// ============================================================
// 单元测试 · v2.65.0「显示界面开关与 V1 对齐 + 扩展菜单入口强制开启」
//
// 用户报告：「设定的显示界面开关存在问题，应该与 V1 对齐，且根据需求展示对应的按钮入口。
//   其中注意，当前扩展中的窗口入口选项是**强制开启**的，禁止被关闭，且**不展示该开关**。」
//
// 本批（`ui/entries.js` 新增 + `ui/menu.js`/`ui/floating.js` 对齐 + `ui/settings-pages.js` 区块重写 + `index.js` 接线）：
//   ① 「显示界面开关」按 V1 v1.206 `buttonLocationRowsHtml()` 对齐：顶栏按钮 / 页面底部按钮 / 悬浮按钮 / 扩展菜单项
//      （顺序、名称、默认值、显示/隐藏 文案一致；开关标记 `data-ftt-loc="<loc>"`，改动即时生效）；
//   ② **扩展菜单项强制开启**：不渲染开关，只给一行「始终开启（主入口，不可关闭）」；`cfg.buttonLocations.menu=false`
//      不生效（V1 存档/跨端带过来也一样）；
//   ③ 四个入口都真实实现（V1 同名 id 与标记）：`#ftt-topbar-button` / `#ftt-qr-button` / `#ftt-float-button` / `#ftt-menu-button`；
//      宿主缺少对应容器时**如实报告**不安装（不做假入口）；
//   ④ 悬浮按钮区分来源（用户开启 / 可见性兜底）：设置里关闭只移除前者；
//   ⑤ V2 附加一项「扩展设置抽屉卡片」（`cfg.uiShowDrawer`）开关，改完立即挂载/卸载。
//
// V1 对照（oracle）：`tests/fixtures/v1-golden-entry-buttons.json`
//   = 真实 V1 v1.206 的「显示界面开关」区块语义投影 + 归一默认值 + `syncButtons()` 落地观察。
// 运行：node tests/unit/entry-buttons.test.js
// ============================================================
import { makeReporter, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    ENTRY_LOCATIONS, ENTRY_LABELS, ENTRY_DEFAULTS, FORCED_ENTRIES,
    normalizeEntryLocations, entryEnabled, syncEntryButtons, entryButtonsState, uninstallAllEntries,
    installTopbarEntry, installQrEntry, topbarInstalled, qrInstalled,
} from '../../ui/entries.js';
import { installFloatingEntry, floatingInfo, uninstallFloatingEntry } from '../../ui/floating.js';
import { installMenuEntry, menuInfo } from '../../ui/menu.js';
import { panelAction, panelBodyHtml, setPanelHooks2, bindOverlay } from '../../ui/panel.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('entry-buttons v2.65.0 显示界面开关与入口按钮');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'v1-golden-entry-buttons.json'), 'utf8'));
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------------- 迷你 DOM（支持 appendChild / pre pen d / remove —— 桩 st-mock 没有，无法验证真实节点） ----------------
function makeEl(id) {
    const el = {
        id: id || '', tagName: 'DIV', className: '', textContent: '', innerHTML: '', title: '', html: '',
        children: [], parentNode: null, listeners: {}, attrs: {}, style: {}, dataset: {},
        checked: false, value: '', disabled: false, type: 'checkbox',
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        prepend(c) { c.parentNode = this; this.children.unshift(c); return c; },
        insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        insertAdjacentHTML(pos, h) { this.html += String(h); },
        contains(n) { return this.children.indexOf(n) >= 0; },
        querySelector(sel) {
            const s = String(sel || '');
            const find = (pred, nodes) => {
                for (const c of (nodes || [])) {
                    if (pred(c)) return c;
                    const deeper = find(pred, c.children || []);
                    if (deeper) return deeper;
                }
                return null;
            };
            if (s === '#qr--bar') return find((c) => c.id === 'qr--bar', this.children);
            if (s === '.ftt-qr-buttons') return find((c) => String(c.className).indexOf('ftt-qr-buttons') >= 0, this.children);
            if (s === '.drawer-toggle') return find((c) => String(c.className).indexOf('drawer-toggle') >= 0, this.children);
            if (s.charAt(0) === '#') return find((c) => c.id === s.slice(1), this.children);
            return null;
        },
        querySelectorAll() { return []; },
        classList: { add() { }, remove() { }, contains() { return false; } },
    };
    return el;
}
function makeDoc() {
    const els = {};
    const doc = {
        _els: els,
        body: makeEl('body'),
        head: makeEl('head'),
        createElement(tag) { const e = makeEl(''); e.tagName = String(tag || 'div').toUpperCase(); return e; },
        getElementById(id) { return els[id] || null; },
        register(id, el) { els[id] = el; return el; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    return doc;
}
/** 建一套完整宿主容器（酒馆里这些节点由宿主持有） */
function makeFullDoc() {
    const doc = makeDoc();
    doc.register('ftt-panel', makeEl('ftt-panel'));
    doc.register('top-settings-holder', makeEl('top-settings-holder'));
    doc.register('persona-management-button', makeEl('persona-management-button'));
    doc.register('send_form', makeEl('send_form'));
    doc.register('extensionsMenu', makeEl('extensionsMenu'));
    doc.body.parentNode = doc;
    return doc;
}
const host = makeHost({});
let doc = makeFullDoc();
installGlobalHost(host, doc);

function boot(nextDoc) {
    if (nextDoc) { doc = nextDoc; installGlobalHost(host, doc); }
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
}
const reset = () => { uninstallAllEntries(); };
/** 在容器里按 id 找节点（含一层嵌套，见 qr 的 bar → wrap → btn） */
function findById(nodes, id) {
    for (const n of (nodes || [])) {
        if (!n) continue;
        if (n.id === id) return n;
        const deeper = findById(n.children || [], id);
        if (deeper) return deeper;
    }
    return null;
}

// ==================== A 组：V1 oracle 对齐 ====================
A('A1 常量与 V1 逐项一致：入口清单 / 名称 / 默认值 / 元素 id', J(ENTRY_LOCATIONS) === J(FX.locations)
    && J(Object.assign({}, ENTRY_LABELS)) === J(FX.labels)
    && J(Object.assign({}, ENTRY_DEFAULTS)) === J(FX.defaults)
    && J(entryButtonsState().ids) === J(FX.ids), J({ loc: ENTRY_LOCATIONS, ids: entryButtonsState().ids }));

A('A2 默认态区块与 V1 逐行一致（名称 / 开关 / 勾选 / 显示-隐藏）', (() => {
    boot(makeFullDoc());
    const html = panelBodyHtml('settings');
    const sec = html.slice(html.indexOf('显示界面开关'));
    const rows = FX.section.rows.filter((r) => FORCED_ENTRIES.indexOf(r.loc) < 0);
    const ok = rows.every((r) => {
        const marker = 'data-ftt-loc="' + r.loc + '"';
        const at = sec.indexOf(marker);
        if (at < 0) return false;
        const seg = sec.slice(sec.lastIndexOf('<div class="ftt-loc-row">', at), sec.indexOf('</div>', at) + 6);
        return strip(seg).indexOf(r.label) >= 0
            && (seg.indexOf('checked') >= 0) === r.checked
            && strip(seg).indexOf(r.stateText) >= 0;
    });
    return ok && sec.indexOf('顶栏按钮') < sec.indexOf('页面底部按钮')
        && sec.indexOf('页面底部按钮') < sec.indexOf('悬浮按钮') && sec.indexOf('悬浮按钮') < sec.indexOf('扩展菜单项');
})(), '见断言');

A('A3 强制项（扩展菜单项）：**不展示开关**，只给「始终开启」一行（用户要求）', (() => {
    const html = panelBodyHtml('settings');
    const sec = html.slice(html.indexOf('显示界面开关'));
    const at = sec.indexOf('扩展菜单项');
    const seg = sec.slice(sec.lastIndexOf('<div class="ftt-loc-row">', at), sec.indexOf('</div>', at) + 6);
    return at >= 0 && seg.indexOf('data-ftt-loc="menu"') < 0 && seg.indexOf('ftt-switch') < 0
        && seg.indexOf('始终开启（主入口，不可关闭）') >= 0 && J(FORCED_ENTRIES) === J(['menu']);
})(), '见断言');

A('A4 提示简短：一句短提示（≤90 字、无历史版本字样）+ 折叠说明承载细节', (() => {
    const html = panelBodyHtml('settings');
    const sec = html.slice(html.indexOf('显示界面开关'), html.indexOf('界面特效'));
    const m = sec.match(/<div class="ftt-muted" data-ftt-short-hint>([\s\S]*?)<\/div>/);
    const short = m ? strip(m[1]) : '';
    return !!m && short.length > 0 && short.length <= 90 && short.indexOf('即时生效') > 0
        && short.indexOf('V1') < 0 && sec.indexOf('<details') > 0 && sec.indexOf('ftt-hint-body') > 0;
})(), '见断言');

// ==================== B 组：入口真实安装 / 移除 ====================
A('B1 默认态真实落地：扩展菜单项（强制）+ 页面底部按钮在；顶栏/悬浮不在', (() => {
    boot(makeFullDoc());
    reset();
    const r = syncEntryButtons(cfg.buttonLocations, { onClick: () => undefined });
    const st = r.installed.installed;
    return st.menu === true && st.qr === true && st.topbar === false && st.float === false
        && !!findById(doc._els.extensionsMenu.children, 'ftt-menu-button')
        && !!findById(doc._els.send_form.children, 'ftt-qr-button');
})(), J(entryButtonsState()));

A('B2 全开：四个入口都按 V1 同名 id 与标记落地（顶栏插在 persona 前 / 底部在快捷栏包裹里 / 悬浮 📖 在 body）', (() => {
    boot(makeFullDoc());
    reset();
    syncEntryButtons({ topbar: true, qr: true, float: true, menu: true }, { onClick: () => undefined });
    const holder = doc._els['top-settings-holder'];
    const topbar = findById(holder.children, 'ftt-topbar-button');
    const qr = findById(doc._els.send_form.children, 'ftt-qr-button');
    const flt = findById(doc.body.children, 'ftt-float-button');
    const menu = findById(doc._els.extensionsMenu.children, 'ftt-menu-button');
    return !!topbar && topbar.className === 'drawer' && String(topbar.innerHTML).indexOf('drawer-toggle') >= 0
        && !!qr && qr.className === 'ftt-qr-btn menu_button interactable' && qr.textContent === 'FTT记忆'
        && !!flt && flt.textContent === '📖' && !!menu && menu.textContent === 'FTT记忆';
})(), J({ holder: (doc._els['top-settings-holder'].children || []).map((c) => c.id), body: (doc.body.children || []).map((c) => c.id) }));

A('B3 关闭即移除：顶栏 / 页面底部 / 悬浮 三个入口从 DOM 上撤掉（菜单不受影响）', (() => {
    syncEntryButtons({ topbar: false, qr: false, float: false, menu: true }, { onClick: () => undefined });
    const st = entryButtonsState().installed;
    return st.topbar === false && st.qr === false && st.float === false && st.menu === true
        && !findById(doc._els['top-settings-holder'].children, 'ftt-topbar-button')
        && !findById(doc._els.send_form.children, 'ftt-qr-button')
        && !findById(doc.body.children, 'ftt-float-button');
})(), J(entryButtonsState()));

A('B4 强制开启：配置写 false 也照样安装，且归一化把菜单项写回 true', (() => {
    boot(makeFullDoc());
    reset();
    const loc = { topbar: false, qr: false, float: false, menu: false };
    const r = syncEntryButtons(loc, { onClick: () => undefined });
    const norm = normalizeEntryLocations({ menu: false });
    return r.installed.installed.menu === true && !!findById(doc._els.extensionsMenu.children, 'ftt-menu-button')
        && loc.menu === true && norm.menu === true && entryEnabled('menu', { menu: false }) === true;
})(), J({ loc: normalizeEntryLocations({ menu: false }) }));

A('B5 点击入口即回调 onClick（四个入口都绑上；preventDefault/stopPropagation 被吞掉）', (async () => {
    boot(makeFullDoc());
    reset();
    let hits = 0;
    syncEntryButtons({ topbar: true, qr: true, float: true, menu: true }, { onClick: () => { hits += 1; return Promise.resolve(); } });
    const nodes = [
        findById(doc._els['top-settings-holder'].children, 'ftt-topbar-button'),
        findById(doc._els.send_form.children, 'ftt-qr-button'),
        findById(doc.body.children, 'ftt-float-button'),
        findById(doc._els.extensionsMenu.children, 'ftt-menu-button'),
    ];
    for (const n of nodes) {
        if (!n) continue;
        const target = n.querySelector('.drawer-toggle') || n;
        target.dispatch('click', { preventDefault() { }, stopPropagation() { } });
    }
    await new Promise((r) => setTimeout(r, 0));      // 点击回调走 Promise.then → 等一个宏任务
    return nodes.every(Boolean) && hits === 4;
})(), 'hits 见断言');

A('B6 缺容器如实报告（不造假入口）：无 #top-settings-holder / 无 #send_form 时不安装', (() => {
    const bare = makeDoc();
    bare.register('ftt-panel', makeEl('ftt-panel'));
    bare.register('extensionsMenu', makeEl('extensionsMenu'));
    bare.body = null;
    boot(bare);
    reset();
    const t = installTopbarEntry({ onClick: () => undefined });
    const q = installQrEntry({ onClick: () => undefined });
    const f = installFloatingEntry({ onClick: () => undefined }, { reason: 'fallback' });
    return t.ok === false && String(t.reason).indexOf('top-settings-holder') > 0
        && q.ok === false && String(q.reason).indexOf('send_form') > 0
        && f.ok === false && String(f.reason).indexOf('无可插入的容器') >= 0
        && topbarInstalled() === false && qrInstalled() === false;
})(), '见断言');

A('B7 悬浮兜底不被设置关掉：兜底来源保留，用户来源才移除', (() => {
    boot(makeFullDoc());
    reset();
    installFloatingEntry({ onClick: () => undefined }, { reason: 'fallback' });
    const afterOff = syncEntryButtons({ float: false, menu: true }, { onClick: () => undefined });
    const kept = floatingInfo().installed === true && floatingInfo().reason === 'fallback';
    uninstallFloatingEntry();
    syncEntryButtons({ float: true, menu: true }, { onClick: () => undefined });
    const afterUserOff = syncEntryButtons({ float: false, menu: true }, { onClick: () => undefined });
    return kept && afterUserOff.installed.installed.float === false && floatingInfo().installed === false && afterOff.ok === true;
})(), J(floatingInfo()));

// ==================== C 组：设定页开关 → 即时生效（真实 change 委托） ====================
A('C1 `data-ftt-loc` 开关：写 `cfg.buttonLocations` + 调 `hooks.syncEntries` 即时重建入口 + 落盘', () => {
    boot(makeFullDoc());
    reset();
    const calls = [];
    setPanelHooks2({ syncEntries: (locs) => { calls.push(JSON.parse(JSON.stringify(locs))); return { ok: true }; } });
    panelAction('settingsSub', { sub: 'base' });
    bindOverlay();
    const el = doc._els['ftt-panel'];
    const onChange = (el.listeners.change || [])[0];
    if (typeof onChange !== 'function') return false;
    const evt = (dataset, checked) => ({ target: { dataset: dataset, checked: checked, type: 'checkbox', value: '' } });
    onChange(evt({ fttLoc: 'topbar' }, true));
    const afterOn = cfg.buttonLocations.topbar === true;
    onChange(evt({ fttLoc: 'qr' }, false));
    const afterOff = cfg.buttonLocations.qr === false;
    onChange(evt({ fttLoc: 'menu' }, false));      // 强制项：勾掉也不生效
    return afterOn && afterOff && calls.length === 3 && cfg.buttonLocations.menu === true
        && calls[0].topbar === true && calls[1].qr === false;
}, () => J({ loc: cfg.buttonLocations, calls: 'see assertion' }));

A('C2 `uiShowDrawer` 开关：写配置并调 `hooks.showDrawer`（抽屉卡片立即挂载/卸载）', () => {
    boot(makeFullDoc());
    const seen = [];
    setPanelHooks2({ showDrawer: (on) => { seen.push(on); return { ok: true }; } });
    panelAction('settingsSub', { sub: 'base' });
    bindOverlay();
    const el = doc._els['ftt-panel'];
    const onChange = (el.listeners.change || [])[0];
    if (typeof onChange !== 'function') return false;
    onChange({ target: { dataset: { fttCfg: 'uiShowDrawer' }, checked: true, type: 'checkbox', value: '' } });
    const on = cfg.uiShowDrawer === true;
    const html = panelBodyHtml('settings');
    onChange({ target: { dataset: { fttCfg: 'uiShowDrawer' }, checked: false, type: 'checkbox', value: '' } });
    return on && cfg.uiShowDrawer === false && J(seen) === J([true, false])
        && html.indexOf('data-ftt-cfg="uiShowDrawer"') >= 0 && html.indexOf('扩展设置抽屉卡片') >= 0;
}, () => J({ loc: cfg.uiShowDrawer }));

A('C3 菜单入口诊断与旧 id 清理：`menuInfo().btnId` 为 V1 名，安装后 `installed` 为真', (() => {
    boot(makeFullDoc());
    reset();
    const r = installMenuEntry({ onClick: () => undefined });
    const info = menuInfo();
    return j(info.btnId) && info.btnId === 'ftt-menu-button' && info.installed === true && r.ok === true && info.menuFound === true;
    function j(x) { return x === 'ftt-menu-button'; }
})(), J(menuInfo()));

reset();
R.done();
