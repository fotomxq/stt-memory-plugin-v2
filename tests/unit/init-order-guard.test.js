// ============================================================
// 单元测试 · v3.24.1「刷新后初始化阶段抛出两个错误」根因修复
//
// 用户报告（原话）：「刷新后初始化阶段，插件会抛出两个错误，均可能是初始化顺序异常导致的数据错乱，引发报错。」
// 用户提供的错误原文（其中一条）：「已处理楼层漂移防呆失败 Cannot read properties of null (reading 'processedFloors')」（另一条同类）。
//
// 根因（**初始化顺序**，确定性、可复现）：
//   `state` 是内核的注入视图（`core/model/runtime.js` 的 `export let state = null`），只在「载入 → 注入」
//   之后才有值；而 `index.js#init()` 的时序是
//     `installHostBridges()` → **`panelStatusSnapshot()`（545 / 562 两处）** → `loadMemoryState()`（内部才 `setKernelState`）
//   于是**状态注入之前**就会取一次面板状态快照 → `pendingFloors()` → `listUnprocessedFloors()` →
//   `scanPendingFloors()` 的**台账维护块** → `processedDriftGuard()` / `reconcileProcessedFloors()`
//   读 `state.processedFloors` → `state` 为 null → TypeError → 各函数 `catch` 里 `warn(...)`
//   → 用户看到两条「…失败 Cannot read properties of null」的异常提示。
//   而此刻 `chatHooks.dbgLog` 还没接线 → 调试日志里**一条都查不到**（这就是「只看到弹窗、日志全空」的原因）。
//
// 本批两条修复：
//   ① **顺序守卫**（`host/floors.js#kernelStateReady`）：状态未注入 → 台账维护/记账/清空**一律短路**
//      （既不抛错、也绝不在空状态上写数据 —— 数据错乱的风险正在于此：早期 `hashFloorText()` 可能全空，
//       台账一旦按空哈希刷新就会被清空）；调用方 `panelStatusSnapshot()` 也不再在未注入时问 pending；
//   ② **取证通道**（`core/model/runtime.js` 告警暂存）：`warn()` 先落有界暂存，`setChatHooks()` 首次接线时
//      一次性补记进调试日志 —— 初始化期的告警再也不会只活在弹窗里。
//
// 覆盖：A 状态未注入 → 六个入口全部短路且**零告警**；B 注入后照常工作（不倒退）；
//       C 接线前告警暂存与补记（含幂等与上限）；D 调用方顺序（`extraForStatus().extractPending` 未注入时为 null）。
// 运行：node tests/unit/init-order-guard.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setNotifyHooks, warn, warnBacklogList, clearWarnBacklog, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import {
    kernelStateReady, scanPendingFloors, processedDriftGuard, reconcileProcessedFloors,
    migrateProcessedFloorsV170, handleFloorShrink, recordProcessedFloors, clearProcessedFloors,
    processedStats, isFloorProcessed, listUnprocessedFloors,
} from '../../host/floors.js';
import { extraForStatus } from '../../index.js';

const R = makeReporter('init-order-guard v3.24.1 刷新后初始化两错根因修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// 12 楼聊天（第 0 楼用户、1-11 楼 AI，正文可分析）
const chat = [{ is_user: true, mes: '开场。', name: 'User' }];
for (let i = 1; i <= 11; i++) chat.push({ is_user: false, mes: '第' + i + '楼正文：甲在码头清点货物并记录去向。', name: '角色甲' });
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat }), doc);

/** 本文件的告警/异常记录器（真机那两条弹窗就是经 `notifyHooks.toast(..., 'error')` 出来的） */
let toasts = [];
function boot(stateLike) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:init-guard');
    setLastMessageId(chat.length - 1);
    setKernelState(stateLike === undefined ? emptyState() : stateLike);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => { toasts.push([String(kind || ''), String(text || '')]); } });
    clearWarnBacklog();
    return state;
}

// ---------- A 组：状态未注入 → 六个入口一律短路，且**零告警** ----------
{
    boot(null);                                  // ← 真机刷新后 init 早期的真实状态：state 尚未注入
    const scan = scanPendingFloors({});
    const dg = processedDriftGuard(false, true);
    const rc = reconcileProcessedFloors(false);
    const mg = migrateProcessedFloorsV170();
    const shr = handleFloorShrink();
    const rec = recordProcessedFloors(1, 1);
    const clr = clearProcessedFloors();

    A('A1 真机路径复现：`state === null` 时 `scanPendingFloors({})`（`panelStatusSnapshot()` → `pendingFloors()` 走的就是它）**不再抛错**，且如实标记 `skipped.stateNotReady`（修复前：台账维护块读 `state.processedFloors` → TypeError）', (() => {
        return kernelStateReady() === false && state === null
            && scan.skipped.stateNotReady === 1
            // 台账在空状态下读不出任何标记 → 全部 11 个 AI 楼如实列为待分析（**只读**，不写任何数据）
            && J(scan.floors) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
            && scan.droppedMarks === 0;
    })(), () => J({ stateReady: kernelStateReady(), skipped: scan.skipped, floors: scan.floors.length }));

    A('A2 六个入口逐条短路且**回报原因**（不是静默吞掉）：漂移防呆 / 归位对账 / 台账迁移 / 拆楼收缩 / 记账 / 清空', (() => {
        return dg.skipped === 'state-not-ready' && rc.skipped === 'state-not-ready'
            && mg.skipped === 'state-not-ready' && shr.skipped === 'state-not-ready'
            && rec.ok === false && rec.reason === 'state-not-ready'
            && clr.ok === false && clr.reason === 'state-not-ready';
    })(), () => J({ dg: dg.skipped, rc: rc.skipped, mg: mg.skipped, shr: shr.skipped, rec: rec.reason, clr: clr.reason }));

    A('A3 **零告警**：整轮初始化路径跑完，`notifyHooks.toast` 一次都没被调用 —— 真机那两条「…失败 Cannot read properties of null」的弹窗不再出现', (() => {
        return toasts.length === 0 && warnBacklogList().length === 0;
    })(), () => J(toasts));

    A('A4 只读诊断在空状态下也安全：`processedStats()` / `isFloorProcessed()` / `listUnprocessedFloors()` 给中性结果，不抛不写（台账仍为 null、无告警）', (() => {
        const st = processedStats();
        const ip = isFloorProcessed(3);
        const ls = listUnprocessedFloors({});
        return st.marks === 0 && st.lastKnownFloor === -1 && ip === false
            && J(ls) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
            && state === null && toasts.length === 0;
    })(), () => J({ stats: processedStats(), ip: isFloorProcessed(3), n: listUnprocessedFloors({}).length }));
}

