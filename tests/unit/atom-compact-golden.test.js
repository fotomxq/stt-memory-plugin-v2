// ============================================================
// 单元测试 · B8-7-a 情节总结（半自动聚合早期情节 + 手动多选合并）
//   （与**真实 V1 插件 v1.206** 逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，经 `tests/unit/helpers.js#loadPlugin` 直调 `__FTT` 同名导出）：
//   tests/fixtures/v1-golden-atom-compact.json —— 计划/分组/体量、force 运行与幂等、五类跳过分支、
//     日→月→年粒度降级、单轮组数上限、定时调度、合并区间/提示词/解析/落库/端到端（fetch 桩喂 AI）。
//   本 fixture 由 /tmp oracle 脚本当场生成，**连跑两次逐字节一致**（`Date.now` 固定为 meta.fixedNow）。
// 覆盖：
//   atomBodyChars / atomDateGrainKey / grainStartDateStr / atomCompactPlan / atomGroupPlan /
//   buildAtomCompactPrompt / compactGrainLabel / applyCompactGroup / scheduleAtomCompact / runAtomCompact；
//   atomMergeRange / buildAtomMergePrompt / parseAtomMergeResult / atomMergeSummary / runAtomMergeSummary；
//   另含 V2 编排与接线：FTT.* 入口、面板「设定 → 提示词」页「🧷 立即聚合早期情节」按钮与动作、
//   情节页多选「🧷 情节总结」按钮（文案/title/disabled 与 V1 逐字一致）。
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
import {
    atomBodyChars, atomDateGrainKey, grainStartDateStr, atomCompactPlan, atomGroupPlan, buildAtomCompactPrompt,
    compactGrainLabel, applyCompactGroup, scheduleAtomCompact, runAtomCompact,
    atomMergeRange, buildAtomMergePrompt, parseAtomMergeResult, atomMergeSummary, runAtomMergeSummary,
} from '../../core/atom-compact.js';
import { panelAction, panelBodyHtml } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-atom-compact.json'), 'utf8'));
const NOW = G.meta.fixedNow;
const R = makeReporter('atom-compact-golden B8-7-a 情节总结（V1 对齐）');
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

/** 断言助手（thenable 防呆：必须 await 后传布尔值） */
const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
/** 键序无关深比较（两端均先 JSON 归一，与 fixture 的序列化口径一致） */
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
/** 固定 Date.now（与 oracle 同口径；块内恢复） */
async function withFixedNow(fn) {
    const real = Date.now;
    Date.now = () => NOW;
    try { return await fn(); } finally { Date.now = real; }
}

let aiCalls = 0, aiContent = '', busyFlag = false, toasts = [], timers = [], lastPrompt = null;
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    cfg.storeMinAtoms = 0;
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined });
    aiCalls = 0; aiContent = ''; busyFlag = false; lastPrompt = null;
    setAiHooks({ callAi: async (messages) => { aiCalls++; lastPrompt = messages; return { ok: true, text: aiContent }; }, feedText: () => '', busy: () => busyFlag });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
/** 情节原子（与 oracle 同构：title=id，楼层 floor-1..floor） */
const atom = (i, date, floor, text, tags) => ({
    id: i, title: i, text, date, tags: tags || ['旧'], floorStart: Math.max(1, floor - 1), floorEnd: floor, uses: 0, type: '事件',
});
const seedOld40 = () => { const o = []; for (let i = 1; i <= 40; i++) o.push(atom('old' + i, '1919-11-29', i, '旧事件甲在码头发现物品' + i, ['旧', '码头'])); return o; };
const seedRecent20 = () => { const o = []; for (let j = 1; j <= 20; j++) o.push(atom('new' + j, '1926-05-01', 500 + j, '新剧情事件内容' + j, ['新'])); return o; };

