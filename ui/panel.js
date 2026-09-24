// ============================================================
// ui/panel.js —— **V1 同构浮层面板**（用户要求：完全对齐 V1，包含样式）
// 结构（与 V1 `panelHtml()` 同名同层级，故 `style.css` 里的 V1 样式原样生效）：
//   <div id="ftt-panel"> <div class="ftt-modal">
//       <div class="ftt-modal-head"> 标题 + 总记忆数 + ✕ </div>
//       <div class="ftt-tabs"> 13 个 <a class="ftt-tab" data-ftt-tab="…"> </div>
//       <div class="ftt-body" data-ftt-body="…"> 各分页内容 </div>
//   </div></div>
// 行为（与 V1 一致）：点击标签切页、✕ 关闭、点击遮罩关闭、Esc 关闭；分页状态与搜索词留在模块内。
// 渲染与动作分离：panelHtml() / panelAction() / bindOverlay()，无 querySelectorAll 的环境可直接调动作（可完整测）。
// 分页内容分批对齐 V1：本批（B1）= 总览（时钟/在场/已处理与未摘要楼层）+ 各维度列表（V1 样式）+ 设置（沿用 V2 表单）；
//   后续批次逐页补齐 V1 的编辑器、关系表、注入自查、提示词页、快照/同步、高级域等（见 docs/P8-功能对齐总表.md）。
// ============================================================
import { VERSION, DIMENSIONS } from '../core/constants.js';
import { state, cfg, getScopeKey, getLastMessageId } from '../core/model/runtime.js';
import { clockDateLabel } from '../core/clock.js';
import { consoleList, consoleEntry, consoleSave, consoleDelete, entrySummary, injectAudit, consoleSummary } from './console.js';
import { fallbackPanelHtml, panelData, setPanelHooks as setPanelFormHooks, bindPanelEvents } from './settings-panel.js';
import { kindFields, flattenSnapshot, deconstructEntry } from './fields.js';
import { settingsPageHtml, settingsSubTabsHtml, applySettingsControl, settingsPagesInfo, SETTINGS_TABS } from './settings-pages.js';
import { dimsCheckboxHtml } from './settings-panel.js';
import { relTableHtml, relAction, relStats, relByWho, relRowsOf, REL_DIMS, howLabel } from './rel-table.js';
import { injectCheckPanelHtml, injectCheckAction, setCheckKeywords, injectCheckStats } from './inject-check.js';
import { atomIsHidden } from '../core/merge.js';

export const PANEL_ID = 'ftt-panel';
/** V1 的 13 个分页（id 与标签逐字一致） */
export const PANEL_TABS = Object.freeze([
    ['overview', '总览'], ['atoms', '情节'], ['states', '状态'], ['snapshots', '角色'],
    ['memories', '记忆'], ['items', '物品'], ['currencies', '货币'], ['rumors', '传言'],
    ['plans', '计划悬念'], ['scenes', '场景'], ['concepts', '概念'], ['parallels', '平行'], ['settings', '设置'],
]);
/** 分页 id → 维度容器键（状态存 currentStates；计划悬念页含 plans+suspense） */
const TAB_DIM = { atoms: 'atoms', states: 'currentStates', snapshots: 'snapshots', memories: 'memories', items: 'items', currencies: 'currencies', rumors: 'rumors', plans: 'plans', scenes: 'scenes', concepts: 'concepts', parallels: 'parallels' };

const ps = {
    tab: 'overview', open: false, q: {}, editing: null, note: '', opened: 0,
    busy: false,        // 批量分析进行中（头部 busy 文案 + 楼层脉冲）
    settingsSub: 'base', // 设定页当前子页（V1 的 14 组子页）
    relSub: {},         // 各分页的子标签：{ [tab]: 'list' | 'rel' | 'check' }（V1 activeMemSub/activeAtomSub 口径）
    relWho: '',         // 关系表「按角色」筛选
    exportText: '',     // 数据管理页的导出 JSON（供复制/查看）
    sel: {},            // 多选集合：{ [kind]: Set<id> }
    multi: {},          // 多选模式：{ [kind]: bool }
    showHidden: false,  // 情节页：是否显示「已总结（隐藏）」情节（V1 atomToggleHidden）
    peek: '',           // 情节速览：正在穿透查看的 id（V1 atomPeek）
};
let overlayEl = null;
let hooks = {};
let escBound = false;

/** 注入动作钩子（index.js：提取 / 清单 / 更新 / 清空注入） */
export function setPanelHooks2(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
/** 面板状态（诊断/测试） */
export function panelState() {
    return {
        id: PANEL_ID, tab: ps.tab, open: ps.open, opened: ps.opened, note: ps.note,
        tabs: PANEL_TABS.map((t) => t[0]), editing: ps.editing ? Object.assign({}, ps.editing) : null,
        search: Object.assign({}, ps.q),
        multi: Object.assign({}, ps.multi),
        selCount: Object.keys(ps.sel).reduce((n, k) => n + (ps.sel[k] ? ps.sel[k].size : 0), 0),
        showHidden: ps.showHidden, peek: ps.peek, settingsSub: ps.settingsSub,
        relSub: Object.assign({}, ps.relSub), relWho: ps.relWho,
        exportChars: String(ps.exportText || '').length,
    };
}
/**
 * UI 分页 id → **数据容器键**：V1 的界面用 'states'，而数据容器/墓碑维度是 'currentStates'
 *   （V1 的 `ATOM_DIM_KEYS` 只含 currentStates）。若直接把 'states' 传给 entries/墓碑层，
 *   墓碑会写到 `deleted.states` —— 跨端合并读不到，属真实缺陷（B2 修）。
 */
function dataKindOf(kind) { return kind === 'states' ? 'currentStates' : String(kind || ''); }
// 注（**与 V1 的一处有意偏离**）：V1 的状态页把墓碑写进 `deleted.states`，而它的维度表 `ATOM_DIM_KEYS` 只认
//   `currentStates` —— 即 V1 的状态删除墓碑**不会被自己的跨端合并/清扫读到**（删了可能在别端复活）。
//   V2 统一用规范维度键（states → currentStates）写入与读取，使删除墓碑真正生效；UI 标签/分页 id 仍与 V1 一致。
//   登记于 docs/P8c-B2条目操作.md「有意偏离」。

/** 某维度的多选集合（缺省即建） */
function selOf(kind) { if (!ps.sel[kind]) ps.sel[kind] = new Set(); return ps.sel[kind]; }
/** 当前列表（含隐藏过滤） */
function listOf(kind, q, limit) {
    const base = consoleList(dataKindOf(kind), q === undefined ? (ps.q[kind] || '') : q, limit);
    if (kind !== 'atoms' || ps.showHidden) return base;
    try { return base.filter((x) => !atomIsHidden(x)); } catch (e) { return base; }
}
function hiddenCount() { try { return arrOf('atoms').filter((x) => atomIsHidden(x)).length; } catch (e) { return 0; } }
export function panelInfo() {
    const doc = docEl();
    let mounted = false;
    try { mounted = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(PANEL_ID)); } catch (e) { mounted = false; }
    return { id: PANEL_ID, mounted: mounted || !!overlayEl, open: ps.open, tab: ps.tab, opened: ps.opened, tabs: PANEL_TABS.map((t) => t[0]), bodyFound: !!(doc && doc.body) };
}
export function panelTabs() { return PANEL_TABS.map((t) => ({ id: t[0], label: t[1] })); }

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (v) => esc(v);
function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }
const J = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } };

