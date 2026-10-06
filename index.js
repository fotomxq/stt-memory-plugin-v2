// ============================================================
// FTT记忆组件 V2 · SillyTavern 原生扩展入口
// 分层：ui/ ─► host/ ─► adapters/ ─► core/（core 严禁反向依赖，见 scripts/check-core-purity.js）
// P0 范围：可安装骨架 + 能力探测 + 设置面板 + 事件绑定 + 生成前钩子（空实现） + 调试导出
// ============================================================
import { VERSION, DATA_VERSION, MODULE_NAME, DIMENSIONS, ATOM_DIM_KEYS } from './core/constants.js';   // v3.0.23：+ATOM_DIM_KEYS（载入记账的逐维条数）
import { hasHost, probeCapabilities, getCtx } from './host/st-api.js';
import { bindCoreEvents, eventTypeAvailability, installErrorCapture, uninstallErrorCapture, errorCaptureState } from './host/events.js';
import { installGlobalInterceptor, uninstallGlobalInterceptor, interceptorStats, resetInterceptorStats } from './host/interceptor.js';
import { clearInject, injectAvailable, pushMemoryInject, pushStats, setInjectRuntime, injectInFlight, readInject } from './host/inject.js';
import { getSettings, setSetting } from './adapters/settings.js';
// v2.90.0（用户要求）：管线状态的历史耗时（预估倒计时样本）落 ST 扩展设置 —— 不进数据模型 → DATA_VERSION 不变
import { setPipelineHooks } from './core/pipeline.js';
// v2.92.0（用户要求）：需人工确认项（跨端冲突/自检异常）—— 设定 + 总览同时展示，落 ST 扩展设置
import { setConflictHooks } from './core/conflicts.js';
import { setFloorShrinkHook } from './host/floors.js';
import { mergeDataObjects, mergeSnapshotStores } from './core/cross-sync.js';   // v3.0.21：载入并集（服务端文件为基底 + 本机缓冲补充）
import { noteConflict } from './core/conflicts.js';
// v2.94.0（`docs/D12` v0.2 §4 / §8-E，用户约定）：「设定 → 数据管理」删除到最近 6/10/12 层 ——
//   一律走**酒馆官方 API**（v3.17.0：一次性批量截断 = `chat` 数组 + `saveChat` + `clearChat`/`printMessages` + 一次事件；
//   逐层 `deleteMessage` 只在批量不可用且 ≤3 层时作最后手段），删前自动明文备份（3 槽轮转），删后精确校准楼层编号。
import { setFloorTrimHooks, floorTrimStatus, floorTrimPrecheck, floorTrimApply, floorRecalibrate, floorTrimBusy } from './host/floor-trim.js';
import { writeFloorBackup } from './adapters/floor-backup.js';
import { notifyHooks } from './core/model/runtime.js';
import { mountSettingsPanel, unmountSettingsPanel, panelMountInfo, setPanelStatus, refreshPanelStatus } from './ui/settings-panel.js';
import { installMenuEntry, ensureMenuEntry, uninstallMenuEntry, unbindMenuWatch, menuInfo } from './ui/menu.js';
import { installFloatingEntry, uninstallFloatingEntry, floatingInfo } from './ui/floating.js';
// v2.65.0（用户要求「显示界面开关与 V1 对齐 + 扩展菜单入口强制开启且不展示开关」）：入口按钮统一管理
import { syncEntryButtons, entryButtonsState, uninstallAllEntries, entryEnabled, ENTRY_LOCATIONS, ENTRY_LABELS, FORCED_ENTRIES } from './ui/entries.js';
import { openPopup, setPopupHooks, popupInfo, popupAction, popupTabs } from './ui/popup.js';
import { openPanel, closePanel, panelInfo, panelTabs, setPanelHooks2, unmountPanel, panelRenderStats, PANEL_RENDER_SLOW_MS, renderPanel, panelOpen } from './ui/panel.js';   // v3.1.0：+渲染观测   // v3.14.0：+renderPanel/panelOpen（载入完成后自动换掉拦截提示）
import { fallbackPanelHtml, panelData, setPanelHooks as setPanelHooksRef, bindPanelEvents } from './ui/settings-panel.js';
import { registerSlashCommand, registerMacros } from './ui/commands.js';
import { installDevtools, uninstallDevtools, buildSnapshot } from './devtools.js';
import { maybeAutoCheckOnStartup, updateStatusText } from './host/update.js';
// v2.46.0：启动自动检查的**内置延迟**（用户要求：「内置延迟几秒后执行，避免插件异常」）
import { startupDelayPlan, UPDATE_STARTUP_DELAY_MS } from './core/update.js';
import { setUpdateStatusLine } from './ui/settings-panel.js';
import { readUpdateState } from './adapters/update-state.js';
import { wireKernelChatHooks, attachKernelState, latestAiMessageText, noteChatKey } from './host/chat.js';
import { wirePersistHooks, loadFromLocalStorage, loadFromLocalFile, loadFromIndexedDB, loadFromServerFile, lastServerLoadInfo, storeStatus, scheduleSave, saveStateNow, primeStateIndex, resetState, flushStateNow, primeShrinkBaseline, localBufferState, LOCAL_BUFFER_MAX_CHARS, localKeyStats, localCopyStats, clearLocalCopy, removeLocalKeys } from './adapters/store.js';   // v3.1.0：+本机缓冲诊断；v3.3.0：+本机缓冲清点与清理   // v3.0.18：+flushStateNow（退出/切后台前落盘）；v3.0.23：+loadFromIndexedDB / lastServerLoadInfo（载入全层对齐）；v3.16.0：+loadFromLocalFile（本地文件模式）
// v3.16.0（用户要求「本地文件存储模式替代变量存储，避免超出限制」）：路径约定在设定-存储；留空 = 不开启
import { localFileEnabled } from './adapters/local-file.js';
// v3.0.23（用户报告「初次激活插件读取的数据还是没有对齐」）：把 chatMetadata（随聊天走的载体）接进载入路径
import { chatMetaLoadState } from './adapters/chat-meta.js';
// v3.0.23（用户要求「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志」）：读取台账
import { setReadLedgerHooks, readLedgerRecord, readLedgerStats, readLedgerList, readLedgerLines, readLedgerSummaryText, resetReadLedger, READ_LEDGER_CAP } from './core/read-ledger.js';
import { wireDebugLog, debugLogPush, debugLogList, debugLogClear, debugLogStats } from './adapters/debug-log.js';
import { wireTraceStore, traceStoreLoad, traceStoreSave, traceStoreClear } from './adapters/trace-store.js';
import { debugLogErrors, debugLogErrorCount, debugLogLastError } from './core/debug-log.js';
// v2.83.0（用户要求「开发之前设计的原子层之上的关联层」）：关联层派生视图 + 反向索引（只读）
import { relationSnapshot, relationStats, dependents, relationsOf, relationQueryRefs, relationLayerOn } from './core/relations.js';
// v2.41.0：调试包导出（面板「📦 导出调试包」与 FTT.debugLogExport 共用同一实现）
import { setDebugHooks as setDebugPageHooks, buildDebugExport, installDebugBridge } from './ui/debug.js';
// v3.24.0：统一用户通知出口（kind 归一 + 行为配色类 + 转义 + 去重 + 分级停留）
import { showToast } from './ui/notify.js';
// v2.42.0：交互/宿主/命令追踪（FTT 入口包装 + 诊断入口）
import { traceEvent, traceOpStart, traceOpEnd, traceSite, traceList, traceTimelineText, traceStats, traceContext, traceClear } from './core/trace.js';
// v2.35.0（B10-a API 页与按用途渠道）：内核 target 解析 + 宿主三通道适配
import { resolveApiTarget, purposeOfLabel, apiChannelSummary, apiPresetSave, apiPresetLoad, apiPresetDelete } from './core/api-channel.js';
// v2.37.0：时钟取值追踪（诊断入口）
import {
    clockTraceLast, clockTraceList, clockTraceInfo, clockTraceSummary, clockTraceClear,
    clockSrcLabel, clockSrcKeys,
} from './core/clock-trace.js';
import { probeTarget, fetchModels as probeModels, listConnectionProfiles, apiChannelAvailability, sendWithTarget } from './host/api-channel.js';
import {
    aboutLoadJson, aboutEnsureLoaded, getAboutData, getAboutState, aboutSortDesc, aboutHtml,
    aboutClearCache, aboutCandidateUrls, aboutFallback, ABOUT_JSON_PATHS, aboutInfo, aboutDirUrl,
} from './ui/about.js';
import { importV1Data, mergeV1IntoCurrent } from './adapters/import-v1.js';
import { autoExtractLatest, analyzeFloors, analyzeFloor, extractSummary, extractStats, summaryDimsForPrompt, runAutoSummary, abortExtract, batchProgress, clearFloors, extractBusy, runSummarySeparate, summaryDimGroups, separateGroupingEnabled, lastExtractRecord, lastPreflightInfo } from './host/extract.js';
import { calibrateBasics } from './host/preflight.js';
import { listUnprocessedFloors, scanPendingFloors, collectFloorLinesInRange, buildFeedFloorText, hashFloorText, fixFloorJump } from './host/floors.js';   // v3.5.0：+fixFloorJump（自动修复的楼层突变步骤）
import { loadKernelCfg, saveKernelCfg } from './adapters/config-store.js';
import { registerLocaleData, i18nStats, t } from './adapters/i18n.js';
import { folderInfo } from './host/paths.js';
import { state as kernelState } from './core/model/runtime.js';
import { migrateState, lastHealInfo } from './core/migrate.js';   // v3.13.1：+lastHealInfo（载入期自愈留痕）
import { emptyState } from './core/state.js';
import { setLastMessageId, setNotifyHooks, setIdentityView, setTimerHooks, timerHooks, getScopeKey, cfg as cfgRef, kernelStateSeq, setLoadPhase, loadGateInfo } from './core/model/runtime.js';
import { hashText, fileStamp } from './core/util.js';
import {
    clockManualState, setClockManual, clearClockManual,
    clockPatrolAnchorInfo, clockPatrolScan,
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
    cleanInvalidRelLinks, relInvalidStats, relInvalidSummary,
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
    characterAgeScan,   // v3.22.0：超长年龄 / 长生者只读干跑
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
    runParallelCustom,   // v2.99.0（用户要求）：自定义平行世界推演（输入一段话 → AI 单独推演）
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
import { setClockAiHooks, runClockRepair, clockRepairPack } from './core/clock-ai.js';
import {
    forgetState, forgetRunAll, runMemoryForget, sweepLowUseForget, lowUseSweepGate, cancelForgetTimers,
} from './core/forget.js';
import { runStateDecay, scenesUnionMergeAll } from './core/ingest.js';
import {
    runNsfwSoften, nsfwSoftenState, nsfwFixedReplace, nsfwScan, nsfwKeywordHits, nsfwApplyRules,
    nsfwKeywordList, nsfwRuleList, nsfwKeywordAdd, nsfwKeywordDelete, nsfwRuleAdd, nsfwRuleDelete,
    nsfwKeywordReset, nsfwRuleReset,
    // v3.8.0：NSFW 等级留档（无 / 弱 / 强 · 永久性留档）
    nsfwLevelOf, nsfwLabelStats, nsfwBackfill, nsfwClassifyItem,
} from './core/nsfw.js';
// v3.18.0（用户要求）：「设定 → NSFW弱化 → 🧠 词条分析」—— 抽取**强留档**原子数据交 AI 找涉敏词与替换词，
//   结果写入转化库（并同批补进识别词条库）；账本落 ST 扩展设置 `nsfwAnalyzeLog`（不进数据模型）。
import {
    runNsfwAnalyze, nsfwAnalyzeState, nsfwAnalyzePack, nsfwAnalyzeCandidates, nsfwAnalyzeSanitize,
    nsfwAnalyzeSeenReset, nsfwAnalyzeSeenCount, setNsfwAnalyzeHooks, NSFW_ANALYZE_MAX_ADD,
} from './core/nsfw-analyze.js';
import { promptToGenerateArgs } from './host/extract.js';
import { dataHealthReport, dataHealthText } from './core/data-health.js';   // v3.13.0：数据体检（只读）
// v2.58.0：提取记忆三层流程（向量 / JS / AI）与向量层宿主适配（对齐 V1 的 Embedding / Rerank API 设置）
import { runExtractFlow, testLayer } from './host/extract-flow.js';
import { vectorRecall, vectorLayerStatus } from './host/vector-recall.js';
import { requestEmbeddings, requestRerank, vectorLayerInfo, vectorTarget } from './host/embeddings.js';
import { vectorCacheClear, vectorCacheStats, vecCachePutMany, resetVectorCacheState, setVectorCacheCaps } from './adapters/vector-cache.js';   // v3.1.0：+resetVectorCacheState（teardown 清理）
import { extractKeywordsFromText, analyzeMemorySend, aiLayerInfo, setAiRecallHooks } from './host/ai-recall.js';
import { getStoryNow } from './core/model/runtime.js';
import { rawGenerate } from './host/generation.js';
import { clockUiInfo } from './ui/clock.js';
import {
    storageBootstrap, scheduleStorageSync, crossSyncManual, refreshFromServer, storageVerify,
    syncLogList, syncLogClear, syncLogServerMerge, syncLogServerStatus, syncLogPush, syncLocalSource,
    storageStatusInfo, resetSyncState, syncInfo, fileCacheDropAll,
    // B9-d：条目瘦身 / gzip / 跨端分歧处置（V1 `__FTT` 同名能力）
    slimFileEnvelope, slimGzipInfo, crossPendingGet, crossPendingSet, crossPendingClear, applyRemoteReplaceState,
    adoptRemoteEnvelope, crossComputeInfo, crossPendingView,
    runStorageSync, storageEnvValid,
    // v3.0.22（用户要求「总览新增保存按钮…全部对齐数据」）：快照文件 / 清单文件的即时推送
    snapshotFilePushNow, metaFilePushNow,
} from './adapters/sync.js';
import { saveSettings } from './adapters/settings.js';
import {
    slimEntryForStorage, hydrateSlimEntry, slimDataForStorage, hydrateStorageData,
    snapshotIndexFrom, slimSnapshotStoreForStorage, hydrateSnapshotStore,
} from './core/slim.js';
import { gzipToBase64, gunzipFromBytes, bytesToBase64, base64ToBytes, isGzipBytes } from './adapters/gzip.js';
// v2.77.0：文件通道后端路由 + 宿主原生存储（官方契约）诊断入口
import { fileTransportStatus, fileTransportListKeys, fileTransportKey, fileTransportDropCaches, resetFileTransportSession } from './adapters/file-transport.js';
import { ttChannelInfo, ttMissStats, ttStoreOverview, TT_NS, TT_LEGACY_NS, TT_TABLE } from './adapters/tt-store.js';

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
        bootstrap: Object.assign({}, runtime.bootstrap, {
            panel: panelMountInfo(), menu: menuInfo(), floating: floatingInfo(), popup: popupInfo(), ready: runtime.ready,
            // v2.65.0：四个「插件自建入口」的安装态（顶栏 / 页面底部 / 悬浮 / 扩展菜单）
            entries: (() => { try { return entryButtonsState(); } catch (e) { return null; } })(),
            // v2.46.0：启动自动检查的**排期**信息（延迟毫秒/原因/排期时刻），便于回答「为什么还没检查」
            updateSchedule: (runtime.update && (runtime.update.reason === 'delayed' || runtime.update.delayMs))
                ? { reason: runtime.update.reason || '', delayMs: Number(runtime.update.delayMs) || 0, delayReason: runtime.update.delayReason || '', scheduledAt: Number(runtime.update.scheduledAt) || 0 }
                : null,
        }),
        cfg: runtime.cfg,
        inject: pushStats(),
        update: (runtime.update && runtime.update.summary) || readUpdateState().lastResult || null,
    };
}

