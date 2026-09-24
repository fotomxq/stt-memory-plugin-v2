// ============================================================
// adapters/debug-log.js —— **调试日志的宿主持久化适配**（B9 前置）
//   把 `core/debug-log.js` 的纯内存环形缓冲接到 `localStorage`（V1 `DEBUG_KEY = 'SPreset_FTTMemoryDebug'`）
//   与内核的 `chatHooks.dbgLog` 上；无 localStorage（Node 测试/受限宿主）时自动退化为纯内存。
//   V1 口径：数组 JSON、最多 300 条、最新在前；读取时容忍损坏（解析失败 → 视为空）。
// ============================================================
import { DEBUG_KEY } from '../core/debug-log.js';
import { setDebugLogHooks, debugLogPush, debugLogList, debugLogClear, debugLogSync, debugLogStats } from '../core/debug-log.js';

const DATA_MAX = 6000;

/** localStorage 可用性（V1 同款判断：`window.localStorage` 存在即可） */
function ls() {
    try {
        const w = globalThis.window;
        return (w && w.localStorage) ? w.localStorage : null;
    } catch (e) { return null; }
}

/** 读取持久层（损坏/缺省 → 空数组；条目做最小归一） */
function debugLogLoad() {
    try {
        const s = ls();
        if (!s) return [];
        const raw = s.getItem(DEBUG_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter((l) => l && typeof l === 'object').map((l) => ({
            at: Number(l.at) || 0,
            kind: String(l.kind == null ? '' : l.kind),
            data: (typeof l.data === 'string') ? l.data.slice(0, DATA_MAX) : '',
        }));
    } catch (e) { return []; }
}

/** 写入持久层（失败静默 —— V1 `dbgPersist` 亦为 try/catch 包裹） */
function debugLogSave(list) {
    try {
        const s = ls();
        if (!s) return false;
        s.setItem(DEBUG_KEY, JSON.stringify(Array.isArray(list) ? list : []));
        return true;
    } catch (e) { return false; }
}

/** 接线（幂等）：内核环形缓冲 ⇄ localStorage；返回是否具备持久层 */
function wireDebugLog() {
    setDebugLogHooks({ load: debugLogLoad, save: debugLogSave });
    const synced = debugLogSync();
    return { persistent: !!ls(), synced };
}

export {
    DEBUG_KEY, debugLogLoad, debugLogSave, wireDebugLog,
    debugLogPush, debugLogList, debugLogClear, debugLogSync, debugLogStats,
};