/** atoms 投影（与 oracle 同字段） */
const atomView = (a) => ({
    id: a.id, title: a.title, text: a.text, type: a.type, date: a.date, tags: a.tags || [],
    importance: a.importance, validity: a.validity, permanence: a.permanence, uses: a.uses,
    floorStart: a.floorStart, floorEnd: a.floorEnd, hidden: a.hidden === true,
    summarizedBy: a.summarizedBy === undefined ? '' : String(a.summarizedBy),
    mergedSummary: a.mergedSummary ? {
        label: a.mergedSummary.label, start: a.mergedSummary.start, end: a.mergedSummary.end,
        sourceCount: a.mergedSummary.sourceCount, by: a.mergedSummary.by === undefined ? '' : String(a.mergedSummary.by),
        grain: a.mergedSummary.grain === undefined ? '' : String(a.mergedSummary.grain),
        sourceIds: a.mergedSummary.sourceIds || [],
    } : null,
});
const sigView = () => (state.atoms || []).map(a => (a.hidden === true ? 'H' : '-') + (a.summarizedBy ? ('S(' + String(a.summarizedBy) + ')') : '-') + ':' + String(a.id));
const summaryView = () => (state.atoms || []).filter(a => /^atom_c_/.test(String(a.id || ''))).map(atomView);
const tombs = (dim) => Object.keys(((state.deleted || {})[dim]) || {}).sort();
const seed3 = () => ([
    { id: 'a1', title: '甲', text: '角色甲在码头与乙商议粮食转运的具体安排与交接时间。', date: '1919-11-29', tags: ['情感', '交易'], entities: ['角色甲', '角色乙'], locations: ['码头'], importance: 0.5, floorStart: 10, floorEnd: 12, uses: 1 },
    { id: 'a2', title: '乙', text: '两人在仓库里清点货物并记录了随后的转运去向。', date: '1919-11-30', tags: ['交易'], entities: ['角色甲'], locations: ['仓库'], importance: 0.9, floorStart: 13, floorEnd: 14, uses: 2 },
    { id: 'a3', title: '丙', text: '角色甲独自前往城外确认了下一批货物的抵港时间。', date: '1919-12-01', tags: ['行程'], entities: ['角色甲'], locations: ['城外'], importance: 0.4, floorStart: 15, floorEnd: 16, uses: 0 },
]);
const promptView = (p) => (p === null ? null : p.map(m => ({ role: m.role, content: m.content })));

// ============================================================
// H 组：与 V1 逐项比对（黄金样本）
// ============================================================
await A('H1 计划与三粒度分组：atomCompactPlan / atomGroupPlan 与 V1 逐字段一致（保护窗口 20 / 目标 20 / 早期池 40）', async () => {
    boot();
    state.atoms = seedOld40().concat(seedRecent20());
    const plan = atomCompactPlan();
    const mine = {
        plan: {
            totalChars: plan.totalChars, threshold: plan.threshold, before: plan.before, recentN: plan.recentN,
            target: plan.target, floor: plan.floor, poolLen: plan.pool.length, poolIds: plan.pool.map(x => x.id),
        },
        groups: {
            day: (() => { const g = atomGroupPlan('day'); return { keys: g.groups.map(x => x.key), sizes: g.groups.map(x => x.items.length), eligible: g.eligible, poolN: g.poolN, ratio: g.ratio }; })(),
            month: (() => { const g = atomGroupPlan('month'); return { keys: g.groups.map(x => x.key), sizes: g.groups.map(x => x.items.length), eligible: g.eligible, poolN: g.poolN, ratio: g.ratio }; })(),
            year: (() => { const g = atomGroupPlan('year'); return { keys: g.groups.map(x => x.key), sizes: g.groups.map(x => x.items.length), eligible: g.eligible, poolN: g.poolN, ratio: g.ratio }; })(),
        },
        planHidden: (() => {
            state.atoms[0].hidden = true; state.atoms[0].summarizedBy = 'x';
            const p2 = atomCompactPlan();
            state.atoms[0].hidden = false; delete state.atoms[0].summarizedBy;
            return { before: p2.before, poolLen: p2.pool.length };
        })(),
    };
    return deq(mine, { plan: G.atomCompact.plan, groups: G.atomCompact.groups, planHidden: G.atomCompact.planHidden });
}, '');

await A('H2 体量计量 atomBodyChars：九类正文主体字段逐项累加（结构深度字段不计），与 V1 同值', async () => {
    boot();
    Object.assign(state, {
        atoms: [{ id: 'b1', title: '情节标题', text: '情节正文' }],
        currentStates: [{ id: 'b2', subject: '主体', field: '字段', value: '取值' }],
        memories: [{ id: 'b3', title: '记忆标题', content: '记忆正文' }],
        items: [{ id: 'b4', name: '物品名', desc: '物品说明' }],
        plans: [{ id: 'b5', content: '计划正文' }],
        suspense: [{ id: 'b6', content: '悬念正文' }],
        scenes: [{ id: 'b7', name: '场景名', desc: '场景说明' }],
        concepts: [{ id: 'b8', name: '概念名', content: '概念正文' }],
        parallels: [{ id: 'b9', title: '平行标题', text: '平行正文' }],
        snapshots: [{ id: 'b10', name: '角色名' }],
        plotSegments: [{ id: 'b11', header: '不计入' }],
    });
    return atomBodyChars() === G.atomCompact.body;
}, '');

