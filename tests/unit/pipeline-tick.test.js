// ============================================================
// 单元测试 · 管线状态（「🧵 管线状态」块）
//
// 历史：v2.63.0「计时器动态变化」（本文件原有 S/T/Z 组）→ v2.95.0「单路 AI 也要显示」→
//   **v3.0.0（用户要求）**：
//     「1. 所有 AI 请求无论是否存在并行，都应该在管线出现提示信息；
//       2. 管线状态默认不显示，如果有请求、同步等各类动作时自动出现，且如果有并行时出现两个或两个以上，根据需求展现。」
//   本版口径：
//     ① 容器 = `[data-ftt-pipeline-box]`，块内 **0..N 行**（`data-ftt-pipeline-row="<runId>"`）——并行时一行一条；
//     ② **默认不显示**：无进行中动作 → 块 `display:none` 且无行（不再常驻一行「空闲」）；
//     ③ **自动出现**：心跳不再只在忙位时跑 —— 面板开着并停在总览就常驻 500ms，后台动作（自动摘要 /
//        跨端同步 / 世界书镜像 / 保存 / 向量请求…）无需整页重绘即可出现；
//     ④ 每行含类别标签（AI / 同步 / 存储 / 任务）+ 读秒 + token + 预估倒计时 + 流式块 + 阶段/结构摘要。
// 覆盖：S 文本与起点 ｜ T 心跳与块刷新 ｜ W v3.0.0 三项要求 ｜ Z 停表与不泄漏。
// 运行：node tests/unit/pipeline-tick.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg } from '../../core/config.js';
import {
    beginPipeline, endPipeline, resetPipeline, listPipelineRuns, trackPipeline, snapshot as pipelineSnapshot,
} from '../../core/pipeline.js';
import {
    panelAction, openPanel, closePanel, unmountPanel, panelBodyHtml, setPanelHooks2,
    pipelineStatusText, updatePipelineStatusDom, pipelineTickState, pipelineBoxRowsHtml,
} from '../../ui/panel.js';

const R = makeReporter('pipeline-tick 管线状态（v3.0.0：0..N 行 · 默认隐藏 · 自动出现）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// ---- DOM 桩：`[data-ftt-pipeline-box]` 节点（记录 innerHTML 写入次数与 display）----
let domWrites = 0;
const pipelineEl = {
    _h: '', _d: 'none',
    get innerHTML() { return this._h; },
    set innerHTML(v) { const s = String(v); if (s !== this._h) { this._h = s; domWrites += 1; } },
    style: {
        get display() { return this._d; },
        set display(v) { this._d = String(v); },
    },
};
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { }, appended: [], appendChild(n) { this.appended.push(n); }, removeChild() { return true; } };
doc.querySelector = (sel) => (String(sel).indexOf('data-ftt-pipeline-box') >= 0 ? pipelineEl : null);
installGlobalHost(makeHost({}), doc);
setKernelState(emptyState());
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));

// ---- 假定时器：捕获 interval 并手动驱动（不真等时间）----
const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
let timers = [];
globalThis.setInterval = (fn, ms) => { const t = { fn: fn, ms: ms, cleared: false }; timers.push(t); return t; };
globalThis.clearInterval = (t) => { if (t) t.cleared = true; timers = timers.filter((x) => x !== t); };
const liveTimers = () => timers.filter((t) => !t.cleared);
const tick = () => { const t = liveTimers()[0]; if (t) t.fn(); return !!t; };
const rowCount = () => (String(pipelineEl.innerHTML).match(/data-ftt-pipeline-row=/g) || []).length;

/** 忙位桩（批次） */
let busy = false;
let since = 0;
setPanelHooks2({
    busy: () => busy,
    batchProgress: () => (busy ? ({ segTotal: 3, segDone: 1, range: { start: 5, end: 8 }, aborted: false, since: since }) : ({ segTotal: 0, segDone: 0 })),
    pending: () => [],
    lastExtract: () => null,
});
resetPipeline();

