// ============================================================
// ui/file-io.js —— **真实文件导出/导入**（v2.49.0，移植 V1 的 Blob 下载与 `<input type=file>` 读取）
//
// 用户报告：「导出和导入，应该正确触发**导出及下载文件**，以及**导入存档文件**。该机制存在问题。」
// 事实：V2 此前「导出」只把 JSON 塞进文本框 + 剪贴板（不落文件），「导入」只提示去文本框粘贴
//   —— 与 V1 的数据管理页不一致，V1 是真的下载/读取文件：
//     · 导出 → `storageExport`/`export` 动作：`new Blob([json], {type:'application/json'})` +
//       `URL.createObjectURL` + `<a download="FTT记忆_<hash>.json">` + `click()`（v1.206 27048 / 27214）；
//     · 导入 → `storageImport`/`import` 动作：`<input type="file" accept=".json">` + `FileReader.readAsText`
//       → `storageImportData(text)`（v1.206 27058 / 26218、27226）。
//
// 本模块只做「取文件 / 落文件」这一层（不碰业务），并保证：
//   · **永不抛**：宿主缺 `Blob`/`URL.createObjectURL`/`document` 时返回 `{ ok:false, reason }`，由调用方回落文本框；
//   · **可测**：所有宿主对象都从 `globalThis` 现取（测试可替换 `document`/`URL`/`Blob`/`FileReader`）；
//   · **不污染 DOM**：临时 `<a>`/`<input>` 用完即移除（V1 同样尝试移除）。
// ============================================================

const str = (v) => String(v == null ? '' : v);

/** 环境能力（导出用下载、导入用文件选择器） */
export function fileIoCapabilities() {
    const g = globalThis;
    const doc = g && g.document;
    const url = g && g.URL;
    return {
        download: !!(doc && typeof doc.createElement === 'function' && typeof g.Blob === 'function'
            && url && typeof url.createObjectURL === 'function'),
        pick: !!(doc && typeof doc.createElement === 'function'),
        blob: typeof g.Blob === 'function',
        reader: typeof g.FileReader === 'function',
    };
}

/** 追加到 body（无 body 时回落 documentElement / 不追加） */
function attach(node) {
    try {
        const doc = globalThis.document;
        const host = (doc && (doc.body || doc.documentElement)) || null;
        if (host && typeof host.appendChild === 'function') host.appendChild(node);
        return !!host;
    } catch (e) { return false; }
}
function detach(node) {
    try { if (node && typeof node.remove === 'function') node.remove(); return; } catch (e) { /* 忽略 */ }
    try { if (node && node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node); } catch (e2) { /* 忽略 */ }
}

/**
 * **下载文本为文件**（V1 `export` 动作同款）。
 * @param {string} filename 文件名（如 `FTT记忆_ab12cd.json`）
 * @param {string} text 文件内容
 * @param {string} [mime] 默认 `application/json`
 * @returns {{ ok: boolean, reason: string, filename: string, chars: number }}
 */
export function downloadTextFile(filename, text, mime) {
    const name = str(filename) || 'FTT-memory.json';
    const body = str(text);
    try {
        const g = globalThis;
        const doc = g && g.document;
        const caps = fileIoCapabilities();
        if (!caps.download) return { ok: false, reason: 'no-download', filename: name, chars: body.length };
        const blob = new g.Blob([body], { type: str(mime) || 'application/json' });
        const url = g.URL.createObjectURL(blob);
        const a = doc.createElement('a');
        try { a.href = url; } catch (e) { /* 忽略 */ }
        try { a.download = name; } catch (e) { /* 忽略 */ }
        try { a.rel = 'noopener'; } catch (e) { /* 忽略 */ }
        try { if (a.style) a.style.display = 'none'; } catch (e) { /* 忽略 */ }
        const attached = attach(a);
        try { a.click(); } catch (e) { detach(a); return { ok: false, reason: 'click-failed', filename: name, chars: body.length }; }
        // 立即摘除节点；URL 稍后回收（太早回收会让部分宿主下载失败）
        detach(a);
        try {
            if (typeof g.setTimeout === 'function') g.setTimeout(() => { try { g.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 5000);
            else g.URL.revokeObjectURL(url);
        } catch (e) { /* 忽略 */ }
        return { ok: true, reason: '', filename: name, chars: body.length, attached: attached };
    } catch (e) {
        return { ok: false, reason: 'error:' + str(e && e.message), filename: name, chars: body.length };
    }
}

/**
 * **选择并读取文本文件**（V1 `import` 动作同款：`<input type="file">` + `readAsText`）。
 * @param {object} [opts] accept / title / timeoutMs
 * @returns {Promise<{ ok:boolean, reason:string, text:string, name:string, size:number }>}
 */
export function pickTextFile(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const done = (r) => { try { resolve(r); } catch (e) { /* 忽略 */ } };
        const empty = (reason) => done({ ok: false, reason: reason, text: '', name: '', size: 0 });
        try {
            const g = globalThis;
            const doc = g && g.document;
            if (!fileIoCapabilities().pick) return empty('no-dom');
            const input = doc.createElement('input');
            try { input.type = 'file'; } catch (e) { return empty('no-input'); }
            try { input.accept = str(o.accept) || '.json,application/json'; } catch (e) { /* 忽略 */ }
            try { if (input.style) input.style.display = 'none'; } catch (e) { /* 忽略 */ }
            let settled = false;
            const finish = (r) => { if (settled) return; settled = true; detach(input); done(r); };
            input.onchange = () => {
                (async () => {
                    try {
                        const files = (input && input.files) ? input.files : null;
                        const file = files && files[0];
                        if (!file) return finish({ ok: false, reason: 'no-file', text: '', name: '', size: 0 });
                        const text = await readFileText(file);
                        finish({ ok: true, reason: '', text: str(text), name: str(file.name), size: Number(file.size) || str(text).length });
                    } catch (e) {
                        finish({ ok: false, reason: 'read-failed', text: '', name: '', size: 0 });
                    }
                })();
            };
            // 现代浏览器的「取消选择」事件；宿主不支持时靠超时兜底（见下）
            try { input.oncancel = () => finish({ ok: false, reason: 'cancelled', text: '', name: '', size: 0 }); } catch (e) { /* 忽略 */ }
            attach(input);
            try { input.click(); } catch (e) { return empty('click-failed'); }
            const ms = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 120000;
            if (typeof g.setTimeout === 'function') {
                g.setTimeout(() => finish({ ok: false, reason: 'cancelled', text: '', name: '', size: 0 }), ms);
            }
        } catch (e) {
            empty('error:' + str(e && e.message));
        }
    });
}

/** 读取文件文本：优先 `file.text()`，否则 `FileReader.readAsText`（V1 用的就是后者） */
export function readFileText(file) {
    try {
        if (file && typeof file.text === 'function') return Promise.resolve(file.text());
    } catch (e) { /* 回落到 FileReader */ }
    return new Promise((resolve, reject) => {
        try {
            const g = globalThis;
            if (typeof g.FileReader !== 'function') return reject(new Error('no-filereader'));
            const fr = new g.FileReader();
            fr.onload = () => resolve(str(fr.result));
            fr.onerror = () => reject(new Error('read-error'));
            fr.readAsText(file);
        } catch (e) { reject(e); }
    });
}
