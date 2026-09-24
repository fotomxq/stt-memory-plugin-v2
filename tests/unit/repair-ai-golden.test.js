// ============================================================
// 单元测试 · B8-6b 修复第 2/3 段（候选筛选 + 窄契约 AI 修订）（与**真实 V1 插件**逐项比对 + 编排/接线）
// 黄金样本：tests/fixtures/v1-golden-repair-ai.json（oracle = 真实 V1 插件 v1.206）
//   场景保证「中间带为空」（每条要么客观缺陷 / 高相关 / 低相关）→ 候选筛选全程确定，可与 V1 逐项比对。
// 覆盖：repairTagSetOf / repairJaccard / repairCorrelationMap（标签基准 + 全文比较）/ repairDefectOf（5 类缺陷）/
//   repairCollectCandidates（候选顺序 + why/rank/label + 统计 + 轮询游标）/ buildRepairPrompt（system+user 逐字符）/
//   repairApplyAiResult（修订/标题/标签/垃圾值/未知字段/未知编号/删除 + 墓碑）；
//   另含 V2 编排：runRepair 三段式（含 `repairAutoAi` 关闭时零 AI 调用）、频率与上限闸门、提取失败自动修复排程、面板动作。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    repairTagSetOf, repairJaccard, repairCorrelationMap, repairDefectOf, repairCollectCandidates,
    buildRepairPrompt, repairApplyAiResult, runRepair, scheduleAutoRepairOnMergeFail, cancelRepairTimers,
    autoRepairOpDue, bumpRepairOp, autoRepairTake, setRepairHooks,
} from '../../core/repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-repair-ai.json'), 'utf8'));
const R = makeReporter('repair-ai-golden B8-6b 修复第 2/3 段（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

let aiText = '';
let aiCalls = 0;
setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => '', busy: () => false });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    Object.assign(cfg, clone(G.inputs.cfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setRepairHooks({ floorHash: () => 'hash-F' });
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => '', busy: () => false });
    aiText = ''; aiCalls = 0;
    return state;
}
/** 与 oracle 相同的键序（候选筛选统计对象） */
const canonStat = (s) => ({ total: s.total, defects: s.defects, corrHigh: s.corrHigh, sampled: s.sampled, topped: s.topped, corrLowSkipped: s.corrLowSkipped, cursors: s.cursors });

// ============================================================
// H 组：与 V1 逐项比对
// ============================================================
R.assert('H1 标签集合与相似度 repairTagSetOf / repairJaccard：去 # 前缀与空白、小写去重；Jaccard 三态与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const a1 = state.atoms[0], a2 = state.atoms[1], a6 = state.atoms[5];
    const got = {
        tagSet: { a1: repairTagSetOf(a1), dup: repairTagSetOf({ tags: ['#甲', '甲', ' 码头 '] }), none: repairTagSetOf({}) },
        jaccard: { same: repairJaccard(repairTagSetOf(a1), repairTagSetOf(a2)), none: repairJaccard(repairTagSetOf(a1), repairTagSetOf(a6)), empty: repairJaccard([], ['甲']) },
    };
    return J(got.tagSet) === J(G.tagSet) && J(got.jaccard) === J(G.jaccard);
})(), (() => { boot(G.inputs.scenario); return repairTagSetOf(state.atoms[0]); })());

R.assert('H2 相关性映射 repairCorrelationMap：同维度最大相似度 + 判定基数（标签/正文）+ tagRich/approx，逐维与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const a = repairCorrelationMap('atoms', state.atoms);
    const m = repairCorrelationMap('memories', state.memories);
    const got = {
        atoms: { sims: a.sims, basis: a.basis, tagRich: a.tagRich, approx: a.approx },
        memories: { sims: m.sims, basis: m.basis, tagRich: m.tagRich, approx: m.approx },
    };
    return J(got) === J(G.corr);
})(), (() => { boot(G.inputs.scenario); return repairCorrelationMap('atoms', state.atoms); })());

