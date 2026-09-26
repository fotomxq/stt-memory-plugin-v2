// ============================================================
// host/extract.js —— 提取编排：楼层正文 → AI 摘要提示词 → JSON 增量 → `mergeDelta` 落库 → 落盘
// 事实源：V1 `runSummaryFloor` / `runSummarySeparate`（src/FTT记忆组件-v1.206.js）
//   ① 判据与台账走 host/floors.js（可分析正文 / 已分析楼层 / 记录台账）
//   ② 提示词由 core/prompt.js#buildSummaryPrompt 构造（V1 逐字移植，读 cfg.promptTemplates）
//   ③ AI 调用走 host/generation.js（ST `generateRaw`），提示词为 V1 的 `[{role,content}, …]`
//   ④ 返回值经 core/util.js#extractJsonObject 解析，再交 core/ingest.js#mergeDelta **按 V1 口径落库**
//   ⑤ 成功即 `recordProcessedFloors` + 落盘（内核 `saveState()` 经适配器写到本地缓冲/服务端文件）
//   ⑥ **独立分组**（P9d）：`cfg.dimensionGrouping === 'separate'` 时按维度分组分别构造提示词并**并行**请求
//      （V1 `runSummarySeparate` 约 14785~14837；V1 仅在**分段**路径判定，见下方 `analyzeSegment`）
//   ⑦ **被动调度**（P9d）：合并成功后 `scheduleParallelWeave(floorRange, jsExtractKeywords(text))`（V1 15240/15490/14806/14829），
//      单楼分析与批量分析收尾各做一次 `scheduleAtomCompact()`（V1 15242 / 15537，情节总结 4s 防抖检查点）
// 失败姿态：任何一步失败都只回报原因（不抛出、不 abort、不改 chat）；并行分组中单组失败不影响其余组。
// ============================================================
import { DIMENSIONS } from '../core/constants.js';
import { cfg, state, dbgLog, log, warn, getLastMessageId } from '../core/model/runtime.js';
import { buildSummaryPrompt } from '../core/prompt.js';
// v2.61.0（用户要求：「提取记忆优化，第一步先校对时钟等基本信息，然后再去提取」）
import { calibrateBasics, withBasics } from './preflight.js';
import { extractJsonObject } from '../core/util.js';
import { mergeDelta } from '../core/ingest.js';
import { scheduleAutoRepairOnMergeFail, bumpRepairOp } from '../core/repair.js';
import { scheduleParallelWeave, jsExtractKeywords, setParallelLastKeywords, parallelLastKeywords } from '../core/parallel.js';
import { scheduleAtomCompact } from '../core/atom-compact.js';
import { DIM_LABELS } from '../core/config.js';
// v2.35.0（API 三通道）：抽取管线的 AI 调用带上**用途 target**（V1 `overrideMain` / `dimensionPresets[维度]` 的等价物）
import { resolveApiTarget } from '../core/api-channel.js';
import { rawGenerate, generationAvailability } from './generation.js';
import {
    floorAnalyzableText, hashFloorText, isFloorProcessed, recordProcessedFloors, listUnprocessedFloors, processedStats,
    collectFloorLinesInRange, clearProcessedFloors, scanPendingFloors,
} from './floors.js';
import { applyFeedRegex } from '../core/prompt.js';
import { cleanText } from '../core/html-text.js';

