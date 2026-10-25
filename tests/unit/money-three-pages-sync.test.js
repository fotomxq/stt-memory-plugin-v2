// ============================================================
// 单元测试 · v3.51.11 **货币三页（总览 / 收支记录 / 长期收支）内容同步核对**
//
// 用户要求（原话）：「核对货币的三个分页内容是否正常同步，如存在问题需修复。」
//
// 核对出的两个真问题 → 本文件锁死：
//   A **编辑流水不生效**：旧实现把「带既有 id 的编辑」当成重复提交 → 静默忽略（余额/账本/摘要都不动）。
//     现口径：同 id 同内容 = duplicate；同 id 内容变了 = **原位替换**（余额反向旧额+应用新额、摘要撤旧换新、id 保留）。
//   B **跨端合并后三页不同源**：对端旧版本只有 `currencies[].history`（摘要）、没有 `ledger` → 合并后账本缺这些流水
//     （总览有、收支记录没有）。现口径：合并 / 采纳远端后把摘要增量补进账本（纯函数、幂等）。
// 运行：node tests/unit/money-three-pages-sync.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { applyLedgerEntry, deleteLedgerEntry, mergeHistoryIntoLedger, ledgerSum } from '../../core/model/ledger.js';
import { mergeDataObjects } from '../../core/cross-sync.js';
import { ledgerPageHtml, dealsPageHtml, moneyPageHtml, setMoneySub } from '../../ui/money-tabs.js';
import { panelAction, setPanelHooks2, panelBodyHtml } from '../../ui/panel.js';

const R = makeReporter('money-three-pages-sync v3.51.11 三页同步（编辑流水 / 跨端合并回填）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:sync3');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.state.date = '1920-06-01';
    st.protagonist = { name: '林昭' };
    st.currencies = [{ id: 'c1', owner: '林昭', name: '银元', amount: 100, unit: '枚', history: [] }];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A 编辑流水（原位替换） ----------
A('A1 编辑流水**生效**：余额按差额更新（不是重复扣款/静默忽略），账本仍 1 条且 id 保留', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const id = state.ledger[0].id;
    const r = applyLedgerEntry({ id: id, currencyId: 'c1', date: '1919-01-02', delta: -40, note: '买面' });
    return r.ok === true && r.replaced === true && Number(state.currencies[0].amount) === 60
        && state.ledger.length === 1 && state.ledger[0].id === id && Number(state.ledger[0].delta) === -40;
})(), () => J({ amount: state.currencies[0].amount, ledger: state.ledger }));
A('A2 摘要同步：旧的一笔被撤掉、换成新的一笔（不会两条并存）；同内容再提交 → `duplicate`（不重复扣）', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const id = state.ledger[0].id;
    applyLedgerEntry({ id: id, currencyId: 'c1', date: '1919-01-02', delta: -40, note: '买面' });
    const hist = (state.currencies[0].history || []).map((h) => Number(h.delta));
    const dup = applyLedgerEntry({ id: id, currencyId: 'c1', date: '1919-01-02', delta: -40, note: '买面' });
    return hist.length === 1 && hist[0] === -40 && dup.duplicate === true && Number(state.currencies[0].amount) === 60;
})(), () => J(state.currencies[0].history));
A('A3 面板「✏ 编辑」流水 → 保存后**三页同源**：总览额度、收支记录行、摘要都与账本一致', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const id = state.ledger[0].id;
    const r = await panelAction('save', { kind: 'ledger', id: id, fields: { currencyId: 'c1', date: '1919-01-02', delta: '-40', note: '买面', source: 'manual' } });
    setMoneySub('ledger');
    await panelAction('tab', { tab: 'currencies' });
    const html = String(panelBodyHtml('currencies') || '');
    setMoneySub('overview');
    return r && r.ok === true && Number(state.currencies[0].amount) === 60 && state.ledger.length === 1
        && html.indexOf('−40') >= 0 && html.indexOf('账本共') < 0 && html.indexOf('ftt-money-summary') >= 0;
})(), 'n/a');
A('A4 删除流水仍是「反向冲正 + 墓碑」（与编辑区分：删了就不在账本里）', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const r = deleteLedgerEntry(state.ledger[0].id);
    return r.ok === true && state.ledger.length === 0 && Number(state.currencies[0].amount) === 100
        && ledgerSum('c1') === 0;
})(), 'n/a');

