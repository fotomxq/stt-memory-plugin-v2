// ============================================================
// core/floor-trim.js —— **删楼（保留最近 N 层）的纯内核**（v2.94.0，`docs/D12` v0.2 §4 / §8-E）
//
// 背景（用户裁决）：「用户删除楼层的原因在于**减少聊天体积**（酒馆本身对高楼层支持很差，所以会主动删除）。
//   优化同步机制兼容该考量，同时在**设定-数据管理**中约定楼层删除的三个按钮，确保插件可感知该操作。」
//   → 三档固定为 **保留最近 6 / 10 / 12 层**；删除是**本地动作**，但插件**发起**它 → 删前删后全可知。
//
// 本文件只做**纯计算**（不碰宿主、不落盘、不发事件）：
//   ① `planFloorTrim`  —— 预检：将删除多少层 / 删哪一段 / 哪些条目受影响；
//   ② `remapAfterTrim` —— 删后**精确编号重映射**（因为 M 已知，比哈希考古更强：幸存楼层整体前移 M）；
//   ③ `trimSummaryText` —— 给面板/人工确认项的一句话摘要。
//
// 口径（与 D12 §3.2 一致，但更强）：**只改编号，绝不删除数据**；
//   · 区间完全落在被删段（`floorEnd < M`）→ 降级为「未知区间」`0/0` + `floorStale: true`；
//   · 区间跨越删除线 → `floorStart` 置 0（起点已失），`floorEnd -= M`，并留 `floorStale`；
//   · 区间完全在幸存段（`floorStart >= M`）→ 两端同时 `-= M`（**精确**，不留痕）。
// ============================================================
import { DIMENSIONS } from './constants.js';

/** 三档预设（`docs/D12` §8-E：保留最近 6 / 10 / 12 层） */
export const FLOOR_TRIM_PRESETS = Object.freeze([6, 10, 12]);

