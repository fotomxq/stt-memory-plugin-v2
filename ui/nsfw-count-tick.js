// ============================================================
// ui/nsfw-count-tick.js —— **总览「🌶 弱化NSFW」计数：事件触发 + 10 秒延迟去抖**（v3.49.0，`docs/D22` §4.21 W21 `技-49`）
//
// 用户要求（原话）：「总览弱化NSFW按钮的数量统计背后应该有被动或定时器，这个机制会造成性能浪费。
//   可做延迟执行，管道完成某个操作后（注意排除弱化NSFW功能），自动触发一个信号，然后延迟10秒检查；
//   在延迟期间可能会频繁触发信号，但自动忽略多余信号，以避免频繁更新。」
//
// 改造前（问题）：那个数字来自 `core/nsfw.js#nsfwSoftenState()` → `nsfwScan()` —— 一次**全库全字段扫描**
//   （每个维度每条目的文本字段都要过关键词/规则）。而它在**每次总览渲染**时被同步调用（面板每次动作都整页重绘）
//   → 点一下按钮就全库扫一遍，纯属白烧性能（数字本身也不会因为「看它一眼」而变化）。
//
// 改造后（本模块）：
//   · **事件触发**：管道完成一次操作（`core/pipeline.js#hooks.onRunEnd`）→ 发一个信号；
//   · **10 秒延迟**：信号只**排一次**检查，真正执行在 `NSFW_COUNT_DELAY_MS`（10000ms）之后；
//   · **去抖/合并**：延迟窗口内再来信号**直接忽略**（`dropped` 计数），**不重排**也不累积 → 避免频繁更新；
//   · **排除弱化NSFW自身**：`弱化NSFW` 这一条管道的完成**不发信号**（用户明确要求）；
//     该动作改为在结束时**直接作废缓存**（`invalidateNsfwCount()`）→ 紧接着的那次重绘**就地算一次**，
//     用户点完立刻看到新的数字，且**只算这一次**（不是「每次渲染都算」）；
//   · **只在看得见时才真正算**：面板关了 / 不在总览页 → 跳过扫描（`skipped` 计数），把算力留到用户真的在看的时候；
//   · **就地更新 DOM**：命中时才重写 `#ftt-nsfw-btn` 的文案与 title（文本未变不写 DOM），**不整页重绘**
//     （与 `updatePipelineStatusDom` / `updateBridgeStatusDom` 同款，避免打断输入与滚动）。
//
// 降级：无 `setTimeout` / 无 DOM（桩环境）一律安全返回；任何异常都不影响面板渲染（计数回落到「按需就地算一次」）。
// ============================================================

import { nsfwSoftenState, nsfwLabelStats } from '../core/nsfw.js';

/** 延迟时长（用户指定：10 秒） */
export const NSFW_COUNT_DELAY_MS = 10000;
/** 不发信号的管道标签（弱化 NSFW 自身的完成不走「延迟检查」这条路） */
export const NSFW_COUNT_SKIP_LABELS = Object.freeze(['弱化NSFW', 'nsfwSoften']);

/** 延迟检查的定时器句柄 */
let timer = null;
/** 延迟窗口内是否已有一次待执行的检查（窗口内多余信号直接忽略） */
let pending = false;
/** 缓存：`{candidates, labels, at}`；`null` = 还没有算过 */
let cache = null;
/** 读数（诊断 / 测试） */
let stats = { runs: 0, signals: 0, dropped: 0, excluded: 0, skipped: 0, inline: 0 };

/** 读数（只读快照） */
export function nsfwCountTickState() {
    return {
        delay: NSFW_COUNT_DELAY_MS, scheduled: !!timer, pending: pending,
        at: cache ? Number(cache.at) || 0 : 0,
        candidates: cache ? Number(cache.candidates) || 0 : 0,
        stale: cache ? (Date.now() - (Number(cache.at) || 0)) > NSFW_COUNT_DELAY_MS : true,
        stats: Object.assign({}, stats),
    };
}

/** 缓存读数（渲染层用；没有缓存 → `null`，由调用方决定是否就地算一次） */
export function nsfwCountCache() { return cache ? Object.assign({}, cache) : null; }

/** 时间源（可注入，供测试；缺省 `Date.now`） */
let nowFn = () => Date.now();
/** 定时器（可注入，供测试；缺省 `setTimeout`/`clearTimeout`） */
let setT = (fn, ms) => ((typeof setTimeout === 'function') ? setTimeout(fn, ms) : null);
let clearT = (h) => { try { if (h != null && typeof clearTimeout === 'function') clearTimeout(h); } catch (e) { /* 忽略 */ } };

/**
 * 注入时间源与定时器（测试用；生产不调）。
 * @param {{now?:Function, setTimeout?:Function, clearTimeout?:Function}} next
 */
export function setNsfwCountHooks(next) {
    const n = next || {};
    if (typeof n.now === 'function') nowFn = n.now;
    if (typeof n.setTimeout === 'function') setT = n.setTimeout;
    if (typeof n.clearTimeout === 'function') clearT = n.clearTimeout;
    return true;
}

/**
 * **算一次并写进缓存**（唯一的全库扫描入口）。
 * @param {{dom?:boolean}} [opts] `dom:false` 表示只更新缓存、不碰 DOM（测试用）
 * @returns {{candidates:number, labels:object, at:number}} 新缓存
 */
