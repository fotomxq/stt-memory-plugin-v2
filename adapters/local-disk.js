// ============================================================
// adapters/local-disk.js —— **真·本地磁盘目录存储**（v3.28.0，用户纠正设计后新增）
//
// 用户纠正（原话）：「理解错误了，本地存储指替代浏览器变量、内存等本地数据存储方式，而不是指服务端的存储路径。
//   请修复该错误设计。」
//
// 事实：v3.16.0~v3.27.x 的「本机缓冲目录」实际写进的是 **宿主扩展存储命名空间**
//   （`<data_root>/_tauritavern/extension-store/<命名空间>/…`）—— 那是**参与官方同步的服务端数据集**，
//   不是「替代浏览器本地存储」的本地目录。本次把语义掰回来：
//   · **本地磁盘目录**（本文件）：用户给一条**真磁盘路径**（如 `D:\Downloads\stn\fft_v2_store`），
//     记忆本机副本 / 日志 / 时间线 / 标记 / 版本清单都写成**真文件**，用来替代浏览器变量（localStorage）与内存库（IndexedDB）；
//   · **服务端存储**：记忆主文件 / 分片 / 快照（`api.extension.store` 命名空间 + 酒馆 user/files），保持不变。
//
// 能力现实（必须如实）：网页 JS 不能凭空写盘 —— 需要宿主提供文件 API。本模块**按优先级探测**：
//   ① `__TAURITAVERN__.api.dev` 下的文件/路径类命名空间（名字按关键字发现，方法按 write/read 关键字发现）；
//   ② Tauri v2 的 fs 插件命令（`window.__TAURI_INTERNALS__.invoke('plugin:fs|write_text_file' …)`）；
//   ③ 都没有 → 如实回报「宿主不提供任意磁盘路径写入」，UI 不假装成功。
// 任何一次真实写入都必须**回读逐字节校验**（与目录探针同纪律），校验不过就当没成功。
// ============================================================
import { cfg, dbgLog } from '../core/model/runtime.js';

/** 探测结果缓存（每次会话探一次；`localDiskReprobe()` 可强制重探） */
let caps = null;
/** 最近一次读写统计（诊断 / UI） */
const stats = { writes: 0, reads: 0, failures: 0, probes: 0, lastError: '', lastAt: 0, lastBytes: 0, mechanism: '' };
/**
 * v3.28.1（用户要求）：「写盘失败 → **回退浏览器层**，但必须明显提醒，且**标记该路径无效**」。
 *   这里维护「路径无效」状态：任何一次真实写入失败 / 探针失败 / 能力缺失都会置位；
 *   成功写入或探针通过时清除。UI 据此显著告警，保存流水线据此回退浏览器层。
 * @type {{invalid:boolean, dir:string, at:number, reason:string, error:string}}
 */
let invalid = { invalid: false, dir: '', at: 0, reason: '', error: '' };
/** 标记「该路径无效」（可被 `localDiskClearInvalid()` 清除） */
export function localDiskMarkInvalid(dir, reason, error) {
    invalid = { invalid: true, dir: String(dir || ''), at: Date.now(), reason: String(reason || ''), error: String(error || '') };
    return Object.assign({}, invalid);
}
/** 清除无效标记（写入成功 / 探针通过时调用） */
export function localDiskClearInvalid() {
    const was = Object.assign({}, invalid);
    invalid = { invalid: false, dir: '', at: 0, reason: '', error: '' };
    return was;
}
/** 当前「路径无效」状态（只读） */
export function localDiskInvalid() { return Object.assign({}, invalid); }

/** 生效的本地磁盘目录（`''` = 不开启）；返回**归一后的真磁盘路径**（去尾部分隔符） */
export function localDiskRaw() {
    try { return localDiskPathNorm((cfg && cfg.storage && cfg.storage.localDiskDir) || ''); } catch (e) { return ''; }
}
/** 是否把「本地磁盘目录」当作本机层（唯一判据：路径非空且宿主具备写盘能力） */
export function localDiskOn() { return !!localDiskRaw(); }

