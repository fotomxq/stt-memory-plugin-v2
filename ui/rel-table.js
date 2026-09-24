// ============================================================
// ui/rel-table.js —— **关系表层**（对齐 V1 `12B-UI-关系表.js` / `relEditorTableHtml` / `relRowHtml` / `relSaveBox`）
// 用途：记忆 / 计划 / 悬念 / 平行事件的「谁知道 / 谁相关」总览与编辑（通用知情关联层 `state.links`）。
// 动作与 V1 同名：`relAddRow`（行内新增，未保存前只在草稿里）、`relRowDel`、`relSave`（落库）、
//   `relSweep`（孤儿关联清扫）、`relDropInferred`（清除「推定」写入的关联，不动人工/AI 行）、`relClearEntry`。
// 写入口径与 V1 一致：`upsertRelLinks(dim, refId, rows)`（返回 `{added, updated, removed}`）+ `saveState()`；
//   删除行留墓碑（`tombEntries`），避免跨端复活。
// 与 V1 的差异（登记）：V1 的编辑是「DOM 行 + 保存时读 DOM」，V2 用**草稿数组**（`relDrafts`）承载未保存行，
//   真实 DOM 由 `bindRelTable()` 把输入写回草稿；这样无 DOM 环境（测试/极简宿主）也能完整驱动。
//
// ------------------------------------------------------------
// B9-b 追加：关系表「双向定位跳转」+「👥 选角色」选择器（V1 v1.166 / v1.194 同名能力）
//   · V1 `relJump`（条目行「🔗」→ 切到关系表页并定位该条目）/ `relGoto`（关系表行 → 打开条目所在页并把
//     该页搜索词设为条目标题）/ `relClearFilter`（清筛选）；
//   · V1 `relPick` / `relPickClose` / `relPickAdd` + 辅助 `relPickAppendRow` / `relPickPanelHtml` /
//     `relPickState` / `setRelPick` / `relKnownNames` / `relFindEntryId` / `relEntryTitle`；
//   · V2 把 V1 写在 `handleAction` case 里的**状态迁移**抽成本模块的可导出函数（`relJump` / `relGoto` /
//     `relClearFilter`），面板只施加导航副作用（切页 / 切子标签 / 设搜索词 / 重绘）——行为序与 V1 逐行一致，
//     并以 `tests/fixtures/v1-golden-rel-nav.json` 的真实 V1 动作序 oracle 断言。
//   · **V2 收窄（已在 docs/P8-功能对齐总表.md §6 记录）**：V1 的「维度筛选」（`data-ftt-relfilter="dim"`）在 V2
//     语义下不适用 —— V2 的关系表按**分页**隔离维度（`ui/panel.js#REL_TABDS`，一页只显示一个维度），
//     故 `relFilterState().dim` 仅保留字段（供 V1 口径对照与诊断），**不参与过滤**；`relClearFilter` 实际清空
//     「角色筛选 + 跳转定位 + 选角色态」。
//   · **签名适配（登记）**：V1 `relPickAppendRow(box, dim, name)` 的首参是 DOM 容器；V2 无 DOM 容器，
//     改为 `relPickAppendRow(dim, refId, name, opts)`（`refId` 承载行容器，`opts.editor` 表示编辑器作用域）。
//     三态返回值语义与 V1 相同：`true` 成功 / `'dup'` 重复角色 / `false` 容器缺失或参数非法。
// ============================================================
import { state, cfg, saveState, warn } from '../core/model/runtime.js';
import { relLinksOf } from '../core/model/rel.js';
import { upsertRelLinks, sweepOrphanRelLinks, dropRelLinks } from '../core/entries.js';
import { tombEntries } from '../core/merge.js';
import { snapNameKey } from '../core/util.js';

/** 可编辑关系的维度（V1 `REL_LINK_DIMS`：记忆 / 计划 / 悬念 / 平行事件） */
export const REL_DIMS = Object.freeze(['memories', 'plans', 'suspense', 'parallels']);

