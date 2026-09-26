// ============================================================
// 单元测试 · B8-1 剧情时钟域（与**真实 V1 插件**逐项比对 + 总览/设定界面接线）
// 黄金样本：tests/fixtures/v1-golden-clock.json（oracle = 真实 V1 插件 v1.206）
// 覆盖：clockNormTime / clockDateAnomaly / clockReplaceYear / clockPatrolMajority / clockPatrolAnchorInfo（四种来源）/
//   clockPatrolScan / runClockPatrolRepair（scanOnly · force · 自动冲突只统计）/ parseClockManualInput /
//   setClockManual / clearClockManual + 总览时钟区与动作分发（clockEdit/clockManualSave/clockManualClear/clockPatrol）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { clockNormTime, clockDateAnomaly, clockReplaceYear } from '../../core/clock.js';
import {
    clockPatrolAnchorInfo, clockPatrolScan,
    parseClockManualInput, setClockManual, clearClockManual, clockManualState,
} from '../../core/clock-patrol.js';
// v2.51.0：巡检修复功能已移除 —— 本文件用它断言「导出确实没了」（只保留扫描供 AI 修复打包）
import * as PATROL from '../../core/clock-patrol.js';
import { clockSectionHtml, clockAction, clockEditingState, setClockEditing, CLOCK_ACTIONS } from '../../ui/clock.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { settingsPageHtml, SETTINGS_CONTROLS } from '../../ui/settings-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock.json'), 'utf8'));
const R = makeReporter('clock-patrol-golden B8-1 剧情时钟域（V1 对齐）');
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

/** 装载场景（与 oracle 的输入逐一相同） */
function boot(scenario, opts) {
    const o = opts || {};
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(3);
    const st = Object.assign(emptyState(), clone(scenario || G.scenarioA));
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    if (o.date !== undefined) state.state.date = o.date;
    return state;
}
const dimsSnapshot = () => ({
    atoms: state.atoms.map((x) => [x.id, x.date || '', x.time || '']),
    plans: (state.plans || []).map((x) => [x.id, x.date || '', x.time || '']),
    memories: (state.memories || []).map((x) => [x.id, x.date || '', x.time || '']),
    suspense: (state.suspense || []).map((x) => [x.id, x.date || '', x.time || '']),
});

// ============================================================
// S1–S3 纯函数（时段 / 日期异常 / 换年份）—— 依赖 cfg.clockAnomalyJumpYears（V1 默认 50），故先装默认配置
// ============================================================
boot(G.scenarioA, { date: '' });
R.assert('S1 时刻归一 clockNormTime：14 组输入与 V1 逐字符一致（HH:MM / 中文点数 / 时段词 / 非法）', (() => {
    const bad = G.normTime.filter(([inp, want]) => String(clockNormTime(inp) || '') !== String(want));
    return bad.length === 0;
})(), G.normTime.map(([inp, want]) => [inp, String(clockNormTime(inp) || ''), want]));

R.assert('S2 日期异常 clockDateAnomaly：invalid / jump / backward / 无锚点放行 与 V1 一致', (() => {
    const bad = G.anomaly.filter((c) => J(clockDateAnomaly(c.d, c.a)) !== J(c.out));
    return bad.length === 0;
})(), G.anomaly.map((c) => [c.d, c.a, clockDateAnomaly(c.d, c.a), c.out]));

R.assert('S3 换年份 clockReplaceYear：保留月日 / 越界与非法返回空串，与 V1 一致', (() => {
    const bad = G.replaceYear.filter((c) => String(clockReplaceYear(c.d, c.y) || '') !== String(c.out));
    return bad.length === 0;
})(), G.replaceYear.map((c) => [c.d, c.y, clockReplaceYear(c.d, c.y), c.out]));

// ============================================================
// S4–S6 多数派与锚点（四来源 + 不可用 + 分歧）
// ============================================================
R.assert('S5（v2.51.0 改版）锚点只有「手工强制改写 > 当前剧情时钟」：无时钟且无手工值 → 不可用（不再用多数派）', (() => {
    boot(G.scenarioA, { date: '' });
    const a = clockPatrolAnchorInfo();
    boot(G.scenarioA, { date: '1919-12-31' });
    const b = clockPatrolAnchorInfo();
    return a.usable === false && a.source === '' && a.conflict === null && a.ambiguous === false
        && b.usable === true && b.source === 'clock' && b.date === '1919-12-31';
})(), (() => { boot(G.scenarioA, { date: '' }); const a = clockPatrolAnchorInfo(); boot(G.scenarioA, { date: '1919-12-31' }); return { noClock: a, withClock: clockPatrolAnchorInfo() }; })());

