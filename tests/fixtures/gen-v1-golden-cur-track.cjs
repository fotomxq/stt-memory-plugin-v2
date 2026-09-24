'use strict';
// ============================================================
// B9-c oracle（货币追踪）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-cur-track.json
//   （货币页「👥 指定角色」标定 UI + 动作 curTrackPick / curTrackClose / curTrackToggle / curTrackClear
//     + trackPickState/setTrackPick + trackedCurrencyRoles/add/remove/clear + knownCharacterNames
//     + buildCurrencyTrackedSection / buildCurrencyLedgerText）
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
//   `curTrack*` 不在 V1 `__FTT` 导出清单（属 handleAction 的 case），故走**真实点击委托**：
//   `F.openPanel()` → `panel.listeners.click` 派发伪事件；货币页 HTML 取自 `panel.innerHTML`。
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, pluginToasts } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}

const SCEN = {
    snapshots: [
        { id: 'sn1', name: '角色甲', tags: ['主角'], identity: {}, floorStart: 0, floorEnd: 0, uses: 0 },
        { id: 'sn2', name: '角色乙', tags: [], identity: {}, floorStart: 0, floorEnd: 0, uses: 0 },
        { id: 'sn3', name: '角色丙', tags: [], identity: {}, floorStart: 0, floorEnd: 0, uses: 0 },
        { id: 'sn4', name: '角色甲', tags: [], identity: {}, floorStart: 0, floorEnd: 0, uses: 0 },
    ],
    currencies: [
        { id: 'cu1', owner: '角色甲', name: '银元', amount: 1250, unit: '枚', date: '1919-11-01', history: [], note: '' },
        { id: 'cu2', owner: '角色乙', name: '贝壳', amount: 30000, unit: '', date: '1919-11-02', history: [{ date: '1919-11-02', delta: 5000, note: '卖鱼' }], note: '' },
        { id: 'cu3', owner: '角色丙', name: '金条', amount: 7, unit: '', date: '', history: [], note: '' },
    ],
};

/**
 * 货币页 HTML 投影（结构化 + **属性前缀无关**，V1 `data-ftt-*` 与 V2 `data-*` 共用同一投影）：
 *   V1 用 `data-ftt-action/-name`；V2 面板 DOM 委托读 `dataset.fttAction` / `dataset.name`（B9-b 起的既定约定），
 *   故此处对 `name` 用 `data-(?:ftt-)?name` 兼容两边，动作名两边一致（`data-ftt-action`）。
 */
