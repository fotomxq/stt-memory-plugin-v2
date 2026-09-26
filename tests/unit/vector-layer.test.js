// ============================================================
// 单元测试 · v2.58.0「提取记忆：向量 API 设置与 V1 对齐 + 向量层落地」
//
// 用户报告：「提取信息的向量 API 设置在哪里？这些内容与 V1 完全没对齐，请核对并修复。」
// 核对（V1 v1.206 extract 页 约 25630~25675）与落地对照：
//   · V1 `useVector` / `jsExtractEnabled` / `useKeywordFlow` 三层开关 + 各层「🧪 测试」；
//   · V1 Embedding API 区块（`embeddingUrl/Key/Model/ProxyPreset`）与 Rerank API 区块（`rerankUrl/Key/Model/ProxyPreset`）
//     + 「检索参数」`vectorTopN/vectorMinScore/vectorTimeoutMs`；
//   · V1 `vectorSearchMemory`：候选库 6 类 → IndexedDB 向量缓存（库 `FTTMemoryVectorCache` / 表 `embeddings`）
//     → embedding → 关键词均值查询向量 → 余弦 TopN → 注入行（情节按剧情时间从早到晚）；
//   · V1 `extractKeywordsFromText`（keywordExtract 模板 + kw API）、`analyzeMemorySend`（memorySend 模板 + mem API）。
// 覆盖：V 向量纯逻辑（余弦/均值/候选库/打分）｜C 缓存（内存回退 + 键结构）｜E embedding/rerank 请求与降级
//   ｜F 三层流程编排（命中即返回 + 降级）｜U 提取页 UI（三层结构 / Embedding / Rerank / 检索参数 / kw·mem 分组 / 测试按钮）
//   ｜A 面板动作（apiTest(emb/rerank) / testLayer / vectorCacheClear）。
// 运行：node tests/unit/vector-layer.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg } from '../../core/config.js';
import { vectorBank, rankVector, meanVector, cosineSimilarity, embedTextOf, missingVectorEntries } from '../../core/vector.js';
import { vectorInjectionLines } from '../../core/recall.js';
import { vecCacheGetMany, vecCachePutMany, vectorCacheClear, vectorCacheStats, resetVectorCacheState, VEC_DB, VEC_STORE } from '../../adapters/vector-cache.js';
import { requestEmbeddings, requestRerank, vectorTarget, vectorLayerInfo } from '../../host/embeddings.js';
import { vectorRecall, vectorLayerStatus } from '../../host/vector-recall.js';
import { runExtractFlow, testLayer } from '../../host/extract-flow.js';
import { extractPageHtml, layerTestResults, vectorTestResults } from '../../ui/extract-page.js';
import { settingsPageHtml, SETTINGS_CONTROLS, settingsControlHtml } from '../../ui/settings-pages.js';
import { apiAction, API_ACTIONS, setApiPageHooks } from '../../ui/api-page.js';

const R = makeReporter('vector-layer v2.58.0 提取记忆：向量 API 设置与 V1 对齐 + 向量层');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
installGlobalHost(makeHost({}), doc);
setKernelState(emptyState());
setScopeKey('char:vector-test');
globalThis.window = Object.assign({}, globalThis.window, { localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true } });
resetVectorCacheState();

const clone = (o) => JSON.parse(JSON.stringify(o));
/** 造一份小记忆库：2 条情节（日期不同）、1 记忆、1 状态、1 角色档案、1 概念 */
function seedState() {
    setKernelState(emptyState());
    state.atoms = [
        { id: 'a-late', text: '甲在码头发现木箱。', date: '1919-11-29', floorStart: 9, floorEnd: 9, uses: 1, tags: [], keywords: ['木箱'], locations: ['码头'], validity: 'active' },
        { id: 'a-early', text: '甲离开凉州。', date: '1919-11-01', floorStart: 3, floorEnd: 3, uses: 1, tags: [], validity: 'active' },
    ];
    state.memories = [{ id: 'm1', owner: '甲', title: '木箱', content: '断口整齐。', date: '1919-11-29', uses: 1, tags: [] }];
    state.currentStates = [{ id: 's1', subject: '甲', field: '处境', value: '在码头', uses: 1 }];
    state.snapshots = [{ id: 'sn1', name: '甲', identity: { occupation: '商人' }, personality: { traits: ['谨慎'] }, uses: 1 }];
    state.concepts = [{ id: 'c1', name: '天机阁', content: '情报机构', date: '1919-10-01', source: '传闻', uses: 1 }];
    state.parallels = [{ id: 'p1', title: '另一条路', text: '乙独自返京。', tags: ['乙'], characters: ['乙'], uses: 1 }];
}