const extractState = {
    runs: 0, ok: 0, fail: 0, lastAt: 0, lastFloor: -1, lastReason: '', lastAdded: 0, lastMs: 0, lastDims: [], busy: false,
    busySince: 0,   // v2.63.0：忙位开始时刻（真实任务的起点；面板读秒据此计算）
    // v2.59.0（用户报告：「概览缺少展示最后一次提取记忆内容的组件」）：记录**最后一次提取**的时间/来源/范围/
    //   新增条数/维度/关键词/AI 回复正文（截断），供总览渲染 —— V1 总览用 `lastExtractTime` + `lastExtractKeywords`
    //   只给了时间与关键词，V2 连**提取内容**（AI 回复）一并留存，便于「刚才到底提了什么」一目了然。
    // B3：分段批量（V1 runAutoSummary）状态
    segTotal: 0, segDone: 0, segRange: '', activeSeg: null, aborted: 0, lastBatch: null,
};
/** v2.61.0：最后一次「提取前校对」结果（总览/日志展示） */
let lastPreflight = null;
export function lastPreflightInfo() { try { return lastPreflight ? JSON.parse(JSON.stringify(lastPreflight)) : null; } catch (e) { return null; } }
/** 最后一次提取记录里保留的 AI 回复上限（字符；避免总览带着几十 KB 文本到处跑） */
export const LAST_EXTRACT_TEXT_CAP = 4000;
/** v2.59.0：最后一次提取记录（总览「📤 最后一次提取」组件的数据源） */
let lastExtract = null;
/** 最近一个分段分析得到的 AI 回复（批量记录时带上，供总览展示「提取内容」） */
let lastSegmentText = '';
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
    // v2.63.0（用户报告「管线状态的计时器不动」）：带上**忙位起始时刻** `since` —— 面板据此显示真实读秒，
    //   而不是「面板渲染那一刻」才开始计时（V1 的 `busy.pipe.startedAt` 同口径）。
    return {
        segTotal: extractState.segTotal, segDone: extractState.segDone, range: extractState.segRange,
        activeSeg: activeSegment(), aborted: extractState.aborted, since: Number(extractState.busySince) || 0,
    };
}

/** 提取统计（/ftt、FTT 调试导出与设置面板共用） */
export function extractStats() { return Object.assign({}, extractState); }

/** 最后一次提取的记忆（只读快照；无记录 → null） */
export function lastExtractRecord() {
    try { return lastExtract ? JSON.parse(JSON.stringify(lastExtract)) : null; } catch (e) { return null; }
}
/** 写入最后一次提取记录（内部；同时把关键词登记到推演模块，V1 `lastExtractKeywords` 同源） */
function recordLastExtract(rec) {
    try {
        lastExtract = Object.assign({ at: Date.now() }, rec || {});
        if (Array.isArray(lastExtract.keywords) && lastExtract.keywords.length) { try { setParallelLastKeywords(lastExtract.keywords); } catch (e2) { /* 忽略 */ } }
    } catch (e) { /* 记录失败不影响主流程 */ }
    return lastExtract;
}
export function extractBusy() { return extractState.busy; }

/**
 * 维度开关的「别名键」：V1 存档的 `cfg.dimensionEnabled` 用 **V1 界面键** `states`，
 *   V2 容器键是 `currentStates` —— 两边都要认（用户报告「状态大类总是没数据」的排查中发现该口径不统一）。
 * 优先级：**精确键优先**（显式 `currentStates:true` 可覆盖 V1 遗留的 `states:false`），无精确键时才看别名。
 */
const DIM_KEY_ALIAS = { currentStates: ['states'] };
/** 该维度是否被用户关闭（V1 别名键一并认） */
export function dimDisabledOf(map, kind) {
    const m = map || {};
    if (Object.prototype.hasOwnProperty.call(m, kind)) return m[kind] === false;
    const al = DIM_KEY_ALIAS[kind] || [];
    return al.some((k) => Object.prototype.hasOwnProperty.call(m, k) && m[k] === false);
}

/** 生效维度（V1 `dimensionEnabled`）：未配置即全部启用 */
export function enabledDims() {
    try {
        const map = cfg.dimensionEnabled || {};
        const on = DIMENSIONS.filter((d) => !dimDisabledOf(map, d.kind)).map((d) => d.kind);
        return on.length ? on : DIMENSIONS.map((d) => d.kind);
    } catch (e) { return DIMENSIONS.map((d) => d.kind); }
}

/**
 * v2.68.0（用户报告：「状态大类总是没数据」）——**提示词维度键投影**（本轮真 BUG 的修复点）。
 *   `buildSummaryPrompt()` 的维度说明按 **V1 模板键**（`atoms/states/snapshots/…`，见 `V1_SUMMARY_DIM_KEYS`）取模板
 *   （`if (pt[d]) lines.push(pt[d])`）；而 V2 的容器 kind 是 `currentStates` —— 直接把 kind 传进去时
 *   `pt['currentStates']` 不存在 → **「状态记录」的抽取说明整段不会进提示词**（AI 不知道要抽状态 → 状态大类长期为空）。
 *   此外 V2 容器还含 `parallels`（V1 摘要**不抽**平行事件，由交织管线负责）与 `links/plotSegments/suspense`
 *   （无摘要模板），一并投影掉，保持与 V1 提示词一致。
 * @param {string[]} [dimsOverride] 显式维度子集（可用 V2 kind 或 V1 键）
 * @returns {string[]} V1 摘要维度键（顺序 = V1 `DIMENSIONS`）
 */
