// ============================================================
// 单元测试 · v3.15.0「货币修正」（货币页「🧹 修正货币」）
// 用户要求（原话）：「货币增加修正按钮，剔除不应该被记录的角色，以及修正错乱的单位计价和冗余的数据合并问题。」
//
// 口径（`core/currency-repair.js`）：纯机械、零 AI、确定性、**先出计划后应用**：
//   ① 剔除：`ghost-owner`（归属不在名册）/ `untracked-owner`（未标定，需显式勾选且主角身份已确证）/
//      `name-is-unit`（币种名写成单位词）/ `empty`（空壳）/ `merged`（被合并并入）
//   ② 计价修正：`unit-alias`（单位写法归一）+ `amount-from-history`（额度缺省 → 流水净额补齐，只补 0）
//   ③ 冗余合并：同归属 + 同规范币种名（别名表）+ 单位相容 → 合一（**保留最新额度、不累加**）
//   · 只报告不改：`unit-conflict` / `unit-nonstandard` / `owner-untracked` / `amount-mismatch`
//   · 剔除与合并**留删除墓碑**（id + 内容哈希）→ 跨端不复活；只减不增；幂等
// 运行：node tests/unit/currency-repair.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { currencyRepairPlan, runCurrencyRepair, canonicalUnit, canonicalName, currencyOwnerRoster } from '../../core/currency-repair.js';
import { panelBodyHtml, panelAction, openPanel, currencyRepairState } from '../../ui/panel.js';

const R = makeReporter('currency-repair v3.15.0 货币修正（剔除 / 计价 / 合并）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 名册：角色档案（甲角色）+ 名册（丙角色）+ 状态记录主体（乙角色）；主角 = 甲角色 */
const ROSTER = {
    snapshots: [{ id: 's1', name: '甲角色', tags: [] }],
    npcs: [{ id: 'n1', name: '丙角色' }],
    currentStates: [{ id: 'st1', subject: '乙角色·体力', value: '好' }],
    protagonist: { name: '甲角色' },
};
/** 未确证主角（无 protagonist / 无主角标签）→ defaultCurrencyOwner() 回落字面「主角」 */
const ROSTER_NO_ME = {
    snapshots: [{ id: 's1', name: '甲角色', tags: [] }, { id: 's2', name: '乙角色', tags: [] }],
    npcs: [], currentStates: [],
};

function boot(currencies, extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:currencyrepair');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文。' }] }), doc);
    setLastMessageId(0);
    // 注意：`extra` **整体替代**名册（不合并）—— 否则「未确证主角」这类用例会被默认名册里的 protagonist 覆盖
    const roster = extra === undefined ? ROSTER : extra;
    setKernelState(Object.assign(emptyState(), roster, { currencies: JSON.parse(JSON.stringify(currencies || [])) }));
    return state;
}
/** 一条货币（默认归属于主角「甲角色」） */
const cur = (o) => Object.assign({
    id: 'c1', owner: '甲角色', name: '银元', unit: '枚', amount: 10, note: '', date: '628-03-24',
    uses: 0, floorStart: 0, floorEnd: 0, history: [], tags: [],
}, o || {});

// ==================== A 组：计划（只读） ====================
A('A1 归属判定：不在名册的归属 → `ghost-owner` 剔除；在名册（含状态记录主体 / 名册 / 角色档案）的一律不动', (() => {
    boot([
        cur({ id: 'c-ghost', owner: '路人甲', name: '银元', unit: '枚', amount: 5 }),
        cur({ id: 'c-me', owner: '甲角色', name: '银元', unit: '枚', amount: 5 }),          // 主角（档案）
        cur({ id: 'c-sub', owner: '乙角色', name: '银元', unit: '枚', amount: 5 }),          // 状态主体（「乙角色·体力」前缀匹配）
        cur({ id: 'c-npc', owner: '丙角色', name: '银元', unit: '枚', amount: 5 }),          // 名册
    ]);
    const p = currencyRepairPlan();
    const dropIds = p.drop.map((d) => d.id);
    // 名册 = 甲角色（档案）+ 丙角色（名册）+ 乙角色·体力 与去后缀的 乙角色（状态主体）= 4 名
    return p.roster.length === 4 && !!(p.drop.filter((d) => d.id === 'c-ghost' && d.reason === 'ghost-owner')[0])
        && dropIds.indexOf('c-me') < 0 && dropIds.indexOf('c-sub') < 0 && dropIds.indexOf('c-npc') < 0
        && currencyOwnerRoster().length === 4;
})(), () => ({ roster: currencyOwnerRoster(), drop: currencyRepairPlan().drop }));

