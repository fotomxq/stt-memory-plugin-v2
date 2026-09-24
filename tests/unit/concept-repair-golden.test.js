// ============================================================
// 单元测试 · B8-6c-2 概念修复管道（与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-concept-repair.json —— 转调等价 / 提示词逐字符 / 应用层全量 / 机械合并 / 全链路 / 各早退与异常分支
// 覆盖：
//   conceptRelatedness / conceptClusters / conceptPickClusters（= 通用引擎 concepts spec 的转调，逐字节等价）；
//   buildConceptRepairPrompt（system + user **逐字符**，含「【相关组 N】」「【缺陷条目…】」分节、正文 300 字截断、空 pick → null）；
//   applyConceptMergeGroups（合并保 id/uses、标签并集并清 keywords、来源/日期兜底、修订字段闭集、删除 + 墓碑、
//     拒收/跳过计数、内容 hardCap、垃圾正文拒收、英文键兼容、**不拆「概念库」包装**的 V1 原样行为）；
//   conceptMergeExact（同内容 `contentDedupeArray` + 同名称 `repairMergeByName`，**不写墓碑**）；
//   runConceptRepair（全链路 / 无高相关组零 AI / 有机械合并的早退 / 空库 / 互斥 / 非法 JSON / 包装键零改动）；
//   另含 V2 编排与接线：面板概念分页按钮显隐 + `conceptRepair` 动作可达、`FTT.*` 入口齐备与无 hook 降级。
// 说明：V1 `saveState` 会调 `tombstoneSweep` 自动给消失条目留墓碑，故本测试的 `saveState` 桩同样调用
//   `tombstoneSweep()`，并在 `boot()` 后调 `entryIndexInit()` 对齐基线 —— 与 oracle 侧的 `F.entryIndexInit()` 一一对应。
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
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import {
    GROUP_REPAIR_SPECS, groupRelatedness, groupClusters, groupPick,
    conceptMergeExact, conceptRelatedness, conceptClusters, conceptPickClusters,
    buildConceptRepairPrompt, applyConceptMergeGroups, runConceptRepair,
} from '../../core/group-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-concept-repair.json'), 'utf8'));
const R = makeReporter('concept-repair-golden B8-6c-2 概念修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const DIMS = ['concepts', 'memories', 'items', 'suspense'];

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
/** 记录最近一次 NOTIFY（V1 `toastLogGet` 的 V2 等价：notifyHooks.toast(text, kind)） */
let toasts = [];
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    // oracle 固定四域阈值/上限 → V2 同值，保证确定可比
    DIMS.forEach((pre) => { cfg[pre + 'RepairSim'] = 0.45; cfg[pre + 'RepairMaxClusters'] = 3; cfg[pre + 'RepairMaxItems'] = 24; cfg[pre + 'RepairMaxClusterSize'] = 8; });
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    // V1 `saveState` = 删除留痕（tombstoneSweep）+ 落盘；测试里同样触发留痕（oracle 侧同口径）
    setPersistHooks({ saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; }, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai' }), feedText: () => '', busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    // oracle 侧每个场景都调 `F.entryIndexInit()` → 这里同口径对齐删除留痕基线
    entryIndexInit();
    return state;
}
/** 概念条目投影（与 oracle 的投影字段一致） */
const conView = () => (state.concepts || []).map(x => ({
    id: x.id, name: x.name, content: x.content, source: x.source, date: x.date,
    tags: x.tags, keywords: x.keywords, uses: x.uses, floorStart: x.floorStart, floorEnd: x.floorEnd,
}));
const pickView = (p) => ({ entries: p.entries, clusters: p.clusters, picked: p.picked, defects: p.defects, singles: p.singles, total: p.total, cursor: p.cursor });
const tombsOf = () => Object.keys((state.deleted || {}).concepts || {}).sort();
/** V1 通知三元件 → V2 单串通知（`repair` → `warning`，与 `core/repair.js` 同映射） */
const wantToasts = (rows) => rows.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);

// ============================================================
// C 组：概念修复 —— 与 V1 逐项比对
// ============================================================
R.assert('C1 conceptRelatedness / conceptClusters 与 V1 一致（sims/basis/tagRich + 连通分量 idxs/size/maxSim/basis）', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const rel = conceptRelatedness(), cl = conceptClusters();
    return J(rel) === J(G.relatedness) && J(cl) === J(G.clusters) && cl.length === 2
        && cl[0].idxs.join(',') === '0,1' && cl[1].idxs.join(',') === '2,3'
        && rel.sims.join(',') === '1,1,1,1,0' && rel.basis[4] === 'text' && rel.tagRich === true;
})(), G.clusters);

