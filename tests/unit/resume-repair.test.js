// ============================================================
// 单元测试 · v3.45.5（`docs/D22` W4 · `docs/D26` 履历链）—— 角色履历的**编排面**
//   （纯算法面在 `tests/unit/resume.test.js`；体检面在 `tests/unit/resume-health.test.js`；
//     界面面在 `tests/unit/resume-ui.test.js`。本档只测「接进角色修复管道之后」的行为。）
//
// 覆盖（`docs/D26` §4 的 H0–H4 与本批 `数-19` / `数-20` / `数-21` / `业-7` / `应-19` 的验收）：
//   H0/H1：`resumeMechanicalPass` —— 归一 → 遗弃（≤ 上限不动 / 超限清算 / 高重要免疫）→ 凝练（幂等）；
//   H1   ：同一档案连跑两次第二次零变化（幂等）；凝练不动 `date`/`time`/`importance`/`refs`/`source`；
//   H3   ：`identity.canon` 准入（无剧情时钟 → 不预填）+ `runResumeRepair` 的**上界护栏**（拒收未来条目）；
//   H4   ：`buildResumeRepairPrompt` 的履历契约与「不得重复已有条目」口径；
//   H2/H3：`runResumeRepair` 的**如实回报**（新增 / 凝练 / 遗弃 / 跳过原因 / 开关关闭 / AI 忙）；
//   另有：`runCharacterMechanicalPass` 折进履历段（→ `changed` → 落盘）、会话内账本、
//        `buildCharacterRepairPrompt` 仅在 `resumeGuide` 下带履历契约（V1 黄金样本路径不受影响）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    resumeMechanicalPass, resumeMechanicalPassFor, resumeLedgerState, resumeLedgerReset,
    buildResumeRepairPrompt, runResumeRepair, runCharacterMechanicalPass, buildCharacterRepairQueue,
    buildCharacterRepairPrompt,
} from '../../core/character-repair.js';
import { panelAction, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-character-repair.json'), 'utf8'));
const R = makeReporter('resume-repair v3.45.5 角色履历（编排 / 预填护栏 / 个体按钮）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

/** 同步断言（布尔） */
const A = (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
/** 异步断言（内部 `await`；防呆：写成 Promise 会在这里被 await，不会假绿） */
const Aa = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

/** 起一份最小环境；`opts.storyDate` 写入 `state.state.date`（剧情时钟的唯一来源）、`opts.cfg` 覆盖配置 */
function boot(stateLike, opts) {
    const o = opts || {};
    Object.assign(cfg, clone(defaultCfg));
    cfg.repairCharacterMinSize = 30; cfg.repairCharacterBatch = 3; cfg.repairFloors = 10;
    if (o.cfg) Object.assign(cfg, o.cfg);
    setScopeKey('甲');
    setLastMessageId(3);
    const st = Object.assign(emptyState(), clone(stateLike || {}));
    if (o.storyDate) st.state = Object.assign({}, st.state, { date: o.storyDate });
    setKernelState(st);
    state.repairCursor = state.repairCursor || {};
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: true, text: o.aiText != null ? o.aiText : '{}' }), feedText: () => (G.feedText || ''), busy: () => !!o.busy });
    setNotifyHooks({ toast: () => undefined });
    resumeLedgerReset();
    return state;
}
/** 造 N 条履历（**已按剧情时间倒序**，即归一后的规范形态；前 `immuneCount` 条为高重要） */
function makeResume(n, opts) {
    const o = opts || {};
    const out = [];
    for (let i = 0; i < n; i++) {
        // 倒序：第 1 条最新（这样 `resumeMechanicalPassFor` 不会因「排序」而判为有改动）
        out.push({ date: (1900 + (n - 1 - i)) + '-01-01', summary: '第 ' + (i + 1) + ' 件事', importance: (i < (o.immuneCount || 0)) ? 0.9 : 0.2 });
    }
    return out;
}
const snaps = () => (state.snapshots || []);

