// ============================================================
// 单元测试 · v3.43.1 **用户报告回归**（`docs/D19` `应-24` / 事实登记 `docs/D17` U182）
//
// 用户报告（原话）：「修正各大类的多选设计，当直接选择对应选项后，顶部的删除等按钮无效。
//   必须选择全选才能激活，请修复该问题。」
//
// 根因：`data-ftt-select` 复选框的 `change` 分支**只改内存集合**（`ui/panel.js#ps.sel`），
//   不重绘也不做局部同步 → 工具行按钮的 `disabled` 与「（N）」计数停在**渲染时快照**上：
//   0 勾选时渲染出的「🗑 删除选中（0）」带 `disabled`，之后无论怎么勾都不会变；
//   只有「全选」是动作（`panelAction` → 整页重绘）才能把它激活 —— 正是用户看到的现象。
//
// 本文件锁四件事：
//   ① **单一事实源** —— 渲染与勾选同步共用 `ui/select-bar.js` 的同一张表（防再次漂移）；
//   ② **用户场景端到端** —— 不经「全选」，直接勾 1 条 → 按钮当场可用、计数为 1；
//   ③ **不整页重绘** —— 勾选走局部同步（`panelRenderStats().renders` 不变，`docs/D9` §5.2 第 5 条）；
//   ④ **数据通路本来就是对的** —— 直接勾选后 `bulkDelete` 只删勾中的那条（证明缺陷只在按钮可用态）。
//
// 运行：node tests/unit/select-bar.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    openPanel, panelAction, panelBodyHtml, panelHtmlBuilt, panelRenderStats, panelState, setPanelHooks2, PANEL_ID,
} from '../../ui/panel.js';
import { SELECT_DEP_LABELS, selectDepButtonState, selectDepButtonParts, syncSelectButtons } from '../../ui/select-bar.js';

const R = makeReporter('select-bar v3.43.1 勾选后工具行按钮失效（D19 应-24）');
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 依赖勾选的三个动作（遍历用；表本身在 `ui/select-bar.js#SELECT_DEP_LABELS`） */
const DEP = ['bulkDelete', 'atomMergeSummary', 'plotSegmentSummarySel'];

/** 异步断言助手：**求值后再断言**（防「Promise 恒真」的假绿；见 tests/harness/st-mock.js 的防呆） */
async function A(name, fn, detail) {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
}

const doc = makeDocument([PANEL_ID, 'extensions_settings2']);
doc.body = { html: '', insertAdjacentHTML(pos, h) { this.html += String(h); }, addEventListener() { } };
const host = makeHost({});
installGlobalHost(host, doc);

