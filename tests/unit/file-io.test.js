// ============================================================
// 单元测试 · v2.49.0「导出/导入：真实下载文件与选择存档文件」
// 用户报告：「导出和导入，应该正确触发**导出及下载文件**，以及**导入存档文件**。该机制存在问题。」
//
// 事实：V2 此前「⬇ 导出 JSON」只把内容塞进文本框 + 剪贴板（**不落文件**），「⬆ 导入 JSON」只提示去文本框粘贴
//   （**不弹文件选择器**）——与 V1 数据管理页不一致。V1 是真的落文件/读文件（v1.206 27048/27214、27058/26218/27226）。
// 本批新增 `ui/file-io.js`（Blob + `<a download>`；`<input type=file>` + FileReader）并接进面板动作。
// 覆盖：
//   F 组：file-io 纯行为 —— 能力探测 / 下载（文件名·mime·click·延迟回收）/ 选择并读取 / 取消 / 无 DOM 回落 /
//         读取失败兜底 / FileReader 分支；
//   E 组：面板「⬇ 导出 JSON」真实点击 → **触发下载**（锚点 download 属性 + blob URL）、文本框仍有内容、
//         note 说明「已下载文件 …」；宿主不支持下载时 → 如实说明回落文本框；
//   I 组：面板「⬆ 导入 JSON（合并）」真实点击 → **弹出文件选择器**并读取 → 调 `importState` 合并 → note 报文件名与新增条数；
//         取消选择 → 提示可粘贴；`importStateOpen` 的文本框兜底路径（`importStateApply`）仍可用。
// 运行：node tests/unit/file-io.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel, bindOverlay } from '../../ui/panel.js';
import { downloadTextFile, pickTextFile, fileIoCapabilities, readFileText } from '../../ui/file-io.js';

const R = makeReporter('file-io v2.49.0 导出下载 / 导入存档文件');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { }, appended: [], appendChild(n) { this.appended.push(n); }, removeChild() { return true; } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** 假的下载环境：记录 createElement('a')/createObjectURL/revokeObjectURL 与 click */
function makeDownloadEnv(opts) {
    const o = opts || {};
    const log = { created: [], blobs: [], urls: [], revoked: [], clicked: [], timers: [] };
    const prevDoc = globalThis.document;
    const prevURL = globalThis.URL;
    const prevBlob = globalThis.Blob;
    const prevTimeout = globalThis.setTimeout;
    const mkEl = (tag) => {
        const el = {
            tagName: String(tag).toUpperCase(), attrs: {}, style: {}, calls: 0,
            set href(v) { this.attrs.href = v; }, get href() { return this.attrs.href; },
            set download(v) { this.attrs.download = v; }, get download() { return this.attrs.download; },
            set rel(v) { this.attrs.rel = v; }, get rel() { return this.attrs.rel; },
            click() { this.calls += 1; log.clicked.push(this); if (typeof this.onclick === 'function') this.onclick(); },
            remove() { this.removed = true; },
        };
        log.created.push(el);
        return el;
    };
    const fakeDoc = {
        body: { appendChild(n) { n.parent = 'body'; } },
        documentElement: { appendChild(n) { n.parent = 'html'; } },
        createElement: (tag) => mkEl(tag),
        getElementById: (id) => (prevDoc && prevDoc.getElementById ? prevDoc.getElementById(id) : null),
    };
    globalThis.document = o.noDoc ? undefined : fakeDoc;
    globalThis.URL = o.noURL ? undefined : {
        createObjectURL(blob) { log.blobs.push(blob); const u = 'blob:mock/' + (log.urls.length + 1); log.urls.push(u); return u; },
        revokeObjectURL(u) { log.revoked.push(u); },
    };
    if (o.noBlob) delete globalThis.Blob; else globalThis.Blob = function Blob(parts, opt) { this.parts = parts; this.type = (opt || {}).type || ''; log.blobs.push(this); };
    // 记录定时器但**照常执行**（测试自身的 `await setTimeout` 也要能推进；延迟回收在 5s 后，不影响断言）
    if (!o.realTimers) globalThis.setTimeout = (fn, ms) => { log.timers.push(ms); return prevTimeout(fn, ms); };
    return {
        log,
        fakeDoc,
        restore() {
            if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
            if (prevURL === undefined) delete globalThis.URL; else globalThis.URL = prevURL;
            if (prevBlob === undefined) delete globalThis.Blob; else globalThis.Blob = prevBlob;
            globalThis.setTimeout = prevTimeout;
        },
    };
}

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), { atoms: [{ id: 'a1', text: '甲把铜箱交给乙。', date: '1919-11-20', floorStart: 1, floorEnd: 2, uses: 1, type: '主线' }] }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
}
boot();
openPanel('settings');