// ---------- B 组：状态注入之后照常工作（不倒退、也不丢数据） ----------
{
    const st = boot(undefined);                  // 注入空容器（= 载入完成后的真实状态）
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    const scan = scanPendingFloors({});
    const rec = recordProcessedFloors(1, 3);
    const scan2 = scanPendingFloors({});
    const dg = processedDriftGuard(false, true);

    A('B1 注入后同一批调用**正常执行**：扫描给出真实待分析清单、记账写入台账、漂移防呆给出真实判定（`skipped` 不再是 state-not-ready）', (() => {
        return kernelStateReady() === true
            && scan.skipped.stateNotReady === 0 && J(scan.floors) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
            && rec.ok === true && rec.count === 3
            && J((state.processedFloors || []).map((x) => x.f)) === J([1, 2, 3])
            && scan2.floors.indexOf(1) < 0 && scan2.floors.indexOf(2) < 0 && scan2.floors.indexOf(3) < 0
            && dg.skipped !== 'state-not-ready';
    })(), () => J({ floors: scan.floors, rec: rec, marks: (state.processedFloors || []).map((x) => x.f), dg: dg.skipped }));

    A('B2 修复**不动数据语义**：注入后台账仍是 `{f,h}` 形状、版本签名与末楼基线照旧写入', (() => {
        const m = (state.processedFloors || [])[0] || {};
        return typeof m.f === 'number' && typeof m.h === 'string' && m.h.length > 0
            && String(state.processedVer || '').indexOf(':') > 0
            && Number(state.lastKnownFloor) === 3;
    })(), () => J({ mark: (state.processedFloors || [])[0], ver: state.processedVer, last: state.lastKnownFloor }));
}

// ---------- C 组：接线前的告警不再丢失（取证通道） ----------
A('C1 `warn()` 在调试日志接线**之前**发生 → 落进告警暂存；`setChatHooks()` 首次接线时**一次性补记**进调试日志（`kind=异常`，动作注明「初始化期告警…补记」），并清空暂存', (() => {
    clearWarnBacklog();
    warn('已处理楼层漂移防呆失败', new Error("Cannot read properties of null (reading 'processedFloors')"));
    const buffered = warnBacklogList();
    const got = [];
    setChatHooks({ dbgLog: (kind, data) => got.push([String(kind), String((data && data.action) || ''), String((data && data.message) || '')]) });
    const after = warnBacklogList();
    return buffered.length === 1
        && buffered[0].msg.indexOf('processedFloors') > 0
        && got.length === 1 && got[0][0] === '异常' && got[0][1].indexOf('初始化期告警') >= 0
        && got[0][2].indexOf('processedFloors') > 0
        && after.length === 0;
})(), () => J({ buffered: warnBacklogList(), after: warnBacklogList().length }));

A('C2 补记**幂等**（事件刷新会反复调 `setChatHooks`，没有暂存时不重复写）；暂存有上限（25 条 → 只留最近 20 条）', (() => {
    clearWarnBacklog();
    for (let i = 0; i < 25; i++) warn('告警' + i);
    const capped = warnBacklogList();
    const got = [];
    setChatHooks({ dbgLog: (kind, data) => got.push(String((data && data.message) || '')) });
    const second = [];
    setChatHooks({ dbgLog: (kind, data) => second.push(String((data && data.message) || '')) });
    return capped.length === 20 && capped[0].msg === '告警5' && capped[19].msg === '告警24'
        && got.length === 20 && got[0] === '告警5' && got[19] === '告警24'
        && second.length === 0 && warnBacklogList().length === 0;
})(), () => J({ cappedLen: warnBacklogList().length, after: warnBacklogList().map((x) => x.msg).slice(0, 3) }));

// ---------- D 组：调用方顺序（index.js） ----------
A('D1 `extraForStatus().extractPending`：内核状态未注入时为 `null`（**不再**在空状态上问待分析楼层），注入后为数字', (() => {
    boot(null);
    const before = extraForStatus().extractPending;
    boot(undefined);
    const after = extraForStatus().extractPending;
    return before === null && typeof after === 'number' && after === 11;
})(), () => J({ before: extraForStatus().extractPending }));

R.done();
