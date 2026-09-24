// ============================================================
// core/nsfw.js —— **内容弱化（NSFW）**（B8-4，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① 识别词条库（v1.197）：内置 63 条 + `cfg.nsfwKeywords` 自定义库（增/改/删/恢复内置，索引经「生效列表」定位）；
//   ② 固定规则转化库（v1.198~v1.199）：内置一套与识别词条一一对应的转化词 + `cfg.nsfwRules` 自定义库；
//   ③ 零 AI 机械替换 `nsfwApplyRules`（**对原文单遍匹配 + 区间占位**：不链式二次转换、重叠按「长词优先」；
//      英文走 `\b词\w*` + 误伤名单，避免 cumulative/circumstance 一类普通词被改写）与 `nsfwFixedReplace`（落地写回 + 镜像字段同步）；
//   ④ 命中判定 `nsfwKeywordHits`（与替换同一判定口径）+ 关键词预筛（按词条库签名缓存，不改变命中结果，只省无命中字段的扫描）；
//   ⑤ 扫描/打包 `nsfwScan` / `nsfwSoftenPack`（命中多者优先、单批 12 条）；
//   ⑥ AI 弱化 `buildNsfwSoftenPrompt` / `applyNsfwSoftenResult`（强校验：不得仍含露骨关键词、不得膨胀、只写命中字段）/
//      `runNsfwSoften`（先固定规则替换一次，再把剩余命中交 AI 二次弱化；忙位互斥；如实回报）；
//   ⑦ 分析侧开关 `nsfwSoftenEnabledOn` / `nsfwSoftenRuleText`（供 `core/prompt.js#buildSummaryPrompt` 追加规则）。
// 适配（与 V1 的差别）：AI 调用/占用判定经共用注入钩子 `core/ai-hooks.js`；提示经 `notifyHooks`；面板重绘由 UI 层负责；
//   V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`（任务管线 UI）未移植（V2 无该管线，见 docs/P8m §2）。
// 一致性由 tests/unit/nsfw-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { cfg, state, saveState, notifyHooks, dbgLog } from './model/runtime.js';
import { PROMPT_TEMPLATES_V2, normalizeDeltaKeys } from './config.js';
import { extractJsonObject } from './util.js';
import { atomIsHidden } from './merge.js';
import { aiCallText, aiBusy } from './ai-hooks.js';

/** 单次提交条数（与其它修复管道同口径：一批一次，余量下次继续） */
const NSFW_SOFTEN_BATCH = 12;
/** 单条弱化结果的长度硬上限 */
const NSFW_TEXT_CAP = 600;
/** 维度 → 可弱化字段路径（点号路径；数组自动展开为 `path.i`，对象数组取 text/content/desc/name/value） */
const NSFW_FIELD_MAP = {
    atoms: ['title', 'text', 'content'],
    states: ['subject', 'value'],
    snapshots: ['appearance', 'personality.speechStyle', 'personality.traits', 'personality.quirks', 'personality.values', 'background.history', 'social.relationToUser', 'social.attitudeToUser'],
    memories: ['title', 'content'],
    items: ['name', 'desc'],
    plans: ['title', 'content', 'statusNote'],
    suspense: ['title', 'content', 'statusNote'],
    scenes: ['name', 'desc'],
    concepts: ['name', 'content'],
    parallels: ['title', 'text', 'causalLine'],
    rumors: ['subject', 'content'],
    plotSegments: ['header', 'lines'],
};
const NSFW_DIM_LABEL = { atoms: '情节', states: '状态记录', snapshots: '角色档案', memories: '长期记忆', items: '物品', plans: '计划', suspense: '悬念', scenes: '场景', concepts: '概念', parallels: '平行事件', rumors: '传言', plotSegments: '情节分段' };

