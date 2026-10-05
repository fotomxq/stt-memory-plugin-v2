// ============================================================
// ui/debug.js —— **调试页（日志查看器 + 清空）**（B9-a）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`）：
//   · 内核日志：`DBG_KEY/DEBUG_CAP/dbgLog/dbgGet/dbgClear/dbgPersist`（约 545~613，v1.49 口径）
//   · 查看器：`debugHtml()`（约 24657~24712，类别标签/配色 + 摘要 + 逐条 `<details>`）
//   · 设定页：`activeSettingsSub === 'debug'` 分支（约 25946~25954：开关 + 说明 + 日志区）
//   · 动作：`case 'dbgClear'`（约 27245：`dbgClear(); renderPanel(); toast('已清空调试日志','info')`）
//
// V2 适配（逐条）：
//   ① 内核数据源：V1 直读全局 `debugLogs`（`dbgGet()`）；V2 读 `adapters/debug-log.js#debugLogList`
//      （内核环形缓冲 `core/debug-log.js` + localStorage 接线），UI 不碰持久层；
//   ② `formatBytes` V1 是模块内私有函数（未导出），此处**按 V1 逐字复制**（与 `ui/sync.js#fmtBytes` 同实现）；
//   ③ V1 的 `toast(...)` 在 V2 统一写面板 note（读 `r.state.note`）；`renderPanel()` 由 `ui/panel.js` 收尾统一重绘；
//   ④ V1 把「最多 300 条」硬编码在文案里；V2 用内核常量 `DEBUG_CAP`（值同为 300）。
// ============================================================
import { escHtml, hashText } from '../core/util.js';
// v2.37.0「时钟取值追踪」：把「值从哪来 / 为什么取它 / 还有什么没被采用」渲染成只读区块
import { clockTraceInfo, clockTraceSummary, clockTraceLast, clockTraceClear } from '../core/clock-trace.js';
import { VERSION, DIMENSIONS } from '../core/constants.js';
// v2.42.0：交互/宿主调用/命令/错误时间线（opId 关联、站点 file:line、错误上下文窗口）
import { traceList, traceStats, traceTimelineText, traceContext, traceClear, traceSiteText, TRACE_CATS } from '../core/trace.js';
import { getCtx } from '../host/st-api.js';
import { DEBUG_CAP, debugLogStats, debugLogErrors, debugLogErrorCount, debugLogLastError } from '../core/debug-log.js';
import { debugLogList, debugLogClear } from '../adapters/debug-log.js';
// v3.13.0：**数据体检**（只读）—— 调试桥 `ftt.dataHealth` / 面板与 `/ftt` 共用同一份报告
import { dataHealthReport, dataHealthText } from '../core/data-health.js';
// v2.77.0：文件通道（宿主原生存储 / 酒馆用户目录文件）现状 —— 排障时先看这一项
import { fileTransportStatus } from '../adapters/file-transport.js';
import { settingsControlHtml } from './settings-pages.js';
// v3.0.7：长说明统一进折叠块（页面可见提示 ≤90 字，由 ui-wording 门禁约束）
import { hintDetailsHtml } from './hints.js';
// v2.82.0（用户报告「日志的导出功能有问题，无法正常导出 log 文件」）：导出必须**真的落文件** ——
//   复用「⬇ 导出记忆 JSON」同一条下载实现（Blob + `<a download>`），而不是只塞剪贴板/文本框。
import { downloadTextFile } from './file-io.js';
// v2.94.0（`docs/D11` v0.3 §3.2 阶段 S1 / `docs/D12` v0.2 S4b）：`chatMetadata` 主载体**只读**差异报告
import { state } from '../core/model/runtime.js';
import { chatMetaDiffReport, chatMetaDiffText, CHAT_META_KEY } from '../adapters/chat-meta.js';
// v3.0.7：本地调试桥（**跨宿主**：酒馆原生与 TauriTavern 都能用；非 TauriTavern 只降级不报错）
import {
    bridgeStart, bridgeStop, bridgeState, bridgeSupported, bridgeHost, bridgeMethodNames,
    setBridgeMethods, setBridgePort, bridgePort, setBridgeHost, bridgeTarget, isLoopbackHost,
    BRIDGE_DEFAULT_PORT, BRIDGE_DEFAULT_HOST, BRIDGE_PROTOCOL,
} from '../adapters/debug-bridge.js';
import { ttAbi, ttWriteStats } from '../adapters/tt-store.js';
// v3.0.9：台账 / 未摘要清单的**只读诊断**（回答「为什么这楼被判为未摘要」）
import {
    processedStats, scanPendingFloors, listUnprocessedFloors, floorMessage, floorStableText,
    hashFloorText, floorAnalyzableText, chatReadyForFloors, processedVerTag, liveFloorTail,
} from '../host/floors.js';
import { floorCoverage } from '../core/floor-cover.js';
// v3.20.0：情节「聊天归属 / 位置越界」体检（只读；回答「时钟为什么取了别条聊天的时间」）
import { currentChatKey, currentChatTail, plotScopeSnapshot } from '../core/chat-scope.js';
// v3.0.10：载入链路诊断（内存 / 本机缓冲 / 服务端文件 / 调试日志 四处并排对比）
import { scopeId } from '../core/state.js';
import { stateFileName } from '../adapters/user-file.js';
import { fileTransportReadAuto } from '../adapters/file-transport.js';
import { storageHash } from '../core/envelope.js';
// v3.0.23（用户要求「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志」）：读取台账区块
import { readLedgerStats, readLedgerLines, readLedgerSummaryText, resetReadLedger, READ_SRC_LABEL } from '../core/read-ledger.js';

const esc = (v) => escHtml(v == null ? '' : v);
/** v2.42.0：时间线类别中文名 */
const DEBUG_CAT_LABEL = { ui: '🖱 交互', host: '🔌 宿主', cmd: '⌨️ 命令', kernel: '🧩 内核', ai: '🤖 AI', error: '❌ 异常' };

/** V1 `formatBytes()`（约 325，逐字复制：B / KB / MB 三档） */
function formatBytes(n) {
    try {
        const b = Number(n) || 0;
        if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
        if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
        return `${b} B`;
    } catch (e) { return '0 B'; }
}

/** V1 `debugHtml()` 内的类别标签映射（逐字） */
export const DEBUG_KIND_LABEL = Object.freeze({
    '摘要': '🧠 分析记忆', '发送记忆': '📤 提取记忆', '关键词': '🔑 关键词提取', '向量': '🔗 向量检索',
    '请求': '🌐 API 请求', '修复': '🛠 质检修复', '投喂': '📥 投喂文本', '对账': '🔄 存储对账',
});
/** V1 `debugHtml()` 内的类别配色（逐字） */
export const DEBUG_KIND_COLOR = Object.freeze({
    '关键词': '#7db0e8', '向量': '#8ad08a', '发送记忆': '#e0b06a', '请求': '#c98ad0',
    '摘要': '#f0c060', '修复': '#f0c060', '投喂': '#8aa7c8', '对账': '#8ad08a',
});

/** V1 `debugHtml()` 内的单条摘要（逐字：从 `data` JSON 里挑关键字段拼一行） */
function debugSummary(l) {
    try {
        const d = JSON.parse(l.data);
        if (typeof d === 'object' && d !== null) {
            const parts = [];
            if (d.label) parts.push(d.label);
            if (d.stage) parts.push(d.stage);
            if (d.action) parts.push(d.action);
            if (d.source) parts.push(d.source);
            if (d.error !== undefined) parts.push(`❌${String(d.error).slice(0, 40)}`);
            if (d.status !== undefined) parts.push(`HTTP${d.status}`);
            if (d.chars !== undefined) parts.push(`${d.chars}字`);
            if (d.count !== undefined) parts.push(`×${d.count}`);
            if (d.floors !== undefined) parts.push(`${d.floors}楼`);
            if (d.topN !== undefined) parts.push(`Top${d.topN}`);
            if (d.ms !== undefined) parts.push(`${d.ms}ms`);
            if (parts.length) return parts.join(' · ');
        }
    } catch (e) { /* 非 JSON 文本 → 无摘要（V1 原样） */ }
    return '';
}

/**
 * 日志列表 HTML（V1 `debugHtml()` 逐字结构：操作行 + 类别统计行 + 逐条 `<details class="ftt-dbg-item">`）
 * @returns {string}
 */
/** v2.41.0：调试日志导出（用户要求「调试日志应该支持导出，方便检查」）—— 最近一次导出的文本（渲染用） */
let lastDebugExport = '';
/** v2.82.0：最近一次「导出日志（.log）」的文本（渲染用；与调试包分开存放，文本框显示最近一次） */
let lastDebugLogExport = '';
/** v2.82.0：最近一次导出落文件的结果（诊断/测试） */
let lastExportFile = null;
/** v2.42.0：时间线类别过滤（'' = 全部） */
let traceFilter = '';
/** 宿主注入的额外诊断（`dump`：一键诊断快照；`meta`：环境信息）；默认 no-op */
const debugHooks = { dump: () => null, meta: () => ({}) };
export function setDebugHooks(next) { Object.assign(debugHooks, next || {}); return debugHooks; }
/** 最近一次导出的调试包（诊断/测试） */
export function debugExportState() { return { chars: lastDebugExport.length, text: lastDebugExport }; }
/** 最近一次「导出日志（.log）」与落文件结果（诊断/测试） */
export function debugExportFileState() { return { file: lastExportFile, logChars: lastDebugLogExport.length }; }

