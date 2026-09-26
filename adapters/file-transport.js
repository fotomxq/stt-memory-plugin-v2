// ============================================================
// adapters/file-transport.js —— 文件通道**统一入口**（后端自动识别切换）
//
// 背景：V1 的「记忆文件 / -bak 备份 / 快照文件 / 清单文件 / 同步日志镜像」五类载荷共用一个文件通道，
//   v1.150 起该通道在**检测到 TauriTavern 宿主时自动改走宿主原生存储**（统一存储抽象的 `transport` 分类），
//   读取优先原生、未命中回退酒馆用户目录文件（旧数据迁移）。V2 此前只实现了酒馆用户目录文件
//   （`adapters/user-file.js`）—— 在 TauriTavern 上该通道并无对应服务端点，写入会失败。
// 本文件把这一层补上，并保持三条硬约束：
//   ① **无宿主时零行为变化**：未检测到 TauriTavern → 直接返回 `adapters/user-file.js` 的同一 Promise
//      （不多一层 await、不多一次请求、请求序列与字节与既有实现完全一致）；
//   ② **读优先原生、未命中回退文件**，并按 key 记住上次命中的后端（避免反复探测）；
//   ③ **写失败自动回退**（原生写不进去 → 酒馆文件通道），`cfg.storage.tauriMirror` 开启时额外镜像写一份，
//      删除时**两个后端都删**（避免「删了又被另一通道唤醒」）。
// 后端：
//   · `tt-native` —— TauriTavern `api.extension.store`（官方 Public Contract，见 `adapters/tt-store.js`）；
//   · `st-files`  —— 酒馆用户目录文件（`/api/files/upload` · `/user/files/<name>` · `/api/files/delete`）。
// ============================================================
import { cfg, dbgLog } from '../core/model/runtime.js';
import {
    uploadStateFile, uploadStateFileGz, readStateFileAuto, readStateFileBytes, deleteStateFile,
} from './user-file.js';
import {
    TT_LEGACY_NS, ttDetected, ttNativeActive, ttNativeOn, tauriNativeSetting, ttMirrorToFiles,
    ttPutBytes, ttGetBytes, ttDelete as ttDeleteNative, ttAnnounceSwitch, ttListKeys, ttListBlobKeys,
    ttDropCaches, ttTextBytes, ttBytesToTextAuto, ttKeyOf, ttChannelInfo,
} from './tt-store.js';
import { gzipToBytes, isGzipBytes } from './gzip.js';

/** 本会话内酒馆文件通道是否已被判定不可用（原生模式下探测失败即停止无谓重试） */
let stFilesOff = false;
let stFilesFailReason = '';
let lastWrite = { backend: '', mirror: false, bytes: 0, at: 0, error: '' };
const readRoute = Object.create(null);          // key → 上次命中的后端

/** 当前应当使用的后端（原生优先；`cfg.storage.tauriNative` = on/off 可强制） */
export function fileTransportBackend() {
    try {
        if (ttNativeActive()) return 'tt-native';
        return 'st-files';
    } catch (e) { return 'st-files'; }
}

/** 是否允许回退酒馆文件通道（关闭开关或本会话已判定不可用 → 否） */
export function stFilesAllowed() {
    try {
        if (stFilesOff) return false;
        return true;
    } catch (e) { return true; }
}

/** 酒馆文件通道探测失败 → 本会话不再重试（**只在原生可用时**才这么做：无宿主时文件通道是唯一通道，不能放弃） */
function markStFilesDown(reason) {
    try {
        if (!ttNativeActive()) return;
        if (stFilesOff) return;
        stFilesOff = true;
        stFilesFailReason = String(reason || '');
        try { dbgLog('对账', { action: '酒馆文件通道不可用 → 本会话停用回退（宿主原生存储已接管）', reason: stFilesFailReason }); } catch (e) { /* 静默 */ }
    } catch (e) { /* 静默 */ }
}

