// ============================================================
// 单元测试 · v2.55.0「调试页只留审计用途」：看日志 / 导出日志 / 清空；删除开发与历史说明
//
// 用户要求：「调试页面有大量无关提醒，尤其是涉及到具体开发的内容、历史内容完全没必要展示，
//   该页面核心目标就是方便查看审计日志、导出日志等操作。」
// 本批删除的噪声（逐项断言其不再出现）：
//   · 设定页标题行的「N 个配置项 · 共 X 项 / 13 页，结构与 V1 同名同序」（所有设定子页都受影响）
//   · 时钟取值追踪的「字段含义…来源中文名取自 core/clock-trace.js 的全量登记表，共 N 项」「排障时先跑一次提取/巡检」
//   · 异常区标题的「（host 全局 error / unhandledrejection + 面板动作失败）」
//   · 时间线的「记录：用户交互（点击/变更/切页）· …」「本机另存最近 120 条简报…」「时间线为纯内存环形缓冲…」
//   · 导出区的「版本 / 时间 / 作用域 / 宿主环境与能力探针 + 一键诊断快照（运行态、探针缺失项）+ …」
//   · 空态啰嗦提示（「运行「AI 摘要」或「自动修复」后在此显示」等）
//
// v2.82.0 追加（用户要求）：
//   ① 「设定-调试-日志的按钮全部调整到最上面」→ 导出日志 / 导出调试包 / 清空日志 三枚按钮统一在
//      **日志区块顶部**（原先「📦 导出调试包」是下方独立分节，要滚到底才能点到）→ S1/S1b 断言；
//   ② 「日志的导出功能有问题，无法正常导出 log 文件」→ 导出**真的落文件**：`dbgExport` 下载 `.json` 调试包、
//      新增 `dbgExportLog` 下载 `.log` 日志文本（此前只写剪贴板 + 文本框，不落文件）→ E 组断言。
// 运行：node tests/unit/debug-page.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { debugPageHtml, debugLogHtml, buildDebugLogText, debugAction, debugExportFileState } from '../../ui/debug.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsPageHtml, SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { debugLogPush, debugLogClear } from '../../adapters/debug-log.js';
import { traceEvent, traceClear } from '../../core/trace.js';

const R = makeReporter('debug-page v2.55.0 调试页：只留审计内容');
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
const host = makeHost({});
installGlobalHost(host, doc);
setKernelState(emptyState());

const lsMap = new Map();
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: {
        getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
        setItem: (k, v) => { lsMap.set(String(k), String(v)); },
        removeItem: (k) => { lsMap.delete(String(k)); },
        clear: () => lsMap.clear(),
    },
});

/** 页 HTML（空态 / 有日志态分别取） */
const pageHtml = () => settingsPageHtml('debug', '');
const boot = () => { debugLogClear(); traceClear(); };

// ---- S 组：页面结构与核心操作 ----
A('S1 分节齐备且排序稳定：调试日志 → 📋 日志 → ⚠ 异常捕捉 → 🧭 时间线 → 🕒 时钟追踪（v2.82.0：「导出」不再单独占一个分节）', (() => {
    boot();
    const h = pageHtml();
    const at = (s) => h.indexOf(s);
    return at('调试日志') >= 0 && at('📋 日志') > at('调试日志')
        && at('⚠ 异常捕捉') > at('📋 日志') && at('🧭 交互与宿主调用时间线') > at('⚠ 异常捕捉')
        && at('🕒 时钟取值追踪') > at('🧭 交互与宿主调用时间线')
        && at('📦 导出调试包') < 0;                       // 旧分节已并入日志区块顶部
})(), pageHtml().slice(0, 200));

A('S1b v2.82.0（用户要求）**日志的按钮全部在最上面**：导出日志 / 导出调试包 / 清空日志 三枚按钮都排在日志条目与类别统计之前', (() => {
    boot();
    debugLogPush('摘要', { label: '有日志' });
    const h = debugLogHtml();
    const bLog = h.indexOf('data-ftt-action="dbgExportLog"');
    const bPkg = h.indexOf('data-ftt-action="dbgExport"');
    const bClear = h.indexOf('data-ftt-action="dbgClear"');
    const stat = h.indexOf('class="ftt-stat"');
    const entry = h.indexOf('class="ftt-dbg-item"');
    return bLog >= 0 && bPkg > bLog && bClear > bPkg       // 按钮行自左至右
        && stat > bClear && entry > stat;                 // 且全部在统计行与日志条目之前
})(), debugLogHtml().slice(0, 240));

