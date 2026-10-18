// ============================================================
// 单元测试 · v3.50.24：W4 `数-1`（旧数据重要度迁移 + C3 权重重标定，同批）+ `数-2`（假 0% → 不适用）
//
// `数-1`（`docs/D20` §8 / `docs/D7` §4.9 C3，裁决 Q4「仅窗内 + 逐批」）：
//   · 存量 `importance` 是 V1 语义（≈0.5），新语义是窗口占比（≈1/21≈0.048）；
//   · 因此 `0.15 → 1.6` 必须与**迁移**同批：迁移前权重 0.15、迁移后 1.6，两者「均值贡献」等价 → 注入择优不变。
// `数-2`（`docs/D20` §8）：没有 `importance` 字段的维度不得显示成 **0%**，用 `importancePctOrNull()` 返回 `null`（不适用）。
//
// 运行：node tests/unit/importance-migrate.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    IMP_MIGRATE_FLAG, IMP_LEGACY_SCALE, IMP_WEIGHT_LEGACY, IMP_WEIGHT_V2,
    importanceMigrated, importanceWeight, migrateLegacyImportance,
} from '../../core/importance-migrate.js';
import { recalcImportanceAfterExtract } from '../../core/importance.js';
import { importancePct, importancePctOrNull, recallEntryScore } from '../../core/recall.js';