/** 条目楼层区间字段名（各维度一律 floorStart/floorEnd；分段总结用 start/end） */
const PAIR_FIELDS = ['floorStart', 'floorEnd'];
const SEG_FIELDS = ['start', 'end'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

/**
 * 单个条目是否「受影响」（其楼层区间与被删段 `[0, M-1]` 有交集）。
 * 未知区间（0/0）与无编号条目**不算**受影响。
 */
function pairTouched(o, aKey, bKey, removeCount) {
    if (!o || typeof o !== 'object') return false;
    const a = num(o[aKey]); const b = num(o[bKey]);
    const aa = Number.isFinite(a) ? a : (Number.isFinite(b) ? b : NaN);
    const bb = Number.isFinite(b) ? b : aa;
    if (!Number.isFinite(aa) || !Number.isFinite(bb)) return false;
    if (aa <= 0 && bb <= 0) return false;            // 已是未知区间
    return aa <= removeCount - 1;                     // 区间起点落在被删段内
}

/** 统计各维度受影响条目数（预检用；只读） */
export function countTrimAffected(st, removeCount) {
    const M = Math.max(0, Math.floor(Number(removeCount) || 0));
    const dims = {};
    let total = 0;
    const scan = (dim, arr, fields) => {
        let n = 0;
        for (const it of (Array.isArray(arr) ? arr : [])) if (pairTouched(it, fields[0], fields[1], M)) n++;
        if (n) { dims[dim] = n; total += n; }
    };
    for (const d of DIMENSIONS) scan(d.kind, (st || {})[d.kind], d.kind === 'plotSegments' ? SEG_FIELDS : PAIR_FIELDS);
    return { dims: dims, total: total };
}

/**
 * 预检计划（**不修改任何数据**）。
 * @param {{chatLen:number, keep:number, state?:object}} input
 * @returns {{ok:boolean, reason?:string, total:number, keep:number, removeCount:number,
 *            removeRange:number[]|null, keepRange:number[]|null, newLastId:number,
 *            affected:{dims:object,total:number}}}
 */
export function planFloorTrim(input) {
    const o = input || {};
    const total = Math.max(0, Math.floor(Number(o.chatLen) || 0));
    const keepWant = Math.floor(Number(o.keep) || 0);
    const keep = Math.max(1, keepWant);
    const empty = { dims: {}, total: 0 };
    const base = { total: total, keep: keep, removeCount: 0, removeRange: null, keepRange: null, newLastId: total - 1, affected: empty };
    if (!Number.isFinite(total) || total <= 0) return Object.assign({ ok: false, reason: 'no-chat' }, base);
    if (keepWant < 1) return Object.assign({ ok: false, reason: 'bad-keep' }, base);
    const removeCount = Math.max(0, total - keep);
    if (removeCount <= 0) return Object.assign({ ok: false, reason: 'nothing-to-delete' }, base);
    const plan = {
        ok: true,
        total: total,
        keep: keep,
        removeCount: removeCount,
        removeRange: [0, removeCount - 1],
        keepRange: [removeCount, total - 1],
        newLastId: total - removeCount - 1,
        affected: countTrimAffected(o.state || {}, removeCount),
    };
    return plan;
}

/** 「未知区间」降级（不改动其它字段） */
function stale(o, aKey, bKey) {
    try { o[aKey] = 0; o[bKey] = 0; o.floorStale = true; } catch (e) { /* 忽略 */ }
}

/** 单条目重映射；返回 'skip' | 'stale' | 'partial' | 'shift' */
function remapPair(o, aKey, bKey, removeCount) {
    if (!o || typeof o !== 'object') return 'skip';
    const a = num(o[aKey]); const b = num(o[bKey]);
    const aa = Number.isFinite(a) ? a : (Number.isFinite(b) ? b : NaN);
    const bb = Number.isFinite(b) ? b : aa;
    if (!Number.isFinite(aa) || !Number.isFinite(bb)) return 'skip';
    if (aa <= 0 && bb <= 0) return 'skip';                 // 已是未知区间 → 幂等
    if (bb < removeCount) { stale(o, aKey, bKey); return 'stale'; }
    if (aa < removeCount) {                                // 跨越删除线：起点已失，终点前移
        try { o[aKey] = 0; o[bKey] = bb - removeCount; o.floorStale = true; } catch (e) { return 'skip'; }
        return 'partial';
    }
    try { o[aKey] = aa - removeCount; o[bKey] = bb - removeCount; } catch (e) { return 'skip'; }
    return 'shift';
}

/**
 * 删后**精确编号重映射**（`docs/D12` §3.2 的「插件发起」加强版：M 已知 → 幸存楼层整体前移 M）。
 * **只改编号，绝不删除条目**；幂等（未知区间重复跑不变）。
 * @param {object} st 内核 state（就地修改）
 * @param {number} removeCount 从**头部**删除的楼层数 M
 * @param {number} [newLastId] 新末楼号（缺省 = 当前 chat 末尾；用于收紧 `lastKnownFloor`）
 * @returns {{ok:boolean, shifted:number, staled:number, partial:number, dims:object}}
 */
export function remapAfterTrim(st, removeCount, newLastId) {
    const M = Math.max(0, Math.floor(Number(removeCount) || 0));
    const dims = {};
    let shifted = 0, staled = 0, partial = 0;
    if (!st || typeof st !== 'object' || M <= 0) return { ok: true, shifted: 0, staled: 0, partial: 0, dims: dims };
    const scan = (dim, arr, fields) => {
        let s = 0, t = 0, p = 0;
        for (const it of (Array.isArray(arr) ? arr : [])) {
            const r = remapPair(it, fields[0], fields[1], M);
            if (r === 'shift') s++; else if (r === 'stale') t++; else if (r === 'partial') p++;
        }
        if (s || t || p) dims[dim] = { shifted: s, staled: t, partial: p };
        shifted += s; staled += t; partial += p;
    };
    for (const d of DIMENSIONS) scan(d.kind, st[d.kind], d.kind === 'plotSegments' ? SEG_FIELDS : PAIR_FIELDS);
    // 台账：被删段内的标记直接丢弃；幸存段的楼层号前移 M（此后 `reconcileProcessedFloors` 仍可按哈希复核）
    try {
        const pf = Array.isArray(st.processedFloors) ? st.processedFloors : [];
        const next = [];
        for (const x of pf) {
            const f = Number(x && x.f);
            if (!Number.isFinite(f) || f < M) continue;
            next.push({ f: f - M, h: String((x && x.h) || '') });
        }
        st.processedFloors = next;
    } catch (e) { /* 忽略：台账失败不阻塞编号重映射 */ }
    try {
        const nl = Number(newLastId);
        if (Number.isFinite(nl) && nl >= -1) st.lastKnownFloor = nl;
        st.floorShrinkAt = Date.now();
    } catch (e) { /* 忽略 */ }
    return { ok: true, shifted: shifted, staled: staled, partial: partial, dims: dims };
}

/** 预检一句话（面板与确认框共用；不含正文，只讲数字与后果） */
export function trimSummaryText(plan, extra) {
    const p = plan || {};
    const e = extra || {};
    if (!p.ok) {
        const why = { 'no-chat': '当前没有可用聊天', 'bad-keep': '保留层数无效', 'nothing-to-delete': '当前楼层数已不超过保留档，无需删除' }[String(p.reason)] || '无法删除';
        return why;
    }
    const parts = [
        '当前 ' + p.total + ' 层',
        '保留最近 ' + p.keep + ' 层',
        '将删除 ' + p.removeCount + ' 层（第 ' + (p.removeRange[0] + 1) + '–' + (p.removeRange[1] + 1) + ' 层）',
        '受影响记忆 ' + (Number(p.affected && p.affected.total) || 0) + ' 条',
    ];
    if (Number.isFinite(Number(e.unextracted)) && Number(e.unextracted) > 0) parts.push('其中 ' + Number(e.unextracted) + ' 层尚未提取');
    if (e.supported === false) parts.push('宿主不支持删除楼层');
    return parts.join(' · ');
}
