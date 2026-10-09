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
//   ② TauriTavern 的 Tauri v2 插件（`plugin:fs|*` / `plugin:path|*` / `plugin:dialog|*`）；
//   ③ 都没有 → 如实回报「宿主不提供任意磁盘路径写入」，UI 不假装成功。
// 任何一次真实写入都必须**回读逐字节校验**（与目录探针同纪律），校验不过就当没成功。
//
// v3.34.0（用户报告「兼容 android 端的 TauriTavern，当前存在问题可能是方法用错了，会弹出报错」）：
//   **调用形态曾是错的** —— 从 TauriTavern 客户端构建实测（2026-10）：
//     · 写：`plugin:fs|write_text_file` 收的是**原始字节 body**，路径与选项走 **HTTP headers**：
//       `invoke(cmd, new TextEncoder().encode(text), { headers: { path: encodeURIComponent(路径), options: '{}' } })`
//       （旧实现传 `{ path, contents }` JSON → 宿主报错弹窗，且每次写要盲试 18 种组合，报错被放大 18 倍）；
//     · 读：`plugin:fs|read_text_file` 收 `{ path, options }`，**返回字节**（ArrayBuffer / Uint8Array / number[]）；
//     · 其余：`exists` / `mkdir` / `remove` / `read_dir` 同样收 `{ path, options }`；
//     · 目录：`plugin:path|resolve_directory` 收 `{ directory: <BaseDirectory 数值枚举> }`
//       （Audio=1 … Data=4, LocalData=5, Document=6, Download=7, Temp=12, AppConfig=13, AppData=14, **AppLocalData=15**, AppCache=16, AppLog=17, Desktop=18, Home=21）；
//     · 对话框：`plugin:dialog|open` 收 `{ options: { directory: true, multiple: false } }`。
//   另一条硬事实：宿主的 fs 放行范围是**应用数据目录**（`$APPDATA` / `$APPLOCALDATA` / `$LOCALDATA` / `$APPCACHE` / `$RESOURCE`），
//   **任意绝对路径（`D:\…`、`/storage/emulated/0/…`）不在放行范围内** → 拒绝。因此「只填一个目录名」会被
//   解析到**应用数据目录**下（`$APPLOCALDATA/<名字>`），并把**解析后的完整路径**回填显示 —— 桌面与 Android 同一套口径。
// ============================================================
import { cfg, dbgLog, dbgLogCoalesced } from '../core/model/runtime.js';
// v3.38.0（用户报告「PC 端不可用」）：**浏览器内置目录**（OPFS）—— 纯浏览器也能构造真文件（无需宿主接口）
import { browserFsAvailable, browserFsNote, browserFsReset, browserFsWrite, browserFsRead, browserFsExists, browserFsRemove, browserFsList, browserFsProbe } from './browser-fs.js';

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
/**
 * 是否把「本地磁盘目录」当作本机层。
 *   v3.33.0：有路径 **或** 本会话选过文件夹句柄即算开启（句柄场景路径框可以为空）。
 *   v3.35.0：句柄标记路径在**句柄已失效**（刷新后）时算**未开启** —— 与真实能力一致：
 *     绝不假装还能写那个文件夹（否则每次保存都会失败并弹告警），而是干净地回退浏览器本地存储，
 *     由界面提示「重新选择文件夹 / 改填绝对路径」。
 */
export function localDiskOn() {
    const raw = localDiskRaw();
    // v3.38.0：浏览器内置目录 —— 当前浏览器不支持 OPFS 时如实算「未开启」（与句柄失效同纪律，绝不假装能写）
    if (localDiskIsBrowserPath(raw)) return browserFsAvailable();
    if (fsHandle) return true;
    return !!(raw && !localDiskIsHandlePath(raw));
}