function projCurPage(h) {
    const s = String(h || '');
    const grab = (re, i) => { const m = s.match(re); return m ? m[i === undefined ? 1 : i] : null; };
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
        hasTrackChips: s.indexOf('data-ftt-track-chips') >= 0 || s.indexOf('data-track-chips') >= 0,
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

async function main() {
    const g = global;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (fn) => { try { fn(); } catch (e) { } return 0; };

    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { F.cfg.storage[k] = false; });
    F.cfg.storage.localStorage = true; F.cfg.storage.syncOnSave = false; F.cfg.storage.autoIdleCheck = false;
    F.cfg.currencyEnabled = true; F.cfg.currencyDynamicEnabled = true;
    F.cfg.currencyTrackedRoles = [];
    F.setTrackPick(false);
    F.state = Object.assign({}, F.state, {
        atoms: [], currentStates: [], snapshots: proj(SCEN.snapshots), memories: [], items: [],
        plans: [], suspense: [], scenes: [], concepts: [], parallels: [], links: [], plotSegments: [], rumors: [],
        currencies: proj(SCEN.currencies).map((c) => F.normalizeCurrency({
            归属: c.owner, 币种: c.name, 额度: c.amount, 单位: c.unit, 日期: c.date,
            收支: (c.history || []).map((x) => ({ 日期: x.date, 增减: x.amount >= 0 ? '收入' : '支出', 数额: x.delta, 说明: x.note })),
        })),
        vars: {}, processedFloors: [], lastKnownFloor: -1, summaries: [],
        state: { date: '1919-11-29', time: '', location: '', sceneFocus: null, present: ['角色甲'] },
    });

    const result = { meta: { v1Version: 'v1.206', notes: [], sourceFile: 'src/FTT记忆组件-v1.206.js' } };

    // ---------------- 零、V1 源码片段 ----------------
    result.meta.v1SourceSnips = {
        curTrackPick: snip("case 'curTrackPick': {", "case 'curTrackClear': {"),
        curTrackClear: snip("case 'curTrackClear': {", '// ==================== v1.184'),
        currenciesHead: snip('function currenciesHtml() {', 'const picker = (() => {'),
        currencyPicker: snip('const picker = (() => {', 'return head + trackChips + picker + listBody'),
        trackPickState: snip('function trackPickState() {', '// v1.186：设定子页读写'),
        knownCharacterNames: snip('function knownCharacterNames() {', '// 收支合并'),
        addTracked: snip('function addTrackedCurrencyRole(name) {', 'function clearTrackedCurrencyRoles() {'),
        buildCurrencyTrackedSection: snip('function buildCurrencyTrackedSection() {', '// v1.183：当前货币账本'),
        buildCurrencyLedgerText: snip('function buildCurrencyLedgerText() {', 'async function buildSummaryPrompt(', 1800),
        exports: snip('normalizeTrackedRoles, trackedCurrencyRoles, isTrackedCurrencyOwner, knownCharacterNames,', '\n', 300),
    };

    // ---------------- 一、纯函数 / 状态 ----------------
    result.knownNames = { out: proj(F.knownCharacterNames()) };

    {
        F.cfg.currencyTrackedRoles = [];
        const t = [];
        const obs = () => proj(F.trackedCurrencyRoles());
        t.push({ call: 'trackedCurrencyRoles()（初始空）', out: obs() });
        t.push({ call: "addTrackedCurrencyRole('角色乙')", out: proj(F.addTrackedCurrencyRole('角色乙')) });
        t.push({ call: "addTrackedCurrencyRole('角色丙')", out: proj(F.addTrackedCurrencyRole('角色丙')) });
        t.push({ call: "addTrackedCurrencyRole('角色乙')（重复）", out: proj(F.addTrackedCurrencyRole('角色乙')) });
        t.push({ call: "addTrackedCurrencyRole('   ')（空名）", out: proj(F.addTrackedCurrencyRole('   ')) });
        t.push({ call: "isTrackedCurrencyOwner('角色乙')", out: F.isTrackedCurrencyOwner('角色乙') });
        t.push({ call: "isTrackedCurrencyOwner(' 角色乙 ')", out: F.isTrackedCurrencyOwner(' 角色乙 ') });
        t.push({ call: "isTrackedCurrencyOwner('角色甲')", out: F.isTrackedCurrencyOwner('角色甲') });
        t.push({ call: "isTrackedCurrencyOwner('')", out: F.isTrackedCurrencyOwner('') });
        t.push({ call: "removeTrackedCurrencyRole('角色乙')", out: proj(F.removeTrackedCurrencyRole('角色乙')) });
        t.push({ call: "removeTrackedCurrencyRole('角色乙')（已不在）", out: proj(F.removeTrackedCurrencyRole('角色乙')) });
        t.push({ call: 'clearTrackedCurrencyRoles()（返回清空条数）', out: F.clearTrackedCurrencyRoles() });
        t.push({ call: 'clearTrackedCurrencyRoles()（已空）', out: F.clearTrackedCurrencyRoles() });
        t.push({ call: 'trackedCurrencyRoles()（清空后）', out: obs() });
        // 简称包含匹配（V1 原生口径：`k.indexOf(o) >= 0 || o.indexOf(k) >= 0`）
        F.cfg.currencyTrackedRoles = ['角色'];
        t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('角色乙')（简称包含 → true）", out: F.isTrackedCurrencyOwner('角色乙') });
        t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('角色')", out: F.isTrackedCurrencyOwner('角色') });
        t.push({ call: "cfg=['角色'] → isTrackedCurrencyOwner('旁人')", out: F.isTrackedCurrencyOwner('旁人') });
        // 「简称包含」命中 → 走移除分支，但 `removeTrackedCurrencyRole` 只做**精确**匹配 → 实际保留（V1 原生不一致）
        F.removeTrackedCurrencyRole('角色乙');
        t.push({ call: "cfg=['角色'] + removeTrackedCurrencyRole('角色乙')（命中判定通过但精确匹配不到 → 名单不变）", out: proj(F.trackedCurrencyRoles()) });
        F.removeTrackedCurrencyRole('角色');
        t.push({ call: "承接上一步 + removeTrackedCurrencyRole('角色')（精确命中 → 清空）", out: proj(F.trackedCurrencyRoles()) });
        result.trackedRoles = { transitions: t };
        F.cfg.currencyTrackedRoles = [];
    }
    {
        const t = [];
        t.push({ call: 'trackPickState()（初始）', out: F.trackPickState() });
        t.push({ call: 'setTrackPick(true)', out: F.setTrackPick(true) });
        t.push({ call: 'trackPickState()', out: F.trackPickState() });
        t.push({ call: "setTrackPick('x')（真值化）", out: F.setTrackPick('x') });
        t.push({ call: 'setTrackPick(0)', out: F.setTrackPick(0) });
        t.push({ call: 'setTrackPick(undefined)', out: F.setTrackPick(undefined) });
        F.setTrackPick(false);
        result.trackPick = { transitions: t, finalOut: F.trackPickState() };
    }

    // 提示词段 / 账本（标定角色参与 + 不参与两态）
    {
        F.cfg.currencyTrackedRoles = [];
        const off = String(F.buildCurrencyTrackedSection());
        const offLedger = String(F.buildCurrencyLedgerText());
        F.addTrackedCurrencyRole('角色乙');
        const on = String(F.buildCurrencyTrackedSection());
        const onLedger = String(F.buildCurrencyLedgerText());
        result.trackedSection = {
            off: off, on: on,
            offHasSection: off.length > 0, onHasSection: on.length > 0,
            ledgerHasMe: offLedger.indexOf('角色甲·银元') >= 0,
            ledgerOffHasOther: offLedger.indexOf('角色乙·贝壳') >= 0,
            ledgerOnHasOther: onLedger.indexOf('角色乙·贝壳') >= 0,
            ledgerStillLacksUntracked: onLedger.indexOf('角色丙·金条') >= 0,
        };
        F.cfg.currencyTrackedRoles = [];
    }

    // ---------------- 二、动作序（真实点击委托） ----------------
    F.setTrackPick(false);
    F.cfg.currencyTrackedRoles = [];
    F.openPanel();
    const panel = env.parentWin.document.body.children.find(c => c.id === 'ftt-panel');
    const listeners = (panel.listeners && panel.listeners.click) ? panel.listeners.click : [];
    const clickFake = async (ds, cls) => {
        const classes = ['ftt-open'].concat(cls || []);
        const keep = panel.classList.contains;
        panel.classList.contains = (c) => (classes.indexOf(c) >= 0 ? true : keep.call(panel, c));
        const fake = {
            target: { dataset: ds, classList: { contains: (c) => classes.indexOf(c) >= 0 }, closest: () => panel, tagName: 'A' },
            preventDefault() { }, stopPropagation() { },
        };
        try { for (const fn of listeners) { try { await fn(fake); } catch (e) { /* 与 V1 委托同容错 */ } } }
        finally { panel.classList.contains = keep; }
    };
    const html = () => String(panel.innerHTML || '');
    const steps = [];
    const step = async (name, ds, cls, extra) => {
        const t0 = pluginToasts(F).length;
        await clickFake(ds, cls);
        const o = {
            ds: ds,
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
            tracked: proj(F.trackedCurrencyRoles()),
            picking: F.trackPickState(),
            cfgRoles: proj(F.cfg.currencyTrackedRoles),
        };
        Object.assign(o, extra ? extra() : {});
        steps.push(Object.assign({ name }, o));
    };
    await step('切到货币页', { fttTab: 'currencies' }, ['ftt-tab'], () => ({ page: projCurPage(html()) }));
    await step('curTrackPick（打开选择器）', { fttAction: 'curTrackPick' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackPick（再点关闭）', { fttAction: 'curTrackPick' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackPick（重新打开）', { fttAction: 'curTrackPick' }, []);
    await step('curTrackToggle 角色乙', { fttAction: 'curTrackToggle', fttName: '角色乙' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackToggle 角色丙', { fttAction: 'curTrackToggle', fttName: '角色丙' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackToggle 角色乙（取消标定）', { fttAction: 'curTrackToggle', fttName: '角色乙' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackToggle 空名（不改动）', { fttAction: 'curTrackToggle', fttName: '   ' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackClose（关闭选择器）', { fttAction: 'curTrackClose' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackClear（清空标定）', { fttAction: 'curTrackClear' }, [], () => ({ page: projCurPage(html()) }));
    await step('curTrackClear（已空）', { fttAction: 'curTrackClear' }, [], () => ({ page: projCurPage(html()) }));
    // 切页形态：标定后（未开选择器）与「本页有标定」两种胶囊
    await clickFake({ fttAction: 'curTrackToggle', fttName: '角色乙' }, []);
    await clickFake({ fttTab: 'overview' }, ['ftt-tab']);
    await clickFake({ fttTab: 'currencies' }, ['ftt-tab']);
    steps.push(Object.assign({
        name: '标定后切页返回货币页（胶囊 + 按钮角标）',
        ds: { fttAction: 'pageSwitch' },
        toasts: [], tracked: proj(F.trackedCurrencyRoles()), picking: F.trackPickState(),
        cfgRoles: proj(F.cfg.currencyTrackedRoles),
    }, { page: projCurPage(html()) }));
    result.actionFlow = { steps };

    // 空角色档案态（选择器打开 + 无角色）
    {
        const keep = F.state.snapshots;
        F.state.snapshots = [];
        F.setTrackPick(true);
        result.emptyArchive = { page: projCurPage(String(F.currenciesHtml ? F.currenciesHtml() : panel.innerHTML)) };
        // currenciesHtml 未导出 → 退回面板重渲染
        await clickFake({ fttAction: 'curTrackClose' }, []);
        await clickFake({ fttAction: 'curTrackPick' }, []);
        result.emptyArchive.page = projCurPage(html());
        F.state.snapshots = keep;
        await clickFake({ fttAction: 'curTrackClose' }, []);
    }

    // 搜索分流（V1 用通用页面搜索词 `pageSearchQuery['currencyTrackPick']`，导出对象可直接写）
    {
        F.pageSearchQuery['currencyTrackPick'] = '不存在';
        await clickFake({ fttAction: 'curTrackPick' }, []);
        result.noMatch = { page: projCurPage(html()) };
        F.pageSearchQuery['currencyTrackPick'] = '乙';
        await clickFake({ fttAction: 'curTrackPick' }, []);      // 关（开关语义）
        await clickFake({ fttAction: 'curTrackPick' }, []);      // 再开
        result.searchHit = { page: projCurPage(html()) };
        F.pageSearchQuery['currencyTrackPick'] = '';
        await clickFake({ fttAction: 'curTrackClose' }, []);
    }

    // ---------------- 三、原生怪癖 ----------------
    result.meta.notes.unshift('本 fixture 由 tests/fixtures/gen-v1-golden-cur-track.cjs **直调真实 V1 插件 v1.206** 生成'
        + '（`node tests/fixtures/gen-v1-golden-cur-track.cjs tests/fixtures/v1-golden-cur-track.json`，连跑两次逐字节一致）。'
        + '其中 curTrackPick / curTrackClose / curTrackToggle / curTrackClear / 切页 走**真实点击委托**'
        + '（openPanel() 后在 panel.listeners.click 上派发伪事件 → V1 handleAction 真实执行；货币页 HTML 取自 panel.innerHTML，'
        + 'V1 currenciesHtml() 未导出、仅经 panelHtml() 可达）；'
        + 'knownCharacterNames / trackedCurrencyRoles / add·remove·clear / isTrackedCurrencyOwner / trackPickState / setTrackPick /'
        + 'buildCurrencyTrackedSection / buildCurrencyLedgerText 直接调 __FTT 导出函数。');
    result.meta.notes.push('V1 原生怪癖（oracle 实测，原样保留）：'
        + '① `curTrackPick` 是**纯开关**（`currencyTrackPicking = !currencyTrackPicking`），不重置搜索词 / 不重置页内其它状态。'
        + '② `curTrackClose` 与 `curTrackPick` 再点一次效果相同（都置 false），但 `curTrackClose` **无任何提示**。'
        + '③ `curTrackToggle` 对空名（trim 后为空）**直接 break**（不提示、不重绘）。'
        + '④ `curTrackClear`/`curTrackToggle` 走 `toast(...)`（kind=info），`curTrackToggle` 的**新增**分支走 `notify(\'success\', …)`（标题不同）。'
        + '⑤ 「✖ 清空标定」按钮只在 `tracked.length` 非空时渲染；「👥 指定角色」按钮恒渲染，标定数进文案角标（`（N）`）且开启选择器时加 `ftt-primary`。'
        + '⑥ 选择器角色名单来自**角色档案**（`knownCharacterNames()`：`state.snapshots[].name` 去重后 `localeCompare` 排序），重名档案只出现一次。'
        + '⑦ 已标定判定在选择器内是**去空白 + 小写**比较（`isOn`）；而 `isTrackedCurrencyOwner` 额外支持**简称包含**匹配（两者口径不同，V1 原样）。');
    result.meta.notes.push('货币页 HTML 取自点击「货币」标签后的 `panel.innerHTML`（V1 `currenciesHtml()` 未导出，仅经 `panelHtml()` 可达）；动作 toast 取自 `F.toastLogGet()`。');

    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    return result;
}

main().then((r) => {
    const text = JSON.stringify(r, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text);
    realStdoutWrite(text);
    process.exit(0);
}).catch((e) => { process.stderr.write('ORACLE FAIL: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
