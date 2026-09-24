// ============================================================
// 单元测试 · B9-b 关系表「双向定位跳转」+「👥 选角色」选择器
//   （**与真实 V1 插件 v1.206 逐项比对** + V2 面板编排/接线）
// 黄金样本：tests/fixtures/v1-golden-rel-nav.json
//   oracle = 真实 V1 插件 v1.206：relJump / relGoto / relClearFilter / relPick / relPickClose / relPickAdd /
//   子标签切换 走**真实点击委托**（openPanel() 后派发伪事件 → V1 `handleAction` 真实执行）；
//   其余直接调 `__FTT` 导出函数。另存 V1 源码片段（`meta.v1SourceSnips`）作为动作序证据。
// 覆盖：
//   R 组（与 V1 逐项比对）：relEntryTitle / relFindEntryId / relKnownNames / relPickAppendRow 三态 /
//     relPickState / relFilterState 迁移（含副本语义）/ relPickPanelHtml 结构投影（条目·编辑器·平行·空档案）/
//     relJump·relClearFilter·relGoto 的状态迁移 / relPickAdd 三态提示文案；
//   V 组（V2 编排/接线）：条目行「🔗 关联（N）」入口 / relJump 切页-子标签-定位提示 / relGoto 页面搜索词 /
//     relPick 开关与搜索分流 / relPickAdd→relSave 端到端落库 / msub 重置定位与选择器态。
// 与 V1 的**必要偏离**（本文件断言其差异，登记于 docs/P9a-B9关系表定位与选角色.md）：
//   ① 跳转落点：V1 `relJump` 恒切「记忆」页（靠维度筛选过滤），V2 关系表按分页隔离维度 → 切到**条目所在页**；
//   ② 「维度筛选」在 V2 不适用（`relFilterState().dim` 仅保留字段，不参与过滤）；
//   ③ `relPickAppendRow` 首参由 DOM 容器改为 `dim + refId`（「容器缺失」态 = 条目引用为空 / 非关联维度 / 关联层关闭）。
// 运行：node tests/unit/rel-nav-golden.test.js（或由 run.js 统一调用）
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { upsertRelLinks } from '../../core/entries.js';
import { relLinksOf } from '../../core/model/rel.js';
import {
    relEntryTitle, relFindEntryId, relKnownNames, relPickAppendRow, relPickPanelHtml,
    relPickState, setRelPick, relFilterState, setRelFilter, relClearFilter, relJump, relGoto,
    relPickQueryOf, setRelPickQuery, relRowsOf, relDiscard, relIsRelDim, relDimLabelOf, REL_TAB_OF,
} from '../../ui/rel-table.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-rel-nav.json'), 'utf8'));
const R = makeReporter('rel-nav-golden B9-b 关系表定位跳转 + 选角色（V1 黄金样本逐项比对）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** detail 传**函数**（惰性求值：只在失败时收集现场） */
const A = async (name, fn, detailFn) => {
    let cond = false, extra = '';
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    if (cond !== true && !extra && typeof detailFn === 'function') { try { extra = detailFn(); } catch (e) { extra = String((e && e.message) || e); } }
    R.assert(name, cond === true, extra);
};

/** 复位：与 oracle 同一场景（快照 / 记忆 / 计划 / 悬念 / 平行 + 一条库内关联） */
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    cfg.relLayerEnabled = true;
    setScopeKey('角色甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        state: { date: '1919-11-29', time: '', location: '', sceneFocus: null, present: ['角色甲'] },
        snapshots: clone(G.scenario.snapshots),
        memories: clone(G.scenario.memories),
        plans: clone(G.scenario.plans),
        suspense: clone(G.scenario.suspense),
        parallels: clone(G.scenario.parallels),
        links: [],
    }));
    try {
        for (const l of (G.scenario.links || [])) upsertRelLinks(l.dim, l.refId, [l], { replace: true });
    } catch (e) { /* 库内预置关联失败不阻塞其余断言 */ }
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
    setRelPick(null);
    setRelFilter('all', '', null);
    setRelPickQuery('');
    return state;
}
boot();

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================

