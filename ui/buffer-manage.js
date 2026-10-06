// ============================================================
// ui/buffer-manage.js —— **本地缓冲管理**（v2.54.0 起；v3.3.0 全面补充）
//
// 用户要求：
//   v2.53.0：「清理本地缓冲」应放在**数据管理**，并**展示缓冲统计**让用户决定是否清理。
//   v2.54.0：「快照/缓存管理错误，请核对内容的一致性；展示信息仅为统计信息」→ 数字一律**真实持久层现算**。
//   v3.3.0（本轮）：「设定-数据管理-本地缓冲，请补充其他为本地缓冲的内容，现在只有两个，明显缺失。
//     而且其他缓冲也应该展示，同样有对应清理按钮功能。」
//
// 于是本模块把**插件在浏览器本机留下的东西**全部列出来，每行给出统计 + 清理按钮（无数据时按钮禁用）：
//
//   ① 本机数据副本（**记忆数据的本机副本**，最容易被误当成"只有两个"而漏掉的一类）
//      · 状态副本（浏览器本地变量 / `localStorage`，键 `ftt2_state_<scope>`）
//      · 内存库副本（`IndexedDB` / `localforage`，同键）
//      · **其它角色的本机副本**（换过角色 / 用过多个存档留下的历史副本）
//   ② 缓存与日志：调试日志 · 交互追踪简报 · 读取台账 · 时钟取值追踪 · 向量缓存 · 版本清单缓存
//      · 命名缓存（文件名 / 归档名）· 同步与对账标记 · 同步日志
//   ③ V1 遗留本机数据（`SPreset_FTTMemory_*`：V1 导入源，清理后无法再迁移 —— 单独一行并明确警告）
//
// 口径：
//   · 数字来自真实持久层（`localStorage` 原始串字节 + 真实条数；IndexedDB 用 `JSON.stringify` 估字节）；
//   · 只展示**统计**，不列明细（明细在「调试」页）；
//   · 清理只删**本机**内容，服务端记忆文件与记忆数据本体不受影响（清掉后下次打开会从服务端重新载入）；
//   · 「清除本机副本」属危险动作（会二次确认），缓存类清理不弹确认。
// ============================================================
import { ABOUT_CACHE_KEY, aboutCacheStats } from './about.js';
import { DEBUG_KEY, debugLogStats } from '../adapters/debug-log.js';
import { TRACE_KEY, TRACE_STORE_CAP, traceStoreLoad } from '../adapters/trace-store.js';
import { readLedgerStats } from '../core/read-ledger.js';
import { clockTraceList } from '../core/clock-trace.js';
import { vectorCacheStats } from '../adapters/vector-cache.js';
import { syncLogList } from '../adapters/sync.js';
import { localKeyStats, localCopyStats, idbCopyStats, localLayerInfo } from '../adapters/store.js';   // v3.26.2：+localLayerInfo（状态副本的压缩留存与停滞标记）

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

/** 字符数缩写（本地缓冲按字符预算计，与 `storeStatus().localBuffer.budget` 同口径） */
function fmtChars(n) {
    const v = Number(n) || 0;
    if (v < 1000) return v + ' 字符';
    if (v < 1048576) return (v / 1024).toFixed(0) + 'K 字符';
    return (v / 1048576).toFixed(2) + 'M 字符';
}

