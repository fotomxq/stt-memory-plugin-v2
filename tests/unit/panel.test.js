// ============================================================
// 单元测试 · 面板对齐 V1（B1：外壳 + 样式 + 13 分页 + 总览/列表/编辑器/设置）
// 口径：DOM 结构与 V1 `panelHtml()` 同名同层级（`#ftt-panel` / `.ftt-modal` / `.ftt-modal-head` /
//   `.ftt-tabs` / `.ftt-tab` / `.ftt-body[data-ftt-body]`），故 V1 的 CSS（已逐字并入 style.css）直接生效。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    openPanel, closePanel, panelHtml, panelTabs, panelInfo, panelState, panelAction, panelBodyHtml,
    PANEL_ID, PANEL_TABS, setPanelHooks2, unmountPanel,
} from '../../ui/panel.js';
import { kindFields } from '../../ui/fields.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('panel V1 同构面板（B1）');

/** 异步断言助手：**求值后再断言**（防「Promise 恒真」的假绿；见 tests/harness/st-mock.js 的防呆） */
async function A(name, fn, detail) {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
}
const J = (v) => JSON.stringify(v);
const CSS = readFileSync(join(ROOT, 'style.css'), 'utf8');

const doc = makeDocument([PANEL_ID, 'extensions_settings2', 'extensions_settings', 'extensionsMenu',
    'ftt_v2_status', 'ftt_v2_action', 'ftt_v2_console', 'ftt_v2_popup_body', 'ftt_v2_popup_note',
    'ftt_v2_updstate', 'ftt_v2_checkupd', 'ftt_v2_doupd', 'ftt_v2_autoupd', 'ftt_v2_updrepo',
    'ftt_v2_cfg_injp', 'ftt_v2_cfg_budget', 'ftt_v2_cfg_maxatoms', 'ftt_v2_cfg_maxmems', 'ftt_v2_cfg_autoext',
    'ftt_v2_dims']);
doc.body = { html: '', insertAdjacentHTML(pos, h) { this.html += String(h); }, addEventListener() { } };
const host = makeHost({ templateHtml: readFileSync(join(ROOT, 'settings.html'), 'utf8') });
const un = installGlobalHost(host, doc);

