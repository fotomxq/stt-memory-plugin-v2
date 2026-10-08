// ============================================================
// core/conflicts.js —— **待确认项 / 记录**（v2.92.0 建立；v3.36.0 按用户要求重新设计）
//
// v2.92.0 原口径（用户要求）：「如果发生冲突需手动确认的，除了在设定中展示外，还需在**总览页面提示**」——
//   于是所有「需人管」的事都进同一个清单，处理动作只有「标记已确认 / 清空」。
//
// v3.36.0 用户报告（原话）：「设定-存储-待确认，点击全部已确认会报错。而且这里设计非常不合理，
//   只能确认无法改其他内容，那和日志没任何区别了。请重新设计该位置的逻辑，如果是确认，应该有差异化处理的机制；
//   如果不需要确认，则只是一种日志。」
//   → 现在把「待确认」与「记录」**分开**，并给每一类**差异化的处理动作**：
//     · `mode:'decide'`（**待确认**）：真的需要人做决定的事 —— 进待确认清单、计入徽标计数、带该类**自己的动作按钮**
//       （如「🔀 重新同步（并集）」「🔍 校验并修复存储」＋「✅ 知道了」）；
//     · `mode:'log'`（**记录**）：已经自动处理完、只是通知（删楼 / 楼层收缩 / 跨端分歧已自动合并）—— 只进只读记录区，
//       **不计入待确认计数、不需要确认**，并同时写一条调试日志。
//   去重与上限纪律不变（`kind + detail` 去重累加、待确认上限 50 条、记录上限 20 条）。
//   持久化仍由宿主注入（ST 扩展设置 `syncConflicts` / `syncConflictLog`，**不进数据模型** → DATA_VERSION 不变）。
//
// v3.37.0（用户要求「请核对是否有设计缺陷」）—— 复核出并修掉的三处**设计缺陷**：
//   S1 **旧数据会变成「无法处理」**：v3.35 及更早写进 `syncConflicts` 的「删楼 / 楼层收缩 / 跨端分歧」升级后落在
//      **待确认**区，而它们的新语义是「记录」→ 渲染出来**一个动作按钮都没有**（既不能单条确认，又占着徽标）。
//      修：`migrateConflicts()` 在装配时把它们**迁移到记录区**（保留计数与明细，幂等）＋ 界面兜底：任何待确认项
//      若该类没有可用动作，一律补一个「✅ 知道了」（绝不出现「无法处理」的行）。
//   S2 **「确认」不留痕**：处理动作只清清单，事后无从追溯（用户原话的另一面：「和日志没区别」）。
//      修：`resolveConflict` / `clearConflicts` 追加一条**合并计数**的记录（`已确认：<类别> ×N`）。
//   S3 **钩子只在开面板时才接上**（`index.js#openPanelPopup`）：没开过面板时的合并冲突 / 删楼通知
//      被写进默认内存钩子 → **直接丢失**。修：`wireConflictHooks()` 在 `init()` 里就接线（幂等）。
// ============================================================

export const CONFLICT_CAP = 50;
/** 「记录」类（`mode:'log'`）的保留上限（只读区，不参与待确认计数） */
export const CONFLICT_LOG_CAP = 20;

/** 内置动作 id（各 kind 可自由组合；`dismiss` 对所有待确认项都成立） */
export const CONFLICT_ACT = Object.freeze({
    DISMISS: 'dismiss',   // 知道了（标记已确认）
    RESYNC: 'resync',     // 重新同步（并集）—— 交给存储页同名动作
    VERIFY: 'verify',     // 校验并修复存储 —— 交给存储页同名动作
});

/**
 * **类别登记表**：每类自己的语义与差异化动作。
 *   `mode:'decide'` = 待确认（进清单、计入计数）；`mode:'log'` = 记录（只读、不计入）。
 *   未登记的类别按**保守**处理：`decide` + 「知道了」（绝不静默吞掉未知情况）。
 */
export const CONFLICT_KINDS = Object.freeze({
    '跨端合并冲突': {
        mode: 'decide',
        hint: '本地与对端同一 id 内容不同 —— 已按「并集 + 按时间取新」处理，数据没有丢；想再对齐一次可重新同步。',
        actions: [
            { id: CONFLICT_ACT.RESYNC, label: '🔀 重新同步（并集）', hint: '重新拉取对端并按并集合并一次（已自动处理，这一步是消歧与再核对）' },
            { id: CONFLICT_ACT.DISMISS, label: '✅ 知道了', hint: '标记已确认（只清提示，不动数据）' },
        ],
    },
    '并集自检异常': {
        mode: 'decide',
        hint: '合并后条数比合并前较少 —— 可能被裁剪或被墓碑过滤，建议校验一次并核对两份存档。',
        actions: [
            { id: CONFLICT_ACT.VERIFY, label: '🔍 校验并修复存储', hint: '跑一次存储校验（只读比较 + 必要时按并集修复）' },
            { id: CONFLICT_ACT.DISMISS, label: '✅ 知道了', hint: '标记已确认（只清提示，不动数据）' },
        ],
    },
    // —— 以下为「记录」类：已自动处理完，只是通知（不再要求确认）——
    '跨端分歧（已自动合并）': { mode: 'log', hint: '已自动下载并集合并并推回服务端 —— 仅记录。' },
    '删楼': { mode: 'log', hint: '内置删楼完成通知（含备份文件名与保留条数）—— 仅记录。' },
    '楼层收缩': { mode: 'log', hint: '聊天楼层变化后台账按内容归位 —— 仅记录。' },
});

