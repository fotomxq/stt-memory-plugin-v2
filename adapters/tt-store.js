// ============================================================
// adapters/tt-store.js —— 宿主 TauriTavern 原生存储（官方 Public Contract）
//
// 事实源（官方文档 / 宿主实现，2026-09 核对）：
//   · `docs/API/Extension.md`（TauriTavern 主仓库）：`window.__TAURITAVERN__.api.extension.store`
//     —— 扩展**全局**持久化：KV JSON（getJson / tryGetJson / setJson / updateJson / renameKey /
//     deleteJson / listKeys / listTables / deleteTable）+ Blob（getBlob / setBlob / deleteBlob / listBlobKeys）。
//   · `docs/API/README.md`：使用前 `await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__)`。
//   · `docs/API/Migration.md`：ST 扩展的**大数据**应迁到 store.*（「SillyTavern 从未提供标准的扩展数据持久化机制」）。
//   · 命名规则：namespace / table / key 仅允许 `[A-Za-z0-9_.-]`，非空，不以 `.` 开头。
//   · 落盘：`data_root/_tauritavern/extension-store/<ns>/kv/<table>/<key>.json` 与 `.../blobs/<table>/<key>`。
//   · 官方同步：TT-Sync / LAN Sync 的**默认数据集** `extensions.store` = 目录 `_tauritavern/extension-store`
//     （ttsync-core `dataset/profile.rs#TAURI_TAVERN_DEFAULT_DATASETS`），故写入此通道的数据**参与官方同步**，
//     增量判定依赖文件大小 + 修改时间（每个 key 一个独立文件 → 单 key 写入即一次原子发布）。
//
// 通道选型（官方建议：多数场景用 KV JSON，大文件才用 Blob）：
//   · 小载荷（清单 meta / 同步日志 log，< `TT_KV_MAX_BYTES`）→ **KV JSON**：
//     `tryGetJson` 自带 `{found}` 语义，未命中**不会**触发宿主报错（V1 v1.156 的教训）；
//   · 大载荷（记忆文件 / 备份 / 快照）→ **Blob**：`setBlob` 直收 `Uint8Array`，
//     省掉 base64 膨胀与 JSON 转义/格式化算力（官方明确推荐 Blob 用于「体积较大」的内容）。
//   · 宿主未提供 Blob 方法时**自动退回** KV（能力探测，不做配置开关）。
//
// 读取：先按「写入通道 / 上次命中通道」，再试另一通道；都未命中即回报未命中，
//   由上层 `adapters/file-transport.js` 回退酒馆用户目录文件（旧数据迁移与兼容）。
// 未命中抑制：KV 走 `tryGetJson` 的 found；Blob 无 tryGet，故用官方 `listBlobKeys` 判存在
//   （短 TTL 缓存 + 写入/删除即失效），避免对不存在的 key 调 `getBlob` 而留下宿主报错。
// ============================================================
import { cfg, dbgLog, notifyHooks } from '../core/model/runtime.js';
import { bytesToText, textToBytes, bytesToBase64, base64ToBytes, isGzipBytes, decodeBytesAuto } from './gzip.js';

/** V2 命名空间（官方命名规则内的稳定标识；与 V1 的 `ftt-files` 并存不冲突） */
export const TT_NS = 'ftt2-files';
/** V1 命名空间：**只读**兼容（V1 在 TauriTavern 上写入的数据迁移入口） */
export const TT_LEGACY_NS = 'ftt-files';
/** 默认主表（官方默认 `main`，与 V1 落盘路径一致） */
export const TT_TABLE = 'main';
/** 小于该字节数的载荷走 KV JSON，否则走 Blob */
export const TT_KV_MAX_BYTES = 96 * 1024;
/** 宿主就绪等待上限（官方 quick start 的 ready 等待） */
export const TT_READY_TIMEOUT_MS = 8000;
/** 未命中负缓存 TTL（同一 key 短期内不再重复探测） */
export const TT_MISS_TTL_MS = 30000;
/** Blob 存在性列表缓存 TTL（`listBlobKeys` 是目录读，短缓存即可，写入/删除即失效） */
export const TT_LIST_TTL_MS = 3000;
/** 官方 key 命名规则 */
export const TT_KEY_RE = /^[A-Za-z0-9_.-]+$/;

