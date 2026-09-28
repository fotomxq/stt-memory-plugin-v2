// ============================================================
// 单元测试 · v2.90.0「管线状态：流式摘要 + token 计数 + 预估倒计时」
// 用户要求（原话）：「管线状态中的提示信息，补充流式更新细节，不需要让用户看到具体内容，只提取一些摘要展示，
//   让用户感知正在处理。其次除了读秒，还需增加 token 计数、预估倒计时。其中预估倒计时，可内置记录
//   最近几次不同处理行为的耗时作为参考。如果为第一次，则给一个潜在默认时间作为倒计时。」
// 覆盖：A token 估算与展示；B 预估倒计时（默认表 / 历史均值 / 去极值 / 样本上限）；C 运行中快照与状态后缀；
//       D 结构摘要**不含内容**（只取顶层键）；E 面板「管线状态」行并入 token / 倒计时 / 摘要。
// 运行：node tests/unit/pipeline.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    estTokens, fmtTokens, fmtSec, etaMs, etaHasHistory, recordPipelineRun, ETA_SAMPLES,
    beginPipeline, endPipeline, addStreamChunk, setPipelinePhase, setPipelineKeys, setPipelineHooks,
    summarizeResponseKeys, snapshot, pipelineSuffix, pipelineSummaryText, resetPipeline, PIPELINE_DEFAULTS,
    noteResponseText, lastPipelineInfo,
} from '../../core/pipeline.js';
import { setLastMessageId } from '../../core/model/runtime.js';
import { entryIndexInit, entryIndexBuild } from '../../core/sweep.js';
import { analyzeFloor, analyzeSegment } from '../../host/extract.js';
import { sendViaProfile } from '../../host/api-channel.js';
import { setPanelHooks2, pipelineStatusText } from '../../ui/panel.js';

const R = makeReporter('pipeline v2.90.0 管线状态（流式摘要 / token / 预估倒计时）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
let hist = {};
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:pipeline');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    hist = {};
    setPipelineHooks({ getHistory: () => hist, saveHistory: (h) => { hist = h; } });
    resetPipeline();
}
boot();

// ---------- A 组：token 估算 ----------
A('A1 token 估算：`ceil(字符数 / 4)`；0 / 非法 → 0；展示缩写 1.2k / 1.5M', (() => {
    return estTokens(4) === 1 && estTokens(5) === 2 && estTokens(0) === 0 && estTokens(NaN) === 0
        && fmtTokens(999) === '999' && fmtTokens(1234) === '1.2k' && fmtTokens(1500000) === '1.5M'
        && fmtSec(1) === '1s' && fmtSec(1500) === '2s';
})(), () => ({ t: estTokens(5), k: fmtTokens(1234) }));

A('A2 运行中：prompt 与响应分别计 token，合计进快照（响应按流式分块累计字符）', (() => {
    boot();
    beginPipeline('单楼分析', { chars: 4000 });         // 1000 tok
    addStreamChunk('x'.repeat(400));                    // +100 tok
    addStreamChunk('y'.repeat(400));                    // +100 tok
    const s = snapshot();
    return s.busy === true && s.promptTokens === 1000 && s.respTokens === 200 && s.tokens === 1200
        && s.chunks === 2 && s.respChars === 800;
})(), () => snapshot());

// ---------- B 组：预估倒计时 ----------
A('B1 首次没有历史 → 用**内置默认表**（不同行为各自默认；未知行为回退「默认」）；`etaHasHistory` = false', (() => {
    boot();
    return etaMs('批量摘要') === PIPELINE_DEFAULTS['批量摘要'] && etaMs('向量检索') === PIPELINE_DEFAULTS['向量检索']
        && etaMs('从未出现的行为') === PIPELINE_DEFAULTS['默认']
        && etaHasHistory('批量摘要') === false;
})(), () => ({ batch: etaMs('批量摘要'), unknown: etaMs('从未出现的行为') }));

