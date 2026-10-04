// ============================================================
// 单元测试 · v3.14.0「首屏载入闸门」（读取拦截提示）
// 用户要求（原话）：「刚加载插件后数据还未完整读取，应有读取拦截提示，避免报错，等加载完成后再展示内容。」
//
// 口径（`core/model/runtime.js#loadGate`）：
//   · `phase = 'idle'`（默认）**不拦截** —— 未开始过载入 = 保持既有行为（既有测试/外部接口口径不变）；
//   · `phase = 'loading'`：各分页只渲染 `loadGateHtml()`（读取提示），标题栏不显示「总记忆数」（此刻必为 0），
//     动作除「关闭 / 切页」外一律拒绝（`ok:false, reason:'loading'`）且**不触发任何钩子**；
//   · `phase = 'ready' | 'failed'`：解除拦截（失败也放行 —— 绝不把用户永久挡在门外）。
// 运行：node tests/unit/load-gate.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase, loadBlocked, loadGateInfo, loadGate, LOAD_PHASES, LOAD_GATE_MAX_MS } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelBodyHtml, panelModalInnerHtml, loadGateHtml, panelAction, openPanel, closePanel, panelOpen, renderPanel } from '../../ui/panel.js';
import { setPanelHooks2 } from '../../ui/panel.js';
import { setPanelStatus, statusBlockText } from '../../ui/settings-panel.js';

const R = makeReporter('load-gate v3.14.0 首屏载入闸门（读取拦截提示）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
let extractCalls = 0;

function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:loadgate');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：甲在仓库清点货物。' }] }), doc);
    setLastMessageId(0);
    Object.assign(loadGate, { phase: 'idle', startedAt: 0, finishedAt: 0, note: '', error: '', waitedMs: 0 });
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'lg-a1', text: '甲在仓库清点编号 3 的铜箱并登记入册。', title: '清点', floorStart: 0, floorEnd: 0, uses: 1, importance: 0.5 }],
        memories: [{ id: 'lg-m1', title: '账册', content: '账册上记着三只铜箱。' }],
    }, st || {}));
    extractCalls = 0;
    setPanelHooks2({ extract: async () => { extractCalls += 1; return { ok: true, added: 1 }; } });
    closePanel();
    return state;
}

// ---------- A 组：闸门口径 ----------
A('A1 默认 `idle` **不拦截**（未开始过载入 = 既有行为不变）：分页照常渲染，标题栏显示总记忆数', (() => {
    boot();
    openPanel('overview');
    const body = panelBodyHtml('overview');
    const inner = panelModalInnerHtml({ tab: 'overview' });
    return LOAD_PHASES.length === 4 && loadGate.phase === 'idle' && loadBlocked() === false
        && body.indexOf('data-ftt-loading-gate') < 0 && body.length > 200
        && inner.indexOf('总记忆数 2') > 0 && inner.indexOf('读取中') < 0;
})(), () => ({ phase: loadGate.phase, blocked: loadBlocked(), has: panelBodyHtml('overview').indexOf('data-ftt-loading-gate') }));

// ---------- B 组：读取中 ----------
A('B1 `loading` 时**每个分页**都只给拦截提示：提示块存在、含「正在读取数据」、且不含任何真实内容', (() => {
    boot();
    setLoadPhase('loading');
    openPanel('overview');
    const tabs = ['overview', 'settings', 'plans', 'states', 'atoms', 'memories', 'items', 'scenes', 'concepts', 'parallels', 'rumors', 'currencies', 'settings'];
    const all = tabs.map((t) => panelBodyHtml(t));
    const gate = loadGateHtml();
    return loadBlocked() === true
        && gate.indexOf('data-ftt-loading-gate') > 0 && gate.indexOf('正在读取数据') > 0
        && gate.indexOf('暂不展示内容') > 0
        && all.every((h) => h === gate)
        && all.every((h) => h.indexOf('lg-a1') < 0 && h.indexOf('总记忆数') < 0);
})(), () => ({ blocked: loadBlocked(), body: panelBodyHtml('overview').slice(0, 120) }));

A('B2 `loading` 时标题栏不显示「总记忆数」（此刻必为 0，会误导），改显示读取态胶囊', (() => {
    boot();
    setLoadPhase('loading');
    const inner = panelModalInnerHtml({ tab: 'overview' });
    return inner.indexOf('总记忆数') < 0 && inner.indexOf('⏳ 读取中…') > 0
        && inner.indexOf('data-ftt-loading-gate') > 0          // 正文也是提示
        && inner.indexOf('ftt-tabs') > 0;                       // 标签条仍在（可切页，但每页都是提示）
})(), () => ({ inner: panelModalInnerHtml({ tab: 'overview' }).slice(0, 200) }));