let hostCache = null;
let readyPromise = null;
let announced = false;
let lastError = '';
let lastOkAt = 0;
let lastReason = '';
const stats = { writes: 0, kvWrites: 0, blobWrites: 0, reads: 0, misses: 0, listCalls: 0, fallbacks: 0 };
const missCache = Object.create(null);      // `${ns}\u0000${key}` → 判定时间
const listCache = Object.create(null);      // `${ns}/${table}` → { at, keys: string[] }
const writeChannel = Object.create(null);   // `${ns}\u0000${key}` → 'kv' | 'blob'
/** 上一次原生调用是否失败（供通道状态行/诊断如实呈现） */
export function ttLastError() { try { return { err: lastError, at: lastOkAt, reason: lastReason }; } catch (e) { return { err: lastError, at: 0, reason: lastReason }; } }

/** 测试/诊断用：清空本会话缓存与计数（不改宿主数据） */
export function ttResetSession() {
    hostCache = null;
    readyPromise = null;
    announced = false;
    lastError = '';
    lastOkAt = 0;
    lastReason = '';
    stats.writes = 0; stats.kvWrites = 0; stats.blobWrites = 0;
    stats.reads = 0; stats.misses = 0; stats.listCalls = 0; stats.fallbacks = 0;
    for (const k of Object.keys(missCache)) delete missCache[k];
    for (const k of Object.keys(listCache)) delete listCache[k];
    for (const k of Object.keys(writeChannel)) delete writeChannel[k];
    return true;
}

/** 清空未命中/列表缓存（「立即同步」「刷新状态」= 取真值 → 绕开缓存） */
export function ttDropCaches() {
    for (const k of Object.keys(missCache)) delete missCache[k];
    listCacheDropAll();
    return true;
}

// ==================== 宿主探测 ====================
/** 候选宿主对象（window / globalThis / top —— 扩展可能运行在 iframe 内） */
export function ttHostList() {
    try {
        if (hostCache) return hostCache;
        const list = [];
        const push = (h) => { try { if (h && list.indexOf(h) < 0) list.push(h); } catch (e) { /* 忽略 */ } };
        try { push(typeof globalThis !== 'undefined' ? globalThis : null); } catch (e) { /* 忽略 */ }
        try { push(typeof window !== 'undefined' ? window : null); } catch (e) { /* 忽略 */ }
        try { push(typeof window !== 'undefined' && window ? window.top : null); } catch (e) { /* 忽略 */ }
        hostCache = list;
        return list;
    } catch (e) { return []; }
}

