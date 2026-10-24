import { debugLogPush } from '../adapters/debug-log.js';
// ============================================================
// host/events.js —— 酒馆事件绑定（对齐 V1 九事件；解绑干净）
// ============================================================
import { HOST_EVENTS } from '../core/constants.js';
import { getCtx } from './st-api.js';
import { crossAutoPull } from '../adapters/sync.js';   // v3.50.32：回到前台自动对账（只并集合并；见文件末尾绑定）

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

// ============================================================
// v2.34.0：**全局异常捕捉**（强化调试）—— 把宿主里未捕获的错误与 Promise 拒绝写进内核调试日志
//   V1 无此能力（V1 只在各处 try/catch + dbgLog）；V2 增加统一兜底，便于在「设定 → 调试」页事后挖掘潜在错误。
//   口径：
//     ① `window.addEventListener('error')`：脚本错误（含资源？只取 message/source/lineno/colno/error.stack）
//     ② `window.addEventListener('unhandledrejection')`：未处理的 Promise 拒绝（reason 归一为字符串/JSON）
//     ③ 归一：**单条截断 2000 字**、同类同址 1 秒内**去重**（防抖避免刷屏）、写入 `kind='异常'`；
//     ④ 幂等安装（`__fttErrBound`）+ `uninstallErrorCapture()` 供 teardown 解绑（事件解绑失败也不抛）。
// ============================================================
// v2.42.0：异常入流 + **上下文窗口**（用户报告「只有异常错误、没有上下文，无法追溯具体代码位置」）——
//   每条异常同时进 trace（cat='error'，带站点与 opId），并把「错误前后各 N 条事件」快照写进调试日志条目，
//   于是调试页/导出包能直接看到「出错前用户点了什么、调了哪些宿主 API」。
import { traceEvent, traceSite, traceContext, traceCurrentOp } from '../core/trace.js';

const ERR_KIND = '异常';
const ERR_MAX = 2000;
let errBound = false;
let errLastKey = '';
let errLastAt = 0;

function errText(v) {
    try {
        if (v == null) return '';
        if (typeof v === 'string') return v.slice(0, ERR_MAX);
        if (v instanceof Error) return String(v.stack || v.message || v).slice(0, ERR_MAX);
        const j = JSON.stringify(v);
        return String(j === undefined ? v : j).slice(0, ERR_MAX);
    } catch (e) { return ''; }
}

function errPush(payload) {
    try {
        const key = String((payload && payload.kind) || '') + '|' + String((payload && payload.message) || '') + '|' + String((payload && payload.source) || '');
        const now = Date.now();
        if (key === errLastKey && (now - errLastAt) < 1000) return false;      // 1s 内同类同址去重
        errLastKey = key; errLastAt = now;
        // ① 进 trace（cat='error'）：站点从栈里解析出**本仓库内的代码位置**；opId 关联到触发的交互/命令
        let rec = null;
        try {
            rec = traceEvent({
                cat: 'error', kind: String((payload && payload.kind) || '异常'), level: 'error', ok: false,
                reason: String((payload && payload.message) || ''), stack: String((payload && payload.stack) || ''),
                detail: { source: String((payload && payload.source) || ''), line: Number(payload && payload.line) || 0, col: Number(payload && payload.col) || 0 },
            });
        } catch (e2) { /* 追踪失败不影响异常记录 */ }
        // ② 附带上下文窗口（错误前后各 20 条 + 同 opId 的全部事件）
        try {
            const ctx = traceContext(rec && rec.id, 20);
            const cur = traceCurrentOp();
            const enriched = Object.assign({}, payload, {
                traceId: (rec && rec.id) || '',
                site: traceSiteTextOf(payload && payload.stack),
                opId: (rec && rec.opId) || cur.opId || '',
                op: cur.op || '',
                context: { window: (ctx.window || []).slice(-20), related: (ctx.related || []).slice(-10) },
                how: '上下文见调试页「🧭 交互与宿主调用时间线」；导出调试包含完整时间线',
            });
            return debugLogPush(ERR_KIND, enriched);
        } catch (e3) { return debugLogPush(ERR_KIND, payload); }
    } catch (e) { return false; }
}

/** 站点文本（供调试日志条目显示 file:line） */
function traceSiteTextOf(stack) {
    try {
        const site = traceSite(stack, ['host/events.js']);
        return site && site.file ? (site.file + ':' + site.line) : '';
    } catch (e) { return ''; }
}