R.assert('C2 conceptPickClusters 与 V1 一致（entries 逐条 + picked/defects/total/cursor + 游标写回），且与通用引擎 groupPick 逐字节等价', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = conceptPickClusters();
    const got = pickView(p);
    boot(G.inputs.scenario); state.repairCursor = {};
    const pe = pickView(groupPick(GROUP_REPAIR_SPECS.concepts));
    return J(got) === J(G.pick) && J(pe) === J(G.pick) && J(state.repairCursor) === J(G.cursorAfter)
        && p.entries.length === 5 && p.picked === 2 && p.defects === 1 && p.total === 2
        && p.entries[4].group === 3 && p.entries[4].defect === '空占位/无意义文本';
})(), G.pick);

R.assert('C3 conceptRelatedness/Clusters 与通用引擎转调等价（同场景同结果，V1 `conceptXxx = groupXxx(SPECS.concepts)` 原样）', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const same = J(conceptRelatedness()) === J(groupRelatedness(GROUP_REPAIR_SPECS.concepts))
        && J(conceptClusters()) === J(groupClusters(GROUP_REPAIR_SPECS.concepts));
    boot(G.inputs.scenario); state.repairCursor = {};
    const a = pickView(conceptPickClusters());
    boot(G.inputs.scenario); state.repairCursor = {};
    const b = pickView(groupPick(GROUP_REPAIR_SPECS.concepts));
    return same && G.sameAsEngine.relatedness === true && G.sameAsEngine.clusters === true
        && G.sameAsEngine.pick === true && J(a) === J(b) && J(a) === J(G.pick);
})(), G.sameAsEngine);

R.assert('C4 buildConceptRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（含相关度 2 位小数 / 标签 / 来源 / 日期 / 缺陷分节）', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = conceptPickClusters();
    const got = buildConceptRepairPrompt(p);
    return J(got) === J(G.prompt) && got.length === 2 && got[0].role === 'system' && got[1].role === 'user'
        && got[0].content.indexOf('只输出 JSON，不要解释。') >= 0
        && got[1].content.indexOf('【相关组 1】') >= 0 && got[1].content.indexOf('【相关组 2】') >= 0
        && got[1].content.indexOf('【缺陷条目（与相关性无关，不参与合并，可修订或删除）】') >= 0
        && got[1].content.indexOf('共 2 组 / 5 条') >= 0;
})(), G.prompt.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('C5 buildConceptRepairPrompt：手工 pick（400 字正文 → 300 字截断、tags 为 null、来源/日期空 → （无）、sim 0.8765 → 0.88）逐字符与 V1 一致；无 entries → null', (() => {
    const got = buildConceptRepairPrompt(clone(G.manualPickInputs));
    const noEntries = buildConceptRepairPrompt({ entries: [], picked: 0 });
    const third = String(got[1].content).split('\n').filter(l => l.indexOf('   内容：') === 0);
    return J(got) === J(G.promptManual) && got.length === 2 && noEntries === null
        && G.promptNoEntries === null && G.promptEmptyPick === null
        && String(got[1].content).indexOf('相关度：0.88') >= 0 && String(got[1].content).indexOf('相关度：0.50') >= 0
        && third.length === 4 && third[0].length === '   内容：'.length + 300 && third[1].length === '   内容：短内容。'.length
        && String(got[1].content).indexOf('来源：（无） ｜ 日期：（无）') >= 0;
})(), G.promptManual[1].content.slice(0, 200));

R.assert('C6 applyConceptMergeGroups 全量应用：合并（保 id/uses、标签并集∪AI 标签并清空 keywords、来源/日期采用）+ 修订（内容/标签）+ 删除 + 墓碑 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const pick = conceptPickClusters();
    const r = applyConceptMergeGroups({
        '合并': [{ '保留': 1, '并入': [2], '名称': '天机阁', '内容': '情报机构及其总部（合并）。', '来源': '正文', '日期': '2020-01-05', '标签': ['情报', '组织', '机构', '暗线'] }],
        '修订': [{ '编号': 4, '字段': '内容', '值': '断魂崖北坡四季有雾。' }, { '编号': 4, '字段': '标签', '值': '地点,山崖,险地,断崖' }],
        '删除': [5],
    }, pick);
    const got = { counts: r, concepts: conView(), tombs: tombsOf(), beforeIds: G.apply.beforeIds };
    const c1 = state.concepts.find(x => x.id === 'c1');
    return J(got) === J(G.apply) && r.fused === 1 && r.removed === 1 && r.revised === 2 && r.deleted === 2 && r.skipped === 0
        && c1.uses === 3 && J(c1.tags) === J(['情报', '组织', '机构', '暗线']) && J(c1.keywords) === J([])
        && (state.concepts || []).length === 3;
})(), G.apply.counts);

