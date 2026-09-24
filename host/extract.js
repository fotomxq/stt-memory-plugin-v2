// ============================================================
// host/extract.js —— 提取编排：楼层正文 → AI 摘要提示词 → JSON 增量 → `mergeDelta` 落库 → 落盘
// 事实源：V1 `runSummaryFloor` / `runSummarySeparate`（src/FTT记忆组件-v1.206.js）
//   ① 判据与台账走 host/floors.js（可分析正文 / 已分析楼层 / 记录台账）
//   ② 提示词由 core/prompt.js#buildSummaryPrompt 构造（V1 逐字移植，读 cfg.promptTemplates）
//   ③ AI 调用走 host/generation.js（ST `generateRaw`），提示词为 V1 的 `[{role,content}, …]`
//   ④ 返回值经 core/util.js#extractJsonObject 解析，再交 core/ingest.js#mergeDelta **按 V1 口径落库**
//   ⑤ 成功即 `recordProcessedFloors` + 落盘（内核 `saveState()` 经适配器写到本地缓冲/服务端文件）
// 失败姿态：任何一步失败都只回报原因（不抛出、不 abort、不改 chat）。
// ============================================================
import { DIMENSIONS } from '../core/constants.js';
import { cfg, state, dbgLog, log, warn, getLastMessageId } from '../core/model/runtime.js';
import { buildSummaryPrompt } from '../core/prompt.js';
import { extractJsonObject } from '../core/util.js';
import { mergeDelta } from '../core/ingest.js';
import { rawGenerate, generationAvailability } from './generation.js';
import {
    floorAnalyzableText, hashFloorText, isFloorProcessed, recordProcessedFloors, listUnprocessedFloors, processedStats,
    collectFloorLinesInRange, clearProcessedFloors,
} from './floors.js';
import { applyFeedRegex } from '../core/prompt.js';

const extractState = {
    runs: 0, ok: 0, fail: 0, lastAt: 0, lastFloor: -1, lastReason: '', lastAdded: 0, lastMs: 0, lastDims: [], busy: false,
    // B3：分段批量（V1 runAutoSummary）状态
    segTotal: 0, segDone: 0, segRange: '', activeSeg: null, aborted: 0, lastBatch: null,
};
/** 中断请求标志（协作式中断：段与段之间生效；在途 AI 请求由宿主决定是否可取消） */
let abortRequested = false;
/** 请求中断当前批量分析（V1 abortAnalysis 的 V2 版） */
export function abortExtract() {
    const active = extractState.busy === true;
    abortRequested = true;
    if (!active) abortRequested = false;
    return { ok: true, busy: active };
}
/** 中断标志是否处于请求态（诊断/测试） */
export function abortPending() { return abortRequested === true; }
/** 当前正在分析的楼层区间（面板动效/进度用） */
export function activeSegment() { return extractState.activeSeg ? Object.assign({}, extractState.activeSeg) : null; }
/** 批量进度（面板头部 busy 文案用） */
export function batchProgress() {
    return { segTotal: extractState.segTotal, segDone: extractState.segDone, range: extractState.segRange, activeSeg: activeSegment(), aborted: extractState.aborted };
}

/** 提取统计（/ftt、FTT 调试导出与设置面板共用） */
export function extractStats() { return Object.assign({}, extractState); }
export function extractBusy() { return extractState.busy; }

/** 生效维度（V1 `dimensionEnabled`）：未配置即全部启用 */
export function enabledDims() {
    try {
        const map = cfg.dimensionEnabled || {};
        const on = DIMENSIONS.filter((d) => map[d.kind] !== false).map((d) => d.kind);
        return on.length ? on : DIMENSIONS.map((d) => d.kind);
    } catch (e) { return DIMENSIONS.map((d) => d.kind); }
}

/** 提示词 → ST generateRaw 的入参（V1 是 messages 数组：首条 system，其余并入 prompt） */
export function promptToGenerateArgs(messages) {
    const list = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages == null ? '' : messages) }];
    const sys = list.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n\n');
    const rest = list.filter((m) => m && m.role !== 'system').map((m) => String(m.content || '')).join('\n\n');
    return { systemPrompt: sys, prompt: rest || sys };
}

