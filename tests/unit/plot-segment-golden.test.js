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
    plotSegmentMaxChars, plotSegmentMaxBatchesDefault, plotSegmentLineText, plotSegmentLineCost,
    plotSegmentBusy, plotSegmentLogList, plotSegmentReserveRecent,
    applyPlotSegmentResult, runPlotSegmentSummary, runPlotSegmentSummarySelected,
    clearPlotSegments, deletePlotSegment, flattenPlotSegment,
} from '../../core/plot-segment.js';
import { panelAction, panelBodyHtml, atomSubState, setAtomSub } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';
// v3.50.4：另一个总结入口（半自动情节总结）—— 用于锁定「保留窗口强制 ≥10」与「两个入口禁止并行」
import { runAtomCompact, atomCompactPlan, atomCompactBusy } from '../../core/atom-compact.js';

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
/**
 * v3.49.3（**有意偏离 V1** 的第二处）：`applyPlotSegmentResult` 命中「同时间范围」时，现在会把本批
 *   `atomIds` **并入**已有段（修「增量模式永不收敛」——实测第 2 批因区间重名而只记 dup，其 ids 从未登记，
 *   于是每次点击都重复提交同一批）。并入会改动 `atomIds / atomCount / floorStart / floorEnd / updatedAt`。
 *   故 V1 平价投影（P11/P12/P13）**排除这 5 个字段**；它们的新口径由 **Q5** 单独锁定。
 */
/** 把并集所改的 5 个字段从**黄金样本侧**剥掉（两侧同口径，才是 V1 平价） */
/** v3.50.3：返回体新增 `pending` / `threshold` / `skippedSubmitted`（V1 无）→ V1 平价投影里剥掉（R 组另行锁定这些读数） */
const v1StripRes = (v) => {
    const o = clone(v);
    if (o && o.res && typeof o.res === 'object') {
        delete o.res.pending; delete o.res.threshold; delete o.res.skippedSubmitted;
    }
    return o;
};
const v1StripUnion = (v) => {
    const o = clone(v);
    if (Array.isArray(o && o.segments)) {
        o.segments = o.segments.map((s) => {
            const x = Object.assign({}, s);
            for (const k of ['atomIds', 'atomCount', 'floorStart', 'floorEnd', 'updatedAt']) delete x[k];
            return x;
        });
    }
    return o;
};
const segViewV1 = (s) => ({
    id: s.id, header: s.header, start: s.start, end: s.end, lines: s.lines, raw: s.raw,
    manual: s.manual === true, uses: s.uses, createdAt: s.createdAt,
});
const segsViewV1 = () => (state.plotSegments || []).map(segViewV1);
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
    const p0 = plotSegmentPlan({ reserveN: 0 });   // v3.50.4：本档验证 V1 平价，显式关掉保留窗口
    const mine0 = { total: p0.total, covered: p0.covered, batches: p0.batches.map(b => ({ index: b.index, ids: b.ids, dateStart: b.dateStart, dateEnd: b.dateEnd, floorStart: b.floorStart, floorEnd: b.floorEnd, covered: b.covered })) };
    state.plotSegments = [{ id: 's1', header: 'A', atomIds: ['p7', 'p1', 'p2'] }];
    const p1 = plotSegmentPlan({ reserveN: 0 });
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
        // v3.49.3：本档校验 **V1 平价**（一次跑完全部批次）—— 新口径默认「一次一批」是**有意偏离**，
        //   故此处显式放开批数上限；新口径本身由 Q 组覆盖。
        const res = await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });   // v3.50.3：本档验证 V1 平价，显式越过「未总结 ≥ 每批条数」门槛
        const mine = { res: res, calls: aiCalls, segments: segsViewV1(), toasts: clone(toasts) };
        ok = deq(v1StripRes(mine), v1StripUnion(F.runAll));
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
        await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });
        cfg.plotSegmentIncremental = true;
        aiCalls = 0; toasts = [];
        const inc = await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });
        cfg.plotSegmentIncremental = false;
        const mineInc = { res: inc, calls: aiCalls, toasts: clone(toasts) };
        /**
         * v3.49.3：**有意偏离 V1**（缺陷修复，见 `docs/history/P10c108`）。
         *   V1 的增量口径：第 2 批因解析出的时间范围与已有段重名 → 只记 `dup`，**其 ids 从未登记** →
         *   该批永远"未被覆盖" → **每点一次都重复提交同一批**（永不收敛）。实测黄金样本此处 `calls = 1`、
         *   `res.segments = 2`。本版把命中段的 ids **并集**起来（`applyPlotSegmentResult`），于是全部覆盖后
         *   再点 → **0 次 AI** + 「已是最新」提示。
         *   故这里对 `F.runIncremental` 做**显式改写**（只改被修复影响的 3 个字段，其余仍与 V1 逐字一致），
         *   并在 **Q5** 单独锁定"并集 + 收敛"本身。
         */
        const expectedInc = (() => {
            const g = clone(F.runIncremental);
            g.calls = 0;                                                        // V1: 1（重复提交未被覆盖的第 2 批）
            g.res = { made: 0, skipped: true, total: 5, batches: 0 };   // V1: { made:0, added:0, dup:2, empty:0, batches:1, total:5, segments:2 }（V1 无「已是最新」早退路径：它每次都要重跑一批）
            // v3.50.3：早退文案扩写为「（或未凑满一批）—— 未总结 N 条，凑满 T 条后即可继续」（本场景 T = 3）
            g.toasts = [["info", "情节分段总结：已是最新 当前 5 条情节已全部被现有段落覆盖（或未凑满一批）—— 未总结 0 条，凑满 3 条后即可继续。"]];   // v3.49.3 版文案: 「…已全部被现有段落覆盖（增量模式）。」
            return g;
        })();
        ok = deq(v1StripRes(mineInc), v1StripUnion(expectedInc));
        boot({ atoms: [] });
        aiCalls = 0; toasts = [];
        const empty = await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });
        ok = ok && deq(v1StripRes({ res: empty, calls: aiCalls, toasts: clone(toasts) }), F.runEmpty);
        boot({ atoms: seedAtoms() });
        busyFlag = true;
        aiCalls = 0; toasts = [];
        const busy = await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });
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
        const sel = await runPlotSegmentSummarySelected(['p1', 'p2', 'p3', 'nope'], { maxBatches: 40 });   // v3.49.3：V1 平价 → 显式放开批数
        const mine = { res: sel, calls: aiCalls, segments: segsViewV1(), toasts: clone(toasts) };
        ok = deq(v1StripRes(mine), v1StripUnion(F.runSelected));
        aiCalls = 0; toasts = [];
        const e1 = await runPlotSegmentSummarySelected([], { maxBatches: 40 });
        const mine2 = { res: e1, calls: aiCalls, toasts: clone(toasts) };
        ok = ok && deq(mine2, F.runSelectedEmpty);
        const e2 = await runPlotSegmentSummarySelected(['gone1', 'gone2'], { maxBatches: 40 });
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
    // ==================== Q 组（v3.49.3）：体量上界与新默认口径 ====================
