// ============================================================
// core/html-text.js —— **正文 HTML 标签/实体清洗**（v2.44.0，纯内核）
//
// 背景（用户报告）：「地点捕捉把 `<br>` 这种 HTML 标签也捕捉进来了，应自动舍弃 HTML Tag 标签，避免污染数据。」
//   事实：酒馆消息正文（`ctx.chat[i].mes` / `swipes[]`）是**可含 HTML 的富文本**（`<br>`、`<p>`、`<div>`、`<img>`、
//   `<span style=…>`、`&nbsp;` 等）。V1（v1.206）在正文头/标记式/自定义正则三条地点来源上都**未做清洗**，
//   于是 `▷码头仓库<br>` 会被整行当作地点写进 `state.state.location`（并进入总览、注入与导出），
//   同样污染 `sceneDesc` / `statusText` / `era`，并让「AI 生成地点正则」按含标签的样本总结出错误写法。
//   本模块把清洗收敛成**一套纯函数**，在「取文」与「取值」两个环节兜底（见 docs/P10i）。
//
// 约定（三条，勿随意放宽）：
//   ① **块级标签 → 换行**：`<br>` / `</p>` / `</div>` / `</li>` / `</tr>` / `</h1..6>` … 视为换行 ——
//      保留楼层原有的分行语义（正文头 `▷…` 行因此不会与后文黏成一行）；
//   ② **其余标签直接丢弃**，`<script>`/`<style>` 连同**内容**一起丢弃，注释丢弃；
//   ③ **实体解码**在**去标签之后**做（避免 `&lt;b&gt;` 被反向还原成标签文本再被误删），
//      常见实体（`&nbsp;` `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` `&mdash;` `&hellip;`）与数字实体都还原。
//
// 保守性：`<` 后紧跟数字/空格（如剧情里的「血压 <10>」「甲 < 乙」）**不视为标签**，不做删除 —— 只删
//   「`<` + 字母」形态的标签，避免误伤正文。
// ============================================================

/** 块级/换行语义标签（→ `\n`），其余标签只删除自身 */
const BLOCK_TAGS = 'br|p|div|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6]|blockquote|section|article|header|footer|pre|hr|figure|figcaption|dd|dt|dl|form|label|button|select|option|textarea|iframe|video|audio|canvas|svg';
const BLOCK_SRC = '<\\s*/?\\s*(?:' + BLOCK_TAGS + ')\\b[^<>]*>';
const BLOCK_RE = new RegExp(BLOCK_SRC, 'gi');
const BLOCK_TEST = new RegExp(BLOCK_SRC, 'i');
/** 一般标签：`<` + 字母 开头（`</div>` / `<img src="…">` / `<br/>`）；不吃 `<10>`、`< 空格` */
const TAG_SRC = '<\\/?[a-zA-Z][a-zA-Z0-9-]*(?:\\s[^<>]*)?\\/?>';
const TAG_RE = new RegExp(TAG_SRC, 'g');
const TAG_TEST = new RegExp(TAG_SRC);
const SCRIPT_RE = /<\s*(script|style|template)\b[^<>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const COMMENT_TEST = /<!--[\s\S]*?-->/;
const ENTITY_TEST = /&(?:nbsp|amp|lt|gt|quot|apos|mdash|ndash|hellip|middot|times|ldquo|rdquo|lsquo|rsquo|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;

const str = (v) => String(v == null ? '' : v);

/** 是否含 HTML 标签或 HTML 实体（用于「只在有标签时才清洗」的快路径判定） */
export function hasHtmlTag(s) {
    const t = str(s);
    if (!t) return false;
    if (TAG_TEST.test(t) || BLOCK_TEST.test(t) || COMMENT_TEST.test(t)) return true;
    return ENTITY_TEST.test(t);
}

const NAMED_ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
    mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', laquo: '«', raquo: '»',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', deg: '°', bull: '•',
};

/**
 * HTML 实体解码（**在去标签之后调用**）。
 * 顺序：先解 `&amp;` 之外的具名/数字实体，最后解 `&amp;` —— 避免 `&amp;lt;` 被二次解码成 `<`。
 */
export function decodeHtmlEntities(s) {
    let t = str(s);
    if (!t || t.indexOf('&') < 0) return t;
    t = t.replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => { try { const n = parseInt(h, 16); return (n > 0 && n <= 0x10ffff) ? String.fromCodePoint(n) : m; } catch (e) { return m; } });
    t = t.replace(/&#(\d{1,7});/g, (m, d) => { try { const n = parseInt(d, 10); return (n > 0 && n <= 0x10ffff) ? String.fromCodePoint(n) : m; } catch (e) { return m; } });
    t = t.replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name) => {
        const k = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : m;
    });
    t = t.replace(/&#39;/g, "'");
    t = t.replace(/&amp;/g, '&');
    return t;
}

/** 去标签（块级 → 换行；script/style/注释整体丢弃；其余标签删除 + 实体解码） */
export function stripHtmlTags(s) {
    let t = str(s);
    if (!t || !hasHtmlTag(t)) return t;
    t = t.replace(COMMENT_RE, '');
    t = t.replace(SCRIPT_RE, ' ');
    t = t.replace(BLOCK_RE, '\n');
    t = t.replace(TAG_RE, '');
    // 刻意**不做** `<[^<>]*>` 的兜底删除：`<` 后不是字母的片段（如剧情里的「血压 <10>」「甲 < 乙」）必须原样保留
    t = decodeHtmlEntities(t);
    return t;
}

/**
 * 正文清洗（**保留换行**）：去标签 → 解实体 → CRLF 归一 → 逐行去首尾空白 → 去空行 → 折叠 3+ 连续空行。
 * 语义与 `core/util.js#normText` 保持同族（都保留换行），区别只在于**额外剔除 HTML**。
 */
export function cleanText(s, max) {
    let t = stripHtmlTags(s).replace(/\r\n?/g, '\n');
    t = t.split('\n').map((l) => l.replace(/[ \t\u00a0\u3000]+$/g, '').replace(/^[ \t\u00a0\u3000]+/g, '')).join('\n');
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    return (max && t.length > Number(max)) ? t.slice(0, Number(max)) : t;
}

/**
 * **字段值清洗**（单行语义；地点/场景/状态/纪年等使用）：先 `cleanText`，再把所有空白折叠为单个空格。
 * 例：`码头仓库<br>` → `码头仓库`；`<b>码头</b>&nbsp;仓库` → `码头 仓库`。
 */
export function cleanValue(s, max) {
    const t = cleanText(s).replace(/\s+/g, ' ').trim();
    return (max && t.length > Number(max)) ? t.slice(0, Number(max)) : t;
}

/** 诊断用：统计一段文本里被剔除的标签数与实体数（写进时钟追踪/日志，便于回答「为什么值变了」） */
export function htmlStats(s) {
    const t = str(s);
    const tags = (t.match(TAG_RE) || []).length + (t.match(/<[^<>]*>/g) || []).length;
    const entities = (t.match(/&(?:nbsp|amp|lt|gt|quot|apos|mdash|hellip|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g) || []).length;
    const samples = (t.match(new RegExp('<\\s*/?\\s*(?:' + BLOCK_TAGS + ')\\b[^<>]*>', 'gi')) || []).slice(0, 3);
    return { tags: tags, entities: entities, block: samples.map((x) => x.slice(0, 20)) };
}