await A('R1 黄金样本与 V1 源码动作序证据齐备（v1.206 / 六个动作片段 / 怪癖记录）', () => {
    const s = G.meta.v1SourceSnips || {};
    return G.meta.v1Version === 'v1.206'
        && ['relJump', 'relGoto', 'relClearFilter', 'relPick', 'relPickClose', 'relPickAdd'].every((k) => typeof s[k] === 'string' && s[k].length > 40)
        // V1 relJump 的状态写入次序：relFilterDim → relFilterWho → relJumpRef → relPickRef
        && s.relJump.indexOf('relFilterDim = kind') < s.relJump.indexOf('relJumpRef = {')
        && s.relJump.indexOf('relJumpRef = {') < s.relJump.indexOf('relPickRef = null')
        // V1 relClearFilter：四项一起清
        && /relFilterDim = 'all'; relFilterWho = ''; relJumpRef = null; relPickRef = null;/.test(s.relClearFilter)
        // V1 relGoto：映射表含 suspense → plans（悬念与计划共用页面）
        && s.relGoto.indexOf("suspense: 'plans'") > 0 && s.relGoto.indexOf('pageSearchQuery[tabOf] = title') > 0
        // V1 relPick：同条目再点一次 → 收起（same ? null : …）
        && s.relPick.indexOf('relPickRef = same ? null :') > 0
        // V1 relPickAppendRow：dup 判定（snapNameKey 归一）
        && s.relPickAppendRow.indexOf("if (dup) return 'dup';") > 0 && s.relPickAppendRow.indexOf('snapNameKey') > 0
        && (G.meta.notes || []).some((n) => n.indexOf('relGoto') >= 0 && n.indexOf('activeMemSub') >= 0);
}, () => Object.keys(G.meta.v1SourceSnips || {}));

await A('R2 `relEntryTitle`：11 例（标题+正文拼接 / content.text 字段 / 同文不重复 / 60 字截断 / 空与 null）与 V1 逐值一致', () => {
    const got = G.entryTitle.cases.map((c) => String(relEntryTitle(c.dim, c.item)));
    const want = G.entryTitle.cases.map((c) => String(c.out));
    return J(got) === J(want) && G.entryTitle.cases.length === 11;
}, () => ({ got: G.entryTitle.cases.map((c) => relEntryTitle(c.dim, c.item)), want: G.entryTitle.cases.map((c) => c.out) }));

await A('R3 `relFindEntryId`：9 例（id 命中 / id 不存在回落标题+正文双向与匹配 / 空 raw / name 字段不参与）与 V1 逐值一致', () => {
    const got = G.findEntryId.cases.map((c) => String(relFindEntryId(c.dim, c.raw) || ''));
    const want = G.findEntryId.cases.map((c) => String(c.out || ''));
    return J(got) === J(want) && G.findEntryId.cases.length === 9;
}, () => ({ got: G.findEntryId.cases.map((c) => relFindEntryId(c.dim, c.raw)), want: G.findEntryId.cases.map((c) => c.out) }));

await A('R4 `relKnownNames`：只读角色档案、按档案顺序去重（重名样本 4 条 → 3 名），与 V1 名单逐值一致', () => {
    const got = relKnownNames();
    return J(got) === J(G.knownNames.out) && got.length === 3;
}, () => ({ got: relKnownNames(), want: G.knownNames.out }));

await A('R5 `relPickAppendRow` 三态：成功 / `dup`（同角色 · trim 同名 · snapNameKey 归一「角色·甲」）/ 容器缺失（空 refId · 非关联维度 · 空名 · 关联层关闭），与 V1 逐步一致', () => {
    // V1 步骤序（oracle）：容器法（记忆共享 box ×4 → 平行新 box → 非法参数 → null/{} 容器）
    const RID_M = 'r5-mem', RID_P = 'r5-par';
    relDiscard('memories', RID_M); relDiscard('parallels', RID_P);
    const out = [];
    const bad = [];
    const steps = G.pickAppendRow.steps;
    steps.forEach((s, i) => {
        let got;
        if (i <= 5) got = relPickAppendRow(s.dim, s.dim === 'parallels' ? RID_P : RID_M, s.who);   // 成功 / dup / 平行新容器
        else if (i <= 8) got = relPickAppendRow(s.dim, RID_M, s.who);                               // 空名 / 非关联维度
        else got = relPickAppendRow(s.dim, '', s.who);                                              // V1 容器为 null / 无 insertAdjacentHTML → V2「条目引用为空」
        out.push(got === 'dup' ? 'dup' : !!got);
    });
    const want = steps.map((s) => (s.out === 'dup' ? 'dup' : !!s.out));
    const rowsMem = relRowsOf('memories', RID_M).map((r) => r.who + '/' + r.how);
    const rowsPar = relRowsOf('parallels', RID_P).map((r) => r.who + '/' + r.how);
    const wantMem = (steps[2].rowsAfter || []).map((r) => r.who + '/' + r.how);
    const wantPar = (steps[5].rowsAfter || []).map((r) => r.who + '/' + r.how);
    // 关联层关闭 → 容器不可用（V2 适配语义）
    cfg.relLayerEnabled = false;
    const off = relPickAppendRow('memories', RID_M, '角色丙');
    cfg.relLayerEnabled = true;
    bad.push(off);
    relDiscard('memories', RID_M); relDiscard('parallels', RID_P);
    return J(out) === J(want) && J(rowsMem) === J(wantMem) && J(rowsPar) === J(wantPar)
        && want.indexOf('dup') >= 0 && want.indexOf(false) >= 0 && want.indexOf(true) >= 0
        && off === false;
}, () => ({ out: G.pickAppendRow.steps.map((s) => s.out), mem: relRowsOf('memories', 'r5-mem'), par: relRowsOf('parallels', 'r5-par') }));

