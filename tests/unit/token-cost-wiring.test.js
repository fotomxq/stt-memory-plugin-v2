// ============================================================
// 单元测试 · v3.42.0「Token 预估与花费」的**接线**（三条通道各一条真实请求 → 账本落一条）
//
// 为什么单独一个文件：`tests/unit/token-cost.test.js` 锁的是**内核账本**（估算 / 定价 / 聚合 / 边界），
//   本文件锁的是**宿主接线** —— 即「用户说的『被动每次请求记录一下』到底有没有真的发生」：
//     · `sendDirect`（自建连接）：能拿到 OpenAI 兼容的**真实 `usage`** → 账本标 `usage`（实测）；
//     · `rawGenerate` 的 **host 通道**（跟随酒馆当前连接）：`generateRaw` 只回文本 → 按字符数**估算**；
//     · `sendViaProfile`（酒馆连接配置）：宿主给了 `usage` 就实测，否则估算；
//     · `probeTarget`（🧪 测试 / 探针）：**不计入**（诊断动作，口径已写进设定页说明）。
//
// 同时锁住「**不改返回形状**」这条硬约束（三条通道的返回键集逐一对齐）——
//   这是 `api-channel-golden` / 冒烟能与 V1 oracle 继续逐项比对的前提。
//
// 运行：node tests/unit/token-cost-wiring.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setPersistHooks } from '../../core/model/runtime.js';
import { sendDirect, sendViaProfile, probeTarget } from '../../host/api-channel.js';
import { rawGenerate } from '../../host/generation.js';
import { setTokenCostHooks, aiUsageSummary, aiUsageRecent, resetAiUsage } from '../../core/token-cost.js';

const R = makeReporter('token-cost-wiring v3.42.0 用量账本的宿主接线');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
installGlobalHost(host, doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

// 账本落内存（与 `index.js#wireTokenCostHooks` 同语义）
let store = {};
let st = 1700000000000;
setTokenCostHooks({ load: () => store, save: (v) => { store = JSON.parse(JSON.stringify(v)); }, now: () => st });

const last = () => { const r = aiUsageRecent(1); return r[0] || null; };

// ============================================================
// W1 自建连接：真实 usage（含缓存命中）→ 实测记账 + 单价折算
// ============================================================
await (async () => {
    resetAiUsage();
    const restore = installGlobalFetch(() => ({
        status: 200,
        body: {
            model: 'deepseek-flash-echo',
            choices: [{ message: { content: '好的'.repeat(50) } }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } },
        },
    }));
    let r = null;
    try {
        r = await sendDirect({
            apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'deepseek-flash',
            systemPrompt: 'S'.repeat(400), prompt: 'P'.repeat(400), label: '单楼分析',
        });
    } finally { restore(); }
    const e = last();
    const s = aiUsageSummary();
    // 花费：(1000−200)×0.30 + 200×0.006 + 500×1.20 = 841.2 → /1e6 ×7.2 元
    const want = (800 * 0.30 + 200 * 0.006 + 500 * 1.20) / 1e6 * 7.2;
    A('W1 `sendDirect` 成功即落一条**实测**账：`usage` 三个数照抄、缓存命中计入、按模型单价折人民币；'
        + '**返回键集不变**（`ok/text/url/via`，与 V1 逐项比对不受影响）',
        r.ok === true && r.text.length > 0
        && J(Object.keys(r).sort()) === J(['ok', 'text', 'url', 'via'])
        && e && e.label === '单楼分析' && e.channel === 'direct' && e.model === 'deepseek-flash-echo'
        && e.usageSource === 'usage' && e.promptTokens === 1000 && e.respTokens === 500 && e.cachedTokens === 200
        && e.priced === true && e.priceKey === 'deepseek-flash'
        && Math.abs(e.costCny - want) < 1e-9 && s.n === 1 && s.measuredN === 1 && s.estimatedN === 0,
        J({ keys: Object.keys(r).sort(), entry: e, want: want }));
})();

