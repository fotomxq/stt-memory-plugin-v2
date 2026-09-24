// ============================================================
// 单元测试 · P9d AI 独立分组抽取（`dimensionGrouping === 'separate'`）+ 被动调度接线
//   （与**真实 V1 插件** v1.206 逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-separate-dim.json —— 由 `tests/fixtures/gen-v1-golden-separate-dim.cjs` 直调生成：
//     ① 分组构造（启用维度各自单组 / 未启用维度合成一个「统一」组）
//     ② 每组提示词（**逐字符**，取自真实请求体）+ `cfg.dimensionPresets` 参与方式（命中预设 → 走预设 url/model）
//     ③ 并行失败互不影响（fetch 抛错 / HTTP 500 / 无该维度数据）
//     ④ 逐组 `mergeDelta` 切片与计数（同一份「全维度」响应喂给每组，只有该组切片落库）
//     ⑤ 合并成功后 `scheduleParallelWeave` 的**轮次与参数**（间隔未到 → 每个成功组各一次；正常 → 1 个 1.8s 定时器）
//     ⑥ `jsExtractKeywords` 输出
// 覆盖（本文件）：
//   G 组：与 V1 逐项比对（分组构造 / 提示词逐字符 / 切片计数 / 失败互不影响 / dimensionPresets 不适用）
//   V 组：V2 编排（分段路径分支 / 单楼不分支 / 统一模式零影响）
//   W 组：被动调度接线（排程一次 · 防抖合并 · 失败不排程 · 间隔闸门 · 关键词 · 保存/落盘链路）
//   U/F 组：设定页「独立分组」开关（V1 代理键）+ `FTT.*` 入口
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { jsExtractKeywords } from '../../core/parallel.js';
import {
    analyzeFloor, analyzeSegment, runAutoSummary, runSummarySeparate, summaryDimGroups,
    separateGroupingEnabled, V1_SUMMARY_DIM_KEYS, enabledDims, promptToGenerateArgs,
} from '../../host/extract.js';
import { isFloorProcessed } from '../../host/floors.js';
import { settingsPageHtml, settingsSubTabsHtml, applySettingsControl } from '../../ui/settings-pages.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-separate-dim.json'), 'utf8'));
const R = makeReporter('separate-dim-golden P9d 独立分组抽取 + 被动调度接线（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const chat = [{ is_user: true, mes: '开场。', name: 'User' }];
for (let i = 1; i <= 11; i++) chat.push({ is_user: false, mes: '第' + i + '楼正文：甲在码头清点货物并记录去向。', name: '角色甲' });
const host = makeHost({ chat });
const un = installGlobalHost(host, doc);

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

/** 记录型定时器钩子（P9d：内核延迟排程全部经 `timerHooks`；驱动 = 手动调回调） */
let timers = [];
/** V2 口径的等价启用表：只有 3 个维度各自成组，其余 7 个走「统一」组（与 oracle `input.cfg.dimensionEnabled` 等价） */
const SEP_DIMS = {
    atoms: true, currentStates: true, plans: true,
    snapshots: false, memories: false, items: false, scenes: false, concepts: false, currencies: false, rumors: false,
    suspense: false, parallels: false, links: false, plotSegments: false,
};
function boot(cfgPatch, stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('角色甲');
    setLastMessageId(chat.length - 1);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai' }), feedText: () => '', busy: () => false });
    setNotifyHooks({ toast: () => undefined });
    return state;
}
/** 驱动并清空已记录的排程（`fireWeave` / 情节总结回调开头即复位模块级定时器位，必须驱动才能「解锁」后续排程） */
async function drainTimers() {
    const list = timers.slice();
    timers = [];
    for (const t of list) { try { await t.fn(); } catch (e) { /* 忽略 */ } }
}
const timerMs = (ms) => timers.filter((t) => t.ms === ms);
const deltas = (keys) => { const o = {}; keys.forEach((k) => { o[k] = { add: [{ title: 'T' + k, text: '甲在码头清点货物（正文足够长）。', date: '1919-11-29' }] }; }); return o; };
const counts = () => ({
    atoms: (state.atoms || []).length, states: (state.currentStates || []).length, snapshots: (state.snapshots || []).length,
    memories: (state.memories || []).length, items: (state.items || []).length, plans: (state.plans || []).length,
    suspense: (state.suspense || []).length, scenes: (state.scenes || []).length, concepts: (state.concepts || []).length,
    currencies: (state.currencies || []).length, rumors: (state.rumors || []).length,
});
const ORACLE_SEED = G.input.seed;

// ============================================================
// G 组：与 V1 逐项比对
// ============================================================
await A('G1 分组构造与 V1 `runSummarySeparate` 一致：启用维度各自单组 + 未启用维度合成「统一」组（顺序 = V1 DIMENSIONS 顺序）', async () => {
    boot();
    const a = summaryDimGroups(Object.keys(SEP_DIMS).filter((k) => SEP_DIMS[k] === true));
    const empty = summaryDimGroups([]);                    // V2 口径：空表 = 全部启用（`config.dimensionEnabled = {}` 的 V2 语义）
    return J(a) === J({ enabled: ['atoms', 'states', 'plans'], rest: G.expectedGroups[3].dims })
        && G.expectedGroups.length === 4 && G.expectedGroups[0].dim === 'atoms' && G.expectedGroups[3].dim === '统一'
        && empty.rest.length === 0 && empty.enabled.length === V1_SUMMARY_DIM_KEYS.length
        && V1_SUMMARY_DIM_KEYS.indexOf('suspense') < 0 && V1_SUMMARY_DIM_KEYS.indexOf('parallels') < 0;   // V1 表本身不含二者
}, () => summaryDimGroups(['atoms', 'states', 'plans']));

await A('G2 每组提示词与 V1 真实请求体**逐字符**一致（system + user 两条；含 V1 的「统一」组把未启用维度并成一次）', async () => {
    boot(null, ORACLE_SEED);
    const bad = [];
    for (const g of G.run1.groups) {
        const grp = G.expectedGroups.filter((x) => x.dim === g.dim)[0];
        const msgs = await buildSummaryPrompt(G.input.floorText, grp.dims);
        if (J(msgs) !== J(g.messages)) bad.push(g.dim);
    }
    return bad.length === 0 && G.run1.groups.length === 4 && G.run1.groups[1].url.indexOf('preset-a.example') >= 0;
}, () => G.run1.groups.map((g) => [g.dim, g.messages[0].content.length]));

await A('G3 逐组 `mergeDelta` 切片与计数：同一份「全维度」响应喂给每组，每组只落自己那一片（含 plans 组带 suspense）', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    const seen = [];
    const ai = async (args, label) => { seen.push(label); return { ok: true, text: J(G.kitchenSink) }; };
    const r = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai });
    const view = r.map((x) => ({ dim: x.dim, ok: !!(x.ok && x.ok.ok), added: x.ok && x.ok.added, total: x.ok && x.ok.total }));
    const want = G.run1.results.map((x) => ({ dim: x.dim, ok: x.ok, added: x.merged.added, total: x.merged.total }));
    const ok = J(view) === J(want) && J(counts()) === J(G.run1.state)
        && seen.length === 4 && seen[0] === '摘要[情节]' && seen[3] === '摘要[统一]'
        && r[2].ok.suspense === undefined;                       // 组外维度**没有**被并入 sub（plans 组只带 plans+suspense）
    await drainTimers();                                          // 成功组已排程 1.8s weave；驱动以复位模块级 weaveTimer
    return ok;
}, () => ({ view: (state.atoms || []).length }));

