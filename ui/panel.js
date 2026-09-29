// ============================================================
// ui/panel.js —— **V1 同构浮层面板**（用户要求：完全对齐 V1，包含样式）
// 结构（与 V1 `panelHtml()` 同名同层级，故 `style.css` 里的 V1 样式原样生效）：
//   <div id="ftt-panel"> <div class="ftt-modal">
//       <div class="ftt-modal-head"> 标题 + 总记忆数 + ✕ </div>
//       <div class="ftt-tabs"> 13 个 <a class="ftt-tab" data-ftt-tab="…"> </div>
//       <div class="ftt-body" data-ftt-body="…"> 各分页内容 </div>
//   </div></div>
// 行为（与 V1 一致）：点击标签切页、✕ 关闭、点击遮罩关闭、Esc 关闭；分页状态与搜索词留在模块内。
// 渲染与动作分离：panelHtml() / panelAction() / bindOverlay()，无 querySelectorAll 的环境可直接调动作（可完整测）。
// 分页内容分批对齐 V1：本批（B1）= 总览（时钟/在场/已处理与未摘要楼层）+ 各维度列表（V1 样式）+ 设置（沿用 V2 表单）；
//   后续批次逐页补齐 V1 的编辑器、关系表、注入自查、提示词页、快照/同步、高级域等（见 docs/history/P8-功能对齐总表.md）。
// ============================================================
import { VERSION, DIMENSIONS } from '../core/constants.js';
import { state, cfg, getScopeKey, getLastMessageId, saveState } from '../core/model/runtime.js';
import { consoleList, entryMatches, consoleEntry, consoleSave, consoleDelete, injectAudit, consoleSummary } from './console.js';
import { fallbackPanelHtml, panelData, setPanelHooks as setPanelFormHooks, bindPanelEvents } from './settings-panel.js';
import { kindFields, flattenSnapshot, deconstructEntry } from './fields.js';
import { settingsPageHtml, settingsSubTabsHtml, applySettingsControl, SETTINGS_TABS } from './settings-pages.js';
import { hintDetailsHtml, shortHintHtml, mdBold } from './hints.js';   // v2.59.0 折叠说明；v2.60.0 统一富文本（`**x**` → 粗体）
import { promptAction } from './prompts.js';
import { snapshotAction } from './snapshots.js';
import { nsfwSoftenState, NSFW_DIM_LABEL } from '../core/nsfw.js';
import { runRepair } from '../core/repair.js';
import { runMemoryRepair, runConceptRepair } from '../core/group-repair.js';
import { runSceneRepair } from '../core/scene-repair.js';
import { runItemRepair } from '../core/item-repair.js';
import { runCharacterRepair } from '../core/character-repair.js';
import { runStateRepair } from '../core/state-repair.js';
import { runPlanSuspRepair } from '../core/plan-repair.js';
import { runAtomCompact, runAtomMergeSummary } from '../core/atom-compact.js';
import {
    runPlotSegmentSummary, runPlotSegmentSummarySelected, clearPlotSegments,
} from '../core/plot-segment.js';
import {
    runParallelWeave, runParallelAdvance, promoteParallelEvent, parallelLastKeywords,
    runParallelCustom,   // v2.99.0：自定义平行世界推演（输入一段话 → AI 单独推演）
} from '../core/parallel.js';
import { parallelExpired, importancePct } from '../core/recall.js';
// v2.90.0（用户要求）：管线状态补「流式摘要 + token 计数 + 预估倒计时」
import {
    pipelineSuffix, pipelineSummaryText, snapshot as pipelineSnapshot,
    // v3.0.0（用户要求）：管线状态「默认不显示 / 有动作自动出现 / 并行一行一条」
    listPipelineRuns,
} from '../core/pipeline.js';
// v2.92.0（用户要求）：**需人工确认的冲突**在总览也要提示（不只设定里）
import { listConflicts, pendingConflictCount, clearConflicts } from '../core/conflicts.js';
import { notifyError } from '../core/model/runtime.js';   // v2.87.0：错误要有可见提示，不只写日志
// v2.84.0（用户要求）：存储上限 = 总上限 × 各大类占比（滚动条拖动，其余按比例补齐到 100%）
// v2.85.0（用户要求）：滚动条**拖动中实时联动** + 保底高于上限时**自动下移**
import {
    STORE_LIMITS, STORE_SHARE_DIMS, storeShareOf, storeTotalMax, normStoreShares,
    allotStoreShares, clampStoreFloors,
} from '../core/ingest.js';   // v2.62.0：状态页排序「重要度」（V1 `pageSortItems` 同源）
import { shareFloorText, shareSumHtml } from './forget.js';
import { sortPlotSegments } from '../core/model/segment.js';
import { snapshotBirthAnomaly } from '../core/model/snapshot.js';
import { runRumorEvolveNow, clearRumors, rumorEveryRounds, rumorNeedRounds, rumorTickState } from '../core/rumor-evolve.js';
import { tombMany } from '../core/merge.js';
// v2.64.0：楼层覆盖统计（「未摘要」跳过「已有记忆数据的楼层」，此处显示覆盖数，便于核对跳过机制）
import { floorCoverage } from '../core/floor-cover.js';
import { debugLogPush } from '../adapters/debug-log.js';
// v2.42.0：交互/错误追踪（用户交互、处理器结果、耗时与代码站点 —— 「点哪个按钮 → 结果 → 代码位置」一条链）
import { traceEvent, traceOpStart, traceOpEnd, traceSite, traceCurrentOp } from '../core/trace.js';
import { syncAction, SYNC_ACTIONS } from './sync.js';
import { nsfwAction, NSFW_ACTIONS } from './nsfw.js';
import { clockSectionHtml, clockAction, CLOCK_ACTIONS } from './clock.js';
import { debugAction, DEBUG_ACTIONS } from './debug.js';
import { aboutAction, ABOUT_ACTIONS, setAboutHooks } from './about.js';
// B9-c：投喂标签自动分析（扫描/收录/清空；V1 `rxScanTags`/`rxAddTag`/`rxScanClear` 同名能力）
import { feedScanAction, FEED_SCAN_ACTIONS, rxDedupeTagList, isFeedTagKey } from './feed-scan.js';
import { sortRecentByStoryDate } from '../core/clock.js';
// v2.47.0：场景页 = V1 的**聚合树**（虚节点 + 当前位置高亮 + 折叠），此前 V2 是平铺列表
import { scenesTreeHtml } from './scene-tree.js';
// v2.49.0（用户报告：「导出和导入…应正确触发导出及下载文件，以及导入存档文件」）：
//   真实文件下载（Blob + `<a download>`）与文件选择器读取（`<input type=file>` + FileReader），与 V1 同口径
import { downloadTextFile, pickTextFile, fileIoCapabilities } from './file-io.js';
// v2.47.0（用户报告：「情节等大类面板列表显示内容不全，请参照 V1 展示对应内容，注意展示顺序」）：
//   各「大类」列表行按 V1 的字段集合与**先后顺序**渲染；排序用 V1 `sortRecent`（剧情日期倒序 → floorEnd 倒序）
import { listRowMainHtml, stateRowMainHtml, listStatusFilter } from './list-rows.js';
// v2.35.0（B10-a）：API 子页（V1 同名动作 presetSave/presetLoad/presetDelete/apiTest/apiModels + V2 的 dimPreset）
import { apiAction, API_ACTIONS, setApiPageHooks } from './api-page.js';
// B9-c：货币追踪（标定角色名单与选择器开关；V1 `currencyTrackPicking` + `curTrack*` 同名能力）
import {
    trackedCurrencyRoles, isTrackedCurrencyOwner, addTrackedCurrencyRole, removeTrackedCurrencyRole,
    clearTrackedCurrencyRoles, trackPickState, setTrackPick, defaultCurrencyOwner, knownCharacterNames,
} from '../core/model/money.js';
import { resetState as kernelResetState } from '../adapters/store.js';
import { getSettings, setSetting, panelWidthCssValue } from '../adapters/settings.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { dimsCheckboxHtml } from './settings-panel.js';
import { relTableHtml, relAction, relByWho, relRowsOf, REL_TAB_OF, relDimLabelOf, relFilterState, setRelFilter, relClearFilter, relPickState, setRelPick, relKnownNames, relPickAppendRow, relJump, relGoto, setRelPickQuery } from './rel-table.js';
import { injectCheckAction } from './inject-check.js';
// v2.80.0（用户要求：关系表 / 约束自查 收进设定页）：「设定 → 约束」子页正文 + 页内维度态
import { constraintPageHtml, constraintDimState, setConstraintDim, setLinkQuery } from './constraint-page.js';
import { atomIsHidden } from '../core/merge.js';

export const PANEL_ID = 'ftt-panel';
/** `data-ftt-v2` 中属于**适配层设置**（而非内核 cfg）的键 */
const UPDATE_SETTING_KEYS = ['autoUpdateCheck', 'updateRepo', 'updateBranch', 'updateCheckIntervalHours', 'useStGitEndpoint'];
/** v2.36.0：同样是**适配层设置**（extensionSettings）而非内核 cfg 的界面键 —— 面板宽度 */
const UI_SETTING_KEYS = ['panelMaxWidth'];
/**
 * v2.36.0 面板宽度档位（`panelMaxWidth`，单位 px；`0` = 铺满不设上限）。
 * 默认 1280px：桌面（≥1025px）在该上限内随视口自适应，两侧恒留 16px；手机/平板档位由 CSS 媒体查询决定。
 * 「需注意较宽」的取舍：默认**不**铺满（长行阅读与点击距离都更舒服），需要更宽由用户显式选择。
 */
export const PANEL_WIDTH_OPTIONS = Object.freeze([
    { v: 960, label: '960px（紧凑）' },
    { v: 1120, label: '1120px' },
    { v: 1280, label: '1280px（默认 · 推荐）' },
    { v: 1440, label: '1440px（大屏）' },
    { v: 1600, label: '1600px（超宽）' },
    { v: 0, label: '铺满（只留 32px 边距）' },
]);
/** V1 的 13 个分页（id 与标签逐字一致） */
export const PANEL_TABS = Object.freeze([
    ['overview', '总览'], ['atoms', '情节'], ['states', '状态'], ['snapshots', '角色'],
    ['memories', '记忆'], ['items', '物品'], ['currencies', '货币'], ['rumors', '传言'],
    ['plans', '计划悬念'], ['scenes', '场景'], ['concepts', '概念'], ['parallels', '平行'], ['settings', '设置'],
]);
/** 分页 id → 维度容器键（状态存 currentStates；计划悬念页含 plans+suspense） */
const TAB_DIM = { atoms: 'atoms', states: 'currentStates', snapshots: 'snapshots', memories: 'memories', items: 'items', currencies: 'currencies', rumors: 'rumors', plans: 'plans', scenes: 'scenes', concepts: 'concepts', parallels: 'parallels' };

const ps = {
    tab: 'overview', open: false, q: {}, editing: null, note: '', opened: 0,
    busy: false,        // 批量分析进行中（头部 busy 文案 + 楼层脉冲）
    settingsSub: 'base', // 设定页当前子页（V1 的 14 组子页 + v2.80.0 新增「约束」= 15 组）
    // 注：关系表「按角色筛选」「跳转定位」「选角色态」自 B9-b 起由 `ui/rel-table.js` 持有（V1 同款闭包变量口径），
    //   面板只经 `relFilterState()/setRelFilter()` 读写；`panelState().relWho` 仍透出该筛选值。
    //   关系表的**当前维度**自 v2.80.0 起由 `ui/constraint-page.js` 持有（`constraintDimState()`），
    //   不再有「列表页子标签」（`relSub` 随子标签一并移除）。
    exportText: '',     // 数据管理页的导出 JSON（供复制/查看）
    sel: {},            // 多选集合：{ [kind]: Set<id> }
    multi: {},          // 多选模式：{ [kind]: bool }
    // v2.62.0（状态页对齐 V1）：每页筛选态 `{ field, sort, extra }`（V1 `pageFilter` 口径）
    f: {},
    showHidden: false,  // 情节页：是否显示「已总结（隐藏）」情节（V1 atomToggleHidden）
    peek: '',           // 情节速览：正在穿透查看的 id（V1 atomPeek）
    atomSub: 'list',    // 情节页子标签：'list'（📜 情节列表）| 'segments'（🧩 分段总结），V1 activeAtomSub
    // v3.0.13（用户报告「自定义平行推演触发后，没有正确新增平行条目」）：本次刚落库的平行事件 id
    //   → 该行渲染「🆕 本次新增」标记并在重绘后滚入视野；切页/下次推演即清除。
    //   用户此前看不到新条目有两个叠加原因：① 缺日期的条目被按剧情日期倒序排到整列表**最后**；
    //   ② 即使排到了可见位置也没有任何「刚新增的是哪一条」的视觉指示。
    flash: null,
};
const str0 = (v) => String(v == null ? '' : v);
/** 管线忙位起始时刻（v2.52.0：总览「管线状态」行的读秒） */
let busySince = 0;
/** 默认导出文件名（V1 `export` 动作：`FTT记忆_<角色哈希>.json`；无哈希时退化为 `FTT记忆.json`） */
function defaultExportFileName() {
    try {
        const scope = String(getScopeKey() || '');
        if (!scope) return 'FTT记忆.json';
        // 与 V1 同用 djb2→base36 短哈希（core/util.js#hashText），保证两端文件名口径一致
        const h = (() => { let x = 5381; for (let i = 0; i < scope.length; i += 1) { x = ((x << 5) + x) ^ scope.charCodeAt(i); } return (x >>> 0).toString(36); })();
        return 'FTT记忆_' + h + '.json';
    } catch (e) { return 'FTT记忆.json'; }
}
let overlayEl = null;
let hooks = {};
let escBound = false;

/**
 * 关于页自动读取成功后的重绘（仅当当前停在「关于」子页）——
 *   V1 `aboutEnsureLoaded()` 里的 `activeTab === 'about' && renderPanel()` 守卫的 V2 等价物。
 */
function aboutRerenderIfVisible() {
    try { if (ps.settingsSub === 'about') renderPanel(); } catch (e) { /* 重绘失败不影响数据 */ }
}
try { setAboutHooks({ rerender: aboutRerenderIfVisible }); } catch (e) { /* 钩子注入失败不影响面板 */ }
/** API 页动作/自动结果后的重绘（仅当当前停在「API」子页）——与 about 页同模式 */
function apiRerenderIfVisible() {
    try { if (ps.settingsSub === 'api') renderPanel(); } catch (e) { /* 重绘失败不影响数据 */ }
}
try { setApiPageHooks({ rerender: apiRerenderIfVisible }); } catch (e) { /* 钩子注入失败不影响面板 */ }

/** v3.0.2：批次（⚡ 立即 AI 摘要）是否在途（= `hooks.busy()`；与单楼分析共用同一条分析管线的忙位） */
function batchBusyNow() {
    try { return (typeof hooks.busy === 'function') ? !!hooks.busy() : false; } catch (e) { return false; }
}

/** v2.96.0：**正在分析中的单楼**（防连点；V1 `busy.summary` 的等价物） */
const singleFloorBusy = new Set();

/**
 * v2.96.0：面板动作的**用户可见通知**（V1 `notify()` 等价物）。
 * 走宿主钩子 `hooks.notify(kind, text)`（index.js 接到 toastr）；未接线时静默 —— 提示行仍会显示。
 */
function panelNotify(kind, text) {
    try {
        if (typeof hooks.notify === 'function') return hooks.notify(String(kind || 'info'), String(text || ''));
    } catch (e) { /* 忽略 */ }
    return false;
}
/** 单楼分析在途清单（测试/诊断） */
export function singleFloorBusyState() { return Array.from(singleFloorBusy).sort((a, b) => a - b); }

