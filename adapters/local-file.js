// ============================================================
// adapters/local-file.js —— **本地文件存储模式**（v3.16.0，用户要求）
//
// 用户原话：「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，避免超出限制。
//   但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式。」
//
// 语义（哪一层被替代）：插件的「本机缓冲」原本写在**浏览器本地变量**（`localStorage`，键 `ftt2_state_<角色>`），
//   并因此受本地化配额限制 —— 真机上「信封超过 1.8M 字符 → 本机缓冲**静默停更**」正是这个限制的后果。
//   本模式把该层换成**宿主的本地文件**：不受 localStorage 配额约束，用户可在文件系统里看到/备份，
//   TauriTavern 的官方同步（TT-Sync）也会带上它（扩展存储目录是其默认数据集）。
//
// 路径约定（`cfg.storage.localFilePath`，**留空 = 不开启**；这是用户唯一开关）：
//   · 只接受**宿主数据目录之内**的相对目录名 —— 浏览器与宿主都不允许扩展写到数据目录之外，
//     故盘符（`D:\…`）与前导 `/` 会被剥掉，`..` 段会被丢弃，非法字符替换为 `_`；
//   · TauriTavern：映射为**扩展存储的命名空间** → 真实目录 `data_root/_tauritavern/extension-store/<命名空间>/kv/local/`
//     （`table='local'`，每个角色一个文件）；
//   · 网页版酒馆：映射为用户目录里的子路径 `user/files/<路径>/ftt2-local-<角色>.json`
//     （若宿主不接受子目录 → 自动退化为同级平铺名 `<路径>-ftt2-local-<角色>.json`）。
//
// v3.26.0（用户要求）：
//   ① 「除了保留当前的 input，还需增加选择目录，可手动选择目录」→ 本模块提供**目录候选 / 用过的目录 /
//      目录探针（写→回读→删除，证明可写）/ 真实落盘位置**，UI 侧是设定-存储的目录选择器；
//   ② 「如果设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储」
//      → 目录模式下 `adapters/store.js` 的**变量层与内存库都不写**（读路径也不读）；
//   ③ 命名空间**碰撞修复**：非 ASCII 目录名归一后会补一个**路径短哈希**（否则「记忆缓冲」与「剧情缓冲」
//      都会变成 `____` → 两个目录写进同一命名空间互相覆盖）；旧命名空间仍可只读命中（`localFileNsLegacy`）。
//
// 纪律：
//   · **留空即完全不动作**（不写、不读、不改任何行为）—— 用户明确要求「没约定路径则视为不开启」；
//   · 目录模式开启后**变量层与内存库都不再被写入或读取**，并把已有内容**迁移**进目录
//     （迁移在写入校验通过后才清两层，避免任何数据丢失；迁移结果与失败原因都如实回报）；
//   · 关闭（清空路径）时把目录内容**迁回两层**（仅当两层为空时），目录文件保留不删（当备份）。
// ============================================================
import { cfg, dbgLog } from '../core/model/runtime.js';
import { fileTransportUploadText, fileTransportReadAuto, fileTransportDelete, fileTransportBackend } from './file-transport.js';
import { ttNativeOn, ttNativeActive, ttDirListCapability, ttListNamespaces } from './tt-store.js';
// v3.26.0：目录选择器把「用过的目录」写回配置（变量层停用后，候选清单不能依赖 localStorage）
import { saveKernelCfg } from './config-store.js';

/** 生效的本地文件目录（原始输入；`''` = 不开启） */
export function localFileRawPath() {
    try { return String((cfg && cfg.storage && cfg.storage.localFilePath) || '').trim(); } catch (e) { return ''; }
}

/**
 * 路径归一：只保留**宿主数据目录内的相对目录名**。
 *   `D:\FTT\data` → `FTT/data` ｜ `/abs/ftt` → `abs/ftt` ｜ `../x` → `x` ｜ `我的 数据` → `我的_数据`
 * @returns {string} 归一后的相对路径（可能为空 = 不开启）
 */
export function localFilePathSanitize(raw) {
    try {
        let s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
        s = s.replace(/^[A-Za-z]:/, '');                                     // 剥盘符（数据目录之外一律不可写）
        const segs = s.split('/')
            .map((x) => x.trim())
            .filter((x) => x && x !== '.' && x !== '..')                     // 丢空段与上跳段
            .map((x) => x.replace(/[^A-Za-z0-9_.\u4e00-\u9fa5-]/g, '_'));    // 非法字符（含空格）转下划线
        return segs.join('/');
    } catch (e) { return ''; }
}

