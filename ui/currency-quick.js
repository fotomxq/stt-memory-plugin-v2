// ============================================================
// ui/currency-quick.js —— **货币「快速记一笔」的界面件**（v3.50.17，用户要求）
//
// 用户原话：「货币增加一个功能，除了编辑外，补充一个按钮，可以只添加一条子记录。
//   例如收入XX元，用户只需要填写XX即可，记录会被记录为'收入XX元 修正'。或者支出XX元，类似。
//   每个货币的记录都可以触发这个简易增减记录操作，同时记录后同步修订该记录的记录金额。」
//
// 交互（**只填一个数字**，不用打开编辑器）：
//   ① 每行货币的操作区多两枚小按钮：`＋` 收入 / `－` 支出（`data-ftt-action="curQuick"`）；
//   ② 点其中一枚 → 该行**就地**展开一个只有「金额」输入框 + 确定/取消的小表单（不弹模态框）；
//   ③ 点「确定」→ `ui/panel.js` 调 `core/currency-quick.js#applyQuickCurrencyFlow`：
//      追加流水（`收入XX元 修正` / `支出XX元 修正`）+ **同步改额度**，然后重绘并给一句回执。
//
// 为什么单独成模块（`docs/05` §5 C11 + 体量棘轮）：`ui/panel.js` 已贴上限，界面件整体落这里，
//   面板只加「两处渲染调用 + 两个动作分支」。
// 降级：拿不到 DOM 时不报错（表单不展开也不影响其它交互）。
// ============================================================
import { QUICK_DIRS, quickDirText, parseQuickAmount, applyQuickCurrencyFlow, quickReceiptText } from '../core/currency-quick.js';
// v3.50.20（用户报告）：行内小表单展开期间**暂停滑动/拖动展开**，否则行内容左移、表单跟着走，输入框无法编辑
import { setSwipeSuspended } from './swipe-rows.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');

/** 表单输入的属性名（渲染层写、动作层读；`panel-audit` L5 要求有真实读者） */
export const QUICK_INPUT_ATTR = 'data-ftt-quick-amount';

/** 两枚「快速记一笔」按钮（收入 / 支出）—— 与「✏️ 编辑」并列，**不替代**它 */
export function curQuickButtonsHtml(id) {
    const i = attr(id);
    const mk = (dir, label, title) => '<button class="ftt-btn ftt-sm" data-ftt-action="curQuick" data-ftt-dir="' + dir
        + '" data-kind="currencies" data-id="' + i + '" title="' + title + '">' + label + '</button>';
    return mk('in', '＋', '快速记一笔收入（只填金额，记为「收入XX元 修正」并同步额度）')
        + mk('out', '－', '快速记一笔支出（只填金额，记为「支出XX元 修正」并同步额度）');
}

/**
 * 行内展开的小表单（只在 `ps.curQuick` 指向本行时渲染）。
 * @param {string} id 货币 id
 * @param {{id:string, dir:string}|null} open 当前展开态（`ui/panel.js#ps.curQuick`）
 * @returns {string} 空串 = 不展开
 */
export function curQuickFormHtml(id, open) {
    if (!open || String(open.id) !== String(id)) return '';
    const dir = QUICK_DIRS.indexOf(String(open.dir)) >= 0 ? String(open.dir) : 'in';
    return '<div class="ftt-row ftt-curquick ftt-w-full">'
        + '<b class="ftt-' + (dir === 'out' ? 'warn' : 'ok') + '">' + quickDirText(dir) + '</b>'
        + '<span class="ftt-muted">金额</span>'
        + '<input type="text" inputmode="decimal" class="ftt-input-sm ftt-curquick-amount" ' + QUICK_INPUT_ATTR + '="1"'
        + ' value="" placeholder="只填数字，如 50" autocomplete="off" title="只填金额；方向由「＋收入 / －支出」决定">'
        + '<button class="ftt-btn ftt-sm ftt-ok" data-ftt-action="curQuickApply" data-ftt-dir="' + dir
        + '" data-kind="currencies" data-id="' + attr(id) + '" title="确定（记为 ' + quickDirText(dir) + 'XX 修正，并同步额度）">确定</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="curQuickCancel" data-kind="currencies" data-id="' + attr(id) + '" title="取消">取消</button>'
        + '<span class="ftt-muted">会记为「' + quickDirText(dir) + 'XX 修正」并同步该条额度</span>'
        + '</div>';
}

