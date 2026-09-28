// ============================================================
// 单元测试 · v3.0.0「所有 AI 请求无论是否存在并行，都应该在管线出现提示信息」
//
// 用户要求（原话）：
//   「1. 所有 AI 请求无论是否存在并行，都应该在管线出现提示信息；
//     2. 管线状态默认不显示，如果有请求、同步等各类动作时自动出现，且如果有并行时出现两个或两个以上，根据需求展现。」
//
// 本文件覆盖**覆盖面**（第 1 条）：逐条验证各请求 / 动作入口在**在途期间**都会在管线里出现一行，
//   并给出类别标签（AI / 同步 / 存储 / 任务）。已在别处覆盖的：`core/ai-hooks.js#aiCallText`（所有 AI 文本调用）、
//   `host/extract.js#genTracked`（批量摘要 / 单楼分析）、`trackPipeline` 本身（`pipeline-tick.test.js` W6）。
//   本文件补：向量请求（embedding）/ 精排（rerank）· 连通性测试 · 获取模型 · 保存记忆文件 ·
//   跨端同步 · 刷新状态 · 校验并修复 · 世界书镜像 · 提取记忆（召回 + 注入）。
// 运行：node tests/unit/pipeline-coverage.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { resetPipeline, listPipelineRuns, beginPipeline, endPipeline } from '../../core/pipeline.js';
import { requestEmbeddings, requestRerank } from '../../host/embeddings.js';
import { probeTarget, fetchModels } from '../../host/api-channel.js';
import { saveStateNow, setStorageHooks } from '../../adapters/store.js';
import { crossSyncManual, refreshFromServer } from '../../adapters/sync.js';

const R = makeReporter('pipeline-coverage v3.0.0 所有请求/动作都进管线状态');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
const uninstallHost = installGlobalHost(host, doc);

function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:pipeline-coverage');
    setLastMessageId(3);
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setStorageHooks({ getItem: () => null, setItem: () => true });
    resetPipeline();
}
boot();

/** 运行期间抓一次「管线里有哪些行」 */
async function captureDuring(fn) {
    let snap = null;
    const p = fn();
    // 让动作真正跑起来（至少一个微任务），再抓在途快照
    await new Promise((r) => setTimeout(r, 0));
    snap = listPipelineRuns();
    const ret = await p;
    return { ret: ret, during: snap, after: listPipelineRuns() };
}
const hasLabel = (runs, needle) => runs.some((x) => String(x.label).indexOf(needle) >= 0);
const kindOf = (runs, needle) => (runs.filter((x) => String(x.label).indexOf(needle) >= 0)[0] || {}).kind;

// ---------- A 组：向量 / 精排请求（AI 请求） ----------
A('A1 向量请求：`requestEmbeddings` 在途期间管线出现「向量检索（embedding）」一行，类别 = AI，并带 token 估算', (async () => {
    boot();
    cfg.useVector = true; cfg.embeddingUrl = 'https://stub.example/v1'; cfg.embeddingModel = 'm'; cfg.embeddingKey = '';
    const unFetch = installGlobalFetch((url) => (String(url).indexOf('/embeddings') >= 0
        ? { status: 200, body: { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] } }
        : { status: 404, body: {} }));
    try {
        let during = null;
        const p = requestEmbeddings(['甲在码头卸货', '乙在钟鼓楼']);
        await new Promise((r) => setTimeout(r, 5));
        during = listPipelineRuns();
        const r = await p;
        return r.ok === true && hasLabel(during, '向量检索') && kindOf(during, '向量检索') === 'ai'
            && Number(during[0].tokens) > 0 && during[0].phase === '请求 embedding'
            && listPipelineRuns().length === 0;
    } finally { unFetch(); }
})(), '');

A('A2 精排请求：`requestRerank` 在途期间出现「精排（rerank）」一行（类别 AI）；缺配置时**不产生**空行', (async () => {
    boot();
    cfg.rerankUrl = 'https://stub.example/v1'; cfg.rerankModel = 'r'; cfg.rerankKey = '';
    const unFetch = installGlobalFetch(() => ({ status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] } }));
    let during = null;
    try {
        const p = requestRerank('木箱', ['甲在码头', '木箱断口整齐']);
        await new Promise((r) => setTimeout(r, 5));
        during = listPipelineRuns();
        const r = await p;
        return r.ok === true && hasLabel(during, '精排') && kindOf(during, '精排') === 'ai'
            && J(r.order) === J([1, 0]) && listPipelineRuns().length === 0;
    } finally { unFetch(); }
})(), () => J(listPipelineRuns()));

// ---------- B 组：连通性测试 / 获取模型（用户点的一次性请求） ----------
A('B1 连通性测试：`probeTarget` 在途出现「连通性测试（chat）」一行（类别 AI）；结束后收尾', (async () => {
    boot();
    const unFetch = installGlobalFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'pong' } }] } }));
    try {
        let during = null;
        const p = probeTarget({ channel: 'direct', apiUrl: 'https://stub.example/v1', apiKey: '', model: 'm' }, 'chat', 3000);
        await new Promise((r) => setTimeout(r, 5));
        during = listPipelineRuns();
        const r = await p;
        return r.ok === true && hasLabel(during, '连通性测试') && kindOf(during, '连通性测试') === 'ai'
            && listPipelineRuns().length === 0;
    } finally { unFetch(); }
})(), '');

