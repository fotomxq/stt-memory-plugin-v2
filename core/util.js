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
 * ============================================================
 * v3.26.1（用户报告「有传言中出现了 undefined 字样，其他原子数据可能也有」）——**坏占位 token 清理**。
 *
 * 事实与成因（真机取证，见 `docs/history/P10c47`）：机械演化把「说法变体」插进文本时，
 *   取变体的掷骰函数把 base36 哈希按 **16 进制**解析 → 含 `g`~`z` 的种子得到 `NaN` →
 *   变体名变成 `undefined`，于是正文被写成 `…（说法演变为：undefined）`、链路写成 `说法完成演化（undefined）`。
 *
 * 纪律：**只清「不可能出现在正常正文里」的占位 token**（`undefined` / `NaN` / `[object Object]`），
 *   且只清它们以「值」的形态出现的位置（整字段 / 冒号后 / 括号内 / 顿号逗号句号分隔处），
 *   不碰普通的词句 —— 不做「见 undefined 就删」的粗暴替换（那会误伤正文里正常出现的英文词）。
 * ============================================================
 */
const BAD_TOKEN = 'undefined|NaN|\\[object Object\\]';
/** 该文本是否含坏占位 token（廉价预检：绝大多数文本一次 indexOf 就返回） */
export function hasBadToken(s) {
    const t = String(s == null ? '' : s);
    return t.indexOf('undefined') >= 0 || t.indexOf('NaN') >= 0 || t.indexOf('[object') >= 0;
}
/**
 * 清理坏占位 token（**幂等**；返回值与入参为字符串）。
 * 处理形态（按顺序；token = `undefined` / `NaN` / `[object Object]`）：
 *   ① 整字段就是 token → `''`；
 *   ② `[object Object]` **任何位置**都删（它绝不可能出现在正常正文里）；
 *   ③ 以 token **结尾**的括号（含可选标签前缀，如「（说法演变为：undefined）」「（发酵度 NaN）」）→ 整段删除；
 *   ④ 冒号后的 token（后接分隔符 / 行尾）→ 只删 token；
 *   ⑤ 行首 token + 冒号 → 连冒号一起删；
 *   ⑥ 孤立 token（后接分隔符 / 行尾）→ 只删 token；
 *   ⑦ 收尾整洁：空标签冒号 / 重复顿号逗号 / 连续空格。
 * **不做**「见 undefined 就全局删」的粗暴替换 —— 正文里正常出现的英文词（如 `the undefined behaviour`）保持原样。
 */
export function scrubBadToken(s) {
    let t = String(s == null ? '' : s);
    if (!hasBadToken(t)) return t;
    t = t.replace(new RegExp('^\\s*(?:' + BAD_TOKEN + ')\\s*$', 'g'), '');                                    // ①
    if (!hasBadToken(t)) return t;
    t = t.replace(/\[object Object\]/g, '');                                                                 // ②
    t = t.replace(new RegExp('[（(][^（）()\\n]{0,24}?(?:[:：]\\s*)?(?:' + BAD_TOKEN + ')\\s*[）)]', 'g'), '');  // ③
    t = t.replace(new RegExp('[:：]\\s*(?:' + BAD_TOKEN + ')(?=\\s*[，,。；;、！!？?\\]】」』]|\\s*$)', 'g'), ''); // ④
    t = t.replace(new RegExp('^\\s*(?:' + BAD_TOKEN + ')\\s*[:：]\\s*', 'g'), '');                            // ⑤
    t = t.replace(new RegExp('(?:' + BAD_TOKEN + ')(?=\\s*[，,。；;、\\]】」』]|\\s*$)', 'g'), '');             // ⑥
    t = t.replace(/[、，,]{2,}/g, (m) => m[0]);                                                              // ⑦
    t = t.replace(/ {2,}/g, ' ').replace(/[:：]\s*$/, '');
    return t.trim();
}
/**
 * 深度遍历对象 / 数组里的**字符串字段**（供载入期自愈与数据体检共用）。
 * 边界（防大对象拖慢载入）：`maxDepth`（默认 4）与 `maxStrings`（默认 20000）双上限；**只读不改**。
 * @param {*} root
 * @param {(value:string, path:string) => (string|void)} visit 返回字符串则**替换**该字段（返回 undefined 表示只读）
 * @param {{maxDepth?:number, maxStrings?:number}} [opts]
 * @returns {{visited:number, changed:number, truncated:boolean}}
 */