/** 导出文件名里的时间戳（本地时间，便于人工辨认；不用 ISO 以避免文件名里的冒号） */
function exportStamp() {
    try {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    } catch (e) { return 'export'; }
}
/** 作用域（角色名）→ 文件名安全片段（非法字符换下划线、截断 24 字） */
function scopeSlug() {
    try {
        const raw = String((getCtx() && getCtx().chatId) || '').trim();
        const s = raw.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
        return s || 'chat';
    } catch (e) { return 'chat'; }
}

/**
 * 把导出文本**落成文件**（v2.82.0 修复点）。
 * @returns {{ok:boolean, filename:string, reason:string, chars:number}}
 */
function saveExportFile(kind, text) {
    const stamp = exportStamp();
    const filename = (kind === 'log' ? 'FTT调试日志_' : 'FTT调试包_') + scopeSlug() + '_' + stamp + (kind === 'log' ? '.log' : '.json');
    const mime = (kind === 'log') ? 'text/plain' : 'application/json';
    let r = { ok: false, reason: 'error', filename: filename, chars: String(text || '').length };
    try { r = Object.assign(r, downloadTextFile(filename, text, mime) || {}); } catch (e) { r.reason = 'error:' + String((e && e.message) || e); }
    lastExportFile = { kind: kind, ok: !!r.ok, filename: String(r.filename || filename), reason: String(r.reason || ''), chars: Number(r.chars) || 0, at: Date.now() };
    return lastExportFile;
}

/** 日志的**人读文本**（导出 .log 用）：头信息 + 每条一行（时间 · 类别 · 内容） */
export function buildDebugLogText() {
    let logs = [];
    try { logs = debugLogList(); } catch (e) { logs = []; }
    const head = [
        'FTT记忆组件 V2 · 调试日志',
        '版本：' + VERSION,
        '导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '作用域：' + scopeSlug(),
        '条数：' + logs.length + ' / 上限 ' + DEBUG_CAP + '（最新在上）',
        ''.padEnd(60, '-'),
    ];
    const lines = logs.map((l) => {
        const t = (() => { try { return new Date(Number(l.at) || 0).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; } })();
        const kind = DEBUG_KIND_LABEL[l.kind] || String(l.kind || '');
        const body = (() => { try { return JSON.stringify(JSON.parse(l.data)); } catch (e) { return String(l.data == null ? '' : l.data); } })();
        return '[' + t + '] [' + kind + '] ' + body;
    });
    return head.concat(lines).join('\n') + '\n';
}

/**
 * 组装**可导出的调试包**（纯数据、可 JSON 序列化）：
 *   meta（版本/时间/作用域/宿主能力）+ dump（一键诊断：异常/日志/运行态/探针）+ errors + logs（完整日志，最新在前）。
 * 与「导出记忆数据」分开：调试包**不含记忆正文**（只有日志与运行态），可直接贴给维护者。
 */
export function buildDebugExport() {
    const ctx = getCtx();
    const caps = (() => { try { return (debugHooks.meta && debugHooks.meta()) || {}; } catch (e) { return {}; } })();
    const scope = (() => { try { return String((ctx && ctx.chatId) || (caps && caps.scope) || ''); } catch (e) { return ''; } })();
    return {
        format: 'ftt-memory-v2-debug',
        version: VERSION,
        at: new Date().toISOString(),
        scope,
        env: {
            host: !!(ctx && typeof ctx === 'object'),
            tauri: !!(typeof globalThis !== 'undefined' && (globalThis.__TAURI__ || globalThis.__TAURI_INTERNALS__)),
            storageChannel: (() => { try { return fileTransportStatus(); } catch (e) { return { error: String((e && e.message) || e) }; } })(),
            locale: String((ctx && ctx.locale) || ''),
            userAgent: (() => { try { return String((globalThis.navigator && globalThis.navigator.userAgent) || ''); } catch (e) { return ''; } })(),
            capabilities: caps || {},
        },
        dump: (() => { try { return (debugHooks.dump && debugHooks.dump()) || null; } catch (e) { return { error: String((e && e.message) || e) }; } })(),
        errors: debugLogErrors(),
        errorCount: debugLogErrorCount(),
        stats: debugLogStats(),
        logs: debugLogList(),
        // v2.42.0：交互/宿主/命令/内核/AI/异常统一时间线（结构化 + 人读文本）
        // v2.94.0（D11 S1 / D12 S4b）：主载体只读差异报告（人读文本；不含记忆正文）
        chatMeta: (() => { try { return chatMetaDiffText(state); } catch (e) { return String((e && e.message) || e); } })(),
        traceStats: traceStats(),
        trace: traceList({ limit: 300 }),
        timeline: traceTimelineText(300),
        // v3.0.23（用户要求「任何…读取…都要详细记录统计、时间等信息到日志」）：
        //   读取台账（人读文本 + 结构化统计；含服务端/本地/内存每一次读取的耗时、体积、条数与结果）
        readsText: (() => { try { return readLedgerText(30); } catch (e) { return String((e && e.message) || e); } })(),
        reads: (() => { try { return readLedgerStats(); } catch (e) { return { error: String((e && e.message) || e) }; } })(),
        // v3.13.0：数据体检（只读；摘要 + 明细计数，便于「导出调试包」一并交给开发核对）
        dataHealth: (() => { try { const r = dataHealthReport(); return { ok: r.ok, level: r.level, counts: r.counts, scanned: r.scanned, truncated: r.truncated, text: dataHealthText(r) }; } catch (e) { return { error: String((e && e.message) || e) }; } })(),
    };
}

/**
 * 导出动作（面板 `dbgExport`）：组装调试包 → **下载 .json 文件** → 尽力复制到剪贴板 → 文本落进文本框兜底。
 * v2.82.0：此前只写剪贴板 + 文本框（**不落文件**）→ 用户报告「无法正常导出 log 文件」；现在与「导出记忆 JSON」
 *   同一实现真落文件：成功时报文件名，宿主不支持下载时如实回落文本框 / 剪贴板。
 * @returns {Promise<{ok:boolean, action:string, chars:number, copied:boolean, file:object, note:string}>}
 */
export async function exportDebugBundle() {
    let text = '';
    try { text = JSON.stringify(buildDebugExport(), null, 1); } catch (e) { text = ''; }
    if (!text) return { ok: false, action: 'dbgExport', chars: 0, copied: false, file: null, note: '调试日志导出失败（序列化异常）' };
    lastDebugExport = text;
    const file = saveExportFile('bundle', text);
    let copied = false;
    try {
        const nav = globalThis.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); copied = true; }
    } catch (e) { copied = false; }
    const note = file.ok
        ? ('已导出调试包 ' + text.length + ' 字符 → 已下载文件「' + file.filename + '」' + (copied ? '（并复制到剪贴板）' : ''))
        : ('已导出调试包 ' + text.length + ' 字符，但**未能下载文件**（' + file.reason + '）' + (copied ? '：已复制到剪贴板' : '：见下方文本框，可手动复制'));
    return { ok: true, action: 'dbgExport', chars: text.length, copied, file, note };
}

/**
 * 导出动作（面板 `dbgExportLog`，v2.82.0）：把**人读日志文本**下载为 `.log` 文件 —— 直接对应
 *   用户所说的「导出 log 文件」；同样保留剪贴板与文本框兜底。
 * @returns {Promise<{ok:boolean, action:string, chars:number, copied:boolean, file:object, note:string}>}
 */
export async function exportDebugLog() {
    let text = '';
    try { text = buildDebugLogText(); } catch (e) { text = ''; }
    const logs = (() => { try { return debugLogList().length; } catch (e) { return 0; } })();
    if (!logs) return { ok: false, action: 'dbgExportLog', chars: 0, copied: false, file: null, note: '暂无日志可导出（先产生一些日志再试）' };
    lastDebugLogExport = text;
    const file = saveExportFile('log', text);
    let copied = false;
    try {
        const nav = globalThis.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); copied = true; }
    } catch (e) { copied = false; }
    const note = file.ok
        ? ('已导出日志 ' + logs + ' 条（' + text.length + ' 字符）→ 已下载文件「' + file.filename + '」' + (copied ? '（并复制到剪贴板）' : ''))
        : ('已导出日志 ' + logs + ' 条，但**未能下载文件**（' + file.reason + '）' + (copied ? '：已复制到剪贴板' : '：见下方文本框，可手动复制'));
    return { ok: true, action: 'dbgExportLog', chars: text.length, copied, file, note };
}

