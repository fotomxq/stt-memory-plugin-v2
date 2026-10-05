// ============================================================
// core/nsfw-analyze.js —— **NSFW 词条分析**（v3.19.0，用户要求）
//
// 用户原话：「设定-NSFW弱化，新增词条分析按钮。该功能用于抽取分析被标记为强NSFW的原子数据，
//   交给AI去识别哪些词汇涉及到强NSFW，以及应该提到为什么其他词汇。
//   最后输出保存到转化库，用于后续弱化NSFW使用。」
//
// 口径（逐条落定，全部可机械核对）：
//   ① **抽取**：只取**留档为「强」**（`entry.nsfw === 'strong'`）的条目文本字段（维度/字段白名单与弱化共用
//      `NSFW_FIELD_MAP`）；每批 `NSFW_ANALYZE_BATCH`(12) 个字段，按「未分析过 → 现有词条命中多 → 文本长」
//      排序，余量下次继续；已分析过的字段按**内容指纹**记账（`nsfwAnalyzeLog.seen`，上限 300，超出淘汰最旧），
//      所以反复点按钮会持续推进而不是重复分析同一批数据；
//   ② **AI**：识别「造成强 NSFW 的词」+ 给出柔化后的**转化词** + 一句话理由；严格 JSON；**词必须是本次原文的
//      实际子串**（防造词，删后逐条核对）；
//   ③ **落地**：写入**转化库**（用户明确要求的目标库 → 立刻可被「🔁 立即固定规则替换」与弱化流程使用），
//      同时把同一个词**补进识别词条库**（后续扫描 / 留档判级据此识别同一批词）；
//   ④ **强校验**（每条都给出被丢弃的原因，如实回报，绝不静默）：词非空且长度/字符集合法、词与转化词不同、
//      转化词不得仍露骨（不得命中识别词库）也不得包含原词、词不得已是库内条目（算去重不算错）、
//      词不得是日常词黑名单、词在**非强留档**数据里出现条数 ≥ `NSFW_ANALYZE_SPREAD_MAX` 视为「过泛」丢弃
//      （误伤护栏）、单次落库上限 `NSFW_ANALYZE_MAX_ADD`(40)；
//   ⑤ **记账**：运行时账本 `nsfwAnalyzeLog`（宿主扩展设置，不进数据模型 → `DATA_VERSION` 不变）：
//      最近一次结果 + 最近 10 条新增明细（词→转化词→理由）+ 指纹表；另写一条调试日志。
//
// 本模块**纯内核**（不碰宿主、不落盘、不发事件）：宿主持久化与 AI 调用经 `core/ai-hooks.js`
// 与 `setNsfwAnalyzeHooks({ getLog, saveLog })` 注入；库写入经 `core/nsfw.js` 既有 API（自带物化与去重）。
// ============================================================
import { cfg, saveCfg, notifyHooks, dbgLog } from './model/runtime.js';
import { PROMPT_TEMPLATES_V2 } from './config.js';
import { hashText, extractJsonObject } from './util.js';
import { aiCallText, aiBusy } from './ai-hooks.js';
import { atomIsHidden } from './merge.js';   // 已总结隐藏的情节不参与分析（与 `nsfwScan` 同口径）
import {
    NSFW_FIELD_MAP, NSFW_DIM_LABEL,
    nsfwDimList, nsfwTextFields, nsfwEntryTitle, nsfwKeywordHits, nsfwLevelOf,
    nsfwKeywordList, nsfwRuleList, nsfwKeywordAdd, nsfwRuleAdd,
} from './nsfw.js';

/** 单批提交的字段数（与弱化同口径：一批一次，余量下次继续） */
export const NSFW_ANALYZE_BATCH = 12;
/** 单次最多落库的词条对数（防一次刷爆转化库） */
export const NSFW_ANALYZE_MAX_ADD = 40;
/** 「词」长度上限 */
export const NSFW_ANALYZE_TERM_MAX = 20;
/** 「转化词」长度上限 */
export const NSFW_ANALYZE_TO_MAX = 30;
/** 误伤护栏：词在**非强留档**数据里出现的条目数达到该值即视为「过泛」丢弃 */
export const NSFW_ANALYZE_SPREAD_MAX = 5;
/** 误伤护栏的扫描上限（条；防止在超大库上做全量匹配） */
export const NSFW_ANALYZE_SPREAD_SCAN = 400;
/** 指纹表上限（超出按时间淘汰最旧） */
export const NSFW_ANALYZE_SEEN_CAP = 300;
/** 账本里保留的「最近新增明细」条数 */
export const NSFW_ANALYZE_ITEM_KEEP = 10;
/** 单条字段提交给 AI 的正文长度 */
export const NSFW_ANALYZE_TEXT_CAP = 600;
/** 太短的字段不值得分析（<8 字） */
const NSFW_ANALYZE_TEXT_MIN = 8;