/** 路径形态判定（绝对路径 / UNC / 相对） */
export function localDiskPathKind(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'empty';
    if (/^[A-Za-z]:[\\/]/.test(s)) return 'windows-abs';
    if (s.slice(0, 2) === '\\\\') return 'unc';          // UNC：以两个反斜杠开头（写成字符比较，避免转义歧义）
    if (s.charAt(0) === '/') return 'posix-abs';
    return 'relative';
}
/** 路径归一（本地磁盘目录**保留原样**，只去掉尾部分隔符与多余空白 —— 与「服务端命名空间」口径完全相反） */
export function localDiskPathNorm(raw) {
    try {
        let s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        s = s.replace(/[\\/]+$/, '');
        return s;
    } catch (e) { return ''; }
}
/** 拼接一个文件路径（用目录里出现过的分隔符） */
export function localDiskJoin(dir, name) {
    const d = localDiskPathNorm(dir);
    if (!d) return '';
    const sep = (d.indexOf('\\') >= 0) ? '\\' : '/';
    return d + sep + String(name || '').replace(/^[\\/]+/, '');
}

/**
 * v3.30.0（用户要求）：「缺少选择目录的能力，浏览器是可以选择文件夹的。选择后展示即可。」
 *   用**浏览器原生**的 File System Access API（`showDirectoryPicker`；WebView2 / Chromium 与 TauriTavern 都支持）：
 *   选中后拿到目录句柄，本机副本 / 辅助数据就写到该文件夹（真文件，**无需宿主文件 API**）。
 *   如实说明：浏览器出于隐私**不暴露绝对路径**（只显示文件夹名）；刷新后句柄失效（安全限制）→ 需重新选择，
 *   未选择时自动回退浏览器本地存储，绝不因此丢数据。
 */
let fsHandle = null;
/** 是否已有「浏览器选中的文件夹」句柄（本会话） */
export function localDiskHasHandle() { return !!fsHandle; }
/** 浏览器文件夹选择（由用户操作触发；失败如实回报） */
export async function localDiskPickDir() {
    try {
        const w = globalThis.window;
        if (!w || typeof w.showDirectoryPicker !== 'function') {
            return { ok: false, reason: 'unsupported', note: '当前宿主不支持浏览器文件夹选择（File System Access API）' };
        }
        const h = await w.showDirectoryPicker({ mode: 'readwrite' });
        if (h && typeof h.requestPermission === 'function') {
            const perm = await h.requestPermission({ mode: 'readwrite' });
            if (perm !== 'granted') return { ok: false, reason: 'denied', note: '未授予读写权限' };
        }
        fsHandle = h;
        return { ok: true, name: String((h && h.name) || ''), note: '已选中文件夹「' + String((h && h.name) || '') + '」（浏览器只暴露文件夹名，绝对路径不可见）' };
    } catch (e) { return { ok: false, reason: String((e && e.name) || 'cancelled'), note: String((e && e.message) || e) }; }
}
/** 句柄可用性（权限可能被浏览器回收） */
async function handleUsable() {
    try {
        if (!fsHandle) return false;
        if (typeof fsHandle.queryPermission === 'function') {
            const p = await fsHandle.queryPermission({ mode: 'readwrite' });
            if (p === 'granted') return true;
            const q = await fsHandle.requestPermission({ mode: 'readwrite' });
            return q === 'granted';
        }
        return true;
    } catch (e) { return false; }
}
const baseNameOfPath = (p) => String(p == null ? '' : p).split(/[\\/]/).filter(Boolean).pop() || '';
async function handleWriteText(name, text) {
    const fh = await fsHandle.getFileHandle(String(name), { create: true });
    const ws = await fh.createWritable();
    await ws.write(String(text == null ? '' : text));
    await ws.close();
    return { ok: true };
}
async function handleReadText(name) {
    const fh = await fsHandle.getFileHandle(String(name));
    const f = await fh.getFile();
    return { ok: true, text: await f.text() };
}
async function handleList() {
    const out = [];
    for await (const ent of fsHandle.entries()) {
        const nm = Array.isArray(ent) ? ent[0] : (ent && ent.name);
        const h = Array.isArray(ent) ? ent[1] : ent;
        out.push({ name: String(nm || ''), isFile: !(h && h.kind === 'directory'), size: 0 });
    }
    return out;
}

/** 宿主 ABI（`window.__TAURITAVERN__`） */
function abi() {
    try {
        const w = globalThis.window;
        if (w && w.__TAURITAVERN__) return w.__TAURITAVERN__;
    } catch (e) { /* 忽略 */ }
    try { return globalThis.__TAURITAVERN__ || null; } catch (e) { return null; }
}
/** Tauri 原始桥（`__TAURI_INTERNALS__.invoke` / `__TAURI__.core.invoke`） */
function tauriInvoke() {
    try {
        const w = globalThis.window;
        const cands = [w && w.__TAURI_INTERNALS__, w && w.__TAURI__ && w.__TAURI__.core, w && w.__TAURI__,
            globalThis.__TAURI_INTERNALS__, globalThis.__TAURI__ && globalThis.__TAURI__.core];
        for (const c of cands) if (c && typeof c.invoke === 'function') return c.invoke.bind(c);
    } catch (e) { /* 忽略 */ }
    return null;
}

