// ============================================================
// core/perf-probe.js —— **性能与卡顿探针 + 四类读数 + 潜在优化清单**（v3.45.4 · `docs/D31` §4 · `技-39` · 台账 U191）
//
// 定位：调试面的**第 7 类采集**（`docs/D31` §4）—— 回答「哪里卡 · 卡在哪一步 · 该优化什么 · 与基线比如何」。
//   四类读数只做**采集与透传**：写入（宿主写队列）· 读取（**直接复用** `core/read-ledger.js#readLedgerStats`，
//   不重算）· 扫描（各全量点条目数）· 体积（主文件 / 快照链 / 墓碑 / 副本，**只算长度、不回正文**）。
//
// 三条硬口径（为什么这样判，写在这里避免后人改错）：
//   ① **只记超阈段**（Q2 整批采纳）：低于 `notice(50ms)` 的段**直接丢弃、不入环**——探针不得成为卡顿源。
//      采样默认开、独立于 `cfg.debugLevel`（不为看卡顿去把时间线开到 trace，避免体积暴涨，`D31` §4.3）。
//   ② **不记正文**：明细只有 `站点名 / 毫秒 / 时刻 / 可选计数`，**绝不**记 prompt / 正文 / 记忆内容
//      （与 `core/trace.js` / `core/read-ledger.js` 同口径）。
//   ③ **不猜**：缺数据源一律 `ok:false + reason`；扫描耗时没有线索就是 `ms:null + note:'未采集'`——
//      宁可少一个数，也不给一个看起来像真的假数（门禁会把假数当成事实钉进基线）。
//
// 内核纯净：本模块**不** import 宿主 / DOM / 定时器 / node:fs；时钟（`now`）与一切外部读数
//   （`listTrace` / `getBaseline` / `readLedger` / `writeStats` / `sizes` / `scanProbe`）全部经 `setPerfHooks` 注入，
//   缺省 `Date.now()`（仓库既有先例：`core/trace.js` / `core/read-ledger.js#nowMs`）。
//
// 追溯六字段（`docs/D31` §3.7）：`at / ver / window / cause / site / u` —— 报告级出口
//   （`perfReport` / `perfBaselineReport`）与四类读数的返回值都带上这六项；
//   卡顿明细的每一条自带 `at / site / cause / u`（`window` / `ver` 是全局常量，由报告级容器给出，
//   不在 200 条明细里重复 200 次）。
//
// 冻结接口（下游 `技-40` / `技-42` 按此接桥与调试页，字段名不得改）：
//   PERF_WINDOW · PERF_DEDUPE_MS · PERF_THRESHOLDS · PERF_LEVELS · setPerfHooks · perfReset ·
//   perfLevelOf · perfMark · perfTime · perfTimeAsync · perfJankList · perfJankSummary ·
//   perfReadings · perfTargets · perfReport · perfBaselineReport · perfReportText
// ============================================================
import { VERSION } from './constants.js';
import { fmtBytes, fmtMs, readLedgerStats } from './read-ledger.js';
import { state as kernelStateView } from './model/runtime.js';

/** 环形缓冲上限（条）—— Q2 裁决：200 */
export const PERF_WINDOW = 200;
/** 同站点去重窗口（毫秒）—— Q2 裁决：800 */
export const PERF_DEDUPE_MS = 800;
/** 三级阈值（毫秒）：notice ≥ 50 · stall ≥ 200 · freeze ≥ 1000 */
export const PERF_THRESHOLDS = Object.freeze({ notice: 50, stall: 200, freeze: 1000 });
/** 级别名（由轻到重；`perfLevelOf` 只会返回其中之一或空串） */
export const PERF_LEVELS = Object.freeze(['notice', 'stall', 'freeze']);

/** 追溯六字段的固定值（`site` / `cause` / `u` 在本模块内恒定） */
const PERF_SITE = 'perf-probe';
const PERF_CAUSE = 'perf';
const PERF_U = 'U191';

/** 扫描类读数的「全量点」维度（`core/state.js#emptyState` 的 14 类 + 墓碑账本） */
const SCAN_DIMS = Object.freeze([
    'atoms', 'memories', 'currentStates', 'snapshots', 'items', 'plans', 'suspense',
    'concepts', 'scenes', 'npcs', 'parallels', 'rumors', 'plotSegments', 'links', 'deleted',
]);

// ==================== 注入钩子（内核保持纯净） ====================
let hooks = {
    now: null,          // () => number（缺省 Date.now）
    listTrace: null,    // ({limit}) => 事件数组（最新在前）—— 仅用于给卡顿段补 cause（opId）
    getBaseline: null,  // () => 基线对象（`scripts/perf-baseline.json` 的形状）
    readLedger: null,   // () => readLedgerStats() 形状（缺省直用 core/read-ledger.js）
    writeStats: null,   // () => adapters/tt-store.js#ttWriteStats 形状（无宿主 → null）
    sizes: null,        // () => { shardBytes?, copyBytes?, note? }（分片 / 副本，宿主侧才有）
    scanProbe: null,    // (state) => { ms?, items?, points?, note? }（全量点计时，宿主 / 桩注入）
};
/** 注入探针钩子（宿主接线 / 测试）；返回合并后的只读快照 */
export function setPerfHooks(next) {
    hooks = Object.assign({}, hooks, next || {});
    return Object.assign({}, hooks);
}

/** 取当前时刻：注入时钟优先，非法或缺省一律回退 `Date.now()`（内核不得直用高精度 API） */
function nowMs() {
    try {
        if (typeof hooks.now === 'function') {
            const v = Number(hooks.now());
            if (Number.isFinite(v)) return v;
        }
    } catch (e) { /* 注入时钟抛错 → 回退，绝不把探针错误抛给调用方 */ }
    return Date.now();
}

/** 安全调用一个钩子（钩子抛错 → null；探针绝不反过来弄坏主流程） */
function callHook(name, arg) {
    try {
        const fn = hooks[name];
        return (typeof fn === 'function') ? fn(arg) : null;
    } catch (e) { return null; }
}

