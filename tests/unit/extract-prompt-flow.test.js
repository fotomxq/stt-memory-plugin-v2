// ============================================================
// 单元测试 · P4 首批（AI 摘要提示词 core/prompt.js + 提取编排 host/extract.js）
// 黄金样本：tests/fixtures/v1-golden-prompt.json（oracle = 真实 V1 插件 v1.206 的 buildSummaryPrompt 输出）
// 口径：提示词逐字符一致；编排侧验证「判据 → AI → JSON → mergeDelta → 台账 → 落盘」全链路与失败姿态。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { hashText } from '../../core/util.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import {
    analyzeFloor, analyzeFloors, autoExtractLatest, promptToGenerateArgs, enabledDims,
    extractStats, extractSummary,
} from '../../host/extract.js';
import {
    floorAnalyzableText, hashFloorText, isFloorProcessed, recordProcessedFloors, listUnprocessedFloors,
    processedStats, PROCESSED_SIG, PROCESSED_VER, floorStableText, assistantTextOf,
} from '../../host/floors.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-prompt.json'), 'utf8'));
const R = makeReporter('extract prompt + flow（P4 首批）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));

// 桩宿主：chat 含用户楼 / 正常 AI 楼 / 占位楼 / 隐藏楼 / 多刷楼
const host = makeHost({
    chat: [
        { is_user: true, mes: '我们把木箱抬进仓库。', name: 'User' },
        { is_user: false, mes: '甲用铜钥匙打开木箱，里面是发黄的账册。', name: '角色甲' },
        { is_user: false, mes: '……', name: '角色甲' },
        { is_user: false, mes: '这一楼被隐藏了。', name: '角色甲', is_hidden: true },
        { is_user: false, mes: '第二刷正文：甲把账册塞回木箱。', name: '角色甲', swipes: ['原始首刷：甲合上木箱。', '第二刷正文：甲把账册塞回木箱。'], swipe_id: 1 },
    ],
});
const uninstall = installGlobalHost(host, null);
const ctx = host.ctx;

function bootKernel(extra) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('角色甲');
    setKernelState(Object.assign(emptyState(), { state: { date: '1919-11-29', time: '夜', location: '码头' } }, extra || {}));
    setLastMessageId(ctx.chat.length - 1);
    let indexReady = false;
    setPersistHooks({
        saveState: () => { if (!indexReady) { entryIndexInit(); indexReady = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
}

// ---------- 提示词（黄金样本 11） ----------
await (async () => {
    Object.assign(cfg, clone(defaultCfg));
    setKernelState(Object.assign(emptyState(), clone(G.seed)));
    const msgs = await buildSummaryPrompt(G.floors, G.dims);
    R.assert('P1 buildSummaryPrompt 与 V1 逐字符一致（system + user 两条消息；含维度说明 / 已有索引 / 货币账本 / 本轮对话）', (() => {
        return J(msgs) === J(G.messages) && msgs.length === 2
            && msgs[0].role === 'system' && msgs[1].role === 'user'
            && msgs[1].content.indexOf('【本轮对话】') >= 0 && msgs[1].content.indexOf(G.floors.slice(-20)) > 0;
    })(), { gotLen: msgs[0].content.length, wantLen: G.messages[0].content.length });

    R.assert('P2 promptToGenerateArgs：system 归 systemPrompt、其余并入 prompt；单条消息亦可', (() => {
        const a = promptToGenerateArgs(msgs);
        const b = promptToGenerateArgs('纯文本');
        return a.systemPrompt === msgs[0].content && a.prompt === msgs[1].content
            && b.systemPrompt === '' && b.prompt === '纯文本'
            && promptToGenerateArgs([{ role: 'user', content: 'u' }, { role: 'system', content: 's' }]).prompt === 'u';
    })(), {});

    R.assert('P3 enabledDims：未配置=全部 14 维；关掉两维后只返回其余', (() => {
        cfg.dimensionEnabled = {};
        const all = enabledDims();
        cfg.dimensionEnabled = { atoms: false, rumors: false };
        const some = enabledDims();
        return all.length === 14 && some.length === 12 && some.indexOf('atoms') < 0 && some.indexOf('rumors') < 0;
    })(), {});
})();

// ---------- 楼层判据与台账 ----------
await (async () => {
    bootKernel();
    R.assert('F1 可分析正文：AI 楼带 `[第N楼 AI]` 前缀；用户楼/占位楼/隐藏楼不产出文本', (() => {
        const ai = floorAnalyzableText(1);
        return ai.indexOf('[第1楼 AI]') === 0 && ai.indexOf('铜钥匙') > 0
            && floorAnalyzableText(2) === ''            // 占位楼「……」
            && floorAnalyzableText(3) === ''            // 隐藏楼
            && floorAnalyzableText(99) === '';          // 越界
    })(), { ai: floorAnalyzableText(1).slice(0, 40) });

    R.assert('F2 楼层哈希用「稳定首刷」：多刷楼取 swipes[0] 而非当前刷', (() => {
        const h = hashFloorText(4);
        return h === hashText('原始首刷：甲合上木箱。') && h !== hashText('第二刷正文：甲把账册塞回木箱。')
            && assistantTextOf(ctx.chat[4]) === '第二刷正文：甲把账册塞回木箱。'
            && floorStableText(ctx.chat[4]) === '原始首刷：甲合上木箱。';
    })(), { h: hashFloorText(4) });

    R.assert('F3 台账：初始未分析 → 记录后为已分析 → 正文改动即视为未分析（V1 同口径）', (() => {
        const before = isFloorProcessed(1);
        recordProcessedFloors(1, 1);
        const after = isFloorProcessed(1);
        const tag = (state.processedVer || '');
        ctx.chat[1].swipes = ['原始首刷被改写。'];
        const changed = isFloorProcessed(1);
        ctx.chat[1].swipes = ['甲用铜钥匙打开木箱，里面是发黄的账册。'];
        const restored = isFloorProcessed(1);
        return before === false && after === true && changed === false && restored === true
            && tag === PROCESSED_VER + ':' + PROCESSED_SIG && PROCESSED_SIG === '11n8nlu'
            && processedStats().lastKnownFloor === 1;
    })(), { sig: PROCESSED_SIG, stats: processedStats() });

    R.assert('F4 未分析清单：跳过用户楼 / 隐藏楼 / 占位楼 / 已分析楼（含 limit）', (() => {
        bootKernel();
        const all = listUnprocessedFloors({});
        recordProcessedFloors(1, 1);
        const rest = listUnprocessedFloors({});
        const limited = listUnprocessedFloors({ limit: 1 });
        return J(all) === J([1, 4]) && J(rest) === J([4]) && limited.length === 1 && limited[0] === 4;
    })(), { all: listUnprocessedFloors({}) });
})();

// ---------- 编排：AI → JSON → mergeDelta → 台账 ----------
const DELTA = {
    atoms: { add: [{ title: '账册现世', text: '甲用铜钥匙打开木箱，取出一本发黄的账册。', date: '1919-11-29', tags: ['账册'], importance: 0.8 }] },
    memories: { add: [{ owner: '甲', content: '甲记得账册上写着转运记录。', date: '1919-11-29' }] },
};
const aiOk = async () => ({ ok: true, text: '```json\n' + J(DELTA) + '\n```' });

await (async () => {
    bootKernel();
    const r = await analyzeFloor(1, { ai: aiOk });
    const st = extractStats();
    R.assert('E1 analyzeFloor：AI 返回 JSON → 落库（情节 + 记忆）+ 台账记录 + 统计（added/维度）', (() => {
        return r.ok === true && r.added === 2 && r.total === 2
            && r.deltaKeys.indexOf('atoms') >= 0 && r.deltaKeys.indexOf('memories') >= 0
            && (state.atoms || []).length === 1 && state.atoms[0].title === '账册现世'
            && (state.memories || []).length === 1 && isFloorProcessed(1) === true
            && st.runs === 1 && st.ok === 1 && st.fail === 0 && st.lastAdded === 2 && st.lastFloor === 1;
    })(), r);

    const again = await analyzeFloors({ ids: [] });
    R.assert('E2 analyzeFloors：已分析楼层不再重复分析（无待分析时返回 note）', (() => {
        return again.ok === true && J(again.floors) === J([]) && (state.atoms || []).length === 1;
    })(), again);
})();

await (async () => {
    bootKernel();
    const before = extractStats();
    const rBad = await analyzeFloor(1, { ai: async () => ({ ok: true, text: '这次没有 JSON' }) });
    const rErr = await analyzeFloor(1, { ai: async () => { throw new Error('网络炸了'); } });
    const savedGen = ctx.generateRaw;
    delete ctx.generateRaw;                                   // 无 AI 能力（宿主未提供 generateRaw）
    const rNoGen = await analyzeFloor(1, {});
    ctx.generateRaw = savedGen;
    R.assert('E3 失败姿态：非 JSON → no-json；AI 抛错 → error；无 AI 能力 → no-generate（且都不写台账、不抛）', (() => {
        const st = extractStats();
        return rBad.ok === false && rBad.reason === 'no-json'
            && rErr.ok === false && rErr.reason === 'error'
            && rNoGen.ok === false && rNoGen.reason === 'no-generate'
            && (state.atoms || []).length === 0 && isFloorProcessed(1) === false
            && (state.processedFloors || []).length === 0
            && st.ok === before.ok && st.fail === before.fail + 3;   // 三次失败都计数、零成功
    })(), { rBad, rErr, rNoGen });

    R.assert('E4 空楼层不调用 AI（empty-floor）：占位楼 / 隐藏楼 / 越界楼都直接拒绝', (() => {
        const before = extractStats().runs;
        return floorAnalyzableText(2) === '' && floorAnalyzableText(3) === ''
            && floorAnalyzableText(42) === '' && before === extractStats().runs;
    })(), {});
})();

await (async () => {
    bootKernel();
    const seen = [];
    const r = await analyzeFloor(4, { ai: async (args) => { seen.push(args); return { ok: true, text: J(DELTA) + '\n' + J(DELTA) }; } });
    R.assert('E5 入参形状：AI 收到 {systemPrompt, prompt}；prompt 含本轮楼层正文与维度说明', (() => {
        const a = seen[0] || {};
        return r.ok === true && seen.length === 1
            && String(a.systemPrompt).length > 500 && String(a.systemPrompt).indexOf('维度') > 0
            && String(a.prompt).indexOf('第二刷正文') > 0;
    })(), { calls: seen.length });
})();

await (async () => {
    bootKernel();
    let release;
    const gate = new Promise((res) => { release = res; });
    const slow = (async () => { await gate; return { ok: true, text: J(DELTA) }; })();   // 注意：立即求值成 Promise
    const p1 = analyzeFloors({ ids: [1], ai: () => slow });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = await analyzeFloors({ ids: [4], ai: aiOk });
    release();
    const r1 = await p1;
    R.assert('E6 忙碌保护：同一时刻只允许一个提取任务（第二次返回 busy，不并发写库）', (() => {
        return p2.ok === false && p2.reason === 'busy' && r1.ok === true && (state.atoms || []).length === 1;
    })(), { p2, r1: { ok: r1.ok, done: r1.done, reason: r1.reason } });
})();

await (async () => {
    bootKernel();
    const runsBefore = extractStats().runs;
    cfg.autoExtract = false;
    const off = await autoExtractLatest({ ai: aiOk });
    cfg.autoExtract = true;
    const on = await autoExtractLatest({ ai: aiOk });
    R.assert('E7 自动提取：总开关关闭 → off（零 AI 调用）；开启 → 分析最后一楼未分析楼层（跳过倒数第二楼占位）', (() => {
        const st = extractStats();
        return off.ok === false && off.reason === 'off'
            && on.ok === true && J(on.floors) === J([4]) && on.done === 1
            && st.runs === runsBefore + 1 && (state.atoms || []).length === 1 && isFloorProcessed(4) === true;
    })(), { off, on: { ok: on.ok, floors: on.floors } });

    const s = extractSummary();
    R.assert('E8 提取状态摘要：统计 + 台账 + 待分析数（供 /ftt 与调试导出）', (() => {
        return s.runs >= 1 && s.ok >= 1 && s.processed && s.processed.marks >= 1
            && s.processed.tag === PROCESSED_VER + ':' + PROCESSED_SIG && typeof s.pending === 'number' && s.pending >= 0;
    })(), { runs: s.runs, pending: s.pending });
})();

uninstall();
R.done();
