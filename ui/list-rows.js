// ============================================================
// ui/list-rows.js —— **数据面板各「大类」列表行**（v2.47.0：对齐 V1 的展示内容与顺序）
//
// 用户报告：「情节等大类面板列表显示内容不全，请参照 V1 展示对应内容，**注意展示顺序**。」
// 事实：V2 此前用一句 `entrySummary()`（title→name→content→text→subject，截 90 字）+ 一行元信息渲染所有维度，
//   于是各维度**自有字段**（情节的类型/楼层/有效性与标签、记忆的知情徽标与分类、角色的档案正文与年龄、
//   物品的数量与所在地、货币的额度与流水、传言的阶段/客观性/载体/链路、计划的目标时间与进度、
//   平行的卦象/源起/目标概率、概念的来源与被引用…）统统看不到。
//
// 本模块按 **V1 v1.206 的各维度行渲染器**逐条对齐（字段集合与**先后顺序**都一致）：
//   atoms       → `atomsHtml()` 23932~23955（行序：标题 → 正文 → 标签 → 时间行；无独立标题时：正文 → 标签 → 时间行）
//   memories    → `memoriesHtml()` 24114~24138（徽标+归属 → 标题 → 描述 → 标签 → 关联摘要 → 差异 → 时间行）
//   snapshots   → `snapshotsHtml()` 24040~24097（标题（+已去世/出生异常角标）→ 档案正文 → 下钻 → 标签 → 调用统计）
//   items       → `itemsHtml()` 24151~24154（标题（×数量/所在地/携带中）→ 说明 → 标签行 → 调用统计）
//   currencies  → `currenciesHtml()` 24197~24217（标题（币种+额度+归属徽标）→ 备注 → 收支流水 → 标签 → 统计）
//   rumors      → `rumorsHtml()` 24235~24268（标题（阶段/客观性/发酵度）→ 说法 → 传播者 → 载体 → 关联平行 → 谱系 → 进行中 → 链路 → 标签 → 统计）
//   plans       → `plansHtml()` 24300~24328（标题（+阶段角标）→ 描述 → 时间/角色/目标 → 进度 → 知情摘要 → 标签）
//   suspense    → `plansHtml()` 24336~24362（同上 + 线索行）
//   concepts    → `conceptsHtml()` 24529~24535（标题（+来源/日期）→ 内容 → 标签 → 被记忆引用 → 统计）
//   parallels   → `parallelsHtml()` 24489~24523（九行结构：标题+卦象 → 时间/地点/角色 → 描述 → 源起 → 目标概率 → 统计 → 标签 → 相关角色 → 来源/预演/约束）
//   states      → `statesHtml()` 24008~24013（`字段：值` → `调用N次 · 更新 …`）
//
// 排序：见 `core/clock.js#sortRecentByStoryDate`（V1 `sortRecent` 逐字：剧情日期倒序 → floorEnd 倒序）。
// 与 V1 的**必要差异**（V2 面板结构决定，登记于 docs/P10k）：
//   ① 操作按钮仍走 V2 的 `data-ftt-action` + `data-id`（V1 用 `data-ftt-action` + `data-ftt-kind/-id`）；
//   ② 行容器是 V2 的 `ftt-item ftt-inline`（右侧操作区），V1 用 `.ftt-item-main` + `.ftt-item-ops` —— 内容与顺序不变；
//   ③ 「下钻」块（角色档案的已知记忆/参与计划/在查悬念、概念的被引用）与「知情摘要」行**本批一并补齐**（V1 有则出）。
// ============================================================
import { cfg, state, getStoryNow } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import { atomTitle, normPhase } from '../core/model/scalars.js';
import { atomIsHidden } from '../core/merge.js';
import { formatMoney, defaultCurrencyOwner, isTrackedCurrencyOwner } from '../core/model/money.js';
import { relLinksOf, relSummaryLine, relHowLabelOf } from '../core/model/rel.js';
import { snapshotAge, snapshotAgeBasisText, snapshotAppearanceText, snapshotBirthAnomaly, snapshotBirthAnomalyShort } from '../core/model/snapshot.js';
import { importancePct, planPhaseLabel, parallelExpired, parallelDecayScore, relTag } from '../core/recall.js';

const esc = (v) => escHtml(String(v == null ? '' : v));
/** 文本裁剪（V1 各行的 `.slice()` 口径） */
const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

