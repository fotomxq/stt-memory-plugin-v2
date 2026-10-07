// ============================================================
// adapters/aux-store.js —— **本机辅助数据统一收纳**（v3.27.0，用户要求）
//
// 用户原话：「新版本，快照、日志等信息，也应该主动跟随本地存储变动。如设置了本地路径，则应该存储到对应目录下
//   统一管理收纳。」
//
// 事实（v3.26.x 之前）：记忆数据在目录模式下只落「目录 + 服务端」，但**辅助数据**仍散在浏览器本地存储里 ——
//   调试日志（`SPreset_FTTMemoryDebug`）、交互时间线（`SPreset_FTTMemoryTrace`，历史上限 7MB）、
//   同步与对账标记、版本清单缓存（`fttAboutJson`）。用户设了目录却只收纳了记忆数据，辅助数据仍占浏览器配额、
//   也不在同一个目录里，无法统一备份/迁移。
//
// 口径：
//   · **留空 = 不开启**（与目录模式同一开关）：读写仍走 localStorage，行为逐字不变；
//   · 目录模式：读写走**内存缓存**（同步 API，调用方零改动）+ **防抖异步落盘**到目录命名空间的 `aux` 表
//     （每个键一个文件 `aux-<安全键名>.json`，便于用户逐个查看/备份）；
//   · **先写后清**迁移：启动时把 localStorage 里的旧值写进目录 → 回读校验 → 才删旧键（任一步失败都不清，
//     并如实回报，下次启动重试）；
//   · 落盘失败如实记账（`lastError`），**绝不丢**（内存副本仍在，下一次防抖或退出前再试）。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { scopeId as kernelScopeId } from '../core/state.js';   // v3.32.0：日志分片目录按角色作用域
import { fileTransportUploadText, fileTransportReadAuto, fileTransportDelete } from './file-transport.js';
import { localFileEnabled, localFileNs, localFilePath } from './local-file.js';
// v3.28.0（用户纠正设计）：**本地磁盘目录**（真磁盘路径，替代浏览器本地存储）优先级最高 ——
//   设了它就把辅助数据写成**真文件**（`<本地磁盘目录>/aux-*.json`），而不是宿主扩展存储命名空间。
import { localDiskOn, localDiskWrite, localDiskRead, localDiskInfo } from './local-disk.js';

/** 目录模式下辅助文件的表名（与记忆数据分开，便于用户区分「记忆」与「辅助」） */
export const AUX_TABLE = 'aux';
/** 文件名前缀（目录里一眼可辨） */
export const AUX_FILE_PREFIX = 'aux-';
/** 防抖落盘时长 */
const AUX_FLUSH_MS = 1200;

/** 内存缓存：key → 文本（目录模式下是真源；非目录模式不使用） */
const mem = Object.create(null);
/** 待落盘的键（目录模式） */
const dirty = Object.create(null);
/** 已知的目录文件元信息（诊断用） */
const meta = Object.create(null);
let flushTimer = null;
let initDone = false;
let initInfo = null;
const stats = { loads: 0, saves: 0, failures: 0, migrated: 0, lastError: '', lastAt: 0, parts: {} };   // v3.32.0：`parts` = 日志结构化分片的落点统计（debug / trace）

/** 是否处于「目录模式」（辅助数据跟随目录） */
export function auxDirMode() { try { return localDiskOn() || localFileEnabled(); } catch (e) { return false; } }
/** v3.28.0：辅助数据是否落在**真磁盘目录**（优先于扩展存储命名空间） */
export function auxDiskMode() { try { return localDiskOn(); } catch (e) { return false; } }

/** localStorage（不可用 → null）；同时兼容 `window.localStorage` 与 `globalThis.localStorage` 两种注入 */
function ls() {
    try {
        const w = globalThis.window;
        if (w && w.localStorage) return w.localStorage;
    } catch (e) { /* 忽略 */ }
    try { return globalThis.localStorage || null; } catch (e) { return null; }
}

/** 键 → 文件名安全形态（保留可读性；非法字符转 `_`） */
export function auxFileName(key) {
    const safe = String(key == null ? '' : key).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    return AUX_FILE_PREFIX + (safe || 'unnamed') + '.json';
}
function auxOpts(name) {
    return { ns: (() => { try { return localFileNs(); } catch (e) { return ''; } })(), table: AUX_TABLE, stName: name };
}

