// ============================================================
// ui/editor.js —— **条目编辑器装配**（v3.52.0 W33 `技-61` 从 `ui/panel.js` 外提 + `应-52` 长表单分组）
//
// 为什么外提：`ui/panel.js` 有体量棘轮（`docs/05` §5 C11，4023 行 / 上限 4025）；编辑器装配是纯渲染逻辑，
//   与面板状态机无关 → 外提后可继续演进表单而不再挤压面板额度。
//
// `应-52`（`docs/D55` §3.6）：字段数 > 8 的表单按**业务语义分组**（可折叠，默认全展开；次要分组默认收起），
//   必填项标星；`parallels` 的 `goalOdds` 由分隔符文本升级为**结构化行控件**（与 `nodeTable` 同族）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { DIMENSIONS } from '../core/constants.js';
import { consoleEntry } from './console.js';
import { kindFields, nodeTableHtml, oddsTableHtml } from './fields.js';
import { flatFor } from './entry-flat.js';
import { nsfwLevelOf, nsfwLevelLabel, nsfwLevelHint } from '../core/nsfw.js';
import { escHtml } from '../core/util.js';

const esc = (v) => { try { return escHtml(v); } catch (e) { return String(v == null ? '' : v); } };
const attr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dataKindOf = (kind) => (kind === 'states' ? 'currentStates' : String(kind || ''));

/** 必填字段（界面标星；真正的拒绝仍在归一函数里） */
const REQUIRED = Object.freeze({
    atoms: ['text'], memories: ['content'], items: ['name'], plans: ['content'], suspense: ['content'],
    concepts: ['name'], snapshots: ['name'], scenes: ['name'], npcs: ['name'], currencies: ['name'],
    ledger: ['currencyId', 'date', 'delta'], deals: ['name', 'currencyId', 'startDate'],
});

/**
 * 长表单分组（仅 `snapshots` 22 字段；其余维度字段少，保持单组平铺）。
 * 组顺序 = `D55` §3.6 的「身份 → 外貌 → 背景 → 关系 → 未来」；次要分组默认收起。
 */
const SNAP_GROUPS = Object.freeze([
    { id: 'identity', label: '身份', keys: ['name', 'gender', 'birthDate', 'occupation', 'title', 'species', 'family', 'deceased', 'immortal', 'canon'], open: true },
    { id: 'look', label: '外貌与性格', keys: ['appearance', 'traits', 'quirks', 'values', 'speechStyle'], open: true },
    { id: 'background', label: '背景', keys: ['origin', 'history'], open: false },
    { id: 'social', label: '关系与未来', keys: ['relationToUser', 'attitudeToUser', 'todos', 'commitments', 'tags'], open: false },
]);

/** 场景父级下拉：父级 id（按完整路径找） */
function findSceneParentId(scene) {
    try {
        const arr = Array.isArray(scene && scene.pathArr) ? scene.pathArr.slice() : [];
        if (arr.length <= 1) return '';
        const parentKey = arr.slice(0, -1).join('>');
        const list = Array.isArray(state.scenes) ? state.scenes : [];
        const p = list.find((x) => ((Array.isArray(x.pathArr) ? x.pathArr.join('>') : String(x.pathStr || '')) === parentKey));
        return p ? String(p.id || '') : '';
    } catch (e) { return ''; }
}

/** 维度标签（未知维度回落键名；`suspense` 的特殊简称与面板同口径） */
export function kindLabelOf(kind) {
    const d = DIMENSIONS.filter((x) => x.kind === kind)[0];
    if (d) return d.label;
    if (kind === 'suspense') return '悬念';
    return String(kind);
}

