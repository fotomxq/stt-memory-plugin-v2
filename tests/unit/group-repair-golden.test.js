// ============================================================
// 单元测试 · B8-6c-1 相关组聚类修复基础设施 + 记忆修复管道
//   （与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   ① tests/fixtures/v1-golden-group-repair.json       —— 聚类引擎四域 / 提示词 / 应用 / 机械去重 / 关联重挂
//   ② tests/fixtures/v1-golden-group-repair-flow.json  —— `runMemoryRepair` 全链路（fetch 桩喂 AI）+ 无高相关组早退
// 覆盖：
//   GROUP_REPAIR_SPECS（concepts / memories / items / suspense 四域 spec）+ groupRepairSpec 兜底；
//   groupRelatedness（标签 Jaccard / 文本 bigram 双基准）/ groupClusters（归属分区约束、共享 ≥2 标签、组规模上限防串联、
//   只返回 ≥2 条组、按条数→组内最大相关度排序）/ groupPick（轮询游标、组数·条数上限、缺陷条目另列、singles 抽查）；
//   buildMemoryRepairPrompt（system + user **逐字符**）；applyMemoryMergeGroups（合并 / 修订 / 删除 / 跨归属拒收 /
//   编号不存在 / 标签并集 / uses 累加 / 楼层并集 / 日期取最早 / 关联重挂 / 墓碑 / 计数）；
//   memoryMergeExact（同归属同正文 / 同标题 / 不写墓碑）；retargetRelRefs（重挂 + 同 who 取更可靠 + 冲突行丢弃 + 自指 0）；
//   另含 V2 编排与接线：runMemoryRepair（六步全链路 + 早退 + 互斥 + 空库）、FTT 入口、面板动作与记忆分页按钮。
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
import { retargetRelRefs } from '../../core/entries.js';
import {
    GROUP_REPAIR_SPECS, groupRepairSpec, groupRelatedness, groupClusters, groupPick,
    itemBaseNameKey, itemNameSim, memoryOwnerKey, memoryMergeExact, buildMemoryRepairPrompt,
    applyMemoryMergeGroups, runMemoryRepair,
} from '../../core/group-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-group-repair.json'), 'utf8'));
const GF = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-group-repair-flow.json'), 'utf8'));
const R = makeReporter('group-repair-golden B8-6c-1 相关组聚类修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const DBG = ['concepts', 'memories', 'items', 'suspense'];

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
    DBG.forEach((pre) => { cfg[pre + 'RepairSim'] = 0.45; cfg[pre + 'RepairMaxClusters'] = 3; cfg[pre + 'RepairMaxItems'] = 24; cfg[pre + 'RepairMaxClusterSize'] = 8; });
    cfg.relLinkEnabled = true; cfg.relOrphanAction = 'keep';
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai' }), feedText: () => '', busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
/** 记忆条目投影（与 oracle 的投影字段一致） */
const memView = () => (state.memories || []).map(x => ({
    id: x.id, owner: x.owner, title: x.title, content: x.content, date: x.date, memCategory: x.memCategory,
    importance: x.importance, tags: x.tags, keywords: x.keywords, uses: x.uses, floorStart: x.floorStart, floorEnd: x.floorEnd,
}));
const linkView = () => (state.links || []).map(x => ({ id: x.id, dim: x.dim, refId: x.refId, who: x.who, how: x.how }));
const pickView = (p) => ({ entries: p.entries, clusters: p.clusters, picked: p.picked, defects: p.defects, singles: p.singles, total: p.total, cursor: p.cursor });

// ============================================================
// H 组：聚类引擎与记忆修复 —— 与 V1 逐项比对
// ============================================================
R.assert('H1 groupRelatedness 四域：每条与同域其它条目的最大相似度（sims 3 位小数）+ 判定基准 basis + tagRich 与 V1 一致', (() => {
    const bad = [];
    for (const dim of DBG) {
        boot(G.inputs.scenario); state.repairCursor = {};
        const got = groupRelatedness(GROUP_REPAIR_SPECS[dim]);
        if (J(got) !== J(G.relatedness[dim])) bad.push(dim);
    }
    return bad.length === 0;
})(), DBG.map(d => [d, G.relatedness[d]]));

R.assert('H2 groupClusters 四域：连通分量（idxs/size/maxSim/basis）+ 只返回 ≥2 条的组 + 排序与 V1 一致', (() => {
    const bad = [];
    for (const dim of DBG) {
        boot(G.inputs.scenario); state.repairCursor = {};
        const got = groupClusters(GROUP_REPAIR_SPECS[dim]);
        if (J(got) !== J(G.clusters[dim])) bad.push([dim, got, G.clusters[dim]]);
    }
    return bad.length === 0 && groupClusters(groupRepairSpec('concepts')).length === 1
        && groupClusters(GROUP_REPAIR_SPECS.concepts)[0].size === 3;      // c1/c2/c3 一组；c4/c5 不成组
})(), G.clusters);

R.assert('H3 groupPick concepts：entries 逐条（n/group/idx/id/name/content/source/date/tags/sim/defect）+ 计数 + 游标写回与 V1 一致', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.concepts);
    return J(pickView(p)) === J(G.pick.concepts) && J(state.repairCursor) === J(G.cursorAfter.concepts);
})(), (() => { boot(G.inputs.scenario); state.repairCursor = {}; return pickView(groupPick(GROUP_REPAIR_SPECS.concepts)); })());

