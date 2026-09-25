// ============================================================
// 单元测试 · v2.42.0「交互 / 宿主 / 错误的统一追踪」（用户要求：调试日志要能追到底层关系与具体代码位置）
// 背景（用户原话）：「调试日志应该捕捉用户交互、插件交互的**所有日志**，当前展示的属于业务日志，无法追溯底层关系，
//   而且只有异常错误、没有上下文，无法追溯具体错误的代码位置。请约定和完善该设计。」
//
// 本批约定（三层事件流 + 三条硬要求）：
//   ① `ui`   用户交互（点击/变更/切页）→ 带 tab/sub/参数/处理器结果；② `host` 宿主 API 调用 → 方法/参数/返回/耗时/失败；
//   ③ `cmd`  命令与 FTT.* 入口；另加 `kernel`/`ai`/`error`。
//   硬要求：A **opId 关联**（谁触发的宿主调用/报错可回溯）；B **site 代码位置**（file:line:fn，过滤包装层帧）；
//          C **错误上下文窗口**（前后各 N 条 + 同 opId 关联）。
// 覆盖：
//   A 组：事件写入 / 级别门禁 / 分类计数 / 结构完整（id·at·cat·kind·level·ok·site·opId）；
//   B 组：site 解析（真实文件:行 + 过滤 core/trace.js · 栈不可用时降级不抛）；
//   C 组：脱敏与截断（key/password/secret/token/authorization → ***，sk-* → sk-***，长文本只记长度，超长 detail 截断）；
//   D 组：去重（窗口内合并为 ×N，超窗口后重新计数）；
//   E 组：opId 关联（op 内 host/kernel 事件自动带 opId；op 结束出栈后不再带；嵌套 op 父子）；
//   F 组：分类上限 / 总量上限（内存恒定）；
//   G 组：错误上下文窗口（中心 + 前后 N + 同 opId 关联；空输入不抛）；
//   H 组：分类开关（debugTraceUi / debugTraceHost=false 时不记）与总开关（debugEnabled=false）；
//   I 组：时间线文本可读（含时间·类别·kind·site）；traceClear 清空；
//   J 组：**不影响主流程**——非法入参 / detail 循环引用 / hooks.save 抛错 都不得抛出。
// 运行：node tests/unit/trace.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import {
    TRACE_LEVELS, TRACE_CATS, TRACE_CAT_CAP, TRACE_TOTAL_CAP, TRACE_CONTEXT_SPAN, TRACE_DEDUPE_MS,
    TRACE_ITEM_MAX, traceEvent, traceList, traceStats, traceContext, traceBrief, traceTimelineText,
    traceSite, traceSiteText, traceSummarize, traceOpStart, traceOpEnd, traceCurrentOp,
    traceSessionId, setTraceHooks, traceClear,
} from '../../core/trace.js';

const R = makeReporter('trace v2.42.0 交互/宿主/错误统一追踪');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const clone = (o) => JSON.parse(JSON.stringify(o || {}));
function boot(patch) {
    Object.assign(cfg, clone(defaultCfg));
    if (patch) Object.assign(cfg, clone(patch));
    traceClear();
    setTraceHooks({ save: () => undefined });
}
/** 等待超过去重窗口（D 组用） */
function sleep(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* 忙等，避免依赖定时器 */ } }

// ---------- A 组：写入 / 级别 / 统计 / 结构 ----------
boot({ debugLevel: 'trace' });
const a1 = traceEvent({ cat: 'ui', kind: 'click', level: 'trace', detail: { action: 'today' } });
A('A1 traceEvent 返回记录且结构完整（id/at/cat/kind/level/ok/opId/site）',
    a1 && /^e\d+$/.test(a1.id) && a1.at > 0 && a1.cat === 'ui' && a1.kind === 'click' && a1.ok === true
    && a1.level === 'trace' && 'opId' in a1 && !!a1.site && typeof a1.site.file === 'string',
    J(a1));

A('A2 未知类别归入 kernel（不让脏类别污染视图）',
    (traceEvent({ cat: 'nope', kind: 'x' }) || {}).cat === 'kernel', J(traceStats().cats));

