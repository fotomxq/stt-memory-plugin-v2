// ============================================================
// core/chunk.js —— **「AI 摘要」的统一分段切片口径**（v3.23.0，内核纯函数、零依赖）
//
// 用户要求（原话）：「全部AI摘要需支持分段处理，且默认采用 **3 个正文**进行切片，分批进行处理。避免一次性分析记忆。」
//
// 背景（为什么要有这个模块）：
//   在此之前，「分段」只是**批量摘要**（`runAutoSummary`）一家的私有实现（`host/extract.js#buildSegments`，
//   默认 **10 楼/段**）；其余 AI 摘要入口各走各的：
//     · 「多楼 / 全量提取」（`analyzeFloors`）—— **一楼一次** AI 调用（没有任何"段"的概念）；
//     · 「推演世界」（`runParallelWeave`）—— **一次请求把整个区间正文**塞进一个提示词。
//   于是同一条「避免一次性分析记忆」的诉求，在三个入口上是三种行为。本模块把它收敛成**一个口径**：
//     **一次 AI 请求最多消费 `SUMMARY_CHUNK_DEFAULT`（3）个楼层正文**，按段依次推进（分批处理）。
//
// 三条口径（全仓库唯一事实源）：
//   ① **默认段长 = 3 个正文**（`SUMMARY_CHUNK_DEFAULT`）—— 可由 `cfg.summaryChunkSize` 覆盖；
//   ② **段内必须连续**：不连续的楼层**绝**拼进同一个提示词（否则会把中间没选中的楼层正文一并喂给 AI，
//      既浪费 token 又让"这段到底分析了哪些楼"说不清）；
//   ③ **段长只做上界**：段内正文数 ≤ 段长（末尾段按剩余量收口）。
//
// 与既有实现的关系：
//   · `cfg.summaryChunkSize`（V1 v1.32 键）语义**不变**，只是默认值由 10 改为 3；
//   · `host/extract.js#buildSegments()` 保留为**薄封装**（V1 黄金/单测仍按它的入参口径调用）；
//   · 修复类（角色/状态/物品/计划/场景/概念/传言/分组）**不**走本口径 —— 它们消费的是"待修复目标 + 上下文正文"，
//     不是"楼层正文切片"（用户本轮明确「修复类保持不动」）。
// ============================================================

/**
 * **每段正文数默认值**：3 个楼层正文 / 段。
 * 用户原话「默认采用 3 个正文进行切片」；`cfg.summaryChunkSize` 未配置（或非法）时按它回落。
 */
export const SUMMARY_CHUNK_DEFAULT = 3;

/** 段长的合法范围（防止用户把 0 / 负数 / 小数 / 字符串写进配置把分段搞坏） */
export const SUMMARY_CHUNK_MIN = 1;
export const SUMMARY_CHUNK_MAX = 200;

/**
 * 归一化段长（"每段正文数"）。
 *   · 合法值 = 有限数且 ≥ 1 → 取整；超出上限 → 夹到上限；
 *   · 非法值（`0` / 负数 / `NaN` / `Infinity` / 空串 / `null` / 非数字）→ 回落到 `fallback`，
 *     `fallback` 也非法时 → `SUMMARY_CHUNK_DEFAULT`（3）。
 * @param {*} v 候选段长（通常 = `cfg.summaryChunkSize`）
 * @param {*} [fallback] 次级回落（通常 = 配置默认值）
 * @returns {number} 合法段长（整数，∈ [1, 200]）
 */
export function normalizeChunkSize(v, fallback) {
    const pick = (x) => {
        const n = Number(x);
        if (!Number.isFinite(n) || n < 1) return NaN;
        return Math.max(SUMMARY_CHUNK_MIN, Math.min(SUMMARY_CHUNK_MAX, Math.trunc(n)));
    };
    const a = pick(v);
    if (!Number.isNaN(a)) return a;
    const b = pick(fallback);
    if (!Number.isNaN(b)) return b;
    return SUMMARY_CHUNK_DEFAULT;
}

/**
 * 把一个**楼层区间**切成段（V1 `buildSegments` 同口径：起点对齐、末段收口）。
 * @param {number} start 起始楼层（负数按 0 处理）
 * @param {number} end 结束楼层（小于起点 → 收口为起点；非有限 → 收口为起点）
 * @param {*} [size] 段长（非法 → `fallback` → 默认 3）
 * @param {*} [fallback] 次级回落（通常 = `cfg.summaryChunkSize`）
 * @returns {Array<{start:number,end:number}>} 依次排列、互不重叠、完整覆盖 `[start, end]`
 */
export function chunkFloorRange(start, end, size, fallback) {
    const n = normalizeChunkSize(size, fallback);
    const s0 = Math.max(0, Math.trunc(Number(start) || 0));
    const raw = Math.trunc(Number(end));
    const e0 = Number.isFinite(raw) ? Math.max(s0, raw) : s0;
    const out = [];
    for (let a = s0; a <= e0; a += n) out.push({ start: a, end: Math.min(e0, a + n - 1) });
    return out;
}

/**
 * 把一份**楼层号清单**切成段：先按"连续"断开，再按段长切片。
 *   · 输出顺序 = 升序（清单先去重、排序，与 `listUnprocessedFloors` 的语义一致）；
 *   · 每个段都带 `ids`（该段实际包含的楼层号），调用方据此记账与回报；
 *   · **不连续处一定断开** —— 例：`[1,2,3,7,8]` + 段长 3 → `[1-3]`、`[7-8]`（绝不出 `1-7`）。
 * @param {number[]} ids 楼层号清单（重复/非法项自动丢弃）
 * @param {*} [size] 段长（非法 → `fallback` → 默认 3）
 * @param {*} [fallback] 次级回落（通常 = `cfg.summaryChunkSize`）
 * @returns {Array<{start:number,end:number,ids:number[]}>}
 */
export function chunkFloorIds(ids, size, fallback) {
    const n = normalizeChunkSize(size, fallback);
    const list = [];
    const seen = Object.create(null);
    for (const raw of (Array.isArray(ids) ? ids : [])) {
        // 只接受「数字」与「数字字符串」（`null` / `''` / 布尔 / 对象 等一律丢弃 —— 否则 `Number(null)` = 0
        //   会把一个不存在的第 0 楼算进分段里）
        if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean' || typeof raw === 'object') continue;
        const v = Math.trunc(Number(raw));
        if (!Number.isFinite(v) || v < 0) continue;
        if (seen[v]) continue;
        seen[v] = true;
        list.push(v);
    }
    list.sort((a, b) => a - b);
    const out = [];
    let cur = null;
    for (const id of list) {
        if (cur && id === cur.end + 1 && cur.ids.length < n) { cur.ids.push(id); cur.end = id; continue; }
        cur = { start: id, end: id, ids: [id] };
        out.push(cur);
    }
    return out;
}

/**
 * 分段摘要的**一页摘要**（诊断 / 调试桥 / 面板文案共用；不含任何正文）。
 * 段数按**实际切片**算（连续段才合并），因此与 `chunkFloorIds(ids).length` 逐字一致。
 * @param {number[]} ids 参与的楼层号清单
 * @param {*} [size] 段长
 * @param {*} [fallback] 次级回落
 * @returns {{chunkSize:number, floors:number, segments:number}}
 */
export function chunkInfo(ids, size, fallback) {
    const chunks = chunkFloorIds(ids, size, fallback);
    const floors = chunks.reduce((a, c) => a + c.ids.length, 0);
    return { chunkSize: normalizeChunkSize(size, fallback), floors: floors, segments: chunks.length };
}