await A('G4 并行失败互不影响：fetch 抛错 / AI 通道失败 / 无该维度数据 三种失败各自只影响自己那组（无未捕获 rejection）', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    const ai = async (args, label) => {
        if (label === '摘要[状态]') throw new Error('模拟网络中断');
        if (label === '摘要[计划悬念]') return { ok: false, error: '模拟 API 500' };
        if (label === '摘要[统一]') return { ok: true, text: J({ 无关维度: { add: [] } }) };
        return { ok: true, text: J(G.kitchenSink) };
    };
    let threw = '';
    let r = [];
    try { r = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai }); } catch (e) { threw = String(e.message || e); }
    // 口径：V1 的失败文案来自其**自建 OpenAI 通道**（`摘要 API 500: boom` / fetch 异常原文），V2 走注入通道
    //   （`{ok:false,error}` / 抛错原文）——故此处只比对「哪几组失败 + 失败原因非空」，不比对通道文案（见 docs/P9d）
    const view = r.map((x) => ({ dim: x.dim, ok: !!(x.ok && x.ok.ok) }));
    const want = G.run2.results.map((x) => ({ dim: x.dim, ok: x.ok }));
    const wantErr = G.run2.results.map((x) => !!x.error);
    const ok = threw === '' && J(view) === J(want) && J(counts()) === J(G.run2.state)
        && J(r.slice(1).map((x) => !!(x.error && String(x.error).length))) === J(wantErr.slice(1))
        && r[0].ok.ok === true && r[0].ok.added === 1                        // 成功组照常落库
        && r[3].error === '无该维度数据' && r[1].error === '模拟网络中断' && r[2].error === '模拟 API 500';
    await drainTimers();
    return ok;
}, () => ({ threw: 'x' }));

