// ============================================================
// 单元测试 · v3.23.0「全部 AI 摘要按 **3 个正文** 切片、分批处理」
//
// 用户要求（原话）：「新版本 全部AI摘要需支持分段处理，且默认采用3个正文进行切片，分批进行处理。避免一次性分析记忆。」
//
// 现状（改动前，逐条核对过）：
//   · **只有批量摘要**（`runAutoSummary`）会分段，段长 = `cfg.summaryChunkSize`，**默认 10 楼/段**；
//   · 「多楼 / 全量提取」（`analyzeFloors`）—— **一楼一次** AI 调用（没有任何"段"的概念）；
//   · 「推演世界」（`runParallelWeave`）—— **一次请求把整个区间正文塞进一个提示词**（默认区间可到 30 楼）。
//   同一条「避免一次性分析记忆」的诉求，在三个入口上是三种行为。
//
// 本批判定（用户裁决：摘要类全部走分段 · 单次运行不限量，只是每段更小；修复类保持不动）：
//   · 段长口径收敛到内核纯函数 `core/chunk.js`（**默认 3 个正文**、段内必连续、段长只作上界）；
//   · 批量摘要 / 多楼（全量）提取 / 推演世界**共用**该口径：**一段 = 一次 AI 请求**；
//   · 单楼分析（含被动自动提取）语义**一字不变**（1 个正文 ≤ 段长，天然是一段）；
//   · 修复类（角色/状态/物品/计划/场景/概念/传言/分组）**不走**本口径。
//
// 覆盖：A `core/chunk.js` 原语（默认值 / 归一化 / 区间切片 / 清单切片 / 摘要读数）；
//       B 三个入口的落地（默认段长 / 多楼提取按段 / 单楼不倒退 / 批量摘要回报段长 / 推演分段聚合）；
//       C 面板批次行（段长可见；`range` 字符串与对象两种形态都认）。
// 运行：node tests/unit/summary-chunk.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { SUMMARY_CHUNK_DEFAULT, normalizeChunkSize, chunkFloorRange, chunkFloorIds, chunkInfo } from '../../core/chunk.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { setParallelTextHooks, runParallelWeaveChunked } from '../../core/parallel.js';
import { analyzeFloor, analyzeFloors, runAutoSummary, buildSegments, batchProgress, summaryChunkSize, lastExtractRecord } from '../../host/extract.js';
import { isFloorProcessed } from '../../host/floors.js';
import { pipelineBoxRowsHtml, setPanelHooks2 } from '../../ui/panel.js';
import { buildBridgeMethods } from '../../ui/debug.js';

const R = makeReporter('summary-chunk v3.23.0 全部 AI 摘要按 3 个正文切片 · 分批处理');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// 12 楼聊天：第 0 楼是用户楼（不可分析），第 1-11 楼是 AI 楼
const chat = [{ is_user: true, mes: '开场。', name: 'User' }];
for (let i = 1; i <= 11; i++) chat.push({ is_user: false, mes: '第' + i + '楼正文：甲在码头清点货物并记录去向。', name: '角色甲' });
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat });
installGlobalHost(host, doc);

const DELTA = (n) => ({ atoms: { add: [{ title: '事件' + n, text: '甲在码头清点货物并记录第' + n + '批去向（正文足够长）。', date: '1919-11-29' }] } });

function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    // 关键：**不**显式设置 `summaryChunkSize` —— 本文件要验证的就是"默认 3 个正文"
    cfg.feedFloors = 6;
    cfg.timelyAnalysis = false;                 // 跳过最近 2 楼（effLast = lastId - 2）
    setScopeKey('角色甲');
    setLastMessageId(chat.length - 1);
    setKernelState(Object.assign(emptyState(), { state: { date: '1919-11-29' } }, extra || {}));
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setNotifyHooks({ toast: () => undefined });
    setParallelTextHooks({ floorLinesInRange: (s, e) => { const out = []; for (let i = Number(s); i <= Number(e); i++) out.push('[第' + i + '楼 AI] 第' + i + '楼：甲在码头清点货物。'); return out; } });
    setPanelHooks2({});
    return state;
}

