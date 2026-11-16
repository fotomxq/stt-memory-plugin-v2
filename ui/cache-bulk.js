// ============================================================
// ui/cache-bulk.js —— **「缓存与日志」聚合清理**（v3.52.13）
//
// 用户要求（原话）：「缓存与日志改为清理，总大小、条数、剩余大小和条数。不要零碎记录和分开，
//   内部方法不变，只是打包聚合为一个按钮清理。」
//
// 分工：
//   · 本模块 = **聚合统计 + 一键清理编排**（`cacheBulkStats` / `cacheBulkClear`）；
//   · 内部清理方法**完全不变**（调试日志 / 时间线 / 读取台账 / 时钟追踪 / 向量 / 版本清单 / 命名缓存 / 对账标记 / 同步日志），
//     逐个调用既有入口；只是**不再在界面上散落成 9 个按钮**。
//   · 界面侧 `ui/buffer-manage.js` 只渲染「合计 + 一个按钮 + 明细折叠（无按钮）」。
// ============================================================
import { debugLogStats } from '../adapters/debug-log.js';
import { traceStoreLoad, TRACE_STORE_CAP } from '../adapters/trace-store.js';
import { readLedgerStats } from '../core/read-ledger.js';
import { clockTraceList } from '../core/clock-trace.js';
import { vectorCacheStats } from '../adapters/vector-cache.js';
import { aboutCacheStats } from './about.js';
import { syncLogList } from '../adapters/sync.js';
import { localKeyStats } from '../adapters/store.js';

/** 粗估内存对象字节（UTF-8；无 TextEncoder 退化为字符数）—— 用于「读取台账 / 时钟追踪」这类不落盘的条目 */
function jsonBytes(v) {
    try {
        const s = JSON.stringify(v == null ? null : v);
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
        return s.length;
    } catch (e) { return 0; }
}

/** 单项统计（`count` 条数 / `bytes` 占用）—— **条数为 0 时占用记 0**（否则空缓冲的估算字节会让「已清理」永不成立） */
function item(label, count, bytes) {
    const n = Math.max(0, Number(count) || 0);
    return { label: String(label), count: n, bytes: n > 0 ? Math.max(0, Number(bytes) || 0) : 0 };
}

/**
 * 聚合统计（只读；界面与清理后的「剩余」共用同一口径）。
 * @returns {{items:Array<{label:string,count:number,bytes:number}>, count:number, bytes:number}}
 */
export function cacheBulkStats() {
    const items = [];
    const add = (it) => { if (it && (it.count > 0 || it.bytes > 0)) items.push(it); else items.push(it); };
    try {
        const d = (() => { try { return debugLogStats() || {}; } catch (e) { return {}; } })();
        add(item('调试日志', d.count, d.bytes));
        const tr = (() => { try { return traceStoreLoad() || []; } catch (e) { return []; } })();
        add(item('交互追踪简报', Math.min(tr.length, TRACE_STORE_CAP), jsonBytes(tr)));
        const lg = (() => { try { return readLedgerStats() || {}; } catch (e) { return {}; } })();
        add(item('读取台账', lg.count, jsonBytes(lg)));
        const ck = (() => { try { return clockTraceList() || []; } catch (e) { return []; } })();
        add(item('时钟取值追踪', ck.length, jsonBytes(ck)));
        const vc = (() => { try { return vectorCacheStats() || {}; } catch (e) { return {}; } })();
        add(item('向量缓存', vc.count, vc.bytes));
        const ab = (() => { try { return aboutCacheStats() || {}; } catch (e) { return {}; } })();
        add(item('版本清单缓存', ab.cached ? ab.versions : 0, ab.bytes));
        const ks = (() => { try { return localKeyStats() || {}; } catch (e) { return {}; } })();
        add(item('命名缓存', (ks.names || {}).count, (ks.names || {}).bytes));
        add(item('同步与对账标记', (ks.syncMarks || {}).count, (ks.syncMarks || {}).bytes));
        const sl = (() => { try { return syncLogList() || []; } catch (e) { return []; } })();
        add(item('同步日志（本机）', sl.length, jsonBytes(sl)));
    } catch (e) { /* 统计失败 → 返回已收集到的部分（绝不因统计中断页面） */ }
    const count = items.reduce((n, x) => n + x.count, 0);
    const bytes = items.reduce((n, x) => n + x.bytes, 0);
    return { items: items, count: count, bytes: bytes };
}

/** 人读字节（与数据管理页 `fmtBytes` 同口径的极简实现；避免跨模块循环依赖） */
export function bulkFmtBytes(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
    return v + ' B';
}

/** 合计一行文案：条数 · 大小 */
export function cacheBulkText(st) {
    const s = st || cacheBulkStats();
    return Number(s.count) + ' 项 · 约 ' + bulkFmtBytes(s.bytes);
}

/**
 * **一键清理**（内部方法不变；逐个调用既有入口）。
 *   失败单项不中断其余（与「九步独立 try/catch」同一纪律），返回逐项结果。
 * @param {{debugAction?:Function, hooks?:object}} deps
 * @returns {Promise<{ok:boolean, before:object, after:object, results:Array, note:string}>}
 */
export async function cacheBulkClear(deps) {
    const d = deps || {};
    const hooks = d.hooks || {};
    const before = cacheBulkStats();
    const results = [];
    const run = async (label, fn) => {
        try { const r = await fn(); results.push({ label: label, ok: (r && r.ok === false) ? false : true, reason: (r && r.reason) || '' }); }
        catch (e) { results.push({ label: label, ok: false, reason: String((e && e.message) || e) }); }
    };
    const dbg = (typeof d.debugAction === 'function') ? d.debugAction : null;
    // ① 调试日志 / ② 交互追踪简报 / ③ 读取台账 / ④ 时钟取值追踪（既有调试动作，无 AI、无记忆数据写入）
    if (dbg) {
        await run('调试日志', () => dbg('dbgClear', {}));
        await run('交互追踪简报', () => dbg('dbgTraceClear', {}));
        await run('读取台账', () => dbg('readLedgerClear', {}));
        await run('时钟取值追踪', () => dbg('clockTraceClear', {}));
    }
    // ⑤ 向量缓存 / ⑥ 版本清单缓存 / ⑦ 命名缓存 / ⑧ 同步与对账标记 / ⑨ 同步日志（沿用既有宿主钩子）
    const hook = (name, label) => {
        const fn = hooks[name];
        if (typeof fn !== 'function') { results.push({ label: label, ok: false, reason: 'no-hook' }); return; }
        return run(label, () => fn({}));
    };
    await hook('vectorCacheClear', '向量缓存');
    await hook('aboutClearCache', '版本清单缓存');
    await hook('nameCacheClear', '命名缓存');
    await hook('syncMarkClear', '同步与对账标记');
    await hook('syncLogClear', '同步日志（本机）');
    const after = cacheBulkStats();
    const failed = results.filter((x) => x.ok !== true);
    const note = '已清理缓存与日志：' + cacheBulkText(before) + ' → 剩余 ' + cacheBulkText(after)
        + (failed.length ? ('（失败 ' + failed.length + ' 项：' + failed.map((x) => x.label).join('/') + '）') : '');
    return { ok: failed.length === 0, before: before, after: after, results: results, note: note };
}
