// ============================================================
// 单元测试 · v3.50.21：货币流水的**形状兼容**（用户报告「快速记账后记录全被清空」）
//
// 根因（本轮实测）：
//   `core/model/money.js#normalizeMoneyFlow` 只认 **AI 抽取形态** `{增减, 数额, 说明, 日期}`；
//   而「快速记一笔」（v3.50.17）写的是 **已归一形态** `{date, delta, note}`（`moneyNet` / `mergeMoneyHistory` 也是这个）
//   → `Number(undefined)` = NaN → 该笔判 null → `normalizeMoneyHistory` 丢掉**整段** → 保存即清空。
//
// 本测试锁两件事：
//   ① 两种形态都能被归一化（不再丢）；② 万一将来又出现「一条都认不出」的输入，**抢救**而不是清空。
//
// 运行：node tests/unit/money-flow-shape.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { normalizeCurrency, normalizeMoneyHistory, moneyNet } from '../../core/model/money.js';
import { applyQuickCurrencyFlow } from '../../core/currency-quick.js';
import { consoleSave } from '../../ui/console.js';

const R = makeReporter('money-flow-shape v3.50.21：货币流水两种形态兼容（修复「记录被清空」）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('flow21'); setLastMessageId(1);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });

// ---------- A 组：两种形态都能归一 ----------
A('A1 **已归一形态**（`{date, delta, note}`）不再被丢弃：正负号与说明原样保留', (() => {
    const out = normalizeMoneyHistory([
        { date: '1919-11-01', delta: 50, note: '收入50元 修正' },
        { date: '', delta: -30, note: '支出30元 修正' },
    ]);
    return out.length === 2 && out[0].delta === 50 && out[1].delta === -30
        && out[0].note === '收入50元 修正' && out[0].date === '1919-11-01';
})(), () => J(normalizeMoneyHistory([{ date: '', delta: 50, note: 'x' }])));

A('A2 **AI 抽取形态**（`{增减, 数额, 说明, 日期}`）仍按原口径（回归保护）', (() => {
    const out = normalizeMoneyHistory([
        { 增减: '收入', 数额: 20, 说明: '卖鱼', 日期: '1919-11-02' },
        { 增减: '支出', 数额: 3, 说明: '买酒' },
    ]);
    return out.length === 2 && out[0].delta === 20 && out[1].delta === -3 && out[1].note === '买酒';
})(), () => J(normalizeMoneyHistory([{ 增减: '支出', 数额: 3, 说明: 'x' }])));

A('A3 混合形态（两种混在一起）都能留下：顺序与符号正确，`moneyNet` 合计对得上', (() => {
    const out = normalizeMoneyHistory([
        { date: '', delta: 100, note: '旧形态' },
        { 增减: '支出', 数额: 40, 说明: '抽取形态' },
        { date: '', delta: -10, note: '再一笔' },
    ]);
    return out.length === 3 && moneyNet(out) === 50;
})(), () => J({ n: normalizeMoneyHistory([{ '增减': '收入', '数额': 1 }, { 'delta': 2 }]).length }));

// ---------- B 组：快速记账 → 归一 → 保存 整链不丢 ----------
A('B1 **快速记账的流水能过归一化**：`applyQuickCurrencyFlow` → `normalizeCurrency` 后条数不减、末笔正确', (() => {
    const cur = { id: 'cur_a', owner: '主角', name: '铜钱', unit: '元', amount: 100, history: [{ date: '', delta: 20, note: '收入20元' }] };
    const r = applyQuickCurrencyFlow(cur, 'in', 50, { date: '1919-11-01' });
    const n = normalizeCurrency(r.currency);
    const last = n.history[n.history.length - 1];
    return n.amount === 150 && n.history.length === 2 && last.delta === 50 && last.note === '收入50元 修正';
})(), 'n/a');

A('B2 **落库不丢**（本轮 bug 的端到端）：`consoleSave` 之后该条额度正确、流水条数不变', (() => {
    const st = emptyState();
    st.currencies = [{ id: 'cur_a', owner: '主角', name: '铜钱', unit: '元', amount: 100, history: [{ date: '', delta: 20, note: '收入20元' }], note: '' }];
    setKernelState(st);
    const r = applyQuickCurrencyFlow(state.currencies[0], 'out', 30, {});
    const saved = consoleSave('currencies', 'cur_a', r.currency);
    const got = (state.currencies || []).filter((x) => x.id === 'cur_a')[0] || {};
    return saved.ok === true && got.amount === 70 && Array.isArray(got.history)
        && got.history.length === 2 && got.history[1].delta === -30;
})(), 'n/a');

// ---------- C 组：抢救（绝不静默清空） ----------
A('C1 **抢救**：输入非空但一条都「认不出」时，按最小形态保留（不返回空数组）', (() => {
    // 只有 amount 没有 delta/数额 → 旧实现会全文丢弃；现在有 amount 就该被救回
    const out = normalizeMoneyHistory([{ amount: 12 }]);
    return out.length === 1 && out[0].delta === 12;
})(), () => J(normalizeMoneyHistory([{ amount: 12 }])));

A('C2 完全相同语义的两笔不合并（人工记账是两笔）：条数如实', (() => {
    const out = normalizeMoneyHistory([
        { date: '', delta: 10, note: '收入10元 修正' },
        { date: '', delta: 10, note: '收入10元 修正' },
    ]);
    return out.length === 2;
})(), 'n/a');

A('C3 上限仍是最近 12 笔（不因抢救而膨胀），且 `normalizeCurrency` 全字段齐备', (() => {
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ date: '', delta: 1, note: '第' + i + '笔' });
    const n = normalizeCurrency({ name: '铜钱', amount: 20, history: many });
    return n.history.length === 12 && n.history[11].note === '第19笔' && n.amount === 20 && n.name === '铜钱';
})(), 'n/a');

R.done();
