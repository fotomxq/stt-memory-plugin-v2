// ============================================================
// core/token-cost.js —— **AI 用量与花费账本**（token 预估 + 价格清单 + 人民币估算）
//
// 用户要求（原话）：「在设定中新增token预估，尤其是请求token、接收、缓存等，并结合大模型价格清单
//   预测花费了多少人民币。注意该功能不需要高频次，只需被动每次请求记录一下统计信息即可。」
//
// 定位：**运行账本**（与 `core/read-ledger.js` / `core/pipeline.js` 的历史样本同类）——
//   · **被动记账**：只在一一次真实 AI 请求**结束时**追加一条，不做轮询、不做定时刷新、不介入请求本身；
//   · **不进数据模型**：持久化由宿主注入（本项目的落点是 ST 扩展设置 `aiUsage`，
//     与 `syncConflicts` / `pipelineEta` / `floorTrimLog` 同口径）→ **`DATA_VERSION` 不变**；
//   · **不保存正文**：只记 token / 字符数 / 模型 / 标签 / 花费 / 耗时（与读取台账同口径）。
//
// 三条口径（写死在代码里，UI、文档与测试共用同一份）：
//   ① **token 估算** = `ceil(字符数 / 4)`（复用 `core/pipeline.js#estTokens`，与管线状态**同一口径**）；
//      若通道能拿到**真实 `usage`**（OpenAI 兼容响应），则以实测值覆盖估算，并标记 `usageSource='usage'`。
//   ② **缓存 token**：只有 API 明确回报（`prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`）才计；
//      估算通道**不猜**缓存 —— 记 0 并在明细里标「未知」。
//   ③ **花费**：`(未命中输入 × in + 命中输入 × cachedIn + 输出 × out) ÷ 1e6`（**未命中 = 总输入 − 缓存命中**），
//      单价表按**每 100 万 token**计；币种可为 `USD` / `CNY`，USD 按可配置汇率折算人民币。
//      两种上游 `usage` 形态归一到「总输入含缓存」后再算（见 `costBreakdown` 的入参约定）。
//
// 诚实口径（**不编价格**）：内置清单只收**已核实来源**的条目（见 `BUILTIN_TOKEN_PRICES` 的 `src` / `asOf`）；
//   未匹配到单价的模型**照样记 token**，但 `costCny = null`（**不显示 0.00 元**），并由 UI 提示「未定价」。
// ============================================================
import { estTokens } from './pipeline.js';

/** 内置价目表的采集日期（齐头写进 UI 与文档；价格会变，用户可覆盖） */
export const TOKEN_PRICE_ASOF = '2026-10-10';
/** 默认美元兑人民币汇率（**参考值**，可在设定页改） */
export const DEFAULT_USD_CNY = 7.2;
/** 明细环上限（超出淘汰最旧；累计聚合**不受**此上限影响） */
export const AI_USAGE_KEEP = 200;
/** 分维度聚合的键上限（超出并入「其它」，避免账本无界膨胀） */
export const AI_USAGE_MAX_KEYS = 40;

/**
 * 内置参考价目表（**只收已核实来源**；每 100 万 token）。
 *
 * | 字段 | 口径 |
 * | --- | --- |
 * | `id` | 条目键（用户覆盖时按它匹配） |
 * | `match` | 模型名**小写子串**匹配（按长度降序尝试，命中即用） |
 * | `in` | **未命中缓存**的输入价 |
 * | `cachedIn` | **命中缓存**的输入价（未提供 → 与 `in` 相同） |
 * | `out` | 输出价 |
 * | `cur` | 币种：`USD` / `CNY` |
 * | `src` / `asOf` | 来源与采集日期（UI 逐条展示，用户可判断是否需要覆盖） |
 */