R.assert('C7 applyConceptMergeGroups 合并语义：AI 不给名称/内容 → 保留主条；来源/日期仅在主条为空时兜底；**楼层不并集、重要度不取大**（与记忆域不同，V1 原样）', (() => {
    boot({ concepts: [
        { id: 'b1', name: '旧概念', content: '主条内容。', source: '', date: '', tags: [], uses: 2, floorStart: 1, floorEnd: 2 },
        { id: 'b2', name: '别名概念', content: '被并入的内容。', source: '侧写', date: '2019-05-05', tags: ['甲', '乙', '丙'], uses: 3, floorStart: 3, floorEnd: 4 },
    ] });
    const r = applyConceptMergeGroups({ '合并': [{ '保留': 1, '并入': [2] }] }, { entries: [{ n: 1, id: 'b1' }, { n: 2, id: 'b2' }] });
    const got = { pickEmpty: 0, counts: r, concepts: conView(), tombs: tombsOf() };
    const b1 = state.concepts[0];
    return J(got) === J(G.applyKeepPrimary) && r.fused === 1 && r.removed === 1
        && b1.name === '旧概念' && b1.content === '主条内容。' && b1.source === '侧写' && b1.date === '2019-05-05'
        && J(b1.tags) === J(['甲', '乙', '丙']) && b1.uses === 5
        && Number(b1.floorStart) === 1 && Number(b1.floorEnd) === 2;                 // 楼层不并集（V1 概念域原样）
})(), G.applyKeepPrimary.counts);

R.assert('C8 applyConceptMergeGroups 拒收/跳过：编号不存在 / 字段非法（归属不可改）/ 标签数不合规（仅 2 个）/ 日期非法 / 删除越界 → skipped 6，数据零改动；空 delta / 空 pick / 非对象 delta → 全 0', (() => {
    boot(G.inputs.scenario);
    const pick = conceptPickClusters();
    const r = applyConceptMergeGroups({
        '合并': [{ '保留': 99, '并入': [98] }],
        '修订': [{ '编号': 99, '字段': '内容', '值': 'x' }, { '编号': 1, '字段': '归属', '值': '角色丙' }, { '编号': 1, '字段': '标签', '值': '仅两个,标签' }, { '编号': 1, '字段': '日期', '值': '不是日期' }],
        '删除': [97],
    }, pick);
    const got = { counts: r, concepts: conView(), tombs: tombsOf() };
    const noopTags = applyConceptMergeGroups({ '修订': [{ '编号': 1, '字段': '标签', '值': '情报/组织/机构' }] }, pick);
    const empty = applyConceptMergeGroups({}, pick);
    const emptyPick = applyConceptMergeGroups({ '合并': [] }, { entries: [] });
    const nonObject = applyConceptMergeGroups({ '合并': 'x' }, pick);
    const english = applyConceptMergeGroups({ merge: [{ keep: 1, merge: [2] }] }, pick);
    return J(got) === J(G.applyBad) && r.skipped === 6 && r.fused === 0 && r.revised === 0 && r.deleted === 0
        && J(noopTags) === J(G.applyNoopTags) && noopTags.skipped === 1               // 标签未变 → 计 skipped（非 revised）
        && J(empty) === J(G.applyEmpty) && J(emptyPick) === J(G.applyEmptyPick) && J(nonObject) === J(G.applyNonObject)
        && J(english) === J(G.applyEnglishKeys) && english.fused === 1;
})(), G.applyBad.counts);