await A('R6 `relPickState`/`setRelPick`：6 步迁移（null / 字符串化 / 布尔化 / undefined）与 V1 逐值一致，且返回值为副本', () => {
    const t = [];
    const obs = () => JSON.parse(JSON.stringify(relPickState()));
    t.push(JSON.parse(JSON.stringify(setRelPick(null))));
    t.push(JSON.parse(JSON.stringify(setRelPick({ dim: 'memories', id: 5, editor: 0 }))));
    const mut = relPickState(); if (mut) mut.id = 'HACKED';
    t.push(obs());
    t.push(JSON.parse(JSON.stringify(setRelPick({ dim: '', id: null, editor: 'x' }))));
    t.push(JSON.parse(JSON.stringify(setRelPick(undefined))));
    t.push(JSON.parse(JSON.stringify(setRelPick({ dim: 'plans' }))));
    const want = G.pickState.transitions.map((x) => x.out);
    setRelPick(null);
    return J(t) === J(want) && relPickState() === null && t[2].id === '5' && t[3].editor === true && t[4] === null;
}, () => ({ got: G.pickState.transitions.map((x) => x.call), pick: relPickState() }));

await A('R7 `relFilterState`/`setRelFilter`：6 步迁移（dim/who/jump 归一与副本语义）与 V1 逐值一致；`relClearFilter` 四项一起清', () => {
    const t = [];
    t.push(JSON.parse(JSON.stringify(setRelFilter('memories', '角色甲', { dim: 'plans', id: 7, title: null }))));
    const st = relFilterState(); if (st.jump) st.jump.id = 'HACKED';
    t.push(JSON.parse(JSON.stringify(relFilterState())));
    t.push(JSON.parse(JSON.stringify(setRelFilter(null, null, null))));
    t.push(JSON.parse(JSON.stringify(setRelFilter('memories', undefined, undefined))));
    t.push(JSON.parse(JSON.stringify(setRelFilter('all', '', {}))));
    t.push(JSON.parse(JSON.stringify(setRelFilter('all', '', null))));
    const want = G.filterState.transitions.map((x) => x.out);
    // relClearFilter：V1 `relFilterDim='all'; relFilterWho=''; relJumpRef=null; relPickRef=null`
    setRelFilter('plans', '角色乙', { dim: 'memories', id: 'm1', title: 'x' });
    setRelPick({ dim: 'plans', id: 'p1', editor: false });
    const cleared = JSON.parse(JSON.stringify(relClearFilter()));
    return J(t) === J(want)
        && J(cleared) === J({ dim: 'all', who: '', jump: null }) && relPickState() === null
        && G.meta.v1SourceSnips.relClearFilter.indexOf("relFilterDim = 'all'") > 0;
}, () => ({ got: t, want: G.filterState.transitions.map((x) => x.out), cleared: relFilterState() }));

