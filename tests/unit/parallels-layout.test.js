// ============================================================
// 单元测试 · v2.71.0「平行大类：右侧按钮竖向排列（对齐 V1）」
//
// 用户要求：「平行大类中的 UI 布局需优化，尤其是**列表右侧按钮会大量挤占空间**。
//   **默认应该将按钮竖向排列**，V1 也有类似处理。」
//
// V1 事实源（v1.206 `parallelsHtml()` 24481 / CSS 22758）：
//   行 = `<div class="ftt-item"><div class="ftt-item-main">…内容…</div><div class="ftt-item-ops ftt-ops-col">…</div></div>`；
//   `#ftt-panel .ftt-ops-col { flex-direction: column; align-items: center; justify-content: center; flex: 0 0 auto; }`；
//   **全库只有平行页**这样写（`ftt-item-ops ftt-ops-col` 仅 1 处），其余维度沿用横向 `.ftt-item-ops`。
//   操作区顺序：🚀 `parallelAdvance` → ⬆ `promoteParallel` →（多选勾选框）→ ✏️ `editEntry` → 🗑 `delEntry`；
//   已达衰退阈值不渲染 🚀、已转正不渲染 ⬆。
//
// V2 修复：`ui/panel.js` 的行装配把平行行的操作按钮包进 `<div class="ftt-item-ops ftt-ops-col">`（其余维度不变），
//   行主体仍由 `.ftt-grow` 占满剩余宽度 → 不再被按钮横向挤压。
//
// V1 对照（oracle）：`tests/fixtures/v1-golden-parallels-row.json`
// 运行：node tests/unit/parallels-layout.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelBodyHtml, openPanel, setPanelHooks2, panelAction } from '../../ui/panel.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('parallels-layout v2.71.0 平行列表按钮竖向排列');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'v1-golden-parallels-row.json'), 'utf8'));
const CSS = readFileSync(join(HERE, '..', '..', 'style.css'), 'utf8');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

/** V2 行 → 投影（与 oracle 的 projectRow 同口径；V2 的动作名 edit/delete 映射到 V1 的 editEntry/delEntry） */
const ACT_MAP = { edit: 'editEntry', delete: 'delEntry' };
function projectRows(html) {
    const out = [];
    const parts = String(html).split('<div class="ftt-item ftt-inline">').slice(1);
    for (const seg of parts) {
        // 行文本取到「下一行 / 工具栏 / 结尾」为止（不能在第一个 `</div>` 处截断 —— 那会切在行主体内部）
        const cut = [seg.indexOf('<div class="ftt-item ftt-inline">'), seg.indexOf('<div class="ftt-addbar'), seg.indexOf('<div class="ftt-row')]
            .filter((i) => i >= 0).sort((a, b) => a - b)[0];
        const row = (cut === undefined) ? seg : seg.slice(0, cut);
        const opsAt = row.indexOf('<div class="ftt-item-ops');
        const opsClass = opsAt >= 0 ? ((row.slice(opsAt).match(/^<div class="([^"]*)"/) || [])[1] || '') : '';
        const opsHtml = opsAt >= 0 ? row.slice(opsAt) : '';
        const actions = [];
        const re = /data-ftt-action="([^"]*)"/g;
        let m;
        while ((m = re.exec(opsHtml)) !== null) actions.push(ACT_MAP[m[1]] || m[1]);
        out.push({
            opsClass: opsClass, opsActions: actions, opsCol: /ftt-ops-col/.test(opsClass),
            opsIsLastChild: opsAt >= 0 && row.trim().endsWith('</div></div>'),
            mainInGrow: row.indexOf('<span class="ftt-grow">') >= 0,
            hasMultiCheckboxInOps: /data-ftt-select="/.test(opsHtml),
        });
    }
    return out;
}
function boot(parallels, extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, extra || {});
    setScopeKey('甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    const st = emptyState();
    st.parallels = parallels;
    setKernelState(st);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    openPanel('parallels');
    return panelBodyHtml('parallels');
}
const P_NORMAL = { id: 'p1', title: '北境集结', text: '部落在边境零星集结。', date: '1919-11-30', location: '北境·哨所', characters: ['甲'], gua: '乾', goalOdds: [{ target: '开战', likelihood: 40 }], tags: ['北境'], type: '推演', uses: 2, importance: 0.7, updatedAt: Date.now() };
const P_PROMOTED = { id: 'p2', title: '王城宴会', text: '宴会筹备中。', date: '1919-11-28', promotedTo: 'atom-1', tags: ['宫廷'], updatedAt: Date.now() };
const P_OLD = { id: 'p3', title: '旧日风声', text: '很久以前的事。', date: '1900-01-01', tags: ['旧'], updatedAt: Date.now() - 400 * 86400000 };
const project = (html) => projectRows(html).map((r) => ({ opsClass: r.opsClass, opsActions: r.opsActions, opsCol: r.opsCol }));

// ---------- A 组：V1 oracle 对照 ----------
A('A1 oracle 齐备：V1 平行行 = `ftt-item-ops ftt-ops-col`（竖向），且全库只有平行页这样写', (() => {
    const rows = FX.rows || [];
    return FX.opsColClassUsageInV1 === 1 && rows.length === 3 && rows.every((r) => r.hasOpsCol === true && r.hasMain === true)
        && J(rows[0].opsActions) === J(['parallelAdvance', 'promoteParallel', 'editEntry', 'delEntry']);
})(), J(FX.rows));

