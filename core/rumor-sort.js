// ============================================================
// core/rumor-sort.js —— **传言的列表排序**（v3.50.18，用户要求）
//
// 用户原话：「传言按照发酵度排序，发酵最高的排在前面；如果发酵度相同，则按照发生日期排列，最近发生的靠前。」
//
// 口径（纯函数、不改入参、稳定）：
//   ① 主键：**发酵度 `ferment` 降序**（0–100；缺省/非法按归一化口径取 20，与 `normalizeRumor` 一致）；
//   ② 次键：发酵度**相同**时按**发生日期**（`date`，缺省退回 `floorEnd`）**降序** —— 最近发生的靠前；
//      日期比较直接复用既有 `core/clock.js#sortRecentByStoryDate`（同一套「剧情日期 → 无日期靠后 → floorEnd 倒序」口径），
//      避免在本模块里再写一遍日期解析（两处口径分叉是历史事故来源）。
//
// 实现要点：**两次稳定排序** —— 先按日期排（得到「最近在前」的基准序），再按发酵度稳定排序
//   （同发酵度的相对次序 = 基准序 = 日期倒序），于是「发酵度优先、同度看日期」一次到位；
//   `Array.prototype.sort` 在现代引擎是**稳定**的（Node ≥ 11 / 各 WebView 一致），本仓已依赖该性质。
// ============================================================
import { sortRecentByStoryDate } from './clock.js';

/** 发酵度归一（缺省/非法 → 20；夹 0–100 并取整；与 `core/model/rumor.js#normalizeRumor` 同口径） */
export function rumorFermentOf(e) {
    const raw = e && (e.ferment != null ? e.ferment : e['发酵度']);
    const n = Number(raw);
    return Math.max(0, Math.min(100, Number.isFinite(n) ? Math.round(n) : 20));
}

/**
 * **传言列表排序**：发酵度降序 → 同度按发生日期降序（最近在前）。
 * @param {Array} list 传言数组（不改入参）
 * @returns {Array} 新数组
 */
export function sortRumorsByFerment(list) {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length <= 1) return arr.slice();
    let base;
    try { base = sortRecentByStoryDate(arr); } catch (e) { base = arr.slice(); }   // 兜底：日期口径异常也不炸
    return base.slice().sort((a, b) => rumorFermentOf(b) - rumorFermentOf(a));
}

/**
 * 排序键（诊断/测试用：把一条传言折算成可比较的两段键）
 * @param {object} e
 * @returns {{ferment:number, dateKey:string}} `dateKey` 升序 = 越新越大（取反即降序）
 */
export function rumorSortKey(e) {
    const one = sortRecentByStoryDate([e]);
    void one;
    return { ferment: rumorFermentOf(e) };
}
