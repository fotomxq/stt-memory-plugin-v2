// ============================================================
// ui/menu.js —— 扩展菜单入口（**强制开启的主入口**：魔杖菜单里的「FTT记忆」）
//
// v2.65.0（用户要求）：入口强制开启、设置页不展示开关（见 `ui/entries.js#FORCED_ENTRIES`）。
//
// v2.67.0（用户报告：「底部扩展菜单看不到面板激活的按钮」）—— 两处真实缺陷，本批修复：
//   ① **陈旧标志**：安装成功后只在模块里记一个节点引用，`menuInstalled()` 直接返回 true。
//      酒馆打开魔杖菜单时会**重建** `#extensionsMenu` 的内容（清空后按扩展设置重新填充）——
//      我们插进去的那一项被清掉后，模块却仍以为「已安装」→ **再也不会补回**（表现就是看不到按钮）。
//      现在 `menuInstalled()` 会校验节点**是否仍挂在文档里**（`isConnected` / `document.contains`），
//      并回查 `getElementById`；陈旧引用会被清掉。
//   ② **安装时机**：`#extensionsMenu` 由酒馆在需要时创建/填充；插件初始化时它可能还不存在，
//      一次失败后此前不再重试。现在提供 `ensureMenuEntry()`（幂等）并在这些时机调用：
//      初始化与每次 `syncEntryButtons`、可见性探针每一轮、**点击魔杖按钮之后**（重建完再补）、
//      以及 `#extensionsMenu` 的 `MutationObserver`（内容被清空即补回）。
//
// 与 V1 对齐：元素 id `ftt-menu-button`、文案「FTT记忆」、`title="打开 FTT记忆组件"`；
//   结构采用酒馆扩展菜单项的标准形态（`list-group-item flex-container flexGap5 interactable` + 图标 + 文本）。
// 约定：菜单容器不存在 / 不支持插入 → 返回 false（不抛），由调用方继续尝试其它可见性方案。
// ============================================================
import { MOUNT_CANDIDATES, panelMountInfo } from './settings-panel.js';

const MENU_ID = 'extensionsMenu';
const WAND_ID = 'extensionsMenuButton';
const BTN_ID = 'ftt-menu-button';

/** 模块跟踪的已安装节点（桩 DOM 不解析 HTML → 无法靠 getElementById 找回落点） */
let menuBtn = null;
/** 最近一次的点击钩子（补回时复用，无需宿主再注入） */
let lastHooks = null;
/** 观察是否已绑定（点击捕获 + MutationObserver） */
let watchBound = false;
let observer = null;
let observerAt = null;
let reensureTimer = null;

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 节点是否仍挂在文档里（陈旧引用不算「已安装」） */
function nodeAttached(node) {
    if (!node) return false;
    try { if (typeof node.isConnected === 'boolean') return node.isConnected; } catch (e) { /* 继续 */ }
    const doc = docEl();
    try { if (doc && typeof doc.contains === 'function') return !!doc.contains(node); } catch (e) { /* 继续 */ }
    return !!node.parentNode;
}

/** 菜单入口是否**确实**已插入（清掉被酒馆重建清掉后的陈旧引用） */
export function menuInstalled() {
    if (menuBtn && nodeAttached(menuBtn)) return true;
    const doc = docEl();
    let found = null;
    try { found = (doc && typeof doc.getElementById === 'function') ? doc.getElementById(BTN_ID) : null; } catch (e) { found = null; }
    if (found) { menuBtn = found; return true; }
    menuBtn = null;                 // 陈旧引用（节点已被移除）→ 清掉，下次 ensure 会重新插入
    return false;
}

/** 绑定点击（打开面板；异常吞掉，不影响宿主） */
function bindClick(el, hooks) {
    try {
        if (!el || typeof el.addEventListener !== 'function') return;
        const fire = (e) => {
            try {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            } catch (err) { /* 忽略 */ }
            Promise.resolve()
                .then(() => (hooks && typeof hooks.onClick === 'function' ? hooks.onClick() : null))
                .catch(() => undefined);
        };
        el.addEventListener('click', fire);
        el.addEventListener('keydown', (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) fire(e); });
    } catch (e) { /* 忽略 */ }
}

