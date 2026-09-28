// ============================================================
// 单元测试 · v2.96.0「总览的可点击单楼分析，点击没任何反应」修复
//
// 用户报告（原话）：「总览的可点击单楼分析，点击没任何反应。」
//
// 核对结论（两类原因，逐条锁定在本文件）：
//   ① **长耗时动作没有任何即时反馈**：`summaryFloor` 要等一次 AI 生成（数秒~数十秒），
//      而提示行只在动作结束后的那次重绘里才出现 → 点了以后界面上**什么都不变**，看起来就是「没反应」。
//      V1 对应实现是：按钮立刻叠加 `.ftt-loading` 转圈并 `disabled`（`btn.classList.add('ftt-loading')`）、
//      状态文案立刻更新、结束时 `notify()` 弹一条结果 —— V2 的 CSS 早就在 `style.css` 里，**JS 一直没接上**。
//   ② **`panelAction()` 的十余处「前置条件早退」绕过了函数末尾的 `renderPanel()`**：
//      刚 `setNote('…入口未就绪')` 写下的提示永远不出现在界面上，返回对象里连 `html`/`state` 都没有。
//      → 修法：所有返回路径（含早退与异常）统一经 `finalizePanelAction()`（渲染 + 通知 + 交互留痕）。
//
// 覆盖：A 早退也重绘；B 即时反馈；C 通知；D 防连点与批次占用；E 结果文案；F 真实点击的转圈态。
// 运行：node tests/unit/floor-click.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    openPanel, panelState, panelAction, panelBodyHtml, setPanelHooks2, singleFloorBusyState, unmountPanel,
} from '../../ui/panel.js';

const R = makeReporter('floor-click v2.96.0 单楼分析点击修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);

function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:floor-click');
    const st = emptyState();
    st.processedFloors = [];
    st.atoms = [];
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    openPanel('overview');
}
boot();

/** 挂一组可控的面板钩子（记录调用，返回可编排的结果） */
function wire(opts) {
    const o = opts || {};
    const calls = { extract: [], notify: [] };
    setPanelHooks2({
        pending: () => [4, 5],
        busy: () => !!o.busy,
        extract: async (arg) => {
            calls.extract.push(arg);
            if (o.extractDelay) await new Promise((r) => setTimeout(r, o.extractDelay));
            if (typeof o.extractResult === 'function') return o.extractResult(arg);
            return { ok: true, added: 2, total: 9, floor: Number(arg && arg.floor) };
        },
        notify: (kind, text) => { calls.notify.push([String(kind), String(text)]); return true; },
        clearInject: () => true,
        inject: async () => ({ ok: true, chars: 12 }),
    });
    return calls;
}

// ---------- A 组：早退路径也要重绘（根因②） ----------
A('A1 前置条件缺失的**早退**也经统一收尾：返回对象带 `html` 与 `state`，提示行真的写进了渲染结果（修复前这两者都没有 → 界面上毫无反应）', (async () => {
    boot();
    setPanelHooks2({ pending: () => [], extract: undefined });
    const r = await panelAction('summaryFloor', { floor: 4 });
    const html = String(r.html || '');
    const note = String((r.state || {}).note || '');
    return r.ok === false && r.reason === 'no-hook'
        && note === '提取入口未就绪'
        && html.indexOf('data-ftt-note') >= 0 && html.indexOf('提取入口未就绪') >= 0;
})(), () => J({ ok: false, reason: 'no-hook' }));

A('A2 同类早退逐项覆盖（提取 / 注入 / 批量摘要 / 导出 / 导入）：每个都返回 `html` 且提示可见', (async () => {
    boot();
    setPanelHooks2({ pending: () => [] });                 // 所有钩子都不接 → 各动作走早退
    const cases = [
        ['summaryFloor', { floor: 4 }, '提取入口未就绪'],
        ['inject', {}, '注入入口未就绪'],
        ['summary', {}, '批量摘要入口未就绪'],
        ['exportState', {}, '导出入口未就绪'],
        ['importStateApply', { text: '' }, '导入入口未就绪'],
    ];
    const bad = [];
    for (const [act, payload, want] of cases) {
        const r = await panelAction(act, payload);
        const note = String((r.state || {}).note || '');
        if (r.ok !== false || typeof r.html !== 'string' || !r.html || note.indexOf(want) < 0) bad.push(act + ':' + note);
    }
    return bad.length === 0;
})(), '');