/** 数字归一：合法有限数 → 数值；否则 null（**不**用 0 冒充「没有数据」） */
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
/** 对象键数（非对象 → 0） */
function countKeys(v) { return (v && typeof v === 'object') ? Object.keys(v).length : 0; }
/** 条目数（数组 → 长度；对象 → 键数；其余 → 0） */
function dimCount(v) { return Array.isArray(v) ? v.length : countKeys(v); }
/** JSON 序列化长度（**只返回长度，不回正文**）；不可序列化（环）→ null */
function jsonLen(v) {
    try { const s = JSON.stringify(v); return (typeof s === 'string') ? s.length : null; } catch (e) { return null; }
}
/** 墓碑键总数：`{ dim: { id: 时间 } }` → 全部叶子键数（**不是**维度数） */
function tombstoneKeys(v) {
    if (!v || typeof v !== 'object') return 0;
    let n = 0;
    for (const dim of Object.keys(v)) {
        const inner = v[dim];
        if (inner && typeof inner === 'object') n += Object.keys(inner).length;
    }
    return n;
}

// ==================== 卡顿环（只记超阈段 + 去重 + 环形上限） ====================
/** 明细缓冲（**最新在前**） */
let ring = [];
/** 去重表：`site → 上次入环时刻` */
let dedupeAt = new Map();
/** 被去重丢弃的条数（对外读数，进 `perfJankSummary`） */
let deduped = 0;
/** 低于 `notice` 被丢弃的条数（**只计数、不出口**：这类段本来就是「不该记」的，报出去只会诱导后人去看它） */
let droppedBelow = 0;

/** 清空环形与计数（测试钩子；**不动注入钩子** —— 钩子由 `setPerfHooks` 管） */
export function perfReset() {
    ring = [];
    dedupeAt = new Map();
    deduped = 0;
    droppedBelow = 0;
    return true;
}

/**
 * 耗时 → 级别（纯函数）。
 * 边界口径：`< 50 → ''` · `50–199 → notice` · `200–999 → stall` · `≥ 1000 → freeze`。
 * 非有限数（NaN / undefined / 负数）→ `''`（**不猜成 notice**）。
 * @param {number} ms 单段耗时（毫秒）
 * @returns {'notice'|'stall'|'freeze'|''}
 */
export function perfLevelOf(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < PERF_THRESHOLDS.notice) return '';
    if (n >= PERF_THRESHOLDS.freeze) return 'freeze';
    if (n >= PERF_THRESHOLDS.stall) return 'stall';
    return 'notice';
}

/**
 * 记一段耗时（**唯一入环入口**）。
 *   · `< notice` → **直接丢弃**（入环成本为零；这是「探针不得成为卡顿源」的第一道闸）；
 *   · 同 `site` 在 `PERF_DEDUPE_MS` 内重复 → 丢弃并计入 `deduped`（第二道闸）；
 *   · 入环后超 `PERF_WINDOW` → 淘汰**最旧**（第三道闸：内存恒定，不随会话增长）。
 * @param {string} site 站点名（`file:line:fn` 或逻辑段名；**不记正文**）
 * @param {number} ms 耗时（毫秒）
 * @param {{cause?:string, u?:string, n?:number, at?:number}} [opts] 可选：触发动作 / 台账号 / 计数 / 指定时刻
 * @returns {object|null} 入环的记录（被丢弃时 null）
 */
export function perfMark(site, ms, opts) {
    try {
        const o = opts || {};
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return null;              // 非法读数 → 丢弃（不猜）
        const level = perfLevelOf(n);
        if (!level) { droppedBelow += 1; return null; }              // 未达 notice → 丢弃
        const name = String(site == null ? '' : site).slice(0, 120);
        const at = (numOrNull(o.at) != null) ? Number(o.at) : nowMs();
        const prev = dedupeAt.get(name);
        if (prev != null && (at - prev) < PERF_DEDUPE_MS) { deduped += 1; return null; }
        const rec = {
            at: at,
            site: name,
            ms: Math.round(n),
            level: level,
            cause: String(o.cause == null ? '' : o.cause).slice(0, 80),
            u: String(o.u == null ? '' : o.u).slice(0, 24),
            n: Math.max(0, Math.round(numOrNull(o.n) || 0)),
        };
        // `cause` 缺省时向时间线要「谁触发的」（opId）—— 只读引用，不重复采集（`D31` §4.3）
        if (!rec.cause) {
            const list = callHook('listTrace', { limit: 1 });
            const top = (Array.isArray(list) && list.length) ? list[0] : null;
            if (top) rec.cause = String(top.opId || top.op || '').slice(0, 80);
        }
        ring.unshift(rec);
        if (ring.length > PERF_WINDOW) ring.length = PERF_WINDOW;    // 淘汰最旧
        dedupeAt.set(name, at);
        if (dedupeAt.size > 256) {                                   // 去重表也有界（站点数有限，防御性清最旧）
            const keys = Array.from(dedupeAt.keys());
            for (let i = 0; i < keys.length - 128; i++) dedupeAt.delete(keys[i]);
        }
        return Object.assign({}, rec);
    } catch (e) { return null; }
}

/**
 * 同步包装：执行 `fn` 并记一段耗时；**返回 `fn` 的返回值**（异常照常抛出，探针不吞错）。
 * @param {string} site 站点名
 * @param {Function} fn 被测同步函数
 */
export function perfTime(site, fn) {
    const t0 = nowMs();
    try {
        return (typeof fn === 'function') ? fn() : fn;
    } finally {
        try { perfMark(site, nowMs() - t0, { cause: 'perfTime' }); } catch (e) { /* 探针绝不抛 */ }
    }
}

/**
 * 异步包装：`await fn()` 之后记一段耗时；**返回 `fn` 的返回值**（异常照常抛出）。
 * 注意：异步段的耗时含事件循环等待，属「墙钟」口径（与 `D31` §4.1 的分段口径一致）。
 * @param {string} site 站点名
 * @param {Function} fn 被测异步函数
 */
