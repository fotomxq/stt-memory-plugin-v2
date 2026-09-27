// ============================================================
// 单元测试 · v2.80.0「设定 → 约束」子页（关系表 / 约束自查 由列表页收进设定页）
//
// 用户要求（原文）：「记忆大类的关系表、关系约束放入设定-约束标签中。」
// 设计取舍（**有意偏离 V1**）：
//   · V1 把关系表挂在「记忆 / 计划悬念 / 平行」页的子标签下（`activeMemSub`），维度由**页面位置**决定；
//     V2 自 v2.80.0 起把**四个维度**（记忆 / 计划 / 悬念 / 平行事件）的关系表与「🧷 约束自查」
//     集中到 **设定 → 约束**，维度改由**页内切换**（`data-ftt-cdim`）承担；四个列表页只保留列表。
//   · `relFilterState().dim` 仍只作对照/诊断字段，不参与过滤（一屏只显示一个维度）。
//   · 状态迁移语义与 V1 `fttMsub` 点击一致：切维度只清「跳转定位 + 选角色态」，**不清角色筛选**。
// 覆盖：
//   A 子页位置与控件表（15 组、约束在「平行」之后「提示词」之前、0 控件、总数仍 173）
//   B 页内结构（四维切换条 / 角色筛选 / 关联统计 / 关联总览 / 约束自查区块）
//   C 页内维度切换（真实动作 + 合法性归一 + 高亮与总览同步）
//   D 状态迁移（清定位与选择器、保角色筛选）
//   E 列表页子标签已移除，但条目行「🔗 关联」入口与 relJump / relEdit 落点正确
// 运行：node tests/unit/constraint-page.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, SETTINGS_TABS, settingsPageHtml, settingsPagesInfo } from '../../ui/settings-pages.js';
import { REL_DIMS, relFilterState, setRelFilter, setRelPick, relPickState } from '../../ui/rel-table.js';
import { constraintDimState, setConstraintDim } from '../../ui/constraint-page.js';
import { panelAction, panelBodyHtml, openPanel, panelState } from '../../ui/panel.js';

const R = makeReporter('constraint-page v2.80.0 设定「约束」子页');
/** 异步断言助手：**求值后再断言**（防「Promise 恒真」的假绿，与 tests/harness 同口径） */
async function A(name, cond, detail) {
    let ok = false, extra = detail;
    try { ok = await cond; } catch (e) { ok = false; extra = String((e && e.message) || e); }
    R.assert(name, ok === true, extra);
}
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true },
});

function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.injectConstraintBlock = true;
    setScopeKey('char:constraint');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        state: { date: '1919-11-29', time: '夜', location: '码头', present: ['甲'] },
        memories: [{ id: 'm1', owner: '甲', content: '甲记得昨夜有人在巷口徘徊。', date: '1919-11-28' }],
        plans: [{ id: 'p1', title: '追查货单', content: '追查货单来源', status: 'open' }],
        suspense: [{ id: 's1', title: '断口之谜', content: '断口来源不明', status: 'open' }],
        parallels: [{ id: 'pa1', title: '第三方插手', text: '若木箱属第三方，则有人上门。' }],
        snapshots: [{ id: 'sn1', name: '甲' }, { id: 'sn2', name: '乙' }],
        links: [
            { id: 'l1', dim: 'memories', refId: 'm1', who: '甲', how: 'participant' },
            { id: 'l2', dim: 'plans', refId: 'p1', who: '乙', how: 'told' },
        ],
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}

/** 打开「设定 → 约束」并返回其正文 HTML */
async function openConstraint(dim) {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'constraint' });
    if (dim) await panelAction('constraintDim', { dim: dim });
    return String(panelBodyHtml('settings') || '');
}

// ---------- A 子页位置与控件表 ----------
await A('A1 设定新增「约束」子页：位置在「平行」之后、「提示词」之前；全表 15 组、V1 的 14 组相对顺序与标签未动', (() => {
    const ids = SETTINGS_TABS.map((t) => t.id);
    const labels = SETTINGS_TABS.map((t) => t.label);
    return ids.length === 15 && labels.length === 15
        && ids.indexOf('constraint') === ids.indexOf('parallels') + 1
        && ids.indexOf('prompts') === ids.indexOf('constraint') + 1
        && labels[ids.indexOf('constraint')] === '约束';
})(), J(SETTINGS_TABS.map((t) => t.id + ':' + t.label)));

