// ============================================================
// ui/console.js —— 数据台（P5 次批）：条目浏览 / 搜索 / 编辑 / 删除 / 关联 / 注入自查
// 定位：V1 数据面板的 V2 版（只做「人能看到、能改、能核对」的最小可用集）。
// 口径：
//   ① 读取一律走内核容器（`state`）；写入走 `core/entries.js#upsertEntry` / `deleteEntry`
//      （**删除留 id + 内容哈希双墓碑**，与 V1 数据安全口径一致），随后 `saveStateNow()` 落盘；
//   ② 维度表取 `DIMENSIONS`（14 类），条目摘要字段按维度回退（title / name / content / text）；
//   ③ 注入自查：拿当前注入正文，逐条判断「是否真的进了注入」，并给出合计（V1「注入自查」的轻量版）；
//   ④ 渲染与交互分离：`consoleHtml()` 产 HTML，`consoleAction()` 处理动作（真实 DOM 由 `bindConsole()` 接线，
//      无 querySelectorAll 的环境可由调用方直接调 `consoleAction`，便于测试与排障）。
// ============================================================
import { DIMENSIONS } from '../core/constants.js';
import { state, cfg, getLastMessageId } from '../core/model/runtime.js';
import { upsertEntry, deleteEntry } from '../core/entries.js';
import { relLinksOf } from '../core/model/rel.js';
import { atomContentHash } from '../core/model/hash.js';
import { readInject } from '../host/inject.js';
import { saveStateNow } from '../adapters/store.js';

const CONSOLE_ID = 'ftt_v2_console';
/** 数据台交互状态（单一来源，渲染与动作共用） */
const cs = { tab: 'atoms', q: '', open: null, note: '', limit: 50 };

/** 当前数据台状态（只读快照，调试与测试） */
export function consoleState() { return Object.assign({}, cs, { open: cs.open ? Object.assign({}, cs.open) : null }); }

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 维度标签（未知维度回退 kind） */
function dimLabel(kind) {
    const d = DIMENSIONS.filter((x) => x.kind === kind)[0];
    return d ? d.label : String(kind);
}

/** 维度容器数组（关联层 `links` 不在 14 维内，单独处理） */
function arrOf(kind) {
    try {
        if (kind === 'links') return Array.isArray(state.links) ? state.links : [];
        return Array.isArray(state[kind]) ? state[kind] : [];
    } catch (e) { return []; }
}

/** 条目摘要文本（title → name → content → text → subject） */
export function entrySummary(e) {
    if (!e || typeof e !== 'object') return '';
    const s = e.title || e.name || e.content || e.text || e.subject || '';
    return String(s).replace(/\s+/g, ' ').slice(0, 90);
}

/** 条目搜索命中（id / 摘要 / 正文 / 标签 / 归属） */
export function entryMatches(e, q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    try {
        const hay = [e.id, e.title, e.name, e.content, e.text, e.subject, e.owner, e.who,
            (Array.isArray(e.tags) ? e.tags.join(' ') : ''), (Array.isArray(e.keywords) ? e.keywords.join(' ') : '')]
            .filter(Boolean).join(' ').toLowerCase();
        return hay.indexOf(needle) >= 0;
    } catch (x) { return false; }
}

/** 维度统计（数据台标签行） */
export function consoleSummary() {
    const dims = DIMENSIONS.map((d) => ({ kind: d.kind, label: d.label, count: arrOf(d.kind).length }));
    const total = dims.reduce((n, d) => n + d.count, 0);
    const injected = readInject();
    return { dims, total, injectChars: injected.length, scope: String((state && state.scope) || ''), floor: getLastMessageId() };
}

/** 当前标签 + 搜索词下的条目列表（V1 面板同款：最新在前） */
export function consoleList(kind, q, limit) {
    const k = kind || cs.tab;
    const n = Number(limit) > 0 ? Number(limit) : cs.limit;
    const list = arrOf(k).filter((e) => entryMatches(e, q === undefined ? cs.q : q));
    return list.slice().reverse().slice(0, n);
}

/**
 * 注入自查（轻量版）：逐条判断「条目是否出现在当前注入正文里」，并区分来源标签。
 * @returns {{chars:number, injected:number, missing:number, rows:Array}}
 */
export function injectAudit(opts) {
    const o = opts || {};
    const text = readInject();
    const rows = [];
    let injected = 0, missing = 0;
    for (const d of DIMENSIONS) {
        const list = arrOf(d.kind);
        for (const e of list) {
            const key = entrySummary(e);
            if (!key) continue;
            const hit = text.indexOf(key.slice(0, 24)) >= 0;
            if (hit) injected++; else missing++;
            if (o.rows !== false) rows.push({ kind: d.kind, id: String(e.id || ''), summary: key.slice(0, 40), hit });
        }
    }
    return { chars: text.length, injected, missing, rows: o.rows === false ? [] : rows };
}