// ---- V 组：向量纯逻辑（V1 口径） ----
A('V1 cosineSimilarity：同向=1、正交=0、长度不等/零模长=0（V1 逐字）', (() => {
    return cosineSimilarity([1, 0], [1, 0]) === 1 && cosineSimilarity([1, 0], [0, 1]) === 0
        && cosineSimilarity([1, 0], [1, 0, 0]) === 0 && cosineSimilarity([0, 0], [1, 1]) === 0
        && cosineSimilarity(null, [1]) === 0;
})(), J(['cos']));

A('V2 meanVector：逐维均值；空 → []', (() => {
    return J(meanVector([[2, 4], [4, 8]])) === J([3, 6]) && J(meanVector([])) === J([]) && J(meanVector([[]])) === J([]);
})(), J(meanVector([[2, 4], [4, 8]])));

A('V3 vectorBank：6 类候选与 V1 同键同文本（atom/mem/state/snap/con/par）', (() => {
    seedState();
    const bank = vectorBank(state);
    const keys = bank.map((b) => b.key);
    const atom = bank.filter((b) => b.key === 'atom:a-late')[0];
    const mem = bank.filter((b) => b.key === 'mem:m1')[0];
    const con = bank.filter((b) => b.key === 'con:c1')[0];
    const par = bank.filter((b) => b.key === 'par:p1')[0];
    return bank.length === 7 && J(keys) === J(['atom:a-late', 'atom:a-early', 'mem:m1', 'state:s1', 'snap:sn1', 'con:c1', 'par:p1'])
        && atom.text === '甲在码头发现木箱。 木箱 码头' && mem.text === '木箱 断口整齐。 '
        && con.text === '天机阁 情报机构 传闻 ' && par.text === '另一条路 乙独自返京。 乙 乙'
        && embedTextOf({ text: 'x'.repeat(400) }).length === 300;
})(), J(vectorBank(state).map((b) => b.key)));

A('V4 rankVector：余弦降序 + TopN + minScore 过滤（V1 用 >0，V2 用 cfg.vectorMinScore）', (() => {
    const bank = [{ key: 'k1', kind: 'x', item: {}, text: 'a' }, { key: 'k2', kind: 'x', item: {}, text: 'b' }, { key: 'k3', kind: 'x', item: {}, text: 'c' }];
    const vectors = new Map([['k1', [1, 0]], ['k2', [0.8, 0.2]], ['k3', [1, 0.9]]]);
    const q = [1, 0];
    const all = rankVector(bank, { vectors, queryVec: q, topN: 5, minScore: 0 });
    const top1 = rankVector(bank, { vectors, queryVec: q, topN: 1, minScore: 0 });
    const filtered = rankVector(bank, { vectors, queryVec: q, topN: 5, minScore: 0.99 });
    return all.length === 3 && all[0].entry.key === 'k1' && top1.length === 1 && top1[0].entry.key === 'k1'
        && filtered.every((x) => x.score > 0.99)
        && missingVectorEntries(bank, new Map([['k1', [1]]])).map((b) => b.key).join(',') === 'k2,k3';
})(), '见断言');

