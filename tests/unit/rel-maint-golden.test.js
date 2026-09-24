// ============================================================
// 单元测试 · B8-6b+ 修复第 1 段收尾「关联层机械维护」（与**真实 V1 插件**逐项比对 + 编排/接线）
// 黄金样本：tests/fixtures/v1-golden-rel-maint.json（oracle = 真实 V1 插件 v1.206 `relRepairMaint` / `mergeRelMaint`）
// 覆盖：relRepairMaint（孤儿行清扫 + 墓碑 / 同 (dim,refId,who) 去重合并 + how 可靠度排序 /
//   角色名按档案全名归一（who + from，稳定 id 重算）/ 悬空引用清理（概念按名称、其余按 id、memRefs·sourceRefs 裁剪）/
//   how·偏差非法值归一 / 降级统计 / 孤儿条目处置 keep·clean·public）、relMaintCounts / relMaintTouched /
//   relMaintSummary / logRelMaint / mergeRelMaint（AI 前·后两次维护口径合并）；
//   另含 V2 编排：runRepair 在 AI 修订后**再跑一次**关联维护并合并两次口径。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { setRepairHooks, runRepair } from '../../core/repair.js';
import {
    relRepairMaint, relMaintCounts, relMaintTouched, relMaintSummary, logRelMaint, mergeRelMaint,
} from '../../core/rel-maint.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-rel-maint.json'), 'utf8'));
const R = makeReporter('rel-maint-golden B8-6b+ 关联层机械维护（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

const dbg = [];
let aiText = '';
setChatHooks({ dbgLog: (...a) => dbg.push(a) });

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
    setRepairHooks({ floorHash: () => 'hash-R' });
    setAiHooks({ callAi: async () => ({ ok: true, text: aiText }), feedText: () => '', busy: () => false });
    setChatHooks({ dbgLog: (...a) => dbg.push(a) });
    dbg.length = 0; aiText = '';
    return state;
}
const emptyLike = () => ({
    version: '2.17.0',
    state: { time: '', date: '2020-06-01', location: '', sceneFocus: null }, protagonist: {},
    items: [], plans: [], suspense: [], scenes: [], npcs: [], atoms: [], currentStates: [], snapshots: [],
    memories: [], concepts: [], parallels: [], currencies: [], plotSegments: [], rumors: [], links: [],
    vars: {}, varTemplates: {}, summaries: [], processedFloors: [], lastKnownFloor: -1,
    stats: { plansClosed: 0, suspenseResolved: 0 }, deleted: {}, deletedH: {}, updatedAt: 0,
});
/** 关联行快照（键序与 oracle 完全一致，便于整体 JSON 比对） */
const linkSnap = (r) => ({
    id: r.id, dim: r.dim, refId: r.refId, who: r.who || '', how: r.how || '', deviation: r.deviation || '',
    conceptRef: r.conceptRef || '', atomRef: r.atomRef || '', planRef: r.planRef || '', suspenseRef: r.suspenseRef || '',
    memRefs: clone(r.memRefs || []), sourceRefs: clone(r.sourceRefs || []), public: !!r.public,
    note: r.note || '', from: r.from || '', uses: Number(r.uses) || 0,
});
const linkSnaps = () => (state.links || []).map(linkSnap);
/** 明细行规范化（只取该行真正有意义的字段，避免键序差异误报） */
const rowKeys = (rows, keys) => (rows || []).map(r => keys.map(k => String(r[k] === undefined ? '' : r[k])).join('|'));
const sweptRows = (d) => rowKeys(d && d.sweptRows, ['dim', 'refId', 'who']);
const dedupedRows = (d) => rowKeys(d && d.dedupedRows, ['dim', 'refId', 'who']);
const renamedRows = (d) => rowKeys(d && d.renamedRows, ['dim', 'refId', 'field', 'from', 'to']);
const staleRows = (d) => rowKeys(d && d.staleRows, ['dim', 'refId', 'field', 'value']);
const tombs = () => Object.keys((state.deleted || {}).links || {}).sort();

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================
await A('R1 keep：孤儿行清扫 / 去重 / 悬空引用 / 归一 / 降级计数逐字段与 V1 一致（action=keep）', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    const got = {
        action: m.action, swept: m.swept, deduped: m.deduped, renamed: m.renamed, staleRefs: m.staleRefs,
        normalized: m.normalized, demoted: m.demoted, orphanItems: m.orphanItems, publicized: m.publicized, changed: m.changed,
    };
    const want = G.keep;
    return J(got) === J({
        action: want.action, swept: want.swept, deduped: want.deduped, renamed: want.renamed, staleRefs: want.staleRefs,
        normalized: want.normalized, demoted: want.demoted, orphanItems: want.orphanItems, publicized: want.publicized, changed: want.changed,
    });
}, 'keep 计数');