/** 条目详情（编辑器用）：副本 + 关联行 + 内容哈希 */
export function consoleEntry(kind, id) {
    const list = arrOf(kind);
    const e = list.filter((x) => x && String(x.id) === String(id))[0];
    if (!e) return null;
    let rels = [];
    try { rels = relLinksOf(kind, id) || []; } catch (x) { rels = []; }
    let hash = '';
    try { hash = atomContentHash(kind, e) || ''; } catch (x) { hash = ''; }
    return { kind, id: String(e.id || ''), item: JSON.parse(JSON.stringify(e)), rels, hash };
}

/**
 * 保存编辑（`patch` 只含改动的字段；`tags` 可用逗号文本）。
 * @returns {{ok:boolean, reason?:string, id?:string}}
 */
export function consoleSave(kind, id, patch) {
    try {
        const raw = Object.assign({}, patch || {});
        if (raw.id === undefined) raw.id = id;
        if (typeof raw.tags === 'string') raw.tags = raw.tags.split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean);
        if (raw.importance !== undefined && raw.importance !== '') raw.importance = Number(raw.importance);
        const ok = upsertEntry(kind, raw);
        if (!ok) { cs.note = '保存失败：必要字段缺失（如记忆需正文、情节需 ≥8 字正文）'; return { ok: false, reason: 'normalize-empty' }; }
        void saveStateNow({ reason: 'console-save' });
        cs.note = '已保存 ' + dimLabel(kind) + ' · ' + String(id);
        cs.open = null;
        return { ok: true, id: String(id) };
    } catch (e) {
        cs.note = '保存异常：' + String((e && e.message) || e);
        return { ok: false, reason: 'error' };
    }
}

/** 删除条目（留双墓碑；不需要二次确认 — 调用方负责确认） */
export function consoleDelete(kind, id) {
    try {
        const ok = deleteEntry(kind, id);
        if (!ok) { cs.note = '删除失败：未找到条目'; return { ok: false, reason: 'not-found' }; }
        void saveStateNow({ reason: 'console-delete' });
        cs.note = '已删除 ' + dimLabel(kind) + ' · ' + String(id) + '（已留墓碑，跨端不会复活）';
        if (cs.open && String(cs.open.id) === String(id)) cs.open = null;
        return { ok: true };
    } catch (e) {
        cs.note = '删除异常：' + String((e && e.message) || e);
        return { ok: false, reason: 'error' };
    }
}

/** 渲染数据台 HTML（标签行 + 搜索框 + 列表 + 编辑器 + 注入自查 + 提示行） */
export function consoleHtml() {
    const sum = consoleSummary();
    const audit = injectAudit({ rows: false });
    const list = consoleList(cs.tab, cs.q);
    const tabsHtml = sum.dims.map((d) => {
        const on = d.kind === cs.tab ? ' ftt-console-tab-on' : '';
        return '<button class="menu_button ftt-console-tab' + on + '" data-ftt-console="tab" data-kind="' + esc(d.kind) + '">' +
            esc(d.label) + '<span class="ftt-console-count">' + d.count + '</span></button>';
    }).join('');
    const rowsHtml = list.map((e) => {
        const id = String(e.id || '');
        const date = String(e.date || e.seenDate || e.lastUpdateDate || '');
        const uses = Number(e.uses) || 0;
        return '<div class="ftt-console-row" data-ftt-console="open" data-kind="' + esc(cs.tab) + '" data-id="' + esc(id) + '">' +
            '<span class="ftt-console-id">' + esc(id) + '</span>' +
            '<span class="ftt-console-sum">' + esc(entrySummary(e)) + '</span>' +
            '<span class="ftt-console-meta">' + esc(date) + (uses ? ' · ' + uses + '次' : '') + '</span>' +
            '<button class="menu_button" data-ftt-console="del" data-kind="' + esc(cs.tab) + '" data-id="' + esc(id) + '">🗑</button>' +
            '</div>';
    }).join('') || '<div class="ftt-v2-note">（该维度暂无条目）</div>';
    const open = cs.open ? consoleEntry(cs.open.kind, cs.open.id) : null;
    const editorHtml = open ? [
        '<div class="ftt-console-editor">',
        '<div class="ftt-v2-sub">编辑 · ' + esc(dimLabel(open.kind)) + ' · ' + esc(open.id) + ' · 内容哈希 ' + esc(open.hash) + '</div>',
        '<label>标题/名称 <input type="text" id="ftt_con_title" value="' + esc(open.item.title || open.item.name || '') + '"></label>',
        '<label>正文/内容 <textarea id="ftt_con_text" rows="4">' + esc(open.item.text || open.item.content || '') + '</textarea></label>',
        '<label>日期 <input type="text" id="ftt_con_date" value="' + esc(open.item.date || '') + '"></label>',
        '<label>标签 <input type="text" id="ftt_con_tags" value="' + esc((open.item.tags || []).join('、')) + '"></label>',
        '<label>重要度 <input type="number" id="ftt_con_imp" step="0.05" min="0" max="1" value="' + esc(open.item.importance === undefined ? '' : open.item.importance) + '"></label>',
        '<div class="ftt-v2-row ftt-v2-row-actions">',
        '<button class="menu_button" data-ftt-console="save" data-kind="' + esc(open.kind) + '" data-id="' + esc(open.id) + '">💾 保存</button>',
        '<button class="menu_button" data-ftt-console="cancel">取消</button>',
        '</div>',
        '<div class="ftt-v2-note">关联 ' + (open.rels.length ? esc(open.rels.map((r) => (r.who || '公共') + (r.how ? '(' + r.how + ')' : '')).join('、')) : '（无）') + '</div>',
        '</div>',
    ].join('') : '';
    return [
        '<div class="ftt-console">',
        '<div class="ftt-v2-sub">数据台 · 共 ' + sum.total + ' 条 · 注入 ' + audit.chars + ' 字（命中 ' + audit.injected + ' / 未命中 ' + audit.missing + '）</div>',
        '<div class="ftt-console-tabs">' + tabsHtml + '</div>',
        '<div class="ftt-v2-row"><label>搜索</label><input type="text" id="ftt_con_search" value="' + esc(cs.q) + '" placeholder="标题 / 正文 / 标签 / 归属"></div>',
        '<div class="ftt-console-list">' + rowsHtml + '</div>',
        editorHtml,
        '<div class="ftt-v2-note" id="ftt_con_note">' + esc(cs.note) + '</div>',
        '</div>',
    ].join('');
}

