// ============================================================
// ui/floating.js —— 悬浮入口（**最后一道可见性兜底**）
// 场景：若扩展设置抽屉的容器一个都找不到（不同发行版/原生移植的 DOM 不同），用户会「装上了但看不到任何东西」。
//   此时在页面右下角放一个固定的「FTT」小按钮；点击即打开面板（优先弹窗，退化为再次尝试挂载）。
// 约定：只在「面板确实挂不到抽屉里」时才安装；面板挂上后自动移除，避免干扰。
// ============================================================
const BTN_ID = 'ftt_v2_float_btn';

function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }

/** 悬浮入口是否已安装 */
export function floatingInstalled() {
    const doc = docEl();
    try { return !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(BTN_ID)); } catch (e) { return false; }
}

/**
 * 安装悬浮入口。
 * @param {object} hooks { onClick(): Promise<any> }
 * @returns {{ok:boolean, inserted?:boolean, resolved?:boolean, reason?:string}}
 */
export function installFloatingEntry(hooks) {
    const doc = docEl();
    if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: '无 document' };
    if (floatingInstalled()) return { ok: true, reason: 'already', inserted: true, resolved: true };
    const html = '<div id="' + BTN_ID + '" class="ftt-float-btn" title="FTT记忆组件 V2（点击打开面板）">FTT</div>';
    // 优先挂到 body；没有 body 时退到任何已存在的扩展容器
    const targets = [null, 'extensions_settings2', 'extensions_settings', 'rm_extensions_block'];
    let host = null;
    try {
        if (doc.body && typeof doc.body.insertAdjacentHTML === 'function') host = doc.body;
        if (!host) { for (const id of targets.slice(1)) { const el = doc.getElementById(id); if (el && typeof el.insertAdjacentHTML === 'function') { host = el; break; } } }
    } catch (e) { host = null; }
    if (!host) return { ok: false, reason: '无可插入的容器（无 body 且无扩展容器）' };
    try { host.insertAdjacentHTML('beforeend', html); } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    const btn = doc.getElementById(BTN_ID);
    if (btn && typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', () => {
            Promise.resolve()
                .then(() => (hooks && typeof hooks.onClick === 'function' ? hooks.onClick() : null))
                .catch(() => undefined);
        });
    }
    // 真实 DOM：insertAdjacentHTML 后按钮可被解析（resolved=true）；桩 DOM 不解析（resolved=false）
    return { ok: true, inserted: true, resolved: !!btn };
}

/** 悬浮入口诊断（/ftt、FTT.panelInfo()） */
export function floatingInfo() {
    const doc = docEl();
    let bodyFound = false;
    try { bodyFound = !!(doc && doc.body); } catch (e) { bodyFound = false; }
    return { btnId: BTN_ID, installed: floatingInstalled(), bodyFound };
}

/** 移除悬浮入口（面板已挂载 / disable / delete 时调用） */
export function uninstallFloatingEntry() {
    const doc = docEl();
    try {
        const btn = doc && typeof doc.getElementById === 'function' ? doc.getElementById(BTN_ID) : null;
        if (btn && btn.parentNode && typeof btn.parentNode.removeChild === 'function') { btn.parentNode.removeChild(btn); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}
