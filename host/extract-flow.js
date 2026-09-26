// ============================================================
// host/extract-flow.js —— **发送前「提取记忆」三层流程编排**（v2.58.0，对齐 V1 v1.206）
//
// V1 出处：`src/FTT记忆组件-v1.206.js` 约 21900 附近的发送前流程（`useKeywordFlow` 闸门）+ `testLayer`（27340）：
//   ① 第一层 🟢 向量检索：关键词 → embedding → 余弦 → TopN（可 rerank 精排）；
//   ② 第二层 🟡 浏览器 JS 抽取：`jsExtractKeywords` + 本地召回（零 API 消耗）；
//   ③ 第三层 🔴 AI 分析：关键词提取（kw API）与记忆分析发送（mem API）。
//   命中即返回该层结果；任一层失败/未命中自动进入下一层。
//
// V2 落点（与 V1 的差异只在于「宿主形态」，见 docs/P10v）：
//   · 第二层的「本地召回」= `core/recall.js#buildMemoryBodyForInject`（V2 既有注入体装配，逐字移植 V1）；
//   · 关键词统一由 `core/parallel.js#jsExtractKeywords` 抽取（V1 同函数），AI 关键词仅在 JS 抽不到时使用；
//   · 本模块只做编排与降级：真正的网络在 `host/vector-recall.js` / `host/ai-recall.js`，
//     注入体装配在 `core/recall.js`（保持内核纯净度）。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { jsExtractKeywords } from '../core/parallel.js';
import { buildMemoryBodyForInject } from '../core/recall.js';
import { vectorRecall } from './vector-recall.js';
import { extractKeywordsFromText, analyzeMemorySend } from './ai-recall.js';
import { debugLogPush } from '../adapters/debug-log.js';

const str = (v) => String(v == null ? '' : v).trim();
function log(kind, data) { try { debugLogPush(kind, data); } catch (e) { /* 忽略 */ } }

/**
 * 三层流程（返回第一层命中的结果；全部未命中 → `hits=[]` 且 `reason` 说明原因）。
 * @param {string} floorText 最近楼层正文（查询意图来源）
 * @param {{queryText?:string, charBudget?:number, topN?:number, minScore?:number, stateDump?:string, layers?:string[]}} [opts]
 * @returns {Promise<{ok:boolean, lines:string[], hitLayer:string, keywords:string[], reason:string, trace:object[]}>}
 */
export async function runExtractFlow(floorText, opts) {
    const o = opts || {};
    const trace = [];
    const text = String(floorText == null ? '' : floorText);
    const queryText = str(o.queryText);
    let keywords = jsExtractKeywords(text || queryText);
    if (!Array.isArray(keywords)) keywords = [];
    trace.push({ layer: 'keywords', via: 'js', count: keywords.length });

    const want = Array.isArray(o.layers) && o.layers.length ? o.layers : ['vector', 'js', 'ai'];

    // ① 向量层
    if (want.indexOf('vector') >= 0 && cfg.useVector === true) {
        let kws = keywords.slice();
        if (!kws.length && str(text)) {
            const kw = await extractKeywordsFromText(text);
            trace.push({ layer: 'keywords', via: 'kwApi', count: kw.keywords.length, ok: kw.ok, error: kw.error || '' });
            kws = kw.keywords.slice();
        }
        const v = await vectorRecall(kws, { topN: o.topN, minScore: o.minScore });
        trace.push({ layer: 'vector', ok: v.ok, count: v.count, reason: v.reason || '', error: v.error || '', ms: v.ms, stats: v.stats || null });
        if (v.ok && v.lines.length) {
            log('向量', { action: 'flow-hit', layer: 'vector', count: v.count, ms: v.ms });
            return { ok: true, lines: v.lines, hitLayer: 'vector', keywords: kws, reason: '', trace: trace };
        }
    }

    // ② 浏览器 JS 抽取层（= V2 既有本地召回装配）
    if (want.indexOf('js') >= 0 && cfg.jsExtractEnabled !== false) {
        const body = buildMemoryBodyForInject(queryText || keywords.join(' '), {
            charBudget: o.charBudget != null ? o.charBudget : cfg.charBudget,
            maxAtoms: cfg.maxAtoms, maxMemories: cfg.maxMemories,
            countUses: false, inject: true,
        });
        const lines = String(body || '').split('\n').filter((x) => str(x));
        trace.push({ layer: 'js', ok: lines.length > 0, count: lines.length });
        if (lines.length) {
            return { ok: true, lines: lines, hitLayer: 'js', keywords: keywords, reason: '', trace: trace };
        }
    }

    // ③ AI 分析层（mem API：直接从记忆库里挑要发送的条目）
    if (want.indexOf('ai') >= 0 && cfg.useKeywordFlow === true) {
        const mem = await analyzeMemorySend(keywords, text, o.stateDump || '');
        const lines = String(mem.text || '').split('\n').filter((x) => str(x));
        trace.push({ layer: 'ai', ok: mem.ok && lines.length > 0, count: lines.length, error: mem.error || '', via: mem.via || '' });
        if (mem.ok && lines.length) {
            log('发送记忆', { action: 'flow-hit', layer: 'ai', count: lines.length });
            return { ok: true, lines: lines, hitLayer: 'ai', keywords: keywords, reason: '', trace: trace };
        }
    }

    return { ok: false, lines: [], hitLayer: '', keywords: keywords, reason: 'no-hit', trace: trace };
}

/** 单层测试（V1 `testLayer`）：layer = vector | js | ai */
export async function testLayer(layer, floorText, opts) {
    const l = str(layer);
    const o = opts || {};
    const text = String(floorText == null ? '' : floorText);
    const started = Date.now();
    try {
        const want = l === 'vector' ? ['vector'] : (l === 'js' ? ['js'] : ['ai']);
        if (l === 'vector' && cfg.useVector !== true) return { ok: false, layer: l, count: 0, reason: 'disabled', note: '请先启用「启用向量检索」', keywords: [], lines: [] };
        if (l === 'ai' && cfg.useKeywordFlow !== true) return { ok: false, layer: l, count: 0, reason: 'disabled', note: '请先开启「发送前提取关键词流程」（第三层）', keywords: [], lines: [] };
        const r = await runExtractFlow(text, Object.assign({}, o, { layers: want }));
        return {
            ok: r.ok, layer: l, count: r.lines.length, keywords: r.keywords,
            lines: r.lines.slice(0, 60), reason: r.reason, trace: r.trace, ms: Date.now() - started,
            note: r.ok ? ('命中 ' + r.lines.length + ' 条' + (r.keywords.length ? ' · 关键词：' + r.keywords.slice(0, 6).join('、') : '')) : ('未命中（' + (r.reason || 'unknown') + '）'),
        };
    } catch (e) {
        return { ok: false, layer: l, count: 0, reason: 'error', note: String((e && e.message) || e).slice(0, 120), keywords: [], lines: [] };
    }
}
