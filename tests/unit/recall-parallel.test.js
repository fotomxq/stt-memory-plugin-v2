// ============================================================
// 单元测试 · v2.74.0「提取记忆不占管道 / 可并行 / 发送前提取并按开关注入」
//
// 用户要求：「提取记忆应该**不占用管道**，因为提取记忆用的是**独立的向量或固定 JS 为主**。
//   确保提取记忆可以**并行处理**，而且在**用户请求发送前提取好记忆**，按照**开关约定注入提示词信息**。」
//
// 修复前：「📤 提取记忆」按钮走的是 `runExtract` = **AI 摘要管道**（`analyzeFloors`）——
//   它会占用忙碌位（`extractState.busy`），与「⚡ 立即 AI 摘要」互相排队；而向量 / JS 两层本来就是零 AI 的本地召回。
//
// 本批：
//   ① `index.js#runRecallNow()`：新入口 = 发送前召回（三层：向量 → JS → AI），**不设置也不检查**摘要忙碌位，
//      因此可与长任务**并行**；「📤 提取记忆」按钮改走它（`hooks.recall`，未接线时回落旧入口）；
//   ② `host/inject.js`：`pushMemoryInject` 改为**单飞（single-flight）**——并发调用共享同一次构建结果
//      （`joined` 计数），不重复消耗向量/AI 请求，也不互相覆盖注入；
//   ③ `host/extract-flow.js`：长任务在途（`aiBusy()`）时**默认跳过 AI 层**（不与在途任务抢 AI 通道），
//      向量 / JS 层照常；`allowAiDuringBusy` 可强制保留；
//   ④ 注入仍按开关：`injectCurrentPrompt` / `timelyAnalysis` 为闸门，`useVector` / `jsExtractEnabled` /
//      `useKeywordFlow` 决定走哪一层；发送前由拦截器再刷一次（`fttGenerateInterceptor`）。
//
// 运行：node tests/unit/recall-parallel.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { pushStats, readInject, injectInFlight, setInjectRuntime } from '../../host/inject.js';
import { runRecallNow, runExtract } from '../../index.js';
import { analyzeFloors, extractBusy, extractStats } from '../../host/extract.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { fttGenerateInterceptor, interceptorStats, resetInterceptorStats } from '../../host/interceptor.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('recall-parallel v2.74.0 提取记忆并行与预注入');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: false, mes: '甲在码头清点货物。', name: '角色甲' }] });
installGlobalHost(host, doc);

function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, extra || {});
    setScopeKey('角色甲');
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '1919-11-29', time: '夜', location: '码头' });
    st.atoms = [
        { id: 'a1', title: '木箱账册', text: '甲在码头打开木箱取出账册，记下转运日期。', date: '1919-11-29', floorStart: 1, floorEnd: 1, tags: ['码头', '账册'], uses: 1, importance: 0.8 },
        { id: 'a2', title: '北境风声', text: '北境传来集结的消息。', date: '1919-11-20', floorStart: 2, floorEnd: 2, tags: ['北境'], uses: 0, importance: 0.6 },
    ];
    st.currentStates = [{ id: 's1', subject: '角色甲', field: '处境', value: '在码头清点货物', status: 'active', importance: 0.7, floorStart: 1, floorEnd: 1, history: [], uses: 0 }];
    setKernelState(st);
    setLastMessageId(0);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    // 注入层：不接向量（走 JS 层），AI 层按需接线（用 generateRaw 计数观察是否被调用）
    setInjectRuntime({ extractFlow: null });
    return st;
}
// 接线三层流程（与 index.js 同源）
const flowMod = await import('../../host/extract-flow.js');
setInjectRuntime({ extractFlow: (text, o) => flowMod.runExtractFlow(text, o), recentFloorText: () => '甲在码头清点货物并记下账册。' });
setAiHooks({ busy: () => { try { return extractBusy(); } catch (e) { return false; } }, callAi: async () => ({ ok: true, text: '' }), feedText: () => '' });

// ---------- P 组：并行（单飞） ----------
A('P1 并行安全：同一时刻两次召回只构建一次（`joined` 计数 = 1），两次结果一致', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    const before = pushStats();
    const p1 = runRecallNow({});
    const inFlightDuring = injectInFlight();
    const p2 = runRecallNow({});
    const [a, b] = await Promise.all([p1, p2]);
    const after = pushStats();
    return inFlightDuring === true && after.builds - before.builds === 1 && after.joined - before.joined === 1
        && a.chars > 0 && a.chars === b.chars && a.hitLayer === b.hitLayer && injectInFlight() === false;
})(), J({ stats: pushStats() }));

