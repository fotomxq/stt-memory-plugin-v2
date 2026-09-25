// ============================================================
// 单元测试 · B10-a「API 页与按用途渠道」（**与真实 V1 插件 v1.206 逐项比对** + V2 实现/接线）
// 黄金样本：tests/fixtures/v1-golden-api.json（生成器入库 tests/fixtures/gen-v1-golden-api.cjs，两次运行逐字节一致）
//   oracle = 真实 V1 v1.206：`resolveApiFor`（22 case 直调）· `resolveKw/Mem/ParallelApiOverride`（15 case，经
//   `extractKeywordsFromText`/`analyzeMemorySend`/`runParallelWeave` 真实调用链反推 + 捕获真实请求）·
//   `testApi`/`fetchModels`（真实请求 + 报错文案）· `apiBlockHtml`/API 子页（真渲染投影）·
//   `presetSave/Load/Delete`（真实点击委托 14 步）· 25 条 V1 怪癖。
// 覆盖：
//   R 组：apiFor 可复现子集逐例比对 / 代理预设子集「不伪造」/ 用途 override 逐例比对（14 例真实请求）/
//        kw 内联缺地址的如实失败 / groupPreview 6 例；
//   N 组：端点拼接 16 例 / testApi 6 例 + 错误顺序 9 例 + HTTP 失败文案 5 例 / fetchModels 8 例 + 非 200；
//   P 组：预设动作 14 步（配置演进 + toast→note 映射 + presetName/presetSelect 不落 cfg）；
//   U 组：API 子页 V1 同款分节/标签/placeholder/按钮/结果 span + 「按用途渠道」原位说明 + 不放假控件；
//   Q 组：V1 怪癖台账（25 条）与 V2 的对齐/偏离裁决。
// 与 V1 的必要偏离（本文件**断言其差异**，登记于 docs/P10a-API页与按用途渠道对齐.md §4）：
//   ① 三通道（host/profile/direct）取代 V1 的「自建直连 + 代理预设名」；
//   ② V1 缺陷 #3（本批修正）：V1 `settingsApplyAll` 的 `else if (!key.startsWith('api'))` 兜底把
//      `apiTemperature/apiMaxTokens/apiTopP` 一并排除 → V1 这三个控件**永远写不进 cfg**（死控件，q23 有实测证据）；
//      V2 即时写回（`applySettingsControl`）→ 参数真实生效；
//   ③ V2 无 `savecfg` 批量保存（既有判定）→ q18（点保存设置顺带重置 kw/mem 策略与 feedWorldbooks）在 V2 不适用；
//   ④ API 块的「地址/Key/模型」在 V2 由通道决定：`direct` 通道字段与 V1 逐字等价；`profile` 通道由酒馆连接配置承载。
// 运行：node tests/unit/api-channel-golden.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, setKernelState, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    resolveApiTarget, purposeOfLabel, apiPresetSave, apiPresetLoad, apiPresetDelete,
    apiPresetNames, apiChannelSummary, apiParamsOf, mainApiChannel, presetChannel, API_CHANNELS,
} from '../../core/api-channel.js';
import {
    chatEndpoint, modelsEndpoint, embeddingsEndpoint, rerankEndpoint,
    probeTarget, fetchModels, listConnectionProfiles, apiChannelAvailability, targetUsable, sendDirect,
    connectionService,
} from '../../host/api-channel.js';
import { settingsPageHtml, applySettingsControl } from '../../ui/settings-pages.js';
import { apiPageHtml, apiAction, apiPageState, resetApiPageState, setApiPageHooks } from '../../ui/api-page.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-api.json'), 'utf8'));
const R = makeReporter('api-channel B10-a API 页与按用途渠道（V1 对齐）');
const J = (v) => JSON.stringify(v);
const A = (name, cond, extra) => R.assert(name, !!cond, extra);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setApiPageHooks({ rerender: () => undefined });

/** V1 cfg → V2 cfg（同名连接字段原样；**不设 `apiChannel`** → 走旧数据迁移口径；分组条目按 V1 字段存） */
function v2CfgFromV1(v1) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    delete cfg.apiChannel;
    cfg.apiType = v1.apiType;
    cfg.apiUrl = v1.apiUrl;
    cfg.apiKey = v1.apiKey;
    cfg.model = v1.model;
    cfg.proxyPreset = v1.proxyPreset;
    cfg.activeApiPreset = v1.activeApiPreset || '';
    cfg.apiPresets = JSON.parse(JSON.stringify(v1.apiPresets || {}));
    ['kwApiEnabled', 'kwApiPreset', 'kwApi', 'memApiEnabled', 'memApiPreset', 'memApi', 'parallelApiPreset', 'dimensionPresets']
        .forEach((k) => { if (v1[k] !== undefined) cfg[k] = JSON.parse(JSON.stringify(v1[k])); });
    return cfg;
}
const trimSlash = (u) => String(u == null ? '' : u).trim().replace(/\/+$/, '');
const reqConn = (r) => ({
    url: String(r.url || '').replace(/\/chat\/completions$/, ''),
    key: String(r.authorization || '').replace(/^Bearer /, ''),
    model: String((r.body && r.body.model) || ''),
});
/** V2 target → 与 V1 `resolveApiFor` 返回值同构的连接三元组 */
const targetConn = (t) => ({ url: trimSlash(t.apiUrl), key: String(t.apiKey || ''), model: String(t.model || '') });