/**
 * 载入择优（v3.0.11，纯函数，便于单测）：在「本机缓冲」与「服务端文件」之间取较新的一份。
 * 规则：两者都有时按 `updatedAt` 取大；**相等（含都为 0）时以服务端文件为准**（权威大对象）；
 *   只有一个时用那个。返回选中的 state 与来源标签，供 `loadMemoryState` 接线与调试留痕。
 * @param {object|null} localSt 本机缓冲 state
 * @param {object|null} fileSt 服务端文件 state
 * @returns {{st:object|null, via:'local'|'file'|'new', atLocal:number, atFile:number, reason:string}}
 */
/**
 * v3.0.21：把「服务端文件」与「本机缓冲」**并集**成一份载入态（文件为基底）。
 *   同名条目按时间取新（`mergeDataObjects` 既有口径）、删除墓碑生效；快照链按并集重建；
 *   `updatedAt` 取两者较大的那个（后续保存继续推进）。
 * @param {object} fileSt 服务端文件状态（基底）
 * @param {object} localSt 本机缓冲状态（只作补充）
 */
export function mergeLoadedSources(fileSt, localSt) {
    try {
        const m = mergeDataObjects(fileSt, localSt, {
            hashFloor: (i) => { try { return hashFloorText(Number(i)); } catch (e) { return ''; } },
        });
        const out = (m && m.data) ? m.data : fileSt;
        try { out.snapStore = mergeSnapshotStores((fileSt && fileSt.snapStore) || [], (localSt && localSt.snapStore) || []); } catch (e) { /* 忽略 */ }
        out.updatedAt = Math.max(Number(fileSt && fileSt.updatedAt) || 0, Number(localSt && localSt.updatedAt) || 0);
        return out;
    } catch (e) { return fileSt; }
}

export function pickNewerState(localSt, fileSt) {
    const atOf = (s) => Number((s && s.updatedAt) || 0);
    const atLocal = atOf(localSt), atFile = atOf(fileSt);
    const hasL = !!(localSt && typeof localSt === 'object');
    const hasF = !!(fileSt && typeof fileSt === 'object');
    if (hasL && hasF) {
        if (atFile >= atLocal) return { st: fileSt, via: 'file', atLocal: atLocal, atFile: atFile, reason: atFile > atLocal ? 'file-newer' : 'tie-file' };
        return { st: localSt, via: 'local', atLocal: atLocal, atFile: atFile, reason: 'local-newer' };
    }
    if (hasL) return { st: localSt, via: 'local', atLocal: atLocal, atFile: atFile, reason: 'only-local' };
    if (hasF) return { st: fileSt, via: 'file', atLocal: atLocal, atFile: atFile, reason: 'only-file' };
    return { st: null, via: 'new', atLocal: atLocal, atFile: atFile, reason: 'none' };
}

/**
 * 载入记忆容器（P2）：聊天注入视图接线 → 持久化钩子接线 → 本机缓冲 → 服务端文件 → 迁移 → 注入内核。
 * 顺序与 V1 一致；任一步失败都降级（最差回落到空容器），绝不抛出。
 * @returns {Promise<{via:string, scope:string}>} via = local | file | new
 */
export async function loadMemoryState() {
    let via = 'new';
    let st = null;
    // v3.0.23：载入是异步的；期间若有人（导入 / 清空 / 跨端合并）注入了更新的状态，**本次不再覆盖**
    const gen0 = (() => { try { return kernelStateSeq(); } catch (e) { return -1; } })();
    try { runtime.chat = wireKernelChatHooks(); } catch (e) { /* 聊天视图缺失不阻塞 */ }
    try { wirePersistHooks(); } catch (e) { /* 忽略 */ }
    const scopeKey = (() => { try { return String(getScopeKey() || ''); } catch (e) { return ''; } })();
    // v3.0.23（用户报告「初次激活插件读取的数据还是没有对齐」）：作用域未就绪时读到的其实是 `default` 作用域
    //   （= 另一个角色的文件）—— 这本身就是「没对齐」。此时照常载入（不阻塞启动），但如实记账并回报
    //   `scopeEmpty: true`，由 `init()` 安排**一次**延迟重载（作用域就绪后自动纠正）。
    if (!scopeKey) {
        try {
            readLedgerRecord({ action: '作用域未就绪', src: 'memory', ok: true, miss: true, reason: 'scope-key-empty', note: '角色稳定键尚未就绪 → 本次按 default 作用域读取，稍后会自动重载一次' });
            debugLogPush('对账', { action: '载入：作用域未就绪（角色键为空）', note: '按 default 作用域读取，init 将延迟重载一次' });
        } catch (e) { /* 忽略 */ }
    }
    // v3.0.11（真机根因）：**两个源都读，按 `updatedAt` 择优**，不再「第一个有货就用」。
    // v3.0.21（用户要求「一劳永逸」）：载入口径 = **服务端文件为基底 + 本机缓冲只作并集补充**。
    // v3.0.23（用户报告「初次激活读取的数据还是没有对齐」）：把**每一层**都读进来 —— 服务端主文件 / 分片 /
    //   本机缓冲（localStorage）/ **本机内存库（IndexedDB）** / **聊天元数据（chatMetadata，随聊天走）**；
    //   基底取「服务端文件（含分片重建）」，其余各层只贡献**并集**（同名按时间取新、墓碑生效），
    //   且**绝不整体覆盖**基底 —— 于是「换设备 / 清缓存 / 恢复聊天备份 / 初次激活」都能自动对齐。
    const layers = { local: null, idb: null, file: null, chatmeta: null };
    try { layers.local = loadFromLocalStorage(); } catch (e) { layers.local = null; }
    // v3.16.0（用户要求「本地文件存储模式替代变量存储」）：**路径非空时**本机层以本地文件为真相
    //   （文件读是异步的 → 只在开启时多这一次 await；关闭时零额外微任务、零行为变化）
    try { if (localFileEnabled()) { const lf = await loadFromLocalFile(); if (lf) layers.local = lf; } } catch (e) { /* 文件层异常 → 保留变量层结果 */ }
    try { layers.idb = await loadFromIndexedDB(); } catch (e) { layers.idb = null; }
    try { layers.file = await loadFromServerFile(); } catch (e) { layers.file = null; }
    const cm = (() => { try { return chatMetaLoadState(); } catch (e) { return null; } })();
    layers.chatmeta = (cm && cm.state) || null;
    const pick = pickNewerState(layers.local, layers.file);            // 保留：作为**诊断**（谁的时间戳更新）
    const chosen = alignLoadedLayers(layers);
    st = chosen.st; via = chosen.via;
    // 逐层记账 + 差异报告（哪一层被采用为基底、哪几层并集进来、各贡献了多少条）
    try {
        debugLogPush('对账', {
            action: st ? ('载入：以' + chosen.baseLabel + '为基底 + ' + (chosen.unioned.length ? (chosen.unioned.join(' / ') + ' 并集并入') : '无并集')) : '载入（无任何数据源）',
            localAt: pick.atLocal, fileAt: pick.atFile, picked: via, newerSide: pick.via, reason: pick.reason,
            base: chosen.base, baseAt: chosen.baseAt, unioned: chosen.unioned, skipped: chosen.skipped,
            contributed: chosen.contributed, chatMetaAt: Number((cm && cm.at) || 0), chatMetaTotal: Number((cm && cm.total) || 0),
            serverVia: (() => { try { return lastServerLoadInfo().via; } catch (e) { return ''; } })(),
            scopeKey: scopeKey ? '(已就绪)' : '(空)',
        });
    } catch (e) { /* 忽略 */ }
    // v3.13.0：载入期数据异常自愈（脏台账 / 非规范 NSFW / 负数 uses / 倒置楼层区间 …）；
    //   v3.13.1：自愈摘要不再丢弃 —— 有修复就记一条调试日志（与 NSFW 补档同一口径）并在挂载后按需落盘，
    //   否则「修了什么」既看不到、也可能长期只活在内存里（磁盘仍是脏数据，每次载入重来）。
    let healInfo = null;
    if (st) {
        try { st = migrateState(st); healInfo = lastHealInfo(); } catch (e) { /* 迁移失败则按原样使用 */ }
    }
    if (!st || typeof st !== 'object') { st = emptyState(); via = 'new'; }
    // v3.0.21：登记「异常缩水」守卫的基线（载入态即基线；此后任何无墓碑的大规模缩水都会被拦下）
    try { primeShrinkBaseline(st); } catch (e) { /* 忽略 */ }
    const genNow = (() => { try { return kernelStateSeq(); } catch (e) { return gen0; } })();
    const superseded = genNow !== gen0;
    if (superseded) {
        // 读盘期间状态已被别的动作换成更新的一份（导入 / 清空 / 跨端合并）→ 保留那一份，不覆盖
        try {
            readLedgerRecord({ action: '载入被更新的内存态让位', src: 'memory', ok: true, miss: true, reason: 'state-superseded', extra: { gen0: gen0, genNow: genNow }, note: '读盘期间内存状态已被其它动作更新 → 本次载入不覆盖' });
            debugLogPush('对账', { action: '载入：内存状态已被其它动作更新 → 本次不覆盖（避免把新数据清回去）', gen0: gen0, genNow: genNow });
        } catch (e) { /* 忽略 */ }
        via = 'superseded';
    } else {
        try { attachKernelState(st); } catch (e) { runtime.lastError = String((e && e.message) || e); }
        // v3.13.1：自愈留痕 + 按需落盘（必须在挂载之后，避免把上一份内存态写回磁盘）
        if (healInfo && healInfo.changed) {
            try {
                debugLogPush('载入', {
                    action: '载入期数据自愈（脏台账 / 非规范 NSFW / 负数 uses / 倒置或非法楼层区间）',
                    ledgerFixed: healInfo.ledger, droppedFixed: healInfo.dropped, entriesFixed: healInfo.entries,
                    note: '自愈在载入期完成（幂等）；本条记录用于核对「这次载入修了什么」',
                });
            } catch (e) { /* 忽略 */ }
            try { scheduleSave('载入期数据自愈'); } catch (e) { /* 忽略 */ }
        }
    }
    // v3.8.0（用户要求）：**NSFW 等级留档补档** —— 老存档（v3.8.0 之前写入的）与派生条目（修复/推演/情节总结新建）
    //   在载入后补上等级标签（无/弱/强）；**只升不降、幂等**：文本没有命中时不写、已打标的不再改动。
    //   弱化路径只改文本、不动标签，因此补档不会把「强」降下来（见 `core/nsfw-level.js#nsfwStampLevel`）。
    if (!superseded) {
        try {
            const bf = nsfwBackfill();
            if (bf.stamped) {
                try { debugLogPush('弱化', { action: '载入补档：NSFW 等级留档（v3.8.0）', stamped: bf.stamped, weak: bf.weak, strong: bf.strong, byDim: bf.byDim, scanned: bf.scanned }); } catch (e2) { /* 忽略 */ }
            }
        } catch (e) { /* 补档失败不影响载入 */ }
    }
    // 内存层记账：注入后内存里到底是什么（条数 / 字段数 / 各维条数）——载入链路的最后一环
    try {
        const counts = dimCountsOf(st);
        readLedgerRecord({
            action: '注入内存态', src: 'memory', ok: true, items: counts.total, fields: Object.keys(st || {}).length,
            extra: { via: via, dims: counts.dims },
            note: '载入完成（来源 ' + via + '）：内存现有 ' + counts.total + ' 条原子数据',
        });
    } catch (e) { /* 忽略 */ }
    // B8-7-b：历史存档清理（V1 启动同款）——旧版「转正」只写 `promotedTo` 软标记，按 v1.196 规则移除该死条目
    //   （仅当被转正的情节仍存在；情节已删则保留原平行记录）。
    try { prunePromotedParallels(); } catch (e) { /* 软标记清理失败不影响载入 */ }
    try { setLastMessageId(runtime.chat.lastMessageId); } catch (e) { /* 忽略 */ }
    try { primeStateIndex(); } catch (e) { /* 索引基线失败不影响载入 */ }
    try { runtime.store = Object.assign({ via, layers: chosen.report }, storeStatus()); } catch (e) { runtime.store = { via }; }
    return { via, scope: runtime.store.scope || '', base: chosen.base, baseAt: chosen.baseAt, unioned: chosen.unioned, skipped: chosen.skipped, contributed: chosen.contributed, layers: chosen.report, scopeKey: scopeKey, scopeEmpty: !scopeKey, superseded: superseded };
}

