// ============================================================
// FTT记忆组件 V2 · SillyTavern 原生扩展入口
// 分层：ui/ ─► host/ ─► adapters/ ─► core/（core 严禁反向依赖，见 scripts/check-core-purity.js）
// P0 范围：可安装骨架 + 能力探测 + 设置面板 + 事件绑定 + 生成前钩子（空实现） + 调试导出
// ============================================================
import { VERSION, DATA_VERSION, MODULE_NAME, DIMENSIONS } from './core/constants.js';
import { hasHost, probeCapabilities, getCtx } from './host/st-api.js';
import { bindCoreEvents, eventTypeAvailability, installErrorCapture, uninstallErrorCapture, errorCaptureState } from './host/events.js';
import { installGlobalInterceptor, uninstallGlobalInterceptor, interceptorStats, resetInterceptorStats } from './host/interceptor.js';
import { clearInject, injectAvailable, pushMemoryInject, pushStats } from './host/inject.js';
import { getSettings } from './adapters/settings.js';
import { mountSettingsPanel, unmountSettingsPanel, panelMountInfo } from './ui/settings-panel.js';
import { installMenuEntry, uninstallMenuEntry, menuInfo } from './ui/menu.js';
import { installFloatingEntry, uninstallFloatingEntry, floatingInfo } from './ui/floating.js';
import { openPopup, setPopupHooks, popupInfo, popupAction, popupTabs } from './ui/popup.js';
import { openPanel, closePanel, panelInfo, panelTabs, setPanelHooks2, unmountPanel } from './ui/panel.js';
import { fallbackPanelHtml, panelData, setPanelHooks as setPanelHooksRef, bindPanelEvents } from './ui/settings-panel.js';
import { registerSlashCommand, registerMacros } from './ui/commands.js';
import { installDevtools, uninstallDevtools, buildSnapshot } from './devtools.js';
import { maybeAutoCheckOnStartup, updateStatusText } from './host/update.js';
import { setUpdateStatusLine } from './ui/settings-panel.js';
import { readUpdateState } from './adapters/update-state.js';
import { wireKernelChatHooks, attachKernelState, latestAiMessageText } from './host/chat.js';
import { wirePersistHooks, loadFromLocalStorage, loadFromServerFile, storeStatus, scheduleSave, saveStateNow, primeStateIndex, resetState } from './adapters/store.js';
import { wireDebugLog, debugLogPush, debugLogList, debugLogClear, debugLogStats } from './adapters/debug-log.js';
import { debugLogErrors, debugLogErrorCount, debugLogLastError } from './core/debug-log.js';
import {
    aboutLoadJson, aboutEnsureLoaded, getAboutData, getAboutState, aboutSortDesc, aboutHtml,
    aboutClearCache, aboutCandidateUrls, aboutFallback, ABOUT_JSON_PATHS, aboutInfo, aboutDirUrl,
} from './ui/about.js';
import { importV1Data, mergeV1IntoCurrent } from './adapters/import-v1.js';
import { autoExtractLatest, analyzeFloors, analyzeFloor, extractSummary, extractStats, runAutoSummary, abortExtract, batchProgress, clearFloors, extractBusy, runSummarySeparate, summaryDimGroups, separateGroupingEnabled } from './host/extract.js';
import { listUnprocessedFloors, collectFloorLinesInRange, buildFeedFloorText, hashFloorText } from './host/floors.js';
import { loadKernelCfg, saveKernelCfg } from './adapters/config-store.js';
import { readInject } from './host/inject.js';
import { registerLocaleData, i18nStats, t } from './adapters/i18n.js';
import { folderInfo } from './host/paths.js';
import { state as kernelState } from './core/model/runtime.js';
import { migrateState } from './core/migrate.js';
import { emptyState } from './core/state.js';
import { setLastMessageId, setNotifyHooks, setIdentityView, setTimerHooks, cfg as cfgRef } from './core/model/runtime.js';
import {
    clockPatrolAutoOnce, clockPatrolState, clockManualState, setClockManual, clearClockManual,
    runClockPatrolRepair, clockPatrolAnchorInfo, clockPatrolMajority, clockPatrolScan,
} from './core/clock-patrol.js';
import {
    setRepairHooks, runRepairMech, runRepair, repairReport, repairLogPush, repairTotalCount,
    autoRepairTake, autoRepairOpDue, bumpRepairOp, repairIsGarbage, repairBannedOf,
    repairMergeDedupe, repairPruneGarbage, repairDecayPass, latestFloorHash,
    repairCollectCandidates, buildRepairPrompt, repairApplyAiResult, repairDefectOf,
    repairCorrelationMap, repairTagSetOf, repairJaccard, scheduleAutoRepairOnMergeFail, cancelRepairTimers,
} from './core/repair.js';
import {
    relRepairMaint, relMaintCounts, relMaintTouched, relMaintSummary, mergeRelMaint, demoteRelLinkOrphans,
} from './core/rel-maint.js';
import {
    runRumorEvolve, runRumorEvolveNow, runRumorDecay, clearRumors, rumorTickState, rumorEnabledOn,
    rumorEveryRounds, rumorNeedRounds, rumorRoll, rumorDecayScore, rumorExpired, rumorInjLine, flattenRumor,
} from './core/rumor-evolve.js';
import { buildWorldbookEntries, buildWorldbookKeys, worldbookIsFttEntry, worldbookLegacyEntryName, worldbookTotalBytes, worldbookMemoryTotal } from './core/worldbook.js';
import { scheduleWorldbookSync, worldbookSyncNow, worldbookSyncState } from './adapters/worldbook.js';
import { refreshWorldbookNames, worldbookNames } from './host/worldbook.js';
import {
    GROUP_REPAIR_SPECS, groupRepairSpec, groupRelatedness, groupClusters, groupPick,
    memoryMergeExact, buildMemoryRepairPrompt, applyMemoryMergeGroups, runMemoryRepair,
    conceptMergeExact, conceptRelatedness, conceptClusters, conceptPickClusters,
    buildConceptRepairPrompt, applyConceptMergeGroups, runConceptRepair,
} from './core/group-repair.js';
import { buildSceneRepairPrompt, applySceneRebuild, runSceneRepair } from './core/scene-repair.js';
import {
    isCurrencyItemName, itemMergeExact, itemLowUsesPurge,
    buildItemRepairPrompt, applyItemMergeGroups, runItemRepair,
} from './core/item-repair.js';
import {
    SNAP_REPAIR_FIELDS, SNAP_REPAIR_FIELD_MAP, snapshotAtomSize, buildCharacterRepairQueue,
    setSnapshotByPath, buildCharacterRepairPrompt, applyCharacterRepairResult, runCharacterRepair,
    characterEvidencePack, ensureSnapshotTags, deriveSnapshotTags, runCharacterMechanicalPass, correctSnapshotBirthDates,
} from './core/character-repair.js';
import {
    STATE_REPAIR_FIELDS, stateCanonField, stateRepairRoster, stateSubjectMatch, stateRepairMatch, stateRepairClean,
    removeStatesOfDeceased, pickStateRepairTargets, buildStateRepairPrompt, applyStateRepair, runStateRepair,
} from './core/state-repair.js';
import {
    suspenseMergeExact, buildPlanSuspRepairPrompt, applyPlanSuspMerge, applySuspenseMergeGroups, runPlanSuspRepair,
} from './core/plan-repair.js';
import { retargetRelRefs } from './core/entries.js';
import {
    atomBodyChars, atomDateGrainKey, grainStartDateStr, atomCompactPlan, atomGroupPlan,
    buildAtomCompactPrompt, compactGrainLabel, applyCompactGroup, scheduleAtomCompact, runAtomCompact,
    atomMergeRange, buildAtomMergePrompt, parseAtomMergeResult, atomMergeSummary, runAtomMergeSummary,
} from './core/atom-compact.js';
import {
    plotSegmentBatchSize, plotSegmentAtomList, plotSegmentCoveredIds, plotSegmentBatchesFrom,
    plotSegmentPlan, plotSegmentPlanForIds, buildPlotSegmentPrompt, plotSegmentSameRange,
    applyPlotSegmentResult, runPlotSegmentSummary, runPlotSegmentSummarySelected,
    clearPlotSegments, deletePlotSegment, flattenPlotSegment,
} from './core/plot-segment.js';
import {
    setParallelTextHooks, weaveEnabled, weavePassiveDue, weaveInputSig, matchParallelsByKeywords,
    scheduleParallelWeave, runParallelWeave, advanceContextSeed, buildAdvanceContext, buildAdvancePrompt,
    applyAdvanceUpdate, runParallelAdvance, promoteParallelEvent, prunePromotedParallels,
    setParallelLastKeywords, parallelLastKeywords, jsExtractKeywords,
} from './core/parallel.js';
import {
    plotSegmentId, plotSegmentRange, normalizePlotSegment, normalizePlotSegmentLine, normalizePlotSegmentLines,
    parsePlotSegmentText, plotSegmentsToText, plotSegmentTimeKey, plotSegmentTimeDesc, plotSegmentTimeAsc, sortPlotSegments,
} from './core/model/segment.js';
import { atomSubState, setAtomSub } from './ui/panel.js';
// B9-b：关系表定位跳转 +「👥 选角色」（V1 v1.166 / v1.194 同名能力；状态由 ui/rel-table.js 持有）
import {
    relPickState, setRelPick, relFilterState, setRelFilter, relClearFilter,
    relKnownNames, relPickAppendRow, relPickPanelHtml, relPickQueryOf, setRelPickQuery,
    relEntryTitle, relFindEntryId, relIsRelDim, relDimLabelOf, relJump, relGoto,
} from './ui/rel-table.js';
// B9-c：投喂标签自动分析（V1 v1.141 同名能力；状态由 ui/feed-scan.js 持有）
import {
    latestAiFloorInfo, rxAnalyzeLatestText, rxNormTag, rxDedupeTagList, rxPushFeedTag, rxTagScanHtml,
    rxTagScanState, setRxTagScan, rxFeedTagLists, feedScanAction,
} from './ui/feed-scan.js';
// B9-c：货币追踪（V1 v1.183 同名能力；名单与选择器开关由 core/model/money.js 持有）
import {
    trackedCurrencyRoles, isTrackedCurrencyOwner, knownCharacterNames,
    addTrackedCurrencyRole, removeTrackedCurrencyRole, clearTrackedCurrencyRoles, trackPickState, setTrackPick,
    defaultCurrencyOwner,
} from './core/model/money.js';
import { normalizeTrackedRoles } from './core/model/scalars.js';
import {
    setClockTextHooks, resolveStoryClock, clockAutoExtractOnce, scheduleClockExtract, clockExtractState,
    extractClockFromHeader, extractClockFromText, latestSceneLocation,
} from './core/clock-extract.js';
import { storageEnvelope, storageHash } from './core/envelope.js';
import { setClockAiHooks, genClockRegexes, runClockRepair, clockRepairPack } from './core/clock-ai.js';
import {
    forgetState, forgetRunAll, runMemoryForget, sweepLowUseForget, lowUseSweepGate, cancelForgetTimers,
} from './core/forget.js';
import { runStateDecay, scenesUnionMergeAll } from './core/ingest.js';
import {
    runNsfwSoften, nsfwSoftenState, nsfwFixedReplace, nsfwScan, nsfwKeywordHits, nsfwApplyRules,
    nsfwKeywordList, nsfwRuleList, nsfwKeywordAdd, nsfwKeywordDelete, nsfwRuleAdd, nsfwRuleDelete,
    nsfwKeywordReset, nsfwRuleReset,
} from './core/nsfw.js';
import { promptToGenerateArgs } from './host/extract.js';
import { rawGenerate } from './host/generation.js';
import { clockUiInfo } from './ui/clock.js';
import {
    storageBootstrap, scheduleStorageSync, crossSyncManual, refreshFromServer, storageVerify,
    syncLogList, syncLogClear, syncLogServerMerge, syncLogServerStatus, syncLogPush, syncLocalSource,
    storageStatusInfo, resetSyncState, syncInfo, fileCacheDropAll,
    // B9-d：条目瘦身 / gzip / 跨端分歧处置（V1 `__FTT` 同名能力）
    slimFileEnvelope, slimGzipInfo, crossPendingGet, crossPendingClear, applyRemoteReplaceState,
    adoptRemoteEnvelope, crossComputeInfo, crossPendingView,
    runStorageSync, storageEnvValid,
} from './adapters/sync.js';
import {
    slimEntryForStorage, hydrateSlimEntry, slimDataForStorage, hydrateStorageData,
    snapshotIndexFrom, slimSnapshotStoreForStorage, hydrateSnapshotStore,
} from './core/slim.js';
import { gzipToBase64, gunzipFromBytes, bytesToBase64, base64ToBytes, isGzipBytes } from './adapters/gzip.js';

