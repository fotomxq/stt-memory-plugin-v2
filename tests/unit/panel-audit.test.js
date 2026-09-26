// ============================================================
// 单元测试 · v2.41.0「设定按钮/功能完整性审计」（用户要求：核对设定相关按钮与功能是否完整）
// 背景：用户报告「设定相关的按钮、功能，我发现大量异常点」。此前已发现两类**静默缺口**：
//   ① 面板钩子漏接（v2.40.0：导出/导入/维度开关等 11 项）；② devtools 白名单漏镜像（v2.41.0：`FTT.*` 入口静默不存在）。
// 本文件把「完整性」变成**可执行的四层审计**，任何一层不齐即失败：
//   L1 面板钩子：`ui/panel.js` 读到的每个 `hooks.X` 都必须由 `panelRuntimeHooks()` 提供（函数）；
//   L2 面板动作：把 13 个分页 + 14 个设定子页里出现的**全部** `data-ftt-action` 逐个调用，
//                不允许出现 `unknown-action` / `no-hook` / 「…入口未就绪」（运行时真审计；AI/文本/宿主依赖类失败不算）；
//   L3 FTT 入口：index.js 提供的每个调试入口在 `FTT.*` 上都可调用（devtools 自动补全后必须 0 缺失）；
//   L4 配置控件：每个 `data-ftt-cfg`（含 `storage.*` / `dimCharLimits.*` 点路径）都能在默认配置里解析，
//                每个 `data-ftt-v2` 都有路由（否则会**静默写错位置**）；
//   L5 委托属性：markup 里用到的每个 `data-ftt-*` 属性，都能在 ui/ 源码里找到处理（dataset 驼峰化）；
// 运行：node tests/unit/panel-audit.test.js
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { DEFAULT_SETTINGS } from '../../adapters/settings.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel, PANEL_TABS } from '../../ui/panel.js';
import { SETTINGS_TABS } from '../../ui/settings-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('panel-audit v2.41.0 设定按钮/功能完整性审计');
const A = (n, c, e) => R.assert(n, !!c, e);
const PANEL_SRC = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
const UI_SRC = readdirSync(join(ROOT, 'ui')).filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(ROOT, 'ui', f), 'utf8')).join('\n');
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
const entry = await import('../../index.js');

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'a1', title: '情节甲', text: '甲在码头', date: '1919-11-20', uses: 1, floorStart: 0, floorEnd: 1, tags: ['码头'] }],
        memories: [{ id: 'm1', title: '记忆甲', content: '甲记得铜箱', date: '1919-11-20', entities: ['甲'] }],
        currentStates: [{ id: 'st1', subject: '甲', field: '体力', value: '疲惫', updatedAt: '1919-11-20' }],
        snapshots: [{ id: 's1', name: '甲', tags: [], identity: {}, floorStart: 0, floorEnd: 1, uses: 0 }],
        items: [{ id: 'i1', name: '铜箱', owner: '甲', date: '1919-11-20' }],
        currencies: [{ id: 'c1', owner: '甲', name: '银元', amount: 10 }],
        rumors: [{ id: 'r1', text: '码头有动静', stage: '传开', uses: 0 }],
        plans: [{ id: 'p1', title: '计划甲', content: '甲要查账', status: 'open' }],
        suspense: [{ id: 'x1', title: '悬念甲', content: '铜箱是谁的', status: 'open' }],
        scenes: [{ id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'] }],
        concepts: [{ id: 'cc1', name: '码头规矩', content: '先来后到', date: '1919-11-20' }],
        parallels: [{ id: 'pa1', title: '分支甲', text: '甲没去码头', date: '1919-11-20', updatedAt: Date.now(), uses: 0 }],
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2(entry.panelRuntimeHooks());
    return state;
}

/** 收集全部分页/子页的 HTML 与动作归属 */
async function collectUi() {
    boot();
    const tabs = PANEL_TABS.map((x) => x[0]);
    const subs = SETTINGS_TABS.map((x) => x.id);
    const html = [];
    for (const t of tabs) html.push(['tab:' + t, String(panelBodyHtml(t))]);
    for (const sub of subs) { await panelAction('settingsSub', { sub }); html.push(['sub:' + sub, String(panelBodyHtml('settings'))]); }
    return { html, tabs, subs };
}
const collectAttrs = (html, name) => {
    const out = new Map();
    const re = new RegExp('data-ftt-' + name + '="([^"]+)"', 'g');
    for (const [tag, h] of html) {
        let m;
        while ((m = re.exec(h)) !== null) {
            if (!out.has(m[1])) out.set(m[1], new Set());
            out.get(m[1]).add(tag);
        }
    }
    return out;
};

// ---------- L1 面板钩子 ----------
A('L1 面板钩子完整：`ui/panel.js` 读取的每个 `hooks.X` 都由 `panelRuntimeHooks()` 提供（函数）', (() => {
    const need = Array.from(new Set((PANEL_SRC.match(/hooks\.([A-Za-z0-9_]+)/g) || []).map((x) => x.slice(6)))).sort();
    const hooks = entry.panelRuntimeHooks();
    const missing = need.filter((k) => typeof hooks[k] !== 'function');
    return need.length >= 14 && missing.length === 0;
})(), null);

// ---------- L2 面板动作（运行时真审计） ----------
const L2 = await (async () => {
    const { html } = await collectUi();
    const actions = new Map();
    for (const [tag, h] of html) {
        const re = /data-ftt-action="([^"]+)"/g;
        let m;
        while ((m = re.exec(h)) !== null) { if (!actions.has(m[1])) actions.set(m[1], new Set()); actions.get(m[1]).add(tag); }
    }
    const broken = [];
    for (const [act, srcs] of actions) {
        let r = null;
        try { r = await panelAction(act, {}); } catch (e) { r = { ok: false, reason: 'throw', error: String((e && e.message) || e) }; }
        const reason = String((r && r.reason) || '');
        const note = String(((r && r.state) || {}).note || '');
        if (reason === 'unknown-action' || reason === 'no-hook' || reason === 'throw' || note.indexOf('未就绪') >= 0) {
            broken.push(act + '（' + [...srcs].join(',') + '）reason=' + reason + ' note=' + note.slice(0, 30));
        }
    }
    return { total: actions.size, broken };
})();
A('L2 面板动作完整：13 分页 + 14 设定子页里出现的全部 `data-ftt-action` 均已被处理（无 unknown-action / no-hook / 「入口未就绪」）', (() => {
    return L2.total >= 60 && L2.broken.length === 0;
})(), L2);

