// ============================================================
// core/trace.js —— **交互 / 宿主调用 / 错误的统一追踪**（v2.42.0，纯内核）
//
// 设计目标（用户要求）：「调试日志应该捕捉用户交互、插件交互的**所有日志**；当前是业务日志，无法追溯底层关系；
//   而且只有异常错误、没有上下文，无法追溯具体错误的代码位置。」
//
// 因此本模块提供**三层可追溯事件流**（与 V1 的业务日志 `core/debug-log.js` 并存、互不替代）：
//   ① `ui`     —— 用户交互：点击 / 变更 / 开关 / 切页 / 搜索（自动带上当前 tab·sub 与**处理器结果**）；
//   ② `host`   —— 插件↔宿主交互：所有经 `getCtx()` 的宿主 API 调用（方法名 / 参数摘要 / 返回摘要 / 耗时 / 失败原因）；
//   ③ `cmd`    —— 命令与调试入口：`/ftt*` 命令、宏、`FTT.*` 入口调用；
//   另加 `kernel`（落盘/载入/注入）、`ai`（AI 调用）、`error`（异常，自动附**上下文窗口**）。
//
// 三条关键约定（缺一不可，否则"追不到代码位置"）：
//   A. **关联 id（opId）**：每次交互/命令/入口调用开一个 op（`traceOpStart`），其执行期间发生的 host/kernel/ai
//      事件**自动带上该 opId**（内部 op 栈）；错误同样带上 —— 于是「谁触发的这次宿主调用/这次报错」可回溯。
//   B. **站点（site）**：每条事件从 `new Error().stack` 解析出**本仓库内第一帧**（`file:line:col` + 函数名），
//      过滤掉本模块自身帧 → 直接给出「具体代码位置」。
//   C. **上下文窗口**：错误事件附带错误前后各 `TRACE_CONTEXT_SPAN` 条事件（按 opId 聚合），不再只有一条孤立异常。
//
// 其它硬约定：
//   · **分级**：`error < warn < info < debug < trace`；低于当前级别的事件直接丢弃（零成本早退）。
//   · **脱敏**：键名含 key/password/secret/token/authorization → `***`；`sk-*` 值 → `sk-***`；
//     长文本字段（prompt/content/text/messages）只记**长度**，除非开 `verbose`。
//   · **体积**：单条 ≤ `TRACE_ITEM_MAX`；分类环形上限 + 总量上限（内存恒定，不随会话增长）。
//   · **节流**：同类别同 kind 同摘要的事件在 `TRACE_DEDUPE_MS` 内合并为 `×N`。
//   · **不影响主流程**：全部 try/catch；任何失败都不得抛到调用方（`traceEvent` 永不抛）。
// ============================================================
import { cfg } from './model/runtime.js';

/** 事件级别（数值越小越严重） */
export const TRACE_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
/** 分类（与「调试页时间线」的分组一致） */
export const TRACE_CATS = ['ui', 'host', 'cmd', 'kernel', 'ai', 'error'];
/** 单条事件序列化上限 */
export const TRACE_ITEM_MAX = 2000;
/** 分类环形上限 */
export const TRACE_CAT_CAP = { ui: 200, host: 300, cmd: 100, kernel: 100, ai: 100, error: 100 };
/** 总量上限（跨分类） */
export const TRACE_TOTAL_CAP = 800;
/** 错误上下文窗口（前后各 N 条） */
export const TRACE_CONTEXT_SPAN = 20;
/** 同类同摘要去重窗口（毫秒） */
export const TRACE_DEDUPE_MS = 800;

const str = (v) => String(v == null ? '' : v);
const clip = (v, n) => { const s = str(v); return s.length > n ? (s.slice(0, n) + '…') : s; };

/** 会话 id（加载期唯一，短） */
const SESSION_ID = (() => {
    try { return 'S' + Math.floor(Date.now() % 1e7).toString(36) + Math.floor(Math.random() * 1296).toString(36); } catch (e) { return 'S0'; }
})();
let seq = 0;
/** 事件缓冲（**最新在前**），以及按 id 的索引用于上下文窗口 */
let events = [];
/** op 栈：opId / 名称 / 起始时间 / 父 op */
let opStack = [];
let opSeq = 0;
/** 去重表：key → { at, n, ref } */
const dedupe = new Map();
/** 可选：宿主注入的持久化钩子（内核保持纯净） */
let hooks = { save: () => undefined };

export function setTraceHooks(next) { hooks = Object.assign({ save: () => undefined }, hooks, next || {}); return hooks; }
export function traceSessionId() { return SESSION_ID; }

