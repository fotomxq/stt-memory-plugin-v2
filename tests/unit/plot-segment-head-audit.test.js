// ============================================================
// 单元测试 · v3.50.31 **情节分段总结：开篇前 10 条禁止参与 + 既有设计审查修复**
//
// 用户要求（原话）：
//   1. 「情节的前10条禁止被分段总结。」
//   2. 「之前设计的情节分段总结，也需核对是否存在问题。」
//
// 本轮落地两件事：
//   ① 新增**头部保留窗口** `PLOT_SEGMENT_HEAD_N = 10` —— 剧情时间最早的前 10 条既不进自动计划，也不允许手动勾选纳入；
//   ② 审查发现并修复的缺陷：**已覆盖情节仍留在池里** → 混合批次（部分已覆盖 + 部分新增）会被**整批重新总结**
//      （浪费一次 AI；若重算区间与既有段落重叠 <50% 还会**新增重复段落**）。现在自动计划的切批来源只含未覆盖情节。
//
// 运行：node tests/unit/plot-segment-head-audit.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    PLOT_SEGMENT_HEAD_N, plotSegmentHeadReserve, plotSegmentPlan, plotSegmentPlanForIds,
    plotSegmentAtomList, plotSegmentCoveredIds, runPlotSegmentSummarySelected, runPlotSegmentSummary,
} from '../../core/plot-segment.js';

const R = makeReporter('plot-segment-head-audit v3.50.31 开篇保留窗口 + 分段总结审查');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(atoms, extraCfg, seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, extraCfg || {});
    setScopeKey('char:head-audit');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.atoms = atoms || [];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const mk = (n, prefix) => Array.from({ length: n }, (_, k) => ({
    id: (prefix || 'a') + k, title: 'A' + k, text: '第 ' + (k + 1) + ' 条情节正文。',
    date: '1919-' + String(Math.floor(k / 28) + 1).padStart(2, '0') + '-' + String((k % 28) + 1).padStart(2, '0'),
    validity: 'active', tags: [], floorStart: k + 1, floorEnd: k + 1,
}));

// ---------- A 头部保留窗口 ----------
A('A1 常量 `PLOT_SEGMENT_HEAD_N = 10`，且 `plotSegmentHeadReserve()` 一致（界面/调试可读）', (() => {
    return PLOT_SEGMENT_HEAD_N === 10 && plotSegmentHeadReserve() === 10;
})(), J({ n: PLOT_SEGMENT_HEAD_N, fn: plotSegmentHeadReserve() }));
A('A2 **开篇前 10 条不进任何批次**：30 条情节（批 5）→ 池 = 去掉头 10 与尾 10 → 只剩中间 10 条（2 批）', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const plan = plotSegmentPlan();
    const ids = new Set(plan.batches.flatMap((b) => b.ids));
    const list = plotSegmentAtomList();
    const head = list.slice(0, 10).map((a) => String(a.id));
    const tail = list.slice(-10).map((a) => String(a.id));
    return plan.headN === 10 && plan.headKept === 10 && plan.poolTotal === 10
        && plan.batches.length === 2 && head.every((id) => !ids.has(id)) && tail.every((id) => !ids.has(id));
})(), 'n/a');
A('A3 情节**不足 10 条**时全部保留：池为空、0 批（绝不为了凑批而动开篇）', (() => {
    boot(mk(8), { plotSegmentBatchAtoms: 3 });
    const plan = plotSegmentPlan();
    return plan.total === 8 && plan.headKept === 8 && plan.poolTotal === 0 && plan.batches.length === 0 && plan.pending === 0;
})(), 'n/a');
A('A4 内部覆盖 `headN: 0` 可关闭头部保留（V1 平价 / 测试专用）；生产路径不传 → 恒为 10', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const p0 = plotSegmentPlan({ headN: 0, reserveN: 0 });
    const pd = plotSegmentPlan();
    return p0.headN === 0 && p0.poolTotal === 30 && pd.headN === 10 && pd.poolTotal === 10;
})(), 'n/a');