// ---- S 组：文本与起始时刻（v2.63.0 既有口径，保持不变）----
busy = false; since = 0;
{
    const s = pipelineStatusText(1000);
    A('S1 批次空闲 → `pipelineStatusText` 仍返回「空闲」（文本函数口径不变；块的显示与否另由 W 组判定）', s.busy === false && s.sec === 0 && s.txt === '空闲', J(s));
}
{
    const now = Date.now();
    busy = true; since = now - 4200;
    const s = pipelineStatusText(now);
    A('S2 忙位起点取批次真实起点（面板中途打开显示真实用时）', s.busy === true && s.sec === 4
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
    busy = false; openPanel('overview');
    busy = true; since = 0;
    const a = pipelineStatusText(now), b = pipelineStatusText(now + 3000);
    A('S4 无真实起点时回落到「首次观察到忙位」的时刻（不会 0 秒卡死）', a.sec === 0 && b.sec === 3 && b.txt.indexOf('已用时 3s') > 0, J([a, b]));
}

// ---- T 组：500ms 心跳动态刷新（内容没变不写、不整页重绘）----
busy = false;
beginPipeline('单楼分析', { chars: 4000, kind: 'ai' });
openPanel('overview');
{
    const st = pipelineTickState();
    A('T1 面板停在总览即起心跳：仅一个、间隔 500ms；总览 markup 含 `[data-ftt-pipeline-box]`',
        st.running === true && liveTimers().length === 1 && liveTimers()[0].ms === 500
        && panelBodyHtml('overview').indexOf('data-ftt-pipeline-box') > 0,
        J({ tick: st, timers: liveTimers().map((t) => t.ms) }));
}
{
    domWrites = 0;
    updatePipelineStatusDom(Date.now());
    const first = String(pipelineEl.innerHTML), writes1 = domWrites;
    updatePipelineStatusDom(Date.now());              // 同一时刻：内容未变 → 不写
    const same = domWrites;
    A('T2 同一时刻重复刷新**不写 DOM**（内容没变不写，V1 同款）', writes1 === 1 && same === 1 && first.indexOf('单楼分析') >= 0,
        J({ writes1: writes1, same: same }));
}
{
    const runs = listPipelineRuns();
    const id = runs[0].id;
    const before = String(pipelineEl.innerHTML);
    const agg = pipelineSnapshot();                   // 聚合快照（兼容既有调用点）
    const ticked = tick();
    A('T3 心跳回调刷新块内容；聚合快照仍可用（busy / elapsed / tokens）',
        ticked === true && agg.busy === true && agg.elapsed >= 0
        && String(pipelineEl.innerHTML).indexOf('⏱') > 0 && before.indexOf('单楼分析') >= 0 && id > 0,
        J({ agg: { busy: agg.busy, tokens: agg.tokens } }));
}
endPipeline(true);

// ---- W 组：v3.0.0 三项要求 ----
resetPipeline();
updatePipelineStatusDom(Date.now());
{
    A('W1 **默认不显示**：没有任何进行中的动作 → 块内 0 行且 `display:none`；总览 markup 里块也带 `display:none`',
        pipelineBoxRowsHtml() === '' && rowCount() === 0 && pipelineEl.style.display === 'none'
        && String(panelBodyHtml('overview')).indexOf('data-ftt-pipeline-box') > 0
        && String(panelBodyHtml('overview')).indexOf('data-ftt-pipeline-box-wrap style="display:none"') > 0,
        J({ rows: pipelineBoxRowsHtml(), display: pipelineEl.style.display }));
}
{
    beginPipeline('批量摘要', { chars: 12000, kind: 'ai' });
    tick();
    const shown = pipelineEl.style.display === '' && rowCount() === 1
        && String(pipelineEl.innerHTML).indexOf('[AI] 批量摘要') >= 0;
    endPipeline(true);
    tick();
    A('W2 **有请求时自动出现**：动作开始后一次心跳即显示（无需整页重绘）；结束后再次心跳自动隐藏',
        shown === true && pipelineEl.style.display === 'none' && rowCount() === 0,
        J({ shown: shown, after: pipelineEl.style.display }));
}
{
    beginPipeline('批量摘要', { chars: 1000, kind: 'ai' });
    beginPipeline('跨端同步', { kind: 'sync' });
    beginPipeline('保存记忆文件', { kind: 'io' });
    tick();
    const html = String(pipelineEl.innerHTML);
    const ok = rowCount() === 3 && pipelineEl.style.display === ''
        && html.indexOf('[AI] 批量摘要') >= 0 && html.indexOf('[同步] 跨端同步') >= 0 && html.indexOf('[存储] 保存记忆文件') >= 0;
    A('W3 **并行时出现两个或两个以上**：三路并行 → 三行，且每行带类别标签（AI / 同步 / 存储）',
        ok === true, J({ rows: rowCount() }));
}
{
    const runs = listPipelineRuns();
    endPipeline(true, runs.filter((r) => r.label === '跨端同步')[0].id);
    tick();
    const two = rowCount();
    endPipeline(true, runs.filter((r) => r.label === '保存记忆文件')[0].id);
    tick();
    const one = rowCount();
    endPipeline(true);
    tick();
    A('W4 各路陆续结束 → 行数跟着减少（3 → 2 → 1 → 隐藏）', two === 2 && one === 1 && rowCount() === 0 && pipelineEl.style.display === 'none',
        J({ two: two, one: one }));
}
{
    beginPipeline('弱化NSFW', { chars: 8000, phase: '请求 AI', kind: 'ai' });
    const rows = pipelineBoxRowsHtml();
    const ok = rows.indexOf('⏱') > 0 && rows.indexOf('🪙') > 0 && rows.indexOf('预计剩') > 0 && rows.indexOf('阶段：请求 AI') > 0;
    endPipeline(true);
    A('W5 每行信息量与既有口径一致：`⏱ 读秒 · 🪙 token · 预计剩 · 阶段/结构摘要`', ok === true, rows);
}
{
    let during = null;
    const ret = await trackPipeline('世界书镜像', { kind: 'sync' }, async (t) => {
        t.phase('推送词条');
        tick();
        during = { rows: rowCount(), html: String(pipelineEl.innerHTML) };
        return 'done';
    });
    tick();
    A('W6 `trackPipeline(label, {kind}, fn)` 一行接线：动作期间自动出现、结束自动收尾（返回值透传）',
        ret === 'done' && during.rows === 1 && during.html.indexOf('[同步] 世界书镜像') >= 0
        && during.html.indexOf('阶段：推送词条') > 0 && rowCount() === 0,
        J(during));
}

// ---- Z 组：停表路径（切页 / 关闭 / 卸载 / 自停）----
busy = true; since = Date.now() - 2000;
openPanel('overview');
{
    const onOverview = liveTimers().length;
    await panelAction('tab', { tab: 'atoms' });
    const offOverview = pipelineTickState().running;
    await panelAction('tab', { tab: 'overview' });
    A('Z1 切离总览 → 停表；切回总览 → 重新起表',
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
    busy = false;
    openPanel('overview');
    A('Z3 批次结束也**不再停表**（v3.0.0：心跳常驻总览，才能捕捉后台动作），但块保持隐藏',
        pipelineTickState().running === true && liveTimers().length === 1 && pipelineEl.style.display === 'none',
        J({ tick: pipelineTickState(), display: pipelineEl.style.display }));
}
{
    const saved = doc.querySelector;
    doc.querySelector = () => null;                    // 拿不到块节点（面板不可见 / 被移除）
    let ok = null, running = null;
    try {
        openPanel('overview');
        const t = liveTimers()[0];
        ok = updatePipelineStatusDom();
        if (t) t.fn();
        running = pipelineTickState().running;
    } finally { doc.querySelector = saved; }
    A('Z4 拿不到 [data-ftt-pipeline-box] 节点 → 心跳自停，不反复空转', ok === false && running === false, J({ ok: ok, running: running }));
}

// 复原全局定时器并停表（避免污染其它测试文件）
busy = false;
closePanel();
resetPipeline();
globalThis.setInterval = realSet;
globalThis.clearInterval = realClear;

R.done();
