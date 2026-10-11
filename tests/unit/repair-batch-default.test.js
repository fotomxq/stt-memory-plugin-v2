// ============================================================
// 单元测试 · v3.45.3（用户要求）：「各大类现有修复功能，每次限定可能抽取 3 个数据，改为默认抽取 6 个。
//   且该约定可在设定中设置修改。」
//
//   覆盖面：
//     A1 六个「每轮抽取量」默认值 = 6（单一事实源 `core/config.js#defaultCfg`）；
//     A2 六个键在设定页**都有控件**（= 用户要求的「可在设定中设置修改」），且标签写明「默认 6」；
//     A3 **行为**：默认配置下「修复状态」每轮抽 6 个主体（9 个候选 → 6；改前是 3）；
//     A4 **可改且真的生效**：把键改成其它值 → 抽取量随之变化；
//     A5 **行为**：默认配置下「修复概念」每轮核对 6 组（8 组候选 → 6；改前是 3）；
//     A6 **行为**：默认配置下「修复角色」每轮取 6 条（9 条待修 → 6；改前是 3）；
//     A7 上限仍生效（状态修复 ≤10 的既有夹取不变）且**未波及其它**（`maxAutoRepairRounds` 仍是 3）。
// 运行：node tests/unit/repair-batch-default.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { pickStateRepairTargets } from '../../core/state-repair.js';
import { GROUP_REPAIR_SPECS, groupPick } from '../../core/group-repair.js';
import { buildCharacterRepairQueue, runCharacterRepair } from '../../core/character-repair.js';
import { SETTINGS_CONTROLS, SETTINGS_TABS, findSettingsControls } from '../../ui/settings-pages.js';

const R = makeReporter('repair-batch-default v3.45.3 各大类修复每轮抽取量（默认 6 · 可在设定中改）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

/** 六个「每轮抽取量」键（v3.45.3 默认由 3 调整为 6） */
const KEYS = ['repairCharacterBatch', 'stateRepairBatch',
    'conceptRepairMaxClusters', 'memoryRepairMaxClusters', 'suspenseRepairMaxClusters', 'itemRepairMaxClusters'];

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);

let aiText = '';
setAiHooks({ callAi: async () => ({ ok: true, text: aiText }), feedText: () => '', busy: () => false });

function boot(stateLike) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    setLastMessageId(12);
    setKernelState(Object.assign(emptyState(), JSON.parse(JSON.stringify(stateLike || {}))));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    aiText = '';
    return state;
}

// ---------- A1：默认值 ----------
A('A1 六个「每轮抽取量」默认值 = 6（角色修复条数 / 状态修复主体数 / 概念·记忆·悬念·物品四域的「每次核对组数」）—— 改前均为 3', (() => {
    boot({});
    const wrong = KEYS.filter((k) => Number(defaultCfg[k]) !== 6);
    return wrong.length === 0 && KEYS.every((k) => Number(cfg[k]) === 6);
})(), () => KEYS.map((k) => [k, defaultCfg[k]]));

// ---------- A2：可在设定中修改 ----------
A('A2 六个键在设定页**都有控件**（用户要求的「可在设定中设置修改」），且标签/提示写明「默认 6」', (() => {
    const all = [];
    for (const t of SETTINGS_TABS) for (const c of (SETTINGS_CONTROLS[t.id] || [])) if (c && c.key) all.push(c);
    const miss = KEYS.filter((k) => !all.some((c) => String(c.key) === k));
    const texts = KEYS.map((k) => {
        const c = all.find((x) => String(x.key) === k) || {};
        return String(c.label || '') + ' ' + String(c.hint || '');
    });
    const noSix = KEYS.filter((k, i) => texts[i].indexOf('默认 6') < 0);
    return miss.length === 0 && noSix.length === 0 && findSettingsControls('repairCharacterBatch', 50).length >= 1;
})(), () => {
    const all = [];
    for (const t of SETTINGS_TABS) for (const c of (SETTINGS_CONTROLS[t.id] || [])) if (c && c.key) all.push([c.key, c.label, c.hint || '']);
    return all.filter((x) => KEYS.indexOf(x[0]) >= 0);
});

