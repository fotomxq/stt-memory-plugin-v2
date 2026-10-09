// ============================================================
// host/floors.js —— 楼层读取与「已分析楼层」台账（**逐字对齐 V1**，宿主层）
// 事实源：V1 `floorStableText` / `getAssistantText` / `collectFloorLinesInRange` / `floorAnalyzableText` /
//   `hashFloorText` / `isFloorProcessed` / `recordProcessedFloors`（src/modules/09-AI摘要与楼层处理.js）。
// 分工：**取文与判据在宿主层**（需要 ST 聊天与 TH 能力）；台账写在内核容器 `state.processedFloors`
//   （V1 同名字段，故 V1 存档可直接沿用「哪些楼层已分析」）。
// ============================================================
import { hashText } from '../core/util.js';
import { applyFeedRegex } from '../core/prompt.js';
import { state, cfg, saveState, log, warn, notifyError, getLastMessageId } from '../core/model/runtime.js';
import { floorCoverage, originFloorRange, markOriginGone, shiftFloorNow } from '../core/floor-cover.js';   // v3.7.0：来源楼层 / 当前位置 / 原文已移除
import { getCtx } from './st-api.js';
import { DIMENSIONS } from '../core/constants.js';   // v2.93.0：楼层收缩时逐维修正陈旧区间
// v2.44.0（用户报告）：取文**保留 HTML**、在「过滤之后、交给 AI 之前」才剔标签 —— 顺序不可颠倒：
//   投喂白名单是**按标签名提取 `<content>…</content>`**（`core/prompt.js#applyFeedRegex`），
//   若在过滤前就把标签删掉，白/黑名单会永远匹配不到（v2.44.0 首版即为该缺陷，见 docs/P10j）。
//   另：**楼层哈希仍用原始稳定正文**（`floorStableText`），既有「已处理楼层」台账不会失效。
import { cleanText } from '../core/html-text.js';
import { activeAtoms } from '../core/merge.js';   // v3.5.0：楼层突变判定取「可见情节」的最新楼层
// v3.40.0（`docs/D16` A1）：台账标记要带**聊天归属**，否则换聊天后「这一楼已分析」会被别的聊天冒领。
import { currentChatKey } from '../core/chat-scope.js';

/**
 * v3.40.0（`docs/D16` A1）：台账标记的**归属键** —— 写标记时记下当前聊天标识，读标记时只认本聊天。
 *   真机取证：8 个「已分析」标记**全部越界**、覆盖楼层 0、丢弃留痕 120 条而 95% 与台账无关 —— 都是
 *   「这条标记属于哪条聊天」从未落盘所致。**兼容口径**：老标记没有 `ck`（或当前键未知）→ 一律按可用处理
 *   （绝不因为缺字段把用户的历史台账判废 —— 那正是「突然冒出大量未分析楼层」的成因）。
 * @returns {string} 当前聊天标识（读不到 → ''）
 */
export function currentChatMarkKey() {
    try { return String(currentChatKey() || ''); } catch (e) { return ''; }
}
/** 标记的聊天归属（无 → ''） */
function markChatKey(mark) { return String((mark && mark.ck) || ''); }
/** 标记的写入时刻（无 → 0 = legacy） */
function markAt(mark) { return Number((mark && mark.at) || 0) || 0; }
/**
 * 该标记是否**属于当前聊天**：两侧都有值且不同 → false；任一侧为空（legacy / 键未知）→ true（保守可用）。
 * @param {object} mark
 * @param {string} [ck] 当前聊天标识
 * @returns {boolean}
 */
function markBelongsToCurrentChat(mark, ck) {
    const mck = markChatKey(mark);
    const cur = String(ck == null ? currentChatMarkKey() : ck);
    if (!mck || !cur) return true;
    return mck === cur;
}
/** 写标记时的公共字段（归属 + 时刻） */
function markMeta() { return { at: Date.now(), ck: currentChatMarkKey() }; }

/** V1 台账版本与哈希自检签名（签名 = hashText(固定样本)，故与 V1 逐字符同值） */
export const PROCESSED_VER = 'v1.174';
export const PROCESSED_SIG = (() => {
    try { return hashText(floorStableText({ swipes: ['【FTT 已处理楼层哈希自检样本 v1.174】'] })); } catch (e) { return 'sig'; }
})();
export function processedVerTag() { return `${PROCESSED_VER}:${PROCESSED_SIG}`; }

/** 稳定正文：优先 `swipes[0]`（原始首刷，不随选中刷/可视文本被改写而变）；否则取 mes 等字段（V1 逐字） */
export function floorStableText(msg) {
    try {
        if (!msg) return '';
        if (Array.isArray(msg.swipes) && typeof msg.swipes[0] === 'string' && msg.swipes[0].trim()) return msg.swipes[0];
        for (const k of ['message', 'mes', 'content']) { if (typeof msg[k] === 'string' && msg[k].trim()) return msg[k]; }
        return '';
    } catch (e) { return ''; }
}

/** 当前刷正文（V1 `getAssistantText`）：优先 `swipes[swipe_id]` */
export function assistantTextOf(msg) {
    try {
        if (!msg) return '';
        const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (Array.isArray(msg.swipes) && typeof msg.swipes[swipeId] === 'string' && msg.swipes[swipeId].trim()) return msg.swipes[swipeId];
        for (const k of ['message', 'mes', 'content']) { if (typeof msg[k] === 'string' && msg[k].trim()) return msg[k]; }
        return '';
    } catch (e) { return ''; }
}

/** 取第 i 楼原始消息（ST ctx.chat[i]；越界 → null） */
export function floorMessage(i) {
    try {
        const ctx = getCtx();
        const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
        const idx = Number(i);
        if (!Number.isFinite(idx) || idx < 0 || idx >= chat.length) return null;
        return chat[idx] || null;
    } catch (e) { return null; }
}

function roleOf(m) {
    if (!m) return '';
    if (m.is_user) return '用户';
    if (m.is_system) return 'system';
    return 'AI';
}

/**
 * 区间楼层原始行（V1 `collectFloorLinesInRange` 逐字：含 `[第N楼 角色]` 前缀、跳过隐藏楼）。
 * **返回原始正文（含 HTML 标签）**：投喂白名单要按标签名提取 `<content>…</content>`，
 *   故去标签只能发生在 `applyFeedRegex` **之后**（见 `buildFeedFloorText` / `floorAnalyzableText`）。
 */
export function collectFloorLinesInRange(start, end, opts) {
    const floors = [];
    const aiOnly = !!(opts && opts.aiOnly);
    try {
        for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) {
            const m = floorMessage(i);
            if (!m || m.is_hidden) continue;
            if (aiOnly && (m.is_user || (m.role && m.role !== 'assistant'))) continue;
            const text = assistantTextOf(m);   // **保留 HTML**：投喂白/黑名单按标签名过滤需要原始标签
            if (!text) continue;
            floors.push(`[第${i}楼 ${roleOf(m)}] ${text}`);
        }
    } catch (e) { warn('楼层投喂构建失败', e); }
    return floors;
}

/** 最近 N 楼原始行（V1 `collectFloorLines`） */
export function collectFloorLines(maxFloors) {
    try {
        const ctx = getCtx();
        const n = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
        const start = Math.max(0, n - Math.max(1, Number(maxFloors) || 1));
        return collectFloorLinesInRange(start, n - 1);
    } catch (e) { return []; }
}

/**
 * 投喂文本（V1 `buildFeedFloorText`）：最近 N 楼原始行 → **投喂标签过滤（此时标签仍在）** → 去 HTML 交 AI。
 * 顺序不可颠倒：白名单走 `<tag>…</tag>` 提取、黑名单按行匹配标签，必须在去标签**之前**；
 *   去标签则保证 AI 提示词与后续落库不含 `<br>`/`<div>`（v2.44.0 用户报告）。
 */
export function buildFeedFloorText(maxFloors) {
    try { return cleanText(applyFeedRegex(collectFloorLines(maxFloors).join('\n'))); } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}
/** 指定结束楼层的投喂文本（V1 `buildFeedFloorTextRange`：摘要用于排除生成中的最近楼） */
export function buildFeedFloorTextRange(maxFloors, endFloor, opts) {
    try {
        const end = Number(endFloor);
        const validEnd = Number.isInteger(end) && end >= 0 ? end : Math.max(0, (getCtx() && Array.isArray(getCtx().chat) ? getCtx().chat.length : 1) - 1);
        const n = Math.max(1, Number(maxFloors) || 10);
        return cleanText(applyFeedRegex(collectFloorLinesInRange(Math.max(0, validEnd - n + 1), validEnd, opts).join('\n')));
    } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}

/** 可分析正文（V1 `floorAnalyzableText`）：投喂正则过滤 + 去占位楼 */
export function floorAnalyzableText(i) {
    try {
        const f = Number(i);
        if (!Number.isFinite(f) || f < 0) return '';
        // 同样「先按标签过滤、再去标签」：过滤需要标签，投喂给 AI 的文本不能带标签
        const raw = String(cleanText(applyFeedRegex(collectFloorLinesInRange(f, f).join('\n'))) || '').trim();
        if (!raw) return '';
        const body = raw.replace(/^\[第\d+楼[^\]]*\]\s*/, '').trim();
        if (!body || /^(?:\.{2,}|…+|—+|-+|·+)$/.test(body)) return '';
        return raw;
    } catch (e) { return ''; }
}

/** 楼层内容哈希（V1 `hashFloorText`：稳定正文 → hashText） */
export function hashFloorText(i) {
    try {
        const m = floorMessage(Number(i));
        const text = m ? (floorStableText(m) || (typeof m.mes === 'string' ? m.mes : '')) : '';
        return text ? hashText(text) : '';
    } catch (e) { return ''; }
}

/** 台账条目楼层号（V1 兼容：`{f,h}` 或裸数字） */
const markFloor = (x) => Number(x && typeof x === 'object' ? x.f : x);

/** 该楼在「已处理楼层」台账里的标记（无 → undefined） */
function processedMarkOf(i) {
    try {
        const pf = state.processedFloors || [];
        const n = Number(i);
        return pf.find((x) => markFloor(x) === n);
    } catch (e) { return undefined; }
}

/**
 * 该楼在**当前聊天**里的可用标记（v3.40.0：属于别的聊天的标记视为「本聊天没有标记」）。
 *   与 `processedMarkOf` 的区别只有一条：跨聊天归属的标记不再冒领本聊天的楼层。
 * @param {number} i 楼层号
 * @returns {object|undefined}
 */