/**
 * 本地缓冲统计（**单一来源**：所有数字现算，页面上别处不再各算一份）。
 *
 * v3.3.0 起覆盖「本机数据副本 + 缓存/日志 + V1 遗留」三类（`docs/history/P10c11`）。
 * @returns {object} 各分组统计（`copy` / `groups` / `totalBytes` / `any`）
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
    // ④ 读取台账（v3.0.23 起的内存环形，240 条上限）
    const ledger = (() => { try { const s = readLedgerStats(); return { count: Number(s.totalReads) || 0, cap: Number(s.cap) || 0, bytes: 0, newestAt: Number(s.lastAt) || 0 }; } catch (e) { return { count: 0, cap: 0, bytes: 0, newestAt: 0 }; } })();
    // ⑤ 时钟取值追踪（内存，每阶段保留 5 组）
    const clock = (() => {
        try {
            const stages = ['resolve', 'time-repair'];
            let n = 0;
            for (const s of stages) n += (clockTraceList(s) || []).length;
            return { count: n, cap: 0, bytes: 0, newestAt: 0 };
        } catch (e) { return { count: 0, cap: 0, bytes: 0, newestAt: 0 }; }
    })();
    // ⑥ 向量缓存（IndexedDB + 内存 LRU；统计与清空由 vector-cache 自己负责）
    const vec = (() => { try { const v = vectorCacheStats(); return { count: Number(v.memory) || 0, cap: Number(v.maxEntries) || 0, bytes: Number(v.bytes) || 0, evicted: Number(v.evicted) || 0, indexedDb: !!v.indexedDb }; } catch (e) { return { count: 0, cap: 0, bytes: 0, evicted: 0, indexedDb: false }; } })();
    // ⑦ 同步日志（localStorage，上限 30 条）
    const syncLog = (() => { try { return { count: (syncLogList() || []).length, cap: 0, bytes: 0, newestAt: 0 }; } catch (e) { return { count: 0, cap: 0, bytes: 0, newestAt: 0 }; } })();
    // ⑧ 本机键分组（状态副本 / 命名缓存 / 对账标记 / 同步日志 / V1 遗留）
    const ks = (() => { try { return localKeyStats(); } catch (e) { return null; } })();
    const g = (name) => (ks && ks[name]) || { count: 0, bytes: 0, chars: 0, keys: [] };
    const copyLocal = g('state').current || { count: 0, bytes: 0, chars: 0, keys: [] };
    const copyOthers = g('state').others || { count: 0, bytes: 0, chars: 0, keys: [] };
    const names = g('names');
    const marks = g('syncMarks');
    const v1 = g('v1Legacy');
    const groups = {
        versionList: versionList,
        debugLog: debugLog,
        trace: trace,
        ledger: ledger,
        clock: clock,
        vector: vec,
        syncLog: { count: syncLog.count, cap: syncLog.cap, bytes: g('syncLog').bytes, newestAt: 0 },
        names: { count: names.count, bytes: names.bytes },
        marks: { count: marks.count, bytes: marks.bytes },
        v1Legacy: { count: v1.count, bytes: v1.bytes },
    };
    const totalBytes = versionList.bytes + debugLog.bytes + trace.bytes + vec.bytes
        + groups.syncLog.bytes + names.bytes + marks.bytes + v1.bytes + copyLocal.bytes + copyOthers.bytes;
    // v3.26.2：状态副本的**留存形态**与「是否已停更」（`localLayerInfo` 同步可算 → 首屏就能如实显示）
    let copyExtra = { gz: false, stale: null, overBudget: false, budget: 0, plainChars: 0 };
    try {
        const info = localLayerInfo();
        copyExtra = { gz: !!info.gz, stale: info.stale || null, overBudget: !!info.overBudget, budget: Number(info.budget || 0), plainChars: Number(info.plainChars || 0) };
    } catch (e) { /* 忽略 */ }
    return {
        // 兼容既有调用点（v2.54.0 的字段名保持不变）
        versionList: versionList, debugLog: debugLog, trace: trace,
        copy: { local: Object.assign({}, copyLocal, copyExtra), others: copyOthers, scope: (ks ? '' : '') },
        groups: groups,
        totalBytes: totalBytes,
        any: !!(versionList.cached || debugLog.count || trace.count || ledger.count || clock.count
            || vec.count || groups.syncLog.count || names.count || marks.count || v1.count || copyLocal.count || copyOthers.count),
    };
}

/** 行：名称 + 统计 + 清理按钮（无数据时按钮禁用，避免空操作） */
function rowHtml(label, stat, action, title, disabled, extraClass) {
    return '<div class="ftt-muted">' + esc(label) + '：' + esc(stat)
        + ' <button class="ftt-btn ftt-sm' + (extraClass ? (' ' + extraClass) : '') + '" data-ftt-action="' + esc(action) + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>🧹 清除</button></div>';
}

