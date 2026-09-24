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
        dimensions: DIMENSIONS.map(d => d.kind),
        hostEvents: HOST_EVENTS.slice(),
        status: statusText(Object.assign({ host: hasHost(), probe, interceptor: interceptorStats() }, extra || {})),
    };
}

/** 挂到 window.FTT（返回快照；不覆盖已存在的同名对象则合并） */
export function installDevtools() {
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
        });
        return true;
    } catch (e) {
        return false;
    }
}

export function uninstallDevtools() {
    try { if (globalThis.FTT && globalThis.FTT.version === VERSION) delete globalThis.FTT; return true; } catch (e) { return false; }
}