/** 逐维条数（载入记账用；与 `store.js#countsOf` 同口径但不引入适配层依赖） */
function dimCountsOf(st) {
    const dims = {};
    let total = 0;
    try {
        for (const d of ATOM_DIM_KEYS) { const n = Array.isArray(st && st[d]) ? st[d].length : 0; dims[d] = n; total += n; }
        const c = Array.isArray(st && st.currencies) ? st.currencies.length : 0;
        dims.currencies = c; total += c;
    } catch (e) { /* 忽略 */ }
    return { total: total, dims: dims };
}

/**
 * v3.0.23：**载入分层对齐**（纯函数，便于单测）——「初次激活读取的数据还是没有对齐」的修复主体。
 *
 * 输入 = 各层读到的 state（已各自校验）：`{local, idb, file, chatmeta}`；输出 = 最终载入的 state + 取证报告。
 *
 * 口径（承接 v3.0.21「服务端文件为基底」）：
 *   ① **基底**：服务端文件（`file`，其内部可能已用分片重建）优先；没有才在（聊天元数据 / 内存库 / 本机缓冲）
 *      里取 `updatedAt` 最新的一层（**初次激活**就是这条路径：文件还没有，但聊天里 / 内存库里可能已经有）。
 *   ② **并集**：本机缓冲与内存库**始终**并集（它们由保存流水线同步写入，清空/导入也一样写 → 不会复活旧数据）；
 *      聊天元数据**只在比基底更新时**才并集（它不由 V2 写入，无条件并集会让「清空记忆」被旧副本复活）。
 *   ③ **绝不整体覆盖**：并集走 `mergeDataObjects`（同名按时间取新 + 墓碑生效 + 快照链并集 + 已处理楼层并集）。
 * @param {{local?:object|null, idb?:object|null, file?:object|null, chatmeta?:object|null}} layers
 * @returns {{st:object|null, via:string, base:string, baseAt:number, unioned:string[], skipped:Array<{src:string,reason:string}>,
 *            contributed:object, report:object, baseLabel:string}}
 */
export function alignLoadedLayers(layers) {
    const L = layers || {};
    const atOf = (s) => Number((s && s.updatedAt) || 0);
    const has = (s) => !!(s && typeof s === 'object');
    const skipped = [];
    let base = '', st = null, baseAt = 0;
    if (has(L.file)) { base = 'file'; st = L.file; baseAt = atOf(L.file); }
    else {
        // 初次激活（服务端还没有数据）：在本地三层里取最新的一份当基底（顺序即同分优先：本机缓冲 → 内存库 → 聊天元数据）
        const order = [['local', L.local], ['idb', L.idb], ['chatmeta', L.chatmeta]].filter((x) => has(x[1]));
        if (order.length) {
            let best = order[0];
            for (const x of order) if (atOf(x[1]) > atOf(best[1])) best = x;
            base = best[0]; st = best[1]; baseAt = atOf(best[1]);
        }
    }
    const contributed = {};
    const unioned = [];
    if (st) {
        const news = [];
        if (base !== 'local' && has(L.local)) news.push(['local', L.local]);
        if (base !== 'idb' && has(L.idb)) news.push(['idb', L.idb]);
        if (base !== 'chatmeta' && has(L.chatmeta)) {
            // 聊天元数据不由 V2 写入 → 只有**确实更新**时才并集（否则「清空记忆」会被它复活）
            if (atOf(L.chatmeta) > baseAt) news.push(['chatmeta', L.chatmeta]);
            else skipped.push({ src: 'chatmeta', reason: 'not-newer', at: atOf(L.chatmeta), baseAt: baseAt });
        }
        if (base !== 'file' && has(L.file)) news.push(['file', L.file]);
        for (const [name, src] of news) {
            const before = dimCountsOf(st).total;
            const merged = (() => { try { return mergeLoadedSources(st, src); } catch (e) { return st; } })();
            st = merged || st;
            const after = dimCountsOf(st).total;
            contributed[name] = after - before;
            unioned.push(name);
        }
    }
    for (const [name, src] of [['local', L.local], ['idb', L.idb], ['file', L.file], ['chatmeta', L.chatmeta]]) {
        if (!has(src) && name !== 'file') skipped.push({ src: name, reason: 'absent' });
    }
    const via = st ? (base || 'new') : 'new';
    const baseLabel = base === 'file' ? '服务端文件' : (base === 'local' ? '本机缓冲' : (base === 'idb' ? '本机内存库' : (base === 'chatmeta' ? '聊天元数据' : '（无）')));
    const report = {};
    for (const [name, src] of [['local', L.local], ['idb', L.idb], ['file', L.file], ['chatmeta', L.chatmeta]]) {
        report[name] = has(src) ? { at: atOf(src), total: dimCountsOf(src).total, used: (name === base) || (unioned.indexOf(name) >= 0), contributed: Number(contributed[name]) || 0 } : { at: 0, total: 0, used: false, contributed: 0 };
    }
    return { st: st, via: via, base: base, baseAt: baseAt, unioned: unioned, skipped: skipped, contributed: contributed, report: report, baseLabel: baseLabel };
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
    // v3.0.23（用户要求「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志」）：
    //   读取台账 → 调试日志（`kind='读取'`）+ 交互时间线（`kernel/read`）。台账本身是纯内核，
    //   出口（日志/时间线）由这里注入 —— 内核零宿主依赖。
    try {
        setReadLedgerHooks({
            // v3.10.4（真机 A5）：**哪些读取值得写进调试日志由内核裁决**（`core/read-ledger.js` 只镜像
            //   失败 / 未命中 / 慢读）—— 真机上常规成功读取曾占满 69% 的日志环（300 条里 208 条），
            //   把对账/摘要/修复/异常挤掉。读取台账本身另有独立缓冲（`ftt.reads` / 调试页可全量查看）。
            log: (rec) => {
                try { debugLogPush('读取', { action: rec.action, src: rec.srcLabel, target: rec.target, ok: rec.ok, miss: rec.miss, ms: rec.ms, bytes: rec.bytes, items: rec.items, fields: rec.fields, hash: rec.hash, reason: rec.reason, note: rec.note, extra: rec.extra }); } catch (e) { /* 忽略 */ }
                try {
                    if (rec.ok !== false || rec.ms >= 150) {
                        traceEvent({ cat: 'kernel', kind: 'read-' + rec.src, level: 'debug', detail: { action: rec.action, target: rec.target, ok: rec.ok, miss: rec.miss, ms: rec.ms, bytes: rec.bytes, items: rec.items, reason: rec.reason } });
                    }
                } catch (e) { /* 忽略 */ }
            },
        });
    } catch (e) { /* 忽略 */ }
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
    // 插件自建入口（V1 `syncButtons()` 同口径）：扩展菜单项**强制开启**；顶栏/底部/悬浮按设置；
    //   全部失败时由可见性探针启用悬浮兜底（`reason='fallback'`）
    try { syncEntriesNow(); } catch (e) { /* 入口安装失败不影响功能 */ }
    try { setPopupHooks(popupHooks()); } catch (e) { /* 忽略 */ }
    // v3.14.0（用户要求「刚加载插件后数据还未完整读取，应有读取拦截提示，避免报错，等加载完成后再展示内容」）：
    //   入口**先于**载入安装 —— 用户在首屏读取期间点开面板时，闸门让界面只显示「⏳ 正在读取数据…」
    //   且拒绝一切动作（`ui/panel.js#panelAction`），读完后再自动重绘成真实内容。
    try { setLoadPhase('loading', { note: '首屏载入：读取本机缓冲 / 服务端文件 / 聊天元数据' }); } catch (e) { /* 忽略 */ }
    try { setPanelStatus(panelStatusSnapshot()); refreshPanelStatus(); } catch (e) { /* 忽略 */ }
    try {
        const loaded = await loadMemoryState();
        // v3.0.23（用户报告「初次激活插件读取的数据还是没有对齐」）：角色稳定键未就绪时那次读取按 `default`
        //   作用域进行（等于读了别的角色的文件）→ **延迟重载一次**（作用域就绪后自动纠正，绝不重复叠加：
        //   重载会重新走「基底 + 并集」，且只在 `scopeEmpty` 时安排）。
        if (loaded && loaded.scopeEmpty) scheduleScopeReload();
        else runtime.scopeReload = { scheduled: false, delayMs: 0 };
        const g = loadGateInfo();
        // 注意：自愈摘要来自 `lastHealInfo()`（`loadMemoryState` 内部的作用域变量取不到）
        const hi = (() => { try { return lastHealInfo(); } catch (e2) { return null; } })();
        const healTxt = (hi && hi.changed) ? '（并自愈 ' + (hi.ledger + hi.dropped) + ' 条台账标记 / ' + hi.entries + ' 条条目）' : '';
        const finalCounts = (() => { try { return dimCountsOf(kernelState()).total; } catch (e2) { return 0; } })();
        setLoadPhase('ready', { via: (loaded && loaded.via) || '', items: finalCounts });
        try { debugLogPush('载入', { action: '首屏载入完成，解除读取拦截' + healTxt, via: (loaded && loaded.via) || '', items: finalCounts, waitedMs: g.waitedMs }); } catch (e2) { /* 忽略 */ }
    } catch (e) {
        runtime.lastError = String((e && e.message) || e);
        // 失败也**解除拦截**并如实标注：绝不把用户永久挡在门外（面板照常可用，调试页可见原因）
        setLoadPhase('failed', { error: runtime.lastError, note: '首屏载入失败：已放行界面，请到「设定 → 调试」查看原因' });
    }
    // 载入结束/失败后：把已经打开的界面（浮层面板 / 抽屉卡片）从「读取中」换成真实内容
    try { if (panelOpen()) renderPanel(); } catch (e) { /* 忽略 */ }
    try { setPanelStatus(panelStatusSnapshot()); refreshPanelStatus(); } catch (e) { /* 忽略 */ }
    // B7-2：启动对账（纯被动）—— 读服务端最新 → 原子合并 → 快照链并集 → 同步日志交叉合并；
    //   清单命中时零大文件下载；失败静默（绝不阻塞初始化与发送）。
    try { void storageBootstrap(); } catch (e) { /* 忽略 */ }
    // v2.51.0：载入后自动时间巡检已随「时间巡检修复」功能一并移除（时钟只取最新情节，无需巡检）
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
            // v3.17.0（删楼卡顿修复的配套）：删楼过程中我们自己会触发一次视图重载（`reloadCurrentChat`）→
            //   它发的 `CHAT_CHANGED` 会走到这里；此刻内存里的编号重映射还没落盘（写队列异步），
            //   **绝不能**重读落盘状态（否则等于无声撤销重映射）→ 删楼期间跳过重读，内存态才是权威。
            if (floorTrimBusy()) return;
            // 切换角色/聊天 → 作用域变化 → 重新载入该作用域容器
            void loadMemoryState().catch(() => { }).then(() => {
                // v3.20.0：载入后同步「当前聊天标识」；**真的换了一条聊天** → 立刻按本聊天的最新情节重解析时钟。
                //   为什么必须在载入之后：`chatKey` 与情节库一样是**按角色**存的 —— 刚载入时它还是上一条聊天的值，
                //   若在这里就判定「归属」，会把上一条聊天的时钟一直显示到本聊天有新楼层被分析为止。
                try {
                    const r = noteChatKey();
                    if (r && r.changed && clockAutoExtractOnce({ force: true }) === true) {
                        try { void saveStateNowQuiet('chat-key'); } catch (e) { /* 忽略 */ }
                    }
                } catch (e) { /* 忽略 */ }
            });
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
 *
 * v2.46.0（用户要求）：「启动时自动检查更新，**内置延迟几秒后执行**，避免插件异常」——
 *   自动路径统一**延迟 `UPDATE_STARTUP_DELAY_MS`（4 秒）**再发起请求：避开酒馆启动高峰与插件自身的启动对账，
 *   也让宿主 git 端点/网络异常不至于在首屏就弹后端错误；**手动检查（`manual: true`）不延迟**。
 *   延迟经内核 `timerHooks` 调度（与快照防抖、时钟调度同一套钩子），可被测试替换；`teardown()` 会撤销待执行的延迟。
 * @param {object} [opts] manual / now / delayMs（`delayMs: 0` = 立即，测试用）
 */
export async function startupUpdateCheck(opts) {
    const o = opts || {};
    const plan = startupDelayPlan(o);
    try {
        if (plan.delayMs > 0) {
            // 排期即留痕（诊断/状态可查：「已排期，N 秒后检查」而非「尚未检查」）
            runtime.update = { ran: false, reason: 'delayed', summary: null, delayMs: plan.delayMs, delayReason: plan.reason, scheduledAt: Date.now() };
            const ok = await waitStartupUpdateDelay(plan.delayMs, o);
            if (!ok) {
                // 被新一轮调度取代 / 插件已卸载 → 放弃本次（不写状态、不提示）
                return { ran: false, reason: 'superseded' };
            }
        }
        const r = await maybeAutoCheckOnStartup(o);
        runtime.update = { ran: !!r.ran, reason: r.reason, summary: r.summary || null, delayMs: plan.delayMs, delayReason: plan.reason };
        if (r.ran && r.summary) { try { setUpdateStatusLine(updateStatusText(r.summary)); } catch (e) { /* 面板可能未挂载 */ } }
        return r;
    } catch (e) {
        runtime.update = { ran: false, reason: 'error', summary: null, delayMs: plan.delayMs, delayReason: plan.reason };
        return { ran: false, reason: 'error' };
    }
}

/** 待执行的启动更新检查（同一时刻最多一个：新一轮调度会取代旧的） */
let startupUpdatePending = null;

/**
 * 等待启动检查的延迟（可被取代 / 被 `teardown()` 取消）。
 * @returns {Promise<boolean>} true = 该执行了；false = 已被取代或取消
 */
function waitStartupUpdateDelay(ms, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const ticket = { id: 0, cancelled: false, resolve: resolve };
        // 新一轮调度替代旧的一轮（例如 init 与 APP_READY 双双触发）
        try { if (startupUpdatePending) cancelStartupUpdateDelay(); } catch (e) { /* 忽略 */ }
        startupUpdatePending = ticket;
        const done = (ok) => {
            if (ticket.settled) return;
            ticket.settled = true;
            if (startupUpdatePending === ticket) startupUpdatePending = null;
            resolve(!!ok);
        };
        ticket.done = done;
        try {
            const id = timerHooks.set(() => { done(true); }, ms);
            ticket.id = id || 0;
        } catch (e) {
            done(true);        // 定时器不可用 → 不延迟（宁可检查，也不要永不检查）
            return;
        }
        // 兜底：定时器钩子若未真正回调（被宿主吞掉），用原始 setTimeout 保证仍会执行
        if (typeof setTimeout === 'function' && o.noFallbackTimer !== true) {
            try {
                const fb = setTimeout(() => { done(true); }, Math.max(0, Number(ms) || 0) + 250);
                ticket.fallback = fb;
            } catch (e) { /* 忽略 */ }
        }
    });
}