R.assert('H4 groupPick memories：entries 逐条（含 owner/title/category/缺陷条目 group 与 defect 文案）+ 缺陷单独送修 + 游标与 V1 一致', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.memories);
    const defects = p.entries.filter(e => e.defect);
    return J(pickView(p)) === J(G.pick.memories) && defectN(p) === 2
        && defects.every(e => e.group > p.picked) && p.total === 1 && p.singles === 0;
    function defectN(x) { return x.entries.filter(e => e.defect).length; }
})(), (() => { boot(G.inputs.scenario); state.repairCursor = {}; return pickView(groupPick(GROUP_REPAIR_SPECS.memories)); })());

R.assert('H5 groupPick items：scoreOf（max(标签 Jaccard, 名称相似度)）+ edgeOk（共享 ≥2 标签 或 名称相似 ≥0.5）+ entries 与 V1 一致', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.items);
    // 物品专有口径：「铜钥匙」「铜钥匙（旧）」规范名相同 → 名称相似度 1，且共享 2 标签 → 成边
    const nameEq = itemNameSim('铜钥匙', '铜钥匙（旧）') === 1 && itemBaseNameKey('铜钥匙（旧）') === '铜钥匙';
    const contain = itemNameSim('钥匙', '铜钥匙') === 0.7;      // 一方包含另一方（长度比 ≥0.5）
    return J(pickView(p)) === J(G.pick.items) && nameEq && contain && p.entries[0].qty !== undefined && p.entries[0].carried !== undefined;
})(), (() => { boot(G.inputs.scenario); state.repairCursor = {}; return pickView(groupPick(GROUP_REPAIR_SPECS.items)); })());

R.assert('H6 groupPick suspense：只取 open 悬念（closed 不参与）+ entries 与 V1 一致 + singles 抽查计数 0', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const spec = GROUP_REPAIR_SPECS.suspense;
    const p = groupPick(spec);
    return J(pickView(p)) === J(G.pick.suspense) && spec.list().length === 2      // u1/u2 为 open，u3 closed 被过滤
        && spec.sampleSingles === true && spec.defectsAlways === true
        && p.entries.every(e => String(e.id) !== 'u3');
})(), (() => { boot(G.inputs.scenario); state.repairCursor = {}; return pickView(groupPick(GROUP_REPAIR_SPECS.suspense)); })());

R.assert('H7 groupRepairSpec：按域取 spec；未知域名回退 concepts（V1 原样）+ 四域 spec 键集完整', (() => {
    boot(G.inputs.scenario);
    const keys = ['label', 'cursorKey', 'list', 'textOf', 'samePartition', 'entryOf', 'cfgSim', 'cfgMaxClusters', 'cfgMaxItems', 'cfgMaxSize', 'defectOf'];
    const complete = DBG.every(d => keys.every(k => GROUP_REPAIR_SPECS[d][k] !== undefined));
    return groupRepairSpec('nope') === GROUP_REPAIR_SPECS.concepts && G.specFallback === true
        && groupRepairSpec('items') === GROUP_REPAIR_SPECS.items && groupRepairSpec('suspense') === GROUP_REPAIR_SPECS.suspense
        && groupRepairSpec('memories') === GROUP_REPAIR_SPECS.memories && complete
        && GROUP_REPAIR_SPECS.items.scoreOf !== undefined && GROUP_REPAIR_SPECS.items.edgeOk !== undefined
        && GROUP_REPAIR_SPECS.concepts.defectsAlways === undefined && GROUP_REPAIR_SPECS.memories.defectsAlways === true;
})(), '');