/** 知情方式选项（V1 `relHowOptions`：平行事件只有「相关」，其余为完整知情方式） */
export const REL_HOW = Object.freeze({
    parallels: [{ v: 'related', t: '相关（角色不知情）' }],
    default: [
        { v: 'participant', t: '亲历' }, { v: 'witness', t: '目击' }, { v: 'told', t: '被告知' },
        { v: 'inferred', t: '推断' }, { v: 'rumor', t: '传闻' }, { v: 'unspecified', t: '知情' },
        { v: 'author', t: '策划/主导' }, { v: 'join', t: '参与' }, { v: 'involved', t: '当事人' },
        { v: 'investigating', t: '在查' },
    ],
});
const HOW_CN = { participant: '亲历', witness: '目击', told: '被告知', inferred: '推断', rumor: '传闻', unspecified: '知情', author: '策划', join: '参与', involved: '当事人', investigating: '在查', related: '相关' };
const HOW_ORDER = ['author', 'involved', 'participant', 'witness', 'join', 'investigating', 'told', 'inferred', 'rumor', 'unspecified', 'related'];

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/** 关系层是否启用（V1：设定 → 分析记忆 → 关联层总开关） */
export function relLayerOn() { try { return cfg.relLayerEnabled !== false; } catch (e) { return true; } }
/** 中文方式名（诊断/摘要用） */
export function howLabel(how) { return HOW_CN[String(how || 'unspecified')] || String(how || '知情'); }
/** 维度中文名 */
function dimLabel(dim) {
    return ({ memories: '记忆', plans: '计划', suspense: '悬念', parallels: '平行事件' })[String(dim)] || String(dim);
}
/** 维度中文名（V1 `relDimLabelOf` 同名；选择器标题与筛选提示用） */
export function relDimLabelOf(dim) { return dimLabel(dim); }
/** 是否为可编辑关系维度（V1 `relIsRelDim`） */
export function relIsRelDim(kind) { try { return REL_DIMS.indexOf(String(kind)) >= 0; } catch (e) { return false; } }
/** 引用条目是否存在（V1 relLinkDimOk + 目标存在判定） */
function entryExists(dim, refId) {
    try { return ((state && state[dim]) || []).some((x) => x && String(x.id) === String(refId)); } catch (e) { return false; }
}
/** 条目标题（未召回清单展示用） */
function entryTitle(dim, refId) {
    try {
        const e = ((state && state[dim]) || []).filter((x) => x && String(x.id) === String(refId))[0];
        if (!e) return String(refId);
        return String(e.title || e.content || e.text || e.name || refId).replace(/\s+/g, ' ').slice(0, 40);
    } catch (e) { return String(refId); }
}

/** 未保存的编辑草稿：`${dim}|${refId}` → rows（V1 的 DOM 行等价物） */
const relDrafts = new Map();
const draftKey = (dim, refId) => String(dim) + '|' + String(refId);

/** 当前行（优先草稿，其次库） */
export function relRowsOf(dim, refId, opts) {
    const o = opts || {};
    const k = draftKey(dim, refId);
    if (!o.fresh && relDrafts.has(k)) return relDrafts.get(k).map((r) => Object.assign({}, r));
    try { return (relLinksOf(String(dim), String(refId)) || []).map((r) => Object.assign({}, r)); } catch (e) { return []; }
}
/** 是否存在未保存改动 */
export function relDirty(dim, refId) { return relDrafts.has(draftKey(dim, refId)); }
/** 丢弃草稿（放弃编辑） */
export function relDiscard(dim, refId) { relDrafts.delete(draftKey(dim, refId)); return true; }