/** 归一后的生效路径（`''` = 不开启）；`override` = 显式路径（关闭模式后按「上次路径」迁回时用） */
export function localFilePath(override) {
    const raw = (override === undefined || override === null) ? localFileRawPath() : override;
    const p = localFilePathSanitize(raw);
    return p;
}

/** 是否开启本地文件模式（**唯一判据**：路径非空且归一后仍非空） */
export function localFileEnable() { return !!localFilePathSanitize(localFileRawPath()); }
/** 别名（语义更直白） */
export function localFileEnabled() { return localFileEnable(); }

/** 角色作用域 → 文件名安全的短标识 */
function scopeSlug(scope) {
    const s = String(scope == null ? '' : scope);
    const safe = s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
    return safe || 'default';
}

/** 酒馆文件通道的文件名（含约定目录；子目录不被接受时用 `stFlatName` 兜底） */
export function localFileName(scope, override) {
    const p = localFilePath(override);
    return (p ? (p + '/') : '') + 'ftt2-local-' + scopeSlug(scope) + '.json';
}
/** 平铺兜底文件名（宿主不接受子目录时用） */
export function localFileFlatName(scope, override) {
    const p = localFilePath(override).replace(/\//g, '-');
    return (p ? (p + '-') : '') + 'ftt2-local-' + scopeSlug(scope) + '.json';
}
/** 稳定短哈希（FNV-1a 32 位 → 6 位 36 进制；无依赖、跨会话稳定，用于命名空间去重） */
function shortHash(s) {
    let h = 0x811c9dc5;
    const t = String(s == null ? '' : s);
    for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36).slice(-6);
}

/**
 * 原生通道的命名空间（TauriTavern：真实目录名；多层路径折叠为单段）。
 * v3.26.0（用户要求「可手动选择目录」后的**碰撞修复**）：命名空间只允许 `[A-Za-z0-9_.-]`，
 *   归一**丢过信息**时补一个**路径短哈希** —— 否则「记忆缓冲」与「剧情缓冲」会双双变成 `____`，
 *   两个不同目录写进**同一个命名空间**（互相覆盖）。旧版本（v3.16.0~v3.25.x）写下的无哈希命名空间
 *   仍可**只读**命中，见 `localFileNsLegacy`。
 */