/** 路径形态判定（绝对路径 / UNC / 相对） */
export function localDiskPathKind(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'empty';
    if (localDiskIsHandlePath(s)) return 'handle';     // v3.35.0：浏览器选中的文件夹（绝对路径不可见）
    if (localDiskIsBrowserPath(s)) return 'browser';   // v3.38.0：浏览器内置目录（OPFS，刷新后仍在）
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
/**
 * v3.35.0（用户报告「设定-本地存储路径：如果选择文件夹，本地存储路径**不会显示完整路径**，而是**需人工填写路径**」）：
 *   **句柄路径标记** —— 浏览器原生文件夹选择器（File System Access）出于隐私**不暴露绝对路径**，
 *   于是「选了文件夹」之后路径框只能是空的（用户被迫手工填写，尽管文件其实已经写进那个文件夹了）。
 *   现在选中后把 `<标记前缀><文件夹名>` 写进路径框：① 框里立刻有可见、可复制的值（不再需要手工填）；
 *   ② 本模块认得它 = 「用本会话的文件夹句柄写」；③ 刷新后句柄失效 → 如实提示重选（绝不假装仍可用）。
 */
export const HANDLE_PREFIX = '@handle/';
/** 是否为「浏览器选中的文件夹」标记路径 */
export function localDiskIsHandlePath(raw) {
    try { return String(raw == null ? '' : raw).trim().indexOf(HANDLE_PREFIX) === 0; } catch (e) { return false; }
}
/** 从标记路径里取文件夹名（非标记 → 空串） */
export function localDiskHandleName(raw) {
    try {
        const s = String(raw == null ? '' : raw).trim();
        return localDiskIsHandlePath(s) ? s.slice(HANDLE_PREFIX.length).replace(/[\\/]+$/, '') : '';
    } catch (e) { return ''; }
}
/** 由文件夹名生成标记路径（`''` 名 → 空串） */
export function localDiskHandleMarker(name) {
    const n = String(name == null ? '' : name).trim().replace(/[\\/]+$/, '');
    return n ? (HANDLE_PREFIX + n) : '';
}

/**
 * v3.38.0：**浏览器内置目录标记** `@browser/<目录名>`。
 *   为什么需要它：`@handle/<名>`（浏览器选中的文件夹）**只在本会话有效**，刷新即失效；
 *   而纯浏览器（PC 酒馆网页版 / Firefox）又没有宿主 fs —— 于是「本地存储路径」在 PC 上根本不可用。
 *   `@browser/<名>` 指向**浏览器自带**的 OPFS 目录：不需要宿主接口、刷新后仍在，且**设备中立**
 *   （同一个配置在手机与 PC 上都成立，各自写各自的浏览器目录）。
 */
export const BROWSER_PREFIX = '@browser/';
/** 是否为「浏览器内置目录」标记路径 */
export function localDiskIsBrowserPath(raw) {
    try { return String(raw == null ? '' : raw).trim().indexOf(BROWSER_PREFIX) === 0; } catch (e) { return false; }
}
/** 从标记路径里取目录名（非标记 → 空串） */
export function localDiskBrowserName(raw) {
    try {
        const s = String(raw == null ? '' : raw).trim();
        if (!localDiskIsBrowserPath(s)) return '';
        return s.slice(BROWSER_PREFIX.length).split(/[\\/]+/).filter(Boolean)[0] || '';
    } catch (e) { return ''; }
}
/** 由目录名生成标记路径（`''` 名 → 空串） */
export function localDiskBrowserMarker(name) {
    const n = String(name == null ? '' : name).trim().split(/[\\/]+/).filter(Boolean)[0] || '';
    return n ? (BROWSER_PREFIX + n) : '';
}
/** 标记路径 → 浏览器内置目录根下的相对路径（`@browser/a/b.json` → `a/b.json`） */
function browserRel(path) {
    try {
        const s = String(path == null ? '' : path).trim();
        const rest = localDiskIsBrowserPath(s) ? s.slice(BROWSER_PREFIX.length) : s;
        return rest.split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..').join('/');
    } catch (e) { return ''; }
}

/**
 * v3.33.0（用户报告「修复本地存储路径设置，无法设置 android」）：**平台识别**。
 *   为什么要它：路径形态**因平台而异** —— 桌面是 `D:\…`，Android 是 `/storage/emulated/0/…`；
 *   而配置随服务端同步会把桌面路径搬到 Android（或反之），在那台设备上必然写不进去。
 *   `navigator.userAgent` 先给个结论，宿主（Tauri `os` 插件）能回答时以它为准。
 * @param {boolean} [reprobe] 忽略缓存
 * @returns {{name:'android'|'ios'|'desktop'|'unknown', source:string, ua:string}}
 */
let platCache = null;
export function localDiskPlatform(reprobe) {
    if (platCache && !reprobe) return platCache;
    const out = { name: 'unknown', source: '', ua: '' };
    try {
        const ua = String((globalThis.navigator && globalThis.navigator.userAgent) || '');
        out.ua = ua.slice(0, 160);
        if (/android/i.test(ua)) { out.name = 'android'; out.source = 'userAgent'; }
        else if (/iphone|ipad|ipod/i.test(ua)) { out.name = 'ios'; out.source = 'userAgent'; }
        else if (/windows|macintosh|mac os x|linux|cros/i.test(ua)) { out.name = 'desktop'; out.source = 'userAgent'; }
    } catch (e) { /* 忽略 */ }
    platCache = out;
    return out;
}
/** 问宿主平台（Tauri `os` 插件；失败 → 退回 UA 结论）；结果缓存 */
export async function localDiskPlatformAsync() {
    const inv = tauriInvoke();
    if (inv) {
        for (const cmd of ['plugin:os|platform', 'os|platform']) {
            try {
                const r = await inv(cmd, {});
                const s = String((typeof r === 'string') ? r : ((r && (r.platform || r.os)) || '')).toLowerCase();
                if (s) {
                    const name = /android/.test(s) ? 'android' : (/ios|iphone|ipad/.test(s) ? 'ios' : 'desktop');
                    platCache = { name: name, source: 'tauri-os:' + s, ua: (platCache && platCache.ua) || '' };
                    return platCache;
                }
            } catch (e) { /* 试下一形态 */ }
        }
    }
    return localDiskPlatform(false);
}
/** 平台的中文名（提示文案用） */
export function localDiskPlatformLabel(name) {
    const n = String(name || localDiskPlatform().name);
    return n === 'android' ? 'Android' : (n === 'ios' ? 'iOS' : (n === 'desktop' ? '桌面系统' : '未知平台'));
}
/**
 * v3.33.0/v3.34.0：路径形态与本机平台的**冲突提示**（'' = 没问题）。
 *   用户遇到的「Android 上根本设不了」根因：路径框里留着**从别的设备同步过来的** `D:\…`，
 *   在本机必然不可写（而且宿主的 fs 只放行**应用数据目录**）→ 校验失败 → 看起来「设置了也没用」。
 *   现在把话说在前面：跨平台路径直接点明；**只写目录名**（如 `fft_v2_store`）是最省事也最稳的用法。
 */
export function localDiskPathWarn(raw, platform) {
    const dir = localDiskPathNorm(raw);
    if (!dir) return '';
    const kind = localDiskPathKind(dir);
    if (kind === 'handle') return '';    // v3.35.0：浏览器选中的文件夹没有跨平台路径问题
    if (kind === 'browser') return '';   // v3.38.0：浏览器内置目录是设备中立的标记，跨平台照用
    const plat = String(platform || localDiskPlatform().name);
    const relativeTip = '改成**只填一个目录名**（如 fft_v2_store）即可自动落在宿主应用数据目录内';
    if (plat === 'android' || plat === 'ios') {
        if (kind === 'windows-abs') return '这看起来是 Windows 路径，本机是 ' + localDiskPlatformLabel(plat) + '：本机写不了它 —— ' + relativeTip;
    } else if (plat === 'desktop') {
        if (kind === 'posix-abs' && dir.charAt(1) !== '/') return '这看起来是 Android / Linux 路径，本机是桌面系统：本机写不了它 —— ' + relativeTip;
    }
    if (kind === 'windows-abs' || (kind === 'posix-abs' && dir.charAt(1) !== '/')) {
        return '';   // 同平台的绝对路径**不在这里告警**（是否放行由探针实测决定；能力明细里已写明宿主只放行应用数据目录）
    }
    return '';
}

/** 系统对话框选目录（Tauri `dialog` 插件：`{ options: { directory: true, multiple: false } }`；返回真路径） */
async function dialogPickDir() {
    const inv = tauriInvoke();
    if (!inv) return { error: 'no-bridge' };   // 没有 Tauri 原始桥 → 连对话框都谈不上（如实回报）
    try {
        const r = await inv('plugin:dialog|open', { options: { directory: true, multiple: false, title: '选择本地存储目录' } });
        const p = (typeof r === 'string') ? r : ((r && (r.path || r.filePath || r.uri)) || '');
        if (p) return { path: String(p) };
        return { error: 'cancelled' };      // 命令可用但用户取消
    } catch (e) { return { error: String((e && e.message) || e) }; }
}

/** 句柄写探针（写 → 回读 → 删除自己的探针文件；只动自己的文件） */
async function handleProbe() {
    const name = 'ftt2-local-probe.json';
    const body = JSON.stringify({ probe: 1, at: Date.now() });
    try {
        const w = await handleWriteText(name, body);
        if (!w || w.ok !== true) return { ok: false, error: 'write-failed' };
        const r = await handleReadText(name).catch(() => ({ ok: false, text: '' }));
        if (!r || String(r.text) !== body) return { ok: false, error: 'verify-failed' };
        try { if (fsHandle && typeof fsHandle.removeEntry === 'function') await fsHandle.removeEntry(name); } catch (e) { /* 删不掉只记诊断 */ }
        return { ok: true, name: name };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}


/** 宿主 dev API 里的「选目录」方法（关键字发现；没有 → null） */
function devPickMethod() {
    try {
        const a = abi();
        const dev = a && a.api && a.api.dev ? a.api.dev : null;
        if (!dev || typeof dev !== 'object') return null;
        for (const k of Object.keys(dev)) {
            if (!/pick|select|choose|dialog/i.test(k)) continue;
            if (!/dir|folder|path/i.test(k)) continue;
            if (typeof dev[k] !== 'function') continue;
            return { ns: k, fn: dev[k].bind(dev) };
        }
    } catch (e) { /* 忽略 */ }
    return null;
}

/**
 * v3.33.0（用户报告「修复本地存储路径设置，无法设置 android」）：**多机制**选目录，逐个实测后再接受：
 *   ① 宿主系统对话框（Tauri `dialog` 插件）—— 给出**真路径**，跨刷新有效（桌面首选；Android 走 SAF）；
 *   ② 浏览器原生文件夹选择器（File System Access）—— 只有句柄、绝对路径不可见（Chromium 系可用；Android 一般没有）；
 *   ③ 宿主 `api.dev` 的选目录方法。
 *   每个机制**都必须通过写探针**（写 → 回读 → 删除自己的探针文件）才算成功；全都失败 → 如实回报尝试过什么。
 * @returns {Promise<{ok:boolean, mechanism?:string, path?:string, name?:string, note:string, tried:Array<object>}>}
 */
export async function localDiskPickDir() {
    const tried = [];
    // ① 系统对话框（真路径）
    try {
        const d = await dialogPickDir();
        if (d && d.path) {
            const pr = await localDiskProbeDir(d.path);
            tried.push({ mechanism: 'dialog', path: String(d.path), ok: !!pr.ok, error: pr.ok ? '' : String(pr.error || 'write-failed') });
            if (pr.ok) {
                return { ok: true, mechanism: 'dialog', path: localDiskPathNorm(d.path), name: baseNameOfPath(d.path), note: '已选中目录 ' + localDiskPathNorm(d.path) + '（写探针 → 回读校验通过，真路径跨刷新有效）', tried: tried };
            }
        } else if (d && d.error && d.error !== 'cancelled') {
            tried.push({ mechanism: 'dialog', error: String(d.error), note: d.error === 'no-bridge' ? '本机没有 Tauri 原始桥 → 无系统文件夹对话框' : '' });
        } else if (d && d.error === 'cancelled') {
            tried.push({ mechanism: 'dialog', error: 'cancelled', note: '用户取消' });
            return { ok: false, reason: 'cancelled', note: '已取消选择', tried: tried };
        }
    } catch (e) { tried.push({ mechanism: 'dialog', error: String((e && e.message) || e) }); }
    // ② 浏览器原生文件夹选择器（句柄；路径不可见）
    try {
        const w = globalThis.window;
        if (w && typeof w.showDirectoryPicker === 'function') {
            try {
                const h = await w.showDirectoryPicker({ mode: 'readwrite' });
                if (h) {
                    if (typeof h.requestPermission === 'function') {
                        const perm = await h.requestPermission({ mode: 'readwrite' });
                        if (perm !== 'granted') { tried.push({ mechanism: 'fs-handle', error: 'denied' }); return { ok: false, reason: 'denied', note: '未授予读写权限', tried: tried }; }
                    }
                    fsHandle = h;
                    const pb = await handleProbe();
                    tried.push({ mechanism: 'fs-handle', name: String(h.name || ''), ok: !!pb.ok, error: pb.ok ? '' : String(pb.error || '') });
                    if (pb.ok) {
                        // v3.35.0：把**句柄标记**一并返回 → 界面写进路径框（框里立刻可见，不再需要人工填写）
                        const marker = localDiskHandleMarker(h.name);
                        return {
                            ok: true, mechanism: 'fs-handle', path: marker, marker: marker, name: String(h.name || ''),
                            note: '已选中文件夹「' + String(h.name || '') + '」（写探针通过）—— 路径框已填入 ' + marker
                                + '；浏览器出于隐私不暴露绝对路径，该标记即「写入本会话选中的文件夹」，刷新后句柄失效需重新选择',
                            tried: tried,
                        };
                    }
                    fsHandle = null;
                }
            } catch (e) {
                tried.push({ mechanism: 'fs-handle', error: String((e && (e.name || e.message)) || e) });
                return { ok: false, reason: String((e && e.name) || 'cancelled'), note: '已取消选择', tried: tried };
            }
        } else {
            tried.push({ mechanism: 'fs-handle', error: 'unsupported', note: '本机没有 File System Access API' });
        }
    } catch (e) { tried.push({ mechanism: 'fs-handle', error: String((e && e.message) || e) }); }
    // ③ v3.38.0：**浏览器内置目录**（OPFS）—— 没有文件夹选择器时（Android / Firefox）也能用**纯浏览器方法**建文件
    try {
        if (browserFsAvailable()) {
            const name = defaultBrowserDirName();
            const pb = await browserFsProbe(name);
            tried.push({ mechanism: 'browser-opfs', name: name, ok: !!pb.ok, error: pb.ok ? '' : String(pb.error || '') });
            if (pb.ok) {
                const marker = localDiskBrowserMarker(name);
                return {
                    ok: true, mechanism: 'browser-opfs', path: marker, marker: marker, name: name,
                    note: '已使用**浏览器内置目录**「' + name + '」（OPFS · 写探针通过）—— 路径框已填入 ' + marker
                        + '；纯浏览器方法，不需要宿主接口：PC 与手机都能用，刷新后仍有效（文件保存在本浏览器内）',
                    tried: tried,
                };
            }
        } else tried.push({ mechanism: 'browser-opfs', error: 'unsupported', note: '本浏览器不支持内置目录（OPFS）' });
    } catch (e) { tried.push({ mechanism: 'browser-opfs', error: String((e && e.message) || e) }); }
    // ④ 宿主 dev API 的选目录方法
    const dp = devPickMethod();
    if (dp) {
        try {
            const r = await dp.fn({});
            const p = (typeof r === 'string') ? r : ((r && (r.path || r.dir)) || '');
            if (p) {
                const pr = await localDiskProbeDir(String(p));
                tried.push({ mechanism: 'dev-api:' + dp.ns, path: String(p), ok: !!pr.ok, error: pr.ok ? '' : String(pr.error || '') });
                if (pr.ok) return { ok: true, mechanism: 'dev-api', path: localDiskPathNorm(String(p)), name: baseNameOfPath(String(p)), note: '已选中目录 ' + localDiskPathNorm(String(p)) + '（宿主接口 · 写探针通过）', tried: tried };
            } else tried.push({ mechanism: 'dev-api:' + dp.ns, error: 'no-path' });
        } catch (e) { tried.push({ mechanism: 'dev-api:' + dp.ns, error: String((e && e.message) || e) }); }
    } else {
        tried.push({ mechanism: 'dev-api', error: 'unsupported', note: '宿主没有提供选目录方法' });
    }
    const plat = localDiskPlatform(false);
    return {
        ok: false, reason: 'unsupported', tried: tried,
        note: '本机（' + localDiskPlatformLabel(plat.name) + '）没有可用的文件夹选择器，且浏览器内置目录不可用：' + tried.map((x) => String(x.mechanism) + (x.error ? ('✗' + String(x.error).slice(0, 40)) : '✓')).join(' · ')
            + ' —— 直接**只填一个目录名**（如 fft_v2_store）后点「✅ 校验本地磁盘目录」即可（会自动落在宿主应用数据目录内）',
    };
}

/** 浏览器内置目录的默认目录名：沿用当前「相对目录名」配置，否则 `fft_v2_store` */
function defaultBrowserDirName() {
    try {
        const raw = localDiskRaw();
        if (raw && localDiskPathKind(raw) === 'relative') return localDiskBrowserName(raw) || raw;
    } catch (e) { /* 忽略 */ }
    return 'fft_v2_store';
}

/**
 * v3.38.0（用户要求「设定到本地时，应该通过浏览器方法去构建相关文件」）：
 *   **显式选择**「浏览器内置目录」—— 由浏览器自己建文件（OPFS），不需要宿主接口。
 *   设备中立（同一配置手机 / PC 都成立）、刷新后仍有效；写探针通过才接受。
 * @param {string} [name] 目录名（默认沿用当前配置的相对名，否则 `fft_v2_store`）
 * @returns {Promise<{ok:boolean, mechanism?:string, path?:string, marker?:string, name?:string, note:string, tried:Array<object>}>}
 */
export async function localDiskUseBrowserDir(name) {
    const n = String(name == null ? '' : name).trim().split(/[\\/]+/).filter(Boolean)[0] || defaultBrowserDirName();
    const tried = [];
    if (!browserFsAvailable()) {
        tried.push({ mechanism: 'browser-opfs', name: n, error: 'unsupported', note: browserFsNote() });
        return { ok: false, reason: 'unsupported', note: '本浏览器不支持内置目录（OPFS）：' + browserFsNote() + ' —— 可改用「📂 选择文件夹…」或宿主目录', tried: tried };
    }
    const pb = await browserFsProbe(n);
    tried.push({ mechanism: 'browser-opfs', name: n, ok: !!pb.ok, error: pb.ok ? '' : String(pb.error || '') });
    if (!pb.ok) return { ok: false, reason: 'probe-failed', note: '浏览器内置目录写探针失败：' + String(pb.error || 'write-failed'), tried: tried };
    const marker = localDiskBrowserMarker(n);
    return {
        ok: true, mechanism: 'browser-opfs', path: marker, marker: marker, name: n, tried: tried,
        note: '已使用**浏览器内置目录**「' + n + '」（OPFS · 写探针通过）—— 路径框已填入 ' + marker
            + '；纯浏览器方法（PC / 手机通用，刷新后仍有效），文件在本浏览器内，可在调试页查看清单',
    };
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
/**
 * v3.38.0：**句柄是否该接管本次读写** —— 只有「配置就是句柄标记」或「配置为空但有会话句柄」时才接管。
 *   修复一处**假成功**：旧实现在任何路径下都优先用句柄（`fsHandle && handleUsable()`），
 *   于是本会话选过文件夹后，校验一个显式绝对路径也会写进那个文件夹、回读也自洽 → 探针**永远通过**。
 */
function handleActive() {
    try {
        const raw = localDiskRaw();
        return !!fsHandle && (localDiskIsHandlePath(raw) || !raw);
    } catch (e) { return false; }
}
/** 句柄内的相对路径（`@handle/<名>/a/b.json` → `a/b.json`；目录本身 → `''`） */
function relForHandle(path) {
    try {
        const s = String(path == null ? '' : path).trim();
        if (localDiskIsHandlePath(s)) return s.slice(HANDLE_PREFIX.length).split(/[\\/]+/).filter(Boolean).slice(1).join('/');
        return s.split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..').join('/');
    } catch (e) { return ''; }
}
/** 按相对路径写入会话句柄（逐段建目录） */
async function handleWritePath(rel, text) {
    const parts = String(rel == null ? '' : rel).split('/').filter(Boolean);
    if (!parts.length) throw new Error('empty-path');
    const name = parts.pop();
    let h = fsHandle;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create: true });
    const fh = await h.getFileHandle(name, { create: true });
    const ws = await fh.createWritable();
    await ws.write(String(text == null ? '' : text));
    await ws.close();
    return { ok: true };
}
/** 按相对路径读取会话句柄 */
async function handleReadPath(rel) {
    const parts = String(rel == null ? '' : rel).split('/').filter(Boolean);
    if (!parts.length) throw new Error('empty-path');
    const name = parts.pop();
    let h = fsHandle;
    for (const p of parts) h = await h.getDirectoryHandle(p);
    const fh = await h.getFileHandle(name);
    const f = await fh.getFile();
    return { ok: true, text: await f.text() };
}
/** 删会话句柄里的一个文件（`rel` 相对句柄根） */
async function handleRemovePath(rel) {
    const parts = String(rel == null ? '' : rel).split('/').filter(Boolean);
    if (!parts.length) throw new Error('empty-path');
    const name = parts.pop();
    let h = fsHandle;
    for (const p of parts) h = await h.getDirectoryHandle(p);
    await h.removeEntry(name);
    return { ok: true };
}
/** 列出会话句柄里的相对目录（`''` = 根） */
async function handleListPath(rel) {
    const out = [];
    let h = fsHandle;
    for (const p of String(rel == null ? '' : rel).split('/').filter(Boolean)) h = await h.getDirectoryHandle(p);
    for await (const ent of h.entries()) {
        const nm = Array.isArray(ent) ? ent[0] : (ent && ent.name);
        const hh = Array.isArray(ent) ? ent[1] : ent;
        out.push({ name: String(nm || ''), isFile: !(hh && hh.kind === 'directory'), size: 0 });
    }
    return out;
}
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

// ------------------------------------------------------------
// v3.34.0：TauriTavern（Tauri v2 插件）的**正确调用形态**（客户端构建实测；见文件头）
//   · 命中后**缓存形态**（`fsShape`）：同会话不再试另一种 —— 盲试会让宿主把每次失败都弹成报错；
//   · 写入前 `mkdir { recursive: true }`（新子目录必须自己建）；探针/清理用 `exists` / `remove`；
//   · 目录名（相对）解析到宿主**应用数据目录**（fs 只放行应用数据目录）。
// ------------------------------------------------------------
let fsShape = '';              // '' | 'v2-raw' | 'v1-json'（成功后缓存）
/** Tauri `BaseDirectory` 数值枚举（客户端构建实测：Audio=1 … AppLocalData=15 … Template=23） */
const BASE_DIR_ENUM = Object.freeze({
    AppLocalData: 15, AppData: 14, LocalData: 5, AppCache: 16, Data: 4,
    Document: 6, Download: 7, Temp: 12, AppConfig: 13, Home: 21, Desktop: 18,
});
let baseDirCache = { at: 0, dir: '', label: '', error: '' };

/** 字节 / 字符串 / 数组 → 文本（Tauri fs 读回的是**字节**） */
function decodeFsBytes(r) {
    try {
        if (typeof r === 'string') return r;
        if (!r) return '';
        if (r instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(r));
        if (r instanceof Uint8Array || Array.isArray(r)) return new TextDecoder('utf-8').decode(new Uint8Array(r));
        if (typeof r === 'object') {
            if (typeof r.text === 'string') return r.text;
            if (typeof r.contents === 'string') return r.contents;
            if (r.data != null) return decodeFsBytes(r.data);
        }
    } catch (e) { /* 忽略 */ }
    return '';
}

/** 建目录（`recursive`；已存在 / 不支持都当成功 —— 真正判据是随后「写 → 回读」） */
async function diskMkdir(dir) {
    const inv = tauriInvoke();
    if (!inv || !dir) return false;
    try { await inv('plugin:fs|mkdir', { path: dir, options: { recursive: true } }); return true; } catch (e) { return false; }
}
/** 是否存在（探针清理前的**存在性判断** —— 与「绝不盲删」同纪律） */
export async function localDiskExists(path) {
    // v3.38.0：浏览器内置目录 / 会话句柄各自判断存在性（不再只问宿主）
    try {
        if (localDiskIsBrowserPath(path)) return await browserFsExists(browserRel(path));
        if (handleActive() && fsHandle) {
            try { await handleReadPath(relForHandle(path)); return true; } catch (e) { return false; }
        }
    } catch (e) { /* 落到宿主判断 */ }
    const inv = tauriInvoke();
    if (!inv || !path) return false;
    try { return (await inv('plugin:fs|exists', { path: path, options: {} })) === true; } catch (e) { return false; }
}
/** 删一个文件（**只删自己写下的探针 / 过期文件**；失败只记诊断） */
async function diskRemove(path) {
    // v3.38.0：三个后端都要能删 —— 否则浏览器内置目录的探针文件会**留在**用户的目录里（清理失效）
    try {
        if (localDiskIsBrowserPath(path)) return !!(await browserFsRemove(browserRel(path))).ok;
        if (handleActive() && fsHandle) return !!(await handleRemovePath(relForHandle(path))).ok;
    } catch (e) { /* 落到宿主机制 */ }
    const inv = tauriInvoke();
    if (!inv || !path) return false;
    try { await inv('plugin:fs|remove', { path: path, options: {} }); return true; } catch (e) { return false; }
}
/** 宿主应用数据目录（`plugin:path|resolve_directory`；数值枚举 = 客户端实测口径）；结果缓存 */
export async function localDiskBaseDir(reprobe) {
    const inv = tauriInvoke();
    if (!inv) return { ok: false, dir: '', label: '', error: 'no-bridge' };
    if (!reprobe && baseDirCache.dir) return { ok: true, dir: baseDirCache.dir, label: baseDirCache.label, error: '' };
    for (const label of ['AppLocalData', 'AppData', 'LocalData', 'AppCache', 'Data']) {
        try {
            const r = await inv('plugin:path|resolve_directory', { directory: BASE_DIR_ENUM[label] });
            const dir = (typeof r === 'string') ? r : String((r && (r.path || r.dir)) || '');
            if (dir) { baseDirCache = { at: Date.now(), dir: localDiskPathNorm(dir), label: label, error: '' }; return { ok: true, dir: baseDirCache.dir, label: label, error: '' }; }
        } catch (e) { baseDirCache = { at: Date.now(), dir: '', label: '', error: String((e && e.message) || e) }; }
    }
    return { ok: false, dir: '', label: '', error: baseDirCache.error || 'resolve-failed' };
}
/** 目录名 → 应用数据目录下的绝对路径（绝对路径原样返回）；宿主不给基准目录则如实失败 */
export async function localDiskResolveDir(input) {
    const raw = localDiskPathNorm(input);
    if (!raw) return { ok: false, dir: '', raw: '', resolved: false, base: '', error: 'empty' };
    // v3.35.0：句柄标记不是宿主路径 —— 原样返回（写入会走本会话的文件夹句柄），绝不解析成宿主目录
    if (localDiskIsHandlePath(raw)) return { ok: true, dir: raw, raw: raw, resolved: false, base: '', handleMode: true, error: '' };
    // v3.38.0：浏览器内置目录标记 —— 原样返回（写入走 OPFS），同样绝不解析成宿主目录
    if (localDiskIsBrowserPath(raw)) return { ok: true, dir: raw, raw: raw, resolved: false, base: browserFsNote(), browserMode: true, error: '' };
    const kind = localDiskPathKind(raw);
    if (kind !== 'relative') return { ok: true, dir: raw, raw: raw, resolved: false, base: '', error: '' };
    const b = await localDiskBaseDir(false);
    if (!b.ok || !b.dir) {
        /**
         * v3.38.0（用户报告「手机端必须用内置路径，跑到 PC 端又不可用」）：**纯浏览器也要能用**。
         *   相对目录名在「没有宿主文件接口」的本机（PC 酒馆网页版 / Firefox）以前直接失败 →
         *   现在落到**浏览器内置目录**（OPFS）：同一份配置（`fft_v2_store`）在手机（宿主应用数据目录）
         *   与 PC（浏览器目录）**都成立**，各自写各自的本地目录 —— 这正是「本地存储路径」该有的语义。
         *   注意：此时**不把解析结果写回配置**（保持设备中立的目录名，见 `localDiskEnsureResolved`）。
         */
        if (browserFsAvailable()) {
            return { ok: true, dir: localDiskBrowserMarker(raw), raw: raw, resolved: false, browserMode: true, base: browserFsNote(), error: '' };
        }
        return { ok: false, dir: raw, raw: raw, resolved: false, base: '', error: String(b.error || 'no-base-dir') };
    }
    return { ok: true, dir: localDiskJoin(b.dir, raw), raw: raw, resolved: true, base: b.dir + '（' + b.label + '）', error: '' };
}
/**
 * v3.34.0：**各读写入口统一用「有效目录」** —— 配置里只有一个目录名（相对）时，
 *   当场解析到宿主应用数据目录（`$APPLOCALDATA/<名字>`）再用；解析不了就退回原名（写入会如实失败并告警）。
 * @returns {Promise<string>} 绝对路径（或原名）
 */
async function effectiveDir() {
    const raw = localDiskRaw();
    // v3.38.0：配置留空但本会话已选文件夹 → 用**句柄标记**当目录（此前返回 `''` → 各入口一律 `off`，
    //   与 `localDiskOn()`（句柄存在即为开启）自相矛盾：选了文件夹却一个文件都写不出来）
    if (!raw) return fsHandle ? localDiskHandleMarker(String(fsHandle.name || '')) : '';
    if (localDiskPathKind(raw) !== 'relative') return raw;
    const rs = await localDiskResolveDir(raw);
    return (rs.ok && rs.dir) ? rs.dir : raw;
}
/**
 * v3.34.0：启动 / 校验时把「只填了目录名」的配置**一次性解析成绝对路径**并写回（设备本地），
 *   之后任何写入都不再需要解析，UI 也能显示完整路径。
 * @returns {Promise<{ok:boolean, dir:string, resolved:boolean, error:string}>}
 */
export async function localDiskEnsureResolved() {
    const raw = localDiskRaw();
    if (!raw || localDiskPathKind(raw) !== 'relative') return { ok: true, dir: raw, resolved: false, error: '' };
    const rs = await localDiskResolveDir(raw);
    if (!rs.ok || !rs.dir) return { ok: false, dir: raw, resolved: false, error: String(rs.error || 'resolve-failed') };
    // v3.38.0：落到浏览器内置目录时**保持原目录名**（设备中立：换设备各自解析，绝不写死成某个路径）
    if (rs.browserMode) return { ok: true, dir: String(rs.dir || raw), resolved: false, browserMode: true, error: '' };
    try {
        cfg.storage = Object.assign({}, cfg.storage || {});
        cfg.storage.localDiskDir = rs.dir;
        try { const RT = await import('../core/model/runtime.js'); RT.saveCfg(); } catch (e) { /* 落盘失败不影响本次会话 */ }
    } catch (e) { /* 忽略 */ }
    return { ok: true, dir: rs.dir, resolved: true, error: '' };
}

/**
 * v3.38.0：本机是否存在**任一**可用机制（宿主接口 / 会话句柄 / 浏览器内置目录）。
 *   用于把「没有机制」与「机制有、但这次调用失败」分开如实回报。
 */
function hasAnyMechanism() {
    try { if (localDiskCapability(false).ok) return true; } catch (e) { /* 忽略 */ }
    try { if (fsHandle) return true; } catch (e) { /* 忽略 */ }
    return browserFsAvailable();
}

/**
 * 探测宿主可用的「写盘」能力（**只读探测，不写任何东西**）。
 * @returns {{ok:boolean, mechanism:string, ns:string, writeMethod:string, readMethod:string, tauriFs:boolean, devKeys:string[], note:string}}
 */
export function localDiskCapability(reprobe) {
    if (caps && !reprobe) return caps;
    const out = { ok: false, mechanism: '', ns: '', writeMethod: '', readMethod: '', tauriFs: false, browserFs: false, devKeys: [], note: '' };
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
        /**
         * v3.38.0：**浏览器内置目录**（OPFS）也算「可用机制」—— 它是纯浏览器方法，不需要任何宿主接口。
         *   以前这里只认宿主接口 → PC 酒馆网页版报 `ok:false`（用户报告的「PC 端不可用」）。
         */
        out.browserFs = browserFsAvailable();
        if (!out.ok && out.browserFs) { out.ok = true; out.mechanism = 'browser-opfs'; out.note = browserFsNote(); }
        if (!out.ok) out.note = '本机没有可用的本地目录机制（api.dev 无文件类命名空间、无 Tauri 原始桥、浏览器也不支持内置目录）';
    } catch (e) { out.note = String((e && e.message) || e); }
    caps = out;
    return caps;
}
/** 强制重探（UI「校验目录」用） */
export function localDiskReprobe() { return localDiskCapability(true); }

