// ============================================================
// core/reserved-fields.js —— **保留字段的越界约束**（v3.44.0，`docs/D22` **W4** `数-14`）
//
// 设计依据：`docs/D20` §3.4 / §8 `数-14` ——
//   事实（真机实测）：「越界保留字段：`weaveLastFloor = 199` / `parallelFloor = 199` 而实际仅 14 层；
//   `storyDay = 53143`」；
//   步骤：① `weaveLastFloor` / `parallelFloor` 按 `chatKey` **清零或分区**；② `floorStart` 加上界校验；
//   ③ `storyDay` 加上界与来源标记；验收：「体检『越界字段』归零或可解释；注入与排序不受影响」。
//
// 本轮采用的处置（**逐条写明，含与设计稿字面不同之处**）：
//   · ①「按 `chatKey` 清零**或**分区」→ 取**清零 + 可见留痕**。为什么不按 chatKey 分区：这两个基线是
//     **顶层状态字段**（不是条目），它们**没有自己的归属记录** —— 存档里根本没有「这个 199 是哪条聊天写的」
//     这条信息，分区等于**新造一个容器**（属 `docs/D15` §3 类别① 数据契约，须 `DATA_VERSION` 递增 + 双端兼容），
//     超出本批「无前置」的范围。而**清零**是可判定的：基线大于「本存档观察到的最大楼层 + 余量」时，
//     它在**本存档里永远不可能再被达到** → 功能上已是死值（只影响「距离下次推演还差几层」的读数）。
//   · ② `floorStart` 上界：**写入路径**拒绝越界（`core/ingest.js` 已知本批楼层区间，那里才有可信上界）；
//     存量只由**体检**报告 —— 存量楼层的可信上界无法从数据本身确定（存档可能跨多条聊天），
//     擅自改写来源楼层会破坏「来源可追溯」，风险高于收益。
//   · ③ `storyDay`：**加上界**（写入口 `core/clock-extract.js` 收敛到 `STORY_DAY_MAX`）+
//     **来源标记** `storyDaySrc`（`'ai'` = 来自正文标题、`'manual'` = 人工/其它）—— 让「这个巨大的天数
//     从哪来」可查，而不是只能看到一个大数。
//
// 本模块是**纯函数叶子**（只 import 自身常量），供 `core/data-health.js`（报告）、
//   `core/migrate.js`（载入期清越界基线）与 `core/ingest.js`（写入期上界）共用。
// ============================================================

/** 楼层基线的允许余量：基线最多可以比「观察到的最大楼层」高这么多层（跨端对账期间的正常超前） */
export const FLOOR_BASELINE_SLACK = 50;

/** `storyDay`（剧情第几天）的上界：`D20` 实测到 53143（≈145 年）属越界；取 20000 天（≈54 年）为硬上界 */
export const STORY_DAY_MAX = 20000;

/** `storyDay` 的来源标记字段名（写入侧与体检侧共用） */
export const STORY_DAY_SRC_FIELD = 'storyDaySrc';

/** 受上界约束的**顶层楼层基线**字段（`weaveLastFloor` / `parallelFloor`；值域 ≥ -1，-1 = 未知） */
export const FLOOR_BASELINE_FIELDS = Object.freeze(['weaveLastFloor', 'parallelFloor']);

/** `storyDay` 可能出现的维度（体检扫描面；`core/clock-extract.js` 只写情节，其余维度为兼容旧数据保留） */
const STORY_DAY_DIMS = ['atoms', 'memories', 'snapshots', 'items', 'concepts', 'scenes', 'plans', 'suspense', 'parallels', 'rumors'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const intOf = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);

/** 读条目的 `storyDay`（非有限值 → 0） */
export function storyDayOf(it) {
    try {
        const n = intOf(isObj(it) ? it.storyDay : NaN);
        return (Number.isFinite(n) && n > 0) ? n : 0;
    } catch (e) { return 0; }
}

