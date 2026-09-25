'use strict';
// ============================================================
// oracle（API 页与 API 通道）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-api.json
//   覆盖：resolveApiFor 多场景矩阵 + resolveKw/Mem/ParallelApiOverride（间接取证）
//        + apiBlockHtml 真实投影（经 settingsHtml() 真渲染 / panel.innerHTML）
//        + API 子页结构化投影（真实点击设定子标签 data-ftt-subtab="api"）
//        + presetSave/presetLoad/presetDelete（真实点击委托）
//        + testApi/fetchModels 网络语义（真实捕获 D.fetch 请求）
//        + V1 原生怪癖
//
// 取证方式（严禁伪造）：
//   · __FTT 已导出：resolveApiFor / testApi / fetchModels / callChatCompletion /
//     extractKeywordsFromText / analyzeMemorySend / runParallelWeave / settingsHtml /
//     settingsSubState / setSettingsSub / toastLogGet。
//   · **未导出**（v1.206 `__FTT` 清单无此项）：apiBlockHtml / apiPresetSelectHtml /
//     groupStrategyHtml / dimensionRowsHtml / collectApiBlock /
//     resolveKwApiOverride / resolveMemApiOverride / resolveParallelApiOverride。
//     这些一律**不 eval、不读源码手写行为**，改为：
//       ① apiBlockHtml → 走 `F.setSettingsSub('api'|'extract') + F.settingsHtml()` 真实渲染后投影
//          （API 子页里 main 块由 apiBlockHtml('main',...,'chat',true) 产出；
//            提取记忆子页里 emb/rerank 块由 apiBlockHtml('emb'|'rerank',...) 产出；
//            分组策略块内嵌 kw/mem 块 → 一并投影）；
//       ② resolveKw/MemApiOverride → 走真实调用链 `extractKeywordsFromText` /
//          `analyzeMemorySend`（二者内部调用 resolveKw/MemApiOverride）并**捕获真实请求**
//          （URL / body.model / Authorization）；
//          resolveParallelApiOverride → `runParallelWeave(...,{force:true})` 同法捕获；
//          另有 V1 自带的人类可读解析结果 `data-ftt-group-preview`（groupEffectiveText 真实渲染）作为旁证；
//       ③ collectApiBlock → 面板动作（apiTest/apiModels/presetSave…）真实执行时内部调用，
//          其输入值由「按真实渲染 HTML 解析出的面板 DOM 影子模型」提供（mock document 无 HTML 解析器，
//          本脚本自行实现最小属性/DOM 影子，语义与浏览器一致：value/.dataset/.type/.checked/.closest/.classList）。
//
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
//   两个非确定源被显式归一：testApi 的 `ms`（挂钟）不落库；UI 结果文案里的 `\d+ms` 归一为 `<n>ms`。
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, pluginToasts, makeResp } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-api.json');
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}

// ---------------- 极小 HTML 工具（只做投影与 DOM 影子，不做浏览器实现） ----------------
function decodeEnt(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function stripTags(s) {
    return decodeEnt(String(s == null ? '' : s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
function parseAttrs(str) {
    const out = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(str))) {
        const n = m[1].toLowerCase();
        const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
        out[n] = decodeEnt(v);
    }
    return out;
}
function dsOf(attrs) {
    const ds = {};
    for (const k of Object.keys(attrs)) {
        if (k.indexOf('data-') !== 0) continue;
        const parts = k.slice(5).split('-');
        ds[parts[0] + parts.slice(1).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('')] = attrs[k];
    }
    return ds;
}
const grab = (s, re) => { const m = String(s == null ? '' : s).match(re); return m ? m[1] : null; };
const grabAll = (s, re) => { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(String(s == null ? '' : s)))) out.push(m); return out; };
const normMs = (s) => String(s == null ? '' : s).replace(/\d+ms/g, '<n>ms');

// 控件投影（attrs + dataset + value/options）
function ctrlOf(tag, attrsStr, tagHtml) {
    const a = parseAttrs(attrsStr || '');
    const o = { tag: String(tag).toLowerCase(), attrs: a, dataset: dsOf(a) };
    if (o.tag === 'select') {
        o.options = grabAll(tagHtml, /<option value="([^"]*)"\s*(selected)?\s*>([\s\S]*?)<\/option>/g)
            .map((m) => ({ value: m[1], selected: !!m[2], text: stripTags(m[3]) }));
        const sel = o.options.find((x) => x.selected);
        o.value = sel ? sel.value : (o.options.length ? o.options[0].value : '');
    } else {
        o.value = a.value !== undefined ? a.value : '';
        if (a.type !== undefined) o.type = String(a.type).toLowerCase();
    }
    return o;
}
function buttonsOf(seg) {
    return grabAll(seg, /<button class="([^"]*)"((?:"[^"]*"|'[^']*'|[^>"'])*)>([^<]*)<\/button>/g)
        .map((m) => { const a = parseAttrs(m[2]); return { cls: m[1], attrs: a, dataset: dsOf(a), title: a.title !== undefined ? a.title : null, text: m[3] }; });
}
function mutedOf(seg) { return grabAll(seg, /<div class="ftt-muted">([\s\S]*?)<\/div>/g).map((m) => stripTags(m[1])); }
function secTitlesOf(seg) { return grabAll(seg, /<div class="ftt-sec-title">([\s\S]*?)<\/div>/g).map((m) => stripTags(m[1])); }
function fieldsOf(seg) {
    return grabAll(seg, /<div class="ftt-field"><label>([\s\S]*?)<\/label>\s*(<select[^>]*>[\s\S]*?<\/select>|<input[^>]*>)/g)
        .map((m) => {
            const tm = /^<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(m[2]);
            return { label: stripTags(m[1]), ctrl: ctrlOf(tm[1], tm[2] || '', m[2]) };
        });
}
// 一个 ftt-api-block 段 → 结构化投影（apiBlockHtml 的真实产物）
function projApiBlock(seg, withRaw) {
    const pfxs = grabAll(seg, /data-ftt-api="([^"]*)"/g).map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
    const o = {
        pfx: pfxs.filter((p) => ['main', 'emb', 'rerank', 'kw', 'mem'].indexOf(p) >= 0),
        title: stripTags(grab(seg, /<div class="ftt-api-title">([\s\S]*?)<\/div>/)),
        fields: fieldsOf(seg),
        buttons: buttonsOf(seg),
        notes: mutedOf(seg),
        resultSpanId: grab(seg, /<span class="ftt-api-test-result" id="([^"]*)">/),
    };
    if (withRaw) o.rawHtml = seg;
    return o;
}
// 平衡截取一个 div（从 `<div ...>` 到其配对 `</div>`），避免 split 后尾随无关节点
function balancedDiv(seg) {
    const s = String(seg);
    const re = /<div\b|<\/div>/g;
    let depth = 0, m;
    while ((m = re.exec(s))) {
        if (m[0] === '<div') depth++;
        else { depth--; if (depth === 0) return s.slice(0, m.index + m[0].length); }
    }
    return s;
}
function apiBlocksOf(html) {
    const parts = String(html).split('<div class="ftt-api-block">');
    const out = [];
    for (let i = 1; i < parts.length; i++) out.push(balancedDiv('<div class="ftt-api-block">' + parts[i]));
    return out;
}
const blockForPfx = (html, pfx) => apiBlocksOf(html).find((b) => b.indexOf('data-ftt-api="' + pfx + '"') >= 0) || null;
function settingsBodyOf(html) {
    const s = String(html);
    const i = s.indexOf('data-ftt-body="settings"');
    if (i < 0) return s;   // settingsHtml() 单页输出：整串就是设定页正文（无 tabs/body 包裹）
    const j = s.indexOf('data-ftt-body=', i + 5);
    return s.slice(i, j < 0 ? undefined : j);
}
function apiSubBodyOf(html) {
    const b = settingsBodyOf(html);
    const i = b.indexOf('<div class="ftt-section">');
    const j = b.indexOf('<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="savecfg">');
    return i < 0 ? '' : b.slice(i, j > i ? j : b.length);
}
// API 子页结构化投影
function projApiSubPage(html, withRaw) {
    const body = apiSubBodyOf(html);
    const all = settingsBodyOf(html);   // 设定页整体（含子页共有的 savecfg 行）
    const pName = fieldsOf(body).find((f) => f.ctrl.dataset.fttCfg === 'presetName');
    const pSel = fieldsOf(body).find((f) => f.ctrl.dataset.fttCfg === 'presetSelect');
    const o = {
        subtabBar: grabAll(html, /<a href="javascript:void\(0\)" class="ftt-subtab([^"]*)" data-ftt-subtab="([^"]*)">([^<]*)<\/a>/g)
            .map((m) => ({ key: m[2], label: m[3], on: m[1].indexOf('ftt-on') >= 0 })),
        sectionTitles: secTitlesOf(body),
        presetNameField: pName ? pName.ctrl : null,
        presetSelectField: pSel ? pSel.ctrl : null,
        buttons: buttonsOf(all),
        notes: mutedOf(body),
        saveButton: buttonsOf(all).find((b) => b.dataset.fttAction === 'savecfg') || null,
        blocks: apiBlocksOf(body).map((b) => projApiBlock(b, false)),
    };
    if (withRaw) o.rawSubBody = body;
    return o;
}

