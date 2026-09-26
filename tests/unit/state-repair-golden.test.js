// ============================================================
// 单元测试 · B8-6c-4 状态记录修复管道（V1 v1.158 + v1.205）
//   （与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-state-repair.json —— 字段归一 / 名册 / 主体匹配 / 角色匹配（union merge +
//   规范化 + 无档案整组删除 + 名册空安全阀）/ 机械清理（占位·别名·截断·去重·条数上限）/ 目标选取（薄弱排序 +
//   batch + 已去世跳过）/ 提示词（逐字符）/ 按主体+字段精确应用（更新·补齐·规范化·未知主体·非法字段·占位值·
//   两种删除写法·无依据）/ 已去世固定规则（幂等 + 双墓碑）/ `runStateRepair` 全链路 / `applyStateBounds` 自证。
// 覆盖：
//   `stateCanonField` / `stateRepairRoster` / `stateSubjectMatch` / `stateRepairMatch` / `stateRepairClean` /
//   `pickStateRepairTargets` / `buildStateRepairPrompt` / `applyStateRepair` / `removeStatesOfDeceased` /
//   `deceasedNameKeys` / `runStateRepair`；另含 V2 编排与接线：`aiBusy` 互斥、空库、无目标早退、AI 非法 JSON、
//   面板 `states` 分页按钮与动作、`FTT.*` 调试入口与无 hook 降级。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks, setIdentityView,
} from '../../core/model/runtime.js';
import { defaultCfg, normalizeDeltaKeys } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { applyStateBounds } from '../../core/ingest.js';
import {
    STATE_REPAIR_FIELDS, stateCanonField, stateRepairRoster, stateSubjectMatch, stateRepairMatch, stateRepairClean,
    removeStatesOfDeceased, pickStateRepairTargets, buildStateRepairPrompt, applyStateRepair, runStateRepair,
} from '../../core/state-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-state-repair.json'), 'utf8'));
const R = makeReporter('state-repair-golden B8-6c-4 状态记录修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
/** 记录最近一次 NOTIFY（V1 `toastLogGet` 的 V2 等价：notifyHooks.toast(text, kind)） */
let toasts = [];
let aiText = '{}';
let aiCalls = 0;
/** 场景装载：替换 state + 清空墓碑 + 对齐删除留痕基线（V1 saveState 内建 tombstoneSweep；
 *  V2 由宿主 `adapters/store.js#saveStateNow` 承担 → 测试桩按同一口径注入，保证墓碑与 V1 逐字段可比） */
function setState(stateLike) {
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    state.deleted = {}; state.deletedH = {}; state.repairCursor = state.repairCursor || {};
    entryIndexInit();
    return state;
}
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    // oracle 固定阈值/上限/字数上限 → V2 同值，保证确定可比（cfgPatch 可再覆盖）
    cfg.dimCharLimits = Object.assign({}, clone(defaultCfg.dimCharLimits), { states: 130 });
    cfg.repairFloors = 10; cfg.stateRepairBatch = 3; cfg.stateMaxPerSubject = 10; cfg.stateMinPerSubject = 0;
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(3);                       // oracle mock env：getLastMessageId() === 3
    setIdentityView({ characterName: '角色甲' });   // V1 `getCurrentCharacterId()` 的 V2 等价注入点
    setPersistHooks({
        // V1 `saveState()` = 建当前索引 + tombstoneSweep + 写库；V2 同口径（持久化由宿主承担）
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    aiText = '{}'; aiCalls = 0;
    // 面板/编排路径共用 AI 钩子；feedText 固定为 oracle 捕获的投喂文本（V1 `buildFeedFloorText(10)`）
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => G.feedText, busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return setState(stateLike);
}
const stateView = () => (state.currentStates || []).map(x => ({
    id: x.id, subject: x.subject, field: x.field, value: x.value, status: x.status,
    uses: x.uses, floorStart: x.floorStart, floorEnd: x.floorEnd, updatedAt: x.updatedAt, updatedAtTime: x.updatedAtTime,
    history: x.history || null,
}));
const tombIds = () => Object.keys((state.deleted || {}).currentStates || {}).sort();
const tombHashes = () => Object.keys((state.deletedH || {}).currentStates || {}).sort();
/** V1 `toastLogGet()` 的 `{kind,title,text}` → V2 `notifyHooks.toast(text, kind)` 的 `[kind, 'title text']`
 *  （V1 `notify('repair', …)` 的 toastr 类型是 warning；V2 notifyHooks 只认 info/success/warning/error） */
const wfToasts = (list) => list.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);

// ============================================================
// I 组：状态修复内核 —— 与 V1 逐项比对
// ============================================================
R.assert('I1 stateCanonField 字段归一：6 个规范字段原样 / 别名表 / 含规范字段关键字（带括号后缀）/ 关键字正则兜底 / 无法归一 → 空串 —— 与 V1 oracle 逐项一致', (() => {
    boot(G.inputs.scenarioRoster);
    const got = G.canonField.map(([f]) => [String(f), String(stateCanonField(f) || '')]);
    return J(got) === J(G.canonField) && STATE_REPAIR_FIELDS.length === 6
        && stateCanonField('身体') === '身体状况与伤势' && stateCanonField('心情') === '情绪与心理状态'
        && stateCanonField('身体状况与伤势（左臂）') === '身体状况与伤势' && stateCanonField('无关字段') === '';
})(), G.canonField);

R.assert('I2 stateRepairRoster 名册来源与优先级（档案 > 名册 > 主角 > 在场 > 当前角色）：names 顺序、source 归属、strong 只计「有据可依」来源 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioRoster);
    const got = stateRepairRoster();
    return J(got) === J(G.roster) && got.strong === 5 && got.names.length === 6
        && got.source['角色甲'] === '当前角色' && got.names.indexOf('角色乙') === 0;
})(), G.roster);

