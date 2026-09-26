// ============================================================
// 单元测试 · v2.46.0「启动自动检查更新：内置延迟几秒后执行」（用户要求）
// 背景（用户原话）：「启动时自动检查更新，内置延迟几秒后执行，避免插件异常。」
// 口径：自动路径**排期** `UPDATE_STARTUP_DELAY_MS`（默认 4s）后才发起检查，避开酒馆启动高峰与插件自身的
//   启动对账；**手动检查（用户点击）不延迟**；延迟经内核 `timerHooks` 调度（可替换、可撤销）；
//   `teardown()` 会撤销未执行的排期。
// 覆盖：
//   P 组：`startupDelayPlan` 纯函数（默认 4s / 手动 0 / 显式值夹取 / 非法值回落）；
//   S 组：**排期语义** —— 调用后立刻返回「已排期」状态、**未发起任何远端请求**；定时器到点才真正检查并落盘；
//   M 组：手动检查与 `delayMs: 0` 都不延迟；
//   C 组：**取代与撤销** —— 连续两次排期只保留最新一次（前一次返回 superseded）；`cancelStartupUpdateDelay`
//         与 `teardown()` 之后到点也不执行（不写状态、不发请求）；
//   F 组：定时器钩子不可用时**不延迟**（宁可检查，也不要永不检查）。
// 运行：node tests/unit/update-delay.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setTimerHooks } from '../../core/model/runtime.js';
import { UPDATE_STARTUP_DELAY_MS, UPDATE_STARTUP_DELAY_MAX_MS, startupDelayPlan } from '../../core/update.js';
import { readUpdateState, writeUpdateState, ensureFirstRun } from '../../adapters/update-state.js';
import { VERSION, MODULE_NAME, DEFAULT_UPDATE_REPO } from '../../core/constants.js';

const R = makeReporter('update-delay v2.46.0 启动自动检查内置延迟');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
host.ctx.extensionSettings[MODULE_NAME] = {};
const un = installGlobalHost(host, doc);
const entry = await import('../../index.js');