export async function perfTimeAsync(site, fn) {
    const t0 = nowMs();
    try {
        return (typeof fn === 'function') ? await fn() : fn;
    } finally {
        try { perfMark(site, nowMs() - t0, { cause: 'perfTimeAsync' }); } catch (e) { /* 探针绝不抛 */ }
    }
}

/**
 * 超阈段明细（**倒序：最新在前**）。
 * @param {{limit?:number, level?:'notice'|'stall'|'freeze'}} [opts]
 * @returns {Array<{at:number, site:string, ms:number, level:string, cause:string, u:string, n:number}>} 只读副本
 */
export function perfJankList(opts) {
    const o = opts || {};
    let out = ring;
    const lvl = String(o.level || '');
    if (lvl) out = out.filter((x) => x.level === lvl);
    const n = numOrNull(o.limit);
    if (n != null && n > 0) out = out.slice(0, Math.floor(n));
    return out.map((x) => ({ at: x.at, site: x.site, ms: x.ms, level: x.level, cause: x.cause, u: x.u, n: x.n }));
}

/**
 * 卡顿摘要。
 * `jankRate` 口径（**与 `D31` §4.1 的差异必须知道**）：本实现 = `超阈条数 ÷ 环形窗口容量(PERF_WINDOW)`，
 *   是一个**有界 0–1 的采样占比**；`D31` §4.1 另写过「Σ(超阈段耗时) ÷ 采样窗口时长」。
 *   为什么不用后者：探针**只记超阈段、不采样子阈值段**，因此「采样窗口时长」在探针内部**不可自证**
 *   （分母无处可来）——按「不猜」口径，宁可用一个真实可算的占比。
 * @returns {{window:number, count:number, deduped:number, byLevel:object, jankRate:number, worstMs:number, worstSite:string, lastAt:number}}
 */
export function perfJankSummary() {
    const byLevel = { notice: 0, stall: 0, freeze: 0 };
    let worstMs = 0, worstSite = '', lastAt = 0;
    for (const x of ring) {
        if (byLevel[x.level] === undefined) byLevel[x.level] = 0;
        byLevel[x.level] += 1;
        if (x.ms > worstMs) { worstMs = x.ms; worstSite = x.site; }
        if (x.at > lastAt) lastAt = x.at;
    }
    const count = ring.length;
    return {
        window: PERF_WINDOW,
        count: count,
        deduped: deduped,
        byLevel: byLevel,
        jankRate: Math.round((count / PERF_WINDOW) * 10000) / 10000,
        worstMs: worstMs,
        worstSite: worstSite,
        lastAt: lastAt,
    };
}

// ==================== 四类读数（只读；缺数据源 → ok:false + reason） ====================
/** 取 state（参数优先；否则用内核注入视图 `core/model/runtime.js#state`） */
function resolveState(stateLike) {
    if (stateLike && typeof stateLike === 'object') return stateLike;
    try { return (kernelStateView && typeof kernelStateView === 'object') ? kernelStateView : null; } catch (e) { return null; }
}

/**
 * 写入侧读数。
 * 数据源：注入的 `writeStats()`（宿主接 `adapters/tt-store.js#ttWriteStats`）。
 * **字节**只在钩子带了 `bytes` 时给出——`ttWriteStats()` 本身**没有**字节字段，
 *   本模块**不**用「写次数 × 某常数」之类的方式估算（那是编造），故缺字节就是 `null` + 说明。
 */
function writeReading() {
    const st = callHook('writeStats');
    if (!st || typeof st !== 'object') {
        return {
            ok: false, reason: 'no-write-stats',
            note: '无写入侧读数源：宿主未接线 ttWriteStats（adapters/tt-store.js#ttWriteStats）',
            writes: null, queued: null, failed: null, pending: null, inFlight: null, maxInFlight: null,
            bytes: null, lastMs: null, lastAt: null, channel: '', waitMs: null,
        };
    }
    const last = (st.last && typeof st.last === 'object') ? st.last : null;
    return {
        ok: true, reason: '',
        note: numOrNull(st.bytes) == null ? '字节未采集（ttWriteStats 无字节字段；需注入 bytes）' : '',
        writes: numOrNull(st.done),
        queued: numOrNull(st.queued),
        failed: numOrNull(st.failed),
        pending: numOrNull(st.pending),
        inFlight: numOrNull(st.inFlight),
        maxInFlight: numOrNull(st.maxInFlight),
        bytes: numOrNull(st.bytes),
        lastMs: last ? numOrNull(last.ms) : null,
        lastAt: last ? numOrNull(last.at) : null,
        channel: last ? String(last.label || '').slice(0, 80) : '',
        waitMs: numOrNull(st.waitMs != null ? st.waitMs : (last ? last.waitMs : null)),
    };
}

/**
 * 读取侧读数：**直接复用** `core/read-ledger.js#readLedgerStats()`（同一函数、不重算，`D31` §3.8 的「只算一次」）。
 * 命名注意：台账自己的 `ok` 是**成功读取次数**，与本类读数的状态位 `ok` 撞名 →
 *   台账的成功次数在本读数里叫 **`okReads`**（字段映射写死在这里，不让下游各猜一套）。
 */
function readReading() {
    let st = null, failed = false;
    try {
        st = (typeof hooks.readLedger === 'function') ? hooks.readLedger() : readLedgerStats();
    } catch (e) { failed = true; st = null; }
    if (failed || !st || typeof st !== 'object') {
        return {
            ok: false, reason: 'no-read-ledger', note: '读取台账不可用（readLedgerStats 不可调用）',
            count: null, totalReads: null, okReads: null, fail: null, miss: null,
            totalMs: null, avgMs: null, totalBytes: null, bySrc: {},
        };
    }
    return {
        ok: true, reason: '',
        note: numOrNull(st.count) ? '' : '台账可用但尚无读取记录（计数为 0，不是缺数据源）',
        count: numOrNull(st.count),
        totalReads: numOrNull(st.totalReads),
        okReads: numOrNull(st.ok),
        fail: numOrNull(st.fail),
        miss: numOrNull(st.miss),
        totalMs: numOrNull(st.totalMs),
        avgMs: numOrNull(st.avgMs),
        totalBytes: numOrNull(st.totalBytes),
        bySrc: (st.bySrc && typeof st.bySrc === 'object') ? st.bySrc : {},
    };
}

