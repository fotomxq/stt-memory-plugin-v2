// ============================================================
// 单元测试 · v3.39.0「本地召回失败 Cannot read properties of null (reading 'state')」回归
//
// 用户报告（原话）：「修复报错：本地召回失败 Cannot read properties of null (reading 'state')」
//
// 根因：内核态初始为 `null`（`core/model/runtime.js`：`export let state = null`，由宿主在载入完成后注入），
//   而**生成拦截器是页面级全局钩子**（manifest 的 `generate_interceptor`）—— 首屏载入 / 切换角色 /
//   跨端合并的窗口期里发送，就会走到「本地召回」`core/recall.js#buildMemoryBodyForInject`，
//   旧实现在 `state.state.date` 等处直接取属性 → `Cannot read properties of null (reading 'state')`
//   → 被入口 catch 包成 `warn('本地召回失败', e)`（用户看到的红字）。
//
// 口径（本批）：
//   ① `core/recall.js` 一律经 `st()` / `stState()` 取用 → 未注入时退化为**空容器**（召回如实为空，不抛错）；
//   ② `host/inject.js`：状态未就绪 → **如实跳过本轮**（`reason='state-not-ready'`），不记为错误、不弹告警；
//   ③ `host/chat.js#attachKernelState`：**绝不把已有内核态降级成 null**（传入非对象时保留当前态）；
//   ④ `index.js#init`：首屏在 `loadMemoryState()` 之前先注入**空容器占位** → 从根上关掉这个窗口。
//
// 运行：node tests/unit/recall-null-state.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, kernelState, setScopeKey, setPersistHooks, setLastMessageId, warnBacklogList, clearWarnBacklog } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import {
    buildMemoryBodyForInject, buildInjectConstraints, recallDateAnchor, trustedPlotList,
    atomLatestDated, relPresentList, importancePct,
} from '../../core/recall.js';
import { attachKernelState } from '../../host/chat.js';
import { pushMemoryInject, readInject, clearInject, setInjectRuntime, pushStats } from '../../host/inject.js';

const R = makeReporter('recall-null-state v3.39.0 内核态未就绪时的本地召回（不再抛 reading \'state\'）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: false, mes: '甲在码头清点货物并登记入册。', name: '角色甲' }] });
installGlobalHost(host, doc);

/** 告警现场（`warn()` 会进暂存环；用它证明「不再报这条错」） */
let warns = [];
let a4Body = '';
function bootNoState() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.injectCurrentPrompt = true;
    setScopeKey('角色甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setInjectRuntime({ extractFlow: null, recentFloorText: () => '' });
    setLastMessageId(0);
    try { clearInject(); } catch (e) { /* 忽略 */ }
    clearWarnBacklog();
    warns = [];
    setKernelState(null);                       // ← 复现：内核态还没注入
}
function richState() {
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '1919-11-29', time: '夜', location: '码头' });
    st.atoms = [{ id: 'a1', title: '木箱账册', text: '甲在码头打开木箱取出账册，记下转运日期。', date: '1919-11-29', floorStart: 1, floorEnd: 1, tags: ['码头'], uses: 1, importance: 0.8 }];
    return st;
}
const grabWarns = () => warnBacklogList().map((x) => String(x.msg || ''));

// ---------- A 组：召回本体对 null 内核态安全 ----------
A('A1 **根因回归**：内核态为 null 时 `buildMemoryBodyForInject()` 返回空串且**不再产生「本地召回失败」告警**（旧实现抛 reading \'state\'）', (() => {
    bootNoState();
    let threw = '';
    let body = null;
    try { body = buildMemoryBodyForInject('甲 码头'); } catch (e) { threw = String((e && e.message) || e); }
    const ws = grabWarns();
    return body === '' && threw === '' && !ws.some((m) => m.indexOf('本地召回失败') >= 0)
        && !ws.some((m) => m.indexOf("reading 'state'") >= 0);
})(), () => ({ body: buildMemoryBodyForInject('x'), warns: grabWarns() }));

