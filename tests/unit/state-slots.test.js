// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-15`** —— 不留「看起来能用实际无效」的位置
//   设计：`docs/D20` §3.4 / §8 `数-15`（「对 `protagonist` 等逐项判定：**接线** 或 **从界面移除并标注「未启用」**」；
//         验收：「`state` 里每个保留字段都有明确归属与出口说明」）
//   实现：`core/state-slots.js`（登记表 = 单一事实源）· `core/data-health.js`（hygiene 两项）
//
// 本文件把「验收」**机械化**：
//   ① **双向一致**：`emptyState()` 的顶层键集 ↔ `STATE_SLOTS`；`state` 容器内部键集 ↔ `STATE_INNER_SLOTS`
//      —— 新增槽位不登记就红（不再靠人记「这个字段是谁的」）；
//   ② **运行期槽位已登记**：`RUNTIME_SLOTS`（生产代码会写、但不在 `emptyState()` 里的那些）同样登记，
//      且与 `STATE_SLOTS` **不重叠** —— 否则体检会天天报噪声（报噪声的检查等于没有检查）；
//   ③ **逐项判定有据**：`wired / reserved / legacy` 三档；`reserved`（保留未启用）与死读配置键都必须写明理由；
//   ④ **体检只在「保留槽位真的装着数据」时报**（空白存档零噪声，「干净 = 无明细」的不变量因此保住）。
//
// 运行：node tests/unit/state-slots.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    RESERVED_CFG_READS, RUNTIME_SLOTS, STATE_INNER_RUNTIME_SLOTS, STATE_INNER_SLOTS, STATE_SLOTS,
    registeredSlotKeys, stateSlotReport, stateSlotSelfCheck,
} from '../../core/state-slots.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('state-slots v3.44.0 存档槽位登记（D22 W4 数-15）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

A('T1 **双向一致（机械化验收）**：`emptyState()` 顶层键 ↔ `STATE_SLOTS`、`state` 内部键 ↔ `STATE_INNER_SLOTS`，两个方向都不许有差', (() => {
    const c = stateSlotSelfCheck();
    return c.ok === true && c.missingInRegistry.length === 0 && c.missingInState.length === 0
        && c.innerMissingInRegistry.length === 0 && c.innerMissingInState.length === 0
        && c.runtimeCollisions.length === 0;
})(), J(stateSlotSelfCheck()));

A('T2 运行期槽位已登记且**不与声明槽位重叠**：`RUNTIME_SLOTS` 里每个键都有 `evidence`（写到哪个文件的哪个写入点），便于日后核对「这个槽位还活着吗」', (() => {
    const keys = Object.keys(RUNTIME_SLOTS);
    const noEvidence = keys.filter((k) => !String(RUNTIME_SLOTS[k].evidence || '').trim());
    const collide = keys.filter((k) => Object.prototype.hasOwnProperty.call(STATE_SLOTS, k))
        .concat(Object.keys(STATE_INNER_RUNTIME_SLOTS).filter((k) => Object.prototype.hasOwnProperty.call(STATE_INNER_SLOTS, k)));
    // 三个「真机实测写过、但 emptyState 不声明」的槽位必须在册（`数-14` 的两个基线 + 快照链）
    return keys.length >= 10 && noEvidence.length === 0 && collide.length === 0
        && keys.indexOf('weaveLastFloor') >= 0 && keys.indexOf('parallelFloor') >= 0 && keys.indexOf('snapStore') >= 0;
})(), J(Object.keys(RUNTIME_SLOTS)));

A('T3 逐项判定齐备：每个声明槽位都有 `label` / `semantics` / `wired` / `outlets` / `disposition`；`disposition` 只取三档', (() => {
    const bad = Object.keys(STATE_SLOTS).filter((k) => {
        const d = STATE_SLOTS[k];
        return !String(d.label || '').trim() || !String(d.semantics || '').trim()
            || typeof d.wired !== 'boolean' || !Array.isArray(d.outlets) || !d.outlets.length
            || ['wired', 'reserved', 'legacy'].indexOf(d.disposition) < 0;
    });
    return bad.length === 0 && registeredSlotKeys().length === Object.keys(emptyState()).length;
})(), J(Object.keys(STATE_SLOTS).filter((k) => STATE_SLOTS[k].disposition !== 'wired')));

