// ============================================================
// 单元测试 · v3.45.0 `docs/D22` W5 **`技-11`** —— 覆盖率核算（零依赖 · 先观测不阻断）
//   设计：`docs/D21` §3.2 / §8 `技-11`（Node 原生覆盖率产出报告；记录 `core/` 基线；报告可读）
//   实现：`scripts/coverage-lib.js`（纯函数）+ `scripts/coverage.js`（CLI：起进程 → 收集 → 打印 → **恒退出 0**）
//
// 为什么测的是 lib 而不是 CLI：CLI 会跑**整套单测**（几分钟）—— 把它塞进门禁等于让门禁自己套自己。
//   因此把可判定的部分（字节区间 → 行、合并、汇总、前缀过滤、文案）全部抽成纯函数，在这里逐条锁住；
//   CLI 只剩「起进程 + 打印」，并由本文件静态断言它**不参与门禁**且**退出码恒 0**（`技-11` 的「先观测」）。
//
// 运行：node tests/unit/coverage-tool.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { coveredLinesOf, fileSummary, filterPrefix, formatSummary, lineAt, lineStartsOf, summarize } from '../../scripts/coverage-lib.js';

const R = makeReporter('coverage-tool v3.45.0 覆盖率核算（D22 W5 技-11）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

A('C1 行起始偏移（**按字节**算，中文注释也不会错位）：「a\\nb\\n」→ [0,2,4]；末尾换行不产生空行；CRLF 照常', (() => {
    const b = (s) => lineStartsOf(Buffer.from(s, 'utf8'));
    const cn = b('甲\n乙\n');                                  // 每个汉字 3 字节
    // 「以换行结尾」不产生末尾空行（2 行就是 2 行）—— 这决定了百分比的分母
    return J(b('a\nb\n')) === J([0, 2])
        && J(b('a\nb')) === J([0, 2])
        && J(b('')) === J([0])
        && J(cn) === J([0, 4])                                 // 3+1=4
        && J(b('a\r\nb\r\n')) === J([0, 3]);
})(), '');

A('C2 偏移 → 行号（二分）：首行/中间/末尾/越界各自正确', (() => {
    const starts = lineStartsOf(Buffer.from('a\nbb\nccc\n', 'utf8'));   // 行起始：0,2,5
    return lineAt(starts, 0) === 1 && lineAt(starts, 1) === 1 && lineAt(starts, 2) === 2
        && lineAt(starts, 4) === 2 && lineAt(starts, 5) === 3 && lineAt(starts, 99) === 3;
})(), '');

A('C3 区间 → 已覆盖行：只认 count>0；半开区间（`endOffset-1`）不多算一行；多段区间取并集', (() => {
    const src = Buffer.from('L1\nL2\nL3\nL4\nL5\n', 'utf8');       // 行起始：0,3,6,9,12
    const one = coveredLinesOf(src, [{ startOffset: 0, endOffset: 3, count: 1 }]);        // 只覆盖第 1 行
    const zero = coveredLinesOf(src, [{ startOffset: 0, endOffset: 12, count: 0 }]);      // count=0 → 不计
    const multi = coveredLinesOf(src, [
        { startOffset: 0, endOffset: 6, count: 1 },                                        // 第 1-2 行
        { startOffset: 9, endOffset: 15, count: 3 },                                       // 第 4-5 行
    ]);
    return J(Array.from(one)) === J([1]) && zero.size === 0
        && J(Array.from(multi).sort((a, b) => a - b)) === J([1, 2, 4, 5]);
})(), '');

A('C4 单文件汇总：`lines` = 总行数、`covered` = 命中行数、`pct` 保留一位小数；**空行与注释也算行**（保守偏低，输出里明说）', (() => {
    const src = Buffer.from('// 注释\n\nconst a = 1;\n', 'utf8');   // 3 行
    const half = fileSummary('core/x.js', src, [{ startOffset: 0, endOffset: 7, count: 1 }]);   // 只命中第 1 行
    const none = fileSummary('core/x.js', src, []);
    const bad = fileSummary('core/x.js', Buffer.from('', 'utf8'), []);
    return half.lines === 3 && half.covered === 1 && half.pct === 33.3
        && none.covered === 0 && none.pct === 0 && bad.lines === 1 && bad.pct === 0;
})(), '');

A('C5 汇总：同一文件的多条 coverage 条目**合并**（子进程各写一份）；按 pct 升序（最低的排最前，便于先看欠账）；totals 一致', (() => {
    const mk = (url, ranges) => ({ url: url, functions: [{ ranges: ranges }] });
    const src = Buffer.from('1\n2\n3\n4\n', 'utf8');
    // 只把「本仓库源码」映射成文件；测试文件与 `node:` 内置 → null（与真实 CLI 的 `resolveUrl` 同口径）
    const resolve = (url) => {
        const m = /(?:core|host|adapters|ui)\/[\w.-]+\.js$/.exec(String(url));
        return m ? { file: m[0], source: src } : null;
    };
    const sum = summarize([
        mk('file:///x/core/a.js', [{ startOffset: 0, endOffset: 2, count: 1 }]),
        mk('file:///x/core/a.js', [{ startOffset: 4, endOffset: 6, count: 1 }]),                 // 与上一条合并 → 2 行
        mk('file:///x/core/b.js', [{ startOffset: 0, endOffset: 8, count: 1 }]),                 // 4 行
        mk('file:///x/host/c.js', [{ startOffset: 0, endOffset: 2, count: 1 }]),                 // 非 core → 仍统计
        mk('file:///x/tests/unit/t.test.js', [{ startOffset: 0, endOffset: 8, count: 1 }]),      // 测试文件 → resolve 返回 null
        mk('node:internal/x', []),
    ], resolve);
    const a = sum.files.filter((f) => f.file === 'core/a.js')[0];
    return sum.files.length === 3 && a.covered === 2 && a.lines === 4
        && sum.totals.lines === 4 + 4 + 4 && sum.totals.covered === 2 + 4 + 1
        && sum.files[0].pct <= sum.files[sum.files.length - 1].pct;
})(), '');

A('C6 前缀过滤（`技-11` 的基线口径是 `core/`）与文案：`filterPrefix` 只留前缀；`formatSummary` 末行是合计并写明单位', (() => {
    const files = [{ file: 'core/a.js', pct: 50, covered: 1, lines: 2 }, { file: 'ui/b.js', pct: 10, covered: 1, lines: 10 }];
    const core = filterPrefix(files, 'core/');
    const txt = formatSummary({ files: core, totals: { lines: 2, covered: 1, pct: 50 } });
    return core.length === 1 && core[0].file === 'core/a.js'
        && txt.indexOf('core/a.js') >= 0 && txt.indexOf('合计 50%') >= 0 && txt.indexOf('1/2 行') >= 0;
})(), '');

A('C7 **真实源文件**（不是合成数据）：拿 `core/util.js` 实测 —— 全量区间 → 100%，空区间 → 0%，且 `covered ≤ lines`', (() => {
    const src = readFileSync(join(ROOT, 'core', 'util.js'));
    const all = fileSummary('core/util.js', src, [{ startOffset: 0, endOffset: src.length, count: 1 }]);
    const none = fileSummary('core/util.js', src, []);
    return all.pct === 100 && all.covered === all.lines && all.lines > 100
        && none.covered === 0 && none.pct === 0;
})(), '');

A('C8 **先观测不阻断**（`技-11` 的硬口径）：CLI 恒以退出码 0 结束，且**不在** `gate` 链里；`package.json` 有独立入口 `coverage`', (() => {
    const cli = readFileSync(join(ROOT, 'scripts', 'coverage.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const gate = String(pkg.scripts.gate || '');
    // v3.45.4：原判据用 `gate.indexOf('coverage') < 0`（子串）。W10 新增的 `scripts/check-debug-coverage.js`
    //   是**另一件事**（调试面完整性门禁，故意进 gate），文件名里也含 "coverage" → 子串判据会误伤。
    //   这里收窄为「gate 链里不得出现**覆盖率工具本体** `scripts/coverage.js`」，语义比原来更准。
    const gateHasCoverageTool = /(?:^|&&)\s*node\s+scripts\/coverage\.js\s*(?=&&|$)/.test(gate);
    return /process\.exit\(0\)/.test(cli)
        && !gateHasCoverageTool
        && typeof pkg.scripts.coverage === 'string' && pkg.scripts.coverage.indexOf('scripts/coverage.js') >= 0;
})(), '');

A('C9 **零依赖**（`docs/D21` Q5）：两个脚本只 import `node:` 内置与本地文件，且全仓**没有** `node_modules` 依赖声明', (() => {
    const lib = readFileSync(join(ROOT, 'scripts', 'coverage-lib.js'), 'utf8');
    const cli = readFileSync(join(ROOT, 'scripts', 'coverage.js'), 'utf8');
    const bad = [];
    for (const [name, src] of [['coverage-lib.js', lib], ['coverage.js', cli]]) {
        const re = /from '([^']+)'/g;
        let m;
        while ((m = re.exec(src))) {
            const spec = m[1];
            if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue;
            bad.push(name + ' → ' + spec);
        }
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return bad.length === 0 && !pkg.dependencies && !pkg.devDependencies;
})(), '');

R.done();
