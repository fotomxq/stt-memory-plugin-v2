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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('panel V1 同构面板（B1）');
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

R.assert('P3 空类目提示与搜索过滤：无匹配时显示 .ftt-empty；搜索词只影响该分页', (async () => {
    const before = panelBodyHtml('atoms');
    await panelAction('search', { kind: 'atoms', q: '不存在的词zzz' });
    const filtered = panelBodyHtml('atoms');
    const other = panelBodyHtml('memories');
    await panelAction('search', { kind: 'atoms', q: '' });
    const back = panelBodyHtml('atoms');
    return before.indexOf('码头木箱') >= 0 && filtered.indexOf('ftt-empty') >= 0 && filtered.indexOf('码头木箱') < 0
        && other.indexOf('巷口徘徊') >= 0 && back.indexOf('码头木箱') >= 0 && panelState().search.atoms === '';
})(), '');

R.assert('P4 编辑器：点 ✏️ 展开 .ftt-editor（标题/正文/日期/标签/重要度 + 内容哈希 + 关联），可保存落库', (async () => {
    await panelAction('edit', { kind: 'atoms', id: 'a1' });
    const ed = panelBodyHtml('atoms');
    const before = state.atoms[0].title;
    const r = await panelAction('save', { kind: 'atoms', id: 'a1', fields: { title: '码头木箱（已核对）', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: '码头、木箱', importance: '0.9' } });
    const after = state.atoms.filter((x) => x.id === 'a1')[0];
    return ed.indexOf('class="ftt-editor"') >= 0 && ed.indexOf('data-ftt-ed="title"') >= 0 && ed.indexOf('data-ftt-ed="importance"') >= 0
        && ed.indexOf('内容哈希') >= 0 && ed.indexOf('关联：') >= 0
        && r.ok === true && before === '码头木箱' && after.title === '码头木箱（已核对）' && after.importance === 0.9
        && panelState().editing === null && panelState().note.indexOf('已保存') >= 0;
})(), panelState());

R.assert('P5 删除：留 id 墓碑并从容器移除（与数据台同一实现）', (async () => {
    const r = await panelAction('delete', { kind: 'atoms', id: 'a1' });
    const gone = state.atoms.filter((x) => x.id === 'a1').length === 0;
    return r.ok === true && gone && !!((state.deleted || {}).atoms || {})['a1'] && panelState().note.indexOf('已删除') >= 0;
})(), (state.deleted || {}).atoms);

// ---------- 动作 ----------
R.assert('A1 工具行动作：提取（全部分析 / 单楼）与立即注入走注入钩子并回填提示', (async () => {
    boot();
    const all = await panelAction('summary', {});
    const one = await panelAction('summaryFloor', { floor: 4 });
    const inj = await panelAction('inject', {});
    const notes = panelState().note;
    return all.ok === true && one.ok === true && inj.ok === true
        && notes.indexOf('已注入') >= 0;
})(), panelState().note);

R.assert('A2 切页与关闭动作：tab 切换更新面板状态并重渲染；close 关闭浮层', (async () => {
    openPanel('overview');
    const r = await panelAction('tab', { tab: 'memories' });
    const open2 = panelInfo().open;
    await panelAction('close', {});
    return r.ok === true && panelState().tab === 'memories' && panelState().editing === null
        && String(r.html).indexOf('class="ftt-tab ftt-on" data-ftt-tab="memories"') >= 0
        && open2 === true && panelInfo().open === false;
})(), panelState());

R.assert('A3 设置分页：内嵌现有设置表单（内核配置控件）并在后续批次替换为 V1 的 13 组子页', (() => {
    const h = panelBodyHtml('settings');
    return h.indexOf('ftt_v2_cfg_budget') >= 0 && h.indexOf('ftt_v2_cfg_autoext') >= 0
        && h.indexOf('13 组设定子页') >= 0 && h.indexOf('ftt_v2_settings') >= 0;
})(), '');

R.assert('A4 未知动作与卸载：未知动作返回失败不抛；unmount 关闭并清空浮层引用', (async () => {
    const bad = await panelAction('不存在的动作', {});
    unmountPanel();
    return bad.ok === false && bad.reason === 'unknown-action' && panelInfo().open === false;
})(), panelInfo());

un();
R.done();