function processedMarkForCurrentChat(i) {
    const mark = processedMarkOf(i);
    if (!mark) return undefined;
    return markBelongsToCurrentChat(mark) ? mark : undefined;
}

/**
 * 是否已分析（V1 `isFloorProcessed`）：
 *   ① 台账版本签名不符（插件/算法更新）→ 按当前算法重算台账（**不是**把历史楼层全判未分析）；
 *   ② 台账无该楼 → false；③ 内容哈希一致 → true；④ 内容变了 → false（视为需重新分析）。
 * @returns {boolean}
 */
export function isFloorProcessed(i) {
    try {
        if ((state.processedVer || '') !== processedVerTag()) { try { migrateProcessedFloorsV170(); } catch (e) { /* 忽略 */ } }
        const mark = processedMarkForCurrentChat(i);   // v3.40.0：跨聊天归属的标记不冒领本聊天
        if (!mark) return false;
        const h = hashFloorText(i);
        if (!h) return false;
        if (!mark.h || mark.h === h) return true;
        return false;
    } catch (e) { return false; }
}

/**
 * **内核状态是否已注入**（v3.24.1 真机根因修复）。
 *
 * 用户报告（原话）：「刷新后初始化阶段，插件会抛出两个错误，均可能是初始化顺序异常导致的数据错乱。」
 * 真机错误原文：「已处理楼层漂移防呆失败 Cannot read properties of null (reading 'processedFloors')」（另一条同类）。
 *
 * 根因（**初始化顺序**，确定性）：`state` 是内核的注入视图（`core/model/runtime.js` 的 `export let state = null`），
 *   只在「载入 → 注入」之后才有值。而 `index.js#init()` 的时序是：
 *     …→ `installHostBridges()`（537）→ **`panelStatusSnapshot()`（545 / 562）** → `loadMemoryState()`（564，内部才 `setKernelState`）
 *   即**状态注入之前**就会走一遍面板状态快照 → `pendingFloors()` → `listUnprocessedFloors()` →
 *   `scanPendingFloors()` 的**台账维护块**（765~769）→ `processedDriftGuard()` / `reconcileProcessedFloors()`
 *   读 `state.processedFloors` → **`state` 为 null → TypeError** → 各函数的 `catch` 里 `warn(...)` →
 *   用户看到两条「…失败 Cannot read properties of null」的异常提示（且此时 `dbgLog` 尚未接线 → 调试日志里查不到，
 *   这正是「只看到弹窗、日志里什么都没有」的原因）。
 *
 * 判据：`state` 必须是对象才算就绪。未就绪时**任何台账读写都一律短路**（既不抛错、也绝不动数据）——
 *   「数据错乱」的风险恰恰在于早期误判：此时 `hashFloorText()` 可能全为空，台账一旦按空哈希刷新就会被清空。
 * @returns {boolean}
 */
export function kernelStateReady() {
    try { return !!state && typeof state === 'object'; } catch (e) { return false; }
}

/**
 * **聊天是否已就绪**（v2.87.0 修复「重启/更新后大量早期楼层冒出来」的关键守卫）。
 * 用户报告：「总览的未摘要每次更新或重启后，都会提示大量早期楼层，该问题在之前版本已经存在。」
 * 根因：插件启动/更新的时刻**聊天可能尚未同步进宿主 ctx**（`getCtx().chat` 为空或消息还没有正文）。
 *   此时 `hashFloorText()` 一律返回 `''`，而 `migrateProcessedFloorsV170()` 的口径是「无正文 → 丢弃该标记」
 *   → **整本台账被清空**并写入当前版本签名；等聊天同步完成后，台账已丢失，只剩「已有记忆数据」覆盖兜底，
 *   于是**早期楼层**（数据早被上限裁剪掉的那批）成片变回「未摘要」，且会随下一次保存永久落盘。
 * 判据（廉价、只读）：聊天为空 → 未就绪；否则取首/中/尾三楼采样，**全部拿不到正文** → 未就绪。
 * @returns {{ready:boolean, reason:string, total:number}}
 */
export function chatReadyForFloors() {
    try {
        const ctx = getCtx();
        const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
        const total = chat.length;
        if (total <= 0) return { ready: false, reason: 'no-chat', total: total };
        const probes = [0, Math.floor((total - 1) / 2), total - 1];
        let ok = 0;
        for (const i of probes) {
            const m = chat[i];
            if (!m) continue;
            if (String(floorStableText(m) || m.mes || '').trim()) ok++;
        }
        if (ok === 0) return { ready: false, reason: 'no-text', total: total };
        return { ready: true, reason: '', total: total };
    } catch (e) { return { ready: false, reason: 'error', total: 0 }; }
}

/** 台账归位刷新（V1 v1.170/v1.174 口径：签名不符时把已知楼层按当前算法重算哈希） */
export function migrateProcessedFloorsV170() {
    try {
        // v3.24.1：状态未注入 → 不迁移（此前会静默抛 `null.processedVer` 并被本函数的 catch 吞掉，
        //   表现为「迁移没做、也没人说」；现在如实回报 skipped）
        if (!kernelStateReady()) return { refreshed: 0, migrated: 0, skipped: 'state-not-ready' };
        // V1 v1.85 同款短路：**版本签名一致 → 直接返回**。缺了这一句时「旧标记迁移」会在每次扫描时
        //   把标记哈希刷成当前正文哈希 —— 那会把「正文被改写、本该重新分析」的楼层也永久判为已处理。
        if ((state.processedVer || '') === processedVerTag()) return { migrated: 0, skipped: 'current' };
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        if (!pf.length) { state.processedVer = processedVerTag(); return { refreshed: 0, migrated: 0 }; }
        // v2.87.0：聊天未就绪时**绝不动台账**（否则「无正文 → 丢弃标记」会把整本台账清空，见 chatReadyForFloors）
        const ready = chatReadyForFloors();
        if (!ready.ready) {
            try { log('摘要', { action: '已处理楼层迁移延后（聊天未就绪）', reason: ready.reason, marks: pf.length }); } catch (e) { /* 忽略 */ }
            // v2.87.0：不再「什么都没反应」——给一次**节流**的用户提示（同文案 60s 内只弹一次）
            try { notifyError('聊天尚未就绪，已处理楼层台账暂未刷新（不影响已分析记录）'); } catch (e) { /* 忽略 */ }
            return { refreshed: 0, migrated: 0, skipped: 'chat-not-ready' };
        }
        const lastId = Number(getLastMessageId());
        let refreshed = 0, dropped = 0, keptNoText = 0;
        const next = [];
        const droppedMarks = [];
        for (const x of pf) {
            const f = markFloor(x);
            if (!Number.isFinite(f) || f < 0) { dropped++; droppedMarks.push(x); continue; }
            if (Number.isFinite(lastId) && lastId >= 0 && f > lastId) { dropped++; droppedMarks.push(x); continue; }   // 楼层已不存在（删除/回滚）
            const h = hashFloorText(f);
            if (!h) {
                // v3.26.4（真机取证「突然冒出来大量未分析的楼层，实际早已分析」）：
                //   **楼层下标还在、只是这一步取不到正文** → 保留原标记，绝不因此丢弃。
                //   旧口径「无正文 → 丢弃该标记」在「宿主只交进来一部分聊天」时会把整本台账静默刷掉
                //   （丢的是**低楼层**标记），而丢完还要 `state.processedVer = 当前签名` —— 之后再无处可查。
                //   真正的「楼层不存在」由上一句的 `f > lastId` 判定（那是**可确认**的消失）。
                next.push({ f: f, h: String((x && x.h) || ''), at: markAt(x), ck: markChatKey(x) });
                keptNoText++;
                continue;
            }
            // v3.40.0（`docs/D16` A1）：刷新哈希时**保留归属与时刻** —— 迁移曾把 `ck/at` 一并丢掉，
            //   于是「标记属于哪条聊天」在升级后全部失效（跨聊天冒领的根因之一）。
            next.push({ f: f, h: h, at: markAt(x), ck: markChatKey(x) });
            refreshed++;
        }
        // v3.26.4：丢弃一律留痕（旧口径此处不留痕 → 恢复聊天后无法按内容归位）
        try { if (droppedMarks.length) rememberDroppedMarks(droppedMarks); } catch (e) { /* 忽略 */ }
        state.processedFloors = next.slice(-5000);
        state.processedVer = processedVerTag();
        if (next.length) state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, Math.max.apply(null, next.map((x) => x.f)));
        log('摘要', { action: 'v1.84 旧标记批量迁移', migrated: refreshed, dropped: dropped, keptNoText: keptNoText });
        return { refreshed, migrated: refreshed, dropped, keptNoText };
    } catch (e) { return { refreshed: 0 }; }
}

/** 记录已分析楼层（V1 `recordProcessedFloors`：`{f,h}` 台账 + 版本签名 + lastKnownFloor + 落盘） */
export function recordProcessedFloors(start, end) {
    try {
        // v3.24.1：状态未注入 → 不记账（绝不把「未就绪」写成「已处理」；调用方据 reason 可诊断）
        if (!kernelStateReady()) return { ok: false, reason: 'state-not-ready' };
        state.processedFloors = state.processedFloors || [];
        const map = new Map();
        for (const x of state.processedFloors) { const f = markFloor(x); if (Number.isFinite(f)) map.set(f, x); }
        const meta = markMeta();   // v3.40.0：归属 + 时刻
        for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) map.set(i, Object.assign({ f: i, h: hashFloorText(i) }, meta));
        state.processedFloors = Array.from(map.values()).slice(-5000);
        state.processedVer = processedVerTag();
        const endN = Number(end) || 0;
        if (endN > (Number(state.lastKnownFloor) || -1)) state.lastKnownFloor = endN;
        // v3.11.1：刚被重新分析的楼层 → 清掉它的「丢弃留痕」（否则覆盖判据会一直以为这楼内容被改写过）
        try { forgetDroppedMarks(start, end); } catch (e) { /* 忽略 */ }
        saveState();
        return { ok: true, count: state.processedFloors.length };
    } catch (e) { warn('已处理楼层记录失败', e); return { ok: false }; }
}

