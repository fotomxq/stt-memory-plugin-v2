// ============================================================
// 单元测试 · v3.46.7 列表渐进展示（`docs/D22` §4.4 W15 `应-1` / `docs/D9` §10 **U1**）
//
// 设计原则（原话）：「列表页默认 **50 条 / 屏**，超出给『显示更多』；**搜索或筛选变更即重置到首屏**，
//   不做跨条件的隐式累积」；「本项是**渐进展示**…**不含虚拟滚动 / 真分页**」。
//
// 本文件锁四件事：
//   ① **步长与上限** —— 首屏 50、按屏追加、到 `LIST_PAGE_MAX` 停（不倒退成无限渲染）；
//   ② **重置口径** —— 搜索 / 筛选变更即回首屏（`pageReset`），且是**幂等**的（重复重置无副作用）；
//   ③ **端到端（真实面板）** —— 300 条数据下首屏只渲染 50 行、有「显示更多」按钮，
//      点它 → 100 行；改筛选 / 搜索 → 回到 50 行；
//   ④ **反向探针** —— 把步长改回「一次给完」的形态会被本文件抓住（下述断言直接读真实渲染行数）。
//
// 运行：node tests/unit/list-pager.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { openPanel, panelAction, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';
import {
    LIST_PAGE_SIZE, LIST_PAGE_STEP, LIST_PAGE_MAX,
    pageLimitOf, pageShowMore, pageReset, pageResetAll, pageInfoOf, listPagerState,
} from '../../ui/list-pager.js';
import { listMatch, listOfInfoWith } from '../../ui/list-of.js';

const R = makeReporter('list-pager v3.46.7 列表渐进展示（D22 W15 应-1 / D9 U1）');
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const J = (v) => JSON.stringify(v === undefined ? null : v);

// ---------- ① 步长与上限（纯函数） ----------
A('A1 首屏 = 50 条（`docs/D9` §10 U1）', LIST_PAGE_SIZE === 50, 'LIST_PAGE_SIZE=' + LIST_PAGE_SIZE);
A('A2 追加步长 = 50（一屏一屏给）', LIST_PAGE_STEP === 50, 'LIST_PAGE_STEP=' + LIST_PAGE_STEP);
A('A3 外框上限 = 300（沿用 `docs/D13` 的既有截断值，不倒退）', LIST_PAGE_MAX === 300, 'LIST_PAGE_MAX=' + LIST_PAGE_MAX);

pageResetAll();
A('A4 未展开的维度回落到首屏', pageLimitOf('atoms') === 50, 'limit=' + pageLimitOf('atoms'));
A('A5 一次「显示更多」→ 100', pageShowMore('atoms') === 100, 'limit=' + pageLimitOf('atoms'));
A('A6 再点 → 150（按屏追加，不是翻倍）', pageShowMore('atoms') === 150, 'limit=' + pageLimitOf('atoms'));
pageResetAll();
A('A7 追加到上限即停（不透支渲染成本）', (() => {
    for (let i = 0; i < 20; i++) pageShowMore('atoms');
    return pageLimitOf('atoms') === LIST_PAGE_MAX;
})(), 'limit=' + pageLimitOf('atoms'));

// ---------- ② 重置口径 ----------
A('B1 `pageReset` 回到首屏', pageReset('atoms') === 50 && pageLimitOf('atoms') === 50, J(pageLimitOf('atoms')));
pageShowMore('atoms'); pageShowMore('atoms');
A('B2 重置是幂等的（重复调用无副作用）', (() => {
    const a = pageReset('atoms'), b = pageReset('atoms');
    return a === 50 && b === 50 && pageLimitOf('atoms') === 50;
})(), J(pageLimitOf('atoms')));
A('B3 维度之间互不影响（重置 A 不动 B）', (() => {
    pageResetAll(); pageShowMore('memories');
    pageReset('atoms');
    return pageLimitOf('memories') === 100 && pageLimitOf('atoms') === 50;
})(), J(listPagerState().shown));

// ---------- ③ 读数形状（`pageInfoOf`） ----------
A('C1 剩余量与 hasMore（还有 250 条 → 按钮出现，步长 50）', (() => {
    pageResetAll();
    const p = pageInfoOf('atoms', 50, 300);
    return p.shown === 50 && p.matched === 300 && p.remaining === 250 && p.hasMore === true && p.step === 50;
})(), J(pageInfoOf('atoms', 50, 300)));
A('C2 全部给完 → hasMore=false（按钮消失）', pageInfoOf('atoms', 300, 300).hasMore === false);
A('C3 命中不足一屏 → hasMore=false', pageInfoOf('atoms', 12, 12).hasMore === false);
A('C4 到外框上限后不再有「显示更多」（即使还有更多匹配）', (() => {
    pageResetAll();
    for (let i = 0; i < 20; i++) pageShowMore('atoms');
    const p = pageInfoOf('atoms', 300, 900);
    return p.hasMore === false && p.remaining === 600;
})(), J(pageInfoOf('atoms', 300, 900)));

