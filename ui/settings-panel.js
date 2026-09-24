// ============================================================
// ui/settings-panel.js —— 设置面板挂载（扩展设置抽屉）
// 事实源：ST 官方文档「HTML templates」：renderExtensionTemplateAsync(folder, file, data) → #extensions_settings2
// 约定：模板不可用时回退到内置最小 HTML（保证面板一定存在，方便排障）。
// ============================================================
import { EXTENSION_FOLDER, VERSION } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { getSettings, DEFAULT_SETTINGS, setSetting } from '../adapters/settings.js';

const MOUNT_ID = 'extensions_settings2';
const ROOT_ID = 'ftt_v2_settings';

/** 面板数据（模板变量） */
export function panelData(extra) {
    const s = getSettings();
    return Object.assign({
        version: VERSION,
        enabled: s.enabled !== false,
        injectEnabled: s.injectEnabled !== false,
        charBudget: s.charBudget,
        autoSummary: !!s.autoSummary,
        autoExtract: !!s.autoExtract,
        timelyAnalysis: !!s.timelyAnalysis,
        autoUpdateCheck: s.autoUpdateCheck !== false,
    }, extra || {});
}

/** 最小回退 HTML（模板渲染不可用时使用；不依赖外部文件） */
export function fallbackPanelHtml(data) {
    const d = data || panelData();
    return [
        '<div class="ftt-v2-settings" id="' + ROOT_ID + '">',
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>FTT记忆组件 V2</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content">',
        '<div class="ftt-v2-row"><label>启用插件</label><input type="checkbox" id="ftt_v2_enabled"' + (d.enabled ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label>注入记忆</label><input type="checkbox" id="ftt_v2_inject"' + (d.injectEnabled ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label>注入预算（字符）</label><input type="number" id="ftt_v2_budget" value="' + String(d.charBudget) + '"></div>',
        '<div class="ftt-v2-row"><label>自动摘要</label><input type="checkbox" id="ftt_v2_autosum"' + (d.autoSummary ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-note">版本 ' + VERSION + ' · 记忆数据请用面板管理（P4 落地）</div>',
        '</div></div></div>',
    ].join('');
}

function mountPoint() {
    try {
        const doc = globalThis.document;
        return doc ? doc.getElementById(MOUNT_ID) : null;
    } catch (e) { return null; }
}

/**
 * 挂载设置面板。
 * @param {object} [extra] 模板附加变量
 * @returns {Promise<{ ok: boolean, via: string, reason?: string }>}
 */
export async function mountSettingsPanel(extra) {
    const host = mountPoint();
    if (!host) return { ok: false, via: 'none', reason: '未找到 #' + MOUNT_ID };
    const data = panelData(extra);
    const ctx = getCtx();
    let html = '';
    try {
        if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
            html = String(await ctx.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', data) || '');
        }
    } catch (e) {
        html = '';
    }
    const via = html ? 'template' : 'fallback';
    if (!html) html = fallbackPanelHtml(data);
    try {
        host.insertAdjacentHTML('beforeend', html);
        bindPanelEvents();
        return { ok: true, via };
    } catch (e) {
        return { ok: false, via, reason: String((e && e.message) || e) };
    }
}

/** 面板交互绑定（P0：三个开关 + 预算；其余项 P4 逐步接入） */
export function bindPanelEvents() {
    const doc = globalThis.document;
    if (!doc || typeof doc.getElementById !== 'function') return false;
    const bind = (id, key, kind) => {
        const el = doc.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            const value = (kind === 'bool') ? !!el.checked : Number(el.value);
            setSetting(key, value);
        });
    };
    bind('ftt_v2_enabled', 'enabled', 'bool');
    bind('ftt_v2_inject', 'injectEnabled', 'bool');
    bind('ftt_v2_budget', 'charBudget', 'num');
    bind('ftt_v2_autosum', 'autoSummary', 'bool');
    return true;
}

/** 卸载面板（disable/delete 时调用） */
export function unmountSettingsPanel() {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(ROOT_ID) : null;
    if (!el || !el.parentNode) return false;
    try { el.parentNode.removeChild(el); return true; } catch (e) { return false; }
}

export const PANEL_IDS = Object.freeze({ mount: MOUNT_ID, root: ROOT_ID, defaults: Object.keys(DEFAULT_SETTINGS) });