const R = makeReporter('importance-migrate v3.50.24：W4 `数-1`（迁移 + C3 权重重标定）+ `数-2`（不适用口径）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('im24'); setLastMessageId(9);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });

/** 造 25 条记忆：V1 语义 importance=0.5，uses 各 1（窗内 20 条会被重算，窗外 5 条被缩放） */
function mkLegacy() {
    const st = emptyState();
    const arr = [];
    for (let i = 0; i < 25; i++) arr.push({ id: 'm' + i, title: 't' + i, text: '第' + i + '条记忆正文足够长。', importance: 0.5, strength: 50, uses: 1, tags: [], floorStart: i + 1, floorEnd: i + 1 });
    st.memories = arr;
    return st;
}

// ---------- A 组：权重随迁移标志切换 ----------
A('A1 未迁移 → 权重 **0.15**；`importanceWeight()` 与 `importanceMigrated()` 一致', (() => {
    const st = mkLegacy();
    return importanceMigrated(st) === false && importanceWeight(st) === IMP_WEIGHT_LEGACY && IMP_WEIGHT_LEGACY === 0.15;
})(), 'n/a');

A('A2 迁移后 → 权重 **1.6**；标志位是 `state.meta.importanceV2`（随存档走）', (() => {
    const st = mkLegacy();
    setKernelState(st);
    const r = migrateLegacyImportance();
    return r.ok === true && r.migrated === true && importanceMigrated() === true
        && importanceWeight() === IMP_WEIGHT_V2 && state.meta[IMP_MIGRATE_FLAG] === true;
})(), 'n/a');

// ---------- B 组：迁移本身（窗内重算 + 窗外缩放 + 幂等） ----------
A('B1 **窗内**按新语义重算：最近 20 条变成窗口占比（各 1/21 ≈ 0.048），不再是 0.5', (() => {
    const st = mkLegacy();
    setKernelState(st);
    migrateLegacyImportance();
    const tail = state.memories.slice(-20);
    // 窗口 = ±10（半径 10）；尾部条目窗口被数组边界截断 → 占比略高（1/11≈0.091），中部 ≈ 1/20 = 0.05
    return tail.every((e) => e.importance > 0 && e.importance < 0.2)
        && Math.abs(state.memories[15].importance - 0.05) < 0.02;
})(), () => J(state.memories.slice(-3).map((e) => e.importance)));

A('B2 **窗外**旧尺度按 ÷10 缩放（保留相对次序；`strength` 同步），迁移后不再有 0.5 这类旧值', (() => {
    const st = mkLegacy();
    setKernelState(st);
    const r = migrateLegacyImportance();
    const outside = state.memories.slice(0, 5);
    return r.scaled >= 0 && outside.every((e) => e.importance === 0.05)
        && state.memories.every((e) => e.importance < 0.2)
        && IMP_LEGACY_SCALE === 0.1;
})(), () => J(state.memories.slice(0, 3).map((e) => e.importance)));

A('B3 **幂等**：第二次调用直接跳过（`skipped=already`），不改任何值', (() => {
    const st = mkLegacy();
    setKernelState(st);
    migrateLegacyImportance();
    const snapshot = J(state.memories.map((e) => e.importance));
    const again = migrateLegacyImportance();
    return again.migrated === false && again.skipped === 'already' && J(state.memories.map((e) => e.importance)) === snapshot;
})(), 'n/a');

A('B4 `recalcImportanceAfterExtract({migrateLegacy:true})` 会触发迁移；**不传则不触发**（保住单测/黄金样本）', (() => {
    const st1 = mkLegacy();
    setKernelState(st1);
    recalcImportanceAfterExtract({ dims: ['memories'] });
    const noMigrate = importanceMigrated();
    const st2 = mkLegacy();
    setKernelState(st2);
    recalcImportanceAfterExtract({ dims: ['memories'], migrateLegacy: true });
    const migrated = importanceMigrated();
    return noMigrate === false && migrated === true;
})(), 'n/a');

// ---------- C 组：注入择优等价（`数-1` 的发布判据） ----------
A('C1 **均值贡献等价**：旧（0.5 × 0.15）= 0.075；新（0.05 × 1.6）= 0.08 → 差 < 0.01（注入择优不因重标定而改变）', (() => {
    const diff = Math.abs(0.5 * IMP_WEIGHT_LEGACY - 0.05 * IMP_WEIGHT_V2);
    return diff < 0.01;
})(), 'n/a');

A('C2 同一条目迁移前/后的**召回分**基本一致（其它因子相同）', (() => {
    const legacy = { id: 'x', title: 'x', text: 'x', importance: 0.5, uses: 0, floorStart: 1, floorEnd: 1, tags: [] };
    const st = emptyState();
    st.memories = [legacy];
    setKernelState(st);
    const before = recallEntryScore(legacy, '');
    migrateLegacyImportance();
    const migratedEntry = Object.assign({}, legacy, { importance: 0.05 });
    const after = recallEntryScore(migratedEntry, '');
    return Math.abs(before - after) < 0.01;
})(), 'n/a');

// ---------- D 组：`数-2` 不适用口径 ----------
A('D1 `importancePctOrNull`：**没有** importance/strength 的条目 → `null`（不适用）；有的 → 数值', (() => {
    const scene = { id: 's1', path: '甲/乙', summary: '场景概要足够长。' };
    const atom = { id: 'a1', text: '正文足够长。', importance: 0.42 };
    return importancePctOrNull(scene) === null && importancePctOrNull(atom) === 42
        && importancePct(atom) === 42
        && importancePctOrNull({ id: 'z', importance: 0 }) === null          // 无信号（0）也判「不适用」，不再显示假 0%
        && importancePctOrNull({ id: 'y', importance: 0.02 }) === 2;          // 真正有信号的低占比照常显示
})(), 'n/a');

A('D2 `importancePct` **保持原口径**（数值；V1 行正文黄金样本依赖它），没有字段时才是 0（旧行为不变）', (() => {
    const scene = { id: 's1' };
    return importancePct(scene) === 0 && importancePct({ importance: 0.5 }) === 50;
})(), 'n/a');

A('D3 三个「不参与重要度」的维度（场景 / 名册 / 货币）真实条目上都返回 `null`', (() => {
    const st = emptyState();
    st.scenes = [{ id: 'sc1', path: '甲/乙', summary: '概要足够长的一句话。' }];
    st.npcs = [{ id: 'n1', name: '张三', role: '同伴', desc: '描述足够长。' }];
    st.currencies = [{ id: 'c1', owner: '主角', name: '铜钱', amount: 10, history: [] }];
    setKernelState(st);
    return importancePctOrNull(state.scenes[0]) === null
        && importancePctOrNull(state.npcs[0]) === null
        && importancePctOrNull(state.currencies[0]) === null;
})(), 'n/a');

R.done();