R.assert('H3 客观缺陷 repairDefectOf：垃圾(0) / 超字数(2) / 模糊措辞(3) / 日期格式(5) 逐条与 V1 一致（无缺陷返回 null）', (() => {
    boot(G.inputs.scenario);
    const got = {
        atoms: state.atoms.map(e => { const d = repairDefectOf('atoms', e); return [e.id, d ? d.rank : null, d ? d.label : '']; }),
        memories: state.memories.map(e => { const d = repairDefectOf('memories', e); return [e.id, d ? d.rank : null, d ? d.label : '']; }),
    };
    return J(got) === J(G.defects);
})(), (() => { boot(G.inputs.scenario); return repairDefectOf('atoms', state.atoms[2]); })());

R.assert('H4 候选筛选 repairCollectCandidates：候选顺序（缺陷→高相关）与编号/why/rank/sim/basis/label 逐条一致 + 统计与轮询游标一致', (() => {
    boot(G.inputs.scenario);
    state.repairCursor = {};
    const stat = {};
    const cands = repairCollectCandidates(20, stat);
    const got = cands.map(c => [c.n, c.dim, c.id, c.why, c.rank, c.sim, c.basis, c.label]);
    return J(got) === J(G.candidates) && J(canonStat(stat)) === J(G.pickStat) && J(state.repairCursor || {}) === J(G.cursorState);
})(), (() => { boot(G.inputs.scenario); const stat = {}; const c = repairCollectCandidates(20, stat); return { n: c.length, stat: canonStat(stat) }; })());

R.assert('H5 窄契约提示词 buildRepairPrompt：system（模板）+ user（清单行 / 相关度 / 来源 / 问题 / 现有文本 + 输出契约）与 V1 逐字符一致', (() => {
    boot(G.inputs.scenario);
    state.repairCursor = {};
    const cands = repairCollectCandidates(20, {});
    return J(buildRepairPrompt(cands)) === J(G.prompt);
})(), '');

R.assert('H6 应用 AI 结果 repairApplyAiResult：修订 3（内容/标题/标签）+ 删除 1，垃圾值与未知字段/未知编号丢弃；状态与墓碑与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const cands = repairCollectCandidates(20, {});
    const applied = repairApplyAiResult(clone(G.inputs.delta), cands);
    const gotState = {
        cands: cands.map(c => [c.n, c.dim, c.id]),
        atoms: state.atoms.map(e => [e.id, String(e.text).slice(0, 20), String(e.title || ''), e.tags || []]),
        memories: state.memories.map(e => [e.id, String(e.content).slice(0, 20), String(e.title || ''), e.tags || []]),
        deletedKeys: Object.keys(state.deleted || {}).reduce((acc, k) => { acc[k] = Object.keys((state.deleted || {})[k] || {}).sort(); return acc; }, {}),
    };
    const want = clone(G.applyState);
    return J({ revised: applied.revised, deleted: applied.deleted, skipped: applied.skipped }) === J(G.apply) && J(gotState) === J(want);
})(), (() => { boot(G.inputs.scenario); const c = repairCollectCandidates(20, {}); return repairApplyAiResult(clone(G.inputs.delta), c); })());

// ============================================================
// P 组：V2 三段式编排与闸门
// ============================================================
await A('P1 runRepair 三段式：机械清理 → 候选筛选 → AI 修订（用同一份 delta）→ 报告/日志；修订与删除落库', async () => {
    boot(G.inputs.scenario, { repairAutoAi: true, maxAutoRepairRounds: 3, autoRepairEveryOps: 0 });
    aiText = J(G.inputs.delta);
    const r = await runRepair({ cause: '单元测试' });
    const ai = r.ai || {};
    const log = Array.isArray(state.repairLog) ? state.repairLog : [];
    // 注意：第 1 段会先清掉一条垃圾记忆（m3）→ 候选比「纯筛选」场景少 1 条（统计口径随之变化）
    return r.made >= 3 && ai.used === true && ai.revised === G.apply.revised && ai.deleted === G.apply.deleted && ai.skipped === G.apply.skipped
        && r.cands.length >= 5 && Number((r.pickStat || {}).total) >= 8 && Number((r.pickStat || {}).corrHigh) >= 4
        && r.report.indexOf('本轮提交') >= 0 && log.length >= 1 && log[0].aiUsed === true && log[0].revised === G.apply.revised;
}, (() => ({ p1: 'see P1' })));

