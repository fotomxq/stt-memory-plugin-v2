// ============================================================
// host/chat.js —— 聊天读取与内核注入接线（P2）
// 职责：把 ST 上下文的聊天数据接进内核的注入钩子（core/model/runtime.js 的 setChatHooks /
//   setScopeKey / setLastMessageId / setKernelState），使逐字移植的 V1 内核代码无需改写即可运行。
// 事实源：docs/P0-探针报告.md（getContext 键位：chat / characters / characterId / name1 / name2）。
// ============================================================
import { getCtx } from './st-api.js';
import { setChatHooks, setLastMessageId, setScopeKey, setKernelState, getChatMessages } from '../core/model/runtime.js';

/** ST 聊天消息是 `{ is_user, mes, name, ... }`；内核沿用 V1 的 `{ is_user, message }` 口径 */
function toKernelMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const text = String(m.mes != null ? m.mes : (m.message != null ? m.message : ''));
    return {
        is_user: m.is_user === true,
        message: text,
        mes: text,
        name: String(m.name == null ? '' : m.name),
        send_date: m.send_date || '',
    };
}

/** 取内核口径的聊天消息数组（倒序无关；保持与 ST 同序） */
export function kernelChatMessages() {
    const ctx = getCtx();
    if (!ctx || !Array.isArray(ctx.chat)) return [];
    const out = [];
    for (const m of ctx.chat) {
        const k = toKernelMessage(m);
        if (k) out.push(k);
    }
    return out;
}

/** 最新一条 AI（非用户）消息的正文（V1 `latestAiFloorText` 的口径：从尾向前找 is_user=false） */
export function latestAiMessageText() {
    const list = kernelChatMessages();
    for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i].is_user && String(list[i].message || '').trim()) return String(list[i].message);
    }
    return '';
}

/** 最后一条消息的楼层号（= 数组下标；空聊天为 -1） */
export function currentLastMessageId() {
    const ctx = getCtx();
    if (!ctx || !Array.isArray(ctx.chat) || !ctx.chat.length) return -1;
    return ctx.chat.length - 1;
}

/** 当前角色稳定标识（优先角色文件名 avatar；见 st-api.currentCharScope 的口径） */
export function currentStableCharKey() {
    const ctx = getCtx();
    if (!ctx) return '';
    try {
        const idx = ctx.characterId;
        const ch = (Array.isArray(ctx.characters) && idx !== undefined && idx !== null) ? ctx.characters[Number(idx)] : null;
        if (ch && ch.avatar) return String(ch.avatar);
    } catch (e) { /* 忽略 */ }
    return String(ctx.name2 || '').trim();
}

/**
 * 把宿主聊天能力接进内核（幂等；返回接线摘要）。
 * 调用时机：启动（APP_READY）、切换聊天、每次消息渲染后（楼层号会变）。
 */
export function wireKernelChatHooks() {
    const messages = kernelChatMessages();
    setChatHooks({
        getChatMessages: kernelChatMessages,
        getAssistantText: latestAiMessageText,
        latestAiFloorText: latestAiMessageText,
        dbgLog: () => undefined,
    });
    setLastMessageId(currentLastMessageId());
    setScopeKey(currentStableCharKey());
    return {
        messages: messages.length,
        lastMessageId: currentLastMessageId(),
        scopeKey: currentStableCharKey(),
        assistantChars: latestAiMessageText().length,
    };
}

/** 把某个 state 注入内核（载入/切换角色/跨端合并后调用） */
export function attachKernelState(state) {
    setKernelState(state || null);
    return state || null;
}

/** 内核当前看到的聊天消息（调试用） */
export function kernelChatDebug() {
    return { count: getChatMessages().length, assistantChars: latestAiMessageText().length, lastMessageId: currentLastMessageId(), scopeKey: currentStableCharKey() };
}
