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
import { inferForecastFallback, normalizeDeal } from '../../core/model/deal.js';
import { runDealTriggers } from '../../core/deal-triggers.js';
import { kindFields, deconstructEntry } from '../../ui/fields.js';
import { flatFor } from '../../ui/entry-flat.js';
import { nodeTableClick } from '../../ui/node-table-dom.js';

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

R.done();
