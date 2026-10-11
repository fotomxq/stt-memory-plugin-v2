// ============================================================
// 单元测试 · v3.45.4 `docs/D22` W10 **`技-43`** —— 必要性完整性门禁（12 类必要内容 × 出口）
//   设计：`docs/D31-调试工具统一设计稿.md` §5（12 类必要内容）+ §6 S3（阶段验收）+ §10 `技-43`
//   实现：`scripts/debug-coverage-lib.js`（纯函数）+ `scripts/check-debug-coverage.js`（CLI，`--strict` 失败）
//
// 本文件锁五件事：
//   ① **正向**：用**真实源码**跑一遍 —— `docs/D31` §5 里「已具备」的那些类**必须全绿**；缺口只允许出现在
//      第 11/12 类（性能与卡顿 / 优化事项清单，`技-42` 的接入点），其余任何一类变红都是真回归；
//   ② **同类检查**：源码里出现的 `dbgLog` / `debugLogPush` kind 全部已登记（`技-41` 验收 ④ 的静态侧）；
//   ③ **反向探针（纯函数）**：按 `REQUIRED_CONTENT` 生成一份**删掉某类唯一出口**的源码夹具 ——
//      该类必须变成缺口、报告文本必须念出它的名字（否则这条门禁就是「永远绿」的摆设）；
//   ④ **反向探针（CLI）**：`--strict --dir <临时目录>` 在缺口时 **exit 1**，把出口补回后 **exit 0**
//      （`docs/D31` §10 `技-43` 验收 ②「人为移除某一类出口后脚本失败，恢复后通过」）；
//   ⑤ 零依赖（库与 CLI 只 import `node:` 内置 / 本地文件）。
//
// 注：跑 CLI 时**不捕获管道输出**（本机沙箱对管道有限制）—— 退出码用 `spawnSync(..., {stdio:'ignore'})`，
//   「输出里有没有那一类的名字」用**纯函数** `coverageText(report)` 直接断言。
//
// 运行：node tests/unit/debug-coverage.test.js
// ============================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeReporter } from '../harness/st-mock.js';
import { DEBUG_KINDS, REQUIRED_CONTENT } from '../../core/debug-catalog.js';
import {
    checkCoverage, checkUnregisteredKinds, collectCatalogKinds, collectLogKinds, collectOutlets,
    coverageText, kindsText, literalKeys, stripComments, wrapperNames,
} from '../../scripts/debug-coverage-lib.js';

const R = makeReporter('debug-coverage v3.45.4 技-43 必要性完整性门禁（D31 §5 12 类）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'check-debug-coverage.js');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 真实证据源（与 CLI 的 `EVIDENCE` 同序同集合） */
const EVIDENCE = ['ui/debug.js', 'ui/commands.js', 'devtools.js', 'index.js'];
const evidence = EVIDENCE.map((f) => ({ file: f, text: read(f) }));
const outlets = collectOutlets(evidence);
const realReport = checkCoverage(REQUIRED_CONTENT, outlets);

/** kind 扫描范围（与 CLI 同口径；`tests/` 有意的合成 kind 不扫，见 `debug-catalog.test.js` K1） */
function walk(dir, acc) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (p.endsWith('.js')) acc.push(p);
    }
    return acc;
}
const KIND_FILES = ['index.js', 'devtools.js'];
const kindTexts = KIND_FILES.map((f) => ({ file: f, text: read(f) })).concat(
    ['core', 'host', 'adapters', 'ui'].flatMap((d) => walk(join(ROOT, d), [])).map((p) => ({ file: p, text: readFileSync(p, 'utf8') })),
);

// ============================================================
// F 组：正向（真实源码）
// ============================================================
A('F1 正向（真实仓库）：`ui/debug.js` · `ui/commands.js` · `devtools.js` · `index.js` 四份证据源里，`docs/D31` §5 已具备的类**必须全绿**；缺口**只允许**是第 11/12 类（性能与卡顿 / 优化事项清单，`技-42` 的接入点）', (() => {
    const otherGaps = realReport.gaps.filter((g) => g.no !== 11 && g.no !== 12);
    const green = realReport.rows.filter((r) => r.ok).length;
    return realReport.total === 12 && green >= 10 && otherGaps.length === 0 && outlets.list.length > 100;
})(), J({ rows: realReport.rows.map((r) => [r.no, r.name, r.ok, r.found.length]), gaps: realReport.gaps.map((g) => g.name) }));