R.assert('I3 stateSubjectMatch 主体 → 规范名：档案同 key 直取 / 精确与姓名核一致 / 包含且长度差 ≤4 / bigram 相似度达阈值 / 未命中空串 —— 与 V1 oracle 逐项一致', (() => {
    boot(G.inputs.scenarioRoster);
    const roster = stateRepairRoster();
    const got = ['角色乙', '角色乙·船长', '乙', '角色丁', '角色甲', '路人甲', '', '角色'].map(s => [s, String(stateSubjectMatch(s, roster, 0.72) || '')]);
    return J(got) === J(G.subjectMatch) && stateSubjectMatch('', roster, 0.72) === ''
        && stateSubjectMatch('角色乙', roster, 0.72) === '角色乙';
})(), G.subjectMatch);

R.assert('I4 stateRepairMatch 主路径：① statesSubjectUnionMerge 归并同人称呼（merged）→ ② 主体规范化（renamed，乙 → 角色乙）→ ③ 无档案主体整组删除（removed + removedSubjects，双墓碑）+ 幂等（第二次零变化）—— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioMatch);
    const got = { r: stateRepairMatch(), states: stateView(), tombs: tombIds(), hashes: tombHashes() };
    boot(G.inputs.scenarioMatch);
    const again = stateRepairMatch();
    boot(G.inputs.scenarioMatch);
    const simLow = stateRepairMatch({ sim: 0.5 });
    return J(got) === J(G.match) && J(again) === J(G.matchAgain) && J(simLow) === J(G.matchSimLow)
        && got.r.merged === 1 && got.r.renamed === 1 && got.r.removed === 1
        && J(got.r.removedSubjects) === J(['黑衣人']) && got.states.length === 4 && got.tombs.length === 2;
})(), G.match);

R.assert('I5 stateRepairMatch 安全阀：档案 / 名册 / 主角 / 在场全空（strong = 0）→ noRoster=true，**不做「未匹配即删除」**（一条不删、零墓碑）—— 与 V1 oracle 一致', (() => {
    boot(G.inputs.scenarioMatchNoRoster);
    const got = { r: stateRepairMatch(), states: stateView(), tombs: tombIds() };
    return J(got) === J(G.matchNoRoster) && got.r.noRoster === true && got.r.removed === 0
        && got.states.length === 2 && got.tombs.length === 0;
})(), G.matchNoRoster);

