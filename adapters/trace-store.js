// ============================================================
// adapters/trace-store.js —— **交互/宿主追踪的宿主持久化**（v2.42.0）
//   只持久化**摘要尾部**（最近 `TRACE_STORE_CAP` 条：id/at/cat/kind/ok/opId/站点），不存 detail ——
//   目的是「刷新页面后仍能看到出错前的交互与调用顺序」，同时避免 localStorage 膨胀。
//   无 localStorage（Node 测试/受限宿主）时自动退化；损坏数据容忍（解析失败 → 空）。
// ============================================================
import { setTraceHooks } from '../core/trace.js';

/** 持久化键（与 V1 调试日志 `SPreset_FTTMemoryDebug` 并列，互不覆盖） */
export const TRACE_KEY = 'SPreset_FTTMemoryTrace';
/** 持久化条数上限 */
export const TRACE_STORE_CAP = 120;

function ls() {
    try {
        const w = globalThis.window;
        return (w && w.localStorage) ? w.localStorage : null;
    } catch (e) { return null; }
}

/** 读取持久化尾部（归一；损坏 → 空数组） */
export function traceStoreLoad() {
    try {
        const s = ls();
        if (!s) return [];
        const raw = s.getItem(TRACE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter((x) => x && typeof x === 'object').map((x) => ({
            id: String(x.id || ''), at: Number(x.at) || 0, cat: String(x.cat || ''), kind: String(x.kind || ''),
            ok: x.ok !== false, opId: String(x.opId || ''), site: String(x.site || ''),
        })).slice(0, TRACE_STORE_CAP);
    } catch (e) { return []; }
}

/** 写入持久化尾部（失败静默） */
export function traceStoreSave(list) {
    try {
        const s = ls();
        if (!s) return false;
        s.setItem(TRACE_KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(0, TRACE_STORE_CAP)));
        return true;
    } catch (e) { return false; }
}

/** 接线（index.js 调用一次）：内核每次记录后写摘要尾部 */
export function wireTraceStore() {
    try {
        setTraceHooks({ save: (briefs) => traceStoreSave(briefs || []) });
        return true;
    } catch (e) { return false; }
}

/** 清空持久层（诊断用） */
export function traceStoreClear() { try { const s = ls(); if (s) s.removeItem(TRACE_KEY); return true; } catch (e) { return false; } }
