// ============================================================
// host/api-channel.js —— **API 三通道宿主适配**（酒馆连接 / 连接配置 / 自建直连）
//
// 事实源（本机 SillyTavern 检出 `/var/service/SillyTavern`，已逐行核对）：
//   · `getContext()` 向扩展暴露 `ConnectionManagerRequestService`（`public/scripts/st-context.js:292`）
//     —— 官方扩展通道 API：`sendRequest(profileId, prompt, maxTokens, custom, overridePayload)`
//     （`public/scripts/extensions/shared.js:419`；`overridePayload` 会被展开进请求体 → 可覆盖
//      `temperature` / `top_p` / `max_tokens` / `model` 等），`getSupportedProfiles()`（:525）列可用连接配置。
//   · V1 的自建直连语义（`testApi` 2477 / `fetchModels` 2509 / `callChatCompletion` 2531 附近的端点拼接、
//     `Authorization: Bearer <key>`、`{model, messages, max_tokens}` 请求体）**逐条移植**为 `direct` 通道。
//
// 三通道（`core/api-channel.js#API_CHANNELS`）：
//   · `host`    —— 宿主 `generateRaw`（见 `host/generation.js`），本文件不参与；
//   · `profile` —— 酒馆「连接配置」（Connection Manager）：鉴权/地址/模型/预设由酒馆管理，
//                  插件只指定 profileId 并可按次覆盖采样参数（**V1 的「代理预设」在 V2 的等价物**）；
//   · `direct`  —— V1 等价的自建连接：插件自己 `fetch(`${url}/chat/completions`)`（浏览器直连，受 CORS 限制）。
//
// 约定：所有函数**不抛异常**，返回统一结果对象；缺能力/缺配置时明确回报原因（绝不静默假装成功）。
// ============================================================
import { getCtx } from './st-api.js';

/** 直连请求超时（毫秒）：V1 无超时（靠用户中断），V2 加兜底避免界面挂死 */
export const DIRECT_TIMEOUT_MS = 120000;

const str = (v) => String(v == null ? '' : v).trim();
const trimUrl = (v) => str(v).replace(/\/+$/, '');

/** V1 `resolveApiFor` 对 url 的处理后拼接端点（逐字规则：已带后缀则不重复拼接） */
export function chatEndpoint(url) {
    const u = trimUrl(url);
    return /\/chat\/completions$/i.test(u) ? u : u + '/chat/completions';
}
export function modelsEndpoint(url) {
    const u = trimUrl(url);
    return /\/models$/i.test(u) ? u : u + '/models';
}
export function embeddingsEndpoint(url) {
    const u = trimUrl(url);
    return /\/embeddings$/i.test(u) ? u : u + '/embeddings';
}
export function rerankEndpoint(url) {
    const u = trimUrl(url);
    return /\/rerank$/i.test(u) ? u : u + '/rerank';
}

/** 酒馆连接配置服务（`getSupportedProfiles` 会在 connection-manager 扩展被禁用时抛错 → 如实回报） */
export function connectionService() {
    const ctx = getCtx();
    const svc = ctx && ctx.ConnectionManagerRequestService;
    return svc && typeof svc.sendRequest === 'function' ? svc : null;
}

/** 可用连接配置列表（不回显任何密钥） */
export function listConnectionProfiles() {
    const svc = connectionService();
    if (!svc) return { ok: false, profiles: [], error: '宿主未提供 ConnectionManagerRequestService（酒馆「连接管理」扩展不可用或版本过旧）' };
    try {
        const raw = typeof svc.getSupportedProfiles === 'function' ? svc.getSupportedProfiles() : [];
        const profiles = (Array.isArray(raw) ? raw : []).map((p) => ({
            id: str(p && p.id),
            name: str(p && p.name) || str(p && p.model) || str(p && p.id),
            api: str(p && p.api),
            model: str(p && p.model),
            preset: str(p && p.preset),
        })).filter((p) => p.id);
        return { ok: true, profiles };
    } catch (e) {
        return { ok: false, profiles: [], error: String((e && e.message) || e) };
    }
}