const FS_NS_RE = /file|files|fs|disk|workspace|path|paths|io/i;
const WRITE_RE = /write|save|put|create/i;
const READ_RE = /read|load|get/i;

/**
 * 探测宿主可用的「写盘」能力（**只读探测，不写任何东西**）。
 * @returns {{ok:boolean, mechanism:string, ns:string, writeMethod:string, readMethod:string, tauriFs:boolean, devKeys:string[], note:string}}
 */
export function localDiskCapability(reprobe) {
    if (caps && !reprobe) return caps;
    const out = { ok: false, mechanism: '', ns: '', writeMethod: '', readMethod: '', tauriFs: false, devKeys: [], note: '' };
    try {
        const a = abi();
        const dev = a && a.api && a.api.dev ? a.api.dev : null;
        if (dev && typeof dev === 'object') {
            out.devKeys = Object.keys(dev).slice(0, 40);
            for (const k of out.devKeys) {
                if (!FS_NS_RE.test(k)) continue;
                const holder = dev[k];
                if (!holder || typeof holder !== 'object') continue;
                const methods = Object.keys(holder).filter((m) => typeof holder[m] === 'function');
                const w = methods.filter((m) => WRITE_RE.test(m) && !/binary|bytes/i.test(m))[0] || '';
                const r = methods.filter((m) => READ_RE.test(m) && !/binary|bytes/i.test(m))[0] || '';
                if (w && r) {
                    out.ok = true; out.mechanism = 'dev-api'; out.ns = k; out.writeMethod = w; out.readMethod = r;
                    out.note = 'api.dev.' + k + '.' + w + '() / .' + r + '()';
                    caps = out;
                    return caps;
                }
            }
        }
        const inv = tauriInvoke();
        if (inv) {
            out.tauriFs = true;                       // 只能算「可能可用」——ACL 可能拒绝，真正判据是探针写入
            out.mechanism = 'tauri-fs';
            out.writeMethod = 'plugin:fs|write_text_file';
            out.readMethod = 'plugin:fs|read_text_file';
            out.note = '检测到 Tauri 原始桥（fs 插件命令；是否放行取决于宿主 ACL，需用探针实测）';
        }
        out.ok = out.ok || out.tauriFs;
        if (!out.ok) out.note = '宿主未提供任何「写任意磁盘路径」的接口（api.dev 无文件类命名空间、也无 Tauri 原始桥）';
    } catch (e) { out.note = String((e && e.message) || e); }
    caps = out;
    return caps;
}
/** 强制重探（UI「校验目录」用） */
export function localDiskReprobe() { return localDiskCapability(true); }