/**
 * 日志区块的**顶部按钮行**（v2.82.0，用户要求「设定-调试-日志的按钮全部调整到最上面」）：
 *   导出日志（.log）/ 导出调试包（.json）/ 清空日志 **三枚按钮统一放在日志列表之前**，
 *   并跟一行统计（条数 · 占用 · 上限口径）与一行「导出内容是什么」的说明。
 *   导出结果（文本）折叠在按钮行下方 —— 既是文本框兜底，也不把日志列表推下去。
 * @param {Array} logs 日志条目（调用方已取好，避免重复读取）
 */
function debugLogToolbarHtml(logs) {
    const list = Array.isArray(logs) ? logs : [];
    let totalBytes = 0;
    for (const l of list) { try { totalBytes += (String(l && l.data) || '').length; } catch (e) { /* 忽略 */ } }
    const rows = [];
    rows.push('<div class="ftt-row">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="dbgExportLog" title="把日志导出为 .log 文本文件（含导出头信息；宿主不支持下载时回落剪贴板与下方文本框）">⬇ 导出日志</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="dbgExport" title="导出调试包（全部日志 + 运行态诊断，不含记忆正文）为 .json 文件">⬇ 导出调试包</button>'
        + (list.length ? '<button class="ftt-btn ftt-sm" data-ftt-action="dbgClear" title="清空全部调试日志（内存 + 本机持久层）">🗑 清空日志</button>' : '')
        + '<span class="ftt-muted">共 ' + list.length + ' 条 · 总占用 ' + formatBytes(totalBytes) + '（最多 ' + DEBUG_CAP + ' 条 · 最新在上 · 点击展开）</span>'
        + '</div>');
    rows.push('<div class="ftt-muted">⬇ 导出日志＝人读 .log 文本（时间 · 类别 · 内容）；⬇ 导出调试包＝日志 + 运行态诊断的 .json，<b>不含记忆正文</b>。</div>');
    const last = lastDebugLogExport || lastDebugExport;
    if (last) {
        const label = lastDebugLogExport ? '最近一次「导出日志」的文本（可复制）' : '最近一次「导出调试包」的文本（可复制）';
        rows.push('<details class="ftt-hint-details"><summary>' + esc(label) + '</summary>'
            + '<div class="ftt-field ftt-field-col"><textarea data-ftt-debugexport="1" rows="8">' + esc(last) + '</textarea></div></details>');
    }
    if (lastExportFile && lastExportFile.ok === false) {
        rows.push('<div class="ftt-hint">⚠️ 上次导出**未能下载文件**（' + esc(String(lastExportFile.reason || '')) + '）—— 宿主可能不支持下载，请用上方文本框复制内容。</div>');
    }
    return rows.join('\n');
}

/** 日志列表 HTML（V1 `debugHtml()` 结构：操作行 + 类别统计行 + 逐条 `<details class="ftt-dbg-item">`） */
export function debugLogHtml() {
    const logs = debugLogList();
    // v2.82.0：按钮行（导出日志 / 导出调试包 / 清空日志）**始终在最上面** —— 空态也有导出入口，
    //   不再是「先看一长串日志、按钮在别处」。
    const toolbar = debugLogToolbarHtml(logs);
    if (!logs.length) return toolbar + '<div class="ftt-empty">暂无日志。</div>';
    // 日志统计（各 kind 计数；顺序 = 首次出现顺序，V1 原样）
    const statCount = {};
    for (const l of logs) statCount[l.kind] = (statCount[l.kind] || 0) + 1;
    const statHtml = Object.keys(statCount).map((k) => '<span class="ftt-stat">' + esc(DEBUG_KIND_LABEL[k] || k) + ' ' + statCount[k] + '</span>').join('');
    return toolbar + '<div class="ftt-row">' + statHtml + '</div>' + logs.map((l) => {
        // 日期+时间（不只记录时间；V1 用 toLocaleString('zh-CN', { hour12: false })）
        const t = new Date(l.at).toLocaleString('zh-CN', { hour12: false });
        const color = DEBUG_KIND_COLOR[l.kind] || '#b8b3ac';
        const label = DEBUG_KIND_LABEL[l.kind] || l.kind;
        const size = formatBytes((l.data || '').length);
        let data = l.data;
        try { data = JSON.stringify(JSON.parse(l.data), null, 1); } catch (e) { /* 原样展示 */ }
        const sum = debugSummary(l);
        return '<details class="ftt-dbg-item"><summary class="ftt-dbg-head"><span class="ftt-dbg-kind" style="color:' + esc(color) + '">' + esc(label) + '</span><span class="ftt-dbg-time">' + esc(t) + '</span><span class="ftt-dbg-size">' + esc(size) + '</span>' + (sum ? '<span class="ftt-dbg-sum">' + esc(sum) + '</span>' : '') + '</summary><div class="ftt-dbg-data">' + esc(data) + '</div></details>';
    }).join('\n');
}

/**
 * 「🧭 交互与宿主调用时间线」区块（v2.42.0，只读）：
 *   用户交互（点击/变更/切页）、插件↔宿主 API 调用、命令与 FTT 入口、落盘/注入、AI 调用与**异常**统一按时间列出；
 *   每条带 opId（关联到触发它的交互）、耗时、结果与**代码站点**（file:line）；异常条目附**上下文窗口**。
 * @param {string} [cat] 类别过滤（ui/host/cmd/kernel/ai/error）
 */
export function traceSectionHtml(cat) {
    const st = traceStats();
    const rows = traceList({ cat: cat || '', limit: 60 });
    const chips = ['', ...TRACE_CATS].map((c) => {
        const on = String(cat || '') === c;
        const label = c === '' ? ('全部 ' + st.total) : ((DEBUG_CAT_LABEL[c] || c) + ' ' + ((st.cats && st.cats[c]) || 0));
        return '<button class="ftt-btn ftt-sm' + (on ? ' ftt-primary' : '') + '" data-ftt-action="dbgTraceFilter" data-ftt-kind="' + esc(c) + '" title="只看该类别">' + esc(label) + '</button>';
    }).join('');
    const ctxText = (ctx) => (ctx.window || []).map((x) => [
        new Date(Number(x.at) || 0).toLocaleTimeString('zh-CN', { hour12: false }),
        x.cat, x.kind, x.ok === false ? ('失败:' + x.reason) : 'ok', x.ms ? (x.ms + 'ms') : '', x.opId, x.site,
    ].filter(Boolean).join('  ')).join('\n');
    const line = (e) => {
        const t = new Date(Number(e.at) || 0).toLocaleTimeString('zh-CN', { hour12: false });
        const isErr = e.cat === 'error' || e.ok === false;
        const ctx = isErr ? traceContext(e.id, 20) : null;
        const detail = (() => { try { const j = JSON.stringify(e.detail || {}); return (j === '{}' || j === 'null') ? '' : j.slice(0, 300); } catch (x) { return ''; } })();
        const ctxHtml = ctx
            ? ('<div class="ftt-dbg-data">上下文（错误前后 ' + (ctx.window || []).length + ' 条 · 同 opId ' + (ctx.related || []).length + ' 条）：\n' + esc(ctxText(ctx)) + '</div>')
            : '';
        const head = [e.kind, e.ok === false ? ('❌ ' + e.reason) : '', e.n > 1 ? ('×' + e.n) : '',
            e.opId ? (e.opId + (e.op ? ('(' + e.op + ')') : '')) : '', traceSiteText(e.site)].filter(Boolean).join(' · ');
        return '<details class="ftt-dbg-item"' + (isErr ? ' open' : '') + '><summary class="ftt-dbg-head">'
            + '<span class="ftt-dbg-kind"' + (isErr ? ' style="color:#ff9a9a"' : '') + '>' + esc(e.cat) + '</span>'
            + '<span class="ftt-dbg-time">' + esc(t) + '</span>'
            + '<span class="ftt-dbg-size">' + esc(e.ms ? (e.ms + 'ms') : '') + '</span>'
            + '<span class="ftt-dbg-sum">' + esc(head) + '</span>'
            + '</summary><div class="ftt-dbg-data">' + esc(detail) + '</div>' + ctxHtml + '</details>';
    };
    return [
        '<div class="ftt-row">' + chips + '</div>',
        '<div class="ftt-muted">会话 ' + esc(st.session) + ' · 事件 ' + st.total + '（上限 ' + st.cap + '）· 级别 ' + esc(st.level) + '</div>',
        (rows.length ? rows.map(line).join('\n') : '<div class="ftt-empty">暂无事件。</div>'),
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="dbgTraceClear">🗑 清空时间线</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="dbgExport">⬇ 导出调试包（含时间线）</button>'
        + '<span class="ftt-muted">仅内存，重启即空</span></div>',
    ].join('\n');
}

/** 调试页正文（v2.55.0 精简：只留「看审计日志 / 导出日志」，删除开发与历史说明）
 * @param {Array} controls `SETTINGS_CONTROLS.debug`（本页唯一控件 `debugEnabled`）
 */
