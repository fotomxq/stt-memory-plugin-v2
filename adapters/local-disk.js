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
/** v3.33.0：只要「有路径」或「本会话选过文件夹句柄」就算开启（句柄场景路径框可以为空） */
export function localDiskOn() { return !!(localDiskRaw() || fsHandle); }

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
 * v3.33.0：路径形态与本机平台的**冲突提示**（''=没问题）。
 *   用户遇到的「Android 上根本设不了」根因之一：路径框里留着从别的设备同步过来的 `D:\…`，
 *   在本机必然不可写 → 校验失败 → 看起来「设置了也没用」。这里把话说在前面。
 */
export function localDiskPathWarn(raw, platform) {
    const dir = localDiskPathNorm(raw);
    if (!dir) return '';
    const kind = localDiskPathKind(dir);
    const plat = String(platform || localDiskPlatform().name);
    if (plat === 'android' || plat === 'ios') {
        if (kind === 'windows-abs') return '这看起来是 Windows 路径，本机是 ' + localDiskPlatformLabel(plat) + '：本机写不了它 —— 请填本机路径（如 /storage/emulated/0/Download/ftt_v2_store）或点「📁 候选目录」';
    } else if (plat === 'desktop') {
        if (kind === 'posix-abs' && dir.charAt(1) !== '/') return '这看起来是 Android / Linux 路径，本机是桌面系统：本机写不了它 —— 请填本机路径（如 D:\\FTT\\store）';
    }
    if (kind === 'relative') return '这不是绝对路径：宿主只会把相对路径当**命名空间名**（真实落点在宿主数据目录内），建议填绝对路径';
    return '';
}

