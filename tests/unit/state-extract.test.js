// ============================================================
// 单元测试 · v2.68.0「状态大类总是没数据」根因修复
//
// 用户报告：「状态大类总是没数据，请核对提示词、分析记忆等位置是否存在问题。」
//
// **真根因（提示词维度键不匹配）**：`buildSummaryPrompt()` 按 **V1 模板键**逐维度取模板
//   （`if (pt[d]) lines.push(pt[d])`，键为 `atoms/states/snapshots/…`）；而 V2 的容器 kind 是 `currentStates`。
//   提取链路把 `enabledDims()` 的 **V2 kind** 直接传进提示词构造器 → `pt['currentStates']` 不存在 →
//   **「状态记录」整段抽取说明（1104 字）从不进提示词** → AI 不知道要抽状态 → 状态大类长期为空。
//   同时 V2 容器里的 `parallels`（V1 摘要**不抽**平行事件，由交织管线负责）反而被塞进提示词，属额外错配。
//
// 本批：
//   ① `host/extract.js#summaryDimsForPrompt()`：kind → V1 摘要维度键（`currentStates`→`states`），
//      按 V1 顺序去重、剔除无摘要模板的容器；`analyzeFloor` / `analyzeSegment` 一律走它；
//   ② `enabledDims()` / 维度勾选框认 **V1 别名键** `states`（V1 存档关过「状态」不再误判为启用；精确键优先）；
//   ③ 重建 oracle `tests/fixtures/gen-v1-golden-prompt.cjs`：旧黄金样本 `dims` 误记成 V2 kind
//      （把「缺状态模板」固化成「V1 原样」）→ 现按 V1 源码的 `DIMENSIONS` 生成并记录模板签名；
//   ④ 诊断：`extractSummary().promptDims` / `FTT.summaryDims()` 可直接看「本次请求哪些维度」。
//
// 运行：node tests/unit/state-extract.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { analyzeFloor, analyzeFloors, enabledDims, summaryDimsForPrompt, summaryDimGroups, extractSummary } from '../../host/extract.js';
import { panelBodyHtml, openPanel, setPanelHooks2 } from '../../ui/panel.js';
import { dimsCheckboxHtml } from '../../ui/settings-panel.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('state-extract v2.68.0 状态大类无数据根因修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'v1-golden-prompt.json'), 'utf8'));
const clone = (v) => JSON.parse(J(v));
const V1_DIMS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'];

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({
    chat: [
        { is_user: true, mes: '我们把木箱抬进仓库。', name: 'User' },
        { is_user: false, mes: '甲用铜钥匙打开木箱，里面是发黄的账册，他的左臂还缠着绷带。', name: '角色甲' },
    ],
});
installGlobalHost(host, doc);

function boot(extra) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('角色甲');
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setKernelState(Object.assign(emptyState(), { state: { date: '1919-11-29', time: '夜', location: '码头' } }, extra || {}));
    setLastMessageId(host.ctx.chat.length - 1);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
}
/** 提示词的全量文本：维度模板在 system 段，正文与索引在 prompt 段 */
const sysOf = (args) => String((args && args.systemPrompt) || '') + '\n' + String((args && args.prompt) || '');
const ATOMS_ONLY = J({ atoms: { add: [{ title: 'x', text: '甲打开木箱取出账册并记下转运日期。' }] } });
const STATES_DELTA = (value) => J({ states: { add: [{ subject: '角色甲·姓氏乙', field: '身体状况与伤势', value: value, importance: 0.8 }] } });
const stateRows = () => (state.currentStates || []).map((s) => ({ subject: s.subject, field: s.field, value: s.value }));

// ---------- R 组：提示词维度键 ----------
A('R1 维度键投影：V2 kind → V1 摘要键（含 states），按 V1 顺序去重，剔除 parallels/links/plotSegments', (() => {
    boot();
    cfg.dimensionEnabled = {};
    const def = summaryDimsForPrompt();
    const subset = summaryDimsForPrompt(['currentStates', 'atoms', 'memories']);
    const none = summaryDimsForPrompt(['parallels', 'links', 'plotSegments']);   // 无摘要模板 → 回落全 10 维
    return J(def) === J(V1_DIMS)
        && J(subset) === J(['atoms', 'states', 'memories'])
        && J(none) === J(V1_DIMS)
        && summaryDimGroups(['currentStates', 'atoms']).enabled.join(',') === 'atoms,states';
})(), J({ def: summaryDimsForPrompt(), subset: summaryDimsForPrompt(['currentStates', 'atoms', 'memories']) }));