// ---------- 聚类边界（V1 未在 oracle 中固化，但必须逐字保持的硬约束） ----------
R.assert('H8 归属分区硬约束：不同归属（owner）的记忆绝不连边 → 即使标签完全一致也不成组', (() => {
    boot({ memories: [
        { id: 'a1', owner: '角色甲', title: '交接甲', content: '甲在码头交接货物。', date: '2020-01-01', tags: ['码头', '交接', '货物'], uses: 1 },
        { id: 'a2', owner: '角色乙', title: '交接乙', content: '乙在码头交接货物。', date: '2020-01-02', tags: ['码头', '交接', '货物'], uses: 1 },
    ] }, {});
    const sameOwner = groupClusters(GROUP_REPAIR_SPECS.memories).length === 0;
    state.memories[1].owner = '角色甲';                        // 同归属 → 立刻成组
    const nowGrouped = groupClusters(GROUP_REPAIR_SPECS.memories).length === 1;
    return sameOwner && nowGrouped && GROUP_REPAIR_SPECS.memories.samePartition({ owner: '角色甲' }, { owner: '角色甲' }) === true
        && GROUP_REPAIR_SPECS.memories.samePartition({ owner: '角色甲' }, { owner: '角色乙' }) === false
        && memoryOwnerKey({ owner: '' }) === '通用' && GROUP_REPAIR_SPECS.concepts.samePartition() === true;
})(), '');