Object.assign(cfg, JSON.parse(J(defaultCfg)));
setScopeKey('角色甲');
setLastMessageId(9);
const SEED = () => Object.assign(emptyState(), {
    state: { date: '1919-11-29', time: '夜', location: '码头', present: ['甲', '乙'] },
    atoms: [{ id: 'a1', title: '码头木箱', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'] }],
    memories: [{ id: 'm1', owner: '甲', content: '甲记得昨夜有人在巷口徘徊。', date: '1919-11-28' }],
    currentStates: [{ id: 'c1', subject: '甲', field: '心情', value: '警觉' }],
    processedFloors: [{ f: 0, h: 'x' }, { f: 1, h: 'y' }, { f: 3, h: 'z' }],
    snapshots: [{ id: 's1', name: '甲', identity: { gender: '男', birthDate: '1900-05-20' } }],
    scenes: [{ id: 'sc1', name: '码头', pathArr: ['城外', '码头'] }],
});
function boot() {
    setKernelState(SEED());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();
setPanelHooks2({ pending: () => [4, 5], extract: async () => ({ ok: true, done: 1, results: [{ floor: 4, ok: true, added: 2 }] }), clearInject: () => true, inject: async () => ({ ok: true, chars: 12 }), checkUpdate: async () => ({ ran: true }) });

// ---------- 外壳与样式 ----------
R.assert('S1 V1 样式已逐字并入：style.css 含 #ftt-panel 系列规则且覆盖关键类', (() => {
    const need = ['#ftt-panel', '.ftt-modal-head', '.ftt-tabs', '.ftt-tab.ftt-on', '.ftt-body', '.ftt-item', '.ftt-editor', '.ftt-btn', '.ftt-empty', '.ftt-floor-btn'];
    return need.every((k) => CSS.indexOf(k) >= 0) && (CSS.match(/#ftt-panel/g) || []).length >= 300;
})(), (CSS.match(/#ftt-panel/g) || []).length);

R.assert('S2 浮层 DOM 与 V1 同构：#ftt-panel > .ftt-modal > 头/标签/13 个 .ftt-body[data-ftt-body]', (() => {
    const html = panelHtml();
    const tabIds = PANEL_TABS.map((t) => t[0]);
    return tabIds.length === 13
        && html.indexOf('<div class="ftt-modal">') >= 0
        && html.indexOf('class="ftt-modal-head"') >= 0 && html.indexOf('class="ftt-close"') >= 0
        && html.indexOf('class="ftt-tabs"') >= 0
        && tabIds.every((t) => html.indexOf('data-ftt-tab="' + t + '"') >= 0 && html.indexOf('data-ftt-body="' + t + '"') >= 0)
        && html.indexOf('📖 FTT记忆组件') >= 0 && html.indexOf('总记忆数') >= 0;
})(), panelInfo());

R.assert('S3 打开/关闭：写入 #ftt-panel、置 open 标记、关闭清空内容', (() => {
    const r = openPanel('overview');
    const el = doc.getElementById(PANEL_ID);
    const opened = r.ok === true && r.via === 'overlay' && panelInfo().open === true
        && String(el.html).indexOf('ftt-modal') >= 0;
    closePanel();
    return opened && panelInfo().open === false;
})(), panelInfo());

// ---------- 13 分页内容 ----------
R.assert('P1 总览：剧情时钟三行 + 在场 + 注入审计 + 类目统计 + 已处理区间 + 未摘要楼层按钮', (() => {
    const h = panelBodyHtml('overview');
    return h.indexOf('📅 日期：1919-11-29') >= 0 && h.indexOf('⏱ 时间：夜') >= 0 && h.indexOf('📍 地点：码头') >= 0
        && h.indexOf('👥 在场角色：甲、乙') >= 0
        && h.indexOf('🧷 注入') >= 0 && h.indexOf('📚 类目统计') >= 0
        && h.indexOf('已处理区间：0-1、3') >= 0
        && h.indexOf('data-ftt-action="summaryFloor" data-ftt-floor="4"') >= 0
        && h.indexOf('data-ftt-action="summary"') >= 0 && h.indexOf('data-ftt-action="inject"') >= 0;
})(), '');

R.assert('P2 维度分页：V1 行样式（.ftt-item/.ftt-inline/.ftt-btn）+ 搜索框 + 编辑/删除按钮；计划页含悬念', (() => {
    const atoms = panelBodyHtml('atoms');
    const plans = panelBodyHtml('plans');
    return atoms.indexOf('data-ftt-search="atoms"') >= 0 && atoms.indexOf('class="ftt-item ftt-inline"') >= 0
        && atoms.indexOf('data-ftt-action="edit" data-kind="atoms" data-id="a1"') >= 0
        && atoms.indexOf('data-ftt-action="delete" data-kind="atoms" data-id="a1"') >= 0
        && atoms.indexOf('码头木箱') >= 0
        && plans.indexOf('悬念') >= 0 && plans.indexOf('data-ftt-search="plans"') >= 0 && plans.indexOf('data-ftt-search="suspense"') >= 0;
})(), '');

await A('P3 空类目提示与搜索过滤：无匹配时显示 .ftt-empty；搜索词只影响该分页', async () => {
    const before = panelBodyHtml('atoms');
    await panelAction('search', { kind: 'atoms', q: '不存在的词zzz' });
    const filtered = panelBodyHtml('atoms');
    const other = panelBodyHtml('memories');
    await panelAction('search', { kind: 'atoms', q: '' });
    const back = panelBodyHtml('atoms');
    return before.indexOf('码头木箱') >= 0 && filtered.indexOf('ftt-empty') >= 0 && filtered.indexOf('码头木箱') < 0
        && other.indexOf('巷口徘徊') >= 0 && back.indexOf('码头木箱') >= 0 && panelState().search.atoms === '';
}, '');

await A('P4 编辑器：点 ✏️ 展开 .ftt-editor（V1 字段表：标题/正文/日期/标签/重要度 + 内容哈希），可保存落库', async () => {
    await panelAction('edit', { kind: 'atoms', id: 'a1' });
    const ed = panelBodyHtml('atoms');
    const before = state.atoms[0].title;
    const r = await panelAction('save', { kind: 'atoms', id: 'a1', fields: { title: '码头木箱（已核对）', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: '码头、木箱', importance: '0.9' } });
    const after = state.atoms.filter((x) => x.id === 'a1')[0];
    return ed.indexOf('class="ftt-editor"') >= 0 && ed.indexOf('data-ftt-ed="title"') >= 0 && ed.indexOf('data-ftt-ed="importance"') >= 0
        && ed.indexOf('内容哈希') >= 0
        && r.ok === true && before === '码头木箱' && after.title === '码头木箱（已核对）' && after.importance === 0.9
        && panelState().editing === null && panelState().note.indexOf('已保存') >= 0;
}, panelState());

await A('P5 删除：留 id 墓碑并从容器移除（与数据台同一实现）', async () => {
    const r = await panelAction('delete', { kind: 'atoms', id: 'a1' });
    const gone = state.atoms.filter((x) => x.id === 'a1').length === 0;
    return r.ok === true && gone && !!((state.deleted || {}).atoms || {})['a1'] && panelState().note.indexOf('已删除') >= 0;
}, (state.deleted || {}).atoms);

// ---------- 动作 ----------
await A('A1 工具行动作：⚡ 批量摘要 / 📤 提取（单楼）/ 📤 立即注入 各自走对应钩子并回填提示', async () => {
    boot();
    // B3 起：`summary` 走批量分段摘要钩子（autoSummary）、`extractNow` 走逐楼提取钩子（extract）
    setPanelHooks2({
        autoSummary: async (o) => ({ ok: true, segments: 2, floors: '4-9', added: 3, aborted: 0, silent: o && o.silent }),
        extract: async () => ({ ok: true, done: 1, results: [{ floor: 4, ok: true, added: 2 }] }),
        inject: async () => ({ ok: true, chars: 12 }),
        clearInject: () => true,
    });
    const all = await panelAction('summary', {});
    const noteAll = panelState().note;
    const one = await panelAction('summaryFloor', { floor: 4 });
    const noteOne = panelState().note;
    const inj = await panelAction('inject', {});
    const noteInj = panelState().note;
    const batch = await panelAction('extractNow', {});
    const noteBatch = panelState().note;
    return all.ok === true && one.ok === true && inj.ok === true && batch.ok === true
        && noteAll.indexOf('摘要完成：2 段 · 读取楼层 4-9 · 新增 3 条') >= 0
        && noteOne.indexOf('第 4 楼：新增 2 条') >= 0
        && noteInj.indexOf('已注入 12 字') >= 0 && noteBatch.indexOf('分析完成') >= 0;
}, panelState().note);

await A('A2 切页与关闭动作：tab 切换更新面板状态并重渲染；close 关闭浮层', async () => {
    openPanel('overview');
    const r = await panelAction('tab', { tab: 'memories' });
    const open2 = panelInfo().open;
    await panelAction('close', {});
    return r.ok === true && panelState().tab === 'memories' && panelState().editing === null
        && String(r.html).indexOf('class="ftt-tab ftt-on" data-ftt-tab="memories"') >= 0
        && open2 === true && panelInfo().open === false;
}, panelState());

R.assert('A3 设置分页：渲染 V1 的 14 组子页（子标签 + 当前页控件 + V2 附加设定块）', (() => {
    const h = panelBodyHtml('settings');
    // v2.34.0：子标签标记改为 V1 同款（`<a href="javascript:void(0)" class="ftt-subtab" data-ftt-subtab="<id>">`）
    return h.indexOf('ftt-settings-subtabs') >= 0 && h.indexOf('data-ftt-subtab="base"') >= 0
        && h.indexOf('href="javascript:void(0)" class="ftt-subtab') >= 0
        && h.indexOf('data-ftt-settings-page="base"') >= 0 && h.indexOf('data-ftt-cfg="') >= 0
        && h.indexOf('V2 附加设定') >= 0 && h.indexOf('data-ftt-v2="autoUpdateCheck"') >= 0
        && h.indexOf('data-ftt-action="importV1Dry"') >= 0 && h.indexOf('ftt_v2_dims') >= 0;
})(), '');

await A('A4 未知动作与卸载：未知动作返回失败不抛；unmount 关闭并清空浮层引用', async () => {
    const bad = await panelAction('不存在的动作', {});
    unmountPanel();
    return bad.ok === false && bad.reason === 'unknown-action' && panelInfo().open === false;
}, panelInfo());

// ---------- B2：条目操作与编辑器全量 ----------
await A('B2-1 编辑器字段表与 V1 一致：各维度字段数与标签取自 kindFields（13 维）', async () => {
    boot();
    const counts = ['atoms', 'states', 'snapshots', 'memories', 'concepts', 'items', 'currencies', 'plotSegments', 'rumors', 'plans', 'suspense', 'scenes', 'parallels']
        .map((k) => k + ':' + kindFields(k).length).join(' ');
    await panelAction('edit', { kind: 'snapshots', id: 's1' });
    const ed = panelBodyHtml('snapshots');
    return counts === 'atoms:11 states:5 snapshots:20 memories:8 concepts:7 items:6 currencies:7 plotSegments:2 rumors:10 plans:11 suspense:11 scenes:3 parallels:13'
        && ed.indexOf('class="ftt-editor"') >= 0 && ed.indexOf('data-ftt-ed="birthDate"') >= 0
        && ed.indexOf('出生日期(年-月-日；年龄自动计算)') >= 0 && ed.indexOf('data-ftt-ed="deceased"') >= 0;
}, '');

await A('B2-2 新增（含预设）：add 打开空编辑器；addStateFor 预设主体；addChildScene 预设父级并生成 pathArr', async () => {
    boot();
    await panelAction('add', { kind: 'items' });
    const newItems = panelBodyHtml('items');
    await panelAction('addStateFor', { subject: '甲' });
    const st = panelBodyHtml('states');
    await panelAction('addChildScene', { id: 'sc1' });
    const sc = panelBodyHtml('scenes');
    const r = await panelAction('save', { kind: 'scenes', id: '', fields: { name: '仓库', parent: 'sc1', desc: '堆货' } });
    const child = (state.scenes || []).filter((x) => x.name === '仓库')[0];
    return newItems.indexOf('➕ 新增 · 物品') >= 0 && st.indexOf('value="甲"') >= 0
        && sc.indexOf('data-ftt-ed="parent"') >= 0 && sc.indexOf('selected') >= 0
        && r.ok === true && !!child && J(child.pathArr) === J(['城外', '码头', '仓库']);   // deconstructEntry：父级路径 + 本节点名（V1 口径）
}, (state.scenes || []).map((x) => x.name));

await A('B2-3 多选与批量删除：multiToggle → selectAll → bulkDelete（逐条留墓碑并清空选择）', async () => {
    boot();
    await panelAction('multiToggle', { kind: 'atoms' });
    await panelAction('selectAll', { kind: 'atoms' });
    const n1 = panelState().selCount;
    const del = await panelAction('bulkDelete', { kind: 'atoms' });
    const tombstones = Object.keys((state.deleted || {}).atoms || {}).length;
    await panelAction('multiToggle', { kind: 'atoms' });
    return n1 === 1 && del.ok === true && del.deleted === 1 && state.atoms.length === 0
        && tombstones >= 1 && panelState().selCount === 0 && panelState().multi.atoms === false;
}, panelState());

await A('B2-4 隐藏过滤与速览：atomToggleHidden 切换显示已总结；atomPeek 穿透查看原文并可收起', async () => {
    boot();
    const s2 = SEED();
    s2.atoms.push({ id: 'a2', title: '已总结情节', text: '这条情节已被总结隐藏。', hidden: true, summarizedAt: 1 });
    setKernelState(s2);
    const filtered = panelBodyHtml('atoms');
    await panelAction('atomToggleHidden', {});
    const shown = panelBodyHtml('atoms');
    await panelAction('atomPeek', { id: 'a2' });
    const peeked = panelBodyHtml('atoms');
    await panelAction('atomPeekClose', {});
    const closed = panelBodyHtml('atoms');
    return filtered.indexOf('已总结情节') < 0 && filtered.indexOf('👁 显示已总结（1）') >= 0
        && shown.indexOf('已总结情节') >= 0 && shown.indexOf('🙈 隐藏已总结') >= 0
        && peeked.indexOf('🔍 速览') >= 0 && peeked.indexOf('这条情节已被总结隐藏。') >= 0
        && closed.indexOf('🔍 速览') < 0;
}, panelState());

await A('B2-5 状态分组：按主体分组 + delStateGroup 删除整组（逐条墓碑）；搜索清除恢复全量', async () => {
    boot();
    const s3 = SEED();
    s3.currentStates = [{ id: 'c1', subject: '甲', field: '心情', value: '警觉' }, { id: 'c2', subject: '乙', field: '伤', value: '轻' }];
    setKernelState(s3);
    const grouped = panelBodyHtml('states');
    const r = await panelAction('delStateGroup', { subject: '乙' });
    const after = (state.currentStates || []).map((x) => x.id);
    await panelAction('search', { kind: 'states', q: '警觉' });
    const searched = panelBodyHtml('states');
    await panelAction('searchClear', { searchKind: 'states' });
    const cleared = panelBodyHtml('states');
    return grouped.indexOf('👤 甲') >= 0 && grouped.indexOf('(1)') >= 0 && grouped.indexOf('data-ftt-action="delStateGroup" data-ftt-subject="乙"') >= 0
        && r.ok === true && J(after) === J(['c1'])
        // **有意偏离 V1**：墓碑写进规范维度键 deleted.currentStates（V1 写 deleted.states，其自己的合并读不到）
        && !!((state.deleted || {}).currentStates || {})['c2']
        && searched.indexOf('心情') >= 0 && searched.indexOf('伤') < 0
        && cleared.indexOf('伤') < 0 && panelState().search.states === '';
}, (state.deleted || {}).currentStates);

await A('B2-6 关闭编辑器：closeEntry 不写库仅收起；deconstructEntry 保存语义（数组/分组字段还原）', async () => {
    boot();
    await panelAction('edit', { kind: 'memories', id: 'm1' });
    const before = J(state.memories[0]);
    await panelAction('closeEntry', { kind: 'memories' });
    const afterClose = J(state.memories[0]);          // 必须在保存**之前**取：closeEntry 不得写库
    const closed = panelState().editing === null;
    const r = await panelAction('save', { kind: 'memories', id: 'm1', fields: { owner: '甲', content: '甲记得有人在巷口徘徊。', date: '1919-11-28', tags: '秘密、见闻', importance: 0.6 } });
    const m = state.memories.filter((x) => x.id === 'm1')[0];
    return closed && afterClose === before
        && r.ok === true && m && m.content.indexOf('巷口') >= 0
        && Array.isArray(m.tags) && m.tags.join('、') === '秘密、见闻' && m.importance === 0.6;
}, state.memories[0]);

un();
R.done();
