// ============================================================
// core/floor-cover.js —— 「该楼是否已有记忆数据」的覆盖判定（v2.64.0，内核纯函数）
//
// 触发（用户报告）：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，请核对跳过机制。
//   当**原子数据对应的楼层存在时，则不需要分析**。」
//
// 现状缺陷：未摘要清单只信 `state.processedFloors` 台账。台账在导入/迁移/跨端合并后可能缺失或只覆盖一部分，
//   此时**明明已经有情节等记忆数据落在该楼**，仍会被列成「未摘要」→ 点下去重复分析、计数虚高。
//
// 判据（确定性、只读、零 AI）：任一记忆维度条目带**有效楼层区间**且 `floorStart ≤ i ≤ floorEnd`
//   → 第 i 楼已有数据 → 不再列为未摘要。
//   有效区间 = 整数、`0 ≤ floorStart ≤ floorEnd`、且**不是 `0/0`** —— `0/0` 是「区间未知」的默认值
//   （手工新增、按时间对齐的条目都会是 0/0），据此跳过会误吞第 0 楼，故只认「有跨度或明确落到某楼」的区间。
//
// 与 V1 的关系：V1 `pendingFloorList` 只有台账判据（无本规则），本文件是**按用户要求新增**的 V2 补充；
//   台账仍是主判据，两者取并集（见 `host/floors.js#scanPendingFloors`）。
// ============================================================
import { DIMENSIONS } from './constants.js';
import { state as kernelState } from './model/runtime.js';

/**
 * 条目的有效楼层区间。
 * @param {object} it 记忆条目
 * @returns {[number, number]|null} `[floorStart, floorEnd]`，无效/未知 → null
 */
export function meaningfulFloorRange(it) {
    try {
        if (!it || typeof it !== 'object') return null;
        const fs = Number(it.floorStart), fe = Number(it.floorEnd);
        if (!Number.isInteger(fs) || !Number.isInteger(fe)) return null;
        if (fs < 0 || fe < fs) return null;
        if (fs === 0 && fe === 0) return null;      // 0/0 = 区间未知（不据此跳过）
        return [fs, fe];
    } catch (e) { return null; }
}

/**
 * 全部记忆维度的有效楼层区间（已合并重叠/相邻区间）。
 * @param {object} [st] 状态容器（缺省用内核 state）
 * @returns {{ranges:Array<[number,number]>, items:number}} items = 贡献区间的条目数
 */
export function floorRanges(st) {
    const s = st || kernelState;
    const spans = [];
    let items = 0;
    try {
        for (const d of DIMENSIONS) {
            const arr = (s && Array.isArray(s[d.kind])) ? s[d.kind] : [];
            for (const it of arr) {
                const r = meaningfulFloorRange(it);
                if (!r) continue;
                spans.push(r);
                items += 1;
            }
        }
    } catch (e) { /* 读取失败 → 视为无覆盖 */ }
    spans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const ranges = [];
    for (const r of spans) {
        const last = ranges[ranges.length - 1];
        if (last && r[0] <= last[1] + 1) { if (r[1] > last[1]) last[1] = r[1]; continue; }
        ranges.push([r[0], r[1]]);
    }
    return { ranges: ranges, items: items };
}

/**
 * 楼层覆盖集（供「未摘要楼层」跳过与界面统计共用）。
 * @param {object} [st] 状态容器（缺省用内核 state）
 * @returns {{ranges:Array<[number,number]>, floors:number, items:number, has:(i:number)=>boolean}}
 */
export function floorCoverage(st) {
    const { ranges, items } = floorRanges(st);
    let floors = 0;
    for (const r of ranges) floors += (r[1] - r[0] + 1);
    return {
        ranges: ranges,
        floors: floors,
        items: items,
        has(i) {
            const n = Number(i);
            if (!Number.isInteger(n) || n < 0) return false;
            let lo = 0, hi = ranges.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const r = ranges[mid];
                if (n < r[0]) hi = mid - 1;
                else if (n > r[1]) lo = mid + 1;
                else return true;
            }
            return false;
        },
    };
}
