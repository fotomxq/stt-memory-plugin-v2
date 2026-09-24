// ============================================================
// ui/menu.js —— 扩展魔杖菜单入口（**可见性兜底**）
// 背景：不同酒馆发行版/原生移植里「扩展设置区块」的 DOM 结构可能不同；若面板容器始终找不到，
//   用户就会「装上了但看不到任何东西」。这里在扩展菜单（`#extensionsMenu`，即魔杖菜单）里放一个入口，
//   点击即强制挂载面板并给出结果提示 —— 保证至少有一个可见、可点的入口。
// 约定：菜单容器不存在 / 不支持插入 → 返回 false（不抛），由调用方继续尝试其它可见性方案。
// ============================================================
import { MOUNT_CANDIDATES, panelMountInfo } from './settings-panel.js';

const MENU_ID = 'extensionsMenu';
const BTN_ID = 'ftt_v2_menu_btn';

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 菜单入口是否已插入 */
export function menuInstalled() {
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(BTN_ID)); } catch (e) { return false; }
}

/**
 * 安装菜单入口。
 * @param {object} hooks { onClick(): Promise<{ok:boolean, ...}> } —— 点击行为（强制挂载 + 提示）
 * @returns {{ok:boolean, reason?:string}}
 */
export function installMenuEntry(hooks) {
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document' };
    if (menuInstalled()) return { ok: true, reason: 'already' };
    const menu = doc.getElementById(MENU_ID);
    if (!menu) return { ok: false, reason: '未找到 #' + MENU_ID };
    const html = '<div class="list-group-item flex-container flexGap5" id="' + BTN_ID + '" title="FTT记忆组件 V2">' +
        '<div class="fa-solid fa-brain extensionsMenuExtensionButton"></div><span>FTT记忆组件</span></div>';
    try {
        if (typeof menu.insertAdjacentHTML === 'function') menu.insertAdjacentHTML('beforeend', html);
        else return { ok: false, reason: '菜单容器不支持插入' };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    const btn = doc.getElementById(BTN_ID);
    if (btn && typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', () => {
            Promise.resolve()
                .then(() => (hooks && typeof hooks.onClick === 'function' ? hooks.onClick() : null))
                .catch(() => undefined);
        });
    }
    // 说明：真实 DOM 里 insertAdjacentHTML 会立刻生成按钮节点（resolved=true）；
    //   桩 DOM 不解析 HTML（resolved=false），此时「已插入」仍为真 —— 测试按两者分别断言。
    return { ok: true, inserted: true, resolved: !!btn };
}

/** 菜单入口诊断（/ftt 与 FTT.panelInfo()） */
export function menuInfo() {
    const doc = docEl();
    let menuFound = false;
    try { menuFound = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(MENU_ID)); } catch (e) { menuFound = false; }
    return { menuId: MENU_ID, btnId: BTN_ID, menuFound, installed: menuInstalled(), candidates: MOUNT_CANDIDATES.slice(), mount: panelMountInfo() };
}

/** 卸载菜单入口（disable/delete） */
export function uninstallMenuEntry() {
    const doc = docEl();
    try {
        const btn = doc && typeof doc.getElementById === 'function' ? doc.getElementById(BTN_ID) : null;
        if (btn && btn.parentNode && typeof btn.parentNode.removeChild === 'function') { btn.parentNode.removeChild(btn); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}