A('T4 **保留未启用 / 遗留**三类逐项有据：`protagonist`（只被 best-effort 读、无写入）、`varTemplates`（只出现在跨端容器名单）、`state.sceneFocus`（全仓零读写）；`npcs` / `summaries` 记 legacy', (() => {
    const rep = stateSlotReport(emptyState());
    const reserved = rep.reserved.map((x) => x.key).sort();
    const legacy = rep.legacy.map((x) => x.key).sort();
    return J(reserved) === J(['protagonist', 'state.sceneFocus', 'varTemplates'])
        && J(legacy) === J(['npcs', 'summaries'])
        && STATE_SLOTS.protagonist.wired === false && STATE_INNER_SLOTS.sceneFocus.wired === false
        && J(RESERVED_CFG_READS.map((x) => x.key)) === J(['protagonistName'])
        && String(RESERVED_CFG_READS[0].note).indexOf('无控件可写') > 0;
})(), J(stateSlotReport(emptyState()).reserved.map((x) => x.key)));

A('T5 未登记槽位会被抓出来：人为塞一个 `zzzStray` → 体检 `state-slot-unregistered` 出现（`hygiene`），登记表本身不动', (() => {
    const s = Object.assign(emptyState(), { zzzStray: 1 });
    const rep = dataHealthReport(s);
    const f = rep.hygiene.findings.filter((x) => x.code === 'state-slot-unregistered');
    const s2 = emptyState();
    if (s2.state) s2.state.zzzInner = 1;
    const rep2 = dataHealthReport(s2);
    return rep.hygiene.counts['state-slot-unregistered'] === 1 && f.length === 1
        && String(f[0].field).indexOf('zzzStray') >= 0
        && rep2.hygiene.counts['state-slot-unregistered'] === 1
        && Object.keys(STATE_SLOTS).indexOf('zzzStray') < 0;
})(), '');

A('T6 **干净状态零噪声**：空白存档下「保留未启用」**不报**（槽位是空的）—— 「体检干净 = 无明细」的不变量保住', (() => {
    const rep = dataHealthReport(emptyState());
    return !rep.hygiene.counts['state-slot-reserved']
        && rep.findings.length === 0 && rep.level === 'ok' && rep.ok === true;
})(), J(dataHealthReport(emptyState()).hygiene.counts));

A('T7 只有装了数据才报：`protagonist` 有内容 / `state.sceneFocus` 非 null → `state-slot-reserved` 出现，并写明「未接线」与死读键', (() => {
    const s1 = Object.assign(emptyState(), { protagonist: { name: '甲' } });
    const s2 = emptyState(); s2.state.sceneFocus = { scene: 'sc1' };
    const r1 = dataHealthReport(s1), r2 = dataHealthReport(s2);
    const f1 = r1.hygiene.findings.filter((x) => x.code === 'state-slot-reserved')[0] || {};
    return r1.hygiene.counts['state-slot-reserved'] === 1 && String(f1.field).indexOf('protagonist') >= 0
        && String(f1.detail).indexOf('未接线') > 0 && String(f1.detail).indexOf('protagonistName') > 0
        && r2.hygiene.counts['state-slot-reserved'] === 1 && String((r2.hygiene.findings.filter((x) => x.code === 'state-slot-reserved')[0] || {}).field).indexOf('state.sceneFocus') >= 0
        && r1.findings.filter((x) => x.code === 'state-slot-reserved').length === 0;   // 不进 findings
})(), '');

A('T8 `varTemplates` 的默认值**不算数据**（空白默认与「装了东西」必须能分辨）—— 默认全空 → 不报；json 里有内容才报', (() => {
    const base = emptyState();
    const r0 = dataHealthReport(base);
    const s = emptyState();
    s.varTemplates.global.json = { hp: 10 };
    const r1 = dataHealthReport(s);
    return !r0.hygiene.counts['state-slot-reserved']
        && r1.hygiene.counts['state-slot-reserved'] === 1
        && String((r1.hygiene.findings.filter((x) => x.code === 'state-slot-reserved')[0] || {}).field).indexOf('varTemplates') >= 0;
})(), '');

R.done();