A('B2 有历史 → 取最近样本均值（≥3 个样本时去掉最大最小各一个，抗单次抖动）；保留最近 5 次', (() => {
    boot();
    [10000, 12000, 11000].forEach((v) => recordPipelineRun('自动修复', v));
    const mid = etaMs('自动修复');                       // 去极值后仅剩 11000
    for (let i = 0; i < 10; i++) recordPipelineRun('自动修复', 30000 + i);
    const arr = hist['自动修复'];
    return mid === 11000 && etaHasHistory('自动修复') === true
        && arr.length === ETA_SAMPLES && arr[arr.length - 1] === 30009;
})(), () => hist);

A('B3 各行为**互不影响**（按 label 分组）；非法样本（0 / 负数 / 非数）不入账', (() => {
    boot();
    recordPipelineRun('推演', 5000);
    recordPipelineRun('推演', 0);
    recordPipelineRun('推演', -3);
    recordPipelineRun('推演', 'x');
    return J(hist['推演']) === J([5000]) && J(hist['传言演化'] || []) === J([]) && etaMs('传言演化') === PIPELINE_DEFAULTS['传言演化'];
})(), () => hist);

// ---------- C 组：运行中状态与状态后缀 ----------
A('C1 状态后缀：`⏱ 已用 · 🪙 token · 预计剩 Xs`；无历史时倒计时标注「（默认）」；结束即不再输出后缀', (() => {
    boot();
    beginPipeline('单楼分析', { chars: 4000 });
    const s1 = pipelineSuffix();
    const midOk = s1.indexOf('🪙 1k tok') >= 0 && s1.indexOf('预计剩') >= 0 && s1.indexOf('（默认）') >= 0;
    addStreamChunk('z'.repeat(4000));
    const s2 = pipelineSuffix();
    const more = s2.indexOf('🪙 2k tok') >= 0 && s2.indexOf('流式 1 块') >= 0;
    endPipeline(true);
    return midOk && more && pipelineSuffix() === '' && snapshot().busy === false;
})(), () => pipelineSuffix());

A('C2 结束会记录本次耗时（供下次预估）；阶段推进只写结构信息，快照如实回报', (() => {
    boot();
    beginPipeline('提取记忆', { chars: 800 });
    setPipelinePhase('落库', '写入 3 条');
    const s = snapshot();
    setPipelineHooks({ now: () => s.elapsed + 1000 + (Date.now() - s.elapsed) });   // 让 endPipeline 看到 ≥1s
    endPipeline(true);
    const rec = hist['提取记忆'] || [];
    return s.phase === '落库' && s.note === '写入 3 条' && rec.length === 1 && rec[0] >= 900;
})(), () => hist);

// ---------- D 组：结构摘要不含内容 ----------
A('D1b v2.95.0：**优先解析 JSON 只取顶层键** —— 英文键响应（`{"atoms":{"add":[…]}}`）不再把 add/title/text/date 一起捞出来；截断响应回退正则扫描', (() => {
    const en = summarizeResponseKeys('{"atoms":{"add":[{"title":"x","text":"y","date":"z"}]},"memories":{"add":[]}}');
    const cut = summarizeResponseKeys('{"情节":{"新增":[{"标');
    const none = summarizeResponseKeys('没有 JSON');
    return J(en) === J(['atoms', 'memories']) && J(cut) === J(['情节']) && J(none) === J([]);
})(), () => J(summarizeResponseKeys('{"atoms":{"add":[]}}')));

A('D1 `summarizeResponseKeys`：只取**顶层键名**（过滤 新增/更新/删除 等二级键），不含任何正文', (() => {
    const text = '{"情节":{"新增":[{"标题":"在码头发现物品","内容":"角色甲发现被破坏的木箱"}]},"记忆库":{"新增":[]},"删除":[]}';
    const keys = summarizeResponseKeys(text);
    const leaked = keys.join('|').indexOf('码头') >= 0 || keys.join('|').indexOf('木箱') >= 0;
    return J(keys) === J(['情节', '记忆库']) && leaked === false;
})(), () => summarizeResponseKeys('{"情节":{"新增":[]},"记忆库":{}}'));