/**
 * 「📎 chatMetadata 主载体（只读差异报告）」区块（v2.94.0，`docs/D11` v0.3 §5 S1 / `docs/D12` v0.2 S4b）。
 *
 * 用户裁决（`docs/D12` §8-C）：「载体必须比消息活得久 —— 记忆数据主载体是 `chatMetadata`（随聊天存活），
 *   不得把消息 `extra` 作为唯一载体（删楼会连带删掉）。」
 * 本阶段**只读不写**：把 chatMetadata 里那份数据与当前生效状态做**逐项差异**（各维条数 / 体积 / 时间先后），
 * 给出可执行结论。宿主不提供 chatMetadata 时如实标注「已降级」，**不报错、不改任何数据**。
 */
export function chatMetaSectionHtml() {
    let d = null;
    try { d = chatMetaDiffReport(state); } catch (e) { d = null; }
    if (!d) return '<div class="ftt-muted">无法读取 chatMetadata（已降级，不影响记忆数据）。</div>';
    const verdictLabel = {
        unsupported: '⚪ 宿主不支持（已降级）',
        empty: '⚪ 两边都没有本插件的记忆',
        'live-only': '🟡 仅文件通道有数据',
        'meta-only': '🟠 仅 chatMetadata 有数据',
        same: '✅ 两边一致',
        'meta-newer': '🟠 chatMetadata 较新',
        'live-newer': '🟡 当前状态较新',
    }[String(d.verdict)] || d.verdict;
    const dims = Object.keys(d.dims || {});
    const dimRows = dims.length
        ? ('<div class="ftt-muted">' + dims.map((k) => escHtml(k + '：chatMetadata ' + d.dims[k].meta + ' / 当前 ' + d.dims[k].live + '（差 ' + d.dims[k].delta + '）')).join('<br>') + '</div>')
        : '';
    return [
        '<div class="ftt-muted">记忆数据应当<b>随聊天走</b>：聊天被酒馆同步 / 备份时，chatMetadata 一起走，删楼也不会丢记忆。</div>',
        '<div class="ftt-hint" data-ftt-chat-meta>命名空间 <span class="ftt-mono-sm">' + escHtml(CHAT_META_KEY) + '</span> · ' + escHtml(verdictLabel) + '<br>'
        + 'chatMetadata：' + (d.present ? (d.meta.total + ' 条 · ' + d.meta.bytes + ' 字节') : '（无本插件数据）')
        + ' · 当前状态：' + d.live.total + ' 条 · ' + d.live.bytes + ' 字节</div>',
        '<div class="ftt-muted">' + escHtml(d.text) + '</div>',
        dimRows,
        '<div class="ftt-hint">本阶段<b>只读</b>：不改 chatMetadata、也不改当前数据；写路径（主通道切换）属后续阶段。</div>',
    ].join('\n');
}

// ============================================================
// 🔌 调试桥（v3.0.7）—— 跨宿主本地调试
//
// 用途：让本机调试工具（`tests/local/bridge.mjs`）通过一个本地端口，调用**插件内置好的只读 API**，
//   从而在**真实宿主页面**里做实际数据测试 —— 而不是用无头浏览器模拟（模拟不出真实宿主）。
//
// 跨宿主（硬要求）：
//   · 传输层只依赖浏览器 `WebSocket` → **酒馆原生与 TauriTavern 都可用**；
//   · `host.*` 那层依赖 TauriTavern 的 `window.__TAURITAVERN__.api.dev`（官方规范化调试 ABI），
//     非 TauriTavern 时返回 `{available:false, reason}` —— **只降级，不报错**；
//   · 开关**默认关闭且不持久化**（每次加载回到关闭态），并只派发白名单内的只读方法。
// ============================================================

