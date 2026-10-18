// ============================================================
// core/currency-quick.js —— **货币「快速记一笔」**（v3.50.17，用户要求）
//
// 用户原话：「货币增加一个功能，除了编辑外，补充一个按钮，可以只添加一条子记录。
//   例如收入XX元，用户只需要填写XX即可，记录会被记录为'收入XX元 修正'。或者支出XX元，类似。
//   每个货币的记录都可以触发这个简易增减记录操作，同时记录后同步修订该记录的记录金额。」
//
// 口径（纯函数，无宿主/DOM/定时器）：
//   · 只填**金额**（正数）→ 生成一条收支流水 `{date, delta:±金额, note:'收入XX元 修正' / '支出XX元 修正'}`；
//   · 流水并入既有 `history`（复用 `mergeMoneyHistory`：同内容去重 + 只留最近 12 笔）；
//   · **同步修订该记录的额度**：`amount = roundMoney(amount + delta)`（收入 +、支出 −）；
//   · 金额必须 > 0 且为有限数（填 0 / 负数 / 非数字一律拒绝并给理由 —— 方向由按钮决定，不由符号决定）。
// ============================================================
import { formatMoney, roundMoney } from './model/money.js';

/** 快速记账的说明后缀（用户指定口径：`收入XX元 修正`） */
export const QUICK_NOTE_SUFFIX = '修正';
/** 方向枚举（`in` = 收入 / `out` = 支出） */
export const QUICK_DIRS = Object.freeze(['in', 'out']);

/** 方向中文 */
export function quickDirText(dir) {
    return String(dir) === 'out' ? '支出' : '收入';
}

/**
 * 金额文本（去掉无意义的小数零；与 `formatMoney` 同口径但不做 万/亿 缩写 ——
 *   流水说明里要写**原始数字**，缩写会让「收入 1.2万 修正」看不懂是多少）。
 * @param {number} n
 * @returns {string}
 */
export function quickAmountText(n) {
    const v = roundMoney(Number(n) || 0);
    return String(v).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 流水说明：`收入XX元 修正` / `支出XX元 修正`（单位取该条货币的 `unit`，缺省 `元`）。
 * @param {'in'|'out'} dir
 * @param {number} amount
 * @param {string} [unit]
 * @returns {string}
 */
export function quickNoteText(dir, amount, unit) {
    const u = String(unit == null ? '' : unit) || '元';
    return quickDirText(dir) + quickAmountText(amount) + u + ' ' + QUICK_NOTE_SUFFIX;
}

/**
 * 解析用户填的金额（只接受正数；空白/非数字/≤0 → `null` + 理由）。
 * @param {*} raw
 * @returns {{ok:boolean, amount:number, error:string}}
 */
export function parseQuickAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[,，\s元圆块]/g, '');
    if (!s) return { ok: false, amount: 0, error: '请输入金额' };
    if (!/^[+]?\d+(?:\.\d+)?$/.test(s)) return { ok: false, amount: 0, error: '金额必须是正数（方向由「收入/支出」按钮决定）' };
    const n = roundMoney(Number(s));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, amount: 0, error: '金额必须大于 0' };
    return { ok: true, amount: n, error: '' };
}

/**
 * **把一条快速记录并入流水**（**不按内容去重**）。
 *
 * 与 `core/model/money.js#mergeMoneyHistory` 的差别（有意为之）：后者给 **AI 抽取** 用 ——
 *   同一份正文重复抽取应当去重；而这里是人**手动点两次同额**，那是**两笔真实记录**，必须都留下。
 *   上限仍沿用「最近 12 笔」（与既有口径一致，防条目无限膨胀）。
 * @param {Array} history 既有流水
 * @param {{date:string,delta:number,note:string}} flow 新流水
 * @returns {Array}
 */
export function appendQuickFlow(history, flow) {
    const arr = Array.isArray(history) ? history.slice() : [];
    if (flow) arr.push({ date: String(flow.date || ''), delta: Number(flow.delta) || 0, note: String(flow.note || '') });
    return arr.slice(-12);
}

/**
 * **应用一条快速记录**（不 mutate 入参；返回新的货币对象）。
 *
 * @param {object} cur 货币记录（`{amount, unit, history, ...}`）
 * @param {'in'|'out'} dir 方向
 * @param {*} amountRaw 用户填的金额（原始文本或数字）
 * @param {{date?:string, now?:number}} [opts] `date` = 流水日期（缺省空串，与 AI 抽取的流水同口径）
 * @returns {{ok:boolean, currency:object|null, flow:object|null, amountBefore:number, amountAfter:number, error:string}}
 */
export function applyQuickCurrencyFlow(cur, dir, amountRaw, opts) {
    const c = (cur && typeof cur === 'object') ? cur : null;
    const d = String(dir) === 'out' ? 'out' : 'in';
    const parsed = parseQuickAmount(amountRaw);
    if (!c) return { ok: false, currency: null, flow: null, amountBefore: 0, amountAfter: 0, error: '找不到这条货币记录' };
    if (!parsed.ok) return { ok: false, currency: null, flow: null, amountBefore: Number(c.amount) || 0, amountAfter: Number(c.amount) || 0, error: parsed.error };
    const amountBefore = roundMoney(Number(c.amount) || 0);
    const delta = d === 'out' ? -parsed.amount : parsed.amount;
    const flow = {
        date: String((opts && opts.date) || ''),
        delta: delta,
        note: quickNoteText(d, parsed.amount, c.unit),
    };
    const history = appendQuickFlow(c.history, flow);
    const amountAfter = roundMoney(amountBefore + delta);
    const currency = Object.assign({}, c, { amount: amountAfter, history: history });
    return { ok: true, currency: currency, flow: flow, amountBefore: amountBefore, amountAfter: amountAfter, error: '' };
}

/** 供 UI 展示的一句话回执（`收入 50元 → 额度 1,250 元`） */
export function quickReceiptText(dir, amount, unit, amountAfter) {
    const u = String(unit == null ? '' : unit) || '元';
    return quickDirText(dir) + ' ' + quickAmountText(amount) + u + ' · 额度已更新为 ' + formatMoney(amountAfter) + u;
}