A('S1c 空态也保留导出入口（按钮行始终在最上面），只有「清空日志」按既有规则隐去', (() => {
    boot();
    const h = pageHtml();
    return h.indexOf('data-ftt-action="dbgExportLog"') >= 0 && h.indexOf('data-ftt-action="dbgExport"') >= 0
        && h.indexOf('data-ftt-action="dbgClear"') < 0 && h.indexOf('暂无日志') > h.indexOf('data-ftt-action="dbgExport"');
})(), '');

A('S2 核心操作入口齐备：开关 + 清空日志 / 导出日志（.log）/ 导出调试包（.json）/ 清空时间线 / 清空时钟追踪（无日志时不渲染「清空日志」，避免空操作）', (() => {
    boot();
    const empty = pageHtml();
    debugLogPush('摘要', { label: '有日志' });
    const h = pageHtml();
    return h.indexOf('data-ftt-action="dbgClear"') >= 0 && h.indexOf('data-ftt-action="dbgExport"') >= 0
        && h.indexOf('data-ftt-action="dbgExportLog"') >= 0
        && h.indexOf('data-ftt-action="dbgTraceClear"') >= 0 && h.indexOf('data-ftt-action="clockTraceClear"') >= 0
        && h.indexOf('data-ftt-cfg="debugEnabled"') >= 0
        && empty.indexOf('data-ftt-action="dbgClear"') < 0;
})(), '见断言');

A('S3 开关后果说明保留（有用的那一句），且只此一句', (() => {
    const h = pageHtml();
    return h.indexOf('关闭后不再记录新日志；已存日志仍可查看。') >= 0
        && h.indexOf('调试日志') >= 0;
})(), '见断言');

// ---- N 组：开发 / 历史内容必须消失 ----
A('N1 无开发与沿革说明：不出现「结构与 V1 同名同序」「个配置项」「core/clock-trace.js」「时间巡检」「探针缺失项」', (() => {
    boot();
    const h = pageHtml();
    const gone = ['结构与 V1 同名同序', '个配置项', 'core/clock-trace.js', '时间巡检', '探针缺失项',
        '字段含义', '命名取自全量登记表', 'unhandledrejection', '一个键', '本机另存最近 120 条简报',
        '记录：用户交互', '纯内存环形缓冲', '点击 → opId → 底层调用',
        '运行「AI 摘要」或「自动修复」后在此显示', '排障时先跑一次', '仅内存（重启即空）'];
    const hit = gone.filter((s) => h.indexOf(s) >= 0);
    return hit.length === 0;
})(), '见断言（hit 为空）');

A('N2 空态只给一句：暂无日志。／暂无事件。／暂无异常记录。（且不再出现「最近 3 条：」空行）', (() => {
    boot();
    const h = pageHtml();
    return h.indexOf('暂无日志。') >= 0 && h.indexOf('暂无事件。') >= 0 && h.indexOf('暂无异常记录。') >= 0
        && h.indexOf('最近 3 条：') < 0 && h.indexOf('运行「AI 摘要」') < 0;
})(), '见断言');

A('N3 时间线元信息只留会话/事件/上限/级别，footer 只说「仅内存，重启即空」', (() => {
    boot();
    traceEvent({ cat: 'ui', kind: 'click', level: 'debug' });
    const h = pageHtml();
    return /会话 [^·]+ · 事件 1（上限 \d+）· 级别 \w+/.test(h)
        && h.indexOf('仅内存，重启即空') >= 0
        && h.indexOf('记录：') < 0 && h.indexOf('本机另存') < 0;
})(), '见断言');

A('N4 时钟追踪的取值口径说明保留（有帮助），但不含来源表规模/N 项/dev 路径', (() => {
    boot();
    const h = pageHtml();
    return h.indexOf('取值口径：') >= 0 && h.indexOf('值 ← 来源') >= 0
        && h.indexOf(' 项') < 0 && h.indexOf('clock-trace') < 0;
})(), '见断言');