await A('Q1 默认**一次点击只提交一批**（`cfg.plotSegmentMaxBatches` 默认 1）：9 条情节 / 批 3 → 共 3 批，但只发 1 次 AI；开工通知保持 V1 原文、体量预告落调试日志（待整理 9 · 共 3 批 · 本次 1 批）', async () => {
    let calls = 0, toastText = '', dbg = [];
    await withFixedNow(async () => {
        const many = [];
        for (let i = 1; i <= 9; i++) many.push({ id: 'q' + i, title: 'Q' + i, text: '第 ' + i + ' 条情节正文。', date: '1919-11-0' + ((i % 9) + 1), validity: 'active', tags: [], floorStart: i, floorEnd: i });
        boot({ atoms: many }, { plotSegmentBatchAtoms: 3 });
        setChatHooks({ dbgLog: (k, v) => dbg.push([String(k), v]) });
        aiContent = SAMPLE;
        const res = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });   // v3.50.3：本项验证"一次一批"，显式越过门槛
        calls = aiCalls;
        toastText = toasts.map((x) => x[1]).join(' ');
        return res.batches === 1 && Number(res.total) === 9;
    });
    const pre = dbg.filter((x) => x[1] && x[1]['本次提交几批'] != null)[0];
    // 开工通知保持 V1 原文（"本批 N 批"），体量预告落在调试日志：待整理 9 / 共 3 批 / 本次 1 批
    return calls === 1 && toastText.indexOf('本批 1 批') > 0
        && !!pre && pre[1]['待整理'] === 9 && pre[1]['共几批'] === 3 && pre[1]['本次提交几批'] === 1;
}, '');