// ---------- F 组：file-io 纯行为 ----------
A('F1 能力探测：无 DOM 时 download=false（不抛）', (() => {
    const env = makeDownloadEnv({ noDoc: true });
    try {
        const c = fileIoCapabilities();
        const r = downloadTextFile('a.json', '{}');
        return c.download === false && r.ok === false && r.reason === 'no-download' && r.chars === 2;
    } finally { env.restore(); }
})(), '');

A('F2 下载：Blob(application/json) → createObjectURL → `<a download="文件名">` → click → 延迟回收 URL', (() => {
    const env = makeDownloadEnv({});
    try {
        const r = downloadTextFile('FTT记忆_ab12.json', '{"x":1}', 'application/json');
        const a = env.log.clicked[0];
        return r.ok === true && r.filename === 'FTT记忆_ab12.json' && r.chars === 7
            && env.log.blobs.filter((b) => b && b.type === 'application/json').length >= 1
            && env.log.urls.length === 1 && !!a && a.download === 'FTT记忆_ab12.json' && a.href === env.log.urls[0]
            && a.calls === 1 && a.removed === true && env.log.timers[0] === 5000 && env.log.revoked.length === 0;
    } finally { env.restore(); }
})(), (() => { const env = makeDownloadEnv({}); try { const r = downloadTextFile('x.json', '{}'); return J({ r, urls: env.log.urls, clicked: env.log.clicked.length, timers: env.log.timers }); } finally { env.restore(); } })());

A('F3 下载：无 URL.createObjectURL → 如实返回 no-download（调用方回落文本框）', (() => {
    const env = makeDownloadEnv({ noURL: true });
    try { const r = downloadTextFile('x.json', '{}'); return r.ok === false && r.reason === 'no-download'; } finally { env.restore(); }
})(), '');

await (async () => {
    // 选择文件：点击后 `onchange` 注入一个文件 → 读到 text/name/size
    const env = makeDownloadEnv({ realTimers: true });
    let inputEl = null;
    env.fakeDoc.createElement = (tag) => (inputEl = {
        tagName: String(tag).toUpperCase(), style: {},
        click() { this.files = [{ name: '存档.json', size: 12, text: async () => '{"state":{}}' }]; if (typeof this.onchange === 'function') this.onchange(); },
    });
    try {
        const r = await pickTextFile({ accept: '.json', timeoutMs: 5000 });
        A('F4 选择并读取文件：`onchange` → `file.text()` → `{ ok, text, name, size }`',
            r.ok === true && r.text === '{"state":{}}' && r.name === '存档.json' && r.size === 12 && inputEl.accept === '.json', J({ r, accept: inputEl && inputEl.accept }));
    } finally { env.restore(); }
})();

await (async () => {
    const env = makeDownloadEnv({ realTimers: true });
    env.fakeDoc.createElement = (tag) => ({ tagName: String(tag).toUpperCase(), style: {}, click() { /* 用户未选文件 */ } });
    try {
        const r = await pickTextFile({ timeoutMs: 5 });
        A('F5 取消选择（超时兜底）→ `{ ok:false, reason:"cancelled" }`，不抛不留悬挂 Promise', r.ok === false && r.reason === 'cancelled', J(r));
    } finally { env.restore(); }
})();

await (async () => {
    // FileReader 分支（无 file.text 时）
    const prevReader = globalThis.FileReader;
    globalThis.FileReader = function FileReader() {
        this.readAsText = () => { this.result = 'FR-内容'; setTimeout(() => this.onload && this.onload(), 0); };
    };
    try {
        const txt = await readFileText({ name: 'a.json', size: 3 });
        A('F6 `readFileText`：无 `file.text()` 时回落 `FileReader.readAsText`（V1 同款）', txt === 'FR-内容', txt);
    } finally {
        if (prevReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = prevReader;
    }
})();

// ---------- E 组：面板导出（真实点击） ----------
await (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'data' });
    bindOverlay();
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const fire = async (dataset) => {
        const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        await new Promise((r) => setTimeout(r, 10));
    };
    setPanelHooks2({
        exportState: () => J({ format: 'ftt-memory-v2-export', state: { atoms: [{ id: 'a1' }] } }),
        importState: async (text) => ({ ok: true, added: JSON.parse(text).state.atoms.length }),
    });
    const env = makeDownloadEnv({});
    try {
        await fire({ fttAction: 'exportState' });
        const a = env.log.clicked[0];
        const st = panelState();
        const html = String(panelBodyHtml('settings') || '');
        A('E1 点「⬇ 导出 JSON」→ **真实触发下载**（blob + `<a download="FTT记忆_<hash>.json">`），文本框同时有内容',
            env.log.clicked.length === 1 && !!a && /^FTT记忆_.*\.json$/.test(String(a.download || ''))
            && String(a.href || '').indexOf('blob:') === 0
            && String(st.note || '').indexOf('已下载文件 FTT记忆_') >= 0
            && html.indexOf('data-ftt-export') >= 0 && Number(st.exportChars) > 10,
            J({ download: a && a.download, href: a && a.href, note: st.note, exportChars: st.exportChars, created: env.log.created.length }));
    } finally { env.restore(); }

    const env2 = makeDownloadEnv({ noURL: true });
    try {
        await fire({ fttAction: 'exportState' });
        const st2 = panelState();
        A('E2 宿主不支持下载（无 URL.createObjectURL）→ 如实提示「未下载文件（no-download…）」并保留文本框内容',
            String(st2.note || '').indexOf('未下载文件') >= 0 && String(st2.note || '').indexOf('no-download') >= 0
            && Number(st2.exportChars) > 10,
            J({ note: st2.note }));
    } finally { env2.restore(); }
})();

