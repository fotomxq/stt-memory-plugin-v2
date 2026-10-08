// ============================================================
// adapters/browser-fs.js —— **浏览器内置目录**（OPFS：Origin Private File System）
//
// v3.38.0（用户报告）：「手机端必须使用内置路径，而跑到 PC 端，又不可用了。根据通知推测，可能你把服务端的方法，
//   用在了前端中？请核对原因，修复『本地存储路径』设定到本地时，应该通过浏览器方法去构建相关文件。」
//   核对结论：v3.28~v3.37 的「本地存储路径」只有**宿主**机制（TauriTavern 的 `plugin:fs|*` / `api.dev`）
//   与**本会话**的文件夹句柄（File System Access，刷新即失效）。纯浏览器（PC 上的酒馆网页版 / Firefox）
//   两者都没有 → `localDiskCapability().ok === false`，而 `localDiskOn()` 仍为 true →
//   每次读写都失败、回退浏览器本地存储并弹告警：**设置看起来生效了，实际不可用**。
//   本模块补上**纯浏览器**的文件后端：OPFS 是浏览器自带的、按源沙箱化的文件系统
//   （`navigator.storage.getDirectory()`），桌面与移动 Chromium / WebView 都支持 —— 不需要任何宿主接口。
//
// 纪律：
//   · 不抛错（全部返回 `{ok:false, error}`），失败由上层**如实回报**；
//   · 路径按 `/` 分段，逐段建目录（`getDirectoryHandle(..., {create:true})`）；
//   · 绝不接受 `..` / 绝对路径（只写本源自有目录内的子路径）；
//   · 与宿主机制同纪律：任何一次写入都由调用方**回读校验**（`local-disk.js#localDiskWrite` 已如此）。
// ============================================================

/** 探测结果缓存（每次会话；`browserFsReset()` 可清） */
let probe = null;

/** OPFS 是否可用（只读探测，不写任何东西） */
export function browserFsAvailable() {
    if (probe) return !!probe.ok;
    const out = { ok: false, error: '', note: '' };
    try {
        const st = globalThis.navigator && globalThis.navigator.storage;
        if (st && typeof st.getDirectory === 'function') { out.ok = true; out.note = '浏览器内置目录（OPFS：navigator.storage.getDirectory）'; }
        else out.error = 'no-opfs';
    } catch (e) { out.error = String((e && e.message) || e); }
    probe = out;
    return out.ok;
}
/** 能力说明（诊断 / UI 用） */
export function browserFsNote() {
    try {
        const st = globalThis.navigator && globalThis.navigator.storage;
        if (st && typeof st.getDirectory === 'function') return '浏览器内置目录（OPFS：navigator.storage.getDirectory）';
        if (st) return '浏览器不支持内置目录（navigator.storage.getDirectory 缺失）';
        return '浏览器不支持内置目录（无 navigator.storage）';
    } catch (e) { return '浏览器内置目录不可用：' + String((e && e.message) || e); }
}
/** 清缓存（测试 / 换环境） */
export function browserFsReset() { probe = null; return true; }

