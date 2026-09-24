// ============================================================
// 单元测试 · B8-6c-3 物品修复管道（V1 v1.142）
//   （与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-item-repair.json —— 机械去重 / 低调用清理 / 聚类选组 / 提示词（逐字符）/
//   按编号精确应用 / `runItemRepair` 全链路（fetch 桩喂 AI）/ 无高相关组早退 / 空库。
// 覆盖：
//   `itemMergeExact`（同规范名去括号说明合并：货币合计数量、uses 累加、标签并集、说明取更长、
//   位置/携带/seenDate 取楼层最新、楼层并集；**不写墓碑**；无同规范名 → 零合并）；
//   `itemLowUsesPurge`（固定规则：平均值阈值、长期未现门槛、保护项（无楼层/携带/货币）、
//   按 uses 升序+age 降序排序、每轮上限、存储保底、清扫间隔闸门；以及 long-absent-disabled /
//   library-too-small / avg-too-low / cooldown / too-recent 五个早退分支）；
//   `buildItemRepairPrompt`（system + user **逐字符**：近期正文段 + 分组条目元信息 + 输出契约；空 entries → null）；
//   `applyItemMergeGroups`（合并 / 修订 / 删除 / 顶层与「物品库」两种操作块定位 / 字段闭集 / 说明限长 /
//   占位值拒收 / 货币数量合计 / 编号不存在 / 墓碑 / 计数）；
//   `isCurrencyItemName`（V1 私有口径，V2 导出供自证）；
//   另含 V2 编排与接线：`runItemRepair` 全链路与早退、`aiBusy` 互斥、空库、AI 非法 JSON；
//   `FTT.*` 入口、面板动作 `itemRepair` 与物品分页按钮。
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
    isCurrencyItemName, itemMergeExact, itemLowUsesPurge, buildItemRepairPrompt, applyItemMergeGroups, runItemRepair,
} from '../../core/item-repair.js';
import { GROUP_REPAIR_SPECS, groupPick } from '../../core/group-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-item-repair.json'), 'utf8'));
const R = makeReporter('item-repair-golden B8-6c-3 物品修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
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
/** 记录最近一次 NOTIFY（V1 `toastLogGet` 的 V2 等价：notifyHooks.toast(text, kind)） */
let toasts = [];
/** 当前生效的 AI 桩返回 / 调用次数（面板路径与编排路径共用） */
let aiText = '{}';
let aiCalls = 0;
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    // oracle 固定阈值/上限/字数上限 → V2 同值，保证确定可比
    cfg.itemRepairSim = 0.45; cfg.itemRepairMaxClusters = 3; cfg.itemRepairMaxItems = 24; cfg.itemRepairMaxClusterSize = 8;
    cfg.dimCharLimits = Object.assign({}, clone(defaultCfg.dimCharLimits), { items: 80 });
    cfg.repairFloors = 10;
    setScopeKey('甲');
    setLastMessageId(3);                       // oracle mock env：getLastMessageId() === 3
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    state.repairCursor = state.repairCursor || {};
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    aiText = '{}'; aiCalls = 0;
    // 面板/编排路径共用 AI 钩子；feedText 固定为 oracle 捕获的投喂文本（V1 `buildFeedFloorText(10)`）
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => G.feedText, busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
/** 物品条目投影（与 oracle 的投影字段一致） */
const itemView = () => (state.items || []).map(x => ({
    id: x.id, name: x.name, desc: x.desc, location: x.location, carried: x.carried,
    qty: (x.qty === undefined ? null : x.qty), tags: x.tags, keywords: x.keywords,
    uses: x.uses, floorStart: x.floorStart, floorEnd: x.floorEnd, seenDate: x.seenDate,
}));
const pickView = (p) => ({ entries: p.entries, clusters: p.clusters, picked: p.picked, defects: p.defects, singles: p.singles, total: p.total, cursor: p.cursor });
const itemTombs = () => Object.keys((state.deleted || {}).items || {}).sort();
/** V1 `toastLogGet()` 的 `{kind,title,text}` → V2 `notifyHooks.toast(text, kind)` 的 `[kind, 'title text']`
 *  （V1 `notify('repair', …)` 的 toastr 类型是 warning；V2 notifyHooks 只认 info/success/warning/error） */
const wfToasts = (list) => list.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);