A('V5 vectorInjectionLines：六类行格式与 V1 一致；情节行按剧情时间从早到晚（相似度不决定顺序）', (() => {
    seedState();
    // 故意让「晚」的情节相似度更高（排前面）—— 输出仍须 早期 → 晚期
    const ranked = [
        { entry: { kind: 'atoms', item: state.atoms[0] }, score: 0.9 },
        { entry: { kind: 'atoms', item: state.atoms[1] }, score: 0.5 },
        { entry: { kind: 'memories', item: state.memories[0] }, score: 0.4 },
        { entry: { kind: 'states', item: state.currentStates[0] }, score: 0.3 },
        { entry: { kind: 'snapshots', item: state.snapshots[0] }, score: 0.2 },
        { entry: { kind: 'concepts', item: state.concepts[0] }, score: 0.1 },
        { entry: { kind: 'parallels', item: state.parallels[0] }, score: 0.05 },
    ];
    const lines = vectorInjectionLines(ranked);
    return lines.length === 7
        && lines[0].indexOf('甲离开凉州。') >= 0 && lines[0].indexOf('[1919-11-01') === 0 + lines[0].indexOf('[1919-11-01')
        && lines[1].indexOf('甲在码头发现木箱。') >= 0
        && lines[2].indexOf('- （甲）') === 0 && lines[2].indexOf('木箱：断口整齐。') >= 0
        && lines[3] === '- 甲·处境: 在码头'
        && lines[4] === '- 甲（商人）'
        && lines[5].indexOf('- 天机阁') === 0
        && lines[6].indexOf('- ') === 0 && lines[6].indexOf('另一条路') >= 0;
})(), J(vectorInjectionLines([{ entry: { kind: 'atoms', item: { id: 'x', text: 't', date: '1919-01-01' } }, score: 1 }])));

// ---- C 组：向量缓存（V1 同名库/表；无 IndexedDB → 内存回退） ----
await (async () => {
    resetVectorCacheState();
    const put = await vecCachePutMany([{ key: 'atom:a1', vector: [1, 2, 3] }, { key: 'mem:m1', vector: [0, 1] }]);
    const got = await vecCacheGetMany(['atom:a1', 'mem:m1', 'nope']);
    A('C1 缓存写读往返：键结构 `类别:id`（与 V1 同库 FTTMemoryVectorCache/embeddings）；无 IndexedDB 时内存回退', put === false
        && got.size === 2 && J(got.get('atom:a1')) === J([1, 2, 3]) && got.has('nope') === false
        && VEC_DB === 'FTTMemoryVectorCache' && VEC_STORE === 'embeddings'
        && vectorCacheStats().memory === 2 && vectorCacheStats().indexedDb === false,
        J({ put, stats: vectorCacheStats() }));
    const cleared = await vectorCacheClear();
    A('C2 清空缓存：内存归零并如实回报通道', cleared.ok === true && cleared.via === 'memory'
        && vectorCacheStats().memory === 0 && (await vecCacheGetMany(['atom:a1'])).size === 0,
        J(cleared));
})();

// ---- E 组：Embedding / Rerank 请求 ----
await (async () => {
    const calls = [];
    const un = installGlobalFetch((url, opts) => {
        calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null, headers: (opts && opts.headers) || {} });
        if (String(url).indexOf('/rerank') >= 0) return { status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] } };
        return { status: 200, body: { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] } };
    });
    try {
        cfg.useVector = false;
        const off = await requestEmbeddings(['a']);
        cfg.useVector = true;
        cfg.embeddingUrl = 'https://api.example.com/v1';
        cfg.embeddingKey = 'k-1';
        cfg.embeddingModel = 'emb-1';
        cfg.rerankUrl = 'https://api.example.com/v1';
        cfg.rerankModel = 'rr-1';
        const a = vectorTarget('embedding');
        const r = await requestEmbeddings(['甲', '乙']);
        const rr = await requestRerank('甲', ['doc0', 'doc1'], 2);
        const hit = calls.filter((x) => x.url.indexOf('/embeddings') >= 0)[0];
        A('E1 未启用向量检索 → 直接拒绝（不静默请求）', off.ok === false && off.error === '向量检索未启用', J(off));
        A('E2 Embedding 请求：端点拼 `/embeddings`、Bearer 鉴权、体 `{model, input}`、按 index 归位', r.ok === true
            && J(r.vectors) === J([[1, 0], [0, 1]]) && !!hit && hit.url === 'https://api.example.com/v1/embeddings'
            && hit.headers.Authorization === 'Bearer k-1' && hit.body.model === 'emb-1' && J(hit.body.input) === J(['甲', '乙'])
            && r.dims === 2 && a.ok === true && a.from === 'inline',
            J({ ok: r.ok, dims: r.dims, url: hit && hit.url }));
        A('E3 Rerank 请求：体 `{model, query, documents, top_n}`、返回按分数降序的索引', rr.ok === true
            && J(rr.order) === J([1, 0]) && J(rr.scores) === J([0.9, 0.2]),
            J(rr));
        A('E4 代理预设（V2 = 本插件 API 分组）：地址为空 + 分组 → 用分组地址；分组缺失 → 如实报错', (async () => {
            cfg.embeddingUrl = '';
            cfg.apiPresets = { 'emb-group': { apiUrl: 'https://group.example.com/v1', apiKey: 'g-1', model: 'emb-g' } };
            cfg.embeddingProxyPreset = 'emb-group';
            const t1 = vectorTarget('embedding');
            cfg.embeddingProxyPreset = 'missing-group';
            const t2 = vectorTarget('embedding');
            return t1.ok === true && t1.url === 'https://group.example.com/v1' && t1.key === 'g-1' && t1.from === 'preset'
                && t2.ok === false && String(t2.error).indexOf('missing-group') >= 0 && t2.error.indexOf('缺少地址') >= 0;
        })(), '见断言');
        A('E5 返回不完整（缺 embedding）如实判失败，不伪造向量', (async () => {
            const keep = globalThis.fetch;
            globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1] }] }) });
            const bad = await requestEmbeddings(['a', 'b']);
            globalThis.fetch = keep;
            return bad.ok === false && bad.error === 'Embedding 返回不完整' && bad.vectors.length === 0;
        })(), '见断言');
    } finally { un(); }
})();