A('F2 同类检查・正向：源码（core/ host/ adapters/ ui/ + 入口）里出现的每一个 kind 都已在 `DEBUG_KINDS` 登记（源码 N 类 · 已登记 M 类 · 未登记 0）', (() => {
    const collected = collectLogKinds(kindTexts);
    const r = checkUnregisteredKinds(collected.kinds, new Set(DEBUG_KINDS.map((x) => x.kind)));
    return r.ok && r.sourceKinds.size >= 15 && r.registered.size === DEBUG_KINDS.length;
})(), J(checkUnregisteredKinds(collectLogKinds(kindTexts).kinds, new Set(DEBUG_KINDS.map((x) => x.kind))).unregistered));

A('F3 `collectOutlets` 三类形态都认：① 页面分节 `data-ftt-sec="x"`（**同时认**既有写法 `data-ftt-section="x"`，归一为一个标识串）；② 桥方法 `T[\'ftt.x\'] =`；③ 调试导出字段（`buildSnapshot` 的 return 与 `FTT` 字面量两处都抽）', (() => {
    const text = [
        'const html = \'<div class="ftt-section" data-ftt-section="既有写法"></div><div data-ftt-sec="新写法"></div>\';',
        "T['ftt.alpha'] = 1;",
        "T['sys.beta'] = 2;",
        'export function buildSnapshot() {',
        '    return { fromReturn: 1, shared: 2 };',
        '}',
        'w.FTT = Object.assign({}, w.FTT || {}, { fromFtt: 3, shared: 4 });',
    ].join('\n');
    const o = collectOutlets([{ file: 'x.js', text: text }]);
    return o.names.has('data-ftt-sec="既有写法"') && o.names.has('data-ftt-sec="新写法"')
        && o.names.has('ftt.alpha') && o.names.has('sys.beta')
        && o.names.has('fromReturn') && o.names.has('fromFtt') && o.names.has('shared')
        && literalKeys('({ a: 1, b, c: { d: 2 }, e: fn(x, y, z) })', 1).length === 4;
})(), '');

A('F4 真实仓库的 `coverageText` 报告含 12 行逐类结论 + 汇总行（口径：一类一行、缺口显式列出；否则人读报告等于没写）', (() => {
    const t = coverageText(realReport);
    const lines = t.split('\n');
    return t.indexOf('必要内容完整性检查') === 0 && lines.filter((l) => /^\s+[✅❌]/.test(l)).length === 12
        && t.indexOf('汇总：必要内容 12 类') >= 0 && t.indexOf('· 缺口 ') >= 0;
})(), coverageText(realReport));

// ============================================================
// N 组：反向探针（纯函数）—— 合成夹具 + 删掉某类唯一出口
// ============================================================
/** 按 `REQUIRED_CONTENT.outlets` 生成一份「所有出口都在」的最小源码夹具（同时验证：每种 outlet 拼写都机械可识别） */
function fixture(required) {
    const bridge = [], sections = [], fields = [];
    for (const it of required) {
        for (const o of it.outlets) {
            if (/^(?:ftt|sys|host)\./.test(o)) bridge.push("    T['" + o + "'] = 1;");
            else if (/^data-ftt-sec=/.test(o)) sections.push('        \'<div class="ftt-sec" ' + o + '></div>\',');
            else fields.push('        ' + o + ': 1,');
        }
    }
    const debugLines = [];
    debugLines.push('// 反向探针夹具（由 REQUIRED_CONTENT 生成；只用于验证检测器本身，不是证据源）');
    debugLines.push('function buildBridgeMethods() {');
    debugLines.push('    const T = {};');
    for (const b of bridge) debugLines.push(b);
    debugLines.push('    return T;');
    debugLines.push('}');
    debugLines.push('function debugPageHtml() {');
    debugLines.push('    return [');
    for (const s of sections) debugLines.push(s);
    debugLines.push('    ];');
    debugLines.push('}');
    const devLines = [];
    devLines.push('function buildSnapshot() {');
    devLines.push('    return {');
    for (const f of fields) devLines.push(f);
    devLines.push('    };');
    devLines.push('}');
    devLines.push('const w = { FTT: null };');
    devLines.push('w.FTT = Object.assign({}, w.FTT || {}, {');
    for (const f of fields) devLines.push(f);
    devLines.push('});');
    return { 'ui/debug.js': debugLines.join('\n'), 'devtools.js': devLines.join('\n') };
}

