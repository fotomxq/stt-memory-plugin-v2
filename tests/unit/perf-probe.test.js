// ============================================================
// 单元测试 · v3.45.4 `docs/D31` §4 · **`技-39`** —— 性能与卡顿探针（四类读数 / 卡顿分级 / 优化清单 / 报告形状）
//   设计：`docs/D31` §3.4（CAP 汇总）· §3.7（追溯六字段）· §4.1（卡顿）· §4.2（7 条机械判据）· §4.4（三处同源）
//   实现：`core/perf-probe.js`（纯内核 · 零宿主依赖 · 时钟与外部读数全部注入）
//
// 本文件锁五件事（每条都是「契约会被后人改坏」的地方）：
//   ① **缺数据源不猜**：无宿主时 `perfReadings()` 不抛错，四类各自给出 `ok` 与 reason/note；
//   ② **同源**：`read` 类**直接复用** `core/read-ledger.js#readLedgerStats()`（不重算），逐值一致；
//   ③ **探针不得成为卡顿源**：< notice 不入环 · 同站点 800ms 去重 · 环形上限 200（压 250 → 剩 200 且淘汰最旧）；
//   ④ **形状冻结**：`perfTargets()` 每条 7 字段（`台账号` 允许 `'未立项'`）· `perfReport()` 六字段 + 三个子块 · 摘要 ≤120 字；
//   ⑤ **无基线不编造**：`perfBaselineReport()` → `available:false, reason:'no-baseline'`。
//
// 运行：node tests/unit/perf-probe.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { VERSION } from '../../core/constants.js';
import { readLedgerRecord, readLedgerStats, resetReadLedger } from '../../core/read-ledger.js';
import { setKernelState } from '../../core/model/runtime.js';
import {
    PERF_DEDUPE_MS, PERF_LEVELS, PERF_THRESHOLDS, PERF_WINDOW,
    perfBaselineReport, perfJankList, perfJankSummary, perfLevelOf, perfMark,
    perfReadings, perfReport, perfReportText, perfReset, perfTargets, perfTime, perfTimeAsync, setPerfHooks,
} from '../../core/perf-probe.js';

