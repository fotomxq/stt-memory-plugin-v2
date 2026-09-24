// ============================================================
// 单元测试 · B8-7-a 情节分段总结（打包 → AI 分段 → `### 时间范围` 归档；只增不减、不注入）
//   （与**真实 V1 插件 v1.206** 逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，经 `tests/unit/helpers.js#loadPlugin` 直调 `__FTT` 同名导出）：
//   tests/fixtures/v1-golden-plot-segment.json —— 批大小夹取、情节清单/覆盖集合、切批与两种计划、
//     提示词（自定义模板 + 默认模板回退）、同区间判定、解析/原文/归一化/回填/排序、落库（只增不减）、
//     全量运行/增量运行/空库/忙位、总结所选三态、清空与删除（墓碑 + 内容哈希）。
//   本 fixture 由 /tmp oracle 脚本当场生成，**连跑两次逐字节一致**（`Date.now` 固定为 meta.fixedNow）。
// 覆盖：
//   plotSegmentBatchSize / plotSegmentAtomList / plotSegmentCoveredIds / plotSegmentBatchesFrom /
//   plotSegmentPlan / plotSegmentPlanForIds / buildPlotSegmentPrompt / plotSegmentSameRange /
//   applyPlotSegmentResult / runPlotSegmentSummary / runPlotSegmentSummarySelected /
//   clearPlotSegments / deletePlotSegment / flattenPlotSegment；
//   另含 V2 编排与接线：FTT.* 入口、情节页「🧩 分段总结」子页（子标签 / 生成 / 手动补一段 / 清理分段）
//   与动作分支（summary=plotSegments / plotSegmentSummarySel / clearPlotSegments）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { normalizePlotSegment, parsePlotSegmentText, plotSegmentsToText, plotSegmentTimeKey, sortPlotSegments } from '../../core/model/segment.js';
import {
    plotSegmentBatchSize, plotSegmentAtomList, plotSegmentCoveredIds, plotSegmentBatchesFrom,
    plotSegmentPlan, plotSegmentPlanForIds, buildPlotSegmentPrompt, plotSegmentSameRange,
    applyPlotSegmentResult, runPlotSegmentSummary, runPlotSegmentSummarySelected,
    clearPlotSegments, deletePlotSegment, flattenPlotSegment,
} from '../../core/plot-segment.js';
import { panelAction, panelBodyHtml, atomSubState, setAtomSub } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-plot-segment.json'), 'utf8'));
const NOW = G.meta.fixedNow;
const R = makeReporter('plot-segment-golden B8-7-a 情节分段总结（V1 对齐）');
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
function deq(a, b) {
    const ja = a === undefined ? undefined : JSON.parse(JSON.stringify(a));
    const jb = b === undefined ? undefined : JSON.parse(JSON.stringify(b));
    const eq = (x, y) => {
        if (x === y) return true;
        if (x === null || y === null || x === undefined || y === undefined) return x === y;
        if (typeof x !== typeof y) return false;
        if (Array.isArray(x) !== Array.isArray(y)) return false;
        if (typeof x !== 'object') return x === y;
        if (Array.isArray(x)) return x.length === y.length && x.every((v, i) => eq(v, y[i]));
        const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
        if (kx.length !== ky.length) return false;
        return kx.every((k, i) => k === ky[i] && eq(x[k], y[k]));
    };
    return eq(ja, jb);
}
async function withFixedNow(fn) {
    const real = Date.now;
    Date.now = () => NOW;
    try { return await fn(); } finally { Date.now = real; }
}
let aiCalls = 0, aiContent = '', busyFlag = false, toasts = [], timers = [];
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined });
    aiCalls = 0; aiContent = ''; busyFlag = false;
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiContent }; }, feedText: () => '', busy: () => busyFlag });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
const seedAtoms = () => ([
    { id: 'p1', title: 'P1', text: '甲在码头搬运货物。', date: '1919-11-29', validity: 'active', tags: ['甲'], floorStart: 1, floorEnd: 1 },
    { id: 'p2', title: '', text: '乙在仓库清点。', date: '1919-11-30', validity: 'active', tags: ['乙'], floorStart: 2, floorEnd: 2 },
    { id: 'p3', title: 'P3', text: '', date: '1919-12-01', validity: 'active', tags: [], floorStart: 3, floorEnd: 3 },
    { id: 'p4', title: 'P4', text: '丙在城外等待。', date: '', validity: 'active', tags: [], floorStart: 4, floorEnd: 4 },
    { id: 'p5', title: 'P5', text: '丁已失效。', date: '1919-12-02', validity: 'inactive', tags: [], floorStart: 5, floorEnd: 5 },
    { id: 'p6', title: 'P6', text: '戊已隐藏。', date: '1919-12-03', validity: 'active', hidden: true, summarizedBy: 's1', tags: [], floorStart: 6, floorEnd: 6 },
    { id: 'p7', title: 'P7', text: '己也在码头。', date: '1919-11-28', validity: 'active', tags: [], floorStart: 7, floorEnd: 7 },
]);
const SAMPLE = [
    '### 1899-03-01 ~ 1899-04-10',
    '1. 感情线: 角色甲与角色乙在码头定下婚约，交合一事未外传。',
    '2. 商业线: 角色甲卖掉旧船板得 50 银元。',
    '',
    '### 1899-04-11 ~ 1899-05-12',
    '1. 学术线: 角色丙抄录 3 卷古籍，得出 2 条结论。',
].join('\n');
const segView = (s) => ({
    id: s.id, header: s.header, start: s.start, end: s.end, lines: s.lines, raw: s.raw,
    atomIds: s.atomIds, atomCount: s.atomCount, floorStart: s.floorStart, floorEnd: s.floorEnd,
    manual: s.manual === true, uses: s.uses, createdAt: s.createdAt, updatedAt: s.updatedAt,
});
const segsView = () => (state.plotSegments || []).map(segView);
const tombs = (dim) => Object.keys(((state.deleted || {})[dim]) || {}).sort();
const promptView = (p) => (p === null ? null : p.map(m => ({ role: m.role, content: m.content })));
const F = G.plotSegment;