await A('H3 粒度键与组起点：atomDateGrainKey / grainStartDateStr / compactGrainLabel（含负年份怪癖与非法日期返回空）', async () => {
    const okKey = atomDateGrainKey('1919-11-29', 'day') === '1919-11-29'
        && atomDateGrainKey('1919-11-29', 'month') === '1919-11'
        && atomDateGrainKey('1919-11-29', 'year') === '1919'
        && atomDateGrainKey('', 'day') === '' && atomDateGrainKey('不是日期', 'month') === '';
    const okStart = grainStartDateStr('1919-11-29') === '1919-11-29'
        && grainStartDateStr('1919-11') === '1919-11-01'
        && grainStartDateStr('1919') === '1919-01-01'
        && grainStartDateStr('-0221-01-02') === ''          // V1 原样：负年份经 split('-') 后 Number('')=0 → 空串
        && grainStartDateStr('') === '';
    const okLabel = compactGrainLabel('day', '1919-11-29') === '1919-11-29'
        && compactGrainLabel('month', '1919-11') === '1919 年 11 月'
        && compactGrainLabel('year', '1919') === '1919 年'
        && compactGrainLabel('month', '1919') === '1919 月';
    return okKey && okStart && okLabel;
}, '');

await A('H4 force 运行 runAtomCompact：40 条同日情节 → 1 条总结（原文保留并隐藏、无墓碑、参与运作 60→21），与 V1 逐字段一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot();
        state.atoms = seedOld40().concat(seedRecent20());
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '十一月码头事件总结', 内容: '压缩后的顺序化过程：先在码头发现物品，后循线索追查，因果衔接保留XYZ', 标签: ['旧', '码头'], 重要度: 0.8 }] });
        aiCalls = 0;
        toasts = [];
        lastPrompt = null;
        const r = await runAtomCompact({ force: true });
        const mine = {
            calls: aiCalls,
            result: r,
            promptUser: String((lastPrompt && lastPrompt[1] && lastPrompt[1].content) || ''),
            afterRun: {
                sig: sigView(), summaries: summaryView(), active: state.atoms.filter(a => !(a.hidden === true || a.summarizedBy)).length,
                hidden: state.atoms.filter(a => a.hidden === true || a.summarizedBy).length,
                stored: state.atoms.length, tombsBefore: [], tombsAfter: tombs('atoms'), toasts: toasts.map(t => [t[0], t[1]]),
            },
        };
        const fixtureRun = {
            calls: f.run.calls, result: f.run.result, promptUser: f.run.promptUser,
            afterRun: { sig: f.afterRun.sig, summaries: f.afterRun.summaries, active: f.afterRun.active, hidden: f.afterRun.hidden, stored: f.afterRun.stored, tombsBefore: f.afterRun.tombsBefore, tombsAfter: f.afterRun.tombsAfter, toasts: f.afterRun.toasts },
        };
        ok = deq(mine, fixtureRun);
    });
    return ok;
}, '');

await A('H5 幂等：二次 force 运行 → skipped=nothing-early（总结数/隐藏数/库内条数不变），与 V1 一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot();
        state.atoms = seedOld40().concat(seedRecent20());
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '十一月码头事件总结', 内容: '压缩后的顺序化过程：先在码头发现物品，后循线索追查，因果衔接保留XYZ', 标签: ['旧', '码头'], 重要度: 0.8 }] });
        await runAtomCompact({ force: true });
        aiCalls = 0;
        const r2 = await runAtomCompact({ force: true });
        const mine = {
            calls: aiCalls, result: r2,
            active: state.atoms.filter(a => !(a.hidden === true || a.summarizedBy)).length,
            hidden: state.atoms.filter(a => a.hidden === true || a.summarizedBy).length,
            stored: state.atoms.length, summaryCount: state.atoms.filter(x => String(x.id).indexOf('atom_c_') === 0).length,
        };
        ok = deq(mine, f.runSecond);
    });
    return ok;
}, '');