/** 相对路径 → 安全分段（丢掉空段 / `.` / `..` / 盘符与绝对前缀） */
function safeParts(rel) {
    return String(rel == null ? '' : rel)
        .replace(/^@browser\//, '')
        .split(/[\\/]+/)
        .map((x) => x.trim())
        .filter((x) => x && x !== '.' && x !== '..' && !/^[A-Za-z]:$/.test(x));
}
/** 逐段解析（`create` = 缺目录时建） */
async function resolveHandle(rel, create) {
    const st = globalThis.navigator.storage;
    let h = await st.getDirectory();
    for (const p of safeParts(rel)) h = await h.getDirectoryHandle(p, { create: !!create });
    return h;
}
/** 父目录 + 末段名 */
async function resolveParent(rel, create) {
    const parts = safeParts(rel);
    if (!parts.length) throw new Error('empty-path');
    const name = parts.pop();
    const st = globalThis.navigator.storage;
    let h = await st.getDirectory();
    for (const p of parts) h = await h.getDirectoryHandle(p, { create: !!create });
    return { dir: h, name: name };
}

/**
 * 写文本到浏览器内置目录（缺目录自动建）。
 * @param {string} rel 相对路径（可含 `/` 子目录）
 * @returns {Promise<{ok:boolean, path:string, bytes:number, error?:string}>}
 */
export async function browserFsWrite(rel, text) {
    const body = String(text == null ? '' : text);
    try {
        if (!browserFsAvailable()) return { ok: false, path: String(rel || ''), bytes: 0, error: 'no-opfs' };
        const { dir, name } = await resolveParent(rel, true);
        const fh = await dir.getFileHandle(name, { create: true });
        const ws = await fh.createWritable();
        await ws.write(body);
        await ws.close();
        return { ok: true, path: safeParts(rel).join('/'), bytes: body.length };
    } catch (e) { return { ok: false, path: String(rel || ''), bytes: 0, error: String((e && e.message) || e) }; }
}

/** 读文本（不存在 → `miss:true`） */
export async function browserFsRead(rel) {
    try {
        if (!browserFsAvailable()) return { ok: false, miss: true, error: 'no-opfs' };
        const { dir, name } = await resolveParent(rel, false);
        const fh = await dir.getFileHandle(name);
        const f = await fh.getFile();
        return { ok: true, path: safeParts(rel).join('/'), text: await f.text() };
    } catch (e) { return { ok: false, miss: true, error: String((e && e.message) || e) }; }
}

/** 存在性（`getFileHandle` 不带 create 成功即存在） */
export async function browserFsExists(rel) {
    try {
        if (!browserFsAvailable()) return false;
        const { dir, name } = await resolveParent(rel, false);
        await dir.getFileHandle(name);
        return true;
    } catch (e) { return false; }
}

/** 删一个文件（只由调用方清理自己写下的探针 / 过期文件） */
export async function browserFsRemove(rel) {
    try {
        if (!browserFsAvailable()) return { ok: false, error: 'no-opfs' };
        const { dir, name } = await resolveParent(rel, false);
        await dir.removeEntry(name);
        return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 列目录（只列一层；不存在 → 空） */
export async function browserFsList(rel) {
    const out = { ok: false, entries: [], error: '' };
    try {
        if (!browserFsAvailable()) { out.error = 'no-opfs'; return out; }
        const h = await resolveHandle(rel, false);
        for await (const ent of h.entries()) {
            const nm = Array.isArray(ent) ? ent[0] : (ent && ent.name);
            const hh = Array.isArray(ent) ? ent[1] : ent;
            let size = 0;
            try { if (hh && hh.kind === 'file' && typeof hh.getFile === 'function') size = Number((await hh.getFile()).size || 0); } catch (e) { /* 大小拿不到就 0 */ }
            out.entries.push({ name: String(nm || ''), isFile: !(hh && hh.kind === 'directory'), size: size });
        }
        out.ok = true;
        return out;
    } catch (e) { out.error = String((e && e.message) || e); return out; }
}

/**
 * 写探针：写 → 回读逐字节比对 → 删掉自己的探针文件（证明「这个目录真的能写」，与宿主机制同纪律）。
 * @param {string} relDir 目录（相对浏览器内置目录根）
 * @returns {Promise<{ok:boolean, path:string, error?:string, mechanism:string}>}
 */
export async function browserFsProbe(relDir) {
    const dirRel = safeParts(relDir).join('/');
    const name = (dirRel ? (dirRel + '/') : '') + 'ftt2-local-probe.json';
    const body = JSON.stringify({ probe: 1, at: Date.now(), backend: 'browser-opfs' });
    try {
        const w = await browserFsWrite(name, body);
        if (!w.ok) return { ok: false, path: name, error: String(w.error || 'write-failed'), mechanism: 'browser-opfs' };
        const r = await browserFsRead(name);
        if (!r.ok || String(r.text) !== body) return { ok: false, path: name, error: 'verify-failed', mechanism: 'browser-opfs' };
        if (await browserFsExists(name)) await browserFsRemove(name);
        return { ok: true, path: name, mechanism: 'browser-opfs' };
    } catch (e) { return { ok: false, path: name, error: String((e && e.message) || e), mechanism: 'browser-opfs' }; }
}

export default {
    browserFsAvailable, browserFsNote, browserFsReset,
    browserFsWrite, browserFsRead, browserFsExists, browserFsRemove, browserFsList, browserFsProbe,
};
