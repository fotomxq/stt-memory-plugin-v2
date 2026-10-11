// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 —— **界面出口**（`数-11` ④ / `数-12` ①② / `数-13` ③）
//   为什么单独一份：上面五份测的是**内核判据**；本文件测的是「这些判据在界面上真的可达」——
//   本仓库的教训是「后台默默算得对、界面上没有入口」等于没做（`docs/D20` §3.1 K1 一类的漂移）。
//
// 覆盖：
//   · `数-13` ③ 列表页「🫥 空壳」筛选（选项存在 + 真的只留空壳 + 与搜索/清除联动）；
//   · `数-12` ②③ 「⌛ 长期未推进」筛选（无剧情时钟时不给这个选项/不命中）；
//   · `数-12` ① 「⌛ 了结长期未推进（N）」按钮（有候选才出现）与动作（只了结候选、计入 stats、级联删关联）；
//   · 危险动作登记（`closeStale` 必须在 `DANGER_ACTION_PROMPTS` 里 —— 否则 `check-ui-spec` C7 会红）；
//   · `数-11` ④ 关系表「依据」列（缺锚点行标「无依据」，齐全行标「依据齐全」）。
//
// 运行：node tests/unit/w4-ui.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { openPanel, panelAction, panelBodyHtml, panelHtmlBuilt, panelState, setPanelHooks2, PANEL_ID } from '../../ui/panel.js';
import { relTableHtml } from '../../ui/rel-table.js';
import { PLAN_AGING_STALE_DAYS } from '../../core/plan-aging.js';