// ---------- 样本自证 ----------
A('R0 样本自证：oracle 版本 v1.206、源码片段/统计齐备、25 条怪癖与各段条目数一致', (() => {
    const sc = G.meta.sectionCounts;
    return G.meta.v1Version === 'v1.206'
        && String(G.meta.sourceFile).indexOf('v1.206') >= 0
        && G.meta.v1SourceSnips.resolveApiFor.indexOf('function resolveApiFor') >= 0
        && G.resolve.apiFor.cases.length === sc.resolveApiForCases
        && G.resolve.overrides.cases.length === sc.resolveOverrideCases
        && G.netSemantics.endpointSuffixRules.length === sc.netSemanticsSuffixCases
        && (G.netSemantics.errors.cases.length + G.netSemantics.errors.fetchModelsCases.length) === sc.netSemanticsErrorCases
        && G.netSemantics.fetchModels.cases.length === sc.netSemanticsFetchModelsCases
        && G.presetActions.steps.length === sc.presetActionSteps
        && G.quirks.length === sc.quirks && G.quirks.length === 25
        && G.apiPage.panelsAgreeOnSubBody === true;
})(), G.meta.sectionCounts);

// ---------- R1：apiFor 可复现子集（按 V1 **调用点**口径逐例比对） ----------
const R1 = (() => {
    const rows = [];
    let n = 0; let want = 0; let callsiteDiff = 0;
    for (const c of G.resolve.apiFor.cases) {
        const presetName = c.override && c.override.preset;
        // 样本里 `null-and-undefined-override` 的 override 是「null / undefined」双形态的**容器**，不是内联字段
        const isNullPair = c.id === 'null-and-undefined-override';
        const inline = !isNullPair && !!c.override && Object.keys(c.override).some((k) => k !== 'preset');
        const mainUrl = trimSlash(c.cfg.apiUrl);
        const pair = isNullPair ? ['nullArg', 'undefinedArg'] : [null];
        for (const arg of pair) {
            const out = arg ? c.out[arg] : c.out;
            const usePreset = !!(presetName && c.cfg.apiPresets[presetName]);
            // ③ 形态不适用：V2 的调用点从不传内联 apiUrl/apiKey/model（V1 的 override 也只有 `{preset}` 与 kw/mem 内联两形态）
            //    注：命中分组时 V1 **忽略** override 的内联字段（q03）→ 仍属可复现子集
            if (inline && !usePreset) { rows.push(c.id + ':N/A(V2 无内联 override 调用点)'); continue; }
            const proxyResolved = !usePreset && out.apiType === 'preset' && out.url && out.url !== mainUrl;
            if (proxyResolved) { rows.push(c.id + ':N/A(代理预设查表 → R2)'); continue; }
            const activeHit = !!(c.cfg.activeApiPreset && c.cfg.apiPresets[c.cfg.activeApiPreset]);
            // V1 调用点口径：命中 override.preset 用该分组；否则若 activeApiPreset 命中则用激活分组（`overrideMain`，v1.206 14789）
            const expectPresetName = usePreset ? presetName : (activeHit ? c.cfg.activeApiPreset : '');
            const expect = expectPresetName
                ? { url: trimSlash(c.cfg.apiPresets[expectPresetName].apiUrl), key: String(c.cfg.apiPresets[expectPresetName].apiKey || ''), model: String(c.cfg.apiPresets[expectPresetName].model || '') }
                : { url: out.url, key: out.key, model: out.model };
            const expectChannel = expectPresetName ? presetChannel(c.cfg.apiPresets[expectPresetName])
                : ((mainUrl && String(c.cfg.model || '').trim()) ? 'direct' : 'host');
            v2CfgFromV1(c.cfg);
            const t = resolveApiTarget(usePreset ? { purpose: 'main', preset: presetName } : { purpose: 'main' });
            want++;
            const ok = J(targetConn(t)) === J(expect) && t.channel === expectChannel;
            if (ok) n++;
            else rows.push(c.id + (arg ? ':' + arg : '') + '(MISMATCH ' + J({ c: targetConn(t), ch: t.channel }) + '≠' + J({ c: expect, ch: expectChannel }) + ')');
            // q02 证据：V1 直调（无 override）忽略 activeApiPreset，而调用点会命中 → 两者结果不同即该怪癖成立
            if (!usePreset && activeHit && J({ url: out.url, key: out.key, model: out.model }) !== J(expect)) callsiteDiff++;
        }
    }
    return { ok: want === 17 && n === want && callsiteDiff === 1 && rows.every((x) => x.indexOf('MISMATCH') < 0), bad: rows.filter((x) => x.indexOf('MISMATCH') >= 0), na: rows.filter((x) => x.indexOf(':N/A') >= 0), n, want, callsiteDiff };
})();
A('R1 `resolveApiFor` 可复现子集 **17/17** 逐例比对（另 6 例 N/A：内联 override 形态 4 + 代理预设查表 2）：连接三元组与 V1 **完全一致**，通道按迁移口径判定（含 q02：V1 直调不读 activeApiPreset，而调用点 `overrideMain` 会读）', R1.ok, R1);

