// ============================================================
// 单元测试 · v3.51.7 **长期收支下一预测的兜底设计** + **轮动后按周期推测下一轮** + **结构性节点编辑**
//
// 用户要求（原话）：「长期收支的下一个预测阶段，增加兜底设计。根据前几论收益的趋势预判，判定预计收益点、预计收益费用等。
//   如果AI明确，则以AI为准；如果制空，则采用该设计。其次如果轮动了1轮，应该根据周期，利用起来推测到下一轮。
//   最后，请优化长期收支编辑的面板，一些多余的提示完全没意义。前景预判② 已发生的变动节点，设计也有问题，
//   应该采用结构性设计，不要用分隔符设计。」
//
// 覆盖：
//   A `inferForecastFallback`：趋势（线性外推）/ 单节点 / 无节点 / 周期缺失
//   B `normalizeDeal`：AI 明确 → 以 AI 为准（source 保留）；留空 → 兜底（source='auto'）；推不出日期 → 拒绝
//   C 触发器：**轮动 1 轮后**按周期推进下一轮；预测为 auto 时用**新趋势**刷新金额；越过截止日期不兜底
//   D 结构性节点：`deconstructEntry` 读 `node-*` 行；空行忽略；非法金额 → 具体报错；旧 `nodesText` 仍兼容
//   E 编辑面板：标签精简（无长串提示）；节点渲染为三列行控件（无「日期|金额|说明」文本域）
// 运行：node tests/unit/deal-forecast-fallback.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { DEAL_NODES_MAX, capDealNodes, inferForecastFallback, normalizeDeal, resolveForecastDelta } from '../../core/model/deal.js';
import { runDealTriggers } from '../../core/deal-triggers.js';
import { kindFields, deconstructEntry } from '../../ui/fields.js';
import { flatFor } from '../../ui/entry-flat.js';
import { nodeTableClick } from '../../ui/node-table-dom.js';
import { ledgerPageHtml } from '../../ui/money-tabs.js';

const R = makeReporter('deal-forecast-fallback v3.51.7 兜底预测 / 轮动推测 / 结构性节点');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:fallback');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.state.date = '1920-06-01';
    st.protagonist = { name: '林昭' };
    st.currencies = [{ id: 'c1', owner: '林昭', name: '银元', amount: 100, unit: '枚' }];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A 趋势外推 ----------
A('A1 趋势（最近 ≤3 节点线性外推）：10/20/30 → 下一节点 **40**；日期 = 最后节点 + 周期', (() => {
    const fb = inferForecastFallback([{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }, { date: '1919-03-01', delta: 30 }], 'monthly', '1919-01-01');
    return fb.delta === 40 && fb.nextDate === '1919-03-31' && fb.direction === 'increase' && fb.source === 'auto' && fb.basis === 'trend';
})(), () => inferForecastFallback([{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }, { date: '1919-03-01', delta: 30 }], 'monthly', '1919-01-01'));
A('A2 单节点 → 沿用该节点金额；无节点 → 金额 0、日期从起始日推；**周期缺失 → 无日期**（推不出就诚实留空）', (() => {
    const one = inferForecastFallback([{ date: '1919-05-01', delta: -12 }], 'quarterly', '1919-01-01');
    const none = inferForecastFallback([], 'weekly', '1919-01-01');
    const noCycle = inferForecastFallback([{ date: '1919-05-01', delta: 5 }], '', '1919-01-01');
    return one.delta === -12 && one.direction === 'decrease' && one.nextDate === '1919-07-30'
        && none.delta === 0 && none.nextDate === '1919-01-08'
        && noCycle.nextDate === '' && noCycle.delta === 5;
})(), 'n/a');

// ---------- B 归一：AI 明确优先；留空兜底 ----------
A('B1 **AI 明确 → 以 AI 为准**：预测日期/金额/来源都原样保留（不被兜底覆盖）', (() => {
    const d = normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { nodes: [{ date: '1919-02-01', delta: 10 }], forecast: { nextDate: '1919-09-09', delta: 999, direction: 'increase', note: 'AI 判断', source: 'ai' } } });
    return d && d.outlook.forecast.nextDate === '1919-09-09' && d.outlook.forecast.delta === 999 && d.outlook.forecast.source === 'ai';
})(), 'n/a');
A('B2 **AI 留空 → 兜底**：按趋势 + 周期补出预测日期与金额（来源记为 auto）', (() => {
    const d = normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { nodes: [{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }], forecast: {} } });
    return d && d.outlook.forecast.nextDate === '1919-03-03' && d.outlook.forecast.delta === 30 && d.outlook.forecast.source === 'auto';
})(), () => normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { nodes: [{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }], forecast: {} } }));
A('B3 连兜底也推不出日期（周期未知 + 无节点/起始日期）→ **拒绝**（没有日期就没有意义）', (() => {
    const noStart = normalizeDeal({ name: 'A', currencyId: 'c1', outlook: { nodes: [], forecast: {} } });
    return noStart === null;
})(), 'n/a');