await A('B3 `loading` 时动作被**拒绝**且不触发任何钩子（提取 / 修复 / 保存一律拦住），但「关闭 / 切页」放行', (async () => {
    boot();
    setLoadPhase('loading');
    openPanel('overview');
    const ex = await panelAction('extract', {});
    const sv = await panelAction('saveAll', {});
    const cl = await panelAction('close', {});
    const tb = await panelAction('tab', { tab: 'settings' });
    return ex && ex.ok === false && ex.reason === 'loading'
        && sv && sv.ok === false && sv.reason === 'loading'
        && extractCalls === 0                                   // 钩子一次都没被调用
        && cl && cl.ok !== false && tb && tb.ok !== false
        && panelOpen() === true;                                // 切页后仍开着，未误关
})(), () => ({ extractCalls: extractCalls, phase: loadGate.phase }));

A('B4 `loading` 时抽屉卡片同样只报读取态（不显示残缺条数）', (() => {
    boot();
    setLoadPhase('loading');
    setPanelStatus({ scope: 'char:loadgate', injectChars: 0, pending: 0, load: loadGateInfo() });
    const t = statusBlockText();
    setLoadPhase('ready', { via: 'local' });
    setPanelStatus({ load: loadGateInfo() });
    const t2 = statusBlockText();
    return t.indexOf('数据读取中') > 0 && t.indexOf('待分析楼层') < 0 && t.indexOf('内核配置') < 0
        && t2.indexOf('数据读取中') < 0 && t2.indexOf('内核配置') > 0;
})(), () => ({ loading: statusBlockText().slice(0, 60) }));

// ---------- C 组：解除拦截 ----------
A('C1 `ready` 后**同一批动作立刻可用**、分页恢复真实内容（拦截只发生在读取期间）', (() => {
    boot();
    setLoadPhase('loading');
    openPanel('overview');
    const before = panelBodyHtml('overview');
    setLoadPhase('ready', { via: 'file', items: 2 });
    renderPanel();
    const after = panelBodyHtml('overview');
    const g = loadGateInfo();
    return g.blocked === false && g.phase === 'ready' && g.finishedAt > 0
        && before !== after && after.indexOf('data-ftt-loading-gate') < 0 && after.length > 200;
})(), () => loadGateInfo());

await A('C2 `ready` 后动作不再被拦：`extract` 真的到达钩子（证明拦截的只是「读取期间」）', (async () => {
    boot();
    setLoadPhase('ready');
    openPanel('overview');
    const r = await panelAction('extract', {});
    return extractCalls === 1 && r && r.reason !== 'loading';
})(), () => ({ extractCalls: extractCalls }));

A('C3 `failed` 也**解除拦截**（避免把用户永久挡在门外），但闸门如实留下失败原因', (() => {
    boot();
    setLoadPhase('failed', { error: 'read-failed', note: '首屏载入失败' });
    const g = loadGateInfo();
    const body = panelBodyHtml('overview');
    return g.blocked === false && g.phase === 'failed' && g.error === 'read-failed'
        && body.indexOf('data-ftt-loading-gate') < 0 && body.length > 200;
})(), () => loadGateInfo());

A('C4 等待时长如实累计：`loading` 期间 `waitedMs` 随时间增长，进入 `ready` 后冻结为总耗时', (() => {
    boot();
    setLoadPhase('loading');
    loadGate.startedAt = Date.now() - 2500;                  // 模拟已等待 2.5 秒
    const mid = loadGateInfo();
    setLoadPhase('ready');
    const done = loadGateInfo();
    return mid.blocked === true && mid.waitedMs >= 2400
        && done.blocked === false && done.waitedMs >= 2400 && done.waitedMs === loadGate.waitedMs;
})(), () => ({ mid: loadGateInfo(), gate: J({ phase: loadGate.phase, waitedMs: loadGate.waitedMs }) }));

// ---------- D 组：超时兜底（宿主读取挂起也不能把界面永久挡住） ----------
A('D1 超过 `LOAD_GATE_MAX_MS` 仍未读完 → **自动放行**（`phase=ready` + `timeout:true` 留痕），正文恢复真实内容', (() => {
    boot();
    openPanel('overview');
    setLoadPhase('loading');
    loadGate.startedAt = Date.now() - (LOAD_GATE_MAX_MS + 500);   // 模拟宿主读取 API 挂起
    const blocked = loadBlocked();                                // 首次读取即触发兜底放行
    const g = loadGateInfo();
    const body = panelBodyHtml('overview');
    return LOAD_GATE_MAX_MS === 20000 && blocked === false && g.blocked === false
        && g.phase === 'ready' && g.timeout === true && g.waitedMs >= LOAD_GATE_MAX_MS
        && g.note.indexOf('读取超时') >= 0
        && body.indexOf('data-ftt-loading-gate') < 0 && body.length > 200;
})(), () => loadGateInfo());

R.done();
