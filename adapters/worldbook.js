// ============================================================
// adapters/worldbook.js —— **世界书单向镜像：保存流水线接线（适配层）**
//   （B8-7，移植 V1 `src/modules/05-记忆状态与存储抽象.js#scheduleWorldbookSync`：
//     8s 防抖 + `wbLastSyncedAt` 去重 + 失败告警）
//
// V1 调用点：① `storageWriteAll()` 末尾「原子数据落主存储后延迟推送词条」；② 启动跨端对账完成后。
// V2 接线：`adapters/store.js#saveStateNow()` 第 ⑧ 步调用 `scheduleWorldbookSync()`
//   （`cfg.storage.worldbook === false` → **零行为**：不排定时器、不触任何宿主 API）。
//
// 适配（与 V1 的差异，逐条见 docs/P8y-B8-7世界书单向镜像.md）：
//   ① 延迟调度改经 `timerHooks`（V1 用全局 `setTimeout`）—— 宿主未注入时默认 no-op（测试/无宿主环境不后台跑）；
//   ② 异步写入由 `void` 触发（V1 的 timer 回调本身即 async）；成功/失败结论记录在 `worldbookSyncState()`；
//   ③ V1 的 `dbgLog('对账', {...})` 日志字段逐字保留（`entries` 取 `worldbookMemoryTotal()`）；
//   ④ V2 增设 `worldbookSyncState()` / `worldbookResetSync()` 两个**只读观测/复位**出口
//      （V1 的 `wbSyncTimer` / `wbLastSyncedAt` 是模块内私有变量，无法观测）—— 不改变写入语义。
// ============================================================
import { cfg, state, timerHooks, warn, dbgLog } from '../core/model/runtime.js';
import { storageEnvelope } from '../core/envelope.js';
import { worldbookMemoryTotal } from '../core/worldbook.js';
import { worldbookProvider } from '../host/worldbook.js';

/** V1 常量：原子数据调整后合并触发的延迟（避免频繁全量重建词条） */
const WORLDBOOK_SYNC_DELAY = 8000;

let wbSyncTimer = null;
let wbLastSyncedAt = 0;
let wbLastResult = { at: 0, ok: false, reason: '' };

/** 世界书存储是否开启（V1 `cfg.storage.worldbook`） */
function worldbookSyncEnabled() {
    try { return !!(cfg && cfg.storage && cfg.storage.worldbook); } catch (e) { return false; }
}

/**
 * 调度一次世界书同步（V1 `scheduleWorldbookSync`，逐字语义）：
 *   ① 未开启 → 直接返回（零行为）；② 已有在途定时器 → 不重复排（8s 防抖合并）；
 *   ③ 回调内比对 `env.payload.updatedAt ≤ wbLastSyncedAt` → 数据未变则跳过；写入失败 → 告警（下次数据变更再试）。
 * @returns {boolean} 是否已（或已有）在途调度
 */
function scheduleWorldbookSync() {
    try {
        if (!worldbookSyncEnabled()) return false;
        if (wbSyncTimer) return true;
        wbSyncTimer = timerHooks.set(() => { void worldbookSyncFlush(); }, WORLDBOOK_SYNC_DELAY);
        return true;
    } catch (e) { return false; }
}

/** 执行一次同步（V1 `setTimeout` 回调体，逐字） */
async function worldbookSyncFlush() {
    wbSyncTimer = null;
    try {
        const env = storageEnvelope(state);
        if (wbLastSyncedAt && env.payload.updatedAt <= wbLastSyncedAt) return { skipped: 'unchanged' };   // 数据未变，跳过
        const ok = await worldbookProvider.write(env);
        if (ok) {
            wbLastSyncedAt = env.payload.updatedAt;
            const d = (env && env.payload && env.payload.data) || {};
            // 世界书同步完成 —— 记录词条体量与来源数据条目数（单向灌输实际内容）
            dbgLog('对账', { action: '世界书同步完成', wb: (cfg.storage && cfg.storage.worldbookName) || '', updatedAt: env.payload.updatedAt, bytes: JSON.stringify(env || {}).length, entries: worldbookMemoryTotal(), dims: { atoms: (d.atoms || []).length, memories: (d.memories || []).length, plans: (d.plans || []).length, suspense: (d.suspense || []).length } });
            wbLastResult = { at: Date.now(), ok: true, reason: '' };
            return { ok: true };
        }
        warn('存储[世界书]同步失败（将在下次数据变更时重试）');
        wbLastResult = { at: Date.now(), ok: false, reason: 'write-failed' };
        return { ok: false };
    } catch (e) {
        warn('世界书同步异常', e);
        wbLastResult = { at: Date.now(), ok: false, reason: String((e && e.message) || e) };
        return { ok: false, reason: 'exception' };
    }
}

/**
 * 立即同步（不经 8s 防抖）—— 供「面板动作 / 手动刷新」接线时调用；本批**未接线**。
 * 与 V1 一致地遵守 `cfg.storage.worldbook` 闸门与 `updatedAt` 去重。
 */
async function worldbookSyncNow() {
    if (!worldbookSyncEnabled()) return { skipped: 'disabled' };
    return worldbookSyncFlush();
}

/** 同步状态（只读观测；V2 新增，便于调试页/面板接线时展示） */
function worldbookSyncState() {
    return {
        enabled: worldbookSyncEnabled(),
        pending: !!wbSyncTimer,
        lastSyncedAt: wbLastSyncedAt,
        last: Object.assign({}, wbLastResult),
        name: (cfg && cfg.storage && cfg.storage.worldbookName) || '',
        delayMs: WORLDBOOK_SYNC_DELAY,
    };
}

/** 复位调度内部态（角色切换 / 宿主重启 / 用例隔离用；V2 新增，不改变写入语义） */
function worldbookResetSync() {
    try { if (wbSyncTimer && typeof timerHooks.clear === 'function') timerHooks.clear(wbSyncTimer); } catch (e) { /* 忽略 */ }
    wbSyncTimer = null;
    wbLastSyncedAt = 0;
    wbLastResult = { at: 0, ok: false, reason: '' };
    return true;
}

export {
    WORLDBOOK_SYNC_DELAY,
    scheduleWorldbookSync, worldbookSyncFlush, worldbookSyncNow, worldbookSyncState,
    worldbookSyncEnabled, worldbookResetSync,
};
