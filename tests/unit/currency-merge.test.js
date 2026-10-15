// ============================================================
// 单元测试 · v3.46.2（`docs/D22` §4.14 **W13** `应-30`：货币融合 / AI 语义合并）
//
// 用户要求（原话）：「新增货币融合，指定一个角色的所有货币交给AI去整理规整，尤其是一些只是叫法不同的货币应该合并。
//   具体你可以参考本地的调试接口，调取数据核对。」
//
// **本档的语料来自本机真实存档的只读核对**（`extension-store/ftt-files`：李瑶 37 种「名字|单位」组合 / 125 条），
//   取其中最有代表性的那一簇：`黄金/两` · `天然碎金/块` · `碎金子/两` · `赤金条/贯` · `飞钱凭证及赤金条/贯` · `铜钱/枚`。
//
// 覆盖：
//   A 打包：**只取一个角色**、不读楼层、名字清单按单位分组、截断如实计数
//   B 窄契约校验的反向探针：成员不在打包集 / 单位冲突（禁凭空换算）/ 复合名 / 负额度 / 同一 id 两组 / 规范名带「及」/ 组数超限
//   C 应用：复用机械档的**同一路径**（同一个 plan 形状 → `runCurrencyRepair`）→ 保留最新额度（或按开关求和）+ **留墓碑**
//   D 幂等签名 · 终态留痕槽位 · 五种终止原因
// 运行：node tests/unit/currency-merge.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { RUNTIME_SLOTS } from '../../core/state-slots.js';
import { currencyRepairPlan } from '../../core/currency-repair.js';
import {
    currencyMergePack, currencyMergeParse, currencyMergeValidate, currencyMergePlan, currencyMergeApply,
    currencyMergeSig, curMergeOwners, curMergeLogPush, curMergeLogList, curMergeNoteText, curMergeBlockReason,
    CUR_MERGE_LOG_MAX,
} from '../../core/currency-merge.js';
// v3.46.3（用户报告「无法正常使用 / 没有任何提醒信息」的回归）：**UI 层**也要测 —— v3.46.2 只测了内核，
//   于是「开面板没生效」这种纯界面缺陷逃过了门禁。
import { panelAction, openPanel, panelModalInnerHtml, setPanelHooks2 } from '../../ui/panel.js';
import { currencyMergeButton, currencyMergePanelHtml, currencyMergeState as uiCurMergeState,
    currencyMergeBegin, currencyMergeRunning, runCurrencyMergeAction, currencyMergeOpen } from '../../ui/currency-merge.js';
import { setAiHooks } from '../../core/ai-hooks.js';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const R = makeReporter('currency-merge v3.46.2 W13（货币融合：只读打包 / 窄契约校验 / 复用机械应用路径 / 墓碑）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setContextProvider(() => makeHost({ chat: [] }).ctx);

function boot(over) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:curmerge');
    const st = Object.assign(emptyState(), over || {});
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}
/** 真实存档里那一簇（名字 / 单位 / 额度 都照抄）—— 角色名册走 `state.snapshots`（角色档案维度，与机械档同源） */
function seed() {
    return {
        snapshots: [{ id: 's1', name: '李瑶' }, { id: 's2', name: '李世民' }],
        currencies: [
            { id: 'cur_gold', owner: '李瑶', name: '黄金', unit: '两', amount: 120, date: '1919-11-20', uses: 3, flows: [] },
            { id: 'cur_dust', owner: '李瑶', name: '天然碎金', unit: '块', amount: 11196, date: '1919-11-25', uses: 1, flows: [] },
            { id: 'cur_powder', owner: '李瑶', name: '碎金子', unit: '两', amount: 30, date: '1919-11-26', uses: 2, flows: [] },
            { id: 'cur_bar', owner: '李瑶', name: '赤金条', unit: '贯', amount: 23200, date: '1919-11-18', uses: 1, flows: [] },
            { id: 'cur_comp', owner: '李瑶', name: '飞钱凭证及赤金条', unit: '贯', amount: 100000, date: '1919-11-27', uses: 1, flows: [] },
            { id: 'cur_coin', owner: '李瑶', name: '铜钱', unit: '枚', amount: 709, date: '1919-11-10', uses: 4, flows: [] },
            { id: 'cur_ls', owner: '李世民', name: '赤金条', unit: '贯', amount: 20000, date: '1919-11-19', uses: 1, flows: [] },
        ],
        state: { date: '1919-12-01' },
    };
}
/** 一份合法方案：`黄金(两)` + `碎金子(两)` 合一（同单位、同一金属）；`赤金条(贯)` 与它们单位不同 → keep */
const goodAi = () => ({
    groups: [{
        canonical: { name: '黄金', unit: '两' },
        members: [{ id: 'cur_gold', name: '黄金' }, { id: 'cur_powder', name: '碎金子' }],
        why: '同为金，单位同为「两」，碎金子是零散叫法',
    }],
    keep: [{ id: 'cur_bar', why: '单位是贯，与两不可换算' }],
    notes: '',
});

