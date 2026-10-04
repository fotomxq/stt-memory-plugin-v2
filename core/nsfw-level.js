// ============================================================
// core/nsfw-level.js —— **NSFW 内容等级（无 / 弱 / 强）· 永久留档**（v3.8.0，内核纯函数）
//
// 用户要求（原话）：「原子数据新增字段，用于标记该信息是否包含了 NSFW 内容，同时 NSFW 分等级，
//   分别包括无、弱、强 3 个级别。其中无代表与 NSFW 完全无关、弱代表有部分但没有露骨内容、强代表完全是露骨内容。
//   当弱化 NSFW 功能修复后，**NSFW 标签不会改变，用于永久性留档**。」
//
// 口径：
//   · 字段 `nsfw`：`none`（无）| `weak`（弱）| `strong`（强）。**缺省 = 无**（缺省不写盘，避免给每条数据加噪声）；
//   · 判级只依据**写入当时的内容**（AI 显式标注优先，其次按原文关键词/弱级信号判定）；
//   · **留档 = 只升不降**（`nsfwStampLevel` 取 `max`）：一旦记为「强」，之后无论弱化、改写、重归一化、
//     跨端合并，都不会被降回「弱/无」——这正是「永久性留档」的含义；
//   · 字段**不参与内容哈希**（见 `core/model/hashfields.js` 的 HASH_FIELDS，未收录），
//     因此不影响去重、瘦身与跨端对账；瘦身写盘按「非默认值保留」原样带上（`core/slim.js`）。
//
// 与 `core/nsfw.js` 的分工：本文件只含**纯函数**（等级归一 / 取高 / 弱级信号 / 标记），
//   可被 `core/model/*`、`core/migrate.js`、`core/cross-sync.js` 等低层模块安全引用；
//   「按维度文本判级」「全库补档」等需要 state/cfg 的逻辑留在 `core/nsfw.js`。
// ============================================================

/** 三个等级（顺序即强弱：none < weak < strong） */
export const NSFW_LEVELS = Object.freeze(['none', 'weak', 'strong']);
/** 等级中文标签（界面用） */
export const NSFW_LEVEL_LABELS = Object.freeze({ none: '无', weak: '弱', strong: '强' });
/** 条目上的字段名 */
export const NSFW_LEVEL_FIELD = 'nsfw';
/**
 * AI 可能使用的等级键名（提取结果里显式标注**原文**程度时用；中英文都认）。
 * 例：`{"标题":"…","正文":"…","NSFW":"强"}`。
 */
export const NSFW_AI_LEVEL_KEYS = Object.freeze(['nsfw', 'NSFW', 'nsfwLevel', 'nsfw_level', '露骨程度', 'NSFW等级', 'NSFW 等级']);

/**
 * **弱级信号词**（有部分亲密/性暗示，但无露骨直述）—— 内置，不可在界面改（强级词库可由
 * `cfg.nsfwKeywords` 自定义；两库取高，重叠无影响）。
 * 其中一部分正是内置转化库的输出词（如「亲近 / 未着寸缕 / 腰腹之间」）——弱化后的文本天然落在「弱」。
 */
export const NSFW_WEAK_SIGNALS = Object.freeze([
    // —— 中文：亲密行为（非露骨） ——
    '亲近', '亲密', '亲昵', '亲热', '相拥', '拥抱', '拥吻', '亲吻', '接吻', '爱抚', '抚摸',
    // —— 中文：情动与暗示 ——
    '缠绵', '情动', '情愫', '暧昧', '挑逗', '撩拨', '调情', '喘息', '低吟', '意乱情迷',
    // —— 中文：场景与状态 ——
    '同床', '共度一夜', '同房', '越过界线', '越过了界线', '未着寸缕', '衣衫不整',
    // —— 中文：转化库输出词（弱化后残留） ——
    '胸前的', '腰腹之间', '隐秘之处', '湿意', '放浪', '轻薄',
    // —— 英文（整词匹配，避免 hug→huge 一类误伤） ——
    'kiss', 'kisses', 'kissing', 'hug', 'hugs', 'hugging', 'embrace', 'embraces', 'intimate', 'intimacy',
    'caress', 'caresses', 'fondle', 'fondles', 'sensual', 'suggestive', 'flirt', 'flirts', 'flirting',
    'moan', 'moans', 'moaning', 'undress', 'undressed', 'undressing', 'arousal', 'foreplay',
]);

