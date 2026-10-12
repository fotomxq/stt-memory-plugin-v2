// ============================================================
// 单元测试 · W5 两条**新门禁**（v3.45.9）：
//   ① `scripts/static-lib.js` —— 零依赖静态检查（`docs/D22` W5 `技-10`；`docs/D17` U130）
//   ② `scripts/file-size-lib.js` —— 单体文件体量门禁（`docs/D22` W5 `技-14`；`docs/D17` U134）
//
// 为什么必须有这份单测：门禁脚本本身**没有反向探针就只是一段会打印的代码**（`docs/D14` 的判据纪律）。
//   本文件对**纯函数**做正反两向断言 —— 尤其两条**实测踩过的坑**（写成回归判据）：
//     · `export { … }` 多行列表里一行注释含 `}` → 朴素正则会把列表**截断** → 合法导入被误报为错（static-lib A1/A3）；
//     · 导入扫描**不能**喂 `codeOnly()` 的输出 —— 它把 `from './x.js'` 清成 `from ""` → 一行都识别不出（A2）。
// 运行：node tests/unit/tech-gates.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    symbolsOf, importsOf, checkImports, lintCode, emptyCatchFindings, summarizeStatic, planStatic, resolveSpec, ruleApplies, STATIC_RULES,
} from '../../scripts/static-lib.js';
import { countLines, planFileSize, fileSizeReportText, DEFAULT_MARGIN, WATCHED_FILES } from '../../scripts/file-size-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('tech-gates v3.45.9 W5 新增门禁（技-10 静态检查 / 技-14 体量）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// ============================================================
// A 组：静态检查的**解析层**（导出名 / 导入清单）
// ============================================================
A('A1 `symbolsOf`：认得 `export function/const/class` · `export default` · `export *`，且**多行 `export { … }` 列表里含注释也不会截断**（实测踩过的坑）', (() => {
    const src = [
        'export const A = 1;',
        'export function B() {}',
        'export function* Bg() {}',
        'export class C {}',
        'function d() {}',
        'export { d,',
        '    // v3 注释里有 `}` 这个字符：朴素正则到这里就截断了',
        '    e, f as g };',
        'export default 42;',
    ].join('\n');
    const s = symbolsOf(src);
    return s.has('A') && s.has('B') && s.has('Bg') && s.has('C') && s.has('d') && s.has('e') && s.has('g')
        && s.has('default') && s.has('f') === false                       // `f as g` → 导出名是 g
        && symbolsOf('export * from "./x.js";').has('*');
})(), (() => Array.from(symbolsOf('export { a, b as c };')).join(','))());

A('A2 `importsOf`：具名 / 别名 / 默认 / 命名空间都能认；**注释掉的 import 不算**；说明符**必须保留原文**（喂 `codeOnly` 会丢）', (() => {
    const src = [
        "import { a, b as bb } from './x.js';",
        "import def from './y.js';",
        "import * as ns from '../core/z.js';",
        "// import { ghost } from './gone.js';",
        "/* import { ghost2 } from './gone2.js'; */",
        "const s = 1;",
    ].join('\n');
    const list = importsOf(src);
    const byFrom = {};
    for (const it of list) byFrom[it.from] = it;
    return list.length === 3
        && J(byFrom['./x.js'].names) === J(['a', 'b'])
        && byFrom['./y.js'].defaultName === 'def'
        && byFrom['../core/z.js'].ns === 'ns'
        && !byFrom['./gone.js'] && !byFrom['./gone2.js'];
})(), (() => J(importsOf("import { a } from './x.js';")))());

A('A3 `checkImports` 正向 + 反向：合法导入零命中；不存在的具名导出 / 缺失 default 都报错；`export *` 目标与非相对说明符**跳过**（不可静态判定，不制造假报）', (() => {
    const files = {
        'core/a.js': "import { ok, ok2 as alias } from './b.js';\nimport def from './b.js';\nimport { starName } from './star.js';\nimport fs from 'node:fs';\nexport const ok = 1;\n",
        'core/b.js': 'export const ok = 1;\nexport const ok2 = 2;\nexport default function d() {}\n',
        'core/star.js': 'export * from "./b.js";\n',
        'core/nodef.js': 'export const x = 1;\n',
        'core/bad.js': "import { nope } from './b.js';\n",
        'core/bad2.js': "import d2 from './nodef.js';\n",
    };
    const clean = checkImports({ 'core/a.js': files['core/a.js'], 'core/b.js': files['core/b.js'], 'core/star.js': files['core/star.js'] });
    const bad = checkImports(files);
    return clean.length === 0                                            // 含 `export *` 目标与非相对说明符 → 都不报
        && bad.length === 2
        && bad.filter((f) => f.rule === 'import-name')[0].file === 'core/bad.js'
        && bad.filter((f) => f.rule === 'import-default')[0].file === 'core/bad2.js'
        && bad.filter((f) => f.file === 'core/a.js').length === 0;       // 合法文件不受影响
})(), (() => J(checkImports({ 'core/bad.js': "import { nope } from './b.js';", 'core/b.js': '' })))());

A('A4 `resolveSpec` 相对路径解析（`..` 上跳）；非相对说明符返回空（不参与核对，避免把宿主/包当本地）', (() => {
    return resolveSpec('core/model/a.js', '../util.js') === 'core/util.js'
        && resolveSpec('core/a.js', './x/y.js') === 'core/x/y.js'
        && resolveSpec('index.js', './core/b.js') === 'core/b.js'
        && resolveSpec('core/a.js', 'node:fs') === '' && resolveSpec('core/a.js', 'tavern/x.js') === '';
})(), '');

