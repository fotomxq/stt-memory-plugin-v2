// ============================================================
// host/vector-recall.js —— **第一层：向量检索编排**（v2.58.0，对齐 V1 v1.206 `vectorSearchMemory`）
//
// 流程：候选库（6 类）→ 向量缓存（IndexedDB）取回 → 缺的批量请求 embedding → 写缓存 →
//   关键词（前 5）embedding → 逐维均值 = 查询向量 → 余弦打分 → TopN →（V2 新增）Rerank 精排 →
//   注入行（`core/recall.js#vectorInjectionLines`）。
// 约定：任何一步失败都**返回原因并让调用方降级**（不抛异常）；未启用 → `reason='disabled'`。
//
// v2.79.0 修正（用户报告「Embedding、Rerank 设定存在严重错误、串行问题」）：
//   ① **并行**：库向量与关键词向量是两个**互相独立**的请求，此前串行等待（两次 30ms 往返 = 63ms）；
//      现用 `Promise.all` 同时发出（同一时刻 2 个在途请求）。失败语义不变（先判库、再判关键词）。
//   ② **Rerank 真正生效**：此前先用余弦截到 TopN 再精排 → 精排只能重排这 TopN，**无法改变入选集合**
//      （白付一次 API 调用）。现在精排前先取更宽的候选（`max(TopN×4, 20)`，受库大小限制），精排后再截 TopN。
//   ③ **维度不一致自愈**：换了 Embedding 模型（维度变化）后，旧缓存向量与查询向量维度不符 →
//      `cosineSimilarity` 恒为 0 → 召回**静默全空**。现在把维度不符的缓存条目视为未命中并**重新嵌入**
//      （成功即覆盖缓存；失败则从缓存**真删**，避免每次召回重试一次注定失败的比对），
//      并在 `stats.dimMismatch` 里如实计数。
//   ④ `stats.ms` 拆分（embed / rerank）与 `stats.parallel`，便于诊断「慢在哪儿」。
// ============================================================
import { state, cfg } from '../core/model/runtime.js';
import { vectorBank, embedTextOf, missingVectorEntries, rankVector, meanVector } from '../core/vector.js';
import { vectorInjectionLines } from '../core/recall.js';
import { vecCacheGetMany, vecCachePutMany, vecCacheDeleteMany, vectorCacheStats } from '../adapters/vector-cache.js';
import { requestEmbeddings, requestRerank, vectorTarget } from './embeddings.js';
import { debugLogPush } from '../adapters/debug-log.js';