// ---------- B 组：即时反馈（根因①） ----------
A('B1 点击后**立刻**可见：AI 还在途时提示行已是「正在分析第 4 楼…」，且此时面板已重绘一次（`renderPanel` 已写入新提示）', (async () => {
    boot();
    let duringNote = '';
    let duringHtmlHasNote = false;
    const calls = wire({ extractDelay: 40, extractResult: () => ({ ok: true, added: 2, total: 9, floor: 4 }) });
    const p = panelAction('summaryFloor', { floor: 4 });
    // 立刻（不等 promise）观察 —— 修复前这里还是上一次的提示/空串
    duringNote = String(panelState().note || '');
    duringHtmlHasNote = String(panelBodyHtml('overview') || '').indexOf('正在分析第 4 楼') >= 0;
    const r = await p;
    return duringNote === '正在分析第 4 楼…（AI 生成中，结果会写回记忆并刷新本页）'
        && duringHtmlHasNote === true
        && calls.extract.length === 1 && Number(calls.extract[0].floor) === 4
        && String((r.state || {}).note || '').indexOf('第 4 楼：新增 2 条') >= 0;
})(), () => panelState().note);

A('B2 在途期间总览正文里带 `data-ftt-note` 的提示节点存在（用户不必等 AI 返回就能看到反馈）', (() => {
    boot();
    wire({});
    const h = String(panelBodyHtml('overview') || '');
    return h.indexOf('data-ftt-note') >= 0;
})(), '');

// ---------- C 组：结果通知（V1 的 notify 等价物） ----------
A('C1 开始与结束各通知一次：开头「开始分析…」、成功「分析完成：本次提取 N 条」', (async () => {
    boot();
    const calls = wire({});
    await panelAction('summaryFloor', { floor: 5 });
    const kinds = calls.notify.map((x) => x[0]).join(',');
    return calls.notify.length === 2 && kinds === 'info,success'
        && calls.notify[0][1].indexOf('第 5 楼：开始分析') >= 0
        && calls.notify[1][1].indexOf('分析完成：本次提取 2 条') >= 0;
})(), '');

A('C2 失败也可见且**给出可操作解释**：`empty-floor` 说明「当前刷次无正文 / 被投喂过滤」，其它原因照实回报', (async () => {
    boot();
    const c1 = wire({ extractResult: () => ({ ok: false, reason: 'empty-floor' }) });
    const r1 = await panelAction('summaryFloor', { floor: 4 });
    const c2 = wire({ extractResult: () => ({ ok: false, reason: 'ai-error' }) });
    const r2 = await panelAction('summaryFloor', { floor: 4 });
    return String((r1.state || {}).note || '').indexOf('第 4 楼未完成：empty-floor') >= 0
        && c1.notify[1][0] === 'warning' && c1.notify[1][1].indexOf('没有可分析正文') >= 0
        && String((r2.state || {}).note || '').indexOf('ai-error') >= 0
        && c2.notify[1][1].indexOf('第 4 楼未完成：ai-error') >= 0;
})(), '');

// ---------- D 组：防连点 / 批次占用 ----------
A('D1 同一楼在途时再点**不会重复发起**：第二次立刻返回 busy，且 extract 只被调用一次（修复前可无限连点 → 并发多条 AI 请求）', (async () => {
    boot();
    const calls = wire({ extractDelay: 30 });
    const first = panelAction('summaryFloor', { floor: 4 });
    const second = await panelAction('summaryFloor', { floor: 4 });        // 在途
    const inFlight = singleFloorBusyState();
    await first;
    return second.ok === false && second.reason === 'busy'
        && String(second.state.note || '').indexOf('已在分析中') >= 0
        && calls.extract.length === 1
        && J(inFlight) === J([4])
        && J(singleFloorBusyState()) === J([]);                            // 结束后释放
})(), () => J(singleFloorBusyState()));

A('D2 不同楼可以并行（只在途去重，不误伤）；批次忙时**拒绝**新单楼（V1 `pipelineOccupied()` 等价物）', (async () => {
    boot();
    const calls = wire({ extractDelay: 20 });
    const p4 = panelAction('summaryFloor', { floor: 4 });
    const p5 = panelAction('summaryFloor', { floor: 5 });
    const both = await Promise.all([p4, p5]);
    const okBoth = calls.extract.length === 2 && both.every((r) => r.ok === true);
    // 批次在途
    boot();
    const c2 = wire({ busy: true });
    const r = await panelAction('summaryFloor', { floor: 4 });
    return okBoth && r.ok === false && r.reason === 'busy'
        && String(r.state.note || '').indexOf('批量摘要正在运行') >= 0 && c2.extract.length === 0;
})(), '');

A('D3 非法楼层（空 / NaN / 负数）如实拒绝，不误当作第 0 楼分析（修复前空串会被 Number 成 0 → 去分析第 0 楼）', (async () => {
    boot();
    const calls = wire({});
    const a1 = await panelAction('summaryFloor', { floor: '' });
    const a2 = await panelAction('summaryFloor', { floor: 'abc' });
    const a3 = await panelAction('summaryFloor', { floor: -1 });
    return a1.ok === false && a1.reason === 'bad-floor' && a2.reason === 'bad-floor' && a3.reason === 'bad-floor'
        && String(a1.state.note || '').indexOf('无效楼层') >= 0 && calls.extract.length === 0;
})(), '');