await A('R2 keep：明细（清扫行 / 去重行 / 改名行 / 悬空引用）与 V1 一致', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    const d = m.details, w = G.keep.details;
    return J([sweptRows(d), dedupedRows(d), renamedRows(d), staleRows(d)])
        === J([sweptRows(w), dedupedRows(w), renamedRows(w), staleRows(w)]);
}, 'keep 明细');

await A('R3 keep：清理后的关联表逐行与 V1 一致（合并行 how 取更可靠者 + 字段并集 + 悬空引用清空）', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'keep' });
    relRepairMaint();
    return J(linkSnaps()) === J(G.keepLinks);
}, 'keep 关联表');

await A('R4 keep：被清理 / 去重的行写墓碑（跨端不复活）', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'keep' });
    relRepairMaint();
    return J(tombs()) === J(G.keepTombs);
}, 'keep 墓碑');

await A('R5 keep：relMaintCounts / relMaintTouched / relMaintSummary 口径与 V1 一致', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    return J(relMaintCounts(m)) === J(G.keepCounts)
        && relMaintTouched(m) === G.keepTouched
        && String(relMaintSummary(m)) === G.keepSummary;
}, 'keep 口径');

await A('R6 public：先清扫再给「一条关联都没有」的条目补公开锚行（平行事件恒不参与）', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'public' });
    const m = relRepairMaint();
    const got = { action: m.action, publicized: m.publicized, changed: m.changed, orphanItems: m.orphanItems };
    return J(got) === J(G.public);
}, 'public 计数');

await A('R7 public：补出的公开锚行（dim/refId/kind/note）与 V1 一致', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'public' });
    relRepairMaint();
    const got = (state.links || []).filter(r => r && r.public && !r.who).map(r => [r.dim, r.refId, r.kind || '', r.note || '']);
    return J(got) === J(G.publicLinks);
}, 'public 锚行');

await A('R8 关闭关联层（relLinkEnabled=false）：一行不动、变更标记为 false', () => {
    boot(G.inputs.scenario, { relLinkEnabled: false, relOrphanAction: 'public' });
    const m = relRepairMaint();
    return J({ changed: m.changed, swept: m.swept, deduped: m.deduped }) === J(G.disabled)
        && state.links.length === G.inputs.scenario.links.length;
}, 'disabled');

await A('R9 空库：changed=false / orphanItems=0 / 摘要为空串 / Touched=false', () => {
    boot(emptyLike(), { relLinkEnabled: true });
    const m = relRepairMaint();
    return J({
        changed: m.changed, orphanItems: m.orphanItems, summary: String(relMaintSummary(m)), touched: relMaintTouched(m),
    }) === J(G.none);
}, '空库');

await A('R10 clean：只清扫孤儿关联（不补公开锚行），摘要只列实际动作', () => {
    boot(G.inputs.scenario, { relLinkEnabled: true, relOrphanAction: 'clean' });
    const m = relRepairMaint();
    return J({ action: m.action, swept: m.swept, publicized: m.publicized, orphanItems: m.orphanItems, changed: m.changed }) === J(G.clean)
        && String(relMaintSummary(m)) === G.cleanSummary;
}, 'clean');

