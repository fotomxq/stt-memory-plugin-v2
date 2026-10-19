// ============================================================
// core/scan-throttle.js —— **全量操作节流 + 处处可观测**（v3.50.28，`docs/D22` §4.28 W28 `技-28`）
//
// 用户当轮授权（`docs/D22` W5 范围裁决）：先做 `技-28`（全量操作节流与可观测）+ `技-29`（删除口径对账收口）。
//   `技-38`（扫描收敛）与 `数-26`（索引化）随后，`技-28` 是它们的前置（本轮同时**修正清单里 技-28 ↔ 技-38 的成环**）。
//
// `docs/D28` §7 的 4 条要求，逐条对应本模块：
//   ① **最短间隔 + 最大间隔**：同一操作在 `minMs` 内再次发起 → **拒绝**（`reason:'too-soon'`，除非显式 `force`）；
//      距上次成功超过 `maxMs` → `overdue()` 如实报「该做而没做」（**只提示，不自动跑**）；
//   ② **每次如实记录**：`items`（扫描条目数）/ `dims`（跨维度数）/ `ms`（耗时）/ `hits`（命中）/ `remaining`（余量）
//      —— **不含正文**，只有计数与时长（与 `数-31` 的只读读数同口径）；
//   ③ **单次扫描上限 + 超限分批留痕**：`chunk()` 累加，超过 `capItems` → 标 `needMore` 并记一次 `batch` 留痕
//      （不丢计数，不吞「还没扫完」这个事实）；
//   ④ **不阻塞注入**：本模块**只做记账与闸门**，不发起任何扫描、不 await 任何 I/O；拒绝时调用方按「跳过」降级
//      （扫描类操作都可跳过；注入路径不在此列，见 v3.49.0 的延迟检查）。
//
// 设计取径：**纯内存记账**（不写 `state`、不涉 `DATA_VERSION`）—— 它是运行期观测面，不是业务数据。
//   会话内统计；跨会话的「到期」判断按进程启动时间计（如实登记该边界）。
// ============================================================

/** 单次扫描的默认参数（各操作可覆盖） */
export const SCAN_DEFAULTS = Object.freeze({
    minMs: 30 * 1000,          // 最短间隔：30s 内重复发起 → 拒绝
    maxMs: 6 * 60 * 60 * 1000, // 最大间隔：6h 未做 → 到期提示
    capItems: 20000,           // 单次扫描上限（超过即标记「需分批」并留痕）
});

/**
 * 已登记的全量 / 重负载操作。
 *   `minMs` / `maxMs` / `capItems` 可逐操作覆盖；`label` 供读数与日志（人读）。
 */
export const SCAN_OPS = Object.freeze({
    nsfwScan: { label: 'NSFW 全库扫描', minMs: 20 * 1000, maxMs: 2 * 60 * 60 * 1000, capItems: 20000 },
    dataHealth: { label: '数据体检', minMs: 30 * 1000, maxMs: 12 * 60 * 60 * 1000, capItems: 50000 },
    repairScan: { label: '修复扫描', minMs: 30 * 1000, maxMs: 12 * 60 * 60 * 1000, capItems: 50000 },
    relations: { label: '关系派生', minMs: 10 * 1000, maxMs: 6 * 60 * 60 * 1000, capItems: 20000 },
});

/** 读数保留的最近运行条数（内存恒定，不随会话增长） */
export const SCAN_KEEP = 20;

const bootAt = Date.now();
/** 每个操作的状态：`{ at, ok, items, dims, ms, hits, remaining, batches, needMore, refused, lastReason }` */
const stats = Object.create(null);
/** 最近运行（每操作环形 ≤ `SCAN_KEEP`；只存计数与时长，**不含正文**） */
const recent = Object.create(null);
/** 进行中的运行（`op → {runId, startedAt, items, dims, hits, batches, needMore}`） */
const active = Object.create(null);
let seq = 0;

/** 时间源（可注入，供测试） */
let nowFn = () => Date.now();
/**
 * 注入时间源（测试用；生产不调）。
 * @param {{now?:Function}} next
 */
