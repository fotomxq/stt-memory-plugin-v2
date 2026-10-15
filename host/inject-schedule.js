// ============================================================
// host/inject-schedule.js —— **楼层事件触发的注入刷新：延迟去抖 + 发送前强制刷新**（v3.50.0，`docs/D22` §4.22 W22 `技-51`）
//
// 用户要求（原话）：「核对项目内是否还有其他类似可做性能优化的点，尤其是高频次触发，做好延迟触发器或被动触发器，以优化性能表现。」
//
// 审计发现（实证，见 `docs/D42` §0/§2）：
//   `index.js#onFloorChanged()` 绑在 **`CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` / `GENERATION_ENDED` / `CHAT_CHANGED`** 上，
//   而它内部直接 `pushMemoryInject({queryText:''})` —— 也就是**每渲染一条消息**就把整份注入体重建一遍：
//   `buildMemoryBodyForInject`（召回打分 + 预算择优 + 结构头）在本机 4000 条目下实测 **≈16 ms/次**，
//   若开了向量检索还会**再发一次 embedding 请求**。长聊天里滚动 / 重绘一次就是几十次构建。
//   而真正的「发送前注入」是 `host/interceptor.js#fttGenerateInterceptor` 在生成时刻做的（**权威**），
//   楼层事件那一份只是**保持预览与状态新鲜** → 完全可以延迟、可以合并。
//
// 本模块的口径（刻意与 `技-50`（弱化NSFW 计数）同款，便于两处对照维护）：
//   · **延迟**：首次信号排一次 `INJECT_REFRESH_DELAY_MS`（1500ms，与时钟巡检 1.8s 防抖同量级）后的刷新；
//   · **合并**：延迟窗口内再来信号**一律忽略**（计入 `coalesced`），**不重排** → 突发事件只换来一次构建；
//   · **发送前不漏**：生成开始 → 由 `index.js` 决定 **flush（拦截器关着：事件路径是唯一刷新源）** 或
//     **cancel（拦截器开着：它自己会在发送前权威构建，避免重复构建）**；
//   · **拦截器侧**：`host/interceptor.js` 在自建之前 `cancelInjectRefresh()`，避免「刚刷完又刷一次」；
//   · **单飞已在底层**：`pushMemoryInject` 自带在途共享（`inFlight`），本模块只负责「何时发起」。
//
// 降级：无 `setTimeout`（受限宿主）/ 推送失败 → 一律静默，绝不影响聊天与生成。
// ============================================================

import { pushMemoryInject } from './inject.js';

/** 延迟时长（ms）：楼层事件后的注入刷新延迟 */
export const INJECT_REFRESH_DELAY_MS = 1500;
/** 触发原因的只读留痕上限（诊断 / 测试用；内存恒定，不随会话增长） */
export const INJECT_REASON_MAX = 20;

/** 延迟句柄 */
let timer = null;
/** 窗口内是否已有待执行的刷新 */
let pending = false;
/** 读数（诊断 / 测试） */
let stats = { signals: 0, coalesced: 0, runs: 0, flushed: 0, cancelled: 0, failed: 0, lastReason: '', lastAt: 0, lastMs: 0 };
/** 最近若干次触发原因（环形，便于事后核对「是谁刷的」） */
let reasons = [];

/** 时间源与定时器（可注入，供测试） */
let nowFn = () => Date.now();
let setT = (fn, ms) => ((typeof setTimeout === 'function') ? setTimeout(fn, ms) : null);
let clearT = (h) => { try { if (h != null && typeof clearTimeout === 'function') clearTimeout(h); } catch (e) { /* 忽略 */ } };
/** 真正的推送（可注入，供测试；缺省走宿主注入通道） */
let pushFn = (o) => pushMemoryInject(o);

/**
 * 注入时间源 / 定时器 / 推送函数（测试用；生产不调）。
 * @param {{now?:Function, setTimeout?:Function, clearTimeout?:Function, push?:Function}} next
 */
export function setInjectScheduleHooks(next) {
    const n = next || {};
    if (typeof n.now === 'function') nowFn = n.now;
    if (typeof n.setTimeout === 'function') setT = n.setTimeout;
    if (typeof n.clearTimeout === 'function') clearT = n.clearTimeout;
    if (typeof n.push === 'function') pushFn = n.push;
    return true;
}

/** 读数（只读快照；`pending` / `scheduled` 表示「窗口内有待做的刷新」） */
export function injectScheduleState() {
    return {
        delay: INJECT_REFRESH_DELAY_MS, pending: pending, scheduled: !!timer,
        stats: Object.assign({}, stats), reasons: reasons.slice(),
    };
}

/** 记一次原因（环形，去重相邻重复） */
function noteReason(reason) {
    const r = String(reason == null ? '' : reason);
    if (!r) return;
    if (reasons[reasons.length - 1] === r) return;
    reasons.push(r);
    if (reasons.length > INJECT_REASON_MAX) reasons = reasons.slice(-INJECT_REASON_MAX);
}

/** 真正做一次刷新（延迟到点 / 被 flush 时执行） */
async function runRefresh(reason) {
    const t0 = Number(nowFn()) || Date.now();
    stats.runs += 1;
    stats.lastReason = String(reason || '');
    stats.lastAt = t0;
    noteReason(reason);
    let ok = true;
    try { await pushFn({ queryText: '' }); } catch (e) { ok = false; stats.failed += 1; }
    stats.lastMs = Math.max(0, (Number(nowFn()) || Date.now()) - t0);
    return ok;
}

/** 清掉待执行的刷新（不动读数） */
function clearPending() {
    if (timer) { clearT(timer); timer = null; }
    pending = false;
}

/**
 * **楼层事件信号**：排一次延迟刷新；窗口内重复信号**忽略且不重排**（用户口径「高频触发 → 合并」）。
 *
 * @param {string} [reason] 触发原因（只读留痕用，如 `floor-changed`）
 * @returns {{accepted:boolean, reason:string}}
 */
export function scheduleInjectRefresh(reason) {
    const r = String(reason == null ? '' : reason);
    try {
        stats.signals += 1;
        if (pending || timer) { stats.coalesced += 1; return { accepted: false, reason: 'coalesced' }; }
        pending = true;
        noteReason(r);
        timer = setT(() => {
            timer = null;
            pending = false;
            void runRefresh(r);
        }, INJECT_REFRESH_DELAY_MS);
        return { accepted: true, reason: 'scheduled' };
    } catch (e) {
        clearPending();
        return { accepted: false, reason: 'error' };
    }
}

/**
 * **立刻补做**待执行的刷新（生成开始且拦截器关着时调 —— 那时事件路径是唯一刷新源，绝不能漏）。
 * @returns {Promise<boolean>} 是否真的做了一次（无待做 → `false`）
 */
export async function flushInjectRefresh(reason) {
    if (!pending && !timer) return false;
    clearPending();
    stats.flushed += 1;
    return await runRefresh(reason || 'flush');
}

/**
 * **作废**待执行的刷新（拦截器即将自行权威构建 / 生成开始且拦截器开着时调）。
 * @returns {boolean} 是否真的作废了一次
 */
export function cancelInjectRefresh(reason) {
    if (!pending && !timer) return false;
    clearPending();
    stats.cancelled += 1;
    noteReason(reason);
    return true;
}

/** 清读数（测试用；不动待执行的定时器之外的任何状态） */
export function resetInjectSchedule() {
    clearPending();
    stats = { signals: 0, coalesced: 0, runs: 0, flushed: 0, cancelled: 0, failed: 0, lastReason: '', lastAt: 0, lastMs: 0 };
    reasons = [];
    return true;
}
