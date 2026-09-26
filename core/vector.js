// ============================================================
// core/vector.js —— **向量检索层的纯逻辑**（v2.58.0，逐条对齐 V1 v1.206）
//
// V1 出处：`src/FTT记忆组件-v1.206.js`
//   · `cosineSimilarity(a,b)` 约 12494~12501（长度不等 → 0；零模长 → 0）
//   · `vectorSearchMemory(keywords, topN)` 约 12504~12569 的**候选库构造与打分**部分：
//       候选库 6 类：情节（`activeAtoms()`）/ 记忆 / 状态 / 角色档案 / 概念 / 平行事件，
//       每条文本按下述字段拼接后取前 300 字（V1 `b.text.slice(0, 300)`）；
//       查询向量 = 前 5 个关键词各自 embedding 的**逐维均值**；
//       打分 = 余弦相似度；V1 口径 `score > 0` 过滤，取 TopN。
//   · 本模块**不做任何网络/存储**（内核纯净度要求）：embedding 请求在 `host/embeddings.js`，
//     向量缓存（IndexedDB，V1 同名库 `FTTMemoryVectorCache` / 表 `embeddings`）在 `adapters/vector-cache.js`，
//     注入行格式化在 `core/recall.js#vectorInjectionLines`，编排在 `host/vector-recall.js`。
// ============================================================
import { activeAtoms } from './merge.js';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const join = (v) => arr(v).map((x) => str(x)).filter(Boolean).join(' ');

/** V1 `cosineSimilarity`（逐字）：长度不一致/空/零模长 → 0 */
export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 查询向量：V1 取前 5 个关键词的 embedding 做**逐维均值**（空 → []）。
 * @param {Array<Array<number>>} vecs
 * @returns {number[]}
 */
export function meanVector(vecs) {
    const list = arr(vecs).filter((v) => Array.isArray(v) && v.length);
    if (!list.length) return [];
    const dim = list[0].length;
    const out = new Array(dim).fill(0);
    for (const v of list) for (let i = 0; i < dim; i++) out[i] += Number(v[i]) || 0;
    return out.map((x) => x / list.length);
}

/**
 * 候选库（V1 `vectorSearchMemory` 内的 bank 构造，逐字口径 + 每个条目的 embedding 文本）。
 * @param {object} st 内核 state
 * @returns {Array<{key:string, kind:string, text:string, item:object}>}
 */
export function vectorBank(st) {
    const s = st || {};
    const bank = [];
    activeAtoms().slice().forEach((a) => bank.push({ key: 'atom:' + a.id, kind: 'atoms', item: a, text: `${str(a.text)} ${join(a.keywords)} ${join(a.locations)}` }));
    arr(s.memories).slice().forEach((m) => bank.push({ key: 'mem:' + m.id, kind: 'memories', item: m, text: `${str(m.title)} ${str(m.content)} ${join(m.keywords)}` }));
    arr(s.currentStates).slice().forEach((x) => bank.push({ key: 'state:' + x.id, kind: 'states', item: x, text: `${str(x.subject)} ${str(x.field)} ${str(x.value)}` }));
    arr(s.snapshots).slice().forEach((x) => bank.push({ key: 'snap:' + x.id, kind: 'snapshots', item: x, text: `${str(x.name)} ${str((x.identity || {}).occupation)} ${join((x.personality || {}).traits)}` }));
    arr(s.concepts).slice().forEach((x) => bank.push({ key: 'con:' + x.id, kind: 'concepts', item: x, text: `${str(x.name)} ${str(x.content)} ${str(x.source)} ${join(x.keywords)}` }));
    arr(s.parallels).slice().forEach((x) => bank.push({ key: 'par:' + x.id, kind: 'parallels', item: x, text: `${str(x.title)} ${str(x.text)} ${join(x.tags)} ${join(x.characters)}` }));
    return bank;
}

/** 单个条目的 embedding 输入文本（V1：`b.text.slice(0, 300)`） */
export function embedTextOf(entry) { return str(entry && entry.text).slice(0, 300); }

/**
 * 打分与排序（V1 口径）：逐条余弦相似度 → 过滤 `> minScore` → 降序 → 取 TopN。
 * V1 只用 `> 0`；V2 用 `cfg.vectorMinScore`（默认 0.35，V1 亦有该键但未参与过滤 —— 见 docs/P10v 偏差表）。
 * @param {Array} bank `vectorBank()` 结果
 * @param {{vectors?:Map<string,number[]>, queryVec?:number[], topN?:number, minScore?:number}} opts
 * @returns {Array<{entry:object, score:number}>}
 */
export function rankVector(bank, opts) {
    const o = opts || {};
    const vectors = o.vectors instanceof Map ? o.vectors : new Map();
    const q = Array.isArray(o.queryVec) ? o.queryVec : [];
    const topN = Math.max(1, Number(o.topN) || 5);
    const min = Number.isFinite(Number(o.minScore)) ? Number(o.minScore) : 0;
    if (!q.length) return [];
    const scored = arr(bank)
        .map((entry) => ({ entry, score: cosineSimilarity(q, vectors.get(entry.key) || []) }))
        .filter((x) => x.score > min)
        .sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
}

/** 需要请求 embedding 的条目（缓存未命中的那些） */
export function missingVectorEntries(bank, vectors) {
    const v = vectors instanceof Map ? vectors : new Map();
    return arr(bank).filter((e) => !v.has(e.key));
}