// ============================================================
// P 组：与 V1 逐项比对（黄金样本）
// ============================================================
await A('P1 批大小 plotSegmentBatchSize：默认 30 / 非正与非有限回落 30 / 四舍五入 / 上限 200，与 V1 逐值一致', async () => {
    boot();
    const mine = {};
    for (const v of [undefined, 0, -5, 500, 12.6, 30, 200, 201, 'x']) {
        if (v === undefined) delete cfg.plotSegmentBatchAtoms; else cfg.plotSegmentBatchAtoms = v;
        mine[String(v)] = plotSegmentBatchSize();
    }
    delete cfg.plotSegmentBatchAtoms;
    return deq(mine, F.batchSize);
}, '');

await A('P2 情节清单与覆盖集合：plotSegmentAtomList（已失效/空正文标题/已隐藏排除 + 剧情时间正序）+ plotSegmentCoveredIds（并集去空）', async () => {
    boot({ atoms: seedAtoms() });
    const list = plotSegmentAtomList();
    state.plotSegments = [{ id: 's1', header: 'A', atomIds: ['p1', 'p2', ''] }, { id: 's2', header: 'B', atomIds: ['p2', 'p3'] }];
    const mine = { atomList: { ids: list.map(x => x.id), total: list.length }, coveredIds: Array.from(plotSegmentCoveredIds()).sort() };
    return deq(mine, { atomList: F.atomList, coveredIds: F.coveredIds });
}, '');

await A('P3 切批 plotSegmentBatchesFrom：每批 ids/日期起止/楼层起止（含「日期未知」批次 dateStart=空串），与 V1 逐字段一致', async () => {
    boot({ atoms: seedAtoms() });
    const list = plotSegmentAtomList();
    const batches = plotSegmentBatchesFrom(list, 3);
    return deq(batches.map(b => ({ ids: b.ids, dateStart: b.dateStart, dateEnd: b.dateEnd, floorStart: b.floorStart, floorEnd: b.floorEnd })), F.batchesFrom);
}, '');

await A('P4 计划 plotSegmentPlan：批次 index / 增量覆盖标记（整批全被覆盖才为 true）+ total / covered，与 V1 一致', async () => {
    boot({ atoms: seedAtoms() });
    state.plotSegments = [];
    cfg.plotSegmentBatchAtoms = 3;
    const p0 = plotSegmentPlan();
    const mine0 = { total: p0.total, covered: p0.covered, batches: p0.batches.map(b => ({ index: b.index, ids: b.ids, dateStart: b.dateStart, dateEnd: b.dateEnd, floorStart: b.floorStart, floorEnd: b.floorEnd, covered: b.covered })) };
    state.plotSegments = [{ id: 's1', header: 'A', atomIds: ['p7', 'p1', 'p2'] }];
    const p1 = plotSegmentPlan();
    const mine1 = { total: p1.total, covered: p1.covered, batches: p1.batches.map(b => ({ index: b.index, ids: b.ids, covered: b.covered })) };
    return deq({ plan: mine0, planCovered: mine1 }, { plan: F.plan, planCovered: F.planCovered });
}, '');