await A('R8 `relPickPanelHtml` 结构投影：条目（含「已在关联」角标）/ 无关联条目 / 编辑器（`dim|editor` 键 + editor 标记）/ 平行事件 与 V1 关键片段一致', () => {
    /** 与 oracle 同一套投影函数（键名/正则一致，仅 V2 的属性名替换见下） */
    const projPanel = (h, editor) => {
        const grab = (re) => { const m = String(h).match(re); return m ? m[1] : null; };
        return {
            key: grab(/data-ftt-rel-pick="([^"]*)"/),
            title: grab(/<div class="ftt-editor-title">([^<]*)<\/div>/),
            hasPickAdd: h.indexOf('data-ftt-action="relPickAdd"') >= 0,
            hasClose: h.indexOf('data-ftt-action="relPickClose"') >= 0,
            hasSearch: h.indexOf('data-ftt-search="relPick"') >= 0,
            addCount: (h.match(/data-ftt-action="relPickAdd"/g) || []).length,
            nameButtons: (h.match(/data-ftt-action="relPickAdd"[^>]*data-name="([^"]*)"/g) || []).map((s) => (s.match(/data-name="([^"]*)"/) || [])[1]),
            linkedBadges: (h.match(/已在关联/g) || []).length,
            editorFlag: h.indexOf('data-editor="1"') >= 0,
            onlyFromArchive: h.indexOf('只从<b>角色档案</b>点名') >= 0,
            noEntryScan: h.indexOf('不遍历记忆 / 计划 / 悬念 / 平行条目') >= 0,
        };
    };
    const cases = [
        ['entry', G.pickPanel.entry, relPickPanelHtml('memories', 'm1', false)],
        ['entryNoLink', G.pickPanel.entryNoLink, relPickPanelHtml('memories', 'm2', false)],
        ['editor', G.pickPanel.editor, relPickPanelHtml('memories', 'm1', true)],
        ['parallels', G.pickPanel.parallels, relPickPanelHtml('parallels', 'pa1', false)],
    ];
    const fails = [];
    for (const [name, want, html] of cases) {
        const got = projPanel(html, want.editor);
        for (const k of Object.keys(want)) {
            if (k === 'dim' || k === 'refId' || k === 'editor' || k === 'emptyText') continue;
            if (k === 'nameButtons') { if (J(got.nameButtons) !== J(want.nameButtons)) fails.push(name + '.' + k); continue; }
            if (J(got[k]) !== J(want[k])) fails.push(name + '.' + k + ':' + J(got[k]) + '≠' + J(want[k]));
        }
    }
    // 空档案态文案与 V1 逐字一致
    const keep = state.snapshots;
    state.snapshots = [];
    const emptyText = (String(relPickPanelHtml('memories', 'm1', false)).match(/<div class="ftt-empty">([^<]*)<\/div>/) || [])[1] || null;
    state.snapshots = keep;
    return fails.length === 0 && emptyText === G.pickPanel.emptyArchive;
}, () => ({ entry: relPickPanelHtml('memories', 'm1', false).length, want: G.pickPanel.entry }));

await A('R9 `relJump` 状态迁移：四个维度（记忆/计划/悬念/平行）的维度·角色筛选·跳转引用（含 `relEntryTitle` 标题）与 V1 actionFlow 逐步一致；选择器态被关闭', () => {
    const steps = G.actionFlow.steps.filter((s) => s.name.indexOf('relJump(') === 0);
    const fails = [];
    for (const s of steps) {
        const dim = s.ds.fttKind, id = s.ds.fttId;
        setRelFilter('all', '', null); setRelPick({ dim: 'memories', id: 'x', editor: false });
        const r = relJump(dim, id);
        const got = { filter: JSON.parse(JSON.stringify(relFilterState())), pick: relPickState() };
        if (!r.ok) fails.push(dim + ':ok=false');
        if (J(got.filter) !== J(s.filter)) fails.push(dim + ' filter ' + J(got.filter) + '≠' + J(s.filter));
        if (got.pick !== null) fails.push(dim + ' pick≠null');
        if (String(s.filter.jump.title) !== (relEntryTitle(dim, ((state[dim]) || []).find((x) => x.id === id)) || '')) fails.push(dim + ' title');
        if (REL_TAB_OF[dim] !== (dim === 'suspense' ? 'plans' : dim)) fails.push(dim + ' tabMap');
    }
    // 非法目标：维度不合法 / 空 id → ok=false（V1 `if (!kind || !id) break;` 等价）
    const badOk = [relJump('atoms', 'a1').ok, relJump('memories', '').ok, relJump('', 'm1').ok];
    setRelFilter('all', '', null);
    return fails.length === 0 && steps.length === 4 && J(badOk) === J([false, false, false]);
}, () => ({ filter: relFilterState(), steps: G.actionFlow.steps.map((s) => s.name) }));