// ---------- A 组：`core/chunk.js` 原语 ----------
A('A1 唯一事实源：`SUMMARY_CHUNK_DEFAULT` = **3 个正文**，且 `defaultCfg.summaryChunkSize` 与它同源（默认配置已降到 3）', (() => {
    return SUMMARY_CHUNK_DEFAULT === 3 && defaultCfg.summaryChunkSize === SUMMARY_CHUNK_DEFAULT
        && defaultCfg.summaryChunkSize === 3;
})(), () => J({ constant: SUMMARY_CHUNK_DEFAULT, cfgDefault: defaultCfg.summaryChunkSize }));

A('A2 `normalizeChunkSize`：合法值取整；非法值（0 / 负数 / NaN / Infinity / 空串 / 非数字）回落 fallback，fallback 也非法则回落默认 3', (() => {
    const ok = normalizeChunkSize(4) === 4 && normalizeChunkSize('7') === 7 && normalizeChunkSize(2.9) === 2;
    const clamp = normalizeChunkSize(1e9) === 200 && normalizeChunkSize(-5) === 3;      // -5 非法 → 默认 3
    const bad = [0, NaN, Infinity, -Infinity, '', null, undefined, 'abc', {}].every((v) => normalizeChunkSize(v) === 3);
    const fb = normalizeChunkSize(0, 9) === 9 && normalizeChunkSize('abc', '6') === 6 && normalizeChunkSize(0, 'abc') === 3;
    return ok && clamp && bad && fb;
})(), () => J([0, 4, -5, 1e9, 'abc'].map((v) => normalizeChunkSize(v))));

A('A3 `chunkFloorRange`：覆盖完整、互不重叠、每段 ≤ 段长、末段收口；倒置/非有限区间收口为单段（V1 `buildSegments` 同口径）', (() => {
    const a = chunkFloorRange(0, 9, 3);
    const b = chunkFloorRange(5, 5, 3);
    const c = chunkFloorRange(7, 3, 3);           // 倒置 → 收口为 [7,7]
    const d = chunkFloorRange(-4, 2, 3);          // 负起点 → 夹到 0
    const cover = a.length === 4 && a.every((s) => (s.end - s.start + 1) <= 3) && a[0].start === 0 && a[3].end === 9
        && a.every((s, i) => i === 0 || s.start === a[i - 1].end + 1);
    return JSON.stringify(a) === J([{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }, { start: 9, end: 9 }])
        && cover && J(b) === J([{ start: 5, end: 5 }]) && J(c) === J([{ start: 7, end: 7 }])
        && J(d) === J([{ start: 0, end: 2 }]);
})(), () => J(chunkFloorRange(0, 9, 3)));

A('A4 `chunkFloorIds`：**连续段才合并**（不连续处一定断开）、每段 ≤ 段长、去重且升序（绝不把中间没选中的楼层拼进同一提示词）', (() => {
    const a = chunkFloorIds([1, 2, 3, 7, 8], 3);
    const b = chunkFloorIds([5, 4, 3, 2, 1], 2);          // 乱序 → 升序
    const c = chunkFloorIds([2, 2, 2, 3], 5);             // 重复 → 去重
    const d = chunkFloorIds([], 3);
    const e = chunkFloorIds([1, -3, 'x', null, 4], 3);    // 非法项丢弃
    return JSON.stringify(a) === J([{ start: 1, end: 3, ids: [1, 2, 3] }, { start: 7, end: 8, ids: [7, 8] }])
        && JSON.stringify(b) === J([{ start: 1, end: 2, ids: [1, 2] }, { start: 3, end: 4, ids: [3, 4] }, { start: 5, end: 5, ids: [5] }])
        && JSON.stringify(c) === J([{ start: 2, end: 3, ids: [2, 3] }])
        && J(d) === J([]) && JSON.stringify(e) === J([{ start: 1, end: 1, ids: [1] }, { start: 4, end: 4, ids: [4] }]);
})(), () => J(chunkFloorIds([1, 2, 3, 7, 8], 3)));

A('A5 `chunkInfo`：段数按**实际切片**算（与 `chunkFloorIds` 逐字一致），楼层数只数有效项', (() => {
    const a = chunkInfo([1, 2, 3, 7, 8], 3);
    const b = chunkInfo([], 3);
    return J(a) === J({ chunkSize: 3, floors: 5, segments: 2 })
        && J(b) === J({ chunkSize: 3, floors: 0, segments: 0 });
})(), () => J(chunkInfo([1, 2, 3, 7, 8], 3)));

