// ============================================================
// ui/popup.js —— **弹窗主界面**（对齐 V1：扩展入口点开一个弹窗，内含分页）
// 用户要求（原话）：「原先扩展内增加按钮，会弹窗方式处置，包括访问记忆」「V1 弹窗已经身经百战很好用」。
// 分页：
//   overview  总览（状态 / 维度计数 / 注入自查合计 / 快捷动作）
//   console   数据台（14 维浏览·搜索·编辑·删除·注入自查 —— ui/console.js）
//   extract   提取（未分析楼层清单 + 逐楼「分析」+ 全部分析 + 统计）
//   settings  设置（内核配置 / 更新 / V1 导入 / 诊断 —— 复用设定面板表单）
// 约定：渲染与动作分离（popupHtml / popupAction / writePopupBody），真实 DOM 用 `[data-ftt-tab]` 等属性接线，
//   无 querySelectorAll 的环境（桩/测试）直接调 popupAction，因此逻辑可完整测。
// 弹窗宿主：ST 的 `callGenericPopup(html, POPUP_TYPE.TEXT)`；不可用时退回「打开抽屉面板」。
// ============================================================
import { VERSION } from '../core/constants.js';
import { state, cfg } from '../core/model/runtime.js';
import { getCtx } from '../host/st-api.js';
import { readInject } from '../host/inject.js';
import { DIMENSIONS } from '../core/constants.js';
import { consoleHtml, writeConsole, bindConsole, consoleSummary, injectAudit, consoleAction } from './console.js';
import { fallbackPanelHtml, panelData, panelMountInfo, setPanelHooks as setPanelHooksRef, bindPanelEvents } from './settings-panel.js';

export const POPUP_ID = 'ftt_v2_popup';
const TABS = [
    { id: 'overview', label: '总览' },
    { id: 'console', label: '数据台' },
    { id: 'extract', label: '提取' },
    { id: 'settings', label: '设置' },
];
const ps = { tab: 'overview', note: '', open: false, opened: 0 };
let popupHooks = {};

/** 注入弹窗动作钩子（index.js 装配时调用） */
export function setPopupHooks(hooks) { popupHooks = Object.assign({}, popupHooks, hooks || {}); return popupHooks; }
/** 弹窗状态（测试/诊断） */
export function popupState() { return Object.assign({}, ps, { tabs: TABS.map((t) => t.id) }); }
export function popupTabs() { return TABS.slice(); }
export function popupInfo() {
    const ctx = getCtx();
    return {
        id: POPUP_ID, tab: ps.tab, opened: ps.opened, open: ps.open, note: ps.note,
        canPopup: !!(ctx && typeof ctx.callGenericPopup === 'function'),
        showDrawer: cfg.uiShowDrawer === true, showFloating: cfg.uiShowFloating !== false,
        mount: panelMountInfo(),
    };
}

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 总览分页：状态 + 维度计数 + 注入自查合计 + 快捷动作 */
function overviewHtml() {
    const sum = consoleSummary();
    const audit = injectAudit({ rows: false });
    const counts = sum.dims.filter((d) => d.count > 0).map((d) => esc(d.label) + ' ' + d.count).join(' · ') || '（暂无条目）';
    const lines = [
        '版本 ' + VERSION + (sum.scope ? ' · 作用域 ' + esc(sum.scope) : ''),
        '条目合计 ' + sum.total + '（' + counts + '）',
        '当前注入 ' + audit.chars + ' 字（命中 ' + audit.injected + ' / 未命中 ' + audit.missing + '）',
        '内核配置 ' + Object.keys(cfg || {}).length + ' 键 · 注入预算 ' + (Number(cfg.charBudget) || 0) + ' 字符',
        '面板容器 ' + panelMountInfo().candidates.join(' / '),
    ];
    return [
        '<div class="ftt-pop-sec"><div class="ftt-pop-title">总览</div><div class="ftt-pop-note">' + lines.map(esc).join('<br>') + '</div></div>',
        '<div class="ftt-pop-actions">',
        '<button class="menu_button" data-ftt-pop="analyze-all">🧠 分析未分析楼层</button>',
        '<button class="menu_button" data-ftt-pop="refresh">🔄 刷新</button>',
        '<button class="menu_button" data-ftt-pop="clear-inject">🧹 清空注入</button>',
        '<button class="menu_button" data-ftt-pop="check-update">🔍 检查更新</button>',
        '</div>',
    ].join('');
}