await A('R10 `relClearFilter` 收窄语义：清「角色筛选 + 跳转定位 + 选角色态」；`dim` 字段保留但**不参与过滤**（V2 页面即维度）', async () => {
    boot();
    openPanel('memories');
    await panelAction('msub', { tab: 'memories', sub: 'rel' });
    // 先设 角色筛选 + 定位 + 选择器态
    const f0 = setRelFilter('plans', '角色丙', { dim: 'memories', id: 'm1', title: '甲在码头看到木箱' });
    setRelPick({ dim: 'memories', id: 'm1', editor: false });
    const withFilter = panelBodyHtml('memories');
    const cleared = relClearFilter();
    const afterHtml = panelBodyHtml('memories');
    const cl = G.actionFlow.steps.filter((s) => s.name === 'relJump 后清除筛选')[0];
    // V1 清空后：{dim:'all', who:'', jump:null}
    const v1Ok = J(cl.filter) === J({ dim: 'all', who: '', jump: null });
    // V2 收窄证据：把 dim 设为 'plans' 后，记忆页的关系总览仍列出记忆条目（维度不参与过滤）
    setRelFilter('plans', '', null);
    const dimInert = panelBodyHtml('memories').indexOf('data-ftt-rel-entry="memories|m1"') >= 0;
    setRelFilter('all', '', null);
    return f0.dim === 'plans' && J(cleared) === J({ dim: 'all', who: '', jump: null }) && relPickState() === null
        && withFilter.indexOf('当前筛选：') >= 0 && withFilter.indexOf('data-ftt-action="relClearFilter"') >= 0
        && afterHtml.indexOf('当前筛选：') < 0 && dimInert && v1Ok;
}, () => ({ cleared: relFilterState(), dimInertHint: panelBodyHtml('memories').slice(0, 120) }));

await A('R11 `relGoto` 状态迁移：页面映射（悬念 → 计划悬念页）、搜索词取「标题优先，空则正文前 12 字」、清跳转/选择器态 —— 与 V1 actionFlow 的页面搜索词逐个一致', () => {
    const got = G.actionFlow.steps.filter((s) => s.name.indexOf('relGoto(') === 0).map((s) => {
        const dim = s.ds.fttKind, id = s.ds.fttId;
        setRelFilter('memories', '角色乙', { dim: 'memories', id: 'm9', title: 't' });
        setRelPick({ dim: 'memories', id: 'm9', editor: true });
        const r = relGoto(dim, id);
        // V1 观测 = 各页面搜索框 value；V1 `tabOf` 与 V2 `REL_TAB_OF` 同表
        const v1Val = s.searches[r.searchTab];
        return { dim, tab: r.tab, searchTab: r.searchTab, title: r.title, v1Val: v1Val, cleared: (r.ok && relFilterState().jump === null && relPickState() === null) };
    });
    const fails = got.filter((g) => g.title !== g.v1Val || !g.cleared).map((g) => g.dim + ':' + g.title + '≠' + g.v1Val);
    const tabOk = got.every((g) => g.tab === (g.dim === 'suspense' ? 'plans' : g.dim)) && got.length === 4;
    const badOk = [relGoto('atoms', 'a1').ok, relGoto('plans', '').ok];
    setRelFilter('all', '', null);
    return fails.length === 0 && tabOk && J(badOk) === J([false, false]);
}, () => ({ got: G.actionFlow.steps.filter((s) => s.name.indexOf('relGoto(') === 0).map((s) => s.searches) }));

await A('R12 `relPickAdd` 三态提示文案：成功 / 重复（`dup`）/ 容器缺失 —— 与 V1 `toast` 逐字一致（含 12 字截断）', async () => {
    boot();
    openPanel('memories');
    await panelAction('msub', { tab: 'memories', sub: 'rel' });
    await panelAction('relPick', { kind: 'memories', id: 'm2' });
    const a1 = await panelAction('relPickAdd', { kind: 'memories', id: 'm2', name: '角色乙' });
    const n1 = String(((a1.state || {}).note) || '');
    const a2 = await panelAction('relPickAdd', { kind: 'memories', id: 'm2', name: '角色乙' });
    const n2 = String(((a2.state || {}).note) || '');
    // 容器缺失：条目引用为空（非编辑器作用域）
    const a3 = await panelAction('relPickAdd', { kind: 'memories', id: '', name: '角色丙' });
    const n3 = String(((a3.state || {}).note) || '');
    const want = [
        G.pickAdd.addOk.toasts[0].text, G.pickAdd.addDupSkip.toasts[0].text, G.pickAdd.containerMissing.toasts[0].text,
    ];
    relDiscard('memories', 'm2');
    return n1 === want[0] && n2 === want[1] && n3 === want[2]
        && a1.appended === true && a2.dup === true && a3.ok === false
        && a2.appended === false;
}, () => ({ n1: panelAction && String(relFilterState) }));

// ============================================================
// V 组：V2 编排 / 接线
// ============================================================