// ---------- C 轮动后按周期推测下一轮 ----------
A('C1 **轮动 1 轮后**：兑现 → 水位按周期推进到下一轮（AI 未给下一节点也能继续）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [{ date: '1919-01-01', delta: 10 }], forecast: { nextDate: '1919-02-01', delta: 20, direction: 'increase', note: '', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-01-15', curDate: '1919-02-10' });
    const fc = state.deals[0].outlook.forecast;
    return r.fired === 1 && state.ledger.length === 1 && fc.nextDate === '1919-03-03' && Number(fc.delta) === 20;
})(), () => J(state.deals[0].outlook.forecast));
A('C2 预测来源为 **auto** → 兑现后用**新趋势**刷新预测金额（10→20→30 之后：40）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [{ date: '1919-01-01', delta: 20 }], forecast: { nextDate: '1919-02-01', delta: 30, direction: 'increase', note: '', source: 'auto' } } }] });
    runDealTriggers({ prevDate: '1919-01-15', curDate: '1919-02-10' });
    const fc = state.deals[0].outlook.forecast;
    return fc.nextDate === '1919-03-03' && Number(fc.delta) === 40 && fc.source === 'auto';
})(), () => J(state.deals[0].outlook.forecast));
A('C3 **截止日期**之后不兜底：越过 `endDate` → 水位清空（本条结束），不再凭空续期', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', endDate: '1919-02-15', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } } }] });
    runDealTriggers({ prevDate: '1919-01-15', curDate: '1919-06-01' });
    return state.deals[0].outlook.forecast.nextDate === '' && state.ledger.length === 1;
})(), () => J({ fc: state.deals[0].outlook.forecast.nextDate, n: state.ledger.length }));

// ---------- D 结构性节点 ----------
A('D1 `node-<i>-*` 结构性行 → nodes（空日期行忽略；按行号排序；说明截断 80）', (() => {
    const raw = deconstructEntry('deals', {
        name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly',
        'node-1-date': '1919-03-01', 'node-1-delta': '30', 'node-1-note': '第三',
        'node-0-date': '1919-02-01', 'node-0-delta': '20', 'node-0-note': '第二',
        'node-2-date': '', 'node-2-delta': '5', 'node-2-note': '空行',
        forecastNextDate: '1919-04-01', forecastSource: 'ai',
    });
    return raw.outlook.nodes.length === 2 && raw.outlook.nodes[0].date === '1919-02-01' && raw.outlook.nodes[0].delta === 20
        && raw.outlook.nodes[1].date === '1919-03-01' && raw.outlook.nodes[1].note === '第三'
        && raw['node-0-date'] === undefined;
})(), 'n/a');
A('D2 结构性行的金额非法 → **具体报错**（`__error`，保存时如实提示）', (() => {
    const raw = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', 'node-0-date': '1919-02-01', 'node-0-delta': 'abc', 'node-0-note': '', forecastNextDate: '1919-03-01' });
    return String(raw.__error || '').indexOf('第 1 行') >= 0;
})(), 'n/a');
A('D3 旧 `nodesText` 仍兼容（程序化调用 / 历史数据）：行格式与 JSON 都能解析', (() => {
    const line = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '1919-02-01|100|首期', forecastNextDate: '1919-03-01' });
    const json = deconstructEntry('deals', { name: 'A', currencyId: 'c1', startDate: '1919-01-01', nodesText: '[{"date":"1919-02-01","delta":100}]', forecastNextDate: '1919-03-01' });
    return line.outlook.nodes.length === 1 && line.outlook.nodes[0].delta === 100
        && json.outlook.nodes.length === 1 && json.outlook.nodes[0].delta === 100;
})(), 'n/a');