// ============================================================
// 共用小件
// ============================================================
/** 标签行（V1 两种类名：`ftt-tags` 与 `ftt-tags-inline`，逐维度照抄） */
function tagsLine(list, cls) {
    const t = arr(list);
    if (!t.length) return '';
    return '<div class="' + (cls || 'ftt-tags') + '">#' + esc(t.join(' #')) + '</div>';
}
/** 时间行（V1 `📅 {date}{相对时间}{时间}`；无日期 → `📅 未知`） */
function whenLine(item, now, unknownText) {
    const d = String((item && item.date) || '').trim();
    if (!d) return unknownText === undefined ? '' : unknownText;
    const t = String((item && item.time) || '');
    const withTime = t && !/^\d{4}/.test(t) ? (' ' + t) : '';
    return '📅 ' + esc(d) + relTag(d, now) + esc(withTime);
}
/** 关联行（V1 `relSummaryLine` + 🔗 入口；入口按钮由面板侧提供，这里只出文本） */
function relNoteText(kind, id, fallback) {
    let known = '';
    try { known = relSummaryLine(kind, id, 6) || ''; } catch (e) { known = ''; }
    return known ? known : fallback;
}

// ============================================================
// 「下钻」块（V1 `relCharacterDrillHtml` 25108~25133 / `relConceptRefHtml` 25141~25154）
// ============================================================
/** 角色页下钻：已知记忆 / 参与计划 / 在查悬念（只读聚合，按知情方式计数 + 前若干标题） */
export function characterDrillHtml(name) {
    try {
        const key = String(name || '').replace(/[\s·・.．]/g, '').toLowerCase();
        if (!key) return '';
        const hit = (dim) => {
            const out = [];
            for (const it of (state[dim] || [])) {
                if (!it || !it.id) continue;
                let rows = [];
                try { rows = relLinksOf(dim, it.id) || []; } catch (e) { rows = []; }
                const mine = rows.filter((x) => x && x.who && String(x.who).replace(/[\s·・.．]/g, '').toLowerCase() === key);
                if (!mine.length) continue;
                out.push({ it: it, how: mine[0].how });
            }
            return out;
        };
        const mems = hit('memories'), plans = hit('plans'), susps = hit('suspense');
        if (!mems.length && !plans.length && !susps.length) return '';
        const cnt = (list) => {
            const g = {};
            for (const x of list) { const l = relHowLabelOf(x.how); g[l] = (g[l] || 0) + 1; }
            return Object.keys(g).map((k) => k + ' ' + g[k]).join(' · ');
        };
        const titles = (list, n) => list.slice(0, n).map((x) => '《' + cut(x.it.title || x.it.content || x.it.text, 16) + '》').join('');
        const parts = [];
        if (mems.length) parts.push('🧠 已知 ' + mems.length + ' 条（' + cnt(mems) + '）' + titles(mems, 2));
        if (plans.length) parts.push('📋 参与计划 ' + plans.length + '（' + cnt(plans) + '）' + titles(plans, 1));
        if (susps.length) parts.push('🔍 在查/知情悬念 ' + susps.length + '（' + cnt(susps) + '）' + titles(susps, 1));
        return '<div class="ftt-note ftt-note-info">' + esc(parts.join(' · ')) + '</div>';
    } catch (e) { return ''; }
}

/** 概念页「← 被记忆引用 N 条：《…》」（V1 `relConceptRefHtml`） */
export function conceptRefHtml(concept) {
    try {
        const name = String((concept && concept.name) || '').trim();
        if (!name) return '';
        const list = [];
        for (const it of (state.memories || [])) {
            if (!it || !it.id) continue;
            let rows = [];
            try { rows = relLinksOf('memories', it.id) || []; } catch (e) { rows = []; }
            const anchor = rows.find((x) => !x.who) || null;
            if (anchor && String(anchor.conceptRef || '').trim() === name) list.push(it);
        }
        if (!list.length) return '';
        const titles = list.slice(0, 3).map((m) => '《' + cut(m.title || m.content, 14) + '》').join('');
        return '<div class="ftt-note ftt-note-info">← 被记忆引用 ' + list.length + ' 条' + (titles ? ('：' + esc(titles)) : '') + '</div>';
    } catch (e) { return ''; }
}