/**
 * 日常词黑名单：**一律不作为匹配词**。
 * 理由：这些词在正常叙事里高频出现，一旦进转化库会被机械替换到各处（误伤），
 *   也不是造成「强 NSFW」的词（AI 偶尔会把它们当成"涉敏词"提出来）。
 * 更广的误伤拦截交给 `nsfwAnalyzeSpread()`（按**非强留档**数据里的实际出现条数判定）。
 */
export const NSFW_ANALYZE_BLOCKLIST = Object.freeze([
    '身体', '眼睛', '房间', '衣服', '声音', '表情', '感觉', '时候', '手指', '手臂', '肌肤', '亲吻', '拥抱',
    '爱情', '欲望', '呼吸', '温度', '汗水', '味道', '夜里', '床上', '女人', '男人', '女孩', '男孩', '胸口',
    '肩膀', '头发', '嘴唇', '脸颊', '目光', '心跳', '衣衫', '醒来', '离开', '靠近', '触碰', '抚摸', '接触',
    '睡衣', '浴室', '大腿', '腰身', '呻吟声',
    'body', 'eyes', 'room', 'clothes', 'voice', 'love', 'kiss', 'hug', 'touch', 'night', 'bed',
    'woman', 'man', 'girl', 'boy', 'skin', 'hand', 'hair', 'warm', 'breath', 'desire', 'sleep',
]);
const NSFW_ANALYZE_BLOCK_SET = (() => {
    const s = new Set();
    try { for (const w of NSFW_ANALYZE_BLOCKLIST) s.add(String(w).toLowerCase()); } catch (e) { /* 忽略 */ }
    return s;
})();

/** 库读写钩子（宿主接线：ST 扩展设置 `nsfwAnalyzeLog`；未接线时退化为进程内账本） */
let hooks = { getLog: null, saveLog: null };
export function setNsfwAnalyzeHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
let localLog = { at: 0, examined: 0, added: 0, dup: 0, rejected: 0, capped: 0, seen: {}, items: [] };
function readLog() {
    try { if (typeof hooks.getLog === 'function') { const v = hooks.getLog(); if (v && typeof v === 'object') return v; } } catch (e) { /* 忽略 */ }
    return localLog;
}
function writeLog(next) {
    localLog = next;
    try { if (typeof hooks.saveLog === 'function') hooks.saveLog(next); } catch (e) { /* 忽略 */ }
}

/** 字段指纹：维度 + 条目 id + 字段路径 + 内容哈希（内容改了即视为新数据，会重新进入分析队列） */
function analyzeFingerprint(dim, id, path, text) {
    try { return String(dim) + '|' + String(id) + '|' + String(path) + '|' + hashText(String(text == null ? '' : text)); }
    catch (e) { return String(dim) + '|' + String(id) + '|' + String(path); }
}
function seenMap() {
    try {
        const lg = readLog();
        return (lg && lg.seen && typeof lg.seen === 'object') ? lg.seen : {};
    } catch (e) { return {}; }
}
/** 记录已分析指纹（超出上限淘汰最旧），返回当前指纹数 */
export function nsfwAnalyzeMarkSeen(keys, at) {
    try {
        const seen = Object.assign({}, seenMap());
        const now = Number(at) || Date.now();
        for (const k of (Array.isArray(keys) ? keys : [])) if (k) seen[String(k)] = now;
        const all = Object.keys(seen);
        if (all.length > NSFW_ANALYZE_SEEN_CAP) {
            all.sort((a, b) => (Number(seen[a]) || 0) - (Number(seen[b]) || 0));
            for (const k of all.slice(0, all.length - NSFW_ANALYZE_SEEN_CAP)) delete seen[k];
        }
        writeLog(Object.assign({}, readLog(), { seen: seen }));
        return Object.keys(seen).length;
    } catch (e) { return 0; }
}
/** 清空分析进度（下次从全部强留档数据重新开始） */
export function nsfwAnalyzeSeenReset() {
    try { writeLog(Object.assign({}, readLog(), { seen: {} })); return true; } catch (e) { return false; }
}
/** 已记录指纹数（只读诊断） */
export function nsfwAnalyzeSeenCount() { return Object.keys(seenMap()).length; }