// ---- F 组：三层流程编排 ----
await (async () => {
    resetVectorCacheState();
    cfg.useVector = true; cfg.jsExtractEnabled = true; cfg.useKeywordFlow = false;
    cfg.embeddingUrl = 'https://api.example.com/v1'; cfg.embeddingKey = ''; cfg.embeddingModel = 'emb-1';
    cfg.rerankUrl = ''; cfg.rerankModel = ''; cfg.vectorTopN = 5; cfg.vectorMinScore = 0; cfg.vectorTimeoutMs = 5000;
    seedState();
    const un = installGlobalFetch((url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        const inputs = Array.isArray(body.input) ? body.input : [];
        // 极简「向量」：把输入映射成 2 维（含「木箱/码头」→ 第一维高）
        return { status: 200, body: { data: inputs.map((t, i) => ({ index: i, embedding: /木箱|码头/.test(t) ? [1, 0] : [0, 1] })) } };
    });
    try {
        const r = await vectorRecall(['木箱']);
        A('F1 向量召回端到端：候选库取向量 → 关键词均值 → 余弦 TopN → 注入行（情节/记忆等）', r.ok === true
            && r.count >= 1 && r.lines.join('\n').indexOf('木箱') >= 0
            && r.stats.bank === 7 && r.stats.dims === 2 && r.stats.cached >= 0,
            J({ ok: r.ok, count: r.count, reason: r.reason, stats: r.stats }));

        const flow = await runExtractFlow('甲在码头发现木箱，断口整齐。', { queryText: '木箱' });
        A('F2 三层流程：向量层命中即返回（hitLayer=vector），并记录追踪', flow.ok === true && flow.hitLayer === 'vector'
            && flow.lines.length >= 1 && flow.trace.some((t) => t.layer === 'vector' && t.ok === true),
            J({ hit: flow.hitLayer, trace: flow.trace }));

        cfg.useVector = false;
        const flow2 = await runExtractFlow('甲在码头发现木箱，断口整齐。', { queryText: '木箱' });
        A('F3 关闭向量层 → 降级到第二层（JS 抽取/本地召回）且不请求 embedding', flow2.ok === true && flow2.hitLayer === 'js'
            && flow2.trace.some((t) => t.layer === 'js' && t.ok === true),
            J({ hit: flow2.hitLayer, trace: flow2.trace }));

        cfg.useVector = true;
        cfg.embeddingUrl = '';
        const flow3 = await runExtractFlow('甲在码头发现木箱。', { queryText: '木箱' });
        A('F4 向量层未配置 → 自动降级（不抛错、不阻塞）', flow3.ok === true && flow3.hitLayer === 'js', J({ hit: flow3.hitLayer }));

        cfg.embeddingUrl = 'https://api.example.com/v1';
        const tv = await testLayer('vector', '甲在码头发现木箱。');
        A('F5 单层测试 testLayer(vector)：真实跑一层并回报命中数/关键词/预览', tv.ok === true && tv.count >= 1
            && tv.lines.length >= 1 && String(tv.note).indexOf('命中') >= 0,
            J({ ok: tv.ok, count: tv.count, note: tv.note }));
        cfg.useVector = false;
        const tv2 = await testLayer('vector', 'x');
        A('F6 未启用时的层测试如实提示（不假装成功）', tv2.ok === false && tv2.reason === 'disabled'
            && String(tv2.note).indexOf('启用') >= 0, J(tv2));
        cfg.useVector = true;
    } finally { un(); }
})();

