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
import { markOriginGone, shiftFloorNow } from './floor-cover.js';   // v3.7.0：来源楼层不动；只打「原文已移除」/ 写当前位置

/** 三档预设（`docs/D12` §8-E：保留最近 6 / 10 / 12 层） */
export const FLOOR_TRIM_PRESETS = Object.freeze([6, 10, 12]);

// ============================================================
// v3.17.0（用户报告「**使用插件内置删除楼层功能后，应用整体进入严重卡顿**」）——**慢速逐层删除的护栏**。
//
// 真机取证（本机 2026-10-05 01:59:58 → 02:05:43，242 层聊天删 230 层）：
//   宿主 `executeSlashCommandsWithOptions` 存在但 `/cut` **不生效**（调用后 `chat` 长度不变）→ 旧代码退回
//   「逐层 `ctx.deleteMessage(id)`」；而宿主的 `deleteMessage` 每层都要走一遍
//   DOM 移除 + `saveChatDebounced()` + `MESSAGE_DELETED`（订阅该事件的所有扩展各自全量刷新）
//   → 实测 **≈1.0–1.5 秒/层**，230 层合计 **5 分 45 秒**，期间整个应用几乎不可用。
//
// 因此（配合宿主层的一次性批量截断）：
//   ① 逐层删除只作**最后手段**，且一次最多 `FLOOR_TRIM_SLOW_MAX` 层 —— 超过即**拒绝执行**并说明原因
//      （绝不再静默地让界面卡住几分钟）；
//   ② 单层耗时按 `FLOOR_TRIM_SLOW_MS_PER_FLOOR` 预估，预检 / 确认框 / 摘要都**如实告知预计卡多久**；
//   ③ 逐层过程中累计超过 `FLOOR_TRIM_SLOW_BUDGET_MS` 即中止（宁可只删一部分并如实回报，
//      也不让界面长时间卡住）。
// ============================================================
/** 逐层删除可接受的层数上限（超过即拒绝；批量截断不可用的宿主才有此顾虑） */
export const FLOOR_TRIM_SLOW_MAX = 3;
/** 逐层删除单层耗时估计（毫秒；真机实测 1.0–1.5 秒/层，取上界用于告知） */
export const FLOOR_TRIM_SLOW_MS_PER_FLOOR = 1500;
/** 逐层删除的硬预算（毫秒）：累计超过即中止本次逐层删除 */
export const FLOOR_TRIM_SLOW_BUDGET_MS = 20000;

/** 逐层删除耗时预估（秒；四舍五入，>0 时至少 1 秒）——预检与摘要共用，用于如实告知卡顿时长 */
export function floorTrimSlowSeconds(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0) return 0;
    return Math.max(1, Math.round(n * FLOOR_TRIM_SLOW_MS_PER_FLOOR / 1000));
}

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
    // v3.7.0（用户要求）：**来源楼层永不变动** → 只打「原文已移除」标记（内容与来源都保留）
    try { markOriginGone(o, Date.now()); } catch (e) { /* 忽略 */ }
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
        // 跨删除线：起点失（当前位置未知 → 记 0），终点按新位置记；**来源楼层不动**
        try {
            o.floorNowStart = 0;
            o.floorNowEnd = Math.max(0, bb - removeCount);
        } catch (e) { return 'skip'; }
        return 'partial';
    }
    // v3.7.0：幸存楼层 → 只更新**当前位置**（`floorNow*`），来源楼层原样保留
    try {
        const nowA = (aKey === 'floorStart') ? 'floorNowStart' : (aKey === 'start' ? 'floorNowStart' : 'floorNowStart');
        const nowB = (bKey === 'floorEnd') ? 'floorNowEnd' : (bKey === 'end' ? 'floorNowEnd' : 'floorNowEnd');
        o[nowA] = Math.max(0, aa - removeCount);
        o[nowB] = Math.max(o[nowA], bb - removeCount);
    } catch (e) { return 'skip'; }
    return 'shift';
}

/**
 * 删后**精确编号重映射**（`docs/D12` §3.2 的「插件发起」加强版：M 已知 → 幸存楼层整体前移 M）。
 * **只改编号，绝不删除条目**；幂等（未知区间重复跑不变）。
 * @param {object} st 内核 state（就地修改）
 * @param {number} removeCount 从**头部**删除的楼层数 M
 * @param {number} [newLastId] 新末楼号（缺省 = 当前 chat 末尾；用于收紧 `lastKnownFloor`）
 * @returns {{ok:boolean, shifted:number, staled:number, partial:number, dims:object, dropped:Array<{f:number,h:string}>}}
 *   `dropped` = 被删段内、因而从台账里移除的标记（**调用方须留痕**，见 v3.26.4）
 */
export function remapAfterTrim(st, removeCount, newLastId) {
    const M = Math.max(0, Math.floor(Number(removeCount) || 0));
    const dims = {};
    let shifted = 0, staled = 0, partial = 0;
    if (!st || typeof st !== 'object' || M <= 0) return { ok: true, shifted: 0, staled: 0, partial: 0, dims: dims, dropped: [] };
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
    // v3.26.4（真机取证「突然冒出来大量未分析的楼层，实际早已分析」）：丢弃的标记**必须留痕** ——
    //   此前静默丢弃，于是「删楼 → 撤销删楼 / 恢复聊天 / 切回更长分支 / 换同角色另一条聊天」之后，
    //   这批楼层既无标记也无留痕（覆盖判据也不认）→ 成片变回「未分析」，且无法自愈。
    //   core 层不做留痕本身（那是状态写入口径，见 `host/floors.js#rememberDroppedMarks`），只如实回报。
    const dropped = [];
    try {
        const pf = Array.isArray(st.processedFloors) ? st.processedFloors : [];
        const next = [];
        for (const x of pf) {
            const f = Number(x && x.f);
            if (!Number.isFinite(f) || f < M) {
                if (Number.isFinite(f) && f >= 0) dropped.push({ f: f, h: String((x && x.h) || '') });
                continue;
            }
            next.push({ f: f - M, h: String((x && x.h) || '') });
        }
        st.processedFloors = next;
    } catch (e) { /* 忽略：台账失败不阻塞编号重映射 */ }
    try {
        const nl = Number(newLastId);
        if (Number.isFinite(nl) && nl >= -1) st.lastKnownFloor = nl;
        st.floorShrinkAt = Date.now();
    } catch (e) { /* 忽略 */ }
    return { ok: true, shifted: shifted, staled: staled, partial: partial, dims: dims, dropped: dropped };
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
    // v3.17.0：逐层删除（最后手段）时如实预告耗时 —— 真机实测 ≈1.5 秒/层，期间界面会卡
    if (Number.isFinite(Number(e.slowCount)) && Number(e.slowCount) > 0) {
        parts.push('其中 ' + Number(e.slowCount) + ' 层需逐层删除（预计约 ' + floorTrimSlowSeconds(e.slowCount) + ' 秒，期间界面会卡顿）');
    }
    return parts.join(' · ');
}
