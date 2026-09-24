// ============================================================
// 单元测试 · B8-6c-4 计划/悬念修复管道（V1 v1.113 计划冗余合并 + v1.140 悬念聚类核对）
//   （与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-plan-repair.json —— 悬念机械去重 / 聚类选组与游标 / 提示词（逐字符）/
//   悬念按编号精确应用（合并·修订·了结·删除·关联重挂·统计）/ 计划按 #P 编号合并 / `runPlanSuspRepair`
//   全链路（AI 桩）/ AI 无改动分支 / 仅计划分支 / 空库。
// 覆盖：
//   `suspenseMergeExact` / `buildPlanSuspRepairPrompt` / `applyPlanSuspMerge` / `applySuspenseMergeGroups` /
//   `runPlanSuspRepair`；另含 V2 编排与接线：`aiBusy` 互斥、空库、AI 非法 JSON、面板 `plans` 分页按钮与动作、
//   `FTT.*` 调试入口与无 hook 降级。
// ⚠️ 与 V1 一致的既有缺陷（如实固化，见 docs/P8v-B8-6c-4状态与计划悬念修复.md）：
//   提示词合同里的中文键「合并」不在 `CN_KEY_MAP` → `runPlanSuspRepair` 里计划合并分支在真实 AI 回包下不命中
//   （I7 专门固化该现象；`applyPlanSuspMerge` 直接用英文 `merge` 键时功能正常，见 I6）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks, setIdentityView,
} from '../../core/model/runtime.js';
import { defaultCfg, normalizeDeltaKeys } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { GROUP_REPAIR_SPECS, groupPick } from '../../core/group-repair.js';
import {
    suspenseMergeExact, buildPlanSuspRepairPrompt, applyPlanSuspMerge, applySuspenseMergeGroups, runPlanSuspRepair,
} from '../../core/plan-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-plan-repair.json'), 'utf8'));
const R = makeReporter('plan-repair-golden B8-6c-4 计划/悬念修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
let toasts = [];
let aiText = '{}';
let aiCalls = 0;
/** 场景装载：替换 state + 清空墓碑 + 对齐删除留痕基线（V1 saveState 内建 tombstoneSweep；
 *  V2 由宿主 `adapters/store.js#saveStateNow` 承担 → 测试桩按同一口径注入，保证墓碑与 V1 逐字段可比） */
function setState(stateLike) {
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    state.deleted = {}; state.deletedH = {}; state.repairCursor = state.repairCursor || {};
    entryIndexInit();
    return state;
}
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    // oracle 固定阈值/上限/字数上限 → V2 同值，保证确定可比（cfgPatch 可再覆盖）
    cfg.suspenseRepairSim = 0.45; cfg.suspenseRepairMaxClusters = 3; cfg.suspenseRepairMaxItems = 24; cfg.suspenseRepairMaxClusterSize = 8;
    cfg.repairFloors = 10; cfg.relOrphanAction = 'keep';
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(3);
    setIdentityView({ characterName: '角色甲' });
    setPersistHooks({
        // V1 `saveState()` = 建当前索引 + tombstoneSweep + 写库；V2 同口径（持久化由宿主承担）
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    aiText = '{}'; aiCalls = 0;
    // 面板/编排路径共用 AI 钩子；feedText 固定为 oracle 捕获的投喂文本（V1 `buildFeedFloorText(10)`）
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => G.feedText, busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return setState(stateLike);
}
const suspView = () => (state.suspense || []).map(x => ({
    id: x.id, title: x.title, content: x.content, date: x.date, tags: x.tags, keywords: x.keywords,
    status: x.status, importance: x.importance, uses: x.uses, floorStart: x.floorStart, floorEnd: x.floorEnd,
}));
const planView = () => (state.plans || []).map(x => ({ id: x.id, content: x.content, status: x.status, tags: x.tags, uses: x.uses }));
const linkView = () => (state.links || []).map(x => ({ id: x.id, dim: x.dim, refId: x.refId, who: x.who, how: x.how, deviation: x.deviation, at: x.at }));
const tombIds = (dim) => Object.keys((state.deleted || {})[dim] || {}).sort();
const tombHashes = (dim) => Object.keys((state.deletedH || {})[dim] || {}).sort();
const pickView = (p) => ({
    entries: p.entries.map(e => ({ n: e.n, group: e.group, idx: e.idx, id: e.id, title: e.title, content: e.content, date: e.date, tags: e.tags, sim: e.sim, defect: e.defect, single: e.single })),
    clusters: p.clusters, picked: p.picked, defects: p.defects, singles: p.singles, total: p.total, cursor: p.cursor,
});
/** V1 `toastLogGet()` 的 `{kind,title,text}` → V2 `notifyHooks.toast(text, kind)` 的 `[kind, 'title text']`
 *  （V1 `notify('repair', …)` 的 toastr 类型是 warning；V2 notifyHooks 只认 info/success/warning/error） */
const wfToasts = (list) => list.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);

// ============================================================
// I 组：计划/悬念修复内核 —— 与 V1 逐项比对
// ============================================================
R.assert('I1 suspenseMergeExact 悬念机械去重（零 AI，**不写墓碑**）：同正文哈希并一条 —— 保留首 id、uses 累加、重要度取大、标题取非空者、标签并集（≤8）、日期取最早；非同正文零合并 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioSusp);
    const me = suspenseMergeExact();
    const got = { merged: me.merged, suspense: suspView(), tombs: tombIds('suspense') };
    boot(G.inputs.scenarioPlanOnly);
    const none = { merged: suspenseMergeExact().merged, suspense: suspView() };
    const u1 = (state.suspense || []).find(x => x.id === 'w1') || {};
    return J(got) === J(G.mergeExact) && J(none) === J(G.mergeExactNone)
        && me.merged === 1 && (state.suspense || []).length === 1 && u1.id === 'w1';
})(), G.mergeExact);

