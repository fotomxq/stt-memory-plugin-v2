// ============================================================
// 单元测试 · v2.40.0「面板钩子接线完整性」（防同类回归）
// 背景（用户报告「数据管理导出导入功能不可用」）：V2 的面板（V1 同构浮层）由 `ui/panel.js` 读取 `hooks.*`，
//   而 index.js 只注入了 `popupHooks()` 的 4~5 个键 → **导出 / 导入 / V1 导入 / 批量摘要 / 中断 / 清台账 /
//   维度开关** 全部落到「入口未就绪」或静默不生效。此前的测试只走 `popupAction`（devtools 钩子）所以没暴露。
// 本文件用**静态交叉校验**把这类问题钉死：
//   C 组：`ui/panel.js` 读到的每个 `hooks.X` 都必须在 `panelRuntimeHooks()` 里存在且为函数（缺一个就失败）；
//   W 组：index.js 的注入点必须使用 `panelRuntimeHooks()`（不得退回 `popupHooks()`）；
//   B 组：逐个钩子做**行为**断言（导出/导入真实数据往返、维度开关落 cfg、清台账、确认对话框语义）；
//   D 组：确认对话框为**同步**语义（返回布尔），避免宿主异步弹窗被 `!!Promise` 误判为「确认」。
// 运行：node tests/unit/panel-hooks.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelAction, panelBodyHtml, setPanelHooks2, panelState } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PANEL_SRC = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
const INDEX_SRC = readFileSync(join(ROOT, 'index.js'), 'utf8');

const R = makeReporter('panel-hooks v2.40.0 面板钩子接线完整性');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

const entry = await import('../../index.js');
const HOOKS = entry.panelRuntimeHooks();

/** 面板源码里读取的全部 `hooks.X` 键（去重、按字母序） */
function neededHookKeys() {
    const set = new Set();
    const re = /hooks\.([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(PANEL_SRC)) !== null) set.add(m[1]);
    return Array.from(set).sort();
}

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2(entry.panelRuntimeHooks());
    return state;
}

// ---------- C 组：静态交叉校验 ----------
A('C1 `ui/panel.js` 读取的每个 `hooks.X` 都已在 `panelRuntimeHooks()` 中提供且为函数（缺键即失败）', (() => {
    const need = neededHookKeys();
    const missing = need.filter((k) => typeof HOOKS[k] !== 'function');
    const notNeeded = Object.keys(HOOKS).filter((k) => need.indexOf(k) < 0);
    // 诊断信息随断言带出（在册但面板未用的键不算失败，只作提示）
    return need.length >= 14 && missing.length === 0 && notNeeded.indexOf('extractStatus') >= 0;
})(), { need: neededHookKeys(), have: Object.keys(HOOKS).sort(), missing: neededHookKeys().filter((k) => typeof HOOKS[k] !== 'function') });

A('C2 曾经缺失的 11 个键全部在册（导出/导入/V1 导入/批量摘要/中断/进度/清台账/清空记忆/维度开关/确认/注入）', (() => {
    const must = ['exportState', 'importState', 'importV1', 'autoSummary', 'abort', 'batchProgress', 'clearFloors', 'resetState', 'dimToggle', 'confirm', 'inject'];
    const missing = must.filter((k) => typeof HOOKS[k] !== 'function');
    return missing.length === 0;
})(), null);

// ---------- W 组：注入点 ----------
A('W1 index.js 的面板注入点使用 `panelRuntimeHooks()`（不得退回只含 4~5 键的 `popupHooks()`）', (() => {
    return INDEX_SRC.indexOf('setPanelHooks2(panelRuntimeHooks())') >= 0
        && INDEX_SRC.indexOf('setPanelHooks2(Object.assign({}, popupHooks()') < 0
        && INDEX_SRC.indexOf('function popupHooks()') >= 0;
})(), null);

// ---------- B 组：行为 ----------
const B1 = await (async () => {
    boot();
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'a1', title: '情节甲', text: '甲在码头', date: '1919-11-20', uses: 0, floorStart: 0, floorEnd: 1 }],
        memories: [{ id: 'm1', title: '记忆甲', content: '甲在码头清点铜箱', date: '1919-11-20' }],
    }));
    await panelAction('tab', { tab: 'settings' });
    await panelAction('settingsSub', { sub: 'data' });
    const text = entry.exportStateJson();
    const page = String(panelBodyHtml('settings'));
    const hasButtons = page.indexOf('data-ftt-action="exportState"') >= 0 && page.indexOf('data-ftt-action="importStateApply"') >= 0;
    const exp = await panelAction('exportState', {});
    const shown = String(panelBodyHtml('settings')).indexOf('data-ftt-export') >= 0;
    // 清空后经面板导入（参数路径）
    setKernelState(emptyState());
    const imp = await panelAction('importStateApply', { text });
    const viaParam = imp.ok === true && Number(imp.added) === 2 && (state.atoms || []).length === 1 && (state.memories || []).length === 1;
    // 文本域路径（真实 UI：粘贴后点导入）
    const prevDoc = globalThis.document;
    globalThis.document = Object.assign({}, doc, { querySelector: (sel) => (String(sel).indexOf('data-ftt-import') >= 0 ? { value: text } : null) });
    setKernelState(emptyState());
    const imp2 = await panelAction('importStateApply', {});
    globalThis.document = prevDoc;
    const viaDom = imp2.ok === true && Number(imp2.added) === 2 && (state.atoms || []).length === 1;
    // 空文本域 → 如实拒绝
    setKernelState(emptyState());
    const imp3 = await panelAction('importStateApply', { text: '   ' });
    return hasButtons && exp.ok === true && Number(exp.chars) > 100 && shown && viaParam && viaDom
        && imp3.ok === false && String(imp3.reason) === 'empty' && String((imp2.state || {}).note).indexOf('已导入并合并：新增 2 条') >= 0;
})();
A('B1 数据管理导出/导入（面板动作路径）：导出返回文本并渲染文本框；导入按参数与**文本域**两条路径都真实合并（新增 2 条）；空文本域如实拒绝', B1, null);

