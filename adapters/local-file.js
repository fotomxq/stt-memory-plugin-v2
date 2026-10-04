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
//   · TauriTavern：映射为**扩展存储的命名空间** → 真实目录 `data_root/_tauritavern/extension-store/<路径>/…`
//     （`table='local'`，每个角色一个文件）；
//   · 网页版酒馆：映射为用户目录里的子路径 `user/files/<路径>/ftt2-local-<角色>.json`
//     （若宿主不接受子目录 → 自动退化为同级平铺名 `<路径>-ftt2-local-<角色>.json`）。
//
// 纪律：
//   · **留空即完全不动作**（不写、不读、不改任何行为）—— 用户明确要求「没约定路径则视为不开启」；
//   · 开启后 localStorage 层**停止写入**（`adapters/store.js` 走本模块），并把已有变量层**迁移**进文件
//     （迁移在写入校验通过后才清变量，避免任何数据丢失；迁移结果与失败原因都如实回报）；
//   · 关闭（清空路径）时把文件内容**迁回变量层**（仅当变量层为空时），文件保留不删（当备份）。
// ============================================================
import { cfg, dbgLog } from '../core/model/runtime.js';
import { fileTransportUploadText, fileTransportReadAuto, fileTransportDelete, fileTransportBackend } from './file-transport.js';
import { ttNativeOn, ttNativeActive } from './tt-store.js';

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
/** 原生通道的命名空间（TauriTavern：真实目录名；多层路径折叠为单段） */
export function localFileNs(override) {
    const p = localFilePath(override);
    return p ? (p.replace(/\//g, '.').replace(/[^A-Za-z0-9_.-]/g, '_') || 'ftt2-local') : '';
}

/** 运行统计（诊断 / 面板 / 调试包） */
const localFileStats = { writes: 0, reads: 0, misses: 0, failures: 0, migrated: 0, restored: 0, lastReason: '', lastBytes: 0, lastAt: 0, backend: '' };
export function localFileStatsGet() {
    return Object.assign({
        enabled: localFileEnable(), raw: localFileRawPath(), path: localFilePath(),
        name: localFileName(''), ns: localFileNs(), backend: localFileBackend(),
    }, localFileStats);
}
/** 重置统计（测试 / 诊断） */
export function localFileStatsReset() {
    localFileStats.writes = 0; localFileStats.reads = 0; localFileStats.misses = 0; localFileStats.failures = 0;
    localFileStats.migrated = 0; localFileStats.restored = 0; localFileStats.lastReason = ''; localFileStats.lastBytes = 0; localFileStats.lastAt = 0;
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
        localFileStats.misses += 1;
        return { ok: false, miss: true, error: String((r2 && r2.error) || (r && r.error) || 'miss') };
    } catch (e) {
        localFileStats.failures += 1;
        localFileStats.lastReason = String((e && e.message) || e);
        return { ok: false, error: localFileStats.lastReason };
    }
}

/** 删除本地文件（两种命名都删；缺失按成功处理） */
export async function localFileDelete(scope) {
    if (!localFileEnable()) return { ok: false, reason: 'off' };
    const out = { ok: true, deleted: 0 };
    for (const [nm, ns] of [[localFileName(scope), localFileNs()], [localFileFlatName(scope), undefined]]) {
        try {
            const r = await fileTransportDelete(nm, ns ? { ns: ns, table: 'local' } : {});
            if (r && r.ok) out.deleted += 1;
        } catch (e) { /* 忽略 */ }
    }
    return out;
}

export { localFileStats };
export default {
    localFileEnable, localFileEnabled, localFileRawPath, localFilePath, localFilePathSanitize,
    localFileName, localFileFlatName, localFileNs, localFileWrite, localFileRead, localFileDelete,
    localFileStatsGet, localFileStatsReset,
};