/** 平台 ABI（`window.__TAURITAVERN__`） */
export function ttAbi() {
    try {
        for (const h of ttHostList()) {
            try { if (h && h.__TAURITAVERN__) return h.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 忽略 */ }
    return null;
}

/** 宿主运行特征（API 尚未就绪的早期阶段也能识别出「这是 TauriTavern」） */
export function ttFeatureSeen() {
    try {
        for (const h of ttHostList()) {
            try {
                if (!h) continue;
                if (h.__TAURITAVERN_MAIN_READY__ || h.__TAURI_RUNNING__ || h.__TAURITAVERN_PERF_READY__) return true;
                if (h.__TAURI__ || h.__TAURI_INTERNALS__) return true;
            } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 忽略 */ }
    return false;
}

/** 官方 KV/Blob 契约对象（`api.extension.store`） */
export function ttStoreApi() {
    try {
        const abi = ttAbi();
        const st = abi && abi.api && abi.api.extension && abi.api.extension.store;
        if (st && typeof st.setJson === 'function' && (typeof st.tryGetJson === 'function' || typeof st.getJson === 'function')) return st;
    } catch (e) { /* 忽略 */ }
    return null;
}

/** Blob 能力（官方可选方法齐备才算可用 —— 缺失即自动退回 KV） */
export function ttBlobApi() {
    try {
        const st = ttStoreApi();
        if (st && typeof st.setBlob === 'function' && typeof st.getBlob === 'function' && typeof st.deleteBlob === 'function' && typeof st.listBlobKeys === 'function') return st;
    } catch (e) { /* 忽略 */ }
    return null;
}

/** 宿主是否被识别为 TauriTavern（含 API 未就绪阶段） */
export function ttDetected() { try { return !!ttStoreApi() || !!ttAbi() || ttFeatureSeen(); } catch (e) { return false; } }

/** 配置：auto（默认，检测到即切换）/ on（强制）/ off（始终用酒馆用户目录文件） */
export function tauriNativeSetting() {
    try { const v = cfg && cfg.storage && cfg.storage.tauriNative; return (v === 'on' || v === 'off') ? v : 'auto'; } catch (e) { return 'auto'; }
}
/** 是否**应当**走原生通道 */
export function ttNativeOn() {
    const s = tauriNativeSetting();
    if (s === 'off') return false;
    if (s === 'on') return true;
    return ttDetected();
}
/** 是否**真的**可用原生通道（API 在位） */
export function ttNativeActive() { try { return ttNativeOn() && !!ttStoreApi(); } catch (e) { return false; } }
/** 是否开启「原生模式下同时镜像写一份酒馆文件」 */
export function ttMirrorToFiles() { try { return !!(cfg && cfg.storage && cfg.storage.tauriMirror); } catch (e) { return false; } }

/** 等待宿主就绪（官方 quick start；超时按未就绪处理，不抛错） */
export function ttEnsureReady(ms) {
    try {
        const abi = ttAbi();
        let p = abi && abi.ready;
        if (!p || typeof p.then !== 'function') {
            try {
                for (const h of ttHostList()) {
                    if (h && h.__TAURITAVERN_MAIN_READY__ && typeof h.__TAURITAVERN_MAIN_READY__.then === 'function') { p = h.__TAURITAVERN_MAIN_READY__; break; }
                }
            } catch (e) { /* 忽略 */ }
        }
        if (!p || typeof p.then !== 'function') return Promise.resolve(true);
        if (!readyPromise) {
            const limit = Number(ms) > 0 ? Number(ms) : TT_READY_TIMEOUT_MS;
            readyPromise = Promise.race([
                Promise.resolve(p).then(() => true).catch(() => false),
                new Promise((res) => { try { setTimeout(() => res(false), limit); } catch (e) { res(false); } }),
            ]);
        }
        return readyPromise;
    } catch (e) { return Promise.resolve(false); }
}

/** 官方命名规则内的 key 归一（非法字符替换、去前导点、空值兜底） */
export function ttKeyOf(name) {
    try {
        let s = String(name == null ? '' : name).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '');
        if (!s) s = 'unnamed';
        return s.slice(0, 180);
    } catch (e) { return 'unnamed'; }
}

function ctxKey(ns, key) { return String(ns) + '\u0000' + String(key); }
function markOk() { lastOkAt = Date.now(); lastError = ''; lastReason = ''; }
function markErr(e, reason) {
    try { lastError = String((e && e.message) || e || '').slice(0, 160); } catch (e2) { lastError = 'error'; }
    lastReason = String(reason || '');
}
/** 「条目不存在」类错误的分类器（宿主只提供 `getJson` 时用它把缺失判为正常未命中） */
export function ttIsNotFound(e) {
    try {
        const m = String((e && e.message) || e || '');
        return /not\s*found|not_found|no\s*such|does\s*not\s*exist|enoent|未找到|不存在/i.test(m);
    } catch (e2) { return false; }
}
function missMark(ns, key) { try { stats.misses++; missCache[ctxKey(ns, key)] = Date.now(); } catch (e) { /* 忽略 */ } }
function missClear(ns, key) { try { delete missCache[ctxKey(ns, key)]; } catch (e) { /* 忽略 */ } }
function missRecently(ns, key) {
    try { const t = missCache[ctxKey(ns, key)]; return !!t && (Date.now() - t) < TT_MISS_TTL_MS; } catch (e) { return false; }
}
function listCacheGet(ns, table) {
    try {
        const c = listCache[String(ns) + '/' + String(table)];
        if (!c) return null;
        return (Date.now() - c.at) < TT_LIST_TTL_MS ? c.keys : null;
    } catch (e) { return null; }
}
function listCacheSet(ns, table, keys) {
    try { listCache[String(ns) + '/' + String(table)] = { at: Date.now(), keys: Array.isArray(keys) ? keys.slice() : [] }; } catch (e) { /* 忽略 */ }
}
function listCacheDrop(ns, table) { try { delete listCache[String(ns) + '/' + String(table)]; } catch (e) { /* 忽略 */ } }
function listCacheDropAll() { for (const k of Object.keys(listCache)) delete listCache[k]; }

// ==================== KV JSON 通道 ====================
/** 写入 KV JSON（base64 载荷；V1 同款 `{ k:'b64', v, ts }` 形状，便于迁移与人工核对） */
export async function ttKvPut(name, b64, opts) {
    const o = opts || {};
    const st = ttStoreApi();
    if (!st) return { ok: false, reason: 'no-api' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    try {
        await ttEnsureReady(o.timeoutMs);
        await st.setJson({ namespace: ns, table: table, key: key, value: { k: 'b64', v: String(b64 || ''), ts: Date.now() } });
        missClear(ns, key);
        writeChannel[ctxKey(ns, key)] = 'kv';
        stats.writes++; stats.kvWrites++;
        markOk();
        return { ok: true, backend: 'tt-native', channel: 'kv', ns: ns, table: table, key: key, path: 'tt-store://' + ns + '/' + table + '/' + key };
    } catch (e) { markErr(e, 'kv-put'); return { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
}

/**
 * 读取 KV JSON 的 base64 载荷。
 * **只信 `tryGetJson` 的 `found` 标记**：有它时 found:false 即未命中，绝不再追问 `getJson`
 *   （宿主会对不存在的键抛错并在控制台打印 Not found —— V1 v1.156 实测缺陷，此处结构性规避）。
 * @returns {Promise<{found:boolean, b64?:string, error?:string}>}
 */
export async function ttKvTryGet(name, opts) {
    const o = opts || {};
    const st = ttStoreApi();
    if (!st) return { found: false, error: 'no-api' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    if (missRecently(ns, key) && !o.force) return { found: false, cached: true };
    try {
        await ttEnsureReady(o.timeoutMs);
        let v;
        let miss = false;
        if (typeof st.tryGetJson === 'function') {
            const r = await st.tryGetJson({ namespace: ns, table: table, key: key });
            if (r && typeof r === 'object' && ('found' in r)) {
                if (r.found) v = r.value;
                else miss = true;                            // ← 不再追问 getJson
            } else if (r !== undefined && r !== null) {
                v = (r && r.value !== undefined) ? r.value : r;
            }
        }
        if (v === undefined && !miss && typeof st.getJson === 'function') {
            try { v = await st.getJson({ namespace: ns, table: table, key: key }); }
            catch (e) { if (ttIsNotFound(e)) miss = true; else { markErr(e, 'kv-get'); return { found: false, error: String((e && e.message) || e) }; } }
        }
        if (miss || v === null || v === undefined) { missMark(ns, key); return { found: false }; }
        // 形状兼容：{k:'b64',v} / {v} / 直接 base64 字符串（V1 三种都写过）
        let b64 = '';
        if (typeof v === 'string') b64 = v;
        else if (typeof v === 'object' && typeof v.v === 'string') b64 = v.v;
        if (!b64) { missMark(ns, key); return { found: false, reason: 'shape' }; }
        stats.reads++; markOk();
        writeChannel[ctxKey(ns, key)] = 'kv';
        return { found: true, b64: b64 };
    } catch (e) {
        if (ttIsNotFound(e)) { missMark(ns, key); return { found: false }; }
        markErr(e, 'kv-get');
        return { found: false, error: String((e && e.message) || e) };
    }
}

/** 删除 KV JSON（缺失键按幂等成功处理 —— V1 同口径） */
export async function ttKvDel(name, opts) {
    const o = opts || {};
    const st = ttStoreApi();
    if (!st || typeof st.deleteJson !== 'function') return { ok: false, reason: 'no-api' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    try {
        await ttEnsureReady(o.timeoutMs);
        await st.deleteJson({ namespace: ns, table: table, key: key });
        missMark(ns, key);
        delete writeChannel[ctxKey(ns, key)];
        markOk();
        return { ok: true, backend: 'tt-native', channel: 'kv' };
    } catch (e) {
        if (ttIsNotFound(e)) { missMark(ns, key); return { ok: true, idempotent: true }; }
        markErr(e, 'kv-del');
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// ==================== Blob 通道 ====================
/** Blob 是否存在（官方 `listBlobKeys` + 短 TTL 缓存；避免对缺失 key 调 `getBlob`） */
export async function ttBlobHas(name, opts) {
    const o = opts || {};
    const st = ttBlobApi();
    if (!st) return false;
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    if (writeChannel[ctxKey(ns, key)] === 'blob' && !o.force) return true;   // 本会话刚写过 → 必然存在
    if (missRecently(ns, key) && !o.force) return false;
    try {
        let keys = listCacheGet(ns, table);
        if (!keys) {
            await ttEnsureReady(o.timeoutMs);
            stats.listCalls++;
            const r = await st.listBlobKeys({ namespace: ns, table: table });
            keys = Array.isArray(r) ? r.map((x) => String(x)) : [];
            listCacheSet(ns, table, keys);
        }
        const hit = keys.indexOf(key) >= 0;
        if (hit) markOk();
        return hit;
    } catch (e) { markErr(e, 'blob-list'); return false; }
}

/** 写入 Blob（直传字节；官方 `setBlob` 接受 Uint8Array / ArrayBuffer / Blob / base64 字符串） */
export async function ttBlobPut(name, bytes, opts) {
    const o = opts || {};
    const st = ttBlobApi();
    if (!st) return { ok: false, reason: 'no-blob' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (!u8.length) return { ok: false, reason: 'empty' };
        await ttEnsureReady(o.timeoutMs);
        await st.setBlob({ namespace: ns, table: table, key: key, data: u8 });
        missClear(ns, key);
        listCacheDrop(ns, table);
        writeChannel[ctxKey(ns, key)] = 'blob';
        stats.writes++; stats.blobWrites++;
        markOk();
        return { ok: true, backend: 'tt-native', channel: 'blob', bytes: u8.length, ns: ns, table: table, key: key, path: 'tt-store://' + ns + '/' + table + '/' + key };
    } catch (e) { markErr(e, 'blob-put'); return { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
}

/** 读取 Blob 字节（Blob → arrayBuffer；宿主桩直接给 ArrayBuffer/Uint8Array 也能用） */
export async function ttBlobGet(name, opts) {
    const o = opts || {};
    const st = ttBlobApi();
    if (!st) return { ok: false, reason: 'no-blob' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    try {
        if (!o.force && !(await ttBlobHas(name, o))) return { ok: false, miss: true };   // 先按存在性判定，绝不追问缺失键
        await ttEnsureReady(o.timeoutMs);
        const r = await st.getBlob({ namespace: ns, table: table, key: key });
        let u8 = null;
        if (r instanceof Uint8Array) u8 = r;
        else if (r && typeof r.arrayBuffer === 'function') u8 = new Uint8Array(await r.arrayBuffer());
        else if (r instanceof ArrayBuffer) u8 = new Uint8Array(r);
        if (!u8 || !u8.length) { missMark(ns, key); return { ok: false, miss: true } };
        stats.reads++; markOk();
        writeChannel[ctxKey(ns, key)] = 'blob';
        return { ok: true, bytes: u8, channel: 'blob' };
    } catch (e) {
        if (ttIsNotFound(e)) { missMark(ns, key); return { ok: false, miss: true } };
        markErr(e, 'blob-get');
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 删除 Blob（缺失按幂等成功） */
export async function ttBlobDel(name, opts) {
    const o = opts || {};
    const st = ttBlobApi();
    if (!st) return { ok: false, reason: 'no-blob' };
    const ns = String(o.ns || TT_NS);
    const table = String(o.table || TT_TABLE);
    const key = ttKeyOf(name);
    try {
        await ttEnsureReady(o.timeoutMs);
        await st.deleteBlob({ namespace: ns, table: table, key: key });
        missMark(ns, key);
        listCacheDrop(ns, table);
        delete writeChannel[ctxKey(ns, key)];
        markOk();
        return { ok: true, backend: 'tt-native', channel: 'blob' };
    } catch (e) {
        if (ttIsNotFound(e)) { missMark(ns, key); return { ok: true, idempotent: true }; }
        markErr(e, 'blob-del');
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// ==================== 统一读写（按体积选通道） ====================
/** 该载荷是否该走 Blob（大载荷且宿主具备 Blob 能力） */
export function ttChannelFor(size) { try { return (Number(size) >= TT_KV_MAX_BYTES && !!ttBlobApi()) ? 'blob' : 'kv'; } catch (e) { return 'kv'; } }

/**
 * 写入原生存储（自动选 KV / Blob）。
 * @param {string} name 键名（原始文件名，内部按官方规则归一）
 * @param {Uint8Array} bytes 原始载荷字节（gzip 或明文 UTF-8 —— 与文件通道内容口径一致）
 */
export async function ttPutBytes(name, bytes, opts) {
    const o = opts || {};
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!u8.length) return { ok: false, reason: 'empty' };
    const ch = o.channel || ttChannelFor(u8.length);
    if (ch === 'blob') {
        const r = await ttBlobPut(name, u8, o);
        if (r.ok) return r;
        stats.fallbacks++;
        const kv = await ttKvPut(name, bytesToBase64(u8), o);      // Blob 写失败 → 退回 KV（绝不丢数据）
        if (kv.ok) kv.afterBlobError = String(r.error || r.reason || 'error');
        return kv;
    }
    const r = await ttKvPut(name, bytesToBase64(u8), o);
    if (r.ok) return r;
    if (ttBlobApi()) {
        stats.fallbacks++;
        const blob = await ttBlobPut(name, u8, o);
        if (blob.ok) blob.afterKvError = String(r.error || r.reason || 'error');
        return blob;
    }
    return r;
}

/**
 * 读取原生存储（按写入通道 → KV → Blob 顺序；均未命中即 `found:false`）。
 * @returns {Promise<{found:boolean, bytes?:Uint8Array, channel?:string, ns?:string, error?:string}>}
 */
export async function ttGetBytes(name, opts) {
    const o = opts || {};
    const ns = String(o.ns || TT_NS);
    const key = ttKeyOf(name);
    const known = writeChannel[ctxKey(ns, key)] || o.channel || '';
    const tryKv = async () => {
        const r = await ttKvTryGet(name, o);
        if (r && r.found) {
            const u8 = base64ToBytes(String(r.b64 || ''));
            if (u8 && u8.length) return { found: true, bytes: u8, channel: 'kv', ns: ns };
        }
        return null;
    };
    const tryBlob = async () => {
        if (!ttBlobApi()) return null;
        const has = await ttBlobHas(name, Object.assign({}, o, { force: o.force === true }));
        if (!has) return null;
        const r = await ttBlobGet(name, o);
        if (r && r.ok && r.bytes && r.bytes.length) return { found: true, bytes: r.bytes, channel: 'blob', ns: ns };
        return null;
    };
    const order = (known === 'blob') ? [tryBlob, tryKv] : [tryKv, tryBlob];
    for (const step of order) {
        const hit = await step();
        if (hit) return hit;
    }
    missMark(ns, key);
    return { found: false };
}

/** 删除原生存储（两个通道都删，避免「删了又被另一通道唤醒」） */
export async function ttDelete(name, opts) {
    const kv = await ttKvDel(name, opts);
    const blob = ttBlobApi() ? await ttBlobDel(name, opts) : { ok: false, reason: 'no-blob' };
    return { ok: !!(kv.ok || blob.ok), kv: !!kv.ok, blob: !!blob.ok };
}

/** KV table 下的 key 列表（官方 `listKeys`；诊断/数据管理用） */
export async function ttListKeys(table, opts) {
    const o = opts || {};
    const st = ttStoreApi();
    if (!st || typeof st.listKeys !== 'function') return [];
    const ns = String(o.ns || TT_NS);
    try {
        await ttEnsureReady(o.timeoutMs);
        const r = await st.listKeys({ namespace: ns, table: String(table || TT_TABLE) });
        return Array.isArray(r) ? r.map((x) => String(x)) : [];
    } catch (e) { markErr(e, 'list-keys'); return []; }
}

/** Blob table 下的 key 列表（官方 `listBlobKeys`，绕开缓存） */
export async function ttListBlobKeys(table, opts) {
    const o = opts || {};
    const st = ttBlobApi();
    if (!st) return [];
    const ns = String(o.ns || TT_NS);
    try {
        await ttEnsureReady(o.timeoutMs);
        const r = await st.listBlobKeys({ namespace: ns, table: String(table || TT_TABLE) });
        return Array.isArray(r) ? r.map((x) => String(x)) : [];
    } catch (e) { markErr(e, 'list-blobs'); return []; }
}

/** 原生存储概览（数据管理/诊断：本命名空间下两种通道的键数） */
export async function ttStoreOverview(opts) {
    const o = opts || {};
    const st = ttStoreApi();
    if (!st) return { available: false };
    const ns = String(o.ns || TT_NS);
    const [kvKeys, blobKeys] = await Promise.all([ttListKeys(TT_TABLE, o), ttListBlobKeys(TT_TABLE, o)]);
    return { available: true, ns: ns, table: TT_TABLE, kv: kvKeys, blob: blobKeys, kvCount: kvKeys.length, blobCount: blobKeys.length };
}

// ==================== 状态与诊断 ====================
/** 未命中统计（状态行/测试） */
export function ttMissStats() {
    try { return { count: stats.misses, cached: Object.keys(missCache).length, ttlMs: TT_MISS_TTL_MS, listCached: Object.keys(listCache).length }; }
    catch (e) { return { count: 0, cached: 0, ttlMs: TT_MISS_TTL_MS, listCached: 0 }; }
}

/** 通道信息（状态行/调试导出/测试） */
export function ttChannelInfo() {
    let detected = false, active = false, setting = 'auto', mirror = false, api = false, blob = false;
    try {
        detected = ttDetected(); setting = tauriNativeSetting(); active = ttNativeActive();
        mirror = ttMirrorToFiles(); api = !!ttStoreApi(); blob = !!ttBlobApi();
    } catch (e) { /* 忽略 */ }
    const id = active ? 'tt-native' : 'st-files';
    let label, reason;
    if (active) {
        label = '宿主原生存储';
        reason = setting === 'on' ? '已在设定中强制开启宿主原生存储' : '检测到 TauriTavern 宿主 → 自动切换';
    } else if (detected) {
        label = '酒馆用户目录文件（宿主存储尚未就绪）';
        reason = '已检测到 TauriTavern，但扩展存储 API 尚未就绪 → 暂用文件通道';
    } else {
        label = '酒馆用户目录文件';
        reason = setting === 'off' ? '已在设定中关闭宿主原生存储' : '未检测到 TauriTavern 宿主';
    }
    return {
        id: id, label: label, reason: reason, detected: detected, native: active, api: api, blob: blob,
        setting: setting, mirror: mirror, ns: TT_NS, legacyNs: TT_LEGACY_NS, table: TT_TABLE,
        kvMaxBytes: TT_KV_MAX_BYTES,
        writes: stats.writes, kvWrites: stats.kvWrites, blobWrites: stats.blobWrites,
        reads: stats.reads, misses: stats.misses, listCalls: stats.listCalls, fallbacks: stats.fallbacks,
        lastOkAt: lastOkAt, err: lastError, errAt: lastError ? lastOkAt : 0, errReason: lastReason,
    };
}

/** 通道状态行（存储页只读行；<b> 强调、无 Markdown 字面量） */
export function ttChannelStatusHtml() {
    try {
        const c = ttChannelInfo();
        const dot = c.native ? '🟢' : (c.detected ? '🟡' : '⚪');
        const extra = c.native ? (' · 已写 ' + c.writes + ' 次 / 命中读 ' + c.reads + ' 次' + (c.misses ? (' · 未命中 ' + c.misses + ' 次') : '')) : '';
        return dot + ' 当前通道：<b>' + esc(c.label) + '</b>' + extra;
    } catch (e) { return ''; }
}

/** 通道详情（折叠块内容：命名空间 / 版本 / 计数 / 最近错误） */
export function ttChannelDetailHtml() {
    try {
        const c = ttChannelInfo();
        const rows = [
            '通道原因：' + c.reason,
            '命名空间：' + c.ns + '（表 ' + c.table + '；旧数据只读兼容 ' + c.legacyNs + '）',
            '写入分布：KV ' + c.kvWrites + ' 次 / 大文件 ' + c.blobWrites + ' 次（≥' + Math.round(c.kvMaxBytes / 1024) + 'KB 走大文件通道）',
            '未命中抑制：' + c.misses + ' 次（' + TT_MISS_TTL_MS / 1000 + 's 内同键不再探测）',
            c.mirror ? '镜像：开启（原生写入后另写一份酒馆用户目录文件）' : '镜像：关闭',
        ];
        if (c.err) rows.push('最近错误：' + c.err + (c.errReason ? ('（' + c.errReason + '）') : ''));
        return rows.map((r) => '<div>' + esc(r) + '</div>').join('');
    } catch (e) { return ''; }
}

function esc(s) {
    try {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    } catch (e) { return ''; }
}

/** 切换提示（每次会话最多一次；宿主原生存储成为实际通道时由上层调用） */
export function ttAnnounceSwitch() {
    try {
        if (announced || !ttNativeActive()) return false;
        announced = true;
        try {
            if (notifyHooks && typeof notifyHooks.toast === 'function') notifyHooks.toast('已启用宿主原生存储：记忆文件改走宿主扩展存储', 'info');
        } catch (e) { /* 静默 */ }
        try { dbgLog('对账', { action: '存储通道切换到宿主原生存储', ns: TT_NS, table: TT_TABLE, blob: !!ttBlobApi(), mirror: ttMirrorToFiles() }); } catch (e) { /* 静默 */ }
        return true;
    } catch (e) { return false; }
}

/** 是否已提示过（测试用） */
export function ttAnnounced() { return announced; }

/** 读取旧命名空间（V1 数据）—— 迁移/导入入口，只读 */
export async function ttGetLegacyBytes(name, opts) {
    const o = Object.assign({}, opts || {}, { ns: TT_LEGACY_NS });
    return await ttGetBytes(name, o);
}

/** 内容解码（gzip / 明文按**内容魔数**识别，与文件通道同一口径） */
export async function ttBytesToTextAuto(u8) {
    try {
        if (!u8 || !u8.length) return { ok: false, text: '', gz: false };
        if (!isGzipBytes(u8)) {
            const t = bytesToText(u8);
            return t ? { ok: true, text: t, gz: false } : { ok: false, text: '', gz: false };
        }
        const dec = await decodeBytesAuto(u8);
        return dec && dec.ok ? { ok: true, text: String(dec.text == null ? '' : dec.text), gz: true } : { ok: false, text: '', gz: true, error: (dec && dec.reason) || 'gunzip' };
    } catch (e) { return { ok: false, text: '', gz: false, error: String((e && e.message) || e) }; }
}

/** 文本 → 字节（写入侧便利函数） */
export function ttTextBytes(text) { try { return textToBytes(String(text == null ? '' : text)); } catch (e) { return new Uint8Array(0); } }