export const BUILTIN_TOKEN_PRICES = Object.freeze([
    {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        match: ['deepseek-v4-pro', 'deepseek-reasoner'],
        cur: 'USD', in: 1.32, cachedIn: 0.044, out: 3.96,
        note: '峰时价（工作日高峰；非峰时为半价 —— 预估按峰时，偏保守）',
        src: 'DeepSeek 官方价目页（api-docs.deepseek.com/quick_start/pricing）', asOf: TOKEN_PRICE_ASOF,
    },
    {
        id: 'deepseek-flash',
        label: 'DeepSeek Flash',
        match: ['deepseek-flash', 'deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4.1-flash'],
        cur: 'USD', in: 0.30, cachedIn: 0.006, out: 1.20,
        note: '峰时价（工作日高峰；非峰时为半价 —— 预估按峰时，偏保守）',
        src: 'DeepSeek 官方价目页（api-docs.deepseek.com/quick_start/pricing）', asOf: TOKEN_PRICE_ASOF,
    },
]);

// ---------- 注入钩子（宿主持久化；未接线时账本只活在内存里，不影响记账） ----------
let hooks = {
    load: () => ({}),          // () => 账本对象（{ log, agg, prices, usdCny }）
    save: () => undefined,     // (ledger) => void
    now: () => Date.now(),
};
export function setTokenCostHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function tokenCostHooks() { return Object.assign({}, hooks); }

// ---------- 账本内存态（惰性从宿主读一次；之后以内存为准，逐次落盘） ----------
let loaded = false;
/** 账本结构：`{ log: [], agg: {…}, prices: {}, usdCny: 0 }` */
const ledger = { log: [], agg: null, prices: {}, usdCny: 0 };

/** 空聚合 */
function emptyAgg() {
    return {
        n: 0, okN: 0, failN: 0,
        promptTokens: 0, respTokens: 0, cachedTokens: 0, totalTokens: 0,
        costMicro: 0,               // 花费（**微元**整数；1 元 = 1e6 微元）→ 避免浮点累加漂移
        unpricedN: 0, measuredN: 0, estimatedN: 0,
        firstAt: 0, lastAt: 0,
        byLabel: {}, byModel: {},
    };
}
/**
 * 单维度桶（`{n, promptTokens, respTokens, cachedTokens, costMicro, unpricedN}`）——
 * **上限**：键数超过 `AI_USAGE_MAX_KEYS` 时并入「其它」（按 token 总量保留最大的那些）。
 */
function bumpBucket(map, key, rec) {
    const k = String(key || '(未标注)').slice(0, 60);
    const cur = map[k] || { n: 0, promptTokens: 0, respTokens: 0, cachedTokens: 0, costMicro: 0, unpricedN: 0 };
    cur.n += 1;
    cur.promptTokens += rec.promptTokens;
    cur.respTokens += rec.respTokens;
    cur.cachedTokens += rec.cachedTokens;
    if (rec.costMicro == null) cur.unpricedN += 1; else cur.costMicro += rec.costMicro;
    map[k] = cur;
    const keys = Object.keys(map);
    if (keys.length > AI_USAGE_MAX_KEYS) {
        // 保留 token 总量最大的前 N 个键，其余并入「其它」（账本键数**有界**）
        const sorted = keys.slice().sort((a, b) => (map[b].promptTokens + map[b].respTokens) - (map[a].promptTokens + map[a].respTokens));
        for (const k2 of sorted.slice(AI_USAGE_MAX_KEYS)) {
            if (k2 === '其它') continue;
            const v = map[k2];
            const o = map['其它'] || { n: 0, promptTokens: 0, respTokens: 0, cachedTokens: 0, costMicro: 0, unpricedN: 0 };
            o.n += v.n; o.promptTokens += v.promptTokens; o.respTokens += v.respTokens; o.cachedTokens += v.cachedTokens;
            o.costMicro += v.costMicro; o.unpricedN += v.unpricedN;
            map['其它'] = o;
            delete map[k2];
        }
    }
    return map;
}