/**
 * 抽取候选（**只读、零 AI**）：被标记为「强 NSFW」的条目文本字段。
 * @param {{dims?:string[]}} [opts] 限定维度（缺省全部有文本字段的维度）
 * @returns {{items:Array, total:number, unseen:number, strongItems:number, strongFields:number,
 *            scannedItems:number, byDim:object, seenCount:number}}
 */
export function nsfwAnalyzeCandidates(opts) {
    const o = opts || {};
    const dims = (o.dims && o.dims.length) ? o.dims : Object.keys(NSFW_FIELD_MAP);
    const seen = seenMap();
    const items = [];
    const byDim = {};
    let scannedItems = 0, strongItems = 0, strongFields = 0, unseen = 0;
    try {
        for (const dim of dims) {
            if (!NSFW_FIELD_MAP[dim]) continue;
            for (const it of nsfwDimList(dim)) {
                if (!it || !it.id) continue;
                if (dim === 'atoms' && atomIsHidden(it)) continue;    // 已总结隐藏的情节不参与（与 nsfwScan 同口径）
                scannedItems++;
                if (nsfwLevelOf(it) !== 'strong') continue;          // 用户口径：**只看强留档**
                strongItems++;
                const title = nsfwEntryTitle(dim, it);
                for (const f of nsfwTextFields(dim, it)) {
                    const text = String(f.text == null ? '' : f.text).trim();
                    if (text.length < NSFW_ANALYZE_TEXT_MIN) continue;
                    strongFields++;
                    const fp = analyzeFingerprint(dim, it.id, f.path, text);
                    const isSeen = !!seen[fp];
                    if (!isSeen) unseen++;
                    byDim[dim] = (byDim[dim] || 0) + 1;
                    items.push({ dim: dim, id: String(it.id), path: f.path, text: text, title: title, hits: nsfwKeywordHits(text), fp: fp, seen: isSeen, level: 'strong' });
                }
            }
        }
        // 未分析过的优先 → 现有词条命中多者优先 → 文本长者优先 → 维度稳定排序
        items.sort((a, b) => (Number(a.seen) - Number(b.seen))
            || (b.hits.length - a.hits.length)
            || (b.text.length - a.text.length)
            || String(a.dim).localeCompare(String(b.dim)));
    } catch (e) { /* 忽略 */ }
    return { items: items, total: items.length, unseen: unseen, strongItems: strongItems, strongFields: strongFields, scannedItems: scannedItems, byDim: byDim, seenCount: Object.keys(seen).length };
}

/**
 * 打包本批（默认 12 个字段）——**只提交尚未分析过的字段**（已分析过的靠内容指纹排除；
 * 全部分析完由 `runNsfwAnalyze` 的 `all-seen` 短路拦住，可点「♻ 重置分析进度」重来）。
 * `opts.reanalyze === true` 时**连已分析过的字段一起提交**（「重新分析」语义，供调试与显式重跑）。
 * @returns {{entries:Array, total:number, truncated:number, byDim:object, strongItems:number, strongFields:number, unseen:number}}
 */
export function nsfwAnalyzePack(opts) {
    const o = opts || {};
    const scan = nsfwAnalyzeCandidates(o);
    const queue = (o.reanalyze === true) ? scan.items.slice() : scan.items.filter((x) => !x.seen);
    const entries = queue.slice(0, NSFW_ANALYZE_BATCH).map((x, i) => Object.assign({ n: i + 1, label: NSFW_DIM_LABEL[x.dim] || x.dim }, x));
    return {
        entries: entries, total: queue.length, truncated: Math.max(0, queue.length - entries.length),
        byDim: scan.byDim, strongItems: scan.strongItems, strongFields: scan.strongFields, unseen: scan.unseen,
    };
}

/** 提示词兜底（`cfg.promptTemplates.nsfwAnalyze` / 内置模板都取不到时用） */
const ANALYZE_FALLBACK_TPL = '你是内容安全与措辞柔化助手：从给定的「强 NSFW」原文里找出造成露骨的词汇，并各给一个柔性、克制、留白的替换词。';

