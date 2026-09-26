// ============================================================
// 单元测试 · v2.67.0「扩展菜单主入口看不到 → 修复并强制保持」
//
// 用户报告：「底部扩展菜单看不到面板激活的按钮，请修复该问题，该设计为**强制打开，不允许用户关闭**。
//   其他位置的显示可根据需求调整。」
//
// 两处真实缺陷（本批修复，见 `ui/menu.js` 头注）：
//   ① **陈旧标志**：安装后模块只记节点引用，`menuInstalled()` 恒为真 —— 酒馆打开魔杖菜单时会
//      **重建** `#extensionsMenu`（清空后重新填充），我们那一项被清掉后再也不会补回（= 看不到按钮）。
//      现在 `menuInstalled()` 校验节点**是否仍在文档里**（`isConnected` / `document.contains`）并回查 id。
//   ② **安装时机**：`#extensionsMenu` 由酒馆按需创建，插件初始化时可能还不存在，一次失败后此前不再重试。
//      现在提供幂等的 `ensureMenuEntry()`，并在 初始化 / 每次 `syncEntryButtons` / 可见性探针每轮 /
//      **点击魔杖按钮之后** / `#extensionsMenu` 的 `MutationObserver` 上补回。
//
// 强制语义：`cfg.buttonLocations.menu = false` 不生效（`FORCED_ENTRIES`），设置页不展示该开关。
// 运行：node tests/unit/menu-entry.test.js
// ============================================================
import { makeReporter, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { installMenuEntry, ensureMenuEntry, uninstallMenuEntry, unbindMenuWatch, menuInfo, menuInstalled } from '../../ui/menu.js';
import { syncEntryButtons, entryButtonsState, uninstallAllEntries } from '../../ui/entries.js';

const R = makeReporter('menu-entry v2.67.0 扩展菜单主入口（强制保持）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// ---------------- 迷你 DOM（含 contains / isConnected / MutationObserver 打桩） ----------------
function makeEl(id) {
    const el = {
        id: id || '', tagName: 'DIV', className: '', textContent: '', innerHTML: '', title: '', html: '',
        children: [], parentNode: null, listeners: {}, attrs: {}, isConnected: true,
        appendChild(c) { c.parentNode = this; c.isConnected = true; this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; c.isConnected = false; return c; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: { add() { }, remove() { }, contains() { return false; } },
    };
    return el;
}
const MO_REGISTRY = [];
function makeDoc() {
    const els = {};
    const doc = {
        _els: els,
        body: makeEl('body'),
        createElement(tag) { const e = makeEl(''); e.tagName = String(tag || 'div').toUpperCase(); return e; },
        getElementById(id) { return els[id] || null; },
        register(id, el) { els[id] = el; return el; },
        contains(node) { return Object.keys(els).some((k) => els[k] === node) || node === doc.body; },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        listeners: {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    return doc;
}
/** MutationObserver 打桩：记录实例，测试可手动触发回调（模拟酒馆清空菜单内容） */
class FakeMO {
    constructor(cb) { this.cb = cb; this.disconnected = false; MO_REGISTRY.push(this); }
    observe() { this.observed = true; }
    disconnect() { this.disconnected = true; }
}
globalThis.MutationObserver = FakeMO;

const host = makeHost({});
let doc = makeDoc();
installGlobalHost(host, doc);

function boot(withMenu) {
    uninstallAllEntries();
    MO_REGISTRY.length = 0;
    doc = makeDoc();
    if (withMenu !== false) doc.register('extensionsMenu', makeEl('extensionsMenu'));
    doc.register('extensionsMenuButton', makeEl('extensionsMenuButton'));
    installGlobalHost(host, doc);
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return doc;
}
/** 模拟酒馆重建菜单：清空子节点 */
function wipeMenu() {
    const menu = doc._els.extensionsMenu;
    menu.children.slice().forEach((c) => menu.removeChild(c));
    return menu;
}
const nodeText = (n) => { if (!n) return ''; let t = String(n.textContent || ''); for (const c of (n.children || [])) t += nodeText(c); return t; };
const flush = () => new Promise((r) => setTimeout(r, 0));

A('M1 安装形态：V1 同名 id + 酒馆标准菜单项结构（图标 + 文本 + tabindex/role），装在 #extensionsMenu 里', (() => {
    boot();
    const r = installMenuEntry({ onClick: () => undefined });
    const menu = doc._els.extensionsMenu;
    const node = (menu.children || [])[0];
    return r.ok === true && r.id === 'ftt-menu-button' && !!node
        && node.id === 'ftt-menu-button' && String(node.className).indexOf('list-group-item') >= 0
        && String(node.className).indexOf('interactable') >= 0 && nodeText(node) === 'FTT记忆'
        && node.attrs.tabindex === '0' && node.attrs.role === 'button'
        && (node.children || []).some((c) => String(c.className).indexOf('extensionsMenuExtensionButton') >= 0)
        && menuInstalled() === true && menuInfo().installed === true;
})(), J(menuInfo()));

await (async () => {
    A('M2 陈旧标志已修：酒馆重建菜单（清空内容）后 `menuInstalled()` 变 false，`ensureMenuEntry()` 立即补回', (() => {
        wipeMenu();
        const staleOk = menuInstalled() === false;
        const again = ensureMenuEntry();
        const node = (doc._els.extensionsMenu.children || [])[0];
        return staleOk && again.ok === true && again.reinserted === true && !!node && node.id === 'ftt-menu-button'
            && nodeText(node) === 'FTT记忆';
    })(), J({ info: menuInfo() }));

    A('M3 点击路径：点魔杖按钮（酒馆在这一步重建菜单）后在下一个宏任务补回，无需用户重开', (async () => {
        wipeMenu();
        const wand = doc._els.extensionsMenuButton;
        (doc.listeners.click || []).slice().forEach((fn) => fn({ target: wand, preventDefault() { }, stopPropagation() { } }));
        const beforeFlush = menuInstalled();
        await flush();
        return beforeFlush === false && menuInstalled() === true
            && ((doc._els.extensionsMenu.children || [])[0] || {}).id === 'ftt-menu-button';
    })(), J({ info: menuInfo() }));

    A('M4 观察者路径：`#extensionsMenu` 的 MutationObserver 在内容被清空后补回（自触发不递归）', (async () => {
        const mo = MO_REGISTRY.filter((m) => m.observed && !m.disconnected).pop();
        wipeMenu();
        if (!mo) return false;
        mo.cb([]);                       // 模拟「内容被替换」
        await flush();
        const back = menuInstalled();
        mo.cb([]);                       // 再触发一次：已安装 → 不应重复插入
        await flush();
        return back === true && (doc._els.extensionsMenu.children || []).filter((c) => c.id === 'ftt-menu-button').length === 1;
    })(), J({ children: (doc._els.extensionsMenu.children || []).map((c) => c.id) }));

    A('M5 晚建容器：初始化时 `#extensionsMenu` 不存在 → 如实报告；容器出现后 `ensureMenuEntry()` 成功补装', (() => {
        boot(false);
        const first = installMenuEntry({ onClick: () => undefined });
        const info1 = menuInfo();
        doc.register('extensionsMenu', makeEl('extensionsMenu'));
        const second = ensureMenuEntry();
        return first.ok === false && String(first.reason).indexOf('extensionsMenu') > 0
            && info1.menuFound === false && info1.installed === false
            && second.ok === true && menuInstalled() === true;
    })(), J({ first: 'see assertion', info: menuInfo() }));

    A('M6 强制语义：`cfg.buttonLocations.menu = false` 也照样安装（syncEntryButtons 用 ensure 而非 install）', (() => {
        boot();
        const loc = { topbar: false, qr: false, float: false, menu: false };
        const r = syncEntryButtons(loc, { onClick: () => undefined });
        wipeMenu();
        const r2 = syncEntryButtons(loc, { onClick: () => undefined });
        return r.installed.installed.menu === true && loc.menu === true
            && r2.installed.installed.menu === true && menuInstalled() === true;
    })(), J(entryButtonsState()));

    A('M7 卸载真正生效：卸载后监听解绑，清空菜单也不会被补回（teardown 不留残留）', (async () => {
        const r = uninstallMenuEntry();
        wipeMenu();
        await flush();
        const menu = doc._els.extensionsMenu;
        const node = (menu.children || []).filter((c) => c.id === 'ftt-menu-button').length;
        return r === true && menuInstalled() === false && node === 0 && menuInfo().observing === false;
    })(), J({ info: menuInfo() }));

    A('M8 诊断如实：`menuInfo()` 给出 btnId / wandId / menuFound / installed / watched / observing', (() => {
        boot();
        const before = menuInfo();
        installMenuEntry({ onClick: () => undefined });
        const after = menuInfo();
        // 安装前：容器在但未安装、尚未绑定观察；安装后：installed 与 watched/observing 均为真
        return before.installed === false && before.menuFound === true && before.watched === false
            && after.installed === true && after.watched === true && after.observing === true
            && after.btnId === 'ftt-menu-button' && after.wandId === 'extensionsMenuButton'
            && J(after.candidates) === J(before.candidates);
    })(), J(menuInfo()));
})();

uninstallAllEntries();
unbindMenuWatch();
R.done();
