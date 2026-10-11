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
import { cfg, dbgLog } from './model/runtime.js';
// v3.45.4（`docs/D22` W10 `技-41` ①）：**kind 枚举表的单一事实源**（`docs/D31` §3.2 / §3.8「枚举化」）——
//   本模块只**消费**它（登记判定 + 注入「未登记」读取器），绝不反向被它依赖（否则成环）。
import { debugKindRegistered, setUnregisteredKindReader } from './debug-catalog.js';

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

// ============================================================
// v3.45.4（`docs/D22` W10 `技-41` ①/④）：**kind 登记制**（`docs/D31` §3.2 统一命名 / §3.8「枚举化」）
//
// 口径：业务日志的 `kind` 由 `core/debug-catalog.js#DEBUG_KINDS` **冻结为枚举**，新增需登记。
//   **但绝不因为「未登记」就把日志丢掉** —— 排障最忌讳「有事件、日志里却查不到」：
//   丢日志等于把 `技-41` 要治的「口径漂移」换成了更严重的**信息缺失**（且是静默的）。
//   所以未登记 kind 走三步：① **照记**（本缓冲行为逐字不变）；② **计数**（`debugLogStats().unregistered`
//   与 `debugUnregisteredKinds()` 可读）；③ **一次性提示**（同一个 kind 只提示一次，避免刷屏）。
//
// 为什么提示走 `core/model/runtime.js#dbgLog`，而不是自己往环形缓冲里塞一条：
//   ① 本环形缓冲是**业务日志流** —— 自塞一条非业务条目会污染既有口径（300 条环的逐字黄金比对、
//      缓冲页 `debugLogStats()` 的逐类别计数都会多出一类）；
//   ② `runtime#dbgLog` 正是**宿主接线后的既有出口**（`host/chat.js` 把它接回本函数）：
//      真机上提示会作为 `kind='调试'` 的一条**真的进环**，而纯内核 / 未接线时自然静默 ——
//      既满足「写一条 `dbgLog('调试', …)` 提示」，又让内核保持零宿主依赖；
//   ③ 提示**先于**业务条目入环：`unshift` 在提示之后，所以 `debugLogList()[0]` 永远是业务条目自己。
//
// 读取器的**依赖倒置**：`core/debug-catalog.js` 不能反向 import 本模块（会成环），
//   因此由本模块在装载时把读取器**注入**给它（`setUnregisteredKindReader`）。
// ============================================================
/** 未登记 kind 的登记表：kind → { kind, count, firstAt, lastAt, notified } */
let unregistered = new Map();
/** 重入保护：提示本身若被接回本函数，绝不能再触发一次提示（否则递归） */
let inKindNotice = false;

/**
 * 记一次「未登记 kind」：计数 + 一次性提示（绝不抛错；返回是否命中未登记）。
 * @param {string} kind 分类
 * @param {number} at **复用业务条目已经取到的时刻** —— 本函数**绝不自己读时钟**，三个理由：
 *   ① 观测设施不该有额外开销（少一次时钟读取）；
 *   ② 与本条日志的 `at` 同值，事后能把「哪条日志踩了未登记 kind」一一对上；
 *   ③ **关键**：`tests/unit/debug-log-golden.test.js` 用「固定基准 + 每次调用 +1ms」的**确定性时钟**
 *      逐字节比对 V1 黄金样本 —— 观测设施多读一次时钟就会让整串 `at` 漂移 1ms，那正是「观测反噬被观测者」。
 */
function noteUnregisteredKind(kind, at) {
    try {
        const k = String(kind == null ? '' : kind);
        if (!k || debugKindRegistered(k)) return false;
        const t = Number(at) > 0 ? Number(at) : 0;
        const rec = unregistered.get(k) || { kind: k, count: 0, firstAt: t, lastAt: t, notified: false };
        rec.count += 1;
        if (t > 0) rec.lastAt = t;
        unregistered.set(k, rec);
        if (!rec.notified && !inKindNotice) {
            rec.notified = true;
            inKindNotice = true;
            try {
                dbgLog('调试', {
                    action: '遇到未登记的调试日志 kind → 已照记（绝不丢日志），但按 D31 §3.2 应登记进 core/debug-catalog.js#DEBUG_KINDS',
                    kind: k, count: rec.count, seen: debugUnregisteredKinds().map((x) => x.kind), u: 'U197',
                });
            } catch (e) { /* 提示失败不影响记录 */ } finally { inKindNotice = false; }
        }
        return true;
    } catch (e) { return false; }
}

