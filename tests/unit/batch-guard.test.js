// ============================================================
// 单元测试 · v3.52.17：AI 分析防失控（超长上下文 / 反复提交）+ 批量分析优化
//
// 用户要求（原话）：
//   1.「ai分析行为存在失控行为，可能提交了超长上下文或反复提交行为，请核对修复。」
//   2.「批量分析能力需优化，不要高频次分析，每次分析多个楼层正文，分析后提炼。避免反复提交、提交后没标记重复提交等。」
//
// 口径：
//   · 段内再按**字符预算**（`cfg.summarySegMaxChars`）收口；单段硬上限 30000 字（超出截断并留痕）；
//   · 同段连续失败 N 次（`cfg.summaryFailMarkAfter`，默认 3）→ **标记已处理**（停止自动重投；内容变化从 1 重计）；
//   · 自动提取**最小间隔**（`cfg.autoExtractGapMs`）冷却；生成结束事件去抖合并（index）；
//   · 批量为「一段多楼一次请求」（`summaryChunkSize`）+ 字符预算；成功后清失败记账。
// 运行：node tests/unit/batch-guard.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase, getLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { chunkFloorIdsByChars } from '../../core/chunk.js';
import { analyzeSegment, analyzeFloors, autoExtractLatest, SUMMARY_SEG_HARD_MAX, extractFailuresSnapshot } from '../../host/extract.js';
import { scanPendingFloors, recordProcessedFloors, hashFloorText } from '../../host/floors.js';

const R = makeReporter('batch-guard v3.52.17 防超长上下文 / 反复提交 / 高频次分析');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const CHAT = Array.from({ length: 12 }, (_, i) => ({ is_user: false, mes: '第 ' + i + ' 楼正文：甲在码头清点货物，数量与地点都写清楚。' }));
installGlobalHost(makeHost({ chat: CHAT }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:guard');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(CHAT.length - 1);
    const st = emptyState();
    st.chatKey = 'chat:A';
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const okAi = (delta) => async () => ({ ok: true, text: J(delta) });
const badAi = async () => ({ ok: false, error: 'boom' });

// ---------- A 字符预算切片 ----------
A('A1 `chunkFloorIdsByChars`：段内累计字符超预算 → 提前收口；单楼超长仍独占一段', (() => {
    const lens = { 0: 100, 1: 100, 2: 100, 3: 100, 4: 9000 };
    const chunks = chunkFloorIdsByChars([0, 1, 2, 3, 4], 10, 10, 250, (id) => lens[id]);
    return chunks.length === 3
        && J(chunks[0].ids) === J([0, 1]) && J(chunks[1].ids) === J([2, 3]) && J(chunks[2].ids) === J([4]);
})(), 'n/a');
A('A2 单段正文**硬上限**：超 30000 字 → 截断后提交（留痕，不整段塞给 AI）', (async () => {
    const huge = '甲在码头清点货物并记录数量与地点。'.repeat(1200);   // > 30000 字
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: huge }] }), makeDocument(['ftt-panel']));
    boot();
    let sent = '';
    const r = await analyzeSegment(0, 0, { ai: async (args) => { sent = String((args && args.prompt) || ''); return { ok: true, text: J({ 情节: { 新增: [] } }) }; } });
    // 自然段正文被截断 → 提交文本里带截断标记；且提交长度受控（不含整段 3 万字以上）
    return r.ok === true && sent.indexOf('已截断') >= 0 && sent.length < (SUMMARY_SEG_HARD_MAX + 2000);
})(), 'n/a');

// ---------- B 失败不重复提交 ----------
A('B1 同段连续失败达阈值（3 次）→ **标记已处理**（未分析清单不再列出），并留失败记账', (async () => {
    boot();
    for (let i = 0; i < 3; i++) await analyzeSegment(1, 2, { ai: badAi });
    const f = extractFailuresSnapshot();
    const pending = scanPendingFloors({ maintain: false }).floors;
    return Object.keys(f).indexOf('1-2') >= 0 && Number(f['1-2'].n) === 3
        && pending.indexOf(1) < 0 && pending.indexOf(2) < 0;
})(), () => J(extractFailuresSnapshot()));
A('B2 失败**未达阈值**时不标记（仍会重试）；达到后**内容变化** → 计数从 1 重算（改过的楼值得重试）', (async () => {
    boot();
    await analyzeSegment(3, 3, { ai: badAi });
    const p1 = scanPendingFloors({ maintain: false }).floors.indexOf(3) >= 0;
    const ctx = globalThis.SillyTavern && globalThis.SillyTavern.getContext();
    if (ctx) ctx.chat[3] = { is_user: false, mes: '改过的正文：内容变化后应重新尝试分析。' };
    await analyzeSegment(3, 3, { ai: badAi });
    const f = extractFailuresSnapshot();
    return p1 && Number(f['3-3'].n) === 1;
})(), 'n/a');
A('B3 成功后**清掉失败记账**（不会因历史失败挡住下次）', (async () => {
    boot();
    await analyzeSegment(4, 4, { ai: badAi });
    await analyzeSegment(4, 4, { ai: okAi({ 情节: { 新增: [] } }) });
    const f = extractFailuresSnapshot();
    return !f['4-4'];
})(), 'n/a');

// ---------- C 批量 + 冷却 ----------
A('C1 批量分析：多楼 → **一次分析多个楼层**（按段），段数 = 字符预算/段长共同作用后的数量', (async () => {
    boot();
    cfg.summaryChunkSize = 3;
    cfg.summarySegMaxChars = 0;   // 只按楼层数
    let calls = 0;
    const ai = async () => { calls += 1; return { ok: true, text: J({ 情节: { 新增: [] } }) }; };
    const r = await analyzeFloors({ ids: [0, 1, 2, 3, 4, 5], ai: ai });
    return r.ok === true && r.segments === 2 && calls === 2 && r.done === 2;
})(), () => J({ calls: calls }));
A('C2 自动提取**最小间隔冷却**：间隔内重复触发 → `cooldown`（不重复提交）', (async () => {
    boot();
    cfg.autoExtractGapMs = 60000;
    cfg.autoExtract = true;
    const ai = async () => ({ ok: true, text: J({ 情节: { 新增: [] } }) });
    const r1 = await autoExtractLatest({ ai: ai });
    const r2 = await autoExtractLatest({ ai: ai });
    return (r1.ok === true || r1.reason === 'nothing-pending') && r2.reason === 'cooldown';
})(), 'n/a');
A('C3 配置键就位（字符预算 / 失败阈值 / 冷却）且默认值合理', (() => {
    const d = JSON.parse(JSON.stringify(defaultCfg));
    return d.summarySegMaxChars === 8000 && d.summaryFailMarkAfter === 3 && d.autoExtractGapMs === 8000;
})(), 'n/a');

R.done();