// ============================================================
// 记忆「类型徽标」（V1 `memoriesHtml()`：按关联派生：公开事实 / 事实 / 共同 / 私密）
// ============================================================
function memoryBadge(id) {
    let rows = [];
    try { rows = relLinksOf('memories', id) || []; } catch (e) { rows = []; }
    const anchor = rows.find((x) => !x.who) || null;
    const people = rows.filter((x) => x.who);
    if (anchor && anchor.public) return { html: '<span class="ftt-badge ftt-badge--public">公开事实</span>', rows: rows, anchor: anchor, people: people };
    if (anchor) return { html: '<span class="ftt-badge ftt-badge--fact">事实</span>', rows: rows, anchor: anchor, people: people };
    if (people.length >= 2) return { html: '<span class="ftt-badge ftt-badge--shared">共同</span>', rows: rows, anchor: anchor, people: people };
    if (people.length === 1) return { html: '<span class="ftt-badge ftt-badge--private">私密</span>', rows: rows, anchor: anchor, people: people };
    return { html: '', rows: rows, anchor: anchor, people: people };
}

// ============================================================
// 各维度行正文（返回 `{ main, tags: [], opsExtra }`；main 放在 V2 行的主体 span 内）
// ============================================================
export function listRowMainHtml(kind, e) {
    const now = (() => { try { return getStoryNow() || ''; } catch (x) { return ''; } })();
    const k = String(kind || '');
    const item = e || {};
    try {
        if (k === 'atoms') return atomsRow(item, now);
        if (k === 'memories') return memoriesRow(item, now);
        if (k === 'snapshots') return snapshotsRow(item);
        if (k === 'items') return itemsRow(item);
        if (k === 'currencies') return currenciesRow(item);
        if (k === 'rumors') return rumorsRow(item);
        if (k === 'plans' || k === 'suspense') return planSuspRow(k, item, now);
        if (k === 'concepts') return conceptsRow(item, now);
        if (k === 'parallels') return parallelsRow(item, now);
    } catch (x) { /* 单行渲染失败 → 回落摘要（不影响整页） */ }
    // 兜底（未覆盖的维度）：V1 无对应行渲染器时用摘要 + 调用统计
    const fallback = String(item.title || item.name || item.content || item.text || item.subject || '');
    return '<b>' + esc(cut(fallback, 90)) + '</b>';
}

/** V1 `atomsHtml()` 23932~23955 */
function atomsRow(a, now) {
    const t = String(a.date ? ('[' + esc(a.date) + relTag(a.date, now) + (a.time && !/^\d{4}-\d{2}-\d{2}/.test(a.time) ? ' ' + esc(a.time) : '') + ']') : '[日期未知]');
    const tags = arr(a.tags).length ? (' <span class="ftt-tags-inline">#' + esc(a.tags.join(' #')) + '</span>') : '';
    const valid = a.validity === 'inactive' ? ' 🔒已失效' : (a.validity === 'uncertain' ? ' ⚠️不确定' : '');
    const ms = a.mergedSummary || null;
    const mergeTag = ms
        ? (' <button class="ftt-op" data-ftt-action="atomPeek" data-ftt-id="' + esc(a.id) + '" title="点击穿透查看底层被隐藏的原情节清单（只读）">🧩</button>'
            + '<span class="ftt-muted">情节总结（' + (ms.by === 'auto' ? '半自动' : '手动') + ' · 覆盖 ' + (Number(ms.sourceCount) || 0) + ' 条'
            + (ms.label ? (' · ' + esc(String(ms.label))) : '') + '）</span>')
        : '';
    const hiddenTag = (() => { try { return atomIsHidden(a) ? ' 🙈已总结隐藏' : ''; } catch (x) { return ''; } })();
    const locs = arr(a.locations).length ? (' · ' + esc(a.locations.join('/'))) : '';
    const meta = '<div class="ftt-desc">📅 ' + t + ' · ' + esc(a.type) + ' · ' + esc(a.floorStart) + '-' + esc(a.floorEnd) + '楼 · 调用' + (a.uses || 0) + '次 · 重要度' + importancePct(a) + '%' + locs + '</div>';
    const title = (() => { try { return atomTitle(a); } catch (x) { return String(a.title || ''); } })();
    const ownTitle = !!title && !String(a.text || '').trim().startsWith(title);
    if (ownTitle) {
        return '<div class="ftt-title-row"><b>' + esc(title) + '</b>' + valid + mergeTag + hiddenTag + '</div>'
            + (a.text ? '<div class="ftt-text">' + esc(a.text) + '</div>' : '')
            + tagsLine(a.tags, 'ftt-tags-inline').replace(/^<div[^>]*>/, '<div>') + meta;
    }
    return '<b>' + esc(a.text) + '</b>' + valid + mergeTag + hiddenTag + tags + meta;
}