/**
 * **同步读**（调用方零改动：原来直接 `localStorage.getItem`）。
 *   目录模式：内存缓存；非目录模式：localStorage。
 * @returns {string|null}
 */
export function auxLsGet(key) {
    if (auxDirMode()) {
        const v = mem[String(key)];
        return (v === undefined || v === null) ? null : String(v);
    }
    try { const s = ls(); return s ? s.getItem(String(key)) : null; } catch (e) { return null; }
}

/**
 * **同步写**：目录模式写内存 + 标脏（防抖落盘）；非目录模式直接写 localStorage。
 * @returns {boolean} 是否已接受（目录模式恒 true，落盘结果由 `auxStoreInfo()`/`lastError` 反映）
 */
export function auxLsSet(key, val) {
    const k = String(key);
    const text = String(val == null ? '' : val);
    if (auxDirMode()) {
        mem[k] = text;
        dirty[k] = true;
        scheduleFlush();
        return true;
    }
    try { const s = ls(); if (!s) return false; s.setItem(k, text); return true; } catch (e) { return false; }
}

/** **同步删**（目录模式：删内存 + 标脏删除，落盘时删文件） */
export function auxLsRemove(key) {
    const k = String(key);
    if (auxDirMode()) {
        delete mem[k];
        dirty[k] = 'del';
        scheduleFlush();
        return true;
    }
    try { const s = ls(); if (!s) return false; s.removeItem(k); return true; } catch (e) { return false; }
}

/** 需要跟随目录收纳的键（启动时据此加载 / 迁移） */
export const AUX_KEYS = Object.freeze(['SPreset_FTTMemoryDebug', 'SPreset_FTTMemoryTrace', 'fttAboutJson']);

/**
 * 「类 localStorage」门面（各辅助模块的 ls() 直接返回它）：getItem/setItem/removeItem 三个方法，
 *   目录模式 → 目录下的 aux 文件；否则 → localStorage。**同步 API**，调用方零改动。
 */
export function auxFacade() {
    // 目录模式 → 目录文件门面；**既没设目录、宿主也没有 localStorage（Node / 受限宿主）时返回 null** ——
    //   让既有调用方的「无持久层 → 退化为纯内存」语义逐字保留（debug-log D5 / trace-store 都靠它判断）。
    if (!auxDirMode()) { try { if (!ls()) return null; } catch (e) { return null; } }
    return {
        getItem: (k) => auxLsGet(k),
        setItem: (k, v) => { auxLsSet(k, v); },
        removeItem: (k) => auxLsRemove(k),
    };
}

/** v3.32.0：当前角色作用域（日志分片目录用；取不到 → default） */
function scopeIdOf() { try { return String(kernelScopeId() || '') || 'default'; } catch (e) { return 'default'; } }
function scheduleFlush() {
    try {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flushTimer = null; void auxStoreFlush(); }, AUX_FLUSH_MS);
    } catch (e) { /* 忽略：无定时器（受限宿主）时由显式 flush 兜底 */ }
}

/**
 * 启动加载（**只在目录模式下做事**；异步）。返回 `{ok, loaded, migrated, kept}`：
 *   · 目录里已有 → 载入内存（顺带清掉同名 localStorage 旧键，避免两份并存）；
 *   · 目录里没有、localStorage 有 → **先写后清**迁进目录（写 → 回读校验 → 才删旧键）。
 * 非目录模式：直接返回 `{ok:true, skipped:'off'}`（零行为变化）。
 */
