// ============================================================
// ui/entries.js —— 「插件自建按钮入口」统一管理（v2.65.0，对齐 V1 v1.206）
//
// 触发（用户报告）：「设定的显示界面开关存在问题，应该与 V1 对齐，且根据需求展示对应的按钮入口。
//   其中注意，当前扩展中的窗口入口选项是**强制开启**的，禁止被关闭，且**不展示该开关**。」
//
// V1 事实源（v1.206）：
//   · `BTN_LOCATIONS = ['topbar','qr','float','menu']`；
//   · `BTN_LOC_LABELS = { topbar:'顶栏按钮', qr:'页面底部按钮', float:'悬浮按钮', menu:'扩展菜单项' }`；
//   · 默认 `buttonLocations = { topbar:false, qr:true, float:false, menu:false }`（V2 `core/config.js` 逐字同值）；
//   · `createTopbarButton` / `createQrButton` / `createFloatButton` / `createMenuButton` + `syncButtons()` 启停；
//   · 设置页 `buttonLocationRowsHtml()` 每行 = 名称 + 开关（`data-ftt-loc="<loc>"`）+ 显示/隐藏。
//
// V2 差异（用户要求，见 `docs/P10ac`）：
//   ① **扩展菜单项强制开启**（`FORCED_ENTRIES`）：忽略 `cfg.buttonLocations.menu=false`，设置页不展示该开关；
//      —— 它是 V2 唯一「必然可见」的入口（`#extensionsMenu`），关掉就只剩兜底。
//   ② 悬浮按钮区分来源（用户开启 / 可见性兜底），设置里关掉只移除「用户开启」的那一个（见 `ui/floating.js`）。
//   ③ 顶栏/页面底部按钮在宿主缺少对应容器时**不会出现**（如实返回 reason，不造假 DOM）。
// ============================================================
import { installMenuEntry, uninstallMenuEntry, menuInfo, menuInstalled } from './menu.js';
import { installFloatingEntry, uninstallFloatingEntry, floatingInfo, floatingInstalled } from './floating.js';

/** V1 逐字：入口位置与顺序 */
export const ENTRY_LOCATIONS = Object.freeze(['topbar', 'qr', 'float', 'menu']);
/** V1 逐字：入口名称 */
export const ENTRY_LABELS = Object.freeze({ topbar: '顶栏按钮', qr: '页面底部按钮', float: '悬浮按钮', menu: '扩展菜单项' });
/** 强制开启的入口（用户要求：扩展菜单项 = 主入口，禁止关闭、不展示开关） */
export const FORCED_ENTRIES = Object.freeze(['menu']);
/** V1 逐字：默认开关 */
export const ENTRY_DEFAULTS = Object.freeze({ topbar: false, qr: true, float: false, menu: false });

const TOPBAR_ID = 'ftt-topbar-button';
const QR_BTN_ID = 'ftt-qr-button';
const QR_BAR_ID = 'qr--bar';
const SEND_FORM_ID = 'send_form';

/** 模块跟踪的已安装节点（桩 DOM 不解析 HTML → 无法靠 getElementById 找回落点） */
let topbarBtn = null;
let qrBtn = null;
/** 最近一次注入的点击钩子（设置页改开关时无需重新注入宿主钩子） */
let lastHooks = null;

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 入口是否强制开启（强制项忽略配置的关闭意图） */
export function entryForced(loc) { return FORCED_ENTRIES.indexOf(String(loc)) >= 0; }

/** 归一化入口开关（缺省 → V1 默认；强制项恒 true） */
export function normalizeEntryLocations(locations) {
    const src = (locations && typeof locations === 'object') ? locations : {};
    const out = {};
    for (const loc of ENTRY_LOCATIONS) {
        if (entryForced(loc)) { out[loc] = true; continue; }
        out[loc] = (src[loc] === undefined || src[loc] === null) ? ENTRY_DEFAULTS[loc] === true : !!src[loc];
    }
    return out;
}

/** 单个入口当前是否应显示 */
export function entryEnabled(loc, locations) { return normalizeEntryLocations(locations)[String(loc)] === true; }