// ---------- I 组：面板导入（真实点击 → 选择文件） ----------
await (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'data' });
    bindOverlay();
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    let seen = null;
    setPanelHooks2({
        exportState: () => '{}',
        importState: async (text) => { seen = String(text); return { ok: true, added: 1 }; },
    });
    const env = makeDownloadEnv({});
    const prevTimeout = globalThis.setTimeout;
    let inputEl = null;
    env.fakeDoc.createElement = (tag) => (inputEl = {
        tagName: String(tag).toUpperCase(), style: {},
        click() { this.files = [{ name: '备份.json', size: 20, text: async () => '{"state":{"atoms":[{"id":"z1"}]}}' }]; if (typeof this.onchange === 'function') this.onchange(); },
    });
    globalThis.setTimeout = (fn, ms) => { const id = prevTimeout(fn, ms); return id; };
    try {
        const tg = { dataset: { fttAction: 'importStateOpen' }, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        await new Promise((r) => prevTimeout(r, 20));
        const st = panelState();
        A('I1 点「⬆ 导入 JSON（合并）」→ **弹出文件选择器**并读取文件 → 调 importState 合并 → note 报文件名与新增条数',
            !!inputEl && inputEl.type === 'file' && String(inputEl.accept || '').indexOf('.json') >= 0
            && seen === '{"state":{"atoms":[{"id":"z1"}]}}'
            && String(st.note || '').indexOf('已导入文件 备份.json') >= 0 && String(st.note || '').indexOf('新增 1 条') >= 0,
            J({ seen, note: st.note, accept: inputEl && inputEl.accept }));
    } finally { env.restore(); globalThis.setTimeout = prevTimeout; }
})();

await (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'data' });
    bindOverlay();
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    let called = 0;
    setPanelHooks2({ importState: async () => { called += 1; return { ok: true, added: 0 }; } });
    const env = makeDownloadEnv({});
    let inputEl = null;
    const prevTimeout = globalThis.setTimeout;
    env.fakeDoc.createElement = (tag) => (inputEl = { tagName: String(tag).toUpperCase(), style: {}, click() { if (typeof this.oncancel === 'function') this.oncancel(); } });
    globalThis.setTimeout = (fn, ms) => { const id = prevTimeout(fn, ms); return id; };
    try {
        const tg = { dataset: { fttAction: 'importStateOpen' }, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        await new Promise((r) => prevTimeout(r, 20));
        const st = panelState();
        A('I2 取消选择文件 → 不调用 importState，并提示「已取消选择文件 → 也可在下方文本框粘贴后点「导入」」',
            called === 0 && String(st.note || '').indexOf('已取消选择文件') >= 0 && String(st.note || '').indexOf('文本框粘贴') >= 0,
            J({ called, note: st.note }));
    } finally { env.restore(); globalThis.setTimeout = prevTimeout; }
})();

A('I3 文本框兜底路径仍可用：`importStateApply` 读 `[data-ftt-import]` 文本域 → 合并（V1 的粘贴导入语义）', (async () => {
    boot();
    let got = '';
    setPanelHooks2({ importState: async (text) => { got = String(text); return { ok: true, added: 2 }; } });
    const r = await panelAction('importStateApply', { text: '{"state":{}}' });
    return r.ok === true && got === '{"state":{}}' && String(panelState().note || '').indexOf('新增 2 条') >= 0;
})(), '');

A('I4 数据管理页按钮文案与 title 对齐 V1（导出=下载文件；导入=增量合并并提示选择文件）', (() => {
    boot();
    openPanel('settings');
    const html = String(panelBodyHtml('settings') || '');
    return html.indexOf('data-ftt-action="exportState"') >= 0 && html.indexOf('⬇ 导出 JSON') >= 0
        && html.indexOf('data-ftt-action="importStateOpen"') >= 0 && html.indexOf('⬆ 导入 JSON（合并）') >= 0
        && html.indexOf('触发浏览器下载') >= 0 && html.indexOf('增量导入：选择 JSON 存档文件') >= 0;
})(), '');

un();
R.done();