/**
 * 读取维度容器数组：**UI kind → 数据容器键**（V1 的界面用 'states'，容器是 `currentStates`）。
 * 注意与「墓碑维度」区分：写入/墓碑层仍传 UI kind（V1 `deleteEntry('states')` 把墓碑写进 `deleted.states`），
 * 但**读取容器**必须映射，否则状态页会显示为空（B2 实测踩到）。
 */
function arrOf(kind) {
    try {
        const k = dataKindOf(kind);
        return Array.isArray(state[k]) ? state[k] : [];
    } catch (e) { return []; }
}
function totalMemory() {
    try { return DIMENSIONS.reduce((n, d) => n + arrOf(d.kind).length, 0); } catch (e) { return 0; }
}

/** 总览：剧情时钟 / 在场 / 计数 / 已处理与未摘要楼层 / 快捷动作（V1 总览的可见子集；其余见 docs/P8 批次表） */
function overviewBody() {
    const lines = [];
    try {
        const st = state && state.state ? state.state : {};
        if (st.date) lines.push('<div class="ftt-item">📅 日期：' + esc(clockDateLabel(st.date)) + (st.era ? '（' + esc(st.era) + '）' : '') + (st.season ? '·' + esc(st.season) : '') + '</div>');
        else lines.push('<div class="ftt-item">📅 日期：<span class="ftt-muted">（未记录 · 可在「设置 → 时钟」手工改写/巡检，见后续批次）</span></div>');
        if (st.time) lines.push('<div class="ftt-item">⏱ 时间：' + esc(st.timeEnd ? st.time + ' → ' + st.timeEnd : st.time) + '</div>');
        else lines.push('<div class="ftt-item">⏱ 时间：<span class="ftt-muted">（未记录）</span></div>');
        if (st.location) lines.push('<div class="ftt-item">📍 地点：' + esc(st.location) + '</div>');
        else lines.push('<div class="ftt-item">📍 地点：<span class="ftt-muted">（未记录）</span></div>');
        const present = Array.isArray(st.present) ? st.present : null;
        if (present && present.length) lines.push('<div class="ftt-item">👥 在场角色：' + esc(present.slice(0, 12).join('、')) + '</div>');
        else lines.push('<div class="ftt-item">👥 在场角色：<span class="ftt-muted">（未识别 · 不限制注入）</span></div>');
    } catch (e) { /* 忽略 */ }
    const audit = injectAudit({ rows: false });
    lines.push('<div class="ftt-item ftt-item--info ftt-inline"><b class="ftt-pipe-title">🧷 注入</b> <span class="ftt-muted" style="flex:1 1 auto;min-width:0">当前注入 ' + audit.chars + ' 字 · 命中 ' + audit.injected + ' / 未命中 ' + audit.missing + ' · 预算 ' + (Number(cfg.charBudget) || 0) + ' 字符</span></div>');
    // 维度计数（V1 总览有逐类目统计）
    const sum = consoleSummary();
    lines.push('<h4 class="ftt-h4-inline">📚 类目统计 <span class="ftt-muted">共 ' + sum.total + ' 条</span></h4>');
    lines.push('<div class="ftt-row">' + sum.dims.map((d) => '<span class="ftt-badge">' + esc(d.label) + ' ' + d.count + '</span>').join(' ') + '</div>');
    // 已处理 / 未摘要楼层（V1 的楼层管理入口）
    const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
    const nums = pf.map((x) => Number(x && typeof x === 'object' ? x.f : x)).filter(Number.isFinite).sort((a, b) => a - b);
    const last = nums.length ? nums[nums.length - 1] : -1;
    lines.push('<h4 class="ftt-h4-inline">✅ 已处理楼层 <span class="ftt-muted">' + pf.length + ' 个' + (last >= 0 ? ' · 最新至第 ' + last + ' 楼' : '') + '</span></h4>');
    if (nums.length) lines.push('<div class="ftt-hint ftt-scroll-40">已处理区间：' + esc(rangesText(nums)) + '</div>');
    else lines.push('<div class="ftt-muted">尚未处理任何楼层。「⚡ 立即 AI 摘要」或「📤 提取记忆」后自动记录。</div>');
    const pending = (typeof hooks.pending === 'function') ? (hooks.pending({}) || []) : [];
    if (pending.length) {
        lines.push('<div class="ftt-item ftt-item--warn ftt-item--col"><b class="ftt-pend-title">⏳ 未摘要楼层：' + pending.length + ' 个 · 可点击单独分析</b><div class="ftt-pend-list">'
            + pending.slice(0, 40).map((f) => '<button class="ftt-btn ftt-sm ftt-floor-btn" data-ftt-action="summaryFloor" data-ftt-floor="' + attr(f) + '" title="单独分析该楼层">第' + esc(f) + '楼</button>').join(' ')
            + (pending.length > 40 ? ' …等 ' + pending.length + ' 个' : '') + '</div></div>');
    } else lines.push('<div class="ftt-muted">🎉 最近楼层均已摘要。</div>');
    // 工具行（V1 同名按钮；未实现的动作给出明确提示，避免「按了没反应」）
    lines.push('<div class="ftt-row">'
        + '<button class="ftt-btn ftt-primary" data-ftt-action="summary" id="ftt-summary-btn">⚡ 立即 AI 摘要</button>'
        + '<button class="ftt-btn" data-ftt-action="extractNow" id="ftt-extract-btn">📤 提取记忆</button>'
        + '<button class="ftt-btn" data-ftt-action="inject" id="ftt-inject-btn">📤 立即注入</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="abortAnalysis" id="ftt-abort-btn" title="中断当前分析：段与段之间停止（已完成并落盘的部分保留）">✖ 中断</button>'
        + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clearFloors" id="ftt-clearfloors-btn" title="清除「已处理楼层」记录（不删除任何记忆条目）">🧹 清除已处理记录</button>'
        + '</div>');
    lines.push('<div class="ftt-hint">「提取记忆」= 分析未摘要楼层（逐楼 AI 摘要 → 落库）；「立即注入」= 立刻把当前记忆按预算注入提示词。</div>');
    if (ps.note) lines.push('<div class="ftt-hint" data-ftt-note>' + esc(ps.note) + '</div>');
    return lines.join('\n');
}

/** 楼层号压缩为区间文本（V1 `processedRanges` 的等价简化） */
function rangesText(nums) {
    const out = [];
    let s = nums[0], p = nums[0];
    for (let i = 1; i < nums.length; i++) {
        if (nums[i] === p + 1) { p = nums[i]; continue; }
        out.push(s === p ? String(s) : s + '-' + p);
        s = p = nums[i];
    }
    out.push(s === p ? String(s) : s + '-' + p);
    return out.slice(-8).join('、') + (out.length > 8 ? ' …共 ' + out.length + ' 段' : '');
}

/** 维度列表（V1 同款：工具栏 + 搜索 + 多选 + 行内操作 + 速览 + 编辑器） */
/** 支持关系表子标签的分页（V1：记忆 / 计划 / 悬念 / 平行） */
const REL_TABDS = { memories: 'memories', plans: 'plans', suspense: 'suspense', parallels: 'parallels' };

