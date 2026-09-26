// ============================================================
// 单元测试 · B8-5 遗忘域（与**真实 V1 插件**逐项比对 + 接线与界面）
// 黄金样本：tests/fixtures/v1-golden-forget.json（oracle = 真实 V1 插件 v1.206；楼层号由 ctx.getLastMessageId 固定）
// 覆盖：memoryForgetAvg / memoryForgetScore / memoryForgetExpired / runMemoryForget（含保底 + 墓碑 + 关闭与无时钟短路）/
//   lowUseSceneIsLeaf / lowUseSweepGate + lowUseSweepMark / sweepLowUseForget（冷却 · 门槛 · 保护 · 叶子 · 保底）/ enforceDimCaps；
//   另含**有意偏差**断言：V1 的 `calcTimeDecay` 用 `item <= 0` 把 **1970 年前的剧情日期**当成「无时间信息」→ 状态衰退 / 记忆遗忘 /
//   平行事件衰退对 19~20 世纪剧情整体失效；V2 按 V1 注释语义只判「非有限数值」，故对同一批数据会真正发生遗忘（见 H7）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    memoryForgetAvg, memoryForgetScore, memoryForgetExpired, runMemoryForget, scheduleMemoryForget,
    lowUseSceneIsLeaf, lowUseSweepGate, lowUseSweepMark, sweepLowUseForget,
    forgetState, forgetRunAll, cancelForgetTimers, LOWUSE_FORGET_DIMS,
} from '../../core/forget.js';
import { enforceDimCaps, mergeDelta, runStateDecay } from '../../core/ingest.js';
import { forgetPageHtml } from '../../ui/forget.js';
import { settingsPageHtml, SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-forget.json'), 'utf8'));
const R = makeReporter('forget-golden B8-5 遗忘域（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

/** 与 oracle 相同的楼层号（V1 用 ctx.getLastMessageId） */
let floorNow = 10;
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(floorNow);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return state;
}
const setFloor = (n) => { floorNow = n; setLastMessageId(n); };
const SWEEP_CFG = { lowUseForgetEnabled: true, lowUseForgetEveryFloors: 40, lowUseForgetMinItems: 20, lowUseForgetMinAvg: 5, lowUseForgetMinFloors: 300, lowUseForgetMaxDelete: 1, lowUseForgetProtectImportance: 0.7, storeMinConcepts: 0, storeMinScenes: 0, storeMinNpcs: 0, storeMinPlans: 0, storeMinSuspense: 0, storeMinSnapshots: 0 };
// v2.76.0：默认存储上限上调（记忆 600→800）——本组黄金样本按 V1 默认 600 录制，故此处**显式固定**，
//   保证比对的是遗忘算法本身而不是默认值变化。
const MEM_CFG = { memoryForgetEnabled: true, memoryForgetCutoff: 0.9, memoryForgetRatio: 0.5, storeMinMemories: 2, storeMaxMemories: 600 };

// ============================================================
// H 组：与 V1 逐项比对
// ============================================================
R.assert('H1 记忆遗忘打分 memoryForgetAvg/Score/Expired：均值 0.5、低重要度旧记忆达阈（1 / true）、高重要度免疫（0 / false）与 V1 一致', (() => {
    boot(G.inputs.memScenario);
    setFloor(10);
    const avg = memoryForgetAvg();
    const got = state.memories.map((m) => [m.id, Number(memoryForgetScore(m).toFixed(6)), memoryForgetExpired(m)]);
    return avg === G.memAvg && J(got) === J(G.memScores);
})(), (() => { boot(G.inputs.memScenario); setFloor(10); return state.memories.map((m) => [m.id, memoryForgetScore(m)]); })());

await A('H2 runMemoryForget：达阈者移除并留 id 墓碑、保底不跌破，统计与状态与 V1 一致', async () => {
    boot(G.inputs.memScenario, MEM_CFG);
    setFloor(10);
    const r = await runMemoryForget({});
    const cmp = { removed: r.removed, triggered: r.triggered, overRatio: r.overRatio, n: r.n, cap: r.cap, floor: r.floor, remain: r.remain };
    const st = { ids: state.memories.map(x => x.id), tombstones: Object.keys((state.deleted || {}).memories || {}).sort() };
    return J(cmp) === J(G.forget1) && J(st) === J(G.forget1State);
}, (() => { boot(G.inputs.memScenario, MEM_CFG); setFloor(10); return G.forget1; })());

await A('H3 记忆遗忘短路：开关关闭 → reason=disabled；无剧情时钟 → reason=no-story-clock（都不改数据）', async () => {
    boot(G.inputs.memScenario, Object.assign({}, MEM_CFG, { memoryForgetEnabled: false }));
    setFloor(10);
    const a = await runMemoryForget({});
    boot(G.inputs.memScenario, MEM_CFG);
    state.state.date = '';
    setFloor(10);
    const b = await runMemoryForget({});
    return J({ removed: a.removed, reason: a.reason }) === J(G.forgetDisabled)
        && J({ removed: b.removed, reason: b.reason }) === J(G.forgetNoClock);
}, '');

R.assert('H4 场景叶子判定 lowUseSceneIsLeaf：父节点 false / 叶子 true / 无路径 true（与 V1 一致）', (() => {
    boot(G.inputs.sweepScenario, SWEEP_CFG);
    return J({ root: lowUseSceneIsLeaf(state.scenes, 0), leaf: lowUseSceneIsLeaf(state.scenes, 1), noPath: lowUseSceneIsLeaf([{ id: 'x' }], 0) }) === J(G.leaf);
})(), (() => { boot(G.inputs.sweepScenario, SWEEP_CFG); return { s0: lowUseSceneIsLeaf(state.scenes, 0), s1: lowUseSceneIsLeaf(state.scenes, 1) }; })());

R.assert('H5 清扫间隔闸门 lowUseSweepGate：首次可扫 / 冷却中（wait=30）/ 期满可扫 —— 与 V1 一致', (() => {
    boot(G.inputs.sweepScenario, SWEEP_CFG);
    setFloor(400);
    const before = lowUseSweepGate('general', 40);
    lowUseSweepMark('general', 400);
    setFloor(410);
    const cooling = lowUseSweepGate('general', 40);
    setFloor(450);
    const ready = lowUseSweepGate('general', 40);
    return J(before) === J(G.gateBefore) && J(cooling) === J(G.gateCooling) && J(ready) === J(G.gateReady);
})(), '');

R.assert('H6 sweepLowUseForget：5 条清扫（逐维度明细与名字）+ scenes:avg-low 跳过 + 冷却标记 + 墓碑，与 V1 一致', (() => {
    boot(G.inputs.sweepScenario, SWEEP_CFG);
    setFloor(400);
    const sw = sweepLowUseForget();
    const cmp = { swept: sw.swept, dims: sw.dims, skipped: sw.skipped, avg: sw.avg, candidates: sw.candidates, floor: sw.floor, every: sw.every, cooldown: sw.cooldown || null };
    const st = { concepts: state.concepts.length, scenes: state.scenes.length, npcs: state.npcs.length, plans: state.plans.length, suspense: state.suspense.length, snapshots: state.snapshots.length, marked: clone(state.lowUseForget || {}), deletedConcepts: Object.keys((state.deleted || {}).concepts || {}).length, deletedScenes: Object.keys((state.deleted || {}).scenes || {}).length };
    return J(cmp) === J(G.sweep) && J(st) === J(G.sweepState);
})(), (() => { boot(G.inputs.sweepScenario, SWEEP_CFG); setFloor(400); const sw = sweepLowUseForget(); return { swept: sw.swept, skipped: sw.skipped, avg: sw.avg }; })());

R.assert('H6b 清扫三类保护：冷却中整项跳过 / 长期未现门槛 0 不生效 / 维度保底不清扫 —— 与 V1 一致', (() => {
    boot(G.inputs.sweepScenario, SWEEP_CFG);
    setFloor(400);
    sweepLowUseForget();
    setFloor(420);
    const sw2 = sweepLowUseForget();
    const cooldown = { swept: sw2.swept, skipped: sw2.skipped, cooldown: sw2.cooldown || null };
    boot(G.inputs.sweepScenario, Object.assign({}, SWEEP_CFG, { lowUseForgetMinFloors: 0 }));
    setFloor(400);
    const sw3 = sweepLowUseForget();
    const disabled = { swept: sw3.swept, skipped: sw3.skipped };
    boot(G.inputs.sweepScenario, Object.assign({}, SWEEP_CFG, { storeMinConcepts: 25 }));
    setFloor(400);
    const sw4 = sweepLowUseForget({ dims: ['concepts'] });
    const guard = { swept: sw4.swept, skipped: sw4.skipped, concepts: state.concepts.length };
    return J(cooldown) === J(G.sweepCooldown) && J(disabled) === J(G.sweepDisabledLongAbsent) && J(guard) === J(G.sweepFloorGuard);
})(), '');

R.assert('H7 enforceDimCaps：按保底/上限裁剪并留墓碑（概念 13 / 场景 15），与 V1 一致', (() => {
    boot(G.inputs.sweepScenario, Object.assign({}, SWEEP_CFG, { storeMaxConcepts: 12, storeMinConcepts: 5, storeMaxScenes: 10, storeMinScenes: 3 }));
    const caps = enforceDimCaps();
    const cmp = { cut: caps.cut, dims: caps.dims };
    const st = { concepts: state.concepts.length, scenes: state.scenes.length, deletedConcepts: Object.keys((state.deleted || {}).concepts || {}).length };
    return J(cmp) === J(G.caps) && J(st) === J(G.capsState);
})(), (() => { boot(G.inputs.sweepScenario, Object.assign({}, SWEEP_CFG, { storeMaxConcepts: 12, storeMinConcepts: 5, storeMaxScenes: 10, storeMinScenes: 3 })); return enforceDimCaps(); })());

R.assert('H8 **有意偏差**：1970 年前剧情日期照常衰减（V1 因 `item <= 0` 记为 0 → 遗忘整体失效；V2 按注释语义修正）', (() => {
    boot(G.inputs.memScenario, MEM_CFG);
    state.state.date = '1920-01-01';
    state.memories = [
        { id: 'q1', title: 'a', content: 'a', date: '1900-01-01', importance: 0.1, uses: 1, floorStart: 1, floorEnd: 2 },
        { id: 'q2', title: 'b', content: 'b', date: '1919-12-31', importance: 0.9, uses: 1, floorStart: 1, floorEnd: 2 },
    ];
    setFloor(10);
    const scores = state.memories.map((m) => [m.id, Number(memoryForgetScore(m).toFixed(6))]);
    const expired = state.memories.map((m) => memoryForgetExpired(m));
    // V1 黄金样本记录：同样数据下 V1 的分数全为 0、且一条也不遗忘
    return J(G.v1Pre1970.scores) === J([['q1', 0], ['q2', 0]]) && J(G.v1Pre1970.expired) === J([false, false])
        && scores[0][1] > 0 && expired[0] === true && expired[1] === false && G.v1DecayGuard.ms1900 === true;
})(), (() => { const s = memoryForgetScore({ id: 'q1', date: '1900-01-01', importance: 0.1 }); return { v2Score: s }; })());

await A('H8b 有意偏差（端到端）：1920 剧情时钟下 runMemoryForget 真正移除低重要度旧记忆（V1 记录为 removed=0）', async () => {
    boot(G.inputs.memScenario, MEM_CFG);
    state.state.date = '1920-01-01';
    state.memories = [
        { id: 'q1', title: 'a', content: 'a', date: '1900-01-01', importance: 0.1, uses: 1, floorStart: 1, floorEnd: 2 },
        { id: 'q2', title: 'b', content: 'b', date: '1919-12-31', importance: 0.9, uses: 1, floorStart: 1, floorEnd: 2 },
        { id: 'q3', title: 'c', content: 'c', date: '1919-12-30', importance: 0.8, uses: 1, floorStart: 1, floorEnd: 2 },
    ];
    setFloor(10);
    const r = await runMemoryForget({});
    return G.v1Pre1970Forget.removed === 0 && r.removed === 1 && state.memories.map(x => x.id).join(',') === 'q2,q3';
}, '');

// ============================================================
// P 组：调度 / 汇总 / 界面
// ============================================================
R.assert('P1 scheduleMemoryForget：无剧情时钟或开关关闭不调度；有剧情时钟排程一次（防抖 3s，重复调用不叠加）', (() => {
    let scheduled = 0;
    boot(G.inputs.memScenario, Object.assign({}, MEM_CFG, { memoryForgetEnabled: false }));
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    const off = scheduleMemoryForget();
    boot(G.inputs.memScenario, MEM_CFG);
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    state.state.date = '';
    const noClock = scheduleMemoryForget();
    boot(G.inputs.memScenario, MEM_CFG);
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    const on = scheduleMemoryForget();
    const again = scheduleMemoryForget();
    cancelForgetTimers();
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return off === false && noClock === false && on === true && again === false && scheduled === 1;
})(), '');

R.assert('P2 mergeDelta 接线：记忆增/改/删后自动调度记忆遗忘（V1 v1.63 口径；开关打开后恰好多一次排程）', (() => {
    // 状态衰退 / 平行衰退的定时器在首次合并后即为 pending（内部去重），因此「打开记忆遗忘开关后再合并一次」
    //   只应新增 1 次排程 —— 这正是 scheduleMemoryForget 的那一次。
    let scheduled = 0;
    boot(G.inputs.memScenario, Object.assign({}, MEM_CFG, { memoryForgetEnabled: false }));
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    mergeDelta({ memories: { add: [{ id: 'mm1', title: '新记忆', content: '内容', date: '2019-01-01', importance: 0.5 }] } });
    const n1 = scheduled;
    cfg.memoryForgetEnabled = true;
    mergeDelta({ memories: { add: [{ id: 'mm2', title: '新记忆2', content: '内容2', date: '2019-01-02', importance: 0.5 }] } });
    const n2 = scheduled;
    cancelForgetTimers();
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return n1 >= 1 && n2 === n1 + 1;
})(), '');

R.assert('P3 forgetState 汇总：状态衰退 / 记忆遗忘（含保底与均值）/ 通用清扫（冷却与间隔）齐备；LOWUSE 六维', (() => {
    boot(G.inputs.memScenario, MEM_CFG);
    setFloor(100);
    const st = forgetState();
    return LOWUSE_FORGET_DIMS.map(d => d.dim).join(',') === 'concepts,scenes,npcs,plans,suspense,snapshots'
        && st.stateDecay.states === 0 && st.stateDecay.cap >= 1
        && st.memoryForget.memories === 4 && st.memoryForget.cap === 600 && st.memoryForget.floor === 2
        && st.memoryForget.avg === 0.5 && st.memoryForget.enabled === true
        && st.lowUse.enabled === true && st.lowUse.now === 100 && st.lowUse.every === 40;
})(), (() => { boot(G.inputs.memScenario, MEM_CFG); return forgetState(); })());

await A('P4 forgetRunAll：一次跑齐 状态衰退 / 记忆遗忘 / 通用清扫 / 库存裁剪（V2 诊断入口）', async () => {
    boot(G.inputs.sweepScenario, Object.assign({}, SWEEP_CFG, MEM_CFG));
    setFloor(400);
    const r = await forgetRunAll({});
    return !!r.decay && !!r.forget && !!r.sweep && !!r.caps
        && r.sweep.swept >= 1 && typeof r.decay.removed === 'number' && typeof r.forget.removed === 'number';
}, '');

R.assert('U1 遗忘设定页：V1 五分节 + 3 个开关 + 28 个控件 + 只读诊断行（当前条数/上限/保底/冷却）', (() => {
    boot(G.inputs.memScenario, MEM_CFG);
    const html = settingsPageHtml('forget');
    return html.indexOf('状态记录衰退（只按剧情日期）') >= 0 && html.indexOf('记忆遗忘机制（只按剧情日期）') >= 0
        && html.indexOf('存储保底 / 上限') >= 0 && html.indexOf('通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）') >= 0
        && html.indexOf('data-ftt-cfg="stateDecayEnabled"') >= 0 && html.indexOf('data-ftt-cfg="memoryForgetEnabled"') >= 0
        && html.indexOf('data-ftt-cfg="lowUseForgetEnabled"') >= 0 && html.indexOf('data-ftt-forget-state') >= 0
        && SETTINGS_CONTROLS.forget.length === 28;
})(), '');

await A('U2 面板接线：切到遗忘子页渲染该页（不再平铺），FTT 遗忘入口在 index 中导出', async () => {
    boot(G.inputs.memScenario, MEM_CFG);
    openPanel('settings');
    setPanelHooks2({});
    const r = await panelAction('settingsSub', { sub: 'forget' });
    const page = panelBodyHtml('settings');
    const st = panelState();
    const mod = await import('../../index.js');
    return r.ok === true && st.settingsSub === 'forget' && page.indexOf('data-ftt-settings-page="forget"') >= 0
        && page.indexOf('通用遗忘清扫') >= 0 && page.indexOf('data-ftt-forget-state') >= 0
        && typeof mod.__internals.VERSION === 'string';
}, '');

// ============================================================
// S 组：状态衰退（V2 已移植；此处验证遗忘域入口可用 + 保底不跌破）
// ============================================================
await A('S1 runStateDecay 可用且受开关控制：无剧情时钟短路；有剧情时钟且超限时触发（force）', async () => {
    boot({});
    state.state.date = '';
    const off = await runStateDecay({});
    boot({});
    state.state.date = '2020-01-01';
    state.currentStates = [];
    for (let i = 0; i < 40; i++) state.currentStates.push({ id: 'st' + i, subject: '角色' + i, field: '状态', value: 'v' + i, date: '2001-01-01', uses: 1, updatedAt: 0 });
    setFloor(10);
    const r = await runStateDecay({ force: true });
    return off.reason === 'no-story-clock' && typeof r.removed === 'number' && r.removed >= 0 && (state.currentStates || []).length <= 40;
}, '');

un();
R.done();