await A('Q2 **字符预算切批**：`plotSegmentMaxChars` 生效——3 条各 ~300 字符时预算 500 → 每批只装 2 条（**软上界**：装到超预算为止）；`batch.chars` 如实记账；预算 0 = 关闭（回到只按条数）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        const long = (i) => ({ id: 'r' + i, title: '', text: '长'.repeat(300), date: '1919-11-0' + i, validity: 'active', tags: [], floorStart: i, floorEnd: i });
        const three = [long(1), long(2), long(3)];
        boot({ atoms: three }, { plotSegmentBatchAtoms: 30, plotSegmentMaxChars: 500 });
        const p1 = plotSegmentPlan({ reserveN: 0 });
        const byChars = p1.batches.length;
        const charsOk = p1.batches.every((b) => Number(b.chars) > 0) && Number(p1.chars) > 0;
        boot({ atoms: three }, { plotSegmentBatchAtoms: 30, plotSegmentMaxChars: 0 });
        const byCount = plotSegmentPlan({ reserveN: 0 }).batches.length;
        // 每行成本 ≈ 301 字符：预算 500 → 装 2 条后（602 ≥ 500）切批 → 2 条/批；预算 0 = 不限 → 3 条一批
        ok = byChars === 2 && charsOk && byCount === 1;
        return ok;
    });
    return ok;
}, '');

await A('Q3 **增量默认开**（`cfg.plotSegmentIncremental` 默认 true）：一次一批地推进；已覆盖的时间范围**不重复新增**（`dup`），全部覆盖后再点 → 0 次 AI', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 3 });
        aiContent = SAMPLE;
        const first = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });
        const c1 = aiCalls;
        aiCalls = 0;
        const second = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });     // 第二批（未被覆盖）→ 仍会发 1 次，但不重复已覆盖的时间范围
        const c2 = aiCalls;
        aiCalls = 0;
        await runPlotSegmentSummary({ maxBatches: 40, ignoreThreshold: true, reserveN: 0 });     // 跑完全部批次
        const allCovered = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });  // 全被覆盖 → 0 次
        ok = c1 === 1 && first.batches === 1 && c2 === 1 && second.added === 0 && second.dup === 2
            && aiCalls === 0 && allCovered.skipped === true;
        return ok;
    });
    return ok;
}, '');

await A('Q4 提交前**体量预告**：计划给出 `chars` / `batchAtoms` / `batchChars`；`Σbatch.chars` 是真实 user 段的**下界**（差值 = 批头 + 固定输出要求 < 900 字符）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 3 });
        const plan = plotSegmentPlan({ reserveN: 0 });
        const sumChars = plan.batches.reduce((s, b) => s + Number(b.chars || 0), 0);
        const sumUser = plan.batches.reduce((s, b) => {
            const prompt = buildPlotSegmentPrompt(b);
            return s + String((prompt && prompt[1] && prompt[1].content) || '').length;
        }, 0);
        // `chars` 是**行成本之和**（下界）：真实 user 段 = 行 + 批头（待整理/时间跨度）+ 【输出要求】固定段
        ok = Number(plan.chars) === sumChars && plan.batchAtoms === 3 && Number(plan.batchChars) === 8000
            && sumChars > 0 && sumUser > sumChars && (sumUser - sumChars) < 900;
        return ok;
    });
    return ok;
}, '');
await A('Q5（**只读核对发现的真缺陷**）同区间命中的段会**并入本批 ids**：增量模式从此**收敛** —— 跑完所有批次后再点 0 次 AI；段的正文/时间范围仍不被改写', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 3 });
        aiContent = SAMPLE;
        await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });                       // 第 1 批（p7/p1/p2）
        await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });                       // 第 2 批（p3/p4）——区间同名 → 只记 dup，但 ids 会并进去
        const seg = (state.plotSegments || []).filter((s) => String(s.header).indexOf('1899-03-01') >= 0)[0] || {};
        const unioned = (seg.atomIds || []).slice().sort().join(',');
        const headerBefore = String(seg.header || '');
        aiCalls = 0;
        const third = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });         // 全部已覆盖 → 0 次 AI（收敛）
        const stillSame = String((state.plotSegments || [])[0].header || '') === headerBefore;
        ok = unioned === 'p1,p2,p3,p4,p7' && Number(seg.atomCount) === 5 && aiCalls === 0
            && third.skipped === true && third.batches === 0 && stillSame;
        return ok;
    });
    return ok;
}, '');
// ==================== R 组（v3.50.3）：门槛 · 满批 · 不重叠 · 已提交去重 ====================
await A('R1 **门槛**：未总结条数 < 「每次打包给 AI 的情节条数」时**不提交**（0 次 AI），提示写明还差几条', async () => {
    let ok = false;
    await withFixedNow(async () => {
        const few = [];
        for (let i = 1; i <= 5; i++) few.push({ id: 's' + i, title: 'S' + i, text: '第 ' + i + ' 条情节正文。', date: '1919-11-0' + i, validity: 'active', tags: [], floorStart: i, floorEnd: i });
        boot({ atoms: few }, { plotSegmentBatchAtoms: 30 });
        aiContent = SAMPLE;
        const res = await runPlotSegmentSummary({ reserveN: 0 });   // v3.50.4：本项验证门槛，显式关保留窗口
        const plan = plotSegmentPlan({ reserveN: 0 });
        ok = aiCalls === 0 && res.skipped === true && res.reason === 'below-threshold'
            && Number(res.pending) === 5 && Number(res.threshold) === 30 && Number(res.need) === 25
            && plan.pending === 5 && plan.eligible === 0
            && toasts.map((x) => x[1]).join(' ').indexOf('还差 25 条') > 0;
        return ok;
    });
    return ok;
}, '');

