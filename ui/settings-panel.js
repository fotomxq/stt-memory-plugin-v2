// ============================================================
// ui/settings-panel.js —— 设置面板挂载（扩展设置抽屉）
// 事实源：ST 官方文档「HTML templates」：renderExtensionTemplateAsync(folder, file, data) → #extensions_settings2
// 约定：模板不可用时回退到内置最小 HTML（保证面板一定存在，方便排障）。
// ============================================================
import { VERSION } from '../core/constants.js';
import { extensionFolder, folderInfo } from '../host/paths.js';
import { getCtx } from '../host/st-api.js';
import { getSettings, DEFAULT_SETTINGS, setSetting } from '../adapters/settings.js';
import { cfg } from '../core/model/runtime.js';
import { DIMENSIONS } from '../core/constants.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { consoleAction, writeConsole, bindConsole, consoleConfig } from './console.js';
import { maybeAutoCheckOnStartup, runStUpdate, updateStatusText, updateConfig } from '../host/update.js';

const MOUNT_ID = 'extensions_settings2';
/**
 * 挂载容器候选（**按序尝试**）：不同酒馆发行版/宿主（含 TauriTavern 等原生移植）里扩展设置区块的 id 并不统一，
 * 只认一个 id 会导致「装上了但看不到面板」。第一个存在的即用；全都不到 → 记录原因，由入口的轮询稍后重试。
 */
export const MOUNT_CANDIDATES = Object.freeze(['extensions_settings2', 'extensions_settings', 'rm_extensions_block']);

/** 最近一次挂载尝试的结果（诊断：/ftt、/ftt-panel、FTT.panelInfo()） */
let lastMount = { ok: false, via: 'none', container: '', reason: '尚未尝试', at: 0, tries: 0, found: {} };
/** 本模块**自己**是否已把面板插进 DOM（不用「根节点是否存在」判断 —— 宿主/测试可能预建同名节点） */
let panelMounted = false;

function escHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(v) {
    return escHtml(v).replace(/"/g, '&quot;');
}
const ROOT_ID = 'ftt_v2_settings';

/** 面板动作钩子（由 index.js 注入：提取 / 导入 / 清空注入）与状态快照（面板只读区） */
let panelHooks = {};
let panelStatus = {};
/** 注入面板钩子（index.js 装配时调用） */
export function setPanelHooks(hooks) { panelHooks = Object.assign({}, panelHooks, hooks || {}); return panelHooks; }
/** 注入面板状态（每次刷新时更新只读区） */
export function setPanelStatus(status) { panelStatus = Object.assign({}, panelStatus, status || {}); return panelStatus; }

/** 面板内 cfg 控件 → 内核配置键（绑定表；测试与排障共用） */
export const PANEL_CFG_BINDINGS = Object.freeze({
    ftt_v2_cfg_injp: ['injectCurrentPrompt', 'bool'],
    ftt_v2_cfg_budget: ['charBudget', 'num'],
    ftt_v2_cfg_maxatoms: ['maxAtoms', 'num'],
    ftt_v2_cfg_maxmems: ['maxMemories', 'num'],
    ftt_v2_cfg_autoext: ['autoExtract', 'bool'],
});

/**
 * 应用面板 cfg 控件值（**唯一写入口**：改内核视图 → 持久化到 ST 配置 → 刷新状态块）。
 * @param {string} id 控件 id（见 PANEL_CFG_BINDINGS）
 * @param {*} raw 控件值（bool/number）
 * @returns {{ok:boolean, key?:string, value?:*}}
 */
export function applyPanelCfg(id, raw) {
    const b = PANEL_CFG_BINDINGS[id];
    if (!b) return { ok: false };
    const [key, kind] = b;
    const value = kind === 'bool' ? !!raw : Number(raw);
    if (!Number.isFinite(value) && kind === 'num') return { ok: false, key };
    cfg[key] = value;
    try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
    refreshPanelStatus();
    return { ok: true, key, value };
}

/** 维度开关：`data-ftt-dim` 勾选框 → `cfg.dimensionEnabled[kind]` */
export function applyPanelDim(kind, on) {
    const k = String(kind || '');
    if (!k) return { ok: false };
    cfg.dimensionEnabled = Object.assign({}, cfg.dimensionEnabled || {});
    cfg.dimensionEnabled[k] = !!on;
    try { saveKernelCfg(); } catch (e) { /* 忽略 */ }
    refreshPanelStatus();
    return { ok: true, kind: k, on: !!on };
}

/** 刷新只读状态块（动作完成后调用） */
export function refreshPanelStatus() {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ftt_v2_status') : null;
    const text = statusBlockText();
    if (el) el.textContent = text;
    return text;
}

/** 面板动作结果提示（按钮执行结果显示区） */
export function setActionNote(text) {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ftt_v2_action') : null;
    const t = String(text == null ? '' : text);
    if (el) el.textContent = t;
    return t;
}

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
        useStGitEndpoint: s.useStGitEndpoint === true,
        updateRepo: String(s.updateRepo || ''),
        updateBranch: String(s.updateBranch || ''),
        updateStatus: updateStatusText(),
        // P5 首批：内核配置（cfg）与状态块
        cfgInject: cfg.injectCurrentPrompt === true,
        cfgBudget: Number(cfg.charBudget) || 8000,
        cfgMaxAtoms: Number(cfg.maxAtoms) || 16,
        cfgMaxMemories: Number(cfg.maxMemories) || 8,
        cfgAutoExtract: cfg.autoExtract !== false,
        dimsHtml: dimsCheckboxHtml(),
        statusHtml: escHtml(statusBlockText()),
        actionNote: '',
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
        '<div class="ftt-v2-sub">记忆与注入（内核配置）</div>',
        '<div class="ftt-v2-row"><label>注入当前提示词</label><input type="checkbox" id="ftt_v2_cfg_injp"' + (d.cfgInject ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label>注入预算（字符）</label><input type="number" id="ftt_v2_cfg_budget" value="' + String(d.cfgBudget) + '"></div>',
        '<div class="ftt-v2-row"><label>注入情节条数上限</label><input type="number" id="ftt_v2_cfg_maxatoms" value="' + String(d.cfgMaxAtoms) + '"></div>',
        '<div class="ftt-v2-row"><label>注入记忆条数上限</label><input type="number" id="ftt_v2_cfg_maxmems" value="' + String(d.cfgMaxMemories) + '"></div>',
        '<div class="ftt-v2-row"><label>生成结束后自动提取</label><input type="checkbox" id="ftt_v2_cfg_autoext"' + (d.cfgAutoExtract ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row ftt-v2-row-col"><label>启用维度</label><div class="ftt-v2-dims" id="ftt_v2_dims">' + String(d.dimsHtml || '') + '</div></div>',
        '<div class="ftt-v2-note ftt-v2-status" id="ftt_v2_status">' + escHtml(d.statusHtml || '') + '</div>',
        '<div class="ftt-v2-row ftt-v2-row-actions"><button class="menu_button" id="ftt_v2_analyze">🧠 分析未分析楼层</button><button class="menu_button" id="ftt_v2_list">📋 待分析清单</button><button class="menu_button" id="ftt_v2_clearinj">🧹 清空注入</button></div>',
        '<div class="ftt-v2-row ftt-v2-row-actions"><button class="menu_button" id="ftt_v2_imp_dry">📥 V1 导入（干跑）</button><button class="menu_button" id="ftt_v2_imp_apply">📥 V1 导入（写入）</button></div>',
        '<div class="ftt-v2-note" id="ftt_v2_action"></div>',
        '<div class="ftt-v2-sub">数据台</div>',
        '<div class="ftt-console-host" id="ftt_v2_console"></div>',
        '<div class="ftt-v2-row"><label>启动时自动检查更新（内置延迟 4 秒执行）</label><input type="checkbox" id="ftt_v2_autoupd"' + (d.autoUpdateCheck ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label title="宿主 Git 端点会做远端 git handshake；无 git 的宿主（如 TauriTavern）会报「后端错误：Git handshake failed」。默认关：改用 GitHub raw 清单判定版本。">使用宿主 Git 更新端点（默认关）</label><input type="checkbox" id="ftt_v2_usegit"' + (d.useStGitEndpoint ? ' checked' : '') + '></div>',
        '<div class="ftt-v2-row"><label>更新检查仓库</label><input type="text" id="ftt_v2_updrepo" value="' + escAttr(d.updateRepo) + '"></div>',
        '<div class="ftt-v2-row ftt-v2-row-actions"><button class="menu_button" id="ftt_v2_checkupd">🔍 检查更新</button><button class="menu_button" id="ftt_v2_doupd">⬆ 立即更新（ST）</button></div>',
        '<div class="ftt-v2-note" id="ftt_v2_updstate" data-ftt-update-state>' + escHtml(d.updateStatus) + '</div>',
        '<div class="ftt-v2-note">版本 ' + VERSION + ' · 数据台在 P5 后续批次落地</div>',
        '</div></div></div>',
    ].join('');
}

/**
 * 维度勾选框（HTML 片段，交给 Handlebars 原样插入）——与 `cfg.dimensionEnabled` 对应。
 * 供模板与回退 HTML 共用，避免两处不一致。
 */
export function dimsCheckboxHtml() {
    const map = (cfg && cfg.dimensionEnabled) || {};
    return DIMENSIONS.map((d) => {
        const on = map[d.kind] !== false;
        return '<label><input type="checkbox" data-ftt-dim="' + escAttr(d.kind) + '"' + (on ? ' checked' : '') + '>' + escHtml(d.label) + '</label>';
    }).join('');
}

/**
 * 状态块文本（面板顶部只读区）：版本 / 作用域 / 内核配置 / 注入 / 提取 / 待分析。
 * 数据来自注入的 `extra.status`（index.js 组装），缺失时至少给出配置摘要。
 */
export function statusBlockText() {
    const s = panelStatus || {};
    const lines = [
        '版本 ' + VERSION + (s.scope ? ' · 作用域 ' + s.scope : ''),
        '内核配置 ' + Object.keys(cfg || {}).length + ' 键 · 注入预算 ' + (Number(cfg.charBudget) || 0) + ' 字符',
    ];
    if (s.injectChars !== undefined) lines.push('当前注入 ' + s.injectChars + ' 字');
    if (s.extract) lines.push('提取：运行 ' + s.extract.runs + ' · 成功 ' + s.extract.ok + ' · 失败 ' + s.extract.fail + (s.extract.lastReason ? '（最近 ' + s.extract.lastReason + '）' : ''));
    if (s.pending !== undefined && s.pending !== null) lines.push('待分析楼层 ' + s.pending + ' 层');
    if (s.store) lines.push('存储：本机缓冲/服务端文件（载入来源 ' + (s.store.via || '—') + '）');
    const panel = s.panel || panelMountInfo();          // 未注入时取实时状态
    if (panel) lines.push('面板挂载：' + (panel.ok ? ('已挂载 → #' + (panel.container || '?') + '（' + (panel.via || '') + '）') : ('未挂载（' + (panel.reason || '未知') + '）')));
    return lines.join('\n');
}

function docEl() {
    try { return globalThis.document || null; } catch (e) { return null; }
}

/** 找到第一个可用的挂载容器（按 MOUNT_CANDIDATES 顺序） */
function findMount() {
    const doc = docEl();
    const found = {};
    if (!doc || typeof doc.getElementById !== 'function') return { el: null, id: '', found };
    for (const id of MOUNT_CANDIDATES) {
        let el = null;
        try { el = doc.getElementById(id); } catch (e) { el = null; }
        found[id] = !!el;
        if (el && !found.__picked) { if (!Object.prototype.hasOwnProperty.call(found, '__picked')) found.__picked = id; return { el, id, found }; }
    }
    return { el: null, id: '', found };
}

/** 挂载状态（诊断用；不触发任何挂载） */
export function panelMountInfo() {
    const doc = docEl();
    const found = {};
    try {
        if (doc && typeof doc.getElementById === 'function') {
            for (const id of MOUNT_CANDIDATES) found[id] = !!doc.getElementById(id);
        }
    } catch (e) { /* 忽略 */ }
    let root = false;
    try { root = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(ROOT_ID)); } catch (e) { root = false; }
    return Object.assign({}, lastMount, { found, rootMounted: root, mounted: panelMounted, candidates: MOUNT_CANDIDATES.slice() });
}

/**
 * 挂载设置面板。
 * @param {object} [extra] 模板附加变量
 * @returns {Promise<{ ok: boolean, via: string, reason?: string }>}
 */
export async function mountSettingsPanel(extra) {
    const o = extra || {};
    if (o.hooks) setPanelHooks(o.hooks);
    if (o.status) setPanelStatus(o.status);
    lastMount.tries += 1;
    lastMount.at = Date.now();
    const doc = docEl();
    // 已由本模块挂载则不再重复插入（force 时强制重挂）
    if (panelMounted && !o.force) {
        lastMount = Object.assign(lastMount, { ok: true, via: 'already', reason: '' });
        return { ok: true, via: 'already', container: lastMount.container, info: panelMountInfo() };
    }
    const pick = findMount();
    const host = pick.el;
    if (!host) {
        lastMount = Object.assign(lastMount, {
            ok: false, via: 'none', container: '', found: pick.found,
            reason: '未找到扩展设置容器（候选：' + MOUNT_CANDIDATES.join(' / ') + '）',
        });
        return { ok: false, via: 'none', container: '', reason: lastMount.reason, info: panelMountInfo() };
    }
    const data = panelData(o);
    const ctx = getCtx();
    let html = '';
    try {
        if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
            // 目录名运行时解析（安装到任意目录名都能渲染模板）；失败回退常量见 host/paths.js
            html = String(await ctx.renderExtensionTemplateAsync(extensionFolder(), 'settings', data) || '');
        }
    } catch (e) {
        html = '';
    }
    const via = html ? 'template' : 'fallback';
    if (!html) html = fallbackPanelHtml(data);
    try {
        host.insertAdjacentHTML('beforeend', html);
        bindPanelEvents();
        // P5 次批：数据台随面板挂载渲染一次（后续由动作或「刷新数据台」按钮重渲染）
        try { writeConsole(); bindConsole(); } catch (e) { /* 数据台失败不影响面板 */ }
        panelMounted = true;
        lastMount = Object.assign(lastMount, { ok: true, via, container: pick.id, reason: '', found: pick.found });
        try { refreshPanelStatus(); } catch (e) { /* 忽略 */ }
        return { ok: true, via, container: pick.id, info: panelMountInfo() };
    } catch (e) {
        lastMount = Object.assign(lastMount, { ok: false, via, container: pick.id, reason: String((e && e.message) || e), found: pick.found });
        return { ok: false, via, container: pick.id, reason: lastMount.reason, info: panelMountInfo() };
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
    bind('ftt_v2_usegit', 'useStGitEndpoint', 'bool');
    bind('ftt_v2_updrepo', 'updateRepo', 'text');

    // P5 首批：内核配置控件（改值即写回 ST 配置并刷新状态块）
    for (const id of Object.keys(PANEL_CFG_BINDINGS)) {
        const el = doc.getElementById(id);
        if (!el) continue;
        el.addEventListener('change', () => applyPanelCfg(id, PANEL_CFG_BINDINGS[id][1] === 'bool' ? !!el.checked : el.value));
    }
    // 维度开关（容器内的 data-ftt-dim 勾选框；桩 DOM 无 querySelectorAll → 由 index 传入的维度表渲染后逐个绑定）
    try {
        const dimsBox = doc.getElementById('ftt_v2_dims');
        if (dimsBox && dimsBox.children && dimsBox.children.length) {
            dimsBox.children.forEach((el) => {
                const kind = el.getAttribute ? el.getAttribute('data-ftt-dim') : '';
                if (kind) el.addEventListener('change', () => applyPanelDim(kind, !!el.checked));
            });
        }
    } catch (e) { /* 忽略 */ }
    bindPanelAction(doc, 'ftt_v2_analyze', async () => {
        if (typeof panelHooks.extract !== 'function') return setActionNote('提取入口未就绪');
        setActionNote('分析中…');
        const r = await panelHooks.extract({});
        if (r && Array.isArray(r.results)) return setActionNote('分析完成：成功 ' + r.done + ' / ' + r.results.length + (r.note ? '（' + r.note + '）' : ''));
        return setActionNote(r && r.ok ? ('新增 ' + r.added + ' 条（共 ' + r.total + ' 条）') : ('未完成：' + String((r && r.reason) || '未知')));
    });
    bindPanelAction(doc, 'ftt_v2_list', async () => {
        if (typeof panelHooks.pending !== 'function') return setActionNote('清单入口未就绪');
        const list = panelHooks.pending({}) || [];
        return setActionNote(list.length ? ('待分析楼层：' + list.join('、')) : '没有待分析楼层');
    });
    bindPanelAction(doc, 'ftt_v2_clearinj', async () => {
        if (typeof panelHooks.clearInject !== 'function') return setActionNote('注入入口未就绪');
        panelHooks.clearInject();
        return setActionNote('已清空注入');
    });
    bindPanelAction(doc, 'ftt_v2_imp_dry', async () => {
        if (typeof panelHooks.importV1 !== 'function') return setActionNote('导入入口未就绪');
        setActionNote('读取 V1 数据…');
        const r = await panelHooks.importV1({});
        const t = (r && r.report && r.report.totals) || {};
        return setActionNote('【干跑】' + (r && r.via ? r.via : '无源数据') + '：新增 ' + (t.add || 0) + ' · 已存在 ' + (t.exist || 0) + ' · 冲突 ' + (t.conflict || 0));
    });
    bindPanelAction(doc, 'ftt_v2_imp_apply', async () => {
        if (typeof panelHooks.importV1 !== 'function') return setActionNote('导入入口未就绪');
        setActionNote('导入并写入…');
        const r = await panelHooks.importV1({ apply: true });
        const t = (r && r.report && r.report.totals) || {};
        return setActionNote('【已写入】新增 ' + (t.add || 0) + ' 条（源数据未删除）');
    });

    bindPanelAction(doc, 'ftt_v2_console_refresh', async () => {
        const r = consoleAction('refresh', {});
        try { bindConsole(); } catch (e) { /* 忽略 */ }
        return setActionNote('数据台已刷新（共 ' + (consoleConfig().dims) + ' 个维度）');
    });

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
                .then(r => setUpdateStatusLine(r.ok
                    ? ('宿主 Git 更新已执行' + (r.commit ? '（' + r.commit + '）' : '') + '，请重载页面')
                    : (r.disabled ? ('未执行：' + (r.error || '宿主 Git 端点已关闭')) : ('宿主 Git 更新失败：' + (r.error || '未知')))))
                .catch(e => setUpdateStatusLine('ST 更新失败：' + String((e && e.message) || e)));
        });
    }
    return true;
}

/** 绑定动作按钮（执行中禁用、完成后回填提示；异常只提示不抛） */
function bindPanelAction(doc, id, run) {
    const el = doc.getElementById(id);
    if (!el) return false;
    el.addEventListener('click', () => {
        Promise.resolve()
            .then(run)
            .catch((e) => setActionNote('操作失败：' + String((e && e.message) || e)));
    });
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
    panelMounted = false;
    lastMount = Object.assign(lastMount, { ok: false, via: 'none', reason: '已卸载' });
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(ROOT_ID) : null;
    if (!el || !el.parentNode) return true;              // 桩 DOM 无 DOM 树：视为已清状态
    try { el.parentNode.removeChild(el); return true; } catch (e) { return false; }
}

export const PANEL_IDS = Object.freeze({ mount: MOUNT_ID, root: ROOT_ID, defaults: Object.keys(DEFAULT_SETTINGS) });

/** 面板目录信息（诊断：实际用于 renderExtensionTemplateAsync 的扩展目录名） */
export function panelFolderInfo() { return folderInfo(); }
