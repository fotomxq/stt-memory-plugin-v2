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
import { aiBusy } from '../core/ai-hooks.js';
import { jsExtractKeywords } from '../core/parallel.js';
import { buildMemoryBodyForInject } from '../core/recall.js';
import { vectorRecall } from './vector-recall.js';
import { extractKeywordsFromText, analyzeMemorySend } from './ai-recall.js';
import { debugLogPush } from '../adapters/debug-log.js';

const str = (v) => String(v == null ? '' : v).trim();
function log(kind, data) { try { debugLogPush(kind, data); } catch (e) { /* 忽略 */ } }

// ============================================================
// v3.26.3（用户要求）：「总览的召回完成提示，应增加**用什么方式召回**的。」
//
// 事实：三层流程（向量 → 本地 JS 抽取 → AI 分析）各自都可能命中，也可能整条降级到
//   `host/inject.js` 的**本地兜底**；而旧提示只把 `hitLayer` 映射成「向量层 / JS 抽取层 / AI 分析层」，
//   且**流程未进入**（向量与 AI 都未启用）时标签为空 —— 用户看不出「这次到底靠什么召回」，
//   更看不出「为什么没用向量」。
// 口径：把「实际经过」说成一句人话 —— labels 固定为 **向量召回 / 本地关键词召回 / AI 分析召回**，
//   并附**降级 / 跳过原因**（向量未启用 / 向量无命中 / 向量请求失败 / 长任务在途 → 跳过 AI 层 …）。
// ============================================================
/** 召回方式标签（对外统一词表；面板提示与诊断共用） */
export const RECALL_METHOD_LABELS = Object.freeze({
    vector: '向量召回',
    local: '本地关键词召回',
    ai: 'AI 分析召回',
});

/** 向量层未命中/不可用的原因 → 人话（用于「为什么降级到本地」） */
const VECTOR_REASON_TEXT = Object.freeze({
    disabled: '向量未启用',
    'not-configured': '向量未配置',
    'no-keywords': '无关键词可用',
    'empty-bank': '向量库为空',
    'embedding-failed': '向量请求失败',
    'keyword-embedding-failed': '关键词向量失败',
    'no-hit': '向量无命中',
});

/**
 * 召回方式信息（**纯函数**，便于单测）。
 * @param {object} info
 *   `hitLayer` 三层流程命中层（`vector`/`js`/`ai`/`''`）· `trace` 逐层轨迹 ·
 *   `flowEntered` 是否进入三层流程 · `usedLocalFallback` 是否由本地兜底产出正文 ·
 *   `vectorEnabled` / `aiEnabled` 配置态 · `aiSkippedBusy` 长任务在途跳过 AI 层 · `keywords` 关键词
 * @returns {{key:string, label:string, note:string, keywords:string[]}}
 */
export function recallMethodInfo(info) {
    const o = info || {};
    const hit = str(o.hitLayer);
    const trace = Array.isArray(o.trace) ? o.trace : [];
    const kws = (Array.isArray(o.keywords) ? o.keywords : []).map((x) => str(x)).filter(Boolean);
    const kwTxt = kws.length ? ('关键词 ' + kws.length + ' 个') : '无关键词';
    const vectorTrace = trace.filter((x) => x && x.layer === 'vector')[0] || null;
    const vectorReason = (() => {
        if (o.vectorEnabled !== true) return '向量未启用';
        if (vectorTrace) {
            if (vectorTrace.ok === false) return VECTOR_REASON_TEXT[str(vectorTrace.reason)] || ('向量不可用（' + str(vectorTrace.reason || 'unknown') + '）');
            if (Number(vectorTrace.count || 0) <= 0) return '向量无命中';
        }
        return '';
    })();
    const aiReason = (() => {
        if (o.aiSkippedBusy === true) return '长任务在途 → 跳过 AI 层';
        if (o.aiEnabled !== true) return 'AI 层未启用';
        return '';
    })();
    const out = { key: '', label: '', note: '', keywords: kws.slice(0, 6) };
    if (hit === 'vector') {
        out.key = 'vector'; out.label = RECALL_METHOD_LABELS.vector; out.note = kwTxt;
        return out;
    }
    if (hit === 'ai') {
        out.key = 'ai'; out.label = RECALL_METHOD_LABELS.ai; out.note = kwTxt;
        return out;
    }
    if (hit === 'js' || (o.usedLocalFallback === true)) {
        out.key = 'local'; out.label = RECALL_METHOD_LABELS.local;
        // 「已降级」只在**本来开着却没用上**时标注；「向量未启用」是如实陈述，不是降级
        const degraded = (o.vectorEnabled === true && !!vectorReason);
        out.note = [
            kwTxt,
            vectorReason ? (vectorReason + (degraded ? ' → 已降级' : '')) : '',
            o.aiSkippedBusy === true ? '长任务在途 → 跳过 AI 层' : '',
        ].filter(Boolean).join(' · ');
        return out;
    }
    // 没有任何一层产出正文 → 如实说明「用什么方式试过、为什么没成」
    out.note = [o.flowEntered === true ? '三层流程均未命中' : '未进入三层流程', vectorReason, aiReason].filter(Boolean).join(' · ');
    return out;
}

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

    let want = Array.isArray(o.layers) && o.layers.length ? o.layers : ['vector', 'js', 'ai'];
    // v2.74.0（用户要求）：「提取记忆…用独立的向量或固定 JS 为主…确保可以**并行处理**」——
    //   向量层与 JS 层零 AI（纯本地 / 本地向量服务），任何时刻都能跑；**AI 层**才会占用 AI 通道，
    //   因此当有长任务在途（摘要 / 修复 / 推演…）时默认**跳过 AI 层**：与在途任务并行但不去抢它的 AI 调用。
    //   调用方可用 `o.allowAiDuringBusy === true` 强制保留（诊断 / 单层测试）。
    let aiSkippedBusy = false;
    if (want.indexOf('ai') >= 0 && o.allowAiDuringBusy !== true && aiBusy()) { want = want.filter((x) => x !== 'ai'); aiSkippedBusy = true; }
    if (aiSkippedBusy) trace.push({ layer: 'ai', skipped: 'busy', reason: '长任务在途：提取记忆不抢 AI 通道' });

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