A('D2 结构摘要文本：优先给「识别到 …」；无键时退回阶段说明；空闲时为空串', (() => {
    boot();
    const idle = pipelineSummaryText();
    beginPipeline('提取记忆', { chars: 100 });
    setPipelinePhase('等待响应');
    const phase = pipelineSummaryText();
    setPipelineKeys(['情节', '记忆库']);
    const keys = pipelineSummaryText();
    endPipeline(true);
    return idle === '' && phase.indexOf('等待响应') >= 0 && keys === '识别到 情节 / 记忆库' && pipelineSummaryText() === '';
})(), () => pipelineSummaryText());

// ---------- E 组：面板「管线状态」行 ----------
A('E1 面板管线行：忙位时含读秒 + `🪙 token` + `预计剩`；空闲时为「空闲」', (() => {
    boot();
    setPanelHooks2({ busy: () => true, batchProgress: () => ({ segTotal: 4, segDone: 2, range: { start: 5, end: 8 }, since: Date.now() - 3000 }) });
    beginPipeline('批量摘要', { chars: 12000 });
    addStreamChunk('a'.repeat(2000));
    const t = pipelineStatusText(Date.now());
    const okBusy = t.busy === true && t.txt.indexOf('分段 2/4') > 0 && t.txt.indexOf('第 5-8 楼') > 0
        && t.txt.indexOf('已用时') > 0 && t.txt.indexOf('🪙') > 0 && t.txt.indexOf('预计剩') > 0
        && t.txt.indexOf('批量摘要') > 0 && t.tokens > 0 && t.remain > 0;
    endPipeline(true);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}) });
    const idle = pipelineStatusText(Date.now());
    return okBusy && idle.busy === false && idle.txt === '空闲';
})(), () => pipelineStatusText(Date.now()));


// ==================== F 组：v2.95.0 修复「倒计时 / 流文字展示没生效」 ====================
//
// 用户报告（原话）：「管线状态之前要求追加的倒计时、流文字展示等，都没有生效。请核对并修复。」
// 根因（本组逐条锁定）：
//   ① **摘要管线本身从未进入管线状态** —— `host/extract.js` 的三处 AI 调用直连 `rawGenerate`，
//      绕过了 v2.90.0 唯一的接入点 `core/ai-hooks.js#aiCallText`；用户真正盯着看的「批量摘要 / 单楼分析」
//      因此永远 token=0、无倒计时、无阶段、无结构摘要（← 这就是「没生效」）。
//   ② 单独一路 AI（弱化NSFW / 自动修复 / 推演 / 时钟…）时面板 `hooks.busy()` 恒为 false → 状态行写「空闲」，
//      500ms 心跳也不启动 → 读秒/倒计时/摘要没有任何出场机会。
//   ③ 非流式通道把整段响应当成「流式 1 块」上报 → 「流文字展示」是假的。
//   ④ 历史样本只在打开面板时接线 → 预估倒计时永远停在「（默认）」。

/** 造一楼正文 + 情节基线（`analyzeFloor` / `analyzeSegment` 的前置） */
function bootChat(text) {
    boot();
    setKernelState(emptyState());
    host.ctx.chat = [{ is_user: true, mes: '你好', name: 'User' }, { is_user: false, mes: String(text || '甲把铜箱搬上船，铜箱里是账册。'), name: '角色甲' }];
    setLastMessageId(1);
    try { entryIndexInit(); entryIndexBuild(true); } catch (e) { /* 忽略 */ }
}
const DELTA = () => ({ atoms: { add: [{ text: '甲把铜箱搬上船。', floorStart: 1, floorEnd: 1, characters: ['甲'] }] } });

A('F1 **单楼分析真实进入管线状态**：AI 在途时快照忙碌（标签「单楼分析」/ prompt token > 0 / 阶段与结构摘要齐备），结束即入 ETA 样本', (async () => {
    bootChat();
    let during = null;
    const r = await analyzeFloor(1, {
        ai: async (args) => {
            during = snapshot();
            return { ok: true, text: J(DELTA()) };
        },
    });
    const after = snapshot();
    const rec = (hist['单楼分析'] || []);
    return r.ok === true && !!during && during.busy === true && during.label === '单楼分析'
        && during.promptTokens > 0 && during.tokens > 0
        && during.phase === '请求 AI（第 1 楼）' && during.runs === 1
        && after.busy === false && rec.length === 1 && rec[0] >= 0;
})(), () => ({ hist: hist['单楼分析'] }));

