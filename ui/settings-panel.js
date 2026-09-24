// ============================================================
// ui/settings-panel.js —— 设置面板挂载（扩展设置抽屉）
// 事实源：ST 官方文档「HTML templates」：renderExtensionTemplateAsync(folder, file, data) → #extensions_settings2
// 约定：模板不可用时回退到内置最小 HTML（保证面板一定存在，方便排障）。
// ============================================================
import { EXTENSION_FOLDER, VERSION } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { getSettings, DEFAULT_SETTINGS, setSetting } from '../adapters/settings.js';
import { maybeAutoCheckOnStartup, runStUpdate, updateStatusText, updateConfig } from '../host/update.js';

const MOUNT_ID = 'extensions_settings2';

function escHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(v) {
    return escHtml(v).replace(/"/g, '&quot;');
}
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
        updateRepo: String(s.updateRepo || ''),
        updateBranch: String(s.updateBranch || ''),
        updateStatus: updateStatusText(),
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
        '<div class="ftt-v2-row"><label>启动时自动检查更新</label><input type="checkbox" id="ftt_v2_autoupd"' + (d.autoUpdateCheck ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label>更新检查仓库</label><input type="text" id="ftt_v2_updrepo" value="' + escAttr(d.updateRepo) + '"></div>',
        '<div class="ftt-v2-row ftt-v2-row-actions"><button class="menu_button" id="ftt_v2_checkupd">🔍 检查更新</button><button class="menu_button" id="ftt_v2_doupd">⬆ 立即更新（ST）</button></div>',
        '<div class="ftt-v2-note" id="ftt_v2_updstate" data-ftt-update-state>' + escHtml(d.updateStatus) + '</div>',
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
    bind('ftt_v2_autoupd', 'autoUpdateCheck', 'bool');
    bind('ftt_v2_updrepo', 'updateRepo', 'text');

    const checkBtn = doc.getElementById('ftt_v2_checkupd');
    if (checkBtn) {
        checkBtn.addEventListener('click', () => {
            setUpdateStatusLine('检查中…');
            // 手动检查同样落盘（lastCheckAt / lastResult），便于重载后与 /ftt 显示上次结果
            maybeAutoCheckOnStartup({ manual: true })
                .then(r => setUpdateStatusLine(updateStatusText(r && r.summary ? r.summary : { ok: false, error: '检查未执行' })))
                .catch(e => setUpdateStatusLine('检查更新失败：' + String((e && e.message) || e)));
        });
    }
    const doBtn = doc.getElementById('ftt_v2_doupd');
    if (doBtn) {
        doBtn.addEventListener('click', () => {
            setUpdateStatusLine('正在调用 ST 更新…');
            runStUpdate()
                .then(r => setUpdateStatusLine(r.ok ? ('ST 更新已执行' + (r.commit ? '（' + r.commit + '）' : '') + '，请重载页面') : ('ST 更新失败：' + (r.error || '未知'))))
                .catch(e => setUpdateStatusLine('ST 更新失败：' + String((e && e.message) || e)));
        });
    }
    return true;
}

/** 更新状态行文本（手工检查/自动检查后回填） */
export function setUpdateStatusLine(text) {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ftt_v2_updstate') : null;
    if (el) el.textContent = String(text == null ? '' : text);
    return !!el;
}

/** 当前更新配置（供 /ftt 与调试导出） */
export function currentUpdateConfig() {
    return updateConfig();
}

/** 卸载面板（disable/delete 时调用） */
export function unmountSettingsPanel() {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(ROOT_ID) : null;
    if (!el || !el.parentNode) return false;
    try { el.parentNode.removeChild(el); return true; } catch (e) { return false; }
}

export const PANEL_IDS = Object.freeze({ mount: MOUNT_ID, root: ROOT_ID, defaults: Object.keys(DEFAULT_SETTINGS) });