/** 某类别的语义与动作（未登记 → 保守：待确认 + 知道了） */
export function conflictKindSpec(kind) {
    const k = String(kind || 'other');
    const spec = CONFLICT_KINDS[k];
    if (spec) return { kind: k, mode: spec.mode === 'log' ? 'log' : 'decide', hint: String(spec.hint || ''), actions: (spec.actions || []).slice() };
    return { kind: k, mode: 'decide', hint: '', actions: [{ id: CONFLICT_ACT.DISMISS, label: '✅ 知道了', hint: '标记已确认（只清提示，不动数据）' }] };
}

let hooks = { get: () => [], save: () => undefined, getLog: () => [], saveLog: () => undefined, log: () => undefined, now: () => Date.now() };
let seq = 0;        // 同毫秒插入的稳定次序（避免上限裁剪时误保留最早的那批）
let seqLog = 0;
export function setConflictHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function conflictHooks() { return Object.assign({}, hooks); }

function load() {
    try { const a = hooks.get(); return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []; } catch (e) { return []; }
}
function save(list) { try { hooks.save(Array.isArray(list) ? list : []); } catch (e) { /* 落盘失败不影响运行 */ } }
function loadLog() {
    try { const a = hooks.getLog(); return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []; } catch (e) { return []; }
}
function saveLog(list) { try { hooks.saveLog(Array.isArray(list) ? list : []); } catch (e) { /* 落盘失败不影响运行 */ } }

/** 按 `kind|detail` 去重登记（待确认清单与记录清单共用同一套去重/排序/裁剪纪律） */
function upsert(list, item, cap, nextSeq) {
    const id = item.id;
    const at = Number(hooks.now()) || Date.now();
    const found = list.filter((x) => String(x.id) === id)[0];
    if (found) {
        found.count = Math.max(1, Number(found.count) || 1) + Math.max(1, Number(item.count) || 1);
        found.lastAt = at;
    } else {
        const seqVal = nextSeq();
        list.push({ id: id, kind: item.kind, detail: item.detail, count: Math.max(1, Number(item.count) || 1), firstAt: at, lastAt: at, seq: seqVal, scope: item.scope });
    }
    // 最新在前；同毫秒按 seq 倒序（保证超上限时裁掉的是**最早**的那批）
    list.sort((a, b) => ((Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)) || ((Number(b.seq) || 0) - (Number(a.seq) || 0)));
    const next = list.slice(0, cap);
    return { count: (found ? found.count : Math.max(1, Number(item.count) || 1)), total: next.length, list: next };
}

/**
 * 登记一条「需人管」的事：按类别语义**分流**到待确认清单或只读记录，并按 `kind + detail` 去重累加。
 * @param {{kind:string, detail:string, count?:number, scope?:string}} item
 * @returns {{ok:boolean, id:string, mode:'decide'|'log', count:number, total:number, remain:number}}
 */
export function noteConflict(item) {
    const o = item || {};
    const kind = String(o.kind || 'other').slice(0, 40);
    const detail = String(o.detail || '').slice(0, 160);
    const spec = conflictKindSpec(kind);
    const base = { id: kind + '|' + detail, kind: kind, detail: detail, count: o.count, scope: String(o.scope || '').slice(0, 60) };
    if (spec.mode === 'log') {
        const r = upsert(loadLog(), base, CONFLICT_LOG_CAP, () => ++seqLog);
        saveLog(r.list);
        try { if (typeof hooks.log === 'function') hooks.log({ kind: kind, detail: detail, count: r.count }); } catch (e) { /* 忽略 */ }
        return { ok: true, id: base.id, mode: 'log', count: r.count, total: r.total, remain: pendingConflictCount() };
    }
    const r = upsert(load(), base, CONFLICT_CAP, () => ++seq);
    save(r.list);
    return { ok: true, id: base.id, mode: 'decide', count: r.count, total: r.total, remain: pendingConflictCount() };
}