await A('G5 `cfg.dimensionPresets` 在 V2 不适用：设置与否提示词与结果**完全一致**（宿主通道无按次预设），且未产生预设下拉控件', async () => {
    const run = async (patch) => {
        boot(Object.assign({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, patch), ORACLE_SEED);
        const prompts = [];
        const ai = async (args, label) => { prompts.push([label, args.systemPrompt.length, args.prompt.length]); return { ok: true, text: J(G.kitchenSink) }; };
        const r = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai });
        await drainTimers();
        return { prompts, r: r.map((x) => x.dim + ':' + !!(x.ok && x.ok.ok)) };
    };
    const legacy = await run({ dimensionPresets: { states: '预设甲' }, apiPresets: G.input.cfg.apiPresets, activeApiPreset: '' });
    const none = await run({ dimensionPresets: {}, apiPresets: {}, activeApiPreset: '' });
    const html = settingsPageHtml('analyze');
    const api = promptToGenerateArgs([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    return J(legacy) === J(none)
        && Object.keys(api).sort().join(',') === 'prompt,systemPrompt'                  // V2 入参只有这两键（无 preset 概念）
        && html.indexOf('data-ftt-cfg="dimensionSeparate"') >= 0
        // **不设**任何维度预设控件（不放假控件）：无 `dimensionPresets` 控件键 / 无 `data-ftt-dim-preset` / 无维度选择下拉
        && html.indexOf('data-ftt-cfg="dimensionPresets"') < 0 && html.indexOf('data-ftt-dim-preset') < 0
        && html.indexOf('<select data-ftt-cfg="dimension') < 0;
}, '');

await A('G6 V1 原样怪癖：AI 回**中文维度键** → 对照组判「无该维度数据」（切片发生在 `mergeDelta` 键归一之前）；零落库、零排程', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    const cn = { 情节: { add: [{ 标题: '清点' }] }, 状态记录: { add: [{ 主体: '甲' }] }, 记忆库: { add: [{ 归属: '甲' }] } };
    const r = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai: async () => ({ ok: true, text: J(cn) }) });
    const view = r.map((x) => ({ dim: x.dim, ok: !!(x.ok && x.ok.ok), error: x.error }));
    const want = G.run5.results.map((x) => ({ dim: x.dim, ok: x.ok, error: x.error }));
    const ok = J(view) === J(want) && J(counts()) === J(G.run5.state) && timerMs(1800).length === 0 && G.run5.weaveTimers === 0;
    await drainTimers();
    return ok;
}, () => G.run5.results);

// ============================================================
// V 组：V2 编排（分支位置与 V1 一致）
// ============================================================
await A('V1 分段路径接入独立分组：`analyzeSegment` → `separate:true`（组数/成功数/失败数如实回报；`added:0` 为 V1 原样怪癖）', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    const ai = async () => ({ ok: true, text: J(G.kitchenSink) });
    const r = await analyzeSegment(2, 5, { ai });
    const ok = r.ok === true && r.separate === true && r.groups === 4 && r.groupOk === 4 && r.groupFailed === 0
        && r.added === 0 && r.floorStart === 2 && r.floorEnd === 5
        && Array.isArray(r.groupResults) && r.groupResults.length === 4
        && [2, 3, 4, 5].every((f) => isFloorProcessed(f)) && separateGroupingEnabled() === true;
    await drainTimers();
    return ok;
}, '');

await A('V2 单楼分析**不**分支（V1 事实：`dimensionGrouping` 只在分段路径判定）：`analyzeFloor` 仍走统一单请求', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    let calls = 0;
    const ai = async () => { calls++; return { ok: true, text: J(G.kitchenSink) }; };
    const r = await analyzeFloor(3, { ai });
    const ok = calls === 1 && r.ok === true && r.separate === undefined && (state.snapshots || []).length === 1;   // 全维度一次落库
    await drainTimers();
    return ok;
}, '');

