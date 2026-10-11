// ============================================================
// 单元测试 · v3.45.4 `docs/D31` §4 · **`技-39`** —— 性能基线门禁（**只增不降**棘轮）
//   设计：`docs/D31` §3.4（基线落 `scripts/perf-baseline.json`）· §4.2 判据 7 · §6 S2（反向探针必须能让门禁失败）
//   实现：`scripts/perf-baseline-lib.js`（纯函数：合成库 / 采集 / 确定性量提取 / 比对 / 文案）
//         + `scripts/perf-baseline.js`（CLI：跑探针 → 打印 → `--write` 落基线）
//         + `scripts/check-perf-baseline.js`（CLI：读基线 → 比对 → 退出码 0/1/2）
//
// 为什么**不在**本文件里跑 CLI（`execFileSync`）：本机沙箱对 `node:child_process` 的管道捕获有限制；
//   且门禁的可判定部分（比对）本就该是纯函数。因此这里直接断言纯函数，**另加静态断言**看住
//   「退出码 / 开关 / 判定逻辑只在 lib 里 / 耗时确实不做门禁」这些只有脚本才有的性质。
//
// 运行：node tests/unit/perf-baseline-gate.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { VERSION } from '../../core/constants.js';
import { setKernelState } from '../../core/model/runtime.js';
import { perfBaselineReport, perfReadings, setPerfHooks } from '../../core/perf-probe.js';
import {
    collectCurrent, collectDeterministic, compareToBaseline, formatCompareLines, pickReadings, withSynthetic,
} from '../../scripts/perf-baseline-lib.js';

const R = makeReporter('perf-baseline-gate v3.45.4 性能基线门禁（D31 §4 / 技-39 / U191）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const cl = (o) => JSON.parse(JSON.stringify(o));                    // 深拷贝（造「当前 / 基线」两侧）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_CHECK = join(ROOT, 'scripts', 'check-perf-baseline.js');
const CLI_BASE = join(ROOT, 'scripts', 'perf-baseline.js');
const LIB = join(ROOT, 'scripts', 'perf-baseline-lib.js');

// 合成库读数（确定性：任何机器、任何时间都一样）
const current = collectCurrent().readings;
const baseReadings = pickReadings(current);                          // 基线的 readings（只有四类）

A('G1 **相等 → 通过**：当前 == 基线 → `ok:true`、回归 0、改善 0，且逐项 verdict 全为 `same`', (() => {
    const r = compareToBaseline(current, baseReadings);
    return r.available === true && r.ok === true
        && r.regressions.length === 0 && r.improvements.length === 0
        && r.keys.length >= 20 && r.keys.every((x) => x.verdict === 'same')
        && r.note.indexOf('回归 0') >= 0;
})(), '');

A('G2 **劣化 → 失败**：当前比基线大 → `ok:false` + regressions 含 `基线 → 当前` 逐项对比（`delta` 正确）', (() => {
    const cur = cl(baseReadings);
    cur.scan.items.atoms += 3;
    const r = compareToBaseline(cur, baseReadings);
    const txt = formatCompareLines(r).join('\n');
    const it = r.regressions[0] || {};
    return r.ok === false && r.regressions.length === 1
        && it.path === 'scan.items.atoms' && it.verdict === 'worse'
        && it.baseline === baseReadings.scan.items.atoms && it.current === baseReadings.scan.items.atoms + 3 && it.delta === 3
        && txt.indexOf('❌ 劣化 scan.items.atoms') >= 0
        && txt.indexOf('基线 ' + baseReadings.scan.items.atoms + ' → 当前 ' + (baseReadings.scan.items.atoms + 3)) >= 0;
})(), '');

A('G3 **改善 → 通过 + 「可收紧」提示**（且 CLI 只有给 `--write` 才写回基线，不自动改）', (() => {
    const cur = cl(baseReadings);
    cur.size.mainBytes -= 10;
    const r = compareToBaseline(cur, baseReadings);
    const txt = formatCompareLines(r).join('\n');
    const cli = readFileSync(CLI_CHECK, 'utf8');
    return r.ok === true && r.regressions.length === 0 && r.improvements.length === 1
        && r.improvements[0].path === 'size.mainBytes' && r.improvements[0].delta === -10
        && txt.indexOf('可收紧 size.mainBytes') >= 0 && txt.indexOf('--write') >= 0 && txt.indexOf('不自动改') >= 0
        // 写回**只在** `--write` 且非 `--dry-run` 时发生（改善不自动改口径）
        && /if \(WRITE && !DRY\)/.test(cli) && /process\.exit\(2\)/.test(cli);
})(), '');

A('G4 **反向探针（只增不降的证据）**：人为把基线的确定性量改小 → 当前相对变大 → 门禁**必须失败**', (() => {
    const tight = cl(baseReadings);
    tight.read.totalReads -= 1;                                       // 基线被人为收紧
    tight.scan.items.atoms -= 5;
    const r = compareToBaseline(current, tight);
    const paths = r.regressions.map((x) => x.path).sort();
    return r.ok === false && J(paths) === J(['read.totalReads', 'scan.items.atoms'])
        && r.regressions.every((x) => x.verdict === 'worse' && x.delta > 0)
        && r.available === true;
})(), '');

A('G5 **耗时不做门禁**（本机噪声）：当前把 `lastMs / totalMs / avgMs / lastAt` 全部放大 → 仍然 `ok:true`，且这些量不在确定性集合里', (() => {
    const cur = cl(baseReadings);
    cur.write.lastMs += 99999; cur.write.lastAt += 100000;
    cur.read.totalMs += 1000000; cur.read.avgMs += 50000;
    const r = compareToBaseline(cur, baseReadings);
    const det = collectDeterministic(cur);
    return r.ok === true && r.regressions.length === 0 && r.improvements.length === 0
        && det['write.lastMs'] === undefined && det['read.totalMs'] === undefined
        && det['read.avgMs'] === undefined && det['write.lastAt'] === undefined
        && det['write.writes'] === baseReadings.write.writes && det['size.mainBytes'] === baseReadings.size.mainBytes;
})(), '');

A('G6 **不得静默丢量**：基线有、当前没有的确定性量 → `verdict:"missing"` 且**判失败**（否则删掉一个读数就能「通过」）', (() => {
    const cur = cl(baseReadings);
    delete cur.write.inFlight;
    const r = compareToBaseline(cur, baseReadings);
    const miss = r.regressions.filter((x) => x.path === 'write.inFlight')[0] || {};
    return r.ok === false && miss.verdict === 'missing' && miss.current === null && miss.delta === null
        && formatCompareLines(r).join('\n').indexOf('（该量缺失）') >= 0;
})(), '');

A('G7 脚本静态口径：退出码 0/1/2 · `--dry-run`/`--from`/`--write` 齐备 · 零依赖 · 门禁口径（耗时不做判定 / 只增不降）写进**头注**', (() => {
    const check = readFileSync(CLI_CHECK, 'utf8');
    const base = readFileSync(CLI_BASE, 'utf8');
    const lib = readFileSync(LIB, 'utf8');
    const badDeps = [];
    for (const [name, src] of [['check-perf-baseline.js', check], ['perf-baseline.js', base], ['perf-baseline-lib.js', lib]]) {
        const re = /from '([^']+)'/g;
        let m;
        while ((m = re.exec(src))) {
            const spec = m[1];
            if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue;
            badDeps.push(name + ' → ' + spec);
        }
    }
    return badDeps.length === 0
        // lib 是纯函数（不碰 fs / 进程）：脚本与单测共用同一份判定
        && lib.indexOf("from 'node:") < 0 && lib.indexOf('process.exit') < 0
        && /process\.exit\(0\)/.test(check) && /process\.exit\(1\)/.test(check) && /process\.exit\(2\)/.test(check)
        && check.indexOf('--dry-run') >= 0 && check.indexOf('--from') >= 0 && check.indexOf('--write') >= 0
        && base.indexOf('--write') >= 0 && base.indexOf('--dry-run') >= 0 && /writeFileSync\(BASELINE_PATH/.test(base)
        && /耗时（ms）只记录、不参与判定/.test(check) && /耗时（ms）只记录、不参与判定/.test(base)
        && check.indexOf('compareToBaseline') >= 0 && check.indexOf('readings:{write,read,scan,size}') >= 0;
})(), '');

