// ============================================================
// host/ai-usage.js —— **AI 用量记账的宿主侧小助手**（v3.42.0）
//
// 为什么单独一个文件：记账有三个落点（`host/generation.js` 的 host 通道、`host/api-channel.js` 的
//   `sendDirect` / `sendViaProfile`），而 `host/api-channel.js` 已被 `host/generation.js` 引用 ——
//   把「算字符数 + 取模型名 + 落一条账」抽到本模块，避免两个文件互相引用形成环。
//
// 口径（与 `core/token-cost.js` 头注同一份）：
//   · **被动**：只在一次请求**结束时**落一条（成功 / 失败都记；失败记 0 token 的失败计数）；
//   · **不保存正文**：只记字符数 / token / 模型 / 标签 / 渠道 / 耗时；
//   · **不介入请求**：任何异常都被吞掉，绝不影响 AI 调用本身。
// ============================================================
import { recordAiUsage } from '../core/token-cost.js';
import { getCtx } from './st-api.js';

/**
 * 提示词字符数（与 `core/ai-hooks.js#aiCallText` / `host/extract.js#genTracked` 同一算法：
 * `systemPrompt` + `prompt` 的字符数之和）。
 */
export function promptCharsOf(systemPrompt, prompt) {
    try {
        return String(systemPrompt == null ? '' : systemPrompt).length + String(prompt == null ? '' : prompt).length;
    } catch (e) { return 0; }
}

/**
 * 宿主通道（跟随酒馆当前连接）的**模型名（best-effort）**。
 * `generateRaw` 不回报模型名，故只能尝试宿主暴露的读取口；取不到返回空串 →
 *   `core/token-cost.js` 记为 `(未识别)`，用户可在设定页为这个键单独填单价（口径见 UI 提示）。
 */
export function hostModelName() {
    try {
        const ctx = getCtx();
        if (!ctx) return '';
        const cands = [
            typeof ctx.getChatCompletionModel === 'function' ? ctx.getChatCompletionModel() : '',
            ctx.oai_settings && ctx.oai_settings.openai_model,
            ctx.oai_settings && ctx.oai_settings.claude_model,
        ];
        for (const c of cands) {
            const s = String(c == null ? '' : c).trim();
            if (s) return s;
        }
    } catch (e) { /* 忽略：取不到模型名不影响记账 */ }
    return '';
}

/**
 * 落一条账（**吞异常**：记账失败绝不影响 AI 调用）。
 * @param {{label?:string, model?:string, channel?:string, purpose?:string, systemPrompt?:string, prompt?:string,
 *          respChars?:number, usage?:object|null, ok?:boolean, ms?:number}} o
 * @returns {object|null} 明细条目（失败 → null）
 */
export function noteAiUsage(o) {
    try {
        const r = o || {};
        return recordAiUsage({
            label: r.label,
            model: r.model || '(未识别)',
            channel: r.channel,
            purpose: r.purpose,
            promptChars: r.promptChars != null ? r.promptChars : promptCharsOf(r.systemPrompt, r.prompt),
            respChars: r.respChars,
            usage: r.usage || null,
            ok: r.ok !== false,
            ms: r.ms,
        });
    } catch (e) { return null; }
}