/**
 * 数据台动作（唯一入口；真实 DOM 与测试共用）。
 * @param {string} action tab | search | open | save | delete | cancel | refresh | audit
 * @param {object} [payload]
 * @returns {object} 动作结果（含渲染后的 HTML，便于调用方直接写入容器）
 */
export function consoleAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    let result = { ok: true, action: a };
    try {
        if (a === 'tab') { cs.tab = String(p.kind || 'atoms'); cs.open = null; cs.q = cs.q; }
        else if (a === 'search') { cs.q = String(p.q == null ? '' : p.q); }
        else if (a === 'open') { cs.open = { kind: String(p.kind || cs.tab), id: String(p.id || '') }; }
        else if (a === 'cancel') { cs.open = null; }
        else if (a === 'save') {
            result = Object.assign(result, consoleSave(String(p.kind || cs.tab), String(p.id || ''), p.fields || {}));
        } else if (a === 'delete') {
            result = Object.assign(result, consoleDelete(String(p.kind || cs.tab), String(p.id || '')));
        } else if (a === 'audit') {
            const au = injectAudit({});
            result = Object.assign(result, { ok: true, audit: au });
        } else if (a === 'refresh') { /* 仅重渲染 */ }
        else { result = { ok: false, reason: 'unknown-action' }; }
    } catch (e) {
        result = { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
    const html = consoleHtml();
    writeConsole(html);
    return Object.assign(result, { html, state: consoleState() });
}

/** 把渲染结果写入容器（容器不存在则只返回 HTML） */
export function writeConsole(html) {
    const doc = globalThis.document;
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(CONSOLE_ID) : null;
    const text = String(html == null ? consoleHtml() : html);
    if (!el) return false;
    try {
        if (typeof el.innerHTML === 'string') { el.innerHTML = text; return true; }   // 真实 DOM：整块替换（不累积）
    } catch (e) { /* 落到追加 */ }
    if (typeof el.insertAdjacentHTML === 'function') el.insertAdjacentHTML('beforeend', text);   // 桩 DOM
    return true;
}

/** 真实 DOM 接线（无 querySelectorAll 的环境跳过；此时由调用方直接调 consoleAction） */
export function bindConsole() {
    const doc = globalThis.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    const nodes = doc.querySelectorAll('[data-ftt-console]');
    for (const el of nodes) {
        const action = el.getAttribute('data-ftt-console');
        if (action === 'tab' || action === 'open' || action === 'del') {
            el.addEventListener('click', () => consoleAction(action === 'del' ? 'delete' : action, { kind: el.getAttribute('data-kind'), id: el.getAttribute('data-id') }));
        } else if (action === 'save') {
            el.addEventListener('click', () => {
                const g = (id) => { const n = doc.getElementById(id); return n ? n.value : ''; };
                consoleAction('save', {
                    kind: el.getAttribute('data-kind'), id: el.getAttribute('data-id'),
                    fields: { title: g('ftt_con_title'), text: g('ftt_con_text'), date: g('ftt_con_date'), tags: g('ftt_con_tags'), importance: g('ftt_con_imp') },
                });
            });
        } else if (action === 'cancel') {
            el.addEventListener('click', () => consoleAction('cancel', {}));
        }
    }
    const search = doc.getElementById('ftt_con_search');
    if (search) search.addEventListener('change', () => consoleAction('search', { q: search.value }));
    return true;
}

/** 数据台配置摘要（诊断/测试） */
export function consoleConfig() { return { id: CONSOLE_ID, limit: cs.limit, tab: cs.tab, dims: DIMENSIONS.length, editFields: ['title', 'text', 'date', 'tags', 'importance'] }; }
