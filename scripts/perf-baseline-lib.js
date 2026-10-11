// ============================================================
// scripts/perf-baseline-lib.js —— **性能基线的纯函数库**（v3.45.4 · `docs/D31` §4 · `技-39` · 台账 U191）
//
// 定位：把「基线门禁」里**所有可判定的部分**抽成纯函数，脚本（`perf-baseline.js` /
//   `check-perf-baseline.js`）只做 IO 与打印，单测直接断言这里 —— 于是门禁本身**可被门禁测**。
//   （同款做法见 `scripts/coverage-lib.js` / `scripts/ledger-sync-lib.js`；为什么不在单测里
//   跑 CLI：本机沙箱对 `node:child_process` 的管道捕获有限制，且 CLI 会重复跑一遍读数。）
//
// 门禁口径（**必须与两个 CLI 的头注一致**）：
//   ① 基线形状：`{ at, ver, readings:{write,read,scan,size}, note }`（落 `scripts/perf-baseline.json`）。
//   ② **棘轮只比「确定性量」**：条数 / 字节 / 计数（`count` `bytes` `items` `lines` `keys` …）。
//      **耗时（ms）只记录、不参与判定** —— 理由：本机耗时噪声大（同一份数据两次跑能差数倍、
//      受宿主负载与 JIT 预热影响），拿它当门禁必然 **flaky**：同样的代码时红时绿，门禁就会被绕过。
//   ③ 判定：确定性量**比基线大**（劣化）→ **失败**（非零退出，逐项 `基线 → 当前`）；
//      **比基线小**（改善）→ 只提示「可收紧」，**必须 `--write` 才写回**（不自动改）；
//      相等 → 通过；**基线有、当前没有**（量被静默删掉）→ **失败**（否则「少一个读数」会变成无声通过）。
//
// 零依赖（`docs/D21` Q5）：本文件不 import 任何 `node:` 内置，只用本地模块与语言内建。
// ============================================================
import { perfReadings, perfReset, setPerfHooks } from '../core/perf-probe.js';
import { readLedgerRecord, resetReadLedger } from '../core/read-ledger.js';
import { VERSION } from '../core/constants.js';

/** 基线文件的固定说明（写进 JSON 的 `note`，让读到文件的人知道这些数字从哪来） */
export const PERF_BASELINE_NOTE = '确定性合成库（无宿主）实测：条数 / 字节 / 计数参与棘轮；耗时（ms）为桩值，只记录、不判定';

/**
 * 确定性量的键名判据（与 `core/perf-probe.js#isTimingKey` **必须逐字一致**，由单测交叉锁定）。
 * 坑（踩过，别再改回去）：**不能**用 `/ms$/i` 判耗时 —— 维度名 `atoms` 以 `ms` 结尾，
 *   那样会让「原子数变多」这条最该被门禁抓住的劣化**整个漏出棘轮**；只认驼峰 `…Ms / …At / …Rate`
 *   与精确小写 `at / ms / lastAt / msNote`。
 */
function isTimingKey(key) {
    const s = String(key);
    if (s === 'at' || s === 'ms' || s === 'lastAt' || s === 'msNote') return true;
    return /(Ms|At|Rate)$/.test(s);
}
const COUNT_RE = /(count|bytes|items|lines|keys|ids|dims|rows|chars|total|writes|queued|done|failed|pending|inflight|maxinflight|reads|fail|miss)/i;
const CONTAINER_RE = /(^|\.)(items|counts|bylevel|dims)(\.|$)/i;
/** 追溯六字段（`docs/D31` §3.7）——不参与任何数值比对 */
const TRACE_KEYS = ['at', 'ver', 'window', 'cause', 'site', 'u'];

/** JSON 长度（只返回长度，不回正文） */
function jsonLen(v) { try { const s = JSON.stringify(v); return (typeof s === 'string') ? s.length : null; } catch (e) { return null; } }
/** 补零（合成 id 用） */
function pad(i, w) { return String(i).padStart(w, '0'); }
/** 展示：字节 / 毫秒 / 数字（null → 「未采集」，**不用 0 冒充**） */
function fb(v) { return (v == null || !Number.isFinite(Number(v))) ? '未采集' : (Number(v) < 1024 ? (Number(v) + 'B') : (Number(v) < 1048576 ? ((Number(v) / 1024).toFixed(1) + 'KB') : ((Number(v) / 1048576).toFixed(2) + 'MB'))); }
function fm(v) { return (v == null || !Number.isFinite(Number(v))) ? '未采集' : (Number(v) >= 1000 ? ((Number(v) / 1000).toFixed(2) + 's') : (Math.round(Number(v)) + 'ms')); }
function fn(v) { return (v == null || !Number.isFinite(Number(v))) ? '未采集' : String(Number(v)); }