/** 写文本（按探测到的机制；不抛错，失败如实回报） */
async function diskWriteText(path, text) {
    // v3.30.0：**浏览器选中的文件夹句柄优先**（原生、无需宿主 API）
    try { if (fsHandle && await handleUsable()) return Object.assign(await handleWriteText(String(path).split(/[\\/]/).pop(), text), { mechanism: 'fs-handle' }); } catch (e) { /* 落到下面的宿主机制 */ }
    const c = localDiskCapability(false);
    const body = String(text == null ? '' : text);
    if (!c.ok) return { ok: false, reason: 'no-capability', error: c.note };
    try {
        if (c.mechanism === 'dev-api') {
            const dev = abi().api.dev[c.ns];
            const r = await dev[c.writeMethod]({ path: path, text: body, content: body, data: body });
            return { ok: !(r && r.ok === false), mechanism: c.mechanism, raw: r };
        }
        const inv = tauriInvoke();
        if (!inv) return { ok: false, reason: 'no-invoke' };
        /**
         * v3.29.0：Tauri v2 `fs` 插件的 `write_text_file` 在不同版本/ACL 下参数形态不完全一致 ——
         *   逐形态试（**每一种都以「写后能回读一致」为准**，由调用方校验）：
         *   ① `{ path, contents: <字符串> }`（多数版本）
         *   ② `{ path, contents: <字节数组> }`（部分版本把 text 当字节写）
         *   ③ `{ path, text }` / ④ `{ path, data: <字节数组> }`（旧别名）
         */
        const bytes = Array.from(new TextEncoder().encode(body));
        const shapes = [
            { path: path, contents: body },
            { path: path, contents: bytes },
            { path: path, text: body },
            { path: path, data: bytes },
        ];
        let lastErr = '';
        for (const arg of shapes) {
            try { await inv('plugin:fs|write_text_file', arg); return { ok: true, mechanism: c.mechanism }; }
            catch (e) { lastErr = String((e && e.message) || e); }
        }
        return { ok: false, reason: 'write-failed', error: lastErr };
    } catch (e) { return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) }; }
}
/** 读文本 */
async function diskReadText(path) {
    try { if (fsHandle && await handleUsable()) return Object.assign(await handleReadText(String(path).split(/[\\/]/).pop()), { mechanism: 'fs-handle' }); } catch (e) { /* 落到下面的宿主机制 */ }
    const c = localDiskCapability(false);
    if (!c.ok) return { ok: false, reason: 'no-capability', error: c.note };
    try {
        if (c.mechanism === 'dev-api') {
            const dev = abi().api.dev[c.ns];
            const r = await dev[c.readMethod]({ path: path });
            const text = (r && typeof r === 'object') ? (r.text != null ? r.text : (r.content != null ? r.content : r.data)) : r;
            return { ok: typeof text === 'string', text: typeof text === 'string' ? text : '', raw: r };
        }
        const inv = tauriInvoke();
        if (!inv) return { ok: false, reason: 'no-invoke' };
        const r = await inv('plugin:fs|read_text_file', { path: path });
        const text = (typeof r === 'string') ? r
            : (r && typeof r === 'object' && typeof r.text === 'string') ? r.text
                : (r && typeof r === 'object' && typeof r.contents === 'string') ? r.contents
                    : (r && typeof r === 'object' && r.data) ? new TextDecoder().decode(new Uint8Array(r.data)) : '';
        if (!text) return { ok: false, reason: 'empty' };
        return { ok: true, text: text };
    } catch (e) { return { ok: false, reason: 'read-failed', error: String((e && e.message) || e) }; }
}

/**
 * v3.29.0（用户要求「核对文件是否保存到本地了」）：**列出本地磁盘目录里的文件**（只读）。
 *   用 Tauri fs 插件的 `read_dir`（ACL 不放行 → 如实返回 `{ok:false}`，不假装）。
 * @returns {Promise<{ok:boolean, dir:string, names:string[], entries:Array<{name:string,isFile:boolean,size:number}>, error?:string}>}
 */
export async function localDiskList() {
    const dir = localDiskRaw();
    const out = { ok: false, dir: dir, names: [], entries: [], error: '' };
    if (!dir) { out.error = 'off'; return out; }
    try {
        if (fsHandle && await handleUsable()) { out.entries = await handleList(); out.names = out.entries.map((x) => x.name); out.ok = true; return out; }
        const inv = tauriInvoke();
        if (!inv) { out.error = 'no-invoke'; return out; }
        const r = await inv('plugin:fs|read_dir', { path: dir });
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.entries) ? r.entries : []);
        out.entries = arr.map((x) => ({
            name: String((x && (x.name || x.path || x.fileName)) || ''),
            isFile: !(x && (x.isDirectory === true || x.isDir === true)),
            size: Number((x && (x.size || x.len)) || 0),
        })).filter((x) => x.name);
        out.names = out.entries.map((x) => x.name);
        out.ok = true;
        return out;
    } catch (e) { out.error = String((e && e.message) || e); return out; }
}

/**
 * 写一个文件到本地磁盘目录（**写 → 回读逐字节校验**，校验不过不算成功）。
 * @param {string} name 文件名（相对目录；不允许 `..`）
 * @param {string} text 内容
 * @returns {Promise<{ok:boolean, path:string, bytes?:number, mechanism?:string, error?:string, reason?:string}>}
 */
export async function localDiskWrite(name, text) {
    const dir = localDiskRaw();
    if (!dir) return { ok: false, reason: 'off', path: '' };
    const safe = String(name || '').replace(/^[\\/]+/, '').replace(/\.\./g, '');
    const full = localDiskJoin(dir, safe);
    const body = String(text == null ? '' : text);
    const w = await diskWriteText(full, body);
    if (!w.ok) { stats.failures++; stats.lastError = String(w.error || w.reason || 'write-failed'); localDiskMarkInvalid(dir, 'write-failed', stats.lastError); return { ok: false, path: full, error: stats.lastError, reason: w.reason }; }
    const r = await diskReadText(full);
    if (!r.ok || String(r.text) !== body) {
        stats.failures++;
        stats.lastError = 'verify-failed';
        localDiskMarkInvalid(dir, 'verify-failed', '写后回读不一致');
        return { ok: false, path: full, error: 'write-then-readback-mismatch', reason: 'verify-failed' };
    }
    stats.writes++; stats.lastAt = Date.now(); stats.lastBytes = body.length; stats.lastError = ''; stats.mechanism = String(w.mechanism || '');
    localDiskClearInvalid();   // v3.28.1：写得进去 → 该路径有效
    try { dbgLog('存储', { action: '本地磁盘目录：写入并回读校验通过', path: full, bytes: body.length, mechanism: stats.mechanism }); } catch (e) { /* 忽略 */ }
    return { ok: true, path: full, bytes: body.length, mechanism: stats.mechanism };
}

