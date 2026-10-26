// ============================================================
// ui/currency-repair-panel.js —— **货币页顶部 + 货币修正预览**（v3.52.0 W33 `技-61` 从 `ui/panel.js` 外提）
//
// 为什么外提：`ui/panel.js` 受体量棘轮约束（`docs/05` §5 C11）；本块是**纯渲染 + 两个开关位**，
//   与面板状态机无关。外提后 `应-51`（统一预览卡片）可直接在本模块改用公共组件。
//
// 依赖由面板注入（`setCurrencyPanelDeps`）：`arrOf / trackedCurrencyRoles / defaultCurrencyOwner /
//   trackPickState / currencyMergeButton / currencyRepairPlan / esc / attr`。
// ============================================================
let deps = {
    arrOf: () => [],
    trackedCurrencyRoles: () => [],
    defaultCurrencyOwner: () => '主角',
    trackPickState: () => false,
    currencyMergeButton: () => '',
    currencyRepairPlan: () => ({ counts: {} }),
    esc: (v) => String(v == null ? '' : v),
    attr: (v) => String(v == null ? '' : v),
};
let currencyRepairOpen = false;
let currencyRepairUntracked = false;

/** 注入依赖（面板初始化时调用一次） */
export function setCurrencyPanelDeps(next) { deps = Object.assign({}, deps, next || {}); return deps; }
/** 修正面板开关态（测试 / 调试用） */
export function currencyRepairState() { return { open: currencyRepairOpen, includeUntracked: currencyRepairUntracked }; }
/** 开关修正面板 */
export function setCurrencyRepairOpen(v) { currencyRepairOpen = v === true; return currencyRepairOpen; }
/** 开关「同时剔除未标定角色」 */
export function setCurrencyRepairUntracked(v) { currencyRepairUntracked = v === true; return currencyRepairUntracked; }

/** 货币统计一行（总览胶囊文案） */
export function currencyStatText() {
    const esc = deps.esc;
    const list = deps.arrOf('currencies');
    const owners = {};
    for (const x of list) { const k = String((x && x.owner) || ''); if (k) owners[k] = (owners[k] || 0) + 1; }
    const names = Object.keys(owners);
    const tracked = deps.trackedCurrencyRoles();
    const base = '共 ' + list.length + ' 条货币' + (names.length
        ? (' · ' + names.length + ' 个归属（' + names.slice(0, 3).map((n) => n + ' ' + owners[n]).join(' / ') + (names.length > 3 ? ' …' : '') + '）')
        : '');
    return base + (tracked.length ? (' · 已标定 ' + tracked.length + ' 名') : '');
}

/** 货币页顶部（统计胶囊 + 说明 + 已标定胶囊） */
export function currencyTopHtml() {
    const esc = deps.esc, attr = deps.attr;
    const me = String(deps.defaultCurrencyOwner() || '主角');
    const tracked = deps.trackedCurrencyRoles();
    const head = '<div class="ftt-cat-stat ftt-chip">' + esc(currencyStatText()) + '</div>'
        + '<div class="ftt-note ftt-note-info">💰 默认只记<b>主角</b>（当前判定：' + esc(me) + '）持有的货币；其他角色的货币需在正文/编辑器里明确指定归属。额度按 万 / 亿 / 兆 / 京 动态显示，收支保留最近 12 笔。</div>';
    const trackChips = tracked.length
        ? '<div class="ftt-note ftt-note-info" data-ftt-track-chips>⭐ 已标定跟踪：' + tracked.map((n) => '<span class="ftt-badge ftt-badge--fact">' + esc(n) + '<span class="ftt-rel-jump" data-ftt-action="curTrackToggle" data-name="' + attr(n) + '" title="取消标定该角色"> ✖</span></span>').join(' ') + ' <span class="ftt-muted">被标定后：分析记忆会<b>恒定</b>考虑这些角色的货币（提示词 + 当前账本参照），注入时与主角一样恒定列出。</span></div>'
        : '';
    return head + trackChips;
}

/** 货币页工具行里的两个标定按钮 */
export function currencyTrackButtons() {
    const tracked = deps.trackedCurrencyRoles();
    return '<button class="ftt-btn' + (deps.trackPickState() ? ' ftt-primary' : '') + '" data-ftt-action="curTrackPick" title="从「角色」大类里指定要跟踪货币的角色（可多选；被标定后分析记忆会同时考虑其货币情况）">👥 指定角色' + (tracked.length ? '（' + tracked.length + '）' : '') + '</button>'
        + (tracked.length ? '<button class="ftt-btn ftt-err" data-ftt-action="curTrackClear" title="取消全部标定角色">✖ 清空标定</button>' : '')
        + '<button class="ftt-btn ftt-sm' + (currencyRepairOpen ? ' ftt-primary' : '') + '" data-ftt-action="currencyRepair" title="修正货币数据（纯机械、零 AI、可预览）：① 剔除不应该被记录的角色；② 修正错乱的单位计价；③ 合并冗余条目。删除与合并都会留墓碑，跨端不会复活。">🧹 修正货币</button>'
        + deps.currencyMergeButton();
}

