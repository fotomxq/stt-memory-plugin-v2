// ============================================================
// ui/menu.js —— 扩展菜单入口（**主入口**：魔杖菜单里的「FTT记忆」项）
// v2.65.0（用户要求）：「当前扩展中的窗口入口选项是**强制开启**的，禁止被关闭，且**不展示该开关**」——
//   本入口由 `ui/entries.js#syncEntryButtons` 强制安装（忽略 `cfg.buttonLocations.menu` 的关闭意图），
//   设置页只以一行说明给出「始终开启」，不再提供可关闭的开关。
// 与 V1 对齐（v1.206 `createMenuButton`）：元素 id `ftt-menu-button`、类 `list-group-item flex-container flexGap5 interactable`、
//   文案「FTT记忆」、`title="打开 FTT记忆组件"` —— `style.css` 里 V1 的 `#ftt-menu-button` 规则据此生效。
// 约定：菜单容器不存在 / 不支持插入 → 返回 false（不抛），由调用方继续尝试其它可见性方案。
// ============================================================
import { MOUNT_CANDIDATES, panelMountInfo } from './settings-panel.js';

const MENU_ID = 'extensionsMenu';
const BTN_ID = 'ftt-menu-button';

/** 模块跟踪的已安装节点（桩 DOM 不解析 HTML → 无法靠 getElementById 找回落点） */
let menuBtn = null;

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 菜单入口是否已插入 */
export function menuInstalled() {
    if (menuBtn) return true;
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(BTN_ID)); } catch (e) { return false; }
}

/** 绑定点击（打开面板；异常吞掉，不影响宿主） */
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

/** 字符串形态（宿主无 createElement 时的退化插入） */
function nodeHtml() {
    return '<div class="list-group-item flex-container flexGap5 interactable" id="' + BTN_ID + '" title="打开 FTT记忆组件">FTT记忆</div>';
}

/**
 * 安装菜单入口。
 * @param {object} hooks { onClick(): Promise<{ok:boolean, ...}> } —— 点击行为（打开面板）
 * @returns {{ok:boolean, reason?:string, id?:string, inserted?:boolean, resolved?:boolean}}
 */
export function installMenuEntry(hooks) {
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document', id: BTN_ID };
    if (menuInstalled()) return { ok: true, reason: 'already', id: BTN_ID, inserted: true, resolved: true };
    const menu = doc.getElementById(MENU_ID);
    if (!menu) return { ok: false, reason: '未找到 #' + MENU_ID, id: BTN_ID };
    // 优先 DOM 节点（可绑定、可移除、样式有保障）；宿主无 createElement 时退回字符串插入
    let btn = null;
    try { if (typeof doc.createElement === 'function') btn = doc.createElement('div'); } catch (e) { btn = null; }
    if (btn) {
        try {
            btn.id = BTN_ID;
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.textContent = 'FTT记忆';
            btn.title = '打开 FTT记忆组件';
            bindClick(btn, hooks);
            if (typeof menu.appendChild === 'function') menu.appendChild(btn);
            else if (typeof menu.insertAdjacentHTML === 'function') menu.insertAdjacentHTML('beforeend', nodeHtml());
            else return { ok: false, reason: '菜单容器不支持插入', id: BTN_ID };
        } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
        menuBtn = btn;
        return { ok: true, inserted: true, resolved: !!(doc.getElementById(BTN_ID) || (btn.parentNode && btn.parentNode.children && btn.parentNode.children.indexOf(btn) >= 0)), id: BTN_ID };
    }
    try {
        if (typeof menu.insertAdjacentHTML === 'function') menu.insertAdjacentHTML('beforeend', nodeHtml());
        else return { ok: false, reason: '菜单容器不支持插入', id: BTN_ID };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
    const found = doc.getElementById(BTN_ID);
    bindClick(found, hooks);
    return { ok: true, inserted: true, resolved: !!found, id: BTN_ID };
}

/** 菜单入口诊断（/ftt 与 FTT.panelInfo()） */
export function menuInfo() {
    const doc = docEl();
    let menuFound = false;
    try { menuFound = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(MENU_ID)); } catch (e) { menuFound = false; }
    return { menuId: MENU_ID, btnId: BTN_ID, menuFound, installed: menuInstalled(), candidates: MOUNT_CANDIDATES.slice(), mount: panelMountInfo() };
}

/** 卸载菜单入口（teardown / 关闭该入口时调用） */
export function uninstallMenuEntry() {
    const el = menuBtn;
    menuBtn = null;
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