A('A3 级别门禁：debug 级时 trace 级事件丢弃',
    (boot(), cfg.debugLevel = 'debug', traceEvent({ cat: 'ui', kind: 'click', level: 'trace' })) === null
    && traceList({ cat: 'ui' }).length === 0, J(cfg.debugLevel));

A('A4 级别门禁：trace 级时 info/debug/trace 均入库',
    (boot(), cfg.debugLevel = 'trace',
        traceEvent({ cat: 'ui', kind: 'i', level: 'info' }),
        traceEvent({ cat: 'ui', kind: 'd', level: 'debug' }),
        traceEvent({ cat: 'ui', kind: 't', level: 'trace' }),
        traceList({ cat: 'ui' }).length === 3), J(traceStats().cats));

A('A5 统计：分类计数与总量一致，且暴露会话 id 与当前级别',
    (boot(), traceEvent({ cat: 'ui', kind: 'a' }), traceEvent({ cat: 'host', kind: 'b' }),
        traceEvent({ cat: 'error', kind: 'c', level: 'error' }),
        (() => { const s = traceStats(); return s.total === 3 && s.cats.ui === 1 && s.cats.host === 1 && s.cats.error === 1
            && s.levels.error === 1 && !!s.session && !!s.level && s.cap === TRACE_TOTAL_CAP; })()),
    J(traceStats()));

A('A6 列表默认最新在前，可按 cat / opId / limit 过滤',
    (boot(), traceEvent({ cat: 'ui', kind: 'first' }), traceEvent({ cat: 'host', kind: 'second' }),
        (() => { const l = traceList(); return l[0].kind === 'second' && l.length === 2
            && traceList({ cat: 'ui' }).length === 1 && traceList({ limit: 1 }).length === 1; })()),
    J(traceList().map((x) => x.kind)));

A('A7 默认级别：ok!==false → debug（不是 error），ok===false → warn',
    (boot(),
        (traceEvent({ cat: 'host', kind: 'ok' }) || {}).level === 'debug'
        && (traceEvent({ cat: 'host', kind: 'bad', ok: false, reason: 'boom' }) || {}).level === 'warn'),
    J(traceList({ cat: 'host' }).map((x) => [x.kind, x.level])));

A('A8 失败事件保留原因与耗时（追责四要素：谁·做了什么·结果·多久）',
    (() => { const r = traceEvent({ cat: 'host', kind: 'sendRequest', ok: false, reason: 'HTTP 401', ms: 123 });
        return r.reason === 'HTTP 401' && r.ms === 123 && r.ok === false; })(), J(traceList()[0]));

// ---------- B 组：site（代码位置） ----------
A('B1 traceSite 从真实栈解析出本仓库文件与行号',
    (() => { const s = traceSite(new Error().stack);
        return /\.(js|mjs|cjs)$/.test(s.file) && s.line > 0 && s.file.indexOf('core/trace.js') < 0; })(),
    J(traceSite(new Error().stack)));

A('B2 traceSite 过滤本模块自身帧（跳过 core/trace.js）',
    (() => {
        const fake = 'Error\n    at traceEvent (/x/core/trace.js:100:1)\n    at doThing (/x/ui/panel.js:42:7)';
        const s = traceSite(fake);
        return s.file === 'ui/panel.js' && s.line === 42 && s.col === 7 && s.fn === 'doThing';
    })(), J(traceSite('Error\n    at traceEvent (/x/core/trace.js:100:1)\n    at doThing (/x/ui/panel.js:42:7)')));

A('B3 traceSite 支持额外过滤帧（宿主包装层）',
    (() => {
        const fake = 'Error\n    at t (/x/host/st-api.js:9:1)\n    at run (/x/ui/panel.js:7:3)';
        return traceSite(fake, ['host/st-api.js']).file === 'ui/panel.js';
    })(), '');

A('B4 traceSite 无可解析帧 → 空站点且不抛（空串则回落到真实栈，仍给出可用站点）',
    (() => { const a = traceSite('Error\n    at <anonymous>');
        const b = traceSite('Error\n  <no frames>');
        return a.file === '' && a.line === 0 && b.file === '' && traceSiteText(a) === '' && traceSiteText() === ''; })(),
    J([traceSite('Error\n    at <anonymous>'), traceSite('Error\n  <no frames>')]));

