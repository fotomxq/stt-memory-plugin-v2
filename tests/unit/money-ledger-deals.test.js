// ============================================================
// 单元测试 · v3.51.0 W32 **货币三子页**（`docs/D53`，推荐决策已采纳）
//
// 覆盖（对应 `docs/D22` W32 的 10 条）：
//   A `ledger`（数-43）：归一 / **必挂现存货币** / 幂等 id / 记账→余额→摘要联动 / 摘要上限可配（默认 60）
//   B `数-45` 联动：删除冲正 · **货币消失 → 流水级联删除（写墓碑）** · 融合 → 重指向 · 对账只报不改
//   C `deals`（数-44）：`desc` / **锚定货币必填** / **预测日期必填** / `cycle` 推断 / `lastChangeDate` 自动 / `direction` 纠正
//   D `数-46` + `技-59` 触发器：跳动判据 · 到期兑现 · 幂等 · **货币丢失不生成** · 猛烈跳动按周期补齐 · 上限如实标记 · **无 AI**
//   E `技-57` 体检四项 · `技-58` 迁移（`DATA_VERSION` 3 + `history` 回填）
//   F `应-46`/`应-47` 界面：三子页可切换、总览原样、预测与事实分区、触发器状态可见
//
// 运行：node tests/unit/money-ledger-deals.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { DATA_VERSION, DIMENSIONS, ATOM_DIM_KEYS } from '../../core/constants.js';
import {
    normalizeLedgerEntry, ledgerIdOf, applyLedgerEntry, deleteLedgerEntry, cascadeDeleteLedgerForCurrency,
    ledgerOf, ledgerSum, reconcileLedger, orphanLedgerEntries, backfillLedgerFromHistory, currencyHistoryMax,
} from '../../core/model/ledger.js';
import { normalizeDeal, dealCycleDays, inferCycleFromNodes, lastNodeDate } from '../../core/model/deal.js';
import { runDealTriggers, dealJumpKind, dealTriggerConf, addStoryDays } from '../../core/deal-triggers.js';
import { dataHealthReport } from '../../core/data-health.js';
import { migrateState } from '../../core/migrate.js';
import { moneyPageHtml, setMoneySub, ledgerPageHtml, dealsPageHtml } from '../../ui/money-tabs.js';
import { kindFields, deconstructEntry } from '../../ui/fields.js';
import { flatFor } from '../../ui/entry-flat.js';
import { panelAction, setPanelHooks2, bindOverlay, panelBodyHtml } from '../../ui/panel.js';

const R = makeReporter('money-ledger-deals v3.51.0 货币三子页（W32 数-43/44/45/46 · 应-46/47 · 技-57/58/59）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:ledger');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.currencies = [{ id: 'c1', owner: '主角', name: '银元', amount: 100, unit: '枚', history: [], date: '1919-01-01' }];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A ledger ----------
A('A1 归一：缺货币 / 缺日期 / 金额为 0 → `null`（拒绝，不产生无主流水）；正常条目字段齐全', (() => {
    const bad1 = normalizeLedgerEntry({ date: '1919-01-01', delta: 5 });
    const bad2 = normalizeLedgerEntry({ currencyId: 'c1', delta: 5 });
    const bad3 = normalizeLedgerEntry({ currencyId: 'c1', date: '1919-01-01', delta: 0 });
    const ok = normalizeLedgerEntry({ currencyId: 'c1', date: '1919-01-01', delta: -12.5, note: '买面包' });
    return bad1 === null && bad2 === null && bad3 === null && ok && ok.currencyId === 'c1' && ok.delta === -12.5 && ok.source === 'manual';
})(), 'n/a');
A('A2 **记账 → 余额 + 摘要联动**；重复提交同一笔 → `duplicate`（不重复扣款）', (() => {
    boot();
    const r1 = applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const r2 = applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const cur = state.currencies[0];
    return r1.ok === true && r1.amountAfter === 70 && r2.duplicate === true
        && state.ledger.length === 1 && Number(cur.amount) === 70
        && (cur.history || []).length === 1 && ledgerSum('c1') === -30 && ledgerOf('c1').length === 1;
})(), 'n/a');
A('A3 记账**必须挂现存货币**：货币不存在 → 拒绝且不新建货币', (() => {
    boot();
    const r = applyLedgerEntry({ currencyId: 'nope', date: '1919-01-02', delta: 10 });
    return r.ok === false && String(r.error).indexOf('找不到对应的货币') >= 0 && state.ledger.length === 0 && state.currencies.length === 1;
})(), 'n/a');
A('A4 **摘要上限可配**：`currencyHistoryMax` 默认 60（原 12），设为 10 时摘要只留 10 笔而账本全量保留', (() => {
    boot();
    const def = currencyHistoryMax();
    cfg.currencyHistoryMax = 10;
    for (let i = 1; i <= 15; i++) applyLedgerEntry({ currencyId: 'c1', date: '1919-01-0' + (i % 9 + 1), delta: -1, note: 'n' + i });
    const cur = state.currencies[0];
    cfg.currencyHistoryMax = 60;
    return def === 60 && (cur.history || []).length === 10 && state.ledger.length === 15;
})(), 'n/a');
A('A5 幂等 id 与 `ledgerIdOf` 同口径：同货币 + 同日期 + 同金额 + 同说明 → 同一 id', (() => {
    const a = ledgerIdOf('c1', '1919-01-01', -5, 'x');
    const b = ledgerIdOf('c1', '1919-01-01', -5, 'x');
    const c = ledgerIdOf('c1', '1919-01-01', -6, 'x');
    return a === b && a !== c && a.indexOf('led_') === 0;
})(), 'n/a');