/**
 * 造**确定性合成库**（脚本内自造，不用宿主；两次运行逐字节一致）。
 * 规模刻意贴近真机画像（`docs/D13` / `D28`：快照链占比高、墓碑多、关联层大），
 * 这样四类读数才有参考价值；内容全部是「合成…」字样，**不含任何真实数据**。
 * @param {{atoms?:number}} [opts] `atoms` 原子条数（缺省 300）
 * @returns {object} 形如 `core/state.js#emptyState` 的状态对象
 */
export function makeSyntheticState(opts) {
    const o = opts || {};
    const nAtoms = Math.max(1, Math.floor(Number(o.atoms) || 300));
    const st = {
        version: VERSION,
        scope: 'char:synthetic-baseline',
        state: { time: '第 12 日 08:30', date: '2026-10-10', location: '合成地点', sceneFocus: null },
        protagonist: { name: '合成主角' },
        vars: {}, varTemplates: { global: { json: {} }, char: { json: {} }, chat: { json: {} } },
        summaries: [], processedFloors: [], processedDropped: [],
        stats: { plansClosed: 3, suspenseResolved: 2 },
        updatedAt: 0,
    };
    st.atoms = [];
    for (let i = 1; i <= nAtoms; i++) st.atoms.push({ id: 'at' + pad(i, 4), t: '合成情节 ' + pad(i, 4), txt: '合成原子内容 ' + pad(i, 4) + '（基线测量用，非真实数据）', floor: i, h: 'h' + pad(i, 4) });
    st.memories = [];
    for (let i = 1; i <= 120; i++) st.memories.push({ id: 'mem' + pad(i, 4), who: '角色' + ((i % 7) + 1), what: '合成记忆 ' + pad(i, 4) + '（基线测量用）', floor: i * 2, h: 'm' + pad(i, 4) });
    st.currentStates = [];
    for (let i = 1; i <= 30; i++) st.currentStates.push({ id: 'cs' + pad(i, 3), dim: '状态维度' + ((i % 6) + 1), val: '合成状态值 ' + pad(i, 3) });
    st.snapshots = [];
    for (let i = 1; i <= 40; i++) st.snapshots.push({ id: 'snap' + pad(i, 3), at: '第 ' + i + ' 日', txt: '合成快照摘要 ' + pad(i, 3) });
    st.items = [];
    for (let i = 1; i <= 25; i++) st.items.push({ id: 'it' + pad(i, 3), name: '合成物品 ' + pad(i, 3), qty: (i % 5) + 1, desc: '合成物品描述 ' + pad(i, 3) });
    st.plans = [];
    for (let i = 1; i <= 12; i++) st.plans.push({ id: 'pl' + pad(i, 3), content: '合成计划 ' + pad(i, 3) + '（基线测量用）', status: (i % 3) ? 'open' : 'done' });
    st.suspense = [];
    for (let i = 1; i <= 8; i++) st.suspense.push({ id: 'su' + pad(i, 3), content: '合成悬念 ' + pad(i, 3), status: 'open' });
    st.concepts = [];
    for (let i = 1; i <= 20; i++) st.concepts.push({ id: 'co' + pad(i, 3), name: '合成概念 ' + pad(i, 3), desc: '合成概念说明 ' + pad(i, 3) });
    st.scenes = [];
    for (let i = 1; i <= 15; i++) st.scenes.push({ id: 'sc' + pad(i, 3), name: '合成场景 ' + pad(i, 3), pathArr: ['合成地点', '子区 ' + pad(i, 2)], pathStr: '合成地点>子区 ' + pad(i, 2), desc: '合成场景描述 ' + pad(i, 3) });
    st.npcs = [];
    for (let i = 1; i <= 10; i++) st.npcs.push({ id: 'np' + pad(i, 3), name: '合成 NPC ' + pad(i, 3), title: '合成头衔 ' + pad(i, 3) });
    st.parallels = [];
    for (let i = 1; i <= 6; i++) st.parallels.push({ id: 'pa' + pad(i, 3), content: '合成平行事件 ' + pad(i, 3) });
    st.rumors = [];
    for (let i = 1; i <= 5; i++) st.rumors.push({ id: 'ru' + pad(i, 3), subject: '合成传言主体 ' + pad(i, 3), claim: '合成说法 ' + pad(i, 3) });
    st.plotSegments = [];
    for (let i = 1; i <= 20; i++) st.plotSegments.push({ id: 'ps' + pad(i, 3), range: '第 ' + (i * 5) + '–' + (i * 5 + 4) + ' 楼', txt: '合成情节分段 ' + pad(i, 3) });
    st.links = [];
    for (let i = 1; i <= 240; i++) st.links.push({ from: 'at' + pad(((i - 1) % nAtoms) + 1, 4), to: 'mem' + pad(((i - 1) % 120) + 1, 4), dim: 'memories', kind: '知情' });
    st.deleted = { atoms: {}, memories: {} };
    for (let i = 1; i <= 50; i++) st.deleted.atoms['del-a' + pad(i, 4)] = 1700000000000 + i;
    for (let i = 1; i <= 30; i++) st.deleted.memories['del-m' + pad(i, 4)] = 1700000000000 + i;
    st.deletedH = { atoms: {} };
    for (let i = 1; i <= 40; i++) st.deletedH.atoms['delh-' + pad(i, 4)] = 1700000000000 + i;
    st.snapStore = [];
    for (let i = 1; i <= 30; i++) {
        const atomsMap = {};
        for (let j = 1; j <= 25; j++) atomsMap['at' + pad(((i * 7 + j) % nAtoms) + 1, 4)] = { h: 'sh' + pad(j, 3), cat: 'atoms' };
        st.snapStore.push({ id: 'store' + pad(i, 3), kind: i === 1 ? 'root' : 'incr', ts: 1700000000000 + i * 1000, baseId: i === 1 ? '' : 'store' + pad(i - 1, 3), hash: 'storehash' + pad(i, 3), atomsHashes: atomsMap });
    }
    return st;
}

