// ============================================================
// 单元测试 · v3.43.0 `docs/D22` `应-10` —— **补齐 WAI-ARIA tabs 最小可用集**（`docs/D9` §10 U8）
//
// 缺陷（`docs/D19` §2 K9）：页签只有 `role="tab"` + `aria-selected`，**没有 `tabindex` 管理、没有左右方向键** ——
//   键盘用户 Tab 进标签条后只能一路 Tab 穿过 13 个页签，且读屏不知道"当前页签是唯一可停靠点"。
//
// 本批（**纯新增属性 + 键盘处理，不改类名与 DOM 层级**）：
//   ① 选中页签 `tabindex="0"`、其余 `tabindex="-1"`；标签条带 `aria-label` + `data-ftt-tablist` 标记；
//   ② `←/→` 循环切换、`Home/End` 跳首尾；切换走**既有 `panelAction('tab')`**（与点击同一条路径），
//      并把焦点移入新选中页签（重绘后重新查询节点）。
//
// 运行：node tests/unit/panel-aria-tabs.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setLoadPhase } from '../../core/model/runtime.js';
import { PANEL_TABS, panelModalInnerHtml, panelAction, panelState, setPanelHooks2, openPanel, tabArrowKey, bindEscClose } from '../../ui/panel.js';

const R = makeReporter('panel-aria-tabs v3.43.0 页签键盘可达性（D22 应-10）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 桩宿主 + 可用的 document（够 `tabArrowKey` / `bindEscClose` 用） ----------
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
installGlobalHost(host, doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 页签节点桩（`closest` / `getAttribute` / `focus` 齐备） */
function tabNode(id) {
    const attrs = { 'data-ftt-tab': String(id) };
    return {
        _id: String(id), _focused: false,
        getAttribute(k) { return attrs[k] === undefined ? null : attrs[k]; },
        closest(sel) { return sel === '[data-ftt-tab]' ? this : null; },
        focus() { this._focused = true; },
        setAttribute(k, v) { attrs[k] = v; },
    };
}
/** `keydown` 监听器只绑一次（`escBound` 是模块级标记）→ 全测试共用一个累计表 */
const allListeners = [];
doc.addEventListener = (type, fn) => { allListeners.push({ type: type, fn: fn }); };
/** 装一套"标签条"到 document 上（`querySelectorAll` 只认标签条选择器；`querySelector` 按 data-ftt-tab 命中） */
function installTabs(ids, activeId) {
    const nodes = ids.map(tabNode);
    doc.querySelectorAll = (sel) => (/data-ftt-tablist.*data-ftt-tab|\[data-ftt-tab\]/.test(String(sel)) ? nodes : []);
    doc.querySelector = (sel) => {
        const m = String(sel).match(/data-ftt-tab="([^"]+)"/);
        if (m) return nodes.filter((n) => n._id === m[1])[0] || null;
        if (String(sel).indexOf('data-ftt-tablist') >= 0) return nodes[0] || null;
        return null;
    };
    const cur = nodes.filter((n) => n._id === activeId)[0] || nodes[0];
    return { nodes: nodes, cur: cur };
}
/** 标签条 HTML 片段（供属性断言用） */
function tabHtmlOf(html) {
    const s = String(html);
    const i = s.indexOf('<div class="ftt-tabs');
    return i < 0 ? '' : s.slice(i, s.indexOf('</div>', i));
}
/** 造一个键盘事件（`preventDefault` / `stopPropagation` 记录调用） */
function keyEvent(key, target) {
    const ev = { key: key, target: target, _pd: 0, _sp: 0 };
    ev.preventDefault = () => { ev._pd += 1; };
    ev.stopPropagation = () => { ev._sp += 1; };
    return ev;
}
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(emptyState());
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    try { setLoadPhase('ready'); } catch (e) { /* 忽略 */ }
    openPanel('overview');
}