// ---------------- 面板 DOM 影子（mock document 无 HTML 解析器；语义对齐浏览器） ----------------
function makePanelDom(panel) {
    let dom = [];
    function mkEl(tag, attrs, text) {
        const ds = dsOf(attrs);
        const el = {
            tagName: String(tag).toUpperCase(), attrs, dataset: ds,
            value: attrs.value !== undefined ? attrs.value : '',
            checked: attrs.checked !== undefined,
            type: (attrs.type || '').toLowerCase(),
            id: attrs.id || '', className: attrs.class || '',
            innerHTML: '', textContent: text || '', style: {},
            disabled: attrs.disabled !== undefined, options: [],
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
            setAttribute(k, v) { attrs[k] = String(v); },
            closest(sel) { return String(sel || '').indexOf('ftt-panel') >= 0 ? panel : null; },
            classList: { contains: (c) => String(attrs.class || '').split(/\s+/).indexOf(c) >= 0 },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            focus() { }, setSelectionRange() { },
        };
        return el;
    }
    function parseHtml(html) {
        const s = String(html || '');
        const out = [];
        const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
        let m, lastSelect = null;
        while ((m = re.exec(s))) {
            const closing = m[1] === '/';
            const tag = m[2].toLowerCase();
            const attrs = parseAttrs(m[3] || '');
            if (closing) { if (tag === 'select') lastSelect = null; continue; }
            if (tag === 'option') { if (lastSelect) lastSelect.options.push(mkEl('option', attrs)); continue; }
            const el = mkEl(tag, attrs);
            if (tag === 'select') lastSelect = el;
            if (tag === 'input') el.value = attrs.value !== undefined ? attrs.value : '';
            out.push(el);
        }
        for (const el of out) {
            if (el.tagName === 'SELECT') {
                const sel = el.options.find((o) => o.attrs.selected !== undefined);
                el.value = sel ? sel.value : (el.options.length ? el.options[0].value : '');
            }
        }
        return out;
    }
    function matchOne(el, selRaw) {
        let s = String(selRaw).trim();
        let pseudo = '';
        const pi = s.indexOf(':checked');
        if (pi >= 0) { pseudo = 'checked'; s = s.slice(0, pi) + s.slice(pi + 8); }
        s = s.trim();
        if (s.charAt(0) === '#') {
            const m = /^#([A-Za-z0-9_-]+)/.exec(s);
            if (!m || el.id !== m[1]) return false;
            s = s.slice(m[0].length);
        } else if (s.charAt(0) === '.') {
            const m = /^\.([A-Za-z0-9_-]+)/.exec(s);
            if (!m || String(el.className || '').split(/\s+/).indexOf(m[1]) < 0) return false;
            s = s.slice(m[0].length);
        } else {
            const m = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(s);
            if (m) { if (el.tagName !== m[1].toUpperCase()) return false; s = s.slice(m[0].length); }
        }
        while (s.length) {
            const m = /^\s*\[\s*([A-Za-z0-9_:-]+)\s*(?:([\^\$\*]?=)\s*(?:"([^"]*)"|'([^']*)'))?\s*\]/.exec(s);
            if (!m) return false;
            const name = m[1], op = m[2], val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : null);
            if (!Object.prototype.hasOwnProperty.call(el.attrs, name)) return false;
            if (op) {
                const av = String(el.attrs[name]);
                if (op === '=' && av !== val) return false;
                if (op === '^=' && av.indexOf(val) !== 0) return false;
                if (op === '$=' && av.slice(-String(val).length) !== val) return false;
                if (op === '*=' && av.indexOf(val) < 0) return false;
            }
            s = s.slice(m[0].length);
        }
        if (pseudo === 'checked' && !el.checked) return false;
        return true;
    }
    function qsa(sel) {
        const res = [];
        for (const p of String(sel).split(',')) {
            for (const el of dom) if (matchOne(el, p) && res.indexOf(el) < 0) res.push(el);
        }
        res.sort((a, b) => dom.indexOf(a) - dom.indexOf(b));
        return res;
    }
    panel.querySelector = (sel) => qsa(sel)[0] || null;
    panel.querySelectorAll = (sel) => qsa(sel);
    return {
        qsa,
        qs: (sel) => qsa(sel)[0] || null,
        reparse: () => { dom = parseHtml(panel.innerHTML); return dom; },
        get dom() { return dom; },
    };
}

// ---------------- fetch 捕获桩（记录 headers；等价 stubFetch + 补录 Authorization） ----------------
function captureFetch(env) {
    const calls = [];
    let handler = () => ({});
    env.parentWin.fetch = async (url, opts) => {
        const o = opts || {};
        let body = null;
        try { body = o.body ? JSON.parse(o.body) : null; } catch (e) { body = null; }
        calls.push({ url: String(url), method: o.method || 'GET', headers: o.headers || null, body });
        const ret = await handler(String(url), o, body);
        if (ret && typeof ret === 'object' && 'ok' in ret) return ret;
        return makeResp(ret);
    };
    return {
        calls,
        set: (fn) => { handler = fn || (() => ({})); },
        reset: () => { calls.length = 0; },
        view: () => calls.map((c) => ({ url: c.url, method: c.method, contentType: c.headers && c.headers['Content-Type'] !== undefined ? c.headers['Content-Type'] : null, authorization: c.headers && c.headers.Authorization !== undefined ? c.headers.Authorization : null, body: c.body })),
    };
}

// ---------------- 场景基线 ----------------
const PRESET_A = { apiType: 'custom', apiUrl: 'https://pA.example/v1/', apiKey: 'sk-A', model: 'model-A', proxyPreset: '' };
const PRESET_B = { apiType: 'preset', apiUrl: 'https://pB.example/v1/', apiKey: 'sk-B', model: 'model-B', proxyPreset: 'P-B' };
const PROXY_PRESETS = { P1: { name: 'P1', settings: { apiurl: 'https://preset.example/v1/', key: '  sk-preset  ', model: 'preset-model' } } };
let presetImpl = 'ok';   // ok | null | throw | noapiurl | missing
function presetFn(name) {
    if (presetImpl === 'throw') throw new Error('preset backend down');
    if (presetImpl === 'missing') return null;
    if (presetImpl === 'noapiurl') return { name, settings: {} };
    if (presetImpl === 'null') return null;
    const p = PROXY_PRESETS[name];
    return p ? proj(p) : null;
}

const API_CFG_KEYS = ['apiType', 'apiUrl', 'apiKey', 'model', 'proxyPreset', 'apiPresets', 'activeApiPreset',
    'kwApiEnabled', 'kwApiPreset', 'kwApi', 'memApiEnabled', 'memApiPreset', 'memApi', 'parallelApiPreset',
    'embeddingUrl', 'embeddingKey', 'embeddingModel', 'embeddingProxyPreset',
    'rerankUrl', 'rerankKey', 'rerankModel', 'rerankProxyPreset', 'apiTemperature', 'apiMaxTokens', 'apiTopP'];