/** 提示词（与弱化同构：system 模板 + user 清单，要求严格 JSON） */
export function buildNsfwAnalyzePrompt(pack) {
    try {
        const p = pack || nsfwAnalyzePack();
        if (!p.entries.length) return null;
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.nsfwAnalyze) || (PROMPT_TEMPLATES_V2 && PROMPT_TEMPLATES_V2.nsfwAnalyze) || '').trim() || ANALYZE_FALLBACK_TPL;
        const lines = p.entries.map((e) => `#${e.n} ｜ ${e.label} ｜ 字段：${e.path}${e.title ? ` ｜ 条目：${e.title}` : ''}${e.hits.length ? ` ｜ 现有词条命中：${e.hits.slice(0, 6).join('、')}` : ''}\n   原文：${String(e.text).slice(0, NSFW_ANALYZE_TEXT_CAP)}`);
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释，不要复述原文。` },
            { role: 'user', content: `【待分析清单（本次唯一工作对象，共 ${p.entries.length} 条；这些数据已被标记为「强 NSFW」）】\n${lines.join('\n')}\n\n输出：{"词条":[{"编号":1,"词":"原文里出现过的词","替换":"柔化后的替换词","理由":"一句话"}],"无法处理":[2]}（按 #编号 引用；「词」必须**原样出现**在该条原文里；每条最多 6 个词；同一个词只出现一次；找不到可替换的词就把编号放进「无法处理」）。` },
        ];
    } catch (e) { return null; }
}

/** 文本是否包含该词（中文按原样子串；拉丁按大小写不敏感子串） */
export function nsfwAnalyzeContains(text, word) {
    try {
        const t = String(text == null ? '' : text);
        const w = String(word == null ? '' : word).trim();
        if (!w) return false;
        if (/[A-Za-z]/.test(w)) return t.toLowerCase().indexOf(w.toLowerCase()) >= 0;
        return t.indexOf(w) >= 0;
    } catch (e) { return false; }
}

/**
 * **误伤护栏**：该词在**非强留档**数据里出现的条目数（达 `NSFW_ANALYZE_SPREAD_MAX` 即判「过泛」）。
 * 口径：只统计「留档不是强」的条目 —— 一个词若在大量非露骨数据里出现，说明它是日常词，机械替换会误伤。
 * @returns {number} 命中条目数（最多扫 `NSFW_ANALYZE_SPREAD_SCAN` 条，达阈值即提前返回）
 */
export function nsfwAnalyzeSpread(word, opts) {
    const o = opts || {};
    const w = String(word == null ? '' : word).trim();
    if (!w) return 0;
    const dims = (o.dims && o.dims.length) ? o.dims : Object.keys(NSFW_FIELD_MAP);
    const cap = Math.max(1, Number(o.cap) || NSFW_ANALYZE_SPREAD_SCAN);
    let hit = 0, scanned = 0;
    try {
        for (const dim of dims) {
            if (!NSFW_FIELD_MAP[dim]) continue;
            for (const it of nsfwDimList(dim)) {
                if (!it || !it.id) continue;
                if (dim === 'atoms' && atomIsHidden(it)) continue;    // 已总结隐藏的情节不参与（与 nsfwScan 同口径）
                if (nsfwLevelOf(it) === 'strong') continue;          // 非强留档才算「日常出现」
                scanned++;
                if (scanned > cap) return hit;
                for (const f of nsfwTextFields(dim, it)) {
                    if (nsfwAnalyzeContains(f.text, w)) { hit++; break; }
                }
                if (hit >= NSFW_ANALYZE_SPREAD_MAX) return hit;
            }
        }
    } catch (e) { /* 忽略 */ }
    return hit;
}

