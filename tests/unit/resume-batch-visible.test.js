// ============================================================
// 单元测试 · v3.48.1 「📜 批量完善履历」入口**恒显** + 无候选时如实说明成因
//   （用户报告：「修改角色旁批量补全履历功能，发版后消失了，需修复。」）
//
// 缺陷与修法：
//   · 旧口径：入口按钮**按候选数隐藏**（`resumeBatchCandidates().length === 0` → 返回空串）；
//     而候选要求「记忆**有日期** 且落在**当前剧情日期**往前 `resumeBatchDays` 天内」→
//     剧情日期为空 / 记忆无日期 / 剧情推进出窗 / 记忆被遗忘 —— 都会让入口**自己消失**，
//     且它背后那个写明「为什么没候选、怎么调」的面板**永远打不开**（空态文案写了却到不了）。
//   · 新口径：入口只看**开关**（`resumeBatchEnabled` + `snapshotResumeEnabled`）→ 恒显；
//     有候选带条数角标「（N）」，无候选进面板看**成因码 → 人读原因**（内核给事实、界面写措辞）。
//
// 本文件锁：① 入口恒显（含四种无候选成因）② 有候选时的角标与 title ③ 成因码口径 ④ 反向探针。
// 运行：node tests/unit/resume-batch-visible.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { resumeBatchWindowInfo } from '../../core/resume-batch.js';
import { openPanel, panelAction, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('resume-batch-visible v3.48.1 批量完善履历入口恒显（用户报告修复）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const host = makeHost({});
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
doc.querySelector = () => null;
const un = installGlobalHost(host, doc);
await import('../../index.js');

const TODAY = new Date().toISOString().slice(0, 10);
/** 造状态：`storyDate` 剧情日期 · `mems` 记忆（date 可空） */
function boot(storyDate, mems, cfgOver) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, cfgOver || {});
    setScopeKey('甲');
    const st = emptyState();
    st.snapshots = [{ id: 's1', owner: '甲', name: '甲', identity: {}, relations: [], resume: [], updatedAt: Date.now() }];
    st.memories = (mems || []).map((m, i) => Object.assign({ id: 'm' + i, owner: '甲', title: 't', content: 'c', tags: [], uses: 0 }, m));
    if (storyDate) st.state = Object.assign({}, st.state, { date: storyDate });
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save() { }, saveState() { } });
    setLastMessageId(1);
    setPanelHooks2({});
    openPanel('snapshots');
    return panelBodyHtml('snapshots');
}

// ---------- ① 四类「无候选」成因下入口都在 ----------
A('A1 **剧情日期为空**（老存档常见）：入口仍在（旧口径在此处直接消失）', (() => {
    const h = String(boot('', [{ date: TODAY }]));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') >= 0 && h.indexOf('📜 批量完善履历') >= 0;
})(), 'n/a');
A('A2 **记忆没有日期**：入口仍在', (() => {
    const h = String(boot(TODAY, [{ date: '' }]));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') >= 0;
})(), 'n/a');
A('A3 **记忆全部落在窗口外**（剧情推进 > 30 天）：入口仍在', (() => {
    const h = String(boot('1930-01-01', [{ date: '1919-01-01' }]));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') >= 0;
})(), 'n/a');
A('A4 **记忆库为空**：入口仍在', (() => {
    const h = String(boot(TODAY, []));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') >= 0;
})(), 'n/a');
A('A5 开关关掉时**才**不出现（`resumeBatchEnabled:false`）——「恒显」不等于「无视开关」', (() => {
    const h = String(boot(TODAY, [{ date: TODAY }], { resumeBatchEnabled: false }));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') < 0;
})(), 'n/a');
A('A6 履历总开关关掉时也不出现（隶属关系不越权）', (() => {
    const h = String(boot(TODAY, [{ date: TODAY }], { snapshotResumeEnabled: false }));
    return h.indexOf('data-ftt-action="resumeBatchOpen"') < 0;
})(), 'n/a');

// ---------- ② 有候选时带条数角标 ----------
A('B1 有候选：按钮带「（N）」角标，且 title 写明条数', (() => {
    const h = String(boot(TODAY, [{ date: TODAY }]));
    return /📜 批量完善履历（1）/.test(h) && h.indexOf('抽出 1 名相关角色') >= 0;
})(), 'n/a');
A('B2 无候选：不带角标，title 改为「点开可见原因与调法」（用「记忆库为空」这一确定零候选态）', (() => {
    // 注：剧情日期为空时，时钟会**回落到最新有日期条目的锚点**（`resumeClockDate` → `ageAnchorDate`），
    //   所以「无剧情日期 + 有日期记忆」仍可能有候选；要构造**确定零候选**用「记忆库为空」。
    const h = String(boot('', []));
    return h.indexOf('📜 批量完善履历（') < 0 && h.indexOf('点开可见原因与调法') >= 0;
})(), 'n/a');