/**
 * 扫描侧读数：各**全量点**的条目数与耗时。
 * 条目数：注入 `scanProbe(state)` 给的就用它（宿主真的量过），否则就地数 `state[key]` 条目数。
 * 耗时：**没有线索就是 `ms:null` + `msNote:'未采集'`** —— 不拿 `Date.now()` 差一次冒充「全量点耗时」
 *   （那样得到的数字没有对应的被测代码，钉进基线只会误导后人）。
 */
function scanReading(st) {
    if (!st || typeof st !== 'object') {
        return {
            ok: false, reason: 'no-state', note: '未注入 state：扫描量无法计数（不猜）',
            items: {}, total: null, points: [], ms: null, msNote: '未采集',
        };
    }
    const items = {};
    // `deleted` 是**两层墓碑账本**（`{dim:{id:时间}}`）而不是条目数组：它的「条数」= 叶子键总数
    //   （「有多少条墓碑要扫」），与 `size.deletedKeys` 走**同一个** `tombstoneKeys` 助手（只算一次）。
    for (const k of SCAN_DIMS) items[k] = (k === 'deleted') ? tombstoneKeys(st[k]) : dimCount(st[k]);
    let total = 0;
    for (const k of SCAN_DIMS) total += items[k];
    const probe = callHook('scanProbe', st);
    let points = [], ms = null, note = '';
    if (probe && typeof probe === 'object') {
        if (probe.items && typeof probe.items === 'object') {
            for (const k of Object.keys(probe.items)) {
                const n = numOrNull(probe.items[k]);
                if (n != null) items[k] = n;
            }
            total = 0;
            for (const k of Object.keys(items)) total += items[k];
        }
        if (Array.isArray(probe.points)) {
            points = probe.points.filter((p) => p && typeof p === 'object')
                .map((p) => ({ site: String(p.site || ''), items: numOrNull(p.items), ms: numOrNull(p.ms) }));
        }
        ms = numOrNull(probe.ms);
        note = String(probe.note || '');
        if (numOrNull(probe.total) != null) total = Number(probe.total);
    }
    return {
        ok: true, reason: '',
        note: note || (ms == null ? '全量点耗时未采集（无计时读数源）' : ''),
        items: items, total: total, points: points,
        ms: ms, msNote: ms == null ? '未采集' : '',
    };
}

/** 语义数据视图（剥掉派生容器；**浅拷贝引用、不深拷贝**，只读） */
function semanticOnly(st) {
    const out = {};
    for (const k of Object.keys(st)) {
        if (k === 'snapStore' || k === 'deleted' || k === 'deletedH' || k === 'links' || k === 'snapFp') continue;
        out[k] = st[k];
    }
    return out;
}

/**
 * 体积侧读数：主文件 / 语义 / 派生（快照链 + 墓碑 + 关联）/ 分片 / 副本，**只算长度、不回正文**。
 * `mainBytes` 用 `JSON.stringify(state).length`（字符数，作字节近似）——口径写在 `note` 里，
 *   且**不含宿主信封**（信封只有宿主知道，探针不猜）。
 */
function sizeReading(st) {
    if (!st || typeof st !== 'object') {
        return {
            ok: false, reason: 'no-state', note: '未注入 state：体积无法测量（不猜）',
            mainBytes: null, semanticBytes: null, derivedBytes: null, snapCount: null, snapBytes: null,
            deletedKeys: null, deletedDims: null, deletedHKeys: null, deletedHDims: null, tombstoneKeys: null,
            linkRows: null, shardBytes: null, copyBytes: null, totalBytes: null,
        };
    }
    const snaps = Array.isArray(st.snapStore) ? st.snapStore : [];
    const mainBytes = jsonLen(st);
    const snapBytes = jsonLen(snaps);
    const deletedKeys = tombstoneKeys(st.deleted);
    const deletedHKeys = tombstoneKeys(st.deletedH);
    const derivedBytes = jsonLen({ snapStore: snaps, deleted: st.deleted, deletedH: st.deletedH, links: st.links });
    const semanticBytes = jsonLen(semanticOnly(st));
    const sz = callHook('sizes', st);
    let shardBytes = null, copyBytes = null, note = 'mainBytes = JSON.stringify(state).length（字符数近似字节，不含宿主信封）';
    if (sz && typeof sz === 'object') {
        shardBytes = numOrNull(sz.shardBytes);
        copyBytes = numOrNull(sz.copyBytes);
        if (sz.note) note += ' · ' + String(sz.note).slice(0, 120);
    } else {
        note += ' · 分片 / 副本字节未采集（需注入 sizes 钩子）';
    }
    const totalBase = (mainBytes || 0) + (shardBytes || 0) + (copyBytes || 0);
    return {
        ok: true, reason: '', note: note,
        mainBytes: mainBytes, semanticBytes: semanticBytes, derivedBytes: derivedBytes,
        snapCount: snaps.length, snapBytes: snapBytes,
        deletedKeys: deletedKeys, deletedDims: countKeys(st.deleted),
        deletedHKeys: deletedHKeys, deletedHDims: countKeys(st.deletedH),
        tombstoneKeys: deletedKeys + deletedHKeys,
        linkRows: Array.isArray(st.links) ? st.links.length : countKeys(st.links),
        shardBytes: shardBytes, copyBytes: copyBytes,
        totalBytes: (mainBytes == null && shardBytes == null && copyBytes == null) ? null : totalBase,
    };
}