A('A2 币种名写成单位词（且未写单位）→ `name-is-unit` 剔除；而「银元 / 人民币」这类合法币种名不受影响', (() => {
    boot([
        cur({ id: 'c-bad', name: '贯', unit: '', amount: -1000, history: [{ date: '1', delta: -1000, note: 'x' }] }),
        cur({ id: 'c-ok1', name: '银元', unit: '枚', amount: 5 }),
        cur({ id: 'c-ok2', name: '人民币', unit: '人民币', amount: 5 }),
    ]);
    const p = currencyRepairPlan();
    const dropIds = p.drop.map((d) => d.id);
    return J(dropIds) === J(['c-bad']) && p.drop[0].reason === 'name-is-unit';
})(), () => currencyRepairPlan().drop);

A('A3 空壳条目（无额度 / 单位 / 备注 / 流水）→ `empty` 剔除；有单位或流水的一律不算空壳', (() => {
    boot([
        cur({ id: 'c-empty', name: '空壳币', unit: '', amount: 0, note: '', history: [] }),
        cur({ id: 'c-unit', name: '有单位', unit: '枚', amount: 0, note: '', history: [] }),
        cur({ id: 'c-flow', name: '有流水', unit: '', amount: 0, note: '', history: [{ date: '1', delta: 5, note: '' }] }),
    ]);
    const p = currencyRepairPlan();
    const dropIds = p.drop.map((d) => d.id);
    return J(dropIds) === J(['c-empty']) && p.drop[0].reason === 'empty';
})(), () => currencyRepairPlan().drop);

A('A4 计价单位归一：别名与全角写法 → 规范写法（银圆/大洋→银元 · 缗→贯 · 銀兩→两 · ＵＳＤ→美元）', (() => {
    boot([
        cur({ id: 'u1', name: '银元', unit: '银圆', amount: 5 }),
        cur({ id: 'u2', name: '铜钱', unit: '缗', amount: 5 }),
        cur({ id: 'u3', name: '白银', unit: '銀兩', amount: 5 }),
        cur({ id: 'u4', name: '美金', unit: 'ＵＳＤ', amount: 5 }),
    ]);
    const p = currencyRepairPlan();
    const got = p.fix.filter((f) => f.field === 'unit').map((f) => f.from + '→' + f.to);
    return p.fix.length === 4 && got.indexOf('银圆→银元') >= 0 && got.indexOf('缗→贯') >= 0
        && got.indexOf('銀兩→两') >= 0 && got.indexOf('ＵＳＤ→美元') >= 0
        && p.counts.drop === 0 && p.counts.mergeGroups === 0;
})(), () => currencyRepairPlan().fix);

A('A5 额度缺省补齐：`amount=0` 且流水有净额 → 用净额补齐（**只补 0**，非零额度绝不动）', (() => {
    boot([
        cur({ id: 'a-zero', name: '开元通宝', unit: '贯', amount: 0, history: [{ date: '1', delta: -300, note: '支出' }] }),
        cur({ id: 'a-some', name: '碎银', unit: '两', amount: 50, history: [{ date: '1', delta: 20, note: '进账' }] }),
    ]);
    const p = currencyRepairPlan();
    const zero = p.fix.filter((f) => f.id === 'a-zero' && f.field === 'amount')[0];
    const some = p.fix.filter((f) => f.id === 'a-some' && f.field === 'amount')[0];
    return !!zero && zero.to === -300 && zero.reason === 'amount-from-history' && !some;
})(), () => currencyRepairPlan().fix);