// ============================================================
// v3.11.1（真机取证）：**台账标记丢弃留痕** + **拆楼检测基线**
//
// 两个同源缺陷，都会让「已分析过的楼」与「该不该再分析」脱节：
//   ① **丢弃即失忆**：对账（`reconcileProcessedFloors`）与拆楼归位（`handleFloorShrink`）会按内容哈希
//      丢弃「对不上的标记」—— 丢弃后**旧哈希不留痕**，于是下游再也分不清「这楼从没分析过」与
//      「分析过、但正文被改写了」。而「已有记忆数据」覆盖兜底会把后者一并当成已分析 → **永远不再分析**。
//      真机证据：第 30/32/38/40/42 楼各有**自己产出的 `rumors` 单楼区间条目**（说明分析过），
//      但台账里没有它们的标记 → 被判「已覆盖」而静默跳过（用户看到的就是「这些楼一直不分析」）。
//   ② **拆楼基线错位**：`lastKnownFloor` 只在**记录分析结果**时更新，等于「已分析到哪」；而拆楼检测
//      拿它当「聊天曾经多长」。真机：聊天 49 楼、只分析到 22 楼 → 之后删到 29 楼时 `lastId(28) < known(22)-5`
//      不成立 → **真实收缩检测不到** → 来源楼层不归位（条目停留在已不存在的楼号上）。
// 修法：① 丢弃的标记进 `state.processedDropped`（有界、按楼层去重），覆盖判据遇「旧哈希 ≠ 当前哈希」
//   即视为**正文已改写**，不再跳过；② 新增 `state.lastChatFloor`（最近见到的聊天末楼），基线取两者较大值。
// ============================================================

/** 丢弃留痕上限（条；按楼层去重后保留最新一批） */
const PROCESSED_DROPPED_CAP = 600;

/** v3.11.1：把「被丢弃的台账标记」留痕（有界、按楼层去重、新值覆盖；v3.40.0 起带归属与时刻） */
export function rememberDroppedMarks(list) {
    try {
        const meta = markMeta();
        const map = new Map();
        for (const src of [Array.isArray(state.processedDropped) ? state.processedDropped : [], list || []]) {
            for (const x of src) {
                const f = markFloor(x);
                if (!Number.isFinite(f) || f < 0) continue;
                map.set(f, { f: f, h: String((x && x.h) || ''), at: Number((x && x.at) || 0) || meta.at, ck: String((x && x.ck) || meta.ck) });
            }
        }
        const arr = Array.from(map.values()).sort((a, b) => a.f - b.f).slice(-PROCESSED_DROPPED_CAP);
        state.processedDropped = arr;
        return arr.length;
    } catch (e) { return 0; }
}

/** v3.11.1：重新分析过 [start,end] → 清掉这些楼的丢弃留痕 */
export function forgetDroppedMarks(start, end) {
    try {
        const arr = Array.isArray(state.processedDropped) ? state.processedDropped : [];
        if (!arr.length) return 0;
        const s = Math.max(0, Number(start) || 0), e = Number(end) || 0;
        const next = arr.filter((x) => { const f = markFloor(x); return !(Number.isFinite(f) && f >= s && f <= e); });
        const removed = arr.length - next.length;
        if (removed) state.processedDropped = next;
        return removed;
    } catch (e) { return 0; }
}

/**
 * v3.11.1：该楼是否有「被丢弃的标记」，且**旧哈希与当前正文不同**（= 正文确实被改写过）。
 *   旧哈希相同 → 正文没变 → 覆盖兜底照常生效（保守；避免把「楼层暂时消失又回来」误判成改写）。
 */
export function droppedContentChanged(i) {
    try {
        const arr = state.processedDropped;
        if (!Array.isArray(arr) || !arr.length) return false;
        const f = Number(i);
        const ck = currentChatMarkKey();
        let rec = null;
        for (const x of arr) {
            if (Number(x && x.f) !== f) continue;
            if (!markBelongsToCurrentChat(x, ck)) continue;   // v3.40.0：别的聊天的留痕不作数
            rec = x; break;
        }
        if (!rec || !rec.h) return false;
        const h = hashFloorText(f);
        return !!h && h !== String(rec.h);
    } catch (e) { return false; }
}

/**
 * v3.11.1：**断裂（拆楼）检测基线** = max(上次观察到的聊天末楼, 已分析最大楼)。
 *   · 只用 `lastKnownFloor`（旧口径）：它只在**记录分析结果**时更新 —— 聊天涨到 49 楼、只分析到 22 楼时
 *     基线严重落后，之后删到 29 楼要 `28 < 22-5` 才判收缩 → **真实收缩检测不到** → 来源楼层不归位。
 *   · 只用 `lastChatFloor`：它在**两次观察之间**聊天先涨后删时也会漏判（smoke BH13 就是这种局面）。
 *   · 取两者较大值：`lastChatFloor` 反映「上次看到多长」，`lastKnownFloor` 是「聊天至少曾有这么长」的
 *     硬证据（分析过第 N 楼 ⇒ 当时至少有 N+1 层），两者互补。
 *   注意 `noteChatFloor` 是 **last-seen（可回落）** —— 若把它做成「见过的最大值」，切到更短的聊天会每次都误判收缩。
 */
export function shrinkBaseline() {
    try {
        return Math.max(Number(state.lastChatFloor) || -1, Number(state.lastKnownFloor) || -1);
    } catch (e) { return -1; }
}

/**
 * v3.11.1：记下「本次见到的聊天末楼」（拆楼检测基线，**可回落** = last-seen 语义）。
 *   收缩后必须能降到新末楼，否则下一次收缩会被重复判定。
 */
export function noteChatFloor(tail) {
    try {
        const n = Number(tail);
        if (!Number.isFinite(n) || n < -1) return -1;
        state.lastChatFloor = n;
        return n;
    } catch (e) { return -1; }
}

// ============================================================
// v2.64.0「未摘要楼层跳过机制」（用户报告：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，
//   请核对跳过机制。当**原子数据对应的楼层存在时，则不需要分析**。」）
// 清单前的**台账维护**与**跳过判据**（顺序与 V1 `pendingFloorList` 一致，逐条对齐后补一条 V2 新规则）：
//   ① `migrateProcessedFloorsV170()`：升级期旧标记按当前取文口径重算（幂等），避免升级后成片变回未摘要；
//   ② `processedDriftGuard(false)`：**必须先于归位对账** —— 取文口径整体漂移时按当前算法刷新全部标记
//      （保留「已处理」语义），否则对账会把「哈希对不上的标记」当内容变更全部丢弃；
//   ③ `reconcileProcessedFloors(false)`（20s 节流）：其他插件增删/隐藏楼层造成的索引错位 → 按哈希归位；
//   ④ 逐楼跳过：非 AI 楼 / 隐藏楼 / 无可分析正文（占位楼、被投喂白黑名单过滤）/ 台账已处理 /
//      **该楼已有记忆数据（v2.64.0 新增，见 `core/floor-cover.js`）**。
// ============================================================
const RECONCILE_MS = 20000;
let lastReconcileTs = 0;
const DRIFT_MS = 20000;
let lastDriftTs = 0;

/**
 * 哈希漂移防呆（V1 v1.174 `processedDriftGuard` 逐条移植）：
 *   已存标记里**过半**与当前哈希对不上、且基数 ≥10 时，判定为「取文口径漂移」（宿主/插件更新、取文方式变化、
 *   swipes 不再返回…），一次性按当前算法刷新全部标记 —— 而不是把历史已分析楼层整体抛成「未摘要」。
 *   少量失配（<50%）仍按「内容真的被改写」处理，只列真正变化的那几楼。
 * @param {boolean} [notify] 是否提示用户（清单路径传 false）
 * @param {boolean} [force] 跳过 20s 节流
 */
export function processedDriftGuard(notify, force) {
    try {
        // v3.24.1：内核状态尚未注入（刷新后 init 早期的面板状态快照会走到这里）→ 一律短路，绝不在
        //   `state` 为 null 时读台账（真机报错「…漂移防呆失败 Cannot read properties of null」的根因）
        if (!kernelStateReady()) return { skipped: 'state-not-ready' };
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        if (pf.length < 10) return { skipped: 'too-few' };
        const ready = chatReadyForFloors();
        if (!ready.ready) return { skipped: 'chat-not-ready' };      // v2.87.0：聊天未就绪 → 不判定漂移、不动台账
        const lastId = Number(getLastMessageId());
        if (!Number.isFinite(lastId) || lastId < 0 || lastId > 5000) return { skipped: 'no-chat-or-too-large' };
        const known = shrinkBaseline();          // v3.11.1：与拆楼检测同一基线（含最近见到的末楼）
        if (Number.isFinite(known) && known >= 0 && lastId < known - 5) return { skipped: 'floor-shrunk' };   // 真删楼 → 交给断裂检测
        const now = Date.now();
        // 节流：完整判定要逐楼算哈希。节流期内先用**抽样**兜底 —— 末尾 5 个标记全部失配即认定漂移，立刻升级为完整判定
        if (!force && (now - lastDriftTs) < DRIFT_MS) {
            const sample = pf.slice(-5);
            let sChecked = 0, sMismatch = 0;
            for (const m of sample) {
                const f = Number(m && m.f);
                if (!Number.isFinite(f) || f < 0 || f > lastId) continue;
                const h = hashFloorText(f);
                if (!h) continue;
                sChecked++;
                if (String((m && m.h) || '') !== h) sMismatch++;
            }
            if (!(sChecked >= 3 && sMismatch === sChecked)) return { skipped: 'throttled' };
        }
        lastDriftTs = now;
        let checked = 0, mismatch = 0;
        for (const m of pf) {
            const f = Number(m && m.f);
            if (!Number.isFinite(f) || f < 0 || f > lastId) continue;
            const h = hashFloorText(f);
            if (!h) continue;                       // 楼层不存在 / 无正文 → 不计入漂移判定
            checked++;
            if (String((m && m.h) || '') !== h) mismatch++;
        }
        if (checked < 10) return { skipped: 'too-few-existing' };
        const ratio = mismatch / checked;
        if (ratio < 0.5) return { checked: checked, mismatch: mismatch, ratio: ratio, drifted: false };
        // 漂移 → 全量按当前算法刷新（楼层号不变 → 仍视为「已处理」，不重新分析）
        const out = [];
        let dropped = 0, keptNoText = 0;
        const droppedMarks = [];
        for (const m of pf) {
            const f = Number(m && m.f);
            if (!Number.isFinite(f) || f < 0 || f > lastId) { dropped++; droppedMarks.push(m); continue; }
            const h = hashFloorText(f);
            if (!h) {
                // v3.26.4：楼层下标还在、只是取不到正文 → **保留标记**（旧口径在这里丢弃 → 台账被静默刷掉，
                //   见 `migrateProcessedFloorsV170` 同批注释）；漂移刷新只为换哈希，不为删条目。
                out.push({ f: f, h: String((m && m.h) || ''), at: markAt(m), ck: markChatKey(m) });
                keptNoText++;
                continue;
            }
            out.push({ f: f, h: h, at: markAt(m), ck: markChatKey(m) });   // v3.40.0（A1）：刷新哈希保留归属/时刻
        }
        try { if (droppedMarks.length) rememberDroppedMarks(droppedMarks); } catch (e) { /* 忽略 */ }
        state.processedFloors = out;
        state.processedVer = processedVerTag();
        state.lastKnownFloor = Math.max(Number.isFinite(known) ? known : -1, lastId);
        saveState();
        log('摘要', { action: '已处理楼层哈希漂移 → 全量刷新', before: pf.length, after: out.length, dropped: dropped, keptNoText: keptNoText, ratio: Number(ratio.toFixed(3)) });
        return { drifted: true, before: pf.length, after: out.length, dropped: dropped, keptNoText: keptNoText, ratio: ratio };
    } catch (e) { warn('已处理楼层漂移防呆失败', e); return { skipped: 'error' }; }
}