R.assert('H9 防串联三态（memories 域，defectsAlways=true）：A) 双方 ≥2 标签仅共享 1 个 → 不成边；B) 任一条 <2 标签 → 基准退化为正文 bigram（同正文即成团）；C) 标签不足且正文不同 → 无组，但该条目按客观缺陷单列送修 —— 三态全部对齐 V1 oracle', (() => {
    const spec = GROUP_REPAIR_SPECS.memories;
    // A) 仅共享 1 个标签 → 不成边（标签基准下需共享 ≥2）
    boot({ memories: [
        { id: 'h9a1', owner: '甲', title: '规则甲', content: '甲类规则文本。', date: '2020-01-01', memCategory: '', importance: 0.5, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'h9a2', owner: '甲', title: '规则乙', content: '乙类规则文本。', date: '2020-01-02', memCategory: '', importance: 0.5, tags: ['甲', '丁', '戊'], uses: 1, floorStart: 2, floorEnd: 2 },
    ] }, {});
    state.repairCursor = {};
    const pa = groupPick(spec);
    const ra = groupRelatedness(spec);
    const a = J({ rel: { sims: ra.sims, basis: ra.basis, tagRich: ra.tagRich }, clusters: groupClusters(spec), pick: { picked: pa.picked, entries: pa.entries.length, total: pa.total } });
    // B) 任一条 <2 标签 → 全局退化为正文 bigram；同正文 → 成团
    boot({ memories: [
        { id: 'h9b1', owner: '甲', title: '记录一', content: '同一条正文内容。', date: '2020-01-01', memCategory: '', importance: 0.5, tags: ['甲'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'h9b2', owner: '甲', title: '记录二', content: '同一条正文内容。', date: '2020-01-02', memCategory: '', importance: 0.5, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 2, floorEnd: 2 },
    ] }, {});
    state.repairCursor = {};
    const pb = groupPick(spec);
    const rb = groupRelatedness(spec);
    const b = J({ rel: { sims: rb.sims, basis: rb.basis, tagRich: rb.tagRich }, clusters: groupClusters(spec), pick: { picked: pb.picked, entries: pb.entries.length, total: pb.total, defects: pb.defects } });
    // C) 标签不足 + 正文互不相似 → 无组，但标签不合规条目按客观缺陷单列送修（picked 0 / entries 1）
    boot({ memories: [
        { id: 'h9c1', owner: '甲', title: '记录一', content: '一号文本内容。', date: '2020-01-01', memCategory: '', importance: 0.5, tags: ['甲'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'h9c2', owner: '甲', title: '记录二', content: '无关的另一段叙述。', date: '2020-01-02', memCategory: '', importance: 0.5, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 2, floorEnd: 2 },
    ] }, {});
    state.repairCursor = {};
    const pc = groupPick(spec);
    const rc = groupRelatedness(spec);
    const c = J({ rel: { sims: rc.sims, basis: rc.basis, tagRich: rc.tagRich }, clusters: groupClusters(spec), pick: { picked: pc.picked, entries: pc.entries.length, total: pc.total, defects: pc.defects, groups: pc.entries.map(e => [e.n, e.group, e.defect || null]) } });
    // 注意：a / b / c 已是 JSON 字符串，直接与 oracle 的 JSON 字符串比较（再套 J() 会二次转义）
    return a === J(GF.h9.A) && b === J(GF.h9.B) && c === J(GF.h9.C)
        && pa.picked === 0 && pa.entries.length === 0 && groupClusters(spec).length === 0   // A：不成边
        && rb.tagRich === false && rb.basis[0] === 'text' && pb.picked === 1 && pb.entries.length === 2   // B：退化正文基准后成团
        && pc.picked === 0 && pc.entries.length === 1 && Number(pc.defects) === 1           // C：无组但缺陷条目单列送修
        && G.clusters.concepts[0].size === 3;         // 三域 oracle 场景本身即共享 3 标签
})(), GF.h9);

R.assert('H10 组规模上限（防 A~B、B~C ⇒ A~B~C 链式误合）：3 条两两高相关但 maxSize=2 → 该连接被丢弃，不成 3 条组', (() => {
    const mem = (i) => ({ id: 'c' + i, name: '同一规律' + i, content: '同一条规律。', date: '2020-01-0' + i, tags: ['甲', '乙', '丙'], uses: 1 });
    boot({ concepts: [mem(1), mem(2), mem(3)] }, {});
    const big = groupClusters(GROUP_REPAIR_SPECS.concepts);
    cfg.conceptRepairMaxClusterSize = 2;
    const capped = groupClusters(GROUP_REPAIR_SPECS.concepts);
    const bigOk = big.length === 1 && big[0].size === 3;
    const cappedOk = capped.length >= 1 && capped.every(c => c.size <= 2);
    return bigOk && cappedOk;
})(), '');

R.assert('H11 groupPick 轮询上限与缺陷条目：组数上限截断 picked、条数上限截断 entries，缺陷条目在额度内追加', (() => {
    // 3 组互不相关的记忆对（同归属，标签组差异大）→ 组数上限 1 只取一组
    const m = [];
    for (let g = 1; g <= 3; g++) {
        for (let k = 1; k <= 2; k++) {
            m.push({ id: `g${g}k${k}`, owner: '甲', title: `事件${g}${k}号`, content: `第${g}组第${k}条正文。`, date: '2020-01-0' + g, tags: [`组${g}`, `类${g}`, `项${g}`], uses: 1 });
        }
    }
    boot({ memories: m }, { memoryRepairMaxClusters: 1, memoryRepairMaxItems: 3 });
    const p = groupPick(GROUP_REPAIR_SPECS.memories);
    return p.total === 3 && p.picked === 1 && p.entries.length <= 3 && p.clusters.length === 1
        && p.entries.filter(e => !e.defect).length === 2
        && GROUP_REPAIR_SPECS.memories.defectsAlways === true;
})(), '');

R.assert('H12 buildMemoryRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（含归属/标签/缺陷分节与输出契约）', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.memories);
    const got = buildMemoryRepairPrompt(p);
    const noEntry = buildMemoryRepairPrompt({ entries: [], picked: 0 });
    return J(got) === J(G.promptMemory) && got.length === 2 && got[0].role === 'system' && got[1].role === 'user'
        && got[0].content.indexOf('只输出 JSON') >= 0 && noEntry === null
        && buildMemoryRepairPrompt({ entries: [] }) === null;
})(), G.promptMemory.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('H13 applyMemoryMergeGroups 全量应用：合并保 id/归属、uses 累加、楼层并集、重要度取大、日期取最早、标签并集∪AI 标签（keywords 清空）、修订、删除、墓碑、关联重挂 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const pick = groupPick(GROUP_REPAIR_SPECS.memories);
    const delta = {
        '合并': [{ '保留': 1, '并入': [2], '标题': '码头交接货物', '正文': '角色甲在码头交接货物并收取银两。', '日期': '2020-01-01', '分类': '交易', '标签': ['码头', '交接', '货物', '银两'] }],
        '修订': [{ '编号': 3, '字段': '正文', '值': '角色乙在仓库取走木箱，未留字条。' }, { '编号': 3, '字段': '标签', '值': '仓库,木箱,字条' }],
        '删除': [4],
    };
    const r = applyMemoryMergeGroups(delta, pick);
    const got = { counts: r, memories: memView(), links: linkView(), tombs: Object.keys((state.deleted || {}).memories || {}).sort() };
    const want = clone(G.applyMemory);
    delete want.beforeIds;
    const m1 = state.memories.find(x => x.id === 'm1');
    return J(got) === J(want) && m1.uses === 4 && m1.floorStart === 1 && m1.floorEnd === 4 && m1.importance === 0.8
        && J(m1.tags) === J(['码头', '交接', '货物', '银两']) && J(m1.keywords) === J([])
        && r.retargeted === 1 && G.applyMemory.counts.retargeted === 1;
})(), G.applyMemory.counts);

