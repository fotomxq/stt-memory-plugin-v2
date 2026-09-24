// ============================================================
// ui/rel-table.js —— **关系表层**（对齐 V1 `12B-UI-关系表.js` / `relEditorTableHtml` / `relRowHtml` / `relSaveBox`）
// 用途：记忆 / 计划 / 悬念 / 平行事件的「谁知道 / 谁相关」总览与编辑（通用知情关联层 `state.links`）。
// 动作与 V1 同名：`relAddRow`（行内新增，未保存前只在草稿里）、`relRowDel`、`relSave`（落库）、
//   `relSweep`（孤儿关联清扫）、`relDropInferred`（清除「推定」写入的关联，不动人工/AI 行）、`relClearEntry`。
// 写入口径与 V1 一致：`upsertRelLinks(dim, refId, rows)`（返回 `{added, updated, removed}`）+ `saveState()`；
//   删除行留墓碑（`tombEntries`），避免跨端复活。
// 与 V1 的差异（登记）：V1 的编辑是「DOM 行 + 保存时读 DOM」，V2 用**草稿数组**（`relDrafts`）承载未保存行，
//   真实 DOM 由 `bindRelTable()` 把输入写回草稿；这样无 DOM 环境（测试/极简宿主）也能完整驱动。
// ============================================================
import { state, cfg, saveState, warn } from '../core/model/runtime.js';
import { relLinksOf } from '../core/model/rel.js';
import { upsertRelLinks, sweepOrphanRelLinks, dropRelLinks } from '../core/entries.js';
import { tombEntries } from '../core/merge.js';

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

/** 关系表 HTML（V1 `relEditorTableHtml` 的表头 + 工具行 + 行；含 `data-ftt-rel-body` 容器名） */
export function relTableHtml(dim, refId) {
    const d = String(dim), r = String(refId);
    const on = relLayerOn();
    const rows = relRowsOf(d, r);
    const body = 'data-ftt-rel-body="' + attr(d + '|' + r) + '"';
    if (!on) {
        return '<div class="ftt-empty">通用知情关联层已关闭（设定 → 分析记忆 → 关联层总开关 `relLayerEnabled`）：不再读写关联行。</div>';
    }
    const head = '<tr><th>角色</th><th>知情方式</th><th>公共</th><th>来源</th><th>日期</th><th>备注</th><th></th></tr>';
    return '<div class="ftt-rel-box" ' + body + '>'
        + '<div class="ftt-hint">关联 = 这条' + esc(dimLabel(d)) + '「谁知道 / 谁相关」；未列出的角色一律视为不知情（约束段据此点名）。</div>'
        + '<table class="ftt-rel-table"><thead>' + head + '</thead><tbody>' + rows.map((row, i) => relRowHtml(d, row, i)).join('') + '</tbody></table>'
        + '<div class="ftt-toolbar ftt-rel-tools">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relAddRow" data-ftt-kind="' + attr(d) + '" data-ftt-id="' + attr(r) + '">➕ 添加行</button>'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="relSave" data-ftt-kind="' + attr(d) + '" data-ftt-id="' + attr(r) + '">💾 保存关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relClearEntry" data-ftt-kind="' + attr(d) + '" data-ftt-id="' + attr(r) + '">🧹 清空该条目关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relSweep">🧽 清扫孤儿关联</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="relDropInferred">🚫 清除「推定」关联</button>'
        + '<span class="ftt-muted">' + (relDirty(d, r) ? '（有未保存改动）' : '（已同步）') + '</span>'
        + '</div></div>';
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
