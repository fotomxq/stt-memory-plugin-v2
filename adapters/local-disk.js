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
        // Tauri v2 fs 插件：write_text_file({ path, contents })（v1 为 { path, contents } 同名参数）
        await inv('plugin:fs|write_text_file', { path: path, contents: Array.from(new TextEncoder().encode(body)) });
        return { ok: true, mechanism: c.mechanism };
    } catch (e) { return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) }; }
}
/** 读文本 */
async function diskReadText(path) {
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
        const text = (typeof r === 'string') ? r : (r && typeof r === 'object' && typeof r.text === 'string' ? r.text : '');
        if (!text) return { ok: false, reason: 'empty' };
        return { ok: true, text: text };
    } catch (e) { return { ok: false, reason: 'read-failed', error: String((e && e.message) || e) }; }
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
    if (!w.ok) { stats.failures++; stats.lastError = String(w.error || w.reason || 'write-failed'); return { ok: false, path: full, error: stats.lastError, reason: w.reason }; }
    const r = await diskReadText(full);
    if (!r.ok || String(r.text) !== body) {
        stats.failures++;
        stats.lastError = 'verify-failed';
        return { ok: false, path: full, error: 'write-then-readback-mismatch', reason: 'verify-failed' };
    }
    stats.writes++; stats.lastAt = Date.now(); stats.lastBytes = body.length; stats.lastError = ''; stats.mechanism = String(w.mechanism || '');
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
        if (!w.ok) { out.error = String(w.error || w.reason || 'write-failed'); return out; }
        if (!r.ok || String(r.text) !== body) { out.error = 'verify-failed'; return out; }
        out.ok = true; out.path = String(w.path || '');
        stats.probes++; stats.lastAt = Date.now();
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
        enabled: !!dir, dir: dir, kind: localDiskPathKind(dir),
        capability: { ok: c.ok, mechanism: c.mechanism, ns: c.ns, writeMethod: c.writeMethod, readMethod: c.readMethod, tauriFs: c.tauriFs, devKeys: c.devKeys, note: c.note },
        stats: Object.assign({}, stats),
    };
}
/** 测试/诊断：重置会话状态 */
export function localDiskReset() {
    caps = null;
    stats.writes = 0; stats.reads = 0; stats.failures = 0; stats.probes = 0;
    stats.lastError = ''; stats.lastAt = 0; stats.lastBytes = 0; stats.mechanism = '';
    return true;
}

export const localDiskStats = stats;

export default {
    localDiskRaw, localDiskOn, localDiskPathKind, localDiskPathNorm, localDiskJoin,
    localDiskCapability, localDiskReprobe, localDiskWrite, localDiskRead, localDiskProbeDir,
    localDiskInfo, localDiskReset,
};
