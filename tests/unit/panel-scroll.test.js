// ============================================================
// 单元测试 · v2.38.0「点击不跳顶（对齐 V1 修复）」
// 背景（用户要求）：「按钮点击不能突然置顶，之前 V1 修复过该问题。V2 请对齐，点击后不能跳顶。」
// V1 的修复（v1.206）：
//   ① `renderPanel()` 26507~26536：重渲染**前**记录滚动位置（面板 + **当前活动标签**的 `.ftt-body[data-ftt-body=…]`），
//      渲染后恢复；同处给所有 `<button>` 补 `type="button"`（26525）—— 无 type 的按钮在 form 内是 submit → 跳顶/刷新；
//      并明确注释「不能用 querySelector('.ftt-body') 取第一个（=总览）」（长列表页删除后跳顶的根因）。
//   ② 切页/切子标签 26083/26166：记录 `.ftt-tabs` / `.ftt-subtabs` 的 `scrollLeft` + 面板滚动，rAF 后恢复；
//      并在点击入口 `preventDefault()/stopPropagation()`（26075~26078，仅对 button/a/[data-ftt-action]）。
// 覆盖：
//   B 组：`ensureButtonTypes` 字符串层补 type（含已带 type/大小写/多按钮）；
//   S 组：`panelScrollState` / `applyPanelScroll` 捕获与回写（面板、模态、标签条、**活动标签内容区**）；
//   R 组：`renderPanel()` 端到端 —— 模拟「innerHTML 替换 → 滚动归零」的 DOM 影子，断言渲染后**活动标签**内容区
//         滚动被恢复、第一个 `.ftt-body`（总览）不被误写、标签条横向位置恢复；非 0 才写（不把未滚动容器置 0）；
//   C 组：点击入口 —— 点在 button/a/[data-ftt-action] 上 preventDefault+stopPropagation；`<label>` 上不拦截；
//         点在内层 `<span>` 上也能触发父按钮动作（`closest('[data-ftt-action]')` 兜底）。
// 运行：node tests/unit/panel-scroll.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    panelAction, panelBodyHtml, panelState, openPanel, renderPanel,
    panelScrollState, applyPanelScroll, ensureButtonTypes, bindOverlay, setPanelHooks2,
} from '../../ui/panel.js';

const R = makeReporter('panel-scroll v2.38.0 点击不跳顶');
const A = (n, c, e) => R.assert(n, !!c, e);

const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const host = makeHost({});
const doc = makeDocument(['extensions_settings2']);

/**
 * DOM 影子：模拟真实面板元素 ——
 *   · `querySelector` 只支持本测试用到的选择器（与 ui/panel.js 使用的一致）；
 *   · `innerHTML = …` 表示「重渲染」→ **把所有滚动位置归零**（真实浏览器的行为）。
 */
function makeFakePanel(init) {
    const o = init || {};
    const scroll = {
        panel: Number(o.panel) || 0, modal: Number(o.modal) || 0, tabs: Number(o.tabs) || 0, subs: Number(o.subs) || 0,
        bodies: Object.assign({}, o.bodies || {}),
    };
    const nodes = {
        modal: { get scrollTop() { return scroll.modal; }, set scrollTop(v) { scroll.modal = Number(v) || 0; } },
        tabs: { get scrollLeft() { return scroll.tabs; }, set scrollLeft(v) { scroll.tabs = Number(v) || 0; } },
        subs: { get scrollLeft() { return scroll.subs; }, set scrollLeft(v) { scroll.subs = Number(v) || 0; } },
    };
    const bodyNode = (tab) => {
        if (!nodes['body:' + tab]) {
            nodes['body:' + tab] = {
                get scrollTop() { return scroll.bodies[tab] || 0; },
                set scrollTop(v) { scroll.bodies[tab] = Number(v) || 0; },
            };
        }
        return nodes['body:' + tab];
    };
    const el = {
        id: 'ftt-panel',
        style: { setProperty() { }, getPropertyValue() { return ''; } },
        _html: '',
        listeners: {},
        scroll,
        get scrollTop() { return scroll.panel; },
        set scrollTop(v) { scroll.panel = Number(v) || 0; },
        classList: { add() { }, remove() { }, contains() { return true; } },
        parentNode: { removeChild() { return true; } },
        get innerHTML() { return this._html; },
        set innerHTML(v) {
            this._html = String(v);
            // 重渲染：真实浏览器会重建子树 → 所有滚动位置归零（这正是「跳顶」的成因）
            scroll.panel = 0; scroll.modal = 0; scroll.tabs = 0; scroll.subs = 0;
            const zeroed = {};
            Object.keys(scroll.bodies).forEach((k) => { zeroed[k] = 0; });
            scroll.bodies = zeroed;
        },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener() { },
        querySelector(sel) {
            if (sel === '.ftt-modal') return nodes.modal;
            if (sel === '.ftt-tabs') return nodes.tabs;
            if (sel === '.ftt-subtabs') return nodes.subs;
            let m = /^\.ftt-body\[data-ftt-body="([^"]*)"\]$/.exec(String(sel));
            if (m) return bodyNode(m[1]);
            if (sel === '.ftt-body') return bodyNode(this._firstBodyTab || 'overview');
            return null;
        },
        querySelectorAll(sel) {
            // 只支持 button（用于 hardenButtonTypes 的断言）
            if (String(sel) !== 'button') return [];
            const out = [];
            const html = this._html || '';
            const re = /<button\b([^>]*)>/gi;
            let mm;
            while ((mm = re.exec(html)) !== null) {
                const attrs = String(mm[1] || '');
                if (/\btype=/.test(attrs)) continue;   // 已有 type 的不需要补
                out.push({ _attrs: attrs, getAttribute: () => null, setAttribute(k, v) { if (k === 'type') this._type = v; } });
            }
            return out;
        },
    };
    return el;
}

