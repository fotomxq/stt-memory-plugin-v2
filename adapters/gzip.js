// ============================================================
// adapters/gzip.js —— gzip 传输能力（宿主/适配层；B9-d，移植自 V1
//   `src/FTT记忆组件-v1.206.js` 的 `bytesToBase64`(~5616)、`base64ToBytes`(~5627)、
//   `gzipToBase64`(~5635)、`gunzipFromBytes`(~5645)、以及读取侧的**魔数识别**
//   `decodeFileBytes`(~6028)）
//
// 为什么在适配层：压缩流（`CompressionStream` / `DecompressionStream`）与字节编解码是
//   **宿主能力**，内核 `core/` 必须保持纯净（scripts/check-core-purity.js）；故瘦身（纯函数）在
//   `core/slim.js`，字节/压缩在本文件，写入路径在 `adapters/user-file.js` + `adapters/sync.js`。
//
// V1 语义（原文照录）：
//   · 酒馆文件端点强制 base64（`writeFileSyncAtomic(path, body.data, 'base64')`），不能发明文；
//     但可以「先 gzip 再 base64」→ 上传体积从 1.33×原文变成 1.33×压缩后（实测约 1/4）。
//   · 读取**按内容魔数**（`1f 8b`）识别压缩，与扩展名无关 —— 明文旧文件与 gzip 新文件都能读。
//   · 环境不支持压缩（无 `CompressionStream`/`Blob`/`Response`）→ 自动回退明文（`{ok:false}`）。
// ============================================================

/** 字节 → base64（分块，避免超长 apply 爆栈）—— V1 `bytesToBase64` 逐字移植 */
export function bytesToBase64(u8) {
    try {
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return (typeof btoa === 'function') ? btoa(bin) : '';
    } catch (e) { return ''; }
}

/** base64 → 字节（不可解返回 null）—— V1 `base64ToBytes` 逐字移植 */
export function base64ToBytes(b64) {
    try {
        const bin = (typeof atob === 'function') ? atob(String(b64 || '').replace(/\s+/g, '')) : '';
        if (!bin) return null;
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    } catch (e) { return null; }
}

/** 文本 → 字节（无 TextEncoder 时按 UTF-8 手工编码） */
export function textToBytes(text) {
    try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text == null ? '' : text));
    } catch (e) { /* 落到手工编码 */ }
    const out = [];
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return new Uint8Array(out);
}

/** 字节 → 文本（UTF-8；失败返回 ''） */
export function bytesToText(u8) {
    try {
        if (!u8 || !u8.length) return '';
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return decodeURIComponent(escape(bin));
    } catch (e) { return ''; }
}

/** gzip 魔数判定（`1f 8b`）—— V1 `decodeFileBytes` 内联判定抽为函数（口径一致） */
export function isGzipBytes(u8) {
    try { return !!(u8 && u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b); } catch (e) { return false; }
}

/** 文本 → gzip → base64（不支持压缩时 `{ok:false, b64:''}`）—— V1 `gzipToBase64` 逐字移植 */
export async function gzipToBase64(text) {
    try {
        if (typeof globalThis.CompressionStream === 'function' && typeof globalThis.Blob === 'function' && typeof globalThis.Response === 'function') {
            const cs = new globalThis.CompressionStream('gzip');
            const stream = new globalThis.Blob([textToBytes(text)]).stream().pipeThrough(cs);
            const buf = await new globalThis.Response(stream).arrayBuffer();
            const b64 = bytesToBase64(new Uint8Array(buf));
            if (b64) return { ok: true, b64: b64 };
        }
    } catch (e) { /* 落到明文回退 */ }
    return { ok: false, b64: '' };
}

/** 文本 → gzip 字节（不支持压缩时返回 null）—— 供需要原始字节的调用方（如直接上传） */
export async function gzipToBytes(text) {
    try {
        if (typeof globalThis.CompressionStream === 'function' && typeof globalThis.Blob === 'function' && typeof globalThis.Response === 'function') {
            const cs = new globalThis.CompressionStream('gzip');
            const stream = new globalThis.Blob([textToBytes(text)]).stream().pipeThrough(cs);
            const buf = await new globalThis.Response(stream).arrayBuffer();
            return new Uint8Array(buf);
        }
    } catch (e) { /* 落到明文回退 */ }
    return null;
}

/** gzip 字节 → 文本（解压失败返回 null）—— V1 `gunzipFromBytes` 逐字移植 */
export async function gunzipFromBytes(u8) {
    try {
        if (typeof globalThis.DecompressionStream === 'function' && typeof globalThis.Response === 'function' && typeof globalThis.Blob === 'function') {
            const ds = new globalThis.DecompressionStream('gzip');
            const stream = new globalThis.Blob([u8]).stream().pipeThrough(ds);
            return await new globalThis.Response(stream).text();
        }
    } catch (e) { /* 落到 null（调用方按「解压失败」处理） */ }
    return null;
}

/**
 * 字节 → 文本（按**内容魔数**自动识别 gzip；V1 `decodeFileBytes` 等价物）。
 * @returns {Promise<{ok:boolean, text:string, gz:boolean, reason:string}>}
 */
export async function decodeBytesAuto(u8) {
    try {
        if (!u8 || !u8.length) return { ok: false, text: '', gz: false, reason: 'empty' };
        if (isGzipBytes(u8)) {
            const t = await gunzipFromBytes(u8);
            if (t === null || t === undefined) return { ok: false, text: '', gz: true, reason: 'gunzip-failed' };
            return { ok: true, text: String(t), gz: true, reason: '' };
        }
        const t0 = bytesToText(u8);
        if (!t0) return { ok: false, text: '', gz: false, reason: 'decode-failed' };
        return { ok: true, text: t0, gz: false, reason: '' };
    } catch (e) {
        return { ok: false, text: '', gz: false, reason: String((e && e.message) || e) };
    }
}

/** 通道是否支持 gzip 压缩（能力探测；供 UI/诊断如实说明，不做假实现） */
export function gzipAvailable() {
    try {
        return typeof globalThis.CompressionStream === 'function' && typeof globalThis.Blob === 'function' && typeof globalThis.Response === 'function'
            && typeof globalThis.DecompressionStream === 'function';
    } catch (e) { return false; }
}