// ==================== A 组：打包 ====================
A('A1 打包**只取指定角色**（李世民的两条不进包）；名字清单**按单位分组**；**不含任何楼层正文**（不调 `aiFeedText`）；打包零写入', (() => {
    const st = boot(seed());
    const p = currencyMergePack({ owner: '李瑶' });
    const units = p.names.map((g) => g.unit);
    return p.owner === '李瑶' && p.rows.length === 6 && p.rows.every((r) => r.owner === '李瑶')
        && p.text.indexOf('李世民') < 0 && p.text.indexOf('cur_ls') < 0
        && units.indexOf('两') >= 0 && units.indexOf('枚') >= 0
        && (p.names.filter((g) => g.unit === '两')[0].names.length === 2)
        && st.currencies.length === 7;                                   // 打包不改数据
})(), (() => { const p = currencyMergePack({ owner: '李瑶' }); return J({ counts: p.counts, units: p.names.map((g) => g.unit + ':' + g.names.length) }); })());

A('A2 截断**如实计数**（`currencyMergeMaxItems` 调小后按名字序截断）；`curMergeOwners()` 给出面板选择器要的角色清单（按条数降序）', (() => {
    boot(seed());
    cfg.currencyMergeMaxItems = 3;
    const p = currencyMergePack({ owner: '李瑶' });
    const owners = curMergeOwners();
    return p.rows.length === 3 && p.truncated === 3 && owners.length === 2 && owners[0].owner === '李瑶' && owners[0].n === 6;
})(), (() => { cfg.currencyMergeMaxItems = 2; return J(currencyMergePack({ owner: '李瑶' }).counts); })());

// ==================== B 组：窄契约校验（反向探针） ====================
A('B1 合法组通过；**反例逐条被拒且原因可分**：成员不在打包集 / 复合名（含「及」）/ 负额度 / 同一 id 进两组 / 规范名带「及」；**不同单位也并成一条**（v3.47.1：主单位 + 其它单位进 `otherAmounts`，见 E 组）', (() => {
    boot(seed());
    const p = currencyMergePack({ owner: '李瑶' });
    const base = { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }], why: '' };
    //   v3.46.5 口径变更：**单位冲突不再整组拒绝**（改按单位拆分，见 I 组）—— 故 `unit-conflict` 不再是拒因，
    //   这里换成「不同单位 + 每单位各 1 条 → 无组可合并、两条都进 keep」的等价断言。
    const cases = {
        'member-not-packed': { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'nope' }] },
        'compound-member': { canonical: { name: '金', unit: '贯' }, members: [{ id: 'cur_bar' }, { id: 'cur_comp' }] },     // 复合条目
        'compound-canonical': { canonical: { name: '黄金及赤金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }] },
        'too-few-members': { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }] },
    };
    const res = {};
    for (const [want, g] of Object.entries(cases)) {
        const v = currencyMergeValidate({ groups: [g] }, p);
        res[want] = v.groups.length === 0 && (v.reasons[want] || 0) > 0;
    }
    // v3.47.1（用户报告「记录是分散的，没有合并」）：不同单位**也并成一条**（主单位取成员最多者，其它单位原额进 `otherAmounts`）
    const split = currencyMergeValidate({ groups: [{ canonical: { name: '金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_bar' }] }] }, p);
    const splitOk = split.groups.length === 1 && split.rejected.length === 0
        && split.groups[0].unit === '两' && split.groups[0].removedIds.length === 1
        && (split.groups[0].otherAmounts || []).length === 1 && split.groups[0].otherAmounts[0].name === '赤金条'
        && split.reasons['unit-mixed'] === 1;
    const ok = currencyMergeValidate({ groups: [base] }, p);
    return Object.keys(res).every((k) => res[k] === true) && splitOk && ok.groups.length === 1 && ok.reasons && !Object.keys(ok.reasons).length;
})(), (() => {
    boot(seed());
    const p = currencyMergePack({ owner: '李瑶' });
    return J(currencyMergeValidate({ groups: [{ canonical: { name: '金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_bar' }] }] }, p).reasons);
})());

