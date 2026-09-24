// ============================================================
// core/util.js —— 纯工具函数（零宿主依赖，Node 可直接单测）
// ============================================================

/** 稳定短哈希（FNV-1a 32 位十六进制；用于内容指纹、id 派生） */
export function hashText(input) {
    const s = String(input == null ? '' : input);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** HTML 转义（UI 层渲染用；内核只提供纯函数实现） */
export function escHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 单行化 + 截断（提示词与列表展示通用） */
export function normText(v, max) {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return (max && s.length > max) ? s.slice(0, max) : s;
}

/** 数值夹取 */
export function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
}

/** 列表归一：去空、去重、保序、截断 */
export function normalizeList(arr, max) {
    const out = [];
    for (const v of (Array.isArray(arr) ? arr : [])) {
        const s = String(v == null ? '' : v).trim();
        if (!s || out.includes(s)) continue;
        out.push(s);
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
