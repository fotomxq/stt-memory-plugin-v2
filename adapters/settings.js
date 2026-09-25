// ============================================================
// adapters/settings.js —— 配置适配器（extensionSettings）
// 事实源：ST 官方文档「Persistent settings」：extensionSettings[MODULE_NAME] + saveSettingsDebounced()
// ============================================================
import { MODULE_NAME, VERSION, DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_INTERVAL_HOURS } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';

/** 默认配置（P0 只放骨架项；P1+ 按 docs/14 §3 逐步补齐 V1 的配置键） */
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    // 内核配置（V1 defaultCfg 全量 217 键的落盘容器；由 adapters/config-store.js 同步进内核视图）
    cfg: {},
    // 注入
    injectEnabled: true,
    injectDepth: 0,
    charBudget: 2000,
    // 提取
    autoSummary: true,
    autoExtract: true,
    timelyAnalysis: false,
    // 生成前拦截器
    interceptorEnabled: true,
    // 更新（用户要求：以 GitHub 项目地址作为更新检查地址；首次启动自动检查 + 设置内手动检查）
    autoUpdateCheck: true,
    // 宿主 Git 更新端点（POST /api/extensions/version|update）—— **默认关**：
    //   无 git 能力的宿主（如 TauriTavern 原生移植）上，该端点会做远端 git handshake，失败即返回
    //   「Failed to get extension version: Git handshake failed…」，宿主以「后端错误」弹窗暴露给用户。
    //   本插件默认只用 GitHub raw 清单（HTTP）判定版本；需要由酒馆代做 git 更新时再显式开启。
    useStGitEndpoint: false,
    updateRepo: DEFAULT_UPDATE_REPO,
    updateBranch: DEFAULT_UPDATE_BRANCH,
    updateCheckIntervalHours: DEFAULT_UPDATE_INTERVAL_HOURS,
    // v2.36.0：面板最大宽度（px；0 = 铺满不设上限）—— 手机端由 CSS 媒体查询恒铺满，此值只作用于 ≥1025px 的桌面与平板区间；
    //   为什么放在 extensionSettings 而不是内核 cfg：这是**界面偏好**（与更新检查/入口开关同类），不属于记忆内核配置。
    panelMaxWidth: 1280,
    // 迁移
    migratedFrom: '',
});

function hostSettings() {
    const ctx = getCtx();
    if (!ctx) return null;
    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') return null;
    if (!ctx.extensionSettings[MODULE_NAME] || typeof ctx.extensionSettings[MODULE_NAME] !== 'object') {
        ctx.extensionSettings[MODULE_NAME] = {};
    }
    return ctx.extensionSettings[MODULE_NAME];
}

/** 取配置：缺失键用默认值补齐（不覆盖用户值） */
export function getSettings() {
    const store = hostSettings();
    if (!store) return Object.assign({}, DEFAULT_SETTINGS);
    let changed = false;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(store, k)) { store[k] = DEFAULT_SETTINGS[k]; changed = true; }
    }
    if (store.version !== VERSION) { store.version = VERSION; changed = true; }
    if (changed) saveSettings();
    return store;
}

/** 保存配置（ST 原生防抖保存；无宿主时返回 false） */
export function saveSettings() {
    const ctx = getCtx();
    if (!ctx || typeof ctx.saveSettingsDebounced !== 'function') return false;
    try { ctx.saveSettingsDebounced(); return true; } catch (e) { return false; }
}

/** 恢复默认（只重置已知键，保留未知键以免误删未来数据） */
export function resetSettings() {
    const store = hostSettings();
    if (!store) return Object.assign({}, DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS)) store[k] = DEFAULT_SETTINGS[k];
    saveSettings();
    return store;
}

/** 写入单个配置键 */
export function setSetting(key, value) {
    const store = getSettings();
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return false;
    if (key === 'panelMaxWidth') {
        // 归一：有限数且 ≥0 → 取整并夹在 [0, 4000]；非法值回落默认（0 = 铺满）
        const n = Number(value);
        store[key] = (Number.isFinite(n) && n >= 0) ? Math.min(4000, Math.round(n)) : DEFAULT_SETTINGS.panelMaxWidth;
    } else {
        store[key] = value;
    }
    saveSettings();
    return true;
}

/** v2.36.0：面板宽度档位 → CSS 变量值（0 = 铺满：变量置 100vw，实际由 `calc(100vw - 32px)` 收边） */
export function panelWidthCssValue(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return '100vw';
    return Math.min(4000, Math.round(n)) + 'px';
}