// ---------- A3：状态修复抽 6 ----------
A('A3 行为：默认配置下「修复状态」每轮抽 6 个主体（9 个候选 → 6 条；改前是 3 条）', (() => {
    boot({ currentStates: Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, subject: '角色' + i, field: '心情', value: '平静', uses: 1 })) });
    const p = pickStateRepairTargets();
    return p.batch === 6 && p.total === 9 && p.list.length === 6;
})(), () => { boot({ currentStates: Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, subject: '角色' + i, field: '心情', value: '平静' })) }); return pickStateRepairTargets(); });

// ---------- A4：可改且生效 ----------
A('A4 「可改」真的生效：把 `stateRepairBatch` 设为 2 → 同一批候选只抽 2 条；设为 10（上限）→ 抽 10 条', (() => {
    const mk = () => ({ currentStates: Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, subject: '角色' + i, field: '心情', value: '平静', uses: 1 })) });
    boot(mk());
    cfg.stateRepairBatch = 2;
    const two = pickStateRepairTargets();
    boot(mk());
    cfg.stateRepairBatch = 10;
    const ten = pickStateRepairTargets();
    return two.batch === 2 && two.list.length === 2 && ten.batch === 10 && ten.list.length === 10;
})(), '见断言');

// ---------- A5：概念修复核 6 组 ----------
A('A5 行为：默认配置下「修复概念」每轮核对 6 组（8 组候选 → 6 组；改前是 3 组），条目仍受「每次提交条数上限」约束', (() => {
    const concepts = [];
    for (let g = 0; g < 8; g++) for (let j = 0; j < 2; j++) {
        concepts.push({ id: 'c' + g + '_' + j, name: '概念' + g + '之' + j, content: '第 ' + g + ' 组的第 ' + j + ' 条', tags: ['标签' + g + '甲', '标签' + g + '乙'] });
    }
    boot({ concepts });
    const pick = groupPick(GROUP_REPAIR_SPECS.concepts);
    const allGroups = groupPick(GROUP_REPAIR_SPECS.concepts);
    return pick.clusters.length === 6 && pick.entries.length >= 12 && pick.entries.length <= Number(cfg.conceptRepairMaxItems)
        && allGroups.picked === 6;
})(), () => {
    const concepts = [];
    for (let g = 0; g < 8; g++) for (let j = 0; j < 2; j++) {
        concepts.push({ id: 'c' + g + '_' + j, name: '概念' + g + '之' + j, content: '第 ' + g + ' 组', tags: ['标签' + g + '甲', '标签' + g + '乙'] });
    }
    boot({ concepts });
    const p = groupPick(GROUP_REPAIR_SPECS.concepts);
    return { clusters: p.clusters.length, entries: p.entries.length, total: p.total };
});

// ---------- A6：角色修复取 6 条 ----------
await (async () => {
    const snap = (i) => ({ id: 'p' + i, name: '角色' + i, identity: { gender: '男' }, appearance: '', personality: {}, background: {}, tags: [], uses: 1 });
    boot({ snapshots: Array.from({ length: 9 }, (_, i) => snap(i)) });
    cfg.repairCharacterMinSize = 400;      // 门限抬高 → 9 条全部「待修」
    const q = buildCharacterRepairQueue();
    aiText = '{}';                          // AI 不给出任何修订 → 走 noChange 路径，但 targets 已按批取
    const r = await runCharacterRepair({ silent: true });
    A('A6 行为：默认配置下「修复角色」每轮取 6 条（9 条待修 → 6 条；改前是 3 条）', (() => {
        return q.list.length >= 9 && r && r.targets === 6;
    })(), () => ({ queue: q.list.length, targets: r && r.targets, noChange: r && r.noChange }));
})();

// ---------- A7：上限与「未波及」 ----------
A('A7 上限与未波及项：状态修复仍夹取 ≤10（`Math.min(10,…)` 不变）；`maxAutoRepairRounds`（同楼层轮次上限）与 `repairMaxItems`（候选池）**未变**', (() => {
    boot({ currentStates: Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, subject: '角色' + i, field: '心情', value: '平静' })) });
    cfg.stateRepairBatch = 99;
    const p = pickStateRepairTargets();
    return p.batch === 10 && p.list.length === 10
        && Number(defaultCfg.maxAutoRepairRounds) === 3 && Number(defaultCfg.repairMaxItems) === 20
        && Number(defaultCfg.summaryChunkSize) === 3;      // 段落长度（非修复抽取量）不受影响
})(), () => { boot({ currentStates: Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, subject: '角色' + i, field: '心情', value: '平静' })) }); cfg.stateRepairBatch = 99; return pickStateRepairTargets(); });

R.done();