/** 允许经调试桥派发的**只读**方法白名单（在此追加即扩展；切勿登记改动型动作） */
export function buildBridgeMethods() {
    const T = Object.create(null);

    /** 需要插件调试导出（window.FTT）的只读方法；缺失时降级返回而非抛错 */
    const needFtt = (fn) => async (params) => {
        let F = null;
        try { F = (typeof window !== 'undefined' && window.FTT) ? window.FTT : null; } catch (e) { F = null; }
        if (!F) return { available: false, reason: 'window.FTT 不可用（插件调试导出未安装）' };
        try { return await fn(F, params || {}); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    };
    /** 本地只读诊断；任何异常都收敛成 available:false */
    const safe = (fn) => async (params) => {
        try { return await fn(params || {}); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    };
    /** TauriTavern 专属：`api.dev` 缺失或该版本没有该方法 → 降级 */
    const needDev = (what, sub, method) => async (params) => {
        let dev = null;
        try { const abi = ttAbi(); dev = (abi && abi.api && abi.api.dev) ? abi.api.dev : null; } catch (e) { dev = null; }
        if (!dev) return { available: false, reason: '当前宿主不是 TauriTavern：' + what + ' 不可用（酒馆原生下本方法只降级，不报错）' };
        const holder = sub ? dev[sub] : dev;
        const fn = holder && holder[method];
        if (typeof fn !== 'function') return { available: false, reason: '该 TauriTavern 版本未提供 ' + (sub ? sub + '.' : '') + method + '()' };
        try { return await fn.call(holder, params || {}); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    };

    // —— 自省 ——
    T['sys.info'] = async () => ({
        protocol: BRIDGE_PROTOCOL,
        plugin: { name: 'FTT记忆组件 V2', version: VERSION },
        host: bridgeHost(),
        bridge: bridgeState(),
        methods: bridgeMethodNames(),
        note: '只读调试桥；默认关闭、刷新即关',
    });
    T['sys.methods'] = async () => bridgeMethodNames();
    T['sys.host'] = async () => bridgeHost();
    T['sys.bridgeState'] = async () => bridgeState();

    // —— 插件只读导出 ——
    T['ftt.snapshot'] = needFtt((F) => F.snapshot());
    T['ftt.probe'] = needFtt((F) => F.probe());
    //   `ftt.stateSize`：只回导出文本的字节数（**不回正文**）—— 正名以避免看起来像「导出/写盘」动作
    T['ftt.stateSize'] = needFtt((F) => {
        const t = String(F.exportState() || '');
        return { available: true, bytes: t.length };
    });
    T['ftt.debugLogStats'] = safe(() => debugLogStats());
    T['ftt.debugPageInfo'] = safe(() => debugPageInfo());
    T['ftt.traceStats'] = safe(() => traceStats());
    T['ftt.clockTraceInfo'] = safe(() => clockTraceInfo());
    T['ftt.clockTraceSummary'] = safe(() => clockTraceSummary());
    T['ftt.fileTransport'] = safe(() => fileTransportStatus());
    T['ftt.chatMeta'] = safe(() => chatMetaDiffReport());

    // —— 记忆真实数据（**只读**）——
    //   `ftt.memoryShape`：各维度条数（不含正文）
    T['ftt.memoryShape'] = safe(() => memoryShape());
    //   `ftt.memorySample`：按维度取样；**默认只回字段名与长度**，显式 { values:true } 才回传正文
    T['ftt.memorySample'] = safe((p) => memorySample(p.dim, p.limit, p.values === true));

    // —— 台账 / 未摘要清单的只读诊断（v3.0.9）——
    //   全部走 `maintain:false` 与纯函数比较：**不触发任何台账维护写入**（migrate/drift/reconcile/shrink 一律不跑）。
    T['ftt.ledger'] = safe(() => {
        const raw = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        // v3.13.0：楼层号解析改**严格**（只认非负整数 / 十进制数字串）——
        //   此前用 `Number(x)` 会把 `null` 读成第 0 楼、把 `{f:'x'}` 读成 NaN 而不报，异常数据被掩盖。
        const marks = raw.map((x) => {
            const obj = !!x && typeof x === 'object' && !Array.isArray(x);
            const rv = obj ? x.f : x;
            let f = NaN;
            if (typeof rv === 'number') f = Number.isInteger(rv) ? rv : NaN;
            else if (typeof rv === 'string' && /^\d+$/.test(rv.trim())) f = Number(rv.trim());
            return { f: Number.isInteger(f) ? f : null, h: obj ? String(x.h || '') : '', bad: !Number.isInteger(f) };
        });
        return {
            stats: processedStats(),
            marks: marks,
            badMarks: marks.filter((m) => m.bad).length,
            verMatches: (state.processedVer || '') === processedVerTag(),
            processedVer: String(state.processedVer || ''),
            currentVer: processedVerTag(),
        };
    });
    T['ftt.chatReady'] = safe(() => chatReadyForFloors());
    T['ftt.pendingScan'] = safe(() => {
        const s = scanPendingFloors({ maintain: false });
        return { lastId: s.lastId, lastIdStale: s.lastIdStale, endFloor: s.endFloor, covered: s.covered, skipped: s.skipped, count: s.floors.length, floors: s.floors, chatReady: s.chatReady, chatReason: s.chatReason };
    });
    T['ftt.pendingFloors'] = safe(() => listUnprocessedFloors({ maintain: false }));
    /** 单楼诊断：这一楼为什么被判为未摘要（逐项给出页面侧实际算出的值） */
    T['ftt.floorDiag'] = safe((p) => floorDiag(Number(p.i)));
    // v3.20.0（只读零副作用）：**情节归属体检** —— 回答「时钟为什么取了别条聊天的时间」：
    //   本聊天 / 归属未知（升级前历史数据）/ 别条聊天 各多少条、多少条位置越界、
    //   以及**本聊天**最新几条的楼层与日期时间（不含正文）。
    T['ftt.plotScope'] = safe(() => {
        const snap = plotScopeSnapshot();
        return Object.assign({ chatKey: currentChatKey().slice(0, 12) + (currentChatKey() ? '…' : ''), chatTail: currentChatTail() }, snap);
    });

    // —— 数据体检（v3.13.0，**只读零副作用**）：把存档里的数据异常逐条列出 ——
    //   脏台账标记 / 非规范 NSFW 等级 / 负数 uses / 倒置或非法的楼层区间 / 缺 id · 重复 id /
    //   孤儿关联行 / 非法墓碑时间戳 / 超长字段 …（自愈在载入期 `migrateState`，这里只核对）
    T['ftt.dataHealth'] = safe((p) => dataHealthReport(undefined, { cap: Number((p && p.cap) || 0) || undefined }));
    T['ftt.dataHealthText'] = safe(() => dataHealthText(dataHealthReport()));
    // v3.15.1（闪退取证）：**原生写队列**诊断 —— 队列计数 / 历史峰值并发（应恒为 1）/ 最近一次原生写的标签与耗时。
    //   用途：真机核对「是否还有并发写」，以及崩溃前最后一次原生写是什么、花了多久。
    T['ftt.writeStats'] = safe(() => ttWriteStats());

    // —— 载入链路诊断（v3.0.10，**只读**）——
    //   把「内存台账 / 本机缓冲 / 服务端文件 / 台账相关调试日志」四处并排读出来，
    //   用于回答「为什么重载后内存台账是空的」。只做 getItem 与只读读取，不写任何存储。
    T['ftt.loadDiag'] = safe(() => loadDiag());
    // v3.0.23（只读）：读取台账（每一次服务端/本地/内存读取的时间、体积、条数、结果）
    T['ftt.reads'] = safe((p) => ({ stats: readLedgerStats(), lines: readLedgerLines(Number((p && p.limit) || 20)) }));
    T['ftt.readLedgerText'] = safe(() => readLedgerSummaryText(30));

    // —— TauriTavern 宿主调试 ABI（酒馆原生下全部降级）——
    T['host.frontendLogsList'] = needDev('前端日志', 'frontendLogs', 'list');
    T['host.consoleCaptureGet'] = needDev('console 捕获开关', 'frontendLogs', 'getConsoleCaptureEnabled');
    T['host.backendLogsTail'] = needDev('后端日志', 'backendLogs', 'tail');
    T['host.llmLogsIndex'] = needDev('LLM 请求日志索引', 'llmApiLogs', 'index');
    T['host.llmLogsPreview'] = needDev('LLM 请求日志预览', 'llmApiLogs', 'getPreview');
    T['host.llmLogsRaw'] = needDev('LLM 请求日志原文', 'llmApiLogs', 'getRaw');
    T['host.llmLogsKeep'] = needDev('LLM 日志保留数', 'llmApiLogs', 'getKeep');

    return T;
}

/**
 * 单楼诊断（只读，纯比较）：回答「这一楼为什么被判为未摘要」。
 * 只回长度与哈希（**不回正文**），逐项对齐 `host/floors.js` 的判据，但**不调用** `isFloorProcessed()`
 *   —— 后者在签名不符时会触发台账迁移写入；诊断必须零副作用。
 */
function floorDiag(i) {
    const n = Number(i);
    if (!Number.isFinite(n) || n < 0) return { available: false, reason: '楼层号非法：' + String(i) };
    const m = floorMessage(n);
    if (!m) return { available: false, reason: '该楼不存在（聊天可能尚未加载完 / 已越界）', i: n };
    const stable = floorStableText(m);
    const mes = (typeof m.mes === 'string') ? m.mes : '';
    const hashStable = hashFloorText(n);
    const hashMes = mes.trim() ? hashText(mes) : '';
    const pf = state.processedFloors || [];
    const mark = pf.find((x) => Number(x && typeof x === 'object' ? x.f : x) === n);
    const markH = mark ? String((mark && mark.h) || '') : '';
    const analyzable = String(floorAnalyzableText(n) || '');
    const cov = (() => { try { return floorCoverage(state, { maxFloor: liveFloorTail() }).has(n); } catch (e) { return null; } })();
    const verMatches = (state.processedVer || '') === processedVerTag();
    const processed = !!(mark && hashStable && (!markH || markH === hashStable));   // 同 isFloorProcessed 判据
    const coveredSkip = !mark && cov === true;                                     // 覆盖跳过只在「无标记」时生效
    return {
        available: true,
        i: n,
        isUser: !!m.is_user,
        isHidden: !!m.is_hidden,
        swipesCount: Array.isArray(m.swipes) ? m.swipes.length : 0,
        swipeId: (m.swipe_id === undefined ? null : m.swipe_id),
        swipes0Len: (Array.isArray(m.swipes) && typeof m.swipes[0] === 'string') ? m.swipes[0].length : null,
        mesLen: mes.length,
        stableLen: stable.length,
        hashStable: String(hashStable || ''),
        hashMes: String(hashMes || ''),
        mesEqualsStable: !!(stable && stable === mes),
        markPresent: !!mark,
        markH: markH,
        markSameHash: !!(mark && hashStable && markH === hashStable),
        verMatches: verMatches,
        processed: processed,
        analyzableLen: analyzable.length,
        covered: cov,
        wouldBePending: !(m.is_user || m.is_hidden || !analyzable.length || processed || coveredSkip),
    };
}

/**
 * 从信封文本里读出「台账三件套」（只读；解析失败给原因）。
 * 同时校验信封哈希是否自洽 —— 「哈希不符 → 载入被拒 → 回落空状态」是本次排查的重点嫌疑。
 */
function ledgerOfEnvelopeText(text) {
    try {
        const env = JSON.parse(String(text || ''));
        const d = (env && env.payload && env.payload.data) ? env.payload.data : env;
        if (!d || typeof d !== 'object') return { parsed: false };
        const pf = Array.isArray(d.processedFloors) ? d.processedFloors : null;
        return {
            parsed: true,
            marks: pf ? pf.length : null,
            floors: pf ? pf.map((x) => Number(x && x.f)).filter(Number.isFinite).slice(0, 40) : null,
            ver: String(d.processedVer || ''),
            lastKnownFloor: (d.lastKnownFloor === undefined ? null : Number(d.lastKnownFloor)),
            scope: String(d.scope || ''),
            version: String(d.version || ''),
            hashOk: (() => { try { return !env.hash || env.hash === storageHash(env.payload); } catch (e) { return null; } })(),
        };
    } catch (e) { return { parsed: false, error: String((e && e.message) || e) }; }
}

/** 台账相关调试日志（只取动作与计数，不含聊天正文） */
function ledgerLogEntries(limit) {
    try {
        const RX = /迁移|归位|漂移|对账|收缩|台账|标记|未摘要|待分析/;
        const pick = (e) => { try { return typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return null; } };
        return debugLogList()
            .filter((e) => RX.test(String((e && e.kind) || '') + String((pick(e) && pick(e).action) || '')))
            .slice(0, Number(limit) > 0 ? Number(limit) : 40)
            .map((e) => {
                const d = pick(e) || {};
                const nums = {};
                for (const k of Object.keys(d)) if (typeof d[k] === 'number') nums[k] = d[k];
                return { at: Number(e.at) || 0, kind: String(e.kind || ''), action: String(d.action || ''), nums: nums, reason: String(d.reason || '') };
            });
    } catch (e) { return []; }
}

/**
 * 载入链路诊断（**只读**）：把「内存台账 / 本机缓冲 / 服务端文件 / 台账相关调试日志」并排读出来。
 * 只做 `getItem` 与只读读取；不写任何存储、不触发任何台账维护。
 */
async function loadDiag() {
    const scope = String(scopeId());
    const key = 'ftt2_state_' + scope;
    const out = {
        scope: scope,
        localBufferKey: key,
        memory: {
            marks: Array.isArray(state.processedFloors) ? state.processedFloors.length : null,
            ver: String(state.processedVer || ''),
            lastKnownFloor: (state.lastKnownFloor === undefined ? null : Number(state.lastKnownFloor)),
            tag: processedVerTag(),
        },
    };
    // ① 本机缓冲（localStorage；只 getItem）
    try {
        const ls = globalThis.localStorage;
        if (!ls) out.localBuffer = { available: false };
        else {
            const raw = ls.getItem(key);
            out.localBuffer = raw
                ? Object.assign({ available: true, present: true, bytes: raw.length }, ledgerOfEnvelopeText(raw))
                : { available: true, present: false };
        }
    } catch (e) { out.localBuffer = { available: false, error: String((e && e.message) || e) }; }
    // ② 服务端文件（与载入同一条只读读取）
    try {
        const r = await fileTransportReadAuto(stateFileName(scope));
        out.file = (r && r.ok)
            ? Object.assign({ ok: true, bytes: String(r.text || '').length }, ledgerOfEnvelopeText(r.text))
            : { ok: false, error: String((r && r.error) || 'no-file') };
    } catch (e) { out.file = { ok: false, error: String((e && e.message) || e) }; }
    // ③ 台账相关调试日志（回答「谁在什么时候把台账弄没了」）
    out.ledgerLog = ledgerLogEntries(40);
    return out;
}

/**
 * 记忆容器形状（只读；只回条数/类型，不回正文）。
 * v3.0.8 修复：维度名**从 `DIMENSIONS` 派生**（单一来源）—— 此前手写列表把
 *   `currentStates` 写成 `states`、把名册写成 `roster`，两项在真机恒返回 null。
 *   另补 `npcs`（名册：确实是运行时容器，但不在 `DIMENSIONS` 的 14 项里）与 `vars` / `deleted`。
 */
function memoryShape() {
    const keys = DIMENSIONS.map((d) => d.kind);
    const extra = ['npcs', 'vars', 'deleted'];
    const out = {};
    // v3.13.0（数据体检）：计数表只回**数字**（数组 = 条数、对象 = 键数、缺失 = null）。
    //   此前类型错误的容器会把 `typeof v`（如 `"string"`）直接填进计数表 —— 消费方（调试页/端口脚本）
    //   拿到的就不是条数；现在统一归入 `bad`（维度 → 实际类型），异常本身由 `ftt.dataHealth` 报告。
    const bad = {};
    for (const k of keys.concat(extra)) {
        try {
            const v = state[k];
            if (Array.isArray(v)) out[k] = v.length;
            else if (v && typeof v === 'object') out[k] = Object.keys(v).length;
            else if (v === undefined || v === null) out[k] = null;
            else { out[k] = null; bad[k] = typeof v; }
        } catch (e) { out[k] = null; }
    }
    if (Object.keys(bad).length) out.bad = bad;
    return out;
}

/**
 * 按维度取样（只读）。
 * **默认只回字段名与值长度**（shape），显式传 `values:true` 才回传截断后的真实值 —— 避免调试桥
 * 在默认情况下把聊天/记忆正文经端口外送。
 */
function memorySample(dim, limit, wantValues) {
    const k = String(dim || '');
    if (!k) return { available: false, reason: '缺少 dim 参数' };
    let arr = null;
    try { arr = state[k]; } catch (e) { arr = null; }
    if (!Array.isArray(arr)) return { available: false, reason: '维度不存在或不是数组：' + k, dim: k };
    const n = Math.max(1, Math.min(Number(limit) || 3, 20));
    const rows = arr.slice(0, n).map((it) => {
        const o = (it && typeof it === 'object') ? it : { value: it };
        const shape = {};
        for (const f of Object.keys(o)) {
            const v = o[f];
            shape[f] = Array.isArray(v) ? ('array(' + v.length + ')') : (typeof v === 'string' ? v.length : typeof v);
        }
        return wantValues ? { _shape: shape, _values: o } : shape;
    });
    return { available: true, dim: k, total: arr.length, returned: rows.length, values: !!wantValues, rows };
}

let bridgeInstalled = false;

/**
 * 装配调试桥（幂等）：登记只读方法表。**不自动开启连接** —— 连接必须由用户在调试页显式开启。
 * @returns {{ok:boolean, methods:number, state:object}}
 */
export function installDebugBridge() {
    let n = 0;
    try { n = setBridgeMethods(buildBridgeMethods()); bridgeInstalled = true; } catch (e) { n = 0; }
    return { ok: bridgeInstalled, methods: n, state: bridgeState() };
}

/** 是否已装配（只读诊断） */
export function debugBridgeInstalled() { return bridgeInstalled; }

/** 「🔌 调试桥」区块（只读渲染；开关默认关） */
export function debugBridgeSectionHtml() {
    if (!bridgeInstalled) installDebugBridge();
    const st = bridgeState();
    const host = bridgeHost();
    const hostLabel = host.tauriTavern
        ? ('TauriTavern' + (host.abiVersion === null ? '' : ('（ABI v' + host.abiVersion + '）')) + (host.devApi ? ' · api.dev 可用' : ' · api.dev 不可用'))
        : '酒馆原生（浏览器）';
    const connLabel = !st.supported ? '传输不可用'
        : (!st.running ? '已关闭' : (st.connected ? ('已连接 ' + st.targetHost + ':' + st.port) : ('未连接（重试中，' + st.targetHost + ':' + st.port + '）')));
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">🔌 调试桥 <span class="ftt-muted">本地调试 · 只读</span></div>',
        '<div class="ftt-row"><span class="ftt-muted">宿主：' + esc(hostLabel) + '</span></div>',
        '<div class="ftt-row"><span class="ftt-muted">状态：' + esc(connLabel) + ' · 已登记 ' + st.methodCount + ' 个只读方法</span></div>',
        '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-bridge-host value="' + esc(String(bridgeTarget())) + '" placeholder="目标主机（默认 ' + esc(BRIDGE_DEFAULT_HOST) + '）">'
            + '<input class="ftt-input" type="text" data-ftt-bridge-port value="' + esc(String(bridgePort())) + '" placeholder="端口">'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="bridgeTargetSet" title="只改内存中的目标；刷新后回到默认值">保存目标</button>'
            + '<button class="ftt-btn ftt-sm' + (st.running ? ' ftt-err' : '') + '" data-ftt-action="bridgeToggle">' + (st.running ? '⏹ 关闭调试桥' : '▶ 开启调试桥') + '</button></div>',
        '<div class="ftt-hint">只读白名单 · 默认关闭、刷新即关 · 不含清空/删除类动作</div>',
        (!st.supported ? '<div class="ftt-hint">本环境不支持 WebSocket，调试桥无法启用（其余功能不受影响）</div>'
            : (!st.tauriTavern ? '<div class="ftt-hint">酒馆原生：宿主日志类方法不可用，调用只回原因、不报错</div>' : '')),
        (!st.loopback ? '<div class="ftt-hint">⚠ 目标不是本机：只读调试面将对局域网开放，同网设备可读</div>' : ''),
        hintDetailsHtml('调试桥说明',
            '<div>' + esc('本机调试工具监听一个本地端口，插件主动拨出连接过去（页面本身无法监听端口，所以方向相反）。协议 v' + BRIDGE_PROTOCOL + '，默认 ' + BRIDGE_DEFAULT_HOST + ':' + BRIDGE_DEFAULT_PORT + '。') + '</div>'
            + '<div>' + esc('只派发白名单内的只读方法（插件快照 / 调试日志统计 / 记忆条数与取样 / 文件通道状态等）；清空、删除、修复、导出落盘这类改动型动作一律不登记。') + '</div>'
            + '<div>' + esc(st.tauriTavern
                ? '宿主为 TauriTavern：额外提供宿主日志类方法（前端日志、后端日志、LLM 请求留档），走官方 window.__TAURITAVERN__.api.dev，只读取不设置。'
                : '宿主为酒馆原生（浏览器）：传输与插件只读方法照常可用；宿主日志类方法依赖 TauriTavern，调用它们只会返回原因。') + '</div>'
            + '<div>' + esc('目标主机默认只连本机。要调试手机等其它设备，把目标改为运行调试工具那台机器的局域网地址（如 192.168.x.x），并在那台机器上让桥接服务监听局域网；此时同网设备都能读到这些只读数据。') + '</div>'
            + '<div>' + esc('参考用法见仓库 tests/local/README.md（本机调试工具与其协议）。') + '</div>'),
        (st.lastCall ? ('<div class="ftt-muted">最近调用：' + esc(st.lastCall.method) + ' · ' + Number(st.lastCall.ms) + 'ms · ' + (st.lastCall.ok ? '成功' : '失败') + '</div>') : ''),
        (st.lastError ? ('<div class="ftt-hint">最近错误：' + esc(st.lastError) + '</div>') : ''),
        '</div>',
    ].join('\n');
}

/**
 * v3.0.23：「📥 读取台账（服务端 / 本地 / 内存）」区块（**只读**）。
 *   回答「这次载入到底读了哪几层、每层读到什么、花了多久、为什么没读到」——
 *   数据来自 `core/read-ledger.js` 的内存环形缓冲（不落盘，避免日志膨胀）。
 */
export function readLedgerSectionHtml(limit) {
    const st = (() => { try { return readLedgerStats(); } catch (e) { return null; } })();
    if (!st || !st.totalReads) return '<div class="ftt-muted">本次会话还没有读取记录（载入 / 同步 / 保存时会自动记录）。</div>';
    const summary = readLedgerSummaryText(limit || 20);
    const srcRows = Object.keys(st.bySrc).map((k) => {
        const s = st.bySrc[k];
        return '<div class="ftt-dim-row"><span class="ftt-dim-name">' + esc(s.label || k) + '</span>'
            + '<span class="ftt-muted">' + s.n + ' 次 · 失败 ' + s.fail + ' · 未命中 ' + s.miss + ' · 共 ' + s.ms + 'ms · 最慢 ' + s.maxMs + 'ms · ' + s.bytes + ' 字节 · ' + s.items + ' 条</span></div>';
    }).join('');
    const lines = readLedgerLines(limit || 20).map((l) => '<div class="ftt-mono">' + esc(l) + '</div>').join('');
    return '<div class="ftt-hint">共 ' + st.totalReads + ' 次读取 · 成功 ' + st.ok + ' / 失败 ' + st.fail + ' / 未命中 ' + st.miss
        + ' · 累计 ' + st.totalMs + 'ms · 平均 ' + st.avgMs + 'ms · 累计 ' + st.totalBytes + ' 字节</div>'
        + (srcRows || '')
        + '<div class="ftt-dim-row"><span class="ftt-dim-name">最近 ' + Math.min(limit || 20, st.count) + ' 条</span></div>'
        + (lines || '<div class="ftt-muted">暂无</div>')
        + '<div class="ftt-muted">来源标签：' + esc(Object.keys(READ_SRC_LABEL).map((k) => READ_SRC_LABEL[k]).join(' / ')) + '</div>'
        + '<div class="ftt-hint">台账只记<b>体积 / 条数 / 字段名 / 哈希 / 结果</b>，不含任何正文；重新载入或点下方按钮可清零。</div>'
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="readLedgerClear" type="button">🧹 清空读取台账</button></div>';
}

/** 读取台账人读文本（调试包用；与区块同源，不含正文） */
export function readLedgerText(limit) {
    try { return readLedgerSummaryText(limit || 30); } catch (e) { return '读取台账不可用：' + String((e && e.message) || e); }
}

export function debugPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const sw = list.filter((c) => String(c.key) === 'debugEnabled').map((c) => settingsControlHtml(c)).join('\n');
    const errCount = debugLogErrorCount();
    const errRows = (() => {
        if (!errCount) return '<div class="ftt-muted">暂无异常记录。</div>';
        const last = debugLogLastError();
        const d = (() => { try { return JSON.parse(last.data); } catch (e) { return { message: String((last && last.data) || '') }; } })();
        return '<div class="ftt-hint">最近一条 · ' + esc(String(new Date(Number(last.at) || 0).toLocaleString('zh-CN', { hour12: false }))) + '<br>'
            + esc(String(d.kind || '异常')) + '：' + esc(String(d.message || '')).slice(0, 300)
            + (d.source ? ('<br><span class="ftt-muted">' + esc(String(d.source)) + (d.line ? (':' + Number(d.line) + (d.col ? (':' + Number(d.col)) : '')) : '') + '</span>') : '')
            + '</div>'
            + '<div class="ftt-row"><span class="ftt-muted">最近 3 条：' + esc(debugLogErrors(3).map((l) => { const x = (() => { try { return JSON.parse(l.data); } catch (e) { return {}; } })(); return String(x.message || l.data || '').slice(0, 60); }).join(' ｜ ')) + '</span></div>';
    })();
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">调试日志</div>',
        sw,
        '<div class="ftt-muted">关闭后不再记录新日志；已存日志仍可查看。</div>',
        '</div>',
        // ① 日志查看器（本页核心：看审计日志 + 导出）
        // v2.82.0（用户要求「日志的按钮全部调整到最上面」）：导出日志 / 导出调试包 / 清空日志
        //   三枚按钮统一在**本区块顶部**（原先「导出调试包」在下方独立分节，要滚到底才能点到）。
        '<div class="ftt-section"><div class="ftt-sec-title">📋 日志</div>',
        debugLogHtml(),
        '</div>',
        // ③ 异常（只看结果，不解释实现）
        '<div class="ftt-section"><div class="ftt-sec-title">⚠ 异常捕捉 <span class="ftt-muted">共 ' + errCount + ' 条</span></div>',
        errRows,
        '</div>',
        // ④ 交互与宿主调用时间线
        '<div class="ftt-section"><div class="ftt-sec-title">🧭 交互与宿主调用时间线</div>',
        traceSectionHtml(traceFilter),
        '</div>',
        // ④a v3.13.0（用户要求「核对存在的 BUG 和数据异常」）：**数据体检**（只读零副作用）
        //   摘要一行 + 折叠明细（逐条 code / 维度 / 条目 / 字段）；自愈在载入期 `migrateState` 完成，这里只核对。
        '<div class="ftt-section"><div class="ftt-sec-title">🩺 数据体检 <span class="ftt-muted">只读</span></div>',
        (() => {
            const r = (() => { try { return dataHealthReport(); } catch (e) { return null; } })();
            if (!r) return '<div class="ftt-muted">体检不可用（读取状态失败）。</div>';
            const rows = r.findings.slice(0, 40).map((f) => '<div>' + esc(f.code) + ' · ' + esc(String(f.dim || ''))
                + (f.id ? (' · <b>' + esc(String(f.id)) + '</b>') : '') + (f.field ? (' · ' + esc(String(f.field))) : '')
                + '：' + esc(String(f.detail || '')) + '</div>').join('');
            return '<div class="ftt-muted" data-ftt-data-health>' + esc(dataHealthText(r)) + '</div>'
                + hintDetailsHtml('明细（前 40 条；自愈在载入时完成，重复 id / 超长字段 / 非法墓碑时间戳只报告不擅自改）',
                    '<div>' + (rows || '没有需要列出的明细。') + (r.truncated ? ('<div>…还有 ' + r.truncated + ' 条未列出</div>') : '') + '</div>');
        })(),
        '</div>',
        // ④b v3.0.23：读取台账（服务端 / 本地 / 内存，每一次读取的时间与统计）
        '<div class="ftt-section"><div class="ftt-sec-title">📥 读取台账 <span class="ftt-muted">服务端 / 本地 / 内存</span></div>',
        readLedgerSectionHtml(20),
        '</div>',
        // ⑤ 时钟取值追踪（时钟链路的审计视图）
        '<div class="ftt-section"><div class="ftt-sec-title">🕒 时钟取值追踪</div>',
        clockTraceSectionHtml(),
        '</div>',
        // ⑥ chatMetadata 主载体（只读差异报告；S1 只读不写）
        '<div class="ftt-section"><div class="ftt-sec-title">📎 chatMetadata 主载体（只读差异报告）</div>',
        chatMetaSectionHtml(),
        '</div>',
        // ⑦ 调试桥（v3.0.7）：跨宿主本地调试（酒馆原生 + TauriTavern）
        debugBridgeSectionHtml(),
    ].join('\n');
}