/** 测试/会话重置（重新允许探测文件通道） */
export function resetFileTransportSession() {
    stFilesOff = false;
    stFilesFailReason = '';
    for (const k of Object.keys(readRoute)) delete readRoute[k];
    ttDropCaches();
    return true;
}

/** 清缓存（「立即同步」「刷新状态」= 取真值） */
export function fileTransportDropCaches() {
    for (const k of Object.keys(readRoute)) delete readRoute[k];
    ttDropCaches();
    return true;
}

/**
 * 读取（按**内容魔数**识别 gzip / 明文）—— 与 `adapters/user-file.js#readStateFileAuto` 同返回形状。
 * @returns {Promise<{ok:boolean, text:string, gz:boolean, backend:string, status?:number, error?:string}>}
 */
export function fileTransportReadAuto(name) {
    // **零额外微任务层**：无宿主 / 关闭时直接返回既有实现的同一 Promise ——
    //   启动装配（loadMemoryState → loadFromServerFile）的微任务步数与旧实现完全一致
    //   （`adapters/user-file.js` 文件头对此有明确口径；B7-2 与冒烟 B1 都依赖装配时序）。
    if (!ttNativeOn()) {
        const p = readStateFileAuto(name);
        bookkeep(p, (r) => { if (r && r.ok) readRoute[String(name || '')] = 'st-files'; });
        return p;
    }
    return readAutoRouted(name);
}

/** 书签：不改变返回的 Promise，只在其落定后记账（失败静默） */
function bookkeep(p, fn) {
    try { Promise.resolve(p).then(fn, () => undefined); } catch (e) { /* 忽略 */ }
    return p;
}

async function readAutoRouted(name) {
    const key = String(name || '');
    const order = [];
    const route = readRoute[key];
    if (route) order.push(route);
    if (order.indexOf('tt-native') < 0) order.push('tt-native');
    if (order.indexOf('st-files') < 0 && stFilesAllowed() && tauriNativeSetting() !== 'off') order.push('st-files');
    let firstError = '';
    for (const id of order) {
        if (id === 'tt-native') {
            if (!ttNativeActive()) continue;
            const got = await ttGetBytes(name, { force: false });
            if (got && got.found) {
                const dec = await ttBytesToTextAuto(got.bytes);
                if (dec && dec.ok) {
                    readRoute[key] = 'tt-native';
                    ttAnnounceSwitch();
                    return { ok: true, text: dec.text, gz: !!dec.gz, backend: 'tt-native', channel: got.channel, bytes: got.bytes.length };
                }
                firstError = firstError || String(dec.error || 'decode');
                continue;
            }
            if (got && got.error) firstError = firstError || String(got.error);
            continue;
        }
        const r = await readStateFileAuto(name);
        if (r && r.ok) {
            readRoute[key] = 'st-files';
            return Object.assign({ backend: 'st-files' }, r);
        }
        const status = Number((r && r.status) || 0);
        if (status === 404) {
            // 文件不存在是正常未命中；但如果原生已接管，说明本宿主没有该文件通道 → 停止无谓探测
            if (r && r.error) firstError = firstError || String(r.error);
            if (ttDetected()) markStFilesDown('read-404');
            continue;
        }
        if (r && (r.error || status === 401 || status === 403)) {
            firstError = firstError || String(r.error || ('status ' + status));
            markStFilesDown(r.error ? 'read-error' : ('read-' + status));
        }
        continue;
    }
    return { ok: false, text: '', gz: false, backend: fileTransportBackend(), error: firstError || 'miss' };
}

/**
 * 读取原始字节（V1 导入器读取 `.json.gz` 用）。
 * @param {string} name 文件名
 * @param {object} [opts] `legacy:true` 时额外探测 V1 命名空间（`ftt-files`，V1 在 TauriTavern 上的落点）
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, backend:string, status?:number, error?:string}>}
 */
export function fileTransportReadBytes(name, opts) {
    const o = opts || {};
    if (!ttNativeOn()) return readStateFileBytes(name);            // 同上：无宿主零额外微任务层
    return readBytesRouted(name, o);
}

