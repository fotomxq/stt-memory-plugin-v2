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

export const PANEL_ID = 'ftt-panel';
/** V1 的 13 个分页（id 与标签逐字一致） */
export const PANEL_TABS = Object.freeze([
    ['overview', '总览'], ['atoms', '情节'], ['states', '状态'], ['snapshots', '角色'],
    ['memories', '记忆'], ['items', '物品'], ['currencies', '货币'], ['rumors', '传言'],
    ['plans', '计划悬念'], ['scenes', '场景'], ['concepts', '概念'], ['parallels', '平行'], ['settings', '设置'],
]);
/** 分页 id → 维度容器键（状态存 currentStates；计划悬念页含 plans+suspense） */
const TAB_DIM = { atoms: 'atoms', states: 'currentStates', snapshots: 'snapshots', memories: 'memories', items: 'items', currencies: 'currencies', rumors: 'rumors', plans: 'plans', scenes: 'scenes', concepts: 'concepts', parallels: 'parallels' };

const ps = { tab: 'overview', open: false, q: {}, editing: null, note: '', opened: 0 };
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
    };
}
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

function arrOf(kind) { try { return Array.isArray(state[kind]) ? state[kind] : []; } catch (e) { return []; } }
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

/** 维度列表（V1 同款行样式 + 搜索 + 编辑/删除） */
function dimBody(kind) {
    const q = ps.q[kind] || '';
    const list = consoleList(kind, q, 200);
    const total = arrOf(kind).length;
    const head = '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-search="' + attr(kind) + '" value="' + attr(q) + '" placeholder="搜索（标题 / 正文 / 标签 / 归属）">'
        + '<span class="ftt-muted">' + (q ? '匹配 ' + list.length + ' / ' : '共 ') + total + ' 条</span></div>';
    const ed = ps.editing && ps.editing.kind === kind ? editorHtml(kind, ps.editing.id) : '';
    if (!list.length) return head + ed + '<div class="ftt-empty">（' + (q ? '没有匹配的条目' : '该类目暂无条目') + '）</div>';
    return head + ed + list.map((e) => {
        const id = String(e.id || '');
        const meta = [e.date || e.seenDate || '', Number(e.uses) ? '调用 ' + e.uses + ' 次' : '', e.who || e.owner || ''].filter(Boolean).join(' · ');
        return '<div class="ftt-item ftt-inline">'
            + '<span class="ftt-grow"><b>' + esc(entrySummary(e)) + '</b>' + (meta ? ' <span class="ftt-muted">' + esc(meta) + '</span>' : '') + '</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="编辑">✏️</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="删除（留墓碑）">🗑</button>'
            + '</div>';
    }).join('\n');
}

/** 编辑器（V1 的 `ftt-editor` 结构；字段与 V2 数据模型对应） */
function editorHtml(kind, id) {
    const d = consoleEntry(kind, id);
    if (!d) return '<div class="ftt-empty">（条目已不存在）</div>';
    const it = d.item || {};
    const f = (label, key, val, type) => '<div class="ftt-field"><label>' + esc(label) + '</label>'
        + (type === 'textarea'
            ? '<textarea data-ftt-ed="' + attr(key) + '" rows="4">' + esc(val) + '</textarea>'
            : '<input type="' + (type || 'text') + '" data-ftt-ed="' + attr(key) + '" value="' + attr(val) + '">')
        + '</div>';
    return '<div class="ftt-editor">'
        + '<div class="ftt-editor-title">✏️ 编辑 · ' + esc(id) + ' · 内容哈希 ' + esc(d.hash || '') + '</div>'
        + f('标题 / 名称', 'title', it.title || it.name || '')
        + f('正文 / 内容', 'text', it.text || it.content || '', 'textarea')
        + f('日期', 'date', it.date || '')
        + f('标签', 'tags', (Array.isArray(it.tags) ? it.tags : []).join('、'))
        + f('重要度', 'importance', it.importance === undefined ? '' : it.importance, 'number')
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="save" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '">💾 保存</button>'
        + '<button class="ftt-btn" data-ftt-action="editCancel">取消</button></div>'
        + '<div class="ftt-hint">关联：' + (d.rels && d.rels.length ? esc(d.rels.map((r) => (r.who || '公共') + (r.how ? '(' + r.how + ')' : '')).join('、')) : '（无）') + '</div>'
        + '</div>';
}

/** 设置分页（B1 沿用 V2 现有表单；B4 将替换为 V1 的 13 组子页） */
function settingsBody() {
    return '<div class="ftt-hint">本页为现有设置表单；V1 的 13 组设定子页（分析记忆 / 提示词 / 存储 / 时钟巡检 / 关联层 / 传言 / 内容弱化 / 情节与分段总结 / 修复与遗忘 …）按 docs/P8-功能对齐总表.md 的批次逐页替换。</div>'
        + fallbackPanelHtml(panelData());
}

