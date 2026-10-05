// ============================================================
// core/chat-scope.js —— **情节的「聊天归属」口径**（v3.20.0）//
// 背景（真机取证，用户报告「最新的情节已经变化，但还是识别为错误的时间」）：
//   本插件的记忆容器是**按角色**存的（`scope: char:xxxx`）——同一个角色的**每一条聊天**共用
//   同一份 `state.atoms`。于是「情节」里混着**别条聊天**的故事线：
//   真机数据里 `书籍` 这条聊天只有 24 楼（628 年长安线），而 `atoms` 里同时躺着
//   198 年罗马线、327/438 年昆仑山线的旧情节，楼层号一路排到 508。
//   时钟的「最新情节」是**按楼层/位置排序**取第一条 → 那些陈旧情节（楼层号更大、
//   或删楼后被账本代理定位到本聊天的楼层上）会**长期压住**本聊天真正的最新情节，
//   用户看到的就是「情节明明更新了，时间还是错的」，且**每次删楼都复发一次**。
//
// 修法（本模块只提供判据，纯函数、无宿主/无 DOM）：
//   ① **聊天归属分级 `chatTier()`**：条目自带 `chatKey` 且等于当前聊天 → 第一档；
//      没有 `chatKey`（升级前的历史数据，保守视为「可能就是本聊天」）→ 第二档；
//      有 `chatKey` 但属于**别条聊天** → 第三档（排到最后，等价于降级）。
//   ② **位置越界降级 `plotOverflow()`**：条目的「当前位置」超过当前聊天末楼 →
//      这个楼层在**本聊天里根本不存在**，不可能是「剧情当下」→ 与「原文已移除」同档降级。
//      （真机取证：修复日志「最新情节在第 508 楼、当前只有第 13 楼」正是这一条失控。）
//   两条都只**降级、不排除** —— 与 v3.16.1「原文已移除降级」同一纪律：全部条目都被降级时
//   仍能取到值，保持向后兼容（宁可给旧值，也不给「无值」）。
// ============================================================

// ============================================================
import { state } from './model/runtime.js';

/** `chatKey` 归一：去空白、限长（防止把整条聊天元数据塞进来）；非字符串 → `''` */
export function normalizeChatKey(raw) {
    try {
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        return s.slice(0, 80);
    } catch (e) { return ''; }
}

/**
 * 相关度档位（**越小越优先**）：
 *   · `0` = 本聊天（自带 `chatKey` 且与当前一致）
 *   · `1` = 归属未知（升级前的历史数据；没有 `chatKey` 字段）
 *   · `2` = 别条聊天（自带 `chatKey` 且与当前不同）
 * 当前聊天标识未知（空）时**一律为 0** —— 判不出来就不改行为（不倒退）。
 * @param {object} entry
 * @param {string} currentKey 当前聊天标识
 * @returns {number}
 */
export function chatTier(entry, currentKey) {
    const cur = normalizeChatKey(currentKey);
    if (!cur) return 0;
    const k = normalizeChatKey(entry && entry.chatKey);
    if (!k) return 1;
    return k === cur ? 0 : 2;
}

/**
 * 条目的**当前位置**（`floorNow*` 优先，缺失才回落到来源楼层）——与
 * `core/recall.js#trustedPlotList` / `core/floor-cover.js#meaningfulFloorRange` 同口径。
 * @param {object} entry
 * @returns {number}
 */
export function plotPositionOf(entry) {
    try {
        const e = entry || {};
        const ns = Number.isInteger(e.floorNowStart) ? e.floorNowStart : (Number(e.floorStart) || 0);
        const ne = Number.isInteger(e.floorNowEnd) ? e.floorNowEnd : (Number(e.floorEnd) || 0);
        return Math.max(ns, ne);
    } catch (e) { return 0; }
}

/**
 * 位置越界：条目的当前位置**超出当前聊天末楼**（那个楼层在本聊天里不存在）。
 *   末楼未知（`< 0` / 非整数）→ 一律不判越界（判不出来就不改行为）。
 * @param {object} entry
 * @param {number} chatTail 当前聊天末楼（`state.lastChatFloor` / 现场末楼）
 * @returns {boolean}
 */