/**
 * **台账**能证明的最大楼层 —— 只取「本聊天已分析到哪」的直接记录：
 *   `lastKnownFloor` / `lastChatFloor` / `processedFloors` / `processedDropped`。
 *
 * 为什么**不**把条目上的 `floorStart` 也算进来：条目的来源楼层**可能来自另一条聊天**
 *   （跨聊天污染是既知现象，见 `core/chat-scope.js` 头注）—— 拿它当「本聊天长度」的证据，
 *   会让一个越界的条目楼层**掩盖**一个同样越界的基线（两者都是 199 时互相「作证」，
 *   于是谁都判不出来）。基线判定必须用**独立于条目**的证据。
 * @returns {number} 无任何台账证据时返回 -1
 */
export function ledgerMaxFloor(s) {
    try {
        if (!isObj(s)) return -1;
        let max = -1;
        const bump = (v) => { const n = intOf(v); if (Number.isFinite(n) && n > max) max = n; };
        bump(s.lastKnownFloor);
        bump(s.lastChatFloor);
        if (Array.isArray(s.processedFloors)) for (const x of s.processedFloors) bump(isObj(x) ? x.f : x);
        if (Array.isArray(s.processedDropped)) for (const x of s.processedDropped) bump(isObj(x) ? x.f : x);
        return max;
    } catch (e) { return -1; }
}

/**
 * 本存档「观察到的最大楼层」—— 台账证据 **+ 条目上的来源楼层**。
 *   用途：**诊断 / 测试**里回答「这份存档里出现过最大的楼层号是多少」；
 *   **不用于**基线越界判定（那用 `ledgerMaxFloor`，理由见上）。
 */
export function observedMaxFloor(s) {
    try {
        if (!isObj(s)) return -1;
        let max = ledgerMaxFloor(s);
        const bump = (v) => { const n = intOf(v); if (Number.isFinite(n) && n > max) max = n; };
        for (const dim of ['atoms', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'rumors']) {
            const arr = s[dim];
            if (!Array.isArray(arr)) continue;
            for (const it of arr) { if (!isObj(it)) continue; bump(it.floorStart); bump(it.floorEnd); }
        }
        return max;
    } catch (e) { return -1; }
}

/**
 * 顶层楼层基线是否越界（只读判定）—— 上界取 `ledgerMaxFloor`（**不含条目楼层**，见其注释）。
 * @returns {Array<{field:string, value:number, max:number}>} 越界的字段（空数组 = 全部正常）
 */
export function outOfRangeBaselines(s) {
    const out = [];
    try {
        if (!isObj(s)) return out;
        const obs = ledgerMaxFloor(s);
        const limit = obs + FLOOR_BASELINE_SLACK;
        for (const f of FLOOR_BASELINE_FIELDS) {
            const n = intOf(s[f]);
            if (!Number.isFinite(n) || n < 0) continue;
            if (n > limit) out.push({ field: f, value: n, max: limit });
        }
        return out;
    } catch (e) { return out; }
}

/**
 * **载入期清零越界基线**（就地；幂等）。`weaveLastFloor` / `parallelFloor` 越界 → `-1`（未知）。
 * 只清「在本存档里永远达不到」的值；不动任何条目、不动台账。
 * @returns {{changed:boolean, cleared:Array<{field:string, value:number, max:number}>}}
 */
export function clampReservedBaselines(s) {
    const out = { changed: false, cleared: [] };
    try {
        const bad = outOfRangeBaselines(s);
        if (!bad.length) return out;
        for (const b of bad) { s[b.field] = -1; out.cleared.push(b); }
        out.changed = true;
        return out;
    } catch (e) { return out; }
}

/**
 * 保留字段越界清单（体检用；只读）。
 * @returns {Array<{code:string, field:string, value:any, limit:any, dim?:string, id?:string, detail:string}>}
 */
