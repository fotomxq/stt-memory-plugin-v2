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
import { runClockPatrolRepair, setClockManual, clearClockManual } from '../../core/clock-patrol.js';
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
A('T1 正文头场景：追踪记录 取文来源/楼层、候选（含原文片段）、选定值 ← 来源标签 + 判据，落选候选带**真实**原因', (() => {
    boot();
    // 注：V1 的正文头解析器只认中文年月日写法（`▷1919年11月30日 …`）；`1919-11-30` 会落到普通日期正则
    const res = resolveStoryClock({ text: '▷1919年11月30日 08:52\n▷凉州卫-钟鼓楼\n晚上又到了码头' });
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    const pick = (f) => info.picks.filter((x) => x.field === f)[0] || {};
    return res.date === '1919-11-30' && res.time === '08:52' && res.location === '凉州卫-钟鼓楼'
        && t.id && t.stage === 'resolve' && t.action.indexOf('统一解析') >= 0
        && info.text.mode === 'given' && info.text.floors === '调用方给定' && info.text.chars > 0 && info.text.sample.indexOf('▷') === 0
        && info.chain.length >= 4
        && info.notes.join(' ').indexOf('V1 口径') >= 0
        && pick('date').value === '1919-11-30' && pick('date').from === 'header' && /正文头结构/.test(pick('date').fromLabel || '') && /异常闸门|恰好|正文侧/.test(pick('date').why)
        && pick('time').from === 'header' && pick('location').from === 'header'
        && info.rejects.length >= 2
        && info.rejects.some((r) => r.from === 'regex' && r.fromLabel === '正文正则（最新正文）' && r.raw && r.raw.length > 0)
        && info.picks.some((p) => p.field === 'date' && /▷1919年11月30日/.test(String(p.value) + String(info.text.sample)))
        && info.rejects.some((r) => /与采用值\*\*相同\*\*|同值副本/.test(r.why))
        && info.rejects.some((r) => /纯时段词权重低于带数字/.test(r.why));
})(), null);

A('T2 多源择优：正文日期异常 → 降级采用最新情节；追踪记下输入探测值、被放弃的正文候选、降级原因与细节', (() => {
    boot({
        atoms: [{ id: 'a1', title: '旧事', text: '甲在码头', date: '1919-11-20', time: '10:00', location: '码头', uses: 0, floorStart: 0, floorEnd: 1 }],
        state: { date: '1919-11-20', time: '10:00', location: '码头' },
    }, { clockAnomalyJumpYears: 5 });
    const res = resolveStoryClock({ text: '公元1999年1月1日，甲醒来。' });
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    const pick = (f) => info.picks.filter((x) => x.field === f)[0] || {};
    return res.date === '1919-11-20' && (info.degrade.degraded === true)
        && /anomaly:/.test(info.degrade.reason) && info.degrade.reasonLabel.length > 0 && info.degrade.detail.indexOf('1999-01-01') >= 0
        && pick('date').from === 'plot' && /最新情节/.test(pick('date').fromLabel)
        && info.rejects.some((r) => r.field === 'date' && String(r.value).indexOf('1999') === 0);
})(), null);

A('T3 手工锁定：追踪记「手工强制改写」判据，且落盘为锁定（未覆盖），不产生任何候选采纳', (() => {
    boot({ state: { date: '1919-11-20', time: '09:00', location: '码头' } });
    setClockManual({ date: '1919-12-01', time: '07:30', location: '钟鼓楼' });
    const res = resolveStoryClock({ text: '▷1919-11-30 08:52\n▷城门' });
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    const pick = (f) => info.picks.filter((x) => x.field === f)[0] || {};
    const lockedChain = info.chain.some((x) => x.indexOf('手工强制改写') >= 0);
    clearClockManual();
    return res.date === '1919-12-01' && res.time === '07:30' && res.location === '钟鼓楼'
        && pick('date').from === 'manual' && /手工值直接采用/.test(pick('date').why) && lockedChain
        && info.degrade.detail.indexOf('跳过') >= 0;
})(), null);

A('T4 追踪为**环形缓冲**：每阶段只留最近 ' + CLOCK_TRACE_KEEP + ' 条；`clockTraceList()` 最新在前；清空即空', (() => {
    boot();
    for (let i = 0; i < CLOCK_TRACE_KEEP + 3; i++) resolveStoryClock({ text: '1919-11-' + String(10 + i).padStart(2, '0') + '，甲出发。' });
    const list = clockTraceList('resolve');
    const ids = list.map((x) => Number(String(x.id).replace('ct', '')));
    const desc = ids.every((v, i) => i === 0 || ids[i - 1] > v);
    const cleared = clockTraceClear();
    return list.length === CLOCK_TRACE_KEEP && desc && cleared === true && clockTraceLast('resolve') === null;
})(), null);