function installFakePanel(init) {
    const el = makeFakePanel(init);
    doc._els['ftt-panel'] = el;
    return el;
}
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
const un = installGlobalHost(host, doc);

// ---------- B 组：按钮 type 兜底 ----------
A('B1 `ensureButtonTypes` 给无 type 的按钮补 `type="button"`（多按钮/带属性/大小写/自闭合式），已有 type 的不动', (() => {
    const src = '<div><button class="ftt-btn" data-ftt-action="x">A</button><button type="submit">B</button>'
        + '<BUTTON class="y">C</BUTTON><button>D</button><span>E</span></div>';
    const out = ensureButtonTypes(src);
    const n = (out.match(/type="button"/g) || []).length;
    return n === 3 && out.indexOf('<button type="button" class="ftt-btn" data-ftt-action="x">A</button>') >= 0
        && out.indexOf('<button type="submit">B</button>') >= 0
        && out.indexOf('<BUTTON type="button" class="y">C</BUTTON>') >= 0
        && out.indexOf('<button type="button">D</button>') >= 0
        && ensureButtonTypes('').length === 0 && ensureButtonTypes(null).length === 0
        // 面板真实 HTML 里所有按钮都带上 type（字符串层即生效，桩宿主也安全）
        // 面板真实 HTML（以「情节」页为例）在字符串层即被补齐（桩宿主也能生效）
        && (() => { const raw = panelBodyHtml('atoms'); const h = ensureButtonTypes(raw); return (raw.match(/<button/g) || []).length >= 3 && h.indexOf('<button type="button"') >= 0 && !/<button(?![^>]*\stype=)[^>]*>/.test(h); })();
})(), null);

// ---------- S 组：滚动状态捕获/回写 ----------
A('S1 `panelScrollState` 捕获：面板+模态+标签条+子标签条+**当前活动标签**的内容区（不是第一个 .ftt-body）', (() => {
    const el = installFakePanel({ panel: 12, modal: 34, tabs: 56, subs: 78, bodies: { overview: 999, plans: 321 } });
    boot(); openPanel('plans');
    const st = panelScrollState(el);
    return st.p === 12 && st.modal === 34 && st.tabs === 56 && st.subs === 78 && st.b === 321 && st.tab === 'plans';
})(), null);

A('S2 `applyPanelScroll` 回写到同一批容器；值为 0 时不写（不把未滚动容器显式置 0）', (() => {
    const el = installFakePanel({ panel: 0, modal: 0, tabs: 0, subs: 0, bodies: { plans: 0 } });
    boot(); openPanel('plans');
    applyPanelScroll(el, { p: 0, modal: 0, tabs: 0, subs: 0, b: 0, tab: 'plans' });
    const untouched = el.scroll.panel === 0 && el.scroll.tabs === 0 && el.scroll.bodies.overview === undefined;
    applyPanelScroll(el, { p: 5, modal: 6, tabs: 7, subs: 8, b: 9, tab: 'plans' });
    return untouched && el.scroll.panel === 5 && el.scroll.modal === 6 && el.scroll.tabs === 7 && el.scroll.subs === 8 && el.scroll.bodies.plans === 9;
})(), null);

// ---------- R 组：renderPanel 端到端 ----------
A('R1 `renderPanel()`：重渲染（滚动归零）后，**活动标签**内容区与标签条位置被恢复 —— 点击按钮不再跳顶', (() => {
    const el = installFakePanel({ tabs: 40, bodies: { overview: 777, plans: 420 } });
    boot(); openPanel('plans');
    el.scroll.bodies.plans = 420; el.scroll.tabs = 40; el.scroll.panel = 15;
    renderPanel();
    const st = el.scroll;
    return st.bodies.plans === 420 && st.tabs === 40 && st.panel === 15
        // 关键（V1 注释中点明的坑）：**不能**把第一个 .ftt-body（总览）当成恢复目标
        && (st.bodies.overview || 0) === 0 && (el.innerHTML || '').indexOf('data-ftt-body="plans"') >= 0;
})(), null);

