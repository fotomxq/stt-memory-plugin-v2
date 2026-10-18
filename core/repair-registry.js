// ============================================================
// core/repair-registry.js —— **修复注册表**（v3.50.14，`docs/D22` §4.13 W12 `技-47` / `docs/D33` §8）
//
// 用户要求：「开发W12待开发清单。」（W12 = 修复通道统一编排，来源稿 `docs/D33`）
//
// 缺陷（`docs/D33` §8 `技-47`）：九个「单域修复」入口的**候选选择器 / 提示词构造器 / 应用器 / 上限键 / 入口**
//   分散在 6 个模块里，只能靠读代码才知道「某域的全套零件在哪、上限是什么」——
//   因此 `技-48`（AI 聚合器）无法机械地「按域分节 → 一次请求 → 按域拆回」，只能硬编码。
//
// 本模块**只做索引**（`docs/D33` §3.2 的字段；纯数据 + 薄适配器）：
//   · 一行 = 一个域：`id / label / kind / inTotal / aggKey / limits / buildSection / apply / entry / pick`；
//   · `buildSection` 是**薄适配器**：直接调用该域既有的 `build*Prompt`，**产出文本逐字不变**（双跑对照即证）；
//   · 行为零变化：本模块**不修改**任何既有函数，只把它们登记进来（`docs/D33` §8 验收②「双跑对照逐字一致」）；
//   · 新增维度只需加一行（单测断言「行数 = 域数」）。
//
// 口径说明（如实登记）：`docs/D33` §8 步骤②还要求「各域 `build*Prompt` 改为『调 `buildSection` + 拼契约句」——
//   那一步与 `技-48` 同批做更安全（届时才需要分节拼装）；本轮先立注册表并证明**逐字一致**，
//   `buildSection` 反向调用既有构造器，等于把「事实源」收敛到注册表而**不动**各域内部。
//
// 纯内核：不碰宿主 / DOM / 定时器（`scripts/check-core-purity.js`）。
// ============================================================
import {
    buildMemoryRepairPrompt, applyMemoryMergeGroups, runMemoryRepair, groupPick,
    buildConceptRepairPrompt, applyConceptMergeGroups, runConceptRepair, conceptPickClusters,
} from './group-repair.js';
import { buildItemRepairPrompt, applyItemMergeGroups, runItemRepair, itemLowUsesPurge } from './item-repair.js';
import { buildPlanSuspRepairPrompt, applyPlanSuspMerge, applySuspenseMergeGroups, runPlanSuspRepair } from './plan-repair.js';
import { buildStateRepairPrompt, applyStateRepair, runStateRepair, pickStateRepairTargets } from './state-repair.js';
import { buildSceneRepairPrompt, applySceneRebuild, runSceneRepair } from './scene-repair.js';
import { buildCharacterRepairPrompt, applyCharacterRepairResult, runCharacterRepair, buildCharacterRepairQueue } from './character-repair.js';
import { buildRepairPrompt, repairApplyAiResult, runRepair, repairCollectCandidates } from './repair.js';

/** 域种类：`struct` = 结构类（去重 / 合并 / 剔除），`text` = 文本类（改写正文），`mixed` = 两者都有 */
export const REPAIR_KINDS = Object.freeze(['struct', 'text', 'mixed']);

/**
 * **注册表**（`docs/D33` §3.2 字段）。顺序 = 全面修复的执行顺序（结构类先于文本类，见 `docs/D33` §3.3）。
 *
 * 字段：
 *   · `id`    域键（`state` 里的容器名或既有域键）
 *   · `label` 中文名（面板 / 报告用，与既有文案一致）
 *   · `kind`  `struct` / `text` / `mixed`
 *   · `inTotal` 是否计入「全面修复」的域计数
 *   · `aggKey` 聚合契约里的 JSON 键（`技-48` 用）
 *   · `limits` 该域的上限键（`cfg` 键名数组；空数组 = 无独立上限）
 *   · `buildSection` 提示词节构造器（薄适配器，逐字等于既有 `build*Prompt`）
 *   · `apply` 应用器
 *   · `entry` 单域入口（面板 🔧 调的那个）
 *   · `pick` 候选选择器（无则 `null`）
 */
