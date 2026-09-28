// ============================================================
// host/floor-trim.js —— **内置「删除到最近 N 层」**（v2.94.0，`docs/D12` v0.2 §4 / §8-E / 阶段 S4）
//
// 用户约定：「在**设定-数据管理**中约定楼层删除的三个按钮（保留最近 6 / 10 / 12 层），确保插件可感知该操作。」
// 用户补充（本轮）：「**用官方 API 实现，不然其他插件也会异常。**」
//
// 因此删除**只经酒馆官方上下文方法** `getContext().deleteMessage(id)`（`public/scripts/st-context.js` 明文导出），
// 它自带其它扩展依赖的全部副作用 —— `chat.splice` + DOM 移除 + `chat_metadata.tainted` +
// `updateViewMessageIds` + `saveChatDebounced()` + **`eventSource.emit(MESSAGE_DELETED)`** ——
// 于是「消息被删除」对别的插件同样是**正常事件**（我们自己也不去改 `ctx.chat`）。
//
// 流程（逐条对齐 D12 §4 前置/执行/结果，缺一不可）：
//   ① 能力探测（Q6）：宿主无 `deleteMessage` → 返回 `unsupported`，按钮侧**提示不支持并隐藏**，**不静默失败**；
//   ② 预检（§4 前置③）：将删除几层 / 删哪一段 / 受影响条目数 / 其中有几层**尚未提取**（§8-D 删前吸收提示）；
//   ③ 二次确认（D9 U4）：由 UI 侧 `confirmDialog` 完成（本模块不弹窗，便于测试）；
//   ④ 自动备份（Q5）：**明文 JSON → 用户目录文件，3 槽轮转**；备份失败 → **中止删除**；
//   ⑤ 删除（§4 执行）：**从后往前**逐个 `await deleteMessage(id)`（早先的下标保持稳定）；
//      每步核对 `chat.length` 是否真的减少 —— 未减少即**如实中止并报告已删层数**（半途失败不装成功）；
//   ⑥ 校准（§3.2 + §8-B）：**精确编号重映射**（幸存楼层整体前移 M；被删段内区间 → 未知区间 + `floorStale`）+
//      台账重排 + `lastKnownFloor` 收紧；**绝不删除任何记忆条目**；
//   ⑦ 记账（§8-A 低噪声）：人工确认项一条（含备份文件名/槽位与「聊天已减小、记忆保留 N 条」）+ 调试日志。
// ============================================================
import { state, log, warn, saveState } from '../core/model/runtime.js';
import { DIMENSIONS } from '../core/constants.js';
import { planFloorTrim, remapAfterTrim, trimSummaryText, FLOOR_TRIM_PRESETS } from '../core/floor-trim.js';
import { getCtx } from './st-api.js';
import { hashFloorText, handleFloorShrink } from './floors.js';
import { nextFloorBackupSlot } from '../adapters/floor-backup.js';

export { FLOOR_TRIM_PRESETS };

/** 宿主注入的钩子：备份写入 / 明文导出 / 轮转账本读写 / 人工确认项登记 */
let hooks = {
    writeBackup: null,        // async (scope, slot, text) => {ok, name, slot, ...}
    exportJson: null,         // () => string（明文 JSON 信封）
    getLog: null,             // () => {slot?:number, items?:Array}
    saveLog: null,            // (log) => void
    noteConflict: null,       // (item) => void
    notify: null,             // (kind, text) => void
};
export function setFloorTrimHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function floorTrimHooks() { return Object.assign({}, hooks); }

/** 轮转账本（宿主未接线时退化为进程内记录，仅影响「上次槽位」的连续性） */
let localLog = { slot: -1, items: [] };
function readLog() {
    try { if (typeof hooks.getLog === 'function') { const v = hooks.getLog(); if (v && typeof v === 'object') return v; } } catch (e) { /* 忽略 */ }
    return localLog;
}
function writeLog(next) {
    localLog = next;
    try { if (typeof hooks.saveLog === 'function') hooks.saveLog(next); } catch (e) { /* 忽略 */ }
}

