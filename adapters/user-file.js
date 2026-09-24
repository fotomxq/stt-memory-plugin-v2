// ============================================================
// adapters/user-file.js —— 服务端用户目录文件通道（大体积权威数据）
// 事实源：docs/P0-探针报告.md（§1 探针 4：V1 生产已验证 `/api/files/upload` / `/api/files/delete`）
// 约定：文件名 `ftt2-state-<slug>.json`（V2 自有前缀，与 V1 的 `ftt-state-*` 并存不冲突，便于导入器读取 V1 文件）；
//   内容默认为 UTF-8 JSON 文本；开启 `cfg.storage.stateFileGzip` 时写 `.json.gz`（先 gzip 再 base64，见
//   `uploadStateFileGz`；V1 `SLIM_EXT_GZ`(~5448) 同名口径）。**读取一律按内容魔数识别** gzip 与明文
//   （`readStateFileAuto`），故明文旧文件始终可读，两个扩展名可随时切换。
// ============================================================
import { getCtx } from '../host/st-api.js';
import { gzipToBytes, bytesToBase64, decodeBytesAuto, gzipAvailable, isGzipBytes, bytesToText } from './gzip.js';

export const FILE_PREFIX = 'ftt2-state-';
export const FILE_EXT = '.json';
/** gzip 扩展名（V1 `SLIM_EXT_GZ` 同名口径） */
export const FILE_EXT_GZ = '.json.gz';

/** 文件名 slug（V1 口径：只允许 [a-zA-Z0-9_-.]，中文名转短哈希） */
export function slugify(name) {
    const raw = String(name == null ? '' : name).trim();
    if (!raw) return 'default';
    const ascii = raw.replace(/[^A-Za-z0-9_.-]/g, '');
    if (ascii && ascii.length >= 2) return ascii.slice(0, 48);
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'n' + h.toString(36);
}

/** 状态文件名（scope = char:<hash> 或角色标识） */
export function stateFileName(scope) {
    return FILE_PREFIX + slugify(scope) + FILE_EXT;
}

function requestHeaders() {
    const ctx = getCtx();
    try { if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders(); } catch (e) { /* 忽略 */ }
    return { 'Content-Type': 'application/json' };
}

/** UTF-8 文本 → base64（无 TextEncoder/btoa 时返回 ''） */
export function textToBase64(text) {
    try {
        const s = String(text == null ? '' : text);
        if (typeof TextEncoder === 'function' && typeof btoa === 'function') {
            const bytes = new TextEncoder().encode(s);
            let bin = '';
            for (const b of bytes) bin += String.fromCharCode(b);
            return btoa(bin);
        }
        if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    } catch (e) { /* 忽略 */ }
    return '';
}

/** base64 → UTF-8 文本 */
export function base64ToText(b64) {
    try {
        const bin = (typeof atob === 'function') ? atob(String(b64 || '')) : '';
        if (!bin) return '';
        if (typeof TextDecoder === 'function') {
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder().decode(bytes);
        }
        return decodeURIComponent(escape(bin));
    } catch (e) { return ''; }
}

/** 写入服务端文件（POST /api/files/upload {name, data(base64)}） */
export async function uploadStateFile(name, text) {
    const data = textToBase64(text);
    if (!data) return { ok: false, error: 'base64 编码不可用' };
    try {
        const res = await globalThis.fetch('/api/files/upload', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ name: String(name), data }),
        });
        const status = Number(res && res.status) || 0;
        return { ok: status >= 200 && status < 300, status };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 读取服务端文件（GET /api/files/…；失败返回 ok:false） */
export async function readStateFile(name) {
    try {
        const res = await globalThis.fetch('/user/files/' + encodeURIComponent(String(name)), { method: 'GET', headers: requestHeaders() });
        const status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) return { ok: false, status };
        const text = await res.text();
        return { ok: true, text: String(text == null ? '' : text) };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 删除服务端文件（POST /api/files/delete {path}） */
export async function deleteStateFile(name) {
    try {
        const res = await globalThis.fetch('/api/files/delete', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ path: '/user/files/' + String(name) }),
        });
        const status = Number(res && res.status) || 0;
        return { ok: status >= 200 && status < 300, status };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 按字节读取服务端文件（V1 主文件默认是 `.json.gz`，必须取原始字节才能解压）。
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, status?:number, error?:string}>}
 */