/**
 * 四类读数（**只读**，不修改任何数据）。
 * @param {object} [stateLike] 状态对象；缺省用内核注入视图 `core/model/runtime.js#state`
 * @returns {{at:number,ver:string,window:number,cause:string,site:string,u:string,write:object,read:object,scan:object,size:object}}
 */
export function perfReadings(stateLike) {
    const st = resolveState(stateLike);
    return {
        // 追溯六字段（`docs/D31` §3.7）——四类读数并列带上，字段名固定
        at: nowMs(), ver: VERSION, window: PERF_WINDOW, cause: PERF_CAUSE, site: PERF_SITE, u: PERF_U,
        write: writeReading(),
        read: readReading(),
        scan: scanReading(st),
        size: sizeReading(st),
    };
}

// ==================== 潜在优化清单（7 条机械判据） ====================
/**
 * 7 条机械判据（`docs/D31` §4.2）逐条求值。
 * 每条固定 7 个字段：`{id, 现象, 判据, 证据, 归因, 建议, 台账号}`（另带 `命中` 供 `{all:true}` 用）。
 * **只输出候选、不自动开单、不自动改代码**；台账号写 `docs/D17` 的 `U<n>`，未立项就**如实写 `'未立项'`**。
 * 阈值为「最终以基线为准」的可判定代理值，全部写在 `判据` 文本里（改阈值必须同批改文本，防止口径漂移）。
 */
function targetsFrom(rd, jk, list) {
    const w = rd.write, s = rd.scan, z = rd.size;
    const out = [];

    // 1 单段热点：某段 ≥ stall
    const hot = list.filter((x) => x.level === 'stall' || x.level === 'freeze');
    out.push({
        id: 'T1', 现象: '单段热点',
        判据: '某段同步耗时 ≥ stall（' + PERF_THRESHOLDS.stall + 'ms，PERF_THRESHOLDS.stall）',
        证据: hot.length
            ? (hot[0].level + ' ' + hot[0].ms + 'ms @ ' + hot[0].site + '（at=' + hot[0].at + ' · cause=' + (hot[0].cause || '—') + ' · window=' + jk.window + '）')
            : ('无超阈段（window=' + jk.window + ' · count=' + jk.count + '）'),
        归因: '同步全量 / 全量序列化',
        建议: '分批 / 索引 / 增量（先看该 site 的调用点）',
        台账号: 'U190（技-38）· U163（数-26）',
        命中: hot.length > 0,
    });

    // 2 扫描量随总量线性增长：某全量点条目数 ÷ 库条目总数 ≥ 0.8（且库 ≥ 200）
    const pts = Array.isArray(s.points) ? s.points : [];
    const libTotal = numOrNull(s.total);
    const full = pts.filter((p) => numOrNull(p.items) != null && libTotal != null && libTotal > 0 && (Number(p.items) / libTotal) >= 0.8);
    const hit2 = s.ok === true && libTotal != null && libTotal >= 200 && full.length > 0;
    out.push({
        id: 'T2', 现象: '扫描量随总量线性增长',
        判据: '某全量点条目数 ÷ 库条目总数 ≥ 0.8，且库条目总数 ≥ 200（「随库上升」需两次基线采样，本轮只判可判定的前一半）',
        证据: hit2
            ? (full[0].site + ' 一次扫 ' + full[0].items + '/' + libTotal + ' 条（比 ' + (Math.round((Number(full[0].items) / libTotal) * 100) / 100) + '）· window=' + jk.window)
            : (s.ok ? ('全量点 ' + pts.length + ' 个 · 库合计 ' + (libTotal == null ? '未采集' : libTotal) + ' 条（未达判据）') : '无 state：扫描量未采集'),
        归因: '每次全量遍历',
        建议: '变更集 + 世代缓存（用 core/model/runtime.js#kernelStateSeq 失效）',
        台账号: 'U190（技-38）',
        命中: hit2,
    });

    // 3 写字节 ≫ 变化量：以「单次保存写字节 ÷ 主文件字节 > 1.5」为可判定代理（变化量**无**读数源，不猜）
    const wBytes = numOrNull(w.bytes), mainB = numOrNull(z.mainBytes);
    const r3 = (wBytes != null && mainB != null && mainB > 0) ? (wBytes / mainB) : null;
    const hit3 = r3 != null && r3 > 1.5;
    out.push({
        id: 'T3', 现象: '写字节 ≫ 变化量',
        判据: '单次保存写字节 ÷ 主文件字节 > 1.5（写放大代理；「本次变化字节」无读数源，故不按变化量判）',
        证据: r3 != null
            ? ('写 ' + wBytes + 'B ÷ 主文件 ' + mainB + 'B = ' + (Math.round(r3 * 100) / 100) + '（最近一次 ' + (w.lastMs == null ? '耗时未采集' : w.lastMs + 'ms') + ' · 通道 ' + (w.channel || '—') + '）')
            : ('写字节或体积未采集（写字节 ' + (wBytes == null ? 'null' : wBytes) + ' / 主文件 ' + (mainB == null ? 'null' : mainB) + '）'),
        归因: '写放大（一次保存写整份主文件 + 派生）',
        建议: '写入收敛：脏分区写 / 等值跳过 / 合流（不改可见结果）',
        台账号: 'U188（数-31）',
        命中: hit3,
    });

    // 4 队列等待 > 执行：需要「等待时长」读数；ttWriteStats 只有 pending/last → 缺就如实说不判
    const wait = numOrNull(w.waitMs), lastMs = numOrNull(w.lastMs), pend = numOrNull(w.pending);
    const hit4 = wait != null && lastMs != null && wait > lastMs;
    out.push({
        id: 'T4', 现象: '队列等待 > 执行',
        判据: '写队列等待时长 > 单次执行耗时（waitMs > lastMs）',
        证据: (wait != null && lastMs != null)
            ? ('等待 ' + wait + 'ms > 执行 ' + lastMs + 'ms · pending=' + (pend == null ? '未采集' : pend))
            : ('等待时长未采集（adapters/tt-store.js#ttWriteStats 只有 pending / last，无等待时长）· pending=' + (pend == null ? '未采集' : pend)),
        归因: '写队列拥塞',
        建议: '去重 / 降频 / 副本收敛；先补「等待时长」读数再判',
        台账号: 'U188（数-31）· U189（数-32）',
        命中: hit4,
    });

    // 5 派生与副本膨胀：(快照链 + 副本) ÷ 语义数据 > 0.3
    const sem = numOrNull(z.semanticBytes), der = numOrNull(z.derivedBytes);
    const r5 = (sem != null && sem > 0 && der != null) ? (der / sem) : null;
    const hit5 = r5 != null && r5 > 0.3;
    out.push({
        id: 'T5', 现象: '派生与副本膨胀',
        判据: '(快照链 + 墓碑 + 关联 + 副本) 字节 ÷ 语义数据字节 > 0.3',
        证据: r5 != null
            ? ('派生 ' + der + 'B ÷ 语义 ' + sem + 'B = ' + (Math.round(r5 * 100) / 100) + '（快照 ' + (z.snapCount == null ? '未采集' : z.snapCount + ' 条 / ' + z.snapBytes + 'B') + ' · 墓碑 ' + (z.tombstoneKeys == null ? '未采集' : z.tombstoneKeys) + ' · 副本 ' + (z.copyBytes == null ? '未采集' : z.copyBytes + 'B') + '）')
            : '体积未采集（语义 / 派生字节缺一）',
        归因: '派生无保留窗（快照链 / 墓碑 / 副本随语义数据同速膨胀）',
        建议: '保留窗 + 合并 + 回收（派生数据可回收，**语义数据不删**）',
        台账号: 'U189（数-32）',
        命中: hit5,
    });

    // 6 可重复的结构性热点：同一 site ≥ 3 次采样均超阈
    const bySite = new Map();
    for (const x of list) bySite.set(x.site, (bySite.get(x.site) || 0) + 1);
    const rep = Array.from(bySite.entries()).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
    out.push({
        id: 'T6', 现象: '可重复的结构性热点',
        判据: '同一 site 在环形窗口内有 ≥ 3 次超阈采样',
        证据: rep.length
            ? (rep.slice(0, 3).map(([site, n]) => site + ' × ' + n).join(' · ') + '（window=' + jk.window + '）')
            : ('无重复站点（window=' + jk.window + ' · 站点数 ' + bySite.size + '）'),
        归因: '结构性热点（不是偶发）',
        建议: '按 site 定位调用点后立项优化',
        台账号: '未立项',
        命中: rep.length > 0,
    });

    // 7 卡顿率恶化：需要基线带卡顿率；本轮基线只含四类**确定性**读数 → 缺就如实说不判
    const base = callHook('getBaseline');
    const baseRate = (base && typeof base === 'object') ? numOrNull(base.jankRate) : null;
    const hit7 = baseRate != null && jk.jankRate > baseRate * 1.5;
    out.push({
        id: 'T7', 现象: '卡顿率恶化',
        判据: 'jankRate > 基线卡顿率 × 1.5（容忍系数）',
        证据: baseRate != null
            ? ('当前 ' + jk.jankRate + ' > 基线 ' + baseRate + ' × 1.5（window=' + jk.window + '）')
            : (base ? '基线不含卡顿率（基线形状只含四类确定性读数；卡顿率含耗时噪声，不进棘轮）' : '无基线（setPerfHooks({getBaseline}) 未接线）'),
        归因: '性能回归',
        建议: '回滚 / 优化；卡顿率只记录不判定（待基线带 jankRate 后再判）',
        台账号: 'U191（技-39）',
        命中: hit7,
    });
    // 英文字段别名（与中文字段**同值**）——W10 消费方（`ui/debug.js` / `ui/commands.js`）按英文渲染；
    //   中文七字段仍是冻结契约，两套都在，读哪套都对。
    for (const x of out) {
        x.title = x.现象;
        x.judge = x.判据;
        x.evidence = x.证据;
        x.attribution = x.归因;
        x.suggest = x.建议;
        x.u = x.台账号;
        x.hit = x.命中;
    }
    return out;
}

