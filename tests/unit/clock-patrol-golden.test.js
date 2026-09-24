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
    clockPatrolMajority, clockPatrolAnchorInfo, clockPatrolScan, runClockPatrolRepair, clockPatrolState,
    parseClockManualInput, setClockManual, clearClockManual, clockManualState, clockPatrolAutoOnce,
} from '../../core/clock-patrol.js';
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
R.assert('S4 年份多数派 clockPatrolMajority：count/share/total/latest/consensus/years 与 V1 一致', (() => {
    boot(G.scenarioA);
    return J(clockPatrolMajority()) === J(G.majorityA);
})(), (() => { boot(G.scenarioA); return { got: clockPatrolMajority(), want: G.majorityA }; })());

R.assert('S5 锚点择优：① 无时钟 → 多数派；② 无有效日期 → 不可用；③ 年份分歧 → ambiguous（宁可不修）', (() => {
    boot(G.scenarioA, { date: '' });
    const a = clockPatrolAnchorInfo();
    boot(G.scenarioB, { date: '' });
    const b = clockPatrolAnchorInfo();
    boot(G.scenarioC, { date: '' });
    const c = clockPatrolAnchorInfo();
    return J(a) === J(G.anchorA) && J(b) === J(G.anchorB) && J(c) === J(G.anchorC) && a.usable === true && b.usable === false && c.ambiguous === true;
})(), (() => { boot(G.scenarioC, { date: '' }); return clockPatrolAnchorInfo(); })());

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
R.assert('S7 手工录入解析 parseClockManualInput：5 组输入（含缺年份沿用库内年份、时间非法忽略、全空）与 V1 一致', (() => {
    boot(G.scenarioA, { date: '' });
    const bad = G.parseManual.filter((c) => J(parseClockManualInput(c.inp)) !== J(c.out));
    return bad.length === 0;
})(), G.parseManual.map((c) => [c.tag, parseClockManualInput(c.inp), c.out]));

R.assert('S7b 无可用年份时拒绝缺年份日期（绝不用现实年份兜底）', (() => {
    boot(G.scenarioB, { date: '' });
    return J(parseClockManualInput({ date: '11月29日' })) === J(G.parseManualNoYear);
})(), (() => { boot(G.scenarioB, { date: '' }); return parseClockManualInput({ date: '11月29日' }); })());

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
// S10–S12 零 AI 巡检
// ============================================================
R.assert('S10 巡检扫描 clockPatrolScan：3 条异常（时间非法 / 日期非法 / 年份跳变）与 V1 逐项一致', (() => {
    boot(G.scenarioA, { date: '' });
    const scan = clockPatrolScan(clockPatrolAnchorInfo());
    return J(scan) === J(G.scanA);
})(), (() => { boot(G.scenarioA, { date: '' }); return clockPatrolScan(clockPatrolAnchorInfo()); })());

R.assert('S11 只统计（scanOnly）：不改任何数据、blocked=scan-only、remain=found（V1 安全口径①）', (() => {
    boot(G.scenarioA, { date: '' });
    const rep = runClockPatrolRepair({ silent: true, scanOnly: true });
    const cmp = (x) => ({ scanned: x.scanned, found: x.found, fixed: x.fixed, skipped: x.skipped, remain: x.remain, reasons: x.reasons, details: x.details, anchor: x.anchor, anchorSource: x.anchorSource, anchorUsable: x.anchorUsable, anchorConflict: x.anchorConflict, scanOnly: x.scanOnly, blocked: x.blocked, snap: x.snap });
    return J(cmp(rep)) === J(G.patrolScanOnly) && state.atoms[3].date === G.scenarioA.atoms[3].date;
})(), (() => { boot(G.scenarioA, { date: '' }); return runClockPatrolRepair({ silent: true, scanOnly: true }); })());

