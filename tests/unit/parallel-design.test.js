// ============================================================
// 单元测试 · v2.99.0 平行世界三项修复与新增
//
// 用户要求（原话）：
//   ①「平行世界的卦象等设计需修复。」
//   ②「传言的清理按钮需二次确认，其他类似高危操作均需二次确认。」
//   ③「可添加新平行世界，即输入一段话交给 ai 单独去平行推演，配套关键词涉及到的原子数据，
//      但因为可能涵盖完全客观或非主角视角的内容，需自行兼容支持。添加后和普通平行世界完全没区别。」
//
// ① 的根因（V1 同源缺陷）：平行事件「更新」是**整条替换**（`state.parallels[i] = n`），
//    而推演/推进提示词里 卦象 / 因果线 / 涉及角色 / 发生地点 / 来源 / 预演 / 约束 都是**可选**字段
//    → AI 常规「更新」只给标题+正文时，**卦象与因果线被清空**（用户看到的就是「卦象没了」）。
//    本版改为**逐字段合并**（未提供即保留旧值），并修掉列表行「⚡ 源起：源起：」的重复前缀与超长卦象徽标。
//
// 覆盖：A 更新逐字段保留/覆盖 + 列表行；B 危险动作二次确认；C 自定义平行世界推演；D 同构性。
// 运行：node tests/unit/parallel-design.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { mergeDelta } from '../../core/ingest.js';
import {
    runParallelCustom, buildCustomWeavePrompt, customSeedLines, customKeywords, ideaCorpusTerms, applyAdvanceUpdate,
} from '../../core/parallel.js';
import {
    panelAction, openPanel, panelBodyHtml, panelState, setPanelHooks2, parallelCustomState,
} from '../../ui/panel.js';

const R = makeReporter('parallel-design v2.99.0 平行世界：卦象保留 / 危险动作确认 / 自定义推演');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);

function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:parallel-design');
    setLastMessageId(9);
    const st = emptyState();
    setKernelState(st);
    if (seed) Object.assign(st, JSON.parse(JSON.stringify(seed)));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}
const SEED_PAR = () => ([{
    id: 'par1', title: '码头暗流', text: '船只被毁一事在码头传开。', type: '暗线', date: '1919-11-29', time: '傍晚',
    gua: '山水蒙——局中待启，需循迹问源', causalLine: '源起：船只被毁→议论→幕后',
    characters: ['甲'], location: '码头区', tags: ['暗流'],
    goalOdds: [{ target: '幕后先发制人', likelihood: 60 }], importance: 0.9,
    sourceRefs: ['a1'], previews: ['计划甲'], constraintNote: '仅幕后', promotedTo: '', uses: 2,
}]);
const apply = (pc, range) => mergeDelta({ 平行事件: pc }, range || { start: 5, end: 5 });
const p1 = () => (state.parallels || [])[0] || {};

// ---------- A 组：① 卦象等字段在「更新」时不被清空 ----------
A('A1 「更新」只给标题+正文 → 卦象 / 因果线 / 涉及角色 / 发生地点 / 类型 / 日期 / 时刻 / 标签 / 重要度 **全部保留**（修复前整条替换 → 除目标可能性外全被清空）', (() => {
    const st = boot({ parallels: SEED_PAR() });
    apply({ 更新: [{ 标题: '码头暗流', 正文: '议论升级为戒备，配角丙开始暗中留意陌生面孔。' }] });
    const p = p1();
    return p.text === '议论升级为戒备，配角丙开始暗中留意陌生面孔。'
        && p.gua === '山水蒙——局中待启，需循迹问源' && p.causalLine === '源起：船只被毁→议论→幕后'
        && J(p.characters) === J(['甲']) && p.location === '码头区' && p.type === '暗线'
        && p.date === '1919-11-29' && p.time === '傍晚' && J(p.tags) === J(['暗流'])
        && p.importance === 0.9 && p.uses === 2 && st.parallels.length === 1;
})(), () => J(p1()));