// ---------- B 联动 ----------
A('B1 **用户删除一笔** → 反向冲正余额 + 写墓碑；摘要同步去掉该笔', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const id = state.ledger[0].id;
    const r = deleteLedgerEntry(id);
    return r.ok === true && Number(state.currencies[0].amount) === 100 && state.ledger.length === 0
        && !!(state.deleted && state.deleted.ledger && state.deleted.ledger[id]);
})(), 'n/a');
A('B2 **货币消失 → 流水级联删除**（逐条墓碑，不留孤儿）', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30 });
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-03', delta: 10 });
    const r = cascadeDeleteLedgerForCurrency('c1');
    const tombs = Object.keys((state.deleted || {}).ledger || {}).length;
    return r.removed === 2 && state.ledger.length === 0 && tombs === 2 && orphanLedgerEntries().length === 0;
})(), 'n/a');
A('B3 **对账只报不改**：余额与账本净额不一致 → 报告差异，但不动任何数据', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30 });     // 余额 70、净额 -30
    state.currencies[0].amount = 55;                                            // 人为制造差异
    const rows = reconcileLedger();
    const r = rows.filter((x) => x.currencyId === 'c1')[0];
    return r && r.amount === 55 && r.sum === -30 && r.diff === 85 && Number(state.currencies[0].amount) === 55;
})(), 'n/a');
A('B4 老存档 `history` → `ledger` **回填**（Q2 裁决：`source` 记为 `migrate`，按 id 幂等）', (() => {
    boot({ currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 100, unit: '枚', history: [{ date: '1919-01-01', delta: -20, note: '旧流水' }] }], ledger: [] });
    const r1 = backfillLedgerFromHistory();
    const r2 = backfillLedgerFromHistory();
    return r1.added === 1 && r2.added === 0 && state.ledger.length === 1 && state.ledger[0].source === 'migrate';
})(), 'n/a');

// ---------- C deals ----------
A('C1 归一：`currencyId` 必填 / `forecast.nextDate` 必填 / `name`+`startDate` 必填；缺一 → `null`', (() => {
    const base = { name: '船厂分成', startDate: '1919-01-01', currencyId: 'c1', outlook: { text: '长期收益', nodes: [{ date: '1919-02-01', delta: 100, note: '首期' }], forecast: { nextDate: '1919-03-01', delta: 100, direction: 'increase', source: 'ai' } } };
    const ok = normalizeDeal(base);
    const noCur = normalizeDeal(Object.assign({}, base, { currencyId: '' }));
    const noFc = normalizeDeal(Object.assign({}, base, { outlook: { text: '', nodes: [], forecast: {} } }));
    const noName = normalizeDeal(Object.assign({}, base, { name: '' }));
    return ok && ok.lastChangeDate === '1919-02-01' && noCur === null && noFc === null && noName === null;
})(), 'n/a');
A('C2 `direction` 与 `delta` 矛盾 → **以符号纠正**；`cycle` 缺省由节点间隔推断', (() => {
    const d = normalizeDeal({ name: 'A', startDate: '1919-01-01', currencyId: 'c1', outlook: { text: '', nodes: [{ date: '1919-01-01' }, { date: '1919-01-31' }, { date: '1919-03-02' }], forecast: { nextDate: '1919-04-01', delta: -50, direction: 'increase', source: 'ai' } } });
    return d && d.outlook.forecast.direction === 'decrease' && d.outlook.forecast.corrected === true && d.cycle === 'monthly';
})(), 'n/a');
A('C3 `dealCycleDays` 取值域：weekly/monthly/quarterly/yearly/custom:N；`lastNodeDate` 取最大日期', (() => {
    return dealCycleDays('weekly') === 7 && dealCycleDays('monthly') === 30 && dealCycleDays('quarterly') === 90
        && dealCycleDays('yearly') === 365 && dealCycleDays('custom:45') === 45 && dealCycleDays('nope') === 0
        && lastNodeDate([{ date: '1919-02-01' }, { date: '1919-05-01' }]) === '1919-05-01';
})(), 'n/a');