A('B2 维度开关 `dimToggle` 真实写内核 `cfg.dimensionEnabled` 并落盘（此前静默无效）；`clearFloors` 与 `abort` 不再「入口未就绪」', (() => {
    boot();
    const r1 = HOOKS.dimToggle('atoms', false);
    const off = (cfg.dimensionEnabled || {}).atoms === false;
    const r2 = HOOKS.dimToggle('states', true);
    const on = (cfg.dimensionEnabled || {}).states === true;
    const r3 = HOOKS.dimToggle('', true);
    const r4 = HOOKS.clearFloors();
    const r5 = HOOKS.abort();
    return r1.ok === true && off && r2.ok === true && on && r3.ok === false
        && !!r4 && typeof r4 === 'object' && !!r5 && typeof r5 === 'object'
        && typeof HOOKS.batchProgress() === 'object'
        && typeof HOOKS.autoSummary === 'function' && typeof HOOKS.importV1 === 'function' && typeof HOOKS.inject === 'function';
})(), null);

// ---------- D 组：确认对话框语义（v2.41.0：异步安全 + ACL 不炸） ----------
const D1 = await (async () => {
    const savedPopup = host.ctx.callGenericPopup;
    const savedConfirm = globalThis.confirm;
    // ① 酒馆自身弹窗（页面内 UI，不走宿主 ACL）按其真实结果
    let askedPopup = 0;
    host.ctx.callGenericPopup = async () => { askedPopup += 1; return 1; };
    const popupYes = await HOOKS.confirm('确定清空？', '数据管理');
    host.ctx.callGenericPopup = async () => 0;
    const popupNo = await HOOKS.confirm('确定清空？', '数据管理');
    host.ctx.callGenericPopup = async () => { throw new Error('ACL denied'); };
    const popupThrow = await HOOKS.confirm('确定清空？', '数据管理');   // 抛错 → 落到原生 confirm（此处无 → false）
    // ② 无酒馆弹窗 → 原生 confirm：同步布尔采信；Promise 桥接**不采信**（ACL 拒绝不得变成未处理拒绝）
    delete host.ctx.callGenericPopup;
    let asked = '';
    globalThis.confirm = (msg) => { asked = String(msg); return true; };
    const nativeYes = await HOOKS.confirm('确定清空？', '数据管理');
    globalThis.confirm = () => false;
    const nativeNo = await HOOKS.confirm('确定清空？', '数据管理');
    globalThis.confirm = () => Promise.reject(new Error('Command plugin:dialog|confirm not allowed by ACL'));
    const bridged = await HOOKS.confirm('确定清空？', '数据管理');
    globalThis.confirm = () => Promise.resolve(true);
    const bridgedTrue = await HOOKS.confirm('确定清空？', '数据管理');
    // ③ Tauri 宿主：原生 confirm 会撞 ACL → 直接跳过（不调用）
    let calledInTauri = false;
    globalThis.__TAURI_INTERNALS__ = {};
    globalThis.confirm = () => { calledInTauri = true; return true; };
    const tauri = await HOOKS.confirm('确定清空？', '数据管理');
    delete globalThis.__TAURI_INTERNALS__;
    // ④ 完全没有对话框能力 → false（按取消，V1 同款）
    delete globalThis.confirm;
    const none = await HOOKS.confirm('确定清空？', '数据管理');
    // 收尾
    if (savedPopup === undefined) delete host.ctx.callGenericPopup; else host.ctx.callGenericPopup = savedPopup;
    if (savedConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = savedConfirm;
    await new Promise((r) => setTimeout(r, 0));   // 给被吞掉的拒绝一个落定机会（未处理拒绝会在此暴露）
    const diag = { popupYes, popupNo, askedPopup, popupThrow, nativeYes, nativeNo, asked, bridged, bridgedTrue, tauri, calledInTauri, none };
    globalThis.__d1diag = diag;
    return popupYes === true && popupNo === false && askedPopup === 1 && popupThrow === false
        && nativeYes === true && nativeNo === false && asked === '确定清空？'
        && bridged === false && bridgedTrue === true && tauri === false && calledInTauri === false && none === false;
})();
A('D1 `confirm` 异步安全：酒馆弹窗 / 原生同步 confirm 按真实结果；**Promise 桥接与拒绝 → 取消**（不产生未处理拒绝）；Tauri 宿主跳过会触发 ACL 的原生 confirm；无对话框 → false', D1, globalThis.__d1diag);

A('D2 面板状态可读（接线后不改变既有行为）：`panelState()` 结构完整', (() => {
    boot();
    const ps = panelState();
    return !!ps && typeof ps === 'object' && typeof ps.tab === 'string' && typeof ps.settingsSub === 'string';
})(), null);

un();
R.done();
