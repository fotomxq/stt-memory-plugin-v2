// ============================================================
// 单元测试 · v3.0.2「立即 AI 摘要」与「单楼分析」联动提示 + 批次管线行
//
// 用户报告（原话）：「立即AI摘要是分析记忆动作，应该与点击单个未分析楼层联动做提示，
//   其次管线状态也应该有提示，但现在没有，请修复。」
//
// 核对结论（两处缺口）：
//   ① **两个入口没有联动**：「⚡ 立即 AI 摘要」（`summary`）与「第 N 楼」（`summaryFloor`）本来是
//      **同一条分析管线**（都经 `genTracked` → `core/pipeline.js`），但按钮态 / 提示 / 通知各自为政 ——
//      批量在跑时楼按钮仍可点（点了才被拒）、单楼在跑时批量按钮仍可点；批量也没有开始/完成通知。
//   ② **批次本身不占管线行**：v3.0.0 的管线块只渲染「AI 运行」，而一次批量分析里 AI 调用只占一部分时间
//      （还有段切分 / 落库 / 快照 / 校正）——两次调用之间整块消失，用户看到的正是「点了没有管线提示」。
//
// 覆盖：A 双向联动（按钮态 / 提示 / 通知）；B 批次占管线行且与 AI 调用行并存；C 拒绝路径与边界。
// 运行：node tests/unit/summary-link.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { resetPipeline, beginPipeline, endPipeline, listPipelineRuns } from '../../core/pipeline.js';
import {
    panelAction, openPanel, panelBodyHtml, panelState, setPanelHooks2, pipelineBoxRowsHtml,
} from '../../ui/panel.js';

const R = makeReporter('summary-link v3.0.2 批量摘要 ⇄ 单楼分析联动 + 批次管线行');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);

let batch = null;      // 批次进度桩（null = 批次空闲）
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:summary-link');
    setLastMessageId(9);
    const st = emptyState();
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    batch = o.batch || null;
    resetPipeline();
    setPanelHooks2({
        pending: () => o.pending || [3, 4, 5],
        busy: () => !!batch,
        batchProgress: () => (batch || { segTotal: 0, segDone: 0 }),
        notify: (o.notify || (() => true)),
        extract: o.extract,
        autoSummary: o.autoSummary,
    });
    openPanel('overview');
    return st;
}
const grabBtn = (h, action) => (String(h).match(new RegExp('<button[^>]*data-ftt-action="' + action + '"[^>]*>')) || [''])[0];

// ---------- A 组：双向联动 ----------
A('A1 空闲时两个入口都可点（基线）：`⚡ 立即 AI 摘要` 与「第 N 楼」都不带 disabled', (() => {
    boot({});
    const h = String(panelBodyHtml('overview') || '');
    const sm = grabBtn(h, 'summary');
    const fl = grabBtn(h, 'summaryFloor');
    return sm.indexOf('disabled') < 0 && fl.indexOf('disabled') < 0
        && h.indexOf('>⚡ 立即 AI 摘要</button>') > 0 && h.indexOf('>第3楼</button>') > 0;
})(), '');

A('A2 **批次在途 → 楼按钮整体禁用**并写明原因（「⚡ 立即 AI 摘要」转圈禁用）；点楼按钮会被拒（不发起 AI）', (async () => {
    const calls = [];
    boot({ batch: { segTotal: 4, segDone: 1, range: { start: 3, end: 5 }, since: Date.now() - 2000 }, extract: async () => { calls.push('extract'); return { ok: true }; } });
    const h = String(panelBodyHtml('overview') || '');
    const sm = grabBtn(h, 'summary');
    const fl = grabBtn(h, 'summaryFloor');
    const r = await panelAction('summaryFloor', { floor: 3 });
    return sm.indexOf('disabled') >= 0 && sm.indexOf('ftt-loading') >= 0 && sm.indexOf('分析中…') >= 0
        && fl.indexOf('disabled') >= 0 && fl.indexOf('正在批量分析未摘要楼层') >= 0
        && r.ok === false && r.reason === 'busy' && calls.length === 0
        && String(r.state.note || '').indexOf('批量摘要正在运行') >= 0;
})(), () => J({ sm: grabBtn(panelBodyHtml('overview'), 'summary').slice(0, 120) }));

