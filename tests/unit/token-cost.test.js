// ============================================================
// 单元测试 · v3.42.0「设定中新增 token 预估与花费」（`core/token-cost.js`）
//
// 用户要求（原话）：「在设定中新增token预估，尤其是请求token、接收、缓存等，并结合大模型价格清单
//   预测花费了多少人民币。注意该功能不需要高频次，只需被动每次请求记录一下统计信息即可。」
//
// 本文件锁住的口径（一条一款，改口径必须先改这里）：
//   ① 估算口径 = `ceil(字符/4)`（与管线状态同一件 `core/pipeline.js#estTokens`）；
//   ② **真实 `usage` 优先**（OpenAI / Anthropic 两种形态都能读），只有 API 明确回报才算「缓存命中」；
//   ③ 未匹配到单价的模型**照样记 token**，但花费为 `null`（**不显示 ¥0.00**）；
//   ④ 明细环上限（超出淘汰最旧）**不影响累计聚合**；花费按**微元整数**累加（不漂移）；
//   ⑤ 价格覆盖 / 汇率 / 清空账本三个写入口的语义与边界；
//   ⑥ 坏账本（非法值）归一后不抛异常。
//
// 运行：node tests/unit/token-cost.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { estTokens } from '../../core/pipeline.js';
import {
    recordAiUsage, aiUsageSummary, aiUsageRecent, resetAiUsage,
    tokenPriceList, priceForModel, costBreakdown, setTokenPriceOverrides, tokenPriceOverrides,
    setUsdCnyRate, usdCnyRate, setTokenCostHooks, DEFAULT_USD_CNY, AI_USAGE_KEEP, BUILTIN_TOKEN_PRICES,
    fmtCny, fmtInt,
} from '../../core/token-cost.js';

const R = makeReporter('token-cost v3.42.0 token 预估与花费账本');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// 宿主注入：内存账本（不碰 ST 设置；语义与 `index.js#wireTokenCostHooks` 同款）
let store = {};
let fixedNow = 1700000000000;
setTokenCostHooks({
    load: () => store,
    save: (v) => { store = JSON.parse(JSON.stringify(v)); },
    now: () => fixedNow,
});

// ============================================================
// P 组：价目表与匹配
// ============================================================
A('P1 内置价目表结构齐备（`in` / `cachedIn` / `out` / `cur` / `match` / `src` / `asOf`），且**只收有来源的条目**',
    (() => {
        const list = tokenPriceList();
        return list.length >= BUILTIN_TOKEN_PRICES.length && list.length > 0
            && list.every((e) => typeof e.in === 'number' && typeof e.out === 'number' && typeof e.cachedIn === 'number'
                && (e.cur === 'USD' || e.cur === 'CNY') && Array.isArray(e.match) && e.match.length > 0 && !!e.id)
            && BUILTIN_TOKEN_PRICES.every((e) => !!e.src && !!e.asOf);
    })(), J(tokenPriceList().map((e) => [e.id, e.cur, e.in, e.cachedIn, e.out])));

A('P2 模型匹配：大小写无关、**长匹配优先**（更具体的模型名不被短名抢走）、未匹配 → `none`',
    (() => {
        const a = priceForModel('deepseek-v4-pro');
        const b = priceForModel('DeepSeek-Flash');
        const c = priceForModel('gpt-4o-unknown-model');
        const d = priceForModel('');
        return a.source !== 'none' && a.key === a.entry.id
            && b.source !== 'none'
            && c.source === 'none' && c.entry === null
            && d.source === 'none';
    })(), J({ pro: priceForModel('deepseek-v4-pro').key, flash: priceForModel('DeepSeek-Flash').key, other: priceForModel('gpt-4o').source }));

A('P3 长度优先的硬证据：构造两条互相包含的覆盖条目 → 命中的是**更长**的那条',
    (() => {
        setTokenPriceOverrides({
            long: { label: '长', match: ['model-abc-9'], cur: 'CNY', in: 9, out: 9, cachedIn: 9 },
            short: { label: '短', match: ['model-abc'], cur: 'CNY', in: 1, out: 1, cachedIn: 1 },
        });
        const hit = priceForModel('model-abc-9');
        setTokenPriceOverrides({});
        return hit.entry && hit.entry.id === 'long' && hit.entry.in === 9;
    })(), J(priceForModel('model-abc-9').entry && priceForModel('model-abc-9').entry.id));