/**
 * 潜在优化清单（**只输出候选**、不自动开单、不自动改代码）。
 *
 * 字段名：设计口径（`docs/D31` §4.2）用**中文字段**（`现象 / 判据 / 证据 / 归因 / 建议 / 台账号`）——
 *   这是冻结契约；同时每条**附带英文字段别名**（`title / judge / evidence / attribution / suggest / u`），
 *   因为 W10 的消费方（`ui/debug.js#perfSectionHtml` · `ui/commands.js` 的 `/ftt-perf targets`）按英文字段渲染。
 *   两套字段**同值**，读哪套都对（`u` 与追溯六字段的 `u` 同义 = 台账号，未立项写 `'未立项'`）。
 *
 * 兼容形状：**主返回值是数组**（"清单 = 条目数组"），另挂**不可枚举**的 `list` / `count`
 *   （= 自身 / 长度）—— 于是 `perfTargets().list`（`/ftt-perf targets` 的既有写法）与
 *   `perfTargets().length` 都能用；不可枚举 ⇒ `JSON.stringify` 仍是**干净的数组**（过桥不失真）。
 * @param {object} [stateLike] 状态对象
 * @param {{all?:boolean}} [opts] `all:true` → 返回全部 7 条（带 `命中` 布尔，用于「为什么没报」的自查）
 * @returns {Array<{id:string,现象:string,判据:string,证据:string,归因:string,建议:string,台账号:string}>}
 */
export function perfTargets(stateLike, opts) {
    const all = !!(opts && opts.all);
    const rd = perfReadings(stateLike);
    const items = targetsFrom(rd, perfJankSummary(), perfJankList({}));
    const out = all ? items : items.filter((x) => x.命中);
    try {
        Object.defineProperty(out, 'list', { value: out, enumerable: false, configurable: true });
        Object.defineProperty(out, 'count', { value: out.length, enumerable: false, configurable: true });
    } catch (e) { /* 兼容属性挂不上也不影响主返回 */ }
    return out;
}