await A('R2 **只提交满批**：31 条 / 每批 30 → 可提交 1 批（30 条），尾部那 1 条**不提交**（`plan.pending` 仍为 31，等凑满）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        const many = [];
        for (let i = 1; i <= 31; i++) many.push({ id: 'm' + i, title: 'M' + i, text: '第 ' + i + ' 条情节正文。', date: '1919-11-' + String((i % 28) + 1).padStart(2, '0'), validity: 'active', tags: [], floorStart: i, floorEnd: i });
        boot({ atoms: many }, { plotSegmentBatchAtoms: 30 });
        aiContent = SAMPLE;
        const plan = plotSegmentPlan({ reserveN: 0 });
        const full = plan.batches.filter((b) => b.full === true).length;
        const res = await runPlotSegmentSummary({ reserveN: 0 });   // v3.50.4：同上，显式关保留窗口
        ok = plan.batches.length === 2 && full === 1 && plan.eligible === 1
            && plan.pending === 31 && plan.pendingEligible === 30
            && aiCalls === 1 && res.batches === 1;
        return ok;
    });
    return ok;
}, '');

await A('R3 **执行不重叠**：在上一次提交未返回期间再点 → 被在途闸挡下（`reason:inflight`、0 次新 AI）；跑完闸自动复位', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 3 });
        aiContent = SAMPLE;
        /**
         * 用**真定时器**把第一次请求挂在在途（`boot()` 只接管了 `Date.now`，`setTimeout` 仍是真的）——
         *   这样"第一次未返回"是确定的事实，不需要靠微任务计数；第一次调用在**同步阶段**就置了在途闸。
         */
        setAiHooks({
            callAi: async () => { aiCalls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, text: aiContent }; },
            feedText: () => '', busy: () => false,
        });
        const first = runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });
        const second = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });   // 第一次还挂着 → 必须被挡
        const r1 = await first;
        const third = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });    // 闸已复位 → 可再跑（是否提交取决于覆盖 / 账本）
        ok = second.blocked === true && second.reason === 'inflight' && aiCalls === 2
            && r1.batches === 1 && plotSegmentBusy() === false && third.blocked !== true;
        return ok;
    });
    return ok;
}, '');

await A('R4 **已提交不重复提交**：同一批（同一组 id）再跑 → 走账本跳过（`skippedSubmitted`）且 0 次新 AI；清空段落后名额释放、可重新生成', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 3 });
        aiContent = '';                                     // 让 AI「空手而归」→ 批次未被覆盖，第二次点击才会撞上账本
        const first = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });
        const c1 = aiCalls;
        aiCalls = 0;
        const second = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });
        const logged = plotSegmentLogList().length;
        const blockedByLog = aiCalls === 0 && second.skippedSubmitted === 1;
        clearPlotSegments();                                // 用户显式清空 → 释放账本
        const released = plotSegmentLogList().length === 0;
        aiCalls = 0;
        const third = await runPlotSegmentSummary({ ignoreThreshold: true, reserveN: 0 });
        ok = c1 === 1 && logged === 1 && blockedByLog && released && aiCalls === 1 && third.batches === 1;
        return ok;
    });
    return ok;
}, '');