/**
 * 「🕒 时钟取值追踪」区块（v2.37.0 新增，**只读**）：
 *   回答「这个时钟值是从哪里取的、取值逻辑是什么、还有什么候选没被采用、这次到底改了什么」。
 *   数据来自 `core/clock-trace.js` 的内存环形缓冲（不落 localStorage，避免日志膨胀）。
 */
export function clockTraceSectionHtml() {
    // v2.51.0 时钟改版：「时间巡检（锚点与修复）」与「AI 捕捉正则」两块功能已移除 → 不再列出（避免废弃内容）
    const stages = [['resolve', '自动解析（只取最新情节：日期/时间/地点/在场）'], ['time-repair', 'AI 时间修复']];
    const rows = stages.map(([stage, label]) => {
        const trace = clockTraceLast(stage);
        const t = trace ? clockTraceInfo(trace) : null;
        if (!t) return '<div class="ftt-muted">' + esc(label) + '：暂无记录</div>';
        const when = new Date(Number(t.at) || 0).toLocaleString('zh-CN', { hour12: false });
        const picks = t.picks.map((p) => '<div class="ftt-dim-row"><span class="ftt-dim-name">' + esc(p.field) + '</span>'
            + '<span class="ftt-muted" style="flex:1">' + esc(String(p.value || '（无）')) + ' ← <b>' + esc(p.fromLabel || '—') + '</b>'
            + (p.why ? ('<br>' + esc(p.why)) : '') + '</span></div>').join('');
        const rejects = t.rejects.length
            ? ('<div class="ftt-muted">未采用的候选（' + t.rejects.length + '）：</div>' + t.rejects.slice(0, 6).map((r) => '<div class="ftt-dim-row"><span class="ftt-dim-name">' + esc(r.field) + '</span><span class="ftt-muted" style="flex:1">' + esc(String(r.value)) + ' ← ' + esc(r.fromLabel) + (r.raw ? (' · 原文「' + esc(r.raw) + '」') : '') + '<br>' + esc(r.why) + '</span></div>').join('') + (t.rejects.length > 6 ? '<div class="ftt-muted">…另有 ' + (t.rejects.length - 6) + ' 条</div>' : ''))
            : '<div class="ftt-muted">未采用的候选：无</div>';
        const applied = (t.applied && t.applied.fields && t.applied.fields.length)
            ? ('<div class="ftt-muted">落盘：' + (t.applied.locked ? '已锁定（未覆盖日期/时间/地点）· ' : '')
                + esc(t.applied.fields.map((x) => (x.changed ? (x.field + '：' + (x.from || '（空）') + ' → ' + (x.to || '（空））')) : (x.field + '（无改动）'))).join(' · ')) + '</div>')
            : (t.applied && t.applied.locked ? '<div class="ftt-muted">落盘：已锁定（未覆盖任何字段）</div>' : '');
        const unchanged = (t.applied && t.applied.unchanged && t.applied.unchanged.length)
            ? ('<div class="ftt-muted">保留原值：' + esc(t.applied.unchanged.slice(0, 6).join(' · ')) + '</div>') : '';
        return '<details class="ftt-dbg-item"><summary class="ftt-dbg-head"><span class="ftt-dbg-kind">' + esc(label) + '</span>'
            + '<span class="ftt-dbg-time">' + esc(when) + '</span>'
            + '<span class="ftt-dbg-sum">' + esc(clockTraceSummary(trace)) + '</span></summary>'
            + '<div class="ftt-dbg-data">'
            + '<div class="ftt-muted">取值环节（按判定顺序）：' + esc((t.chain || []).join(' → ') || '—') + '</div>'
            + (t.text && (t.text.mode || t.text.chars) ? ('<div class="ftt-muted">取文：' + esc(t.text.mode || '—') + (t.text.floors ? (' · ' + esc(t.text.floors)) : '') + ' · ' + Number(t.text.chars) + ' 字' + (t.text.sample ? ('<br>样本「' + esc(t.text.sample) + '」') : '') + '</div>') : '')
            + picks + rejects
            + (t.degrade && (t.degrade.degraded || t.degrade.detail) ? ('<div class="ftt-hint">降级：' + esc(t.degrade.reasonLabel || t.degrade.reason || '—') + (t.degrade.detail ? (' · ' + esc(t.degrade.detail)) : '') + '</div>') : '')
            + (t.notes && t.notes.length ? ('<div class="ftt-muted">备注：' + esc(t.notes.join(' ｜ ')) + '</div>') : '')
            + applied + unchanged
            + '</div></details>';
    }).join('\n');
    return '<div class="ftt-muted">取值口径：<b>值 ← 来源</b>；同时列出未采用的候选与本次落盘结果。</div>'
        + rows
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="clockTraceClear">🗑 清空时钟追踪</button>'
        + '<span class="ftt-muted">仅内存，重启即空</span></div>';
}