R.assert('S12 手动强制修复（force）：3 条异常全部修复 + 写回前留全量快照（V1 安全口径④），结果与 V1 逐一一致', (() => {
    boot(G.scenarioA, { date: '' });
    const rep = runClockPatrolRepair({ silent: true, force: true });
    const cmp = { scanned: rep.scanned, found: rep.found, fixed: rep.fixed, skipped: rep.skipped, remain: rep.remain, blocked: rep.blocked, reasons: rep.reasons, anchor: rep.anchor, anchorSource: rep.anchorSource, hasSnap: !!rep.snap, detailCount: (rep.details || []).length };
    return J(cmp) === J(G.patrolForce) && J(dimsSnapshot()) === J(G.afterForce);
})(), (() => { boot(G.scenarioA, { date: '' }); const rep = runClockPatrolRepair({ silent: true, force: true }); return { rep: { fixed: rep.fixed }, dims: dimsSnapshot() }; })());

R.assert('S13 自动路径遇「锚点与库内多数年份冲突」→ 只统计不修改（blocked=anchor-conflict，V1 v1.187）', (() => {
    boot(G.scenarioA, { date: '1950-01-01' });
    const auto = runClockPatrolRepair({ silent: true });
    const cmp = { blocked: auto.blocked, fixed: auto.fixed, remain: auto.remain, anchor: auto.anchor, anchorConflict: auto.anchorConflict };
    return J(cmp) === J(G.patrolAutoConflict) && state.atoms[3].date === '不是日期';
})(), (() => { boot(G.scenarioA, { date: '1950-01-01' }); return runClockPatrolRepair({ silent: true }); })());

R.assert('S14 巡检状态与自动巡检入口：clockPatrolState 保留最近一次报告；clockPatrolAutoOnce 默认只统计（scanOnly）', (() => {
    boot(G.scenarioA, { date: '' });
    cfg.clockAutoPatrol = true; cfg.clockPatrolAutoFix = false;
    const rep = clockPatrolAutoOnce();
    const st = clockPatrolState();
    cfg.clockPatrolAutoFix = true;
    const rep2 = clockPatrolAutoOnce();
    cfg.clockAutoPatrol = false;
    const off = clockPatrolAutoOnce();
    return !!st && st.blocked === 'scan-only' && st.scanOnly === true && rep.fixed === 0
        && rep2.fixed === 3 && off === null;
})(), '');

// ============================================================
// U 组：总览时钟区 + 动作分发
// ============================================================
await A('U1 总览时钟区（V1 同构）：日期/时间/地点 + 参考最近记忆 + 手工工具行 + 时间巡检状态行', async () => {
    boot(G.scenarioA, { date: '' });
    state.state.date = ''; state.state.time = ''; state.state.location = '';
    const html = clockSectionHtml();
    const r2 = runClockPatrolRepair({ silent: true, scanOnly: true });
    const html2 = clockSectionHtml();
    return html.indexOf('📅 日期：') >= 0 && html.indexOf('（参考最近记忆：') >= 0
        && html.indexOf('data-ftt-action="clockEdit"') >= 0 && html.indexOf('✏️ 手工改写日期/时间/地点') >= 0
        && html.indexOf('自动提取中') >= 0
        && html2.indexOf('data-ftt-clock-patrol') >= 0 && html2.indexOf('🩺 时间巡检修复') >= 0
        && html2.indexOf('上次巡检：扫描 ' + r2.scanned + ' 条') >= 0 && html2.indexOf('仅统计') >= 0;
}, '');

await A('U2 动作 clockEdit / clockEditCancel：展开与收起手工面板（含三项输入与保存按钮）', async () => {
    boot(G.scenarioA, { date: '1919-12-31' });
    setClockEditing(false);
    const r1 = await clockAction('clockEdit', {});
    const editingAfterOpen = clockEditingState();          // 注意：必须在「取消」之前取，否则被取消动作覆盖
    const openHtml = clockSectionHtml();
    const r2 = await clockAction('clockEditCancel', {});
    const editingAfterCancel = clockEditingState();
    const closedHtml = clockSectionHtml();
    return r1.ok === true && editingAfterOpen === true
        && openHtml.indexOf('data-ftt-clock-manual="date"') >= 0 && openHtml.indexOf('data-ftt-clock-manual="time"') >= 0
        && openHtml.indexOf('data-ftt-clock-manual="location"') >= 0 && openHtml.indexOf('💾 保存并锁定') >= 0
        && r2.ok === true && editingAfterCancel === false && closedHtml.indexOf('data-ftt-clock-manual="date"') < 0;
}, (() => ({ note: '见 tests/unit/clock-patrol-golden.test.js U2' })));