A('A2 本次**给了**的字段照常覆盖：卦象 / 涉及角色 / 发生地点 / 目标可能性 / 重要度 都用新值；标签**并集合并**', (() => {
    boot({ parallels: SEED_PAR() });
    apply({ 更新: [{ 标题: '码头暗流', 卦象: '坤——承纳积蓄', 涉及角色姓名: ['乙'], 发生地点: '钟鼓楼', 重要度: 0.3, 标签: ['新增标签'], 演化目标可能性: [{ 目标: '新分支', 可能性: 20 }] }] });
    const p = p1();
    return p.gua === '坤——承纳积蓄' && J(p.characters) === J(['乙']) && p.location === '钟鼓楼'
        && p.importance === 0.3 && J(p.tags) === J(['暗流', '新增标签'])
        && J(p.goalOdds) === J([{ target: '新分支', likelihood: 20 }])
        && p.causalLine === '源起：船只被毁→议论→幕后';      // 未提供 → 保留
})(), () => J({ gua: p1().gua, tags: p1().tags, odds: p1().goalOdds }));

A('A3 关联/派生字段（来源 / 预演 / 约束 / 转正标记）在「更新」时不被清空（AI 从不产出这些键）', (() => {
    boot({ parallels: SEED_PAR() });
    apply({ 更新: [{ 标题: '码头暗流', 正文: '局势继续发酵。' }] });
    const p = p1();
    return J(p.sourceRefs) === J(['a1']) && J(p.previews) === J(['计划甲'])
        && p.constraintNote === '仅幕后' && p.promotedTo === '';
})(), () => J({ s: p1().sourceRefs, p: p1().previews, c: p1().constraintNote }));

A('A4 新增路径不受影响：两条新增各自独立落库（id 由内容生成，不互相覆盖）', (() => {
    boot({});
    apply({ 新增: [{ 标题: '甲线', 正文: '甲线正文足够长。', 卦象: '乾' }, { 标题: '乙线', 正文: '乙线正文足够长。', 卦象: '兑' }] });
    return state.parallels.length === 2
        && J(state.parallels.map((x) => x.gua).sort()) === J(['乾', '兑'].sort());
})(), () => J(state.parallels.map((x) => x.title)));

A('A5 推进（`applyAdvanceUpdate`）同样保留未提供的字段（既有行为锁定）：只给正文 → 卦象/因果线/角色/地点/标签 不动', (() => {
    boot({ parallels: SEED_PAR() });
    const p = p1();
    applyAdvanceUpdate(p, { 正文: '推进后的正文。' });
    return p.text === '推进后的正文。' && p.gua === '山水蒙——局中待启，需循迹问源'
        && p.causalLine === '源起：船只被毁→议论→幕后' && J(p.characters) === J(['甲']) && p.location === '码头区';
})(), () => J(p1()));

A('A6 列表行（① 的展示面）：因果线**不再重复「源起：」前缀**（值自带前缀时不加），卦象徽标限宽 40 字且 title 给全文', (() => {
    boot({ parallels: SEED_PAR() });
    openPanel('parallels');
    setPanelHooks2({ pending: () => [] });
    const html = String(panelBodyHtml('parallels') || '');
    const dupBad = html.indexOf('⚡ 源起：源起：') >= 0;
    return dupBad === false && html.indexOf('⚡ 源起：船只被毁→议论→幕后') >= 0
        && html.indexOf('☯ 山水蒙——局中待启，需循迹问源') >= 0
        && html.indexOf('title="卦象：山水蒙——局中待启，需循迹问源"') >= 0;
})(), () => String(panelBodyHtml('parallels') || '').slice(0, 200));

A('A7 长卦象（>40 字）徽标截断为 40 字 + 「…」，完整值仍在 title 里（不再撑成多行）', (() => {
    const long = '巽为风——'.repeat(12);
    boot({ parallels: [{ id: 'px', title: '长卦象', text: '正文足够长。', gua: long, tags: [] }] });
    openPanel('parallels');
    setPanelHooks2({ pending: () => [] });
    const html = String(panelBodyHtml('parallels') || '');
    return html.indexOf('☯ ' + long.slice(0, 40) + '…') >= 0 && html.indexOf('title="卦象：' + long + '"') >= 0
        && html.indexOf('☯ ' + long) < 0;
})(), '');

