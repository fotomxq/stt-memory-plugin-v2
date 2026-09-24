// ============================================================
// host/interceptor.js —— 生成前拦截器（manifest.generate_interceptor 指向的全局函数）
// 事实源：ST 官方文档「Prompt Interceptors」——入参 (chat, contextSize, abort, type)；
// 约定（硬规则）：**永不调用 abort**，任何失败都必须放行（消息一定发得出去）。
// P0 只建立骨架与可观测性；提取/注入闭环在 P3 接入 core/recall。
// ============================================================
import { VERSION, INJECT_ID } from '../core/constants.js';

const state = {
    calls: 0,
    lastType: '',
    lastAt: 0,
    lastError: '',
    lastChatSize: 0,
    lastContextSize: 0,
    injectedLength: 0,
};

export function interceptorStats() {
    return Object.assign({}, state, { version: VERSION, injectKey: INJECT_ID });
}

export function resetInterceptorStats() {
    state.calls = 0; state.lastType = ''; state.lastAt = 0; state.lastError = '';
    state.lastChatSize = 0; state.lastContextSize = 0; state.injectedLength = 0;
}

/**
 * 生成前钩子。P0：只记录调用（不做提取/注入），永不 abort。
 * @param {Array} chat 本次生成将使用的聊天消息数组（可改，但本插件不改）
 * @param {number} contextSize 本次请求的上下文 token 预算
 * @param {Function} abort 中止函数（**本插件永不调用**）
 * @param {string} type 生成类型（normal/regenerate/swipe/quiet/impersonate…）
 * @returns {Promise<void>}
 */
export async function fttGenerateInterceptor(chat, contextSize, abort, type) {
    try {
        state.calls += 1;
        state.lastType = String(type == null ? '' : type);
        state.lastAt = Date.now();
        state.lastChatSize = Array.isArray(chat) ? chat.length : -1;
        state.lastContextSize = Number(contextSize) || 0;
        // P3：在此处调用 core/recall + host/inject.setInject 完成「发送前提取与注入」。
        // 此处刻意不调用 abort( )，也不修改 chat。
        void abort;
    } catch (e) {
        state.lastError = String((e && e.message) || e);
    }
}

/** 挂到全局（manifest 的 generate_interceptor 按名字查找全局函数） */
export function installGlobalInterceptor(name) {
    const key = name || 'fttGenerateInterceptor';
    try {
        globalThis[key] = fttGenerateInterceptor;
        return true;
    } catch (e) {
        return false;
    }
}

/** 卸载全局钩子（disable/delete 时调用） */
export function uninstallGlobalInterceptor(name) {
    const key = name || 'fttGenerateInterceptor';
    try {
        if (globalThis[key] === fttGenerateInterceptor) delete globalThis[key];
        return true;
    } catch (e) {
        return false;
    }
}