// ---------- B 组：三个入口的落地 ----------
{
    boot();
    A('B1 `buildSegments` 在**未配置**段长时回落默认 3（配置了仍以配置为准）', (() => {
        const dflt = buildSegments(0, 9, 0);                 // 0 → 非法 → 默认 3
        const conf = (() => { const keep = cfg.summaryChunkSize; cfg.summaryChunkSize = 5; const r = buildSegments(0, 9, 0); cfg.summaryChunkSize = keep; return r; })();
        return J(dflt) === J([{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }, { start: 9, end: 9 }])
            && JSON.stringify(conf) === J([{ start: 0, end: 4 }, { start: 5, end: 9 }])
            && summaryChunkSize() === 3;
    })(), () => J({ default: buildSegments(0, 9, 0), effective: summaryChunkSize() }));
}

await (async () => {
    boot();
    const calls = [];
    const r = await analyzeFloors({ ai: async (args) => { calls.push(args); return { ok: true, text: J(DELTA(calls.length)) }; } });
    A('B2 **多楼 / 全量提取 = 按段推进**（默认 3 个正文/段）：11 个未摘要楼 → 4 段 = 4 次 AI 调用；每段区间连续、末段收口、整段记账', (() => {
        const segs = r.results.map((x) => [x.start, x.end]);
        const allMarked = Array.from({ length: 11 }, (_, i) => i + 1).every((f) => isFloorProcessed(f));
        const userFloorUntouched = isFloorProcessed(0) === false;
        return r.ok === true && r.segments === 4 && calls.length === 4 && r.results.length === 4
            && J(segs) === J([[1, 3], [4, 6], [7, 9], [10, 11]])
            && r.results.every((x) => x.floors.length === (x.end - x.start + 1))
            && r.floors.length === 11 && allMarked && userFloorUntouched;
    })(), () => J({ segs: r.results.map((x) => [x.start, x.end]), calls: calls.length, segments: r.segments }));

    // 「每段一次 AI 请求」的提示词里只有该段的楼层（不会夹带别的段）
    const oneSeg = calls[0] && String(calls[0].prompt || '');
    A('B3 段与段之间**不串味**：第一段的提示词只含第 1-3 楼正文，不含第 4 楼及以后', (() => {
        return oneSeg.indexOf('第1楼正文') >= 0 && oneSeg.indexOf('第3楼正文') >= 0
            && oneSeg.indexOf('第4楼正文') < 0 && oneSeg.indexOf('第10楼正文') < 0;
    })(), () => String(oneSeg).slice(0, 120));
})();

await (async () => {
    boot();
    let calls = 0;
    const r = await analyzeFloors({ ids: [5], ai: async () => { calls += 1; return { ok: true, text: J(DELTA(1)) }; } });
    A('B4 **单楼不倒退**：`analyzeFloors` 只给一个楼层时仍走「单楼分析」（1 次调用、`via=floor` 记账、结果形状 `floor===start===end`）', (() => {
        const rec = lastExtractRecord() || {};
        return r.ok === true && calls === 1 && r.segments === 1
            && r.results[0].floor === 5 && r.results[0].start === 5 && r.results[0].end === 5
            && J(r.results[0].floors) === J([5]) && String(rec.via) === 'floor' && String(rec.floors) === '5';
    })(), () => J({ r: r.results[0], via: (lastExtractRecord() || {}).via }));
})();

await (async () => {
    boot();
    A('B5 `batchProgress()` 在尚未开跑时就给出当前生效段长（默认 3），便于面板/调试桥说明切片口径', (() => {
        const bp = batchProgress();
        return bp.chunkSize === 3 && Number(bp.segTotal) === 0 && Number(bp.segDone) === 0;
    })(), () => J(batchProgress()));

    const calls = [];
    const r = await runAutoSummary({ silent: false, ai: async () => { calls.push(1); return { ok: true, text: J(DELTA(calls.length)) }; } });
    A('B6 **批量摘要**同样默认 3 个正文/段：末楼 9、取最近 `feedFloors`(6) 楼 → 区间 4-9 → **2 段**，并如实回报 `chunkSize`', (() => {
        return r.ok === true && r.floors === '4-9' && r.segments === 2 && calls.length === 2 && r.chunkSize === 3;
    })(), () => J({ floors: r.floors, segments: r.segments, calls: calls.length, chunkSize: r.chunkSize }));
})();