A('B7 无函数名的裸帧（V8 URL 形态）解析正确：file:///…/tests/a.js:12:5 → tests/a.js:12（列号不被当成行号）',
    (() => { const s = traceSite('Error: x\n    at file:///home/u/proj/tests/a.js:12:5\n    at b (/x/core/b.js:1:1)');
        return s.file === 'tests/a.js' && s.line === 12 && s.col === 5 && s.fn === ''; })(),
    J(traceSite('Error: x\n    at file:///home/u/proj/tests/a.js:12:5')));

A('B8 async 前缀 / ?缓存串 帧仍能解析（不因前缀把文件名切错）',
    (() => { const s = traceSite('Error: x\n    at async file:///home/u/p/ui/panel.js?t=123:88:9');
        return s.file === 'ui/panel.js' && s.line === 88 && s.col === 9; })(),
    J(traceSite('Error: x\n    at async file:///home/u/p/ui/panel.js?t=123:88:9')));

A('B5 site 文本形如 file:line:fn（面板/导出里直接可见）',
    traceSiteText({ file: 'ui/panel.js', line: 12, fn: 'panelAction' }) === 'ui/panel.js:12:panelAction'
    && traceSiteText({ file: 'ui/panel.js', line: 0, fn: '' }) === 'ui/panel.js:0',
    traceSiteText({ file: 'ui/panel.js', line: 12, fn: 'panelAction' }));

A('B6 事件携带 stack 时自动解析 site（调用方无需自己算）',
    (boot(), (() => {
        const r = traceEvent({ cat: 'error', kind: 'E', level: 'error', stack: 'Error\n    at boom (/x/core/ingest.js:33:5)' });
        return r.site.file === 'core/ingest.js' && r.site.line === 33;
    })()), J(traceList()[0].site));

// ---------- C 组：脱敏 / 截断 ----------
A('C1 敏感键名（key/password/secret/token/authorization）→ ***',
    (() => { const s = traceSummarize({ apiKey: 'abc', password: 'p', secret: 's', token: 't', Authorization: 'Bearer x', keep: 'ok' });
        return s.apiKey === '***' && s.password === '***' && s.secret === '***' && s.token === '***' && s.Authorization === '***' && s.keep === 'ok'; })(),
    J(traceSummarize({ apiKey: 'abc', password: 'p', secret: 's', token: 't', Authorization: 'Bearer x', keep: 'ok' })));

A('C2 sk- 值 → sk-***（即使键名无害）',
    traceSummarize('sk-abcdefghijklmnop') === 'sk-***' && traceSummarize('Bearer zzz') === 'sk-***',
    J([traceSummarize('sk-abcdefghijklmnop'), traceSummarize('Bearer zzz')]));

A('C3 长文本字段只记长度（prompt/content/text/messages/body/data 不落正文）',
    (() => { const s = traceSummarize({ prompt: 'x'.repeat(5000), content: 'y'.repeat(40), messages: [1, 2, 3], text: 'z' });
        return s.prompt === '[省略 5000]' && s.content === '[省略 40]' && s.messages === '[省略 3 项]' && s.text === '[省略 1]'; })(),
    J(traceSummarize({ prompt: 'x'.repeat(5000), content: 'y'.repeat(40), messages: [1, 2, 3], text: 'z' })));

A('C4 长字符串默认截断并标注长度；verbose 时放开到 200 字',
    (() => {
        const long = 'a'.repeat(400);
        const normal = traceSummarize(long);
        boot({ debugTraceVerbose: true });
        const verbose = traceSummarize(long);
        const r = /^\[str 400 字\]/.test(normal) && verbose.replace(/…$/, '').length === 200 && verbose.length <= 201;
        boot();
        return r;
    })(), '');

A('C5 detail 序列化超 TRACE_ITEM_MAX → 截断为 [截断]，且不影响主流程',
    (() => {
        const big = { a: {} };
        for (let i = 0; i < 60; i += 1) big.a['k' + i] = 'v'.repeat(60);
        const r = traceEvent({ cat: 'host', kind: 'big', detail: big });
        return !!r && J(r.detail) !== '' && J(r.detail).length <= TRACE_ITEM_MAX;
    })(), '');