/**
 * 调试页动作（V1 同名：`dbgClear`）
 * @returns {{ok:boolean, action:string, note:string, cleared?:number}}
 */
export async function debugAction(action, payload) {   // v2.41.0：改为 async（导出调试包需要 await 剪贴板）
    // v3.0.7：调试桥开关 / 目标（跨宿主：酒馆原生与 TauriTavern 都能用）
    if (String(action) === 'bridgeToggle') {
        installDebugBridge();
        if (bridgeState().running) {
            const stopped = bridgeStop();
            return { ok: true, action: 'bridgeToggle', note: '已关闭调试桥', bridge: stopped };
        }
        const t = applyBridgeTargetInput();          // 开启前先采纳输入框里的目标
        const r = bridgeStart();
        if (!r.ok) return { ok: false, action: 'bridgeToggle', note: '调试桥开启失败：' + String(r.reason || '未知原因'), bridge: r.state };
        return {
            ok: true, action: 'bridgeToggle',
            note: '调试桥已开启' + (t.note ? '（' + t.note + '）' : '') + '：' + bridgeTarget() + ':' + bridgePort()
                + (isLoopbackHost(bridgeTarget()) ? '' : ' · ⚠ 目标非本机，只读面已对局域网开放'),
            bridge: r.state,
        };
    }
    // v3.0.8：保存调试目标（主机 + 端口）。`bridgePortSet` 保留为别名，避免旧页面残留按钮失效。
    if (String(action) === 'bridgeTargetSet' || String(action) === 'bridgePortSet') {
        const a = String(action);
        const t = applyBridgeTargetInput();
        if (!t.ok) return { ok: false, action: a, note: '调试目标未生效：' + t.note, bridge: bridgeState() };
        return { ok: true, action: a, note: '调试目标已设为 ' + bridgeTarget() + ':' + bridgePort() + '（仅内存，刷新后回默认）', bridge: bridgeState() };
    }
    // v2.42.0：时间线类别过滤 / 清空
    if (String(action) === 'dbgTraceFilter') {
        traceFilter = TRACE_CATS.indexOf(String(payload && payload.kind)) >= 0 ? String(payload.kind) : '';
        return { ok: true, action: 'dbgTraceFilter', filter: traceFilter, note: '时间线过滤：' + (DEBUG_CAT_LABEL[traceFilter] || '全部') };
    }
    if (String(action) === 'dbgTraceClear') {
        try { traceClear(); } catch (e) { /* 忽略 */ }
        return { ok: true, action: 'dbgTraceClear', note: '已清空交互/宿主调用时间线（含本机简报；调试日志与时钟追踪不受影响）' };
    }
    // v2.41.0：导出调试包（日志 + 运行态 → .json 文件 + 剪贴板 + 文本域）
    if (String(action) === 'dbgExport') {
        return await exportDebugBundle();
    }
    // v2.82.0：导出日志（人读文本 → .log 文件 + 剪贴板 + 文本域）
    if (String(action) === 'dbgExportLog') {
        return await exportDebugLog();
    }
    // v3.0.23：清空读取台账（只清内存缓冲，不动调试日志与时间线）
    if (String(action) === 'readLedgerClear') {
        try { resetReadLedger(); } catch (e) { /* 忽略 */ }
        return { ok: true, action: 'readLedgerClear', note: '已清空读取台账（调试日志与时间线不受影响）' };
    }
    // v2.37.0：清空时钟取值追踪（只清内存缓冲，不动调试日志）
    if (String(action) === 'clockTraceClear') {
        try { clockTraceClear(); } catch (e) { /* 忽略 */ }
        return { ok: true, action: 'clockTraceClear', note: '已清空时钟取值追踪（调试日志不受影响）' };
    }
    const a = String(action || '');
    try {
        if (a === 'dbgClear') {
            const n = debugLogClear();     // V1 `dbgClear()`：清内存 + 清宿主持久层
            return { ok: true, action: a, note: '已清空调试日志', cleared: n, stats: { n: 0, cap: DEBUG_CAP } };
        }
        return { ok: false, action: a, note: '未知调试动作：' + a };
    } catch (e) {
        return { ok: false, action: a, note: '调试动作失败：' + String((e && e.message) || e) };
    }
}

