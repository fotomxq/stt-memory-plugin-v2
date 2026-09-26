// ============================================================
// host/ai-recall.js —— **第二/三层：关键词提取（kw API）与记忆分析发送（mem API）**（v2.58.0）
//
// V1 出处：`src/FTT记忆组件-v1.206.js`
//   · `jsExtractKeywords(floorText)` 约 11213（**已在 V2** `core/parallel.js` 逐字移植）
//   · `extractKeywordsFromText(floorText)` 约 12568~12584：`keywordExtract` 模板 + 正文 → AI → JSON 数组 → 前 10 个
//   · `analyzeMemorySend(keywords, floorText)` 约 12586~12604：`memorySend` 模板 + 【当前剧情日期】+【关键词】
//     +【记忆库】+【最近对话】(末 3000 字) → AI → 注入行文本
// 通道：kw 用 `resolveKwApiOverride()`（分组 `kwApiPreset` → 内联 `kwApi` → 主配置），
//   mem 用 `resolveMemApiOverride()`（分组 `memApiPreset` → 内联 `memApi` → 主配置）—— 见 `core/api-channel.js`
//   （V2 已就位：`resolveApiTarget({purpose:'kw'|'mem'})`，含「分组优先于内联」的 V1 语义）。
// 约定：不抛异常；未配置/调用失败 → `{ok:false, reason, error}`，调用方降级到本地召回。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { defaultCfg } from '../core/config.js';
import { resolveApiTarget } from '../core/api-channel.js';
import { sendWithTarget } from './api-channel.js';
import { debugLogPush } from '../adapters/debug-log.js';

const str = (v) => String(v == null ? '' : v).trim();

/** 取提示词模板（用户自定义优先，缺失回退默认；V1 `cfg.promptTemplates || defaultCfg.promptTemplates` 同款） */
function template(name) {
    try {
        const t = (cfg.promptTemplates || {})[name];
        if (str(t)) return String(t);
    } catch (e) { /* 忽略 */ }
    try { return String(((defaultCfg || {}).promptTemplates || {})[name] || ''); } catch (e) { return ''; }
}
function log(kind, data) { try { debugLogPush(kind, data); } catch (e) { /* 忽略 */ } }

/** 解析 JSON 数组（V1 `extractJsonArray` 的等价物：截取第一个 `[` 到最后一个 `]`；失败 → []） */
export function parseJsonArray(text) {
    const s = String(text == null ? '' : text);
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    try {
        const j = JSON.parse(s.slice(a, b + 1));
        return Array.isArray(j) ? j : [];
    } catch (e) { return []; }
}

/**
 * 第三层 · AI 关键词提取（kw API）。
 * @param {string} floorText
 * @returns {Promise<{ok:boolean, keywords:string[], error?:string, via?:string}>}
 */
export async function extractKeywordsFromText(floorText) {
    const text = String(floorText == null ? '' : floorText);
    if (!str(text)) return { ok: false, keywords: [], error: '正文为空' };
    const target = resolveApiTarget({ purpose: 'kw' });
    const use = (() => { try { return { ok: true, target: target }; } catch (e) { return { ok: false, error: str((e && e.message) || e) }; } })();
    if (!use.ok) return { ok: false, keywords: [], error: use.error };
    const r = await sendWithTarget(target, {
        systemPrompt: template('keywordExtract'),
        prompt: '【正文】\n' + text.slice(-6000),
    });
    if (!r.ok) return { ok: false, keywords: [], error: r.error };
    const arr = parseJsonArray(r.text);
    const kws = [];
    for (const x of arr) { const k = str(x); if (k && kws.indexOf(k) < 0 && kws.length < 10) kws.push(k); }
    log('关键词', { source: 'keywordApi', count: kws.length, list: kws.slice(0, 8), via: r.via || target.channel });
    return { ok: kws.length > 0, keywords: kws, via: r.via || target.channel };
}

/**
 * 第三层 · 记忆分析发送（mem API）：让 AI 从记忆库里挑出该发送的条目。
 * @param {string[]} keywords
 * @param {string} floorText 最近对话正文
 * @param {string} dumpText 记忆库文本（调用方给 `FTT.stateDump()` / 诊断口径）
 * @returns {Promise<{ok:boolean, text:string, error?:string, via?:string}>}
 */
export async function analyzeMemorySend(keywords, floorText, dumpText) {
    const target = resolveApiTarget({ purpose: 'mem' });
    const storyNow = (() => { try { const s = requireStateNow(); return s; } catch (e) { return ''; } })();
    const nowNote = storyNow ? ('【当前剧情日期】' + storyNow + '（「今天」即此日）\n\n') : '';
    const prompt = nowNote
        + '【关键词】' + ((Array.isArray(keywords) ? keywords : []).map(str).filter(Boolean).join('、') || '（无）')
        + '\n\n【记忆库】\n' + String(dumpText == null ? '' : dumpText)
        + '\n\n【最近对话】\n' + String(floorText == null ? '' : floorText).slice(-3000);
    const r = await sendWithTarget(target, { systemPrompt: template('memorySend'), prompt: prompt });
    if (!r.ok) return { ok: false, text: '', error: r.error };
    const out = str(r.text);
    log('发送记忆', { source: 'memApi', chars: out.length, via: r.via || target.channel });
    return { ok: !!out, text: out, via: r.via || target.channel };
}

/** 当前剧情日期（runtine 注入；缺失 → ''） */
let stateNowFn = () => '';
export function setAiRecallHooks(next) { if (next && typeof next.getStoryNow === 'function') stateNowFn = next.getStoryNow; return true; }
function requireStateNow() { try { return str(stateNowFn()); } catch (e) { return ''; } }

/** 第三层是否就绪（mem 通道是否配置；设置页/测试动作用） */
export function aiLayerInfo() {
    const mem = resolveApiTarget({ purpose: 'mem' });
    const kw = resolveApiTarget({ purpose: 'kw' });
    return {
        kw: { configured: !!(kw && (kw.channel === 'host' || str(kw.apiUrl) || str(kw.profileId))), channel: str(kw && kw.channel), preset: str(cfg.kwApiPreset), inline: !!cfg.kwApiEnabled },
        mem: { configured: !!(mem && (mem.channel === 'host' || str(mem.apiUrl) || str(mem.profileId))), channel: str(mem && mem.channel), preset: str(cfg.memApiPreset), inline: !!cfg.memApiEnabled },
        template: { keywordExtract: !!template('keywordExtract'), memorySend: !!template('memorySend') },
        defaultTemplates: !!defaultCfg,
    };
}