/** 提取分页：未分析楼层清单 + 逐楼分析 + 全部分析 */
function extractHtml() {
    const pending = (typeof popupHooks.pending === 'function') ? (popupHooks.pending({}) || []) : [];
    const stats = (typeof popupHooks.extractStatus === 'function') ? (popupHooks.extractStatus() || {}) : {};
    const rows = pending.slice(0, 80).map((f) => '<div class="ftt-pop-floor" data-ftt-floor="' + esc(f) + '">' +
        '<span>第 ' + esc(f) + ' 楼</span>' +
        '<button class="menu_button" data-ftt-pop="analyze-floor" data-floor="' + esc(f) + '">分析</button></div>').join('');
    return [
        '<div class="ftt-pop-sec"><div class="ftt-pop-title">提取（未分析楼层 ' + pending.length + '）</div>',
        '<div class="ftt-pop-note">运行 ' + Number(stats.runs || 0) + ' · 成功 ' + Number(stats.ok || 0) + ' · 失败 ' + Number(stats.fail || 0)
        + (stats.lastReason ? '（最近 ' + esc(stats.lastReason) + '）' : '') + '</div>',
        '<div class="ftt-pop-actions"><button class="menu_button" data-ftt-pop="analyze-all">🧠 分析全部未分析楼层</button></div>',
        (rows || '<div class="ftt-pop-note">没有未分析楼层（或宿主未提供楼层读取）。</div>'),
        '</div>',
    ].join('');
}

/** 当前分页内容 */
export function popupBodyHtml(tab) {
    const t = tab || ps.tab;
    try {
        if (t === 'console') return '<div class="ftt-pop-sec"><div class="ftt-pop-title">数据台</div><div id="ftt_v2_console"></div></div>';
        if (t === 'extract') return extractHtml();
        if (t === 'settings') return '<div class="ftt-pop-sec"><div class="ftt-pop-title">设置</div>' + fallbackPanelHtml(panelData()) + '</div>';
        return overviewHtml();
    } catch (e) { return '<div class="ftt-pop-note">渲染失败：' + esc(String((e && e.message) || e)) + '</div>'; }
}

/** 弹窗完整 HTML（分页条 + 内容区 + 提示行） */
export function popupHtml(tab) {
    const cur = tab || ps.tab;
    const bar = TABS.map((t) => '<button class="menu_button ftt-pop-tab' + (t.id === cur ? ' ftt-pop-tab-on' : '') + '" data-ftt-tab="' + t.id + '">' + esc(t.label) + '</button>').join('');
    return [
        '<div class="ftt-pop" id="' + POPUP_ID + '">',
        '<div class="ftt-pop-bar">' + bar + '</div>',
        '<div class="ftt-pop-body" id="ftt_v2_popup_body">' + popupBodyHtml(cur) + '</div>',
        '<div class="ftt-pop-note" id="ftt_v2_popup_note">' + esc(ps.note) + '</div>',
        '</div>',
    ].join('');
}

/** 把内容区写进弹窗（真实 DOM 替换；桩 DOM 追加） */
function writePopupBody() {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ftt_v2_popup_body') : null;
    if (!el) return false;
    const html = popupBodyHtml(ps.tab);
    try { if (typeof el.innerHTML === 'string') { el.innerHTML = html; return true; } } catch (e) { /* 落到追加 */ }
    if (typeof el.insertAdjacentHTML === 'function') el.insertAdjacentHTML('beforeend', html);
    if (ps.tab === 'console') { try { writeConsole(); } catch (e) { /* 忽略 */ } }
    return true;
}

/** 提示行 */
function setPopupNote(text) {
    ps.note = String(text == null ? '' : text);
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ftt_v2_popup_note') : null;
    if (el) el.textContent = ps.note;
    return ps.note;
}

/**
 * 弹窗内动作（唯一入口；真实 DOM 与测试共用）。
 * @param {string} action tab | analyze-all | analyze-floor | clear-inject | check-update | refresh | console
 * @param {object} [payload]
 */