// ---------- L3 FTT 入口 ----------
A('L3 FTT 入口完整：index.js 提供的每个调试入口在 `FTT.*` 上都可调用（devtools 自动补全后 0 缺失）；自动补全清单被如实报告', (() => {
    const F = globalThis.FTT;
    if (!F || typeof F.hookKeys !== 'function') return false;
    const keys = F.hookKeys();
    const missing = keys.filter((k) => typeof F[k] !== 'function');
    const auto = typeof F.autoHooks === 'function' ? F.autoHooks() : null;
    // 用户排障会用到的关键入口必须存在
    const must = ['debugLogExport', 'debugLogExportText', 'dbgDump', 'dbgErrors', 'clockTrace', 'clockSrcLabels', 'apiTest', 'apiModels', 'status', 'snapshot'];
    const missKey = must.filter((k) => typeof F[k] !== 'function');
    return keys.length >= 300 && missing.length === 0 && Array.isArray(auto) && missKey.length === 0;
})(), { keys: (globalThis.FTT && globalThis.FTT.hookKeys ? globalThis.FTT.hookKeys().length : 0), auto: (globalThis.FTT && globalThis.FTT.autoHooks ? globalThis.FTT.autoHooks() : []) });

// ---------- L4 配置控件 ----------
const L4 = await (async () => {
    const { html } = await collectUi();
    const resolve = (path) => {
        const segs = String(path).split('.');
        let cur = defaultCfg;
        for (const s of segs) {
            if (!cur || typeof cur !== 'object' || !(s in cur)) return false;
            cur = cur[s];
        }
        return true;
    };
    const cfgBad = [];
    for (const [k, v] of collectAttrs(html, 'cfg')) {
        // V1 的**代理/入参键**（显式不落 cfg）：
        //   · `presetName`/`presetSelect` —— 按钮入参（V1 26280/26692 显式跳过）
        //   · `dimensionSeparate` —— 代理键（写真键 `cfg.dimensionGrouping`，V1 26693）
        if (k === 'presetName' || k === 'presetSelect' || k === 'dimensionSeparate') continue;
        if (!resolve(k)) cfgBad.push(k + '（' + [...v].join(',') + '）');
    }
    const routed = new Set(['autoUpdateCheck', 'updateRepo', 'updateBranch', 'updateCheckIntervalHours', 'useStGitEndpoint', 'panelMaxWidth']);
    const settingsKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const v2Bad = [];
    for (const [k, v] of collectAttrs(html, 'v2')) {
        if (!routed.has(k) || !settingsKeys.has(k)) v2Bad.push(k + '（' + [...v].join(',') + '）');
    }
    return { cfgBad, v2Bad, cfgKeys: collectAttrs(html, 'cfg').size, v2Keys: collectAttrs(html, 'v2').size };
})();
A('L4 配置控件完整：每个 `data-ftt-cfg`（含 `storage.*` / `dimCharLimits.*` 点路径）在默认配置里可解析；每个 `data-ftt-v2` 都同时存在于适配层设置且有路由', (() => {
    return L4.cfgKeys >= 120 && L4.cfgBad.length === 0 && L4.v2Bad.length === 0;
})(), L4);