/**
 * 已处理楼层哈希归位对账（V1 v1.70/v1.174 `reconcileProcessedFloors` 逐条移植）：
 *   其他插件增删/隐藏楼层导致索引错位时，按「当前内容哈希 ∈ 历史已处理哈希集」把标记归位到新索引
 *   （内容未变只挪位置 → 保持已处理，不再冒出）。
 *   大批量失配（≥50% 且基数 ≥10）**不删标记** —— 交给 `processedDriftGuard` 按当前口径整体刷新。
 * v3.26.4（真机取证「突然冒出来大量未分析的楼层，实际早已分析」）：**「丢弃留痕」里的历史哈希同样是「在册证据」** ——
 *   删楼丢弃的低楼层标记进留痕后，若聊天被恢复 / 撤销 / 切回更长分支（内容回来了），只按当前标记重建会**漏掉这批楼层**，
 *   而下面的「丢弃前留痕」还会用**错位的新哈希覆盖旧留痕** → 那批楼层从此既无标记也无留痕（真机 41 层就是这样丢的）。
 *   现在：留痕哈希参与归位（内容找到 → 重新在册），且**内容已找到的留痕随即失效**（只保留「内容确实没了」的）。
 */
export function reconcileProcessedFloors(notify) {
    try {
        // v3.24.1：同上 —— 内核状态未注入时不做归位对账（真机第二条报错即此处）
        if (!kernelStateReady()) return { kept: 0, dropped: 0, skipped: 'state-not-ready' };
        const pf = state.processedFloors || [];
        if (!pf.length) return { kept: 0, dropped: 0 };
        // v2.87.0：聊天未就绪 → 不归位、不丢标记（**先于**版本判定，保证重启期的原因一致可诊断）
        const ready = chatReadyForFloors();
        if (!ready.ready) return { kept: pf.length, skipped: 'chat-not-ready' };
        if ((state.processedVer || '') !== processedVerTag()) return { skipped: 'pre-upgrade' };   // 升级期由 isFloorProcessed 逐楼刷新
        const lastId = Number(getLastMessageId());
        if (!Number.isFinite(lastId) || lastId < 0 || lastId > 5000) return { skipped: 'no-chat-or-too-large' };
        const oldHashes = new Set();
        for (const m of pf) { const h = m && m.h; if (h) oldHashes.add(h); }
        const droppedBefore = Array.isArray(state.processedDropped) ? state.processedDropped.slice() : [];
        for (const x of droppedBefore) { const h = x && x.h; if (h) oldHashes.add(String(h)); }   // v3.26.4：留痕也算在册证据
        if (!oldHashes.size) return { kept: 0, dropped: 0 };
        const keep = [];
        const found = new Set();          // 在当前聊天里找到的历史哈希（含来自留痕的）
        // v3.40.0（A1）：归位时按**哈希**继承原标记的归属 / 时刻（改的是楼层号，不是「哪个聊天分析的」）
        const metaByHash = new Map();
        for (const m of pf) { const h = String((m && m.h) || ''); if (h && !metaByHash.has(h)) metaByHash.set(h, { at: markAt(m), ck: markChatKey(m) }); }
        for (let f = 0; f <= lastId; f++) {
            const h = hashFloorText(f);
            if (h && oldHashes.has(h)) {
                const meta = metaByHash.get(h) || { at: Date.now(), ck: currentChatMarkKey() };
                keep.push({ f: f, h: h, at: meta.at, ck: meta.ck });
                found.add(h);
            }
        }
        const before = pf.length;
        // 「真的丢了」= 台账标记的哈希在当前聊天里**找不到**（留痕救回的不算丢弃 → dropped 可能小于 0？不，这里按标记算）
        const lostList = pf.filter((m) => { const h = String((m && m.h) || ''); return !h || !found.has(h); });
        const dropped = lostList.length;
        if (before >= 10 && dropped / before >= 0.5) {
            log('摘要', { action: '已处理楼层对账跳过（整体失配）', before: before, wouldDrop: dropped });
            return { kept: before, dropped: 0, skipped: 'mass-mismatch' };
        }
        // v3.11.1：**丢弃前留痕**（旧哈希进 `processedDropped`）—— 覆盖判据据此识别「正文被改写过」。
        // v3.26.4：只对**确实找不到内容**的标记留痕（旧实现拿「楼层号没保留」当丢弃 → 会用错位的新哈希覆盖旧留痕）；
        //   同时把「内容已重新找到」的留痕**失效**（它们已重新在册，留着只会让覆盖判据误判「正文被改写」）。
        try {
            rememberDroppedMarks(lostList);
            const arr = Array.isArray(state.processedDropped) ? state.processedDropped : [];
            const keepDropped = arr.filter((x) => { const h = String((x && x.h) || ''); return !(h && found.has(h)); });
            if (keepDropped.length !== arr.length) state.processedDropped = keepDropped;
        } catch (e) { /* 忽略 */ }
        // v2.64.0（V1 缺陷修复）：V1 只在 `dropped !== 0` 时写回 —— 于是「条数不变、只是楼层号整体挪位」
        //   （顶部插入一条新消息，其余内容整体后移）时**归位结果被丢弃**：标记仍指向旧楼层号，
        //   表现为旧楼层继续「已处理」、新位置反而被列为未摘要（用户报告「不应该分析的会被展示出来」）。
        //   现在只要归位结果与现有标记不同就写回（内容未变的楼仍是已处理，只是落到正确楼层号）。
        const relocated = keep.length !== before || keep.some((x, i) => markFloor(pf[i]) !== x.f);
        if (dropped !== 0 || relocated) {
            state.processedFloors = keep;
            if (keep.length) {
                const maxF = Math.max.apply(null, keep.map((x) => x.f));
                state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, maxF);
            }
            saveState();
            log('摘要', { action: '已处理楼层对账（哈希归位）', before: before, kept: keep.length, dropped: dropped, relocated: relocated });
            if (notify && dropped > 0) log('摘要', { action: '已处理楼层对账完成', dropped: dropped });
        }
        return { kept: keep.length, dropped: dropped, relocated: relocated };
    } catch (e) { warn('已处理楼层对账失败', e); return { dropped: -1 }; }
}

/**
 * v3.26.4（真机取证「新版本 请调试对接，突然冒出来大量未分析的楼层，实际早已分析」）——
 * **台账自愈（留痕回填）+ 诊断量表**。
 *
 * 真机事实（只读取证，未改任何数据）：
 *   · 聊天 231 层（0..230），台账 `processedFloors` 只剩 68 条，且全部与各自楼层正文**哈希一致**（台账本身没错位）；
 *   · 未分析清单重算 = 41 层（全是 AI 楼 2,4,…,98）——这批楼层**既无标记、也无「丢弃留痕」、覆盖判据也不认**；
 *   · 旧副本（本机缓冲 16:30）里同一台账有 104 条标记 —— 低楼层标记是在某次删楼 / 换聊天 / 部分载入之后
 *     **被静默丢弃**的：`core/floor-trim.js#remapAfterTrim` 与两处维护函数丢弃标记时**不留痕**，
 *     于是「正文其实还在」也无从归位。
 *
 * 本批三件事：
 *   ① 丢弃一律留痕（删楼 / 迁移 / 漂移刷新三处补齐，与 v3.11.1 同口径）；
 *   ② **留痕回填**：留痕里的旧哈希若在当前聊天里按内容找得到 → 该楼内容仍在 → 恢复为「已处理」标记
 *      （这正是「删楼 → 撤销 / 恢复聊天 / 切回更长分支 / 换同角色另一条聊天」之后的救回路径）；
 *   ③ **「原文已移除」常态化复核**：原文还在（位置指纹找得到）→ 解除标记并归位，
 *      不再要求「必须先检测到楼层收缩」。
 */

/** 上一次「留痕回填」的结果（只读诊断用；由扫描路径写入） */
let lastLedgerHeal = null;
/** @returns {{at:number, restored:number, kept:number, floors:number[]}|null} */
export function lastLedgerHealInfo() { return lastLedgerHeal ? Object.assign({}, lastLedgerHeal) : null; }

/** 当前聊天「内容哈希 → 楼层」索引（0..lastId，只读；同哈希取最小楼层） */
function nowHashIndex(lastId) {
    const at = new Map();
    try {
        for (let f = 0; f <= lastId; f++) {
            const h = hashFloorText(f);
            if (!h) continue;
            if (!at.has(h)) at.set(h, f);
        }
    } catch (e) { /* 读取失败 → 空索引 */ }
    return at;
}

/**
 * **留痕回填**：把「丢弃留痕」里内容仍在的那些楼层恢复为「已处理」标记。
 *   判据与 `reconcileProcessedFloors` 同源（**按内容哈希定位**，不看楼层号）：
 *   · 旧哈希在当前聊天里找得到 → 内容仍在 → 恢复标记（若该楼已有标记则保留现有，不覆盖）；
 *   · 找不到 → 内容确实没了 → **保留留痕**（口径不变：`droppedContentChanged` 继续如实判「正文被改写」）。
 * @returns {{restored:number, kept:number, floors?:number[], skipped?:string}}
 */