/** 三通道可用性（UI 与 `FTT.apiChannelSummary()` 用） */
export function apiChannelAvailability() {
    const ctx = getCtx();
    const prof = listConnectionProfiles();
    return {
        host: {
            available: !!(ctx && typeof ctx.generateRaw === 'function'),
            reason: !!(ctx && typeof ctx.generateRaw === 'function') ? '' : '宿主 generateRaw 不可用',
        },
        profile: {
            available: prof.ok && prof.profiles.length > 0,
            reason: prof.ok ? (prof.profiles.length ? '' : '酒馆里还没有可用的连接配置') : prof.error,
            count: prof.profiles.length,
        },
        direct: {
            available: typeof globalThis.fetch === 'function',
            reason: typeof globalThis.fetch === 'function' ? '' : '当前环境没有 fetch',
        },
    };
}

/** 自建连接是否具备最小可用条件（V1 `callChatCompletion`：`!api.url || !api.model` → 报「API 未配置」） */
export function targetUsable(target) {
    const t = target || {};
    if (t.channel === 'profile') {
        if (!str(t.profileId)) return { ok: false, error: '未选择酒馆连接配置' };
        const prof = listConnectionProfiles();
        if (!prof.ok) return { ok: false, error: prof.error };
        const hit = prof.profiles.filter((p) => p.id === str(t.profileId))[0];
        if (!hit) return { ok: false, error: '连接配置不存在（可能已被删除）：' + str(t.profileId) };
        return { ok: true, profile: hit };
    }
    if (t.channel === 'direct') {
        if (!trimUrl(t.apiUrl)) return { ok: false, error: '未配置 API 地址' };
        if (!str(t.model)) return { ok: false, error: '未配置模型' };
        return { ok: true };
    }
    const ctx = getCtx();
    if (!ctx || typeof ctx.generateRaw !== 'function') return { ok: false, error: '宿主 generateRaw 不可用' };
    return { ok: true };
}

function withTimeout(timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DIRECT_TIMEOUT_MS;
    if (typeof AbortController !== 'function') return { init: {}, done: () => undefined };
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* noop */ } }, ms);
    return { init: { signal: ac.signal }, done: () => { try { clearTimeout(timer); } catch (e) { /* noop */ } } };
}

/**
 * 经酒馆**连接配置**发送（`ConnectionManagerRequestService.sendRequest`）。
 * `temperature`/`topP` 经 `overridePayload` 覆盖（酒馆官方扩展 API 支持的按次覆盖）；
 * `maxTokens` 为 `sendRequest` 的独立形参。
 */
export async function sendViaProfile({ profileId, systemPrompt, prompt, maxTokens, temperature, topP } = {}) {
    const svc = connectionService();
    if (!svc) return { ok: false, error: '酒馆连接配置服务不可用（请在酒馆扩展里启用「连接管理」）' };
    const id = str(profileId);
    if (!id) return { ok: false, error: '未选择酒馆连接配置' };
    const messages = [];
    if (str(systemPrompt)) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt == null ? '' : prompt) });
    const override = {};
    if (String(temperature) !== '' && Number.isFinite(Number(temperature))) override.temperature = Number(temperature);
    if (String(topP) !== '' && Number.isFinite(Number(topP))) override.top_p = Number(topP);
    const mt = Number(maxTokens);
    const maxOut = Number.isFinite(mt) && mt > 0 ? mt : undefined;
    try {
        const data = await svc.sendRequest(id, messages, maxOut, { stream: false, extractData: true, includePreset: true, includeInstruct: true }, override);
        const text = data && typeof data === 'object' ? String(data.content == null ? '' : data.content) : String(data == null ? '' : data);
        return { ok: true, text, via: 'profile', profileId: id };
    } catch (e) {
        const cause = e && e.cause ? String((e.cause && e.cause.message) || e.cause) : '';
        const msg = String((e && e.message) || e);
        return { ok: false, error: (msg + (cause ? '：' + cause : '')).slice(0, 300) };
    }
}