/** 系统对话框选目录（Tauri `dialog` 插件；返回真路径，Android 上可能是 SAF 给出的路径） */
async function dialogPickDir() {
    const inv = tauriInvoke();
    if (!inv) return { error: 'no-bridge' };   // 没有 Tauri 原始桥 → 连对话框都谈不上（如实回报）
    const cmds = ['plugin:dialog|open', 'dialog|open'];
    const shapes = [
        { options: { directory: true, multiple: false, title: '选择本地存储目录' } },
        { directory: true, multiple: false, title: '选择本地存储目录' },
        { options: { directory: true, multiple: false } },
        { directory: true },
    ];
    let lastErr = '';
    for (const cmd of cmds) {
        for (const arg of shapes) {
            try {
                const r = await inv(cmd, arg);
                const p = (typeof r === 'string') ? r : ((r && (r.path || r.filePath || r.uri)) || '');
                if (p) return { path: String(p) };
                return { error: 'cancelled' };      // 命令可用但用户取消 → 不再试其它形态
            } catch (e) { lastErr = String((e && e.message) || e); }
        }
    }
    return { error: lastErr || 'dialog-unavailable' };
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

/**
 * v3.33.0：**宿主提供的可写目录候选**（Android 上尤其重要 —— 那里通常没有浏览器文件夹选择器）。
 *   来源：① Tauri `path` 插件的标准目录；② 宿主 `api.*` 里形如路径的字段/零参方法；
 *   ③ Android 常见公共目录（**仅建议**，选中后会做写探针，写不进去会如实失败）。
 * @returns {Promise<{platform:string, items:Array<{path:string,label:string,source:string,kind:string}>, notes:string[]}>}
 */
export async function localDiskDirCandidates() {
    const plat = await localDiskPlatformAsync();
    const items = [];
    const notes = [];
    const push = (p, label, source) => {
        const d = localDiskPathNorm(p);
        if (!d) return;
        if (items.some((x) => x.path === d)) return;
        items.push({ path: d, label: String(label || ''), source: String(source || ''), kind: localDiskPathKind(d) });
    };
    // ① Tauri path 插件（AppLocalData / Download / Document / Home / Temp …）
    const inv = tauriInvoke();
    if (inv) {
        const names = ['AppLocalData', 'AppData', 'AppConfig', 'Download', 'Document', 'Home', 'Temp', 'Data', 'LocalData', 'Desktop'];
        for (const n of names) {
            let got = '';
            for (const cmd of ['plugin:path|resolve_directory', 'path|resolve_directory']) {
                for (const arg of [{ directory: n }, { path: n }, { dir: n }]) {
                    try { const r = await inv(cmd, arg); got = (typeof r === 'string') ? r : String((r && (r.path || r.dir)) || ''); } catch (e) { got = ''; }
                    if (got) break;
                }
                if (got) break;
            }
            if (got) push(got, n, 'tauri-path');
        }
        if (!items.length) notes.push('宿主没有提供 Tauri `path` 插件接口（拿不到标准目录）');
    }
    // ② 宿主 api 里的路径类字段 / 零参方法（关键字匹配，调用失败一律忽略）
    try {
        const a = abi();
        const holders = [a && a.api && a.api.dev, a && a.api && a.api.path, a && a.api && a.api.paths, a && a.api].filter((x) => x && typeof x === 'object');
        for (const holder of holders) {
            for (const k of Object.keys(holder).slice(0, 60)) {
                if (!/dir|path|home|root|folder|data|download|document|temp|store/i.test(k)) continue;
                let v = holder[k];
                if (typeof v === 'function') { try { v = await v({}); } catch (e) { try { v = holder[k](); } catch (e2) { continue; } } }
                const s = (typeof v === 'string') ? v : ((v && (v.path || v.dir || v.dirPath)) || '');
                if (typeof s === 'string' && /^([A-Za-z]:[\\/]|\/|\\\\)/.test(s)) push(s, k, 'host-api');
            }
        }
    } catch (e) { /* 忽略 */ }
    // ③ Android：宿主一般只放行「应用私有目录 / 系统选择器授予的目录」——给两条常见公共位置做建议（需探针实测）
    if (plat.name === 'android') {
        push('/storage/emulated/0/Download/ftt_v2_store', 'Download（公共下载目录 · 需宿主放行）', 'suggested');
        push('/storage/emulated/0/Documents/ftt_v2_store', 'Documents（公共文档目录 · 需宿主放行）', 'suggested');
        notes.push('Android：浏览器文件夹选择器通常不可用；若宿主没有 `dialog` / `path` 接口，请用「系统选择文件夹」或直接填应用私有目录（宿主数据目录内），并点「✅ 校验」实测能否写入。');
    }
    if (!items.some((x) => x.source === 'tauri-path')) notes.push('提示：候选目录只是**建议**，选中后会写一个探针文件并回读校验；校验通过才算可用。');
    return { platform: plat.name, platformSource: plat.source, items: items, notes: notes };
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
                        return { ok: true, mechanism: 'fs-handle', path: '', name: String(h.name || ''), note: '已选中文件夹「' + String(h.name || '') + '」（写探针通过；浏览器只暴露文件夹名、绝对路径不可见，刷新后需重新选择 —— 想跨刷新请填绝对路径或改用系统对话框）', tried: tried };
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
    // ③ 宿主 dev API 的选目录方法
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
        note: '本机（' + localDiskPlatformLabel(plat.name) + '）没有可用的文件夹选择器：' + tried.map((x) => String(x.mechanism) + (x.error ? ('✗' + String(x.error).slice(0, 40)) : '✓')).join(' · ')
            + ' —— 可点「📁 候选目录」选一个宿主给出的目录，或直接手填路径后点「✅ 校验」',
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
        /**
         * v3.30.1（真机报错 `missing file path`）：Tauri v2 `fs` 插件的命令名与参数包装在**宿主之间**并不统一 ——
         *   命令名可能带/不带 `plugin:` 前缀，参数可能直接摊平、也可能包在 `args` 里，`path` 也可能要求
         *   `{ path: { path } }` 这种「scope 对象」形态。逐组合试，一律以「写后回读一致」为成功判据。
         */
        const cmds = ['plugin:fs|write_text_file', 'plugin:fs|write_file', 'fs|write_text_file'];
        const argShapes = [
            { path: path, contents: body },
            { path: path, contents: bytes },
            { path: path, text: body },
            { path: path, data: bytes },
            { args: { path: path, contents: body } },
            { path: { path: path }, contents: body },
        ];
        let lastErr2 = '';
        for (const cmd of cmds) {
            for (const arg of argShapes) {
                try { await inv(cmd, arg); return { ok: true, mechanism: c.mechanism + '/' + cmd }; }
                catch (e) { lastErr2 = String((e && e.message) || e); }
            }
        }
        return { ok: false, reason: 'write-failed', error: lastErr2 };
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
    const dir = localDiskRaw();
    if (!dir && !fsHandle) return { ok: false, error: 'off' };
    try {
        const { splitParts, buildManifest, manifestFileName, shardFileName, scopeSlug } = await import('./local-shards.js');
        const r = splitParts(env);
        if (!r.ok) return { ok: false, error: r.reason || 'no-data' };
        const sub = scopeSlug(scope || r.scope);
        const mf = buildManifest(r.parts, { at: r.at, scope: String(scope || r.scope || '') });
        // ① 浏览器文件夹句柄：建 `<scope>` 子目录后逐文件写
        if (fsHandle && await handleUsable()) {
            try {
                const subDir = await fsHandle.getDirectoryHandle(sub, { create: true });
                const writeInto = async (h, name, text) => {
                    const fh = await h.getFileHandle(name, { create: true });
                    const ws = await fh.createWritable();
                    await ws.write(text); await ws.close();
                };
                for (const k of Object.keys(r.parts)) await writeInto(subDir, shardFileName(k), JSON.stringify(r.parts[k]));
                await writeInto(subDir, manifestFileName(), JSON.stringify(mf));
                stats.writes++;
                return { ok: true, dir: dir + '/' + sub, files: Object.keys(r.parts).length + 1, counts: r.counts };
            } catch (e) { /* 落到宿主机制 */ }
        }
        // ② 宿主文件 API：逐文件写
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
    const dir = localDiskRaw();
    try {
        const { joinParts, verifyParts, manifestFileName, shardFileName, allShardNames, scopeSlug } = await import('./local-shards.js');
        const sub = scopeSlug(scope);
        const readOne = async (name) => {
            if (fsHandle && await handleUsable()) {
                try { const d2 = await fsHandle.getDirectoryHandle(sub); const fh = await d2.getFileHandle(name); const f = await fh.getFile(); return await f.text(); } catch (e) { return null; }
            }
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
    const dir = localDiskRaw();
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
        if (fsHandle && await handleUsable()) {
            try {
                let subDir = await fsHandle.getDirectoryHandle(sub, { create: true });
                subDir = await subDir.getDirectoryHandle(dirName, { create: true });
                const w = async (name, text) => {
                    const short = name.split('/').pop();
                    const fh = await subDir.getFileHandle(short, { create: true });
                    const ws = await fh.createWritable(); await ws.write(text); await ws.close();
                };
                const files = await writePair(w);
                stats.writes++;
                return { ok: true, dir: dir + '/' + sub + '/' + dirName, files: files, count: Number(built.manifest.count || 0) };
            } catch (e) { /* 落到宿主机制 */ }
        }
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
    const dir = localDiskRaw();
    if (!dir && !fsHandle) return { ok: false, error: 'off' };
    try {
        const LP = await import('./local-parts.js');
        const { scopeSlug } = await import('./local-shards.js');
        const sub = scopeSlug(scope);
        const dirName = (what === 'snapshots') ? LP.SNAP_DIR : LP.LOG_DIR;
        const readOne = async (name) => {
            if (fsHandle && await handleUsable()) {
                try {
                    const d2 = await fsHandle.getDirectoryHandle(sub);
                    const d3 = await d2.getDirectoryHandle(dirName);
                    const fh = await d3.getFileHandle(name);
                    const f = await fh.getFile();
                    return await f.text();
                } catch (e) { return null; }
            }
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
    return {
        enabled: !!dir || !!fsHandle, dir: dir || (fsHandle ? String(fsHandle.name || '') : ''), kind: fsHandle ? 'fs-handle' : localDiskPathKind(dir), handle: !!fsHandle,
        // v3.33.0：平台与「路径形态 vs 本机平台」的冲突提示（用户报告「Android 上设不了」的直接可见原因）
        platform: plat.name, platformSource: plat.source, platformLabel: localDiskPlatformLabel(plat.name),
        pathWarn: localDiskPathWarn(dir, plat.name),
        capability: { ok: c.ok, mechanism: c.mechanism, ns: c.ns, writeMethod: c.writeMethod, readMethod: c.readMethod, tauriFs: c.tauriFs, devKeys: c.devKeys, note: c.note },
        invalid: localDiskInvalid(),   // v3.28.1：路径是否已被标记为**无效**（写入失败 / 探针失败）
        stats: Object.assign({}, stats),
    };
}
/** 测试/诊断：重置会话状态 */
export function localDiskReset() {
    caps = null;
    platCache = null;   // v3.33.0：平台缓存也清（测试里会改 UA / 宿主）
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
    localDiskPickDir, localDiskHasHandle, localDiskWriteShards, localDiskReadShards, localDiskWriteParts, localDiskReadParts,
    // v3.33.0：平台识别 / 路径形态冲突提示 / 宿主候选目录（Android 上「怎么设置」的依据）
    localDiskPlatform, localDiskPlatformAsync, localDiskPlatformLabel, localDiskPathWarn, localDiskDirCandidates,
};