export function healLedgerFromDropped() {
    try {
        if (!kernelStateReady()) return { restored: 0, kept: 0, skipped: 'state-not-ready' };
        const arr = Array.isArray(state.processedDropped) ? state.processedDropped : [];
        if (!arr.length) { lastLedgerHeal = { at: Date.now(), restored: 0, kept: 0, floors: [] }; return { restored: 0, kept: 0, skipped: 'no-dropped' }; }
        const ready = chatReadyForFloors();
        if (!ready.ready) return { restored: 0, kept: arr.length, skipped: 'chat-not-ready' };
        const lastId = ready.total - 1;
        if (!Number.isFinite(lastId) || lastId < 0) return { restored: 0, kept: arr.length, skipped: 'no-chat' };
        const idx = nowHashIndex(lastId);
        const ck = currentChatMarkKey();   // v3.40.0：只回填**属于本聊天**的留痕（别的聊天的留痕不作数）
        const meta = markMeta();
        const marks = new Map();
        for (const x of (Array.isArray(state.processedFloors) ? state.processedFloors : [])) {
            const f = markFloor(x);
            if (Number.isFinite(f) && f >= 0) marks.set(f, { f: f, h: String((x && x.h) || ''), at: markAt(x), ck: markChatKey(x) });
        }
        const keep = [];
        const floors = [];
        for (const x of arr) {
            const h = String((x && x.h) || '');
            if (!markBelongsToCurrentChat(x, ck)) { keep.push({ f: markFloor(x), h: h, at: markAt(x), ck: markChatKey(x) }); continue; }
            const at = h ? idx.get(h) : undefined;
            if (at === undefined) { keep.push({ f: markFloor(x), h: h, at: markAt(x), ck: markChatKey(x) }); continue; }
            if (!marks.has(at)) { marks.set(at, { f: at, h: h, at: meta.at, ck: ck }); floors.push(at); }
        }
        const restored = floors.length;
        if (restored) {
            state.processedFloors = Array.from(marks.values()).sort((a, b) => a.f - b.f).slice(-5000);
            state.processedVer = processedVerTag();
            state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, Math.max.apply(null, floors));
        }
        if (keep.length !== arr.length) state.processedDropped = keep;
        if (restored || keep.length !== arr.length) {
            saveState();
            log('摘要', { action: '台账留痕回填（内容仍在 → 恢复为已处理）', restored: restored, kept: keep.length });
        }
        lastLedgerHeal = { at: Date.now(), restored: restored, kept: keep.length, floors: floors.slice(0, 60) };
        return { restored: restored, kept: keep.length, floors: floors };
    } catch (e) { warn('台账留痕回填失败', e); return { restored: 0, kept: 0, error: String((e && e.message) || e) }; }
}

/**
 * **「原文已移除」常态化复核**（v3.26.4）：只对**带位置指纹**（`floorNowHash`）的条目复核 ——
 *   指纹在当前聊天里找得到 → 原文仍在 → `clearGone` + 归位（`floorNow*` = 找到的楼层 + 原跨度）。
 *   注意：本函数**只解除标记**（保守方向）；找不到的条目保持「原文已移除」，绝不臆断。
 * @returns {{restored:number, checked:number, stillGone:number, skipped?:string}}
 */
export function recheckOriginGone() {
    try {
        if (!kernelStateReady()) return { restored: 0, checked: 0, stillGone: 0, skipped: 'state-not-ready' };
        const ready = chatReadyForFloors();
        if (!ready.ready) return { restored: 0, checked: 0, stillGone: 0, skipped: 'chat-not-ready' };
        const lastId = ready.total - 1;
        if (!Number.isFinite(lastId) || lastId < 0) return { restored: 0, checked: 0, stillGone: 0, skipped: 'no-chat' };
        const idx = nowHashIndex(lastId);
        let restored = 0, checked = 0, stillGone = 0;
        for (const d of DIMENSIONS) {
            for (const it of (Array.isArray(state[d.kind]) ? state[d.kind] : [])) {
                if (!it || it.originGone !== true) continue;
                const fn = it.floorNowHash ? String(it.floorNowHash) : '';
                if (!fn) continue;                       // 无指纹 → 无从复核（保持「原文已移除」）
                checked++;
                const at = idx.get(fn);
                if (at === undefined) { stillGone++; continue; }
                const r = originFloorRange(it);
                it.floorNowStart = at;
                it.floorNowEnd = at + (r ? Math.max(0, r[1] - r[0]) : 0);
                delete it.originGone;
                delete it.originGoneAt;
                restored++;
            }
        }
        if (restored) {
            saveState();
            log('摘要', { action: '「原文已移除」复核：内容仍在 → 解除标记', restored: restored, checked: checked });
        }
        return { restored: restored, checked: checked, stillGone: stillGone };
    } catch (e) { warn('「原文已移除」复核失败', e); return { restored: 0, checked: 0, stillGone: 0, error: String((e && e.message) || e) }; }
}

/**
 * v3.26.4（用户补救出口）：**把指定楼层登记为「已分析」** —— 只写台账标记，
 *   **不动任何记忆条目、不调用 AI、不改正文**（与 `clearProcessedFloors` 互为逆操作）。
 * 用途：标记确实丢失、数据里也再无证据的楼层（真机 41 层即此情形）——用户确认「这些楼当初分析过」后，
 *   一次性登记，避免它们被重复分析（重复分析会重复落库、白花 token）。
 * 口径与扫描一致：只登记**存在、非隐藏、非用户、有正文**的楼层；登记失败/跳过如实计数回报。
 * @param {number[]} list 楼层号清单
 * @returns {{ok:boolean, marked:number, skipped:number, floors?:number[], reason?:string}}
 */
export function markFloorsProcessed(list) {
    try {
        if (!kernelStateReady()) return { ok: false, reason: 'state-not-ready', marked: 0, skipped: 0 };
        const ready = chatReadyForFloors();
        if (!ready.ready) return { ok: false, reason: 'chat-not-ready', marked: 0, skipped: 0 };
        const nums = (Array.isArray(list) ? list : []).map((x) => Number(x)).filter((f) => Number.isInteger(f) && f >= 0);
        if (!nums.length) return { ok: false, reason: 'empty', marked: 0, skipped: 0 };
        const map = new Map();
        for (const x of (Array.isArray(state.processedFloors) ? state.processedFloors : [])) {
            const f = markFloor(x);
            if (Number.isFinite(f) && f >= 0) map.set(f, { f: f, h: String((x && x.h) || ''), at: markAt(x), ck: markChatKey(x) });
        }
        const meta = markMeta();   // v3.40.0：登记也带归属 + 时刻（旧值被新值覆盖是登记语义）
        let marked = 0, skipped = 0;
        const done = [];
        for (const f of nums) {
            const m = floorMessage(f);
            const h = hashFloorText(f);
            if (!m || m.is_hidden || m.is_user || !h) { skipped++; continue; }
            map.set(f, Object.assign({ f: f, h: h }, meta));
            marked++;
            done.push(f);
        }
        if (!marked) return { ok: false, reason: 'nothing-markable', marked: 0, skipped: skipped };
        state.processedFloors = Array.from(map.values()).sort((a, b) => a.f - b.f).slice(-5000);
        state.processedVer = processedVerTag();
        state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, Math.max.apply(null, done));
        // 登记成功 → 这些楼的「丢弃留痕」失效（它们已重新在册；留痕只描述「不在册」）
        try {
            const set = new Set(done);
            const arr = Array.isArray(state.processedDropped) ? state.processedDropped : [];
            const keep = arr.filter((x) => !set.has(markFloor(x)));
            if (keep.length !== arr.length) state.processedDropped = keep;
        } catch (e) { /* 忽略 */ }
        saveState();
        log('摘要', { action: '用户登记未分析楼层为已分析', marked: marked, skipped: skipped, count: done.length });
        return { ok: true, marked: marked, skipped: skipped, floors: done };
    } catch (e) { warn('登记已分析楼层失败', e); return { ok: false, reason: 'error', marked: 0, skipped: 0 }; }
}

/**
 * **台账健康量表**（v3.26.4；只读诊断，供调试桥 `ftt.ledger.health` 与真机取证）。
 *   回答三个问题：台账有多少条、有多少条**在当前聊天里读不到正文**（部分载入/楼层消失的信号）、
 *   留痕有几条、覆盖几层、未分析几层、上次留痕回填救回几条。
 */
export function ledgerHealth() {
    try {
        if (!kernelStateReady()) return { ready: false };
        const lastId = (() => { try { const ctx = getCtx(); const n = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0; return n > 0 ? n - 1 : -1; } catch (e) { return -1; } })();
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        const ck = currentChatMarkKey();   // v3.40.0：归属未知（''）时不做跨聊天判定（保守）
        let readable = 0, unreadable = 0, outOfRange = 0, crossChat = 0, noTimestamp = 0, legacyNoCk = 0;
        for (const x of pf) {
            const mck = markChatKey(x);
            if (!mck) legacyNoCk++;
            if (!markAt(x)) noTimestamp++;
            if (ck && mck && mck !== ck) { crossChat++; continue; }   // 属于别的聊天 → 不计入本聊天的可读/越界
            const f = markFloor(x);
            if (!Number.isFinite(f) || f < 0) { outOfRange++; continue; }
            if (f > lastId) { outOfRange++; continue; }
            if (hashFloorText(f)) readable++; else unreadable++;
        }
        const dropped = Array.isArray(state.processedDropped) ? state.processedDropped : [];
        const droppedCrossChat = dropped.filter((x) => ck && markChatKey(x) && markChatKey(x) !== ck).length;
        const droppedNoTimestamp = dropped.filter((x) => !markAt(x)).length;
        const cov = floorCoverage(state, { maxFloor: lastId });
        const pending = listUnprocessedFloors({ maintain: false });
        return {
            ready: true, lastId: lastId,
            marks: pf.length, marksReadable: readable, marksUnreadable: unreadable, marksOutOfRange: outOfRange,
            // v3.40.0（`docs/D16` A1）：把「为什么这些标记不能证明本聊天已分析」分成三个可见数字
            marksCrossChat: crossChat, marksNoTimestamp: noTimestamp, marksLegacyNoChat: legacyNoCk,
            chatKey: ck,
            dropped: dropped.length, droppedCrossChat: droppedCrossChat, droppedNoTimestamp: droppedNoTimestamp,
            coverFloors: cov.floors, coverItems: cov.items, coverIgnored: cov.ignored,
            pending: pending.length, pendingFloors: pending.slice(0, 60),
            verMatches: (state.processedVer || '') === processedVerTag(),
            lastHeal: lastLedgerHealInfo(),
        };
    } catch (e) { return { ready: false, error: String((e && e.message) || e) }; }
}

