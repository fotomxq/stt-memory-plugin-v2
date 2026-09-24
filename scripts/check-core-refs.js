// ============================================================
// scripts/check-core-refs.js —— 内核「未定义标识符」静态门禁
// 背景：V1 逐字移植时，某些函数体引用了**同模块但未被一并移植**的辅助函数，
//   而 V1 的 `try { … } catch (e) { }`/`catch { return null; }` 会把 `ReferenceError` 静默吞掉 ——
//   表现为「某维度条目悄悄写不进去」而不是崩溃（真实案例：core/model/dims.js 缺 `splitListText`）。
// 本门禁用静态分析兜住这一类：core/ 内每个文件里出现的标识符，必须**在本文件声明 / 被 import /
//   是 JS 内建全局**，否则报违规。
// 用法：node scripts/check-core-refs.js [--json]
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'core');

/** JS 内建与语言关键字（允许在 core 中出现） */
const GLOBALS = new Set(('globalThis undefined null true false NaN Infinity Math JSON Object Array String Number Boolean ' +
    'Date RegExp Error TypeError RangeError SyntaxError Map Set WeakMap WeakSet Promise Symbol BigInt Proxy Reflect ' +
    'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI eval Function ' +
    'Intl structuredClone setTimeout clearTimeout setInterval clearInterval queueMicrotask arguments this super new typeof ' +
    'instanceof in of void delete await async yield class function return if else for while do switch case break continue ' +
    'try catch finally throw const let var import export from as default extends static get set ' +
    'DecompressionStream TextDecoder TextEncoder Blob Response Request URL URLSearchParams AbortController').split(/\s+/).filter(Boolean));

/** 剔除注释、字符串与模板字面量的「非代码」部分（模板里的 ${…} 保留为代码） */
function codeOnly(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }              // 行注释
        if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }   // 块注释
        if (c === '/' && looksLikeRegex(out)) {                                                        // 正则字面量
            i++;
            while (i < n && src[i] !== '/') {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '[') { i++; while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
                i++;
            }
            i++;
            while (i < n && /[a-z]/.test(src[i])) i++;
            out += ' '; continue;
        }
        if (c === '"' || c === "'") {                                                                  // 字符串
            const q = c; i++;
            while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            i++; out += '""'; continue;
        }
        if (c === '`') {                                                                               // 模板字面量（保留 ${…} 内的代码）
            i++; let buf = '';
            while (i < n && src[i] !== '`') {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '$' && src[i + 1] === '{') {
                    i += 2; let depth = 1; let inner = '';
                    while (i < n && depth > 0) {
                        if (src[i] === '{') depth++;
                        else if (src[i] === '}') { depth--; if (!depth) break; }
                        inner += src[i]; i++;
                    }
                    i++; buf += ' ' + codeOnly(inner) + ' ';
                    continue;
                }
                i++;
            }
            i++; out += ' `` ' + buf; continue;
        }
        out += c; i++;
    }
    return out;
}

