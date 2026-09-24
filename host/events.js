// ============================================================
// host/events.js —— 酒馆事件绑定（对齐 V1 九事件；解绑干净）
// ============================================================
import { HOST_EVENTS } from '../core/constants.js';
import { getCtx } from './st-api.js';

/**
 * 绑定核心事件。
 * @param {Record<string, Function>} handlers 事件名 → 处理函数（未提供的事件跳过）
 * @returns {{ bound: string[], missing: string[], unbind: Function }}
 */
export function bindCoreEvents(handlers) {
    const ctx = getCtx();
    const h = handlers || {};
    const bound = [], missing = [];
    const offs = [];
    const es = ctx && ctx.eventSource;
    const et = (ctx && ctx.eventTypes) || {};
    for (const name of HOST_EVENTS) {
        const fn = h[name];
        if (typeof fn !== 'function') continue;
        const type = et[name] || name;
        if (!es || typeof es.on !== 'function') { missing.push(name); continue; }
        try {
            es.on(type, fn);
            offs.push(() => { try { if (typeof es.removeListener === 'function') es.removeListener(type, fn); else if (typeof es.off === 'function') es.off(type, fn); } catch (e) { /* noop */ } });
            bound.push(name);
        } catch (e) {
            missing.push(name);
        }
    }
    return { bound, missing, unbind: () => { for (const off of offs) off(); } };
}

/** 供探针/调试：九事件在当前宿主是否都能拿到常量 */
export function eventTypeAvailability() {
    const ctx = getCtx();
    const et = (ctx && ctx.eventTypes) || {};
    return HOST_EVENTS.map(n => ({ name: n, available: !!et[n] }));
}
