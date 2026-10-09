// ============================================================
// core/debug-log.js —— **调试日志环形缓冲**（B9 前置；逐字移植自 V1 `src/modules/01-核心状态与存储.js` v1.49）
//
// 定位：V1 的调试日志（供「设定 → 调试」页查看 + `dbgClear` 清空）是内存里的**最新在前环形缓冲**
//   （`{at, kind, data}`，上限 `DEBUG_CAP=300`，`data` 为字符串或 JSON 截断 6000 字），并持久化到 localStorage
//   （键 `SPreset_FTTMemoryDebug`），持久化时与既有存储**按 `at|kind` 去重后按时间降序截断**。
//
// V2 适配（逐条）：
//   ① 内核纯净度：`localStorage` / `window` 属宿主能力 → 本模块**只做纯内存环形缓冲**，持久化经
//      `setDebugLogHooks({ load, save })` 注入（`adapters/debug-log.js` 接 localStorage；未注入则纯内存，等价 V1 无 localStorage 环境）；
//   ② 日志开关沿用 `cfg.debugEnabled !== false`（V1 同键：关闭则不记录）；
//   ③ `data` 归一（字符串原样 / 其它 `JSON.stringify` 截断 6000）与 `at` 取值（`Date.now()`）与 V1 一致；
//   ④ 合并语义（`debugLogMerge`）保留 V1 v1.49 的修复口径：以内存为基准，仅补入存储中**内存没有**的条目，
//      再统一按时间降序截断到 `DEBUG_CAP`（避免旧存储倒灌打乱「最新在前/环形挤出」）。
// ============================================================
import { cfg } from './model/runtime.js';

/** V1 `DEBUG_CAP`：环形缓冲上限 */
const DEBUG_CAP = 300;
/** V1 `DEBUG_KEY`：localStorage 键（由宿主适配层使用） */
const DEBUG_KEY = 'SPreset_FTTMemoryDebug';
/** V1：单条 `data` 序列化后截断长度 */
// v3.1.0（`docs/D13` R1/Q6）：单条上限 6000 → **2000** 字符。
//   理由：300 条 × 6000 = **1.8M 字符**本身就吃掉本机缓冲配额（5MB UTF-16 ≈ 2.62M 字符）的大半，
//   与状态信封叠加必然越界 → 本机缓冲静默停更。降到 2000 后上限 0.6M 字符，排障所需的关键字段
//   （动作 / 目标 / 耗时 / 原因）都在前 2000 字符内，长正文截断不影响定位问题。
const DEBUG_DATA_MAX = 2000;

/** 内存环形缓冲（**最新在前**，与 V1 v1.49 语义一致） */
let debugLogs = [];
/** 宿主持久化钩子（内核默认 no-op） */
let hooks = { load: () => [], save: () => undefined };

/** 注入宿主持久化钩子（`load` 返回历史条目数组；`save` 落盘当前全量） */
function setDebugLogHooks(next) {
    hooks = Object.assign({ load: () => [], save: () => undefined }, hooks, next || {});
    return hooks;
}

/** 归一单条日志（V1：字符串原样，其余 JSON 截断 6000；`at`/`kind` 与 V1 同形） */
function debugLogNormalize(kind, data, at) {
    const t = Number(at);
    return {
        at: Number.isFinite(t) && t > 0 ? t : Date.now(),
        kind: String(kind == null ? '' : kind),
        data: (typeof data === 'string') ? data : (() => { try { return JSON.stringify(data).slice(0, DEBUG_DATA_MAX); } catch (e) { return ''; } })(),
    };
}

/** 合并两批日志（V1 `dbgPersist` 口径）：以 `base` 为基准，补入 `extra` 中 `at|kind` 未出现者，按时间降序截断 */
function debugLogMerge(base, extra) {
    const seen = new Set((base || []).map((l) => `${l && l.at}|${l && l.kind}`));
    const add = (extra || []).filter((l) => l && !seen.has(`${l.at}|${l.kind}`));
    const merged = (base || []).concat(add).slice().sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));
    return merged.slice(0, DEBUG_CAP);
}

/** 记录一条调试日志（V1 `dbgLog`；`cfg.debugEnabled === false` 时直接丢弃） */
function debugLogPush(kind, data) {
    try {
        if (cfg && cfg.debugEnabled === false) return false;
        debugLogs.unshift(debugLogNormalize(kind, data));
        if (debugLogs.length > DEBUG_CAP) debugLogs = debugLogs.slice(0, DEBUG_CAP);
        try { hooks.save(debugLogs.slice()); } catch (e) { /* 落盘失败不影响内存态 */ }
        return true;
    } catch (e) { return false; }
}

// ============================================================
// v3.40.0（`docs/D16` L11）：**合并式记录** —— 高频「成功」日志不再刷屏。
//
// 真机取证：300 条环里「存储」占 248（83%），最近 200 条只有 3 种动作、其中 **166 条是同一句**
//   「本地磁盘目录：写入并回读校验通过」→ 摘要 / 异常 / 同步类诊断被挤出（与 v3.10.4 修过的
//   「读取占 69%」同族，这次换成了存储）。口径：**同一个 key 在窗口内的重复成功，原地升级为
//   「计数 + 最近时刻 + 累计字节」**，只占一条；失败类日志仍逐条（不许合并，避免掩盖问题）。
// ============================================================
/** key → { at, row }（`row` 是环形缓冲里的**同一个对象**，原地改写即可） */
let coalesceRefs = Object.create(null);
/** 默认合并窗口（毫秒） */
const COALESCE_WINDOW_MS = 5000;

