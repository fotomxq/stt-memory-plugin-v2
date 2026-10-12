// ============================================================
// scripts/static-lib.js —— **零依赖静态检查**的纯函数库（`docs/D22` W5 `技-10`；`docs/D17` U130）
//
// 依据与裁决：
//   · `docs/D21` §3.2 `技-10`：「加零依赖的类型检查（新增一份 jsconfig.json 并启用 `checkJs`，只对 `core/` 与 `adapters/` 起步）
//     与最小 lint 规则集」；验收 = 「`checkJs` 在 `core/`+`adapters/` 零报错（或告警数登记为基线且只减不增）」；
//   · `docs/D21` §6 **Q5 用户裁决**：「**不允许**引入需要 `node_modules` 的工具；只用零依赖或 Node 原生能力」。
//
// ⚠️ 与 §8 的一处**有意差异（如实登记）**：`jsconfig.json + checkJs` 需要 TypeScript（`node_modules`）→ 与 Q5 冲突，
//   本仓**不引入**。本模块交付的是**零依赖的等价物**：
//     ① **语法层**：由 `check-static.js` 调 `node --check`（Node 原生，零依赖）；
//     ② **类型层最小等价物**：**导入名必须在目标模块的导出里存在**（`importsOf` × `symbolsOf`）——
//        这是 JS 里最常见的一类「类型错误」（导入不存在的具名导出 → 运行时静默 `undefined`，正是 `checkJs` 会抓的那类）；
//     ③ **最小 lint 规则集**：明确禁止项（`eval` / `new Function` / `debugger` / `with`）+ 债务类告警
//        （`console.*` / `var` / 空 `catch` 无说明）。
//
// 口径：本模块**不读盘、不打印、不退出**（调用方负责 I/O 与退出码），便于单测做反向探针。
// ============================================================
import { codeOnly } from './check-core-refs.js';

/**
 * **最小 lint 规则集**（`level`：`error` = 必须为 0；`warn` = 计入基线、只减不增）。
 * 每条都刻意选「零依赖可判定、且在本仓有明确约定」的形态（宁可少而准，不做噪声规则）。
 * `scope`：`shipped` = 交付面（`core/ host/ adapters/ ui/` + 入口）适用全部规则；
 *   `tool` = 工具面（`scripts/ tests/`）**只适用正确性规则**（`import-*` / `syntax`）——
 *   测试 runner 与脚本**本来就该**往 stdout 打印（`console.*`），对它们套「不许 console」纯属噪声。
 */
export const STATIC_RULES = Object.freeze([
    { id: 'no-eval', level: 'error', desc: '禁止 eval / new Function（动态执行 = 无法静态核对，也破坏「源码即发布物」的可审计性）', re: /\b(?:eval|Function)\s*\(/, scope: 'shipped' },
    { id: 'no-debugger', level: 'error', desc: '禁止遗留 debugger 语句（会中断宿主页面）', re: /\bdebugger\b/, scope: 'shipped' },
    { id: 'no-with', level: 'error', desc: '禁止 with 语句（严格模式不允许，且作用域不可静态判定）', re: /\bwith\s*\(/, scope: 'shipped' },
    { id: 'no-console', level: 'warn', desc: '交付代码不直接用 console.*（走 core/debug-log.js 或宿主日志，便于真机取证）', re: /\bconsole\s*\.\s*(?:log|warn|error|info|debug|trace)\s*\(/, scope: 'shipped' },
    { id: 'no-var', level: 'warn', desc: '不使用 var（块级作用域 + 避免提升类误读）', re: /(?:^|[^\w$.])var\s+[A-Za-z_$]/, scope: 'shipped' },
]);

/** 该规则是否适用于某文件面（`shipped` 全部适用；`tool` 只适用 `scope === 'shipped'` 之外的**正确性**规则） */
export function ruleApplies(rule, face) {
    if (!rule) return false;
    if (face === 'tool') return rule.scope !== 'shipped';     // 工具面：只有无 scope 限定的正确性规则
    return true;
}

/** 交付面（错误与告警都查） */
export const SHIPPED_DIRS = Object.freeze(['core', 'host', 'adapters', 'ui']);
export const SHIPPED_FILES = Object.freeze(['index.js', 'devtools.js']);
/** 工具面（只做「导入名是否存在」这类**正确性**检查；记录型文件多，规则告警仍计入基线） */
export const TOOL_DIRS = Object.freeze(['scripts', 'tests']);

/** 一行里的所有规则命中（`code` 应为 `codeOnly()` 之后的文本；`face` = `shipped` / `tool`） */
export function lintCode(rel, code, face) {
    const out = [];
    const lines = String(code == null ? '' : code).split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const rule of STATIC_RULES) {
            if (!ruleApplies(rule, face)) continue;
            if (rule.re.test(lines[i])) out.push({ file: rel, line: i + 1, rule: rule.id, level: rule.level, msg: rule.desc });
        }
    }
    return out;
}

/** 空 `catch (e) {}` / 无说明的 `catch`（**用原始文本**判断：`忽略` 这类说明必须存在，见 `core/` 既有约定） */
export function emptyCatchFindings(rel, raw, face) {
    const out = [];
    if (face === 'tool') return out;                       // 工具面不查风格（同 `ruleApplies` 的口径）
    const lines = String(raw == null ? '' : raw).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /catch\s*(?:\([^)]*\))?\s*\{\s*\}\s*;?\s*$/.exec(lines[i].trim());
        if (m) out.push({ file: rel, line: i + 1, rule: 'empty-catch', level: 'warn', msg: '空 catch：本仓风格要写明忽略原因（如 `/* 忽略 */`）—— 否则异常被静默吞掉、真机排查时无从判断' });
    }
    return out;
}

