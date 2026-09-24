// ============================================================
// 单元测试 · B8-3 时钟域 AI 管线（与**真实 V1 插件**逐项比对 + 界面动作接线）
// 黄金样本：tests/fixtures/v1-golden-clock-ai.json（oracle = 真实 V1 插件 v1.206 + stubFetch 固定 AI 返回）
// 覆盖：normalizeClockRegexFromAi（正则三重校验）/ genClockRegexes（AI 捕捉正文 → 写入 cfg + 试算，含失败分支）/
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
    normalizeClockRegexFromAi, buildClockRegexPrompt, applyClockRegexResult, genClockRegexes,
    clockRepairPack, buildClockRepairPrompt, applyClockRepairResult, runClockRepair, setClockAiHooks,
} from '../../core/clock-ai.js';
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
R.assert('H1 正则三重校验 normalizeClockRegexFromAi：7 组（去包裹 / /…/g / 代码块 / 非法 / 空 / 匹配空串 / 标记式）与 V1 一致', (() => {
    boot({});
    const bad = G.normalize.filter((c) => J(normalizeClockRegexFromAi(c.v)) !== J(c.out));
    return bad.length === 0;
})(), G.normalize.map((c) => [c.tag, normalizeClockRegexFromAi(c.v), c.out]));

await A('H2 AI 捕捉正则（成功）：三条正则经校验 + 命中判定后写入 cfg，试算结果与 V1 逐字段一致', async () => {
    boot({});
    aiText = G.inputs.aiGen1;
    const r = await genClockRegexes({ floors: 2 });
    const cmp = { ok: r.ok, applied: r.applied, skipped: r.skipped, hits: r.hits, probe: r.probe, regexes: r.regexes };
    return J(cmp) === J(G.genOk) && cfg.clockDateRegex === G.genOk.regexes.date
        && cfg.clockTimeRegex === G.genOk.regexes.time && cfg.clockLocationRegex === G.genOk.regexes.location;
}, (() => ({ r: 'see H2' })));

await A('H3 AI 捕捉正则（失败分支）：非法 / 匹配空串 / 无命中 → 全部不采用且不改 cfg', async () => {
    boot({});
    aiText = G.inputs.aiGen2;
    const r = await genClockRegexes({ floors: 2 });
    const cmp = { ok: r.ok, applied: r.applied, skipped: r.skipped, hits: r.hits, regexes: r.regexes };
    return J(cmp) === J(G.genBad) && !cfg.clockDateRegex && !cfg.clockTimeRegex && !cfg.clockLocationRegex;
}, (() => ({ r: 'see H3' })));

R.assert('H4 异常清单打包 clockRepairPack：锚点/可用性/来源/总量/截断/逐条（维度·字段·现值·原因·正文·楼层）与 V1 一致', (() => {
    boot(G.inputs.scenario);
    // 与 oracle 相同的键序（JSON 字符串比较对键序敏感）
    const norm = (p) => ({ anchor: p.anchor, anchorUsable: p.anchorUsable, anchorSource: p.anchorSource, total: p.total, truncated: p.truncated, entries: p.entries });
    return J(norm(clockRepairPack())) === J(G.pack);
})(), (() => { boot(G.inputs.scenario); const p = clockRepairPack(); return { got: { anchor: p.anchor, total: p.total, entries: p.entries.length } }; })());

R.assert('H5 修复提示词 buildClockRepairPrompt：system + user（锚点 / 近期正文 / 清单 / 输出契约）与 V1 逐字符一致', (() => {
    boot(G.inputs.scenario);
    const pack = clockRepairPack();
    return J(buildClockRepairPrompt(pack, G.inputs.floorText)) === J(G.prompt);
})(), (() => { boot(G.inputs.scenario); return buildClockRepairPrompt(clockRepairPack(), G.inputs.floorText); })());

R.assert('H6 应用 AI 结果 applyClockRepairResult：修正 2 / 清空 1 / 丢弃不合格 2 / 无法判定 1，且状态与 V1 一致（现实年份被闸门丢弃）', (() => {
    boot(G.inputs.scenario);
    const pack = clockRepairPack();
    const r = applyClockRepairResult(pack, clone(G.inputs.delta));
    return J({ applied: r.applied, cleared: r.cleared, skipped: r.skipped, unknown: r.unknown, details: r.details }) === J(G.apply)
        && J(dimsSnapshot()) === J(G.applyState);
})(), (() => { boot(G.inputs.scenario); const p = clockRepairPack(); return applyClockRepairResult(p, clone(G.inputs.delta)); })());

await A('H7 runClockRepair 端到端：AI 返回同一 delta → made/applied/cleared/skipped/unknown 与状态改写与 V1 一致', async () => {
    boot(G.inputs.scenario);
    aiText = G.inputs.aiRepair;
    const r = await runClockRepair({ silent: true });
    const cmp = { made: r.made, applied: r.applied, cleared: r.cleared, skipped: r.skipped, unknown: r.unknown, total: r.total, submitted: r.submitted, details: r.details };
    return J(cmp) === J(G.run) && J(dimsSnapshot()) === J(G.runState) && aiCalls === 1;
}, '');

await A('H8 无可信锚点 → 拒绝执行且**不调用 AI**、不改任何数据（V1 安全口径）', async () => {
    boot(G.inputs.noAnchorScenario);
    aiText = G.inputs.aiRepair;
    const r = await runClockRepair({ silent: true });
    const cmp = { made: r.made, skipped: r.skipped, blocked: r.blocked, noAnchor: r.noAnchor };
    return J(cmp) === J(G.runNoAnchor) && aiCalls === 0 && state.atoms[0].date === '不是日期';
}, '');