await A('R11 角色名按档案全名归一：who 与 from 同时回填 + 稳定 id 重算 + 摘要', () => {
    const st = clone(G.inputs.scenario);
    st.links = [{ id: 'lnk_r1', dim: 'memories', refId: 'm1', who: '角色', from: '角色', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 }];
    boot(st, { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    return m.renamed === G.rename.renamed && m.changed === G.rename.changed
        && J(m.details.renamedRows) === J(G.rename.details)
        && J(relMaintCounts(m)) === J(G.rename.counts)
        && J((state.links || []).map(r => ({ id: r.id, who: r.who || '', from: r.from || '' }))) === J(G.renameLinks)
        && String(relMaintSummary(m)) === G.renameSummary;
}, 'name-rename');

await A('R12 只有孤儿条目（无可清理项）：changed=false / Touched=false / 摘要走「仍有 N 条无关联条目」分支', () => {
    const st = emptyLike();
    st.memories = [{ id: 'm9', title: '记忆九', content: '内容', date: '2020-01-01', importance: 0.5, uses: 1, floorStart: 1, floorEnd: 2, tags: [] }];
    boot(st, { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    return J({
        changed: m.changed, swept: m.swept, orphanItems: m.orphanItems, summary: String(relMaintSummary(m)), touched: relMaintTouched(m),
    }) === J(G.orphanOnly);
}, 'orphan-only');

await A('R13 mergeRelMaint：两次维护计数相加 / 明细拼接 / 摘要取合并口径；空值守卫返回另一侧', () => {
    boot(clone(G.inputs.scenario), { relLinkEnabled: true, relOrphanAction: 'keep' });
    const mA = relRepairMaint();
    // 模拟 AI 合并后：新增一条孤儿行 + 删除悬念条目（使锚行 suspenseRef 悬空）
    state.links.push({ id: 'lnk_new_gone', dim: 'memories', refId: 'm-gone', who: '角色丙', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 3000 });
    state.suspense = (state.suspense || []).filter(x => x && x.id !== 'u1');
    const mB = relRepairMaint();
    const mrg = mergeRelMaint(mA, mB);
    const got = { counts: relMaintCounts(mrg), summary: String(relMaintSummary(mrg)), details: mrg.details, changed: mrg.changed };
    const want = G.merged;
    const same = J(got) === J(want)
        && J([sweptRows(mrg.details), dedupedRows(mrg.details), renamedRows(mrg.details), staleRows(mrg.details)])
        === J([sweptRows(want.details), dedupedRows(want.details), renamedRows(want.details), staleRows(want.details)]);
    // 空值守卫：任一侧缺失时返回另一侧
    return same && mergeRelMaint(null, mA) === mA && mergeRelMaint(mA, null) === mA && mergeRelMaint(null, null) === null;
}, 'mergeRelMaint');

await A('R14 logRelMaint：有改动时写调试日志并返回 true；无改动时静默返回 false', () => {
    boot(clone(G.inputs.scenario), { relLinkEnabled: true, relOrphanAction: 'keep' });
    const m = relRepairMaint();
    const on = logRelMaint('单元', m), logCount = dbg.length;
    const quiet = relRepairMaint();
    const off = logRelMaint('单元', quiet);
    return on === true && logCount > 0 && off === false && dbg.length === logCount;
}, 'logRelMaint');

// ============================================================
// S 组：V2 编排接线（runRepair 的两次关联维护）
// ============================================================
/** 候选场景：m2 标签不足（客观缺陷 → 必入候选）+ 两条关联（其一为孤儿行，第 1 段即被清扫） */
const aiScenario = () => {
    const st = emptyLike();
    st.snapshots = [{ id: 'k1', name: '角色甲', appearance: '灰袍', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.memories = [
        { id: 'm1', title: '记忆一', content: '角色甲在码头交接钥匙。', date: '2020-01-01', importance: 0.6, uses: 1, floorStart: 1, floorEnd: 2, tags: ['码头', '交接', '钥匙'] },
        { id: 'm2', title: '记忆二', content: '角色乙在仓库取走木箱。', date: '2020-01-02', importance: 0.4, uses: 1, floorStart: 2, floorEnd: 3, tags: ['仓库', '木箱'] },
    ];
    st.links = [
        { id: 'lnk_m1', dim: 'memories', refId: 'm1', who: '角色甲', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
        { id: 'lnk_m2', dim: 'memories', refId: 'm2', who: '角色甲', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
        { id: 'lnk_gone', dim: 'memories', refId: 'm-none', who: '角色乙', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
    ];
    return st;
};

await A('R15 runRepair：AI 删除条目后再跑一次关联维护（新孤儿行被清扫），返回合并口径 + 摘要入 notes', async () => {
    boot(aiScenario(), { relLinkEnabled: true, relOrphanAction: 'keep', repairAutoAi: true, repairMaxItems: 20, autoRepairEveryOps: 1 });
    aiText = J({ 删除: [1, 2, 3] });                      // 编号未知也不影响：不存在的编号按「丢弃」计
    const r = await runRepair({ cause: '单元测试', force: true });
    const first = (r.stage1 && r.stage1.relMaint) || null;
    const del = Number(r.ai.deleted) || 0;
    const tombIds = Object.keys((state.deleted || {}).links || {});
    return del >= 1
        && !!first && first.swept === 1                                       // 第 1 段：仅清扫既有孤儿行
        && r.relCounts.swept === 1 + del                                      // 合并口径：+ AI 删除产生的孤儿行
        && state.links.every(x => (state.memories || []).some(e => e.id === x.refId))   // 不留指向已删条目的关联行
        && tombIds.length === 1 + del && tombIds.indexOf('lnk_gone') >= 0
        && r.stage1.notes.some(t => String(t).includes(`关联维护：清理孤儿关联 ${1 + del} 行`));
}, 'runRepair 两次维护');

await A('R16 runRepair：未触发 AI（repairAutoAi=false）时不跑第 2 次维护，relMaint 保持第 1 段口径', async () => {
    boot(aiScenario(), { relLinkEnabled: true, relOrphanAction: 'keep', repairAutoAi: false, repairMaxItems: 20, autoRepairEveryOps: 1 });
    aiText = J({ 删除: [1, 2, 3] });
    const r = await runRepair({ silent: true, cause: '自动触发', force: true });   // repairAutoAi 只关自动路径
    return r.ai.used === false && r.ai.deleted === 0
        && !!r.relMaint && r.relCounts.swept === 1
        && state.links.some(x => x.refId === 'm2') && state.links.some(x => x.refId === 'm1');
}, 'runRepair 无 AI');

R.done();
