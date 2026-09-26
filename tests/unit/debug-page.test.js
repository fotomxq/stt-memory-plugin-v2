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
// 运行：node tests/unit/debug-page.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { debugPageHtml, debugLogHtml } from '../../ui/debug.js';
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
A('S1 五个分节齐备且按「先看日志、再导出」排序：调试日志 → 📋 日志 → 📦 导出调试包 → ⚠ 异常捕捉 → 时间线 → 时钟追踪', (() => {
    boot();
    const h = pageHtml();
    const at = (s) => h.indexOf(s);
    return at('调试日志') >= 0 && at('📋 日志') > at('调试日志') && at('📦 导出调试包') > at('📋 日志')
        && at('⚠ 异常捕捉') > at('📦 导出调试包') && at('🧭 交互与宿主调用时间线') > at('⚠ 异常捕捉')
        && at('🕒 时钟取值追踪') > at('🧭 交互与宿主调用时间线');
})(), pageHtml().slice(0, 200));

A('S2 核心操作入口齐备：开关 + 清空日志 / 导出调试包 / 清空时间线 / 清空时钟追踪（无日志时不渲染「清空日志」，避免空操作）', (() => {
    boot();
    const empty = pageHtml();
    debugLogPush('摘要', { label: '有日志' });
    const h = pageHtml();
    return h.indexOf('data-ftt-action="dbgClear"') >= 0 && h.indexOf('data-ftt-action="dbgExport"') >= 0
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

A('N5 导出说明只说「包含什么 / 不含什么」，不再罗列实现细节；按钮文案统一为「导出调试包」', (() => {
    boot();
    const h = pageHtml();
    return h.indexOf('包含全部日志与运行态诊断，不含记忆正文') >= 0
        && h.indexOf('⬇ 导出调试包') >= 0 && h.indexOf('⬇ 导出调试日志') < 0
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
R.done();