A('G8 **真实基线文件**正向：`scripts/perf-baseline.json` 可解析 · **UTF-8 无 BOM** · 形状 `{at,ver,readings{四类},note}` · 与当前读数比对通过', (() => {
    const buf = readFileSync(join(ROOT, 'scripts', 'perf-baseline.json'));
    const noBom = !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    let base = null, parsed = true;
    try { base = JSON.parse(buf.toString('utf8')); } catch (e) { parsed = false; }
    if (!parsed || !base) return false;
    const r = compareToBaseline(current, base.readings);
    // 注意：**不**断言 `base.ver === VERSION` —— 基线是产物文件，版本号变了要重跑
    //   `node scripts/perf-baseline.js --write` 刷新；这里只要求它像版本号（否则等于用版本号卡住门禁）。
    return noBom === true && /^\d+\.\d+\.\d+$/.test(String(base.ver)) && typeof base.note === 'string' && Number(base.at) > 0
        && !!base.readings.write && !!base.readings.read && !!base.readings.scan && !!base.readings.size
        && r.keys.length >= 20 && r.ok === true && r.regressions.length === 0;
})(), '');

A('G9 **规则不漂移**：`core/perf-probe.js#perfBaselineReport`（报告出口）与 lib 的 `compareToBaseline`（门禁）对同一对读数给出**同一组**回归 / 改善路径', (() => {
    const tight = cl(baseReadings);
    tight.scan.items.atoms -= 3;                                     // 当前相对基线更大 → 必有回归
    const out = withSynthetic(null, (st) => {
        setKernelState(st);                                          // 让 `perfBaselineReport()` 内部取到同一份 state
        setPerfHooks({ getBaseline: () => ({ at: 1, ver: VERSION, readings: tight }) });
        const core = perfBaselineReport();
        const lib = compareToBaseline(perfReadings(st), tight);
        setPerfHooks({ getBaseline: null });
        setKernelState(null);
        return { core: core, lib: lib };
    });
    // 同一口径（合成库两侧、无未采集）下：报告的回归 / 改善路径必须与门禁逐项一致
    return out.core.available === true
        && J(out.core.regressions.map((x) => x.key)) === J(out.lib.regressions.map((x) => x.path))
        && J(out.core.improvements.map((x) => x.key)) === J(out.lib.improvements.map((x) => x.path))
        && out.core.missing.length === 0
        && out.core.regressions.some((x) => x.key === 'scan.items.atoms' && x.delta === 3)
        && out.core.compare['scan.items.atoms'].kind === 'count'
        && out.core.compare['read.totalMs'].kind === 'timing';        // 耗时只标记、不判定
})(), '');

R.done();
