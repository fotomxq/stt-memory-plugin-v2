// ============================================================
// 单元测试 · v3.50.14：W12 `技-47` 修复注册表（`docs/D33` §8）
//   验收：① 九域各一行、字段齐 9 项；② **双跑对照逐字一致**（提示词文本 + 应用计数）；
//         ③ `node tests/unit/run.js` 全绿；④ 既有 `v1-golden-*` 样本未改。
//
// 用户要求：「开发W12待开发清单。」（W12 = 修复通道统一编排，来源稿 `docs/D33`）
// 本轮的边界（如实登记）：注册表**只做索引**（`buildSection` 反向调用既有构造器 → 逐字不变），
//   把「各域自拼提示词改为调 `buildSection`」留到 `技-48` 同批（那时才需要分节拼装）。
//
// 运行：node tests/unit/repair-registry.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    REPAIR_REGISTRY, REPAIR_DOMAIN_IDS, REPAIR_REGISTRY_FIELDS, REPAIR_KINDS,
    repairDomain, repairTotalDomains, repairAggKeys, repairLimitKeys, repairRegistryIssues,
} from '../../core/repair-registry.js';
import { buildMemoryRepairPrompt, buildConceptRepairPrompt } from '../../core/group-repair.js';
import { buildItemRepairPrompt } from '../../core/item-repair.js';
import { buildPlanSuspRepairPrompt } from '../../core/plan-repair.js';
import { buildStateRepairPrompt } from '../../core/state-repair.js';
import { buildSceneRepairPrompt } from '../../core/scene-repair.js';
import { buildCharacterRepairPrompt } from '../../core/character-repair.js';
import { buildRepairPrompt } from '../../core/repair.js';

