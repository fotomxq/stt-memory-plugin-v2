// ============================================================
// 单元测试 · v2.37.0「时钟取值追踪」（值从哪来 / 取值逻辑 / 有什么没被采用 / 这次改了什么）
// 背景（用户要求）：「时钟日志记录有问题，需明确**从哪里取值、取值逻辑是什么**，以方便追踪问题。」
// 本批把时钟域的取值过程记成结构化追踪（`core/clock-trace.js`），并在日志/调试页/总览展示。
// 覆盖：
//   L 组：来源标签全量登记（与产源键集合不脱节）+ 未知键如实标注；
//   T 组：追踪结构（取文/候选/择优/落选原因/降级/落盘）逐场景；
//   S 组：正文头 vs 正则 vs 时段词 的落选原因必须是**真实规则**（不是泛泛「更早」）；
//   D 组：降级链（无日期 / 强制降级 / 日期异常）如实记录原因与细节；
//   P 组：巡检锚点取值链（手工 > 当前时钟 > 多数派）+ conflict 落选记载；
//   R 组：**回归**——追踪只记录、不改判定（返回结构与既有键集不变；floor-window 分支不得因追踪报错而丢值）；
//   A 组：日志字段（`dbgLog('时钟')`）含「来源/理由/落选/落盘」四类信息；构造失败走「异常」类而非静默；
//   U 组：调试页区块与总览摘要行渲染。
// 运行：node tests/unit/clock-trace.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setTimerHooks, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    CLOCK_SRC_LABEL, CLOCK_DEGRADE_LABEL, clockSrcLabel, clockDegradeLabel, clockSrcKeys,
    clockTraceStart, clockTraceText, clockTraceChain, clockTracePick, clockTraceReject,
    clockTraceDegrade, clockTraceApplied, clockTraceFinish, clockTraceLast, clockTraceList,
    clockTraceSummary, clockTraceInfo, clockTraceClear, CLOCK_TRACE_KEEP,
} from '../../core/clock-trace.js';
import {
    extractClockFromText, clockExtractDiag, resolveStoryClock, clockAutoExtractOnce,
    clockExtractState, setClockTextHooks, scheduleClockExtract,
} from '../../core/clock-extract.js';
import { setClockManual, clearClockManual } from '../../core/clock-patrol.js';
import { clockTraceSectionHtml } from '../../ui/debug.js';
import { clockSectionHtml } from '../../ui/clock.js';
import { debugLogList, wireDebugLog, debugLogPush } from '../../adapters/debug-log.js';

const R = makeReporter('clock-trace v2.37.0 时钟取值追踪');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
// 内核 `dbgLog` 默认 no-op → 单测直接把日志钩子接到适配层（等价于 index.js 的接线）
setChatHooks({
    latestAiFloorText: () => '',
    dbgLog: (kind, data) => debugLogPush(kind, data),
});

const clone = (o) => JSON.parse(JSON.stringify(o || {}));
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 1; }, clear: () => undefined });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
    clockTraceClear();
    return state;
}
const lastLog = () => debugLogList().filter((l) => l.kind === '时钟')[0] || null;
const logData = () => { const l = lastLog(); if (!l) return null; try { return JSON.parse(l.data); } catch (e) { return null; } };

// ---------- L 组：来源标签全量登记 ----------
A('L1 来源标签表覆盖全部产源键（正文正则/正文头/自定义正则/标记式/纯时段词/相对推进/纪元换算/最新情节/原子降级/最新场景/沿用旧值/手工/在场三源/锚点四源），未知键如实标注「（未登记）」', (() => {
    const must = ['regex', 'header', 'custom', 'marker', 'daypart', 'relative', 'storyday', 'plot', 'atom-latest', 'prev', 'scene',
        'manual', 'latest-ai', 'plot-atom', 'keep-prev', 'clock', 'atoms-majority'];
    const miss = must.filter((k) => !CLOCK_SRC_LABEL[k]);
    return miss.length === 0 && clockSrcKeys().length >= 17
        && clockSrcLabel('regex') === '正文正则（最新正文）' && clockSrcLabel('scene') === '最新场景（降级）'
        && clockSrcLabel('') === '—' && clockSrcLabel('nope') === 'nope（未登记）'
        && clockDegradeLabel('anomaly:jump').indexOf('年份远超') >= 0 && clockDegradeLabel('').length === 0
        && Object.keys(CLOCK_DEGRADE_LABEL).length === 5;
})(), CLOCK_SRC_LABEL);