// ---------- R2：代理预设子集「不伪造」 ----------
A('R2 V1 的「代理预设」查表（v1.206 2453~2457）V2 **无法复现**：2 例（proxy-preset / -cfg-model-empty）→ V2 落到 `cfg.apiUrl`（不伪造预设地址）；而 V1 自身回落的 5 例（null/throw/no-apiurl/接口缺失/仅 custom 才查表）V2 逐字一致', (() => {
    const proxyCases = G.resolve.apiFor.cases.filter((c) => {
        const presetName = c.override && c.override.preset;
        const inline = c.override && Object.keys(c.override).some((k) => k !== 'preset');
        const mainUrl = trimSlash(c.cfg.apiUrl);
        return !inline && !(presetName && c.cfg.apiPresets[presetName]) && c.out.apiType === 'preset' && c.out.url && c.out.url !== mainUrl;
    });
    let ok = 0;
    for (const c of proxyCases) {
        v2CfgFromV1(c.cfg);
        const t = resolveApiTarget({ purpose: 'main' });
        // 不伪造：地址等于 V1 主配置地址（≠ 预设地址）
        if (String(t.apiUrl) === trimSlash(c.cfg.apiUrl) && String(t.apiUrl) !== String(c.out.url)) ok++;
    }
    const fallback = G.resolve.apiFor.cases.filter((c) => String(c.id).indexOf('proxy-preset-') === 0 && !c.override && trimSlash(c.out.url) === trimSlash(c.cfg.apiUrl));
    let fbOk = 0;
    for (const c of fallback) {
        v2CfgFromV1(c.cfg);
        const t = resolveApiTarget({ purpose: 'main' });
        if (J(targetConn(t)) === J({ url: c.out.url, key: c.out.key, model: c.out.model })) fbOk++;
    }
    return proxyCases.length === 2 && ok === 2 && fallback.length === 5 && fbOk === 5;
})(), null);

// ---------- R3：用途 override（kw / mem / parallel）逐例与 V1 真实请求比对 ----------
A('R3 用途 override 15 例：V1 **真实请求**的 url/key/model 与 V2 `resolveApiTarget` 逐个一致（含 kw/mem 三段优先级、parallel 无自定义分支、activeApiPreset 兜底）', (() => {
    const PURPOSE = { extractKeywordsFromText: 'kw', analyzeMemorySend: 'mem', runParallelWeave: 'parallel' };
    const rows = [];
    let n = 0; let matched = 0;
    for (const c of G.resolve.overrides.cases) {
        v2CfgFromV1(c.cfg);
        const purpose = PURPOSE[c.probe];
        const t = resolveApiTarget({ purpose });
        const reqs = c.requests || [];
        if (!reqs.length) {
            // V1 未发出请求（缺地址）→ V2 的 target 必须**同样不可用**（如实失败，不回落 host）
            const use = targetUsable(t);
            const ok = purpose === 'kw' && c.id === 'kw-enabled-custom-empty-url' && t.channel === 'direct' && use.ok === false && use.error === '未配置 API 地址';
            rows.push(c.id + (ok ? '' : '(MISMATCH 不可用口径)'));
            if (ok) n++;
            matched++;
            continue;
        }
        const want = reqConn(reqs[0]);
        const ok = J(targetConn(t)) === J(want);
        rows.push(c.id + (ok ? '' : '(MISMATCH ' + J(targetConn(t)) + '≠' + J(want) + ')'));
        matched++;
        if (ok) n++;
    }
    return matched === 15 && n === 15 && rows.every((x) => x.indexOf('MISMATCH') < 0);
})(), null);

// ---------- R4：groupPreview（V1 生效预览 6 例）→ V2 用途摘要如实反映同一来源 ----------
A('R4 V1 `groupEffectiveText` 6 例的来源判定与 V2 `resolveApiTarget` 一致（分组 > 内联 Enabled > activeApiPreset > 主配置）', (() => {
    const cases = G.resolve.groupPreview.cases;
    let n = 0;
    for (const c of cases) {
        const v1 = c.cfg || c;
        v2CfgFromV1(v1);
        const purpose = String(c.probe || '').indexOf('mem') >= 0 ? 'mem' : 'kw';
        const t = resolveApiTarget({ purpose });
        const sum = apiChannelSummary();
        const presetName = purpose === 'kw' ? cfg.kwApiPreset : cfg.memApiPreset;
        const enabled = purpose === 'kw' ? cfg.kwApiEnabled : cfg.memApiEnabled;
        const expectPreset = !!(presetName && cfg.apiPresets && cfg.apiPresets[presetName]);
        const ok = expectPreset
            ? (t.source === 'preset' && t.name === presetName)
            : (enabled ? t.source.indexOf('inline:') === 0 : (cfg.activeApiPreset && cfg.apiPresets[cfg.activeApiPreset] ? t.source === 'preset' : t.source === 'main'));
        if (ok) n++;
    }
    return cases.length === 6 && n === 6;
})(), null);

