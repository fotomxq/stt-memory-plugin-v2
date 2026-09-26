// ============================================================
// 单元测试 · B8-2 剧情时钟自动提取（与**真实 V1 插件**逐项比对 + 落盘/调度接线）
// 黄金样本：tests/fixtures/v1-golden-clock-extract.json（oracle = 真实 V1 插件 v1.206，逐例回放 cfg 补丁与 state）
// 覆盖：extractClockFromHeader（▷/▶ 正文头）/ extractClockFromText（正则 / 标记式 / 正文头 / 相对推进 / 自定义正则 / 时段词）/
//   resolveStoryClock（多源择优 + 日期异常降级 + 强制降级 + 场景兜底 + 沿用旧值 + 第 N 天纪元换算 + 手工锁定/未锁定）/
//   latestSceneLocation / resolvePresentNames + clockAutoExtractOnce（落盘 + clockSrc + 在场 + 手工锁定不覆盖）+ scheduleClockExtract。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    extractClockFromHeader, extractClockFromText, resolveStoryClock, resolvePresentNames,
    latestSceneLocation, clockAutoExtractOnce, scheduleClockExtract, clockExtractState, setClockTextHooks,
} from '../../core/clock-extract.js';
import { setClockManual, clearClockManual } from '../../core/clock-patrol.js';
import { clockSectionHtml } from '../../ui/clock.js';
import { panelAction, openPanel, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock-extract.json'), 'utf8'));
const R = makeReporter('clock-extract-golden B8-2 剧情时钟自动提取（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

/** 装默认配置 + 指定 state（逐例回放 oracle 输入） */
function boot(stateLike, cfgPatch) {
    // v2.51.0：这些旧设定已从默认配置删除 —— 显式清除，避免上一用例的残留值影响独立解析器的对照
    ['clockRegexPreset', 'clockRelative', 'clockDateRegex', 'clockTimeRegex', 'clockLocationRegex',
        'clockStoryDayEpoch', 'clockForceDegrade', 'clockAnomalyJumpYears', 'clockAutoPatrol', 'clockPatrolAutoFix']
        .forEach((k) => { try { delete cfg[k]; } catch (e) { /* 忽略 */ } });
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
    return state;
}

// ============================================================
// H 组：正文头结构 / 文本提取 / 统一解析（与 V1 逐例一致）
// ============================================================
R.assert('H1 正文头结构 extractClockFromHeader：日期/纪年/季节/场景描述/地点路径/第 N 天/时间区间/状态 逐项一致', (() => {
    boot({});
    const bad = G.header.filter((c) => J(extractClockFromHeader(c.text)) !== J(c.out));
    return bad.length === 0;
})(), G.header.map((c) => [extractClockFromHeader(c.text), c.out]));

R.assert('H2 文本提取 extractClockFromText：9 例（正则/带已存年份/标记式/正文头/相对推进开关/自定义正则/纯时段词/空文本）逐例一致', (() => {
    const bad = [];
    for (const c of G.extract) {
        boot({}, c.cfg);
        const got = extractClockFromText(c.text, c.prev);
        if (J(got) !== J(c.out)) bad.push({ tag: c.tag, got, want: c.out });
    }
    return bad.length === 0;
})(), (() => {
    const bad = [];
    for (const c of G.extract) {
        boot({}, c.cfg);
        const got = extractClockFromText(c.text, c.prev);
        if (J(got) !== J(c.out)) bad.push({ tag: c.tag, got, want: c.out });
    }
    return bad.slice(0, 3);
})());
R.assert('H3（v2.51.0 改版）统一解析 resolveStoryClock：**只取最新情节**的 date/time/location；正文/其它类别一律不参与', (() => {
    const cases = [
        { tag: 'plot-wins', atoms: [
            { id: 'p1', text: '剧情正文里写着 1919年12月31日 23:59。', date: '1919-11-30', time: '08:52', location: '凉州卫-钟鼓楼', floorStart: 5, floorEnd: 5, uses: 1, tags: [] },
        ], want: { date: '1919-11-30', time: '08:52', location: '凉州卫-钟鼓楼' } },
        { tag: 'plot-newest-by-floor', atoms: [
            { id: 'p1', text: '旧。', date: '1919-11-18', floorStart: 1, floorEnd: 2, uses: 0, tags: [] },
            { id: 'p2', text: '新。', date: '1919-11-25', time: '夜里', floorStart: 9, floorEnd: 9, uses: 0, tags: [] },
        ], want: { date: '1919-11-25', time: '夜里', location: '' } },
        { tag: 'summary-excluded', atoms: [
            { id: 'p1', text: '被总结的原文。', date: '1919-11-20', floorStart: 25, floorEnd: 25, uses: 0, tags: [], summarizedBy: 's1' },
            { id: 's1', text: '情节总结条。', date: '2035-01-01', floorStart: 30, floorEnd: 30, uses: 0, tags: [], mergedSummary: { by: 'auto', sourceCount: 1 } },
            { id: 'p2', text: '可用情节。', date: '1919-11-22', floorStart: 10, floorEnd: 10, uses: 0, tags: [] },
        ], want: { date: '1919-11-22', time: '', location: '' } },
    ];
    const bad = [];
    for (const c of cases) {
        boot({ atoms: c.atoms, state: { date: '', time: '', location: '' } });
        setClockTextHooks({ latestAiText: () => '正文里的 1919年12月31日 不该被采纳', floorWindowText: () => '同上' });
        const r = resolveStoryClock({});
        const got = { date: r.date, time: r.time, location: r.location };
        if (J(got) !== J(c.want)) bad.push({ tag: c.tag, got, want: c.want });
    }
    return bad.length === 0;
})(), (() => {
    boot({ atoms: [{ id: 'p1', text: '正文 1919年12月31日', date: '1919-11-30', time: '08:52', location: '凉州卫-钟鼓楼', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }], state: { date: '', time: '', location: '' } });
    setClockTextHooks({ latestAiText: () => '正文 1919年12月31日', floorWindowText: () => '' });
    return J(resolveStoryClock({}));
})());


R.assert('S1 降级地点来源 latestSceneLocation：无当前地点 → 取楼层最新场景；与当前地点同路径 → 优先同路径', (() => {
    const st = clone(G.resolve[0].state);
    boot(st);
    const a = latestSceneLocation();
    boot(st);
    state.state.location = '城市甲·码头';
    const b = latestSceneLocation();
    return a === G.latestScene && b === G.latestSceneSamePath;
})(), '');

R.assert('S2 在场解析 resolvePresentNames：最新正文命中 / 最新情节涉及角色 / 两侧都无 → 保留旧名单（null 不限制）', (() => {
    boot(G.resolve[0].state);
    const got = [
        ['text-hit', resolvePresentNames('主角甲走进房间，另有一人。', null)],
        ['plot-hit', resolvePresentNames('', { entities: ['主角甲'] })],
        ['none', resolvePresentNames('', { entities: [] })],
    ];
    return J(got) === J(G.present);
})(), (() => [resolvePresentNames('主角甲走进房间。', null), resolvePresentNames('', { entities: [] })]));

// ============================================================
// A 组：落盘与调度
// ============================================================
R.assert('A1（v2.51.0 改版）clockAutoExtractOnce：从**最新情节**落盘 日期/时间/地点 + clockSrc 来源（不再有正文头附加字段/降级）', (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '凉州卫·钟鼓楼', floorStart: 5, floorEnd: 5, uses: 1, tags: ['码头'] }], state: { date: '', time: '', location: '', present: [] } });
    const ok = clockAutoExtractOnce({ force: true });
    const cs = state.state.clockSrc || {};
    return ok === true && state.state.date === '1919-11-30' && state.state.time === '08:52'
        && state.state.location === '凉州卫·钟鼓楼' && cs.date === 'plot' && cs.time === 'plot' && cs.location === 'plot'
        && state.state.header === undefined && state.state.storyDay === undefined;
})(), (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '凉州卫·钟鼓楼', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }], state: { date: '' } });
    clockAutoExtractOnce({ force: true });
    return J({ state: state.state });
})());


