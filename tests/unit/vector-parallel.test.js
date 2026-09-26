// ============================================================
// 单元测试 · v2.79.0「Embedding / Rerank 严重错误 + 串行问题」修复
//
// 用户报告：「修复错误，Embedding、Rerank 设定存在严重错误、串行问题。」
// 逐个复现并修复的缺陷（每条都有对应断言）：
//   ① **串行**：库向量与关键词向量是两个互相独立的请求，此前串行等待（两次往返 = 2×RTT）；
//      现并行发出（同一时刻 2 个在途请求），失败语义不变。
//   ② **Rerank 白付**：此前先用余弦截到 TopN 再精排 → 精排只能重排这 TopN、无法改变入选集合；
//      现在精排前取更宽候选（`max(TopN×4, 20)`，受库大小限制），精排后截 TopN。
//   ③ **维度不一致静默失效**：换 Embedding 模型后旧缓存维度不同 → 余弦恒 0 → 召回静默全空；
//      现在把维度不符的条目视为未命中并**重新嵌入**（覆盖缓存），如实计数 `stats.dimMismatch`。
//   ④ **不完整返回被当成成功**（V1 同款实现缺陷）：`new Array(n)` 的空槽会被 `some` 跳过 →
//      服务端少返回几条也算成功，调用方拿到半份向量；现在缺项一律判失败。
//   ⑤ 超时：向量区块的「🧪 测试」按 `cfg.vectorTimeoutMs` 走（此前恒用默认 120s）。
// 运行：node tests/unit/vector-parallel.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg } from '../../core/config.js';
import { vecCacheGetMany, resetVectorCacheState, VEC_DB, VEC_STORE } from '../../adapters/vector-cache.js';
import { requestEmbeddings } from '../../host/embeddings.js';
import { vectorRecall } from '../../host/vector-recall.js';
import { apiAction, setApiPageHooks } from '../../ui/api-page.js';

const R = makeReporter('vector-parallel v2.79.0 向量层并行 / 精排候选 / 维度自愈');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
installGlobalHost(makeHost({}), doc);
setScopeKey('char:vector-parallel');
globalThis.window = Object.assign({}, globalThis.window, { localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true } });

const DIM = 4;
/** 造库：n 条情节 */
function seed(n) {
    setKernelState(emptyState());
    const atoms = [];
    for (let i = 0; i < n; i += 1) atoms.push({ id: 'a' + i, text: '事件' + i, date: '1919-11-0' + ((i % 9) + 1), floorStart: i, floorEnd: i, tags: [], validity: 'active', uses: 1 });
    state.atoms = atoms;
}

/**
 * 装一个「可观测并发」的 fetch 桩：记录最大并发、每个请求的开始/结束顺序、并按 dim 返回向量。
 * @returns {{calls:string[], maxActive:number, started:string[], order:string[], reqOf:Function}}
 */
function observFetch(opts) {
    const o = opts || {};
    const calls = [];
    let active = 0, maxActive = 0;
    const started = [];
    const order = [];
    const un = installGlobalFetch(async (url, req) => {
        const u = String(url);
        calls.push(u);
        active += 1; maxActive = Math.max(maxActive, active);
        started.push(u);
        let body = {};
        try { body = JSON.parse((req && req.body) || '{}'); } catch (e) { body = {}; }
        await new Promise((r) => setTimeout(r, Number(o.delayMs) || 15));
        active -= 1;
        order.push(u);
        if (u.indexOf('/rerank') >= 0) {
            const docs = Array.isArray(body.documents) ? body.documents : [];
            return { status: 200, body: { results: docs.map((d, i) => ({ index: i, relevance_score: 1 - i * 0.01 })) } };
        }
        const inputs = Array.isArray(body.input) ? body.input : [];
        const dim = Number(o.dim) > 0 ? Number(o.dim) : DIM;
        const rows = inputs.map((t, i) => ({ index: i, embedding: new Array(dim).fill(0.1).map((v, k) => v + (k === 0 ? i * 0.01 : 0)) }));
        if (o.dropLast && rows.length) rows.pop();                       // 模拟服务端少返回一条（不完整）
        return { status: 200, body: { data: rows } };
    });
    return { calls, started, order, un, get maxActive() { return maxActive; } };
}

function setupCfg() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.useVector = true;
    cfg.embeddingUrl = 'https://emb.example.com/v1';
    cfg.embeddingModel = 'emb-1';
    cfg.vectorMinScore = 0;
    cfg.vectorTopN = 2;
    cfg.rerankUrl = '';
    cfg.rerankModel = '';
    resetVectorCacheState();
}