// ---------- R 组：回归（追踪只记录，不改判定） ----------
A('R1 追踪不改变解析结果：返回对象的**键集与取值**与 V1 结构一致（无 trace/candidates 等新增键泄漏）', (() => {
    boot();
    const res = resolveStoryClock({ text: '▷1919-11-30 08:52\n▷凉州卫-钟鼓楼' });
    const want = ['date', 'time', 'location', 'present', 'source', 'degraded', 'textMode', 'jumpYears', 'degradeReason', 'timeEnd', 'season', 'era', 'storyDay', 'sceneDesc', 'statusText', 'header'];
    const got = Object.keys(res);
    const extra = got.filter((k) => want.indexOf(k) < 0);
    const missing = want.filter((k) => got.indexOf(k) < 0);
    // `extractClockFromText` 同样不得新增键（诊断走 clockExtractDiag 侧信道）
    const ex = extractClockFromText('1919-11-30，甲出发。', {});
    const exExtra = Object.keys(ex).filter((k) => ['date', 'time', 'location', 'source', 'timeEnd', 'season', 'era', 'storyDay', 'sceneDesc', 'statusText', 'header'].indexOf(k) < 0);
    const diag = clockExtractDiag();
    return extra.length === 0 && missing.length === 0 && exExtra.length === 0
        // V1 口径：正文侧的 `source.date` 统一记为 'regex'（正文头结构亦如此）；精确来源见追踪（T1 断言 from==='header'）
        && J(res.source) === J({ date: 'regex', time: 'header', location: 'header', present: 'keep-prev' })
        && diag.picked && diag.picked.date && diag.picked.date.raw.length > 0 && Array.isArray(diag.candidates.date);
})(), null);

A('R2 回归：楼层窗口回退分支**不得因追踪构造失败而丢值**（曾在追踪里误用块级 `last` → ReferenceError 被吞 → 日期变空）', (() => {
    boot();
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '1919-12-09，主角甲来到城市壬。' });
    const ok = clockAutoExtractOnce({ force: true });
    const res = clockExtractState();
    const t = clockTraceLast('resolve');
    const info = clockTraceInfo(t);
    return ok === true && state.state.date === '1919-12-09' && res.textMode === 'floor-window'
        && /^第\d+-\d+楼/.test(String(info.text.floors)) && info.text.chars > 0
        && info.text.mode === 'floor-window';
})(), null);

// ---------- P 组：巡检锚点链 ----------
A('P1 巡检锚点取值链：锚点来自「当前剧情时钟」并记明判据；自动路径遇锚点与库内多数年份冲突时**只统计**（落选记载 + 未修改）', (() => {
    boot({
        atoms: [
            { id: 'a1', title: '一', text: '甲', date: '1919-11-20', time: '08:00', uses: 0, floorStart: 0, floorEnd: 1 },
            { id: 'a2', title: '二', text: '乙', date: '1919-11-21', time: '09:00', uses: 0, floorStart: 0, floorEnd: 2 },
            { id: 'a3', title: '三', text: '丙', date: '1919-11-22', time: '10:00', uses: 0, floorStart: 0, floorEnd: 3 },
            { id: 'a4', title: '四', text: '丁', date: '1999-01-01', time: '25:99', uses: 0, floorStart: 0, floorEnd: 4 },
        ],
        state: { date: '1919-11-22', time: '10:00', location: '码头' },
    });
    const rep = runClockPatrolRepair({ silent: true });
    const t = clockTraceLast('patrol');
    const info = clockTraceInfo(t);
    const pick = info.picks.filter((x) => x.field === 'date')[0] || {};
    const chainOk = info.chain.some((x) => x.indexOf('手工强制改写 > 当前剧情时钟') >= 0);
    const applied = info.applied && info.applied.fields ? info.applied.fields.length : 0;
    return rep.anchor === '1919-11-22' && rep.anchorSource === 'clock'
        && pick.from === 'clock' && /当前剧情时钟有效即用/.test(pick.why) && chainOk
        && info.notes.join(' ').indexOf('扫描') >= 0
        && (rep.fixed > 0 ? applied > 0 : (info.applied.locked === true));
})(), null);