export function localFileNs(override) {
    const p = localFilePath(override);
    if (!p) return '';
    const raw = p.replace(/\//g, '.');
    const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (safe === raw && safe) return safe;
    const base = safe.replace(/_+$/, '');
    return (base || 'ftt2-local') + '-' + shortHash(raw);
}

/**
 * v3.26.0：**旧命名空间**（只读兼容）—— v3.16.0~v3.25.x 的映射（非法字符一律转 `_`、无哈希）。
 * 仅在「与现行命名空间不同」时才多读一次：老用户已经写在里面的本机缓冲不会被判为丢失。
 */
export function localFileNsLegacy(override) {
    const p = localFilePath(override);
    if (!p) return '';
    return p.replace(/\//g, '.').replace(/[^A-Za-z0-9_.-]/g, '_') || 'ftt2-local';
}

/** 运行统计（诊断 / 面板 / 调试包） */
const localFileStats = { writes: 0, reads: 0, misses: 0, failures: 0, migrated: 0, restored: 0, probes: 0, lastReason: '', lastBytes: 0, lastAt: 0, backend: '' };
export function localFileStatsGet() {
    return Object.assign({
        enabled: localFileEnable(), raw: localFileRawPath(), path: localFilePath(),
        name: localFileName(''), ns: localFileNs(), backend: localFileBackend(),
    }, localFileStats);
}
/** 重置统计（测试 / 诊断） */
export function localFileStatsReset() {
    localFileStats.writes = 0; localFileStats.reads = 0; localFileStats.misses = 0; localFileStats.failures = 0;
    localFileStats.migrated = 0; localFileStats.restored = 0; localFileStats.probes = 0; localFileStats.lastReason = ''; localFileStats.lastBytes = 0; localFileStats.lastAt = 0;
    return true;
}
function localFileBackend() { try { return fileTransportBackend(); } catch (e) { return ''; } }

/** 传输参数：原生走自定义命名空间；酒馆文件通道走「目录 + 文件名」 */
function localFileOpts(scope, override) {
    const o = { ns: localFileNs(override), table: 'local', stName: localFileName(scope, override) };
    return o;
}

/**
 * 写本地文件（信封文本）。
 * @param {string} text 信封文本
 * @param {string} scope 角色作用域
 * @param {string} [override] 显式路径（缺省用配置里的路径）
 * @returns {Promise<{ok:boolean, backend?:string, bytes?:number, error?:string}>}
 */
export async function localFileWrite(text, scope, override) {
    const path = localFilePath(override);
    if (!path) return { ok: false, reason: 'off' };
    const body = String(text == null ? '' : text);
    const o = localFileOpts(scope, override);
    try {
        let r = await fileTransportUploadText(localFileName(scope, override), body, o);
        if ((!r || !r.ok) && ttNativeActive()) {
            // 原生写入失败（例如命名空间非法）→ 用平铺名再试一次（不改变语义，只是换个键名）
            r = await fileTransportUploadText(localFileFlatName(scope, override), body,
                Object.assign({}, o, { ns: undefined, stName: localFileFlatName(scope, override) }));
        }
        if (r && r.ok) {
            localFileStats.writes += 1;
            localFileStats.lastBytes = body.length;
            localFileStats.lastAt = Date.now();
            localFileStats.lastReason = '';
            return { ok: true, backend: String(r.backend || ''), bytes: body.length, path: path };
        }
        localFileStats.failures += 1;
        localFileStats.lastReason = String((r && (r.error || r.reason)) || 'write-failed');
        return { ok: false, error: localFileStats.lastReason };
    } catch (e) {
        localFileStats.failures += 1;
        localFileStats.lastReason = String((e && e.message) || e);
        return { ok: false, error: localFileStats.lastReason };
    }
}

/**
 * 读本地文件（信封文本）。
 * @param {string} scope 角色作用域
 * @param {string} [override] 显式路径（关闭模式后按「上次路径」迁回时用）
 * @returns {Promise<{ok:boolean, text?:string, miss?:boolean, error?:string}>}
 */
export async function localFileRead(scope, override) {
    const path = localFilePath(override);
    if (!path) return { ok: false, reason: 'off' };
    const o = localFileOpts(scope, override);
    try {
        const r = await fileTransportReadAuto(localFileName(scope, override), o);
        if (r && r.ok && r.text) {
            localFileStats.reads += 1;
            localFileStats.lastBytes = String(r.text).length;
            localFileStats.lastAt = Date.now();
            return { ok: true, text: String(r.text), backend: String(r.backend || ''), path: path };
        }
        // 主名未命中 → 试平铺兜底名（可能上次是用它写成功的）
        const r2 = await fileTransportReadAuto(localFileFlatName(scope, override), Object.assign({}, o, { ns: undefined, stName: localFileFlatName(scope, override) }));
        if (r2 && r2.ok && r2.text) {
            localFileStats.reads += 1;
            localFileStats.lastBytes = String(r2.text).length;
            localFileStats.lastAt = Date.now();
            return { ok: true, text: String(r2.text), backend: String(r2.backend || ''), flat: true, path: path };
        }
        // v3.26.0：**旧命名空间只读兼容** —— v3.16.0~v3.25.x 把非 ASCII 目录名一律映射成 `_`（无哈希），
        //   升级后命名空间会带哈希 → 老数据若只按新命名空间找会被判为「本机层没数据」。此处补一次只读回退。
        const legacyNs = localFileNsLegacy(override);
        if (legacyNs && legacyNs !== o.ns) {
            const o2 = { ns: legacyNs, table: 'local', stName: localFileName(scope, override) };
            const r3 = await fileTransportReadAuto(localFileName(scope, override), o2);
            if (r3 && r3.ok && r3.text) {
                localFileStats.reads += 1;
                localFileStats.lastBytes = String(r3.text).length;
                localFileStats.lastAt = Date.now();
                try { dbgLog('存储', { action: '本地目录：命中旧命名空间（只读兼容）', ns: legacyNs, path: path }); } catch (e) { /* 忽略 */ }
                return { ok: true, text: String(r3.text), backend: String(r3.backend || ''), legacyNs: true, path: path };
            }
        }
        localFileStats.misses += 1;
        return { ok: false, miss: true, error: String((r2 && r2.error) || (r && r.error) || 'miss') };
    } catch (e) {
        localFileStats.failures += 1;
        localFileStats.lastReason = String((e && e.message) || e);
        return { ok: false, error: localFileStats.lastReason };
    }
}

/** 删除本地文件（两种命名都删；缺失按成功处理）；`override` = 显式路径（探针 / 迁移用） */
export async function localFileDelete(scope, override) {
    if (!localFilePath(override)) return { ok: false, reason: 'off' };
    const out = { ok: true, deleted: 0 };
    const ns = localFileNs(override);
    const nsLegacy = localFileNsLegacy(override);
    const tries = [[localFileName(scope, override), ns], [localFileFlatName(scope, override), undefined]];
    // v3.26.0：旧命名空间也删（否则「删了又被旧命名空间唤醒」）
    if (nsLegacy && nsLegacy !== ns) tries.push([localFileName(scope, override), nsLegacy]);
    for (const [nm, useNs] of tries) {
        try {
            const r = await fileTransportDelete(nm, useNs ? { ns: useNs, table: 'local' } : {});
            if (r && r.ok) out.deleted += 1;
        } catch (e) { /* 忽略 */ }
    }
    return out;
}

// ==================== v3.26.0（用户要求「增加选择目录，可手动选择目录」） ====================
/**
 * 用户原话：「设置本机缓冲时，除了保留当前的 input，还需增加选择目录，可手动选择目录。」
 *
 * 硬事实（决定「选择目录」能长成什么样）：**扩展只能写到宿主数据目录之内** ——
 *   `api.extension.store` 的命名空间只允许 `[A-Za-z0-9_.-]`（盘符与绝对路径根本传不进去），
 *   酒馆文件通道也只在 `user/files/` 之下。因此本模块给出的「目录」= 数据目录内的**相对目录名**，
 *   选择器**如实告知真实落盘位置**，绝不假装能选任意磁盘路径。
 *
 * 候选来源（三条，互不依赖）：
 *   ① **预设**：插件自己的存储命名空间（与记忆文件同域，官方同步默认带上）；
 *   ② **用过的目录**：写进**配置** `cfg.storage.localFileDirs`（不是 localStorage ——
 *      本机缓冲改走目录后变量层整体停用，候选清单不能反过来依赖它）；
 *   ③ **宿主枚举**：宿主 store 若提供命名空间列举能力则一并列出（无此能力时如实显示「宿主不支持」）。
 */

/** 用过的目录清单上限 */
export const LOCAL_DIR_HISTORY_MAX = 8;
/** 目录探针用的文件名（写→回读→删除，用来证明「这个目录真的可写」） */
export const LOCAL_PROBE_NAME = 'ftt2-local-probe.json';

/** 预设候选目录（`path` = 数据目录内的相对路径） */
export const LOCAL_DIR_PRESETS = Object.freeze([
    { path: 'ftt2-files', label: '插件存储目录（推荐）', note: '与记忆文件同一命名空间；官方同步默认带上' },
    { path: 'ftt2-local', label: '插件缓冲目录', note: '独立目录，便于单独备份本机缓冲' },
]);

/** 用过的目录清单（归一后、去重、最近在前） */
export function localFileDirHistory() {
    try {
        const arr = (cfg && cfg.storage && cfg.storage.localFileDirs) || [];
        const out = [];
        for (const x of (Array.isArray(arr) ? arr : [])) {
            const p = localFilePathSanitize(x);
            if (p && out.indexOf(p) < 0) out.push(p);
        }
        return out.slice(0, LOCAL_DIR_HISTORY_MAX);
    } catch (e) { return []; }
}

/** 记住一个用过的目录（去重 + 最近在前 + 上限截断；写回 ST 配置） */
export function localFileDirRemember(raw) {
    const p = localFilePathSanitize(raw);
    if (!p) return { ok: false, reason: 'empty', list: localFileDirHistory() };
    try {
        const list = [p].concat(localFileDirHistory().filter((x) => x !== p)).slice(0, LOCAL_DIR_HISTORY_MAX);
        cfg.storage = Object.assign({}, cfg.storage || {});
        cfg.storage.localFileDirs = list;
        try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
        return { ok: true, path: p, list: list };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e), list: localFileDirHistory() }; }
}