await A('H6 五类跳过分支：disabled / floor（保底优先于 force）/ busy（不排队）/ below-threshold / nothing-early，与 V1 一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        // below-threshold（非 force）
        boot({ atoms: seedOld40().concat(seedRecent20()) });
        cfg.atomCompactChars = 999999;
        const rBelow = await runAtomCompact({});
        cfg.atomCompactChars = 30000;
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '十一月码头事件总结', 内容: '压缩后的顺序化过程：先在码头发现物品，后循线索追查，因果衔接保留XYZ', 标签: ['旧', '码头'], 重要度: 0.8 }] });
        const rForce = await runAtomCompact({ force: true });
        // disabled / floor / busy
        boot({ atoms: seedOld40().concat(seedRecent20()) });
        cfg.atomCompactEnabled = false;
        const rDisabled = await runAtomCompact({ force: true });
        cfg.atomCompactEnabled = true;
        cfg.storeMinAtoms = 500;
        const rFloor = await runAtomCompact({ force: true });
        cfg.storeMinAtoms = 0;
        busyFlag = true;
        const rBusy = await runAtomCompact({ force: true });
        busyFlag = false;
        ok = rBelow.skipped === 'below-threshold' && rForce.summarized === 1
            && deq({ below: rBelow, force: rForce }, f.runBelowThreshold)
            && deq({ disabled: rDisabled, floor: rFloor, busy: rBusy }, f.runSkips);
        // nothing-early
        boot({ atoms: [atom('x1', '1919-11-29', 1, '唯一情节', ['旧'])] });
        const rNothing = await runAtomCompact({ force: true });
        ok = ok && deq(rNothing, f.runNothingEarly) && timers.length === 0;
    });
    return ok;
}, '');

await A('H7 粒度降级：日占比不足 → 月聚合（2 组 → 2 条总结、4 条原文隐藏），与 V1 逐字段一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot({
            atoms: [
                atom('m1', '1919-11-01', 1, '旧事件甲在码头发现物品一', ['旧']),
                atom('m2', '1919-11-02', 2, '旧事件甲在码头发现物品二', ['旧']),
                atom('m3', '1920-01-03', 3, '旧事件甲在码头发现物品三', ['旧']),
                atom('m4', '1920-01-04', 4, '旧事件甲在码头发现物品四', ['旧']),
            ],
        }, { atomCompactRecent: 0, atomCompactChars: 50 });
        aiContent = JSON.stringify({ groups: [
            { key: '1919-11', 标题: '十一月总结', 内容: '整月事件过程总括ABC', 标签: ['旧'], 重要度: 0.7 },
            { key: '1920-01', 标题: '一月总结', 内容: '一月事件总括DEF', 标签: ['旧'], 重要度: 0.6 },
        ] });
        const r = await runAtomCompact({});
        ok = deq({ result: r, atoms: (state.atoms || []).map(atomView) }, f.runMonth);
    });
    return ok;
}, '');

await A('H8 粒度降级：月不足 → 年聚合（3 条同年情节合 1 条，1 条不同年保留），与 V1 逐字段一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot({
            atoms: [
                atom('y1', '1919-01-01', 1, '旧事件甲在码头发现物品一', ['旧']),
                atom('y2', '1919-01-03', 2, '旧事件甲在码头发现物品二', ['旧']),
                atom('y3', '1919-06-02', 3, '旧事件甲在码头发现物品三', ['旧']),
                atom('y4', '1920-03-03', 4, '旧事件甲在码头发现物品四', ['旧']),
            ],
        }, { atomCompactRecent: 0, atomCompactChars: 50 });
        aiContent = JSON.stringify({ groups: [{ key: '1919', 标题: '一九一九年总结', 内容: '全年事件过程总括GHI', 标签: ['旧'], 重要度: 0.9 }] });
        const r = await runAtomCompact({});
        ok = deq({ result: r, atoms: (state.atoms || []).map(atomView) }, f.runYear);
    });
    return ok;
}, '');

await A('H9 单轮组数上限 atomCompactBatch=1：只处理 1 组即达目标（其余原文保持可见），与 V1 逐字段一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot({
            atoms: [
                atom('c1', '1919-11-01', 1, '旧事件甲在码头发现物品一', ['旧']),
                atom('c2', '1919-11-01', 2, '旧事件甲在码头发现物品二', ['旧']),
                atom('c3', '1919-12-01', 3, '旧事件甲在码头发现物品三', ['旧']),
                atom('c4', '1919-12-01', 4, '旧事件甲在码头发现物品四', ['旧']),
                atom('c5', '1920-01-01', 5, '旧事件甲在码头发现物品五', ['旧']),
                atom('c6', '1920-01-01', 6, '旧事件甲在码头发现物品六', ['旧']),
            ],
        }, { atomCompactRecent: 0, atomCompactBatch: 1, atomCompactTarget: 0.8 });
        aiContent = JSON.stringify({ groups: [
            { key: '1919-11-01', 标题: '十一月一日总结', 内容: '当日过程总括PQR', 标签: ['旧'], 重要度: 0.7 },
            { key: '1919-12-01', 标题: '十二月一日总结', 内容: '当日过程总括STU', 标签: ['旧'], 重要度: 0.6 },
            { key: '1920-01-01', 标题: '一月一日总结', 内容: '当日过程总括VWX', 标签: ['旧'], 重要度: 0.5 },
        ] });
        const r = await runAtomCompact({ force: true });
        ok = deq({ result: r, atoms: (state.atoms || []).map(atomView) }, f.runBatchCap);
    });
    return ok;
}, '');