R.assert('I6 stateRepairClean 主路径：空值/占位丢弃（junk）/ 字段别名归一（renamedField）/ 超长按 `dimCharLimits.states` 截断（trimmed）/ 同主体同字段去重（merged，保更新者：uses 累加、楼层并集、history 归并）/ 非规范字段保留 + 双墓碑 + 幂等 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioClean);
    const got = { r: stateRepairClean(), states: stateView(), tombs: tombIds(), hashes: tombHashes() };
    boot(G.inputs.scenarioClean);
    const again = stateRepairClean();
    const c2 = (state.currentStates || []).find(x => x.id === 'c2') || {};
    return J(got) === J(G.clean) && J(again) === J(G.cleanAgain)
        && got.r.junk === 3 && got.r.merged === 1 && got.r.renamedField === 2 && got.r.trimmed === 1
        && got.r.before === 12 && got.r.after === 8
        && c2.uses === 3 && String((state.currentStates || []).find(x => x.id === 'c5').value).length === 130;
})(), G.clean);

R.assert('I7 stateRepairClean 每角色条数上限（`stateMaxPerSubject`，保调用次数高 → 楼层新）+ 空库早退 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioCap, { stateMaxPerSubject: 2 });
    const got = { r: stateRepairClean(), states: stateView(), tombs: tombIds() };
    const keptInactive = (state.currentStates || []).some(x => x.status === 'inactive');   // inactive 不参与计数/裁剪
    boot({ currentStates: [] });
    const empty = stateRepairClean();
    return J(got) === J(G.cleanCap) && J(empty) === J(G.cleanEmpty)
        && got.r.capped === 2 && got.r.after === 3 && J(got.tombs) === J(['k1', 'k4']) && keptInactive;
})(), G.cleanCap);

R.assert('I8 pickStateRepairTargets 薄弱排序（规范字段填充少 → 更新时间旧 → 调用次数低）+ batch 上限（≤10）+ 已去世角色（身份.已去世）的状态**不提交 AI** —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioTargets);
    const pk = pickStateRepairTargets();
    const got = {
        batch: pk.batch, total: pk.total,
        list: pk.list.map(t => ({ name: t.name, filled: t.filled, missing: t.missing, uses: t.uses, last: t.last, lastAt: t.lastAt, arrLen: t.arr.length, fieldMap: t.fieldMap })),
    };
    const limit = (() => { const p = pickStateRepairTargets(10); return { batch: p.batch, total: p.total, names: p.list.map(t => t.name) }; })();
    boot(G.inputs.scenarioTargets);
    const one = (() => { const p = pickStateRepairTargets(1); return { batch: p.batch, total: p.total, names: p.list.map(t => t.name) }; })();
    return J(got) === J(G.pick) && J(limit) === J(G.pickLimit) && J(one) === J(G.pickOne)
        && got.list[0].name === '角色丁' && got.list.map(t => t.name).indexOf('角色丙') < 0 && got.total === 2;
})(), G.pick);

R.assert('I9 buildStateRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（模板 + 目标主体字段级现状 + 缺失规范字段清单 + 聚焦近期正文 + 允许字段闭集 + 输出契约）；`{list:[]}` → 空清单形态一致', (() => {
    boot(G.inputs.scenarioTargets);
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { statesRepair: '（测试用状态修复模板）' });
    const pick = pickStateRepairTargets();
    const got = buildStateRepairPrompt(pick);
    return J(got) === J(G.prompt) && J(buildStateRepairPrompt({ list: [] })) === J(G.promptEmpty)
        && got.length === 2 && got[0].role === 'system' && String(got[0].content).indexOf('只输出 JSON') >= 0
        && String(got[1].content).indexOf('【待修复状态（本轮共 2 名主体') >= 0
        && String(got[1].content).indexOf('（非规范字段：可改写为规范字段或删除）') >= 0;
})(), G.prompt.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('I10 applyStateRepair 全量应用（归一化 delta）：更新现有值 / 非规范字段按该主体已有条目保留 / 新建补齐（added，`normalizeCurrentState` 生成 id 与楼层）/ 未变（unchanged）/ 非法字段·占位值·非对象（invalid）/ 未知主体（unknownRole）/ 值超长截断 / 无依据计数 —— counts + states + 墓碑与 V1 逐字段一致', (() => {
    boot(G.inputs.scenarioTargets);
    const pick = pickStateRepairTargets();
    const r = applyStateRepair(normalizeDeltaKeys(clone(G.inputs.aiA)), pick);
    const got = { r, states: stateView(), tombs: tombIds(), hashes: tombHashes() };
    const t2 = (state.currentStates || []).find(x => x.id === 't2') || {};
    const t4 = (state.currentStates || []).find(x => x.id === 't4') || {};
    return J(got) === J(G.apply)
        && r.changed === 5 && r.added === 3 && r.unchanged === 1 && r.invalid === 3 && r.unknownRole === 1 && r.noBasis === 2
        && t2.value === '在码头边' && t4.value === '改后的值' && String(t4.updatedAt) === '2020-06-01';
})(), G.apply.r);