/** 归一：任意来源的账本对象 → 合法结构（坏值一律回落默认，不抛异常） */
function normalizeLedger(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const agg = Object.assign(emptyAgg(), (src.agg && typeof src.agg === 'object') ? src.agg : {});
    // 桶表必须是对象；数值字段统一夹到非负整数
    for (const f of ['byLabel', 'byModel']) {
        const m = (agg[f] && typeof agg[f] === 'object') ? agg[f] : {};
        const out = {};
        for (const k of Object.keys(m)) {
            const v = m[k] && typeof m[k] === 'object' ? m[k] : {};
            out[k] = {
                n: Math.max(0, Math.round(Number(v.n) || 0)),
                promptTokens: Math.max(0, Math.round(Number(v.promptTokens) || 0)),
                respTokens: Math.max(0, Math.round(Number(v.respTokens) || 0)),
                cachedTokens: Math.max(0, Math.round(Number(v.cachedTokens) || 0)),
                costMicro: Math.max(0, Math.round(Number(v.costMicro) || 0)),
                unpricedN: Math.max(0, Math.round(Number(v.unpricedN) || 0)),
            };
        }
        agg[f] = out;
    }
    agg.n = Math.max(0, Math.round(Number(agg.n) || 0));
    agg.okN = Math.max(0, Math.round(Number(agg.okN) || 0));
    agg.failN = Math.max(0, Math.round(Number(agg.failN) || 0));
    for (const f of ['promptTokens', 'respTokens', 'cachedTokens', 'totalTokens', 'costMicro', 'unpricedN', 'measuredN', 'estimatedN']) {
        agg[f] = Math.max(0, Math.round(Number(agg[f]) || 0));
    }
    const log = (Array.isArray(src.log) ? src.log : []).filter((x) => x && typeof x === 'object').slice(-AI_USAGE_KEEP);
    return { log, agg, prices: (src.prices && typeof src.prices === 'object') ? src.prices : {}, usdCny: Math.max(0, Number(src.usdCny) || 0) };
}
/** 惰性读一次宿主账本（只读一次；之后的写入以内存为准） */
function ensureLoaded() {
    if (loaded) return ledger;
    loaded = true;
    const n = normalizeLedger((() => { try { return hooks.load(); } catch (e) { return {}; } })());
    ledger.log = n.log;
    ledger.agg = n.agg;
    ledger.prices = n.prices;
    ledger.usdCny = n.usdCny;
    return ledger;
}
/** 落盘（异常不影响记账；**低频**：只在每次请求结束时调用） */
function persistLedger() {
    try { hooks.save({ log: ledger.log, agg: ledger.agg, prices: ledger.prices, usdCny: ledger.usdCny }); } catch (e) { /* 忽略 */ }
}

// ---------- 价格解析 ----------
/** 汇率（用户覆盖优先；非法值回落默认） */
export function usdCnyRate() {
    const l = ensureLoaded();
    const v = Number(l.usdCny);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_USD_CNY;
}
/** 内置 + 用户覆盖后的**完整价目表**（覆盖按 `id` 合并；用户新增条目追加在后） */
export function tokenPriceList() {
    const l = ensureLoaded();
    const over = (l.prices && typeof l.prices === 'object') ? l.prices : {};
    const out = BUILTIN_TOKEN_PRICES.map((e) => {
        const o = over[e.id];
        // 被用户覆盖的内置条目**不再标「内置」**（UI 据此显示「(自定义)」，避免把用户价当成官方参考价）
        return o ? normalizeEntry(Object.assign({}, e, o, { id: e.id, builtin: false })) : normalizeEntry(Object.assign({}, e, { builtin: true }));
    });
    for (const id of Object.keys(over)) {
        if (BUILTIN_TOKEN_PRICES.some((e) => e.id === id)) continue;
        const e = normalizeEntry(Object.assign({ id }, over[id]));
        if (e) out.push(e);
    }
    return out;
}
/** 单条目归一（非法值回落 0；`match` 归一为小写数组） */
function normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const match = (Array.isArray(e.match) ? e.match : [e.match]).map((s) => String(s == null ? '' : s).trim().toLowerCase()).filter(Boolean);
    const id = String(e.id || match[0] || '').trim();
    if (!id && !match.length) return null;
    return {
        id: id || match[0],
        label: String(e.label || id),
        match: match.length ? match : [id.toLowerCase()],
        cur: String(e.cur || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
        in: num(e.in), cachedIn: (e.cachedIn === undefined || e.cachedIn === null) ? num(e.in) : num(e.cachedIn), out: num(e.out),
        note: String(e.note || ''), src: String(e.src || ''), asOf: String(e.asOf || ''),
        builtin: e.builtin === true,
    };
}
/**
 * 按模型名匹配单价条目（**长匹配优先**：更具体的模型名先命中）。
 * @returns {{entry:object|null, key:string, source:'builtin'|'override'|'none'}}
 */