R.assert('H14 applyMemoryMergeGroups 跨归属合并一律拒收（skipped 1，两库均未改动）；编号不存在/字段非法同样跳过', (() => {
    boot(G.inputs.scenario);
    const crossPick = { entries: [{ n: 1, id: 'm1', owner: '角色甲' }, { n: 2, id: 'm3', owner: '角色乙' }] };
    const rCross = applyMemoryMergeGroups({ '合并': [{ '保留': 1, '并入': [2], '标题': '跨归属' }] }, crossPick);
    const crossOk = J({ counts: rCross, titles: (state.memories || []).map(x => [x.id, x.title]) }) === J(G.applyCrossOwner);
    // 编号不存在 + 非法字段闭集 + 空 pick + 非对象 delta
    boot(G.inputs.scenario);
    const pick = groupPick(GROUP_REPAIR_SPECS.memories);
    const rBad = applyMemoryMergeGroups({ '合并': [{ '保留': 99, '并入': [98] }], '修订': [{ '编号': 99, '字段': '正文', '值': 'x' }, { '编号': 1, '字段': '归属', '值': '角色丙' }], '删除': [97] }, pick);
    return crossOk && rBad.fused === 0 && rBad.revised === 0 && rBad.deleted === 0 && rBad.skipped === 4
        && J(applyMemoryMergeGroups({}, pick)) === J({ fused: 0, revised: 0, deleted: 0, removed: 0, skipped: 0, retargeted: 0 })
        && applyMemoryMergeGroups({ '合并': 'x' }, pick).fused === 0
        && applyMemoryMergeGroups({ '合并': [] }, { entries: [] }).skipped === 0;
})(), (() => { boot(G.inputs.scenario); return G.applyCrossOwner; })());

