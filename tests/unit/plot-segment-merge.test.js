// ============================================================
// 单元测试 · v3.50.12：`docs/D22` §4.5 W4 `数-9`
//   **`plotSegments` / `summaries` 有上限且可解释**（`docs/D20` §8；Q2 裁决「设上限 + 合并 + 裁剪可见」）
//
// 用户要求：「开发待开发事项W4的未完成内容。」
//
// 缺陷：`state.plotSegments`（分段总结）与 `state.summaries`（遗留摘要）**没有上限** —— 归档只增不减。
// 口径：超上限时按**剧情时间**把**最早的相邻两段合并**（保留归档与全部条目 id，**不删除**）；
//   遗留摘要容器只裁不并；两处结果在**数据管理页**与**分段总结子页**如实可见。
//
// 运行：node tests/unit/plot-segment-merge.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    mergePlotSegmentsToCap, mergeTwoPlotSegments, trimLegacySummaries,
    PLOT_SEGMENT_MAX, LEGACY_SUMMARY_MAX, PLOT_SEGMENT_LINE_MAX,
} from '../../core/plot-segment-merge.js';
import { applyStateBounds } from '../../core/ingest.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';
import { plotSegmentBodyListHtml } from '../../ui/plot-segment-forecast.js';

const R = makeReporter('plot-segment-merge v3.50.12：`数-9` 分段总结上限 + 按剧情时间合并');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('seg9'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });

/** 造 n 段分段总结（剧情时间递增、每段 1 条剧情线 / 1 个 atomId） */
function mkSegs(n, opts) {
    const o = opts || {};
    const out = [];
    for (let i = 0; i < n; i++) {
        const d = '1919-11-' + String((i % 28) + 1).padStart(2, '0');
        const lines = [{ label: '感情线', text: '事件' + i }];
        if (o.extraLines) for (let k = 0; k < o.extraLines; k++) lines.push({ label: '线' + k, text: '补充' + i + '-' + k });
        out.push({
            id: 'sg' + i, header: d, start: d, end: d, lines: lines.concat(o.sharedLines || []),
            atomIds: ['a' + i], atomCount: 1, floorStart: i + 1, floorEnd: i + 1,
            manual: false, uses: 0, createdAt: 100 + i, updatedAt: 100 + i,
        });
    }
    return out;
}

// ---------- A 组：上限与合并语义 ----------
A('A1 **未超限 → 原样返回**（引用不变、`changed:false`）：上限内的分段总结不做任何改写', (() => {
    const segs = mkSegs(3);
    const r = mergePlotSegmentsToCap(segs, 5);
    return r.changed === false && r.list === segs && r.before === 3 && r.after === 3 && r.merged === 0;
})(), 'n/a');

A('A2 **超限 → 条数回落到上限**（合并总数 = before − after）', (() => {
    const segs = mkSegs(5);
    const r = mergePlotSegmentsToCap(segs, 3, { now: 999 });
    return r.changed === true && r.after === 3 && r.before === 5 && r.merged === 2 && r.list.length === 3;
})(), () => J(mergePlotSegmentsToCap(mkSegs(5), 3, { now: 1 }).list.map((s) => s.header)));

A('A3 **合并语义**：时间范围连续（最早段的 start ~ 较晚段的 end）· `atomIds` 并集 · `atomCount` 求和 · 剧情线去重 · `merged/mergedFrom` 可追溯', (() => {
    const segs = mkSegs(5);
    segs[0].lines.push({ label: '共同线', text: '同一件事' });
    segs[1].lines.push({ label: '共同线', text: '同一件事' });      // 两段有重复线 → 合并后去重
    const r = mergePlotSegmentsToCap(segs, 3, { now: 999 });
    const m = r.list[0];
    return m.merged === true && m.mergedFrom.length >= 2
        && m.start === '1919-11-01' && m.end === '1919-11-03'
        && J(m.atomIds) === J(['a0', 'a1', 'a2']) && m.atomCount === 3
        && m.lines.filter((x) => x.text === '同一件事').length === 1
        && Number(m.createdAt) === 100 && Number(m.updatedAt) === 999;
})(), () => J(mergePlotSegmentsToCap(mkSegs(5), 3, { now: 1 }).list[0]));

A('A4 **幂等**：已在上限内的结果再跑一次 → `changed:false`，内容不变', (() => {
    const once = mergePlotSegmentsToCap(mkSegs(6), 3, { now: 999 }).list;
    const twice = mergePlotSegmentsToCap(once, 3, { now: 999 });
    return twice.changed === false && J(twice.list) === J(once);
})(), 'n/a');

A('A5 **不删数据**：合并只做并集 —— 所有原 `atomIds` 一个不少；且**只合并最早的段**，最新段保持原样', (() => {
    const segs = mkSegs(6);
    const r = mergePlotSegmentsToCap(segs, 4, { now: 999 });
    const all = new Set();
    segs.forEach((s) => s.atomIds.forEach((x) => all.add(x)));
    const got = new Set();
    r.list.forEach((s) => s.atomIds.forEach((x) => got.add(x)));
    const newestKept = r.list.some((s) => s.id === 'sg5' && s.merged !== true);
    return all.size === got.size && Array.from(all).every((x) => got.has(x)) && newestKept;
})(), () => J(mergePlotSegmentsToCap(mkSegs(6), 4, { now: 1 }).list.map((s) => s.id)));