R.assert('C9 applyConceptMergeGroups 内容 hardCap（`cfg.dimCharLimits.concepts`=320 硬截断）+ 垃圾正文（「待补充」）被拒 —— 与 V1 一致', (() => {
    boot({ concepts: [{ id: 'h1', name: '长文概念', content: '短。', source: '正文', date: '2020-03-03', tags: ['甲', '乙', '丙'], keywords: ['旧关键词'], uses: 1 }] });
    const r = applyConceptMergeGroups({
        '修订': [
            { '编号': 1, '字段': '内容', '值': '长'.repeat(5000) },
            { '编号': 1, '字段': '名称', '值': '长文概念（改）' },
            { '编号': 1, '字段': '来源', '值': '侧写' },
            { '编号': 1, '字段': '日期', '值': '2021-12-31' },
        ],
    }, { entries: [{ n: 1, id: 'h1' }] });
    const got = { counts: r, hardCap: G.applyHardCap.hardCap, contentLen: String(state.concepts[0].content).length, concepts: conView() };
    boot({ concepts: [{ id: 'h2', name: '垃圾概念', content: '正常内容。', source: '正文', date: '2020-03-03', tags: ['甲', '乙', '丙'], uses: 1 }] });
    const rg = applyConceptMergeGroups({ '修订': [{ '编号': 1, '字段': '内容', '值': '待补充' }] }, { entries: [{ n: 1, id: 'h2' }] });
    const gotG = { counts: rg, concepts: conView() };
    return J(got) === J(G.applyHardCap) && r.revised === 4 && got.contentLen === Number(cfg.dimCharLimits.concepts) && got.contentLen === 320
        && J(gotG) === J(G.applyGarbage) && rg.skipped === 1 && state.concepts[0].content === '正常内容。';
})(), G.applyHardCap.counts);

R.assert('C10 conceptMergeExact：同内容（`contentDedupeArray`）+ 同名称（`repairMergeByName`）两类机械合并各自触发；uses 累加、标签并集、楼层并集、**不写墓碑** —— 与 V1 一致', (() => {
    boot({ concepts: [
        { id: 'x1', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'x2', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 2, floorStart: 2, floorEnd: 3 },
        { id: 'x3', name: '断魂崖', content: '险峻山崖。', source: '正文', date: '2020-01-04', tags: [], uses: 1, floorStart: 4, floorEnd: 4 },
        { id: 'x4', name: '断魂崖', content: '另一段描述。', source: '侧写', date: '', tags: ['地点'], uses: 5, floorStart: 5, floorEnd: 9 },
        { id: 'x5', name: '无关条目', content: '独立内容。', source: '正文', date: '2020-01-06', tags: ['甲'], uses: 1, floorStart: 6, floorEnd: 6 },
    ] });
    const me = conceptMergeExact();
    const got = { merged: me.merged, notes: me.notes, concepts: conView(), tombs: tombsOf() };
    const sq = state.concepts.find(x => x.id === 'x3');
    return J(got) === J(G.mergeExact) && me.merged === 2 && J(me.notes) === J(['同内容 1', '同名称 1'])
        && got.tombs.length === 0                                              // 机械合并本身不写墓碑（V1 原样）
        && sq.uses === 6 && J(sq.tags) === J(['地点']) && sq.floorStart === 4 && sq.floorEnd === 9;
})(), G.mergeExact);

R.assert('C11 conceptMergeExact 边界：空库（0 条）/ 单条 → merged 0 且 notes 空、数据不动', (() => {
    boot({ concepts: [] });
    const e = conceptMergeExact();
    const emptyGot = { r: e, count: (state.concepts || []).length, notes: e.notes };
    boot({ concepts: [{ id: 'y1', name: '唯一概念', content: '唯一。', source: '正文', date: '', tags: [], uses: 1 }] });
    const s = conceptMergeExact();
    const got = { r: s, concepts: conView() };
    return J(emptyGot) === J(G.mergeExactEmpty)
        && J(got) === J(G.mergeExactSingle) && e.merged === 0 && s.merged === 0 && state.concepts.length === 1;
})(), G.mergeExactSingle);

// ============================================================
// P 组：V2 编排（runConceptRepair 全链路）
// ============================================================
await A('P1 runConceptRepair 全链路：① 机械合并 → ②③ 聚类选组 → ④ AI（fetch 桩）→ ⑤ 按编号精确应用（合并/修订/删除/墓碑）—— 返回结构 / 落库 / 墓碑 / 游标 / 提示文案逐字段与 V1 一致', async () => {
    boot(G.inputs.scenario);
    let aiCalls = 0;
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: G.inputs.ai }; }, feedText: () => '', busy: () => false });
    const r = await runConceptRepair();
    const flow = { made: r.made, before: r.before, after: r.after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, merged: r.merged, groups: r.groups, groupsTotal: r.groupsTotal, checked: r.checked };
    return aiCalls === 1 && J(flow) === J(G.flow) && J(conView()) === J(G.flowConcepts)
        && J(tombsOf()) === J(G.flowTombs) && J(state.repairCursor) === J(G.flowCursor)
        && J(toasts) === J(wantToasts(G.flowToasts))
        && flow.fused === 1 && flow.removed === 1 && flow.revised === 2 && flow.deleted === 2 && flow.groups === 2
        && flow.checked === 5;
}, G.flow);