// ---------- T 组：追踪结构 ----------
// ---------- T 组（v2.51.0 改版）：追踪如实记录「只取最新情节」 ----------
A('T1（v2.51.0 改版）追踪记录：取值来源 = 最新情节（`source.date === "plot"` + 情节 id/楼层），无正文候选', (() => {
    boot();
    state.atoms = [
        { id: 'a-old', text: '旧情节。', date: '1919-11-18', floorStart: 1, floorEnd: 2, uses: 0, tags: [] },
        { id: 'a-new', text: '最新情节。', date: '1919-11-30', time: '08:52', location: '凉州卫-钟鼓楼', floorStart: 9, floorEnd: 9, uses: 1, tags: [] },
    ];
    const res = resolveStoryClock({ text: '▷1919年12月31日 23:59 正文里另有日期（不再被采纳）' });
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    const dp = info.picks.filter((x) => x.field === 'date')[0] || {};
    return res.date === '1919-11-30' && res.time === '08:52' && res.location === '凉州卫-钟鼓楼'
        && res.source.date === 'plot' && res.plotId === 'a-new' && Number(res.plotFloor) === 9
        && res.textMode === 'plot-only' && dp.from === 'plot'
        && J(info.candidates || {}) === J({});
})(), (() => {
    boot();
    state.atoms = [{ id: 'a-new', text: '最新情节。', date: '1919-11-30', time: '08:52', floorStart: 9, floorEnd: 9, uses: 1, tags: [] }];
    return J(resolveStoryClock({ text: '▷1919年12月31日' }));
})());

A('T2（v2.51.0 改版）最新情节缺日期 → 只在**情节内**退到次新带日期项（仍不引入其它来源）', (() => {
    boot();
    state.atoms = [
        { id: 'a-dated', text: '有日期的情节。', date: '1919-11-18', floorStart: 1, floorEnd: 2, uses: 0, tags: [] },
        { id: 'a-nodate', text: '最新但没写日期。', date: '', floorStart: 9, floorEnd: 9, uses: 1, tags: [] },
    ];
    const res = resolveStoryClock({ text: '▷1919年12月31日（正文日期不参与）' });
    return res.date === '1919-11-18' && res.source.date === 'plot' && res.plotId === 'a-dated';
})(), (() => {
    boot();
    state.atoms = [
        { id: 'a-dated', text: '有日期的情节。', date: '1919-11-18', floorStart: 1, floorEnd: 2, uses: 0, tags: [] },
        { id: 'a-nodate', text: '最新但没写日期。', date: '', floorStart: 9, floorEnd: 9, uses: 1, tags: [] },
    ];
    return J(resolveStoryClock({}));
})());

// ---------- R 组：回归（追踪只记录，不改判定） ----------
A('R1（v2.51.0 改版）追踪不改变解析结果：返回键集固定（含 plotId/plotFloor），无 trace/candidates 泄漏', (() => {
    boot();
    state.atoms = [{ id: 'a1', text: '情节。', date: '1919-11-20', time: '傍晚', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }];
    const a = resolveStoryClock({});
    const b = resolveStoryClock({});
    const KEYS = ['date', 'time', 'location', 'present', 'source', 'degraded', 'textMode', 'jumpYears', 'timeEnd', 'season', 'era', 'storyDay', 'sceneDesc', 'statusText', 'header', 'plotId', 'plotFloor'];
    return J(Object.keys(a).sort()) === J(KEYS.slice().sort()) && J(a) === J(b);
})(), (() => { boot(); return J(Object.keys(resolveStoryClock({})).sort()); })());

A('R2（v2.51.0 改版）**没有可用情节**时：不改动时钟（保持原值）、不抛错、追踪如实说明', (() => {
    boot();
    state.atoms = [];
    state.state = { date: '1919-11-01', time: '清晨', location: '旧地点', present: [] };
    const res = resolveStoryClock({ text: '▷1919年12月31日' });
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    return res.date === '' && res.time === '' && res.location === ''
        && String((info.notes || []).join(' ')).indexOf('没有任何可用情节') >= 0
        && state.state.date === '1919-11-01';
})(), (() => {
    boot();
    state.atoms = [];
    state.state = { date: '1919-11-01', present: [] };
    const r = resolveStoryClock({});
    return J({ r, kept: state.state.date });
})());