/** 合成「分片」视图（8 片，真实切片 → 长度是真量出来的，不是编的） */
function shardsOf(st) {
    const k = Math.ceil((st.atoms || []).length / 4) || 1;
    return {
        shard_atoms_1: (st.atoms || []).slice(0, k),
        shard_atoms_2: (st.atoms || []).slice(k, k * 2),
        shard_memories_1: (st.memories || []).slice(0, 60),
        shard_memories_2: (st.memories || []).slice(60),
        shard_links_1: (st.links || []).slice(0, 120),
        shard_links_2: (st.links || []).slice(120),
        shard_scenes: st.scenes || [],
        shard_plans: st.plans || [],
    };
}
/** 合成「副本」视图（本机缓冲 + 对端镜像，同样是真实序列化长度） */
function copiesOf(st) {
    const local = {};
    for (const k of ['atoms', 'memories', 'items', 'plans', 'suspense', 'concepts', 'scenes', 'npcs', 'parallels', 'rumors', 'plotSegments', 'links']) local[k] = st[k] || [];
    return { localBuffer: local, mirrorShards: shardsOf(st) };
}

/** 体积模型：主文件 / 分片 / 副本 / 快照链 / 一次保存的物理写字节（全部由真实序列化长度算出） */
function byteModelOf(st) {
    const mainBytes = jsonLen(st) || 0;
    const shardBytes = jsonLen(shardsOf(st)) || 0;
    const copyBytes = jsonLen(copiesOf(st)) || 0;
    const snapBytes = jsonLen(st.snapStore || []) || 0;
    return { mainBytes: mainBytes, shardBytes: shardBytes, copyBytes: copyBytes, snapBytes: snapBytes, saveBytes: mainBytes + shardBytes + snapBytes + copyBytes };
}