const runtime = {
    ready: false,
    bind: { bound: [], missing: [] },
    probe: { missing: [], ok: false },
    slash: false,
    macros: false,
    settingsVia: 'none',
    update: { ran: false, reason: '', summary: null },
    store: { via: 'none', scope: '', last: null },
    cfg: null,
    import: { runs: 0, last: null },
    i18n: { ok: false, locales: [] },
    // 启动探针：触发来源 / 轮询次数 / 可见性（面板与菜单入口）
    bootstrap: { triggers: [], pollTries: 0, startedAt: 0, lastError: '' },
    extract: { runs: 0, ok: 0 },
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
        extract: extractStats(),
        extractPending: (() => { try { return pendingFloors({}).length; } catch (e) { return null; } })(),
        i18n: i18nStats(),
        bootstrap: Object.assign({}, runtime.bootstrap, { panel: panelMountInfo(), menu: menuInfo(), floating: floatingInfo(), popup: popupInfo(), ready: runtime.ready }),
        cfg: runtime.cfg,
        inject: pushStats(),
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
    // B8-7-b：历史存档清理（V1 启动同款）——旧版「转正」只写 `promotedTo` 软标记，按 v1.196 规则移除该死条目
    //   （仅当被转正的情节仍存在；情节已删则保留原平行记录）。
    try { prunePromotedParallels(); } catch (e) { /* 软标记清理失败不影响载入 */ }
    try { setLastMessageId(runtime.chat.lastMessageId); } catch (e) { /* 忽略 */ }
    try { primeStateIndex(); } catch (e) { /* 索引基线失败不影响载入 */ }
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
    // B9-a：调试日志接线（内核环形缓冲 ⇄ localStorage；V1 `dbgLoadFromStorage()` 的 V2 等价物在 wireDebugLog 内）
    try { runtime.debug = wireDebugLog(); } catch (e) { runtime.debug = { persistent: false, synced: 0 }; }
    // v2.34.0（强化调试）：安装全局异常捕捉 —— 未捕获错误 / 未处理 Promise 拒绝自动写入调试日志（`kind='异常'`）
    try { runtime.errCapture = installErrorCapture(); } catch (e) { runtime.errCapture = false; }
    try { runtime.cfg = loadKernelCfg(); } catch (e) { runtime.cfg = null; }
    try { installHostBridges(); } catch (e) { /* 桥接失败不阻塞 */ }
    try { runtime.i18n = registerLocaleData(); } catch (e) { runtime.i18n = { ok: false, reason: 'error' }; }
    // 界面形态：**弹窗优先**（用户要求对齐 V1）；仅当 cfg.uiShowDrawer 打开时才在扩展设置抽屉里渲染卡片
    if (cfgShowDrawer()) {
        try {
            const mounted = await mountSettingsPanel({
                probeMissing: runtime.probe.missing.join('、'),
                hooks: panelHooks(),
                status: panelStatusSnapshot(),
            });
            runtime.settingsVia = mounted.via;
            runtime.bootstrap.panelReason = mounted.ok ? '' : String(mounted.reason || '');
        } catch (e) { runtime.settingsVia = 'error'; runtime.bootstrap.lastError = String((e && e.message) || e); }
    } else {
        runtime.settingsVia = 'overlay';
        runtime.bootstrap.panelReason = 'V1 同构浮层优先（cfg.uiShowDrawer = false 时不挂抽屉卡片）';
    }
    // 扩展菜单入口（主入口）→ 打开弹窗；不可用时由探针启用悬浮兜底
    try { installMenuEntry({ onClick: () => openPanelPopup() }); } catch (e) { /* 菜单入口失败不影响功能 */ }
    try { setPopupHooks(popupHooks()); } catch (e) { /* 忽略 */ }
    try { await loadMemoryState(); } catch (e) { runtime.lastError = String((e && e.message) || e); }
    // B7-2：启动对账（纯被动）—— 读服务端最新 → 原子合并 → 快照链并集 → 同步日志交叉合并；
    //   清单命中时零大文件下载；失败静默（绝不阻塞初始化与发送）。
    try { void storageBootstrap(); } catch (e) { /* 忽略 */ }
    // B8-1：载入后自动时间巡检一次（V1 `clockPatrolAutoOnce`：默认只统计，`cfg.clockPatrolAutoFix` 才自动修复）
    try {
        setTimeout(() => { try { clockPatrolAutoOnce(); } catch (e) { /* 忽略 */ } }, 2600);
    } catch (e) { /* 忽略 */ }
    try {
        // P2：楼层变化即刷新内核视图（只读映射，不写数据）；P3 在此接入提取/注入闭环
        const onFloorChanged = () => {
            try { runtime.chat = wireKernelChatHooks(); } catch (e) { /* 忽略 */ }
            // P3：楼层/状态变化后刷新注入（失败静默；构建为空时保留上一次注入）
            void pushMemoryInject({ queryText: '' }).catch(() => { });
            // B8-2：消息后自动提取剧情时钟（1.8s 防抖；`cfg.clockExtractEnabled`）
            try { scheduleClockExtract(); } catch (e) { /* 忽略 */ }
        };
        const onGenEnded = () => {
            onFloorChanged();
            try { void saveStateNowQuiet('generation'); } catch (e) { /* 忽略 */ }
            // P4：生成结束 → 自动分析最后一楼（总开关 cfg.autoExtract；失败静默，绝不影响聊天）
            void runAutoExtract().catch(() => { });
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
    try { bootstrapDiagnostics(); } catch (e) { /* 诊断入口失败不阻塞 */ }
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

/**
 * 导出当前记忆为 JSON 文本（V1「⬇ 导出」的 V2 版）：内容 = 当前内核容器 + 版本与作用域元信息。
 * 只读操作，不修改任何数据。
 */
export function exportStateJson() {
    try {
        const st = kernelState || {};
        return JSON.stringify({
            format: 'ftt-memory-v2-export',
            version: VERSION,
            scope: (runtime.store && runtime.store.scope) || '',
            at: Date.now(),
            state: JSON.parse(JSON.stringify(st)),
        }, null, 2);
    } catch (e) { return ''; }
}

/**
 * 导入 JSON（V1「⬆ 导入」的 V2 版）：接受本插件导出的信封或裸 state；
 *   **按 id 合并（append-only）**，同 id 以当前为准，绝不删除现有数据（与 V1 导入器同一口径）。
 * @returns {Promise<{ok:boolean, added?:number, reason?:string}>}
 */
export async function importStateJson(text) {
    try {
        let obj = null;
        try { obj = JSON.parse(String(text || '')); } catch (e) { return { ok: false, reason: 'JSON 解析失败' }; }
        const incoming = (obj && obj.state) ? obj.state : obj;
        if (!incoming || typeof incoming !== 'object') return { ok: false, reason: '不是有效的记忆数据' };
        const before = DIMENSIONS.reduce((n, d) => n + ((kernelState && Array.isArray(kernelState[d.kind])) ? kernelState[d.kind].length : 0), 0);
        const { merged } = mergeV1IntoCurrent(kernelState, incoming);
        attachKernelState(merged);
        await saveStateNow({ reason: 'import-json' });
        const after = DIMENSIONS.reduce((n, d) => n + ((merged && Array.isArray(merged[d.kind])) ? merged[d.kind].length : 0), 0);
        return { ok: true, added: Math.max(0, after - before) };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/** 面板只读状态快照（作用域 / 注入字数 / 提取统计 / 待分析 / 存储来源） */
function panelStatusSnapshot() {
    let injectChars = 0, pending = null;
    try { injectChars = readInject().length; } catch (e) { /* 忽略 */ }
    try { pending = pendingFloors({}).length; } catch (e) { /* 忽略 */ }
    return { scope: (runtime.store && runtime.store.scope) || '', injectChars, pending, extract: extractStats(), store: runtime.store };
}

/**
 * 诊断入口**提前注册**（模块加载即注册，不依赖 APP_READY）：
 *   ① `/ftt`、`/ftt-panel`、`/ftt-analyze`、`/ftt-import` 命令与 `{{fttVersion}}`/`{{fttStatus}}` 宏；
 *   ② `window.FTT` 调试导出（含 `panelInfo()` / `forceMount()`）。
 * 这样即使初始化没有触发（宿主事件缺失/加载时机不同），用户依然能用命令自查。
 */
function bootstrapDiagnostics() {
    const hooks = { importV1: runV1Import, extract: runExtract, summary: runSummaryBatch, abort: abortExtraction, clearFloors: clearProcessedFloors, pending: pendingFloors, panel: forceMountPanel, ui: openPanelPopup, exportState: exportStateJson, importState: importStateJson };
    try {
        if (!runtime.slash) runtime.slash = registerSlashCommand(extraForStatus, hooks);
    } catch (e) { runtime.slash = false; }
    try {
        if (!runtime.macros) runtime.macros = registerMacros(extraForStatus);
    } catch (e) { runtime.macros = false; }
    try {
        installDevtools(Object.assign({
            importV1: runV1Import, importStatus,
            // B7-2 跨端同步调试入口（与 V1 `FTT.*` 同名能力：同步状态 / 立即同步 / 刷新 / 校验 / 日志）
            syncStatus: storageStatusInfo,
            syncInfo,
            syncNow: () => crossSyncManual(),
            syncRefresh: () => refreshFromServer(),
            syncVerify: () => storageVerify(true),
            syncLog: () => syncLogList(),
            syncLogClear: () => syncLogClear(),
            syncLogMerge: () => syncLogServerMerge({ force: true }),
            syncLogServerStatus: () => syncLogServerStatus(),
            syncLogPush: (rec) => syncLogPush(rec || {}),
            syncSource: () => syncLocalSource(),
            syncDropCache: () => fileCacheDropAll(),
            // B9-d 条目瘦身 + gzip 传输（V1 `__FTT` 同名能力：slimEntryForStorage / hydrateSlimEntry /
            //   slimDataForStorage / hydrateStorageData / snapshotIndexFrom / slimSnapshotStoreForStorage /
            //   hydrateSnapshotStore / gzipToBase64 / gunzipFromBytes / bytesToBase64 / base64ToBytes）
            slimEntryForStorage: (cat, it) => slimEntryForStorage(cat, it),
            hydrateSlimEntry: (cat, it) => hydrateSlimEntry(cat, it),
            slimDataForStorage: (data, opts) => slimDataForStorage(data, opts || {}),
            hydrateStorageData: (data) => hydrateStorageData(data),
            snapshotIndexFrom: (snaps) => snapshotIndexFrom(snaps),
            slimSnapshotStoreForStorage: (snaps) => slimSnapshotStoreForStorage(snaps),
            hydrateSnapshotStore: (snaps) => hydrateSnapshotStore(snaps),
            slimFileEnvelope: (env, keepSnap) => slimFileEnvelope(env, keepSnap === true),
            gzipToBase64: (text) => gzipToBase64(text),
            gunzipFromBytes: (u8) => gunzipFromBytes(u8),
            bytesToBase64: (u8) => bytesToBase64(u8),
            base64ToBytes: (b64) => base64ToBytes(b64),
            isGzipBytes: (u8) => isGzipBytes(u8),
            slimInfo: () => slimGzipInfo(),
            // B9-d 跨端分歧处置（V1 `__FTT` 同名能力：crossComputeInfo / crossPendingGet / crossPendingClear /
            //   applyRemoteReplaceState / adoptRemoteEnvelope）
            crossComputeInfo: (localData, remoteData, remoteTs) => crossComputeInfo(localData, remoteData, remoteTs),
            crossPendingGet: () => crossPendingGet(),
            crossPendingView: () => crossPendingView(),
            crossPendingClear: () => crossPendingClear(),
            applyRemoteReplaceState: (env) => applyRemoteReplaceState(env),
            adoptRemoteEnvelope: (env) => adoptRemoteEnvelope(env),
            // V1 `__FTT` 同名：`crossPullPolicy(label, opts)`（自动对账入口；V2 的等价物是 `runStorageSync`，
            //   `label` 仅作签名兼容——V2 无多后端触发源标签）
            crossPullPolicy: (label, opts) => runStorageSync(!!(opts && opts.force)),
            // V1 `__FTT` 同名：`storageEnvelope` / `storageHash` / `storageEnvValid`（信封构造与校验；供诊断/测试造数据）
            storageEnvelope: (data) => storageEnvelope(data),
            storageHash: (payload) => storageHash(payload),
            storageEnvValid: (env) => storageEnvValid(env),
            // B8-1 剧情时钟（与 V1 `FTT.*` 同名能力：巡检 / 锚点 / 手工改写）
            clockUi: () => clockUiInfo(),
            clockPatrol: (opts) => runClockPatrolRepair(opts || {}),
            clockPatrolState: () => clockPatrolState(),
            clockPatrolAuto: () => clockPatrolAutoOnce(),
            clockAnchor: () => clockPatrolAnchorInfo(),
            clockMajority: () => clockPatrolMajority(),
            clockScan: () => clockPatrolScan(),
            clockManual: () => clockManualState(),
            clockManualSet: (input) => setClockManual(input || {}),
            clockManualClear: () => clearClockManual(),
            // B8-2 剧情时钟自动提取（多源择优 + 降级）
            clockResolve: (opts) => resolveStoryClock(opts || {}),
            clockExtractOnce: (opts) => clockAutoExtractOnce(opts || {}),
            clockExtractState: () => clockExtractState(),
            clockExtractSchedule: () => scheduleClockExtract(),
            clockHeader: (text) => extractClockFromHeader(text),
            clockExtractText: (text, prev) => extractClockFromText(text, prev || {}),
            // B8-3 时钟域 AI 管线
            clockRegexGen: (opts) => genClockRegexes(opts || {}),
            clockRepair: (opts) => runClockRepair(opts || {}),
            clockRepairPack: () => clockRepairPack(),
            // B8-4 内容弱化（NSFW）
            nsfwState: () => nsfwSoftenState(),
            nsfwSoften: (opts) => runNsfwSoften(opts || {}),
            nsfwFixed: (opts) => nsfwFixedReplace(opts || {}),
            nsfwScan: (opts) => nsfwScan(opts || {}),
            nsfwHits: (text) => nsfwKeywordHits(text),
            nsfwApply: (text) => nsfwApplyRules(text),
            nsfwKeywords: () => nsfwKeywordList(),
            nsfwRules: () => nsfwRuleList(),
            nsfwKeywordAdd: (kw) => nsfwKeywordAdd(kw),
            nsfwKeywordDelete: (i) => nsfwKeywordDelete(i),
            nsfwRuleAdd: (f, t) => nsfwRuleAdd(f, t),
            nsfwRuleDelete: (i) => nsfwRuleDelete(i),
            nsfwKeywordReset: () => nsfwKeywordReset(),
            nsfwRuleReset: () => nsfwRuleReset(),
            // B8-5 遗忘域（状态衰退 / 记忆遗忘 / 通用清扫；V1 中为自动行为，这里另给诊断入口）
            forgetState: () => forgetState(),
            forgetRunAll: (opts) => forgetRunAll(opts || {}),
            stateDecay: (opts) => runStateDecay(opts || {}),
            memoryForget: (opts) => runMemoryForget(opts || {}),
            lowUseSweep: (opts) => sweepLowUseForget(opts || {}),
            lowUseGate: (every) => lowUseSweepGate('general', every),
            // B8-6a 修复管线（第 1 段 机械清理；第 2/3 段属 B8-6b）
            repairMech: (opts) => runRepairMech(opts || {}),
            repairReport: (o) => repairReport(o || {}),
            repairLog: () => (Array.isArray(kernelState && kernelState.repairLog) ? kernelState.repairLog.slice() : []),
            repairTotal: () => repairTotalCount(),
            repairGateTake: (reset) => autoRepairTake(!!reset),
            repairGateDue: () => autoRepairOpDue(),
            repairBumpOp: () => { bumpRepairOp(); return true; },
            repairIsGarbage: (text, min) => repairIsGarbage(text, min),
            repairBanned: (text) => repairBannedOf(text),
            repairDedupe: () => repairMergeDedupe(),
            repairPrune: () => repairPruneGarbage(),
            repairDecay: () => repairDecayPass(),
            latestFloorHash: () => latestFloorHash(),
            repairLogPush: (rec) => repairLogPush(rec || {}),
            // B8-6b 修复第 2/3 段（候选筛选 + 窄契约 AI 修订）
            repair: (opts) => runRepair(opts || {}),
            repairCandidates: (limit, stat) => repairCollectCandidates(limit, stat || {}),
            repairPrompt: (cands) => buildRepairPrompt(cands),
            repairApply: (delta, cands) => repairApplyAiResult(delta, cands),
            repairDefect: (dim, e) => repairDefectOf(dim, e),
            repairCorr: (dim, arr) => repairCorrelationMap(dim, arr),
            repairTags: (entries) => repairTagSetOf(entries),
            repairJaccard: (a, b) => repairJaccard(a, b),
            repairFailArmed: () => scheduleAutoRepairOnMergeFail(),
            // B8-7 传言演化（零 AI）与世界书单向镜像
            rumorEvolve: (opts) => runRumorEvolveNow(opts || {}),
            rumorEvolveAuto: (opts) => runRumorEvolve(opts || {}),
            rumorDecay: (opts) => runRumorDecay(opts || {}),
            clearRumors: () => clearRumors(),
            rumorTick: () => rumorTickState(),
            rumorEnabled: () => rumorEnabledOn(),
            rumorEveryRounds: () => rumorEveryRounds(),
            rumorNeedRounds: () => rumorNeedRounds(),
            rumorRoll: (seed) => rumorRoll(seed),
            rumorDecayScore: (r) => rumorDecayScore(r),
            rumorExpired: (r) => rumorExpired(r),
            rumorInjLine: (r) => rumorInjLine(r),
            flattenRumor: (r) => flattenRumor(r),
            // v2.34.0 调试强化：异常日志查询与捕捉开关状态
            // v2.34.0：一键诊断快照（异常/日志/运行态）——便于用户直接把结果贴给维护者
            dbgDump: () => {
                try {
                    return {
                        version: VERSION,
                        ready: !!runtime.ready,
                        debug: runtime.debug || null,
                        errCapture: errorCaptureState(),
                        errors: debugLogErrorCount(),
                        lastErrors: debugLogErrors(3),
                        stats: debugLogStats(),
                        recent: debugLogList().slice(0, 10),
                        probe: (runtime.probe && runtime.probe.missing) ? { missing: runtime.probe.missing } : null,
                        lastError: runtime.lastError || '',
                    };
                } catch (e) { return { version: VERSION, error: String((e && e.message) || e) }; }
            },
            dbgErrors: (limit) => debugLogErrors(limit),
            dbgErrorCount: () => debugLogErrorCount(),
            dbgLastError: () => debugLogLastError(),
            errCaptureState: () => errorCaptureState(),
            worldbookEntries: (env) => buildWorldbookEntries(env),
            worldbookKeys: (n) => buildWorldbookKeys(n),
            worldbookIsFttEntry: (e) => worldbookIsFttEntry(e),
            worldbookLegacyEntryName: () => worldbookLegacyEntryName(),
            worldbookTotalBytes: (e) => worldbookTotalBytes(e),
            worldbookMemoryTotal: () => worldbookMemoryTotal(),
            worldbookSync: () => scheduleWorldbookSync(),
            worldbookSyncNow: () => worldbookSyncNow(),
            worldbookSyncState: () => worldbookSyncState(),
            worldbookNames: () => worldbookNames(),
            refreshWorldbookNames: () => refreshWorldbookNames(),
            // B8-6b+ 关联层机械维护（零 AI；修复第 1 段收尾 + AI 修订后复检）
            relMaint: (opts) => relRepairMaint(opts || {}),
            relMaintCounts: (m) => relMaintCounts(m),
            relMaintTouched: (m) => relMaintTouched(m),
            relMaintSummary: (m) => relMaintSummary(m),
            mergeRelMaint: (a, b) => mergeRelMaint(a, b),
            demoteRelLinkOrphans: () => demoteRelLinkOrphans(),
            // B8-6c-1 相关组聚类修复基础设施 + 记忆修复管道
            groupSpecs: () => GROUP_REPAIR_SPECS,
            groupSpec: (dimKey) => groupRepairSpec(dimKey),
            groupRelatedness: (spec) => groupRelatedness(spec),
            groupClusters: (spec) => groupClusters(spec),
            groupPick: (spec) => groupPick(spec),
            memoryMergeExact: () => memoryMergeExact(),
            memoryRepairPrompt: (pick) => buildMemoryRepairPrompt(pick),
            memoryRepairApply: (delta, pick) => applyMemoryMergeGroups(delta, pick),
            memoryRepair: (opts) => runMemoryRepair(opts || {}),
            retargetRelRefs: (dim, fromIds, toId) => retargetRelRefs(dim, fromIds, toId),
            // B8-6c-2 概念修复（V1 v1.139 聚类核对管道）+ 场景修复（V1 v1.89 全量重建管道）
            conceptMergeExact: () => conceptMergeExact(),
            conceptRelatedness: () => conceptRelatedness(),
            conceptClusters: () => conceptClusters(),
            conceptPickClusters: () => conceptPickClusters(),
            conceptRepairPrompt: (pick) => buildConceptRepairPrompt(pick),
            conceptRepairApply: (delta, pick) => applyConceptMergeGroups(delta, pick),
            conceptRepair: (opts) => runConceptRepair(opts || {}),
            sceneRepairPrompt: () => buildSceneRepairPrompt(),
            sceneRepairApply: (entries) => applySceneRebuild(entries),
            sceneRepair: (opts) => runSceneRepair(opts || {}),
            // B8-6c-3 物品修复（V1 v1.142 标签/名称聚类 + 低调用固定规则清理管道）
            isCurrencyItemName: (name, desc) => isCurrencyItemName(name, desc),
            itemMergeExact: () => itemMergeExact(),
            itemLowUsesPurge: () => itemLowUsesPurge(),
            itemRepairPrompt: (pick) => buildItemRepairPrompt(pick),
            itemRepairApply: (delta, pick) => applyItemMergeGroups(delta, pick),
            itemRepair: (opts) => runItemRepair(opts || {}),
            // B8-6c-3 角色档案修复（V1 v1.139 提取策略 + v1.152 出生必给 + v1.176 机械处理 + v1.205 已去世跳过）
            snapRepairFields: () => SNAP_REPAIR_FIELDS,
            snapRepairFieldMap: () => SNAP_REPAIR_FIELD_MAP,
            snapshotAtomSize: (s) => snapshotAtomSize(s),
            characterRepairQueue: () => buildCharacterRepairQueue(),
            setSnapshotByPath: (s, path, val, o) => setSnapshotByPath(s, path, val, o),
            characterRepairPrompt: (targets, o) => buildCharacterRepairPrompt(targets, o),
            characterRepairApply: (delta, targets) => applyCharacterRepairResult(delta, targets),
            characterRepair: (opts) => runCharacterRepair(opts || {}),
            characterEvidencePack: (name, o) => characterEvidencePack(name, o),
            ensureSnapshotTags: (s) => ensureSnapshotTags(s),
            deriveSnapshotTags: (s, o) => deriveSnapshotTags(s, o),
            characterMechanicalPass: (o) => runCharacterMechanicalPass(o),
            correctSnapshotBirthDates: (o) => correctSnapshotBirthDates(o),
            // B8-6c-4 状态记录修复（V1 v1.158 匹配角色 → 机械清理/规范化 → AI 整理；v1.205 已去世固定规则）
            stateRepairFields: () => STATE_REPAIR_FIELDS,
            stateCanonField: (f) => stateCanonField(f),
            stateRepairRoster: () => stateRepairRoster(),
            stateSubjectMatch: (s, roster, sim) => stateSubjectMatch(s, roster, sim),
            stateRepairMatch: (o) => stateRepairMatch(o || {}),
            stateRepairClean: () => stateRepairClean(),
            removeStatesOfDeceased: (o) => removeStatesOfDeceased(o || {}),
            stateRepairTargets: (n) => pickStateRepairTargets(n),
            stateRepairPrompt: (pick) => buildStateRepairPrompt(pick),
            stateRepairApply: (delta, pick) => applyStateRepair(delta, pick),
            stateRepair: (opts) => runStateRepair(opts || {}),
            // B8-6c-4 计划/悬念修复（V1 v1.140 悬念聚类核对 + v1.113 计划冗余合并）
            suspenseMergeExact: () => suspenseMergeExact(),
            planSuspRepairPrompt: (pick) => buildPlanSuspRepairPrompt(pick),
            planSuspMergeApply: (delta) => applyPlanSuspMerge(delta),
            suspenseRepairApply: (delta, pick) => applySuspenseMergeGroups(delta, pick),
            planSuspRepair: (opts) => runPlanSuspRepair(opts || {}),
            // B8-7-a 情节总结（V1 v1.206 半自动早期情节聚合 + v1.203 手动多选合并）
            atomBodyChars: () => atomBodyChars(),
            atomDateGrainKey: (d, g) => atomDateGrainKey(d, g),
            grainStartDateStr: (k) => grainStartDateStr(k),
            atomCompactPlan: () => atomCompactPlan(),
            atomGroupPlan: (grain) => atomGroupPlan(grain),
            buildAtomCompactPrompt: (chunk) => buildAtomCompactPrompt(chunk),
            compactGrainLabel: (grain, key) => compactGrainLabel(grain, key),
            applyCompactGroup: (g, out, grain) => applyCompactGroup(g, out, grain),
            scheduleAtomCompact: () => scheduleAtomCompact(),
            runAtomCompact: (opts) => runAtomCompact(opts || {}),
            atomMergeRange: (items) => atomMergeRange(items),
            buildAtomMergePrompt: (items) => buildAtomMergePrompt(items),
            parseAtomMergeResult: (resp) => parseAtomMergeResult(resp),
            atomMergeSummary: (ids, ai) => atomMergeSummary(ids, ai),
            runAtomMergeSummary: (ids, opts) => runAtomMergeSummary(ids, opts || {}),
            // B8-7-a 情节分段总结（V1 v1.182 打包 → 分段 → `### 时间范围` 归档；只增不减、不注入）
            plotSegmentId: (e) => plotSegmentId(e),
            plotSegmentRange: (text) => plotSegmentRange(text),
            normalizePlotSegment: (e) => normalizePlotSegment(e),
            normalizePlotSegmentLine: (raw) => normalizePlotSegmentLine(raw),
            normalizePlotSegmentLines: (raw, limit) => normalizePlotSegmentLines(raw, limit),
            parsePlotSegmentText: (text) => parsePlotSegmentText(text),
            plotSegmentsToText: (list) => plotSegmentsToText(list),
            plotSegmentTimeKey: (s) => plotSegmentTimeKey(s),
            plotSegmentTimeDesc: (a, b) => plotSegmentTimeDesc(a, b),
            plotSegmentTimeAsc: (a, b) => plotSegmentTimeAsc(a, b),
            sortPlotSegments: (list, mode) => sortPlotSegments(list, mode),
            plotSegmentBatchSize: () => plotSegmentBatchSize(),
            plotSegmentAtomList: () => plotSegmentAtomList(),
            plotSegmentCoveredIds: () => Array.from(plotSegmentCoveredIds()),
            plotSegmentBatchesFrom: (list, size) => plotSegmentBatchesFrom(list, size),
            plotSegmentPlan: () => plotSegmentPlan(),
            plotSegmentPlanForIds: (ids) => plotSegmentPlanForIds(ids),
            buildPlotSegmentPrompt: (batch) => buildPlotSegmentPrompt(batch),
            plotSegmentSameRange: (a, b) => plotSegmentSameRange(a, b),
            applyPlotSegmentResult: (batch, segments) => applyPlotSegmentResult(batch, segments),
            runPlotSegmentSummary: (opts) => runPlotSegmentSummary(opts || {}),
            runPlotSegmentSummarySelected: (ids, opts) => runPlotSegmentSummarySelected(ids, opts || {}),
            clearPlotSegments: () => clearPlotSegments(),
            deletePlotSegment: (id) => deletePlotSegment(id),
            flattenPlotSegment: (item) => flattenPlotSegment(item),
            atomSubState: () => atomSubState(),
            setAtomSub: (v) => setAtomSub(v),
            // B8-7-b 平行世界推演 / 推进 / 转正 / 清理（V1 同名能力）
            weaveEnabled: () => weaveEnabled(),
            weavePassiveDue: (endF) => weavePassiveDue(endF),
            weaveInputSig: (start, end, floorsText) => weaveInputSig(start, end, floorsText),
            matchParallelsByKeywords: (keywords) => matchParallelsByKeywords(keywords),
            scheduleParallelWeave: (fr, keywords) => scheduleParallelWeave(fr, keywords),
            runParallelWeave: (fr, opts) => runParallelWeave(fr, opts || {}),
            advanceContextSeed: (p) => advanceContextSeed(p),
            buildAdvanceContext: (targets) => buildAdvanceContext(targets),
            buildAdvancePrompt: (targets, memText) => buildAdvancePrompt(targets, memText),
            applyAdvanceUpdate: (p, u) => applyAdvanceUpdate(p, u),
            runParallelAdvance: (opts) => runParallelAdvance(opts || {}),
            promoteParallelEvent: (id, opts) => promoteParallelEvent(id, opts || {}),
            prunePromotedParallels: () => prunePromotedParallels(),
            setParallelLastKeywords: (list) => setParallelLastKeywords(list),
            parallelLastKeywords: () => parallelLastKeywords(),
            // P9d：被动调度与独立分组（V1 `jsExtractKeywords` / `runSummarySeparate` 同名能力 + V2 分组构造诊断）
            jsExtractKeywords: (text) => jsExtractKeywords(text),
            runSummarySeparate: (text, fr, opts) => runSummarySeparate(text, fr, opts || {}),
            summaryDimGroups: (dims) => summaryDimGroups(dims),
            separateGroupingEnabled: () => separateGroupingEnabled(),
            scenesUnionMergeAll: () => scenesUnionMergeAll(),
            clockScene: () => latestSceneLocation(),
            storageBootstrap,
            // B9-a 调试页：日志读写/清空/统计（V1 同名 `dbgLog` / `dbgGet` / `dbgClear`；V2 另给 `debugLogStats`）
            dbgLog: (kind, data) => debugLogPush(kind, data),
            dbgGet: () => debugLogList(),
            dbgLogGet: () => debugLogList(),
            dbgClear: () => debugLogClear(),
            debugLogStats: () => debugLogStats(),
            // B9-a 关于页：版本清单读取 / 状态 / 渲染 / 清缓存 / 候选地址 / 排序 / 兜底（V1 同名能力）
            aboutLoad: (force) => aboutLoadJson(force === true),
            aboutEnsureLoaded: () => aboutEnsureLoaded(),
            aboutState: () => getAboutState(),
            aboutData: () => getAboutData(),
            aboutHtml: () => aboutHtml(),
            aboutClearCache: () => aboutClearCache(),
            aboutCandidateUrls: () => aboutCandidateUrls(),
            aboutSortDesc: (list) => aboutSortDesc(list),
            aboutFallback: () => aboutFallback(),
            aboutJsonPaths: () => ABOUT_JSON_PATHS.slice(),
            aboutInfo: () => aboutInfo(),
            aboutDirUrl: () => aboutDirUrl(),
            // B9-a 数据管理：清空当前角色记忆（V1 `resetState`；破坏性动作，面板侧带二次确认）
            resetState: () => resetState(),
            // B9-b 关系表定位跳转 +「👥 选角色」（V1 `__FTT` 同名能力；`relJump` / `relGoto` 在 V1 只存在于
            //   handleAction 的 case 内，V2 把状态迁移抽成可导出函数以便诊断与黄金样本比对）
            relPickState: () => relPickState(),
            setRelPick: (ref) => setRelPick(ref),
            relFilterState: () => relFilterState(),
            setRelFilter: (dim, who, jump) => setRelFilter(dim, who, jump),
            relClearFilter: () => relClearFilter(),
            relPickQuery: () => relPickQueryOf(),
            setRelPickQuery: (q) => setRelPickQuery(q),
            relKnownNames: () => relKnownNames(),
            relPickAppendRow: (dim, refId, name, opts) => relPickAppendRow(dim, refId, name, opts || {}),
            relPickPanelHtml: (dim, refId, editor) => relPickPanelHtml(dim, refId, editor === true || String(editor) === '1'),
            relEntryTitle: (dim, it) => relEntryTitle(dim, it),
            relFindEntryId: (dim, raw) => relFindEntryId(dim, raw),
            relIsRelDim: (kind) => relIsRelDim(kind),
            relDimLabelOf: (dim) => relDimLabelOf(dim),
            relJump: (dim, id) => relJump(dim, id),
            relGoto: (dim, id) => relGoto(dim, id),
            // B9-c 投喂标签自动分析（V1 `__FTT` 同名：latestAiFloorInfo / rxAnalyzeLatestText / rxNormTag /
            //   rxDedupeTagList / rxPushFeedTag / rxTagScanHtml；`rxPushFeedTag` 为 V1 同款的收录写入口）
            latestAiFloorInfo: () => latestAiFloorInfo(),
            rxAnalyzeLatestText: () => rxAnalyzeLatestText(),
            rxNormTag: (raw) => rxNormTag(raw),
            rxDedupeTagList: (list) => rxDedupeTagList(list),
            rxPushFeedTag: (kind, raw) => rxPushFeedTag(kind, raw),
            rxTagScanHtml: () => rxTagScanHtml(),
            rxTagScan: () => rxTagScanState(),
            setRxTagScan: (v) => setRxTagScan(v),
            rxFeedTagLists: () => rxFeedTagLists(),
            feedScanAction: (a, p) => feedScanAction(a, p || {}),
            // B9-c 货币追踪（V1 `__FTT` 同名：normalizeTrackedRoles / trackedCurrencyRoles / isTrackedCurrencyOwner /
            //   knownCharacterNames / trackPickState / setTrackPick；V1 亦导出 add/remove/clear 三个写入口）
            normalizeTrackedRoles: (v) => normalizeTrackedRoles(v),
            trackedCurrencyRoles: () => trackedCurrencyRoles(),
            isTrackedCurrencyOwner: (owner) => isTrackedCurrencyOwner(owner),
            knownCharacterNames: () => knownCharacterNames(),
            addTrackedCurrencyRole: (name) => addTrackedCurrencyRole(name),
            removeTrackedCurrencyRole: (name) => removeTrackedCurrencyRole(name),
            clearTrackedCurrencyRoles: () => clearTrackedCurrencyRoles(),
            trackPickState: () => trackPickState(),
            setTrackPick: (v) => setTrackPick(v),
            defaultCurrencyOwner: () => defaultCurrencyOwner(),
            scheduleStorageSync, extract: runExtract, pendingFloors, extractStatus: extractSummary, i18n: i18nStats, t, folderInfo, forceMountPanel, panelInfo: panelMountInfo, menuInfo, floatingInfo, openPanelPopup, ensureVisibleEntry, popupInfo, popupAction, v1PanelInfo: panelInfo, v1PanelTabs: panelTabs, injectNow, summary: runSummaryBatch, abort: abortExtraction, clearFloors: clearProcessedFloors, exportState: exportStateJson, importState: importStateJson }));
    } catch (e) { /* 忽略 */ }
    return { slash: runtime.slash, macros: runtime.macros };
}

/** 初始化（幂等 + 去重；被事件/轮询/命令三处触发都只跑一次） */
let initPromise = null;
export function ensureReady(reason) {
    noteTrigger(String(reason || 'manual'));
    if (runtime.ready) return Promise.resolve({ ok: true, reused: true });
    if (initPromise) return initPromise;
    initPromise = Promise.resolve()
        .then(() => init())
        .catch((e) => { runtime.bootstrap.lastError = String((e && e.message) || e); return { ok: false, error: runtime.bootstrap.lastError }; })
        .finally(() => { initPromise = null; });
    return initPromise;
}

function noteTrigger(why) {
    try {
        if (runtime.bootstrap.triggers.indexOf(why) < 0 && runtime.bootstrap.triggers.length < 24) runtime.bootstrap.triggers.push(why);
    } catch (e) { /* 忽略 */ }
}

/**
 * 可见性探针：**不等单一事件**（不同宿主/原生移植的 APP_READY 时机与是否补发并不一致）。
 *   立即尝试一次，然后最多 `POLL_MAX` 次、每 `POLL_MS` 毫秒重试，直到「已初始化且面板已挂载」。
 *   已初始化但面板容器当时不存在（例如设置抽屉尚未建好）时，只重试挂载，不重复整套初始化。
 */
const POLL_MAX = 20;
const POLL_MS = 750;
/** 连续多少次挂载失败后启用悬浮兜底入口（约 3 秒） */
const FLOAT_AFTER_TRIES = 4;
let pollTimer = null;

/** cfg.uiShowDrawer：是否在扩展设置抽屉里也渲染面板卡片（默认否 = 只用弹窗） */
function cfgShowDrawer() { try { return cfgRef.uiShowDrawer === true; } catch (e) { return false; } }
/** 是否已经有**可见入口**（弹窗主入口=菜单；或抽屉面板；或悬浮按钮） */
function visibleEntryReady() {
    try { return panelMountInfo().ok || menuInfo().installed || floatingInfo().installed; } catch (e) { return false; }
}

async function probeTick(why) {
    noteTrigger(why);
    try {
        if (!hasHost()) return false;
        if (!runtime.ready) await ensureReady(why);
        if (runtime.ready && cfgShowDrawer() && !panelMountInfo().ok) {
            try { await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot() }); } catch (e) { /* 下一轮再试 */ }
        }
        if (runtime.ready && visibleEntryReady()) {
            if (panelMountInfo().ok) uninstallFloatingEntry();
            stopReadyProbe();
            return true;
        }
        // 连续若干次仍没有可见入口 → 启用悬浮兜底并停止轮询（不无限重试）
        if (runtime.ready && runtime.bootstrap.pollTries >= FLOAT_AFTER_TRIES) {
            if (cfgRef.uiShowFloating !== false) {
                const f = installFloatingEntry({ onClick: () => openPanelPopup() });
                runtime.bootstrap.floating = f;
            }
            stopReadyProbe();
        }
    } catch (e) { runtime.bootstrap.lastError = String((e && e.message) || e); }
    return false;
}

export function stopReadyProbe() {
    if (pollTimer) { try { clearTimeout(pollTimer); } catch (e) { /* 忽略 */ } }
    pollTimer = null;
    return true;
}

function startReadyProbe() {
    runtime.bootstrap.startedAt = Date.now();
    void probeTick('load');
    const loop = () => {
        if (runtime.bootstrap.pollTries >= POLL_MAX) { pollTimer = null; return; }
        runtime.bootstrap.pollTries += 1;
        void probeTick('poll' + runtime.bootstrap.pollTries).then((done) => {
            if (done || runtime.bootstrap.pollTries >= POLL_MAX) { pollTimer = null; return; }
            pollTimer = setTimeout(loop, POLL_MS);
        });
    };
    if (pollTimer) return true;
    pollTimer = setTimeout(loop, POLL_MS);
    return true;
}

/** 设置面板/数据台需要的动作钩子（集中一处，供 init 与可见性探针复用） */
function panelHooks() {
    return { extract: runExtract, pending: pendingFloors, importV1: runV1Import, clearInject, panelInfo: panelMountInfo };
}

/**
 * 以**弹窗**打开面板（当扩展设置抽屉容器缺失时的兜底展示）。
 * 优先 `callGenericPopup(html, POPUP_TYPE.TEXT)`；不可用时退回「再试挂载 + 提示」。
 * @returns {Promise<{ok:boolean, via:string, reason?:string}>}
 */
export async function openPanelPopup(tab) {
    // V1 同构主界面：**浮层 #ftt-panel**（13 分页 + V1 原样式）
    try {
        setPopupHooks(popupHooks());
        setPanelHooks2(Object.assign({}, popupHooks(), { inject: injectNow }));
        const r = openPanel(tab);
        if (r.ok) return r;
    } catch (e) { /* 落到抽屉/挂载 */ }
    const m = await forceMountPanel();
    return { ok: !!m.ok, via: 'mount', reason: m.reason };
}

/** 「📤 立即注入」：按当前配置立刻注入一次（返回字数） */
export async function injectNow() { return pushMemoryInject({ queryText: '' }); }

/** 弹窗动作钩子（提取 / 更新 / 清空注入 / 清单 / 状态） */
function popupHooks() {
    return {
        extract: runExtract,
        pending: pendingFloors,
        extractStatus: extractSummary,
        clearInject,
        checkUpdate: checkUpdateNow,
    };
}

/**
 * 确保有一个可见入口：面板挂上 → 移除悬浮按钮；挂不上 → 安装悬浮按钮（点击弹窗打开面板）。
 * @returns {Promise<{panel:object, floating:object}>}
 */
export async function ensureVisibleEntry() {
    let panel = { ok: false, reason: '' };
    try { panel = await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot() }); } catch (e) { panel = { ok: false, reason: String((e && e.message) || e) }; }
    let floating = { ok: false, reason: '' };
    if (panel.ok) {
        try { uninstallFloatingEntry(); } catch (e) { /* 忽略 */ }
        floating = { ok: false, reason: '面板已挂载（无需悬浮入口）' };
    } else {
        try { floating = installFloatingEntry({ onClick: openPanelPopup }); } catch (e) { floating = { ok: false, reason: String((e && e.message) || e) }; }
    }
    return { panel, floating };
}

/**
 * 强制挂载设置面板并确保菜单入口存在（供 `/ftt-panel`、魔杖菜单与可见性探针使用）。
 * @returns {Promise<object>} { ok, via, container, reason, menu }
 */
export async function forceMountPanel() {
    let mount = { ok: false, via: 'none', reason: '' };
    try { mount = await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot(), force: true }); }
    catch (e) { mount = { ok: false, via: 'error', reason: String((e && e.message) || e) }; }
    let menu = { ok: false, reason: '' };
    try { menu = installMenuEntry({ onClick: forceMountPanel }); } catch (e) { menu = { ok: false, reason: String((e && e.message) || e) }; }
    // 挂不上抽屉 → 至少给一个悬浮入口（点击以弹窗展示面板）
    let floating = { ok: false, reason: '' };
    try {
        if (mount.ok) floating = { ok: false, reason: '面板已挂载' };
        else floating = installFloatingEntry({ onClick: openPanelPopup });
    } catch (e) { floating = { ok: false, reason: String((e && e.message) || e) }; }
    runtime.bootstrap.lastError = mount.ok ? '' : String(mount.reason || '');
    return Object.assign({}, mount, { menu, floating, info: panelMountInfo(), menuInfo: menuInfo(), floatingInfo: floatingInfo() });
}