const FIX = fixture(REQUIRED_CONTENT);
const fixReport = checkCoverage(REQUIRED_CONTENT, collectOutlets([{ file: 'ui/debug.js', text: FIX['ui/debug.js'] }, { file: 'devtools.js', text: FIX['devtools.js'] }]));

A('N1 夹具自证（**每种 outlet 拼写都机械可识别**）：按 `REQUIRED_CONTENT.outlets` 生成的夹具 → 12 类全绿 —— 若某类出口的**写法**抽取器不认，这里就会红（这是「清单 ↔ 抽取器」的契约测试）', (() => {
    return fixReport.ok === true && fixReport.gaps.length === 0 && fixReport.rows.length === 12;
})(), J({ gaps: fixReport.gaps.map((g) => [g.no, g.missing]) }));

const STRIP = ['ftt.memoryShape', 'ftt.memorySample'];       // 第 4 类「记忆数据形状与取样」的唯一出口
const strippedDebug = FIX['ui/debug.js'].split('\n').filter((l) => !STRIP.some((s) => l.indexOf(s) >= 0)).join('\n');
const brokenReport = checkCoverage(REQUIRED_CONTENT, collectOutlets([{ file: 'ui/debug.js', text: strippedDebug }, { file: 'devtools.js', text: FIX['devtools.js'] }]));

A('N2 反向探针（纯函数）：删掉第 4 类「记忆数据形状与取样」的唯一两个出口 → 该类**必须**变成缺口（`ok=false`），且 `coverageText` 里出现它的名字与缺失清单', (() => {
    const t = coverageText(brokenReport);
    return brokenReport.ok === false && brokenReport.gaps.length === 1 && brokenReport.gaps[0].no === 4
        && brokenReport.gaps[0].name === '记忆数据形状与取样'
        && brokenReport.gaps[0].missing.indexOf('ftt.memoryShape') >= 0
        && t.indexOf('记忆数据形状与取样') >= 0 && t.indexOf('缺口 1') >= 0;
})(), J({ gaps: brokenReport.gaps.map((g) => g.name) }));

A('N3 反向探针（注释不算证据）：注释里的 `dbgLog(\'假类别\'`、注释掉的 `T[\'ftt.zzz\'] =` 与注释掉的 `data-ftt-sec="…"` 都**不能**被当成真实证据（「报噪声的检查等于没有检查」）；同时给一组**正向对照**证明抽取器本身是活的', (() => {
    const src = [
        "// dbgLog('注释里的假类别', {});",
        "/* T['ftt.zzz'] = 1; */",
        "// const html = '<div data-ftt-sec=\"注释里的假分节\"></div>';",
        'const real = 1;',
    ].join('\n');
    const kinds = collectLogKinds([{ file: 'a.js', text: src }]);
    const o = collectOutlets([{ file: 'a.js', text: src }]);
    const pos = collectLogKinds([{ file: 'a.js', text: "dbgLog('真类别', 1);" }]);
    return kinds.kinds.size === 0 && o.names.size === 0 && pos.kinds.has('真类别') && pos.kinds.size === 1
        && stripComments("const a = 1; // dbgLog('x')\n").indexOf('dbgLog') < 0
        && wrapperNames("function log(kind, data) { try { debugLogPush(kind, data); } catch (e) {} }").has('log');
})(), J({ commented: collectLogKinds([{ file: 'a.js', text: "// dbgLog('x')\ndbgLog('真类别', 1);" }]).list }));