// ---------- P 组：巡检锚点链 ----------
A('U1（v2.55.0）调试页「🕒 时钟取值追踪」区块：只保留「自动解析（只取最新情节）」与「AI 时间修复」两节 + 落盘 + 清空；空态一句「暂无记录」；不含开发说明（来源表规模/dev 路径）', (() => {
    boot();
    const empty = clockTraceSectionHtml();
    resolveStoryClock({ text: '▷1919年11月30日 08:52\n▷凉州卫-钟鼓楼' });
    const html = clockTraceSectionHtml();
    // v2.51.0：巡检与「AI 捕捉正则」两块已随功能移除；v2.55.0：删除「字段含义…共 N 项 / core/clock-trace.js」等开发说明
    return empty.indexOf('暂无记录') >= 0
        && html.indexOf('自动解析（只取最新情节：日期/时间/地点/在场）') >= 0
        && html.indexOf('时间巡检') < 0 && html.indexOf('AI 捕捉正则') < 0
        && html.indexOf('落盘') >= 0
        && html.indexOf('data-ftt-action="clockTraceClear"') >= 0
        && html.indexOf('取值口径：') >= 0 && html.indexOf('值 ← 来源') >= 0
        && html.indexOf('clock-trace') < 0 && html.indexOf('共 ' + clockSrcKeys().length + ' 项') < 0
        && html.indexOf(' 项') < 0;
})(), null);

A('U2 总览时钟区：展示最近一次取值摘要行（值 ← 来源 + 落盘改动 + 指向调试页的路径）', (() => {
    boot();
    // 走完整落盘（写 state + clockSrc + 追踪），总览的「时钟来源行」才会出现
    state.atoms = [{ id: 'a1', text: '最新情节。', date: '1919-11-30', time: '08:52', location: '凉州卫-钟鼓楼', floorStart: 9, floorEnd: 9, uses: 1, tags: [] }];
    clockAutoExtractOnce({ force: true });
    const html = clockSectionHtml();
    return html.indexOf('data-ftt-clock-trace') >= 0 && html.indexOf('🕒 取值 [resolve]') >= 0
        && html.indexOf('设定→调试「🕒 时钟取值追踪」') >= 0
        && html.indexOf('data-ftt-clock-src') >= 0;
})(), null);

A('U3 摘要与结构化信息一致：`clockTraceSummary` 含四字段与落盘结论；`clockTraceInfo().picks` 逐字段带中文来源名', (() => {
    const t = clockTraceStart('probe', '摘要自检');
    clockTraceText(t, { mode: 'given', floors: '调用方给定', chars: 12, sample: '样本' });
    clockTracePick(t, 'date', { value: '1919-11-30', from: 'header', why: '正文头结构命中' });
    clockTraceReject(t, { field: 'time', value: '晚上', from: 'daypart', raw: '晚上到了码头', why: '纯时段词权重更低' });
    clockTraceDegrade(t, { degraded: true, reason: 'no-date', detail: '正文无日期' });
    clockTraceApplied(t, { fields: [{ field: 'date', from: '1919-11-29', to: '1919-11-30', changed: true }], locked: false, unchanged: ['time'], present: null });
    clockTraceFinish(t);
    const info = clockTraceInfo(t);
    const sum = clockTraceSummary(t);
    return sum.indexOf('[probe]') > 0 && sum.indexOf('date 1919-11-30←正文头结构（▷/▶）') > 0 && sum.indexOf('⚠️降级：正文未识别到日期') > 0
        && sum.indexOf('落盘改动：date') > 0
        && info.picks.filter((x) => x.field === 'date')[0].fromLabel === '正文头结构（▷/▶）'
        && info.rejects[0].fromLabel === '纯时段词（清晨/晚上…）' && info.degrade.reasonLabel === '正文未识别到日期'
        && info.applied.fields[0].changed === true && info.applied.unchanged[0] === 'time';
})(), null);

un();
R.done();
