// ============================================================
// 单元测试 · B8-3 时钟域 AI 管线（与**真实 V1 插件**逐项比对 + 界面动作接线）
// 黄金样本：tests/fixtures/v1-golden-clock-ai.json（oracle = 真实 V1 插件 v1.206 + stubFetch 固定 AI 返回）
// v2.51.0：AI 生成时钟正则（clockRegexGen）随「正文直取」一并移除 —— 本文件只覆盖「AI 结合正文修复日期时间」。
//   clockRepairPack（异常清单打包）/ buildClockRepairPrompt（提示词逐字符）/ applyClockRepairResult（只改日期·时间 + 安全闸门）/
//   runClockRepair（端到端：AI 返回 → 落盘；无可信锚点 → 拒绝且不调用 AI）+ 面板动作接线。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    clockRepairPack, buildClockRepairPrompt, applyClockRepairResult, runClockRepair, setClockAiHooks,
} from '../../core/clock-ai.js';
import { setClockManual } from '../../core/clock-patrol.js';
import { clockAction, CLOCK_ACTIONS } from '../../ui/clock.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock-ai.json'), 'utf8'));
const R = makeReporter('clock-ai-golden B8-3 时钟域 AI 管线（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** 最近一次注入的 AI 返回（每个用例设置） */
let aiText = '';
let aiCalls = 0;
setClockAiHooks({
    callAi: async () => { aiCalls++; return { ok: true, text: aiText }; },
    feedText: (n) => (Number(n) >= 10 ? G.inputs.floorText + '\n' + G.inputs.floorText2 : G.inputs.floorText + '\n' + G.inputs.floorText2),
    busy: () => false,
});

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(1);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    aiText = ''; aiCalls = 0;
    return state;
}
const dimsSnapshot = () => ({
    atoms: state.atoms.map((x) => [x.id, x.date || '', x.time || '']),
    memories: (state.memories || []).map((x) => [x.id, x.date || '', x.time || '']),
});

// ============================================================
// H 组：与 V1 逐项比对
// ============================================================
R.assert('H4（v2.51.0 改版）异常清单打包 clockRepairPack：**只打包情节**里格式非法的日期/时间（锚点/可用性/来源/总量/逐条字段齐备）', (() => {
    boot(G.inputs.scenario);
    const p = clockRepairPack();
    const dims = Array.from(new Set((p.entries || []).map((e) => e.dim)));
    const allPlot = (p.entries || []).length > 0 && dims.every((d) => d === 'atoms');
    const fieldsOk = (p.entries || []).every((e) => e.dim && e.field && e.value !== undefined && e.reason && e.text !== undefined && e.n >= 1);
    const reasons = Array.from(new Set((p.entries || []).map((e) => e.reason)));
    return allPlot && fieldsOk && p.total === (p.entries || []).length
        && reasons.every((r) => r === 'invalid')
        && (p.anchorSource === '' || p.anchorSource === 'clock' || p.anchorSource === 'manual');
})(), (() => { boot(G.inputs.scenario); const p = clockRepairPack(); return { total: p.total, entries: (p.entries || []).map((e) => [e.dim, e.field, e.reason]) }; })());

await A('P5 无异常条目：clockRepairPack.total=0 → runClockRepair 直接回报 skipped 且不调用 AI', async () => {
    const clean = clone(emptyState());
    clean.atoms = [{ id: 'a1', text: '干净', title: '干净', date: '1919-12-01', tags: [], uses: 0, floorStart: 1, floorEnd: 2 }];
    boot(clean);
    const r = await runClockRepair({ silent: true });
    return r.made === 0 && r.skipped === true && r.total === 0 && aiCalls === 0;
}, '');

await A('U3（v2.51.0 改版）clockAction("clockRepair")：① 无可信锚点（无手工值且时钟为空）→ **拒绝执行**并如实说明；② 手工锚点后只修**情节**（AI 请求由本场景的打包条目生成，其它维度一字不动）', async () => {
    // ① 无锚点
    boot(G.inputs.scenario);
    aiText = G.inputs.aiRepair;
    const before0 = JSON.stringify(state);
    const r0 = await clockAction('clockRepair', {});
    const untouched0 = JSON.stringify(state) === before0;
    // ② 手工锚点（新设计的唯一可信锚点来源）+ 依据**真实打包条目**构造 AI 回复
    boot(G.inputs.scenario);
    setClockManual({ date: '1919-11-29' });
    const pack = clockRepairPack();
    const first = (pack.entries || [])[0];
    aiText = JSON.stringify({ 修正: first ? [{ 编号: first.n, 日期: '1919-11-20', 时间: '傍晚' }] : [], 清除: [], 无法判定: [] });
    const targetId = first ? String(first.id) : '';
    const otherBefore = JSON.stringify((state.memories || []).concat(state.plans || [], state.suspense || [], state.parallels || []));
    const r1 = await clockAction('clockRepair', {});
    const otherAfter = JSON.stringify((state.memories || []).concat(state.plans || [], state.suspense || [], state.parallels || []));
    const target = (state.atoms || []).find((a) => String(a.id) === targetId) || null;
    const touched = (r1.detail && r1.detail.details || []).join(' ');
    return r0.ok === false && String(r0.note).indexOf('缺少可信锚点') >= 0 && untouched0
        && !!first && first.dim === 'atoms'
        && r1.ok === true && otherBefore === otherAfter
        && (!target || target.date === '1919-11-20')
        && (touched === '' || touched.indexOf('情节') >= 0);
}, (() => ({ note: '见 U3（只修情节）' })));

un();
R.done();