// ---------- A 组：机械段（归一 / 遗弃 / 凝练） ----------
A('A1 `resumeMechanicalPass` 遗弃：40 条 → 裁到上限；恰好 = 上限的档案**一条不删**（软阈值）；高重要条目全留', () => {
    boot({
        snapshots: [
            { id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) },
            { id: 's2', name: '角色乙', resume: makeResume(30, { immuneCount: 2 }) },
        ],
    });
    const r = resumeMechanicalPass();
    const a = snaps()[0].resume, b = snaps()[1].resume;
    const itemA = r.items.find((x) => x.name === '角色甲') || {};
    const itemB = r.items.find((x) => x.name === '角色乙') || {};
    return r.snapshots === 2 && r.dropped === 10
        && a.length === 30 && a.filter((e) => Number(e.importance) >= 0.7).length === 3
        && b.length === 30 && Number(itemA.dropped) === 10 && Number(itemB.dropped) === 0;
}, '');

A('A2 遗弃**确定性**：同一输入连跑两次，保留结果逐字节相同（keep → 更久远 → summary 字典序的 tie-break）', () => {
    const mk = () => ({ id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) });
    boot({ snapshots: [mk()] });
    const r1 = resumeMechanicalPass();
    const kept1 = J(snaps()[0].resume);
    boot({ snapshots: [mk()] });
    const r2 = resumeMechanicalPass();
    return r1.dropped === 10 && r2.dropped === 10 && J(snaps()[0].resume) === kept1;
}, '');

A('A3 机械段**幂等**：同一档案连跑两次，第二次 `changed === false`（归一无变化 / 未超限 / 凝练已达标）', () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: [{ date: '1919-01-01', summary: '甲'.repeat(120), importance: 0.5 }] }] });
    const r1 = resumeMechanicalPassFor(snaps()[0], { max: 30, summaryMax: 60 });
    const after1 = J(snaps()[0].resume);
    const r2 = resumeMechanicalPassFor(snaps()[0], { max: 30, summaryMax: 60 });
    return r1.changed === true && r1.condensed === 1 && snaps()[0].resume[0].summary.length <= 60
        && r2.changed === false && r2.condensed === 0 && J(snaps()[0].resume) === after1;
}, '');

A('A4 凝练只压 `summary`：`date` / `time` / `importance` / `refs` / `source` 逐字段不变（`docs/D26` §3.3）', () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: [{ date: '1919-01-01', time: '傍晚', summary: '乙'.repeat(100), importance: 0.8, refs: ['m1', 'm2'], source: 'manual' }] }] });
    const before = clone(snaps()[0].resume[0]);
    resumeMechanicalPassFor(snaps()[0], { max: 30, summaryMax: 60 });
    const after = snaps()[0].resume[0];
    return after.summary.length <= 60 && after.date === before.date && after.time === before.time
        && Number(after.importance) === Number(before.importance) && J(after.refs) === J(before.refs) && after.source === before.source;
}, '');

A('A5 归一闪顺带修掉脏条目：`date` / `summary` 缺一的条目**被丢弃**、重复条目去重、乱序被排成剧情时间倒序', () => {
    boot({
        snapshots: [{ id: 's1', name: '角色甲', resume: [
            { date: '', summary: '缺日期' }, { date: '1919-01-01', summary: '' },
            { date: '1900-01-01', summary: '早' }, { date: '1950-01-01', summary: '晚' },
            { date: '1900-01-01', summary: '早' },
        ] }],
    });
    const r = resumeMechanicalPassFor(snaps()[0], { max: 30, summaryMax: 60 });
    const list = snaps()[0].resume;
    return r.changed === true && list.length === 2 && list[0].date === '1950-01-01' && list[1].date === '1900-01-01';
}, '');

