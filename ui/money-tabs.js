// ============================================================
// ui/money-tabs.js —— **货币三子页**（v3.51.0 起，`docs/D53` §3.1 / `docs/D22` W32 `应-46` / `应-47`）
//
// 用户要求（原话）：「货币拆分子页，当前页作为货币总览。额外增加**收支记录**，类似记账；**长期收支**，用于记录标的物的长期收支。」
// v3.51.2（用户在真机点不动）→ 子标签改 `data-ftt-csub`（动作入参补 `sub`）；
// v3.51.3（用户报告「顶部按钮全部错误 / 无法点击」「长期收支按钮错误」+「列表样式美化」）：
//   · **编辑器挂载**：`＋记一笔` / `＋新建标的物` / `✏ 编辑` 走 `ps.editing` —— 但本页正文由本模块渲染，
//     面板的编辑器不会再出现 → 由面板把 `{editing, editorHtml}` 传进来，本页按 `editing.kind` 渲染（否则点了不出表单）；
//   · **列表美化**：收支记录 = 汇总卡 + 日期块 + 方向色 + 金额 + 来源徽标；长期收支 = 卡片（三段 + 触发器徽标）。
//
// 口径（`docs/D53` §3.1）：
//   · **① 货币总览** = 当前货币页，**行为与文案一字不改**（由 `ui/panel.js` 原样渲染后传进来）；
//   · **② 收支记录** = `ledger` 明细 + 合计（只增不删；删除走危险动作二次确认）；
//   · **③ 长期收支** = `deals` 列表 + 详情（**已发生节点**与**预测**分区块呈现 + 触发器状态）；
//   · 三子页是**页内子标签**，不新增面板分页（`PANEL_TABS` 不变）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import { formatMoney } from '../core/model/money.js';
import { ledgerList, currencyHistoryMaxOf } from '../core/model/ledger.js';
import { dealList } from '../core/model/deal.js';

const esc = (v) => { try { return escHtml(v); } catch (e) { return String(v == null ? '' : v); } };
const str0 = (v) => String(v == null ? '' : v);
const cut = (v, n) => { const s = str0(v); return s.length > n ? (s.slice(0, n - 1) + '…') : s; };
const money = (n) => { try { return formatMoney(Math.abs(Number(n) || 0)); } catch (e) { return str0(n); } };

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
const KIND_TEXT = { investment: '投资', royalty: '创作长期收益', loan: '贷款长期支出', other: '其它' };

/** 货币查找（渲染期只读） */
function curOf(id) {
    const list = Array.isArray(state.currencies) ? state.currencies : [];
    return list.filter((c) => c && String(c.id) === String(id))[0] || null;
}
function curText(id) {
    const c = curOf(id);
    return c ? (str0(c.owner) + '·' + str0(c.name)) : ('（货币已失效：' + cut(str0(id), 12) + '）');
}

/** 顶部动作条（v3.51.4：按页给 —— 收支记录只放「记一笔」；长期收支只放「新建标的物 + 修复」） */
function actBtns(which) {
    const addLedger = '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="ledger" title="新建一笔收支（必须先选择货币；金额正数=收入、负数=支出）">＋ 记一笔</button>';
    const addDeal = '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="deals" title="新建一条长期收支（标的物 + 锚定货币 + 预测节点）">＋ 新建标的物</button>';
    const repair = '<button class="ftt-btn ftt-sm" data-ftt-action="dealRepair" title="结合剧情节选修订/更正长期收支（每次只取 3 条交 AI，机械校验后落库；失败不改任何数据）">🔧 修复（3 条/次）</button>';
    return '<div class="ftt-money-actions">' + (which === 'deals' ? (addDeal + repair) : addLedger) + '</div>';
}