A('N5 v2.82.0 导出说明只说「包含什么 / 不含什么」：两种导出各有按钮、说明点明「不含记忆正文」，不罗列实现细节', (() => {
    boot();
    const h = pageHtml();
    return h.indexOf('不含记忆正文') >= 0
        && h.indexOf('⬇ 导出日志') >= 0 && h.indexOf('⬇ 导出调试包') >= 0
        && h.indexOf('⬇ 导出调试日志') < 0
        && h.indexOf('能力探针') < 0 && h.indexOf('一键诊断快照（运行态') < 0;
})(), '见断言');

// ---- L 组：有日志时仍是审计视图 ----
A('L1 有日志：工具栏给出条数/上限/展开提示与按类别统计，逐条为可展开的 details（审计可读）', (() => {
    boot();
    debugLogPush('摘要', { label: '第 3 楼', chars: 120 });
    debugLogPush('异常', { message: '面板动作失败：boom' });
    const h = debugLogHtml();
    return h.indexOf('共 2 条') >= 0 && h.indexOf('（最多 300 条 · 最新在上 · 点击展开）') >= 0
        && h.indexOf('🧠 分析记忆 1') >= 0 && h.indexOf('class="ftt-dbg-item"') >= 0
        && h.indexOf('第 3 楼') >= 0 && h.indexOf('boom') >= 0;
})(), debugLogHtml().slice(0, 200));

A('L2 有异常时异常区给出「最近一条 + 最近 3 条」，标题只留「共 N 条」', (() => {
    boot();
    debugLogPush('异常', { kind: '脚本错误', message: '测试异常甲' });
    const h = pageHtml();
    return h.indexOf('⚠ 异常捕捉') >= 0 && h.indexOf('共 1 条') >= 0
        && h.indexOf('最近一条 ·') >= 0 && h.indexOf('最近 3 条：') >= 0 && h.indexOf('测试异常甲') >= 0
        && h.indexOf('面板动作失败）') < 0;
})(), '见断言');

A('L3 直接调用 debugPageHtml(controls) 与设定页渲染一致（同一份内容，避免两处各写一套）', (() => {
    boot();
    debugLogPush('对账', { stage: 'diff' });
    const a = debugPageHtml(SETTINGS_CONTROLS.debug);
    const b = settingsPageHtml('debug', '');
    return a === b && a.indexOf('📋 日志') >= 0;
})(), '见断言');

if (globalThis.window && globalThis.window.localStorage === undefined) delete globalThis.window;

// ============================================================
// E 组（v2.82.0）：导出**真的落文件** —— 用户报告「日志的导出功能有问题，无法正常导出 log 文件」
//   修复前：`dbgExport` 只把文本写剪贴板 + 文本框（不落文件）→ 用户点了没有任何文件。
//   修复后：`dbgExport` 下载 `.json` 调试包；新增 `dbgExportLog` 下载 `.log` 日志文本；
//          宿主不支持下载时如实回落（note 说明原因 + 文本框兜底）。
// ============================================================
const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 假的下载环境（Blob / URL / <a download> / 立即执行的 revoke 定时器），返回记录与还原函数 */
function withDownloadEnv(fn) {
    const log = { names: [], blobs: [], mimes: [], clicked: [], revoked: [] };
    const prev = { doc: globalThis.document, URL: globalThis.URL, Blob: globalThis.Blob, timeout: globalThis.setTimeout };
    globalThis.Blob = class FakeBlob {
        constructor(parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; }
    };
    globalThis.URL = {
        createObjectURL(b) { log.blobs.push(b); return 'blob:test/' + log.blobs.length; },
        revokeObjectURL(u) { log.revoked.push(u); },
    };
    globalThis.setTimeout = (f) => { try { f(); } catch (e) { /* 忽略 */ } return 0; };
    globalThis.document = {
        createElement(tag) {
            const el = {
                tagName: String(tag).toUpperCase(), style: {}, attrs: {},
                set href(v) { this.attrs.href = v; }, get href() { return this.attrs.href; },
                set download(v) { this.attrs.download = v; }, get download() { return this.attrs.download; },
                set rel(v) { this.attrs.rel = v; },
                click() { log.clicked.push(this.attrs.download); },
                remove() { },
            };
            return el;
        },
        body: { appendChild() { return true; }, removeChild() { return true; } },
    };
    try { return fn(log); } finally {
        globalThis.document = prev.doc; globalThis.URL = prev.URL; globalThis.Blob = prev.Blob; globalThis.setTimeout = prev.timeout;
    }
}