await A('A2 约束页**无配置控件**（正文由 ui/constraint-page.js 渲染，不走控件表）；总控件数 172（v2.86.0：重要度口径改 → extract −2 +3 = +1）', (() => {
    const info = settingsPagesInfo();
    const page = info.pages.filter((p) => p.id === 'constraint')[0] || {};
    return Array.isArray(SETTINGS_CONTROLS.constraint) && SETTINGS_CONTROLS.constraint.length === 0
        && page.controls === 0 && info.totalControls === 172
        && String(settingsPageHtml('constraint')) === '';      // 不渲染「（本页为动作页…）」兜底空态
})(), () => settingsPagesInfo().pages.filter((p) => p.id === 'constraint'));

// ---------- B 页内结构 ----------
await (async () => {
    const h = await openConstraint();
    await A('B1 页内结构齐备：四维切换条 / 关联统计 / 按角色筛选 / 关联总览 / 约束自查（含注入约束段原样预览）', (() => {
        return REL_DIMS.every((d) => h.indexOf('data-ftt-cdim="' + d + '"') >= 0)
            && h.indexOf('关联行合计') >= 0 && h.indexOf('data-ftt-rel-who="1"') >= 0
            && h.indexOf('ftt-rel-overview') >= 0 && h.indexOf('data-ftt-rel-entry="memories|m1"') >= 0
            && h.indexOf('data-ftt-section="constraint-check"') >= 0 && h.indexOf('ftt-inject-check') >= 0
            && h.indexOf('【注入约束】原样预览') >= 0 && h.indexOf('未进注入的非公共信息') >= 0
            && h.indexOf('data-ftt-action="checkRefresh"') >= 0 && h.indexOf('data-ftt-action="checkMode"') >= 0;
    })(), h.slice(0, 200));

    await A('B2 四维标签用中文（不暴露内部维度键）且默认高亮「记忆」；关联统计逐维列出中文名', (() => {
        return h.indexOf('🔗 记忆') >= 0 && h.indexOf('🔗 计划') >= 0 && h.indexOf('🔗 悬念') >= 0 && h.indexOf('🔗 平行事件') >= 0
            && h.indexOf('ftt-subtab ftt-on" data-ftt-cdim="memories"') >= 0
            && h.indexOf('记忆 1') >= 0 && h.indexOf('plans ') < 0 && h.indexOf('memories ') < 0;
    })(), h.match(/关联行合计[^<]*/) || []);
})();

// ---------- C 页内维度切换 ----------
await A('C1 `constraintDim` 真实动作：切换维度 → 高亮与关联总览同步换维度；状态透出 `panelState().constraintDim`', (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'constraint' });
    const mem = String(panelBodyHtml('settings') || '');
    const r = await panelAction('constraintDim', { dim: 'plans' });
    const plans = String(panelBodyHtml('settings') || '');
    const st = panelState();
    return r.ok === true && r.dim === 'plans' && st.constraintDim === 'plans'
        && mem.indexOf('data-ftt-rel-entry="memories|m1"') >= 0 && mem.indexOf('data-ftt-rel-entry="plans|p1"') < 0
        && plans.indexOf('data-ftt-rel-entry="plans|p1"') >= 0 && plans.indexOf('data-ftt-rel-entry="memories|m1"') < 0
        && plans.indexOf('ftt-subtab ftt-on" data-ftt-cdim="plans"') >= 0;
})(), () => ({ dim: constraintDimState(), st: panelState().constraintDim }));

await A('C2 维度合法性归一：非法 / 空 / 未知维度一律回落「记忆」（与 V1 `activeMemSub` 归一同一口径）', (() => {
    const a = setConstraintDim('atoms');
    const b = setConstraintDim('');
    const c = setConstraintDim(null);
    const d = setConstraintDim('suspense');
    return a === 'memories' && b === 'memories' && c === 'memories' && d === 'suspense'
        && setConstraintDim('memories') === 'memories';
})(), () => J({ state: constraintDimState() }));

await A('C3 维度切换后**仍停留在设定页的约束子页**（不把用户弹回列表页）', (async () => {
    boot();
    openPanel('memories');
    await panelAction('tab', { tab: 'settings' });
    await panelAction('settingsSub', { sub: 'constraint' });
    await panelAction('constraintDim', { dim: 'parallels' });
    const st = panelState();
    return st.tab === 'settings' && st.settingsSub === 'constraint' && st.constraintDim === 'parallels';
})(), () => J(panelState()));

// ---------- D 状态迁移 ----------
await A('D1 切维度只清「跳转定位 + 选角色态」，**不清角色筛选**（与 V1 `fttMsub` 点击口径一致）', (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'constraint' });
    setRelFilter('memories', '角色甲', { dim: 'memories', id: 'm1', title: '码头见闻' });
    setRelPick({ dim: 'memories', id: 'm1', editor: false });
    const r = await panelAction('constraintDim', { dim: 'suspense' });
    const f = relFilterState();
    return r.ok === true && f.who === '角色甲' && f.jump === null && relPickState() === null
        && String((r.state || {}).note) === '关系表维度：悬念';
})(), () => J(relFilterState()));