R.assert('I2 groupPick(suspense) + 游标：逐条 entries（n/group/idx/id/title/content/date/tags/sim/defect/single）与 clusters/picked/defects/total 及 `state.repairCursor`（含 `suspenseRing` 孤例轮询）写回 —— 与 V1 一致（悬念域专用 `sampleSingles` 经 group-repair 复用）', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.suspense);
    const got = pickView(p);
    const cursor = clone(state.repairCursor);
    return J(got) === J(G.pick) && J(cursor) === J(G.cursorAfter)
        && p.picked === 2 && p.entries.length === 6 && p.defects === 1 && p.singles === 1
        && p.entries[0].sim === 1 && GROUP_REPAIR_SPECS.suspense.sampleSingles === true;
})(), G.pick);

R.assert('I3 buildPlanSuspRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（近期正文段 + 相关组/缺陷/逐一核对三种分组标题 + #S 编号清单 + 进行中计划 #P 清单 + 输出契约）；`{entries:[]}` 形态一致', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.suspense);
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { planSuspRepair: '（测试用计划悬念修复模板）' });
    const got = buildPlanSuspRepairPrompt(p);
    const empty = buildPlanSuspRepairPrompt({ entries: [] });
    return J(got) === J(G.prompt) && J(empty) === J(G.promptEmpty)
        && got.length === 2 && got[0].role === 'system' && String(got[0].content).indexOf('只输出 JSON') >= 0
        && String(got[1].content).indexOf('【未解悬念·待核对清单') >= 0
        && String(got[1].content).indexOf('【进行中的计划（仅作「了结」判定：不合并、不修订、不新增）】') >= 0
        && String(got[1].content).indexOf('#P0 找到失踪的货船。') >= 0;
})(), G.prompt.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('I4 applySuspenseMergeGroups 全量应用：合并（保留主条 id、uses 累加、重要度取大、标签并集、日期最早）/ 修订（内容·标签，3-8 个才生效并清空 keywords）/ 了结（计入 `stats.suspenseResolved`）/ 删除（不计已了结）/ 关联行重挂（retargeted，被并入悬念的关联改挂保留主条）—— counts + 悬念 + 关联 + 统计 + 墓碑与 V1 逐字段一致', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const pick = groupPick(GROUP_REPAIR_SPECS.suspense);
    const r = applySuspenseMergeGroups(normalizeDeltaKeys(clone(G.inputs.sDelta)), pick);
    const got = { counts: r, suspense: suspView(), links: linkView(), stats: clone(state.stats), tombs: tombIds('suspense'), hashes: tombHashes('suspense') };
    return J(got) === J(G.applySusp) && r.fused === 1 && r.revised === 2 && r.closed === 1 && r.deleted === 2
        && r.retargeted === 1 && state.stats.suspenseResolved === 1;
})(), G.applySusp.counts);

