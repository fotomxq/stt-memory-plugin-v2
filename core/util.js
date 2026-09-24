// ============================================================
// core/util.js —— 纯工具函数（零宿主依赖，Node 可直接单测）
// ============================================================

/**
 * 稳定短哈希（**与 V1 完全一致**：djb2 → base36）。
 * 说明：id 派生、内容指纹、删除墓碑都依赖它；换实现会导致「同一内容两端不同哈希」，
 * 跨端去重与墓碑失效，因此**不要改动**此算法。
 */
export function hashText(s) {
    let h = 5381;
    const t = String(s == null ? '' : s);
    for (let i = 0; i < t.length; i++) { h = ((h << 5) + h) ^ t.charCodeAt(i); }
    return (h >>> 0).toString(36);
}

/** HTML 转义（UI 层渲染用；内核只提供纯函数实现） */
export function escHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 文本归一（与 V1 完全一致：**保留换行**，仅统一 CRLF 与首尾空白，再按 max 截断）。
 * 说明：内核归一化依赖此语义（atom 正文保留段落），不要改成单行化。
 */
export function normText(s, max) {
    const t = String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
    return (max && t.length > max) ? t.slice(0, max) : t;
}

/** 单行化（提示词/状态行展示用；与 normText 分开，避免误用） */
export function oneLine(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return (max && t.length > max) ? t.slice(0, max) : t;
}

/** 数值夹取（与 V1 一致：`Math.max(min, Math.min(max, v))`，不做 NaN 兜底） */
export function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/** 列表归一：仅接受数组；去空、去重、保序（可选 max 截断，V2 扩展） */
/** 角色/条目名归一（去空格与间隔号、小写）—— **逐字移植自 V1** `snapNameKey` */
export function snapNameKey(s) { try { return String(s == null ? '' : s).replace(/[\s·・.．]/g, '').toLowerCase(); } catch (e) { return ''; } }

/** 逗号/顿号/分号分隔的列表文本 → 数组（**逐字移植自 V1** `splitListText`） */
export function splitListText(s) { return normalizeList(String(s == null ? '' : s).split(/[,，、;；]/)); }

export function normalizeList(v, max) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
        const s = String(x == null ? '' : x).trim();
        if (s && !out.includes(s)) out.push(s);
        if (max && out.length >= max) break;
    }
    return out;
}

/** 日期串比较（YYYY-MM-DD，支持负年份；空值排最后） */
export function cmpDateStr(a, b) {
    const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? -1 : (x > y ? 1 : 0);
}

/** 从任意 AI 文本中提取第一个 JSON 对象（容忍 ```json 围栏与前后噪声） */
export function extractJsonObject(text) {
    const s = String(text == null ? '' : text);
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1] : s;
    const start = body.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < body.length; i++) {
        const c = body[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(body.slice(start, i + 1)); } catch (e) { return null; }
            }
        }
    }
    return null;
}

/** 构造空状态（与 V1 state 容器对齐，V2 增加 dataVersion） */
export function emptyState() {
    const st = { dataVersion: 1, charScope: '', deleted: {}, deletedH: {} };
    for (const k of ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'links', 'plotSegments', 'rumors', 'currencies']) st[k] = [];
    st.state = { date: '', time: '', location: '', present: [] };
    return st;
}
