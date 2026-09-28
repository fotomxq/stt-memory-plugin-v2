// ============================================================
// core/pipeline.js —— **管线状态：流式摘要 + token 计数 + 预估倒计时**（v2.90.0）
// 用户要求（原话）：「管线状态中的提示信息，补充流式更新细节，不需要让用户看到具体内容，只提取一些摘要展示，
//   让用户感知正在处理。其次除了读秒，还需增加 token 计数、预估倒计时。其中预估倒计时，可内置记录
//   最近几次不同处理行为的耗时作为参考。如果为第一次，则给一个潜在默认时间作为倒计时。」
// 口径：
//   · **不泄漏内容**：摘要只给「阶段 + 结构信息」（如识别到的顶层键名、响应字数/块数），绝不显示正文；
//   · **token 计数**：`ceil(字符数 / 4)` 估算（中英混排的通用近似）；prompt 与响应分别计，取合计；
//   · **预估倒计时**：按**处理行为标签**（label）取最近 N 次耗时均值；无历史 → 用内置默认表；
//   · 好历史持久化由宿主注入（`setPipelineHooks`，本项目落 ST 扩展设置，不进数据模型 → `DATA_VERSION` 不变）；
//   · 纯内核：无 DOM / 无宿主 / 无定时器（定时刷新由 UI 的 500ms 心跳负责）。
// ============================================================
import { extractJsonObject } from './util.js';

/** 最近耗时样本条数（每个行为各保留最近 N 次） */
export const ETA_SAMPLES = 5;

/** 各处理行为的**潜在默认耗时**（ms；首次运行没有历史时用它做倒计时） */
export const PIPELINE_DEFAULTS = Object.freeze({
    '情节总结': 6000,
    '批量摘要': 20000,     // 每段（分段批量摘要按段推进）
    '单楼分析': 6000,
    '提取记忆': 8000,
    '自动修复': 9000,
    '推演': 5000,
    '传言演化': 4000,
    '向量检索': 2500,
    '弱化NSFW': 12000,
    '时钟巡检': 3000,
    '默认': 8000,
});

let hooks = {
    getHistory: () => ({}),      // () => { [label]: number[] }（宿主注入，读持久化历史）
    saveHistory: () => undefined, // (h) => void
    now: () => Date.now(),
};
export function setPipelineHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function pipelineHooks() { return Object.assign({}, hooks); }

/** token 估算（字符数 → token；中英混排近似 4 字符 ≈ 1 token） */
export function estTokens(chars) {
    const n = Number(chars);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n / 4);
}
/** token 展示（千分位缩写：1234 → 1.2k） */
export function fmtTokens(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}
/** 秒展示（向上取整，至少 1s） */
export function fmtSec(ms) { return Math.max(1, Math.ceil((Number(ms) || 0) / 1000)) + 's'; }

/** 历史（读宿主；异常 → 空表） */
function history() {
    try { const h = hooks.getHistory(); return (h && typeof h === 'object') ? h : {}; } catch (e) { return {}; }
}
/**
 * 某处理行为的**预估耗时**（ms）：优先最近样本均值（去掉最大最小各一个的稳健均值），否则内置默认。
 * @param {string} label 处理行为标签（如「批量摘要」/「单楼分析」）
 */
export function etaMs(label) {
    const key = String(label || '');
    const arr = (history()[key] || []).filter((x) => Number.isFinite(Number(x)) && Number(x) > 0).map(Number);
    if (!arr.length) return Number(PIPELINE_DEFAULTS[key] || PIPELINE_DEFAULTS['默认']);
    const sorted = arr.slice().sort((a, b) => a - b);
    const use = (sorted.length >= 3) ? sorted.slice(1, sorted.length - 1) : sorted;   // 去极值（样本 ≥3 时）
    const avg = use.reduce((n, v) => n + v, 0) / use.length;
    return Math.max(300, Math.round(avg));
}
/** 该行为是否已有历史（用于区分「预估」与「默认」文案） */
export function etaHasHistory(label) { return ((history()[String(label || '')] || []).length > 0); }

/** 记录一次处理行为耗时（保留最近 ETA_SAMPLES 次并落盘；返回记录后的历史表） */
export function recordPipelineRun(label, ms) {
    const key = String(label || '');
    const v = Math.round(Number(ms) || 0);
    if (!key || !(v > 0)) return history();
    const h = Object.assign({}, history());
    const arr = (h[key] || []).slice(-(ETA_SAMPLES - 1));
    arr.push(v);
    h[key] = arr;
    try { hooks.saveHistory(h); } catch (e) { /* 落盘失败不影响运行 */ }
    return h;
}

// ==================== 当前管线（运行中状态） ====================
// v2.95.0 修复（用户报告「倒计时、流文字展示等都没有生效」）：**支持并发** ——
//   摘要「独立分组」会并行发起最多 10 个请求（`host/extract.js#runSummarySeparate`），
//   旧实现只有一个 `cur` 槽 → 后开始的请求把前一个覆盖掉，先结束的又把还在跑的那个清空，
//   于是状态行时有时无。现在用**按 id 的活跃表**：快照把并发运行**聚合**成一条读数。
/** @typedef {{id:number, label:string, startedAt:number, promptChars:number, respChars:number,
 *             streamChars:number, streamChunks:number, phase:string, note:string, keys:string[]}} Run */