R.assert('I5 applySuspenseMergeGroups 边界：空 delta / 空 entries / null pick / 编号不存在与了结删除同号 —— 四种边界与 V1 逐字段一致（skipped 计数口径相同）', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const got = {
        empty: applySuspenseMergeGroups({}, { entries: [{ n: 1, id: 'u1' }] }),
        noEntries: applySuspenseMergeGroups({ '悬念库': { '合并': [] } }, { entries: [] }),
        nullPick: applySuspenseMergeGroups({ '悬念库': { '合并': [{ '保留': 1, '并入': [2] }] } }, null),
        unknownN: applySuspenseMergeGroups({ suspense: { remove: [99], close: [98] } }, { entries: [{ n: 1, id: 'u1' }] }),
    };
    return J(got) === J(G.applySuspEdge) && got.unknownN.skipped === 2 && got.empty.fused === 0;
})(), G.applySuspEdge);

R.assert('I6 applyPlanSuspMerge 计划按 #P 编号合并（只接收 plans 段）：保留主条、移除被合并条目、合并后正文覆盖；标签/状态不变 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioSusp);
    const r = applyPlanSuspMerge(clone(G.inputs.pDelta));
    const got = { r, plans: planView(), susp: suspView() };
    const p1 = (state.plans || []).find(x => x.id === 'p1') || {};
    return J(got) === J(G.applyPlanMerge) && r.mergedPlans === 1 && r.removed === 1
        && p1.content === '找到失踪的货船并查明敲门者。' && (state.plans || []).length === 2
        && J(suspView()) === J(G.applyPlanMerge.susp);
})(), G.applyPlanMerge.r);

R.assert('I7 applyPlanSuspMerge 边界（V1 原样）：空 merge 段 / 保留编号越界 → 零改动；**同时传入 suspense 段时仍会处理**（v1.140 起调用方只传 plans 段）—— 与 V1 oracle 一致', (() => {
    boot(G.inputs.scenarioSusp);
    const got = {
        noMerge: applyPlanSuspMerge({ plans: {} }),
        badKeep: applyPlanSuspMerge({ plans: { merge: [{ '保留编号': 9, '合并编号': [0] }] } }),
        suspenseIgnored: applyPlanSuspMerge({ suspense: { merge: [{ '保留编号': 0, '合并编号': [1] }] } }),
    };
    return J(got) === J(G.applyPlanMergeEdge) && got.suspenseIgnored.mergedSusps === 1 && got.noMerge.removed === 0;
})(), G.applyPlanMergeEdge);

R.assert('I8（V1 既有缺陷固化）真实 AI 回包的「计划库.合并」经 `normalizeDeltaKeys` 后落在 `delta.plans["合并"]`，而 `applyPlanSuspMerge` 只读 `delta.plans.merge` → 计划合并分支**不命中**（`mergedP === 0`），与 V1 oracle 全链路结果逐字段一致', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const ai = clone(G.inputs.ai);
    const delta = normalizeDeltaKeys(JSON.parse(JSON.stringify(ai['计划库'])));
    // 归一化后：中文键「了结」→ close（命中，走 mergeDelta），「合并」不在 CN_KEY_MAP → 仍是「合并」（不命中）
    const noMerge = applyPlanSuspMerge({ plans: delta });
    const withMerge = applyPlanSuspMerge({ plans: { merge: clone(G.inputs.pDelta.plans.merge) } });
    return noMerge.mergedPlans === 0 && noMerge.removed === 0
        && withMerge.mergedPlans === 1 && withMerge.removed === 1
        && Array.isArray(delta.close) && delta['合并'] !== undefined && delta.merge === undefined;
})(), 'V1 既有缺陷：中文键「合并」未进 CN_KEY_MAP');