async function readBytesRouted(name, o) {
    const order = [];
    const route = readRoute[String(name || '')];
    if (route) order.push(route);
    if (order.indexOf('tt-native') < 0) order.push('tt-native');
    if (order.indexOf('st-files') < 0 && stFilesAllowed()) order.push('st-files');
    let firstError = '';
    for (const id of order) {
        if (id === 'tt-native') {
            if (!ttNativeActive()) continue;
            const got = await ttGetBytes(name);
            if (got && got.found) { readRoute[String(name || '')] = 'tt-native'; return { ok: true, bytes: got.bytes, backend: 'tt-native', channel: got.channel }; }
            if (o.legacy) {                                  // V1 命名空间（只读兼容；V2 前缀不同，正常情况下不会命中）
                const leg = await ttGetBytes(name, { ns: TT_LEGACY_NS, force: true });
                if (leg && leg.found) { readRoute[String(name || '')] = 'tt-native'; return { ok: true, bytes: leg.bytes, backend: 'tt-native', channel: leg.channel, ns: TT_LEGACY_NS }; }
            }
            if (got && got.error) firstError = firstError || String(got.error);
            continue;
        }
        const r = await readStateFileBytes(name);
        if (r && r.ok) { readRoute[String(name || '')] = 'st-files'; return Object.assign({ backend: 'st-files' }, r); }
        if (Number((r && r.status) || 0) === 404) { if (ttDetected()) markStFilesDown('bytes-404'); continue; }
        if (r && (r.error || Number(r.status) === 401 || Number(r.status) === 403)) markStFilesDown(r.error ? 'bytes-error' : ('bytes-' + r.status));
        firstError = firstError || String((r && r.error) || '');
    }
    return { ok: false, backend: fileTransportBackend(), error: firstError || 'miss' };
}

/**
 * 写入文本（原生优先；`tauriMirror` 开启时额外镜像写酒馆文件；原生失败自动回退）。
 * @returns {Promise<{ok:boolean, backend:string, mirror?:boolean, status?:number, error?:string}>}
 */
export function fileTransportUploadText(name, text) {
    const bytes = ttTextBytes(text);
    if (!ttNativeOn()) {
        const p = uploadStateFile(name, text);                     // 无宿主：同一 Promise，零额外微任务层
        bookkeep(p, (r) => {
            lastWrite = { backend: 'st-files', mirror: false, bytes: bytes.length, at: Date.now(), error: (r && r.ok) ? '' : String((r && r.error) || '') };
        });
        return p;
    }
    return uploadTextRouted(name, text, bytes);
}

async function uploadTextRouted(name, text, bytes) {
    const out = { backend: 'tt-native', mirror: false, bytes: bytes.length };
    if (ttNativeActive()) {
        const r = await ttPutBytes(name, bytes);
        if (r && r.ok) {
            ttAnnounceSwitch();
            out.ok = true;
            out.channel = r.channel;
            if (ttMirrorToFiles()) {
                const m = await uploadStateFile(name, text);            // 镜像失败不改变主结果（主存储已成功）
                out.mirror = !!(m && m.ok);
            }
            lastWrite = { backend: 'tt-native', mirror: !!out.mirror, bytes: bytes.length, at: Date.now(), error: '' };
            return out;
        }
        out.nativeError = String((r && (r.error || r.reason)) || 'error');
    } else {
        out.nativeError = 'not-ready';
    }
    if (!stFilesAllowed()) { out.ok = false; out.error = out.nativeError; lastWrite = { backend: 'tt-native', mirror: false, bytes: bytes.length, at: Date.now(), error: out.error }; return out; }
    const fb = await uploadStateFile(name, text);                       // ← 回退：绝不因为原生写失败而丢数据
    out.backend = 'st-files';
    out.ok = !!(fb && fb.ok);
    out.status = Number((fb && fb.status) || 0);
    out.error = out.ok ? '' : String((fb && fb.error) || out.nativeError || 'write-failed');
    if (!out.ok && ttDetected() && ttNativeActive()) markStFilesDown('write-fail');
    lastWrite = { backend: out.backend, mirror: false, bytes: bytes.length, at: Date.now(), error: out.error };
    return out;
}