await A('D2 约束页按角色筛选真实生效：`relWho` 写入后总览与「当前筛选」提示同步（只读动作，不改数据）', (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'constraint' });
    await panelAction('constraintDim', { dim: 'memories' });
    await panelAction('relWho', { who: '甲' });
    const hit = String(panelBodyHtml('settings') || '');
    await panelAction('relWho', { who: '查无此人' });
    const miss = String(panelBodyHtml('settings') || '');
    await panelAction('relClearFilter', {});
    const cleared = String(panelBodyHtml('settings') || '');
    return hit.indexOf('当前筛选：角色含「甲」') >= 0 && hit.indexOf('data-ftt-rel-entry="memories|m1"') >= 0
        && miss.indexOf('当前筛选：角色含「查无此人」') >= 0 && miss.indexOf('data-ftt-rel-entry="memories|m1"') < 0
        && cleared.indexOf('当前筛选：') < 0 && cleared.indexOf('data-ftt-rel-entry="memories|m1"') >= 0;
})(), () => ({ filter: relFilterState(), mem: (state.memories || []).length }));

// ---------- E 列表页与入口 ----------
await (async () => {
    boot();
    openPanel('memories');
    const pages = {};
    for (const t of ['memories', 'plans', 'parallels']) pages[t] = String(panelBodyHtml(t) || '');
    await A('E1 四个列表页（记忆 / 计划悬念 / 平行）不再有 `data-ftt-msub` 子标签，也不再内联渲染约束自查', (() => {
        return ['memories', 'plans', 'parallels'].every((t) => pages[t].indexOf('data-ftt-msub') < 0
            && pages[t].indexOf('ftt-inject-check') < 0 && pages[t].indexOf('data-ftt-rel-who') < 0)
            && pages.memories.indexOf('ftt-subtabs') < 0;
    })(), () => J(Object.keys(pages).map((t) => t + ':' + (pages[t].indexOf('ftt-inject-check') >= 0))));

    await A('E2 条目行的「🔗 关联」入口仍在（relJump + data-kind/-id），title 指向新落点「设定 → 约束 → 关系表」', (() => {
        return pages.memories.indexOf('data-ftt-action="relJump"') >= 0
            && pages.memories.indexOf('data-kind="memories" data-id="m1"') >= 0
            && pages.memories.indexOf('在「设定 → 约束 → 关系表」里查看 / 新建这条记忆的知情关联') >= 0
            && pages.plans.indexOf('在「设定 → 约束 → 关系表」里编辑这条计划的知情者') >= 0
            && pages.parallels.indexOf('在「设定 → 约束 → 关系表」里编辑平行事件的相关角色') >= 0;
    })(), () => pages.memories.match(/title="[^"]*约束[^"]*"/g) || []);

    const rj = await panelAction('relJump', { kind: 'suspense', id: 's1' });
    const rjs = rj.state || {};
    const jh = String(panelBodyHtml('settings') || '');
    await A('E3 `relJump` 落点：设定页 + 约束子页 + 该条目维度 + 跳转定位提示（定位目标即使暂无关联也列出）', (() => {
        return rj.ok === true && rjs.tab === 'settings' && rjs.settingsSub === 'constraint' && rjs.constraintDim === 'suspense'
            && String(rjs.note).indexOf('已定位到「约束 → 关系表」：悬念') === 0
            && jh.indexOf('ftt-subtab ftt-on" data-ftt-cdim="suspense"') >= 0
            && jh.indexOf('当前筛选：定位 悬念「断口之谜：断口来源不明」') >= 0
            && jh.indexOf('data-ftt-action="relClearFilter"') >= 0
            && jh.indexOf('data-ftt-rel-entry="suspense|s1"') >= 0 && jh.indexOf('🔗 定位') >= 0;
    })(), () => ({ state: rjs, dim: constraintDimState(), hasFilter: jh.indexOf('当前筛选：定位 悬念') >= 0 }));

    const re = await panelAction('relEdit', { kind: 'suspense', id: 's1' });
    const res = re.state || {};
    await A('E4 `relEdit` 从约束页打开编辑器：切回该条目的列表页（悬念 → 计划悬念页）并置编辑器（关联小表随编辑器渲染）', (() => {
        return res.tab === 'plans' && res.editing && res.editing.kind === 'suspense' && res.editing.id === 's1'
            && String(panelBodyHtml('plans')).indexOf('data-ftt-rel-body="suspense|s1"') >= 0;
    })(), () => res);
})();

R.done();