const SEED = () => Object.assign(emptyState(), {
    atoms: [
        { id: 'a1', title: '情节一', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'] },
        { id: 'a2', title: '情节二', text: '乙在仓库清点货物，账目对不上（正文足够长）。', date: '1919-11-30', tags: ['仓库'] },
        { id: 'a3', title: '情节三', text: '丙在茶馆听到传闻，来源不明（正文足够长）。', date: '1919-12-01', tags: ['茶馆'] },
    ],
    currentStates: [{ id: 'c1', subject: '甲', field: '心情', value: '警觉' }],
    scenes: [{ id: 'sc1', name: '码头', pathArr: ['城外', '码头'] }, { id: 'sc2', name: '仓库', pathArr: ['城内', '仓库'] }],
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
/** 幂等置多选为开（`multiToggle` 是**切换**动作 → 必须先读当前态，否则用例间互相翻转） */
async function ensureMulti(kind) {
    if (panelState().multi[kind] !== true) await panelAction('multiToggle', { kind: kind });
    return panelState().multi[kind] === true;
}
/** 清空该维度勾选（`ps.sel` 跨用例保留 → 每个用例开头必须清，否则前一个用例的选择会串味） */
async function clearSel(kind) { await panelAction('selectNone', { kind: kind }); }

// ---------- 伪 DOM：把「刚渲染出来的 HTML」变成可遍历的按钮列表 ----------
//   面板桩（`tests/harness/st-mock.js#makeEl`）没有 `querySelectorAll`；这里在**测试内**补一个，
//   数据源 = `panelHtmlBuilt()`（真实渲染产物）→ 断言的是「真实 markup 被同步」，而不是另造一份。
const ATTR = (attrs, name) => {
    const m = new RegExp('\\s' + name + '="([^"]*)"').exec(String(attrs || ''));
    return m ? m[1] : '';
};
/** 解析渲染产物里「依赖勾选」的按钮 → 伪节点（`dataset` / `disabled` / `textContent`） */
function parseDepButtons(html) {
    const out = [];
    const re = /<button([^>]*\sdata-ftt-action="([^"]+)"[^>]*)>([^<]*)<\/button>/g;
    let m;
    while ((m = re.exec(String(html || '')))) {
        if (DEP.indexOf(m[2]) < 0) continue;
        out.push({
            dataset: { fttAction: m[2], kind: ATTR(m[1], 'data-kind') },
            disabled: /\sdisabled(=|"|\s|>|$)/.test(m[1]),
            textContent: String(m[3] || ''),
        });
    }
    return out;
}
/**
 * 给面板桩挂 `querySelectorAll` —— 模拟**真实 DOM 的节点同一性**：
 *   节点在「同一次渲染产物」内是**同一批对象**（改 `disabled` / `textContent` 会保留），
 *   只有整页重绘后才换新节点。若每次查询都新建对象，「局部同步」就永远观察不到 —— 那是假失败。
 */
function attachDom(el) {
    let lastHtml = null, cache = [];
    el.querySelectorAll = (sel) => {
        if (String(sel) !== '[data-ftt-action]') return [];
        const html = panelHtmlBuilt();
        if (html !== lastHtml) { lastHtml = html; cache = parseDepButtons(html); }
        return cache;
    };
    return el;
}
/** 面板上捕获的 `change` 委托（`bindOverlay` 幂等 → 只有一个） */
function changeListener(el) { return (el.listeners && el.listeners.change && el.listeners.change[0]) || null; }
/** 模拟一次复选框勾选/取消 —— 真实用户的**直接勾选**路径，不经 `selectAll` */
function fireSelect(el, kind, id, checked) {
    const fn = changeListener(el);
    if (typeof fn !== 'function') throw new Error('change 委托未绑定');
    fn({ target: { dataset: { fttSelect: String(kind), fttId: String(id) }, checked: !!checked, type: 'checkbox' } });
}
/** 取某动作按钮的当前（伪 DOM）状态（可按 kind 过滤） */
function btn(el, action, kind) {
    return (el.querySelectorAll('[data-ftt-action]') || [])
        .filter((b) => b.dataset.fttAction === action && (kind === undefined || b.dataset.kind === kind))[0] || null;
}

// ---------- E1：单一事实源 ----------
await A('E1 单一事实源：三个「依赖勾选」的动作全部登记在 `ui/select-bar.js#SELECT_DEP_LABELS`；未登记动作返回 null（= 不依赖勾选，同步时一律不碰）', () => {
    const okTable = DEP.every((a) => typeof SELECT_DEP_LABELS[a] === 'function');
    const unknown = ['selectAll', 'selectNone', 'multiToggle', 'delete', ''].every((a) => selectDepButtonState(a, 3) === null);
    return okTable && unknown && selectDepButtonState(null, 1) === null && selectDepButtonState(undefined, 1) === null;
}, Object.keys(SELECT_DEP_LABELS));

await A('E2 勾选数归一：undefined / null / NaN / 负数 / 非数字 → 0（disabled）；数字字符串与小数按数值取整；只有 0 才 disabled', () => {
    const z = (s) => selectDepButtonState('bulkDelete', s);
    const zero = [undefined, null, NaN, -1, '', 'abc'].every((s) => z(s).disabled === true && z(s).text === '🗑 删除选中（0）');
    const s3 = z('3'), s2 = z(2.7);
    return zero
        && s3.disabled === false && s3.text === '🗑 删除选中（3）'
        && s2.disabled === false && s2.text === '🗑 删除选中（2）'
        && selectDepButtonParts('bulkDelete', 0).attr === ' disabled'
        && selectDepButtonParts('bulkDelete', 1).attr === ''
        && selectDepButtonParts('bulkDelete', 0).text === z(0).text;
}, J([selectDepButtonState('bulkDelete', 0), selectDepButtonState('bulkDelete', 3)]));

// ---------- E3：渲染侧也用同一张表 ----------
await A('E3 渲染侧与同步侧同源：多选模式下 0 勾选渲染出的三个按钮，其文案与 disabled **逐字等于** `selectDepButtonState` 的返回值（不是就地拼字面量）', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    const bs = parseDepButtons(panelHtmlBuilt());
    const byAct = {};
    for (const b of bs) byAct[b.dataset.fttAction] = b;
    const expect = (a) => selectDepButtonState(a, 0);
    return bs.length === 3
        && DEP.every((a) => byAct[a] && byAct[a].textContent === expect(a).text && byAct[a].disabled === expect(a).disabled)
        && byAct.bulkDelete.textContent === '🗑 删除选中（0）'
        && byAct.atomMergeSummary.textContent === '🧷 情节总结（0）'
        && byAct.plotSegmentSummarySel.textContent === '🧩 分段总结（0）'
        && panelBodyHtml('atoms').length > 0;
}, '');

// ---------- E4：用户报告场景（核心回归） ----------
await A('E4 用户场景：多选模式下**只勾 1 条**（不经「全选」）→ 顶部「🗑 删除选中」「🧷 情节总结」「🧩 分段总结」当场变为可用、计数变 1（修复前：按钮停在渲染快照的 disabled + （0），点不动）', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    const beforeDel = btn(el, 'bulkDelete');
    const before = { disabled: beforeDel.disabled, text: beforeDel.textContent };
    fireSelect(el, 'atoms', 'a2', true);
    const afterDel = btn(el, 'bulkDelete'), afterMerge = btn(el, 'atomMergeSummary'), afterSeg = btn(el, 'plotSegmentSummarySel');
    return before.disabled === true && before.text === '🗑 删除选中（0）'
        && afterDel.disabled === false && afterDel.textContent === '🗑 删除选中（1）'
        && afterMerge.disabled === false && afterMerge.textContent === '🧷 情节总结（1）'
        && afterSeg.disabled === false && afterSeg.textContent === '🧩 分段总结（1）'
        && panelState().selCount === 1;
}, '');

await A('E5 勾选 → 取消勾选 → 回到 0：按钮**回到** disabled 且计数回 0（双向，不是只升不降）；再勾两条 → 计数为 2', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    fireSelect(el, 'atoms', 'a2', true);
    const one = btn(el, 'bulkDelete');
    const mid = { disabled: one.disabled, text: one.textContent };
    fireSelect(el, 'atoms', 'a2', false);
    const back = btn(el, 'bulkDelete');
    const off = { disabled: back.disabled, text: back.textContent };
    fireSelect(el, 'atoms', 'a1', true); fireSelect(el, 'atoms', 'a3', true);
    const two = btn(el, 'bulkDelete');
    return mid.disabled === false && mid.text === '🗑 删除选中（1）'
        && off.disabled === true && off.text === '🗑 删除选中（0）'
        && two.disabled === false && two.textContent === '🗑 删除选中（2）';
}, '');