await A('P5 勾选计划 plotSegmentPlanForIds：只取勾选且有效的 id、按剧情时间切批、covered 恒 false；空勾选 → 空计划', async () => {
    boot({ atoms: seedAtoms() });
    cfg.plotSegmentBatchAtoms = 3;      // 与 oracle 同配置（该块在切批块之后，批大小仍是 3）
    const p = plotSegmentPlanForIds(['p1', 'p2', 'p3', 'p4', 'nope']);
    const mine = {
        planForIds: { total: p.total, selected: p.selected, batches: p.batches.map(b => ({ index: b.index, ids: b.ids, dateStart: b.dateStart, dateEnd: b.dateEnd, floorStart: b.floorStart, floorEnd: b.floorEnd, covered: b.covered })) },
        planForIdsEmpty: (() => { const q = plotSegmentPlanForIds([]); return { total: q.total, selected: q.selected, batches: q.batches.length }; })(),
    };
    return deq(mine, { planForIds: F.planForIds, planForIdsEmpty: F.planForIdsEmpty });
}, '');

await A('P6 提示词 buildPlotSegmentPrompt：自定义模板优先 / 删模板回退默认模板；system+user 逐字符（含「第 undefined 批」怪癖）', async () => {
    cfg.plotSegmentBatchAtoms = 30;
    boot({ atoms: seedAtoms() });
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { plotSegment: '（测试用分段总结模板）\n只输出段落。' });
    const b1 = plotSegmentBatchesFrom(plotSegmentAtomList(), 30)[0];
    const p1 = promptView(buildPlotSegmentPrompt(b1));
    const pNull = promptView(buildPlotSegmentPrompt({}));
    delete cfg.promptTemplates.plotSegment;
    const b2 = plotSegmentBatchesFrom(plotSegmentAtomList(), 30)[0];
    const p2 = promptView(buildPlotSegmentPrompt(b2));
    return deq({ prompt: p1, promptNull: pNull, promptDefault: p2 }, { prompt: F.prompt, promptNull: F.promptNull, promptDefault: F.promptDefault });
}, '');

await A('P7 同区间判定 plotSegmentSameRange：规范化头相同 / 区间重叠 ≥50% / 不相交 / 空头 / null，与 V1 逐值一致', async () => {
    boot();
    const mine = {
        sameHeader: plotSegmentSameRange({ header: '1899-03-01 ~ 1899-04-10', start: '1899-03-01', end: '1899-04-10' }, { header: '1899/03/01-1899/04/10', start: '1899-03-05', end: '1899-04-01' }),
        overlap50: plotSegmentSameRange({ header: 'A', start: '1899-03-01', end: '1899-03-10' }, { header: 'B', start: '1899-03-06', end: '1899-03-20' }),
        noOverlap: plotSegmentSameRange({ header: 'A', start: '1899-03-01', end: '1899-03-10' }, { header: 'B', start: '1900-01-01', end: '1900-02-01' }),
        emptyHeaders: plotSegmentSameRange({ header: '', start: '', end: '' }, { header: '', start: '', end: '' }),
        oneEmpty: plotSegmentSameRange({ header: 'A', start: '', end: '' }, { header: 'A', start: '', end: '' }),
        tinyOverlap: plotSegmentSameRange({ header: 'A', start: '1899-03-01', end: '1899-03-10' }, { header: 'B', start: '1899-03-09', end: '1900-01-01' }),
        nulls: plotSegmentSameRange(null, null),
    };
    return deq(mine, F.sameRange);
}, '');

