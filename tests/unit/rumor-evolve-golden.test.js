// ============================================================
// 单元测试 · B8-7 传言演化引擎（内核部分）
//   （与**真实 V1 插件** v1.206 逐项比对）
// 黄金样本（oracle = 真实 V1 插件，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-rumor-evolve.json —— V1 行 13261~13820 的引擎主体 + 行 23377 的 `flattenRumor`。
// 覆盖（oracle 已导出、逐值比对）：
//   rumorEnabledOn / rumorEveryRounds / rumorNeedRounds；rumorTickState（脏值归一：字符串 / 负数 / null / 非对象）；
//   rumorRoll（确定性掷骰 + 同 seed 复现）；rumorStoryDate / rumorDayDiff；rumorMediaWeight / rumorAgeMedia /
//   rumorFermentDelta（多载体 · 耐久度 · 寿命 · 无载体惩罚）；rumorChainPush（日期 + 轮次 + 类型归一）；
//   rumorParallelLinkScore / rumorParallelLink（发酵 / 消退 / 推动三分支 + 关闭 + 无命中）；
//   rumorVariantFor（含 V1 的 NaN → undefined 越界怪癖）；rumorStartPending / rumorAdvancePending /
//   rumorCommitPending（裂变 / 变异 / 重复裂变跳过）；rumorMaybeStartChange（裂变 / 变异 / 不开始）；
//   runRumorEvolve / runRumorEvolveNow（老化 + 发酵 + 联动 + 酝酿 + 提交 + 阶段重算 + 日期跟新 + 通知）；
//   rumorTickAdvance（轮次计数 + 满轮异步触发 + 同楼层不重复计数）；rumorMarkParallelChange（轮次重置）；
//   rumorDecayScore / rumorExpired / runRumorDecay（饱和时间戳 → 精确打分；移除 + id/内容双墓碑 + 比例触发 + 关闭）；
//   rumorApplyAiDelta（new / spread 保留旧字段 / 显式覆盖 / branch-new / branch-update / splitFrom / 关闭 / 非法输入）；
//   clearRumors；rumorInjLine（re-export 自 core/recall.js）；flattenRumor。
// 另含（V1 `__FTT` **未导出**，故无黄金值，只做语义/等价断言）：
//   rumorActiveMediaCount（用 durability=1 时 `rumorMediaWeight == 活跃载体数` 等价）；rumorAiHas / rumorMergeAiInto
//   （窄契约语义；其公开效果已由 rumorApplyAiDelta 黄金值覆盖）；scheduleRumorEvolve / scheduleRumorDecay
//   （V1 用 setTimeout、V2 用 timerHooks，行为等价）。
// 说明：V1 `saveState` 会调 `tombstoneSweep` 自动给消失条目留墓碑，故本测试的 `saveState` 桩同样调用
//   `tombstoneSweep()`，并在 `boot()` 后调 `entryIndexInit()` 对齐基线 —— 与 oracle 侧的 `F.entryIndexInit()` 一一对应。
// 确定性：固定剧情日期 2020-06-01 + 固定 seed；时间戳字段一律经投影剔除；全量结果**连跑两次逐字节一致**。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import * as RU from '../../core/rumor-evolve.js';
import {
    rumorEnabledOn, rumorEveryRounds, rumorNeedRounds, rumorTickState, rumorRoll, rumorStoryDate, rumorDayDiff,
    rumorChainPush, rumorActiveMediaCount, rumorMediaWeight, mergeRumorListBy, rumorAgeMedia, rumorFermentDelta,
    rumorParallelLinkScore, rumorParallelLink, rumorVariantFor,
    rumorStartPending, rumorAdvancePending, rumorCommitPending, rumorMaybeStartChange,
    runRumorEvolve, runRumorEvolveNow, rumorTickAdvance, rumorMarkParallelChange, scheduleRumorEvolve,
    rumorDecayScore, rumorExpired, scheduleRumorDecay, runRumorDecay,
    rumorAiHas, rumorMergeAiInto, rumorApplyAiDelta, clearRumors, flattenRumor, rumorInjLine,
} from '../../core/rumor-evolve.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-rumor-evolve.json'), 'utf8'));
const R = makeReporter('rumor-evolve-golden B8-7 传言演化引擎（V1 对齐）');
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
const sleep = () => new Promise((r) => setTimeout(r, 0));

// 宿主桩：dbgLog 静默（保存/通知不影响断言）
setChatHooks({ dbgLog: () => undefined });
// 「导入零副作用」快照：ESM import 先于本模块体执行，此刻 state 仍应为 null（内核默认值）
const STATE_AT_IMPORT = state;

