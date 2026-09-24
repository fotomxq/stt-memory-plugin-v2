// ============================================================
// 单元测试 · B8-6a 修复管线第 1 段（JS 机械清理）（与**真实 V1 插件**逐项比对 + 编排/接线）
// 黄金样本：tests/fixtures/v1-golden-repair.json（oracle = 真实 V1 插件 v1.206；楼层号固定 400）
// 覆盖：repairIsGarbage / repairBannedOf / repairMergeByName（同名称并集 + 货币数量合计 + 字段只增不减）/
//   repairMergeDedupe（内容哈希并集 + 同类并集 + 状态主体归并）/ repairPruneGarbage（垃圾 + 已关闭残留 + 墓碑）/
//   repairDecayPass（状态衰退 + 记忆遗忘 + 平行衰退 + 状态条数钳制）/ repairBatchTags / repairReport；
//   另含 V2 编排与接线：runRepairMech（前→后计数 + 报告 + 修复日志）、频率/上限闸门、`repair` 动作（第 2/3 段如实说明）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    repairIsGarbage, repairBannedOf, repairNameKey, repairMergeByName, repairMergeDedupe, repairPruneGarbage,
    repairDecayPass, repairBatchTags, repairReport, repairLogPush, repairTotalCount,
    setRepairHooks, latestFloorHash, autoRepairOpDue, bumpRepairOp, autoRepairTake, runRepairMech,
} from '../../core/repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-repair.json'), 'utf8'));
const R = makeReporter('repair-golden B8-6a 修复管线第 1 段（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
setRepairHooks({ floorHash: (i) => ('h' + i) });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setRepairHooks({ floorHash: (i) => ('h' + i) });
    return state;
}
const dims = () => ({
    atoms: state.atoms.map(e => [e.id, String(e.text).slice(0, 12)]),
    currentStates: state.currentStates.map(e => [e.id, e.subject, e.value]),
    items: state.items.map(e => [e.id, e.name]),
    concepts: state.concepts.map(e => [e.id, e.name, String(e.content || '').slice(0, 12)]),
    snapshots: state.snapshots.map(e => [e.id, e.name, String(e.appearance || '')]),
    npcs: state.npcs.map(e => [e.id, e.name]),
    scenes: state.scenes.map(e => [e.id, e.name, e.pathStr || '']),
});

// ============================================================
// H 组：与 V1 逐项比对
// ============================================================
R.assert('H1 垃圾判定 repairIsGarbage（minKey 4 / 2 两档）与模糊措辞 repairBannedOf：13 + 3 组输入与 V1 一致', (() => {
    boot({});
    const bad = G.inputs.texts.filter((t, i) => repairIsGarbage(t, 4) !== G.garbage[i][1] || repairIsGarbage(t, 2) !== G.garbage[i][2]);
    const badBanned = G.inputs.banned.filter((t, i) => J(repairBannedOf(t)) !== J(G.banned[i][1]));
    return bad.length === 0 && badBanned.length === 0 && repairNameKey('角色甲 · 甲') === '角色甲甲';
})(), G.inputs.texts.map(t => [t, repairIsGarbage(t, 4), repairIsGarbage(t, 2)]));

R.assert('H2 同名称并集 repairMergeByName（物品）：2 组归并、字段只增不减、货币数量合计、uses 累计、楼层区间并集 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const merged = repairMergeByName('items', (e) => e.name);
    const got = state.items.map(e => [e.id, e.name, e.desc || '', Number(e.qty) || 0, Number(e.uses) || 0, e.floorStart, e.floorEnd, e.tags || []]);
    return merged === G.mergeByNameItems.merged && J(got) === J(G.mergeByNameItems.items);
})(), (() => { boot(G.inputs.scenario); const m = repairMergeByName('items', (e) => e.name); return { merged: m, items: state.items.map(e => [e.id, e.name]) }; })());

R.assert('H3 机械合并 repairMergeDedupe：内容哈希并集 1 + 场景并集 2 = 8 条（含同类并集与状态主体归并），notes 与逐维结果与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const d = repairMergeDedupe();
    return d.merged === G.dedupe.merged && J(d.notes) === J(G.dedupe.notes) && J(dims()) === J(G.dedupeState);
})(), (() => { boot(G.inputs.scenario); const d = repairMergeDedupe(); return { merged: d.merged, notes: d.notes, dims: dims() }; })());

