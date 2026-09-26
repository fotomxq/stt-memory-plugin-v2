// ============================================================
// host/vector-recall.js —— **第一层：向量检索编排**（v2.58.0，对齐 V1 v1.206 `vectorSearchMemory`）
//
// 流程（V1 同序）：候选库（6 类）→ 向量缓存（IndexedDB）取回 → 缺的批量请求 embedding → 写缓存 →
//   关键词（前 5）embedding → 逐维均值 = 查询向量 → 余弦打分 → TopN →（V2 新增）Rerank 精排 →
//   注入行（`core/recall.js#vectorInjectionLines`）。
// 约定：任何一步失败都**返回原因并让调用方降级**（不抛异常）；未启用 → `reason='disabled'`。
// ============================================================
import { state, cfg } from '../core/model/runtime.js';
import { vectorBank, embedTextOf, missingVectorEntries, rankVector, meanVector } from '../core/vector.js';
import { vectorInjectionLines } from '../core/recall.js';
import { vecCacheGetMany, vecCachePutMany, vectorCacheStats } from '../adapters/vector-cache.js';
import { requestEmbeddings, requestRerank, vectorTarget } from './embeddings.js';

/**
 * 执行一次向量召回。
 * @param {string[]} keywords 检索关键词（V1：`jsExtractKeywords()` 或 AI 关键词）
 * @param {{topN?:number, minScore?:number, rerank?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, lines:string[], count:number, keywords:string[], reason?:string, ms:number, stats?:object}>}
 */
export async function vectorRecall(keywords, opts) {
    const t0 = Date.now();
    const o = opts || {};
    const kws = (Array.isArray(keywords) ? keywords : []).map((k) => String(k == null ? '' : k).trim()).filter(Boolean);
    if (cfg.useVector !== true) return { ok: false, lines: [], count: 0, keywords: kws, reason: 'disabled', ms: 0 };
    if (!kws.length) return { ok: false, lines: [], count: 0, keywords: [], reason: 'no-keywords', ms: 0 };
    const emb = vectorTarget('embedding');
    if (!emb.ok) return { ok: false, lines: [], count: 0, keywords: kws, reason: 'not-configured', error: emb.error, ms: Date.now() - t0 };

    const bank = vectorBank(state);
    if (!bank.length) return { ok: false, lines: [], count: 0, keywords: kws, reason: 'empty-bank', ms: Date.now() - t0 };

    // ① 缓存命中
    const cached = await vecCacheGetMany(bank.map((b) => b.key));
    const need = missingVectorEntries(bank, cached);
    let cachedWrites = 0;
    if (need.length) {
        const r = await requestEmbeddings(need.map(embedTextOf));
        if (!r.ok) return { ok: false, lines: [], count: 0, keywords: kws, reason: 'embedding-failed', error: r.error, ms: Date.now() - t0 };
        const puts = need.map((b, i) => ({ key: b.key, vector: r.vectors[i] })).filter((x) => Array.isArray(x.vector) && x.vector.length);
        await vecCachePutMany(puts);
        cachedWrites = puts.length;
        puts.forEach((x) => cached.set(x.key, x.vector));
    }
    // ② 关键词向量（V1：前 5 个取均值）
    const kwRes = await requestEmbeddings(kws.slice(0, 5));
    if (!kwRes.ok || !kwRes.vectors.length) {
        return { ok: false, lines: [], count: 0, keywords: kws, reason: 'keyword-embedding-failed', error: kwRes.error || '关键词向量为空', ms: Date.now() - t0 };
    }
    const queryVec = meanVector(kwRes.vectors);
    const topN = Math.max(1, Number(o.topN) || Number(cfg.vectorTopN) || 5);
    const minScore = Number.isFinite(Number(o.minScore)) ? Number(o.minScore) : (Number(cfg.vectorMinScore) || 0);

    // ③ 打分 + TopN
    let ranked = rankVector(bank, { vectors: cached, queryVec, topN, minScore });

    // ④ Rerank 精排（仅当配置了 Rerank API；V1 未在搜索路径调用，V2 生效 —— 见 docs/P10v）
    let reranked = false;
    const rerankOn = o.rerank !== false && vectorTarget('rerank').ok && ranked.length > 1;
    if (rerankOn) {
        const q = kws.join(' ');
        const docs = ranked.map((x) => String((x.entry && x.entry.text) || '').slice(0, 300));
        const rr = await requestRerank(q, docs, Math.min(topN, docs.length));
        if (rr.ok && rr.order.length) {
            const byIdx = new Map(ranked.map((x, i) => [i, x]));
            const next = [];
            for (const i of rr.order) { const hit = byIdx.get(i); if (hit && next.indexOf(hit) < 0) next.push(hit); }
            ranked.forEach((x) => { if (next.indexOf(x) < 0) next.push(x); });
            ranked = next.slice(0, topN);
            reranked = true;
        }
    }
    const lines = vectorInjectionLines(ranked);
    return {
        ok: lines.length > 0,
        lines: lines,
        count: lines.length,
        keywords: kws,
        reason: lines.length ? '' : 'no-hit',
        ms: Date.now() - t0,
        stats: { bank: bank.length, cached: cached.size, embedded: cachedWrites, dims: queryVec.length, reranked: reranked, rerankOn: rerankOn, topN: topN, minScore: minScore, cache: vectorCacheStats() },
    };
}

/** 只读诊断（设置页/总览用）：向量层是否可用、候选库规模、缓存规模 */
export function vectorLayerStatus() {
    let bank = 0;
    try { bank = vectorBank(state).length; } catch (e) { bank = 0; }
    return { useVector: cfg.useVector === true, bank: bank, cache: vectorCacheStats(), embedding: vectorTarget('embedding'), rerank: vectorTarget('rerank') };
}