/**
 * 自动提取（P4）：`GENERATION_ENDED` 后分析最后一个未分析楼层。
 * 受 `cfg.autoExtract`（设置面板「自动提取」）与忙碌状态保护；任何失败只记录统计。
 */
export async function runAutoExtract(opts) {
    const r = await autoExtractLatest(opts || {});
    runtime.extract = extractStats();
    return r;
}

/** 手动提取（命令 / 调试入口）：`{ floor }` 指定楼层，缺省分析未分析清单（可带 limit） */
export async function runExtract(opts) {
    const o = opts || {};
    const r = (Number.isFinite(Number(o.floor)) && Number(o.floor) >= 0)
        ? Object.assign({ floor: Number(o.floor) }, await analyzeFloor(Number(o.floor), o))
        : await analyzeFloors(o);
    runtime.extract = extractStats();
    return r;
}

/** 面板/菜单/弹窗诊断（对外再导出，便于控制台与测试直接调用） */
export { panelMountInfo } from './ui/settings-panel.js';
export { menuInfo, installMenuEntry } from './ui/menu.js';
export { popupInfo, popupAction, popupTabs, popupHtml, openPopup } from './ui/popup.js';
export { panelInfo, panelTabs, panelHtml, panelAction, closePanel } from './ui/panel.js';