/** 分页内容 */
export function panelBodyHtml(tab) {
    const t = tab || ps.tab;
    try {
        if (t === 'overview') return overviewBody();
        if (t === 'settings') return settingsBody();
        if (t === 'plans') return dimBody('plans') + '<h4 class="ftt-h4-inline">悬念</h4>' + dimBody('suspense');
        const kind = TAB_DIM[t];
        if (kind) return dimBody(kind);
        return '<div class="ftt-empty">（该分页尚未实现）</div>';
    } catch (e) { return '<div class="ftt-empty">渲染失败：' + esc(String((e && e.message) || e)) + '</div>'; }
}

/** 整个浮层 HTML（与 V1 同名同层级；V1 样式挂在 #ftt-panel 上） */
export function panelHtml() {
    const active = PANEL_TABS.some((x) => x[0] === ps.tab) ? ps.tab : 'overview';
    const nameTxt = (() => { try { return String(getScopeKey() || ''); } catch (e) { return ''; } })();
    const head = '<div class="ftt-modal-head">'
        + '<span class="ftt-title">📖 FTT记忆组件 ' + esc(VERSION) + (nameTxt ? ' · ' + esc(nameTxt) : '') + '</span>'
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
    if (!el) return null;
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
        if (a === 'tab') { ps.tab = String(p.tab || 'overview'); ps.editing = null; }
        else if (a === 'close') { closePanel(); }
        else if (a === 'search') { ps.q[String(p.kind || '')] = String(p.q == null ? '' : p.q); }
        else if (a === 'edit') { ps.editing = { kind: String(p.kind || ''), id: String(p.id || '') }; }
        else if (a === 'edit-cancel' || a === 'editCancel') { ps.editing = null; }
        else if (a === 'save') {
            const r = consoleSave(String(p.kind || ''), String(p.id || ''), p.fields || {});
            setNote(r.ok ? '已保存 ' + String(p.id || '') : ('保存失败：' + String(r.reason || '')));
            result = Object.assign(result, r);
            ps.editing = null;
        } else if (a === 'delete') {
            const r = consoleDelete(String(p.kind || ''), String(p.id || ''));
            setNote(r.ok ? '已删除 ' + String(p.id || '') + '（已留墓碑）' : '删除失败');
            result = Object.assign(result, r);
        } else if (a === 'summary' || a === 'extractNow') {
            if (typeof hooks.extract !== 'function') { setNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setNote('分析中…');
            const r = await hooks.extract({});
            setNote(r && Array.isArray(r.results)
                ? ('分析完成：成功 ' + r.done + ' / ' + r.results.length + (r.note ? '（' + r.note + '）' : ''))
                : (r && r.ok ? ('新增 ' + r.added + ' 条（共 ' + r.total + '）') : ('未完成：' + String((r && r.reason) || '未知'))));
        } else if (a === 'summaryFloor') {
            const floor = Number(p.floor);
            if (typeof hooks.extract !== 'function') { setNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setNote('分析第 ' + floor + ' 楼…');
            const r = await hooks.extract({ floor });
            setNote(r && r.ok ? ('第 ' + floor + ' 楼：新增 ' + r.added + ' 条（共 ' + r.total + '）') : ('第 ' + floor + ' 楼未完成：' + String((r && r.reason) || '未知')));
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
        } else if (a === 'refresh' || a === 'noop') { /* 仅重渲染 */ }
        else { result = { ok: false, reason: 'unknown-action' }; }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
        setNote('操作失败：' + result.error);
    }
    renderPanel();
    return Object.assign(result, { html: panelHtml(), state: panelState() });
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
            if (act === 'save') {
                const g = (k) => { const n = doc && typeof doc.getElementById === 'function' ? null : null; const q = el.querySelector ? el.querySelector('[data-ftt-ed="' + k + '"]') : null; return q ? q.value : (n ? '' : ''); };
                void panelAction('save', { kind, id, fields: { title: g('title'), text: g('text'), date: g('date'), tags: g('tags'), importance: g('importance') } });
                return;
            }
            void panelAction(act, { kind, id, floor });
        });
        if (typeof el.addEventListener === 'function') {
            el.addEventListener('change', (e) => {
                const tg = e && e.target;
                if (tg && tg.dataset && tg.dataset.fttSearch !== undefined) void panelAction('search', { kind: tg.dataset.fttSearch, q: tg.value });
            });
        }
    }
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