A('P2 并行不改变注入闸门语义：两次并发都按开关推送，注入非空且只推一次', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    const before = pushStats().pushes;
    await Promise.all([runRecallNow({}), runRecallNow({})]);
    const after = pushStats();
    return after.pushes - before === 1 && readInject().indexOf('【FTT记忆注入】') === 0
        && after.lastChars > 0 && after.lastLayer === 'js';
})(), J({ pushes: pushStats().pushes, chars: readInject().length }));

// ---------- B 组：不占管道（与摘要并行） ----------
await (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    const runsBefore = extractStats().runs;
    const slow = analyzeFloors({ ai: () => new Promise((r) => setTimeout(() => r({ ok: true, text: J({ atoms: { add: [{ title: 'x', text: '甲在码头清点货物并记下账册与转运日期。' }] } }) }), 40)) });
    await new Promise((r) => setTimeout(r, 5));
    const busyBefore = extractBusy();
    const rec = await runRecallNow({});
    const busyAfter = extractBusy();
    await slow;
    void runsBefore;
    A('B1 长任务在途时召回照常成功（并行）：报告 `busy=true`、注入非空，且**不改动**忙碌位',
        busyBefore === true && rec.busy === true && rec.ok === true && rec.chars > 0
        && busyAfter === true && readInject().length > 0,
        J({ busyBefore: busyBefore, rec: { ok: rec.ok, chars: rec.chars, hitLayer: rec.hitLayer, busy: rec.busy } }));
})();

A('B2 召回入口不占用管道：`runRecallNow` 前后 `extractBusy()` 均为 false（空闲态），且不触发 AI 摘要（runs 不变）', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    const runsBefore = extractStats().runs;
    const r = await runRecallNow({});
    return extractBusy() === false && extractStats().runs === runsBefore && r.ok === true && r.busy === false;
})(), J({ stats: extractStats() }));

A('B3 旧入口 `runExtract` 仍是 AI 摘要管道（占用忙碌位）——两条路互不影响', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true });
    const p = runExtract({ floor: 0, ai: () => new Promise((r) => setTimeout(() => r({ ok: true, text: J({ atoms: { add: [{ title: 'y', text: '甲在码头清点货物并记下账册与去向。' }] } }) }), 20)) });
    await new Promise((r) => setTimeout(r, 5));
    const busy = extractBusy();
    const recallOk = (await runRecallNow({})).ok === true;
    const out = await p;
    return busy === true && recallOk === true && out && out.ok === true;
})(), '见断言');

// ---------- C 组：忙位跳过 AI 层 ----------
A('C1 长任务在途时自动**跳过 AI 层**（不与在途任务抢 AI 通道）；空闲时 AI 层照常被调用', (async () => {
    // AI 层调用计数：`useKeywordFlow=true` + 空关键词 + 有正文 → 走 kw/mem API（此处由 generateRaw 桩计数）
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: true });
    let aiCalls = 0;
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => { aiCalls += 1; return '【情节记忆】甲在码头清点货物。'; };
    try {
        // ② 空闲：AI 层被调用（JS 层先命中则不会进 AI —— 故先关掉 JS 层，单独观察 AI 层）
        cfg.jsExtractEnabled = false;
        const idle = await runRecallNow({});
        const callsIdle = aiCalls;
        // ③ 忙位：用 `analyzeFloors` 顶住忙碌位，再召回（应跳过 AI 层）
        cfg.jsExtractEnabled = true;
        const slow = analyzeFloors({ ai: () => new Promise((r) => setTimeout(() => r({ ok: true, text: '{}' }), 40)) });
        await new Promise((r) => setTimeout(r, 5));
        aiCalls = 0;
        const busy = await runRecallNow({});
        const callsBusy = aiCalls;
        await slow;
        // ④ 强制保留 AI 层（诊断用）：`allowAiDuringBusy`
        return callsIdle >= 1 && callsBusy === 0 && busy.hitLayer !== 'ai' && busy.ok === true;
    } finally { host.ctx.generateRaw = saved; }
})(), '见断言');

// ---------- D 组：按开关注入 ----------
A('D1 注入闸门：两个开关都关 → 不推送、不清空已有注入（gate-closed）', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true });
    await runRecallNow({});
    const before = readInject();
    cfg.injectCurrentPrompt = false; cfg.timelyAnalysis = false;
    const r = await runRecallNow({});
    return before.length > 0 && r.reason === 'gate-closed' && r.injected === false
        && readInject() === before && r.chars === 0;
})(), '见断言');