export function priceForModel(model) {
    const m = String(model == null ? '' : model).trim().toLowerCase();
    const list = tokenPriceList();
    const pairs = [];
    for (const e of list) for (const k of e.match) pairs.push({ k, e });
    pairs.sort((a, b) => b.k.length - a.k.length);                       // 长匹配优先
    for (const p of pairs) { if (m && m.indexOf(p.k) >= 0) return { entry: p.e, key: p.e.id, source: p.e.builtin ? 'builtin' : 'override' }; }
    return { entry: null, key: '', source: 'none' };
}
/** 单价的展示文案（UI 与日志共用） */
export function priceText(entry) {
    if (!entry) return '未定价';
    const u = entry.cur === 'USD' ? '美元' : '元';
    return `${entry.cur} 入 ${entry.in} / 缓存 ${entry.cachedIn} / 出 ${entry.out}（每 100 万 token，${u}）`;
}

/**
 * 花费拆解（纯函数）。
 *
 * **入参约定（重要）**：`promptTokens` = **总输入 token（含缓存命中的部分）**，`cachedTokens` = 其中命中缓存的部分。
 *   两种上游形态都归一到这个约定后才进本函数（见 `recordAiUsage`）：
 *   · OpenAI 兼容：`prompt_tokens` **含** `prompt_tokens_details.cached_tokens` → 直接用；
 *   · Anthropic 形态：`input_tokens` **不含** `cache_read_input_tokens` → 相加后再用。
 * @param {{model?:string, promptTokens?:number, respTokens?:number, cachedTokens?:number}} input
 * @returns {{cny:number|null, usd:number|null, entry:object|null, source:string, breakdown:{missIn:number,cachedIn:number,out:number}}}
 */
export function costBreakdown(input) {
    const o = input || {};
    const totalIn = Math.max(0, Math.round(Number(o.promptTokens) || 0));
    const cachedIn = Math.min(totalIn, Math.max(0, Math.round(Number(o.cachedTokens) || 0)));
    const missIn = totalIn - cachedIn;                 // 未命中缓存的输入（缓存命中按 `cachedIn` 单价计）
    const outT = Math.max(0, Math.round(Number(o.respTokens) || 0));
    const hit = priceForModel(o.model);
    if (!hit.entry) return { cny: null, usd: null, entry: null, source: 'none', breakdown: { missIn, cachedIn, out: outT } };
    const e = hit.entry;
    const rate = usdCnyRate();
    const toCny = (v) => (e.cur === 'USD' ? v * rate : v);
    const usd = e.cur === 'USD' ? (missIn * e.in + cachedIn * e.cachedIn + outT * e.out) / 1e6 : null;
    const cny = toCny((missIn * e.in + cachedIn * e.cachedIn + outT * e.out) / 1e6);
    return { cny: cny, usd: usd, entry: e, source: hit.source, breakdown: { missIn, cachedIn, out: outT } };
}

// ---------- 记账 ----------
/**
 * **被动记账**：一次真实 AI 请求结束时调用一次（不论成败）。
 *
 * @param {{label?:string, model?:string, channel?:string, purpose?:string,
 *          promptChars?:number, respChars?:number,
 *          promptTokens?:number, respTokens?:number, cachedTokens?:number,
 *          usage?:object|null, ok?:boolean, ms?:number, at?:number}} rec
 * @returns {object} 记账后的明细条目
 */