// ============================================================
// C 组：估算 / 实测 / 花费
// ============================================================
A('C1 估算口径与管线状态**同一件**：`estTokens(chars) === ceil(chars/4)`（0 / 负数 / 非数值 → 0）',
    (() => {
        return estTokens(4) === 1 && estTokens(5) === 2 && estTokens(0) === 0 && estTokens(-3) === 0 && estTokens('x') === 0;
    })(), J({ e4: estTokens(4), e5: estTokens(5), e0: estTokens(0) }));

A('C2 花费折算：USD 条目按汇率折人民币；CNY 条目直用；**未命中 = 总输入 − 缓存命中**；未定价 → null',
    (() => {
        setUsdCnyRate(7.2);
        setTokenPriceOverrides({ cny1: { label: '人民币价', match: ['cny-model'], cur: 'CNY', in: 1, cachedIn: 0.1, out: 2 } });
        // deepseek-flash: 1000 输入（0 缓存）+ 500 输出 = (1000*0.30 + 500*1.20)/1e6 = 0.0009 USD → ×7.2 = 0.00648 元
        const usd = costBreakdown({ model: 'deepseek-flash', promptTokens: 1000, respTokens: 500, cachedTokens: 0 });
        // cny-model: 总输入 1000、其中 1000 命中缓存 → 未命中 0；(0*1 + 1000*0.1 + 500*2)/1e6 = 0.0011 元
        const cny = costBreakdown({ model: 'cny-model', promptTokens: 1000, respTokens: 500, cachedTokens: 1000 });
        const none = costBreakdown({ model: 'no-such-model', promptTokens: 1000, respTokens: 500, cachedTokens: 0 });
        const okUsd = Math.abs(usd.cny - 0.00648) < 1e-9 && Math.abs(usd.usd - 0.0009) < 1e-12 && usd.breakdown.missIn === 1000;
        const okCny = Math.abs(cny.cny - 0.0011) < 1e-9 && cny.usd === null && cny.breakdown.missIn === 0 && cny.breakdown.cachedIn === 1000;
        return okUsd && okCny && none.cny === null && none.usd === null && none.entry === null;
    })(), J(costBreakdown({ model: 'deepseek-flash', promptTokens: 1000, respTokens: 500 })));

await (async () => {
    resetAiUsage();
    setTokenPriceOverrides({});
    fixedNow = 1700000000000;
    // OpenAI 形态：prompt_tokens（**含**缓存命中）/ completion_tokens / prompt_tokens_details.cached_tokens
    const e1 = recordAiUsage({
        label: '单楼分析', model: 'deepseek-flash', channel: 'direct',
        promptChars: 4000, respChars: 800,
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } },
        ok: true, ms: 1200,
    });
    // Anthropic 形态：input_tokens（**不含**缓存）/ output_tokens / cache_read_input_tokens → 总输入 = 300 + 50
    const e2 = recordAiUsage({
        label: '单楼分析', model: 'deepseek-flash', channel: 'profile',
        promptChars: 800, respChars: 400,
        usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 50 },
        ok: false, ms: 900,
    });
    // 纯估算（没有 usage）
    const e3 = recordAiUsage({
        label: '批量摘要', model: 'unknown-model-x', channel: 'host',
        promptChars: 4000, respChars: 400, ok: true, ms: 500,
    });
    const s = aiUsageSummary();
    A('C3 实测优先且两种 usage 形态都**归一到「总输入含缓存」**；缓存只有 API 给了才计；无 usage → 估算（字符/4）',
        e1.usageSource === 'usage' && e1.promptTokens === 1000 && e1.respTokens === 500 && e1.cachedTokens === 200
        && e2.usageSource === 'usage' && e2.promptTokens === 350 && e2.respTokens === 100 && e2.cachedTokens === 50
        && e3.usageSource === 'estimate' && e3.promptTokens === 1000 && e3.respTokens === 100 && e3.cachedTokens === 0
        && s.measuredN === 2 && s.estimatedN === 1,
        J({ e1: [e1.promptTokens, e1.respTokens, e1.cachedTokens, e1.usageSource], e2: [e2.promptTokens, e2.respTokens, e2.cachedTokens, e2.usageSource], e3: [e3.promptTokens, e3.respTokens, e3.cachedTokens, e3.usageSource] }));
})();