await A('V1 条目行「🔗 关联」入口：四个关系维度分页的行内按钮存在（记忆带人数角标 `🔗 关联（N）`），且携带 `data-kind`/`data-id`', async () => {
    boot();
    upsertRelLinks('memories', 'm1', [{ who: '角色甲', how: 'participant' }, { who: '角色乙', how: 'witness' }], { replace: true });
    // 先切回列表子标签（关系表子页只渲染总览，不渲染条目行）
    for (const k of ['memories', 'plans', 'suspense', 'parallels']) await panelAction('msub', { tab: k, sub: 'list' });
    const rows = { memories: 'm1', plans: 'p1', suspense: 's1', parallels: 'pa1' };
    const fails = [];
    for (const kind of Object.keys(rows)) {
        // 悬念维度的条目行渲染在「计划悬念」页的悬念段里（V2 `panelBodyHtml('plans')` 含两段）
        const h = (kind === 'suspense') ? panelBodyHtml('plans') : panelBodyHtml(kind);
        const id = rows[kind];
        if (h.indexOf('data-ftt-action="relJump"') < 0) fails.push(kind + ':noAction');
        if (h.indexOf('data-kind="' + kind + '" data-id="' + id + '"') < 0) fails.push(kind + ':noRef');
        if (h.indexOf('🔗 关联') < 0) fails.push(kind + ':noLabel');
    }
    const memo = panelBodyHtml('memories');
    const plan = panelBodyHtml('plans');
    const par = panelBodyHtml('parallels');
    return fails.length === 0
        && memo.indexOf('🔗 关联（2）') >= 0                       // V1 `🔗 关联（people.length）`
        && plan.indexOf('在「记忆 → 关系表」里编辑这条计划的知情者') >= 0
        && plan.indexOf('在「记忆 → 关系表」里编辑这条悬念的知情者') >= 0
        && par.indexOf('在关系表里编辑相关角色') >= 0
        && G.entryRowEntry.label === '🔗 关联（1）';                // oracle：同场景 m1 只有 1 人（本断言用的是 2 人的本地数据）
}, () => ({ memo: (panelBodyHtml('memories').match(/🔗 关联（\d+）/) || [])[0], fails: 'see-per-kind' }));

await A('V2 `relJump` 面板编排：切到条目所在页 + 该维度子标签置 rel + 跳转提示与「清除筛选」入口 + 定位目标行出现（即使暂无关联）+ 目标条目选择器态被关', async () => {
    boot();
    openPanel('plans');
    const r = await panelAction('relJump', { kind: 'suspense', id: 's1' });     // 悬念条目 → 计划悬念页
    const st = r.state || {};
    const html = String(r.html || '');
    const ok1 = r.ok === true && st.tab === 'plans' && st.relSub && st.relSub.suspense === 'rel'
        && String(st.note).indexOf('已定位到关系表：悬念') === 0
        && html.indexOf('当前筛选：定位 悬念「断口之谜：断口来源不明') >= 0
        && html.indexOf('data-ftt-action="relClearFilter"') >= 0
        && html.indexOf('data-ftt-rel-entry="suspense|s1"') >= 0;
    // 记忆条目：无关联也必须在总览里列出（V1 `!rows.length && !jump` 的定位例外）
    const r2 = await panelAction('relJump', { kind: 'memories', id: 'm2' });
    const st2 = r2.state || {};
    const html2 = String(r2.html || '');
    const ok2 = r2.ok === true && st2.tab === 'memories' && st2.relSub.memories === 'rel'
        && html2.indexOf('data-ftt-rel-entry="memories|m2"') >= 0 && html2.indexOf('🔗 定位') >= 0
        && html2.indexOf('当前筛选：定位 记忆「仓库清点：乙清点仓库，少了三箱。」') >= 0;
    // 编辑态被清空（V1 `editor = null`）
    await panelAction('edit', { kind: 'memories', id: 'm1' });
    const r3 = await panelAction('relJump', { kind: 'memories', id: 'm1' });
    const ok3 = (r3.state || {}).editing === null;
    // 非法目标 → 如实失败
    const r4 = await panelAction('relJump', { kind: 'atoms', id: 'a1' });
    return ok1 && ok2 && ok3 && r4.ok === false;
}, () => ({ step: 'relJump' }));