export function setScanHooks(next) {
    const n = next || {};
    if (typeof n.now === 'function') nowFn = n.now;
    return true;
}

/** 操作参数（缺省回落 `SCAN_DEFAULTS`，未登记的操作按默认处理并标 `unknown:true`） */
export function scanOpConf(op) {
    const id = String(op || '');
    const c = SCAN_OPS[id];
    const base = c || SCAN_DEFAULTS;
    return {
        id: id,
        label: c ? c.label : id,
        known: !!c,
        minMs: Math.max(0, Number(base.minMs) || SCAN_DEFAULTS.minMs),
        maxMs: Math.max(0, Number(base.maxMs) || SCAN_DEFAULTS.maxMs),
        capItems: Math.max(1, Number(base.capItems) || SCAN_DEFAULTS.capItems),
    };
}

/** 记账一条运行（环形，去正文） */
function note(op, row) {
    const list = recent[op] || (recent[op] = []);
    list.push(row);
    while (list.length > SCAN_KEEP) list.shift();
}

/** 一次运行的只读快照 */
function emptyStat() {
    return { at: 0, ok: false, items: 0, dims: 0, ms: 0, hits: 0, remaining: 0, batches: 0, needMore: false, refused: 0, lastReason: '' };
}

/**
 * **发起一次全量操作**（闸门）。
 *
 * @param {string} op 操作 id（见 `SCAN_OPS`）
 * @param {{force?:boolean}} [opts] `force:true` = 用户显式动作，跳过硬性最短间隔（仍记账）
 * @returns {{go:boolean, runId:number, reason:string, sinceLastMs:number, conf:object}}
 *   `reason`：`ok` / `too-soon` / `running`
 */
export function scanBegin(op, opts) {
    const o = opts || {};
    const id = String(op || '');
    const conf = scanOpConf(id);
    const t = Number(nowFn()) || Date.now();
    const st = stats[id] || (stats[id] = emptyStat());
    if (active[id]) { st.refused += 1; st.lastReason = 'running'; return { go: false, runId: 0, reason: 'running', sinceLastMs: 0, conf: conf }; }
    const sinceLastMs = st.at ? Math.max(0, t - st.at) : Infinity;
    if (!o.force && st.at && sinceLastMs < conf.minMs) {
        st.refused += 1;
        st.lastReason = 'too-soon';
        return { go: false, runId: 0, reason: 'too-soon', sinceLastMs: sinceLastMs, conf: conf };
    }
    const runId = ++seq;
    active[id] = { runId: runId, startedAt: t, items: 0, dims: 0, hits: 0, batches: 0, needMore: false };
    return { go: true, runId: runId, reason: 'ok', sinceLastMs: sinceLastMs, conf: conf };
}

/**
 * **累加一段扫描量**（分批场景反复调用）。
 * 超过 `capItems` → 标 `needMore` 并记一次 `batch` 留痕（**不丢计数、不吞事实**）。
 * @returns {{items:number, needMore:boolean}} 累计条目数与「是否已超单次上限」
 */
export function scanChunk(op, runId, part) {
    const id = String(op || '');
    const a = active[id];
    if (!a || a.runId !== Number(runId)) return { items: 0, needMore: false };
    const p = part || {};
    a.items += Math.max(0, Number(p.items) || 0);
    a.dims = Math.max(a.dims, Math.max(0, Number(p.dims) || 0));
    a.hits += Math.max(0, Number(p.hits) || 0);
    const cap = scanOpConf(id).capItems;
    if (a.items >= cap) {
        a.needMore = true;
        a.batches += 1;
    }
    return { items: a.items, needMore: a.needMore };
}

/**
 * **结束一次全量操作**（如实落账）。
 * @param {object} [final] `{items, dims, ms, hits, remaining}`（未给则用累加值；`ms` 未给则按起始时刻算）
 * @returns {object} 本次运行的读数（不含正文）
 */