/**
 * 分析单楼（V1 `runSummaryFloor` 的 V2 版）。
 * @param {number} floorId 楼层号
 * @param {object} [opts] dims（维度子集）/ silent / ai（注入的生成函数，测试用）
 * @returns {Promise<{ok:boolean, reason?:string, added?:number, total?:number, chars?:number, ms?:number, deltaKeys?:string[]}>}
 */
export async function analyzeFloor(floorId, opts) {
    const o = opts || {};
    const t0 = Date.now();
    extractState.runs += 1;
    extractState.lastAt = t0;
    extractState.lastFloor = Number(floorId);
    try {
        const text = floorAnalyzableText(floorId);
        if (!text) { extractState.fail += 1; extractState.lastReason = 'empty-floor'; return { ok: false, reason: 'empty-floor' }; }
        const av = generationAvailability();
        const gen = o.ai || rawGenerate;
        if (!o.ai && !av.generateRaw) { extractState.fail += 1; extractState.lastReason = 'no-generate'; return { ok: false, reason: 'no-generate' }; }
        const dims = (Array.isArray(o.dims) && o.dims.length ? o.dims : enabledDims());
        const messages = await buildSummaryPrompt(text, dims);
        const args = promptToGenerateArgs(messages);
        const resp = await gen(args);
        if (!resp || resp.ok === false) {
            extractState.fail += 1; extractState.lastReason = 'ai-error';
            return { ok: false, reason: 'ai-error', error: (resp && resp.error) || '' };
        }
        const delta = extractJsonObject(resp.text);
        if (!delta) {
            extractState.fail += 1; extractState.lastReason = 'no-json';
            return { ok: false, reason: 'no-json', chars: String(resp.text || '').length };
        }
        const mr = mergeDelta(delta, { start: Number(floorId), end: Number(floorId) });
        if (!mr || !mr.ok) { extractState.fail += 1; extractState.lastReason = 'merge-fail'; return { ok: false, reason: 'merge-fail' }; }
        recordProcessedFloors(Number(floorId), Number(floorId));
        const ms = Date.now() - t0;
        extractState.ok += 1;
        extractState.lastReason = '';
        extractState.lastAdded = mr.added;
        extractState.lastMs = ms;
        extractState.lastDims = Object.keys(delta);
        try { dbgLog('摘要', { action: '单楼分析完成', floor: Number(floorId), added: mr.added, total: mr.total, ms, chars: String(resp.text || '').length, dims: Object.keys(delta).slice(0, 8) }); } catch (e) { /* 忽略 */ }
        return { ok: true, added: mr.added, total: mr.total, chars: String(resp.text || '').length, ms, deltaKeys: Object.keys(delta) };
    } catch (e) {
        extractState.fail += 1;
        extractState.lastReason = String((e && e.message) || e);
        warn('单楼分析失败', e);
        return { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
}

/**
 * 批量分析（默认分析「未分析楼层」；`onlyLatest` 只分析最后一楼）。
 * @param {object} [opts] ids / onlyLatest / limit / dims / ai / silent
 */
export async function analyzeFloors(opts) {
    const o = opts || {};
    if (extractState.busy) return { ok: false, reason: 'busy' };
    extractState.busy = true;
    try {
        let ids = Array.isArray(o.ids) ? o.ids.slice() : null;
        if (!ids) ids = o.onlyLatest ? listUnprocessedFloors({ limit: 1 }).slice(-1) : listUnprocessedFloors({ limit: Number(o.limit) > 0 ? Number(o.limit) : 0 });
        if (!ids.length) return { ok: true, floors: [], results: [], note: '没有未分析楼层' };
        const results = [];
        for (const id of ids) {
            const r = await analyzeFloor(id, o);
            results.push(Object.assign({ floor: id }, r));
        }
        const done = results.filter((r) => r.ok).length;
        return { ok: done > 0, floors: ids, results, done, failed: results.length - done };
    } finally {
        extractState.busy = false;
    }
}

/** 分析**一个楼层段**（V1 `runAutoSummary` 的段分析：一段拼成一次 AI 调用，整段记账） */
export async function analyzeSegment(start, end, opts) {
    const o = opts || {};
    const s0 = Math.max(0, Number(start) || 0);
    const e0 = Math.max(s0, Number(end) || s0);
    const t0 = Date.now();
    extractState.activeSeg = { start: s0, end: e0 };
    try {
        const text = String(applyFeedRegex(collectFloorLinesInRange(s0, e0).join('\n')) || '').trim();
        if (!text) { recordProcessedFloors(s0, e0); return { ok: true, empty: true, added: 0, floorStart: s0, floorEnd: e0 }; }
        const gen = o.ai || rawGenerate;
        if (!o.ai && !generationAvailability().generateRaw) return { ok: false, reason: 'no-generate', floorStart: s0, floorEnd: e0 };
        const dims = (Array.isArray(o.dims) && o.dims.length ? o.dims : enabledDims());
        const messages = await buildSummaryPrompt(text, dims);
        const args = promptToGenerateArgs(messages);
        const resp = await gen(args);
        if (!resp || resp.ok === false) return { ok: false, reason: 'ai-error', error: (resp && resp.error) || '', floorStart: s0, floorEnd: e0 };
        const delta = extractJsonObject(resp.text);
        if (!delta) return { ok: false, reason: 'no-json', chars: String(resp.text || '').length, floorStart: s0, floorEnd: e0 };
        const mr = mergeDelta(delta, { start: s0, end: e0 });
        if (!mr || !mr.ok) return { ok: false, reason: 'merge-fail', floorStart: s0, floorEnd: e0 };
        // V1 口径：**无论合并是否新增**都记该段为已处理（失败/无 JSON 则不记，下次重试）
        recordProcessedFloors(s0, e0);
        const ms = Date.now() - t0;
        return { ok: true, added: mr.added, total: mr.total, chars: text.length, ms, floorStart: s0, floorEnd: e0, deltaKeys: Object.keys(delta) };
    } finally {
        extractState.activeSeg = null;
    }
}

/** 把楼层区间切成段（V1：`cfg.summaryChunkSize`，默认 10 楼/段） */
export function buildSegments(start, end, chunkSize) {
    const s0 = Math.max(0, Number(start) || 0);
    const e0 = Math.max(s0, Number(end) || s0);
    const n = Math.max(1, Number(chunkSize) || Number(cfg.summaryChunkSize) || 10);
    const out = [];
    for (let a = s0; a <= e0; a += n) out.push({ start: a, end: Math.min(e0, a + n - 1) });
    return out;
}

/**
 * 批量分析（V1 `runAutoSummary` 的 V2 版）：分段 → 逐段 AI → 整段落库与记账。
 *   · `silent=false`（手动「⚡ 立即 AI 摘要」）：分析最近 `cfg.feedFloors`/`cfg.summaryFloors` 楼
 *   · `silent=true`（自动补全）：覆盖全部**未摘要** AI 楼，并跳过已处理段
 *   · **协作式中断**：`abortExtract()` 后，段与段之间停止（在途请求完成后不再继续）
 * @returns {Promise<{ok:boolean, made:number, added:number, failed:number, floors:string, segments:number, aborted:number, reason?:string}>}
 */
export async function runAutoSummary(opts) {
    const o = opts || {};
    if (extractState.busy) return { ok: false, reason: 'busy', made: 0, added: 0, failed: 0, floors: '', segments: 0, aborted: 0 };
    extractState.busy = true;
    abortRequested = false;
    extractState.segTotal = 0;
    extractState.segDone = 0;
    extractState.aborted = 0;
    const t0 = Date.now();
    try {
        const lastId = (() => { try { return Number(getLastMessageId()); } catch (e) { return -1; } })();
        if (!Number.isFinite(lastId) || lastId < 0) return { ok: false, reason: 'no-message', made: 0, added: 0, failed: 0, floors: '', segments: 0, aborted: 0 };
        // 跳过最近 2 楼（生成中的半成品楼；V1 `timelySummaryEffLast` 在及时分析下为 0）
        const skip = (cfg && cfg.timelyAnalysis === true) ? 0 : 2;
        const effLast = Math.max(0, lastId - skip);
        const feedN = Math.max(1, Number(cfg.feedFloors) || Number(cfg.summaryFloors) || 10);
        const silent = o.silent === true;
        let start = Math.max(0, effLast - feedN + 1);
        let pendingIds = listUnprocessedFloors({ endFloor: effLast });
        if (silent) {
            if (!pendingIds.length) return { ok: true, made: 0, added: 0, failed: 0, floors: '0-0', segments: 0, aborted: 0, skipped: true };
            start = Math.min.apply(null, pendingIds);
        }
        const segments = buildSegments(start, effLast, o.chunkSize || cfg.summaryChunkSize);
        extractState.segTotal = segments.length;
        extractState.segRange = start + '-' + effLast;
        let made = 0, added = 0, failed = 0, aborted = 0;
        for (const seg of segments) {
            if (abortRequested) { aborted = segments.length - extractState.segDone; extractState.aborted = aborted; break; }
            // 静默模式：整段已完成 → 跳过（V1 同口径）
            if (silent) {
                const segIds = [];
                for (let i = seg.start; i <= seg.end; i++) if (pendingIds.indexOf(i) >= 0) segIds.push(i);
                if (!segIds.length) { extractState.segDone += 1; continue; }
            }
            const r = await analyzeSegment(seg.start, seg.end, o);
            extractState.segDone += 1;
            if (r.ok && !r.empty) { made += 1; added += Number(r.added) || 0; }
            else if (!r.ok) failed += 1;
            extractState.lastAdded = added;
            if (typeof o.onProgress === 'function') { try { o.onProgress({ seg: Object.assign({}, seg), result: r, done: extractState.segDone, total: extractState.segTotal }); } catch (e) { /* 忽略 */ } }
        }
        const out = { ok: made > 0 || (failed === 0 && aborted === 0), made, added, failed, floors: start + '-' + effLast, segments: segments.length, aborted, ms: Date.now() - t0 };
        extractState.lastBatch = out;
        if (made) extractState.ok += 1;
        if (failed) extractState.fail += 1;
        return out;
    } catch (e) {
        extractState.fail += 1;
        extractState.lastReason = String((e && e.message) || e);
        return { ok: false, reason: 'error', error: extractState.lastReason, made: 0, added: 0, failed: 0, floors: '', segments: 0, aborted: 0 };
    } finally {
        extractState.busy = false;
        extractState.activeSeg = null;
        abortRequested = false;
    }
}

/** 清除「已处理楼层」台账（面板动作 `clearFloors`） */
export function clearFloors() { return clearProcessedFloors(); }

/** 自动提取：`GENERATION_ENDED` 后分析最后一楼（受 `cfg.autoExtract` 与忙碌状态保护） */
export async function autoExtractLatest(opts) {
    try {
        if (cfg && cfg.autoExtract === false) return { ok: false, reason: 'off' };
        if (extractState.busy) return { ok: false, reason: 'busy' };
        // 取**最后一个**未分析楼层（V1 自动摘要是「按未分析清单推进」，这里先取全集尾项，避免 limit 先截断取到最旧一楼）
        const ids = listUnprocessedFloors({});
        const id = ids.length ? ids[ids.length - 1] : -1;
        if (id < 0) return { ok: false, reason: 'nothing-pending' };
        if (isFloorProcessed(id)) return { ok: false, reason: 'already' };
        return await analyzeFloors(Object.assign({ ids: [id] }, opts || {}));
    } catch (e) {
        return { ok: false, reason: 'error' };
    }
}

/** 提取状态摘要（诊断面板/命令共用） */
export function extractSummary() {
    const s = extractStats();
    const st = processedStats();
    return Object.assign({}, s, { processed: st, pending: listUnprocessedFloors({}).length, floorHash: (n) => hashFloorText(n) });
}
