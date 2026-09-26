// ============================================================
// ui/floating.js —— 悬浮入口（V1「悬浮按钮」）
// 两种来源（同一元素、同一 id，V1 对齐）：
//   ① **用户开启**（设置 → 显示界面开关 → 悬浮按钮，`cfg.buttonLocations.float = true`）→ `reason='user'`；
//   ② **可见性兜底**（扩展菜单入口不可用 / 面板挂不上时自动出现）→ `reason='fallback'`。
// 区分来源的意义：用户在设置里关掉「悬浮按钮」时只移除 ①，兜底 ② 仍保留（否则会「装上了但看不到任何东西」）。
// 与 V1 对齐（v1.206 `createFloatButton`）：id `ftt-float-button`、文案 `📖`、`title="FTT记忆组件"`，挂在 `body`；
//   `style.css` 里 V1 的 `#ftt-float-button` 圆形按钮样式据此生效。
// ============================================================
const BTN_ID = 'ftt-float-button';

/** 模块跟踪的已安装节点与来源 */
let floatBtn = null;
let floatReason = '';

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 悬浮入口是否已安装 */
export function floatingInstalled() {
    if (floatBtn) return true;
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(BTN_ID)); } catch (e) { return false; }
}

/** 字符串形态（宿主无 createElement 时的退化插入） */
function nodeHtml() { return '<div id="' + BTN_ID + '" title="FTT记忆组件">📖</div>'; }

/**
 * 安装悬浮入口。
 * @param {object} hooks { onClick(): Promise<any> }
 * @param {object} [opts] { reason: 'user' | 'fallback' }
 * @returns {{ok:boolean, inserted?:boolean, resolved?:boolean, reason?:string|boolean, id?:string, via?:string}}
 */
export function installFloatingEntry(hooks, opts) {
    const o = opts || {};
    const reason = String(o.reason || 'user');
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document', id: BTN_ID };
    if (floatingInstalled()) {
        if (reason === 'user') floatReason = 'user';      // 兜底已装 → 用户开启视作「常驻」
        return { ok: true, reason: 'already', inserted: true, resolved: true, id: BTN_ID, via: floatReason };
    }
    // 优先挂到 body；没有 body 时退到任何已存在的扩展容器（宿主只有 insertAdjacentHTML 时也接受）
    const targets = ['extensions_settings2', 'extensions_settings', 'rm_extensions_block'];
    const canHost = (el) => !!(el && (typeof el.appendChild === 'function' || typeof el.insertAdjacentHTML === 'function'));
    let host = null;
    try {
        if (canHost(doc.body)) host = doc.body;
        if (!host) { for (const id of targets) { const el = doc.getElementById(id); if (canHost(el)) { host = el; break; } } }
    } catch (e) { host = null; }
    if (!host) return { ok: false, reason: '无可插入的容器（无 body 且无扩展容器）', id: BTN_ID };
    let btn = null;
    try { if (typeof doc.createElement === 'function' && typeof host.appendChild === 'function') btn = doc.createElement('div'); } catch (e) { btn = null; }
    if (btn) {
        try {
            btn.id = BTN_ID;
            btn.title = 'FTT记忆组件';
            btn.textContent = '📖';
            if (typeof btn.addEventListener === 'function') {
                btn.addEventListener('click', (e) => {
                    try {
                        if (e && typeof e.preventDefault === 'function') e.preventDefault();
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                    } catch (err) { /* 忽略 */ }
                    Promise.resolve()
                        .then(() => (hooks && typeof hooks.onClick === 'function' ? hooks.onClick() : null))
                        .catch(() => undefined);
                });
            }
            host.appendChild(btn);
        } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
        floatBtn = btn;
        floatReason = reason;
        return { ok: true, inserted: true, resolved: true, id: BTN_ID, via: reason };
    }
    try {
        if (typeof host.insertAdjacentHTML === 'function') host.insertAdjacentHTML('beforeend', nodeHtml());
        else return { ok: false, reason: '容器不支持插入', id: BTN_ID };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), id: BTN_ID }; }
    const found = doc.getElementById(BTN_ID);
    floatReason = reason;
    return { ok: true, inserted: true, resolved: !!found, id: BTN_ID, via: reason };
}

/** 悬浮入口诊断（/ftt、FTT.panelInfo()） */
export function floatingInfo() {
    const doc = docEl();
    let bodyFound = false;
    try { bodyFound = !!(doc && doc.body); } catch (e) { bodyFound = false; }
    return { btnId: BTN_ID, installed: floatingInstalled(), bodyFound, reason: floatReason || (floatBtn ? 'user' : '') };
}

/** 移除悬浮入口（面板已挂载 / 用户关闭该入口 / teardown 时调用） */
export function uninstallFloatingEntry() {
    const el = floatBtn;
    floatBtn = null;
    floatReason = '';
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