export function recordAiUsage(rec) {
    const l = ensureLoaded();
    const r = (rec && typeof rec === 'object') ? rec : {};
    const u = (r.usage && typeof r.usage === 'object') ? r.usage : null;
    // ① 真实 usage 优先。两种上游形态**归一到「总输入含缓存」**：
    //    · OpenAI 兼容：`prompt_tokens`（**含** `prompt_tokens_details.cached_tokens`）/ `completion_tokens`；
    //    · Anthropic 形态：`input_tokens`（**不含** `cache_read_input_tokens`）/ `output_tokens` → 相加后再用。
    //    也兼容部分网关的 `prompt_cache_hit_tokens`。
    const pick = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
    const uDetails = u && u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : null;
    const uCached = u ? (
        pick(u.prompt_cache_hit_tokens) != null ? pick(u.prompt_cache_hit_tokens)
            : (uDetails ? pick(uDetails.cached_tokens) : null) != null ? pick(uDetails.cached_tokens)
                : pick(u.cache_read_input_tokens)
    ) : null;
    const uInRaw = u ? (pick(u.prompt_tokens) != null ? pick(u.prompt_tokens) : pick(u.input_tokens)) : null;
    // Anthropic 形态的输入不含缓存 → 补上；OpenAI 形态的输入已含缓存 → 不动（`uInclusive` 判定见下）
    const uInclusive = u ? (pick(u.prompt_tokens) != null) : false;
    const uPrompt = uInRaw == null ? null : (uInclusive ? uInRaw : uInRaw + (uCached || 0));
    const uResp = u ? (pick(u.completion_tokens) != null ? pick(u.completion_tokens) : pick(u.output_tokens)) : null;
    const measured = uPrompt != null || uResp != null;
    // 估算口径与管线状态**同一件**（`core/pipeline.js#estTokens`：ceil(字符/4)）
    const promptTokens = uPrompt != null ? uPrompt : estTokens(r.promptChars);
    const respTokens = uResp != null ? uResp : estTokens(r.respChars);
    const cachedTokens = uCached != null ? uCached : 0;
    const label = String(r.label || '(未标注)').slice(0, 60);
    const model = String(r.model || '(未识别)').slice(0, 80);
    const cost = costBreakdown({ model: model, promptTokens: promptTokens, respTokens: respTokens, cachedTokens: cachedTokens });
    const entry = {
        at: Math.max(0, Math.round(Number(r.at) || Number(hooks.now()) || 0)),
        label: label,
        model: model,
        channel: String(r.channel || '').slice(0, 12),
        purpose: String(r.purpose || '').slice(0, 12),
        ok: r.ok !== false,
        ms: Math.max(0, Math.round(Number(r.ms) || 0)),
        promptChars: Math.max(0, Math.round(Number(r.promptChars) || 0)),
        respChars: Math.max(0, Math.round(Number(r.respChars) || 0)),
        promptTokens: promptTokens,
        respTokens: respTokens,
        cachedTokens: cachedTokens,
        totalTokens: promptTokens + respTokens,
        usageSource: measured ? 'usage' : 'estimate',
        priced: cost.cny != null,
        priceKey: cost.entry ? cost.entry.id : '',
        priceSrc: cost.source,
        costCny: cost.cny,
        costMicro: cost.cny == null ? null : Math.round(cost.cny * 1e6),
    };
    // 明细环（最新的在末尾）
    l.log.push(entry);
    if (l.log.length > AI_USAGE_KEEP) l.log = l.log.slice(-AI_USAGE_KEEP);
    // 累计聚合
    const a = l.agg;
    a.n += 1;
    if (entry.ok) a.okN += 1; else a.failN += 1;
    a.promptTokens += promptTokens;
    a.respTokens += respTokens;
    a.cachedTokens += cachedTokens;
    a.totalTokens += entry.totalTokens;
    a.unpricedN += entry.priced ? 0 : 1;
    if (measured) a.measuredN += 1; else a.estimatedN += 1;
    if (entry.costMicro != null) a.costMicro += entry.costMicro;
    if (!a.firstAt) a.firstAt = entry.at;
    a.lastAt = entry.at;
    // 分维度（按标签 / 按模型）
    bumpBucket(a.byLabel, label, entry);
    bumpBucket(a.byModel, model, entry);
    persistLedger();
    return entry;
}

