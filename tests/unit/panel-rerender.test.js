// ============================================================
// 单元测试 · v2.80.1「每次点击按钮，插件页面会闪一下」修复
//
// 用户报告（原话）：「每次点击按钮，插件页面会闪一下，请修复该问题。」
//
// 根因（已核实）：
//   `ui/panel.js#panelAction()` 每次动作结束都调 `renderPanel()`（`:2163`），而 `renderPanel()` 此前是
//   **整树替换** `#ftt-panel` 的 `innerHTML`（`:1252`）→ `.ftt-modal` 节点被销毁重建 →
//   CSS 入场动画 `#ftt-panel .ftt-modal { animation: fttModalIn .22s … both }`（`style.css:404`）
//   **每次点击都重放**（opacity 0 → 1、translateY(10px) → 0）= 用户看到的「闪一下」。
//
// 修复口径（v2.80.1）：
//   ① `panelHtml()` 拆出 `panelModalInnerHtml()`（返回模态**内部** HTML），`panelHtml()` 仍返回完整浮层
//      （外部接口与既有测试口径逐字节不变）；
//   ② `renderPanel()` **复用既有 `.ftt-modal` 节点**，只替换其内部 → 节点不重建 → 入场动画不重放；
//   ③ 仅在「已有可写模态节点」时走复用路径：首次打开 / 关闭后再打开 / 桩 DOM 一律回落整树替换，
//      于是「打开面板的入场动画」仍然保留（动效只应出现在打开时）。
//
// 覆盖：
//   A 组：节点复用（同一对象）· 覆盖层不再整树替换 · 复用路径内容与 `panelHtml()` 一致；
//   B 组：真实点击路径（`panelAction`）连续多次 → 模态始终复用；
//   C 组：关闭后再打开 → 回到整树替换（入场动画保留）；无模态 / 桩 DOM → 安全回落；
//   D 组：复用路径下滚动恢复仍生效；CSS 入场动画确实只挂在 `.ftt-modal` 上（修复的因果链）。
// 运行：node tests/unit/panel-rerender.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    panelHtml, panelModalInnerHtml, ensureButtonTypes, renderPanel, openPanel, closePanel, panelAction, setPanelHooks2,
} from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('panel-rerender v2.80.1 点击不再闪一下');
/** 异步断言助手：求值后再断言（防「Promise 恒真」的假绿） */
async function A(name, cond, detail) {
    let ok = false, extra = detail;
    try { ok = await cond; } catch (e) { ok = false; extra = String((e && e.message) || e); }
    R.assert(name, ok === true, extra);
}
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

/**
 * DOM 影子：建模真实浏览器的两条关键行为 ——
 *   ① `el.innerHTML = html`：整树替换 → 旧 `.ftt-modal` **销毁**，新模态由新记号创建；
 *   ② `modal.innerHTML = inner`：**复用同一模态对象**（这正是「入场动画不重放」的物理前提）。
 * 计数 `panelWrites` / `modalWrites` 用于断言走了哪条路径。
 */