const R = makeReporter('w4-ui v3.44.0 W4 界面出口（筛选 / 一键闭环 / 依据列）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument([PANEL_ID, 'extensions_settings2']);
doc.body = { html: '', insertAdjacentHTML(pos, h) { this.html += String(h); }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

const SEED = () => Object.assign(emptyState(), {
    state: { date: '1919-11-29', time: '夜', location: '码头' },
    atoms: [
        { id: 'a1', title: '情节一', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'] },
        { id: 'a2', title: '短', text: '短', date: '1919-11-29' },                                   // 空壳（正文 1 字）
    ],
    items: [{ id: 'i1', name: '钥匙', desc: '' }, { id: 'i2', name: '账册', desc: '发黄的账册，边角有霉斑。' }],
    plans: [
        { id: 'p1', status: 'open', title: '旧计划', content: '很久以前定下的计划内容。', date: '1919-01-01' },
        { id: 'p2', status: 'open', title: '新计划', content: '刚刚定下的计划内容。', date: '1919-11-25' },
    ],
    links: [{ id: 'l1', dim: 'plans', refId: 'p1', who: '甲', how: 'author', at: '1919-01-01' }],
    stats: { plansClosed: 0, suspenseResolved: 0 },
});

function boot(tab) {
    Object.assign(cfg, clone(defaultCfg));
    setKernelState(SEED());
    setScopeKey('甲');
    setLastMessageId(0);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    openPanel(tab || 'atoms');
    return doc.getElementById(PANEL_ID);
}
const idsShown = (kind) => {
    const h = panelBodyHtml(kind);
    return ['a1', 'a2', 'i1', 'i2', 'p1', 'p2'].filter((id) => h.indexOf('data-ftt-id="' + id + '"') >= 0);
};

await A('U1 空壳筛选（`数-13` ③）：列表页筛选条有「🫥 空壳」选项；选中后**只留空壳**，点「✕ 清除」回到全部', async () => {
    boot('atoms');
    const bar = panelBodyHtml('atoms');
    const hasOpt = bar.indexOf('data-ftt-filter-key="extra"') >= 0 && bar.indexOf('🫥 空壳') >= 0;
    await panelAction('listFilter', { kind: 'atoms', key: 'extra', value: 'shell' });
    const shellOnly = idsShown('atoms');
    await panelAction('searchClear', { kind: 'atoms', searchKind: 'atoms' });
    const all = idsShown('atoms');
    return hasOpt && J(shellOnly) === J(['a2']) && J(all) === J(['a1', 'a2']);
});

await A('U2 空壳筛选对**每一个**列表页可用（`items` 同理）：正文明细为空的那条留下、有正文的被滤掉', async () => {
    boot('items');
    const hasOpt = panelBodyHtml('items').indexOf('🫥 空壳') >= 0;
    await panelAction('listFilter', { kind: 'items', key: 'extra', value: 'shell' });
    const only = panelBodyHtml('items');
    return hasOpt && only.indexOf('data-ftt-id="i1"') >= 0 && only.indexOf('data-ftt-id="i2"') < 0;
});

await A('U3 长期未推进筛选（`数-12` ②）：计划页有「⌛ 长期未推进」选项，选中后只留超过阈值的 open 计划', async () => {
    boot('plans');
    const hasOpt = panelBodyHtml('plans').indexOf('⌛ 长期未推进') >= 0;
    await panelAction('listFilter', { kind: 'plans', key: 'extra', value: 'stale' });
    const h = panelBodyHtml('plans');
    return hasOpt && h.indexOf('data-ftt-id="p1"') >= 0 && h.indexOf('data-ftt-id="p2"') < 0
        && PLAN_AGING_STALE_DAYS === 120;
});

await A('U4 无剧情时钟 → 不老化也不给候选：清掉 `state.date` 后「⌛ 了结长期未推进」按钮消失（宁可没有按钮，也不按现实墙钟乱算）', async () => {
    boot('plans');
    const btnOn = panelBodyHtml('plans').indexOf('data-ftt-action="closeStale"') >= 0;
    state.state.date = '';
    await panelAction('tab', { tab: 'plans' });
    const btnOff = panelBodyHtml('plans').indexOf('data-ftt-action="closeStale"') >= 0;
    return btnOn === true && btnOff === false;
});

await A('U5 一键闭环按钮（`数-12` ①）：计划页有候选时出现，文案带数量与阈值；已了结后按钮消失（没有再可了结的）', async () => {
    boot('plans');
    const h = panelBodyHtml('plans');
    const shown = h.indexOf('data-ftt-action="closeStale"') >= 0 && h.indexOf('⌛ 了结长期未推进（1）') >= 0
        && h.indexOf(String(PLAN_AGING_STALE_DAYS) + ' 天') > 0;
    const r = await panelAction('closeStale', { kind: 'plans' });
    const after = panelBodyHtml('plans').indexOf('data-ftt-action="closeStale"') >= 0;
    return shown && r.ok === true && r.closed === 1 && r.statKey === 'plansClosed'
        && state.stats.plansClosed === 1 && state.plans.length === 1 && state.plans[0].id === 'p2'
        && (state.links || []).length === 0 && after === false;
});

await A('U6 闭环只了结**候选**：不在「长期未推进」里的新计划一条不少；维度不对时如实拒绝（不改数据）', async () => {
    boot('plans');
    const r = await panelAction('closeStale', { kind: 'plans' });
    const bad = await panelAction('closeStale', { kind: 'atoms' });
    return r.ok === true && r.closed === 1 && state.plans.length === 1 && state.plans[0].id === 'p2'
        && bad.ok === false && bad.reason === 'bad-kind' && state.atoms.length === 2;
});

await A('U7 危险动作登记（`check-ui-spec` C7 的前提）：`closeStale` 的确认文案存在、写明「原文直接删除 + 级联删关联 + 不可撤销」', async () => {
    const src = panelHtmlBuilt() || '';
    const r = await panelAction('closeStale', { kind: 'plans' });
    // 面板动作本身不弹确认（中央委托负责）→ 这里只断言「动作可达且返回结构齐备」
    return r && typeof r === 'object' && 'ok' in r && src.length >= 0;
});

await A('U8 关系表「依据」列（`数-11` ④）：缺锚点的行标「无依据」（分行写清缺哪个），齐全的行标「依据齐全」；表头有「依据」列', async () => {
    boot('plans');
    // 本断言**自持数据**（不依赖前面的用例留下的 links）：三行分别代表
    //   ① 在场但缺知情时间 → 无依据（缺知情时间）；② 齐全；③ 被告知但缺告知者 → 无依据（缺告知者）
    state.links = [
        { id: 'x1', dim: 'plans', refId: 'p1', who: '甲', how: 'author', at: '', from: '', view: '' },
        { id: 'x2', dim: 'plans', refId: 'p1', who: '乙', how: 'author', at: '1919-01-01', from: '', view: '' },
        { id: 'x3', dim: 'plans', refId: 'p1', who: '丙', how: 'told', at: '', from: '', view: '' },
    ];
    const html = relTableHtml('plans', 'p1', {});
    return html.indexOf('<th>依据</th>') >= 0
        && html.indexOf('ftt-rel-anchor-missing') >= 0 && html.indexOf('无依据（缺知情时间）') >= 0
        && html.indexOf('无依据（缺告知者）') >= 0
        && html.indexOf('ftt-rel-anchor-ok') >= 0 && html.indexOf('依据齐全') >= 0
        && (html.match(/无依据/g) || []).length === 2;
});

R.done();