/** V1 `memoriesHtml()` 24114~24138 */
function memoriesRow(m, now) {
    const b = memoryBadge(m.id);
    const people = b.people;
    const who = (!people.length && m.owner && m.owner !== '通用') ? ('【' + esc(m.owner) + '】') : '';
    const when = m.date ? ('📅 ' + esc(m.date) + relTag(m.date, now)) : '📅 未知';
    const cat = esc(m.memCategory || m.category || '一般');
    const tags = tagsLine(m.tags);
    const relSum = '<div class="ftt-note ftt-note-info">'
        + (people.length ? ('关联 ' + people.length + '：' + esc(relSummaryLine('memories', m.id, 6))) : '未记录知情者（按归属者保守回退）')
        + ' <span class="ftt-rel-jump" data-ftt-action="relJump" data-kind="memories" data-id="' + esc(m.id) + '" title="在「记忆 → 关系表」里查看 / 新建这条记忆的知情关联">🔗 关联' + (people.length ? ('（' + people.length + '）') : '') + '</span></div>';
    const devs = people.filter((x) => String(x.view || '').trim()).slice(0, 3)
        .map((x) => String(x.who || '').replace(/^.*·/, '') + ' ' + esc(cut(x.view, 24)));
    const devLine = devs.length ? ('<div class="ftt-note ftt-note-warn">差异：' + devs.join(' · ') + '</div>') : '';
    const concept = (b.anchor && b.anchor.conceptRef) ? ('<span class="ftt-hint ftt-hint-info"> 概念：' + esc(b.anchor.conceptRef) + '</span>') : '';
    return '<div class="ftt-title-row">' + b.html + who + '<b>' + esc(m.title) + '</b></div>'
        + (m.content ? '<div class="ftt-desc">' + esc(m.content) + '</div>' : '')
        + tags + relSum + devLine
        + '<div class="ftt-meta">' + when + ' · ' + cat + concept + ' · 调用' + (m.uses || 0) + '次 · 重要度' + importancePct(m) + '%</div>';
}

