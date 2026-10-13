// ============================================================
// ui/list-pager.js —— **列表渐进展示（分页步长）的界面状态**（v3.46.7，`docs/D22` §4.4 W15 `应-1`）
//
// 来源（`docs/D9` §10 **U1** 设计原则 / `docs/D19` §8 实施规格 `应-1`）：
//   「列表页默认 **50 条 / 屏**，超出给『显示更多』；**搜索或筛选变更即重置到首屏**，不做跨条件的隐式累积。」
//   「本项是**渐进展示**（一次渲染仍是这些条，只是不一次给完），**不含虚拟滚动 / 真分页** ——
//     后者按 `docs/D13` §7 Q8『暂不做』执行。」
//   —— 故本模块只记「这一维度当前展开到第几条」，不切分数据、不改排序、不改任何条目。
//
// 与 `docs/D13` 的既有上限（外框 300 行）的分工：U1 管**一屏给多少**，D13 管**总量硬上限**；
//   两者正交 —— 展开到 `LIST_PAGE_MAX` 就停（与切页前的截断值一致，行为不倒退）。
//
// 本模块不 import 任何上层（面板只把它的返回值用在渲染与动作分派上）。
// ============================================================

/** 一屏条数（`docs/D9` §10 **U1**：默认 50 条 / 屏） */
export const LIST_PAGE_SIZE = 50;

/** 单次「显示更多」追加的条数（= 一屏） */
export const LIST_PAGE_STEP = 50;

/**
 * 展开上限（外框）。取 `docs/D13` §2 的既有「列表行硬截断 300」口径：
 * U1 只规定**渐进展示的步长**，不撤销渲染成本上限（`docs/D13` §7 Q8「暂不做真分页」）。
 */
export const LIST_PAGE_MAX = 300;

/** 维度 → 已展开条数（缺省 = 未展开 = 首屏 `LIST_PAGE_SIZE`） */
const shown = {};

/** 当前维度应渲染的条数（未展开的维度一律回落到首屏） */
export function pageLimitOf(kind) {
    const n = Number(shown[String(kind || '')]);
    if (!Number.isFinite(n) || n <= 0) return LIST_PAGE_SIZE;
    return Math.min(LIST_PAGE_MAX, Math.max(LIST_PAGE_SIZE, Math.round(n)));
}

/**
 * 「显示更多」：当前维度追加一屏。
 * @returns {number} 追加后的应渲染条数（已到 `LIST_PAGE_MAX` 则原样返回上限）
 */
export function pageShowMore(kind) {
    const k = String(kind || '');
    const next = Math.min(LIST_PAGE_MAX, pageLimitOf(k) + LIST_PAGE_STEP);
    shown[k] = next;
    return next;
}

/**
 * **重置到首屏**（搜索或筛选变更即调用；`docs/D9` §10 U1 的硬性口径）。
 * @returns {number} 重置后的条数（= `LIST_PAGE_SIZE`）
 */
export function pageReset(kind) {
    const k = String(kind || '');
    if (k) delete shown[k];
    return LIST_PAGE_SIZE;
}

/** 清空全部维度的展开态（切页 / 重挂载用） */
export function pageResetAll() {
    Object.keys(shown).forEach((k) => { delete shown[k]; });
    return true;
}

/**
 * 渲染「显示更多」条需要的读数。
 * @param {string} kind 维度
 * @param {number} shownCount 本次实际渲染出来的条数（= `listOf` 返回的长度）
 * @param {number} matchedCount 本维度**匹配总数**（截断前的条数）
 * @returns {{limit:number, shown:number, matched:number, hasMore:boolean, remaining:number, step:number}}
 *   `hasMore` = 「显示更多」按钮是否该出现（还有没给完的，且未到上限）。
 */
export function pageInfoOf(kind, shownCount, matchedCount) {
    const n = Number(shownCount) || 0;
    const m = Number(matchedCount) || 0;
    const limit = pageLimitOf(kind);
    const remaining = Math.max(0, m - n);
    return {
        limit: limit,
        shown: n,
        matched: m,
        hasMore: remaining > 0 && limit < LIST_PAGE_MAX,
        remaining: remaining,
        step: Math.min(LIST_PAGE_STEP, remaining),
    };
}

/** `list-of.js` 侧的别名（同一实现：渲染读数只此一处，避免两处分算） */
export const listPagerInfo = pageInfoOf;

/** 状态快照（测试 / 调试用） */
export function listPagerState() {
    return { size: LIST_PAGE_SIZE, step: LIST_PAGE_STEP, max: LIST_PAGE_MAX, shown: Object.assign({}, shown) };
}