R.assert('H15 applyMemoryMergeGroups 日期取最早（`dateStrCmp` 数值口径，含公元前 -YYYY 与位数不齐）+ 正文走 `dimCap` 截断', (() => {
    boot({ memories: [
        { id: 'd1', owner: '甲', title: '同日事件', content: '甲在码头等人。', date: '-0500-03-01', memCategory: '行动', importance: 0.2, tags: ['码头', '等人', '甲'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'd2', owner: '甲', title: '同日事件', content: '甲在码头等人并收货。', date: '0999-01-01', memCategory: '行动', importance: 0.9, tags: ['码头', '等人', '甲'], uses: 2, floorStart: 2, floorEnd: 3 },
    ] }, { memoryRepairMaxItems: 24 });
    const pick = groupPick(GROUP_REPAIR_SPECS.memories);
    const r = applyMemoryMergeGroups({ '合并': [{ '保留': 1, '并入': [2], '正文': '长'.repeat(5000) }] }, pick);
    const m1 = state.memories.find(x => x.id === 'd1');
    const cap = Number(cfg.dimCharLimits.memories) || 300;
    return r.fused === 1 && m1.date === '-0500-03-01' && String(m1.content).length === cap
        && m1.uses === 3 && m1.importance === 0.9 && m1.floorStart === 1 && m1.floorEnd === 3;
})(), '');

R.assert('H16 memoryMergeExact：①a 同正文哈希（并集全生效）与 ①b 同标题 ≥4 字（正文更长者**整体替换**、仅保留首个 id）各自独立触发；跨归属同正文与标题 <4 字均不合并；**不写墓碑** —— 全部对齐 V1 oracle', (() => {
    // 多场景（oracle）：m1/m2 触发 ①a；m3/m4 触发 ①b；m5 跨归属不合并；m6/m7 标题「事件」<4 字不合并
    boot({ memories: clone(GF.mergeExactMultiInputs) }, {});
    const mm = memoryMergeExact();
    const multi = { merged: mm.merged, notes: mm.notes, retargeted: mm.retargeted, memories: memView(), tombs: Object.keys((state.deleted || {}).memories || {}).sort() };
    const m1 = (state.memories || []).find(x => x.id === 'm1') || {};
    const m3 = (state.memories || []).find(x => x.id === 'm3') || {};
    const m5 = (state.memories || []).find(x => x.id === 'm5') || {};
    const multiOk = J(multi) === J(GF.mergeExactMulti) && mm.merged === 2 && mm.retargeted === 2
        && multi.tombs.length === 0
        // ①a：并集全生效（tags 并集、uses 累加、楼层并集、重要度取大、日期取最早）
        && J(m1.tags) === J(['码头', '货物', '交接']) && m1.uses === 3 && m1.floorStart === 1 && m1.floorEnd === 4
        && m1.importance === 0.9 && m1.date === '2020-01-01'
        // ①b：正文更长者整体替换 → 仅 id 保留（V1 原生怪癖：并集被丢弃，不得「修正」）
        && m3.content === '天机阁在密室密谈并留下字条。' && m3.importance === 0.7 && m3.uses === 4
        && m3.floorStart === 6 && m3.floorEnd === 9 && J(m3.tags) === J(['天机阁', '字条'])
        // 跨归属 + 短标题：原样保留
        && m5.owner === '角色乙' && m5.uses === 1
        && (state.memories || []).filter(x => x.title === '事件').length === 2;
    // ①a（单场景 oracle：m5 与 m1 同正文哈希）
    boot(G.inputs.scenario);
    state.memories.push({ id: 'm5', owner: '角色甲', title: '码头交接', content: '角色甲在码头交接货物。', date: '2020-01-01', memCategory: '交易', importance: 0.5, tags: ['码头'], uses: 1, floorStart: 1, floorEnd: 2 });
    const me = memoryMergeExact();
    const a1 = J({ merged: me.merged, notes: me.notes, ids: (state.memories || []).map(x => x.id), tombs: Object.keys((state.deleted || {}).memories || {}).sort() }) === J(G.memoryMergeExact)
        && me.retargeted === 1 && G.memoryMergeExact.tombs.length === 0;
    // 标题 <4 字 → 不合并；跨归属同正文 → 不合并（归属分区同样作用于机械去重）
    boot({ memories: [
        { id: 's1', owner: '甲', title: '事件', content: '甲事。', date: '2020-01-01', memCategory: '', importance: 0.3, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 's2', owner: '甲', title: '事件', content: '乙事。', date: '2020-01-02', memCategory: '', importance: 0.4, tags: ['丁', '戊', '己'], uses: 1, floorStart: 2, floorEnd: 2 },
    ] }, {});
    const ms = memoryMergeExact();
    const shortOk = ms.merged === GF.mergeShortTitle.merged && state.memories.length === GF.mergeShortTitle.count;
    boot({ memories: [
        { id: 'o1', owner: '甲', title: '甲记录', content: '同一件事。', date: '2020-01-01', memCategory: '', importance: 0.3, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'o2', owner: '乙', title: '乙记录', content: '同一件事。', date: '2020-01-02', memCategory: '', importance: 0.4, tags: ['甲', '乙', '丙'], uses: 1, floorStart: 2, floorEnd: 2 },
    ] }, {});
    const mo = memoryMergeExact();
    const crossOk = mo.merged === GF.mergeCrossOwner.merged && state.memories.length === GF.mergeCrossOwner.count;
    return multiOk && a1 && shortOk && crossOk
        && memoryOwnerKey({ owner: '' }) === GF.ownerKey.empty && memoryOwnerKey({}) === GF.ownerKey.missing
        && memoryOwnerKey({ owner: ' 角色甲 ' }) === GF.ownerKey.spaced;
})(), GF.mergeExactMulti);

R.assert('H17 retargetRelRefs：被并入条目的关联行改挂保留主条；同 who 多行按 REL_LINK_HOW_RANK 取更可靠；**目标条目原有的同名 who 行被顶掉**（V1 怪癖，如实固化）；自指 → 0', (() => {
    boot(G.inputs.scenario);
    const n1 = retargetRelRefs('memories', ['m2'], 'm1');
    const first = { n: n1, links: linkView() };
    const n2 = retargetRelRefs('memories', ['m1'], 'm1');                 // 自指 → 0（filter 掉 x === to）
    const n3 = retargetRelRefs('memories', ['m2'], '');                   // 无目标 → 0
    const n4 = retargetRelRefs('memories', [], 'm1');                     // 空来源 → 0
    const src = first.links.find(x => x.who === '角色甲');
    return J(first) === J(G.retarget) && n2 === G.retargetSelf && n3 === 0 && n4 === 0
        && first.links.length === 2 && src.how === 'witness'              // participant 被 witness 顶掉（可靠性排序）
        && first.links.every(x => x.refId === 'm1');
})(), G.retarget);

// ============================================================
// P 组：V2 编排（runMemoryRepair 六步全链路）
// ============================================================
await A('P1 runMemoryRepair 全链路：① 机械去重 → ①-b 关系维护 → ②③ 聚类选组 → ④ AI → ⑤ 应用（合并/删除/墓碑/关联重挂）→ ⑥ 再维护并合并两次口径 —— 返回结构 / 落库 / 墓碑 / 关联 / 提示文案与 V1 逐项一致', async () => {
    boot(GF.inputs.scenario);
    const r = await runMemoryRepair({ aiText: GF.inputs.ai });
    const flow = {
        made: r.made, before: r.before, after: r.after, fused: r.fused, removed: r.removed, revised: r.revised,
        deleted: r.deleted, skipped: r.skipped, merged: r.merged, retargeted: r.retargeted,
        groups: r.groups, groupsTotal: r.groupsTotal, checked: r.checked, relMaint: r.relMaint,
    };
    // V1 `notify('repair', …)` → toastr 类型 warning；V2 notifyHooks 只认 info/success/warning/error，故 kind 映射后文本逐字符一致
    const wantToasts = GF.toasts.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);
    return J(flow) === J(GF.flow) && J(memView()) === J(GF.memories) && J(linkView()) === J(GF.links)
        && J(Object.keys((state.deleted || {}).memories || {}).sort()) === J(GF.tombs)
        && J(toasts) === J(wantToasts)
        && flow.merged === 1 && flow.fused === 1 && flow.retargeted === 1        // 机械去重 + AI 合并 + 关联重挂
        && flow.relMaint.swept === 2;                                            // 两次维护口径合并（1 + AI 后 1）
}, GF.flow);

