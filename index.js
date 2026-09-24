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
import { maybeAutoCheckOnStartup, updateStatusText } from './host/update.js';
import { setUpdateStatusLine } from './ui/settings-panel.js';
import { readUpdateState } from './adapters/update-state.js';
import { wireKernelChatHooks, attachKernelState, latestAiMessageText } from './host/chat.js';
import { wirePersistHooks, loadFromLocalStorage, loadFromServerFile, storeStatus, scheduleSave, saveStateNow } from './adapters/store.js';
import { importV1Data } from './adapters/import-v1.js';
import { state as kernelState } from './core/model/runtime.js';
import { migrateState } from './core/migrate.js';
import { emptyState } from './core/state.js';
import { setLastMessageId } from './core/model/runtime.js';

const runtime = {
    ready: false,
    bind: { bound: [], missing: [] },
    probe: { missing: [], ok: false },
    slash: false,
    macros: false,
    settingsVia: 'none',
    update: { ran: false, reason: '', summary: null },
    store: { via: 'none', scope: '', last: null },
    import: { runs: 0, last: null },
    chat: { messages: 0, lastMessageId: -1, scopeKey: '' },
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
        store: runtime.store,
        chat: runtime.chat,
        import: runtime.importSummary || '',
        update: (runtime.update && runtime.update.summary) || readUpdateState().lastResult || null,
    };
}

/**
 * 载入记忆容器（P2）：聊天注入视图接线 → 持久化钩子接线 → 本机缓冲 → 服务端文件 → 迁移 → 注入内核。
 * 顺序与 V1 一致；任一步失败都降级（最差回落到空容器），绝不抛出。
 * @returns {Promise<{via:string, scope:string}>} via = local | file | new
 */
export async function loadMemoryState() {
    let via = 'new';
    let st = null;
    try { runtime.chat = wireKernelChatHooks(); } catch (e) { /* 聊天视图缺失不阻塞 */ }
    try { wirePersistHooks(); } catch (e) { /* 忽略 */ }
    try { st = loadFromLocalStorage(); if (st) via = 'local'; } catch (e) { st = null; }
    if (!st) { try { st = await loadFromServerFile(); if (st) via = 'file'; } catch (e) { st = null; } }
    if (st) { try { st = migrateState(st); } catch (e) { /* 迁移失败则按原样使用 */ } }
    if (!st || typeof st !== 'object') { st = emptyState(); via = 'new'; }
    try { attachKernelState(st); } catch (e) { runtime.lastError = String((e && e.message) || e); }
    try { setLastMessageId(runtime.chat.lastMessageId); } catch (e) { /* 忽略 */ }
    try { runtime.store = Object.assign({ via }, storeStatus()); } catch (e) { runtime.store = { via }; }
    return { via, scope: runtime.store.scope || '' };
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
    try { await loadMemoryState(); } catch (e) { runtime.lastError = String((e && e.message) || e); }
    try {
        // P2：楼层变化即刷新内核视图（只读映射，不写数据）；P3 在此接入提取/注入闭环
        const onFloorChanged = () => {
            try { runtime.chat = wireKernelChatHooks(); } catch (e) { /* 忽略 */ }
        };
        const onGenEnded = () => {
            onFloorChanged();
            try { void saveStateNowQuiet('generation'); } catch (e) { /* P3：提取后保存 */ }
        };
        const onUserRendered = () => { onFloorChanged(); };
        const onChatChanged = () => {
            clearInject();
            onFloorChanged();
            // 切换角色/聊天 → 作用域变化 → 重新载入该作用域容器
            void loadMemoryState().catch(() => { });
        };
        runtime.bind = bindCoreEvents({
            GENERATION_ENDED: onGenEnded,
            USER_MESSAGE_RENDERED: onUserRendered,
            CHARACTER_MESSAGE_RENDERED: onFloorChanged,
            CHAT_CHANGED: onChatChanged,
        });
    } catch (e) { runtime.lastError = String((e && e.message) || e); }
    try { runtime.slash = registerSlashCommand(extraForStatus, { importV1: runV1Import }); } catch (e) { runtime.slash = false; }
    try { runtime.macros = registerMacros(extraForStatus); } catch (e) { runtime.macros = false; }
    try { installDevtools({ importV1: runV1Import, importStatus }); } catch (e) { /* 忽略 */ }
    // 首次启动自动检查更新（不 await：绝不阻塞初始化与发送；失败静默）
    try { void startupUpdateCheck(); } catch (e) { /* 忽略 */ }
    runtime.ready = true;
    return { ok: true, probe: runtime.probe, bind: runtime.bind, settingsVia: runtime.settingsVia, slash: runtime.slash, macros: runtime.macros, store: runtime.store };
}

/**
 * 启动时更新检查（首次启动必查，之后按间隔；失败静默不阻塞）。
 * 用户要求：「构建首次启动插件自动检查、设定手动检查更新的机制」。
 * @param {object} [opts] manual / now
 */
export async function startupUpdateCheck(opts) {
    try {
        const r = await maybeAutoCheckOnStartup(opts || {});
        runtime.update = { ran: !!r.ran, reason: r.reason, summary: r.summary || null };
        if (r.ran && r.summary) { try { setUpdateStatusLine(updateStatusText(r.summary)); } catch (e) { /* 面板可能未挂载 */ } }
        return r;
    } catch (e) {
        runtime.update = { ran: false, reason: 'error', summary: null };
        return { ran: false, reason: 'error' };
    }
}

/** 手动检查更新（设置面板按钮 / 斜杠命令调用同一入口） */
export async function checkUpdateNow() {
    return startupUpdateCheck({ manual: true });
}

/**
 * V1 数据导入（P2 次批）：默认**干跑**，`apply: true` 才合并写入。
 * 用户要求（不丢数据 / 可回退）：合并为 append-only（同 id 以当前为准），源数据一律不删。
 * @param {object} [opts] apply / identity
 * @returns {Promise<object>} importV1Data 结果（含 report / merged / notes）
 */
export async function runV1Import(opts) {
    const o = opts || {};
    const apply = o.apply === true;
    const res = await importV1Data({
        dryRun: !apply,
        identity: o.identity,
        current: kernelState,
        apply: apply ? async (merged) => {
            attachKernelState(merged);
            await saveStateNow({ reason: 'import-v1' });
        } : null,
    });
    const t = (res.report && res.report.totals) || { v1Entries: 0, add: 0, exist: 0, conflict: 0 };
    runtime.import = { runs: (runtime.import.runs || 0) + 1, last: { at: Date.now(), dryRun: !!res.dryRun, via: res.via, name: res.name, totals: t } };
    runtime.importSummary = (res.dryRun ? '干跑 ' : '已写入 ') + (res.via ? res.via + '/' + res.name : '无源数据')
        + '：新增 ' + t.add + ' · 已存在 ' + t.exist + ' · 冲突 ' + t.conflict;
    return res;
}

/** 导入状态（/ftt 与 FTT.importStatus()） */
export function importStatus() { return runtime.import; }

/** 静默保存（事件路径用；失败只记录，不影响交互） */
export function saveStateNowQuiet(reason) {
    try { return scheduleSave(reason || 'event'); } catch (e) { return false; }
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
    startupUpdateCheck, checkUpdateNow,
};
