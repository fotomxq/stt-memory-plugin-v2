// ============================================================
// adapters/sync.js —— **跨端同步与镜像**（B7-2，移植自 V1 `src/modules/06-存储后端与三型归类.js`）
// 覆盖：
//   ① 文件通道（服务端用户目录）：记忆文件（主/备份）+ **清单(meta)预判** + **快照链独立文件** + 同步日志文件；
//   ② `refreshFromServer`（「刷新状态」）＝取服务端最新（记忆文件/备份/快照文件）→ 原子合并 → 本端更全则回推；
//   ③ `crossSyncManual`（「立即同步」）＝识别最新端（超集整体替换 / 分歧原子融合）→ 推送并写备份 + 快照；
//   ④ `scheduleStorageSync`（保存后镜像，流量门控：楼层哈希差异 + 镜像推送签名）+ 清单命中零大文件下载；
//   ⑤ 同步日志（最近 30 条，本机环形 + 服务端交叉并集合并）；
//   ⑥ `storageVerify`（校验并修复）与 `storageStatusInfo`（UI 状态行）。
// 适配（与 V1 的差别，均在 docs/P8i-B7-2跨端同步.md 记录）：
//   · V1 有「统一存储抽象 + 多后端（localStorage/IndexedDB/存档变量/文件/世界书/楼层）」，V2 为
//     「本机缓冲（localStorage/IndexedDB）+ 服务端记忆文件」两型；故「跨端后端」判定收敛为**记忆文件**；
//   · 文件名沿用 V2 前缀 `ftt2-` 且为**明文 .json**（V1 主文件为 gzip）；主文件名与 B7-2 之前保持一致（不孤立旧文件）；
//   · `latestFloorFingerprint` 按 V1 **注释所述语义**（楼层号 + 正文稳定哈希）实现；V1 代码把「正文」传给
//     只接受楼层号的 `hashFloorText` → 实际比对一个无关哈希（详见文档「偏差」小节）。
// ============================================================
import {
    cfg, state, setKernelState, saveState, log, warn, notifyHooks, identityView, getLastMessageId,
} from '../core/model/runtime.js';
import { scopeId, emptyState } from '../core/state.js';
import { VERSION } from '../core/constants.js';
import { hashText } from '../core/util.js';
import { storageEnvelope, storageHash } from '../core/envelope.js';
import {
    atomEntryCount, dataAggHash, diffAtomData, mergeDataObjects, mergeSnapshotStores,
    snapshotSigOf, snapIndexFrom, mirrorPushSig,
} from '../core/cross-sync.js';
import {
    SYNC_LOG_MAX, syncLogMerge, syncLogPushRecord, syncLogStat, syncLogShortHash, syncLogSource,
} from '../core/sync-log.js';
import { migrateState } from '../core/migrate.js';
import { ensureAtomHashes } from '../core/merge.js';
import { mergeTombTrees, applyTombstonesToState } from '../core/sweep.js';
import { hashFloorText } from '../host/floors.js';
import { extractBusy } from '../host/extract.js';
import { getCtx } from '../host/st-api.js';
import {
    slugify, stateFileName as scopedStateFileName, uploadStateFile, readStateFile,
} from './user-file.js';

// ---------- 常量（V1 同名口径） ----------
const BAK_PREFIX = 'ftt2-bak-';
const META_PREFIX = 'ftt2-meta-';
const SNAP_PREFIX = 'ftt2-snap-';
const LOG_PREFIX = 'ftt2-log-';
const META_MISS_RETRY_MS = 5 * 60 * 1000;     // 确认无清单后 5 分钟内不再探测（旧版本端场景，避免每轮 404）
const STORAGE_SYNC_DELAY = 3000;              // 保存后镜像防抖（V1 `scheduleStorageSync`）
const META_PUSH_DELAY = 1200;
const SNAP_PUSH_DELAY = 2500;
const LOG_SERVER_PUSH_DELAY = 1500;

// ---------- 会话内状态 ----------
let fileReadCache = {};                        // name → { at, text }
let metaFileLastOkAt = 0, metaFileLastErr = '', metaFileMissingAt = 0, metaFilePushing = false;
let snapFileLastOkAt = 0, snapFilePushedSig = '', snapFileMerging = false, snapPushTimer = null;
let metaPushTimer = null;
let storageSyncTimer = null, storageSyncSkipRetries = 0, storageSyncRunning = false;
let lastMirror = { at: 0, ok: 0, total: 0, wrote: '', reason: '' };
let lastRefresh = null, lastManual = null;
let stateFileLastOkAt = 0, stateFileLastErr = '', stateFileLastBytes = 0;
let syncLogServerDisabled = false, syncLogServerWarned = false, syncLogServerLastOkAt = 0;
let syncLogServerLastError = '', syncLogServerMerging = false, syncLogServerPushTimer = null;
let remotePushSkipNotified = false;

// ---------- localStorage 小工具（本机缓冲；键按作用域隔离；可注入以便宿主/测试替换） ----------
let lsHooks = {
    get: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (e) { return null; } },
    set: (k, v) => { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, String(v)); return true; } catch (e) { return false; } },
    del: (k) => { try { if (globalThis.localStorage) globalThis.localStorage.removeItem(k); return true; } catch (e) { return false; } },
};
/** 注入本机存储钩子（宿主为 TauriTavern/自定义存储时使用；测试亦用） */
export function setSyncStorageHooks(next) { lsHooks = Object.assign({}, lsHooks, next || {}); return lsHooks; }
function lsGet(k) { try { return lsHooks.get(k); } catch (e) { return null; } }
function lsSet(k, v) { try { lsHooks.set(k, v); } catch (e) { /* 忽略 */ } }
function lsDel(k) { try { lsHooks.del(k); } catch (e) { /* 忽略 */ } }

/** 作用域短哈希（V1 `scopeHash8`）；用于文件/键名隔离 */
export function scopeHash8() {
    try { return (String(hashText(scopeId())) + String(hashText('ftt-scope:' + scopeId()))).slice(0, 8); } catch (e) { return '00000000'; }
}

/** 存档（角色）名称 —— 记忆按角色隔离，故取当前角色名作为可读标识 */
export function storageArchiveName() {
    try { return String(identityView.characterName || '').trim(); } catch (e) { return ''; }
}

const SLUG_CACHE_PREFIX = 'ftt2_FileSlug_';
const ARCHIVE_NAME_PREFIX = 'ftt2_ArchiveName_';
let slugMemoryCache = '';
function slugCacheKey() { return SLUG_CACHE_PREFIX + scopeHash8(); }
function archiveNameKey() { return ARCHIVE_NAME_PREFIX + scopeHash8(); }
function archiveNameCacheGet() { return lsGet(archiveNameKey()) || ''; }
function archiveNameCacheSet(nm) { if (nm) lsSet(archiveNameKey(), nm); }
/** 名称解析（实时优先；不可用时用上次已固化的名称兜底 —— 保证同名同文件） */
function resolvedArchiveName() {
    try {
        const live = storageArchiveName();
        if (live) { archiveNameCacheSet(live); return live; }
        return archiveNameCacheGet() || '';
    } catch (e) { return ''; }
}
function slugFromName() {
    try {
        const nm = resolvedArchiveName();
        if (!nm) return '';
        const s = String(nm).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
        return s || ('n' + String(hashText(nm)).slice(0, 6));
    } catch (e) { return ''; }
}
function slugFallback() { try { return 'n' + String(hashText(scopeId())).slice(0, 6); } catch (e) { return 'n000000'; } }
/** 文件名 slug：① 已固化 → 稳定；② 名称就绪 → 固化；③ 名称未就绪 → 确定性兜底（不缓存） */
export function storageSlug() {
    try {
        if (slugMemoryCache) return slugMemoryCache;
        const cached = lsGet(slugCacheKey());
        if (cached) { slugMemoryCache = cached; return cached; }
        const live = slugFromName();
        if (live) { slugMemoryCache = live; lsSet(slugCacheKey(), live); return live; }
        return slugFallback();
    } catch (e) { return slugFallback(); }
}