await A('P8 解析 / 原文 / 归一化 / 回填：parsePlotSegmentText → 段对象、plotSegmentsToText 往返、normalizePlotSegment（剥 `###`、id 哈希）、flattenPlotSegment 回填', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        const parsed = parsePlotSegmentText(SAMPLE);
        const mine = {
            parse: parsed.map(segView),
            toText: plotSegmentsToText(parsed),
            normalize: segView(normalizePlotSegment({ header: '### 1899-03-01 ~ 1899-04-10', lines: ['感情线: 甲与乙定亲', '- **商业线**：卖船板'], manual: true })),
            flatten: flattenPlotSegment(parsed[0]),
        };
        ok = deq(mine, { parse: F.parse, toText: F.toText, normalize: F.normalize, flatten: F.flatten });
    });
    return ok;
}, '');

await A('P9 排序：plotSegmentTimeKey 键 + desc/asc/default 三态（无日期的段无论升降序都排在最后）', async () => {
    boot();
    const trio = [
        { id: 'x1', header: '未标注', start: '', end: '', updatedAt: 300 },
        { id: 'x2', header: 'c', start: '1899-04-11', end: '1899-05-12', updatedAt: 100 },
        { id: 'x3', header: 'a', start: '1899-03-01', end: '1899-04-10', updatedAt: 200 },
    ];
    const mine = {
        keys: trio.map(seg => plotSegmentTimeKey(seg)),
        desc: sortPlotSegments(trio, 'desc').map(s => s.id),
        asc: sortPlotSegments(trio, 'asc').map(s => s.id),
        def: sortPlotSegments(trio, 'default').map(s => s.id),
        noMode: sortPlotSegments(trio).map(s => s.id),
        empty: sortPlotSegments(null).length,
    };
    return deq(mine, F.sort);
}, '');

await A('P10 落库 applyPlotSegmentResult：新增（记录 atomIds/楼层）+ 同头/重叠跳过 + 空段忽略 + 关闭保护时只覆盖正文，与 V1 逐字段一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentProtectManual = true;
        const batchA = plotSegmentBatchesFrom([state.atoms[0], state.atoms[1]], 30)[0];
        const segsA = parsePlotSegmentText(SAMPLE);
        const add = applyPlotSegmentResult(batchA, segsA);
        const dup = applyPlotSegmentResult(batchA, segsA);
        const overlap = applyPlotSegmentResult(batchA, [normalizePlotSegment({ header: '1899-03-02 ~ 1899-04-05', lines: ['感情线: 另一个区间'] })]);
        const empty = applyPlotSegmentResult(batchA, [normalizePlotSegment({ header: 'X', lines: [] }), null]);
        const mine = { add: add, dup: dup, overlap: overlap, empty: empty, segments: segsView() };
        ok = deq(mine, F.apply);
        cfg.plotSegmentProtectManual = false;
        const rw = applyPlotSegmentResult(batchA, [normalizePlotSegment({ header: '1899-03-02 ~ 1899-04-05', lines: ['感情线: 改写后的区间'] })]);
        const mine2 = { r: rw, segments: segsView() };
        ok = ok && deq(mine2, F.applyRewrite);
        cfg.plotSegmentProtectManual = true;
    });
    return ok;
}, '');

await A('P11 全量运行 runPlotSegmentSummary：按批调 AI（2 批 2 次）→ 新增 2 段、同区间跳过 2 段，提示文案与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentBatchAtoms = 3;
        aiContent = SAMPLE;
        const res = await runPlotSegmentSummary({});
        const mine = { res: res, calls: aiCalls, segments: segsView(), toasts: clone(toasts) };
        ok = deq(mine, F.runAll);
    });
    return ok;
}, '');

await A('P12 增量运行 / 空库 / 忙位：plotSegmentIncremental 只跑未覆盖批、空库零 AI、忙位如实 blocked，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentBatchAtoms = 3;
        aiContent = SAMPLE;
        await runPlotSegmentSummary({});
        cfg.plotSegmentIncremental = true;
        aiCalls = 0; toasts = [];
        const inc = await runPlotSegmentSummary({});
        cfg.plotSegmentIncremental = false;
        const mineInc = { res: inc, calls: aiCalls, toasts: clone(toasts) };
        ok = deq(mineInc, F.runIncremental);
        boot({ atoms: [] });
        aiCalls = 0; toasts = [];
        const empty = await runPlotSegmentSummary({});
        ok = ok && deq({ res: empty, calls: aiCalls, toasts: clone(toasts) }, F.runEmpty);
        boot({ atoms: seedAtoms() });
        busyFlag = true;
        aiCalls = 0; toasts = [];
        const busy = await runPlotSegmentSummary({});
        busyFlag = false;
        ok = ok && deq({ res: busy, calls: aiCalls, toasts: clone(toasts) }, F.runBusy);
    });
    return ok;
}, '');