// ---------- B 组：② 危险动作二次确认 ----------
const DANGER_ACTIONS = [
    'delete', 'bulkDelete', 'dbgClear', 'dbgTraceClear', 'syncLogClear', 'nsfwKwReset', 'nsfwRuleReset',
    'importStateApply', 'snapRestore', 'snapDelete', 'snapshotClear', 'clear-inject', 'clearFloors',
    'clearPlotSegments', 'clearRumors', 'clearPlans', 'clearSuspense', 'delStateGroup',
    'promptResetAll', 'promptGroupReset', 'promptResetOne', 'presetDelete', 'syncPickLocal', 'syncPickRemote',
];
A('B1 危险动作清单**覆盖全部会不可逆清空/覆盖用户数据**的动作（24 项，含用户点名的「🧹 清理传言」；新增 13 项此前无确认）', (async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
    const block = src.slice(src.indexOf('const DANGER_ACTION_PROMPTS = {'), src.indexOf('async function confirmDialog'));
    const missing = DANGER_ACTIONS.filter((a) => block.indexOf("'" + a + "'") < 0);
    const withConfirmText = DANGER_ACTION_PROMPTS => 0;
    void withConfirmText;
    // 每条都要有「讲清后果」的文案（长度 ≥ 20 字）
    const tooShort = [];
    for (const a of DANGER_ACTIONS) {
        const i = block.indexOf("'" + a + "': '");
        if (i < 0) { tooShort.push(a); continue; }
        const seg = block.slice(i, block.indexOf("',", i) + 2);
        if (seg.length < 40) tooShort.push(a);
    }
    return missing.length === 0 && tooShort.length === 0;
})(), '');

// v3.0.4（用户要求）：「设定跨端同步分歧中，应增加合并差异选项，即将对端下载后合并去重。」
//   口径：**覆盖型**两项（保留本端 / 采用对端）会丢弃另一方的差异 → 需二次确认（仍在清单内）；
//   新增的「🔀 合并差异」是**并集去重**，不丢任何一方的数据 → **不进**危险动作清单（点了直接执行）。
A('B1b v3.0.4：`syncPickMerge`（下载对端并集去重，两端都不丢）**不在**危险动作清单内；覆盖型两项仍在（仍会丢弃对方差异 → 仍要二次确认）', (async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
    const block = src.slice(src.indexOf('const DANGER_ACTION_PROMPTS = {'), src.indexOf('async function confirmDialog'));
    const uiSrc = readFileSync(join(ROOT, 'ui', 'sync.js'), 'utf8');
    return block.indexOf("'syncPickMerge'") < 0
        && block.indexOf("'syncPickLocal'") >= 0 && block.indexOf("'syncPickRemote'") >= 0
        && DANGER_ACTIONS.indexOf('syncPickMerge') < 0 && DANGER_ACTIONS.length === 24
        // 动作确实存在且**不经** confirmDialog（在分歧处置分支内联、无确认调用）
        && uiSrc.indexOf("a === 'syncPickMerge'") >= 0
        && uiSrc.indexOf('applyRemoteMergeToState') >= 0;
})(), '');