// ---------- N1：端点拼接（16 例） ----------
A('N1 端点拼接 16 例逐项一致（各 kind 只对自己的后缀去重、正则带 i、比较对象是去尾斜杠后的 url）', (() => {
    // 样本里的 kind 名是 V1 `testApi` 的取值（chat/embedding/rerank）；`models` 一并映射以备扩展
    const FN = { chat: chatEndpoint, models: modelsEndpoint, embedding: embeddingsEndpoint, embeddings: embeddingsEndpoint, rerank: rerankEndpoint };
    let n = 0;
    for (const c of G.netSemantics.endpointSuffixRules) {
        const fn = FN[c.kind];
        if (fn && fn(c.inputUrl) === c.endpoint) n++;
    }
    return n === G.netSemantics.endpointSuffixRules.length && n === 16;
})(), null);

// ---------- N2：testApi 语义（请求 + 返回形态 + 错误顺序 + HTTP 文案） ----------
A('N2 `testApi` 语义等价：请求（url/method/Authorization/请求体）逐字一致，kind 归一为 chat，`{ok,ms,kind}` 形态一致', (async () => {
    const names = ['chat', 'embedding', 'rerank', 'kind-undefined', 'kind-CHAT-uppercase', 'no-key'];
    const calls = [];
    const restore = installGlobalFetch((url, opts) => { calls.push({ url: String(url), opts: opts || {} }); return { status: 200, body: { ok: true } }; });
    let n = 0;
    try {
        for (const nm of names) {
            const c = G.netSemantics.testApi[nm];
            const inp = c.input || { override: { apiUrl: 'https://x.example/v1', apiKey: 'sk-1', model: 'm' }, kind: 'chat' };
            calls.length = 0;
            const r = await probeTarget({
                channel: 'direct', apiUrl: inp.override.apiUrl, apiKey: inp.override.apiKey, model: inp.override.model,
            }, inp.kind);
            const sent = calls[0] || { url: '', opts: {} };
            const body = sent.opts.body ? JSON.parse(String(sent.opts.body)) : null;
            const auth = (sent.opts.headers || {}).Authorization || null;
            const wantBody = c.request.body;
            const okReq = sent.url === c.request.url && sent.opts.method === c.request.method
                && (sent.opts.headers || {})['Content-Type'] === c.request.contentType
                && auth === c.request.authorization && J(body) === J(wantBody);
            const okShape = r.ok === true && r.kind === 'chat' && typeof r.ms === 'number';
            if (okReq && okShape) n++;
        }
    } finally { restore(); }
    return n === names.length;
})(), null);