// ============================================================
// B 组：静态检查的**规则层**（错误必须为 0；工具面不吃风格规则）
// ============================================================
A('B1 规则层：`eval` / `new Function` / `debugger` / `with` 命中为**错误**；`console.*` / `var` 为告警', (() => {
    const code = ['eval("x");', 'const F = new Function("return 1");', 'debugger;', 'with (o) { }', 'console.log(1);', 'var x = 1;'].join('\n');
    const errs = lintCode('core/x.js', code, 'shipped').filter((f) => f.level === 'error').map((f) => f.rule);
    const warns = lintCode('core/x.js', code, 'shipped').filter((f) => f.level === 'warn').map((f) => f.rule);
    return errs.indexOf('no-eval') >= 0 && errs.indexOf('no-debugger') >= 0 && errs.indexOf('no-with') >= 0
        && warns.indexOf('no-console') >= 0 && warns.indexOf('no-var') >= 0
        // 工具面（tests/scripts）：console 是**正常输出**，不查风格规则
        && lintCode('tests/x.test.js', 'console.log(1);\nvar y = 2;', 'tool').length === 0
        && ruleApplies(STATIC_RULES[0], 'shipped') === true && ruleApplies(STATIC_RULES[3], 'tool') === false;
})(), '');

A('B2 空 `catch` 判据：`catch (e) { }` 命中；写了忽略说明（`/* 忽略 */`）的**不**命中；工具面不查', (() => {
    const raw = ['try { a(); } catch (e) { }', 'try { b(); } catch (e) { /* 忽略 */ }', 'try { c(); } catch (e) {', '}'].join('\n');
    const hits = emptyCatchFindings('core/x.js', raw, 'shipped');
    return hits.length === 1 && hits[0].line === 1 && hits[0].level === 'warn'
        && emptyCatchFindings('tests/x.test.js', raw, 'tool').length === 0;
})(), '');

A('B3 `planStatic`：**错误 > 0 一律不通过**（不设基线）；告警总数或**逐规则**任一上涨都不通过', (() => {
    const err = planStatic([{ rule: 'no-eval', level: 'error' }], { warnings: 5, byRule: { 'no-console': 5 } });
    const okWarn = planStatic([{ rule: 'no-console', level: 'warn' }], { warnings: 1, byRule: { 'no-console': 1 } });
    const grownTotal = planStatic([{ rule: 'no-console', level: 'warn' }, { rule: 'no-console', level: 'warn' }], { warnings: 1, byRule: { 'no-console': 1 } });
    const grownRule = planStatic([{ rule: 'no-var', level: 'warn' }], { warnings: 1, byRule: { 'no-console': 1 } });
    return err.ok === false && err.summary.errors === 1
        && okWarn.ok === true
        && grownTotal.ok === false && grownTotal.grown.length === 1
        && grownRule.ok === false && grownRule.grown[0].rule === 'no-var'
        && summarizeStatic([{ rule: 'a', level: 'warn' }, { rule: 'b', level: 'error' }]).total === 2;
})(), '');

// ============================================================
// C 组：体量门禁
// ============================================================
A('C1 `countLines` = `wc -l` 口径（换行符个数）：结尾有换行 / 无换行 / 空串都正确', (() => {
    return countLines('a\nb\n') === 2 && countLines('a\nb') === 1 && countLines('') === 0 && countLines(null) === 0;
})(), '');

A('C2 `planFileSize` 四态：`shrunk`（变小）/ `within`（宽限内）/ `over`（超上限）/ `unbaselined`（没基线）；`--strict` 把宽限按 0', (() => {
    const base = { margin: 40, files: { 'a.js': 100, 'b.js': 100, 'c.js': 100 } };
    const cur = [{ file: 'a.js', lines: 90 }, { file: 'b.js', lines: 140 }, { file: 'c.js', lines: 141 }, { file: 'd.js', lines: 1 }];
    const p = planFileSize(cur, base, {});
    const strict = planFileSize([{ file: 'b.js', lines: 101 }], base, { strict: true });
    return p.ok === false && p.margin === 40
        && p.rows[0].status === 'shrunk' && p.rows[1].status === 'within' && p.rows[2].status === 'over' && p.rows[3].status === 'unbaselined'
        && p.rows[2].over === 1 && p.over.length === 2
        && strict.ok === false && strict.margin === 0 && strict.rows[0].over === 1
        && fileSizeReportText(p).indexOf('超出上限') > 0;
})(), '');

A('C3 **真仓自检**：当前仓库相对**已提交的基线**必须通过（防「基线文件丢了 → 门禁静默全绿」）；基线覆盖 5 个已登记文件', (() => {
    const base = JSON.parse(readFileSync(join(ROOT, 'scripts', 'file-size-baseline.json'), 'utf8'));
    const cur = WATCHED_FILES.map((w) => ({ file: w.file, lines: countLines(readFileSync(join(ROOT, w.file), 'utf8')) }));
    const p = planFileSize(cur, base, {});
    return p.ok === true && p.margin === Number(base.margin) && cur.length === 5
        && Number(base.margin) === DEFAULT_MARGIN
        && Object.keys(base.files || {}).length === 5;
})(), (() => { try { return readFileSync(join(ROOT, 'scripts', 'file-size-baseline.json'), 'utf8').slice(0, 120); } catch (e) { return 'MISSING'; } })());

R.done();
