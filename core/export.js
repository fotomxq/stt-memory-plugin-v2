// ============================================================
// core/export.js —— **导出的分段组装**（v3.45.7，用户报告「数据导出功能会直接卡死」）
//
// 背景（真机取证）：宿主里同一份存档的**主文件约 10 MB**（`ftt.fileTransport.lastWrite.bytes = 10432694`）。
//   旧导出实现（`index.js#exportStateJson`）在这么大的数据上做了四件重活：
//     ① `JSON.parse(JSON.stringify(state))` —— **整份深拷贝**（10 MB 对象 → 字符串 → 再解析回来）；
//     ② `JSON.stringify(envelope, null, 2)` —— **2 空格美化**（体积再涨约 1.5~2 倍，且逐键缩进极慢）；
//     ③ 把这一整串塞进 `<textarea>` 渲染（`ui/panel.js` 的导出结果框）；
//     ④ 把这一整串写进剪贴板（`navigator.clipboard.writeText`）。
//   ②③④ 任何一条都足以让 WebView 卡死 —— 用户看到的就是「点导出直接卡死，与数据量有关」。
//
// 本模块把导出改成**分段组装**（= 用户建议的「动态注入」形态）：
//   · `exportChunks()` 是**纯生成器**，逐段产出 JSON 片段（`{section, part, index, total}`）——
//     调用方可以**逐段让出主线程**（UI 层负责 `await` 一个宏任务），也可以直接收进数组；
//   · 分片可**直接交给 `Blob(parts)`**（`ui/file-io.js#downloadTextParts`）——
//     于是**不需要**先拼成一整串，省掉一份等量内存与一次全量拷贝；
//   · 语义与旧实现**逐字节等价**：`parts.join('') === JSON.stringify(exportEnvelopeValue(state, meta))`
//     （由 `tests/unit/export-chunks.test.js` 强制）；导入侧只认 JSON，故格式（紧凑 / 美化）不影响兼容。
//
// 纯内核：不碰宿主 / DOM / 定时器（`scripts/check-core-purity.js`），让出主线程由 UI 层做。
// ============================================================

/** 导出信封的格式标识（与历史实现一致：导入侧按它判形态） */
export const EXPORT_FORMAT = 'ftt-memory-v2-export';
/**
 * **页内内联上限**（字符）：超过它的导出**不进面板文本框、不写剪贴板** ——
 *   两处都是「把整串文本交给浏览器渲染 / 剪贴板」的动作，几 MB 起就会让界面卡死。
 *   超过时只落文件（分段 Blob），并如实告知用户「内容较大、未在页内显示」。
 */
export const EXPORT_INLINE_MAX = 1024 * 1024;
/**
 * **保留人读美化（2 空格缩进）的上限**（字符）：小存档导出继续给人读格式（历史行为不变）；
 *   大存档一律紧凑 —— 美化会让体积翻倍且显著变慢，而导入并不需要它。
 */
export const EXPORT_PRETTY_MAX = 512 * 1024;
/**
 * **分批让出主线程的粒度**（字符）：分段组装累计到这么多字符时，调用方应 `await` 一次宏任务
 *   （见 `ui/panel.js#buildExportPartsForPanel`）。小存档因此**一次组装就结束**（不让出），
 *   大存档才分批让出 —— 既不让界面卡住，也不让「点了没立刻落文件」成为新问题。
 */
export const EXPORT_YIELD_CHARS = 256 * 1024;

/** 是否「普通对象」（只有它能按键拆段；数组 / 类实例 / 原始值一律整段序列化） */
function isPlainObject(v) {
    try {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
    } catch (e) { return false; }
}

/**
 * 导出信封的**值形态**（数据源，不是文本）：`{format, version, scope, at, state}`。
 * `exportChunks()` 产出的文本必须与 `JSON.stringify(本函数结果)` 逐字节相同。
 * @param {object} state 记忆状态
 * @param {{format?:string, version?:string, scope?:string, at?:number}} [meta] 元信息（缺省用格式标识 / 空串 / 0）
 */
export function exportEnvelopeValue(state, meta) {
    const m = meta || {};
    return {
        format: String(m.format === undefined ? EXPORT_FORMAT : m.format),
        version: String(m.version === undefined ? '' : m.version),
        scope: String(m.scope === undefined ? '' : m.scope),
        at: Number(m.at) || 0,
        state: state === undefined ? null : state,
    };
}

/** 状态里会被拆成独立分段的键（普通对象才有；用于进度与测试，不参与结果语义） */
export function exportSectionKeys(state) {
    try { return isPlainObject(state) ? Object.keys(state) : []; } catch (e) { return []; }
}

/**
 * **逐段产出导出 JSON**（生成器；纯函数、无副作用）。
 * @param {object} state 记忆状态
 * @param {object} [meta] 元信息（见 `exportEnvelopeValue`）
 * @yields {{section:string, part:string, index:number, total:number}}
 */
export function* exportChunks(state, meta) {
    const env = exportEnvelopeValue(state, meta);
    const st = env.state;
    const split = isPlainObject(st);
    const keys = split ? Object.keys(st) : [];
    // 总量 = 头 + （开括号）+ 各键 / 整段值 + 尾；键里值为 undefined 的会在产出时跳过（与 `JSON.stringify` 同口径）
    const total = 3 + (split ? keys.length : 0);
    let index = 0;
    const head = { format: env.format, version: env.version, scope: env.scope, at: env.at };
    // 头：与 `JSON.stringify` 的键序一致 —— 去掉结尾 `}` 后接 `,"state":`
    yield { section: '@meta', part: JSON.stringify(head).slice(0, -1) + ',"state":', index: index++, total: total };
    if (split) {
        yield { section: '@state-open', part: '{', index: index++, total: total };
        let first = true;
        for (const key of keys) {
            let json;
            try { json = JSON.stringify(st[key]); } catch (e) { json = undefined; }
            // `JSON.stringify` 会**丢弃** undefined / 函数 / Symbol 值的键 —— 这里同口径，避免产出非法 JSON
            if (json === undefined) continue;
            yield { section: String(key), part: (first ? '' : ',') + JSON.stringify(key) + ':' + json, index: index++, total: total };
            first = false;
        }
        yield { section: '@end', part: '}}', index: index++, total: total };     // 关 state + 关信封
    } else {
        let json;
        try { json = JSON.stringify(st); } catch (e) { json = 'null'; }
        yield { section: '@state', part: json === undefined ? 'null' : json, index: index++, total: total };
        yield { section: '@end', part: '}', index: index++, total: total };      // 关信封
    }
}

/**
 * **分段组装**（同步收集；不拼成一整串）。
 * @returns {{parts:string[], chars:number, total:number, sections:string[]}}
 */
export function exportParts(state, meta) {
    const out = { parts: [], chars: 0, total: 0, sections: [] };
    try {
        for (const c of exportChunks(state, meta)) {
            out.parts.push(String(c.part));
            out.chars += String(c.part).length;
            out.sections.push(String(c.section));
            out.total = Number(c.total) || out.total;
        }
    } catch (e) { /* 忽略：返回已组装的部分 */ }
    return out;
}

/** **分段组装的等价整串**（小数据用；大存档请直接用 `exportParts()` 的分段） */
export function exportTextOf(state, meta) {
    try { return exportParts(state, meta).parts.join(''); } catch (e) { return ''; }
}

/** 该字符数是否允许「页内内联」（进文本框 / 写剪贴板）—— 唯一判据，UI 与测试共用 */
export function exportInlineAllowed(chars) {
    return (Number(chars) || 0) <= EXPORT_INLINE_MAX;
}