/** 「词」合法性（长度 + 字符集 + 单字拒绝）：返回 {ok, term, reason} */
export function nsfwAnalyzeTermCheck(term) {
    try {
        const t = String(term == null ? '' : term).trim();
        if (!t) return { ok: false, reason: 'empty' };
        if (t.length > NSFW_ANALYZE_TERM_MAX) return { ok: false, reason: 'term-too-long' };
        // 只允许中英文/数字与内部连字符（不允许空白、标点、正则元字符 —— 防止把规则库变成正则雷区）
        if (!/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5-]*$/.test(t)) return { ok: false, reason: 'bad-chars' };
        const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
        const latin = (t.match(/[A-Za-z0-9]/g) || []).length;
        if (cjk > 0 && cjk < 2 && latin === 0) return { ok: false, reason: 'term-too-short' };     // 单字中文一律不要
        if (latin > 0 && latin < 3 && cjk === 0) return { ok: false, reason: 'term-too-short' };    // 拉丁词干 <3 字母太危险
        return { ok: true, term: t };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 该词是否已是库内条目（识别词条库 or 转化库的匹配词；大小写不敏感） */
export function nsfwAnalyzeIsKnown(term) {
    try {
        const t = String(term == null ? '' : term).trim().toLowerCase();
        if (!t) return false;
        if (nsfwKeywordList().some((k) => String(k).trim().toLowerCase() === t)) return true;
        if (nsfwRuleList().some((r) => String(r && r.from).trim().toLowerCase() === t)) return true;
        return false;
    } catch (e) { return false; }
}

/** 从 AI delta 里取「词条」数组（兼容多种键名/结构） */
function pickPairs(delta) {
    const d = delta || {};
    const list = (d['词条'] !== undefined) ? d['词条'] : (d.pairs !== undefined ? d.pairs : (d.items !== undefined ? d.items : d.terms));
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
        if (!raw || typeof raw !== 'object') continue;
        const from = raw['词'] !== undefined ? raw['词'] : (raw['匹配词'] !== undefined ? raw['匹配词'] : (raw.from !== undefined ? raw.from : (raw.term !== undefined ? raw.term : raw.word)));
        const to = raw['替换'] !== undefined ? raw['替换'] : (raw['转化词'] !== undefined ? raw['转化词'] : (raw.to !== undefined ? raw.to : (raw.replace !== undefined ? raw.replace : raw.replacement)));
        const why = raw['理由'] !== undefined ? raw['理由'] : (raw.why !== undefined ? raw.why : (raw.reason !== undefined ? raw.reason : raw.note));
        const n = raw['编号'] !== undefined ? raw['编号'] : (raw.n !== undefined ? raw.n : (raw.id !== undefined ? raw.id : raw.index));
        out.push({ from: String(from == null ? '' : from), to: String(to == null ? '' : to), why: String(why == null ? '' : why).replace(/\s+/g, ' ').slice(0, 40), n: Number(String(n == null ? '' : n).replace(/[^0-9]/g, '')) });
    }
    return out;
}

/**
 * **强校验**（纯函数、不写库）：把 AI 结果过滤成「可落库的 词→转化词」清单。
 * @param {object} pack `nsfwAnalyzePack()` 的结果（用 entries 里的原文做「词必须出现」核对与来源标注）
 * @param {object} delta AI 返回的归一化对象
 * @param {{maxAdd?:number, spreadMax?:number, skipSpread?:boolean}} [opts]
 * @returns {{accepted:Array, rejected:Array, capped:number, examined:number}}
 */
