// ============================================================
// devtools.js —— 调试导出（window.FTT，替代 V1 的 window.__FTT）
// 约定：只读快照 + 少量探针函数；不暴露写数据能力（避免误操作）。
// ============================================================
import { VERSION, DATA_VERSION, MODULE_NAME, DIMENSIONS, HOST_EVENTS } from './core/constants.js';
import { hasHost, probeCapabilities, currentCharScope } from './host/st-api.js';
import { interceptorStats } from './host/interceptor.js';
import { readInject, injectAvailable } from './host/inject.js';
import { getSettings } from './adapters/settings.js';
import { statusText } from './ui/commands.js';
import { readUpdateState } from './adapters/update-state.js';
import { updateStatusText, hasUpdate, updateConfig } from './host/update.js';

export function buildSnapshot(extra) {
    const probe = hasHost() ? probeCapabilities() : { need: {}, missing: ['host'], ok: false };
    return {
        name: 'FTT记忆组件 V2',
        version: VERSION,
        dataVersion: DATA_VERSION,
        moduleName: MODULE_NAME,
        host: hasHost(),
        scope: currentCharScope(),
        probe,
        interceptor: interceptorStats(),
        inject: { available: injectAvailable(), key: MODULE_NAME, length: readInject().length },
        settings: getSettings(),
        update: { config: updateConfig(), state: readUpdateState(), status: updateStatusText(), hasUpdate: hasUpdate() },
        dimensions: DIMENSIONS.map(d => d.kind),
        hostEvents: HOST_EVENTS.slice(),
        status: statusText(Object.assign({ host: hasHost(), probe, interceptor: interceptorStats() }, extra || {})),
    };
}

/** 挂到 window.FTT（返回快照；不覆盖已存在的同名对象则合并） */
export function installDevtools(hooks) {
    const snap = buildSnapshot();
    try {
        const w = globalThis;
        w.FTT = Object.assign({}, w.FTT || {}, {
            version: snap.version,
            dataVersion: snap.dataVersion,
            snapshot: () => buildSnapshot(),
            status: () => snap.status,
            probe: () => probeCapabilities(),
            interceptor: () => interceptorStats(),
            injectLength: () => readInject().length,
            update: () => buildSnapshot().update,
            // P2：V1 数据导入（默认干跑；apply:true 才写入）
            importV1: (opts) => (hooks && typeof hooks.importV1 === 'function' ? hooks.importV1(opts || {}) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            importStatus: () => (hooks && typeof hooks.importStatus === 'function' ? hooks.importStatus() : null),
            // P4：提取（AI 摘要）入口
            analyze: (opts) => (hooks && typeof hooks.extract === 'function' ? hooks.extract(opts || {}) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            pendingFloors: (opts) => (hooks && typeof hooks.pendingFloors === 'function' ? hooks.pendingFloors(opts || {}) : []),
            extractStatus: () => (hooks && typeof hooks.extractStatus === 'function' ? hooks.extractStatus() : null),
            i18n: () => (hooks && typeof hooks.i18n === 'function' ? hooks.i18n() : null),
            folderInfo: () => (hooks && typeof hooks.folderInfo === 'function' ? hooks.folderInfo() : null),
            // 可见性诊断（用户报「装上了但看不到面板」时的第一现场）
            panelInfo: () => (hooks && typeof hooks.panelInfo === 'function' ? hooks.panelInfo() : null),
            menuInfo: () => (hooks && typeof hooks.menuInfo === 'function' ? hooks.menuInfo() : null),
            forceMount: () => (hooks && typeof hooks.forceMountPanel === 'function' ? hooks.forceMountPanel() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            t: (key, vars) => (hooks && typeof hooks.t === 'function' ? hooks.t(key, vars) : String(key == null ? '' : key)),
        });
        return true;
    } catch (e) {
        return false;
    }
}

export function uninstallDevtools() {
    try { if (globalThis.FTT && globalThis.FTT.version === VERSION) delete globalThis.FTT; return true; } catch (e) { return false; }
}