A('A2 未就绪时**不抛错**的还有：约束段 / 日期锚点 / 可信情节 / 最新日期条目 / 在场名单 / 重要度（都退化为空值）', (() => {
    bootNoState();
    const out = {};
    const run = (k, fn) => { try { out[k] = fn(); } catch (e) { out[k] = 'THREW:' + String((e && e.message) || e); } };
    run('constraints', () => buildInjectConstraints({ injected: { memories: [], plans: [], suspense: [], parallels: [], rumors: [] } }));
    run('anchor', () => recallDateAnchor());
    run('plots', () => trustedPlotList());
    run('latestDated', () => atomLatestDated());
    run('present', () => relPresentList());
    run('imp', () => importancePct({ importance: 0.5 }));
    const threw = Object.keys(out).filter((k) => typeof out[k] === 'string' && out[k].indexOf('THREW:') === 0);
    return threw.length === 0 && typeof out.constraints === 'string' && Array.isArray(out.plots)
        && Array.isArray(out.present) && out.present.length === 0 && out.latestDated == null;
})(), () => ({ out: null }));

A('A3 未就绪 ≠ 空的诊断口径：`diagnose` 模式如实回报 `state-not-ready`（自查面板据此说明原因，而不是显示「解析失败」）', (() => {
    bootNoState();
    const d = buildMemoryBodyForInject('甲', { diagnose: true });
    return d && d.ok === false && d.reason === 'state-not-ready'
        && d.bodyText === '' && d.totalText === '' && String(d.note).indexOf('尚未注入') > 0;
})(), () => ({ diag: buildMemoryBodyForInject('甲', { diagnose: true }) }));

A('A4 反例（防「一刀切」）：内核态就绪后召回照常产出正文；未就绪只影响「拿不到数据」，不影响判定', (() => {
    bootNoState();
    setKernelState(richState());
    const body = String(buildMemoryBodyForInject('木箱 账册', { charBudget: 2000 }) || '');
    a4Body = body;
    return body.indexOf('情节记忆') >= 0 && body.indexOf('打开木箱取出账册') >= 0 && grabWarns().length === 0;
})(), () => ({ body: a4Body, warns: grabWarns() }));

// ---------- B 组：注入路径如实跳过（不弹错、不写脏注入） ----------
A('B1 状态未就绪时注入**如实跳过**：`pushMemoryInject()` 回 `state-not-ready`、不注入、不报错（载入完成后自动重算）', (async () => {
    bootNoState();
    const cur0 = readInject();
    const r = await pushMemoryInject({ queryText: '甲' });
    const cur = readInject();
    const err = String((pushStats() || {}).lastError || '');
    const ws = grabWarns();
    return r && r.ok === true && r.reason === 'state-not-ready' && r.injected === false
        && r.method && r.method.key === 'state-not-ready'
        && J(cur) === J(cur0) && err === '' && ws.length === 0;
})(), () => ({ r: null, cur: readInject() }));

A('B2 状态就绪后注入照常（同一入口、同一口径）：写入注入文本并回报命中层', (async () => {
    bootNoState();
    setKernelState(richState());
    const r = await pushMemoryInject({ queryText: '木箱 账册' });
    const cur = readInject();
    return r && r.ok === true && r.injected === true && String(cur || '').indexOf('木箱账册') >= 0
        && String(r.reason || '') !== 'state-not-ready';
})(), () => ({ cur: readInject() }));

// ---------- C 组：注入内核态的口径（绝不降级成 null） ----------
A('C1 `attachKernelState()` **绝不把已有内核态降级成 null**：传入 null / undefined / 字符串时保留当前态并如实记账', (() => {
    bootNoState();
    const st = richState();
    attachKernelState(st);
    const keep1 = kernelState();
    const rNull = attachKernelState(null);
    const keep2 = kernelState();
    const rUndef = attachKernelState(undefined);
    const keep3 = kernelState();
    const rStr = attachKernelState('not-an-object');
    const keep4 = kernelState();
    return keep1 === st && rNull === st && keep2 === st && rUndef === st && keep3 === st && rStr === st && keep4 === st;
})(), () => ({ state: kernelState() }));

A('C2 `attachKernelState(obj)` 正常注入（幂等；`chatKey` 照旧就地更新）', (() => {
    bootNoState();
    const st = richState();
    const r = attachKernelState(st);
    return r === st && kernelState() === st && typeof st.chatKey === 'string';
})(), () => ({ state: kernelState() }));

R.done();