/** 宿主目录枚举能力（同步探测；无能力时 `supported:false`，UI 据此**不渲染**无效按钮） */
export function localFileDirHostCapability() {
    try { return ttDirListCapability(); } catch (e) { return { supported: false, api: '' }; }
}

/**
 * 目录候选清单（同步：预设 + 用过的目录；宿主枚举见 `localFileDirScanHost`）。
 * @returns {{current:string, items:Array<{path:string,label:string,source:string,note:string,current:boolean}>, host:{supported:boolean,api:string}}}
 */
export function localFileDirCandidates() {
    const cur = localFilePath();
    const items = [];
    const add = (path, label, source, note) => {
        const p = localFilePathSanitize(path);
        if (!p || items.some((x) => x.path === p)) return;
        items.push({ path: p, label: String(label || p), source: String(source || ''), note: String(note || ''), current: p === cur });
    };
    for (const d of LOCAL_DIR_PRESETS) add(d.path, d.label, 'preset', d.note);
    for (const p of localFileDirHistory()) add(p, p, 'history', '最近使用过');
    return { current: cur, items: items, host: localFileDirHostCapability() };
}

/** 枚举宿主已有目录（异步；宿主不支持时返回空并带原因，绝不假装有枚举能力） */
export async function localFileDirScanHost() {
    try {
        const cap = localFileDirHostCapability();
        if (!cap.supported) return { ok: false, dirs: [], reason: 'no-api', note: '宿主未提供目录枚举能力' };
        const r = await ttListNamespaces();
        const dirs = (r && Array.isArray(r.dirs) ? r.dirs : []).map((x) => localFilePathSanitize(x)).filter(Boolean);
        return { ok: !!(r && r.ok), dirs: dirs, reason: String((r && r.reason) || ''), note: dirs.length ? ('宿主目录 ' + dirs.length + ' 个') : '宿主目录为空' };
    } catch (e) { return { ok: false, dirs: [], reason: String((e && e.message) || e) }; }
}

