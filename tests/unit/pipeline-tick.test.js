// ============================================================
// 单元测试 · v2.63.0「管线状态计时器：动态变化」
//
// 用户报告：「管线状态的计时器不动，需改进，应该是动态变化的。」
// 事实（修复前）：总览「🧵 管线状态」的「已用时 Ns」只在**面板重绘**那一刻算一次 ——
//   中间没有任何定时器刷新，于是读秒冻结（分析跑 30 秒，页面仍显示首次渲染时的那个秒数）。
// 本批（对齐 V1 v1.85 的 `pipelineTickStart / updatePipelineStatusDom`）：
//   ① 抽出 `pipelineStatusText(now)`：每次调用按**当前时刻**重算读秒，渲染与心跳共用；
//   ② 忙位起始时刻优先取批次真实起点（`batchProgress().since`，对应 V1 `busy.pipe.startedAt`），
//      面板中途打开也显示真实用时（此前从「首次渲染」起算 → 少报）；
//   ③ 忙位期间 **500ms** 心跳（V1 同值）调 `updatePipelineStatusDom()` —— 只改那一行文本、
//      内容没变不写（V1 同款），**不整页重绘**（避免打断输入与滚动）；
//   ④ 空闲 / 关闭面板 / 卸载 / 切离总览 / 那一行不在 DOM → 停表（不泄漏定时器）；
//   ⑤ 行标记与 V1 同名：`data-ftt-pipeline-label`。
// 覆盖：S 文本与起点 ｜ T 500ms 动态刷新（假定时器 + 假时钟，逐秒断言）｜ Z 停表与不泄漏。
// 运行：node tests/unit/pipeline-tick.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg } from '../../core/config.js';
import { panelAction, openPanel, closePanel, unmountPanel, panelBodyHtml, setPanelHooks2, pipelineStatusText, updatePipelineStatusDom, pipelineTickState } from '../../ui/panel.js';

const R = makeReporter('pipeline-tick v2.63.0 管线状态动态读秒');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// ---- DOM 桩：额外提供 `[data-ftt-pipeline-label]` 节点（V1 同名），并统计写入次数 ----
let domWrites = 0;
const pipelineEl = {
    _t: '',
    get textContent() { return this._t; },
    set textContent(v) { this._t = String(v); domWrites += 1; },
};
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { }, appended: [], appendChild(n) { this.appended.push(n); }, removeChild() { return true; } };
doc.querySelector = (sel) => (String(sel).indexOf('data-ftt-pipeline-label') >= 0 ? pipelineEl : null);
installGlobalHost(makeHost({}), doc);
setKernelState(emptyState());
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));

// ---- 假定时器：捕获 interval 并手动驱动（不真等时间）----
const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
let timers = [];
globalThis.setInterval = (fn, ms) => { const t = { fn: fn, ms: ms, cleared: false }; timers.push(t); return t; };
globalThis.clearInterval = (t) => { if (t) t.cleared = true; timers = timers.filter((x) => x !== t); };
const liveTimers = () => timers.filter((t) => !t.cleared);

// ---- 忙位桩 ----
let busy = true;
let since = 0;
setPanelHooks2({
    busy: () => busy,
    batchProgress: () => (busy ? ({ segTotal: 3, segDone: 1, range: { start: 5, end: 8 }, aborted: false, since: since }) : ({ segTotal: 0, segDone: 0 })),
    pending: () => [],
    lastExtract: () => null,
});

// ---- S 组：文本与起始时刻 ----
busy = false; since = 0;
{
    const s = pipelineStatusText(1000);
    A('S1 空闲 → 「空闲」、sec=0、不残留读秒', s.busy === false && s.sec === 0 && s.txt === '空闲', J(s));
}

{
    const now = Date.now();
    busy = true; since = now - 4200;                 // 批次已经开始 4.2 秒（面板此后才打开）
    const s = pipelineStatusText(now);
    A('S2 忙位起点取批次真实起点（面板中途打开显示真实用时，而非从渲染起算）', s.busy === true && s.sec === 4
        && s.txt.indexOf('正在分析记忆（AI 摘要）') === 0 && s.txt.indexOf('分段 1/3') > 0
        && s.txt.indexOf('第 5-8 楼') > 0 && s.txt.indexOf('已用时 4s') > 0, J(s));
}

{
    const now = Date.now();
    busy = true; since = now - 1000;
    const a = pipelineStatusText(now), b = pipelineStatusText(now), c = pipelineStatusText(now + 5000);
    A('S3 同一时刻重复调用稳定；传到更晚的 now → 秒数增长（纯函数、无副作用）', a.sec === 1 && J(a) === J(b) && c.sec === 6, J([a, c]));
}