R.assert('S6 锚点优先级：手工改写 > 当前剧情时钟 > 多数派（V1 v1.187 口径）', (() => {
    boot(G.scenarioA, { date: '' });
    setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' });
    const man = clockPatrolAnchorInfo();
    const manState = clockManualState();
    const cleared = clearClockManual();
    boot(G.scenarioA, { date: '1919-01-01' });
    const clk = clockPatrolAnchorInfo();
    return J(man) === J(G.anchorManual) && manState.date === G.manualSetA.date && manState.lock === true
        && cleared === G.manualCleared && clockManualState() === null
        && J(clk) === J(G.anchorClock) && clk.source === 'clock';
})(), '');

// ============================================================
// S7 手工改写：解析 / 落库效应 / 解锁
// ============================================================
R.assert('S7（v2.51.0 改版）手工录入解析：缺年份时**只沿用当前时钟年份**；无时钟则拒绝（不再用多数派兜底）', (() => {
    // 无时钟：缺年份 → 拒绝；时间非法 → 忽略；全空 → ok=false
    boot(G.scenarioA, { date: '' });
    const noClock = [parseClockManualInput({ date: '11月29日' }), parseClockManualInput({ time: '25:99' }), parseClockManualInput({})];
    // 有时钟：缺年份 → 沿用时钟年份
    boot(G.scenarioA, { date: '1919-12-31' });
    const withClock = [parseClockManualInput({ date: '11月29日' }), parseClockManualInput({ time: '下午三点' })];
    return noClock[0].ok === false && noClock[1].ok === false && noClock[2].ok === false
        && withClock[0].ok === true && withClock[0].date === '1919-11-29'
        && withClock[1].ok === true && withClock[1].time === '15:00';
})(), (() => {
    boot(G.scenarioA, { date: '' });
    const a = parseClockManualInput({ date: '11月29日' });
    boot(G.scenarioA, { date: '1919-12-31' });
    return { noClock: a, withClock: parseClockManualInput({ date: '11月29日' }) };
})());