// ---------- ④ 纯查询：截断前给总数（`应-1` 的必要条件） ----------
A('D1 `listOfInfoWith` 同时给「渲染行」与「匹配总数」', (() => {
    const arr = Array.from({ length: 120 }, (_, i) => ({ id: 'i' + i, title: 't' + i }));
    const r = listOfInfoWith({ arr: () => arr, match: () => true }, 'atoms', '', 50);
    return r.list.length === 50 && r.total === 120 && r.pager.remaining === 70;
})(), 'n/a');
A('D2 不给 limit 时用渐进展示的当前上限（首屏 50）', (() => {
    pageResetAll();
    const arr = Array.from({ length: 120 }, (_, i) => ({ id: 'i' + i }));
    const r = listOfInfoWith({ arr: () => arr, match: () => true }, 'atoms', '', undefined);
    return r.list.length === 50 && r.total === 120;
})(), 'n/a');
A('D3 未注入 match → 全量匹配（与旧 `listOf` 的容错口径一致）', (() => {
    const r = listOfInfoWith({ arr: () => [{ id: 'a' }, { id: 'b' }] }, 'atoms', '', 10);
    return r.total === 2 && r.list.length === 2;
})(), 'n/a');
A('D4 空数组 / 读不到数组都不抛错', (() => {
    const a = listMatch(null, '', 'all', '', {});
    const b = listOfInfoWith({}, 'atoms', '', 10);
    return a.total === 0 && b.total === 0 && b.list.length === 0;
})(), 'n/a');

// ---------- ⑤ 端到端：真实面板渲染 ----------
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
await import('../../index.js');

function bootAtoms(n) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    const st = emptyState();
    st.atoms = Array.from({ length: n }, (_, i) => ({ id: 'a' + i, title: '情节 ' + i, text: '正文 ' + i, floorEnd: i + 1 }));
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save: () => { } });
    setLastMessageId(1);
    setPanelHooks2({});
    pageResetAll();
}
/** 渲染当前情节页并返回 HTML */
function body() { return panelBodyHtml('atoms'); }
/** 数渲染出来的行数（情节列表行 = `.ftt-item.ftt-inline`） */
function rowCount(html) { return (String(html).match(/class="ftt-item ftt-inline"/g) || []).length; }

bootAtoms(300);
openPanel('atoms');
await panelAction('searchClear', { searchKind: 'atoms' });   // 清掉跨用例残留的搜索词（面板态是模块级）
const h1 = body();
A('E1 300 条数据下**首屏只渲染 50 行**（不是 300）', rowCount(h1) === 50, 'rows=' + rowCount(h1));
A('E2 首屏出现「显示更多（+50）」', String(h1).indexOf('显示更多（+50）') >= 0, '缺少按钮');
A('E3 计数行给**真实总数**（截断后行数只有 50，但报的是 300）', (() => {
    return String(h1).indexOf('共 300 条') >= 0 && String(h1).indexOf('共 50 条') < 0;
})(), '计数被截断行数污染');
A('E4 同时报「已显示 50 条」', String(h1).indexOf('已显示 50 条') >= 0, '缺少已显示读数');

await panelAction('showMore', { kind: 'atoms' });
const h2 = body();
A('E5 点「显示更多」→ 渲染 100 行', rowCount(h2) === 100, 'rows=' + rowCount(h2));
A('E6 按钮继续给（+50）', String(h2).indexOf('显示更多（+50）') >= 0, '按钮消失');

await panelAction('listFilter', { kind: 'atoms', key: 'sort', value: 'important' });
const h3 = body();
A('E7 筛选变更 → **重置回首屏 50 行**（不做隐式累积）', rowCount(h3) === 50, 'rows=' + rowCount(h3));

await panelAction('showMore', { kind: 'atoms' });
A('E8 重置后再点仍从 50 开始追加', rowCount(body()) === 100, 'rows=' + rowCount(body()));

await panelAction('search', { kind: 'atoms', q: '情节' });
A('E9 搜索变更 → 重置回首屏', rowCount(body()) === 50, 'rows=' + rowCount(body()));
A('E10 搜索后计数为匹配数（300 条全命中）', String(body()).indexOf('匹配 300') >= 0, '计数不对');

await panelAction('search', { kind: 'atoms', q: '情节 1' });
A('E11 收窄搜索后行数不超过命中数（50 与命中取小）', (() => {
    const n = rowCount(body());
    return n > 0 && n <= 50;
})(), 'rows=' + rowCount(body()));

bootAtoms(30);
openPanel('atoms');
await panelAction('searchClear', { searchKind: 'atoms' });
A('E12 不足一屏（30 条）→ 无「显示更多」、全部渲染', (() => {
    const h = body();
    return rowCount(h) === 30 && String(h).indexOf('显示更多') < 0;
})(), 'rows=' + rowCount(body()));

// 反向探针：把外框上限当作「一次给完」会立刻被 E1/E5 抓住（此处显式证明上限仍是 300，而不是无上限）
A('F1 反向探针：外框上限仍是 300（改成「一次给完」会让 E1 变红）', LIST_PAGE_MAX === 300 && LIST_PAGE_SIZE !== LIST_PAGE_MAX);

un();
R.done();