await A('P2 runConceptRepair 无高相关组早退：**零 AI**（一次也不发），文案区分「有机械合并 / 无机械合并」，made 口径 = 机械合并条数（V1 原样非布尔）', async () => {
    boot({ concepts: [
        { id: 'q1', name: '独立概念甲', content: '完全无关的甲事。', source: '正文', date: '2020-01-01', tags: ['甲组', '甲类', '甲项'], uses: 1 },
        { id: 'q2', name: '独立概念乙', content: '完全无关的乙事。', source: '正文', date: '2020-01-02', tags: ['乙组', '乙类', '乙项'], uses: 1 },
    ] });
    let aiCalls = 0;
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: G.inputs.ai }; }, feedText: () => '', busy: () => false });
    const r = await runConceptRepair();
    const first = { made: r.made, skipped: r.skipped, merged: r.merged, groups: r.groups, before: r.before, after: r.after };
    const okNoGroup = aiCalls === 0 && J(first) === J(G.earlyExit) && J(toasts) === J(wantToasts(G.earlyExitToasts));
    // 有机械合并（同名称）→ 早退文案变化 + made = 合并条数
    boot({ concepts: [
        { id: 'm1', name: '同一概念', content: '甲段内容。', source: '正文', date: '2020-01-01', tags: [], uses: 1 },
        { id: 'm2', name: '同一概念', content: '乙段内容。', source: '正文', date: '2020-01-02', tags: [], uses: 2 },
    ] });
    aiCalls = 0;
    const r2 = await runConceptRepair();
    const second = { made: r2.made, skipped: r2.skipped, merged: r2.merged, groups: r2.groups, before: r2.before, after: r2.after, concepts: conView(), tombs: tombsOf() };
    return okNoGroup && aiCalls === 0 && J(second) === J(G.earlyExitMerged)
        && r2.made === 1 && J(toasts) === J(wantToasts(G.earlyExitMergedToasts));
}, G.earlyExit);

await A('P3 runConceptRepair AI 非法 JSON：不崩溃、不改动任何数据，机械合并成果保留（落库 + 墓碑按 V1 删除留痕口径）', async () => {
    boot({ concepts: [
        { id: 'n1', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 1 },
        { id: 'n2', name: '天机阁总部', content: '情报机构总部。', source: '正文', date: '2020-01-02', tags: ['情报', '组织', '机构'], uses: 2 },
        { id: 'n3', name: '情报机构', content: '收集情报的机构。', source: '正文', date: '2020-01-03', tags: ['情报', '组织', '机构'], uses: 1 },
        { id: 'n4', name: '情报机构', content: '同一名称（机械合并）。', source: '正文', date: '2020-01-04', tags: [], uses: 1 },
    ] });
    const r = await runConceptRepair({ aiText: '这不是 JSON' });
    const got = { made: r.made, before: r.before, after: r.after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, merged: r.merged, groups: r.groups, groupsTotal: r.groupsTotal, checked: r.checked, concepts: conView(), tombs: tombsOf() };
    return J(got) === J(G.noJson) && Number(r.fused) === 0 && Number(r.deleted) === 0 && r.merged === 1
        && state.concepts.length === 3 && J(tombsOf()) === J(G.noJson.tombs)
        && J(toasts) === J(wantToasts(G.noJsonToasts));
}, G.noJson);

await A('P4 runConceptRepair AI 返回「概念库」包装：V1 概念域**不拆包** → 取不到操作、零改动（如实固化，不做「顺手修正」）', async () => {
    boot(G.inputs.scenario);
    const r = await runConceptRepair({ aiText: JSON.stringify({ '概念库': { '合并': [{ '保留': 1, '并入': [2], '名称': '不该生效' }] } }) });
    const got = { made: r.made, before: r.before, after: r.after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, groups: r.groups, concepts: conView(), tombs: tombsOf() };
    return J(got) === J(G.wrapped) && r.fused === 0 && r.deleted === 0
        && state.concepts.length === 5 && J(toasts) === J(wantToasts(G.wrappedToasts));
}, G.wrapped);