/** V1 `snapshotsHtml()` 24040~24097 */
function snapshotsRow(s) {
    const parts = [];
    const add = (kk, v) => { const t = String(v == null ? '' : v).trim(); if (t) parts.push(kk + '：' + esc(t)); };
    add('性别', s.identity && s.identity.gender);
    add('出生日期', s.identity && s.identity.birthDate);
    let ageNow = '';
    try { ageNow = snapshotAge(s) || ''; } catch (e) { ageNow = ''; }
    if (ageNow) {
        let basis = '';
        try { basis = snapshotAgeBasisText(s) || ''; } catch (e) { basis = ''; }
        parts.push('年龄：' + esc(ageNow) + '岁' + (basis ? ('（' + esc(basis) + '）') : ''));
    } else if (s.identity && s.identity.birthDate) {
        parts.push('年龄：待算（缺剧情日期）');
    }
    add('种族', s.identity && s.identity.species);
    add('职业', s.identity && s.identity.occupation);
    add('称号', s.identity && s.identity.title);
    add('家族', s.identity && s.identity.family);
    try { add('外貌', snapshotAppearanceText(s)); } catch (e) { /* 忽略 */ }
    if (arr(s.personality && s.personality.traits).length) parts.push('性格特质：' + esc(s.personality.traits.join('/')));
    if (arr(s.personality && s.personality.quirks).length) parts.push('小癖好：' + esc(s.personality.quirks.join('/')));
    if (arr(s.personality && s.personality.values).length) parts.push('价值观：' + esc(s.personality.values.join('/')));
    add('说话风格', s.personality && s.personality.speechStyle);
    add('出身', s.background && s.background.origin);
    add('背景经历', s.background && s.background.history);
    if (arr(s.relationships).length) parts.push('关系：' + esc(s.relationships.map((r) => r.name + '(' + r.relation + (r.attitude ? ('/' + r.attitude) : '') + ')').join('、')));
    add('与主角', s.social && s.social.relationToUser);
    add('对主角态度', s.social && s.social.attitudeToUser);
    if (arr(s.future && s.future.todos).length) parts.push('待办：' + esc(s.future.todos.join('/')));
    if (arr(s.future && s.future.commitments).length) parts.push('承诺：' + esc(s.future.commitments.join('/')));
    const body = parts.length ? parts.join('，') : '（暂无详细信息）';
    const deadTag = (s.identity && s.identity.deceased === true) ? '<span class="ftt-badge ftt-badge--abandoned">🪦 已去世</span>' : '';
    let birthTag = '';
    try {
        const anom = snapshotBirthAnomaly(s);
        if (anom) {
            let why = anom;
            try { why = snapshotBirthAnomalyShort(anom) || anom; } catch (e) { why = anom; }
            birthTag = '<span class="ftt-badge ftt-badge--blocked" title="' + esc(cut('出生日期异常：' + why + '（修复时优先）', 29)) + '">⚠️ 出生日期异常</span>';
        }
    } catch (e) { /* 忽略 */ }
    const tags = tagsLine(s.tags);
    const stamp = (icon, label, d, t) => (d ? (icon + ' ' + label + ' ' + esc(d) + (t ? (' ' + esc(t)) : '')) : '');
    const times = [stamp('🕒', '更新', s.lastUpdateDate, s.lastUpdateTime), stamp('👁', '见面', s.lastSeenDate, s.lastSeenTime)].filter(Boolean);
    const drill = characterDrillHtml(s.name);
    return '<div class="ftt-title-row"><b>' + esc(s.name) + '</b>' + deadTag + birthTag + '</div>'
        + '<div class="ftt-snap-desc">' + body + '</div>' + drill + tags
        + '<div class="ftt-meta">调用' + (s.uses || 0) + '次 · 重要度' + importancePct(s) + '%' + (times.length ? (' · ' + times.join(' · ')) : '') + '</div>';
}

/** V1 `itemsHtml()` 24151~24154 */
function itemsRow(i) {
    const tagLine = arr(i.tags).length
        ? '<div class="ftt-tags">🏷 #' + esc(i.tags.join(' #')) + '</div>'
        : '<div class="ftt-note ftt-note-warn">🏷 （无标签 · 点「🔧 修复物品」可自动补齐 3-5 个）</div>';
    return '<div class="ftt-title-row"><b>' + esc(i.name) + '</b>'
        + (i.qty != null ? (' ×' + esc(i.qty)) : '')
        + (i.location ? ('（' + esc(i.location) + '）') : '')
        + (i.carried ? ' 携带中' : '') + '</div>'
        + (i.desc ? '<div class="ftt-desc">' + esc(i.desc) + '</div>' : '')
        + tagLine
        + '<div class="ftt-meta">调用' + (i.uses || 0) + '次 · 重要度' + importancePct(i) + '%</div>';
}

/** V1 `currenciesHtml()` 24197~24217 */
function currenciesRow(c) {
    let me = '主角';
    try { me = String(defaultCurrencyOwner() || '主角'); } catch (e) { me = '主角'; }
    const owner = String(c.owner || me);
    const mine = owner === me;
    let tracked = false;
    try { tracked = !mine && isTrackedCurrencyOwner(owner); } catch (e) { tracked = false; }
    const hist = arr(c.history).slice(-4).reverse();
    const histHtml = hist.length
        ? ('<div class="ftt-sub">' + hist.map((f) => esc(f.date || '—') + ' ' + (f.delta >= 0 ? '收入' : '支出') + ' <b>' + esc(formatMoney(Math.abs(f.delta))) + '</b>' + (f.note ? ('· ' + esc(cut(f.note, 30))) : '')).join('<br>') + '</div>')
        : '';
    const tagLine = arr(c.tags).length ? ('<div class="ftt-tags">🏷 #' + esc(c.tags.join(' #')) + '</div>') : '';
    return '<div class="ftt-title-row"><b>' + esc(c.name) + '</b> ' + esc(formatMoney(c.amount)) + (c.unit ? (' ' + esc(c.unit)) : '')
        + '<span class="ftt-badge ' + (mine ? 'ftt-badge--fact' : 'ftt-badge--private') + '">' + esc(owner) + (mine ? '' : '（非主角）') + '</span>'
        + (tracked ? '<span class="ftt-badge ftt-badge--public">⭐已标定</span>' : '') + '</div>'
        + (c.note ? '<div class="ftt-desc">' + esc(c.note) + '</div>' : '')
        + histHtml + tagLine
        + '<div class="ftt-meta">调用' + (c.uses || 0) + '次 · 原始额度 ' + esc(String(c.amount)) + (c.date ? (' · ' + esc(c.date)) : '') + '</div>';
}