export function plotOverflow(entry, chatTail) {
    try {
        const tail = Number(chatTail);
        if (!Number.isInteger(tail) || tail < 0) return false;
        const pos = plotPositionOf(entry);
        return pos > tail;
    } catch (e) { return false; }
}

/**
 * 「剧情当下可信度」降级档：`0` = 活情节（含位置在册），`1` = 已降级
 *   （原文已移除 / 位置越界）。与 v3.16.1 的 `originGone` 降级合并成同一档，
 *   保持排序判据只有一层，便于现有单测与调试追踪文案延续。
 * @param {object} entry
 * @param {number} chatTail
 * @returns {number}
 */
export function plotDemoted(entry, chatTail) {
    try {
        if (entry && entry.originGone === true) return 1;
        return plotOverflow(entry, chatTail) ? 1 : 0;
    } catch (e) { return 0; }
}

/** 当前聊天的标识（宿主注入；未注入 → `''` = 判不出来，排序不改行为） */
export function currentChatKey() {
    try { return normalizeChatKey(state && state.chatKey); } catch (e) { return ''; }
}

/**
 * 当前聊天的**末楼**（排序用「位置越界」判据的基准）：取状态里记的
 *   `lastChatFloor` / `lastKnownFloor` 较大值（`host/floors.js` 每次楼层巡检 / 删楼处理都会刷新，
 *   其中 `lastKnownFloor` 是「聊天至少曾有这么长」的高水位）。
 *
 * 为什么**刻意不用现场末楼**（内核注入的 `getLastMessageId()`）：
 *   · 它是「本轮看到的聊天长度」，在宿主尚未载入完、或调用方给的是合成数据时可能**比情节楼层小**；
 *     此时按「现场」判越界会把**有效情节误降级**（时钟反而退回旧值）——诊断/测试与真机都会踩；
 *   · 真机要防的场景（删楼后旧情节仍占着已不存在的楼层）在**下一次楼层巡检**后 `lastChatFloor`
 *     就已收紧，足够及时；且这条判据只是**兜底**，主判据是「聊天归属」（`chatTier`）。
 *   · 全都未知 → `-1`（`plotOverflow` 直接放行，不臆断）。
 * @returns {number}
 */
export function currentChatTail() {
    try {
        const a = Number(state && state.lastChatFloor);
        const b = Number(state && state.lastKnownFloor);
        const cand = [a, b].filter((x) => Number.isInteger(x) && x >= 0);
        return cand.length ? Math.max.apply(null, cand) : -1;
    } catch (e) { return -1; }
}

/**
 * 情节的**归属/位置体检快照**（只读；供调试桥 `ftt.plotScope` 与调试日志）。
 * 只统计条数与楼层，**不含任何正文**（隐私口径与其它诊断一致）。
 * @param {Array<object>} [list] 默认 `state.atoms`
 * @returns {object}
 */
export function plotScopeSnapshot(list) {
    try {
        const arr = Array.isArray(list) ? list : ((state && Array.isArray(state.atoms)) ? state.atoms : []);
        const key = currentChatKey();
        const tail = currentChatTail();
        const out = { chatKey: key ? key.slice(0, 12) + '…' : '', tail: tail, total: arr.length, current: 0, legacy: 0, other: 0, overflow: 0, originGone: 0, newest: [] };
        const cur = [];
        for (const a of arr) {
            if (!a) continue;
            const t = chatTier(a, key);
            if (t === 0) out.current++; else if (t === 1) out.legacy++; else out.other++;
            if (plotOverflow(a, tail)) out.overflow++;
            if (a.originGone === true) out.originGone++;
            if (t === 0) cur.push(a);
        }
        const pos = (a) => plotPositionOf(a);
        out.newest = cur.slice().sort((x, y) => pos(y) - pos(x)).slice(0, 5).map((a) => ({
            floor: pos(a), date: String(a.date || ''), time: String(a.time || ''),
            gone: a.originGone === true, hidden: a.hidden === true,
        }));
        return out;
    } catch (e) { return { error: String((e && e.message) || e) }; }
}