/** 汇总快照（UI / 调试桥 / 测试共用；**只读**，深拷贝返回） */
export function aiUsageSummary() {
    const l = ensureLoaded();
    const a = l.agg;
    const costCny = a.costMicro / 1e6;
    return {
        n: a.n, okN: a.okN, failN: a.failN,
        promptTokens: a.promptTokens, respTokens: a.respTokens, cachedTokens: a.cachedTokens, totalTokens: a.totalTokens,
        costCny: costCny, costMicro: a.costMicro,
        unpricedN: a.unpricedN, measuredN: a.measuredN, estimatedN: a.estimatedN,
        firstAt: a.firstAt, lastAt: a.lastAt,
        usdCny: usdCnyRate(),
        priceAsOf: TOKEN_PRICE_ASOF,
        priceCount: tokenPriceList().length,
        byLabel: JSON.parse(JSON.stringify(a.byLabel || {})),
        byModel: JSON.parse(JSON.stringify(a.byModel || {})),
        keep: AI_USAGE_KEEP,
        logN: (l.log || []).length,
    };
}

/** 最近 N 条明细（**倒序**：最新的在前；只读深拷贝） */
export function aiUsageRecent(limit) {
    const l = ensureLoaded();
    const n = Math.max(1, Math.round(Number(limit) || 10));
    return JSON.parse(JSON.stringify((l.log || []).slice(-n).reverse()));
}

/** 价格覆盖（只读深拷贝；`{ [id]: {in, out, cachedIn, cur, label, match, note} }`） */
export function tokenPriceOverrides() {
    const l = ensureLoaded();
    return JSON.parse(JSON.stringify(l.prices || {}));
}

/**
 * 写入**整份**价格覆盖（设定页的 JSON 文本域提交入口）。
 * @returns {{ok:boolean, n?:number, reason?:string}}
 */
export function setTokenPriceOverrides(obj) {
    const l = ensureLoaded();
    if (obj === null || obj === undefined || obj === '') {
        l.prices = {};
        persistLedger();
        return { ok: true, n: 0 };
    }
    if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: '价格覆盖必须是一个 JSON 对象（{ 条目键: { in, out } }）' };
    const out = {};
    for (const id of Object.keys(obj)) {
        const v = obj[id];
        if (!v || typeof v !== 'object') continue;
        const s = String(id).trim();
        if (!s) continue;
        out[s] = {
            in: v.in, out: v.out, cachedIn: v.cachedIn, cur: v.cur, label: v.label, match: v.match, note: v.note,
        };
    }
    l.prices = out;
    persistLedger();
    return { ok: true, n: Object.keys(out).length };
}
/** 写入汇率（`0` / 非法 → 回落默认） */
export function setUsdCnyRate(v) {
    const l = ensureLoaded();
    const n = Number(v);
    l.usdCny = (Number.isFinite(n) && n > 0 && n < 1000) ? n : 0;
    persistLedger();
    return usdCnyRate();
}
/** 清空账本（**不动**价格覆盖与汇率） */
export function resetAiUsage() {
    const l = ensureLoaded();
    l.log = [];
    l.agg = emptyAgg();
    persistLedger();
    return aiUsageSummary();
}

/** 人民币展示（≤ 0.01 元保留 4 位；`null` → 「未定价」） */
export function fmtCny(v) {
    if (v == null || !Number.isFinite(Number(v))) return '未定价';
    const n = Number(v);
    if (n === 0) return '¥0.00';
    const digits = n < 0.01 ? 4 : 2;
    return '¥' + n.toFixed(digits);
}
/** 千分位整数展示（token 数用） */
export function fmtInt(v) {
    const n = Math.max(0, Math.round(Number(v) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** 时间展示（本地时区；0 → 空串） */
export function fmtWhen(at) {
    const n = Number(at);
    if (!Number.isFinite(n) || n <= 0) return '';
    try { return new Date(n).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(n); }
}
