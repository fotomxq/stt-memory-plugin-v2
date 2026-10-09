// ============================================================
// host/chat.js —— 聊天读取与内核注入接线（P2）
// 职责：把 ST 上下文的聊天数据接进内核的注入钩子（core/model/runtime.js 的 setChatHooks /
//   setScopeKey / setLastMessageId / setKernelState），使逐字移植的 V1 内核代码无需改写即可运行。
// 事实源：docs/history/P0-探针报告.md（getContext 键位：chat / characters / characterId / name1 / name2）。
// ============================================================
import { getCtx } from './st-api.js';
import { setChatHooks, setLastMessageId, setScopeKey, setKernelState, kernelState, getChatMessages, state } from '../core/model/runtime.js';
import { debugLogPush, debugLogPushCoalesced } from '../adapters/debug-log.js';
// v2.44.0（用户报告）：酒馆消息正文是可含 HTML 的富文本（`<br>`/`<p>`/`&nbsp;`…）→ 在**读入边界**统一清洗，
//   这样「提取提示词 / 剧情时钟 / 楼层哈希之外的取文」都不会把标签带进数据（哈希仍用原始稳定正文，见 host/floors.js）
import { cleanText, hasHtmlTag, htmlStats } from '../core/html-text.js';
import { traceEvent } from '../core/trace.js';

/** ST 聊天消息是 `{ is_user, mes, name, ... }`；内核沿用 V1 的 `{ is_user, message }` 口径 */
function toKernelMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const rawText = String(m.mes != null ? m.mes : (m.message != null ? m.message : ''));
    // v2.44.0：含标签才清洗（无标签路径零改动），并把剔除情况记入追踪时间线（可回答「AI 看到的正文里为什么没有 `<br>`」）
    const text = hasHtmlTag(rawText) ? (() => {
        const st = htmlStats(rawText);
        try {
            traceEvent({
                cat: 'kernel', kind: 'html-clean', level: 'debug',
                detail: { where: 'host/chat.js', tags: Number(st.tags) || 0, entities: Number(st.entities) || 0, block: (st.block || []).join(' '), name: String(m.name == null ? '' : m.name) },
                dedupeKey: 'html-clean|' + (Number(st.tags) || 0),
            });
        } catch (e) { /* 追踪失败不影响读文 */ }
        return cleanText(rawText);
    })() : rawText;
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

/**
 * v3.20.0：**当前聊天的稳定标识**（`state.chatKey` 的来源；用于给情节打「聊天归属」）。
 *
 * 为什么需要：记忆容器按**角色**存（`scope: char:xxxx`），同一角色的多条聊天共用一份 `atoms` ——
 *   别条聊天/旧聊天的情节混在里面，楼层号在本聊天里没有意义，却会参与「最新情节」排序 →
 *   时钟长期显示别条故事的时间（真机取证见 `core/chat-scope.js` 头注）。
 *
 * 取值优先级（都取不到就返回 `''` = 判不出来，此时**不打标、不改排序**）：
 *   ① `chatMetadata.chat_id_hash` —— 宿主写在**聊天文件里**的稳定哈希（随聊天文件走，最可靠）；
 *   ② `ctx.chatId` —— 酒馆的聊天标识 / 文件名；
 *   ③ `chatMetadata.integrity` —— 聊天文件里的 UUID。
 * 只**读**聊天元数据，绝不写入（写路径另属阶段 S3，见 adapters/chat-meta.js 头注）。
 * @returns {string}
 */
export function currentChatKey() {
    const ctx = getCtx();
    if (!ctx) return '';
    try {
        const m = (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') ? ctx.chatMetadata : null;
        const norm = (v) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, 80) : ''; };
        const h = m ? norm(m.chat_id_hash) : '';
        if (h) return h;
        const id = norm(ctx.chatId);
        if (id) return id;
        const ig = m ? norm(m.integrity) : '';
        if (ig) return ig;
    } catch (e) { /* 忽略 */ }
    return '';
}

/**
 * 把「当前聊天标识」记进内核状态（幂等）。
 *   · 标识**读不到**时写空串：宁可「归属未知」，也不能把新聊天的新情节错打成上一条聊天的归属；
 *   · 返回 `changed` 供调用方决定是否重解析时钟（切聊天 → 时钟应立刻切到本聊天的最新情节）。
 * @returns {{changed:boolean, key:string, from:string, applied:boolean}}
 */