/** 字符串形态（宿主无 createElement 时的退化插入） */
function nodeHtml() {
    return '<div class="list-group-item flex-container flexGap5 interactable" id="' + BTN_ID + '" tabindex="0" role="button" title="打开 FTT记忆组件">'
        + '<div class="fa-solid fa-brain extensionsMenuExtensionButton"></div><span>FTT记忆</span></div>';
}

/** 菜单节点（标准扩展菜单项结构：图标 + 文本） */
function makeNode(doc) {
    const btn = (typeof doc.createElement === 'function') ? doc.createElement('div') : null;
    if (!btn) return null;
    btn.id = BTN_ID;
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.title = '打开 FTT记忆组件';
    if (typeof btn.setAttribute === 'function') { btn.setAttribute('tabindex', '0'); btn.setAttribute('role', 'button'); }
    // 子节点只在宿主支持 appendChild 时构造；否则退化为一整块文本（桩 DOM / 极简宿主）
    const canAppend = (typeof btn.appendChild === 'function');
    if (canAppend) {
        const icon = (typeof doc.createElement === 'function') ? doc.createElement('div') : null;
        if (icon) { icon.className = 'fa-solid fa-brain extensionsMenuExtensionButton'; btn.appendChild(icon); }
        const label = (typeof doc.createElement === 'function') ? doc.createElement('span') : null;
        if (label) { label.textContent = 'FTT记忆'; btn.appendChild(label); }
        else btn.textContent = 'FTT记忆';
    } else {
        btn.textContent = 'FTT记忆';
    }
    return btn;
}

/**
 * 安装菜单入口（幂等）。
 * @param {object} hooks { onClick(): Promise<{ok:boolean, ...}> } —— 点击行为（打开面板）
 * @returns {{ok:boolean, reason?:string, id?:string, inserted?:boolean, resolved?:boolean}}
 */