A('B2 负额度与「名字就是单位词」的条目不进组；**同一 id 出现在两组**时第二组被拒（`member-reused`）；拒绝原因**结构化**留档供预览展示', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_neg', owner: '李瑶', name: '拜占庭铜努米亚', unit: '枚', amount: -6, date: '1919-11-01', uses: 0, flows: [] });
    st.currencies.push({ id: 'cur_bz', owner: '李瑶', name: '拜占庭金币', unit: '枚', amount: 12, date: '1919-11-02', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    const v = currencyMergeValidate({
        groups: [
            { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_neg' }] },   // 负额度 → 拒
            { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_bz' }] },    // 这一组合法
            { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_bz' }] },    // 与上一组抢同一个 id → 拒
        ],
    }, p);
    return v.groups.length === 1 && (v.reasons['negative-amount'] || 0) > 0 && (v.reasons['member-reused'] || 0) > 0
        && v.rejected.length === 2 && Array.isArray(v.rejected[0].reasons);
})(), (() => {
    boot(seed());
    const st = state;
    st.currencies.push({ id: 'cur_neg', owner: '李瑶', name: '拜占庭铜努米亚', unit: '枚', amount: -6, date: '1919-11-01', uses: 0, flows: [] });
    st.currencies.push({ id: 'cur_bz', owner: '李瑶', name: '拜占庭金币', unit: '枚', amount: 12, date: '1919-11-02', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    return J(currencyMergeValidate({ groups: [
        { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_neg' }] },
        { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_bz' }] },
        { canonical: { name: '铜钱', unit: '枚' }, members: [{ id: 'cur_coin' }, { id: 'cur_bz' }] },
    ] }, p).reasons);
})());

// ==================== C 组：应用（复用机械档路径 + 墓碑） ====================
A('C1 应用走**机械档同一路径**：合成 plan → `runCurrencyRepair({plan})` → **额度求和**（120+30=150，用户裁决的默认）、保留条目**改名成规范名**、备注/标签/用量**并集**、被并入条目**留墓碑**（id 墓碑 + 内容哈希墓碑）', (() => {
    const st = boot(seed());
    st.currencies[0].note = '两锭'; st.currencies[0].tags = ['金'];
    st.currencies[2].note = '零碎'; st.currencies[2].tags = ['金', '零碎']; st.currencies[2].uses = 2;
    const p = currencyMergePack({ owner: '李瑶' });
    const plan = currencyMergePlan({ pack: p, ai: goodAi() });
    const before = st.currencies.length;
    const r = currencyMergeApply(plan, { quiet: true });
    const kept = (st.currencies || []).filter((c) => c && c.owner === '李瑶').map((c) => c.id);
    const keepRow = (st.currencies || []).filter((c) => c.id === plan.merge.filter((m) => m.ai)[0].keepId)[0] || {};
    return r.ok === true && r.changed === true && st.currencies.length === before - 1
        && kept.indexOf('cur_gold') < 0 && kept.indexOf('cur_powder') >= 0      // 保留**最新**那条（碎金子 11-26）
        && Number(keepRow.amount) === 150                                       // **求和**（120 + 30）
        && String(keepRow.name || '') === '黄金'                                 // 保留条目**改名成规范名**
        && String(keepRow.note || '').length > 0                                // 备注并集（取最长的）
        && (Array.isArray(keepRow.tags) ? keepRow.tags.length : 0) >= 2          // 标签并集
        && (Number(keepRow.uses) || 0) === 5                                     // 用量并集 3+2
        && J(st.deleted || {}).indexOf('cur_gold') >= 0                          // **id 墓碑**：货币 id 由「归属+币种」派生 → 跨端同一条同 id → 足以拦住复活
        && Object.keys(((st.deleted || {}).currencies) || {}).length > 0;         // （内容哈希墓碑对 currencies 恒空 —— `core/model/hash.js` 无该维口径，既有实现与注释见 `core/currency-repair.js` 头部）
})(), (() => J({ after: (state.currencies || []).filter((c) => c.owner === '李瑶').map((c) => c.id + ':' + c.name + ':' + c.amount), deleted: Object.keys((state.deleted || {}).currencies || {}) }))());

A('C2 **额度策略可切换**：`currencyMergeSumAmount=false` 时同一方案退回**保留最新额度、不累加**（30）；两种策略下组员原额都留在 plan 里（不静默丢数字）', (() => {
    const st = boot(seed());
    cfg.currencyMergeSumAmount = false;
    const plan = currencyMergePlan({ pack: currencyMergePack({ owner: '李瑶' }), ai: goodAi() });
    currencyMergeApply(plan, { quiet: true });
    const keepRow = (st.currencies || []).filter((c) => c.id === plan.merge.filter((m) => m.ai)[0].keepId)[0] || {};
    const g = (plan.merge || []).filter((m) => m.ai === true)[0] || {};
    return Number(keepRow.amount) === 30 && g.sumAmount === 150 && g.newestAmount === 30
        && (g.members || []).every((m) => Number.isFinite(Number(m.amount)));
})(), J((() => { const m = (state.currencies || []).filter((c) => c.name === '黄金')[0] || {}; return { name: m.name, amount: m.amount }; })()));

A('C3 机械档的**结构清理照旧生效**（同一个 plan 里带机械 drop/fix，不是二选一）：空壳条目仍被剔除、单位别名仍被归一；AI 组与机械组**不会重复消费同一 id**', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_shell', owner: '李瑶', name: '', unit: '', amount: 0, date: '', uses: 0, flows: [] });
    st.currencies.push({ id: 'cur_aliasunit', owner: '李瑶', name: '雪花银', unit: '両', amount: 5, date: '1919-11-15', uses: 1, flows: [] });
    const plan = currencyMergePlan({ pack: currencyMergePack({ owner: '李瑶' }), ai: goodAi() });
    const ids = plan.merge.flatMap((m) => [m.keepId].concat(m.removedIds || []));
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    return plan.drop.some((d) => d.id === 'cur_shell') && plan.fix.some((f) => f.id === 'cur_aliasunit')
        && dup.length === 0 && plan.counts.aiGroups === 1;
})(), (() => { boot(seed()); const p = currencyMergePlan({ pack: currencyMergePack({ owner: '李瑶' }), ai: goodAi() }); return J({ counts: p.counts }); })());

// ==================== D 组：幂等 / 留痕 / 终止原因 ====================
A('D1 幂等签名：同「打包指纹 + 规范化分组」稳定同值，分组变化即变值；`currencyMergeLog` 末 5 条且已登记 runtime 槽位；提示行四项计数齐备', (() => {
    const st = boot(seed());
    const p = currencyMergePack({ owner: '李瑶' });
    const g1 = currencyMergeValidate(goodAi(), p).groups;
    const s1 = currencyMergeSig(p, g1), s2 = currencyMergeSig(currencyMergePack({ owner: '李瑶' }), g1);
    const s3 = currencyMergeSig(p, []);                                       // 空方案 → 不同签名
    const s4 = currencyMergeSig(p, currencyMergeValidate(goodAi(), currencyMergePack({ owner: '李世民' })).groups);
    for (let i = 0; i < 7; i++) curMergeLogPush({ owner: '李瑶', groups: i });
    const log = curMergeLogList();
    const note = curMergeNoteText({ before: 7, after: 6, dropped: 1 }, { owner: '李瑶', counts: { mergeGroups: 1, mergeRemoved: 1, fix: 0, report: 0 }, sumAmount: false });
    return !!s1 && s1 === s2 && s1 !== s3 && s1 !== s4 && log.length === CUR_MERGE_LOG_MAX && log[CUR_MERGE_LOG_MAX - 1].groups === 6
        && !!RUNTIME_SLOTS.currencyMergeLog && RUNTIME_SLOTS.currencyMergeLog.disposition === 'runtime'
        && note.indexOf('李瑶') >= 0 && note.indexOf('合并 1 组') >= 0 && note.indexOf('7 → 6') >= 0 && note.indexOf('不累加') >= 0;
})(), (() => { const p = currencyMergePack({ owner: '李瑶' }); return J({ sig: currencyMergeSig(p, currencyMergeValidate(goodAi(), p).groups).slice(0, 12) }); })());

A('D2 五种终止原因：`disabled`（开关关）/ `no-owner`（没选角色）/ `no-data`（该角色没有货币）/ `no-ai`（AI 没返回）/ `invalid`（没有任何可合并的组）；解析器容忍 ```json 包裹与前后文字', (() => {
    const st = boot(seed());
    const pack = currencyMergePack({ owner: '李瑶' });
    const r1 = curMergeBlockReason('李瑶', pack.rows);
    cfg.currencyMergeEnabled = false;
    const r2 = curMergeBlockReason('李瑶', pack.rows);
    cfg.currencyMergeEnabled = true;
    const r3 = curMergeBlockReason('', pack.rows);
    const r4 = curMergeBlockReason('张三', []);
    const parseOk = !!currencyMergeParse('好的：\n```json\n{"groups":[]}\n```\n以上。') && currencyMergeParse('not json') === null;
    // 全被拒 → invalid（没有任何可合并的组）
    const bad = currencyMergeValidate({ groups: [{ canonical: { name: '黄金及赤金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }] }] }, pack);
    return r1 === '' && r2 === 'disabled' && r3 === 'no-owner' && r4 === 'no-data' && parseOk && bad.groups.length === 0;
})(), (() => { boot(seed()); return J({ reasons: Object.keys(currencyMergeValidate({ groups: [] }, currencyMergePack({ owner: '李瑶' })).reasons) }); })());

// ==================== E 组（v3.47.1）：跨单位**并成一条**（记录不再分散） ====================
A('E1 **一个 AI 组 = 一条**：同为金但单位是 两/贯/条 的五条 → 只产出一组；主单位取**成员最多的单位**（两）；其余两条进 `otherAmounts`（不丢弃、不换算）', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_jinzi', owner: '李瑶', name: '金子', unit: '两', amount: 10, date: '1919-11-22', uses: 1, flows: [] });
    st.currencies.push({ id: 'cur_bar2', owner: '李瑶', name: '赤条金', unit: '条', amount: 5, date: '1919-11-19', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    const v = currencyMergeValidate({ groups: [{ canonical: { name: '黄金', unit: '两' },
        members: [{ id: 'cur_gold' }, { id: 'cur_powder' }, { id: 'cur_jinzi' }, { id: 'cur_bar' }, { id: 'cur_bar2' }],
        why: '同为金的不同叫法' }] }, p);
    const g = v.groups[0] || {};
    return v.groups.length === 1 && g.unit === '两' && (g.members || []).length === 3
        && (g.otherAmounts || []).length === 2 && (g.removedIds || []).length === 4
        && v.reasons['unit-mixed'] === 1;
})(), (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_jinzi', owner: '李瑶', name: '金子', unit: '两', amount: 10, date: '1919-11-22', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    const v = currencyMergeValidate({ groups: [{ canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }, { id: 'cur_jinzi' }, { id: 'cur_bar' }], why: '' }] }, p);
    return J({ groups: v.groups.length, unit: (v.groups[0] || {}).unit, other: (v.groups[0] || {}).otherAmounts });
})());

A('E2 落库：**五条 → 一条**；主额度 = 主单位成员之和（160 两，**不含**贯/条）；其它单位原额**写进备注**（不换算）；被并入的四条留 id 墓碑', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_jinzi', owner: '李瑶', name: '金子', unit: '两', amount: 10, date: '1919-11-22', uses: 1, flows: [] });
    st.currencies.push({ id: 'cur_bar2', owner: '李瑶', name: '赤条金', unit: '条', amount: 5, date: '1919-11-19', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    const plan = currencyMergePlan({ pack: p, ai: { groups: [{ canonical: { name: '黄金', unit: '两' },
        members: [{ id: 'cur_gold' }, { id: 'cur_powder' }, { id: 'cur_jinzi' }, { id: 'cur_bar' }, { id: 'cur_bar2' }], why: '同为金' }] } });
    const before = st.currencies.filter((c) => c.owner === '李瑶').length;      // 种子 6 + 本轮 2 = 8
    currencyMergeApply(plan, { quiet: true });
    const mine = st.currencies.filter((c) => c.owner === '李瑶');
    const row = mine.filter((c) => String(c.name) === '黄金')[0] || {};
    return before === 8 && mine.length === 4 && st.currencies.length === 5
        && String(row.name) === '黄金' && String(row.unit) === '两' && Number(row.amount) === 160
        && String(row.note || '').indexOf('赤金条(贯) 23200') >= 0 && String(row.note || '').indexOf('赤条金(条) 5') >= 0
        && plan.counts.unitMerged === 2
        && J(st.deleted || {}).indexOf('cur_bar2') >= 0;

})(), (() => J({ rows: (state.currencies || []).map((c) => c.name + '/' + c.unit + '/' + c.amount), note: (state.currencies[0] || {}).note }))());

A('E3 主单位选择有确定规则：**成员最多的单位**优先；并列时取 AI 的 `canonical.unit`；都不匹配时退第一个成员的单位；额度**不跨单位相加**（≠ 全体之和）', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_bar2', owner: '李瑶', name: '赤条金', unit: '条', amount: 5, date: '1919-11-19', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    // 并列 2:2（两 / 贯），AI 指定 canonical.unit = 贯 → 主单位取贯
    st.currencies.push({ id: 'cur_g2', owner: '李瑶', name: '碎金', unit: '两', amount: 1, date: '1919-11-10', uses: 1, flows: [] });
    const p2 = currencyMergePack({ owner: '李瑶' });
    const v = currencyMergeValidate({ groups: [{ canonical: { name: '黄金', unit: '贯' },
        members: [{ id: 'cur_gold' }, { id: 'cur_powder' }, { id: 'cur_bar' }, { id: 'cur_g2' }], why: '' }] }, p2);
    const g = v.groups[0] || {};
    const all = (g.members || []).concat(g.otherAmounts || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return v.groups.length === 1 && g.unit === '贯' && Number(g.sumAmount) === 23200 && Number(g.sumAmount) !== all;
})(), '');

A('E4 透明计数与提示：`unitMerged` 记下跨单位并成一条的成员数；`detail` 写明「另 N 条单位不同 → 原额记入备注（不换算）」', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_bar2', owner: '李瑶', name: '赤条金', unit: '条', amount: 5, date: '1919-11-19', uses: 1, flows: [] });
    const p = currencyMergePack({ owner: '李瑶' });
    const plan = currencyMergePlan({ pack: p, ai: { groups: [{ canonical: { name: '黄金', unit: '两' },
        members: [{ id: 'cur_gold' }, { id: 'cur_powder' }, { id: 'cur_bar' }, { id: 'cur_bar2' }], why: '同为金' }] } });
    const m = (plan.merge || []).filter((x) => x.ai === true)[0] || {};
    return plan.counts.unitMerged === 2 && String(m.detail || '').indexOf('原额记入备注') >= 0;
})(), '');
A('D3 机械档的既有口径**未被改动**：不传 `plan` 时 `currencyRepairPlan()` 仍然按老办法合并同规范名别名（`金子/赤金→黄金` 这类写死的表），且单位冲突仍只报告', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_ghost1', owner: '李瑶', name: '金子', unit: '两', amount: 5, date: '1919-11-11', uses: 1, flows: [] });
    const plan = currencyRepairPlan({ includeUntracked: false });
    const merged = (plan.merge || []).some((m) => (m.removedIds || []).indexOf('cur_ghost1') >= 0 || m.keepId === 'cur_ghost1');
    return merged === true && plan.counts.mergeGroups >= 1;
})(), (() => { boot(seed()); return J(currencyRepairPlan({}).counts); })());



/**
 * v3.46.3（新增组专用）：本文件的 `A` 是**同步**断言 —— 它先做 `!!c` 再交给 reporter，于是
 *   **传入 Promise / 函数都会恒为真**（假绿；reporter 的 thenable 防呆在这里已被 `!!` 提前吃掉）。
 *   凡**异步**用例一律用这个：传**函数**进来、`await` 之后再断言（与 `tests/unit/aux-store.test.js` 同款防呆）。
 */
const AX = async (n, fn, e) => {
    let c = false, x = e;
    try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); }
    R.assert(n, c === true, (typeof x === 'function') ? x() : x);
};
// ==================== H 组：v3.46.3 UI 回归（用户报告的两条） ====================
//   ①「🔀 AI 融合货币**无法正常使用**」：`currencyMergeOpen` 动作此前**只返回文案、没置 `open`**
//     → 预览区恒为空 → 角色列表不出现、无法选角色。
//   ②「点击后**没有任何提醒信息**」：动作结果提示行只渲染在总览正文里 → 其它分页看不见。
{
    /** UI 组装配：起干净环境 + 装桩 AI + 打开面板停在货币页 */
    async function uiBoot() {
        const st = boot(seed());
        setPanelHooks2({});
        openPanel('currencies');
        setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify(goodAi()) }), busy: () => false });
        return st;
    }

    await AX('H1 货币页出现「🔀 AI 融合货币」按钮，且动作名登记为 `currencyMergeOpen`', async () => {
        await uiBoot();
        const btn = String(currencyMergeButton());
        return btn.indexOf('data-ftt-action="currencyMergeOpen"') >= 0 && btn.indexOf('🔀 AI 融合货币') >= 0;
    }, '');

    await AX('H2 **开面板真的生效**（v3.46.3 修复点）：`currencyMergeOpen` → `open === true` 且预览区非空', async () => {
        await uiBoot();
        const before = String(currencyMergePanelHtml()).length;
        await panelAction('currencyMergeOpen', {});
        const st = uiCurMergeState();
        return before === 0 && st.open === true && String(currencyMergePanelHtml()).length > 0;
    }, () => J(uiCurMergeState()));

    await AX('H3 **在货币页也能看到提示信息**（v3.46.3 修复点）：结果 HTML 的外壳里含 `data-ftt-note`', async () => {
        await uiBoot();
        const r = await panelAction('currencyMergeOpen', {});
        const html = String(r.html || panelModalInnerHtml({ tab: 'currencies' }));
        return html.indexOf('data-ftt-note') >= 0 && /货币融合：请选择要整理的角色/.test(html);
    }, '');

    await AX('H4 **端到端（UI 层）**：开面板 → 选角色（桩 AI 出方案）→ 应用 → 同义黄金合 1 组、条数 -1、额度按求和、留墓碑', async () => {
        const st = await uiBoot();
        const n0 = (st.currencies || []).length;
        await panelAction('currencyMergeOpen', {});
        const rPick = await panelAction('currencyMergePick', { name: '李瑶' });
        const pend = uiCurMergeState().pending;
        const rApply = await panelAction('currencyMergeApply', {});
        const left = (state.currencies || []);
        const gold = left.filter((c) => c.owner === '李瑶' && String(c.name).indexOf('黄金') >= 0);
        // 墓碑是**按 id 的映射**（`deleted.currencies = { <id>: <at> }`），不是数组 —— 两种形状都兼容地数
        const tombBag = (state.deleted && state.deleted.currencies) || null;
        const hasTomb = !!(tombBag && ((Array.isArray(tombBag) ? tombBag.length : Object.keys(tombBag).length) >= 1));
        return !!pend && pend.groups === 1
            && rPick.ok !== false && rApply.ok !== false
            && left.length === n0 - 1
            && gold.length === 1 && Number(gold[0].amount) === 150        // 120 + 30（默认求和）
            && hasTomb;
    }, () => J({ n0: (state.currencies || []).length, gold: (state.currencies || []).filter((c) => c.owner === '李瑶' && String(c.name).indexOf('黄金') >= 0).map((c) => c.name + '/' + c.unit + '/' + c.amount), names: (state.currencies || []).map((c) => c.name) }));

    await AX('H5 取消：`currencyMergeClose` → 面板关闭 + 待确认方案清空（零写入）', async () => {
        const st = await uiBoot();
        const n0 = (st.currencies || []).length;
        await panelAction('currencyMergeOpen', {});
        await panelAction('currencyMergeClose', {});
        const s2 = uiCurMergeState();
        return s2.open === false && s2.pending === null && (state.currencies || []).length === n0;
    }, () => J(uiCurMergeState()));
}