/**
 * v3.0.23：作用域未就绪时的**一次性延迟重载**（用户报告「初次激活插件读取的数据还是没有对齐」）。
 *   初次激活 / 宿主早期加载时，角色稳定键可能还是空的 → 这一次读的是 `default` 作用域（等于读了别人的文件）。
 *   这里安排**一次** 1.5s 后的重载（经内核 `timerHooks`，宿主可替换 → 测试可断言；`teardown` 会撤销）。
 * @returns {{scheduled:boolean, delayMs:number}}
 */
export const SCOPE_RELOAD_DELAY_MS = 1500;
let scopeReloadPending = null;
export function scheduleScopeReload(ms) {
    const delay = Math.max(0, Number(ms) || SCOPE_RELOAD_DELAY_MS);
    try { cancelScopeReload(); } catch (e) { /* 忽略 */ }
    const ticket = { id: 0, fallback: 0, done: false };
    scopeReloadPending = ticket;
    const fire = () => {
        if (ticket.done) return;
        ticket.done = true;
        if (scopeReloadPending === ticket) scopeReloadPending = null;
        try { void loadMemoryState().catch(() => { }); } catch (e) { /* 忽略 */ }
    };
    try { ticket.id = timerHooks.set(fire, delay) || 0; } catch (e) { /* 落到兜底定时器 */ }
    if (typeof setTimeout === 'function') { try { ticket.fallback = setTimeout(fire, delay + 500); } catch (e) { /* 忽略 */ } }
    runtime.scopeReload = { scheduled: true, delayMs: delay, at: Date.now() };
    try { debugLogPush('对账', { action: '载入：作用域未就绪 → 已安排一次延迟重载', delayMs: delay }); } catch (e) { /* 忽略 */ }
    return { scheduled: true, delayMs: delay };
}

/** 取消待执行的作用域重载（teardown / 新调度时调用；幂等） */
export function cancelScopeReload() {
    try {
        const t = scopeReloadPending;
        if (!t) return false;
        scopeReloadPending = null;
        t.done = true;
        if (t.id) { try { timerHooks.clear(t.id); } catch (e) { /* 忽略 */ } }
        if (t.fallback) { try { clearTimeout(t.fallback); } catch (e) { /* 忽略 */ } }
        return true;
    } catch (e) { return false; }
}