A('A6 只报告不改：单位冲突（同归属同币种多种单位）/ 非标准单位 / 额度与流水符号矛盾', (() => {
    boot([
        // 同归属 + 同规范币种名（开元通宝）但单位不同 → 报 unit-conflict，且**不合并**
        cur({ id: 'k1', name: '开元通宝', unit: '枚', amount: -16, history: [{ date: '1', delta: 1575, note: 'x' }] }),
        cur({ id: 'k2', name: '开元通宝', unit: '贯', amount: 200, history: [] }),
        // 非标准单位
        cur({ id: 'k3', name: '碎银', unit: '粒', amount: 5 }),
        cur({ id: 'k4', name: '天然碎金', unit: '块', amount: 5 }),
    ]);
    const p = currencyRepairPlan();
    const reasons = p.report.map((r) => r.reason + '@' + r.id).sort();
    return p.merge.length === 0
        && p.counts.report === 5                                          // 单位冲突 ×2 + 非标准单位 ×2 + 额度符号矛盾 ×1
        && reasons.indexOf('unit-conflict@k1') >= 0 && reasons.indexOf('unit-conflict@k2') >= 0
        && reasons.indexOf('unit-nonstandard@k3') >= 0 && reasons.indexOf('unit-nonstandard@k4') >= 0
        && reasons.indexOf('amount-mismatch@k1') >= 0
        && p.counts.drop === 0 && p.counts.fix === 0;
})(), () => currencyRepairPlan());

A('A7 单位冲突时**绝不相加**：不同单位的两条同币种条目都原样保留（金额与 id 不变）', (() => {
    boot([
        cur({ id: 'k1', name: '开元通宝', unit: '枚', amount: -16 }),
        cur({ id: 'k2', name: '开元通宝', unit: '贯', amount: 200 }),
    ]);
    const before = J(state.currencies);
    const r = runCurrencyRepair({ quiet: true });
    return r.changed === false && J(state.currencies) === before && r.before === 2 && r.after === 2;
})(), () => ({ changed: runCurrencyRepair({ dryRun: true, quiet: true }).changed, plan: currencyRepairPlan().counts }));

// ==================== B 组：冗余合并 ====================
const MERGE_FIXTURE = () => ([
    cur({ id: 'g1', name: '金子', unit: '两', amount: 20, date: '628-03-20', uses: 3, tags: ['甲'], history: [{ date: '628-03-20', delta: 20, note: '得金' }], floorStart: 10, floorEnd: 12 }),
    cur({ id: 'g2', name: '赤金', unit: '两', amount: 10, date: '628-03-24', uses: 5, tags: ['乙'], note: '较长的备注说明', history: [{ date: '628-03-24', delta: 10, note: '再得金' }], floorStart: 20, floorEnd: 22 }),
    cur({ id: 'g3', name: '黄金', unit: '两', amount: 0, date: '628-03-22', uses: 1, tags: ['甲'], history: [], floorStart: 15, floorEnd: 16 }),
]);

A('B1 冗余合并（别名 + 同单位）：金子/赤金/黄金 → 1 组；**保留最新一条**（id 与额度不累加）、uses 累加、标签并集、备注取最长、楼层取并集', (() => {
    boot(MERGE_FIXTURE());
    const p = currencyRepairPlan();
    const m = p.merge[0] || {};
    return p.counts.mergeGroups === 1 && p.counts.mergeRemoved === 2
        && m.canonical === '黄金' && m.keepId === 'g2' && m.amount === 10        // 最新是 g2（amount 10）→ 不累加成 30
        && m.uses === 9 && m.unit === '两'
        && J(m.removedIds.sort()) === J(['g1', 'g3'])
        && canonicalName('赤金') === '黄金' && canonicalName('金子') === '黄金';
})(), () => currencyRepairPlan().merge);

