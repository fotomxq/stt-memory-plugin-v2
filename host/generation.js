// ============================================================
// host/generation.js —— AI 调用（generateRaw / generateQuietPrompt）
// 事实源：ST 官方文档（含 jsonSchema 结构化输出）+ getContext 键位
// 约定：所有调用返回统一结果对象（不抛异常）；缺能力时明确降级并回报原因。
// ============================================================
import { getCtx } from './st-api.js';
import { extractJsonObject } from '../core/util.js';

function ctxHas(name) {
    const ctx = getCtx();
    return !!(ctx && typeof ctx[name] === 'function');
}

/** 原始生成（完全自控提示词）：返回 { ok, text, error } */
export async function rawGenerate({ systemPrompt, prompt, prefill, jsonSchema } = {}) {
    const ctx = getCtx();
    if (!ctx || typeof ctx.generateRaw !== 'function') return { ok: false, error: 'generateRaw 不可用' };
    const payload = {};
    if (systemPrompt) payload.systemPrompt = String(systemPrompt);
    if (prompt !== undefined) payload.prompt = prompt;
    if (prefill) payload.prefill = String(prefill);
    if (jsonSchema) payload.jsonSchema = jsonSchema;
    try {
        const text = await ctx.generateRaw(payload);
        return { ok: true, text: String(text == null ? '' : text) };
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