await A('P2 runMemoryRepair 无高相关组早退：不发 AI（零成本）、只做机械去重与关系维护，回报 skipped + 原因文案 —— 与 V1 一致', async () => {
    boot(GF.inputs.scenario);
    let aiCalls = 0;
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: '{}' }; }, feedText: () => '', busy: () => false });
    state.memories = [
        { id: 'q1', owner: '角色甲', title: '独立事件甲', content: '完全无关的甲事。', date: '2020-01-01', memCategory: '', importance: 0.5, tags: ['甲组', '甲类', '甲项'], uses: 1, floorStart: 1, floorEnd: 1 },
        { id: 'q2', owner: '角色乙', title: '独立事件乙', content: '完全无关的乙事。', date: '2020-01-02', memCategory: '', importance: 0.5, tags: ['乙组', '乙类', '乙项'], uses: 1, floorStart: 2, floorEnd: 2 },
    ];
    state.links = [];
    const r = await runMemoryRepair({ aiText: GF.inputs.ai });
    const got = { made: r.made, skipped: r.skipped, merged: r.merged, groups: r.groups, before: r.before, after: r.after, relMaint: r.relMaint };
    return aiCalls === 0 && J(got) === J(GF.earlyExit)
        && String(toasts[0][1]).indexOf('未发现达到相关性阈值（0.45）的记忆组') >= 0
        && String(toasts[0][1]).indexOf('分属不同归属') >= 0
        && toasts[0][0] === 'info' && r.fused === undefined;
}, GF.earlyExit);

await A('P3 runMemoryRepair 长任务在途拒绝（aiBusy 互斥语义，同 core/repair.js#runRepair）：返回 blocked，不改动任何数据', async () => {
    boot(GF.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: false }), feedText: () => '', busy: () => true });
    const before = J(memView());
    const r = await runMemoryRepair({ aiText: GF.inputs.ai });
    setAiHooks({ callAi: async () => ({ ok: false }), feedText: () => '', busy: () => false });
    return r.made === 0 && r.blocked === true && J(memView()) === before
        && toasts.length === 1 && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('修复进行中') >= 0;
}, '');

await A('P4 runMemoryRepair 空库：直接返回 skipped 并提示先产生记忆（不触发任何 AI/维护）', async () => {
    boot({ memories: [] });
    const r = await runMemoryRepair({ aiText: GF.inputs.ai });
    return r.made === 0 && r.skipped === true && toasts.length === 1 && toasts[0][0] === 'info'
        && String(toasts[0][1]).indexOf('暂无记忆') >= 0;
}, '');