// ---- U 组：提取页 UI（与 V1 的三层结构对齐） ----
A('U1 提取页含 V1 的三层结构 + Embedding / Rerank 区块 + 检索参数 + kw/mem 分组 + 三层测试按钮', (() => {
    const h = settingsPageHtml('extract', '');
    return h.indexOf('提取记忆 · 三层结构') >= 0
        && h.indexOf('🟢 第一层 · 向量检索（优先级最高）') >= 0 && h.indexOf('🟡 第二层 · 浏览器 JS 抽取记忆') >= 0 && h.indexOf('🔴 第三层 · AI 分析') >= 0
        && h.indexOf('data-ftt-cfg="useVector"') >= 0 && h.indexOf('data-ftt-cfg="jsExtractEnabled"') >= 0 && h.indexOf('data-ftt-cfg="useKeywordFlow"') >= 0
        && h.indexOf('data-ftt-cfg="embeddingUrl"') >= 0 && h.indexOf('data-ftt-cfg="embeddingKey"') >= 0
        && h.indexOf('data-ftt-cfg="embeddingModel"') >= 0 && h.indexOf('data-ftt-cfg="embeddingProxyPreset"') >= 0
        && h.indexOf('data-ftt-cfg="rerankUrl"') >= 0 && h.indexOf('data-ftt-cfg="rerankKey"') >= 0
        && h.indexOf('data-ftt-cfg="rerankModel"') >= 0 && h.indexOf('data-ftt-cfg="rerankProxyPreset"') >= 0
        && h.indexOf('data-ftt-cfg="vectorTopN"') >= 0 && h.indexOf('data-ftt-cfg="vectorMinScore"') >= 0 && h.indexOf('data-ftt-cfg="vectorTimeoutMs"') >= 0
        && h.indexOf('data-ftt-cfg="kwApiPreset"') >= 0 && h.indexOf('data-ftt-cfg="memApiPreset"') >= 0
        && h.indexOf('data-ftt-action="testLayer" data-ftt-layer="vector"') >= 0
        && h.indexOf('data-ftt-action="testLayer" data-ftt-layer="js"') >= 0
        && h.indexOf('data-ftt-action="testLayer" data-ftt-layer="ai"') >= 0
        && h.indexOf('data-ftt-api-pfx="emb"') >= 0 && h.indexOf('data-ftt-api-pfx="rerank"') >= 0
        && h.indexOf('data-ftt-api-kind="embedding"') >= 0 && h.indexOf('data-ftt-api-kind="rerank"') >= 0
        && h.indexOf('data-ftt-action="vectorCacheClear"') >= 0
        && h.indexOf('召回参数') >= 0 && h.indexOf('data-ftt-cfg="charBudget"') >= 0;
})(), settingsPageHtml('extract', '').slice(0, 200));

A('U2 提取页不再只渲染裸控件：Embedding/Rerank 区块给出「当前生效 / 尚未可用」的真实状态', (() => {
    cfg.embeddingUrl = 'https://api.example.com/v1'; cfg.embeddingModel = 'emb-1';
    const h1 = settingsPageHtml('extract', '');
    cfg.embeddingUrl = '';
    const h2 = settingsPageHtml('extract', '');
    cfg.embeddingUrl = 'https://api.example.com/v1';
    return h1.indexOf('当前生效：emb-1') >= 0 && h2.indexOf('尚未可用：Embedding API 未配置') >= 0;
})(), '见断言');