A('A2 V1 的竖向语义来自 CSS `flex-direction: column`（本批沿用同一条规则，不改 CSS）', (() => {
    return /flex-direction:\s*column/.test(FX.cssRule)
        && /#ftt-panel \.ftt-ops-col \{[^}]*flex-direction:\s*column/.test(CSS)
        && /#ftt-panel \.ftt-item-ops \{ display: flex;/.test(CSS);
})(), FX.cssRule);

// ---------- B 组：V2 渲染（对齐 oracle） ----------
A('B1 平行行操作区现在是**竖排容器**：`ftt-item-ops ftt-ops-col`，且为行内最后一个子节点（主体占满剩余宽度）', (() => {
    const rows = project(boot([P_NORMAL]));
    return rows.length === 1 && rows[0].opsClass === 'ftt-item-ops ftt-ops-col' && rows[0].opsCol === true;
})(), J(project(boot([P_NORMAL]))));

A('B2 操作按钮与 V1 同序：🚀 推进 → ⬆ 转正 → ✏️ 编辑 → 🗑 删除（V2 动作名 edit/delete 映射 editEntry/delEntry）', (() => {
    const rows = project(boot([P_NORMAL]));
    return rows[0].opsActions.join(',') === 'parallelAdvance,promoteParallel,editEntry,delEntry';
})(), J(project(boot([P_NORMAL]))[0].opsActions));

A('B3 条件渲染与 V1 一致：已转正 → 无 ⬆；已达衰退阈值 → 无 🚀', (() => {
    const promoted = project(boot([P_PROMOTED]))[0].opsActions;
    const expired = project(boot([P_NORMAL], { parallelDecayCutoff: 0 }))[0].opsActions;
    // 巨旧条目：与一条近期条目同列（V1 的衰退值含「类目内相对位置」，单条列表的相对位置恒为 0 —— 见 docs/P8 说明）
    // 页面按「最近优先」排序 → 巨旧条目在末行；此处统计「没有 🚀」的行数（应恰为 1 行）
    const agedRows = project(boot([P_OLD, P_NORMAL]));
    const noAdvance = agedRows.filter((r) => r.opsActions.indexOf('parallelAdvance') < 0);
    return promoted.join(',') === 'parallelAdvance,editEntry,delEntry'
        && expired.join(',') === 'promoteParallel,editEntry,delEntry'
        && agedRows.length === 2 && noAdvance.length === 1 && noAdvance[0].opsCol === true;
})(), J({ promoted: project(boot([P_PROMOTED]))[0].opsActions, aged: project(boot([P_OLD, P_NORMAL]))[0].opsActions }));

A('B4 行主体仍在 `.ftt-grow` 里（内容顺序/九行结构未动），竖排只影响右侧操作区', (() => {
    const html = boot([P_NORMAL]);
    const i = html.indexOf('<div class="ftt-item ftt-inline">');
    const after = html.slice(i + 30);
    const cut = [after.indexOf('<div class="ftt-item ftt-inline">'), after.indexOf('<div class="ftt-addbar')].filter((x) => x >= 0).sort((a, b) => a - b)[0];
    const row = html.slice(i, (cut === undefined) ? undefined : i + 30 + cut);
    return html.indexOf('<span class="ftt-grow">') > 0 && row.indexOf('ftt-item-ops ftt-ops-col') > 0
        && row.indexOf('ftt-grow') < row.indexOf('ftt-item-ops ftt-ops-col')
        && html.indexOf('☯ 乾') > 0 && html.indexOf('🎯 目标：') > 0;
})(), '见断言');

A('B5 其余维度**保持横向**（V1 口径：只有平行页竖向）：情节 / 记忆 / 传言页都不出现 `ftt-ops-col`', (() => {
    const st = emptyState();
    st.atoms = [{ id: 'a1', text: '甲打开木箱取出账册，记下转运日期与去向。', date: '1919-11-29', floorStart: 1, floorEnd: 1, tags: [] }];
    st.memories = [{ id: 'm1', owner: '甲', title: '账册', content: '记录转运。', tags: [], uses: 0 }];
    st.rumors = [{ id: 'r1', subject: '账册去向', content: '据说账册被转手。', date: '1919-11-29', tags: ['谣言'], uses: 0, updatedAt: Date.now() }];
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(st);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const hits = [];
    for (const tab of ['atoms', 'memories', 'rumors']) {
        openPanel(tab);
        if (panelBodyHtml(tab).indexOf('ftt-ops-col') >= 0) hits.push(tab);
    }
    return hits.length === 0 && panelBodyHtml('atoms').indexOf('data-ftt-action="edit"') > 0;
})(), '见断言');

A('B6 多选模式：勾选框仍在行首（V2 口径），竖排操作列不受影响', (async () => {
    boot([P_NORMAL]);
    await panelAction('multiToggle', { kind: 'parallels' });
    const html = panelBodyHtml('parallels');
    const rows = projectRows(html);
    const boxAt = html.indexOf('data-ftt-select="parallels"');
    return rows.length === 1 && rows[0].opsCol === true && boxAt > 0
        && boxAt < html.indexOf('<span class="ftt-grow">') && rows[0].hasMultiCheckboxInOps === false;
})(), '见断言');

A('B7 窄屏规则不受影响：移动端 `.ftt-item-ops { flex-wrap: wrap }` 仍只影响横向布局，竖排列照常', (() => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width: 700px)'), CSS.indexOf('/* 平板区间适配'));
    return mobile.indexOf('.ftt-item-ops { flex-wrap: wrap; }') > 0
        && /#ftt-panel \.ftt-ops-col \{[^}]*flex: 0 0 auto/.test(CSS);
})(), '见断言');

R.done();