/** 把节点插进容器（优先节点插入；宿主只支持字符串插入时退化） */
function insertNode(host, node, html) {
    try {
        if (host && typeof host.appendChild === 'function') { host.appendChild(node); return true; }
        if (host && typeof host.insertAdjacentHTML === 'function') { host.insertAdjacentHTML('beforeend', html); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}

/** 绑定点击（统一：preventDefault + 吞异常 + 支持同步/异步 onClick） */
function bindClick(el, hooks) {
    try {
        if (!el || typeof el.addEventListener !== 'function') return;
        el.addEventListener('click', (e) => {
            try {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            } catch (err) { /* 忽略 */ }
            Promise.resolve()
                .then(() => (hooks && typeof hooks.onClick === 'function' ? hooks.onClick() : null))
                .catch(() => undefined);
        });
    } catch (e) { /* 忽略 */ }
}

/** 是否真的落到了 DOM（字符串插入路径下由 getElementById 判定） */
function resolvedIn(doc, id, node) {
    try { if (doc && typeof doc.getElementById === 'function' && doc.getElementById(id)) return true; } catch (e) { /* 忽略 */ }
    try { if (node && node.parentNode && node.parentNode.children && node.parentNode.children.indexOf(node) >= 0) return true; } catch (e) { /* 忽略 */ }
    return false;
}

/** 顶栏按钮的字符串形态（宿主无 appendChild 时退化） */
function topbarHtml() {
    return '<div id="' + TOPBAR_ID + '" class="drawer"><div class="drawer-toggle">'
        + '<div class="drawer-icon fa-solid fa-book-open fa-fw closedIcon interactable" title="FTT记忆组件" tabindex="0" role="button"></div>'
        + '</div><div class="drawer-content closedDrawer" id="FTTMemoryDrawerContent"></div></div>';
}

// ---------------- 顶栏按钮（V1 `createTopbarButton` 逐条移植） ----------------
export function topbarInstalled() {
    if (topbarBtn) return true;
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(TOPBAR_ID)); } catch (e) { return false; }
}

export function installTopbarEntry(hooks) {
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document', id: TOPBAR_ID };
    if (topbarInstalled()) return { ok: true, reason: 'already', id: TOPBAR_ID, inserted: true, resolved: true };
    const holder = doc.getElementById('top-settings-holder');
    if (!holder) return { ok: false, reason: '未找到 #top-settings-holder', id: TOPBAR_ID };
    let btn = null;
    try { if (typeof doc.createElement === 'function') btn = doc.createElement('div'); } catch (e) { btn = null; }
    if (!btn) return { ok: false, reason: '宿主无 createElement', id: TOPBAR_ID };
    try {
        btn.id = TOPBAR_ID;
        btn.className = 'drawer';   // 与 ST 其他顶栏按钮（如 persona-management-button）同构，视觉交给 ST 的 drawer 样式
        btn.innerHTML = '<div class="drawer-toggle">'
            + '<div class="drawer-icon fa-solid fa-book-open fa-fw closedIcon interactable" title="FTT记忆组件" tabindex="0" role="button"></div>'
            + '</div><div class="drawer-content closedDrawer" id="FTTMemoryDrawerContent"></div>';
        // 真实 DOM 里绑在 `.drawer-toggle` 上（避免 content 区点击误触）；桩 DOM 无 querySelector → 退化为绑根节点
        let target = null;
        try { target = (typeof btn.querySelector === 'function') ? btn.querySelector('.drawer-toggle') : null; } catch (e) { target = null; }
        bindClick(target || btn, hooks);
        const anchor = doc.getElementById('persona-management-button');
        if (anchor && anchor.parentNode && typeof anchor.parentNode.insertBefore === 'function') anchor.parentNode.insertBefore(btn, anchor);
        else if (!insertNode(holder, btn, topbarHtml())) return { ok: false, reason: '顶栏容器不支持插入', id: TOPBAR_ID };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: TOPBAR_ID }; }
    topbarBtn = btn;
    return { ok: true, inserted: true, resolved: resolvedIn(doc, TOPBAR_ID, btn), id: TOPBAR_ID, at: 'top-settings-holder' };
}