export const REPAIR_REGISTRY = Object.freeze([
    Object.freeze({
        id: 'memories', label: '记忆', kind: 'struct', inTotal: true, aggKey: 'memories',
        limits: Object.freeze(['storeMaxMemories']),
        buildSection: (pick) => buildMemoryRepairPrompt(pick),
        apply: (delta, pick) => applyMemoryMergeGroups(delta, pick),
        entry: (opts) => runMemoryRepair(opts || {}),
        pick: (n) => groupPick('memories', n),
    }),
    Object.freeze({
        id: 'concepts', label: '概念', kind: 'struct', inTotal: true, aggKey: 'concepts',
        limits: Object.freeze(['storeMaxConcepts']),
        buildSection: (pick) => buildConceptRepairPrompt(pick),
        apply: (delta, pick) => applyConceptMergeGroups(delta, pick),
        entry: (opts) => runConceptRepair(opts || {}),
        pick: (n) => conceptPickClusters(n),
    }),
    Object.freeze({
        id: 'items', label: '物品', kind: 'mixed', inTotal: true, aggKey: 'items',
        limits: Object.freeze(['storeMaxItems', 'itemRepairMaxItems']),
        buildSection: (pick) => buildItemRepairPrompt(pick),
        apply: (delta, pick) => applyItemMergeGroups(delta, pick),
        entry: (opts) => runItemRepair(opts || {}),
        pick: (n) => itemLowUsesPurge(n),
    }),
    Object.freeze({
        id: 'plans', label: '计划', kind: 'struct', inTotal: true, aggKey: 'plans',
        limits: Object.freeze(['storeMaxPlans']),
        buildSection: (pick) => buildPlanSuspRepairPrompt(pick),
        apply: (delta, pick) => applyPlanSuspMerge(delta, pick),
        entry: (opts) => runPlanSuspRepair(opts || {}),
        pick: null,
    }),
    Object.freeze({
        id: 'suspense', label: '悬念', kind: 'struct', inTotal: true, aggKey: 'suspense',
        limits: Object.freeze(['storeMaxSuspense']),
        buildSection: (pick) => buildPlanSuspRepairPrompt(pick),
        apply: (delta, pick) => applySuspenseMergeGroups(delta, pick),
        entry: (opts) => runPlanSuspRepair(opts || {}),
        pick: null,
    }),
    Object.freeze({
        id: 'currentStates', label: '状态记录', kind: 'text', inTotal: true, aggKey: 'currentStates',
        limits: Object.freeze(['stateMaxPerSubject']),
        buildSection: (pick) => buildStateRepairPrompt(pick),
        apply: (delta, pick) => applyStateRepair(delta, pick),
        entry: (opts) => runStateRepair(opts || {}),
        pick: (n) => pickStateRepairTargets(n),
    }),
    Object.freeze({
        id: 'scenes', label: '场景', kind: 'text', inTotal: true, aggKey: 'scenes',
        limits: Object.freeze(['storeMaxScenes', 'sceneRepairMaxItems']),
        buildSection: () => buildSceneRepairPrompt(),
        apply: (entries) => applySceneRebuild(entries),
        entry: (opts) => runSceneRepair(opts || {}),
        pick: null,
    }),
    Object.freeze({
        id: 'characters', label: '角色', kind: 'text', inTotal: true, aggKey: 'characters',
        limits: Object.freeze([]),
        buildSection: () => buildCharacterRepairPrompt(),
        apply: (delta, targets) => applyCharacterRepairResult(delta, targets),
        entry: (opts) => runCharacterRepair(opts || {}),
        pick: (n) => buildCharacterRepairQueue(n),
    }),
    Object.freeze({
        id: 'atoms', label: '情节', kind: 'text', inTotal: true, aggKey: 'atoms',
        limits: Object.freeze(['storeMaxAtoms']),
        buildSection: (cands) => buildRepairPrompt(cands),
        apply: (delta, cands) => repairApplyAiResult(delta, cands),
        entry: (opts) => runRepair(opts || {}),
        pick: (n) => repairCollectCandidates(n),
    }),
]);

/** 域键列表（顺序 = 执行顺序） */
export const REPAIR_DOMAIN_IDS = Object.freeze(REPAIR_REGISTRY.map((d) => d.id));

/** 注册表字段（单测断言「字段齐 9 项」用） */
export const REPAIR_REGISTRY_FIELDS = Object.freeze(['id', 'label', 'kind', 'inTotal', 'aggKey', 'limits', 'buildSection', 'apply', 'entry', 'pick']);

/**
 * 取一个域的注册项。
 * @param {string} id
 * @returns {object|null}
 */
export function repairDomain(id) {
    const key = String(id == null ? '' : id);
    return REPAIR_REGISTRY.filter((d) => d.id === key)[0] || null;
}

/** 参与「全面修复」的域（`inTotal:true` 的全集） */
export function repairTotalDomains() {
    return REPAIR_REGISTRY.filter((d) => d.inTotal === true);
}

/** 聚合契约的键集合（`技-48` 的 JSON 键；顺序固定） */
export function repairAggKeys() {
    return REPAIR_REGISTRY.map((d) => d.aggKey);
}

/** 某个域的上限键（`cfg` 键名；无独立上限返回空数组） */
export function repairLimitKeys(id) {
    const d = repairDomain(id);
    return d ? Array.prototype.slice.call(d.limits) : [];
}

/**
 * **自检**：注册表结构是否完整（字段齐 / id 唯一 / kind 合法 / 十项齐全）。
 *   供单测与 `技-48` 前置断言使用；返回问题列表（空 = 通过）。
 * @returns {Array<{domain:string, problem:string}>}
 */
export function repairRegistryIssues() {
    const out = [];
    const seen = {};
    REPAIR_REGISTRY.forEach((d) => {
        const id = String(d.id || '');
        if (!id) out.push({ domain: '(空)', problem: 'id 为空' });
        else if (seen[id]) out.push({ domain: id, problem: 'id 重复' });
        seen[id] = 1;
        REPAIR_REGISTRY_FIELDS.forEach((f) => {
            if (!(f in d)) out.push({ domain: id, problem: '缺字段 ' + f });
        });
        if (String(d.label || '').length === 0) out.push({ domain: id, problem: 'label 为空' });
        if (REPAIR_KINDS.indexOf(d.kind) < 0) out.push({ domain: id, problem: 'kind 非法：' + d.kind });
        if (typeof d.buildSection !== 'function') out.push({ domain: id, problem: 'buildSection 非函数' });
        if (typeof d.apply !== 'function') out.push({ domain: id, problem: 'apply 非函数' });
        if (typeof d.entry !== 'function') out.push({ domain: id, problem: 'entry 非函数' });
        if (d.pick !== null && typeof d.pick !== 'function') out.push({ domain: id, problem: 'pick 既非函数也非 null' });
        if (!Array.isArray(d.limits)) out.push({ domain: id, problem: 'limits 非数组' });
    });
    return out;
}