function repairRow(d) {
    const esc = deps.esc;
    const parts = [];
    if (d.owner) parts.push(esc(String(d.owner)));
    if (d.name) parts.push('<b>' + esc(String(d.name)) + '</b>');
    if (d.unit) parts.push('单位 ' + esc(String(d.unit)));
    if (d.amount !== undefined && d.amount !== null && d.amount !== 0) parts.push('额度 ' + esc(String(d.amount)));
    return '<div class="ftt-muted">· ' + parts.join(' · ') + ' — ' + esc(String(d.detail || d.reason || '')) + '</div>';
}
function repairSection(title, arr, cap) {
    if (!arr || !arr.length) return '';
    const n = Math.max(1, Number(cap) || 8);
    return '<div class="ftt-muted ftt-w-full"><b>' + deps.esc(title) + '（' + arr.length + '）</b></div>'
        + arr.slice(0, n).map(repairRow).join('')
        + (arr.length > n ? '<div class="ftt-muted">…还有 ' + (arr.length - n) + ' 条</div>' : '');
}

/** 货币修正预览面板（纯机械修正的计划；空 = 未打开） */
export function currencyRepairPanelHtml() {
    const esc = deps.esc;
    if (!currencyRepairOpen) return '';
    let plan;
    try { plan = deps.currencyRepairPlan({ includeUntracked: currencyRepairUntracked }); } catch (e) { return '<div class="ftt-empty">修正计划不可用：' + esc(String((e && e.message) || e)) + '</div>'; }
    const counts = plan.counts || {};
    const canUntracked = plan.untrackedAvailable === true;
    const toggle = '<button class="ftt-btn ftt-sm' + (currencyRepairUntracked ? ' ftt-primary' : '') + '" data-ftt-action="currencyRepairToggleUntracked"'
        + (canUntracked ? '' : ' disabled')
        + ' title="' + (canUntracked
            ? '勾选后：既不是默认归属（主角）也没有被「👥 指定角色」标定的角色，其货币一并剔除'
            : '不可用：默认归属是兜底值「主角」（主角身份未确证）→ 勾选会把全部货币误删，故只报告不剔除') + '">'
        + (currencyRepairUntracked ? '☑' : '☐') + ' 同时剔除未标定角色的货币</button>';
    const head = '<div class="ftt-editor-title">🧹 货币修正计划 · 共 ' + (Number(counts.total) || 0) + ' 项'
        + '（剔除 ' + (Number(counts.drop) || 0) + ' · 合并 ' + (Number(counts.mergeGroups) || 0) + ' 组 · 修正 ' + (Number(counts.fix) || 0) + ' · 只报告 ' + (Number(counts.report) || 0) + '）</div>';
    const intro = '<div class="ftt-muted ftt-w-full">纯机械修正（<b>零 AI</b>、确定性）：页面逐条列出将删除 / 合并 / 修正的内容，确认后才落库；'
        + '删除与合并都会留删除墓碑（按条目 id；货币 id 由「归属 + 币种」派生 → 跨端同一条会得到同一 id，不会被复活），条目<b>只减不增</b>。'
        + '默认归属（主角）判定：<b>' + esc(String(plan.me || '')) + '</b>'
        + (plan.meConfirmed ? '' : '（兜底值，未确证）') + ' · 名册 ' + (plan.roster || []).length + ' 名 · 标定 ' + (plan.tracked || []).length + ' 名。'
        + '建议先「⬇ 导出 JSON 文件」备份。</div>';
    const empty = (Number(counts.total) || 0) === 0;
    const body = (empty ? '<div class="ftt-empty">未发现需要修正的条目（剔除 / 合并 / 计价修正都是空的）。</div>' : '')
        + repairSection('① 将剔除的条目', plan.drop, 10)
        + repairSection('② 将合并的冗余条目', (plan.merge || []).map((m) => ({
            owner: m.owner, name: m.canonical, unit: m.unit, amount: m.amount,
            detail: m.detail + ' ← ' + m.members.map((x) => x.name + '/' + (x.unit || '—') + '/' + x.amount).join('，'),
        })), 6)
        + repairSection('③ 将修正的计价', plan.fix, 10)
        + repairSection('④ 只报告不改（需人工判断）', plan.report, 8);
    const ops = '<div class="ftt-row">'
        + (empty ? '' : '<button class="ftt-btn ftt-primary" data-ftt-action="currencyRepairApply" title="按上面的计划落库（会再次弹确认框）">✅ 应用修正</button>')
        + '<button class="ftt-btn" data-ftt-action="currencyRepairClose">取消</button></div>';
    return '<div class="ftt-editor ftt-preview-card" data-ftt-cur-repair>' + head + intro
        + '<div class="ftt-row">' + toggle + '</div>' + body + ops + '</div>';
}