await A('P13 总结所选 runPlotSegmentSummarySelected：只处理勾选的有效情节（4 勾 1 无效 → 3 条 2 批）+ 空勾选 / 全失效，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentBatchAtoms = 2;
        aiContent = SAMPLE;
        aiCalls = 0; toasts = [];
        const sel = await runPlotSegmentSummarySelected(['p1', 'p2', 'p3', 'nope']);
        const mine = { res: sel, calls: aiCalls, segments: segsView(), toasts: clone(toasts) };
        ok = deq(mine, F.runSelected);
        aiCalls = 0; toasts = [];
        const e1 = await runPlotSegmentSummarySelected([]);
        const mine2 = { res: e1, calls: aiCalls, toasts: clone(toasts) };
        ok = ok && deq(mine2, F.runSelectedEmpty);
        const e2 = await runPlotSegmentSummarySelected(['gone1', 'gone2']);
        ok = ok && deq({ res: e2, calls: aiCalls }, F.runSelectedGone);
    });
    return ok;
}, '');

await A('P14 清空与删除：clearPlotSegments / deletePlotSegment 都留 id + 内容哈希墓碑（跨端不复活）且提示文案与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        // 清空
        boot({ atoms: seedAtoms() });
        const segsA = parsePlotSegmentText(SAMPLE);
        state.plotSegments = segsA.map(s => clone(s));
        const t0 = tombs('plotSegments');
        const cleared = clearPlotSegments();
        const mine = { ret: cleared, segments: state.plotSegments.length, tombsBefore: t0, tombsAfter: tombs('plotSegments'), hashes: Object.keys(((state.deletedH || {}).plotSegments) || {}).length };
        ok = deq(mine, F.clear);
        // 单删
        boot({ atoms: seedAtoms() });
        state.plotSegments = segsA.map(s => clone(s));
        toasts = [];
        const del1 = deletePlotSegment(String(state.plotSegments[0].id));
        const del2 = deletePlotSegment('nope');
        const mine2 = { del1: del1, del2: del2, segments: state.plotSegments.length, tombs: tombs('plotSegments'), toasts: clone(toasts) };
        ok = ok && deq(mine2, F.del);
    });
    return ok;
}, '');

// ============================================================
// U 组：V2 编排 / 接线
// ============================================================
await A('U1 FTT.* 入口齐备（分段总结 14 项 + 子标签状态），且无 hook 时按约定降级不抛错', async () => {
    boot({ atoms: seedAtoms() });
    installDevtools({
        plotSegmentAtomList: () => plotSegmentAtomList(),
        plotSegmentBatchesFrom: (list, size) => plotSegmentBatchesFrom(list, size),
        parsePlotSegmentText: (text) => parsePlotSegmentText(text),
        applyPlotSegmentResult: (batch, segsIn) => applyPlotSegmentResult(batch, segsIn),
        plotSegmentPlan: () => plotSegmentPlan(),
        plotSegmentBatchSize: () => plotSegmentBatchSize(),
        runPlotSegmentSummary: (o) => runPlotSegmentSummary(o || {}),
        runPlotSegmentSummarySelected: (ids, o) => runPlotSegmentSummarySelected(ids, o || {}),
        clearPlotSegments: () => clearPlotSegments(),
        deletePlotSegment: (id) => deletePlotSegment(id),
    });
    const Ft = globalThis.FTT;
    const names = ['plotSegmentBatchSize', 'plotSegmentAtomList', 'plotSegmentCoveredIds', 'plotSegmentBatchesFrom',
        'plotSegmentPlan', 'plotSegmentPlanForIds', 'buildPlotSegmentPrompt', 'plotSegmentSameRange',
        'applyPlotSegmentResult', 'runPlotSegmentSummary', 'runPlotSegmentSummarySelected',
        'clearPlotSegments', 'deletePlotSegment', 'flattenPlotSegment', 'plotSegmentId', 'parsePlotSegmentText',
        'plotSegmentsToText', 'sortPlotSegments', 'atomSubState', 'setAtomSub'];
    const missing = names.filter((n) => typeof Ft[n] !== 'function');
    const plan = Ft.plotSegmentPlan();
    const seg = Ft.plotSegmentBatchesFrom(Ft.plotSegmentAtomList(), 3)[0];
    const applied = Ft.applyPlotSegmentResult(seg, Ft.parsePlotSegmentText(SAMPLE));
    const cleared = Ft.clearPlotSegments();
    uninstallDevtools();
    return missing.length === 0 && plan.total === 5 && applied.added === 2 && cleared === 2 && globalThis.FTT === undefined;
}, '');