await A('H10 定时调度 scheduleAtomCompact：窗口 4 秒单次排程（重复调用忽略、禁用不排、回调内跑 runAtomCompact），结果与 V1 一致', async () => {
    const f = G.atomCompact;
    let ok = false;
    await withFixedNow(async () => {
        boot({
            atoms: [
                atom('s1', '1919-11-29', 1, '旧事件甲在码头发现物品一', ['旧']),
                atom('s2', '1919-11-29', 2, '旧事件甲在码头发现物品二', ['旧']),
                atom('s3', '1919-11-29', 3, '旧事件甲在码头发现物品三', ['旧']),
            ],
        }, { atomCompactChars: 10, atomCompactRecent: 0 });
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '调度聚合总结', 内容: '调度触发的聚合过程总括VWX', 标签: ['旧'], 重要度: 0.8 }] });
        const ret = scheduleAtomCompact();
        const first = timers[0];
        const once = timers.length === 1 && first && first.ms === 4000;
        scheduleAtomCompact();                                   // 已有排程 → 忽略
        const twice = timers.length === 1;
        cfg.atomCompactEnabled = false;
        timers = [];
        scheduleAtomCompact();                                   // 禁用 → 不排
        const off = timers.length === 0;
        cfg.atomCompactEnabled = true;
        ok = once && twice && off && ret === undefined;
        // 触发首个排程的回调（等价 V1 的 4 秒后自动跑）；回调内会把 module 级 compactTimer 清空
        const fire = first.fn;
        fire();
        await new Promise(r => setTimeout(r, 0));                 // 让回调内的 async 跑完
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        const mine = {
            ret: null, sig: sigView(), summaries: summaryView(),
            active: state.atoms.filter(a => !(a.hidden === true || a.summarizedBy)).length,
            hidden: state.atoms.filter(a => a.hidden === true || a.summarizedBy).length,
        };
        ok = ok && deq(mine, f.scheduled);
    });
    return ok;
}, '');

await A('H11 合并区间 atomMergeRange：日期起止 / 楼层写法 / 无日期 / 空数组 / 非法日期，与 V1 逐字段一致', async () => {
    boot();
    const mine = {
        three: atomMergeRange(seed3()),
        one: atomMergeRange([seed3()[0]]),
        undated: atomMergeRange([{ id: 'u1', text: 'x', date: '', floorStart: 3, floorEnd: 4 }, { id: 'u2', text: 'y', date: '', floorStart: 7, floorEnd: 9 }]),
        empty: atomMergeRange([]),
        badDates: atomMergeRange([{ id: 'd1', text: 'x', date: '不是日期' }, { id: 'd2', text: 'y', date: '1920-02-03' }]),
        sameDate: atomMergeRange([{ id: 'e1', text: 'x', date: '1920-02-03', floorStart: 1, floorEnd: 2 }, { id: 'e2', text: 'y', date: '1920-02-03', floorStart: 5, floorEnd: 6 }]),
    };
    return deq(mine, G.atomMerge.rangeCases);
}, '');

await A('H12 合并提示词 buildAtomMergePrompt：system 固定口径 + user 逐字符（含隐藏过滤与 <2 条返回 null）', async () => {
    boot();
    const mine = {
        three: promptView(buildAtomMergePrompt(seed3())),
        one: promptView(buildAtomMergePrompt([seed3()[0]])),
        empty: promptView(buildAtomMergePrompt([])),
        hiddenFiltered: promptView(buildAtomMergePrompt([seed3()[0], Object.assign({}, seed3()[1], { hidden: true }), Object.assign({}, seed3()[2], { hidden: true, summarizedBy: 's' })])),
        null2: promptView(buildAtomMergePrompt(null)),
    };
    return deq(mine, G.atomMerge.promptCases);
}, '');