export async function readStateFileBytes(name) {
    try {
        const res = await globalThis.fetch('/user/files/' + encodeURIComponent(String(name)), { method: 'GET', headers: requestHeaders() });
        const status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) return { ok: false, status };
        if (res && typeof res.arrayBuffer === 'function') {
            const buf = await res.arrayBuffer();
            return { ok: true, bytes: new Uint8Array(buf), status };
        }
        const text = await res.text();
        return { ok: true, bytes: textToBytes(String(text == null ? '' : text)), status };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * **按内容魔数**读取服务端文件（B9-d）：取原始字节 → `1f 8b` 则 gunzip，否则按 UTF-8 解码。
 * 与扩展名无关 —— 明文旧文件（`.json`）与 gzip 新文件（`.json.gz`）都能读，是「写入侧换 gzip 不破坏旧文件」的关键。
 * 实现说明：明文路径**不追加异步层**（单函数内完成 fetch → arrayBuffer → 文本），
 *   以保证默认（gzip 关）时的微任务步数与 B7-2 的 `readStateFile` 完全一致（不改变既有装配时序）。
 * @returns {Promise<{ok:boolean, text:string, gz:boolean, status?:number, error?:string}>}
 */
export async function readStateFileAuto(name) {
    try {
        const res = await globalThis.fetch('/user/files/' + encodeURIComponent(String(name)), { method: 'GET', headers: requestHeaders() });
        const status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) return { ok: false, text: '', gz: false, status };
        let bytes = null;
        if (res && typeof res.arrayBuffer === 'function') {
            try { bytes = new Uint8Array(await res.arrayBuffer()); } catch (e) { bytes = null; }
        }
        if (!bytes) {                                   // 桩/旧环境无 arrayBuffer → 退回文本（V1 同口径）
            const t0 = await res.text();
            return { ok: true, text: String(t0 == null ? '' : t0), gz: false, status };
        }
        if (!isGzipBytes(bytes)) {                      // 明文：同步解码（零额外 await）
            const t = bytesToText(bytes);
            return t ? { ok: true, text: t, gz: false, status } : { ok: false, text: '', gz: false, status, error: 'decode-failed' };
        }
        const dec = await decodeBytesAuto(bytes);        // gzip：解压（不支持 DecompressionStream 时如实失败）
        if (!dec.ok) return { ok: false, text: '', gz: true, status, error: dec.reason };
        return { ok: true, text: dec.text, gz: true, status };
    } catch (e) {
        return { ok: false, text: '', gz: false, error: String((e && e.message) || e) };
    }
}

/**
 * gzip 写入服务端文件（先 gzip 再 base64；V1 `filesUploadContent`(~5691) 的 V2 等价物）。
 * **不可用即失败**（`{ok:false, reason:'no-gzip'}`）—— 由调用方回退明文，绝不写坏文件。
 */
export async function uploadStateFileGz(name, text) {
    try {
        if (!gzipAvailable()) return { ok: false, gz: false, reason: 'no-gzip' };
        const bytes = await gzipToBytes(text);
        if (!bytes || !bytes.length || !isGzipBytes(bytes)) return { ok: false, gz: false, reason: 'gzip-failed' };
        const data = bytesToBase64(bytes);
        if (!data) return { ok: false, gz: false, reason: 'base64-failed' };
        const res = await globalThis.fetch('/api/files/upload', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ name: String(name), data }),
        });
        const status = Number(res && res.status) || 0;
        return { ok: status >= 200 && status < 300, gz: true, status, bytes: bytes.length };
    } catch (e) {
        return { ok: false, gz: false, reason: String((e && e.message) || e) };
    }
}

export { isGzipBytes, bytesToText, gzipAvailable };

/** 文本 → 字节（无 TextEncoder 时按 UTF-8 手工编码） */
function textToBytes(text) {
    try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    } catch (e) { /* 落到手工编码 */ }
    const out = [];
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return new Uint8Array(out);
}