/** 一行流水（v3.51.3 美化：日期块 / 方向色 / 金额 / 来源徽标 / 说明） */
function ledgerRowHtml(x) {
    if (!x) return '';
    const delta = Number(x.delta) || 0;
    const dir = delta >= 0 ? 'in' : 'out';
    return '<div class="ftt-money-row ftt-flow-' + dir + '" data-ftt-ledger="' + esc(x.id) + '">'
        + '<div class="ftt-flow-date"><b>' + esc(cut(str0(x.date) || '—', 10)) + '</b></div>'
        + '<div class="ftt-flow-main">'
        + '<div class="ftt-flow-topline"><span class="ftt-flow-cur">' + esc(curText(x.currencyId)) + '</span>'
        + '<span class="ftt-chip ftt-chip-src">' + esc(SOURCE_TEXT[str0(x.source)] || str0(x.source) || '手动') + '</span>'
        + (x.dealId ? ('<span class="ftt-chip" title="由长期收支触发器生成">标的物</span>') : '') + '</div>'
        + (x.note ? ('<div class="ftt-flow-note">' + esc(cut(x.note, 60)) + '</div>') : '')
        + '</div>'
        + '<div class="ftt-flow-amt">' + (dir === 'in' ? '＋' : '−') + esc(money(delta)) + '</div>'
        + '<div class="ftt-flow-ops">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="ledger" data-id="' + esc(x.id) + '" title="编辑这笔流水（金额/日期/说明）">✏</button>'
        + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="ledger" data-id="' + esc(x.id) + '" title="删除这笔流水（反向冲正余额；留删除记录，跨端不复活）">🗑</button>'
        + '</div></div>';
}

/** 收支记录子页（编辑器由面板注入 → `opts.editorHtml`） */
export function ledgerPageHtml(opts) {
    const o = opts || {};
    const all = ledgerList().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const sum = all.reduce((s, x) => s + (Number(x.delta) || 0), 0);
    const income = all.filter((x) => Number(x.delta) >= 0).reduce((s, x) => s + (Number(x.delta) || 0), 0);
    const outgo = all.filter((x) => Number(x.delta) < 0).reduce((s, x) => s + (Number(x.delta) || 0), 0);
    const editor = (o.editing && String(o.editing.kind) === 'ledger' && typeof o.editorHtml === 'function')
        ? o.editorHtml('ledger', o.editing.id, o.editing.preset) : '';
    const head = '<div class="ftt-money-summary">'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">笔数</span><b>' + all.length + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">净额</span><b class="' + (sum >= 0 ? 'ftt-money-in' : 'ftt-money-out') + '">' + (sum >= 0 ? '＋' : '−') + esc(money(sum)) + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">收入</span><b class="ftt-money-in">' + esc(money(income)) + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">支出</span><b class="ftt-money-out">' + esc(money(outgo)) + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">摘要上限</span><b>' + esc(currencyHistoryMaxOf()) + ' 笔</b></div>'
        + '</div>';
    const hint = '<div class="ftt-money-hint">记账**必须挂在一条现存货币**上（货币不存在 → 拒绝，不会自动新建）；'
        + '删除一笔会**反向冲正**余额；货币被删除时其流水随之级联删除（跨端不复活）。</div>';
    const body = all.length
        ? all.map(ledgerRowHtml).join('')
        : '<div class="ftt-empty ftt-money-empty" data-ftt-ledger-empty>还没有收支记录。<br>点上方「＋ 记一笔」（先选择它属于哪条货币），或从「货币总览」的货币记录开始记账。</div>';
    return editor + head + '<div class="ftt-row ftt-money-toolbar">' + actBtns('ledger') + '</div>' + hint + body;
}