/**
 * 合并式记录：同一 `key` 在 `windowMs` 内重复调用 → 把已有那条升级为 `{n, lastAt, bytes}`
 * @param {string} kind 分类（与 `debugLogPush` 同）
 * @param {string} key 合并键（**同一件事**才用同一个键，例如 `local-disk-write|tt-native`）
 * @param {object} data 载荷（可带 `bytes` / `count`）
 * @param {{windowMs?:number, force?:boolean}} [opts] `force` = 不合并，直接新记一条
 * @returns {boolean} 是否记录成功
 */
function debugLogPushCoalesced(kind, key, data, opts) {
    const o = opts || {};
    try {
        if (cfg && cfg.debugEnabled === false) return false;
        const k = String(key == null ? '' : key);
        const win = Number.isFinite(Number(o.windowMs)) ? Math.max(0, Number(o.windowMs)) : COALESCE_WINDOW_MS;
        const now = Date.now();
        const ref = k ? coalesceRefs[k] : null;
        if (o.force !== true && win > 0 && ref && (now - Number(ref.at || 0)) <= win && debugLogs.indexOf(ref.row) >= 0) {
            const row = ref.row;
            let obj = null;
            try { obj = JSON.parse(row.data); } catch (e) { obj = null; }
            if (obj && typeof obj === 'object') {
                const add = Math.max(1, Number((data && data.count) || 1));
                obj.n = Math.max(1, Number(obj.n || 1)) + add;
                obj.lastAt = now;
                if (data && data.bytes != null) obj.bytes = Number(obj.bytes || 0) + Number(data.bytes || 0);
                try { row.data = JSON.stringify(obj).slice(0, DEBUG_DATA_MAX); } catch (e) { /* 忽略 */ }
                row.at = now;                       // 合并后按「最近一次」排序（仍是最新在前）
                ref.at = now;
                try { hooks.save(debugLogs.slice()); } catch (e) { /* 忽略 */ }
                return true;
            }
        }
        const row = debugLogNormalize(kind, data);
        debugLogs.unshift(row);
        if (debugLogs.length > DEBUG_CAP) debugLogs = debugLogs.slice(0, DEBUG_CAP);
        if (k) coalesceRefs[k] = { at: now, row: row };
        // 合并表不无限增长（键由调用点固定，正常只有几个；异常情况下按时间淘汰）
        const ks = Object.keys(coalesceRefs);
        if (ks.length > 64) {
            ks.sort((a, b) => Number(coalesceRefs[a].at || 0) - Number(coalesceRefs[b].at || 0));
            for (const k2 of ks.slice(0, ks.length - 64)) delete coalesceRefs[k2];
        }
        try { hooks.save(debugLogs.slice()); } catch (e) { /* 忽略 */ }
        return true;
    } catch (e) { return false; }
}

/** 取日志（最新在前；内存为空时尝试从宿主加载一次 —— V1 `dbgGet`） */
function debugLogList() {
    try {
        if (!debugLogs.length) {
            const loaded = hooks.load();
            if (Array.isArray(loaded) && loaded.length) debugLogs = debugLogMerge(loaded, []).slice(0, DEBUG_CAP);
        }
        return debugLogs.slice(0, DEBUG_CAP);
    } catch (e) { return debugLogs.slice(0, DEBUG_CAP); }
}

/** 清空调试日志（V1 `dbgClear`：清内存 + 清宿主持久层） */
function debugLogClear() {
    const n = debugLogs.length;
    debugLogs = [];
    coalesceRefs = Object.create(null);   // v3.40.0：合并引用表一并清（否则下次会去改写已不存在的条目）
    try { hooks.save([]); } catch (e) { /* 忽略 */ }
    return n;
}

/** 与宿主持久层对账合并（V1 `dbgLoadFromStorage` + `dbgPersist` 的组合口径；供启动/刷新时调用） */
function debugLogSync() {
    try {
        const stored = hooks.load();
        debugLogs = debugLogMerge(debugLogs, Array.isArray(stored) ? stored : []);
        try { hooks.save(debugLogs.slice()); } catch (e) { /* 忽略 */ }
        return debugLogs.length;
    } catch (e) { return debugLogs.length; }
}

/**
 * 异常日志（`host` 侧全局错误钩子写入 `kind='异常'`；调试页/FTT 自证用）
 * @param {number} [limit] 最多返回条数（默认全部，最新在前）
 */
function debugLogErrors(limit) {
    try {
        const list = debugLogList().filter((l) => String((l && l.kind) || '') === '异常');
        const n = Number(limit);
        return Number.isFinite(n) && n > 0 ? list.slice(0, n) : list;
    } catch (e) { return []; }
}
/** 异常计数 */
function debugLogErrorCount() { return debugLogErrors().length; }
/** 最近一条异常（无则 null） */
function debugLogLastError() { return debugLogErrors(1)[0] || null; }

/** 统计（调试页只读行用） */
function debugLogStats() {
    const list = debugLogList();
    const kinds = {};
    list.forEach((l) => { const k = String((l && l.kind) || ''); kinds[k] = (kinds[k] || 0) + 1; });
    return { n: list.length, cap: DEBUG_CAP, kinds, newestAt: Number((list[0] && list[0].at) || 0) };
}

export {
    DEBUG_CAP, DEBUG_KEY, DEBUG_DATA_MAX,
    setDebugLogHooks, debugLogPush, debugLogPushCoalesced, debugLogList, debugLogClear, debugLogSync, debugLogStats, debugLogMerge, debugLogNormalize,
    debugLogErrors, debugLogErrorCount, debugLogLastError,
};