R.assert('I11 applyStateRepair 删除段（V1 原样：只认 `ops["删除"]`/`ops.delete`，中文键未归一才命中）：对象写法 {主体,字段} 与文本写法「主体·字段」都按目标主体名**前缀**匹配 → 字段级删除 + 双墓碑；未知主体计入 unknownRole —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioTargets);
    const pick = pickStateRepairTargets();
    const got = { r: applyStateRepair(clone(G.inputs.applyRaw), pick), states: stateView(), tombs: tombIds(), hashes: tombHashes() };
    return J(got) === J(G.applyRawDelete) && got.r.deleted === 2 && got.r.changed === 3 && got.r.unknownRole === 1
        && J(got.tombs) === J(['t3', 't4']) && got.states.length === 3;
})(), G.applyRawDelete.r);

R.assert('I12 applyStateRepair 非规范字段改写为规范字段名（`renamedField`）：该主体已存在同名非规范条目时改写字段而非新增 —— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioRename);
    const pick = pickStateRepairTargets();
    const r = applyStateRepair(normalizeDeltaKeys(clone(G.inputs.aiB)), pick);
    const got = { r, states: stateView() };
    return J(got) === J(G.applyRename) && r.renamedField === 1 && r.changed === 1 && r.added === 0
        && state.currentStates[0].field === '身体状况与伤势' && state.currentStates[0].value === '强健';
})(), G.applyRename.r);

R.assert('I13 applyStateRepair 边界：空 pick（全部 unknownRole）/ null delta（零改动不抛错）—— 与 V1 oracle 一致', (() => {
    boot(G.inputs.scenarioRename);
    const pick = pickStateRepairTargets();
    const noPick = applyStateRepair({ states: { update: [{ subject: '角色乙', field: '处境', value: 'x' }] } }, { list: [] });
    const bad = applyStateRepair(null, pick);
    return J(noPick) === J(G.applyNoPick) && J(bad) === J(G.applyBadDelta)
        && noPick.unknownRole === 1 && noPick.changed === 0 && bad.changed === 0;
})(), [G.applyNoPick, G.applyBadDelta]);

R.assert('I14 removeStatesOfDeceased 固定规则（v1.205）：已去世角色状态按主体名归一后**全等**整组移除（称呼差异残留不误删）+ 内容哈希墓碑 + 幂等（第二次 removed=0）—— 与 V1 oracle 逐字段一致', (() => {
    boot(G.inputs.scenarioTargets);
    const r1 = removeStatesOfDeceased();
    const got = { r: r1, states: stateView(), tombs: tombIds(), hashes: tombHashes() };
    const again = { r: removeStatesOfDeceased(), states: stateView() };
    return J(got) === J(G.deceased) && J(again) === J(G.deceasedAgain)
        && r1.removed === 1 && r1.deceased === 1 && r1.scanned === 5 && J(r1.subjects) === J(['角色丙'])
        && again.r.removed === 0;
})(), G.deceased.r);

R.assert('I15 applyStateBounds（V1 v1.101 状态固定模板条数钳制）—— V2 **已有等价实现**（`core/ingest.js`），与 V1 oracle 逐字段一致：每角色保留 floorEnd/updatedAt 最新者，inactive 不参与计数', (() => {
    boot(G.inputs.scenarioCap, { stateMaxPerSubject: 2 });
    const got = { r: applyStateBounds(), states: stateView() };
    return J(got) === J(G.stateBounds) && got.r.cut === 2 && got.states.length === 3
        && got.states.map(x => x.id).join(',') === 'k3,k4,k5';
})(), G.stateBounds);