// ============================================================
// I 组：物品修复内核 —— 与 V1 逐项比对
// ============================================================
R.assert('I1 itemMergeExact：同规范名（去括号说明）合并 —— 货币数量合计 / uses 累加 / 标签并集 / 说明取更长 / 位置·携带·seenDate 取楼层最新 / 楼层并集 / **不写墓碑**，且无同规范名时零合并 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioMerge);
    const me = itemMergeExact();
    const got = { merged: me.merged, items: itemView(), tombs: itemTombs() };
    boot(G.inputs.scenarioPick);
    const none = { merged: itemMergeExact().merged, items: itemView() };
    const i1 = state.items.find(x => x.id === 'k1');
    return J(got) === J(G.mergeExact) && J(none) === J(G.mergeExactNone)
        && got.merged === 2 && got.tombs.length === 0 && i1.qty === 1;
})(), G.mergeExact);

R.assert('I2 itemLowUsesPurge 主路径：阈值＝平均×ratio、≥minFloors 楼未现才算候选、无楼层/携带/货币受保护、按 uses 升序+age 降序、每轮上限、写墓碑并推进清扫间隔 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioPurge, { itemLowUsesMinItems: 3, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 0, storeMinItems: 0 });
    const pg = itemLowUsesPurge();
    const got = { r: pg, items: itemView(), tombs: itemTombs(), lowUseForget: state.lowUseForget || null };
    return J(got) === J(G.purge) && pg.removed === 2 && pg.threshold === 0.83 && pg.protectedCount === 3
        && J(pg.names) === J(['旧草鞋(0次·2楼)', '破布条(0次·1楼)'])
        && (state.lowUseForget || {}).itemFloor === 3;
})(), G.purge);

R.assert('I3 itemLowUsesPurge 五个早退分支与 V1 逐字段一致：幂等再跑（too-recent）/ 门槛 0（long-absent-disabled）/ 库规模不足（library-too-small）/ 平均调用不足（avg-too-low）/ 清扫间隔未到（cooldown + cooldown 明细）', (() => {
    boot(G.inputs.scenarioPurge, { itemLowUsesMinItems: 3, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 0, storeMinItems: 0 });
    const again = itemLowUsesPurge();
    const first = J(again) === J(G.purge.r);                        // 第一次与主路径一致
    const second = itemLowUsesPurge();
    const againOk = J(second) === J(G.purgeAgain);
    boot(G.inputs.scenarioPurge, { itemLowUsesMinFloors: 0, itemLowUsesMinItems: 3, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 0, storeMinItems: 0 });
    const disabled = J(itemLowUsesPurge()) === J(G.purgeDisabled);
    boot(G.inputs.scenarioPurge, { itemLowUsesMinItems: 100, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 0, storeMinItems: 0 });
    const tooSmall = J(itemLowUsesPurge()) === J(G.purgeTooSmall);
    boot(G.inputs.scenarioPurge, { itemLowUsesMinItems: 3, itemLowUsesMinAvg: 50, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 0, storeMinItems: 0 });
    const avgLow = J(itemLowUsesPurge()) === J(G.purgeAvgLow);
    boot(G.inputs.scenarioPurge, { itemLowUsesMinItems: 3, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2, itemLowUsesEveryFloors: 40, storeMinItems: 0 });
    state.lowUseForget = { itemFloor: 3 };
    const cool = J(itemLowUsesPurge()) === J(G.purgeCooldown);
    return first && againOk && disabled && tooSmall && avgLow && cool;
})(), [G.purgeAgain, G.purgeDisabled, G.purgeTooSmall, G.purgeAvgLow, G.purgeCooldown]);

R.assert('I4 groupPick(items) 逐条 entries（n/group/idx/id/name/desc/qty/location/carried/uses/tags/sim/defect）与 clusters/picked/defects/total 及 `state.repairCursor` 写回 —— 与 V1 一致（物品域专用 scoreOf/edgeOk 经 group-repair 复用）', (() => {
    boot(G.inputs.scenarioPick);
    state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.items);
    const got = pickView(p);
    const cursor = J(state.repairCursor);
    return J(got) === J(G.pick) && cursor === J(G.cursorAfter)
        && p.picked === 1 && p.entries.length === 4 && p.defects === 2
        && p.entries[0].sim === 0.5 && GROUP_REPAIR_SPECS.items.scoreOf !== undefined;
})(), (() => { boot(G.inputs.scenarioPick); state.repairCursor = {}; return pickView(groupPick(GROUP_REPAIR_SPECS.items)); })());