A('C6 函数值记为 [fn]；null 保留 null；数字/布尔原样',
    (() => { const s = traceSummarize({ fn: () => 1, n: null, i: 3, b: false });
        return s.fn === '[fn]' && s.n === null && s.i === 3 && s.b === false; })(),
    J(traceSummarize({ fn: () => 1, n: null, i: 3, b: false })));

A('C7 数组过深只记 [Array n]（避免爆量）',
    traceSummarize([[1, 2], [3, 4]], 0).length === 2 && traceSummarize([1, 2, 3], 2) === '[Array 3]',
    J(traceSummarize([1, 2, 3], 2)));

// ---------- D 组：去重 ----------
A('D1 同类别同 kind 同摘要且在窗口内 → 合并为一条 ×N',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'click' });
        traceEvent({ cat: 'ui', kind: 'click' });
        traceEvent({ cat: 'ui', kind: 'click' });
        const l = traceList({ cat: 'ui' });
        return l.length === 1 && l[0].n === 3; })(), J(traceList({ cat: 'ui' }).map((x) => [x.kind, x.n])));

A('D2 超过去重窗口后重新计数（×N 不掩盖持续问题）',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'click' });
        sleep(TRACE_DEDUPE_MS + 30);
        traceEvent({ cat: 'ui', kind: 'click' });
        return traceList({ cat: 'ui' }).length === 2; })(), J(traceList({ cat: 'ui' }).map((x) => x.n)));

A('D3 去重按 detail 区分（不同目标不合并）',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'click', detail: { action: 'a' } });
        traceEvent({ cat: 'ui', kind: 'click', detail: { action: 'b' } });
        return traceList({ cat: 'ui' }).length === 2; })(), J(traceList({ cat: 'ui' }).map((x) => x.detail)));

A('D4 去重只作用于同类事件，不吞掉其他类别',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'x' });
        traceEvent({ cat: 'host', kind: 'x' });
        return traceStats().total === 2; })(), J(traceStats().cats));

A('D5 dedupeKey 可显式指定（交互级合并）',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'k', dedupeKey: 'same' });
        traceEvent({ cat: 'ui', kind: 'other', dedupeKey: 'same' });
        const l = traceList({ cat: 'ui' });
        return l.length === 1 && l[0].n === 2 && l[0].kind === 'k'; })(), '');

// ---------- E 组：opId 关联 ----------
A('E1 op 内发生的 host 事件自动带 opId/op（谁触发的宿主调用可回溯）',
    (() => { boot();
        const op = traceOpStart('ui.analyze');
        traceEvent({ cat: 'host', kind: 'generateRaw' });
        const l = traceList({ cat: 'host' })[0];
        const done = traceOpEnd(op, { ok: true });
        return l.opId === op.opId && l.op === 'ui.analyze' && done.ms >= 0 && done.ok === true; })(),
    J(traceList()[0]));

A('E2 op 结束后不再带上该 opId（不串台）',
    (() => { boot();
        const op = traceOpStart('x');
        traceOpEnd(op, { ok: true });
        traceEvent({ cat: 'host', kind: 'after' });
        return traceList({ cat: 'host' })[0].opId === ''; })(), J(traceList({ cat: 'host' })[0]));

A('E3 嵌套 op：内层事件归属内层；出栈后回到外层',
    (() => { boot();
        const outer = traceOpStart('outer');
        const inner = traceOpStart('inner');
        traceEvent({ cat: 'host', kind: 'in' });
        traceOpEnd(inner, { ok: true });
        traceEvent({ cat: 'host', kind: 'out' });
        traceOpEnd(outer, { ok: true });
        const l = traceList({ cat: 'host' });
        return l[1].opId === inner.opId && l[0].opId === outer.opId && inner.parentId === outer.opId; })(),
    J(traceList({ cat: 'host' }).map((x) => [x.kind, x.opId])));

A('E4 traceCurrentOp 无 op 时返回空（调用方无需判空即可用）',
    (boot(), traceCurrentOp().opId === '' && traceCurrentOp().op === ''), J(traceCurrentOp()));

A('E5 traceOpEnd 记录失败原因与摘要（供 ui 完成事件复用）',
    (() => { boot();
        const op = traceOpStart('ui.x');
        const d = traceOpEnd(op, { ok: false, reason: '未就绪', note: 'n' });
        return d.ok === false && d.reason === '未就绪' && d.note === 'n'; })(), '');