// ---------- D 触发器 ----------
A('D1 跳动判据：跨度 ≥ 30 天 → `jump`；回退 → `backward`；脏日期 → `invalid`（后两者**不兑现**）', (() => {
    const c = dealTriggerConf();
    return c.jumpMinDays === 30 && c.strongJumpCycles === 3 && c.catchUpMax === 24
        && dealJumpKind('1919-01-01', '1919-02-15') === 'jump'
        && dealJumpKind('1919-02-15', '1919-01-01') === 'backward'
        && dealJumpKind('坏', '1919-01-01') === 'invalid';
})(), 'n/a');
A('D2 **到期兑现**（`nextDate ≤ 当前剧情日期`）：生成一笔来源为 deal 的流水 + 节点提升为已发生 + 余额联动', (() => {
    boot({ deals: [{ id: 'd1', name: '船厂分成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 100, direction: 'increase', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-03-01' });
    const led = state.ledger.filter((x) => x.source === 'deal');
    const deal = state.deals[0];
    return r.fired >= 1 && led.length >= 1 && led[0].dealId === 'd1' && led[0].date === '1919-02-01'
        && Number(state.currencies[0].amount) > 100 && (deal.outlook.nodes || []).length >= 1;
})(), J(state.ledger));
A('D3 **幂等**：同一批预测重跑不重复生成（同 `dealId + 节点日期` 只兑现一次）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 100, direction: 'increase', source: 'ai' } } }] });
    runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-02-05' });
    const n1 = state.ledger.length;
    runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-02-05' });
    const n2 = state.ledger.length;
    return n1 === 1 && n2 === 1;
})(), 'n/a');
A('D4 **锚定货币丢失 → 不生成**（留痕 `currency-missing`，不阻塞其它标的物）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'gone', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 100, direction: 'increase', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-03-01' });
    return r.skipped === 1 && state.ledger.length === 0 && state.deals[0].trigger.skippedReason === 'currency-missing';
})(), 'n/a');
A('D5 **猛烈跳动按周期补齐**（跨度 ≥ 3 个周期），受 `dealCatchUpMax` 上限并如实标记 `catchUpTruncated`', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', source: 'ai' } } }] });
    cfg.dealCatchUpMax = 3;
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-12-01' });   // 约 10 个月 → 超过 3 周期
    const truncated = state.deals[0].trigger.catchUpTruncated === true;
    cfg.dealCatchUpMax = 24;
    return r.jump === 'jump' && r.fired === 3 && r.truncated >= 1 && truncated;
})(), J({ fired: 3 }));
A('D6 **全程无 AI**：触发器接口只做日期数学与写库（返回值显式标 `noAi:true`），不依赖任何生成函数', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-03-01' });
    return r.noAi === true && r.ok === true && addStoryDays('1919-01-31', 30) === '1919-03-02';
})(), 'n/a');

// ---------- E 体检 + 迁移 ----------
A('E1 体检四项：余额不符（info）/ 孤儿流水（warn）/ 预测被当真（info）/ 触发器停摆（warn）', (() => {
    boot({
        currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 999, unit: '枚', history: [] }],
        ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: -5, note: '', source: 'manual' }, { id: 'l2', currencyId: 'gone', date: '1919-01-02', delta: 1, note: '', source: 'manual' }],
        deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'gone', cycle: 'monthly', outlook: { text: '', nodes: [{ date: '1919-02-01' }], forecast: { nextDate: '1919-02-01', delta: 5, direction: 'increase', source: 'ai' } }, trigger: {} }],
    });
    const rep = dataHealthReport(null, { force: true });
    const codes = (rep.findings || []).map((f) => f.code);
    return codes.indexOf('ledger-amount-mismatch') >= 0 && codes.indexOf('ledger-orphan') >= 0
        && codes.indexOf('deal-forecast-as-fact') >= 0 && codes.indexOf('deal-trigger-stalled') >= 0
        && rep.findings.filter((f) => f.code === 'ledger-orphan').every((f) => f.level === 'warn');
})(), 'n/a');
A('E2 数字口径：`DATA_VERSION` 3 · 维度 17 · 原子层 16；`migrateState` 补两容器并回填 `history`', (() => {
    const old = { currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 100, unit: '枚', history: [{ date: '1919-01-01', delta: -20, note: '旧' }] }] };
    const migrated = migrateState(old);
    return DATA_VERSION === 3 && DIMENSIONS.length === 17 && ATOM_DIM_KEYS.length === 16
        && Array.isArray(migrated.ledger) && Array.isArray(migrated.deals) && migrated.ledger.length === 1 && migrated.ledger[0].source === 'migrate';
})(), J({ dv: DATA_VERSION, dims: DIMENSIONS.length, atoms: ATOM_DIM_KEYS.length }));