await A('V3 统一模式（默认 `unified`）行为零变化：单次 AI 调用 + 单次 mergeDelta + 全量落库', async () => {
    boot({ dimensionGrouping: 'unified' }, ORACLE_SEED);
    let calls = 0;
    const ai = async () => { calls++; return { ok: true, text: J(G.kitchenSink) }; };
    const r = await analyzeSegment(2, 5, { ai });
    const c = counts();
    const ok = calls === 1 && r.separate === undefined && r.floorEnd === 5 && r.added > 0
        && Object.keys(c).filter((k) => c[k] >= 1).length === 11;          // 统一模式**全量**落库（独立分组下才逐组切片）
    await drainTimers();
    return ok;
}, '');

// ============================================================
// W 组：被动调度接线（保存/合并成功后自动排程）
// ============================================================
await A('W1 单楼分析合并成功 → `scheduleParallelWeave` 1.8s + `scheduleAtomCompact` 4s **各排程一次**；驱动 weave 后 `weaveLastFloor` 落到该楼（V1 15240/15242）', async () => {
    boot(null, ORACLE_SEED);
    const r = await analyzeFloor(4, { ai: async () => ({ ok: true, text: J(deltas(['atoms'])) }) });
    const ok = r.ok === true && timerMs(1800).length === 1 && timerMs(4000).length === 1;
    await drainTimers();
    return ok && Number(state.weaveLastFloor) === 4;
}, () => ({ ms: timers.map((t) => t.ms) }));

await A('W2 失败不排程：AI 未返回 JSON → weave 与情节总结检查点**都不排程**（V1 15236~15237 早退；只排自动修复 15s 重试）', async () => {
    boot(null, ORACLE_SEED);
    const r = await analyzeFloor(4, { ai: async () => ({ ok: true, text: '没有 JSON' }) });
    const ok = r.ok === false && r.reason === 'no-json' && timerMs(1800).length === 0 && timerMs(4000).length === 0
        && timerMs(15000).length === 1;                                   // 自动修复的延迟重试（V1 `scheduleAutoRepairOnMergeFail`）
    await drainTimers();
    return ok;
}, () => ({ ms: timers.map((t) => t.ms) }));

await A('W3 分段分析（统一路径）合并成功 → 排程 weave，参数 = 段区间（驱动后 `weaveLastFloor` = 段末楼；V1 15490）', async () => {
    boot(null, ORACLE_SEED);
    let prompts = '';
    const r = await analyzeSegment(6, 9, { ai: async (args) => { prompts = String(args.prompt); return { ok: true, text: J(deltas(['atoms'])) }; } });
    const ok = r.ok === true && timerMs(1800).length === 1 && prompts.indexOf('第6楼') >= 0;
    await drainTimers();
    return ok && Number(state.weaveLastFloor) === 9;
}, () => ({ ms: timers.map((t) => t.ms) }));

await A('W4 批量分析收尾（finally）→ 情节总结检查点**防抖合并**：3 段成功也只排 1 个 4s 定时器（V1 15537，`scheduleAtomCompact` 自身去重）', async () => {
    boot({ summaryChunkSize: 4, feedFloors: 12, timelyAnalysis: true }, ORACLE_SEED);
    const ai = async () => ({ ok: true, text: J(deltas(['atoms'])) });
    const r = await runAutoSummary({ silent: false, ai });
    const ok = r.made >= 2 && timerMs(4000).length === 1 && timerMs(1800).length === 1;   // weave 同样被「已在调度中」去重
    await drainTimers();
    return ok;
}, () => ({ made: 0, ms: timers.map((t) => t.ms) }));

await A('W5 独立分组：**每个成功组各调用一次** `scheduleParallelWeave`；间隔未到 → 0 定时器（与 oracle `run3.intervalSkipLogs` 同口径），且模块级 `weaveTimer` 去重后仅 1 个定时器', async () => {
    // ① 间隔未到（parallelWeaveInterval = 999 且 weaveLastFloor = 4）→ 4 个成功组各被间隔闸门拦下 → 0 定时器
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS, parallelWeaveInterval: 999 }, Object.assign(clone(ORACLE_SEED), { weaveLastFloor: 4 }));
    const ai = async () => ({ ok: true, text: J(G.kitchenSink) });
    const r1 = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai });
    const blocked = timerMs(1800).length === 0 && r1.filter((x) => x.ok).length === 4;
    await drainTimers();
    // ② 间隔到（0）→ 首个成功组建 1.8s 定时器，其余被「已在调度中」静默丢弃 → 仍 1 个（V1 原生怪癖）
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS, parallelWeaveInterval: 0 }, Object.assign(clone(ORACLE_SEED), { weaveLastFloor: -1 }));
    const r2 = await runSummarySeparate(G.input.floorText, G.input.floorRange, { ai });
    const one = timerMs(1800).length === 1 && r2.filter((x) => x.ok).length === 4;
    await drainTimers();
    return blocked && one && G.run3.intervalSkipLogs === 4 && G.run4.weaveTimers === 1;
}, '');