function makeFakePanel(opts) {
    const o = opts || {};
    const stats = { panelWrites: 0, modalWrites: 0 };
    const scroll = { panel: Number(o.panel) || 0, tabs: Number(o.tabs) || 0, subs: 0, bodies: Object.assign({}, o.bodies || {}) };
    const tabsNode = { get scrollLeft() { return scroll.tabs; }, set scrollLeft(v) { scroll.tabs = Number(v) || 0; } };
    const subsNode = { get scrollLeft() { return scroll.subs; }, set scrollLeft(v) { scroll.subs = Number(v) || 0; } };
    const bodyNode = (tab) => ({
        get scrollTop() { return scroll.bodies[tab] || 0; },
        set scrollTop(v) { scroll.bodies[tab] = Number(v) || 0; },
    });
    const zeroBodies = () => { Object.keys(scroll.bodies).forEach((k) => { scroll.bodies[k] = 0; }); };
    const makeModal = () => ({
        _h: '',
        classList: { contains(c) { return String(c) === 'ftt-modal'; } },
        get innerHTML() { return this._h; },
        set innerHTML(v) {
            this._h = String(v);
            stats.modalWrites++;
            zeroBodies();                 // 内部子树重建 → 内容区滚动归零（随后由 renderPanel 恢复）
        },
        get scrollTop() { return 0; },
        set scrollTop(_v) { },
    });
    let modal = null;
    const el = {
        id: 'ftt-panel',
        _stats: stats,
        _scroll: scroll,
        style: { setProperty() { }, getPropertyValue() { return ''; } },
        classList: { add() { }, remove() { }, contains() { return true; } },
        parentNode: { removeChild() { return true; } },
        listeners: {},
        get scrollTop() { return scroll.panel; },
        set scrollTop(v) { scroll.panel = Number(v) || 0; },
        get innerHTML() { return modal ? ('<div class="ftt-modal">' + modal._h + '</div>') : ''; },
        set innerHTML(v) {
            const html = String(v);
            stats.panelWrites++;
            modal = /class="ftt-modal"/.test(html) ? makeModal() : null;
            if (modal) {
                const open = '<div class="ftt-modal">';
                const i = html.indexOf(open);
                modal._h = (i >= 0) ? html.slice(i + open.length, html.lastIndexOf('</div>')) : '';
            }
            zeroBodies();
            scroll.panel = 0;
        },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener() { },
        querySelector(sel) {
            if (sel === '.ftt-modal') return modal;
            if (sel === '.ftt-tabs') return tabsNode;
            if (sel === '.ftt-subtabs') return subsNode;
            const m = /^\.ftt-body\[data-ftt-body="([^"]*)"\]$/.exec(String(sel));
            if (m) return bodyNode(m[1]);
            if (sel === '.ftt-body') return bodyNode('overview');
            return null;
        },
        querySelectorAll() { return []; },
    };
    return el;
}

const host = makeHost({});
const doc = makeDocument(['extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const uninstall = installGlobalHost(host, doc);
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true },
});

let fake = null;
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:rerender');
    setLastMessageId(3);
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
    fake = makeFakePanel({ bodies: { overview: 0 }, panel: 0 });
    doc._els['ftt-panel'] = fake;
    return fake;
}

// ---------- A 组：节点复用 ----------
await A('A1 首次渲染走**整树替换**（创建 `.ftt-modal`）：打开面板时应有的行为', (() => {
    boot();
    openPanel('overview');
    return fake._stats.panelWrites === 1 && fake._stats.modalWrites === 0
        && !!fake.querySelector('.ftt-modal') && fake.querySelector('.ftt-modal').innerHTML.length > 100;
})(), () => J(fake._stats));

await A('A2 **关键修复**：再次渲染复用**同一个** `.ftt-modal` 节点（覆盖层不再整树替换）→ CSS 入场动画不会重放', (() => {
    const before = fake.querySelector('.ftt-modal');
    const writes = fake._stats.panelWrites;
    renderPanel();
    const after = fake.querySelector('.ftt-modal');
    return after === before                              // 节点对象同一 → 动画不重放
        && fake._stats.panelWrites === writes            // 覆盖层未被再次替换
        && fake._stats.modalWrites === 1;                // 只写了模态内部
})(), () => J(fake._stats));

await A('A3 复用路径产出的内容与 `panelHtml()` 完全一致（拆分不改口径）', (() => {
    renderPanel();
    const inner = fake.querySelector('.ftt-modal').innerHTML;
    // 两条路径（复用节点 / 整树替换）写入的内容必须一致：字符串层 type 补全后的模态内部
    return inner === ensureButtonTypes(panelModalInnerHtml())
        && ('<div class="ftt-modal">' + inner + '</div>') === ensureButtonTypes(panelHtml());
})(), () => ({ inner: fake.querySelector('.ftt-modal').innerHTML.slice(0, 80) }));

await A('A4 `panelHtml()` 仍是完整浮层（外层包 `<div class="ftt-modal">`）：外部接口与既有测试口径不变', (() => {
    const h = panelHtml();
    return h.indexOf('<div class="ftt-modal">') === 0 && h.lastIndexOf('</div>') === h.length - 6
        && h === ('<div class="ftt-modal">' + panelModalInnerHtml() + '</div>');
})(), () => panelHtml().slice(0, 60));