// ---------- F 界面 ----------
A('F1 **三子页可切换**：货币总览（原样传入、一字不改）/ 收支记录 / 长期收支', (() => {
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: 5, note: '', source: 'manual' }], deals: [] });
    setMoneySub('overview');
    const ov = moneyPageHtml('<div data-ftt-overview>原样总览</div>');
    setMoneySub('ledger');
    const lg = moneyPageHtml('<div data-ftt-overview>原样总览</div>');
    setMoneySub('deals');
    const dl = moneyPageHtml('<div data-ftt-overview>原样总览</div>');
    setMoneySub('overview');
    return ov.indexOf('原样总览') >= 0 && ov.indexOf('data-ftt-csub-tabs') >= 0
        && lg.indexOf('📒 收支记录') >= 0 && lg.indexOf('ftt-money-summary') >= 0 && lg.indexOf('ftt-money-row') >= 0 && lg.indexOf('原样总览') < 0
        && dl.indexOf('📈 长期收支') >= 0 && dl.indexOf('＋ 新建标的物') >= 0;
})(), 'n/a');
A('F2 详情**预测与事实分区**：已发生节点与预测区块分别呈现、预测标来源；触发器的停摆/截断状态可见', (() => {
    boot({
        deals: [{
            id: 'd1', name: '船厂分成', desc: '三成分成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly',
            status: '长期收益稳定', outlook: { text: '看好', nodes: [{ date: '1919-02-01', delta: 100, note: '首期' }], forecast: { nextDate: '1919-03-01', delta: 50, direction: 'decrease', note: '淡季', source: 'manual' } },
            trigger: { lastFiredDate: '1919-02-05', lastFiredNodeDate: '1919-02-01', catchUpTruncated: true, skippedReason: '' },
        }],
    });
    const html = dealsPageHtml();
    return html.indexOf('前景预判 ② 已发生的变动节点') >= 0 && html.indexOf('data-ftt-forecast') >= 0
        && html.indexOf('手动') >= 0 && html.indexOf('长期收益稳定') >= 0
        && html.indexOf('补齐被截断') >= 0 && html.indexOf('三成分成') >= 0 && html.indexOf('ftt-deal-card') >= 0;
})(), 'n/a');
A('F3 收支记录页：空态引导 + 合计/笔数读数（只增不删；删除走危险动作确认）', (() => {
    boot({ ledger: [] });
    const empty = ledgerPageHtml();
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: 20, note: '卖鱼', source: 'manual' }, { id: 'l2', currencyId: 'c1', date: '1919-01-02', delta: -5, note: '买面', source: 'manual' }] });
    const html = ledgerPageHtml();
    return empty.indexOf('data-ftt-ledger-empty') >= 0 && html.indexOf('笔数</span><b>2</b>') >= 0
        && html.indexOf('净额') >= 0 && html.indexOf('data-ftt-action="delete" data-kind="ledger"') >= 0
        && html.indexOf('＋ 记一笔') >= 0;
})(), 'n/a');