export function scanEnd(op, runId, final) {
    const id = String(op || '');
    const a = active[id];
    if (!a || a.runId !== Number(runId)) return null;
    delete active[id];
    const f = final || {};
    const t = Number(nowFn()) || Date.now();
    const st = stats[id] || (stats[id] = emptyStat());
    const ms = Math.max(0, Number(f.ms != null ? f.ms : (t - a.startedAt)) || 0);
    const items = Math.max(0, Number(f.items != null ? f.items : a.items) || 0);
    const row = {
        at: t, ok: f.ok !== false,
        items: items, dims: Math.max(0, Number(f.dims != null ? f.dims : a.dims) || 0),
        ms: ms, hits: Math.max(0, Number(f.hits != null ? f.hits : a.hits) || 0),
        remaining: Math.max(0, Number(f.remaining) || 0),
        batches: a.batches, needMore: a.needMore, refused: st.refused, lastReason: f.ok === false ? 'failed' : 'ok',
    };
    stats[id] = row;
    note(id, { at: row.at, ms: row.ms, items: row.items, dims: row.dims, hits: row.hits, batches: row.batches, needMore: row.needMore, ok: row.ok });
    return Object.assign({}, row);
}

/** 单操作读数（只读） */
export function scanStatOf(op) {
    const id = String(op || '');
    const st = stats[id];
    const conf = scanOpConf(id);
    const t = Number(nowFn()) || Date.now();
    const sinceLastMs = st && st.at ? Math.max(0, t - st.at) : Infinity;
    return {
        id: id, label: conf.label, known: conf.known, conf: { minMs: conf.minMs, maxMs: conf.maxMs, capItems: conf.capItems },
        running: !!active[id], sinceLastMs: sinceLastMs,
        overdue: !!st && st.at > 0 && sinceLastMs > conf.maxMs,
        stat: st ? Object.assign({}, st) : emptyStat(),
        recent: (recent[id] || []).slice(),
    };
}

/** 全部操作读数（只读；诊断 / 桥 / 面板共用同一形状） */
export function scanStats() {
    const out = { at: Number(nowFn()) || Date.now(), bootAt: bootAt, ops: [] };
    for (const id of Object.keys(SCAN_OPS)) out.ops.push(scanStatOf(id));
    return out;
}

/**
 * **到期如实提示**：距上次成功超过 `maxMs` 的操作（`st.at === 0` = 从未跑过 → **不算到期**，避免开机就报一堆）。
 * @returns {Array<{id:string, label:string, overdueMs:number}>}
 */
export function scanOverdue() {
    const t = Number(nowFn()) || Date.now();
    const out = [];
    for (const id of Object.keys(SCAN_OPS)) {
        const st = stats[id];
        if (!st || !st.at) continue;
        const conf = scanOpConf(id);
        const gap = t - st.at;
        if (gap > conf.maxMs) out.push({ id: id, label: conf.label, overdueMs: gap });
    }
    return out;
}

/** 一行读数文本（桥 / 日志 / 面板共用；**不含正文**） */
export function scanStatsText() {
    try {
        const parts = [];
        for (const id of Object.keys(SCAN_OPS)) {
            const s = scanStatOf(id);
            if (!s.stat.at) { parts.push(s.label + ' 未跑过'); continue; }
            parts.push(s.label + ' ' + s.stat.items + ' 条 / ' + s.stat.ms + 'ms'
                + (s.stat.hits ? (' / 命中 ' + s.stat.hits) : '')
                + (s.stat.batches ? (' / 分批 ' + s.stat.batches + (s.stat.needMore ? '（未扫完）' : '')) : '')
                + (s.overdue ? ' / **已到期**' : ''));
        }
        return parts.join(' · ');
    } catch (e) { return ''; }
}

/** 强制放行一次（用户显式动作；等价于 `scanBegin(op, {force:true})` 的语法糖） */
export function scanForce(op) { return scanBegin(op, { force: true }); }

/** 清空读数（测试 / 重置用；不影响进行中的运行） */
export function resetScanStats() {
    for (const k of Object.keys(stats)) delete stats[k];
    for (const k of Object.keys(recent)) delete recent[k];
    for (const k of Object.keys(active)) delete active[k];
    seq = 0;
    return true;
}