const R = makeReporter('perf-probe v3.45.4 性能与卡顿探针（D31 §4 / 技-39 / U191）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 清钩子（每个用例自己决定注入什么；缺省 = 无宿主） */
const clearHooks = () => setPerfHooks({
    now: null, listTrace: null, getBaseline: null, readLedger: null, writeStats: null, sizes: null, scanProbe: null,
});

/** 小状态（逐项手工核对用）：数组按长度、`deleted` 这类对象按**维度键数**计 */
function smallState() {
    return {
        atoms: [1, 2, 3], memories: [{}, {}], currentStates: [], snapshots: [{}], items: [], plans: [], suspense: [],
        concepts: [], scenes: [], npcs: [], parallels: [], rumors: [], plotSegments: [], links: [{}, {}],
        deleted: { atoms: { a: 1, b: 2 } }, deletedH: {}, snapStore: [{}, {}],
    };
}

A('P0 冻结接口齐备（常量逐值 + 15 个导出都是函数）', (() => {
    return PERF_WINDOW === 200 && PERF_DEDUPE_MS === 800
        && PERF_THRESHOLDS.notice === 50 && PERF_THRESHOLDS.stall === 200 && PERF_THRESHOLDS.freeze === 1000
        && J(PERF_LEVELS) === J(['notice', 'stall', 'freeze'])
        && [setPerfHooks, perfReset, perfLevelOf, perfMark, perfTime, perfTimeAsync, perfJankList, perfJankSummary,
            perfReadings, perfTargets, perfReport, perfBaselineReport, perfReportText].every((f) => typeof f === 'function');
})(), '');

// ---------------- A 组：四类读数（缺数据源不猜 / 与手工计数一致 / 与台账同源） ----------------
A('P1 无宿主时**不抛错**，四类读数各自给出 ok 与原因（write=no-write-stats · scan/size=no-state · 耗时给 null 不猜）', (() => {
    perfReset();
    clearHooks();
    setKernelState(null);                                  // 内核也没有 state → 扫描 / 体积确实无从测起
    let threw = false, rd = null;
    try { rd = perfReadings(); } catch (e) { threw = true; }
    return threw === false && !!rd
        && rd.write.ok === false && rd.write.reason === 'no-write-stats' && rd.write.note.length > 0
        && rd.write.bytes === null && rd.write.writes === null
        && rd.read.ok === true && typeof rd.read.note === 'string'             // 台账是纯内核函数，永远可用
        && rd.scan.ok === false && rd.scan.reason === 'no-state' && rd.scan.ms === null && rd.scan.msNote === '未采集'
        && rd.size.ok === false && rd.size.reason === 'no-state' && rd.size.mainBytes === null;
})(), '');

A('P2 有 state 时 scan / size 的条数与**手工计数**逐项一致（总条目数、对象按维度键数、耗时缺失给 null）', (() => {
    perfReset();
    clearHooks();
    const st = smallState();
    setKernelState(st);                                    // 走内核注入视图（不传参也能取到 state）
    const rd = perfReadings();
    const manualTotal = 3 + 2 + 0 + 1 + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 0 + 2 + 2;   // SCAN_DIMS 逐项相加
    return rd.scan.ok === true && rd.scan.total === manualTotal
        && rd.scan.items.atoms === 3 && rd.scan.items.memories === 2 && rd.scan.items.snapshots === 1
        && rd.scan.items.links === 2 && rd.scan.items.deleted === 2 && rd.scan.items.concepts === 0   // deleted = 墓碑叶子键数（2 条）
        && rd.scan.items.npcs === 0 && rd.scan.points.length === 0
        && rd.scan.ms === null && rd.scan.msNote === '未采集' && rd.scan.note.indexOf('未采集') >= 0
        && rd.size.ok === true && rd.size.mainBytes === JSON.stringify(st).length
        && rd.size.snapCount === 2 && rd.size.snapBytes === JSON.stringify(st.snapStore).length
        && rd.size.deletedKeys === 2 && rd.size.deletedDims === 1 && rd.size.deletedHKeys === 0
        && rd.size.tombstoneKeys === 2 && rd.size.linkRows === 2
        && rd.size.shardBytes === null && rd.size.copyBytes === null && rd.size.note.indexOf('未采集') >= 0;
})(), '');

A('P3 `read` 类与 `core/read-ledger.js#readLedgerStats()` **同源**（逐值一致，且源码里确实是调用它而不是自己求和）', (() => {
    perfReset();
    clearHooks();
    resetReadLedger();
    readLedgerRecord({ action: '读主文件', src: 'file', ok: true, bytes: 100, items: 3, ms: 7, at: 1700000000000, quiet: true });
    readLedgerRecord({ action: '读本机缓冲', src: 'local', miss: true, ms: 1, at: 1700000000001, quiet: true });
    readLedgerRecord({ action: '读本机内存库', src: 'idb', ok: false, reason: 'load-failed', ms: 5, at: 1700000000002, quiet: true });
    const src = readLedgerStats();
    const rd = perfReadings(smallState());
    const code = readFileSync(join(ROOT, 'core', 'perf-probe.js'), 'utf8');
    return rd.read.ok === true
        && rd.read.count === src.count && rd.read.totalReads === src.totalReads
        && rd.read.okReads === src.ok && rd.read.fail === src.fail && rd.read.miss === src.miss
        && rd.read.totalMs === src.totalMs && rd.read.totalBytes === src.totalBytes
        && J(rd.read.bySrc) === J(src.bySrc)
        && code.indexOf('readLedgerStats') >= 0 && code.indexOf("from './read-ledger.js'") >= 0;
})(), '');

// ---------------- B 组：卡顿分级与采样自限 ----------------
A('P4 `perfLevelOf` 三级边界：49/50/199/200/999/1000 逐点正确；NaN / 负数 / undefined 一律空串（不猜成 notice）', (() => {
    return perfLevelOf(49) === '' && perfLevelOf(50) === 'notice' && perfLevelOf(199) === 'notice'
        && perfLevelOf(200) === 'stall' && perfLevelOf(999) === 'stall' && perfLevelOf(1000) === 'freeze'
        && perfLevelOf(1001) === 'freeze' && perfLevelOf(NaN) === '' && perfLevelOf(-5) === '' && perfLevelOf(undefined) === '';
})(), '');

A('P5 `< notice` 的段**不入环**（探针不得成为卡顿源）：49ms / 10ms / 0ms / NaN 全部丢弃，摘要保持全零', (() => {
    perfReset();
    clearHooks();
    let t = 1000;
    setPerfHooks({ now: () => (t += 10) });
    perfMark('seg-a', 49); perfMark('seg-a', 10); perfMark('seg-b', 0); perfMark('seg-c', NaN);
    const s = perfJankSummary();
    return perfJankList({}).length === 0 && s.count === 0 && s.deduped === 0 && s.jankRate === 0 && s.worstMs === 0;
})(), '');

A('P6 同站点 **800ms 去重**：窗口内重复丢弃并计入 deduped；恰好 800ms（不含）之后再记可入环', (() => {
    perfReset();
    clearHooks();
    perfMark('siteA', 60, { at: 1000 });
    const first = perfJankList({}).length;
    perfMark('siteA', 60, { at: 1500 });                       // 500ms 内 → 去重
    perfMark('siteA', 60, { at: 1800 });                       // 距上次入环恰好 800 → 不算「小于 800」→ 入环
    perfMark('siteA', 60, { at: 2000 });                       // 距上次入环 200 → 去重
    perfMark('siteB', 60, { at: 2000 });                       // 不同站点 → 入环
    const s = perfJankSummary();
    return first === 1 && perfJankList({}).length === 3 && s.count === 3 && s.deduped === 2;
})(), '');

A('P7 环形**上限 200**：压 250 条不同站点 → 只剩 200，且**淘汰最旧**（最新在前）', (() => {
    perfReset();
    clearHooks();
    for (let i = 0; i < 250; i++) perfMark('s' + i, 60, { at: 1000000 + i });
    const l = perfJankList({});
    const s = perfJankSummary();
    return l.length === PERF_WINDOW && s.count === 200
        && l[0].site === 's249' && l[199].site === 's50'
        && l.filter((x) => x.site === 's49').length === 0
        && l.filter((x) => x.site === 's0').length === 0;
})(), '');

A('P8 摘要口径：window / count / byLevel / jankRate=超阈条数÷窗口容量 / worstMs+worstSite / lastAt；明细倒序且 level/limit 过滤生效', (() => {
    perfReset();
    clearHooks();
    perfMark('w1', 100, { at: 1000 });
    perfMark('w2', 250, { at: 1001, cause: '保存' });
    perfMark('w3', 1500, { at: 1002, u: 'U191' });
    const s = perfJankSummary();
    const list = perfJankList({});
    const rec = list[0];
    return s.window === PERF_WINDOW && s.count === 3
        && s.byLevel.notice === 1 && s.byLevel.stall === 1 && s.byLevel.freeze === 1
        && s.jankRate === Math.round((3 / PERF_WINDOW) * 10000) / 10000
        && s.worstMs === 1500 && s.worstSite === 'w3' && s.lastAt === 1002
        && list.length === 3 && rec.site === 'w3' && rec.level === 'freeze' && rec.u === 'U191'
        && perfJankList({ level: 'notice' }).length === 1 && perfJankList({ limit: 2 }).length === 2
        && J(Object.keys(rec).sort()) === J(['at', 'cause', 'level', 'ms', 'n', 'site', 'u'].sort());
})(), '');

// ---------------- C 组：清单与形状（7 字段 / 六字段 / 无基线） ----------------
A('P9 `perfTargets()` 每条 7 字段齐全（含英文别名）；构造 stall 段 → T1 命中；同站点 3 次超阈 → T6 命中且台账号写 `未立项`', (() => {
    perfReset();
    clearHooks();
    const st = smallState();
    perfMark('hot:site', 250, { at: 1000 });
    perfMark('hot:site', 250, { at: 2000 });
    perfMark('hot:site', 250, { at: 3000 });
    const hits = perfTargets(st);
    const all = perfTargets(st, { all: true });
    const FIELDS = ['id', '现象', '判据', '证据', '归因', '建议', '台账号'];
    const ALIASES = ['title', 'judge', 'evidence', 'attribution', 'suggest', 'u', 'hit'];
    const okFields = (x) => FIELDS.every((k) => typeof x[k] === 'string' && x[k].length > 0);
    const okAlias = (x) => ALIASES.every((k) => x[k] !== undefined);
    const t1 = all.filter((x) => x.id === 'T1')[0];
    const t6 = all.filter((x) => x.id === 'T6')[0];
    return all.length === 7 && all.every(okFields) && all.every(okAlias)
        && hits.length >= 2 && hits.every((x) => x.命中 === true)
        && hits.some((x) => x.id === 'T1') && hits.some((x) => x.id === 'T6')
        && t1.命中 === true && t1.证据.indexOf('hot:site') >= 0 && t1.证据.indexOf('window=200') >= 0
        && t1.evidence === t1.证据 && t1.u === t1.台账号 && t1.hit === true
        && t6.命中 === true && t6.台账号 === '未立项' && t6.u === '未立项'
        // 兼容形状：主返回是数组；`.list` / `.count` 可用且**不可枚举**（过桥 JSON 仍是干净数组）
        && hits.list === hits && hits.count === hits.length && J(Object.keys(hits).indexOf('list') >= 0) === 'false'
        && J(JSON.parse(JSON.stringify(all))[0].list) === 'null'
        && all.filter((x) => x.命中 === false).every((x) => x.建议.length > 0);
})(), '');

A('P10 `perfReport()` 形状冻结：六字段（at/ver/window/cause/site/u）+ readings 四类 + jank + targets{count,list≤10} + text（≤120 字且含 U191）', (() => {
    perfReset();
    clearHooks();
    const rep = perfReport(smallState());
    const SIX = ['at', 'ver', 'window', 'cause', 'site', 'u'];
    return SIX.every((k) => rep[k] !== undefined)
        && typeof rep.at === 'number' && rep.ver === VERSION && rep.window === PERF_WINDOW
        && rep.cause === 'perf' && rep.site === 'perf-probe' && rep.u === 'U191'
        && !!rep.readings && !!rep.readings.write && !!rep.readings.read && !!rep.readings.scan && !!rep.readings.size
        && SIX.every((k) => rep.readings[k] !== undefined)                    // 四类读数同样带六字段
        && !!rep.jank && typeof rep.jank.count === 'number' && rep.jank.window === PERF_WINDOW
        && !!rep.targets && typeof rep.targets.count === 'number' && Array.isArray(rep.targets.list) && rep.targets.list.length <= 10
        && typeof rep.text === 'string' && rep.text.length > 0 && rep.text.length <= 120 && rep.text.indexOf('U191') >= 0
        && perfReportText(smallState()).length <= 120;
})(), '');

A('P11 `perfBaselineReport()`：无基线 → `available:false, reason:"no-baseline"`（不编造差异）；注入相等基线 → 全 same；当前更小 → 记进 improvements', (() => {
    perfReset();
    clearHooks();
    const none = perfBaselineReport();
    const okNone = none.available === false && none.reason === 'no-baseline'
        && none.regressions.length === 0 && none.improvements.length === 0 && none.missing.length === 0 && J(none.compare) === J({})
        && none.ver === VERSION && none.window === PERF_WINDOW && none.cause === 'perf' && none.site === 'perf-probe' && none.u === 'U191';
    const cur = perfReadings(smallState());
    const bag = () => ({ write: cur.write, read: cur.read, scan: cur.scan, size: cur.size });
    setPerfHooks({ getBaseline: () => ({ at: 123, ver: VERSION, readings: bag() }) });
    const same = perfBaselineReport();
    const lower = JSON.parse(JSON.stringify(bag()));
    lower.scan.total = lower.scan.total - 1;                                  // 基线更小 → 当前更大 = 劣化
    setPerfHooks({ getBaseline: () => ({ at: 123, ver: VERSION, readings: lower }) });
    const worse = perfBaselineReport();
    clearHooks();
    return okNone && same.available === true && same.regressions.length === 0 && same.improvements.length === 0 && same.missing.length === 0
        && same.compare['scan.total'] && same.compare['scan.total'].verdict === 'same'
        && worse.regressions.some((x) => x.key === 'scan.total' && x.baseline === lower.scan.total && x.delta === 1)
        && worse.compare['scan.total'].verdict === 'worse'
        && worse.compare['size.mainBytes'].verdict === 'same';
})(), '');

A('P12 实时读数 vs 合成基线：**未采集**（键在、值是 null）单列 `missing`（verdict=`unavailable`）且**不计入回归**；真的更小则记 improvements', (() => {
    perfReset();
    clearHooks();
    // 基线一侧：写侧读数齐全（模拟合成库 / 接线完整的宿主）
    setPerfHooks({
        writeStats: () => ({
            done: 40, queued: 41, failed: 1, pending: 0, inFlight: 0, maxInFlight: 1, bytes: 265814, waitMs: null,
            last: { id: 40, label: 'kv-put:x', ms: 12, at: 1700000000000, ok: true },
        }),
    });
    const cur = perfReadings(smallState());
    const bag = { write: cur.write, read: cur.read, scan: cur.scan, size: cur.size };
    // 当前一侧：宿主桩只给「写次数」→ 其余写侧读数为 null（真机上就是「钩子没接全」的形态）
    setPerfHooks({
        writeStats: () => ({ done: 5, last: null }),
        getBaseline: () => ({ at: 7, ver: VERSION, readings: bag }),
    });
    const rep = perfBaselineReport();
    const bytes = rep.compare['write.bytes'] || {};
    const queued = rep.compare['write.queued'] || {};
    clearHooks();
    return rep.available === true
        && bytes.verdict === 'unavailable' && bytes.current === null && bytes.baseline === bag.write.bytes
        && queued.verdict === 'unavailable'
        && rep.missing.some((x) => x.key === 'write.bytes' && x.verdict === 'unavailable')
        && rep.missing.some((x) => x.key === 'write.queued')
        && !rep.regressions.some((x) => x.key === 'write.bytes') && rep.regressions.length === 0
        && rep.improvements.some((x) => x.key === 'write.writes' && x.current === 5 && x.baseline === 40)
        && rep.missing.length >= 5;
})(), '');

// ---------------- D 组：包装函数（返回值 + 入环行为） ----------------
A('P13 `perfTime`：**返回 fn 的返回值**；快函数（10ms）不入环、慢函数（300ms）入环（level=stall）；fn 抛错仍标记且异常照抛', (() => {
    perfReset();
    clearHooks();
    let t = 5000;
    setPerfHooks({ now: () => (t += 10) });                                   // 每次取时钟 +10ms
    const fast = perfTime('fast:seg', () => 42);
    const fastNoRing = perfJankList({}).length === 0;
    t = 5000;
    setPerfHooks({ now: () => (t += 300) });                                  // 取两次时钟 → 相差 300ms
    const slow = perfTime('slow:seg', () => 'x');
    const list = perfJankList({});
    let threw = false;
    try { perfTime('boom:seg', () => { throw new Error('boom'); }); } catch (e) { threw = true; }
    const boomMarked = perfJankList({}).some((x) => x.site === 'boom:seg');
    clearHooks();
    return fast === 42 && fastNoRing === true && slow === 'x'
        && list.length === 1 && list[0].site === 'slow:seg' && list[0].ms === 300
        && list[0].level === 'stall' && list[0].cause === 'perfTime'
        && threw === true && boomMarked === true;
})(), '');

// 异步断言（顶层 await：ESM 允许，且必须在 R.done() 之前完成）
await (async () => {
    perfReset();
    clearHooks();
    let t = 9000;
    setPerfHooks({ now: () => (t += 5) });                                    // await 前后各 +5 → 10ms → 不入环
    const fast = await perfTimeAsync('afast:seg', async () => 'ok');
    const fastNoRing = perfJankList({}).length === 0;
    t = 9000;
    setPerfHooks({ now: () => (t += 1000) });                                 // 取两次时钟 → 相差 1000ms = freeze
    const slow = await perfTimeAsync('aslow:seg', async () => 'done');
    const list = perfJankList({});
    let threw = false;
    try { await perfTimeAsync('aboom:seg', async () => { throw new Error('boom'); }); } catch (e) { threw = true; }
    const boomMarked = perfJankList({}).some((x) => x.site === 'aboom:seg');
    clearHooks();
    A('P14 `perfTimeAsync`：await 后照常**返回 fn 的返回值**；10ms 不入环、1000ms 入环（level=freeze）；抛错仍标记且异常照抛',
        fast === 'ok' && fastNoRing === true && slow === 'done'
        && list.length === 1 && list[0].site === 'aslow:seg' && list[0].ms === 1000
        && list[0].level === 'freeze' && list[0].cause === 'perfTimeAsync'
        && threw === true && boomMarked === true, '');
})();

R.done();