A('N3 `testApi` 错误顺序 9 例（先地址后模型，三种 kind 各自文案）+ HTTP 失败文案 5 例与 V1 逐字一致', (async () => {
    let n = 0;
    const total = G.netSemantics.errors.cases.length + 5;
    for (const c of G.netSemantics.errors.cases) {
        const r = await probeTarget({
            channel: 'direct', apiUrl: c.override.apiUrl, apiKey: c.override.apiKey, model: c.override.model,
        }, c.kind);
        if (r.ok === false && r.error === c.error) n++;
    }
    const he = G.netSemantics.httpErrors;
    const mkHttp = (injected) => {
        const restore = installGlobalFetch(() => injected);
        return restore;
    };
    for (const key of ['testApi.chat', 'testApi.embedding', 'testApi.rerank']) {
        const c = he[key];
        const kind = key.split('.')[1];
        const restore = mkHttp(Object.assign({}, c.injected, { text: async () => c.injected.text }));
        let r;
        try { r = await probeTarget({ channel: 'direct', apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, kind === 'chat' ? 'chat' : kind); } finally { restore(); }
        if (r.ok === false && r.error === c.error) n++;
    }
    // 截断到 200 字符 + res.text() 抛错回落 statusText
    {
        const c = he.truncation;
        const restore = installGlobalFetch(() => ({ status: 502, statusText: 'Bad Gateway', text: async () => 'x'.repeat(c.injectedTextLen) }));
        let r; try { r = await probeTarget({ channel: 'direct', apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, 'chat'); } finally { restore(); }
        const want = 'HTTP 502: ' + 'x'.repeat(200);
        if (r.ok === false && r.error === want && r.error.length === c.errorLen) n++;
    }
    {
        const restore = installGlobalFetch(() => ({ status: 500, statusText: 'Internal Server Error', text: async () => { throw new Error('stream broken'); } }));
        let r; try { r = await probeTarget({ channel: 'direct', apiUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, 'chat'); } finally { restore(); }
        if (r.ok === false && r.error === he.textThrows.error) n++;
    }
    return n === total;
})(), null);

// ---------- N4：fetchModels（解析 + 请求头 + 非 200 + 缺地址） ----------
A('N4 `fetchModels` 8 例解析/请求 + 非 200 + 缺地址文案与 V1 逐字一致（GET、只带 Authorization、data 优先 models、不去重）', (async () => {
    let n = 0;
    for (const c of G.netSemantics.fetchModels.cases) {
        const calls = [];
        const restore = installGlobalFetch((url, opts) => { calls.push({ url: String(url), opts: opts || {} }); return { status: 200, body: c.payload }; });
        let r;
        try { r = await fetchModels({ channel: 'direct', apiUrl: c.override.apiUrl, apiKey: c.override.apiKey }); } finally { restore(); }
        const sent = calls[0] || { url: '', opts: {} };
        const auth = (sent.opts.headers || {}).Authorization || null;
        const okReq = sent.url === c.request.url && sent.opts.method === 'GET'
            && (sent.opts.headers || {})['Content-Type'] === undefined && auth === c.request.authorization;
        const okOut = (c.error === null) ? (r.ok === true && J(r.models) === J(c.models)) : (r.ok === false && r.error === c.error);
        if (okReq && okOut) n++;
    }
    for (const c of G.netSemantics.errors.fetchModelsCases) {
        const r = await fetchModels({ channel: 'direct', apiUrl: c.override.apiUrl, apiKey: c.override.apiKey });
        if (r.ok === false && r.error === c.error) n++;
    }
    {
        const c = G.netSemantics.fetchModels.non200;
        const restore = installGlobalFetch(() => ({ status: 404, statusText: 'Not Found', text: async () => c.injected.text }));
        let r; try { r = await fetchModels({ channel: 'direct', apiUrl: 'https://x.example/v1', apiKey: 'k' }); } finally { restore(); }
        if (r.ok === false && r.error === c.error) n++;
    }
    // host/profile 通道的如实拒绝（V2 特有；不伪造模型列表）
    {
        const r1 = await fetchModels({ channel: 'host' });
        const r2 = await fetchModels({ channel: 'profile', profileId: 'p1' });
        if (r1.ok === false && String(r1.error).indexOf('跟随酒馆当前连接') >= 0
            && r2.ok === false && String(r2.error).indexOf('连接配置') >= 0) n++;
    }
    return n === G.netSemantics.fetchModels.cases.length + G.netSemantics.errors.fetchModelsCases.length + 2 && n === 12;
})(), null);

// ---------- P1：预设三动作 14 步（配置演进 + note 映射 + presetName/presetSelect 不落 cfg） ----------
await (async () => {
    const steps = G.presetActions.steps;
    const rows = [];
    let n = 0; let matched = 0;
    const ACTION = (name) => {
        const m = String(name).match(/^(presetSave|presetLoad|presetDelete|savecfg)\b/);
        return m ? m[1] : null;
    };
    // 初始态：V1 步 0 的 cfg（面板打开）
    const init = steps[0].cfg;
    v2CfgFromV1(Object.assign({}, init, { apiPresets: init.apiPresets || {} }));
    let lastCfg = J(init.apiPresets || {});
    for (const s of steps) {
        const act = ACTION(s.name);
        if (act === 'savecfg') {
            // ③ 偏离：V2 无 savecfg；改为断言 V2 的即时写回口径（参数**真实生效**，且 preset* 仍不落 cfg）
            const before = apiParamsOf();
            const a1 = applySettingsControl('apiTemperature', 0.9);
            const a2 = applySettingsControl('apiMaxTokens', '123');
            const t1 = applySettingsControl('presetName', 'ZZ');
            const t2 = applySettingsControl('presetSelect', 'A');
            const after = apiParamsOf();
            const ok = a1.ok && a2.ok && before.temperature === 0.2 && after.temperature === 0.9
                && String(after.maxTokens) === '123' && t1.transient === true && t2.transient === true
                && !Object.prototype.hasOwnProperty.call(cfg, 'presetName') && !Object.prototype.hasOwnProperty.call(cfg, 'presetSelect');
            rows.push('savecfg(改判) ' + (ok ? '' : '(MISMATCH ' + J({ beforeT: before.temperature, afterT: after.temperature, afterMax: String(after.maxTokens), a1: a1.ok, a2: a2.ok, t1: t1.transient, t2: t2.transient, hp1: Object.prototype.hasOwnProperty.call(cfg, 'presetName'), hp2: Object.prototype.hasOwnProperty.call(cfg, 'presetSelect') }) + ')'));
            if (ok) n++;
            matched++;
            continue;
        }
        if (!act) { rows.push(s.name + ':SKIP'); continue; }
        // 点击时的控件值在 `inputsSet`（`presetNameDomValue` 是**点击后**的 DOM 值：V1 会整页重渲染把输入框清空，q14）
        const valOf = (frag) => { const hit = (s.inputsSet || []).filter((x) => String(x.sel).indexOf(frag) >= 0)[0]; return hit ? String(hit.applied == null ? '' : hit.applied) : ''; };
        // 形态差异：V1 的主 API 字段真值是**面板 DOM**（`collectApiBlock('main')`），V2 的真值是 cfg
        //   → 复现该步的 DOM 赋值语义（等价地把值落到 cfg），再点击
        (s.inputsSet || []).forEach((x) => {
            const m = String(x.sel).match(/^\[data-ftt-api="main"\]\[data-ftt-api-key="([A-Za-z]+)"\]$/);
            if (m && m[1] !== 'modelSelect') cfg[m[1]] = String(x.applied == null ? '' : x.applied);
        });
        const p = { name: valOf('presetName'), preset: valOf('presetSelect') };
        const r = await apiAction(act, p);
        const wantOk = !(s.toasts || []).some((t) => t.kind === 'warning');
        // V2 条目比 V1 多 `channel`/`profileId`（连接形态所需，见 docs/P10a §2）→ 只比对 V1 的 5 个字段
        const V1_FIELDS = ['apiType', 'apiUrl', 'apiKey', 'model', 'proxyPreset'];
        const sub = (m) => { const o = {}; Object.keys(m || {}).sort().forEach((n) => { const e = {}; V1_FIELDS.forEach((f) => { e[f] = String((m[n] || {})[f] == null ? '' : (m[n] || {})[f]); }); o[n] = e; }); return o; };
        // 注：不比 `cfg.apiUrl/apiKey/model` —— V1 的这两个来源是 DOM，`presetLoad` 才写回 cfg（形态差异已登记）
        const okCfg = J(sub((s.cfg || {}).apiPresets)) === J(sub(cfg.apiPresets))
            && String((s.cfg || {}).activeApiPreset || '') === String(cfg.activeApiPreset || '');
        const okCfg2 = String((s.cfg || {}).activeApiPreset || '') === String(cfg.activeApiPreset || '');
        const ok = r.ok === wantOk && okCfg && okCfg2
            && s.hasCfgPresetName === false && s.hasCfgPresetSelect === false
            && !Object.prototype.hasOwnProperty.call(cfg, 'presetName') && !Object.prototype.hasOwnProperty.call(cfg, 'presetSelect');
        if (!ok) rows.push(s.name + '(MISMATCH ok=' + r.ok + '/' + wantOk + ' cfg=' + okCfg + ')');
        matched++;
        if (ok) n++;
        lastCfg = J(cfg.apiPresets);
    }
    A('P1 预设三动作 13 步全部与 V1 一致（cfg.apiPresets / activeApiPreset / 拒绝语义 / preset* 不落 cfg）；末步 `savecfg` 改判为 V2 即时写回（参数真实生效）', matched === 13 && n === 13, { rows: rows.slice(0, 4), lastCfg, matched, n });
})();

// ---------- U1：API 子页与 V1 同款结构（真渲染投影比对） ----------
A('U1 API 子页：两个分节标题逐字、按钮文案/类名/动作全部一致；参数三项标签与 placeholder 逐字；结果 span id 一致', (() => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); delete cfg.apiChannel;
    const html = apiPageHtml();
    const pj = G.apiPage.projection;
    const btnOk = pj.buttons.filter((b) => b.attrs['data-ftt-action'] !== 'savecfg').every((b) => {
        return html.indexOf('class="' + b.cls + '" data-ftt-action="' + b.attrs['data-ftt-action'] + '"') >= 0
            && html.indexOf('>' + b.text + '</button>') >= 0;
    });
    const secOk = pj.sectionTitles.every((t) => html.indexOf(t) >= 0);
    const nameOk = html.indexOf('data-ftt-cfg="presetName" placeholder="' + G.apiPage.projection.presetNameField.attrs.placeholder + '"') >= 0;
    const mf = G.apiBlockHtml.main.fields;
    const fieldOf = (label) => mf.filter((f) => f.label === label)[0];
    const paramsOk = ['temperature', 'max_tokens', 'top_p'].every((label) => {
        const f = fieldOf(label);
        // V1 的三个参数控件是 `data-ftt-cfg` 字段；V2 同键、同标签、同 placeholder（值渲染方式无关紧要）
        return html.indexOf('data-ftt-cfg="' + f.ctrl.attrs['data-ftt-cfg'] + '"') >= 0
            && (!f.ctrl.attrs.placeholder || html.indexOf('placeholder="' + f.ctrl.attrs.placeholder + '"') >= 0);
    });
    // 说明文字按**去标签后的可见文本**比对（V1 投影里含 <b> 已剥离，V2 渲染带 <b>）
    const text = html.replace(/<[^>]*>/g, '');
    const noteOk = G.apiBlockHtml.main.notes.every((nt) => text.indexOf(nt) >= 0);
    const spanOk = html.indexOf('id="' + G.apiBlockHtml.main.resultSpanId + '"') >= 0;
    const apiTestBtn = G.apiBlockHtml.main.buttons.map((b) => b.text).every((tx) => html.indexOf(tx) >= 0);
    return btnOk && secOk && nameOk && paramsOk && noteOk && spanOk && apiTestBtn;
})(), null);

Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); delete cfg.apiChannel;
A('U2 按用途渠道按 V1 **原位**渲染：分析记忆页出各维度分组下拉、平行页出推演渠道选择器、API 页只作索引；向量层控件不给（不放假控件）', (() => {
    const api = apiPageHtml();
    const analyze = settingsPageHtml('analyze');
    const parallels = settingsPageHtml('parallels');
    const dims = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'];
    return api.indexOf('在「平行」设定页选择') >= 0 && api.indexOf('在「分析记忆」设定页选择') >= 0
        && api.indexOf('data-ftt-dim-preset') < 0 && api.indexOf('parallelApiPreset') < 0
        && dims.every((d) => analyze.indexOf('data-ftt-dim-preset="' + d + '"') >= 0)
        && analyze.indexOf('各维度独立子开关与分组') >= 0 && analyze.indexOf('跟随主配置') >= 0
        && parallels.indexOf('data-ftt-cfg="parallelApiPreset"') >= 0 && parallels.indexOf('推演/推进分析渠道') >= 0
        // 未实现用途：kw/mem/Embedding/Rerank 一律**无控件**（说明文字可以提到它们，控件与 API 块不得存在）
        && api.indexOf('data-ftt-cfg="kwApiPreset"') < 0 && api.indexOf('data-ftt-cfg="memApiPreset"') < 0
        && api.indexOf('ftt-api-title">Embedding API') < 0 && api.indexOf('ftt-api-title">Rerank API') < 0
        && api.indexOf('data-ftt-api="emb"') < 0 && api.indexOf('data-ftt-api="rerank"') < 0
        && analyze.indexOf('data-ftt-api-preset') < 0 && parallels.indexOf('data-ftt-cfg="kwApi') < 0
        // V1 开启态原文（按维度选预设已实现 → 逐字恢复）
        && settingsPageHtml('analyze').indexOf('统一分组（一次请求全部维度）') >= 0;
})(), null);