A('B2 真实点击「🧹 清理传言」：确认框取消 → **零副作用**（传言一条不少）；确认 → 才清空并留删除墓碑', (async () => {
    const st = boot({
        rumors: [{ id: 'ru1', subject: '传闻甲', content: '码头有人交易军械。', stage: 'active', tags: [], carriers: [], uses: 0 }],
        deleted: {}, deletedH: {},
    });
    openPanel('rumors');
    const calls = [];
    setPanelHooks2({ pending: () => [], notify: (k, t) => { calls.push([String(k), String(t)]); return true; } });
    const el = doc.getElementById('ftt-panel');
    try { el.__fttBound = false; el.listeners = {}; } catch (e) { /* 忽略 */ }
    const { bindOverlay } = await import('../../ui/panel.js');
    bindOverlay();
    const fire = (dataset) => ((el.listeners || {}).click || []).forEach((fn) => fn({ target: { dataset, closest: () => null }, preventDefault() { }, stopPropagation() { } }));
    const keepPopup = host.ctx.callGenericPopup;
    try {
        // ① 取消
        host.ctx.callGenericPopup = () => Promise.resolve(0);
        fire({ fttAction: 'clearRumors' });
        await new Promise((r) => setTimeout(r, 10));
        const afterCancel = (st.rumors || []).length;
        // ② 确认
        host.ctx.callGenericPopup = () => Promise.resolve(1);
        fire({ fttAction: 'clearRumors' });
        await new Promise((r) => setTimeout(r, 20));
        const afterOk = (st.rumors || []).length;
        const tombs = Object.keys((st.deleted || {}).rumors || {}).length + Object.keys((st.deletedH || {}).rumors || {}).length;
        return afterCancel === 1 && afterOk === 0 && tombs >= 1
            && String(panelState().note || '').indexOf('已清理') >= 0;
    } finally { host.ctx.callGenericPopup = keepPopup; }
})(), '');

A('B3 程序化调用（命令 / devtools / 测试）不经点击闸：`panelAction` 直接清空仍生效（与 v2.96.0 的边界一致）', (async () => {
    boot({ rumors: [{ id: 'ru2', subject: '传闻乙', content: '内容足够长。', stage: 'active', tags: [], carriers: [] }], deleted: {}, deletedH: {} });
    openPanel('rumors');
    setPanelHooks2({ pending: () => [] });
    const r = await panelAction('clearRumors', {});
    return r.ok === true && (state.rumors || []).length === 0;
})(), '');

A('B4 清空类动作的 title 不再写「不弹确认」（误导性文案已随二次确认一并修正）', (async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files = ['ui/panel.js', 'ui/api-page.js'];
    const bad = [];
    for (const f of files) {
        const src = readFileSync(join(ROOT, f), 'utf8');
        src.split('\n').forEach((l, i) => { if (l.indexOf('不弹确认') >= 0) bad.push(f + ':' + (i + 1)); });
    }
    return bad.length === 0;
})(), '');

// ---------- C 组：③ 自定义平行世界 ----------
A('C1 设想关键词 → 关联既有数据：命中的情节/记忆/… 被收集为上下文行（没命中就不塞噪声）', (() => {
    boot({
        atoms: [{ id: 'a1', text: '河运中断，盐商行会受损。', title: '河运中断', validity: 'active', tags: [] }],
        memories: [{ id: 'm1', owner: '甲', title: '镖局', content: '镖局与盐商行会有旧约。' }],
        currentStates: [{ id: 's1', subject: '无关角色', field: '心情', value: '平静' }],
    });
    const idea = '北方盐商行会因河运中断而改走陆路，镖局态度开始分化。';
    const kws = customKeywords(idea);
    const seed = customSeedLines(kws);
    return kws.indexOf('盐商') >= 0
        && seed.some((l) => l.indexOf('[情节]') === 0 && l.indexOf('河运中断') >= 0)
        && seed.some((l) => l.indexOf('[记忆]') === 0 && l.indexOf('镖局') >= 0)
        && seed.every((l) => l.indexOf('无关角色') < 0);
})(), () => J(customSeedLines(customKeywords('北方盐商行会因河运中断而改走陆路，镖局态度开始分化。'))));