let toasts = [];
let timers = [];
/** 与 oracle 侧同口径的启动：默认配置 + 场景 state + 墓碑基线 + 定时器/通知桩 */
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    // V1 `saveState` = 删除留痕 + 落盘；这里同样触发留痕（oracle 侧 F.entryIndexInit() 对齐基线）
    setPersistHooks({
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    entryIndexInit();
    return state;
}
// ---------- 投影（剔除时间戳 + **捕获即深拷贝**，避免后续演化改动同一嵌套对象） ----------
const rumView = () => clone((state.rumors || []).map(x => ({
    id: x.id, subject: x.subject, content: x.content, objectivity: x.objectivity, stage: x.stage, ferment: x.ferment,
    pending: x.pending, carriers: x.carriers, media: x.media, chain: x.chain, lineage: x.lineage,
    parallelRefs: x.parallelRefs, source: x.source, date: x.date, tags: x.tags, floorStart: x.floorStart, floorEnd: x.floorEnd,
})));
const parView = () => clone((state.parallels || []).map(x => ({ id: x.id, title: x.title, tags: x.tags, previews: x.previews })));
const tickView = (t) => ({ round: t.round, lastFloor: t.lastFloor, parallelFloor: t.parallelFloor, runs: t.runs });
const tombsOf = (h) => Object.keys(((h ? state.deletedH : state.deleted) || {}).rumors || {}).sort();
const toc = (x) => (x ? { childId: x.childId, variant: x.variant, skipped: x.skipped } : null);
// AI 落库场景（等价 oracle `scenarioAi()`：只有剧情日期，无传言 / 平行 / rumorTick）
const ST_AI = { state: { time: '', date: G.inputs.today, location: '', sceneFocus: null }, rumors: [], parallels: [] };

const R_LINK = {
    id: 'rum_link', subject: '码头失窃', content: '码头的货被偷了，有人说是内贼。', date: G.inputs.today, tags: ['甲', '乙', '丙'],
    ferment: 50, carriers: [{ who: '甲', role: '源头' }], media: [], chain: [], parallelRefs: [],
    lineage: { rootId: 'rum_link', parentId: '', children: [], generation: 0 },
};
const R_FRESH = {
    id: 'rum_new', subject: '新传言', content: '新说法。', objectivity: '主观', stage: '发酵', ferment: 85,
    carriers: [{ who: '甲' }], media: [], chain: [], parallelRefs: [], date: G.inputs.today,
    lineage: { rootId: 'rum_new', parentId: '', children: [], generation: 0 },
};
const R1_AI = {
    subject: '码头失窃', content: '码头的货被偷了。', objectivity: '客观', ferment: 30, source: '正文', date: '2020-05-01',
    tags: ['码头', '失窃'], carriersText: '甲:源头\n乙', mediaText: '口耳相传|口耳相传|2020-05-01|1',
};
const R3_AI = { subject: '码头失窃', content: '完全不同的说法：是水匪半夜摸上码头搬空了货栈，还打伤了守夜人。', objectivity: '主观', ferment: 40 };

// ============================================================
// V2 侧全量执行（与 oracle 生成脚本逐段同序；每段 boot 一次）
// ============================================================
async function runAll() {
    const got = {};
    const patch = () => clone(G.inputs.cfg);

    // ---------- 1) 配置读取器 ----------
    boot(G.inputs.mech, patch());
    got.cfgReaders = {
        enabled: [null, true, false].map(v => { cfg.rumorEnabled = v; return rumorEnabledOn(); }),
        enabledRestore: (() => { cfg.rumorEnabled = true; return rumorEnabledOn(); })(),
        every: [0, -3, 7.4, 'abc', 5, null, 1].map(v => { cfg.rumorChangeEveryRounds = v; return rumorEveryRounds(); }),
        everyMissing: (() => { delete cfg.rumorChangeEveryRounds; return rumorEveryRounds(); })(),
        need: [null, 0, 3.6, 'x', 2].map(v => { cfg.rumorChangeNeedRounds = v; return rumorNeedRounds(); }),
        needMissing: (() => { delete cfg.rumorChangeNeedRounds; return rumorNeedRounds(); })(),
    };
    cfg.rumorChangeEveryRounds = G.inputs.cfg.rumorChangeEveryRounds;
    cfg.rumorChangeNeedRounds = G.inputs.cfg.rumorChangeNeedRounds;

    // ---------- 2) rumorTickState（脏值归一） ----------
    got.tick = [];
    for (const tc of G.tick) {
        const st = clone(G.inputs.mech); st.rumorTick = clone(tc.input);
        boot(st, patch());
        const g = clone(rumorTickState());
        got.tick.push({ input: clone(tc.input), got: g, stored: clone(state.rumorTick) });
    }

    // ---------- 3) rumorRoll ----------
    got.roll = G.roll.map(x => ({ seed: x.seed, v: rumorRoll(x.seed) }));
    got.rollRepeat = [rumorRoll('rum_m1|variant|2020-01-01|1'), rumorRoll('rum_m1|variant|2020-01-01|1'), rumorRoll('rum_m1|variant|2020-01-01|2')];

    // ---------- 4) rumorStoryDate / rumorDayDiff ----------
    boot(G.inputs.mech, patch());
    got.storyDate = rumorStoryDate();
    got.dayDiff = G.dayDiff.map(([a, b]) => [a, b, rumorDayDiff(a, b)]);
    { const s = clone(G.inputs.mech); s.state.date = ''; boot(s, patch()); got.storyDateEmpty = rumorStoryDate(); }
    { const s = clone(G.inputs.mech); s.state.date = '2020-06-01T08:00'; boot(s, patch()); got.storyDateDirty = rumorStoryDate(); }

    // ---------- 5) 载体权重 / 发酵增量 / 老化 ----------
    boot(G.inputs.mech, patch());
    got.mech = {
        weight: (state.rumors || []).map(r => [r.id, rumorMediaWeight(r)]),
        fermentDelta: (state.rumors || []).map(r => [r.id, rumorFermentDelta(r)]),
        aged: (state.rumors || []).map(r => rumorAgeMedia(r)),
        after: rumView(),
    };
    // durability 全为 1 → 权重 == 活跃载体数（用于间接校验 rumorActiveMediaCount）
    {
        const s = clone(G.inputs.mech);
        s.rumors = s.rumors.map(r => Object.assign({}, r, { media: (r.media || []).map(m => Object.assign({}, m, { durability: 1 })) }));
        boot(s, patch());
        got.weightD1 = (state.rumors || []).map(r => [r.id, rumorMediaWeight(r)]);
    }

    // ---------- 6) rumorChainPush ----------
    boot(G.inputs.mech, patch());
    got.chainPush = {
        steps: [
            clone(rumorChainPush(state.rumors[0], { kind: '传播', from: '甲', to: '乙', note: '甲把话传给了乙' })),
            clone(rumorChainPush(state.rumors[0], { kind: '联动' })),
            clone(rumorChainPush(state.rumors[0], {})),
            clone(rumorChainPush(state.rumors[0], { kind: '不存在的类型', note: '类型归一' })),
            clone(rumorChainPush(null, { note: '空条目' })),
        ],
        chain: clone((state.rumors[0] || {}).chain),
    };

    // ---------- 7) 平行联动打分 / 三选一 ----------
    boot(G.inputs.link, patch());
    got.linkScore = (state.parallels || []).map(p => [p.id, rumorParallelLinkScore(clone(R_LINK), clone(p))]);
    cfg.rumorParallelLinkSim = 0; cfg.rumorParallelLinkChance = 1;
    got.link = { inputs: clone(R_LINK), runs: [], kinds: [] };
    for (const id of ['rum_lk_1', 'rum_lk_476', 'rum_lk_8']) {
        boot(G.inputs.link, patch());
        cfg.rumorParallelLinkSim = 0; cfg.rumorParallelLinkChance = 1;
        const rr = clone(R_LINK); rr.id = id;
        const r = clone(rumorParallelLink(rr, 3));
        got.link.runs.push({ id, result: r, rumor: clone(rr), parallels: parView(), rolls: [rumorRoll(id + '|link|' + G.inputs.today + '|3'), rumorRoll(id + '|linkef|' + G.inputs.today + '|3')] });
    }
    got.link.kinds = got.link.runs.map(x => x.result && x.result.kind);
    boot(G.inputs.link, patch());
    cfg.rumorParallelLinkChance = 0;
    got.linkChance0 = clone(rumorParallelLink(clone(R_LINK), 3));
    cfg.rumorParallelLinkSim = 0.99;
    { const rNo = clone(R_LINK); rNo.tags = ['无关甲', '无关乙', '无关丙']; got.linkNoHit = clone(rumorParallelLink(rNo, 3)); }
    cfg.rumorParallelLinkSim = 0.34; cfg.rumorParallelLinkChance = 0.35;

    // ---------- 8) rumorVariantFor ----------
    got.variants = ['rum_v1', 'rum_v2', 'rum_v3', 'rum_v4', 'rum_v5', 'rum_v6'].map(id => ({ id, date: G.inputs.today, idxs: [1, 2, 3, 4, 5, 6, 7].map(i => rumorVariantFor({ id, date: G.inputs.today }, i) === undefined ? null : rumorVariantFor({ id, date: G.inputs.today }, i)) }));

    // ---------- 9) 变化过程 ----------
    boot(G.inputs.change, patch());
    got.startPending = {
        dup: clone(rumorStartPending(state.rumors[0], '变异', '官方口径', 1)),
        pushed: state.rumors.push(clone(R_FRESH)),
        ok: clone(rumorStartPending(state.rumors[4], '裂变', '夸大版', 1)),
        rumor: clone(rumView().find(x => x.id === 'rum_new')),
        chain: clone((state.rumors[4] || {}).chain),
    };
    boot(G.inputs.change, patch());
    got.advance = { results: state.rumors.map((r, i) => toc(rumorAdvancePending(r, 8))), rumors: rumView() };
    boot(G.inputs.change, patch());
    got.commit = { results: state.rumors.map((r, i) => toc(rumorCommitPending(r, 8))), rumors: rumView() };

    // ---------- 10) rumorMaybeStartChange ----------
    boot(G.inputs.maybe, patch());
    got.maybeStart = { results: state.rumors.map((r, i) => clone(rumorMaybeStartChange(r, 9))), rumors: rumView() };
    cfg.rumorFissionChance = 0;
    boot(G.inputs.maybe, patch());
    cfg.rumorFissionChance = 0;
    got.maybeStart0 = state.rumors.map((r, i) => clone(rumorMaybeStartChange(r, 9)));
    cfg.rumorFissionChance = G.inputs.cfg.rumorFissionChance;

    // ---------- 11) runRumorEvolve / runRumorEvolveNow ----------
    boot(G.inputs.evolve, patch());
    got.evolve = {
        out: clone(await runRumorEvolve({ reason: 'golden', silent: true })),
        rumors: rumView(), parallels: parView(), tick: tickView(state.rumorTick),
    };
    got.evolveNow = { out: clone(await runRumorEvolveNow({ silent: true })), rumors: rumView() };
    boot(G.inputs.evolve, patch());
    cfg.rumorEnabled = false;
    got.evolveDisabled = clone(await runRumorEvolve({ silent: true }));
    cfg.rumorEnabled = true;
    boot(G.inputs.evolve, patch());
    toasts = [];
    await runRumorEvolve({ reason: 'notify' });
    got.evolveToasts = clone(toasts);

    // ---------- 12) rumorTickAdvance / rumorMarkParallelChange ----------
    cfg.rumorChangeEveryRounds = 2;
    boot(G.inputs.evolve, patch());
    cfg.rumorChangeEveryRounds = 2;
    got.tickAdvance = { ticks: [], rumors: null };
    for (const f of [10, 10, 11, 12, 13, 14]) {
        const ret = clone(rumorTickAdvance(f));
        const tk = tickView(state.rumorTick);
        got.tickAdvance.ticks.push({ floor: f, ret, tick: tk });
        await sleep();
    }
    got.tickAdvance.rumors = rumView();
    cfg.rumorChangeEveryRounds = G.inputs.cfg.rumorChangeEveryRounds;
    boot(G.inputs.evolve, patch());
    got.parallelChange = {
        a: tickView(clone(rumorMarkParallelChange(22))),
        b: tickView(clone(rumorMarkParallelChange('abc'))),
        stored: tickView(state.rumorTick),
    };

    // ---------- 13) 衰退 ----------
    boot(G.inputs.decay, patch());
    got.decay = {
        scores: state.rumors.map(r => [r.id, Number(rumorDecayScore(r).toFixed(6))]),
        expired: state.rumors.map(r => [r.id, rumorExpired(r)]),
        ret: clone(await runRumorDecay({})),
        rumors: rumView(), tombs: tombsOf(false), tombsH: tombsOf(true),
    };
    boot(G.inputs.decay, patch());
    got.decayForce = { ret: clone(await runRumorDecay({ force: true })), rumors: rumView(), tombs: tombsOf(false) };
    cfg.storeMaxRumors = 4;
    boot(G.inputs.decayRatio, patch());
    cfg.storeMaxRumors = 4;
    got.decayRatio = { ret: clone(await runRumorDecay({})), rumors: rumView() };
    cfg.storeMaxRumors = G.inputs.cfg.storeMaxRumors;
    boot(G.inputs.decay, patch());
    cfg.rumorDecayEnabled = false;
    got.decayDisabled = { ret: clone(await runRumorDecay({})), expired: state.rumors.map(r => rumorExpired(r)), rumors: rumView() };
    cfg.rumorDecayEnabled = true;

    // ---------- 14) AI 补写窄契约：rumorApplyAiDelta ----------
    boot(ST_AI, patch());
    // 时间戳归一：V1 内 `prev` 取 updatedAt 最新者，同毫秒并列时按数组序取首个 → 结果取决于宿主耗时；
    //   这里每次落库后按数组序固定 updatedAt（与 oracle 侧同口径），保证黄金样本可复现。
    const fixTs = () => { (state.rumors || []).forEach((x, i) => { x.updatedAt = 1000 + i; }); };
    const aiLog = [];
    const shot = (mode, raw, opts) => {
        const r = rumorApplyAiDelta(clone(raw), clone(opts || {}));
        fixTs();
        aiLog.push({ mode, ret: r ? { added: r.added, updated: r.updated, mode: r.mode, id: r.item && r.item.id } : null, rumors: rumView() });
    };
    shot('new', R1_AI, { floor: { start: 3, end: 5 } });
    shot('spread-keep-fields', { subject: '码头失窃', content: '码头的货被偷了。', tags: ['新标签'] }, { floor: { start: 6, end: 7 } });
    shot('spread-override', { subject: '码头失窃', content: '码头的货被偷了。', objectivity: '主观', source: 'AI来源', '发酵度': 55, '阶段': '异变' }, {});
    shot('branch-new', R3_AI, {});
    shot('spread-repeat', R3_AI, {});
    shot('branch-update', { subject: '码头失窃', content: R3_AI.content, source: 'AI来源丙', tags: ['追加标签'], '分裂自': '码头失窃' }, {});
    shot('splitFrom', { subject: '河神显灵', content: '河神昨夜在渡口显灵，保了船队平安。', objectivity: '主观', '分裂自': '码头失窃' }, {});
    got.aiDelta = { log: aiLog, rumors: rumView() };
    boot(ST_AI, patch());
    got.aiDeltaBad = clone(rumorApplyAiDelta({ subject: '', content: '' }, {}));
    cfg.rumorEnabled = false;
    got.aiDeltaDisabled = clone(rumorApplyAiDelta(clone(R1_AI), {}));
    cfg.rumorEnabled = true;
    got.aiDeltaNoContent = clone(rumorApplyAiDelta({ subject: '只有主体' }, {}));

    // ---------- 15) clearRumors ----------
    boot(G.inputs.decay, patch());
    got.clear = { n: clearRumors(), rumors: rumView(), tombs: tombsOf(false), tombsH: tombsOf(true) };

    // ---------- 16) rumorInjLine / flattenRumor ----------
    boot(G.inputs.mech, patch());
    got.injLine = (state.rumors || []).map(r => [r.id, rumorInjLine(clone(r))]);
    got.injLineEdge = [null, {}, { subject: 'S', content: 'C' }, { subject: 'S', content: 'C', media: [{ type: '报刊', name: '报刊', active: true }, { type: '书', name: '旧书', active: false }], carriers: [{ who: '甲', role: '源头' }, { who: '乙' }], objectivity: '客观', stage: '发酵', ferment: 0 }].map(r => rumorInjLine(r));
    got.flatten = (state.rumors || []).map(r => clone(flattenRumor(clone(r))));
    got.flattenEdge = [null, {}, { subject: 'S', carriers: [{ who: '甲' }, { who: '乙', role: '源头' }, { who: '丙', role: '传播者' }], media: [{ type: '书', name: '账本', at: '2020-01-01', durability: 3 }, { type: '报刊' }], tags: ['甲', '乙'] }].map(x => clone(flattenRumor(x)));

    // ---------- 17) 延迟调度（timerHooks 等价；V1 为 setTimeout 3000） ----------
    boot(G.inputs.evolve, patch());
    const runs0 = state.rumorTick.runs;
    scheduleRumorEvolve('tick');
    scheduleRumorEvolve('tick');
    const evTimers = timers.length;
    await timers[0].fn();
    await sleep();
    const runs1 = state.rumorTick.runs;
    scheduleRumorDecay();
    scheduleRumorDecay();
    const deTimers = timers.length - evTimers;
    await timers[timers.length - 1].fn();
    await sleep();
    cfg.rumorEnabled = false; cfg.rumorDecayEnabled = false;
    const n0 = timers.length;
    scheduleRumorEvolve('tick'); scheduleRumorDecay();
    const disabledAdds = timers.length - n0;
    cfg.rumorEnabled = true; cfg.rumorDecayEnabled = true;
    got.schedule = { evTimers, evMs: 3000, runsBefore: runs0, runsAfter: runs1, deTimers, disabledAdds };

    return got;
}

// ============================================================
// Z 组：逐段与真实 V1 黄金样本比对
// ============================================================
const g1 = await runAll();
const g2 = await runAll();

await A('Z1 配置读取器：rumorEnabledOn / rumorEveryRounds（0·负·小数·非数字·缺键）/ rumorNeedRounds 与 V1 一致',
    () => J(g1.cfgReaders) === J(G.cfgReaders) && g1.cfgReaders.every[1] === 1 && g1.cfgReaders.every[3] === 5
        && g1.cfgReaders.everyMissing === 5 && g1.cfgReaders.need[1] === 2 && g1.cfgReaders.enabled[2] === false,
    [g1.cfgReaders, G.cfgReaders]);

await A('Z2 rumorTickState 脏值归一（字符串小数 / 负数 / null / 非对象 / 未知楼层）与 V1 逐字段一致',
    () => J(g1.tick) === J(G.tick) && g1.tick[0].got.round === 4 && g1.tick[0].got.parallelFloor === -1
        && g1.tick[1].got.runs === 0 && g1.tick[2].got.lastFloor === -1,
    [g1.tick, G.tick]);

await A('Z3 rumorRoll 确定性：固定 seed 恒返回同一值（含空串 / null / 中文 seed），且与 V1 数值一致',
    () => J(g1.roll) === J(G.roll) && J(g1.rollRepeat) === J(G.rollRepeat) && g1.rollRepeat[0] === g1.rollRepeat[1],
    [g1.roll, G.roll]);

await A('Z4 rumorStoryDate / rumorDayDiff：日期裁剪、空剧情日期、带时刻、不可解析 → 0，与 V1 一致',
    () => g1.storyDate === G.storyDate && g1.storyDateEmpty === G.storyDateEmpty && g1.storyDateDirty === G.storyDateDirty
        && J(g1.dayDiff) === J(G.dayDiff) && g1.dayDiff[0][2] === 152 && g1.dayDiff[1][2] === 0,
    [g1.dayDiff, G.dayDiff]);

await A('Z5 载体：rumorMediaWeight 耐久度加权 + rumorAgeMedia 按「寿命×耐久度」停用（含空 at 回退 r.date）与 V1 一致',
    () => J(g1.mech.weight) === J(G.mech.weight) && J(g1.mech.aged) === J(G.mech.aged)
        && J(g1.mech.after) === J(G.mech.after) && J(g1.mech.aged) === J([3, 0, 0]),
    [g1.mech, G.mech]);

await A('Z6 发酵度增量 rumorFermentDelta：活跃载体加权 + 传播者 + 联动推力 − 无载体/久未变化压力，与 V1 一致',
    () => J(g1.mech.fermentDelta) === J(G.mech.fermentDelta) && g1.mech.fermentDelta[2][1] === -13,
    [g1.mech.fermentDelta, G.mech.fermentDelta]);

await A('Z7 活跃载体数 rumorActiveMediaCount（V1 未导出）：durability=1 时 == rumorMediaWeight == V1 权重值',
    () => {
        if (J(g1.weightD1) !== J(G.weightD1)) return false;
        const st = clone(G.inputs.mech);
        st.rumors = st.rumors.map(r => Object.assign({}, r, { media: (r.media || []).map(m => Object.assign({}, m, { durability: 1 })) }));
        boot(st, clone(G.inputs.cfg));
        return (state.rumors || []).every(r => rumorActiveMediaCount(r) === rumorMediaWeight(r))
            && rumorMediaWeight(state.rumors[0]) === 5 && rumorActiveMediaCount(state.rumors[2]) === 0;
    },
    [g1.weightD1, G.weightD1]);

await A('Z8 rumorChainPush：链路步补日期与轮次、类型归一（未知 → 传播）、空条目 → null，与 V1 一致',
    () => J(g1.chainPush) === J(G.chainPush) && g1.chainPush.steps[1].kind === '联动'
        && g1.chainPush.steps[3].kind === '传播' && g1.chainPush.steps[4] === null && g1.chainPush.chain.length === 4,
    [g1.chainPush, G.chainPush]);

await A('Z9 rumorParallelLinkScore：标签 Jaccard（无标签/不相关 → 0）与 V1 一致',
    () => J(g1.linkScore) === J(G.linkScore) && g1.linkScore[0][1] === 1 && g1.linkScore[1][1] === 0,
    [g1.linkScore, G.linkScore]);

await A('Z10 rumorParallelLink 三选一：发酵(+12) / 消退(-15) / 推动(写入平行预演 +6)，标签关联 + 概率掷骰与 V1 一致',
    () => J(g1.link) === J(G.link) && J(g1.link.kinds) === J(G.link.kinds)
        && g1.link.kinds.join(',') === '发酵,消退,推动'
        && J(g1.link.runs[2].parallels[0].previews) === J(G.link.runs[2].parallels[0].previews),
    [g1.link, G.link]);

await A('Z11 rumorParallelLink 关闭（chance=0）与无命中（相似度不足）→ null；转正平行事件不参与联动',
    () => J(g1.linkChance0) === J(G.linkChance0) && g1.linkChance0 === null
        && J(g1.linkNoHit) === J(G.linkNoHit) && g1.linkNoHit === null && g1.linkScore[2][1] === 1,
    [g1.linkChance0, g1.linkNoHit]);

await A('Z12 rumorVariantFor：按下标取变体；V1 的 NaN 越界怪癖（返回 undefined）被逐字保留',
    () => J(g1.variants) === J(G.variants) && g1.variants[0].idxs.every(v => v === '夸大版')
        && g1.variants[1].idxs.every(v => v === null),
    [g1.variants, G.variants]);

await A('Z13 rumorStartPending：同一时间只允许一个变化过程（已有 pending → false）；新建写入 need/progress/at 与链路',
    () => J(g1.startPending) === J(G.startPending) && g1.startPending.dup === false && g1.startPending.ok === true
        && g1.startPending.rumor.pending.progress === 0 && g1.startPending.rumor.pending.need === 2,
    [g1.startPending, G.startPending]);

await A('Z14 rumorAdvancePending：未满轮 → 记推进链路返回 null；满轮 → 提交（裂变建子条 / 变异改说法）与 V1 一致',
    () => J(g1.advance) === J(G.advance) && g1.advance.results[2] === null
        && g1.advance.results[1].variant === '添油加醋' && g1.advance.rumors.length === 6,
    [g1.advance, G.advance]);

await A('Z15 rumorCommitPending：裂变派生稳定子 id（主体不变 + 世代 +1）、变异加后缀 +8 发酵、重复分支跳过',
    () => J(g1.commit) === J(G.commit) && g1.commit.results[0].childId === 'rum_13mb7va'
        && g1.commit.rumors.find(x => x.id === 'rum_13mb7va').subject === '传言rum_c1'
        && g1.commit.rumors.find(x => x.id === 'rum_13mb7va').lineage.generation === 1,
    [g1.commit, G.commit]);

await A('Z16 rumorMaybeStartChange：裂变（高发酵 + 有传播者）/ 变异（≥60）/ 不开始 三径与 V1 一致；chance=0 → 全 null',
    () => J(g1.maybeStart) === J(G.maybeStart) && J(g1.maybeStart0) === J(G.maybeStart0)
        && g1.maybeStart.results[0].kind === '裂变' && g1.maybeStart.results[2].kind === '变异' && g1.maybeStart.results[3] === null,
    [g1.maybeStart, G.maybeStart]);

await A('Z17 runRumorEvolve：老化 + 发酵 + 联动 + 酝酿 + 提交 + 阶段重算 + 日期跟新（统计与整库状态与 V1 一致）',
    () => J(g1.evolve) === J({ out: G.evolve.out, rumors: G.evolve.rumors, parallels: G.evolve.parallels, tick: tickView(G.evolve.tick) }) && g1.evolve.out.aged === 1 && g1.evolve.out.links === 3
        && g1.evolve.out.committed === 3 && g1.evolve.out.fissions === 2 && g1.evolve.rumors.length === 6
        && J(g1.evolve.out.fissionsIds) === J(G.evolve.out.fissionsIds),
    [g1.evolve, G.evolve]);

await A('Z18 runRumorEvolveNow：默认 reason=manual，二次演化（无 pending → 不再提交）与 V1 一致',
    () => J(g1.evolveNow) === J(G.evolveNow) && g1.evolveNow.out.reason === 'manual'
        && g1.evolveNow.out.committed === 0 && g1.evolveNow.out.changes === 1,
    [g1.evolveNow, G.evolveNow]);

await A('Z19 rumorEnabled=false → runRumorEvolve 直接 disabled 短路（列表不变）',
    () => J(g1.evolveDisabled) === J(G.evolveDisabled) && g1.evolveDisabled.disabled === true && g1.evolveDisabled.list === 4,
    [g1.evolveDisabled, G.evolveDisabled]);

await A('Z20 演化完成通知：V1 notify({title,text}) → V2 notifyHooks.toast(title + text) 文案逐字符一致',
    () => J(g1.evolveToasts) === J(G.evolveToasts.map(t => [t[0], [t[1], t[2]].filter(Boolean).join(' ')]))
        && g1.evolveToasts.length === 1 && g1.evolveToasts[0][0] === 'success',
    [g1.evolveToasts, G.evolveToasts]);

await A('Z21 rumorTickAdvance：每新楼 1 轮、同楼层不重复计数、满 N 轮触发异步演化并归零；与 V1 一致',
    () => J(g1.tickAdvance) === J({
        ticks: G.tickAdvance.ticks.map(x => ({ floor: x.floor, ret: x.ret, tick: tickView(x.tick) })),
        rumors: G.tickAdvance.rumors,
    }) && g1.tickAdvance.ticks[0].ret.triggered === true && g1.tickAdvance.ticks[1].ret.triggered === false
        && g1.tickAdvance.ticks[2].ret.round === 1 && g1.tickAdvance.ticks[3].ret.triggered === true,
    [g1.tickAdvance, G.tickAdvance]);

await A('Z22 rumorMarkParallelChange：轮次重置 + parallelFloor 记录（非法入参回退 lastFloor）与 V1 一致',
    () => J(g1.parallelChange) === J({ a: tickView(G.parallelChange.a), b: tickView(G.parallelChange.b), stored: tickView(G.parallelChange.stored) })
        && g1.parallelChange.a.parallelFloor === 22 && g1.parallelChange.b.parallelFloor === 9 && g1.parallelChange.stored.round === 0,
    [g1.parallelChange, G.parallelChange]);

await A('Z23 rumorDecayScore / rumorExpired：饱和时间戳 → 旧条 1.0（达阈）/ 新条 0（免疫），与 V1 精确一致',
    () => J(g1.decay.scores) === J(G.decay.scores) && J(g1.decay.expired) === J(G.decay.expired)
        && g1.decay.scores[0][1] === 1 && g1.decay.scores[1][1] === 0,
    [g1.decay.scores, G.decay.scores]);

await A('Z24 runRumorDecay：达阈移除 + id/内容哈希双墓碑 + 计数与剩余（与 V1 一致；墓碑值时间戳不比对）',
    () => J({ ret: g1.decay.ret, rumors: g1.decay.rumors, tombs: g1.decay.tombs, tombsH: g1.decay.tombsH })
        === J({ ret: G.decay.ret, rumors: G.decay.rumors, tombs: G.decay.tombs, tombsH: G.decay.tombsH })
        && g1.decay.ret.removed === 1 && g1.decay.ret.remain === 1 && g1.decay.tombs.length === 1 && g1.decay.tombsH.length === 1,
    [g1.decay, G.decay]);

await A('Z25 runRumorDecay({force:true}) 强制清扫与 V1 一致（无超比例也移除达阈条目）',
    () => J(g1.decayForce) === J(G.decayForce) && g1.decayForce.ret.removed === 1 && g1.decayForce.tombs.length === 1,
    [g1.decayForce, G.decayForce]);

await A('Z26 runRumorDecay 比例触发：条数 > 上限×比例 → triggered=true 但无达阈条目不删除（与 V1 一致）',
    () => J(g1.decayRatio) === J(G.decayRatio) && g1.decayRatio.ret.triggered === true
        && g1.decayRatio.ret.overRatio === true && g1.decayRatio.ret.removed === 0 && g1.decayRatio.rumors.length === 3,
    [g1.decayRatio, G.decayRatio]);

await A('Z27 rumorDecayEnabled=false → runRumorDecay 短路 disabled、rumorExpired 恒 false（与 V1 一致）',
    () => J(g1.decayDisabled) === J(G.decayDisabled) && g1.decayDisabled.ret.reason === 'disabled'
        && g1.decayDisabled.expired.every(v => v === false),
    [g1.decayDisabled, G.decayDisabled]);

await A('Z28 rumorApplyAiDelta：new / spread 保留旧字段 / AI 显式覆盖 / branch-new / 同说法传播 / 显式分裂自命中既有分支（branch-update）/ 新主体分支 与 V1 一致',
    () => J(g1.aiDelta) === J(G.aiDelta)
        && g1.aiDelta.log.map(x => x.ret && x.ret.mode).join(',') === 'new,spread,spread,branch-new,spread,branch-update,branch-new'
        && g1.aiDelta.rumors.length === 3,
    [g1.aiDelta, G.aiDelta]);

await A('Z29 rumorApplyAiDelta 边界：无可解析条目 / 开关关闭 / 缺正文 → null（与 V1 一致）',
    () => J(g1.aiDeltaBad) === J(G.aiDeltaBad) && g1.aiDeltaBad === null
        && J(g1.aiDeltaDisabled) === J(G.aiDeltaDisabled) && g1.aiDeltaDisabled === null
        && J(g1.aiDeltaNoContent) === J(G.aiDeltaNoContent) && g1.aiDeltaNoContent === null,
    [g1.aiDeltaBad, g1.aiDeltaDisabled, g1.aiDeltaNoContent]);

await A('Z30 clearRumors：清空 + 全部留 id/内容哈希墓碑，返回清空条数（与 V1 一致）',
    () => J(g1.clear) === J(G.clear) && g1.clear.n === 2 && g1.clear.rumors.length === 0
        && g1.clear.tombs.length === 2 && g1.clear.tombsH.length === 2,
    [g1.clear, G.clear]);

await A('Z31 rumorInjLine（re-export 自 core/recall.js）：正文 / 阶段 / 发酵度 / 传播者 / 载体 + 已停载体计数与 V1 一致',
    () => J(g1.injLine) === J(G.injLine) && J(g1.injLineEdge) === J(G.injLineEdge)
        && g1.injLine[0][1].indexOf('（另有 1 个载体已停）') > 0 && g1.injLineEdge[0] === '',
    [g1.injLine, G.injLine]);

await A('Z32 flattenRumor：编辑器回填字段（传播者逐行 / 载体 `类型|名称|日期|耐久度` / 标签逗号）与 V1 一致',
    () => J(g1.flatten) === J(G.flatten) && J(g1.flattenEdge) === J(G.flattenEdge)
        && g1.flatten[0].carriersText === '甲:源头\n乙' && g1.flatten[0].mediaText.split('\n').length === 6,
    [g1.flatten, G.flatten]);

// ============================================================
// Y 组：V1 未导出助手（无黄金值 → 语义断言）+ 调度 + 确定性
// ============================================================
await A('Y1 rumorActiveMediaCount 语义：仅计 active!==false 的载体（经 durability=1 的权重等价校验）',
    () => {
        boot(clone(G.inputs.mech), clone(G.inputs.cfg));
        const r = state.rumors[0];
        return rumorActiveMediaCount(r) === 5 && rumorMediaWeight(r) === 15
            && rumorActiveMediaCount({ media: [{ active: false }, { active: true }, null] }) === 1
            && rumorActiveMediaCount(null) === 0 && rumorActiveMediaCount({}) === 0;
    }, '');

await A('Y2 rumorAiHas 语义：「AI 是否显式提供字段」——空串/空数组/undefined/null 视为未提供，中文键名同样识别',
    () => {
        const hit = (raw, keys) => rumorAiHas(raw, keys);
        return hit({ content: 'x' }, ['content']) === true
            && hit({ content: '   ' }, ['content']) === false
            && hit({ content: [] }, ['content']) === false
            && hit({ content: null }, ['content']) === false
            && hit({}, ['content']) === false
            && hit(null, ['content']) === false
            && hit({ '正文': 'x' }, ['content', '正文']) === true
            && hit({ ferment: 0 }, ['ferment']) === true
            && hit({ ferment: '' }, ['ferment']) === false;
    }, '');

await A('Y3 rumorMergeAiInto 语义：未提供字段保留旧值、集合字段并集、机械字段（pending/lineage/uses/chain）不被 AI 覆盖',
    () => {
        const prev = {
            id: 'rum_x', subject: '旧主体', content: '旧说法。', objectivity: '客观', stage: '发酵', ferment: 66,
            pending: { kind: '变异', need: 2, progress: 1, target: '夸大版', at: '2020-05-01' },
            carriers: [{ who: '甲', role: '源头' }], media: [{ type: '报刊', name: '临江日报', at: '2020-05-01', durability: 2 }],
            chain: [{ at: '2020-05-01', round: 1, kind: '起源', from: '', to: '旧主体', note: '起源' }],
            lineage: { rootId: 'rum_x', parentId: '', children: [], generation: 0 },
            parallelRefs: ['p1'], source: '正文', date: '2020-05-01', tags: ['甲'], uses: 3, floorStart: 1, floorEnd: 2,
            createdAt: 111,
        };
        const n0 = {
            id: 'rum_x', subject: '新主体', content: '新说法。', objectivity: '主观', stage: '异变', ferment: 10,
            carriers: [{ who: '乙', role: '传播者' }], media: [{ type: '书', name: '账本', at: '2020-06-01', durability: 1 }],
            chain: [], lineage: { rootId: 'zzz', parentId: 'q', children: ['c1'], generation: 5 },
            parallelRefs: ['p2'], tags: ['乙'], floorStart: 5, floorEnd: 9, source: '侧写', date: '2020-06-01',
        };
        const keep = rumorMergeAiInto(clone(prev), clone(n0), {});
        const over = rumorMergeAiInto(clone(prev), clone(n0), { content: 'AI 新说法。', source: 'AI来源' });
        const stageGiven = rumorMergeAiInto(clone(prev), clone(n0), { '阶段': '异变' });
        const bare = rumorMergeAiInto(null, clone(n0), { content: 'x' });
        return keep.content === '旧说法。' && keep.objectivity === '客观' && keep.source === '正文' && keep.date === '2020-05-01'
            && keep.ferment === 66 && keep.stage === '发酵' && keep.title === keep.subject && keep.text === keep.content
            && J(keep.tags) === J(['甲', '乙']) && J(keep.carriers.map(c => c.who)) === J(['甲', '乙'])
            && J(keep.media.map(m => m.name)) === J(['临江日报', '账本']) && J(keep.parallelRefs) === J(['p1', 'p2'])
            && keep.pending && keep.pending.progress === 1 && keep.lineage.rootId === 'rum_x' && keep.uses === 3
            && keep.floorStart === 1 && keep.floorEnd === 9 && keep.createdAt === 111 && keep.chain.length === 1
            && over.content === '新说法。' && over.source === '侧写'   // AI 给字段 → 取本次归一化值，不回退旧值
            // V1 口径：AI 给了 stage 也只是触发「按发酵度重算」，阶段字面量不生效（发酵度 66 → 扩散）
            && stageGiven.stage === '扩散'
            && bare.subject === '新主体' && bare.id === 'rum_x';
    }, '');

await A('Y4 延迟调度：scheduleRumorEvolve / scheduleRumorDecay 经 timerHooks 3000ms 入队且同种定时器去重；关闭开关则不入队',
    () => J(g1.schedule) === J(g2.schedule) && g1.schedule.evTimers === 1 && g1.schedule.deTimers === 1
        && g1.schedule.disabledAdds === 0 && g1.schedule.runsAfter === g1.schedule.runsBefore + 1,
    [g1.schedule, g2.schedule]);

await A('Y5 mergeRumorListBy（model 层导出）：按签名并集、保留先出现者、条目级去重',
    () => J(mergeRumorListBy(['a', 'b'], ['b', 'c'], x => String(x))) === J(['a', 'b', 'c'])
        && J(mergeRumorListBy(null, ['x'], x => String(x))) === J(['x'])
        && J(mergeRumorListBy([{ t: 1 }, { t: 1 }, { t: 2 }], [], x => String(x.t))) === J([{ t: 1 }, { t: 2 }]),
    '');

await A('Y6 模块契约：导入零副作用（导入时 state 仍为 null）且导出清单完整（37 函数 + 2 常量；v2.70.0 新增时间判断拆解）', () => {
    const want = ['clearRumors', 'flattenRumor', 'mergeRumorListBy', 'rumorActiveMediaCount', 'rumorAdvancePending', 'rumorAgeMedia', 'rumorAgeSpeed', 'rumorAiHas', 'rumorApplyAiDelta', 'rumorChainPush', 'rumorCommitPending', 'rumorDayDiff', 'rumorDecayBreakdown', 'rumorDecayScore', 'rumorEnabledOn', 'rumorEveryRounds', 'rumorExpired', 'rumorFermentDelta', 'rumorInjLine', 'rumorMarkParallelChange', 'rumorMaybeStartChange', 'rumorMediaWeight', 'rumorMergeAiInto', 'rumorNeedRounds', 'rumorParallelLink', 'rumorParallelLinkScore', 'rumorRoll', 'rumorStartPending', 'rumorStoryDate', 'rumorTickAdvance', 'rumorTickState', 'rumorVariantFor', 'runRumorDecay', 'runRumorEvolve', 'runRumorEvolveNow', 'scheduleRumorDecay', 'scheduleRumorEvolve'];
    const consts = ['RUMOR_AGE_HORIZON_DAYS', 'RUMOR_AGE_MAX_BOOST'];
    const have = Object.keys(RU).sort();
    return STATE_AT_IMPORT === null && J(have) === J(want.concat(consts).sort()) && have.length === 39
        && want.every(k => typeof RU[k] === 'function') && consts.every(k => typeof RU[k] === 'number');
}, '');

await A('Y7 确定性：全量 V2 结果连跑两次逐字节一致（时间戳已由投影剔除）',
    () => J(g1) === J(g2) && J(g1).length > 20000, '');

R.done();