export function reservedRangeIssues(st) {
    const out = [];
    try {
        const s = st || {};
        for (const b of outOfRangeBaselines(s)) {
            out.push({
                code: 'field-out-of-range', field: b.field, value: b.value, limit: b.max,
                detail: '楼层基线 ' + b.value + ' 超过本存档观察到的最大楼层 + 余量（' + b.max + '）→ 在本存档里永远达不到（载入期已清零）',
            });
        }
        for (const dim of STORY_DAY_DIMS) {
            const arr = s[dim];
            if (!Array.isArray(arr)) continue;
            for (const it of arr) {
                if (!isObj(it)) continue;
                const sd = intOf(it.storyDay);
                if (Number.isFinite(sd) && sd > STORY_DAY_MAX) {
                    out.push({
                        code: 'field-out-of-range', field: 'storyDay', value: sd, limit: STORY_DAY_MAX, dim: dim, id: String(it.id || ''),
                        detail: '剧情天数 ' + sd + ' 超过上界 ' + STORY_DAY_MAX + '（≈' + Math.round(STORY_DAY_MAX / 365) + ' 年）；来源标记 ' + String(it[STORY_DAY_SRC_FIELD] || '（无）'),
                    });
                }
            }
        }
        return out;
    } catch (e) { return out; }
}

/**
 * **写入期**的楼层上界校验（`数-14` ②）。
 * 可信上界 = `max(本批楼层区间, lastKnownFloor, lastChatFloor) + FLOOR_BASELINE_SLACK` ——
 *   只有在**写入现场**才存在这个可信上界（那时我们知道本批在分析哪几楼）。
 *
 * **为什么不自动改写越界的 `floorStart`**：它极可能来自**另一条聊天**（跨聊天污染是既知现象，
 *   见 `core/chat-scope.js` 头注）—— 自动夹取会把「真实来源」改写成本聊天的楼层，
 *   而**来源可追溯正是 `D12` / `D16` 一系列修复的基础**。故此处只**如实报告并留痕**，
 *   由体检列出、由用户按「来源可追溯」自行判断。
 * @param {{start?:number, end?:number}} fb 本批楼层区间
 * @param {Array<{dim:string, id:string, floorStart:any, floorEnd:any}>} entries 本批归一化结果
 * @param {{lastKnownFloor?:number, lastChatFloor?:number}} [baselines] 存档里的可信基线（由调用方给出，本模块不读全局）
 * @returns {{limit:number, bad:Array<{dim:string,id:string,field:string,value:number,limit:number}>}}
 */
export function checkFloorRange(fb, entries, baselines) {
    const out = { limit: -1, bad: [] };
    try {
        const f = isObj(fb) ? fb : {};
        const b = isObj(baselines) ? baselines : {};
        const cand = [intOf(f.end), intOf(f.start), intOf(b.lastKnownFloor), intOf(b.lastChatFloor)].filter((n) => Number.isFinite(n));
        if (!cand.length) return out;                                  // 没有任何可信楼层 → 无法判定（不报假警）
        const trusted = Math.max.apply(null, cand) + FLOOR_BASELINE_SLACK;
        out.limit = trusted;
        for (const e of (Array.isArray(entries) ? entries : [])) {
            if (!isObj(e)) continue;
            for (const field of ['floorStart', 'floorEnd']) {
                const n = intOf(e[field]);
                if (Number.isFinite(n) && n > trusted) out.bad.push({ dim: String(e.dim || ''), id: String(e.id || ''), field: field, value: n, limit: trusted });
            }
        }
        return out;
    } catch (e) { return out; }
}

/**
 * `storyDay` 上界夹取（**写入口**用）：超界 → 0（= 不记录）并返回 `{value, clamped}`。
 * 为什么不夹到上界：一个 53143 天的值不是「略大」，而是**解析错了** —— 夹到上界等于把错误数据
 * 伪装成合理数据（与「不编数据」的纪律相反）；记 0 表示「本次没有可用的天数」。
 */
export function clampStoryDay(v) {
    const n = intOf(v);
    if (!Number.isFinite(n) || n <= 0) return { value: 0, clamped: false };
    if (n > STORY_DAY_MAX) return { value: 0, clamped: true };
    return { value: n, clamped: false };
}