await (async () => {
    boot();
    debugLogPush('摘要', { label: '导出用例', chars: 42 });
    const r = await withDownloadEnv(() => debugAction('dbgExportLog', {}));
    const st = debugExportFileState();
    A('E1 v2.82.0 修复/新增：`dbgExportLog` **真实下载 .log 文件**（文件名带角色与时间戳、mime text/plain、内容含头信息与逐条日志）', (() => {
        const blob = r.file && r.file.ok;
        return r.ok === true && !!blob
            && /\.log$/.test(String(r.file.filename)) && String(r.file.filename).indexOf('FTT调试日志_') === 0
            && r.note.indexOf('已下载文件') >= 0
            && st.file && st.file.ok === true && st.file.kind === 'log';
    })(), () => ({ file: r.file, note: r.note }));
})();

await (async () => {
    boot();
    debugLogPush('修复', { label: '调试包用例' });
    const r = await withDownloadEnv(() => debugAction('dbgExport', {}));
    A('E2 v2.82.0 修复：`dbgExport`（导出调试包）**真实下载 .json 文件**（此前只写剪贴板/文本框，用户点完没有文件）', (() => {
        return r.ok === true && r.file && r.file.ok === true
            && /\.json$/.test(String(r.file.filename)) && String(r.file.filename).indexOf('FTT调试包_') === 0
            && Number(r.chars) > 200 && r.note.indexOf('已下载文件') >= 0;
    })(), () => ({ file: r.file, note: r.note }));
})();

A('E3 `.log` 文本口径：头信息（版本/时间/作用域/条数）+ 每条一行「[时间] [类别] 内容」，且非 JSON 日志也能导出', (() => {
    boot();
    debugLogPush('摘要', { label: '甲', chars: 1 });
    debugLogPush('异常', '纯文本异常行');
    const t = buildDebugLogText();
    return t.indexOf('FTT记忆组件 V2 · 调试日志') >= 0 && t.indexOf('条数：2') >= 0
        && /\[\d{4}\/\d{1,2}\/\d{1,2}[^\]]*\] \[🧠 分析记忆\]/.test(t)
        && t.indexOf('纯文本异常行') >= 0 && t.split('\n').length >= 7;
})(), () => buildDebugLogText().split('\n').slice(0, 7));

A('E4 无日志时 `dbgExportLog` 如实拒绝（提示先产生日志），不产生空文件；调试包仍可导出（含运行态）', (async () => {
    boot();
    const bad = await withDownloadEnv(() => debugAction('dbgExportLog', {}));
    const ok = await withDownloadEnv(() => debugAction('dbgExport', {}));
    return bad.ok === false && bad.note.indexOf('暂无日志') >= 0 && (!bad.file)
        && ok.ok === true && ok.file && ok.file.ok === true;
})(), '见断言');

A('E5 宿主不支持下载 → 如实回落（note 说明未能下载 + 文本仍在文本框兜底），不抛错', (async () => {
    boot();
    debugLogPush('摘要', { label: '无下载环境' });
    const prevDoc = globalThis.document, prevUrl = globalThis.URL, prevBlob = globalThis.Blob;
    globalThis.document = undefined; globalThis.URL = undefined; globalThis.Blob = undefined;
    let r = null;
    try { r = await debugAction('dbgExportLog', {}); } finally {
        globalThis.document = prevDoc; globalThis.URL = prevUrl; globalThis.Blob = prevBlob;
    }
    return r.ok === true && r.file && r.file.ok === false
        && r.note.indexOf('未能下载文件') >= 0 && debugExportFileState().logChars > 0;
})(), '见断言');

A('E6 CSS/视图层不阻断：日志区块顶部按钮行使用既有 .ftt-row/.ftt-btn 类名（样式无需新增）', (() => {
    const css = readFileSync(join(ROOT2, 'style.css'), 'utf8');
    const h = debugLogHtml();
    return h.indexOf('class="ftt-row"') >= 0 && h.indexOf('class="ftt-btn ftt-sm') >= 0
        && /#ftt-panel \.ftt-row\b/.test(css);
})(), '见断言');

R.done();