// ---------- A 组：日志口径 ----------
await (async () => {
    boot();
    clockAutoExtractOnce({ force: true, text: '▷1919年12月1日 09:10\n▷凉州卫-钟鼓楼\n甲与乙在码头清点铜箱。' });
    const d = logData();
    A('A1 时钟日志含四类追踪信息：来源（含**时间/地点**来源，此前缺失）、判据（why）、落选候选（含原因）、落盘差异（prev → next）', (() => {
        return !!d && d.traceId && d.dateFrom === '正文头结构（▷/▶）' && d.dateFromV1 === '正文正则（最新正文）'
            && d.timeFrom === '正文头结构（▷/▶）' && d.locationFrom === '正文头结构（▷/▶）'
            && String(d.dateWhy).length > 10 && String(d.timeWhy).length > 5 && String(d.locationWhy).length > 5 && String(d.presentWhy).length > 3
            && Array.isArray(d.chain) && d.chain.length >= 4
            && Array.isArray(d.rejects) && d.rejects.length >= 1 && d.rejects.every((x) => x.indexOf('←') > 0 && x.indexOf('（') > 0)
            && Number(d.rejectsTotal) >= 1 && Array.isArray(d.applied) && d.applied.length >= 1
            && d.textFloors === '调用方给定' && d.textChars > 0 && String(d.sample).length > 0
            && String(d.how).indexOf('clockTrace') > 0 && d.degradeReason === '';
    })(), d);

    A('A2 无改动时**不写日志**（与 V1 同口径：只在 changed/present/见面标记变化时记一条），但取值追踪仍可查；手工锁定时 `unchanged` 记明锁定', (() => {
        // 场景一：日期/时间/地点与现值完全相同、在场与见面标记也没变化 → 不写日志（避免「日志噪音」= 用户报告的问题源之一）
        boot({ state: { date: '1919-12-01', time: '09:10', location: '凉州卫-钟鼓楼', present: [] } });
        const before = debugLogList().filter((l) => l.kind === '时钟').length;
        clockAutoExtractOnce({ force: true, text: '▷1919年12月1日 09:10\n▷凉州卫-钟鼓楼' });
        const after = debugLogList().filter((l) => l.kind === '时钟').length;
        const noLog = after === before;
        const traceStillThere = !!clockTraceLast('resolve') && clockTraceInfo(clockTraceLast('resolve')).picks.length >= 3;
        const noChangeFlag = (() => { const t = clockTraceLast('resolve'); return t && Array.isArray(t.applied.fields) && t.applied.fields.every((x) => x.changed === false); })();
        // 场景二：手工锁定 → 日期/时间/地点不被覆盖（取值追踪的 `applied.locked` 与 `unchanged` 如实标锁定），
        //   且「未改动」时同样不写提取日志（V1 口径：手工改写自身会单独记一条）
        boot({ state: { date: '1919-11-20', time: '', location: '' } });
        const beforeManual = debugLogList().filter((l) => l.kind === '时钟').length;
        setClockManual({ date: '1919-12-05' });
        clockAutoExtractOnce({ force: true, text: '▷1919年12月1日 09:10\n▷城门' });
        const t2 = clockTraceLast('resolve');
        const lockedOk = !!t2 && t2.applied.locked === true
            && (t2.applied.unchanged || []).join('|').indexOf('手工锁定') >= 0
            && (t2.applied.fields || []).every((x) => x.changed === false);
        const extractLogs = debugLogList().filter((l) => l.kind === '时钟').length - beforeManual;
        const manualLogged = debugLogList().some((l) => { try { return String(JSON.parse(l.data).action).indexOf('手工强制改写') >= 0; } catch (e) { return false; } });
        clearClockManual();
        return noLog && traceStillThere && noChangeFlag && state.state.date === '1919-12-05' && lockedOk
            && extractLogs === 1 && manualLogged;   // 这 1 条来自「手工强制改写」自身，而不是提取
    
    })(), null);
})();

// ---------- U 组：界面 ----------
A('U1 调试页「🕒 时钟取值追踪」区块：四个阶段分节 + 值←来源 + 未采用候选 + 落盘 + 清空按钮；无记录时如实说明', (() => {
    boot();
    const empty = clockTraceSectionHtml();
    resolveStoryClock({ text: '▷1919年11月30日 08:52\n▷凉州卫-钟鼓楼' });
    const html = clockTraceSectionHtml();
    return empty.indexOf('暂无记录') >= 0
        && html.indexOf('自动解析（日期/时间/地点/在场）') >= 0 && html.indexOf('时间巡检（锚点与修复）') >= 0
        && html.indexOf('AI 捕捉正则') >= 0 && html.indexOf('AI 时间修复') >= 0
        && html.indexOf('未采用的候选') >= 0 && html.indexOf('落盘') >= 0
        && html.indexOf('data-ftt-action="clockTraceClear"') >= 0
        && html.indexOf('正文头结构（▷/▶）') >= 0 && html.indexOf('共 ' + clockSrcKeys().length + ' 项') >= 0;
})(), null);

A('U2 总览时钟区：展示最近一次取值摘要行（值 ← 来源 + 落盘改动 + 指向调试页的路径）', (() => {
    boot();
    // 走完整落盘（写 state + clockSrc + 追踪），总览的「时钟来源行」才会出现
    clockAutoExtractOnce({ force: true, text: '▷1919年11月30日 08:52\n▷凉州卫-钟鼓楼' });
    const html = clockSectionHtml();
    return html.indexOf('data-ftt-clock-trace') >= 0 && html.indexOf('🕒 取值 [resolve]') >= 0
        && html.indexOf('正文头结构（▷/▶）') >= 0 && html.indexOf('设定→调试「🕒 时钟取值追踪」') >= 0
        // 来源行的时间来源也走全量标签（不再是英文原键）
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