// ============================================================
// T 组：渲染层（属性齐备、类名与结构不变）
// ============================================================
A('T1 选中页签 `tabindex="0"`、其余 `tabindex="-1"`；标签条带 `aria-label` 与 `data-ftt-tablist` 标记',
    (() => {
        boot();
        const tabHtml = tabHtmlOf(panelModalInnerHtml({ tab: 'overview' }));
        const zero = (tabHtml.match(/tabindex="0"/g) || []).length;
        const minus = (tabHtml.match(/tabindex="-1"/g) || []).length;
        return tabHtml.indexOf('role="tablist"') >= 0 && tabHtml.indexOf('aria-label="FTT记忆组件分页"') >= 0
            && tabHtml.indexOf('data-ftt-tablist="1"') >= 0
            && zero === 1 && minus === PANEL_TABS.length - 1
            && tabHtml.indexOf('aria-selected="true"') >= 0
            && /data-ftt-tab="overview"[^>]*tabindex="0"/.test(tabHtml);
    })(), (() => {
        const tabHtml = tabHtmlOf(panelModalInnerHtml({ tab: 'overview' }));
        return J({ zero: (tabHtml.match(/tabindex="0"/g) || []).length, minus: (tabHtml.match(/tabindex="-1"/g) || []).length, tabs: PANEL_TABS.length });
    })());

A('T2 切到别的页签时 `tabindex` 跟着走（仍是"恰好一个 0"），类名与结构不变（`.ftt-tab` + `data-ftt-tab` 数量一致）',
    (() => {
        boot();
        return panelAction('tab', { tab: 'settings' }).then(() => {
            const tabHtml = tabHtmlOf(panelModalInnerHtml({ tab: 'settings' }));
            const cls = (tabHtml.match(/class="ftt-tab/g) || []).length;
            const data = (tabHtml.match(/data-ftt-tab="/g) || []).length;
            return (tabHtml.match(/tabindex="0"/g) || []).length === 1
                && /data-ftt-tab="settings"[^>]*tabindex="0"/.test(tabHtml)
                && cls === PANEL_TABS.length && data === PANEL_TABS.length;
        });
    })(), '见断言');

// ============================================================
// K 组：键盘行为
// ============================================================
A('K1 `→` 从当前页签切到下一个，`panelAction(\'tab\')` 生效（`panelState().tab` 跟着变）、焦点移入新页签、阻止默认行为',
    (() => {
        boot();
        const ids = PANEL_TABS.map((x) => x[0]);
        const t = installTabs(ids, 'overview');
        const ev = keyEvent('ArrowRight', t.cur);
        const consumed = tabArrowKey(ev);
        const nextId = ids[1];
        const moved = t.nodes.filter((n) => n._id === nextId)[0];
        return consumed === true && panelState().tab === nextId && moved && moved._focused === true
            && ev._pd === 1 && ev._sp === 1;
    })(), J({ tab: panelState().tab }));

A('K2 `←` 从首个页签**循环**到末个（`Home` → 首个、`End` → 末个）',
    (() => {
        boot();
        const ids = PANEL_TABS.map((x) => x[0]);
        let t = installTabs(ids, ids[0]);
        const left = tabArrowKey(keyEvent('ArrowLeft', t.cur));
        const wrapOk = left === true && panelState().tab === ids[ids.length - 1];
        boot();
        t = installTabs(ids, ids[3]);
        tabArrowKey(keyEvent('End', t.cur));
        const endOk = panelState().tab === ids[ids.length - 1];
        boot();
        t = installTabs(ids, ids[5]);
        tabArrowKey(keyEvent('Home', t.cur));
        const homeOk = panelState().tab === ids[0];
        return wrapOk && endOk && homeOk;
    })(), J({ tab: panelState().tab }));

A('K3 焦点**不在页签**上时不拦截（非页签元素的左右键、以及非方向键一律返回 false 且不动页签）',
    (() => {
        boot();
        const ids = PANEL_TABS.map((x) => x[0]);
        const t = installTabs(ids, 'overview');
        const before = panelState().tab;
        const outside = { closest: () => null };
        const r1 = tabArrowKey(keyEvent('ArrowRight', outside));
        const r2 = tabArrowKey(keyEvent('a', t.cur));
        const r3 = tabArrowKey(null);
        return r1 === false && r2 === false && r3 === false && panelState().tab === before;
    })(), J({ tab: panelState().tab }));

A('K4 `bindEscClose` 注册的监听器同时处理 Esc 与方向键（同一个 `keydown` 出口，不再是"只有 Esc"）',
    (() => {
        boot();
        const ids = PANEL_TABS.map((x) => x[0]);
        const t = installTabs(ids, ids[1]);
        bindEscClose();
        const kd = allListeners.filter((x) => x.type === 'keydown')[0];
        if (!kd) return false;
        const ev = keyEvent('ArrowRight', t.cur);
        kd.fn(ev);
        const switched = panelState().tab === ids[2];
        const esc = keyEvent('Escape', t.cur);
        kd.fn(esc);
        return switched && panelState().open === false;
    })(), J({ tab: panelState().tab, open: panelState().open, listeners: allListeners.length }));

R.done();
