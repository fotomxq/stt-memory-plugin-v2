// ============================================================
// 单元测试 · B4 设定 14 组子页（V1 对齐）
// 口径：页顺序/标签与 V1 `subTabs` 一致；控件表由 V1 源码自动提取（105 项），键必须能在配置里找到；
//   渲染为 V1 同款结构（`.ftt-field` / `.ftt-switch` / `data-ftt-cfg`）；写回内核 cfg 并持久化 ST 配置。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    SETTINGS_TABS, SETTINGS_CONTROLS, settingsPageHtml, settingsSubTabsHtml,
    applySettingsControl, readControl, settingsPagesInfo, settingsControlHtml,
} from '../../ui/settings-pages.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel } from '../../ui/panel.js';

const R = makeReporter('settings-pages B4 设定子页（V1 对齐）');
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setKernelState(emptyState());

R.assert('P1 子页与 V1 同名同序（14 组）', (() => {
    const want = ['base:基础', 'feed:投喂范围', 'api:API', 'analyze:分析记忆', 'safety:内容弱化', 'extract:提取记忆', 'forget:遗忘', 'rumors:传言', 'parallels:平行', 'prompts:提示词', 'storage:存储', 'debug:调试', 'data:数据管理', 'about:关于'];
    const got = SETTINGS_TABS.map((t) => t.id + ':' + t.label);
    return J(got) === J(want) && settingsSubTabsHtml('base').indexOf('ftt-subtab ftt-on') >= 0;
})(), SETTINGS_TABS.map((t) => t.id));

R.assert('P2 控件表：共 105 项，逐页数量与 V1 提取一致（base12/feed12/analyze3/extract18/forget25/rumors12/parallels5/prompts5/storage13）', (() => {
    const info = settingsPagesInfo();
    const m = {};
    info.pages.forEach((p) => { m[p.id] = p.controls; });
    return info.totalControls === 105 && m.base === 12 && m.feed === 12 && m.analyze === 3 && m.extract === 18
        && m.forget === 25 && m.rumors === 12 && m.parallels === 5 && m.prompts === 5 && m.storage === 13;
})(), settingsPagesInfo());

R.assert('P3 控件键均可解析：普通键在 defaultCfg 内、storage.* 在 defaultCfg.storage 内（提取零漏配）', (() => {
    const bad = [];
    Object.keys(SETTINGS_CONTROLS).forEach((pid) => {
        SETTINGS_CONTROLS[pid].forEach((c) => {
            const k = String(c.key);
            if (k.indexOf('storage.') === 0) {
                const sub = k.slice(8);
                if (!(defaultCfg.storage && Object.prototype.hasOwnProperty.call(defaultCfg.storage, sub))) bad.push(k);
            } else if (!Object.prototype.hasOwnProperty.call(defaultCfg, k)) bad.push(k);
        });
    });
    return bad.length === 0;
})(), (() => {
    const bad = [];
    Object.keys(SETTINGS_CONTROLS).forEach((pid) => SETTINGS_CONTROLS[pid].forEach((c) => {
        const k = String(c.key);
        if (k.indexOf('storage.') === 0) { if (!(defaultCfg.storage && Object.prototype.hasOwnProperty.call(defaultCfg.storage, k.slice(8)))) bad.push(k); }
        else if (!Object.prototype.hasOwnProperty.call(defaultCfg, k)) bad.push(k);
    }));
    return bad.slice(0, 10);
})());

R.assert('P4 渲染：开关页用 .ftt-switch + 「已开启/已关闭」；文本框用 input；下拉用 select；正文域用 textarea', (() => {
    const boolCtl = SETTINGS_CONTROLS.storage.filter((c) => c.type === 'checkbox')[0];
    const textCtl = SETTINGS_CONTROLS.base.filter((c) => c.type === 'text')[0];
    const sb = settingsControlHtml(boolCtl);
    const st = settingsControlHtml(textCtl);
    const page = settingsPageHtml('storage');
    return sb.indexOf('class="ftt-switch"') >= 0 && sb.indexOf('data-ftt-cfg="' + boolCtl.key + '"') >= 0
        && (sb.indexOf('已开启') >= 0 || sb.indexOf('已关闭') >= 0)
        && st.indexOf('<input type="text"') >= 0 && st.indexOf('value="') >= 0
        && page.indexOf('data-ftt-cfg="storage.stateFile"') >= 0
        && panelBodyHtml('settings').indexOf('ftt-settings-subtabs') >= 0;
})(), '');

R.assert('P5 写回：applySettingsControl 改内核 cfg 并持久化（含 storage.* 嵌套）；未知键不崩', (() => {
    const r1 = applySettingsControl('importanceBase', 0.42);
    const r2 = applySettingsControl('storage.settingsMirror', true);
    const store = host.ctx.extensionSettings.ftt_memory_v2;
    const r3 = applySettingsControl('', 1);
    return r1.ok === true && cfg.importanceBase === 0.42 && readControl('importanceBase') === 0.42
        && r2.ok === true && cfg.storage.settingsMirror === true && readControl('storage.settingsMirror') === true
        && store && store.cfg && store.cfg.importanceBase === 0.42 && store.cfg.storage.settingsMirror === true
        && r3.ok === false;
})(), (() => { try { return JSON.stringify({ a: cfg.importanceBase, b: cfg.storage.settingsMirror }); } catch (e) { return String(e.message); } })());

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

await A('P6 面板接线：settingsSub 切页只影响设定页；数据管理页含导出/导入/清台账按钮；导出走钩子并可复制', async () => {
    openPanel('settings');
    setPanelHooks2({
        exportState: () => J({ format: 'ftt-memory-v2-export', state: { atoms: [] } }),
        importState: async (text) => ({ ok: true, added: JSON.parse(text).state.atoms ? 1 : 0 }),
        clearFloors: () => ({ ok: true, cleared: 2 }),
    });
    const r1 = await panelAction('settingsSub', { sub: 'data' });
    const page = panelBodyHtml('settings');
    const r2 = await panelAction('settingsSub', { sub: 'about' });
    const about = panelBodyHtml('settings');
    await panelAction('settingsSub', { sub: 'data' });
    const exp = await panelAction('exportState', {});
    const imp = await panelAction('importStateApply', { text: J({ state: { atoms: [{ id: 'x', text: '来自导入的情节正文足够长。' }] } }) });
    const st = panelState();
    return r1.ok === true && page.indexOf('data-ftt-settings-page="data"') >= 0
        && page.indexOf('data-ftt-action="exportState"') >= 0 && page.indexOf('data-ftt-import="1"') >= 0
        && page.indexOf('data-ftt-action="clearFloors"') >= 0
        && r2.ok === true && about.indexOf('设定 · 关于') >= 0 && about.indexOf('内核配置键：') >= 0
        && exp.ok === true && exp.chars > 10 && st.exportChars > 10
        && imp.ok === true && st.settingsSub === 'data';
}, (() => { try { return JSON.stringify(panelState()).slice(0, 200); } catch (e) { return String(e.message); } })());

un();
R.done();