// ---------- 文件名（V1 命名规则：ftt-<kind>-<slug>-<scope8>[.json]） ----------
function fileNameBase(slug, kind) {
    if (kind === 'bak') return BAK_PREFIX + slug + '-' + scopeHash8();
    if (kind === 'snap') return SNAP_PREFIX + slug + '-' + scopeHash8();
    if (kind === 'meta') return META_PREFIX + slug + '-' + scopeHash8();
    if (kind === 'log') return LOG_PREFIX + slug + '-' + scopeHash8();
    return '';
}
/** 主记忆文件名 —— 与 B7-2 之前保持完全一致（不孤立已写出的文件；V2 口径：按作用域 slug） */
export function stateFileName() { return scopedStateFileName(scopeId()); }
export function bakFileName() { return fileNameBase(storageSlug(), 'bak') + '.json'; }
export function snapshotFileName() { return fileNameBase(storageSlug(), 'snap') + '.json'; }
export function metaFileName() { return fileNameBase(storageSlug(), 'meta') + '.json'; }
export function syncLogServerFile() { return fileNameBase(storageSlug(), 'log') + '.json'; }
export function syncLogServerUrl() { return '/user/files/' + syncLogServerFile(); }

// ---------- 文件通道（读缓存：同名文件同会话不重复下载） ----------
/** 清空文件读缓存（手动「刷新状态」「立即同步」= 取真值 → 绕开缓存） */
export function fileCacheDropAll() { fileReadCache = {}; return true; }
export function fileCacheStats() { return { names: Object.keys(fileReadCache).length }; }