R.assert('S8 保存手工改写：写入 state.state.clockManual + 覆盖 日期/时间/地点 + clockSrc 标记（与 V1 状态一致）', (() => {
    boot(G.scenarioA, { date: '' });
    setLastMessageId(3);
    const r = setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' });
    const got = { date: state.state.date, time: state.state.time, location: state.state.location, clockSrc: state.state.clockSrc };
    // at 字段为运行时时间戳 → 比对时剔除（与 oracle 同为 Date.now 派生）
    const want = clone(G.stateAfterManual);
    delete want.clockSrc.at; delete got.clockSrc.at;
    return r.ok === true && J(got) === J(want) && r.lock === true;
})(), (() => { boot(G.scenarioA, { date: '' }); setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' }); return state.state; })());

R.assert('S9 解锁 clearClockManual：删除手工值与 clockSrc.manual 标记，但保留已写入的时钟值（V1 同口径）', (() => {
    boot(G.scenarioA, { date: '' });
    setClockManual({ date: '1919-12-31', time: '08:30', location: '城市甲·码头' });
    const had = clearClockManual();
    const got = { date: state.state.date, time: state.state.time, location: state.state.location };
    const cs = state.state.clockSrc || {};
    return had === true && clockManualState() === null && J(got) === J(G.stateAfterClear) && !cs.manual && !cs.manualLock;
})(), (() => state.state));

// ============================================================
// ============================================================
// S10（v2.51.0 改版）：巡检修复功能**已移除**，只保留 clockPatrolScan 供 AI 修复打包
// ============================================================
R.assert('S10（v2.51.0）巡检修复功能已移除：不再导出 runClockPatrolRepair / clockPatrolState / clockPatrolAutoOnce；clockPatrolScan 只扫情节且只报格式非法', (() => {
    const mod = PATROL;
    const gone = ['runClockPatrolRepair', 'clockPatrolState', 'clockPatrolAutoOnce', 'clockPatrolMajority'].every((k) => mod[k] === undefined);
    boot({ atoms: [
        { id: 'p1', text: '甲在码头。', date: '1919-11-20', floorStart: 1, floorEnd: 1, uses: 0, tags: [] },
        { id: 'p2', text: '乙在钟鼓楼。', date: '不是日期', floorStart: 2, floorEnd: 2, uses: 0, tags: [] },
        { id: 'p3', text: '总结条', date: '2035-01-01', floorStart: 3, floorEnd: 3, mergedSummary: { by: 'auto', sourceCount: 2 } },
        { id: 'p4', text: '已总结隐藏', date: '2035-01-02', floorStart: 4, floorEnd: 4, summarizedBy: 'p3' },
    ], state: { date: '1919-11-20' } });
    const scan = mod.clockPatrolScan(mod.clockPatrolAnchorInfo());
    const dims = Array.from(new Set((scan.findings || []).map((f) => f.dim)));
    const ids = (scan.findings || []).map((f) => f.id);
    return gone && scan.scanned === 2 && J(dims) === J(['atoms'])
        && ids.indexOf('p2') >= 0 && ids.indexOf('p3') < 0 && ids.indexOf('p4') < 0
        && (scan.findings || []).every((f) => f.reason === 'invalid');
})(), (() => { const mod = PATROL; return { hasRepair: typeof mod.runClockPatrolRepair }; })());

await A('U6 总览渲染含时钟区与手工面板（panelBodyHtml 走 overviewBody → clockSectionHtml）', async () => {
    boot(G.scenarioA, { date: '1919-12-31' });
    setClockEditing(false);
    openPanel('overview');
    const closed = panelBodyHtml('overview');
    await panelAction('clockEdit', {});
    const opened = panelBodyHtml('overview');
    return closed.indexOf('✏️ 手工改写日期/时间/地点') >= 0 && closed.indexOf('data-ftt-clock-manual="date"') < 0
        && opened.indexOf('data-ftt-clock-manual="date"') >= 0 && opened.indexOf('data-ftt-action="clockManualSave"') >= 0;
}, '');

// ============================================================
// P 组：设定「基础」页（V1 分节 + 强制开关 + 新增控件）
// ============================================================
R.assert('P1（v2.51.0 改版）基础页控件：删除 10 个废弃时钟设定后共 11 项（不再含 clockAutoPatrol/clockPatrolAutoFix/clockRegexPreset/…）', (() => {
    const keys = (SETTINGS_CONTROLS.base || []).map((c) => String(c.key));
    const removed = ['clockAutoPatrol', 'clockPatrolAutoFix', 'clockRegexPreset', 'clockDateRegex', 'clockTimeRegex',
        'clockLocationRegex', 'clockRelative', 'clockForceDegrade', 'clockAnomalyJumpYears', 'clockStoryDayEpoch'];
    return keys.length === 11 && removed.every((k) => keys.indexOf(k) < 0)
        && keys.indexOf('clockExtractEnabled') >= 0 && keys.indexOf('clockRepairBatch') >= 0;
})(), (SETTINGS_CONTROLS.base || []).map((c) => c.key));

R.assert('P2（v2.51.0 改版）基础页渲染：时钟分节按新设计（只取最新情节 / 巡检只针对情节），不再出现废弃内容', (() => {
    const h = settingsPageHtml('base');
    const gone = ['强制使用降级方案', '日期异常判定', '纪元首日', '时间巡检：载入后自动巡检', '自动修复（默认关', '自定义 · 日期正则', '相对日期推进'];
    return h.indexOf('剧情时钟（总览 日期/时间/地点）') >= 0 && h.indexOf('最新一条「情节」') >= 0
        && h.indexOf('巡检范围只有') >= 0 && gone.every((t) => h.indexOf(t) < 0);
})(), '');

await A('U6 总览渲染含时钟区与手工面板（panelBodyHtml 走 overviewBody → clockSectionHtml）；巡检修复入口已移除', async () => {
    boot(G.scenarioA, { date: '1919-12-31' });
    setClockEditing(false);
    openPanel('overview');
    const closed = panelBodyHtml('overview');
    await panelAction('clockEdit', {});
    const opened = panelBodyHtml('overview');
    return closed.indexOf('✏️ 手工改写日期/时间/地点') >= 0 && closed.indexOf('data-ftt-clock-manual="date"') < 0
        && opened.indexOf('data-ftt-clock-manual="date"') >= 0 && opened.indexOf('data-ftt-action="clockManualSave"') >= 0
        && closed.indexOf('时间巡检') < 0 && closed.indexOf('clockPatrol') < 0;
}, '');

un();
R.done();
