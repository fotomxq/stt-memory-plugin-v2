// ============================================================
// adapters/vector-cache.js —— **向量缓存持久层**（v2.58.0）
//
// V1 出处：`src/FTT记忆组件-v1.206.js` 约 12393~12449 —— IndexedDB 库 `FTTMemoryVectorCache`、
//   表 `embeddings`（`keyPath: 'key'`，条目 `{key, vector}`）；读失败/无 IndexedDB 时**静默降级**。
// V2 逐条对齐：库名/表名/键结构/composite `{key, vector}` 与 V1 **完全一致**（V1 缓存可直接复用，
//   反之亦然）；无 IndexedDB（Node 测试 / 受限宿主）时退化为**内存 Map**，行为对调用方一致。
// 约定：所有函数不抛异常；失败返回空/0（向量层失败不影响注入主流程）。
// ============================================================

/** V1 常量（逐字） */
export const VEC_DB = 'FTTMemoryVectorCache';
export const VEC_STORE = 'embeddings';

/** 内存回退（无 IndexedDB 时使用；进程内有效） */
const mem = new Map();
/** 最近一次降级原因（诊断用） */
let lastFallback = '';

const str = (v) => String(v == null ? '' : v).trim();

/** IndexedDB 视图（无 → null） */
function idb() {
    try {
        const g = globalThis;
        return (g.indexedDB && typeof g.indexedDB.open === 'function') ? g.indexedDB : null;
    } catch (e) { return null; }
}

/** 打开库（V1 `openVectorDb` 逐字：version 1 + `onupgradeneeded` 建表） */
export function openVectorDb() {
    return new Promise((resolve, reject) => {
        try {
            const db = idb();
            if (!db) return reject(new Error('IndexedDB 不可用'));
            const req = db.open(VEC_DB, 1);
            req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(VEC_STORE)) d.createObjectStore(VEC_STORE, { keyPath: 'key' }); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        } catch (e) { reject(e); }
    });
}

/**
 * 批量读向量（V1 `vecCacheGetMany`）。
 * @param {string[]} keys
 * @returns {Promise<Map<string, number[]>>}
 */
export async function vecCacheGetMany(keys) {
    const list = (Array.isArray(keys) ? keys : []).map(str).filter(Boolean);
    if (!list.length) return new Map();
    if (!idb()) { lastFallback = 'no-indexeddb'; const m = new Map(); list.forEach((k) => { if (mem.has(k)) m.set(k, mem.get(k)); }); return m; }
    try {
        const db = await openVectorDb();
        const out = await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(VEC_STORE, 'readonly');
                const store = tx.objectStore(VEC_STORE);
                const got = new Map();
                let left = list.length;
                for (const k of list) {
                    const r = store.get(k);
                    r.onsuccess = () => { const v = r.result && r.result.vector; if (Array.isArray(v) && v.length) got.set(k, v); if (--left === 0) resolve(got); };
                    r.onerror = () => reject(r.error || new Error('向量读取失败'));
                }
            } catch (e) { reject(e); }
        });
        try { db.close(); } catch (e) { /* 忽略 */ }
        return out;
    } catch (e) {
        lastFallback = 'read-failed:' + str((e && e.message) || e).slice(0, 60);
        const m = new Map(); list.forEach((k) => { if (mem.has(k)) m.set(k, mem.get(k)); });
        return m;
    }
}

/**
 * 批量写向量（V1 `vecCachePutMany`：条目 `{key, vector}`）。
 * @param {Array<{key:string, vector:number[]}>} entries
 * @returns {Promise<boolean>}
 */
export async function vecCachePutMany(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && str(e.key) && Array.isArray(e.vector) && e.vector.length);
    if (!list.length) return false;
    list.forEach((e) => mem.set(str(e.key), e.vector));
    if (!idb()) { lastFallback = 'no-indexeddb'; return false; }
    try {
        const db = await openVectorDb();
        await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(VEC_STORE, 'readwrite');
                const store = tx.objectStore(VEC_STORE);
                for (const en of list) store.put({ key: str(en.key), vector: en.vector });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('向量写入失败'));
            } catch (e) { reject(e); }
        });
        try { db.close(); } catch (e) { /* 忽略 */ }
        return true;
    } catch (e) {
        lastFallback = 'write-failed:' + str((e && e.message) || e).slice(0, 60);
        return false;
    }
}

/**
 * 批量删除向量（v2.79.0：**旧维度向量清理**用 —— 换了 Embedding 模型后维度不符的缓存必须真正删掉，
 * 否则每次召回都要重试一次注定失败的比对；重嵌成功时走 `vecCachePutMany` 覆盖，无需删除）。
 * @param {string[]} keys
 * @returns {Promise<number>} 实际删除条数（内存计数）
 */
export async function vecCacheDeleteMany(keys) {
    const list = (Array.isArray(keys) ? keys : []).map(str).filter(Boolean);
    if (!list.length) return 0;
    let n = 0;
    list.forEach((k) => { if (mem.delete(k)) n += 1; });
    if (!idb()) return n;
    try {
        const db = await openVectorDb();
        await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(VEC_STORE, 'readwrite');
                const store = tx.objectStore(VEC_STORE);
                for (const k of list) store.delete(k);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('向量删除失败'));
            } catch (e) { reject(e); }
        });
        try { db.close(); } catch (e) { /* 忽略 */ }
        return n;
    } catch (e) {
        lastFallback = 'delete-failed:' + str((e && e.message) || e).slice(0, 60);
        return n;
    }
}

/** 清空向量缓存（内存 + IndexedDB 表；诊断/设置用） */
export async function vectorCacheClear() {
    const n = mem.size;
    mem.clear();
    if (!idb()) return { ok: true, cleared: n, via: 'memory' };
    try {
        const db = await openVectorDb();
        await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(VEC_STORE, 'readwrite');
                tx.objectStore(VEC_STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('清空失败'));
            } catch (e) { reject(e); }
        });
        try { db.close(); } catch (e) { /* 忽略 */ }
        return { ok: true, cleared: n, via: 'indexeddb' };
    } catch (e) {
        return { ok: false, cleared: n, error: str((e && e.message) || e) };
    }
}

/** 缓存统计（设置页/诊断：内存条数 + 是否有 IndexedDB + 最近降级原因） */
export function vectorCacheStats() {
    return { memory: mem.size, indexedDb: !!idb(), fallback: lastFallback };
}

/** 测试用：复位内存回退与降级原因 */
export function resetVectorCacheState() { mem.clear(); lastFallback = ''; return true; }