await A('H13 合并结果解析 parseAtomMergeResult：中文/英文键、围栏剥离、整段退化（含「只有标题 → 整段 JSON 当正文」怪癖）', async () => {
    boot();
    const mine = {
        zh: parseAtomMergeResult(JSON.stringify({ 标题: '粮运交接', 内容: '甲乙在码头敲定粮食转运并清点。', 标签: ['交易', '情感', '贸易', '码头', '仓库', '粮食', '多余'], 重要度: 0.85 })),
        en: parseAtomMergeResult(JSON.stringify({ title: 'T', content: 'C', tags: ['x', 'y'], importance: 2 })),
        plain: parseAtomMergeResult('这是一段没有 JSON 的整段文本。'),
        fenced: parseAtomMergeResult('```json\n{"标题":"围栏","内容":"围栏正文"}\n```'),
        empty: parseAtomMergeResult(''),
        blank: parseAtomMergeResult('   '),
        nullIn: parseAtomMergeResult(null),
        titleOnly: parseAtomMergeResult(JSON.stringify({ 标题: '只有标题' })),
        badImportance: parseAtomMergeResult(JSON.stringify({ 标题: 'T', 内容: 'C', 重要度: 'abc' })),
    };
    return deq(mine, G.atomMerge.parseCases);
}, '');