/** 合成全量点读数：条目数是**真实数数**，耗时**不伪造**（`ms:null` + 说明） */
function syntheticScanProbe(st) {
    const dims = ['atoms', 'memories', 'currentStates', 'snapshots', 'items', 'plans', 'suspense', 'concepts', 'scenes', 'npcs', 'parallels', 'rumors', 'plotSegments', 'links', 'deleted'];
    let all = 0;
    for (const k of dims) all += Array.isArray(st[k]) ? st[k].length : Object.keys(st[k] || {}).length;
    return {
        ms: null,
        points: [
            { site: 'scripts/perf-baseline-lib.js#scanAtoms', items: (st.atoms || []).length, ms: null },
            { site: 'scripts/perf-baseline-lib.js#scanMemories', items: (st.memories || []).length, ms: null },
            { site: 'scripts/perf-baseline-lib.js#scanAll', items: all, ms: null },
        ],
        note: '合成库全量点：条目数为真实计数，耗时未采集（不伪造）',
    };
}

/** 往读取台账里灌**合成记录**（走真实 API `readLedgerRecord`，`quiet` 不镜像调试日志） */
function seedReadLedger() {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push({ action: '读主文件', src: 'file', ok: true, bytes: 47000, items: 300, ms: 3 + i });
    for (let i = 1; i <= 4; i++) rows.push({ action: '读分片', src: 'shard', ok: true, bytes: 5200, items: 40, ms: 4 + i });
    for (let i = 1; i <= 2; i++) rows.push({ action: '读分片清单', src: 'meta', ok: true, bytes: 900, items: 8, ms: 2 + i });
    for (let i = 1; i <= 2; i++) rows.push({ action: '读本机缓冲', src: 'local', miss: true, bytes: 0, ms: 1 + i });
    rows.push({ action: '读本机内存库', src: 'idb', ok: false, reason: 'load-failed', bytes: 0, ms: 9 });
    rows.push({ action: '读扩展设置', src: 'settings', ok: true, bytes: 400, items: 1, ms: 2 });
    for (const r of rows) readLedgerRecord(Object.assign({ quiet: true, at: 1700000000000 }, r));
    return rows.length;
}

/**
 * 装上合成钩子（时钟 / 写队列 / 分片副本 / 全量点 + 重置探针与台账）。
 * 时钟是**确定性计数器**（固定基准逐调用 +1）：`at` 字段完全可复现，且**不参与门禁**。
 * @param {object} [state] 合成状态（缺省 `makeSyntheticState()`）
 * @returns {Function} 还原钩子的函数（调用方务必在 finally 里调）
 */
export function installSyntheticHooks(state) {
    const st = state || makeSyntheticState();
    const bytes = byteModelOf(st);
    let tick = 1700000000000;
    perfReset();
    resetReadLedger();
    seedReadLedger();
    setPerfHooks({
        now: () => (tick += 1),
        listTrace: () => [],
        getBaseline: () => null,
        readLedger: null,                      // 缺省 → 直接复用 core/read-ledger.js#readLedgerStats（同源）
        writeStats: () => ({
            queued: 41, done: 40, failed: 1, pending: 0, inFlight: 0, maxInFlight: 1,
            bytes: bytes.saveBytes, waitMs: null,
            last: { id: 40, label: 'kv-put:SPreset_FTTMemory_<scope>', ms: 12, at: 1700000000000, ok: true },
            lastSlow: null,
        }),
        sizes: () => ({ shardBytes: bytes.shardBytes, copyBytes: bytes.copyBytes, note: '合成分片 8 片 / 副本 2 份（真实序列化长度）' }),
        scanProbe: (s) => syntheticScanProbe(s),
    });
    return () => setPerfHooks({ now: null, listTrace: null, getBaseline: null, readLedger: null, writeStats: null, sizes: null, scanProbe: null });
}

/**
 * 在「合成钩子已装上」的前提下跑一段逻辑（统一入口：基线与门禁因此走**同一条代码路径**）。
 * @param {object|null} state 合成状态（null → 现造一份）
 * @param {(st:object)=>any} fn 要做的事（读数 / 清单 / 摘要都在这段里采）
 * @returns {any} `fn` 的返回
 */
export function withSynthetic(state, fn) {
    const st = state || makeSyntheticState();
    const restore = installSyntheticHooks(st);
    try { return fn(st); } finally { restore(); }
}

/**
 * 采集当前读数（= 基线的「当前」一侧）。**同一份代码路径**给基线与门禁用，避免两侧口径漂移。
 * @param {object} [state]
 * @returns {{state:object, readings:object}} `readings` 为 `perfReadings()` 的原始返回（含六字段）
 */
