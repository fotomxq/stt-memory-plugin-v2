// ============================================================
// scripts/debug-coverage-lib.js —— **调试面完整性 / 口径一致性**的纯函数库
//   （v3.45.4，`docs/D22` W10 `技-43`；判据来源 `docs/D31` §5 的 12 类必要内容 + §3.2 的 kind 枚举化）
//
// 用户要求（原话）：「`docs/D22` §4.11 的 `技-41`（调试面口径统一）与 `技-43`（必要性完整性门禁）」
//
// 为什么需要这条判据（`docs/D31` §2.4 G7 + §6 S3）：
//   「插件必要内容是不是都有出口」此前**无人核对**：新加一个功能、忘了给它调试出口，任何门禁都发现不了。
//   `技-43` 把它变成机械判据：**12 类必要内容里任何一类在「页面分节 / 桥方法 / 调试导出字段」三处
//   都找不到出口 → 报缺口**（`--strict` 时失败）。
//
// 口径（写死在这里，CLI 与单测共用；**纯函数、零 import**）：
//   ① **证据只看消费侧**（`ui/debug.js` 的页面分节与桥方法、`devtools.js` 的调试导出字段、`index.js`
//      与 `ui/commands.js` 的同源出口）——**绝不含 `core/debug-catalog.js` 自己**：
//      若把「清单里写的 outlet 字符串」当证据，判据就变成**自证**，反向探针永远绿（这条门禁就成了摆设）。
//   ② 出口标识串只用三种形态（与 `core/debug-catalog.js#REQUIRED_CONTENT.outlets` 对齐）：
//      · 页面分节：`data-ftt-sec="x"`（**归一形态**；抽取器同时认既有写法 `data-ftt-section="x"`）；
//      · 桥方法：`ftt.*` / `sys.*` / `host.*`（`T['ftt.x'] = …` 形态的赋值）；
//      · 调试导出字段：**裸名**（`devtools.js` 里 `buildSnapshot` 的 `return {…}` 键 + `FTT` 对象字面量的键）。
//   ③ 只做**存在性**判定 —— 「出口好不好用」是人评的，机械判不了（与 `scripts/ledger-sync-lib.js` 同一纪律）。
//   ④ 同类检查②：**未登记的 `dbgLog` / `debugLogPush` kind**（`技-41` 验收 ④：新增一条 kind 未登记时
//      必须能被检查发现）。收集逻辑与 `core/debug-catalog.js#DEBUG_KINDS` 的注释**逐字对应**
//      （直接调用点 + 薄包装转发点），因此「枚举表漏了谁」是可机械核对的。
// ============================================================