export function installMenuEntry(hooks) {
    if (hooks && typeof hooks === 'object') lastHooks = hooks;
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document', id: BTN_ID };
    bindMenuWatch();
    if (menuInstalled()) return { ok: true, reason: 'already', id: BTN_ID, inserted: true, resolved: true };
    const menu = doc.getElementById(MENU_ID);
    if (!menu) return { ok: false, reason: '未找到 #' + MENU_ID, id: BTN_ID };
    const btn = makeNode(doc);
    if (btn && typeof menu.appendChild === 'function') {
        try { menu.appendChild(btn); } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
        bindClick(btn, lastHooks);
        menuBtn = btn;
        return { ok: true, inserted: true, resolved: nodeAttached(btn), id: BTN_ID };
    }
    // 退化：宿主不支持 createElement/appendChild → 字符串插入（并回查节点）。
    //   容器上留一枚标记，避免「宿主不解析 HTML、回查不到节点」时被重复插入（重复项会出现在菜单里）；
    //   酒馆重建菜单时由 MutationObserver 清掉标记，随后再补回。
    try {
        if (typeof menu.insertAdjacentHTML !== 'function') return { ok: false, reason: '菜单容器不支持插入', id: BTN_ID };
        if (menu.__fttMenuInjected === true) return { ok: true, reason: 'already-html', inserted: true, resolved: false, id: BTN_ID };
        menu.insertAdjacentHTML('beforeend', nodeHtml());
        menu.__fttMenuInjected = true;
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
    const found = doc.getElementById(BTN_ID);
    bindClick(found, lastHooks);
    if (found) menuBtn = found;
    return { ok: true, inserted: true, resolved: !!found, id: BTN_ID };
}

/**
 * 确保菜单入口存在（幂等；被酒馆清掉/初次未建成时补回）。可安全高频调用。
 * @param {object} [hooks] 缺省沿用上一次注入的钩子
 * @returns {{ok:boolean, reason?:string, id?:string, reinserted?:boolean}}
 */
export function ensureMenuEntry(hooks) {
    if (hooks && typeof hooks === 'object') lastHooks = hooks;
    bindMenuWatch();
    const before = menuInstalled();
    const r = installMenuEntry(lastHooks);
    return Object.assign({}, r, { reinserted: !before && r.ok === true });
}

/**
 * 绑定「菜单被重建 → 补回」的两条路径（幂等）：
 *   ① 点击魔杖按钮（`#extensionsMenuButton`）后的下一个宏任务补一次 —— 酒馆正是在这次点击里重建菜单内容；
 *   ② `#extensionsMenu` 的 `MutationObserver`（childList）：内容被清空/替换即补回。
 * 容器此刻不存在也能绑定第 ① 条；第 ② 条会在后续 `ensureMenuEntry()` 调用时补绑。
 */
export function bindMenuWatch() {
    const doc = docEl();
    if (!doc || typeof doc.addEventListener !== 'function') return false;
    if (!watchBound) {
        watchBound = true;
        try {
            doc.addEventListener('click', (e) => {
                try {
                    let node = e && e.target;
                    let hitWand = false;
                    for (let i = 0; node && i < 12; i++) {
                        if (node.id === WAND_ID || node.id === MENU_ID) { hitWand = true; break; }
                        node = node.parentNode;
                    }
                    if (hitWand) scheduleReensure();
                } catch (err) { /* 忽略 */ }
            }, true);
        } catch (e) { /* 忽略 */ }
    }
    // MutationObserver：容器出现/被替换时（重新）绑定
    try {
        const menu = (typeof doc.getElementById === 'function') ? doc.getElementById(MENU_ID) : null;
        const MO = (typeof globalThis !== 'undefined') ? globalThis.MutationObserver : null;
        if (menu && typeof MO === 'function' && observerAt !== menu) {
            try { if (observer && typeof observer.disconnect === 'function') observer.disconnect(); } catch (e) { /* 忽略 */ }
            observer = new MO(() => {
                try {
                    if (!menuInstalled()) {
                        // 酒馆重建了菜单内容 → 清掉字符串插入标记，允许补回（避免重复项）
                        try { delete menu.__fttMenuInjected; } catch (e2) { menu.__fttMenuInjected = false; }
                        scheduleReensure();
                    }
                } catch (e) { /* 忽略 */ }
            });
            if (typeof observer.observe === 'function') observer.observe(menu, { childList: true });
            observerAt = menu;
        }
    } catch (e) { /* 忽略 */ }
    return true;
}

/** 下一个宏任务补一次（合并多次触发；避免观察者自触发死循环） */
function scheduleReensure() {
    try {
        if (reensureTimer) return false;
        const setT = (typeof setTimeout === 'function') ? setTimeout : null;
        if (!setT) { ensureMenuEntry(); return true; }
        reensureTimer = setT(() => {
            reensureTimer = null;
            try { if (!menuInstalled()) ensureMenuEntry(); } catch (e) { /* 忽略 */ }
        }, 0);
        return true;
    } catch (e) { return false; }
}

/** 解绑观察（teardown / 卸载时调用；避免残留定时器与监听） */
export function unbindMenuWatch() {
    try { if (observer && typeof observer.disconnect === 'function') observer.disconnect(); } catch (e) { /* 忽略 */ }
    observer = null;
    observerAt = null;
    watchBound = false;
    return true;
}

/** 菜单入口诊断（/ftt 与 FTT.panelInfo()） */
export function menuInfo() {
    const doc = docEl();
    let menuFound = false;
    try { menuFound = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(MENU_ID)); } catch (e) { menuFound = false; }
    return {
        menuId: MENU_ID, btnId: BTN_ID, wandId: WAND_ID,
        menuFound: menuFound, installed: menuInstalled(),
        watched: watchBound, observing: !!observer,
        candidates: MOUNT_CANDIDATES.slice(), mount: panelMountInfo(),
    };
}

/** 卸载菜单入口（teardown / 禁用扩展时调用；同时解绑观察） */
export function uninstallMenuEntry() {
    const el = menuBtn;
    menuBtn = null;
    unbindMenuWatch();
    try { if (reensureTimer && typeof clearTimeout === 'function') { clearTimeout(reensureTimer); reensureTimer = null; } } catch (e) { /* 忽略 */ }
    let ok = false;
    try {
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') { el.parentNode.removeChild(el); ok = true; }
    } catch (e) { /* 忽略 */ }
    try {
        const doc = docEl();
        const found = (doc && typeof doc.getElementById === 'function') ? doc.getElementById(BTN_ID) : null;
        if (found && found.parentNode && typeof found.parentNode.removeChild === 'function') { found.parentNode.removeChild(found); ok = true; }
    } catch (e) { /* 忽略 */ }
    return ok;
}