/** V1 `rumorsHtml()` 24235~24268 */
function rumorsRow(r) {
    const stageBadge = (st) => {
        const s = String(st || '萌芽');
        const cls = (s === '沉寂' || s === '消退') ? 'ftt-badge--dim' : 'ftt-badge--fact';
        return '<span class="ftt-badge ' + cls + '">' + esc(s) + '</span>';
    };
    const byId = {};
    for (const x of (state.rumors || [])) if (x && x.id) byId[x.id] = x;
    const carriers = arr(r.carriers), media = arr(r.media);
    const act = media.filter((m) => m && m.active !== false);
    const mediaLine = media.length
        ? ('<div class="ftt-sub">📰 载体：' + media.map((m) => esc(m.type) + ((m.name && m.name !== m.type) ? ('《' + esc(m.name) + '》') : '') + (m.at ? (' ' + esc(m.at)) : '') + (m.active === false ? ' <span class="ftt-badge ftt-badge--dim">已停</span>' : '')).join('　') + '</div>')
        : '';
    const carrierLine = carriers.length
        ? ('<div class="ftt-sub">👥 传播者：' + carriers.map((c) => esc(c.who) + ((c.role && c.role !== '传播者') ? ('（' + esc(c.role) + '）') : '')).join('、') + '</div>')
        : '';
    const chain = arr(r.chain).slice(-4);
    const chainLine = chain.length
        ? ('<div class="ftt-sub">🔗 传导链路（最近 ' + chain.length + ' 步）：' + chain.map((s) => esc(s.at || '—') + ' ' + esc(s.kind) + (s.note ? ('·' + esc(cut(s.note, 40))) : '')).join('　→　') + '</div>')
        : '';
    const lin = r.lineage || {};
    const linBits = [];
    if (lin.parentId) { const p = byId[lin.parentId]; linBits.push('分裂自 ' + (p ? esc(p.subject || p.id) : esc(cut(lin.parentId, 12)))); }
    const kids = arr(lin.children).map((id) => byId[id]).filter(Boolean);
    if (kids.length) linBits.push('已分出 ' + kids.map((x) => esc(x.subject || '')).filter(Boolean).join('、') + '（' + kids.length + ' 支）');
    if (Number(lin.generation) > 0) linBits.push('第 ' + Number(lin.generation) + ' 代');
    const linLine = linBits.length ? ('<div class="ftt-sub">🧬 谱系：' + linBits.join(' · ') + '</div>') : '';
    const pref = arr(r.parallelRefs).map((id) => (state.parallels || []).find((p) => p && p.id === id)).filter(Boolean);
    const prefLine = pref.length ? ('<div class="ftt-sub">🌌 关联平行事件：' + pref.map((p) => esc(cut(p.title || p.id, 20))).join('、') + '</div>') : '';
    const pendingLine = r.pending ? ('<div class="ftt-sub">⏳ 变化过程进行中：' + esc(r.pending.kind) + '「' + esc(cut(r.pending.target, 20)) + '」（' + (Number(r.pending.progress) || 0) + '/' + (Number(r.pending.need) || 2) + ' 轮）</div>') : '';
    const tagLine = arr(r.tags).length ? ('<div class="ftt-tags">🏷 #' + esc(r.tags.join(' #')) + '</div>') : '';
    return '<div class="ftt-title-row"><b>' + esc(r.subject || '') + '</b> ' + stageBadge(r.stage)
        + '<span class="ftt-badge ' + (r.objectivity === '客观' ? 'ftt-badge--public' : 'ftt-badge--private') + '">' + esc(r.objectivity || '主观') + '</span>'
        + '<span class="ftt-muted">发酵度 ' + (Number(r.ferment) || 0) + '</span></div>'
        + '<div class="ftt-desc">' + esc(r.content || '') + '</div>'
        + carrierLine + mediaLine + prefLine + linLine + pendingLine + chainLine + tagLine
        + '<div class="ftt-meta">来源 ' + esc(r.source || '—') + ' · 调用' + (r.uses || 0) + '次'
        + (r.date ? (' · ' + esc(r.date)) : '') + ' · 链路 ' + arr(r.chain).length + ' 步'
        + (act.length ? (' · 活跃载体 ' + act.length) : '') + '</div>';
}

