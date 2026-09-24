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
import { setClockManual } from '../../core/clock-patrol.js';
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

R.assert('H3 统一解析 resolveStoryClock：10 例（正文头胜出/正则与情节择优/异常降级/强制降级/场景兜底/沿用旧值/纪元换算/手工锁定）逐例一致', (() => {
    const bad = [];
    for (const c of G.resolve) {
        boot(c.state, c.cfg);
        const got = resolveStoryClock(c.opts);
        if (J(got) !== J(c.out)) bad.push({ tag: c.tag, got, want: c.out });
    }
    return bad.length === 0;
})(), (() => {
    const bad = [];
    for (const c of G.resolve) {
        boot(c.state, c.cfg);
        const got = resolveStoryClock(c.opts);
        if (J(got) !== J(c.out)) bad.push({ tag: c.tag, keys: Object.keys(got) });
    }
    return bad;
})());

// ============================================================
// S 组：场景 / 在场
// ============================================================
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
R.assert('A1 clockAutoExtractOnce：写 日期/时间/地点（与 resolveStoryClock 同源）+ 正文头附加字段（时间区间/季节/纪年/剧情天数/场景描述）+ clockSrc 来源 + 在场', (() => {
    boot(G.resolve[0].state);
    const ok = clockAutoExtractOnce({ text: G.header[0].text, force: true });
    const st = state.state;
    const res = clockExtractState();
    const want = G.resolve[0].out;                      // 与 V1 同一判据：日期取最新候选（此处为最新情节）
    return ok === true && st.date === want.date && st.time === want.time && st.location === want.location
        && st.timeEnd === want.timeEnd && st.season === want.season && st.era === want.era
        && st.storyDay === want.storyDay && st.sceneDesc === want.sceneDesc && st.statusText === want.statusText
        && st.clockSrc && st.clockSrc.date === want.source.date && st.clockSrc.time === want.source.time
        && st.clockSrc.location === want.source.location && st.clockSrc.degraded === want.degraded
        && st.clockSrc.degradeReason === want.degradeReason
        && Array.isArray(st.present) && J(st.present) === J(want.present)
        && res && res.header === true;
})(), (() => state.state));

R.assert('A2 clockAutoExtractOnce 幂等：同文本再跑一次 → 无改动（不重复落盘）', (() => {
    boot(G.resolve[0].state);
    clockAutoExtractOnce({ text: G.header[0].text, force: true });
    const again = clockAutoExtractOnce({ text: G.header[0].text, force: true });
    return again === false;
})(), '');

R.assert('A3 手工锁定：解析走 manual 且不覆盖 日期/时间/地点（只维护在场与来源）；未锁定则按正文更新', (() => {
    // 锁定路径走真实入口 setClockManual（同时写 state.state.date 与 clockManual）
    boot(G.resolve[0].state);
    setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' });
    clockAutoExtractOnce({ text: '1920-05-05，主角甲在城市乙。', force: true });
    const locked = { date: state.state.date, time: state.state.time, location: state.state.location };
    boot(G.resolve[0].state, { clockManualLock: false });
    setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' });
    clockAutoExtractOnce({ text: '1920-05-05，主角甲在城市乙。', force: true });
    const unlocked = { date: state.state.date, time: state.state.time };
    return locked.date === '1919-12-31' && locked.time === '08:30' && locked.location === '城市甲·码头'
        && unlocked.date === '1920-05-05';
})(), (() => state.state));

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

await A('A6 楼层窗口回退（宿主注入文本）：无最新正文时用窗口文本提取日期/时间/地点；在场**不取窗口文本**（只认最新正文或最新情节）', async () => {
    boot(G.resolve[0].state);
    state.state.present = ['旧角色甲'];
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '1919-12-09，主角甲来到城市壬。' });
    const ok = clockAutoExtractOnce({ force: true });
    const res = clockExtractState();
    return ok === true && state.state.date === '1919-12-09' && res.textMode === 'floor-window'
        && res.source.present === 'plot-atom' && J(state.state.present) === J(['主角甲']);
}, (() => ({ mode: (clockExtractState() || {}).textMode })));

// ============================================================
// U 组：界面接线（总览时钟来源行随自动提取更新）
// ============================================================
await A('U1 总览时钟区：自动提取后显示 日期/时间/地点 + 时钟来源行（正则/正文头）+ 降级说明', async () => {
    boot(G.resolve[0].state);
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
    clockAutoExtractOnce({ text: '2011年5月6日，主角甲在城市庚。', force: true });      // 异常 → 降级
    openPanel('overview');
    setPanelHooks2({});
    const html = panelBodyHtml('overview');
    const degraded = html.indexOf('data-ftt-clock-src') >= 0 && html.indexOf('已降级') >= 0;
    boot(G.resolve[0].state);
    clockAutoExtractOnce({ text: G.header[0].text, force: true });
    const html2 = panelBodyHtml('overview');
    return degraded && html2.indexOf('🕒 时钟来源：') >= 0
        && html2.indexOf('📅 日期：' + G.resolve[0].out.date) >= 0
        && html2.indexOf('东汉建武二十七年') >= 0 && html2.indexOf('📆 剧情第 17602 天') >= 0
        && html2.indexOf('09:00 → 09:05') >= 0 && html2.indexOf('📍 地点：' + G.resolve[0].out.location) >= 0;
}, '');

un();
R.done();
