// ============================================================
// ui/money-tabs.js —— **货币三子页**（v3.51.0，`docs/D53` §3.1 / `docs/D22` W32 `应-46` / `应-47`）
//
// 用户要求（原话）：「货币拆分子页，当前页作为货币总览。额外增加**收支记录**，类似记账；**长期收支**，用于记录标的物的长期收支。」
//
// 口径（`docs/D53` §3.1）：
//   · **① 货币总览** = 当前货币页，**行为与文案一字不改**（由 `ui/panel.js` 原样渲染后传进来）；
//   · **② 收支记录** = `ledger` 明细 + 合计（只增不删；删除走危险动作二次确认）；
//   · **③ 长期收支** = `deals` 列表 + 详情（**已发生节点**与**预测**分区块呈现 + 触发器状态）；
//   · 三子页是**页内子标签**，不新增面板分页（`PANEL_TABS` 不变）。
//
// 「预测 ≠ 事实」三处护栏的界面一处：详情里「已发生（节点）」与「预测（下一节点）」**分区**，预测区标来源（AI/手动）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import { formatMoney } from '../core/model/money.js';
import { ledgerList, currencyHistoryMaxOf } from '../core/model/ledger.js';
import { dealList } from '../core/model/deal.js';

const esc = (v) => { try { return escHtml(v); } catch (e) { return String(v == null ? '' : v); } };
const str0 = (v) => String(v == null ? '' : v);
const cut = (v, n) => { const s = str0(v); return s.length > n ? (s.slice(0, n - 1) + '…') : s; };

let moneySub = 'overview';                       // 页内子标签状态（overview / ledger / deals）
/** 当前子页 */
export function moneySubState() { return moneySub; }
/** 切换子页 */
export function setMoneySub(sub) {
    const s = String(sub || '');
    moneySub = (s === 'ledger' || s === 'deals') ? s : 'overview';
    return moneySub;
}

const SOURCE_TEXT = { manual: '手动', quick: '快速记账', ai: 'AI', deal: '长期收支', repair: '修复', migrate: '迁移回填' };

/** 一行流水 */
function ledgerRowHtml(x) {
    if (!x) return '';
    const cur = (Array.isArray(state.currencies) ? state.currencies : []).filter((c) => c && String(c.id) === String(x.currencyId))[0] || null;
    const who = cur ? (str0(cur.owner) + '·' + str0(cur.name)) : ('（货币已失效）' + str0(x.currencyId));
    const dir = Number(x.delta) >= 0 ? '收入' : '支出';
    return '<div class="ftt-row" data-ftt-ledger="' + esc(x.id) + '">'
        + '<div class="ftt-main"><div class="ftt-title-row"><b>' + esc(str0(x.date) || '—') + '</b> · ' + esc(who)
        + ' · ' + esc(dir) + ' <b>' + esc(formatMoney(Math.abs(Number(x.delta) || 0))) + '</b>'
        + (x.note ? (' · ' + esc(cut(x.note, 40))) : '') + '</div>'
        + '<div class="ftt-sub">来源：' + esc(SOURCE_TEXT[str0(x.source)] || str0(x.source) || '手动')
        + (x.dealId ? (' · 标的物 ' + esc(str0(x.dealId))) : '') + '</div></div>'
        + '<div class="ftt-actions"><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="ledger" data-id="' + esc(x.id) + '" title="删除这笔流水（会反向冲正余额；留删除记录，跨端不复活）">🗑</button></div>'
        + '</div>';
}

/** 收支记录子页 */
export function ledgerPageHtml() {
    const all = ledgerList().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const sum = all.reduce((s, x) => s + (Number(x.delta) || 0), 0);
    const head = '<div class="ftt-row"><div class="ftt-sub">账本共 <b>' + all.length + '</b> 笔 · 净额 <b>' + esc(formatMoney(sum))
        + '</b> · 条目内摘要上限 <b>' + esc(currencyHistoryMaxOf()) + '</b> 笔（可在设定 → 基础调整）'
        + ' · 记账**必须挂在一条现存货币**上（否则拒绝，不会自动新建货币）</div></div>';
    if (!all.length) {
        return head + '<div class="ftt-empty" data-ftt-ledger-empty>还没有收支记录。<br>点上方「＋记一笔」新建一笔（先选择它属于哪条货币），或从「货币总览」的货币记录开始记账。</div>'
            + addBtns();
    }
    return head + '<div class="ftt-row">' + addBtns() + '</div>' + all.map(ledgerRowHtml).join('');
}
function addBtns() {
    return '<button class="ftt-btn ftt-sm" data-ftt-action="add" data-kind="ledger" title="新建一笔收支（必须先选择货币；金额正数=收入、负数=支出）">＋记一笔</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="add" data-kind="deals" title="新建一条长期收支（标的物 + 锚定货币 + 预测节点）">＋新建标的物</button>';
}