/** 调试页动作名判定（供面板分发；与 V1 同名逐字一致） */
export const DEBUG_ACTIONS = Object.freeze(['dbgClear', 'readLedgerClear', 'clockTraceClear', 'dbgExport', 'dbgExportLog', 'dbgTraceFilter', 'dbgTraceClear', 'bridgeToggle', 'bridgeTargetSet', 'bridgePortSet']);   // v3.0.23 + 读取台账清空；v2.37.0 + 时钟追踪清空；v2.41.0 + 调试包导出；v2.82.0 + 日志导出（.log）；v3.0.7 + 调试桥；v3.0.8 + 调试目标（bridgePortSet 保留为别名）

/** 读某个 `data-ftt-*` 输入框的值（无 DOM / 无输入框 / 空值 → null；**不抛**） */
function readInput(attr) {
    try {
        const doc = globalThis.document;
        const el = (doc && doc.querySelector) ? doc.querySelector('[' + attr + ']') : null;
        if (!el) return null;
        const raw = String(el.value == null ? '' : el.value).trim();
        return raw ? raw : null;
    } catch (e) { return null; }
}

/**
 * 采纳调试页输入框里的「目标主机 + 端口」。缺省（读不到输入框）则不改动任何值；
 * 非法值**沿用旧值**并在 note 里如实说明（`ok:false`）—— 不抛。
 */
function applyBridgeTargetInput() {
    const parts = [];
    let ok = true;
    const h = readInput('data-ftt-bridge-host');
    if (h !== null) {
        if (setBridgeHost(h)) parts.push('主机 ' + bridgeTarget());
        else { ok = false; parts.push('主机非法（沿用 ' + bridgeTarget() + '）'); }
    }
    const p = readInput('data-ftt-bridge-port');
    if (p !== null) {
        if (setBridgePort(Number(p))) parts.push('端口 ' + bridgePort());
        else { ok = false; parts.push('端口非法（沿用 ' + bridgePort() + '）'); }
    }
    return { ok, note: parts.join(' · ') };
}

/** 调试页只读诊断（测试/排障用） */
export function debugPageInfo() {
    let logs = [];
    try { logs = debugLogList(); } catch (e) { logs = []; }
    const kinds = {};
    logs.forEach((l) => { const k = String((l && l.kind) || ''); kinds[k] = (kinds[k] || 0) + 1; });
    return { n: logs.length, cap: DEBUG_CAP, kinds: kinds, bytes: logs.reduce((a, l) => a + String((l && l.data) || '').length, 0) };
}