A('F2 **批量摘要（分段）真实进入管线状态**：在途忙碌、标签「批量摘要」，结束即入样本（倒计时从此有实测依据）', (async () => {
    bootChat('甲把铜箱搬上船。');
    let during = null;
    const r = await analyzeSegment(1, 1, {
        ai: async (args) => {
            during = snapshot();
            return { ok: true, text: J(DELTA()) };
        },
    });
    return r.ok === true && !!during && during.busy === true && during.label === '批量摘要'
        && during.promptTokens > 0 && during.phase.indexOf('请求 AI（第 1-1 楼）') === 0
        && (hist['批量摘要'] || []).length === 1 && etaHasHistory('批量摘要') === true;
})(), () => ({ hist: hist['批量摘要'] }));

A('F3 结构摘要写进管线：响应到达后记录**顶层键名**（不含正文），经 `lastPipelineInfo()` 可查（只读诊断）', (async () => {
    bootChat();
    await analyzeFloor(1, {
        ai: async () => ({ ok: true, text: J({ atoms: { add: [{ text: '甲把铜箱搬上船。', floorStart: 1, floorEnd: 1 }] }, memories: { add: [] } }) }),
    });
    const li = lastPipelineInfo();
    const dumped = J(li);
    return !!li && li.label === '单楼分析' && li.ok === true && J(li.keys) === J(['atoms', 'memories'])
        && li.phase === '解析响应' && li.respChars > 0 && li.promptTokens > 0
        && dumped.indexOf('铜箱') < 0;                       // **不泄漏正文**
})(), () => lastPipelineInfo());

A('F4 「流式 N 块」**只在真的收到分块时**出现：整段响应（非流式通道）不再谎报成 1 块', (() => {
    boot();
    // ① 非流式：整段响应
    beginPipeline('单楼分析', { chars: 4000 });
    noteResponseText('x'.repeat(4000));
    const whole = snapshot();
    const wholeSuffix = pipelineSuffix();
    endPipeline(true);
    // ② 真流式：逐块回调
    beginPipeline('单楼分析', { chars: 4000 });
    addStreamChunk('a'.repeat(1000));
    addStreamChunk('b'.repeat(1000));
    const stream = snapshot();
    const streamSuffix = pipelineSuffix();
    endPipeline(true);
    return whole.chunks === 0 && wholeSuffix.indexOf('流式') < 0 && whole.respChars === 4000
        && whole.streaming === false
        && stream.chunks === 2 && stream.streamChars === 2000 && stream.streaming === true
        && streamSuffix.indexOf('流式 2 块') >= 0;
})(), () => pipelineSuffix());

A('F5 并发（独立分组）**聚合为一条读数**：多路同时跑互不覆盖，快照给出并发数与 token 合计', (() => {
    boot();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((beginPipeline('批量摘要', { chars: 1000 }) || {}).runId);
    addStreamChunk('x'.repeat(400), { id: ids[0] });
    addStreamChunk('y'.repeat(400), { id: ids[3] });
    const s = snapshot();
    const suffix = pipelineSuffix();
    const okAgg = s.busy === true && s.runs === 4 && s.label === '批量摘要'
        && s.tokens === 4 * 250 + 200 && s.chunks === 2 && suffix.indexOf('并发 4 路') >= 0;
    endPipeline(true, ids[0]); endPipeline(true, ids[1]); endPipeline(true, ids[2]); endPipeline(true, ids[3]);
    return okAgg && snapshot().busy === false;
})(), () => snapshot());

A('F6 面板状态行**不再只看批次忙位**：单路 AI（批次空闲）时也显示「正在处理：<行为>」+ token + 倒计时，并启动 500ms 心跳', (() => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}) });     // 批次**空闲**
    beginPipeline('弱化NSFW', { chars: 8000 });
    addStreamChunk('a'.repeat(2000));
    const t = pipelineStatusText(Date.now());
    const okBusy = t.busy === true && t.txt.indexOf('正在处理：弱化NSFW') >= 0
        && t.txt.indexOf('🪙') > 0 && t.txt.indexOf('预计剩') > 0 && t.txt.indexOf('⏱') > 0
        && t.txt.indexOf('流式 1 块') > 0 && t.tokens > 0;
    endPipeline(true);
    const idle = pipelineStatusText(Date.now());
    return okBusy && idle.busy === false && idle.txt === '空闲';
})(), () => pipelineStatusText(Date.now()));