/** 未登记 kind（**只读**副本；按出现次数降序，同次数按名字） */
function debugUnregisteredKinds() {
    try {
        return Array.from(unregistered.values())
            .map((r) => ({ kind: r.kind, count: r.count, firstAt: r.firstAt, lastAt: r.lastAt, notified: r.notified }))
            .sort((a, b) => (b.count - a.count) || String(a.kind).localeCompare(String(b.kind)));
    } catch (e) { return []; }
}
// 交给 `core/debug-catalog.js` 读取（它的 `debugCatalogReport().unregisteredKinds` 因此是**实时**的）
try { setUnregisteredKindReader(() => debugUnregisteredKinds()); } catch (e) { /* 忽略 */ }
/** 复位未登记登记表（清空日志时一并复位 —— 与 `n` / `kinds` 同口径：清空后统计归零） */
function resetUnregisteredKinds() {
    const n = unregistered.size;
    unregistered = new Map();
    return n;
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
        // v3.45.4（`技-41` ④）：**先**归一（这一次 `Date.now()` 基线本来就要读，不多不少），
        //   再登记判定（未登记 → 计数 + 一次性提示），**最后**才入环 —— 顺序不可颠倒：
        //   提示走到 `dbgLog` 会先入环，业务条目后入环才能稳居 `debugLogList()[0]`。
        const row = debugLogNormalize(kind, data);
        noteUnregisteredKind(kind, row.at);
        debugLogs.unshift(row);
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
        // 口径与 `debugLogPush` 一致：合并式记录同样受 kind 枚举约束（复用上面已经读到的 `now`，不多读时钟）
        noteUnregisteredKind(kind, now);
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
    // v3.45.4（`技-41` ④）：未登记 kind 的登记表与统计同口径复位（清空后 `n` / `kinds` / `unregistered` 全部归零）；
    //   代价是「同 kind 只提示一次」会重新武装 —— 可接受：清空是用户主动动作，且提示本身按会话计。
    resetUnregisteredKinds();
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

/**
 * 统计（调试页只读行用）
 *
 * v3.45.4（`技-41` ④）：新增 `unregistered` —— **既有字段一个都没动**（`n` / `cap` / `kinds` / `newestAt`
 *   的口径与顺序逐字保持，既有单测与黄金样本逐字断言它们）。
 * @returns {{n:number, cap:number, kinds:object, newestAt:number, unregistered:{count:number, kinds:string[]}}}
 */
function debugLogStats() {
    const list = debugLogList();
    const kinds = {};
    list.forEach((l) => { const k = String((l && l.kind) || ''); kinds[k] = (kinds[k] || 0) + 1; });
    const un = debugUnregisteredKinds();
    return {
        n: list.length, cap: DEBUG_CAP, kinds, newestAt: Number((list[0] && list[0].at) || 0),
        // `count` = 未登记 kind 的**出现次数**合计；`kinds` = 去重后的 kind 名（按次数降序）
        unregistered: { count: un.reduce((s, x) => s + Number(x.count || 0), 0), kinds: un.map((x) => x.kind) },
    };
}

export {
    DEBUG_CAP, DEBUG_KEY, DEBUG_DATA_MAX,
    setDebugLogHooks, debugLogPush, debugLogPushCoalesced, debugLogList, debugLogClear, debugLogSync, debugLogStats, debugLogMerge, debugLogNormalize,
    debugLogErrors, debugLogErrorCount, debugLogLastError,
    debugUnregisteredKinds,
};