const WEAK_CN = NSFW_WEAK_SIGNALS.filter((w) => /[\u4e00-\u9fa5]/.test(w));
const WEAK_EN = NSFW_WEAK_SIGNALS.filter((w) => !/[\u4e00-\u9fa5]/.test(w));
const WEAK_EN_RE = WEAK_EN.map((w) => ({ w: w, re: new RegExp('\\b' + String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') }));

/** 等级归一（认 `none/weak/strong`、`无/弱/强`、`0/1/2`；未知 → `none`） */
export function nsfwLevelNorm(v) {
    try {
        if (v === true) return 'strong';
        if (v === false || v === null || v === undefined) return 'none';
        if (typeof v === 'number') return v >= 2 ? 'strong' : (v >= 1 ? 'weak' : 'none');
        const s = String(v).trim().toLowerCase();
        if (!s) return 'none';
        if (s === 'strong' || s === '强' || s === 'high' || s === '3' || s === 'explicit') return 'strong';
        if (s === 'weak' || s === '弱' || s === 'medium' || s === 'mid' || s === '2' || s === '1' || s === 'suggestive') return 'weak';
        if (s === 'none' || s === '无' || s === 'no' || s === '0' || s === 'normal' || s === 'off') return 'none';
        return 'none';
    } catch (e) { return 'none'; }
}

/** 等级序号（none=0 · weak=1 · strong=2） */
export function nsfwLevelRank(l) { const v = nsfwLevelNorm(l); return v === 'strong' ? 2 : (v === 'weak' ? 1 : 0); }

/** 取最高等级（留档 = 只升不降） */
export function nsfwLevelMax() {
    let best = 'none';
    for (let i = 0; i < arguments.length; i++) {
        const l = nsfwLevelNorm(arguments[i]);
        if (nsfwLevelRank(l) > nsfwLevelRank(best)) best = l;
    }
    return best;
}

/** 等级中文标签（`强` / `弱` / `无`） */
export function nsfwLevelLabel(l) { return NSFW_LEVEL_LABELS[nsfwLevelNorm(l)] || '无'; }

/** 条目上的留档等级（字段缺省 = 无） */
export function nsfwLevelOf(it) {
    try { return (it && typeof it === 'object') ? nsfwLevelNorm(it[NSFW_LEVEL_FIELD]) : 'none'; } catch (e) { return 'none'; }
}

/** 从**写入原文**里取 AI 显式标注的等级（认中英文键名；没有 → `none`） */
export function nsfwLevelFromEntry(raw) {
    try {
        if (!raw || typeof raw !== 'object') return 'none';
        for (const k of NSFW_AI_LEVEL_KEYS) {
            if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
            const l = nsfwLevelNorm(raw[k]);
            if (l !== 'none') return l;
        }
        return 'none';
    } catch (e) { return 'none'; }
}

/** 文本是否含**弱级信号**（中文原样子串、英文整词，均不区分大小写） */
export function nsfwWeakHit(text) {
    try {
        const t = String(text == null ? '' : text);
        if (!t) return false;
        for (const w of WEAK_CN) { if (t.indexOf(w) >= 0) return true; }
        for (const x of WEAK_EN_RE) { if (x.re.test(t)) return true; }
        return false;
    } catch (e) { return false; }
}

/**
 * **打标（只升不降）** —— 留档的核心：把 `level` 与条目现有等级取高后写回。
 *   · 结果 `none` 时**不写字段**（缺省即无，避免给每条数据加噪声）；
 *   · 结果与现有相同则不动（幂等，不产生无谓的写盘）。
 * @param {object} it 条目（就地修改）
 * @param {string} level 本次判出的等级
 * @returns {{from:string, to:string, changed:boolean}}
 */
export function nsfwStampLevel(it, level) {
    try {
        if (!it || typeof it !== 'object') return { from: 'none', to: 'none', changed: false };
        const from = nsfwLevelOf(it);
        const to = nsfwLevelMax(from, level);
        if (to === from) return { from: from, to: to, changed: false };
        if (to === 'none') return { from: from, to: to, changed: false };
        it[NSFW_LEVEL_FIELD] = to;
        return { from: from, to: to, changed: true };
    } catch (e) { return { from: 'none', to: 'none', changed: false }; }
}

/**
 * 合并两份拷贝的留档等级（跨端合并 / 同内容去重时用）：把 `source` 的等级并进 `target`（只升不降）。
 * @returns {boolean} 是否改动了 `target`
 */
export function nsfwMergeLevel(target, source) {
    try {
        if (!target || typeof target !== 'object') return false;
        const l = nsfwLevelMax(nsfwLevelOf(target), nsfwLevelOf(source));
        return nsfwStampLevel(target, l).changed;
    } catch (e) { return false; }
}