A('B2 合并只减不增、且留删除墓碑：应用后条目数 = 原数 − 剔除数；被并入条目写入 id 墓碑', (() => {
    boot(MERGE_FIXTURE());
    const before = state.currencies.length;
    const r = runCurrencyRepair({ quiet: true });
    const kept = state.currencies;
    const tombs = Object.keys((state.deleted || {}).currencies || {});
    return r.changed === true && r.before === before && before === 3 && r.after === 1 && kept.length === 1
        && kept[0].id === 'g2' && kept[0].amount === 10 && kept[0].uses === 9
        && kept[0].floorStart === 10 && kept[0].floorEnd === 22
        && kept[0].history.length === 2 && kept[0].note === '较长的备注说明'
        && J(kept[0].tags.slice().sort()) === J(['乙', '甲'].sort())
        && tombs.indexOf('g1') >= 0 && tombs.indexOf('g3') >= 0;
})(), () => { boot(MERGE_FIXTURE()); const r = runCurrencyRepair({ quiet: true }); return { r: r, kept: state.currencies, deleted: state.deleted }; });

A('B3 幂等：修正后再跑一次计划为空、再跑一次应用 `changed=false`（不会反复改写存档）', (() => {
    boot(MERGE_FIXTURE());
    runCurrencyRepair({ quiet: true });
    const p2 = currencyRepairPlan();
    const r2 = runCurrencyRepair({ quiet: true });
    return p2.counts.total === 0 && p2.counts.drop === 0 && p2.counts.mergeGroups === 0
        && r2.changed === false && r2.before === r2.after;
})(), () => { boot(MERGE_FIXTURE()); runCurrencyRepair({ quiet: true }); return { p2: currencyRepairPlan().counts, r2: runCurrencyRepair({ quiet: true }) }; });

A('B4 `dryRun` 与「计划」都不改数据：跑完 `state.currencies` 逐字符不变', (() => {
    boot(MERGE_FIXTURE().concat([cur({ id: 'x1', owner: '路人乙', name: '银元', unit: '枚', amount: 1 })]));
    const before = J(state.currencies);
    currencyRepairPlan();
    const r = runCurrencyRepair({ dryRun: true, quiet: true });
    return J(state.currencies) === before && r.changed === false && r.dropped === 0;
})(), () => { boot(MERGE_FIXTURE()); const before = J(state.currencies); const r = runCurrencyRepair({ dryRun: true, quiet: true }); return { same: J(state.currencies) === before, r: r }; });

// ==================== C 组：未标定角色（含护栏） ====================
A('C1 未标定角色默认**只报告**；主角身份已确证时勾选「同时剔除」才剔除（主角与标定角色永远保留）', (() => {
    boot([
        cur({ id: 'me1', owner: '甲角色', name: '银元', unit: '枚', amount: 5 }),
        cur({ id: 'other1', owner: '乙角色', name: '银元', unit: '枚', amount: 5 }),
    ]);
    const p1 = currencyRepairPlan();
    const p2 = currencyRepairPlan({ includeUntracked: true });
    const r1Ids = p1.report.map((r) => r.id), d2Ids = p2.drop.map((d) => d.id);
    return p1.untrackedAvailable === true && p1.counts.drop === 0
        && r1Ids.indexOf('other1') >= 0 && r1Ids.indexOf('me1') < 0
        && J(d2Ids) === J(['other1']) && p2.drop[0].reason === 'untracked-owner';
})(), () => ({ p1: currencyRepairPlan(), p2: currencyRepairPlan({ includeUntracked: true }) }));