// ============================================================
// P 组：V2 编排（runStateRepair 四步全链路）
// ============================================================
await A('P1 runStateRepair 全链路：⓪ 已去世固定规则移除 → ① 匹配角色 → ② 机械清理 → ③ AI（桩）→ 按主体+字段精确应用 —— 返回结构 / 落库 / 墓碑 / 通知文案与 V1 逐项一致', async () => {
    boot(G.inputs.scenarioTargets);
    state.repairCursor = {};
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { statesRepair: '（测试用状态修复模板）' });
    aiText = JSON.stringify(G.inputs.aiA);
    const r = await runStateRepair();
    const got = {
        res: {
            made: r.made, before: r.before, after: r.after, targets: r.targets, queueLeft: r.queueLeft,
            match: r.match, clean: r.clean, ai: r.ai, keys: Object.keys(r).sort(),
        },
        states: stateView(), tombs: tombIds(), toasts, aiCalls,
    };
    const want = Object.assign({}, clone(G.run), { toasts: wfToasts(G.run.toasts) });
    return J(got) === J(want) && aiCalls === 1 && r.made === 1 && r.before === 5 && r.after === 7
        && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('本轮只提交最薄弱的 2 名') >= 0;
}, G.run.res);

await A('P2 runStateRepair 机械段之后无主体可提交：**不发 AI**（aiCalls = 0）、如实回报 skipped + 机械成果（清理空值/占位）—— 与 V1 一致', async () => {
    boot(G.inputs.scenarioAllJunk);
    state.repairCursor = {};
    const r = await runStateRepair();
    const got = { res: r, states: stateView(), toasts: wfToasts(toasts), aiCalls };
    const want = Object.assign({}, clone(G.runNoTargets), { toasts: wfToasts(G.runNoTargets.toasts) });
    return J(got) === J(want) && aiCalls === 0 && r.made === 1 && r.skipped === true
        && String(toasts[0][1]).indexOf('无可提交 AI 的主体') >= 0;
}, G.runNoTargets.res);

await A('P3 runStateRepair 空库：直接返回 skipped 并提示先产生状态（不触发 AI / 不写墓碑）', async () => {
    boot({ currentStates: [] });
    const r = await runStateRepair();
    return J({ res: r, toasts: wfToasts(toasts) }) === J(Object.assign({}, clone(G.runEmpty), { toasts: wfToasts(G.runEmpty.toasts) }))
        && r.made === 0 && r.skipped === true && aiCalls === 0
        && String(toasts[0][1]).indexOf('暂无状态记录') >= 0;
}, G.runEmpty.res);

await A('P4 runStateRepair 长任务在途拒绝（aiBusy 互斥语义，同 core/repair.js#runRepair）：返回 blocked，不改动任何数据', async () => {
    boot(G.inputs.scenarioTargets);
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: '{}' }; }, feedText: () => G.feedText, busy: () => true });
    const before = J(stateView());
    const r = await runStateRepair();
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => G.feedText, busy: () => false });
    return r.made === 0 && r.blocked === true && J(stateView()) === before && aiCalls === 0
        && toasts.length === 1 && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('修复进行中') >= 0;
}, '');

await A('P5 runStateRepair AI 未返回有效 JSON：不崩溃、AI 段零改动，机械段（含已去世固定规则）的成果仍保留（V2 编排不虚报）', async () => {
    boot(G.inputs.scenarioTargets);
    state.repairCursor = {};
    aiText = '这不是 JSON';
    const r = await runStateRepair();
    return aiCalls === 1 && Number(r.ai.changed) === 0 && Number(r.ai.added) === 0
        && (state.currentStates || []).length === 4                    // 已去世 1 条移除，AI 段零改动
        && (state.currentStates || []).every(x => x.subject !== '角色丙')
        && r.made === 0 && toasts.length >= 1;   // V1 口径：made 只计 匹配/清理/AI 改动，已去世固定规则不计入
}, '');

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 状态分页渲染 V1 同款「🔧 修复状态」按钮（有状态记录时显示、无记录时隐藏；文案与 title 逐字对齐）', (() => {
    boot(G.inputs.scenarioTargets);
    openPanel('states'); setPanelHooks2({});
    const html = panelBodyHtml('states');
    const hasBtn = html.indexOf('data-ftt-action="stateRepair"') >= 0 && html.indexOf('🔧 修复状态') >= 0
        && html.indexOf('title="匹配角色 → 机械清理与字段规范化 → 交 AI 整理"') >= 0;
    boot({ currentStates: [] });
    openPanel('states');
    const empty = panelBodyHtml('states');
    // v2.62.0：状态页空态文案对齐 V1（「暂无状态记录。运行「AI 摘要」或点「添加状态」创建。」）
    return hasBtn && empty.indexOf('data-ftt-action="stateRepair"') < 0 && empty.indexOf('暂无状态记录。运行「AI 摘要」或点「添加状态」创建。') >= 0;
})(), '');

