// ============================================================
// 单元测试 · v3.50.0 楼层事件的注入刷新：**延迟去抖 + 发送前强制刷新**（`docs/D22` §4.22 W22 `技-51`）
//
// 用户要求（原话）：「核对项目内是否还有其他类似可做性能优化的点，尤其是高频次触发，做好延迟触发器或被动触发器，以优化性能表现。」
//
// 审计发现：`index.js#onFloorChanged()` 绑在 `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` /
//   `GENERATION_ENDED` / `CHAT_CHANGED` 上，而它内部直接 `pushMemoryInject()` —— **每渲染一条消息**就重建整份注入体
//   （本机 4000 条目实测 `buildMemoryBodyForInject` ≈16ms/次；开向量检索还会再发一次 embedding 请求）。
//   而真正「发送前」的注入是 `host/interceptor.js` 在生成时刻权威构建的 → 事件路径这一份可延迟、可合并。
//
// 本文件锁六件事：
//   ① **延迟 1500ms**：首次信号只排一次，**期间不执行**；
//   ② **窗口内合并且不重排**：重复信号一律 `coalesced`，`setTimeout` 只 1 次、`clearTimeout` 0 次；
//   ③ **发送前不漏**：`flushInjectRefresh` 立刻补做（拦截器关着时的唯一刷新源）；
//   ④ **不重复构建**：`cancelInjectRefresh` 作废待做（拦截器开着时它自己会构建）；
//   ⑤ **容错**：无 `setTimeout` / 推送抛错 → 静默（`failed` 计数），绝不影响聊天与生成；
//   ⑥ **反向探针**：延迟改 0 / 允许窗口内重排 / flush 不走真推送 → 本文件变红。
//
// 运行：node tests/unit/inject-schedule.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {
    INJECT_REFRESH_DELAY_MS, INJECT_REASON_MAX,
    injectScheduleState, scheduleInjectRefresh, flushInjectRefresh, cancelInjectRefresh,
    setInjectScheduleHooks, resetInjectSchedule,
} from '../../host/inject-schedule.js';