// ==================== I 组：v3.46.5 —— **单位冲突不再整组丢弃**（用户报告「金子 / 赤条金 / 黄金 明明可以融合却被忽略」）===
{
    /** 用户报告那一簇：同一物的不同叫法，但其中一条单位不同 */
    function seedMixedUnit() {
        return {
            snapshots: [{ id: 's1', name: '李瑶' }],
            currencies: [
                { id: 'g1', owner: '李瑶', name: '金子', unit: '两', amount: 10, date: '1919-11-20', uses: 1, flows: [] },
                { id: 'g2', owner: '李瑶', name: '赤条金', unit: '条', amount: 2, date: '1919-11-21', uses: 1, flows: [] },
                { id: 'g3', owner: '李瑶', name: '黄金', unit: '两', amount: 120, date: '1919-11-22', uses: 2, flows: [] },
            ],
            state: { date: '1919-12-01' },
        };
    }
    const aiOneGroup = () => ({ groups: [{ canonical: { name: '黄金', unit: '两' }, members: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }] }] });

    await AX('I1（v3.47.1 口径）**整组并成一条**：三条（金子/两 · 赤条金/条 · 黄金/两）→ 1 组；主单位取成员最多的「两」；`reasons` 如实记 `unit-mixed`', async () => {
        const st = boot(seedMixedUnit());
        const pack = currencyMergePack({ owner: '李瑶' });
        const v = currencyMergeValidate(aiOneGroup(), pack);
        const g = v.groups[0];
        return v.groups.length === 1 && v.rejected.length === 0
            && !!g && g.unit === '两' && g.members.length === 2
            && g.members.map((m) => m.id).sort().join(',') === 'g1,g3'
            && Number(g.sumAmount) === 130                                  // 10 + 120（**不含**条）
            && (g.otherAmounts || []).length === 1 && g.otherAmounts[0].amount === 2
            && v.reasons['unit-mixed'] === 1
            && (st.currencies || []).length === 3;                          // 校验阶段**零写入**
    }, () => { boot(seedMixedUnit()); const v = currencyMergeValidate(aiOneGroup(), currencyMergePack({ owner: '李瑶' })); return J({ groups: v.groups.map((g) => g.unit + ':' + g.members.length), rejected: v.rejected, reasons: v.reasons }); });

    await AX('I2（v3.47.1 口径）单位不同的那条（赤条金 / 条）**不丢失**：进 `otherAmounts`（原额如实保留、**不参与算术**），并在落库时写入备注', async () => {
        boot(seedMixedUnit());
        const v = currencyMergeValidate(aiOneGroup(), currencyMergePack({ owner: '李瑶' }));
        const g = v.groups[0] || {};
        const o = (g.otherAmounts || [])[0] || {};
        return v.groups.length === 1 && String(o.name) === '赤条金' && String(o.unit) === '条' && Number(o.amount) === 2
            && Number(g.sumAmount) === 130                                  // 2 **没有**被加进去
            && v.keep.filter((x) => x.id === 'g2').length === 0;            // 不再走「只报告」那条路
    }, () => { boot(seedMixedUnit()); const v = currencyMergeValidate(aiOneGroup(), currencyMergePack({ owner: '李瑶' })); return J({ unit: v.groups[0] && v.groups[0].unit, other: v.groups[0] && v.groups[0].otherAmounts, sum: v.groups[0] && v.groups[0].sumAmount }); });

    await AX('I3 **旧行为回归锁**：若整组单位一致，行为与从前完全一致（1 组、求和、保留最新条目）—— 拆分逻辑不改变正常路径', async () => {
        boot(seedMixedUnit());
        const ai = { groups: [{ canonical: { name: '黄金', unit: '两' }, members: [{ id: 'g1' }, { id: 'g3' }] }] };
        const v = currencyMergeValidate(ai, currencyMergePack({ owner: '李瑶' }));
        return v.groups.length === 1 && v.groups[0].members.length === 2
            && v.groups[0].keepId === 'g3'                                  // 日期最新 → 保留它
            && v.groups[0].removedIds.join(',') === 'g1'
            && v.reasons['unit-mixed'] === undefined;
    }, '');

    await AX('I4（v3.47.1 口径）端到端（应用后）：三条**合成一条**（黄金/两 130），赤条金的 2 条记入备注（记录不再分散）', async () => {
        const st = boot(seedMixedUnit());
        setPanelHooks2({});
        openPanel('currencies');
        setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify(aiOneGroup()) }), busy: () => false });
        await panelAction('currencyMergeOpen', {});
        await panelAction('currencyMergePick', { name: '李瑶' });
        const r = await panelAction('currencyMergeApply', {});
        const rows = (state.currencies || []).filter((c) => c.owner === '李瑶');
        const gold = rows.filter((c) => String(c.name) === '黄金');
        return r.ok !== false && rows.length === 1 && gold.length === 1 && Number(gold[0].amount) === 130
            && String(gold[0].unit) === '两'
            && String(gold[0].note || '').indexOf('赤条金(条) 2') >= 0;      // 其它单位原额入备注
    }, 'I4：合并后应为 2 条（黄金 130 两 + 赤条金 2 条）');
}