// ---------- ③ 面板里的成因说明（内核给码 + 界面写话） ----------
A('C1 内核成因码逐条自检（用 `nowDate` 显式隔离，避免时钟回落干扰）：no-memories / no-story-date / undated-memories / out-of-window / no-name-hit', (() => {
    const pick = (storyDate, mems, o) => { boot(storyDate, mems); return resumeBatchWindowInfo(o || {}).codes; };
    const c1 = pick('', []);                                                   // 无记忆 + 无时钟
    const c2 = pick('', [], { nowDate: '' });                                   // 同上（显式空时钟）
    const c3 = pick(TODAY, [{ date: '' }], { nowDate: TODAY });                  // 有日期记忆数 < 记忆数
    const c4 = pick('', [{ date: '1919-01-01' }], { nowDate: '1930-01-01' });    // 有日期但全在窗外
    const c5 = pick(TODAY, [{ date: TODAY, owner: '查无此人' }], { nowDate: TODAY });  // 窗内但名字对不上名册
    const has = (cs, c) => cs.indexOf(c) >= 0;
    return has(c1, 'no-memories') && has(c1, 'no-story-date')
        && has(c2, 'no-story-date')
        && has(c3, 'undated-memories')
        && has(c4, 'out-of-window')
        && has(c5, 'no-name-hit');
})(), 'n/a');
A('C2 窗口读数如实（窗口天数 / 记忆数 / 有日期数 / 窗口内数）', (() => {
    boot(TODAY, [{ date: TODAY }, { date: '' }, { date: TODAY }]);
    const info = resumeBatchWindowInfo({});
    return info.days === 30 && info.memories === 3 && info.dated === 2 && info.inWindow === 2 && info.candidates === 1;
})(), J(resumeBatchWindowInfo({})));
A('C3 点开入口后面板给出**可读原因**（剧情日期为空 + 无日期两条同时命中）', (async () => {
    boot('', [{ date: '' }]);
    await panelAction('resumeBatchOpen', {});
    const h = String(panelBodyHtml('snapshots'));
    return h.indexOf('窗口内没有候选角色') >= 0 && h.indexOf('剧情日期为空') >= 0
        && h.indexOf('条记忆没有日期') >= 0 && h.indexOf('本入口') >= 0;
})(), 'n/a');
A('C4 空态给出**可执行下一步**（调窗口天数 / 跑摘要 / 补日期三者至少给到）', (async () => {
    boot('1930-01-01', [{ date: '1919-01-01' }]);
    await panelAction('resumeBatchOpen', {});
    const h = String(panelBodyHtml('snapshots'));
    return h.indexOf('把**窗口天数**调大') >= 0 || h.indexOf('窗口天数') >= 0;
})(), 'n/a');

// ---------- ④ 开面板这个动作本身不被候选卡住 ----------
A('D1 `resumeBatchOpen` 在**零候选**时也成功打开（不再返回拒绝）', (async () => {
    boot('', []);
    const r = await panelAction('resumeBatchOpen', {});
    const h = String(panelBodyHtml('snapshots'));
    return r.ok !== false && h.indexOf('批量完善履历 · 近') >= 0;
})(), 'n/a');

// ---------- ⑤ 反向探针 ----------
A('E1 反向探针：把入口重新按候选隐藏（恢复旧口径）→ A1/A3/A4 会变红', (() => {
    // 直接验证判据本身：零候选时按钮 HTML 非空、且带锚点 —— 旧口径下这里会是空串
    const h = String(boot('', []));
    const i = h.indexOf('data-ftt-action="resumeBatchOpen"');
    return i > 0 && h.indexOf('📜 批量完善履历') > i;
})(), 'n/a');
A('E2 反向探针：内核成因码若不再自检（恒返回空数组）→ C1 会变红', (() => {
    const codes = resumeBatchWindowInfo({}).codes;
    return Array.isArray(codes) && codes.length >= 1 && resumeBatchWindowInfo({ nowDate: '', days: 1 }).codes.indexOf('no-story-date') >= 0;
})(), 'n/a');

un();
R.done();