const R = makeReporter('inject-schedule v3.50.0 注入刷新延迟去抖（D22 W22 技-51）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// ---------- 可控时钟 + 假定时器 + 假推送 ----------
let NOW = 500000;
const timers = [];
let seq = 0, setCalls = 0, cleared = 0;
const pushed = [];                 // 每次推送的实参
let pushThrows = false;
setInjectScheduleHooks({
    now: () => NOW,
    setTimeout: (fn, ms) => { setCalls += 1; const t = { fn, ms, id: ++seq, alive: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { cleared += 1; const t = timers.filter((x) => x.id === id)[0]; if (t) t.alive = false; },
    push: async (o) => { if (pushThrows) throw new Error('push failed'); pushed.push(o); return { ok: true }; },
});
function fireTimers() {
    const live = timers.filter((t) => t.alive);
    for (const t of live) { t.alive = false; t.fn(); }
    return live.length;
}
const settle = () => new Promise((r) => setTimeout(r, 0));   // 真定时器：等一次微任务/宏任务，让 async 推送跑完

// ---------- ① 延迟 1500ms ----------
resetInjectSchedule(); setCalls = 0; cleared = 0; timers.length = 0; pushed.length = 0;
A('A1 首次信号 → **只排一次**延迟刷新，延迟恰为 1500ms（与时钟巡检 1.8s 防抖同量级）', (() => {
    const r = scheduleInjectRefresh('floor-changed');
    const st = injectScheduleState();
    return r.accepted === true && r.reason === 'scheduled' && setCalls === 1
        && timers.length === 1 && timers[0].ms === INJECT_REFRESH_DELAY_MS && INJECT_REFRESH_DELAY_MS === 1500
        && st.pending === true && st.scheduled === true;
})(), J(injectScheduleState()));
A('A2 延迟期间**不构建**（时间没到 → 一次推送都没发生）', (() => {
    NOW += INJECT_REFRESH_DELAY_MS - 1;
    return pushed.length === 0 && injectScheduleState().stats.runs === 0;
})(), J({ pushed: pushed.length }));

// ---------- ② 窗口内合并且不重排 ----------
A('B1 窗口内再来 4 个信号 → 全部 `coalesced`（高频事件合并为一次构建）', (() => {
    const rs = [scheduleInjectRefresh('floor-changed'), scheduleInjectRefresh('floor-changed'),
        scheduleInjectRefresh('generation-ended'), scheduleInjectRefresh('chat-changed')];
    return rs.every((x) => x.accepted === false && x.reason === 'coalesced')
        && injectScheduleState().stats.coalesced === 4 && injectScheduleState().stats.signals === 5;
})(), J(injectScheduleState().stats));
A('B2 **不重排**：`setTimeout` 仍只调用 1 次、`clearTimeout` 0 次（时间点不后移）', () => setCalls === 1 && cleared === 0, J({ setCalls, cleared }));
A('B3 时间到 → **只做一次**推送，且参数与旧实现同口径（queryText 为空串）', (async () => {
    fireTimers();
    await settle();
    const st = injectScheduleState();
    return pushed.length === 1 && pushed[0] && pushed[0].queryText === ''
        && st.stats.runs === 1 && st.pending === false && st.scheduled === false;
})(), 'n/a');

// ---------- ③ 发送前补做（拦截器关着时唯一刷新源） ----------
resetInjectSchedule(); setCalls = 0; timers.length = 0; pushed.length = 0;
A('C1 `flushInjectRefresh` 立刻补做待做的刷新（不等延迟）', (async () => {
    scheduleInjectRefresh('floor-changed');
    const did = await flushInjectRefresh('generation-started');
    await settle();
    const st = injectScheduleState();
    return did === true && pushed.length === 1 && st.stats.flushed === 1 && st.pending === false
        && st.stats.runs === 1 && st.scheduled === false;      // 定时器已清掉，不会再多构建一次
})(), 'n/a');
A('C2 没有待做时 `flush` 返回 false（不空构建）', (async () => {
    const before = pushed.length;
    const did = await flushInjectRefresh('generation-started');
    return did === false && pushed.length === before;
})(), 'n/a');

// ---------- ④ 不重复构建（拦截器开着时） ----------
resetInjectSchedule(); setCalls = 0; timers.length = 0; pushed.length = 0;
A('D1 `cancelInjectRefresh` 作废待做 → 到点也**不会**再构建（拦截器自己会权威构建）', (async () => {
    scheduleInjectRefresh('floor-changed');
    const did = cancelInjectRefresh('generation-started');
    const n = fireTimers();                                   // 即便定时器仍被触发（已被 clear）
    await settle();
    const st = injectScheduleState();
    return did === true && pushed.length === 0 && st.stats.cancelled === 1 && st.stats.runs === 0;
})(), J(injectScheduleState().stats));
A('D2 没有待做时 `cancel` 返回 false（如实回报，不虚报作废）', () => cancelInjectRefresh('interceptor') === false, 'n/a');
A('D3 作废后**下一次信号照常能排**（不会卡死「永远合并」）', (async () => {
    const r = scheduleInjectRefresh('floor-changed');
    NOW += INJECT_REFRESH_DELAY_MS + 1;
    fireTimers();
    await settle();
    return r.accepted === true && pushed.length === 1;
})(), 'n/a');

// ---------- ⑤ 容错 ----------
resetInjectSchedule(); pushed.length = 0;
A('E1 推送抛错 → 静默并计入 `failed`（绝不影响聊天与生成）', (async () => {
    pushThrows = true;
    scheduleInjectRefresh('floor-changed');
    NOW += INJECT_REFRESH_DELAY_MS + 1;
    fireTimers();
    await settle();
    const st = injectScheduleState();
    pushThrows = false;
    return st.stats.runs === 1 && st.stats.failed === 1;
})(), 'n/a');
/**
 * v3.50.10（`docs/D22` §4.25 `技-52`）：受限宿主（`setTimeout` 返回空句柄）下的口径**变严了** ——
 *   旧断言只要求「不抛错」（`accepted:true || reason:'error'`），并默认承认「`pending` 可能停在 true」；
 *   现在必须：① 如实回报 `no-timer`；② **状态回滚**（`pending/scheduled` 都为 false，不留粘滞态）。
 */
A('E2 无 `setTimeout`（受限宿主）→ 如实回报 `no-timer`、不抛错、**不留悬挂状态**（`pending` 回滚）', (() => {
    resetInjectSchedule();
    const prevSet = globalThis.setTimeout;
    setInjectScheduleHooks({ setTimeout: undefined });
    // 注入一个「返回空句柄」的定时器实现，模拟受限宿主
    setInjectScheduleHooks({ setTimeout: () => null });
    const r = scheduleInjectRefresh('floor-changed');
    const st = injectScheduleState();
    setInjectScheduleHooks({ setTimeout: (fn, ms) => { setCalls += 1; const t = { fn, ms, id: ++seq, alive: true }; timers.push(t); return t.id; } });
    void prevSet;
    resetInjectSchedule();
    return r.accepted === false && String(r.reason) === 'no-timer'
        && st.pending === false && st.scheduled === false;
})(), 'n/a');
A('E3 原因环形留痕有上限（内存恒定，不随会话增长）', (() => {
    resetInjectSchedule();
    for (let i = 0; i < INJECT_REASON_MAX + 10; i++) {
        scheduleInjectRefresh('reason-' + i);
        cancelInjectRefresh('cancel-' + i);
    }
    const rs = injectScheduleState().reasons;
    resetInjectSchedule();
    return rs.length <= INJECT_REASON_MAX;
})(), J(INJECT_REASON_MAX));

// ---------- ⑥ 反向探针 ----------
A('F1 反向探针①：延迟若被改成 0（= 回到「每次事件立即构建」）→ A1/A2 变红', () => INJECT_REFRESH_DELAY_MS === 1500, J(INJECT_REFRESH_DELAY_MS));
A('F2 反向探针②：窗口内若「重排定时器」→ B2 变红（本判据直接盯着 set/clear 次数）', (() => {
    resetInjectSchedule(); setCalls = 0; cleared = 0; timers.length = 0;
    scheduleInjectRefresh('a');
    scheduleInjectRefresh('b');
    scheduleInjectRefresh('c');
    const ok = setCalls === 1 && cleared === 0;
    resetInjectSchedule();
    return ok;
})(), J({ setCalls, cleared }));
A('F3 反向探针③：flush 必须**真的走推送**（若只清状态不推送 → C1 变红）', (async () => {
    resetInjectSchedule(); pushed.length = 0;
    scheduleInjectRefresh('floor-changed');
    await flushInjectRefresh('generation-started');
    await settle();
    const ok = pushed.length === 1;
    resetInjectSchedule();
    return ok;
})(), 'n/a');

resetInjectSchedule();
R.done();