/** 子标签条（V1 `.ftt-subtab`：列表 / 关系表 / 约束自查） */
function subTabsHtml(tab, cur) {
    const items = [['list', '📚 列表']];
    if (REL_TABDS[tab]) items.push(['rel', '🔗 关系表']);
    if (tab === 'memories') items.push(['check', '🧷 约束自查']);
    return '<div class="ftt-row ftt-subtabs">' + items.map(([id, label]) =>
        '<a href="javascript:void(0)" class="ftt-subtab' + (id === cur ? ' ftt-on' : '') + '" data-ftt-msub="' + id + '">' + esc(label) + '</a>').join(' ')
        + '<span class="ftt-hint ftt-ml-2">关系表 = 「谁知道 / 谁相关」的总览与编辑；约束自查 = 「本轮注入了什么、为什么别的没进去」</span></div>';
}

/** 某分页的子标签视图（list / rel / check） */
function subViewHtml(tab) {
    const cur = ps.relSub[tab] || 'list';
    if (!REL_TABDS[tab]) return '';
    const bars = subTabsHtml(tab, cur);
    if (cur === 'rel') {
        const dim = REL_TABDS[tab];
        const st = relStats();
        const who = String(ps.relWho || '');
        const byWho = who ? relByWho(who, [dim]) : [];
        const pickHtml = byWho.length
            ? ('<div class="ftt-hint">「' + esc(who) + '」在此维度的关联：' + esc(byWho.map((x) => (x.title + '（' + howLabel(x.how) + '）')).join('、')) + '</div>')
            : '';
        return bars
            + '<div class="ftt-hint">关联行合计 ' + st.total + '（' + REL_DIMS.map((d) => (d === dim ? (d + ' ' + (st.byDim[d] || 0)) : null)).filter(Boolean).join('') + '）'
            + ' · 推定 ' + st.inferred + ' · 孤儿 ' + st.orphan + ' · 公共 ' + st.publics + '</div>'
            + '<div class="ftt-field"><label>按角色筛选</label><input type="text" data-ftt-rel-who="1" value="' + attr(who) + '" placeholder="角色名（回车）"></div>'
            + pickHtml
            + '<div class="ftt-hint">点条目行的 ✏️ 打开编辑器后可编辑该条目的关联；下方为该维度**关联总览**（按条目聚合）。</div>'
            + relOverviewHtml(dim);
    }
    if (cur === 'check') return bars + injectCheckPanelHtml();
    return bars;
}

/** 某维度的关联总览（按条目聚合，V1 关系表总览口径） */
function relOverviewHtml(dim) {
    const links = (() => { try { return Array.isArray(state.links) ? state.links : []; } catch (e) { return []; } })();
    const byRef = new Map();
    links.forEach((x) => {
        if (!x || String(x.dim) !== dim) return;
        const k = String(x.refId);
        if (!byRef.has(k)) byRef.set(k, []);
        byRef.get(k).push(x);
    });
    if (!byRef.size) return '<div class="ftt-empty">（该维度暂无关联行）</div>';
    const rows = Array.from(byRef.entries()).slice(0, 200).map(([refId, list]) => {
        const who = list.filter((x) => x && x.who).map((x) => String(x.who) + '（' + howLabel(x.how) + '）').join('、');
        const pub = list.some((x) => x && x.public);
        return '<div class="ftt-item ftt-inline"><span class="ftt-grow"><b>' + esc(entrySummary({ id: refId })) + '</b> <span class="ftt-muted">' + esc(entrySummaryById(dim, refId)) + '</span>'
            + '<div class="ftt-hint">' + (who ? esc(who) : '（仅幕后 / 未指定角色）') + (pub ? ' · 公共' : '') + '</div></span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="relEdit" data-ftt-kind="' + attr(dim) + '" data-ftt-id="' + attr(refId) + '">🔗 编辑</button></div>';
    }).join('');
    return rows;
}

/** 条目摘要（按 id 取库内条目） */
function entrySummaryById(dim, id) {
    try {
        const e = ((state[dataKindOf(dim)] || [])).filter((x) => x && String(x.id) === String(id))[0];
        return e ? entrySummary(e) : '（条目已不在库中）';
    } catch (e) { return ''; }
}

function dimBody(kind) {
    const q = ps.q[kind] || '';
    const list = listOf(kind, q, 300);
    const total = arrOf(kind).length;
    const sel = selOf(kind);
    const multi = ps.multi[kind] === true;
    const hiddenN = kind === 'atoms' ? hiddenCount() : 0;
    const toolbar = '<div class="ftt-addbar ftt-toolbar">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="' + attr(kind) + '">➕ 新增</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="multiToggle" data-kind="' + attr(kind) + '" title="切换单选 / 多选">' + (multi ? '☑ 多选模式' : '☐ 单选模式') + '</button>'
        + (multi ? ('<button class="ftt-btn ftt-sm" data-ftt-action="selectAll" data-kind="' + attr(kind) + '">全选</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="selectNone" data-kind="' + attr(kind) + '">清空选择</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="bulkDelete" data-kind="' + attr(kind) + '"' + (sel.size ? '' : ' disabled') + '>🗑 删除选中（' + sel.size + '）</button>') : '')
        + (kind === 'atoms' ? ('<button class="ftt-btn ftt-sm" data-ftt-action="atomToggleHidden">' + (ps.showHidden ? '🙈 隐藏已总结' : ('👁 显示已总结（' + hiddenN + '）')) + '</button>') : '')
        + '</div>'
        + (kind === 'atoms' ? '<div class="ftt-hint">已总结的情节不参与注入 / 淘汰 / 修复 / 质检等任何自动动作（持久保留，除非人工删除）。</div>' : '');
    const head = '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-search="' + attr(kind) + '" value="' + attr(q) + '" placeholder="搜索（标题 / 正文 / 标签 / 归属）">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="searchClear" data-ftt-search-kind="' + attr(kind) + '" title="清除搜索与筛选">✕ 清除</button>'
        + '<span class="ftt-muted">' + (q ? '匹配 ' + list.length + ' / ' : '共 ') + total + ' 条</span></div>';
    const bars = subViewHtml(kind);
    const curSub = ps.relSub[kind] || 'list';
    const relEditing = ps.relEditing && ps.relEditing.kind === kind ? ps.relEditing.id : '';
    if (REL_TABDS[kind] && curSub === 'rel') return bars;
    if (REL_TABDS[kind] && curSub === 'check') return bars;
    const ed = ps.editing && ps.editing.kind === kind
        ? (editorHtml(kind, ps.editing.id, ps.editing.preset) + (REL_TABDS[kind] ? relTableHtml(kind, ps.editing.id || '') : ''))
        : '';
    const peek = (kind === 'atoms' && ps.peek) ? peekHtml(ps.peek) : '';
    if (!list.length) return (REL_TABDS[kind] ? subViewHtml(kind) : '') + toolbar + head + ed + peek + '<div class="ftt-empty">（' + (q ? '没有匹配的条目' : '该类目暂无条目') + '）</div>';
    const rows = list.map((e) => {
        const id = String(e.id || '');
        const meta = [e.date || e.seenDate || '', Number(e.uses) ? '调用 ' + e.uses + ' 次' : '', e.who || e.owner || e.subject || ''].filter(Boolean).join(' · ');
        const hidden = kind === 'atoms' && (() => { try { return atomIsHidden(e); } catch (x) { return false; } })();
        const box = multi ? ('<input type="checkbox" data-ftt-select="' + attr(kind) + '" data-ftt-id="' + attr(id) + '"' + (sel.has(id) ? ' checked' : '') + ' title="选中">') : '';
        const peekBtn = (kind === 'atoms' && hidden) ? ('<button class="ftt-op" data-ftt-action="atomPeek" data-ftt-id="' + attr(id) + '" title="穿透查看被总结的原文">🔍</button>') : '';
        return '<div class="ftt-item ftt-inline">' + box
            + '<span class="ftt-grow"><b>' + esc(entrySummary(e)) + '</b>' + (meta ? ' <span class="ftt-muted">' + esc(meta) + '</span>' : '') + (hidden ? ' <span class="ftt-badge">已总结</span>' : '') + '</span>'
            + peekBtn
            + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="编辑">✏️</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="删除（留墓碑）">🗑</button>'
            + '</div>';
    }).join('\n');
    return (REL_TABDS[kind] ? subViewHtml(kind) : '') + toolbar + head + ed + peek + rows;
}

