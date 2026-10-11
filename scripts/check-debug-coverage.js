#!/usr/bin/env node
// ============================================================
// scripts/check-debug-coverage.js —— **调试面完整性门禁**（v3.45.4，`docs/D22` W10 `技-43`）
//
// 用法：node scripts/check-debug-coverage.js [--strict] [--dir <源码根目录>] [--quiet]
// 退出码：默认 **warning 模式**（有缺口仍 `exit 0`，但显著打印 `⚠️ 缺口 N 类`）；
//         加 `--strict` 时**有缺口 → exit 1**（`docs/D31` §10 `技-43` ③：先进 gate 为 warning，稳定后收紧）。
//
// 判据（纯函数在 `scripts/debug-coverage-lib.js`，有单测与反向探针）：
//   ① **12 类必要内容**（`core/debug-catalog.js#REQUIRED_CONTENT` = `docs/D31` §5 的机器可读化）
//      每一类至少要有一个**出口**存在（三选一）：调试页分节标记 / 桥只读方法名 / 调试导出字段名；
//   ② **同类检查**：源码里出现的 `dbgLog` / `debugLogPush` kind 若不在 `DEBUG_KINDS` 里 → 报出来
//      （`技-41` 验收 ④「新增一条 kind 未登记时能被检查发现」）。
//
// 边界（为什么证据里**没有** `core/debug-catalog.js`）：
//   清单文件自己写着「某类的出口是 `ftt.perf`」——若把它当证据，判据就是**自证**（永远绿，反向探针失效）。
//   因此「读 `core/debug-catalog.js`」只用来：① 读出 `DEBUG_KINDS` 的**文本声明**并与模块导入值比对
//   （防「文本 ↔ 模块」漂移）；② 报出清单规模。它**不参与**出口证据。
//   `--dir` 只改**证据源目录**（反向探针用：造一份删掉某类出口的小目录 → 必须失败）；必要内容清单
//   始终来自本仓库的 `core/debug-catalog.js`（单一事实源，不随 `--dir` 变）。
// ============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CONTENT, DEBUG_KINDS } from '../core/debug-catalog.js';
import {
    checkCoverage, checkUnregisteredKinds, collectCatalogKinds, collectLogKinds, collectOutlets, coverageText, kindsText,
} from './debug-coverage-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const QUIET = process.argv.includes('--quiet');
const dirArg = process.argv.indexOf('--dir');
const BASE = (dirArg >= 0 && process.argv[dirArg + 1]) ? String(process.argv[dirArg + 1]) : ROOT;
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { return null; } };
/** 证据源（**消费侧**；缺失即跳过 —— `--dir` 的小目录只放其中几份也能跑） */
const EVIDENCE = ['ui/debug.js', 'ui/commands.js', 'devtools.js', 'index.js'];
/** kind 扫描范围（与 `docs/D31` §3.2 的「插件运行时」一致；`tests/` 与 `scripts/` 不入内） */
const KIND_DIRS = ['core', 'host', 'adapters', 'ui'];
const KIND_FILES = ['index.js', 'devtools.js'];

function walk(dir, acc) {
    let names = [];
    try { names = readdirSync(dir); } catch (e) { return acc; }
    for (const n of names) {
        const p = join(dir, n);
        let st = null;
        try { st = statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) walk(p, acc);
        else if (p.endsWith('.js')) acc.push(p);
    }
    return acc;
}

// ---------- ① 12 类必要内容的出口核对 ----------
const evidence = [];
const missingEvidence = [];
for (const rel of EVIDENCE) {
    const t = read(join(BASE, rel));
    if (t == null) missingEvidence.push(rel);
    else evidence.push({ file: rel, text: t });
}
const outlets = collectOutlets(evidence);
const report = checkCoverage(REQUIRED_CONTENT, outlets);

// ---------- ② 未登记 kind 同类检查 ----------
const catalogText = read(join(BASE, 'core', 'debug-catalog.js'));
const catalogKinds = catalogText == null ? null : collectCatalogKinds(catalogText);
const registered = new Set(DEBUG_KINDS.map((x) => x.kind));
const kindFiles = KIND_FILES.map((f) => join(BASE, f)).concat(KIND_DIRS.map((d) => join(BASE, d)).flatMap((d) => walk(d, [])));
const kindSources = [];
for (const p of kindFiles) {
    const t = read(p);
    if (t != null) kindSources.push({ file: relative(BASE, p).split('\\').join('/'), text: t });
}
const collected = collectLogKinds(kindSources);
const kindCheck = checkUnregisteredKinds(collected.kinds, registered);
// 文本 ↔ 模块一致性（清单文件的声明必须与模块导出一致；不一致说明这份清单被手改坏了）
const catalogDrift = (catalogKinds == null) ? [] : Array.from(new Set(Array.from(catalogKinds).concat(Array.from(registered))))
    .filter((k) => !(catalogKinds.has(k) && registered.has(k))).sort();

// ---------- 输出 ----------
if (!QUIET) {
    console.log('调试面完整性检查（`技-43`，`docs/D31` §5 的 ' + REQUIRED_CONTENT.length + ' 类必要内容）：'
        + '证据源 ' + evidence.length + '/' + EVIDENCE.length + ' 份（' + evidence.map((x) => x.file).join(' · ') + '）'
        + (missingEvidence.length ? ('；缺失：' + missingEvidence.join('·')) : '')
        + ' · 出口标识 ' + outlets.list.length + ' 个');
    if (outlets.notes.length) for (const n of outlets.notes) console.log('  ⚠️ ' + n);
    console.log(coverageText(report));
    console.log(kindsText(kindCheck, collected.byFile));
    if (catalogText != null) {
        console.log('清单源：`core/debug-catalog.js`（' + catalogText.split('\n').length + ' 行 · `DEBUG_KINDS` 文本声明 '
            + (catalogKinds ? catalogKinds.size : 0) + ' 类 · 模块导出 ' + registered.size + ' 类'
            + (catalogDrift.length ? ('；⚠️ 文本 ↔ 模块不一致：' + catalogDrift.join('、')) : '（文本 ↔ 模块一致）') + '）');
    } else {
        console.log('清单源：`core/debug-catalog.js` 在本目录下不存在（`--dir` 模式）→ 必要内容与 kind 表取**本仓库模块**的导出值');
    }
}

const problems = [];
if (!report.ok) problems.push('必要内容缺口 ' + report.gaps.length + ' 类：' + report.gaps.map((g) => g.name).join('、'));
if (!kindCheck.ok) problems.push('未登记 kind ' + kindCheck.unregistered.length + ' 类：' + kindCheck.unregistered.join('、'));
if (catalogDrift.length) problems.push('`DEBUG_KINDS` 文本 ↔ 模块不一致 ' + catalogDrift.length + ' 类：' + catalogDrift.join('、'));

if (!problems.length) {
    if (!QUIET) console.log('✅ 调试面完整性通过（' + REQUIRED_CONTENT.length + ' 类必要内容全部有出口 · kind 全部已登记）');
    process.exit(0);
}
for (const p of problems) console.log('  ❌ ' + p);
if (STRICT) {
    console.log('调试面完整性：' + problems.length + ' 处问题（`--strict` → exit 1；`docs/D31` §6 S3 的验收口径）');
    process.exit(1);
}
console.log('⚠️ 缺口 ' + (report.ok ? 0 : report.gaps.length) + ' 类 · 问题 ' + problems.length + ' 处（warning 模式：不阻断；'
    + '稳定后把本脚本加 `--strict` 进 `npm run gate`）');
process.exit(0);