/** 内置识别词条库（中文原样匹配、英文不区分大小写） */
const NSFW_KEYWORDS = [
    '做爱', '性交', '性爱', '交合', '交媾', '上床', '性行为', '性事', '肉欲', '情欲', '发情', '高潮', '射精', '精液', '阴茎', '阴道', '阴部',
    '下体', '乳头', '乳尖', '乳房', '臀部', '私处', '裸体', '全裸', '赤裸', '呻吟', '娇喘', '抽插', '插入', '口交', '肛交', '自慰', '手淫',
    '强暴', '轮奸', '强奸', '猥亵', '调教', '肉棒', '鸡巴', '屄', '骚穴', '淫水', '淫叫', '淫荡', '淫乱', '泄身', '破处', '初夜',
    'porn', 'nsfw', 'explicit', 'orgasm', 'penis', 'vagina', 'cum', 'semen', 'intercourse', 'masturbat', 'erotic', 'nipple', 'genital',
];
/** 内置转化词（与识别词条一一对应；缺转化词的条目自动跳过） */
const NSFW_REPLACE_PAIRS = {
    // —— 行为 ——
    '做爱': '亲近', '性交': '亲密接触', '性爱': '亲密', '交合': '相拥', '交媾': '缠绵', '上床': '共度一夜',
    '性行为': '亲密之举', '性事': '私密之事', '肉欲': '情动', '情欲': '情愫', '发情': '情动难抑', '高潮': '顶点',
    '射精': '释放', '精液': '体液',
    // —— 身体 ——
    '阴茎': '腰腹之间', '阴道': '私密之处', '阴部': '私密之处', '下体': '腰腹之间', '乳头': '胸前', '乳尖': '胸前',
    '乳房': '胸口', '臀部': '腰臀', '私处': '隐秘之处', '裸体': '未着寸缕', '全裸': '全身未着寸缕', '赤裸': '未着衣',
    // —— 反应与描写 ——
    '呻吟': '低吟', '娇喘': '气息微乱', '抽插': '起伏', '插入': '进入', '口交': '亲昵', '肛交': '亲密',
    '自慰': '独自纾解', '手淫': '独自纾解',
    // —— 强迫与贬义 ——
    '强暴': '施暴', '轮奸': '施暴', '强奸': '强迫', '猥亵': '轻薄', '调教': '驯服', '肉棒': '腰腹之间', '鸡巴': '腰腹之间',
    '屄': '隐秘之处', '骚穴': '隐秘之处', '淫水': '湿意', '淫叫': '失声', '淫荡': '放浪', '淫乱': '放纵',
    '泄身': '失守', '破处': '初次', '初夜': '初次共度',
    // —— 英文（\b 词首 + 词形通配，忽略大小写）——
    'porn': 'intimate', 'nsfw': 'sensitive', 'explicit': 'suggestive', 'orgasm': 'climax', 'penis': 'groin',
    'vagina': 'intimate area', 'cum': 'release', 'semen': 'fluid', 'intercourse': 'intimacy', 'masturbat': 'self-soothing',
    'erotic': 'romantic', 'nipple': 'chest', 'genital': 'private area',
};
/** 内置标准转化库：逐条对应内置识别词条库（顺序一致；缺转化词自动跳过） */
const NSFW_RULES = NSFW_KEYWORDS.map(k => ({ from: k, to: NSFW_REPLACE_PAIRS[k] || '' })).filter(r => r.to);
/** 英文误伤名单：这些普通词既不参与替换、也不计命中（`cum` 前缀类） */
const NSFW_EN_INNOCENT = ['cumulative', 'cumulatively', 'cumbersome', 'cumbersomely', 'cumbersomeness', 'cumulus', 'cumin', 'cummerbund', 'cummerbunds', 'cummingtonite'];
const NSFW_EN_INNOCENT_SET = new Set(NSFW_EN_INNOCENT);