/** 取消待执行的启动更新检查（teardown / 新调度时调用；幂等） */
export function cancelStartupUpdateDelay() {
    try {
        const t = startupUpdatePending;
        if (!t) return false;
        startupUpdatePending = null;
        t.cancelled = true;
        if (t.id) { try { timerHooks.clear(t.id); } catch (e) { /* 忽略 */ } }
        if (t.fallback) { try { clearTimeout(t.fallback); } catch (e) { /* 忽略 */ } }
        if (typeof t.done === 'function') t.done(false);
        return true;
    } catch (e) { return false; }
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
            await saveStateNow({ reason: 'import-v1', force: true });     // v3.0.15：导入是直接写入 → 不走「无变化」短路
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
        await saveStateNow({ reason: 'import-json', force: true }); // v3.0.15：同上
        const after = DIMENSIONS.reduce((n, d) => n + ((merged && Array.isArray(merged[d.kind])) ? merged[d.kind].length : 0), 0);
        return { ok: true, added: Math.max(0, after - before) };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/** 面板只读状态快照（作用域 / 注入字数 / 提取统计 / 待分析 / 存储来源） */
function panelStatusSnapshot() {
    let injectChars = 0, pending = null;
    try { injectChars = readInject().length; } catch (e) { /* 忽略 */ }
    try { pending = pendingFloors({}).length; } catch (e) { /* 忽略 */ }
    // v3.14.0：把首屏载入闸门一起带给界面（抽屉卡片据此只显示「读取中」而不是残缺条数）
    let load = null;
    try { load = loadGateInfo(); } catch (e) { load = null; }
    return { scope: (runtime.store && runtime.store.scope) || '', injectChars, pending, extract: extractStats(), store: runtime.store, load: load };
}

/**
 * v2.42.0：把 `globalThis.FTT.*` 的每个入口包一层追踪（cat='cmd'）——
 *   入口名 / 参数摘要 / 返回摘要 / 耗时 / 站点；`trace*` 自身入口不包装（避免自递归）。
 */
function wrapFttEntries() {
    try {
        const F = globalThis.FTT;
        if (!F) return false;
        const SELF = ['trace', 'traceList', 'traceTimeline', 'traceStats', 'traceContext', 'traceClear', 'dbgDump', 'debugLogExport', 'debugLogExportText'];
        let n = 0;
        for (const k of Object.keys(F)) {
            if (SELF.indexOf(k) >= 0) continue;
            if (typeof F[k] !== 'function') continue;
            if (F[k].__fttTraced) continue;
            const orig = F[k];
            const wrapped = function (...args) {
                const op = traceOpStart('entry.' + k, { args: args.map((a) => (typeof a === 'string' ? a.slice(0, 60) : typeof a)) });
                const t0 = Date.now();
                try {
                    const r = orig.apply(this, args);
                    if (r && typeof r.then === 'function') {
                        return r.then(
                            (v) => { finishEntry(k, op, t0, { ok: true, ret: v }); return v; },
                            (e) => { finishEntry(k, op, t0, { ok: false, reason: String((e && e.message) || e) }); throw e; },
                        );
                    }
                    finishEntry(k, op, t0, { ok: true, ret: r });
                    return r;
                } catch (e) {
                    finishEntry(k, op, t0, { ok: false, reason: String((e && e.message) || e) });
                    throw e;
                }
            };
            try { wrapped.__fttTraced = true; Object.defineProperty(wrapped, 'name', { value: k }); } catch (e) { /* 忽略 */ }
            F[k] = wrapped;
            n += 1;
        }
        return n;
    } catch (e) { return false; }
}
/** 入口调用收尾：记录一条 cmd 事件（含耗时/站点/opId） */
function finishEntry(key, op, t0, r) {
    try {
        const ok = !r || r.ok !== false;
        traceOpEnd(op, { ok, reason: (r && r.reason) || '' });
        traceEvent({
            cat: 'cmd', kind: key, level: ok ? 'debug' : 'info', ok,
            reason: String((r && r.reason) || ''), ms: Date.now() - t0,
            detail: { source: 'FTT-entry', ret: (() => { const v = r && r.ret; if (v === undefined) return 'undefined'; if (typeof v === 'string') return v.slice(0, 80); if (Array.isArray(v)) return '[' + v.length + ']'; return typeof v; })() },
            site: traceSite(undefined, ['/index.js']), opId: op.opId, op: op.name,
        });
    } catch (e) { /* 忽略 */ }
}

/**
 * 一键诊断快照（v2.34.0 引入，v2.41.0 抽成函数供 FTT 入口与调试包导出共用）：
 *   版本 / 就绪 / 调试接线 / 异常捕捉状态 / 异常计数与最近 3 条 / 日志统计 / 最近 10 条 / 探针缺失项 / 最后一条异常。
 */
export function debugDumpSnapshot() {
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
}

/**
 * 诊断入口**提前注册**（模块加载即注册，不依赖 APP_READY）：
 *   ① `/ftt`、`/ftt-panel`、`/ftt-analyze`、`/ftt-import` 命令与 `{{fttVersion}}`/`{{fttStatus}}` 宏；
 *   ② `window.FTT` 调试导出（含 `panelInfo()` / `forceMount()`）。
 * 这样即使初始化没有触发（宿主事件缺失/加载时机不同），用户依然能用命令自查。
 */
function bootstrapDiagnostics() {
    const hooks = { importV1: runV1Import, extract: runExtract, summary: runSummaryBatch, abort: abortExtraction, clearFloors: clearProcessedFloors, pending: pendingFloors, panel: forceMountPanel, ui: openPanelPopup, exportState: exportStateJson, importState: importStateJson };
    // v2.41.0：调试页钩子**模块加载即接线**（`init` 未必触发；导出调试包需要 dump/meta）
    try {
        setDebugPageHooks({
            dump: () => debugDumpSnapshot(),
            meta: () => ({
                scope: (runtime.store && runtime.store.scope) || '',
                ready: !!runtime.ready,
                probe: (runtime.probe && runtime.probe.missing) ? { missing: runtime.probe.missing } : null,
                store: (runtime.store && { via: runtime.store.via || '', file: runtime.store.file || '' }) || null,
            }),
        });
    } catch (e) { /* 钩子接线失败不影响诊断入口 */ }
    try {
        if (!runtime.slash) runtime.slash = registerSlashCommand(extraForStatus, hooks);
    } catch (e) { runtime.slash = false; }
    try {
        if (!runtime.macros) runtime.macros = registerMacros(extraForStatus);
    } catch (e) { runtime.macros = false; }
    // v3.0.7：装配本地调试桥（**只登记只读方法，不自动连接**；非 TauriTavern 只降级不报错）
    try { installDebugBridge(); } catch (e) { /* 调试桥装配失败不影响主流程 */ }
    try {
        installDevtools(Object.assign({
            // v2.46.0：启动自动检查的排期（供 `FTT.snapshot()/FTT.update()` 与调试包回答「为什么还没检查」）
            updateSchedule: () => (runtime.update ? { ...runtime.update } : null),
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
            // v2.77.0 存储通道（宿主原生存储 / 酒馆用户目录文件）：现状 / 键清单 / 未命中抑制 / 缓存
            fileChannel: () => fileTransportStatus(),
            fileChannelKeys: () => fileTransportListKeys(),
            fileChannelKey: (name) => fileTransportKey(name),
            fileChannelDropCache: () => fileTransportDropCaches(),
            fileChannelReset: () => resetFileTransportSession(),
            ttChannel: () => ttChannelInfo(),
            ttMissStats: () => ttMissStats(),
            ttStoreOverview: () => ttStoreOverview(),
            ttStoreInfo: () => ({ ns: TT_NS, legacyNs: TT_LEGACY_NS, table: TT_TABLE }),
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
            // v3.0.3：自动路径已改为「不一致 → 自动下载合并」，不再产生待选；本入口供**旧版本遗留待选**的
            //   人工处置与回归测试注入（UI 仅在确实存在待选时显示横幅与两个按钮）。
            crossPendingSet: (env, info) => crossPendingSet(env, info),
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
            // v2.37.0「时钟取值追踪」：值从哪来 / 为什么取它 / 有什么没被采用 / 这次改了什么
            clockTrace: (stage) => clockTraceInfo(stage ? clockTraceLast(stage) : clockTraceLast()),
            clockTraceAll: () => ({ resolve: clockTraceList('resolve').map(clockTraceInfo), patrol: clockTraceList('patrol').map(clockTraceInfo), 'regex-ai': clockTraceList('regex-ai').map(clockTraceInfo), 'time-repair': clockTraceList('time-repair').map(clockTraceInfo) }),
            clockTraceSummary: (stage) => clockTraceSummary(stage ? clockTraceLast(stage) : clockTraceLast()),
            clockTraceClear: () => clockTraceClear(),
            // v3.0.23：读取台账（面板/调试台同源；只读 + 可清零）
            reads: (o2) => ({ stats: readLedgerStats(), lines: readLedgerLines(Number((o2 && o2.limit) || 20)) }),
            readsText: (limit) => readLedgerSummaryText(Number(limit) || 30),
            readsClear: () => resetReadLedger(),
            loadInfo: () => (() => { try { return { server: lastServerLoadInfo(), store: storeStatus(), ledger: readLedgerStats() }; } catch (e) { return null; } })(),
            // v3.1.0（性能观测 / 容量诊断，docs/D13 S0/S2/S3）：面板渲染观测 · 本机缓冲预算 · 向量缓存容量
            // v3.3.0（用户要求）：数据管理 →「本地缓冲」全面补充（本机副本 / 命名缓存 / 同步标记 / V1 遗留）
            localCopyInfo: () => (() => { try { return localCopyStats(); } catch (e) { return null; } })(),
            localKeyStats: () => (() => { try { return localKeyStats(); } catch (e) { return null; } })(),
            localCopyClear: (o2) => clearLocalCopy(o2 || {}),
            localCopyClearOthers: () => clearLocalCopy({ target: 'others' }),
            idbCopyClear: () => clearLocalCopy({ target: 'idb' }),
            nameCacheClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.names.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理命名缓存', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
            syncMarkClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.syncMarks.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理同步与对账标记', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
            v1LegacyClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.v1Legacy.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理 V1 遗留本机数据', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
            renderStats: () => (() => { try { return panelRenderStats(); } catch (e) { return null; } })(),
            localBuffer: () => (() => { try { return localBufferState(); } catch (e) { return null; } })(),
            vectorCache: () => (() => { try { return vectorCacheStats(); } catch (e) { return null; } })(),
            vectorCacheCaps: (o2) => setVectorCacheCaps(o2 || {}),

            clockSrcLabel: (k) => clockSrcLabel(k),
            clockSrcLabels: () => clockSrcKeys().map((k) => ({ key: k, label: clockSrcLabel(k) })),
            clockAnchor: () => clockPatrolAnchorInfo(),
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
            // v3.8.0：NSFW 等级留档（无 / 弱 / 强）—— 统计 / 补档 / 单条判级（只读诊断用）
            nsfwLabels: (st) => nsfwLabelStats(st || undefined),
            // v3.13.0：数据体检（只读；本地调试端口 / 控制台核对数据异常）
            dataHealth: (opts) => dataHealthReport(undefined, opts || {}),
            dataHealthText: () => dataHealthText(dataHealthReport()),
            nsfwBackfill: (opts) => nsfwBackfill(opts || {}),
            nsfwLevelOf: (it) => nsfwLevelOf(it),
            nsfwClassify: (dim, it) => nsfwClassifyItem(dim, it),
            // v3.19.0：NSFW 词条分析（抽取强留档 → AI 找词 → 写转化库；只读诊断入口给本地调试端口）
            nsfwAnalyze: (opts) => runNsfwAnalyze(opts || {}),
            nsfwAnalyzeState: () => nsfwAnalyzeState(),
            nsfwAnalyzePack: (opts) => nsfwAnalyzePack(opts || {}),
            nsfwAnalyzeScan: (opts) => nsfwAnalyzeCandidates(opts || {}),
            nsfwAnalyzeFilter: (pack, delta, opts) => nsfwAnalyzeSanitize(pack, delta, opts || {}),
            nsfwAnalyzeSeen: () => nsfwAnalyzeSeenCount(),
            nsfwAnalyzeSeenReset: () => nsfwAnalyzeSeenReset(),
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
            dbgDump: () => debugDumpSnapshot(),
            dbgErrors: (limit) => debugLogErrors(limit),
            dbgErrorCount: () => debugLogErrorCount(),
            dbgLastError: () => debugLogLastError(),
            errCaptureState: () => errorCaptureState(),
            // v2.42.0：交互/宿主调用追踪（时间线 / 统计 / 上下文窗口 / 清空）
            trace: (opts) => ({ stats: traceStats(), timeline: traceTimelineText((opts && opts.limit) || 50), list: traceList(opts || { limit: 50 }) }),
            traceList: (opts) => traceList(opts || {}),
            traceTimeline: (limit) => traceTimelineText(limit),
            traceStats: () => traceStats(),
            traceContext: (id, span) => traceContext(id, span),
            traceClear: () => traceClear(),
            traceStoreLoad: () => traceStoreLoad(),
            traceStoreSave: (l) => traceStoreSave(l),
            traceStoreClear: () => traceStoreClear(),
            traceSite: () => traceSite(),
            // v2.83.0：关联层（派生视图 + 反向索引）—— 「谁依赖我」「我引用了谁」「按坐标/关键字查」
            relations: (opts) => { try { return relationSnapshot(opts || {}); } catch (e) { return { edges: [], stats: {}, error: String((e && e.message) || e) }; } },
            relationStats: () => { try { return relationStats(); } catch (e) { return {}; } },
            relationLayerOn: () => { try { return relationLayerOn(); } catch (e) { return false; } },
            dependents: (dim, id) => { try { return dependents({ dim: String(dim || ''), id: String(id || '') }); } catch (e) { return []; } },
            relationsOf: (dim, id) => { try { return relationsOf({ dim: String(dim || ''), id: String(id || '') }); } catch (e) { return []; } },
            relationQuery: (q, opts) => { try { return relationQueryRefs(q, opts || {}); } catch (e) { return []; } },
            // v2.41.0：调试包导出（面板「📦 导出调试包」同一实现）
            debugLogExport: () => { try { return buildDebugExport(); } catch (e) { return null; } },
            debugLogExportText: () => { try { return JSON.stringify(buildDebugExport(), null, 1); } catch (e) { return ''; } },
            // v2.35.0（B10-a）：API 通道与「API 分组」预设入口（含连通性测试与模型列表）
            apiChannelSummary: () => apiChannelSummary(),
            apiChannelAvailability: () => apiChannelAvailability(),
            apiProfiles: () => listConnectionProfiles(),
            apiTarget: (opts) => resolveApiTarget(opts || {}),
            apiPresetNames: () => apiChannelSummary().presets.map((p) => p.name),
            apiPresetSave: (name) => { const r = apiPresetSave(name); if (r.ok) { try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ } } return r; },
            apiPresetLoad: (name) => { const r = apiPresetLoad(name); if (r.ok) { try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ } } return r; },
            apiPresetDelete: (name) => { const r = apiPresetDelete(name); if (r.ok) { try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ } } return r; },
            apiTest: (opts) => probeTarget(opts && opts.target ? opts.target : resolveApiTarget({ purpose: opts && opts.purpose }), (opts && opts.kind) || 'chat'),
            apiModels: (opts) => probeModels(opts && opts.target ? opts.target : resolveApiTarget({ purpose: opts && opts.purpose })),
            apiSend: (opts) => sendWithTarget((opts && opts.target) || resolveApiTarget({ purpose: opts && opts.purpose }), { systemPrompt: opts && opts.systemPrompt, prompt: opts && opts.prompt }),
            // v2.58.0：提取记忆三层（向量 / JS / AI）—— 设置页测试、诊断与命令共用
            vectorLayerInfo: () => vectorLayerInfo(),
            vectorLayerStatus: () => vectorLayerStatus(),
            vectorTarget: (kind) => vectorTarget(kind),
            vectorRecall: (keywords, opts) => vectorRecall(keywords, opts || {}),
            embeddingsRequest: (texts) => requestEmbeddings(texts),
            rerankRequest: (query, docs, topN) => requestRerank(query, docs, topN),
            vectorCacheStats: () => vectorCacheStats(),
            vectorCacheClear: () => vectorCacheClear(),
            vectorCachePut: (entries) => vecCachePutMany(entries),
            extractFlow: (floorText, opts) => runExtractFlow(floorText, opts || {}),
            testLayer: (layer, floorText, opts) => testLayer(layer, floorText, opts || {}),
            aiLayerInfo: () => aiLayerInfo(),
            aiKeywords: (text) => extractKeywordsFromText(text),
            aiMemorySend: (keywords, floorText, dump) => analyzeMemorySend(keywords, floorText, dump),
            worldbookEntries: (env) => buildWorldbookEntries(env),
            worldbookKeys: (n) => buildWorldbookKeys(n),
            worldbookIsFttEntry: (e) => worldbookIsFttEntry(e),
            worldbookLegacyEntryName: () => worldbookLegacyEntryName(),
            worldbookTotalBytes: (e) => worldbookTotalBytes(e),
            worldbookMemoryTotal: () => worldbookMemoryTotal(),
            // v3.0.22（用户要求）：总览「💾 保存（对齐所有存储）」同源入口（命令 / devtools / 测试共用）
            saveAll: (o2) => runSaveAll(o2 || {}),
            worldbookSync: () => scheduleWorldbookSync(),
            worldbookSyncNow: () => worldbookSyncNow(),
            worldbookSyncState: () => worldbookSyncState(),
            worldbookNames: () => worldbookNames(),
            refreshWorldbookNames: () => refreshWorldbookNames(),
            // B8-6b+ 关联层机械维护（零 AI；修复第 1 段收尾 + AI 修订后复检）
            relMaint: (opts) => relRepairMaint(opts || {}),
            // v3.2.0（用户要求）：关系表「清理无效关系」（与自动修复第 1 段同一步共用核心实现）
            relInvalidStats: (opts) => relInvalidStats((opts || {}).st),
            relCleanInvalid: (opts) => {
                const r = cleanInvalidRelLinks(opts || {});
                try { if (r && r.changed) saveStateNow({ reason: 'rel-clean-invalid' }); } catch (e) { /* 忽略 */ }
                return Object.assign({}, r, { summary: relInvalidSummary(r) });
            },
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
            // v3.22.0：超长年龄 / 长生者只读干跑（`FTT.ageAnomalyScan()` 经 devtools 透出，见 devtools.js）
            characterAgeScan: () => characterAgeScan(),
            // 注：只读干跑 `FTT.deceasedScan()` 由 `devtools.js` **直接实现**（不占宿主钩子位；此处不再重复登记）
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
            // v2.99.0：自定义平行推演（面板「🧪 自定义推演」→ 产物与常规推演完全同构）
            runParallelCustom: (idea, opts) => runParallelCustom(idea, opts || {}),
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
            scheduleStorageSync, extract: runExtract, recall: (opts) => runRecallNow(opts || {}), recallState: () => ({ inFlight: injectInFlight(), stats: pushStats() }), pendingFloors, pendingScan, extractStatus: extractSummary, summaryDims: () => summaryDimsForPrompt(), menuInfo, ensureMenu: () => ensureMenuEntry(entryClickHooks()), i18n: i18nStats, t, folderInfo, forceMountPanel, panelInfo: panelMountInfo, menuInfo, floatingInfo, openPanelPopup, ensureVisibleEntry, popupInfo, popupAction, v1PanelInfo: panelInfo, v1PanelTabs: panelTabs, injectNow, summary: runSummaryBatch, abort: abortExtraction, clearFloors: clearProcessedFloors, exportState: exportStateJson, importState: importStateJson }));
        // v2.42.0：**FTT.* 入口调用入流**（cat='cmd'）—— 用户/维护者在控制台调 `FTT.xxx()` 也能追溯：
        //   记录入口名 / 参数摘要 / 结果 / 耗时 / 站点，并把该调用期间的宿主与内核事件用 opId 串起来。
        try { wrapFttEntries(); } catch (e) { /* 追踪接线失败不影响调试入口 */ }
        try { wireTraceStore(); } catch (e) { /* 追踪持久化失败不影响主流程 */ }
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
/** 是否已经有**可见入口**（主入口=扩展菜单；或抽屉面板；或悬浮按钮；或顶栏/底部按钮） */
function visibleEntryReady() {
    try {
        const st = entryButtonsState().installed;
        return panelMountInfo().ok || st.menu || st.float || st.topbar || st.qr;
    } catch (e) { return false; }
}
/** 入口点击 → 打开面板弹窗（V1 `togglePanel` 的 V2 等价物） */
function entryClickHooks() { return { onClick: () => openPanelPopup() }; }
/** v2.65.0：按 `cfg.buttonLocations` 启停全部插件自建入口（设置页改开关 → 立即生效） */
function syncEntriesNow(locations) {
    try { return syncEntryButtons(locations || cfgRef.buttonLocations || {}, entryClickHooks()); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}
/** 只移除「可见性兜底」来源的悬浮按钮（用户自己开启的保留） */
function dropFallbackFloat() {
    try { if (floatingInfo().reason === 'fallback') return uninstallFloatingEntry(); } catch (e) { /* 忽略 */ }
    return false;
}
/** v2.65.0：`cfg.uiShowDrawer` 开关立即生效（挂载 / 卸载扩展设置抽屉卡片） */
async function applyDrawerVisibility(on) {
    const want = (on === undefined) ? cfgShowDrawer() : !!on;
    try {
        if (want) {
            const r = await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot() });
            return { ok: !!r.ok, on: true, reason: r.reason || '' };
        }
        const off = unmountSettingsPanel();
        return { ok: true, on: false, removed: !!off };
    } catch (e) { return { ok: false, on: want, reason: String((e && e.message) || e) }; }
}