/** 直接调用点：`dbgLog('x'` / `debugLogPush('x'` / `debugLogPushCoalesced('x'` / `dbgLogCoalesced('x'` */
const DIRECT_KIND_RE = /(?:dbgLog|debugLogPush|debugLogPushCoalesced|dbgLogCoalesced)\s*\(\s*'([^']*)'/g;
/** 薄包装转发点（函数声明形态）：`function log(kind, data) { … debugLogPush(kind, data) … }` */
const WRAPPER_FN_RE = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{([^\n]*)\}/g;
/** 薄包装转发点（箭头形态）：`const log = (kind, data) => { … debugLogPush(kind, data) …` */
const WRAPPER_ARROW_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*=>\s*\{?([^\n]*)/g;
/** 页面分节标记（归一为 `data-ftt-sec="x"`；两种写法都认） */
const SECTION_RE = /data-ftt-sec(?:tion)?=(?:"([^"]+)"|'([^']+)')/g;
/** 桥方法赋值（`任意标识符['ftt.x'] =`；`类别.对象` 命名契约见 §3.2） */
const BRIDGE_RE = /[A-Za-z_$][\w$]*\[['"]((?:ftt|sys|host)\.[A-Za-z0-9_]+)['"]\]\s*=/g;
/** `FTT` 对象字面量的起点（`Object.assign({}, w.FTT || {}, {` —— 第三个参数才是目标字面量） */
const FTT_LITERAL_RE = /Object\.assign\(\s*\{\s*\}\s*,\s*[^,]*,\s*\{/g;
/** `buildSnapshot` 的对象字面量起点 */
const SNAPSHOT_FN_RE = /export\s+function\s+buildSnapshot\s*\(/;

/** 归一输入：接受字符串数组或 `{file, text}` 数组（同序返回 `{file, text}`） */
export function normalizeSources(sourceTexts) {
    const arr = Array.isArray(sourceTexts) ? sourceTexts : [];
    return arr.map((it, i) => {
        if (it && typeof it === 'object' && typeof it.text === 'string') return { file: String(it.file || ('source#' + (i + 1))), text: it.text };
        return { file: 'source#' + (i + 1), text: String(it == null ? '' : it) };
    });
}

/**
 * 去掉注释（行注释 / 块注释），**保留字符串与模板字面量**。
 * 为什么必须先去掉注释再抽取：本仓库的注释里**真的**写着 `dbgLog('<kind>'` 这类占位示例
 *   （`core/debug-catalog.js` 的收集方法说明就是），不去注释就会把文档里的占位符当成真实 kind 报出来
 *   —— 「报噪声的检查等于没有检查」。同理，注释掉的 `T['ftt.x'] =` 与 `data-ftt-sec="perf"` 也不算出口证据。
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
    const s = String(text == null ? '' : text);
    let out = '', i = 0, quote = null;
    while (i < s.length) {
        const c = s[i], c2 = s[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += (c2 === undefined ? '' : c2); i += 2; continue; }
            if (c === quote) quote = null;
            i++;
            continue;
        }
        if (c === '/' && c2 === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && c2 === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
        out += c;
        i++;
    }
    return out;
}

/**
 * 从对象字面量里收集**深度 1** 的键（含简写属性 `{ probe, host: 1 }`）。
 * 跳过字符串 / 模板 / 行注释 / 块注释；括号 `(` `[` 内的逗号不算属性分隔（否则 `foo: bar(a, b, c)` 会把 `b` 当键）。
 * @param {string} text
 * @param {number} braceStart 字面量起始 `{` 的下标
 * @returns {string[]}
 */
export function literalKeys(text, braceStart) {
    const out = [];
    const s = String(text == null ? '' : text);
    let i = Number(braceStart);
    if (!(i >= 0) || s[i] !== '{') return out;
    let depth = 0, pDepth = 0, quote = null, atKey = false;
    while (i < s.length) {
        const c = s[i], c2 = s[i + 1];
        if (quote) {
            if (c === '\\') { i += 2; continue; }
            if (c === quote) quote = null;
            i++;
            continue;
        }
        if (c === '/' && c2 === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && c2 === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; i++; atKey = false; continue; }
        if (c === '(' || c === '[') { pDepth++; i++; continue; }
        if (c === ')' || c === ']') { pDepth = Math.max(0, pDepth - 1); i++; continue; }
        if (c === '{') {
            depth++;
            if (depth === 1 && pDepth === 0) atKey = true;
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth <= 0) break;
            i++;
            continue;
        }
        if (c === ',' && depth === 1 && pDepth === 0) { atKey = true; i++; continue; }
        if (atKey && depth === 1 && pDepth === 0 && /[A-Za-z_$]/.test(c)) {
            const m = /^([A-Za-z_$][\w$]*)\s*([:,}])/.exec(s.slice(i));
            if (m) {
                out.push(m[1]);
                atKey = false;
                i += m[1].length;
                continue;
            }
            atKey = false;
        }
        i++;
    }
    return out;
}

/** 定位 `pattern` 之后、`anchor` 之后的第一个 `{`（用于找对象字面量起点） */
function braceAfter(text, from, anchorRe) {
    const s = String(text == null ? '' : text);
    const tail = s.slice(Math.max(0, from));
    const m = anchorRe.exec(tail);
    if (!m) return -1;
    const start = Math.max(0, from) + m.index + m[0].length - 1;   // m[0] 以 `{` 结尾（各 anchor 都是这个形态）
    return s[start] === '{' ? start : s.indexOf('{', start);
}

/**
 * 抽取「出口标识串」（`docs/D31` §3.2 / §3.6 / §5 的三类形态）。
 * @param {Array<string|{file:string,text:string}>} sourceTexts 多份**消费侧**源码文本
 * @returns {{names:Set<string>, byFile:Object<string,string[]>, list:string[], notes:string[]}}
 */
export function collectOutlets(sourceTexts) {
    const srcs = normalizeSources(sourceTexts);
    const names = new Set();
    const byFile = Object.create(null);
    const notes = [];
    const add = (file, name) => {
        const n = String(name || '');
        if (!n) return;
        if (!byFile[file]) byFile[file] = [];
        if (byFile[file].indexOf(n) < 0) byFile[file].push(n);
        names.add(n);
    };
    for (const s of srcs) {
        const t = stripComments(s.text);   // 注释里的占位符 / 注释掉的注册行都不算证据
        // ① 页面分节标记（两种写法 → 归一 `data-ftt-sec="x"`）
        let m;
        const secRe = new RegExp(SECTION_RE.source, 'g');
        while ((m = secRe.exec(t))) add(s.file, 'data-ftt-sec="' + String(m[1] || m[2]) + '"');
        // ② 桥方法名（`T['ftt.x'] =` / `['sys.y'] =` / `['host.z'] =`）
        const brRe = new RegExp(BRIDGE_RE.source, 'g');
        while ((m = brRe.exec(t))) add(s.file, m[1]);
        // ③ 调试导出字段名：`buildSnapshot` 的 `return {…}` + `FTT` 对象字面量
        const fn = SNAPSHOT_FN_RE.exec(t);
        let found = 0;
        if (fn) {
            const b = braceAfter(t, fn.index + fn[0].length, /return\s*\{/);
            if (b >= 0) { for (const k of literalKeys(t, b)) { add(s.file, k); found++; } }
        }
        const fttRe = new RegExp(FTT_LITERAL_RE.source, 'g');
        while ((m = fttRe.exec(t))) {
            const b = m.index + m[0].length - 1;
            if (t[b] === '{') { for (const k of literalKeys(t, b)) { add(s.file, k); found++; } }
        }
        if (found === 0 && /devtools/i.test(s.file)) notes.push(s.file + '：未找到调试导出区块标记（`buildSnapshot` 的 return / `Object.assign({}, …, {`）→ 本次**没有**导出字段证据');
    }
    const list = Array.from(names).sort();
    return { names: names, byFile: byFile, list: list, notes: notes };
}

/** 兼容：`outlets` 既可以是 `collectOutlets` 的返回，也可以是 `Set` / 数组 */
function namesOf(outlets) {
    if (outlets instanceof Set) return outlets;
    if (outlets && typeof outlets === 'object' && outlets.names instanceof Set) return outlets.names;
    if (Array.isArray(outlets)) return new Set(outlets.map((x) => String(x)));
    return new Set();
}

/**
 * 逐类核对「必要内容 → 是否至少有一个出口存在」。
 * @param {Array<{no:number,name:string,outlets:string[]}>} required `core/debug-catalog.js#REQUIRED_CONTENT`
 * @param {Set<string>|{names:Set<string>}} outlets `collectOutlets` 的返回
 * @returns {{rows:Array<{no:number,name:string,declared:string[],found:string[],missing:string[],ok:boolean}>,
 *   gaps:Array<object>, ok:boolean, total:number}}
 */
export function checkCoverage(required, outlets) {
    const names = namesOf(outlets);
    const rows = [];
    for (const it of (Array.isArray(required) ? required : [])) {
        const declared = Array.isArray(it && it.outlets) ? it.outlets.map((x) => String(x)) : [];
        const found = declared.filter((x) => names.has(x));
        const missing = declared.filter((x) => !names.has(x));
        rows.push({ no: Number((it && it.no) || 0), name: String((it && it.name) || ''), declared: declared, found: found, missing: missing, ok: found.length > 0 });
    }
    const gaps = rows.filter((r) => !r.ok);
    return { rows: rows, gaps: gaps, ok: gaps.length === 0, total: rows.length };
}

/** 人读报告（12 类逐类的出口与结论 + 汇总） */
export function coverageText(report) {
    const r = report || {};
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const lines = ['必要内容完整性检查（`docs/D31` §5 的 12 类 × 出口：页面分节 / 桥方法 / 调试导出）：'];
    for (const row of rows) {
        const mark = row.ok ? '✅' : '❌';
        const found = row.found.length ? row.found.join('、') : '（无）';
        lines.push('  ' + mark + ' ' + String(row.no).padStart(2, ' ') + ' ' + row.name + ' ← ' + found);
        if (!row.ok) lines.push('        缺失出口（声明）：' + (row.missing.length ? row.missing.join('、') : '（未声明任何出口）'));
    }
    const gaps = Array.isArray(r.gaps) ? r.gaps : [];
    lines.push('汇总：必要内容 ' + Number(r.total || rows.length) + ' 类 · 具备 ' + (rows.length - gaps.length) + ' · 缺口 ' + gaps.length
        + (gaps.length ? ('（' + gaps.map((g) => g.name).join('、') + '）') : ''));
    return lines.join('\n');
}

// ============================================================
// 同类检查②：未登记的 `dbgLog` / `debugLogPush` kind（`技-41` 验收 ④）
// ============================================================
/** 收集某份源码里「薄包装转发函数」的名字（第一参数被原样转给 debugLogPush / dbgLog） */
export function wrapperNames(text) {
    const t = String(text == null ? '' : text);
    const out = new Set();
    const scan = (re) => {
        let m;
        const r = new RegExp(re.source, 'g');
        while ((m = r.exec(t))) {
            const p1 = String(m[2] || '');
            if (!p1) continue;
            if (new RegExp('(?:debugLogPush|dbgLog|dbgLogCoalesced|debugLogPushCoalesced)\\s*\\(\\s*' + p1 + '\\b').test(String(m[3] || ''))) out.add(m[1]);
        }
    };
    scan(WRAPPER_FN_RE);
    scan(WRAPPER_ARROW_RE);
    return out;
}

/**
 * 收集源码里出现的**全部**日志 kind（直接调用点 + 薄包装调用点）。
 * @param {Array<string|{file:string,text:string}>} sourceTexts
 * @returns {{kinds:Set<string>, byFile:Object<string,string[]>}}
 */
export function collectLogKinds(sourceTexts) {
    const srcs = normalizeSources(sourceTexts);
    const kinds = new Set();
    const byFile = Object.create(null);
    for (const s of srcs) {
        const clean = stripComments(s.text);   // ★ 注释里写的 `dbgLog('<kind>'` 是文档占位符，不是真实 kind
        const add = (k) => {
            const v = String(k == null ? '' : k);
            if (!v) return;
            kinds.add(v);
            if (!byFile[s.file]) byFile[s.file] = [];
            if (byFile[s.file].indexOf(v) < 0) byFile[s.file].push(v);
        };
        let m;
        const re = new RegExp(DIRECT_KIND_RE.source, 'g');
        while ((m = re.exec(clean))) add(m[1]);
        for (const w of wrapperNames(clean)) {
            const wre = new RegExp('(?:^|[^\\w$.])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(\\s*\'([^\']*)\'', 'g');
            let wm;
            while ((wm = wre.exec(clean))) add(wm[1]);
        }
    }
    return { kinds: kinds, byFile: byFile, list: Array.from(kinds).sort() };
}

/** 从 `core/debug-catalog.js` 的**文本**里读出 `DEBUG_KINDS` 声明的 kind 集合（文本 ↔ 模块一致性由调用方比对） */
export function collectCatalogKinds(catalogText) {
    const out = new Set();
    const s = String(catalogText == null ? '' : catalogText);
    const m = /export\s+const\s+DEBUG_KINDS\s*=\s*Object\.freeze\(\[/.exec(s);
    if (!m) return out;
    const start = m.index + m[0].length;
    let end = s.indexOf('\n]);', start);
    if (end < 0) end = s.indexOf('\n]', start);
    const block = s.slice(start, end < 0 ? s.length : end);
    const re = /kind:\s*'([^']*)'/g;
    let mm;
    while ((mm = re.exec(block))) out.add(mm[1]);
    return out;
}

/**
 * 未登记的 kind（出现即报；`技-41` 验收 ④）。
 * @param {Set<string>|string[]} sourceKinds 源码里出现的 kind
 * @param {Set<string>|string[]} registered 已登记的 kind（`DEBUG_KINDS`）
 * @returns {{registered:Set<string>, sourceKinds:Set<string>, unregistered:string[], ok:boolean}}
 */
export function checkUnregisteredKinds(sourceKinds, registered) {
    const src = (sourceKinds instanceof Set) ? sourceKinds : new Set(sourceKinds || []);
    const reg = (registered instanceof Set) ? registered : new Set(registered || []);
    const unregistered = Array.from(src).filter((k) => !reg.has(k)).sort();
    return { registered: reg, sourceKinds: src, unregistered: unregistered, ok: unregistered.length === 0 };
}

/** 未登记 kind 的人读报告 */
export function kindsText(result, byFile) {
    const r = result || {};
    const lines = ['kind 枚举检查（`docs/D31` §3.2 / §3.8「枚举化」）：源码 ' + (r.sourceKinds ? r.sourceKinds.size : 0)
        + ' 类 · 已登记 ' + (r.registered ? r.registered.size : 0) + ' 类 · 未登记 ' + ((r.unregistered || []).length) + ' 类'];
    for (const k of (r.unregistered || [])) {
        const files = (byFile && byFile[k]) ? byFile[k].join('、') : '';
        lines.push('  ❌ 未登记 kind：' + k + (files ? ('（' + files + '）') : '') + ' → 请登记进 `core/debug-catalog.js#DEBUG_KINDS`');
    }
    return lines.join('\n');
}