A('F7 等待响应时也有一句可感知的进行态（不再空白）：无键/无 note 时显示「阶段：…」，流式中显示「接收中」', (() => {
    boot();
    beginPipeline('推演', { chars: 0 });
    const p1 = pipelineSummaryText();                       // 阶段 = 「准备」
    setPipelinePhase('等待响应');
    const p2 = pipelineSummaryText();
    addStreamChunk('x');
    setPipelinePhase('');
    const p3 = pipelineSummaryText();
    endPipeline(true);
    return p1 === '阶段：准备' && p2 === '阶段：等待响应' && p3 === '接收中' && pipelineSummaryText() === '';
})(), () => pipelineSummaryText());

A('F9 预估倒计时**随实测收敛**：首次标「（默认）」→ 跑过一轮后，同一行为的倒计时改用实测均值（不再是默认表）', (async () => {
    boot();
    beginPipeline('单楼分析', { chars: 100 });
    const first = pipelineSuffix();                       // 无历史 → （默认）
    endPipeline(true);
    // 灌入三条历史（模拟已跑过几轮）
    [8000, 9000, 10000].forEach((v) => recordPipelineRun('单楼分析', v));
    beginPipeline('单楼分析', { chars: 100 });
    const later = pipelineSuffix();
    const eta = snapshot().eta;
    endPipeline(true);
    return first.indexOf('（默认）') > 0 && later.indexOf('（默认）') < 0
        && eta === 9000 && later.indexOf('预计剩') > 0;
})(), () => ({ first: '（默认）', eta: etaMs('单楼分析'), has: etaHasHistory('单楼分析') }));

A('F8 酒馆**官方流式通道**（连接配置）：`custom.stream=true` 返回生成器 → 逐块回调增量文本；生成器为空 / 抛错自动回落一次性请求', (async () => {
    const calls = [];
    const host2 = makeHost({});
    host2.ctx.ConnectionManagerRequestService = {
        sendRequest: async (id, messages, maxOut, custom) => {
            calls.push(!!(custom && custom.stream));
            if (custom && custom.stream) {
                return () => (async function* () {
                    yield { text: '甲' };
                    yield { text: '甲把铜箱' };
                    yield { text: '甲把铜箱搬上船。' };      // **累计**文本（ST 口径）→ 必须切成增量
                })();
            }
            return { content: '甲把铜箱搬上船。' };
        },
    };
    installGlobalHost(host2, doc);
    try {
        const deltas = [];
        const r = await sendViaProfile({ profileId: 'p1', prompt: 'x', onToken: (d) => deltas.push(d) });
        // ② 生成器为空 → 回落一次性
        host2.ctx.ConnectionManagerRequestService.sendRequest = async (id, m, mx, custom) => {
            calls.push(!!(custom && custom.stream));
            if (custom && custom.stream) return () => (async function* () { /* 空 */ })();
            return { content: '回落文本' };
        };
        const r2 = await sendViaProfile({ profileId: 'p1', prompt: 'x', onToken: () => { /* 忽略 */ } });
        // ③ 流式抛错 → 回落一次性
        host2.ctx.ConnectionManagerRequestService.sendRequest = async (id, m, mx, custom) => {
            if (custom && custom.stream) throw new Error('stream unsupported');
            return { content: '错误回落' };
        };
        const r3 = await sendViaProfile({ profileId: 'p1', prompt: 'x', onToken: () => { /* 忽略 */ } });
        return r.ok === true && r.streamed === true && r.text === '甲把铜箱搬上船。'
            && J(deltas) === J(['甲', '把铜箱', '搬上船。'])
            && r2.ok === true && r2.streamed === false && r2.text === '回落文本'
            && r3.ok === true && r3.text === '错误回落'
            && calls[0] === true;
    } finally { installGlobalHost(makeHost({ chat: [] }), doc); }
})(), '');

R.done();