// ============================================================
// P 组：V2 编排（runPlanSuspRepair 全链路）
// ============================================================
await A('P1 runPlanSuspRepair 全链路：① 悬念机械去重 → ①-b 关联层机械维护 → ②③ 聚类选组 → ④ AI（桩）→ 悬念按编号 + 计划了结/合并 + `mergeDelta` 落库 → `saveState` —— 返回结构 / 悬念·计划·关联·统计 / 墓碑 / 通知文案与 V1 逐项一致', async () => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { planSuspRepair: '（测试用计划悬念修复模板）' });
    aiText = JSON.stringify(G.inputs.ai);
    const r = await runPlanSuspRepair();
    const got = {
        res: {
            made: r.made, closedP: r.closedP, closedS: r.closedS, mergedP: r.mergedP, mergedS: r.mergedS,
            removedDup: r.removedDup, revised: r.revised, deleted: r.deleted, merged: r.merged,
            groups: r.groups, checked: r.checked, keys: Object.keys(r).sort(),
        },
        suspense: suspView(), plans: planView(), links: linkView(), stats: clone(state.stats),
        tombsS: tombIds('suspense'), tombsP: tombIds('plans'), toasts, aiCalls,
    };
    const want = Object.assign({}, clone(G.run), { toasts: wfToasts(G.run.toasts) });
    return J(got) === J(want) && aiCalls === 1 && r.made === 1 && r.closedP === 1 && r.closedS === 1
        && r.mergedP === 0 && r.mergedS === 1          // 计划合并不命中（V1 既有缺陷，I8 已固化）
        && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('高相关悬念组 1/1 组') >= 0;
}, G.run.res);

await A('P2 runPlanSuspRepair AI 判无可了结/合并：走 `changed=0` 分支（warning 提示 + skipped），数据只保留机械段成果 —— 与 V1 逐项一致', async () => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    aiText = '{}';
    const r = await runPlanSuspRepair();
    const got = {
        res: { made: r.made, skipped: r.skipped, groups: r.groups, checked: r.checked, merged: r.merged, keys: Object.keys(r).sort() },
        suspense: suspView(), plans: planView(), toasts, aiCalls,
    };
    const want = Object.assign({}, clone(G.runNoChange), { toasts: wfToasts(G.runNoChange.toasts) });
    return J(got) === J(want) && aiCalls === 1 && r.made === 0 && r.skipped === true && r.merged === 1
        && toasts[1][0] === 'warning' && String(toasts[1][1]).indexOf('均仍有效、无冗余重复') >= 0;
}, G.runNoChange.res);

await A('P3 runPlanSuspRepair 无未解悬念、只有进行中计划：本次 0 条悬念可核对仍发 1 次 AI（提示「本次无高相关悬念组」），AI 无改动 → skipped —— 与 V1 逐项一致', async () => {
    boot(G.inputs.scenarioPlanOnly);
    state.repairCursor = {};
    const r = await runPlanSuspRepair();
    const got = {
        res: { made: r.made, skipped: r.skipped, merged: r.merged, groups: r.groups, keys: Object.keys(r).sort() },
        suspense: suspView(), toasts, aiCalls,
    };
    const want = Object.assign({}, clone(G.runPlanOnly), { toasts: wfToasts(G.runPlanOnly.toasts) });
    return J(got) === J(want) && aiCalls === 1 && r.made === 0 && r.skipped === true
        && String(toasts[0][1]).indexOf('本次无高相关悬念组') >= 0;
}, G.runPlanOnly.res);

await A('P4 runPlanSuspRepair 空库（无进行中计划且无未解悬念）：直接返回 skipped 并提示无可修复条目（不触发 AI）', async () => {
    boot({ plans: [], suspense: [] });
    const r = await runPlanSuspRepair();
    return J({ res: r, toasts: wfToasts(toasts) }) === J(Object.assign({}, clone(G.runEmpty), { toasts: wfToasts(G.runEmpty.toasts) }))
        && r.made === 0 && r.skipped === true && aiCalls === 0
        && String(toasts[0][1]).indexOf('无可修复条目') >= 0;
}, G.runEmpty.res);

await A('P5 runPlanSuspRepair 长任务在途拒绝（aiBusy 互斥语义，同 core/repair.js#runRepair）：返回 blocked，不改动任何数据', async () => {
    boot(G.inputs.scenarioSusp);
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: '{}' }; }, feedText: () => G.feedText, busy: () => true });
    const before = J(suspView()) + J(planView());
    const r = await runPlanSuspRepair();
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => G.feedText, busy: () => false });
    return r.made === 0 && r.blocked === true && (J(suspView()) + J(planView())) === before && aiCalls === 0
        && toasts.length === 1 && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('修复进行中') >= 0;
}, '');

