// ============================================================
// host/embeddings.js —— **Embedding / Rerank 请求**（v2.58.0，对齐 V1 v1.206）
//
// V1 出处：`src/FTT记忆组件-v1.206.js#requestEmbeddings` 约 12452~12493：
// v2.79.0 修正：① 不完整 embedding 返回必须失败（V1 空槽数组缺陷）；② 超时统一读 `cfg.vectorTimeoutMs`。
//   · 地址/Key/模型取 `cfg.embeddingUrl/embeddingKey/embeddingModel`；**地址为空且设了代理预设名**时，
//     从代理预设读 `settings.apiurl/key`（V1 走 TavernHelper `getPreset`）；
//   · 未配置 → 抛「Embedding API 未配置」；无输入 → 返回空；
//   · 端点：`/embeddings`（已带后缀不重复拼）；`Authorization: Bearer <key>`；
//   · 体 `{ model, input: texts }`；超时 `cfg.vectorTimeoutMs`（默认 15000）；
//   · 解析 `j.data[].{index, embedding}`（按 index 归位，缺项即「返回不完整」）；
//   · 失败逐传输尝试（V1：direct → 宿主 `/proxy/<endpoint>`）；成功写调试日志 `kind='向量'`。
//
// V2 适配（与 V1 的差异逐条登记于 `docs/P10v-向量层与提取页对齐.md`）：
//   ① 「代理预设」在 V2 = **API 分组**（`cfg.apiPresets[name]`，含 apiUrl/apiKey/model）。
//      V1 的 TavernHelper 预设名（`getPreset`）在原生扩展里拿不到 —— 故 V2 用自家分组作等价物；
//      分组缺失/不含地址时**如实回报原因**，不静默失败。
//   ② 传输顺序与 V1 相同：先直连；直连因网络/CORS 失败且存在代理路径时再试代理
//      （V2 原生扩展没有宿主 `/proxy` 通道，故「代理」= 该分组的自建地址，本质仍是直连）。
//   ③ 不抛异常：返回 `{ok, vectors|error, ...}`；调用方（`host/vector-recall.js`）据此降级。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { apiPresetGet } from '../core/api-channel.js';
import { debugLogPush } from '../adapters/debug-log.js';
import { embeddingsEndpoint, rerankEndpoint, DIRECT_TIMEOUT_MS } from './api-channel.js';

const str = (v) => String(v == null ? '' : v).trim();
const trimUrl = (v) => str(v).replace(/\/+$/, '');

/** 调试日志（V1 `dbgLog('向量', …)`；关闭调试时不写） */
function logVec(data) { try { debugLogPush('向量', data); } catch (e) { /* 忽略 */ } }

/**
 * 解析一个向量通道（Embedding / Rerank）的有效连接：内联优先，其次代理预设（API 分组）。
 * @param {'embedding'|'rerank'} kind
 * @returns {{ok:boolean, url:string, key:string, model:string, preset:string, from:string, error?:string}}
 */
export function vectorTarget(kind) {
    const k = kind === 'rerank' ? 'rerank' : 'embedding';
    const urlKey = k === 'rerank' ? 'rerankUrl' : 'embeddingUrl';
    const keyKey = k === 'rerank' ? 'rerankKey' : 'embeddingKey';
    const modelKey = k === 'rerank' ? 'rerankModel' : 'embeddingModel';
    const presetKey = k === 'rerank' ? 'rerankProxyPreset' : 'embeddingProxyPreset';
    let url = trimUrl(cfg[urlKey]);
    let key = str(cfg[keyKey]);
    let model = str(cfg[modelKey]);
    const preset = str(cfg[presetKey]);
    let from = url ? 'inline' : '';
    if (!url && preset) {
        const p = apiPresetGet(preset);
        if (p) { url = trimUrl(p.apiUrl || p.url); key = str(p.apiKey || p.key); if (!model) model = str(p.model); from = 'preset'; }
    }
    const label = k === 'rerank' ? 'Rerank' : 'Embedding';
    if (!url) return { ok: false, url: '', key: key, model: model, preset: preset, from: from, error: label + ' API 未配置（缺少地址' + (preset ? '，且分组「' + preset + '」不含地址' : '') + '）' };
    if (!model) return { ok: false, url: url, key: key, model: '', preset: preset, from: from, error: label + ' API 未配置模型' };
    return { ok: true, url: url, key: key, model: model, preset: preset, from: from === 'preset' ? 'preset' : 'inline' };
}

/** 向量层设置摘要（设置页 / 诊断 / 测试动作共用，避免多处各算一份） */
export function vectorLayerInfo() {
    const e = vectorTarget('embedding');
    const r = vectorTarget('rerank');
    return {
        useVector: cfg.useVector === true,
        topN: Number(cfg.vectorTopN) || 5,
        minScore: Number.isFinite(Number(cfg.vectorMinScore)) ? Number(cfg.vectorMinScore) : 0.35,
        timeoutMs: Number(cfg.vectorTimeoutMs) || 15000,
        embedding: e,
        rerank: r,
        rerankActive: r.ok,          // Rerank 已配置 → 精排步骤生效（V1 仅提供设置与测试，搜索路径未调用；V2 生效，见 docs/P10v）
    };
}