{
    boot();
    let sys = '';
    const r = await analyzeFloor(1, { ai: async (args) => { sys = sysOf(args); return { ok: true, text: ATOMS_ONLY }; } });
    A('R2 真实流水线提示词含「状态记录」模板、且**不含**「平行事件」模板（修复前正好相反）',
        r.ok === true && sys.indexOf('【状态记录】角色当下仍然成立的属性状态') > 0
        && sys.indexOf('【当前状态】') > 0 && sys.indexOf('【平行事件】') < 0,
        J({ hasStates: sys.indexOf('【状态记录】') >= 0, hasParallels: sys.indexOf('【平行事件】') >= 0 }));
}

A('R3 oracle 已修复：黄金样本 dims = V1 摘要维度键；10 段模板 + 锚点都在、平行事件不在', (() => {
    const sys = String(G.messages[0].content);
    const sigOk = V1_DIMS.every((k) => G.signatures[k] === true) && G.signatures.parallels === false && G.signatures.anchor === true;
    return J(G.v1Dimensions) === J(V1_DIMS) && J(G.dims) === J(V1_DIMS) && sigOk
        && sys.indexOf('【状态记录】') > 0 && sys.indexOf('【平行事件】') < 0;
})(), J(G.signatures));

// ---------- S 组：端到端落库（状态真的进得来） ----------
{
    boot();
    const r1 = await analyzeFloor(1, { ai: async () => ({ ok: true, text: STATES_DELTA('左臂扭伤') }) });
    A('S1 单楼分析：AI 返回 states → 落进 `state.currentStates`（主体 / 字段 / 值齐备）',
        r1.ok === true && stateRows().length === 1 && stateRows()[0].subject === '角色甲·姓氏乙'
        && stateRows()[0].field === '身体状况与伤势' && stateRows()[0].value === '左臂扭伤',
        J({ rows: stateRows(), r1: r1 }));

    // V1 口径：同一主体+字段的「变化」由 AI 用「更新」给出（`add` 是同日新增/覆盖，不写变更史）
    const upd = J({ states: { update: [{ subject: '角色甲·姓氏乙', field: '身体状况与伤势', value: '左臂已包扎' }] } });
    await analyzeFloor(1, { ai: async () => ({ ok: true, text: upd }) });
    const hist = ((state.currentStates || [])[0] || {}).history || [];
    A('S2 同一主体+字段再次提取 → 合并为一条（值变化写入变更史），不重复新增',
        stateRows().length === 1 && stateRows()[0].value === '左臂已包扎'
        && hist.length >= 1 && String(hist[hist.length - 1].value).indexOf('左臂扭伤') >= 0,
        J({ rows: stateRows(), hist: hist }));
}

{
    boot();
    // AI 按模板给出的**中文键**输出（`{"状态记录":{"新增":[…]}}`）→ 经 CN_KEY_MAP 归一后同样落库
    const zh = J({ 状态记录: { 新增: [{ 主体: '角色甲·姓氏乙', 字段: '情绪与心理状态', 值: '警惕' }] } });
    const r = await analyzeFloor(1, { ai: async () => ({ ok: true, text: zh }) });
    A('S4 中文键输出同样落库（模板要求 `{"状态记录":{"新增":[…]}}`，经 CN_KEY_MAP 归一为 states）',
        r.ok === true && (state.currentStates || []).length === 1
        && state.currentStates[0].subject === '角色甲·姓氏乙' && state.currentStates[0].field === '情绪与心理状态'
        && state.currentStates[0].value === '警惕',
        J({ rows: stateRows(), deltaKeys: r.deltaKeys }));
}