/** 调试日志（维度自愈等；关闭调试时不写） */
function logRekey(data) { try { debugLogPush('向量', data); } catch (e) { /* 忽略 */ } }

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

    // ② 库向量与关键词向量**并行**发出（互相独立；同一时刻最多 2 个在途请求）
    const embedT0 = Date.now();
    const [bankRes, kwRes] = await Promise.all([
        need.length ? requestEmbeddings(need.map(embedTextOf)) : Promise.resolve({ ok: true, vectors: [] }),
        requestEmbeddings(kws.slice(0, 5)),
    ]);
    const embedMs = Date.now() - embedT0;
    if (need.length) {
        if (!bankRes.ok) return { ok: false, lines: [], count: 0, keywords: kws, reason: 'embedding-failed', error: bankRes.error, ms: Date.now() - t0 };
        const puts = need.map((b, i) => ({ key: b.key, vector: bankRes.vectors[i] })).filter((x) => Array.isArray(x.vector) && x.vector.length);
        await vecCachePutMany(puts);
        puts.forEach((x) => cached.set(x.key, x.vector));
    }
    const cachedWrites = need.length ? need.filter((b) => { const v = cached.get(b.key); return Array.isArray(v) && v.length; }).length : 0;
    if (!kwRes.ok || !kwRes.vectors.length) {
        return { ok: false, lines: [], count: 0, keywords: kws, reason: 'keyword-embedding-failed', error: kwRes.error || '关键词向量为空', ms: Date.now() - t0, stats: { embedMs: embedMs } };
    }
    const queryVec = meanVector(kwRes.vectors);
    const topN = Math.max(1, Number(o.topN) || Number(cfg.vectorTopN) || 5);
    const minScore = Number.isFinite(Number(o.minScore)) ? Number(o.minScore) : (Number(cfg.vectorMinScore) || 0);

    // ③ 维度不一致自愈：换了 Embedding 模型后旧缓存维度不同 → 余弦恒 0（静默召回为空）→ 重新嵌入覆盖缓存
    let dimMismatch = 0;
    if (queryVec.length) {
        const stale = bank.filter((b) => { const v = cached.get(b.key); return Array.isArray(v) && v.length && v.length !== queryVec.length; });
        if (stale.length) {
            dimMismatch = stale.length;
            const re = await requestEmbeddings(stale.map(embedTextOf));
            if (re.ok) {
                const puts2 = stale.map((b, i) => ({ key: b.key, vector: re.vectors[i] })).filter((x) => Array.isArray(x.vector) && x.vector.length);
                await vecCachePutMany(puts2);
                puts2.forEach((x) => cached.set(x.key, x.vector));
            } else {
                stale.forEach((b) => cached.delete(b.key));      // 本地视图丢弃
                await vecCacheDeleteMany(stale.map((b) => b.key));   // **持久层也真删**：宁可漏召回，不留脏向量
            }
            try { logRekey({ action: 'dim-mismatch', mismatched: dimMismatch, dims: queryVec.length, healed: re.ok === true }); } catch (e) { /* 忽略 */ }
        }
    }

    // ④ 打分 + 候选（配置了 Rerank 时取更宽候选，精排后截 TopN）
    const rerankOn = o.rerank !== false && vectorTarget('rerank').ok;
    const candN = rerankOn ? Math.min(Math.max(bank.length, 1), Math.max(topN * 4, 20)) : topN;
    let ranked = rankVector(bank, { vectors: cached, queryVec, topN: candN, minScore });
    const candCount = ranked.length;          // 精排候选数（精排后会被截到 TopN）

    // ⑤ Rerank 精排（仅当配置了 Rerank API；V1 未在搜索路径调用，V2 生效 —— 见 docs/P10v）
    let reranked = false;
    let rerankMs = 0;
    if (rerankOn && ranked.length > 1) {
        const q = kws.join(' ');
        const docs = ranked.map((x) => String((x.entry && x.entry.text) || '').slice(0, 300));
        const rrT0 = Date.now();
        const rr = await requestRerank(q, docs, Math.min(topN, docs.length));
        rerankMs = Date.now() - rrT0;
        if (rr.ok && rr.order.length) {
            const byIdx = new Map(ranked.map((x, i) => [i, x]));
            const next = [];
            for (const i of rr.order) { const hit = byIdx.get(i); if (hit && next.indexOf(hit) < 0) next.push(hit); }
            ranked.forEach((x) => { if (next.indexOf(x) < 0) next.push(x); });
            ranked = next.slice(0, topN);
            reranked = true;
        }
    } else {
        ranked = ranked.slice(0, topN);
    }
    const lines = vectorInjectionLines(ranked);
    return {
        ok: lines.length > 0,
        lines: lines,
        count: lines.length,
        keywords: kws,
        reason: lines.length ? '' : 'no-hit',
        ms: Date.now() - t0,
        stats: {
            bank: bank.length, cached: cached.size, embedded: cachedWrites, dims: queryVec.length,
            reranked: reranked, rerankOn: rerankOn, rerankCandidates: candCount, rerankKept: ranked.length, topN: topN, minScore: minScore,
            dimMismatch: dimMismatch, parallel: need.length ? 2 : 1, ms: { embed: embedMs, rerank: rerankMs, total: Date.now() - t0 },
            cache: vectorCacheStats(),
        },
    };
}

/** 只读诊断（设置页/总览用）：向量层是否可用、候选库规模、缓存规模 */
export function vectorLayerStatus() {
    let bank = 0;
    try { bank = vectorBank(state).length; } catch (e) { bank = 0; }
    return { useVector: cfg.useVector === true, bank: bank, cache: vectorCacheStats(), embedding: vectorTarget('embedding'), rerank: vectorTarget('rerank') };
}