async function filesReadText(name) {
    try {
        const r = await readStateFile(name);
        if (!r || !r.ok) return '';
        return String(r.text == null ? '' : r.text);
    } catch (e) { return ''; }
}
async function filesReadContentCached(name) {
    try {
        const key = String(name || '');
        if (!key) return null;
        if (fileReadCache[key]) return fileReadCache[key];
        const text = await filesReadText(key);
        if (!text) return null;
        const hit = { at: Date.now(), text };
        fileReadCache[key] = hit;
        return hit;
    } catch (e) { return null; }
}
async function filesUploadText(name, text) {
    try { return await uploadStateFile(name, text); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---------- 远端已合入指纹（清单预判的比对基准） ----------
function remoteStateHashKey() { return 'ftt2_RemoteStateHash_' + scopeHash8(); }
function remoteSnapSigKey() { return 'ftt2_RemoteSnapSig_' + scopeHash8(); }
export function remoteStateHashSeen() { return String(lsGet(remoteStateHashKey()) || ''); }
export function remoteStateHashMark(h) { if (h) lsSet(remoteStateHashKey(), String(h)); }
export function remoteSnapSigSeen() { return String(lsGet(remoteSnapSigKey()) || ''); }
export function remoteSnapSigMark(sig) { if (sig) lsSet(remoteSnapSigKey(), String(sig)); }

// ---------- 开关（V1 同名配置键） ----------
export function stateFileEnabled() { try { return !(cfg && cfg.storage && cfg.storage.stateFile === false); } catch (e) { return true; } }
export function stateBakEnabled() { try { return !(cfg && cfg.storage && cfg.storage.stateFileBak === false); } catch (e) { return true; } }
export function snapshotFileEnabled() { try { return !(cfg && cfg.storage && cfg.storage.snapshotFile === false); } catch (e) { return true; } }
export function settingsMirrorOn() { try { return !!(cfg && cfg.storage && cfg.storage.settingsMirror === true); } catch (e) { return false; } }
export function metaProbeEnabled() { try { return !(cfg && cfg.storage && cfg.storage.syncMetaProbe === false); } catch (e) { return true; } }
export function syncLogServerEnabled() { try { return !(cfg && cfg.storage && cfg.storage.syncLogServer === false); } catch (e) { return true; } }
export function syncOnSaveOn() { try { return !(cfg && cfg.storage && cfg.storage.syncOnSave === false); } catch (e) { return true; } }
export function syncTrafficGuardOn() { try { return !cfg || cfg.syncTrafficGuard !== false; } catch (e) { return true; } }

/** 快照链签名（id+ts）：未变化不重复上传（省流量） */
export function snapshotSig() { return snapshotSigOf(state && state.snapStore); }

// ============================================================
// 清单(meta) —— 轻量文件，用于「对端未变则跳过大文件下载」
// ============================================================
/** 清单载荷（写入侧）：hash 用**文件级**哈希（信封 payload 哈希，与读取侧解析出的 hash 同源可比） */
export function metaPayloadBuild(env, stateHashOverride) {
    try {
        const d = (env && env.payload && env.payload.data) || state || {};
        return {
            v: 1, scope: scopeId(), ts: Date.now(), by: VERSION,
            state: {
                name: stateFileName(),
                hash: String(stateHashOverride || (env && env.hash) || remoteStateHashSeen() || ''),
                bytes: Number(stateFileLastBytes) || 0,
                updatedAt: Number((env && env.payload && env.payload.updatedAt) || d.updatedAt || 0),
                entries: atomEntryCount(d),
            },
            snap: { name: snapshotFileName(), count: ((state && state.snapStore) || []).length, sig: snapshotSig() },
            log: { name: syncLogServerFile(), count: syncLogList().length },
        };
    } catch (e) { return null; }
}
export function metaFileLastInfo() { return { okAt: metaFileLastOkAt, err: metaFileLastErr, missingAt: metaFileMissingAt, name: metaFileName() }; }

/** 上传清单（单飞；失败静默 —— 只是下次退回整份下载，不影响正确性） */
export async function metaFilePushNow(env, stateHashOverride) {
    if (!metaProbeEnabled() || !stateFileEnabled()) return { ok: false, reason: 'off' };
    if (metaFilePushing) return { ok: false, reason: 'busy' };
    const payload = metaPayloadBuild(env, stateHashOverride);
    if (!payload) return { ok: false, reason: 'no-payload' };
    metaFilePushing = true;
    try {
        const name = metaFileName();
        const text = JSON.stringify(payload);
        const r = await filesUploadText(name, text);
        if (r && r.ok) {
            metaFileLastOkAt = Date.now(); metaFileLastErr = ''; metaFileMissingAt = 0;
            fileReadCache[name] = { at: Date.now(), text };      // 本会话读到的清单即最新
            return { ok: true, name, bytes: text.length };
        }
        metaFileLastErr = String((r && (r.error || r.status)) || 'fail');
        return { ok: false, reason: metaFileLastErr };
    } finally { metaFilePushing = false; }
}
export function scheduleMetaFilePush(env, stateHashOverride) {
    try {
        if (!metaProbeEnabled()) return false;
        if (metaPushTimer) clearTimeout(metaPushTimer);
        metaPushTimer = setTimeout(() => {
            metaPushTimer = null;
            try { const p = metaFilePushNow(env, stateHashOverride); if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
        }, META_PUSH_DELAY);
        return true;
    } catch (e) { return false; }
}
/** 读清单（带读缓存；不存在时本会话短暂记忆，避免每轮都探测旧版本端没有的文件） */
export async function metaFileRead() {
    try {
        if (!metaProbeEnabled() || !stateFileEnabled()) return null;
        const name = metaFileName();
        if (metaFileMissingAt && (Date.now() - metaFileMissingAt) < META_MISS_RETRY_MS && !fileReadCache[name]) return null;
        const got = await filesReadContentCached(name);
        if (!got || !got.text) { metaFileMissingAt = Date.now(); return null; }
        let j = null; try { j = JSON.parse(got.text); } catch (e) { return null; }
        if (!(j && j.v === 1 && j.scope === scopeId() && j.state && typeof j.state === 'object')) return null;
        metaFileMissingAt = 0;
        return j;
    } catch (e) { return null; }
}
/** 跳过判定：仅当「清单指向当前规范文件名」且「其文件级哈希 == 本端上次已合入的远端哈希」 */
export function metaStateSkipOk(mm) {
    try {
        if (!mm || !mm.state || !mm.state.hash) return false;
        if (String(mm.state.name || '') !== String(stateFileName())) return false;
        return String(mm.state.hash) === remoteStateHashSeen();
    } catch (e) { return false; }
}
export function metaSnapSkipOk(mm) {
    try {
        if (!mm || !mm.snap || !mm.snap.sig) return false;
        return String(mm.snap.sig) === remoteSnapSigSeen();
    } catch (e) { return false; }
}

// ============================================================
// 记忆文件（主/备份）读与写
// ============================================================
function envValid(env) {
    try { return !!(env && env.v && env.payload && env.payload.data && env.hash === storageHash(env.payload)); } catch (e) { return false; }
}
function stateHasData(d) {
    try {
        if (!d) return false;
        if (atomEntryCount(d) > 0) return true;
        if ((d.summaries || []).length) return true;
        if ((d.snapStore || []).length) return true;
        if (d.vars && Object.keys(d.vars || {}).length) return true;
        return false;
    } catch (e) { return false; }
}

/**
 * 读服务端记忆文件（主文件 → 备份文件）。返回 `{ env, from, name, all:[{env,name,kind}] }`。
 * @param {object} [opts] all=true 时同时返回全部有效来源（供并集合并）
 */
export async function stateFileReadAny(opts) {
    const wantAll = !!(opts && opts.all);
    const out = { env: null, from: '', name: '', all: [] };
    const tryOne = async (name, kind) => {
        const got = await filesReadContentCached(name);
        if (!got || !got.text) return null;
        let env = null; try { env = JSON.parse(got.text); } catch (e) { return null; }
        if (!envValid(env)) { warn('存储[' + kind + ']校验失败（hash 不匹配）→ 已忽略', ''); return null; }
        if (env.payload.scope && env.payload.scope !== scopeId()) return null;
        out.all.push({ env, name, kind });
        return env;
    };
    if (stateFileEnabled()) {
        const main = await tryOne(stateFileName(), 'state');
        if (main) { out.env = main; out.from = 'state'; out.name = stateFileName(); remoteStateHashMark(String(main.hash || '')); }
        if (stateBakEnabled()) {
            const bak = await tryOne(bakFileName(), 'bak');
            if (bak && !out.env) { out.env = bak; out.from = 'bak'; out.name = bakFileName(); }
        }
    }
    if (!wantAll) out.all = out.env ? out.all.slice(0, 1) : [];
    return out;
}

/**
 * 写记忆文件（主文件 + 可选备份）。主文件写入成功后刷新清单（下次同步先读清单）。
 * @param {object} env 标准化信封
 * @param {object} [opts] bak（是否同时写备份）
 */
export async function stateFileWrite(env, opts) {
    const o = opts || {};
    const out = { ok: false, uploaded: [], bak: false, name: '', reason: '', gz: false };
    if (!stateFileEnabled()) { out.reason = 'off'; return out; }
    if (!env || !env.payload || !env.payload.data) { out.reason = 'no-env'; return out; }
    const text = JSON.stringify(env);
    const r = await filesUploadText(stateFileName(), text);
    if (r && r.ok) {
        out.ok = true; out.name = stateFileName(); out.uploaded.push(out.name);
        stateFileLastOkAt = Date.now(); stateFileLastErr = ''; stateFileLastBytes = text.length;
        remoteStateHashMark(String(env.hash || ''));
        scheduleMetaFilePush(env, String(env.hash || ''));
        fileReadCache[stateFileName()] = { at: Date.now(), text };
        // 主文件不含快照链剥离（V2 主文件保留完整链）→ 快照文件仅在开启时另行镜像
        if (snapshotFileEnabled() && ((state && state.snapStore) || []).length && snapshotSig() !== snapFilePushedSig) {
            try { await snapshotFilePushNow(); } catch (e) { /* 忽略 */ }
        }
    } else {
        out.reason = String((r && (r.error || r.status)) || 'upload-failed');
        stateFileLastErr = out.reason;
    }
    if ((o.bak === undefined ? stateBakEnabled() : !!o.bak) && stateFileEnabled()) {
        const rb = await filesUploadText(bakFileName(), text);
        out.bak = !!(rb && rb.ok);
        if (out.bak) out.uploaded.push(bakFileName());
    }
    return out;
}

/** 记忆文件状态（UI 状态行 / 调试） */
export function stateFileStatus() {
    return {
        enabled: stateFileEnabled(), bakEnabled: stateBakEnabled(), snapEnabled: snapshotFileEnabled(),
        mirrorSettings: settingsMirrorOn(), lastOkAt: stateFileLastOkAt, lastOk: !!stateFileLastOkAt,
        err: stateFileLastErr, name: stateFileName(), bak: bakFileName(), snap: snapshotFileName(),
        meta: metaFileName(), metaOkAt: metaFileLastOkAt, metaErr: metaFileLastErr,
        slug: storageSlug(), archive: storageArchiveName(), scope8: scopeHash8(),
        bytes: stateFileLastBytes,
    };
}

// ============================================================
// 快照链独立文件（与主文件解耦：双端并集合并）
// ============================================================
export async function snapshotFileReadAny() {
    if (!snapshotFileEnabled()) return null;
    try {
        const got = await filesReadContentCached(snapshotFileName());
        if (!got || !got.text) return null;
        let j = null; try { j = JSON.parse(got.text); } catch (e) { return null; }
        if (j && j.scope === scopeId() && Array.isArray(j.snapStore)) return j;
        return null;
    } catch (e) { return null; }
}
export async function snapshotFilePushNow() {
    if (!snapshotFileEnabled()) return { ok: false, reason: 'off' };
    try {
        // 快照文件同时承载 snapFp（删除指纹 —— 与链同源，随文件跨端）
        const payload = {
            v: 1, scope: scopeId(), updatedAt: Date.now(), count: ((state && state.snapStore) || []).length,
            snapStore: (state && state.snapStore) || [], snapFp: (state && state.snapFp) || {},
        };
        const text = JSON.stringify(payload);
        const r = await filesUploadText(snapshotFileName(), text);
        if (r && r.ok) {
            snapFileLastOkAt = Date.now(); snapFilePushedSig = snapshotSig();
            remoteSnapSigMark(snapFilePushedSig);
            fileReadCache[snapshotFileName()] = { at: Date.now(), text };
            scheduleMetaFilePush(null, '');
            return { ok: true, count: payload.count, name: snapshotFileName() };
        }
        return { ok: false, reason: String((r && (r.error || r.status)) || 'failed') };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
export function scheduleSnapshotFilePush(force) {
    try {
        if (!snapshotFileEnabled()) return false;
        if (!((state && state.snapStore) || []).length) return false;
        if (!force && snapshotSig() === snapFilePushedSig) return false;
        if (snapPushTimer) clearTimeout(snapPushTimer);
        snapPushTimer = setTimeout(() => {
            snapPushTimer = null;
            try { const p = snapshotFilePushNow(); if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
        }, SNAP_PUSH_DELAY);
        return true;
    } catch (e) { return false; }
}
/** 快照文件 → 本地并集合并（不同端各自的快照链互相补全；返回是否发生变化） */
export async function snapshotFilePullMerge() {
    if (!snapshotFileEnabled() || snapFileMerging) return false;
    snapFileMerging = true;
    try {
        // 清单预判 —— 远端快照链自上次合入后未变化 → 跳过整份快照下载（慢链路省一次大文件 GET）
        try {
            const mm = await metaFileRead();
            if (metaSnapSkipOk(mm)) { log('对账：快照清单未变化 → 跳过快照文件下载（流量保护）'); return false; }
        } catch (e) { /* 忽略 */ }
        const remote = await snapshotFileReadAny();
        if (!remote) return false;
        try { remoteSnapSigMark(snapshotSigOf(remote.snapStore)); } catch (e) { /* 忽略 */ }
        // snapFp 随快照文件回来（本端无指纹时采纳）
        try {
            if ((!state.snapFp || !Object.keys(state.snapFp || {}).length) && remote.snapFp && Object.keys(remote.snapFp).length) state.snapFp = remote.snapFp;
        } catch (e) { /* 忽略 */ }
        const before = JSON.stringify(state.snapStore || []);
        const merged = mergeSnapshotStores(state.snapStore || [], remote.snapStore || []);
        const after = JSON.stringify(merged);
        if (after !== before) {
            state.snapStore = merged;
            try { saveState(); } catch (e) { /* 忽略 */ }
            return true;
        }
        return false;
    } catch (e) { return false; } finally { snapFileMerging = false; }
}

// ============================================================
// 远端合并（原子级 + 快照并集 + 墓碑过滤）
// ============================================================
/** 楼层正文哈希解析器（供「已处理楼层并集」判据使用；V1 `hashFloorText`） */
function floorHashResolver(i) { try { return hashFloorText(i); } catch (e) { return ''; } }

/** 整体采用远端信封（替换处置）：保留本端删除墓碑，并按「并集墓碑」过滤采纳进来的数据 */
export function adoptRemoteEnvelope(env) {
    try {
        if (!env || !env.payload || !env.payload.data) return false;
        const prevSnaps = Array.isArray(state.snapStore) ? state.snapStore.slice() : [];
        const prevDel = state.deleted || {}, prevDelH = state.deletedH || {};
        const next = migrateState(Object.assign(emptyState(), env.payload.data));
        if (!Array.isArray(next.snapStore)) next.snapStore = [];
        next.snapStore = mergeSnapshotStores(prevSnaps, next.snapStore.concat((env.payload.data.snapStore) || []));
        next.deleted = mergeTombTrees(prevDel, next.deleted || {});
        next.deletedH = mergeTombTrees(prevDelH, next.deletedH || {});
        setKernelState(next);
        applyTombstonesToState(true);            // 采纳进来的条目按并集墓碑过滤（删除保持删除）
        ensureAtomHashes();
        return true;
    } catch (e) { warn('采用远端版本失败', e); return false; }
}

/** 把远端信封按「原子合并 + 快照链并集」并入当前 state（冲突自动仲裁） */
export function applyRemoteMergeToState(remoteEnv) {
    try {
        if (!remoteEnv || !remoteEnv.payload || !remoteEnv.payload.data) return null;
        const rem = remoteEnv.payload.data;
        const aggL = dataAggHash(state), aggR = dataAggHash(rem);
        const diffStat = diffAtomData(state, rem);
        if (aggL === aggR) {
            const before = (state.snapStore || []).length;
            state.snapStore = mergeSnapshotStores(state.snapStore || [], rem.snapStore || []);
            state.updatedAt = Math.max(Number(state.updatedAt) || 0, Number(remoteEnv.payload.updatedAt) || 0);
            return { mode: 'same', diff: diffStat, snaps: (state.snapStore || []).length, snapChanged: (state.snapStore || []).length !== before };
        }
        const merged = mergeDataObjects(state, rem, { hashFloor: floorHashResolver });
        setKernelState(merged.data);
        state.snapStore = mergeSnapshotStores(state.snapStore || [], rem.snapStore || []);
        return { mode: 'merge', stat: merged.stat, diff: diffStat, snaps: (state.snapStore || []).length };
    } catch (e) { warn('远端合并应用失败', e); return null; }
}

// ============================================================
// 常规镜像写入（V2：主文件由保存流水线写；此处补齐备份 + 清单 + 快照链）
// ============================================================
export async function storageWriteAll(env, opts) {
    const o = opts || {};
    let ok = 0, total = 0;
    const wrote = [];
    if (stateFileEnabled()) {
        total++;
        const res = await stateFileWrite(env, { bak: o.bak === true ? true : undefined });
        if (res && res.ok) { ok++; wrote.push('state'); }
    }
    total++;
    const snapRes = snapshotFileEnabled() && ((state && state.snapStore) || []).length ? await snapshotFilePushNow() : { ok: false, reason: 'off' };
    if (snapRes && snapRes.ok) { ok++; wrote.push('snap'); }
    metaFilePushNow(env, String((env && env.hash) || '')).then(() => { /* 忽略 */ }).catch(() => { /* 忽略 */ });
    // 记录本次推送内容签名 —— 后续同内容保存不再重复写回（流量保护）
    if (ok > 0) mirrorPushMark();
    lastMirror = { at: Date.now(), ok, total, wrote: wrote.join('+'), reason: '' };
    return { ok, total, wrote };
}

// ============================================================
// 流量门控：楼层哈希差异 + 镜像推送签名
// ============================================================
function syncGateStoreKey() { return 'ftt2_SyncGate_' + scopeHash8(); }
export function syncGateLoad() { try { const raw = lsGet(syncGateStoreKey()); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
function syncGateSave(o) { try { lsSet(syncGateStoreKey(), JSON.stringify(o)); } catch (e) { /* 忽略 */ } }
/** 最新楼层指纹（楼层号 + 正文稳定哈希）—— 纯本地，无网络 */
export function latestFloorFingerprint() {
    try {
        const f = Number(getLastMessageId());
        if (!Number.isFinite(f) || f < 0) return null;
        const h = String(hashFloorText(f) || '');
        if (!h) return null;
        return { f, h };
    } catch (e) { return null; }
}
/** 与「存档」差异判定：最新楼层未归档 / 归档哈希不一致 / 该指纹尚未同步过 → differs=true（需同步） */
export function syncFloorDiffersFromArchive() {
    if (!syncTrafficGuardOn()) return { differs: true, fp: latestFloorFingerprint(), why: 'guard-off' };
    const fp = latestFloorFingerprint();
    if (!fp) return { differs: false, fp: null, why: 'no-floor' };
    const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
    let archivedHash = '';
    for (const x of pf) { if (Number(x && x.f) === fp.f) { archivedHash = String((x && x.h) || ''); break; } }
    if (!archivedHash) return { differs: true, fp, why: 'unarchived' };        // 新楼层：尚未归档 → 有差异
    if (archivedHash !== fp.h) return { differs: true, fp, why: 'changed' };   // 楼层正文被编辑 → 有差异
    const gate = syncGateLoad();
    if (!gate || Number(gate.f) !== fp.f || String(gate.h) !== fp.h) return { differs: true, fp, why: 'unsynced' };
    return { differs: false, fp, why: 'same' };                                 // 已归档且已同步 → 无差异
}
export function syncGateMark(fp) {
    const x = fp || latestFloorFingerprint();
    if (x) syncGateSave({ f: x.f, h: x.h, at: Date.now() });
}
/** 镜像推送签名（不含 updatedAt：每次保存都会刷新它，否则永远「变了」） */
export function mirrorPushSigNow() { return mirrorPushSig(state || {}); }
function mirrorPushSigKey() { return 'ftt2_LastPushSig_' + scopeHash8(); }
export function mirrorPushNeeded() {
    if (!syncTrafficGuardOn()) return true;
    try {
        const sig = mirrorPushSigNow();
        if (!sig) return true;
        return String(lsGet(mirrorPushSigKey()) || '') !== sig;
    } catch (e) { return true; }
}
export function mirrorPushMark() { try { lsSet(mirrorPushSigKey(), mirrorPushSigNow()); } catch (e) { /* 忽略 */ } }

// ============================================================
// 同步日志（本机环形 + 服务端交叉并集合并）
// ============================================================
function syncLogStorageKey() { return 'ftt2_SyncLog_' + scopeHash8(); }
export function syncLogList() {
    try {
        const raw = lsGet(syncLogStorageKey());
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
}
function syncLogSave(list) { try { lsSet(syncLogStorageKey(), JSON.stringify(list || [])); } catch (e) { /* 忽略 */ } }
/** 本端源头（浏览器依据 + 短码）—— 供同步日志追溯是「哪台设备/哪个浏览器」 */
export function syncLocalSource() { try { return syncLogSource(globalThis.navigator); } catch (e) { return '未知'; } }
/** 记一条同步日志（V1 `crossSyncLogPush`）：头部插入 + ts/src 自动附带 + 服务端 1.5s 防抖镜像 */
export function syncLogPush(rec) {
    try {
        const list = syncLogPushRecord(syncLogList(), rec, { src: syncLocalSource(), max: SYNC_LOG_MAX });
        syncLogSave(list);
        scheduleSyncLogServerPush();
        return list.length;
    } catch (e) { return 0; }
}
export function syncLogClear() {
    try { lsDel(syncLogStorageKey()); } catch (e) { /* 忽略 */ }
    // 同步清空服务端镜像（否则下次启动交叉合并会把对端旧记录又合回来）
    try {
        if (syncLogServerEnabled() && !syncLogServerDisabled) {
            const p = filesUploadText(syncLogServerFile(), '[]');
            if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ });
        }
    } catch (e) { /* 忽略 */ }
    return 0;
}
function syncLogServerMarkFailed(status) {
    try {
        syncLogServerDisabled = true;
        syncLogServerLastError = 'HTTP ' + status;
        if (!syncLogServerWarned) {
            syncLogServerWarned = true;
            warn('同步日志[服务端]不可用（HTTP ' + status + '）—— 本会话日志仅存本机（记忆同步功能不受影响）', '');
        }
    } catch (e) { /* 忽略 */ }
}
export function syncLogServerStatus() {
    return {
        enabled: syncLogServerEnabled(), disabled: syncLogServerDisabled, error: syncLogServerLastError,
        lastOkAt: syncLogServerLastOkAt, file: syncLogServerFile(), url: syncLogServerUrl(),
    };
}
/**
 * 读-合并-回传（核心）：打开页面时取最新并对齐；本机更全时才回传服务端（不整份覆盖语义）。
 * @param {object} [opts] force=true 时即使本会话判定不可用也重试一次（手动「刷新日志」）
 */
export async function syncLogServerMerge(opts) {
    if (!syncLogServerEnabled()) return { ok: false, reason: 'off' };
    if (syncLogServerDisabled && !(opts && opts.force)) return { ok: false, reason: 'disabled' };
    if (syncLogServerMerging) return { ok: false, reason: 'busy' };
    syncLogServerMerging = true;
    try {
        const local = syncLogList();
        let remote = [];
        const txt = await filesReadText(syncLogServerFile());
        if (txt) { try { const j = JSON.parse(txt); if (Array.isArray(j)) remote = j; } catch (e) { /* 忽略 */ } }
        const merged = syncLogMerge(remote, local, SYNC_LOG_MAX);
        const mergedJson = JSON.stringify(merged);
        const localChanged = mergedJson !== JSON.stringify(local);
        if (localChanged) syncLogSave(merged);
        const remoteChanged = mergedJson !== JSON.stringify(remote);
        let uploaded = false;
        if (remoteChanged && merged.length) {
            const up = await filesUploadText(syncLogServerFile(), mergedJson);
            uploaded = !!(up && up.ok);
            if (uploaded) { syncLogServerLastOkAt = Date.now(); syncLogServerLastError = ''; syncLogServerDisabled = false; }
            else if (up && (up.status === 401 || up.status === 403)) syncLogServerMarkFailed(up.status);
            else if (up && up.error) syncLogServerLastError = String(up.error);
        }
        return { ok: true, localN: local.length, remoteN: remote.length, mergedN: merged.length, localChanged, uploaded };
    } catch (e) { return { ok: false, reason: 'error' }; } finally { syncLogServerMerging = false; }
}
export function scheduleSyncLogServerPush() {
    try {
        if (!syncLogServerEnabled() || syncLogServerDisabled) return false;
        if (syncLogServerPushTimer) { clearTimeout(syncLogServerPushTimer); syncLogServerPushTimer = null; }
        syncLogServerPushTimer = setTimeout(() => {
            syncLogServerPushTimer = null;
            try { const p = syncLogServerMerge({}); if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
        }, LOG_SERVER_PUSH_DELAY);
        return true;
    } catch (e) { return false; }
}

// ============================================================
// 双向同步（立即同步 / 刷新状态）
// ============================================================
/** 长任务（摘要/提取）在途 → 拒绝/推迟同步（避免并发读写同一份记忆数据） */
function longTaskBusy() { try { return !!extractBusy(); } catch (e) { return false; } }

/** 对端信息纯计算（供同步决策/提示/测试）：same / replace-remote / replace-local / divergence / merge */
export function crossComputeInfo(localData, remoteData, remoteTs) {
    try {
        const localTs = Number((localData && localData.updatedAt) || Date.now()) || 0;
        const rts = Number(remoteTs) || Number((remoteData && remoteData.updatedAt) || 0) || 0;
        const aggSame = dataAggHash(localData) === dataAggHash(remoteData);
        const diff = diffAtomData(localData, remoteData);
        const localN = atomEntryCount(localData), remoteN = atomEntryCount(remoteData);
        let mode = 'same';
        if (!aggSame) {
            const remoteSup = diff.onlyLocal === 0 && diff.conflictWinLocal === 0;
            const localSup = diff.onlyRemote === 0 && diff.conflictWinRemote === 0;
            if (remoteSup) mode = 'replace-remote';
            else if (localSup) mode = 'replace-local';
            else if (diff.conflict > 0) mode = 'divergence';
            else mode = 'merge';
        }
        return {
            aggSame, diff, mode, localTs, remoteTs: rts, tsDiff: Math.abs(rts - localTs),
            localN, remoteN, newer: rts > localTs ? 'remote' : (localTs > rts ? 'local' : 'tie'),
        };
    } catch (e) { return { mode: 'error', error: String((e && e.message) || e).slice(0, 120) }; }
}

/** 读取跨端（服务端记忆文件）中「最新且有数据」的有效信封 */
export async function crossFindRemoteEnv() {
    try {
        const fr = await stateFileReadAny({ all: true });
        let remote = null;
        for (const it of (fr.all || [])) {
            const env = it && it.env;
            if (!env) continue;
            const hasNew = stateHasData(env.payload.data);
            const hasCur = remote ? stateHasData(remote.payload.data) : false;
            if (!remote || (hasNew && !hasCur) || (hasNew === hasCur && Number(env.payload.updatedAt) > Number(remote.payload.updatedAt))) remote = env;
        }
        return remote;
    } catch (e) { return null; }
}

/** 同步日志的统计字段补齐（V1 `pickN` 口径：兼容 {n,bytes} 与 {localN,localBytes}） */
function pickN(v, alt, fb) {
    const x = (v !== undefined && v !== null) ? v : ((alt !== undefined && alt !== null) ? alt : fb);
    return Number(x) || 0;
}

/**
 * 「立即同步」= 双向：识别最新端（超集 → 整体替换；分歧 → 原子融合），再推送 + 写备份 + 快照。
 * @returns {Promise<{mode:string, side?:string, info?:object, stat?:object, error?:string}>}
 */
export async function crossSyncManual() {
    const t0 = Date.now();
    if (longTaskBusy()) {
        log('对账：立即同步被拒绝（长任务进行中，避免并发读写）');
        return { mode: 'blocked', info: null, error: '摘要/提取/修复等长任务正在进行；为避免与任务并发读写同一份记忆数据，请等任务结束后再点「立即同步」' };
    }
    if (storageSyncRunning) return { mode: 'busy', info: null, error: '另有同步在进行中' };
    storageSyncRunning = true;
    fileCacheDropAll();                     // 手动「立即同步」= 取真值 → 绕开读缓存
    const mkLog = (mode, changed, stat, note) => {
        try {
            const s = stat || {};
            const cur = syncLogStat(state);
            syncLogPush({
                action: '手动立即同步', mode, changed, ms: Date.now() - t0,
                localN: pickN(s.localN, s.n, cur.n), localBytes: pickN(s.localBytes, s.bytes, cur.bytes),
                remoteN: pickN(s.remoteN, s.rn, 0), remoteBytes: pickN(s.remoteBytes, s.rbytes, 0),
                afterN: pickN(s.afterN, s.n, cur.n), afterBytes: pickN(s.afterBytes, s.bytes, cur.bytes),
                localHash: s.localHash !== undefined ? s.localHash : dataAggHash(state),
                remoteHash: s.remoteHash !== undefined ? s.remoteHash : '',
                afterHash: s.afterHash !== undefined ? s.afterHash : (s.localHash !== undefined ? s.localHash : dataAggHash(state)),
                note,
            });
            if (mode !== '无对端') syncGateMark();
        } catch (e) { /* 忽略 */ }
    };
    try {
        const env = await crossFindRemoteEnv();
        if (!env) {
            mkLog('无对端', false, { localHash: dataAggHash(state) }, '未检测到对端数据（已写入本端记忆文件 + 备份）');
            lastManual = { mode: 'none', info: null };
            return { mode: 'none', info: null };
        }
        const info = crossComputeInfo(state, env.payload.data, env.payload.updatedAt);
        const localStat = syncLogStat(state);
        const remoteStat = syncLogStat(env.payload.data);
        const hL = dataAggHash(state), hR = dataAggHash(env.payload.data);
        const afterStat = () => syncLogStat(state);
        const afterHash = () => dataAggHash(state);
        if (info.mode === 'same') {
            mkLog('两端一致', false, Object.assign({}, localStat, { remoteN: remoteStat.n, remoteBytes: remoteStat.bytes, afterN: localStat.n, afterBytes: localStat.bytes, localHash: hL, remoteHash: hR, afterHash: hL }), '内容一致，仅对齐');
            lastManual = { mode: 'same', info };
            return { mode: 'same', info };
        }
        if (info.mode === 'replace-remote') {
            adoptRemoteEnvelope(env);
            const a = afterStat();
            mkLog('整体采用对端', true, Object.assign({}, localStat, { remoteN: remoteStat.n, remoteBytes: remoteStat.bytes, afterN: a.n, afterBytes: a.bytes, localHash: hL, remoteHash: hR, afterHash: afterHash() }), '对端最新/超集 → 整体替换');
            lastManual = { mode: 'replace', side: 'remote', info };
            return { mode: 'replace', side: 'remote', info };
        }
        if (info.mode === 'replace-local') {
            mkLog('本端为超集', false, Object.assign({}, localStat, { remoteN: remoteStat.n, remoteBytes: remoteStat.bytes, afterN: localStat.n, afterBytes: localStat.bytes, localHash: hL, remoteHash: hR, afterHash: hL }), '本端更新更多：保留本地，随后推送覆盖对端');
            lastManual = { mode: 'replace', side: 'local', info };
            return { mode: 'replace', side: 'local', info };
        }
        // 分歧：立即同步采用「原子融合」（冲突按更新方胜）后推送
        const r = applyRemoteMergeToState(env);
        if (!r) {
            mkLog('融合失败', false, Object.assign({}, localStat, { remoteN: remoteStat.n, remoteBytes: remoteStat.bytes, afterN: localStat.n, afterBytes: localStat.bytes, localHash: hL, remoteHash: hR, afterHash: hL }), '对端信封无效，未改动本端');
            return { mode: 'merge-failed', info };
        }
        const a2 = afterStat();
        mkLog('双向原子融合', true, Object.assign({}, localStat, { remoteN: remoteStat.n, remoteBytes: remoteStat.bytes, afterN: a2.n, afterBytes: a2.bytes, localHash: hL, remoteHash: hR, afterHash: afterHash() }), '新增 ' + ((r.stat && r.stat.added) || 0) + '，冲突按更新方胜');
        lastManual = { mode: 'merge', info };
        return { mode: 'merge', stat: r.stat || {}, info };
    } catch (e) {
        warn('立即同步处置失败', e);
        try { syncLogPush({ action: '手动立即同步', mode: '失败', changed: false, ms: Date.now() - t0, note: String((e && e.message) || e).slice(0, 120) }); } catch (e2) { /* 忽略 */ }
        return { mode: 'error', info: null, error: String((e && e.message) || e).slice(0, 120) };
    } finally {
        // 立即同步 = 同步 + 备份 —— 无论处置结果如何都写一份当前（收敛后）状态 + 备份，并确保快照链为最新
        try { saveState(); } catch (e) { /* 忽略 */ }
        try { await stateFileWrite(storageEnvelope(state), { bak: true }); } catch (e) { /* 忽略 */ }
        try { if (((state && state.snapStore) || []).length) await snapshotFilePushNow(); } catch (e) { /* 忽略 */ }
        storageSyncRunning = false;
    }
}

/**
 * 「刷新状态」= 获取服务端最新数据并与本端自动合并：
 *   ① 强制读取服务端记忆文件（主/备份）+ 快照文件；② 以本端为基准套用原子合并（含双端墓碑，删除不复活）；
 *   ③ 若本端有变化则落盘并回推；④ 返回对比报告供 UI 展示。
 */
export async function refreshFromServer() {
    const rep = { at: Date.now(), file: null, bakFallback: false, snap: false, snapPushed: false, merged: null, pushed: false, err: '', blocked: false };
    if (storageSyncRunning) { rep.err = 'busy'; return rep; }
    if (longTaskBusy()) {
        rep.blocked = true;
        rep.err = '任务进行中：摘要/提取/修复等正在运行；为避免与任务并发读写记忆数据，请等任务结束后再刷新';
        return rep;
    }
    storageSyncRunning = true;
    fileCacheDropAll();                       // 手动「刷新状态」= 取服务端真值 → 绕开读缓存
    try {
        const beforeN = atomEntryCount(state), beforeBytes = JSON.stringify(state).length, beforeHash = dataAggHash(state);
        const beforeSnaps = ((state && state.snapStore) || []).length;
        rep.snapBefore = beforeSnaps;
        const fr = await stateFileReadAny({ all: true });
        rep.file = fr.env ? {
            from: fr.from, name: fr.name, updatedAt: fr.env.payload.updatedAt,
            entries: atomEntryCount(fr.env.payload.data), bytes: JSON.stringify(fr.env).length, files: (fr.all || []).length,
        } : null;
        rep.bakFallback = fr.from === 'bak';
        try { rep.snap = await snapshotFilePullMerge(); } catch (e) { /* 忽略 */ }
        // 依次并入（**全部候选文件** → 并集合并，任一端数据都不丢）
        const candidates = [];
        (fr.all || []).forEach((it) => { const e = it && it.env; if (e && !candidates.some(x => x.hash === e.hash)) candidates.push(e); });
        for (const env of candidates) { try { applyRemoteMergeToState(env); } catch (e) { /* 忽略 */ } }
        const snapAfter = (state && state.snapStore) || [];
        const changed = dataAggHash(state) !== beforeHash || atomEntryCount(state) !== beforeN || snapAfter.length !== rep.snapBefore;
        let pushed = false;
        if (candidates.length) {
            try { saveState(); } catch (e) { /* 忽略 */ }
            const w = await stateFileWrite(storageEnvelope(state), {});
            pushed = !!(w && w.ok);
        }
        try { if (snapAfter.length) { const sp = await snapshotFilePushNow(); if (sp && sp.ok) rep.snapPushed = true; } } catch (e) { /* 忽略 */ }
        rep.merged = { entries: atomEntryCount(state), bytes: JSON.stringify(state).length, snaps: snapAfter.length, changed: !!changed };
        rep.pushed = pushed;
        try {
            const st = syncLogStat(state);
            syncLogPush({
                action: '刷新状态（服务端最新）', mode: candidates.length ? '合并服务端' : '服务端无数据', changed: !!changed,
                localN: beforeN, localBytes: beforeBytes, remoteN: rep.file ? rep.file.entries : 0,
                remoteBytes: rep.file ? rep.file.bytes : 0, afterN: st.n, afterBytes: st.bytes,
                localHash: dataAggHash(state), remoteHash: '', afterHash: dataAggHash(state),
                note: '源 ' + (fr.from === 'bak' ? '备份文件' : (fr.env ? '记忆文件' : '无')) + (fr.name ? '[' + fr.name + ']' : '') + (candidates.length > 1 ? ' 等 ' + candidates.length + ' 个源' : '') + '；自动合并（删除墓碑生效）',
            });
        } catch (e) { /* 忽略 */ }
        lastRefresh = rep;
        return rep;
    } catch (e) {
        rep.err = String((e && e.message) || e).slice(0, 120);
        lastRefresh = rep;
        return rep;
    } finally { storageSyncRunning = false; }
}

/**
 * 保存后镜像（V1 `scheduleStorageSync`）—— 防抖 3s；两条流量门控：
 *   ① 楼层哈希差异门控（无差异 → 零网络请求）；② 镜像推送签名门控（内容未变 → 不重复写回）。
 * @param {boolean} force 绕过门控（手动 / 首次打开聊天）
 */
export function scheduleStorageSync(force) {
    try {
        if (!syncOnSaveOn() && !force) return false;
        if (storageSyncTimer) clearTimeout(storageSyncTimer);
        storageSyncTimer = setTimeout(() => {
            storageSyncTimer = null;
            const p = runStorageSync(!!force);
            if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ });
        }, STORAGE_SYNC_DELAY);
        return true;
    } catch (e) { return false; }
}

/** 保存后镜像的实际执行（默认导出于测试与调试） */
export async function runStorageSync(force) {
    if (storageSyncRunning) {
        storageSyncSkipRetries++;
        log('对账：保存后推送延迟（同步在途，避免并发读写远端）', storageSyncSkipRetries);
        if (storageSyncSkipRetries <= 5) { scheduleStorageSync(force); return { skipped: 'busy' }; }
        storageSyncSkipRetries = 0;
        return { skipped: 'busy-final' };
    }
    const gate = force ? { differs: true, why: 'forced' } : syncFloorDiffersFromArchive();
    if (!gate.differs) {
        lastMirror = { at: Date.now(), ok: 0, total: 0, wrote: '', reason: 'gate-' + gate.why };
        return { skipped: 'gate', why: gate.why };
    }
    storageSyncRunning = true;
    const t0 = Date.now();
    try {
        if (!force && !mirrorPushNeeded()) {
            const st = syncLogStat(state);
            const lh = dataAggHash(state);
            syncLogPush({
                action: '保存后镜像', mode: '推送(门控)', changed: false, ms: Date.now() - t0,
                localN: st.n, localBytes: st.bytes, remoteN: st.n, remoteBytes: st.bytes, afterN: st.n, afterBytes: st.bytes,
                localHash: lh, remoteHash: '', afterHash: lh,
                note: '内容未变化 → 未读远端，仅跳过重复写回（流量保护）',
            });
            return { skipped: 'mirror-sig' };
        }
        // 清单预判：远端自上次合入后未变化 → 跳过大文件下载（只推送本端内容）
        let metaSkip = false;
        try {
            const mm = await metaFileRead();
            if (metaStateSkipOk(mm)) metaSkip = true;
        } catch (e) { /* 忽略 */ }
        if (!metaSkip) {
            // 远端有变化时先拉取合并（避免覆盖对端新数据）
            try {
                const rem = await crossFindRemoteEnv();
                if (rem) applyRemoteMergeToState(rem);
            } catch (e) { /* 忽略 */ }
        }
        try { saveState(); } catch (e) { /* 忽略 */ }
        const w = await storageWriteAll(storageEnvelope(state), {});
        const st = syncLogStat(state);
        const lh = dataAggHash(state);
        syncLogPush({
            action: '保存后镜像', mode: metaSkip ? '推送(清单命中)' : '拉取合并后推送', changed: !metaSkip, ms: Date.now() - t0,
            localN: st.n, localBytes: st.bytes, remoteN: st.n, remoteBytes: st.bytes, afterN: st.n, afterBytes: st.bytes,
            localHash: lh, remoteHash: '', afterHash: lh,
            note: metaSkip ? '清单未变化 → 跳过远端下载，仅推送本端内容（流量保护）' : '读取远端并原子合并后推送（删除墓碑生效）',
        });
        syncGateMark(gate.fp);
        return { ok: w.ok, total: w.total, mode: metaSkip ? 'push-only' : 'pull-merge-push' };
    } catch (e) {
        warn('保存后镜像失败', e);
        return { error: String((e && e.message) || e).slice(0, 120) };
    } finally { storageSyncRunning = false; }
}

// ============================================================
// 校验并修复
// ============================================================
/**
 * 校验各后端（本机缓冲 / 服务端记忆文件 / 快照文件）并按最新有效源修复。
 * @param {boolean} repair 是否执行修复
 */
export async function storageVerify(repair) {
    const details = [];
    // ① 本机缓冲
    try {
        const raw = await readLocalEnvelope();
        details.push({ name: '本机缓冲', has: !!raw, ok: !!(raw && envValid(raw)), note: raw ? (envValid(raw) ? '哈希一致' : '哈希不一致') : '无数据' });
    } catch (e) { details.push({ name: '本机缓冲', has: false, ok: false, note: '读取异常' }); }
    // ② 服务端记忆文件（主）
    let main = null;
    try {
        const got = await filesReadContentCached(stateFileName());
        if (got && got.text) { try { main = JSON.parse(got.text); } catch (e) { main = null; } }
        details.push({ name: '记忆文件(主)', has: !!main, ok: !!main && envValid(main), note: main ? (envValid(main) ? '哈希一致' : '校验失败') : '文件不存在' });
    } catch (e) { details.push({ name: '记忆文件(主)', has: false, ok: false, note: '读取异常' }); }
    // ③ 备份文件
    let bakEnv = null;
    try {
        const got = await filesReadContentCached(bakFileName());
        if (got && got.text) { try { bakEnv = JSON.parse(got.text); } catch (e) { bakEnv = null; } }
        details.push({ name: '记忆文件(备份)', has: !!bakEnv, ok: !!bakEnv && envValid(bakEnv), note: bakEnv ? (envValid(bakEnv) ? '哈希一致' : '校验失败') : '文件不存在' });
    } catch (e) { details.push({ name: '记忆文件(备份)', has: false, ok: false, note: '读取异常' }); }
    // ④ 快照文件
    try {
        const snap = await snapshotFileReadAny();
        details.push({ name: '快照链文件', has: !!snap, ok: !!snap, note: snap ? (snap.count || 0) + ' 个快照' : '文件不存在' });
    } catch (e) { details.push({ name: '快照链文件', has: false, ok: false, note: '读取异常' }); }
    // ⑤ 清单
    try {
        const mm = await metaFileRead();
        details.push({ name: '服务端清单', has: !!mm, ok: !!mm, note: mm ? '条目 ' + Number((mm.state && mm.state.entries) || 0) : '文件不存在' });
    } catch (e) { details.push({ name: '服务端清单', has: false, ok: false, note: '读取异常' }); }

    // 修复 = 以「最新有效源」重写各镜像（V1 `storageVerify`：取 newest 后 storageWriteAll）
    let repaired = false, repairedFrom = '';
    const bad = details.filter(d => d.has && !d.ok);
    if (repair) {
        const localEnv = await readLocalEnvelope();
        const curEnv = (() => { try { return storageEnvelope(state); } catch (e) { return null; } })();
        const candidates = [
            { name: '本机缓冲', env: localEnv },
            { name: '记忆文件(主)', env: main },
            { name: '记忆文件(备份)', env: bakEnv },
            { name: '当前状态', env: curEnv },
        ].filter(x => x.env && envValid(x.env));
        let newest = null;
        for (const c of candidates) {
            const ts = Number((c.env.payload && c.env.payload.updatedAt) || 0);
            if (!newest || ts > newest.ts) newest = { name: c.name, env: c.env, ts };
        }
        if (newest) {
            try {
                const w = await storageWriteAll(newest.env, { bak: true });
                repaired = !!(w && w.ok > 0);
                repairedFrom = newest.name;
            } catch (e) { /* 忽略 */ }
        }
    }
    return { at: Date.now(), repair: !!repair, details, bad: bad.length, repaired, repairedFrom };
}

/** 读本机缓冲信封（校验用；不依赖 store 的载入路径） */
async function readLocalEnvelope() {
    try {
        const raw = lsGet('ftt2_state_' + scopeId());
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

// ---------- 状态汇总（UI 状态行 / 调试钩子） ----------
export function storageStatusInfo() {
    return {
        scope: scopeId(), scope8: scopeHash8(), slug: storageSlug(), archive: storageArchiveName(),
        file: stateFileStatus(), meta: metaFileLastInfo(),
        snapshot: { enabled: snapshotFileEnabled(), name: snapshotFileName(), count: ((state && state.snapStore) || []).length, sig: snapshotSig(), okAt: snapFileLastOkAt, pushedSig: snapFilePushedSig },
        log: { enabled: syncLogServerEnabled(), ...syncLogServerStatus(), localN: syncLogList().length },
        remote: { stateHash: remoteStateHashSeen(), snapSig: remoteSnapSigSeen() },
        mirror: Object.assign({}, lastMirror),
        gates: { traffic: syncTrafficGuardOn(), mirrorNeeded: mirrorPushNeeded(), floor: syncFloorDiffersFromArchive() },
        lastRefresh: lastRefresh ? Object.assign({}, lastRefresh) : null,
        lastManual: lastManual ? { mode: lastManual.mode, side: lastManual.side || '' } : null,
    };
}

// ---------- 生命周期（启动对账 / 组件卸载 / 测试隔离） ----------
/**
 * 启动对账（V1 `storageBootstrap` 的被动版）：
 *   读服务端最新（清单预判命中则零大文件下载）→ 合并 → 快照并集 → 日志交叉合并。
 */
export async function storageBootstrap() {
    const rep = { at: Date.now(), skipped: false, why: '', merged: false, snap: false, log: null };
    try {
        if (longTaskBusy()) { rep.skipped = true; rep.why = 'long-task'; return rep; }
        let metaSkip = false;
        try {
            const mm = await metaFileRead();
            if (metaStateSkipOk(mm)) { metaSkip = true; rep.why = 'meta-unchanged'; }
        } catch (e) { /* 忽略 */ }
        if (!metaSkip) {
            const rem = await crossFindRemoteEnv();
            if (rem) {
                const r = applyRemoteMergeToState(rem);
                rep.merged = !!(r && r.mode === 'merge');
                if (r) { try { saveState(); } catch (e) { /* 忽略 */ } }
            }
        }
        try { rep.snap = await snapshotFilePullMerge(); } catch (e) { /* 忽略 */ }
        try { rep.log = await syncLogServerMerge({}); } catch (e) { /* 忽略 */ }
        return rep;
    } catch (e) { rep.why = 'error'; return rep; }
}

/** 清空全部定时器与单飞标志（组件卸载 / 测试隔离） */
export function resetSyncState() {
    try { if (storageSyncTimer) clearTimeout(storageSyncTimer); } catch (e) { /* 忽略 */ }
    try { if (snapPushTimer) clearTimeout(snapPushTimer); } catch (e) { /* 忽略 */ }
    try { if (metaPushTimer) clearTimeout(metaPushTimer); } catch (e) { /* 忽略 */ }
    try { if (syncLogServerPushTimer) clearTimeout(syncLogServerPushTimer); } catch (e) { /* 忽略 */ }
    storageSyncTimer = snapPushTimer = metaPushTimer = syncLogServerPushTimer = null;
    storageSyncRunning = snapFileMerging = metaFilePushing = syncLogServerMerging = false;
    storageSyncSkipRetries = 0;
    metaFileMissingAt = 0;
    fileReadCache = {};
    return true;
}

/** 同步诊断（FTT.* 调试钩子用） */
export function syncInfo() {
    return {
        stateFile: stateFileName(), bak: bakFileName(), snap: snapshotFileName(), meta: metaFileName(), log: syncLogServerFile(),
        cacheNames: Object.keys(fileReadCache).length,
        lastMirror: Object.assign({}, lastMirror), remotePushSkipNotified,
        logLocalN: syncLogList().length,
        snapIndex: snapIndexFrom(((state && state.snapStore) || [])).length,
    };
}

/** 供 UI/调试展示的「最近一次同步报告」 */
export function lastSyncReports() {
    return { refresh: lastRefresh ? Object.assign({}, lastRefresh) : null, manual: lastManual ? { mode: lastManual.mode, side: lastManual.side || '', stat: lastManual.stat || null } : null, mirror: Object.assign({}, lastMirror), version: VERSION };
}

/** 记录最近报告（UI 调用方在动作完成后回填） */
export function noteSyncReport(kind, rep) {
    if (kind === 'refresh') lastRefresh = rep || null;
    else if (kind === 'manual') lastManual = rep || null;
    return true;
}

/** 通知（宿主 toast 钩子；UI 层动作的统一出口） */
export function syncToast(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
    return true;
}

/** 供测试/宿主清理「远端已合入指纹」（换角色或重置时） */
export function resetRemoteMarks() {
    lsDel(remoteStateHashKey()); lsDel(remoteSnapSigKey()); lsDel(syncGateStoreKey()); lsDel(mirrorPushSigKey());
    return true;
}

/** 宿主上下文可用性（调试：文件通道是否需要 CSRF/请求头） */
export function syncChannelInfo() {
    try {
        const ctx = getCtx();
        return { hasCtx: !!ctx, hasHeaders: !!(ctx && typeof ctx.getRequestHeaders === 'function'), prefix: 'ftt2-' };
    } catch (e) { return { hasCtx: false, hasHeaders: false, prefix: 'ftt2-' }; }
}

export { slugify, syncLogShortHash, snapIndexFrom };
