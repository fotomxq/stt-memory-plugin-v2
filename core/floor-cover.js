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

// ============================================================
// v3.7.0（用户要求）：「原子数据来源记录了楼层，**原始楼层不应该变动**。当楼层发生突变后，
//   如找不到对应楼层哈希值，则**标记原文已移除**处理。同时新的楼层必须**结合新的位置**来记录，
//   修复无法分析、跳过的问题。」
//
// 于是把「来源楼层」与「当前位置」彻底分开：
//   · `floorStart` / `floorEnd`  = **原始来源楼层（provenance）**：条目在哪几楼产生的，**创建后永不改写**；
//   · `floorNowStart` / `floorNowEnd` = **当前对应位置**：删楼 / 楼层突变后按内容哈希匹配算出的新位置，
//     缺省（无该字段）= 与原始相同（新条目天然如此）；
//   · `floorNowHash` = 当前位置那一段的**内容哈希**（v3.7.0 同批）：让「当前位置」也**可复核** ——
//     下次突变时若该哈希在当前聊天里也找不到，说明**当前位置的内容也被移除了** → 同样转「原文已移除」；
//   · `originGone` / `originGoneAt` = **原文已移除**：突变后按哈希**找不到**该楼层原文时打标，
//     条目内容与来源楼层都保留（不再把楼层清零），但**不再覆盖任何楼层**（否则新楼会被误判成「已有数据」而跳过）；
//   · 兼容：历史的 `floorStale: true` 视为「当前位置未知」（不覆盖任何楼层），由下一次突变识别自动升级为新字段。
// ============================================================

/** 楼层溯源字段（归一化/合并时必须**原样保留**；不参与内容哈希） */
export const FLOOR_PROV_FIELDS = Object.freeze(['floorNowStart', 'floorNowEnd', 'floorNowHash', 'originGone', 'originGoneAt']);

/**
 * 归一化后保留楼层溯源字段（各维度 normalizer 会丢弃未知字段 → 这里补回来）。
 * @param {object} raw 原始输入条目
 * @param {object} norm 归一化结果
 * @returns {object} `norm`（原地补齐）
 */
export function preserveFloorProvenance(raw, norm) {
    try {
        if (!raw || !norm || typeof norm !== 'object') return norm;
        const ns = Number(raw.floorNowStart), ne = Number(raw.floorNowEnd);
        if (Number.isInteger(ns) && ns >= 0) norm.floorNowStart = ns;
        if (Number.isInteger(ne) && ne >= ns) norm.floorNowEnd = ne;
        // `floorNowHash` = 当前位置那一段的**内容哈希**（可复核「当前位置还作不作数」——内容没了就能立刻发现）
        if (raw.floorNowHash) norm.floorNowHash = String(raw.floorNowHash);
        if (raw.originGone === true) {
            norm.originGone = true;
            const at = Number(raw.originGoneAt);
            norm.originGoneAt = Number.isFinite(at) && at > 0 ? at : Date.now();
        }
        return norm;
    } catch (e) { return norm; }
}

/** 该条目的**原始来源区间**（只读；不做任何兼容处理） */
export function originFloorRange(it) {
    try {
        if (!it || typeof it !== 'object') return null;
        const fs = Number(it.floorStart), fe = Number(it.floorEnd);
        if (!Number.isInteger(fs) || !Number.isInteger(fe)) return null;
        if (fs < 0 || fe < fs) return null;
        return [fs, fe];
    } catch (e) { return null; }
}

/** 标记「原文已移除」（保留来源楼层与内容） */
export function markOriginGone(it, at) {
    try {
        if (!it || typeof it !== 'object') return false;
        it.originGone = true;
        it.originGoneAt = Number(at) > 0 ? Number(at) : Date.now();
        return true;
    } catch (e) { return false; }
}

/** 写入「当前位置」（相对原始区间整体平移 `shift` 层；起点下限 0） */
export function shiftFloorNow(it, shift) {
    try {
        if (!it || typeof it !== 'object') return false;
        const r = originFloorRange(it);
        if (!r) return false;
        const s = Math.trunc(Number(shift) || 0);
        it.floorNowStart = Math.max(0, r[0] + s);
        it.floorNowEnd = Math.max(it.floorNowStart, r[1] + s);
        return true;
    } catch (e) { return false; }
}

/**
 * 条目的**有效当前位置区间**（覆盖判定用）。
 *   规则：`originGone` → null（原文已移除，不覆盖任何楼层）；有 `floorNow*` → 用它；
 *         历史的 `floorStale: true` → null（当前位置未知）；否则回落 `floorStart/floorEnd`（老数据兼容）。
 * @param {object} it 记忆条目
 * @returns {[number, number]|null}
 */
export function currentFloorRange(it) {
    try {
        if (!it || typeof it !== 'object') return null;
        if (it.originGone === true) return null;
        const ns = Number(it.floorNowStart), ne = Number(it.floorNowEnd);
        // 显式写出「当前位置」时**以它为准**（含 `0/0`：删楼重映射里「跨越删除线、只有原第 M 楼幸存」的条目
        //   恰恰落在新第 0 楼，是**精确位置**而非「未知区间」；若这里回落到来源区间，就会用旧楼号压住新楼）。
        if (Number.isInteger(ns) && Number.isInteger(ne) && ns >= 0 && ne >= ns) return [ns, ne];
        if (it.floorStale === true) return null;
        const fs = Number(it.floorStart), fe = Number(it.floorEnd);
        if (!Number.isInteger(fs) || !Number.isInteger(fe)) return null;
        if (fs < 0 || fe < fs) return null;
        if (fs === 0 && fe === 0) return null;      // 0/0 = 区间未知（不据此跳过）
        return [fs, fe];
    } catch (e) { return null; }
}

/**
 * 条目的有效楼层区间（**当前口径**：v3.7.0 起按 `currentFloorRange` 判定「该楼是否已有数据」）。
 * @param {object} it 记忆条目
 * @returns {[number, number]|null}
 */
export function meaningfulFloorRange(it) {
    return currentFloorRange(it);
}

/**
 * v3.7.0：条目的**楼层展示标签**（界面用；把「来源」与「当前位置」讲清楚，避免用户被旧楼号误导）。
 *   · `原文已移除` → `原文已移除（原 12-14 楼）`（来源楼层保留可查，但已不占用任何楼层）；
 *   · 有当前位置且与来源不同 → `4-6 楼（原 30-32 楼）`；
 *   · 否则沿用来源区间 → `30-32 楼`；无有效区间 → `''`。
 * @param {object} it 记忆条目
 * @returns {string}
 */
export function floorPositionLabel(it) {
    try {
        if (!it || typeof it !== 'object') return '';
        const o = originFloorRange(it);
        const span = (r) => (r ? (r[0] + '-' + r[1] + '楼') : '楼层未知');   // 与 V1 行正文逐字一致（无空格）
        if (it.originGone === true) return '原文已移除（原 ' + span(o) + '）';
        const ns = Number(it.floorNowStart), ne = Number(it.floorNowEnd);
        if (Number.isInteger(ns) && Number.isInteger(ne) && ns >= 0 && ne >= ns) {
            return span([ns, ne]) + (o && (o[0] !== ns || o[1] !== ne) ? ('（原 ' + span(o) + '）') : '');
        }
        const cur = currentFloorRange(it);
        if (!cur) return '';
        return span(cur);
    } catch (e) { return ''; }
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