// ---------- E 组：结果与列表联动 ----------
A('E1 成功后：提示写「新增 N 条（共 M）」，且该楼从「未摘要」列表里消失（`pending` 由宿主给出，这里验证渲染取的是新值）', (async () => {
    boot();
    let pending = [4, 5];
    setPanelHooks2({
        pending: () => pending,
        busy: () => false,
        extract: async () => { pending = [5]; return { ok: true, added: 3, total: 12, floor: 4 }; },
        notify: () => true,
    });
    const r = await panelAction('summaryFloor', { floor: 4 });
    const html = String(r.html || '');
    return String((r.state || {}).note || '').indexOf('第 4 楼：新增 3 条（共 12）') >= 0
        && html.indexOf('data-ftt-floor="4"') < 0 && html.indexOf('data-ftt-floor="5"') >= 0;
})(), '');

A('E2 在途楼层的按钮**由渲染持续保持**「分析中」态（禁用 + `.ftt-loading` + title）—— 点击委托叠的类会被立即重绘换掉，故必须由状态驱动', (async () => {
    boot();
    const calls = wire({ extractDelay: 40 });
    const p = panelAction('summaryFloor', { floor: 4 });
    // 立刻重绘后的 HTML：第 4 楼应是「分析中 + 禁用」，第 5 楼仍可点
    const html = String(panelBodyHtml('overview') || '');
    const seg4 = (html.match(/<button[^>]*data-ftt-floor="4"[^>]*>/) || [''])[0];
    const seg5 = (html.match(/<button[^>]*data-ftt-floor="5"[^>]*>/) || [''])[0];
    const okLoading = seg4.indexOf('ftt-loading') >= 0 && seg4.indexOf('disabled') >= 0 && seg4.indexOf('分析中') >= 0;
    const okOther = seg5.indexOf('ftt-loading') < 0 && seg5.indexOf('disabled') < 0;
    await p;
    const after = String(panelBodyHtml('overview') || '');
    const seg4b = (after.match(/<button[^>]*data-ftt-floor="4"[^>]*>/) || [''])[0];
    return okLoading && okOther && calls.extract.length === 1
        && seg4b.indexOf('ftt-loading') < 0 && seg4b.indexOf('disabled') < 0;    // 结束即复原
})(), () => panelBodyHtml('overview').slice(0, 0));

// ---------- F 组：真实点击的转圈态（V1 `.ftt-loading` 等价物） ----------
A('F1 真实点击点击委托：按钮**同步**被叠加 `.ftt-loading` + `disabled`（等 AI 期间用户看得到转圈），提示同帧写入', (async () => {
    boot();
    const calls = wire({ extractDelay: 25 });
    const el = doc.getElementById('ftt-panel');
    // 干净的绑定：先解绑再重绑，确保点击委托挂在当前 overlay 上
    try { el.__fttBound = false; el.listeners = {}; } catch (e) { /* 忽略 */ }
    const { bindOverlay } = await import('../../ui/panel.js');
    bindOverlay();
    const classes = new Set();
    const btn = {
        dataset: { fttAction: 'summaryFloor', fttFloor: '4' },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        disabled: false, title: '',
        closest: () => null,
    };
    const fns = (el.listeners || {}).click || [];
    fns.forEach((fn) => fn({ target: btn, preventDefault() { }, stopPropagation() { } }));
    // **同步**检查（还没到 await 之后的完成阶段）
    const markedOk = classes.has('ftt-loading') === true && btn.disabled === true && btn.title.indexOf('分析中') >= 0;
    const noteNow = String(panelState().note || '');
    await new Promise((r) => setTimeout(r, 60));
    const doneNote = String(panelState().note || '');
    return fns.length > 0 && markedOk && noteNow.indexOf('正在分析第 4 楼') >= 0
        && doneNote.indexOf('第 4 楼：新增 2 条') >= 0 && calls.extract.length === 1;
})(), () => J({ note: panelState().note }));

A('F2 点击委托对**非**单楼动作不加转圈态（避免误伤其它按钮）', (async () => {
    boot();
    wire({});
    const el = doc.getElementById('ftt-panel');
    try { el.__fttBound = false; el.listeners = {}; } catch (e) { /* 忽略 */ }
    const { bindOverlay } = await import('../../ui/panel.js');
    bindOverlay();
    const classes = new Set();
    const btn = {
        dataset: { fttAction: 'refresh' },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        disabled: false, title: '', closest: () => null,
    };
    const fns = (el.listeners || {}).click || [];
    fns.forEach((fn) => fn({ target: btn, preventDefault() { }, stopPropagation() { } }));
    await new Promise((r) => setTimeout(r, 10));
    return classes.size === 0 && btn.disabled === false;
})(), '');

try { unmountPanel(); } catch (e) { /* 忽略 */ }
R.done();