A('C2 **护栏**：主角身份未确证（默认归属是兜底字面量「主角」）→ 勾选也不剔除未标定角色（否则会把全部货币误删）', (() => {
    boot([
        cur({ id: 'me1', owner: '甲角色', name: '银元', unit: '枚', amount: 5 }),
        cur({ id: 'other1', owner: '乙角色', name: '银元', unit: '枚', amount: 5 }),
    ], ROSTER_NO_ME);
    const p = currencyRepairPlan({ includeUntracked: true });
    return p.me === '主角' && p.meConfirmed === false && p.untrackedAvailable === false
        && p.counts.drop === 0 && p.report.filter((r) => r.reason === 'owner-untracked').length === 2
        && p.report.every((r) => r.reason !== 'owner-untracked' || r.blocked === true);
})(), () => { boot([cur({ id: 'me1', owner: '甲角色', name: '银元', unit: '枚', amount: 5 })], ROSTER_NO_ME); return { plan: currencyRepairPlan({ includeUntracked: true }), me: currencyRepairPlan().me }; });

A('C3 标定角色等同主角：被「👥 指定角色」标定的角色不会被当作未标定剔除', (() => {
    boot([
        cur({ id: 'me1', owner: '甲角色', name: '银元', unit: '枚', amount: 5 }),
        cur({ id: 'tracked1', owner: '丙角色', name: '银元', unit: '枚', amount: 5 }),
    ]);
    cfg.currencyTrackedRoles = ['丙角色'];
    const p = currencyRepairPlan({ includeUntracked: true });
    cfg.currencyTrackedRoles = [];
    return p.tracked.length === 1 && p.counts.drop === 0
        && p.report.filter((r) => r.reason === 'owner-untracked' && r.id === 'tracked1').length === 0;
})(), () => currencyRepairPlan({ includeUntracked: true }));

// ==================== D 组：面板接线 ====================
await A('D1 货币页工具行出现「🧹 修正货币」按钮（真实渲染）', (async () => {
    boot(MERGE_FIXTURE());
    openPanel('currencies');
    const html = String(panelBodyHtml('currencies'));
    return html.indexOf('data-ftt-action="currencyRepair"') > 0 && html.indexOf('🧹 修正货币') > 0
        && html.indexOf('data-ftt-action="curTrackPick"') > 0;      // 既有标定按钮仍在
})(), () => String(panelBodyHtml('currencies')).slice(0, 200));

await A('D2 动作 `currencyRepair` 只**打开计划预览**（零副作用）：预览含四段明细与「✅ 应用修正」；`currencyRepairClose` 关闭', (async () => {
    boot(MERGE_FIXTURE());
    openPanel('currencies');
    const before = J(state.currencies);
    const open = await panelAction('currencyRepair', {});
    const html = String(panelBodyHtml('currencies'));
    const openedOk = open.ok === true && open.planned > 0 && currencyRepairState().open === true
        && J(state.currencies) === before                            // 打开预览不改数据
        && html.indexOf('data-ftt-cur-repair') > 0 && html.indexOf('货币修正计划') > 0
        && html.indexOf('data-ftt-action="currencyRepairApply"') > 0
        && html.indexOf('data-ftt-action="currencyRepairClose"') > 0
        && html.indexOf('将合并的冗余条目') > 0 && html.indexOf('将剔除的条目') > 0;
    const close = await panelAction('currencyRepairClose', {});
    const after = String(panelBodyHtml('currencies'));
    return openedOk && close.ok === true && currencyRepairState().open === false && after.indexOf('data-ftt-cur-repair') < 0;
})(), () => ({ st: currencyRepairState(), action: null }));