/** 自建连接直连（V1 `callChatCompletion` 的端点/鉴权/请求体语义逐条移植） */
export async function sendDirect({ apiUrl, apiKey, model, systemPrompt, prompt, temperature, maxTokens, topP, timeoutMs } = {}) {
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: '当前环境没有 fetch' };
    const url = trimUrl(apiUrl);
    if (!url) return { ok: false, error: '未配置 API 地址' };
    if (!str(model)) return { ok: false, error: '未配置模型' };
    const messages = [];
    if (str(systemPrompt)) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt == null ? '' : prompt) });
    const headers = { 'Content-Type': 'application/json' };
    if (str(apiKey)) headers.Authorization = 'Bearer ' + str(apiKey);
    // V1 `callChatCompletion` 的真实请求体含 `stream:false`（本机 V1 v1.206 实测，见黄金样本 requests[].body）
    const body = { model: str(model), messages, stream: false };
    if (String(temperature) !== '' && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
    if (String(topP) !== '' && Number.isFinite(Number(topP))) body.top_p = Number(topP);
    if (String(maxTokens) !== '' && Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
    const t = withTimeout(timeoutMs);
    try {
        const res = await globalThis.fetch(chatEndpoint(url), { method: 'POST', headers, body: JSON.stringify(body), ...t.init });
        if (!res || !res.ok) {
            const txt = res && typeof res.text === 'function' ? await res.text().catch(() => (res && res.statusText) || '') : '';
            return { ok: false, error: ('HTTP ' + ((res && res.status) || 0) + ': ' + String(txt).slice(0, 200)) };
        }
        const j = typeof res.json === 'function' ? await res.json() : null;
        const text = (j && j.choices && j.choices[0] && ((j.choices[0].message && j.choices[0].message.content) || j.choices[0].text)) || '';
        return { ok: true, text: String(text == null ? '' : text), via: 'direct', url: chatEndpoint(url) };
    } catch (e) {
        const msg = String((e && e.message) || e);
        // 浏览器直连的常见失败：CORS / 网络不可达 —— 如实回报并给出可操作建议
        const hint = /Failed to fetch|NetworkError|Load failed/i.test(msg) ? '（浏览器直连失败：多为目标服务未开放 CORS，或网络不可达；可改用「酒馆连接配置」通道）' : '';
        return { ok: false, error: (msg + hint).slice(0, 300) };
    } finally { t.done(); }
}

/** 按 target 发送（host 通道不在此处理，由 `host/generation.js#rawGenerate` 走 `generateRaw`） */
export async function sendWithTarget(target, { systemPrompt, prompt } = {}) {
    const t = target || {};
    const use = targetUsable(t);
    if (!use.ok) return { ok: false, error: use.error };
    if (t.channel === 'profile') {
        return await sendViaProfile({
            profileId: t.profileId, systemPrompt, prompt,
            maxTokens: t.maxTokens, temperature: t.temperature, topP: t.topP,
        });
    }
    if (t.channel === 'direct') {
        return await sendDirect({
            apiUrl: t.apiUrl, apiKey: t.apiKey, model: t.model, systemPrompt, prompt,
            temperature: t.temperature, maxTokens: t.maxTokens, topP: t.topP,
        });
    }
    return { ok: false, error: 'host 通道应由宿主 generateRaw 处理' };
}

/**
 * 连通性测试（V1 `testApi(override, kind)` 逐条等价）：
 *   · `chat`（默认）：`POST /chat/completions`，`{model, messages:[{role:'user',content:'ping'}], max_tokens:1}`；
 *   · `embedding` / `rerank`：**向量层尚未在 V2 接线**，此处按 V1 语义保留实现（供向量层批次直接复用），
 *     UI 暂不暴露按钮（避免"假控件"）。
 * 返回 `{ok:true,ms,kind}` 或 `{ok:false,error}`（错误文案与 V1 同源：未配置地址/模型、`HTTP <code>: <body>`）。
 */
export async function probeTarget(target, kind, timeoutMs) {
    const t = target || {};
    const k = str(kind) || 'chat';
    if (t.channel === 'profile') {
        if (k !== 'chat') return { ok: false, error: '连接配置通道仅支持 chat 测试' };
        const use = targetUsable(t);
        if (!use.ok) return { ok: false, error: use.error };
        const t0 = Date.now();
        const r = await sendViaProfile({ profileId: t.profileId, prompt: 'ping', maxTokens: 1, temperature: t.temperature, topP: t.topP });
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, ms: Date.now() - t0, kind: 'chat', via: 'profile' };
    }
    if (t.channel === 'host') {
        return { ok: false, error: '当前通道为「跟随酒馆当前连接」，请改用「酒馆连接配置」或「自建连接」后再测试（或直接用酒馆"连接"面板的测试）' };
    }
    const url = trimUrl(t.apiUrl);
    if (!url) return { ok: false, error: '未配置 API 地址' };
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: '当前环境没有 fetch' };
    const headers = { 'Content-Type': 'application/json' };
    if (str(t.apiKey)) headers.Authorization = 'Bearer ' + str(t.apiKey);
    const t0 = Date.now();
    // v2.79.0：允许调用方指定超时（向量区块的「🧪 测试」传 `cfg.vectorTimeoutMs`，与「检索参数 · 超时(ms)」一致；
    //   此前该测试恒用默认 120s，用户把超时设成 15s 也不生效）。
    const tOut = withTimeout(timeoutMs);
    try {
        if (k === 'embedding' || k === 'rerank') {
            if (!str(t.model)) return { ok: false, error: k === 'embedding' ? '未配置 Embedding 模型' : '未配置 Rerank 模型' };
            const req = k === 'embedding'
                ? { url: embeddingsEndpoint(url), body: { model: str(t.model), input: ['测试'] } }
                : { url: rerankEndpoint(url), body: { model: str(t.model), query: '测试', documents: ['测试文档'], top_n: 1 } };
            const res = await globalThis.fetch(req.url, { method: 'POST', headers, body: JSON.stringify(req.body), ...tOut.init });
            if (!res || !res.ok) {
                const txt = res && typeof res.text === 'function' ? await res.text().catch(() => (res && res.statusText) || '') : '';
                return { ok: false, error: 'HTTP ' + ((res && res.status) || 0) + ': ' + String(txt).slice(0, 200) };
            }
            return { ok: true, ms: Date.now() - t0, kind: k };
        }
        if (!str(t.model)) return { ok: false, error: '未配置模型' };
        const res = await globalThis.fetch(chatEndpoint(url), {
            method: 'POST', headers,
            body: JSON.stringify({ model: str(t.model), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
            ...tOut.init,
        });
        if (!res || !res.ok) {
            const txt = res && typeof res.text === 'function' ? await res.text().catch(() => (res && res.statusText) || '') : '';
            return { ok: false, error: 'HTTP ' + ((res && res.status) || 0) + ': ' + String(txt).slice(0, 200) };
        }
        return { ok: true, ms: Date.now() - t0, kind: 'chat' };
    } catch (e) {
        const msg = String((e && e.message) || e);
        const hint = /Failed to fetch|NetworkError|Load failed/i.test(msg) ? '（浏览器直连失败：多为目标服务未开放 CORS，或网络不可达）' : '';
        return { ok: false, error: (msg + hint).slice(0, 300) };
    } finally { tOut.done(); }
}

/** 获取模型列表（V1 `fetchModels(override)` 逐条等价：端点、鉴权、`data`/`models` 两形态解析与报错文案） */
export async function fetchModels(target) {
    const t = target || {};
    if (t.channel === 'host') return { ok: false, error: '当前通道为「跟随酒馆当前连接」，模型由酒馆连接面板决定；请改用「酒馆连接配置」或「自建连接」' };
    if (t.channel === 'profile') return { ok: false, error: '「酒馆连接配置」通道的模型由该连接配置决定（请在酒馆「连接」面板的模型下拉里选择）' };
    const url = trimUrl(t.apiUrl);
    if (!url) return { ok: false, error: '未配置 API 地址' };
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: '当前环境没有 fetch' };
    const headers = {};
    if (str(t.apiKey)) headers.Authorization = 'Bearer ' + str(t.apiKey);
    const tOut = withTimeout();
    try {
        const res = await globalThis.fetch(modelsEndpoint(url), { method: 'GET', headers, ...tOut.init });
        if (!res || !res.ok) {
            const txt = res && typeof res.text === 'function' ? await res.text().catch(() => (res && res.statusText) || '') : '';
            return { ok: false, error: 'HTTP ' + ((res && res.status) || 0) + ': ' + String(txt).slice(0, 200) };
        }
        const j = typeof res.json === 'function' ? await res.json() : null;
        const data = Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.models) ? j.models : [];
        const models = data.map((m) => str(m && (m.id || m.model || m.name))).filter(Boolean);
        if (!models.length) return { ok: false, error: '未解析到模型列表' };
        return { ok: true, models };
    } catch (e) {
        const msg = String((e && e.message) || e);
        const hint = /Failed to fetch|NetworkError|Load failed/i.test(msg) ? '（浏览器直连失败：多为目标服务未开放 CORS，或网络不可达）' : '';
        return { ok: false, error: (msg + hint).slice(0, 300) };
    } finally { tOut.done(); }
}
