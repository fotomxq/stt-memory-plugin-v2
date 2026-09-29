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

/**
 * v3.0.14（用户报告「保存记忆文件会执行超长时间，管线状态看到 2.6 万秒」）——**卡死运行的兜底收尾阈值**。
 * 一次运行超过该时长仍未被 `endPipeline` 收尾，即视为**泄漏 / 卡死**：由 `reapStaleRuns()` 就地撤下，
 *   **不记 ETA 样本**（绝不让 7 小时污染「预计剩」），并在调试日志留一条可追溯的记录。
 * 15 分钟：远大于任何正常动作（含最慢的 AI 生成），又远小于用户看到的那种「数万秒」。
 */
export const PIPELINE_STALE_MS = 15 * 60 * 1000;
/**
 * v3.0.14：**耗时样本的合理上限**（超过即不记入 ETA 历史）。
 *   「预计剩」= 同标签历史均值；若把卡死的 2.6 万秒记进去，之后每次保存都会显示「预计剩 7 小时」。
 */
export const PIPELINE_SAMPLE_MAX_MS = 15 * 60 * 1000;

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
    // v3.0.14：诊断留痕（宿主注入 → 调试日志）；默认 no-op，内核保持零宿主依赖
    log: () => undefined,        // (msg, detail) => void
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
    // v3.0.14：**异常大的样本不入账** —— 卡死/挂起的运行（如 2.6 万秒的「保存记忆文件」）会把
    //   同标签的「预计剩」永久拉成数小时，且样本表只有 5 格，一次污染就顶掉全部正常样本。
    if (v > PIPELINE_SAMPLE_MAX_MS) {
        try { hooks.log('管线状态：忽略异常耗时样本', { label: key, ms: v, max: PIPELINE_SAMPLE_MAX_MS }); } catch (e) { /* 忽略 */ }
        return history();
    }
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
    const key = String(label || '默认');
    // v3.0.0：`join: true` —— **同标签已在跑**时不再新开一行（嵌套 / 重复触发的同类动作共享一行，避免刷屏）。
    //   用引用计数：每个 begin 都要有对应的 end，最后一个 end 才真正收尾并记录耗时样本。
    if (o.join) {
        const same = runs.filter((r) => r.label === key);
        if (same.length) {
            const r = same[same.length - 1];
            r.refs = Math.max(1, Number(r.refs) || 1) + 1;
            // v3.0.14 **根因修复**（用户报告「保存记忆文件会执行超长时间，管线状态 2.6 万秒」）：
            //   合流时必须回传**被合流那一行的 id**。此前直接返回聚合 `snapshot()`，而它的 `runId` 是
            //   「最新开始的那一行」—— 并发时（保存 + AI 请求 + 同步同时进行是常态）那是**别的行**：
            //   · `trackPipeline` 收尾时把**别的运行**结束掉；
            //   · 真正被合流的这一行引用计数永远减不到 0 → **永久留在运行表里**，UI 上的「已用时」
            //     无上限增长（用户看到的 2.6 万秒 ≈ 7.2 小时就是这么来的）。
            return Object.assign(snapshot(), { runId: r.id });
        }
    }
    runs.push({
        id: ++runSeq,
        refs: 1,
        label: key,
        // v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：运行**类别**，UI 据此给行首标签
        //   ai = AI 请求 · sync = 同步 / 存储 · io = 读写文件 · task = 其它长任务
        kind: String(o.kind || 'task'),
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
    // v3.0.0：合流运行按引用计数收尾 —— 还有调用方在跑时**不移除**（避免提前把行撤掉）
    const refs = Math.max(1, Number(r.refs) || 1);
    if (refs > 1) { r.refs = refs - 1; return s; }
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

/** 类别标签（UI 行首用；未知类别回落「任务」） */
export const PIPELINE_KIND_LABEL = Object.freeze({ ai: 'AI', sync: '同步', io: '存储', task: '任务' });

/**
 * v3.0.14：把**卡死 / 泄漏**的运行就地撤下（存活超过 `PIPELINE_STALE_MS`）。
 *   为什么要有这一层：运行表是「begin 一行、end 一行」配对的引用计数模型，任何一处少配对（异常路径、
 *   第三方钩子、宿主中途换页）都会让那一行**永久生效**——UI 上的「已用时」就会无上限增长
 *   （用户实测到 2.6 万秒）。根因已修（见 `beginPipeline` 的 `join` 分支），这里再给一层**兜底**：
 *   超时即撤下，**不记 ETA 样本**（绝不让一次卡死把「预计剩」永久拉成数小时），只在调试日志留痕。
 *   纯内核：不加定时器，只在读取快照（`snapshot()` / `listPipelineRuns()`）时顺手清理。
 * @returns {number} 本次收尾的行数
 */
export function reapStaleRuns() {
    if (!runs.length) return 0;
    const now = Number(hooks.now()) || Date.now();
    const stale = runs.filter((r) => (now - r.startedAt) > PIPELINE_STALE_MS);
    if (!stale.length) return 0;
    runs = runs.filter((r) => stale.indexOf(r) < 0);
    for (const r of stale) {
        try { hooks.log('管线状态：运行超时收尾（疑似泄漏，未计入预计耗时样本）', { label: r.label, kind: r.kind, ms: now - r.startedAt, phase: r.phase }); } catch (e) { /* 忽略 */ }
    }
    const r0 = stale[stale.length - 1];
    last = {
        label: r0.label, ms: Math.max(0, now - r0.startedAt), ok: false, at: Date.now(), stale: true,
        keys: r0.keys.slice(), phase: r0.phase, note: '超时收尾（未计入预计耗时样本）',
        promptChars: r0.promptChars, respChars: r0.respChars,
        chunks: r0.streamChunks, streamChars: r0.streamChars,
        promptTokens: estTokens(r0.promptChars), respTokens: estTokens(r0.respChars),
    };
    return stale.length;
}

/**
 * v3.0.0（用户要求「如果有并行时出现两个或两个以上，根据需求展现」）——**逐条**运行快照（最新开始的在前）。
 * UI 一行一条；聚合读数仍由 `snapshot()` 给出（既有调用点不变）。
 * @returns {Array<object>} 每条含 `{id, label, kind, kindLabel, elapsed, eta, remain, over, tokens, promptTokens,
 *   respTokens, respChars, chunks, streamChars, streaming, phase, note, keys, hasHistory, text}`
 */
export function listPipelineRuns() {
    reapStaleRuns();
    if (!runs.length) return [];
    const now = Number(hooks.now()) || Date.now();
    const out = [];
    for (let i = runs.length - 1; i >= 0; i--) {
        const r = runs[i];
        const elapsed = Math.max(0, now - r.startedAt);
        const eta = etaMs(r.label);
        const item = {
            id: r.id, label: r.label, kind: r.kind, kindLabel: PIPELINE_KIND_LABEL[r.kind] || PIPELINE_KIND_LABEL.task,
            elapsed: elapsed, eta: eta, remain: Math.max(0, eta - elapsed), over: elapsed > eta,
            tokens: estTokens(r.promptChars + r.respChars),
            promptTokens: estTokens(r.promptChars), respTokens: estTokens(r.respChars),
            respChars: r.respChars, chunks: r.streamChunks, streamChars: r.streamChars,
            streaming: r.streamChunks > 0,
            phase: r.phase, note: r.note, keys: r.keys.slice(),
            hasHistory: etaHasHistory(r.label),
            joined: Math.max(1, Number(r.refs) || 1),
        };
        item.text = pipelineRunLine(item);
        out.push(item);
    }
    return out;
}

/**
 * 单条运行的**状态行文本**（不含批次进度 —— 那部分由 UI 依据 `batchProgress()` 补充）。
 * 形如：`[AI] 批量摘要 · ⏱ 12s · 🪙 1.2k tok · 预计剩 8s · 流式 37 块 / 1.9k 字 · 阶段：解析响应`。
 */
export function pipelineRunLine(r) {
    const it = r || {};
    const parts = ['[' + (it.kindLabel || PIPELINE_KIND_LABEL.task) + '] ' + String(it.label || '任务')];
    parts.push('⏱ ' + Math.floor((Number(it.elapsed) || 0) / 1000) + 's');
    if (Number(it.tokens) > 0) parts.push('🪙 ' + fmtTokens(it.tokens) + ' tok');
    if (it.over) parts.push('已超预估 ' + fmtSec(0));
    else parts.push('预计剩 ' + fmtSec(it.remain) + (it.hasHistory ? '' : '（默认）'));
    if (Number(it.chunks) > 0) parts.push('流式 ' + Number(it.chunks) + ' 块 / ' + fmtTokens(it.streamChars) + ' 字');
    if (Number(it.joined) > 1) parts.push('合并 ' + Number(it.joined) + ' 次');
    const sum = (() => {
        if (it.keys && it.keys.length) return '识别到 ' + it.keys.join(' / ');
        if (it.note) return String(it.note);
        if (it.phase) return '阶段：' + String(it.phase);
        return '';
    })();
    if (sum) parts.push(sum);
    return parts.join(' · ');
}

/** 全部运行的状态行（空数组 = 无进行中的动作 → UI 整块不显示） */
export function pipelineLines() { return listPipelineRuns().map((r) => r.text); }

/**
 * v3.0.0：把一段异步动作**纳入管线状态**（自带收尾，异常也如实结束）。
 * 用法（宿主/适配层一行接线）：
 * ```js
 * await trackPipeline('跨端同步', { kind: 'sync' }, async (t) => { t.phase('拉取对端'); … });
 * ```
 * @param {string} label 行为标签（决定 ETA 归组与行文本）
 * @param {{kind?:string, chars?:number, phase?:string}} opts
 * @param {(ctl:{id:number, phase:(p:string,n?:string)=>void, chunk:(t:string)=>void, respond:(t:string)=>void, keys:(k:string[])=>void}) => Promise<any>} fn
 * @returns {Promise<any>} `fn` 的返回值
 */
export async function trackPipeline(label, opts, fn) {
    let id;
    try { id = (beginPipeline(label, opts) || {}).runId; } catch (e) { id = undefined; }
    const ctl = {
        id: id,
        phase: (ph, note) => { try { setPipelinePhase(ph, note, { id: id }); } catch (e) { /* 忽略 */ } },
        chunk: (t) => { try { addStreamChunk(t, { id: id }); } catch (e) { /* 忽略 */ } },
        respond: (t) => { try { noteResponseText(t, { id: id }); } catch (e) { /* 忽略 */ } },
        keys: (k) => { try { setPipelineKeys(k, { id: id }); } catch (e) { /* 忽略 */ } },
    };
    try {
        const r = await fn(ctl);
        try { endPipeline(true, id); } catch (e) { /* 忽略 */ }
        return r;
    } catch (e) {
        try { endPipeline(false, id); } catch (e2) { /* 忽略 */ }
        throw e;
    }
}

/** 当前状态快照（无运行中管线 → `{busy:false}`）；并发时**聚合**为一条读数 */
export function snapshot() {
    reapStaleRuns();
    if (!runs.length) return { busy: false };
    const now = Number(hooks.now()) || Date.now();
    const oldest = runs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    const newest = runs[runs.length - 1];
    const elapsed = Math.max(0, now - oldest.startedAt);
    // v3.0.3：**代表运行**用于「聚合读数」的 label / ETA / 阶段（并发时给出**最有信息量**的那一条）：
    //   ① 有 AI 运行 → 取**最新开始的 AI 运行**（管线的主线就是 AI 请求；后台保存/同步只是伴随动作，
    //      若用「最早开始」会在 AI 请求期间把标题写成「保存记忆文件」—— 用户看到的就是「提示串台」）；
    //   ② 没有 AI 运行 → 取最新开始的那一次（同步 / 存储 / 任务）。
    //   注意：`elapsed` 仍是**最早开始**到现在（= 本轮「忙」了多久），列表逐条读数不受影响。
    const rep = (() => {
        const aiRuns = runs.filter((r) => r.kind === 'ai');
        if (aiRuns.length) return aiRuns[aiRuns.length - 1];
        return newest;
    })();
    const label = rep.label;
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
        // 阶段/结构摘要与 label 同源（代表运行）——避免「标题说批量摘要、阶段说写入存储」的串台
        phase: rep.phase, note: rep.note, keys: rep.keys.slice(),
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