/**
 * v2.93.0（`docs/D12` v0.2 裁决）——**楼层收缩处理**（补上 V1 遗留但缺失的「断裂检测」）。
 * 背景：用户会**主动删楼**以减小聊天体积（酒馆对高楼层支持差）→ 这是**常态**操作，必须低噪声且**不丢数据**。
 * 口径（逐条对应 D12）：
 *   · 判据（Q2）：`getLastMessageId() < lastKnownFloor - 容忍` 且**聊天已就绪**（复用 `chatReadyForFloors`）；
 *   · 台账（Q3）：**强制跑一次哈希归位**（绕过 20s 节流与 `mass-mismatch` 守卫 —— 此时整体失配是**预期**）；
 *   · 编号（Q1）：条目的 `floorStart/floorEnd` 与分段总结 `start/end` 若已超过当前末楼 → **只改编号**：
 *     置「未知区间」(`0/0`) 并打 `floorStale: true`（**绝不删除条目**）；
 *   · 基线（Q9）：`lastKnownFloor` **收紧**为当前末楼；
 *   · 低噪声（D12 §8-A）：登记一条**按类型合并计数**的人工确认项 + 调试日志；
 *   · 幂等：无收缩、或聊天未就绪 → 直接返回（不动作）。
 * @param {{force?:boolean, silent?:boolean}} [opts]
 * @returns {{ok:boolean, skipped?:string, removedFloors?:number, staleEntries?:number, dims?:object, marks?:number, lastId?:number}}
 */
export function handleFloorShrink(opts) {
    const o = opts || {};
    /**
     * v3.0.19：**额外的「历史已处理哈希」**（调用方传入）。
     *   用途：内置删楼先做了「按 M 整体前移」的重映射，若删除**只成功了一部分**（前缀里有「洞」），
     *   前移量与实际下标会对不上，部分**仍然存在**的楼层其标记会被重映射丢掉（`f < M` 直接丢弃）。
     *   把**重映射之前**的全部标记哈希传进来，据此按内容把台账归位 —— 于是那些楼层仍是「已处理」，
     *   不会在删楼后被当成未摘要而**成片重分析**（用户报告「删除后无法正常继续分析」的另一面）。
     * @type {Iterable<string>|undefined}
     */
    const extraHashes = (() => {
        try {
            const e = o.extraHashes;
            if (!e) return [];
            return Array.from(e).map((x) => String(x || '')).filter(Boolean);
        } catch (e) { return []; }
    })();
    try {
        const ready = chatReadyForFloors();
        if (!ready.ready) return { ok: true, skipped: 'chat-not-ready' };
        // v3.24.1：内核状态未注入 → 不动作（收缩处理会**写台账**；此刻写下去等于把数据建在空状态上）
        if (!kernelStateReady()) return { ok: true, skipped: 'state-not-ready' };
        const total = ready.total;
        const lastId = total - 1;
        const known = shrinkBaseline();          // v3.11.1：含「最近见到的聊天末楼」，不再只看分析进度
        const TOL = 5;
        const shrunk = Number.isFinite(known) && known >= 0 && lastId < known - TOL;
        noteChatFloor(lastId);                    // v3.11.1：无论是否收缩，都刷新「最近见到的末楼」基线
        if (!shrunk && !o.force) return { ok: true, skipped: 'no-shrink', lastId: lastId };
        // ①-0 v3.7.0：**先快照突变前的台账**（`f → h`，f = 突变**前**的楼层号）。第 ① 步会把台账整体重建成
        //   「当前聊天里还能对上的楼层」，之后再也读不到原始楼层号 —— 而「当前位置」正是要靠这份快照才能算出来。
        const preLedger = (() => {
            try {
                return (Array.isArray(state.processedFloors) ? state.processedFloors : [])
                    .map((x) => ({ f: Number(x && x.f), h: String((x && x.h) || '') }))
                    .filter((x) => Number.isFinite(x.f) && x.f >= 0 && !!x.h);
            } catch (e) { return []; }
        })();
        // ① 台账：强制哈希归位（收缩时整体失配属预期，故绕过 mass-mismatch 守卫）
        let marks = 0;
        try {
            const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
            const hist = new Set(extraHashes);                          // v3.0.19：历史已处理哈希（含重映射前被丢掉的）
            for (const x of pf) { const h = String((x && x.h) || ''); if (h) hist.add(h); }
            const keep = [];
            // v3.40.0（A1）：拆楼归位同样按哈希继承归属 / 时刻
            const metaByHash2 = new Map();
            for (const x of pf) { const h = String((x && x.h) || ''); if (h && !metaByHash2.has(h)) metaByHash2.set(h, { at: markAt(x), ck: markChatKey(x) }); }
            for (let f = 0; f <= lastId; f++) {
                const h = hashFloorText(f);
                if (!h) continue;
                if (hist.has(h)) {
                    const meta = metaByHash2.get(h) || { at: Date.now(), ck: currentChatMarkKey() };
                    keep.push({ f: f, h: h, at: meta.at, ck: meta.ck });
                }
            }
            state.processedFloors = keep;
            state.processedVer = processedVerTag();
            marks = keep.length;
            // v3.11.1：拆楼归位同样**丢弃前留痕**（旧哈希），供覆盖判据识别「正文已改写」
            try {
                const keptFloors = new Set(keep.map((x) => Number(x.f)));
                rememberDroppedMarks(pf.filter((x) => !keptFloors.has(markFloor(x))));
            } catch (e) { /* 忽略 */ }
        } catch (e) { /* 归位失败不阻塞后续 */ }
        // ② v3.7.0（用户要求）：**来源楼层（floorStart/floorEnd）永不变动**；改为维护「当前位置」与「原文已移除」标记。
        //   · 先按**内容哈希**算出「当前聊天里每个楼层的哈希」与「突变前台账的楼层→哈希」，据此把条目的原始区间
        //     平移到它现在的位置（哈希在哪个楼层找到 → 那一段就整体前/后移）；
        //   · 某个原始楼层的哈希在**当前聊天里找不到** → 该楼层原文已移除 → 给条目打 `originGone`（内容与来源楼层都保留）；
        //   · 完全查不到哈希信息、且原始区间已超出当前末楼 → 同样视为原文已移除（位置根本不存在）。
        const dims = {};
        let staleEntries = 0;      // v3.7.0 起 = 「原文已移除」条数（字段名保持兼容，报告文案已更新）
        // 突变前的台账（f → h）与当前聊天的（h → f）
        const oldHashAt = {};
        const nowHashAt = {};
        let nowHashes = 0;
        try {
            for (let f = 0; f <= lastId; f++) { const h = hashFloorText(f); if (h) { nowHashAt[h] = f; nowHashes++; } }
        } catch (e) { /* 忽略 */ }
        try {
            // v3.7.0：**突变前的台账是权威**（原始楼层号 → 内容哈希）；重建后的台账只作兜底补空。
            for (const x of preLedger) oldHashAt[x.f] = x.h;
            for (const x of (Array.isArray(state.processedFloors) ? state.processedFloors : [])) {
                const f = Number(x && x.f), h = String((x && x.h) || '');
                if (Number.isFinite(f) && h && oldHashAt[f] === undefined) oldHashAt[f] = h;
            }
        } catch (e) { /* 忽略 */ }
        // 重建后的台账：**当前聊天里「内容在册」的楼层 → 该楼内容哈希**（用于给「当前位置」做复核）
        const ledgerAt = {};
        try {
            for (const x of (Array.isArray(state.processedFloors) ? state.processedFloors : [])) {
                const f = Number(x && x.f), h = String((x && x.h) || '');
                if (Number.isFinite(f) && h) ledgerAt[f] = h;
            }
        } catch (e) { /* 忽略 */ }
        /** 清除「原文已移除」标记（原文又找到了） */
        const clearGone = (it) => { try { if (it.originGone === true) { delete it.originGone; delete it.originGoneAt; } } catch (e) { /* 忽略 */ } };
        /**
         * 条目位置核算（v3.7.0 用户要求：来源楼层永不变动 / 找不到原文档标「原文已移除」/ 新楼按**新位置**记）：
         *   ① 原文档（台账里 `floorStart` 那一楼的内容哈希）在当前聊天里找得到 → 写 `floorNow*`（当前位置）+ 记
         *      `floorNowHash`（当前位置的内容指纹，供下次复核）；原文仍在 → 解除「原文已移除」；
         *   ② 原文找不到，但条目自己的 `floorNowHash` 在当前聊天里找得到 → 当前位置**整体平移**到该处（同一段内容搬了家）；
         *   ③ `floorNowHash` 也找不到 → 当前位置的内容**也被移除了** → 转「原文已移除」（不再占用任何楼层）；
         *   ④ 没有 `floorNowHash`（位置由删楼时的**精确前移**写入，量已知）→ 该楼在册就补记指纹；否则**保守保留**，不臆断；
         *   ⑤ 查不到任何哈希信息、且原始区间已根本不存在（超出当前末楼）→ 判「原文已移除」。
         * 纪律：**不删任何条目、不改 `floorStart/floorEnd`**。
         */
        const mapEntry = (it) => {
            try {
                if (!it || typeof it !== 'object') return 0;
                const r = originFloorRange(it);
                if (!r) return 0;
                const ns0 = Number(it.floorNowStart), ne0 = Number(it.floorNowEnd);
                const hasNow = Number.isInteger(ns0) && Number.isInteger(ne0) && ns0 >= 0 && ne0 >= ns0;
                const h = oldHashAt[r[0]] || '';
                const fn = it.floorNowHash ? String(it.floorNowHash) : '';
                // v3.20.0（时钟「时间总是错的」第二重成因）：**条目自己的位置指纹优先于台账代理**。
                //   台账 `processedFloors` 与情节库同为**按角色**存储 —— 里面可能混着别条聊天/旧聊天的标记，
                //   于是 `oldHashAt[floorStart]`（台账代理）只对「本聊天自己产出的条目」成立。
                //   真机取证：198 年罗马线的旧情节被这条代理定位到当前聊天第 11 楼、被**写上**代理指纹
                //   并 `clearGone` 解除「原文已移除」→ **每次删楼都把陈旧情节洗白成「位置有效」**，
                //   时钟随之地被它压住（用户看到的「每次都是错的时间」就是这条复发链）。
                //   现在：条目**自己有指纹**却在本聊天里找不到 = 内容确实不在了 → 直接判「原文已移除」，
                //   不再用台账代理救活；**没有指纹**的历史条目仍走代理（不倒退）。
                const ownMissing = !!fn && nowHashAt[fn] === undefined;
                if (!ownMissing && h && nowHashAt[h] !== undefined) {   // ① 原文仍在 → 按内容哈希定位
                    shiftFloorNow(it, nowHashAt[h] - r[0]);
                    it.floorNowHash = h;
                    clearGone(it);
                    return 0;
                }
                if (fn) {                                             // ②③ 复核「当前位置」还好不好使
                    if (nowHashAt[fn] !== undefined) {
                        const q = nowHashAt[fn], span = Math.max(0, ne0 - ns0);
                        it.floorNowStart = q; it.floorNowEnd = q + span;
                        clearGone(it);
                        return 0;
                    }
                    markOriginGone(it, Date.now());
                    return 1;
                }
                if (hasNow) {                                         // ④ 精确前移写入的位置：在册则补记指纹，否则保守保留
                    const mark = ledgerAt[ns0];
                    if (mark) { it.floorNowHash = mark; clearGone(it); }
                    return 0;
                }
                if (h || r[0] > lastId || r[1] > lastId) { markOriginGone(it, Date.now()); return 1; }   // ⑤
                return 0;
            } catch (e) { return 0; }
        };
        for (const d of DIMENSIONS) {
            const arr = (state[d.kind] || []);
            let n = 0;
            for (const it of arr) n += mapEntry(it);
            if (n) dims[d.kind] = n;
            staleEntries += n;
        }
        // ③ 基线收紧（Q9）
        try { state.lastKnownFloor = lastId; state.floorShrinkAt = Date.now(); } catch (e) { /* 忽略 */ }
        const removedFloors = Math.max(0, (Number.isFinite(known) ? known : lastId) - lastId);
        // ④ 低噪声记账：合并计数 + 调试日志（D12 §8-A：常态操作，不刷屏）
        try {
            if (typeof onFloorShrink === 'function') onFloorShrink({ removedFloors: removedFloors, staleEntries: staleEntries, marks: marks, lastId: lastId });
        } catch (e) { /* 忽略 */ }
        try { log('楼层', { action: '楼层收缩处理', removedFloors: removedFloors, lastId: lastId, staleEntries: staleEntries, marks: marks }); } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }
        return {
            ok: true, removedFloors: removedFloors, staleEntries: staleEntries, dims: dims, marks: marks, lastId: lastId,
            originGone: staleEntries,               // v3.7.0：原文已移除的条数（= staleEntries，语义更准确）
            nowHashes: nowHashes,                   // 当前聊天可用的楼层哈希数（诊断）
        };
    } catch (e) {
        try { warn('楼层收缩处理失败', e); } catch (e2) { /* 忽略 */ }
        return { ok: false, skipped: 'error' };
    }
}
/**
 * v3.5.0（用户要求）：「增加识别楼层突变，常见的主要就是当前楼层与最新情节对应楼层不一致且存在跨度达到 9 层以上，
 *   说明楼层出现大幅手动删减。需修正已处理记录，避免无法正常分析楼层。」
 */