async function main() {
    const g = global;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (fn) => { try { fn(); } catch (e) { } return 0; };

    const env = makeTavernEnv({ iframe: { TavernHelper: { getPreset: (n) => presetFn(n) } } });
    const F = await loadPlugin(env);
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach((k) => { F.cfg.storage[k] = false; });
    F.cfg.storage.localStorage = true; F.cfg.storage.syncOnSave = false; F.cfg.storage.autoIdleCheck = false;
    F.cfg.storage.syncMetaProbe = false; F.cfg.storage.syncLogServer = false;
    F.state = Object.assign({}, F.state, {
        atoms: [], currentStates: [], snapshots: [], memories: [], items: [], plans: [], suspense: [],
        scenes: [], concepts: [], parallels: [], links: [], plotSegments: [], rumors: [], currencies: [],
        summaries: [], vars: {}, processedFloors: [], lastKnownFloor: -1,
        state: { date: '', time: '', location: '', sceneFocus: null, present: [] },
    });
    await new Promise((r) => setTimeout(r, 120));   // 让启动对账落定，保证 toast 基线稳定

    const net = captureFetch(env);
    const result = {};

    function resetApiCfg() {
        F.cfg.apiType = 'custom'; F.cfg.apiUrl = 'https://main.example/v1'; F.cfg.apiKey = 'sk-main'; F.cfg.model = 'model-main';
        F.cfg.proxyPreset = ''; F.cfg.activeApiPreset = '';
        F.cfg.apiPresets = { A: proj(PRESET_A), B: proj(PRESET_B) };
        F.cfg.kwApiEnabled = false; F.cfg.kwApiPreset = '';
        F.cfg.kwApi = { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' };
        F.cfg.memApiEnabled = false; F.cfg.memApiPreset = '';
        F.cfg.memApi = { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' };
        F.cfg.parallelApiPreset = '';
        F.cfg.embeddingUrl = 'https://e.example/v1'; F.cfg.embeddingKey = ''; F.cfg.embeddingModel = 'em'; F.cfg.embeddingProxyPreset = '';
        F.cfg.rerankUrl = 'https://r.example/v1'; F.cfg.rerankKey = 'rk'; F.cfg.rerankModel = 'rm'; F.cfg.rerankProxyPreset = '';
        F.cfg.apiTemperature = 0.2; F.cfg.apiMaxTokens = ''; F.cfg.apiTopP = '';
        F.cfg.feedWorldbooks = []; F.cfg.feedWorldbookEntries = {};
        presetImpl = 'ok';
    }
    const cfgSnap = (keys) => {
        const o = {};
        for (const k of (keys || API_CFG_KEYS)) o[k] = F.cfg[k] === undefined ? null : proj(F.cfg[k]);
        return o;
    };
    // 分场景的紧凑 cfg 视图（避免每个 case 都拖 25 个与本题无关的键）
    const RESOLVE_CFG_KEYS = ['apiType', 'apiUrl', 'apiKey', 'model', 'proxyPreset', 'activeApiPreset', 'apiPresets'];
    const OVERRIDE_CFG_KEYS = RESOLVE_CFG_KEYS.concat(['kwApiEnabled', 'kwApiPreset', 'kwApi', 'memApiEnabled', 'memApiPreset', 'memApi', 'parallelApiPreset']);
    const resolveCfgSnap = () => cfgSnap(RESOLVE_CFG_KEYS);
    const overrideCfgSnap = () => cfgSnap(OVERRIDE_CFG_KEYS);
    const apiCfgSnap = () => ({
        apiType: F.cfg.apiType, apiUrl: F.cfg.apiUrl, apiKey: F.cfg.apiKey, model: F.cfg.model,
        proxyPreset: F.cfg.proxyPreset, activeApiPreset: F.cfg.activeApiPreset || '', apiPresets: proj(F.cfg.apiPresets),
    });

    // ============================================================
    // 0. meta
    // ============================================================
    result.meta = {
        v1Version: 'v1.206',
        generatedBy: 'tests/fixtures/gen-v1-golden-api.cjs',
        sourceFile: 'src/FTT记忆组件-v1.206.js',
        note: '',
        notes: [],
        evidence: {
            directCall: 'resolveApiFor / testApi / fetchModels / extractKeywordsFromText / analyzeMemorySend / runParallelWeave / settingsHtml / settingsSubState / setSettingsSub / toastLogGet —— 均为 v1.206 `__FTT` 导出，直接调用。',
            apiBlockHtml: 'apiBlockHtml **未导出** → 用 `setSettingsSub("api"|"extract") + settingsHtml()` 真实渲染后，从真实 HTML 里切出每个 `<div class="ftt-api-block">` 段并投影（main 块即 apiBlockHtml("main","主摘要 API",... ,"chat",true) 的产物；emb/rerank 即 apiBlockHtml("emb"|"rerank",...) 的产物；kw/mem 块由 groupStrategyHtml 内嵌 apiBlockHtml 产出）。',
            apiPresetSelectHtml: 'apiPresetSelectHtml **未导出** 且 v1.206 中**无任何调用方**（死代码，仅 1 处定义）→ 无法从任何真实渲染路径取证，只有源码片段。',
            apiPage: '真实 `F.openPanel()` → 真实点击委托（`ftt-tab`=settings → `ftt-subtab`=api）→ 取 `panel.innerHTML`，投影设定子页。',
            presetActions: '真实点击委托：`panel.listeners.click` 派发伪事件 → V1 `handleAction` 真实执行 presetSave/presetLoad/presetDelete；输入控件值由**按真实渲染 HTML 解析出的面板 DOM 影子**提供（mock document 无 HTML 解析器，影子语义对齐浏览器：value/dataset/type/.closest/.classList/select 的 selected 优先并回落首个 option）。',
            netSemantics: '自实现等价 `stubFetch`（记录 url/method/**headers**/body；stubFetch 原版不记 headers），挂在 `D.fetch`（= parentWin.fetch）上捕获 V1 真实请求；HTTP 失败响应按 `{ok:false,status,statusText,text()}` 形态桩注入。',
            resolveOverrides: 'resolveKwApiOverride / resolveMemApiOverride / resolveParallelApiOverride **均未导出** → 经真实调用链（extractKeywordsFromText / analyzeMemorySend / runParallelWeave）捕获真实请求反推；另附 V1 自带 `data-ftt-group-preview`（groupEffectiveText 真实渲染）作为人类可读旁证。',
            skipped: [],
        },
    };
    result.meta.v1SourceSnips = {
        resolveApiFor: snip('function resolveApiFor(override) {', '// [] 解析关键词提取/记忆分析 API 分组'),
        resolveKwApiOverride: snip('function resolveKwApiOverride() {', 'async function testApi('),
        testApi: snip('async function testApi(override, kind) {', 'async function fetchModels('),
        fetchModels: snip('async function fetchModels(override) {', '// 双管道队列'),
        apiBlockHtml: snip('function apiBlockHtml(prefix, title, cfgObj, kind, showParams) {', 'function dimensionRowsHtml()'),
        dimensionRowsHtml: snip('function dimensionRowsHtml() {', 'function buttonLocationRowsHtml()'),
        apiPresetSelectHtml: snip('function apiPresetSelectHtml(pfx, value) {', 'function groupStrategyHtml('),
        groupStrategyHtml: snip('function groupStrategyHtml(pfx, title) {', '// 当前分组实际生效的 API（供预览）'),
        groupEffectiveText: snip('function groupEffectiveText(pfx) {', 'async function renderWorldbookSettings()'),
        collectApiBlock: snip('function collectApiBlock(pfx) {', '// ==================== v1.166：关系表 UI'),
        apiSubPage: snip("} else if (activeSettingsSub === 'api') {", "} else if (activeSettingsSub === 'analyze') {"),
        apiTestAction: snip("case 'apiTest': {", "case 'apiModels': {"),
        apiModelsAction: snip("case 'apiModels': {", "// 提取记忆三层分别测试"),
        presetActions: snip("case 'presetSave': {", "case 'savecfg': { settingsApplyAll(null); break; }"),
        settingsApplyAllApi: snip("const mainApi = collectApiBlock('main');", '// [] 关键词/记忆 API 分组：按策略保存'),
        settingsApplyAllSkip: snip("if (['rx_whitelist', 'rx_blacklist', 'presetName', 'presetSelect'].includes(key)) return;", "if (key === 'dimensionSeparate')", 200),
        settingsAutoApplySkip: snip("if (['presetName', 'presetSelect'].includes(key)) return;", 'const textLike =', 200),
        exports: snip('testApi, fetchModels, resolveApiFor, callChatCompletion,', '\n', 200),
    };

    // ============================================================
    // 1. resolve
    // ============================================================
    result.resolve = {
        note: 'resolveApiFor(override) 为 v1.206 `__FTT` 导出，全部为**直调真实返回值**。'
            + ' cfg 子集按场景设置后原样记录（未设置的键保持本节基线，见 resolve.baseline）。'
            + ' resolveKw/Mem/ParallelApiOverride 未导出 → 见 resolve.overrides（经真实调用链捕获请求反推）+ resolve.groupPreview。',
        baseline: { note: 'resolve.apiFor 各场景的 cfg 基线（每场景只改列出的键）', cfg: null, proxyPresetInterface: 'makeTavernEnv({iframe:{TavernHelper:{getPreset}}})：命中 V1 getFn 的第一顺位 window.TavernHelper.getPreset' },
        apiFor: { cases: [] },
        overrides: { cases: [] },
        groupPreview: { cases: [] },
    };
    resetApiCfg();
    result.resolve.baseline.cfg = cfgSnap();

    const resolveCases = [
        { id: 'main-custom-trailing-slash', desc: '主配置=自定义；apiUrl 带尾斜杠 → 返回值去尾斜杠，key/model 原样',
            set: { apiType: 'custom', apiUrl: 'https://main.example/v1/', apiKey: 'sk-main', model: 'model-main', proxyPreset: '' }, call: () => F.resolveApiFor() },
        { id: 'main-custom-multi-slash-and-space', desc: 'apiUrl 多个尾斜杠 + key/model 前后空白 → 均 trim；URL 去全部尾斜杠',
            set: { apiUrl: 'https://main.example/v1///', apiKey: '  sk-main  ', model: '  model-main  ' }, call: () => F.resolveApiFor() },
        { id: 'no-override-reads-activeApiPreset', desc: 'cfg.activeApiPreset="A"（无 override）→ resolveApiFor **不读** activeApiPreset，仍走主配置',
            set: { activeApiPreset: 'A' }, call: () => F.resolveApiFor() },
        { id: 'explicit-preset-from-activeApiPreset', desc: 'override {preset: cfg.activeApiPreset} → 命中已存分组 A',
            set: { activeApiPreset: 'A' }, call: () => F.resolveApiFor({ preset: F.cfg.activeApiPreset }) },
        { id: 'override-preset-A', desc: 'override 显式 {preset:"A"} → 返回分组 A 的 url（去尾斜杠）/key/model/proxyPreset',
            set: {}, call: () => F.resolveApiFor({ preset: 'A' }) },
        { id: 'override-preset-A-ignores-inline-fields', desc: 'override {preset:"A"} 同时带 apiUrl/apiKey/model → 分组分支**完全忽略**这些内联字段',
            set: {}, call: () => F.resolveApiFor({ preset: 'A', apiUrl: 'https://ov.example/v1', apiKey: 'sk-ov', model: 'ov-model' }) },
        { id: 'override-preset-preserves-preset-apiType', desc: '分组 B 的 apiType="preset" → 返回值 apiType 原样保留 "preset"',
            set: {}, call: () => F.resolveApiFor({ preset: 'B' }) },
        { id: 'override-preset-unknown', desc: 'override {preset:"ghost"}（分组不存在）→ 静默回落主配置',
            set: {}, call: () => F.resolveApiFor({ preset: 'ghost' }) },
        { id: 'override-preset-empty-string', desc: 'override {preset:""} → 空串为假值 → 回落主配置',
            set: {}, call: () => F.resolveApiFor({ preset: '' }) },
        { id: 'proxy-preset', desc: 'apiType="preset" + proxyPreset="P1" → url/key 取自 TavernHelper 预设；model 优先级 o.model || cfg.model || 预设 model（此处 cfg.model 胜出）',
            set: { apiType: 'preset', proxyPreset: 'P1', model: 'cfg-model' }, call: () => F.resolveApiFor() },
        { id: 'proxy-preset-override-model', desc: '同上 + override {model:"ov-model"} → o.model 优先于 cfg.model 与预设 model',
            set: { apiType: 'preset', proxyPreset: 'P1', model: 'cfg-model' }, call: () => F.resolveApiFor({ model: 'ov-model' }) },
        { id: 'proxy-preset-cfg-model-empty', desc: '同上但 cfg.model="" → 回落预设 settings.model',
            set: { apiType: 'preset', proxyPreset: 'P1', model: '' }, call: () => F.resolveApiFor() },
        { id: 'proxy-preset-getPreset-null', desc: 'getPreset(name) 返回 null → 静默回落主配置（apiType 仍为 "preset"）',
            set: { apiType: 'preset', proxyPreset: 'P1' }, preset: 'null', call: () => F.resolveApiFor() },
        { id: 'proxy-preset-getPreset-throws', desc: 'getPreset 抛错 → 被 catch 吞掉，回落主配置',
            set: { apiType: 'preset', proxyPreset: 'P1' }, preset: 'throw', call: () => F.resolveApiFor() },
        { id: 'proxy-preset-no-apiurl', desc: '预设 settings 无 apiurl → 不满足 `if (s.apiurl)`，回落主配置',
            set: { apiType: 'preset', proxyPreset: 'P1' }, preset: 'noapiurl', call: () => F.resolveApiFor() },
        { id: 'proxy-preset-interface-missing', desc: 'window.TavernHelper 不可用（getFn 取不到 getPreset）→ 回落主配置',
            set: { apiType: 'preset', proxyPreset: 'P1' }, preset: 'missing', call: () => F.resolveApiFor() },
        { id: 'proxy-preset-only-when-apiType-preset', desc: 'apiType="custom" 时即使 proxyPreset 有值也不查预设（仍用主配置 url/key）',
            set: { apiType: 'custom', proxyPreset: 'P1' }, call: () => F.resolveApiFor() },
        { id: 'override-inline-url-key-model', desc: 'override 显式 apiUrl/apiKey/model → 覆盖主配置（URL 去尾斜杠、key trim）',
            set: {}, call: () => F.resolveApiFor({ apiUrl: 'https://ov.example/v1///', apiKey: '  sk-ov  ', model: 'ov-model' }) },
        { id: 'override-partial-model-only', desc: 'override 仅 {model} → url/key 仍取主配置',
            set: {}, call: () => F.resolveApiFor({ model: 'only-model' }) },
        { id: 'override-apiType-preset-with-inline-fields', desc: 'override 指定 apiType="preset" + proxyPreset="P1" → 走预设分支（cfg.apiType 无关）',
            set: {}, call: () => F.resolveApiFor({ apiType: 'preset', proxyPreset: 'P1' }) },
        { id: 'null-and-undefined-override', desc: 'resolveApiFor(null) 与 resolveApiFor() 等价',
            set: {}, call: () => ({ nullArg: F.resolveApiFor(null), undefinedArg: F.resolveApiFor(undefined) }) },
        { id: 'empty-cfg-url', desc: '主配置 url 为空 → 返回 url:""（不抛错；是否报错由调用方决定）',
            set: { apiUrl: '', apiKey: '', model: '' }, call: () => F.resolveApiFor() },
    ];
    for (const c of resolveCases) {
        resetApiCfg();
        presetImpl = c.preset || 'ok';
        for (const k of Object.keys(c.set || {})) F.cfg[k] = c.set[k];
        let out, err = null;
        try { out = proj(c.call()); } catch (e) { out = null; err = String((e && e.message) || e); }
        result.resolve.apiFor.cases.push({ id: c.id, desc: c.desc, presetImpl: c.preset || 'ok', cfg: resolveCfgSnap(), override: null, out, error: err });
    }
    // override 回填（便于阅读）：从 cases 里挑出带 override 的补记
    const ovById = {
        'explicit-preset-from-activeApiPreset': { preset: 'A' },
        'override-preset-A': { preset: 'A' },
        'override-preset-A-ignores-inline-fields': { preset: 'A', apiUrl: 'https://ov.example/v1', apiKey: 'sk-ov', model: 'ov-model' },
        'override-preset-preserves-preset-apiType': { preset: 'B' },
        'override-preset-unknown': { preset: 'ghost' },
        'override-preset-empty-string': { preset: '' },
        'proxy-preset-override-model': { model: 'ov-model' },
        'override-inline-url-key-model': { apiUrl: 'https://ov.example/v1///', apiKey: '  sk-ov  ', model: 'ov-model' },
        'override-partial-model-only': { model: 'only-model' },
        'override-apiType-preset-with-inline-fields': { apiType: 'preset', proxyPreset: 'P1' },
        'null-and-undefined-override': 'null / undefined / 省略',
    };
    for (const c of result.resolve.apiFor.cases) if (ovById[c.id] !== undefined) c.override = ovById[c.id];

    // ---- resolveKw/Mem/ParallelApiOverride：经真实调用链捕获真实请求 ----
    const tryProbe = async (fn) => { try { const v = await fn(); return { ok: true, value: proj(v) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } };
    net.set(() => ({ choices: [{ message: { content: '["k1","k2"]' } }] }));
    resetApiCfg();
    // 记录 extract/mem/parallel 的场景
    const ovCases = [
        { id: 'kw-unconfigured-follow-main', probe: 'extractKeywordsFromText', desc: 'kw 未配置（Enabled=false 且无 Preset）→ override {preset: undefined} → 用主配置',
            set: { kwApiEnabled: false, kwApiPreset: '', activeApiPreset: '' } },
        { id: 'kw-enabled-custom', probe: 'extractKeywordsFromText', desc: 'kw 仅 Enabled + 自定义独立配置 → 用 kwApi 的 url/key/model',
            set: { kwApiEnabled: true, kwApiPreset: '', kwApi: { apiType: 'custom', apiUrl: 'https://kw.example/v1', apiKey: 'sk-kw', model: 'kw-model', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'kw-enabled-custom-empty-url', probe: 'extractKeywordsFromText', desc: 'kw 仅 Enabled 但自定义配置 url 为空 → override 照旧返回该空配置 → 请求失败（不发 fetch）',
            set: { kwApiEnabled: true, kwApiPreset: '', kwApi: { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'kw-only-preset-exists', probe: 'extractKeywordsFromText', desc: 'kw 仅 Preset="A"（分组存在）→ override {preset:"A"}',
            set: { kwApiEnabled: false, kwApiPreset: 'A', activeApiPreset: '' } },
        { id: 'kw-preset-unknown-follow-main', probe: 'extractKeywordsFromText', desc: 'kw Preset="ghost"（分组不存在）+ activeApiPreset="" → 回落主配置',
            set: { kwApiEnabled: false, kwApiPreset: 'ghost', activeApiPreset: '' } },
        { id: 'kw-preset-unknown-with-active', probe: 'extractKeywordsFromText', desc: 'kw Preset="ghost" + activeApiPreset="A" → 回落 activeApiPreset="A"',
            set: { kwApiEnabled: false, kwApiPreset: 'ghost', activeApiPreset: 'A' } },
        { id: 'kw-preset-beats-enabled', probe: 'extractKeywordsFromText', desc: 'kw Preset="A" 且 Enabled=true → **Preset 优先**（enabled 分支不生效）',
            set: { kwApiEnabled: true, kwApiPreset: 'A', kwApi: { apiType: 'custom', apiUrl: 'https://kw.example/v1', apiKey: 'sk-kw', model: 'kw-model', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'mem-unconfigured-follow-main', probe: 'analyzeMemorySend', desc: 'mem 未配置 → 用主配置',
            set: { memApiEnabled: false, memApiPreset: '', activeApiPreset: '' } },
        { id: 'mem-enabled-custom', probe: 'analyzeMemorySend', desc: 'mem 仅 Enabled + 自定义 → 用 memApi',
            set: { memApiEnabled: true, memApiPreset: '', memApi: { apiType: 'custom', apiUrl: 'https://mem.example/v1', apiKey: 'sk-mem', model: 'mem-model', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'mem-only-preset-exists', probe: 'analyzeMemorySend', desc: 'mem 仅 Preset="A" → override {preset:"A"}',
            set: { memApiEnabled: false, memApiPreset: 'A', activeApiPreset: '' } },
        { id: 'mem-preset-unknown-follow-main', probe: 'analyzeMemorySend', desc: 'mem Preset="ghost" + active 空 → 用主配置',
            set: { memApiEnabled: false, memApiPreset: 'ghost', activeApiPreset: '' } },
        { id: 'parallel-preset-exists', probe: 'runParallelWeave', desc: 'parallelApiPreset="B"（分组存在）→ override {preset:"B"}',
            set: { parallelApiPreset: 'B', activeApiPreset: '' } },
        { id: 'parallel-preset-unknown-follow-active', probe: 'runParallelWeave', desc: 'parallelApiPreset="ghost" + activeApiPreset="A" → 回落 activeApiPreset="A"',
            set: { parallelApiPreset: 'ghost', activeApiPreset: 'A' } },
        { id: 'parallel-preset-unknown-follow-main', probe: 'runParallelWeave', desc: 'parallelApiPreset="ghost" + active 空 → 用主配置',
            set: { parallelApiPreset: 'ghost', activeApiPreset: '' } },
        { id: 'parallel-no-custom-branch', probe: 'runParallelWeave', desc: 'parallelApiPreset 留空且无 activeApiPreset → 用主配置（V1 平行渠道**没有**自定义独立配置分支）',
            set: { parallelApiPreset: '', activeApiPreset: '' } },
    ];
    for (const c of ovCases) {
        resetApiCfg();
        for (const k of Object.keys(c.set)) F.cfg[k] = c.set[k];
        net.reset();
        net.set(() => ({ choices: [{ message: { content: c.probe === 'extractKeywordsFromText' ? '["k1","k2"]' : (c.probe === 'runParallelWeave' ? '{"平行事件":{}}' : 'mem-out') } }] }));
        const before = pluginToasts(F).length;
        let r;
        if (c.probe === 'extractKeywordsFromText') r = await tryProbe(() => F.extractKeywordsFromText('正文甲'));
        else if (c.probe === 'analyzeMemorySend') r = await tryProbe(() => F.analyzeMemorySend(['k1'], '正文甲'));
        else r = await tryProbe(() => F.runParallelWeave({ start: 0, end: 1 }, { keywords: ['k1'], force: true }));
        result.resolve.overrides.cases.push({
            id: c.id, probe: c.probe, desc: c.desc, cfg: overrideCfgSnap(),
            fetches: net.calls.length, requests: net.view(), result: r,
            toasts: pluginToasts(F).slice(before).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
        });
    }

    // ---- groupEffectiveText（V1 自带人类可读解析）真实渲染 ----
    for (const c of [
        { id: 'follow-main', desc: 'kw/mem 均未配置 → 跟随主配置', set: { kwApiEnabled: false, kwApiPreset: '', memApiEnabled: false, memApiPreset: '', activeApiPreset: '' } },
        { id: 'kw-enabled-empty', desc: 'kw Enabled 但自定义 url 为空 → 仍报「自定义独立配置（未配置 API 地址）」', set: { kwApiEnabled: true, kwApiPreset: '', kwApi: { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'kw-enabled-with-url', desc: 'kw Enabled + 有 url → 自定义独立配置 → url / model', set: { kwApiEnabled: true, kwApiPreset: '', kwApi: { apiType: 'custom', apiUrl: 'https://kw.example/v1', apiKey: 'sk-kw', model: 'kw-model', proxyPreset: '' }, activeApiPreset: '' } },
        { id: 'kw-preset-A', desc: 'kw Preset="A" → 预设「A」→ url / model', set: { kwApiEnabled: false, kwApiPreset: 'A', activeApiPreset: '' } },
        { id: 'kw-preset-ghost-with-active', desc: 'kw Preset="ghost" + active="A" → 预设「A」（回落 activeApiPreset）', set: { kwApiEnabled: false, kwApiPreset: 'ghost', activeApiPreset: 'A' } },
        { id: 'main-url-empty', desc: '主配置 url 为空 → 「（未配置 API 地址）」', set: { apiUrl: '', kwApiEnabled: false, kwApiPreset: '', activeApiPreset: '' } },
    ]) {
        resetApiCfg();
        for (const k of Object.keys(c.set)) F.cfg[k] = c.set[k];
        F.setSettingsSub('extract');
        const h = F.settingsHtml();
        const strip = (x) => stripTags(x);
        result.resolve.groupPreview.cases.push({
            id: c.id, desc: c.desc, cfg: overrideCfgSnap(),
            kw: strip(grab(h, /<div class="ftt-muted" data-ftt-group-preview="kw">([\s\S]*?)<\/div>/)),
            mem: strip(grab(h, /<div class="ftt-muted" data-ftt-group-preview="mem">([\s\S]*?)<\/div>/)),
        });
    }
    F.setSettingsSub('api');

    // ============================================================
    // 2. apiBlockHtml
    // ============================================================
    resetApiCfg();
    F.cfg.apiType = 'custom'; F.cfg.apiUrl = 'https://a.example/v1'; F.cfg.apiKey = 'k'; F.cfg.model = 'm'; F.cfg.proxyPreset = '';
    F.cfg.embeddingUrl = 'https://e.example/v1'; F.cfg.embeddingKey = ''; F.cfg.embeddingModel = 'em'; F.cfg.embeddingProxyPreset = '';
    F.cfg.apiPresets = {};   // 与 apiPage（面板真实渲染）同基线，便于逐字对照
    F.setSettingsSub('api');
    const apiPageHtml = F.settingsHtml();
    F.setSettingsSub('extract');
    const extractHtml = F.settingsHtml();
    F.setSettingsSub('analyze');
    const analyzeHtml = F.settingsHtml();
    F.setSettingsSub('api');

    const mainSeg = blockForPfx(apiPageHtml, 'main');
    const embSeg = blockForPfx(extractHtml, 'emb');
    const rerankSeg = blockForPfx(extractHtml, 'rerank');
    const kwSeg = blockForPfx(extractHtml, 'kw');
    const memSeg = blockForPfx(extractHtml, 'mem');

    result.apiBlockHtml = {
        note: 'apiBlockHtml 未导出 → 一律取 `setSettingsSub(...) + settingsHtml()` 的**真实渲染 HTML**，'
            + '按 `<div class="ftt-api-block">` 切段后投影（fields/buttons/notes/resultSpanId/rawHtml）。'
            + ' main 段来自设定子页「API 设定」（调用点 v1.206:25541，showParams=true）；'
            + ' emb/rerank 段来自设定子页「提取记忆」（调用点 25643/25646，showParams 省略=不渲染 OpenAI 兼容参数）；'
            + ' kw/mem 段来自「提取记忆」页 groupStrategyHtml 内嵌的 apiBlockHtml（调用点 24607）。',
        renderSources: {
            apiSubPage: { via: "F.setSettingsSub('api') + F.settingsHtml()", htmlLength: apiPageHtml.length, mainCallSite: "apiBlockHtml('main', '主摘要 API', {apiType,apiUrl,apiKey,model,proxyPreset}, 'chat', true)" },
            extractSubPage: { via: "F.setSettingsSub('extract') + F.settingsHtml()", htmlLength: extractHtml.length, embCallSite: "apiBlockHtml('emb', 'Embedding API', {apiUrl:embeddingUrl,apiKey:embeddingKey,model:embeddingModel,proxyPreset:embeddingProxyPreset}, 'embedding')", rerankCallSite: "apiBlockHtml('rerank', 'Rerank API', {...}, 'rerank')", kwMemCallSite: "groupStrategyHtml('kw'|'mem') → apiBlockHtml('kw'|'mem', ...)" },
            analyzeSubPage: { via: "F.setSettingsSub('analyze') + F.settingsHtml()", htmlLength: analyzeHtml.length, note: 'dimensionRowsHtml 的真实渲染所在子页（未导出 → 见 extras.dimensionRows）' },
        },
        main: mainSeg ? projApiBlock(mainSeg, true) : null,
        emb: embSeg ? projApiBlock(embSeg, true) : null,
        extras: {
            rerank: rerankSeg ? projApiBlock(rerankSeg, true) : null,
            kw: kwSeg ? projApiBlock(kwSeg, true) : null,
            mem: memSeg ? projApiBlock(memSeg, true) : null,
            dimensionRows: {
                note: 'dimensionRowsHtml 未导出 → 取「分析记忆」子页真实渲染里 `data-ftt-dim-enable` / `data-ftt-dim-preset` 控件投影',
                rows: grabAll(analyzeHtml, /<div class="ftt-dim-row">/g).length,
                enableKeys: grabAll(analyzeHtml, /data-ftt-dim-enable="([^"]*)"/g).map((m) => m[1]),
                presetKeys: grabAll(analyzeHtml, /data-ftt-dim-preset="([^"]*)"/g).map((m) => m[1]),
                firstRowHtml: analyzeHtml.indexOf('<div class="ftt-dim-row">') < 0 ? null : balancedDiv(analyzeHtml.slice(analyzeHtml.indexOf('<div class="ftt-dim-row">'))),
            },
            apiPresetSelectHtml: {
                note: 'apiPresetSelectHtml **未导出且在 v1.206 无任何调用方（死代码）** → 无真实渲染产物可投影，仅存源码片段',
                references: (SRC.match(/apiPresetSelectHtml/g) || []).length,
                sourceSnip: result.meta.v1SourceSnips.apiPresetSelectHtml,
            },
        },
    };

    // ============================================================
    // 3. apiPage（真实面板 + 真实点击设定子标签） + presetActions（真实点击委托）
    // ============================================================
    resetApiCfg();
    F.cfg.apiType = 'custom'; F.cfg.apiUrl = 'https://a.example/v1'; F.cfg.apiKey = 'k'; F.cfg.model = 'm'; F.cfg.proxyPreset = '';
    F.cfg.apiPresets = {};
    F.openPanel();
    const panel = env.parentWin.document.body.children.find((c) => c.id === 'ftt-panel');
    if (!panel) throw new Error('未找到 #ftt-panel');
    const listeners = (panel.listeners && panel.listeners.click) ? panel.listeners.click : [];
    const shadow = makePanelDom(panel);
    shadow.reparse();
    let usedDom = shadow.dom;
    const clickFake = async (ds, cls) => {
        const classes = ['ftt-open'].concat(cls || []);
        const keep = panel.classList.contains;
        panel.classList.contains = (c) => (classes.indexOf(c) >= 0 ? true : keep.call(panel, c));
        const fake = {
            target: { dataset: ds, classList: { contains: (c) => classes.indexOf(c) >= 0 }, closest: () => panel, tagName: 'A' },
            preventDefault() { }, stopPropagation() { },
        };
        usedDom = shadow.dom;
        try { for (const fn of listeners) { try { await fn(fake); } catch (e) { /* 与 V1 委托同容错 */ } } }
        finally { panel.classList.contains = keep; }
        shadow.reparse();
        return usedDom;
    };
    const dispatch = (type, target) => { for (const fn of (panel.listeners[type] || [])) { try { fn({ target }); } catch (e) { } } };
    const panelHtmlNow = () => String(panel.innerHTML || '');
    let setLog = [];   // 本步对各控件赋值的留痕（证明「点击时 DOM 里到底是什么值」）
    // 输入控件赋值：SELECT 按浏览器语义校验（无此 option → 落回 ''），INPUT 直接赋值
    const inputs = (ds, val) => {
        const el = shadow.qs('[data-ftt-cfg="' + ds + '"]');
        if (!el) { setLog.push({ sel: '[data-ftt-cfg="' + ds + '"]', requested: val, applied: null, missingElement: true }); return el; }
        if (el.tagName === 'SELECT') el.value = el.options.some((o) => o.value === val) ? val : '';
        else el.value = val;
        setLog.push({ sel: '[data-ftt-cfg="' + ds + '"]', requested: val, applied: el.value });
        return el;
    };
    // 绕过浏览器校验的直接赋值（模拟「陈旧 DOM / 代码侧状态分歧」：select 仍持有一个已被删除的分组名）
    const inputsRaw = (ds, val) => {
        const el = shadow.qs('[data-ftt-cfg="' + ds + '"]');
        if (el) el.value = val;
        setLog.push({ sel: '[data-ftt-cfg="' + ds + '"]', requested: val, applied: el ? el.value : null, bypassSelectValidation: true });
        return el;
    };
    const apiInput = (pfx, key, val) => {
        const el = shadow.qs('[data-ftt-api="' + pfx + '"][data-ftt-api-key="' + key + '"]');
        if (el) el.value = val;
        setLog.push({ sel: '[data-ftt-api="' + pfx + '"][data-ftt-api-key="' + key + '"]', requested: val, applied: el ? el.value : null });
        return el;
    };

    await clickFake({ fttTab: 'settings' }, ['ftt-tab']);
    await clickFake({ fttSubtab: 'api' }, ['ftt-subtab']);
    const apiPagePanelHtml = panelHtmlNow();

    result.apiPage = {
        note: '取自真实 `F.openPanel()` + 真实点击委托（`ftt-tab`=settings → `ftt-subtab`=api）后的 `panel.innerHTML`。'
            + ' 与 settingsHtml()（setSettingsSub("api")）渲染一致，可互为对照。'
            + ' mock document 的 innerHTML 不参与 DOM 查询，故 `panel` 的 querySelector/querySelectorAll 由本脚本的 HTML 影子模型应答（见 meta.evidence.presetActions）。',
        panelHtmlLength: apiPagePanelHtml.length,
        settingsBodyLength: settingsBodyOf(apiPagePanelHtml).length,
        projection: projApiSubPage(apiPagePanelHtml, true),
        projectionFromSettingsHtml: projApiSubPage(apiPageHtml),
        panelsAgreeOnSubBody: apiSubBodyOf(apiPagePanelHtml) === apiSubBodyOf(apiPageHtml),
    };

    // ---- presetActions：真实点击委托 ----
    const steps = [];
    const domVal = (sel) => { const el = shadow.qs(sel); return el ? el.value : null; };
    const domOptions = (sel) => { const el = shadow.qs(sel); return el ? el.options.map((o) => o.value) : null; };
    const step = async (name, ds, cls, mutate) => {
        shadow.reparse();
        setLog = [];
        if (mutate) mutate();
        const inputsSet = proj(setLog);
        const t0 = pluginToasts(F).length;
        const used = await clickFake(ds, cls);
        const grabEl = (id) => used.find((e) => e.id === id) || null;
        const snap = {
            name,
            clicked: ds,
            inputsSet,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
            cfg: apiCfgSnap(),
            presetNameDomValue: domVal('[data-ftt-cfg="presetName"]'),
            presetSelectDomValue: domVal('[data-ftt-cfg="presetSelect"]'),
            presetSelectOptions: domOptions('[data-ftt-cfg="presetSelect"]'),
            hasCfgPresetName: Object.prototype.hasOwnProperty.call(F.cfg, 'presetName'),
            hasCfgPresetSelect: Object.prototype.hasOwnProperty.call(F.cfg, 'presetSelect'),
        };
        if (name.indexOf('apiTest') >= 0 || name.indexOf('apiModels') >= 0) {
            const res = grabEl('ftt-api-result-main');
            if (res) snap.resultText = normMs(res.textContent);
            const sel = (used.find((e) => e.dataset.fttApi === 'main' && e.dataset.fttApiKey === 'modelSelect'));
            if (sel) snap.modelSelectInnerHtml = sel.innerHTML;
        }
        if (name.indexOf('savecfg') === 0) {
            snap.cfgAfter = { feedWorldbooks: proj(F.cfg.feedWorldbooks), feedWorldbookEntries: proj(F.cfg.feedWorldbookEntries), kwApiEnabled: F.cfg.kwApiEnabled, kwApiPreset: F.cfg.kwApiPreset, memApiEnabled: F.cfg.memApiEnabled, memApiPreset: F.cfg.memApiPreset, apiTemperature: F.cfg.apiTemperature, apiMaxTokens: F.cfg.apiMaxTokens, apiTopP: F.cfg.apiTopP };
        }
        steps.push(snap);
    };

    steps.push({ name: '面板打开 + API 子页渲染（初始态）', clicked: null, toasts: [], cfg: apiCfgSnap(), presetNameDomValue: domVal('[data-ftt-cfg="presetName"]'), presetSelectDomValue: domVal('[data-ftt-cfg="presetSelect"]'), presetSelectOptions: domOptions('[data-ftt-cfg="presetSelect"]'), hasCfgPresetName: false, hasCfgPresetSelect: false });
    await step('presetSave · 分组名为空 → 拒绝', { fttAction: 'presetSave' }, [], () => { inputs('presetName', ''); });
    await step('presetSave · 名称含前后空白 "  A  " + 主 API 值 → 保存（trim 落库）', { fttAction: 'presetSave' }, [], () => {
        inputs('presetName', '  A  ');
        apiInput('main', 'apiType', 'custom'); apiInput('main', 'apiUrl', 'https://a.example/v1');
        apiInput('main', 'apiKey', 'k'); apiInput('main', 'model', 'm'); apiInput('main', 'proxyPreset', '');
    });
    await step('presetSave · 改主 API model="m2" 后同名覆盖 A', { fttAction: 'presetSave' }, [], () => {
        inputs('presetName', 'A');
        apiInput('main', 'model', 'm2');
    });
    await step('presetSave · 再存第二个分组 B（主 API 换成 B 的值）', { fttAction: 'presetSave' }, [], () => {
        inputs('presetName', 'B');
        apiInput('main', 'apiUrl', 'https://b.example/v1'); apiInput('main', 'apiKey', 'sk-b'); apiInput('main', 'model', 'mb');
    });
    await step('presetLoad · 未选分组（select 首项为空）→ 拒绝', { fttAction: 'presetLoad' }, [], () => { inputs('presetSelect', ''); });
    await step('presetLoad · 选中 A → 主配置切换 + activeApiPreset=A', { fttAction: 'presetLoad' }, [], () => { inputs('presetSelect', 'A'); });
    await step('presetLoad · select 值为无关串 "ghost"（浏览器语义下不存在该 option → 落回首项 ""；此处用 raw 赋值模拟陈旧 DOM）→ 拒绝', { fttAction: 'presetLoad' }, [], () => { inputsRaw('presetSelect', 'ghost'); });
    await step('presetDelete · select 值为 "ghost"（同上 raw 陈旧 DOM）→ 拒绝', { fttAction: 'presetDelete' }, [], () => { inputsRaw('presetSelect', 'ghost'); });
    await step('presetDelete · 选中 B（activeApiPreset="A" 与被删名不符 → active 保留）', { fttAction: 'presetDelete' }, [], () => { inputs('presetSelect', 'B'); });
    await step('presetDelete · 选中 A（与被删名相符 → activeApiPreset 一并清空）', { fttAction: 'presetDelete' }, [], () => { inputs('presetSelect', 'A'); });
    await step('presetDelete · 已无分组（select 空）→ 拒绝', { fttAction: 'presetDelete' }, [], () => { inputs('presetSelect', ''); });
    await step('presetSave · 重建分组 A（为 savecfg 用例准备一个**非空且合法**的 select 值）', { fttAction: 'presetSave' }, [], () => {
        inputs('presetName', 'A');
        apiInput('main', 'apiType', 'custom'); apiInput('main', 'apiUrl', 'https://a.example/v1'); apiInput('main', 'apiKey', 'k'); apiInput('main', 'model', 'm'); apiInput('main', 'proxyPreset', '');
    });
    await step('savecfg · 面板上 presetName="ZZ" + presetSelect="A"（合法非空）+ apiTemperature="0.9"/apiMaxTokens="123" 时点「保存设置」→ preset* 两键不写 cfg、api* 三参数也不写 cfg；并记录 API 子页保存的副作用', { fttAction: 'savecfg' }, [], () => {
        inputs('presetName', 'ZZ');
        inputs('presetSelect', 'A');
        inputs('apiTemperature', '0.9');
        inputs('apiMaxTokens', '123');
        F.cfg.feedWorldbooks = ['预置世界书'];
    });
    // settingsAutoApply 跳过路径（change 事件真实派发）
    {
        shadow.reparse();
        inputs('presetName', 'AUTO');
        inputs('presetSelect', 'A');
        let el = shadow.qs('[data-ftt-cfg="presetName"]');
        const presetCfgKeys = () => ['activeApiPreset', 'kwApiPreset', 'memApiPreset', 'parallelApiPreset'].filter((k) => Object.prototype.hasOwnProperty.call(F.cfg, k)).map((k) => k + '=' + JSON.stringify(F.cfg[k]));
        const t0 = pluginToasts(F).length;
        dispatch('change', el);
        const afterName = { hasCfgPresetName: Object.prototype.hasOwnProperty.call(F.cfg, 'presetName'), presetRelatedCfg: presetCfgKeys(), toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })) };
        el = shadow.qs('[data-ftt-cfg="presetSelect"]');
        dispatch('change', el);
        const afterSel = { hasCfgPresetSelect: Object.prototype.hasOwnProperty.call(F.cfg, 'presetSelect'), presetRelatedCfg: presetCfgKeys(), toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })) };
        result.presetActions = {
            note: '全部为**真实点击委托**（openPanel() 后在 panel.listeners.click 派发伪事件 → V1 handleAction 真实执行）；'
                + '控件值写入「按真实渲染 HTML 解析的面板 DOM 影子」，V1 的 panelEl.querySelector(...) 由影子应答。'
                + ' 每步记录 cfg.apiPresets（深拷贝）/activeApiPreset/主 API 字段、pluginToasts、以及 DOM 中 presetName/presetSelect 的当前值。',
            domShadow: { note: 'mock document 无 HTML 解析器 → 本脚本实现最小影子（value/dataset/type/.checked/.closest/.classList/select options+selected 回落首项）', presetNameWriteToCfg: false, presetSelectWriteToCfg: false },
            steps,
            autoApplySkip: {
                note: '真实派发 change 事件到 presetName / presetSelect → settingsAutoApply 命中 `[\'presetName\',\'presetSelect\'].includes(key)` 提前 return',
                presetName: afterName, presetSelect: afterSel,
            },
        };
    }

    // ============================================================
    // 4. netSemantics
    // ============================================================
    resetApiCfg();
    net.set(() => ({ choices: [{ message: { content: 'ok' } }] }));
    const netSem = { note: '', stubNote: '', testApi: {}, endpointSuffixRules: [], errors: {}, httpErrors: {}, fetchModels: {}, uiDelegation: {} };
    netSem.note = '全部为**真实请求捕获**：testApi/fetchModels 为 __FTT 导出直调；'
        + ' resolveKw/Mem/ParallelApiOverride 经真实调用链（extractKeywordsFromText / analyzeMemorySend / runParallelWeave）间接取证，见 resolve.overrides；'
        + ' apiTest/apiModels 走真实点击委派，见 netSemantics.uiDelegation。'
        + ' 「HTTP 失败」与「modelSelect 注入」等无法真实发生的网络结果按等价 Response 形态桩注入（每条都注明了注入内容）。';
    netSem.stubNote = '自实现 captureFetch：env.parentWin.fetch = async (url,opts)=>{ 记录 {url, method, headers, body(JSON.parse)}; 返回 makeResp(payload) 或原样返回 {ok,...} 对象 }'
        + '（等价 helpers.stubFetch，但**额外记录 headers**，因 stubFetch 的 rec 只含 url/method/body）。D.fetch === window.parent.fetch === env.parentWin.fetch。';
    const req = async (fn) => { net.reset(); const r = await fn(); return { request: net.view(), result: r }; };

    // testApi 三 kind
    for (const [kind, ov] of [
        ['chat', { apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }],
        ['embedding', { apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }],
        ['rerank', { apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }],
    ]) {
        net.set(() => ({ choices: [{ message: { content: 'ok' } }] }));
        const r = await req(() => F.testApi(ov, kind));
        netSem.testApi[kind] = {
            input: { override: ov, kind },
            request: r.request[0],
            fetches: r.request.length,
            resultShape: r.result ? { ok: r.result.ok, kind: r.result.kind, msIsNumber: typeof r.result.ms === 'number' } : null,
        };
    }
    net.set(() => ({ choices: [{ message: { content: 'ok' } }] }));
    { const r = await req(() => F.testApi({ apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }, undefined)); netSem.testApi['kind-undefined'] = { desc: 'kind 省略 → 走 chat 分支且返回 kind:"chat"', request: r.request[0], resultShape: { ok: r.result.ok, kind: r.result.kind, msIsNumber: typeof r.result.ms === 'number' } }; }
    { const r = await req(() => F.testApi({ apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }, 'CHAT')); netSem.testApi['kind-CHAT-uppercase'] = { desc: 'kind="CHAT" 非 "embedding"/"rerank" → 仍走 chat 分支', request: r.request[0], resultShape: { ok: r.result.ok, kind: r.result.kind, msIsNumber: typeof r.result.ms === 'number' } }; }
    { net.reset(); const r = await req(() => F.testApi({ apiUrl: 'https://x.example/v1', apiKey: '', model: 'm' }, 'chat')); netSem.testApi['no-key'] = { desc: 'apiKey 为空 → 不发 Authorization 头，仍带 Content-Type', request: r.request[0] }; }

    // 端点后缀规则
    for (const [kind, urls] of [
        ['chat', ['https://x.example/v1', 'https://x.example/v1/', 'https://x.example/v1/chat/completions', 'https://x.example/v1/chat/completions/', 'https://x.example/v1/Chat/Completions', 'https://x.example/v1/models', 'https://x.example/v1/embeddings']],
        ['embedding', ['https://x.example/v1', 'https://x.example/v1/embeddings', 'https://x.example/v1/embeddings/', 'https://x.example/v1/EMBEDDINGS', 'https://x.example/v1/chat/completions']],
        ['rerank', ['https://x.example/v1', 'https://x.example/v1/rerank', 'https://x.example/v1/rerank/', 'https://x.example/v1/models']],
    ]) {
        for (const u of urls) {
            net.set(() => ({ choices: [{ message: { content: 'ok' } }] }));
            net.reset();
            await F.testApi({ apiUrl: u, apiKey: 'k', model: 'm' }, kind);
            netSem.endpointSuffixRules.push({ kind, inputUrl: u, endpoint: net.calls[0] ? net.calls[0].url : null });
        }
    }

    // 报错文案（逐字）
    netSem.errors = { note: '逐字记录真实 throw 的 e.message（url 检查先于模型检查）', cases: [] };
    for (const [kind, ov] of [
        ['chat', { apiUrl: '', apiKey: '', model: '' }],
        ['embedding', { apiUrl: '', apiKey: '', model: '' }],
        ['rerank', { apiUrl: '', apiKey: '', model: '' }],
        ['chat', { apiUrl: 'https://x.example/v1', apiKey: 'k', model: '' }],
        ['embedding', { apiUrl: 'https://x.example/v1', apiKey: 'k', model: '' }],
        ['rerank', { apiUrl: 'https://x.example/v1', apiKey: 'k', model: '' }],
        ['chat', { apiUrl: '   ', apiKey: 'k', model: 'm' }],
    ]) {
        net.reset();
        let err = null;
        try { await F.testApi(ov, kind); } catch (e) { err = String((e && e.message) || e); }
        netSem.errors.cases.push({ kind, override: ov, error: err, fetches: net.calls.length });
    }
    netSem.errors.fetchModelsCases = [];
    for (const ov of [{ apiUrl: '', apiKey: 'k' }, { apiUrl: '   ', apiKey: 'k' }]) {
        net.reset();
        let err = null;
        try { await F.fetchModels(ov); } catch (e) { err = String((e && e.message) || e); }
        netSem.errors.fetchModelsCases.push({ override: ov, error: err, fetches: net.calls.length });
    }
    // 非 200 → HTTP ${status}: ${text.slice(0,200)}
    for (const [kind, label] of [['chat', 'testApi.chat'], ['embedding', 'testApi.embedding'], ['rerank', 'testApi.rerank']]) {
        net.set(() => ({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'server boom', json: async () => ({}) }));
        let err = null;
        try { await F.testApi({ apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, kind); } catch (e) { err = String((e && e.message) || e); }
        netSem.httpErrors[label] = { injected: { ok: false, status: 500, statusText: 'Internal Server Error', text: 'server boom' }, error: err };
    }
    {
        const long = 'x'.repeat(300);
        net.set(() => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => long, json: async () => ({}) }));
        let err = null;
        try { await F.testApi({ apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, 'chat'); } catch (e) { err = String((e && e.message) || e); }
        netSem.httpErrors.truncation = { injectedTextLen: long.length, error: err, errorLen: err ? err.length : null, note: 'body 截断到 200 字符：`HTTP ${status}: ${text.slice(0,200)}`' };
    }
    {
        net.set(() => ({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => { throw new Error('no body'); }, json: async () => ({}) }));
        let err = null;
        try { await F.testApi({ apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, 'chat'); } catch (e) { err = String((e && e.message) || e); }
        netSem.httpErrors.textThrows = { injected: 'res.text() 抛错 → catch(() => res.statusText)', error: err };
    }

    // fetchModels
    netSem.fetchModels = { note: 'fetchModels 真实请求 + 解析/报错（data | models；id | model | name；trim + 过滤空）', cases: [] };
    const fmCases = [
        { id: 'data-id', payload: { data: [{ id: 'm1' }, { id: '  m2  ' }, { id: '' }, {}] }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'models-model', payload: { models: [{ model: 'a' }, { name: 'b' }, { id: 'c' }] }, ov: { apiUrl: 'https://x.example/models', apiKey: '' } },
        { id: 'data-wins-over-models', payload: { data: [{ id: 'd1' }], models: [{ id: 'x1' }] }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'models-not-array', payload: { models: 'oops' }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'empty-data', payload: { data: [] }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'all-blank-ids', payload: { data: [{ id: '   ' }, {}] }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'duplicates-kept', payload: { data: [{ id: 'dup' }, { id: 'dup' }] }, ov: { apiUrl: 'https://x.example/v1', apiKey: 'k' } },
        { id: 'models-with-models-suffix-and-no-key', payload: { data: [{ id: 'z' }] }, ov: { apiUrl: 'https://x.example/v1/models', apiKey: '' } },
    ];
    for (const c of fmCases) {
        net.set(() => proj(c.payload));
        net.reset();
        let out = null, err = null;
        try { out = proj(await F.fetchModels(c.ov)); } catch (e) { err = String((e && e.message) || e); }
        netSem.fetchModels.cases.push({ id: c.id, payload: proj(c.payload), override: c.ov, request: net.view()[0] || null, fetches: net.calls.length, models: out, error: err });
    }
    {
        net.set(() => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'no model list', json: async () => ({}) }));
        net.reset();
        let err = null;
        try { await F.fetchModels({ apiUrl: 'https://x.example/v1', apiKey: 'k' }); } catch (e) { err = String((e && e.message) || e); }
        netSem.fetchModels.non200 = { injected: { ok: false, status: 404, statusText: 'Not Found', text: 'no model list' }, error: err, request: net.view()[0] };
    }

    // ---- UI 委派：apiTest / apiModels 真实点击 ----
    await clickFake({ fttSubtab: 'api' }, ['ftt-subtab']);
    const uiSteps = [];
    const setMainDom = () => {
        shadow.reparse();
        apiInput('main', 'apiType', 'custom'); apiInput('main', 'apiUrl', 'https://x.example/v1'); apiInput('main', 'apiKey', 'sk-1'); apiInput('main', 'model', 'm'); apiInput('main', 'proxyPreset', '');
    };
    const domApiNow = () => {
        const g = (k) => { const el = shadow.qs('[data-ftt-api="main"][data-ftt-api-key="' + k + '"]'); return el ? el.value : null; };
        return { apiType: g('apiType'), apiUrl: g('apiUrl'), apiKey: g('apiKey'), model: g('model'), proxyPreset: g('proxyPreset'), modelSelect: g('modelSelect') };
    };
    {
        setMainDom();
        net.set(() => ({ choices: [{ message: { content: 'ok' } }] }));
        net.reset();
        const t0 = pluginToasts(F).length;
        const used = await clickFake({ fttAction: 'apiTest', fttApiPfx: 'main', fttApiKind: 'chat' }, []);
        await new Promise((r) => setTimeout(r, 30));
        const res = used.find((e) => e.id === 'ftt-api-result-main');
        uiSteps.push({
            action: 'apiTest', dataset: { fttAction: 'apiTest', fttApiPfx: 'main', fttApiKind: 'chat' },
            domApiValuesAtClick: domApiNow(),
            request: net.view()[0] || null,
            resultText: res ? normMs(res.textContent) : null,
            resultColor: res && res.style ? res.style.color || null : null,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: normMs(t.text) })),
        });
    }
    {
        setMainDom();
        net.set(() => ({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'boom', json: async () => ({}) }));
        net.reset();
        const t0 = pluginToasts(F).length;
        const used = await clickFake({ fttAction: 'apiTest', fttApiPfx: 'main', fttApiKind: 'chat' }, []);
        await new Promise((r) => setTimeout(r, 30));
        const res = used.find((e) => e.id === 'ftt-api-result-main');
        uiSteps.push({
            action: 'apiTest(HTTP 500)', domApiValuesAtClick: domApiNow(), request: net.view()[0] || null,
            resultText: res ? res.textContent : null, resultColor: res && res.style ? res.style.color || null : null,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
        });
    }
    {
        setMainDom();
        net.set(() => ({ data: [{ id: 'm1' }, { id: 'm2' }] }));
        net.reset();
        const t0 = pluginToasts(F).length;
        const used = await clickFake({ fttAction: 'apiModels', fttApiPfx: 'main', fttApiKind: 'chat' }, []);
        await new Promise((r) => setTimeout(r, 30));
        const sel = used.find((e) => e.dataset.fttApi === 'main' && e.dataset.fttApiKey === 'modelSelect');
        uiSteps.push({
            action: 'apiModels', domApiValuesAtClick: domApiNow(), request: net.view()[0] || null,
            modelSelectInnerHtml: sel ? sel.innerHTML : null,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
        });
    }
    {
        setMainDom();
        net.set(() => ({ data: [] }));
        net.reset();
        const t0 = pluginToasts(F).length;
        const used = await clickFake({ fttAction: 'apiModels', fttApiPfx: 'main', fttApiKind: 'chat' }, []);
        await new Promise((r) => setTimeout(r, 30));
        const sel = used.find((e) => e.dataset.fttApi === 'main' && e.dataset.fttApiKey === 'modelSelect');
        uiSteps.push({
            action: 'apiModels(空列表)', domApiValuesAtClick: domApiNow(), request: net.view()[0] || null,
            modelSelectInnerHtml: sel ? sel.innerHTML : null,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
        });
    }
    netSem.uiDelegation = {
        note: 'apiTest/apiModels 的真实点击委派（handleAction 为 async：点击后等 30ms 让 testApi/fetchModels 落定）。'
            + ' `collectApiBlock(pfx)` 从面板 DOM 读值（跳过 data-ftt-api-key="modelSelect"）；'
            + ' 结果写回 `#ftt-api-result-${pfx}` 的 textContent/style.color + notify/toast。'
            + ' 非确定的 `\\d+ms` 已归一为 `<n>ms`。',
        steps: uiSteps,
    };
    result.netSemantics = netSem;

    // ============================================================
    // 5. quirks
    // ============================================================
    result.quirks = [
        { id: 'q01', quirk: '`resolveApiFor` 三个返回分支都对日志里的 url 做 `String(...).trim().replace(/\\/+$/,"")`（去尾斜杠），key/model 只 `.trim()`。', evidence: 'v1.206:2449 / 2456 / 2459；resolve.apiFor.cases[main-custom-trailing-slash, main-custom-multi-slash-and-space, override-inline-url-key-model]' },
        { id: 'q02', quirk: '`resolveApiFor` **完全不读 `cfg.activeApiPreset`** —— 无 override 时永远用主配置；activeApiPreset 只在 resolveKw/Mem/ParallelApiOverride 里作为兜底 preset 名出现。', evidence: 'v1.206:2445-2460；cases[no-override-reads-activeApiPreset, explicit-preset-from-activeApiPreset]' },
        { id: 'q03', quirk: 'override 命中已存分组（`o.preset` 且 `cfg.apiPresets[o.preset]`）时，**override 的 apiUrl/apiKey/model 一律被忽略**，返回值完全来自分组。', evidence: 'v1.206:2447-2449；cases[override-preset-A-ignores-inline-fields]' },
        { id: 'q04', quirk: '分组值 `apiType` 原样保留（`pr.apiType || "custom"`）—— 分组可存 apiType="preset"，此时返回值 apiType="preset" 但 url/key/model 取的是该分组自己的字段。', evidence: 'v1.206:2449；cases[override-preset-preserves-preset-apiType]' },
        { id: 'q05', quirk: '代理预设分支的模型优先级是 `o.model || cfg.model || 预设 settings.model`（cfg.model 压过预设 model）；而 key **只能**来自预设 settings.key（override apiKey 无效）。', evidence: 'v1.206:2456；cases[proxy-preset, proxy-preset-override-model, proxy-preset-cfg-model-empty]' },
        { id: 'q06', quirk: 'getPreset 取不到 / 抛错 / 预设无 apiurl 时**静默回落主配置**（三个 try/catch 全吞异常），但返回值里 apiType 仍是 "preset"。', evidence: 'v1.206:2453-2458；cases[proxy-preset-getPreset-null, -getPreset-throws, -no-apiurl, -interface-missing]' },
        { id: 'q07', quirk: '`testApi` 的错误检查顺序：先判 url（三种 kind 都是「未配置 API 地址」），再判模型（chat=「未配置模型」/ embedding=「未配置 Embedding 模型」/ rerank=「未配置 Rerank 模型」）。url 与 model 同时缺失时报 url 错。', evidence: 'v1.206:2479-2500；netSemantics.errors.cases' },
        { id: 'q08', quirk: '`testApi` 返回 `{ok, ms, kind}`，其中 ms 是挂钟耗时（不可复现）；chat 分支把 kind 规范成字面量 `"chat"`（kind 省略或传 "CHAT" 都得到 "chat"）。', evidence: 'v1.206:2488/2498/2507；netSemantics.testApi[kind-undefined, kind-CHAT-uppercase]' },
        { id: 'q09', quirk: '端点拼接规则：各 kind 只对自己的后缀去重，正则带 `i`；比较对象是**已去尾斜杠的 url**。故 `…/v1/models` 传给 rerank 会拼成 `…/v1/models/rerank`。', evidence: 'v1.206:2482/2492/2501/2512；netSemantics.endpointSuffixRules' },
        { id: 'q10', quirk: 'HTTP 失败文案统一为 ``HTTP ${res.status}: ${text.slice(0,200)}``；`res.text()` 抛错时回落 `res.statusText`。', evidence: 'v1.206:2487/2497/2506/2516；netSemantics.httpErrors' },
        { id: 'q11', quirk: '`fetchModels` 只发 `Authorization`（**不带 Content-Type**），method=GET；`testApi` 三个 kind 都带 `Content-Type: application/json`（apiKey 为空时不发 Authorization）。', evidence: 'v1.206:2513-2515 vs 2483-2484；netSemantics.fetchModels.cases / testApi.no-key' },
        { id: 'q12', quirk: '`fetchModels` 解析：`j.data` 优先于 `j.models`（都要求是数组）；id 取 `id || model || name`，逐项 `String().trim()` 后 `filter(Boolean)`（空项丢弃、重复保留）；全空 → throw「未解析到模型列表」。', evidence: 'v1.206:2517-2520；netSemantics.fetchModels.cases[data-wins-over-models, all-blank-ids, duplicates-kept]' },
        { id: 'q13', quirk: '`collectApiBlock(pfx)` 跳过 `data-ftt-api-key="modelSelect"`（下拉选择不成为 API 字段），只收 apiType/apiUrl/apiKey/model/proxyPreset。面板 change 事件里 modelSelect → model 输入框的复制是**独立**的一条路径。', evidence: 'v1.206:24712-24719、26224-26228；netSemantics.uiDelegation' },
        { id: 'q14', quirk: '`presetSave` 对分组名 `.trim()`，空名 → `toast("请输入预设名","warning")`；只存 `{apiType,apiUrl,apiKey,model,proxyPreset}`，**不设置 activeApiPreset**；保存后 `renderPanel()` 整页重渲染 → 刚输入的分组名从输入框消失。', evidence: 'v1.206:27373-27382；presetActions.steps 中 3 个 `presetSave ·` 步' },
        { id: 'q15', quirk: '`presetLoad` 要求 `presetSelect.value` 命中已有分组，否则 `toast("请选择要加载的预设","warning")`；成功时把分组值写进主配置并设 `activeApiPreset=name`。', evidence: 'v1.206:27384-27397；presetActions.steps 中 3 个 `presetLoad ·` 步' },
        { id: 'q16', quirk: '`presetDelete` **不弹确认**（源码注释明说「删除按钮不再弹确认，直接生效」）；成功时 toast 是 `toast("已删除","info")`（title 为空、kind=info），且仅当被删分组 === activeApiPreset 时才清空 activeApiPreset。', evidence: 'v1.206:27399-27408；presetActions.steps 中 4 个 `presetDelete ·` 步' },
        { id: 'q17', quirk: '`presetName` / `presetSelect` **永不写入 cfg**：settingsApplyAll 有显式跳过（与 rx_whitelist/rx_blacklist 同列），settingsAutoApply 也提前 return；实测 `hasOwnProperty(cfg,"presetName"/"presetSelect")` 恒为 false。', evidence: 'v1.206:26692、26280；presetActions.steps 中 `savecfg ·` 步 + presetActions.autoApplySkip' },
        { id: 'q18', quirk: '在「API」子页点「保存设置」会**顺带重置页面上不存在的控件**：分组策略控件（kw/mem）不在本页 → `applyGroupStrategy` 读到 null 走 "follow" 分支，`cfg.kwApiEnabled/memApiEnabled` 被清为 false、preset 清空；`cfg.feedWorldbooks` 也被清空（本页无世界书勾选框）。', evidence: 'v1.206:26578-26622；presetActions.steps 中 `savecfg ·` 步的 cfgAfter' },
        { id: 'q19', quirk: '`apiPresetSelectHtml(pfx,value)`（`data-ftt-api-preset`）在 v1.206 里**是死代码**：仅 1 处定义、零调用方，UI 上不存在该控件。', evidence: 'grep -c apiPresetSelectHtml = 1（仅定义行 24585）；apiBlockHtml.extras.apiPresetSelectHtml' },
        { id: 'q20', quirk: '`resolveParallelApiOverride` **没有**自定义独立配置分支：只有 `parallelApiPreset`（命中已存分组）或 `activeApiPreset` 兜底，二者皆空则回主配置。', evidence: 'v1.206:2473-2476；resolve.overrides.cases[parallel-*]' },
        { id: 'q21', quirk: 'kw/mem 的三段优先级是：**已存分组预设 > Enabled 自定义 > activeApiPreset 兜底**。`kwApiPreset` 指向不存在分组时会落到 Enabled 分支（若开），因此「Preset 失效 + Enabled=true」会静默走 kwApi 自定义配置。', evidence: 'v1.206:2462-2471；resolve.overrides.cases[kw-preset-beats-enabled, kw-preset-unknown-*]' },
        { id: 'q22', quirk: '`groupEffectiveText` 的来源判定用 `override.apiUrl || override.apiType` —— Enabled 但 url 为空的 kw 配置仍被标为「自定义独立配置（未配置 API 地址）」，而不是「跟随主配置」。', evidence: 'v1.206:24617-24627；resolve.groupPreview.cases[kw-enabled-empty]' },
        { id: 'q23', quirk: '`apiBlockHtml` 的 OpenAI 兼容参数用 `??`：`cfg.apiTemperature ?? 0.2`（null/undefined 都回 0.2）；这三项是 `data-ftt-cfg` 字段（走 settingsApplyAll 的通用路径，key 以 "api" 开头 → 被 `else if (!key.startsWith("api"))` 排除，即 temperature/max_tokens/top_p **不落 cfg**）。', evidence: 'v1.206:24543-24547、26746；apiBlockHtml.main.fields + presetActions.steps 中 `savecfg ·` 步：DOM apiTemperature="0.9"/apiMaxTokens="123" 点击后 cfgAfter.apiTemperature 仍为 0.2、apiMaxTokens 仍为 ""' },
        { id: 'q24', quirk: '`apiPagePanelHtml`（真实点击渲染）与 `settingsHtml()`（setSettingsSub("api")）在 API 子页正文上逐字一致（同一构建器）；面板路径唯一差别是外层 tabs/body 包裹。', evidence: 'apiPage.panelsAgreeOnSubBody === true' },
        { id: 'q25', quirk: 'apiTest 的 UI 结果文案是 `✅ 可用（${ms}ms）` / `❌ ${msg.slice(0,80)}`，同时 notify「API 测试通过/失败」（失败 text 也截断 80 字）；apiModels 成功 toast `✅ 获取到 N 个模型`、失败 toast `❌ 获取模型失败:${msg.slice(0,80)}` 并把下拉写成「获取失败」。', evidence: 'v1.206:27305-27337；netSemantics.uiDelegation.steps' },
    ];

    // meta 汇总
    result.meta.sectionCounts = {
        resolveApiForCases: result.resolve.apiFor.cases.length,
        resolveOverrideCases: result.resolve.overrides.cases.length,
        resolveGroupPreviewCases: result.resolve.groupPreview.cases.length,
        apiBlockHtmlBlocks: ['main', 'emb'].filter((k) => result.apiBlockHtml[k]).length,
        apiBlockHtmlExtraBlocks: Object.keys(result.apiBlockHtml.extras).length,
        apiPageControls: (result.apiPage.projection.blocks || []).reduce((n, b) => n + b.fields.length + b.buttons.length, 0),
        presetActionSteps: result.presetActions.steps.length,
        presetActionToasts: result.presetActions.steps.reduce((n, s) => n + s.toasts.length, 0),
        netSemanticsTestApiCases: Object.keys(result.netSemantics.testApi).length,
        netSemanticsSuffixCases: result.netSemantics.endpointSuffixRules.length,
        netSemanticsErrorCases: result.netSemantics.errors.cases.length + result.netSemantics.errors.fetchModelsCases.length,
        netSemanticsFetchModelsCases: result.netSemantics.fetchModels.cases.length,
        netSemanticsUiDelegationSteps: result.netSemantics.uiDelegation.steps.length,
        quirks: result.quirks.length,
    };
    result.meta.note = '本 fixture 由 tests/fixtures/gen-v1-golden-api.cjs **真实加载并直调 V1 插件 v1.206**（'
        + SRC_FILE + '）生成：`node tests/fixtures/gen-v1-golden-api.cjs [out.json]`，连跑两次逐字节一致。'
        + ' resolveApiFor / testApi / fetchModels / settingsHtml / extractKeywordsFromText / analyzeMemorySend / runParallelWeave 为 `__FTT` 导出直调；'
        + ' apiBlockHtml / groupStrategyHtml / dimensionRowsHtml / collectApiBlock / resolveKw·Mem·ParallelApiOverride **未导出** → 一律经真实渲染（settingsHtml）或真实行为（请求捕获 / 点击委托）取证，细节见 meta.evidence。';
    result.meta.notes.push('未取证 / skipped：' + (result.meta.evidence.skipped.length ? result.meta.evidence.skipped.join('；') : '无（全部条目均为真实取证；apiPresetSelectHtml 为死代码，只保留源码片段，未伪造渲染产物）'));
    result.meta.notes.push('非确定源归一：testApi 的 `ms`（挂钟）只记录类型不记录数值；UI 结果/提示文案里的 `\\d+ms` 归一为 `<n>ms`。');
    result.meta.notes.push('测试基建：' + path.join(V1, 'tests/unit/helpers.js') + '（makeTavernEnv / loadPlugin / pluginToasts / makeResp）。');

    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    return result;
}

// 注意：本 fixture 体积 ~240KB，stdout 是管道时 write 是**异步**的 —— 必须先等写回调再 exit(0)，
// 否则 `process.exit(0)` 会丢掉未 flush 的缓冲，stdout 变成截断的非法 JSON（本 oracle 实测踩过）。
process.stdout.on('error', () => { try { process.exit(0); } catch (e) { } });
main().then((r) => {
    const text = JSON.stringify(r, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text);          // 仓库产物：同步落盘（与 stdout 无关，保证逐字节一致）
    realStdoutWrite(text, () => process.exit(0));
}).catch((e) => { process.stderr.write('ORACLE FAIL: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