// ---------- E 编辑面板 ----------
A('E1 标签精简：`deals` 字段标签不含长串说明（只留字段名，提示放进 placeholder/hint）', (() => {
    const fs = kindFields('deals');
    const long = fs.filter((f) => String(f.label).length > 14);
    const nodesField = fs.filter((f) => f.key === 'nodes')[0] || {};
    return long.length === 0 && nodesField.type === 'nodeTable' && fs.every((f) => f.key !== 'nodesText');
})(), () => J(kindFields('deals').map((f) => [f.key, f.label])));
A('E2 结构性节点字段不再输出「日期|金额|说明」提示；`flatFor` 提供 nodes 数组（供三列行控件回填）', (() => {
    const item = { id: 'd1', name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { text: '', nodes: [{ date: '1919-02-01', delta: 5, note: 'n' }], forecast: { nextDate: '1919-03-01', delta: 5, direction: 'increase', note: '', source: 'ai' } } };
    const flat = flatFor('deals', item);
    const f = kindFields('deals').filter((x) => x.key === 'nodes')[0] || {};
    return Array.isArray(flat.nodes) && flat.nodes.length === 1 && flat.nodes[0].date === '1919-02-01'
        && String(f.label) === '已发生节点' && String(JSON.stringify(f)).indexOf('日期|金额') < 0;
})(), 'n/a');

// ---------- F 结构性行的 DOM 操作（加一行 / 删一行） ----------
function fakeTable() {
    const rows = [];
    const foot = { inserted: [], insertAdjacentHTML(where, html) { foot.inserted.push(html); } };
    const table = {
        rows: rows,
        querySelectorAll: () => rows,
        querySelector: (sel) => (sel === '.ftt-node-foot' ? foot : null),
        foot: foot,
    };
    return table;
}
A('F1 「＋加一行」→ 新行号 = 最大行号 + 1（稀疏行号安全），HTML 带 node-<i>-* 三个输入', (() => {
    const t = fakeTable();
    t.rows.push({ getAttribute: () => '3' }, { getAttribute: () => '7' });
    const add = { closest: (sel) => (sel === '.ftt-node-table' ? t : (sel === '[data-ftt-node-add]' ? add : null)) };
    const hit = nodeTableClick(add);
    return hit === true && t.foot.inserted.length === 1 && String(t.foot.inserted[0]).indexOf('data-ftt-node-row="8"') >= 0
        && String(t.foot.inserted[0]).indexOf('node-8-date') >= 0 && String(t.foot.inserted[0]).indexOf('node-8-note') >= 0;
})(), 'n/a');
A('F2 「✕」→ 从父节点移除该行；命中返回 true（不再进动作分发）', (() => {
    let removed = null;
    const row = { parentNode: { removeChild(n) { removed = n; } } };
    const del = { closest: (sel) => (sel === '.ftt-node-row' ? row : (sel === '[data-ftt-node-del]' ? del : null)) };
    const hit = nodeTableClick(del);
    return hit === true && removed === row;
})(), 'n/a');
A('F3 非节点表点击 → 返回 false（不影响其它按钮）', (() => {
    return nodeTableClick({ closest: () => null }) === false && nodeTableClick(null) === false;
})(), 'n/a');

// ---------- G v3.51.9：预计收益费用的**多层兜底** ----------
A('G1 **没有任何记录**（无节点）→ 采信记录里的「下一个费用」来轮动（不再一律 0）', (() => {
    const fb = inferForecastFallback([], 'monthly', '1919-01-01', 17);
    return fb.delta === 17 && fb.basis === 'forecast' && fb.nextDate === '1919-01-31' && fb.source === 'auto';
})(), () => inferForecastFallback([], 'monthly', '1919-01-01', 17));
A('G2 分层顺序：`forecast.delta`（AI 明确）→ 节点趋势 → 最后节点 → 无记录采信记录费用 → 都没有则 0', (() => {
    const r1 = resolveForecastDelta({ cycle: 'monthly', startDate: '1919-01-01', outlook: { nodes: [{ date: '1919-01-01', delta: 9 }], forecast: { delta: -8 } } });
    const r2 = resolveForecastDelta({ cycle: 'monthly', startDate: '1919-01-01', outlook: { nodes: [{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }], forecast: {} } });
    const r3 = resolveForecastDelta({ cycle: 'monthly', startDate: '1919-01-01', outlook: { nodes: [{ date: '1919-01-01', delta: 5 }], forecast: {} } });
    const r4 = resolveForecastDelta({ cycle: 'monthly', startDate: '1919-01-01', outlook: { nodes: [], forecast: { delta: 33 } } });
    const r5 = resolveForecastDelta({ cycle: 'monthly', startDate: '1919-01-01', outlook: { nodes: [], forecast: {} } });
    return r1.delta === -8 && r1.basis === 'forecast'
        && r2.delta === 30 && r2.basis === 'trend'
        && r3.delta === 5 && r3.basis === 'last'
        && r4.delta === 33 && r4.basis === 'forecast'
        && r5.delta === 0 && r5.basis === 'none';
})(), 'n/a');
A('G3 触发器：**零记录**（无节点）+ 记录里有周期/日期/费用 → 按费用逐轮记账（不再因为"没历史"而 0 记账）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-01-01', curDate: '1919-04-05' });
    const amounts = state.ledger.map((x) => Number(x.delta));
    return r.fired === 3 && amounts.every((a) => a === 10) && state.deals[0].outlook.nodes.length === 3;
})(), () => J(state.ledger.map((x) => x.delta)));
A('G4 触发器：`forecast.delta` 为 0 但**有历史节点** → 用趋势金额记账（旧实现会 0 记账 = 只推进不记账）', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [{ date: '1919-01-01', delta: 10 }, { date: '1919-02-01', delta: 20 }], forecast: { nextDate: '1919-03-01', delta: 0, direction: '', note: '', source: 'ai' } } }] });
    const r = runDealTriggers({ prevDate: '1919-02-05', curDate: '1919-04-05' });
    return r.fired >= 1 && state.ledger.length === r.fired && Number(state.ledger[0].delta) === 30;
})(), () => J(state.ledger.map((x) => x.delta)));
A('G5 归一：预测留空 + 无节点 + 记录里给了费用 → 兜底把费用带进预测（basis forecast）', (() => {
    const d = normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { nodes: [], forecast: { nextDate: '', delta: 25, direction: '' } } });
    return d && d.outlook.forecast.nextDate === '1919-01-31' && Number(d.outlook.forecast.delta) === 25
        && d.outlook.forecast.source === 'auto';
})(), () => normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1919-01-01', cycle: 'monthly', outlook: { nodes: [], forecast: { nextDate: '', delta: 25 } } }));