await A('V3 `relGoto` 面板编排：切到条目所在页并把**该页搜索词**设为条目标题（悬念→计划悬念页的 plans 搜索框）+ 清跳转/选择器态', async () => {
    boot();
    openPanel('memories');
    await panelAction('relJump', { kind: 'memories', id: 'm1' });
    const g1 = await panelAction('relGoto', { kind: 'memories', id: 'm1' });
    const s1 = g1.state || {};
    const ok1 = g1.ok === true && s1.tab === 'memories' && s1.search.memories === '码头见闻'
        && String(s1.note).indexOf('已定位到「码头见闻」') === 0 && relFilterState().jump === null && relPickState() === null;
    const g2 = await panelAction('relGoto', { kind: 'suspense', id: 's1' });
    const s2 = g2.state || {};
    // V1 同款：悬念映射到页面 'plans' → 搜索词写在 plans（`searches.suspense` 恒空）
    const oracleVal = G.actionFlow.steps.filter((s) => s.name.indexOf('relGoto(suspense') === 0)[0].searches.plans;
    const ok2 = g2.ok === true && s2.tab === 'plans' && s2.search.plans === oracleVal && s2.search.suspense !== oracleVal
        && String(s2.note).indexOf('已定位到「断口之谜」') === 0;
    const g3 = await panelAction('relGoto', { kind: 'parallels', id: 'pa1' });
    const ok3 = (g3.state || {}).tab === 'parallels' && (g3.state || {}).search.parallels === '第三方插手';
    // 无标题条目 → 取正文前 12 字；完全空 → '已打开条目所在页'
    state.memories.push({ id: 'm9', owner: '角色丙', content: '只有正文的一条记忆，没有标题字段。' });
    const g4 = await panelAction('relGoto', { kind: 'memories', id: 'm9' });
    const ok4 = (g4.state || {}).search.memories === '只有正文的一条记忆，没有' && String((g4.state || {}).note).indexOf('已定位到「') === 0;
    return ok1 && ok2 && ok3 && ok4;
}, () => ({ search: panelBodyHtml('memories') }));