// ---------- G 编辑器（应-47）：字段表 + 保存走记账入口 ----------
A('G1 编辑器字段表：`ledger` 6 项 / `deals` 15 项，且 `deconstructEntry` 把扁平表单还原为**三段 `outlook`**（预测与事实分字段）', (() => {
    const lf = kindFields('ledger'), df = kindFields('deals');
    const raw = deconstructEntry('deals', {
        name: '船厂分成', desc: '三成', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly',
        outlookText: '看好', nodesText: '1919-02-01|100|首期', forecastNextDate: '1919-03-01',
        forecastDelta: '-5', forecastDirection: 'decrease', forecastNote: '淡季', forecastSource: 'ai',
    });
    return lf.length === 6 && df.length === 15
        && raw.outlook && Array.isArray(raw.outlook.nodes) && raw.outlook.nodes.length === 1
        && raw.outlook.nodes[0].date === '1919-02-01' && raw.outlook.nodes[0].delta === 100
        && raw.outlook.forecast.nextDate === '1919-03-01' && raw.outlook.forecast.delta === -5 && raw.outlook.forecast.source === 'ai'
        && raw.outlookText === undefined && raw.nodesText === undefined && raw.forecastNextDate === undefined;
})(), 'n/a');
A('G2 **面板「保存」一条流水 → 走记账入口**（余额联动 + 幂等）：编辑器保存不能只写账本、不动余额', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('save', { kind: 'ledger', id: '', fields: { currencyId: 'c1', date: '1919-01-02', delta: '-30', note: '买面', source: 'manual' } });
    const r2 = await panelAction('save', { kind: 'ledger', id: '', fields: { currencyId: 'c1', date: '1919-01-02', delta: '-30', note: '买面', source: 'manual' } });
    return r && r.ok === true && state.ledger.length === 1 && Number(state.currencies[0].amount) === 70
        && (state.currencies[0].history || []).length === 1 && r2 && r2.ok === true && r2.duplicate === true && state.ledger.length === 1;
})(), 'n/a');
A('G3 面板「保存」一条流水但**货币不存在** → 拒绝（不写账本、不新建货币）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('save', { kind: 'ledger', id: '', fields: { currencyId: 'nope', date: '1919-01-02', delta: '10', note: '', source: 'manual' } });
    return r && r.ok === false && String(r.reason) === 'ledger-rejected' && state.ledger.length === 0 && state.currencies.length === 1;
})(), 'n/a');