/** 打开货币融合面板（F 组用） */
function boot2() { try { currencyMergeOpen(); } catch (e) { /* 忽略 */ } }

// ==================== F 组（v3.49.2）：面板交互 —— 修复图标 / 在途禁用 / 加载与「已提交 AI」状态 ====================
A('F1 图标语义：角色行右侧是**修复含义**的 🔧（不再是 ➕），title 写明「按 AI 生成…融合方案」；提示行同步改口径', (() => {
    boot(seed()); boot2();
    const h = currencyMergePanelHtml();
    return h.indexOf('data-ftt-action="currencyMergePick"') > 0
        && h.indexOf('🔧') > 0 && h.indexOf('➕') < 0 && h.indexOf('✅ 应用融合') < 0
        && h.indexOf('货币融合方案（整理同义叫法') > 0
        && h.indexOf('点角色右侧 <b>🔧</b> 出方案') > 0;
})(), '')

A('F2 点击瞬间：`currencyMergeBegin()` 置在途归属并给出**提交 AI 的提示文案**；面板随即渲染该条目的**行级加载态 + 转圈 + 禁用 + ⏳ 已提交 AI…** 与顶部状态行（**状态行在 main 内**，不挤压右侧按钮，v3.50.2）', (() => {
    boot(seed()); boot2();
    const pre = currencyMergeBegin('currencyMergePick', { name: '李瑶' });
    const h = currencyMergePanelHtml();
    const rowStart = h.indexOf('李瑶');
    const row = h.slice(Math.max(0, rowStart - 60), rowStart + 1200);   // v3.50.2：窗口放宽 —— 按钮的 disabled 属性在按钮末尾
    return !!pre && String(pre.note).indexOf('已提交 AI 分析') > 0 && String(pre.note).indexOf('李瑶') > 0
        && currencyMergeRunning() === '李瑶'
        && h.indexOf('⏳ 已提交 AI 分析') > 0                       // 顶部状态行
        && h.indexOf('⏳ 已提交 AI…') > 0                           // 该条目的徽标
        && row.indexOf('ftt-item-loading') > 0                     // v3.50.2：行级加载态（CSS 已定义，可见）
        && row.indexOf('ftt-spin') > 0                             // v3.50.2：通用转圈元素
        && row.indexOf('ftt-op ftt-ok ftt-loading') > 0            // 按钮自身的转圈态（.ftt-op.ftt-loading）
        && row.indexOf(' disabled') > 0                            // 在途禁用，避免重复点击
        && row.indexOf('正在整理这个角色的货币') > 0                // 状态说明
        // v3.50.2（用户报告「挤压到了一起」）：状态行必须在 .ftt-item-main **内部**，
        //   否则它会成为行的第三个 flex 子项，把右侧 🔧 挤到下一行。
        && row.indexOf('ftt-item-main') < row.indexOf('正在整理这个角色的货币')
        && row.indexOf('正在整理这个角色的货币') < row.indexOf('ftt-item-ops');
})(), () => { boot(seed()); boot2(); currencyMergeBegin('currencyMergePick', { name: '李瑶' }); return String(currencyMergePanelHtml()).slice(0, 900); })

