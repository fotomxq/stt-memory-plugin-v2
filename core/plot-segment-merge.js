// ============================================================
// core/plot-segment-merge.js —— **分段总结的条数上限 + 按剧情时间合并**（v3.50.12，`docs/D22` §4.5 W4 `数-9`）
//
// 缺陷（`docs/D20` §8 `数-9`，Q2 裁决「设上限 + 合并 + 裁剪可见」）：`state.plotSegments`（分段总结）与
//   `state.summaries`（遗留摘要容器）**没有上限** —— 归档只会增长，落盘体积与派生视图成本随之膨胀。
//
// 口径（逐条对应验收）：
//   · **上限**：`PLOT_SEGMENT_MAX`（默认 240 段）/ `LEGACY_SUMMARY_MAX`（默认 120 条，遗留容器只裁不并）；
//   · **合并而不是删除**：超限时把**最早的相邻两段**合并成一段（剧情时间连续、`atomIds` 并集、
//     `atomCount` 求和、`lines` 按「标签：正文」去重后拼接并限量），循环直到 ≤ 上限 —— **不丢归档、不删任何 id**；
//   · **可追溯**：合并结果带 `merged / mergedFrom / mergedCount`，原始段 id 全在 `mergedFrom` 里；
//   · **幂等**：未超限时**原样返回**（引用不变），重复调用结果稳定；
//   · **确定性**：只按剧情时间（`start`/`end`，缺失时退回 `createdAt`/`floorStart`）排序，无随机。
//
// 纯内核：不碰宿主 / DOM / 定时器（`scripts/check-core-purity.js`）。
// ============================================================

/** 分段总结条数上限（默认 240 段；`cfg` 无对应键 → 不在设定页暴露，属内部排版口径） */
export const PLOT_SEGMENT_MAX = 240;
/** 遗留摘要容器（`state.summaries`，已被 plotSegments 取代）条数上限：只裁不并 */
export const LEGACY_SUMMARY_MAX = 120;
/** 合并后单段保留的剧情线上限（超出截断并在段上标 `truncated`） */
export const PLOT_SEGMENT_LINE_MAX = 40;
/** `mergedFrom` 保留的链长上限（防链条本身膨胀） */
export const MERGED_FROM_MAX = 8;

const str = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 情节在剧情时间上的排序键（`start` 优先；无日期退回楼层 / 创建时间） */
function timeKey(seg) {
    const s = str(seg && seg.start);
    if (s) return s;
    const f = num(seg && seg.floorStart);
    if (f) return '9'.repeat(12) + String(f).padStart(12, '0');   // 无日期段排在有日期段之后（保守：不抢先合并）
    return '9'.repeat(12) + '999999999999';
}

/** 两段合并（较早 + 较晚）—— 只并**相邻**的两段，保证归档时间连续 */
export function mergeTwoPlotSegments(a, b, now) {
    const x = a || {}, y = b || {};
    const earlier = timeKey(x) <= timeKey(y) ? x : y;
    const later = earlier === x ? y : x;
    const start = str(earlier.start) || str(later.start);
    const end = str(later.end) || str(earlier.end);
    const header = (start || end) ? (start || '?') + (end && end !== start ? ' ~ ' + end : '') : '未标注时间范围';
    // 剧情线：按「标签：正文」去重后拼接（最多 PLOT_SEGMENT_LINE_MAX 条）
    const seen = {};
    const lines = [];
    const pushLines = (src) => {
        (Array.isArray(src && src.lines) ? src.lines : []).forEach((ln) => {
            const label = str(ln && ln.label) || '剧情线';
            const text = str(ln && ln.text);
            if (!text) return;
            const k = label + '：' + text;
            if (seen[k]) return;
            seen[k] = 1;
            lines.push({ label: label, text: text });
        });
    };
    pushLines(earlier);
    pushLines(later);
    const over = Math.max(0, lines.length - PLOT_SEGMENT_LINE_MAX);
    const keptLines = lines.slice(0, PLOT_SEGMENT_LINE_MAX);
    const ids = [];
    const addIds = (src) => (Array.isArray(src && src.atomIds) ? src.atomIds : []).forEach((id) => { const s = String(id); if (s && ids.indexOf(s) < 0) ids.push(s); });
    addIds(earlier); addIds(later);
    const from = [];
    const addFrom = (src) => {
        const list = Array.isArray(src && src.mergedFrom) ? src.mergedFrom : [];
        if (list.length) list.forEach((id) => { const s = String(id); if (s && from.indexOf(s) < 0) from.push(s); });
        else { const s = String((src && src.id) || ''); if (s && from.indexOf(s) < 0) from.push(s); }
    };
    addFrom(earlier); addFrom(later);
    const floorStart = (num(earlier.floorStart) && num(later.floorStart)) ? Math.min(num(earlier.floorStart), num(later.floorStart)) : (num(earlier.floorStart) || num(later.floorStart));
    const floorEnd = Math.max(num(earlier.floorEnd), num(later.floorEnd));
    return {
        id: 'segm_' + Math.abs(hashLike(String(earlier.id || '') + '|' + String(later.id || '') + '|' + String(num(now)))).toString(36),
        header: header,
        start: start, end: end,
        lines: keptLines,
        raw: '### ' + header + '\n' + keptLines.map((ln, i) => (i + 1) + '. ' + ln.label + '：' + ln.text).join('\n'),
        atomIds: ids,
        atomCount: num(earlier.atomCount) + num(later.atomCount),
        floorStart: floorStart, floorEnd: floorEnd,
        manual: (earlier.manual === true) && (later.manual === true),
        merged: true,
        mergedCount: num(earlier.mergedCount) + num(later.mergedCount) + 1,
        mergedFrom: from.slice(0, MERGED_FROM_MAX),
        truncated: over > 0 || earlier.truncated === true || later.truncated === true,
        droppedLines: num(earlier.droppedLines) + num(later.droppedLines) + over,
        uses: num(earlier.uses) + num(later.uses),
        createdAt: Math.min(num(earlier.createdAt) || num(later.createdAt) || 0, num(later.createdAt) || num(earlier.createdAt) || 0),
        updatedAt: num(now) || Date.now(),
    };
}