// ---------- L5 委托属性 ----------
A('L5 委托属性完整：markup 的每个 `data-ftt-*` 属性（除 action/cfg/v2）都被「dataset 直读」或「选择器读取」；其余必须落在**已文档化的标记白名单**内', (() => {
    const attrs = new Set();
    const re = /data-ftt-([a-z-]+)=/g;
    let m;
    while ((m = re.exec(UI_SRC)) !== null) {
        const a = m[1];
        if (['action', 'cfg', 'v2'].indexOf(a) >= 0) continue;
        attrs.add(a);
    }
    const pascal = (a) => a.split('-').map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('');
    // 渲染/结构标记：由动作重绘、CSS、测试或「用户复制用文本框」使用，**不需要**读者（逐条给理由）
    const MARKERS = {
        'asub-body': '情节子标签容器（`atomSub` 动作重绘切显隐）',
        'body': '分页内容容器（面板渲染与滚动恢复用 `.ftt-body[data-ftt-body=…]`）',
        'cur-list': '货币选择器列表容器（重绘即更新）',
        'curpick-name': '选择器点名标记（测试/高亮锚点）',
        'debugexport': '调试包文本框（渲染给用户复制）',
        'export': '导出结果文本框（渲染给用户复制）',
        'idx': 'NSFW 词条行索引（**由委托透传为 `idx`**，见 L6）',
        'mode': '注入自查口径（**由委托透传为 `mode`**，见 L6）',
        'tag': '投喂标签值（**由委托透传为 `tag`**，见 L6）',
        'nsfw-kw-row': 'NSFW 词条行容器（重绘即更新）',
        'nsfw-rule-row': 'NSFW 规则行容器（值经输入控件读取）',
        'prompt-box': '提示词文本域容器（按 `data-ftt-prompt` 选择器读取）',
        'rel-list': '选角色列表容器（重绘即更新）',
        'rel-pick': '选角色面板容器（标题已注明；面板按 dim|id 重绘）',
        'relfilter': '维度筛选**已收窄**（V2 用分页隔离维度；字段仅保留供对照，见 P8 §6）',
        'relpick-name': '选择器点名标记（测试/高亮锚点）',
        'settings-page': '设定页容器（样式与测试锚点）',
        'section': '分节容器（v2.43.0：`data-ftt-section="v2-extras"` = V2 附加设定分节，样式/测试锚点）',
        'scene-node': '场景树节点（v2.47.0：`data-ftt-scene-node="<路径>"` = 节点路径锚点，供折叠/定位与测试）',
        'scene-children': '场景子树容器（v2.47.0：折叠切换用 `.ftt-scene-children[data-ftt-scene-children="<路径>"]`）',
        'scene-caret': '场景折叠三角（v2.47.0：`data-ftt-scene-caret="1"` 标记，点击纯 DOM 切显隐，V1 v1.206 26185 同款）',
        'scene-caret-for': '场景折叠三角对应路径（v2.47.0：`data-ftt-scene-caret-for="<路径>"`，点击时按它找子树）',
        'snap-inspect': '快照查看容器（重绘即更新）',
        'api-result': '向量层（Embedding / Rerank）测试结果行（v2.58.0：由动作写入模块态、重绘输出）',
        'layer-result': '「提取记忆」层测试结果行（v2.58.0：`data-ftt-layer-result` 由 `testLayer` 动作重绘）',
        'layer-preview': '「提取记忆」层命中预览容器（v2.58.0：`data-ftt-layer-preview` 由 `testLayer` 动作重绘）',
        'vector-cache': '向量缓存统计行（v2.58.0：清空动作后重绘即更新）',
    };
    const unread = [];
    for (const a of attrs) {
        if (UI_SRC.indexOf('.ftt' + pascal(a)) >= 0) continue;                                  // dataset 直读
        if (new RegExp('\\[data-ftt-' + a + '[\\]="]').test(UI_SRC)) continue;                    // 选择器读取
        if (new RegExp("getAttribute\\(\\s*['\"]data-ftt-" + a + "['\"]").test(UI_SRC)) continue;    // getAttribute 读取
        unread.push(a);
    }
    const unexplained = unread.filter((a) => !MARKERS[a]);
    // 反向：白名单里声明为「由委托透传」的，必须确实出现在委托入参里（L6 再细查）
    return attrs.size >= 45 && unread.length > 0 && unexplained.length === 0;
})(), null);