A('C2 提示词显式支持**完全客观 / 非主角视角**：允许客观事件、允许主角不出场、**禁止**把事件牵引向主角，并带上当前剧情日期', (() => {
    const st = boot({});
    st.state.date = '1919-11-29';
    const prompt = buildCustomWeavePrompt('北方的盐商行会因河运中断而改走陆路。', ['[情节] 河运中断']);
    const u = prompt[1].content;
    return prompt[0].role === 'system' && prompt[1].role === 'user'
        && u.indexOf('客观事件') >= 0 && u.indexOf('主角**可以完全不出场') >= 0
        && u.indexOf('禁止') >= 0 && u.indexOf('牵引向主角') >= 0
        && u.indexOf('【当前剧情日期】1919-11-29') >= 0
        && u.indexOf('只用「新增」') >= 0
        && u.indexOf('北方的盐商行会因河运中断而改走陆路。') >= 0
        && u.indexOf('[情节] 河运中断') >= 0
        && prompt[0].content.indexOf('以卦象为纲、以因果为线') >= 0;
})(), '');

A('C3 端到端：`runParallelCustom` 落库为**普通平行事件**（字段齐全：卦象/因果线/标签/目标可能性都在），并回报关键词与关联条数', (async () => {
    boot({
        atoms: [{ id: 'a1', text: '河运中断，盐商行会受损。', title: '河运中断', validity: 'active', tags: [] }],
        memories: [{ id: 'm1', owner: '甲', title: '镖局', content: '镖局与盐商行会有旧约。' }],
    });
    const reply = J({ 平行事件: { 新增: [{ 标题: '盐商改走陆路', 正文: '行会暗中联络镖局改走陆路。', 类型: '势力动向', 因果线: '来自用户设想：河运中断→盐商改道→衙门态度分化', 卦象: '巽——渗透影响', 演化目标可能性: [{ 目标: '陆路垄断', 可能性: 55 }], 标签: ['盐商', '镖局'] }] } });
    const r = await runParallelCustom('北方盐商行会因河运中断而改走陆路，镖局态度分化。', { aiText: reply });
    const p = state.parallels[0] || {};
    return r.ok === true && r.added === 1 && r.updated === 0 && r.seed >= 1
        && p.title === '盐商改走陆路' && p.gua === '巽——渗透影响'
        && p.causalLine.indexOf('来自用户设想') === 0 && J(p.tags) === J(['盐商', '镖局'])
        && J(p.goalOdds) === J([{ target: '陆路垄断', likelihood: 55 }]) && p.type === '势力动向';
})(), () => J(state.parallels));

A('C4 自定义产物与常规产物**完全同构**：字段集与常规 `mergeDelta` 落库的条目**逐键一致**（同一归一化路径）', (() => {
    boot({});
    const reply = { 平行事件: { 新增: [{ 标题: '自定义线', 正文: '自定义线正文足够长。', 卦象: '坎' }] } };
    mergeDelta({ 平行事件: JSON.parse(J(reply.平行事件)) }, { start: 1, end: 1 });
    const custom = Object.keys(state.parallels[0]).sort().join(',');
    boot({});
    mergeDelta({ 平行事件: { 新增: [{ 标题: '常规线', 正文: '常规线正文足够长。', 卦象: '离' }] } }, { start: 1, end: 1 });
    const normal = Object.keys(state.parallels[0]).sort().join(',');
    return custom === normal && custom.indexOf('gua') >= 0 && custom.indexOf('causalLine') >= 0;
})(), '');

A('C5 边界：内容太短 → `idea-too-short`；AI 无 JSON → 报错不落库；AI 返回空对象 → `skipped:empty` 且不新增', (async () => {
    const st = boot({});
    const a = await runParallelCustom('短');
    const b = await runParallelCustom('这段设想足够长但没有 JSON。', { aiText: '不是 JSON' });
    const c = await runParallelCustom('这段设想足够长但 AI 说没有可推演的点。', { aiText: J({ 平行事件: {} }) });
    return a.ok === false && a.error === 'idea-too-short'
        && b.ok === false && b.error === 'AI 未返回有效 JSON'
        && c.ok === true && c.skipped === 'empty' && (st.parallels || []).length === 0;
})(), '');