export async function popupAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    let result = { ok: true, action: a };
    try {
        if (a === 'tab') { ps.tab = String(p.tab || 'overview'); }
        else if (a === 'refresh') { /* 仅重渲染 */ }
        else if (a === 'analyze-all') {
            if (typeof popupHooks.extract !== 'function') { setPopupNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setPopupNote('分析中…');
            const r = await popupHooks.extract({});
            setPopupNote(r && Array.isArray(r.results)
                ? ('分析完成：成功 ' + r.done + ' / ' + r.results.length + (r.note ? '（' + r.note + '）' : ''))
                : (r && r.ok ? ('新增 ' + r.added + ' 条') : ('未完成：' + String((r && r.reason) || '未知'))));
        } else if (a === 'analyze-floor') {
            const floor = Number(p.floor);
            if (typeof popupHooks.extract !== 'function') { setPopupNote('提取入口未就绪'); return { ok: false, reason: 'no-hook' }; }
            setPopupNote('分析第 ' + floor + ' 楼…');
            const r = await popupHooks.extract({ floor });
            setPopupNote(r && r.ok ? ('第 ' + floor + ' 楼：新增 ' + r.added + ' 条（共 ' + r.total + '）') : ('第 ' + floor + ' 楼未完成：' + String((r && r.reason) || '未知')));
        } else if (a === 'clear-inject') {
            if (typeof popupHooks.clearInject === 'function') popupHooks.clearInject();
            setPopupNote('已清空注入');
        } else if (a === 'check-update') {
            if (typeof popupHooks.checkUpdate === 'function') { setPopupNote('检查更新…'); await popupHooks.checkUpdate(); setPopupNote('检查完成（详见设置分页/`/ftt`）'); }
            else setPopupNote('更新入口未就绪');
        } else if (a === 'console') {
            const r = consoleAction(String(p.consoleAction || 'refresh'), p.payload || {});
            result = Object.assign(result, { console: r });
        } else { result = { ok: false, reason: 'unknown-action' }; }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
        setPopupNote('操作失败：' + result.error);
    }
    writePopupBody();
    if (ps.tab === 'console') { try { writeConsole(); bindConsole(); } catch (e) { /* 忽略 */ } }
    return Object.assign(result, { html: popupHtml(), state: popupState() });
}

/** 真实 DOM 接线（无 querySelectorAll 的环境跳过；此时由调用方直接调 popupAction） */
export function bindPopup() {
    const doc = globalThis.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    const root = typeof doc.getElementById === 'function' ? doc.getElementById(POPUP_ID) : null;
    if (!root) return false;
    for (const el of doc.querySelectorAll('[data-ftt-tab]')) {
        el.addEventListener('click', () => { void popupAction('tab', { tab: el.getAttribute('data-ftt-tab') }); });
    }
    for (const el of doc.querySelectorAll('[data-ftt-pop]')) {
        const a = el.getAttribute('data-ftt-pop');
        el.addEventListener('click', () => { void popupAction(a, { floor: el.getAttribute('data-floor') }); });
    }
    try { bindConsole(); bindPanelEvents(); } catch (e) { /* 忽略 */ }
    return true;
}

/**
 * 打开弹窗（V1 风格的**主界面**入口）。
 * @param {string} [tab] 初始分页（默认取 cfg.uiFirstTab）
 * @returns {Promise<{ok:boolean, via:string, reason?:string, tab?:string}>}
 */
export async function openPopup(tab) {
    const t = TABS.some((x) => x.id === (tab || '')) ? tab : (TABS.some((x) => x.id === cfg.uiFirstTab) ? cfg.uiFirstTab : 'overview');
    ps.tab = t;
    ps.open = true;
    ps.opened += 1;
    ps.note = '';
    const ctx = getCtx();
    if (!ctx || typeof ctx.callGenericPopup !== 'function') {
        ps.open = false;
        return { ok: false, via: 'none', reason: 'callGenericPopup 不可用', tab: t };
    }
    try {
        const type = (ctx.POPUP_TYPE && (ctx.POPUP_TYPE.TEXT || ctx.POPUP_TYPE.DISPLAY)) || 1;
        const html = popupHtml(t);
        // 不 await 弹窗关闭（它是模态的）：先把引用与接线做好，让用户立即能操作
        try { bindPopup(); } catch (e) { /* 忽略 */ }
        const p = ctx.callGenericPopup(html, type, undefined, undefined, undefined);
        if (p && typeof p.then === 'function') p.then(() => { ps.open = false; }).catch(() => { ps.open = false; });
        return { ok: true, via: 'popup', tab: t };
    } catch (e) {
        ps.open = false;
        return { ok: false, via: 'popup', reason: String((e && e.message) || e), tab: t };
    }
}

/** 弹窗配置摘要（诊断/测试） */
export function popupConfig() {
    return { id: POPUP_ID, tabs: TABS.map((x) => x.id), firstTab: cfg.uiFirstTab, showDrawer: cfg.uiShowDrawer === true, dims: DIMENSIONS.length };
}