await A('U2 面板动作 stateRepair 可达：走 runStateRepair 全链路并把结果写回面板 `state.note`（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenarioTargets);
    state.repairCursor = {};
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { statesRepair: '（测试用状态修复模板）' });
    aiText = JSON.stringify(G.inputs.aiA);
    openPanel('states'); setPanelHooks2({});
    const r = await panelAction('stateRepair', {});
    const note = String(panelState().note || '');
    return r.ok === true && !!r.stateRepair && r.made === 1 && r.action === 'stateRepair' && aiCalls === 1
        && note.indexOf('状态修复：') >= 0 && note.indexOf('目标 2 名') >= 0 && note.indexOf('AI 更新 5 条') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：stateRepairFields / stateCanonField / stateRepairRoster / stateSubjectMatch / stateRepairMatch / stateRepairClean / removeStatesOfDeceased / stateRepairTargets / stateRepairPrompt / stateRepairApply / stateRepair', (() => {
    boot(G.inputs.scenarioTargets, { stateMaxPerSubject: 2 });
    state.repairCursor = {};
    const on = installDevtools({
        stateRepairFields: () => STATE_REPAIR_FIELDS,
        stateCanonField: (f) => stateCanonField(f),
        stateRepairRoster: () => stateRepairRoster(),
        stateSubjectMatch: (s, roster, sim) => stateSubjectMatch(s, roster, sim),
        stateRepairMatch: (o) => stateRepairMatch(o || {}),
        stateRepairClean: () => stateRepairClean(),
        removeStatesOfDeceased: (o) => removeStatesOfDeceased(o || {}),
        stateRepairTargets: (n) => pickStateRepairTargets(n),
        stateRepairPrompt: (p) => buildStateRepairPrompt(p),
        stateRepairApply: (d, p) => applyStateRepair(d, p),
        stateRepair: (o) => runStateRepair(o),
    });
    const F = globalThis.FTT;
    const fields = F.stateRepairFields();
    const roster = F.stateRepairRoster();
    const pk = F.stateRepairTargets();
    const prompt = F.stateRepairPrompt(pk);
    const mech = F.stateRepairMatch({ sim: 0.5 });
    const clean = F.stateRepairClean();
    const rm = F.removeStatesOfDeceased();
    const applied = F.stateRepairApply({ states: { update: [{ subject: '角色乙', field: '长期目标', value: '远航' }] } }, pk);
    const ok = on === true && Array.isArray(fields) && fields.length === 6
        && F.stateCanonField('心情') === '情绪与心理状态' && roster.strong === 6
        && F.stateSubjectMatch('角色乙', roster, 0.72) === '角色乙'
        && Array.isArray(prompt) && prompt.length === 2 && applied.added === 1
        && clean.before === 5 && rm.removed === 1 && mech.removed === 0
        && typeof F.stateRepair === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.stateRepair 无 hook 时按约定降级（不抛错），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenarioAllJunk);
    installDevtools({});
    const noHook = await globalThis.FTT.stateRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenarioTargets);
    state.repairCursor = {};
    installDevtools({ stateRepair: (o) => runStateRepair(o) });
    const r = await globalThis.FTT.stateRepair({ aiText: JSON.stringify(G.inputs.aiA) });
    uninstallDevtools();
    return degraded && r.made === 1 && r.ai && r.ai.changed === 5;
}, '');

un();
R.done();
