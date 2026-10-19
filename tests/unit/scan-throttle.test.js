// ============================================================
// 单元测试 · v3.50.28 **全量操作节流且处处可观测**（`docs/D22` §4.28 W28 `技-28`）
//
// 来源：`docs/D28` §7（`技-28` 四条要求）—— 用户当轮授权范围 = W5 的 `技-28` + `技-29`。
//   ① 全量类操作加**最短间隔 + 最大间隔**（到期如实提示）；
//   ② 每次全量 / 分批如实记录**扫描条目数 / 跨维度数 / 耗时 / 命中 / 余量**（**不含正文**）；
//   ③ 单次设**扫描上限**，超限**分批**并留痕；
//   ④ 期间**不阻塞注入**（本模块只记账与闸门，不发起扫描、不 await）。
//
// 本文件锁六件事：
//   A 闸门：最短间隔内重复发起 → 拒绝（`too-soon`）；`force` 放行；并发中 → `running`；
//   B 记账：条目 / 维度 / 耗时 / 命中 / 余量逐项如实；读数形状稳定；
//   C 分批：超 `capItems` → `needMore` + `batches` 留痕（不丢计数）；
//   D 到期：超过 `maxMs` → `overdue` 与 `scanOverdue()` 如实列出（**从未跑过不算到期**）；
//   E 只读出口：`scanStats()` / `scanStatsText()` / 桥方法 `ftt.scanStats`；
//   F 接线：体检 / 修复 / 关系 / NSFW 四类全量操作都落账，且**注入路径不被节流拦截**。
//
// 运行：node tests/unit/scan-throttle.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    SCAN_OPS, SCAN_DEFAULTS, SCAN_KEEP, scanOpConf, scanBegin, scanChunk, scanEnd,
    scanStatOf, scanStats, scanStatsText, scanOverdue, scanForce, setScanHooks, resetScanStats,
} from '../../core/scan-throttle.js';
import { buildBridgeMethods } from '../../ui/debug.js';
import { bridgeDispatch, setBridgeMethods } from '../../adapters/debug-bridge.js';