await A('D3 动作 `currencyRepairApply`：按计划落库（剔除 / 合并 / 修正）+ 回填提示；界面回到列表', (async () => {
    boot([
        cur({ id: 'me1', owner: '甲角色', name: '银圆', unit: '银圆', amount: 0, history: [{ date: '1', delta: 500, note: '收' }] }),
        cur({ id: 'me2', owner: '甲角色', name: '金子', unit: '两', amount: 20, date: '628-03-20' }),
        cur({ id: 'me3', owner: '甲角色', name: '赤金', unit: '两', amount: 10, date: '628-03-24' }),
        cur({ id: 'ghost', owner: '路人丙', name: '银元', unit: '枚', amount: 1 }),
    ]);
    openPanel('currencies');
    await panelAction('currencyRepair', {});
    const r = await panelAction('currencyRepairApply', {});
    const cr = r.currencyRepair || {};
    const ids = state.currencies.map((c) => c.id);
    return r.ok === true && cr.changed === true && cr.before === 4 && cr.after === 2
        && J(ids.sort()) === J(['me1', 'me3'])
        && state.currencies.filter((c) => c.id === 'me1')[0].unit === '银元'             // 单位归一
        && state.currencies.filter((c) => c.id === 'me1')[0].amount === 500             // 额度补齐
        && state.currencies.filter((c) => c.id === 'me3')[0].amount === 10              // 合并保留最新额度
        && Object.keys((state.deleted || {}).currencies || {}).length === 2
        && String(panelBodyHtml('currencies')).indexOf('data-ftt-cur-repair') < 0;
})(), () => ({ ids: (state.currencies || []).map((c) => c.id), deleted: state.deleted }));

await A('D4 计划为空时预览如实说明且**不给**「应用修正」按钮', (async () => {
    boot([cur({ id: 'clean', owner: '甲角色', name: '银元', unit: '银元', amount: 10 })]);
    openPanel('currencies');
    const r = await panelAction('currencyRepair', {});
    const html = String(panelBodyHtml('currencies'));
    return r.planned === 0 && html.indexOf('未发现需要修正的条目') > 0
        && html.indexOf('data-ftt-action="currencyRepairApply"') < 0;
})(), () => ({ r: null, html: String(panelBodyHtml('currencies')).slice(0, 160) }));

await A('D5 未标定开关：`currencyRepairToggleUntracked` 切换勾选态并如实回报 `untrackedAvailable`（守卫生效时为 false）', (async () => {
    boot([cur({ id: 'me1', owner: '甲角色', name: '银元', unit: '银元', amount: 10 })], ROSTER_NO_ME);
    openPanel('currencies');
    const r1 = await panelAction('currencyRepairToggleUntracked', {});
    const st1 = currencyRepairState();
    const r2 = await panelAction('currencyRepairToggleUntracked', {});
    const st2 = currencyRepairState();
    return r1.ok === true && r1.includeUntracked === true && r1.untrackedAvailable === false
        && st1.includeUntracked === true && r2.includeUntracked === false && st2.includeUntracked === false;
})(), () => ({ st: currencyRepairState() }));

await A('D6 单位归一函数口径：`canonicalUnit` 只做无歧义归一（不把「元 / 圆 / 块」硬归到某一边）', (async () => {
    return canonicalUnit('银圆') === '银元' && canonicalUnit('缗') === '贯' && canonicalUnit('銀兩') === '两'
        && canonicalUnit('  ') === '' && canonicalUnit('元') === '元' && canonicalUnit('块') === '块'
        && canonicalUnit('美元') === '美元' && canonicalUnit('ＵＳＤ') === '美元';
})(), () => ({ a: canonicalUnit('银圆'), b: canonicalUnit('元'), c: canonicalUnit('块') }));

await A('D7 同一条目**两条修正同时生效**（单位归一 + 额度补齐，回归：按 id 建索引会互相覆盖 → 必须按「id + 字段」）', (async () => {
    boot([cur({ id: 'both', owner: '甲角色', name: '银圆', unit: '银圆', amount: 0, history: [{ date: '1', delta: 500, note: '收' }] })]);
    const plan = currencyRepairPlan();
    const fields = plan.fix.filter((f) => f.id === 'both').map((f) => f.field).sort();
    const r = runCurrencyRepair({ quiet: true });
    const got = state.currencies[0] || {};
    return J(fields) === J(['amount', 'unit']) && r.changed === true
        && got.unit === '银元' && got.amount === 500 && currencyRepairPlan().counts.total === 0;
})(), () => ({ plan: currencyRepairPlan().fix, got: state.currencies }));

R.done();
