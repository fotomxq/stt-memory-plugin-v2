#!/usr/bin/env node
// ============================================================
// scripts/check-ledger-sync.js —— **C12：实施规格 ↔ 待办清单 双向承接**（v3.45.0，`docs/D22` W5 `技-24`；
//   v2.0 起清单只列未完成，判据改为「清单有行 或 台账已落地」两态承接）
//
// 用法：node scripts/check-ledger-sync.js [--quiet]
// 退出码：0 = 一致；1 = 有不一致（会在 `npm run gate` 里阻断）
//
// 判据（纯函数在 `scripts/ledger-sync-lib.js`，有单测与反向探针）：
//   ① 每份设计稿（`docs/D*.md`，`D22` 除外）的「实施规格」表里出现的**每个编号**，都必须被一侧承接：
//      在 `docs/D22` 有对应行（待办），**或**该行「台账」列引用的 `U<n>` 在 `docs/D17` 已标「已落地」
//      （= 已交付并从待办清单移出）；
//   ② 反之，清单里出现的每个编号，都必须在**某份**设计稿的实施规格里有定义；
//   ③ 清单引用的 `U<数字>` 必须在 `docs/D17-未落实事项台账.md` 里登记过。
// 为什么这条判据存在：`docs/D17` §0 写明「两者销账时必须同时改」——此前只靠人记，
//   任何门禁都发现不了「设计稿加了实施规格、清单忘了加行」这类漂移。
//   v2.0 起清单只列未完成（已完成行移出、git 历史即留痕），故「已交付」这一侧改由 `D17` 的状态列证明。
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    collectSpecIds, collectSpecDetails, collectLedgerIds, compareIds, collectURefs, collectRegisteredUs,
    collectSettledUs, missingURefs, unaccountedSpecIds,
} from './ledger-sync-lib.js';

// v3.50.11（`docs/D22` §4.25 `技-54` / `docs/D45` §2.6 F5）：**台账头部机械判据**（区间 / 条数 / 事实基准）
import { checkLedgerHeaders } from './ledger-header-lib.js';
import { VERSION as PROGRAM_VERSION } from '../core/constants.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const LEDGER_FILE = 'D22-开发待办清单.md';
const LEDGER_LABEL = 'docs/D22-开发待办清单.md';
const TRUTH_FILE = 'D17-未落实事项台账.md';
const QUIET = process.argv.includes('--quiet');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { return null; } };

const designFiles = readdirSync(DOCS).filter((f) => /^D\d+.*\.md$/.test(f) && f !== LEDGER_FILE).sort();
const specById = new Map();
const specDetails = new Map();
for (const f of designFiles) {
    const text = read(join(DOCS, f));
    if (text == null) continue;
    for (const [id, meta] of collectSpecIds(text)) {
        const prev = specById.get(id);
        if (prev && prev.from !== f) {
            // 同编号出现在两份稿里 = 定义重复（机械可判定 → 报出来）
            specById.set(id, { from: prev.from, line: prev.line, dup: f });
        } else if (!prev) specById.set(id, { from: f, line: meta.line });
    }
    for (const [id, meta] of collectSpecDetails(text)) if (!specDetails.has(id)) specDetails.set(id, meta);
}

const ledgerText = read(join(DOCS, LEDGER_FILE));
if (ledgerText == null) { console.error('❌ 读不到 ' + LEDGER_LABEL); process.exit(1); }
const ledgerById = collectLedgerIds(ledgerText);

const { onlyLedger } = compareIds(specById, ledgerById);

const truthText = read(join(DOCS, TRUTH_FILE)) || '';
const missingU = missingURefs(collectURefs(ledgerText), collectRegisteredUs(truthText));
const settledUs = collectSettledUs(truthText);
const unaccounted = unaccountedSpecIds(specDetails, ledgerById, settledUs);

// v3.50.11（`技-54`）：头部声明 vs 实测（区间 / 条数 / 事实基准）——措辞不匹配的项自动跳过（宁少不误报）
const registeredUs = collectRegisteredUs(truthText);
const actualUMax = Math.max(0, ...Array.from(registeredUs.keys()).map((x) => Number(String(x).replace('U', ''))).filter((n) => Number.isFinite(n)));
const headerReport = checkLedgerHeaders({
    truthText: truthText, ledgerText: ledgerText,
    actualUMax: actualUMax, actualUCount: registeredUs.size, programVersion: PROGRAM_VERSION,
});

const dupIds = Array.from(specById.entries()).filter(([, m]) => m.dup).map(([id, m]) => id + '（' + m.from + ' / ' + m.dup + '）');

const problems = [];
for (const id of unaccounted) {
    problems.push('设计稿有实施规格、清单缺行，且台账未标已落地：`' + id + '`（来源 ' + (specById.get(id) || {}).from + '）');
}
for (const x of onlyLedger) problems.push('清单有行、实施规格里没有定义：`' + x.id + '`');
for (const u of missingU) problems.push('清单引用了未登记的台账条目：`' + u + '`（' + TRUTH_FILE + ' 里没有这一行）');
for (const d of dupIds) problems.push('同一编号在两份设计稿里都有实施规格：' + d);
// v3.50.11（`技-54`）：头部声明与实测不一致
headerReport.checks.filter((x) => !x.ok).forEach((x) => {
    problems.push('台账头部口径漂移：' + x.name + ' 声明 `' + x.declared + '`，实测 `' + x.actual + '`');
});

if (!QUIET) {
    console.log('台账一致性检查（C12）：设计稿 ' + designFiles.length + ' 份 · 实施规格编号 ' + specById.size
        + ' 个（其中 ' + (specById.size - unaccounted.length - onlyLedger.length) + ' 个已承接）'
        + ' · 清单编号 ' + ledgerById.size + ' 个 · 台账已落地 ' + settledUs.size + ' 个'
        + ' · 清单引用 U 编号 ' + collectURefs(ledgerText).size + ' 个（台账登记 ' + collectRegisteredUs(truthText).size + ' 个）');
}
if (problems.length) {
    for (const p of problems) console.log('  ❌ ' + p);
    console.log('台账一致性：' + problems.length + ' 处不一致（实施规格必须在清单有行，或其台账 U 在 ' + TRUTH_FILE
        + ' 标已落地；清单行必须来自某份设计稿的实施规格，见 `docs/D17` §0）');
    process.exit(1);
}
if (!QUIET) console.log('✅ 台账一致性通过（实施规格 ↔ 清单 / 台账已落地 双向承接 · U 编号全部已登记 · 头部口径 ' + headerReport.checks.filter((x) => !x.skipped).length + ' 项已核）');
process.exit(0);