// ============================================================
// C 组：反向探针（CLI）—— `--strict --dir` 的退出码
// ============================================================
const TMP = mkdtempSync(join(tmpdir(), 'ftt-dbgcov-'));
try {
    mkdirSync(join(TMP, 'ui'), { recursive: true });
    const runCli = (dir) => {
        const r = spawnSync(process.execPath, [CLI, '--strict', '--dir', dir], { stdio: 'ignore' });
        return r.status;
    };
    // ① 夹具（全部出口都在）→ 0
    writeFileSync(join(TMP, 'ui', 'debug.js'), FIX['ui/debug.js'], 'utf8');
    writeFileSync(join(TMP, 'devtools.js'), FIX['devtools.js'], 'utf8');
    const okCode = runCli(TMP);
    // ② 删掉第 4 类的唯一出口 → 1（反向探针）
    writeFileSync(join(TMP, 'ui', 'debug.js'), strippedDebug, 'utf8');
    const badCode = runCli(TMP);
    // ③ 恢复 → 0（`技-43` 验收②：「恢复后通过」）
    writeFileSync(join(TMP, 'ui', 'debug.js'), FIX['ui/debug.js'], 'utf8');
    const backCode = runCli(TMP);

    A('C1 **反向探针（CLI 实跑）**：`node scripts/check-debug-coverage.js --strict --dir <临时目录>` —— 出口齐全 → **exit 0**；人为删掉第 4 类的唯一出口 → **exit 1**；恢复后 → **exit 0**（`docs/D31` §10 `技-43` 验收 ②）', (() => {
        return okCode === 0 && badCode === 1 && backCode === 0;
    })(), J({ fixtureOk: okCode, stripped: badCode, restored: backCode, tmp: TMP }));
} finally {
    try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

A('C2 CLI 与纯函数**同一判据**：真实仓库上 `--strict` 的退出码 == `checkCoverage(...).ok ? 0 : 1`（门禁不是另写一套逻辑；`--strict` 才阻断，默认 warning 模式恒 `exit 0`）', (() => {
    const strict = spawnSync(process.execPath, [CLI, '--strict'], { stdio: 'ignore' }).status;
    const warn = spawnSync(process.execPath, [CLI], { stdio: 'ignore' }).status;
    return strict === (realReport.ok ? 0 : 1) && warn === 0;
})(), J({ strict: spawnSync(process.execPath, [CLI, '--strict'], { stdio: 'ignore' }).status, realOk: realReport.ok }));

A('C3 `collectCatalogKinds` 能从 `core/debug-catalog.js` 的**文本**里读出 `DEBUG_KINDS` 声明，且与模块导入值**逐字一致**（防「文本 ↔ 模块」漂移）；条数与 `DEBUG_KINDS` 相同', (() => {
    const fromText = collectCatalogKinds(read('core/debug-catalog.js'));
    const fromModule = new Set(DEBUG_KINDS.map((x) => x.kind));
    const diff = Array.from(new Set(Array.from(fromText).concat(Array.from(fromModule)))).filter((k) => !(fromText.has(k) && fromModule.has(k)));
    return fromText.size === fromModule.size && fromText.size === DEBUG_KINDS.length && diff.length === 0
        && kindsText(checkUnregisteredKinds(fromModule, fromModule), {}).indexOf('未登记 0 类') >= 0;
})(), J({ text: collectCatalogKinds(read('core/debug-catalog.js')).size, module: DEBUG_KINDS.length }));

A('C4 零依赖（`docs/D21` Q5）：`debug-coverage-lib.js` **没有任何 import**（纯函数库）；`check-debug-coverage.js` 只 import `node:` 内置 / 本地文件 / `../core/debug-catalog.js`', (() => {
    const lib = read('scripts/debug-coverage-lib.js');
    const cli = read('scripts/check-debug-coverage.js');
    const bad = [];
    for (const m of cli.matchAll(/from\s+'([^']+)'/g)) {
        const s = m[1];
        if (s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')) continue;
        bad.push(s);
    }
    return /^\s*import\s/m.test(lib) === false && bad.length === 0;
})(), '');

R.done();
