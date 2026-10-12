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
A('B1 合法组通过；**反例逐条被拒且原因可分**：成员不在打包集 / 单位冲突（禁凭空换算）/ 复合名（含「及」）/ 负额度 / 同一 id 进两组 / 规范名带「及」', (() => {
    boot(seed());
    const p = currencyMergePack({ owner: '李瑶' });
    const base = { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }], why: '' };
    const cases = {
        'member-not-packed': { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'nope' }] },
        'unit-conflict': { canonical: { name: '金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_bar' }] },        // 两 vs 贯
        'compound-member': { canonical: { name: '金', unit: '贯' }, members: [{ id: 'cur_bar' }, { id: 'cur_comp' }] },     // 复合条目
        'compound-canonical': { canonical: { name: '黄金及赤金', unit: '两' }, members: [{ id: 'cur_gold' }, { id: 'cur_powder' }] },
        'too-few-members': { canonical: { name: '黄金', unit: '两' }, members: [{ id: 'cur_gold' }] },
    };
    const res = {};
    for (const [want, g] of Object.entries(cases)) {
        const v = currencyMergeValidate({ groups: [g] }, p);
        res[want] = v.groups.length === 0 && (v.reasons[want] || 0) > 0;
    }
    const ok = currencyMergeValidate({ groups: [base] }, p);
    return Object.keys(res).every((k) => res[k] === true) && ok.groups.length === 1 && ok.reasons && !Object.keys(ok.reasons).length;
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

A('D3 机械档的既有口径**未被改动**：不传 `plan` 时 `currencyRepairPlan()` 仍然按老办法合并同规范名别名（`金子/赤金→黄金` 这类写死的表），且单位冲突仍只报告', (() => {
    const st = boot(seed());
    st.currencies.push({ id: 'cur_ghost1', owner: '李瑶', name: '金子', unit: '两', amount: 5, date: '1919-11-11', uses: 1, flows: [] });
    const plan = currencyRepairPlan({ includeUntracked: false });
    const merged = (plan.merge || []).some((m) => (m.removedIds || []).indexOf('cur_ghost1') >= 0 || m.keepId === 'cur_ghost1');
    return merged === true && plan.counts.mergeGroups >= 1;
})(), (() => { boot(seed()); return J(currencyRepairPlan({}).counts); })());

R.done();
