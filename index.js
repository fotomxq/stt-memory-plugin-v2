// ============================================================
// FTT记忆组件 V2 · SillyTavern 原生扩展入口
// 分层：ui/ ─► host/ ─► adapters/ ─► core/（core 严禁反向依赖，见 scripts/check-core-purity.js）
// P0 范围：可安装骨架 + 能力探测 + 设置面板 + 事件绑定 + 生成前钩子（空实现） + 调试导出
// ============================================================
import { VERSION, DATA_VERSION, MODULE_NAME } from './core/constants.js';
import { hasHost, probeCapabilities, getCtx } from './host/st-api.js';
import { bindCoreEvents, eventTypeAvailability } from './host/events.js';
import { installGlobalInterceptor, uninstallGlobalInterceptor, interceptorStats, resetInterceptorStats } from './host/interceptor.js';
import { clearInject, injectAvailable } from './host/inject.js';
import { getSettings } from './adapters/settings.js';
import { mountSettingsPanel, unmountSettingsPanel } from './ui/settings-panel.js';
import { registerSlashCommand, registerMacros } from './ui/commands.js';
import { installDevtools, uninstallDevtools, buildSnapshot } from './devtools.js';

const runtime = {
    ready: false,
    bind: { bound: [], missing: [] },
    probe: { missing: [], ok: false },
    slash: false,
    macros: false,
    settingsVia: 'none',
    lastError: '',
};

/** 当前运行态（调试导出与测试共用） */
export function runtimeState() {
    return Object.assign({}, runtime, { interceptor: interceptorStats() });
}

export function extraForStatus() {
    return {
        host: hasHost(),
        probe: runtime.probe,
        bind: runtime.bind,
        interceptor: interceptorStats(),
    };
}

/** 初始化（幂等；任何一步失败都不影响其余步骤与宿主） */
export async function init() {
    runtime.lastError = '';
    if (!hasHost()) return { ok: false, reason: 'no-host' };
    if (runtime.ready) return { ok: true, reused: true };
    try { runtime.probe = probeCapabilities(); } catch (e) { runtime.lastError = String((e && e.message) || e); }
    try { getSettings(); } catch (e) { /* 配置失败不阻塞 */ }
    try {
        const mounted = await mountSettingsPanel({ probeMissing: runtime.probe.missing.join('、') });
        runtime.settingsVia = mounted.via;
    } catch (e) { runtime.settingsVia = 'error'; }
    try {
        // P0：事件处理器只做可观测记录；P3 接入提取/注入闭环
        const onGenEnded = () => { /* P3：runExtract() */ };
        const onUserRendered = () => { /* P3：按需及时分析 */ };
        runtime.bind = bindCoreEvents({
            GENERATION_ENDED: onGenEnded,
            USER_MESSAGE_RENDERED: onUserRendered,
            CHAT_CHANGED: () => { clearInject(); },
        });
    } catch (e) { runtime.lastError = String((e && e.message) || e); }
    try { runtime.slash = registerSlashCommand(extraForStatus); } catch (e) { runtime.slash = false; }
    try { runtime.macros = registerMacros(extraForStatus); } catch (e) { runtime.macros = false; }
    try { installDevtools(); } catch (e) { /* 忽略 */ }
    runtime.ready = true;
    return { ok: true, probe: runtime.probe, bind: runtime.bind, settingsVia: runtime.settingsVia, slash: runtime.slash, macros: runtime.macros };
}

/** 收尾（disable / delete / 重载前） */
export function teardown() {
    try { if (runtime.bind && typeof runtime.bind.unbind === 'function') runtime.bind.unbind(); } catch (e) { /* noop */ }
    try { unbindAppLifecycle(); } catch (e) { /* noop */ }
    runtime.bind = { bound: [], missing: [] };
    try { clearInject(); } catch (e) { /* noop */ }
    try { unmountSettingsPanel(); } catch (e) { /* noop */ }
    try { uninstallGlobalInterceptor(); } catch (e) { /* noop */ }
    try { uninstallDevtools(); } catch (e) { /* noop */ }
    runtime.ready = false;
    return true;
}

// ---------------- 生命周期钩子（manifest.hooks 指向这些具名导出） ----------------

/** 页面加载期（阻塞加载器还在时）执行：同步装配，保持轻量 */
export function onActivate() {
    installGlobalInterceptor();
}

/** 异步就绪：真正的初始化放在 APP_READY（不阻塞 ST 就绪） */
function hookAppReady() {
    try {
        if (!hasHost()) return;
        const snap = buildSnapshot();
        void snap;
        init().catch(() => { });
    } catch (e) { /* 忽略 */ }
}

export async function onInstall() { /* P6：初始化数据容器与版本标记 */ }
export async function onUpdate() { /* P6：按 DATA_VERSION 跑数据迁移 */ }
export async function onDelete() { teardown(); }
export function onEnable() { init().catch(() => { }); }
export function onDisable() { teardown(); }
export async function onClean() { teardown(); }

// ---------------- 模块加载期副作用（仅在有宿主时执行） ----------------

// 1) 生成前拦截器必须是全局函数（manifest.generate_interceptor 按名字查找）
installGlobalInterceptor();

// 2) 挂 APP_READY（ST 文档：该事件在监听器挂载后若已就绪会自动补发）；解绑句柄进 appOffs
const appOffs = [];
function bindAppLifecycle() {
    try {
        if (!hasHost()) return false;
        const ctx = getCtx();
        const es = ctx && ctx.eventSource;
        const et = (ctx && ctx.eventTypes) || {};
        if (!es || typeof es.on !== 'function') return false;
        const on = (type, fn) => {
            es.on(type, fn);
            appOffs.push(() => { try { if (typeof es.removeListener === 'function') es.removeListener(type, fn); else if (typeof es.off === 'function') es.off(type, fn); } catch (e) { /* noop */ } });
        };
        on(et.APP_READY || 'APP_READY', () => hookAppReady());
        on(et.APP_INITIALIZED || 'APP_INITIALIZED', () => { /* 预留：UI 注入点 */ });
        return true;
    } catch (e) { return false; }
}
function unbindAppLifecycle() {
    while (appOffs.length) { try { appOffs.pop()(); } catch (e) { /* noop */ } }
}
bindAppLifecycle();

// ---------------- 测试与自检用导出 ----------------
export const __internals = {
    VERSION, DATA_VERSION, MODULE_NAME,
    init, teardown, runtimeState, extraForStatus,
    eventTypeAvailability, interceptorStats, resetInterceptorStats, injectAvailable,
};
