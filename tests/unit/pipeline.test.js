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
} from '../../core/pipeline.js';
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

R.done();