const R2 = await (async () => {
    const el = installFakePanel({ bodies: { overview: 111, atoms: 222 } });
    boot(); openPanel('overview');
    el.scroll.bodies.overview = 111;
    renderPanel();
    const firstOk = el.scroll.bodies.overview === 111;
    // 切到情节页（重渲染 → 滚动归零）→ 恢复目标随之切换为活动标签内容区
    await panelAction('tab', { tab: 'atoms' });
    el.scroll.bodies.atoms = 222;
    renderPanel();
    return firstOk && el.scroll.bodies.atoms === 222 && panelState().tab === 'atoms'
        && String(el.innerHTML).indexOf('data-ftt-body="atoms"') >= 0;
})();
A('R2 `renderPanel()` 端到端：切到另一标签后，恢复目标随之切换（活动标签内容区），且面板 HTML 每次都重新生成', R2, null);

A('R3 `renderPanel()` 在无 `querySelector` 的桩宿主下安全：不抛错、HTML 仍写入、按钮 type 已补', (() => {
    doc._els['ftt-panel'] = { id: 'ftt-panel', html: '', insertAdjacentHTML() { }, addEventListener() { }, classList: { add() { }, remove() { } } };
    boot(); openPanel('overview');
    let threw = '';
    let html = '';
    try { html = String(renderPanel() || ''); } catch (e) { threw = String(e.message || e); }
    const st = panelScrollState(doc._els['ftt-panel']);
    return threw === '' && html.indexOf('<button type="button"') >= 0 && st.p === 0 && st.b === 0 && applyPanelScroll(doc._els['ftt-panel'], st) === true;
})(), null);

// ---------- C 组：点击入口 ----------
A('C1 点击入口 `preventDefault()` + `stopPropagation()`：仅对 `button / a / [data-ftt-action]` 生效；`<label>`（开关）不拦截', (() => {
    const el = installFakePanel({});
    doc._els['ftt-panel'] = el;
    boot(); openPanel('overview');
    bindOverlay();
    const click = el.listeners.click || [];
    const fire = (target) => {
        const rec = { pd: 0, sp: 0 };
        const ev = {
            target,
            preventDefault() { rec.pd += 1; },
            stopPropagation() { rec.sp += 1; },
        };
        click.forEach((fn) => fn(ev));
        return rec;
    };
    const btn = { dataset: { fttAction: 'noop' }, closest: (sel) => (String(sel).indexOf('button') >= 0 || sel === '[data-ftt-action]' ? btn : null) };
    const r1 = fire(btn);
    const label = { dataset: {}, closest: () => null };
    const r2 = fire(label);
    const bare = { dataset: {}, closest: () => null };   // 点空白处（tg === el 时关闭面板，此处仅断言不拦截）
    const r3 = fire(bare);
    return click.length > 0 && r1.pd === 1 && r1.sp === 1 && r2.pd === 0 && r2.sp === 0 && r3.pd === 0;
})(), null);

const C2 = await (async () => {
    const el = installFakePanel({});
    doc._els['ftt-panel'] = el;
    boot(); openPanel('settings');
    bindOverlay();
    const click = el.listeners.click || [];
    // 记录面板收到的动作（注入 hook 便于断言）
    const seen = [];
    setPanelHooks2({ dimToggle: (kind, on) => { seen.push({ kind, on }); } });
    const parent = {
        dataset: { fttAction: 'dimToggle', kind: 'atoms', id: '', floor: '', subject: '' },
        dataset2: null,
    };
    parent.closest = (sel) => (sel === '[data-ftt-action]' ? parent : (sel === 'button, a, [data-ftt-action]' ? parent : null));
    const inner = { dataset: {}, closest: (sel) => parent.closest(sel) };
    click.forEach((fn) => fn({ target: inner, preventDefault() { }, stopPropagation() { } }));
    await new Promise((r) => setTimeout(r, 0));
    setPanelHooks2({});
    // 点击委托不带 `on`（开关态由 change 事件给出）→ 这里只断言「动作与参数被正确解析到父按钮」
    return seen.length === 1 && seen[0].kind === 'atoms' && seen[0].on === false;
})();
A('C2 点在内层元素（按钮里的 `<span>`）也能触发父按钮动作：`closest(\'[data-ftt-action]\')` 兜底解析动作与参数', C2, null);

un();
R.done();