A('U3 `apiTest`/`apiModels` 的结果文案与 V1 逐字一致（`✅ 可用（Nms）` / `❌ …` / `✅ 获取到 N 个模型` / `❌ 获取模型失败：…`）；通道不可用时如实降级', (async () => {
    resetApiPageState();
    const savedSvc = host.ctx.ConnectionManagerRequestService;
    let ok = true;
    // direct 成功
    cfg.apiChannel = 'direct'; cfg.apiUrl = 'https://x.example/v1'; cfg.apiKey = 'k'; cfg.model = 'm';
    let restore = installGlobalFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'pong' } }] } }));
    let rt; try { rt = await apiAction('apiTest', {}); } finally { restore(); }
    ok = ok && rt.ok === true && /^✅ 可用（\d+ms）$/.test(String(rt.result));
    // HTTP 失败
    restore = installGlobalFetch(() => ({ status: 500, text: async () => 'boom' }));
    let rf; try { rf = await apiAction('apiTest', {}); } finally { restore(); }
    ok = ok && rf.ok === false && String(rf.result) === '❌ HTTP 500: boom';
    // 模型列表
    restore = installGlobalFetch(() => ({ status: 200, body: { data: [{ id: 'm1' }, { id: 'm2' }] } }));
    let rm; try { rm = await apiAction('apiModels', {}); } finally { restore(); }
    ok = ok && rm.ok === true && rm.count === 2 && String(rm.note) === '✅ 获取到 2 个模型' && apiPageState().models.count === 2;
    restore = installGlobalFetch(() => ({ status: 200, body: { data: [] } }));
    let rme; try { rme = await apiAction('apiModels', {}); } finally { restore(); }
    ok = ok && rme.ok === false && String(rme.note) === '❌ 获取模型失败：未解析到模型列表';
    // host 通道：如实拒绝（不假装测试通过）
    cfg.apiChannel = 'host';
    const rh = await apiAction('apiTest', {});
    ok = ok && rh.ok === false && String(rh.result).indexOf('跟随酒馆当前连接') >= 0;
    // profile 通道不可用（连接管理缺失）→ 如实回报
    cfg.apiChannel = 'profile'; cfg.apiProfileId = 'nope';
    const rp = await apiAction('apiTest', {});
    ok = ok && rp.ok === false && String(rp.result).indexOf('连接配置不存在') >= 0;
    host.ctx.ConnectionManagerRequestService = savedSvc;
    resetApiPageState();
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); delete cfg.apiChannel;
    return ok;
})(), null);