await A('P2 repairAutoAi 关闭：自动路径零 AI 调用（V1 语义：只做机械清理），手动路径不受该开关限制', async () => {
    boot(G.inputs.scenario, { repairAutoAi: false, maxAutoRepairRounds: 3, autoRepairEveryOps: 0 });
    aiText = J(G.inputs.delta);
    const auto = await runRepair({ silent: true, cause: '自动触发' });
    const autoCalls = aiCalls;
    const manual = await runRepair({ cause: '手动' });
    return auto.ai.used === false && autoCalls === 0 && manual.ai.used === true && manual.ai.revised === G.apply.revised && aiCalls === 1;
}, '');

await A('P3 频率与上限闸门在 runRepair 中生效：自动路径受 autoRepairEveryOps 与同楼层上限约束；手动路径重置计数', async () => {
    boot(G.inputs.scenario, { autoRepairEveryOps: 3, maxAutoRepairRounds: 1, repairAutoAi: false });
    const a1 = await runRepair({ silent: true, cause: '自动' });          // 首次：频率未到（ops=0 < 3）
    bumpRepairOp(); bumpRepairOp(); bumpRepairOp();
    const a2 = await runRepair({ silent: true, cause: '自动' });          // 频率已到 → 放行（消耗 1/1）
    const a3 = await runRepair({ silent: true, cause: '自动' });          // 同楼层已达上限 → 拒绝
    const m1 = await runRepair({ cause: '手动' });                        // 手动 → 重置并放行
    return a1.reason === 'auto-repair-frequency' && a2.blocked !== true && a3.reason && a3.reason.indexOf('auto-repair-limit') === 0
        && m1.blocked !== true;
}, '');

await A('P4 scheduleAutoRepairOnMergeFail：开关关闭或长任务在途不排程；开启后按 repairFailDelaySec 排程一次（防重复）', async () => {
    let scheduled = 0;
    boot(G.inputs.scenario, { autoRepairOnMergeFail: false });
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    const off = scheduleAutoRepairOnMergeFail();
    boot(G.inputs.scenario, { autoRepairOnMergeFail: true, repairFailDelaySec: 15 });
    setTimerHooks({ set: () => { scheduled++; return 1; }, clear: () => undefined });
    const on = scheduleAutoRepairOnMergeFail();
    const again = scheduleAutoRepairOnMergeFail();
    cancelRepairTimers();
    const cur = setAiHooks({});
    setAiHooks({ busy: () => true });
    const busy = scheduleAutoRepairOnMergeFail();
    setAiHooks({ busy: cur.busy });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return off === false && on === true && again === false && scheduled === 1 && busy === false;
}, '');

R.assert('P5 提取计数 bumpRepairOp 与闸门判定 autoRepairOpDue 配合（每 N 次提取才允许一次自动修复）', (() => {
    boot({}, { autoRepairEveryOps: 2 });
    const d0 = autoRepairOpDue();
    bumpRepairOp();
    const d1 = autoRepairOpDue();
    bumpRepairOp();
    const d2 = autoRepairOpDue();
    return d0 === false && d1 === false && d2 === true;
})(), '');

// ============================================================
// U 组：面板动作（三段式提示）
// ============================================================
await A('U1 面板动作 repair（三段式）：提示含「机械清理」「候选 N 条（缺陷/高相关/抽查/补足）」「AI 修订 N 条」', async () => {
    boot(G.inputs.scenario, { repairAutoAi: true, maxAutoRepairRounds: 3, autoRepairEveryOps: 0 });
    aiText = J(G.inputs.delta);
    openPanel('overview');
    setPanelHooks2({});
    const r = await panelAction('repair', {});
    const st = panelState();
    const note = String(st.note || '');
    return r.ok === true && r.repair && r.made >= 3
        && note.indexOf('自动修复：机械清理：合并') >= 0 && note.indexOf('候选 ') >= 0
        && note.indexOf('AI 修订 ' + G.apply.revised + ' 条') >= 0
        && note.indexOf('高相关 4') >= 0 && note.indexOf('缺陷 3') >= 0;
}, (() => ({ u1: 'see U1' })));

un();
R.done();