A('U3 extractPageHtml 与设定页渲染同源（同一份内容，避免两处各写一套）', (() => {
    return extractPageHtml(SETTINGS_CONTROLS.extract, settingsControlHtml) === settingsPageHtml('extract', '');
})(), '见断言');

// ---- A 组：面板动作（API 页动作表内的向量动作） ----
await (async () => {
    seedState();
    cfg.useVector = true; cfg.embeddingUrl = 'https://api.example.com/v1'; cfg.embeddingModel = 'emb-1'; cfg.embeddingKey = '';
    cfg.rerankUrl = 'https://api.example.com/v1'; cfg.rerankModel = 'rr-1'; cfg.vectorMinScore = 0;
    const un = installGlobalFetch((url, opts) => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 0] }], results: [{ index: 0, relevance_score: 0.5 }] } }));
    setApiPageHooks({ rerender: () => undefined });
    try {
        A('A1 动作表包含 testLayer 与 vectorCacheClear（面板可分发）', API_ACTIONS.indexOf('testLayer') >= 0 && API_ACTIONS.indexOf('vectorCacheClear') >= 0, J(API_ACTIONS));

        const t = await apiAction('apiTest', { apiPfx: 'emb', kind: 'embedding' });
        A('A2 `apiTest`（Embedding 区块）：用向量层 target 真实探测并写回结果态', t.ok === true && t.pfx === 'emb' && t.kind === 'embedding'
            && String(t.note).indexOf('可用') >= 0 && String(vectorTestResults().emb).indexOf('可用') >= 0,
            J({ note: t.note, results: vectorTestResults() }));

        const tr = await apiAction('apiTest', { apiPfx: 'rerank', kind: 'rerank' });
        A('A3 `apiTest`（Rerank 区块）：同样真实探测（kind=rerank）', tr.ok === true && tr.kind === 'rerank' && String(vectorTestResults().rerank).indexOf('可用') >= 0,
            J({ note: tr.note }));

        const lt = await apiAction('testLayer', { layer: 'vector', floorText: '甲在码头发现木箱，断口整齐。' });
        A('A4 `testLayer` 动作：跑向量层并把「命中 N 条 + 预览行」写回页面态', lt.ok === true && lt.count >= 1
            && (layerTestResults().vector.lines || []).length >= 1 && String(lt.note).indexOf('命中') >= 0,
            J({ note: lt.note, count: lt.count }));

        await vecCachePutMany([{ key: 'atom:zz', vector: [1, 1] }]);
        const vc = await apiAction('vectorCacheClear', {});
        A('A5 `vectorCacheClear` 动作：清空缓存并如实回报（内存 → 0）', vc.ok === true && vc.cleared >= 1
            && vectorCacheStats().memory === 0 && String(vc.note).indexOf('已清空向量缓存') === 0,
            J({ note: vc.note, cleared: vc.cleared }));

        cfg.useVector = false;
        const t2 = await apiAction('testLayer', { layer: 'vector' });
        A('A6 未启用时层测试动作如实失败（不假装命中）', t2.ok === false && t2.count === 0
            && (String(t2.note).indexOf('请先启用') >= 0 || String(t2.note).indexOf('未命中') >= 0), J(t2));
        cfg.useVector = true;
    } finally { un(); }
})();

A('B1 向量层状态摘要（设置页/诊断同源）：未配置地址时 vectorLayerInfo 给出原因', (() => {
    cfg.embeddingUrl = ''; cfg.rerankUrl = ''; cfg.rerankModel = '';
    const i1 = vectorLayerInfo();
    cfg.embeddingUrl = 'https://api.example.com/v1';
    cfg.embeddingModel = 'emb-1';
    const i2 = vectorLayerInfo();
    const s = vectorLayerStatus();
    return i1.embedding.ok === false && String(i1.embedding.error).indexOf('缺少地址') >= 0
        && i2.embedding.ok === true && i2.rerank.ok === false && i2.rerankActive === false
        && s.embedding.ok === true && typeof s.bank === 'number';
})(), J(vectorLayerStatus()));

R.done();