R.assert('H4 垃圾清理 repairPruneGarbage：垃圾 4 条 + 已关闭残留 2 条 = 6 条，notes 与墓碑键与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const p = repairPruneGarbage();
    const gotState = {
        atoms: state.atoms.map(e => e.id), memories: state.memories.map(e => e.id),
        plans: state.plans.map(e => e.id), suspense: state.suspense.map(e => e.id),
        deleted: Object.keys(state.deleted || {}).reduce((acc, k) => { acc[k] = Object.keys((state.deleted || {})[k] || {}).sort(); return acc; }, {}),
    };
    const want = clone(G.pruneState);
    want.deleted = Object.keys(want.deleted).reduce((acc, k) => { acc[k] = Object.keys(want.deleted[k] || {}).sort(); return acc; }, {});
    return p.deleted === G.prune.deleted && J(p.notes) === J(G.prune.notes) && J(gotState) === J(want);
})(), (() => { boot(G.inputs.scenario); return repairPruneGarbage(); })());

await A('H5 衰退清扫 repairDecayPass：状态衰退 + 记忆遗忘 + 平行衰退 + 状态条数钳制（本例记忆遗忘 1 条），统计与状态与 V1 一致', async () => {
    boot(G.inputs.decayScenario, { stateDecayEnabled: true, stateDecayRatio: 0.5, stateDecayCutoff: 0.95, memoryForgetEnabled: true, memoryForgetRatio: 0.5, memoryForgetCutoff: 0.9, storeMinMemories: 1, storeMinStates: 0 });
    const d = await repairDecayPass();
    return J({ deleted: d.deleted, notes: d.notes }) === J(G.decay) && state.memories.map(e => e.id).join(',') === G.decayState.memories.join(',');
}, (() => ({ decay: G.decay })));

R.assert('H6 报告口径 repairBatchTags + repairReport：标签去重上限 12；三组报告文案与 V1 逐字符一致', (() => {
    boot({});
    const tags = repairBatchTags(G.inputs.batchEntries);
    const r1 = repairReport({ before: 100, after: 92, checked: 20, groups: 4, groupsTotal: 9, defects: 3, submittedTags: ['甲', '乙'], fused: 2, removed: 5, revised: 3, deleted: 1, merged: 8, purged: 2, swept: 4, skipped: 1, queueLeft: 6, extra: '备注' });
    const r2 = repairReport({ before: 10, after: 10 });
    const r3 = repairReport({ before: 5, after: 4, extra: '仅机械' });
    return J(tags) === J(G.batchTags) && r1 === G.report1 && r2 === G.report2 && r3 === G.report3;
})(), (() => { boot({}); return repairReport({ before: 100, after: 92, checked: 20, groups: 4, groupsTotal: 9 }); })());

// ============================================================
// P 组：V2 编排与闸门
// ============================================================
await A('P1 runRepairMech：第 1 段五步编排（机械合并 → 遗忘清扫 → 条数上限 → 垃圾清理 → 衰退清扫）的前后计数与逐步统计与 V1 一致 + 报告/日志', async () => {
    boot(G.inputs.scenario, { lowUseForgetEnabled: true, lowUseForgetMinItems: 20, lowUseForgetMinAvg: 5, lowUseForgetMinFloors: 300, lowUseForgetEveryFloors: 40, lowUseForgetMaxDelete: 1, stateDecayEnabled: true, memoryForgetEnabled: true });
    const before = repairTotalCount();
    const r = await runRepairMech({ silent: true, cause: '单元测试' });
    const after = repairTotalCount();
    const log = Array.isArray(state.repairLog) ? state.repairLog : [];
    const got = {
        before: r.before, after: r.after,
        merged: r.stage1.merged, sweepSwept: Number((r.sweep || {}).swept) || 0, capCut: Number((r.caps || {}).cut) || 0,
        pruned: Number((r.pruned || {}).deleted) || 0, decayed: Number((r.decay || {}).deleted) || 0,
        notes: (r.stage1.notes || []).slice(),
    };
    return before === G.mechFlow.before && after === G.mechFlow.after && J(got) === J(G.mechFlow)
        && r.report.indexOf('修复前 ' + before + ' 条 → 修复后 ' + after + ' 条') >= 0
        && log.length === 1 && log[0].cause === '单元测试' && Number(log[0].ms) >= 0 && log[0].merged === G.mechFlow.merged;
}, (() => ({ mech: G.mechFlow })));

