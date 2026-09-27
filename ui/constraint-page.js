// ============================================================
// ui/constraint-page.js —— 「设定 → 约束」子页（v2.80.0，用户要求）
//
// 用户要求：「记忆大类的关系表、关系约束放入设定-约束标签中」→ 把**四个维度**
//   （记忆 / 计划 / 悬念 / 平行事件）的「🔗 关系表」与「🧷 约束自查」集中到 **设定 → 约束**，
//   四个列表页只保留列表（不再有 关系表 / 约束自查 子标签）。
//
// 页内结构（自上而下）：
//   ① 维度切换条（`data-ftt-cdim`，页内可切维度；缺省「记忆」）
//   ② 关联统计 + 按角色筛选 + 「👥 选角色」选择器
//   ③ 关联总览（按条目聚合，V1 关系表总览口径；定位目标即使暂无关联也列出）
//   ④ 🧷 约束自查（`ui/inject-check.js`：注入约束段原样预览 + 未进注入的非公共信息）
//
// 与 V1 的差异（登记）：V1 把关系表挂在「记忆 / 计划悬念 / 平行」页的子标签下（`activeMemSub`），
//   维度由页面位置决定；V2 自 v2.80.0 起统一收到本页，维度改由**页内切换**承担（`REL_DIMS` 四项）。
//   `relFilterState().dim` 仍只作对照/诊断字段，不参与过滤（一屏只显示一个维度）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { entrySummary } from './console.js';
import {
    REL_DIMS, relStats, relByWho, relFilterState, relPickingOf, relPickPanelHtml, relDimLabelOf, howLabel,
} from './rel-table.js';
import { injectCheckPanelHtml } from './inject-check.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/**
 * 当前维度（页内状态）。缺省「记忆」；非法值一律回落第一项（与 V1 的 `activeMemSub` 归一同一口径）。
 * 状态由本模块持有（与 `ui/rel-table.js` 持有筛选态同构），面板只经 `setConstraintDim()` 读写。
 */
let constraintDim = REL_DIMS[0];
/** 当前维度（诊断/测试） */
export function constraintDimState() { return constraintDim; }
/** 设置当前维度（非法值回落记忆） */
export function setConstraintDim(v) {
    const k = String(v || '');
    constraintDim = (REL_DIMS.indexOf(k) >= 0) ? k : REL_DIMS[0];
    return constraintDim;
}

/** 条目摘要（按 id 取库内条目；四个关联维度都是规范容器键，无需 states→currentStates 映射） */
function entrySummaryById(dim, id) {
    try {
        const e = ((state[dim] || [])).filter((x) => x && String(x.id) === String(id))[0];
        return e ? entrySummary(e) : '（条目已不在库中）';
    } catch (e) { return ''; }
}

/**
 * 某维度的关联总览（按条目聚合，V1 关系表总览口径）。
 *   · 行上 `data-ftt-rel-entry="dim|refId"`（`relJump` 的 `scrollIntoView` 定位锚点）；
 *   · 「↗ 打开条目」（`relGoto`：打开该条目所在页并把该页搜索词设为条目标题）；
 *   · 「👥 选角色」（`relPick` → 面板 → `relPickAdd` 追加草稿行）+「💾 保存关联」（`relSave`）；
 *   · 定位目标（`relJump` 的 jump）**即使暂无关联也列出**（V1 `!rows.length && !jump` 的例外）；
 *   · 角色筛选在此过滤（V1 `whoQ` 只保留命中该角色的条目）。
 */
export function relOverviewHtml(dim) {
    const links = (() => { try { return Array.isArray(state.links) ? state.links : []; } catch (e) { return []; } })();
    const byRef = new Map();
    links.forEach((x) => {
        if (!x || String(x.dim) !== dim) return;
        const k = String(x.refId);
        if (!byRef.has(k)) byRef.set(k, []);
        byRef.get(k).push(x);
    });
    const fs = relFilterState();
    const whoQ = String(fs.who || '').trim().toLowerCase();
    const jump = (fs.jump && String(fs.jump.dim) === String(dim)) ? fs.jump : null;
    // 定位目标优先（即使库内无关联行），其余保持库内行序；沿用 V2 原有的 200 行上限（V1 无上限，此处保留 V2 护栏）
    const order = [];
    if (jump && !byRef.has(String(jump.id))) byRef.set(String(jump.id), []);
    if (jump) order.push(String(jump.id));
    for (const k of byRef.keys()) if (order.indexOf(k) < 0) order.push(k);
    const body = order.slice(0, 200).map((refId) => {
        const list = byRef.get(refId) || [];
        const people = list.filter((x) => x && x.who);
        if (whoQ && !people.some((x) => String(x.who || '').toLowerCase().indexOf(whoQ) >= 0)) return '';
        const isJump = !!(jump && String(jump.id) === refId);
        const who = people.map((x) => String(x.who) + '（' + howLabel(x.how) + '）').join('、');
        const pub = list.some((x) => x && x.public);
        const picking = relPickingOf(dim, refId, false);
        return '<div class="ftt-item ftt-inline" data-ftt-rel-entry="' + attr(dim + '|' + refId) + '"><span class="ftt-grow"><b>' + esc(entrySummary({ id: refId })) + '</b> <span class="ftt-muted">' + esc(entrySummaryById(dim, refId)) + '</span>'
            + (isJump ? ' <span class="ftt-badge ftt-badge--fact">🔗 定位</span>' : '')
            + '<div class="ftt-hint">' + (who ? esc(who) : '（仅幕后 / 未指定角色）') + (pub ? ' · 公共' : '') + (people.length ? '' : ' · 无关联 → 注入按保守口径回退') + '</div></span>'
            + '<a class="ftt-rel-jump" data-ftt-action="relGoto" data-kind="' + attr(dim) + '" data-id="' + attr(refId) + '" title="打开该条目所在页并把该页搜索词设为条目标题">↗ 打开条目</a>'
            + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="relPick" data-kind="' + attr(dim) + '" data-id="' + attr(refId) + '" data-editor="" title="从「角色」大类点名，直接追加一行关联角色">👥 选角色</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="relSave" data-kind="' + attr(dim) + '" data-id="' + attr(refId) + '">💾 保存关联</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="relEdit" data-kind="' + attr(dim) + '" data-id="' + attr(refId) + '">🔗 编辑</button>'
            + (picking ? relPickPanelHtml(dim, refId, false) : '')
            + '</div>';
    }).filter(Boolean).join('');
    if (!body) {
        return '<div class="ftt-empty">' + (jump ? '未找到定位的条目（可能已被删除）' : '（该维度暂无关联行）') + '</div>';
    }
    return body;
}