await (async () => {
    boot();
    const withDelta = async () => J({ '平行事件': { '新增': [{ '标题': '推演点', '正文': '甲在码头发现了一只新的铜箱（正文足够长）。', '日期': '1919-11-29' }] } });
    const r1 = await runParallelWeaveChunked({ start: 1, end: 7 }, { aiText: await withDelta(), force: true });
    const r2 = await runParallelWeaveChunked({ start: 4, end: 6 }, { aiText: await withDelta(), force: true });
    const r3 = await runParallelWeaveChunked({ start: 1, end: 2 }, { aiText: J({ '平行事件': {} }), force: true });
    A('B7 **推演世界按段请求**：区间 1-7 → 3 段（1-3 / 4-6 / 7-7），逐段调用并聚合新增数；区间 ≤3 时仍是 1 段', (() => {
        const segs = r1.results.map((x) => [x.start, x.end]);
        return r1.ok === true && r1.chunks === 3 && r1.range === '1-7' && J(segs) === J([[1, 3], [4, 6], [7, 7]])
            && r1.added === 3 && r1.updated === 0
            && r2.ok === true && r2.chunks === 1 && r2.range === '4-6' && r2.added === 1
            && r3.ok === true && r3.chunks === 1 && r3.skipped === 'empty' && r3.added === 0;
    })(), () => J({ c1: r1.chunks, segs: r1.results.map((x) => [x.start, x.end]), added: r1.added, c2: r2.chunks, c3: r3.chunks }));
})();

// ---------- C 组：面板批次行（段长对用户可见） ----------
A('C1 面板批次行：`range` 为**字符串**（生产形态「4-9」）时显示「分段 x/y · 第 4-9 楼 · 每段 ≤3 个正文」', (() => {
    boot();
    setPanelHooks2({
        busy: () => true,
        batchProgress: () => ({ segTotal: 2, segDone: 1, range: '4-9', chunkSize: 3, since: Date.now() - 2000, aborted: false }),
    });
    const rows = String(pipelineBoxRowsHtml());
    return rows.indexOf('data-ftt-pipeline-row="batch"') >= 0 && rows.indexOf('分段 1/2') >= 0
        && rows.indexOf('第 4-9 楼') >= 0 && rows.indexOf('每段 ≤3 个正文') >= 0;
})(), () => pipelineBoxRowsHtml());

A('C2 面板批次行：`range` 为**对象**（`{start,end}` 调用方形态）时同样显示区间（两种形态都认，不倒退）', (() => {
    boot();
    setPanelHooks2({
        busy: () => true,
        batchProgress: () => ({ segTotal: 8, segDone: 3, range: { start: 9, end: 16 }, chunkSize: 3, since: Date.now() - 1000 }),
    });
    const rows = String(pipelineBoxRowsHtml());
    return rows.indexOf('分段 3/8') >= 0 && rows.indexOf('第 9-16 楼') >= 0 && rows.indexOf('每段 ≤3 个正文') >= 0;
})(), () => pipelineBoxRowsHtml());

await (async () => {
    boot();
    const T = buildBridgeMethods();
    // 未配置 → 来源 = default（3）；已配置 → 来源 = cfg
    const dflt = await T['ftt.chunkPlan']();
    const keep = cfg.summaryChunkSize;
    cfg.summaryChunkSize = 5;
    const configured = await T['ftt.chunkPlan']();
    cfg.summaryChunkSize = keep;
    A('C3 调试桥 `ftt.chunkPlan`（只读）：给出生效段长 + 是否内置默认 + 未摘要楼层会被切成几段 + 前几段预览', (() => {
        return dflt && dflt.chunkSize === 3 && dflt.isBuiltinDefault === true && dflt.cfgValue === 3
            && dflt.pending === 11 && dflt.pendingSegments === 4
            && JSON.stringify(dflt.pendingPreview) === J([{ start: 1, end: 3, floors: 3 }, { start: 4, end: 6, floors: 3 }, { start: 7, end: 9, floors: 3 }, { start: 10, end: 11, floors: 2 }])
            && configured && configured.chunkSize === 5 && configured.isBuiltinDefault === false && configured.cfgValue === 5
            && configured.pendingSegments === 3
            && dflt.running && dflt.running.chunkSize === 3;
    })(), J({ dflt, configured }));
})();

R.done();