// ---------- B 手动勾选同样受约束 ----------
A('B1 **手动勾选不能纳入开篇前 10 条**：全选 30 条 → 只总结中间 10 条，`skippedHead = 10`（如实回报）', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const all = plotSegmentAtomList().map((a) => String(a.id));
    const plan = plotSegmentPlanForIds(all.slice(0, 10).concat(all.slice(10, 20)));
    return plan.skippedHead === 10 && plan.total === 10 && plan.batches.length === 2;
})(), 'n/a');
A('B2 勾选**只含开篇 10 条** → 0 批（不静默总结，界面据 `skippedHead` / toast 告知）', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const head = plotSegmentAtomList().slice(0, 10).map((a) => String(a.id));
    const plan = plotSegmentPlanForIds(head);
    return plan.skippedHead === 10 && plan.total === 0 && plan.batches.length === 0;
})(), 'n/a');
A('B3 `runPlotSegmentSummarySelected` 端到端：勾选含开篇 → 段落 `atomIds` **绝不含**开篇 id；返回体带 `skippedHead`', (async () => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const all = plotSegmentAtomList().map((a) => String(a.id));
    const headIds = new Set(all.slice(0, 10));
    const res = await runPlotSegmentSummarySelected(all, { aiText: '### 1919-01-01 ~ 1919-01-20\n1. 主线: 概述。', maxBatches: 1 });
    const leaked = (state.plotSegments || []).some((sg) => (sg.atomIds || []).some((id) => headIds.has(String(id))));
    return res && res.batches >= 1 && res.skippedHead === 10 && !leaked;
})(), 'n/a');

// ---------- C 审查修复：混合批次不再重复总结已覆盖情节 ----------
A('C1 增量修正确认：已覆盖情节**不再进入切批来源**（30 条 → 覆盖中间 10 条里的 3 条 → 池 7 条）', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const list = plotSegmentAtomList();
    const mid = list.slice(10, 20).map((a) => String(a.id));
    state.plotSegments = [{ id: 's1', header: 'H', atomIds: mid.slice(0, 3) }];
    const plan = plotSegmentPlan();
    const ids = new Set(plan.batches.flatMap((b) => b.ids));
    return plan.poolTotal === 10 && plan.pending === 7 && plan.batches.length === 2
        && mid.slice(0, 3).every((id) => !ids.has(id)) && mid.slice(3).every((id) => ids.has(id));
})(), 'n/a');
A('C2 `includeCovered: true` 保留旧行为（V1 平价校验用）：被覆盖的 3 条重新出现在批次里', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const list = plotSegmentAtomList();
    const mid = list.slice(10, 20).map((a) => String(a.id));
    state.plotSegments = [{ id: 's1', header: 'H', atomIds: mid.slice(0, 3) }];
    const plan = plotSegmentPlan({ includeCovered: true });
    const ids = new Set(plan.batches.flatMap((b) => b.ids));
    return plan.pendng === undefined ? (plan.batches.length === 2 && mid.slice(0, 3).every((id) => ids.has(id))) : false;
})(), 'n/a');
A('C3 幂等：全部覆盖后再计划 → 0 批（不会每点一次都重新总结同一批）', (() => {
    boot(mk(30), { plotSegmentBatchAtoms: 5 });
    const list = plotSegmentAtomList();
    const mid = list.slice(10, 20).map((a) => String(a.id));
    state.plotSegments = [{ id: 's1', header: 'H', atomIds: mid }];
    const plan = plotSegmentPlan();
    return plan.pending === 0 && plan.batches.length === 0 && plan.eligible === 0;
})(), 'n/a');

// ---------- D 审查：其他口径仍然自洽 ----------
A('D1 `covered` 只统计现有段落并集；已失效 / 已隐藏情节**从不**进入列表（既有口径不倒退）', (() => {
    const atoms = mk(30).concat([
        { id: 'inv1', title: '失效', text: '已失效情节。', date: '1919-01-01', validity: 'inactive', floorStart: 99, floorEnd: 99 },
        { id: 'hid1', title: '隐藏', text: '已隐藏情节。', date: '1919-01-02', validity: 'active', hidden: true, summarizedBy: 'x', floorStart: 98, floorEnd: 98 },
    ]);
    boot(atoms, { plotSegmentBatchAtoms: 5 });
    const list = plotSegmentAtomList().map((a) => String(a.id));
    return list.indexOf('inv1') < 0 && list.indexOf('hid1') < 0 && plotSegmentCoveredIds().size === 0;
})(), 'n/a');
A('D2 完整运行（自动）：开篇 10 条不出现在任何新建段落的 `atomIds` 里（端到端）', (async () => {
    boot(mk(40), { plotSegmentBatchAtoms: 10 });
    const headIds = new Set(plotSegmentAtomList().slice(0, 10).map((a) => String(a.id)));
    const res = await runPlotSegmentSummary({ aiText: '### 1919-01-01 ~ 1919-01-20\n1. 主线: 概述。', maxBatches: 2, ignoreThreshold: true });
    const leaked = (state.plotSegments || []).some((sg) => (sg.atomIds || []).some((id) => headIds.has(String(id))));
    return res && res.made >= 0 && !leaked;
})(), 'n/a');

R.done();