/** @type {Run[]} 活跃运行表（按开始时间升序） */
let runs = [];
let runSeq = 0;
/** 最近一次**已结束**的运行摘要（只读诊断：面板/调试页可直接展示「上次做了什么、花了多久、识别到哪些键」） */
let last = null;

/** 取运行（缺 id → 最近开始的那个） */
function runOf(id) {
    if (id === undefined || id === null || id === '') return runs.length ? runs[runs.length - 1] : null;
    const n = Number(id);
    return runs.filter((r) => r.id === n)[0] || null;
}

/**
 * 开始一次处理行为。
 * @param {string} label 行为标签（决定 ETA 用哪组历史）
 * @param {{chars?:number, phase?:string}} [opts] `chars` = 发送给 AI 的字符数（用于 token 估算）
 * @returns {object} 快照（含本次运行的 `runId`，并发调用方应把它透传给 `addStreamChunk`/`endPipeline`）
 */
export function beginPipeline(label, opts) {
    const o = opts || {};
    runs.push({
        id: ++runSeq,
        label: String(label || '默认'),
        startedAt: Number(hooks.now()) || Date.now(),
        promptChars: Math.max(0, Number(o.chars) || 0),
        respChars: 0, streamChars: 0, streamChunks: 0,
        phase: String(o.phase || '准备'), note: '', keys: [],
    });
    return snapshot();
}

/**
 * **真实的流式分块**（宿主逐块回调时用）：累计字符数与块数。
 * 注意：非流式通道把整段响应一次给出时**不要**走这里 —— 用 `noteResponseText()`，
 *   否则状态行会把「一次性响应」谎报成「流式 1 块」（v2.95.0 修复）。
 */
export function addStreamChunk(text, opts) {
    const o = opts || {};
    const r = runOf(o.id);
    const n = String(text == null ? '' : text).length;
    if (!r || n <= 0) return snapshot();
    r.respChars += n;
    if (o.final === true) return snapshot();      // 兼容旧调用：整段响应不计块
    r.streamChunks += 1;
    r.streamChars += n;
    return snapshot();
}

/**
 * **整段响应**（非流式通道）：只刷新响应字符数（幂等取大值），**不计流式块**。
 * 有流式分块已到达时（`respChars` 已 ≥ 文本长度）不重复累加。
 */
export function noteResponseText(text, opts) {
    const o = opts || {};
    const r = runOf(o.id);
    if (!r) return snapshot();
    const n = String(text == null ? '' : text).length;
    if (n > r.respChars) r.respChars = n;
    return snapshot();
}

/** 阶段推进（如「等待响应」/「解析 JSON」/「落库」）；`note` 只写结构摘要，**不得写正文** */
export function setPipelinePhase(phase, note, opts) {
    const o = opts || {};
    const r = runOf(o.id);
    if (!r) return snapshot();
    if (phase !== undefined && phase !== null) r.phase = String(phase || '');   // 传空串 = 清掉阶段
    if (note !== undefined) r.note = String(note || '').slice(0, 60);
    return snapshot();
}

/**
 * 从 AI 响应文本提取**结构摘要**（只取顶层键名，不含任何内容）——
 * 例如 `{"情节": {"新增": [...]}, "记忆库": {...}}` → `情节 / 记忆库`。
 */
export function summarizeResponseKeys(text) {
    try {
        const s = String(text || '');
        // v2.95.0：**优先真正解析 JSON → 只取顶层键**（旧实现用正则扫 `"key":`，会把二级/三级键
        //   一起捞出来 —— 例如 `{"atoms":{"add":[{"title":…}]}}` 会显示成「atoms / add / title / text / date」，
        //   既吵闹又泄漏内部结构）。解析失败（流式中 / 响应被截断）再回退到正则扫描。
        const NOISE = /^(add|update|del|delete|remove|list|items?|title|text|content|desc|date|time|name|id|key|value|type|note|reason|新增|更新|删除|变更|说明|标题|内容|正文|原因|备注)$/i;
        const keys = [];
        const push = (k) => {
            const kk = String(k == null ? '' : k).slice(0, 12);
            if (!kk || NOISE.test(kk) || keys.indexOf(kk) >= 0) return;
            if (keys.length < 6) keys.push(kk);
        };
        let parsed = null;
        try { parsed = extractJsonObject(s); } catch (e) { parsed = null; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.keys(parsed).forEach(push);
            if (keys.length) return keys;
        }
        // 回退：扫描形如 `"键":` 的片段（同样过滤二级键）
        const re = /"([^"\\]{1,12})"\s*:/g;
        let m;
        while ((m = re.exec(s)) !== null) {
            push(m[1]);
            if (keys.length >= 6) break;
        }
        return keys;
    } catch (e) { return []; }
}