A('A6 `runCharacterMechanicalPass` 已折进履历段：`mech.resume` 有读数，且履历有改动 → `mech.changed === true`（触发落盘）', () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) }] });
    const mech = runCharacterMechanicalPass();
    return !!mech.resume && mech.resume.snapshots === 1 && mech.resume.dropped === 10
        && mech.changed === true && snaps()[0].resume.length === 30;
}, '');

A('A7 会话内账本：`resumeLedgerState()` 累计遗弃/凝练；`resumeLedgerReset()` 只清计数、**不动数据**', () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) }] });
    resumeMechanicalPass();
    const led = resumeLedgerState();
    const kept = snaps()[0].resume.length;
    resumeLedgerReset();
    const after = resumeLedgerState();
    return led.runs === 1 && led.snapshots === 1 && led.dropped === 10
        && after.runs === 0 && after.dropped === 0 && snaps()[0].resume.length === kept;
}, '');

A('A8 开关关闭 → 机械段**整体不执行**（一条不动、无账本累积）', () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) }] }, { cfg: { snapshotResumeEnabled: false } });
    const r = resumeMechanicalPass();
    return r.snapshots === 0 && r.changed === 0 && snaps()[0].resume.length === 40 && resumeLedgerState().runs === 0;
}, '');

// ---------- B 组：历史 / 同人预填的准入与护栏（`数-21`） ----------
A('B1 准入：`identity.canon === true` 且**有剧情时钟** → `canonFill === true`；非原作 → `canonFill === false`', () => {
    boot({
        snapshots: [
            { id: 's1', name: '史实人物', identity: { canon: true }, resume: [] },
            { id: 's2', name: '普通角色', resume: [] },
        ],
    }, { storyDate: '1930-06-01' });
    cfg.repairCharacterMinSize = 0;
    const q = buildCharacterRepairQueue();
    const a = q.all.find((x) => x.name === '史实人物'), b = q.all.find((x) => x.name === '普通角色');
    return !!a && !!b && a.canon === true && a.canonFill === true && a.canonBlocked === ''
        && b.canon === false && b.canonFill === false;
}, '');

A('B2 无剧情时钟 → **不预填**：`canonBlocked === \'no-clock\'`、`canonFill === false`，且提示词明确禁止写「原作」来源', () => {
    boot({ snapshots: [{ id: 's1', name: '史实人物', identity: { canon: true }, resume: [] }] });
    cfg.repairCharacterMinSize = 0;
    const q = buildCharacterRepairQueue();
    const t = q.all.find((x) => x.name === '史实人物');
    const user = String((buildResumeRepairPrompt(snaps()[0], {})[1] || {}).content || '');
    return !!t && t.canon === true && t.canonFill === false && t.canonBlocked === 'no-clock'
        && user.indexOf('当前剧情日期】未知') >= 0 && user.indexOf('不要**补任何') >= 0;
}, '');

A('B3 有上界时提示词给出**当前剧情日期**、标注「原作人物」、并列出已有履历要求不重复', () => {
    boot({
        snapshots: [{ id: 's1', name: '史实人物', identity: { canon: true }, resume: [{ date: '1900-01-01', summary: '旧事一桩', importance: 0.5 }] }],
    }, { storyDate: '1930-06-01' });
    const user = String((buildResumeRepairPrompt(snaps()[0], {})[1] || {}).content || '');
    return user.indexOf('原作人物') >= 0 && user.indexOf('1930-06-01') >= 0 && user.indexOf('旧事一桩') >= 0
        && user.indexOf('不得**写入此日之后') >= 0;
}, '');