/**
 * 某模块**导出的名字**（`export function/class/const/let/var` + `export { … }` + `default` / `*`）。
 * 口径：先在 `codeOnly()` 上判（**必须**——`export { … }` 列表里常有行注释，注释里一个 `}` 就会把
 *   多行导出列表**截断**，于是真正的导出名被漏掉、反过来把「合法导入」报成错；本函数因此不接受原始文本的近似）。
 */
export function symbolsOf(code) {
    const set = new Set();
    const src = codeOnly(String(code == null ? '' : code));
    try {
        for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
        for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
            for (const part of m[1].split(',')) {
                const p = part.trim();
                if (!p) continue;
                const name = p.split(/\s+as\s+/).pop().trim();          // `X as Y` → 导出名是 Y
                if (name) set.add(name);
            }
        }
        if (/\bexport\s+default\b/.test(src)) set.add('default');
        if (/\bexport\s*\*\s*from\b/.test(src)) set.add('*');           // 再导出：调用方跳过该目标的具名核对
        if (/\bexport\s*\*\s*as\s+[A-Za-z_$][\w$]*/.test(src)) set.add('*');
    } catch (e) { /* 忽略 */ }
    return set;
}

/**
 * 某模块的**导入清单**（具名 / 默认 / 命名空间）。
 *
 * 口径（踩过的坑，写在这里防复发）：**不能用 `codeOnly()` 的输出** —— 它会把字符串整体替换成 `""`，
 *   于是 `from './util.js'` 变成 `from ""`，模块说明符就丢了（实测：探针文件一行都没被识别）。
 *   这里改用「轻量去注释」（块注释 + 整行 `//` 注释），**保留字符串原文** —— 导入行的字符串恰好就是说明符。
 * @returns {Array<{from:string, line:number, names:string[], defaultName:string, ns:string}>}
 */
export function importsOf(code) {
    const out = [];
    const src = String(code == null ? '' : code)
        .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释（含 JSDoc）→ 去掉，避免注释里的 import 被算进来
        .replace(/^\s*\/\/.*$/gm, '');             // 整行行注释
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /^\s*import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/.exec(line);
        if (!m) continue;
        const clause = m[1].trim();
        const from = m[2];
        const rec = { from: from, line: i + 1, names: [], defaultName: '', ns: '' };
        const named = /\{([^}]*)\}/.exec(clause);
        if (named) {
            for (const part of named[1].split(',')) {
                const p = part.trim();
                if (!p) continue;
                const src = p.split(/\s+as\s+/)[0].trim();               // `X as Y` → 需要存在的是 X
                if (src) rec.names.push(src);
            }
        }
        const before = clause.replace(/\{[^}]*\}/, '').replace(/^\s*,|,\s*$/g, '').trim();
        if (before && before.indexOf('*') < 0) rec.defaultName = before.replace(/,/g, '').trim();
        const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
        if (ns) rec.ns = ns[1];
        out.push(rec);
    }
    return out;
}