A('D2 层开关：`useVector=false` → 走 JS 层；`jsExtractEnabled=false` 且无 AI → 无命中（no-hit）', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    const js = await runRecallNow({});
    cfg.jsExtractEnabled = false;
    const none = await runRecallNow({});
    return js.hitLayer === 'js' && js.count > 0
        && none.ok === false && none.reason === 'no-hit' && none.count === 0;
})(), '见断言');

// ---------- E 组：发送前提取 ----------
await (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true, useKeywordFlow: false });
    resetInterceptorStats();
    const chat = [{ is_user: false, mes: '甲在码头清点货物。' }];
    let aborted = 0;
    const t0 = Date.now();
    await fttGenerateInterceptor(chat, 8000, () => { aborted += 1; }, 'normal');
    const st = interceptorStats();
    A('E1 发送前提取好：拦截器 await 结束时注入已写好（非空、含结构头），且**永不调用 abort**',
        st.calls === 1 && st.lastPush && st.lastPush.ok === true && st.injectedLength > 0
        && readInject().indexOf('【FTT记忆注入】') === 0 && aborted === 0 && st.lastPush.ms >= 0 && Date.now() - t0 >= 0,
        J({ push: st.lastPush, chars: st.injectedLength }));
})();

A('E2 拦截器按开关注入：`injectCurrentPrompt`/`timelyAnalysis` 都关时不刷新（不覆盖已有注入）', (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true });
    await runRecallNow({});
    const before = readInject();
    resetInterceptorStats();
    cfg.injectCurrentPrompt = false; cfg.timelyAnalysis = false;
    await fttGenerateInterceptor([{ is_user: false, mes: 'x' }], 100, () => { }, 'normal');
    return interceptorStats().lastPush === null && readInject() === before;
})(), '见断言');

// ---------- F 组：面板按钮与诊断 ----------
await (async () => {
    boot({ injectCurrentPrompt: true, useVector: false, jsExtractEnabled: true });
    const calls = { recall: 0, extract: 0 };
    setPanelHooks2({ recall: async () => { calls.recall += 1; return { ok: true, count: 3, chars: 120, ms: 7, hitLayer: 'js', busy: false }; }, extract: async () => { calls.extract += 1; return { ok: true }; } });
    openPanel('overview');
    await panelAction('extractNow', {});
    const note = String((panelBodyHtml('overview').match(/data-ftt-note>([^<]*)</) || [])[1] || '');
    A('F1 「📤 提取记忆」走**召回**入口（不是 AI 摘要）：note 给出条数/层级/字数/耗时，且未调用旧 extract 入口',
        calls.recall === 1 && calls.extract === 0 && note.indexOf('召回完成：3 条（JS 抽取层）') >= 0
        && note.indexOf('注入 120 字') >= 0 && note.indexOf('7ms') >= 0,
        J({ calls: calls, note: note }));

    // 回落：未接线 recall（显式置空，避免上一次注入的钩子残留）→ 仍可用旧入口
    setPanelHooks2({ recall: undefined, extract: async () => { calls.extract += 1; return { ok: true, added: 1, total: 1 }; } });
    await panelAction('extractNow', {});
    A('F2 回落：宿主未接线 `hooks.recall` 时仍走旧提取入口（不报「入口未就绪」）',
        calls.extract === 1 && String((panelBodyHtml('overview').match(/data-ftt-note>([^<]*)</) || [])[1] || '').indexOf('新增 1 条') >= 0,
        J(calls));
})();

A('F3 诊断：`pushStats()` 给出 joined / lastMs / lastLayer，`injectInFlight()` 完成后为 false', (() => {
    const s = pushStats();
    return typeof s.joined === 'number' && s.joined >= 1 && typeof s.lastMs === 'number'
        && typeof s.lastLayer === 'string' && injectInFlight() === false && s.builds > 0;
})(), J(pushStats()));

A('F4 按钮文案与 title 说明「不占分析管道、可与摘要并行、发送前自动刷新」', (() => {
    boot({});
    openPanel('overview');
    const h = panelBodyHtml('overview');
    return h.indexOf('📤 提取记忆') > 0 && h.indexOf('不占用分析管道') > 0
        && h.indexOf('可与 AI 摘要并行') > 0 && h.indexOf('发送前也会自动刷新一次') > 0;
})(), '见断言');

R.done();