// ---------- B 组：真实点击路径 ----------
await A('B1 连续点击（`panelAction` ×6，每次动作后都会重渲染）→ 模态节点**始终是同一个**，覆盖层只被替换过一次', (async () => {
    boot();
    openPanel('overview');
    const first = fake.querySelector('.ftt-modal');
    const panelWrites0 = fake._stats.panelWrites;
    for (const act of [['tab', { tab: 'atoms' }], ['tab', { tab: 'memories' }], ['tab', { tab: 'states' }],
        ['search', { kind: 'memories', q: '甲' }], ['searchClear', { searchKind: 'memories' }], ['tab', { tab: 'settings' }]]) {
        await panelAction(act[0], act[1]);
        if (fake.querySelector('.ftt-modal') !== first) return false;
    }
    return fake._stats.panelWrites === panelWrites0 && fake._stats.modalWrites === 6
        && fake.querySelector('.ftt-modal') === first;
})(), () => J({ stats: fake._stats, same: !!fake.querySelector('.ftt-modal') }));

await A('B2 复用路径下切页内容真的换了（不是「省的没渲染」）：总览与情节正文都出现且互不相同', (async () => {
    boot();
    openPanel('overview');
    await panelAction('tab', { tab: 'overview' });
    const ov = fake.querySelector('.ftt-modal').innerHTML;
    await panelAction('tab', { tab: 'atoms' });
    const at = fake.querySelector('.ftt-modal').innerHTML;
    return ov !== at && ov.indexOf('data-ftt-body="overview"') >= 0 && at.indexOf('data-ftt-body="atoms"') >= 0
        && at.indexOf('ftt-on" data-ftt-tab="atoms"') >= 0;
})(), () => ({ same: null }));

// ---------- C 组：打开/关闭与回落 ----------
await A('C1 关闭后再打开 → 回到整树替换（模态被重建）：入场动画保留在「打开」这一次', (() => {
    boot();
    openPanel('overview');
    const first = fake.querySelector('.ftt-modal');
    const w1 = fake._stats.panelWrites;                 // 首次打开 = 1 次整树替换
    closePanel();                                       // 关闭 = 清空（也计一次写入）
    const gone = fake.querySelector('.ftt-modal') === null;
    openPanel('overview');                              // 再打开 = 又一次整树替换（模态重建 → 入场动画重放）
    const second = fake.querySelector('.ftt-modal');
    return gone && !!second && second !== first && w1 === 1 && fake._stats.panelWrites === 3;
})(), () => J(fake._stats));

await A('C2 无 `.ftt-modal` 的环境（桩 DOM / 受限宿主）→ 安全回落整树替换，不抛错', (() => {
    const plain = makeDocument(['ftt-panel2']);
    const el2 = plain.getElementById('ftt-panel2');   // 桩元素：无 querySelector('.ftt-modal')
    el2.querySelector = () => null;
    doc._els['ftt-panel'] = el2;
    const html = renderPanel();
    const ok = typeof html === 'string' && html.indexOf('<div class="ftt-modal">') === 0;
    boot();                                            // 还原
    return ok;
})(), () => 'fallback');

await A('C3 模态节点存在但**不可写**（部分宿主 / 伪节点）→ 也回落整树替换（判定严格：必须可写 innerHTML）', (() => {
    boot();
    openPanel('overview');
    const writes = fake._stats.panelWrites;
    // 把模态换成不可写节点（innerHTML 非字符串）
    fake.querySelector = (sel) => (sel === '.ftt-modal' ? { innerHTML: undefined } : null);
    renderPanel();
    return fake._stats.panelWrites === writes + 1;
})(), () => J(fake._stats));

// ---------- D 组：滚动恢复与 CSS 因果 ----------
await A('D1 复用路径下**滚动恢复仍生效**：活动标签内容区滚动位置在重渲染后被写回', (() => {
    boot();
    fake._scroll.bodies.overview = 42;
    openPanel('overview');
    fake._scroll.bodies.overview = 42;                 // 打开后人为滚动
    renderPanel();                                     // 重建模态内部（影子会把滚动归零）
    return fake._scroll.bodies.overview === 42;
})(), () => J(fake._scroll.bodies));

await A('D2 因果链自证：`style.css` 的入场动画确实挂在 `.ftt-modal` 上（所以「节点不重建 = 动画不重放」）', (() => {
    const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
    return /#ftt-panel\s+\.ftt-modal\s*\{\s*animation:\s*fttModalIn/.test(css)
        && /@keyframes\s+fttModalIn\s*\{\s*from\s*\{\s*opacity:\s*0/.test(css);
})(), () => 'see-style.css');

uninstall();
R.done();