/** 行 HTML（V1 `relRowHtml` 的结构与类名；平行为「相关」只读） */
function relRowHtml(dim, row, idx) {
    const who = String((row && row.who) || '');
    const how = String((row && row.how) || (String(dim) === 'parallels' ? 'related' : 'unspecified'));
    const isPar = String(dim) === 'parallels';
    const howCell = isPar
        ? '<span class="ftt-muted">相关</span>'
        : ('<select data-ftt-relf="how">' + (REL_HOW.default).map((o) => '<option value="' + attr(o.v) + '"' + (o.v === how ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('') + '</select>');
    const isPublic = !!(row && row.public);
    return '<tr data-ftt-rel-row data-ftt-rel-idx="' + attr(idx) + '">'
        + '<td class="ftt-rel-role"><input class="ftt-rel-who" data-ftt-relf="who" value="' + attr(who) + '" placeholder="角色名"></td>'
        + '<td>' + howCell + '</td>'
        + '<td><label class="ftt-switch"><input type="checkbox" data-ftt-relf="public"' + (isPublic ? ' checked' : '') + '><span class="ftt-slider"></span></label></td>'
        + '<td><input class="ftt-rel-w-who" data-ftt-relf="from" value="' + attr(String((row && row.from) || '')) + '" placeholder="' + (how === 'told' ? '告知者' : '—') + '"></td>'
        + '<td><input class="ftt-rel-w-date" data-ftt-relf="at" value="' + attr(String((row && row.at) || '')) + '" placeholder="YYYY-MM-DD"></td>'
        + '<td><input data-ftt-relf="note" value="' + attr(String((row && row.note) || '')) + '" placeholder="备注"></td>'
        + '<td><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="relRowDel" data-ftt-rel-idx="' + attr(idx) + '">🗑</button></td>'
        + '</tr>';
}

/**
 * 关系表 HTML（V1 `relEditorTableHtml` 的表头 + 工具行 + 行；含 `data-ftt-rel-body` 容器名）
 * B9-b 追加：V1 编辑器关系表的「👥 选角色」按钮 + 面板（`opts.editor` = 编辑器作用域）。
 * V2 差异（登记）：V1 编辑器容器键是 `dim|editor`，V2 统一用 `dim|refId`（草稿槽就是条目引用）；
 *   选择器面板的键仍与 V1 一致（编辑器 = `dim|editor`）。
 */
export function relTableHtml(dim, refId, opts) {
    const d = String(dim), r = String(refId);
    const o = opts || {};
    const isEd = !!o.editor;
    const on = relLayerOn();
    const rows = relRowsOf(d, r);
    const body = 'data-ftt-rel-body="' + attr(d + '|' + r) + '"';
    if (!on) {
        return '<div class="ftt-empty">通用知情关联层已关闭（设定 → 分析记忆 → 关联层总开关 `relLayerEnabled`）：不再读写关联行。</div>';
    }
    const head = '<tr><th>角色</th><th>知情方式</th><th>公共</th><th>来源</th><th>日期</th><th>备注</th><th></th></tr>';
    const picking = relPickingOf(d, r, isEd);
    return '<div class="ftt-rel-box" ' + body + '>'
        + '<div class="ftt-hint">关联 = 这条' + esc(dimLabel(d)) + '「谁知道 / 谁相关」；未列出的角色一律视为不知情（约束段据此点名）。</div>'
        + '<table class="ftt-rel-table"><thead>' + head + '</thead><tbody>' + rows.map((row, i) => relRowHtml(d, row, i)).join('') + '</tbody></table>'
        + '<div class="ftt-toolbar ftt-rel-tools">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="relPick" data-kind="' + attr(d) + '" data-id="' + attr(r) + '" data-editor="' + (isEd ? '1' : '') + '" title="从「角色」大类点名，直接追加一行关联角色">👥 选角色</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relAddRow" data-kind="' + attr(d) + '" data-id="' + attr(r) + '">➕ 添加行</button>'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="relSave" data-kind="' + attr(d) + '" data-id="' + attr(r) + '">💾 保存关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relClearEntry" data-kind="' + attr(d) + '" data-id="' + attr(r) + '">🧹 清空该条目关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relSweep">🧽 清扫孤儿关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relDropInferred">🚫 清除「推定」关联</button>'
        + '<span class="ftt-muted">' + (relDirty(d, r) ? '（有未保存改动）' : '（已同步）') + '</span>'
        + '</div>'
        + (picking ? relPickPanelHtml(d, r, isEd) : '')
        + '</div>';
}

/**
 * 关系表动作（唯一入口；V1 同名）。
 * @param {string} action relAddRow | relRowDel | relSetRow | relSave | relSweep | relDropInferred | relClearEntry | relDiscard
 * @param {object} [payload] {kind|dim, id|refId, row, idx, rows}
 * @returns {object} 结果（含渲染后的 HTML 供调用方写入）
 */
export function relAction(action, payload) {
    const p = payload || {};
    const d = String(p.kind || p.dim || '');
    const r = String(p.id || p.refId || '');
    const a = String(action || '');
    let result = { ok: true, action: a, dim: d, refId: r };
    try {
        // 维度无关动作先处理（V1 的 relSweep / relDropInferred 不需要 kind/id）
        if (a === 'relSweep') {
            let n = 0;
            try { n = sweepOrphanRelLinks() || 0; } catch (e) { n = 0; }
            if (n) { try { saveState(); } catch (e) { /* 忽略 */ } }
            return Object.assign(result, { ok: true, swept: n, html: '' });
        }
        if (a === 'relDropInferred') {
            const arr = Array.isArray(state.links) ? state.links : [];
            const gone = arr.filter((x) => x && /推定/.test(String(x.note || '')));
            if (gone.length) {
                try { tombEntries('links', gone); } catch (e) { /* 墓碑失败不阻塞 */ }
                state.links = arr.filter((x) => !(x && /推定/.test(String(x.note || ''))));
                try { saveState(); } catch (e) { /* 忽略 */ }
            }
            return Object.assign(result, { ok: true, dropped: gone.length, html: '' });
        }
        if (!REL_DIMS.includes(d)) { result = { ok: false, reason: 'dim-not-supported', dim: d }; return result; }
        if (!relLayerOn()) { result = { ok: false, reason: 'layer-off', dim: d }; return result; }
        const k = draftKey(d, r);
        const cur = relRowsOf(d, r);
        if (a === 'relAddRow') {
            cur.push({ who: '', how: d === 'parallels' ? 'related' : 'unspecified' });
            relDrafts.set(k, cur);
            result = Object.assign(result, { ok: true, rows: cur.length });
        } else if (a === 'relRowDel') {
            const idx = Number(p.idx);
            if (Number.isFinite(idx) && idx >= 0 && idx < cur.length) { const gone = cur.splice(idx, 1)[0]; relDrafts.set(k, cur); result = Object.assign(result, { ok: true, removed: gone }); }
            else result = { ok: false, reason: 'bad-index' };
        } else if (a === 'relSetRow') {
            const idx = Number(p.idx);
            if (!Number.isFinite(idx) || idx < 0 || idx >= cur.length) result = { ok: false, reason: 'bad-index' };
            else { cur[idx] = Object.assign({}, cur[idx], p.row || {}); relDrafts.set(k, cur); result = Object.assign(result, { ok: true, row: cur[idx] }); }
        } else if (a === 'relDiscard') {
            relDiscard(d, r);
        } else if (a === 'relSave') {
            const rows = Array.isArray(p.rows) ? p.rows : cur;
            const clean = rows.filter((x) => x && String(x.who || '').trim());   // V1：空角色名行不落库
            let r1 = { added: 0, updated: 0, removed: 0 };
            // V1 `relSaveBox`：以「当前行集合」为全集 → `{ replace: true }`（删除的行才会真正移除）
            try { r1 = upsertRelLinks(d, r, clean.map((x) => Object.assign({}, x, { who: String(x.who).trim() })), { replace: true }) || r1; } catch (e) { warn('关系保存失败', e); }
            relDiscard(d, r);
            // V1 `case 'relSave'`：保存后关闭「👥 选角色」面板（`relPickRef = null`）
            setRelPick(null);
            try { saveState(); } catch (e) { /* 落盘失败不抛 */ }
            result = Object.assign(result, { ok: true, saved: clean.length, added: Number(r1.added) || 0, updated: Number(r1.updated) || 0, removed: Number(r1.removed) || 0, skipped: rows.length - clean.length });
        } else if (a === 'relClearEntry') {
            // V1：`dropRelLinks(kind,[id])` —— 清空该条目全部关联并**留墓碑**（跨端不复活）
            let n = 0;
            try { n = dropRelLinks(d, [r]) || 0; } catch (e) { n = 0; }
            relDiscard(d, r);
            if (n) { try { saveState(); } catch (e) { /* 忽略 */ } }
            result = Object.assign(result, { ok: true, cleared: n });
        } else {
            result = { ok: false, reason: 'unknown-action' };
        }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
    const html = REL_DIMS.includes(d) ? relTableHtml(d, r) : '';
    return Object.assign(result, { html });
}

/** 关系层统计（面板角标 / 诊断） */
export function relStats() {
    try {
        const arr = Array.isArray(state.links) ? state.links : [];
        const byDim = {};
        REL_DIMS.forEach((d) => { byDim[d] = 0; });
        let inferred = 0, orphan = 0, publics = 0;
        for (const x of arr) {
            if (!x) continue;
            const d = String(x.dim);
            if (byDim[d] !== undefined) byDim[d] += 1;
            if (/推定/.test(String(x.note || ''))) inferred += 1;
            if (x.public) publics += 1;
            if (REL_DIMS.includes(d) && !entryExists(d, String(x.refId))) orphan += 1;
        }
        return { total: arr.length, byDim, inferred, orphan, publics, enabled: relLayerOn() };
    } catch (e) { return { total: 0, byDim: {}, inferred: 0, orphan: 0, publics: 0, enabled: relLayerOn() }; }
}

/** 某角色的关联总览（V1 关系表「按角色」筛选）：返回 [{dim, refId, how, title}] */
export function relByWho(who, dims) {
    const w = String(who || '').trim();
    if (!w) return [];
    const list = Array.isArray(dims) && dims.length ? dims : REL_DIMS.slice();
    const out = [];
    try {
        for (const d of list) {
            const arr = Array.isArray(state.links) ? state.links : [];
            for (const x of arr) {
                if (!x || String(x.dim) !== d) continue;
                if (String(x.who || '') !== w) continue;
                out.push({ dim: d, refId: String(x.refId), how: String(x.how || 'unspecified'), title: entryTitle(d, String(x.refId)), public: !!x.public });
            }
        }
    } catch (e) { /* 忽略 */ }
    return out.sort((a, b) => HOW_ORDER.indexOf(a.how) - HOW_ORDER.indexOf(b.how));
}

// ============================================================
// B9-b：定位跳转态 +「👥 选角色」选择器（V1 v1.166 / v1.194 同名能力）
// ============================================================

/** 维度 → 条目所在分页（V1 `relGoto` 的 `tabOf` 映射：悬念与计划共用「计划悬念」页） */
export const REL_TAB_OF = Object.freeze({ memories: 'memories', currencies: 'currencies', plans: 'plans', suspense: 'plans', parallels: 'parallels' });

/** 跳转定位引用：`{ dim, id, title }`（V1 `relJumpRef`） */
let relJumpRef = null;
/** 选角色引用：`{ dim, id, editor }`（V1 `relPickRef`） */
let relPickRef = null;
/** 维度筛选（V1 `relFilterDim`）—— **V2 收窄：不参与过滤**（页面即维度），仅保留字段供对照/诊断 */
let relFilterDim = 'all';
/** 角色筛选（V1 `relFilterWho`）—— V2 由本模块持有（面板读 `relFilterState().who`） */
let relFilterWho = '';
/** 选角色面板搜索词（V1 `pageSearchQuery['relPick']`；V1 不清除 → 跨次保留，此处同样保留） */
let relPickQuery = '';

/** 条目显示名（V1 `relEntryTitle`：标题+正文按「：」拼接、60 字截断） */
export function relEntryTitle(dim, it) {
    // V1 原样：`dim` 参数未参与计算（保留形参以对齐签名）
    if (!it) return '';
    const t = String(it.title || '').trim();
    const c = String(it.content || it.text || '').trim();
    const s = (t && c && t !== c) ? (t + '：' + c) : (t || c);
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

/** 保存后按「id 优先、否则标题+正文精确匹配（自后向前）」定位条目 id（V1 `relFindEntryId` 原样） */
export function relFindEntryId(dim, raw) {
    try {
        const list = (state && state[dim]) || [];
        const id0 = String((raw && raw.id) || '');
        if (id0 && list.some((x) => x && String(x.id) === id0)) return id0;
        const content = String((raw && (raw.content || raw.text)) || '').trim();
        const title = String((raw && (raw.title || raw.name)) || '').trim();
        if (!content && !title) return '';
        const hit = list.slice().reverse().find((x) => x
            && (!content || String(x.content || '').trim() === content)
            && (!title || String(x.title || '').trim() === title));
        return hit ? String(hit.id) : '';
    } catch (e) { return ''; }
}

/**
 * 已知角色名（V1 `relKnownNames`：**只读角色档案**，不遍历四个关联维度）。
 * V1 的第二来源 `knownCharacterNames()` 本身也只遍历 `state.snapshots`，故两边结果一致（名单顺序 = 档案顺序去重）。
 */
export function relKnownNames() {
    const out = [];
    const push = (nm) => {
        const t = String(nm == null ? '' : nm).trim();
        if (t && out.indexOf(t) < 0) out.push(t);
    };
    try { for (const s of ((state && state.snapshots) || [])) push(s && s.name); } catch (e) { /* 忽略 */ }
    // V1 的第二来源 `knownCharacterNames()` 自身也只遍历 `state.snapshots`（V1 v1.206:8851）→ V2 不另设来源，名单等价。
    return out;
}

/** 选择器开关状态（V1 `relPickState`：返回副本） */
export function relPickState() { return relPickRef ? Object.assign({}, relPickRef) : null; }
/** 设置/清空选择器开关（V1 `setRelPick`：dim/id 字符串化、editor 布尔化） */
export function setRelPick(ref) {
    relPickRef = ref ? { dim: String(ref.dim || ''), id: String(ref.id == null ? '' : ref.id), editor: !!ref.editor } : null;
    return relPickState();
}

/** 关系表筛选/定位状态（V1 `relFilterState`：返回副本；`dim` 在 V2 不参与过滤，见文件头收窄说明） */
export function relFilterState() {
    return { dim: String(relFilterDim || 'all'), who: String(relFilterWho || ''), jump: relJumpRef ? Object.assign({}, relJumpRef) : null };
}
/** 设置筛选/定位状态（V1 `setRelFilter` 原样归一） */
export function setRelFilter(dim, who, jump) {
    relFilterDim = String(dim == null ? 'all' : dim);
    relFilterWho = String(who == null ? '' : who);
    relJumpRef = jump ? { dim: String(jump.dim || ''), id: String(jump.id == null ? '' : jump.id), title: String(jump.title || '') } : null;
    return relFilterState();
}
/** 选角色面板搜索词读写（V1 `pageSearchQuery['relPick']` 的 V2 等价物；V1 不清除 → 这里也不由 relClearFilter 清除） */
export function relPickQueryOf() { return String(relPickQuery || ''); }
export function setRelPickQuery(q) { relPickQuery = String(q == null ? '' : q); return relPickQuery; }

/**
 * V1 `case 'relClearFilter'` 的状态迁移：清空维度筛选 + 角色筛选 + 跳转定位 + 选角色态。
 * V2 收窄：`dim` 本就不参与过滤（页面即维度），故实际可见效果 = 清角色筛选与定位/选择器态；`relPickQuery` 按 V1 保留。
 */
export function relClearFilter() {
    relFilterDim = 'all'; relFilterWho = ''; relJumpRef = null; relPickRef = null;
    return relFilterState();
}

/**
 * V1 `case 'relJump'` 的**状态迁移**部分（导航副作用由面板施加）：
 *   切到关系表并定位该条目 —— 维度=该条目维度、清角色筛选、置跳转引用、关选择器。
 * @returns {{ok:boolean, reason?:string, tab:string, title:string, filter:object, pick:object|null}}
 */
export function relJump(dim, id) {
    const d = String(dim || '');
    const i = String(id == null ? '' : id);
    if (!relIsRelDim(d) || !i) return { ok: false, reason: 'bad-target', tab: '', title: '', filter: relFilterState(), pick: relPickState() };
    let title = '';
    try {
        const it = ((state && state[d]) || []).find((x) => x && String(x.id) === i);
        if (it) title = relEntryTitle(d, it);
    } catch (e) { /* 忽略 */ }
    relFilterDim = d;
    relFilterWho = '';
    relJumpRef = { dim: d, id: i, title: title };
    relPickRef = null;
    return { ok: true, tab: REL_TAB_OF[d] || 'memories', title: title, filter: relFilterState(), pick: relPickState() };
}

/**
 * V1 `case 'relGoto'` 的**状态迁移**部分（导航副作用由面板施加）：
 *   打开条目所在页并把该页搜索词设为条目标题（标题优先，空则取正文前 12 字），清跳转/选择器态。
 * **V1 原生怪癖（原样保留）**：不重置「当前子标签」→ 记忆维度下会停在关系表子标签（搜索词只在切回列表后可见）；
 *   悬念维度按 `tabOf` 映射把搜索词写到 **plans** 页。
 * @returns {{ok:boolean, reason?:string, tab:string, title:string, searchTab:string, planSub:string}}
 */
export function relGoto(dim, id) {
    const d = String(dim || '');
    const i = String(id == null ? '' : id);
    if (!relIsRelDim(d) || !i) return { ok: false, reason: 'bad-target', tab: '', title: '', searchTab: '', planSub: '' };
    let title = '';
    try {
        const it = ((state && state[d]) || []).find((x) => x && String(x.id) === i);
        if (it) title = String(it.title || '').trim() || String(it.content || it.text || '').slice(0, 12);
    } catch (e) { /* 忽略 */ }
    const tabOf = REL_TAB_OF[d] || 'memories';
    relJumpRef = null;
    relPickRef = null;
    return { ok: true, tab: tabOf, searchTab: tabOf, title: title, planSub: (d === 'plans' || d === 'suspense') ? d : '' };
}

/**
 * 追加一行角色（V1 `relPickAppendRow` 的 V2 适配；仍要点「💾 保存关联」才落库）。
 * V1 首参是 DOM 容器；V2 用草稿表承载 → 首参改为 `dim`，并显式给出 `refId`（行容器）。
 * @returns {true|'dup'|false} 成功 / 重复角色 / 容器缺失或参数非法
 */
export function relPickAppendRow(dim, refId, name, opts) {
    try {
        const d = String(dim || '');
        const r = String(refId == null ? '' : refId);
        const o = opts || {};
        const who = String(name == null ? '' : name).trim();
        // V1：`!box || !box.insertAdjacentHTML` / 空名 / 非关联维度 → false
        // V2：行容器 = 草稿槽 `${dim}|${refId}`；条目作用域必须有 refId，编辑器作用域由 opts.editor 显式标记
        if (!o.editor && !r) return false;
        if (!who || !relIsRelDim(d)) return false;
        if (!relLayerOn()) return false;                 // V2 适配：关联层关闭 = 容器不可用（V1 由面板整体不渲染等价）
        const cur = relRowsOf(d, r);
        let dup = false;
        for (const row of cur) {
            if (!row || !row.who) continue;
            if (String(row.who).trim() === who) { dup = true; break; }                                        // V1 第二条判定
            if (snapNameKey(String(row.who)) === snapNameKey(who)) { dup = true; break; }                       // V1 snapNameKey 归一判定
        }
        if (dup) return 'dup';
        cur.push({ who: who, how: d === 'parallels' ? 'related' : 'unspecified' });
        relDrafts.set(draftKey(d, r), cur);
        return true;
    } catch (e) { return false; }
}

/**
 * 「👥 选角色」面板（V1 `relPickPanelHtml`：只从角色档案点名，不遍历四个关联维度）。
 * 结构关键片段与 V1 一致：`data-ftt-rel-pick="dim|id"`（编辑器 `dim|editor`）、`👥 选角色 · 加到「…」` 标题、
 *   `data-ftt-action="relPickAdd"` / `relPickClose` / `data-ftt-search="relPick"`、已关联角标「已在关联」。
 * V2 差异（登记）：V1 的 `data-ftt-kind/-id/-editor/-name` → V2 的 `data-kind/-id/-editor/-name`（面板 DOM 委托口径）。
 */
export function relPickPanelHtml(dim, refId, editor) {
    const d = String(dim || '');
    const r = String(refId == null ? '' : refId);
    const isEd = !!editor;
    const names = relKnownNames();
    let linked = [];
    // V1：已关联名单取自**库**（relLinksOf），编辑器态不取
    try { linked = (relIsRelDim(d) && r && !isEd) ? relRowsOf(d, r, { fresh: true }).filter((x) => x.who).map((x) => String(x.who)) : []; } catch (e) { linked = []; }
    const isOn = (nm) => linked.some((w) => snapNameKey(w) === snapNameKey(nm));
    const q = String(relPickQuery || '').trim().toLowerCase();
    const shown = q ? names.filter((nm) => nm.toLowerCase().indexOf(q) >= 0) : names;
    let body = '';
    if (!names.length) body = '<div class="ftt-empty">「角色」大类暂无已知角色：先运行「AI 摘要」生成角色档案，或在角色页添加角色。</div>';
    else if (!shown.length) body = '<div class="ftt-empty">无匹配角色（搜索：' + esc(relPickQuery) + '）</div>';
    else {
        body = shown.map((nm) => {
            const on = isOn(nm);
            return '<div class="ftt-item" data-ftt-relpick-name="' + attr(nm) + '"><div class="ftt-item-main"><b>' + esc(nm) + '</b>'
                + (on ? ' <span class="ftt-badge ftt-badge--fact">已在关联</span>' : '') + '</div>'
                + '<div class="ftt-item-ops"><button class="ftt-op' + (on ? ' ftt-ok' : '') + '" data-ftt-action="relPickAdd" data-kind="' + attr(d) + '"'
                + ' data-id="' + attr(r) + '" data-editor="' + (isEd ? '1' : '') + '" data-name="' + attr(nm) + '"'
                + ' title="添加为该条目的关联角色（点「保存关联」落库）">➕</button></div></div>';
        }).join('\n');
    }
    const label = isEd ? (relDimLabelOf(d) + '（编辑器）') : relDimLabelOf(d);
    return '<div class="ftt-editor" data-ftt-rel-pick="' + attr(relPickKey(d, r, isEd)) + '">'
        + '<div class="ftt-editor-title">👥 选角色 · 加到「' + esc(label) + '」的关联（角色档案 ' + names.length + ' 名）</div>'
        + '<div class="ftt-muted ftt-w-full">只从<b>角色档案</b>点名，不遍历记忆 / 计划 / 悬念 / 平行条目；点 ➕ 追加一行角色，仍要点「💾 保存关联」才落库。</div>'
        + '<input class="ftt-input" type="text" data-ftt-search="relPick" value="' + attr(relPickQuery) + '" placeholder="搜索角色名…">'
        + '<div class="ftt-hint">角色档案 ' + names.length + ' 名 · 显示 ' + shown.length + ' 名</div>'
        + '<div data-ftt-rel-list="relPick">' + body + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="relPickClose">关闭</button></div></div>';
}
/** 选择器面板的键（V1 `relPickKey`：编辑器 = `dim|editor`，条目 = `dim|refId`） */
export function relPickKey(dim, refId, editor) {
    return String(dim || '') + '|' + (editor ? 'editor' : String(refId == null ? '' : refId));
}
/** 当前是否应渲染某条目的选择器面板（V1 两处 `picking` 判定的合并口径） */
export function relPickingOf(dim, refId, editor) {
    const p = relPickRef;
    if (!p) return false;
    if (String(p.dim) !== String(dim)) return false;
    if (!!p.editor !== !!editor) return false;
    return !!editor || String(p.id || '') === String(refId == null ? '' : refId);
}