export function noteChatKey() {
    const key = currentChatKey();
    const st = state;
    if (!st || typeof st !== 'object') return { changed: false, key: key, from: '', applied: false };
    const prev = String(st.chatKey || '');
    if (prev === key) return { changed: false, key: key, from: prev, applied: true };
    st.chatKey = key;
    try { traceEvent({ cat: 'kernel', kind: 'chat-key', level: 'info', detail: { from: prev.slice(0, 12), to: key.slice(0, 12), where: 'host/chat.js' }, dedupeKey: 'chat-key|' + key.slice(0, 12) }); } catch (e) { /* 追踪失败不影响记账 */ }
    try { debugLogPush('楼层', { action: '聊天归属已更新', from: prev ? prev.slice(0, 12) : '（无）', to: key ? key.slice(0, 12) : '（读不到）' }); } catch (e) { /* 忽略 */ }
    return { changed: true, key: key, from: prev, applied: true };
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
        dbgLog: (kind, data) => debugLogPush(kind, data),      // B9：调试日志接入环形缓冲（V1 `dbgLog` 口径；此前为空实现）
        // v3.40.0（`docs/D16` L11）：合并式日志（高频成功写盘只占一条，带 n / lastAt / bytes）
        dbgLogCoalesced: (kind, key, data, opts) => debugLogPushCoalesced(kind, key, data, opts),
    });
    setLastMessageId(currentLastMessageId());
    setScopeKey(currentStableCharKey());
    // v3.20.0：同步「当前聊天标识」（切聊天 / 消息渲染 / 启动都会走到这里）——
    //   新落库的情节据此打 `chatKey`，时钟据此只采信本聊天的情节（见 core/chat-scope.js）。
    let chatKey = '';
    try { chatKey = noteChatKey().key; } catch (e) { /* 忽略 */ }
    return {
        messages: messages.length,
        lastMessageId: currentLastMessageId(),
        scopeKey: currentStableCharKey(),
        chatKey: chatKey,
        assistantChars: latestAiMessageText().length,
    };
}

/**
 * 把某个 state 注入内核（载入/切换角色/跨端合并后调用）
 *
 * v3.22.1：注入之后**立刻**记一次「当前聊天标识」。
 *   缺陷成因（真机取证）：`state.chatKey` 原本只在 `wireKernelChatHooks`（消息渲染 / 切聊天）里写，
 *   而**刷新页面**的首屏路径是「载入 → 合并 → attachKernelState → 重解析时钟」，此刻
 *   `state.chatKey` 还是空串 ⇒ 聊天分层（`core/chat-scope.js`）**失效** ⇒ 别条聊天的旧情节
 *   一并参与「最新情节」评选。真机上 13:18 那次「以滞后一天的服务端文件为基底 + local 并集」的
 *   载入就落在这个窗口里：时钟被 0198 年线的旧情节压回 `0198-05-16`，直到第 73 楼被分析后才自愈。
 *   这里补上「注入即归属」，让分层从**第一次解析**起就生效（幂等；读不到标识时按空串=归属未知，不放宽）。
 * @param {object} next 要注入的内核状态
 * @returns {object} 注入的状态（`state.chatKey` 已被就地更新）
 */
export function attachKernelState(next) {
    // v3.39.0（用户报告「本地召回失败 Cannot read properties of null (reading 'state')」）：
    //   **绝不把已注入的内核态降级成 null** —— 传入 falsy（异常路径 / 空合并结果）时保留当前态并如实记账。
    //   内核态为 null 会让所有 `state.*` 取用处抛错（本模块历史上已因此修过「楼层漂移防呆」一处）。
    if (!next || typeof next !== 'object') {
        const kept = (() => { try { return kernelState(); } catch (e) { return null; } })();
        try { debugLogPush('异常', { action: '注入内核态被拒绝（传入的不是对象）→ 保留当前态', kept: !!kept, got: String(typeof next) }); } catch (e) { /* 忽略 */ }
        return kept || null;
    }
    setKernelState(next);
    try { noteChatKey(); } catch (e) { /* 归属记账失败不阻断注入 */ }
    return next;
}

/** 内核当前看到的聊天消息（调试用） */
export function kernelChatDebug() {
    return { count: getChatMessages().length, assistantChars: latestAiMessageText().length, lastMessageId: currentLastMessageId(), scopeKey: currentStableCharKey() };
}