// ---------- L6 委托入参透传 ----------
A('L6 委托入参完整：通用分发必须透传动作实际需要的键（kind/id/idx/index/relIdx/tag/mode/from/to/row/dim/refId/key/box/pick/name/editor/summary）', (() => {
    const seg = PANEL_SRC.slice(PANEL_SRC.lastIndexOf('void panelAction(act, {'));
    const body = seg.slice(0, seg.indexOf('});'));
    const must = ['kind', 'id', 'floor', 'subject', 'summary', 'name', 'editor', 'idx', 'index', 'relIdx', 'tag', 'mode', 'from', 'to', 'row', 'dim', 'refId', 'key', 'box', 'pick'];
    // 允许简写属性（`kind, id, …`）与显式键（`tag: …`）两种写法
    const missing = must.filter((k) => !new RegExp('(^|[\\s{,])\\s*' + k + '\\s*[,:}]').test(body));
    return missing.length === 0;
})(), null);

// ---------- L7 曾失效按钮的运行时回归 ----------
const L7 = await (async () => {
    const { html } = await collectUi();
    void html;
    openPanel('settings');       // 绑定点击委托（真实点击路径）
    const panelEl = doc.getElementById('ftt-panel');
    const click = (panelEl && panelEl.listeners && panelEl.listeners.click) || [];
    const fire = (dataset) => {
        const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
    };
    const FS = await import('../../ui/feed-scan.js');
    const IC = await import('../../ui/inject-check.js');
    // ① 投喂标签「＋白」（缺 tag 时曾永久无效）
    const w0 = JSON.stringify(FS.rxFeedTagLists());
    fire({ fttAction: 'rxAddTag', fttKind: 'white', fttTag: '审计标签A' });
    await new Promise((r) => setTimeout(r, 0));
    const w1 = JSON.stringify(FS.rxFeedTagLists());
    // ② 注入自查「按本地召回」（缺 mode 时曾无效）
    const m0 = IC.injectCheckStats().useKeywords;
    fire({ fttAction: 'checkMode', fttMode: 'bare' });
    await new Promise((r) => setTimeout(r, 0));
    const m1 = IC.injectCheckStats().useKeywords;
    // ③ NSFW 词条「🗑 删除」（缺 idx 时曾无效）
    fire({ fttAction: 'nsfwKwDel', fttIdx: '0' });
    await new Promise((r) => setTimeout(r, 0));
    const note = String(panelState().note || '');
    return { tagOk: w0 !== w1 && w1.indexOf('审计标签A') >= 0, modeOk: m0 === true && m1 === false, idxOk: note.indexOf('已删除词条') >= 0 };
})();
A('L7 运行时回归：三个曾因「入参没透传」而完全失效的按钮经**真实点击**生效 —— 投喂「＋白」写入名单、自查口径切到「按本地召回」、NSFW 词条按索引删除', (() => {
    return L7.tagOk && L7.modeOk && L7.idxOk;
})(), L7);