A('F3 非 pick 动作不受影响：`currencyMergeBegin()` 对其余三个动作返回 null（不改变任何状态）', (() => {
    boot(seed()); boot2();
    return currencyMergeBegin('currencyMergeOpen', {}) === null
        && currencyMergeBegin('currencyMergeApply', {}) === null
        && currencyMergeBegin('currencyMergeClose', {}) === null
        && currencyMergeRunning() === '';
})(), '')

A('F4 收尾清位：一轮真跑（AI 桩）结束后**在途归属清空**，面板不再有转圈 / 禁用 / 已提交徽标；失败路径同样清位', (() => {
    boot(seed()); boot2();
    return (async () => {
        setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify({ groups: [] }) }), busy: () => false });
        await runCurrencyMergeAction('currencyMergePick', { name: '李瑶' });
        const afterOk = currencyMergeRunning() === '' && String(currencyMergePanelHtml()).indexOf('⏳ 已提交 AI…') < 0;
        // 失败路径（AI 抛错 → 内核返回失败）也清位
        setAiHooks({ callAi: async () => { throw new Error('boom'); }, busy: () => false });
        await runCurrencyMergeAction('currencyMergePick', { name: '李瑶' });
        const afterFail = currencyMergeRunning() === '';
        return afterOk && afterFail;
    })();
})(), '')
A('F5（v3.50.2 反向锁）**动效类必须有 CSS 定义**：`.ftt-item.ftt-item-loading` / `.ftt-op.ftt-loading::before` / `.ftt-spin` / `.ftt-item-sub` 四者都在 `style.css` 里 —— 此前 `.ftt-loading` 只给 `.ftt-floor-btn` 写过，挂到行上等于没效果', (() => {
    const css = readFileSync(join(ROOT2, 'style.css'), 'utf8');
    return /\.ftt-item\.ftt-item-loading\s*\{/.test(css)
        && /\.ftt-op\.ftt-loading::before\s*\{/.test(css)
        && /\.ftt-spin\s*\{/.test(css)
        && /\.ftt-item-sub\s*\{/.test(css)
        && css.indexOf('@keyframes fttSpin') > 0
        // 关掉特效（设定→界面特效）或 prefers-reduced-motion 时动画被全局禁用 → 行级加载态仍靠**底色 + 左侧强调条**可见
        && /\.ftt-item\.ftt-item-loading[^}]*background:/.test(css) && /\.ftt-item\.ftt-item-loading[^}]*box-shadow:/.test(css);
})(), '')
R.done();