R.assert('I5 buildItemRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（近期正文段 = `aiFeedText` 投喂文本 / 分组条目元信息 / 缺陷段落 / 输出契约）；entries 为空 → null', (() => {
    boot(G.inputs.scenarioPick);
    state.repairCursor = {};
    const p = groupPick(GROUP_REPAIR_SPECS.items);
    const got = buildItemRepairPrompt(p);
    return J(got) === J(G.prompt) && got.length === 2 && got[0].role === 'system' && got[1].role === 'user'
        && got[1].content.indexOf('【近期正文') >= 0 && got[1].content.indexOf('（无正文）') < 0
        && got[0].content.indexOf('只输出 JSON') >= 0
        && buildItemRepairPrompt({ entries: [] }) === null && G.promptEmpty === null;
})(), G.prompt.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('I6 applyItemMergeGroups 全量应用：合并（AI 名称/说明/位置/数量/携带 优先、标签并集、uses 累加、楼层并集、货币数量合计）/ 修订（说明·数量·携带）/ 删除 —— counts + items + 墓碑与 V1 逐字段一致，`keywords` 被清空', (() => {
    boot(G.inputs.scenarioPick);
    state.repairCursor = {};
    const pick = groupPick(GROUP_REPAIR_SPECS.items);
    const r = applyItemMergeGroups(clone(G.inputs.deltaApply), pick);
    const got = { counts: r, items: itemView(), tombs: itemTombs() };
    const k1 = state.items.find(x => x.id === 'k1');
    const k3 = state.items.find(x => x.id === 'k3');
    return J(got) === J(G.apply) && r.fused === 1 && r.deleted === 2 && r.removed === 1
        && k1.uses === 3 && k1.floorStart === 1 && k1.floorEnd === 4 && J(k1.keywords) === J([])
        && J(k1.tags) === J(['钥匙', '工具', '门禁', '铁']) && k3.carried === true && k3.qty === 3;
})(), G.apply.counts);

R.assert('I7 applyItemMergeGroups 规格细节：货币类合并数量合计（AI 未给数量时）/ 编号不存在·非法字段闭集 → skipped；空 delta / 空 entries / null pick / 非对象 delta 四种边界零改动 —— 与 V1 一致', (() => {
    boot(G.inputs.scenarioMerge);
    state.repairCursor = {};
    const pick = groupPick(GROUP_REPAIR_SPECS.items);
    const r1 = applyItemMergeGroups({
        '合并': [{ '保留': 2, '并入': [3], '说明': '合并后的银两。', '标签': ['货币', '银两', '钱'] }],
        '修订': [{ '编号': 99, '字段': '说明', '值': 'x' }, { '编号': 1, '字段': '归属', '值': '角色乙' }],
        '删除': [98],
    }, pick);
    const curOk = J({ counts: r1, items: itemView(), tombs: itemTombs() }) === J(G.applyCurrency);
    boot(G.inputs.scenarioPick);
    state.repairCursor = {};
    const pick2 = groupPick(GROUP_REPAIR_SPECS.items);
    const edge = {
        empty: applyItemMergeGroups({}, { entries: [{ n: 1, id: 'k1' }] }),
        noEntries: applyItemMergeGroups({ '合并': [] }, { entries: [] }),
        nullPick: applyItemMergeGroups({ '合并': [{ '保留': 1, '并入': [2] }] }, null),
        notObject: applyItemMergeGroups('x', { entries: [{ n: 1, id: 'k1' }] }),
    };
    return curOk && r1.skipped === 3 && J(edge) === J(G.applyEdge)
        && applyItemMergeGroups({ '物品库': { '合并': [] } }, pick2).fused === 0;
})(), G.applyCurrency.counts);

R.assert('I8 applyItemMergeGroups 字段限长与占位值：说明按 `dimCharLimits.items` 硬截断到 80 字；说明为占位文本（「待补充」）过 `repairIsGarbage` 被拒收（skipped）—— 与 V1 一致', (() => {
    boot(G.inputs.scenarioPick);
    state.repairCursor = {};
    const pick = groupPick(GROUP_REPAIR_SPECS.items);
    const r = applyItemMergeGroups({
        '修订': [
            { '编号': 1, '字段': '说明', '值': '长'.repeat(200) },
            { '编号': 1, '字段': '名称', '值': '待补充' },
            { '编号': 1, '字段': '说明', '值': '待补充' },
        ],
    }, pick);
    const got = { counts: r, items: itemView() };
    return J(got) === J(G.applyLimits) && r.revised === 2 && r.skipped === 1
        && String(state.items[0].desc).length === 80;
})(), G.applyLimits.counts);

R.assert('I9 isCurrencyItemName（V1 私有、V2 导出供自证）：名称命中 币/货币/钱/银两/… 或说明前 40 字命中货币字样 → true；普通道具 → false', (() => {
    boot({ items: [] });
    const t = (n, d) => isCurrencyItemName(n, d) === true;
    const f = (n, d) => isCurrencyItemName(n, d) === false;
    return t('银两', '') && t('铜钱袋', '') && t('Gold Coin', '') && t('钱袋', '')
        && t('布袋', '装着一些货币。') && f('铁剑', '一把铁剑。') && f('', '') && f('干粮', '路上的干粮。');
})(), '');

// ============================================================
// P 组：V2 编排（runItemRepair 五步全链路）
// ============================================================
await A('P1 runItemRepair 全链路：① 机械去重 → ② 低调用清理 → ③ 聚类选组 → ④ AI（桩）→ ⑤ 按编号应用 —— 返回结构 / 落库 / 墓碑 / 游标 / 通知文案与 V1 逐项一致', async () => {
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { itemRepair: '（测试用物品修复模板）' });
    aiText = JSON.stringify(G.inputs.ai);
    const r = await runItemRepair();
    const got = {
        res: {
            made: r.made, before: r.before, after: r.after, fused: r.fused, removed: r.removed, revised: r.revised,
            deleted: r.deleted, skipped: r.skipped, merged: r.merged, purged: r.purged, groups: r.groups,
            checked: r.checked, keys: Object.keys(r).sort(),
        },
        items: itemView(), tombs: itemTombs(), cursor: clone(state.repairCursor), aiCalls,
    };
    const want = clone(G.run); delete want.toasts;
    return J(got) === J(want) && J(toasts) === J(wfToasts(G.run.toasts))
        && aiCalls === 1 && r.made === 1 && r.fused === 1 && r.deleted === 2
        && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('高相关组 1/1 组') >= 0;
}, G.run.res);