export function summaryDimsForPrompt(dimsOverride) {
    try {
        const on = (Array.isArray(dimsOverride) && dimsOverride.length) ? dimsOverride.map(String) : enabledDims();
        const keys = [];
        for (const k of on) {
            const v1 = KIND_TO_SUMMARY_DIM[k] || String(k);
            if (V1_SUMMARY_DIM_KEYS.indexOf(v1) >= 0 && keys.indexOf(v1) < 0) keys.push(v1);
        }
        return keys.length ? V1_SUMMARY_DIM_KEYS.filter((d) => keys.indexOf(d) >= 0) : V1_SUMMARY_DIM_KEYS.slice();
    } catch (e) { return V1_SUMMARY_DIM_KEYS.slice(); }
}

/** 提示词 → ST generateRaw 的入参（V1 是 messages 数组：首条 system，其余并入 prompt） */
export function promptToGenerateArgs(messages) {
    const list = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages == null ? '' : messages) }];
    const sys = list.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n\n');
    const rest = list.filter((m) => m && m.role !== 'system').map((m) => String(m.content || '')).join('\n\n');
    return { systemPrompt: sys, prompt: rest || sys };
}

// ==================== 独立分组（V1 `runSummarySeparate`，v1.206 14785~14837） ====================
/**
 * 摘要维度键（**逐字取自 V1 `DIMENSIONS`**，v1.206 1135）——即 `buildSummaryPrompt` 的维度模板键 + `mergeDelta` 的增量键。
 * 注：V1 此表**不含** `suspense`（悬念与计划共用「计划库与悬念库」模板，随 `plans` 组一起请求/落库）、
 *   **不含** `parallels`（平行事件由交织管线产出，不走摘要抽取）。
 * V2 适配：`core/constants.js#DIMENSIONS` 是 14 个 `{kind,part,label}` 容器（含 `currentStates` / `links` / `plotSegments` 等
 *   V2 扩展容器），故分组前需做 kind → 本表键的投影（见 `KIND_TO_SUMMARY_DIM`）。`core/constants.js` 本批不改。
 */
export const V1_SUMMARY_DIM_KEYS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'];
/** V2 容器键 → 摘要维度键（仅 `currentStates` 是 V1 `states` 的别名；其余同名；`links`/`plotSegments`/`parallels`/`suspense` 不参与分组） */
const KIND_TO_SUMMARY_DIM = { currentStates: 'states' };

/** 是否启用独立分组（V1 `cfg.dimensionGrouping === 'separate'`；默认 `'unified'`） */
export function separateGroupingEnabled() { return !!(cfg && cfg.dimensionGrouping === 'separate'); }

/**
 * 独立分组构造（V1 `runSummarySeparate` 的 14786~14787 口径）：
 *   · `enabled` —— 生效维度**各自一组**（V1 `DIMENSIONS.filter(d => cfg.dimensionEnabled[d])`）；
 *   · `rest` —— 其余维度**合成一个「统一」组**（V1 `DIMENSIONS.filter(d => !cfg.dimensionEnabled[d])`；
 *     ⚠️ V1 原样：这些「未启用」的维度**仍会被请求**，只是并成一次）。
 * V2 适配（与 V1 的差异，已在 docs/P9d 逐条登记）：
 *   ① 「生效维度」取 V2 既有口径 `enabledDims()`（**空表 = 全部启用**）；V1 的迁移器会给每个维度补 `false`（V1 2392），
 *      故 V1 默认配置在独立分组下等价于「单个统一请求」，而 V2 默认空表 = 10 组并行 —— 要复现 V1 默认需显式把维度置 `false`；
 *   ② `o.dims` 显式给出时按 V2 既有「dims 覆盖」约定只用该子集（V1 无此参数）。
 * @param {string[]} [dimsOverride] 显式维度子集（V2 扩展；V1 无）
 * @returns {{enabled:string[], rest:string[]}} 两组均为 V1 `DIMENSIONS` 顺序
 */