/** 情节速览（V1 atomPeek 的只读穿透视图） */
function peekHtml(id) {
    const d = consoleEntry('atoms', id);
    if (!d) return '';
    return '<div class="ftt-item ftt-item--info ftt-item--col"><b>🔍 速览 · ' + esc(String(d.item.title || id)) + '</b>'
        + '<div class="ftt-hint" style="white-space:pre-wrap">' + esc(String(d.item.text || '')) + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="atomPeekClose">收起</button></div></div>';
}

/** 表单值：数组/结构化字段 → 文本（V1 编辑器的展示口径） */
function flatFor(kind, item) {
    const it = item || {};
    if (kind === 'snapshots') return flattenSnapshot(it);
    const out = Object.assign({}, it);
    ['tags', 'keywords', 'entities', 'locations', 'characters', 'traits', 'quirks', 'values', 'todos', 'commitments'].forEach((k) => {
        if (Array.isArray(out[k])) out[k] = out[k].join('，');
    });
    if (kind === 'rumors') {
        out.carriersText = (Array.isArray(it.carriers) ? it.carriers : []).map((c) => String(c && c.who || '') + (c && c.role && c.role !== '传播者' ? ':' + c.role : '')).filter(Boolean).join('\n');
        out.mediaText = (Array.isArray(it.media) ? it.media : []).map((m) => [m && m.type, m && m.name, m && m.date, m && m.durability].filter((x) => x !== undefined && x !== null && x !== '').join('|')).join('\n');
    }
    if (kind === 'plotSegments') {
        out.linesText = (Array.isArray(it.lines) ? it.lines : []).map((l) => String(l && l.label || '') + ': ' + String(l && l.text || '')).join('\n');
    }
    if (kind === 'parallels' && Array.isArray(it.goalOdds)) out.goalOdds = JSON.stringify(it.goalOdds);
    return out;
}