/**
 * 「本地缓冲」分节 HTML（数据管理页用）：只给统计 + 清理入口。
 * 文案口径（用户要求）：一句话说明「这是什么 / 清理有什么后果」——「本地缓存，清理不影响记忆数据」。
 * @param {object} [copy] 兼容旧签名的可选项（v3.3.0 起统计一律现算；传入会被忽略）
 * @returns {string}
 */
export function bufferSectionHtml(copy) {
    void copy;
    let st;
    try { st = bufferStats(); } catch (e) { st = bufferStatsFallback(); }
    const v = st.versionList, d = st.debugLog, t = st.trace, G = st.groups || {};
    const c = copy || null;
    const vStat = v.cached ? ('已缓存 ' + v.versions + ' 个版本 · 约 ' + fmtBytes(v.bytes)) : '（无缓存）';
    const dStat = d.count + ' / ' + d.cap + ' 条 · 约 ' + fmtBytes(d.bytes) + (fmtTs(d.newestAt) ? (' · 最近 ' + fmtTs(d.newestAt)) : '');
    const tStat = t.count + ' / ' + t.cap + ' 条 · 约 ' + fmtBytes(t.bytes) + (fmtTs(t.newestAt) ? (' · 最近 ' + fmtTs(t.newestAt)) : '');
    const rows = [];
    // ── ① 本机数据副本（记忆数据的本机副本；最容易被漏掉的一类）──
    rows.push('<h5 class="ftt-h4-inline">🧱 本机数据副本 <span class="ftt-muted">记忆数据在本机的副本</span></h5>');
    rows.push('<div class="ftt-hint">清掉后<b>下次打开会从服务端记忆文件重新载入</b>；服务端那份不受影响（若从没成功上传过，清掉本机副本等于丢弃未上传的改动 —— 建议先「⬇ 导出 JSON 文件」）。</div>');
    // v3.26.5（用户报告「保存到本地文件后，是否没有正常读取和写入？」）：**目录模式必须在这里显示目录层** ——
    //   旧版只列「浏览器本地变量 / 内存库」，而这两层在目录模式下按设计是空的 → 整页看起来「本机什么都没有」，
    //   用户据此判断「没写进去」。现在目录层单独一行（真实键名 + 两通道路径 + 最近读回/写入 + 读写计数 + 失败原因）。
    {
        let info = null;
        try { info = localLayerInfo(); } catch (e) { info = null; }
        if (info && info.enabled) {
            const when = (t) => (Number(t) > 0 ? fmtTs(Number(t)) : '—');
            rows.push('<div class="ftt-muted" data-ftt-dir-copy><b>状态副本（本地目录）</b>：'
                + esc(String(info.path || '')) + ' · 最近写入 ' + esc(fmtChars(Number(info.fileBytes || 0)))
                + '（' + esc(when(info.fileLastWriteAt)) + '） · 读 ' + Number(info.reads || 0) + ' / 写 ' + Number(info.writes || 0)
                + ' / 未命中 ' + Number(info.misses || 0)
                + (Number(info.failures) ? (' · <span class="ftt-err">失败 ' + Number(info.failures) + '：' + esc(String(info.lastReason || '')) + '</span>') : '')
                + '<br><span class="ftt-muted">真实文件：' + esc(String(info.fileKey || '')) + '（blobs/local/ 大信封 · kv/local/ 小信封）'
                + (info.fileLastReadAt ? (' · 最近读回 ' + esc(when(info.fileLastReadAt))) : ' · 本次会话尚未读回')
                + '</span></div>');
            rows.push('<div class="ftt-hint">目录模式下<b>浏览器本地变量、内存库、聊天元数据都不读不写</b>（只读只写目录 + 服务端）；下面两行按设计恒为空，不是故障。</div>');
        }
    }
    {
        // 状态副本（localStorage）：**同步**可算（真实键值现算）→ 首屏就显示真值
        const lo = (st.copy && st.copy.local) || { count: 0, bytes: 0, chars: 0, keys: [] };
        const loStat = Number(lo.count || 0) > 0
            ? (fmtChars(lo.chars) + ' · 约 ' + fmtBytes(lo.bytes) + (lo.gz ? ' · 压缩留存' : ''))
            : '（无本机副本）';
        const dirOn = (() => { try { return !!localLayerInfo().enabled; } catch (e) { return false; } })();
        rows.push(rowHtml('状态副本（浏览器本地变量）' + (dirOn ? ' · 已停用（目录模式不读不写）' : ''), loStat, 'localCopyClear', '清除当前角色在本机浏览器里的状态副本（服务端记忆文件不动；下次打开会重新载入）', !(Number(lo.count) > 0), 'ftt-err'));
        // v3.26.2：本机层「停滞」如实告知（上次写入被跳过 → 这份副本不是最新的）
        {
            const stale = st.copy && st.copy.stale;
            if (stale && Number(stale.at) > 0) {
                const when = (() => { try { return new Date(Number(stale.at)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(stale.at); } })();
                rows.push('<div class="ftt-hint ftt-warn-box">⚠️ <b>本机状态副本自 ' + esc(when) + ' 起未更新</b>：'
                    + '上次写入被跳过（' + esc(Number(stale.chars || 0).toLocaleString()) + ' &gt; ' + esc(Number(stale.budget || 0).toLocaleString()) + ' 字符配额）。'
                    + '可到「设定 → 存储」设置<b>本机缓冲目录</b>：该模式下本机缓冲写本地目录，不受浏览器配额限制。</div>');
            }
        }
        // 内存库副本（IndexedDB）：异步统计 → 先占位，取到后就地更新
        const cachedIdb = copyCache && copyCache.idb ? copyCache.idb : null;
        const idbStat = cachedIdb
            ? (!cachedIdb.available ? '（宿主未提供 IndexedDB）' : (cachedIdb.present ? ('约 ' + fmtBytes(cachedIdb.bytes)) : '（无副本）'))
            : '（读取中…）';
        rows.push('<div class="ftt-muted">内存库副本（IndexedDB）：<span data-ftt-idb-copy>' + esc(idbStat) + '</span>'
            + ' <button class="ftt-btn ftt-sm ftt-err" data-ftt-action="idbCopyClear" title="清除当前角色在 IndexedDB 里的状态副本（服务端记忆文件不动）">🧹 清除</button></div>');
        // 其它角色的本机副本（同步可算）
        const others = (st.copy && st.copy.others) || { count: 0, bytes: 0 };
        if (Number(others.count || 0) > 0) {
            rows.push('<div class="ftt-muted">其它角色的本机副本：<span data-ftt-copy-others>' + esc(Number(others.count) + ' 个键 · 约 ' + fmtBytes(others.bytes)) + '</span>'
                + ' <button class="ftt-btn ftt-sm ftt-err" data-ftt-action="localCopyClearOthers" title="清除其它角色留在本机的状态副本（当前角色的不动；每个角色清掉后，下次切到它时会从服务端重新载入）">🧹 全部清除</button></div>');
        }
    }
    // ── ② 缓存与日志 ──
    rows.push('<h5 class="ftt-h4-inline ftt-mt-2">🧰 缓存与日志 <span class="ftt-muted">排障与加速用的本机缓存</span></h5>');
    rows.push('<div class="ftt-hint">都是可再生成的缓存（日志 / 台账 / 追踪 / 向量 / 版本清单 / 命名与对账标记）；清理<b>不影响记忆数据</b>。</div>');
    rows.push(rowHtml('调试日志', dStat, 'dbgClear', '清空调试日志（记忆数据不受影响）', d.count === 0));
    rows.push(rowHtml('交互追踪简报', tStat, 'dbgTraceClear', '清空交互/宿主调用简报（调试日志与记忆数据不受影响）', t.count === 0));
    const lg = G.ledger || { count: 0, cap: 0 };
    rows.push(rowHtml('读取台账', lg.count + (lg.cap ? (' / ' + lg.cap) : '') + ' 次读取 · 内存（不落盘）', 'readLedgerClear', '清空读取台账（每次服务端/本地/内存读取的统计；内存环形，不影响数据）', !lg.count));
    const ck = G.clock || { count: 0 };
    rows.push(rowHtml('时钟取值追踪', ck.count + ' 组 · 内存（不落盘）', 'clockTraceClear', '清空时钟取值追踪（只清内存缓冲，不影响时钟数据与记忆）', !ck.count));
    const vc = G.vector || { count: 0, cap: 0, bytes: 0, indexedDb: false };
    rows.push(rowHtml('向量缓存', vc.count + (vc.cap ? (' / ' + vc.cap) : '') + ' 条 · 约 ' + fmtBytes(vc.bytes) + (vc.indexedDb ? ' · IndexedDB 可用' : ' · 仅内存'), 'vectorCacheClear', '清空向量缓存（下次提取记忆会重新嵌入；不影响记忆数据）', !(vc.count || vc.indexedDb)));
    rows.push(rowHtml('版本清单缓存', vStat, 'aboutClearCache', '清除后下次打开「关于」页会重新从代码库获取', !v.cached));
    const nm = G.names || { count: 0, bytes: 0 };
    rows.push(rowHtml('命名缓存（文件名 / 归档名）', nm.count + ' 个键 · 约 ' + fmtBytes(nm.bytes), 'nameCacheClear', '清除文件名与归档名解析缓存（下次会自动重新解析；不影响服务端文件）', !nm.count));
    const mk = G.marks || { count: 0, bytes: 0 };
    rows.push(rowHtml('同步与对账标记', mk.count + ' 个键 · 约 ' + fmtBytes(mk.bytes), 'syncMarkClear', '清除对账门控标记（远端哈希 / 快照签名 / 上次推送签名 / 同步门控）；下次同步会重新判定，不影响记忆', !mk.count));
    const sl = G.syncLog || { count: 0, bytes: 0 };
    rows.push(rowHtml('同步日志（本机）', sl.count + ' 条 · 约 ' + fmtBytes(sl.bytes), 'syncLogClear', '清空本机与服务端的同步日志（不影响记忆数据）', !sl.count));
    // ── ③ V1 遗留（导入源，单独警示）──
    const v1 = G.v1Legacy || { count: 0, bytes: 0 };
    if (Number(v1.count || 0) > 0) {
        rows.push('<h5 class="ftt-h4-inline ftt-mt-2">🧬 V1 遗留本机数据</h5>');
        rows.push('<div class="ftt-hint">V1 插件留在本机的数据（旧版存档 / 旧版命名缓存 / 旧版设置）——「⬆ 导入 V1」靠它迁移；<b>清掉后无法再用它迁移</b>，确认已在 V2 里不需要时再清。</div>');
        rows.push(rowHtml('V1 遗留数据（导入源）', v1.count + ' 个键 · 约 ' + fmtBytes(v1.bytes), 'v1LegacyClear', '清除 V1 遗留的本机数据（清理后「导入 V1」将无法再从本机迁移）', false, 'ftt-err'));
    }
    const idbBytes = (copyCache && copyCache.idb && copyCache.idb.present) ? Number(copyCache.idb.bytes || 0) : 0;
    return [
        '<h4 class="ftt-h4-inline">🗂 本地缓冲 <span class="ftt-muted">共约 ' + fmtBytes(st.totalBytes + idbBytes) + '</span>'
        + (idbBytes ? '' : ' <span class="ftt-muted" data-ftt-copy-total></span>') + '</h4>',
        '<div class="ftt-hint">插件在<b>本机（浏览器）</b>留下的副本与缓存；清理只删本机内容，<b>不影响服务端记忆文件</b>。</div>',
    ].concat(rows).join('\n');
}

// ============================================================
// v3.3.0：IndexedDB 副本统计是**异步**的，而设定页渲染是同步的 —— 于是：
//   · 模块级缓存 `copyCache` 保存最近一次取到的副本统计；
//   · 页面渲染出 `[data-ftt-idb-copy]` / `[data-ftt-copy-local]` 占位；
//   · `refreshLocalCopy()` 取到后**就地更新这些占位文本**（无 DOM / 取不到节点时只更新缓存，
//     下次渲染即显示真值）。不引入面板重绘、不产生循环依赖。
// ============================================================
let copyCache = null;
/** 最近一次取到的本机副本统计（无 → null） */
export function localCopyCache() { return copyCache ? JSON.parse(JSON.stringify(copyCache)) : null; }

/** 更新页面上的副本占位（无 DOM / 无节点 → 静默） */
function paintCopySpans() {
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== 'function' || !copyCache) return false;
        const lo = copyCache.local || {}, idb = copyCache.idb || {}, others = copyCache.others || {};
        const set = (sel, text) => { const el = doc.querySelector(sel); if (el) { try { el.textContent = text; } catch (e) { /* 忽略 */ } } };
        set('[data-ftt-copy-local]', lo.present
            ? (fmtChars(lo.chars) + ' / ' + fmtChars(copyCache.budget) + '（预算）· 约 ' + fmtBytes(lo.bytes) + ' · ' + Number(lo.items || 0) + ' 条' + (fmtTs(lo.updatedAt) ? (' · 更新 ' + fmtTs(lo.updatedAt)) : ''))
            : '（无本机副本）');
        set('[data-ftt-idb-copy]', !idb.available ? '（宿主未提供 IndexedDB）' : (idb.present ? ('约 ' + fmtBytes(idb.bytes)) : '（无副本）'));
        if (Number(others.count || 0) > 0) set('[data-ftt-copy-others]', Number(others.count) + ' 个键 · 约 ' + fmtBytes(others.bytes));
        const totalSel = doc.querySelector('[data-ftt-copy-total]');
        if (totalSel) { try { totalSel.textContent = '其中本机数据副本约 ' + fmtBytes(Number(lo.bytes || 0) + Number(idb.bytes || 0) + Number(others.bytes || 0)); } catch (e) { /* 忽略 */ } }
        return true;
    } catch (e) { return false; }
}