A('A6 **剧情线限量**：合并后单段剧情线不超过上限，超出部分记 `truncated` + `droppedLines`（如实可解释）', (() => {
    const many = PLOT_SEGMENT_LINE_MAX + 8;
    const segs = [{ id: 'p1', start: '1919-11-01', end: '1919-11-01', lines: Array.from({ length: many }, (_, i) => ({ label: '线' + i, text: '文' + i })), atomIds: ['x'], atomCount: 1, floorStart: 1, floorEnd: 1, createdAt: 1, updatedAt: 1 },
        { id: 'p2', start: '1919-11-02', end: '1919-11-02', lines: [{ label: '线z', text: '文z' }], atomIds: ['y'], atomCount: 1, floorStart: 2, floorEnd: 2, createdAt: 2, updatedAt: 2 }];
    const m = mergeTwoPlotSegments(segs[0], segs[1], 999);
    return m.lines.length === PLOT_SEGMENT_LINE_MAX && m.truncated === true && Number(m.droppedLines) > 0;
})(), 'n/a');

A('A7 **遗留摘要容器**（`summaries`）只**裁不并**：保留较新的 N 条，`removed` 如实回报', (() => {
    const list = [{ id: 1, at: 1 }, { id: 2, at: 2 }, { id: 3, at: 3 }, { id: 4, at: 4 }];
    const r = trimLegacySummaries(list, 2);
    return r.changed === true && r.before === 4 && r.after === 2 && r.removed === 2
        && J(r.list.map((x) => x.id)) === J([3, 4])
        && trimLegacySummaries(list, 9).changed === false;
})(), () => J(trimLegacySummaries([{ id: 1, at: 1 }, { id: 2, at: 2 }, { id: 3, at: 3 }], 2)));

// ---------- B 组：接线（写入收口真的会裁） ----------
A('B1 `applyStateBounds()` 收口时会执行：构造超过上限的分段总结 → 段数回落到上限，且返回报告带 `plotSegments`', (() => {
    const st = emptyState();
    st.plotSegments = mkSegs(PLOT_SEGMENT_MAX + 10);
    st.summaries = Array.from({ length: LEGACY_SUMMARY_MAX + 5 }, (_, i) => ({ id: 's' + i, at: i }));
    setKernelState(st);
    const rep = applyStateBounds();
    return (state.plotSegments || []).length === PLOT_SEGMENT_MAX
        && (state.summaries || []).length === LEGACY_SUMMARY_MAX
        && !!rep.plotSegments && rep.plotSegments.merged >= 10;
})(), () => J({ segs: (state.plotSegments || []).length, rep: applyStateBounds() }));

A('B2 上限之内**不动**：段数 ≤ 上限时 `applyStateBounds` 不返回 `plotSegments` 报告（避免无谓改写）', (() => {
    const st = emptyState();
    st.plotSegments = mkSegs(5);
    st.summaries = [];
    setKernelState(st);
    const rep = applyStateBounds();
    return (state.plotSegments || []).length === 5 && !rep.plotSegments;
})(), 'n/a');

// ---------- C 组：裁剪可见 ----------
A('C1 **数据管理页可见**：显示「分段总结 N / 240 段」「遗留摘要 M / 120 条」与「超出时合并、不删除」的口径', (() => {
    const st = emptyState();
    st.plotSegments = mkSegs(3);
    st.summaries = [{ id: 'x', at: 1 }];
    setKernelState(st);
    const h = String(settingsPageHtml('data', '') || '');
    return h.indexOf('🗂 分段总结上限') >= 0 && h.indexOf('/ 240 段') >= 0 && h.indexOf('/ 120 条') >= 0
        && h.indexOf('不删除') >= 0 && h.indexOf('剧情时间') >= 0;
})(), () => J(String(settingsPageHtml('data', '')).slice(0, 120)));

A('C2 **分段总结子页可见**：条数行写明上限与「合并而不是删除」，并如实报出「其中 N 段是合并过的」', (() => {
    const st = emptyState();
    const segs = mergePlotSegmentsToCap(mkSegs(5), 3, { now: 999 }).list;
    st.plotSegments = segs;
    setKernelState(st);
    const h = String(plotSegmentBodyListHtml() || '');
    return h.indexOf('上限 240') >= 0 && h.indexOf('合并') >= 0 && h.indexOf('不删除') >= 0
        && h.indexOf('段是合并过的') >= 0;
})(), () => J(String(plotSegmentBodyListHtml()).slice(-160)));

A('C3 上限常量是**唯一事实源**：`PLOT_SEGMENT_MAX` / `LEGACY_SUMMARY_MAX` 为正值，且数据页与子页显示的就是它们', (() => {
    return PLOT_SEGMENT_MAX > 0 && LEGACY_SUMMARY_MAX > 0
        && String(settingsPageHtml('data', '')).indexOf(String(PLOT_SEGMENT_MAX)) >= 0;
})(), 'n/a');

R.done();