export async function auxStoreInit() {
    if (initDone) return Object.assign({ ok: true, reused: true }, initInfo || {});
    if (!auxDirMode()) { initDone = true; initInfo = { ok: true, skipped: 'off', loaded: 0, migrated: 0 }; return initInfo; }
    const out = { ok: true, loaded: 0, migrated: 0, kept: 0, errors: [] };
    for (const key of AUX_KEYS) {
        const name = auxFileName(key);
        try {
            let dirText = null;
            const r = auxDiskMode() ? (await localDiskRead(name)) : (await fileTransportReadAuto(name, auxOpts(name)));
            if (r && r.ok && typeof r.text === 'string' && r.text) dirText = String(r.text);
            const localText = (() => { try { const s = ls(); return s ? s.getItem(key) : null; } catch (e) { return null; } })();
            if (dirText !== null) {
                mem[key] = dirText;
                meta[key] = { at: Date.now(), bytes: dirText.length, file: name };
                out.loaded++;
                // 目录里已有一份 → 浏览器里的旧键不再需要（先确认目录可读，再删）
                if (localText !== null) { try { const s = ls(); if (s) s.removeItem(key); } catch (e) { /* 忽略 */ } }
                continue;
            }
            if (localText !== null) {
                // 先写后清：写目录 → 回读逐字节校验 → 才删 localStorage
                const w = auxDiskMode() ? (await localDiskWrite(name, String(localText))) : (await fileTransportUploadText(name, String(localText), auxOpts(name)));
                if (!w || !w.ok) { out.errors.push(key + ':write-failed'); stats.failures++; continue; }
                const back = auxDiskMode() ? (await localDiskRead(name)) : (await fileTransportReadAuto(name, auxOpts(name)));
                if (!back || !back.ok || String(back.text) !== String(localText)) { out.errors.push(key + ':verify-failed'); stats.failures++; continue; }
                mem[key] = String(localText);
                meta[key] = { at: Date.now(), bytes: String(localText).length, file: name };
                try { const s = ls(); if (s) s.removeItem(key); } catch (e) { /* 忽略 */ }
                out.migrated++;
                stats.migrated++;
                continue;
            }
            out.kept++;
        } catch (e) {
            stats.failures++;
            stats.lastError = String((e && e.message) || e);
            out.errors.push(key + ':' + stats.lastError);
        }
    }
    initDone = true;
    initInfo = out;
    stats.loads++;
    stats.lastAt = Date.now();
    return out;
}

/** 把标脏的键写进目录（幂等；失败保留脏标记，下次再试） */
export async function auxStoreFlush() {
    if (!auxDirMode()) return { ok: true, skipped: 'off', written: 0 };
    const keys = Object.keys(dirty);
    let written = 0;
    for (const key of keys) {
        const name = auxFileName(key);
        try {
            if (dirty[key] === 'del') {
                if (auxDiskMode()) { /* 磁盘模式：删除留待下一次落盘覆盖（不主动删用户磁盘上的文件） */ } else { await fileTransportDelete(name, auxOpts(name)); }
                delete mem[key];
                delete meta[key];
            } else {
                const text = String(mem[key] == null ? '' : mem[key]);
                const w = auxDiskMode() ? (await localDiskWrite(name, text)) : (await fileTransportUploadText(name, text, auxOpts(name)));
                if (!w || !w.ok) { stats.failures++; stats.lastError = 'write-failed:' + key; continue; }
                meta[key] = { at: Date.now(), bytes: text.length, file: name };
                // v3.32.0（用户要求「日志文件也需要拆开做存储」）：调试日志 / 交互时间线**按天分片**再写一份结构化副本
                //   注意：只在成功写出主记录后、且**不阻塞**主流程；失败只记 `stats.parts[kind].error`。
                try {
                    const kind = (key === 'SPreset_FTTMemoryDebug') ? 'debug' : ((key === 'SPreset_FTTMemoryTrace') ? 'trace' : (/log/i.test(key) ? 'log' : ''));
                    if (kind && text) {
                        const arr = JSON.parse(text);
                        if (Array.isArray(arr)) {
                            const LD2 = await import('./local-disk.js');
                            const r = await LD2.localDiskWriteParts('logs', arr, scopeIdOf(), { kind: kind, cap: 500 });
                            if (r && r.ok) { stats.parts[kind] = { at: Date.now(), dir: String(r.dir || ''), files: Number(r.files || 0), count: Number(r.count || 0) }; }
                            else { stats.parts[kind] = { at: Date.now(), dir: String((r && r.dir) || ''), files: 0, count: 0, error: String((r && r.error) || 'write-failed') }; }
                        }
                    }
                } catch (e) { /* 忽略：分片副本失败不影响主记录 */ }
            }
            delete dirty[key];
            written++;
            stats.saves++;
            stats.lastAt = Date.now();
            stats.lastError = '';
        } catch (e) {
            stats.failures++;
            stats.lastError = String((e && e.message) || e);
        }
    }
    return { ok: true, written: written, pending: Object.keys(dirty).length };
}

