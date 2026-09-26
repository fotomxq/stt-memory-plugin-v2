// ============================================================
// ui/buffer-manage.js —— **本地缓冲管理**（v2.54.0，数据管理页的「本地缓冲」分节）
//
// 用户要求（v2.53.0 起）：「清理本地缓冲」应放在**数据管理**，并**展示缓冲统计**让用户决定是否清理。
// v2.54.0 修正（用户报告「快照/缓存管理错误，请核对内容的一致性；展示信息仅为统计信息」）：
//   ① 每一行的数字都必须来自**真实持久层现算**（localStorage 原始串的 UTF-8 字节数 + 实际条数），
//      不再用「内存里的追踪事件数」冒充「已持久化的简报条数」、也不再用错字段名（`count` vs `n`）导致恒为 0；
//   ② 只展示**统计**（条数 / 上限 / 占用字节 / 最近时间），不列具体日志或简报明细（明细在「调试」页看）；
//   ③ 三类缓冲各自给出**清理按钮**（版本清单缓存 / 调试日志 / 交互追踪简报）——都是本地缓存，清理不影响记忆数据。
// 数据来源（全部为既有模块，不新增存储）：
//   · 版本清单缓存 `fttAboutJson`（`ui/about.js#aboutCacheStats`）
//   · 调试日志   `SPreset_FTTMemoryDebug`（`adapters/debug-log.js`，上限 300）
//   · 追踪简报   `SPreset_FTTMemoryTrace`（`adapters/trace-store.js`，上限 120）
// ============================================================
import { ABOUT_CACHE_KEY, aboutCacheStats } from './about.js';
import { DEBUG_KEY, debugLogStats } from '../adapters/debug-log.js';
import { TRACE_KEY, TRACE_STORE_CAP, traceStoreLoad } from '../adapters/trace-store.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** localStorage 视图（与 about/trace-store 同款判断） */
function ls() {
    try {
        const w = globalThis.window;
        return (w && w.localStorage) ? w.localStorage : null;
    } catch (e) { return null; }
}

/** 真实 UTF-8 字节数（无 TextEncoder 时退化为字符数） */
export function byteLen(s) {
    try { if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(s == null ? '' : s)).length; } catch (e) { /* 退化 */ }
    return String(s == null ? '' : s).length;
}

/** 某键在持久层里的真实占用字节（键不存在或内容为空容器 → 0） */
export function rawBytes(key) {
    try {
        const s = ls();
        const raw = s ? s.getItem(String(key)) : null;
        if (!raw) return 0;
        const t = String(raw).trim();
        // 空容器不算占用（清空后持久层会留下 `[]` / `{}`）—— 显示「约 0 B」比「约 2 B」更符合事实
        if (t === '' || t === '[]' || t === '{}' || t === 'null') return 0;
        return byteLen(raw);
    } catch (e) { return 0; }
}

/** 人类可读大小 */
export function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/** 本地时间（空值 → ''；用于「最近一条」） */
function fmtTs(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    try { return new Date(n).toLocaleString(); } catch (e) { return String(n); }
}

/**
 * 本地缓冲统计（**单一来源**：所有数字现算，页面上别处不再各算一份）。
 * @returns {{versionList:{cached:boolean,versions:number,bytes:number},debugLog:{count:number,cap:number,bytes:number,newestAt:number},trace:{count:number,cap:number,bytes:number,newestAt:number},totalBytes:number,any:boolean}}
 */
export function bufferStats() {
    // ① 版本清单缓存（关于页的版本更新数据）
    const a = (() => { try { return aboutCacheStats(); } catch (e) { return { cached: false, versions: 0, bytes: 0 }; } })();
    const versionList = { cached: !!a.cached, versions: Number(a.versions) || 0, bytes: rawBytes(ABOUT_CACHE_KEY) };
    // ② 调试日志（内核环形缓冲 + 持久层；条数取真实持久层，内存与持久层不一致时以**持久层**为准并注明）
    const d = (() => { try { return debugLogStats() || {}; } catch (e) { return {}; } })();
    const debugLog = { count: Number(d.n) || 0, cap: Number(d.cap) || 0, bytes: rawBytes(DEBUG_KEY), newestAt: Number(d.newestAt) || 0 };
    // ③ 交互追踪简报（持久化尾部，上限 120；条数取持久层实际数组长度）
    const t = (() => { try { return traceStoreLoad(); } catch (e) { return []; } })();
    const trace = { count: t.length, cap: TRACE_STORE_CAP, bytes: rawBytes(TRACE_KEY), newestAt: Number((t[0] && t[0].at) || 0) };
    const totalBytes = versionList.bytes + debugLog.bytes + trace.bytes;
    return {
        versionList: versionList, debugLog: debugLog, trace: trace, totalBytes: totalBytes,
        any: versionList.cached || debugLog.count > 0 || trace.count > 0,
    };
}

/** 一行：名称 + 统计 + 清理按钮（无数据时按钮禁用，避免空操作） */
function rowHtml(label, stat, action, title, disabled) {
    return '<div class="ftt-muted">' + esc(label) + '：' + esc(stat)
        + ' <button class="ftt-btn ftt-sm" data-ftt-action="' + esc(action) + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>🧹 清除</button></div>';
}

/**
 * 「本地缓冲」分节 HTML（数据管理页用）：只给统计 + 清理入口。
 * 文案口径（用户要求）：一句话说明「这是什么 / 清理有什么后果」——「本地缓存，清理不影响记忆数据」。
 * @returns {string}
 */
export function bufferSectionHtml() {
    let st;
    try { st = bufferStats(); } catch (e) { st = { versionList: { cached: false, versions: 0, bytes: 0 }, debugLog: { count: 0, cap: 0, bytes: 0 }, trace: { count: 0, cap: 0, bytes: 0 }, totalBytes: 0, any: false }; }
    const v = st.versionList, d = st.debugLog, t = st.trace;
    const vStat = v.cached
        ? ('已缓存 ' + v.versions + ' 个版本 · 约 ' + fmtBytes(v.bytes))
        : '（无缓存）';
    const dStat = d.count + ' / ' + d.cap + ' 条 · 约 ' + fmtBytes(d.bytes) + (fmtTs(d.newestAt) ? (' · 最近 ' + fmtTs(d.newestAt)) : '');
    const tStat = t.count + ' / ' + t.cap + ' 条 · 约 ' + fmtBytes(t.bytes) + (fmtTs(t.newestAt) ? (' · 最近 ' + fmtTs(t.newestAt)) : '');
    return [
        '<h4 class="ftt-h4-inline">🗂 本地缓冲 <span class="ftt-muted">共约 ' + fmtBytes(st.totalBytes) + '</span></h4>',
        '<div class="ftt-hint">浏览器本地缓存与日志，用于「关于」页版本更新与排障；清理只删这些缓存，**不影响任何记忆数据**。</div>',
        rowHtml('版本清单缓存', vStat, 'aboutClearCache', '清除后下次打开「关于」页会重新从代码库获取', !v.cached),
        rowHtml('调试日志', dStat, 'dbgClear', '清空调试日志（记忆数据不受影响）', d.count === 0),
        rowHtml('交互追踪简报', tStat, 'dbgTraceClear', '清空交互/宿主调用简报（调试日志与记忆数据不受影响）', t.count === 0),
    ].join('\n');
}