/** 长期收支：详情（已发生 / 预测 分区 + 触发器状态） */
export function dealDetailHtml(d) {
    if (!d) return '';
    const ol = d.outlook || {};
    const fc = ol.forecast || {};
    const nodes = Array.isArray(ol.nodes) ? ol.nodes : [];
    const cur = (Array.isArray(state.currencies) ? state.currencies : []).filter((c) => c && String(c.id) === String(d.currencyId))[0] || null;
    const curTxt = cur ? (str0(cur.owner) + '·' + str0(cur.name)) : '（锚定货币已失效 → 触发器停摆）';
    const trig = d.trigger || {};
    const trigErr = str0(trig.skippedReason) === 'currency-missing';
    const nodesHtml = nodes.length
        ? nodes.map((n) => '<div class="ftt-sub">· ' + esc(str0(n.date)) + (Number(n.delta) ? (' ' + (Number(n.delta) > 0 ? '＋' : '−') + esc(formatMoney(Math.abs(Number(n.delta))))) : '') + (n.note ? (' · ' + esc(cut(n.note, 40))) : '') + '</div>').join('')
        : '<div class="ftt-sub">（还没有已发生的变动节点）</div>';
    const fcHtml = fc.nextDate
        ? ('<div class="ftt-sub" data-ftt-forecast>**预测**（' + esc(fc.source === 'manual' ? '手动' : 'AI 建议') + '）· 下一节点 <b>'
            + esc(str0(fc.nextDate)) + '</b> · ' + esc(str0(fc.direction) === 'decrease' ? '减少' : (str0(fc.direction) === 'increase' ? '增加' : '方向未定'))
            + (Number(fc.delta) ? (' <b>' + esc(formatMoney(Math.abs(Number(fc.delta)))) + '</b>') : '')
            + (fc.note ? (' · ' + esc(cut(fc.note, 40))) : '') + '</div>')
        : '<div class="ftt-sub">（尚未给出下一节点的预测日期）</div>';
    return '<div class="ftt-row" data-ftt-deal="' + esc(d.id) + '"><div class="ftt-main">'
        + '<div class="ftt-title-row"><b>' + esc(str0(d.name)) + '</b> <span class="ftt-sub">' + esc(str0(d.kind)) + (d.cycle ? (' · 周期 ' + esc(str0(d.cycle))) : ' · 周期未知') + '</span></div>'
        + (d.desc ? ('<div class="ftt-sub">约定：' + esc(cut(d.desc, 120)) + '</div>') : '')
        + '<div class="ftt-sub">初始日期 ' + esc(str0(d.startDate) || '—') + ' · 最后变动 ' + esc(str0(d.lastChangeDate) || '—') + ' · 截止 ' + esc(str0(d.endDate) || '无固定期') + '</div>'
        + '<div class="ftt-sub">锚定货币：' + esc(curTxt) + (d.status ? (' · 现状：' + esc(cut(d.status, 80))) : '') + '</div>'
        + '<div class="ftt-sub"><b>前景预判</b>' + (ol.text ? ('：' + esc(cut(ol.text, 120))) : '') + '</div>'
        + '<div class="ftt-sub">**已发生（节点）**</div>' + nodesHtml + fcHtml
        + '<div class="ftt-sub">触发器：' + (trigErr ? '**停摆**（锚定货币已失效，不生成流水）'
            : (str0(trig.lastFiredDate) ? ('上次处置 ' + esc(str0(trig.lastFiredDate)) + (trig.lastFiredNodeDate ? (' · 兑现节点 ' + esc(str0(trig.lastFiredNodeDate))) : '')) : '尚未处置'))
        + (trig.catchUpTruncated ? ' · **补齐被上限截断**（尚有周期未补齐）' : '') + '</div>'
        + '</div><div class="ftt-actions"><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="deals" data-id="' + esc(d.id) + '" title="删除这条长期收支（不删其它数据）">🗑</button></div></div>';
}

/** 长期收支子页 */
export function dealsPageHtml() {
    const all = dealList();
    const head = '<div class="ftt-row"><div class="ftt-sub">共 <b>' + all.length + '</b> 条标的物 · 触发器在「总览自动分析完成」后**确定性**执行（**不经 AI**）；'
        + '锚定货币丢失则**不生成**流水（详见详情里的触发器状态）</div>' + addBtns() + '</div>';
    if (!all.length) return head + '<div class="ftt-empty" data-ftt-deals-empty>还没有长期收支。<br>点「＋新建标的物」：填标的物名称、锚定货币、起始日期，以及**预测节点**（下一节点的日期 + 预计金额与方向）。</div>';
    return head + all.map((d) => dealDetailHtml(d)).join('');
}

/**
 * 货币页整体（三子标签 + 当前子页）。
 * @param {string} overviewHtml **总览**的 HTML（由 `ui/panel.js` 原样渲染 → 保证「总览一字不改」）
 */
export function moneyPageHtml(overviewHtml) {
    const cur = moneySub;
    const nL = ledgerList().length, nD = dealList().length;
    const tab = (key, label) => '<a href="javascript:void(0)" class="ftt-subtab' + (cur === key ? ' ftt-on' : '')
        + '" data-ftt-action="moneySub" data-sub="' + key + '">' + label + '</a>';
    const tabs = '<div class="ftt-row ftt-subtabs" data-ftt-csub-tabs>'
        + tab('overview', '💰 货币总览')
        + tab('ledger', '📒 收支记录（' + nL + '）')
        + tab('deals', '📈 长期收支（' + nD + '）')
        + '<span class="ftt-hint ftt-ml-2">记账必须挂在一条现存货币上；长期收支的预测与已发生分区呈现</span></div>';
    const body = cur === 'ledger' ? ledgerPageHtml() : (cur === 'deals' ? dealsPageHtml() : str0(overviewHtml));
    return tabs + '<div data-ftt-csub-body="' + esc(cur) + '">' + body + '</div>';
}
