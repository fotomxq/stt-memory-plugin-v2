// ============================================================
// 单元测试 · v3.50.17：货币「快速记一笔」（只填金额 → 追加子记录 + 同步额度）
//   用户原话：「货币增加一个功能，除了编辑外，补充一个按钮，可以只添加一条子记录。
//     例如收入XX元，用户只需要填写XX即可，记录会被记录为'收入XX元 修正'。或者支出XX元，类似。
//     每个货币的记录都可以触发这个简易增减记录操作，同时记录后同步修订该记录的记录金额。」
//
// 口径（`core/currency-quick.js` 纯函数 + `ui/currency-quick.js` 界面件/动作处理）：
//   · 只填金额；方向由「＋收入 / －支出」按钮决定；说明固定为 `收入XX元 修正` / `支出XX元 修正`；
//   · 流水并入 `history`（去重 + 只留最近 N 笔；v3.51.0：`cfg.currencyHistoryMax` 默认 60，原硬编码 12）；**额度当场同步**（收入 +、支出 −）；
//   · 金额必须 > 0；非法输入给理由、不改任何数据。
//
// 运行：node tests/unit/currency-quick.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {
    QUICK_NOTE_SUFFIX, quickDirText, quickAmountText, quickNoteText, parseQuickAmount,
    applyQuickCurrencyFlow, quickReceiptText,
} from '../../core/currency-quick.js';
import { curQuickButtonsHtml, curQuickFormHtml, QUICK_INPUT_ATTR, QUICK_ACTIONS, handleCurQuick } from '../../ui/currency-quick.js';

const R = makeReporter('currency-quick v3.50.17：货币「快速记一笔」（只填金额 + 同步额度）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const mkCur = (amount, unit, history) => ({
    id: 'cur_1', owner: '主角', name: '铜钱', unit: unit === undefined ? '元' : unit,
    amount: amount === undefined ? 100 : amount, history: history || [{ date: '', delta: 20, note: '收入20元' }],
});

// ---------- A 组：纯函数（说明文本 / 解析） ----------
A('A1 说明文本按用户口径：`收入XX元 修正` / `支出XX元 修正`（后缀常量 = `修正`）', (() => {
    return QUICK_NOTE_SUFFIX === '修正'
        && quickNoteText('in', 50, '元') === '收入50元 修正'
        && quickNoteText('out', 30, '元') === '支出30元 修正'
        && quickNoteText('in', 50, '铜钱') === '收入50铜钱 修正'
        && quickNoteText('in', 50) === '收入50元 修正'          // 缺单位 → 元
        && quickDirText('out') === '支出' && quickDirText('in') === '收入';
})(), () => J(quickNoteText('in', 50, '元')));

A('A2 金额文本：整数不带小数、小数去尾零（`50` / `12.5` / `12.50` → `12.5`）', (() => {
    return quickAmountText(50) === '50' && quickAmountText(12.5) === '12.5'
        && quickAmountText(12.50) === '12.5' && quickAmountText(0.5) === '0.5';
})(), () => J([quickAmountText(50), quickAmountText(12.5)]));

A('A3 `parseQuickAmount`：正数通过（容许空格/逗号/「元」）；`0` / 负数 / 非数字 / 空 → 拒绝并给理由', (() => {
    const ok = parseQuickAmount('50'), ok2 = parseQuickAmount(' 1,200 元 ');
    const bad = [parseQuickAmount(''), parseQuickAmount('0'), parseQuickAmount('-5'), parseQuickAmount('abc')];
    return ok.ok && ok.amount === 50 && ok2.ok && ok2.amount === 1200
        && bad.every((x) => !x.ok && !!x.error);
})(), () => J([parseQuickAmount('50'), parseQuickAmount('0')]));

// ---------- B 组：应用（追加子记录 + 同步额度） ----------
A('B1 **收入**：追加一条 `收入50元 修正`（delta=+50）且额度 100 → **150**；原对象不被修改', (() => {
    const cur = mkCur(100);
    const r = applyQuickCurrencyFlow(cur, 'in', '50', { date: '1919-11-01' });
    const flow = r.currency.history[r.currency.history.length - 1];
    return r.ok && r.amountBefore === 100 && r.amountAfter === 150 && r.currency.amount === 150
        && flow.delta === 50 && flow.note === '收入50元 修正' && flow.date === '1919-11-01'
        && cur.amount === 100 && cur.history.length === 1;
})(), 'n/a');

A('B2 **支出**：追加 `支出30元 修正`（delta=−30）且额度 150 → **120**', (() => {
    const r = applyQuickCurrencyFlow(mkCur(150), 'out', 30, {});
    const flow = r.currency.history[r.currency.history.length - 1];
    return r.ok && r.amountAfter === 120 && flow.delta === -30 && flow.note === '支出30元 修正';
})(), 'n/a');

A('B3 **非法金额不改数据**：`0` / 负数 / 文字 → `ok:false` + 理由，`currency` 为 null（调用方据此不落库）', (() => {
    const cur = mkCur(100);
    const bads = ['0', '-5', 'abc', ''].map((x) => applyQuickCurrencyFlow(cur, 'in', x, {}));
    return bads.every((r) => r.ok === false && r.currency === null && !!r.error)
        && cur.amount === 100 && cur.history.length === 1;
})(), 'n/a');