/** 当前聊天长度（宿主权威值；无宿主返回 0） */
function chatLen() {
    try {
        const ctx = getCtx();
        return (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
    } catch (e) { return 0; }
}

/** 插件当前持有的条目总数（只读诊断） */
function entryCount() {
    try {
        let n = 0;
        for (const d of DIMENSIONS) n += (Array.isArray(state[d.kind]) ? state[d.kind].length : 0);
        return n;
    } catch (e) { return 0; }
}

/**
 * 能力探测（D12 Q6）：宿主是否提供**官方**删除楼层方法。
 * 只判「有没有 / 是不是函数」，**不产生任何副作用**。
 * @returns {{ok:boolean, supported:boolean, reason:string}}
 */
export function floorTrimCapability() {
    try {
        const ctx = getCtx();
        if (!ctx) return { ok: false, supported: false, reason: 'no-host' };
        if (!Array.isArray(ctx.chat)) return { ok: false, supported: false, reason: 'no-chat' };
        if (typeof ctx.deleteMessage !== 'function') return { ok: false, supported: false, reason: 'unsupported-host' };
        return { ok: true, supported: true, reason: '' };
    } catch (e) {
        return { ok: false, supported: false, reason: 'error' };
    }
}

/**
 * 只读诊断（数据管理页那行「当前 N 层 · 插件 M 条 · 上次删楼 …」）。
 * @returns {{supported:boolean, reason:string, floors:number, entries:number,
 *            last:{at:number, keep:number, removed:number, stale:number, backup:string}|null,
 *            presets:number[]}}
 */export function floorTrimStatus() {
    const cap = floorTrimCapability();
    const lg = readLog();
    const items = Array.isArray(lg && lg.items) ? lg.items : [];
    const last = items.length ? items[items.length - 1] : null;
    return {
        supported: cap.supported,
        reason: cap.reason,
        floors: chatLen(),
        entries: entryCount(),
        last: last ? {
            at: Number(last.at) || 0,
            keep: Number(last.keep) || 0,
            removed: Number(last.removed) || 0,
            stale: Number(last.stale) || 0,
            backup: String(last.backup || ''),
        } : null,
        presets: FLOOR_TRIM_PRESETS.slice(),
    };
}

/** 被删段中「尚未提取」的楼层数（§8-D 删前吸收预检；按内容哈希判台账） */
function unextractedInRange(removeCount) {
    try {
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        const set = {};
        for (const x of pf) set[String((x && x.h) || '')] = true;
        let n = 0;
        for (let f = 0; f < removeCount; f++) {
            const h = hashFloorText(f);
            if (!h || !set[h]) n++;
        }
        return n;
    } catch (e) { return 0; }
}

/**
 * 预检（**只读**）：三档按钮与确认框都用它给出「将删除 / 受影响 / 尚未提取」。
 * @param {number} keep 保留最近层数
 * @returns {{ok:boolean, reason:string, supported:boolean, plan:object, unextracted:number, summary:string}}
 */
export function floorTrimPrecheck(keep) {
    const cap = floorTrimCapability();
    const plan = planFloorTrim({ chatLen: chatLen(), keep: keep, state: state });
    const un = plan.ok ? unextractedInRange(plan.removeCount) : 0;
    return {
        ok: !!plan.ok && cap.supported,
        reason: (!cap.supported) ? cap.reason : (plan.ok ? '' : String(plan.reason || '')),
        supported: cap.supported,
        plan: plan,
        unextracted: un,
        summary: trimSummaryText(plan, { unextracted: un, supported: cap.supported }),
    };
}

/**
 * 执行删楼（**唯一会改聊天与编号的入口**）。
 * @param {{keep:number, backup?:boolean, confirmed?:boolean, _deleteOne?:Function}} opts
 *        `_deleteOne(id)` 仅供测试注入；生产一律走 `getContext().deleteMessage`。
 * @returns {Promise<object>} 见各分支 `{ok, reason?, deleted?, requested?, backup?, remap?, summary?}`
 */
export async function floorTrimApply(opts) {
    const o = opts || {};
    const keep = Math.floor(Number(o.keep) || 0);
    const pre = floorTrimPrecheck(keep);
    if (!pre.supported) {
        return { ok: false, reason: pre.reason || 'unsupported-host', unsupported: true, summary: pre.summary };
    }
    if (!pre.ok) return { ok: false, reason: pre.reason || 'precheck-failed', plan: pre.plan, summary: pre.summary };
    const plan = pre.plan;
    const ctx = getCtx();
    const del = (typeof o._deleteOne === 'function') ? o._deleteOne
        : (typeof ctx.deleteMessage === 'function' ? ctx.deleteMessage.bind(ctx) : null);
    if (!del) return { ok: false, reason: 'unsupported-host', unsupported: true, summary: pre.summary };

    // ④ 自动备份（Q5：3 槽轮转；失败即中止 —— 不允许「删了但没备份」）
    let backup = { ok: false, skipped: true, slot: -1, name: '' };
    if (o.backup !== false) {
        const lg = readLog();
        const slot = nextFloorBackupSlot(lg && lg.slot);
        let text = '';
        try { text = (typeof hooks.exportJson === 'function') ? String(hooks.exportJson() || '') : ''; } catch (e) { text = ''; }
        if (!text) return { ok: false, reason: 'backup-unavailable', summary: pre.summary };
        let wr = null;
        try { wr = (typeof hooks.writeBackup === 'function') ? await hooks.writeBackup(String(state.scope || ''), slot, text) : null; } catch (e) { wr = { ok: false, error: String((e && e.message) || e) }; }
        if (!wr || !wr.ok) {
            return { ok: false, reason: 'backup-failed', backup: wr || null, error: String((wr && wr.error) || ''), summary: pre.summary };
        }
        backup = { ok: true, slot: slot, name: String(wr.name || ''), chars: Number(wr.chars) || 0 };
    }

    // ⑤ 删除：**从后往前**（先删最大下标，早先下标保持稳定），每步核对聊天确实变短
    const before = chatLen();
    let deleted = 0;
    let failedAt = -1;
    for (let id = plan.removeCount - 1; id >= 0; id--) {
        try { await del(id); } catch (e) {
            failedAt = id;
            try { warn('删楼失败（已中止）', e); } catch (e2) { /* 忽略 */ }
            break;
        }
        if (chatLen() >= before - deleted) { failedAt = id; break; }   // 该次调用没有真的删掉（DOM 未渲染等）
        deleted++;
    }

    // ⑥ 校准：只按**实际删掉的层数**重映射（半途失败也保持编号自洽）
    const remap = remapAfterTrim(state, deleted, chatLen() - 1);
    try { saveState(); } catch (e) { /* 忽略 */ }

    // ⑦ 记账（低噪声：按类型合并计数；失败不算「删除失败」，删除本身已成立）
    const after = chatLen();
    const entries = entryCount();
    const summary = '聊天已减小：-' + deleted + ' 层（保留最近 ' + plan.keep + ' 层）；记忆保留 ' + entries + ' 条'
        + '；编号已校准 ' + remap.shifted + ' 条、失效 ' + (remap.staled + remap.partial) + ' 条'
        + (backup.ok ? '；备份 ' + backup.name : '');
    const rec = {
        at: Date.now(), keep: plan.keep, removed: deleted, requested: plan.removeCount,
        stale: remap.staled + remap.partial, shifted: remap.shifted, backup: backup.name,
        floorsBefore: plan.total, floorsAfter: after, entries: entries,
    };
    const lg = readLog();
    const items = (Array.isArray(lg && lg.items) ? lg.items : []).concat([rec]).slice(-3);   // 账本也只留 3 条
    writeLog({ slot: backup.ok ? backup.slot : (Number(lg && lg.slot) || -1), items: items });
    try {
        if (typeof hooks.noteConflict === 'function') {
            hooks.noteConflict({
                kind: '删楼',
                detail: '删除 ' + deleted + ' 层（保留最近 ' + plan.keep + ' 层）；记忆保留 ' + entries + ' 条；'
                    + '备份 ' + (backup.name || '（未生成）'),
                count: 1,
            });
        }
    } catch (e) { /* 忽略 */ }
    try { log('楼层', { action: '删楼', keep: plan.keep, deleted: deleted, requested: plan.removeCount, shifted: remap.shifted, stale: rec.stale, backup: backup.name }); } catch (e) { /* 忽略 */ }
    try { if (typeof hooks.notify === 'function') hooks.notify('info', summary); } catch (e) { /* 忽略 */ }

    if (failedAt >= 0 || deleted < plan.removeCount) {
        return {
            ok: false, reason: 'partial', partial: true, unsupported: false,
            deleted: deleted, requested: plan.removeCount, failedAt: failedAt,
            backup: backup, remap: remap, summary: summary,
            precheck: pre,
        };
    }
    return {
        ok: true, deleted: deleted, requested: plan.removeCount,
        backup: backup, remap: remap, summary: summary, precheck: pre,
    };
}

/**
 * v2.94.0（`docs/D12` §3.4 / 阶段 S3）——**「重新校准楼层」**（设定 → 存储；幂等手动动作）。
 *
 * 与「删楼」的区别：删楼是**插件发起**（已知 M → 精确前移）；本动作是**兜底重算** ——
 *   适用于「用户在酒馆里自己删了楼」或「跨端合并后编号可疑」等情况：
 *   按当前聊天现实重跑一次 §3.1/§3.2 的收缩处理（哈希归位台账 + 超出当前末楼的区间降级为未知区间 +
 *   `lastKnownFloor` 收紧）。**只改编号，绝不删除条目**；无收缩时也安全（幂等）。
 *
 * @returns {Promise<{ok:boolean, skipped?:string, removedFloors?:number, staleEntries?:number, marks?:number, lastId?:number, stale:number}>}
 */
export async function floorRecalibrate() {
    // 判据与自动哨兵**同一口径**（`handleFloorShrink` 的 `lastKnownFloor - 5` 容忍带）：
    //   ≤5 层的正常抖动（回滚一次编辑等）不算收缩 —— 手动按钮也不该把它当收缩去改编号。
    //   真的收缩了就走完整流程；没收缩如实回 `skipped:'no-shrink'`（幂等，不动任何数据）。
    const r = await handleFloorShrink({});
    return Object.assign({ stale: countStaleEntries() }, r || {});
}

/** 楼层信息已失效的条目数（`floorStale` 标记；只读诊断用） */
export function countStaleEntries() {
    try {
        let n = 0;
        for (const d of DIMENSIONS) {
            for (const it of (Array.isArray(state[d.kind]) ? state[d.kind] : [])) if (it && it.floorStale) n++;
        }
        return n;
    } catch (e) { return 0; }
}

/**
 * 楼层校准只读诊断（设定 → 存储 的那一行；`docs/D12` §3.4）。
 * @returns {{at:number, stale:number, floors:number, marks:number, lastKnownFloor:number}}
 */
export function floorCalibrateStatus() {
    try {
        return {
            at: Number(state.floorShrinkAt) || 0,
            stale: countStaleEntries(),
            floors: chatLen(),
            marks: Array.isArray(state.processedFloors) ? state.processedFloors.length : 0,
            lastKnownFloor: Number(state.lastKnownFloor) || -1,
        };
    } catch (e) {
        return { at: 0, stale: 0, floors: 0, marks: 0, lastKnownFloor: -1 };
    }
}