await A('P5 runConceptRepair 空库 / 长任务在途拒绝（aiBusy 互斥）：分别返回 skipped / blocked，数据零改动，提示与 V1 逐字一致', async () => {
    boot({ concepts: [] });
    const r0 = await runConceptRepair();
    const emptyOk = !r0.made && r0.skipped === true && J(toasts) === J(wantToasts(G.emptyToasts));
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: G.inputs.ai }), feedText: () => '', busy: () => true });
    const before = J(conView());
    const rb = await runConceptRepair();
    setAiHooks({ callAi: async () => ({ ok: false }), feedText: () => '', busy: () => false });
    return emptyOk && rb.made === 0 && rb.blocked === true && J(conView()) === before
        && J(conView()) === J(G.busyConcepts) && J(toasts) === J(wantToasts(G.busyToasts));
}, G.busyFlow);

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 概念分页渲染 V1 同款「🔧 修复概念」按钮（有概念时显示、无概念时隐藏；文案与 title 逐字对齐）', (() => {
    boot(G.inputs.scenario);
    openPanel('concepts'); setPanelHooks2({});
    const html = panelBodyHtml('concepts');
    const hasBtn = html.indexOf('data-ftt-action="conceptRepair"') >= 0 && html.indexOf('🔧 修复概念') >= 0
        && html.indexOf('title="修复概念错乱/冗余，并融合相似概念"') >= 0;
    boot({ concepts: [] });
    openPanel('concepts');
    const empty = panelBodyHtml('concepts');
    return hasBtn && empty.indexOf('data-ftt-action="conceptRepair"') < 0
        && empty.indexOf('该类目暂无条目') >= 0;
})(), '');

await A('U2 面板动作 conceptRepair 可达：走 runConceptRepair 全链路并把结果写回面板 note（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: G.inputs.ai }), feedText: () => '', busy: () => false });
    openPanel('concepts'); setPanelHooks2({});
    const r = await panelAction('conceptRepair', {});
    const note = String(panelState().note || '');
    return r.ok === true && !!r.conceptRepair && r.made === 1 && r.action === 'conceptRepair'
        && note.indexOf('概念修复：') >= 0 && note.indexOf('高相关组 2/2 组') >= 0
        && note.indexOf('合并 1 组（-1 条）') >= 0 && note.indexOf('修订 2 条') >= 0 && note.indexOf('删除 2 条') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：conceptMergeExact / conceptRelatedness / conceptClusters / conceptPickClusters / conceptRepairPrompt / conceptRepairApply / conceptRepair', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const on = installDevtools({
        conceptMergeExact: () => conceptMergeExact(), conceptRelatedness: () => conceptRelatedness(),
        conceptClusters: () => conceptClusters(), conceptPickClusters: () => conceptPickClusters(),
        conceptRepairPrompt: (p) => buildConceptRepairPrompt(p), conceptRepairApply: (d, p) => applyConceptMergeGroups(d, p),
        conceptRepair: (o) => runConceptRepair(o),
    });
    const F = globalThis.FTT;
    const rel = F.conceptRelatedness();
    const cl = F.conceptClusters();
    const p = F.conceptPickClusters();
    const prompt = F.conceptRepairPrompt(p);
    const applied = F.conceptRepairApply({ '修订': [{ '编号': 1, '字段': '名称', '值': '天机阁（改）' }] }, p);
    const ok = on === true && rel.sims.length === 5 && cl.length === 2 && p.picked === 2
        && Array.isArray(prompt) && prompt.length === 2 && applied.revised === 1
        && state.concepts.find(x => x.id === 'c1').name === '天机阁（改）'
        && typeof F.conceptMergeExact === 'function' && typeof F.conceptRepair === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.conceptRepair 无 hook 时按约定降级（不抛错，返回 no-hook），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenario);
    installDevtools({});
    const noHook = await globalThis.FTT.conceptRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenario);
    installDevtools({ conceptRepair: (o) => runConceptRepair(o) });
    const r = await globalThis.FTT.conceptRepair({ aiText: G.inputs.ai });
    uninstallDevtools();
    return degraded && r.made === 1 && r.fused === 1;
}, '');

un();
R.done();