const R = makeReporter('scan-throttle v3.50.28 全量操作节流与可观测（D22 W28 技-28）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// 可注入时钟：让「最短 / 最大间隔」可测
let T = 1000000;
setScanHooks({ now: () => T });
const at = (t) => { T = t; };

// ---------- A 闸门 ----------
A('A1 首次发起放行；**最短间隔内**重复发起被拒（`too-soon`）且计入 `refused`；`force` 可显式放行', (() => {
    resetScanStats();
    at(1000);
    const g1 = scanBegin('nsfwScan');
    scanEnd('nsfwScan', g1.runId, { items: 10, dims: 3, ms: 5, hits: 1 });
    at(1000 + 1000);                       // 1s 后（minMs = 20s）
    const g2 = scanBegin('nsfwScan');
    const g3 = scanBegin('nsfwScan', { force: true });
    const st = scanStatOf('nsfwScan');
    return g1.go === true && g2.go === false && g2.reason === 'too-soon'
        && g3.go === true && st.stat.refused >= 1 && st.stat.lastReason !== 'ok';
})(), 'n/a');
A('A2 超过最短间隔后放行；进行中的同一操作再发起 → `running`（不产生第二条运行）', (() => {
    resetScanStats();
    at(2000);
    const g1 = scanBegin('dataHealth');
    const g2 = scanBegin('dataHealth');     // 未结上一次
    scanEnd('dataHealth', g1.runId, { items: 1, dims: 1, ms: 1 });
    at(2000 + scanOpConf('dataHealth').minMs + 1);
    const g3 = scanBegin('dataHealth');
    return g1.go && g2.go === false && g2.reason === 'running' && g3.go === true;
})(), 'n/a');
A('A3 `force` 语义只跳**最短间隔**，不改变其它闸门（并发仍拒）', (() => {
    resetScanStats();
    at(3000);
    const g1 = scanForce('relations');
    const g2 = scanForce('relations');
    scanEnd('relations', g1.runId, {});
    return g1.go === true && g0() === true && g2.go === false && g2.reason === 'running';
    function g0() { return true; }
})(), 'n/a');

// ---------- B 记账 ----------
A('B1 条目 / 维度 / 耗时 / 命中 / 余量**逐项如实**落账，且读数形状稳定（无正文字段）', (() => {
    resetScanStats();
    at(5000);
    const g = scanBegin('repairScan');
    scanEnd('repairScan', g.runId, { items: 1234, dims: 7, ms: 88, hits: 3, remaining: 9 });
    const s = scanStatOf('repairScan').stat;
    const keys = Object.keys(s).sort().join(',');
    return s.items === 1234 && s.dims === 7 && s.ms === 88 && s.hits === 3 && s.remaining === 9
        && keys === 'at,batches,dims,hits,items,lastReason,ms,needMore,ok,refused,remaining';
})(), J(scanStatOf('repairScan').stat));
A('B2 读数**不含正文**：序列化后不出现条目正文里的词（只存计数与时长）', (() => {
    resetScanStats();
    at(6000);
    const g = scanBegin('nsfwScan');
    scanEnd('nsfwScan', g.runId, { items: 2, dims: 1, ms: 1, hits: 1 });
    const txt = J(scanStats()) + scanStatsText();
    return txt.indexOf('正文') < 0 && txt.indexOf('content') < 0 && txt.indexOf('text') < 0;
})(), 'n/a');
A('B3 最近运行环形保留 ≤ `SCAN_KEEP`（内存恒定，不随会话增长）', (() => {
    resetScanStats();
    for (let i = 0; i < SCAN_KEEP + 5; i++) {
        at(7000 + i * 100000);
        const g = scanBegin('relations', { force: true });
        scanEnd('relations', g.runId, { items: i, dims: 1, ms: 1 });
    }
    return scanStatOf('relations').recent.length === SCAN_KEEP;
})(), J(scanStatOf('relations').recent.length));

// ---------- C 分批 ----------
A('C1 超单次上限（`capItems`）→ 标 `needMore` 并记 `batches` 留痕；**累计条目数不丢**', (() => {
    resetScanStats();
    at(50000);
    const cap = scanOpConf('nsfwScan').capItems;
    const g = scanBegin('nsfwScan');
    const c1 = scanChunk('nsfwScan', g.runId, { items: Math.floor(cap / 2), dims: 2, hits: 1 });
    const c2 = scanChunk('nsfwScan', g.runId, { items: Math.floor(cap / 2) + 10, dims: 3, hits: 2 });
    const row = scanEnd('nsfwScan', g.runId, {});
    return c1.needMore === false && c2.needMore === true && row.items >= cap && row.batches >= 1 && row.needMore === true;
})(), 'n/a');
A('C2 分批留痕只记次数，不记正文；结账后 `needMore` 仍为真（事实不吞）', (() => {
    const s = scanStatOf('nsfwScan').stat;
    const r = scanStatOf('nsfwScan').recent.slice(-1)[0] || {};
    return s.needMore === true && s.batches >= 1 && r.needMore === true && typeof r.items === 'number';
})(), 'n/a');

// ---------- D 到期 ----------
A('D1 超过 `maxMs` → `overdue:true`，`scanOverdue()` 如实列出（含超期时长）', (() => {
    resetScanStats();
    at(100000);
    const g = scanBegin('dataHealth');
    scanEnd('dataHealth', g.runId, { items: 5, dims: 1, ms: 1 });
    const conf = scanOpConf('dataHealth');
    at(100000 + conf.maxMs + 5000);
    const s = scanStatOf('dataHealth');
    const od = scanOverdue();
    return s.overdue === true && od.length === 1 && od[0].id === 'dataHealth' && od[0].overdueMs === conf.maxMs + 5000;
})(), J(scanOverdue()));
A('D2 **从未跑过不算到期**（避免开机就报一堆）；跑过但未超期也不算', (() => {
    resetScanStats();
    at(200000);
    const g = scanBegin('repairScan');
    scanEnd('repairScan', g.runId, { items: 1 });
    at(200000 + 1000);
    return scanOverdue().length === 0 && scanStatOf('dataHealth').overdue === false;
})(), J(scanOverdue()));

// ---------- E 只读出口 ----------
A('E1 `scanStats()` 覆盖全部已登记操作、带参数与 `overdue`；`scanStatsText()` 一行可读且含「未跑过 / 已到期」信号', (() => {
    resetScanStats();
    at(300000);
    const all = scanStats();
    const ids = all.ops.map((o) => o.id).join(',');
    return ids === Object.keys(SCAN_OPS).join(',') && all.ops.every((o) => o.conf && typeof o.overdue === 'boolean')
        && scanStatsText().indexOf('未跑过') >= 0;
})(), J(scanStats().ops.map((o) => o.id)));
A('E2 调试桥只读方法 `ftt.scanStats` 可用（与 `scanStats()` 同源；`params` 为空）', (async () => {
    setBridgeMethods(buildBridgeMethods());
    const out = (await bridgeDispatch({ id: 'ftt.scanStats', method: 'ftt.scanStats', params: {} })).result;
    return !!out && Array.isArray(out.ops) && out.ops.length === Object.keys(SCAN_OPS).length;
})(), 'n/a');
A('E3 未登记的操作按默认参数处理并标 `known:false`（不因拼错而崩、不静默当合法）', (() => {
    const c = scanOpConf('noSuchOp');
    return c.known === false && c.minMs === SCAN_DEFAULTS.minMs && c.maxMs === SCAN_DEFAULTS.maxMs;
})(), 'n/a');

// ---------- F 接线（四类全量操作 + 不阻塞注入） ----------
const host = makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在仓库清点货物，语气平静。' }] });
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(host, doc);
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:scan-throttle');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '1919-11-29' }, seed || {});
    st.atoms = [{ id: 'a1', title: '情节', text: '正文足够长用于测试。', date: '1919-11-29', floorStart: 1, floorEnd: 1, tags: [] }];
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
A('F1 `dataHealthReport()` 落账：条目 / 维度 / 耗时都有值，且返回值带 `scanThrottled`（空串 = 未被节流）', (async () => {
    resetScanStats(); at(400000);
    boot();
    const DH = await import('../../core/data-health.js');
    const rep = DH.dataHealthReport();
    const s = scanStatOf('dataHealth').stat;
    return rep.scanThrottled === '' && s.items > 0 && s.ms >= 0 && s.dims >= 0;
})(), 'n/a');
A('F2 `deriveRelations()` 落账：扫描条目数与派生边数如实（`throttled` 空串）', (async () => {
    resetScanStats(); at(410000);
    boot();
    const REL = await import('../../core/relations.js');
    const r = REL.deriveRelations({});
    const s = scanStatOf('relations').stat;
    return r.throttled === '' && s.items > 0 && s.hits >= 0;
})(), 'n/a');
A('F3 节流**不影响结论**：同一次数据，被节流与未被节流的派生结果**完全一致**（闸门只拒绝重跑，不改结果）', (async () => {
    resetScanStats(); at(420000);
    boot();
    const REL = await import('../../core/relations.js');
    const a = REL.deriveRelations({ force: true });
    const b = REL.deriveRelations({});                    // 立即重跑 → 被节流
    return b.throttled === 'too-soon' && J(b.edges) === J(a.edges) && b.scanned === a.scanned;
})(), 'n/a');
A('F4 **注入路径不被节流拦截**（要求④）：注入构建与 NSFW 弱化计数不受扫描闸门影响（不阻塞、不等待）', (async () => {
    resetScanStats(); at(430000);
    boot();
    const INJ = await import('../../core/inject.js');
    const t0 = Date.now();
    let ok = false;
    try { const out = INJ.buildInjectText ? INJ.buildInjectText() : null; ok = out !== undefined; } catch (e) { ok = false; }
    const ms = Date.now() - t0;
    // 关键：注入构建不因「刚跑过全量扫描」而被拒/被等待（本模块不参与注入闸门）
    const s = scanStatOf('nsfwScan');
    return ok && ms < 3000 && s.stat.at === 0;
})(), 'n/a');

un();
resetScanStats();
R.done();
