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
import { escHtml } from '../core/util.js';
// v2.37.0「时钟取值追踪」：把「值从哪来 / 为什么取它 / 还有什么没被采用」渲染成只读区块
import { clockTraceInfo, clockTraceSummary, clockTraceLast, clockTraceClear, clockSrcKeys } from '../core/clock-trace.js';
import { VERSION } from '../core/constants.js';
// v2.42.0：交互/宿主调用/命令/错误时间线（opId 关联、站点 file:line、错误上下文窗口）
import { traceList, traceStats, traceTimelineText, traceContext, traceClear, traceSiteText, TRACE_CATS } from '../core/trace.js';
import { getCtx } from '../host/st-api.js';
import { DEBUG_CAP, debugLogStats, debugLogErrors, debugLogErrorCount, debugLogLastError } from '../core/debug-log.js';
import { debugLogList, debugLogClear } from '../adapters/debug-log.js';
import { settingsControlHtml } from './settings-pages.js';

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
/** v2.42.0：时间线类别过滤（'' = 全部） */
let traceFilter = '';
/** 宿主注入的额外诊断（`dump`：一键诊断快照；`meta`：环境信息）；默认 no-op */
const debugHooks = { dump: () => null, meta: () => ({}) };
export function setDebugHooks(next) { Object.assign(debugHooks, next || {}); return debugHooks; }
/** 最近一次导出的调试包（诊断/测试） */
export function debugExportState() { return { chars: lastDebugExport.length, text: lastDebugExport }; }

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
        traceStats: traceStats(),
        trace: traceList({ limit: 300 }),
        timeline: traceTimelineText(300),
    };
}

/**
 * 导出动作（面板 `dbgExport`）：组装调试包 → 尽力复制到剪贴板 → 文本落进 `lastDebugExport` 供页面文本域手动复制。
 * @returns {Promise<{ok:boolean, action:string, chars:number, copied:boolean, note:string}>}
 */
export async function exportDebugBundle() {
    let text = '';
    try { text = JSON.stringify(buildDebugExport(), null, 1); } catch (e) { text = ''; }
    if (!text) return { ok: false, action: 'dbgExport', chars: 0, copied: false, note: '调试日志导出失败（序列化异常）' };
    lastDebugExport = text;
    let copied = false;
    try {
        const nav = globalThis.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); copied = true; }
    } catch (e) { copied = false; }
    return { ok: true, action: 'dbgExport', chars: text.length, copied, note: '已导出调试包 ' + text.length + ' 字符' + (copied ? '（已复制到剪贴板）' : '（见下方文本框，可手动复制）') };
}

/** 调试包导出区（按钮 + 文本域；空态只出按钮与说明） */
export function debugExportSectionHtml() {
    const rows = [
        '<div class="ftt-muted">导出内容：版本 / 时间 / 作用域 / 宿主环境与能力探针 + 一键诊断快照（运行态、探针缺失项）'
        + ' + <b>全部调试日志</b>（含「异常」类：未处理的 Promise 拒绝、脚本错误、面板动作失败）。'
        + '调试包**不含记忆正文**，可直接贴给维护者排查。</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="dbgExport" title="导出调试包（日志 + 运行态）到剪贴板与下方文本框">⬇ 导出调试日志</button>'
        + '<span class="ftt-muted">共 ' + debugLogList().length + ' 条日志 · 异常 ' + debugLogErrorCount() + ' 条</span></div>',
    ];
    if (lastDebugExport) {
        rows.push('<div class="ftt-field ftt-field-col"><label>调试包（可复制）</label><textarea data-ftt-debugexport="1" rows="8">' + esc(lastDebugExport) + '</textarea></div>');
    }
    return rows.join('\n');
}