export function nsfwAnalyzeSanitize(pack, delta, opts) {
    const o = opts || {};
    const p = pack || { entries: [] };
    const maxAdd = Math.max(1, Number(o.maxAdd) || NSFW_ANALYZE_MAX_ADD);
    const spreadMax = Number.isFinite(Number(o.spreadMax)) ? Number(o.spreadMax) : NSFW_ANALYZE_SPREAD_MAX;
    const entries = Array.isArray(p.entries) ? p.entries : [];
    const allText = entries.map((e) => String(e.text == null ? '' : e.text)).join('\n');
    const accepted = [];
    const rejected = [];
    const seen = {};
    let capped = 0;
    const pairs = pickPairs(delta);
    for (const row of pairs) {
        const why = row.why;
        const term = nsfwAnalyzeTermCheck(row.from);
        if (!term.ok) { rejected.push({ from: row.from, to: row.to, reason: term.reason }); continue; }
        const from = term.term;
        const to = String(row.to == null ? '' : row.to).trim();
        if (!to) { rejected.push({ from: from, to: row.to, reason: 'to-empty' }); continue; }
        if (to.length > NSFW_ANALYZE_TO_MAX) { rejected.push({ from: from, to: to, reason: 'to-too-long' }); continue; }
        if (!/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5-]*$/.test(to)) { rejected.push({ from: from, to: to, reason: 'to-bad-chars' }); continue; }
        if (from.toLowerCase() === to.toLowerCase()) { rejected.push({ from: from, to: to, reason: 'same' }); continue; }
        if (nsfwAnalyzeContains(to, from)) { rejected.push({ from: from, to: to, reason: 'to-contains-term' }); continue; }
        if (nsfwKeywordHits(to).length) { rejected.push({ from: from, to: to, reason: 'to-still-nsfw' }); continue; }
        if (NSFW_ANALYZE_BLOCK_SET.has(from.toLowerCase())) { rejected.push({ from: from, to: to, reason: 'blocklist' }); continue; }
        // 词必须真的出现在本次提交的原文里（防 AI 造词 / 改写）
        if (!nsfwAnalyzeContains(allText, from)) { rejected.push({ from: from, to: to, reason: 'not-in-text' }); continue; }
        // 去重：同一批里重复 / 已在库里
        const key = from.toLowerCase();
        if (seen[key]) { rejected.push({ from: from, to: to, reason: 'dup-batch' }); continue; }
        seen[key] = true;
        if (nsfwAnalyzeIsKnown(from)) { rejected.push({ from: from, to: to, reason: 'dup-library' }); continue; }
        // 误伤护栏：词在非强留档数据里过泛 → 不落库（可在页内手动新增）
        if (o.skipSpread !== true && spreadMax > 0) {
            const spread = nsfwAnalyzeSpread(from);
            if (spread >= spreadMax) { rejected.push({ from: from, to: to, reason: 'wide-use', spread: spread }); continue; }
        }
        if (accepted.length >= maxAdd) { capped++; continue; }
        const src = entries.find((e) => Number(e.n) === Number(row.n)) || null;
        accepted.push({ from: from, to: to, why: why, from_n: Number(row.n) || 0, dim: src ? src.dim : '', path: src ? src.path : '', title: src ? src.title : '' });
    }
    return { accepted: accepted, rejected: rejected, capped: capped, examined: pairs.length };
}

/**
 * **落地**：把校验通过的对写入**转化库**（用户要求的目标库）+ 识别词条库，并记账。
 * @param {object} pack
 * @param {object} delta AI 返回
 * @param {{silent?:boolean, skipSpread?:boolean, maxAdd?:number, now?:number}} [opts]
 * @returns {{ok:boolean, added:number, dup:number, rejected:number, capped:number, examined:number,
 *            details:Array, rejectedList:Array, rules:number, keywords:number}}
 */
export function applyNsfwAnalyzeResult(pack, delta, opts) {
    const o = opts || {};
    const out = { ok: true, added: 0, dup: 0, rejected: 0, capped: 0, examined: 0, details: [], rejectedList: [], rules: 0, keywords: 0 };
    try {
        const san = nsfwAnalyzeSanitize(pack, delta, o);
        out.examined = san.examined;
        out.capped = san.capped;
        // 「已在库」单独计数（与「丢弃不合格」区分：前者是正常的去重，后者是真的不合格）
        const dupList = san.rejected.filter((x) => x.reason === 'dup-library');
        out.dup = dupList.length;
        out.rejectedList = san.rejected.filter((x) => x.reason !== 'dup-library');
        for (const a of san.accepted) {
            // ① 转化库（用户明确要求；`nsfwRuleAdd` 自带物化内置库 + 匹配词去重 + 长度截断）
            const r1 = nsfwRuleAdd(a.from, a.to);
            // ② 识别词条库（同一批词 —— 后续扫描与留档判级据此识别）
            const r2 = nsfwKeywordAdd(a.from);
            if (r1 && r1.ok) {
                out.added++;
                out.details.push({ from: a.from, to: a.to, why: a.why, dim: a.dim, path: a.path, kwAdded: !!(r2 && r2.ok) });
            } else if (r1 && r1.reason === 'dup') {
                out.dup++;                 // 极端竞态（同一秒内被别处加入）也如实计入「已在库」
            } else {
                out.rejectedList.push({ from: a.from, to: a.to, reason: String((r1 && r1.reason) || 'add-failed') });
            }
        }
        out.rejected = out.rejectedList.length;
        out.rules = nsfwRuleList().length;
        out.keywords = nsfwKeywordList().length;
        // ③ 记账（最近一次结果 + 最近 10 条新增明细；指纹由调用方按「实际提交过的字段」记录）
        const at = Number(o.now) || Date.now();
        const lg = readLog();
        const items = (Array.isArray(lg && lg.items) ? lg.items : []).concat(out.details.map((d) => ({ at: at, from: d.from, to: d.to, why: d.why }))).slice(-NSFW_ANALYZE_ITEM_KEEP);
        writeLog(Object.assign({}, lg, {
            at: at, examined: out.examined, added: out.added, dup: out.dup, rejected: out.rejected, capped: out.capped,
            items: items,
        }));
        if (out.added && o.silent !== true) {
            try { dbgLog('弱化', `词条分析：新增 ${out.added} 条转化规则（识别词条库 +${out.added}）`); } catch (e) { /* 忽略 */ }
        }
    } catch (e) { out.ok = false; }
    return out;
}