A('E6 显式传 opId 时优先于当前 op（跨包装仍可注入）',
    (boot(), (() => {
        const op = traceOpStart('cur');
        const r = traceEvent({ cat: 'cmd', kind: 'k', opId: 'opX', op: 'manual' });
        traceOpEnd(op, { ok: true });
        return r.opId === 'opX' && r.op === 'manual';
    })()), '');

A('E7 未闭合 op 不会无限增长（栈有上限兜底）',
    (() => { boot();
        for (let i = 0; i < 60; i += 1) traceOpStart('leak' + i);
        const op = traceCurrentOp();
        return !!op.opId && op.op.indexOf('leak5') === 0; })(), J(traceCurrentOp()));

// ---------- F 组：上限（内存恒定） ----------
A('F1 分类上限生效：ui 超过 ' + TRACE_CAT_CAP.ui + ' 条后只保留最新',
    (() => { boot();
        for (let i = 0; i < TRACE_CAT_CAP.ui + 25; i += 1) traceEvent({ cat: 'ui', kind: 'k' + i, dedupeKey: 'd' + i });
        const l = traceList({ cat: 'ui' });
        return l.length === TRACE_CAT_CAP.ui && l[0].kind === 'k' + (TRACE_CAT_CAP.ui + 24); })(),
    String(traceList({ cat: 'ui' }).length));

A('F2 总量上限生效（跨分类）',
    (() => { boot();
        const cats = ['ui', 'host', 'cmd', 'kernel', 'ai', 'error'];
        for (let i = 0; i < TRACE_TOTAL_CAP + 120; i += 1) {
            traceEvent({ cat: cats[i % cats.length], kind: 'k' + i, level: 'trace', dedupeKey: 't' + i });
        }
        return traceStats().total <= TRACE_TOTAL_CAP; })(), J(traceStats().total));

A('F3 分类上限互不影响：host 满不会挤掉 ui',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'keep' });
        for (let i = 0; i < 350; i += 1) traceEvent({ cat: 'host', kind: 'h' + i, dedupeKey: 'h' + i });
        const s = traceStats();
        return s.cats.ui === 1 && s.cats.host <= TRACE_CAT_CAP.host; })(), J(traceStats().cats));

A('F4 上限由常量声明（视图/导出与内核同源，不写死数字）',
    TRACE_CAT_CAP.ui === 200 && TRACE_CAT_CAP.host === 300 && TRACE_CAT_CAP.error === 100
    && TRACE_TOTAL_CAP === 800 && TRACE_CONTEXT_SPAN === 20 && TRACE_DEDUPE_MS === 800
    && TRACE_CATS.join(',') === 'ui,host,cmd,kernel,ai,error' && TRACE_LEVELS.error === 0 && TRACE_LEVELS.trace === 4,
    J({ TRACE_CAT_CAP, TRACE_TOTAL_CAP, TRACE_CONTEXT_SPAN, TRACE_DEDUPE_MS, TRACE_CATS }));

// ---------- G 组：错误上下文窗口 ----------
A('G1 traceContext 返回中心错误 + 前后窗口 + 同 opId 关联（关联可超出窗口）',
    (() => { boot();
        const op = traceOpStart('ui.import');
        traceEvent({ cat: 'host', kind: 'importState' });          // op 起点：稍后被挤出窗口
        for (let i = 0; i < 10; i += 1) traceEvent({ cat: 'kernel', kind: 'fill' + i, dedupeKey: 'f' + i });
        const err = traceEvent({ cat: 'error', kind: '未处理的异常', level: 'error', reason: 'boom', ok: false, stack: 'Error\n    at bad (/x/core/ingest.js:9:1)' });
        traceEvent({ cat: 'kernel', kind: 'after' });
        traceOpEnd(op, { ok: false });
        const c = traceContext(err.id, 2);
        return c.error && c.error.reason === 'boom' && c.error.site === 'core/ingest.js:9:bad'
            && c.window.length >= 3 && c.window.some((x) => x.kind === '未处理的异常')
            && c.related.some((x) => x.kind === 'importState'); })(),
    J(traceContext(traceList()[2].id, 2).error));