await (async () => {
    const s = aiUsageSummary();
    // 逐条按同一公式算出**微元**期望值（与实现的「逐条取整再累加」完全一致）
    const micro = (missIn, cachedIn, out, rate) => Math.round((missIn * 0.30 + cachedIn * 0.006 + out * 1.20) / 1e6 * rate * 1e6);
    const expectMicro = micro(800, 200, 500, 7.2) + micro(300, 50, 100, 7.2);   // e1 / e2
    A('C4 累计聚合：条数 / token 分类求和 / 花费按**微元整数**累加（与逐条取整之和一致）；未定价单独计数',
        s.n === 3 && s.promptTokens === 1000 + 350 + 1000 && s.respTokens === 500 + 100 + 100
        && s.cachedTokens === 250 && s.totalTokens === s.promptTokens + s.respTokens
        && s.costMicro === expectMicro && s.unpricedN === 1 && s.okN === 2 && s.failN === 1
        && s.firstAt === 1700000000000 && s.lastAt === 1700000000000,
        J({ n: s.n, promptTokens: s.promptTokens, respTokens: s.respTokens, cachedTokens: s.cachedTokens, costMicro: s.costMicro, expectMicro: expectMicro, unpricedN: s.unpricedN }));
    A('C5 分维度聚合：按「行为标签」与「模型」各一表，且花费与未定价计数都进桶',
        s.byLabel['单楼分析'] && s.byLabel['单楼分析'].n === 2 && s.byLabel['批量摘要'] && s.byLabel['批量摘要'].n === 1
        && s.byLabel['批量摘要'].unpricedN === 1 && s.byLabel['单楼分析'].costMicro === expectMicro
        && s.byModel['deepseek-flash'] && s.byModel['deepseek-flash'].n === 2 && s.byModel['unknown-model-x'].unpricedN === 1,
        J({ labels: Object.keys(s.byLabel), models: Object.keys(s.byModel) }));
    A('C6 明细倒序（最新在前）且逐条带可核对的字段',
        (() => {
            const r = aiUsageRecent(5);
            return r.length === 3 && r[0].label === '批量摘要' && r[2].label === '单楼分析'
                && typeof r[0].at === 'number' && typeof r[0].costCny === 'number' || r[0].costCny === null
                && r[0].promptChars === 4000;
        })(), J(aiUsageRecent(3).map((x) => [x.label, x.model, x.promptTokens, x.costCny])));
})();

// ============================================================
// B 组：边界（环上限 / 汇率 / 覆盖 / 清空 / 坏账本）
// ============================================================
await (async () => {
    resetAiUsage();
    for (let i = 0; i < AI_USAGE_KEEP + 25; i++) {
        recordAiUsage({ label: '压测', model: 'deepseek-flash', promptChars: 40, respChars: 40, ok: true });
    }
    const s = aiUsageSummary();
    const r = aiUsageRecent(5);
    A('B1 明细环上限 = `AI_USAGE_KEEP`（超出淘汰最旧），**累计聚合不受上限影响**',
        s.logN === AI_USAGE_KEEP && s.n === AI_USAGE_KEEP + 25 && r.length === 5 && s.byLabel['压测'].n === AI_USAGE_KEEP + 25,
        J({ logN: s.logN, n: s.n, keep: AI_USAGE_KEEP }));
})();

await (async () => {
    A('B2 汇率：非法值（0 / 负数 / 非数值 / 超大）一律回落默认参考值；合法值原样生效',
        (() => {
            const a = setUsdCnyRate(0) === DEFAULT_USD_CNY;
            const b = setUsdCnyRate(-1) === DEFAULT_USD_CNY;
            const c = setUsdCnyRate('abc') === DEFAULT_USD_CNY;
            const d = setUsdCnyRate(99999) === DEFAULT_USD_CNY;
            const e = setUsdCnyRate(6.5) === 6.5 && usdCnyRate() === 6.5;
            setUsdCnyRate(DEFAULT_USD_CNY);
            return a && b && c && d && e;
        })(), J({ rate: usdCnyRate(), def: DEFAULT_USD_CNY }));
})();