// ============================================================
// P 组：AI 管线自身行为（提示词构建 / 无正文 / 长任务占用 / AI 无返回）
// ============================================================
R.assert('P1 buildClockRegexPrompt：system 取配置模板（V1 同款），user 含正文样本与输出契约', (() => {
    boot({});
    const msgs = buildClockRegexPrompt('样本正文');
    return msgs.length === 2 && msgs[0].role === 'system' && msgs[0].content.indexOf('时钟正则生成') >= 0
        && msgs[1].role === 'user' && msgs[1].content.indexOf('样本正文') >= 0 && msgs[1].content.indexOf('日期正则') >= 0;
})(), '');

await A('P2 无可用正文 → 不调用 AI，返回 reason=no-text（V1 同款保护）', async () => {
    boot({});
    const cur = setClockAiHooks({});                    // 快照当前钩子（不改动）
    setClockAiHooks({ feedText: () => '' });
    const r = await genClockRegexes({ floors: 2 });
    setClockAiHooks({ feedText: cur.feedText });
    return r.ok === false && r.reason === 'no-text' && aiCalls === 0;
}, '');

await A('P3 长任务在途（busy 钩子）→ 两条管线都拒绝且不调用 AI（V2 以「拒绝」替代 V1 的管线提示）', async () => {
    boot(G.inputs.scenario);
    const cur = setClockAiHooks({});                    // 快照当前钩子（不改动）
    setClockAiHooks({ busy: () => true });
    aiText = G.inputs.aiGen1;
    const g = await genClockRegexes({ floors: 2 });
    aiText = G.inputs.aiRepair;
    const r = await runClockRepair({ silent: true });
    setClockAiHooks({ busy: cur.busy });
    return g.blocked === true && r.blocked === true && aiCalls === 0;
}, '');

await A('P4 AI 无返回：捕捉正则 → reason=no-ai；修复 → error=no-ai 且不改数据', async () => {
    boot(G.inputs.scenario);
    aiText = '';
    const g = await genClockRegexes({ floors: 2 });
    const before = J(dimsSnapshot());
    const r = await runClockRepair({ silent: true });
    return g.ok === false && g.reason === 'no-ai' && r.error === 'no-ai' && J(dimsSnapshot()) === before;
}, '');

await A('P5 无异常条目：clockRepairPack.total=0 → runClockRepair 直接回报 skipped 且不调用 AI', async () => {
    const clean = clone(emptyState());
    clean.atoms = [{ id: 'a1', text: '干净', title: '干净', date: '1919-12-01', tags: [], uses: 0, floorStart: 1, floorEnd: 2 }];
    boot(clean);
    const r = await runClockRepair({ silent: true });
    return r.made === 0 && r.skipped === true && r.total === 0 && aiCalls === 0;
}, '');

R.assert('P6 applyClockRegexResult：写入的只有命中项；未命中项保留原 cfg（不覆盖用户已有正则）', (() => {
    boot({});
    cfg.clockLocationRegex = '既有地点正则';
    const r = applyClockRegexResult(G.inputs.floorText, { '日期正则': '(\\d{4}年\\d{1,2}月\\d{1,2}日)', '时间正则': 'ZZZ', '地点正则': 'YYY' });
    return r.applied.length === 1 && cfg.clockDateRegex.indexOf('\\d{4}年') >= 0 && cfg.clockLocationRegex === '既有地点正则';
})(), '');

// ============================================================
// U 组：界面动作接线（设定页两个按钮 + 面板分发）
// ============================================================
R.assert('U1 基础页两条 AI 按钮就位（V1 同名动作名），不再标「待后续批次」', (() => {
    boot({});
    const html = settingsPageHtml('base');
    return html.indexOf('data-ftt-action="clockRegexGen"') >= 0 && html.indexOf('data-ftt-action="clockRepair"') >= 0
        && html.indexOf('🤖 AI 捕捉正文 → 生成正则') >= 0 && html.indexOf('🩺 AI 结合正文修复日期时间') >= 0
        && html.indexOf('（B8-3）') < 0 && html.indexOf('属后续批次（B8-2）') < 0;
})(), '');

await A('U2 clockAction("clockRegexGen")：写入 cfg 并回填「已应用」提示（经面板分发可达）', async () => {
    boot({});
    aiText = G.inputs.aiGen1;
    openPanel('settings');
    setPanelHooks2({});
    await panelAction('settingsSub', { sub: 'base' });
    const r = await panelAction('clockRegexGen', {});
    const st = panelState();
    return r.ok === true && cfg.clockDateRegex === G.genOk.regexes.date
        && String(r.note).indexOf('AI 捕捉正则完成') >= 0 && String(st.note).length > 0
        && CLOCK_ACTIONS.indexOf('clockRegexGen') >= 0 && CLOCK_ACTIONS.indexOf('clockRepair') >= 0;
}, '');

await A('U3 clockAction("clockRepair")：修复异常日期时间并回填「修正/清空/丢弃」明细', async () => {
    boot(G.inputs.scenario);
    aiText = G.inputs.aiRepair;
    const r = await clockAction('clockRepair', {});
    return r.ok === true && r.detail.made === 3 && String(r.note).indexOf('修正 2 条') >= 0
        && String(r.note).indexOf('清空 1 条') >= 0 && String(r.note).indexOf('丢弃不合格 2 条') >= 0
        && state.atoms[0].date === '1919-05-06';
}, (() => ({ note: '见 U3' })));

un();
R.done();