{
    boot();
    const calls = [];
    const r = await analyzeFloors({ ai: async (args) => { calls.push(sysOf(args)); return { ok: true, text: STATES_DELTA('情绪紧绷') }; } });
    A('S3 批量分析同源：同样带上「状态记录」模板并落库（不是单楼特例）',
        r.ok === true && calls.length === 1 && calls[0].indexOf('【状态记录】') > 0
        && (state.currentStates || []).length === 1 && state.currentStates[0].value === '情绪紧绷',
        J({ floors: r.floors, states: (state.currentStates || []).length }));
}

// ---------- T 组：维度开关（含 V1 别名键） ----------
{
    boot();
    cfg.dimensionEnabled = { states: false };
    let sys = '';
    await analyzeFloor(1, { ai: async (args) => { sys = sysOf(args); return { ok: true, text: ATOMS_ONLY }; } });
    A('T1 `dimensionEnabled.states=false`（V1 存档口径）也生效：提示词不再含状态模板，其它维度照常',
        enabledDims().indexOf('currentStates') < 0 && sys.indexOf('【状态记录】') < 0 && sys.indexOf('【情节】') > 0,
        J({ dims: enabledDims() }));
}

A('T2 `dimensionEnabled.currentStates=false`（V2 口径）同样生效；精确键优先于别名键；勾选框同口径', (() => {
    boot();
    cfg.dimensionEnabled = { currentStates: false };
    const offV2 = enabledDims().indexOf('currentStates') < 0 && summaryDimsForPrompt().indexOf('states') < 0;
    cfg.dimensionEnabled = { states: false, currentStates: true };      // 显式开 → 覆盖 V1 遗留的关
    const onWins = enabledDims().indexOf('currentStates') >= 0 && summaryDimsForPrompt().indexOf('states') >= 0;
    const boxOn = /data-ftt-dim="currentStates"[^>]*checked/.test(dimsCheckboxHtml());
    cfg.dimensionEnabled = { states: false };
    const boxOff = !/data-ftt-dim="currentStates"[^>]*checked/.test(dimsCheckboxHtml());
    return offV2 && onWins && boxOn && boxOff;
})(), '见断言');

{
    boot();
    let sys = '';
    await analyzeFloor(1, { dims: ['currentStates'], ai: async (args) => { sys = sysOf(args); return { ok: true, text: STATES_DELTA('疲惫') }; } });
    A('T3 显式维度子集（`dims:["currentStates"]`）→ 只带状态模板（+ 恒定的当前状态锚点），并正常落库',
        sys.indexOf('【状态记录】') > 0 && sys.indexOf('【记忆库】') < 0 && sys.indexOf('【物品库】') < 0
        && sys.indexOf('【情节】') < 0 && sys.indexOf('【当前状态】') > 0 && (state.currentStates || []).length === 1,
        '见断言');
}

// ---------- U 组：用户可见 / 诊断 ----------
A('U4 状态页能看到该条（用户报告的「没数据」在界面上被修复）', (() => {
    boot();
    state.currentStates = [{ id: 'st1', subject: '角色甲·姓氏乙', field: '身体状况与伤势', value: '左臂扭伤', status: 'active', importance: 0.8, floorStart: 1, floorEnd: 1, history: [], uses: 0 }];
    openPanel('states');
    const html = panelBodyHtml('states');
    return html.indexOf('角色甲·姓氏乙') > 0 && html.indexOf('左臂扭伤') > 0;
})(), '见断言');

A('U5 诊断出口：`extractSummary().promptDims` 如实列出会请求的维度（状态在其中）', (() => {
    boot();
    const s = extractSummary();
    return J(s.promptDims) === J(V1_DIMS) && s.promptDims.indexOf('states') >= 0;
})(), J(extractSummary().promptDims));

A('U6 独立分组口径同源：`summaryDimGroups` 把 `currentStates` 归到 `states` 组，其余进「统一」组', (() => {
    boot();
    const g = summaryDimGroups(['currentStates', 'atoms']);
    return J(g.enabled) === J(['atoms', 'states']) && g.rest.indexOf('states') < 0 && g.rest.indexOf('memories') >= 0;
})(), J(summaryDimGroups(['currentStates', 'atoms'])));

R.done();