/** 编辑器初值（字段 key → 值）；preset 用于「新增」路径（状态主体 / 父级场景 / 失败保留的草稿） */
export function prefillEditor(kind, out, item, preset) {
    const p = preset || {};
    if (!item) {
        for (const k of Object.keys(p)) { if (k.charAt(0) === '_') continue; out.set(k, p[k]); }
        if (kind === 'states' && p.subject) out.set('subject', String(p.subject));
        if (kind === 'scenes' && p.parentSceneId) out.set('parent', String(p.parentSceneId));
        if (kind === 'scenes' && p.name) out.set('name', String(p.name));
        if (kind === 'plans' || kind === 'suspense') { out.set('status', 'open'); out.set('phase', ''); }
        if (kind === 'items') out.set('carried', false);
        if (kind === 'snapshots') { out.set('deceased', false); out.set('immortal', false); }
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
export function collectEditorFields(el) {
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

/** 单字段渲染 */
function fieldHtml(kind, f, val, d, isNew, preset) {
    const req = (REQUIRED[kind] || []).indexOf(f.key) >= 0 ? '<span class="ftt-req" title="必填">*</span>' : '';
    if (f.type === 'relTable') {
        const rels = (!isNew && d && d.rels) ? d.rels : [];
        return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + '</label><div class="ftt-hint">'
            + (rels.length ? esc(rels.map((r) => (r.who || '公共') + (r.how ? '(' + r.how + ')' : '')).join('、')) : '（无关联 · 关系表编辑见批次 B5）') + '</div></div>';
    }
    if (f.type === 'checkbox') {
        return '<div class="ftt-field"><label>' + esc(f.label) + req + '</label><input type="checkbox" data-ftt-ed="' + attr(f.key) + '"' + (val === true ? ' checked' : '') + '></div>';
    }
    if (f.type === 'select') {
        const opts = (f.options || []).map((o) => {
            const ov = (o && typeof o === 'object') ? o.value : o;
            const ol = (o && typeof o === 'object') ? o.label : o;
            return '<option value="' + attr(ov) + '"' + (String(val) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>';
        }).join('');
        return '<div class="ftt-field"><label>' + esc(f.label) + req + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
    }
    if (f.type === 'sceneParent') {
        const item = (!isNew && d) ? d.item : null;
        const selId = String((preset && preset.parentSceneId) || (item ? findSceneParentId(item) : '') || '');
        const list = Array.isArray(state.scenes) ? state.scenes : [];
        const all = list.slice().sort((a, b) => {
            const pa = (Array.isArray(a.pathArr) ? a.pathArr.join('/') : String(a.pathStr || a.name || ''));
            const pb = (Array.isArray(b.pathArr) ? b.pathArr.join('/') : String(b.pathStr || b.name || ''));
            return pa.localeCompare(pb);
        });
        const opts = ['<option value="">（顶层）</option>'].concat(all.map((sc) => {
            const depth = Math.max(0, (Array.isArray(sc.pathArr) ? sc.pathArr.length : 1) - 1);
            const label = '　'.repeat(depth) + String(sc.name || '') + '（' + (Array.isArray(sc.pathArr) ? sc.pathArr.join('>') : String(sc.name || '')) + '）';
            return '<option value="' + attr(sc.id) + '"' + (String(sc.id) === selId ? ' selected' : '') + '>' + esc(label) + '</option>';
        })).join('');
        return '<div class="ftt-field"><label>' + esc(f.label) + req + '</label><select data-ftt-ed="' + attr(f.key) + '">' + opts + '</select></div>';
    }
    if (f.type === 'textarea') {
        return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + req + '</label><textarea data-ftt-ed="' + attr(f.key) + '" rows="4">' + esc(val) + '</textarea></div>';
    }
    if (f.type === 'nodeTable') return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + req + '</label>' + nodeTableHtml(f, val) + '</div>';
    if (f.type === 'oddsTable') return '<div class="ftt-field ftt-field-col"><label>' + esc(f.label) + req + '</label>' + oddsTableHtml(f, val) + '</div>';
    const ph = f.placeholder ? (' placeholder="' + attr(f.placeholder) + '"') : '';
    return '<div class="ftt-field"><label>' + esc(f.label) + req + '</label><div class="ftt-grow"><input type="' + attr(f.type || 'text') + '" data-ftt-ed="' + attr(f.key) + '" value="' + attr(val) + '"' + ph + '></div></div>';
}

/** 编辑器主体（字段 → 分组 → HTML） */
export function editorHtml(kind, id, preset) {
    const isNew = !id;
    const d = isNew ? null : consoleEntry(dataKindOf(kind), id);
    if (!isNew && !d) return '<div class="ftt-empty">（条目已不存在）</div>';
    const base = new Map();
    try { prefillEditor(kind, base, isNew ? null : d.item, preset); } catch (e) { /* 忽略 */ }
    const fields = kindFields(kind);
    const renderField = (f) => fieldHtml(kind, f, base.has(f.key) ? base.get(f.key) : '', d, isNew, preset);
    const groups = (kind === 'snapshots')
        ? SNAP_GROUPS.map((g) => {
            const fs = fields.filter((f) => g.keys.indexOf(f.key) >= 0);
            if (!fs.length) return '';
            return '<div class="ftt-edgroup' + (g.open ? ' ftt-edgroup--open' : '') + '" data-ftt-edgroup="' + g.id + '">'
                + '<button type="button" class="ftt-edgroup-head" data-ftt-edgroup-toggle="' + g.id + '">' + (g.open ? '▾' : '▸') + ' ' + esc(g.label) + '<span class="ftt-muted">（' + fs.length + ' 项）</span></button>'
                + '<div class="ftt-edgroup-body" data-ftt-edgroup-body="' + g.id + '"' + (g.open ? '' : ' style="display:none"') + '>' + fs.map(renderField).join('\n') + '</div></div>';
        }).join('')
        : fields.map(renderField).join('\n');
    const nsfwRow = (() => {
        try {
            const it = (!isNew && d) ? d.item : null;
            const l = it ? nsfwLevelOf(it) : 'none';
            if (l === 'none') return '';
            return '<div class="ftt-field"><label>NSFW 等级留档</label><div class="ftt-grow">'
                + '<span class="ftt-tags-inline ftt-nsfw-tag" data-ftt-nsfw-level="' + l + '">NSFW·' + esc(nsfwLevelLabel(l)) + '</span>'
                + ' <span class="ftt-muted">' + esc(nsfwLevelHint(l)) + '（永久留档：弱化内容不会改变它）</span></div></div>';
        } catch (x) { return ''; }
    })();
    return '<div class="ftt-editor">'
        + '<div class="ftt-editor-title">' + (isNew ? '➕ 新增' : '✏️ 编辑') + ' · ' + esc(kindLabelOf(kind)) + (id ? (' · ' + esc(id) + ' · 内容哈希 ' + esc((d && d.hash) || '')) : '') + '</div>'
        + nsfwRow
        + groups
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="save" data-kind="' + attr(kind) + '" data-id="' + attr(id || '') + '">💾 保存</button>'
        + '<button class="ftt-btn" data-ftt-action="closeEntry" data-kind="' + attr(kind) + '">取消</button></div>'
        + '</div>';
}