/** 前一个有效字符能否作为正则字面量的起始（避免把除法 `a / b` 当正则） */
function looksLikeRegex(out) {
    const t = out.replace(/\s+$/, '');
    if (!t) return true;
    const last = t[t.length - 1];
    if ('=(:,[!&|?{};+*-<>%^~'.indexOf(last) >= 0) return true;
    return /(^|[^\w$])(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(t);
}

/** 本文件声明的名字（函数 / 变量 / 类 / 参数 / catch / import 与 export 名） */
function declared(code) {
    const names = new Set();
    for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // for 循环声明（含数组/对象解构）：for (const [k, v] of …) / for (let i = 0; …)
    for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) addParams(names, m[1]);
    // 对象字面量简写方法 / getter / setter：行内 `name(params) {`
    for (const m of code.matchAll(/^[ \t]*(?:async\s+)?(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) names.add(m[1]);
    // 多声明符（const a = 1, b = 2）—— 逐个逗号段取名字
    for (const m of code.matchAll(/\b(?:const|let|var)\s+((?:(?!\b(?:const|let|var)\b)[^;\n])*)/g)) {
        let depth = 0, seg = '';
        const parts = [];
        for (const ch of m[1]) {
            if ('([{'.indexOf(ch) >= 0) depth++;
            else if (')]}'.indexOf(ch) >= 0) depth--;
            if (ch === ',' && depth === 0) { parts.push(seg); seg = ''; continue; }
            seg += ch;
        }
        parts.push(seg);
        parts.forEach((p2) => {
            const t = p2.trim().split('=')[0].trim().replace(/^\.\.\./, '').replace(/^[\{\[]|[\}\]]$/g, '');
            if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        });
    }
    // 解构：const { a, b: c } = / const [a, b] =
    for (const m of code.matchAll(/\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]\s*=/g)) {
        m[1].split(',').forEach((part) => {
            const t = part.split(':').pop().trim().split('=')[0].trim().replace(/^\.\.\./, '');
            if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        });
    }
    // 参数（含箭头函数单参数 x => ）
    for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$]?[\w$]*\s*\(([^)]*)\)/g)) addParams(names, m[1]);
    for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(names, m[1]);
    for (const m of code.matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
    for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // import / export 名（含 as 别名）
    for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
        m[1].split(',').forEach((part) => {
            const t = part.split(/\bas\b/).pop().trim();
            if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
        });
    }
    for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
    for (const m of code.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    return names;
}

function addParams(names, raw) {
    raw.split(',').forEach((p) => {
        const t = p.trim().split('=')[0].trim().replace(/^\.\.\./, '').replace(/^[\{\[]|[\}\]]$/g, '').split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
}

/** 引用到的名字（排除属性访问 obj.x 与对象键 { x: } 与字符串里的内容） */
function referenced(code) {
    const out = new Set();
    for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)/g)) {
        const before = code.slice(0, m.index + m[1].length).trimEnd();
        const after = code.slice(m.index + m[1].length + m[2].length).trimStart();
        if (before.endsWith('.') || before.endsWith('?.')) continue;
        if (after.startsWith(':') && !after.startsWith('::')) continue;      // 对象键 / 标签
        out.add(m[2]);
    }
    return out;
}

function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (p.endsWith('.js')) acc.push(p);
    }
    return acc;
}

const files = walk(CORE).sort();
const violations = [];
for (const f of files) {
    const code = codeOnly(readFileSync(f, 'utf8'));
    const decl = declared(code);
    for (const name of referenced(code)) {
        if (decl.has(name) || GLOBALS.has(name)) continue;
        violations.push({ file: relative(ROOT, f), name });
    }
}

// 诊断：--explain=core/xxx.js:name 打印该名字在「仅代码」文本中的上下文与声明集合
const explainArg = process.argv.find((a) => a.indexOf('--explain=') === 0);
if (explainArg) {
    const [rel, name] = explainArg.slice('--explain='.length).split(':');
    const code = codeOnly(readFileSync(join(ROOT, rel), 'utf8'));
    const decl = declared(code);
    const idx = code.indexOf(name);
    console.log('declared count:', decl.size, '| has', name, ':', decl.has(name));
    console.log('context:', JSON.stringify(code.slice(Math.max(0, idx - 120), idx + 120)));
    process.exit(0);
}

const asJson = process.argv.includes('--json');
if (asJson) { console.log(JSON.stringify({ files: files.length, violations }, null, 2)); process.exit(violations.length ? 1 : 0); }
console.log('内核标识符检查：扫描 ' + files.length + ' 个文件（core/）');
if (violations.length) {
    console.log('❌ 内核标识符门禁未通过（' + violations.length + ' 处未定义标识符）');
    violations.slice(0, 40).forEach((v) => console.log('   · ' + v.file + ' → ' + v.name));
    process.exit(1);
}
console.log('✅ 内核标识符门禁通过（0 未定义标识符）');