// ---------- C 组：个体按钮（`应-19` ②）与结果应用 ----------
await Aa('C1 原作人物补履历：**晚于上界的条目被拒收**，之前的入库且来源强制为 `原作`；回报 `added` / `rejected`', async () => {
    boot({
        snapshots: [{ id: 's1', name: '史实人物', identity: { canon: true }, resume: [] }],
    }, {
        storyDate: '1930-06-01',
        aiText: J({ '履历': { '新增': [
            { '日期': '1890-05-01', '简述': '早年经历一事', '重要性': 0.8 },
            { '日期': '1940-05-01', '简述': '剧情尚未发生的事' },
        ] } }),
    });
    const r = await runResumeRepair('史实人物');
    const list = snaps()[0].resume;
    return r.ok === true && r.aiUsed === true && r.added === 1 && r.rejected === 1
        && list.length === 1 && list[0].source === 'canon' && list[0].date === '1890-05-01';
}, '');

await Aa('C2 非原作角色：AI 就算标了「原作」，也**强制回落为「剧情」**（防误标批量编造，`docs/D26` R6）', async () => {
    boot({ snapshots: [{ id: 's1', name: '普通角色', resume: [] }] }, {
        storyDate: '1930-06-01',
        aiText: J({ '履历': { '新增': [{ '日期': '1919-01-01', '简述': '普通一件事', '来源': '原作' }] } }),
    });
    const r = await runResumeRepair('普通角色');
    return r.ok === true && r.added === 1 && snaps()[0].resume[0].source === 'story';
}, '');

await Aa('C3 AI 凝练：只接受「更短且 ≤ 目标长度」的版本（更长的被忽略），且不改日期与重要性', async () => {
    boot({
        snapshots: [{ id: 's1', name: '角色甲', resume: [{ date: '1919-01-01', summary: '丙'.repeat(100), importance: 0.6 }] }],
    }, {
        storyDate: '1930-06-01',
        aiText: J({ '履历': { '新增': [], '凝练': [
            { '日期': '1919-01-01', '原简述': '丙丙丙', '简述': '压缩后的短句' },
            { '日期': '1919-01-01', '原简述': '丙丙丙', '简述': '丁'.repeat(500) },
        ] } }),
    });
    const r = await runResumeRepair('角色甲');
    const e = snaps()[0].resume[0];
    return r.ok === true && r.condensed >= 1 && e.summary === '压缩后的短句'
        && e.date === '1919-01-01' && Number(e.importance) === 0.6;
}, '');

await Aa('C4 开关关闭 → 如实拒绝（`reason === \'disabled\'`，一条不改）；开关打开但角色不存在 → `no-role`', async () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40) }] }, { cfg: { snapshotResumeEnabled: false } });
    const r = await runResumeRepair('角色甲');
    const stillDisabled = snaps()[0].resume.length === 40;
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40) }] }, { storyDate: '1930-06-01' });
    const r2 = await runResumeRepair('查无此人');
    return r.ok === false && r.reason === 'disabled' && stillDisabled
        && r2.ok === false && r2.reason === 'no-role' && snaps()[0].resume.length === 40;
}, '');

await Aa('C5 AI 忙 → 只做机械段并如实标「为什么没调 AI」（`aiSkipped === \'busy\'`，不谎报「已补全」）；无变化 → `no-change`', async () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(40, { immuneCount: 3 }) }] }, { busy: true, storyDate: '1930-06-01' });
    const r = await runResumeRepair('角色甲');
    const r2 = await runResumeRepair('角色甲');
    return r.ok === true && r.aiUsed === false && r.aiSkipped === 'busy' && r.dropped === 10
        && r.after === 30 && r2.reason === 'no-change' && r2.aiSkipped === 'busy';
}, '');

await Aa('C6 `noAi: true` → 纯机械段（`aiSkipped === \'no-ai\'`，不调 AI）；回报 `total` / `max` 供界面显示「N / 上限」', async () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(5) }] }, { storyDate: '1930-06-01' });
    const r = await runResumeRepair('角色甲', { noAi: true });
    return r.ok === true && r.aiUsed === false && r.aiSkipped === 'no-ai' && r.total === 5 && r.max === 30
        && r.added === 0 && r.dropped === 0 && r.condensed === 0;
}, '');