// ---------- H v3.51.10：内存核查（节点保留上限 / 账本页渲染上限） ----------
A('H1 节点保留上限：归一后只留最近 `DEAL_NODES_MAX`(240) 条；`lastChangeDate` 取保留段最后一条', (() => {
    const nodes = [];
    for (let i = 0; i < 300; i++) nodes.push({ date: '19' + String(10 + Math.floor(i / 12)).padStart(1, '0') + '-' + String((i % 12) + 1).padStart(2, '0') + '-01', delta: 1 });
    const d = normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1910-01-01', cycle: 'monthly', outlook: { nodes: nodes, forecast: { nextDate: '1930-01-01', delta: 1, direction: 'increase', source: 'ai' } } });
    return DEAL_NODES_MAX === 240 && d.outlook.nodes.length === 240
        && d.lastChangeDate === nodes[nodes.length - 1].date
        && capDealNodes(nodes).length === 240 && capDealNodes(nodes)[239].date === nodes[299].date;
})(), () => normalizeDeal({ name: 'A', currencyId: 'c1', startDate: '1910-01-01', cycle: 'monthly', outlook: { nodes: Array.from({ length: 300 }, (_, i) => ({ date: '1910-01-01', delta: 1 })), forecast: { nextDate: '1930-01-01', delta: 1, source: 'ai' } } }).outlook.nodes.length);
A('H2 触发器长跑：推进 300 个周期 → 节点仍 ≤ 240（不再无限增长），而**账本按权威口径全量记录**', (() => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1900-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1900-02-01', delta: 1, direction: 'increase', note: '', source: 'ai' } } }] });
    // 每次最多 24 轮 → 反复推进（每次跨 26 个月）模拟长跑；累计 > 240 个周期
    cfg.dealCatchUpMax = 24;
    for (let k = 1; k <= 15; k++) {
        const y = 1900 + Math.floor((k * 26) / 12), m = ((k * 26) % 12) + 1;
        runDealTriggers({ prevDate: '', curDate: y + '-' + String(m).padStart(2, '0') + '-15' });
    }
    return state.deals[0].outlook.nodes.length === DEAL_NODES_MAX && state.ledger.length > DEAL_NODES_MAX;
})(), () => J({ nodes: state.deals[0].outlook.nodes.length, ledger: state.ledger.length }));
A('H3 收支记录页：**只渲染最近 200 笔**并标注总条数（合计仍按全量算），避免长跑后 HTML 无限膨胀', (() => {
    boot({ ledger: Array.from({ length: 260 }, (_, i) => ({ id: 'l' + i, currencyId: 'c1', date: '1920-01-' + String((i % 28) + 1).padStart(2, '0'), delta: 1, note: 'n' + i, source: 'manual' })) });
    const html = ledgerPageHtml();
    const rows = (html.match(/data-ftt-ledger="/g) || []).length;
    return rows === 200 && html.indexOf('data-ftt-ledger-more') >= 0
        && html.indexOf('共 <b>260</b> 笔') >= 0 && html.indexOf('笔数</span><b>260</b>') >= 0;
})(), () => { const h = ledgerPageHtml(); return J({ rows: (h.match(/data-ftt-ledger="/g) || []).length }); });

R.done();