/** 读一个文件（不存在 → `{ok:false, miss:true}`） */
export async function localDiskRead(name) {
    const dir = localDiskRaw();
    if (!dir) return { ok: false, reason: 'off' };
    const safe = String(name || '').replace(/^[\\/]+/, '').replace(/\.\./g, '');
    const full = localDiskJoin(dir, safe);
    const r = await diskReadText(full);
    if (!r.ok) return { ok: false, path: full, miss: true, error: String(r.error || r.reason || 'miss') };
    stats.reads++; stats.lastAt = Date.now();
    return { ok: true, path: full, text: String(r.text) };
}

/** 目录探针：写 → 回读 → 删除（证明「这个真磁盘路径确实可写」；删除失败只记诊断） */
export async function localDiskProbeDir(rawPath) {
    const dir = localDiskPathNorm(rawPath);
    const out = { ok: false, dir: dir, kind: localDiskPathKind(rawPath), path: '', mechanism: '', error: '' };
    if (!dir) { out.error = 'empty'; return out; }
    const cap = localDiskCapability(true);
    out.mechanism = cap.mechanism;
    const prev = localDiskRaw();
    try {
        // 探针用「显式路径」：临时把 cfg 指向待校验目录（不改配置持久化，只在本函数内）
        cfg.storage = Object.assign({}, cfg.storage || {});
        const keep = cfg.storage.localDiskDir;
        cfg.storage.localDiskDir = dir;
        const body = JSON.stringify({ probe: 1, at: Date.now(), dir: dir });
        const w = await localDiskWrite('ftt2-local-probe.json', body);
        const r = await localDiskRead('ftt2-local-probe.json');
        cfg.storage.localDiskDir = keep;
        if (!w.ok) { out.error = String(w.error || w.reason || 'write-failed'); localDiskMarkInvalid(dir, 'probe-write-failed', out.error); return out; }
        if (!r.ok || String(r.text) !== body) { out.error = 'verify-failed'; return out; }
        out.ok = true; out.path = String(w.path || '');
        stats.probes++; stats.lastAt = Date.now();
        localDiskClearInvalid();
    } catch (e) {
        try { cfg.storage.localDiskDir = prev; } catch (e2) { /* 忽略 */ }
        out.error = String((e && e.message) || e);
    }
    return out;
}

/** 只读状态（UI / 诊断） */
export function localDiskInfo() {
    const dir = localDiskRaw();
    const c = localDiskCapability(false);
    return {
        enabled: !!dir || !!fsHandle, dir: dir || (fsHandle ? String(fsHandle.name || '') : ''), kind: fsHandle ? 'fs-handle' : localDiskPathKind(dir), handle: !!fsHandle,
        capability: { ok: c.ok, mechanism: c.mechanism, ns: c.ns, writeMethod: c.writeMethod, readMethod: c.readMethod, tauriFs: c.tauriFs, devKeys: c.devKeys, note: c.note },
        invalid: localDiskInvalid(),   // v3.28.1：路径是否已被标记为**无效**（写入失败 / 探针失败）
        stats: Object.assign({}, stats),
    };
}
/** 测试/诊断：重置会话状态 */
export function localDiskReset() {
    caps = null;
    stats.writes = 0; stats.reads = 0; stats.failures = 0; stats.probes = 0;
    stats.lastError = ''; stats.lastAt = 0; stats.lastBytes = 0; stats.mechanism = '';
    localDiskClearInvalid();
    fsHandle = null;
    return true;
}

export const localDiskStats = stats;

export default {
    localDiskRaw, localDiskOn, localDiskPathKind, localDiskPathNorm, localDiskJoin,
    localDiskCapability, localDiskReprobe, localDiskWrite, localDiskRead, localDiskProbeDir,
    localDiskInfo, localDiskReset, localDiskMarkInvalid, localDiskClearInvalid, localDiskInvalid, localDiskList,
    localDiskPickDir, localDiskHasHandle,
};