/** 长期收支：详情卡（v3.51.3 美化：徽标 / 三段分区 / 触发器状态） */
export function dealDetailHtml(d) {
    if (!d) return '';
    const ol = d.outlook || {};
    const fc = ol.forecast || {};
    const nodes = Array.isArray(ol.nodes) ? ol.nodes : [];
    const cur = curOf(d.currencyId);
    const trig = d.trigger || {};
    const stalled = str0(trig.skippedReason) === 'currency-missing';
    const nodesHtml = nodes.length
        ? nodes.map((n) => '<div class="ftt-deal-node"><span class="ftt-deal-node-date">' + esc(str0(n.date) || '—') + '</span>'
            + (Number(n.delta) ? ('<span class="ftt-deal-node-amt ' + (Number(n.delta) > 0 ? 'ftt-money-in' : 'ftt-money-out') + '">' + (Number(n.delta) > 0 ? '＋' : '−') + esc(money(n.delta)) + '</span>') : '')
            + (n.note ? ('<span class="ftt-deal-node-note">' + esc(cut(n.note, 40)) + '</span>') : '') + '</div>').join('')
        : '<div class="ftt-deal-empty-line">（还没有已发生的变动节点）</div>';
    const fcHtml = fc.nextDate
        ? '<div class="ftt-forecast" data-ftt-forecast><div class="ftt-forecast-k">预测 · 下一节点'
            + '<span class="ftt-chip ftt-chip-src">' + esc(fc.source === 'manual' ? '手动' : 'AI 建议') + '</span></div>'
            + '<div class="ftt-forecast-line"><b>' + esc(str0(fc.nextDate)) + '</b>'
            + (Number(fc.delta) ? (' <span class="' + (Number(fc.delta) > 0 ? 'ftt-money-in' : 'ftt-money-out') + '">' + (Number(fc.delta) > 0 ? '＋' : '−') + esc(money(fc.delta)) + '</span>') : '')
            + (str0(fc.direction) === 'decrease' ? ' <span class="ftt-chip">方向：减少</span>' : (str0(fc.direction) === 'increase' ? ' <span class="ftt-chip">方向：增加</span>' : ''))
            + (fc.note ? (' <span class="ftt-muted">' + esc(cut(fc.note, 40)) + '</span>') : '') + '</div></div>'
        : '<div class="ftt-forecast ftt-forecast-none" data-ftt-forecast>（尚未给出下一节点的预测日期）</div>';
    return '<div class="ftt-deal-card" data-ftt-deal="' + esc(d.id) + '">'
        + '<div class="ftt-deal-head"><b class="ftt-deal-name">' + esc(str0(d.name)) + '</b>'
        + '<span class="ftt-chip">' + esc(KIND_TEXT[str0(d.kind)] || str0(d.kind) || '其它') + '</span>'
        + (d.cycle ? ('<span class="ftt-chip">周期 ' + esc(str0(d.cycle)) + '</span>') : '<span class="ftt-chip">周期未知</span>')
        + (stalled ? '<span class="ftt-chip ftt-chip-warn" title="锚定货币已失效 → 触发器停摆">⚠ 触发器停摆</span>'
            : (str0(trig.lastFiredDate) ? ('<span class="ftt-chip ftt-chip-ok">已处置 ' + esc(str0(trig.lastFiredDate)) + '</span>') : '<span class="ftt-chip">尚未处置</span>'))
        + (trig.catchUpTruncated ? '<span class="ftt-chip ftt-chip-warn" title="猛烈跳动的补齐被上限截断：尚有周期未补齐">补齐被截断</span>' : '')
        + '<span class="ftt-deal-ops">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="deals" data-id="' + esc(d.id) + '" title="编辑该标的物（约定 / 现状 / 锚定货币 / 三段预判）">✏</button>'
        + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="deals" data-id="' + esc(d.id) + '" title="删除这条长期收支（不删其它数据）">🗑</button>'
        + '</span></div>'
        + (d.desc ? ('<div class="ftt-deal-desc">约定：' + esc(cut(d.desc, 160)) + '</div>') : '')
        + '<div class="ftt-deal-meta">'
        + '<span>锚定货币：<b>' + esc(cur ? (str0(cur.owner) + '·' + str0(cur.name)) : '（已失效 → 触发器停摆）') + '</b></span>'
        + '<span>初始 <b>' + esc(str0(d.startDate) || '—') + '</b></span>'
        + '<span>最后变动 <b>' + esc(str0(d.lastChangeDate) || '—') + '</b></span>'
        + '<span>截止 <b>' + esc(str0(d.endDate) || '无固定期') + '</b></span>'
        + '</div>'
        + (d.status ? ('<div class="ftt-deal-status">现状：' + esc(cut(d.status, 120)) + '</div>') : '')
        + '<div class="ftt-deal-sec"><div class="ftt-deal-sec-k">前景预判 ① 文字说明</div><div class="ftt-deal-text">' + (ol.text ? esc(cut(ol.text, 200)) : '<span class="ftt-muted">（暂无）</span>') + '</div></div>'
        + '<div class="ftt-deal-sec"><div class="ftt-deal-sec-k">前景预判 ② 已发生的变动节点</div><div class="ftt-deal-nodes">' + nodesHtml + '</div></div>'
        + '<div class="ftt-deal-sec"><div class="ftt-deal-sec-k">前景预判 ③ 预测下一节点</div>' + fcHtml + '</div>'
        + '</div>';
}

