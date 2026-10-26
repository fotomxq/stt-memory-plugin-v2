// ============================================================
// ui/states-page.js —— **状态页（按角色分组）**（v3.52.0 W33 `技-61` 从 `ui/panel.js` 外提 + `应-50` 角色组折叠）
//
// 为什么外提：`ui/panel.js` 受体量棘轮约束（`docs/05` §5 C11）；本块是纯渲染 + 过滤/排序编排，
//   依赖由面板注入（`setStatesPageDeps`）。
//
// `应-50`（`docs/D55` §3.5）：角色组标题增加**字段数角标**与**纯 DOM 折叠开关**（`data-ftt-stategroup-toggle`），
//   折叠态默认展开、不落盘（纯视图态）；空态 / 无匹配 / 占位符文案仍与 V1 逐字一致。
// ============================================================
let deps = {
    psOf: () => ({ q: {}, multi: {}, editing: null }),
    listFilterOf: () => ({}),
    arrOf: () => [],
    fieldHayOf: () => '',
    extraMatchOf: () => true,
    listSortOf: (k, a) => a,
    selOf: () => new Set(),
    listFilterBarHtml: () => '',
    selectDepButtonParts: () => ({ attr: '', text: '' }),
    editorHtml: () => '',
    rowSelectMarkHtml: () => '',
    swipeRowHtml: (a, b) => String(a) + String(b),
    stateRowMainHtml: () => '',
    esc: (v) => String(v == null ? '' : v),
    attr: (v) => String(v == null ? '' : v),
};
/** 注入依赖（面板初始化时调用一次） */
export function setStatesPageDeps(next) { deps = Object.assign({}, deps, next || {}); return deps; }

/** 状态页正文（V1 `statesHtml()` 对齐；新增角色组折叠） */
export function renderStatesPage() {
    const ps = deps.psOf() || {};
    const esc = deps.esc, attr = deps.attr;
    const q = String((ps.q && ps.q.states) || '');
    const qs = q.trim().toLowerCase();
    const f = deps.listFilterOf('states');
    const all = deps.arrOf('currentStates');
    const byQ = qs
        ? all.filter((it) => deps.fieldHayOf(it, f.field).includes(qs) || String((it && it.subject) || '').toLowerCase().includes(qs))
        : all.slice();
    const byE = byQ.filter((it) => { try { return deps.extraMatchOf('states', it, f.extra); } catch (e) { return true; } });
    const matched = deps.listSortOf('states', byE);
    const groups = new Map();
    for (const e of matched) {
        const k = String((e && e.subject) || '').trim() || '（无主体）';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
    }
    const subjects = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const multi = (ps.multi && ps.multi.states) === true;
    const sel = deps.selOf('states');
    const repBtn = all.length
        ? '<button class="ftt-btn ftt-sm" data-ftt-action="stateRepair" title="匹配角色 → 机械清理与字段规范化 → 交 AI 整理">🔧 修复状态</button>'
        : '';
    const dep = deps.selectDepButtonParts('bulkDelete', sel.size);
    const filterBar = deps.listFilterBarHtml('states', {
        placeholder: '搜索：角色 / 字段 / 值 / 关键词…',
        extraOpts: [['all', '全部状态'], ['inactive', '仅已失效']],
        countText: '共 ' + all.length + ' 条 · 命中 ' + matched.length,
    });
    const toolbar = '<div class="ftt-addbar ftt-toolbar">'
        + '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="add" data-kind="states">➕ 新增</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="multiToggle" data-kind="states" title="切换单选 / 多选">' + (multi ? '☑ 多选模式' : '☐ 单选模式') + '</button>'
        + (multi ? ('<button class="ftt-btn ftt-sm" data-ftt-action="selectAll" data-kind="states">全选</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="selectNone" data-kind="states">清空选择</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="bulkDelete" data-kind="states"' + dep.attr + '>' + dep.text + '</button>') : '')
        + repBtn + '</div>';
    const ed = ps.editing && ps.editing.kind === 'states' ? deps.editorHtml('states', ps.editing.id, ps.editing.preset) : '';
    const head = '<div class="ftt-cat-stat ftt-chip">共 ' + all.length + ' 条状态（有效 ' + all.filter((x) => String((x && x.status) || 'active') !== 'inactive').length + '）· ' + groups.size + ' 个角色组</div>'
        + filterBar + toolbar + ed;
    if (!all.length) return head + '<div class="ftt-empty">暂无状态记录。运行「AI 摘要」或点「添加状态」创建。</div>';
    if (!matched.length) return head + '<div class="ftt-empty">无匹配结果（搜索/筛选：' + esc(String(q)) + '）</div>';
    const blocks = subjects.map((subj) => {
        const items = groups.get(subj).slice().sort((a, b) => (Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0));
        const rows = items.map((e) => {
            const id = String(e.id || '');
            const box = multi ? deps.rowSelectMarkHtml(sel.has(id)) : '';
            return deps.swipeRowHtml(box + '<span class="ftt-grow">' + deps.stateRowMainHtml(e) + '</span>',
                '<button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="states" data-id="' + attr(id) + '" title="编辑这条状态记录">✏️</button>'
                + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="states" data-id="' + attr(id) + '" title="删除这条状态记录">🗑</button>',
                { count: 2 });
        }).join('\n');
        // v3.52.0（应-50）：角色组可折叠（纯 DOM；默认展开，不落盘）
        return '<div class="ftt-stategroup" data-ftt-stategroup="' + attr(subj) + '">'
            + '<div class="ftt-stategroup-head"><button type="button" class="ftt-caret" data-ftt-stategroup-toggle="' + attr(subj) + '" title="折叠 / 展开该角色组">▾</button></div>'
            + '<h4 class="ftt-h4-inline ftt-mt-6">👤 ' + esc(subj) + ' <span class="ftt-muted">(' + groups.get(subj).length + ')</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="addStateFor" data-ftt-subject="' + attr(subj) + '">➕ 添加</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delStateGroup" data-ftt-subject="' + attr(subj) + '" title="删除该角色全部状态">🗑 删除分组</button></h4>'
            + '<div class="ftt-stategroup-body" data-ftt-stategroup-body="' + attr(subj) + '">' + rows + '</div></div>';
    }).join('\n');
    return head + blocks;
}