function onWindowError(evt) {
    try {
        const e = evt || {};
        const err = e.error || null;
        errPush({
            kind: '脚本错误',
            message: String(e.message || (err && err.message) || '').slice(0, ERR_MAX),
            source: String(e.filename || e.source || '').slice(0, 400),
            line: Number(e.lineno || e.line || 0) || 0,
            col: Number(e.colno || e.col || 0) || 0,
            stack: errText(err && err.stack ? err.stack : (e.error || '')),
        });
    } catch (e) { /* 钩子自身绝不抛 */ }
}

function onUnhandledRejection(evt) {
    try {
        const e = evt || {};
        const reason = e.reason !== undefined ? e.reason : e.detail;
        errPush({
            kind: '未处理的 Promise 拒绝',
            message: errText(reason && reason.message ? reason.message : reason),
            source: 'unhandledrejection',
            line: 0, col: 0,
            stack: errText(reason && reason.stack ? reason.stack : reason),
        });
    } catch (e) { /* 忽略 */ }
}

/** 安装异常捕捉（幂等；无 `window.addEventListener` 的环境返回 false，如 Node 测试） */
export function installErrorCapture() {
    try {
        const w = globalThis.window;
        if (!w || typeof w.addEventListener !== 'function') return false;
        if (errBound) return true;
        w.addEventListener('error', onWindowError);
        w.addEventListener('unhandledrejection', onUnhandledRejection);
        errBound = true;
        return true;
    } catch (e) { return false; }
}

/** 解绑异常捕捉（teardown；幂等） */
export function uninstallErrorCapture() {
    try {
        const w = globalThis.window;
        if (w && typeof w.removeEventListener === 'function' && errBound) {
            w.removeEventListener('error', onWindowError);
            w.removeEventListener('unhandledrejection', onUnhandledRejection);
        }
    } catch (e) { /* 忽略 */ }
    errBound = false;
    errLastKey = ''; errLastAt = 0;
    return true;
}

/** 异常捕捉是否已安装（诊断） */
export function errorCaptureState() { return { installed: errBound }; }

// ============================================================
// v3.50.32（用户报告「货币跨端不同步金额、记录」）：**页面回到前台 → 自动对账**
//
// 为什么需要（代码取证）：会话内远端主文件 / 清单**整个会话只读一次**（`adapters/sync.js#filesReadContentCached`
//   无 TTL），自动路径又不绕开缓存；而唯一的自动拉取（保存后镜像）在**写完之后**才跑 ——
//   于是「另一端刚记的货币金额 / 流水」既读不到、还会被本端旧内存整份覆盖。
// 口径：只做**并集合并**（`adapters/sync.js#crossAutoPull` → `applyRemoteMergeToState`，不整体替换、
//   不写备份、不写快照），有变化才落盘；开关 `storage.crossPullOnVisible`（默认开）关闭即不动作；
//   失败静默，绝不阻塞界面。回调 `onMerged` 由调用方注入（界面层用它刷新面板，宿主层不依赖 ui）。
// ============================================================
let autoPullBound = false;
let autoPullOff = null;
let autoPullHook = null;
/**
 * 绑定「回到前台自动对账」（幂等；无 `document` 的环境返回 false，如 Node 测试）。
 * @param {{onMerged?:Function}} [hooks] `onMerged(report)` = 合并有变化时回调（界面重绘用）
 */
export function bindAutoPullVisible(hooks) {
    try {
        autoPullHook = (hooks && typeof hooks.onMerged === 'function') ? hooks.onMerged : null;
        if (autoPullBound) return true;
        const doc = globalThis.document;
        if (!doc || typeof doc.addEventListener !== 'function') return false;
        const onVis = () => {
            try {
                if (doc.visibilityState !== 'visible') return;
                let p = null;
                try { p = crossAutoPull('visible', { from: 'visibility' }); } catch (e) { p = null; }
                if (!p || typeof p.then !== 'function') return;
                void p.then((rep) => {
                    try { if (rep && rep.changed && autoPullHook) autoPullHook(rep); } catch (e) { /* 忽略：回调失败不影响同步 */ }
                }).catch(() => { /* 忽略：自动对账失败不影响界面 */ });
            } catch (e) { /* 忽略 */ }
        };
        doc.addEventListener('visibilitychange', onVis);
        autoPullOff = () => { try { doc.removeEventListener('visibilitychange', onVis); } catch (e) { /* noop */ } };
        autoPullBound = true;
        return true;
    } catch (e) { return false; }
}
/** 解绑（teardown；幂等） */
export function unbindAutoPullVisible() {
    try { if (autoPullOff) autoPullOff(); } catch (e) { /* noop */ }
    autoPullOff = null; autoPullBound = false; autoPullHook = null;
    return true;
}
/** 自动对账绑定状态（诊断） */
export function autoPullBindState() { return { bound: autoPullBound }; }