/** 注入动作钩子（index.js：提取 / 清单 / 更新 / 清空注入） */
export function setPanelHooks2(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
/** 面板状态（诊断/测试） */
export function panelState() {
    return {
        id: PANEL_ID, tab: ps.tab, open: ps.open, opened: ps.opened, note: ps.note,
        tabs: PANEL_TABS.map((t) => t[0]), editing: ps.editing ? Object.assign({}, ps.editing) : null,
        search: Object.assign({}, ps.q),
        multi: Object.assign({}, ps.multi),
        filter: JSON.parse(JSON.stringify(ps.f || {})),
        selCount: Object.keys(ps.sel).reduce((n, k) => n + (ps.sel[k] ? ps.sel[k].size : 0), 0),
        showHidden: ps.showHidden, peek: ps.peek, settingsSub: ps.settingsSub, atomSub: ps.atomSub,
        constraintDim: constraintDimState(), relWho: String(relFilterState().who || ''),
        exportChars: String(ps.exportText || '').length,
        // v3.0.13：本次「🆕 本次新增」标记的平行事件 id（空数组 = 无标记）
        flashIds: (ps.flash && Array.isArray(ps.flash.ids)) ? ps.flash.ids.slice() : [],
    };
}
/**
 * UI 分页 id → **数据容器键**：V1 的界面用 'states'，而数据容器/墓碑维度是 'currentStates'
 *   （V1 的 `ATOM_DIM_KEYS` 只含 currentStates）。若直接把 'states' 传给 entries/墓碑层，
 *   墓碑会写到 `deleted.states` —— 跨端合并读不到，属真实缺陷（B2 修）。
 */
function dataKindOf(kind) { return kind === 'states' ? 'currentStates' : String(kind || ''); }
// 注（**与 V1 的一处有意偏离**）：V1 的状态页把墓碑写进 `deleted.states`，而它的维度表 `ATOM_DIM_KEYS` 只认
//   `currentStates` —— 即 V1 的状态删除墓碑**不会被自己的跨端合并/清扫读到**（删了可能在别端复活）。
//   V2 统一用规范维度键（states → currentStates）写入与读取，使删除墓碑真正生效；UI 标签/分页 id 仍与 V1 一致。
//   登记于 docs/history/P8c-B2条目操作.md「有意偏离」。

/** 每页筛选态（V1 `pageFilter(kind)` = { field, sort, extra }；缺省 = 全部字段 / 默认排序 / 全部） */
const LIST_FILTER_DEFAULT = Object.freeze({ field: 'all', sort: 'default', extra: 'all' });
function listFilterOf(kind) { return Object.assign({}, LIST_FILTER_DEFAULT, (ps.f && ps.f[kind]) || {}); }
/** 按字段取检索文本（V1 `fieldHay` 逐条等价：title/desc/tags/name 各一档，其余走通用 hay） */
function fieldHayOf(it, field) {
    try {
        if (field === 'title') return String((it && (it.title || it.name)) || '').toLowerCase();
        if (field === 'desc') return String((it && (it.desc || it.content || it.text)) || '').toLowerCase();
        if (field === 'tags') return (Array.isArray(it && it.tags) ? it.tags.join(' ') : '').toLowerCase();
        if (field === 'name') return String((it && (it.name || it.title)) || '').toLowerCase();
    } catch (e) { /* 忽略 */ }
    return String((it && (it.subject || '') + ' ' + (it.field || '') + ' ' + (it.value || '') + ' ' + (it.title || '') + ' ' + (it.content || '') + ' ' + (it.text || '') + ' ' + (Array.isArray(it && it.tags) ? it.tags.join(' ') : '')) || '').toLowerCase();
}
/** 额外条件（V1 `pageExtraMatch`）：目前只用于状态页（全部状态 / 仅已失效） */
function extraMatchOf(kind, it, extra) {
    const ex = String(extra || 'all');
    if (ex === 'all') return true;
    if (kind === 'states') {
        const inactive = String((it && it.status) || '').toLowerCase() === 'inactive';
        return ex === 'inactive' ? inactive : !inactive;
    }
    return true;
}
/** 排序（V1 `pageSortItems` 的 V2 等价物：默认 / 最新在前 / 最早在前 / 重要度 / 调用次数） */
function listSortOf(kind, arr) {
    const s = listFilterOf(kind).sort;
    const a = Array.isArray(arr) ? arr.slice() : [];
    if (s === 'new') { try { return sortRecentByStoryDate(a); } catch (e) { return a; } }
    if (s === 'old') { try { return sortRecentByStoryDate(a).reverse(); } catch (e) { return a.reverse(); } }
    if (s === 'importance') { return a.sort((x, y) => (Number(importancePct(y)) || 0) - (Number(importancePct(x)) || 0)); }
    if (s === 'uses') return a.sort((x, y) => (Number(y && y.uses) || 0) - (Number(x && x.uses) || 0));
    return a;
}
/** 筛选条控件（V1 `searchBoxHtml` 的 V2 等价物：字段 / 排序 / 额外条件；多选仍用 V2 的按钮形态） */
function listFilterBarHtml(kind, opts) {
    const o = opts || {};
    const f = listFilterOf(kind);
    const q = ps.q[kind] || '';
    const sel = (attr0, list, cur) => '<select class="ftt-select-sm" ' + attr0 + '>' + list.map(([v, l]) => '<option value="' + attr(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
    const fieldOpts = [['all', '全部字段'], ['title', '标题'], ['desc', '描述'], ['tags', '标签'], ['name', '名称']];
    const sortOpts = [['default', '默认排序'], ['new', '最新在前'], ['old', '最早在前'], ['importance', '重要度'], ['uses', '调用次数']];
    const extraOpts = Array.isArray(o.extraOpts) ? o.extraOpts : null;
    return '<div class="ftt-row ftt-filterbar ftt-toolbar ftt-filter-tight">'
        + '<input type="text" class="ftt-input" data-ftt-search="' + attr(kind) + '" value="' + attr(q) + '" placeholder="' + attr(o.placeholder || '搜索：标题 / 描述 / 关键词…') + '">'
        + sel('data-ftt-filter="' + attr(kind) + '" data-ftt-filter-key="field"', fieldOpts, f.field)
        + sel('data-ftt-filter="' + attr(kind) + '" data-ftt-filter-key="sort"', sortOpts, f.sort)
        + (extraOpts ? sel('data-ftt-filter="' + attr(kind) + '" data-ftt-filter-key="extra"', extraOpts, f.extra) : '')
        + '<button class="ftt-btn ftt-sm" data-ftt-action="searchClear" data-ftt-search-kind="' + attr(kind) + '" title="清除搜索与筛选">✕ 清除</button>'
        + '<span class="ftt-muted" data-ftt-search-count="' + attr(kind) + '">' + esc(o.countText || '') + '</span>'
        + '</div>';
}
/** 某维度的多选集合（缺省即建） */
function selOf(kind) { if (!ps.sel[kind]) ps.sel[kind] = new Set(); return ps.sel[kind]; }
/** 当前列表（含隐藏过滤） */
function listOf(kind, q, limit) {
    // v2.47.0：排序与可见范围对齐 V1 ——
    //   ① `sortRecent`（剧情日期倒序 → floorEnd 倒序；V1 `sortRecent` 逐字，见 core/clock.js）；
    //   ② 情节：隐藏已总结项（在排序/截断**之前**过滤，V1 `atomShowHidden ? state.atoms : activeAtoms()`）；
    //   ③ 计划/悬念：只列 `status === 'open'`（V1 `plansHtml` 的 `openPlansAll/openSuspAll`）。
    const dataKind = dataKindOf(kind);
    const statusWant = listStatusFilter(kind);
    let base = arrOf(dataKind);
    if (kind === 'atoms' && !ps.showHidden) {
        try { base = base.filter((x) => !atomIsHidden(x)); } catch (e) { /* 忽略 */ }
    }
    if (statusWant) base = base.filter((x) => String((x && x.status) || 'open') === statusWant);
    try { base = sortRecentByStoryDate(base); } catch (e) { base = base.slice().reverse(); }
    const needle = q === undefined ? (ps.q[kind] || '') : q;
    const matched = base.filter((x) => entryMatches(x, needle));
    const n = Number(limit) > 0 ? Number(limit) : matched.length;
    return matched.slice(0, n);
}
function hiddenCount() { try { return arrOf('atoms').filter((x) => atomIsHidden(x)).length; } catch (e) { return 0; } }
export function panelInfo() {
    const doc = docEl();
    let mounted = false;
    try { mounted = !!(doc && typeof doc.getElementById === 'function' && doc.getElementById(PANEL_ID)); } catch (e) { mounted = false; }
    return { id: PANEL_ID, mounted: mounted || !!overlayEl, open: ps.open, tab: ps.tab, opened: ps.opened, tabs: PANEL_TABS.map((t) => t[0]), bodyFound: !!(doc && doc.body) };
}
export function panelTabs() { return PANEL_TABS.map((t) => ({ id: t[0], label: t[1] })); }

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (v) => esc(v);
function docEl() { try { return globalThis.document || null; } catch (e) { return null; } }
const J = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } };

/**
 * 读取维度容器数组：**UI kind → 数据容器键**（V1 的界面用 'states'，容器是 `currentStates`）。
 * 注意与「墓碑维度」区分：写入/墓碑层仍传 UI kind（V1 `deleteEntry('states')` 把墓碑写进 `deleted.states`），
 * 但**读取容器**必须映射，否则状态页会显示为空（B2 实测踩到）。
 */
function arrOf(kind) {
    try {
        const k = dataKindOf(kind);
        return Array.isArray(state[k]) ? state[k] : [];
    } catch (e) { return []; }
}
function totalMemory() {
    try { return DIMENSIONS.reduce((n, d) => n + arrOf(d.kind).length, 0); } catch (e) { return 0; }
}

/**
 * 管线状态（总览「🧵 管线状态」行）的**实时**计算 —— 每次调用都按当前时刻重算读秒。
 * v2.63.0（用户报告「管线状态的计时器不动，需改进，应该是动态变化的」）：
 *   此前秒数只在**面板重绘**那一刻计算一次，之后没有任何定时器去刷新 → 读秒冻结。
 *   现在抽出本函数给「渲染」与「1s 计时器」共用；起始时刻优先取批次真实起点（`batchProgress().since`），
 *   其次用面板首次观察到 busy 的时刻（`busySince`）。
 * @returns {{busy:boolean, txt:string, sec:number}}
 */
export function pipelineStatusText(now) {
    const at = Number(now) || Date.now();
    try {
        const batchBusy = (typeof hooks.busy === 'function') ? !!hooks.busy() : false;
        const bp = (typeof hooks.batchProgress === 'function') ? (hooks.batchProgress() || {}) : {};
        const total = Number(bp.segTotal) || 0, done = Number(bp.segDone) || 0;
        const range = (bp.range && (bp.range.start !== undefined)) ? (' · 第 ' + bp.range.start + '-' + bp.range.end + ' 楼') : '';
        // v2.95.0 修复（用户报告「倒计时 / 流文字展示都没生效」）：忙位判定此前**只看批次**
        //   （`hooks.busy()` = `extractBusy()`），于是单路 AI（弱化NSFW / 自动修复 / 推演 / 时钟 / 情节总结…）
        //   全程显示「空闲」，token / 倒计时 / 结构摘要根本没有出场机会。现在**忙位 = 批次忙 或 管线忙**。
        const ps = (() => { try { return pipelineSnapshot() || {}; } catch (e) { return {}; } })();
        const pipeBusy = !!ps.busy;
        const busy = batchBusy || pipeBusy;
        if (batchBusy && !busySince) busySince = Number(bp.since) > 0 ? Number(bp.since) : at;   // 首次观察到忙位
        if (batchBusy && Number(bp.since) > 0) busySince = Number(bp.since);                     // 批次给出真实起点 → 采用
        if (!batchBusy) busySince = 0;
        // 「已用时」：批次忙 → 批次读秒（既有口径）；仅管线忙 → 用管线自己的运行时长
        const sec = batchBusy
            ? (busySince ? Math.max(0, Math.floor((at - busySince) / 1000)) : 0)
            : (pipeBusy ? Math.max(0, Math.floor((Number(ps.elapsed) || 0) / 1000)) : 0);
        // v2.90.0：token 计数 + 预估倒计时（按最近几次同类型处理行为耗时；首次用内置默认）
        const suffix = (() => { try { return pipelineSuffix() || ''; } catch (e) { return ''; } })();
        const sum = (() => { try { return pipelineSummaryText() || ''; } catch (e) { return ''; } })();
        const label = String(ps.label || '');
        const head = batchBusy
            ? '正在分析记忆（AI 摘要）'
            : (pipeBusy ? ('正在处理：' + (label || 'AI 任务')) : '');
        const txt = busy
            ? (head + (batchBusy && total ? (' · 分段 ' + done + '/' + total) : '') + (batchBusy ? range : '')
                + (batchBusy && label ? (' · ' + label) : '')
                // 批次忙：批次读秒 + 管线读数并存（两者含义不同）；仅管线忙：读秒即管线读数，避免重复显示
                + ((batchBusy || !pipeBusy) ? (' · 已用时 ' + sec + 's') : '')
                + (suffix ? (' · ' + suffix) : '')
                + (sum ? (' · ' + sum) : '') + (bp.aborted ? ' · 已请求中断' : ''))
            : '空闲';
        return { busy: busy, sec: sec, txt: txt, tokens: Number(ps.tokens) || 0, remain: Number(ps.remain) || 0 };
    } catch (e) { return { busy: false, sec: 0, txt: '空闲' }; }
}

/**
 * 「🧵 管线状态」**块内行**（v3.0.0，用户要求）：
 *   · **默认不显示** —— 没有任何进行中的动作时整块隐藏（不再常驻一行「空闲」）；
 *   · **有请求 / 同步等各类动作时自动出现**；
 *   · **并行时一行一条**（两个及以上同时进行 → 两行及以上，按需展现）。
 * 行文本 = `pipelineRunLine()` +（批量摘要时）批次进度「分段 x/y · 第 N-M 楼」。
 */
export function pipelineBoxRowsHtml() {
    try {
        const runs = (() => { try { return listPipelineRuns(); } catch (e) { return []; } })();
        // v3.0.2（用户报告「管线状态也应该有提示，但现在没有」）：**批次（⚡ 立即 AI 摘要）本身**也要占一行 ——
        //   一次批量分析里「AI 调用」只占其中一部分时间（还有段切分 / 落库 / 快照 / 校正），
        //   旧实现只渲染 AI 运行 → 两次 AI 调用之间**整块消失**（用户看到的就是「点了没有管线提示」）。
        const batchOn = (typeof hooks.busy === 'function') ? !!hooks.busy() : false;
        const bp = batchOn && (typeof hooks.batchProgress === 'function') ? (hooks.batchProgress() || {}) : {};
        const total = Number(bp.segTotal) || 0, done = Number(bp.segDone) || 0;
        const range = (bp.range && (bp.range.start !== undefined)) ? (' · 第 ' + bp.range.start + '-' + bp.range.end + ' 楼') : '';
        const seg = total ? (' · 分段 ' + done + '/' + total) : '';
        const aborted = bp.aborted ? ' · 已请求中断' : '';
        const rows = [];
        if (batchOn) {
            const since = Number(bp.since) > 0 ? Number(bp.since) : 0;
            const sec = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
            const list = String((bp.range && bp.range.start !== undefined) ? ('第 ' + bp.range.start + '-' + bp.range.end + ' 楼') : '');
            const batchText = '[AI] AI 摘要（批量）' + (total ? (' · 分段 ' + done + '/' + total) : '') + (list ? (' · ' + list) : '')
                + (sec ? (' · 已用时 ' + sec + 's') : '') + aborted;
            rows.push('<div class="ftt-pipe-line" data-ftt-pipeline-row="batch" title="AI：批量摘要（未摘要楼层分段分析，与「第 N 楼」同一条分析管线）">'
                + '<span class="ftt-muted" style="flex:1 1 auto;min-width:0">' + esc(batchText) + '</span></div>');
        }
        // 批次进度只挂在**批量摘要那一行**上（不是「第一行」—— 第一行可能是后起的其它动作）；
        //   批次行已单独列出时，AI 调用行不再重复批次进度。
        const batchIdx = batchOn ? -1 : runs.findIndex((r) => String(r.label) === '批量摘要');
        for (let i = 0; i < runs.length; i++) {
            const r = runs[i];
            const extra = (i === batchIdx && (seg || range)) ? (seg + range) : '';
            rows.push('<div class="ftt-pipe-line" data-ftt-pipeline-row="' + r.id + '" title="' + attr(String(r.kindLabel) + '：' + String(r.label)) + '">'
                + '<span class="ftt-muted" style="flex:1 1 auto;min-width:0">' + esc(r.text + extra + (i === batchIdx ? aborted : '')) + '</span></div>');
        }
        return rows.join('');
    } catch (e) { return ''; }
}

/**
 * 只更新「管线状态」**块**（V1 `updatePipelineStatusDom()` 同口径：找到就写、内容没变不写）。
 * v2.63.0：容器属性为 `[data-ftt-pipeline-box]`；**不整页重绘**，避免打断输入与滚动。
 * v3.0.0：块内改为 **0..N 行**；无进行中动作 → 整块 `display:none`（默认不显示）。
 * @param {number} [now] 当前时刻（测试可注入）
 * @param {object} [docOverride] 覆盖 `document`（测试用）
 */
export function updatePipelineStatusDom(now, docOverride) {
    try {
        const doc = docOverride || globalThis.document;
        const box = doc && doc.querySelector ? doc.querySelector('[data-ftt-pipeline-box]') : null;
        if (!box) return false;
        const rows = pipelineBoxRowsHtml();
        if (String(box.innerHTML) !== rows) box.innerHTML = rows;
        const show = rows ? '' : 'none';
        try { if (box.style && box.style.display !== show) box.style.display = show; } catch (e) { /* 忽略 */ }
        return true;
    } catch (e) { return false; }
}

/** 管线状态计时器（V1 v1.85：500ms 心跳）——忙位期间动态刷新读秒；空闲/面板不可见时自动停止（不泄漏定时器） */
let pipelineTimer = null;
/** 计时器是否在跑（测试/诊断） */
export function pipelineTickState() { return { running: !!pipelineTimer, busySince: busySince }; }
function stopPipelineTick() {
    if (pipelineTimer) { try { clearInterval(pipelineTimer); } catch (e) { /* 忽略 */ } pipelineTimer = null; }
    return true;
}
/** 那个「管线状态」块是否在 DOM 里（V1 `pipelineTickStart` 同款前置检查；V2 在首个心跳时复查，见下） */
function pipelineRowPresent() {
    try { const doc = globalThis.document; return !!(doc && doc.querySelector && doc.querySelector('[data-ftt-pipeline-box]')); } catch (e) { return false; }
}
/** 管线是否在跑（v2.95.0：单路 AI 任务也算忙；异常 → false） */
function pipelineBusy() {
    try { return !!(pipelineSnapshot() || {}).busy; } catch (e) { return false; }
}
/** 按「忙位 + 面板开着 + 停在总览页」启停计时器（每次渲染/动作后调用） */
function syncPipelineTick() {
    try {
        // v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：心跳**不再只在忙位时跑** —— 只要面板开着
        //   并停在总览就常驻（500ms），这样**后台**开始的动作（自动摘要 / 跨端同步 / 世界书镜像 / 保存…）
        //   无需等下一次整页重绘就会自动出现；块内 0 行时整块保持隐藏。
        const onOverview = String(ps.tab) === 'overview';
        // 离开总览 / 面板关闭 → 立即停表，别留一个「只在下次回调里才自停」的定时器
        if (!ps.open || !onOverview) { stopPipelineTick(); return false; }
        if (pipelineTimer) return true;
        const iv = (typeof setInterval === 'function') ? setInterval(() => {
            try {
                // 面板已关/切页 → 停；那个块不在 DOM（拿不到节点）→ 停；否则只刷新块内 0..N 行
                // （V1 v1.85 500ms 心跳；**不重绘整页**，避免打断输入与滚动）
                if (!ps.open || String(ps.tab) !== 'overview') { stopPipelineTick(); return; }
                if (!pipelineRowPresent() || !updatePipelineStatusDom()) stopPipelineTick();
            } catch (e) { stopPipelineTick(); }
        }, 500) : null;
        pipelineTimer = iv;
        return !!iv;
    } catch (e) { return false; }
}

/**
 * v2.92.0（用户要求）：「发生冲突需手动确认的，除了在设定中展示外，还需在**总览页面提示**」。
 * 总览「⚠️ 待确认」横幅（无待确认项 → 空串）：摘要一行 + 「去处理」（跳设定→存储）与「已确认」（只清提示，不动数据）。
 * 抽成独立导出函数，便于单测（总览渲染依赖较多钩子）。
 */
export function conflictBannerHtml() {
    try {
        const cnt = pendingConflictCount();
        if (cnt <= 0) return '';
        const first = listConflicts()[0] || {};
        return '<div class="ftt-item ftt-item--info ftt-inline" data-ftt-conflict-banner>'
            + '<b class="ftt-pipe-title">⚠️ 待确认</b> <span class="ftt-muted" style="flex:1 1 auto;min-width:0">'
            + esc(String(first.detail || first.kind || '').slice(0, 80)) + (cnt > 1 ? ('　（共 ' + cnt + ' 项）') : '')
            + '</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="goStorageConflicts" title="去「设定 → 存储」查看完整清单">去处理</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="resolveConflicts" title="全部标记为已确认（只清提示，不动数据）">已确认</button>'
            + '</div>';
    } catch (e) { return ''; }
}

/** 总览：剧情时钟 / 在场 / 计数 / 已处理与未摘要楼层 / 快捷动作（V1 总览的可见子集；其余见 docs/P8 批次表） */
function overviewBody() {
    const lines = [];
    // ① 剧情时钟（日期/时间/地点 + 🔒手工徽标 + 手工改写面板 + 时钟来源）
    try { lines.push(clockSectionHtml()); } catch (e) { /* 忽略 */ }
    // ② 管线状态（v2.52.0 缺失修复 + v2.63.0 动态读秒）——进行中给出任务/进度/读秒；空闲明确写「空闲」
    //   读秒计时器由 `renderPanel()` 在**写入 DOM 之后**启停（此刻那一行才真的存在，见 `syncPipelineTick`）
    //   v3.0.0（用户要求「管线状态默认不显示，有请求/同步等各类动作时自动出现，并行时出现两个或两个以上」）：
    //   整块**默认隐藏**（`display:none`），块内 0..N 行由 500ms 心跳或本次渲染写入（`pipelineBoxRowsHtml()`）。
    //   「✖ 中断」按钮仍只在**批次**进行中出现（它只中断批量摘要的分段路径）。
    // 先跑一次文本计算：它同时维护「忙位起点」`busySince`（空闲即清零，v2.63.0 口径），
    //   然后「✖ 中断」只对**批次**（`hooks.busy()` = extractBusy）出现 —— 单路 AI 没有分段中断入口。
    try { pipelineStatusText(); } catch (e) { /* 忽略 */ }
    const batchBusy = batchBusyNow();
    const pipeRows = (() => { try { return pipelineBoxRowsHtml(); } catch (e) { return ''; } })();
    lines.push('<div class="ftt-item ftt-item--info ftt-inline" data-ftt-pipeline-box-wrap' + (pipeRows ? '' : ' style="display:none"') + '>'
        + '<b class="ftt-pipe-title">🧵 管线状态</b>'
        + '<div data-ftt-pipeline-box style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px"' + (pipeRows ? '' : ' hidden') + '>' + pipeRows + '</div>'
        + (batchBusy ? '<button class="ftt-btn ftt-sm" data-ftt-action="abortAnalysis" id="ftt-abort-btn" title="中断当前分析：段与段之间停止（已完成并落盘的部分保留）">✖ 中断</button>' : '')
        + '</div>');
    // ④ 注入概览（一句话）
    const audit = injectAudit({ rows: false });
    lines.push('<div class="ftt-hint" data-ftt-inject>🧷 注入 ' + audit.chars + ' 字 · 命中 ' + audit.injected + ' / 未命中 ' + audit.missing + ' · 预算 ' + (Number(cfg.charBudget) || 0) + '</div>');
    // ④b v2.59.0（用户报告：「概览缺少展示最后一次提取记忆内容的组件」）：最后一次提取 —— 时间 / 来源 /
    //   楼层范围 / 新增条数 / 维度 / 关键词，提取正文（AI 回复）放进默认收起的「查看提取内容」。
    //   v2.66.0（用户要求）：「最后一次提取」整块**移到总览最末端**（它是「刚刚发生了什么」的回顾，不占首屏）。
    const lastExtractLines = (() => {
        const out = [];
        const le = (typeof hooks.lastExtract === 'function') ? hooks.lastExtract() : null;
        const line = (() => {
            if (!le || !le.at) return '尚无提取记录（点上方「📤 提取记忆」或等自动提取后会在这里显示）';
            const t = new Date(Number(le.at)).toLocaleString('zh-CN', { hour12: false });
            const viaLabel = { floor: '单楼分析', segment: '分段分析', batch: '批量摘要' }[String(le.via || '')] || '提取';
            const trig = String(le.trigger || '') === 'auto' ? '自动' : '手动';
            const scope = le.floors ? (' · 第 ' + String(le.floors) + ' 楼') : '';
            const made = (le.via === 'batch') ? (' · ' + (Number(le.made) || 0) + ' 段') : '';
            const add = (' · 新增 ' + (Number(le.added) || 0) + ' 条');
            const chars = Number(le.chars) ? (' · AI ' + (Number(le.chars) >= 1000 ? ((Number(le.chars) / 1000).toFixed(1) + 'k') : Number(le.chars)) + ' 字') : '';
            const dims = (Array.isArray(le.dims) && le.dims.length) ? (' · ' + le.dims.slice(0, 4).join('/')) : '';
            const kws = (Array.isArray(le.keywords) && le.keywords.length) ? (' · 🔑 ' + le.keywords.slice(0, 6).join('、')) : '';
            // v2.61.0：提取前的「校对时钟」结果（用户要求：第一步先校对基本信息，再去提取）
            const cal = (le.calib && typeof le.calib === 'object') ? le.calib : null;
            const calText = (() => {
                if (!cal) return '';
                if (cal.skipped === 'auto-off') return ' · 🕒 未校对（时钟自动同步已关）';
                if (cal.skipped === 'disabled') return ' · 🕒 未校对（组件未启用）';
                if (cal.skipped === 'error') return ' · 🕒 校对失败';
                const c = cal.clock || {};
                const brief = [c.date, c.time].filter(Boolean).join(' ');
                if (!brief && !c.location) return ' · 🕒 无可校对信息';
                return ' · 🕒 ' + (cal.changed ? '已校对 ' : '时钟未变 ') + [brief, c.location].filter(Boolean).join(' · ');
            })();
            return t + ' · ' + viaLabel + '（' + trig + '）' + scope + made + add + chars + dims + kws + calText;
        })();
        out.push('<div class="ftt-item ftt-item--info ftt-inline" data-ftt-last-extract><b class="ftt-pipe-title">📤 最后一次提取</b>'
            + ' <span style="flex:1 1 auto;min-width:0" class="ftt-muted" data-ftt-last-extract-line>' + esc(line) + '</span></div>');
        // v2.75.0（用户要求）：「总览中查看提取内容，应该展示的是**注入内容**，而不是提取的 JSON 结构。」
        //   折叠块改为展示**当前实际注入给 AI 的正文**（`hooks.injectText()` → ST 注入通道读回，含结构头与「记忆结束。」），
        //   并给出字数；无注入时如实说明原因（注入开关关 / 未命中 / 空库），不再展示 AI 回复的 JSON 原文
        //   （原始输出仍留在调试日志与 `FTT.lastExtract().text` 里，供排障时取用）。
        const inj = (() => { try { return (typeof hooks.injectText === 'function') ? String(hooks.injectText() || '') : ''; } catch (e) { return ''; } })();
        if (inj) {
            out.push(hintDetailsHtml('查看注入内容（当前注入给 AI 的正文，' + inj.length + ' 字）',
                '<div class="ftt-pre ftt-extract-pre" data-ftt-inject-preview>' + esc(inj) + '</div>'));
        } else {
            out.push(hintDetailsHtml('查看注入内容',
                '<div class="ftt-muted" data-ftt-inject-preview>' + esc('当前没有注入内容（注入开关关闭 / 未命中 / 记忆库为空）。把「注入当前提示词」或「及时分析」打开即可在发送前写入。') + '</div>'));
        }
        return out.join('\n');
    })();

    // ⑤ 工具行（v2.52.0：移出「清除已处理记录」—— 该动作属 设定 → 数据管理；提示合并为一句话）
    const nsfwSt = (() => { try { return nsfwSoftenState(); } catch (e) { return null; } })();
    const nsfwBtn = '<button class="ftt-btn" data-ftt-action="nsfwSoften" id="ftt-nsfw-btn" title="按关键词找出露骨内容并交 AI 弱化（分析侧开关在设定「内容弱化」页）">🌶 弱化NSFW' + (nsfwSt && nsfwSt.candidates ? '（' + nsfwSt.candidates + '）' : '') + '</button>';
    // v3.0.2（用户要求：「立即 AI 摘要是分析记忆动作，应该与点击单个未分析楼层**联动**做提示」）：
    //   「⚡ 立即 AI 摘要」与「第 N 楼」是**同一个分析动作的两个入口**（都走 `genTracked` → 同一条 AI 管线），
    //   因此它们的**按钮态与提示必须联动**：任一入口在途时，另一个入口同帧禁用并写明原因（点下去会被拒，
    //   提前说清楚而不是等用户点了才提示）。渲染驱动（不靠点击时叠 class，紧跟的重绘会把它换掉）。
    const summaryBusy = batchBusy;                        // 批次（立即 AI 摘要）在途
    const oneFloorBusy = singleFloorBusy.size > 0;
    const summaryBtnTitle = summaryBusy
        ? '正在批量分析未摘要楼层（分段批量摘要进行中）—— 完成后可再次点击'
        : (oneFloorBusy ? ('正在分析第 ' + Array.from(singleFloorBusy).sort((a, b) => a - b).join('、') + ' 楼（会占用同一条 AI 管线）—— 等本次完成后再点')
            : '把全部未摘要楼层分段交给 AI 分析并落库（与「第 N 楼」是同一条分析管线的两个入口）');
    const summaryBtn = '<button class="ftt-btn ftt-primary' + (summaryBusy ? ' ftt-loading' : '') + '" type="button"'
        + ' data-ftt-action="summary" id="ftt-summary-btn"'
        + ((summaryBusy || oneFloorBusy) ? ' disabled' : '')
        + ' title="' + attr(summaryBtnTitle) + '">'
        + (summaryBusy ? ('⚡ 分析中…' + (() => { const bp = (typeof hooks.batchProgress === 'function') ? (hooks.batchProgress() || {}) : {}; const t = Number(bp.segTotal) || 0, d = Number(bp.segDone) || 0; return t ? ('（分段 ' + d + '/' + t + '）') : ''; })()) : '⚡ 立即 AI 摘要')
        + '</button>';
    lines.push('<div class="ftt-row">'
        + summaryBtn
        + '<button class="ftt-btn" data-ftt-action="repair" id="ftt-repair-btn" title="三段式修复：① JS 机械清理 → ② 候选筛选 → ③ 窄契约 AI 修订">🛠 自动修复</button>'
        + '<button class="ftt-btn" data-ftt-action="extractNow" id="ftt-extract-btn" title="按向量 / JS 抽取召回相关记忆并刷新注入（零 AI 为主，不占用分析管道，可与 AI 摘要并行；发送前也会自动刷新一次）">📤 提取记忆</button>'
        + '<button class="ftt-btn" data-ftt-action="parallelWeaveNow" id="ftt-weave-btn" title="手动触发平行事件推演（独立交织管线）">🧭 推演世界</button>'
        + nsfwBtn
        + '<button class="ftt-btn" data-ftt-action="inject" id="ftt-inject-btn">📤 立即注入</button>'
        + '</div>');
    // ⑥ 类目统计（一行胶囊）
    const sum = consoleSummary();
    lines.push('<div class="ftt-row"><span class="ftt-muted">📚 共 ' + sum.total + ' 条</span>'
        + sum.dims.map((d) => '<span class="ftt-badge">' + esc(d.label) + ' ' + d.count + '</span>').join(' ') + '</div>');
    // ⑦ 未摘要楼层（可点单楼分析）；已处理楼层只留一行计数（区间过长的历史信息不再平铺）
    //   v2.64.0（用户报告：「未摘要楼层…很多无法分析或不应该分析的会被展示出来…当原子数据对应的楼层存在时，
    //   则不需要分析」）：清单由 `hooks.pending` 给出，已在宿主侧按「已有记忆数据的楼层」跳过；
    //   此处再补一句被跳过的覆盖数，便于用户核对跳过机制确实生效。
    const pending = (typeof hooks.pending === 'function') ? (hooks.pending({}) || []) : [];
    if (pending.length) {
        // v2.96.0（用户报告「点击没任何反应」）：**正在分析中的楼层**由渲染决定「分析中」态 ——
        //   点击委托给节点叠的 `.ftt-loading` 会被紧随其后的那次重绘换掉，故真正的持续态必须来自状态：
        //   这里按 `singleFloorBusy` 渲染成禁用 + 转圈的按钮（V1 `updateFloorAnimDom()` 的同口径做法）。
        lines.push('<div class="ftt-item ftt-item--warn ftt-item--col"><b class="ftt-pend-title">⏳ 未摘要 ' + pending.length + ' 楼（可点击单楼分析）</b><div class="ftt-pend-list">'
            + pending.slice(0, 40).map((f) => {
                const loading = singleFloorBusy.has(Number(f));
                // v3.0.2 联动：**批量摘要（⚡ 立即 AI 摘要）在途**时，这些楼按钮同样禁用并写明原因
                //   （它们与批量摘要是同一条分析管线；点下去只会被拒，提前说明清楚）。
                const blockedByBatch = batchBusy && !loading;
                const dis = loading || blockedByBatch;
                const title = loading
                    ? '分析中…（等本次 AI 返回；结果会写回记忆并刷新本页）'
                    : (blockedByBatch ? '「⚡ 立即 AI 摘要」正在批量分析未摘要楼层 —— 等本次完成后再单独分析该楼' : '单独分析该楼层');
                return '<button class="ftt-btn ftt-sm ftt-floor-btn' + (loading ? ' ftt-loading' : '') + '" type="button"'
                    + ' data-ftt-action="summaryFloor" data-ftt-floor="' + attr(f) + '"'
                    + (dis ? ' disabled' : '')
                    + ' title="' + attr(title) + '">第' + esc(f) + '楼</button>';
            }).join(' ')
            + (pending.length > 40 ? ' …+' + (pending.length - 40) : '') + '</div></div>');
    }
    const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
    const covered = (() => { try { return floorCoverage(state).floors; } catch (e) { return 0; } })();
    lines.push('<div class="ftt-hint">✅ 已处理 ' + pf.length + ' 楼' + (pending.length ? (' · 待摘要 ' + pending.length + ' 楼') : ' · 最近楼层均已摘要')
        + (covered ? (' · 已有记忆数据 ' + covered + ' 楼') : '') + '</div>');
    if (ps.note) lines.push('<div class="ftt-hint" data-ftt-note>' + esc(ps.note) + '</div>');
    // ⑧ v2.66.0：最后一次提取放**最末端**（回顾性质，不占首屏；折叠内容给足高度）
    if (lastExtractLines) lines.push(lastExtractLines);
    // v2.66.0：总览统一容器（布局微调锚点：收紧区块间距、限高可滚的未摘要列表，见 style.css）
    return '<div class="ftt-overview">' + lines.join('\n') + '</div>';
}

/** 楼层号压缩为区间文本（V1 `processedRanges` 的等价简化） */
function rangesText(nums) {
    const out = [];
    let s = nums[0], p = nums[0];
    for (let i = 1; i < nums.length; i++) {
        if (nums[i] === p + 1) { p = nums[i]; continue; }
        out.push(s === p ? String(s) : s + '-' + p);
        s = p = nums[i];
    }
    out.push(s === p ? String(s) : s + '-' + p);
    return out.slice(-8).join('、') + (out.length > 8 ? ' …共 ' + out.length + ' 段' : '');
}

/** 维度列表（V1 同款：工具栏 + 搜索 + 多选 + 行内操作 + 速览 + 编辑器） */
/** 有「关系层」的分页（V1：记忆 / 计划 / 悬念 / 平行）—— 编辑器内带关系小表，行上带「🔗 关联」入口 */
const REL_TABDS = { memories: 'memories', plans: 'plans', suspense: 'suspense', parallels: 'parallels' };
// v2.80.0（用户要求：关系表 / 约束自查 收进设定页）：
//   四个列表页（记忆 / 计划悬念 / 平行）**只保留列表** —— 原 `📚 列表 / 🔗 关系表 / 🧷 约束自查`
//   三子标签与 `ps.relSub`、`subTabsHtml()` / `subViewHtml()` 一并移除；
//   关系表与约束自查正文改由「设定 → 约束」（`ui/constraint-page.js`）承载。
//   `REL_TABDS` 仍用于：① 编辑器内的关系小表（`relTableHtml(kind, id, {editor:true})`）；
//   ② `kindHasRel()` 判定「🔗 关联」行内入口（见 `ui/list-rows.js`）。

/**
 * 计划悬念页的「🧹 清理计划 / 🧹 清理悬念」按钮（V1 `plansHtml()`：各自库非空才显示；**不弹确认**）
 * 文案与 title 与 V1 逐字一致。
 */
function clearPSButtons() {
    const hasPlans = Array.isArray(state.plans) && state.plans.length > 0;
    const hasSusp = Array.isArray(state.suspense) && state.suspense.length > 0;
    return (hasPlans ? '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clearPlans" title="清空全部计划（需二次确认；留删除墓碑）">🧹 清理计划</button>' : '')
        + (hasSusp ? '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clearSuspense" title="清空全部悬念（需二次确认；留删除墓碑）">🧹 清理悬念</button>' : '');
}

/**
 * 角色页「🔧 修复角色」按钮（V1 `snapshotsHtml()`）：v1.172 出生日期倒挂 / 异常的角色数进优先档，
 * 按钮文案带「（⚠️N 优先）」角标；title 与 V1 逐字一致。
 */
function characterRepairButton() {
    let anomCount = 0;
    try { anomCount = (state.snapshots || []).filter((x) => snapshotBirthAnomaly(x)).length; } catch (e) { /* 忽略 */ }
    return '<button class="ftt-btn ftt-sm" data-ftt-action="characterRepair" title="出生日期倒挂者优先，其余按字数最薄弱 3 条">🔧 修复角色'
        + (anomCount ? '（⚠️' + anomCount + ' 优先）' : '') + '</button>';
}

/**
 * 计划悬念页「🔧 修复计划/悬念」按钮（V1 `plansHtml()`）：**有进行中计划或未解悬念才显示**
 *   （V1 `hasOpenPS` 条件），文案与 title 逐字一致。
 */
function planSuspRepairButton() {
    const hasOpenPS = (state.plans || []).some((p) => p && p.status === 'open')
        || (state.suspense || []).some((s) => s && s.status === 'open');
    return hasOpenPS ? '<button class="ftt-btn ftt-sm" data-ftt-action="planSuspRepair" title="了结已完成/已揭晓，合并重复并归并关联">🔧 修复计划/悬念</button>' : '';
}

/**
 * 情节页子标签状态（V1 `atomSubState` / `setAtomSub`）：'list' = 📜 情节列表 / 'segments' = 🧩 分段总结。
 * 非 'segments' 一律回落 'list'（与 V1 同口径）。
 */
export function atomSubState() { return String(ps.atomSub || 'list'); }
export function setAtomSub(v) {
    const k = String(v || '');
    ps.atomSub = (k === 'segments') ? 'segments' : 'list';
    return ps.atomSub;
}

/** 维度分页正文（分发器）：情节页 = 双子标签（📜 情节列表 / 🧩 分段总结，V1 v1.182/v1.206） */
function dimBody(kind) {
    if (kind === 'atoms') return atomsBody();
    return dimBodyList(kind);
}

/**
 * 情节页双子标签（V1 `atomsHtml` 结构）：📜 情节列表 + 🧩 分段总结。
 * 分段总结 = 把情节打包给 AI 拆成多段（`### 时间范围` + 段内剧情线），**只归档、不注入**；
 * 唯一消失途径 = 手动删除（「🧹 清理分段」或逐段 🗑）。
 */
function atomsBody() {
    const cur = atomSubState();
    const segs = (() => { try { return Array.isArray(state.plotSegments) ? state.plotSegments : []; } catch (e) { return []; } })();
    const tabs = '<div class="ftt-row ftt-subtabs" data-ftt-asubtabs>'
        + '<a href="javascript:void(0)" class="ftt-subtab' + (cur === 'list' ? ' ftt-on' : '') + '" data-ftt-asub="list">📜 情节列表（' + arrOf('atoms').length + '）</a>'
        + '<a href="javascript:void(0)" class="ftt-subtab' + (cur === 'segments' ? ' ftt-on' : '') + '" data-ftt-asub="segments" title="把情节打包给 AI 拆成多段总结并归档">🧩 分段总结（' + segs.length + '）</a>'
        + '<span class="ftt-hint ftt-ml-2">分段总结只归档、不注入 —— 唯一消失途径是手动删除</span></div>';
    return tabs
        + '<div data-ftt-asub-body="list" style="' + (cur === 'list' ? '' : 'display:none') + '">' + dimBodyList('atoms') + '</div>'
        + '<div data-ftt-asub-body="segments" style="' + (cur === 'segments' ? '' : 'display:none') + '">' + plotSegmentsBodyHtml() + '</div>';
}

/** 🧩 分段总结子页正文（V1 `atomsHtml` 的第二子页）：说明 + 工具栏 + 段落列表 */
function plotSegmentsBodyHtml() {
    const segs = (() => { try { return Array.isArray(state.plotSegments) ? state.plotSegments : []; } catch (e) { return []; } })();
    const view = sortPlotSegments(segs, 'desc');        // v1.190：默认按时间范围倒序（最新在最上、早期靠后）
    const out = [];
    out.push('<div class="ftt-cat-stat ftt-chip">共 ' + segs.length + ' 段分段总结</div>');
    out.push(shortHintHtml('分段总结：把情节打包交 AI 拆成多段归档（只归档、不注入）。'));
    out.push(hintDetailsHtml('说明', '<div>' + esc('每段以「### 时间范围」为头，段内按剧情线逐条列出。内容只作人工查阅，不参与注入 / 召回 / 遗忘；只有手动删除才会消失。列表默认按时间范围倒序。两个入口：①「生成分段总结」= 全部有效情节按时间切批；②「情节列表」多选后点「分段总结（N）」= 只归档勾选的那些。') + '</div>'));
    out.push('<div class="ftt-addbar ftt-toolbar"><button class="ftt-btn" data-ftt-action="summary" data-ftt-summary="plotSegments" title="把情节按时间打包交 AI 拆成多段总结（言简意赅、只陈述事实与数据）">🧩 生成分段总结</button><button class="ftt-btn" data-ftt-action="addEntry" data-kind="plotSegments">➕ 手动补一段</button>'
        + (segs.length ? '<button class="ftt-btn ftt-err" data-ftt-action="clearPlotSegments" title="清空全部分段总结（不弹确认）">🧹 清理分段</button>' : '') + '</div>');
    if (!segs.length) out.push('<div class="ftt-empty">暂无分段总结。点「🧩 生成分段总结」把情节交 AI 分段整理。</div>');
    else out.push(view.map((s) => {
        const lines = Array.isArray(s.lines) ? s.lines : [];
        const body = lines.map((ln, i) => '<div class="ftt-seg-line"><span class="ftt-seg-no">' + (i + 1) + '.</span> <b>' + esc(ln && ln.label) + '</b>：' + esc(ln && ln.text) + '</div>').join('');
        const rangeTxt = (s.start || s.end) ? (esc(s.start || '?') + (s.end && s.end !== s.start ? ' ~ ' + esc(s.end) : '')) : '';
        const meta = [
            s.atomCount ? '覆盖情节 ' + Number(s.atomCount) + ' 条' : '',
            (s.floorStart && s.floorEnd) ? '第 ' + s.floorStart + '-' + s.floorEnd + ' 楼' : '',
            s.manual ? '手动编辑' : 'AI 生成',
        ].filter(Boolean).join(' · ');
        return '<div class="ftt-item ftt-item--col"><div class="ftt-title-row"><b>### ' + esc(s.header || '未标注时间范围') + '</b></div>'
            + (rangeTxt ? '<div class="ftt-meta">🗓 ' + rangeTxt + '</div>' : '') + body
            + '<div class="ftt-meta">' + esc(meta) + '</div>'
            + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="plotSegments" data-id="' + attr(String(s.id || '')) + '" title="编辑该段（时间范围与剧情线）">✏️ 编辑</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="plotSegments" data-id="' + attr(String(s.id || '')) + '" title="删除该段（唯一的手动删除入口）">🗑 删除</button></div></div>';
    }).join('\n'));
    out.push('<div class="ftt-muted ftt-w-full">共 ' + segs.length + ' 段 · 该内容不注入、不参与遗忘，可随时编辑或删除。</div>');
    return out.join('\n');
}

/**
 * 平行页顶部「🚀 全部推进」条（V1 `parallelsHtml()` 的 `topBar` 逐字：
 *   文案 / title / 旁注与 V1 一致；V2 用 `data-ftt-action` + `data-id` 约定）。
 */
/** v2.99.0：自定义平行推演面板是否展开（模块态，随面板重绘保留） */
let customWeaveOpen = false;
/** v2.99.0：自定义推演是否在途（防连点；长耗时 AI 动作） */
let customWeaveBusy = false;
export function parallelCustomState() { return { open: customWeaveOpen, busy: customWeaveBusy }; }

/**
 * v2.99.0（用户要求）——**自定义平行世界**入口 + 输入区。
 * 「输入一段话交给 AI 单独去平行推演」：不读楼层正文、不受「推演世界」开关与去重影响；
 *   关键词命中的既有原子数据自动作为衔接/去重/客观性校验上下文；产物与常规推演**完全同构**。
 * 提示词显式允许**完全客观 / 非主角视角**（并禁止把事件牵引向主角），见 `core/parallel.js#buildCustomWeavePrompt`。
 */
function parallelCustomBar() {
    const btn = customWeaveBusy
        ? '<button class="ftt-btn ftt-sm ftt-loading" type="button" disabled title="AI 推演中…">🧪 自定义推演（推演中…）</button>'
        : '<button class="ftt-btn ftt-sm" data-ftt-action="parallelCustomOpen" title="输入一段设想，交 AI 单独推演一条新的平行世界（不读楼层正文；自动带上关键词关联的既有数据）">🧪 自定义推演（新增平行世界）</button>';
    const rows = ['<div class="ftt-row" style="margin:4px 0">' + btn
        + '<span class="ftt-muted">输入一段话 → AI 单独平行推演，并可带上关键词关联的既有数据；'
        + '完全客观或非主角视角的设想同样支持（不会强行牵引到主角）。</span></div>'];
    if (customWeaveOpen) {
        rows.push('<div class="ftt-editor"><div class="ftt-editor-title">🧪 自定义平行推演</div>'
            + '<div class="ftt-muted ftt-w-full">写下这段设想要推演什么（可以是纯客观事件、幕后势力动向、与主角无关的世界线；'
            + '主角可完全不出场）。AI 会按「以卦象为纲、以因果为线」的口径推演，产出与普通平行事件完全一致。'
            + '设想里出现、且在既有记忆里存在的词，会用来匹配相关的情节 / 记忆 / 状态 / 计划 / 悬念 / 传言 / 角色 / 场景 / 物品，作为衔接与去重依据。</div>'
            + '<div class="ftt-field ftt-field-col"><label>设想要推演的内容</label>'
            + '<textarea data-ftt-custom-weave="1" rows="5" placeholder="例如：与此同时，北方的盐商行会因河运中断而暗中改走陆路，镖局与地方衙门的态度开始分化……"></textarea></div>'
            + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="parallelCustomRun">🚀 交由 AI 推演</button>'
            + '<button class="ftt-btn" data-ftt-action="parallelCustomCancel">取消</button></div></div>');
    }
    return rows.join('\n');
}

/** 平行页顶部工具栏（V1「🚀 全部推进」条 + v2.99.0 自定义推演入口） */
function parallelTopBar() {
    return '<div class="ftt-row" style="margin:4px 0"><button class="ftt-btn ftt-sm" data-ftt-action="parallelAdvanceAll" title="全部平行事件交 AI 逐一推进">🚀 全部推进</button><span class="ftt-muted">记忆数据随推进一并交给 AI 作背景与种子；事件可能只是世界背景/间接相关，不会强行牵引到主角。</span></div>'
        + parallelCustomBar();
}

/** 平行事件行的「相关角色（角色不知情）」摘要（V1 `relSummaryLine('parallels', id, 6)` 的 V2 等价） */
function parallelRelWho(p) {
    try {
        const rows = relRowsOf('parallels', String((p && p.id) || ''));
        const people = rows.filter((x) => x && x.who);
        return people.length ? ('相关：' + people.slice(0, 6).map((x) => x.who).join('、') + '（角色不知情）') : '';
    } catch (e) { return ''; }
}

/**
 * 条目行「🔗 关联」入口（V1 `relJump` 的条目侧发起口）。
 * V1 文案/title 逐字对照：记忆 `🔗 关联（N）`（无人关联时不带角标，v1.206 `memoriesHtml()` 的 `relLink`）；
 *   计划 → 「在「设定 → 约束 → 关系表」里编辑这条计划的知情者」；悬念 → 「…编辑这条悬念的知情者」；
 *   平行事件 → 「…编辑平行事件的相关角色」。V1 用 `data-ftt-kind/-id`，V2 用 `data-kind/-id`（面板 DOM 委托口径）。
 *   title 的**落点自 v2.80.0 起改为「设定 → 约束」**（关系表由列表页子标签移入设定页，用户要求）。
 */
function relJumpBtn(kind, e) {
    if (!REL_TABDS[kind]) return '';
    const id = String((e && e.id) || '');
    if (!id) return '';
    let n = 0;
    try { n = relRowsOf(kind, id, { fresh: true }).filter((x) => x && x.who).length; } catch (x) { n = 0; }
    const title = kind === 'memories' ? '在「设定 → 约束 → 关系表」里查看 / 新建这条记忆的知情关联'
        : kind === 'plans' ? '在「设定 → 约束 → 关系表」里编辑这条计划的知情者'
            : kind === 'suspense' ? '在「设定 → 约束 → 关系表」里编辑这条悬念的知情者'
                : '在「设定 → 约束 → 关系表」里编辑平行事件的相关角色';
    const label = (kind === 'memories' && n) ? ('🔗 关联（' + n + '）') : '🔗 关联';
    return '<span class="ftt-rel-jump" data-ftt-action="relJump" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="' + attr(title) + '">' + esc(label) + '</span>';
}

/**
 * 平行事件行专属操作（V1 `parallelsHtml()` 逐条渲染的 `advBtn` / `proBtn` / `line8`）：
 *   · `🚀` 推进按钮：**已达衰退阈值（`parallelExpired`）时不显示**（且只在衰退机制开启时判定，V1 原样）；
 *   · `⬆` 转正按钮：**已转正（`promotedTo`）时不显示**；
 *   · 备注行：相关角色 / 「仅幕后（角色不知情）」+「 · 已转正为情节」+ 转正入口（文案与 V1 一致）。
 *   注（B9-b 更新）：V1 备注行里的「🔗 关联」跳转（`relJump`）已在本批移植 —— 由共用的行渲染
 *   `ui/list-rows.js` 渲染在行主体末尾（V1 把它放在备注行内，位置差异仅此一处）。
 *   v2.80.0：`relJump` 落点由「记忆 → 关系表」子标签改为「设定 → 约束 → 关系表」（见 `panelAction` 的 relJump 分支）。
 */
function parallelRowBits(e) {
    const id = String((e && e.id) || '');
    let expired = false;
    try { if (cfg.parallelDecayEnabled !== false) expired = parallelExpired(e); } catch (x) { /* 忽略 */ }
    const promoted = !!String((e && e.promotedTo) || '').trim();
    const who = parallelRelWho(e);
    const note = '<div class="ftt-note ftt-note-info">' + esc(who || '仅幕后（角色不知情）') + (promoted ? ' · 已转正为情节' : '')
        + (promoted ? '' : ' <span class="ftt-rel-jump" data-ftt-action="promoteParallel" data-id="' + attr(id) + '" title="转正为情节（需确认，原条不再注入）">⬆ 转正为情节</span>') + '</div>';
    const adv = expired ? '' : '<button class="ftt-op ftt-ok" data-ftt-action="parallelAdvance" data-id="' + attr(id) + '" title="推进该事件（附带记忆数据作种子）">🚀</button>';
    const pro = promoted ? '' : '<button class="ftt-op" data-ftt-action="promoteParallel" data-id="' + attr(id) + '" title="转正为情节（需确认）">⬆</button>';
    return { note: note, ops: adv + pro };
}

// ============================================================
// B9-c：货币页「👥 指定角色」标定（V1 v1.183 `currenciesHtml()` 的 head/trackChips/picker 三段）
//   V1 出处：`currenciesHtml()`（约 24156）、`trackPickState()`/`setTrackPick()`（约 23745）、
//   动作 `curTrackPick`/`curTrackClose`/`curTrackToggle`/`curTrackClear`（约 27480~27500）。
//   V1 的 `catStat('currencies')`（约 9745）与 `currenciesHtml` 顶部胶囊由此处等价实现：
//     `共 N 条货币 · M 个归属（前 3 个归属计数）` + 已标定时追加 ` · 已标定 K 名`。
//   选择器角色名单 = `knownCharacterNames()`（角色档案去重排序，V1 同源）；
//   行内「已标定」判定与 V1 选择器口径一致（去空白 + 小写比较），开关动作则用 V1 `isTrackedCurrencyOwner`。
// ============================================================

/** 货币页顶部统计胶囊（V1 `catStat('currencies')` + `tracked.length` 角标，逐字文案） */
function currencyStatText() {
    const list = arrOf('currencies');
    const owners = {};
    for (const x of list) { const k = String((x && x.owner) || ''); if (k) owners[k] = (owners[k] || 0) + 1; }
    const names = Object.keys(owners);
    const tracked = trackedCurrencyRoles();
    const base = '共 ' + list.length + ' 条货币' + (names.length
        ? (' · ' + names.length + ' 个归属（' + names.slice(0, 3).map((n) => n + ' ' + owners[n]).join(' / ') + (names.length > 3 ? ' …' : '') + '）')
        : '');
    return base + (tracked.length ? (' · 已标定 ' + tracked.length + ' 名') : '');
}

/** 货币页顶部（统计胶囊 + 说明 + 已标定胶囊；V1 `currenciesHtml` 的 `head` + `trackChips` 逐字） */
function currencyTopHtml() {
    const me = String(defaultCurrencyOwner() || '主角');
    const tracked = trackedCurrencyRoles();
    const head = '<div class="ftt-cat-stat ftt-chip">' + esc(currencyStatText()) + '</div>'
        + '<div class="ftt-note ftt-note-info">💰 默认只记<b>主角</b>（当前判定：' + esc(me) + '）持有的货币；其他角色的货币需在正文/编辑器里明确指定归属。额度按 万 / 亿 / 兆 / 京 动态显示，收支保留最近 12 笔。</div>';
    const trackChips = tracked.length
        ? '<div class="ftt-note ftt-note-info" data-ftt-track-chips>⭐ 已标定跟踪：' + tracked.map((n) => '<span class="ftt-badge ftt-badge--fact">' + esc(n) + '<span class="ftt-rel-jump" data-ftt-action="curTrackToggle" data-name="' + attr(n) + '" title="取消标定该角色"> ✖</span></span>').join(' ') + ' <span class="ftt-muted">被标定后：分析记忆会<b>恒定</b>考虑这些角色的货币（提示词 + 当前账本参照），注入时与主角一样恒定列出。</span></div>'
        : '';
    return head + trackChips;
}

/** 货币页工具行里的两个标定按钮（V1 `addBtn` 的 `curTrackPick` / `curTrackClear` 两支，文案与 title 逐字） */
function currencyTrackButtons() {
    const tracked = trackedCurrencyRoles();
    return '<button class="ftt-btn' + (trackPickState() ? ' ftt-primary' : '') + '" data-ftt-action="curTrackPick" title="从「角色」大类里指定要跟踪货币的角色（可多选；被标定后分析记忆会同时考虑其货币情况）">👥 指定角色' + (tracked.length ? '（' + tracked.length + '）' : '') + '</button>'
        + (tracked.length ? '<button class="ftt-btn ftt-err" data-ftt-action="curTrackClear" title="取消全部标定角色">✖ 清空标定</button>' : '');
}

/**
 * 「👥 指定跟踪角色」选择器（V1 `currenciesHtml` 的 `picker` 段逐字；角色来源 = 角色档案）。
 * 适配差异（登记）：V1 的搜索框是通用筛选条（`searchBoxHtml`：字段/排序/额外条件/模式 4 个下拉）；
 *   V2 沿用「选角色」面板的既有约定（单输入框，`data-ftt-search="currencyTrackPick"`），
 *   搜索词仍走 V1 同源的**页面搜索词槽**（V2 = `ps.q['currencyTrackPick']`）。
 */
function currencyPickPanelHtml() {
    if (!trackPickState()) return '';
    const names = knownCharacterNames();
    const tracked = trackedCurrencyRoles();
    const key = (nm) => String(nm).replace(/\s+/g, '').toLowerCase();
    const isOn = (nm) => tracked.some((t) => key(t) === key(nm));
    const q = String(ps.q.currencyTrackPick || '').trim().toLowerCase();
    const shown = q ? names.filter((nm) => String(nm).toLowerCase().indexOf(q) >= 0) : names;
    let body;
    if (!names.length) body = '<div class="ftt-empty">「角色」大类暂无已知角色：先运行「AI 摘要」生成角色档案，或在角色页添加角色。</div>';
    else if (!shown.length) body = '<div class="ftt-empty">无匹配角色（搜索：' + esc(ps.q.currencyTrackPick || '') + '）</div>';
    else {
        body = shown.map((nm) => {
            const on = isOn(nm);
            return '<div class="ftt-item" data-ftt-curpick-name="' + attr(nm) + '"><div class="ftt-item-main"><b>' + esc(nm) + '</b>'
                + (on ? ' <span class="ftt-badge ftt-badge--fact">已标定</span>' : '') + '</div>'
                + '<div class="ftt-item-ops"><button class="ftt-op' + (on ? ' ftt-ok' : '') + '" data-ftt-action="curTrackToggle" data-name="' + attr(nm) + '" title="' + (on ? '取消标定' : '标定为跟踪对象') + '">' + (on ? '✅' : '➕') + '</button></div></div>';
        }).join('\n');
    }
    return '<div class="ftt-editor"><div class="ftt-editor-title">👥 指定跟踪角色 · 从「角色」大类选择（已标定 ' + tracked.length + ' 名）</div>'
        + '<div class="ftt-muted ftt-w-full">被标定的角色：后续<b>分析记忆</b>会恒定把他们的货币纳入考虑（追加「货币 · 标定跟踪」提示词 + 投喂当前货币账本作为更新参照），<b>注入</b>时与主角一样恒定列出（行尾标 ⭐已标定）。</div>'
        + '<input class="ftt-input" type="text" data-ftt-search="currencyTrackPick" value="' + attr(ps.q.currencyTrackPick || '') + '" placeholder="搜索角色名…">'
        + '<div class="ftt-hint">角色档案 ' + names.length + ' 名 · 显示 ' + shown.length + ' 名</div>'
        + '<div data-ftt-cur-list="currencyTrackPick">' + body + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="curTrackClose">关闭</button></div></div>';
}

/** 货币页专属顶部（统计/说明/标定胶囊）—— 选择器另经 `currencyPickPanelHtml()` 渲染在工具行之后 */
function currenciesTopHtml() {
    try { return currencyTopHtml(); } catch (e) { return ''; }
}

function dimBodyList(kind) {
    const q = ps.q[kind] || '';
    const list = listOf(kind, q, 300);
    const total = arrOf(kind).length;
    const sel = selOf(kind);
    const multi = ps.multi[kind] === true;
    const hiddenN = kind === 'atoms' ? hiddenCount() : 0;
    const toolbar = '<div class="ftt-addbar ftt-toolbar">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="' + attr(kind) + '">➕ 新增</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="multiToggle" data-kind="' + attr(kind) + '" title="切换单选 / 多选">' + (multi ? '☑ 多选模式' : '☐ 单选模式') + '</button>'
        // V1 `bulkHtml()`（v1.206 术语）：情节页多选模式追加「🧷 情节总结（N）」（合并成一条 A~B 总结、
        //   原文保留并隐藏）与「🧩 分段总结（N）」（归档到分段总结子页，只归档不注入）——
        //   文案 / title / disabled 条件与 V1 逐字一致（V1 用 `data-ftt-kind`，V2 统一用 `data-kind`）
        + ((multi && kind === 'atoms') ? ('<button class="ftt-btn" data-ftt-action="atomMergeSummary" data-kind="atoms"' + (sel.size ? '' : ' disabled') + ' title="【情节总结】把勾选的情节交 AI 聚合成一条情节（标题标记「【A~B 总结】」）；原文保留并隐藏，不参与注入与淘汰，除非人工删除（可在总结上点 🧩 穿透查看）">🧷 情节总结（' + sel.size + '）</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="plotSegmentSummarySel" data-kind="atoms"' + (sel.size ? '' : ' disabled') + ' title="【分段总结】把勾选的情节按剧情时间打包交 AI 分成多段，归档到「🧩 分段总结」子页供人工管理（只归档、不注入、不参与任何自动动作）">🧩 分段总结（' + sel.size + '）</button>') : '')
        + (multi ? ('<button class="ftt-btn ftt-sm" data-ftt-action="selectAll" data-kind="' + attr(kind) + '">全选</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="selectNone" data-kind="' + attr(kind) + '">清空选择</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="bulkDelete" data-kind="' + attr(kind) + '"' + (sel.size ? '' : ' disabled') + '>🗑 删除选中（' + sel.size + '）</button>') : '')
        + (kind === 'atoms' ? ('<button class="ftt-btn ftt-sm" data-ftt-action="atomToggleHidden">' + (ps.showHidden ? '🙈 隐藏已总结' : ('👁 显示已总结（' + hiddenN + '）')) + '</button>') : '')
        // V1 `memoriesHtml()`：记忆页新增「🔧 修复记忆」顶部按钮（融合同归属高相似记忆；与修复同管道）——
        //   仅在有记忆时显示（V1 `memList.length` 条件），文案与 title 逐字对齐
        + (kind === 'memories' && total ? '<button class="ftt-btn ftt-sm" data-ftt-action="memoryRepair" title="融合相似记忆并清理孤儿关联">🔧 修复记忆</button>' : '')
        // V1 `conceptsHtml()`：概念页顶部「🔧 修复概念」按钮（修复错乱/冗余并融合相似概念）——
        //   仅在有概念时显示（V1 `state.concepts.length` 条件），文案与 title 逐字对齐
        + (kind === 'concepts' && total ? '<button class="ftt-btn ftt-sm" data-ftt-action="conceptRepair" title="修复概念错乱/冗余，并融合相似概念">🔧 修复概念</button>' : '')
        // V1 `scenesHtml()`：场景页按钮 **无显隐条件**（场景树为空时 V1 也照常渲染 sceneBar）——
        //   文案与 title 逐字对齐
        + (kind === 'scenes' ? '<button class="ftt-btn ftt-sm" data-ftt-action="sceneRepair" title="复用「立即修复」管道，修正场景树错乱的结构/用词不当">🔧 修复结构/用词</button>' : '')
        // V1 `itemsHtml()`：物品页顶部「🔧 修复物品」按钮（修复冗余/记录错误 + 结合正文更新最新流转）——
        //   仅在有物品时显示（V1 `itemList.length` 条件），文案与 title 逐字对齐
        + (kind === 'items' && total ? '<button class="ftt-btn ftt-sm" data-ftt-action="itemRepair" title="修复物品冗余与记录错误，并更新流转信息">🔧 修复物品</button>' : '')
        // V1 `snapshotsHtml()`：角色页顶部「🔧 修复角色」按钮（结合正文补全档案 / 保守删除明显错误）——
        //   v1.172：出生日期倒挂 / 异常的角色数进优先档，按钮文案带「（⚠️N 优先）」角标；
        //   仅在有角色时显示（V1 `snapList.length` 条件），文案与 title 逐字对齐
        + (kind === 'snapshots' && total ? characterRepairButton() : '')
        // V1 `plansHtml()`：计划悬念页「🔧 修复计划/悬念」（有进行中计划或未解悬念才显示）+
        //   「🧹 清理计划」「🧹 清理悬念」（各自库非空才显示）——文案与 title 逐字对齐；V1 不弹确认
        + (kind === 'plans' ? (planSuspRepairButton() + clearPSButtons()) : '')
        // V1 `rumorsHtml()`：传言页工具条 —— 「🧪 立即演化」恒显、「🧹 清理传言」仅在有传言时显示（文案与 title 逐字对齐）
        + (kind === 'rumors' ? ('<button class="ftt-btn ftt-sm" data-ftt-action="rumorEvolve" title="立即执行一次机械演化（载体老化 / 发酵消退 / 平行联动 / 裂变）">🧪 立即演化</button>'
            + (total ? '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clearRumors" title="清空全部传言（留删除墓碑）">🧹 清理传言</button>' : '')) : '')
        // V1 `currenciesHtml()`：货币页「👥 指定角色（N）」（恒显，开启选择器时加 ftt-primary）与
        //   「✖ 清空标定」（仅在有标定角色时显示）—— 文案与 title 逐字对齐（B9-c）
        + (kind === 'currencies' ? currencyTrackButtons() : '')
        + '</div>'
        + (kind === 'rumors' ? ('<div class="ftt-hint">📢 按剧情时间机械演化（零 AI）：每 <b>' + rumorEveryRounds() + '</b> 楼一次、变化需 <b>' + rumorNeedRounds() + '</b> 轮生效（已演化 ' + (Number((rumorTickState() || {}).runs) || 0) + ' 次）；传言未经证实，注入只作参考。</div>') : '')
        + (kind === 'atoms' ? '<div class="ftt-hint">已总结的情节不参与注入 / 淘汰 / 修复 / 质检等任何自动动作（持久保留，除非人工删除）。</div>' : '');
    const head = '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-search="' + attr(kind) + '" value="' + attr(q) + '" placeholder="搜索（标题 / 正文 / 标签 / 归属）">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="searchClear" data-ftt-search-kind="' + attr(kind) + '" title="清除搜索与筛选">✕ 清除</button>'
        + '<span class="ftt-muted">' + (q ? '匹配 ' + list.length + ' / ' : '共 ') + total + ' 条</span></div>';
    // v2.80.0：列表页不再有子标签（关系表 / 约束自查已移入「设定 → 约束」）→ 此处分页正文只渲染列表。
    const ed = ps.editing && ps.editing.kind === kind
        ? (editorHtml(kind, ps.editing.id, ps.editing.preset) + (REL_TABDS[kind] ? relTableHtml(kind, ps.editing.id || '', { editor: true }) : ''))
        : '';
    // 场景页（V1 `scenesHtml()`）：**聚合树**（虚节点 / 当前位置高亮 / 折叠），不是平铺列表；
    //   树自带统计/搜索/工具条（含 ➕ 添加顶层场景、🔧 修复结构），编辑器仍由面板侧提供。
    if (kind === 'scenes') return ed + scenesTreeHtml({ q: q, multi: multi, sel: sel });
    const peek = (kind === 'atoms' && ps.peek) ? peekHtml(ps.peek) : '';
    // B8-7-b：平行页顶部「🚀 全部推进」条（V1 `parallelsHtml()` 的 topBar；空库时同样显示）
    const ptb = (kind === 'parallels') ? parallelTopBar() : '';
    // B9-c：货币页顶部（统计胶囊 + 说明 + 已标定胶囊）与「👥 指定跟踪角色」选择器
    //   位置：胶囊在工具行之前（V1 `currenciesHtml` 的 head/trackChips），选择器在工具行之后（V1 的 addBtn 之后）
    const curTop = (kind === 'currencies') ? currenciesTopHtml() : '';
    const curPick = (kind === 'currencies') ? currencyPickPanelHtml() : '';
    if (!list.length) return curTop + toolbar + curPick + ptb + head + ed + peek + '<div class="ftt-empty">（' + (q ? '没有匹配的条目' : '该类目暂无条目') + '）</div>';
    const rows = list.map((e) => {
        const id = String(e.id || '');
        // v2.47.0（用户报告）：行正文按 **V1 各维度行渲染器**的字段集合与顺序输出（见 ui/list-rows.js）。
        //   情节/记忆/角色/物品/货币/传言/计划/悬念/概念/平行 各用各自的行；现实墙钟仅以「现实更新 …」出现
        //   （由 parallels 行与内存行内统一处理，绝不与 📅 剧情日期混同）。
        const hidden = kind === 'atoms' && (() => { try { return atomIsHidden(e); } catch (x) { return false; } })();
        const box = multi ? ('<input type="checkbox" data-ftt-select="' + attr(kind) + '" data-ftt-id="' + attr(id) + '"' + (sel.has(id) ? ' checked' : '') + ' title="选中">') : '';
        const peekBtn = (kind === 'atoms' && hidden) ? ('<button class="ftt-op" data-ftt-action="atomPeek" data-ftt-id="' + attr(id) + '" title="穿透查看被总结的原文">🔍</button>') : '';
        const par = (kind === 'parallels') ? parallelRowBits(e) : null;
        // 平行行的「相关角色 / 转正」备注在 V1 属**行内第 8 行** → 已并入 `listRowMainHtml('parallels')`，
        //   此处不再重复输出（`par.ops` 仍提供 🚀/⬆ 操作按钮）。
        // 记忆/平行/计划/悬念的「🔗 关联」已由 `listRowMainHtml` 按 **V1 行内位置**输出，此处不重复
        const relJump = '';
        const editBtn = '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="编辑">✏️</button>';
        const delBtn = '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="' + attr(kind) + '" data-id="' + attr(id) + '" title="删除（留墓碑）">🗑</button>';
        // v2.71.0（用户要求）：「平行大类…列表右侧按钮会大量挤占空间。默认应该将按钮**竖向排列**，V1 也有类似处理。」
        //   V1 `parallelsHtml()`（v1.206 24481）正是把这一页的操作区写成 `<div class="ftt-item-ops ftt-ops-col">`
        //   （CSS 22758：`flex-direction: column`），其余维度沿用横向 `.ftt-item-ops`。此处按 V1 口径对齐：
        //   平行行 = 一个**竖排操作列**（🚀 推进 / ⬆ 转正 / ✏️ 编辑 / 🗑 删除 + 选中态的多选由左侧方框承担），
        //   行主体仍占满剩余宽度（`.ftt-grow`），不再被按钮横向挤压。
        const opsInner = (par ? par.ops : '') + peekBtn + editBtn + delBtn;
        const ops = (kind === 'parallels')
            ? ('<div class="ftt-item-ops ftt-ops-col">' + opsInner + '</div>')
            : opsInner;
        // v3.0.13：本次刚推演落库的平行事件 → 行上带定位锚点 + 「🆕 本次新增」标记（重绘后自动滚入视野）
        const flashed = (kind === 'parallels' && ps.flash && Array.isArray(ps.flash.ids) && ps.flash.ids.indexOf(id) >= 0);
        const flashAttr = flashed ? (' data-ftt-flash-id="' + attr(id) + '"') : '';
        const flashBadge = flashed ? '<b class="ftt-ok">🆕 本次新增</b>' : '';
        return '<div class="ftt-item ftt-inline"' + flashAttr + '>' + box
            + '<span class="ftt-grow">' + listRowMainHtml(kind, e) + relJump + flashBadge + '</span>'
            + ops
            + '</div>';
    }).join('\n');
    return curTop + toolbar + curPick + ptb + head + ed + peek + rows;
}

/** 情节速览（V1 atomPeek 的只读穿透视图） */
function peekHtml(id) {
    const d = consoleEntry('atoms', id);
    if (!d) return '';
    return '<div class="ftt-item ftt-item--info ftt-item--col"><b>🔍 速览 · ' + esc(String(d.item.title || id)) + '</b>'
        + '<div class="ftt-hint" style="white-space:pre-wrap">' + esc(String(d.item.text || '')) + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="atomPeekClose">收起</button></div></div>';
}

/** 表单值：数组/结构化字段 → 文本（V1 编辑器的展示口径） */
function flatFor(kind, item) {
    const it = item || {};
    if (kind === 'snapshots') return flattenSnapshot(it);
    const out = Object.assign({}, it);
    ['tags', 'keywords', 'entities', 'locations', 'characters', 'traits', 'quirks', 'values', 'todos', 'commitments'].forEach((k) => {
        if (Array.isArray(out[k])) out[k] = out[k].join('，');
    });
    if (kind === 'rumors') {
        out.carriersText = (Array.isArray(it.carriers) ? it.carriers : []).map((c) => String(c && c.who || '') + (c && c.role && c.role !== '传播者' ? ':' + c.role : '')).filter(Boolean).join('\n');
        out.mediaText = (Array.isArray(it.media) ? it.media : []).map((m) => [m && m.type, m && m.name, m && m.date, m && m.durability].filter((x) => x !== undefined && x !== null && x !== '').join('|')).join('\n');
    }
    if (kind === 'plotSegments') {
        out.linesText = (Array.isArray(it.lines) ? it.lines : []).map((l) => String(l && l.label || '') + ': ' + String(l && l.text || '')).join('\n');
    }
    if (kind === 'parallels' && Array.isArray(it.goalOdds)) out.goalOdds = JSON.stringify(it.goalOdds);
    return out;
}

/**
 * 某场景的**父级场景 id**（V1 `findSceneParentId` 23352 逐字）：
 * 路径去掉末段即为父级路径，在场景库里按路径找到该父级记录并返回其 id；顶层或无父级记录 → ''。
 * v2.50.0（用户报告「场景收纳能力异常」）：此前 V2 **没有**这一步 —— 编辑一条嵌套场景时父级下拉恒为「（顶层）」，
 *   用户直接点保存就会把该场景**拍平成顶层**（`pathArr` 退化为 `[name]`），层级被悄悄丢掉。
 */
function findSceneParentId(scene) {
    try {
        const arr = Array.isArray(scene && scene.pathArr) ? scene.pathArr.slice() : [];
        if (arr.length <= 1) return '';
        const parentKey = arr.slice(0, -1).join('>');
        const p = (arrOf('scenes') || []).find((x) => ((Array.isArray(x.pathArr) ? x.pathArr.join('>') : String(x.pathStr || '')) === parentKey));
        return p ? String(p.id || '') : '';
    } catch (e) { return ''; }
}

/** 编辑器（V1 `ftt-editor` 结构；字段表来自 `kindFields(kind)`，保存经 `deconstructEntry` 还原为入库 raw） */
function editorHtml(kind, id, preset) {
    const isNew = !id;
    const d = isNew ? null : consoleEntry(dataKindOf(kind), id);
    if (!isNew && !d) return '<div class="ftt-empty">（条目已不存在）</div>';
    const base = new Map();
    try { prefillEditor(kind, base, isNew ? null : d.item, preset); } catch (e) { /* 忽略 */ }
    const rows = kindFields(kind).map((f) => {
        const val = base.has(f.key) ? base.get(f.key) : '';
        if (f.type === 'relTable') {
            const rels = (!isNew && d && d.rels) ? d.rels : [];
            return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + '</label><div class="ftt-hint">'
                + (rels.length ? esc(rels.map((r) => (r.who || '公共') + (r.how ? '(' + r.how + ')' : '')).join('、')) : '（无关联 · 关系表编辑见批次 B5）') + '</div></div>';
        }
        if (f.type === 'checkbox') {
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><input type="checkbox" data-ftt-ed="' + attr(f.key) + '"' + (val === true ? ' checked' : '') + '></div>';
        }
        if (f.type === 'select') {
            const opts = (f.options || []).map((o) => {
                const ov = (o && typeof o === 'object') ? o.value : o;
                const ol = (o && typeof o === 'object') ? o.label : o;
                return '<option value="' + attr(ov) + '"' + (String(val) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>';
            }).join('');
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
        }
        if (f.type === 'sceneParent') {
            // v2.50.0（对齐 V1 23300~23313）：父级下拉 = 顶层 + **全部场景按完整路径排序**，
            //   标签带层级缩进与完整路径（`　　name（A>B>name）`），选中项 = 预设父级 或 **该条自身的父级**。
            const item = (!isNew && d) ? d.item : null;
            const selId = String((preset && preset.parentSceneId) || (item ? findSceneParentId(item) : '') || '');
            const all = arrOf('scenes').slice().sort((a, b) => {
                const pa = (Array.isArray(a.pathArr) ? a.pathArr.join('/') : String(a.pathStr || a.name || ''));
                const pb = (Array.isArray(b.pathArr) ? b.pathArr.join('/') : String(b.pathStr || b.name || ''));
                return pa.localeCompare(pb);
            });
            const opts = ['<option value="">（顶层）</option>'].concat(all.map((sc) => {
                const depth = Math.max(0, (Array.isArray(sc.pathArr) ? sc.pathArr.length : 1) - 1);
                const label = '　'.repeat(depth) + String(sc.name || '') + '（' + (Array.isArray(sc.pathArr) ? sc.pathArr.join('>') : String(sc.name || '')) + '）';
                return '<option value="' + attr(sc.id) + '"' + (String(sc.id) === selId ? ' selected' : '') + '>' + esc(label) + '</option>';
            })).join('');
            return '<div class="ftt-field"><label>' + esc(f.label) + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
        }
        if (f.type === 'textarea') {
            return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + '</label><textarea data-ftt-ed="' + attr(f.key) + '" rows="4">' + esc(val) + '</textarea></div>';
        }
        return '<div class="ftt-field"><label>' + esc(f.label) + '</label><div class="ftt-grow"><input type="' + attr(f.type || 'text') + '" data-ftt-ed="' + attr(f.key) + '" value="' + attr(val) + '"></div></div>';
    }).join('\n');
    return '<div class="ftt-editor">'
        + '<div class="ftt-editor-title">' + (isNew ? '➕ 新增' : '✏️ 编辑') + ' · ' + esc(kindLabelOf(kind)) + (id ? (' · ' + esc(id) + ' · 内容哈希 ' + esc((d && d.hash) || '')) : '') + '</div>'
        + rows
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="save" data-kind="' + attr(kind) + '" data-id="' + attr(id || '') + '">💾 保存</button>'
        + '<button class="ftt-btn" data-ftt-action="closeEntry" data-kind="' + attr(kind) + '">取消</button></div>'
        + '</div>';
}

function kindLabelOf(kind) {
    const d = DIMENSIONS.filter((x) => x.kind === kind)[0];
    if (d) return d.label;
    if (kind === 'suspense') return '悬念';
    return String(kind);
}

/** 编辑器初值（字段 key → 值）；preset 用于「新增」路径（状态主体 / 父级场景） */
function prefillEditor(kind, out, item, preset) {
    const p = preset || {};
    if (!item) {
        if (kind === 'states' && p.subject) out.set('subject', String(p.subject));
        if (kind === 'scenes' && p.parentSceneId) out.set('parent', String(p.parentSceneId));
        if (kind === 'scenes' && p.name) out.set('name', String(p.name));
        if (kind === 'plans' || kind === 'suspense') { out.set('status', kind === 'plans' ? 'open' : 'open'); out.set('phase', ''); }
        if (kind === 'items') out.set('carried', false);
        if (kind === 'snapshots') out.set('deceased', false);
        return out;
    }
    const flat = flatFor(kind, item);
    for (const f of kindFields(kind)) {
        const v = flat[f.key];
        if (v === undefined || v === null) { out.set(f.key, f.type === 'checkbox' ? false : ''); continue; }
        out.set(f.key, f.type === 'checkbox' ? (v === true) : v);
    }
    return out;
}

/** 从 DOM 读取编辑器表单（真实 DOM 路径；桩 DOM 由调用方直接传 fields） */
function collectEditorFields(el) {
    const fields = {};
    try {
        if (!el || typeof el.querySelectorAll !== 'function') return fields;
        for (const node of el.querySelectorAll('[data-ftt-ed]')) {
            const key = node.getAttribute('data-ftt-ed');
            if (!key) continue;
            fields[key] = (node.type === 'checkbox') ? !!node.checked : String(node.value == null ? '' : node.value);
        }
    } catch (e) { /* 忽略 */ }
    return fields;
}

/** 状态页：按主体分组（V1 同款：每组标题带「➕ 添加」「🗑 删除分组」） */
function statesBody() {
    // v2.62.0（用户要求：核对状态大类的提示词等细节，确保对齐 V1）—— 状态页按 V1 `statesHtml()`（v1.206 23988~24027）对齐：
    //   ① 分组键：`String(subject||'').trim() || '（无主体）'`（V1 对空白主体同样归到「（无主体）」）；
    //   ② 主体排序：`subjects.sort((a,b)=>a.localeCompare(b))`（V1 原文；此前 V2 用列表顺序，组序与 V1 不一致）；
    //   ③ 检索：`fieldHay(s, 字段范围).includes(q) || subject.includes(q)`（V1 语义：命中角色名也保留）；
    //   ④ 额外条件：全部状态 / 仅已失效（V1 `pageExtraOptions('states')`）；
    //   ⑤ 排序：默认 / 最新在前 / 最早在前 / 重要度 / 调用次数（V1 `pageSortItems`）；
    //   ⑥ 文案：占位符与空态、无匹配文案逐字对齐 V1。
    const q = String(ps.q.states || '');
    const qs = q.trim().toLowerCase();
    const f = listFilterOf('states');
    const all = arrOf('currentStates');
    const byQ = qs
        ? all.filter((it) => fieldHayOf(it, f.field).includes(qs) || String((it && it.subject) || '').toLowerCase().includes(qs))
        : all.slice();
    const byE = byQ.filter((it) => { try { return extraMatchOf('states', it, f.extra); } catch (e) { return true; } });
    const matched = listSortOf('states', byE);
    const groups = new Map();
    for (const e of matched) {
        const k = String((e && e.subject) || '').trim() || '（无主体）';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
    }
    const subjects = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const multi = ps.multi.states === true;
    const sel = selOf('states');
    const repBtn = all.length
        ? '<button class="ftt-btn ftt-sm" data-ftt-action="stateRepair" title="匹配角色 → 机械清理与字段规范化 → 交 AI 整理">🔧 修复状态</button>'
        : '';
    const filterBar = listFilterBarHtml('states', {
        placeholder: '搜索：角色 / 字段 / 值 / 关键词…',
        extraOpts: [['all', '全部状态'], ['inactive', '仅已失效']],
        countText: '共 ' + all.length + ' 条 · 命中 ' + matched.length,
    });
    const toolbar = '<div class="ftt-addbar ftt-toolbar">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="states">➕ 新增</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="multiToggle" data-kind="states" title="切换单选 / 多选">' + (multi ? '☑ 多选模式' : '☐ 单选模式') + '</button>'
        + (multi ? ('<button class="ftt-btn ftt-sm" data-ftt-action="selectAll" data-kind="states">全选</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="selectNone" data-kind="states">清空选择</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="bulkDelete" data-kind="states"' + (sel.size ? '' : ' disabled') + '>🗑 删除选中（' + sel.size + '）</button>') : '')
        + repBtn + '</div>';
    const ed = ps.editing && ps.editing.kind === 'states' ? editorHtml('states', ps.editing.id, ps.editing.preset) : '';
    const head = '<div class="ftt-cat-stat ftt-chip">共 ' + all.length + ' 条状态（有效 ' + all.filter((x) => String((x && x.status) || 'active') !== 'inactive').length + '）· ' + groups.size + ' 个角色组</div>'
        + filterBar + toolbar + ed;
    // 文案与 V1 逐字一致（空库 / 有库但筛选无命中）
    if (!all.length) return head + '<div class="ftt-empty">暂无状态记录。运行「AI 摘要」或点「添加状态」创建。</div>';
    if (!matched.length) return head + '<div class="ftt-empty">无匹配结果（搜索/筛选：' + esc(String(q)) + '）</div>';
    const blocks = subjects.map((subj) => {
        const items = groups.get(subj).slice().sort((a, b) => (Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0));
        const rows = items.map((e) => {
            const id = String(e.id || '');
            const box = multi ? ('<input type="checkbox" data-ftt-select="states" data-ftt-id="' + attr(id) + '"' + (sel.has(id) ? ' checked' : '') + ' title="选中">') : '';
            return '<div class="ftt-item ftt-inline">' + box + '<span class="ftt-grow">' + stateRowMainHtml(e) + '</span>'
                + '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="states" data-id="' + attr(id) + '" title="编辑这条状态记录">✏️</button>'
                + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="states" data-id="' + attr(id) + '" title="删除这条状态记录">🗑</button></div>';
        }).join('\n');
        return '<h4 class="ftt-h4-inline ftt-mt-6">👤 ' + esc(subj) + ' <span class="ftt-muted">(' + groups.get(subj).length + ')</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="addStateFor" data-ftt-subject="' + attr(subj) + '">➕ 添加</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delStateGroup" data-ftt-subject="' + attr(subj) + '" title="删除该角色全部状态">🗑 删除分组</button></h4>'
            + rows;
    }).join('\n');
    return head + blocks;
}

/** 设置分页：V1 的 **14 组子页**（子标签条 + 当前页控件；写回内核 cfg 并持久化） */
function settingsBody() {
    const cur = SETTINGS_TABS.some((t) => t.id === ps.settingsSub) ? ps.settingsSub : SETTINGS_TABS[0].id;
    const label = (SETTINGS_TABS.filter((t) => t.id === cur)[0] || {}).label || cur;
    return [
        '<div class="ftt-row ftt-settings-subtabs">' + settingsSubTabsHtml(cur) + '</div>',
        // v2.55.0（用户要求：页面上不要开发/历史内容）：标题行只留「设定 · <页名>」，
        //   不再展示「N 个配置项 · 共 X 项 / 13 页 · 结构与 V1 同名同序」这类实现与沿革说明。
        '<div class="ftt-hint">设定 · ' + esc(label) + '</div>',
        // v2.43.0（用户要求）：「V2 附加设定」不再挂在**每个**设定子页的最底部，而是作为
        //   「基础」页的一块固定分节（默认进入设定页就是基础页，故仍一眼可见）。
        '<div class="ftt-settings-page" data-ftt-settings-page="' + attr(cur) + '">'
            + settingsPageHtml(cur, cur === 'base' ? v2ExtrasSectionHtml() : '')
            // v2.80.0（用户要求：关系表 / 约束自查 收进设定页）：「约束」页正文由 `ui/constraint-page.js`
            //   渲染（四维关系表 + 约束自查）；它无配置控件，故不经过 `settingsPageHtml` 的控件表。
            + (cur === 'constraint' ? constraintPageHtml() : '') + '</div>',
        (cur === 'prompts' ? atomCompactSectionHtml() : ''),
        // v2.54.0（用户报告「导出 UI 设计有问题」）：导出结果只出现在**数据管理页**（就近显示在导出分节下方），
        //   其它子页不再吊一个来路不明的文本框；标题也写清「这是什么、要拿它做什么」。
        (cur === 'data' && ps.exportText
            ? ('<div class="ftt-field ftt-field-col"><label>导出结果（上面「⬇ 导出 JSON 文件」的内容；浏览器未触发下载时可从这里手动复制保存）</label>'
                + '<textarea data-ftt-export="1" rows="6">' + esc(ps.exportText) + '</textarea></div>')
            : ''),
    ].join('\n');
}

/**
 * 「V2 附加设定」分节（V2 独有：更新检查 / V1 数据导入 / 维度开关 / 面板宽度）。
 * v2.43.0：由「所有设定子页的页脚」改为「基础页内的一块分节」—— 位置由 `settingsPageHtml('base', …)` 注入，
 *   因此它随基础页一起滚动，不再固定吊在每个子页末尾。
 */
export function v2ExtrasSectionHtml() {
    return [
        '<div class="ftt-section" data-ftt-section="v2-extras">',
        '<div class="ftt-sec-title">附加设定 <span class="ftt-muted">更新检查 · 旧数据导入 · 启用维度 · 面板宽度</span></div>',
        v2ExtrasHtml(),
        '</div>',
    ].join('\n');
}

/** V2 附加设定块的控件（V1 没有、但 V2 已有的能力：更新检查、V1 导入、维度勾选、面板宽度） */
function v2ExtrasHtml() {
    // 更新相关键属于**适配层设置**（extensionSettings），不是内核 cfg —— 读写都走 settings，避免"改了不生效"
    const s = (() => { try { return getSettings() || {}; } catch (e) { return {}; } })();
    const repo = String(s.updateRepo || '');
    // 宽度档位（非法/缺失 → 默认档；`0` 是合法值 = 铺满，故用 Number.isFinite 判定而非 `||`）
    const curWidth = (() => { const n = Number(s.panelMaxWidth); return Number.isFinite(n) && n >= 0 ? n : 1280; })();
    return [
        '<div class="ftt-row"><label class="ftt-switch"><input type="checkbox" data-ftt-v2="autoUpdateCheck"' + (s.autoUpdateCheck !== false ? ' checked' : '') + '><span class="ftt-slider"></span></label><span class="ftt-muted">启动时自动检查更新（内置延迟 4 秒执行，避开启动高峰）</span>',
        '<input type="text" class="ftt-input" data-ftt-v2="updateRepo" value="' + attr(repo) + '" placeholder="更新检查仓库地址">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="check-update">🔍 检查更新</button></div>',
        '<div class="ftt-row"><label class="ftt-switch"><input type="checkbox" data-ftt-v2="useStGitEndpoint"' + (s.useStGitEndpoint === true ? ' checked' : '') + '><span class="ftt-slider"></span></label><span class="ftt-muted">使用宿主 Git 更新端点（默认关）</span></div>',
        hintDetailsHtml('说明', '<div>' + esc('宿主 Git 端点会在酒馆后端对远端仓库做 git 校验；宿主不支持时会报错。默认关闭，改用 GitHub 清单判定版本（无需 git）；确认宿主可 git 更新时再开启。') + '</div>'),
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="importV1Dry" title="读取旧版插件的数据并预演合并结果，不写入">📥 导入旧版数据（干跑）</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="importV1Apply" title="把旧版插件的数据按 id 合并写入">📥 导入旧版数据（写入）</button>'
        + '<span class="ftt-muted">源数据不删除；写入为按 id 合并</span></div>',
        // v2.36.0：面板宽度档位（V2 附加设定；V1 无此项 —— V1 固定 min(940px,94vw)）
        '<div class="ftt-row"><span class="ftt-muted">面板最大宽度</span>'
        + '<select class="ftt-input" data-ftt-v2="panelMaxWidth">'
        + PANEL_WIDTH_OPTIONS.map((o) => '<option value="' + attr(String(o.v)) + '"' + (Number(curWidth) === Number(o.v) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('')
        + '</select><span class="ftt-muted">手机端恒铺满；此值作用于桌面/平板（≥701px）的上限，实际宽度随窗口自适应</span></div>',
        '<div class="ftt-field ftt-field-col"><label>启用维度</label><div class="ftt-v2-dims" id="ftt_v2_dims">' + dimsCheckboxHtml() + '</div></div>',
    ].join('\n');
}

/**
 * 设定 → 提示词 页的「早期情节压缩」节（V1 同节：标题 + 摘要按钮；6 个配置控件仍由 `SETTINGS_CONTROLS.prompts`
 * 平铺渲染，V2 不重复出控件 —— 见 docs/P8w 适配差异）。
 * 按钮文案与 title 与 V1 逐字一致；`[data-ftt-compact-result]` 保留 V1 的落点（V2 结果同时写面板 note）。
 */
function atomCompactSectionHtml() {
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">早期情节压缩</div>',
        '<div class="ftt-muted">达阈值时自动压缩早期情节（保护最近 N 条）：同日 ≥2 条归并；不足则按月、再按年降级。</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="atomCompactNow" title="立即对早期情节执行一次半自动情节总结（聚合为情节总结，原文保留并隐藏）">🧷 立即聚合早期情节</button><span class="ftt-muted" data-ftt-compact-result></span></div>',
        '</div>',
    ].join('\n');
}

/** 分页内容 *//** 分页内容 *//** 分页内容 */
export function panelBodyHtml(tab) {
    const t = tab || ps.tab;
    try {
        if (t === 'overview') return overviewBody();
        if (t === 'settings') return settingsBody();
        if (t === 'plans') return dimBody('plans') + '<h4 class="ftt-h4-inline">悬念</h4>' + dimBody('suspense');
        if (t === 'states') return statesBody();
        const kind = TAB_DIM[t];
        if (kind) return dimBody(kind);
        return '<div class="ftt-empty">（该分页尚未实现）</div>';
    } catch (e) { return '<div class="ftt-empty">渲染失败：' + esc(String((e && e.message) || e)) + '</div>'; }
}

/**
 * `.ftt-modal` 的**内部** HTML（标题栏 + 标签条 + 各分页正文）。
 * v2.80.1（用户报告「每次点击按钮，插件页面会闪一下」）：
 *   重渲染只替换**模态内部**、复用既有 `.ftt-modal` 节点 —— 否则节点被重建会让入场动画
 *   `fttModalIn`（`style.css#ftt-panel .ftt-modal`）**每次点击重放**（220ms 淡入 + 下移 = 用户看到的「闪」）。
 *   `panelHtml()` 仍返回**完整**浮层 HTML（测试与外部接口口径不变）。
 */
export function panelModalInnerHtml() {
    const active = PANEL_TABS.some((x) => x[0] === ps.tab) ? ps.tab : 'overview';
    const nameTxt = (() => { try { return String(getScopeKey() || ''); } catch (e) { return ''; } })();
    const bp = (ps.busy && typeof hooks.batchProgress === 'function') ? (hooks.batchProgress() || {}) : null;
    const busyNote = ps.busy
        ? ('<span class="ftt-busy">' + (bp && bp.segTotal ? ('🔄 分析中 ' + bp.segDone + '/' + bp.segTotal + ' 段' + (bp.activeSeg ? ('（第 ' + bp.activeSeg.start + '-' + bp.activeSeg.end + ' 楼）') : '')) : '🔄 分析中…') + '</span>')
        : '';
    const head = '<div class="ftt-modal-head' + (ps.busy ? ' ftt-head-busy' : '') + '">'
        + '<span class="ftt-title">📖 FTT记忆组件 ' + esc(VERSION) + (nameTxt ? ' · ' + esc(nameTxt) : '') + '</span>'
        + busyNote
        + '<span class="ftt-stat" title="全部类目记忆条目之和">总记忆数 ' + totalMemory() + '</span>'
        + '<button class="ftt-close" data-ftt-action="close" title="关闭面板（Esc 同效）">✕</button></div>';
    const tabs = '<div class="ftt-tabs">' + PANEL_TABS.map(([t, l]) =>
        '<a href="javascript:void(0)" class="ftt-tab' + (t === active ? ' ftt-on' : '') + '" data-ftt-tab="' + attr(t) + '">' + esc(l) + '</a>').join('') + '</div>';
    const bodies = PANEL_TABS.map(([t]) => '<div class="ftt-body" data-ftt-body="' + attr(t) + '" style="' + (t === active ? '' : 'display:none') + '">' + panelBodyHtml(t) + '</div>').join('\n');
    return head + tabs + bodies;
}

/** 整个浮层 HTML（与 V1 同名同层级；V1 样式挂在 #ftt-panel 上） */
export function panelHtml() {
    return '<div class="ftt-modal">' + panelModalInnerHtml() + '</div>';
}

/** 找到（或创建）浮层元素：优先 body，退到任意扩展容器（桩 DOM 无 body 时也能工作） */
function ensureOverlay() {
    const doc = docEl();
    if (!doc) return null;
    let el = null;
    try { el = typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null; } catch (e) { el = null; }
    // 修复（v2.34.0）：宿主里**已存在**面板节点时（UI 被酒馆重渲染 / 二次打开 / 测试预注册），
    //   此前直接 return，**跳过了 bindOverlay()** → 面板点击委托从未绑定 → 所有按钮与子标签点击无效。
    //   bindOverlay 以 `el.__fttBound` 幂等，重复调用安全。
    if (el) { overlayEl = el; bindOverlay(); return el; }
    if (!doc.body) return null;
    try {
        if (typeof doc.body.insertAdjacentHTML === 'function') {
            doc.body.insertAdjacentHTML('beforeend', '<div id="' + PANEL_ID + '" class="ftt-open"></div>');
            el = typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null;
        }
    } catch (e) { el = null; }
    if (!el) {
        // 兜底：宿主不解析 HTML（无 DOM 树 / 无 getElementById 回查）时，用内存元素承接渲染，
        //   保证「打开面板」在任何宿主都成立；真实浏览器里 insertAdjacentHTML 后必能回查到节点，不会走这里。
        try {
            overlayEl = {
                id: PANEL_ID, html: '', synthetic: true,
                insertAdjacentHTML(pos, html) { this.html += String(html); },
                addEventListener() { /* 无 DOM 事件 */ },
                classList: { add() { }, remove() { } },
            };
            return overlayEl;
        } catch (e) { return null; }
    }
    overlayEl = el;
    applyPanelWidth(el);   // v2.36.0：新建浮层时即下发宽度上限（不等首次 renderPanel）
    bindOverlay();
    return el;
}

/**
 * v2.38.0：给内联按钮统一补 `type="button"`（**V1 的「点击跳顶」修复之一**，v1.206 26525）。
 * 原因：无 `type` 的 `<button>` 在 `<form>` 内默认是 `submit` → 触发提交（页面跳顶/刷新）。
 * 这里在**字符串层**先补一遍（不依赖 DOM 解析，桩宿主也生效），DOM 插入后再补一遍防守。
 */
export function ensureButtonTypes(html) {
    // 保留原标签大小写（`<BUTTON>` 不改成 `<button>`，只补属性）
    try { return String(html == null ? '' : html).replace(/<(button)(?![^>]*\stype=)/gi, '<$1 type="button"'); } catch (e) { return String(html == null ? '' : html); }
}

/** DOM 层兜底：把还没有 `type` 的按钮补成 `type="button"`（V1 `renderPanel` 的等价步骤） */
function hardenButtonTypes(el) {
    try {
        if (!el || typeof el.querySelectorAll !== 'function') return 0;
        const list = el.querySelectorAll('button');
        let n = 0;
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (b && typeof b.getAttribute === 'function' && !b.getAttribute('type') && typeof b.setAttribute === 'function') { b.setAttribute('type', 'button'); n += 1; }
        }
        return n;
    } catch (e) { return 0; }
}

/**
 * v2.38.0：重渲染前后**保持滚动位置**（对齐 V1 v1.206 26507~26536 的修复，用户报告「点击按钮突然置顶」）。
 * V1 的关键点（原注释里写明）：恢复对象必须是**当前活动标签的内容区**
 *   （`.ftt-body[data-ftt-body="<activeTab>"]`）——旧实现用 `querySelector('.ftt-body')` 恒取到第一个（总览），
 *   于是长列表页（计划/悬念等）删除条目后仍会跳回顶部。
 * V2 同构：滚动容器是 `.ftt-body`（`overflow-y:auto`），标签条 `.ftt-tabs` / 子标签条 `.ftt-subtabs` 横向滚动。
 */
export function panelScrollState(el) {
    const st = { p: 0, modal: 0, b: 0, tabs: 0, subs: 0, tab: String(ps.tab || 'overview') };
    try {
        const target = el || overlayEl;
        if (!target) return st;
        st.p = Number(target.scrollTop) || 0;
        const q = (sel) => (typeof target.querySelector === 'function' ? target.querySelector(sel) : null);
        const modal = q('.ftt-modal'); if (modal) st.modal = Number(modal.scrollTop) || 0;
        const tabs = q('.ftt-tabs'); if (tabs) st.tabs = Number(tabs.scrollLeft) || 0;
        const subs = q('.ftt-subtabs'); if (subs) st.subs = Number(subs.scrollLeft) || 0;
        const body = q('.ftt-body[data-ftt-body="' + st.tab + '"]') || q('.ftt-body');
        if (body) st.b = Number(body.scrollTop) || 0;
    } catch (e) { /* 无 DOM 的宿主：返回零值 */ }
    return st;
}

/** 把捕获到的滚动位置写回（仅在非 0 时写入，避免把未滚动的容器显式置 0） */
export function applyPanelScroll(el, st) {
    const s = st || {};
    try {
        const target = el || overlayEl;
        if (!target) return false;
        const q = (sel) => (typeof target.querySelector === 'function' ? target.querySelector(sel) : null);
        if (s.p) target.scrollTop = Number(s.p) || 0;
        const modal = q('.ftt-modal'); if (modal && s.modal) modal.scrollTop = Number(s.modal) || 0;
        const tabs = q('.ftt-tabs'); if (tabs && s.tabs) tabs.scrollLeft = Number(s.tabs) || 0;
        const subs = q('.ftt-subtabs'); if (subs && s.subs) subs.scrollLeft = Number(s.subs) || 0;
        const body = q('.ftt-body[data-ftt-body="' + String(s.tab || '') + '"]') || q('.ftt-body');
        if (body && s.b) body.scrollTop = Number(s.b) || 0;
        return true;
    } catch (e) { return false; }
}

/**
 * 取当前浮层里**已存在**的 `.ftt-modal` 节点（v2.80.1 修复「点击按钮闪一下」的关键）。
 * 判定严格：必须是元素、必须能写 `innerHTML`（桩 DOM 的伪节点不能写 → 回落整树替换）。
 * @returns {object|null}
 */
function existingModalNode(el) {
    try {
        if (!el || typeof el.querySelector !== 'function') return null;
        const node = el.querySelector('.ftt-modal');
        if (!node || typeof node !== 'object') return null;
        if (typeof node.innerHTML !== 'string') return null;
        return node;
    } catch (e) { return null; }
}

/** 布局落定后再补一次（字体/图片/异步内容改变高度时，同步恢复会被浏览器重置） */
function scheduleScrollRestore(el, st) {
    try {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === 'function') { raf(() => { applyPanelScroll(el, st); }); return true; }
    } catch (e) { /* 无 rAF 的宿主：只做同步恢复 */ }
    return false;
}

/** 渲染（真实 DOM 用 innerHTML 替换；桩 DOM 记录到 el.html） */
/**
 * v3.0.13：把「本次新增的平行事件」那一行滚入视野中心（与 `relJump` 同款 rAF + `scrollIntoView`，无 DOM 时静默跳过）。
 * 只做定位，不改任何数据；标记本身由 `ps.flash` 持有，渲染时给该行加 `data-ftt-flash-id`。
 */
function flashScrollIntoView(el) {
    try {
        const ids = (ps.flash && Array.isArray(ps.flash.ids)) ? ps.flash.ids : [];
        if (!ids.length) return;
        const target = String(ids[0]).replace(/"/g, '');
        const go = () => {
            try {
                const node = (el && typeof el.querySelector === 'function') ? el.querySelector('[data-ftt-flash-id="' + target + '"]') : null;
                if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
            } catch (e) { /* 忽略 */ }
        };
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === 'function') raf(go); else go();
    } catch (e) { /* 忽略 */ }
}

export function renderPanel() {
    const el = overlayEl || ensureOverlay();
    // v2.63.0：DOM 写完后启停「管线状态」读秒计时器（此刻那一行才真的存在；切页/关闭/空闲则停表）
    const finish = (html) => {
        try { syncPipelineTick(); } catch (e) { /* 计时器启停失败不影响渲染 */ }
        try { flashScrollIntoView(el); } catch (e) { /* 定位失败不影响渲染 */ }   // v3.0.13：把「本次新增」条目滚入视野
        return html;
    };
    // ① 重渲染**前**记录滚动位置（V1 同款；活动标签内容区，不是第一个 .ftt-body）
    const scroll = panelScrollState(el);
    // ② 字符串层补 `type="button"`（防止 form 内按钮提交导致跳顶）
    // 只渲染一次：模态内部 HTML 复用给两条路径（复用节点 / 整树替换），避免重复渲染 13 个分页
    const innerHtml = ensureButtonTypes(panelModalInnerHtml());
    const html = ensureButtonTypes(panelHtml());
    applyPanelWidth(el);
    if (!el) return html;
    // v2.80.1（用户报告「每次点击按钮，页面闪一下」）：**复用既有 `.ftt-modal` 节点**，
    //   只替换其内部 —— 节点不被重建，CSS 入场动画（`fttModalIn`）就不会每次点击重放。
    //   仅在「已有模态节点」时走该路径；首次打开 / 关闭后再打开 / 桩 DOM 一律回落整树替换，
    //   于是「打开面板的入场动画」仍然保留（这正是动效该出现的地方）。
    const modal = existingModalNode(el);
    if (modal) {
        try {
            modal.innerHTML = innerHtml;
            hardenButtonTypes(el);
            applyPanelScroll(el, scroll);      // ③ 渲染后同步恢复
            scheduleScrollRestore(el, scroll); // ④ 布局落定后再补一次
            return finish(html);
        } catch (e) { /* 落回整树替换 */ }
    }
    try {
        if (typeof el.innerHTML === 'string') {
            el.innerHTML = html;
            hardenButtonTypes(el);
            applyPanelScroll(el, scroll);      // ③ 渲染后同步恢复
            scheduleScrollRestore(el, scroll); // ④ 布局落定后再补一次
            return finish(html);
        }
    } catch (e) { /* 落到桩路径 */ }
    try { if (typeof el.insertAdjacentHTML === 'function') el.insertAdjacentHTML('beforeend', html); else el.html = html; } catch (e) { /* 忽略 */ }
    hardenButtonTypes(el);
    applyPanelScroll(el, scroll);
    scheduleScrollRestore(el, scroll);
    return finish(html);
}

/**
 * v2.36.0：把「面板最大宽度」档位下发给浮层元素（CSS 变量 `--ftt-panel-max-w`）。
 * 无 style/无 DOM 的宿主（桩、受限环境）静默跳过；读取失败回落默认档。
 * @param {object} [el] 浮层元素（缺省用当前浮层）
 * @returns {string} 实际下发的 CSS 变量值（诊断/测试用）
 */
export function applyPanelWidth(el) {
    const target = el || overlayEl || ensureOverlay();
    const px = (() => { try { return getSettings().panelMaxWidth; } catch (e) { return 1280; } })();
    const css = panelWidthCssValue(px);
    try {
        if (target && target.style && typeof target.style.setProperty === 'function') target.style.setProperty('--ftt-panel-max-w', css);
    } catch (e) { /* 无 style 的宿主：忽略 */ }
    return css;
}

/** 打开浮层（V1 的主入口行为） */
export function openPanel(tab) {
    const t = PANEL_TABS.some((x) => x[0] === tab) ? tab : (PANEL_TABS.some((x) => x[0] === cfg.uiFirstTab) ? cfg.uiFirstTab : 'overview');
    ps.tab = t;
    ps.open = true;
    try { traceEvent({ cat: 'ui', kind: 'panel-open', level: 'info', detail: { tab: ps.tab, via: 'openPanel' }, site: traceSite() }); } catch (e2) { /* 忽略 */ }
    ps.opened += 1;
    const el = ensureOverlay();
    if (!el) return { ok: false, reason: '无法创建浮层（无 body 且无扩展容器）', tab: t };
    try { el.classList && el.classList.add && el.classList.add('ftt-open'); } catch (e) { /* 忽略 */ }
    try { bindEscClose(); } catch (e) { /* 忽略 */ }
    renderPanel();
    return { ok: true, via: 'overlay', tab: t, tabs: PANEL_TABS.map((x) => x[0]) };
}

/** 关闭浮层 */
export function closePanel() {
    ps.open = false;
    stopPipelineTick();   // v2.63.0：面板关闭即停读秒计时器（不泄漏定时器）
    try { traceEvent({ cat: 'ui', kind: 'panel-close', level: 'info', detail: { tab: ps.tab }, site: traceSite() }); } catch (e2) { /* 忽略 */ }
    const el = overlayEl;
    if (!el) return true;
    try { if (el.classList && el.classList.remove) el.classList.remove('ftt-open'); } catch (e) { /* 忽略 */ }
    try { if (typeof el.innerHTML === 'string') el.innerHTML = ''; } catch (e) { /* 忽略 */ }
    return true;
}
export function panelOpen() { return ps.open; }

function setNote(text) { ps.note = String(text == null ? '' : text); return ps.note; }

/**
 * 确认框（V1 `D.confirm(...)` 的 V2 等价）：
 *   ① 优先用宿主注入的 `hooks.confirm(text, title)`（测试/宿主可替换）；
 *   ② 否则用浏览器原生 `globalThis.confirm`；
 *   ③ **都没有 → 返回 false（取消）** —— 与 V1「`D.confirm` 不是函数时 `ok=false` 直接 break」同口径，
 *      保证「转正需确认」在无对话框环境下不会被绕过。
 */
/**
 * v2.94.0（`docs/D9-UI统一规范设计稿.md` **U4** / 检查项 **C7**）——**危险动作二次确认清单**（固定，逐条对应 U4）：
 *   删除条目 / 清空（日志 · 本地缓冲 · 过滤词条库）/ 导入覆盖 / 恢复快照 / 清空注入。
 * 键 = `data-ftt-action`，值 = 确认文案（讲清「删什么 + 能不能恢复 + 有无备份」）。
 * 只作用于**用户真实点击**路径（见点击委托的最前面那道闸）；取消 → 直接 return，零副作用。
 */
const DANGER_ACTION_PROMPTS = {
    'delete': '删除这一条记忆？\n\n删除会留下记录，跨端同步时不会把它复活；但本机该条内容将不再注入。此操作不可撤销，建议先「⬇ 导出 JSON 文件」备份。',
    'bulkDelete': '删除勾选的全部记忆条目？\n\n删除会留下记录（跨端不复活），但本机这些内容将不再注入。此操作不可撤销，建议先备份。',
    'dbgClear': '清空调试日志？\n\n只清除本机的调试与交互日志，**不影响任何记忆数据**。',
    'dbgTraceClear': '清空交互与宿主调用时间线？\n\n只清除本机的追踪记录，**不影响任何记忆数据**。',
    'syncLogClear': '清空同步日志？\n\n只清除本角色的对账 / 同步记录（含服务端那份），**不影响记忆数据**。',
    'nsfwKwReset': '清空 NSFW 词条库？\n\n将恢复为内置默认词条，你自行添加的词条会全部丢失。此操作不可撤销。',
    'importStateApply': '导入并合并这份存档？\n\n合并规则：相同跳过、新条目插入、变更以文件为准，**不会删除**本地已有记忆。',
    'snapRestore': '恢复到这个快照？\n\n当前记忆会被快照内容替换（快照之后的新增与修改将丢失）。恢复前建议先「⬇ 导出 JSON 文件」备份。',
    'clearPlotSegments': '清空全部分段总结？\n\n分段总结只归档、不注入，清空后无法找回。此操作不可撤销。',
    // ── v2.99.0（用户要求「传言的清理按钮需二次确认，其他类似高危操作均需二次确认」）──
    //   下列动作此前**没有任何确认**（部分 title 甚至写着「不弹确认」，沿袭 V1）；它们都会**不可逆地清空/覆盖用户数据**。
    'clearRumors': '清空全部传言？\n\n所有传言（含传播者 / 载体 / 裂变谱系）将被删除并留下删除墓碑（跨端同步时不会复活）。此操作不可撤销，建议先「⬇ 导出 JSON 文件」备份。',
    'clearPlans': '清空全部计划？\n\n所有计划（含进度 / 步骤 / 阻碍 / 历史）将被删除并留下删除墓碑。此操作不可撤销，建议先备份。',
    'clearSuspense': '清空全部悬念？\n\n所有悬念（含线索 / 揭晓条件 / 历史）将被删除并留下删除墓碑。此操作不可撤销，建议先备份。',
    'delStateGroup': '删除该角色的全部状态记录？\n\n该角色下的所有状态字段都会被删除并留下墓碑。此操作不可撤销。',
    'snapshotClear': '清空全部快照？\n\n快照链是自动备份，清空后**无法再回滚到任何历史时刻**（记忆本体不受影响）。此操作不可撤销。',
    'snapDelete': '删除这个快照？\n\n删除后无法再用它回滚（记忆本体不受影响）。此操作不可撤销。',
    'nsfwRuleReset': '恢复内置默认转化库？\n\n你自定义的固定规则**全部丢失**，只保留内置标准库。此操作不可撤销。',
    'promptResetAll': '全部恢复默认提示词？\n\n你对**所有**提示词模板的修改都会丢失。此操作不可撤销。',
    'promptGroupReset': '本组恢复默认提示词？\n\n你对**本组**提示词模板的修改都会丢失。此操作不可撤销。',
    'promptResetOne': '恢复这条提示词的默认内容？\n\n你对这条模板的修改会丢失。此操作不可撤销。',
    'presetDelete': '删除选中的 API 分组？\n\n该分组（连接配置 / 地址 / Key / 模型 / 参数）会被删除，引用它的维度将回落到主配置。此操作不可撤销。',
    'syncPickLocal': '用**本端**版本覆盖对端？\n\n两端分歧将按本端内容强行统一，**对端的差异会被丢弃**。此操作不可撤销，建议先备份。',
    'syncPickRemote': '用**对端**版本覆盖本端？\n\n本端当前记忆会被对端内容替换，**本端的差异会被丢弃**。此操作不可撤销，建议先备份。',
    'clear-inject': '清空当前注入内容？\n\n只清除这次注入给 AI 的正文，**不影响任何记忆数据**（下次提取会重新生成）。',
    'clearFloors': '清除「已处理楼层」记录？\n\n只重置「哪些楼层已摘要」，**记忆条目一条不删**；之后可能重复摘要已处理过的楼层。',
};

async function confirmDialog(text, title) {
    // v2.41.0：**异步安全** —— 宿主确认框可能是 Promise（酒馆 `callGenericPopup`、或把 `window.confirm` 桥接到
    //   宿主命令的实现）。此前 `!!hooks.confirm(...)` 把 **Promise 当"已确认"**（恒为真），且宿主拒绝时会变成
    //   **未处理的 Promise 拒绝**（用户报告：`Command plugin:dialog|confirm not allowed by ACL`）。
    //   现在：await 宿主返回值；抛错/拒绝 → 按「取消」；返回 thenable 的分支一律不采信并吞掉拒绝。
    try {
        if (typeof hooks.confirm === 'function') {
            const r = await hooks.confirm(String(text || ''), String(title || ''));
            if (r && typeof r.then === 'function') { try { r.then(() => { }, () => { }); } catch (e) { /* 忽略 */ } return false; }
            return !!r;
        }
        const w = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (!w || typeof w.confirm !== 'function') return false;
        const r = w.confirm(String(text || ''));
        if (r && typeof r.then === 'function') { try { r.then(() => { }, () => { }); } catch (e) { /* 忽略 */ } return false; }
        return !!r;
    } catch (e) { return false; }
}

/**
 * 面板动作（唯一入口；真实 DOM 与测试共用）。
 * action: tab | close | search | edit | edit-cancel | save | delete | refresh | summary | extractNow | inject
 *         | summaryFloor | clear-inject | check-update
 */
export async function panelAction(action, payload) {
    const p = payload || {};
    // v2.42.0：每次面板动作开一个 **op**（关联 id）—— 该 op 执行期间的宿主/内核/AI 事件都会自动带上它，
    //   于是「用户点了什么 → 触发了哪些底层调用 → 结果如何」可用 opId 串起来；错误同样带 opId + 站点。
    const traceOp = traceOpStart('ui.' + String(action || ''), {
        tab: ps.tab, sub: ps.settingsSub, kind: p.kind, id: p.id,
    });
    const traceT0 = Date.now();
    const a = String(action || '');
    let result = { ok: true, action: a };
    // v2.96.0：所有返回路径（含前置条件早退）都经统一收尾 → 界面一定被重绘、提示一定可见
    const done = (extra) => finalizePanelAction(Object.assign(result, extra || {}), traceOp, traceT0, a, p);
    try {
        if (a === 'tab') { ps.tab = String(p.tab || 'overview'); ps.editing = null; ps.peek = ''; ps.flash = null; }   // v3.0.13：切页清「本次新增」标记   // v2.63.0：读秒计时器随本次动作末尾的重绘启停（见 renderPanel）
        else if (a === 'close') { closePanel(); }
        else if (a === 'search') { ps.q[String(p.kind || '')] = String(p.q == null ? '' : p.q); }
        else if (a === 'edit' || a === 'editEntry') { ps.editing = { kind: String(p.kind || ''), id: String(p.id || ''), preset: p.preset || null }; }
        else if (a === 'edit-cancel' || a === 'editCancel' || a === 'closeEntry' || a === 'cancelEntry') { ps.editing = null; }
        else if (a === 'add' || a === 'addEntry') { ps.editing = { kind: String(p.kind || ps.tab), id: '', preset: p.preset || null }; }
        else if (a === 'addStateFor') { ps.editing = { kind: 'states', id: '', preset: { subject: String(p.subject || '') } }; }
        else if (a === 'addChildScene') {
            const parent = String(p.id || '');
            ps.editing = { kind: 'scenes', id: '', preset: { parentSceneId: parent } };
        }
        else if (a === 'multiToggle') { const k = String(p.kind || ps.tab); ps.multi[k] = !(ps.multi[k] === true); }
        else if (a === 'listFilter') {
            // v2.62.0：列表筛选条（V1 `data-ftt-filter` + `data-ftt-filter-key`）——字段范围 / 排序 / 额外条件
            const k = String(p.kind || ps.tab);
            const key = String(p.key || '');
            const val = String(p.value == null ? '' : p.value);
            if (['field', 'sort', 'extra'].indexOf(key) >= 0) {
                const cur = listFilterOf(k);
                cur[key] = val;
                ps.f[k] = cur;
                setNote('筛选：' + k + ' ' + key + ' = ' + val);
            }
        }
        else if (a === 'selectAll') { const k = String(p.kind || ps.tab); const set = selOf(k); listOf(k, ps.q[k], 300).forEach((x) => set.add(String(x.id || ''))); }
        else if (a === 'selectNone') { selOf(String(p.kind || ps.tab)).clear(); }
        else if (a === 'bulkDelete') {
            const k = String(p.kind || ps.tab);
            const set = selOf(k);
            const ids = Array.from(set);
            let n = 0;
            for (const id of ids) { try { if (consoleDelete(dataKindOf(k), id).ok) n++; } catch (e2) { /* 单条失败不影响其余 */ } }
            set.clear();
            setNote('已删除 ' + n + ' 条（多选批量删除 · 含跨端墓碑）');
            result = Object.assign(result, { ok: true, deleted: n });
        }
        else if (a === 'searchClear') { const k = String(p.searchKind || p.kind || ps.tab); ps.q[k] = ''; selOf(k).clear(); delete (ps.f || {})[k]; }   // v2.62.0：与 V1 同义（清除搜索与筛选）
        else if (a === 'atomToggleHidden') { ps.showHidden = !ps.showHidden; }
        else if (a === 'atomPeek') { const id = String(p.id || ''); ps.peek = (ps.peek === id) ? '' : id; }
        else if (a === 'atomPeekClose') { ps.peek = ''; }
        else if (a === 'delStateGroup') {
            const subj = String(p.subject || '');
            const before = (state.currentStates || []).length;
            const gone = (state.currentStates || []).filter((x) => String(x && x.subject || '') === subj);
            for (const g of gone) { try { consoleDelete('currentStates', String(g.id || '')); } catch (e2) { /* 忽略 */ } }
            setNote('已删除「' + subj + '」的 ' + (before - (state.currentStates || []).length) + ' 条状态');
        }
        else if (a === 'save') {
            const kind = String(p.kind || '');
            const id = String(p.id || '');
            const fields = p.fields || {};
            // V1 口径：表单 → deconstructEntry → 入库 raw（数组/分组/父级路径/文本行解析都在此处）
            let raw = fields;
            try { raw = deconstructEntry(kind, Object.assign({}, fields, id ? { id } : {})); } catch (e) { raw = fields; }
            const r = consoleSave(dataKindOf(kind), id, raw);
            setNote(r.ok ? ('已保存 ' + (id || '（新增）')) : ('保存失败：' + String(r.reason || '')));
            result = Object.assign(result, r);
            ps.editing = null;
        } else if (a === 'delete') {
            const r = consoleDelete(dataKindOf(String(p.kind || '')), String(p.id || ''));
            setNote(r.ok ? '已删除 ' + String(p.id || '') + '（已留墓碑）' : '删除失败');
            result = Object.assign(result, r);
        } else if (a === 'atomSub') { setAtomSub(p.sub); }
        else if (a === 'atomCompactNow') {
            // V1「🧷 立即聚合早期情节」（设定 → 提示词 页）：force 忽略体量阈值立即执行一次半自动情节总结；
            //   V1 把结果写进 `[data-ftt-compact-result]` 元素，V2 统一写面板 note（读 `r.state.note`）。
            const cr = await runAtomCompact({ force: true });
            const msg = cr && cr.ok
                ? (cr.skipped ? ('（' + cr.skipped + (cr.totalChars != null ? '，体量 ' + cr.totalChars + ' < 阈值 ' + cr.threshold : '') + '）')
                    : (' 聚合 ' + Number(cr.summarized || 0) + ' 条总结 · 覆盖 ' + Number(cr.hidden || 0) + ' 条原情节（参与运作 ' + Number(cr.before || 0) + ' → ' + Number(cr.after || 0) + '，目标 ≤ ' + Number(cr.target || 0) + '；原文保留并隐藏）'))
                : ('失败：' + String((cr && cr.error) || '未知'));
            setNote(msg);
            result = Object.assign(result, { ok: !!(cr && cr.ok), action: a, atomCompact: cr, made: Number((cr && cr.summarized) || 0) });
        }
        else if (a === 'atomMergeSummary') {
            // V1「🧷 情节总结（N）」（情节页多选）：把勾选情节交 AI 合并成**一条**情节（标题标记「【A~B 总结】」），
            //   原情节**保留并隐藏**（不参与注入 / 淘汰等任何自动动作，除非人工删除）
            const ids = Array.from(selOf('atoms'));
            if (!ids.length) {
                setNote('情节总结：未选中情节（请先在「📜 情节列表」切到多选模式并勾选要合并的情节）');
                result = Object.assign(result, { ok: false, reason: 'no-selection' });
            } else {
                const r = await runAtomMergeSummary(ids);
                setNote(r.made
                    ? ('情节总结：新增 1 条情节总结「' + String(r.label || '') + '」· 覆盖 ' + Number(r.merged || 0) + ' 条原情节（原文保留并隐藏，不参与注入与淘汰）')
                    : (r.blocked ? '情节总结：已跳过（任务占用中）' : (r.error ? ('情节总结失败：' + String(r.error)) : ('情节总结：未落库（' + String(r.reason || '无可用情节') + '）'))));
                selOf('atoms').clear();
                result = Object.assign(result, { ok: Number(r.made || 0) > 0, action: a, atomMerge: r, made: Number(r.made || 0) });
            }
        }
        else if (a === 'plotSegmentSummarySel') {
            // V1「🧩 分段总结（N）」（情节页多选）：只把勾选情节按剧情时间打包交 AI 分段，归档到「🧩 分段总结」子页
            const ids = Array.from(selOf('atoms'));
            if (!ids.length) {
                setNote('分段总结：未选中情节（请先在「📜 情节列表」切到多选模式并勾选要总结的情节）');
                result = Object.assign(result, { ok: false, reason: 'no-selection' });
            } else {
                const r = await runPlotSegmentSummarySelected(ids);
                const parts = ['新增 ' + Number(r.added || 0) + ' 段'];
                if (r.dup) parts.push('跳过同时间范围已存在 ' + Number(r.dup) + ' 段');
                if (r.empty) parts.push('忽略空段 ' + Number(r.empty));
                parts.push('当前共 ' + Number((state.plotSegments || []).length) + ' 段');
                setNote(r.blocked ? '分段总结（所选）：已跳过（任务占用中）' : (r.error ? ('分段总结（所选）失败：' + String(r.error)) : ('分段总结（所选）：' + parts.join(' · '))));
                selOf('atoms').clear();
                setAtomSub('segments');
                result = Object.assign(result, { ok: Number(r.made || 0) > 0, action: a, plotSegment: r, made: Number(r.made || 0) });
            }
        }
        else if (a === 'clearPlotSegments') {
            // V1「🧹 清理分段」（分段总结子页）：清空全部分段总结（不弹确认；留 id + 内容哈希墓碑）
            const n = clearPlotSegments();
            setNote(n ? ('已清理 ' + n + ' 段分段总结') : '当前没有分段总结');
            result = Object.assign(result, { ok: true, action: a, cleared: n });
        }
        // ==================== B8-7-b：平行事件（推演 / 推进 / 转正，V1 同名动作） ====================
        else if (a === 'parallelAdvance') {
            // V1 `case 'parallelAdvance'`（单条推进）：`runParallelAdvance({ids:[id]})` → 按分支如实提示
            const id = String(p.id || '');
            const r = await runParallelAdvance({ ids: id ? [id] : [] });
            let msg;
            if (r && r.error) msg = '❌ 推进失败:' + String(r.error).slice(0, 80);
            else if (r && r.skipped === 'busy') msg = '⏳ 摘要/情节总结/推演/修复进行中，请稍候再推进';
            else if (r && r.skipped === 'none-active') msg = '⏳ 该事件已达衰退阈值待清理，无法推进';
            else if (r && r.skipped === 'no-targets') msg = '⏳ 没有可推进的平行事件';
            else msg = '🚀 平行事件推进完成：更新 ' + Number(r.updated || 0) + '/' + Number(r.target || 0) + ' 条 · AI 调用 ' + Number(r.aiCalls || 0) + ' 次 · 发送 ' + Number(r.sentChars || 0) + ' 字 · 用时 ' + Number(r.ms || 0) + 'ms';
            setNote(msg);
            result = Object.assign(result, { ok: !(r && r.error), action: a, parallelAdvance: r });
        }
        else if (a === 'parallelAdvanceAll') {
            // V1 `case 'parallelAdvanceAll'`（全部推进）：`runParallelAdvance({all:true})`
            const r = await runParallelAdvance({ all: true });
            let msg;
            if (r && r.error) msg = '❌ 全部推进失败:' + String(r.error).slice(0, 80);
            else if (r && r.skipped === 'busy') msg = '⏳ 摘要/情节总结/推演/修复进行中，请稍候再推进';
            else if (r && r.skipped === 'none-active') msg = '⏳ 当前无活动平行事件可推进';
            else if (r && r.skipped === 'no-targets') msg = '⏳ 当前没有平行事件';
            else msg = '🚀 平行事件推进完成：更新 ' + Number(r.updated || 0) + '/' + Number(r.target || 0) + ' 条 · AI 调用 ' + Number(r.aiCalls || 0) + ' 次 · 发送 ' + Number(r.sentChars || 0) + ' 字 · 用时 ' + Number(r.ms || 0) + 'ms';
            setNote(msg);
            result = Object.assign(result, { ok: !(r && r.error), action: a, parallelAdvance: r });
        }
        else if (a === 'parallelCustomOpen') {
            customWeaveOpen = true;
            setNote('自定义推演：写下设想后点「🚀 交由 AI 推演」');
        }
        else if (a === 'parallelCustomCancel') {
            customWeaveOpen = false;
            setNote('已取消自定义推演');
        }
        else if (a === 'parallelCustomRun') {
            // v2.99.0（用户要求）：输入一段话 → AI **单独**平行推演 → 落库为**普通平行事件**（同一条 mergeDelta 路径）。
            //   即时反馈与防连点同单楼分析（v2.96.0）：立刻写提示 + 重绘 + 通知 + 在途禁用。
            const ta = (() => {
                if (p.text !== undefined) return String(p.text);
                try { const doc = globalThis.document; const el = doc && doc.querySelector ? doc.querySelector('[data-ftt-custom-weave]') : null; return el ? String(el.value == null ? '' : el.value) : ''; } catch (e) { return ''; }
            })();
            const idea = String(ta || '').trim();
            if (idea.length < 4) {
                setNote('自定义推演：请先写下要推演的内容（至少 4 个字）');
                result = Object.assign(result, { ok: false, action: a, reason: 'idea-too-short' });
            } else if (customWeaveBusy) {
                setNote('自定义推演正在进行中，请等本次 AI 返回后再试');
                result = Object.assign(result, { ok: false, action: a, reason: 'busy' });
            } else {
                customWeaveBusy = true;
                setNote('自定义推演中…（AI 正在按你的设想推演，结果会作为一条普通平行事件落库）');
                renderPanel();                                    // 立刻可见（不等 AI）
                try { panelNotify('info', '自定义推演：开始推演…'); } catch (e) { /* 忽略 */ }
                let r = null;
                try {
                    r = (typeof hooks.parallelCustom === 'function')
                        ? await hooks.parallelCustom(idea)
                        : await runParallelCustom(idea, {});
                } finally {
                    customWeaveBusy = false;
                    customWeaveOpen = true;                           // 保留输入区，便于连续追加设想
                }
                const err = String((r && r.error) || '');
                if (r && r.ok && r.skipped === 'empty') {
                    setNote('自定义推演：这段设想没有可推演的点（未新增平行事件）');
                    try { panelNotify('warning', '自定义推演：没有可推演的点'); } catch (e) { /* 忽略 */ }
                } else if (r && r.ok) {
                    // v3.0.13（用户报告「没有正确新增平行条目」）：① 提示改用**真实落库结果**（r.added/updated/dup 由 state 前后差异算出）；
                    //   ② 无新增无更新时按 warning 如实说明；③ 新增的条目记进 `ps.flash` → 列表行带「🆕 本次新增」并自动滚入视野。
                    const addedN = Number(r.added || 0), updN = Number(r.updated || 0), dupN = Number(r.dup || 0);
                    const ids = Array.isArray(r.newIds) ? r.newIds.slice() : [];
                    if (ids.length) ps.flash = { ids: ids, at: Date.now() };
                    setNote('自定义推演完成：新增 ' + addedN + ' / 更新 ' + updN
                        + (dupN ? '（' + dupN + ' 条与既有内容一致，未重复新增）' : '')
                        + '（平行事件共 ' + Number((state.parallels || []).length) + ' 条 · 关联数据 ' + Number(r.seed || 0) + ' 条）');
                    try {
                        if (addedN || updN) panelNotify('success', '自定义推演完成：新增 ' + addedN + ' / 更新 ' + updN + ' 条平行事件'
                            + (ids.length ? '（已在列表中标记「🆕 本次新增」）' : ''));
                        else panelNotify('warning', '自定义推演完成：本次没有产生新的平行条目'
                            + (dupN ? '（' + dupN + ' 条与既有内容一致）' : ''));
                    } catch (e) { /* 忽略 */ }
                } else {
                    const why = { 'busy': '摘要 / 情节总结 / 推演 / 修复进行中，请稍候再试', 'idea-too-short': '内容太短（至少 4 个字）' }[err] || err || '未知';
                    setNote('自定义推演未完成：' + why);
                    try { panelNotify('warning', '自定义推演未完成：' + why); } catch (e) { /* 忽略 */ }
                }
                result = Object.assign(result, r || { ok: false }, { action: a });
            }
        }
        else if (a === 'parallelWeaveNow') {
            // V1 `case 'parallelWeaveNow'`：**先判 `cfg.parallelWeaveEnabled`**（V1 原样：缺失即视为未开启）
            if (!cfg.parallelWeaveEnabled) {
                setNote('🧭 推演世界未开启（设置→提取记忆→推演世界）');
                result = Object.assign(result, { ok: false, action: a, reason: 'disabled' });
            } else {
                const lastId = getLastMessageId();
                const feedN = Math.max(1, Number(cfg.feedFloors) || Number(cfg.summaryFloors) || 10);
                const fr = { start: Math.max(0, lastId - feedN + 1), end: lastId };
                const kws = parallelLastKeywords().slice(0, 10);
                const r = await runParallelWeave(fr, { keywords: kws, force: true });
                if (r && r.error === 'busy') setNote('⏳ 摘要/情节总结/推演/推进/修复进行中，请稍候');
                else if (r && r.error) setNote('❌ 推演世界失败:' + String(r.error).slice(0, 60));
                else if (r && r.skipped === 'dedup') setNote('推演世界：已跳过重复分析（楼层正文与原子未变化）');
                else if (r && r.skipped === 'empty') setNote('推演世界完成：无新增/更新点（平行事件共 ' + Number((state.parallels || []).length) + ' 条）');
                else setNote('推演世界完成：新增 ' + Number(r.added || 0) + ' / 更新 ' + Number(r.updated || 0) + '（平行事件共 ' + Number((state.parallels || []).length) + ' 条）');
                result = Object.assign(result, { ok: !(r && r.error), action: a, weave: r });
            }
        }
        else if (a === 'promoteParallel') {
            // V1 `case 'promoteParallel'`：转正需确认（`cfg.parallelPromoteConfirm !== false`）→ 再调核心
            const id = String(p.id || '');
            const ev = ((state.parallels) || []).find((x) => x && String(x.id) === String(id));
            let pr = null, msg;
            if (!ev) { msg = '未找到该平行事件'; }
            else if (ev.promotedTo) { msg = '该平行事件已转正'; }
            else {
                let go = true;
                if (cfg.parallelPromoteConfirm !== false) {
                    go = await confirmDialog(`把「${String(ev.title || ev.text || '').slice(0, 30)}」转正为情节？\n\n转正 = 确认为<b>已发生事实</b>：会生成/更新一条情节（走正常注入与知情约束），并在情节落库后<b>自动移除该平行世界记录</b>（留删除墓碑，跨端不会复活）。`, 'FTT 平行事件转正');
                }
                if (!go) { msg = '已取消转正（未生成情节）'; }
                else {
                    pr = promoteParallelEvent(id);
                    msg = (pr && pr.ok)
                        ? ('已转正为情节 已生成' + (pr.updated ? '/更新' : '') + '情节（id ' + String(pr.atomId || '').slice(0, 18) + '）；已' + (pr.removed ? '自动移除' : '标记') + '该平行世界记录（留删除墓碑，跨端不会复活），情节可在「情节」页查看。')
                        : ('转正失败 ' + String((pr && pr.reason) || '未知原因'));
                }
            }
            setNote(msg);
            result = Object.assign(result, { ok: !!(pr && pr.ok), action: a, promote: pr });
        }
        else if (a === 'summary') {
            // V1 `case 'summary'` 的 `data-ftt-summary="plotSegments"` 分流：分段总结（与「⚡ 立即 AI 摘要」共用动作名）
            if (String(p.summary || '') === 'plotSegments') {
                const r = await runPlotSegmentSummary({});
                const parts = ['新增 ' + Number(r.added || 0) + ' 段'];
                if (r.dup) parts.push('跳过已存在 ' + Number(r.dup) + ' 段');
                if (r.empty) parts.push('忽略空段 ' + Number(r.empty));
                parts.push('当前共 ' + Number((state.plotSegments || []).length) + ' 段');
                setNote(r.skipped ? ('分段总结：' + String(r.total ? '已是最新（' + r.total + ' 条情节已被现有段落覆盖）' : '暂无可整理情节'))
                    : (r.blocked ? '分段总结：已跳过（任务占用中）' : (r.error ? ('分段总结失败：' + String(r.error)) : ('分段总结：' + parts.join(' · ')))));
                setAtomSub('segments');
                result = Object.assign(result, { ok: !!(r && !r.error), action: a, plotSegment: r, made: Number(r.made || 0) });
                renderPanel();
                return Object.assign(result, { html: panelHtml(), state: panelState() });
            }
            // V1「⚡ 立即 AI 摘要」：分段批量（cfg.summaryChunkSize 楼/段）
            // v3.0.2（用户要求：「立即 AI 摘要是分析记忆动作，应该与点击单个未分析楼层**联动**做提示」）：
            //   两个入口是**同一条分析管线**（都走 `genTracked` → `core/pipeline.js`），因此提示、通知、
            //   管线行、按钮禁用态**全部联动**：
            //     ① 点下去**同帧**写提示（含待分析楼层数）+ 立即重绘（「⚡ 立即 AI 摘要」转圈禁用、楼按钮整体禁用）；
            //     ② 弹「开始分析」通知；完成后弹结果通知（与单楼分析同一套 `hooks.notify` 通道）；
            //     ③ 管线块里**批次本身占一行**（v3.0.2 修复「点了没有管线提示」——旧实现只渲染 AI 调用行，
            //        两次调用之间（段切分 / 落库 / 校正）整块消失）。
            if (typeof hooks.autoSummary !== 'function') { setNote('批量摘要入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            if (batchBusyNow()) { setNote('AI 摘要已在分析中（分段批量摘要进行中），请等本次完成'); return done({ ok: false, reason: 'busy' }); }
            if (singleFloorBusy.size) {
                setNote('正在分析第 ' + Array.from(singleFloorBusy).sort((a, b) => a - b).join('、') + ' 楼（同一条分析管线）—— 等本次完成后再批量摘要');
                return done({ ok: false, reason: 'busy', floors: Array.from(singleFloorBusy) });
            }
            const pendN = (() => { try { return (typeof hooks.pending === 'function') ? (hooks.pending({}) || []).length : 0; } catch (e) { return 0; } })();
            setNote('AI 摘要分析中…（' + (pendN ? (pendN + ' 个未摘要楼层 · ') : '') + '分段批量摘要，与「第 N 楼」同一条分析管线）');
            ps.busy = true;                                  // 兼容旧文本口径（真实忙位由 extractBusy 给出）
            renderPanel();                                   // ① 立刻可见（按钮转圈 + 两个入口禁用 + 管线行出现）
            try { panelNotify('info', 'AI 摘要：开始分析' + (pendN ? (' ' + pendN + ' 个未摘要楼层') : '未摘要楼层') + '…'); } catch (e) { /* 忽略 */ }
            const r = await hooks.autoSummary({ silent: false });
            ps.busy = false;
            const okAll = !!(r && r.ok);
            setNote(okAll
                ? ('摘要完成：' + r.segments + ' 段 · 读取楼层 ' + r.floors + ' · 新增 ' + r.added + ' 条' + (r.aborted ? '（中断：剩余 ' + r.aborted + ' 段未分析）' : ''))
                : ('未完成：' + String((r && r.reason) || '未知') + (r && r.failed ? '（失败 ' + r.failed + ' 段）' : '')));
            try {
                panelNotify(okAll ? 'success' : 'warning', okAll
                    ? ('AI 摘要完成：' + Number(r.segments || 0) + ' 段 · 新增 ' + Number(r.added || 0) + ' 条' + (r.aborted ? ('（已中断：剩 ' + r.aborted + ' 段）') : ''))
                    : ('AI 摘要未完成：' + String((r && r.reason) || '未知')));
            } catch (e) { /* 忽略 */ }
        } else if (a === 'extractNow') {
            // v2.74.0（用户要求）：「提取记忆」= **发送前召回**（向量 → JS 抽取 → AI 分析，前两层零 AI 为主）——
            //   **不占分析管道**、可与摘要等长任务并行；结果按开关（`提取记忆`页各层 + 注入开关）写入提示词注入。
            //   `hooks.recall` 未接线时回落到旧的 AI 摘要入口（`hooks.extract`），保证任何宿主形态都可用。
            if (typeof hooks.recall === 'function') {
                setNote('召回中…（向量 / JS 为主，不占用分析管道）');
                const r = await hooks.recall({});
                const layerLabel = { vector: '向量层', js: 'JS 抽取层', ai: 'AI 分析层' }[String((r && r.hitLayer) || '')] || '';
                setNote(r && r.ok
                    ? ('召回完成：' + Number((r && r.count) || 0) + ' 条' + (layerLabel ? '（' + layerLabel + '）' : '')
                        + ' · 注入 ' + Number((r && r.chars) || 0) + ' 字 · ' + Number((r && r.ms) || 0) + 'ms'
                        + (r && r.busy ? '（与在途长任务并行）' : ''))
                    : ('召回未完成：' + String((r && r.reason) || '未知')));
            } else if (typeof hooks.extract === 'function') {
                setNote('分析中…');
                const r = await hooks.extract({});
                setNote(r && Array.isArray(r.results)
                    ? ('分析完成：成功 ' + r.done + ' / ' + r.results.length + (r.note ? '（' + r.note + '）' : ''))
                    : (r && r.ok ? ('新增 ' + r.added + ' 条（共 ' + r.total + '）') : ('未完成：' + String((r && r.reason) || '未知'))));
            } else {
                setNote('提取入口未就绪');
                return done({ ok: false, reason: 'no-hook' });
            }
        } else if (a === 'abortAnalysis' || a === 'abort') {
            const r = (typeof hooks.abort === 'function') ? hooks.abort() : { ok: false };
            setNote(r && r.busy ? '已请求中断：当前段完成后停止' : '当前没有正在运行的分析任务');
        } else if (a === 'clearFloors') {
            const r = (typeof hooks.clearFloors === 'function') ? hooks.clearFloors() : { ok: false };
            setNote(r && r.ok ? ('已清空已处理楼层记录（' + (r.cleared || 0) + ' 个）') : '清空失败');
        } else if (a === 'reset') {
            // V1 `case 'reset'`（数据管理页「🗑 清空当前角色记忆」）：确认文案**逐字一致**
            //   （V1 原文：`confirm('确认清空当前角色的 FTT 记忆？此操作不可恢复，建议先导出备份。')` → `resetState()` → `toast('已清空','info')`）。
            //   V1 用浏览器原生 `confirm`（无标题）；V2 走 `confirmDialog`（宿主 hooks.confirm → 原生 confirm → 无对话框时取消，同 V1 的
            //   「无对话框不执行」口径）；清空能力由**适配层** `adapters/store.js#resetState` 提供（UI 只调用），并可经 `hooks.resetState` 替换。
            const go = await confirmDialog('确认清空当前角色的 FTT 记忆？此操作不可恢复，建议先导出备份。', 'FTT 清空当前角色记忆');
            if (!go) {
                setNote('已取消清空（记忆未改动）');
                result = Object.assign(result, { ok: false, action: a, reason: 'cancelled' });
            } else {
                const fn = (typeof hooks.resetState === 'function') ? hooks.resetState : kernelResetState;
                const r = await fn();
                setNote(r && r.ok
                    ? ('已清空当前角色的 FTT 记忆（' + Number((r.cleared && r.cleared.total) || 0) + ' 条已清除 · 落盘 ' + String(r.via || '未落盘') + '）')
                    : ('清空失败：' + String((r && r.error) || '未知')));
                result = Object.assign(result, r || { ok: false }, { action: a });
            }
        } else if (a === 'floorTrim') {
            // v2.94.0（`docs/D12` v0.2 §4 / §8-E，用户约定）：设定 → 数据管理「✂️ 删除聊天楼层」三档
            //   （保留最近 6 / 10 / 12 层）。纪律：
            //     ① **官方 API**（`ctx.deleteMessage`）—— 由宿主层执行，别的插件同样收到 `MESSAGE_DELETED` 事件；
            //     ② 预检先行（只读）→ 二次确认（D9 U4）→ 自动备份 → 删除 → 精确编号校准；
            //     ③ 宿主不支持 → **提示不支持并说明**（D12 Q6：不静默失败），按钮侧已 disabled。
            const keep = Number(p.keep) || 0;
            const pre = (typeof hooks.floorTrimPrecheck === 'function') ? hooks.floorTrimPrecheck(keep) : null;
            if (!pre) {
                setNote('删楼入口未就绪');
                result = Object.assign(result, { ok: false, action: a, reason: 'no-hook' });
            } else if (pre.supported === false || pre.unsupported) {
                setNote('当前宿主不提供官方删除楼层接口，无法执行（记忆未改动）');
                result = Object.assign(result, { ok: false, action: a, reason: String(pre.reason || 'unsupported-host') });
            } else if (!pre.ok) {
                setNote('无需删除：' + String(pre.summary || pre.reason || '当前楼层数已不超过该档'));
                result = Object.assign(result, { ok: false, action: a, reason: String(pre.reason || 'precheck') });
            } else {
                // 二次确认：把**预检结论**摆在最前面（用户先看清「删几层 / 影响几条 / 有没有没提取的楼」）
                const warnLine = (Number(pre.unextracted) > 0)
                    ? ('\n⚠️ 其中 ' + Number(pre.unextracted) + ' 层<b>尚未提取</b>，删除后将无法再补提（插件数据不会丢）。\n')
                    : '';
                const go = await confirmDialog(
                    '将删除<b>聊天</b>中较早的楼层（不是插件记忆）。\n\n'
                    + String(pre.summary || '') + '\n' + warnLine
                    + '\n删除前会自动生成一份明文备份；删除后插件会把记忆里的楼层编号一并校准（<b>记忆条目一条都不会删</b>）。\n\n是否继续？',
                    'FTT 删除聊天楼层'
                );
                if (!go) {
                    setNote('已取消删楼（聊天与记忆均未改动）');
                    result = Object.assign(result, { ok: false, action: a, reason: 'cancelled' });
                } else {
                    setNote('删除中…（先备份，再逐层删除并校准编号）');
                    const r = (typeof hooks.floorTrim === 'function') ? await hooks.floorTrim(keep) : { ok: false, reason: 'no-hook' };
                    if (r && r.ok) {
                        setNote('已删除 ' + Number(r.deleted) + ' 层，保留最近 ' + keep + ' 层 · 记忆保留 ' + Number((r.remap && r.remap.shifted) || 0) + ' 条已校准'
                            + (r.backup && r.backup.name ? (' · 备份 ' + r.backup.name) : ''));
                    } else if (r && r.partial) {
                        setNote('删楼未完成：已删 ' + Number(r.deleted) + '/' + Number(r.requested) + ' 层后中止（编号已按实际删除量校准，记忆未丢）');
                    } else {
                        const why = { 'backup-failed': '备份失败，已中止（未删除任何楼层）', 'backup-unavailable': '备份不可用，已中止（未删除任何楼层）', 'unsupported-host': '宿主不支持删除楼层' }[String(r && r.reason)] || String((r && r.reason) || '未知');
                        setNote('删楼未执行：' + why);
                    }
                    result = Object.assign(result, r || { ok: false }, { action: a });
                }
            }
        } else if (a === 'floorRecalibrate') {
            // v2.94.0（`docs/D12` §3.4 / 阶段 S3）：设定 → 存储「🔄 重新校准楼层」（**幂等**手动兜底）
            //   用于「用户在酒馆里自己删了楼」或跨端合并后编号可疑；**只改编号，绝不删除条目**。
            if (typeof hooks.floorRecalibrate !== 'function') {
                setNote('楼层校准入口未就绪');
                result = Object.assign(result, { ok: false, action: a, reason: 'no-hook' });
            } else {
                const r = await hooks.floorRecalibrate();
                const n = Number((r && r.staleEntries) || 0);
                setNote(r && r.ok
                    ? (r.skipped === 'no-shrink'
                        ? ('楼层已是最新：当前 ' + (Number(r.lastId) + 1) + ' 层，无需校准' + (Number(r.stale) ? ('（已有 ' + Number(r.stale) + ' 条楼层信息失效）') : ''))
                        : ('楼层已按当前聊天重算：当前 ' + (Number(r.lastId) + 1) + ' 层 · 标记失效 ' + n + ' 条 · 记忆一条未删'))
                    : ('校准未完成：' + String((r && r.skipped) || '未知')));
                result = Object.assign(result, r || { ok: false }, { action: a });
            }
        } else if (a === 'summaryFloor') {
            // v2.96.0 修复（用户报告「总览的可点击单楼分析，点击没任何反应」）：
            //   ① **立刻**给出可见反馈（此前 `setNote` 只在动作结束时才随重绘出现，AI 一慢就像点了没反应）：
            //      写入提示后**马上渲染一次**（点击的按钮此刻已带上 `.ftt-loading` 转圈态，见点击委托）；
            //   ② **防重复点击 / 防与批次撞车**（V1 `pipelineOccupied()` + `busy.summary` 的等价物）——
            //      此前可无限连点，会并发发出多条单楼分析；
            //   ③ 结果除提示行外**再弹一条通知**（V1 用 `notify` 弹「分析完成 / 无可分析内容」，V2 之前只有那行小字）。
            const floor = Number(p.floor);
            if (typeof hooks.extract !== 'function') { setNote('提取入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            if (!Number.isFinite(floor) || floor < 0) { setNote('无效楼层：' + String(p.floor)); return done({ ok: false, reason: 'bad-floor' }); }
            const batchBusy = (typeof hooks.busy === 'function') ? !!hooks.busy() : false;
            if (batchBusy || singleFloorBusy.has(floor)) {
                setNote('第 ' + floor + ' 楼已在分析中（或批量摘要正在运行），请等本次完成后再点');
                return done({ ok: false, reason: 'busy', floor: floor });
            }
            singleFloorBusy.add(floor);
            setNote('正在分析第 ' + floor + ' 楼…（AI 生成中，结果会写回记忆并刷新本页）');
            renderPanel();                                   // ① 立刻可见（不等 AI）
            try { panelNotify('info', '第 ' + floor + ' 楼：开始分析…'); } catch (e) { /* 忽略 */ }
            let r = null;
            try {
                r = await hooks.extract({ floor });
            } finally {
                singleFloorBusy.delete(floor);
            }
            // 兼容两种返回形态：单楼结果 {ok, added, total} 与批量结果 {ok, results:[{floor,added,…}]}
            let added = r && r.added, total = r && r.total, ok = !!(r && r.ok);
            if (r && Array.isArray(r.results)) {
                const hit = r.results.filter((x) => Number(x && x.floor) === floor)[0] || r.results[0] || null;
                ok = !!(hit && hit.ok);
                added = hit ? hit.added : 0;
            }
            const why = String((r && (r.reason || r.error)) || '未知');
            setNote(ok ? ('第 ' + floor + ' 楼：新增 ' + (Number(added) || 0) + ' 条' + (total === undefined ? '' : '（共 ' + total + '）'))
                : ('第 ' + floor + ' 楼未完成：' + why));
            // ③ 结果可见（成功/失败都给）：与 V1 的 notify 同口径；无可分析内容给可操作的解释
            try {
                if (ok) panelNotify('success', '第 ' + floor + ' 楼分析完成：本次提取 ' + (Number(added) || 0) + ' 条');
                else if (why === 'empty-floor') panelNotify('warning', '第 ' + floor + ' 楼在当前刷次下没有可分析正文（或已被投喂白/黑名单过滤），已从「未摘要」列表移除');
                else panelNotify('warning', '第 ' + floor + ' 楼未完成：' + why);
            } catch (e) { /* 忽略 */ }
            result = Object.assign(result, { ok: !!ok, floor: floor, added: Number(added) || 0 });
        } else if (a === 'inject') {
            if (typeof hooks.inject !== 'function') { setNote('注入入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            const r = await hooks.inject();
            setNote(r && r.ok ? ('已注入 ' + r.chars + ' 字') : ('注入失败：' + String((r && r.reason) || '未知')));
        } else if (a === 'clear-inject') {
            if (typeof hooks.clearInject === 'function') hooks.clearInject();
            setNote('已清空注入');
        } else if (a === 'check-update') {
            if (typeof hooks.checkUpdate === 'function') { setNote('检查更新…'); await hooks.checkUpdate(); setNote('检查完成'); }
            else setNote('更新入口未就绪');
        } else if (a === 'storeShare') {
            // v2.84.0：存储占比滚动条（设定 → 遗忘）—— 被拖动项权威，其余按原比例补齐到 100%
            // v2.85.0：提交时把被牵连的**保底下移**到新上限之下（用户要求「保底高于该数字则自动下移」）
            const dim = String(p.dim == null ? '' : p.dim);
            if (STORE_SHARE_DIMS.indexOf(dim) < 0) { setNote('未知维度：' + dim); result = { ok: false, reason: 'bad-dim' }; }
            else {
                const next = (() => { try { return allotStoreShares(cfg && cfg.storeShare, dim, Number(p.value) || 0); } catch (e) { return null; } })();
                if (!next) { setNote('占比调整失败'); result = { ok: false, reason: 'allot-failed' }; }
                else {
                    try { cfg.storeShare = Object.assign({}, next); } catch (e) { /* 忽略 */ }
                    const moved = (() => { try { return clampStoreFloors(next); } catch (e) { return []; } })();
                    try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
                    const label = String((STORE_LIMITS[dim] || [])[3] || dim);
                    const movedTxt = moved.length
                        ? ('；保底已下移：' + moved.map((m) => m.label + ' ' + m.from + '→' + m.to).join(' / '))
                        : '';
                    setNote('已调整「' + label + '」占比为 ' + Math.round(Number(p.value) || 0) + '%，其余按比例联动（合计 100%）' + movedTxt);
                    result = Object.assign(result, { ok: true, dim: dim, shares: next, floorsMoved: moved });
                }
            }
        } else if (a === 'linkQuery') {
            // v2.83.0：关联层派生视图的查询（设定 → 约束 → 🔗 关联层）；只写页内查询词，结果渲染时现算
            const q = setLinkQuery(String(p.q == null ? '' : p.q));
            ps.tab = 'settings';
            ps.settingsSub = 'constraint';
            setNote(q ? ('关联层查询：' + q.slice(0, 30)) : '已清空关联层查询');
            result = Object.assign(result, { ok: true, q: q });
        } else if (a === 'constraintDim') {
            // v2.80.0：关系表已收进「设定 → 约束」→ 维度改为**页内切换**（`data-ftt-cdim`）。
            //   与 V1 子标签点击同口径：切维度只重置「跳转定位 + 选角色态」，**不清角色筛选**
            //   （V1 `e.target.dataset.fttMsub` 分支同样只清 `relJumpRef` / `relPickRef`）。
            const dim = setConstraintDim(String(p.dim == null ? '' : p.dim));
            ps.settingsSub = 'constraint';
            try { const rf = relFilterState(); setRelFilter(rf.dim, rf.who, null); setRelPick(null); } catch (e) { /* 忽略 */ }
            setNote('关系表维度：' + relDimLabelOf(dim));
            result = Object.assign(result, { ok: true, dim: dim });
        }
        // ==================== B9-b：关系表定位跳转 +「👥 选角色」（V1 v1.166 / v1.194 同名动作） ====================
        // 注意：这些动作名都以 `rel` 开头 —— 必须放在下面的 `relAction` 兜底分支**之前**，否则会被误当作关表层动作。
        else if (a === 'relJump') {
            // V1 `case 'relJump'`：切到「关系表」并定位该条目（维度=该条目维度 / 清角色筛选 / 置跳转引用 / 关选择器）
            // v2.80.0：关系表落在「设定 → 约束」→ 导航副作用改为「切到设定页 + 约束子页 + 该维度」
            const jr = relJump(String(p.kind || ''), String(p.id || ''));
            if (jr.ok) {
                ps.tab = 'settings';
                ps.settingsSub = 'constraint';
                setConstraintDim(String(p.kind || ''));
                ps.editing = null;
                setNote('已定位到「约束 → 关系表」：' + relDimLabelOf(String(p.kind || '')) + '「' + String(jr.title || '').slice(0, 20) + '」');
                // V1 用 requestAnimationFrame 把定位目标滚到视野中央（无 DOM/无 rAF 时静默跳过）
                try {
                    const raf = globalThis.requestAnimationFrame;
                    if (typeof raf === 'function') raf(() => {
                        try {
                            const el = overlayEl && overlayEl.querySelector ? overlayEl.querySelector('[data-ftt-rel-entry="' + String(p.kind || '') + '|' + String(p.id || '').replace(/"/g, '') + '"]') : null;
                            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
                        } catch (e) { /* 忽略 */ }
                    });
                } catch (e) { /* 忽略 */ }
            } else {
                setNote('定位失败：条目引用无效');
            }
            result = Object.assign(result, jr);
        }
        else if (a === 'relGoto') {
            // V1 `case 'relGoto'`：打开条目所在页并把该页搜索词设为条目标题（清跳转/选择器态）
            const gr = relGoto(String(p.kind || ''), String(p.id || ''));
            if (gr.ok) {
                ps.tab = gr.tab;
                ps.q[gr.searchTab] = gr.title;      // V1 `pageSearchQuery[tabOf] = title`
                ps.editing = null;
                setNote(gr.title ? ('已定位到「' + String(gr.title).slice(0, 16) + '」') : '已打开条目所在页');
            } else {
                setNote('打开条目失败：条目引用无效');
            }
            result = Object.assign(result, gr);
        }
        else if (a === 'relClearFilter') {
            // V1 `case 'relClearFilter'`：维度筛选 + 角色筛选 + 跳转定位 + 选角色态一起清
            //   V2 收窄：维度由分页决定（`dim` 字段不参与过滤）→ 实际清「角色筛选 + 定位/选择器态」
            relClearFilter();
            setNote('已清除关系表筛选');
            result = Object.assign(result, { ok: true, filter: relFilterState() });
        }
        else if (a === 'relPick') {
            // V1 `case 'relPick'`：同一条目（同维度 + 同 editor 标记 + 同 id）再点一次 → 收起
            const kind = String(p.kind || '');
            const id = String(p.id || '');
            const isEd = (p.editor === true || String(p.editor == null ? '' : p.editor) === '1');
            if (!kind) { setNote('选角色失败：缺少维度'); result = { ok: false, reason: 'bad-dim' }; }
            else {
                const cur = relPickState();
                const same = !!(cur && String(cur.dim) === kind && !!cur.editor === isEd && String(cur.id || '') === id);
                setRelPick(same ? null : { dim: kind, id: id, editor: isEd });
                setNote(same ? '已收起「👥 选角色」' : ('「👥 选角色」：从角色档案点名（' + relKnownNames().length + ' 名）'));
                result = Object.assign(result, { ok: true, pick: relPickState() });
            }
        }
        else if (a === 'relPickClose') {
            setRelPick(null);
            setNote('已收起「👥 选角色」');
            result = Object.assign(result, { ok: true, pick: null });
        }
        else if (a === 'relPickAdd') {
            // V1 `case 'relPickAdd'`：追加一行关联角色（**不落库**，仍需点「💾 保存关联」）；三态提示与 V1 逐字一致
            const kind = String(p.kind || '');
            const id = String(p.id || '');
            const name = String(p.name || '');
            const isEd = (p.editor === true || String(p.editor == null ? '' : p.editor) === '1');
            if (!kind || !name) { result = { ok: false, reason: 'bad-args' }; }
            else {
                const r = relPickAppendRow(kind, id, name, { editor: isEd });
                if (r === 'dup') setNote('「' + name.slice(0, 12) + '」已在关联表里（如需再加一行可手写）');
                else if (r) setNote('已加角色「' + name.slice(0, 12) + '」—— 点「💾 保存关联」落库');
                else setNote('未找到关联表容器（请重新打开该条目）');
                result = Object.assign(result, { ok: !!r, appended: r === true, dup: r === 'dup', name: name });
            }
        }
        else if (a === 'relPickQuery') {
            setRelPickQuery(String(p.q == null ? '' : p.q));
            result = Object.assign(result, { ok: true, q: String(p.q == null ? '' : p.q) });
        }
        else if (a === 'relEdit') {
            // V1 关系表卡片是**卡内行内编辑**；V2 的编辑表单在**列表页**渲染（关系小表挂在编辑器下方）——
            //   v2.80.0：关系总览移到「设定 → 约束」后，此处必须把**分页切回该条目的列表页**
            //   （悬念与计划共用「计划悬念」页，见 `REL_TAB_OF`），否则编辑器无处可显。
            const k = String(p.kind || '');
            ps.tab = REL_TAB_OF[k] || 'memories';
            ps.editing = { kind: k, id: String(p.id || ''), preset: null };
            setNote('已打开条目编辑器（关联小表在编辑器下方）');
        }
        else if (a === 'relWho') {
            // V1 的「按角色筛（回车）」只写 `relFilterWho` 并重绘 —— 不打开任何条目编辑器
            //   （V2 早期实现会顺带打开首条命中条目的编辑器；B9-b 按 V1 更正，登记于 docs/P9a）。
            const rf = relFilterState();
            const next = setRelFilter(rf.dim, String(p.who == null ? '' : p.who), rf.jump);
            if (next.who) {
                try {
                    const hits = relByWho(next.who);
                    if (hits.length) setNote('筛选：' + hits.length + ' 条关联含「' + next.who + '」（首条：' + String(hits[0].title).slice(0, 20) + '）');
                    else setNote('筛选：没有关联含「' + next.who + '」');
                } catch (e) { /* 忽略 */ }
            } else setNote('已清除角色筛选');
        }
        else if (a.indexOf('rel') === 0 && a !== 'reload') {
            const rr = relAction(a, p);
            setNote(rr.ok ? ('关系：' + (rr.saved !== undefined ? ('已保存 ' + rr.saved + ' 行 / 新增 ' + (rr.added || 0) + ' · 更新 ' + (rr.updated || 0) + (rr.skipped ? (' · 跳过空行 ' + rr.skipped) : '')) : (rr.cleared !== undefined ? ('已清空 ' + rr.cleared + ' 行') : (rr.swept !== undefined ? ('已清扫孤儿 ' + rr.swept + ' 行') : (rr.dropped !== undefined ? ('已清除推定 ' + rr.dropped + ' 行') : ('行数 ' + (rr.rows || 0))))))) : ('关系操作失败：' + String(rr.reason || '未知')));
            result = Object.assign(result, rr);
        }
        else if (a === 'checkRefresh' || a === 'checkMode') {
            const cr = injectCheckAction(a, { mode: p.mode });
            setNote(a === 'checkMode' ? ('自查口径：' + (cr.useKeywords ? '按最近关键词' : '按本地召回')) : '已按当前数据刷新注入自查预览');
            result = Object.assign(result, cr);
        }
        else if (a.indexOf('snap') === 0) {
            const sr = snapshotAction(a, { id: p.id || (p.snapId || ''), snapId: p.snapId });
            setNote(sr.ok
                ? (a === 'snapCreate' ? ('已建根快照 ' + String(sr.id || '').slice(0, 16))
                    : a === 'snapRestore' ? ('已还原到快照（' + (sr.added || 0) + ' 条原子）')
                        : a === 'snapDelete' ? ('已删除快照 ' + String(sr.deleted || '').slice(0, 16))
                            : a === 'snapConsolidate' ? ('已整理：并入根 ' + (sr.folded || 0) + ' 个增量（根 ' + (sr.roots || 0) + '）')
                                : a === 'snapshotInspect' ? (sr.id ? ('已展开快照内容（' + Number((sr.items || []).length) + ' 条原子）') : '已收起快照内容')
                                    : '已清空全部快照（记忆本体未动）')
                : ('快照操作失败：' + String(sr.reason || '未知')));
            result = Object.assign(result, sr);
        }
        else if (a.indexOf('prompt') === 0 || a === 'armorPresetImport') {
            // 提示词模板动作：保存/恢复单条/整组/全部 + 破甲预设导入（textarea 取值）
            const key = String(p.promptKey || p.key || '');
            let text = p.text;
            if (text === undefined) {
                try {
                    const doc = globalThis.document;
                    if (doc && doc.querySelector) {
                        const sel = (a === 'armorPresetImport') ? '[data-ftt-armor-import]' : ('[data-ftt-prompt="' + key + '"]');
                        const node = doc.querySelector(sel);
                        if (node) text = String(node.value == null ? '' : node.value);
                    }
                } catch (e) { /* 忽略 */ }
            }
            const pr = promptAction(a, { key, text, group: p.group });
            setNote(pr.ok
                ? (a === 'promptSave' ? ('已保存提示词 ' + key + '（' + (pr.chars || 0) + ' 字' + (pr.customized ? ' · 已自定义' : ' · 与默认一致') + '）')
                    : a === 'promptResetOne' ? ('已恢复默认：' + key)
                        : a === 'promptResetAll' ? ('已全部恢复默认（' + (pr.reset || 0) + ' 条）')
                            : a === 'promptGroupReset' ? ('已恢复本组默认（' + (pr.reset || 0) + ' 条）')
                                : ('已采用破甲预设（' + (pr.imported || 0) + ' 字）'))
                : ('提示词操作失败：' + String(pr.reason || '未知')));
            result = Object.assign(result, pr);
        }
        else if (CLOCK_ACTIONS.indexOf(a) >= 0) {
            // 时钟动作（v2.51.0：手工改写 / 解锁 / AI 修复情节日期时间）
            const cr = await clockAction(a, p);
            setNote(cr.note || '');
            result = Object.assign(result, cr);
        }
        else if (a === 'repair') {
            // 「🛠 自动修复」：V1 三段式（① JS 机械清理 → ② 候选筛选 → ③ 窄契约 AI 修订）
            //   手动路径重置同楼层上限计数（V1 口径）；AI 段不可用/未配置时如实回报（不伪造结果）。
            const r = await runRepair({ cause: '手动' });
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用/已达上限') + '）');
            else {
                const st1 = (r.stage1 || {});
                const pick = (r.pickStat || {});
                parts.push('机械清理：合并 ' + Number(st1.merged || 0) + ' · 清理 ' + Number(st1.deleted || 0)
                    + ' · 遗忘清扫 ' + Number((r.mech && r.mech.sweep ? r.mech.sweep.swept : 0) || 0)
                    + ' · 条数裁剪 ' + Number((r.mech && r.mech.caps ? r.mech.caps.cut : 0) || 0));
                parts.push('候选 ' + Number((r.cands || []).length) + ' 条（缺陷 ' + Number(pick.defects || 0) + ' · 高相关 ' + Number(pick.corrHigh || 0)
                    + ' · 抽查 ' + Number(pick.sampled || 0) + ' · 补足 ' + Number(pick.topped || 0) + '）');
                const ai = r.ai || {};
                parts.push(ai.used
                    ? ('AI 修订 ' + Number(ai.revised || 0) + ' 条 · 删除 ' + Number(ai.deleted || 0) + ' 条 · 丢弃 ' + Number(ai.skipped || 0) + ' 条' + (ai.error ? '（' + ai.error + '）' : ''))
                    : '未调用 AI' + (cfg.repairAutoAi === false ? '（「AI 修订措辞」已关闭 → 只做机械清理）' : '（无候选或 AI 不可用）'));
            }
            setNote('自动修复：' + parts.join('；') + (r.report ? '；' + String(r.report) : ''));
            result = Object.assign(result, { ok: true, action: a, repair: r, made: r.made || 0 });
        }
        else if (a === 'clearPlans' || a === 'clearSuspense') {
            // V1 同名动作：一键清空计划库 / 悬念库（**写删除墓碑**，不弹确认 —— V1 原样）
            const dim = (a === 'clearPlans') ? 'plans' : 'suspense';
            const list = Array.isArray(state[dim]) ? state[dim].slice() : [];
            for (const e of list) { try { if (e && e.id) tombMany(dim, [e.id]); } catch (err) { /* 忽略 */ } }
            state[dim] = [];
            try { saveState(); } catch (err) { /* 忽略 */ }
            setNote(list.length ? ('已清理 ' + list.length + ' 条' + (dim === 'plans' ? '计划' : '悬念')) : ((dim === 'plans' ? '计划库' : '悬念库') + '已为空'));
            result = Object.assign(result, { ok: true, action: a, cleared: list.length });
        }
        else if (a === 'rumorEvolve') {
            // V1 `rumorsHtml()`：「🧪 立即演化」——手动触发一次**零 AI** 机械演化（载体老化/发酵消退/平行联动/裂变）
            const rs = await runRumorEvolveNow({ silent: false });
            setNote(rs && rs.ok
                ? ('传言演化：载体停用 ' + Number(rs.aged || 0) + ' · 联动 ' + Number(rs.links || 0) + ' · 酝酿变化 ' + Number(rs.changes || 0)
                    + ' · 完成变化 ' + Number(rs.committed || 0) + '（裂变 ' + Number(rs.fissions || 0) + '）')
                : ('传言演化失败：' + String((rs && rs.error) || '未知')));
            result = Object.assign(result, { ok: !!(rs && rs.ok), action: a, rumor: rs });
        }
        else if (a === 'clearRumors') {
            // V1 同名动作：清空全部传言并留删除墓碑
            const n = clearRumors();
            setNote(n ? ('已清空 ' + n + ' 条传言（留删除墓碑）') : '当前没有传言');
            result = Object.assign(result, { ok: true, action: a, cleared: n });
        }
        else if (a === 'memoryRepair') {
            // 「🔧 修复记忆」（V1 v1.140 记忆页专用）：机械去重 → 关系层维护 → 标签组聚类选组 → 窄契约 AI 梳理
            //   → 按编号精确应用（合并/修订/删除；跨归属拒收）→ 再跑一次关系层维护；AI 不可用/无高相关组时如实回报。
            const r = await runMemoryRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('无需 AI 梳理（机械去重 ' + Number(r.merged || 0) + ' 条）');
            else {
                parts.push('高相关组 ' + Number(r.groups || 0) + '/' + Number(r.groupsTotal || 0) + ' 组（核对 ' + Number(r.checked || 0) + ' 条）');
                if (Number(r.fused || 0)) parts.push('合并 ' + Number(r.fused) + ' 组（-' + Number(r.removed || 0) + ' 条）');
                if (Number(r.revised || 0)) parts.push('修订 ' + Number(r.revised) + ' 条');
                if (Number(r.deleted || 0)) parts.push('删除 ' + Number(r.deleted) + ' 条');
                if (Number(r.merged || 0)) parts.push('机械去重 ' + Number(r.merged) + ' 条');
                if (Number(r.retargeted || 0)) parts.push('关联重挂 ' + Number(r.retargeted) + ' 行');
            }
            setNote('记忆修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, memoryRepair: r, made: r.made || 0 });
        }
        else if (a === 'conceptRepair') {
            // 「🔧 修复概念」（V1 v1.139 概念页专用）：机械合并（同名称/同内容）→ 标签组聚类选组 → 窄契约 AI
            //   → 按编号精确应用（合并/修订/删除）；无高相关组时**零 AI**，如实回报。
            const r = await runConceptRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('无需 AI 梳理（机械合并 ' + Number(r.merged || 0) + ' 条）');
            else {
                parts.push('高相关组 ' + Number(r.groups || 0) + '/' + Number(r.groupsTotal || 0) + ' 组（核对 ' + Number(r.checked || 0) + ' 条）');
                if (Number(r.fused || 0)) parts.push('合并 ' + Number(r.fused) + ' 组（-' + Number(r.removed || 0) + ' 条）');
                if (Number(r.revised || 0)) parts.push('修订 ' + Number(r.revised) + ' 条');
                if (Number(r.deleted || 0)) parts.push('删除 ' + Number(r.deleted) + ' 条');
                if (Number(r.merged || 0)) parts.push('机械合并 ' + Number(r.merged) + ' 条');
            }
            setNote('概念修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, conceptRepair: r, made: r.made || 0 });
        }
        else if (a === 'sceneRepair') {
            // 「🔧 修复结构/用词」（V1 v1.89 场景页专用）：整库清单 → AI「场景库.重建」最终列表
            //   → applySceneRebuild（归一化/去重/补中间层，路径未变保留 id/uses）→ 场景并集归并 → 落盘
            const r = await runSceneRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push(r.error === 'no-rebuild' ? 'AI 未返回可用的场景重建列表' : ('失败：' + String(r.error)));
            else if (r.skipped) parts.push('暂无场景');
            else parts.push('节点 ' + Number(r.before || 0) + ' → ' + Number(r.after || 0));
            setNote('场景修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, sceneRepair: r, made: r.made || 0 });
        }
        else if (a === 'itemRepair') {
            // 「🔧 修复物品」（V1 v1.142 物品页专用）：机械去重（同规范名）→ 低调用固定规则清理 →
            //   标签/名称聚类选组 → 窄契约 AI 融合/完善说明 → 按编号精确应用（合并/修订/删除）；
            //   无高相关组且无缺陷条目时**零 AI**，如实回报。
            const r = await runItemRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('无需 AI 判断融合（机械合并 ' + Number(r.merged || 0) + ' 件 · 低调用清理 ' + Number(r.purged || 0) + ' 件）');
            else {
                // 注意：V1 `runItemRepair` 成功分支的返回结构**不含 `groupsTotal`**（黄金样本已固化，不得加键改形），
                //   故此处以 `groups` 兜底展示（记忆/概念域的返回里才有 groupsTotal）。
                const gt = (r.groupsTotal != null) ? r.groupsTotal : (Number(r.groups) || 0);
                parts.push('高相关组 ' + Number(r.groups || 0) + '/' + Number(gt) + ' 组（核对 ' + Number(r.checked || 0) + ' 条）');
                if (Number(r.fused || 0)) parts.push('合并 ' + Number(r.fused) + ' 组（-' + Number(r.removed || 0) + ' 件）');
                if (Number(r.revised || 0)) parts.push('修订 ' + Number(r.revised) + ' 件');
                if (Number(r.deleted || 0)) parts.push('删除 ' + Number(r.deleted) + ' 件');
                if (Number(r.merged || 0)) parts.push('机械合并 ' + Number(r.merged) + ' 件');
                if (Number(r.purged || 0)) parts.push('低调用清理 ' + Number(r.purged) + ' 件');
            }
            setNote('物品修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, itemRepair: r, made: r.made || 0 });
        }
        else if (a === 'characterRepair') {
            // 「🔧 修复角色」（V1 v1.139 角色页专用）：AI 前全局机械处理（出生日期/标签/年龄，零 AI）
            //   → 待修复名单（字数门限 + 出生日期异常优先档 + 已去世跳过）→ 窄契约 AI（空手则加强重试一次）
            //   → 按「姓名 + 中文点路径」精确应用（只填空不改写）→ 出生/标签兜底 + 年龄刷新。
            const r = await runCharacterRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('暂无角色或无需修复（可修复 ' + Number(r.total || 0) + ' 名 · 门限 ' + Number((r.mech && r.mech.total) || 0) + ' 名已机械处理）');
            else if (r.noChange) parts.push('本轮未产生实际变化（目标 ' + Number(r.targets || 0) + ' 名' + (r.attempts > 1 ? ' · AI 加强重试 ' + Number(r.attempts) + ' 轮' : '') + '）');
            else {
                parts.push('目标 ' + Number(r.targets || 0) + ' 名' + (r.attempts > 1 ? '（AI 加强重试 ' + Number(r.attempts) + ' 轮）' : ''));
                parts.push('补全 ' + Number(r.rolesChanged || 0) + ' 名 / ' + Number(r.changed || 0) + ' 个字段');
                if (Number(r.removed || 0)) parts.push('删除明显错误 ' + Number(r.removed) + ' 条');
                if (Number(r.inferred || 0)) parts.push('保守推断 ' + Number(r.inferred) + ' 名');
                if (Number(r.noBasis || 0)) parts.push('无依据 ' + Number(r.noBasis) + ' 名');
                if (Number(r.queueLeft || 0)) parts.push('剩余待修 ' + Number(r.queueLeft) + ' 名');
            }
            setNote('角色修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, characterRepair: r, made: r.made || 0 });
        }
        else if (a === 'stateRepair') {
            // 「🔧 修复状态」（V1 v1.158 状态页专用）：① 已去世固定规则移除 → ① 匹配角色（未匹配整组删除）
            //   → ② 机械清理与字段规范化 → ③ 最薄弱主体交 AI 整理；无主体可提交时**零 AI**，如实回报。
            const r = await runStateRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('已按规则整理，无可提交 AI 的主体'
                + (Number((r.clean && r.clean.junk) || 0) ? '（清理空值/占位 ' + Number(r.clean.junk) + ' 条）' : ''));
            else {
                const mt = r.match || {};
                const cl = r.clean || {};
                const ai = r.ai || {};
                parts.push('目标 ' + Number(r.targets || 0) + ' 名 / 共 ' + Number(r.before || 0) + ' 条');
                if (Number(r.before || 0) !== Number(r.after || 0)) parts.push('条数 ' + Number(r.before || 0) + ' → ' + Number(r.after || 0));
                if (Number(mt.removed || 0)) parts.push('删除无档案主体 ' + Number(mt.removed) + ' 条');
                if (Number(cl.junk || 0)) parts.push('清理空值/占位 ' + Number(cl.junk) + ' 条');
                if (Number(cl.merged || 0)) parts.push('同字段去重 ' + Number(cl.merged) + ' 条');
                if (Number(ai.changed || 0)) parts.push('AI 更新 ' + Number(ai.changed) + ' 条');
                if (Number(ai.deleted || 0)) parts.push('AI 删除 ' + Number(ai.deleted) + ' 条');
                if (Number(r.queueLeft || 0)) parts.push('剩余待修 ' + Number(r.queueLeft) + ' 名');
            }
            setNote('状态修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, stateRepair: r, made: r.made || 0 });
        }
        else if (a === 'planSuspRepair') {
            // 「🔧 修复计划/悬念」（V1 v1.140 悬念聚类核对 + v1.113 计划冗余合并）：① 悬念机械去重 →
            //   ①-b 关联层机械维护 → ②③ 聚类选组 → ④ AI（悬念按编号 / 计划了结 + 冗余合并）
            const r = await runPlanSuspRepair();
            const parts = [];
            if (r.blocked) parts.push('已跳过（' + String(r.reason || '任务占用中') + '）');
            else if (r.error) parts.push('失败：' + String(r.error));
            else if (r.skipped) parts.push('无可了结/合并条目（核对 ' + Number(r.checked || 0) + ' 条）');
            else {
                if (Number(r.closedP || 0)) parts.push('已了结计划 ' + Number(r.closedP) + ' 项');
                if (Number(r.closedS || 0)) parts.push('已揭晓悬念 ' + Number(r.closedS) + ' 项');
                if (Number(r.mergedS || 0)) parts.push('合并悬念 ' + Number(r.mergedS) + ' 组（-' + Number(r.removedDup || 0) + ' 条）');
                if (Number(r.revised || 0)) parts.push('修订悬念 ' + Number(r.revised) + ' 条');
                if (Number(r.deleted || 0)) parts.push('删除无效悬念 ' + Number(r.deleted) + ' 条');
                if (Number(r.mergedP || 0)) parts.push('合并计划 ' + Number(r.mergedP) + ' 组');
                if (Number(r.merged || 0)) parts.push('机械去重 ' + Number(r.merged) + ' 条');
            }
            setNote('计划/悬念修复：' + parts.join('；'));
            result = Object.assign(result, { ok: true, action: a, planSuspRepair: r, made: r.made || 0 });
        }
        // ==================== B9-c：投喂标签自动分析（V1 同名动作） ====================
        else if (FEED_SCAN_ACTIONS.indexOf(a) >= 0) {
            // V1 `case 'rxScanTags'` / `'rxAddTag'` / `'rxScanClear'`（约 27087~27103）：
            //   `rxScanTags` 分析最新 AI 正文结构（无正文时 warning）→ `renderPanel()` → 提示；
            //   `rxAddTag` 按 `data-ftt-kind`（非 black 一律 white）+ `data-ftt-tag` 收录并自动排重；
            //   `rxScanClear` 清空结果（**V1 无提示**，V2 同样不写 note）。
            const fr = feedScanAction(a, p);
            setNote(fr.note || '');
            result = Object.assign(result, fr);
        }
        // ==================== B9-c：货币「指定角色」标定（V1 v1.183 四个动作） ====================
        else if (a === 'curTrackPick') {
            // V1 `case 'curTrackPick'`：打开/关闭选择器（纯开关，不重置搜索词）
            setTrackPick(!trackPickState());
        }
        else if (a === 'curTrackClose') { setTrackPick(false); }
        else if (a === 'curTrackToggle') {
            // V1 `case 'curTrackToggle'`：已标定 → 取消（toast 纯文本）；未标定 → 标定（notify 标题 + 文本）
            const nm = String(p.name || '').trim();
            if (nm) {
                const on = isTrackedCurrencyOwner(nm);
                if (on) { removeTrackedCurrencyRole(nm); setNote('已取消标定「' + nm + '」'); }
                else {
                    addTrackedCurrencyRole(nm);
                    setNote('已标定「' + nm + '」：后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。');
                }
            }
        }
        else if (a === 'curTrackClear') {
            // V1 `case 'curTrackClear'`：清空全部标定（toast 纯文本，含条数）
            const n = clearTrackedCurrencyRoles();
            setNote(n ? ('已清空 ' + n + ' 个标定角色') : '当前没有标定角色');
        }
        else if (NSFW_ACTIONS.indexOf(a) >= 0) {
            // 内容弱化动作（V1 同名：立即弱化 / 固定规则替换 / 词条库与转化库增删改恢复）
            const nr = await nsfwAction(a, p);
            setNote(nr.note || '');
            result = Object.assign(result, nr);
        }
        else if (SYNC_ACTIONS.indexOf(a) >= 0) {
            // 存储页动作（V1 同名：刷新状态 / 立即同步 / 校验并修复 / 刷新日志 / 清空日志）
            const sr = await syncAction(a, p);
            setNote(sr.note || '');
            result = Object.assign(result, sr);
        }
        else if (API_ACTIONS.indexOf(a) >= 0) {
            // API 页动作（V1 同名：`presetSave`/`presetLoad`/`presetDelete`/`apiTest`/`apiModels`；
            //   `dimPreset` 为 V2 的各维度分组下拉动作，写 `cfg.dimensionPresets`）
            const ar = await apiAction(a, p);
            setNote(ar.note || '');
            result = Object.assign(result, ar);
        }
        else if (DEBUG_ACTIONS.indexOf(a) >= 0) {
            // 调试页动作（V1 同名：`dbgClear` —— 清空日志缓冲与 localStorage 持久层）
            const dr = await debugAction(a, p);
            setNote(dr.note || '');
            result = Object.assign(result, dr);
        }
        else if (ABOUT_ACTIONS.indexOf(a) >= 0) {
            // 关于页动作（V1 同名：`aboutReload` 重新获取 / `aboutClearCache` 清本地缓存并复位状态）
            const ar = await aboutAction(a, p);
            setNote(ar.note || '');
            result = Object.assign(result, ar);
        }
        else if (a === 'settingsSub') {
            const id = String(p.sub || p.kind || '');
            ps.settingsSub = SETTINGS_TABS.some((t) => t.id === id) ? id : ps.settingsSub;
        }
        else if (a === 'exportState') {
            if (typeof hooks.exportState !== 'function') { setNote('导出入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            const text = String((await hooks.exportState()) || '');
            ps.exportText = text;
            // ① **真实下载文件**（V1 `export` 动作同款：Blob + `<a download>`）
            const fname = (() => {
                try { return String((typeof hooks.exportFileName === 'function' ? hooks.exportFileName() : '') || '') || defaultExportFileName(); } catch (e) { return defaultExportFileName(); }
            })();
            const dl = text ? downloadTextFile(fname, text, 'application/json') : { ok: false, reason: 'empty' };
            // ② 复制到剪贴板（保留，便于直接粘贴）
            let copied = false;
            try {
                const nav = globalThis.navigator;
                if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); copied = true; }
            } catch (e) { copied = false; }
            const bits = ['已导出 ' + text.length + ' 字符（备份 / 迁移用）'];
            bits.push(dl.ok ? ('已下载文件 ' + dl.filename) : ('未下载文件（' + dl.reason + '）—— 可从下方文本框手动复制保存'));
            if (copied) bits.push('已复制到剪贴板');
            setNote(bits.join(' · '));
            result = Object.assign(result, { ok: true, chars: text.length, copied: copied, downloaded: !!dl.ok, filename: dl.ok ? dl.filename : '', downloadReason: dl.reason || '' });
        }
        else if (a === 'importStateOpen') {
            // **真实选择存档文件**（V1 `import` 动作同款：`<input type=file>` → 读取 → 增量合并）
            if (typeof hooks.importState !== 'function') { setNote('导入入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            if (!fileIoCapabilities().pick) { setNote('当前宿主不支持文件选择器 —— 请把 JSON 内容粘贴到文本框，再点「⬆ 导入粘贴内容」'); return done({ ok: false, reason: 'no-picker' }); }
            setNote('请选择要导入的 JSON 存档文件…');
            const picked = await pickTextFile({ accept: '.json,application/json' });
            if (!picked.ok) {
                const why = picked.reason === 'cancelled' ? '已取消选择文件' : ('未取到文件（' + picked.reason + '）');
                setNote(why + ' —— 也可把 JSON 内容粘贴到文本框，再点「⬆ 导入粘贴内容」');
                return done({ ok: false, reason: picked.reason || 'no-file' });
            }
            const r = await hooks.importState(picked.text);
            setNote(r && r.ok
                ? ('已导入文件 ' + (picked.name || '（未命名）') + ' 并合并：新增 ' + (r.added || 0) + ' 条（相同的跳过 / 变更覆盖，未删除本地记忆）')
                : ('导入失败（' + String((r && r.reason) || '未知') + '）：' + (picked.name || '')));
            result = Object.assign(result, r || {}, { fileName: picked.name, fileSize: picked.size });
        }
        else if (a === 'importV1Dry' || a === 'importV1Apply') {
            if (typeof hooks.importV1 !== 'function') { setNote('旧版导入入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            const apply = a === 'importV1Apply';
            setNote(apply ? '导入并写入…' : '读取 V1 数据…');
            const r = await hooks.importV1({ apply });
            const t = (r && r.report && r.report.totals) || {};
            setNote((apply ? '【已写入】' : '【干跑】') + (r && r.via ? r.via : '无源数据')
                + '：新增 ' + (t.add || 0) + ' · 已存在 ' + (t.exist || 0) + ' · 冲突 ' + (t.conflict || 0));
        }
        else if (a === 'dimToggle') {
            if (typeof hooks.dimToggle === 'function') hooks.dimToggle(String(p.kind || ''), !!p.on);
            setNote('维度 ' + String(p.kind || '') + (p.on ? ' 已启用' : ' 已停用'));
        }
        else if (a === 'importStateApply') {
            if (typeof hooks.importState !== 'function') { setNote('导入入口未就绪'); return done({ ok: false, reason: 'no-hook' }); }
            const el = (() => { try { const doc = globalThis.document; return doc && doc.querySelector ? doc.querySelector('[data-ftt-import]') : null; } catch (e) { return null; } })();
            const text = String(p.text != null ? p.text : (el ? el.value : ''));
            if (!text.trim()) { setNote('导入失败：文本框是空的 —— 请先粘贴导出的 JSON 内容'); return done({ ok: false, reason: 'empty' }); }
            const r = await hooks.importState(text);
            setNote(r && r.ok
                ? ('已导入并合并：新增 ' + (r.added || 0) + ' 条（相同的跳过 / 变更覆盖，未删除本地记忆）')
                : ('导入失败：' + String((r && r.reason) || '未知')));
            result = Object.assign(result, r || {});
        }
        else if (a === 'refresh' || a === 'noop') { /* 仅重渲染 */ }
        else { result = { ok: false, reason: 'unknown-action' }; }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
        // v2.34.0：面板动作异常统一留痕（强化调试）—— 写入内核调试日志的「异常」类，便于事后挖掘
        try { debugLogPush('异常', { kind: '面板动作失败', action: String(action || ''), message: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 2000) }); } catch (err) { /* 忽略 */ }
        setNote('操作失败：' + result.error);
        // v2.87.0（用户要求：「错误信息除了日志记录外，应该通知异常，而不是什么都没反应」）：
        //   用户主动触发的动作异常 → **强制**弹一次可见提示（不受每会话上限约束）
        try { notifyError('操作失败：' + result.error, { force: true }); } catch (err) { /* 忽略 */ }
    }
    return finalizePanelAction(result, traceOp, traceT0, a, p);
}

/**
 * v2.96.0（用户报告：「总览的可点击单楼分析，点击没任何反应」）——**统一收尾**（渲染 + 提示 + 交互留痕）。
 *
 * 为什么必须抽出来：`panelAction()` 内部有十余处「前置条件不满足」的**早退**（`return { ok:false, reason:'no-hook' }`），
 *   它们绕过了函数末尾的 `renderPanel()` —— 于是刚 `setNote('…入口未就绪')` 写下的提示**永远不会出现在界面上**，
 *   用户看到的就是「点了没任何反应」。现在所有返回路径（含早退与异常）都经过本函数，界面一定更新。
 *
 * @param {object} result 动作结果（会被就地补上 `html` / `state`）
 * @param {object} traceOp `traceOpStart()` 的句柄
 * @param {number} traceT0 起始时刻
 * @param {string} action 动作名
 * @param {object} params 入参
 */
function finalizePanelAction(result, traceOp, traceT0, action, params) {
    const p = params || {};
    // v2.87.0：动作**被拒绝**（ok:false，例如未知动作 / 前置条件缺失）也要可见 —— 走节流（同文案 60s 一次）
    try {
        if (result && result.ok === false) {
            const why = String(result.error || result.reason || '未知原因');
            if (why !== 'unknown-action' || true) notifyError('操作未完成：' + why);
        }
    } catch (err) { /* 忽略 */ }
    renderPanel();
    const out = Object.assign(result, { html: panelHtml(), state: panelState() });
    // v2.42.0：交互完成事件（动作 / 入参摘要 / 结果 / 耗时 / 站点 / opId）—— 这是「所有用户交互」的主时间线
    try {
        const ended = traceOpEnd(traceOp, out);
        traceEvent({
            cat: 'ui', kind: String(action || ''), level: out.ok === false ? 'info' : 'debug',
            ok: out.ok !== false, reason: String(out.reason || ''),
            ms: Date.now() - traceT0,
            detail: {
                params: traceParamsOf(p), tab: ps.tab, sub: ps.settingsSub,
                note: String(ps.note || ''), reason: String(out.reason || ''),
                children: ended ? { opId: ended.opId, ms: ended.ms } : null,
            },
            opId: traceOp.opId, op: traceOp.name,
        });
    } catch (e) { /* 追踪失败不影响面板 */ }
    return out;
}

/** 交互入参摘要（只取动作模块实际读的键；长值由 trace 内核截断/脱敏） */
function traceParamsOf(p) {
    const o = p || {};
    const out = {};
    ['kind', 'id', 'idx', 'index', 'tag', 'mode', 'from', 'to', 'row', 'dim', 'refId', 'name', 'editor', 'preset', 'sub', 'tab', 'snapId', 'promptKey', 'group', 'summary', 'floor', 'subject'].forEach((k) => {
        if (o[k] !== undefined && o[k] !== '') out[k] = o[k];
    });
    if (o.text !== undefined) out.text = '[文本 ' + String(o.text || '').length + ' 字]';
    return out;
}

/** 读取某配置键当前值（用于 change 时判断是否按数字写回） */
function readControlValue(key) {
    try {
        const k = String(key || '');
        if (k.indexOf('storage.') === 0) return (cfg.storage || {})[k.slice(8)];
        return cfg[k];
    } catch (e) { return undefined; }
}

/**
 * ============================================================
 * v2.85.0（用户要求）：「存储总上限 / 各大类占比」滚动条的**拖动中实时联动**
 *   用户原话：①「各大类百分比滚动条没有联动，调节一个其他应该等比例变化。」
 *             ②「存储总上限的保底数据应该被动联动，如情节调节后，如果保底数据高于该数字则自动下移数字。」
 * 口径：
 *   · 联动算法与提交完全同源（`core/ingest.js#allotStoreShares`）—— 被拖动项权威，其余按**基准占比**等比例缩放，
 *     四舍五入 + 余数给最大项，合计恒为 100%；
 *   · **基准占比**在本次拖动首次 input 时快照（`shareDrag.base`），全程以它为比例基准 —— 避免「每帧按已改过的值再缩放」
 *     造成比例漂移；松手（change）后清空；
 *   · 拖动只改 DOM（滚动条 / 读数 / 保底文字 / 合计行 / 保底输入框），**不写配置**；落盘仍走 change → `storeShare` 动作。
 * ============================================================
 */
let shareDrag = null;      // { el, dim, base } —— 本次拖动的基准占比（DOM 快照；松手即清空）

/** 读当前页面上所有占比滚动条的取值（域内 DOM 快照） */
function shareSliderValues(root) {
    const out = {};
    try {
        const nodes = (root && typeof root.querySelectorAll === 'function') ? root.querySelectorAll('[data-ftt-share]') : [];
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const d = String((n.dataset || {}).fttShare || '');
            if (d) out[d] = Number(n.value) || 0;
        }
    } catch (e) { /* 快照失败 → 用配置值兜底（见调用方） */ }
    return out;
}

/**
 * 按给定占比表刷新「占比区」的全部读数：滚动条值 / 占比读数 / 保底文字 / 合计行 / 保底输入框。
 * @param {object} root 面板根（或任一含占比区的容器）
 * @param {object} shares 归一后的占比表
 * @param {number} total 总上限（拖动总上限时传预览值）
 * @param {Element} [skip] 正在被拖动的滚动条（不回写它的 value，避免与手指位置打架）
 */
function applySharePreview(root, shares, total, skip) {
    let sumPct = 0, sumCap = 0;
    for (const d of STORE_SHARE_DIMS) {
        const pct = Number(shares[d]) || 0;
        const cap = Math.max(1, Math.round(Number(total) * (pct / 100)));
        sumPct += pct;
        sumCap += cap;
        const input = (typeof root.querySelector === 'function') ? root.querySelector('[data-ftt-share="' + d + '"]') : null;
        if (input && input !== skip) input.value = String(pct);
        const out = (typeof root.querySelector === 'function') ? root.querySelector('[data-ftt-share-out="' + d + '"]') : null;
        if (out) out.textContent = pct + '% · ≈' + cap + ' 条';
        const floorEl = (typeof root.querySelector === 'function') ? root.querySelector('[data-ftt-share-floor="' + d + '"]') : null;
        if (floorEl) floorEl.textContent = shareFloorText(d, cap);
        // 保底输入框（设定 → 遗忘 上方的保底控件，v2.85.0「自动下移数字」）：高于上限就跟着降到上限
        const minKey = String((STORE_LIMITS[d] || [])[0] || '');
        const minInput = (minKey && typeof root.querySelector === 'function') ? root.querySelector('[data-ftt-cfg="' + minKey + '"]') : null;
        if (minInput && Number(minInput.value) > cap) minInput.value = String(cap);
    }
    const sumEl = (typeof root.querySelector === 'function') ? root.querySelector('[data-ftt-share-sum]') : null;
    if (sumEl) sumEl.innerHTML = shareSumHtml(sumPct, sumCap, total);
}

/** 拖动「某维占比」时的实时联动（input 事件；只改 DOM，不落盘） */
function shareDragInput(root, tg) {
    const dim = String((tg.dataset || {}).fttShare || '');
    if (STORE_SHARE_DIMS.indexOf(dim) < 0) return;
    if (!shareDrag || shareDrag.el !== tg) {
        const snap = shareSliderValues(root);
        const base = {};
        for (const d of STORE_SHARE_DIMS) base[d] = (snap[d] === undefined) ? Number(storeShareOf(d)) || 0 : snap[d];
        shareDrag = { el: tg, dim: dim, base: base };
    }
    const value = Number(tg.value) || 0;
    // 基准表恒为**合计 100 的完整表**（被拖动项在表里仍留旧值）：`allotStoreShares` 只按其余维度的**比例**缩放，
    //   若先把被拖项的新值写进基准表，表就不足 100 → 归一化会把差额补给最大项，比例当场失真。
    const next = allotStoreShares(shareDrag.base, dim, value);
    applySharePreview(root, next, storeTotalMax(), tg);
}

/** 拖动「存储总上限」时的实时联动（占比不变，但各维条数 / 保底会随之变） */
function shareTotalInput(root, total) {
    let shares = null;
    try { shares = normStoreShares(cfg && cfg.storeShare); } catch (e) { shares = null; }
    if (!shares) return;
    applySharePreview(root, shares, Math.max(1, Math.floor(Number(total) || 0)), null);
}

/** 真实 DOM 事件委托（V1 用委托；无 addEventListener 的环境跳过） */
export function bindOverlay() {
    const el = overlayEl;
    const doc = docEl();
    if (!el) return false;
    if (typeof el.addEventListener === 'function' && !el.__fttBound) {
        el.__fttBound = true;
        el.addEventListener('click', async (e) => {
            const tg = e && e.target;
            // v2.42.0：先记一条**原始交互**（点到了什么、携带哪些 data-ftt-* 属性、当前页）——
            //   即使动作分发层判为未知/异常，也能看到用户到底点了什么（此前完全没有这条线索）。
            try {
                const dsx = (tg && tg.dataset) ? tg.dataset : {};
                const attrs = {};
                Object.keys(dsx).forEach((k) => { if (/^ftt/.test(k) && attrs && Object.keys(attrs).length < 12) attrs[k] = String(dsx[k]).slice(0, 60); });
                const tag = str0(tg && tg.tagName ? tg.tagName : '') || 'el';
                traceEvent({
                    // 级别 debug（而非 trace）：默认级别即可见 —— 「用户点了什么」是可追溯链的**起点**，缺它则后面全断
                    cat: 'ui', kind: 'click', level: 'debug',
                    detail: { target: tag, attrs, tab: ps.tab, sub: ps.settingsSub },
                    site: traceSite(),
                });
            } catch (err) { /* 追踪失败不影响交互 */ }
            // v2.38.0（对齐 V1 v1.206 26075~26078）：点在按钮/链接/动作元素上时阻止默认行为 ——
            //   `<a href="javascript:void(0)">` 的默认跳转与 form 内 `<button>` 的隐式提交都会让面板**跳顶**；
            //   仅对 `button, a, [data-ftt-action]` 生效，故不影响 `<label>` 内复选框等原生交互。
            try {
                const hit = tg && tg.closest ? tg.closest('button, a, [data-ftt-action]') : null;
                if (hit) { if (typeof e.preventDefault === 'function') e.preventDefault(); if (typeof e.stopPropagation === 'function') e.stopPropagation(); }
            } catch (err) { /* 忽略 */ }
            // 场景树折叠（V1 v1.206 26185 同款）：点 `▾` 纯 DOM 收起/展开其子树，**不触发重绘**
            try {
                const caret = (tg && tg.dataset && tg.dataset.fttSceneCaret !== undefined) ? tg
                    : ((tg && tg.closest) ? tg.closest('[data-ftt-scene-caret]') : null);
                if (caret && caret.dataset) {
                    const forPath = String(caret.dataset.fttSceneCaretFor || '');
                    const box = (el && typeof el.querySelector === 'function') ? el.querySelector('[data-ftt-scene-children="' + forPath + '"]') : null;
                    if (box && box.style) {
                        const hidden = box.style.display === 'none';
                        box.style.display = hidden ? '' : 'none';
                        try { caret.textContent = hidden ? '▾' : '▸'; } catch (e2) { /* 忽略 */ }
                    }
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    if (typeof e.stopPropagation === 'function') e.stopPropagation();
                    return;
                }
            } catch (err) { /* 折叠失败不影响其它交互 */ }
            const tabEl = tg && tg.closest ? tg.closest('[data-ftt-tab]') : null;
            if (tabEl) { void panelAction('tab', { tab: tabEl.getAttribute('data-ftt-tab') }); return; }
            // 动作元素解析：点在内层元素（如按钮里的 <span>/<b>）时回退到最近的 `[data-ftt-action]` 宿主
            const actEl = (tg && typeof tg.dataset === 'object' && tg.dataset && tg.dataset.fttAction)
                ? tg : ((tg && tg.closest) ? tg.closest('[data-ftt-action]') : null);
            const ds = (actEl && actEl.dataset) ? actEl.dataset : (tg && tg.dataset ? tg.dataset : {});
            const act = String(ds.fttAction || '');
            // ── v2.94.0（D9 **U4**）：**危险动作必须二次确认**（清单固定，见 `DANGER_ACTION_PROMPTS`）──
            //   放在**所有分支之前**：确认被取消时直接返回（**取消不产生任何副作用**）。
            //   确认框统一走 `confirmDialog`（宿主 hooks.confirm → 酒馆 callGenericPopup → 原生 confirm →
            //   无对话框能力即按「取消」，与 V1 的 confirm 口径一致）。
            //   注意：这里只拦**用户真实点击**；程序化调用 `panelAction()`（命令 / devtools / 测试）不受影响。
            // v2.96.0（用户报告「总览的可点击单楼分析，点击没任何反应」）：单楼分析是**长耗时**动作
            //   （要等一次 AI 生成，通常数秒到数十秒）→ 点击后**立刻**给按钮叠加「分析中」转圈态并禁用
            //   （V1 v1.38 的 `btn.classList.add('ftt-loading'); btn.disabled = true; btn.title = '分析中…'` 同款；
            //   样式 `#ftt-panel .ftt-floor-btn.ftt-loading` 早已在 `style.css` 里，V2 一直没接上 → 白留）。
            //   动作结束时 `finalizePanelAction()` 会重绘，节点被替换即自然复原。
            if (act === 'summaryFloor' && actEl) {
                try {
                    if (actEl.classList && actEl.classList.add) actEl.classList.add('ftt-loading');
                    actEl.disabled = true;
                    actEl.title = '分析中…（等本次 AI 返回；结果会写回记忆并刷新本页）';
                } catch (e) { /* 忽略 */ }
            }
            if (DANGER_ACTION_PROMPTS[act]) {
                const go = await confirmDialog(DANGER_ACTION_PROMPTS[act], 'FTT 危险操作确认');
                if (!go) return;
            }
            if (!act) {
                // ── 修复（v2.34.0）：「属性型」控件没有 `data-ftt-action`，此前被下面的 `!act → return` 直接吞掉，
                //    导致**设定子标签 / 情节子标签（情节列表·分段总结）点击无效**。
                //    这些控件在 V1 里同样是无 action 的 `<a>`，靠 dataset 分发；现统一在 `!act` 分支内先处理。
                //    v2.80.0：记忆子标签（列表·关系表·约束自查）已移除，新增「约束」页的维度切换（`data-ftt-cdim`）。
                if (ds && Object.keys(ds).length) {
                    if (ds.fttSubtab !== undefined) { void panelAction('settingsSub', { sub: String(ds.fttSubtab || '') }); return; }
                    if (ds.fttCdim !== undefined) { void panelAction('constraintDim', { dim: String(ds.fttCdim || '') }); return; }
                    if (ds.fttAsub !== undefined) { void panelAction('atomSub', { sub: String(ds.fttAsub || '') }); return; }
                    if (ds.fttSettings !== undefined) { void panelAction('settingsSub', { sub: String(ds.fttSettings || '') }); return; }   // 旧标记兼容
                }
                if (tg === el) void panelAction('close', {});
                return;
            }
            // v2.45.0 修复（用户报告「＋黑名单按钮功能」）：`kind` 必须兼容 **`data-ftt-kind`** ——
            //   投喂标签「＋白/＋黑」与调试页时间线类别筛选按钮用的都是 V1 同款 `data-ftt-kind`，
            //   而这里此前只读 `data-kind` → `kind` 恒为空串 → 点「＋黑」被 `feedScanAction` 归一为 `white`
            //   （**实际加进了白名单**）、点类别筛选恒为「全部」（点了没反应）。V1 的 `rxAddTag` 直接读 `ds.fttKind`。
            const kind = ds.kind || ds.fttKind || '';
            const id = ds.id || '';
            const floor = ds.fttFloor || '';
            const subject = ds.fttSubject || '';
            if (act === 'save') {
                void panelAction('save', { kind, id, fields: collectEditorFields(el) });
                return;
            }
            const cdim = String(ds.fttCdim || '');
            if (cdim) { void panelAction('constraintDim', { dim: cdim }); return; }
            if (ds.fttAsub !== undefined) { void panelAction('atomSub', { sub: ds.fttAsub }); return; }
            if (String(act).indexOf('snap') === 0) {
                void panelAction(act, { snapId: ds.fttSnapId || '' });
                return;
            }
            if (String(act).indexOf('prompt') === 0 || act === 'armorPresetImport') {
                void panelAction(act, {
                    promptKey: ds.fttPromptKey || '',
                    group: ds.fttPromptGroup || '',
                });
                return;
            }
            if (act === 'settingsSub') {
                void panelAction('settingsSub', { sub: ds.fttSettings || '' });
                return;
            }
            if (act === 'multiToggle' || act === 'selectAll' || act === 'selectNone' || act === 'bulkDelete' || act === 'searchClear' || act === 'add') {
                void panelAction(act, { kind: kind || ds.fttKind || ps.tab, id, searchKind: ds.fttSearchKind || '', subject });
                return;
            }
            // v2.41.0：**动作入参全量透传** —— 此前这里只传 7 个键，导致「控件带了参数、动作却读不到」的按钮
            //   **点了没反应**（用户报告的「大量异常点」）：投喂标签「＋白/＋黑」缺 `tag`、注入自查「关键词/全量」缺 `mode`、
            //   NSFW 词条「💾 保存 / 🗑 删除」缺 `idx`、NSFW 规则行缺 `from/to/row`。此处按属性逐一映射（缺省空串）。
            void panelAction(act, {
                kind, id, floor, subject,
                summary: ds.fttSummary || '',
                // B9-b：「👥 选角色」追加行需要角色名与编辑器作用域标记（V1 `data-ftt-name` / `data-ftt-editor`）；
                //   行内删除按钮用 `data-ftt-rel-idx`（V1 用 `el.closest` 反查，V2 由拖出的索引直接给出）
                name: String(ds.name || ''),
                editor: String(ds.editor || ''),
                idx: (ds.fttIdx !== undefined) ? ds.fttIdx : ((ds.relIdx !== undefined) ? ds.relIdx : ''),
                index: (ds.fttIdx !== undefined) ? ds.fttIdx : '',
                relIdx: (ds.relIdx !== undefined) ? ds.relIdx : '',
                tag: ds.fttTag || '',
                mode: ds.fttMode || '',
                from: (ds.fttNsfwRuleFrom !== undefined) ? ds.fttNsfwRuleFrom : '',
                to: (ds.fttNsfwRuleTo !== undefined) ? ds.fttNsfwRuleTo : '',
                row: (ds.fttNsfwRuleRow !== undefined) ? ds.fttNsfwRuleRow : '',
                dim: ds.fttDim || '',
                refId: (ds.fttRefId !== undefined) ? ds.fttRefId : id,
                key: ds.fttPromptKey || ds.fttKey || '',
                box: ds.fttPromptBox || '',
                pick: ds.fttRelPick || '',
                // v2.58.0：向量层区块与「提取记忆」层测试的入参（`data-ftt-api-pfx` / `data-ftt-api-kind` / `data-ftt-layer`）
                apiPfx: ds.fttApiPfx || '',
                apiKind: ds.fttApiKind || '',
                layer: ds.fttLayer || '',
                // v2.94.0：数据管理「✂️ 删除聊天楼层」三档的保留层数（`data-ftt-keep="6|10|12"`）
                keep: (ds.fttKeep !== undefined) ? ds.fttKeep : '',
            });
        });
        if (typeof el.addEventListener === 'function') {
            // v2.84.0：滚动条拖动时**实时刷新读数**（写配置与重绘留到 change/松手，避免拖动过程抖动与频繁落盘）
            // v2.85.0：占比滚动条与总上限滚动条额外做**实时联动**（其余占比 / 各维条数 / 保底文字 / 合计行同步变化）
            el.addEventListener('input', (e) => {
                try {
                    const tg = e && e.target;
                    if (!tg || !tg.dataset || String(tg.type) !== 'range') return;
                    const ds2 = tg.dataset || {};
                    if (ds2.fttShare === undefined && ds2.fttCfg === undefined) return;
                    const box = (tg.closest && tg.closest('.ftt-field-range')) || el;
                    const sel = (ds2.fttShare !== undefined)
                        ? ('[data-ftt-share-out="' + ds2.fttShare + '"]')
                        : ('[data-ftt-range-out="' + ds2.fttCfg + '"]');
                    const out = (box && typeof box.querySelector === 'function') ? box.querySelector(sel) : null;
                    if (out) {
                        const num = Number(tg.value);
                        const isPct = String(ds2.fttCfg || '') === 'storage.worldbookProbability';
                        out.textContent = isPct ? (Math.round(num) + '%') : String(Math.round(num * 1000) / 1000);
                    }
                    // v2.85.0：占比滚动条 → 其余维度**当场**等比联动（基准占比在本次拖动首次 input 时快照）
                    if (ds2.fttShare !== undefined) { shareDragInput(el, tg); return; }
                    // v2.85.0：总上限滚动条 → 各维条数与保底文字当场跟着变（占比不变）
                    if (String(ds2.fttCfg) === 'storeTotalMax') { shareTotalInput(el, Number(tg.value)); }
                } catch (err) { /* 读数刷新失败不影响拖动 */ }
            });
            el.addEventListener('change', (e) => {
                const tg = e && e.target;
                if (!tg || !tg.dataset) return;
                // v2.42.0：控件变更入流（键 + 旧值 → 新值）——「设置改了什么」也能追溯
                try {
                    const dsx = tg.dataset || {};
                    const key = str0(dsx.fttCfg || dsx.fttV2 || dsx.fttSearch || dsx.fttSelect || dsx.fttDim || dsx.fttDimPreset || dsx.fttModelSelect || dsx.fttRelWho || '');
                    const raw = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value);
                    const prev = (key && typeof readControlValue === 'function') ? readControlValue(key) : undefined;
                    traceEvent({
                        cat: 'ui', kind: 'change:' + (key || '(匿名控件)'), level: 'debug',
                        detail: { key, from: prev, to: raw, tab: ps.tab, sub: ps.settingsSub },
                        site: traceSite(),
                    });
                } catch (err) { /* 追踪失败不影响交互 */ }
                if (tg.dataset.fttSearch !== undefined) {
                    // B9-b：「👥 选角色」面板的搜索框与列表页搜索同名属性（V1 `data-ftt-search="relPick"`）→ 分流到选择器搜索词
                    if (String(tg.dataset.fttSearch) === 'relPick') { void panelAction('relPickQuery', { q: tg.value }); return; }
                    // B9-c：货币「👥 指定角色」选择器的搜索框（V1 `data-ftt-search="currencyTrackPick"`）沿用**页面搜索词槽**
                    //   （V2 = `ps.q['currencyTrackPick']`，与 V1 `pageSearchQuery['currencyTrackPick']` 同口径）
                    void panelAction('search', { kind: tg.dataset.fttSearch, q: tg.value });
                    return;
                }
                if (tg.dataset.fttRelWho !== undefined) { void panelAction('relWho', { who: tg.value }); return; }
                if (tg.dataset.fttLinkq !== undefined) { void panelAction('linkQuery', { q: tg.value }); return; }
                if (tg.dataset.fttShare !== undefined) { shareDrag = null; void panelAction('storeShare', { dim: tg.dataset.fttShare, value: tg.value }); return; }
                if (tg.dataset.fttV2 !== undefined) {
                    const k = String(tg.dataset.fttV2);
                    const raw = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value);
                    // 更新相关键写入**适配层设置**（updateConfig 读的是 settings；写内核 cfg 不会生效）
                    if (UPDATE_SETTING_KEYS.indexOf(k) >= 0 || UI_SETTING_KEYS.indexOf(k) >= 0) setSetting(k, raw);
                    else applySettingsControl(k, raw);
                    setNote('已更新 ' + k);
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttFilter !== undefined) {
                    // v2.62.0：列表筛选条（字段 / 排序 / 额外条件）——V1 同款标记 `data-ftt-filter` + `data-ftt-filter-key`
                    void panelAction('listFilter', {
                        kind: String(tg.dataset.fttFilter || ''),
                        key: String(tg.dataset.fttFilterKey || ''),
                        value: String(tg.value == null ? '' : tg.value),
                    });
                    return;
                }
                if (tg.dataset.fttDimPreset !== undefined) {
                    // v2.35.0：各维度 API 分组下拉（V1 `data-ftt-dim-preset`，v1.206 24570）
                    void panelAction('dimPreset', { kind: String(tg.dataset.fttDimPreset), preset: String(tg.value == null ? '' : tg.value) });
                    return;
                }
                if (tg.dataset.fttModelSelect !== undefined) {
                    // v2.35.0：V1 26224 是把选中值回填「模型输入框的 DOM」；V2 即时写回。
                    // v3.0.12 修复（用户报告「API 分组看到的是主线 API 的模型清单」）：
                    //   本分支此前**写死主 API 的模型键 `cfg.model`**。而 v2.79.0 起 Embedding / Rerank
                    //   区块各有自己的「选择模型」下拉（`data-ftt-cfg="embeddingModel"` / `"rerankModel"`）——
                    //   于是从区块下拉里选模型会**静默改写主 API 的模型**，而区块自己的模型键始终为空
                    //   → 区块恒报「未配置模型」，🧪 测试 恒失败（看起来像「向量 API 配置全不可用」）。
                    //   现改为写回**该控件自己的键**；无 `data-ftt-cfg` 的旧下拉（主 API）仍回落 `model`。
                    const mKey = String(tg.dataset.fttCfg || 'model');
                    const mVal = String(tg.value == null ? '' : tg.value);
                    applySettingsControl(mKey, mVal);
                    setNote('已选择模型 ' + mVal + (mKey === 'model' ? '' : ('（已写入 ' + mKey + '）')));
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttDim !== undefined) {
                    void panelAction('dimToggle', { kind: String(tg.dataset.fttDim), on: !!tg.checked });
                    return;
                }
                if (tg.dataset.fttCfg !== undefined) {
                    // 设定控件写回（V1 同款 `data-ftt-cfg`）：bool 用 checked，其余按原值类型写回
                    const key = String(tg.dataset.fttCfg);
                    let raw = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value);
                    // B9-c：投喂白/黑名单文本域在保存时**整表排重**（V1 `settingsApplyAll`：`rxDedupeTagList(wlTa.value.split('\n'))`）
                    if (isFeedTagKey(key)) raw = rxDedupeTagList(String(raw).split('\n'));
                    else if (typeof readControlValue(key) === 'number' && /^-?\d+(\.\d+)?$/.test(String(raw))) raw = Number(raw);
                    const applied = applySettingsControl(key, raw);
                    // v2.35.0：瞬态键（「分组名」「已存分组」）**不落配置也不重绘** —— V1 同样跳过它们
                    //   （v1.206 26280/26692），且重绘会清空用户正在输入的分组名。
                    if (applied && applied.transient) return;
                    // v2.85.0（用户要求：「保底数据应该被动联动…高于该数据则自动下移数字」）：
                    //   改「存储总上限」或任一「保底」后，把高于有效上限的保底**下移**到上限（只降不升）并落盘。
                    if (key === 'storeTotalMax' || key.indexOf('storeMin') === 0) {
                        const moved = (() => { try { return clampStoreFloors(); } catch (e) { return []; } })();
                        if (moved.length) {
                            try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
                            setNote('保底已随上限下移：' + moved.map((m) => m.label + ' ' + m.from + '→' + m.to).join(' / '));
                        }
                    }
                    // v2.65.0：「扩展设置抽屉卡片」开关立即生效（挂载 / 卸载抽屉卡片）
                    if (key === 'uiShowDrawer' && typeof hooks.showDrawer === 'function') { try { void hooks.showDrawer(raw); } catch (e) { /* 忽略 */ } }
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttLoc !== undefined) {
                    // v2.65.0（V1 v1.206 `settingsApplyAll` 同口径）：`data-ftt-loc="<入口>"` 写 `cfg.buttonLocations[<入口>]`
                    //   并**立即重建/移除**对应入口（扩展菜单项由宿主强制开启，配置里的关闭意图不生效）
                    const loc = String(tg.dataset.fttLoc || '');
                    const on = (tg.type === 'checkbox') ? !!tg.checked : String(tg.value == null ? '' : tg.value) !== '';
                    if (loc) applySettingsControl('buttonLocations.' + loc, on);
                    if (typeof hooks.syncEntries === 'function') { try { hooks.syncEntries(cfg.buttonLocations); } catch (e) { /* 忽略 */ } }
                    setNote('入口「' + loc + '」已' + (on ? '显示' : '隐藏'));
                    renderPanel();
                    return;
                }
                if (tg.dataset.fttSelect !== undefined) {
                    const k = String(tg.dataset.fttSelect);
                    const set = selOf(k);
                    if (tg.checked) set.add(String(tg.dataset.fttId || '')); else set.delete(String(tg.dataset.fttId || ''));
                }
            });
        }
    }
    try {
        const box = el.querySelector ? el.querySelector('[data-ftt-rel-body]') : null;
        if (box && typeof box.querySelectorAll === 'function') {
            for (const node of box.querySelectorAll('[data-ftt-relf]')) {
                node.addEventListener('change', () => {
                    try {
                        const body = String(box.getAttribute('data-ftt-rel-body') || '');
                        const [dim, refId] = body.split('|');
                        const rowEl = node.closest ? node.closest('[data-ftt-rel-idx]') : null;
                        const idx = Number((rowEl && rowEl.getAttribute('data-ftt-rel-idx')) || 0);
                        const field = String(node.getAttribute('data-ftt-relf'));
                        const val = (node.type === 'checkbox') ? !!node.checked : String(node.value == null ? '' : node.value);
                        relAction('relSetRow', { kind: dim, id: refId, idx, row: { [field]: val } });
                    } catch (e) { /* 忽略 */ }
                });
            }
        }
    } catch (e) { /* 关系表绑定失败不影响面板 */ }
    try { bindPanelEvents(); } catch (e) { /* 设置分页表单绑定 */ }
    return true;
}

/** Esc 关闭（V1 同款） */
export function bindEscClose() {
    if (escBound) return true;
    const doc = docEl();
    try {
        if (doc && typeof doc.addEventListener === 'function') {
            doc.addEventListener('keydown', (e) => { if (e && (e.key === 'Escape' || e.keyCode === 27)) closePanel(); });
            escBound = true;
        }
    } catch (e) { /* 忽略 */ }
    return escBound;
}

/** 卸载（disable / delete） */
export function unmountPanel() {
    stopPipelineTick();
    closePanel();
    const doc = docEl();
    try {
        const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(PANEL_ID) : null;
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
    } catch (e) { /* 忽略 */ }
    overlayEl = null;
    ps.open = false;
    return true;
}

/** 面板配置摘要（诊断） */
export function panelConfig() {
    return { id: PANEL_ID, tabs: PANEL_TABS.map((t) => t[0]), firstTab: cfg.uiFirstTab, dims: DIMENSIONS.length, floors: (() => { try { return Number(getLastMessageId()) + 1; } catch (e) { return 0; } })() };
}
