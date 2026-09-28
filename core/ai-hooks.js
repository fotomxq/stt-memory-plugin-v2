// ============================================================
// core/ai-hooks.js —— AI 调用 / 投喂文本 / 长任务占用的**共用注入钩子**
// 目的：多个 AI 管线（时钟正则生成与修复、内容弱化 NSFW、后续修复域）共用同一套宿主接线，
//   内核保持零宿主依赖（不直连网络、不读宿主聊天、不感知任务管线）。
// 宿主接线见 `index.js`：`callAi` → ST `generateRaw`；`feedText` → `host/floors.js`；`busy` → `host/extract.js#extractBusy`。
// ============================================================
let hooks = {
    /** AI 调用：入参为 V1 口径的 messages 数组，返回 { ok, text } 或字符串 */
    callAi: async () => ({ ok: false, error: 'AI 调用未接线' }),
    /** 投喂文本：最近 N 楼（V1 `buildFeedFloorText`） */
    feedText: () => '',
    /** 长任务占用判定（摘要/提取/同步在途 → 拒绝本次 AI 管线） */
    busy: () => false,
};
/** 注入钩子（合并式；返回值即当前生效钩子，可用于「快照后再恢复」） */
export function setAiHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
// v2.90.0（用户要求）：管线状态 —— 流式摘要 / token 计数 / 预估倒计时
import { beginPipeline, endPipeline, addStreamChunk, noteResponseText, summarizeResponseKeys, setPipelinePhase, setPipelineKeys } from './pipeline.js';
/** 当前钩子（只读快照） */
export function aiHooks() { return Object.assign({}, hooks); }
/** 调用 AI 并归一为纯文本（失败/异常 → 空串） */
export async function aiCallText(messages, label) {
    // v2.90.0：AI 调用统一进「管线状态」—— 记录 prompt 字符数（token 估算）、阶段、响应结构摘要与耗时（预估倒计时样本）
    const chars = (() => {
        try {
            const list = Array.isArray(messages) ? messages : [];
            return list.reduce((n, m) => n + String((m && (m.content !== undefined ? m.content : m.text)) || '').length, 0);
        } catch (e) { return 0; }
    })();
    // v2.95.0：取回本轮的 `runId` 并**透传**给每一次增量/阶段/结束调用（并发安全：多路 AI 同时跑也不互相覆盖）
    let runId;
    try { runId = (beginPipeline(String(label || '默认'), { chars: chars, phase: '请求 AI' }) || {}).runId; } catch (e) { /* 忽略 */ }
    try {
        const r = await hooks.callAi(messages, { label: label, onToken: (chunk) => { try { addStreamChunk(chunk, { id: runId }); } catch (e) { /* 忽略 */ } } });
        const text = (r && typeof r === 'object') ? (r.ok === false ? '' : String(r.text == null ? '' : r.text)) : String(r == null ? '' : r);
        if (text) {
            try {
                // **整段响应**（非流式通道）→ 记字符数但**不计流式块**；已收到分块时按文本长度对齐、不重复累加
                noteResponseText(text, { id: runId });
                setPipelineKeys(summarizeResponseKeys(text), { id: runId });
                setPipelinePhase('解析响应', '响应 ' + text.length + ' 字', { id: runId });
            } catch (e) { /* 忽略 */ }
        }
        try { endPipeline(!!text, runId); } catch (e) { /* 忽略 */ }
        return text;
    } catch (e) {
        try { endPipeline(false, runId); } catch (e2) { /* 忽略 */ }
        return '';
    }
}
/** 取投喂文本（异常 → 空串） */
export function aiFeedText(maxFloors) {
    try { return String(hooks.feedText(maxFloors) || ''); } catch (e) { return ''; }
}
/** 长任务是否占用（异常 → 不占用） */
export function aiBusy() {
    try { return !!hooks.busy(); } catch (e) { return false; }
}