await (async () => {
    A('B3 价格覆盖：整份写入（含新增条目）；坏入参（数组 / 字符串）被拒绝且**不清空**原覆盖',
        (() => {
            const ok = setTokenPriceOverrides({ mine: { label: '我的', match: ['my-model'], cur: 'CNY', in: 2, out: 4 } });
            const has = !!tokenPriceOverrides().mine && tokenPriceOverrides().mine.in === 2;
            const bad1 = setTokenPriceOverrides([]);
            const bad2 = setTokenPriceOverrides('nope');
            const still = !!tokenPriceOverrides().mine;
            const cleared = setTokenPriceOverrides({});
            setTokenPriceOverrides({});
            return ok.ok && ok.n === 1 && has && bad1.ok === false && bad2.ok === false && still && cleared.n === 0;
        })(), J(tokenPriceOverrides()));
    A('B4 覆盖内置条目：同名键覆盖单价与币种，且条目标记不再是「内置」',
        (() => {
            setTokenPriceOverrides({ 'deepseek-flash': { in: 1, cachedIn: 0.5, out: 2, cur: 'CNY' } });
            const e = tokenPriceList().filter((x) => x.id === 'deepseek-flash')[0];
            const hit = priceForModel('deepseek-flash');
            setTokenPriceOverrides({});
            return e.in === 1 && e.out === 2 && e.cur === 'CNY' && e.builtin === false && hit.entry.id === 'deepseek-flash';
        })(), '见断言');
})();

await (async () => {
    resetAiUsage();
    recordAiUsage({ label: 'X', model: 'deepseek-flash', promptChars: 400, respChars: 400, ok: true });
    setUsdCnyRate(6.8);
    setTokenPriceOverrides({ mine: { match: ['my-model'], cur: 'CNY', in: 1, out: 1 } });
    const s = resetAiUsage();
    A('B5 清空账本：明细与累计归零，但**单价覆盖与汇率保留**',
        s.n === 0 && s.logN === 0 && s.promptTokens === 0 && s.costMicro === 0
        && usdCnyRate() === 6.8 && !!tokenPriceOverrides().mine,
        J({ n: s.n, rate: usdCnyRate(), overrides: Object.keys(tokenPriceOverrides()) }));
    setUsdCnyRate(DEFAULT_USD_CNY);
    setTokenPriceOverrides({});
})();

await (async () => {
    A('B6 坏账本归一：脏值（字符串 / 负数 / NaN / 非对象桶）不抛异常，且计数与花费回到合法下界',
        (() => {
            store = {
                log: 'not-an-array',
                agg: { n: 'x', promptTokens: -5, respTokens: NaN, costMicro: -1, byLabel: 'nope', byModel: { a: 'bad' } },
                prices: [],
                usdCny: 'bad',
            };
            // 重新载入（换新钩子 → 触发一次 load）
            setTokenCostHooks({ load: () => store, save: () => undefined, now: () => fixedNow });
            const s = aiUsageSummary();
            const ok = s.n === 0 && s.promptTokens === 0 && s.respTokens === 0 && s.costMicro === 0
                && s.byLabel && typeof s.byLabel === 'object' && s.usdCny === DEFAULT_USD_CNY;
            store = {};
            return ok;
        })(), '见断言');
})();

A('B7 展示格式化：`fmtCny` 的「未定价」与小额精度（< 0.01 元保留 4 位）；`fmtInt` 千分位',
    (() => {
        return fmtCny(null) === '未定价' && fmtCny(0) === '¥0.00' && fmtCny(1.5) === '¥1.50'
            && fmtCny(0.00648) === '¥0.0065' && fmtInt(1234567) === '1,234,567' && fmtInt(-5) === '0';
    })(), J({ none: fmtCny(null), tiny: fmtCny(0.00648), big: fmtInt(1234567) }));

R.done();
