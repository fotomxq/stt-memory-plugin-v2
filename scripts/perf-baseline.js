#!/usr/bin/env node
// ============================================================
// scripts/perf-baseline.js —— **跑一次探针并把四类读数写成基线**（v3.45.4 · `docs/D31` §4 · `技-39` · 台账 U191）
//
// 用法：node scripts/perf-baseline.js [--write] [--dry-run] [--json]
//   · 不带 `--write`：**只打印**四类读数 / 卡顿摘要 / 优化清单（**不动文件**）；
//   · `--write`：把读数落 `scripts/perf-baseline.json`（UTF-8 无 BOM）；
//   · `--dry-run`：即使给了 `--write` 也只打印计划（两个开关可叠加，便于「先看再写」）；
//   · `--json`：额外打印基线的 JSON 文本（便于粘进排查记录）。
// 退出码：0 = 正常；2 = 用法错误。
//
// 数据来源：**确定性合成库**（本脚本经 `scripts/perf-baseline-lib.js` 自造 N 条原子 / 记忆 / 快照，
//   **不用宿主**）—— 因此任何机器、任何时间跑出来都一致；探针的时钟与写队列读数由该库注入桩钩子。
//
// ============ 门禁口径（与 `scripts/check-perf-baseline.js` 同口径，写在头注以免漂移）============
//   ① 基线形状：`{ at, ver, readings:{write,read,scan,size}, note }`。
//   ② **棘轮只比「确定性量」**：条数 / 字节 / 计数（`count` `bytes` `items` `lines` `keys` 等）。
//      **耗时（ms）只记录、不参与判定** —— 理由：本机耗时噪声大（同一份数据两次跑能差数倍、
//      受宿主负载与 JIT 预热影响），拿它当门禁必然 **flaky**：同样的代码时红时绿，门禁就会被绕过。
//   ③ 劣化（当前 > 基线）→ 失败；改善（当前 < 基线）→ 只提示「可收紧」，**必须 `--write` 才写回**；
//      相等 → 通过；基线有、当前没有 → 失败（不许静默丢量）。
// ============================================================
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineOf, formatReadings, makeSyntheticState, PERF_BASELINE_NOTE, withSynthetic } from './perf-baseline-lib.js';
import { perfJankSummary, perfReadings, perfReportText, perfTargets } from '../core/perf-probe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'perf-baseline.json');

const argv = process.argv.slice(2);
const KNOWN = ['--write', '--dry-run', '--json', '--quiet'];
const unknown = argv.filter((a) => KNOWN.indexOf(a) < 0);
if (unknown.length) {
    console.error('用法错误：未知参数 ' + unknown.join(' '));
    console.error('用法：node scripts/perf-baseline.js [--write] [--dry-run] [--json] [--quiet]');
    process.exit(2);
}
const WRITE = argv.includes('--write');
const DRY = argv.includes('--dry-run');
const QUIET = argv.includes('--quiet');

// 一次装配：钩子装上 → 采四类读数 / 卡顿摘要 / 优化清单 / 摘要 → 还原钩子。
// 注意：**必须在钩子存活期间**采完所有读数（钩子还原后再调 `perfReportText` 会退化成「未接线」）。
const state = makeSyntheticState();
const gathered = withSynthetic(state, (st) => ({
    readings: perfReadings(st),
    jank: perfJankSummary(),
    targets: perfTargets(st),
    line: perfReportText(st),
}));
const { readings, jank, targets, line } = gathered;
const base = baselineOf(readings, PERF_BASELINE_NOTE);

if (!QUIET) {
    console.log('性能基线（技-39 / U191）· v' + base.ver + ' · 确定性合成库（无宿主 · 不用真实数据）');
    console.log('四类读数：');
    for (const l of formatReadings(readings)) console.log(l);
    console.log('卡顿（只记超阈段 · 默认开 · 独立于 debugLevel）：window ' + jank.window + ' · 超阈 ' + jank.count
        + ' 段（notice ' + jank.byLevel.notice + ' / stall ' + jank.byLevel.stall + ' / freeze ' + jank.byLevel.freeze + '）· 去重 ' + jank.deduped
        + ' · jankRate ' + jank.jankRate + ' · 最差 ' + (jank.worstMs ? (jank.worstMs + 'ms @ ' + jank.worstSite) : '—'));
    console.log('优化清单（潜在候选，含"未立项"）：' + targets.length + ' 条');
    for (const t of targets) console.log('  · [' + t.id + '] ' + t.现象 + ' —— ' + t.证据 + ' → ' + t.建议 + '（台账号 ' + t.台账号 + '）');
    console.log('一行摘要：' + line);
}
if (argv.includes('--json')) console.log(JSON.stringify(base, null, 2));

if (WRITE && !DRY) {
    writeFileSync(BASELINE_PATH, JSON.stringify(base, null, 2) + '\n', 'utf8');   // 无 BOM：JS 字符串写盘不带 BOM
    console.log('✅ 基线已写入 scripts/perf-baseline.json（v' + base.ver + ' · ' + base.note + '）');
} else if (!QUIET) {
    console.log('ℹ️ 基线**未写入**' + (DRY && WRITE ? '（--dry-run）' : '') + '：要落盘请加 --write');
}
process.exit(0);