A('A3 **单楼在途 → 批量按钮禁用**并写明「正在分析第 N 楼」；点批量会被拒（不启动批次）', (async () => {
    let started = 0;
    boot({ autoSummary: async () => { started += 1; return { ok: true, segments: 1, floors: 1, added: 0 }; } });
    let release = null;
    setPanelHooks2({
        pending: () => [3, 4, 5],
        busy: () => false,
        batchProgress: () => ({ segTotal: 0, segDone: 0 }),
        notify: () => true,
        autoSummary: async () => { started += 1; return { ok: true, segments: 1, floors: 1, added: 0 }; },
        extract: async () => { await new Promise((r) => { release = r; }); return { ok: true, added: 1 }; },
    });
    const p = panelAction('summaryFloor', { floor: 4 });
    await new Promise((r) => setTimeout(r, 0));
    const h = String(panelBodyHtml('overview') || '');
    const sm = grabBtn(h, 'summary');
    const rejected = await panelAction('summary', {});
    if (release) release();
    await p;
    return sm.indexOf('disabled') >= 0 && sm.indexOf('正在分析第 4 楼') >= 0
        && rejected.ok === false && rejected.reason === 'busy' && started === 0;
})(), '');

A('A4 提示与通知也联动：批量点击后**同帧**写提示（含未摘要楼层数）+ 弹「开始分析」，完成后弹结果通知（成功/失败两档）', (async () => {
    const notices = [];
    boot({
        pending: [3, 4, 5],
        notify: (k, t) => { notices.push([String(k), String(t)]); return true; },
        autoSummary: async () => ({ ok: true, segments: 3, floors: 3, added: 5 }),
    });
    const r = await panelAction('summary', {});
    const after = notices.map((x) => x[0]).join(',');
    // 失败档
    const notices2 = [];
    setPanelHooks2({
        pending: () => [3], busy: () => false, batchProgress: () => ({ segTotal: 0, segDone: 0 }),
        notify: (k, t) => { notices2.push([String(k), String(t)]); return true; },
        autoSummary: async () => ({ ok: false, reason: 'no-generate' }),
    });
    const r2 = await panelAction('summary', {});
    return r.ok === true && after === 'info,success'
        && notices[0][1].indexOf('开始分析 3 个未摘要楼层') >= 0
        && notices[1][1].indexOf('AI 摘要完成：3 段 · 新增 5 条') >= 0
        && String(r.state.note || '').indexOf('摘要完成：3 段') >= 0
        && r2.ok === true && notices2.map((x) => x[0]).join(',') === 'info,warning'
        && notices2[1][1].indexOf('AI 摘要未完成：no-generate') >= 0;
})(), () => J(panelState().note));

A('A5 批量点击后**立即重绘**（提示同帧可见，不必等 AI 返回）：调用点先 renderPanel 再 await 批次', (async () => {
    let noteAtStart = '';
    boot({
        pending: [3, 4],
        autoSummary: async () => { noteAtStart = String(panelState().note || ''); return { ok: true, segments: 1, floors: 1, added: 0 }; },
    });
    await panelAction('summary', {});
    return noteAtStart.indexOf('AI 摘要分析中…') >= 0 && noteAtStart.indexOf('2 个未摘要楼层') >= 0
        && noteAtStart.indexOf('同一条分析管线') >= 0;
})(), '');

// ---------- B 组：批次占管线行 ----------
A('B1 **批次本身在管线里占一行**（`分段 x/y · 第 N-M 楼 · 已用时 · 已请求中断`）—— 修复前只有 AI 调用行，两次调用之间整块消失', (() => {
    boot({ batch: { segTotal: 8, segDone: 3, range: { start: 9, end: 16 }, since: Date.now() - 5000, aborted: true } });
    const rows = String(pipelineBoxRowsHtml());
    return rows.indexOf('data-ftt-pipeline-row="batch"') >= 0
        && rows.indexOf('[AI] AI 摘要（批量）') >= 0
        && rows.indexOf('分段 3/8') >= 0 && rows.indexOf('第 9-16 楼') >= 0
        && rows.indexOf('已用时') >= 0 && rows.indexOf('已请求中断') >= 0;
})(), () => pipelineBoxRowsHtml());

