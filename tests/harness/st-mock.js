// ============================================================
// tests/harness/st-mock.js —— 酒馆宿主桩（Node 环境下模拟 getContext 与最小 DOM）
// 用途：让 host/ adapters/ ui/ index.js 在无酒馆环境下可被真实执行与断言。
// ============================================================
import { HOST_EVENTS } from '../../core/constants.js';

/** 最小 DOM 元素桩 */
function makeEl(id) {
    const el = {
        id,
        html: '',
        textContent: '',
        checked: false,
        value: '',
        children: [],
        listeners: {},
        // v2.36.0：面板宽度以 CSS 变量下发 → 桩需能记录 style.setProperty（测试断言宽度档位用）
        __styleVars: {},
        style: {
            setProperty(k, v) { this.owner.__styleVars[String(k)] = String(v); },
            getPropertyValue(k) { return this.owner.__styleVars[String(k)] || ''; },
            removeProperty(k) { delete this.owner.__styleVars[String(k)]; },
            get cssText() { return Object.keys(this.owner.__styleVars).map((k) => k + ':' + this.owner.__styleVars[k]).join(';'); },
        },
        insertAdjacentHTML(pos, html) { this.html += String(html); },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeChild() { return true; },
        parentNode: { removeChild() { return true; } },
        dispatch(type) { for (const fn of (this.listeners[type] || [])) fn(); },
        // v2.47.0：最小 `querySelector` —— 只支持 `[attr="value"]` 形态（场景树折叠用它找子树容器）。
        //   **不是**完整 DOM：命中后返回一个稳定的伪节点（带 `style.display` / `textContent` / `dataset`），
        //   足以断言「折叠按钮切了显示态」这类纯 DOM 行为。
        querySelector(sel) {
            const m = /^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/.exec(String(sel == null ? '' : sel));
            if (!m) return null;
            const attr = m[1];
            // 属性值在 HTML 里是**实体转义**的（`>` → `&gt;`），而 CSS 选择器比的是解码值 —— 两种都试
            const escHtmlVal = m[2].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const rx = (v) => new RegExp(attr + '="' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
            if (!rx(m[2]).test(String(this.html || '')) && !rx(escHtmlVal).test(String(this.html || ''))) return null;
            if (!this.__qs) this.__qs = {};
            if (!this.__qs[sel]) this.__qs[sel] = { style: { display: '' }, textContent: '', dataset: {}, id: '' };
            return this.__qs[sel];
        },
    };
    el.style.owner = el;
    return el;
}

/** 最小 document 桩（只支持 getElementById） */
export function makeDocument(ids) {
    const els = {};
    for (const id of (ids || ['extensions_settings2'])) els[id] = makeEl(id);
    return {
        _els: els,
        getElementById(id) { return els[id] || null; },
        createElement() { return makeEl('tmp'); },
    };
}

/**
 * 构造宿主桩。
 * @param {object} [opts]
 * @param {boolean} [opts.noEventSource] 不带事件源（验证降级）
 * @param {boolean} [opts.noInject] 不带 setExtensionPrompt
 * @param {boolean} [opts.noTemplate] 不带 renderExtensionTemplateAsync（验证回退 HTML）
 * @param {boolean} [opts.noSlash] 不带 SlashCommandParser
 * @param {boolean} [opts.noMacros] 不带 macros
 * @param {Array} [opts.chat] 初始聊天
 */
export function makeHost(opts) {
    const o = opts || {};
    const events = [];
    const listeners = {};
    const eventSource = {
        on(type, fn) { listeners[type] = listeners[type] || []; listeners[type].push(fn); events.push(['on', type]); },
        removeListener(type, fn) { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); if (!a.length) delete listeners[type]; events.push(['off', type]); },
        emit(type, ...args) { for (const fn of (listeners[type] || []).slice()) fn(...args); },
    };
    const eventTypes = {};
    for (const n of HOST_EVENTS) eventTypes[n] = n;
    eventTypes.APP_READY = 'APP_READY';
    eventTypes.APP_INITIALIZED = 'APP_INITIALIZED';

    const ctx = {
        chat: o.chat || [{ is_user: true, mes: '你好', name: 'User' }],
        characters: [{ name: '角色甲' }],
        characterId: 0,
        name1: 'User',
        name2: '角色甲',
        chatMetadata: {},
        extensionSettings: {},
        extensionPrompts: {},
        saveSettingsCount: 0,
        saveSettingsDebounced() { ctx.saveSettingsCount += 1; },
        saveMetadata() { return Promise.resolve(); },
        setExtensionPrompt(key, value, position, depth, scan, role) {
            ctx.extensionPrompts[key] = { value: String(value), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role) };
            ctx.injectCalls = ctx.injectCalls || [];
            ctx.injectCalls.push({ key, value: String(value), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role) });
        },
        generateRaw: async () => '{"ok":true}',
        generateQuietPrompt: async () => 'quiet',
        locale: 'zh-cn',
        getCurrentLocale() { return ctx.locale; },
        addLocaleData(locale, data) {
            ctx.localeData = ctx.localeData || {};
            ctx.localeData[String(locale)] = Object.assign({}, ctx.localeData[String(locale)] || {}, data || {});
            ctx.localeCalls = (ctx.localeCalls || []).concat([[String(locale), Object.keys(data || {}).length]]);
        },
        macros: { register(name, def) { ctx.macrosRegistered = ctx.macrosRegistered || []; ctx.macrosRegistered.push({ name, def }); } },
        SlashCommandParser: { addCommandObject(cmd) { ctx.commands = ctx.commands || []; ctx.commands.push(cmd); } },
        SlashCommand: { fromProps(p) { return p; } },
        loadWorldInfo: async () => ({}),
        saveWorldInfo: async () => true,
        getWorldInfoNames: () => ['测试世界书'],
        getExtensionManifest: () => ({ version: '2.0.0', display_name: 'FTT记忆组件 V2' }),
        callGenericPopup: () => Promise.resolve(1),
        getRequestHeaders: () => ({}),
        accountStorage: { getItem: () => null, setItem: () => true },
        variables: { local: {}, global: {} },
        substituteParams: (s) => String(s == null ? '' : s),
        // v2.35.0：酒馆「连接配置」服务桩（扩展通道 API）——默认无可用连接，测试可整体替换
        ConnectionManagerRequestService: { sendRequest: async () => '', getSupportedProfiles: () => [] },
    };
    if (o.noEventSource) delete ctx.eventSource; else ctx.eventSource = eventSource;
    ctx.eventTypes = o.noEventSource ? undefined : eventTypes;
    if (o.noInject) { delete ctx.setExtensionPrompt; delete ctx.extensionPrompts; }
    if (!o.noTemplate) {
        ctx.renderExtensionTemplateAsync = async (folder, file, data) => {
            if (o.templateHtml) return String(o.templateHtml);
            return '<div class="ftt-v2-settings" id="ftt_v2_settings" data-via="template">' + String(data && data.version) + '</div>';
        };
    }
    if (o.noSlash) { delete ctx.SlashCommandParser; delete ctx.SlashCommand; }
    if (o.noMacros) delete ctx.macros;

    return { ctx, eventSource, listeners, events, emit: (t, ...a) => eventSource.emit(t, ...a) };
}