/** 读行内输入框的值（优先事件目标所在的表单，其次调用方给的 node） */
export function readQuickAmountFrom(node) {
    try {
        const box = node && typeof node.querySelector === 'function' ? node.querySelector('[' + QUICK_INPUT_ATTR + ']') : null;
        if (box) return String(box.value == null ? '' : box.value);
    } catch (e) { /* 忽略：DOM 能力缺失 */ }
    return '';
}

/** 校验并给出「可提交 / 不可提交 + 理由」（供动作层在提交前提示，不重复写解析逻辑） */
export function checkQuickAmount(raw) {
    return parseQuickAmount(raw);
}

/** 面板动作名（动作层与测试共用，避免字符串漂移） */
export const QUICK_ACTIONS = Object.freeze(['curQuick', 'curQuickApply', 'curQuickCancel']);

/**
 * **动作处理**（`ui/panel.js` 只留一行调用）：`curQuick` 展开表单 / `curQuickCancel` 收起 / `curQuickApply` 应用。
 *
 * @param {string} a 动作名（`QUICK_ACTIONS` 之一）
 * @param {object} p 动作入参（`{kind, id, dir}`）
 * @param {{list:()=>Array, save:(kind:string,id:string,raw:object)=>object, ps:object, note:(s:string)=>void, render:()=>void}} api
 * @returns {{ok:boolean, applied:boolean, note:string}}
 */
export function handleCurQuick(a, p, api) {
    const act = String(a == null ? '' : a);
    const id = String((p && p.id) || '');
    const dir = QUICK_DIRS.indexOf(String((p && p.dir) || '')) >= 0 ? String(p.dir) : 'in';
    const ps = (api && api.ps) || {};
    const note = (s) => { try { if (api && typeof api.note === 'function') api.note(String(s)); } catch (e) { /* 忽略 */ } };
    const render = () => { try { if (api && typeof api.render === 'function') api.render(); } catch (e) { /* 忽略 */ } };
    if (act === 'curQuick') {
        try { setSwipeSuspended(true); } catch (e) { /* 忽略：滑动模块不可用也不影响记账 */ }
        ps.curQuick = id ? { id: id, dir: dir } : null;
        render();
        return { ok: true, applied: false, note: '' };
    }
    if (act === 'curQuickCancel') {
        try { setSwipeSuspended(false); } catch (e) { /* 忽略 */ }
        ps.curQuick = null;
        render();
        return { ok: true, applied: false, note: '' };
    }
    // curQuickApply：读行内输入框 → 应用 → 落库 → 收起表单 → 重绘
    const raw = (function () {
        try {
            const w = (typeof globalThis !== 'undefined') ? globalThis : null;
            const doc = w && w.document;
            const box = doc && typeof doc.querySelector === 'function' ? doc.querySelector('#ftt-panel [' + QUICK_INPUT_ATTR + ']') : null;
            if (box) return String(box.value == null ? '' : box.value);
        } catch (e) { /* 忽略：拿不到 DOM 时按空值处理（会提示「请输入金额」） */ }
        return '';
    })();
    const checked = parseQuickAmount(raw);
    if (!checked.ok) {
        try { setSwipeSuspended(false); } catch (e) { /* 忽略 */ }
        note(checked.error);
        return { ok: false, applied: false, note: checked.error };
    }
    const list = (api && typeof api.list === 'function') ? (api.list() || []) : [];
    const cur = list.filter((x) => x && String(x.id) === id)[0] || null;
    const r = applyQuickCurrencyFlow(cur, dir, checked.amount, {});
    if (!r.ok) { note(r.error); return { ok: false, applied: false, note: r.error }; }
    let saved = { ok: false };
    try { saved = (api && typeof api.save === 'function') ? api.save('currencies', id, r.currency) : { ok: false }; } catch (e) { saved = { ok: false }; }
    if (!saved || saved.ok === false) { note('记录失败：' + String((saved && saved.reason) || '保存通道不可用')); return { ok: false, applied: false, note: '记录失败' }; }
    try { setSwipeSuspended(false); } catch (e) { /* 忽略 */ }   // v3.50.20：记账完成 → 恢复滑动
    ps.curQuick = null;
    const msg = quickReceiptText(dir, checked.amount, (cur && cur.unit) || '元', r.amountAfter) + '（流水已记「' + r.flow.note + '」）';
    note(msg);
    render();
    return { ok: true, applied: true, note: msg };
}