export function walkStrings(root, visit, opts) {
    const o = opts || {};
    const maxDepth = Math.max(0, Number(o.maxDepth) || 4);
    const maxStrings = Math.max(1, Number(o.maxStrings) || 20000);
    const out = { visited: 0, changed: 0, truncated: false };
    const walk = (node, path, depth) => {
        if (out.truncated || node == null || depth > maxDepth) return node;
        if (typeof node === 'string') {
            if (out.visited >= maxStrings) { out.truncated = true; return node; }
            out.visited++;
            const next = visit(node, path);
            if (typeof next === 'string' && next !== node) { out.changed++; return next; }
            return node;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') {
                    if (out.visited >= maxStrings) { out.truncated = true; break; }
                    out.visited++;
                    const next = visit(v, path + '[' + i + ']');
                    if (typeof next === 'string' && next !== v) { node[i] = next; out.changed++; }
                } else if (v && typeof v === 'object') node[i] = walk(v, path + '[' + i + ']', depth + 1);
            }
            return node;
        }
        if (typeof node === 'object') {
            for (const k of Object.keys(node)) {
                const v = node[k];
                const p = path ? (path + '.' + k) : k;
                if (typeof v === 'string') {
                    if (out.visited >= maxStrings) { out.truncated = true; break; }
                    out.visited++;
                    const next = visit(v, p);
                    if (typeof next === 'string' && next !== v) { node[k] = next; out.changed++; }
                } else if (v && typeof v === 'object') node[k] = walk(v, p, depth + 1);
            }
            return node;
        }
        return node;
    };
    walk(root, '', 0);
    return out;
}

/**
 * 文本归一（与 V1 完全一致：**保留换行**，仅统一 CRLF 与首尾空白，再按 max 截断）。
 * 说明：内核归一化依赖此语义（atom 正文保留段落），不要改成单行化。
 * v3.26.1：追加**坏占位 token 清理**（`undefined` / `NaN` / `[object Object]`，见 `scrubBadToken`）——
 *   这是**唯一**的写入口径，于是 AI 返回的脏值、机械演化拼出的脏值、手工编辑粘贴的脏值
 *   都不可能再落进存档（用户要求「AI 回复不可控时用默认值顶上去，避免出现异常数据」）。
 */
export function normText(s, max) {
    let t = String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
    if (hasBadToken(t)) t = scrubBadToken(t).trim();
    return (max && t.length > max) ? t.slice(0, max) : t;
}

/** 单行化（提示词/状态行展示用；与 normText 分开，避免误用） */
export function oneLine(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return (max && t.length > max) ? t.slice(0, max) : t;
}

/**
 * v3.0.17（用户要求「导出 json 备份，文件名必须带日期和时间」）——**文件名时间戳**。
 *   形如 `2026-09-30_14-05-22`：本地时间；用 `-`/`_` 而不是 `:`（Windows / 安卓 / 各类网盘都不接受冒号）。
 * @param {Date|number} [now] 时间（缺省当前）
 * @returns {string}
 */
export function fileStamp(now) {
    try {
        const d = (now instanceof Date) ? now : new Date(Number(now) || Date.now());
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
    } catch (e) { return 'unknown-time'; }
}

/**
 * 紧凑时间戳（备份文件名用）：`20260930-140522`（无 `:`，短且可直接排序）。
 * @param {Date|number} [now]
 */
export function fileStampCompact(now) {
    try {
        const d = (now instanceof Date) ? now : new Date(Number(now) || Date.now());
        const p = (n) => String(n).padStart(2, '0');
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    } catch (e) { return 'unknown'; }
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