R.assert('A2 clockAutoExtractOnce 幂等：同文本再跑一次 → 无改动（不重复落盘）', (() => {
    boot(G.resolve[0].state);
    clockAutoExtractOnce({ text: G.header[0].text, force: true });
    const again = clockAutoExtractOnce({ text: G.header[0].text, force: true });
    return again === false;
})(), '');
R.assert('A3（v2.51.0 改版）手工锁定：不覆盖 日期/时间/地点；解锁后按**最新情节**同步', (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '码头', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }], state: { date: '1900-01-01', time: '01:00', location: '旧地点' } });
    setClockManual({ date: '1919-11-01', time: '02:00', location: '手工地点' });
    clockAutoExtractOnce({ force: true });
    const locked = J({ d: state.state.date, t: state.state.time, l: state.state.location });
    clearClockManual();
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '码头', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }], state: { date: '', time: '', location: '' } });
    clockAutoExtractOnce({ force: true });
    const unlocked = J({ d: state.state.date, t: state.state.time, l: state.state.location });
    return locked === J({ d: '1919-11-01', t: '02:00', l: '手工地点' })
        && unlocked === J({ d: '1919-11-30', t: '08:52', l: '码头' });
})(), '');


R.assert('A4 开关关门：cfg.clockExtractEnabled=false 或 cfg.enabled=false → 不提取（force 可绕过，供测试与手动）', (() => {
    boot(G.resolve[0].state, { clockExtractEnabled: false });
    const off1 = clockAutoExtractOnce({ text: G.header[0].text });
    const forced = clockAutoExtractOnce({ text: G.header[0].text, force: true });
    boot(G.resolve[0].state, { enabled: false });
    const off2 = clockAutoExtractOnce({ text: G.header[0].text });
    return off1 === false && forced === true && off2 === false;
})(), '');

