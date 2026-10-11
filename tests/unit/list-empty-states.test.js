// ============================================================
// 单元测试 · v3.43.0 `docs/D22` `应-12` ① —— **11 个维度列表页的空态逐页核对**（`docs/D9` §9 **C4** / §10 **U3**）
//
// 缺陷（`docs/D19` §3.5 应-12）：`D9` 附·核实边界 长期记着「每个列表页的空态文案现状 **未逐页核对**」——
//   即「有 `.ftt-empty` 元素」这一条由 `check-ui-spec` C4 兜着（≥11 处），但**每一页到底写了什么、
//   是不是「为什么空 + 下一步做什么」两段式**，从来没有人逐页看过。
//
// 本文件把那次人工走查**机械化**：逐页渲染**空内核态**，断言每页都给出非空引导文案，
//   并逐条打印出来（人工一眼可核；输出即 `docs/D9` 附·核实边界登记的证据）。
//
// 运行：node tests/unit/list-empty-states.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelBodyHtml, setPanelHooks2, openPanel, PANEL_TABS } from '../../ui/panel.js';

const R = makeReporter('list-empty-states v3.43.0 空态逐页核对（D22 应-12 ①）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 11 个**维度列表页**（`总览` / `设置` 不是列表页，不参与本判据） */
const LIST_TABS = PANEL_TABS.map((x) => x[0]).filter((id) => id !== 'overview' && id !== 'settings');

/** 起一套**全空**的内核态（空态分支的唯一触发条件） */
function bootEmpty() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(0);
    setKernelState(emptyState());
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    try { setLoadPhase('ready'); } catch (e) { /* 忽略 */ }
    openPanel('overview');
}

/** 取该页 HTML 里的空态文案（第一个 `.ftt-empty` 的可见文本） */
function emptyTextOf(html) {
    const m = String(html).match(/<div class="ftt-empty"[^>]*>([\s\S]*?)<\/div>/);
    return m ? String(m[1]).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

const seen = [];
A('E1 11 个维度列表页在**空内核态**下**逐个**给出 `.ftt-empty` 引导文案（漏一页即失败）', (() => {
    bootEmpty();
    const missing = [];
    for (const id of LIST_TABS) {
        const txt = emptyTextOf(panelBodyHtml(id));
        seen.push({ tab: id, text: txt });
        if (!txt) missing.push(id);
    }
    return LIST_TABS.length === 11 && missing.length === 0;
})(), (() => J(seen)));

A('E2 空态是「为什么空 + 下一步做什么」两段式（文案 ≥ 10 字，且不是「暂无数据」这类无信息量的一句）', (() => {
    const bad = seen.filter((x) => x.text.length < 10 || /^(暂无数据|无数据|空|没有数据)[。！]?$/.test(x.text));
    return bad.length === 0;
})(), (() => J(seen.map((x) => [x.tab, x.text.length, x.text.slice(0, 46)])))());

A('E3 通用空态文案可共用（同属「无条目」的页允许同一句），但**必须写明下一步动作**（含「摘要 / 添加 / 提取」其一）', (() => {
    const generic = seen.filter((x) => x.text.indexOf('暂无条目') >= 0 || x.text.indexOf('暂无') >= 0);
    const noNext = generic.filter((x) => !/(摘要|添加|提取|创建|生成)/.test(x.text));
    return generic.length >= 1 && noNext.length === 0;
})(), (() => J(seen.map((x) => [x.tab, x.text])))());

R.done();