export function summaryDimGroups(dimsOverride) {
    const on = (Array.isArray(dimsOverride) && dimsOverride.length) ? dimsOverride.map(String) : enabledDims();
    const keys = [];
    for (const k of on) {
        const v1 = KIND_TO_SUMMARY_DIM[k] || String(k);
        if (V1_SUMMARY_DIM_KEYS.indexOf(v1) >= 0 && keys.indexOf(v1) < 0) keys.push(v1);
    }
    return {
        enabled: V1_SUMMARY_DIM_KEYS.filter((d) => keys.indexOf(d) >= 0),
        rest: V1_SUMMARY_DIM_KEYS.filter((d) => keys.indexOf(d) < 0),
    };
}

/** 逐组增量切片（V1 原样：`plans` 组一并带 `suspense`；无任何该组键 → 调用方判「无该维度数据」） */
function groupDeltaSlice(dims, delta) {
    const sub = {};
    for (const d of dims) {
        if (d === 'plans') { sub.plans = delta.plans; sub.suspense = delta.suspense; }
        else sub[d] = delta[d];
    }
    return sub;
}

/**
 * 单组执行（V1 `runSummarySeparate` 内层 task）：构造该组提示词 → AI → 解析 → 取该组切片 → `mergeDelta` →
 * 合并成功即 `scheduleParallelWeave(floorRange, jsExtractKeywords(floorText))`（V1 14806 / 14829）。
 * 失败语义（V1 原样）：本组失败只回报本组（`{dim, ok:false, error}`），**不抛出、不影响其它组**。
 * V1 原样保留：成功时返回的 `ok` 是 `mergeDelta` 的**返回对象**（`{ok:true,added,total}`，真值），失败时是 `false`
 *   —— 调用方按真值判定（`results.filter(r => r.ok)`）。
 * @returns {Promise<{dim:string, ok:object|boolean, error?:string}>}
 */
async function runSeparateGroup(groupDim, dims, floorText, floorRange, gen, o) {
    const label = '摘要[' + (groupDim === '统一' ? '统一' : (DIM_LABELS[groupDim] || groupDim)) + ']';
    try {
        const messages = await buildSummaryPrompt(floorText, dims);
        // v2.35.0：该组按维度解析 API target —— V1 `runSummarySeparate` 的 `dimensionPresets[dim] || overrideMain`
        //   （v1.206 14795~14796）。`o.ai` 注入时（测试）该字段被忽略，行为不变。
        const args = Object.assign(promptToGenerateArgs(messages), { target: resolveApiTarget({ purpose: 'dim', dimension: groupDim }) });
        // 第二参 label 与 V1 `callChatCompletion(prompt, override, label, 'analysis')` 的标签同源（宿主按它判定用途；
        //   本组的**连接**已由上面的 `target` 决定，label 只作留痕）
        const resp = await gen(args, label);
        if (!resp || resp.ok === false) return { dim: groupDim, ok: false, error: String((resp && resp.error) || 'ai-error').slice(0, 80), label };
        const delta = extractJsonObject(resp.text);
        if (!delta) return { dim: groupDim, ok: false, error: 'AI 未返回有效 JSON', label };
        const sub = groupDeltaSlice(dims, delta);
        if (!Object.keys(sub).some((k) => sub[k] !== undefined)) return { dim: groupDim, ok: false, error: '无该维度数据', label };
        const ok = mergeDelta(sub, floorRange);
        if (ok) { try { scheduleParallelWeave(floorRange, jsExtractKeywords(floorText)); } catch (e) { /* 忽略 */ } }
        return { dim: groupDim, ok, label };
    } catch (e) {
        warn('维度[' + (DIM_LABELS[groupDim] || groupDim) + ']摘要失败', e);
        return { dim: groupDim, ok: false, error: String((e && e.message) || e).slice(0, 80), label };
    }
}