/** 长期收支子页 */
export function dealsPageHtml(opts) {
    const o = opts || {};
    const all = dealList();
    const editor = (o.editing && String(o.editing.kind) === 'deals' && typeof o.editorHtml === 'function')
        ? o.editorHtml('deals', o.editing.id, o.editing.preset) : '';
    const stalled = all.filter((d) => d && d.trigger && String(d.trigger.skippedReason) === 'currency-missing').length;
    const head = '<div class="ftt-money-summary">'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">标的物</span><b>' + all.length + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">触发器停摆</span><b class="' + (stalled ? 'ftt-money-out' : '') + '">' + stalled + '</b></div>'
        + '<div class="ftt-money-stat"><span class="ftt-money-k">执行方式</span><b>确定性 · 无 AI</b></div>'
        + '</div>';
    const hint = '<div class="ftt-money-hint">触发器在「总览自动分析完成」后执行：剧情日期跳动 → 到期兑现 / 猛烈跳动按周期补齐（受上限、如实标记）；'
        + '**锚定货币失效则不生成流水**（卡片上标「触发器停摆」）。</div>';
    const body = all.length
        ? all.map(dealDetailHtml).join('')
        : '<div class="ftt-empty ftt-money-empty" data-ftt-deals-empty>还没有长期收支。<br>点「＋ 新建标的物」：填名称、锚定货币、起始日期，以及**预测节点**（下一节点的日期 + 预计金额与方向）。</div>';
    return editor + head + '<div class="ftt-row ftt-money-toolbar">' + actBtns('deals') + '</div>' + hint + body;
}

/**
 * 货币页整体（三子标签 + 当前子页）。
 * @param {string} overviewHtml **总览**的 HTML（由 `ui/panel.js` 原样渲染 → 保证「总览一字不改」）
 * @param {{editing?:object, editorHtml?:Function}} [opts] 面板注入的**编辑态与编辑器渲染器**
 *   （v3.51.3：本页正文由本模块渲染，面板的编辑器不会出现 → 由面板把编辑器传进来，否则「＋ / ✏」点了不出表单）
 */
export function moneyPageHtml(overviewHtml, opts) {
    const o = opts || {};
    const cur = moneySub;
    const nL = ledgerList().length, nD = dealList().length;
    const tab = (key, label) => '<a href="javascript:void(0)" class="ftt-subtab' + (cur === key ? ' ftt-on' : '')
        + '" data-ftt-action="moneySub" data-ftt-csub="' + key + '">' + label + '</a>';
    const tabs = '<div class="ftt-row ftt-subtabs" data-ftt-csub-tabs>'
        + tab('overview', '💰 货币总览')
        + tab('ledger', '📒 收支记录（' + nL + '）')
        + tab('deals', '📈 长期收支（' + nD + '）')
        + '<span class="ftt-hint ftt-ml-2">记账必须挂在一条现存货币上；长期收支的预测与已发生分区呈现</span></div>';
    const body = cur === 'ledger' ? ledgerPageHtml(o) : (cur === 'deals' ? dealsPageHtml(o) : str0(overviewHtml));
    return tabs + '<div data-ftt-csub-body="' + esc(cur) + '">' + body + '</div>';
}