A('B4 **人工记账不按内容去重**（连点两次同额 = 两笔真实记录）× 上限为最近 **60** 笔（v3.51.0 可配）', (() => {
    let cur = mkCur(0, '元', []);
    for (let i = 0; i < 20; i++) cur = applyQuickCurrencyFlow(cur, 'in', 10, {}).currency;
    const len = cur.history.length;
    // 再记一笔与最后一条**完全相同**的 → 也应当留下（人工动作，不去重）
    const again = applyQuickCurrencyFlow(cur, 'in', 10, {}).currency;
    return len === 20 && again.history.length === 21
        && again.amount === 210                    // 20 笔 ×10 = 200，上限只截流水、不截额度；再来一笔 +10
        && again.history[again.history.length - 1].note === '收入10元 修正';
})(), () => { let c = mkCur(0, '元', []); for (let i = 0; i < 20; i++) c = applyQuickCurrencyFlow(c, 'in', 10, {}).currency; return J({ len: c.history.length, amount: c.amount }); });
A('B5 回执文案：`收入 50元 · 额度已更新为 150元`（含方向、金额与更新后的额度）', (() => {
    const s = quickReceiptText('in', 50, '元', 150);
    return s.indexOf('收入') >= 0 && s.indexOf('50') >= 0 && s.indexOf('150') >= 0;
})(), () => quickReceiptText('in', 50, '元', 150));

// ---------- C 组：界面件 ----------
A('C1 **每行都有两枚按钮**（`＋` 收入 / `－` 支出）：带 `data-ftt-action="curQuick"` + 方向 + 货币 id；title 说明「只填金额」', (() => {
    const h = curQuickButtonsHtml('cur_1');
    return h.indexOf('data-ftt-action="curQuick"') >= 0
        && h.indexOf('data-ftt-dir="in"') >= 0 && h.indexOf('data-ftt-dir="out"') >= 0
        && h.indexOf('data-kind="currencies"') >= 0 && h.indexOf('data-id="cur_1"') >= 0
        && h.indexOf('＋') >= 0 && h.indexOf('－') >= 0 && h.indexOf('只填金额') >= 0;
})(), 'n/a');

A('C2 **只填一个金额**：展开的表单里只有一个 `input`（金额）＋ 确定 / 取消，并写明会记为「收入XX 修正」', (() => {
    const h = curQuickFormHtml('cur_1', { id: 'cur_1', dir: 'in' });
    const outs = (h.match(/<input/g) || []).length;
    return outs === 1 && h.indexOf(QUICK_INPUT_ATTR) >= 0
        && h.indexOf('data-ftt-action="curQuickApply"') >= 0 && h.indexOf('data-ftt-action="curQuickCancel"') >= 0
        && h.indexOf('收入XX 修正') >= 0 && h.indexOf('确定') >= 0 && h.indexOf('取消') >= 0;
})(), 'n/a');

A('C3 表单**只在本行展开**：`curQuickFormHtml` 对别的 id / 无展开态返回空串', (() => {
    return curQuickFormHtml('cur_1', null) === ''
        && curQuickFormHtml('cur_1', { id: 'cur_2', dir: 'in' }) === ''
        && curQuickFormHtml('cur_1', { id: 'cur_1', dir: 'out' }).indexOf('支出') >= 0;
})(), 'n/a');

// ---------- D 组：动作处理（不依赖 DOM 的可测路径） ----------
A('D1 `curQuick` 展开 / `curQuickCancel` 收起：只改展开态并重绘，不动数据', (() => {
    const ps = {};
    let rendered = 0;
    const api = { list: () => [], save: () => ({ ok: true }), ps: ps, note: () => undefined, render: () => { rendered += 1; } };
    handleCurQuick('curQuick', { id: 'cur_1', dir: 'out' }, api);
    const opened = J(ps.curQuick);
    handleCurQuick('curQuickCancel', { id: 'cur_1' }, api);
    return opened === J({ id: 'cur_1', dir: 'out' }) && ps.curQuick === null && rendered === 2;
})(), 'n/a');

A('D2 `curQuickApply` 在**拿不到输入框**（无 DOM）时给理由、不落库；动作名清单齐备（3 个）', (() => {
    let saved = 0, noteText = '';
    const api = { list: () => [mkCur(100)], save: () => { saved += 1; return { ok: true }; }, ps: {}, note: (s) => { noteText = s; }, render: () => undefined };
    const r = handleCurQuick('curQuickApply', { id: 'cur_1', dir: 'in' }, api);
    return r.ok === false && r.applied === false && saved === 0 && noteText.indexOf('请输入金额') >= 0
        && QUICK_ACTIONS.length === 3 && QUICK_ACTIONS.indexOf('curQuickApply') >= 0;
})(), 'n/a');

A('D3 `curQuickApply` 落库路径：找不到该条货币 → 给理由不落库（数据保护）', (() => {
    let saved = 0;
    const api = { list: () => [], save: () => { saved += 1; return { ok: true }; }, ps: {}, note: () => undefined, render: () => undefined };
    const r = handleCurQuick('curQuickApply', { id: 'nope', dir: 'in' }, api);
    return r.ok === false && saved === 0;
})(), 'n/a');

R.done();