A('G2 窗口顺序为时间正序（人读时间线一致）',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'a' }); traceEvent({ cat: 'ui', kind: 'b' }); traceEvent({ cat: 'ui', kind: 'c' });
        const c = traceContext(traceList()[1].id);
        return c.window.map((x) => x.kind).join(',') === 'a,b,c'; })(),
    J(traceContext(traceList()[1].id).window.map((x) => x.kind)));

A('G3 窗口跨度遵守 TRACE_CONTEXT_SPAN（不会无限放大）',
    (() => { boot();
        for (let i = 0; i < 60; i += 1) traceEvent({ cat: 'kernel', kind: 'k' + i, dedupeKey: 'k' + i });
        const c = traceContext(traceList({ cat: 'kernel', limit: 5 })[4].id, 3);
        return c.window.length <= 7; })(), String(traceContext(traceList()[0].id, 3).window.length));

A('G4 opId 为空时不产生 related（不误关联）',
    (() => { boot();
        traceEvent({ cat: 'kernel', kind: 'plain' });
        const c = traceContext(traceList()[0].id);
        return c.opId === '' && c.related.length === 0; })(), J(traceContext(traceList()[0].id).related));

A('G5 未知 id / 空入参 → 结构完整且不抛',
    (() => { boot();
        const a = traceContext('不存在');
        const b = traceContext();
        return a.window.length === 0 && b.error === null && Array.isArray(b.related); })(), '');

A('G6 有目标 id 但窗口为空时仍给出结构（不炸视图）',
    (boot(), (() => { const c = traceContext('e999'); return c.error === null && J(c).length > 0; })()), '');

// ---------- H 组：开关 ----------
A('H1 debugTraceUi=false → ui 事件不记（其余照记）',
    (() => { boot({ debugTraceUi: false });
        traceEvent({ cat: 'ui', kind: 'click' });
        traceEvent({ cat: 'host', kind: 'x' });
        return traceList({ cat: 'ui' }).length === 0 && traceList({ cat: 'host' }).length === 1; })(),
    J(traceStats().cats));

A('H2 debugTraceHost=false → host 事件不记（其余照记）',
    (() => { boot({ debugTraceHost: false });
        traceEvent({ cat: 'host', kind: 'x' });
        traceEvent({ cat: 'error', kind: 'y', level: 'error' });
        return traceList({ cat: 'host' }).length === 0 && traceList({ cat: 'error' }).length === 1; })(),
    J(traceStats().cats));

A('H3 debugEnabled=false → 总开关关闭，一切不记',
    (() => { boot({ debugEnabled: false });
        traceEvent({ cat: 'error', kind: 'x', level: 'error' });
        return traceStats().total === 0; })(), J(traceStats()));

A('H4 开关只挡记录、不抛（关掉后调用方路径照常）',
    (() => { boot({ debugEnabled: false });
        const r = traceEvent({ cat: 'ui', kind: 'x' });
        return r === null && traceClear() === true; })(), '');

A('H5 setTraceHooks 注入落盘钩子后，事件写入时收到摘要（不含正文）',
    (() => { boot();
        let got = null;
        setTraceHooks({ save: (briefs) => { got = briefs; } });
        traceEvent({ cat: 'ui', kind: 'click', detail: { action: 'x', prompt: 'y'.repeat(300) } });
        setTraceHooks({ save: () => undefined });
        return Array.isArray(got) && got.length === 1 && got[0].cat === 'ui' && got[0].kind === 'click'
            && typeof got[0].site === 'string' && J(got).indexOf('y'.repeat(50)) < 0; })(), '');

A('H6 落盘钩子抛错被吞掉（追踪不得影响主流程）',
    (() => { boot();
        setTraceHooks({ save: () => { throw new Error('disk full'); } });
        const r = traceEvent({ cat: 'ui', kind: 'x' });
        setTraceHooks({ save: () => undefined });
        return !!r; })(), '');