await A('R5 **所选路径不受「凑满一批」门槛限制**（用户显式勾选），但同样受在途闸与账本约束', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedAtoms() }, { plotSegmentBatchAtoms: 30 });   // 单批都不到 30 条
        aiContent = SAMPLE;
        const sel = await runPlotSegmentSummarySelected(['p1', 'p2'], { maxBatches: 40 });
        ok = aiCalls === 1 && Number(sel.total) === 2;
        aiCalls = 0;
        const again = await runPlotSegmentSummarySelected(['p1', 'p2'], { maxBatches: 40 });   // 同一批 → 账本挡下
        ok = ok && aiCalls === 0 && again.skippedSubmitted === 1;
        return ok;
    });
    return ok;
}, '');
// ==================== S 组（v3.50.4）：保留窗口（强制 ≥10）· 门槛 N+10 · 双总结入口互斥 ====================
/** 造 n 条情节（剧情时间升序：i 越小越旧） */
const mkAtoms = (n, prefix) => Array.from({ length: n }, (_, k) => ({
    id: (prefix || 'a') + k, title: 'A' + k, text: '第 ' + (k + 1) + ' 条情节正文。',
    date: '1919-' + String(Math.floor(k / 28) + 1).padStart(2, '0') + '-' + String((k % 28) + 1).padStart(2, '0'),
    validity: 'active', tags: [], floorStart: k + 1, floorEnd: k + 1,
}));

await A('S1 **保留窗口强制 ≥10**：`cfg.plotSegmentReserveRecent` 设 0 / 3 都被兜到 10；最新 10 条**不进任何批次**（`poolTotal = total − 10`）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: mkAtoms(45) }, { plotSegmentBatchAtoms: 30, plotSegmentReserveRecent: 0 });
        const zero = plotSegmentReserveRecent();
        const p0 = plotSegmentPlan();
        boot({ atoms: mkAtoms(45) }, { plotSegmentBatchAtoms: 30, plotSegmentReserveRecent: 3 });
        const three = plotSegmentReserveRecent();
        const p3 = plotSegmentPlan();
        // 最新 10 条 = id 末 10 个；断言它们不在任何批次里
        const inPoolIds = new Set(p0.batches.flatMap((b) => b.ids));
        const newest = mkAtoms(45).slice(-10).map((x) => x.id);
        ok = zero === 10 && three === 10 && p0.reserveN === 10 && p3.reserveN === 10
            && p0.poolTotal === 35 && p3.poolTotal === 35
            && newest.every((id) => !inPoolIds.has(id));
        return ok;
    });
    return ok;
}, '');

await A('S2 **门槛 = N + 10**：39 条（10 保留 + 29 池）→ 池内未总结 29 < 30 → **不提交**（0 次 AI，提示还差 1 条）；40 条 → 提交 1 批，且该批**全是池内**旧情节', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: mkAtoms(39) }, { plotSegmentBatchAtoms: 30 });
        aiContent = SAMPLE;
        const r39 = await runPlotSegmentSummary({});
        const c39 = aiCalls;
        const note39 = toasts.map((x) => x[1]).join(' ');
        boot({ atoms: mkAtoms(40) }, { plotSegmentBatchAtoms: 30 });
        aiContent = SAMPLE;
        const r40 = await runPlotSegmentSummary({});
        const pool = plotSegmentPlan();
        const batchIds = (pool.batches[0] || {}).ids || [];
        const newest = mkAtoms(40).slice(-10).map((x) => x.id);
        ok = c39 === 0 && r39.skipped === true && r39.reason === 'below-threshold' && r39.need === 1
            && note39.indexOf('还差 1 条') > 0
            && aiCalls === 1 && r40.batches === 1
            && batchIds.length === 30 && newest.every((id) => batchIds.indexOf(id) < 0);
        return ok;
    });
    return ok;
}, '');

