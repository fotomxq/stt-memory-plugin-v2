// ============================================================
// 单元测试 · v2.36.0「面板宽度自适应」
// 口径（用户要求）：宽度不足 → 插件自适应宽度；手机端铺满、PC 自适应；但**注意不要太宽**。
// 实现：CSS 变量 `--ftt-panel-max-w`（上限，默认 1280px）+ `width: min(上限, 100vw - 32px)`；
//   平板 701~1024px → `min(上限, 96vw)`；手机 ≤700px → `100dvw/100dvh` 全屏；
//   上限档位由「V2 附加设定 → 面板最大宽度」（适配层设置 `panelMaxWidth`，V1 无此项）下发。
// 覆盖：C 组 CSS 规则（三档 + 540px 不写死 + 宽屏溢出保护）/ S 组设置键（默认值、归一、夹取）/
//   V 组变量下发（打开与重绘都下发、档位切换即时生效、非法值回落）/ U 组控件与键路由（选择框写回适配层）。
// 运行：node tests/unit/panel-width.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { DEFAULT_SETTINGS, getSettings, setSetting, resetSettings, panelWidthCssValue } from '../../adapters/settings.js';
import { panelState, panelBodyHtml, panelAction, openPanel, renderPanel, applyPanelWidth, PANEL_WIDTH_OPTIONS } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(ROOT, 'style.css'), 'utf8');
const R = makeReporter('panel-width v2.36.0 面板宽度自适应');
const A = (name, cond, extra) => R.assert(name, !!cond, extra);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
const overlay = () => doc.getElementById('ftt-panel');
const cssVar = () => String(overlay().style.getPropertyValue('--ftt-panel-max-w') || '');

// ---------- C 组：CSS 三档 ----------
A('C1 桌面档：宽度 = min(CSS 变量上限, 100vw - 32px)（不再写死 940px），且变量默认 1280px', (() => {
    const base = /#ftt-panel\s*\{[^}]*--ftt-panel-max-w:\s*1280px/.test(CSS);
    const rule = CSS.indexOf('width: min(var(--ftt-panel-max-w), calc(100vw - 32px))') >= 0;
    const noHard = CSS.indexOf('width: min(940px, 94vw)') < 0;
    return base && rule && noHard;
})(), null);

A('C2 平板档 701~1024px → min(上限, 96vw)；手机档 ≤700px → 100dvw/100dvh 全屏铺满（并禁用圆角/边框/阴影）', (() => {
    const tabIdx = CSS.indexOf('@media (min-width: 701px) and (max-width: 1024px)');
    const tab = tabIdx >= 0 && CSS.slice(tabIdx, tabIdx + 400).indexOf('width: min(var(--ftt-panel-max-w), 96vw)') >= 0;
    const mobIdx = CSS.indexOf('@media (max-width: 700px)');
    const mob = mobIdx >= 0 && (() => {
        const seg = CSS.slice(mobIdx, mobIdx + 900);
        return seg.indexOf('width: 100vw') >= 0 && seg.indexOf('width: 100dvw') >= 0
            && seg.indexOf('height: 100dvh') >= 0 && seg.indexOf('border-radius: 0') >= 0 && seg.indexOf('border: none') >= 0;
    })();
    return tab && mob;
})(), null);

A('C3 宽面板的溢出保护：正文/分节/设定页 min-width:0 且 max-width:100%，日志与代码块可横向滚动（加宽后不得撑破容器）', (() => {
    return CSS.indexOf('#ftt-panel .ftt-body, #ftt-panel .ftt-section, #ftt-panel .ftt-settings-page { min-width: 0; max-width: 100%; }') >= 0
        && CSS.indexOf('#ftt-panel .ftt-dbg-data, #ftt-panel .ftt-wb-entries, #ftt-panel .ftt-editor, #ftt-panel .ftt-pre-box { max-width: 100%; overflow-x: auto; }') >= 0
        && CSS.indexOf('#ftt-panel .ftt-item-main { min-width: 0; }') >= 0
        // 抽屉卡片（v2.0 形态）窄屏兜底
        && CSS.indexOf('.ftt-v2-settings .ftt-v2-row { flex-wrap: wrap; }') >= 0;
})(), null);

// ---------- S 组：设置键与归一 ----------
A('S1 `panelMaxWidth` 默认 1280（注意不要太宽的保守档）；`panelWidthCssValue` 归一：正数 → `Npx` 且夹在 4000、0/非法 → `100vw`（铺满）', (() => {
    const d = DEFAULT_SETTINGS.panelMaxWidth === 1280;
    const norm = panelWidthCssValue(1440) === '1440px' && panelWidthCssValue('960') === '960px'
        && panelWidthCssValue(0) === '100vw' && panelWidthCssValue(-5) === '100vw'
        && panelWidthCssValue('abc') === '100vw' && panelWidthCssValue(99999) === '4000px';
    return d && norm;
})(), { def: DEFAULT_SETTINGS.panelMaxWidth, v: panelWidthCssValue(1440) });