// ==================== 识别词条库（v1.197） ====================
/** 生效词条库：自定义列表非空 → 用它；否则用内置库 */
function nsfwKeywordList() {
    try {
        const custom = (cfg && Array.isArray(cfg.nsfwKeywords)) ? cfg.nsfwKeywords : [];
        const list = custom.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
        return list.length ? Array.from(new Set(list)) : NSFW_KEYWORDS.slice();
    } catch (e) { return NSFW_KEYWORDS.slice(); }
}
function nsfwKeywordsCustomized() {
    try { return !!(cfg && Array.isArray(cfg.nsfwKeywords) && cfg.nsfwKeywords.map(x => String(x || '').trim()).filter(Boolean).length); } catch (e) { return false; }
}
/** 把内置库物化成自定义列表（首次编辑时调用；已有自定义列表则不动） */
function nsfwKeywordsSeed() {
    try { cfg.nsfwKeywords = nsfwKeywordList(); return cfg.nsfwKeywords.length; } catch (e) { return 0; }
}
function nsfwKeywordAdd(kw) {
    try {
        const k = String(kw == null ? '' : kw).trim().slice(0, 40);
        if (!k) return { ok: false, reason: 'empty' };
        nsfwKeywordsSeed();
        const list = cfg.nsfwKeywords;
        if (list.some(x => String(x).toLowerCase() === k.toLowerCase())) return { ok: false, reason: 'dup', n: list.length };
        list.push(k);
        return { ok: true, n: list.length, kw: k };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 按生效索引改（空值 = 删除该条；内部先物化再按同位置替换，避免索引错位） */
function nsfwKeywordUpdate(idx, kw) {
    try {
        const i = Number(idx);
        const k = String(kw == null ? '' : kw).trim().slice(0, 40);
        if (!Number.isInteger(i) || i < 0) return { ok: false, reason: 'index' };
        const before = nsfwKeywordList();
        if (i >= before.length) return { ok: false, reason: 'index' };
        if (!k) return nsfwKeywordDelete(i);
        nsfwKeywordsSeed();
        const list = cfg.nsfwKeywords;
        const target = String(before[i]);
        const at = list.findIndex(x => String(x) === target);
        if (at < 0) return { ok: false, reason: 'index' };
        // 改名先查重（大小写不敏感）—— 冲突时拒绝，不静默去重丢条目
        if (list.some((x, j) => j !== at && String(x).toLowerCase() === k.toLowerCase())) return { ok: false, reason: 'dup', kw: k };
        list[at] = k;
        cfg.nsfwKeywords = list.map(x => String(x).trim()).filter(Boolean);
        return { ok: true, n: cfg.nsfwKeywords.length, kw: k };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
function nsfwKeywordDelete(idx) {
    try {
        const i = Number(idx);
        if (!Number.isInteger(i) || i < 0) return { ok: false, reason: 'index' };
        const before = nsfwKeywordList();
        if (i >= before.length) return { ok: false, reason: 'index' };
        nsfwKeywordsSeed();
        const target = String(before[i]);
        const at = cfg.nsfwKeywords.findIndex(x => String(x) === target);
        if (at < 0) return { ok: false, reason: 'index' };
        const removed = String(cfg.nsfwKeywords[at]);
        cfg.nsfwKeywords.splice(at, 1);          // 按生效索引只删这一条（按值 filter 会连删同值多条）
        return { ok: true, n: cfg.nsfwKeywords.length, removed: removed };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 恢复内置默认（清空自定义列表） */
function nsfwKeywordReset() {
    try { cfg.nsfwKeywords = []; return { ok: true, n: NSFW_KEYWORDS.length }; } catch (e) { return { ok: false, reason: 'error' }; }
}

// ==================== 固定规则转化库（v1.198~v1.199） ====================
/** 英文匹配正则（词首边界 + 词干通配、忽略大小写；`from` 中正则元字符已转义） */
function nsfwEnRegex(from) {
    return new RegExp('\\b' + String(from == null ? '' : from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'gi');
}
/** 该英文词形是否可命中（误伤名单内的普通词原样保留） */
function nsfwEnWordOk(w) { return !NSFW_EN_INNOCENT_SET.has(String(w).toLowerCase()); }
/** 生效转化库（自定义非空 → 用它；否则用内置） */
function nsfwRuleList() {
    try {
        const custom = (cfg && Array.isArray(cfg.nsfwRules)) ? cfg.nsfwRules : [];
        const list = custom.map(x => ({
            from: String((x && x.from) == null ? '' : x.from).trim(),
            to: String((x && x.to) == null ? '' : x.to).trim(),
        })).filter(r => r.from && r.to);
        return list.length ? list : NSFW_RULES.map(r => ({ from: r.from, to: r.to }));
    } catch (e) { return NSFW_RULES.map(r => ({ from: r.from, to: r.to })); }
}
function nsfwRulesCustomized() {
    try { return !!(cfg && Array.isArray(cfg.nsfwRules) && cfg.nsfwRules.map(x => (x && x.from && x.to) ? 1 : 0).filter(Boolean).length); } catch (e) { return false; }
}
/** 把内置转化库物化成自定义列表（首次编辑时调用；已有自定义则不动） */
function nsfwRulesSeed() {
    try { cfg.nsfwRules = nsfwRuleList().map(r => ({ from: r.from, to: r.to })); return cfg.nsfwRules.length; } catch (e) { return 0; }
}
function nsfwRuleAdd(from, to) {
    try {
        const f = String(from == null ? '' : from).trim().slice(0, 40);
        const t = String(to == null ? '' : to).trim().slice(0, 40);
        if (!f || !t) return { ok: false, reason: 'empty' };
        nsfwRulesSeed();
        const list = cfg.nsfwRules;
        if (list.some(x => String(x.from).toLowerCase() === f.toLowerCase())) return { ok: false, reason: 'dup', n: list.length, from: f };
        list.push({ from: f, to: t });
        return { ok: true, n: list.length, from: f, to: t };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 按生效索引改（from/to 任一为空 = 删除该条） */
function nsfwRuleUpdate(idx, from, to) {
    try {
        const i = Number(idx);
        const f = String(from == null ? '' : from).trim().slice(0, 40);
        const t = String(to == null ? '' : to).trim().slice(0, 40);
        if (!Number.isInteger(i) || i < 0) return { ok: false, reason: 'index' };
        const before = nsfwRuleList();
        if (i >= before.length) return { ok: false, reason: 'index' };
        if (!f || !t) return nsfwRuleDelete(i);
        nsfwRulesSeed();
        const list = cfg.nsfwRules;
        const target = before[i];
        const at = list.findIndex(x => String(x.from) === String(target.from) && String(x.to) === String(target.to));
        if (at < 0) return { ok: false, reason: 'index' };
        // 改匹配词先查重（大小写不敏感）—— 冲突时拒绝，避免造出重复条目
        if (list.some((x, j) => j !== at && String(x.from).toLowerCase() === f.toLowerCase())) return { ok: false, reason: 'dup', from: f };
        list[at] = { from: f, to: t };
        cfg.nsfwRules = list.map(x => ({ from: String(x.from).trim(), to: String(x.to).trim() })).filter(x => x.from && x.to);
        return { ok: true, n: cfg.nsfwRules.length, from: f, to: t };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
function nsfwRuleDelete(idx) {
    try {
        const i = Number(idx);
        if (!Number.isInteger(i) || i < 0) return { ok: false, reason: 'index' };
        const before = nsfwRuleList();
        if (i >= before.length) return { ok: false, reason: 'index' };
        nsfwRulesSeed();
        const target = before[i];
        const at = cfg.nsfwRules.findIndex(x => String(x.from) === String(target.from) && String(x.to) === String(target.to));
        if (at < 0) return { ok: false, reason: 'index' };
        const removed = String(cfg.nsfwRules[at].from);
        cfg.nsfwRules.splice(at, 1);
        return { ok: true, n: cfg.nsfwRules.length, removed: removed };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
function nsfwRuleReset() {
    try { cfg.nsfwRules = []; return { ok: true, n: NSFW_RULES.length }; } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 自动开关（默认开）：`undefined` 也视为开（老配置合并后不会丢默认行为） */
function nsfwReplaceAutoOn() { try { return !(cfg && cfg.nsfwReplaceAuto === false); } catch (e) { return true; } }

/** 关键词预筛（按生效词条库签名缓存；预筛是精确判定的超集，不改变命中结果） */
let nsfwProbeCache = { sig: null, re: null };
function nsfwKeywordSignature() {
    try { return nsfwKeywordList().join('\u0001'); } catch (e) { return ''; }
}
function nsfwKeywordProbe() {
    try {
        const sig = nsfwKeywordSignature();
        if (nsfwProbeCache.sig === sig) return nsfwProbeCache.re;
        const parts = [];
        for (const k of nsfwKeywordList()) {
            const kw = String(k || '');
            if (!kw) continue;
            const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            parts.push(/[\u4e00-\u9fa5]/.test(kw) ? esc : ('\\b' + esc + '\\w*'));
        }
        const re = parts.length ? new RegExp(parts.join('|'), 'i') : null;
        nsfwProbeCache = { sig: sig, re: re };
        return re;
    } catch (e) { return null; }
}
/**
 * 命中关键词（中文原样、英文按词界；与替换引擎同一判定口径）。
 * @returns {string[]} 命中的词条（按生效库顺序、去重）
 */
function nsfwKeywordHits(text) {
    const out = [];
    try {
        const t = String(text == null ? '' : text);
        if (!t) return out;
        const probe = nsfwKeywordProbe();
        if (probe && !probe.test(t)) return out;      // 一个匹配词都不含 → 跳过逐词循环
        for (const k of nsfwKeywordList()) {
            const kw = String(k || '');
            if (!kw || out.indexOf(kw) >= 0) continue;
            let hit = false;
            if (/[\u4e00-\u9fa5]/.test(kw)) hit = t.indexOf(kw) >= 0;
            else {
                const re = nsfwEnRegex(kw);
                let m;
                while ((m = re.exec(t)) !== null) {
                    if (!m[0]) { re.lastIndex++; continue; }
                    if (nsfwEnWordOk(m[0])) { hit = true; break; }
                }
            }
            if (hit) out.push(kw);
        }
    } catch (e) { /* 忽略 */ }
    return out;
}
/**
 * 固定规则替换（纯文本）：对**原文单遍匹配 + 区间占位** —— 不链式二次转换、结果与规则顺序无关；
 * 重叠时按「匹配词更长者优先」，并跳过已占用区间。
 * @returns {{text:string, hits:number, changed:boolean}}
 */
function nsfwApplyRules(text) {
    const src = String(text == null ? '' : text);
    try {
        if (!src) return { text: src, hits: 0, changed: false };
        const rules = nsfwRuleList().slice().sort((a, b) => String(b.from).length - String(a.from).length);
        if (!rules.length) return { text: src, hits: 0, changed: false };
        const claimed = new Array(src.length).fill(false);
        const subs = [];
        let hits = 0;
        const rangeFree = (s, e) => { for (let i = s; i < e; i++) { if (claimed[i]) return false; } return true; };
        const claimRange = (s, e) => { for (let i = s; i < e; i++) claimed[i] = true; };
        for (const r of rules) {
            const from = String(r.from || ''), to = String(r.to || '');
            if (!from || !to || from.length > src.length) continue;
            if (/[\u4e00-\u9fa5]/.test(from)) {
                for (let idx = src.indexOf(from); idx >= 0; idx = src.indexOf(from, idx + 1)) {
                    const e = idx + from.length;
                    if (!rangeFree(idx, e)) continue;
                    claimRange(idx, e); subs.push({ s: idx, e: e, to: to }); hits++;
                }
            } else {
                const re = nsfwEnRegex(from);
                let m;
                while ((m = re.exec(src)) !== null) {
                    const w = m[0];
                    if (!w) { re.lastIndex++; continue; }
                    if (nsfwEnWordOk(w)) {
                        const s = m.index, e = s + w.length;
                        if (rangeFree(s, e)) { claimRange(s, e); subs.push({ s: s, e: e, to: to }); hits++; }
                    }
                    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
                }
            }
        }
        if (!subs.length) return { text: src, hits: 0, changed: false };
        subs.sort((a, b) => a.s - b.s);
        let out = '', cur = 0;
        for (const x of subs) { out += src.slice(cur, x.s) + x.to; cur = x.e; }
        out += src.slice(cur);
        return { text: out, hits: hits, changed: out !== src };
    } catch (e) { return { text: src, hits: 0, changed: false }; }
}
// ---------- 路径读写与镜像字段 ----------
function nsfwGetByPath(obj, path) {
    try {
        let cur = obj;
        for (const seg of String(path || '').split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
        return cur;
    } catch (e) { return undefined; }
}
function nsfwSetByPath(obj, path, val) {
    try {
        const segs = String(path || '').split('.');
        let cur = obj;
        for (let i = 0; i < segs.length - 1; i++) { if (cur == null) return false; cur = cur[segs[i]]; }
        if (cur == null) return false;
        cur[segs[segs.length - 1]] = val;
        return true;
    } catch (e) { return false; }
}
/** 镜像字段名（情节的 `text` ↔ `content`） */
function nsfwMirrorKey(path) {
    const base = String(path || '').split('.')[0];
    if (base === 'text') return 'content';
    if (base === 'content') return 'text';
    return '';
}
function nsfwSyncMirror(it, path, origText, newText) {
    try {
        const k = nsfwMirrorKey(path);
        if (!k || !it) return false;
        if (typeof it[k] === 'string' && it[k] === String(origText)) { it[k] = newText; return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}
/** 镜像字段分组（仅 `text ↔ content` 这一对同值只收一次；其它路径同值各自收集） */
function nsfwMirrorGroup(path) {
    const base = String(path || '').split('.')[0];
    return (base === 'text' || base === 'content') ? 'text|content' : '';
}
/** 某条目可弱化的文本字段（数组自动展开；只收字符串） */
function nsfwTextFields(dim, it) {
    const out = [];
    const seen = {};
    const seenVal = {};
    const push = (path, text) => {
        const t = String(text == null ? '' : text);
        if (!t.trim() || seen[path]) return;
        const prev = seenVal[t];
        if (prev !== undefined) {
            const gp = nsfwMirrorGroup(prev), gc = nsfwMirrorGroup(path);
            if (gp && gp === gc) return;
        }
        seen[path] = 1; seenVal[t] = path;
        out.push({ path: path, text: t });
    };
    try {
        for (const p of (NSFW_FIELD_MAP[dim] || [])) {
            const v = nsfwGetByPath(it, p);
            if (typeof v === 'string') { push(p, v); continue; }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    const x = v[i];
                    if (typeof x === 'string') push(p + '.' + i, x);
                    else if (x && typeof x === 'object') {
                        for (const k of ['text', 'content', 'desc', 'name', 'value']) {
                            if (typeof x[k] === 'string' && x[k].trim()) { push(p + '.' + i + '.' + k, x[k]); break; }
                        }
                    }
                }
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}
/** 条目显示名（用于提示词与通知） */
function nsfwEntryTitle(dim, it) {
    try {
        const s = String((it && (it.title || it.name || it.subject || it.content || it.text || it.desc || '')) || '').replace(/\s+/g, ' ').trim();
        return s.length > 24 ? s.slice(0, 23) + '…' : s;
    } catch (e) { return ''; }
}
/** 固定规则替换落地：按与扫描同一套白名单字段遍历，命中即写回并刷新 `updatedAt`（零 AI） */
function nsfwFixedReplace(opts) {
    const o = opts || {};
    const out = { ok: true, fields: 0, replaced: 0, items: 0, skipped: 0, details: [] };
    try {
        const rules = nsfwRuleList();
        if (!rules.length) { out.skipped = 1; return out; }
        for (const dim of Object.keys(NSFW_FIELD_MAP)) {
            for (const it of ((state && state[dim]) || [])) {
                if (!it || !it.id) continue;
                if (dim === 'atoms' && atomIsHidden(it)) continue;   // 已总结隐藏的情节不被机械替换
                let touched = false;
                for (const f of nsfwTextFields(dim, it)) {
                    const r = nsfwApplyRules(f.text);
                    if (!r.hits) continue;
                    if (!nsfwSetByPath(it, f.path, r.text)) continue;
                    nsfwSyncMirror(it, f.path, f.text, r.text);        // 镜像字段同步，避免留原文
                    touched = true; out.fields++; out.replaced += r.hits;
                    if (out.details.length < 24) out.details.push(`${(NSFW_DIM_LABEL[dim] || dim)}（${f.path}）命中 ${r.hits} 处 → ${String(r.text).slice(0, 22)}${String(r.text).length > 22 ? '…' : ''}`);
                }
                if (touched) { it.updatedAt = Date.now(); out.items++; }
            }
        }
        try { if (o.silent !== true && out.replaced) dbgLog('弱化', `固定规则替换：${out.items} 条 / ${out.fields} 字段 / ${out.replaced} 处`); } catch (e) { /* 忽略 */ }
    } catch (e) { out.ok = false; }
    return out;
}
/**
 * 扫描：按关键词找出「潜在需弱化」的字段（只读，零 AI）
 * @param {object} [opts] dims 限定维度
 * @returns {{items:Array, total:number, byDim:object, scannedItems:number, scannedFields:number}}
 */
function nsfwScan(opts) {
    const o = opts || {};
    const dims = (o.dims && o.dims.length) ? o.dims : Object.keys(NSFW_FIELD_MAP);
    const items = [];
    const byDim = {};
    let scannedItems = 0, scannedFields = 0;
    try {
        for (const dim of dims) {
            if (!NSFW_FIELD_MAP[dim]) continue;
            for (const it of ((state && state[dim]) || [])) {
                if (!it || !it.id) continue;
                if (dim === 'atoms' && atomIsHidden(it)) continue;   // 已总结隐藏的情节不参与扫描
                scannedItems++;
                for (const f of nsfwTextFields(dim, it)) {
                    scannedFields++;
                    const hits = nsfwKeywordHits(f.text);
                    if (!hits.length) continue;
                    items.push({ dim, id: String(it.id), path: f.path, text: String(f.text), hits, title: nsfwEntryTitle(dim, it) });
                    byDim[dim] = (byDim[dim] || 0) + 1;
                }
            }
        }
        items.sort((a, b) => (b.hits.length - a.hits.length) || String(a.dim).localeCompare(String(b.dim)));
    } catch (e) { /* 忽略 */ }
    return { items, total: items.length, byDim, scannedItems, scannedFields };
}
/** 打包本批（默认 12 条；命中关键词多者优先） */
function nsfwSoftenPack(opts) {
    const scan = nsfwScan(opts);
    const entries = scan.items.slice(0, NSFW_SOFTEN_BATCH).map((x, i) => Object.assign({ n: i + 1, label: NSFW_DIM_LABEL[x.dim] || x.dim }, x));
    return { entries, total: scan.total, truncated: Math.max(0, scan.total - entries.length), byDim: scan.byDim, scannedItems: scan.scannedItems, scannedFields: scan.scannedFields };
}
/** 提示词（V1 `buildNsfwSoftenPrompt`） */
function buildNsfwSoftenPrompt(pack) {
    try {
        const p = pack || nsfwSoftenPack();
        if (!p.entries.length) return null;
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.nsfwSoften) || (PROMPT_TEMPLATES_V2 && PROMPT_TEMPLATES_V2.nsfwSoften) || '').trim()
            || '把下列条目里的露骨描写改写成柔性、克制、留白的表述（不添加新事实、长度不超过原文）；只输出 JSON。';
        const lines = p.entries.map(e => `#${e.n} ｜ ${e.label} ｜ 字段：${e.path}${e.title ? ` ｜ 条目：${e.title}` : ''} ｜ 命中：${e.hits.slice(0, 6).join('、')}\n   原文：${String(e.text).slice(0, 600)}`);
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释，不要复述原文。` },
            { role: 'user', content: `【待弱化清单（本次唯一工作对象，共 ${p.entries.length} 条）】\n${lines.join('\n')}\n\n输出：{"弱化":[{"编号":1,"文本":"改写后的完整文本","说明":"一句话说明改了什么"}],"无法处理":[2]}（按 #编号 引用；文本不得含露骨词汇、长度不超过原文；没有改动的条目放进「无法处理」或省略）。` },
        ];
    } catch (e) { return null; }
}
/** 应用结果（强校验：不得仍含露骨关键词、不得膨胀、只写命中字段） */
function applyNsfwSoftenResult(pack, delta) {
    const out = { applied: 0, skipped: 0, unchanged: 0, unable: 0, failed: 0, details: [] };
    try {
        const p = pack || { entries: [] };
        const byN = new Map();
        for (const e of p.entries) byN.set(Number(e.n), e);
        const d = delta || {};
        const soft = (d['弱化'] !== undefined) ? d['弱化'] : (d.soften !== undefined ? d.soften : d.items);
        const unable = (d['无法处理'] !== undefined) ? d['无法处理'] : d.unable;
        for (const raw of (Array.isArray(soft) ? soft : [])) {
            try {
                if (!raw || typeof raw !== 'object') { out.skipped++; continue; }
                const rawN = (raw['编号'] !== undefined) ? raw['编号'] : (raw.n !== undefined ? raw.n : raw.id);
                const n = Number(String(rawN == null ? '' : rawN).replace(/[^0-9]/g, ''));
                const e = byN.get(n);
                if (!e) { out.skipped++; continue; }
                const it = (state[e.dim] || []).find(x => x && String(x.id) === String(e.id));
                if (!it) { out.skipped++; continue; }
                const txt = String((raw['文本'] !== undefined) ? raw['文本'] : (raw.text !== undefined ? raw.text : (raw.content || ''))).trim();
                const note = String((raw['说明'] !== undefined) ? raw['说明'] : (raw.note || '')).replace(/\s+/g, ' ').slice(0, 40);
                if (!txt || txt.length < 2) { out.skipped++; continue; }
                if (txt === String(e.text).trim()) { out.unchanged++; continue; }
                const still = nsfwKeywordHits(txt);
                if (still.length) { out.skipped++; out.details.push(`${e.label} #${n} → 丢弃（结果仍含「${still.slice(0, 2).join('、')}」）`); continue; }
                const cap = Math.max(24, Math.min(NSFW_TEXT_CAP, Math.round(String(e.text).length * 1.4)));
                if (txt.length > cap) { out.skipped++; out.details.push(`${e.label} #${n} → 丢弃（结果过长 ${txt.length} > ${cap}）`); continue; }
                if (!nsfwSetByPath(it, e.path, txt)) { out.failed++; continue; }
                nsfwSyncMirror(it, e.path, e.text, txt);   // 镜像字段同步（AI 路径同修）
                it.updatedAt = Date.now();                 // 跨端合并按 updatedAt 取较新 → 弱化后的文本会胜出
                out.applied++;
                out.details.push(`${e.label}（${e.path}）→ ${txt.slice(0, 22)}${txt.length > 22 ? '…' : ''}${note ? `（${note}）` : ''}`);
            } catch (e) { out.skipped++; }
        }
        for (const raw of (Array.isArray(unable) ? unable : [])) {
            try { const n = Number(String(raw).replace(/[^0-9]/g, '')); if (byN.get(n)) out.unable++; } catch (e) { /* 忽略 */ }
        }
        return out;
    } catch (e) { return out; }
}
// ==================== 分析侧规则（供 buildSummaryPrompt 追加） ====================
function nsfwSoftenEnabledOn() { try { return !!(cfg && cfg.nsfwSoftenEnabled === true); } catch (e) { return false; } }
function nsfwSoftenRuleText() {
    try {
        if (!nsfwSoftenEnabledOn()) return '';
        return String((cfg.promptTemplates && cfg.promptTemplates.nsfwSoften) || (PROMPT_TEMPLATES_V2 && PROMPT_TEMPLATES_V2.nsfwSoften) || '').trim();
    } catch (e) { return ''; }
}
/** 状态摘要（设置页/总览/诊断：只读扫描，零 AI） */
function nsfwSoftenState() {
    try {
        const scan = nsfwScan();
        return {
            enabled: nsfwSoftenEnabledOn(),
            candidates: scan.total, byDim: scan.byDim, scannedItems: scan.scannedItems, scannedFields: scan.scannedFields,
            batch: NSFW_SOFTEN_BATCH, keywords: nsfwKeywordList().length, custom: nsfwKeywordsCustomized(),
            rules: nsfwRuleList().length, rulesCustom: nsfwRulesCustomized(), ruleAuto: nsfwReplaceAutoOn(),
        };
    } catch (e) { return { enabled: false, candidates: 0, byDim: {}, scannedItems: 0, scannedFields: 0, batch: NSFW_SOFTEN_BATCH, keywords: 0, rules: 0, rulesCustom: false, ruleAuto: true }; }
}
/** 用户提示（V1 `notify(kind,{title,text})` → 宿主通知钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/**
 * 手动流程（总览「🌶 弱化NSFW」按钮 / 设定页同名按钮）。
 * @param {object} [opts] silent / skipFixed（跳过固定规则阶段）/ aiText（显式 AI 返回，测试用）
 */
async function runNsfwSoften(opts) {
    const o = opts || {};
    try {
        const pre = nsfwSoftenPack();
        const autoFixed = nsfwReplaceAutoOn() && o.skipFixed !== true;
        if (!pre.total && !autoFixed) {
            if (o.silent !== true) notify('info', '弱化 NSFW：未发现需处理内容', `按 ${nsfwKeywordList().length} 个词条扫描 ${pre.scannedItems} 条原子 / ${pre.scannedFields} 个文本字段：没有命中露骨关键词。`);
            return { made: 0, skipped: true, total: 0, scannedItems: pre.scannedItems, scannedFields: pre.scannedFields };
        }
        if (aiBusy()) { notify('warning', '任务进行中', '已有修复/摘要/同步任务在运行，请稍候再试。'); return { made: 0, blocked: true }; }
        // 先跑一次固定规则替换（零 AI、机械转化），再把剩余命中交 AI 二次弱化（默认开，可关）
        let fixedDone = null;
        if (autoFixed) {
            const fx = nsfwFixedReplace({ silent: o.silent === true });
            if (fx.replaced) {
                fixedDone = fx;
                try { saveState(); } catch (e) { /* 忽略 */ }
                if (o.silent !== true) notify('info', '已先执行固定规则替换', `${fx.items} 条 / ${fx.fields} 个字段 / ${fx.replaced} 处命中已按固定规则转化，剩余交 AI 二次弱化。`);
            }
        }
        const pack = fixedDone ? nsfwSoftenPack() : pre;
        if (!pack.total) {
            if (o.silent !== true) notify('info', fixedDone ? '固定规则替换完成（无需 AI）' : '弱化 NSFW：未发现需处理内容', fixedDone ? `固定规则已处理 ${fixedDone.replaced} 处，其余无命中露骨关键词。` : `按 ${nsfwKeywordList().length} 个词条扫描 ${pack.scannedItems} 条原子 / ${pack.scannedFields} 个文本字段：没有命中露骨关键词。`);
            return { made: 0, skipped: true, total: 0, fixed: fixedDone ? { fields: fixedDone.fields, replaced: fixedDone.replaced, items: fixedDone.items } : null, scannedItems: pack.scannedItems, scannedFields: pack.scannedFields };
        }
        const prompt = buildNsfwSoftenPrompt(pack);
        if (!prompt) { notify('info', '弱化 NSFW：无待处理条目', '清单为空。'); return { made: 0, skipped: true }; }
        const t0 = Date.now();
        const dimTxt = Object.keys(pack.byDim).map(k => `${NSFW_DIM_LABEL[k] || k} ${pack.byDim[k]}`).join(' · ');
        notify('info', '开始弱化 NSFW…', `命中 ${pack.total} 处${dimTxt ? `（${dimTxt}）` : ''} · 本次提交 ${pack.entries.length} 条${pack.truncated ? `（余 ${pack.truncated} 条下次继续）` : ''}`);
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '弱化NSFW'));
        if (!resp) {
            notify('warning', '弱化 NSFW：AI 无返回', 'AI 未返回内容（可能未配置模型或请求失败），未改动任何数据。');
            return { made: 0, error: 'no-ai', total: pack.total, fixed: fixedDone ? { fields: fixedDone.fields, replaced: fixedDone.replaced, items: fixedDone.items } : null };
        }
        const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
        const r = applyNsfwSoftenResult(pack, delta);
        if (r.applied) { try { saveState(); } catch (e) { /* 忽略 */ } }
        const parts = [];
        if (r.applied) parts.push(`已弱化 ${r.applied} 条`);
        if (r.unchanged) parts.push(`无变化 ${r.unchanged} 条`);
        if (r.unable) parts.push(`AI 无法处理 ${r.unable} 条`);
        if (r.skipped) parts.push(`丢弃不合格 ${r.skipped} 条`);
        if (r.failed) parts.push(`写入失败 ${r.failed} 条`);
        if (o.silent !== true) {
            notify(parts.length ? (r.applied ? 'success' : 'warning') : 'warning', r.applied ? '弱化 NSFW 完成' : '弱化 NSFW：AI 未给出可用结果',
                parts.length
                    ? `${parts.join(' · ')}；${r.details.length ? '例：' + r.details.slice(0, 3).join('；') : ''}${pack.truncated ? ` · 余 ${pack.truncated} 条可再点一次` : ''}`
                    : 'AI 未返回可用的改写文本（结果若仍含露骨词汇会被丢弃）。可重试或先检查提示词模板「内容弱化（NSFW）」。');
        }
        try { dbgLog('弱化', { action: '弱化 NSFW（v1.195）', total: pack.total, submitted: pack.entries.length, truncated: pack.truncated, byDim: pack.byDim, applied: r.applied, unchanged: r.unchanged, unable: r.unable, skipped: r.skipped, failed: r.failed, ms: Date.now() - t0, fixedBefore: fixedDone ? fixedDone.replaced : 0 }); } catch (e) { /* 忽略 */ }
        return { made: r.applied, applied: r.applied, unchanged: r.unchanged, unable: r.unable, skipped: r.skipped, failed: r.failed, total: pack.total, submitted: pack.entries.length, truncated: pack.truncated, details: r.details, fixed: fixedDone ? { fields: fixedDone.fields, replaced: fixedDone.replaced, items: fixedDone.items } : null };
    } catch (e) {
        const fx = null;
        notify('error', '弱化 NSFW 失败', String((e && e.message) || e).slice(0, 120));
        return { made: 0, error: String((e && e.message) || e), fixed: fx };
    }
}

export {
    NSFW_SOFTEN_BATCH, NSFW_TEXT_CAP, NSFW_FIELD_MAP, NSFW_DIM_LABEL, NSFW_KEYWORDS, NSFW_REPLACE_PAIRS, NSFW_RULES, NSFW_EN_INNOCENT,
    nsfwKeywordList, nsfwKeywordsCustomized, nsfwKeywordsSeed, nsfwKeywordAdd, nsfwKeywordUpdate, nsfwKeywordDelete, nsfwKeywordReset,
    nsfwRuleList, nsfwRulesCustomized, nsfwRulesSeed, nsfwRuleAdd, nsfwRuleUpdate, nsfwRuleDelete, nsfwRuleReset, nsfwReplaceAutoOn,
    nsfwEnRegex, nsfwEnWordOk, nsfwKeywordProbe, nsfwKeywordHits, nsfwApplyRules, nsfwFixedReplace,
    nsfwGetByPath, nsfwSetByPath, nsfwMirrorKey, nsfwSyncMirror, nsfwMirrorGroup, nsfwTextFields, nsfwEntryTitle,
    nsfwScan, nsfwSoftenPack, buildNsfwSoftenPrompt, applyNsfwSoftenResult, nsfwSoftenEnabledOn, nsfwSoftenRuleText, nsfwSoftenState,
    runNsfwSoften,
};