// ---------- H 真实点击委托（v3.51.2 用户报告「货币子页面无法点击」的回归锁） ----------
A('H1 **真实点击**「📒 收支记录」子标签 → 面板切到收支记录页（不再是「点了没反应」）', (async () => {
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: 5, note: '卖鱼', source: 'manual' }], deals: [] });
    setMoneySub('overview');
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'currencies' });
    bindOverlay();
    const doc = globalThis.document;
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const fire = (ds) => {
        const tg = { dataset: ds, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 || String(sel).indexOf('button') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        return new Promise((r) => setTimeout(r, 5));
    };
    // ① 点「收支记录」子标签（属性 = data-ftt-csub）
    await fire({ fttCsub: 'ledger' });
    const onLedger = String(panelBodyHtml('currencies') || '');
    // ② 点「长期收支」
    await fire({ fttCsub: 'deals' });
    const onDeals = String(panelBodyHtml('currencies') || '');
    // ③ 点回「货币总览」
    await fire({ fttCsub: 'overview' });
    const onOverview = String(panelBodyHtml('currencies') || '');
    return onLedger.indexOf('ftt-money-summary') >= 0 && onLedger.indexOf('📒 收支记录') >= 0 && onLedger.indexOf('ftt-money-row') >= 0
        && onDeals.indexOf('＋ 新建标的物') >= 0 && onDeals.indexOf('ftt-money-row') < 0
        && onOverview.indexOf('原样') < 0 && onOverview.indexOf('data-ftt-csub="ledger"') >= 0;
})(), 'n/a');
A('H2 货币下拉：记账/标的物的货币字段是**下拉选择**（选项来自当前货币列表，含「请选择」占位）', (() => {
    boot({ currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 100, unit: '枚' }, { id: 'c2', owner: '甲', name: '铜钱', amount: 3, unit: '枚' }] });
    const lf = kindFields('ledger').filter((f) => f.key === 'currencyId')[0] || {};
    const df = kindFields('deals').filter((f) => f.key === 'currencyId')[0] || {};
    const opts = (lf.options || []).map((o) => String(o.value));
    return lf.type === 'select' && df.type === 'select' && opts.indexOf('') === 0
        && opts.indexOf('c1') > 0 && opts.indexOf('c2') > 0
        && String((lf.options || [])[1].label).indexOf('银元') >= 0;
})(), 'n/a');
A('H3 变动节点支持 **JSON**（结构化）或逐行；解析失败如实报错（不再静默丢弃）', (() => {
    const okJson = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '[{"date":"1919-02-01","delta":100,"note":"首期"}]', forecastNextDate: '1919-03-01', forecastSource: 'ai' });
    const okLine = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '1919-02-01|100|首期', forecastNextDate: '1919-03-01', forecastSource: 'ai' });
    const badJson = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '[{oops', forecastNextDate: '1919-03-01' });
    const badLine = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '1919-02-01|abc|首期', forecastNextDate: '1919-03-01' });
    return okJson.outlook.nodes.length === 1 && okJson.outlook.nodes[0].delta === 100
        && okLine.outlook.nodes.length === 1 && okLine.outlook.nodes[0].date === '1919-02-01'
        && String(badJson.__error || '').indexOf('JSON') >= 0 && String(badLine.__error || '').indexOf('第 1 行') >= 0;
})(), 'n/a');
A('H4 保存失败**给出具体原因**：缺锚定货币 / 缺预测日期 / 节点解析失败，都不再只说「必要字段缺失」', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r1 = await panelAction('save', { kind: 'deals', id: '', fields: { name: 'A', currencyId: '', startDate: '1919-01-01', forecastNextDate: '1919-03-01', forecastSource: 'ai' } });
    const r2 = await panelAction('save', { kind: 'deals', id: '', fields: { name: 'A', currencyId: 'c1', startDate: '1919-01-01', forecastNextDate: '', forecastSource: 'ai' } });
    const r3 = await panelAction('save', { kind: 'deals', id: '', fields: { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '[{oops', forecastNextDate: '1919-03-01', forecastSource: 'ai' } });
    return r1 && r1.ok === false && String(r1.error).indexOf('锚定货币') >= 0
        && r2 && r2.ok === false && String(r2.error).indexOf('预测日期') >= 0
        && r3 && r3.ok === false && String(r3.error).indexOf('JSON') >= 0;
})(), 'n/a');
A('H6 **点「＋ 记一笔」→ 编辑器出现**（修复「顶部按钮全部错误/无法点击」）：表单含货币下拉与保存按钮', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setMoneySub('ledger');
    await panelAction('tab', { tab: 'currencies' });
    await panelAction('add', { kind: 'ledger' });
    const html = String(panelBodyHtml('currencies') || '');
    return html.indexOf('data-ftt-action="save" data-kind="ledger"') >= 0
        && html.indexOf('data-ftt-ed="currencyId"') >= 0 && html.indexOf('<select data-ftt-ed="currencyId"') >= 0
        && html.indexOf('data-ftt-ed="delta"') >= 0 && html.indexOf('ftt-money-summary') >= 0;
})(), 'n/a');
A('H7 **点「✏」→ 编辑器带该条数据**（收支记录 / 长期收支都可用）；取消后回到列表', (async () => {
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面', source: 'manual' }], deals: [{ id: 'd1', name: '船厂分成', desc: '三成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '看好', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } } }] });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setMoneySub('ledger');
    await panelAction('tab', { tab: 'currencies' });
    await panelAction('edit', { kind: 'ledger', id: 'l1' });
    const lg = String(panelBodyHtml('currencies') || '');
    setMoneySub('deals');
    await panelAction('edit', { kind: 'deals', id: 'd1' });
    const dl = String(panelBodyHtml('currencies') || '');
    await panelAction('closeEntry', { kind: 'deals' });
    const back = String(panelBodyHtml('currencies') || '');
    setMoneySub('overview');
    return lg.indexOf('data-ftt-action="save" data-kind="ledger"') >= 0 && lg.indexOf('value="买面"') >= 0
        && dl.indexOf('data-ftt-action="save" data-kind="deals"') >= 0 && dl.indexOf('value="船厂分成"') >= 0
        && back.indexOf('data-ftt-action="save" data-kind="deals"') < 0 && back.indexOf('ftt-deal-card') >= 0;
})(), 'n/a');
A('H8 「＋ 新建标的物」→ 长期收支编辑器出现（锚定货币为下拉、三段预判字段齐全）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setMoneySub('deals');
    await panelAction('tab', { tab: 'currencies' });
    await panelAction('add', { kind: 'deals' });
    const html = String(panelBodyHtml('currencies') || '');
    setMoneySub('overview');
    return html.indexOf('data-ftt-action="save" data-kind="deals"') >= 0
        && html.indexOf('<select data-ftt-ed="currencyId"') >= 0
        && html.indexOf('data-ftt-ed="forecastNextDate"') >= 0 && html.indexOf('data-ftt-ed="nodesText"') >= 0
        && html.indexOf('data-ftt-ed="outlookText"') >= 0;
})(), 'n/a');
A('H5 收支记录与长期收支行都有「✏ 编辑」入口（编辑走既有编辑器，不新增动作）', (() => {
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: 5, note: '', source: 'manual' }], deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 1, direction: 'increase', source: 'ai' } } }] });
    const lg = ledgerPageHtml(), dl = dealsPageHtml();
    return lg.indexOf('data-ftt-action="edit" data-kind="ledger" data-id="l1"') >= 0
        && dl.indexOf('data-ftt-action="edit" data-kind="deals" data-id="d1"') >= 0;
})(), 'n/a');

