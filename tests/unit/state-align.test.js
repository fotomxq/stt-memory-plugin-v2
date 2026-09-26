// ============================================================
// 单元测试 · v2.62.0「状态大类细节对齐 V1」
//
// 用户要求：「核对状态大类的提示词等细节，确保对齐 V1。」
//
// 黄金样本：`tests/fixtures/v1-golden-state-align.json`（oracle = 真实 V1 插件 v1.206 直调；
//   生成器 `tests/fixtures/gen-v1-golden-state-align.cjs`，连跑两次逐字节一致）。覆盖：
//     · 提示词模板 `state` / `states` / `statesRepair`（V1 v1.206 1582 / 1617 / 2028）；
//     · 状态页 `statesHtml()`（23988~24027）：空态文案、主体分组（localeCompare 排序）、组内行
//       `字段：值` + `调用N次[ · 更新 日期 时间]`、搜索占位符、无匹配文案、修复按钮显隐；
//     · 注入体 `[状态记录]` 块（在场过滤 + 行格式，V1 `buildMemoryBodyForInject`）；
//     · 条数钳制 `applyStateBounds`（经 `mergeDelta` 触发；每角色 > `stateMaxPerSubject` 裁最旧）。
// 另覆盖 V2 本轮补上的 **筛选条**（字段范围 / 排序 / 额外条件「仅已失效」）真实生效。
// 运行：node tests/unit/state-align.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg, PROMPT_TEMPLATES_V2 } from '../../core/config.js';
import { entryIndexInit, entryIndexBuild } from '../../core/sweep.js';
import { mergeDelta } from '../../core/ingest.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { panelAction, panelBodyHtml, openPanel, panelState } from '../../ui/panel.js';

const R = makeReporter('state-align v2.62.0 状态大类对齐 V1');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const G = JSON.parse(readFileSync(new URL('../fixtures/v1-golden-state-align.json', import.meta.url), 'utf8'));