R.assert('A5 scheduleClockExtract：`cfg.clockExtractEnabled=false` 不排程；开启时经 timerHooks 排程一次（防重复）', (() => {
    boot(G.resolve[0].state, { clockExtractEnabled: false });
    const a = scheduleClockExtract();
    let fired = 0;
    setTimerHooks({ set: (fn) => { fired++; fn(); return 1; }, clear: () => undefined });
    boot(G.resolve[0].state, { clockExtractEnabled: true });
    setClockTextHooks({ latestAiText: () => G.header[0].text });
    const b = scheduleClockExtract();
    const c = scheduleClockExtract();      // 已排程 → 不重复
    setTimerHooks({ set: () => 0, clear: () => undefined });
    // fired ≥ 1：第一次是时钟提取本身，后续可能来自「剧情日期推进 → 调度状态记录衰退」（同一 timerHooks）
    return a === false && b === true && c === false && fired >= 1 && state.state.date === G.resolve[0].out.date;
})(), '');
R.assert('A6（v2.51.0 改版）正文/楼层窗口文本**不再参与**时钟（即便提供了窗口文本，时钟仍只取情节）', (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }], state: { date: '' } });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '▷1919年12月31日 08:00 正文' });
    const r = resolveStoryClock({});
    return r.date === '1919-11-30' && r.source.date === 'plot' && r.textMode === 'plot-only';
})(), (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }], state: { date: '' } });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '▷1919年12月31日' });
    return J(resolveStoryClock({}));
})());

R.assert('U1（v2.51.0 改版 + v2.66.0 精简）总览时钟区：紧凑一块显示 日期/时间/地点/在场；不再有「时钟来源」提示与降级/巡检/第N天等废弃说法', (() => {
    boot({ atoms: [{ id: 'p1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '城市甲·码头', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }], state: { date: '', time: '', location: '', present: ['甲'] } });
    clockAutoExtractOnce({ force: true });
    const html = String(panelBodyHtml('overview') || '');
    const gone = ['已降级', '日期较此前跳变', '时间巡检', '剧情第 ', '校准用', '🕒 时钟来源：', 'data-ftt-clock-src', 'data-ftt-clock-trace'];
    return html.indexOf('data-ftt-clock') >= 0 && html.indexOf('ftt-clock-line') >= 0
        && html.indexOf('📅 日期：1919-11-30') >= 0 && html.indexOf('⏱ 时间：08:52') >= 0
        && html.indexOf('📍 地点：城市甲·码头') >= 0 && html.indexOf('👥 在场角色：甲') >= 0
        && gone.every((t) => html.indexOf(t) < 0);
})(), '');

un();
R.done();