/** 写入 gzip 文本（原生通道同样先 gzip，写不进则退回明文由调用方处理；返回形状同 V1 `uploadStateFileGz`） */
export function fileTransportUploadGz(name, text) {
    if (!ttNativeOn() || !ttNativeActive()) return uploadStateFileGz(name, text);   // 无宿主/未就绪：同一 Promise
    return uploadGzRouted(name, text);
}

async function uploadGzRouted(name, text) {
    const build = await (async () => {
        try {
            const bytes = await gzipToBytes(text);
            if (!bytes || !bytes.length || !isGzipBytes(bytes)) return null;
            return bytes;
        } catch (e) { return null; }
    })();
    if (!build) return { ok: false, gz: false, reason: 'no-gzip' };
    const r = await ttPutBytes(name, build);
    if (r && r.ok) {
        ttAnnounceSwitch();
        let mirror = false;
        if (ttMirrorToFiles()) { const m = await uploadStateFileGz(name, text); mirror = !!(m && m.ok); }
        lastWrite = { backend: 'tt-native', mirror: mirror, bytes: build.length, at: Date.now(), error: '' };
        return { ok: true, gz: true, backend: 'tt-native', channel: r.channel, mirror: mirror, bytes: build.length };
    }
    const fb = await uploadStateFileGz(name, text);
    return Object.assign({ backend: 'st-files' }, fb || { ok: false });
}

/**
 * 删除（**两个后端都删**，避免另一通道把已删数据唤醒）。
 * @returns {Promise<{ok:boolean, backend:string, native?:boolean, files?:boolean}>}
 */
export function fileTransportDelete(name) {
    if (!ttNativeOn()) {
        const p = deleteStateFile(name);                           // 无宿主：同一 Promise，零额外微任务层
        bookkeep(p, () => { delete readRoute[String(name || '')]; });
        return p;
    }
    return deleteRouted(name);
}

async function deleteRouted(name) {
    const n = ttNativeActive() ? await ttDeleteNative(name) : { ok: false };
    let f = { ok: false };
    if (stFilesAllowed()) f = await deleteStateFile(name);
    delete readRoute[String(name || '')];
    if (!n.ok && !f.ok && ttDetected() && ttNativeActive()) markStFilesDown('delete-fail');
    return { ok: !!(n.ok || f.ok), backend: 'tt-native', native: !!n.ok, files: !!f.ok };
}

/** 重置保存状态 / 诊断信息 */
export function fileTransportStatus() {
    const ch = ttChannelInfo();
    return {
        backend: fileTransportBackend(), channel: ch,
        stFilesAllowed: stFilesAllowed(), stFilesOff: stFilesOff, stFilesReason: stFilesFailReason,
        routes: Object.keys(readRoute).length, lastWrite: Object.assign({}, lastWrite),
    };
}

/** 一次读取本命名空间下的键清单（诊断/数据管理；绕开缓存） */
export async function fileTransportListKeys() {
    if (!ttNativeActive()) return { ok: false, kv: [], blob: [], legacy: [] };
    const kv = await ttListKeys();
    const blob = await ttListBlobKeys();
    const legacy = await ttListKeys(undefined, { ns: TT_LEGACY_NS });      // V1 命名空间（只读核对）
    return { ok: true, kv: kv, blob: blob, legacy: legacy };
}

/** 归一后的原生 key（诊断展示用） */
export function fileTransportKey(name) { try { return ttKeyOf(name); } catch (e) { return ''; } }

/** 读取配置：是否处于「宿主原生存储」模式（UI 条件展示用；不改任何语义） */
export function tauriModeEnabled() { try { return !!(cfg && cfg.storage && cfg.storage.tauriNative !== 'off'); } catch (e) { return true; } }