/** 编辑器（V1 `ftt-editor` 结构；字段表来自 `kindFields(kind)`，保存经 `deconstructEntry` 还原为入库 raw） */
function editorHtml(kind, id, preset) {
    const isNew = !id;
    const d = isNew ? null : consoleEntry(dataKindOf(kind), id);
    if (!isNew && !d) return '<div class="ftt-empty">（条目已不存在）</div>';
    const base = new Map();
    try { prefillEditor(kind, base, isNew ? null : d.item, preset); } catch (e) { /* 忽略 */ }
    const rows = kindFields(kind).map((f) => {
        const val = base.has(f.key) ? base.get(f.key) : '';
        if (f.type === 'relTable') {
            const rels = (!isNew && d && d.rels) ? d.rels : [];
            return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + '</label><div class="ftt-hint">'
                + (rels.length ? esc(rels.map((r) => (r.who || '公共') + (r.how ? '(' + r.how + ')' : '')).join('、')) : '（无关联 · 关系表编辑见批次 B5）') + '</div></div>';
        }
        if (f.type === 'checkbox') {
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><input type="checkbox" data-ftt-ed="' + attr(f.key) + '"' + (val === true ? ' checked' : '') + '></div>';
        }
        if (f.type === 'select') {
            const opts = (f.options || []).map((o) => {
                const ov = (o && typeof o === 'object') ? o.value : o;
                const ol = (o && typeof o === 'object') ? o.label : o;
                return '<option value="' + attr(ov) + '"' + (String(val) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>';
            }).join('');
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
        }
        if (f.type === 'sceneParent') {
            const opts = ['<option value="">（顶层）</option>'].concat(arrOf('scenes').map((sc) =>
                '<option value="' + attr(sc.id) + '"' + (String(val) === String(sc.id) ? ' selected' : '') + '>' + esc(sc.name) + '</option>')).join('');
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
        }
        if (f.type === 'textarea') {
            return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + '</label><textarea data-ftt-ed="' + attr(f.key) + '" rows="4">' + esc(val) + '</textarea></div>';
        }
        return '<div class="ftt-field"><label>' + esc(f.label) + '</label><div class="ftt-grow"><input type="' + attr(f.type || 'text') + '" data-ftt-ed="' + attr(f.key) + '" value="' + attr(val) + '"></div></div>';
    }).join('\n');
    return '<div class="ftt-editor">'
        + '<div class="ftt-editor-title">' + (isNew ? '➕ 新增' : '✏️ 编辑') + ' · ' + esc(kindLabelOf(kind)) + (id ? (' · ' + esc(id) + ' · 内容哈希 ' + esc((d && d.hash) || '')) : '') + '</div>'
        + rows
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="save" data-kind="' + attr(kind) + '" data-id="' + attr(id || '') + '">💾 保存</button>'
        + '<button class="ftt-btn" data-ftt-action="closeEntry" data-kind="' + attr(kind) + '">取消</button></div>'
        + '</div>';
}

function kindLabelOf(kind) {
    const d = DIMENSIONS.filter((x) => x.kind === kind)[0];
    if (d) return d.label;
    if (kind === 'suspense') return '悬念';
    return String(kind);
}

/** 编辑器初值（字段 key → 值）；preset 用于「新增」路径（状态主体 / 父级场景） */
function prefillEditor(kind, out, item, preset) {
    const p = preset || {};
    if (!item) {
        if (kind === 'states' && p.subject) out.set('subject', String(p.subject));
        if (kind === 'scenes' && p.parentSceneId) out.set('parent', String(p.parentSceneId));
        if (kind === 'scenes' && p.name) out.set('name', String(p.name));
        if (kind === 'plans' || kind === 'suspense') { out.set('status', kind === 'plans' ? 'open' : 'open'); out.set('phase', ''); }
        if (kind === 'items') out.set('carried', false);
        if (kind === 'snapshots') out.set('deceased', false);
        return out;
    }
    const flat = flatFor(kind, item);
    for (const f of kindFields(kind)) {
        const v = flat[f.key];
        if (v === undefined || v === null) { out.set(f.key, f.type === 'checkbox' ? false : ''); continue; }
        out.set(f.key, f.type === 'checkbox' ? (v === true) : v);
    }
    return out;
}

/** 从 DOM 读取编辑器表单（真实 DOM 路径；桩 DOM 由调用方直接传 fields） */
function collectEditorFields(el) {
    const fields = {};
    try {
        if (!el || typeof el.querySelectorAll !== 'function') return fields;
        for (const node of el.querySelectorAll('[data-ftt-ed]')) {
            const key = node.getAttribute('data-ftt-ed');
            if (!key) continue;
            fields[key] = (node.type === 'checkbox') ? !!node.checked : String(node.value == null ? '' : node.value);
        }
    } catch (e) { /* 忽略 */ }
    return fields;
}

/** 状态页：按主体分组（V1 同款：每组标题带「➕ 添加」「🗑 删除分组」） */
function statesBody() {
    const q = ps.q.states || '';
    const list = listOf('states', q, 300);
    const groups = new Map();
    for (const e of list) {
        const k = String((e && e.subject) || '（未标主体）');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
    }
    const head = '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-search="states" value="' + attr(q) + '" placeholder="搜索（主体 / 字段 / 值）">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="searchClear" data-ftt-search-kind="states">✕ 清除</button>'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="states">➕ 新增</button>'
        + '<span class="ftt-muted">共 ' + arrOf('currentStates').length + ' 条</span></div>';
    const ed = ps.editing && ps.editing.kind === 'states' ? editorHtml('states', ps.editing.id, ps.editing.preset) : '';
    if (!groups.size) return head + ed + '<div class="ftt-empty">（暂无状态记录）</div>';
    const blocks = Array.from(groups.entries()).map(([subj, items]) => {
        const rows = items.map((e) => {
            const id = String(e.id || '');
            return '<div class="ftt-item ftt-inline"><span class="ftt-grow"><b>' + esc(String(e.field || '')) + '</b>：' + esc(String(e.value || ''))
                + (e.date ? ' <span class="ftt-muted">' + esc(e.date) + '</span>' : '') + '</span>'
                + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="states" data-id="' + attr(id) + '">✏️</button>'
                + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="states" data-id="' + attr(id) + '">🗑</button></div>';
        }).join('\n');
        return '<h4 class="ftt-h4-inline ftt-mt-6">👤 ' + esc(subj) + ' <span class="ftt-muted">(' + items.length + ')</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="addStateFor" data-ftt-subject="' + attr(subj) + '">➕ 添加</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delStateGroup" data-ftt-subject="' + attr(subj) + '" title="删除该角色全部状态">🗑 删除分组</button></h4>'
            + rows;
    }).join('\n');
    return head + ed + blocks;
}

/** 设置分页：V1 的 **14 组子页**（子标签条 + 当前页控件；写回内核 cfg 并持久化） */
function settingsBody() {
    const cur = SETTINGS_TABS.some((t) => t.id === ps.settingsSub) ? ps.settingsSub : SETTINGS_TABS[0].id;
    const label = (SETTINGS_TABS.filter((t) => t.id === cur)[0] || {}).label || cur;
    const info = settingsPagesInfo();
    const curInfo = info.pages.filter((p) => p.id === cur)[0] || { controls: 0 };
    return [
        '<div class="ftt-row ftt-settings-subtabs">' + settingsSubTabsHtml(cur) + '</div>',
        '<div class="ftt-hint">设定 · ' + esc(label) + '（' + curInfo.controls + ' 个配置项 · 共 ' + info.totalControls + ' 项 / ' + info.pages.length + ' 页，结构与 V1 同名同序）</div>',
        '<div class="ftt-settings-page" data-ftt-settings-page="' + attr(cur) + '">' + settingsPageHtml(cur) + '</div>',
        '<h4 class="ftt-h4-inline">V2 附加设定 <span class="ftt-muted">（V1 无此项：更新检查 / V1 数据导入 / 维度开关）</span></h4>',
        v2ExtrasHtml(),
        (ps.exportText ? ('<div class="ftt-field ftt-field-col"><label>导出结果（可复制保存）</label><textarea data-ftt-export="1" rows="6">' + esc(ps.exportText) + '</textarea></div>') : ''),
    ].join('\n');
}

/** V2 附加设定块（V1 没有、但 V2 已有的能力：更新检查、V1 导入、维度勾选） */
function v2ExtrasHtml() {
    const repo = String(cfg.updateRepo || '');
    return [
        '<div class="ftt-row"><label class="ftt-switch"><input type="checkbox" data-ftt-v2="autoUpdateCheck"' + (cfg.autoUpdateCheck !== false ? ' checked' : '') + '><span class="ftt-slider"></span></label><span class="ftt-muted">启动时自动检查更新</span>',
        '<input type="text" class="ftt-input" data-ftt-v2="updateRepo" value="' + attr(repo) + '" placeholder="更新检查仓库地址">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="check-update">🔍 检查更新</button></div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="importV1Dry">📥 V1 导入（干跑）</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="importV1Apply">📥 V1 导入（写入）</button>'
        + '<span class="ftt-muted">源数据不删除；写入为按 id 合并</span></div>',
        '<div class="ftt-field ftt-field-col"><label>启用维度</label><div class="ftt-v2-dims" id="ftt_v2_dims">' + dimsCheckboxHtml() + '</div></div>',
    ].join('\n');
}

/** 分页内容 *//** 分页内容 *//** 分页内容 */
export function panelBodyHtml(tab) {
    const t = tab || ps.tab;
    try {
        if (t === 'overview') return overviewBody();
        if (t === 'settings') return settingsBody();
        if (t === 'plans') return dimBody('plans') + '<h4 class="ftt-h4-inline">悬念</h4>' + dimBody('suspense');
        if (t === 'states') return statesBody();
        const kind = TAB_DIM[t];
        if (kind) return dimBody(kind);
        return '<div class="ftt-empty">（该分页尚未实现）</div>';
    } catch (e) { return '<div class="ftt-empty">渲染失败：' + esc(String((e && e.message) || e)) + '</div>'; }
}

/** 整个浮层 HTML（与 V1 同名同层级；V1 样式挂在 #ftt-panel 上） */
export function panelHtml() {
    const active = PANEL_TABS.some((x) => x[0] === ps.tab) ? ps.tab : 'overview';
    const nameTxt = (() => { try { return String(getScopeKey() || ''); } catch (e) { return ''; } })();
    const bp = (ps.busy && typeof hooks.batchProgress === 'function') ? (hooks.batchProgress() || {}) : null;
    const busyNote = ps.busy
        ? ('<span class="ftt-busy">' + (bp && bp.segTotal ? ('🔄 分析中 ' + bp.segDone + '/' + bp.segTotal + ' 段' + (bp.activeSeg ? ('（第 ' + bp.activeSeg.start + '-' + bp.activeSeg.end + ' 楼）') : '')) : '🔄 分析中…') + '</span>')
        : '';
    const head = '<div class="ftt-modal-head' + (ps.busy ? ' ftt-head-busy' : '') + '">'
        + '<span class="ftt-title">📖 FTT记忆组件 ' + esc(VERSION) + (nameTxt ? ' · ' + esc(nameTxt) : '') + '</span>'
        + busyNote
        + '<span class="ftt-stat" title="全部类目记忆条目之和">总记忆数 ' + totalMemory() + '</span>'
        + '<button class="ftt-close" data-ftt-action="close">✕</button></div>';
    const tabs = '<div class="ftt-tabs">' + PANEL_TABS.map(([t, l]) =>
        '<a href="javascript:void(0)" class="ftt-tab' + (t === active ? ' ftt-on' : '') + '" data-ftt-tab="' + attr(t) + '">' + esc(l) + '</a>').join('') + '</div>';
    const bodies = PANEL_TABS.map(([t]) => '<div class="ftt-body" data-ftt-body="' + attr(t) + '" style="' + (t === active ? '' : 'display:none') + '">' + panelBodyHtml(t) + '</div>').join('\n');
    return '<div class="ftt-modal">' + head + tabs + bodies + '</div>';
}

/** 找到（或创建）浮层元素：优先 body，退到任意扩展容器（桩 DOM 无 body 时也能工作） */
function ensureOverlay() {
    const doc = docEl();
    if (!doc) return null;
    let el = null;
    try { el = typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null; } catch (e) { el = null; }
    if (el) { overlayEl = el; return el; }
    if (!doc.body) return null;
    try {
        if (typeof doc.body.insertAdjacentHTML === 'function') {
            doc.body.insertAdjacentHTML('beforeend', '<div id="' + PANEL_ID + '" class="ftt-open"></div>');
            el = typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null;
        }
    } catch (e) { el = null; }
    if (!el) {
        // 兜底：宿主不解析 HTML（无 DOM 树 / 无 getElementById 回查）时，用内存元素承接渲染，
        //   保证「打开面板」在任何宿主都成立；真实浏览器里 insertAdjacentHTML 后必能回查到节点，不会走这里。
        try {
            overlayEl = {
                id: PANEL_ID, html: '', synthetic: true,
                insertAdjacentHTML(pos, html) { this.html += String(html); },
                addEventListener() { /* 无 DOM 事件 */ },
                classList: { add() { }, remove() { } },
            };
            return overlayEl;
        } catch (e) { return null; }
    }
    overlayEl = el;
    bindOverlay();
    return el;
}

/** 渲染（真实 DOM 用 innerHTML 替换；桩 DOM 记录到 el.html） */
export function renderPanel() {
    const el = overlayEl || ensureOverlay();
    const html = panelHtml();
    if (!el) return html;
    try { if (typeof el.innerHTML === 'string') { el.innerHTML = html; return html; } } catch (e) { /* 落到桩路径 */ }
    try { if (typeof el.insertAdjacentHTML === 'function') el.insertAdjacentHTML('beforeend', html); else el.html = html; } catch (e) { /* 忽略 */ }
    return html;
}

/** 打开浮层（V1 的主入口行为） */
export function openPanel(tab) {
    const t = PANEL_TABS.some((x) => x[0] === tab) ? tab : (PANEL_TABS.some((x) => x[0] === cfg.uiFirstTab) ? cfg.uiFirstTab : 'overview');
    ps.tab = t;
    ps.open = true;
    ps.opened += 1;
    const el = ensureOverlay();
    if (!el) return { ok: false, reason: '无法创建浮层（无 body 且无扩展容器）', tab: t };
    try { el.classList && el.classList.add && el.classList.add('ftt-open'); } catch (e) { /* 忽略 */ }
    try { bindEscClose(); } catch (e) { /* 忽略 */ }
    renderPanel();
    return { ok: true, via: 'overlay', tab: t, tabs: PANEL_TABS.map((x) => x[0]) };
}

/** 关闭浮层 */
export function closePanel() {
    ps.open = false;
    const el = overlayEl;
    if (!el) return true;
    try { if (el.classList && el.classList.remove) el.classList.remove('ftt-open'); } catch (e) { /* 忽略 */ }
    try { if (typeof el.innerHTML === 'string') el.innerHTML = ''; } catch (e) { /* 忽略 */ }
    return true;
}
export function panelOpen() { return ps.open; }

function setNote(text) { ps.note = String(text == null ? '' : text); return ps.note; }

/**
 * 面板动作（唯一入口；真实 DOM 与测试共用）。
 * action: tab | close | search | edit | edit-cancel | save | delete | refresh | summary | extractNow | inject
 *         | summaryFloor | clear-inject | check-update
 */
export async function panelAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    let result = { ok: true, action: a };
    try {
        if (a === 'tab') { ps.tab = String(p.tab || 'overview'); ps.editing = null; ps.peek = ''; }
        else if (a === 'close') { closePanel(); }
        else if (a === 'search') { ps.q[String(p.kind || '')] = String(p.q == null ? '' : p.q); }
        else if (a === 'edit' || a === 'editEntry') { ps.editing = { kind: String(p.kind || ''), id: String(p.id || ''), preset: p.preset || null }; }
        else if (a === 'edit-cancel' || a === 'editCancel' || a === 'closeEntry' || a === 'cancelEntry') { ps.editing = null; }
        else if (a === 'add' || a === 'addEntry') { ps.editing = { kind: String(p.kind || ps.tab), id: '', preset: p.preset || null }; }
        else if (a === 'addStateFor') { ps.editing = { kind: 'states', id: '', preset: { subject: String(p.subject || '') } }; }
        else if (a === 'addChildScene') {
            const parent = String(p.id || '');
            ps.editing = { kind: 'scenes', id: '', preset: { parentSceneId: parent } };
        }
        else if (a === 'multiToggle') { const k = String(p.kind || ps.tab); ps.multi[k] = !(ps.multi[k] === true); }
        else if (a === 'selectAll') { const k = String(p.kind || ps.tab); const set = selOf(k); listOf(k, ps.q[k], 300).forEach((x) => set.add(String(x.id || ''))); }
        else if (a === 'selectNone') { selOf(String(p.kind || ps.tab)).clear(); }
        else if (a === 'bulkDelete') {
            const k = String(p.kind || ps.tab);
            const set = selOf(k);
            const ids = Array.from(set);
            let n = 0;
            for (const id of ids) { try { if (consoleDelete(dataKindOf(k), id).ok) n++; } catch (e2) { /* 单条失败不影响其余 */ } }
            set.clear();
            setNote('已删除 ' + n + ' 条（多选批量删除 · 含跨端墓碑）');
            result = Object.assign(result, { ok: true, deleted: n });
        }
        else if (a === 'searchClear') { const k = String(p.searchKind || p.kind || ps.tab); ps.q[k] = ''; selOf(k).clear(); }
        else if (a === 'atomToggleHidden') { ps.showHidden = !ps.showHidden; }
        else if (a === 'atomPeek') { const id = String(p.id || ''); ps.peek = (ps.peek === id) ? '' : id; }
        else if (a === 'atomPeekClose') { ps.peek = ''; }
        else if (a === 'delStateGroup') {
            const subj = String(p.subject || '');
            const before = (state.currentStates || []).length;
            const gone = (state.currentStates || []).filter((x) => String(x && x.subject || '') === subj);
            for (const g of gone) { try { consoleDelete('currentStates', String(g.id || '')); } catch (e2) { /* 忽略 */ } }
            setNote('已删除「' + subj + '」的 ' + (before - (state.currentStates || []).length) + ' 条状态');
        }
        else if (a === 'save') {
            const kind = String(p.kind || '');
            const id = String(p.id || '');
            const fields = p.fields || {};
            // V1 口径：表单 → deconstructEntry → 入库 raw（数组/分组/父级路径/文本行解析都在此处）
            let raw = fields;
            try { raw = deconstructEntry(kind, Object.assign({}, fields, id ? { id } : {})); } catch (e) { raw = fields; }
            const r = consoleSave(dataKindOf(kind), id, raw);
            setNote(r.ok ? ('已保存 ' + (id || '（新增）')) : ('保存失败：' + String(r.reason || '')));
            result = Object.assign(result, r);
            ps.editing = null;
        } else if (a === 'delete') {
            const r = consoleDelete(dataKindOf(String(p.kind || '')), String(p.id || ''));
            setNote(r.ok ? '已删除 ' + String(p.id || '') + '（已留墓碑）' : '删除失败');
            result = Object.assign(result, r);
        } else if (a === 'summary') {
            // V1「⚡ 立即 AI 摘要」：分段批量（cfg.summaryChunkSize 楼/段）
            if (typeof hooks.autoSummary !== 'function') { setNote('批量摘要入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setNote('分析中…（分段批量摘要）');
            ps.busy = true;
            renderPanel();
            const r = await hooks.autoSummary({ silent: false });
            ps.busy = false;
            setNote(r && r.ok
                ? ('摘要完成：' + r.segments + ' 段 · 读取楼层 ' + r.floors + ' · 新增 ' + r.added + ' 条' + (r.aborted ? '（中断：剩余 ' + r.aborted + ' 段未分析）' : ''))
                : ('未完成：' + String((r && r.reason) || '未知') + (r && r.failed ? '（失败 ' + r.failed + ' 段）' : '')));
        } else if (a === 'extractNow') {
            if (typeof hooks.extract !== 'function') { setNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setNote('分析中…');
            const r = await hooks.extract({});
            setNote(r && Array.isArray(r.results)
                ? ('分析完成：成功 ' + r.done + ' / ' + r.results.length + (r.note ? '（' + r.note + '）' : ''))
                : (r && r.ok ? ('新增 ' + r.added + ' 条（共 ' + r.total + '）') : ('未完成：' + String((r && r.reason) || '未知'))));
        } else if (a === 'abortAnalysis' || a === 'abort') {
            const r = (typeof hooks.abort === 'function') ? hooks.abort() : { ok: false };
            setNote(r && r.busy ? '已请求中断：当前段完成后停止' : '当前没有正在运行的分析任务');
        } else if (a === 'clearFloors') {
            const r = (typeof hooks.clearFloors === 'function') ? hooks.clearFloors() : { ok: false };
            setNote(r && r.ok ? ('已清空已处理楼层记录（' + (r.cleared || 0) + ' 个）') : '清空失败');
        } else if (a === 'summaryFloor') {
            const floor = Number(p.floor);
            if (typeof hooks.extract !== 'function') { setNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setNote('分析第 ' + floor + ' 楼…');
            const r = await hooks.extract({ floor });
            // 兼容两种返回形态：单楼结果 {ok, added, total} 与批量结果 {ok, results:[{floor,added,…}]}
            let added = r && r.added, total = r && r.total, ok = !!(r && r.ok);
            if (r && Array.isArray(r.results)) {
                const hit = r.results.filter((x) => Number(x && x.floor) === floor)[0] || r.results[0] || null;
                ok = !!(hit && hit.ok);
                added = hit ? hit.added : 0;
            }
            setNote(ok ? ('第 ' + floor + ' 楼：新增 ' + (Number(added) || 0) + ' 条' + (total === undefined ? '' : '（共 ' + total + '）'))
                : ('第 ' + floor + ' 楼未完成：' + String((r && r.reason) || '未知')));
        } else if (a === 'inject') {
            if (typeof hooks.inject !== 'function') { setNote('注入入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            const r = await hooks.inject();
            setNote(r && r.ok ? ('已注入 ' + r.chars + ' 字') : ('注入失败：' + String((r && r.reason) || '未知')));
        } else if (a === 'clear-inject') {
            if (typeof hooks.clearInject === 'function') hooks.clearInject();
            setNote('已清空注入');
        } else if (a === 'check-update') {
            if (typeof hooks.checkUpdate === 'function') { setNote('检查更新…'); await hooks.checkUpdate(); setNote('检查完成'); }
            else setNote('更新入口未就绪');
        } else if (a === 'msub') {
            const tab = String(p.tab || ps.tab);
            const id = String(p.sub || 'list');
            ps.relSub[tab] = (id === 'rel' || id === 'check') ? id : 'list';
            if (id === 'check' && typeof p.keywords !== 'undefined') { try { setCheckKeywords(p.keywords || []); } catch (e) { /* 忽略 */ } }
        }
        else if (a === 'relEdit') { ps.editing = { kind: String(p.kind || ''), id: String(p.id || ''), preset: null }; }
        else if (a === 'relWho') {
            ps.relWho = String(p.who == null ? '' : p.who);
            if (ps.relWho) {
                try {
                    const hits = relByWho(ps.relWho);
                    if (hits.length) ps.editing = { kind: hits[0].dim, id: hits[0].refId, preset: null };
                } catch (e) { /* 忽略 */ }
            }
        }
        else if (a.indexOf('rel') === 0 && a !== 'reload') {
            const rr = relAction(a, p);
            setNote(rr.ok ? ('关系：' + (rr.saved !== undefined ? ('已保存 ' + rr.saved + ' 行 / 新增 ' + (rr.added || 0) + ' · 更新 ' + (rr.updated || 0) + (rr.skipped ? (' · 跳过空行 ' + rr.skipped) : '')) : (rr.cleared !== undefined ? ('已清空 ' + rr.cleared + ' 行') : (rr.swept !== undefined ? ('已清扫孤儿 ' + rr.swept + ' 行') : (rr.dropped !== undefined ? ('已清除推定 ' + rr.dropped + ' 行') : ('行数 ' + (rr.rows || 0))))))) : ('关系操作失败：' + String(rr.reason || '未知')));
            result = Object.assign(result, rr);
        }
        else if (a === 'checkRefresh' || a === 'checkMode') {
            const cr = injectCheckAction(a, { mode: p.mode });
            setNote(a === 'checkMode' ? ('自查口径：' + (cr.useKeywords ? '按最近关键词' : '按本地召回')) : '已按当前数据刷新注入自查预览');
            result = Object.assign(result, cr);
        }
        else if (a === 'settingsSub') {
            const id = String(p.sub || p.kind || '');
            ps.settingsSub = SETTINGS_TABS.some((t) => t.id === id) ? id : ps.settingsSub;
        }
        else if (a === 'exportState') {
            if (typeof hooks.exportState !== 'function') { setNote('导出入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            const text = String((await hooks.exportState()) || '');
            ps.exportText = text;
            let copied = false;
            try {
                const nav = globalThis.navigator;
                if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); copied = true; }
            } catch (e) { copied = false; }
            setNote('已导出 ' + text.length + ' 字符' + (copied ? '（已复制到剪贴板）' : '（见下方文本框，可手动复制）'));
            result = Object.assign(result, { ok: true, chars: text.length, copied });
        }
        else if (a === 'importStateOpen') { setNote('在「导入 JSON」文本框粘贴内容后点「导入」'); }
        else if (a === 'importV1Dry' || a === 'importV1Apply') {
            if (typeof hooks.importV1 !== 'function') { setNote('V1 导入入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            const apply = a === 'importV1Apply';
            setNote(apply ? '导入并写入…' : '读取 V1 数据…');
            const r = await hooks.importV1({ apply });
            const t = (r && r.report && r.report.totals) || {};
            setNote((apply ? '【已写入】' : '【干跑】') + (r && r.via ? r.via : '无源数据')
                + '：新增 ' + (t.add || 0) + ' · 已存在 ' + (t.exist || 0) + ' · 冲突 ' + (t.conflict || 0));
        }
        else if (a === 'dimToggle') {
            if (typeof hooks.dimToggle === 'function') hooks.dimToggle(String(p.kind || ''), !!p.on);
            setNote('维度 ' + String(p.kind || '') + (p.on ? ' 已启用' : ' 已停用'));
        }
        else if (a === 'importStateApply') {
            if (typeof hooks.importState !== 'function') { setNote('导入入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            const el = (() => { try { const doc = globalThis.document; return doc && doc.querySelector ? doc.querySelector('[data-ftt-import]') : null; } catch (e) { return null; } })();
            const text = String(p.text != null ? p.text : (el ? el.value : ''));
            if (!text.trim()) { setNote('导入失败：文本框为空'); return { ok: false, reason: 'empty' }; }
            const r = await hooks.importState(text);
            setNote(r && r.ok ? ('已导入并合并：新增 ' + (r.added || 0) + ' 条') : ('导入失败：' + String((r && r.reason) || '未知')));
            result = Object.assign(result, r || {});
        }
        else if (a === 'refresh' || a === 'noop') { /* 仅重渲染 */ }
        else { result = { ok: false, reason: 'unknown-action' }; }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
        setNote('操作失败：' + result.error);
    }
    renderPanel();
    return Object.assign(result, { html: panelHtml(), state: panelState() });
}

/** 读取某配置键当前值（用于 change 时判断是否按数字写回） */
function readControlValue(key) {
    try {
        const k = String(key || '');
        if (k.indexOf('storage.') === 0) return (cfg.storage || {})[k.slice(8)];
        return cfg[k];
    } catch (e) { return undefined; }
}

/** 真实 DOM 事件委托（V1 用委托；无 addEventListener 的环境跳过） */
export function bindOverlay() {
    const el = overlayEl;
    const doc = docEl();
    if (!el) return false;
    if (typeof el.addEventListener === 'function' && !el.__fttBound) {
        el.__fttBound = true;
        el.addEventListener('click', (e) => {
            const tg = e && e.target;
            const tabEl = tg && tg.closest ? tg.closest('[data-ftt-tab]') : null;
            if (tabEl) { void panelAction('tab', { tab: tabEl.getAttribute('data-ftt-tab') }); return; }
            const act = tg && tg.dataset ? String(tg.dataset.fttAction || '') : '';
            if (!act) { if (tg === el) void panelAction('close', {}); return; }
            const kind = tg.dataset ? tg.dataset.kind : '';
            const id = tg.dataset ? tg.dataset.id : '';
            const floor = tg.dataset ? tg.dataset.fttFloor : '';
            const subject = tg.dataset ? tg.dataset.fttSubject : '';
            if (act === 'save') {
                void panelAction('save', { kind, id, fields: collectEditorFields(el) });
                return;
            }
            const msub = tg.dataset ? String(tg.dataset.fttMsub || '') : '';
            if (msub) { void panelAction('msub', { tab: ps.tab, sub: msub }); return; }
            if (act === 'settingsSub') {
                void panelAction('settingsSub', { sub: tg.dataset ? tg.dataset.fttSettings : '' });
                return;
            }
            if (act === 'multiToggle' || act === 'selectAll' || act === 'selectNone' || act === 'bulkDelete' || act === 'searchClear' || act === 'add') {
                void panelAction(act, { kind: kind || (tg.dataset ? tg.dataset.fttKind : '') || ps.tab, id, searchKind: tg.dataset ? tg.dataset.fttSearchKind : '', subject });
                return;
            }
            void panelAction(act, { kind, id, floor, subject });
        });
        if (typeof el.addEventListener === 'function') {
            el.addEventListener('change', (e) => {
                const tg = e && e.target;
                if (!tg || !tg.dataset) return;
                if (tg.dataset.fttSearch !== undefined) { void panelAction('search', { kind: tg.dataset.fttSearch, q: tg.value }); return; }
                if (tg.dataset.fttRelWho !== undefined) { void panelAction('relWho', { who: tg.value }); return; }
                if (tg.dataset.fttV2 !== undefined) {
                    const k = String(tg.dataset.fttV2);
                    const raw = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value);
                    applySettingsControl(k, raw);
                    setNote('已更新 ' + k);
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttDim !== undefined) {
                    void panelAction('dimToggle', { kind: String(tg.dataset.fttDim), on: !!tg.checked });
                    return;
                }
                if (tg.dataset.fttCfg !== undefined) {
                    // 设定控件写回（V1 同款 `data-ftt-cfg`）：bool 用 checked，其余按原值类型写回
                    const key = String(tg.dataset.fttCfg);
                    let raw = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value);
                    if (typeof readControlValue(key) === 'number' && /^-?\d+(\.\d+)?$/.test(String(raw))) raw = Number(raw);
                    applySettingsControl(key, raw);
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttSelect !== undefined) {
                    const k = String(tg.dataset.fttSelect);
                    const set = selOf(k);
                    if (tg.checked) set.add(String(tg.dataset.fttId || '')); else set.delete(String(tg.dataset.fttId || ''));
                }
            });
        }
    }
    try {
        const box = el.querySelector ? el.querySelector('[data-ftt-rel-body]') : null;
        if (box && typeof box.querySelectorAll === 'function') {
            for (const node of box.querySelectorAll('[data-ftt-relf]')) {
                node.addEventListener('change', () => {
                    try {
                        const body = String(box.getAttribute('data-ftt-rel-body') || '');
                        const [dim, refId] = body.split('|');
                        const rowEl = node.closest ? node.closest('[data-ftt-rel-idx]') : null;
                        const idx = Number((rowEl && rowEl.getAttribute('data-ftt-rel-idx')) || 0);
                        const field = String(node.getAttribute('data-ftt-relf'));
                        const val = (node.type === 'checkbox') ? !!node.checked : String(node.value == null ? '' : node.value);
                        relAction('relSetRow', { kind: dim, id: refId, idx, row: { [field]: val } });
                    } catch (e) { /* 忽略 */ }
                });
            }
        }
    } catch (e) { /* 关系表绑定失败不影响面板 */ }
    try { bindPanelEvents(); } catch (e) { /* 设置分页表单绑定 */ }
    return true;
}

/** Esc 关闭（V1 同款） */
export function bindEscClose() {
    if (escBound) return true;
    const doc = docEl();
    try {
        if (doc && typeof doc.addEventListener === 'function') {
            doc.addEventListener('keydown', (e) => { if (e && (e.key === 'Escape' || e.keyCode === 27)) closePanel(); });
            escBound = true;
        }
    } catch (e) { /* 忽略 */ }
    return escBound;
}

/** 卸载（disable / delete） */
export function unmountPanel() {
    closePanel();
    const doc = docEl();
    try {
        const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null;
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
    } catch (e) { /* 忽略 */ }
    overlayEl = null;
    ps.open = false;
    return true;
}

/** 面板配置摘要（诊断） */
export function panelConfig() {
    return { id: PANEL_ID, tabs: PANEL_TABS.map((t) => t[0]), firstTab: cfg.uiFirstTab, dims: DIMENSIONS.length, floors: (() => { try { return Number(getLastMessageId()) + 1; } catch (e) { return 0; } })() };
}