async function probeTick(why) {
    noteTrigger(why);
    try {
        if (!hasHost()) return false;
        if (!runtime.ready) await ensureReady(why);
        // v2.67.0：主入口（扩展菜单项）每轮补一次 —— 酒馆可能晚建/重建 `#extensionsMenu`
        try { ensureMenuEntry(entryClickHooks()); } catch (e) { /* 忽略 */ }
        if (runtime.ready && cfgShowDrawer() && !panelMountInfo().ok) {
            try { await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot() }); } catch (e) { /* 下一轮再试 */ }
        }
        if (runtime.ready && visibleEntryReady()) {
            if (panelMountInfo().ok) dropFallbackFloat();
            stopReadyProbe();
            return true;
        }
        // 连续若干次仍没有可见入口 → 启用悬浮兜底并停止轮询（不无限重试）
        if (runtime.ready && runtime.bootstrap.pollTries >= FLOAT_AFTER_TRIES) {
            if (cfgRef.uiShowFloating !== false) {
                const f = installFloatingEntry(entryClickHooks(), { reason: 'fallback' });
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
        setPanelHooks2(panelRuntimeHooks());   // v2.40.0：面板所需的**全部**钩子（此前只用 popupHooks() → 导出/导入等缺接）
        // v2.90.0：管线状态的历史耗时读写（ST 扩展设置里的 `pipelineEta`：每个处理行为保留最近 5 次）
        // v2.93.0（`docs/D12` v0.2 §8-A）：**删楼是常态** —— 收缩结果按类型**合并计数**登记一条人工确认项（低噪声，不刷屏）
        setFloorShrinkHook((info) => {
            try {
                noteConflict({
                    kind: '楼层收缩', scope: 'floors',
                    detail: '聊天已减小 ' + Number(info.removedFloors || 0) + ' 层（现 ' + (Number(info.lastId) + 1) + ' 层）；台账已按内容归位 ' + Number(info.marks || 0) + ' 条，' + Number(info.staleEntries || 0) + ' 条条目的楼层信息已标记失效（记忆数据保留）',
                    count: 1,
                });
            } catch (e) { /* 忽略 */ }
        });
        setConflictHooks({
            get: () => { try { return getSettings().syncConflicts || []; } catch (e) { return []; } },
            save: (list) => { try { setSetting('syncConflicts', Array.isArray(list) ? list : []); } catch (e) { /* 忽略 */ } },
        });
        wirePipelineHooks();
        setDebugPageHooks({
            dump: () => debugDumpSnapshot(),
            meta: () => ({
                scope: (runtime.store && runtime.store.scope) || '',
                ready: !!runtime.ready,
                probe: (runtime.probe && runtime.probe.missing) ? { missing: runtime.probe.missing } : null,
                store: (runtime.store && { via: runtime.store.via || '', file: runtime.store.file || '' }) || null,
            }),
        });
        const r = openPanel(tab);
        if (r.ok) return r;
    } catch (e) { /* 落到抽屉/挂载 */ }
    const m = await forceMountPanel();
    return { ok: !!m.ok, via: 'mount', reason: m.reason };
}

/** 「📤 立即注入」：按当前配置立刻注入一次（返回字数） */
export async function injectNow() { return pushMemoryInject({ queryText: '' }); }

/** 弹窗动作钩子（提取 / 更新 / 清空注入 / 清单 / 状态） */
/** 弹窗（V2 附加入口）钩子 —— 仅用于 `openPanelPopup` 的小弹窗 */
function popupHooks() {
    return {
        extract: runExtract,
        pending: pendingFloors,
        // v3.0.22（用户要求）：总览「💾 保存（对齐所有存储）」
        saveAll: (o2) => runSaveAll(o2 || {}),
        // v3.1.0（性能观测，docs/D13 S0）：慢渲染留痕（面板只在超过阈值时回调，正常渲染零噪音）
        onSlowRender: (rec) => {
            try { debugLogPush('存储', { action: '面板渲染偏慢', tab: String((rec && rec.tab) || ''), ms: Number((rec && rec.ms) || 0), bytes: Number((rec && rec.bytes) || 0), builds: Number((rec && rec.builds) || 0) }); } catch (e) { /* 忽略 */ }
            try { traceEvent({ cat: 'ui', kind: 'slow-render', level: 'info', detail: { tab: String((rec && rec.tab) || ''), ms: Number((rec && rec.ms) || 0), bytes: Number((rec && rec.bytes) || 0) } }); } catch (e) { /* 忽略 */ }
        },
            // v3.3.0（用户要求）：数据管理 →「本地缓冲」全面补充（本机副本 / 命名缓存 / 同步标记 / V1 遗留）
            localCopyInfo: () => (() => { try { return localCopyStats(); } catch (e) { return null; } })(),
            localKeyStats: () => (() => { try { return localKeyStats(); } catch (e) { return null; } })(),
            localCopyClear: (o2) => clearLocalCopy(o2 || {}),
            localCopyClearOthers: () => clearLocalCopy({ target: 'others' }),
            idbCopyClear: () => clearLocalCopy({ target: 'idb' }),
            nameCacheClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.names.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理命名缓存', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
            syncMarkClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.syncMarks.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理同步与对账标记', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
            v1LegacyClear: () => {
                const ks = localKeyStats();
                const rm = removeLocalKeys((ks.v1Legacy.keys || []).map((x) => x.key));
                try { if (rm.removed) debugLogPush('存储', { action: '清理 V1 遗留本机数据', keys: rm.removed }); } catch (e) { /* 忽略 */ }
                return { ok: true, cleared: rm.removed, failed: rm.failed };
            },
        extractStatus: extractSummary,
        lastExtract: () => { try { return lastExtractRecord(); } catch (e) { return null; } },   // v2.59.0：最后一次提取记录（总览组件同源）
        lastPreflight: () => { try { return lastPreflightInfo(); } catch (e) { return null; } },   // v2.61.0：提取前校对结果
        calibrateBasics: (opts) => { try { return calibrateBasics(opts || {}); } catch (e) { return null; } },
        clearInject,
        checkUpdate: checkUpdateNow,
    };
}

/**
 * v2.40.0：**面板（V1 同构浮层）所需的全部运行时钩子**。
 *
 * 背景（用户报告「数据管理导出导入功能不可用」）：面板钩子此前只注入 `popupHooks()` 的 4~5 个键，
 *   而 `ui/panel.js` 实际读取 15 个键 → **导出 / 导入 / V1 导入 / 批量摘要 / 中断 / 清台账 / 维度开关**
 *   全部落到「入口未就绪」或静默不生效（自 v2.2.0 的 B1 批次起一直如此；当时测试只走 `popupAction` 的
 *   devtools 钩子，所以没被发现）。现在把面板需要的键**一次性补齐**，并由
 *   `tests/unit/panel-hooks.test.js` 做**静态交叉校验**（面板读到的每个 `hooks.X` 都必须在册），防止再次漏接。
 */
export function panelRuntimeHooks() {
    return Object.assign({}, popupHooks(), {
        inject: injectNow,
        // v2.74.0：「📤 提取记忆」= 发送前召回（向量/JS 为主，不占分析管道、可并行）
        recall: (opts) => runRecallNow(opts || {}),
        // v2.75.0：总览「查看注入内容」= 当前实际注入给 AI 的正文（读回 ST 注入通道）
        injectText: () => { try { return readInject(); } catch (e) { return ''; } },
        recallState: () => ({ inFlight: injectInFlight(), stats: pushStats() }),
        exportState: exportStateJson,
        importState: importStateJson,
        // v2.49.0：导出文件名（V1 `export` 动作：`FTT记忆_<角色哈希>.json`；`hashText` 与 V1 同算法）
        // v3.0.17（用户要求「导出 json 备份，文件名必须带日期和时间」）：追加 `_日期_时间`
        //   （`2026-09-30_14-05-22`，本地时间、无冒号）—— 同一角色多次导出不再互相覆盖，事后也能一眼看出备份时间。
        exportFileName: () => {
            try { return 'FTT记忆_' + hashText(String(getScopeKey() || 'scope')) + '_' + fileStamp() + '.json'; }
            catch (e) { try { return 'FTT记忆_' + fileStamp() + '.json'; } catch (e2) { return 'FTT记忆.json'; } }
        },
        importV1: runV1Import,
        autoSummary: runSummaryBatch,          // 总览「批量摘要」
        abort: abortExtraction,                // 总览「中断」
        batchProgress: batchProgress,          // 忙位进度（「分析中 x/y 段」）
        busy: () => { try { return !!extractBusy(); } catch (e) { return false; } },   // v2.52.0：总览「管线状态」行 + 中断按钮的条件展示
        lastExtract: () => { try { return lastExtractRecord(); } catch (e) { return null; } },   // v2.59.0：总览「📤 最后一次提取」组件
        // v2.99.0（用户要求「可添加新平行世界」）：面板「🧪 自定义推演」的运行入口
        parallelCustom: (idea) => runParallelCustom(String(idea == null ? '' : idea), {}),
        clearFloors: clearProcessedFloors,     // 数据管理「清除已处理记录」
        resetState: () => resetState(),        // 数据管理「清空当前角色记忆」（缺省回落适配层同名函数）
        // v2.94.0（D12 §4 / §8-E）：数据管理「删除到最近 N 层」三档（官方 API + 备份 + 精确编号校准）
        floorTrimStatus: () => { try { return floorTrimStatus(); } catch (e) { return null; } },
        floorTrimPrecheck: (keep) => { try { return floorTrimPrecheck(keep); } catch (e) { return { ok: false, reason: 'error' }; } },
        floorTrim: (keep) => runFloorTrim(keep),
        // v2.94.0（D12 §3.4 / 阶段 S3）：设定 → 存储「🔄 重新校准楼层」（幂等手动兜底）
        floorRecalibrate: () => { try { return floorRecalibrate(); } catch (e) { return { ok: false, skipped: 'error' }; } },
        dimToggle: (kind, on) => setDimensionEnabled(kind, on),
        confirm: (text, title) => hostConfirm(text, title),
        // v2.96.0：面板动作的用户可见通知（V1 `notify()` 等价物）—— 单楼分析这类长耗时动作**开始时与结束时**
        //   都弹一条，用户不必盯着总览底部那行小字才知道「点了有没有生效」
        notify: (kind, text) => { try { notifyHooks.toast(String(text || ''), String(kind || 'info')); return true; } catch (e) { return false; } },
        // v2.65.0：显示界面开关 —— 改开关立即重建/移除对应的入口按钮；抽屉卡片开关立即挂载/卸载
        syncEntries: (locations) => syncEntriesNow(locations),
        showDrawer: (on) => applyDrawerVisibility(on),
    });
}