// ==================== 出口：报告 / 基线差异 / 一行摘要 ====================
/**
 * 六字段内的「确定性量」判定（与本仓库门禁 `scripts/perf-baseline-lib.js` 的规则**必须一致**）：
 *   · 耗时 / 平均 / 比率 / 时刻类键名 → **只记录**、不判定；
 *   · 条数 / 字节 / 计数类键名，或位于 `items / counts / byLevel / dims` 容器之下 → 确定性量。
 * 为什么耗时不做判定：本机耗时噪声大（同一份数据两次跑能差数倍），拿它当门禁必然 flaky。
 *
 * 判「耗时键」的两个坑（都踩过，别再改回去）：
 *   ① **不能**用 `/ms$/i` 一把梭 —— 维度名 `atoms` 就是以 `ms` 结尾的，会被当成耗时而**整个漏出棘轮**
 *      （于是「原子数变多」这条最该被门禁抓住的劣化反而无声通过）；
 *   ② 只能认**驼峰**的 `…Ms / …At / …Rate` 与精确小写 `at / ms / lastAt / msNote`。
 */
function isTimingKey(key) {
    const s = String(key);
    if (s === 'at' || s === 'ms' || s === 'lastAt' || s === 'msNote') return true;
    return /(Ms|At|Rate)$/.test(s);
}
function isCountKey(key) {
    return /(count|bytes|items|lines|keys|ids|dims|rows|chars|total|writes|queued|done|failed|pending|inflight|maxinflight|reads|fail|miss)/i.test(String(key));
}
function inCountContainer(path) { return /(^|\.)(items|counts|bylevel|dims)(\.|$)/i.test(String(path)); }
/** 追溯字段（`D31` §3.7）——不参与任何数值比对 */
const TRACE_KEYS = Object.freeze(['at', 'ver', 'window', 'cause', 'site', 'u']);

/** 摊平所有数值叶子：`{path: {value, kind}}`（kind = 'count' | 'timing'） */
function flattenNumbers(root, includeNull) {
    const out = {};
    const walk = (obj, path, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 4) return;
        for (const k of Object.keys(obj)) {
            if (depth === 0 && TRACE_KEYS.indexOf(k) >= 0) continue;
            const v = obj[k];
            const p = path ? (path + '.' + k) : k;
            if (typeof v === 'number' && Number.isFinite(v)) {
                if (isTimingKey(k)) out[p] = { value: v, kind: 'timing' };
                else if (isCountKey(k) || inCountContainer(path)) out[p] = { value: v, kind: 'count' };
                continue;
            }
            // `includeNull`：把「键在、值是 null」也登记下来 —— 用于区分「**未采集**（钩子没接线）」
            //   与「**量被删掉**（代码里这个读数没了）」。两者都不猜，但处置不同（见 `diffReadings`）。
            if (includeNull && v === null) {
                out[p] = { value: null, kind: isTimingKey(k) ? 'timing' : 'count' };
                continue;
            }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length && i < 32; i++) walk(v[i], p + '.' + i, depth + 1);
                continue;
            }
            walk(v, p, depth + 1);
        }
    };
    walk(root, '', 0);
    return out;
}

/**
 * 基线差异（diff）。`verdict` 取值与含义（**与门禁同一套词**，但多两种「如实标注」）：
 *   · `same` / `worse` / `better` —— 确定性量（条数 / 字节 / 计数）的相等 / 变大 / 变小；
 *   · `timing` —— 耗时 / 时刻：**只记录、不判定**（本机噪声大，拿它当门禁必然 flaky）；
 *   · `missing` —— 基线有、当前**连这个键都没有**（读数被删了）；
 *   · `unavailable` —— 基线有、当前**键在但值是 null**（宿主钩子没接线 / 数据源缺失，**未采集**）；
 *   · `new` —— 当前新增、基线没有的量（不判定；`--write` 可纳入）。
 *
 * 为什么 `missing` / `unavailable` **不计入 `regressions`**（与门禁脚本的分工）：
 *   本报告面向**实时读数**，而基线是**开发期确定性合成库**的产物 —— 真机上「宿主没接线 → 该量未采集」
 *   属于正常态，若算成「回归」，调试页会满屏假回归、真回归反而被淹没。**严格口径在门禁脚本里**：
 *   `scripts/perf-baseline-lib.js#compareToBaseline` 把「基线有、当前没有」一律判**失败**（不许静默丢量），
 *   因为它比的是**同一合成库**的两侧，缺量只可能是代码退化。
 */
function diffReadings(cur, base) {
    const c = flattenNumbers(cur || {});
    const cSlots = flattenNumbers(cur || {}, true);            // 含 null：用于区分「未采集」与「被删」
    const b = flattenNumbers(base || {});
    const compare = {}, regressions = [], improvements = [], missing = [];
    const itemOf = (p, bv, cv, delta, verdict, kind) => ({ key: p, path: p, baseline: bv, current: cv, delta: delta, verdict: verdict, kind: kind });
    for (const p of Object.keys(b)) {
        const bv = b[p].value;
        if (c[p] === undefined) {
            const slot = cSlots[p];
            const verdict = slot ? 'unavailable' : 'missing';
            const it = itemOf(p, bv, null, null, verdict, b[p].kind);
            compare[p] = { baseline: bv, current: null, delta: null, verdict: verdict, kind: b[p].kind };
            missing.push(it);
            continue;
        }
        const cv = c[p].value;
        const delta = cv - bv;
        let verdict = 'same';
        if (b[p].kind === 'timing') verdict = 'timing';
        else if (delta > 0) verdict = 'worse';
        else if (delta < 0) verdict = 'better';
        compare[p] = { baseline: bv, current: cv, delta: delta, verdict: verdict, kind: b[p].kind };
        if (verdict === 'worse') regressions.push(itemOf(p, bv, cv, delta, verdict, b[p].kind));
        if (verdict === 'better') improvements.push(itemOf(p, bv, cv, delta, verdict, b[p].kind));
    }
    for (const p of Object.keys(c)) {
        if (b[p] === undefined) compare[p] = { baseline: null, current: c[p].value, delta: null, verdict: 'new', kind: c[p].kind };
    }
    const byKey = (a, b2) => (a.key < b2.key ? -1 : (a.key > b2.key ? 1 : 0));
    return {
        compare: compare,
        regressions: regressions.sort(byKey),
        improvements: improvements.sort(byKey),
        missing: missing.sort(byKey),
    };
}