await A('P6 runPlanSuspRepair AI 未返回有效 JSON：不崩溃、AI 段零改动、机械去重成果仍保留 → 走 `changed=0` 分支（V2 编排不虚报）', async () => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    aiText = '这不是 JSON';
    const r = await runPlanSuspRepair();
    return aiCalls === 1 && r.made === 0 && r.skipped === true && r.merged === 1
        && (state.suspense || []).length === 5                    // 机械去重 6 → 5，AI 段零改动
        && (state.suspense || []).every(x => x.id !== 'u2') && toasts.length === 2;
}, '');

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 计划悬念分页渲染 V1 同款「🔧 修复计划/悬念」按钮（有进行中计划或未解悬念才显示；文案与 title 逐字对齐）', (() => {
    boot(G.inputs.scenarioSusp);
    openPanel('plans'); setPanelHooks2({});
    const html = panelBodyHtml('plans');
    const hasBtn = html.indexOf('data-ftt-action="planSuspRepair"') >= 0 && html.indexOf('🔧 修复计划/悬念') >= 0
        && html.indexOf('title="了结已完成/已揭晓，合并重复并归并关联"') >= 0;
    boot({ plans: [], suspense: [] });
    openPanel('plans');
    const empty = panelBodyHtml('plans');
    boot({ plans: [{ id: 'z1', content: '已完结。', status: 'closed' }], suspense: [] });
    openPanel('plans');
    const closedOnly = panelBodyHtml('plans');
    return hasBtn && empty.indexOf('data-ftt-action="planSuspRepair"') < 0
        && closedOnly.indexOf('data-ftt-action="planSuspRepair"') < 0;   // 只有已完结/已揭晓 → 不显示
})(), '');

await A('U2 面板动作 planSuspRepair 可达：走 runPlanSuspRepair 全链路并把结果写回面板 `state.note`（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { planSuspRepair: '（测试用计划悬念修复模板）' });
    aiText = JSON.stringify(G.inputs.ai);
    openPanel('plans'); setPanelHooks2({});
    const r = await panelAction('planSuspRepair', {});
    const note = String(panelState().note || '');
    return r.ok === true && !!r.planSuspRepair && r.made === 1 && r.action === 'planSuspRepair' && aiCalls === 1
        && note.indexOf('计划/悬念修复：') >= 0 && note.indexOf('已了结计划 1 项') >= 0 && note.indexOf('已揭晓悬念 1 项') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：suspenseMergeExact / planSuspRepairPrompt / planSuspMergeApply / suspenseRepairApply / planSuspRepair', (() => {
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    const on = installDevtools({
        suspenseMergeExact: () => suspenseMergeExact(),
        planSuspRepairPrompt: (p) => buildPlanSuspRepairPrompt(p),
        planSuspMergeApply: (d) => applyPlanSuspMerge(d),
        suspenseRepairApply: (d, p) => applySuspenseMergeGroups(d, p),
        planSuspRepair: (o) => runPlanSuspRepair(o),
    });
    const F = globalThis.FTT;
    const me = F.suspenseMergeExact();
    const pk = groupPick(GROUP_REPAIR_SPECS.suspense);
    const prompt = F.planSuspRepairPrompt(pk);
    const applied = F.suspenseRepairApply({ '悬念库': { '修订': [{ '编号': 1, '字段': '内容', '值': '修订后的内容。' }] } }, pk);
    const pm = F.planSuspMergeApply({ plans: { merge: [{ '保留编号': 0, '合并编号': [1], '合并后正文': '合并后。' }] } });
    const ok = on === true && me.merged === 1 && Array.isArray(prompt) && prompt.length === 2
        && applied.revised === 1 && pm.mergedPlans === 1
        && typeof F.planSuspRepair === 'function' && typeof F.suspenseMergeExact === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.planSuspRepair 无 hook 时按约定降级（不抛错），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenarioSusp);
    installDevtools({});
    const noHook = await globalThis.FTT.planSuspRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenarioSusp);
    state.repairCursor = {};
    installDevtools({ planSuspRepair: (o) => runPlanSuspRepair(o) });
    const r = await globalThis.FTT.planSuspRepair({ aiText: JSON.stringify(G.inputs.ai) });
    uninstallDevtools();
    return degraded && r.made === 1 && r.mergedS === 1;
}, '');

un();
R.done();
