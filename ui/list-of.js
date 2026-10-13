// ============================================================
// ui/list-of.js —— **列表可见范围筛选（纯函数）**（v3.46.7，`docs/D22` §4.4 W15 `应-1`）
//
// 从 `ui/panel.js#listOf` 原样抽出（**行为逐字不变**）：只做「按状态筛 → 按额外条件筛 → 按剧情日期排序 →
//   按关键词匹配 → 截断」，把「截断前还剩多少条」一并返回 —— 渐进展示（`docs/D9` §10 U1）需要这个总数
//   才能给出「匹配 N 条 · 已显示 M 条」与「显示更多」的剩余量。
//
// 为什么抽出（`docs/05-开发指南.md` §5 **C11** + 体量棘轮 `scripts/check-file-size.js`）：
//   `ui/panel.js` 已贴着「基线 + 40 行」的上限；这次的新功能必须落在新模块，面板只留接线。
//
// 依赖全部**注入**（`deps`）：本模块不 import 任何上层，纯函数、可单测、可复用。
// ============================================================
import { atomIsHidden } from '../core/merge.js';
import { isShellEntry } from '../core/shell-guard.js';
import { listPagerInfo, pageLimitOf } from './list-pager.js';

/**
 * 按可见范围筛选 + 排序 + 匹配。
 *
 * @param {Array} arr 该维度的运行时数组（已由调用方按 UI kind → 数据容器键映射取好）
 * @param {string} statusWant 只要这个 status 的条目（空串 / undefined = 都要）
 * @param {string} extra 额外条件（`all` / `shell` / `stale`；未知值等同 `all`）
 * @param {string} needle 搜索关键词（空串 = 全部匹配）
 * @param {{isHidden?:(x:any)=>boolean, isShell?:(x:any)=>boolean, isStale?:(x:any)=>boolean, sort?:(a:Array)=>Array, match?:(x:any,needle:string)=>boolean}} deps 注入的判定函数
 * @returns {{matched:Array, total:number}} `total` = 截断前的匹配条数（调用方据此分页）
 */
export function listMatch(arr, statusWant, extra, needle, deps) {
    const d = deps || {};
    let base = Array.isArray(arr) ? arr : [];
    if (typeof d.isHidden === 'function') { try { base = base.filter((x) => !d.isHidden(x)); } catch (e) { /* 忽略 */ } }
    if (statusWant) base = base.filter((x) => String((x && x.status) || 'open') === statusWant);
    // v3.44.0（`docs/D22` W4）：**筛选视图**（额外条件）—— 只收窄**可见范围**，绝不删数据。
    //   放在排序 / 文本匹配之前：先按语义筛，再排序与关键词匹配（与状态筛选同一位置）。
    try {
        if (extra === 'shell' && typeof d.isShell === 'function') base = base.filter((x) => d.isShell(x));
        else if (extra === 'stale' && typeof d.isStale === 'function') base = base.filter((x) => d.isStale(x));
    } catch (e) { /* 筛选失败不改变默认视图 */ }
    try {
        base = (typeof d.sort === 'function') ? d.sort(base) : base.slice().reverse();
    } catch (e) { base = base.slice().reverse(); }
    const matched = (typeof d.match === 'function') ? base.filter((x) => d.match(x, String(needle == null ? '' : needle))) : base;
    return { matched: matched, total: matched.length };
}

/**
 * `ui/panel.js#listOf` / `#listOfInfo` 的**实现体**（从面板原样抽出，行为逐字不变）。
 *
 * @param {*} deps 面板注入：`{ arr:(kind)=>Array, statusOf:(kind)=>string, extraOf:(kind)=>string, hidden:(kind)=>?Function, sort, match }`
 * @returns {{list:Array, total:number, pager:Object}} `total` = 截断前的匹配条数；`pager` = 渐进展示读数
 */
export function listOfInfoWith(deps, kind, q, limit) {
    const d = deps || {};
    const m = listMatch(
        (typeof d.arr === 'function') ? d.arr(kind) : [],
        (typeof d.statusOf === 'function') ? d.statusOf(kind) : '',
        (typeof d.extraOf === 'function') ? d.extraOf(kind) : 'all',
        q,
        { isHidden: (typeof d.hidden === 'function') ? d.hidden(kind) : null, isShell: d.isShell, isStale: d.isStale, sort: d.sort, match: d.match }
    );
    // 未给 limit → 用**渐进展示的当前上限**（首屏 50 / 展开后按屏追加），保证两处口径只此一份
    const cap = Number(limit) > 0 ? Number(limit) : pageLimitOf(kind);
    const list = m.matched.slice(0, cap);
    return { list: list, total: m.total, pager: listPagerInfo(kind, list.length, m.total) };
}