await A('P2 runItemRepair 无高相关组且无缺陷条目：不发 AI（aiCalls = 0）、零改动、回报 skipped + 原因文案；低调用清理与机械合并的成果如实上报', async () => {
    boot(G.inputs.scenarioNone, { itemLowUsesMinItems: 100, itemLowUsesMinFloors: 1, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    const r = await runItemRepair();
    const got = {
        res: { made: r.made, skipped: r.skipped, merged: r.merged, purged: r.purged, groups: r.groups, before: r.before, after: r.after, keys: Object.keys(r).sort() },
        items: itemView(), aiCalls,
    };
    const want = clone(G.runNone); delete want.toasts;
    return J(got) === J(want) && J(toasts) === J(wfToasts(G.runNone.toasts))
        && aiCalls === 0 && r.made === 0 && r.skipped === true
        && String(toasts[0][1]).indexOf('未发现达到相关性阈值（0.45）的物品组') >= 0;
}, G.runNone.res);

await A('P3 runItemRepair 空库：直接返回 skipped 并提示先产生物品（不触发 AI / 不写墓碑）', async () => {
    boot({ items: [] });
    const r = await runItemRepair();
    return J(r) === J(G.runEmpty.res) && J(toasts) === J(wfToasts(G.runEmpty.toasts))
        && r.made === 0 && r.skipped === true && aiCalls === 0
        && String(toasts[0][1]).indexOf('暂无物品') >= 0;
}, G.runEmpty.res);

await A('P4 runItemRepair 长任务在途拒绝（aiBusy 互斥语义，同 core/repair.js#runRepair）：返回 blocked，不改动任何数据', async () => {
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: '{}' }; }, feedText: () => G.feedText, busy: () => true });
    const before = J(itemView());
    const r = await runItemRepair();
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => G.feedText, busy: () => false });
    return r.made === 0 && r.blocked === true && J(itemView()) === before && aiCalls === 0
        && toasts.length === 1 && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('修复进行中') >= 0;
}, '');