/** V1 `plansHtml()` 24300~24362（plans 与 suspense 同一模板，悬念多一行「线索」） */
function planSuspRow(kind, p, now) {
    const isSusp = kind === 'suspense';
    const hasTitle = String(p.title || '').trim() && p.title !== p.content;
    const meta = [];
    if (p.date) meta.push(esc(p.date + relTag(p.date, now) + (p.time && !/^\d{4}/.test(String(p.time)) ? ' ' + p.time : '')));
    else if (p.time) meta.push(esc(p.time));
    if (arr(p.characters).length) meta.push('角色:' + esc(p.characters.slice(0, 6).join('、')));
    if (!isSusp && p.targetTime) meta.push('目标:' + esc(String(p.targetTime) + relTag(p.targetTime, now)));
    if (isSusp && p.resolveTime) meta.push('揭晓:' + esc(String(p.resolveTime) + relTag(p.resolveTime, now)));
    const metaS = meta.length ? ('<div class="ftt-meta">' + meta.join(' · ') + '</div>') : '';
    // V1：`const ph = normPhase(p.phase); ph ? <角标> : ''` —— 无阶段（或非法值）**不出角标**
    const ph = normPhase(p.phase) || '';
    const phBadge = ph ? ('<span class="ftt-badge ftt-ml-2 ' + (ph === 'blocked' ? 'ftt-badge--blocked' : 'ftt-badge--abandoned') + '">' + esc(planPhaseLabel(ph)) + (p.statusNote ? ('·' + esc(cut(p.statusNote, 20))) : '') + '</span>') : '';
    const known = relNoteText(kind, p.id, isSusp ? '未记录知情者（按当事人保守回退）' : '未记录知情者（按策划者保守回退）');
    const relLine = '<div class="ftt-note ftt-note-info">' + esc(known)
        + ' <span class="ftt-rel-jump" data-ftt-action="relJump" data-kind="' + esc(kind) + '" data-id="' + esc(p.id) + '" title="在「记忆 → 关系表」里编辑这条' + (isSusp ? '悬念' : '计划') + '的知情者">🔗 关联</span></div>';
    const prog = Number(p.progress);
    const progTxt = (!isSusp && Number.isFinite(prog) && prog > 0)
        ? ('<div class="ftt-meta">进度 ' + Math.max(0, Math.min(100, Math.round(prog))) + '%'
            + (arr(p.steps).length ? (' · 步骤 ' + p.steps.filter((x) => x && x.done === true).length + '/' + p.steps.length) : '') + '</div>')
        : '';
    const clueLine = (isSusp && arr(p.clues).length)
        ? ('<div class="ftt-meta">线索 ' + p.clues.length + ' 条' + (p.resolveCondition ? (' · 揭晓条件：' + esc(cut(p.resolveCondition, 24))) : '') + '</div>')
        : '';
    return '<div class="ftt-title-row"><b>' + esc(hasTitle ? p.title : p.content) + '</b>' + phBadge + '</div>'
        + (hasTitle ? ('<div class="ftt-desc">' + esc(p.content) + '</div>') : '')
        + metaS + progTxt + clueLine + relLine + tagsLine(p.tags);
}

/** V1 `conceptsHtml()` 24529~24535 */
function conceptsRow(c, now) {
    const src = c.source ? ('<span class="ftt-sub"> · 来源:' + esc(c.source) + '</span>') : '';
    const when = c.date ? (' 📅 ' + esc(c.date) + relTag(c.date, now)) : '';
    const refs = conceptRefHtml(c);
    const tagsInner = arr(c.tags).length ? (' #' + esc(c.tags.join(' #'))) : '';
    return '<div class="ftt-title-row"><b>' + esc(c.name) + '</b>' + src + when + '</div>'
        + (c.content ? ('<div class="ftt-desc">' + esc(c.content) + '</div>') : '')
        + '<span class="ftt-tags-inline">' + tagsInner + '</span>' + refs
        + '<div class="ftt-meta">调用' + (c.uses || 0) + '次 · 重要度' + importancePct(c) + '%</div>';
}