/** 相对导入说明符 → 仓库内相对路径（`./x.js` / `../core/y.js`）；非相对（无路径）→ 空 */
export function resolveSpec(fromRel, spec) {
    const s = String(spec || '');
    if (s.charAt(0) !== '.') return '';
    const parts = String(fromRel || '').split('/');
    parts.pop();
    for (const seg of s.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
}

/**
 * **导入名 ↔ 导出名一致性**（本模块的「类型检查最小等价物」）。
 * @param {Object<string,string>} files 仓库相对路径 → 源码
 * @returns {Array<{file:string, line:number, rule:string, level:string, msg:string}>}
 */
export function checkImports(files) {
    const out = [];
    const map = (files && typeof files === 'object') ? files : {};
    const symCache = Object.create(null);
    const symOf = (rel) => {
        if (!(rel in symCache)) symCache[rel] = (rel in map) ? symbolsOf(map[rel]) : null;   // null = 目标不在扫描面内
        return symCache[rel];
    };
    for (const rel of Object.keys(map)) {
        for (const imp of importsOf(map[rel])) {
            const target = resolveSpec(rel, imp.from);
            if (!target) continue;                                   // 非相对：宿主/包，不在核对面
            const syms = symOf(target);
            if (!syms) continue;                                     // 目标不在扫描面（或不可解析）→ 跳过（不制造假报）
            if (syms.has('*')) continue;                             // 目标有 `export *` → 具名不可静态判定，跳过
            for (const name of imp.names) {
                if (!syms.has(name)) out.push({
                    file: rel, line: imp.line, rule: 'import-name', level: 'error',
                    msg: '导入了不存在的具名导出 `' + name + '`（自 ' + imp.from + '）—— 运行时会是 undefined',
                });
            }
            if (imp.defaultName && !syms.has('default')) out.push({
                file: rel, line: imp.line, rule: 'import-default', level: 'error',
                msg: '默认导入了没有 default 导出的模块 `' + imp.from + '`',
            });
        }
    }
    return out;
}

/** 汇总（错误按规则计数；告警按规则计数 —— 基线比对用告警合计） */
export function summarizeStatic(findings) {
    const list = Array.isArray(findings) ? findings : [];
    const byRule = {};
    let errors = 0, warnings = 0;
    for (const f of list) {
        const lv = f && f.level === 'error' ? 'error' : 'warn';
        if (lv === 'error') errors++; else warnings++;
        byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    }
    return { total: list.length, errors: errors, warnings: warnings, byRule: byRule };
}

/**
 * 判定与基线比对（纯函数）：
 *   · **错误必须为 0**（不设基线）；
 *   · 告警合计 ≤ 基线（`baseline.warnings`），且**逐规则**不得比基线多（防止「这条减、那条涨」互相抵消）。
 * @param {Array} findings
 * @param {{warnings?:number, byRule?:object}} baseline
 */
export function planStatic(findings, baseline) {
    const sum = summarizeStatic(findings);
    const base = (baseline && typeof baseline === 'object') ? baseline : {};
    const baseWarn = Math.max(0, Number(base.warnings) || 0);
    const baseByRule = (base.byRule && typeof base.byRule === 'object') ? base.byRule : {};
    const grown = [];
    for (const rule of Object.keys(sum.byRule)) {
        const isErrRule = (STATIC_RULES.filter((r) => r.id === rule)[0] || {}).level === 'error' || rule.indexOf('import-') === 0;
        if (isErrRule) continue;
        const now = Number(sum.byRule[rule]) || 0;
        const was = Math.max(0, Number(baseByRule[rule]) || 0);
        if (now > was) grown.push({ rule: rule, now: now, base: was });
    }
    const ok = sum.errors === 0 && sum.warnings <= baseWarn && grown.length === 0;
    return { ok: ok, summary: sum, baseline: { warnings: baseWarn, byRule: baseByRule }, grown: grown };
}