(async function main() {
    console.log('\n[P1] 库向量与关键词向量**并行**发出（不再串行等待两次往返）');
    {
        setupCfg();
        seed(3);
        const f = observFetch({ dim: DIM, delayMs: 25 });
        const t0 = Date.now();
        const r = await vectorRecall(['关键词'], { topN: 2 });
        const ms = Date.now() - t0;
        f.un();
        await A('P1 同一时刻 2 个 embedding 在途（并行证据：maxActive=2，且两次请求都先于任一返回）', () => {
            const embStarts = f.calls.filter((u) => u.indexOf('/embeddings') >= 0).length;
            const firstDone = f.order[0];
            const bothBeforeFirstDone = f.started.filter((u) => u.indexOf('/embeddings') >= 0).length === 2 && f.started.indexOf(f.order[1]) < f.order.length;
            return embStarts === 2 && f.maxActive === 2 && !!firstDone && bothBeforeFirstDone;
        }, J({ calls: f.calls.length, maxActive: f.maxActive, started: f.started, order: f.order }));
        await A('P1 并行耗时接近**单次**往返（25ms 桩：并行 <45ms，串行必然 ≥50ms）', () => ms < 45 && r.stats.parallel === 2, J({ ms: ms, stats: r.stats }));
        await A('P1 stats 如实给出并行度与分段时间（embed / rerank / total）', () => r.stats.ms && Number(r.stats.ms.embed) >= 0 && Number(r.stats.ms.total) >= 0, J(r.stats.ms));
    }

    console.log('\n[P2] 并行不改变失败语义');
    {
        setupCfg();
        seed(2);
        const un = installGlobalFetch(async (url) => (String(url).indexOf('/embeddings') >= 0 ? { status: 500, text: 'boom' } : { status: 200, body: {} }));
        const r = await vectorRecall(['关键词'], { topN: 2 });
        un();
        await A('P2 库向量失败 → reason=embedding-failed（关键词成功也不放行）', () => r.ok === false && r.reason === 'embedding-failed', J({ reason: r.reason, error: r.error }));
    }

    console.log('\n[P3] Rerank 精排前取更宽候选（精排才能真正改变入选集合）');
    {
        setupCfg();
        seed(6);
        cfg.rerankUrl = 'https://rr.example.com/v1';
        cfg.rerankModel = 'rr-1';
        const f = observFetch({ dim: DIM, delayMs: 5 });
        const r = await vectorRecall(['关键词'], { topN: 2 });
        f.un();
        const rerankCall = f.calls.filter((u) => u.indexOf('/rerank') >= 0);
        await A('P3 精排候选 = max(TopN×4, 20) 受库大小限制 → 6 条（此前只有 TopN=2）',
            () => rerankCall.length === 1 && r.stats.rerankCandidates === 6 && r.stats.rerankKept === 2 && r.stats.reranked === true,
            J({ rerankCalls: rerankCall.length, stats: r.stats }));
    }
    {
        setupCfg();
        seed(30);
        cfg.rerankUrl = 'https://rr.example.com/v1';
        cfg.rerankModel = 'rr-1';
        const f = observFetch({ dim: DIM, delayMs: 1 });
        const r = await vectorRecall(['关键词'], { topN: 2 });
        f.un();
        await A('P3b 大库时候选收敛到 max(TopN×4, 20)=20（不会把整库送进精排）', () => r.stats.rerankCandidates === 20 && r.stats.rerankKept === 2, J(r.stats));
    }
    {
        setupCfg();
        seed(6);
        const f = observFetch({ dim: DIM, delayMs: 1 });
        const r = await vectorRecall(['关键词'], { topN: 2 });
        f.un();
        await A('P3c 未配置 Rerank → 一次精排请求都不发，候选即 TopN', () => f.calls.filter((u) => u.indexOf('/rerank') >= 0).length === 0
            && r.stats.rerankOn === false && r.stats.rerankCandidates === 2, J(r.stats));
    }

    console.log('\n[P4] 维度不一致自愈（换 Embedding 模型后不再静默召回为空）');
    {
        setupCfg();
        seed(3);
        // ① 先用 4 维建立缓存
        const f1 = observFetch({ dim: 4, delayMs: 1 });
        const r1 = await vectorRecall(['关键词'], { topN: 3 });
        f1.un();
        const before = await vecCacheGetMany(['atom:a0', 'atom:a1', 'atom:a2']);
        // ② 换成 8 维（模拟换模型）
        const f2 = observFetch({ dim: 8, delayMs: 1 });
        const r2 = await vectorRecall(['关键词'], { topN: 3 });
        f2.un();
        const after = await vecCacheGetMany(['atom:a0', 'atom:a1', 'atom:a2']);
        await A('P4 缓存里旧维度向量被重新嵌入覆盖为新维度（不再恒 0 分）',
            () => r1.stats.dims === 4 && r2.stats.dims === 8 && r2.stats.dimMismatch === 3 && r2.ok === true
                && (before.get('atom:a0') || []).length === 4 && (after.get('atom:a0') || []).length === 8,
            J({ r1d: r1.stats.dims, r2d: r2.stats.dims, mismatch: r2.stats.dimMismatch, before: (before.get('atom:a0') || []).length, after: (after.get('atom:a0') || []).length }));
        // ③ 重嵌失败 → 丢弃脏向量（宁可漏召回，不留脏向量）
        const f3 = observFetch({ dim: 4, delayMs: 1 });
        await vectorRecall(['关键词'], { topN: 3 });                    // 再切回 4 维（产生 3 条不匹配）
        f3.un();
        // 只让**库向量**那批失败（关键词批照常成功）→ 走到「重嵌失败 → 丢弃脏向量」分支
        const unFail = installGlobalFetch(async (url, req) => {
            let body = {};
            try { body = JSON.parse((req && req.body) || '{}'); } catch (e) { body = {}; }
            const inputs = Array.isArray(body.input) ? body.input : [];
            const isKeywordBatch = inputs.some((t) => String(t).indexOf('关键词') >= 0);   // 关键词批 vs 库批（库文本是「事件N」）
            if (String(url).indexOf('/embeddings') >= 0 && !isKeywordBatch) return { status: 500, text: 'down' };
            const dim = isKeywordBatch ? 8 : 4;                 // 关键词：8 维（与缓存 4 维不符 → 触发不匹配）
            return { status: 200, body: { data: inputs.map((t, i) => ({ index: i, embedding: new Array(dim).fill(0.2) })) } };
        });
        const r4 = await vectorRecall(['关键词'], { topN: 3 });
        unFail();
        const after4 = await vecCacheGetMany(['atom:a0', 'atom:a1', 'atom:a2']);
        await A('P4b 重嵌失败 → 丢弃旧维度向量（不留脏向量，也不再假装命中）',
            () => r4.stats.dimMismatch === 3 && r4.ok === false && after4.size === 0 && r4.reason === 'no-hit',
            J({ stats: r4.stats, cache: after4.size, reason: r4.reason }));
    }

    console.log('\n[P5] 不完整 embedding 返回必须失败（V1 空槽数组缺陷回归）');
    {
        setupCfg();
        seed(1);
        const f = observFetch({ dim: DIM, delayMs: 1, dropLast: true });
        const inc = await requestEmbeddings(['x', 'y', 'z']);
        f.un();
        await A('P5 3 条请求只回 2 条 → ok:false 且错误里如实给出缺项数（此前 ok:true 且带 null）',
            () => inc.ok === false && inc.vectors.length === 0 && String(inc.error).indexOf('1/3') > 0 && String(inc.error).indexOf('不完整') > 0,
            J(inc));
        const f2 = observFetch({ dim: DIM, delayMs: 1 });
        const ok = await requestEmbeddings(['x', 'y']);
        f2.un();
        await A('P5b 完整返回照常成功（维度与顺序不变）', () => ok.ok === true && ok.vectors.length === 2 && ok.vectors[0].length === DIM && ok.dims === DIM, J({ ok: ok.ok, dims: ok.dims }));
    }

    console.log('\n[P6] 向量区块「🧪 测试」按配置的超时走');
    {
        setupCfg();
        cfg.embeddingUrl = 'https://emb.example.com/v1';
        cfg.embeddingModel = 'emb-1';
        cfg.vectorTimeoutMs = 5000;
        let seenSignal = 'none';
        const un = installGlobalFetch(async (url, req) => {
            seenSignal = (req && req.signal) ? 'abortsignal' : 'none';
            return { status: 200, body: { data: [{ index: 0, embedding: [1, 2, 3, 4] }] } };
        });
        setApiPageHooks({ rerender: () => undefined });
        const t = await apiAction('apiTest', { apiPfx: 'emb', kind: 'embedding' });
        un();
        await A('P6 测试请求带 AbortController 信号（受 `cfg.vectorTimeoutMs` 约束）且结果可用',
            () => t.ok === true && seenSignal === 'abortsignal' && String(t.note).indexOf('可用') >= 0,
            J({ note: t.note, signal: seenSignal }));
    }

    R.done();
})().catch((e) => { console.error('❌ vector-parallel.test.js 异常中断:', e); process.exit(1); });