/** 虚拟定时器：记录排期、不自动触发（由用例显式 fire） */
function virtualTimers() {
    const list = [];
    setTimerHooks({
        set: (fn, ms) => { list.push({ fn, ms, cleared: false }); return list.length; },
        clear: (id) => { const t = list[Number(id) - 1]; if (t) t.cleared = true; },
    });
    return {
        list,
        fireAll() { for (const t of list.slice()) { if (!t.cleared && typeof t.fn === 'function') t.fn(); } },
    };
}
/** 远端清单桩：记录被请求的 URL */
function stubNet(calls) {
    return installGlobalFetch((url) => {
        calls.push(String(url));
        if (String(url).endsWith('/manifest.json')) return { status: 200, text: JSON.stringify({ version: VERSION }) };
        if (String(url).endsWith('/CHANGELOG.md')) return { status: 200, text: '## v' + VERSION + '（2026-09-26）\n- 当前版本\n' };
        return { status: 404, body: {} };
    });
}
function resetUpdateState() {
    writeUpdateState({ firstRunAt: 0, startupCheckedAt: 0, lastCheckAt: 0, lastResult: null });
    ensureFirstRun(Date.now());
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 只保留「更新检查」相关请求（宿主文件通道的其它 fetch 不计入） */
const updateCallsOf = (all) => (all || []).filter((u) => /manifest\.json|CHANGELOG|\/api\/extensions/.test(String(u)));
/** 等待「排期后立即返回」的那次调用落地（不触发定时器） */
async function settlePending() { for (let i = 0; i < 5; i += 1) await tick(); }

// ---------- P 组：纯函数 ----------
A('P1 `startupDelayPlan`：自动 → 默认 4 秒；手动 → 0；显式值夹在 0..上限；非法值回落默认',
    (() => {
        const a = startupDelayPlan();
        const b = startupDelayPlan({ manual: true });
        const c = startupDelayPlan({ delayMs: 0 });
        const d = startupDelayPlan({ delayMs: 1234 });
        const e = startupDelayPlan({ delayMs: -5 });
        const f = startupDelayPlan({ delayMs: UPDATE_STARTUP_DELAY_MAX_MS * 10 });
        const g = startupDelayPlan({ delayMs: 'abc' });
        return UPDATE_STARTUP_DELAY_MS === 4000 && a.delayMs === 4000 && a.reason === 'startup'
            && b.delayMs === 0 && b.reason === 'manual'
            && c.delayMs === 0 && c.reason === 'explicit'
            && d.delayMs === 1234 && e.delayMs === 0
            && f.delayMs === UPDATE_STARTUP_DELAY_MAX_MS
            && g.delayMs === 4000 && g.reason === 'startup';
    })(), J([startupDelayPlan(), startupDelayPlan({ manual: true }), startupDelayPlan({ delayMs: 1234 })]));

A('P2 常量可被文档/设置引用（4 秒默认 + 60 秒上限，避免「永不检查」）',
    UPDATE_STARTUP_DELAY_MS === 4000 && UPDATE_STARTUP_DELAY_MAX_MS === 60000,
    J({ UPDATE_STARTUP_DELAY_MS, UPDATE_STARTUP_DELAY_MAX_MS }));

// ---------- S 组：排期语义 ----------
await (async () => {
    // v2.77.0 说明（本次修正的时序脆弱点）：插件自身的 `init()` 也会调用一次启动自动检查
    //   （index.js 注释里的「init 与 APP_READY 双双触发」——新一轮取代旧一轮）。init 走的是
    //   probeTick 的延后初始路径，落地时机取决于模块装载量；若它在我们显式调用**之后**才落地，
    //   就会把我们这一轮取代掉（`scheduled` 变 2 条、`p` 返回 superseded）。
    //   本组只验证「显式调用这一轮」的排期语义，故先等 init 的自动排期落地（此时用的是真实定时器钩子，
    //   不会被下面的虚拟定时器记录），再装虚拟定时器开测 —— 断言与实现顺序解耦。
    for (let i = 0; i < 60 && !Number(((entry.runtimeState() || {}).update || {}).delayMs); i += 1) await tick();
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const p = entry.startupUpdateCheck();            // 不传参数 = 启动自动路径
    await settlePending();
    const scheduled = timers.list.slice();
    const duringCalls = updateCallsOf(calls);
    const duringState = readUpdateState();
    const u = entry.runtimeState().update || {};
    timers.fireAll();                                 // 到点 → 真正检查
    const r = await p;
    await tick();
    const afterState = readUpdateState();
    net();

    A('S1 自动路径：调用后**只排期**（记录到 4000ms 的定时器），此时**没有任何远端请求**',
        scheduled.length === 1 && scheduled[0].ms === UPDATE_STARTUP_DELAY_MS && scheduled[0].cleared === false
        && duringCalls.length === 0,
        J({ scheduled: scheduled.map((t) => t.ms), updateCalls: duringCalls }));

    A('S2 排期期间状态为「已排期」（`reason=delayed` + `delayMs`），而非「尚未检查」或已落盘',
        u.reason === 'delayed' && Number(u.delayMs) === 4000 && u.ran === false
        && !Number(duringState.startupCheckedAt) && !Number(duringState.lastCheckAt),
        J({ update: u, state: duringState }));

    A('S3 定时器到点后才真正检查：发起远端请求、返回 `ran:true`、写入 startupCheckedAt/lastCheckAt',
        updateCallsOf(calls).length >= 1 && updateCallsOf(calls).every((x) => x.indexOf('/api/extensions') < 0)
        && r && r.ran === true && Number(afterState.startupCheckedAt) > 0 && Number(afterState.lastCheckAt) > 0
        && !!afterState.lastResult,
        J({ updateCalls: updateCallsOf(calls).slice(0, 4), r: r && { ran: r.ran, reason: r.reason }, state: afterState }));
})();

// ---------- M 组：手动 / 显式 0 ----------
await (async () => {
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const r = await entry.startupUpdateCheck({ manual: true });
    await tick();
    const manualTimerCount = timers.list.length;
    net();

    A('M1 手动检查**不延迟**：无定时器排期，直接发起请求并落盘',
        manualTimerCount === 0 && updateCallsOf(calls).length >= 1 && r && r.ran === true,
        J({ manualTimerCount, updateCalls: updateCallsOf(calls).slice(0, 2), r: r && r.ran }));
})();

await (async () => {
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const r = await entry.startupUpdateCheck({ delayMs: 0 });
    await tick();
    net();

    A('M2 `delayMs: 0`（测试/诊断用）同样不延迟，直接检查',
        timers.list.length === 0 && r && r.ran === true && updateCallsOf(calls).length >= 1,
        J({ timers: timers.list.length, r: r && r.ran }));
})();

// ---------- C 组：取代 / 撤销 ----------
await (async () => {
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const p1 = entry.startupUpdateCheck();
    await settlePending();
    const firstTimer = timers.list[0];
    const p2 = entry.startupUpdateCheck();            // 第二次排期 → 取代第一次
    await settlePending();
    const r1 = await p1;
    timers.fireAll();
    const r2 = await p2;
    await tick();
    const state = readUpdateState();
    net();

    A('C1 连续两次排期：旧排期被**取代**（返回 superseded 且其定时器被清除），只有最新一次真正检查',
        r1 && r1.ran === false && r1.reason === 'superseded'
        && firstTimer && firstTimer.cleared === true
        && r2 && r2.ran === true && updateCallsOf(calls).length >= 1 && Number(state.startupCheckedAt) > 0,
        J({ r1, r2: r2 && { ran: r2.ran }, firstCleared: firstTimer && firstTimer.cleared, updateCalls: updateCallsOf(calls).length }));
})();

await (async () => {
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const p = entry.startupUpdateCheck();
    await settlePending();
    const cancelled = entry.cancelStartupUpdateDelay();
    timers.fireAll();                                  // 即使定时器"到点"也不该执行
    const r = await p;
    await tick();
    const state = readUpdateState();
    net();

    A('C2 `cancelStartupUpdateDelay()`：撤销后到点也不检查（无请求、无落盘、返回 superseded）',
        cancelled === true && r && r.ran === false && r.reason === 'superseded'
        && updateCallsOf(calls).length === 0 && !Number(state.startupCheckedAt) && !Number(state.lastCheckAt),
        J({ cancelled, r, updateCalls: updateCallsOf(calls), state }));
})();

await (async () => {
    const timers = virtualTimers();
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const p = entry.startupUpdateCheck();
    await settlePending();
    entry.teardown();                                  // 卸载 → 撤销待执行排期
    timers.fireAll();
    const r = await p;
    await tick();
    const state = readUpdateState();
    net();

    A('C3 `teardown()` 撤销未执行的排期（卸载后不再发起请求/写状态）',
        r && r.ran === false && r.reason === 'superseded' && updateCallsOf(calls).length === 0 && !Number(state.startupCheckedAt),
        J({ r, updateCalls: updateCallsOf(calls), state }));
})();

// ---------- F 组：定时器不可用 → 不延迟 ----------
await (async () => {
    setTimerHooks({ set: () => { throw new Error('no-timer'); }, clear: () => undefined });
    const calls = [];
    const net = stubNet(calls);
    resetUpdateState();
    const r = await entry.startupUpdateCheck({ delayMs: 3000 });
    await tick();
    net();
    setTimerHooks({ set: (fn, ms) => setTimeout(fn, Math.max(0, Number(ms) || 0)), clear: (id) => clearTimeout(id) });

    A('F1 定时器钩子抛错 → **不延迟**照常检查（宁可检查，也不要永不检查）',
        r && r.ran === true && updateCallsOf(calls).length >= 1,
        J({ r: r && { ran: r.ran }, updateCalls: updateCallsOf(calls).length }));
})();

// 收尾：还原默认上下文与设置，避免影响其它用例
try { writeUpdateState({ firstRunAt: 0, startupCheckedAt: 0, lastCheckAt: 0, lastResult: null }); } catch (e) { /* 忽略 */ }
void DEFAULT_UPDATE_REPO;
un();
R.done();