await Aa('C7 空手 AI（`{}`）不产生假变化：`added === 0`、条数不变（不虚报「已补全」）', async () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(5) }] }, { storyDate: '1930-06-01', aiText: '{}' });
    const r = await runResumeRepair('角色甲');
    return r.ok === true && r.aiUsed === true && r.added === 0 && r.after === 5 && r.dropped === 0;
}, '');

// ---------- D 组：与「🔧 修复角色」的联动（`业-7` · Q6 默认连修） ----------
A('D1 `buildCharacterRepairPrompt` 在 `resumeGuide` 下带履历契约：列出已有履历 + 「只输出新增」 + 与「经历」分工；默认调用一字不加', () => {
    boot({
        snapshots: [{ id: 's1', name: '角色甲', identity: { canon: true }, resume: [{ date: '1919-01-01', summary: '旧履历一条', importance: 0.9 }] }],
    }, { storyDate: '1930-06-01' });
    cfg.repairCharacterMinSize = 0;
    const targets = buildCharacterRepairQueue().list.slice(0, 1);
    const withGuide = String((buildCharacterRepairPrompt(targets, { resumeGuide: true })[1] || {}).content || '');
    const without = String((buildCharacterRepairPrompt(targets, {})[1] || {}).content || '');
    return withGuide.indexOf('【履历维护】') >= 0 && withGuide.indexOf('旧履历一条') >= 0
        && withGuide.indexOf('不要重复') >= 0 && withGuide.indexOf('背景资料.经历') >= 0
        && withGuide.indexOf('1930-06-01') >= 0
        && without.indexOf('【履历维护】') < 0;
}, '');

// ---------- E 组：面板动作路由（`应-19` ② 的落地依赖） ----------
await Aa('E1 面板动作 `resumeRepair` 可达：按 `data-ftt-id`（`p.id`）找到该档案 → 走 `runResumeRepair` → 结果与四类计数写回面板 note', async () => {
    boot({
        snapshots: [{ id: 's1', name: '史实人物', identity: { canon: true }, resume: [] }],
    }, {
        storyDate: '1930-06-01',
        aiText: J({ '履历': { '新增': [{ '日期': '1890-05-01', '简述': '早年经历一事', '重要性': 0.8 }] } }),
    });
    openPanel('snapshots'); setPanelHooks2({});
    // 真实交互：行内按钮带 `data-ftt-action="resumeRepair" data-ftt-id="s1"`，通用分发透传为 `p.id`
    const r = await panelAction('resumeRepair', { id: 's1' });
    const note = String((panelState() || {}).note || '');
    return r.ok === true && !!r.resumeRepair && Number(r.added) === 1
        && note.indexOf('履历：') >= 0 && note.indexOf('新增 1 条') >= 0 && note.indexOf('现有 1 / 30 条') >= 0;
}, '');

await Aa('E2 面板动作 `resumeRepair` 的失败路径**如实回报**：开关关闭 → 提示去设定打开；找不到角色 → 明确「找不到该角色档案」', async () => {
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(3) }] }, { cfg: { snapshotResumeEnabled: false } });
    openPanel('snapshots'); setPanelHooks2({});
    const r = await panelAction('resumeRepair', { id: 's1' });
    const note = String((panelState() || {}).note || '');
    boot({ snapshots: [{ id: 's1', name: '角色甲', resume: makeResume(3) }] }, { storyDate: '1930-06-01' });
    openPanel('snapshots'); setPanelHooks2({});
    const r2 = await panelAction('resumeRepair', { id: '不存在的 id' });
    const note2 = String((panelState() || {}).note || '');
    return r.ok === false && note.indexOf('履历：') >= 0 && note.indexOf('履历功能已关闭') >= 0
        && r2.ok === false && note2.indexOf('找不到该角色档案') >= 0;
}, '');

R.done();