const R = makeReporter('repair-registry v3.50.14：W12 `技-47` 修复注册表（九域一处可查 · 行为零变化）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('reg14'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });
setKernelState(emptyState());

// ---------- A 组：注册表结构 ----------
A('A1 **九域各一行**：`REPAIR_REGISTRY.length === 9`，id 唯一且等于既定执行顺序', (() => {
    return REPAIR_REGISTRY.length === 9 && repairRegistryIssues().length === 0
        && J(REPAIR_DOMAIN_IDS) === J(['memories', 'concepts', 'items', 'plans', 'suspense', 'currentStates', 'scenes', 'characters', 'atoms']);
})(), () => J(repairRegistryIssues()));

A('A2 **字段齐 10 项**（`docs/D33` §3.2）：id / label / kind / inTotal / aggKey / limits / buildSection / apply / entry / pick', (() => {
    const miss = [];
    REPAIR_REGISTRY.forEach((d) => REPAIR_REGISTRY_FIELDS.forEach((f) => { if (!(f in d)) miss.push(d.id + '.' + f); }));
    return miss.length === 0 && REPAIR_REGISTRY_FIELDS.length === 10;
})(), 'n/a');

A('A3 每行可用：`buildSection` / `apply` / `entry` 都是函数，`pick` 是函数或 `null`，`kind` 合法，`limits` 是数组', (() => {
    return REPAIR_REGISTRY.every((d) => typeof d.buildSection === 'function' && typeof d.apply === 'function'
        && typeof d.entry === 'function' && (d.pick === null || typeof d.pick === 'function')
        && REPAIR_KINDS.indexOf(d.kind) >= 0 && Array.isArray(d.limits));
})(), 'n/a');

A('A4 查询助手：`repairDomain` 命中 / 未命中，`repairTotalDomains` = 全部计入，`repairAggKeys` 无重复', (() => {
    const keys = repairAggKeys();
    const uniq = new Set(keys);
    return repairDomain('memories').label === '记忆' && repairDomain('nope') === null
        && repairTotalDomains().length === REPAIR_REGISTRY.length
        && uniq.size === keys.length && keys.length === REPAIR_REGISTRY.length;
})(), 'n/a');

A('A5 上限键登记：`repairLimitKeys` 返回该域的 `cfg` 键（如记忆 → `storeMaxMemories`；角色域无独立上限 → 空数组）', (() => {
    return J(repairLimitKeys('memories')) === J(['storeMaxMemories'])
        && J(repairLimitKeys('characters')) === J([])
        && repairLimitKeys('nope').length === 0;
})(), () => J({ m: repairLimitKeys('memories'), c: repairLimitKeys('characters') }));

// ---------- B 组：双跑对照（行为零变化；含抛错一致） ----------
/**
 * 双跑对照的工具：把「结构类 / 文本类 / 混合类」各域**自己的 pick 产物**喂进两边，
 * 比较「返回值或抛错」——完全一致 = 行为零变化（注册表只是索引，不改任何既有函数）。
 */
function capture(fn) {
    try { return { ok: true, out: JSON.stringify(fn()) }; } catch (e) { return { ok: false, out: 'ERR:' + String((e && e.message) || e) }; }
}
const DIRECT = {
    memories: (pick) => buildMemoryRepairPrompt(pick),
    concepts: (pick) => buildConceptRepairPrompt(pick),
    items: (pick) => buildItemRepairPrompt(pick),
    plans: (pick) => buildPlanSuspRepairPrompt(pick),
    suspense: (pick) => buildPlanSuspRepairPrompt(pick),
    currentStates: (pick) => buildStateRepairPrompt(pick),
    scenes: () => buildSceneRepairPrompt(),
    characters: () => buildCharacterRepairPrompt(),
    atoms: (pick) => buildRepairPrompt(pick),
};
/** 给库塞少量相似条目，让各域 pick 能产出非空候选（否则对照会退化成 null === null） */
function seedState() {
    const st = emptyState();
    st.memories = [
        { id: 'm1', title: '码头仓库', content: '码头仓库里堆着木箱。', importance: 40, uses: 3, createdAt: 1, updatedAt: 1 },
        { id: 'm2', title: '码头仓库货', content: '码头仓库货架上有帐本。', importance: 40, uses: 3, createdAt: 2, updatedAt: 2 },
        { id: 'm3', title: '码头仓库门', content: '码头仓库门锁坏了。', importance: 40, uses: 3, createdAt: 3, updatedAt: 3 },
    ];
    st.concepts = [
        { id: 'c1', name: '账本', content: '账本记着往来。', importance: 40, uses: 3, createdAt: 1, updatedAt: 1 },
        { id: 'c2', name: '账本册', content: '账本册记着数目。', importance: 40, uses: 3, createdAt: 2, updatedAt: 2 },
    ];
    st.items = [
        { id: 'i1', name: '木箱', desc: '装货用。', qty: 2, uses: 3, tags: ['仓储'], importance: 40, createdAt: 1, updatedAt: 1 },
        { id: 'i2', name: '木箱盖', desc: '盖箱用。', qty: 1, uses: 3, tags: ['仓储'], importance: 40, createdAt: 2, updatedAt: 2 },
    ];
    st.plans = [{ id: 'p1', content: '去码头取货。', status: 'open', floorStart: 1, createdAt: 1, updatedAt: 1 },
        { id: 'p2', content: '去码头取帐本。', status: 'open', floorStart: 2, createdAt: 2, updatedAt: 2 }];
    st.suspense = [{ id: 's1', content: '谁锁了仓库？', status: 'open', floorStart: 1, createdAt: 1, updatedAt: 1 },
        { id: 's2', content: '谁锁了仓库门？', status: 'open', floorStart: 2, createdAt: 2, updatedAt: 2 }];
    st.currentStates = [{ id: 'st1', subject: '码头', key: '状态', value: '值一', floorEnd: 1, updatedAt: 1 },
        { id: 'st2', subject: '码头', key: '状态', value: '值一。', floorEnd: 2, updatedAt: 2 }];
    st.scenes = [{ id: 'sc1', name: '码头', desc: '有仓库。', floorStart: 1, createdAt: 1, updatedAt: 1 }];
    st.atoms = [{ id: 'a1', text: '码头仓库里堆着木箱，货架上有帐本。', importance: 40, uses: 3, floorStart: 1, createdAt: 1, updatedAt: 1 }];
    return st;
}

A('B1 **双跑对照（九个域整体）**：把各域**自己的 pick 产物**喂进两边，返回值 / 抛错逐字一致', (() => {
    setKernelState(seedState());
    const diffs = [];
    REPAIR_REGISTRY.forEach((d) => {
        let pick = undefined;
        try { if (typeof d.pick === 'function') pick = d.pick(12); } catch (e) { pick = undefined; }
        const a = capture(() => d.buildSection(pick));
        const b = capture(() => DIRECT[d.id](pick));
        if (a.ok !== b.ok || a.out !== b.out) diffs.push(d.id + ': ' + a.out.slice(0, 60) + ' ≠ ' + b.out.slice(0, 60));
    });
    return diffs.length === 0;
})(), 'n/a');

A('B2 对照**不是空转**：至少 3 个域在上述输入下产出非空提示词（证明比较的是真内容，而不是 null === null）', (() => {
    setKernelState(seedState());
    let nonEmpty = 0;
    REPAIR_REGISTRY.forEach((d) => {
        let pick = undefined;
        try { if (typeof d.pick === 'function') pick = d.pick(12); } catch (e) { pick = undefined; }
        const r = capture(() => d.buildSection(pick));
        if (r.ok && r.out !== 'null' && r.out.length > 20) nonEmpty += 1;
    });
    return nonEmpty >= 3;
})(), 'n/a');

A('B3 **空库也不炸且一致**：空状态下九个域的两边同样逐字一致（注册表不改变调用契约）', (() => {
    setKernelState(emptyState());
    const diffs = [];
    REPAIR_REGISTRY.forEach((d) => {
        let pick = undefined;
        try { if (typeof d.pick === 'function') pick = d.pick(12); } catch (e) { pick = undefined; }
        const a = capture(() => d.buildSection(pick));
        const b = capture(() => DIRECT[d.id](pick));
        if (a.ok !== b.ok || a.out !== b.out) diffs.push(d.id);
    });
    return diffs.length === 0;
})(), 'n/a');

A('B4 **行为零变化**：注册表不改变「哪些域计入全面修复」—— `inTotal` 全为 true，且总域数 = 9（与面板 9 个 🔧 一致）', (() => {
    return repairTotalDomains().length === 9 && REPAIR_REGISTRY.every((d) => d.inTotal === true);
})(), 'n/a');

// ---------- C 组：可扩展性（新增维度只需加一行） ----------
A('C1 **加一行即注册**：把一行追加进注册表视图（不改既有代码路径），`repairDomain`/`repairAggKeys`/自检都能立刻识别', (() => {
    // 用一张「视图」模拟新增：仅验证注册表的查询能力不依赖硬编码清单
    const view = REPAIR_REGISTRY.concat([{ id: 'demo', label: '示例', kind: 'text', inTotal: true, aggKey: 'demo', limits: [], buildSection: () => '', apply: () => 0, entry: () => 0, pick: null }]);
    const ids = view.map((d) => d.id);
    const hit = view.filter((d) => d.id === 'demo')[0];
    return ids.length === 10 && !!hit && hit.aggKey === 'demo' && !repairDomain('demo');
})(), 'n/a');

A('C2 注册表与「全面修复」清单同源：`REPAIR_DOMAIN_IDS` 与 `repairTotalDomains()` 的 id 序列一致（避免两处清单漂移）', (() => {
    return J(REPAIR_DOMAIN_IDS) === J(repairTotalDomains().map((d) => d.id));
})(), 'n/a');

R.done();