/** V1 `parallelsHtml()` 24489~24523（九行结构） */
function parallelsRow(p, now) {
    let decayNote = '', expired = false;
    try {
        if (cfg.parallelDecayEnabled !== false) {
            const sc = parallelDecayScore(p);
            expired = parallelExpired(p);
            decayNote = expired ? '💀 已衰退待清理' : ('⏳ 新鲜度 ' + Math.round((1 - sc) * 100) + '%');
        }
    } catch (e) { /* 忽略 */ }
    const line1 = '<b>' + esc(p.title || p.text) + '</b>' + (p.gua ? (' <span class="ftt-badge ftt-badge--suspense">☯ ' + esc(p.gua) + '</span>') : '');
    const segs = [];
    const when = p.date ? (p.date + relTag(p.date, now) + (p.time && !/^\d{4}/.test(String(p.time)) ? ' ' + p.time : '')) : (p.time || '');
    if (when) segs.push('📅 ' + esc(when));
    if (p.location) segs.push('📍 ' + esc(p.location));
    if (arr(p.characters).length) segs.push('角色:' + esc(p.characters.join('、')));
    const line2 = segs.length ? ('<div class="ftt-desc">' + segs.join(' · ') + '</div>') : '';
    const line3 = p.text ? ('<div class="ftt-text">' + esc(p.text) + '</div>') : '';
    const line4 = p.causalLine ? ('<div class="ftt-desc">⚡ 源起：' + esc(p.causalLine) + '</div>') : '';
    const line5 = arr(p.goalOdds).length ? ('<div class="ftt-tags">🎯 目标：' + p.goalOdds.map((g) => esc(g.target) + ' ' + (Number(g.likelihood) || 0) + '%').join('；') + '</div>') : '';
    const updated = p.updatedAt ? (' · 现实更新 ' + new Date(Number(p.updatedAt)).toLocaleString()) : '';
    const line6 = '<div class="ftt-meta">' + esc(p.type || '') + ' · 调用' + (p.uses || 0) + '次 · 重要度' + importancePct(p) + '%' + esc(updated) + ' · ' + esc(decayNote) + '</div>';
    const line7 = tagsLine(p.tags);
    const relWho = relNoteText('parallels', p.id, '仅幕后（角色不知情）');
    const line8 = '<div class="ftt-note ftt-note-info">' + esc(relWho) + (p.promotedTo ? ' · 已转正为情节' : '')
        + ' <span class="ftt-rel-jump" data-ftt-action="relJump" data-kind="parallels" data-id="' + esc(p.id) + '" title="在关系表里编辑相关角色">🔗 关联</span>'
        + (p.promotedTo ? '' : (' <span class="ftt-rel-jump" data-ftt-action="promoteParallel" data-id="' + esc(p.id) + '" title="转正为情节（需确认，原条不再注入）">⬆ 转正为情节</span>')) + '</div>';
    const srcN = arr(p.sourceRefs).length, preN = arr(p.previews).length;
    const line9 = (srcN || preN || p.constraintNote)
        ? ('<div class="ftt-meta">' + (srcN ? ('来源 ' + srcN + ' 条') : '')
            + (preN ? ((srcN ? ' · ' : '') + '预演 ' + esc(arr(p.previews).slice(0, 2).join('/'))) : '')
            + (p.constraintNote ? (((srcN || preN) ? ' · ' : '') + '约束：' + esc(cut(p.constraintNote, 30))) : '') + '</div>')
        : '';
    return line1 + line2 + line3 + line4 + line5 + line6 + line7 + line8 + line9;
}

/** V1 `statesHtml()` 24008~24013 的单行（状态页在面板侧按主体分组渲染） */
export function stateRowMainHtml(s) {
    const up = s.updatedAt ? (' · 更新 ' + esc(s.updatedAt) + (s.updatedAtTime ? (' ' + esc(s.updatedAtTime)) : '')) : '';
    return '<b>' + esc(s.field) + '</b>：' + esc(s.value)
        + '<div class="ftt-meta">调用' + (s.uses || 0) + '次' + up + '</div>';
}

/** 该维度在列表里是否只显示「进行中」（V1 `plansHtml` 只列 `status==='open'`） */
export function listStatusFilter(kind) { return (kind === 'plans' || kind === 'suspense') ? 'open' : ''; }