/** 只读状态（设定页状态行与诊断用） */
export function nsfwAnalyzeState() {
    const empty = {
        candidates: 0, strongFields: 0, strongItems: 0, unseen: 0, scannedItems: 0, byDim: {},
        batch: NSFW_ANALYZE_BATCH, cap: NSFW_ANALYZE_MAX_ADD, keywords: 0, rules: 0, seen: 0, last: null, items: [],
    };
    try {
        const c = nsfwAnalyzeCandidates();
        const lg = readLog();
        const items = (Array.isArray(lg && lg.items) ? lg.items : []).slice(-NSFW_ANALYZE_ITEM_KEEP).reverse();
        return {
            candidates: c.total, strongFields: c.strongFields, strongItems: c.strongItems, unseen: c.unseen,
            scannedItems: c.scannedItems, byDim: c.byDim,
            batch: NSFW_ANALYZE_BATCH, cap: NSFW_ANALYZE_MAX_ADD,
            keywords: nsfwKeywordList().length, rules: nsfwRuleList().length, seen: c.seenCount,
            last: (lg && Number(lg.at)) ? {
                at: Number(lg.at) || 0, examined: Number(lg.examined) || 0, added: Number(lg.added) || 0,
                dup: Number(lg.dup) || 0, rejected: Number(lg.rejected) || 0, capped: Number(lg.capped) || 0,
            } : null,
            items: items,
        };
    } catch (e) { return empty; }
}

/** 通知（宿主 toast 钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/**
 * 手动流程（设定 → NSFW弱化「🧠 词条分析」按钮）。
 * @param {{silent?:boolean, reset?:boolean, aiText?:string, maxAdd?:number, skipSpread?:boolean, now?:number}} [opts]
 *   `aiText` 仅测试注入；`reset` 清空分析进度后重来
 */
