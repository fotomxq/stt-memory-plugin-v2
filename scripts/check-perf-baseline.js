#!/usr/bin/env node
// ============================================================
// scripts/check-perf-baseline.js —— **性能与容量基线门禁（只增不降棘轮）**（v3.45.4 · `docs/D31` §4 · `技-39` · 台账 U191）
//
// 用法：node scripts/check-perf-baseline.js [--write] [--dry-run] [--from <file>] [--quiet]
//   · 默认用 `scripts/perf-baseline.json` 作基线；`--from <file>` 用指定基线文件（反向探针 / 局部验证用）；
//   · `--dry-run`：只打印计划，**绝不写文件**；
//   · `--write`：**仅在出现「可收紧」项时**把当前读数写回基线（改善不自动生效，避免门禁自己改口径）；
//   · `--quiet`：只打印结论行。
// 退出码：0 = 通过（相等或改善）；1 = 回归 / 基线缺失或损坏（`npm run gate` 里会阻断）；2 = 用法错误。
//
// ============ 门禁口径（与 `scripts/perf-baseline.js` 同口径，写在头注以免漂移）============
//   ① 基线形状：`{ at, ver, readings:{write,read,scan,size}, note }`。
//   ② **棘轮只比「确定性量」**：条数 / 字节 / 计数（`count` `bytes` `items` `lines` `keys` 等）。
//      **耗时（ms）只记录、不参与判定** —— 理由：本机耗时噪声大（同一份数据两次跑能差数倍、
//      受宿主负载与 JIT 预热影响），拿它当门禁必然 **flaky**：同样的代码时红时绿，门禁就会被绕过。
//   ③ 某确定性量**比基线大**（劣化）→ **失败**（非零退出，逐项打印 `基线 → 当前`）；
//      **比基线小**（改善）→ 打印「可收紧」提示，**必须 `--write` 才写回**（不自动改）；
//      相等 → 通过；**基线有、当前没有** → 失败（不许把某个读数静默删掉就当作通过）。
//   ④ 判定逻辑全在 `scripts/perf-baseline-lib.js#compareToBaseline`（纯函数、有单测与反向探针），
//      本脚本只做「读文件 → 采集 → 比对 → 打印 → 退出码」。
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineOf, collectCurrent, compareToBaseline, formatCompareLines, formatReadings, PERF_BASELINE_NOTE } from './perf-baseline-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(ROOT, 'scripts', 'perf-baseline.json');

const argv = process.argv.slice(2);
const KNOWN = ['--write', '--dry-run', '--quiet'];
let fromPath = DEFAULT_BASELINE;
const unknown = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') {
        const v = argv[i + 1];
        if (!v || v.indexOf('--') === 0) { console.error('用法错误：--from 需要一个文件路径'); process.exit(2); }
        fromPath = join(ROOT, v);
        i++;
        continue;
    }
    if (KNOWN.indexOf(a) >= 0) continue;
    unknown.push(a);
}
if (unknown.length) {
    console.error('用法错误：未知参数 ' + unknown.join(' '));
    console.error('用法：node scripts/check-perf-baseline.js [--write] [--dry-run] [--from <file>] [--quiet]');
    process.exit(2);
}
const WRITE = argv.includes('--write');
const DRY = argv.includes('--dry-run');
const QUIET = argv.includes('--quiet');

// ---------- 读基线（缺失 / 损坏都按失败处理：没有基线的「通过」毫无意义） ----------
let baseline = null;
try {
    baseline = JSON.parse(readFileSync(fromPath, 'utf8'));
} catch (e) {
    console.error('❌ 读不到或解析不了基线文件：' + fromPath);
    console.error('   ' + String((e && e.message) || e));
    console.error('   先跑 `node scripts/perf-baseline.js --write` 生成基线（或用 --from <file> 指定）。');
    process.exit(1);
}
if (!baseline || typeof baseline !== 'object' || !baseline.readings) {
    console.error('❌ 基线文件形状不对（缺 `readings`）：' + fromPath);
    console.error('   期望：{ at, ver, readings:{write,read,scan,size}, note }');
    process.exit(1);
}

// ---------- 采集当前 + 比对 ----------
const { readings } = collectCurrent();
const res = compareToBaseline(readings, baseline.readings);

if (!QUIET) {
    console.log('性能基线门禁（技-39 / U191）：基线 ' + fromPath + '（v' + (baseline.ver || '?') + ' · at=' + (baseline.at || 0) + '）');
    console.log('当前读数（确定性合成库 · 无宿主）：');
    for (const l of formatReadings(readings)) console.log(l);
    for (const l of formatCompareLines(res)) console.log(l);
}

if (!res.ok) {
    const bad = res.regressions.length;
    console.error('❌ 性能基线门禁未通过：' + (res.available ? (bad + ' 项确定性量比基线大或缺失') : '基线里没有可比对的确定性量'));
    for (const it of res.regressions) console.error('   · ' + it.path + '：基线 ' + it.baseline + ' → 当前 ' + (it.current == null ? '（缺失）' : it.current));
    console.error('   只增不降棘轮的用意：条数 / 字节 / 计数一旦变大（劣化）就必须要么修回去，要么在同批里说明并更新基线。');
    process.exit(1);
}

if (res.improvements.length) {
    if (WRITE && !DRY) {
        const next = baselineOf(readings, PERF_BASELINE_NOTE);
        writeFileSync(fromPath, JSON.stringify(next, null, 2) + '\n', 'utf8');   // 无 BOM
        console.log('✅ 已把基线收紧（' + res.improvements.length + ' 项）→ ' + fromPath);
    } else {
        console.log('ℹ️ 有 ' + res.improvements.length + ' 项可收紧（加 --write 写回基线；**不自动改**）');
        for (const it of res.improvements) console.log('   · ' + it.path + '：' + it.baseline + ' → ' + it.current);
    }
}
console.log('✅ 性能基线门禁通过（确定性量 ' + res.keys.length + ' 项 · 回归 0 · 新增 ' + res.added.length + '）');
process.exit(0);