await A('P5 runItemRepair AI 未返回有效 JSON：不崩溃、AI 段零改动，① 机械去重与 ② 低调用清理的成果仍保留（V2 编排不虚报）', async () => {
    boot(G.inputs.scenarioMerge, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0, itemLowUsesMinAvg: 0, itemLowUsesRatio: 0.5, itemLowUsesMinFloors: 1, itemLowUsesMaxDelete: 2 });
    state.repairCursor = {};
    aiText = '这不是 JSON';
    const r = await runItemRepair();
    return aiCalls === 1 && Number(r.merged) === 2 && Number(r.fused) === 0 && Number(r.deleted) === 0
        && state.items.length === 4                                    // i1/i2、i3/i4 各并一条
        && state.items.every(x => x.id !== 'i2' && x.id !== 'i4')
        && r.made === 1 && toasts.length >= 1;
}, '');

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 物品分页渲染 V1 同款「🔧 修复物品」按钮（有物品时显示、无物品时隐藏；文案与 title 逐字对齐）', (() => {
    boot(G.inputs.scenarioPick);
    openPanel('items'); setPanelHooks2({});
    const html = panelBodyHtml('items');
    const hasBtn = html.indexOf('data-ftt-action="itemRepair"') >= 0 && html.indexOf('🔧 修复物品') >= 0
        && html.indexOf('title="修复物品冗余与记录错误，并更新流转信息"') >= 0;
    boot({ items: [] });
    openPanel('items');
    const empty = panelBodyHtml('items');
    return hasBtn && empty.indexOf('data-ftt-action="itemRepair"') < 0 && empty.indexOf('该类目暂无条目') >= 0;
})(), '');

await A('U2 面板动作 itemRepair 可达：走 runItemRepair 全链路并把结果写回面板 note（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    aiText = JSON.stringify(G.inputs.ai);
    openPanel('items'); setPanelHooks2({});
    const r = await panelAction('itemRepair', {});
    const st = panelState();
    const note = String(st.note || '');
    return r.ok === true && !!r.itemRepair && r.made === 1 && r.action === 'itemRepair' && aiCalls === 1
        && note.indexOf('物品修复：') >= 0 && note.indexOf('高相关组 1/1 组') >= 0 && note.indexOf('删除 2 件') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：isCurrencyItemName / itemMergeExact / itemLowUsesPurge / itemRepairPrompt / itemRepairApply / itemRepair', (() => {
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    const on = installDevtools({
        isCurrencyItemName: (n, d) => isCurrencyItemName(n, d),
        itemMergeExact: () => itemMergeExact(),
        itemLowUsesPurge: () => itemLowUsesPurge(),
        itemRepairPrompt: (p) => buildItemRepairPrompt(p),
        itemRepairApply: (d, p) => applyItemMergeGroups(d, p),
        itemRepair: (o) => runItemRepair(o),
    });
    const F = globalThis.FTT;
    const cur = F.isCurrencyItemName('银两', '');
    const me = F.itemMergeExact();
    const pg = F.itemLowUsesPurge();
    const p = groupPick(GROUP_REPAIR_SPECS.items);
    const prompt = F.itemRepairPrompt(p);
    const applied = F.itemRepairApply({ '修订': [{ '编号': 3, '字段': '标签', '值': '武器,铁,近战' }] }, p);
    const ok = on === true && cur === true && Number(me.merged) === 0 && pg.skipped === 'library-too-small'
        && Array.isArray(prompt) && prompt.length === 2 && applied.revised === 1
        && state.items.find(x => x.id === 'k3').tags.length === 3
        && typeof F.itemRepair === 'function' && typeof F.itemLowUsesPurge === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.itemRepair 无 hook 时按约定降级（不抛错），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    installDevtools({});
    const noHook = await globalThis.FTT.itemRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenarioPick, { itemLowUsesMinItems: 100, storeMinItems: 0, itemLowUsesEveryFloors: 0 });
    state.repairCursor = {};
    installDevtools({ itemRepair: (o) => runItemRepair(o) });
    const r = await globalThis.FTT.itemRepair({ aiText: JSON.stringify(G.inputs.ai) });
    uninstallDevtools();
    return degraded && r.made === 1 && r.fused === 1;
}, '');

un();
R.done();