await A('E6 勾选走**局部同步**、不整页重绘（`docs/D9` §5.2 第 5 条）：连勾 3 次后 `panelRenderStats().renders` 完全不变；`syncSelectButtons` 返回「实际更新了几个按钮」的实数，坏入参一律返回 0 而不抛', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    const r0 = panelRenderStats().renders;
    fireSelect(el, 'atoms', 'a1', true);
    const n1 = syncSelectButtons(el, () => 1);          // 直接调一次：应命中 3 个依赖勾选的按钮
    fireSelect(el, 'atoms', 'a2', true);
    fireSelect(el, 'atoms', 'a3', true);
    const r1 = panelRenderStats().renders;
    return r0 === r1 && n1 === 3
        && syncSelectButtons(null, () => 1) === 0          // 无根节点 → 0（不抛）
        && syncSelectButtons(el, null) === 0               // 无取数函数 → 0（不抛）
        && syncSelectButtons({ querySelectorAll() { throw new Error('boom'); } }, () => 1) === 0;   // DOM 抛错 → 0（不抛）
}, '');

await A('E7 同步只碰「依赖勾选」的按钮：`全选` / `清空选择` 的文案不被改动；未知动作的节点原样保留（`disabled` 与文案都不动）', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms');
    const html = panelHtmlBuilt();
    const untouched = ['selectAll', 'selectNone'].every((a) => html.indexOf('data-ftt-action="' + a + '"') >= 0);
    const stray = { dataset: { fttAction: 'sceneRepair', kind: 'atoms' }, disabled: true, textContent: '🔧 修复结构/用词' };
    const n = syncSelectButtons({ querySelectorAll: () => [stray] }, () => 5);
    return untouched && n === 0 && stray.disabled === true && stray.textContent === '🔧 修复结构/用词';
}, '');