/** 带超时的 fetch（`cfg.vectorTimeoutMs`；无 AbortController 时退化为无超时） */
async function fetchJson(url, body, key, timeoutMs) {
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: '当前环境没有 fetch' };
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(cfg.vectorTimeoutMs) > 0 ? Number(cfg.vectorTimeoutMs) : DIRECT_TIMEOUT_MS);
    let ac = null, timer = null;
    if (typeof AbortController === 'function') {
        ac = new AbortController();
        timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* 忽略 */ } }, ms);
    }
    try {
        const res = await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac ? ac.signal : undefined });
        if (!res || !res.ok) {
            const txt = res && typeof res.text === 'function' ? await res.text().catch(() => (res && res.statusText) || '') : '';
            return { ok: false, error: 'HTTP ' + ((res && res.status) || 0) + ': ' + String(txt).slice(0, 200) };
        }
        const j = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
        return { ok: true, json: j };
    } catch (e) {
        const msg = str((e && e.message) || e);
        const hint = /Failed to fetch|NetworkError|Load failed|aborted|AbortError/i.test(msg) ? '（直连失败：网络不可达 / CORS / 超时）' : '';
        return { ok: false, error: (msg + hint).slice(0, 300) };
    } finally { if (timer) clearTimeout(timer); }
}

/**
 * 批量取 embedding（V1 `requestEmbeddings` 的 V2 等价物）。
 * @param {string[]} texts
 * @returns {Promise<{ok:boolean, vectors:number[][], error?:string, model?:string, from?:string, dims?:number}>}
 */
export async function requestEmbeddings(texts) {
    const inputs = (Array.isArray(texts) ? texts : []).map((t) => str(t)).filter(Boolean);
    if (!inputs.length) return { ok: true, vectors: [] };
    if (cfg.useVector !== true) return { ok: false, vectors: [], error: '向量检索未启用' };
    const t = vectorTarget('embedding');
    if (!t.ok) return { ok: false, vectors: [], error: t.error };
    const r = await fetchJson(embeddingsEndpoint(t.url), { model: t.model, input: inputs }, t.key);
    if (!r.ok) {
        logVec({ action: 'embedding', ok: false, model: t.model, inputs: inputs.length, from: t.from, error: String(r.error).slice(0, 120) });
        return { ok: false, vectors: [], error: r.error };
    }
    const data = Array.isArray(r.json && r.json.data) ? r.json.data : [];
    // v2.79.0 修正（V1 同款实现缺陷）：V1 用 `new Array(n)` 建结果数组，**空槽（hole）会被 `Array.prototype.some`
    //   跳过** → 服务端少返回几条时 `out.some(...)` 恒为 false，残缺结果被当成成功（`vectors` 里是 null/空槽）。
    //   现改为显式填 null 再校验，缺项一律判失败（调用方据此降级，绝不拿半份向量去打分）。
    const out = new Array(inputs.length).fill(null);
    data.forEach((d, i) => {
        const idx = Number.isInteger(d && d.index) ? d.index : i;
        if (idx >= 0 && idx < inputs.length && Array.isArray(d && d.embedding) && d.embedding.length) out[idx] = d.embedding.map(Number);
    });
    const missing = out.filter((x) => !Array.isArray(x) || !x.length).length;
    if (missing) {
        logVec({ action: 'embedding', ok: false, model: t.model, inputs: inputs.length, from: t.from, missing: missing, error: '返回不完整' });
        return { ok: false, vectors: [], error: 'Embedding 返回不完整（' + missing + '/' + inputs.length + ' 条缺失）' };
    }
    logVec({ action: 'embedding', ok: true, model: t.model, inputs: inputs.length, dims: out[0].length, from: t.from });
    return { ok: true, vectors: out, model: t.model, from: t.from, dims: out[0].length };
}

/**
 * Rerank 精排：把候选文档按与 query 的相关性重排（V1 只提供设置/测试，搜索路径未调用 —— 见 docs/P10v）。
 * 兼容两种常见返回：`{results:[{index, relevance_score}]}`（Cohere/Jina 系）与 `{data:[{index, score}]}`。
 * @param {string} query
 * @param {string[]} documents
 * @param {number} [topN]
 * @returns {Promise<{ok:boolean, order:number[], scores:number[], error?:string}>}
 */
export async function requestRerank(query, documents, topN) {
    const docs = (Array.isArray(documents) ? documents : []).map((d) => str(d));
    if (!docs.length) return { ok: true, order: [], scores: [] };
    const t = vectorTarget('rerank');
    if (!t.ok) return { ok: false, order: [], scores: [], error: t.error };
    const n = Math.max(1, Number(topN) || docs.length);
    const r = await fetchJson(rerankEndpoint(t.url), { model: t.model, query: str(query), documents: docs, top_n: n }, t.key);
    if (!r.ok) {
        logVec({ action: 'rerank', ok: false, model: t.model, docs: docs.length, error: String(r.error).slice(0, 120) });
        return { ok: false, order: [], scores: [], error: r.error };
    }
    const rows = Array.isArray(r.json && r.json.results) ? r.json.results : (Array.isArray(r.json && r.json.data) ? r.json.data : []);
    const scored = rows.map((x, i) => ({
        index: Number.isInteger(x && x.index) ? x.index : i,
        score: Number((x && (x.relevance_score != null ? x.relevance_score : x.score)) || 0),
    })).filter((x) => x.index >= 0 && x.index < docs.length).sort((a, b) => b.score - a.score);
    if (!scored.length) return { ok: false, order: [], scores: [], error: 'Rerank 返回为空或格式不可识别' };
    logVec({ action: 'rerank', ok: true, model: t.model, docs: docs.length, top: scored.length });
    return { ok: true, order: scored.map((x) => x.index), scores: scored.map((x) => x.score) };
}