export const FLOOR_JUMP_MIN_GAP = 9;

/** 最新情节对应的楼层（可见情节里最大的 `floorEnd`；无情节 → -1） */
export function latestPlotFloor() {
    try {
        const list = (() => { try { return activeAtoms(); } catch (e) { return Array.isArray(state.atoms) ? state.atoms : []; } })();
        let max = -1;
        for (const a of list) {
            const e = Number(a && a.floorEnd), s2 = Number(a && a.floorStart);
            const v = (Number.isFinite(e) && e > 0) ? e : ((Number.isFinite(s2) && s2 > 0) ? s2 : -1);
            if (v > max) max = v;
        }
        return max;
    } catch (e) { return -1; }
}

/**
 * **楼层突变识别与修正**（自动修复的一个步骤；只改编号与台账，**绝不删除任何条目**）。
 *
 * 判据（用户口径）：`最新情节对应楼层 - 当前末楼 ≥ FLOOR_JUMP_MIN_GAP(9)` → 判为「大幅手动删减」。
 * 动作：复用 `handleFloorShrink({ force: true })` —— 按**内容哈希**把「仍然存在的楼层」保回已处理台账（避免成片重分析），
 *   把超出当前末楼的区间降级为未知区间（`floorStale`），并收紧 `lastKnownFloor`（此后新楼照常可分析）。
 * 纪律：**幂等**；同一对 `(plotFloor, lastFloor)` 已处理过且本次无新改动时只报告不再写盘（避免每次自动修复都刷笔记）；
 *   聊天未就绪时如实跳过（`skipped:'chat-not-ready'`）。
 * @param {{force?:boolean}} [opts]
 * @returns {{jumped:boolean, gap:number, lastFloor:number, plotFloor:number, acted:boolean, skipped?:string,
 *            marks?:number, staleEntries?:number, removedFloors?:number}}
 */
export function fixFloorJump(opts) {
    const o = opts || {};
    const out = { jumped: false, gap: 0, lastFloor: -1, plotFloor: -1, acted: false };
    try {
        const lastFloor = liveLastFloorId();
        const plotFloor = latestPlotFloor();
        out.lastFloor = lastFloor;
        out.plotFloor = plotFloor;
        if (lastFloor < 0 || plotFloor < 0) { out.skipped = 'no-data'; return out; }
        const gap = plotFloor - lastFloor;
        out.gap = gap;
        if (gap < FLOOR_JUMP_MIN_GAP) { out.skipped = 'no-jump'; return out; }
        out.jumped = true;
        // 同一对 (plotFloor,lastFloor) 已处理过 → 只在**确实还有新改动**时再写盘（幂等 + 低噪声）
        const seen = (() => { try { return state.floorJumpAt || null; } catch (e) { return null; } })();
        const same = !!(seen && Number(seen.plotFloor) === plotFloor && Number(seen.lastFloor) === lastFloor);
        const r = handleFloorShrink({ force: true });
        if (!r || r.ok === false) { out.skipped = String((r && r.skipped) || 'error'); return out; }
        out.marks = Number(r.marks) || 0;
        out.staleEntries = Number(r.staleEntries) || 0;
        out.removedFloors = Number(r.removedFloors) || 0;
        out.lastId = Number(r.lastId);
        if (same && !o.force) { out.skipped = 'already-fixed'; out.acted = false; return out; }
        out.acted = true;
        try { state.floorJumpAt = { at: Date.now(), gap: gap, plotFloor: plotFloor, lastFloor: lastFloor, marks: out.marks, staleEntries: out.staleEntries }; } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }
        try { log('楼层', { action: '楼层突变识别与修正', gap: gap, lastFloor: lastFloor, plotFloor: plotFloor, marks: out.marks, staleEntries: out.staleEntries, removedFloors: out.removedFloors }); } catch (e) { /* 忽略 */ }
        return out;
    } catch (e) {
        out.skipped = 'error';
        return out;
    }
}

/** 收缩回调（宿主注入；用于登记人工确认项 —— 内核不直接依赖 UI/冲突模块） */
let onFloorShrink = null;
export function setFloorShrinkHook(fn) { onFloorShrink = (typeof fn === 'function') ? fn : null; return true; }

/**
 * 未摘要楼层扫描（清单 + 跳过计数，供界面/诊断/命令共用；执行侧与列表**同源**，V1 v1.174 纪律）。
 * 跳过项：非 AI 楼（含用户楼）/ 隐藏楼 / 无可分析正文（占位楼、投喂白黑名单过滤）/ 台账已处理 /
 *   已有记忆数据（`covered`）。
 * @param {object} [opts] startFloor / endFloor / limit / maintain=false 关闭台账维护 / ignoreCovered=true 关闭覆盖跳过
 * @returns {{floors:number[], startFloor:number, endFloor:number, lastId:number, lastIdStale:boolean, covered:number, skipped:object}}
 */