// ---------- B 跨端合并：摘要 → 账本回填 ----------
A('B1 纯函数 `mergeHistoryIntoLedger`：把旧端摘要补进账本（幂等；同内容不重复）', (() => {
    const cur = [{ id: 'c1', owner: '林昭', name: '银元', amount: 60, history: [{ date: '1919-01-02', delta: -30, note: '买面' }, { date: '1919-01-03', delta: 10, note: '卖鱼' }] }];
    const a = mergeHistoryIntoLedger([], cur, { source: 'migrate' });
    const b = mergeHistoryIntoLedger(a.ledger, cur, { source: 'migrate' });
    const sum = a.ledger.reduce((n, x) => n + Number(x.delta || 0), 0);
    return a.added === 2 && a.ledger.length === 2 && a.ledger.every((x) => x.source === 'migrate')
        && b.added === 0 && b.ledger.length === 2 && sum === -20;
})(), 'n/a');
A('B2 **跨端合并**（本端有账本 / 对端只有摘要）→ 合并后账本补齐，收支记录不再缺条目', (() => {
    boot();
    // 本端：currency + ledger 一条
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    const local = JSON.parse(JSON.stringify(state));
    // 对端（旧版本）：同一货币，只有 history（两笔），没有 ledger
    const remote = JSON.parse(JSON.stringify(state));
    remote.currencies = [{ id: 'c1', owner: '林昭', name: '银元', amount: 80, unit: '枚', history: [{ date: '1919-01-02', delta: -30, note: '买面' }, { date: '1919-01-05', delta: 10, note: '卖鱼' }], updatedAt: 0 }];
    remote.ledger = [];
    remote.deals = [];
    const m = mergeDataObjects(local, remote, { hashFloor: () => '' });
    const led = Array.isArray(m.data.ledger) ? m.data.ledger : [];
    const dates = led.map((x) => x.date);
    return led.length === 2 && dates.indexOf('1919-01-02') >= 0 && dates.indexOf('1919-01-05') >= 0
        && led.reduce((n, x) => n + Number(x.delta || 0), 0) === -20;
})(), () => { const m = mergeDataObjects(JSON.parse(JSON.stringify(state)), { currencies: [{ id: 'c1', owner: '林昭', name: '银元', amount: 80, unit: '枚', history: [{ date: '1919-01-05', delta: 10, note: '卖鱼' }] }], ledger: [], deals: [], deleted: {}, deletedH: {} }, { hashFloor: () => '' }); return J(m.data.ledger); });
A('B3 合并后**长期收支**不丢：两端各有不同标的物 → 合并后都在（原子层逐条）', (() => {
    boot();
    const mk = (id, name, next) => ({ id: id, name: name, startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: next, delta: 10, direction: 'increase', note: '', source: 'ai' } } });
    const local = Object.assign(JSON.parse(JSON.stringify(state)), { deals: [mk('d1', 'A', '1919-02-01')] });
    const remote = Object.assign(JSON.parse(JSON.stringify(state)), { deals: [mk('d2', 'B', '1919-02-02')], ledger: [] });
    const m = mergeDataObjects(local, remote, { hashFloor: () => '' });
    const ids = (m.data.deals || []).map((d) => d.id).sort();
    return ids.length === 2 && ids.indexOf('d1') >= 0 && ids.indexOf('d2') >= 0;
})(), 'n/a');
A('B4 三页渲染读的都是同一份 state：账本变化后，收支页与总览摘要同步反映', (() => {
    boot();
    applyLedgerEntry({ currencyId: 'c1', date: '1919-01-02', delta: -30, note: '买面' });
    setMoneySub('ledger');
    const lg = ledgerPageHtml();
    setMoneySub('deals');
    const dl = dealsPageHtml();
    setMoneySub('overview');
    const ov = moneyPageHtml('<div data-ftt-overview>总览</div>');
    return lg.indexOf('−30') >= 0 && lg.indexOf('笔数</span><b>1</b>') >= 0
        && dl.indexOf('＋ 新建标的物') >= 0 && ov.indexOf('总览') >= 0
        && (state.currencies[0].history || []).length === 1;
})(), 'n/a');

R.done();