/** 一行人读摘要（≤120 字；调试页与导出共用） */
function reportTextOf(rd, jk, hits) {
    const w = rd.write, r = rd.read, s = rd.scan, z = rd.size;
    const fb = (v) => (v == null ? '未采集' : fmtBytes(v));
    const fs = (v) => (v == null ? '未采集' : fmtMs(v));
    const parts = [];
    parts.push('📊 性能 ' + PERF_U + ' v' + VERSION);
    parts.push('写入 ' + (w.ok ? ((w.writes == null ? '?' : w.writes) + '次/' + fb(w.bytes) + '/' + fs(w.lastMs)) : '未接线'));
    parts.push('读取 ' + (r.ok ? ((r.totalReads == null ? '?' : r.totalReads) + '次/' + fs(r.totalMs)) : '不可用'));
    parts.push('扫描 ' + (s.ok ? ((s.total == null ? '?' : s.total) + '条/' + (s.ms == null ? '耗时未采集' : fs(s.ms))) : '无 state'));
    parts.push('体积 ' + (z.ok ? fb(z.mainBytes) : '无 state'));
    parts.push('卡顿 ' + jk.count + '段 ' + (Math.round(jk.jankRate * 10000) / 100) + '% 最差 ' + (jk.worstMs ? (jk.worstMs + 'ms') : '—'));
    parts.push('清单 ' + hits.length + '条');
    let t = parts.join(' · ');
    if (t.length > 120) t = t.slice(0, 119) + '…';
    return t;
}

/**
 * 报告（= 调试桥 `ftt.perf` 的形状；下游直接进桥与页面，字段名不得改）。
 * @param {object} [stateLike]
 * @returns {{at:number,ver:string,window:number,cause:string,site:string,u:string,readings:object,jank:object,targets:object,text:string}}
 */
export function perfReport(stateLike) {
    const rd = perfReadings(stateLike);
    const jk = perfJankSummary();
    const list = perfJankList({});
    const hits = targetsFrom(rd, jk, list).filter((x) => x.命中);
    return {
        at: nowMs(), ver: VERSION, window: PERF_WINDOW, cause: PERF_CAUSE, site: PERF_SITE, u: PERF_U,
        readings: rd,
        jank: jk,
        targets: { count: hits.length, list: hits.slice(0, 10) },
        text: reportTextOf(rd, jk, hits),
    };
}

/**
 * 与基线比（= 调试桥 `ftt.perfBaseline` 的形状）。
 * 基线经 `setPerfHooks({getBaseline})` 注入；**无基线 → `available:false, reason:'no-baseline'`**（不编造）。
 * 判定口径与门禁 `scripts/perf-baseline-lib.js#compareToBaseline` **同规则**（耗时只记录不判定）；
 *   两处实现的一致性由 `tests/unit/perf-baseline-gate.test.js` 的比对断言锁住（防止规则漂移）。
 *
 * **两个口径必须知道**（否则会把「未采集」误读成回归）：
 *   ① 基线是**开发期确定性合成库**（`scripts/perf-baseline.json`）的产物：真机实时读数的量级与它不同
 *      属正常现象；**严格判定**在 `node scripts/check-perf-baseline.js`（同一合成口径两侧相比）；
 *   ② `missing / unavailable`（键被删 / 键在但值为 null）单列在 `missing`，**不计入 `regressions`** ——
 *      真机上「宿主没接线 → 未采集」是正常态；若算成回归，调试页会满屏假回归。
 * @returns {{at:number,ver:string,window:number,cause:string,site:string,u:string,available:boolean,baselineAt:number,compare:object,regressions:Array,improvements:Array,missing:Array,note:string,reason?:string}}
 */
export function perfBaselineReport() {
    const head = { at: nowMs(), ver: VERSION, window: PERF_WINDOW, cause: PERF_CAUSE, site: PERF_SITE, u: PERF_U };
    let base = null;
    try { base = (typeof hooks.getBaseline === 'function') ? hooks.getBaseline() : null; } catch (e) { base = null; }
    if (!base || typeof base !== 'object' || !base.readings) {
        return Object.assign(head, {
            available: false, reason: 'no-baseline', baselineAt: numOrNull(base && base.at) || 0,
            compare: {}, regressions: [], improvements: [], missing: [],
            note: '未注入基线（setPerfHooks({getBaseline})）——不编造差异',
        });
    }
    const cur = perfReadings();
    const d = diffReadings(cur, base.readings);
    return Object.assign(head, {
        available: true, reason: '',
        baselineAt: numOrNull(base.at) || 0,
        compare: d.compare,
        regressions: d.regressions,
        improvements: d.improvements,
        missing: d.missing,
        note: '回归 ' + d.regressions.length + ' 项 · 改善 ' + d.improvements.length + ' 项 · 未采集/已被删的量 '
            + d.missing.length + ' 项（**不计回归**：基线是开发期合成库，实时读数与它量级不同属正常；'
            + '严格判定见 node scripts/check-perf-baseline.js）· 耗时 / 时刻只记录，不参与判定',
    });
}

/**
 * 一行摘要（≤120 字）。
 * @param {object} [stateLike]
 * @returns {string}
 */
export function perfReportText(stateLike) {
    return perfReport(stateLike).text;
}