export function uninstallTopbarEntry() {
    const el = topbarBtn;
    topbarBtn = null;
    let ok = false;
    try {
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') { el.parentNode.removeChild(el); ok = true; }
    } catch (e) { /* 忽略 */ }
    try {
        const doc = docEl();
        const found = (doc && typeof doc.getElementById === 'function') ? doc.getElementById(TOPBAR_ID) : null;
        if (found && found.parentNode && typeof found.parentNode.removeChild === 'function') { found.parentNode.removeChild(found); ok = true; }
    } catch (e) { /* 忽略 */ }
    return ok;
}

// ---------------- 页面底部按钮（V1 `createQrButton` 逐条移植） ----------------
export function qrInstalled() {
    if (qrBtn) return true;
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(QR_BTN_ID)); } catch (e) { return false; }
}

export function installQrEntry(hooks) {
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document', id: QR_BTN_ID };
    if (qrInstalled()) return { ok: true, reason: 'already', id: QR_BTN_ID, inserted: true, resolved: true };
    const sendForm = doc.getElementById(SEND_FORM_ID);
    if (!sendForm) return { ok: false, reason: '未找到 #' + SEND_FORM_ID, id: QR_BTN_ID };
    const mk = (tag) => { try { return typeof doc.createElement === 'function' ? doc.createElement(tag || 'div') : null; } catch (e) { return null; } };
    try {
        // V1 同款：先清掉历史脚本残留（`FTT记忆vX.X` 的快捷栏脚本容器），避免重复入口
        try {
            const oldBar = (typeof sendForm.querySelector === 'function') ? sendForm.querySelector('#' + QR_BAR_ID) : null;
            if (oldBar && typeof oldBar.querySelectorAll === 'function') {
                const stale = oldBar.querySelectorAll('[id^="script_container_"], .qr--buttons [data-script-name]') || [];
                for (const el of Array.prototype.slice.call(stale)) {
                    const t = String((el && (el.textContent || el.title)) || '').trim();
                    if (/FTT记忆v\d\.\d/.test(t) && typeof el.remove === 'function') { try { el.remove(); } catch (e) { /* 忽略 */ } }
                }
            }
        } catch (e) { /* 清理失败不影响安装 */ }
        let bar = (typeof sendForm.querySelector === 'function') ? sendForm.querySelector('#' + QR_BAR_ID) : null;
        if (!bar) {
            bar = mk('div');
            if (!bar) return { ok: false, reason: '宿主无 createElement', id: QR_BTN_ID };
            bar.id = QR_BAR_ID;
            bar.className = 'ftt-qr-bar flex-container flexGap5';
            if (typeof sendForm.prepend === 'function') sendForm.prepend(bar);
            else if (!insertNode(sendForm, bar, '<div id="' + QR_BAR_ID + '" class="ftt-qr-bar flex-container flexGap5"></div>')) return { ok: false, reason: '输入区不支持插入', id: QR_BTN_ID };
        }
        let wrap = (typeof bar.querySelector === 'function') ? bar.querySelector('.ftt-qr-buttons') : null;
        if (!wrap) {
            wrap = mk('div');
            if (!wrap) return { ok: false, reason: '宿主无 createElement', id: QR_BTN_ID };
            wrap.className = 'ftt-qr-buttons';
            if (!insertNode(bar, wrap, '<div class="ftt-qr-buttons"></div>')) return { ok: false, reason: '快捷栏不支持插入', id: QR_BTN_ID };
        }
        const btn = mk('div');
        if (!btn) return { ok: false, reason: '宿主无 createElement', id: QR_BTN_ID };
        btn.id = QR_BTN_ID;
        btn.className = 'ftt-qr-btn menu_button interactable';
        btn.textContent = 'FTT记忆';
        btn.title = '打开 FTT记忆组件';
        if (typeof btn.setAttribute === 'function') btn.setAttribute('tabindex', '0');
        bindClick(btn, hooks);
        if (!insertNode(wrap, btn, '<div id="' + QR_BTN_ID + '" class="ftt-qr-btn menu_button interactable" title="打开 FTT记忆组件">FTT记忆</div>')) return { ok: false, reason: '快捷栏不支持插入', id: QR_BTN_ID };
        qrBtn = btn;
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: QR_BTN_ID }; }
    return { ok: true, inserted: true, resolved: resolvedIn(doc, QR_BTN_ID, qrBtn), id: QR_BTN_ID, at: 'send_form' };
}

