// ============================================================
// 单元测试 · v2.54.0「数据管理 → 本地缓冲：统计与真实持久层一致 + 只给统计不给明细」
//
// 用户报告：「快照/缓存管理错误，请核对该内容的一致性；展示信息**仅为统计信息**，而不是具体明细」。
// 事实（修复前）：数据管理页「本地缓冲」两处数字与真实持久层**不一致** ——
//   ① 调试日志读了不存在的字段 `logs.count`（真实字段是 `n`）→ 永远显示「0 条」；
//   ② 交互追踪简报用的是**内存事件数** `traceStats().total`，而实际持久化的是「最近 120 条简报」→ 数字对不上；
//   ③ 也没有给出「占用字节 / 最近时间」，用户无法判断要不要清。
// 本批：新增 `ui/buffer-manage.js`（`bufferStats()` 单一来源 + `bufferSectionHtml()` 仅统计 + 逐项清理），
//   `core/trace.js#traceClear` 同时清掉本机简报（否则调试页 0 条、数据管理 N 条，仍不一致）。
// 覆盖：C 数字与 localStorage 逐项一致 / E 空态与禁用 / H 只出统计不出明细 / A 三个清理动作真实生效。
// 运行：node tests/unit/buffer-manage.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { bufferStats, bufferSectionHtml, byteLen, fmtBytes, rawBytes } from '../../ui/buffer-manage.js';
import { aboutWriteCache, aboutClearCache, ABOUT_CACHE_KEY } from '../../ui/about.js';
import { DEBUG_KEY } from '../../adapters/debug-log.js';
import { TRACE_KEY } from '../../adapters/trace-store.js';
import { panelAction, setPanelHooks2, openPanel, bindOverlay } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';
import { traceClear, traceStats } from '../../core/trace.js';
import { wireTraceStore } from '../../adapters/trace-store.js';
import { wireDebugLog, debugLogPush, debugLogClear } from '../../adapters/debug-log.js';

const R = makeReporter('buffer-manage v2.54.0 本地缓冲：统计一致性 / 仅统计 / 逐项清理');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { }, appended: [], appendChild(n) { this.appended.push(n); }, removeChild() { return true; } };
const host = makeHost({});
installGlobalHost(host, doc);
setKernelState(emptyState());
wireDebugLog();

const lsMap = new Map();
const ls = {
    getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
    removeItem: (k) => { lsMap.delete(String(k)); },
    clear: () => lsMap.clear(),
    key: (i) => Array.from(lsMap.keys())[i] || null,
    get length() { return lsMap.size; },
};
const keepWin = globalThis.window;
globalThis.window = Object.assign({}, globalThis.window, { localStorage: ls });
wireTraceStore();   // 把内核追踪接到 localStorage（与 index.js 生产接线一致）

const VERSION_DOC = {
    name: 'FTT记忆组件', version: '9.9.9', updatedAt: '2026-10-01',
    intro: { what: 'x', highlights: [], entries: [], notes: '' },
    changelog: [{ version: '9.9.9', date: '2026-10-01', title: 't', points: ['p'] }, { version: '9.9.8', date: '2026-09-01', title: 't2', points: [] }],
};
const TRACE_BRIEFS = [
    { id: 't1', at: 1700000000000, cat: 'ui', kind: 'click', ok: true, opId: 'op1', site: 'a.js:1' },
    { id: 't2', at: 1700000001000, cat: 'host', kind: 'getContext', ok: true, opId: '', site: 'b.js:2' },
];
const DEBUG_LIST = [
    { at: 1700000002000, kind: '摘要', data: '第一行' },
    { at: 1700000003000, kind: '对账', data: '第二行' },
    { at: 1700000004000, kind: '异常', data: '第三行' },
];

function seed() {
    lsMap.clear();
    traceClear();
    aboutClearCache();
    aboutWriteCache(VERSION_DOC);                            // → fttAboutJson（2 个版本）
    debugLogClear();
    DEBUG_LIST.forEach((l) => debugLogPush(l.kind, { text: l.data }));   // → SPreset_FTTMemoryDebug（3 条）
    lsMap.set(TRACE_KEY, JSON.stringify(TRACE_BRIEFS));                  // → SPreset_FTTMemoryTrace（2 条简报）
    wireTraceStore();
}