await A('P1b runRepairMech 幂等：同一批数据再跑一次 → 无合并/清理（固定规则不会被重复触发）', async () => {
    boot(G.inputs.scenario, { lowUseForgetEnabled: true, lowUseForgetMinFloors: 300, lowUseForgetMinItems: 20, lowUseForgetMinAvg: 5, lowUseForgetEveryFloors: 40 });
    await runRepairMech({ silent: true });
    const again = await runRepairMech({ silent: true });
    return again.stage1.merged === 0 && again.stage1.deleted === 0 && again.sweep.swept === 0 && again.caps.cut === 0;
}, '');

R.assert('P2 频率与上限闸门：autoRepairOpDue（每 N 次提取）/ bumpRepairOp / autoRepairTake（同楼层至多 N 次；哈希变化或手动重置）', (() => {
    boot({}, { autoRepairEveryOps: 3, maxAutoRepairRounds: 2 });
    const due0 = autoRepairOpDue();
    bumpRepairOp(); bumpRepairOp();
    const due2 = autoRepairOpDue();
    bumpRepairOp();
    const due3 = autoRepairOpDue();
    // 上限：同楼层哈希
    setRepairHooks({ floorHash: () => 'hash-A' });
    const t1 = autoRepairTake(false);          // 首次：n=1
    const t2 = autoRepairTake(false);          // 第二次：n=2
    const t3 = autoRepairTake(false);          // 达上限 → 拒绝
    const t4 = autoRepairTake(true);           // 手动 → 重置并放行
    setRepairHooks({ floorHash: () => 'hash-B' });
    const t5 = autoRepairTake(false);          // 哈希变化 → 重置
    return due0 === false && due2 === false && due3 === true
        && t1.allowed === true && t1.n === 1 && t2.allowed === true && t2.n === 2 && t3.allowed === false && t3.n === 2
        && t4.allowed === true && t4.n === 0 && t5.allowed === true && t5.n === 1;
})(), '');

R.assert('P3 楼层面板哈希 latestFloorHash：经注入钩子取值（内核不直读宿主聊天）；空哈希 → (empty)、无楼层 → (none)', (() => {
    boot({});
    setRepairHooks({ floorHash: () => 'abc' });
    const a = latestFloorHash();
    setRepairHooks({ floorHash: () => '' });
    const b = latestFloorHash();
    setLastMessageId(-1);
    const c = latestFloorHash();
    setLastMessageId(400);
    return a === 'abc' && b === '(empty)' && c === '(none)';
})(), '');

R.assert('P4 修复日志 repairLogPush：新→旧、上限 5 条', (() => {
    boot({});
    for (let i = 1; i <= 7; i++) repairLogPush({ tag: 'r' + i });
    const log = state.repairLog || [];
    return log.length === 5 && log[0].tag === 'r7' && log[4].tag === 'r3' && Number(log[0].ts) > 0;
})(), '');

// ============================================================
// U 组：界面接线（总览「🛠 自动修复」→ 第 1 段执行 + 第 2/3 段如实说明）
// ============================================================
await A('U1 总览工具行含 V1 同款「🛠 自动修复」按钮（紧贴「⚡ 立即 AI 摘要」右侧）', async () => {
    boot(G.inputs.scenario);
    openPanel('overview');
    setPanelHooks2({});
    const html = panelBodyHtml('overview');
    const iSummary = html.indexOf('data-ftt-action="summary"');
    const iRepair = html.indexOf('data-ftt-action="repair"');
    const iExtract = html.indexOf('data-ftt-action="extractNow"');
    return iSummary >= 0 && iRepair > iSummary && iExtract > iRepair && html.indexOf('🛠 自动修复') >= 0;
}, '');

await A('U2 面板动作 repair：三段式编排（机械清理 → 候选筛选 → AI 修订）；无 AI 可用时如实回报', async () => {
    boot(G.inputs.scenario, { repairAutoAi: true, maxAutoRepairRounds: 2 });
    openPanel('overview');
    setPanelHooks2({});
    setRepairHooks({ floorHash: () => 'hash-X' });
    const r1 = await panelAction('repair', {});
    const st = panelState();
    const r3 = await panelAction('repair', {});      // 手动路径每次都重置 → 恒放行
    return r1.ok === true && r1.repair && r1.repair.stage1 && r1.aiPending === undefined
        && String(st.note).indexOf('自动修复：机械清理') >= 0
        && String(st.note).indexOf('候选 ') >= 0
        && r3.repair && J(r1.repair.stage1.merged) === J(G.mechFlow.merged);
}, '');

un();
R.done();
