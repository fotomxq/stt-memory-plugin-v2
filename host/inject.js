// ============================================================
// host/inject.js —— 记忆注入通道（setExtensionPrompt）
// 事实源：script.js `setExtensionPrompt(key, value, position, depth, scan = false, role = 0, filter = null)`
// 约定：注入键唯一；关闭/禁用/无内容时必须显式置空，避免残留旧注入。
// ============================================================
import { INJECT_ID, PROMPT_POSITION, PROMPT_ROLE } from '../core/constants.js';
import { getCtx, safeCall } from './st-api.js';

export const DEFAULT_INJECT_OPTS = Object.freeze({
    position: PROMPT_POSITION.IN_PROMPT,
    depth: 0,
    scan: false,
    role: PROMPT_ROLE.SYSTEM,
});

/**
 * 写入注入文本。
 * @param {string} text 注入正文（空串 = 清空）
 * @param {object} [opts] position/depth/scan/role
 * @returns {{ ok: boolean, reason?: string, length: number }}
 */
export function setInject(text, opts) {
    const o = Object.assign({}, DEFAULT_INJECT_OPTS, opts || {});
    const value = String(text == null ? '' : text);
    const r = safeCall('setExtensionPrompt', INJECT_ID, value, o.position, o.depth, !!o.scan, o.role);
    return r.ok ? { ok: true, length: value.length } : { ok: false, reason: r.reason, length: 0 };
}

/** 清空注入（禁用扩展 / 关闭插件 / 无内容时都必须调） */
export function clearInject() {
    return setInject('', DEFAULT_INJECT_OPTS);
}

/** 读回当前注入值（调试与断言用） */
export function readInject() {
    const ctx = getCtx();
    const p = ctx && ctx.extensionPrompts && ctx.extensionPrompts[INJECT_ID];
    return p ? String(p.value == null ? '' : p.value) : '';
}

/** 注入通道是否可用 */
export function injectAvailable() {
    const ctx = getCtx();
    return !!(ctx && typeof ctx.setExtensionPrompt === 'function');
}