await A('V4 `relPick` / `relPickClose` / `relPickQuery`：同条目再点一次收起、跨条目切换、关闭清空；搜索词只在选角色面板内生效（不污染列表页搜索）', async () => {
    boot();
    openPanel('memories');
    await panelAction('msub', { tab: 'memories', sub: 'rel' });
    const p1 = await panelAction('relPick', { kind: 'memories', id: 'm1' });
    const on1 = String(p1.html || '').indexOf('data-ftt-rel-pick="memories|m1"') >= 0;
    const p2 = await panelAction('relPick', { kind: 'memories', id: 'm1' });
    const off2 = String(p2.html || '').indexOf('data-ftt-rel-pick="memories|m1"') < 0 && relPickState() === null;
    const p3 = await panelAction('relPick', { kind: 'memories', id: 'm1' });
    await panelAction('relPickQuery', { q: '乙' });
    const q = relPickQueryOf();
    const htmlQ = panelBodyHtml('memories');
    const filtered = htmlQ.indexOf('data-name="角色乙"') >= 0 && htmlQ.indexOf('data-name="角色甲"') < 0;
    const listSearch = String((await panelAction('search', { kind: 'memories', q: '' })).state.search.memories) === '';
    await panelAction('relPickQuery', { q: '' });
    const c = await panelAction('relPickClose', {});
    const closed = relPickState() === null && String((c.state || {}).note) === '已收起「👥 选角色」';
    // 编辑器作用域：面板键为 `dim|editor`（V1 relPickKey 口径）—— 需先打开编辑器（V2 编辑器在列表子标签下渲染）
    await panelAction('relEdit', { kind: 'memories', id: 'm1' });
    await panelAction('relPick', { kind: 'memories', id: 'm1', editor: '1' });
    const ed = String((await panelAction('refresh', {})).html || '');
    const edKey = (ed.match(/data-ftt-rel-pick="([^"]*)"/) || [])[1] || null;
    await panelAction('relPickClose', {});
    return on1 && off2 && q === '乙' && filtered && listSearch && closed
        && relPickState() === null && G.pickPanel.editor.key === 'memories|editor' && edKey === 'memories|editor';
}, () => ({ pick: relPickState(), q: relPickQueryOf(), edKey: (String(panelBodyHtml('memories')).match(/data-ftt-rel-pick="([^"]*)"/) || [])[1] }));

await A('V5 端到端：条目行 → relJump → 选角色 → ➕ 追加（草稿）→ 「💾 保存关联」落库 → 关系总览出现该角色；重复角色被挡且不打乱已有行', async () => {
    boot();
    openPanel('memories');
    await panelAction('relJump', { kind: 'memories', id: 'm2' });           // m2 库内无关联
    await panelAction('relPick', { kind: 'memories', id: 'm2' });
    const add1 = await panelAction('relPickAdd', { kind: 'memories', id: 'm2', name: '角色乙' });
    const add2 = await panelAction('relPickAdd', { kind: 'memories', id: 'm2', name: '角色乙' });
    const draft = relRowsOf('memories', 'm2').map((r) => r.who + '/' + r.how);
    const libBefore = relLinksOf('memories', 'm2').filter((x) => x.who).length;      // 未保存 → 库内仍为 0
    const save = await panelAction('relSave', { kind: 'memories', id: 'm2' });
    const libAfter = relLinksOf('memories', 'm2').filter((x) => x.who).map((x) => x.who + '/' + x.how);
    const view = panelBodyHtml('memories');
    const oracleRows = (G.pickAdd.addOk.rowsAfterFirst || []).map((r) => r.who + '/' + r.how);
    return add1.appended === true && add2.dup === true
        && J(draft) === J(oracleRows) && libBefore === 0
        && save.ok === true && save.saved === 1 && J(libAfter) === J(oracleRows)
        && view.indexOf('角色乙（知情）') >= 0 && view.indexOf('data-ftt-rel-entry="memories|m2"') >= 0
        && relPickState() === null;                                          // V1 `case 'relSave'`：保存后关选择器
}, () => ({ draft: relRowsOf('memories', 'm2'), lib: relLinksOf('memories', 'm2') }));

await A('V6 子标签切换（`msub`）重置跳转定位与选择器态，但**不清角色筛选**（V1 `fttMsub` 点击口径）；关系层关闭时选角色追加如实失败', async () => {
    boot();
    openPanel('memories');
    setRelFilter('memories', '角色甲', { dim: 'memories', id: 'm1', title: '码头见闻' });
    setRelPick({ dim: 'memories', id: 'm1', editor: false });
    const r = await panelAction('msub', { tab: 'memories', sub: 'list' });
    const s = relFilterState();
    const v1Step = G.actionFlow.steps.filter((x) => x.name.indexOf('子标签点击') === 0)[0];
    const v1Ok = J(v1Step.filter) === J({ dim: 'memories', who: '', jump: null });
    // V1 oracle 该步 who 为 ''（此前 relJump 已清）；此处 V2 显式验证「who 保留、jump/pick 清」——比 V1 更强的同向断言
    cfg.relLayerEnabled = false;
    const off = relPickAppendRow('memories', 'm1', '角色丙');
    const offPanel = await panelAction('relPickAdd', { kind: 'memories', id: 'm1', name: '角色丙' });
    cfg.relLayerEnabled = true;
    return r.ok === true && s.who === '角色甲' && s.jump === null && relPickState() === null
        && v1Ok && off === false && offPanel.ok === false
        && String((offPanel.state || {}).note) === G.pickAdd.containerMissing.toasts[0].text;
}, () => ({ filter: relFilterState(), note: '' }));

await A('V7 常量与只读诊断：`REL_TAB_OF` 与 V1 `relGoto` 的 `tabOf` 映射逐键一致；`relDimLabelOf`/`relIsRelDim` 与 V1 同口径；`relEntryTitle` 不修改入参', () => {
    const want = { memories: 'memories', currencies: 'currencies', plans: 'plans', suspense: 'plans', parallels: 'parallels' };
    const keysOk = Object.keys(want).every((k) => REL_TAB_OF[k] === want[k]) && Object.keys(REL_TAB_OF).length === 5;
    const src = G.meta.v1SourceSnips.relGoto;
    const srcOk = Object.keys(want).every((k) => src.indexOf(k + ": '" + want[k] + "'") > 0);
    const item = { id: 'x', title: '标题', content: '正文' };
    const before = J(item);
    const t = relEntryTitle('memories', item);
    const labelsOk = relDimLabelOf('memories') === '记忆' && relDimLabelOf('plans') === '计划'
        && relDimLabelOf('suspense') === '悬念' && relDimLabelOf('parallels') === '平行事件'
        && relDimLabelOf('atoms') === 'atoms'                       // V1 `relDimLabelOf` 未知维度原样返回
        && relIsRelDim('memories') === true && relIsRelDim('atoms') === false && relIsRelDim(null) === false;
    return keysOk && srcOk && J(item) === before && t === '标题：正文' && labelsOk;
}, () => ({ relTabOf: REL_TAB_OF, v1: G.meta.v1SourceSnips.relGoto.slice(0, 80) }));

un();
R.done();
