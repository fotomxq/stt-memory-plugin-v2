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
            floatingInfo: () => (hooks && typeof hooks.floatingInfo === 'function' ? hooks.floatingInfo() : null),
            openPanel: () => (hooks && typeof hooks.openPanelPopup === 'function' ? hooks.openPanelPopup() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            ui: (tab) => (hooks && typeof hooks.openPanelPopup === 'function' ? hooks.openPanelPopup(tab) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            popupInfo: () => (hooks && typeof hooks.popupInfo === 'function' ? hooks.popupInfo() : null),
            panelInfo: () => (hooks && typeof hooks.v1PanelInfo === 'function' ? hooks.v1PanelInfo() : null),
            panelTabs: () => (hooks && typeof hooks.v1PanelTabs === 'function' ? hooks.v1PanelTabs() : []),
            injectNow: () => (hooks && typeof hooks.injectNow === 'function' ? hooks.injectNow() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            summary: (opts) => (hooks && typeof hooks.summary === 'function' ? hooks.summary(opts || {}) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            abort: () => (hooks && typeof hooks.abort === 'function' ? hooks.abort() : { ok: false, reason: 'no-hook' }),
            clearFloors: () => (hooks && typeof hooks.clearFloors === 'function' ? hooks.clearFloors() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            exportState: () => (hooks && typeof hooks.exportState === 'function' ? hooks.exportState() : ''),
            importState: (text) => (hooks && typeof hooks.importState === 'function' ? hooks.importState(text) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            popupAction: (a, p) => (hooks && typeof hooks.popupAction === 'function' ? hooks.popupAction(a, p || {}) : Promise.resolve({ ok: false, reason: 'no-hook' })),
            // B7-2 跨端同步（与 V1 `FTT.*` 同名能力）
            syncStatus: () => (hooks && typeof hooks.syncStatus === 'function' ? hooks.syncStatus() : null),
            syncInfo: () => (hooks && typeof hooks.syncInfo === 'function' ? hooks.syncInfo() : null),
            syncNow: () => (hooks && typeof hooks.syncNow === 'function' ? hooks.syncNow() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            syncRefresh: () => (hooks && typeof hooks.syncRefresh === 'function' ? hooks.syncRefresh() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            syncVerify: () => (hooks && typeof hooks.syncVerify === 'function' ? hooks.syncVerify() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            syncLog: () => (hooks && typeof hooks.syncLog === 'function' ? hooks.syncLog() : []),
            syncLogClear: () => (hooks && typeof hooks.syncLogClear === 'function' ? hooks.syncLogClear() : 0),
            syncLogMerge: () => (hooks && typeof hooks.syncLogMerge === 'function' ? hooks.syncLogMerge() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            syncLogServerStatus: () => (hooks && typeof hooks.syncLogServerStatus === 'function' ? hooks.syncLogServerStatus() : null),
            syncLogPush: (rec) => (hooks && typeof hooks.syncLogPush === 'function' ? hooks.syncLogPush(rec || {}) : 0),
            syncSource: () => (hooks && typeof hooks.syncSource === 'function' ? hooks.syncSource() : ''),
            syncDropCache: () => (hooks && typeof hooks.syncDropCache === 'function' ? hooks.syncDropCache() : false),
            storageBootstrap: () => (hooks && typeof hooks.storageBootstrap === 'function' ? hooks.storageBootstrap() : Promise.resolve({ ok: false, reason: 'no-hook' })),
            // B8-1 剧情时钟（巡检 / 锚点 / 手工改写）
            clockUi: () => (hooks && typeof hooks.clockUi === 'function' ? hooks.clockUi() : null),
            clockPatrol: (opts) => (hooks && typeof hooks.clockPatrol === 'function' ? hooks.clockPatrol(opts || {}) : null),
            clockPatrolState: () => (hooks && typeof hooks.clockPatrolState === 'function' ? hooks.clockPatrolState() : null),
            clockPatrolAuto: () => (hooks && typeof hooks.clockPatrolAuto === 'function' ? hooks.clockPatrolAuto() : null),
            clockAnchor: () => (hooks && typeof hooks.clockAnchor === 'function' ? hooks.clockAnchor() : null),
            clockMajority: () => (hooks && typeof hooks.clockMajority === 'function' ? hooks.clockMajority() : null),
            clockScan: () => (hooks && typeof hooks.clockScan === 'function' ? hooks.clockScan() : null),
            clockManual: () => (hooks && typeof hooks.clockManual === 'function' ? hooks.clockManual() : null),
            clockManualSet: (input) => (hooks && typeof hooks.clockManualSet === 'function' ? hooks.clockManualSet(input || {}) : { ok: false, notes: ['no-hook'] }),
            clockManualClear: () => (hooks && typeof hooks.clockManualClear === 'function' ? hooks.clockManualClear() : false),
            // B8-2 剧情时钟自动提取
            clockResolve: (opts) => (hooks && typeof hooks.clockResolve === 'function' ? hooks.clockResolve(opts || {}) : null),
            clockExtractOnce: (opts) => (hooks && typeof hooks.clockExtractOnce === 'function' ? hooks.clockExtractOnce(opts || {}) : Promise.resolve(false)),
            clockExtractState: () => (hooks && typeof hooks.clockExtractState === 'function' ? hooks.clockExtractState() : null),
            clockExtractSchedule: () => (hooks && typeof hooks.clockExtractSchedule === 'function' ? hooks.clockExtractSchedule() : false),
            clockHeader: (text) => (hooks && typeof hooks.clockHeader === 'function' ? hooks.clockHeader(text) : null),
            clockExtractText: (text, prev) => (hooks && typeof hooks.clockExtractText === 'function' ? hooks.clockExtractText(text, prev || {}) : null),
            clockScene: () => (hooks && typeof hooks.clockScene === 'function' ? hooks.clockScene() : ''),
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