/** 日志列表 HTML（V1 `debugHtml()` 逐字结构：操作行 + 类别统计行 + 逐条 `<details class="ftt-dbg-item">`） */
export function debugLogHtml() {
    const logs = debugLogList();
    if (!logs.length) return '<div class="ftt-empty">暂无日志。运行「AI 摘要」或「自动修复」后在此显示。</div>';
    // 日志统计（各 kind 计数；顺序 = 首次出现顺序，V1 原样）
    const statCount = {};
    for (const l of logs) statCount[l.kind] = (statCount[l.kind] || 0) + 1;
    const statHtml = Object.keys(statCount).map((k) => '<span class="ftt-stat">' + esc(DEBUG_KIND_LABEL[k] || k) + ' ' + statCount[k] + '</span>').join('');
    // 每条日志大小 + 总占用
    let totalBytes = 0;
    for (const l of logs) { try { totalBytes += (l.data || '').length; } catch (e) { /* 忽略 */ } }
    const sizeNote = ' · 总占用 ' + formatBytes(totalBytes);
    return '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="dbgClear">🗑 清空日志</button><span class="ftt-muted">共 ' + logs.length + ' 条' + sizeNote + '（最多 ' + DEBUG_CAP + ' 条，最新在上；点击展开详情）</span></div><div class="ftt-row">' + statHtml + '</div>' + logs.map((l) => {
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
        '<div class="ftt-muted">会话 ' + esc(st.session) + ' · 事件 ' + st.total + '（上限 ' + st.cap + '）· 级别 ' + esc(st.level)
        + ' · 记录：用户交互（点击/变更/切页）· 宿主 API 调用 · 命令与 FTT 入口 · 落盘/注入 · AI 调用 · 异常（含上下文窗口）</div>',
        (rows.length ? rows.map(line).join('\n') : '<div class="ftt-empty">暂无事件。任一交互/命令后在此显示（含点击了哪个按钮、调了哪些宿主 API、结果与代码位置）。</div>'),
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="dbgTraceClear">🗑 清空时间线</button>'
        + '<button class="ftt-btn" data-ftt-action="dbgExport">⬇ 导出调试包（含完整时间线）</button>'
        + '<span class="ftt-muted">时间线为纯内存环形缓冲；导出包可直接贴给维护者</span></div>',
    ].join('\n');
}

/**
 * 调试页正文（V1 `activeSettingsSub === 'debug'` 分支逐字两节）。
 * @param {Array} controls `SETTINGS_CONTROLS.debug`（本页唯一控件 `debugEnabled`）
 */
export function debugPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const sw = list.filter((c) => String(c.key) === 'debugEnabled').map((c) => settingsControlHtml(c)).join('\n');
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">调试日志</div>',
        sw,
        '<div class="ftt-muted">关闭后不再记录新日志；已存日志仍可查看。</div>',
        '</div>',
                // v2.34.0：异常捕捉只读区（全局 error / unhandledrejection / 面板动作失败 → 内核调试日志 kind='异常'）
        '<div class="ftt-section"><div class="ftt-sec-title">⚠ 异常捕捉 <span class="ftt-muted">共 ' + debugLogErrorCount() + ' 条（host 全局 error / unhandledrejection + 面板动作失败）</span></div>',
        (() => {
            const last = debugLogLastError();
            if (!last) return '<div class="ftt-muted">暂无异常记录（未捕获错误会自动写入本页与调试日志）</div>';
            const d = (() => { try { return JSON.parse(last.data); } catch (e) { return { message: String(last.data || '') }; } })();
            return '<div class="ftt-hint">最近一条 · ' + esc(String(new Date(Number(last.at) || 0).toLocaleString('zh-CN', { hour12: false }))) + '<br>'
                + esc(String(d.kind || '异常')) + '：' + esc(String(d.message || '')).slice(0, 300)
                + (d.source ? ('<br><span class="ftt-muted">' + esc(String(d.source)) + (d.line ? (':' + Number(d.line) + (d.col ? (':' + Number(d.col)) : '')) : '') + '</span>') : '')
                + '</div>';
        })(),
        '<div class="ftt-row"><span class="ftt-muted">最近 3 条：' + esc(debugLogErrors(3).map((l) => { const d = (() => { try { return JSON.parse(l.data); } catch (e) { return {}; } })(); return String(d.message || l.data || '').slice(0, 60); }).join(' ｜ ')) + '</span></div>',
// v2.37.0：时钟取值追踪（只读）—— 「值从哪来 / 为什么取它 / 有什么没被采用 / 这次改了什么」
        '<div class="ftt-section"><div class="ftt-sec-title">🕒 时钟取值追踪 <span class="ftt-muted">（日志口径：值 ← 来源；含落选候选与落盘差异）</span></div>',
        clockTraceSectionHtml(),
        '</div>',
        '<div class="ftt-section"><div class="ftt-sec-title">调试日志（上一轮请求的关键词 / 向量提取 / 发送记忆 / 请求日志）</div>',
        debugLogHtml(),
        '</div>',
        // v2.42.0：交互与宿主调用时间线
        '<div class="ftt-section"><div class="ftt-sec-title">🧭 交互与宿主调用时间线 <span class="ftt-muted">（点击 → opId → 底层调用 → 结果 → 代码位置）</span></div>',
        traceSectionHtml(traceFilter),
        '</div>',
        // v2.41.0：调试包导出（用户要求）
        '<div class="ftt-section"><div class="ftt-sec-title">📦 导出调试包 <span class="ftt-muted">（日志 + 运行态，不含记忆正文）</span></div>',
        debugExportSectionHtml(),
        '</div>',
    ].join('\n');
}