A('B2 批次行与**当前 AI 调用行并存**（一行说「批次整体进度」、一行说「这一次调用」）—— 两行都在', (() => {
    boot({ batch: { segTotal: 8, segDone: 3, range: { start: 9, end: 16 }, since: Date.now() - 5000 } });
    beginPipeline('批量摘要', { chars: 4000, kind: 'ai', phase: '请求 AI（第 9-16 楼）' });
    const rows = String(pipelineBoxRowsHtml());
    const n = (rows.match(/data-ftt-pipeline-row=/g) || []).length;
    const ok = n === 2 && rows.indexOf('[AI] AI 摘要（批量）') >= 0 && rows.indexOf('[AI] 批量摘要') >= 0
        && rows.indexOf('阶段：请求 AI（第 9-16 楼）') >= 0;
    endPipeline(true);
    return ok;
})(), () => pipelineBoxRowsHtml());

A('B3 批次结束后行消失；**空闲无批次时整块为空**（默认不显示仍成立）', (() => {
    boot({ batch: { segTotal: 4, segDone: 2, since: Date.now() - 1000 } });
    const during = String(pipelineBoxRowsHtml());
    batch = null;                                        // 批次结束
    const after = String(pipelineBoxRowsHtml());
    return during.indexOf('data-ftt-pipeline-row="batch"') >= 0 && after === '';
})(), '');

A('B4 批次在途但**已无 AI 调用**时也不空转：只有批次行一行（覆盖「段切分 / 落库 / 校正」这类非 AI 阶段）', (() => {
    boot({ batch: { segTotal: 6, segDone: 4, range: { start: 1, end: 6 }, since: Date.now() - 9000 } });
    const runs = listPipelineRuns();
    const rows = String(pipelineBoxRowsHtml());
    return runs.length === 0 && (rows.match(/data-ftt-pipeline-row=/g) || []).length === 1
        && rows.indexOf('AI 摘要（批量）') >= 0 && rows.indexOf('分段 4/6') >= 0;
})(), '');

// ---------- C 组：边界 ----------
A('C1 批次已在跑时再点批量 → 如实拒绝（不重复启动）', (async () => {
    let started = 0;
    boot({ batch: { segTotal: 2, segDone: 1, since: Date.now() - 1000 }, autoSummary: async () => { started += 1; return { ok: true }; } });
    const r = await panelAction('summary', {});
    return r.ok === false && r.reason === 'busy' && started === 0
        && String(r.state.note || '').indexOf('已在分析中') >= 0;
})(), '');

A('C2 未接批次钩子 → 如实提示「入口未就绪」（并走统一收尾：返回 html/state 可见）', (async () => {
    boot({});                                            // 不提供 autoSummary
    const r = await panelAction('summary', {});
    return r.ok === false && r.reason === 'no-hook'
        && String(r.state.note || '').indexOf('批量摘要入口未就绪') >= 0
        && String(r.html || '').indexOf('批量摘要入口未就绪') >= 0;
})(), '');

A('C3 批量的 AI 调用仍各自占行（多段依次进行时逐段出现，段与段之间由批次行兜底）—— 既有 v3.0.0 口径不回退', (() => {
    boot({ batch: null });
    const a = beginPipeline('批量摘要', { chars: 1000, kind: 'ai', phase: '请求 AI（第 1-8 楼）' });
    const rows1 = String(pipelineBoxRowsHtml());
    endPipeline(true, a.runId);
    const b = beginPipeline('批量摘要', { chars: 1000, kind: 'ai', phase: '请求 AI（第 9-16 楼）' });
    const rows2 = String(pipelineBoxRowsHtml());
    endPipeline(true, b.runId);
    return rows1.indexOf('第 1-8 楼') >= 0 && rows2.indexOf('第 9-16 楼') >= 0
        && rows1.indexOf('[AI] 批量摘要') >= 0 && rows2.indexOf('[AI] 批量摘要') >= 0;
})(), '');

R.done();