await A('S3 **两个总结入口禁止并行**：分段总结在途时，半自动情节总结直接拒绝（`segment-inflight`、0 次 AI）；反之半自动在途时分段总结被拒（`compact-inflight`）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        // ① 分段总结在途 → 半自动被拒
        boot({ atoms: mkAtoms(40) }, { plotSegmentBatchAtoms: 30, atomCompactChars: 10, atomCompactRecent: 0 });
        aiContent = SAMPLE;
        setAiHooks({
            callAi: async () => { aiCalls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, text: aiContent }; },
            feedText: () => '', busy: () => false,
        });
        const seg = runPlotSegmentSummary({});
        const ac = await runAtomCompact({ force: true });
        const r1 = await seg;
        const a1 = ac && ac.skipped === 'segment-inflight';
        /**
         * ② 半自动在途 → 分段总结被拒。
         *   夹具要能真正**走到 AI 调用**，否则半自动会同步早退（保全 / 无组）→ 闸已复位，测不到互斥：
         *   · 参与运作条数必须 > 保全 storeMinFor('atoms')（默认 100）；
         *   · 且要能成组（同日 ≥2 条）。
         *   故造 **120 条同日情节**（v3.50.4 生产路径强制保留最新 10 条，不影响成组）。
         */
        const sameDay = Array.from({ length: 120 }, (_, k) => ({
            id: 'c' + k, title: 'C' + k, text: '第 ' + (k + 1) + ' 条情节正文。', date: '1919-11-29',
            validity: 'active', tags: [], floorStart: k + 1, floorEnd: k + 1,
        }));
        boot({ atoms: sameDay }, { plotSegmentBatchAtoms: 30, atomCompactChars: 10 });
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: 'T', 内容: 'C', 标签: [], 重要度: 0.5 }] });
        setAiHooks({
            callAi: async () => { aiCalls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, text: aiContent }; },
            feedText: () => '', busy: () => false,
        });
        const comp = runAtomCompact({ force: true });
        const seg2 = await runPlotSegmentSummary({});
        const rc = await comp;
        ok = a1 === true && r1.batches === 1 && seg2.blocked === true && seg2.reason === 'compact-inflight'
            && !!rc && rc.skipped !== 'segment-inflight'          // 半自动确实跑起来了（不是在途被拒）
            && atomCompactBusy() === false && plotSegmentBusy() === false;
        return ok;
    });
    return ok;
}, '');

await A('S4 **半自动入口的保护窗口同样强制 ≥10**：`atomCompactPlan()` 在 `atomCompactRecent = 3` 时仍报 `recentN ≥ 10`，且最新 10 条不进早期池', async () => {
    boot({ atoms: mkAtoms(40) }, { atomCompactRecent: 3 });
    const p = atomCompactPlan();
    const poolIds = new Set((p.pool || []).map((x) => x.id));
    const newest = mkAtoms(40).slice(-10).map((x) => x.id);
    return p.recentN === 10 && p.before === 40 && newest.every((id) => !poolIds.has(id));
}, () => J(atomCompactPlan().recentN));
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
    // v3.50.3 / v3.50.4：本场景可见情节 5 条，全部落在**保留窗口（最新 10 条）**内 → 池内未总结 0 条
    //   → 按钮**禁用** + 明写「未总结 5 条，需凑满 30 条一批（还差 25 条）」（title 也随之改口径，属有意变更）
    const emptyOk = h.indexOf('data-ftt-action="summary" data-ftt-summary="plotSegments"') >= 0
        // v3.50.4：默认**强制保留最新 10 条** → 本场景 5 条情节全在保留窗口内，池内未总结 0 条
        && h.indexOf('未达门槛：未总结 0 条，需凑满 30 条一批（还差 30 条）') >= 0
        && h.indexOf('保留最近 10 条') >= 0
        && h.indexOf('plotSegments" disabled') >= 0 && h.indexOf('ftt-btn-off') >= 0
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
        // v3.50.4：自动路径**强制保留最新 10 条** → 夹具要有 10 + 3 条以上，才可能有可提交的满批
        const many = seedAtoms().concat(Array.from({ length: 12 }, (_, k) => ({
            id: 'x' + k, title: 'X' + k, text: '第 ' + (k + 1) + ' 条补足情节正文。', date: '1919-12-' + String(k + 1).padStart(2, '0'),
            validity: 'active', tags: [], floorStart: 100 + k, floorEnd: 100 + k,
        })));
        boot({ atoms: many });
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