// ---------- Q1：V1 怪癖台账 ----------
A('Q1 V1 怪癖 25 条台账齐备，且 V2 的裁决逐类落地（对齐 / 迁移 / 明确修正 / 不适用）', (() => {
    const ids = G.quirks.map((q) => q.id);
    const has = (s) => G.quirks.some((q) => String(q.quirk).indexOf(s) >= 0);
    // 台账完整性
    const listOk = ids.length === 25 && ids[0] === 'q01' && ids[24] === 'q25';
    // 已**对齐**的怪癖：去尾斜杠 / 端点各自去重 / data 优先 / 不去重 / 不弹确认 / 空名拒绝 / testApi 错误顺序
    v2CfgFromV1({ apiType: 'custom', apiUrl: 'https://a.example/v1///  ', apiKey: ' k ', model: ' m ', proxyPreset: '', activeApiPreset: '', apiPresets: {} });
    const t = resolveApiTarget({ purpose: 'main' });
    const aligned = t.apiUrl === 'https://a.example/v1' && t.apiKey === 'k' && t.model === 'm'
        && chatEndpoint('https://x/v1/models') === 'https://x/v1/models/chat/completions'
        && has('replace(/\\/+$/') && has('data` 优先') && has('不弹确认') && has('未配置 API 地址');
    // 迁移：V1「代理预设」→ host/direct（不伪造）；apiType 保留
    const migrated = mainApiChannel() === 'direct' && presetChannel({ apiType: 'preset', apiUrl: '', model: '' }) === 'host'
        && presetChannel({ apiType: 'custom', apiUrl: 'https://p/v1', model: 'm' }) === 'direct';
    // 明确修正（V1 缺陷 #3）：三个参数控件在 V1 不落 cfg（q23），V2 落 cfg
    const fixed = has('不落 cfg') && (() => {
        Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
        const a = applySettingsControl('apiTemperature', '0.75');
        return a.ok === true && apiParamsOf().temperature === 0.75;
    })();
    // 不适用：savecfg 的连带重置（q18）
    const na = has('保存设置') && has('feedWorldbooks');
    // V2 三通道与 V1 的「代理预设名」字段：V2 不再渲染该输入（形态差异已登记）
    const noProxyField = apiPageHtml().indexOf('代理预设名') < 0 && apiPageHtml().indexOf('data-ftt-cfg="proxyPreset"') < 0;
    return listOk && aligned && migrated && fixed && na && noProxyField && API_CHANNELS.join(',') === 'host,profile,direct';
})(), null);

