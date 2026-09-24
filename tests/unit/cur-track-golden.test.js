// ============================================================
// 单元测试 · B9-c 货币追踪「👥 指定角色」标定选择器
//   （**与真实 V1 插件 v1.206 逐项比对** + V2 面板编排/接线）
// 黄金样本：tests/fixtures/v1-golden-cur-track.json
//   oracle = 真实 V1 插件 v1.206：`knownCharacterNames` / `trackedCurrencyRoles` / `add·remove·clear` /
//   `isTrackedCurrencyOwner` / `trackPickState` / `setTrackPick` / `buildCurrencyTrackedSection` /
//   `buildCurrencyLedgerText` 直接调 `__FTT` 导出函数；动作 `curTrackPick` / `curTrackClose` /
//   `curTrackToggle` / `curTrackClear` 与切页走**真实点击委托**（openPanel() 后派发伪事件 → V1 `handleAction`
//   真实执行），货币页 HTML 取自 `panel.innerHTML`（`currenciesHtml` 未导出，仅经 `panelHtml()` 可达）。
// 覆盖：
//   R 组（与 V1 逐项比对）：样本与源码证据 / knownCharacterNames（档案去重 + `localeCompare` 排序）/
//     trackedRoles 14 步（增删清空 + 简称包含匹配）/ trackPick 6 步 / 提示词段与货币账本（标定前后）/
//     货币页三态投影 / 动作序 11 步（名单·开关·toast·页面投影）/ 空档案与搜索态；
//   V 组（V2 编排/接线）：货币页接线（胶囊/说明/按钮 title/选择器）/ 端到端（打开→标定→胶囊→清空）/
//     空名 toggle 不改动 + V1「简称包含」怪癖 / `curTrackClose` 与再点开关等价 / 分析提示词接线（标定段恒定追加）。
// 与 V1 的必要偏离（本文件断言其差异，登记于 docs/P9b-B9投喂标签与货币追踪.md）：
//   ① 选择器搜索框：V1 是通用筛选条（字段/排序/额外条件/模式 4 下拉 + 计数 + 清除），V2 沿用「选角色」面板约定
//      的单输入框（`data-ftt-search="currencyTrackPick"`），搜索词仍走同一页面搜索词槽；
//   ② 追踪按钮的行内属性名：V1 用 `data-ftt-name`，V2 面板 DOM 委托读 `dataset.name` → 用 `data-name`（B9-b 起既定）；
//   ③ V1 `notify(title,text)` 的 V2 等价：note = `title：text`（单行面板提示；V1 用 toastr 两行）。
// 运行：node tests/unit/cur-track-golden.test.js（或由 run.js 统一调用）
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setIdentityView } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    normalizeCurrency, trackedCurrencyRoles, isTrackedCurrencyOwner, knownCharacterNames,
    addTrackedCurrencyRole, removeTrackedCurrencyRole, clearTrackedCurrencyRoles, trackPickState, setTrackPick,
    defaultCurrencyOwner,
} from '../../core/model/money.js';
import { normalizeTrackedRoles } from '../../core/model/scalars.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-cur-track.json'), 'utf8'));
const R = makeReporter('cur-track-golden B9-c 货币追踪「👥 指定角色」标定（V1 黄金样本逐项比对）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/**
 * 货币页 HTML 投影（与 oracle 生成器同一套；**属性前缀无关**）：
 *   V1 用 `data-ftt-action` / `data-ftt-name`，V2 面板委托读 `dataset.fttAction` / `dataset.name`
 *   → 动作名两边一致（`data-ftt-action`），称呼属性用 `data-(?:ftt-)?name` 兼容。
 */
function projCurPage(h) {
    const s = String(h || '');
    const grab = (re) => { const m = s.match(re); return m ? m[1] : null; };
    const chip = grab(/<div class="ftt-cat-stat ftt-chip">([\s\S]*?)<\/div>/);
    const btn = (action) => {
        const m = s.match(new RegExp('<button class="([^"]*)" data-ftt-action="' + action + '" title="([^"]*)">([^<]*)</button>'));
        return m ? { cls: m[1], title: m[2], text: m[3] } : null;
    };
    const toggles = [];
    {
        const re = /<button class="(ftt-op[^"]*)" data-ftt-action="curTrackToggle" data-(?:ftt-)?name="([^"]*)" title="([^"]*)">([^<]*)<\/button>/g;
        let m;
        while ((m = re.exec(s))) toggles.push({ cls: m[1], name: m[2], title: m[3], text: m[4], on: m[1].indexOf('ftt-ok') >= 0 });
    }
    const chipNames = [];
    {
        const re = /<span class="ftt-badge ftt-badge--fact">([^<]*)<span class="ftt-rel-jump" data-ftt-action="curTrackToggle" data-(?:ftt-)?name="([^"]*)" title="([^"]*)"> ✖<\/span><\/span>/g;
        let m;
        while ((m = re.exec(s))) chipNames.push({ name: m[1], action: 'curTrackToggle', title: m[3] });
    }
    return {
        statChip: chip === null ? null : chip.replace(/\s+/g, ' ').trim(),
        noteMain: s.indexOf('💰 默认只记<b>主角</b>') >= 0,
        noteText: grab(/<div class="ftt-note ftt-note-info">(💰 默认只记[\s\S]*?)<\/div>/),
        hasTrackChips: s.indexOf('data-ftt-track-chips') >= 0,
        chipNames: chipNames,
        chipNote: grab(/<span class="ftt-muted">(被标定后：[\s\S]*?)<\/span><\/div>/),
        pickBtn: btn('curTrackPick'),
        clearBtn: btn('curTrackClear'),
        pickerTitle: grab(/<div class="ftt-editor-title">([^<]*)<\/div>/),
        pickerNote: grab(/<div class="ftt-muted ftt-w-full">(被标定的角色：[\s\S]*?)<\/div>/),
        pickerSearch: s.indexOf('data-ftt-search="currencyTrackPick"') >= 0,
        pickerSearchHint: grab(/data-ftt-search="currencyTrackPick"[^>]*placeholder="([^"]*)"/),
        pickerClose: s.indexOf('data-ftt-action="curTrackClose"') >= 0,
        pickerCloseText: grab(/data-ftt-action="curTrackClose">([^<]*)<\/button>/),
        toggleBtns: toggles,
        emptyArchive: grab(/<div class="ftt-empty">([^<]*)<\/div>/),
        emptyNoMatch: grab(/<div class="ftt-empty">无匹配角色（搜索：([^<]*)）<\/div>/),
    };
}