{
    const now = Date.now();
    busy = false; openPanel('overview');              // 先空闲，清掉 busySince
    busy = true; since = 0;                           // 忙位但批次未给起点
    const a = pipelineStatusText(now), b = pipelineStatusText(now + 3000);
    A('S4 无真实起点时回落到「首次观察到忙位」的时刻（不会 0 秒卡死）', a.sec === 0 && b.sec === 3 && b.txt.indexOf('已用时 3s') > 0, J([a, b]));
}

// ---- T 组：500ms 心跳动态刷新 ----
busy = true; since = Date.now() - 4000;
openPanel('overview');
{
    const st = pipelineTickState();
    A('T1 忙位下渲染总览会起心跳：仅一个、间隔 500ms（V1 v1.85 同值）；行标记与 V1 同名',
        st.running === true && liveTimers().length === 1 && liveTimers()[0].ms === 500
        && panelBodyHtml('overview').indexOf('data-ftt-pipeline-label') > 0,
        J({ tick: st, timers: liveTimers().map((t) => t.ms) }));
}

{
    const now = Date.now();
    domWrites = 0;
    updatePipelineStatusDom(now);
    const first = String(pipelineEl.textContent), writes1 = domWrites;
    updatePipelineStatusDom(now);                     // 同一时刻：文本未变
    const idleWrite = domWrites;
    const tick = liveTimers()[0];
    since = since - 3000;                             // 等价于真实时间流逝 3 秒
    tick.fn();
    const second = String(pipelineEl.textContent);
    A('T2 心跳只改那一行文本：DOM 文本逐秒变化（不整页重绘）；内容没变不写（V1 同款）',
        first.indexOf('已用时 4s') > 0 && writes1 === 1 && idleWrite === 1 && second.indexOf('已用时 7s') > 0 && domWrites === 2,
        J({ first: first, second: second, writes1: writes1, afterSame: idleWrite, total: domWrites }));
}

{
    openPanel('overview');
    void panelBodyHtml('overview');
    void panelBodyHtml('overview');
    A('T3 反复渲染/动作不会重复起表（同一时刻最多一个心跳）', liveTimers().length === 1, J(liveTimers().length));
}

busy = false; since = 0;
openPanel('overview');
{
    const st = pipelineTickState();
    A('T4 管线结束（busy=false）→ 重绘后停表并清零起点', st.running === false && st.busySince === 0 && liveTimers().length === 0,
        J({ tick: st, timers: liveTimers().length }));
}

// ---- Z 组：停表路径（切页 / 关闭 / 卸载 / 自停）----
busy = true; since = Date.now() - 2000;
openPanel('overview');
{
    const onOverview = liveTimers().length;
    await panelAction('tab', { tab: 'atoms' });
    const offOverview = pipelineTickState().running;
    await panelAction('tab', { tab: 'overview' });
    A('Z1 切离总览 → 停表；切回总览（忙位）→ 重新起表',
        onOverview === 1 && offOverview === false && pipelineTickState().running === true && liveTimers().length === 1,
        J({ onOverview: onOverview, offOverview: offOverview, back: pipelineTickState() }));
}

{
    closePanel();
    const afterClose = pipelineTickState().running;
    openPanel('overview');
    const beforeUnmount = liveTimers().length;
    unmountPanel();
    A('Z2 closePanel / unmountPanel → 停表（不泄漏定时器）',
        afterClose === false && beforeUnmount === 1 && pipelineTickState().running === false && liveTimers().length === 0,
        J({ tick: pipelineTickState(), timers: liveTimers().length }));
}

{
    busy = true; since = Date.now() - 1000;
    openPanel('overview');
    const tick = liveTimers()[0];
    busy = false;                                     // 管线结束但这次没有重绘
    tick.fn();
    A('Z3 心跳回调发现管线已结束 → 自行停表（不空转）', pipelineTickState().running === false && liveTimers().length === 0,
        J({ tick: pipelineTickState(), timers: liveTimers().length }));
}

{
    const saved = doc.querySelector;
    doc.querySelector = () => null;                    // 面板不可见 / 那一行不在 DOM
    let ok = null, running = null;
    try {
        busy = true; since = Date.now() - 1000;
        openPanel('overview');
        const tick = liveTimers()[0];
        ok = updatePipelineStatusDom();
        if (tick) tick.fn();
        running = pipelineTickState().running;
    } finally { doc.querySelector = saved; }
    A('Z4 拿不到 [data-ftt-pipeline-label] 节点 → 心跳自停，不反复空转', ok === false && running === false, J({ ok: ok, running: running }));
}

// 复原全局定时器并停表（避免污染其它测试文件）
busy = false;
closePanel();
globalThis.setInterval = realSet;
globalThis.clearInterval = realClear;

R.done();