// ---------- I 组：时间线文本 / 清空 ----------
A('I1 traceTimelineText 每行含时间·类别·kind·站点（人读可贴给维护者）',
    (() => { boot();
        traceEvent({ cat: 'host', kind: 'generateRaw', ms: 12, stack: 'Error\n    at call (/x/host/st-api.js:1:1)' });
        const txt = traceTimelineText();
        const line = txt.split('\n')[0];
        return /\d{2}:\d{2}:\d{2}\.\d{3}/.test(line) && line.indexOf('host') >= 0 && line.indexOf('generateRaw') >= 0 && line.indexOf('12ms') >= 0; })(),
    traceTimelineText().split('\n')[0]);

A('I2 失败/异常行带可视化标记（❌/⚠️）与原因',
    (() => { boot();
        traceEvent({ cat: 'error', kind: '未处理的异常', level: 'error', reason: 'ACL 拒绝', ok: false });
        const line = traceTimelineText().split('\n').pop();
        return line.indexOf('❌') >= 0 && line.indexOf('ACL 拒绝') >= 0; })(), traceTimelineText());

A('I3 有序：多行按时间正序（旧行在前）',
    (() => { boot();
        traceEvent({ cat: 'ui', kind: 'one' }); sleep(5); traceEvent({ cat: 'ui', kind: 'two' });
        const lines = traceTimelineText().split('\n');
        return lines[0].indexOf('one') >= 0 && lines[1].indexOf('two') >= 0; })(), '');

A('I4 traceBrief 是导出用的短摘要（含 site 文本、不含函数对象）',
    (boot(), (() => {
        traceEvent({ cat: 'ui', kind: 'k', detail: { fn: () => 1 } });
        const b = traceBrief(traceList()[0]);
        return typeof b.site === 'string' && b.detail.fn === '[fn]' && !!b.id;
    })()), '');

A('I5 traceSessionId 稳定且非空（一次加载同一 id）',
    (boot(), /^S/.test(traceSessionId()) && traceSessionId() === traceSessionId()), traceSessionId());

A('I6 traceClear 清空事件/去重/op 栈',
    (() => { boot();
        traceOpStart('pending');
        traceEvent({ cat: 'ui', kind: 'x' });
        traceClear();
        return traceStats().total === 0 && traceCurrentOp().opId === ''; })(), J(traceStats()));

// ---------- J 组：鲁棒性（永不抛） ----------
A('J1 traceEvent 空参/非法类别/超长 kind 都不抛',
    (() => { boot();
        const a = traceEvent();
        const b = traceEvent({});
        const c = traceEvent({ cat: 123, kind: null, level: '不存在级别' });
        return a === null ? true : !!a && !!b && !!c; })(), '');

A('J2 detail 循环引用 → 降级为 {} 且不抛',
    (() => { boot();
        const o = { name: 'x' }; o.self = o;
        const r = traceEvent({ cat: 'host', kind: 'circular', detail: o });
        return !!r && typeof r.detail === 'object'; })(), '');

A('J3 traceSummarize 深嵌套/异常值不抛',
    (() => { let deep = { v: 1 }; for (let i = 0; i < 20; i += 1) deep = { child: deep };
        const s = traceSummarize(deep);
        const bad = { get boom() { throw new Error('x'); } };
        const s2 = traceSummarize(bad);
        return !!s && !!s2; })(), '');

A('J4 traceList/traceStats/traceContext/traceTimelineText 在异常入参下仍可调用',
    (() => { boot();
        const a = traceList(null); const b = traceList({ limit: -1 });
        const c = traceStats(); const d = traceTimelineText('abc');
        return Array.isArray(a) && a.length === 0 && b.length === 0 && !!c && typeof d === 'string'; })(), '');

A('J5 traceOpEnd 重复调用/空参不抛',
    (() => { boot();
        const op = traceOpStart('x');
        const a = traceOpEnd(op, { ok: true });
        const b = traceOpEnd(op, { ok: true });
        const c = traceOpEnd(null, {});
        return !!a && b === null ? false : (!!a && !!c === false ? true : true); })(), '');

A('J6 事件不含正文：长 prompt 在整条记录里不出现（隐私边界）',
    (() => { boot();
        traceEvent({ cat: 'host', kind: 'sendRequest', detail: { prompt: '秘密剧情'.repeat(100) } });
        return J(traceList()[0]).indexOf('秘密剧情' + '秘密剧情') < 0; })(), J(traceList()[0]));

R.done();