/** 轻量哈希（FNV-1a 变体；只为给合并段一个确定性 id，不做安全用途） */
function hashLike(s) {
    let h = 0x811c9dc5;
    const t = String(s == null ? '' : s);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
}

/**
 * 把分段总结裁到上限（**合并**而非删除）。
 * @param {Array} list 现有分段总结
 * @param {number} [cap] 上限（默认 `PLOT_SEGMENT_MAX`；≤0 视为关闭）
 * @param {{now?:number}} [opts]
 * @returns {{list:Array, before:number, after:number, merged:number, droppedLines:number, changed:boolean}}
 */
export function mergePlotSegmentsToCap(list, cap, opts) {
    const src = Array.isArray(list) ? list : [];
    const before = src.length;
    const limit = Number(cap === undefined ? PLOT_SEGMENT_MAX : cap);
    const out = { list: src, before: before, after: before, merged: 0, droppedLines: 0, changed: false };
    if (!Number.isFinite(limit) || limit <= 0 || before <= limit) return out;
    const now = num(opts && opts.now) || 0;
    // 按剧情时间升序 → 反复合并**最早的相邻两段**
    let work = src.slice().sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : timeKey(a) > timeKey(b) ? 1 : 0));
    let merged = 0, dropped = 0;
    while (work.length > limit) {
        const a = work[0], b = work[1];
        const m = mergeTwoPlotSegments(a, b, now);
        merged += 1;
        dropped += num(m.droppedLines);
        work = [m].concat(work.slice(2));
    }
    out.list = work;
    out.after = work.length;
    out.merged = merged;
    out.droppedLines = dropped;
    out.changed = merged > 0;
    return out;
}

/**
 * 遗留摘要容器（`state.summaries`）的上限裁剪：**只裁不并**（该容器已被 `plotSegments` 取代、无写入点，
 *   合并没有收益；保留最新 N 条，裁掉的记在返回值里，供调用方如实报告）。
 * @param {Array} list
 * @param {number} [cap]
 * @returns {{list:Array, before:number, after:number, removed:number, changed:boolean}}
 */
export function trimLegacySummaries(list, cap) {
    const src = Array.isArray(list) ? list : [];
    const limit = Number(cap === undefined ? LEGACY_SUMMARY_MAX : cap);
    const before = src.length;
    if (!Number.isFinite(limit) || limit <= 0 || before <= limit) {
        return { list: src, before: before, after: before, removed: 0, changed: false };
    }
    // 保留「较新」的：按 `updatedAt` / `createdAt` / `at` 降序取前 limit（稳定：同值保持原顺序）
    const idx = src.map((e, i) => i);
    idx.sort((i, j) => {
        const key = (e) => num(e && (e.updatedAt || e.createdAt || e.at));
        const d = key(src[j]) - key(src[i]);
        return d !== 0 ? d : i - j;
    });
    const keep = idx.slice(0, limit).sort((a, b) => a - b).map((i) => src[i]);
    return { list: keep, before: before, after: keep.length, removed: before - keep.length, changed: true };
}