/**
 * 刷新本机副本统计（异步）：取一次真实数据 → 更新模块缓存 + 就地更新页面占位。
 * 调用时机：设定 → 数据管理 页渲染后（`ui/settings-pages.js` 触发，fire-and-forget）。
 */
export async function refreshLocalCopy() {
    try {
        copyCache = await localCopyStats();
    } catch (e) { copyCache = null; }
    paintCopySpans();
    return localCopyCache();
}

/** 兜底空统计（`bufferStats()` 抛错时使用；字段与正常返回一致） */
function bufferStatsFallback() {
    const z = { count: 0, cap: 0, bytes: 0, newestAt: 0 };
    return {
        versionList: { cached: false, versions: 0, bytes: 0 }, debugLog: Object.assign({}, z), trace: Object.assign({}, z),
        copy: { local: { count: 0, bytes: 0, chars: 0 }, others: { count: 0, bytes: 0, chars: 0 } },
        groups: { ledger: Object.assign({}, z), clock: Object.assign({}, z), vector: Object.assign({}, z), syncLog: Object.assign({}, z), names: Object.assign({}, z), marks: Object.assign({}, z), v1Legacy: Object.assign({}, z) },
        totalBytes: 0, any: false,
    };
}

/** 数据管理页用：本机数据副本统计（异步；页面渲染时若已取到则一并展示） */
export async function localCopyInfo() {
    try { return await localCopyStats(); } catch (e) { return null; }
}

/** 数据管理页用：IndexedDB 副本统计（单独一行展示时用） */
export async function idbCopyInfo() {
    try { return await idbCopyStats(); } catch (e) { return null; }
}