/** 把桩装进 globalThis（返回卸载函数） */
export function installGlobalHost(host, doc) {
    const prevST = globalThis.SillyTavern;
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    globalThis.SillyTavern = { getContext: () => host.ctx };
    if (doc) { globalThis.document = doc; globalThis.window = { document: doc }; }
    return () => {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (doc) { if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc; }
        if (doc) { if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin; }
    };
}

/**
 * 安装 fetch 桩（返回卸载函数）。
 * @param {Function|object} handler (url, opts) => {status, json, text} 或 {status, body, text}
 *   简化写法：返回 {status:200, body:{...}} 时自动同时支持 json()/text()
 */
export function installGlobalFetch(handler) {
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        const r = (typeof handler === 'function') ? await handler(String(url), opts || {}) : handler;
        const status = Number(r && r.status != null ? r.status : 200);
        const body = r && r.body !== undefined ? r.body : null;
        const text = r && r.text !== undefined ? r.text : (body === null ? '' : JSON.stringify(body));
        // V1 主文件是 gzip 字节（`.json.gz`）→ 桩需支持 arrayBuffer()（r.bytes 为 Uint8Array/Buffer 时）
        const bytes = (r && (r.bytes instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(r.bytes)))) ? new Uint8Array(r.bytes) : null;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => (body === null ? JSON.parse(text) : body),
            text: async () => (bytes ? Buffer.from(bytes).toString('utf8') : String(text)),
            arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new TextEncoder().encode(String(text)).buffer),
        };
    };
    return () => { if (prev === undefined) delete globalThis.fetch; else globalThis.fetch = prev; };
}

/** 断言收集器 */
export function makeReporter(title) {
    let pass = 0, fail = 0;
    const failures = [];
    return {
        assert(name, cond, extra) {
            // 防呆：断言条件必须是**已求值的布尔值** —— Promise/thenable 恒为真，会造成「假绿」（曾真实发生）
            const thenable = cond && (typeof cond === 'object' || typeof cond === 'function') && typeof cond.then === 'function';
            if (thenable) {
                fail++;
                failures.push(name);
                console.log('  ❌', name, '断言条件是一个 Promise（未 await）：请改为 await 后传布尔值', extra === undefined ? '' : JSON.stringify(extra));
                return;
            }
            if (cond) { pass++; }
            else { fail++; failures.push(name); console.log('  ❌', name, extra === undefined ? '' : JSON.stringify(extra)); }
        },
        done() {
            console.log('\n[' + title + '] 结果: ' + pass + ' 通过, ' + fail + ' 失败');
            if (fail) { console.log('  失败项：' + failures.join(' | ')); process.exit(1); }
            process.exit(0);
        },
        stats() { return { pass, fail, failures }; },
        silentAssert(name, cond) { if (cond) pass++; else { fail++; failures.push(name); } },
    };
}