await A('U2 面板情节页「🧩 分段总结」子页：子标签（含计数）、生成/手动补一段、清理分段（仅有段时显隐）——文案与 title 逐字一致', async () => {
    boot({ atoms: seedAtoms() });
    state.plotSegments = [];
    setAtomSub('segments');
    let h = String(panelBodyHtml('atoms') || '');
    const tabsOk = h.indexOf('data-ftt-asub="list"') >= 0 && h.indexOf('📜 情节列表（7）') >= 0
        && h.indexOf('data-ftt-asub="segments"') >= 0 && h.indexOf('🧩 分段总结（0）') >= 0
        && h.indexOf('分段总结只归档、不注入 —— 唯一消失途径是手动删除') >= 0;
    const emptyOk = h.indexOf('data-ftt-action="summary" data-ftt-summary="plotSegments"') >= 0
        && h.indexOf('title="把情节按时间打包交 AI 拆成多段总结（言简意赅、只陈述事实与数据）"') >= 0
        && h.indexOf('🧩 生成分段总结') >= 0
        && h.indexOf('data-ftt-action="addEntry" data-kind="plotSegments"') >= 0
        && h.indexOf('data-ftt-action="clearPlotSegments"') < 0
        && h.indexOf('暂无分段总结') >= 0;
    // 有段 → 清理按钮出现 + 段落行（### 头 / 剧情线 / 编辑删除）
    state.plotSegments = parsePlotSegmentText(SAMPLE).map(s => clone(s));
    h = String(panelBodyHtml('atoms') || '');
    const segsOk = h.indexOf('data-ftt-action="clearPlotSegments"') >= 0
        && h.indexOf('title="清空全部分段总结（不弹确认）"') >= 0 && h.indexOf('🧹 清理分段') >= 0
        && h.indexOf('### 1899-03-01 ~ 1899-04-10') >= 0 && h.indexOf('感情线') >= 0
        && h.indexOf('data-ftt-action="edit" data-kind="plotSegments"') >= 0
        && h.indexOf('data-ftt-action="delete" data-kind="plotSegments"') >= 0
        && h.indexOf('只归档') >= 0;
    setAtomSub('list');
    const listOk = String(panelBodyHtml('atoms') || '').indexOf('data-ftt-asub="segments"') >= 0
        && atomSubState() === 'list' && setAtomSub('nope') === 'list';
    return tabsOk && emptyOk && segsOk && listOk;
}, '');

await A('U3 面板动作：summary=plotSegments（AI 桩 2 批 → 新增 2 段）+ plotSegmentSummarySel（勾选归档）+ clearPlotSegments（清空），提示写 r.state.note', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentBatchAtoms = 3;
        aiContent = SAMPLE;
        const r1 = await panelAction('summary', { summary: 'plotSegments' });
        const note1 = String((r1.state || {}).note || '');
        const ok1 = r1.ok === true && state.plotSegments.length === 2 && note1.indexOf('新增 2 段') >= 0;
        // 多选归档：勾选 p1..p3
        boot({ atoms: seedAtoms() });
        state.plotSegments = [];
        cfg.plotSegmentBatchAtoms = 2;
        aiContent = SAMPLE;
        await panelAction('multiToggle', { kind: 'atoms' });
        await panelAction('selectAll', { kind: 'atoms' });
        const r2 = await panelAction('plotSegmentSummarySel', {});
        const note2 = String((r2.state || {}).note || '');
        const ok2 = state.plotSegments.length === 2 && note2.indexOf('新增 2 段') >= 0 && note2.indexOf('分段总结') >= 0;
        // 清理
        const r3 = await panelAction('clearPlotSegments', {});
        const note3 = String((r3.state || {}).note || '');
        const ok3 = state.plotSegments.length === 0 && note3.indexOf('已清理 2 段') >= 0 && tombs('plotSegments').length === 2;
        ok = ok1 && ok2 && ok3;
    });
    return ok;
}, '');

un();
R.done();