/** 维度开关（V2 附加设定「启用维度」）：写内核 `cfg.dimensionEnabled` 并落盘（V1 同键同语义） */
function setDimensionEnabled(kind, on) {
    const k = String(kind || '');
    if (!k) return { ok: false, reason: 'no-kind' };
    try {
        cfgRef.dimensionEnabled = Object.assign({}, cfgRef.dimensionEnabled || {});
        cfgRef.dimensionEnabled[k] = !!on;
        try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
        return { ok: true, kind: k, on: !!on };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/**
 * v2.95.0（`docs/history/P10bc` ⑤ 的加固）：**管线状态的历史样本读写接线**。
 * 为什么必须与装配同批（而不是只在 `openPanelPopup` 里）：预估倒计时的样本由**任何** AI 任务产生，
 *   与「面板是否开过」无关；只在开面板时接线会让「第一次运行的样本」永久丢失，倒计时一直停在「（默认）」。
 */
let pipelineWired = false;
function wirePipelineHooks() {
    if (pipelineWired) return true;
    pipelineWired = true;
    setPipelineHooks({
        getHistory: () => { try { return getSettings().pipelineEta || {}; } catch (e) { return {}; } },
        saveHistory: (h) => { try { setSetting('pipelineEta', (h && typeof h === 'object') ? h : {}); } catch (e) { /* 忽略 */ } },
        // v3.0.14：管线异常留痕（超时收尾 / 异常大的耗时样本不入账）→ 调试日志，便于事后核对
        log: (msg, detail) => { try { debugLogPush('管线', Object.assign({ action: String(msg || '') }, detail || {})); } catch (e) { /* 忽略 */ } },
    });
    return true;
}

/**
 * v2.94.0（`docs/D12` v0.2 §4 / §8-E）——**删楼动作**（设定 → 数据管理 三档按钮的唯一入口）。
 * 用户要求「用官方 API 实现，不然其他插件也会异常」→ 删除只在 `host/floor-trim.js` 内经**官方上下文 API** 执行：
 * v3.17.0 起默认是**一次性批量截断**（官方 `chat` 数组 + `saveChat` + `clearChat`/`printMessages` + 一次
 * `MESSAGE_DELETED`）；逐层 `deleteMessage` 只在「批量不可用且 ≤3 层」时作最后手段，超过即拒绝
 * （真机实测逐层 ≈1.5 秒/层，242 层删 230 层会把界面卡住 5 分 45 秒）。
 * 本函数只负责**接线**（明文导出 / 3 槽轮转备份 / 账本落 ST 扩展设置 / 人工确认项 / 通知），
 * 业务判定与执行全在宿主层，便于单测与冒烟用桩宿主验证真实删除流程。
 */
/**
 * v3.0.22（用户要求）：「总览新增保存按钮，可对齐已开启的所有存储，包括内存、浏览器本地变量、服务端等，全部对齐数据。」
 *
 * 把**当前内存数据**依次写到**每一层已开启的存储**，并逐层回报结果（面板提示 / 调试日志 / 人工确认项都不写，
 * 这是一次正常的保存动作）：
 *
 * | 层 | 落点 | 开关 / 跳过条件 |
 * | --- | --- | --- |
 * | 本机缓冲（浏览器本地变量） | `localStorage` 键 `ftt2_state_<scope>` | 始终 |
 * | IndexedDB 缓冲 | `localforage` 可用时 | 不可用即跳过 |
 * | 服务端记忆文件（完整信封） | `/api/files/upload` `ftt2-state-<scope>.json` | `storage.stateFile` |
 * | 服务端**分片**（v3.0.21） | `ftt2-shard-*`（本次 `force` 全量重传 → 与内存完全一致） | `storage.stateFile` |
 * | 快照文件 | `snapshotFilePushNow()` | `storage.snapshotFile` 且快照链非空 |
 * | 清单文件（对账用） | `metaFilePushNow()` | `storage.syncMetaProbe` 等既有门控 |
 * | 世界书镜像 | `worldbookSyncNow()` | `storage.worldbook` |
 * | 跨端镜像（对端合并 + 推回） | `runStorageSync(true)` | `storage.syncOnSave` |
 * | 配置（ST 扩展设置） | `saveSettings()` | 始终 |
 *
 * @param {{silent?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, at:number, layers:object, failed:string[], skipped:string[]}>}
 */
export async function runSaveAll(opts) {
    const o = opts || {};
    const out = { ok: true, at: Date.now(), layers: {}, failed: [], skipped: [] };
    const mark = (name, r) => {
        const rec = Object.assign({ at: Date.now() }, r || {});
        out.layers[name] = rec;
        if (rec.skipped) out.skipped.push(name);
        else if (rec.ok === false) { out.failed.push(name); out.ok = false; }
        return rec;
    };
    // ① 本机缓冲 + IndexedDB + 服务端文件 + 分片（同一条保存流水线；`force` 绕开「无变化短路」，
    //    `shardsForce` 让分片**全量重传** —— 「对齐」的语义就是每一层都与内存逐字节一致）
    try {
        const r = await flushStateNow('手动保存（对齐所有存储）', { force: true, shardsForce: true });
        mark('state', { ok: !!(r && r.ok !== false), via: String((r && r.via) || ''), bytes: Number((r && r.bytes) || 0), error: String((r && r.error) || '') });
    } catch (e) { mark('state', { ok: false, error: String((e && e.message) || e) }); }
    // ② 快照文件（快照链非空且开关开启时）
    try {
        const st = kernelState || {};                       // 注意：`kernelState` 是**状态对象**（`state as kernelState`），不是函数
        if (!((st && st.snapStore) || []).length) mark('snapshot', { skipped: 'no-snapshots' });
        else { const sp = await snapshotFilePushNow(); mark('snapshot', { ok: !!(sp && sp.ok !== false), bytes: Number((sp && sp.bytes) || 0), error: String((sp && sp.error) || '') }); }
    } catch (e) { mark('snapshot', { ok: false, error: String((e && e.message) || e) }); }
    // ③ 清单文件（对账用；内部有开关与签名门控）
    try {
        const st = kernelState || {};
        const env = storageEnvelope(st);
        await metaFilePushNow(env, String((env && env.hash) || ''));
        mark('meta', { ok: true });
    } catch (e) { mark('meta', { skipped: String((e && e.message) || 'meta-off') }); }
    // ④ 世界书镜像（开关关闭即跳过）
    try {
        const w = await worldbookSyncNow();
        if (w && (w.skipped || w.reason)) mark('worldbook', { skipped: String(w.skipped || w.reason || 'off') });
        else mark('worldbook', { ok: w ? w.ok !== false : true, entries: Number((w && w.entries) || 0) });
    } catch (e) { mark('worldbook', { skipped: String((e && e.message) || 'worldbook-error') }); }
    // ⑤ 跨端镜像：对端拉取 + 原子合并 + 推回（`force` 绕开门控）
    try {
        const m = await runStorageSync(true);
        if (m && (m.skipped || m.error)) mark('mirror', { skipped: String(m.skipped || m.error) });
        else mark('mirror', { ok: m ? m.ok !== false : true, mode: String((m && m.mode) || ''), total: Number((m && m.total) || 0) });
    } catch (e) { mark('mirror', { ok: false, error: String((e && e.message) || e) }); }
    // ⑥ 配置（ST 扩展设置）
    try { saveSettings(); mark('settings', { ok: true }); } catch (e) { mark('settings', { ok: false, error: String((e && e.message) || e) }); }
    try {
        debugLogPush('存储', {
            action: '手动保存（对齐所有存储）', ok: out.ok,
            state: out.layers.state && out.layers.state.via, bytes: out.layers.state && out.layers.state.bytes,
            failed: out.failed, skipped: out.skipped,
        });
    } catch (e) { /* 忽略 */ }
    if (!o.silent) { try { notifyHooks.toast(out.ok ? '已对齐所有存储' : '部分存储对齐失败', out.ok ? 'info' : 'warning'); } catch (e) { /* 忽略 */ } }
    return out;
}

async function runFloorTrim(keep) {
    wireFloorTrimHooks();
    try { return await floorTrimApply({ keep: Number(keep) || 0 }); } catch (e) {
        return { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
}

/**
 * v3.19.0：NSFW 词条分析账本钩子（只接一次、幂等）。
 * 账本落 ST 扩展设置 `nsfwAnalyzeLog`（已分析指纹 + 最近一次结果 + 最近 10 条新增明细）——
 * 「运行账本」而非记忆数据，故不进数据模型（`DATA_VERSION` 不变）。
 * 在装配期就接线（不像删楼那样等到第一次动作）：设定页的状态行要**立刻**能读到「上次分析」。
 */
let nsfwAnalyzeWired = false;
function wireNsfwAnalyzeHooks() {
    if (nsfwAnalyzeWired) return true;
    nsfwAnalyzeWired = true;
    setNsfwAnalyzeHooks({
        getLog: () => { try { return getSettings().nsfwAnalyzeLog || null; } catch (e) { return null; } },
        saveLog: (v) => { try { setSetting('nsfwAnalyzeLog', (v && typeof v === 'object') ? v : {}); } catch (e) { /* 忽略 */ } },
    });
    return true;
}

/** 删楼钩子只接一次（幂等；账本落 ST 扩展设置 `floorTrimLog` —— 不进数据模型 → DATA_VERSION 不变） */
let floorTrimWired = false;
function wireFloorTrimHooks() {
    if (floorTrimWired) return true;
    floorTrimWired = true;
    setFloorTrimHooks({
        exportJson: () => exportStateJson(),
        // v3.0.19：**第 4 个参数必须透传** —— 备份名带时间戳后靠它把「该槽位的上一份」删掉（3 份轮转）；
        //   此前这里只传 3 个参数 → 生产环境里轮转删除从不执行（备份无限累积）。
        writeBackup: (scope, slot, text, opts) => writeFloorBackup(scope, slot, text, opts),
        getLog: () => { try { return getSettings().floorTrimLog || null; } catch (e) { return null; } },
        saveLog: (v) => { try { setSetting('floorTrimLog', (v && typeof v === 'object') ? v : {}); } catch (e) { /* 忽略 */ } },
        noteConflict: (item) => { try { noteConflict(item); } catch (e) { /* 忽略 */ } },
        notify: (kind, text) => { try { notifyHooks.toast(String(text || ''), String(kind || 'info')); } catch (e) { /* 忽略 */ } },
        // v3.17.0：批量截断的重渲染走 `clearChat()`（ST 官方行为：顺手把 `extension_prompts` 清空）→
        //   删楼后立刻重推一次注入，避免「删完这一轮注入为空」。幂等：没删成功时不会被调用。
        afterMutate: () => {
            try { clearInject(); } catch (e) { /* 忽略 */ }
            try { runtime.chat = wireKernelChatHooks(); } catch (e) { /* 忽略 */ }
            try { void pushMemoryInject({ queryText: '' }).catch(() => { }); } catch (e) { /* 忽略 */ }
        },
    });
    return true;
}

/**
 * 确认对话框（**同步**，与 V1 的 `confirm()` 同口径）：优先宿主原生 `confirm`；
 * 无对话框能力的环境（测试桩 / 受限 webview）返回 `false` → 面板按「取消」处理（V1 同款：不执行破坏性动作）。
 */
async function hostConfirm(text, title) {
    const msg = String(text || '');
    try {
        // ① 酒馆自身的确认弹窗（**页面内 UI**，不经过宿主 ACL；返回 1=确认 / 0=取消 / null=关闭）
        const ctx = getCtx();
        if (ctx && typeof ctx.callGenericPopup === 'function') {
            const r = await ctx.callGenericPopup(msg, 2, String(title || '') || null);   // POPUP_TYPE.CONFIRM === 2
            return !!r;
        }
    } catch (e) { /* 落到下一方案 */ }
    // ② 原生 confirm —— **只在返回同步布尔时采信**：
    //   部分宿主（如 TauriTavern）把 `window.confirm` 桥接成宿主命令 `plugin:dialog|confirm`，
    //   未授权时以 ACL 拒绝 → 既不能当成「已确认」（危险），也不能让它成为**未处理的 Promise 拒绝**
    //   （用户报告的那条错误正是如此）。故：Tauri 环境直接跳过；thenable 一律不采信并吞掉拒绝。
    try {
        const w = globalThis;
        if (w && (w.__TAURI__ || w.__TAURI_INTERNALS__)) return false;
        if (!w || typeof w.confirm !== 'function') return false;
        const r = w.confirm(msg);
        // 桥接型（返回 Promise）：**await 其真实结果**（拒绝/ACL 失败 → 取消），绝不当成「已确认」，
        //   也不留未处理的 Promise 拒绝（用户报告的那条 ACL 错误正是如此）
        if (r && typeof r.then === 'function') { try { return !!(await r); } catch (e) { return false; } }
        return !!r;
    } catch (e) { return false; }
}

/**
 * 确保有一个可见入口：先按 `cfg.buttonLocations` 同步全部自建入口（主入口=扩展菜单，强制开启）；
 * 抽屉面板挂上 → 移除「兜底」悬浮按钮；挂不上 → 安装兜底悬浮按钮（点击弹窗打开面板）。
 * @returns {Promise<{panel:object, floating:object, entries:object}>}
 */
export async function ensureVisibleEntry() {
    let panel = { ok: false, reason: '' };
    try { panel = await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot() }); } catch (e) { panel = { ok: false, reason: String((e && e.message) || e) }; }
    const entries = syncEntriesNow();
    let floating = { ok: false, reason: '' };
    if (panel.ok) {
        dropFallbackFloat();
        floating = { ok: entryEnabled('float', cfgRef.buttonLocations), reason: '面板已挂载（悬浮按钮按设置保留；兜底入口已移除）' };
    } else {
        try { floating = installFloatingEntry(entryClickHooks(), { reason: 'fallback' }); } catch (e) { floating = { ok: false, reason: String((e && e.message) || e) }; }
    }
    return { panel, floating, entries };
}

/**
 * 强制挂载设置面板并确保菜单入口存在（供 `/ftt-panel`、魔杖菜单与可见性探针使用）。
 * @returns {Promise<object>} { ok, via, container, reason, menu }
 */
export async function forceMountPanel() {
    let mount = { ok: false, via: 'none', reason: '' };
    try { mount = await mountSettingsPanel({ hooks: panelHooks(), status: panelStatusSnapshot(), force: true }); }
    catch (e) { mount = { ok: false, via: 'error', reason: String((e && e.message) || e) }; }
    // v2.65.0：入口按设置同步（扩展菜单项强制开启，忽略配置里的关闭意图）
    const entries = syncEntriesNow();
    const menu = (entries.applied && entries.applied.menu) ? entries.applied.menu : { ok: false, reason: '未安装' };
    // 挂不上抽屉 → 至少给一个悬浮入口（点击以弹窗展示面板）
    let floating = { ok: false, reason: '' };
    try {
        if (mount.ok) floating = { ok: entryEnabled('float', cfgRef.buttonLocations), reason: '面板已挂载' };
        else floating = installFloatingEntry(entryClickHooks(), { reason: 'fallback' });
    } catch (e) { floating = { ok: false, reason: String((e && e.message) || e) }; }
    runtime.bootstrap.lastError = mount.ok ? '' : String(mount.reason || '');
    return Object.assign({}, mount, { menu, floating, entries, info: panelMountInfo(), menuInfo: menuInfo(), floatingInfo: floatingInfo() });
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
/**
 * v2.74.0（用户要求）：「提取记忆应该**不占用管道**…确保**并行处理**，而且在用户请求发送前提取好记忆，
 *   按照开关约定注入提示词信息。」
 *   · 本入口 = **发送前召回**（三层：向量 → JS 抽取 → AI 分析；零 AI 的前两层为主），
 *     **不设置也不检查** AI 摘要的忙碌位（`extractState.busy`）——因此可以与「⚡ 立即 AI 摘要」等长任务**并行**；
 *   · 长任务在途时自动**跳过 AI 层**（不与在途任务抢 AI 通道），向量/JS 层照常；
 *   · 结果按开关注入提示词（`injectCurrentPrompt` / `timelyAnalysis` 闸门 + 各层开关），发送前由拦截器再刷一次。
 * @param {object} [opts] queryText / floorText / layers / allowAiDuringBusy
 * @returns {Promise<{ok:boolean, reason?:string, hitLayer:string, count:number, chars:number, injected:boolean, ms:number, busy:boolean}>}
 */
export async function runRecallNow(opts) {
    const o = opts || {};
    const busy = (() => { try { return !!extractBusy(); } catch (e) { return false; } })();
    const r = await pushMemoryInject(o);
    try { runtime.inject = pushStats(); } catch (e) { /* 忽略 */ }
    return Object.assign({ busy: busy }, r);
}

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
export { menuInfo, installMenuEntry, ensureMenuEntry, uninstallMenuEntry, unbindMenuWatch } from './ui/menu.js';
export { floatingInfo, installFloatingEntry, uninstallFloatingEntry } from './ui/floating.js';
// v2.65.0：入口按钮（顶栏 / 页面底部 / 悬浮 / 扩展菜单）统一启停与诊断
export { syncEntryButtons, entryButtonsState, uninstallAllEntries, entryEnabled, normalizeEntryLocations, ENTRY_LOCATIONS, ENTRY_LABELS, FORCED_ENTRIES } from './ui/entries.js';
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

/** 待分析楼层清单（命令与调试）；`{detail:true}` → 返回扫描明细（跳过计数 / 覆盖数 / 扫描区间） */
export function pendingFloors(opts) {
    const o = opts || {};
    if (o.detail === true) return pendingScan(o);
    return listUnprocessedFloors(o);
}

/** 待分析扫描明细（核对「未摘要楼层跳过机制」用：哪些楼被跳过、为什么） */
export function pendingScan(opts) { try { return scanPendingFloors(opts || {}); } catch (e) { return { floors: [], error: String((e && e.message) || e) }; } }

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
    setRepairHooks({
        floorHash: (i) => { try { return hashFloorText(i); } catch (e) { return ''; } },
        // v3.5.0（用户要求）：自动修复的两个追加步骤 ——
        //   ① 楼层突变识别与修正（最新情节楼层 − 当前末楼 ≥ 9 → 按内容哈希修正已处理记录；只改编号不删条目）
        //   ② 计划/悬念修复（**与「设定 → 计划悬念 → 🔧 修复计划/悬念」同一条处理**，静默调用）
        floorJump: () => fixFloorJump(),
        planSuspRepair: (opts) => runPlanSuspRepair(Object.assign({ silent: true }, opts || {})),
        //   ③ v3.6.0（用户要求）：按**最新情节**（内置天数判断）刷新时间 / 地点 / 人物 —— 与 v2.81.0
        //      「分析后按最新情节同步剧情时钟」同一条处理（`clockAutoExtractOnce({force:true})`，零 AI）
        clockSync: () => {
            let changed = false;
            try { changed = clockAutoExtractOnce({ force: true }) === true; } catch (e) { changed = false; }
            const res = (() => { try { return clockExtractState(); } catch (e) { return null; } })();
            const st = (kernelState && kernelState.state) || {};   // `state` 在本文件里以 `kernelState` 别名导入
            const src = (st && st.clockSrc) || {};
            return {
                changed: changed,
                date: String(st.date || ''), time: String(st.time || ''), location: String(st.location || ''),
                present: Array.isArray(st.present) ? st.present.slice() : [],
                storyDay: Number(st.storyDay) || 0,
                // v3.6.0：被选中那条**情节自身**记录的天数（`storyDay` 预留计数器；时钟的 `state.state.storyDay` 只在
                //   正文头结构被采用时才写）—— 报告里优先用它显示「第 N 天」，便于用户核对「按天数取到的是哪条」
                plotStoryDay: (() => {
                    try {
                        const id = String((res && res.plotId) || '');
                        if (!id) return 0;
                        const node = (kernelState.atoms || []).find((x) => x && String(x.id) === id);
                        return Number(node && node.storyDay) || 0;
                    } catch (e) { return 0; }
                })(),
                manual: !!(res && res.manual), manualLock: !!(src && src.manualLock),
                source: (res && res.source) || {}, plotId: String((res && res.plotId) || ''),
            };
        },
    });
    // v2.58.0：向量层接线（三层流程 + 最近楼层正文 + 剧情日期）—— 向量/rerank 请求在 host/embeddings.js
    setInjectRuntime({ extractFlow: (text, opts) => runExtractFlow(text, opts) });
    setInjectRuntime({
        recentFloorText: () => {
            try {
                const last = Number((getCtx() && typeof getCtx().getLastMessageId === 'function') ? getCtx().getLastMessageId() : -1);
                if (!Number.isFinite(last) || last < 0) return '';
                const n = Math.max(1, Number(cfgRef.feedFloors) || 2);
                return collectFloorLinesInRange(Math.max(0, last - n + 1), last).join('\n');
            } catch (e) { return ''; }
        },
    });
    setAiRecallHooks({ getStoryNow: () => { try { return getStoryNow(); } catch (e) { return ''; } } });
    // B8-7-b：平行事件取文钩子（V1 `collectFloorLinesInRange(start, end, {})`；内核不直读宿主聊天）
    setParallelTextHooks({
        floorLinesInRange: (start, end) => { try { return collectFloorLinesInRange(Number(start) || 0, Number(end) || 0); } catch (e) { return []; } },
    });
    // v2.95.0 修复（用户报告「管线状态的倒计时 / 流文字展示都没生效」）：
    //   ① 历史读写的接线此前**只在打开面板时**发生（`openPanelPopup`）→ 未开过面板就永远读不到/写不进样本；
    //   ② `pipelineEta` 一度不在 `DEFAULT_SETTINGS`（v2.94.0 已修），落盘静默失败。现在与其它内核钩子同批装配。
    wirePipelineHooks();
    // v3.19.0：NSFW 词条分析账本钩子（设定页状态行要在装配期就能读到「上次分析」）
    wireNsfwAnalyzeHooks();
    // B8-3：时钟域 AI 管线钩子（AI 调用走 ST generateRaw；投喂文本走 host/floors；长任务在途即拒绝）
    setClockAiHooks({
        callAi: async (messages, opts) => {
            try {
                // v2.35.0：按 V1 调用标签判定用途（'[平行事件·…]' → parallel；其余 → main），
                //   再解析出该用途的 API target（V1 `resolveApiFor` 家族等价物）。未配置任何通道时
                //   target.channel === 'host'，行为与 v2.34.0 **完全一致**。
                const label = opts && opts.label;
                const target = resolveApiTarget({ purpose: purposeOfLabel(label) });
                const r = await rawGenerate(Object.assign(promptToGenerateArgs(messages), { target }));
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
        // v3.24.0（用户要求「进一步优化UI设计、优化通知效果等」）：**统一走 `ui/notify.js#showToast`**
        //   —— 改动前这里只把 kind 压成 4 类宿主方法、且不传任何选项，导致：
        //     ① `style.css` 早已写好的 8 类行为配色类（`ftt-toastr--weave/--sync/--repair/--analysis…`）
        //        **从未被挂上**（死 CSS，所有通知长得一样）；
        //     ② `escapeHtml` 未开（正文里的 `<...>` 被当 HTML 渲染）；无去重（同文案连发刷屏）；
        //        无长度上限；错误与普通提示停留时间相同（来不及看清失败原因）。
        //   现在（口径详见 `ui/notify.js` 头注）：kind 全量归一 → 配色类 + 转义 + 去重 + 分级停留 + 截断。
        //   面板 `hooks.notify` 与删楼 `floorTrim.notify` 也最终经过此处，故三处入口一次收口。
        toast: (text, kind) => { try { return showToast(globalThis.toastr, kind, text) === true; } catch (e) { return false; } },
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
    try { unbindExitFlush(); } catch (e) { /* noop */ }
    runtime.bind = { bound: [], missing: [] };
    try { clearInject(); } catch (e) { /* noop */ }
    try { unmountSettingsPanel(); } catch (e) { /* noop */ }
    try { unmountPanel(); } catch (e) { /* noop */ }
    try { uninstallGlobalInterceptor(); } catch (e) { /* noop */ }
    try { stopReadyProbe(); } catch (e) { /* noop */ }
    try { uninstallAllEntries(); } catch (e) { /* noop */ }
    try { closePanel(); } catch (e) { /* noop */ }
    try { uninstallErrorCapture(); } catch (e) { /* noop */ }
    try { uninstallDevtools(); } catch (e) { /* noop */ }
    try { resetSyncState(); } catch (e) { /* noop */ }
    try { cancelForgetTimers(); } catch (e) { /* noop */ }
    try { cancelRepairTimers(); } catch (e) { /* noop */ }
    try { cancelStartupUpdateDelay(); } catch (e) { /* noop */ }   // v2.46.0：撤销待执行的启动更新检查
    try { cancelScopeReload(); } catch (e) { /* noop */ }   // v3.0.23：撤销待执行的作用域延迟重载
    try { setLoadPhase('idle'); } catch (e) { /* noop */ }   // v3.14.0：卸载即解除载入闸门（避免把「读取中」留在下一次装配）
    try { resetVectorCacheState(); } catch (e) { /* noop */ }   // v3.1.0：清空向量缓存内存副本（docs/D13 R2）
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

/**
 * v3.0.18（用户报告「重开应用后存档丢失」）——**退出/切后台前落一次盘**。
 *
 * 背景：保存是 **800ms 防抖**（`scheduleSave`）+ 落盘后镜像 3s 防抖；若用户在这段窗口内
 *   关闭/刷新页面或把应用切到后台被系统杀掉，那段「只差几百毫秒就写下去」的改动就丢了。
 * 做法：`visibilitychange`（hidden）/`pagehide`/`beforeunload` 各触发一次**立即落盘**
 *   （`flushStateNow` → 同步写本机缓冲 + 服务端文件；无变化时按内容签名短路，不浪费流量）。
 *   只看不改数据、失败静默；`teardown()` 解绑。
 */
const exitFlushOffs = [];
function bindExitFlush() {
    try {
        const doc = globalThis.document;
        const win = globalThis.window;
        // 退出/切后台是**最后一次**写主文件的机会 → 强制完整落盘（`force` 绕开「无变化短路」）
        const fire = (why) => { try { void flushStateNow(why, { force: true }); } catch (e) { /* 忽略 */ } };
        if (doc && typeof doc.addEventListener === 'function') {
            const onVis = () => { try { if (doc.visibilityState === 'hidden') fire('应用切到后台'); } catch (e) { /* 忽略 */ } };
            doc.addEventListener('visibilitychange', onVis);
            exitFlushOffs.push(() => { try { doc.removeEventListener('visibilitychange', onVis); } catch (e) { /* noop */ } });
        }
        if (win && typeof win.addEventListener === 'function') {
            const onHide = () => fire('应用关闭/离开页面');
            win.addEventListener('pagehide', onHide);
            exitFlushOffs.push(() => { try { win.removeEventListener('pagehide', onHide); } catch (e) { /* noop */ } });
            win.addEventListener('beforeunload', onHide);
            exitFlushOffs.push(() => { try { win.removeEventListener('beforeunload', onHide); } catch (e) { /* noop */ } });
        }
        return exitFlushOffs.length > 0;
    } catch (e) { return false; }
}
function unbindExitFlush() { while (exitFlushOffs.length) { try { exitFlushOffs.pop()(); } catch (e) { /* noop */ } } }

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
try { bindExitFlush(); } catch (e) { /* 忽略：不影响启动 */ }

// 3) 可见性探针：多触发 + 有限轮询 —— 宿主事件缺失/时机不符时仍会装配并挂载面板
bindDocumentReady();
try { setPopupHooks(popupHooks()); syncEntryButtons(cfgRef.buttonLocations || {}, entryClickHooks()); } catch (e) { /* 忽略 */ }
startReadyProbe();

// ---------------- 测试与自检用导出 ----------------
export const __internals = {
    VERSION, DATA_VERSION, MODULE_NAME,
    init, ensureReady, teardown, runtimeState, extraForStatus,
    forceMountPanel, panelMountInfo, menuInfo, floatingInfo, openPanelPopup, ensureVisibleEntry,
    popupInfo, popupAction, popupTabs, panelInfo, panelTabs, injectNow,
    runSummaryBatch, abortExtraction, clearProcessedFloors, exportStateJson, importStateJson, debugDumpSnapshot, panelRuntimeHooks,
    startReadyProbe, stopReadyProbe,
    eventTypeAvailability, interceptorStats, resetInterceptorStats, injectAvailable,
    startupUpdateCheck, checkUpdateNow, cancelStartupUpdateDelay,
};