/** 批量分段摘要（V1「⚡ 立即 AI 摘要」）：silent=true 覆盖全部未摘要 AI 楼 */
export async function runSummaryBatch(opts) {
    const r = await runAutoSummary(opts || {});
    runtime.extract = extractStats();
    return r;
}

/** 中断当前批量分析（V1「✖ 中断」；协作式：段与段之间生效） */
export function abortExtraction() { return abortExtract(); }

/** 清除已处理楼层台账（V1「清除已处理记录」；不删除任何记忆条目） */
export function clearProcessedFloors() { return clearFloors(); }

/** 待分析楼层清单（命令与调试） */
export function pendingFloors(opts) { return listUnprocessedFloors(opts || {}); }

/** 导入状态（/ftt 与 FTT.importStatus()） */
export function importStatus() { return runtime.import; }

/**
 * 宿主桥接（P3 次批）：把内核需要的宿主能力按**注入视图**接上 ——
 *   ① 身份：当前角色名（V1 里是 TH 的 getCurrentCharacterName，用于货币默认归属等）；
 *   ② 通知：ST 的 toastr（内核只经 `notifyHooks.toast` 发出，缺失即静默）。
 */
function installHostBridges() {
    const ctx = getCtx();
    setIdentityView({ characterName: String((ctx && (ctx.name2 || ctx.name1)) || '') });
    // B8-2：剧情时钟取文钩子（内核不读宿主聊天）—— 最新 AI 正文 + 最近楼层窗口回退文本
    setClockTextHooks({
        latestAiText: () => { try { return latestAiMessageText(); } catch (e) { return ''; } },
        floorWindowText: () => {
            try {
                const last = Number((getCtx() && typeof getCtx().getLastMessageId === 'function') ? getCtx().getLastMessageId() : -1);
                if (!Number.isFinite(last) || last < 0) return '';
                const n = Math.max(1, Number(cfgRef.feedFloors) || 2);
                return collectFloorLinesInRange(Math.max(0, last - n + 1), last).join('\n');
            } catch (e) { return ''; }
        },
    });
    // B8-6：修复域钩子（楼层面板哈希走 host/floors；内核不直读宿主聊天）
    setRepairHooks({ floorHash: (i) => { try { return hashFloorText(i); } catch (e) { return ''; } } });
    // B8-7-b：平行事件取文钩子（V1 `collectFloorLinesInRange(start, end, {})`；内核不直读宿主聊天）
    setParallelTextHooks({
        floorLinesInRange: (start, end) => { try { return collectFloorLinesInRange(Number(start) || 0, Number(end) || 0); } catch (e) { return []; } },
    });
    // B8-3：时钟域 AI 管线钩子（AI 调用走 ST generateRaw；投喂文本走 host/floors；长任务在途即拒绝）
    setClockAiHooks({
        callAi: async (messages) => {
            try {
                const r = await rawGenerate(promptToGenerateArgs(messages));
                return r && r.ok ? { ok: true, text: String(r.text || '') } : { ok: false, error: String((r && r.error) || 'no-generate') };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        },
        feedText: (maxFloors) => { try { return buildFeedFloorText(maxFloors); } catch (e) { return ''; } },
        busy: () => { try { return !!extractBusy(); } catch (e) { return false; } },
    });
    // 内核延迟调度钩子 → 宿主定时器（快照增量 400ms 防抖依赖它；未接线时内核默认 no-op = 永不建增量快照）
    setTimerHooks({
        set: (fn, ms) => setTimeout(fn, Math.max(0, Number(ms) || 0)),
        clear: (id) => { try { clearTimeout(id); } catch (e) { /* 忽略 */ } },
    });
    setNotifyHooks({
        toast: (text, kind) => {
            try {
                const t = globalThis.toastr;
                if (!t) return;
                const fn = kind === 'error' ? t.error : (kind === 'warning' ? t.warning : t.info);
                if (typeof fn === 'function') fn.call(t, String(text == null ? '' : text));
            } catch (e) { /* 静默 */ }
        },
    });
    return { identity: true, notify: true };
}

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
    try { unmountPanel(); } catch (e) { /* noop */ }
    try { uninstallGlobalInterceptor(); } catch (e) { /* noop */ }
    try { stopReadyProbe(); } catch (e) { /* noop */ }
    try { uninstallMenuEntry(); } catch (e) { /* noop */ }
    try { uninstallFloatingEntry(); } catch (e) { /* noop */ }
    try { closePanel(); } catch (e) { /* noop */ }
    try { uninstallErrorCapture(); } catch (e) { /* noop */ }
    try { uninstallDevtools(); } catch (e) { /* noop */ }
    try { resetSyncState(); } catch (e) { /* noop */ }
    try { cancelForgetTimers(); } catch (e) { /* noop */ }
    try { cancelRepairTimers(); } catch (e) { /* noop */ }
    runtime.ready = false;
    return true;
}

