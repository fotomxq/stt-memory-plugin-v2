// ============================================================
// adapters/user-file.js —— 服务端用户目录文件通道（大体积权威数据）
// 事实源：docs/history/P0-探针报告.md（§1 探针 4：V1 生产已验证 `/api/files/upload` / `/api/files/delete`）
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

/**
 * v3.0.14（用户报告「保存记忆文件会执行超长时间，管线状态看到 2.6 万秒」）——**服务端文件请求的超时**。
 *   此前所有 `/api/files/*` 与 `/user/files/*` 的 `fetch` 都**没有超时**：宿主/服务端一处挂住
 *   （网络半开、反向代理不返回、ST 进程忙），这个 Promise 就永远不 settle →
 *   「保存记忆文件」那一行永远不结束、UI 的「已用时」无上限增长。现在统一带看门狗。
 */
export const USER_FILE_TIMEOUT_MS = 30000;

/** 超时的**有效值**（调用方可经 `opts.timeoutMs` 覆盖；下限 1ms 便于单测） */
function effTimeout(timeoutMs) { return Math.max(1, Number(timeoutMs) || USER_FILE_TIMEOUT_MS); }

/** 带超时的 fetch（无 `AbortController` 的环境退化为普通 fetch，绝不因为缺能力而抛错） */
async function fetchWithTimeout(url, opts, timeoutMs) {
    const ms = effTimeout(timeoutMs);
    const AC = globalThis.AbortController;
    if (typeof AC !== 'function' || typeof globalThis.fetch !== 'function') return await globalThis.fetch(url, opts);
    const ac = new AC();
    let aborted = false;
    const timer = setTimeout(() => { aborted = true; try { ac.abort(); } catch (e) { /* 忽略 */ } }, ms);
    try {
        return await globalThis.fetch(url, Object.assign({}, opts || {}, { signal: ac.signal }));
    } catch (e) {
        if (aborted) { const err = new Error('timeout(' + ms + 'ms)'); err.name = 'TimeoutError'; throw err; }
        throw e;
    } finally {
        try { clearTimeout(timer); } catch (e) { /* 忽略 */ }
    }
}
/** 统一的请求异常文案（超时给可读原因，其余沿用宿主消息） */
function fetchErrText(e) {
    if (String((e && e.name) || '') === 'TimeoutError') return String(e.message || ('timeout(' + USER_FILE_TIMEOUT_MS + 'ms)'));
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || e || '');
    if (name === 'AbortError' || /abort/i.test(msg)) return 'timeout(' + USER_FILE_TIMEOUT_MS + 'ms)';
    return msg;
}

function requestHeaders() {
    const ctx = getCtx();
    try { if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders(); } catch (e) { /* 忽略 */ }
    return { 'Content-Type': 'application/json' };
}

/**
 * UTF-8 文本 → base64（无 TextEncoder/btoa 时返回 ''）。
 *
 * v3.0.15（用户报告「上次更新后特别卡顿，尤其正文保存，可能直接卡死」）——**性能修复**：
 *   原实现是逐字节字符串拼接（`for (const b of bytes) bin += String.fromCharCode(b)`），
 *   在 1.3MB 信封上实测 **151ms**（浏览器更慢），且产生巨量临时字符串把 GC 顶起来 —— 这是每次保存
 *   最主要的阻塞项。改为**分块 `String.fromCharCode.apply`**（与 `adapters/gzip.js#bytesToBase64` 同款，
 *   每块 32KB）：实测 **16ms**。Node/Bun 等有 `Buffer` 的环境直接走原生 base64（更快且零临时字符串）。
 *   编码结果与旧实现**逐字节一致**（由 `store-chat` 的 S11 断言锁定）。
 */
export function textToBase64(text) {
    try {
        const s = String(text == null ? '' : text);
        // ① 有 Buffer（Tauri/Node 侧常见；经 globalThis 取，保持内核纯净度门禁通过）→ 原生实现
        try {
            const B = globalThis.Buffer;
            if (B && typeof B.from === 'function') {
                const b64 = B.from(s, 'utf8').toString('base64');
                if (b64) return b64;
            }
        } catch (e) { /* 退回落下面 */ }
        // ② 浏览器：分块 fromCharCode（**不再逐字节拼接**）
        if (typeof TextEncoder === 'function' && typeof btoa === 'function') {
            const bytes = new TextEncoder().encode(s);
            const CH = 0x8000;
            const parts = [];
            for (let i = 0; i < bytes.length; i += CH) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
            return btoa(parts.join(''));
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

/**
 * 写入服务端文件（POST /api/files/upload {name, data(base64)}）
 * @param {string} name 文件名
 * @param {string} text 文件内容（明文）
 * @param {{timeoutMs?:number}} [opts] v3.0.14：超时覆盖（缺省 `USER_FILE_TIMEOUT_MS`；单测用小值验证超时路径）
 */
export async function uploadStateFile(name, text, opts) {
    const o = opts || {};
    const data = textToBase64(text);
    if (!data) return { ok: false, error: 'base64 编码不可用' };
    try {
        const res = await fetchWithTimeout('/api/files/upload', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ name: String(name), data }),
        }, o.timeoutMs);
        const status = Number(res && res.status) || 0;
        return { ok: status >= 200 && status < 300, status };
    } catch (e) {
        return { ok: false, error: fetchErrText(e) };          // v3.0.14：超时 → 'timeout(30000ms)'（不再永远挂着）
    }
}

/** 读取服务端文件（GET /api/files/…；失败返回 ok:false）；`opts.timeoutMs` 同 `uploadStateFile` */
export async function readStateFile(name, opts) {
    const o = opts || {};
    try {
        const res = await fetchWithTimeout('/user/files/' + encodeURIComponent(String(name)), { method: 'GET', headers: requestHeaders() }, o.timeoutMs);
        const status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) return { ok: false, status };
        const text = await res.text();
        return { ok: true, text: String(text == null ? '' : text) };
    } catch (e) {
        return { ok: false, error: fetchErrText(e) };
    }
}

/** 删除服务端文件（POST /api/files/delete {path}）；`opts.timeoutMs` 同 `uploadStateFile` */
export async function deleteStateFile(name, opts) {
    const o = opts || {};
    try {
        const res = await fetchWithTimeout('/api/files/delete', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ path: '/user/files/' + String(name) }),
        }, o.timeoutMs);
        const status = Number(res && res.status) || 0;
        return { ok: status >= 200 && status < 300, status };
    } catch (e) {
        return { ok: false, error: fetchErrText(e) };
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
export async function readStateFileAuto(name, opts) {
    const o = opts || {};
    try {
        const res = await fetchWithTimeout('/user/files/' + encodeURIComponent(String(name)), { method: 'GET', headers: requestHeaders() }, o.timeoutMs);
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
        return { ok: false, text: '', gz: false, error: fetchErrText(e) };
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