export function uninstallQrEntry() {
    const el = qrBtn;
    qrBtn = null;
    let ok = false;
    try {
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') { el.parentNode.removeChild(el); ok = true; }
    } catch (e) { /* 忽略 */ }
    try {
        const doc = docEl();
        const found = (doc && typeof doc.getElementById === 'function') ? doc.getElementById(QR_BTN_ID) : null;
        if (found && found.parentNode && typeof found.parentNode.removeChild === 'function') { found.parentNode.removeChild(found); ok = true; }
    } catch (e) { /* 忽略 */ }
    return ok;
}

// ---------------- 统一启停 ----------------
/**
 * 按 `cfg.buttonLocations` 启停全部「插件自建入口」（V1 `syncButtons()` 的 V2 等价物）。
 * @param {object} locations `cfg.buttonLocations`（会被就地补上强制项）
 * @param {object} [hooks] { onClick } —— 缺省沿用上一次注入的钩子（设置页改开关时用）
 * @returns {{ok:boolean, locations:object, applied:object, installed:object}}
 */
export function syncEntryButtons(locations, hooks) {
    const loc = (locations && typeof locations === 'object') ? locations : {};
    if (hooks && typeof hooks === 'object') lastHooks = hooks;
    const use = lastHooks || {};
    const norm = normalizeEntryLocations(loc);
    // 强制项写回配置（V1 存档/跨端带过来的 false 不生效）
    for (const k of FORCED_ENTRIES) { try { loc[k] = true; } catch (e) { /* 只读配置对象：忽略 */ } }
    const applied = {
        menu: norm.menu ? installMenuEntry(use) : uninstallMenuEntry(),
        topbar: norm.topbar ? installTopbarEntry(use) : uninstallTopbarEntry(),
        qr: norm.qr ? installQrEntry(use) : uninstallQrEntry(),
        float: norm.float ? installFloatingEntry(use, { reason: 'user' }) : uninstallFloatIfUser(),
    };
    return { ok: true, locations: norm, applied: applied, installed: entryButtonsState() };
}

/** 关闭「悬浮按钮」时只移除「用户开启」的那一个（兜底来源保留） */
function uninstallFloatIfUser() {
    try {
        const info = floatingInfo();
        if (info.reason === 'fallback') return { ok: false, reason: 'off（保留可见性兜底）', id: info.btnId };
        return uninstallFloatingEntry() ? { ok: true, removed: true, id: info.btnId } : { ok: false, reason: '未安装', id: info.btnId };
    } catch (e) { return { ok: false, reason: 'error' }; }
}

/** 全部入口的安装态（诊断 / 测试） */
export function entryButtonsState() {
    return {
        locations: ENTRY_LOCATIONS.slice(),
        labels: Object.assign({}, ENTRY_LABELS),
        forced: FORCED_ENTRIES.slice(),
        installed: {
            topbar: topbarInstalled(),
            qr: qrInstalled(),
            float: floatingInstalled(),
            menu: menuInstalled(),
        },
        ids: { topbar: TOPBAR_ID, qr: QR_BTN_ID, float: floatingInfo().btnId, menu: menuInfo().btnId },
        floatReason: floatingInfo().reason || '',
    };
}

/** 卸载全部入口（teardown / 禁用扩展时调用） */
export function uninstallAllEntries() {
    const out = {
        topbar: uninstallTopbarEntry(),
        qr: uninstallQrEntry(),
        float: uninstallFloatingEntry(),
        menu: uninstallMenuEntry(),
    };
    return out;
}