/**
 * 独立分组抽取（V1 `runSummarySeparate(floorText, floorRange, silent)` 的 V2 版）。
 * 语义（V1 原样）：生效维度各自构造提示词并**并行**请求；未启用维度合成一个「统一」组；
 *   每组独立解析/切片/`mergeDelta`/计成功失败；合并成功的组各自触发被动推演。
 * V2 适配（逐条见 docs/P9d）：
 *   ① AI 通道 = 注入钩子（`o.ai` 注入点 / 宿主 `rawGenerate`）；**v2.35.0 起** `cfg.dimensionPresets[维度]`
 *      （按维度选 API 分组）**已实现**：每组按 `resolveApiTarget({purpose:'dim',dimension})` 解析出 target
 *      并随 `args.target` 传给宿主（P9d 当年的「不适用」判定已被推翻 —— 酒馆向扩展暴露了
 *      `ConnectionManagerRequestService` 官方通道，见 `docs/P10a-API页与按用途渠道对齐.md`）；
 *   ② V1 的 `abortTick()` / `newTaskStart()` / `pipeUpdate()` 未移植（V2 无任务中断标志与管线状态 UI）；
 *   ③ 形参 `silent` 在 V1 函数体内**从未被引用**（v1.206 原样），V2 直接不设该参数。
 * @param {string} floorText 楼层（或段）正文
 * @param {{start:number,end:number}} floorRange 落库楼层区间
 * @param {object} [opts] ai（注入生成函数，测试用）
 * @returns {Promise<Array<{dim:string, ok:object|boolean, error?:string}>>} 永不全量 reject（每组内部已兜住异常）
 */