/**
 * 结束一次运行（并记录耗时供下次预估）。
 * 缺 `id` 时结束**最近开始**的那次（单运行场景与旧行为完全一致）。
 * @param {boolean} ok
 * @param {number} [id] `beginPipeline` 返回的 `runId`（并发时必须显式给出）
 */
export function endPipeline(ok, id) {
    const s = snapshot();
    const r = runOf(id);
    if (!r) return s;
    const ms = Math.max(0, (Number(hooks.now()) || Date.now()) - r.startedAt);
    try { recordPipelineRun(r.label, ms); } catch (e) { /* 忽略 */ }
    last = {
        label: r.label, ms: ms, ok: ok !== false, at: Date.now(),
        keys: r.keys.slice(), phase: r.phase, note: r.note,
        promptChars: r.promptChars, respChars: r.respChars,
        chunks: r.streamChunks, streamChars: r.streamChars,
        promptTokens: estTokens(r.promptChars), respTokens: estTokens(r.respChars),
    };
    runs = runs.filter((x) => x.id !== r.id);
    return Object.assign(s, { ms: ms, ok: ok !== false });
}

/** 当前状态快照（无运行中管线 → `{busy:false}`）；并发时**聚合**为一条读数 */
export function snapshot() {
    if (!runs.length) return { busy: false };
    const now = Number(hooks.now()) || Date.now();
    const oldest = runs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    const newest = runs[runs.length - 1];
    const elapsed = Math.max(0, now - oldest.startedAt);
    const label = oldest.label;                     // ETA 以**最早开始**的那次为准（它决定何时全部结束）
    const eta = etaMs(label);
    let promptChars = 0, respChars = 0, streamChars = 0, chunks = 0, tokens = 0;
    for (const r of runs) {
        promptChars += r.promptChars;
        respChars += r.respChars;
        streamChars += r.streamChars;
        chunks += r.streamChunks;
        tokens += estTokens(r.promptChars + r.respChars);
    }
    return {
        busy: true, runId: newest.id, runs: runs.length, labels: runs.map((r) => r.label),
        label: label, elapsed: elapsed, eta: eta,
        remain: Math.max(0, eta - elapsed), over: elapsed > eta,
        promptTokens: estTokens(promptChars), respTokens: estTokens(respChars),
        tokens: tokens, promptChars: promptChars, respChars: respChars,
        chunks: chunks, streamChars: streamChars, streaming: chunks > 0,
        // 阶段/结构摘要取**最近更新**的那次（它代表「当前正在做什么」）
        phase: newest.phase, note: newest.note, keys: newest.keys.slice(),
        hasHistory: runs.some((r) => etaHasHistory(r.label)),
    };
}

/** 把结构摘要写入当前管线（供 UI 在响应到达后显示「识别到 情节 / 记忆库」） */
export function setPipelineKeys(keys, opts) {
    const o = opts || {};
    const r = runOf(o.id);
    if (!r) return snapshot();
    r.keys = Array.isArray(keys) ? keys.slice(0, 6).map((x) => String(x).slice(0, 12)) : [];
    return snapshot();
}

/**
 * 状态行后缀（UI 与测试共用）：
 * `· ⏱ 12s · 🪙 1.2k tok · 预计剩 8s · 流式 9 块 / 1.1k 字`；超时改为「已超预估」。
 * v2.95.0：`流式 N 块` **只在真的收到分块时**出现（不再把整段响应谎报成 1 块）；
 *   并发运行追加 `并发 N 路`。
 */
export function pipelineSuffix() {
    const s = snapshot();
    if (!s.busy) return '';
    const parts = ['⏱ ' + Math.floor(s.elapsed / 1000) + 's'];
    if (s.tokens > 0) parts.push('🪙 ' + fmtTokens(s.tokens) + ' tok');
    parts.push(s.over ? ('已超预估 ' + fmtSec(s.remain === 0 ? s.elapsed - s.eta : 0)) : ('预计剩 ' + fmtSec(s.remain) + (s.hasHistory ? '' : '（默认）')));
    if (s.chunks > 0) parts.push('流式 ' + s.chunks + ' 块 / ' + fmtTokens(s.streamChars) + ' 字');
    if (s.runs > 1) parts.push('并发 ' + s.runs + ' 路');
    return parts.join(' · ');
}

/** 结构摘要文本（无内容）：识别到的顶层键 / 当前阶段；等待响应时给一句可感知的进行态 */
export function pipelineSummaryText() {
    const s = snapshot();
    if (!s.busy) return '';
    if (s.keys.length) return '识别到 ' + s.keys.join(' / ');
    if (s.note) return s.note;
    if (s.phase) return '阶段：' + s.phase;
    return s.streaming ? '接收中' : '等待响应';
}

/** 最近一次已结束运行的摘要（无 → `null`）；供只读诊断使用，**不含任何正文** */
export function lastPipelineInfo() { return last ? Object.assign({}, last, { keys: last.keys.slice() }) : null; }

/** 复位（测试与中断用） */
export function resetPipeline() { runs = []; last = null; return true; }