await A('U3 动作 clockManualSave：写入并锁定 + 提示；clockManualClear：解锁并恢复自动', async () => {
    boot(G.scenarioA, { date: '' });
    setClockEditing(true);
    const save = await clockAction('clockManualSave', { date: '1919-12-31', time: '下午三点', location: '城市甲·码头' });
    const locked = clockManualState();
    const saveHtml = clockSectionHtml();
    const clr = await clockAction('clockManualClear', {});
    return save.ok === true && state.state.date === '1919-12-31' && state.state.time === '15:00'
        && locked && locked.lock === true && saveHtml.indexOf('🔒 已手工锁定') >= 0 && saveHtml.indexOf('🔓 解锁并恢复自动') >= 0
        && clr.ok === true && clockManualState() === null && clr.note.indexOf('已解除手工锁定') >= 0;
}, (() => ({ note: state.state })));

await A('U4 动作 clockManualSave 空输入：不写入并如实提示（不产生假成功）', async () => {
    boot(G.scenarioA, { date: '' });
    const r = await clockAction('clockManualSave', { date: '', time: '', location: '' });
    return r.ok === false && clockManualState() === null && r.note.length > 0;
}, '');

await A('U5 动作 clockPatrol（面板分发）：按锚点修复并在提示里回报 扫描/异常/修复/保留/快照', async () => {
    boot(G.scenarioA, { date: '' });
    openPanel('overview');
    setPanelHooks2({});
    const r = await panelAction('clockPatrol', {});
    const st = panelState();
    return r.ok === true && r.detail.fixed === 3 && r.detail.snap && String(r.note).indexOf('巡检 7 条') >= 0
        && String(r.note).indexOf('修复 3 条') >= 0 && String(st.note).indexOf('修复 3 条') >= 0
        && CLOCK_ACTIONS.length === 5;
}, (() => ({})));

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
R.assert('P1 基础页控件：21 项、与 V1 同名同序（含 enabled/autoRepair/clockAutoPatrol/clockPatrolAutoFix/uiEffects/clockRegexPreset）', (() => {
    const keys = SETTINGS_CONTROLS.base.map((c) => c.key);
    const want = ['enabled', 'timelyAnalysis', 'autoExtract', 'autoSummary', 'autoRepair', 'injectCurrentPrompt',
        'importanceBase', 'importancePerUse', 'clockExtractEnabled', 'clockRegexPreset', 'clockDateRegex', 'clockTimeRegex',
        'clockLocationRegex', 'clockRelative', 'clockForceDegrade', 'clockAnomalyJumpYears', 'clockStoryDayEpoch',
        'clockAutoPatrol', 'clockPatrolAutoFix', 'clockRepairBatch', 'uiEffects'];
    return keys.length === 21 && J(keys) === J(want);
})(), SETTINGS_CONTROLS.base.map((c) => c.key));

R.assert('P2 基础页渲染：V1 五节 + 强制开关标记（timelyAnalysis 开启时 autoExtract/autoSummary/injectCurrentPrompt 强制开启且禁用）', (() => {
    Object.assign(cfg, clone(defaultCfg));
    cfg.timelyAnalysis = true;
    const html = settingsPageHtml('base');
    const forced = html.match(/disabled/g) || [];
    cfg.timelyAnalysis = false;
    const html2 = settingsPageHtml('base');
    return html.indexOf('组件开关') >= 0 && html.indexOf('重要性计算（调用次数驱动）') >= 0
        && html.indexOf('剧情时钟自动提取（总览 日期/时间/地点）') >= 0 && html.indexOf('时钟降级与时间巡检（总览）') >= 0
        && html.indexOf('界面特效') >= 0 && forced.length === 3 && html.indexOf('（由「及时分析」强制开启）') >= 0
        && html2.indexOf('disabled') < 0 && html2.indexOf('中文常用 + 标记式（推荐，最全）') >= 0
        && html.indexOf('（B8-2）') >= 0;
})(), '');

un();
R.done();