A('S2 `setSetting` 归一与夹取：1440 落库、`"1600"` 字符串转数、非法回落默认 1280、超限夹到 4000；未知键拒绝', (() => {
    resetSettings();
    const ok1 = setSetting('panelMaxWidth', 1440) === true && getSettings().panelMaxWidth === 1440;
    const ok2 = setSetting('panelMaxWidth', '1600') === true && getSettings().panelMaxWidth === 1600;
    const ok3 = setSetting('panelMaxWidth', 'abc') === true && getSettings().panelMaxWidth === 1280;
    const ok4 = setSetting('panelMaxWidth', -3) === true && getSettings().panelMaxWidth === 1280;
    const ok5 = setSetting('panelMaxWidth', 99999) === true && getSettings().panelMaxWidth === 4000;
    const ok6 = setSetting('panelMaxWidth', 0) === true && getSettings().panelMaxWidth === 0;   // 0 是合法档（铺满）
    const ok7 = setSetting('nope', 1) === false;
    resetSettings();
    return ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7;
})(), null);

// ---------- V 组：变量下发 ----------
A('V1 打开面板即下发变量（默认 1280px）；切换到 1440 档 → 重绘后变量随之变化；切到「铺满」→ 100vw', (() => {
    resetSettings();
    openPanel();
    const v0 = cssVar();
    setSetting('panelMaxWidth', 1440);
    const v1 = applyPanelWidth();
    renderPanel();
    const v1b = cssVar();
    setSetting('panelMaxWidth', 0);
    const v2 = applyPanelWidth();
    renderPanel();
    const v2b = cssVar();
    resetSettings();
    renderPanel();
    const back = cssVar();
    return v0 === '1280px' && v1 === '1440px' && v1b === '1440px' && v2 === '100vw' && v2b === '100vw' && back === '1280px';
})(), null);

A('V2 桩宿主/受限环境安全：无 style 的元素不抛错（返回下发的值）；变量值恒为合法 CSS（`Npx` 或 `100vw`）', (() => {
    let threw = '';
    let out = '';
    try { out = applyPanelWidth({ id: 'no-style' }); } catch (e) { threw = String(e.message || e); }
    const ok = threw === '' && out === '1280px' && /^(\d+px|100vw)$/.test(out);
    return ok && panelState().open === true;
})(), null);

// ---------- U 组：控件与键路由 ----------
A('U1 「V2 附加设定」出宽度档位选择框（`data-ftt-v2="panelMaxWidth"`）：六档、当前档选中、含「铺满」并在文案里说明手机恒铺满', (() => {
    resetSettings();
    const html = panelBodyHtml('settings');
    const hasCtrl = html.indexOf('data-ftt-v2="panelMaxWidth"') >= 0;
    const opts = PANEL_WIDTH_OPTIONS.map((o) => '<option value="' + o.v + '"').every((s) => html.indexOf(s) >= 0);
    const selected = html.indexOf('<option value="1280" selected>') >= 0;
    const full = html.indexOf('铺满（只留 32px 边距）') >= 0;
    const note = html.indexOf('手机端恒铺满') >= 0 && html.indexOf('面板最大宽度') >= 0;
    return PANEL_WIDTH_OPTIONS.length === 6 && hasCtrl && opts && selected && full && note;
})(), null);

A('U2 选择框变更走**适配层设置**（不是内核 cfg）：值写进 extensionSettings 且立即生效；内核 cfg 不新增该键', (async () => {
    resetSettings();
    const before = Number(getSettings().panelMaxWidth);
    await panelAction('refresh', {});
    // 模拟真实 change 委托
    const el = overlay();
    const fireChange = (dataset, value) => {
        const list = (el.listeners && el.listeners.change) || [];
        list.forEach((fn) => fn({ target: { dataset, value, type: 'select-one' } }));
        return list.length > 0;
    };
    const fired = fireChange({ fttV2: 'panelMaxWidth' }, '1600');
    await new Promise((r) => setTimeout(r, 0));
    const stored = Number(getSettings().panelMaxWidth);
    const varNow = cssVar();
    const { cfg } = await import('../../core/model/runtime.js');
    const notInCfg = !Object.prototype.hasOwnProperty.call(cfg, 'panelMaxWidth');
    resetSettings();
    await panelAction('refresh', {});
    return fired && before === 1280 && stored === 1600 && varNow === '1600px' && notInCfg;
})(), null);

un();
R.done();