/**
 * 目录探针：**写一个探针文件 → 回读逐字节校验 → 删除**（证明该目录真的存在且可写）。
 * 与正式缓冲文件互不干扰（独立文件名 + `probe` 作用域）。
 * @returns {Promise<{ok:boolean, path:string, ns:string, name:string, backend:string, error?:string}>}
 */
export async function localFileProbeDir(rawPath) {
    const path = localFilePathSanitize(rawPath);
    const out = { ok: false, path: path, ns: '', name: '', backend: localFileBackend(), error: '' };
    if (!path) { out.error = 'empty'; return out; }
    const body = JSON.stringify({ probe: 1, at: Date.now(), dir: path });
    const base = { ns: localFileNs(path), table: 'local' };
    let name = localFileName('probe', path);
    let opts = Object.assign({}, base, { stName: name });
    out.ns = base.ns; out.name = name;
    const drop = async () => {
        try { await fileTransportDelete(name, opts); } catch (e) { /* 忽略 */ }
    };
    try {
        let w = await fileTransportUploadText(name, body, opts);
        if ((!w || !w.ok) && ttNativeActive()) {
            // 命名空间被拒（非法字符等）→ 平铺名再试一次（与 `localFileWrite` 同一口径）
            const flat = localFileFlatName('probe', path);
            const o2 = { table: 'local', stName: flat };
            const w2 = await fileTransportUploadText(flat, body, o2);
            if (w2 && w2.ok) { name = flat; opts = o2; out.name = flat; w = w2; }
        }
        if (!w || !w.ok) { out.error = String((w && (w.error || w.reason)) || 'write-failed'); return out; }
        const r = await fileTransportReadAuto(name, Object.assign({}, opts, { stName: name }));
        if (!r || !r.ok || String(r.text) !== body) {
            out.error = 'verify-failed';
            await drop();
            return out;
        }
        out.ok = true;
        out.backend = String(w.backend || out.backend || '');
        await drop();
        localFileStats.probes += 1;
        localFileStats.lastAt = Date.now();
        return out;
    } catch (e) {
        await drop();
        out.error = String((e && e.message) || e);
        return out;
    }
}

/**
 * 「这个目录最终落在磁盘哪里」的**如实**说明（面板显示用；不猜、不美化）。
 * @returns {{known:boolean, backend:string, text:string}}
 */
export function localFileRealLocation(rawPath) {
    const path = localFilePathSanitize(rawPath);
    if (!path) return { known: true, backend: '', text: '未开启：本机缓冲仍写浏览器变量与内存库' };
    const backend = localFileBackend();
    const file = 'ftt2-local-＜角色＞.json';
    if (backend === 'tt-native') {
        return { known: true, backend: backend, text: '数据目录内：_tauritavern/extension-store/' + localFileNs(path) + '/kv/local/' + file };
    }
    return { known: true, backend: backend, text: '用户目录内：user/files/' + path + '/' + file };
}

export { localFileStats };
export default {
    localFileEnable, localFileEnabled, localFileRawPath, localFilePath, localFilePathSanitize,
    localFileName, localFileFlatName, localFileNs, localFileNsLegacy, localFileWrite, localFileRead, localFileDelete,
    localFileStatsGet, localFileStatsReset,
    localFileDirCandidates, localFileDirHistory, localFileDirRemember, localFileDirScanHost,
    localFileProbeDir, localFileRealLocation, localFileDirHostCapability,
};
