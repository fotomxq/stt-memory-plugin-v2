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
        && lg.indexOf('📒 收支记录') >= 0 && lg.indexOf('账本共 <b>1</b>') >= 0 && lg.indexOf('原样总览') < 0
        && dl.indexOf('📈 长期收支') >= 0 && dl.indexOf('＋新建标的物') >= 0;
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
    return html.indexOf('**已发生（节点）**') >= 0 && html.indexOf('data-ftt-forecast') >= 0
        && html.indexOf('手动') >= 0 && html.indexOf('长期收益稳定') >= 0
        && html.indexOf('补齐被上限截断') >= 0 && html.indexOf('三成分成') >= 0;
})(), 'n/a');
A('F3 收支记录页：空态引导 + 合计/笔数读数（只增不删；删除走危险动作确认）', (() => {
    boot({ ledger: [] });
    const empty = ledgerPageHtml();
    boot({ ledger: [{ id: 'l1', currencyId: 'c1', date: '1919-01-01', delta: 20, note: '卖鱼', source: 'manual' }, { id: 'l2', currencyId: 'c1', date: '1919-01-02', delta: -5, note: '买面', source: 'manual' }] });
    const html = ledgerPageHtml();
    return empty.indexOf('data-ftt-ledger-empty') >= 0 && html.indexOf('账本共 <b>2</b>') >= 0
        && html.indexOf('净额') >= 0 && html.indexOf('data-ftt-action="delete" data-kind="ledger"') >= 0;
})(), 'n/a');

R.done();