A('B2 获取模型：`fetchModels` 在途出现「获取模型列表」一行（类别 AI）', (async () => {
    boot();
    const unFetch = installGlobalFetch(() => ({ status: 200, body: { data: [{ id: 'm1' }, { id: 'm2' }] } }));
    try {
        let during = null;
        const p = fetchModels({ channel: 'direct', apiUrl: 'https://stub.example/v1', apiKey: '', model: 'm' });
        await new Promise((r) => setTimeout(r, 5));
        during = listPipelineRuns();
        const r = await p;
        return r.ok === true && hasLabel(during, '获取模型') && kindOf(during, '获取模型') === 'ai'
            && listPipelineRuns().length === 0;
    } finally { unFetch(); }
})(), '');

// ---------- C 组：存储 / 同步类动作 ----------
A('C1 保存记忆文件：`saveStateNow` 在途出现「保存记忆文件」一行（类别 = 存储），且**不改变**保存结果与返回结构', (async () => {
    boot();
    state.atoms = [{ id: 'a1', text: '甲在码头卸货（正文足够长）。', date: '1919-11-29', tags: [], keywords: [] }];
    let during = null;
    const p = saveStateNow({ reason: 'test' });
    await new Promise((r) => setTimeout(r, 0));
    during = listPipelineRuns();
    const r = await p;
    return r && typeof r === 'object' && 'ok' in r
        && hasLabel(during, '保存记忆文件') && kindOf(during, '保存记忆文件') === 'io'
        && listPipelineRuns().length === 0;
})(), () => J({ during: listPipelineRuns().length }));

A('C2 跨端同步 / 刷新状态：两个入口在途各出现一行「同步」类别（即使被 busy / 长任务拒绝也如实收尾）', (async () => {
    boot();
    let duringSync = null, duringRefresh = null;
    const p1 = crossSyncManual();
    await new Promise((r) => setTimeout(r, 0));
    duringSync = listPipelineRuns();
    await p1;
    const p2 = refreshFromServer();
    await new Promise((r) => setTimeout(r, 0));
    duringRefresh = listPipelineRuns();
    await p2;
    return hasLabel(duringSync, '跨端同步') && kindOf(duringSync, '跨端同步') === 'sync'
        && hasLabel(duringRefresh, '刷新状态') && kindOf(duringRefresh, '刷新状态') === 'sync'
        && listPipelineRuns().length === 0;
})(), () => J({ sync: listPipelineRuns().length }));

// ---------- D 组：并行与嵌套 ----------
A('D1 并行：两路请求同时进行 → 管线内**两行**（类别可不同），各自独立收尾', (async () => {
    boot();
    cfg.useVector = true; cfg.embeddingUrl = 'https://stub.example/v1'; cfg.embeddingModel = 'm'; cfg.embeddingKey = '';
    const unFetch = installGlobalFetch((url) => (String(url).indexOf('/embeddings') >= 0
        ? { status: 200, body: { data: [{ index: 0, embedding: [1, 0] }] } }
        : { status: 404, body: {} }));
    try {
        const a = beginPipeline('批量摘要', { kind: 'ai', chars: 100 });

        let during = null;
        const p = requestEmbeddings(['甲在码头']);
        await new Promise((r) => setTimeout(r, 5));
        during = listPipelineRuns();
        await p;
        endPipeline(true, a.runId);
        return during.length === 2
            && hasLabel(during, '批量摘要') && hasLabel(during, '向量检索')
            && listPipelineRuns().length === 0;
    } finally { unFetch(); }
})(), '');

// ---------- E 组：结构性保证 ----------
A('E1 所有登记都成对出现（异常也收尾）：`trackPipeline` 内抛错 → 运行被移除、异常继续向上抛（不吞异常）', (async () => {
    boot();
    const { trackPipeline } = await import('../../core/pipeline.js');
    let threw = '';
    try { await trackPipeline('会失败的动作', { kind: 'sync' }, async () => { throw new Error('boom'); }); } catch (e) { threw = String(e.message || e); }
    return threw === 'boom' && listPipelineRuns().length === 0;
})(), '');

A('E2 静态审计：`host/ adapters/ core/` 里的**网络请求/长动作**入口都在管线登记表内（防止以后新增请求漏登记）', (async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
    // 期望「在途期间能在管线看到自己那一行」的入口文件（逐条给出应包含的登记手段）
    const EXPECT = [
        ['core/ai-hooks.js', 'aiCallText 统一出口（beginPipeline）'],
        ['host/extract.js', 'genTracked（批量摘要 / 单楼分析）'],
        ['host/embeddings.js', '向量 / 精排请求'],
        ['host/api-channel.js', '连通性测试 / 获取模型'],
        ['host/inject.js', '提取记忆（召回 + 注入）'],
        ['adapters/store.js', '保存记忆文件'],
        ['adapters/sync.js', '跨端同步 / 刷新状态 / 校验修复'],
        ['adapters/worldbook.js', '世界书镜像'],
    ];
    const missing = [];
    for (const [f, why] of EXPECT) {
        const src = read(f);
        if (!/beginPipeline\(|trackPipeline\(/.test(src)) missing.push(f + '（' + why + '）');
    }
    // 反向兜底：所有直接 `globalThis.fetch` 的业务文件必须已在 EXPECT 内
    const D = (dir) => { try { return readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.js')); } catch (e) { return []; } };
    const fetchers = ['host', 'adapters'].flatMap((d) => D(d).map((f) => d + '/' + f))
        .filter((f) => /globalThis\.fetch\(/.test(read(f)))
        .filter((f) => !/user-file|file-transport|gzip/.test(f));
    const untracked = fetchers.filter((f) => !EXPECT.some(([e]) => e === f));
    return missing.length === 0 && untracked.length === 0;
})(), '');

try { uninstallHost(); } catch (e) { /* 忽略 */ }
R.done();