// ---- C 组：统计与真实持久层逐项一致 ----
A('C1 bufferStats 的每项数字都等于 localStorage 里的真实内容（条数 / 字节 / 上限）', (() => {
    seed();
    const st = bufferStats();
    const rawV = ls.getItem(ABOUT_CACHE_KEY), rawD = ls.getItem(DEBUG_KEY), rawT = ls.getItem(TRACE_KEY);
    return st.versionList.cached === true && st.versionList.versions === 2
        && st.versionList.bytes === byteLen(rawV)
        && st.debugLog.count === 3 && st.debugLog.cap === 300 && st.debugLog.bytes === byteLen(rawD)
        && st.trace.count === 2 && st.trace.cap === 120 && st.trace.bytes === byteLen(rawT)
        && st.totalBytes === st.versionList.bytes + st.debugLog.bytes + st.trace.bytes;
})(), J(bufferStats()));

A('C2 rawBytes 现算：键存在 → 真实 UTF-8 字节（中文 3 字节）；键不存在 → 0', (() => {
    lsMap.clear();
    ls.setItem('probe', '中');
    return rawBytes('probe') === 3 && rawBytes('nope') === 0 && byteLen('中') === 3;
})(), J({ probe: rawBytes('probe'), none: rawBytes('nope') }));

A('C3 fmtBytes 人类可读（B / KB / MB）', fmtBytes(0) === '0 B' && fmtBytes(999) === '999 B'
    && fmtBytes(2048) === '2.0 KB' && fmtBytes(3 * 1024 * 1024) === '3.00 MB',
    J([fmtBytes(0), fmtBytes(999), fmtBytes(2048), fmtBytes(3 * 1024 * 1024)]));

A('C4 刷新页面后典型态：内存事件 0 条、持久简报 N 条 → 统计以**持久层**为准（旧实现读内存事件数，数字与「本机已存简报」对不上）', (() => {
    lsMap.clear();
    traceClear();
    lsMap.set(TRACE_KEY, JSON.stringify(TRACE_BRIEFS.slice(0, 1)));   // 仅持久层有 1 条（模拟上次会话遗留）
    const st = bufferStats();
    return traceStats().total === 0 && st.trace.count === 1 && st.trace.bytes === byteLen(ls.getItem(TRACE_KEY));
})(), J({ mem: traceStats().total, persisted: bufferStats().trace.count }));

// ---- E 组：空态 / 禁用 ----
A('E1 全空：cached=false、计数 0、字节 0；HTML 显示「（无缓存）」且三个清理按钮禁用', (() => {
    lsMap.clear();
    traceClear();
    aboutClearCache();
    debugLogClear();
    const st = bufferStats();
    const h = bufferSectionHtml();
    const disabled = (h.match(/disabled/g) || []).length;
    return st.any === false && st.totalBytes === 0 && st.versionList.cached === false
        && st.debugLog.count === 0 && st.trace.count === 0
        && h.indexOf('（无缓存）') >= 0 && disabled === 3
        && /data-ftt-action="aboutClearCache"[^>]*disabled/.test(h)
        && /data-ftt-action="dbgClear"[^>]*disabled/.test(h)
        && /data-ftt-action="dbgTraceClear"[^>]*disabled/.test(h);
})(), bufferSectionHtml());

// ---- H 组：只出统计，不出明细 ----
A('H1 分节 HTML 只含统计与清理入口：出现条数/上限/字节，不出现任何日志或简报的正文明细', (() => {
    seed();
    const h = bufferSectionHtml();
    return h.indexOf('🗂 本地缓冲') >= 0
        && h.indexOf('已缓存 2 个版本') >= 0 && h.indexOf('约 ') >= 0
        && h.indexOf('3 / 300 条') >= 0 && h.indexOf('2 / 120 条') >= 0
        && h.indexOf('data-ftt-action="aboutClearCache"') >= 0 && h.indexOf('data-ftt-action="dbgClear"') >= 0
        && h.indexOf('data-ftt-action="dbgTraceClear"') >= 0
        // 只统计：不出现明细正文（调试日志 data / 简报 site / 版本标题）
        && h.indexOf('第一行') < 0 && h.indexOf('第二行') < 0 && h.indexOf('第三行') < 0
        && h.indexOf('a.js:1') < 0 && h.indexOf('b.js:2') < 0 && h.indexOf('t2') < 0;
})(), bufferSectionHtml());