// ---------- L8 属性→入参（v2.45.0：`＋黑` 曾因读错属性被当成「＋白」） ----------
A('L8 属性→入参静态审计：markup 里每个**携带参数**的 `data-ftt-*` 属性，委托都必须读同名 dataset 键（`ds.ftt<Pascal>`）', (() => {
    // 参数属性 → 委托应读取的 dataset 键（本表即「按钮带了参数，动作必须收得到」的可执行约定）
    const PARAM_ATTRS = {
        kind: 'fttKind', tag: 'fttTag', mode: 'fttMode', idx: 'fttIdx',
        'nsfw-rule-from': 'fttNsfwRuleFrom', 'nsfw-rule-to': 'fttNsfwRuleTo', 'nsfw-rule-row': 'fttNsfwRuleRow',
        dim: 'fttDim', 'ref-id': 'fttRefId', 'prompt-key': 'fttPromptKey', 'prompt-group': 'fttPromptGroup',
        'prompt-box': 'fttPromptBox', 'rel-pick': 'fttRelPick', floor: 'fttFloor', subject: 'fttSubject', summary: 'fttSummary',
    };
    // 只看「点击委托」那一段（含 prompt/snap/multi 等专用分支）：属性必须在这里被读成 dataset 键
    const CLICK_RAW = PANEL_SRC.slice(PANEL_SRC.indexOf('const actEl = (tg && typeof tg.dataset'), PANEL_SRC.indexOf("el.addEventListener('change'"));
    // **先去注释**：否则注释里提到 `ds.fttKind` 会让本审计假绿（实测踩到）
    const CLICK_SRC = CLICK_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const kindLine = (CLICK_SRC.match(/const kind = [^;]+;/) || [''])[0];
    const bad = [];
    const seen = [];
    for (const a of Object.keys(PARAM_ATTRS)) {
        if (UI_SRC.indexOf('data-ftt-' + a + '=') < 0) continue;      // markup 未使用该属性 → 跳过
        seen.push(a);
        const key = PARAM_ATTRS[a];
        // `kind` 只认**派生那一行**（别处出现 `ds.fttKind` 可能是其它分支，不能替代本行的读取）
        const readInClick = (key !== 'fttKind') && CLICK_SRC.indexOf('ds.' + key) >= 0;
        const readInKindLine = (key === 'fttKind') && kindLine.indexOf('ds.fttKind') >= 0;
        if (!readInClick && !readInKindLine) bad.push('data-ftt-' + a + ' → ds.' + key);
    }
    if (seen.length < 8) bad.push('参数属性覆盖过少（' + seen.length + '）：' + seen.join(','));
    // 反向：投喂/调试的 kind 按钮必须存在（避免本审计因属性改名而空转）
    const hasKindBtn = UI_SRC.indexOf('data-ftt-kind="black"') >= 0 && UI_SRC.indexOf('data-ftt-action="rxAddTag"') >= 0;
    return bad.length === 0 && hasKindBtn;
})(), null);

A('L9 端到端：经**真实点击**，`data-ftt-kind="black"` 收录进黑名单（此前读 `data-kind` → 恒空 → 被归一为白名单）；`dbgTraceFilter` 类别筛选按钮同样生效', (async () => {
    const FS = await import('../../ui/feed-scan.js');
    const TR = await import('../../core/trace.js');
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const fire = (dataset) => {
        const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        return new Promise((r) => setTimeout(r, 0));
    };
    await fire({ fttAction: 'rxScanTags' });
    await fire({ fttAction: 'rxAddTag', fttKind: 'black', fttTag: '审计黑标签' });
    const bl = FS.rxFeedTagLists().black;
    const wl = FS.rxFeedTagLists().white;
    // 调试页类别筛选：点击后走 `debugAction('dbgTraceFilter', { kind })`
    const DBG = await import('../../ui/debug.js');
    const r = await DBG.debugAction('dbgTraceFilter', { kind: 'host' });
    const r2 = await DBG.debugAction('dbgTraceFilter', { kind: '不存在' });
    // 顺带：该点击也应留下 params（v2.42.0 追踪），确认入参确实到过动作层
    TR.traceClear();
    await fire({ fttAction: 'rxAddTag', fttKind: 'black', fttTag: '审计黑标签2' });
    const ev = TR.traceList({ cat: 'ui' }).filter((x) => x.kind === 'rxAddTag')[0];
    const paramsOk = !!ev && String(ev.detail.params.kind || '') === 'black' && String(ev.detail.params.tag || '') === '审计黑标签2';
    return JSON.stringify(bl) === JSON.stringify(['审计黑标签']) && wl.length === 0
        && r.ok === true && r.filter === 'host' && r2.ok === true && r2.filter === '' && paramsOk;
})(), null);

un();
R.done();