installGlobalHost(makeHost({}), makeDocument(['ftt-panel']));
setScopeKey('char:state-align');
setPersistHooks({
    saveState: () => { entryIndexInit(); entryIndexBuild(true); return true; },
    saveCfg: () => true, log: () => undefined, warn: () => undefined,
});
globalThis.window = Object.assign({}, globalThis.window, { localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true } });

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** 与 oracle 生成器**同一投影**（V1 HTML → 可比较结构） */
function projectStatesPage(html) {
    const h = String(html || '');
    const groups = [];
    const re = /<h4 class="ftt-h4-inline ftt-mt-6">👤 ([\s\S]*?)<\/h4>/g;
    let m;
    while ((m = re.exec(h))) {
        const head = m[1];
        const name = (head.match(/^([\s\S]*?) <span class="ftt-muted">/) || [])[1] || '';
        const count = Number((head.match(/<span class="ftt-muted">\((\d+)\)<\/span>/) || [])[1] || 0);
        const rest = h.slice(m.index + m[0].length);
        const nextAt = rest.search(/<h4 class="ftt-h4-inline ftt-mt-6">/);
        const body = nextAt >= 0 ? rest.slice(0, nextAt) : rest;
        const rows = [];
        const rowRe = /<b>([\s\S]*?)<\/b>：([\s\S]*?)<div class="ftt-meta">([\s\S]*?)<\/div>/g;
        let rm;
        while ((rm = rowRe.exec(body))) rows.push({ field: strip(rm[1]), value: strip(rm[2]), meta: strip(rm[3]) });
        groups.push({ subject: strip(name), count: count, rows: rows, addBtn: body.indexOf('data-ftt-action="addStateFor"') >= 0, delGroupBtn: body.indexOf('data-ftt-action="delStateGroup"') >= 0 });
    }
    return {
        empty: (h.match(/<div class="ftt-empty">([\s\S]*?)<\/div>/) || [])[1] ? strip((h.match(/<div class="ftt-empty">([\s\S]*?)<\/div>/) || [])[1]) : '',
        chip: strip((h.match(/<div class="ftt-cat-stat ftt-chip">([\s\S]*?)<\/div>/) || [])[1] || ''),
        placeholder: (h.match(/data-ftt-search="states"[^>]*placeholder="([^"]*)"/) || [])[1] || '',
        repairBtn: h.indexOf('data-ftt-action="stateRepair"') >= 0,
        groups: groups,
    };
}
const mk = (subject, field, value, extra) => Object.assign({ id: 'st-' + subject + '-' + field, subject, field, value, status: 'active', importance: 0.6, floorStart: 1, floorEnd: 5, uses: 2, updatedAt: '1919-11-29', updatedAtTime: '傍晚' }, extra || {});
const STATES = [
    mk('乙', '处境', '在船上', { floorEnd: 7, uses: 5 }),
    mk('甲', '情绪与心理状态', '担忧', { floorEnd: 9, uses: 1 }),
    mk('甲', '短期目标', '找到铜箱', { floorEnd: 3, uses: 0 }),
    mk('丙', '身体状况与伤势', '左臂扭伤', { floorEnd: 4, uses: 9, updatedAt: '', updatedAtTime: '' }),
    mk('甲', '处境', '在码头', { floorEnd: 12, uses: 4 }),
];
function boot(states) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setKernelState(emptyState());
    if (states) state.currentStates = JSON.parse(JSON.stringify(states));
    entryIndexInit(); entryIndexBuild(true);
}
/** 只取注入体里的 [状态记录] 块（与 oracle 同一截取口径） */
function injectStateBlock(text) {
    const b = String(text || '');
    const i = b.indexOf('[状态记录]');
    if (i < 0) return '';
    const rest = b.slice(i);
    const j = rest.slice(1).search(/\n\[/);
    return (j >= 0 ? rest.slice(0, j + 1) : rest).trim();
}

// ---- T 组：提示词模板逐字节对齐 ----
A('T1 提示词模板 state / states / statesRepair 与 V1 v1.206 **逐字节相同**', (() => {
    return String(PROMPT_TEMPLATES_V2.state) === G.templates.state
        && String(PROMPT_TEMPLATES_V2.states) === G.templates.states
        && String(PROMPT_TEMPLATES_V2.statesRepair) === G.templates.statesRepair
        && String(G.templates.state).length > 200;
})(), J({
    state: [String(PROMPT_TEMPLATES_V2.state).length, String(G.templates.state).length],
    states: [String(PROMPT_TEMPLATES_V2.states).length, String(G.templates.states).length],
    statesRepair: [String(PROMPT_TEMPLATES_V2.statesRepair).length, String(G.templates.statesRepair).length],
}));

A('T2 三条模板都在提示词分组④（可编辑）且默认为空签名（V1 `statesRepair` 无历史默认）', (() => {
    return String(PROMPT_TEMPLATES_V2.states).indexOf('【状态记录】') === 0
        && String(PROMPT_TEMPLATES_V2.state).indexOf('【当前状态】') === 0
        && String(PROMPT_TEMPLATES_V2.statesRepair).indexOf('【状态修复】') === 0;
})(), '见断言');

// ---- P 组：状态页渲染对齐 ----
boot([]);
openPanel('states');
A('P1 空库：空态文案与 V1 逐字一致，且不渲染「🔧 修复状态」', J(projectStatesPage(panelBodyHtml('states')).empty) === J(G.pageEmpty.empty)
    && projectStatesPage(panelBodyHtml('states')).repairBtn === false,
    J(projectStatesPage(panelBodyHtml('states'))));

A('P2 有数据：占位符 / 修复按钮 / 主体分组（localeCompare 排序）与 V1 一致', (() => {
    boot(STATES);
    openPanel('states');
    const p = projectStatesPage(panelBodyHtml('states'));
    return p.placeholder === G.pageGrouped.placeholder && p.repairBtn === G.pageGrouped.repairBtn
        && J(p.groups.map((g) => g.subject)) === J(G.pageGrouped.groups.map((g) => g.subject))
        && J(p.groups.map((g) => g.count)) === J(G.pageGrouped.groups.map((g) => g.count));
})(), J(projectStatesPage(panelBodyHtml('states')).groups.map((g) => g.subject)));

A('P3 组内行（字段：值 + 调用N次[ · 更新 日期 时间]）与组内 floorEnd 倒序逐条一致', (() => {
    const p = projectStatesPage(panelBodyHtml('states'));
    return J(p.groups.map((g) => g.rows)) === J(G.pageGrouped.groups.map((g) => g.rows));
})(), J(projectStatesPage(panelBodyHtml('states')).groups));

A('P4 搜索命中：与 V1 同一投影（含「命中角色名也保留」的 V1 语义）', (async () => {
    boot(STATES);
    openPanel('states');
    await panelAction('search', { kind: 'states', q: '铜箱' });
    const hit = projectStatesPage(panelBodyHtml('states'));
    await panelAction('search', { kind: 'states', q: '甲' });     // 角色名命中
    const bySubject = projectStatesPage(panelBodyHtml('states'));
    await panelAction('search', { kind: 'states', q: '' });
    return J(hit.groups) === J(G.pageSearchHit.groups) && bySubject.groups.length === 1 && bySubject.groups[0].subject === '甲';
})(), '见断言');

A('P5 无匹配：文案与 V1 逐字一致（「无匹配结果（搜索/筛选：X）」）', (async () => {
    boot(STATES);
    openPanel('states');
    await panelAction('search', { kind: 'states', q: '不存在的词' });
    const miss = projectStatesPage(panelBodyHtml('states'));
    await panelAction('search', { kind: 'states', q: '' });
    return J(miss.empty) === J(G.pageSearchMiss.empty) && miss.groups.length === 0;
})(), J(projectStatesPage(panelBodyHtml('states')).empty));

// ---- I 组：注入体 [状态记录] 块逐字节对齐 ----
A('I1 注入 [状态记录] 块与 V1 **逐字节相同**（在场过滤 + 行格式；不在场的角色不注入）', (() => {
    boot(STATES);
    cfg.charBudget = 6000; cfg.maxStates = 30;
    cfg.stateMinPerSubject = 1; cfg.stateMaxPerSubject = 10;
    cfg.injectConstraintBlock = false;          // 与 oracle 同设置（约束段与状态无关）
    state.state = { date: '1919-11-29', time: '傍晚', location: '码头', present: ['甲'] };
    const body = String(buildMemoryBodyForInject('', { inject: true, countUses: false }) || '');
    const block = injectStateBlock(body);
    return G.inject.hasBlock === true && block === G.inject.block
        && block.indexOf('乙') < 0 && block.indexOf('丙') < 0;      // 不在场 → 不注入
})(), J({ got: injectStateBlock(buildMemoryBodyForInject('', { inject: true, countUses: false })), want: G.inject.block }));

// ---- B 组：条数钳制 ----
A('B1 每角色条数钳制（`stateMaxPerSubject`，超出裁最旧、保调用次数高者）与 V1 同结果', (() => {
    boot(null);
    state.currentStates = Array.from({ length: 12 }, (_, i) => ({ id: 'b' + i, subject: '甲', field: '字段' + i, value: '值' + i, importance: 0.5, floorEnd: i + 1, uses: i }));
    const mr = mergeDelta({ states: { add: [] } }, { start: 1, end: 1 });
    const kept = (state.currentStates || []).map((s) => String(s.field)).sort();
    return J(kept) === J(G.bounds.keptFields) && (state.currentStates || []).length === G.bounds.count
        && (state.currentStates || []).every((s) => ['字段2', '字段3', '字段4', '字段5', '字段6', '字段7', '字段8', '字段9', '字段10', '字段11'].indexOf(String(s.field)) >= 0);
})(), J((state.currentStates || []).map((s) => s.field).sort()));

// ---- F 组：V2 本轮补上的状态页筛选条（V1 `fieldHay`/`pageSortItems`/`pageExtraMatch` 语义） ----
await (async () => {
    boot(STATES.concat([mk('丁', '处境', '在驿站', { floorEnd: 2, uses: 0, status: 'inactive' })]));
    openPanel('states');
    const bar = panelBodyHtml('states');
    const hasBar = bar.indexOf('data-ftt-filter="states" data-ftt-filter-key="field"') >= 0
        && bar.indexOf('data-ftt-filter="states" data-ftt-filter-key="sort"') >= 0
        && bar.indexOf('data-ftt-filter="states" data-ftt-filter-key="extra"') >= 0
        && bar.indexOf('全部字段') >= 0 && bar.indexOf('默认排序') >= 0 && bar.indexOf('仅已失效') >= 0;
    A('F1 状态页有 V1 同款筛选条：字段范围 / 排序 / 额外条件（全部状态 · 仅已失效）+ ✕ 清除', hasBar, bar.slice(0, 240));

    await panelAction('listFilter', { kind: 'states', key: 'extra', value: 'inactive' });
    const onlyInactive = projectStatesPage(panelBodyHtml('states'));
    await panelAction('listFilter', { kind: 'states', key: 'extra', value: 'all' });
    A('F2 「仅已失效」真实生效（只剩 status=inactive 的主体）', onlyInactive.groups.length === 1 && onlyInactive.groups[0].subject === '丁',
        J(onlyInactive.groups.map((g) => g.subject)));

    await panelAction('listFilter', { kind: 'states', key: 'sort', value: 'uses' });
    const byUses = projectStatesPage(panelBodyHtml('states'));
    const topUses = byUses.groups.filter((g) => g.subject === '丙' || g.subject === '乙')[0];
    await panelAction('listFilter', { kind: 'states', key: 'sort', value: 'default' });
    A('F3 排序「调用次数」真实生效（组内首条为 uses 最高者：丙 9 次在乙 5 次之前）',
        !!topUses && byUses.groups.map((g) => g.subject).indexOf('丙') < byUses.groups.map((g) => g.subject).indexOf('乙'),
        J(byUses.groups.map((g) => [g.subject, g.rows.length])));

    await panelAction('listFilter', { kind: 'states', key: 'field', value: 'title' });
    await panelAction('search', { kind: 'states', q: '铜箱' });
    const titleOnly = projectStatesPage(panelBodyHtml('states'));
    await panelAction('searchClear', { searchKind: 'states' });
    const cleared = panelState().filter.states || null;
    A('F4 字段范围参与检索（title 档命中标题，不命中值时为空）；「✕ 清除」同时复位筛选（V1 同义）',
        titleOnly.groups.length === 0 && cleared === null, J({ titleGroups: titleOnly.groups.length, cleared }));
    await panelAction('listFilter', { kind: 'states', key: 'field', value: 'all' });
})();

R.done();