/** 维度切换条（页内切换；`data-ftt-cdim` 由面板 DOM 委托处理） */
function dimTabsHtml(cur) {
    return '<div class="ftt-row ftt-subtabs" data-ftt-cdims>' + REL_DIMS.map((d) =>
        '<a href="javascript:void(0)" class="ftt-subtab' + (d === cur ? ' ftt-on' : '') + '" data-ftt-cdim="' + attr(d) + '">🔗 ' + esc(relDimLabelOf(d)) + '</a>').join(' ')
        + '</div>';
}

/**
 * 「设定 → 约束」子页正文。
 * 只读渲染 + 既有动作（relGoto / relPick / relSave / relEdit / relWho / relClearFilter / checkRefresh / checkMode），
 * 新增动作只有维度切换 `constraintDim`。
 */
export function constraintPageHtml() {
    const dim = setConstraintDim(constraintDim);
    const st = relStats();
    const fs = relFilterState();
    const who = String(fs.who || '');
    const jump = (fs.jump && String(fs.jump.dim) === String(dim)) ? fs.jump : null;
    const byWho = who ? relByWho(who, [dim]) : [];
    const pickHtml = byWho.length
        ? ('<div class="ftt-hint">「' + esc(who) + '」在此维度的关联：' + esc(byWho.map((x) => (x.title + '（' + howLabel(x.how) + '）')).join('、')) + '</div>')
        : '';
    const filterBits = [];
    if (who) filterBits.push('角色含「' + who + '」');
    if (jump) filterBits.push('定位 ' + relDimLabelOf(jump.dim) + '「' + String(jump.title || '').slice(0, 20) + '」');
    const filterHtml = filterBits.length
        ? ('<div class="ftt-hint">当前筛选：' + esc(filterBits.join(' · ')) + ' <a class="ftt-rel-jump" data-ftt-action="relClearFilter">清除筛选</a></div>')
        : '';
    const rel = [
        '<div class="ftt-section" data-ftt-section="constraint-rel">',
        '<div class="ftt-sec-title">🔗 关系表 <span class="ftt-muted">谁知道 / 谁相关</span></div>',
        dimTabsHtml(dim),
        '<div class="ftt-hint">关联 = 这条' + esc(relDimLabelOf(dim)) + '「谁知道 / 谁相关」；未列出的角色一律视为不知情（约束段据此点名）。</div>',
        '<div class="ftt-hint">关联行合计 ' + st.total + '（' + REL_DIMS.map((d) => (relDimLabelOf(d) + ' ' + (st.byDim[d] || 0))).join(' · ') + '）'
        + ' · 推定 ' + st.inferred + ' · 孤儿 ' + st.orphan + ' · 公共 ' + st.publics + '</div>',
        '<div class="ftt-field"><label>按角色筛选</label><input type="text" data-ftt-rel-who="1" value="' + attr(who) + '" placeholder="角色名（回车）"></div>',
        pickHtml,
        filterHtml,
        '<div class="ftt-hint">点条目行的 ✏️ 打开编辑器后可编辑关联；下方为按条目聚合的 <b>关联总览</b>。</div>',
        '<div class="ftt-rel-overview">' + relOverviewHtml(dim) + '</div>',
        '</div>',
    ].join('\n');
    const check = [
        '<div class="ftt-section" data-ftt-section="constraint-check">',
        '<div class="ftt-sec-title">🧷 约束自查 <span class="ftt-muted">本轮注入了什么 / 为什么别的没进去</span></div>',
        injectCheckPanelHtml(),
        '</div>',
    ].join('\n');
    return rel + '\n' + check;
}