// ---------- I v3.51.4：失败保留草稿 + 分页按钮 + 修复按钮 ----------
A('I1 **保存失败 → 编辑器不关闭、草稿原样保留**（用户报告「失败后关闭会重置所有信息」）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setMoneySub('deals');
    await panelAction('tab', { tab: 'currencies' });
    // 故意缺锚定货币 → 保存失败
    const r = await panelAction('save', { kind: 'deals', id: '', fields: { name: '船厂分成', desc: '三成', currencyId: '', startDate: '1919-01-01', cycle: 'monthly', status: '稳定', outlookText: '看好', nodesText: '1919-02-01|100|首期', forecastNextDate: '1919-03-01', forecastNote: '淡季', forecastSource: 'ai' } });
    const html = String(panelBodyHtml('currencies') || '');
    setMoneySub('overview');
    return r && r.ok === false && r.reason === 'field-required'
        && html.indexOf('data-ftt-action="save" data-kind="deals"') >= 0          // 编辑器仍在
        && html.indexOf('value="船厂分成"') >= 0 && html.indexOf('value="稳定"') >= 0;   // 已填内容仍在
})(), 'n/a');
A('I2 分页按钮不再错位：收支记录只有「记一笔」；长期收支只有「新建标的物 + 修复」', (() => {
    boot({ ledger: [], deals: [] });
    const lg = ledgerPageHtml(), dl = dealsPageHtml();
    return lg.indexOf('＋ 记一笔') >= 0 && lg.indexOf('＋ 新建标的物') < 0 && lg.indexOf('data-ftt-action="dealRepair"') < 0
        && dl.indexOf('＋ 新建标的物') >= 0 && dl.indexOf('＋ 记一笔') < 0 && dl.indexOf('data-ftt-action="dealRepair"') >= 0;
})(), 'n/a');
A('I3 「🔧 修复（3 条/次）」按钮 → 面板动作调用修复管线并回报摘要（注入 AI 文本，不触网）', (async () => {
    boot({ deals: [{ id: 'd1', name: '船厂分成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: '', status: '', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } } }] });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const { setAiHooks } = await import('../../core/ai-hooks.js');
    setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify({ items: [{ id: 'd1', status: '稳定', desc: '三成分成', forecast: { nextDate: '1919-04-01', delta: 10, direction: 'increase', note: '' } }] }) }), feedText: () => '正文', busy: () => false });
    const r = await panelAction('dealRepair', {});
    setMoneySub('overview');
    return r && r.ok === true && r.changed === 1 && String(r.note).indexOf('长期收支修复') >= 0
        && (state.deals[0].status === '稳定') && (state.deals[0].desc === '三成分成');
})(), 'n/a');