await A('P5 runMemoryRepair AI 未返回有效 JSON：不崩溃、不改动数据，机械去重与关系维护的成果仍保留', async () => {
    boot(GF.inputs.scenario, { relOrphanAction: 'keep' });
    const r = await runMemoryRepair({ aiText: '这不是 JSON' });
    const mergedKept = Number(r.merged) === 1 && Number(r.fused) === 0 && Number(r.deleted) === 0
        && state.memories.length === Number(r.after)                               // m6 已并入 m3（机械去重生效）
        && state.links.every(x => x.refId !== 'm-none');                            // 孤儿关联行已被清扫
    return mergedKept && toasts.length === 2
        && String(toasts[1][1]).indexOf('机械去重 1 条') >= 0                        // V1：有机械去重 → success 分支
        && String(toasts[1][1]).indexOf('修复前 ') >= 0;
}, '');

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 记忆分页渲染 V1 同款「🔧 修复记忆」按钮（有记忆时显示、无记忆时隐藏；文案与 title 逐字对齐）', (() => {
    boot(G.inputs.scenario);
    openPanel('memories'); setPanelHooks2({});
    const html = panelBodyHtml('memories');
    const hasBtn = html.indexOf('data-ftt-action="memoryRepair"') >= 0 && html.indexOf('🔧 修复记忆') >= 0
        && html.indexOf('title="融合相似记忆并清理孤儿关联"') >= 0;
    boot({ memories: [] });
    openPanel('memories');
    const empty = panelBodyHtml('memories');
    return hasBtn && empty.indexOf('data-ftt-action="memoryRepair"') < 0
        && empty.indexOf('该类目暂无条目') >= 0;
})(), '');

await A('U2 面板动作 memoryRepair 可达：走 runMemoryRepair 全链路并把结果写回面板 note（不伪造 AI 结果）', async () => {
    boot(GF.inputs.scenario);
    // 面板路径不经 opts.aiText，AI 必须从共用注入钩子取 —— 这里接线到 oracle 的 AI 返回
    setAiHooks({ callAi: async () => ({ ok: true, text: GF.inputs.ai }), feedText: () => '', busy: () => false });
    openPanel('memories'); setPanelHooks2({});
    const r = await panelAction('memoryRepair', {});
    const st = panelState();
    const note = String(st.note || '');
    return r.ok === true && !!r.memoryRepair && r.made === 1 && r.action === 'memoryRepair'
        && note.indexOf('记忆修复：') >= 0 && note.indexOf('高相关组 1/1 组') >= 0 && note.indexOf('关联重挂 1 行') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：groupSpecs / groupSpec / groupRelatedness / groupClusters / groupPick / memoryMergeExact / memoryRepairPrompt / memoryRepairApply / memoryRepair / retargetRelRefs', (() => {
    boot(G.inputs.scenario); state.repairCursor = {};
    const on = installDevtools({
        groupSpecs: () => GROUP_REPAIR_SPECS, groupSpec: (k) => groupRepairSpec(k),
        groupRelatedness: (s) => groupRelatedness(s), groupClusters: (s) => groupClusters(s), groupPick: (s) => groupPick(s),
        memoryMergeExact: () => memoryMergeExact(), memoryRepairPrompt: (p) => buildMemoryRepairPrompt(p),
        memoryRepairApply: (d, p) => applyMemoryMergeGroups(d, p), memoryRepair: (o) => runMemoryRepair(o),
        retargetRelRefs: (d, f, t) => retargetRelRefs(d, f, t),
    });
    const F = globalThis.FTT;
    const specs = F.groupSpecs();
    const spec = F.groupSpec('memories');
    const p = F.groupPick(spec);
    const rel = F.groupRelatedness(spec);
    const cl = F.groupClusters(spec);
    const prompt = F.memoryRepairPrompt(p);
    const applied = F.memoryRepairApply({ '修订': [{ '编号': 3, '字段': '标题', '值': '仓库取物（改）' }] }, p);
    const n = F.retargetRelRefs('memories', ['m2'], 'm1');
    const ok = on === true && specs === GROUP_REPAIR_SPECS && spec === GROUP_REPAIR_SPECS.memories
        && p.picked === 1 && rel.sims.length === 4 && cl.length === 1 && Array.isArray(prompt) && prompt.length === 2
        && applied.revised === 1 && state.memories.find(x => x.id === 'm3').title === '仓库取物（改）'
        && n === 2 && F.groupSpec('nope') === GROUP_REPAIR_SPECS.concepts
        && typeof F.memoryMergeExact === 'function' && typeof F.memoryRepair === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.memoryRepair 无 hook 时按约定降级（不抛错），有 hook 时执行全链路', async () => {
    boot(GF.inputs.scenario);
    installDevtools({});
    const noHook = await globalThis.FTT.memoryRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(GF.inputs.scenario);
    installDevtools({ memoryRepair: (o) => runMemoryRepair(o) });
    const r = await globalThis.FTT.memoryRepair({ aiText: GF.inputs.ai });
    uninstallDevtools();
    return degraded && r.made === 1 && r.fused === 1;
}, '');

un();
R.done();