await A('H14 合并落库 atomMergeSummary：成功落库 + 原文隐藏 + 无墓碑；need2 / empty / unknown / tooShort / hiddenSource / exists 分支，与 V1 逐字段一致', async () => {
    const f = G.atomMerge.applyCases;
    let ok = false;
    await withFixedNow(async () => {
        const mine = {};
        boot({ atoms: seed3() });
        mine.ok = atomMergeSummary(['a1', 'a2', 'a3'], parseAtomMergeResult(JSON.stringify({ 标题: '粮运交接', 内容: '甲乙在码头敲定粮食转运并清点货物。', 标签: ['交易'], 重要度: 0.85 })));
        mine.okState = (state.atoms || []).map(atomView);
        mine.okTombs = tombs('atoms');
        mine.exists = atomMergeSummary(['a1', 'a2', 'a3'], { title: 'x', text: '重新合并的正文段落。', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        mine.need2 = atomMergeSummary(['a1'], { title: 'x', text: '正文段落内容够长。', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        mine.empty = atomMergeSummary([], { title: 'x', text: '正文段落内容够长。', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        mine.unknownIds = atomMergeSummary(['nope1', 'nope2'], { title: 'x', text: '正文段落内容够长。', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        mine.tooShort = atomMergeSummary(['a1', 'a2'], { title: 'x', text: '短', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        state.atoms[1].hidden = true; state.atoms[1].summarizedBy = 'z';
        mine.hiddenSource = atomMergeSummary(['a1', 'a2'], { title: 'x', text: '正文段落内容够长。', tags: [], importance: 0.5 });
        boot({ atoms: seed3() });
        mine.blankTextNoAi = atomMergeSummary(['a1', 'a2'], { title: 'x', text: '   ', tags: [], importance: 0.5 });
        // exists 分支（先合并一次 → 恢复来源可见并保留总结条 → 再次调用命中 exists）
        boot({ atoms: seed3() });
        const first = atomMergeSummary(['a1', 'a2', 'a3'], { title: 'T', text: '预置总结正文段落。', tags: [], importance: 0.5 });
        const sumAtom = state.atoms.filter(x => String(x.id).indexOf('atom_m_') === 0)[0];
        boot({ atoms: seed3().concat([clone(sumAtom)]) });
        mine.exists = { first: first, again: atomMergeSummary(['a1', 'a2', 'a3'], { title: 'T', text: '另一段正文内容。', tags: [], importance: 0.5 }), stored: state.atoms.length };
        boot({ atoms: seed3() });
        mine.noTitleNoTags = (() => { const r = atomMergeSummary(['a2', 'a1'], { title: '', text: '没有标题的合并正文段落。', tags: [], importance: null }); return { r: r, atoms: (state.atoms || []).map(atomView) }; })();
        boot({ atoms: seed3() });
        mine.dupIds = (() => { const r = atomMergeSummary(['a1', 'a2', 'a3', 'a2'], { title: 'T', text: '重复 id 的合并正文段落。', tags: [], importance: 0.3 }); return { r: r, atoms: (state.atoms || []).map(atomView) }; })();
        ok = deq(mine, f);
    });
    return ok;
}, '');

await A('H15 合并端到端 runAtomMergeSummary：AI 桩落库 1 条 + 隐藏 3 条、纯文本退化路径、空结果、未选中/仅 1 条、忙位、只剩 1 条可用，与 V1 一致', async () => {
    const f = G.atomMerge.runCases;
    let ok = false;
    await withFixedNow(async () => {
        const mine = {};
        boot({ atoms: seed3() });
        aiContent = JSON.stringify({ 标题: '粮运交接', 内容: '甲乙在码头敲定粮食转运并清点货物，随后甲出城确认了抵港时间。', 标签: ['交易', '情感'], 重要度: 0.85 });
        aiCalls = 0; toasts = [];
        const r0 = await runAtomMergeSummary(['a1', 'a2', 'a3']);
        mine.ok = { calls0: 0, res: r0, atoms: (state.atoms || []).map(atomView), toasts: clone(toasts), calls: aiCalls };
        boot({ atoms: seed3() });
        aiContent = '这不是 JSON 的整段总结文本，应退化为正文并落库。';
        aiCalls = 0; toasts = [];
        mine.plainText = { res: await runAtomMergeSummary(['a1', 'a2']), atoms: (state.atoms || []).map(atomView), calls: aiCalls, toasts: clone(toasts) };
        boot({ atoms: seed3() });
        aiContent = '';
        aiCalls = 0; toasts = [];
        mine.emptyAi = { res: await runAtomMergeSummary(['a1', 'a2']), calls: aiCalls, toasts: clone(toasts) };
        boot({ atoms: seed3() });
        aiContent = JSON.stringify({ 标题: 'x', 内容: 'y' });
        aiCalls = 0; toasts = [];
        mine.noIds = { res: await runAtomMergeSummary([]), calls: aiCalls, toasts: clone(toasts) };
        boot({ atoms: seed3() });
        aiCalls = 0; toasts = [];
        mine.oneId = { res: await runAtomMergeSummary(['a1']), calls: aiCalls, toasts: clone(toasts) };
        boot({ atoms: seed3() });
        busyFlag = true;
        aiCalls = 0; toasts = [];
        mine.busy = { res: await runAtomMergeSummary(['a1', 'a2']), calls: aiCalls, toasts: clone(toasts) };
        busyFlag = false;
        boot({ atoms: seed3().filter(x => x.id === 'a1') });
        aiContent = JSON.stringify({ 标题: 'x', 内容: '正文内容' });
        aiCalls = 0; toasts = [];
        mine.hiddenOnly = { res: await runAtomMergeSummary(['a1', 'gone']), calls: aiCalls, toasts: clone(toasts) };
        ok = deq(mine, f);
    });
    return ok;
}, '');

await A('H16 提示词口径静态校验：summaries 标记「【… 总结】」+ by=auto/manual + 原文保留不记墓碑（V1 v1.206 语义）', async () => {
    const sys = buildAtomCompactPrompt([{ key: 'k', items: [] }])[0].content;
    const okPrompt = sys.indexOf('做「情节总结」') >= 0 && sys.indexOf('顺序化压缩总结') >= 0
        && sys.indexOf('避免因果顺序错乱') >= 0 && sys.indexOf('{"groups":[{"key"') >= 0
        && sys.indexOf('你是记忆档案员') === 0;
    const ms = buildAtomMergePrompt(seed3())[0].content;
    const okMergePrompt = ms.indexOf('把同一批情节**合并成一条**紧凑的情节总结') >= 0
        && ms.indexOf('不得丢失任何一条原情节的关键事实') >= 0 && ms.indexOf('{"标题":"…","内容":"…"') >= 0;
    boot({ atoms: seed3() });
    const g = { key: '1919-11-29', items: [seed3()[0], seed3()[1]] };
    const sum = applyCompactGroup(g, { 标题: 'T', 内容: '正文过程内容' }, 'day');
    const autoOk = !!sum && sum.mergedSummary.by === 'auto' && sum.mergedSummary.grain === 'day'
        && sum.title === '【1919-11-29 总结】 T' && sum.permanence === 'permanent' && sum.type === '总结'
        && state.atoms.filter(x => x.hidden === true).length === 2 && tombs('atoms').length === 0;
    return okPrompt && okMergePrompt && autoOk;
}, '');

// ============================================================
// U 组：V2 编排 / 接线
// ============================================================
await A('U1 FTT.* 入口齐备（情节总结 10 项：体量/粒度键/计划/分组/提示词/应用/调度/运行/区间/合并），且无 hook 时不抛错', async () => {
    boot();
    installDevtools({ runAtomCompact: (o) => runAtomCompact(o || {}), runAtomMergeSummary: (ids, o) => runAtomMergeSummary(ids, o) });
    const F = globalThis.FTT;
    const names = ['atomBodyChars', 'atomDateGrainKey', 'grainStartDateStr', 'atomCompactPlan', 'atomGroupPlan',
        'buildAtomCompactPrompt', 'compactGrainLabel', 'applyCompactGroup', 'scheduleAtomCompact', 'runAtomCompact',
        'atomMergeRange', 'buildAtomMergePrompt', 'parseAtomMergeResult', 'atomMergeSummary', 'runAtomMergeSummary'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const r = await F.runAtomCompact({ force: true });
    const r2 = await F.runAtomMergeSummary(['nope']);
    uninstallDevtools();
    return missing.length === 0 && r && r.ok === true && r2 && r2.made === 0 && globalThis.FTT === undefined;
}, '');

await A('U2 面板接线：设定页「🧷 立即聚合早期情节」按钮（文案/title 与 V1 逐字一致）+ 多选「🧷 情节总结」按钮（disabled 条件同 V1）', async () => {
    boot({ atoms: seed3() });
    await panelAction('settingsSub', { sub: 'prompts' });
    const html = String(panelBodyHtml('settings') || '');
    const btnOk = html.indexOf('data-ftt-action="atomCompactNow"') >= 0
        && html.indexOf('title="立即对早期情节执行一次半自动情节总结（聚合为情节总结，原文保留并隐藏）"') >= 0
        && html.indexOf('🧷 立即聚合早期情节') >= 0
        && html.indexOf('data-ftt-compact-result') >= 0
        && html.indexOf('早期情节压缩') >= 0;
    // 情节页多选模式：未勾选 → disabled；勾选 2 条 → 可点
    let h = String(panelBodyHtml('atoms') || '');
    const single = h.indexOf('data-ftt-action="atomMergeSummary"') < 0;
    await panelAction('multiToggle', { kind: 'atoms' });
    h = String(panelBodyHtml('atoms') || '');
    const multiOff = h.indexOf('data-ftt-action="atomMergeSummary"') >= 0 && h.indexOf('🧷 情节总结（0）') >= 0
        && /data-ftt-action="atomMergeSummary"[^>]*disabled/.test(h)
        && h.indexOf('title="【情节总结】把勾选的情节交 AI 聚合成一条情节（标题标记「【A~B 总结】」）；原文保留并隐藏，不参与注入与淘汰，除非人工删除（可在总结上点 🧩 穿透查看）"') >= 0
        && h.indexOf('title="【分段总结】把勾选的情节按剧情时间打包交 AI 分成多段，归档到「🧩 分段总结」子页供人工管理（只归档、不注入、不参与任何自动动作）"') >= 0;
    await panelAction('selectAll', { kind: 'atoms' });
    h = String(panelBodyHtml('atoms') || '');
    const multiOn = h.indexOf('🧷 情节总结（3）') >= 0 && h.indexOf('🧩 分段总结（3）') >= 0
        && !/data-ftt-action="atomMergeSummary"[^>]*disabled/.test(h);
    return btnOk && single && multiOff && multiOn;
}, '');

await A('U3 面板动作 atomCompactNow：force 执行、提示写入 r.state.note（读 state.note，非 r.note）、跳过分支如实回报', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ atoms: seedOld40().concat(seedRecent20()) });
        aiContent = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '十一月码头事件总结', 内容: '压缩后的过程总括XYZ', 标签: ['旧'], 重要度: 0.8 }] });
        const r = await panelAction('atomCompactNow', {});
        const note = String((r.state || {}).note || '');
        const okRun = r.ok === true && Number((r.atomCompact || {}).summarized) === 1
            && note.indexOf('聚合 1 条总结 · 覆盖 40 条原情节') >= 0 && note.indexOf('原文保留并隐藏') >= 0;
        // 跳过分支：体量未达标 + 无早期池 → 文案含 skipped
        boot({ atoms: [atom('z1', '1919-11-29', 1, '唯一情节', ['旧'])] });
        const r2 = await panelAction('atomCompactNow', {});
        const note2 = String((r2.state || {}).note || '');
        ok = okRun && note2.indexOf('nothing-early') >= 0;
    });
    return ok;
}, '');

un();
R.done();