export async function runSummarySeparate(floorText, floorRange, opts) {
    const o = opts || {};
    const gen = o.ai || rawGenerate;
    const { enabled, rest } = summaryDimGroups(o.dims);
    const tasks = [];
    for (const dim of enabled) tasks.push(runSeparateGroup(dim, [dim], floorText, floorRange, gen, o));
    if (rest.length) tasks.push(runSeparateGroup('统一', rest, floorText, floorRange, gen, o));
    return await Promise.all(tasks);
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
        // v2.68.0：这里必须投影成 **V1 摘要维度键**（`currentStates` → `states`），否则「状态记录」模板整段丢失
        const dims = summaryDimsForPrompt(o.dims);
        // ① 先校对时钟等基本信息（时钟唯一来源仍是「最新情节」，见 host/preflight.js 头注）
        const calib = calibrateBasics({ text: text });
        lastPreflight = calib;
        // ② 再用「已校对的基本信息 + 正文」去提取
        const messages = withBasics(await buildSummaryPrompt(text, dims), calib);
        // v2.35.0：主路径 target（V1 `overrideMain = { preset: cfg.activeApiPreset || undefined, ... }`，v1.206 14789）
        const args = Object.assign(promptToGenerateArgs(messages), { target: resolveApiTarget({ purpose: 'main' }) });
        const resp = await gen(args);
        if (!resp || resp.ok === false) {
            extractState.fail += 1; extractState.lastReason = 'ai-error';
            return { ok: false, reason: 'ai-error', error: (resp && resp.error) || '' };
        }
        const delta = extractJsonObject(resp.text);
        if (!delta) {
            extractState.fail += 1; extractState.lastReason = 'no-json';
            try { scheduleAutoRepairOnMergeFail(); } catch (e) { /* 忽略 */ }
            return { ok: false, reason: 'no-json', chars: String(resp.text || '').length };
        }
        const mr = mergeDelta(delta, { start: Number(floorId), end: Number(floorId) });
        try { bumpRepairOp(); } catch (e) { /* 忽略 */ }
        // V1 v1.206 15240~15242（单楼分析 `runSummaryFloor`）：合并成功 → 被动调度推演（关键词取该楼正文）；
        //   紧随其后**无条件**做一次情节总结检查点（V1 该行在 `if (mr && mr.ok)` 之外）
        if (mr && mr.ok) { try { scheduleParallelWeave({ start: Number(floorId), end: Number(floorId) }, jsExtractKeywords(text)); } catch (e) { /* 忽略 */ } }
        try { scheduleAtomCompact(); } catch (e) { /* 忽略 */ }
        if (!mr || !mr.ok) { extractState.fail += 1; extractState.lastReason = 'merge-fail'; return { ok: false, reason: 'merge-fail' }; }
        recordProcessedFloors(Number(floorId), Number(floorId));
        const ms = Date.now() - t0;
        extractState.ok += 1;
        extractState.lastReason = '';
        extractState.lastAdded = mr.added;
        extractState.lastMs = ms;
        extractState.lastDims = Object.keys(delta);
        try { dbgLog('摘要', { action: '单楼分析完成', floor: Number(floorId), added: mr.added, total: mr.total, ms, chars: String(resp.text || '').length, dims: Object.keys(delta).slice(0, 8) }); } catch (e) { /* 忽略 */ }
        const kws = (() => { try { return jsExtractKeywords(text); } catch (e2) { return []; } })();
        recordLastExtract({
            via: 'floor', trigger: String(o.trigger || 'manual'), floors: String(Number(floorId)),
            calib: (calib ? { changed: !!calib.changed, skipped: String(calib.skipped || ''), note: String(calib.note || ''), clock: calib.clock } : null),
            added: Number(mr.added) || 0, total: Number(mr.total) || 0, chars: String(resp.text || '').length, ms: ms,
            dims: Object.keys(delta).slice(0, 12), keywords: kws, text: String(resp.text || '').slice(0, LAST_EXTRACT_TEXT_CAP),
        });
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
    extractState.busySince = Date.now();
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
        extractState.busySince = 0;
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
        // v2.44.0：先按投喂标签过滤（需标签），再去 HTML 交 AI（顺序不可颠倒，见 host/floors.js 头注）
        const text = String(cleanText(applyFeedRegex(collectFloorLinesInRange(s0, e0).join('\n'))) || '').trim();
        if (!text) { recordProcessedFloors(s0, e0); return { ok: true, empty: true, added: 0, floorStart: s0, floorEnd: e0 }; }
        const gen = o.ai || rawGenerate;
        if (!o.ai && !generationAvailability().generateRaw) return { ok: false, reason: 'no-generate', floorStart: s0, floorEnd: e0 };
        // V1 v1.206 15477~15485：**独立分组分支**（`cfg.dimensionGrouping === 'separate'` → `runSummarySeparate`）。
        //   事实核验：V1 仅在**分段路径**（`runAutoSummary` 的 `runSegment`）判定该开关；单楼分析（`runSummaryFloor`）
        //   与其它路径**没有**该分支（`grep dimensionGrouping` 仅 1432 默认值 / 15477 此处分支 / 两处 UI 代理键）。
        if (separateGroupingEnabled()) {
            const results = await runSummarySeparate(text, { start: s0, end: e0 }, Object.assign({}, o, { ai: gen }));
            const okN = results.filter((r) => r && r.ok).length;
            // V1 原样：独立分组下**无论成败**都记该段已处理（与统一模式一致）
            recordProcessedFloors(s0, e0);
            const ms = Date.now() - t0;
            // V1 原样怪癖：独立分组分支**不累加** `totalAdded`（V1 通知里的「本次提取 N 条」在独立分组下恒为 0）→ 这里 `added: 0`
            return {
                ok: okN > 0, added: 0, separate: true, groups: results.length, groupOk: okN,
                groupFailed: results.length - okN, groupResults: results, chars: text.length, ms, floorStart: s0, floorEnd: e0,
            };
        }
        const dims = summaryDimsForPrompt(o.dims);   // v2.68.0：同上，投影成 V1 摘要维度键（含 states）
        // ① 先校对时钟等基本信息（与单楼同一套口径与顺序）
        const calib = calibrateBasics({ text: text });
        lastPreflight = calib;
        // ② 再提取
        const messages = withBasics(await buildSummaryPrompt(text, dims), calib);
        // v2.35.0：主路径 target（V1 `overrideMain = { preset: cfg.activeApiPreset || undefined, ... }`，v1.206 14789）
        const args = Object.assign(promptToGenerateArgs(messages), { target: resolveApiTarget({ purpose: 'main' }) });
        const resp = await gen(args);
        if (!resp || resp.ok === false) return { ok: false, reason: 'ai-error', error: (resp && resp.error) || '', floorStart: s0, floorEnd: e0 };
        const delta = extractJsonObject(resp.text);
        if (!delta) {
            try { scheduleAutoRepairOnMergeFail(); } catch (e) { /* 忽略 */ }
            return { ok: false, reason: 'no-json', chars: String(resp.text || '').length, floorStart: s0, floorEnd: e0 };
        }
        const mr = mergeDelta(delta, { start: s0, end: e0 });
        try { bumpRepairOp(); } catch (e) { /* 忽略 */ }
        if (!mr || !mr.ok) return { ok: false, reason: 'merge-fail', floorStart: s0, floorEnd: e0 };
        // V1 v1.206 15490（分段分析）：合并成功 → 被动调度推演（关键词取**段文本**）
        try { scheduleParallelWeave({ start: s0, end: e0 }, jsExtractKeywords(text)); } catch (e) { /* 忽略 */ }
        // V1 口径：**无论合并是否新增**都记该段为已处理（失败/无 JSON 则不记，下次重试）
        recordProcessedFloors(s0, e0);
        const ms = Date.now() - t0;
        lastSegmentText = String(resp.text || '').slice(0, LAST_EXTRACT_TEXT_CAP);
        recordLastExtract({
            via: 'segment', trigger: String(o.trigger || 'manual'), floors: s0 + '-' + e0,
            calib: (calib ? { changed: !!calib.changed, skipped: String(calib.skipped || ''), note: String(calib.note || ''), clock: calib.clock } : null),
            added: Number(mr.added) || 0, total: Number(mr.total) || 0, chars: String(resp.text || '').length, ms: ms,
            dims: Object.keys(delta).slice(0, 12), keywords: (() => { try { return jsExtractKeywords(text); } catch (e2) { return []; } })(),
            text: lastSegmentText,
        });
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
    extractState.busySince = Date.now();
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
        // v2.59.0：批量汇总也记一条（总览显示「本次批量：N 段 / 新增 M 条」；正文沿用最后一段的 AI 回复）
        recordLastExtract({
            via: 'batch', trigger: String(o.trigger || (silent ? 'auto' : 'manual')), floors: out.floors,
            added: added, total: 0, chars: String(lastSegmentText || '').length, ms: out.ms,
            made: made, failed: failed, segments: segments.length, aborted: aborted,
            keywords: (() => { try { return parallelLastKeywords(); } catch (e2) { return []; } })(), text: lastSegmentText,
        });
        if (made) extractState.ok += 1;
        if (failed) extractState.fail += 1;
        return out;
    } catch (e) {
        extractState.fail += 1;
        extractState.lastReason = String((e && e.message) || e);
        return { ok: false, reason: 'error', error: extractState.lastReason, made: 0, added: 0, failed: 0, floors: '', segments: 0, aborted: 0 };
    } finally {
        extractState.busy = false;
        extractState.busySince = 0;
        extractState.activeSeg = null;
        abortRequested = false;
        // V1 v1.206 15537（`runAutoSummary` 的 finally）：批量摘要收尾 → 情节总结检查点（4s 防抖，体量未达标内部跳过）
        try { scheduleAtomCompact(); } catch (e) { /* 忽略 */ }
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
    // v2.64.0：待分析清单改为「扫描结果」——额外给出**跳过明细**（用户楼/隐藏楼/无正文/已处理/已有记忆数据），
    //   便于核对「为什么这楼没被列出来」（`pendingCovered` = 已有记忆数据的楼层数）
    let scan = null;
    try { scan = scanPendingFloors({}); } catch (e) { scan = null; }
    return Object.assign({}, s, {
        processed: st,
        // v2.68.0：本次会请求的**提示词维度键**（V1 摘要键；`currentStates` 会投影成 `states`）——
        //   「某大类总是没数据」时先看这里：维度不在表里 = 提示词根本没带该维度的抽取说明
        promptDims: (() => { try { return summaryDimsForPrompt(); } catch (e) { return []; } })(),
        pending: scan ? scan.floors.length : listUnprocessedFloors({}).length,
        pendingCovered: scan ? scan.covered : 0,
        pendingSkipped: scan ? scan.skipped : null,
        pendingEnd: scan ? scan.endFloor : -1,
        floorHash: (n) => hashFloorText(n),
    });
}