/** 与 oracle 同一场景（角色档案 4 条含重名 + 3 条货币 + 主角标签） */
function scenario() {
    const snaps = clone(G.actionFlow.steps.length ? [
        { id: 'sn1', name: '角色甲', tags: ['主角'] },
        { id: 'sn2', name: '角色乙', tags: [] },
        { id: 'sn3', name: '角色丙', tags: [] },
        { id: 'sn4', name: '角色甲', tags: [] },
    ] : []);
    const curs = [
        { 归属: '角色甲', 币种: '银元', 额度: 1250, 单位: '枚', 日期: '1919-11-01' },
        { 归属: '角色乙', 币种: '贝壳', 额度: 30000, 日期: '1919-11-02', 收支: [{ 日期: '1919-11-02', 增减: '收入', 数额: 5000, 说明: '卖鱼' }] },
        { 归属: '角色丙', 币种: '金条', 额度: 7 },
    ];
    return { snapshots: snaps, currencies: curs.map((c) => normalizeCurrency(c)) };
}

let host = null;
let un = null;
let VFAILS = [];

function boot(opts) {
    const o = opts || {};
    host = makeHost({});
    un = installGlobalHost(host, doc);
    Object.assign(cfg, clone(defaultCfg));
    cfg.currencyEnabled = true;
    cfg.currencyDynamicEnabled = true;
    cfg.currencyTrackedRoles = [];
    setScopeKey('角色甲');
    // V1 oracle 环境提供 `getCurrentCharacterName() → '角色甲'`；V2 的等价注入是身份视图（宿主层注入）
    setIdentityView({ characterName: '角色甲' });
    setLastMessageId(3);
    const sc = scenario();
    setKernelState(Object.assign(emptyState(), {
        snapshots: o.noSnapshots ? [] : sc.snapshots,
        currencies: sc.currencies,
        state: { date: '1919-11-29', time: '', location: '', sceneFocus: null, present: ['角色甲'] },
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
    setTrackPick(!!o.picking);
    // 复位选择器搜索词槽（`ps.q` 是面板级状态，跨用例粘性；V1 `pageSearchQuery` 同性质）
    void panelAction('search', { kind: 'currencyTrackPick', q: '' });
    return state;
}

/** detail 传**函数**（惰性求值：只在失败时收集现场） */
const A = async (name, fn, detailFn) => {
    let cond = false, extra = '';
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    if (cond !== true && !extra && typeof detailFn === 'function') { try { extra = detailFn(); } catch (e) { extra = String((e && e.message) || e); } }
    R.assert(name, cond === true, extra);
};

boot();

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================

await A('R1 黄金样本与 V1 源码证据齐备（v1.206 / 十个片段 / 四个动作 / 选择器与提示词口径 / 怪癖 7 条）', () => {
    const s = G.meta.v1SourceSnips || {};
    const need = ['curTrackPick', 'curTrackClear', 'currenciesHead', 'currencyPicker', 'trackPickState',
        'knownCharacterNames', 'addTracked', 'buildCurrencyTrackedSection', 'buildCurrencyLedgerText', 'exports'];
    return G.meta.v1Version === 'v1.206'
        && need.every((k) => typeof s[k] === 'string' && s[k].length > 40)
        // curTrackPick 是纯开关；curTrackClear 走 toast（含条数）
        && s.curTrackPick.indexOf('currencyTrackPicking = !currencyTrackPicking') > 0
        && s.curTrackClear.indexOf('clearTrackedCurrencyRoles()') > 0
        // 选择器：角色来源 = knownCharacterNames；已标定判定 = 去空白 + 小写
        && s.currencyPicker.indexOf('knownCharacterNames()') > 0
        && s.currencyPicker.indexOf("replace(/\\s+/g, '').toLowerCase()") > 0
        // 提示词段：{{标定角色}} / {{角色}} 占位替换
        && s.buildCurrencyTrackedSection.indexOf("split('{{标定角色}}')") > 0
        && s.buildCurrencyTrackedSection.indexOf("split('{{角色}}')") > 0
        // 导出清单含名单访问器与选择器开关
        && s.exports.indexOf('trackedCurrencyRoles') > 0 && s.trackPickState.indexOf('currencyTrackPicking') > 0
        && (G.meta.notes || []).some((n) => n.indexOf('简称包含') >= 0);
}, () => Object.keys(G.meta.v1SourceSnips || {}));

await A('R2 `knownCharacterNames`：只读角色档案、按名去重、`localeCompare` 升序（4 条档案含重名 → 3 名，顺序与 V1 逐值一致）', () => {
    boot();
    const got = knownCharacterNames();
    return J(got) === J(G.knownNames.out) && got.length === 3
        && J(G.knownNames.out) === J(['角色丙', '角色乙', '角色甲']);
}, () => ({ got: knownCharacterNames(), want: G.knownNames.out }));

await A('R3 `trackedCurrencyRoles` / 增删清空 / `isTrackedCurrencyOwner`：14 步（含重复、空名、简称包含）与 V1 逐值一致', () => {
    boot();
    const t = [];
    const obs = () => clone(trackedCurrencyRoles());
    t.push({ call: 'trackedCurrencyRoles()（初始空）', out: obs() });
    t.push({ call: "addTrackedCurrencyRole('角色乙')", out: clone(addTrackedCurrencyRole('角色乙')) });
    t.push({ call: "addTrackedCurrencyRole('角色丙')", out: clone(addTrackedCurrencyRole('角色丙')) });
    t.push({ call: "addTrackedCurrencyRole('角色乙')（重复）", out: clone(addTrackedCurrencyRole('角色乙')) });
    t.push({ call: "addTrackedCurrencyRole('   ')（空名）", out: clone(addTrackedCurrencyRole('   ')) });
    t.push({ call: "isTrackedCurrencyOwner('角色乙')", out: isTrackedCurrencyOwner('角色乙') });
    t.push({ call: "isTrackedCurrencyOwner(' 角色乙 ')", out: isTrackedCurrencyOwner(' 角色乙 ') });
    t.push({ call: "isTrackedCurrencyOwner('角色甲')", out: isTrackedCurrencyOwner('角色甲') });
    t.push({ call: "isTrackedCurrencyOwner('')", out: isTrackedCurrencyOwner('') });
    t.push({ call: "removeTrackedCurrencyRole('角色乙')", out: clone(removeTrackedCurrencyRole('角色乙')) });
    t.push({ call: "removeTrackedCurrencyRole('角色乙')（已不在）", out: clone(removeTrackedCurrencyRole('角色乙')) });
    t.push({ call: 'clearTrackedCurrencyRoles()（返回清空条数）', out: clearTrackedCurrencyRoles() });
    t.push({ call: 'clearTrackedCurrencyRoles()（已空）', out: clearTrackedCurrencyRoles() });
    t.push({ call: 'trackedCurrencyRoles()（清空后）', out: obs() });
    // 简称包含匹配（V1 原生口径）
    cfg.currencyTrackedRoles = ['角色'];
    t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('角色乙')（简称包含 → true）", out: isTrackedCurrencyOwner('角色乙') });
    t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('角色')", out: isTrackedCurrencyOwner('角色') });
    t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('旁人')", out: isTrackedCurrencyOwner('旁人') });
    // 命中判定（含包含）走移除分支，但移除只做**精确**匹配 → 名单不变（V1 原生不一致）
    removeTrackedCurrencyRole('角色乙');
    t.push({ call: "cfg=['角色'] + removeTrackedCurrencyRole('角色乙')（命中判定通过但精确匹配不到 → 名单不变）", out: clone(trackedCurrencyRoles()) });
    removeTrackedCurrencyRole('角色');
    t.push({ call: "承接上一步 + removeTrackedCurrencyRole('角色')（精确命中 → 清空）", out: clone(trackedCurrencyRoles()) });
    const want = G.trackedRoles.transitions;
    const fails = [];
    t.forEach((x, i) => { if (J(x.out) !== J(want[i].out)) fails.push(i + ' ' + x.call + ' → ' + J(x.out) + '≠' + J(want[i].out)); });
    VFAILS = fails;
    return fails.length === 0 && t.length === want.length && want.length === 19;
}, () => ({ fails: VFAILS, got: trackedCurrencyRoles() }));

await A('R4 `trackPickState` / `setTrackPick`：6 步（真值化 / 0 / undefined）与 V1 逐值一致，且每次返回当前值', () => {
    boot();
    const t = [];
    t.push({ call: 'trackPickState()（初始）', out: trackPickState() });
    t.push({ call: 'setTrackPick(true)', out: setTrackPick(true) });
    t.push({ call: 'trackPickState()', out: trackPickState() });
    t.push({ call: "setTrackPick('x')（真值化）", out: setTrackPick('x') });
    t.push({ call: 'setTrackPick(0)', out: setTrackPick(0) });
    t.push({ call: 'setTrackPick(undefined)', out: setTrackPick(undefined) });
    setTrackPick(false);
    const want = G.trackPick.transitions;
    return J(t.map((x) => x.out)) === J(want.map((x) => x.out)) && t.length === 6
        && G.trackPick.finalOut === false && trackPickState() === false;
}, () => ({ got: G.trackPick.transitions.map((x) => x.call) }));

await A('R5 提示词接线：未标定 → 不追加「标定跟踪」段、账本只含主角；标定后 → 段文本与 V1 **逐字节一致**、账本纳入标定角色且不含未标定角色', async () => {
    boot();
    cfg.currencyTrackedRoles = [];
    const p0 = await buildSummaryPrompt('角色甲数了数银元。', ['currencies']);
    const sys0 = String(p0[0].content), usr0 = String(p0[1].content);
    addTrackedCurrencyRole('角色乙');
    const p1 = await buildSummaryPrompt('角色甲数了数银元。', ['currencies']);
    const sys1 = String(p1[0].content), usr1 = String(p1[1].content);
    const offOk = sys0.indexOf('【货币 · 标定跟踪】') < 0 && G.trackedSection.offHasSection === false;
    const onOk = sys1.indexOf(G.trackedSection.on) >= 0 && G.trackedSection.onHasSection === true
        && String(G.trackedSection.on).indexOf('角色乙。') > 0;
    const ledgerOk = usr0.indexOf('角色甲·银元') >= 0 && usr0.indexOf('角色乙·贝壳') < 0
        && usr1.indexOf('角色乙·贝壳') >= 0 && usr1.indexOf('角色丙·金条') < 0
        && G.trackedSection.ledgerHasMe === true && G.trackedSection.ledgerOffHasOther === false
        && G.trackedSection.ledgerOnHasOther === true && G.trackedSection.ledgerStillLacksUntracked === false;
    return offOk && onOk && ledgerOk;
}, () => ({ on: G.trackedSection.on.slice(0, 60), ledgerOn: G.trackedSection.ledgerOnHasOther }));

await A('R6 货币页三态投影（未标定·选择器关闭 / 打开选择器 / 再点关闭）：胶囊·说明·按钮 title·选择器结构 与 V1 逐步一致', async () => {
    boot();
    openPanel('currencies');
    const steps = [G.actionFlow.steps[0], G.actionFlow.steps[1], G.actionFlow.steps[2]];
    const got = [];
    for (const s of steps) {
        if (s.ds.fttAction === 'curTrackPick') await panelAction('curTrackPick', {});
        else await panelAction('tab', { tab: s.ds.fttTab });
        got.push(projCurPage(panelBodyHtml('currencies')));
    }
    // 第 0 步在 openPanel 后（未点任何动作）；此处先取「切到货币页」的基线再逐步
    boot();
    openPanel('currencies');
    const base = projCurPage(panelBodyHtml('currencies'));
    await panelAction('curTrackPick', {});
    const open = projCurPage(panelBodyHtml('currencies'));
    await panelAction('curTrackPick', {});
    const closed = projCurPage(panelBodyHtml('currencies'));
    const fails = [];
    if (J(base) !== J(steps[0].page)) fails.push('base');
    if (J(open) !== J(steps[1].page)) fails.push('open');
    if (J(closed) !== J(steps[2].page)) fails.push('closed');
    VFAILS = fails;
    return fails.length === 0 && base.hasTrackChips === false && base.pickBtn.cls === 'ftt-btn'
        && open.pickBtn.cls === 'ftt-btn ftt-primary' && open.toggleBtns.length === 3 && closed.toggleBtns.length === 0
        && steps[0].page.statChip === '共 3 条货币 · 3 个归属（角色甲 1 / 角色乙 1 / 角色丙 1）';
}, () => ({ fails: VFAILS, base: projCurPage(panelBodyHtml('currencies')).statChip }));

await A('R7 动作序 11 步（真实点击委托）：标定名单 / 选择器开关 / toast（kind+title+text）/ 页面投影 逐步与 V1 一致', async () => {
    boot();
    openPanel('currencies');
    const fails = [];
    // 面板 note 是**粘性**的（V1 用 toastr 队列，V2 用单行 note）→ 期望值 = 最近一次提示的合成文本
    let expectNote = String((await panelAction('refresh', {})).state.note || '');
    for (let i = 0; i < G.actionFlow.steps.length; i++) {
        const s = G.actionFlow.steps[i];
        let r;
        if (s.ds.fttAction === 'pageSwitch') {
            // oracle 该步之前有一次未记录的 `curTrackToggle 角色乙`（标定后切页返回）
            await panelAction('curTrackToggle', { name: '角色乙' });
            expectNote = '已标定「角色乙」：后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。';
            await panelAction('tab', { tab: 'overview' });
            r = await panelAction('tab', { tab: 'currencies' });
        } else if (s.ds.fttTab) r = await panelAction('tab', { tab: s.ds.fttTab });
        else r = await panelAction(s.ds.fttAction, { name: s.ds.fttName });
        if (J(trackedCurrencyRoles()) !== J(s.tracked)) fails.push(i + ' tracked');
        if (trackPickState() !== s.picking) fails.push(i + ' picking');
        if (J(cfg.currencyTrackedRoles) !== J(s.cfgRoles)) fails.push(i + ' cfgRoles');
        // toast（V1 `toast(text)` 无标题 → note = text；`notify(title,text)` → note = `title：text`）
        const t = (s.toasts || [])[0] || null;
        if (t) expectNote = t.title ? (t.title + '：' + t.text) : t.text;
        const note = String((r && r.state && r.state.note) || '');
        if (note !== expectNote) fails.push(i + ' note ' + J(note) + '≠' + J(expectNote));
        if (s.page && J(projCurPage(panelBodyHtml('currencies'))) !== J(s.page)) fails.push(i + ' page');
    }
    VFAILS = fails;
    return fails.length === 0 && G.actionFlow.steps.length === 12;
}, () => ({ fails: VFAILS, tracked: trackedCurrencyRoles(), picking: trackPickState() }));

await A('R8 空角色档案 / 搜索无匹配 / 搜索命中三态：空态文案与过滤结果与 V1 一致（搜索词走页面搜索词槽）', async () => {
    // 空档案（oracle 该态已标定 1 名 —— 与动作序同步）
    boot({ noSnapshots: true });
    addTrackedCurrencyRole('角色乙');
    openPanel('currencies');
    await panelAction('curTrackPick', {});
    const empty = projCurPage(panelBodyHtml('currencies'));
    // 有档案 + 搜索（无匹配 / 命中）
    boot();
    addTrackedCurrencyRole('角色乙');
    openPanel('currencies');
    await panelAction('curTrackPick', {});
    await panelAction('search', { kind: 'currencyTrackPick', q: '不存在' });
    const noMatch = projCurPage(panelBodyHtml('currencies'));
    await panelAction('search', { kind: 'currencyTrackPick', q: '乙' });
    const hit = projCurPage(panelBodyHtml('currencies'));
    const fails = [];
    if (J(empty) !== J(G.emptyArchive.page)) fails.push('empty');
    if (J(noMatch) !== J(G.noMatch.page)) fails.push('noMatch');
    if (J(hit) !== J(G.searchHit.page)) fails.push('hit');
    VFAILS = fails;
    return fails.length === 0
        && noMatch.emptyNoMatch === '不存在' && noMatch.toggleBtns.length === 0
        && hit.toggleBtns.length === 1 && hit.toggleBtns[0].name === '角色乙'
        && empty.emptyArchive === '「角色」大类暂无已知角色：先运行「AI 摘要」生成角色档案，或在角色页添加角色。';
}, () => ({ fails: VFAILS, empty: projCurPage(panelBodyHtml('currencies')).emptyArchive }));

// ============================================================
// V 组：V2 编排 / 接线
// ============================================================

await A('V1 货币页接线：统计胶囊（含「已标定 N 名」）/ 说明 / 「👥 指定角色（N）」与「✖ 清空标定」的 title 逐字 / 选择器结构', async () => {
    boot();
    openPanel('currencies');
    const off = projCurPage(panelBodyHtml('currencies'));
    setTrackPick(true);
    await panelAction('curTrackToggle', { name: '角色乙' });
    const on = projCurPage(panelBodyHtml('currencies'));
    const want = G.actionFlow.steps[4].page;      // 标定 1 名 + 选择器打开
    return off.statChip === '共 3 条货币 · 3 个归属（角色甲 1 / 角色乙 1 / 角色丙 1）'
        && off.clearBtn === null && off.pickBtn.text === '👥 指定角色'
        && off.pickBtn.title === '从「角色」大类里指定要跟踪货币的角色（可多选；被标定后分析记忆会同时考虑其货币情况）'
        && off.noteText === want.noteText
        && J(on.chipNames) === J(want.chipNames) && on.chipNote === want.chipNote
        && on.pickBtn.text === '👥 指定角色（1）' && on.clearBtn.text === '✖ 清空标定'
        && on.clearBtn.title === '取消全部标定角色' && on.clearBtn.cls === 'ftt-btn ftt-err'
        && on.statChip === '共 3 条货币 · 3 个归属（角色甲 1 / 角色乙 1 / 角色丙 1） · 已标定 1 名'
        && on.pickerTitle === '👥 指定跟踪角色 · 从「角色」大类选择（已标定 1 名）'
        && on.pickerNote === want.pickerNote && on.pickerSearch && on.pickerCloseText === '关闭';
}, () => ({ stat: projCurPage(panelBodyHtml('currencies')).statChip }));

await A('V2 端到端：打开选择器 → 标定两名 → 胶囊/角标/✅ 递增 → 「✖ 清空标定」清空并回报条数；分析提示词同步纳入', async () => {
    boot();
    openPanel('currencies');
    await panelAction('curTrackPick', {});
    const a1 = await panelAction('curTrackToggle', { name: '角色乙' });
    const a2 = await panelAction('curTrackToggle', { name: '角色丙' });
    const on = projCurPage(panelBodyHtml('currencies'));
    const prompt = String((await buildSummaryPrompt('正文', ['currencies']))[0].content);
    const trackedBefore = clone(trackedCurrencyRoles());
    const cl = await panelAction('curTrackClear', {});
    const off = projCurPage(panelBodyHtml('currencies'));
    const conds = [
        J(trackedBefore) === J(G.actionFlow.steps[5].tracked),
        String(a1.state.note) === '已标定「角色乙」：后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。',
        String(a2.state.note) === '已标定「角色丙」：后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。',
        on.statChip.indexOf('已标定 2 名') > 0 && on.pickBtn.text === '👥 指定角色（2）',
        on.toggleBtns.filter((t) => t.on).length === 2,
        J(on.chipNames.map((x) => x.name)) === J(['角色乙', '角色丙']),
        prompt.indexOf('角色乙、角色丙') > 0,
        String(cl.state.note) === '已清空 2 个标定角色' && cl.ok === true,
        J(off.chipNames) === J([]) && off.clearBtn === null && trackedCurrencyRoles().length === 0,
    ];
    VFAILS = conds.map((x, i) => i + ':' + x);
    return conds.every(Boolean);
}, () => ({ conds: VFAILS, tracked: trackedCurrencyRoles() }));

await A('V3 空名 toggle 不改动且**无新提示**；V1 原生不一致怪癖：标定为「角色」时点「角色乙」→ 提示「已取消标定」但名单**实际保留**（原样保留，未"顺手修正"）', async () => {
    boot();
    openPanel('currencies');
    await panelAction('curTrackPick', {});
    const before = String((await panelAction('refresh', {})).state.note || '');
    const e = await panelAction('curTrackToggle', { name: '   ' });
    const noop = trackedCurrencyRoles().length === 0 && String(e.state.note) === before;
    // 简称包含命中的「移除」：命中判定为 true → 走移除分支并提示；精确匹配不到 → 名单不变
    cfg.currencyTrackedRoles = ['角色'];
    const t = await panelAction('curTrackToggle', { name: '角色乙' });
    const kept = J(trackedCurrencyRoles()) === J(['角色'])
        && String(t.state.note) === '已取消标定「角色乙」'
        && J(G.trackedRoles.transitions[G.trackedRoles.transitions.length - 2].out) === J(['角色']);
    // 精确命中 → 真正移除
    const t2 = await panelAction('curTrackToggle', { name: '角色' });
    const gone = J(trackedCurrencyRoles()) === J([]) && String(t2.state.note) === '已取消标定「角色」';
    return noop && kept && gone && isTrackedCurrencyOwner('角色') === false;
}, () => ({ tracked: trackedCurrencyRoles(), note: '' }));

await A('V4 `curTrackClose` 与 `curTrackPick` 再点等价（都置 false，均无新提示）；开关态跨切页保留、切页不改名单', async () => {
    boot();
    openPanel('currencies');
    await panelAction('curTrackToggle', { name: '角色乙' });      // 先标定（选择器仍关）
    const n0 = String((await panelAction('refresh', {})).state.note || '');
    const open1 = await panelAction('curTrackPick', {});
    const close1 = await panelAction('curTrackClose', {});
    const open2 = await panelAction('curTrackPick', {});
    const close2 = await panelAction('curTrackPick', {});
    await panelAction('tab', { tab: 'overview' });                 // 切走
    const back = await panelAction('tab', { tab: 'currencies' });  // 切回
    const after = projCurPage(panelBodyHtml('currencies'));
    return trackPickState() === false
        && [open1, close1, open2, close2, back].every((r) => String(r.state.note || '') === n0)
        && J(trackedCurrencyRoles()) === J(['角色乙'])
        && after.pickerTitle === null && after.chipNames.length === 1
        && after.chipNames[0].name === '角色乙'
        && J(G.actionFlow.steps[11].tracked) === J(['角色乙']);
}, () => ({ picking: trackPickState(), tracked: trackedCurrencyRoles() }));

await A('V5 名单归一与默认归属接线：`normalizeTrackedRoles` 兼容字符串/去重/上限 12；`defaultCurrencyOwner` 取带「主角」标签的档案', () => {
    boot();
    const byStr = normalizeTrackedRoles('角色乙，角色丙、角色乙;角色丁');
    const many = normalizeTrackedRoles(Array.from({ length: 20 }, (_, i) => '角色' + i).concat(['角色0', '  ', '']));
    const dirty = [normalizeTrackedRoles(null).length, normalizeTrackedRoles(undefined).length, normalizeTrackedRoles(123).length];
    return J(byStr) === J(['角色乙', '角色丙', '角色丁'])
        && many.length === 12 && many[0] === '角色0'
        && J(dirty) === J([0, 0, 0])
        && defaultCurrencyOwner() === '角色甲'
        && (() => { state.protagonist = { name: '正主' }; const v = defaultCurrencyOwner(); delete state.protagonist; return v === '正主'; })();
}, () => ({ owner: defaultCurrencyOwner(), many: normalizeTrackedRoles(Array.from({ length: 20 }, (_, i) => '角色' + i)).length }));

un();
R.done();