A('H2 文案说明「这是什么 + 清理有什么后果」（本地缓存 / 不影响记忆数据）', (() => {
    const h = bufferSectionHtml();
    return h.indexOf('本地缓存与日志') >= 0 && h.indexOf('不影响记忆数据') >= 0
        && h.indexOf('10 分钟') < 0 && h.indexOf('相对路径') < 0 && h.indexOf('localStorage') < 0;
})(), '见断言');

A('H3 数据管理页含「本地缓冲」分节；行数恒为 3（不随数据增长出明细行）', (() => {
    seed();
    const h = settingsPageHtml('data', '');
    const rows = (h.match(/class="ftt-muted">(版本清单缓存|调试日志|交互追踪简报)：/g) || []).length;
    return h.indexOf('🗂 本地缓冲') >= 0 && rows === 3
        && h.indexOf('共约 ') >= 0;
})(), '见断言');

// ---- A 组：三个清理动作真实生效（并同步统计）----
await (async () => {
    seed();
    openPanel('settings');
    bindOverlay();
    setPanelHooks2({});

    const r1 = await panelAction('aboutClearCache', {});
    const afterAbout = bufferStats();
    A('A1 清除版本清单缓存：localStorage 键消失 + 统计归零 + 动作如实回报', r1.ok === true
        && ls.getItem(ABOUT_CACHE_KEY) === null && afterAbout.versionList.cached === false
        && afterAbout.versionList.versions === 0 && afterAbout.versionList.bytes === 0
        && String(r1.note || '').indexOf('已清除版本清单缓存') >= 0,
        J({ note: r1.note, stats: afterAbout.versionList }));

    const r2 = await panelAction('dbgClear', {});
    const afterDbg = bufferStats();
    A('A2 清空调试日志：持久层归零 + 统计 0 条（旧实现读错字段 `count`，此处恒显示 0 属巧合、非真实）', r2.ok === true
        && afterDbg.debugLog.count === 0 && afterDbg.debugLog.bytes === 0
        && String(r2.note || '').indexOf('已清空调试日志') >= 0,
        J({ note: r2.note, stats: afterDbg.debugLog }));

    const r3 = await panelAction('dbgTraceClear', {});
    const afterTrace = bufferStats();
    const left = (() => { try { return JSON.parse(ls.getItem(TRACE_KEY) || '[]'); } catch (e) { return [{ id: 'parse-error' }]; } })();
    A('A3 清空交互追踪简报：**本机简报一并清掉**（旧的 2 条简报消失；动作自身会被追踪，故至多剩 1 条）', r3.ok === true
        && left.every((x) => x && x.id !== 't1' && x.id !== 't2') && left.length <= 1
        && afterTrace.trace.count === left.length
        && String(r3.note || '').indexOf('含本机简报') >= 0,
        J({ note: r3.note, left: left.length, persisted: afterTrace.trace.count }));

    A('A4 清理后数据管理页统计随之更新（版本缓存无、日志 0 条、按钮禁用）', (() => {
        const h = settingsPageHtml('data', '');
        return h.indexOf('版本清单缓存：（无缓存）') >= 0 && h.indexOf('0 / 300 条') >= 0
            && h.indexOf('版本清单缓存：（无缓存） <button class="ftt-btn ftt-sm" data-ftt-action="aboutClearCache"') >= 0
            && (h.match(/disabled/g) || []).length >= 2;
    })(), '见断言');
})();

if (keepWin === undefined) delete globalThis.window; else globalThis.window = keepWin;
R.done();