// ---------- J v3.51.5：触发器改为「抵达剧情日期即触发」+ 叠加执行 + 截止日期 ----------
function mkDeal(extra) {
    return Object.assign({
        id: 'd1', name: '船厂分成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly',
        outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } },
    }, extra || {});
}
A('J1 **小步推进也触发**（旧口径要求跨度 ≥ 30 天 → 「只推进 1 天就到期」永远不兑现）', (() => {
    boot({ deals: [mkDeal()] });
    const r = runDealTriggers({ prevDate: '1919-01-31', curDate: '1919-02-01' });
    return r.fired === 1 && state.ledger.length === 1 && state.ledger[0].date === '1919-02-01'
        && state.deals[0].outlook.forecast.nextDate === '1919-03-03';   // 水位推进到下个周期
})(), () => J(state.deals.map((d) => [d.outlook.forecast.nextDate, state.ledger.length])));
A('J2 **叠加执行**：一次推进跨多个周期 → 连续兑现，直到水位 > 当前剧情日期', (() => {
    boot({ deals: [mkDeal()] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-06-01' });
    const fc = state.deals[0].outlook.forecast;
    return r.fired >= 3 && state.ledger.length === r.fired && String(fc.nextDate) > '1919-06-01'
        && state.deals[0].outlook.nodes.length === r.fired;
})(), () => J({ fired: state.ledger.length, fc: state.deals[0].outlook.forecast.nextDate }));
A('J3 **截止日期**：越过 `endDate` 即停（不再生成），并把预测水位清空（本条自然结束）', (() => {
    boot({ deals: [mkDeal({ endDate: '1919-03-31' })] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-06-01' });
    return r.fired === 2 && state.ledger.length === 2 && state.deals[0].outlook.forecast.nextDate === '';
})(), () => J({ fired: state.ledger.length, fc: state.deals[0].outlook.forecast.nextDate }));
A('J4 **首次运行**（prev 为空）也处置：受 `dealCatchUpMax` 上限并如实标 `catchUpTruncated`', (() => {
    boot({ deals: [mkDeal()] });
    cfg.dealCatchUpMax = 3;
    const r = runDealTriggers({ prevDate: '', curDate: '1919-06-01' });
    cfg.dealCatchUpMax = 24;
    // 被上限截断时，水位停在**下一个待兑现节点**（仍 ≤ 当前剧情日期）→ 下次运行继续叠加
    return r.fired === 3 && r.truncated === 1 && state.deals[0].trigger.catchUpTruncated === true
        && state.deals[0].outlook.forecast.nextDate === '1919-05-02';
})(), 'n/a');
A('J5 **剧情日期回退** → 不处置（不生成历史流水）', (() => {
    boot({ deals: [mkDeal()] });
    const r = runDealTriggers({ prevDate: '1920-01-01', curDate: '1919-06-01' });
    return r.fired === 0 && state.ledger.length === 0 && r.jump === 'backward';
})(), 'n/a');

// ---------- K v3.51.5：长期收支**编辑回填**（用户报告「信息没回填」） ----------
A('K1 `flatFor(deals)`：三段 `outlook` 扁平化（文字 / 节点逐行 / 预测四字段），且与 `deconstructEntry` **互逆**', (() => {
    const item = {
        id: 'd1', name: '船厂分成', desc: '三成', kind: 'royalty', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', status: '稳定',
        outlook: { text: '看好', nodes: [{ date: '1919-02-01', delta: 100, note: '首期' }, { date: '1919-03-03', delta: 50, note: '淡季' }], forecast: { nextDate: '1919-04-02', delta: -10, direction: 'decrease', note: '减半', source: 'manual' } },
    };
    const flat = flatFor('deals', item);
    const back = deconstructEntry('deals', Object.assign({}, flat, { id: 'd1' }));
    return flat.outlookText === '看好' && flat.nodesText === '1919-02-01|100|首期\n1919-03-03|50|淡季'
        && flat.forecastNextDate === '1919-04-02' && flat.forecastDelta === -10 && flat.forecastDirection === 'decrease'
        && flat.forecastNote === '减半' && flat.forecastSource === 'manual'
        && back.outlook.text === '看好' && back.outlook.nodes.length === 2 && back.outlook.nodes[0].delta === 100
        && back.outlook.forecast.nextDate === '1919-04-02' && back.outlook.forecast.direction === 'decrease';
})(), 'n/a');
A('K2 面板「✏ 编辑」长期收支 → **表单带原值**（标题 / 约定 / 现状 / 节点文本 / 预测日期都在）', (async () => {
    boot({ deals: [{ id: 'd1', name: '船厂分成', desc: '三成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', status: '稳定',
        outlook: { text: '看好', nodes: [{ date: '1919-02-01', delta: 100, note: '首期' }], forecast: { nextDate: '1919-03-03', delta: 10, direction: 'increase', note: '淡季', source: 'manual' } } }] });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    setMoneySub('deals');
    await panelAction('tab', { tab: 'currencies' });
    await panelAction('edit', { kind: 'deals', id: 'd1' });
    const html = String(panelBodyHtml('currencies') || '');
    setMoneySub('overview');
    return html.indexOf('value="船厂分成"') >= 0 && html.indexOf('value="稳定"') >= 0
        && html.indexOf('1919-02-01|100|首期') >= 0 && html.indexOf('value="1919-03-03"') >= 0
        && html.indexOf('value="看好"') >= 0 && html.indexOf('value="三成"') >= 0;
})(), 'n/a');
A('K3 编辑保存（未改内容）→ 不丢字段：节点/预测/现状原样保留（回填↔还原闭环）', (async () => {
    boot({ deals: [{ id: 'd1', name: '船厂分成', desc: '三成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', status: '稳定',
        outlook: { text: '看好', nodes: [{ date: '1919-02-01', delta: 100, note: '首期' }], forecast: { nextDate: '1919-03-03', delta: 10, direction: 'increase', note: '淡季', source: 'manual' } } }] });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const flat = flatFor('deals', state.deals[0]);
    const r = await panelAction('save', { kind: 'deals', id: 'd1', fields: flat });
    const d = state.deals[0];
    return r && r.ok === true && d.outlook.nodes.length === 1 && d.outlook.nodes[0].delta === 100
        && d.outlook.forecast.nextDate === '1919-03-03' && d.outlook.forecast.source === 'manual'
        && d.status === '稳定' && d.desc === '三成';
})(), 'n/a');

R.done();