// ---------------- 生命周期钩子（manifest.hooks 指向这些具名导出） ----------------

/** 页面加载期（阻塞加载器还在时）执行：同步装配，保持轻量 */
export function onActivate() {
    installGlobalInterceptor();
}

/**
 * 异步就绪入口（**多触发**）：APP_READY / APP_INITIALIZED / DOMContentLoaded / window.load / 轮询 / 命令，
 * 任一先到即开始初始化；`ensureReady` 去重保证只跑一次。
 */
function hookAppReady(why) {
    try {
        if (!hasHost()) return false;
        const snap = buildSnapshot();
        void snap;
        void ensureReady(why || 'APP_READY');
        return true;
    } catch (e) { return false; }
}

/** 文档就绪兜底（部分宿主不补发 APP_READY，或插件加载晚于就绪） */
function bindDocumentReady() {
    try {
        const doc = globalThis.document;
        const win = globalThis.window;
        if (doc && doc.readyState && doc.readyState !== 'loading') { void probeTick('dom-ready'); return true; }
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', () => { void probeTick('DOMContentLoaded'); });
        if (win && typeof win.addEventListener === 'function') win.addEventListener('load', () => { void probeTick('window.load'); });
        return true;
    } catch (e) { return false; }
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

// 1b) 诊断入口提前注册（不依赖任何事件）—— 装上了但界面没出现时仍可用 `/ftt`、`/ftt-panel`、`FTT.panelInfo()`
try { bootstrapDiagnostics(); } catch (e) { runtime.bootstrap.lastError = String((e && e.message) || e); }

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
        on(et.APP_READY || 'APP_READY', () => hookAppReady('APP_READY'));
        on(et.APP_INITIALIZED || 'APP_INITIALIZED', () => hookAppReady('APP_INITIALIZED'));
        return true;
    } catch (e) { return false; }
}
function unbindAppLifecycle() {
    while (appOffs.length) { try { appOffs.pop()(); } catch (e) { /* noop */ } }
}
bindAppLifecycle();

// 3) 可见性探针：多触发 + 有限轮询 —— 宿主事件缺失/时机不符时仍会装配并挂载面板
bindDocumentReady();
try { setPopupHooks(popupHooks()); installMenuEntry({ onClick: () => openPanelPopup() }); } catch (e) { /* 忽略 */ }
startReadyProbe();

// ---------------- 测试与自检用导出 ----------------
export const __internals = {
    VERSION, DATA_VERSION, MODULE_NAME,
    init, ensureReady, teardown, runtimeState, extraForStatus,
    forceMountPanel, panelMountInfo, menuInfo, floatingInfo, openPanelPopup, ensureVisibleEntry,
    popupInfo, popupAction, popupTabs, panelInfo, panelTabs, injectNow,
    runSummaryBatch, abortExtraction, clearProcessedFloors, exportStateJson, importStateJson,
    startReadyProbe, stopReadyProbe,
    eventTypeAvailability, interceptorStats, resetInterceptorStats, injectAvailable,
    startupUpdateCheck, checkUpdateNow,
};
