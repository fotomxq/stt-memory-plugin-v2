// ============================================================
// 单元测试 · B3 提取与楼层管理（V1 runAutoSummary / abortAnalysis / clearFloors 对齐）
// 口径：
//   ① 分段：`cfg.summaryChunkSize` 楼/段，段文本 = 该段楼层行（`[第N楼 角色] 正文`）经投喂正则过滤；
//   ② 一段 = 一次 AI 调用 = 一次 mergeDelta（floorRange = 该段）+ 整段记账；
//   ③ 失败段**不记账**（下次会重试）；空段直接记账跳过；
//   ④ 中断为**协作式**：段与段之间生效，在途段完成后停止；
//   ⑤ 手动模式取最近 `cfg.feedFloors` 楼；静默模式覆盖全部未摘要 AI 楼并跳过已处理段。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { runAutoSummary, analyzeSegment, buildSegments, abortExtract, abortPending, batchProgress, clearFloors } from '../../host/extract.js';
import { isFloorProcessed, processedStats, listUnprocessedFloors } from '../../host/floors.js';
import { panelAction, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('extract-batch B3 提取与楼层管理');
const J = (v) => JSON.stringify(v);

// 12 楼聊天：0 用户楼，其余 AI 楼（末两楼跳过 → effLast = 9）
const chat = [{ is_user: true, mes: '开场。', name: 'User' }];
for (let i = 1; i <= 11; i++) chat.push({ is_user: false, mes: '第' + i + '楼正文：甲在码头清点货物并记录去向。', name: '角色甲' });
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat });
const un = installGlobalHost(host, doc);

function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.summaryChunkSize = 4;      // 便于观察分段
    cfg.feedFloors = 6;
    cfg.timelyAnalysis = false;    // 跳过最近 2 楼
    setScopeKey('角色甲');
    setLastMessageId(chat.length - 1);
    setKernelState(Object.assign(emptyState(), { state: { date: '1919-11-29' } }, extra || {}));
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setPanelHooks2({});
}
const DELTA = (n) => ({ atoms: { add: [{ title: '事件' + n, text: '甲在码头清点货物并记录第' + n + '批去向（正文足够长）。', date: '1919-11-29' }] } });

// ---------- 分段构建 ----------
R.assert('S1 分段构建与 V1 一致：按 cfg.summaryChunkSize 切段、末段收口、chunk 守卫', (() => {
    const a = buildSegments(0, 9, 4);
    const b = buildSegments(3, 3, 10);
    const c = buildSegments(5, 8, 0);            // 0 → 回退默认（cfg.summaryChunkSize = 4）
    return J(a) === J([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 9 }])
        && J(b) === J([{ start: 3, end: 3 }]) && c.length === 1;
})(), buildSegments(0, 9, 4));

// ---------- 段分析 ----------
await (async () => {
    boot();
    const calls = [];
    const r = await analyzeSegment(2, 5, { ai: async (args) => { calls.push(args); return { ok: true, text: J(DELTA(1)) }; } });
    R.assert('S2 段分析：一次 AI 调用 = 一次 mergeDelta(整段) + 整段记账（段文本含楼层前缀）', (() => {
        const marked = [2, 3, 4, 5].every((f) => isFloorProcessed(f));
        const out = [0, 1, 6].some((f) => isFloorProcessed(f));
        return r.ok === true && r.added === 1 && r.floorStart === 2 && r.floorEnd === 5
            && calls.length === 1 && String(calls[0].prompt).indexOf('[第2楼 AI]') >= 0 && String(calls[0].prompt).indexOf('第5楼正文') >= 0
            && marked && out === false && (state.atoms || []).length === 1;
    })(), { r, marked: processedStats() });

    const fail = await analyzeSegment(6, 7, { ai: async () => ({ ok: true, text: '没有 JSON' }) });
    R.assert('S3 失败段不记账（下次可重试）且不影响已记段', (() => {
        return fail.ok === false && fail.reason === 'no-json'
            && isFloorProcessed(6) === false && isFloorProcessed(7) === false
            && isFloorProcessed(2) === true;
    })(), fail);

    let emptyAiCalls = 0;
    const empty = await analyzeSegment(99, 99, { ai: async () => { emptyAiCalls++; return { ok: true, text: '{}' }; } });
    R.assert('S3b 空段（越界楼层无可分析正文）直接记账并跳过 AI 调用', (() => {
        // 注：台账会记该段，但**不存在的楼层**哈希为空 → `isFloorProcessed` 依 V1 口径返回 false（不当成已分析）
        return empty.ok === true && empty.empty === true && emptyAiCalls === 0 && isFloorProcessed(99) === false;
    })(), empty);
})();

// ---------- 批量：手动模式 ----------
await (async () => {
    boot();
    const seen = [];
    const ai = async (args) => { const m = String(args.prompt).match(/\[第(\d+)楼 AI\]/g) || []; seen.push(m.length); return { ok: true, text: J(DELTA(seen.length)) }; };
    const r = await runAutoSummary({ silent: false, ai });
    R.assert('B1 手动「立即 AI 摘要」：取最近 cfg.feedFloors 楼、按 chunkSize 分段、逐段 AI 与落库', (() => {
        // lastId=11 → effLast=9；feedFloors=6 → start=4；4..9 按 4 楼/段 = 2 段
        const marked = [4, 5, 6, 7, 8, 9].every((f) => isFloorProcessed(f));
        return r.ok === true && r.segments === 2 && r.floors === '4-9' && r.made === 2 && r.added === 2
            && seen.length === 2 && marked && (state.atoms || []).length === 2
            && (state.processedFloors || []).length === 6;
    })(), { r, seen, marks: (state.processedFloors || []).length });
})();