// ---------- D1：通道与可用性（V2 特有能力的如实降级） ----------
await (async () => {
    const savedSvc = host.ctx.ConnectionManagerRequestService;
    let ok;
    try {
        host.ctx.ConnectionManagerRequestService = undefined;
        const p0 = listConnectionProfiles();
        const a0 = apiChannelAvailability();
        const svc0 = connectionService();
        const t0 = await probeTarget({ channel: 'profile', profileId: 'x' }, 'chat');
        host.ctx.ConnectionManagerRequestService = {
            getSupportedProfiles: () => [{ id: 'p1', name: '主连接', api: 'openai', model: 'gpt-x' }],
            sendRequest: async () => ({ content: 'PONG' }),
        };
        const p1 = listConnectionProfiles();
        const a1 = apiChannelAvailability();
        const use1 = targetUsable({ channel: 'profile', profileId: 'p1' });
        const r1 = await sendDirect({ apiUrl: '', model: 'm' });
        const r2 = await sendDirect({ apiUrl: 'https://x.example/v1', model: '' });
        ok = svc0 === null && p0.ok === false && a0.profile.available === false && t0.ok === false && String(t0.error).indexOf('不可用') >= 0
            && p1.ok === true && p1.profiles.length === 1 && p1.profiles[0].name === '主连接' && p1.profiles[0].model === 'gpt-x'
            && a1.profile.available === true && a1.profile.count === 1 && use1.ok === true
            && r1.ok === false && r1.error === '未配置 API 地址' && r2.ok === false && r2.error === '未配置模型';
    } finally {
        host.ctx.ConnectionManagerRequestService = savedSvc;
        Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); delete cfg.apiChannel;
    }
    A('D1 连接配置通道缺失时如实降级（不崩、不假成功）：不可用文案 / 有配置时列出 / 自建直连缺地址缺模型的报错与 V1 同源', ok, null);
})();

// ---------- 收尾 ----------
const D2 = (() => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); delete cfg.apiChannel;
    const before = String(apiChannelSummary().channel);
    const t = resolveApiTarget({ purpose: 'main' });
    const sum = apiChannelSummary();
    const cyc = (() => { const s = apiPresetSave('T'); const l = apiPresetLoad('T'); const d = apiPresetDelete('T'); return s.ok && l.ok && d.ok && cfg.activeApiPreset === ''; })();
    const clauses = {
        chan: typeof t.channel === 'string', presets: sum.presets.length === apiPresetNames().length, before: before === 'host',
        pl1: purposeOfLabel('摘要[状态]') === 'main', pl2: purposeOfLabel('平行事件推进') === 'parallel',
        empty: apiPresetSave('').ok === false, miss: apiPresetLoad('nope').ok === false, cycle: cyc,
    };
    return { ok: Object.keys(clauses).every((k) => clauses[k] === true), clauses };
})();
A('D2 teardown：内核通道解析不受宿主缺失影响（纯 cfg 驱动）', D2.ok, D2.clauses);

un();
R.done();
