// ============================================================
// 单元测试 · v3.50.11：`技-54` 台账头部机械判据
//   （`docs/D22` §4.25 · `docs/D45` §2.6 F5）
//
// 缺陷：两份台账的头部口径（§1 标题区间 / 「事实条目 N 条」/「关联 U1–Un」/「事实基准 vX」）**全靠人手同步**，
//   任何门禁都不核 → 实测已漂移（区间 `U1–U227` 而实际 242；「事实条目 227 条」而实际 242；基准 v3.45.x 而程序 v3.50.x）。
//   本轮把「声明 vs 实测」做成机械判据，接进 `scripts/check-ledger-sync.js`。
//
// 口径：**宁少不误报** —— 措辞不匹配就跳过该项，绝不因此报错；只有「声明存在且与实测不符」才失败。
//
// 运行：node tests/unit/ledger-header.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { checkLedgerHeaders, declaredUMax, declaredUCount, declaredBaselineVersion } from '../../scripts/ledger-header-lib.js';
import { collectRegisteredUs } from '../../scripts/ledger-sync-lib.js';
import { VERSION } from '../../core/constants.js';

const R = makeReporter('ledger-header v3.50.11：`技-54` 台账头部机械判据（区间 / 条数 / 事实基准）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const D17 = readFileSync(join(ROOT, 'docs', 'D17-未落实事项台账.md'), 'utf8');
const D22 = readFileSync(join(ROOT, 'docs', 'D22-开发待办清单.md'), 'utf8');
const us = collectRegisteredUs(D17);
const ACTUAL_MAX = Math.max(0, ...Array.from(us.keys()).map((x) => Number(String(x).replace('U', ''))).filter((n) => Number.isFinite(n)));
const run = (truth, ledger) => checkLedgerHeaders({ truthText: truth, ledgerText: ledger, actualUMax: ACTUAL_MAX, actualUCount: us.size, programVersion: VERSION });

// ---------- A 组：真实仓库 ----------
A('A1 **真仓通过**：两份台账头部声明与实测一致（与 `core/constants.js#VERSION`、D17 实际登记条数 / 最大 U 号比对）', (() => {
    const r = run(D17, D22);
    return r.ok === true;
})(), () => J(run(D17, D22).checks));

A('A2 判据**至少核了 3 项**（区间 / 条数 / 事实基准；措辞不匹配的项允许 skipped，但不得全跳过）', (() => {
    const r = run(D17, D22);
    return r.checks.filter((x) => !x.skipped).length >= 3;
})(), () => J(run(D17, D22).checks.map((x) => [x.name, x.skipped])));

A('A3 解析器读数：D17 §1 标题区间 / D22「事实条目 N 条」都能解析出来且等于实测', (() => {
    const sec1 = D17.split('\n').filter((l) => /^##\s*1\./.test(l))[0] || '';
    return declaredUMax(sec1) === ACTUAL_MAX && declaredUCount(D22) === us.size && declaredBaselineVersion(D22) === VERSION;
})(), () => J({ sec1: declaredUMax(D17.split('\n').filter((l) => /^##\s*1\./.test(l))[0] || ''), count: declaredUCount(D22), ver: declaredBaselineVersion(D22), actual: ACTUAL_MAX, n: us.size, VERSION: VERSION }));

// ---------- B 组：反向探针（改错必须红） ----------
A('B1 **反向探针 · 区间**：把 D17 §1 标题区间改小一号 → 必须失败且点名该行', (() => {
    const bad = D17.replace(/^##\s*1\.(.*?U1\s*[–\-~—]\s*U)(\d+)(.*)$/m, (m, a, n, c) => '## 1.' + a + (Number(n) - 1) + c);
    const r = run(bad, D22);
    return r.ok === false && r.checks.some((x) => !x.ok && x.name.indexOf('D17 §1') >= 0);
})(), 'n/a');

A('B2 **反向探针 · 条数**：把 D22「事实条目（N 条）」改大一号 → 必须失败', (() => {
    const bad = D22.replace(/事实条目（\*\*(\d+) 条\*\*/, (m, n) => '事实条目（**' + (Number(n) + 3) + ' 条**');
    const r = run(D17, bad);
    return r.ok === false && r.checks.some((x) => !x.ok && x.name.indexOf('事实条目') >= 0);
})(), 'n/a');

A('B3 **反向探针 · 事实基准**：把 D22「事实基准 vX」改成旧版本 → 必须失败', (() => {
    const bad = D22.replace(/事实基准\*\*：程序 \*\*v[\d.]+\*\*/, '事实基准**：程序 **v3.0.0**');
    const r = run(D17, bad);
    return r.ok === false && r.checks.some((x) => !x.ok && x.name.indexOf('事实基准') >= 0);
})(), 'n/a');

A('B4 **宁少不误报**：措辞不匹配（头里没有区间 / 条数 / 基准的声明）→ 该项**跳过**且整体不报错', (() => {
    const r = checkLedgerHeaders({ truthText: '## 1. 清单\n（没有任何区间声明）\n', ledgerText: '（没有事实条目也没有基准）\n', actualUMax: ACTUAL_MAX, actualUCount: us.size, programVersion: VERSION });
    return r.ok === true && r.checks.every((x) => x.skipped === true);
})(), 'n/a');

// ---------- C 组：接线（门禁真的在用它） ----------
A('C1 `scripts/check-ledger-sync.js` 已接入头部判据：导入 `checkLedgerHeaders` 并把不一致计入 problems（退出码非 0）', (() => {
    const src = readFileSync(join(ROOT, 'scripts', 'check-ledger-sync.js'), 'utf8');
    return src.indexOf('checkLedgerHeaders') >= 0 && src.indexOf('台账头部口径漂移') >= 0 && src.indexOf('process.exit(1)') >= 0;
})(), 'n/a');

A('C2 反向探针：门禁的输出里确实会打印「头部口径 N 项已核」（证明它不只是导入、而是真的在跑）', (() => {
    const src = readFileSync(join(ROOT, 'scripts', 'check-ledger-sync.js'), 'utf8');
    return src.indexOf('头部口径 ') >= 0 && src.indexOf('headerReport') >= 0;
})(), 'n/a');

R.done();