export function refreshNsfwCount(opts) {
    const o = opts || {};
    const out = { candidates: 0, labels: null, at: Number(nowFn()) || 0 };
    try { const st = nsfwSoftenState(); out.candidates = Number(st && st.candidates) || 0; } catch (e) { out.candidates = 0; }
    try { out.labels = nsfwLabelStats() || null; } catch (e) { out.labels = null; }
    cache = out;
    stats.runs += 1;
    if (o.dom !== false) updateNsfwCountDom();
    return Object.assign({}, cache);
}

/** 作废缓存（弱化NSFW 动作结束时调用 → 紧接着那次重绘会**就地算一次**，而不是等一个信号周期） */
export function invalidateNsfwCount() {
    const had = !!cache;
    cache = null;
    return had;
}

/** 面板是否**看得见**这个数字（关着 / 不在总览页 → 没必要扫全库） */
export function nsfwCountVisible(docOverride) {
    try {
        const doc = docOverride || (typeof document !== 'undefined' ? document : null);
        if (!doc || typeof doc.querySelector !== 'function') return false;
        return !!doc.querySelector('#ftt-nsfw-btn');
    } catch (e) { return false; }
}

/**
 * **就地更新**按钮文案与 title（不整页重绘）。
 * @returns {boolean} 是否找到并处理了节点（未找到 = false → 上层可据此跳过扫描）
 */
export function updateNsfwCountDom(docOverride) {
    try {
        const doc = docOverride || (typeof document !== 'undefined' ? document : null);
        if (!doc || typeof doc.querySelector !== 'function') return false;
        const btn = doc.querySelector('#ftt-nsfw-btn');
        if (!btn) return false;
        const c = Number(cache && cache.candidates) || 0;
        const labs = (cache && cache.labels) || null;
        const text = '🌶 弱化NSFW' + (c ? ('（' + c + '）') : '');
        const title = '按关键词找出露骨内容并交 AI 弱化（分析侧开关在设定「NSFW弱化」页）'
            + '｜NSFW 等级留档：无 ' + (labs ? labs.none : 0) + ' · 弱 ' + (labs ? labs.weak : 0) + ' · 强 ' + (labs ? labs.strong : 0)
            + '（按原文判定，弱化后不变）';
        let wrote = false;
        if (typeof btn.textContent === 'string') { if (btn.textContent !== text) { btn.textContent = text; wrote = true; } }
        if (typeof btn.setAttribute === 'function') {
            if (typeof btn.getAttribute !== 'function' || btn.getAttribute('title') !== title) { btn.setAttribute('title', title); wrote = true; }
        }
        return true;
    } catch (e) { return false; }
}

/** 排一次延迟检查（**只排一次**：窗口内重复调用直接忽略 —— 用户要求「自动忽略多余信号」） */
function schedule() {
    if (pending || timer) return false;
    pending = true;
    timer = setT(() => {
        timer = null;
        pending = false;
        try {
            // 看不见就不扫（面板关着 / 不在总览）→ 算力留给用户真的在看的时候
            if (!nsfwCountVisible()) { stats.skipped += 1; return; }
            refreshNsfwCount();
        } catch (e) { /* 检查失败不影响任何东西；下一轮再来 */ }
    }, NSFW_COUNT_DELAY_MS);
    return true;
}

/**
 * **管道完成信号**（`core/pipeline.js#hooks.onRunEnd` 接线而来）。
 *
 * @param {string} label 管道标签（如 `提取记忆` / `自动修复` / `弱化NSFW`）
 * @returns {{accepted:boolean, reason:string}} 如实回报（诊断 / 测试用）
 */
export function signalNsfwCountRefresh(label) {
    const lb = String(label == null ? '' : label).trim();
    try {
        if (NSFW_COUNT_SKIP_LABELS.indexOf(lb) >= 0) { stats.excluded += 1; return { accepted: false, reason: 'excluded' }; }
        stats.signals += 1;
        if (pending || timer) { stats.dropped += 1; return { accepted: false, reason: 'coalesced' }; }
        schedule();
        return { accepted: true, reason: 'scheduled' };
    } catch (e) { return { accepted: false, reason: 'error' }; }
}

/**
 * **渲染层取值**（面板总览里那两处读数的唯一入口）。
 *
 * 语义：有缓存就用缓存（可能略旧 —— 这正是「延迟 10 秒检查」的口径）；缓存缺失或已过期 >
 *   一个延迟周期时**就地算一次**（用户在看着它，必须给正确的数），并顺带排一次延迟检查把窗口续上。
 * @param {{inline?:boolean}} [opts] `inline:false` = 即便没有缓存也不就地算（只回空值）
 * @returns {{candidates:number, labels:object|null, at:number, fromCache:boolean}}
 */
export function nsfwCountSnapshot(opts) {
    const o = opts || {};
    const fresh = cache && (((Number(nowFn()) || 0) - (Number(cache.at) || 0)) <= NSFW_COUNT_DELAY_MS);
    if (fresh) return { candidates: cache.candidates, labels: cache.labels, at: cache.at, fromCache: true };
    // 过期 / 未算过：不重排信号（信号只管「管道完成后延迟检查」），但把这轮的窗口续上
    if (o.inline === false) return { candidates: 0, labels: null, at: 0, fromCache: false };
    const out = refreshNsfwCount({ dom: false });
    stats.inline += 1;
    return { candidates: out.candidates, labels: out.labels, at: out.at, fromCache: false };
}

/** 清掉定时器与读数（测试 / 关闭面板时用；不动缓存） */
export function resetNsfwCountTick() {
    if (timer) { clearT(timer); timer = null; }
    pending = false;
    stats = { runs: 0, signals: 0, dropped: 0, excluded: 0, skipped: 0, inline: 0 };
    return true;
}
