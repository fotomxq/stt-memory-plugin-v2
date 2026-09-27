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
/** @type {{label:string, startedAt:number, promptChars:number, respChars:number, phase:string, note:string, streamChunks:number, keys:string[]}|null} */
let cur = null;

/**
 * 开始一次处理行为。
 * @param {string} label 行为标签（决定 ETA 用哪组历史）
 * @param {{chars?:number, phase?:string}} [opts] `chars` = 发送给 AI 的字符数（用于 token 估算）
 */
export function beginPipeline(label, opts) {
    const o = opts || {};
    cur = {
        label: String(label || '默认'),
        startedAt: Number(hooks.now()) || Date.now(),
        promptChars: Math.max(0, Number(o.chars) || 0),
        respChars: 0, phase: String(o.phase || '准备'),
        note: '', streamChunks: 0, keys: [],
    };
    return snapshot();
}

/** 流式增量（宿主若能回调分块 → 累计字符数与块数；不保存内容） */
export function addStreamChunk(text) {
    if (!cur) return snapshot();
    const n = String(text == null ? '' : text).length;
    if (n > 0) { cur.respChars += n; cur.streamChunks += 1; }
    return snapshot();
}

/** 阶段推进（如「等待响应」/「解析 JSON」/「落库」）；`note` 只写结构摘要，**不得写正文** */
export function setPipelinePhase(phase, note) {
    if (!cur) return snapshot();
    if (phase) cur.phase = String(phase);
    if (note !== undefined) cur.note = String(note || '').slice(0, 60);
    return snapshot();
}

/**
 * 从 AI 响应文本提取**结构摘要**（只取顶层键名，不含任何内容）——
 * 例如 `{"情节": {"新增": [...]}, "记忆库": {...}}` → `情节 / 记忆库`。
 */
export function summarizeResponseKeys(text) {
    try {
        const s = String(text || '');
        const keys = [];
        const re = /"([^"\\]{1,12})"\s*:/g;
        let m;
        while ((m = re.exec(s)) !== null) {
            const k = m[1];
            if (/^(新增|更新|删除|变更|说明|标题|内容|正文|原因|备注)$/.test(k)) continue;   // 过滤二级键
            if (keys.indexOf(k) < 0) keys.push(k);
            if (keys.length >= 6) break;
        }
        return keys;
    } catch (e) { return []; }
}

/** 结束时记录耗时（`ok=false` 也记录：失败往往更快，分开看更准 —— 这里统一入样本） */
export function endPipeline(ok) {
    const s = snapshot();
    if (!cur) return s;
    const ms = Math.max(0, (Number(hooks.now()) || Date.now()) - cur.startedAt);
    try { recordPipelineRun(cur.label, ms); } catch (e) { /* 忽略 */ }
    cur = null;
    return Object.assign(s, { ms: ms, ok: ok !== false });
}

/** 当前状态快照（无运行中管线 → `{busy:false}`） */
export function snapshot() {
    if (!cur) return { busy: false };
    const now = Number(hooks.now()) || Date.now();
    const elapsed = Math.max(0, now - cur.startedAt);
    const eta = etaMs(cur.label);
    const tokens = estTokens(cur.promptChars + cur.respChars);
    return {
        busy: true, label: cur.label, elapsed: elapsed, eta: eta,
        remain: Math.max(0, eta - elapsed), over: elapsed > eta,
        promptTokens: estTokens(cur.promptChars), respTokens: estTokens(cur.respChars),
        tokens: tokens, respChars: cur.respChars, chunks: cur.streamChunks,
        phase: cur.phase, note: cur.note, keys: cur.keys.slice(),
        hasHistory: etaHasHistory(cur.label),
    };
}

/** 把结构摘要写入当前管线（供 UI 在响应到达后显示「识别到 情节 / 记忆库」） */
export function setPipelineKeys(keys) {
    if (!cur) return snapshot();
    cur.keys = Array.isArray(keys) ? keys.slice(0, 6).map((x) => String(x).slice(0, 12)) : [];
    return snapshot();
}

/**
 * 状态行后缀（UI 与测试共用）：
 * `· ⏱ 12s · 🪙 1.2k tok · 预计剩 8s`（超时改为「已超预估」）；无历史时倒计时标注「默认」。
 */
export function pipelineSuffix() {
    const s = snapshot();
    if (!s.busy) return '';
    const parts = ['⏱ ' + Math.floor(s.elapsed / 1000) + 's'];
    if (s.tokens > 0) parts.push('🪙 ' + fmtTokens(s.tokens) + ' tok');
    parts.push(s.over ? ('已超预估 ' + fmtSec(s.remain === 0 ? s.elapsed - s.eta : 0)) : ('预计剩 ' + fmtSec(s.remain) + (s.hasHistory ? '' : '（默认）')));
    if (s.chunks > 0) parts.push('流式 ' + s.chunks + ' 块');
    return parts.join(' · ');
}

/** 结构摘要文本（无内容）：识别到的顶层键 / 当前阶段 */
export function pipelineSummaryText() {
    const s = snapshot();
    if (!s.busy) return '';
    if (s.keys.length) return '识别到 ' + s.keys.join(' / ');
    return s.note ? s.note : (s.phase ? ('阶段：' + s.phase) : '');
}

/** 复位（测试与中断用） */
export function resetPipeline() { cur = null; return true; }