/** 追加一条「记录」（只读区；按 kind+detail 去重累加；返回 `{ok,id,mode:'log',count,total}`） */
function noteLog(kind, detail, count) {
    const r = upsert(loadLog(), { id: String(kind) + '|' + String(detail), kind: String(kind), detail: String(detail), count: count, scope: '' }, CONFLICT_LOG_CAP, () => ++seqLog);
    saveLog(r.list);
    return { ok: true, id: String(kind) + '|' + String(detail), mode: 'log', count: r.count, total: r.total };
}

/** 待确认项列表（副本，倒序：最新在前） */
export function listConflicts() { return load().slice(); }
/** 只读**记录**列表（副本；这些不需要确认） */
export function listConflictLog() { return loadLog().slice(); }
/** 待确认数量（总览徽标用；**只统计待确认**，记录不计入） */
export function pendingConflictCount() {
    try { return load().reduce((n, x) => n + Math.max(1, Number(x.count) || 1), 0); } catch (e) { return 0; }
}
/** 待确认**条目**数（去重后的种类数） */
export function pendingConflictKinds() { return load().length; }
/** 记录条数（只读区展示用） */
export function conflictLogCount() {
    try { return loadLog().reduce((n, x) => n + Math.max(1, Number(x.count) || 1), 0); } catch (e) { return 0; }
}

/**
 * 处理一条待确认项：`dismiss`（默认）= 标记已确认；其它动作由调用方执行后再调本函数销账。
 * @param {string} idOrKind 条目 id 或类别名
 * @param {string} [action] 执行过的动作 id（如实记录在返回值里）
 */
export function resolveConflict(idOrKind, action) {
    const k = String(idOrKind || '');
    const list = load();
    const gone = list.filter((x) => String(x.id) === k || String(x.kind) === k);
    const next = list.filter((x) => String(x.id) !== k && String(x.kind) !== k);
    save(next);
    // v3.37.0（S2）：「确认」也留痕 —— 每条被处理掉的待确认项在记录区留一条**合并计数**的记录（同样只读、无需再确认）
    try {
        for (const x of gone) noteLog('已确认：' + String(x.kind || ''), String(x.detail || '').slice(0, 120), Math.max(1, Number(x.count) || 1));
    } catch (e) { /* 忽略 */ }
    return { ok: true, removed: list.length - next.length, remain: next.length, action: String(action || CONFLICT_ACT.DISMISS), pending: pendingConflictCount() };
}
/** 全部标记已确认（**只清待确认清单**；只读记录原样保留） */
export function clearConflicts() {
    const list = load();
    const n = list.length;
    save([]);
    try {
        for (const x of list) noteLog('已确认：' + String(x.kind || ''), String(x.detail || '').slice(0, 120), Math.max(1, Number(x.count) || 1));
    } catch (e) { /* 忽略 */ }
    return { ok: true, cleared: n, keptLog: loadLog().length, pending: 0 };
}

/**
 * v3.37.0（S1）：**旧数据迁移** —— 把「语义已变成记录」的类别从待确认区搬到记录区。
 *   背景：v3.35 及更早把删楼 / 楼层收缩 / 跨端分歧都写进 `syncConflicts`（那时只有待确认一种语义）；
 *   现在这些类别的 `mode` 是 `log` → 它们若留在待确认区，界面**无动作按钮可点**（既不能单条确认，又占徽标）。
 *   幂等：搬过之后再跑不产生变化；明细与计数原样保留（合并进记录区的同 id 记录）。
 * @returns {{moved:number, kept:number, log:number}}
 */
export function migrateConflicts() {
    let moved = 0;
    try {
        const list = load();
        if (!list.length) return { moved: 0, kept: 0, log: loadLog().length };
        const keep = [];
        for (const x of list) {
            const spec = conflictKindSpec(x.kind);
            if (spec.mode === 'log') {
                noteLog(String(x.kind || ''), String(x.detail || ''), Math.max(1, Number(x.count) || 1));
                moved++;
                continue;
            }
            keep.push(x);
        }
        if (moved) save(keep);
        return { moved: moved, kept: keep.length, log: loadLog().length };
    } catch (e) { return { moved: 0, kept: load().length, log: loadLog().length }; }
}

/** 供 UI 展示的一句话摘要（只统计待确认；不泄露内容） */
export function conflictsSummary() {
    try {
        const list = load();
        if (!list.length) return '';
        return list.map((x) => String(x.kind) + ' ×' + Math.max(1, Number(x.count) || 1)).join(' · ').slice(0, 120);
    } catch (e) { return ''; }
}
/** 记录区一句话摘要（只读） */
export function conflictLogSummary() {
    try {
        const list = loadLog();
        if (!list.length) return '';
        return list.map((x) => String(x.kind) + ' ×' + Math.max(1, Number(x.count) || 1)).join(' · ').slice(0, 120);
    } catch (e) { return ''; }
}
/** 复位（测试用） */
export function resetConflicts() { save([]); saveLog([]); return true; }