/** 当前级别阈值（`cfg.debugLevel`；缺省 `debug`） */
function levelThreshold() {
    try {
        const l = String((cfg && cfg.debugLevel) || 'debug');
        return (TRACE_LEVELS[l] === undefined) ? TRACE_LEVELS.debug : TRACE_LEVELS[l];
    } catch (e) { return TRACE_LEVELS.debug; }
}
/** 总开关（沿用 V1 `cfg.debugEnabled`） */
function enabled() { try { return !(cfg && cfg.debugEnabled === false); } catch (e) { return true; } }

/** 从错误对象解析**本仓库内第一帧**（file:line:col + 函数名）——「具体代码位置」 */
export function traceSite(stack, skipExtra) {
    try {
        const s = str(stack || (new Error()).stack);
        const skip = ['core/trace.js'].concat(Array.isArray(skipExtra) ? skipExtra : []);
        const lines = s.split('\n');
        for (const raw of lines) {
            // 逐行解析栈帧；两种形态都要吃下（此前 URL 形态会被切错文件）：
            //   ① `at fn (file:line:col)`  ② `at file:line:col`（Node/浏览器在无函数名时省掉括号）
            let ln = str(raw).trim();
            if (ln.indexOf('at ') === 0) ln = ln.slice(3).trim();
            ln = ln.replace(/^(?:async|new|await)\s+/g, '').trim();
            if (!ln || ln.indexOf('eval at ') === 0) continue;
            let file = '', fn = '', lineNo = 0, colNo = 0;
            const withFn = /^(.*?)\s*\((.+):(\d+):(\d+)\)$/.exec(ln);
            const bare = withFn ? null : /^(.+):(\d+):(\d+)$/.exec(ln);
            if (withFn) { fn = str(withFn[1]).trim(); file = str(withFn[2]); lineNo = Number(withFn[3]) || 0; colNo = Number(withFn[4]) || 0; }
            else if (bare) { file = str(bare[1]).trim(); lineNo = Number(bare[2]) || 0; colNo = Number(bare[3]) || 0; }
            else continue;
            file = file.replace(/^file:\/\//, '');                       // 去掉 Node 的 file:// 前缀，便于取短路径
            file = file.split('?')[0];                                   // 去掉 `?t=…` 之类的缓存串
            if (!/\.(?:js|mjs|cjs)$/.test(file)) continue;               // 只看本仓库脚本帧（跳过 node:internal 等）
            if (skip.some((x) => file.indexOf(x) >= 0)) continue;        // 过滤本模块与包装层自身帧
            const short = file.split('/').slice(-2).join('/');           // core/xxx.js / ui/panel.js
            return { file: short, line: lineNo, col: colNo, fn: fn || '' };
        }
    } catch (e) { /* 忽略 */ }
    return { file: '', line: 0, col: 0, fn: '' };
}
/** 站点 → `file:line` 文本 */
export function traceSiteText(site) {
    const s = site || {};
    return s.file ? (s.file + ':' + (Number(s.line) || 0) + (s.fn ? (':' + s.fn) : '')) : '';
}

/** 脱敏 + 摘要（**不深拷贝**；长文本只记长度） */
export function traceSummarize(v, depth) {
    const d = Number(depth) || 0;
    try {
        if (v === null || v === undefined) return v === null ? null : '';
        const t = typeof v;
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[fn]';
        if (t === 'string') {
            const s = v;
            if (/^sk-|^Bearer\s/i.test(s)) return 'sk-***';
            return (s.length > 160 && !(cfg && cfg.debugTraceVerbose === true)) ? ('[str ' + s.length + ' 字] ' + clip(s, 60)) : clip(s, 200);
        }
        if (Array.isArray(v)) {
            if (d >= 2) return '[Array ' + v.length + ']';
            return v.slice(0, 8).map((x) => traceSummarize(x, d + 1)).concat(v.length > 8 ? ['…+' + (v.length - 8)] : []);
        }
        if (t === 'object') {
            if (d >= 2) return '[Object]';
            const out = {};
            let n = 0;
            for (const k of Object.keys(v)) {
                if (n >= 12) { out['…'] = '+' + (Object.keys(v).length - 12); break; }
                n += 1;
                if (/key|password|secret|token|authorization/i.test(k)) { out[k] = '***'; continue; }
                if (/^(prompt|content|text|messages|body|data)$/i.test(k)) {
                    const raw = v[k];
                    const len = (typeof raw === 'string') ? raw.length : (Array.isArray(raw) ? raw.length + ' 项' : '');
                    out[k] = '[省略 ' + len + ']';
                    continue;
                }
                out[k] = traceSummarize(v[k], d + 1);
            }
            return out;
        }
        return String(v);
    } catch (e) { return '[unloggable]'; }
}

/** 当前 op 上下文（供事件自动关联）；无 op 时返回空 */
export function traceCurrentOp() {
    const top = opStack[opStack.length - 1];
    return top ? { opId: top.opId, op: top.name } : { opId: '', op: '' };
}

/** 开启一个 op（返回 {opId, name, t0}）；配合 `traceOpEnd` 使用（异常也必须 end） */
export function traceOpStart(name, extra) {
    try {
        opSeq += 1;
        const parent = opStack[opStack.length - 1];
        const op = {
            opId: 'op' + opSeq, name: str(name), t0: Date.now(),
            parentId: parent ? parent.opId : '', extra: traceSummarize(extra || {}, 0),
        };
        opStack.push(op);
        if (opStack.length > 32) opStack = opStack.slice(-32);   // 防泄漏（嵌套异常未闭合）
        return op;
    } catch (e) { return { opId: '', name: str(name), t0: Date.now(), parentId: '', extra: {} }; }
}
/** 关闭 op（记录耗时与结果摘要，产出一条 `ui`/`cmd` 的完成事件由调用方决定） */
export function traceOpEnd(op, result) {
    try {
        if (!op) return null;
        const i = opStack.lastIndexOf(op);
        if (i >= 0) opStack.splice(i, 1);
        const ms = Date.now() - op.t0;
        const r = result || {};
        return { opId: op.opId, name: op.name, ms, ok: r.ok !== false, reason: str(r.reason), note: clip(r.note, 120) };
    } catch (e) { return null; }
}

/**
 * 记录一条事件（**唯一入口**；永不抛）。
 * @param {{cat:string, kind:string, level?:string, opId?:string, op?:string, detail?:object,
 *          ok?:boolean, reason?:string, ms?:number, site?:object, stack?:string, dedupeKey?:string}} ev
 * @returns {{id:string}|null} 记录到的条目（被级别/去重丢弃时为 null）
 */
export function traceEvent(ev) {
    try {
        if (!enabled()) return null;
        const e = ev || {};
        const cat = TRACE_CATS.indexOf(str(e.cat)) >= 0 ? str(e.cat) : 'kernel';
        const lvlName = str(e.level) || (str(e.kind).indexOf('异常') >= 0 || e.ok === false ? 'warn' : 'debug');
        if (TRACE_LEVELS[lvlName] > levelThreshold()) return null;
        // 分类开关（调试页可关：UI 交互 / 宿主调用）
        if (cat === 'ui' && cfg && cfg.debugTraceUi === false) return null;
        if (cat === 'host' && cfg && cfg.debugTraceHost === false) return null;
        // 去重（同 key 在窗口内合并为 ×N）
        const dk = str(e.dedupeKey) || (cat + '|' + str(e.kind) + '|' + clip(JSON.stringify(traceSummarize(e.detail || {}, 0)), 120));
        const prev = dedupe.get(dk);
        const now = Date.now();
        if (prev && (now - prev.at) < TRACE_DEDUPE_MS && prev.ref) {
            prev.n += 1; prev.at = now;
            prev.ref.n = prev.n;
            prev.ref.at = now;
            return prev.ref;
        }
        seq += 1;
        const site = e.site || (e.stack ? traceSite(e.stack) : null);
        const cur = traceCurrentOp();
        const rec = {
            id: 'e' + seq,
            at: now,
            cat,
            kind: str(e.kind),
            level: lvlName,
            ok: e.ok !== false,
            reason: clip(e.reason, 160),
            ms: Number(e.ms) || 0,
            opId: str(e.opId) || (e.opId === '' ? '' : cur.opId),
            op: str(e.op) || cur.op,
            detail: traceSummarize(e.detail || {}, 0),
            site: site || traceSite(),
            n: 1,
        };
        try {
            const json = JSON.stringify({ detail: rec.detail, reason: rec.reason });
            if (json && json.length > TRACE_ITEM_MAX) rec.detail = { note: '[截断]' };
        } catch (err) { rec.detail = {}; }
        events.unshift(rec);
        const cap = TRACE_CAT_CAP[cat] || 100;
        let count = 0;
        const keep = [];
        for (const x of events) {
            if (x.cat === cat) { count += 1; if (count > cap) continue; }
            keep.push(x);
        }
        events = keep.slice(0, TRACE_TOTAL_CAP);
        dedupe.set(dk, { at: now, n: 1, ref: rec });
        if (dedupe.size > 400) { for (const k of dedupe.keys()) { dedupe.delete(k); if (dedupe.size <= 300) break; } }
        try { hooks.save(events.slice(0, 120).map((x) => ({ id: x.id, at: x.at, cat: x.cat, kind: x.kind, ok: x.ok, opId: x.opId, site: traceSiteText(x.site) }))); } catch (e2) { /* 落盘失败不影响主流程 */ }
        return rec;
    } catch (e) { return null; }
}

/** 列表（最新在前；可按类别/opId 过滤） */
export function traceList(opts) {
    const o = opts || {};
    let out = events;
    if (o.cat) out = out.filter((x) => x.cat === str(o.cat));
    if (o.opId) out = out.filter((x) => x.opId === str(o.opId));
    const n = Number(o.limit);
    return (Number.isFinite(n) && n > 0) ? out.slice(0, n) : out.slice();
}

/** 统计（分类计数 / 级别计数 / 总量 / 会话） */
export function traceStats() {
    const cats = {}, levels = {};
    for (const x of events) { cats[x.cat] = (cats[x.cat] || 0) + 1; levels[x.level] = (levels[x.level] || 0) + 1; }
    return { session: SESSION_ID, seq, total: events.length, cats, levels, cap: TRACE_TOTAL_CAP, level: Object.keys(TRACE_LEVELS).filter((k) => TRACE_LEVELS[k] === levelThreshold())[0] || 'debug' };
}

/**
 * 错误上下文窗口：取该错误前后各 `TRACE_CONTEXT_SPAN` 条事件（按时间序，聚合其 opId 相关的全部事件）。
 * 这是「只有异常、没有上下文」的直接解药。
 */
export function traceContext(recOrId, span) {
    try {
        const id = (recOrId && recOrId.id) ? recOrId.id : str(recOrId);
        const idx = events.findIndex((x) => x.id === id);
        const n = Number(span) > 0 ? Number(span) : TRACE_CONTEXT_SPAN;
        const center = idx >= 0 ? idx : 0;
        const win = events.slice(Math.max(0, center - n), center + n + 1);
        const x0 = events[center] || null;
        const opId = x0 ? x0.opId : '';
        const related = opId ? events.filter((x) => x.opId === opId && !win.some((y) => y.id === x.id)) : [];
        return {
            error: x0 ? { id: x0.id, at: x0.at, kind: x0.kind, reason: x0.reason, site: traceSiteText(x0.site), opId: x0.opId, detail: x0.detail } : null,
            opId,
            window: win.map(traceBrief).reverse(),
            related: related.map(traceBrief).reverse(),
        };
    } catch (e) { return { error: null, opId: '', window: [], related: [] }; }
}

/** 单条事件的短摘要（视图/导出共用） */
export function traceBrief(x) {
    const e = x || {};
    return {
        id: e.id, at: e.at, cat: e.cat, kind: e.kind, level: e.level, ok: e.ok,
        ms: e.ms, opId: e.opId, op: e.op, site: traceSiteText(e.site), reason: e.reason, n: e.n,
        detail: e.detail,
    };
}

/**
 * **人读时间线文本**（导出与「贴给维护者」用）：按时间正序，逐行
 *   `12:34:56.789 host  generateRaw  ok 120ms  op3@ui/panel.js:1234  {…}`
 * 错误行上方标注其上下文窗口。
 */
export function traceTimelineText(limit) {
    try {
        const n = Number(limit) > 0 ? Number(limit) : 200;
        const rows = events.slice(0, n).slice().reverse();
        const pad2 = (x) => String(x).padStart(2, '0');
        return rows.map((x) => {
            const d = new Date(x.at);
            const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            const detail = (() => { try { const s = JSON.stringify(x.detail); return (s === '{}' || s === 'null') ? '' : clip(s, 220); } catch (e) { return ''; } })();
            const flag = (x.cat === 'error') ? '❌ ' : (x.ok === false ? '⚠️ ' : '');
            return [t, flag + x.cat, x.kind, x.ok === false ? ('失败:' + x.reason) : 'ok', x.ms ? (x.ms + 'ms') : '', x.opId ? (x.opId + (x.op ? ('(' + x.op + ')') : '')) : '', traceSiteText(x.site), detail].filter(Boolean).join('  ');
        }).join('\n');
    } catch (e) { return ''; }
}

/**
 * 清空（调试页/测试）。
 * v2.54.0：清内存的同时把**本机持久简报**也置空（`hooks.save([])`）—— 否则「调试页显示 0 条、
 *   数据管理的本地缓冲仍显示 N 条」这种不一致会一直存在（用户报告要求核对内容一致性）。
 */
export function traceClear() {
    try {
        events = []; dedupe.clear(); opStack = [];
        try { hooks.save([]); } catch (e2) { /* 落盘失败不影响清空 */ }
        return true;
    } catch (e) { return false; }
}