/**
 * 「🕒 时钟取值追踪」区块（v2.37.0 新增，**只读**）：
 *   回答「这个时钟值是从哪里取的、取值逻辑是什么、还有什么候选没被采用、这次到底改了什么」。
 *   数据来自 `core/clock-trace.js` 的内存环形缓冲（不落 localStorage，避免日志膨胀）。
 */
export function clockTraceSectionHtml() {
    const stages = [['resolve', '自动解析（日期/时间/地点/在场）'], ['patrol', '时间巡检（锚点与修复）'], ['regex-ai', 'AI 捕捉正则'], ['time-repair', 'AI 时间修复']];
    const rows = stages.map(([stage, label]) => {
        const trace = clockTraceLast(stage);
        const t = trace ? clockTraceInfo(trace) : null;
        if (!t) return '<div class="ftt-muted">' + esc(label) + '：暂无记录（运行一次对应操作后在此显示）</div>';
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
    return '<div class="ftt-muted">字段含义：<b>值 ← 来源</b>（来源中文名取自 <code>core/clock-trace.js</code> 的全量登记表，共 ' + clockSrcKeys().length + ' 项）；「未采用的候选」给出放弃原因；「落盘」给出本次实际改动。</div>'
        + rows
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="clockTraceClear">🗑 清空时钟追踪</button>'
        + '<span class="ftt-muted">仅内存（重启即空）；排障时先跑一次提取/巡检再回本页查看</span></div>';
}

/**
 * 调试页动作（V1 同名：`dbgClear`）
 * @returns {{ok:boolean, action:string, note:string, cleared?:number}}
 */
export async function debugAction(action, payload) {   // v2.41.0：改为 async（导出调试包需要 await 剪贴板）
    // v2.42.0：时间线类别过滤 / 清空
    if (String(action) === 'dbgTraceFilter') {
        traceFilter = TRACE_CATS.indexOf(String(payload && payload.kind)) >= 0 ? String(payload.kind) : '';
        return { ok: true, action: 'dbgTraceFilter', filter: traceFilter, note: '时间线过滤：' + (DEBUG_CAT_LABEL[traceFilter] || '全部') };
    }
    if (String(action) === 'dbgTraceClear') {
        try { traceClear(); } catch (e) { /* 忽略 */ }
        return { ok: true, action: 'dbgTraceClear', note: '已清空交互/宿主调用时间线（调试日志与时钟追踪不受影响）' };
    }
    // v2.41.0：导出调试包（日志 + 运行态 → 剪贴板 + 文本域）
    if (String(action) === 'dbgExport') {
        return await exportDebugBundle();
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
export const DEBUG_ACTIONS = Object.freeze(['dbgClear', 'clockTraceClear', 'dbgExport', 'dbgTraceFilter', 'dbgTraceClear']);   // v2.37.0 + 时钟追踪清空；v2.41.0 + 调试包导出

/** 调试页只读诊断（测试/排障用） */
export function debugPageInfo() {
    let logs = [];
    try { logs = debugLogList(); } catch (e) { logs = []; }
    const kinds = {};
    logs.forEach((l) => { const k = String((l && l.kind) || ''); kinds[k] = (kinds[k] || 0) + 1; });
    return { n: logs.length, cap: DEBUG_CAP, kinds: kinds, bytes: logs.reduce((a, l) => a + String((l && l.data) || '').length, 0) };
}