export async function runNsfwAnalyze(opts) {
    const o = opts || {};
    try {
        if (o.reset === true) {
            nsfwAnalyzeSeenReset();
            const st = nsfwAnalyzeState();
            if (o.silent !== true) notify('info', '词条分析：已重置分析进度', `下次会重新分析全部 ${st.strongFields} 处强留档字段。`);
            return { ok: true, reset: true, strongFields: st.strongFields, unseen: st.unseen };
        }
        const pre = nsfwAnalyzeCandidates();
        if (!pre.total) {
            const msg = pre.strongItems
                ? `扫描 ${pre.scannedItems} 条：留档为「强」的 ${pre.strongItems} 条里没有可分析的文本字段（过短或字段为空）。`
                : `扫描 ${pre.scannedItems} 条：没有留档为「强」的条目 —— 先到上面「📌 NSFW 等级留档」点「🔖 立即补档」，或等新数据写入后再试。`;
            if (o.silent !== true) notify('info', '词条分析：没有可分析的强留档数据', msg);
            return { ok: false, skipped: 'no-strong', strongItems: pre.strongItems, strongFields: pre.strongFields, scannedItems: pre.scannedItems, total: 0 };
        }
        if (o.reanalyze !== true && pre.total > 0 && pre.unseen === 0) {
            const msg = `强留档字段 ${pre.strongFields} 处**全部已分析过**（进度 ${pre.seenCount} 处）——`
                + '没有新的强留档数据，本次不调用 AI（省 token）；要重新分析同一批数据请点「♻ 重置分析进度」。';
            if (o.silent !== true) notify('info', '词条分析：本批已全部分析过', msg);
            return { ok: false, skipped: 'all-seen', strongItems: pre.strongItems, strongFields: pre.strongFields, seen: pre.seenCount, total: pre.total };
        }
        if (aiBusy()) {
            if (o.silent !== true) notify('warning', '任务进行中', '已有修复/摘要/同步任务在运行，请稍候再试。');
            return { ok: false, blocked: true };
        }
        const pack = nsfwAnalyzePack({ reanalyze: o.reanalyze === true });
        const prompt = buildNsfwAnalyzePrompt(pack);
        if (!prompt) { notify('info', '词条分析：无待分析条目', '清单为空。'); return { ok: false, skipped: 'empty-pack' }; }
        const t0 = Date.now();
        const dimTxt = Object.keys(pack.byDim).map((k) => `${NSFW_DIM_LABEL[k] || k} ${pack.byDim[k]}`).join(' · ');
        if (o.silent !== true) {
            notify('info', '开始分析 NSFW 词条…', `强留档字段 ${pre.strongFields} 处（未分析 ${pre.unseen} 处）${dimTxt ? `（${dimTxt}）` : ''} · 本次提交 ${pack.entries.length} 处${pack.truncated ? `（余 ${pack.truncated} 处下次继续）` : ''}`);
        }
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, 'NSFW词条分析'));
        if (!resp) {
            if (o.silent !== true) notify('warning', '词条分析：AI 无返回', 'AI 未返回内容（可能未配置模型或请求失败），未改动任何数据（进度也未推进）。');
            return { ok: false, error: 'no-ai', examined: pack.entries.length, total: pack.total, truncated: pack.truncated };
        }
        const delta = extractJsonObject(resp) || {};
        const r = applyNsfwAnalyzeResult(pack, delta, { silent: o.silent === true, maxAdd: o.maxAdd, skipSpread: o.skipSpread === true, now: o.now });
        if (r.added) { try { saveCfg(); } catch (e) { /* 忽略：内存态已写入 */ } }
        // 无论是否落库都推进进度（本次提交过的字段不再重复分析；内容变化会生成新指纹重新入队）
        const seenN = nsfwAnalyzeMarkSeen(pack.entries.map((e) => e.fp), o.now);
        const parts = [];
        if (r.added) parts.push(`已新增 ${r.added} 条转化规则（同批补进识别词条库）`);
        if (r.dup) parts.push(`已在库中跳过 ${r.dup} 条`);
        if (r.rejected) parts.push(`丢弃不合格 ${r.rejected} 条`);
        if (r.capped) parts.push(`超出单次上限未落库 ${r.capped} 条`);
        if (!r.added && !r.dup && !r.rejected) parts.push('AI 未给出可用词条');
        const detailTxt = r.details.slice(0, 3).map((d) => `「${d.from}」→「${d.to}」`).join('；');
        if (o.silent !== true) {
            notify(r.added ? 'success' : 'warning', r.added ? 'NSFW 词条分析完成' : 'NSFW 词条分析：本次没有可落库的新词条',
                `${parts.join(' · ')}；转化库 ${r.rules} 条 · 识别词条库 ${r.keywords} 条；已分析进度 ${seenN} 处`
                + (detailTxt ? `。例：${detailTxt}` : '')
                + (r.rejectedList.length ? `。丢弃例：${r.rejectedList.slice(0, 2).map((x) => `「${x.from}」(${x.reason})`).join('、')}` : '')
                + (pack.truncated ? ` · 余 ${pack.truncated} 处可再点一次` : ''));
        }
        try {
            dbgLog('弱化', {
                action: 'NSFW 词条分析（v3.19.0）', examined: r.examined, submitted: pack.entries.length, truncated: pack.truncated,
                strongFields: pre.strongFields, unseenBefore: pre.unseen, byDim: pack.byDim,
                added: r.added, dup: r.dup, rejected: r.rejected, capped: r.capped,
                rules: r.rules, keywords: r.keywords, seen: seenN, ms: Date.now() - t0,
                addedList: r.details.slice(0, 10).map((d) => d.from + '→' + d.to),
            });
        } catch (e) { /* 忽略 */ }
        return {
            ok: r.added > 0, added: r.added, dup: r.dup, rejected: r.rejected, capped: r.capped,
            examined: r.examined, details: r.details, rejectedList: r.rejectedList,
            rules: r.rules, keywords: r.keywords, seen: seenN,
            submitted: pack.entries.length, total: pack.total, truncated: pack.truncated, strongFields: pre.strongFields,
        };
    } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 120);
        notify('error', 'NSFW 词条分析失败', msg);
        return { ok: false, error: msg };
    }
}