// ---------- E8：各页都覆盖（列表页 / 状态页 / 场景树） ----------
await A('E8 覆盖面：`states` 页与 `scenes` 场景树用的是**同一个** `ui/select-bar.js`（文案与 disabled 等于 `selectDepButtonState`），勾选后同步同样生效', async () => {
    // 状态页（`ui/panel.js#statesBody`）
    const el1 = attachDom(boot('states'));
    await ensureMulti('states'); await clearSel('states');
    const stOff = btn(el1, 'bulkDelete', 'states');
    const stOk = !!stOff && stOff.disabled === true && stOff.textContent === '🗑 删除选中（0）';
    fireSelect(el1, 'states', 'c1', true);
    const stOn = btn(el1, 'bulkDelete', 'states');
    const stSynced = !!stOn && stOn.disabled === false && stOn.textContent === '🗑 删除选中（1）';
    // 场景树（`ui/scene-tree.js`）
    const el2 = attachDom(boot('scenes'));
    await ensureMulti('scenes'); await clearSel('scenes');
    const scOff = btn(el2, 'bulkDelete', 'scenes');
    const scOk = !!scOff && scOff.disabled === true && scOff.textContent === '🗑 删除选中（0）';
    fireSelect(el2, 'scenes', 'sc1', true);
    const scOn = btn(el2, 'bulkDelete', 'scenes');
    const scSynced = !!scOn && scOn.disabled === false && scOn.textContent === '🗑 删除选中（1）';
    return stOk && stSynced && scOk && scSynced;
}, J(['states', 'scenes']));

// ---------- E9 / E10：数据通路本来就是对的（缺陷只在按钮可用态） ----------
await A('E9 直接勾选后 `bulkDelete` 的真实数据路径：只删勾中的那 1 条（其余保留 + 留墓碑）—— 证明修复前「按钮无效」纯属可用态问题，不是删除逻辑坏', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    fireSelect(el, 'atoms', 'a2', true);
    const r = await panelAction('bulkDelete', { kind: 'atoms' });
    return r && r.ok === true && r.deleted === 1;
}, '');

await A('E10 端到端：勾 1 条后按钮**真的可点**（`disabled === false`）→ 动作被受理并返回 ok；勾选本身不放行未勾中的条目', async () => {
    const el = attachDom(boot('atoms'));
    await ensureMulti('atoms'); await clearSel('atoms');
    fireSelect(el, 'atoms', 'a1', true);
    const b = btn(el, 'bulkDelete');
    const clickable = !!b && b.disabled === false;
    const r = await panelAction('bulkDelete', { kind: 'atoms' });
    return clickable && r && r.ok === true && r.deleted === 1;
}, '');

R.done();