export function collectCurrent(state) {
    return withSynthetic(state || null, (st) => ({ state: st, readings: perfReadings(st) }));
}

/** 只取四类读数（基线文件按此落盘：六字段在文件顶层，不重复进 `readings`） */
export function pickReadings(readings) {
    const r = readings || {};
    return { write: r.write, read: r.read, scan: r.scan, size: r.size };
}

/** 摊平四类读数里的**确定性量**：`{path: number}`（耗时 / 平均 / 比率 / 时刻一律跳过） */
export function collectDeterministic(readings) {
    const out = {};
    const walk = (obj, path, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 4) return;
        for (const k of Object.keys(obj)) {
            if (depth === 0 && TRACE_KEYS.indexOf(k) >= 0) continue;
            const v = obj[k];
            const p = path ? (path + '.' + k) : k;
            if (typeof v === 'number' && Number.isFinite(v)) {
                if (isTimingKey(k)) continue;                                     // 耗时 / 时刻：只记录
                if (COUNT_RE.test(k) || CONTAINER_RE.test(path)) out[p] = v;      // 条数 / 字节 / 计数
                continue;
            }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length && i < 32; i++) walk(v[i], p + '.' + i, depth + 1);
                continue;
            }
            walk(v, p, depth + 1);
        }
    };
    walk(readings || {}, '', 0);
    return out;
}

/**
 * 与基线比对（**只增不降**棘轮；纯函数，脚本与单测共用）。
 * @param {object} current 当前四类读数（`perfReadings()` 的返回或其 `pickReadings` 子集）
 * @param {object} baseline 基线里的 `readings`
 * @returns {{available:boolean, keys:Array, regressions:Array, improvements:Array, added:Array, ok:boolean, note:string}}
 *   `keys[].verdict`：`same` 相等 · `worse` 劣化（失败）· `better` 改善（可收紧）· `missing` 基线量在当前缺失（失败）· `new` 当前新增量（不判定）
 */