// ---------- 批量：静默补全（覆盖全部未摘要楼 + 跳过已处理段） ----------
await (async () => {
    boot();
    let calls = 0;
    const ai = async () => { calls++; return { ok: true, text: J(DELTA(calls)) }; };
    const r1 = await runAutoSummary({ silent: true, ai });
    const callsAfter1 = calls;
    const r2 = await runAutoSummary({ silent: true, ai });
    R.assert('B2 静默补全：覆盖全部未摘要 AI 楼（0-9），二次调用无待分析段即跳过（零新增 AI 调用）', (() => {
        const all = [];
        for (let f = 1; f <= 9; f++) all.push(f);
        return r1.ok === true && r1.made >= 1 && callsAfter1 >= 1
            && all.every((f) => isFloorProcessed(f))
            && r2.ok === true && r2.made === 0 && (r2.skipped === true || r2.aborted === 0)
            && calls === callsAfter1;
    })(), { r1, r2, calls, callsAfter1 });
})();

// ---------- 中断（协作式） ----------
await (async () => {
    boot();
    cfg.summaryChunkSize = 2;      // 多段，便于中途中断
    let calls = 0;
    const ai = async () => {
        calls++;
        if (calls === 1) abortExtract();          // 首段完成后请求中断
        return { ok: true, text: J(DELTA(calls)) };
    };
    const r = await runAutoSummary({ silent: false, ai });
    R.assert('B3 中断为协作式：段间生效（首段完成并落盘，其余段未分析），返回 aborted 计数且 busy 归位', (() => {
        const marks = (state.processedFloors || []).length;
        return r.ok === true && r.made === 1 && r.aborted > 0 && calls === 1
            && marks === 2 && abortPending() === false && batchProgress().segTotal >= 2
            && (state.atoms || []).length === 1;
    })(), { r, calls, marks: (state.processedFloors || []).length });
})();

// ---------- 清除已处理记录 ----------
await (async () => {
    boot();
    await runAutoSummary({ silent: false, ai: async () => ({ ok: true, text: J(DELTA(1)) }) });
    const before = (state.processedFloors || []).length;
    const r = clearFloors();
    R.assert('B4 清除已处理记录：台账清空、lastKnownFloor 复位、**不删除任何记忆条目**', (() => {
        return before > 0 && r.ok === true && r.cleared === before
            && (state.processedFloors || []).length === 0 && Number(state.lastKnownFloor) === -1
            && (state.atoms || []).length >= 1 && (listUnprocessedFloors({}).length) > 0
            && processedStats().marks === 0;
    })(), { before, r, atoms: (state.atoms || []).length });
})();

// ---------- 面板接线（动效 / 按钮 / 提示） ----------
await (async () => {
    boot();
    let abortCalled = 0;
    let batchArgs = null;
    setPanelHooks2({
        autoSummary: async (o) => { batchArgs = o; return { ok: true, segments: 2, floors: '4-9', added: 3, aborted: 0 }; },
        abort: () => { abortCalled++; return { ok: true, busy: true }; },
        clearFloors: () => ({ ok: true, cleared: 5 }),
        batchProgress: () => ({ segTotal: 2, segDone: 1, range: '4-9', activeSeg: { start: 4, end: 5 }, aborted: 0 }),
        pending: () => [4, 5, 6, 7, 8, 9],
    });
    await panelAction('summary', {});
    const html = panelBodyHtml('overview');
    const note = await panelAction('tab', { tab: 'overview' });
    await panelAction('abortAnalysis', {});
    const r2 = await panelAction('clearFloors', {});
    R.assert('B5（v2.52.0）面板接线：⚡ 立即 AI 摘要 触发批量并回填完成文案；总览不再出现「清除已处理记录」（改属设定→数据管理）', (() => {
        return batchArgs && batchArgs.silent === false && abortCalled === 1 && r2.ok === true
            && String(note.html).indexOf('摘要完成：2 段 · 读取楼层 4-9 · 新增 3 条') >= 0
            && String(note.html).indexOf('data-ftt-action="clearFloors"') < 0
            && String(note.html).indexOf('🧵 管线状态') >= 0;
    })(), { batchArgs, abortCalled, r2, note: String(note.html).match(/data-ftt-note>[^<]*/) });

    // busy 头部文案与楼层脉冲（V1 动效口径）：批量进行中时头部加 ftt-head-busy、当前段楼层加 ftt-floor-pulse
    const panelMod = await import('../../ui/panel.js');
    panelMod.openPanel('overview');
    panelMod.setPanelHooks2({ batchProgress: () => ({ segTotal: 2, segDone: 1, activeSeg: { start: 4, end: 5 } }), pending: () => [4, 5, 6] });
    await panelAction('summary', { silent: false });     // 该块未注入 autoSummary → 报未就绪，但会重置 busy
    const busyHtml = String(panelMod.panelHtml());
    return void busyHtml;
})();

un();
R.done();