await A('W6 `jsExtractKeywords` 与 V1 同源（oracle `run4.keywordsAtWeave`）：命中正文的特征词按来源顺序去重、上限 10、长度 ≥2', async () => {
    boot(null, ORACLE_SEED);
    const kw = jsExtractKeywords(G.input.floorText);
    const short = jsExtractKeywords('甲');
    const none = jsExtractKeywords('与记忆库无关的一段话。');
    return J(kw) === J(G.run4.keywordsAtWeave) && kw.length === 2 && kw[0] === '码头' && kw[1] === '铜箱'
        && J(short) === J([]) && J(none) === J([])
        && jsExtractKeywords('').length === 0;
}, () => jsExtractKeywords(G.input.floorText));

// ============================================================
// U/F 组：设定页开关与 `FTT.*` 入口
// ============================================================
await A('U1 分析记忆页：V1 同款「独立分组」开关（标签逐字 + 关闭态文案逐字 + 状态随真键切换）；代理键写回真键 `cfg.dimensionGrouping`', async () => {
    boot();
    const tab = settingsSubTabsHtml('analyze');
    let html = settingsPageHtml('analyze');
    const off = html.indexOf('>独立分组</label>') >= 0 && html.indexOf('统一分组（一次请求全部维度）') >= 0
        && html.indexOf('data-ftt-cfg="dimensionSeparate"') >= 0 && html.indexOf('checked') > 0 ? true : false;
    const r1 = applySettingsControl('dimensionSeparate', true);
    html = settingsPageHtml('analyze');
    const on = r1.ok === true && cfg.dimensionGrouping === 'separate'
        && html.indexOf('独立分组（各维度单独构造提示词并行请求）') >= 0 && html.indexOf('data-ftt-cfg="dimensionSeparate" checked') >= 0;
    const r2 = applySettingsControl('dimensionSeparate', false);
    const back = cfg.dimensionGrouping === 'unified' && settingsPageHtml('analyze').indexOf('统一分组（一次请求全部维度）') >= 0;
    return tab.indexOf('data-ftt-settings="analyze"') >= 0 && off && on && back && r2.ok === true
        && (cfg.dimensionEnabled && typeof cfg.dimensionEnabled === 'object');
}, '');

await A('F1 `FTT.*` 入口齐备：jsExtractKeywords / runSummarySeparate / summaryDimGroups / separateGroupingEnabled；devtools 无 hook 时按约定降级（不抛错）', async () => {
    boot({ dimensionGrouping: 'separate', dimensionEnabled: SEP_DIMS }, ORACLE_SEED);
    installDevtools({});
    const names = ['jsExtractKeywords', 'runSummarySeparate', 'summaryDimGroups', 'separateGroupingEnabled'];
    const noHookOk = names.every((n) => typeof globalThis.FTT[n] === 'function')
        && J(globalThis.FTT.jsExtractKeywords('x')) === J([])
        && J(await globalThis.FTT.runSummarySeparate('x', { start: 0, end: 0 })) === J([])
        && globalThis.FTT.separateGroupingEnabled() === false;
    uninstallDevtools();
    installDevtools({
        jsExtractKeywords: (t) => jsExtractKeywords(t), runSummarySeparate: (t, fr, o) => runSummarySeparate(t, fr, o),
        summaryDimGroups: (d) => summaryDimGroups(d), separateGroupingEnabled: () => separateGroupingEnabled(),
    });
    const wired = J(globalThis.FTT.jsExtractKeywords(G.input.floorText)) === J(G.run4.keywordsAtWeave)
        && globalThis.FTT.separateGroupingEnabled() === true
        && globalThis.FTT.summaryDimGroups(['atoms', 'states', 'plans']).enabled.length === 3;
    uninstallDevtools();
    await drainTimers();
    return noHookOk && wired && globalThis.FTT === undefined;
}, '');

un();
R.done();