export function scanPendingFloors(opts) {
    const o = opts || {};
    const ctx = getCtx();
    const total = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
    const lastId = Number(getLastMessageId());
    // end = **实时聊天末尾**（= V1 宿主 `getLastMessageId()` 的活值，它也是 `chat.length - 1`）。
    //   注意：V2 内核里的 `getLastMessageId()` 是**聊天同步时的快照**（`host/chat.js` 在载入/事件时刷新），
    //   新楼刚 push 进来、宿主尚未同步时它会偏小；据此砍掉区间会漏掉新楼 → 自动提取永远追不上新楼。
    //   故这里只把它当**诊断**信息（`lastId` / `lastIdStale`），区间一律按实时聊天长度取。
    const tail = total - 1;
    const end = Number.isFinite(Number(o.endFloor)) ? Number(o.endFloor) : tail;
    const lastIdStale = Number.isFinite(lastId) && lastId >= 0 && lastId !== tail;
    const startFloor = Math.max(0, Number(o.startFloor) || 0);
    const skipped = { user: 0, hidden: 0, missing: 0, noText: 0, processed: 0, covered: 0, chatNotReady: 0, stateNotReady: 0 };
    let changedFromDropped = 0;      // v3.11.1：因「正文改写 + 标记已丢」重新入队的楼层数（诊断）
    const out = [];
    try {
        // v2.87.0：聊天未就绪（插件刚启动 / 更新后尚未同步）→ **不做任何台账维护**，并如实标记，避免误判大批楼层。
        const ready = chatReadyForFloors();
        if (!ready.ready) {
            skipped.chatNotReady = 1;
            return { floors: [], startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: 0, coverItems: 0, coverIgnored: 0, coverMaxFloor: end, skipped: skipped, chatReady: false, chatReason: ready.reason };
        }
        if (o.maintain !== false) {
            // v3.24.1（真机根因）：**内核状态尚未注入 → 整块台账维护一律跳过**。
            //   刷新后 `init()` 在 `loadMemoryState()`（内部才 `setKernelState`）**之前**就会取一次面板状态快照
            //   （`panelStatusSnapshot()` → `pendingFloors()` → 这里），此时 `state === null`：
            //   旧实现会依次进入四个维护函数并在读 `state.processedFloors` 时抛 TypeError，
            //   各函数的 catch 里 `warn(...)` → 用户看到两条「…失败 Cannot read properties of null」的异常提示
            //   （且此刻 `dbgLog` 尚未接线 → 调试日志里查不到，只看到弹窗）。
            //   注意：这里**只是延后**维护，不是取消 —— 状态注入后下一次扫描会照常补齐（幂等）。
            if (!kernelStateReady()) {
                skipped.stateNotReady = 1;
            } else {
                // v2.93.0（`docs/D12`）：**先处理楼层骤减**（用户会主动删楼减体积）—— 幂等，无收缩即短路返回
                try { handleFloorShrink(); } catch (e) { /* 忽略 */ }
                try { migrateProcessedFloorsV170(); } catch (e) { /* 忽略 */ }
                try { processedDriftGuard(false); } catch (e) { /* 忽略 */ }
                const now = Date.now();
                if (now - lastReconcileTs > RECONCILE_MS) {
                    lastReconcileTs = now;
                    try { reconcileProcessedFloors(false); } catch (e) { /* 忽略 */ }
                    // v3.26.4：同一节流窗口里跑两条**自愈**（幂等、只读优先、聊天就绪才动作）：
                    //   ① 留痕回填（内容仍在 → 恢复为已处理）；② 「原文已移除」常态化复核。
                    //   顺序：先对账（按内容归位）→ 再回填/复核，避免用过期留痕覆盖刚归位的结果。
                    try { healLedgerFromDropped(); } catch (e) { /* 忽略 */ }
                    try { recheckOriginGone(); } catch (e) { /* 忽略 */ }
                }
            }
        }
        // 状态未注入时按空容器判覆盖（`floorCoverage` 只读、零副作用；此处避免把 null 传下去）
        const cov = floorCoverage(kernelStateReady() ? state : {}, { maxFloor: end });   // v3.10.3：越界区间不计入覆盖（见 core/floor-cover.js）
        const skipCovered = (o.ignoreCovered !== true);
        // v3.0.20：用户显式「清除已处理楼层记录」→ 该楼号及之前不再按「已有记忆数据」跳过（见 clearProcessedFloors）
        const coverResetUpTo = (() => {
            try {
                const c = state.coverReset;
                const n = Number(c && c.upTo);
                return Number.isFinite(n) ? n : -1;
            } catch (e) { return -1; }
        })();
        for (let i = startFloor; i <= end; i++) {
            const m = floorMessage(i);
            if (!m) { skipped.missing++; continue; }
            if (m.is_hidden) { skipped.hidden++; continue; }
            if (m.is_user) { skipped.user++; continue; }
            if (!floorAnalyzableText(i)) { skipped.noText++; continue; }
            // 台账优先（V1 语义）：① 在册且哈希一致 → 已处理，跳过；
            //   ② **在册但哈希不符 = 该楼正文被改写过** → 必须重新分析（此时「已有记忆数据」不构成跳过理由，
            //      否则编辑过的楼层会被旧数据永久压住）；③ 不在册（台账缺失/迁移丢失/导入未带）才用覆盖判据兜底。
            const mark = processedMarkOf(i);
            if (mark && isFloorProcessed(i)) { skipped.processed++; continue; }
            // v3.11.1：**正文被改写且标记已丢**（丢弃留痕里旧哈希 ≠ 当前哈希）→ 同样视为内容已变，
            //   覆盖兜底不得跳过（否则「分析过 → 正文改写 → 标记被对账丢弃」的楼会被永久隐藏）。
            const droppedChanged = !mark && droppedContentChanged(i);
            const contentChanged = !!mark || droppedChanged;
            if (droppedChanged) changedFromDropped += 1;
            // v2.64.0：该楼已有记忆数据 → 无需分析；v3.0.20：显式清空过的区间除外（用户要求「重新看到全部待分析楼层」）
            if (!contentChanged && skipCovered && i > coverResetUpTo && cov.has(i)) { skipped.covered++; continue; }
            out.push(i);
        }
        return { floors: out, startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: cov.floors, coverItems: cov.items, coverIgnored: cov.ignored, coverMaxFloor: end, changedFromDropped: changedFromDropped, droppedMarks: droppedMarksCount(), skipped: skipped };
    } catch (e) { /* 忽略 */ }
    return { floors: out, startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: 0, coverItems: 0, coverIgnored: 0, coverMaxFloor: end, changedFromDropped: changedFromDropped, droppedMarks: droppedMarksCount(), skipped: skipped };
}

/**
 * v3.24.1：「丢弃留痕」条数（**空状态安全**）。
 *   此前 `scanPendingFloors` 的两条 return 直接写 `state.processedDropped.length` —— 该表达式**不在**
 *   函数内部 try/catch 的保护范围内，状态未注入时会直接在返回语句上抛
 *   `Cannot read properties of null (reading 'processedDropped')`（与本批修的是同一类错序缺陷）。
 */
function droppedMarksCount() {
    try { return kernelStateReady() && Array.isArray(state.processedDropped) ? state.processedDropped.length : 0; } catch (e) { return 0; }
}

/**
 * 当前聊天末尾楼号（实时；无聊天 → -1）。
 * v3.10.3：把「已有记忆数据覆盖」的判定限制在**本聊天范围内** —— 覆盖集、界面统计、单楼诊断
 *   三处必须用**同一个**上限，否则诊断与管线会给出不同答案（真机 A3 的症状就是由此放大）。
 * @returns {number}
 */
export function liveFloorTail() {
    try {
        const ctx = getCtx();
        const n = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
        return n > 0 ? n - 1 : -1;
    } catch (e) { return -1; }
}

/**
 * 未分析楼层清单（`scanPendingFloors().floors` 的薄封装；`opts.limit` 保留 V1 语义）。
 * @returns {number[]}
 */
export function listUnprocessedFloors(opts) {
    const o = opts || {};
    const scan = scanPendingFloors(o);
    if (Number(o.limit) > 0) return scan.floors.slice(0, Number(o.limit));
    return scan.floors;
}

/**
 * 清除「已处理楼层」台账（V1 `clearFloors`）：清空数组 + 复位 `lastKnownFloor` + 落盘。
 * 只清「哪些楼层已分析」的记账，**不删除任何记忆条目**（V1 同口径）。
 */
export function clearProcessedFloors() {
    try {
        // v3.24.1：状态未注入 → 不清（清空是**写**操作，绝不能建在空状态上）
        if (!kernelStateReady()) return { ok: false, reason: 'state-not-ready', cleared: 0 };
        const before = (state.processedFloors || []).length;
        state.processedFloors = [];
        state.lastKnownFloor = -1;
        state.processedVer = processedVerTag();
        /**
         * v3.0.20（用户要求）：「清除已处理楼层记录」必须**真的能把已分析统计归零**，
         *   并让总览**重新列出第 0 层之后的所有待分析楼层**。
         *
         * 关键：台账清空后，逐楼跳过还有第二条判据 ——「该楼已有记忆数据」（`core/floor-cover.js`，v2.64.0 按用户要求新增）。
         *   分析过的楼层本来就有情节数据 → 台账清空后它们**仍然**被这条判据跳过，于是总览看上去「清了没变化」
         *   （用户报告的就是这个）。V1 的 `clearFloors` 只有台账判据，故清空即全部重现 —— 这里补回该语义：
         *   记下**清空时的末楼号**，该楼号及之前的楼层不再按「已有记忆数据」跳过；再往后的新楼层按常规判据。
         *   重新分析后台账会重新记上这些楼层 → 它们照常从清单里消失（不会一直堆着）。
         */
        const upTo = (() => { try { return Number(liveLastFloorId()); } catch (e) { return -1; } })();
        state.coverReset = { at: Date.now(), upTo: Number.isFinite(upTo) ? upTo : -1 };
        saveState();
        return { ok: true, cleared: before, coverUpTo: state.coverReset.upTo };
    } catch (e) { return { ok: false, cleared: 0 }; }
}

/**
 * v3.0.16（用户报告「使用内置删除楼层后，无法衔接继续分析，新增正文无法分析」）——**活值**末楼号。
 *
 * 背景：内核的 `getLastMessageId()` 是**聊天同步时的快照**（`host/chat.js#wireKernelChatHooks` 在
 * 「载入 / 生成结束 / 消息渲染 / 切聊天」时刷新）。内置删楼走官方 `deleteMessage()`（只发 `MESSAGE_DELETED`，
 * 我们未订阅该事件）→ 删完那一刻快照**仍是被删前的旧值**（例如聊天只剩 10 楼而快照还是 199）。
 * 凡是用快照算**区间**的地方（最典型：`runAutoSummary` 的 `effLast`）就会扫到已不存在的楼层 →
 * 全是 `missing` → 「本次没有可分析楼层」→ 用户看到的就是「删楼后新正文无法分析」。
 *
 * 本函数按宿主**活值**取末楼号（优先级：宿主 `getContext().getLastMessageId()` → `chat.length - 1`
 * → 内核快照兜底），供所有「算区间」的宿主侧调用点使用；内核快照仍用于诊断与 V1 对齐。
 * @returns {number} 末楼号（无聊天 → -1）
 */
export function liveLastFloorId() {
    try {
        const ctx = getCtx();
        const fc = (ctx && typeof ctx.getLastMessageId === 'function') ? Number(ctx.getLastMessageId()) : NaN;
        if (Number.isFinite(fc) && fc >= 0) return Math.floor(fc);
        const total = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
        if (total > 0) return total - 1;
    } catch (e) { /* 落回内核快照 */ }
    try { const snap = Number(getLastMessageId()); return Number.isFinite(snap) ? snap : -1; } catch (e) { return -1; }
}

/** 台账统计（诊断用） */
export function processedStats() {
    try {
        return {
            ver: state.processedVer || '', tag: processedVerTag(), marks: (state.processedFloors || []).length,
            lastKnownFloor: Number(state.lastKnownFloor) || -1,
            // v3.11.1：拆楼检测基线（含最近见到的聊天末楼）与「丢弃留痕」条数 —— 覆盖判据的可诊断依据
            lastChatFloor: Number(state.lastChatFloor) || -1,
            shrinkBaseline: shrinkBaseline(),
            droppedMarks: (Array.isArray(state.processedDropped) ? state.processedDropped.length : 0),
            // v3.0.20：「清除已处理楼层记录」时记下的覆盖失效末楼号（-1 = 未清空过 / 已恢复常规判据）
            coverResetUpTo: (() => { try { const n = Number(state.coverReset && state.coverReset.upTo); return Number.isFinite(n) ? n : -1; } catch (e) { return -1; } })(),
        };
    } catch (e) { return { ver: '', tag: processedVerTag(), marks: 0, lastKnownFloor: -1, lastChatFloor: -1, shrinkBaseline: -1, droppedMarks: 0, coverResetUpTo: -1 }; }
}