/** 写文本（按探测到的机制；不抛错，失败如实回报） */
async function diskWriteText(path, text) {
    // v3.38.0 ① **浏览器内置目录（OPFS）**：纯浏览器方法，不需要宿主接口（PC 端可用性的根因修复）
    if (localDiskIsBrowserPath(path)) {
        const r = await browserFsWrite(browserRel(path), text);
        return r.ok
            ? { ok: true, mechanism: 'browser-opfs', path: String(r.path || '') }
            : { ok: false, reason: 'browser-write-failed', error: String(r.error || 'write-failed') };
    }
    // v3.30.0 ② 浏览器选中的文件夹句柄（原生、无需宿主 API）；v3.38.0：只在**配置就是句柄标记**时接管
    try { if (handleActive() && await handleUsable()) { await handleWritePath(relForHandle(path), text); return { ok: true, mechanism: 'fs-handle' }; } } catch (e) { /* 落到下面的宿主机制 */ }
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
         * v3.34.0（用户报告「方法用错了，会弹出报错」）：**不再盲试多种形态** ——
         *   每次盲试失败都会被宿主当成一次错误（弹窗），旧实现一次写要试 18 种组合。
         *   现在只试两种**已知**形态，成功即缓存（同会话不再试另一种）：
         *   ① 规范（TauriTavern 实测）：`invoke(cmd, <原始字节>, { headers: { path, options } })`；
         *   ② 旧宿主：`invoke(cmd, { path, contents })`。
         */
        // v3.34.0：新子目录自己建（`mkdir -p`）；已存在 / 不支持都不算失败
        const dirOf = String(path).replace(/[\\/][^\\/]*$/, '');
        if (dirOf) await diskMkdir(dirOf);
        const bytes = new TextEncoder().encode(body);
        // ① 规范形态（TauriTavern 客户端构建实测）：**原始字节 body** + `headers.path`
        const tryV2 = async () => {
            await inv('plugin:fs|write_text_file', bytes, { headers: { path: encodeURIComponent(String(path)), options: '{}' } });
        };
        // ② 旧形态（Tauri v1 / 更老的宿主）：JSON 参数
        const tryV1 = async () => { await inv('plugin:fs|write_text_file', { path: path, contents: body }); };
        const order = (fsShape === 'v1-json') ? [['v1-json', tryV1], ['v2-raw', tryV2]] : [['v2-raw', tryV2], ['v1-json', tryV1]];
        let lastErr = '';
        for (const pair of order) {
            try { await pair[1](); fsShape = pair[0]; return { ok: true, mechanism: c.mechanism + '/' + pair[0] }; }
            catch (e) {
                lastErr = String((e && e.message) || e);
                /**
                 * v3.34.0：**只在「参数形态不对」时才试下一种** —— 权限 / 放行范围类拒绝（forbidden / not allowed / scope）
                 *   是**路径本身**的问题，换个参数形态也照样被拒；继续试只会让宿主再弹一次报错（用户报告的「弹出报错」）。
                 */
                if (!/missing|invalid|unexpected|deserial|expected|args|argument/i.test(lastErr)) break;
            }
        }
        fsShape = '';
        const forbidden = /forbidden|not allowed|denied|scope|permission/i.test(lastErr);
        return { ok: false, reason: forbidden ? 'forbidden-path' : 'write-failed', error: lastErr };
    } catch (e) { return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) }; }
}
/** 读文本 */
async function diskReadText(path) {
    // v3.38.0 ① 浏览器内置目录（OPFS）
    if (localDiskIsBrowserPath(path)) {
        const r = await browserFsRead(browserRel(path));
        return r.ok ? { ok: true, text: String(r.text == null ? '' : r.text), mechanism: 'browser-opfs' } : { ok: false, reason: String(r.ok ? 'read-failed' : 'browser-miss'), error: String(r.error || 'miss') };
    }
    try { if (handleActive() && await handleUsable()) return Object.assign(await handleReadPath(relForHandle(path)), { mechanism: 'fs-handle' }); } catch (e) { /* 落到下面的宿主机制 */ }
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
        // v3.34.0（TauriTavern 实测）：`{ path, options }`，返回值是**字节**（ArrayBuffer / Uint8Array / number[]）
        const r = await inv('plugin:fs|read_text_file', { path: path, options: {} });
        const text = decodeFsBytes(r);
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
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    const out = { ok: false, dir: dir, names: [], entries: [], error: '' };
    if (!dir) { out.error = 'off'; return out; }
    try {
        // v3.38.0：浏览器内置目录（OPFS）
        if (localDiskIsBrowserPath(dir)) {
            const r = await browserFsList(browserRel(dir));
            out.entries = r.entries || []; out.names = out.entries.map((x) => x.name); out.ok = !!r.ok;
            out.error = r.ok ? '' : String(r.error || 'browser-list-failed');
            return out;
        }
        if (handleActive() && await handleUsable()) { out.entries = await handleListPath(relForHandle(dir)); out.names = out.entries.map((x) => x.name); out.ok = true; return out; }
        const inv = tauriInvoke();
        if (!inv) { out.error = hasAnyMechanism() ? 'no-invoke' : String(localDiskCapability(false).note || 'no-capability'); return out; }
        const r = await inv('plugin:fs|read_dir', { path: dir, options: {} });
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
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    if (!dir) return { ok: false, reason: 'off', path: '' };
    const safe = String(name || '').replace(/^[\\/]+/, '').replace(/\.\./g, '');
    const full = localDiskJoin(dir, safe);
    const body = String(text == null ? '' : text);
    const w = await diskWriteText(full, body);
    if (!w.ok) {
        const why = (w.reason === 'forbidden-path')
            ? '宿主只放行应用数据目录（该路径被拒绝）—— 可只填一个目录名（如 fft_v2_store）'
            : String(w.error || w.reason || 'write-failed');
        stats.failures++; stats.lastError = why;
        localDiskMarkInvalid(dir, String(w.reason || 'write-failed'), why);
        return { ok: false, path: full, error: why, reason: w.reason, raw: String(w.error || '') };
    }
    const r = await diskReadText(full);
    if (!r.ok || String(r.text) !== body) {
        stats.failures++;
        stats.lastError = 'verify-failed';
        localDiskMarkInvalid(dir, 'verify-failed', '写后回读不一致');
        return { ok: false, path: full, error: 'write-then-readback-mismatch', reason: 'verify-failed' };
    }
    stats.writes++; stats.lastAt = Date.now(); stats.lastBytes = body.length; stats.lastError = ''; stats.mechanism = String(w.mechanism || '');
    localDiskClearInvalid();   // v3.28.1：写得进去 → 该路径有效
    // v3.40.0（`docs/D16` L11）：成功写盘是**高频**日志 —— 合并记录（同 key 在窗口内只占一条，带 n / lastAt / bytes），
    //   否则 300 条环会被同一句话占满（真机 83% 是「存储」，其中 166/200 是这一句），异常与摘要类诊断被挤出。
    try { dbgLogCoalesced('存储', 'local-disk-write|' + String(stats.mechanism || ''), { action: '本地磁盘目录：写入并回读校验通过', path: full, bytes: body.length, mechanism: stats.mechanism }); } catch (e) { /* 忽略 */ }
    return { ok: true, path: full, bytes: body.length, mechanism: stats.mechanism };
}

/** 读一个文件（不存在 → `{ok:false, miss:true}`） */
export async function localDiskRead(name) {
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    if (!dir) return { ok: false, reason: 'off' };
    const safe = String(name || '').replace(/^[\\/]+/, '').replace(/\.\./g, '');
    const full = localDiskJoin(dir, safe);
    const r = await diskReadText(full);
    if (!r.ok) return { ok: false, path: full, miss: true, error: String(r.error || r.reason || 'miss') };
    stats.reads++; stats.lastAt = Date.now();
    return { ok: true, path: full, text: String(r.text) };
}

/**
 * 目录探针：**建目录 → 写 → 回读 → 删掉自己的探针文件**（证明「这个目录确实可写」）。
 * v3.34.0：传入**目录名**（相对）时先解析到宿主应用数据目录（`$APPLOCALDATA/<名字>`）——
 *   宿主的 fs 只放行应用数据目录，`D:\…` / `/storage/emulated/0/…` 一律会被拒绝；
 *   解析后的**完整路径**由 `dir` 返回（UI 据此回填显示）。
 * @param {string} rawPath 绝对路径，或一个目录名
 * @returns {Promise<{ok:boolean, dir:string, raw:string, resolved:boolean, base:string, kind:string, path:string, mechanism:string, error:string}>}
 */
export async function localDiskProbeDir(rawPath) {
    const raw = localDiskPathNorm(rawPath);
    const out = { ok: false, dir: raw, raw: raw, resolved: false, base: '', kind: localDiskPathKind(rawPath), path: '', mechanism: '', error: '' };
    if (!raw) { out.error = 'empty'; return out; }
    const cap = localDiskCapability(true);
    out.mechanism = cap.mechanism;
    const prev = localDiskRaw();
    // v3.35.0：**句柄标记** —— 校验「本会话选中的文件夹」是否还能写（刷新后句柄失效则如实报错，不解析成宿主路径）
    if (localDiskIsHandlePath(raw)) {
        out.handleMode = true;
        out.mechanism = 'fs-handle';
        try {
            if (!fsHandle) { out.error = 'handle-lost'; out.note = '浏览器选中的文件夹句柄已失效（刷新页面后需重新「📂 选择文件夹…」）'; return out; }
            if (!(await handleUsable())) { out.error = 'handle-denied'; out.note = '浏览器未授予该文件夹的读写权限（请重新选择并允许）'; return out; }
            const pb = await handleProbe();
            if (!pb.ok) { out.error = String(pb.error || 'probe-failed'); localDiskMarkInvalid(raw, 'probe-write-failed', out.error); return out; }
            out.ok = true; out.resolved = false; out.dir = raw; out.path = raw + '/' + 'ftt2-local-＜角色＞.json';
            stats.probes++; stats.lastAt = Date.now();
            localDiskClearInvalid();
            return out;
        } catch (e) { out.error = String((e && e.message) || e); return out; }
    }
    try {
        const rs = await localDiskResolveDir(raw);
        out.dir = String(rs.dir || raw); out.resolved = !!rs.resolved; out.base = String(rs.base || '');
        // v3.38.0：相对目录名落到**浏览器内置目录**（本机无宿主文件接口）→ 标记形态，探针走 OPFS
        if (rs.browserMode) { out.browserMode = true; out.kind = 'browser'; }
        if (!rs.ok) { out.error = String(rs.error || 'resolve-failed'); localDiskMarkInvalid(raw, 'resolve-failed', out.error); return out; }
        // 探针用「显式路径」：临时把 cfg 指向待校验目录（不改配置持久化，只在本函数内）
        cfg.storage = Object.assign({}, cfg.storage || {});
        const keep = cfg.storage.localDiskDir;
        cfg.storage.localDiskDir = out.dir;
        const body = JSON.stringify({ probe: 1, at: Date.now(), dir: out.dir });
        const w = await localDiskWrite('ftt2-local-probe.json', body);
        const r = await localDiskRead('ftt2-local-probe.json');
        cfg.storage.localDiskDir = keep;
        if (!w.ok) { out.error = String(w.error || w.reason || 'write-failed'); localDiskMarkInvalid(out.dir, 'probe-write-failed', out.error); return out; }
        if (!r.ok || String(r.text) !== body) { out.error = 'verify-failed'; localDiskMarkInvalid(out.dir, 'probe-verify-failed', '写后回读不一致'); return out; }
        // 删掉自己的探针文件（存在才删；失败只记诊断，绝不动别人的文件）
        try {
            const probeFull = String(w.path || '');
            if (probeFull && await localDiskExists(probeFull)) await diskRemove(probeFull);
        } catch (e) { /* 忽略 */ }
        out.ok = true;
        // v3.38.0：浏览器内置目录的探针路径按**标记形态**回报（`@browser/<名>/…`），与 UI 展示口径一致
        out.path = out.browserMode ? localDiskJoin(out.dir, 'ftt2-local-probe.json') : String(w.path || '');
        stats.probes++; stats.lastAt = Date.now();
        localDiskClearInvalid();
    } catch (e) {
        try { cfg.storage.localDiskDir = prev; } catch (e2) { /* 忽略 */ }
        out.error = String((e && e.message) || e);
    }
    return out;
}

/**
 * v3.31.0（用户要求「本地文件可以拆碎了保存……呈现结构化、体系化，而不是聚合到单一文件」）：
 *   把一份存储信封**按维度拆成多个文件**写进本地目录：`<本地存储路径>/<scope>/<维度>.json` + `manifest.json`。
 *   · 浏览器选中的文件夹（File System Access）→ 建子目录后逐文件写；
 *   · 宿主文件 API（tauri-fs）→ 逐文件写（同样路径）。
 *   与**单文件**机制并存（单文件仍是「一次写入」的原子副本），本函数是**结构化副本**，失败只记诊断、不阻塞保存。
 * @param {object} env 存储信封
 * @param {string} scope 角色作用域
 * @returns {Promise<{ok:boolean, dir?:string, files?:number, counts?:object, error?:string}>}
 */
export async function localDiskWriteShards(env, scope) {
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    if (!dir && !fsHandle) return { ok: false, error: 'off' };
    try {
        const { splitParts, buildManifest, manifestFileName, shardFileName, scopeSlug } = await import('./local-shards.js');
        const r = splitParts(env);
        if (!r.ok) return { ok: false, error: r.reason || 'no-data' };
        const sub = scopeSlug(scope || r.scope);
        const mf = buildManifest(r.parts, { at: r.at, scope: String(scope || r.scope || '') });
        // v3.38.0：**统一走 `diskWriteText` 路由**（浏览器内置目录 / 会话句柄 / 宿主 fs 三选一，按路径判定）
        //   旧实现各自内联一套句柄分支 → 与路由规则容易漂移（句柄会劫持显式路径）。
        let n = 0;
        for (const k of Object.keys(r.parts)) {
            const w = await diskWriteText(localDiskJoin(localDiskJoin(dir, sub), shardFileName(k)), JSON.stringify(r.parts[k]));
            if (!w.ok) return { ok: false, error: String(w.error || 'write-failed'), files: n };
            n++;
        }
        const wm = await diskWriteText(localDiskJoin(localDiskJoin(dir, sub), manifestFileName()), JSON.stringify(mf));
        if (!wm.ok) return { ok: false, error: String(wm.error || 'manifest-failed'), files: n };
        stats.writes++;
        return { ok: true, dir: localDiskJoin(dir, sub), files: n + 1, counts: r.counts };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * v3.31.0：读回**结构化分片**（`<scope>/manifest.json` + 逐维文件）→ 合并成 data。
 *   清单校验：坏片只报坏片（返回 `bad`），只要 `meta` 可用就仍返回数据（维度缺失按空数组处理）。
 */
export async function localDiskReadShards(scope) {
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    try {
        const { joinParts, verifyParts, manifestFileName, shardFileName, allShardNames, scopeSlug } = await import('./local-shards.js');
        const sub = scopeSlug(scope);
        const readOne = async (name) => {
            // v3.38.0：统一走 `diskReadText` 路由（见 `localDiskWriteShards` 同款说明）
            if (!dir) return null;
            const r = await diskReadText(localDiskJoin(localDiskJoin(dir, sub), name));
            return (r && r.ok) ? String(r.text) : null;
        };
        const mfRaw = await readOne(manifestFileName());
        if (!mfRaw) return { ok: false, error: 'no-manifest' };
        const mf = JSON.parse(mfRaw);
        const parts = {};
        for (const k of allShardNames()) {
            const raw = await readOne(shardFileName(k));
            if (raw == null) continue;
            try { parts[k] = JSON.parse(raw); } catch (e) { /* 坏片跳过（verify 会报） */ }
        }
        const vf = verifyParts(parts, mf);
        if (!parts.meta) return { ok: false, error: 'no-meta', bad: vf.bad };
        const j = joinParts(parts);
        return { ok: !!j.ok, data: j.data, dims: j.dims, bad: vf.bad, at: Number(mf.at || 0) || 0, dir: dir ? localDiskJoin(dir, sub) : sub };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * v3.32.0（用户要求「快照 / 日志也拆分结构化存储，避免单一文件聚合」）：
 *   把快照链与日志**按结构化小文件**写进本地目录：
 *     · 快照：`<目录>/<scope>/snapshots/<条目 id>.json` + `snapshots/manifest.json`；
 *     · 日志：`<目录>/<scope>/logs/<kind>-<YYYY-MM-DD>.json` + `logs/manifest.json`。
 *   best-effort：失败只记诊断，不阻塞主流程。
 * @param {'snapshots'|'logs'} what
 * @param {Array<object>} list 快照链（`state.snapStore`）或日志条目
 * @param {string} scope 角色作用域
 * @param {{kind?:string, cap?:number}} [opts] 日志种类与每片条数上限
 * @returns {Promise<{ok:boolean, dir?:string, files?:number, count?:number, error?:string}>}
 */
export async function localDiskWriteParts(what, list, scope, opts) {
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    if (!dir && !fsHandle) return { ok: false, error: 'off' };
    try {
        const LP = await import('./local-parts.js');
        const { scopeSlug } = await import('./local-shards.js');
        const sub = scopeSlug(scope);
        const kind = String((opts && opts.kind) || 'debug');
        const built = (what === 'snapshots')
            ? LP.snapshotParts(list)
            : LP.logParts(list, kind, { cap: (opts && opts.cap) || 500 });
        if (!built || !built.ok) return { ok: false, error: (built && built.reason) || 'build-failed' };
        const dirName = (what === 'snapshots') ? LP.SNAP_DIR : LP.LOG_DIR;
        const mfName = (what === 'snapshots') ? LP.SNAP_MANIFEST : LP.LOG_MANIFEST;
        const writePair = async (write) => {
            let n = 0;
            for (const name of Object.keys(built.files)) { await write(dirName + '/' + name, built.files[name]); n++; }
            await write(dirName + '/' + mfName, JSON.stringify(built.manifest));
            return n + 1;
        };
        // v3.38.0：统一走 `diskWriteText` 路由（浏览器内置目录 / 会话句柄 / 宿主 fs）
        const base = localDiskJoin(localDiskJoin(dir, sub), dirName);
        const files = await writePair(async (name, text) => { await diskWriteText(localDiskJoin(base, name.split('/').pop()), text); });
        stats.writes++;
        return { ok: true, dir: base, files: files, count: Number(built.manifest.count || 0) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * v3.32.0：读回**快照 / 日志的结构化拆分**（逐条 / 按天小文件 + manifest），按清单校验逐片 hash。
 *   坏片只报坏片（`bad`），可用片照常返回 —— 与分片读同构，供载入兜底与诊断使用。
 * @param {'snapshots'|'logs'} what
 * @param {string} scope 角色作用域
 * @returns {Promise<{ok:boolean, manifest?:object, files?:object, bad?:string[], snapStore?:Array, entries?:Array, count?:number, dir?:string, error?:string}>}
 */
export async function localDiskReadParts(what, scope) {
    const dir = await effectiveDir();   // v3.34.0：只填目录名时当场解析到宿主应用数据目录
    if (!dir && !fsHandle) return { ok: false, error: 'off' };
    try {
        const LP = await import('./local-parts.js');
        const { scopeSlug } = await import('./local-shards.js');
        const sub = scopeSlug(scope);
        const dirName = (what === 'snapshots') ? LP.SNAP_DIR : LP.LOG_DIR;
        const readOne = async (name) => {
            // v3.38.0：统一走 `diskReadText` 路由
            const r = await diskReadText(localDiskJoin(localDiskJoin(localDiskJoin(dir, sub), dirName), name));
            return (r && r.ok) ? String(r.text) : null;
        };
        const mfRaw = await readOne('manifest.json');
        if (!mfRaw) return { ok: false, error: 'no-manifest' };
        const mf = JSON.parse(mfRaw);
        const files = {};
        for (const name of (Array.isArray(mf.order) ? mf.order : [])) {
            const raw = await readOne(String(name));
            if (raw == null) continue;
            files[String(name)] = raw;
        }
        const j = (what === 'snapshots') ? LP.joinSnapshotParts(mf, files) : LP.joinLogParts(mf, files);
        return {
            ok: !!j.ok, manifest: mf, files: files, bad: j.bad || [],
            snapStore: j.snapStore || [], entries: j.entries || [],
            count: Number(mf.count || 0) || 0,
            dir: dir ? localDiskJoin(localDiskJoin(dir, sub), dirName) : (sub + '/' + dirName),
        };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 只读状态（UI / 诊断） */

export function localDiskInfo() {
    const dir = localDiskRaw();
    const c = localDiskCapability(false);
    const plat = localDiskPlatform(false);
    const handleMode = localDiskIsHandlePath(dir);
    const handleName = handleMode ? localDiskHandleName(dir) : (fsHandle ? String(fsHandle.name || '') : '');
    // v3.38.0：**浏览器内置目录**（OPFS）—— 纯浏览器方法，PC / 手机都可用（刷新后仍在，无需重选）
    /**
     * v3.38.0：相对目录名在本机**没有宿主基准目录**但有 OPFS 时，实际会落到浏览器内置目录
     *   （`localDiskResolveDir` 的口径）—— 这里给一个**同步预览**，让界面如实显示真实落点。
     */
    const browserPreview = !localDiskIsHandlePath(dir) && localDiskPathKind(dir) === 'relative'
        && !baseDirCache.dir && browserFsAvailable();
    const browserMode = localDiskIsBrowserPath(dir) || browserPreview;
    const browserName = browserMode ? (localDiskBrowserName(dir) || (browserPreview ? dir : '')) : '';
    return {
        enabled: localDiskOn(),
        // v3.35.0：句柄模式 → `dir` 就是标记本身（路径框里显示的就是它）；另给 `display` 供界面讲清楚「这是什么」
        dir: dir || (fsHandle ? String(fsHandle.name || '') : ''),
        display: handleMode
            ? (handleName + '（浏览器选中的文件夹 · 绝对路径不可见 · 本会话内直接写入该文件夹' + (fsHandle ? '' : ' · 句柄已失效，请重新选择') + '）')
            : (browserMode
                ? (browserName + '（浏览器内置目录（OPFS）· 由浏览器直接建文件，不需要宿主接口 · 刷新后仍在；文件在本浏览器内，可从调试页查看）')
                : ''),
        handleMode: handleMode, handleName: handleName, handleLive: !!fsHandle,
        browserMode: browserMode, browserName: browserName, browserFs: browserFsAvailable(),
        kind: handleMode ? 'handle' : (browserMode ? 'browser' : (fsHandle ? 'fs-handle' : localDiskPathKind(dir))), handle: !!fsHandle,
        // v3.33.0：平台与「路径形态 vs 本机平台」的冲突提示（用户报告「Android 上设不了」的直接可见原因）
        platform: plat.name, platformSource: plat.source, platformLabel: localDiskPlatformLabel(plat.name),
        pathWarn: localDiskPathWarn(dir, plat.name),
        // v3.34.0：宿主应用数据目录（相对目录名的落点）+ 已实测成功的传输形态（诊断「方法对不对」）
        base: baseDirCache.dir, baseLabel: baseDirCache.label, fsShape: fsShape,
        capability: { ok: c.ok, mechanism: c.mechanism, ns: c.ns, writeMethod: c.writeMethod, readMethod: c.readMethod, tauriFs: c.tauriFs, browserFs: !!c.browserFs, devKeys: c.devKeys, note: c.note },
        invalid: localDiskInvalid(),   // v3.28.1：路径是否已被标记为**无效**（写入失败 / 探针失败）
        stats: Object.assign({}, stats),
    };
}
/** 测试/诊断：重置会话状态 */
export function localDiskReset() {
    caps = null;
    platCache = null;   // v3.33.0：平台缓存也清（测试里会改 UA / 宿主）
    fsShape = '';       // v3.34.0：传输形态缓存也清（下一次写会重新尝试规范形态）
    baseDirCache = { at: 0, dir: '', label: '', error: '' };
    stats.writes = 0; stats.reads = 0; stats.failures = 0; stats.probes = 0;
    stats.lastError = ''; stats.lastAt = 0; stats.lastBytes = 0; stats.mechanism = '';
    localDiskClearInvalid();
    fsHandle = null;
    try { browserFsReset(); } catch (e) { /* 忽略 */ }
    return true;
}

export const localDiskStats = stats;

export default {
    HANDLE_PREFIX, localDiskIsHandlePath, localDiskHandleName, localDiskHandleMarker,
    // v3.38.0：浏览器内置目录（OPFS）—— 纯浏览器方法，PC 端可用性的修复
    BROWSER_PREFIX, localDiskIsBrowserPath, localDiskBrowserName, localDiskBrowserMarker, localDiskUseBrowserDir,
    localDiskRaw, localDiskOn, localDiskPathKind, localDiskPathNorm, localDiskJoin,
    localDiskCapability, localDiskReprobe, localDiskWrite, localDiskRead, localDiskProbeDir,
    localDiskInfo, localDiskReset, localDiskMarkInvalid, localDiskClearInvalid, localDiskInvalid, localDiskList,
    localDiskPickDir, localDiskHasHandle, localDiskWriteShards, localDiskReadShards, localDiskWriteParts, localDiskReadParts,
    localDiskList, localDiskEnsureResolved,
    // v3.33.0：平台识别 / 路径形态冲突提示
    localDiskPlatform, localDiskPlatformAsync, localDiskPlatformLabel, localDiskPathWarn,
    // v3.34.0：宿主应用数据目录（相对目录名的落点）/ 名称解析 / 存在性判断
    localDiskBaseDir, localDiskResolveDir, localDiskExists,
};
