// ============================================================
// host/generation.js —— AI 调用（generateRaw / generateQuietPrompt）
// 事实源：ST 官方文档（含 jsonSchema 结构化输出）+ getContext 键位
// 约定：所有调用返回统一结果对象（不抛异常）；缺能力时明确降级并回报原因。
// ============================================================
import { getCtx } from './st-api.js';
import { extractJsonObject } from '../core/util.js';
import { sendWithTarget } from './api-channel.js';

function ctxHas(name) {
    const ctx = getCtx();
    return !!(ctx && typeof ctx[name] === 'function');
}

/**
 * 原始生成（完全自控提示词）：返回 { ok, text, error }。
 *
 * v2.35.0（API 三通道）：
 *   · `target.channel === 'profile'` → 经酒馆**连接配置**发送（`host/api-channel.js#sendViaProfile`，
 *     支持 `temperature` / `top_p` / `max_tokens` 按次覆盖）；
 *   · `target.channel === 'direct'`  → **自建连接**直连（V1 `callChatCompletion` 等价物）；
 *   · 否则（`host`，含未传 target）→ 宿主 `generateRaw`（V2 既有行为**逐字节不变**）。
 * `host` 通道的 `max_tokens` 经宿主 `responseLength` 形参**真实生效**（ST `public/script.js:3987` 的
 *   `TempResponseLength.save(api, responseLength)` → 临时改写 `oai_settings.openai_max_tokens`）；
 *   `temperature` / `top_p` 在 `generateRaw` 签名里**没有**对应形参（`public/script.js:4109`），
 *   该通道下**不生效**（UI 已如实标注）。
 */
export async function rawGenerate({ systemPrompt, prompt, prefill, jsonSchema, target } = {}) {
    const t = target && typeof target === 'object' ? target : null;
    if (t && (t.channel === 'profile' || t.channel === 'direct')) {
        const r = await sendWithTarget(t, { systemPrompt, prompt });
        return r.ok ? { ok: true, text: String(r.text == null ? '' : r.text), via: t.channel } : { ok: false, error: String(r.error || 'api-error') };
    }
    const ctx = getCtx();
    if (!ctx || typeof ctx.generateRaw !== 'function') return { ok: false, error: 'generateRaw 不可用' };
    const payload = {};
    if (systemPrompt) payload.systemPrompt = String(systemPrompt);
    if (prompt !== undefined) payload.prompt = prompt;
    if (prefill) payload.prefill = String(prefill);
    if (jsonSchema) payload.jsonSchema = jsonSchema;
    // host 通道的 max_tokens：经 responseLength 临时覆盖（仅当配置了上限且为正数）
    const mt = t ? Number(t.maxTokens) : NaN;
    if (Number.isFinite(mt) && mt > 0) payload.responseLength = mt;
    try {
        const text = await ctx.generateRaw(payload);
        return { ok: true, text: String(text == null ? '' : text), via: 'host' };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 后台静默生成（quiet prompt，不进对话 UI） */
export async function quietGenerate({ quietPrompt, jsonSchema } = {}) {
    const ctx = getCtx();
    if (!ctx || typeof ctx.generateQuietPrompt !== 'function') return { ok: false, error: 'generateQuietPrompt 不可用' };
    const payload = { quietPrompt: String(quietPrompt == null ? '' : quietPrompt) };
    if (jsonSchema) payload.jsonSchema = jsonSchema;
    try {
        const text = await ctx.generateQuietPrompt(payload);
        return { ok: true, text: String(text == null ? '' : text) };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 生成并解析 JSON（结构化输出失败时回退文本解析） */
export async function generateJson(opts) {
    const r = await rawGenerate(opts);
    if (!r.ok) return { ok: false, error: r.error, data: null };
    const data = extractJsonObject(r.text);
    return data ? { ok: true, data, text: r.text } : { ok: false, error: 'JSON 解析失败', data: null, text: r.text };
}

export function generationAvailability() {
    return { generateRaw: ctxHas('generateRaw'), generateQuietPrompt: ctxHas('generateQuietPrompt') };
}