// ============================================================
// W2 自建连接失败：HTTP 非 200 → 仍记一条（token 0、失败计数 +1）
// ============================================================
await (async () => {
    resetAiUsage();
    const restore = installGlobalFetch(() => ({ status: 500, statusText: 'boom', text: async () => 'boom' }));
    let r = null;
    try { r = await sendDirect({ apiUrl: 'https://x.example/v1', model: 'deepseek-flash', prompt: 'P'.repeat(400), label: '弱化NSFW' }); }
    finally { restore(); }
    const e = last();
    const s = aiUsageSummary();
    A('W2 `sendDirect` HTTP 失败也记一条（`ok:false`、token 与花费记 0、失败 +1）—— 不静默丢账、也不把未发生的费用算进去',
        r.ok === false && e && e.ok === false && e.label === '弱化NSFW' && e.promptTokens === 0 && e.respTokens === 0
        && e.costCny === 0 && s.n === 1 && s.failN === 1 && s.okN === 0,
        J({ ok: r.ok, entry: e, failN: s.failN }));
})();

// ============================================================
// W3 宿主通道（generateRaw）：无 usage → 按字符数估算 + 模型名 best-effort
// ============================================================
await (async () => {
    resetAiUsage();
    const savedGen = host.ctx.generateRaw;
    const savedModel = host.ctx.getChatCompletionModel;
    let r = null;
    try {
        host.ctx.generateRaw = async () => 'X'.repeat(400);
        host.ctx.getChatCompletionModel = () => 'gpt-host-x';
        r = await rawGenerate({ systemPrompt: 'S'.repeat(400), prompt: 'P'.repeat(400), target: { channel: 'host' }, usageLabel: '批量摘要' });
    } finally {
        host.ctx.generateRaw = savedGen;
        host.ctx.getChatCompletionModel = savedModel;
    }
    const e = last();
    A('W3 host 通道（`generateRaw` 不回 usage）→ 按 `ceil(字符/4)` 估算、渠道标 `host`、模型名取宿主当前模型；'
        + '**返回键集不变**（`ok/text/via`）',
        r.ok === true && r.via === 'host' && J(Object.keys(r).sort()) === J(['ok', 'text', 'via'])
        && e && e.channel === 'host' && e.label === '批量摘要' && e.model === 'gpt-host-x'
        && e.usageSource === 'estimate' && e.promptChars === 800 && e.promptTokens === 200 && e.respTokens === 100,
        J({ keys: Object.keys(r).sort(), entry: e }));
})();

// ============================================================
// W4 连接配置通道：宿主回 `usage` → 实测；模型名取「连接配置」里的 model
// ============================================================
await (async () => {
    resetAiUsage();
    const savedSvc = host.ctx.ConnectionManagerRequestService;
    let r = null;
    try {
        host.ctx.ConnectionManagerRequestService = {
            getSupportedProfiles: () => [{ id: 'p1', name: '主连接', api: 'openai', model: 'profile-model-x' }],
            sendRequest: async () => ({ content: 'PONG', usage: { prompt_tokens: 100, completion_tokens: 50 } }),
        };
        r = await sendViaProfile({ profileId: 'p1', systemPrompt: 'S'.repeat(200), prompt: 'P'.repeat(200), label: '推演世界' });
    } finally { host.ctx.ConnectionManagerRequestService = savedSvc; }
    const e = last();
    A('W4 `sendViaProfile`：宿主给了 `usage` → 实测记账；模型名取连接配置的 model；'
        + '**返回键集不变**（`ok/text/via/profileId/streamed`）',
        r.ok === true && J(Object.keys(r).sort()) === J(['ok', 'profileId', 'streamed', 'text', 'via'])
        && e && e.channel === 'profile' && e.label === '推演世界' && e.model === 'profile-model-x'
        && e.usageSource === 'usage' && e.promptTokens === 100 && e.respTokens === 50,
        J({ keys: Object.keys(r).sort(), entry: e }));
})();

// ============================================================
// W5 探针 / 连通性测试**不计入**（口径写进设定页说明，此处锁住）
// ============================================================
await (async () => {
    resetAiUsage();
    const restore = installGlobalFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'pong' } }] } }));
    let r = null;
    try { r = await probeTarget({ channel: 'direct', apiUrl: 'https://x.example/v1', model: 'deepseek-flash' }, 'chat'); }
    finally { restore(); }
    A('W5 `probeTarget`（🧪 测试 / 探针）**不落账**（诊断动作不计入花费）',
        r.ok === true && aiUsageSummary().n === 0 && aiUsageRecent(5).length === 0,
        J({ ok: r.ok, n: aiUsageSummary().n }));
})();

R.done();