/**
 * 只读状态（诊断 / 存储页 / 数据管理页）：每个键现在**落在哪里**、多大、什么时候写的。
 * @returns {{mode:'dir'|'localStorage', path:string, items:Array<{key:string,file:string,where:string,bytes:number,at:number}>, pending:number, migration:object|null, lastError:string, failures:number}}
 */
export function auxStoreInfo() {
    const dirMode = auxDirMode();
    const items = AUX_KEYS.map((key) => {
        let bytes = 0;
        let at = Number((meta[key] && meta[key].at) || 0);
        if (dirMode) { bytes = String(mem[key] == null ? '' : mem[key]).length; }
        else {
            try { const s = ls(); const raw = s ? s.getItem(key) : null; bytes = raw ? String(raw).length : 0; } catch (e) { bytes = 0; }
        }
        return { key: key, file: auxFileName(key), where: dirMode ? 'dir' : 'localStorage', bytes: bytes, at: at };
    });
    return {
        mode: dirMode ? 'dir' : 'localStorage',
        path: (() => { try { return auxDiskMode() ? String(localDiskInfo().dir || '') : localFilePath(); } catch (e) { return ''; } })(),
        disk: (() => { try { const i = localDiskInfo(); return { enabled: i.enabled, dir: i.dir, capability: i.capability }; } catch (e) { return null; } })(),
        items: items,
        pending: Object.keys(dirty).length,
        migration: initInfo ? Object.assign({}, initInfo) : null,
        lastError: stats.lastError,
        failures: stats.failures,
        stats: Object.assign({}, stats),
        parts: Object.assign({}, stats.parts),   // v3.32.0：日志结构化分片（按天文件 + manifest）的落点
    };
}

/**
 * v3.27.0：把某个**已写到服务端**的文件（快照链 / 同步日志）**额外收录一份到本地目录**（用户要求
 *   「快照、日志等信息……存储到对应目录下统一管理收纳」）。best-effort：失败只记诊断，绝不影响主写入。
 *   · 只读路径**不变**（权威仍在原命名空间，跨端同步语义不受影响）→ 目录里那份是「本机统一收纳的副本」。
 * @param {string} name 文件名（如 `ftt2-snap-xxxx.json`）
 * @param {string} text 明文内容
 * @returns {Promise<{ok:boolean, skipped?:string, bytes?:number, error?:string}>}
 */
export async function auxMirrorFile(name, text) {
    try {
        if (!auxDirMode()) return { ok: false, skipped: 'off' };
        const body = String(text == null ? '' : text);
        if (!body) return { ok: false, skipped: 'empty' };
        const file = AUX_FILE_PREFIX + String(name || 'file').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) + '.json';
        const w = await fileTransportUploadText(file, body, auxOpts(file));
        if (!w || !w.ok) { stats.failures++; stats.lastError = 'mirror-failed:' + file; return { ok: false, error: String((w && (w.error || w.reason)) || 'write-failed') }; }
        meta['mirror:' + file] = { at: Date.now(), bytes: body.length, file: file };
        stats.saves++;
        stats.lastAt = Date.now();
        return { ok: true, file: file, bytes: body.length };
    } catch (e) { stats.failures++; stats.lastError = String((e && e.message) || e); return { ok: false, error: stats.lastError }; }
}

/** 测试/诊断：重置会话内状态 */
export function auxStoreReset() {
    for (const k of Object.keys(mem)) delete mem[k];
    for (const k of Object.keys(dirty)) delete dirty[k];
    for (const k of Object.keys(meta)) delete meta[k];
    flushTimer = null; initDone = false; initInfo = null;
    stats.loads = 0; stats.saves = 0; stats.failures = 0; stats.migrated = 0; stats.lastError = ''; stats.lastAt = 0; stats.parts = {};
    return true;
}

export const auxStoreStats = stats;

export default {
    AUX_TABLE, AUX_FILE_PREFIX, AUX_KEYS,
    auxDirMode, auxFileName, auxLsGet, auxLsSet, auxLsRemove,
    auxStoreInit, auxStoreFlush, auxStoreInfo, auxStoreReset,
};