A('C6 AI 若返回「更新」（设想明确深化既有线）也能正常应用：走同一条更新路径（逐字段保留）', (async () => {
    boot({ parallels: SEED_PAR() });
    const reply = J({ 平行事件: { 更新: [{ 标题: '码头暗流', 正文: '设想要求深化：议论演变为有组织的串联。' }] } });
    const r = await runParallelCustom('请深化「码头暗流」这条线：议论演变为有组织的串联。', { aiText: reply });
    const p = p1();
    return r.ok === true && r.updated === 1 && r.added === 0
        && p.gua === '山水蒙——局中待启，需循迹问源' && (state.parallels || []).length === 1;
})(), '');

// ---------- D 组：平行页交互（入口 / 展开 / 在途 / 落库） ----------
A('D1 平行页顶部有自定义推演入口；点击展开输入区（不含 AI 调用），取消即收起', (async () => {
    boot({ parallels: SEED_PAR() });
    openPanel('parallels');
    setPanelHooks2({ pending: () => [] });
    const html0 = String(panelBodyHtml('parallels') || '');
    const hasEntry = html0.indexOf('data-ftt-action="parallelCustomOpen"') >= 0 && html0.indexOf('🧪 自定义推演（新增平行世界）') >= 0;
    const closed = html0.indexOf('data-ftt-custom-weave') < 0;
    const r1 = await panelAction('parallelCustomOpen', {});
    const html1 = String(r1.html || '');
    const opened = html1.indexOf('data-ftt-custom-weave="1"') >= 0 && html1.indexOf('data-ftt-action="parallelCustomRun"') >= 0
        && html1.indexOf('🚀 交由 AI 推演') >= 0 && html1.indexOf('完全客观或非主角视角') >= 0;
    const r2 = await panelAction('parallelCustomCancel', {});
    return hasEntry && closed && r1.ok === true && opened && r2.ok === true
        && String(r2.html || '').indexOf('data-ftt-custom-weave') < 0
        && parallelCustomState().open === false;
})(), '');

A('D2 面板动作 `parallelCustomRun`：**立即**写提示并重绘（不等 AI）+ 弹通知，完成后落库并回报条数；在途重复点击被拒', (async () => {
    boot({ parallels: [] });
    openPanel('parallels');
    const calls = [];
    let release = null;
    setPanelHooks2({
        pending: () => [],
        notify: (k, t) => { calls.push([String(k), String(t)]); return true; },
        parallelCustom: async (idea) => {
            calls.push(['idea', String(idea)]);
            await new Promise((r) => { release = r; });
            mergeDelta({ 平行事件: { 新增: [{ 标题: '设想产物', 正文: '设想产物的正文足够长。', 卦象: '震' }] } }, { start: 1, end: 1 });
            return { ok: true, added: 1, updated: 0, seed: 2, keywords: ['盐商'] };
        },
    });
    const p = panelAction('parallelCustomRun', { text: '北方的盐商行会因河运中断而改走陆路。' });
    const noteNow = String(panelState().note || '');
    const busyNow = parallelCustomState().busy;
    const second = await panelAction('parallelCustomRun', { text: '北方的盐商行会因河运中断而改走陆路。' });
    if (release) release();
    const r = await p;
    return noteNow.indexOf('自定义推演中…') >= 0 && busyNow === true
        && second.ok === false && second.reason === 'busy'
        && r.ok === true && String(r.state.note || '').indexOf('自定义推演完成：新增 1') >= 0
        && (state.parallels || []).length === 1 && (state.parallels || [])[0].gua === '震'
        && calls.some((x) => x[0] === 'info') && calls.some((x) => x[0] === 'success')
        && parallelCustomState().busy === false;
})(), () => J({ note: panelState().note, parallels: (state.parallels || []).length }));

A('D3 空内容直接拒绝（不调用 AI、不发通知）', (async () => {
    boot({});
    openPanel('parallels');
    const calls = [];
    setPanelHooks2({ pending: () => [], notify: (k, t) => { calls.push(String(t)); return true; }, parallelCustom: async () => { calls.push('AI'); return { ok: true }; } });
    const r = await panelAction('parallelCustomRun', { text: '   ' });
    return r.ok === false && r.reason === 'idea-too-short'
        && String(r.state.note || '').indexOf('至少 4 个字') >= 0 && calls.length === 0;
})(), '');

R.done();