export function compareToBaseline(current, baseline) {
    const cur = collectDeterministic(current);
    const base = collectDeterministic(baseline);
    const keys = [], regressions = [], improvements = [], added = [];
    for (const path of Object.keys(base)) {
        const bv = base[path];
        const has = Object.prototype.hasOwnProperty.call(cur, path);
        const cv = has ? cur[path] : null;
        const delta = has ? (cv - bv) : null;
        let verdict = 'same';
        if (!has) verdict = 'missing';
        else if (delta > 0) verdict = 'worse';
        else if (delta < 0) verdict = 'better';
        const item = { path: path, baseline: bv, current: cv, delta: delta, verdict: verdict };
        keys.push(item);
        if (verdict === 'worse' || verdict === 'missing') regressions.push(item);
        else if (verdict === 'better') improvements.push(item);
    }
    for (const path of Object.keys(cur)) {
        if (Object.prototype.hasOwnProperty.call(base, path)) continue;
        const item = { path: path, baseline: null, current: cur[path], delta: null, verdict: 'new' };
        keys.push(item);
        added.push(item);
    }
    const cmp = (a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
    keys.sort(cmp); regressions.sort(cmp); improvements.sort(cmp); added.sort(cmp);
    const empty = Object.keys(base).length === 0;
    return {
        available: !empty,
        keys: keys, regressions: regressions, improvements: improvements, added: added,
        ok: !empty && regressions.length === 0,
        note: empty
            ? '基线里没有任何可比对的确定性量（基线损坏或为空）——门禁按失败处理'
            : ('比对 ' + keys.length + ' 项确定性量：回归 ' + regressions.length + ' · 改善 ' + improvements.length + ' · 新增 ' + added.length),
    };
}

/** 逐项对比文本（`基线 → 当前`；CLI 与单测共用同一份口径） */
export function formatCompareLines(res) {
    const out = [];
    out.push('性能基线门禁（技-39 / U191）：' + (res && res.note ? res.note : '无可比对量'));
    out.push('  口径：只比「确定性量」（条数 / 字节 / 计数）；**耗时（ms）只记录、不参与判定**（本机耗时噪声大，用它当门禁必然 flaky）');
    for (const it of (res.regressions || [])) {
        out.push('  ❌ 劣化 ' + it.path + '：基线 ' + it.baseline + ' → 当前 ' + (it.current == null ? '（该量缺失）' : it.current)
            + '（' + (it.delta == null ? '无法核对' : ((it.delta > 0 ? '+' : '') + it.delta)) + '）');
    }
    for (const it of (res.improvements || [])) {
        out.push('  ℹ️ 可收紧 ' + it.path + '：基线 ' + it.baseline + ' → 当前 ' + it.current + '（' + it.delta + '；加 --write 才写回，不自动改）');
    }
    for (const it of (res.added || [])) {
        out.push('  ＋ 新增 ' + it.path + ' = ' + it.current + '（基线无此量，不判定；--write 可纳入）');
    }
    const same = (res.keys || []).length - (res.regressions || []).length - (res.improvements || []).length - (res.added || []).length;
    out.push('  相等 ' + same + ' 项' + (res.ok ? '' : ' · 结论：**不通过**（确定性量不得比基线大，也不得缺失）'));
    return out;
}

/** 组装一份基线对象（`--write` 用；`readings` 只放四类，六字段在顶层） */
export function baselineOf(readings, note) {
    return {
        at: Date.now(),
        ver: VERSION,
        readings: pickReadings(readings),
        note: String(note == null ? PERF_BASELINE_NOTE : note),
    };
}

/** 四类读数的人读文本（两个 CLI 共用；缺数据源时**如实**打印 reason） */
export function formatReadings(rd) {
    const r = rd || {};
    const w = r.write || {}, q = r.read || {}, s = r.scan || {}, z = r.size || {};
    const out = [];
    out.push('  写入（write）：' + (w.ok
        ? ('物理写 ' + fn(w.writes) + ' 次（排队 ' + fn(w.queued) + ' / 失败 ' + fn(w.failed) + ' / 积压 ' + fn(w.pending) + ' / 峰值并发 ' + fn(w.maxInFlight) + '）· 写字节 ' + fb(w.bytes) + ' · 最近一次 ' + fm(w.lastMs) + ' · 通道 ' + (w.channel || '—'))
        : ('ok=false · reason=' + (w.reason || '') + ' · ' + (w.note || ''))));
    out.push('  读取（read）：' + (q.ok
        ? ('台账 ' + fn(q.totalReads) + ' 次（成功 ' + fn(q.okReads) + ' / 失败 ' + fn(q.fail) + ' / 未命中 ' + fn(q.miss) + '）· 累计 ' + fm(q.totalMs) + ' · 平均 ' + fm(q.avgMs) + ' · ' + fb(q.totalBytes) + '（同源 core/read-ledger.js#readLedgerStats）')
        : ('ok=false · reason=' + (q.reason || '') + ' · ' + (q.note || ''))));
    out.push('  扫描（scan）：' + (s.ok
        ? ('合计 ' + fn(s.total) + ' 条 · 耗时 ' + (s.ms == null ? '未采集' : fm(s.ms)) + ' · 全量点 ' + ((s.points || []).length) + ' 个')
        : ('ok=false · reason=' + (s.reason || '') + ' · ' + (s.note || ''))));
    if (s.ok && s.note) out.push('    · ' + s.note);
    if (s.ok && s.items) {
        const parts = [];
        for (const k of Object.keys(s.items)) if (Number(s.items[k]) > 0) parts.push(k + ' ' + s.items[k]);
        out.push('    · ' + (parts.length ? parts.join(' · ') : '各维均为 0'));
    }
    out.push('  体积（size）：' + (z.ok
        ? ('主文件 ' + fb(z.mainBytes) + ' · 语义 ' + fb(z.semanticBytes) + ' · 派生 ' + fb(z.derivedBytes) + '（快照 ' + fn(z.snapCount) + ' 条 ' + fb(z.snapBytes) + ' / 墓碑 ' + fn(z.tombstoneKeys) + ' 键 / 关联 ' + fn(z.linkRows) + ' 行）· 分片 ' + fb(z.shardBytes) + ' · 副本 ' + fb(z.copyBytes) + ' · 合计 ' + fb(z.totalBytes))
        : ('ok=false · reason=' + (z.reason || '') + ' · ' + (z.note || ''))));
    if (z.ok && z.note) out.push('    · ' + z.note);
    return out;
}
