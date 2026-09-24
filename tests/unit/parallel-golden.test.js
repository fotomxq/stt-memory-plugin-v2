// ============================================================
// 单元测试 · B8-7-b 平行世界推演（weave）+ 平行事件推进（advance）+ 转正（promote）+ 清理（prune）
//   （与**真实 V1 插件 v1.206** 逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，经 `tests/unit/helpers.js#loadPlugin` 直调 `__FTT` 同名导出，
//   提示词经 `stubFetch` 拦截 `/chat/completions` 的真实请求体取得）：
//   tests/fixtures/v1-golden-parallel.json ——
//     weaveFlags：`weaveEnabled` 三态 + `weavePassiveDue` 9 组（interval 0/负数/非数字、首次、到点/未到点、floor 回退）；
//     schedule：开关关闭 / 间隔未到 / 到点自动执行 / 忙位排队重试 / 调度中二次请求被丢弃（5 例）；
//     weaveRun：默认区间、新增+更新+删除（含提示词全文）、关键词命中、无关键词列既有、空三键、非 JSON、输入签名去重、
//       force 绕过去重、忙位（9 例）；
//     advance：无目标、未知 id、全部过期被过滤、忙位、单条推进（富字段 + 越界钳制）、全部推进分批（7 条 → 2 批）、
//       AI 未返回推进数组（7 例）；
//     promote：未找到 / 内容过短 / 标题补足正文 / 正常转正 / 幂等原地更新 / 标题等于正文 / opts 覆盖 / prune 四态。
//   本 fixture 由 /tmp oracle 脚本当场生成，**连跑两次逐字节一致**（`Date.now` 固定为 meta.fixedNow）。
//
// ⚠️ 与 V1 用例顺序一致（本文件的 W→S→R→A→P 顺序**不可调整**）：V1/V2 的 `lastWeaveSig`（输入签名去重）
//   是模块级状态，去重用例依赖「前序用例已写入的签名」。
//
// 覆盖：core/parallel.js 全部导出（16 项）+ V2 编排与接线（FTT.* 入口 / 面板按钮与动作 / 确认闸门）。
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
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import {
    setParallelTextHooks, weaveEnabled, weavePassiveDue, weaveInputSig, matchParallelsByKeywords,
    scheduleParallelWeave, runParallelWeave, advanceContextSeed, buildAdvanceContext, buildAdvancePrompt,
    applyAdvanceUpdate, runParallelAdvance, promoteParallelEvent, prunePromotedParallels,
    setParallelLastKeywords, parallelLastKeywords,
} from '../../core/parallel.js';
import { panelAction, panelBodyHtml } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-parallel.json'), 'utf8'));
const NOW = G.meta.fixedNow;
const R = makeReporter('parallel-golden B8-7-b 平行推演与转正（V1 对齐）');
const clone = (v) => JSON.parse(JSON.stringify(v));
const J = (v) => JSON.stringify(v === undefined ? null : v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setScopeKey('甲');

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.stack) || e); }
    R.assert(name, cond === true, extra);
};
function deq(a, b) {
    const ja = a === undefined ? undefined : JSON.parse(JSON.stringify(a));
    const jb = b === undefined ? undefined : JSON.parse(JSON.stringify(b));
    const eq = (x, y) => {
        if (x === y) return true;
        if (x === null || y === null || x === undefined || y === undefined) return x === y;
        if (typeof x !== typeof y) return false;
        if (Array.isArray(x) !== Array.isArray(y)) return false;
        if (typeof x !== 'object') return x === y;
        if (Array.isArray(x)) return x.length === y.length && x.every((v, i) => eq(v, y[i]));
        const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
        if (kx.length !== ky.length) return false;
        return kx.every((k, i) => k === ky[i] && eq(x[k], y[k]));
    };
    return eq(ja, jb);
}
async function withFixedNow(fn) {
    const real = Date.now;
    Date.now = () => NOW;
    try { return await fn(); } finally { Date.now = real; }
}

// ---------- 桩：AI / 定时器 / 通知 / 楼层取文 ----------
let aiCalls = 0, aiContent = '', busyFlag = false, aiPrompts = [], toasts = [], timers = [];
/** 楼层行（与 V1 oracle 的 `ctx.getChatMessages` 桩逐字一致） */
function floorMock(start, end) {
    const out = [];
    for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) out.push('[第' + i + '楼 AI] 第' + i + '楼：角色甲在地点丁发现被破坏的物品戊。');
    return out;
}
function floorText(start, end) { return floorMock(start, end).join('\n').slice(0, 6000); }
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    cfg.parallelWeaveEnabled = true;
    cfg.parallelWeaveInterval = 10;
    cfg.parallelDecayEnabled = false;
    cfg.parallelDecayCutoff = 0.95;
    cfg.maxParallels = 30;
    cfg.storeMinAtoms = 0;
    setLastMessageId(3);
    const st = Object.assign(emptyState(), clone(stateLike || {}));
    st.weaveLastFloor = -1;
    // V1 oracle 的 `reset()` 固定剧情日期（转正写 promotedAt 用）
    if (!st.state || !st.state.date) st.state = { date: '1919-12-01', time: '', location: '', present: [] };
    setKernelState(st);
    // V1 的 `saveState()` 会**先跑「删除自动留痕」**（`tombstoneSweep`：消失的条目补 id + 内容哈希墓碑）——
    //   本测试用同一移植件复现（否则 V1 oracle 的 `deletedH` 无法在 V2 侧重放）。
    try { entryIndexInit(); } catch (e) { /* 忽略 */ }
    setPersistHooks({
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined });
    aiCalls = 0; aiContent = ''; busyFlag = false; aiPrompts = [];
    setAiHooks({
        callAi: async (messages) => { aiCalls++; aiPrompts.push(clone(messages)); return { ok: true, text: aiContent }; },
        feedText: () => '',
        busy: () => busyFlag,
    });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    setParallelTextHooks({ floorLinesInRange: (s, e) => floorMock(s, e) });
    return state;
}
const promptView = (p) => (p === null || p === undefined ? null : p.map(m => ({ role: m.role, content: m.content })));
const toastsView = () => clone(toasts);
const toastsExpected = (v1) => v1.map(t => [String(t.kind || ''), String(t.msg || '')]);
const dropModel = (o) => { const c = clone(o); delete c.model; return c; };
const tombs = (dim) => Object.keys(((state.deleted || {})[dim]) || {}).sort();

// ---------- 种子（与 oracle 逐字一致） ----------
const seedParallels = () => ([
    { id: 'par1', title: '黑市风声', text: '码头有人私下交易军械。', type: '阴谋', date: '1919-11-29', gua: '坎', causalLine: '甲发现木箱 → 黑市', characters: ['角色甲'], location: '码头', tags: ['黑市', '码头'], importance: 0.6, goalOdds: [{ target: '军械流入', likelihood: 60 }] },
    { id: 'par2', title: '远方的战争', text: '北方边境的冲突可能波及本地。', type: '背景', date: '1919-11-20', gua: '离', causalLine: '边境冲突 → 商路中断', characters: ['角色乙'], location: '城外', tags: ['战争'], importance: 0.5 },
]);
const seedContext = () => ({
    currentStates: [{ id: 'st1', subject: '角色甲', field: '状态', value: '警觉' }],
    snapshots: [{ id: 'sn1', name: '角色甲' }],
    memories: [{ id: 'me1', title: '码头木箱', content: '甲记得木箱断口整齐。' }],
    suspense: [{ id: 'su1', content: '木箱来源不明。' }],
    plans: [{ id: 'pl1', content: '查清木箱来源。' }],
    atoms: [{ id: 'at1', title: '发现木箱', text: '甲在码头发现一只木箱，断口整齐，来源不明。', tags: ['码头'], date: '1919-11-29', validity: 'active' }],
});
const parallelView = (p) => ({
    id: String(p.id == null ? '' : p.id), title: String(p.title == null ? '' : p.title), text: String(p.text == null ? '' : p.text),
    type: String(p.type == null ? '' : p.type), date: String(p.date == null ? '' : p.date), time: String(p.time == null ? '' : p.time),
    gua: String(p.gua == null ? '' : p.gua), causalLine: String(p.causalLine == null ? '' : p.causalLine),
    characters: p.characters || [], location: String(p.location == null ? '' : p.location), tags: p.tags || [],
    importance: Number(p.importance) || 0, uses: Number(p.uses) || 0,
    goalOdds: (p.goalOdds || []).map(g => ({ target: String(g && g.target == null ? '' : g.target), likelihood: Number(g && g.likelihood) || 0 })),
    promotedTo: p.promotedTo === undefined ? '' : String(p.promotedTo),
    promotedAt: p.promotedAt === undefined ? '' : String(p.promotedAt),
    updatedAt: Number(p.updatedAt) || 0,
});
const parallelsView = () => (state.parallels || []).map(parallelView);
const atomsView = () => (state.atoms || []).map(a => ({
    id: String(a.id == null ? '' : a.id), title: String(a.title == null ? '' : a.title), text: String(a.text == null ? '' : a.text),
    type: String(a.type == null ? '' : a.type), date: String(a.date == null ? '' : a.date), time: String(a.time == null ? '' : a.time),
    entities: a.entities || [], locations: a.locations || [], tags: a.tags || [],
    importance: Number(a.importance) || 0, validity: String(a.validity == null ? '' : a.validity),
    floorStart: Number(a.floorStart) || 0, floorEnd: Number(a.floorEnd) || 0, uses: Number(a.uses) || 0,
}));

// ============================================================
// W 组：开关与间隔判定
// ============================================================
await A('W1 weaveEnabled：true / false / 键缺失 三态与 V1 一致（缺省即开启）', async () => {
    boot();
    const mine = {};
    for (const v of [true, false, undefined]) {
        if (v === undefined) delete cfg.parallelWeaveEnabled; else cfg.parallelWeaveEnabled = v;
        mine[String(v)] = weaveEnabled();
    }
    return deq(mine, G.weaveFlags.enabled);
}, '');

await A('W2 weavePassiveDue：interval 0/负数/非数字、首次触发、到点与未到点、floor 回退，9 组与 V1 逐值一致', async () => {
    boot();
    const mine = [];
    for (const q of [
        { interval: 10, last: -1, end: 3 }, { interval: 10, last: 0, end: 3 }, { interval: 10, last: 0, end: 10 },
        { interval: 10, last: 20, end: 5 }, { interval: 0, last: 50, end: 1 }, { interval: -3, last: 50, end: 1 },
        { interval: 5, last: 10, end: 15 }, { interval: 5, last: 10, end: 14 }, { interval: 'x', last: 1, end: 2 },
    ]) {
        cfg.parallelWeaveInterval = q.interval;
        state.weaveLastFloor = q.last;
        mine.push({ interval: q.interval, last: q.last, end: q.end, due: weavePassiveDue(q.end) });
    }
    return deq(mine, G.weaveFlags.passiveDue);
}, '');

// ============================================================
// S 组：scheduleParallelWeave（用注入定时器驱动，等价 V1 的真实 1.8s / 2.5s）
// ============================================================
await A('S1 scheduleParallelWeave：开关关闭 → 直接返回（零 AI、零 pending）；间隔未到 → 跳过且不建定时器，与 V1 一致', async () => {
    boot();
    aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '不该出现', 正文: '开关关闭时不应推演。', 标签: ['x'] }] } });
    cfg.parallelWeaveEnabled = false;
    const ret0 = scheduleParallelWeave({ start: 0, end: 3 }, ['码头']);
    const mine0 = { calls: aiCalls, timers: timers.length, lastFloor: Number(state.weaveLastFloor), parallels: (state.parallels || []).length, toasts: toastsView() };
    const okDisabled = deq(mine0, { calls: G.schedule.disabled.calls, timers: 0, lastFloor: G.schedule.disabled.lastFloor, parallels: G.schedule.disabled.parallels, toasts: toastsExpected(G.schedule.disabled.toasts) }) && ret0 === undefined;
    boot();
    cfg.parallelWeaveInterval = 10;
    state.weaveLastFloor = 10;
    const ret1 = scheduleParallelWeave({ start: 0, end: 15 }, []);
    const mine1 = { calls: aiCalls, timers: timers.length, lastFloor: Number(state.weaveLastFloor), parallels: (state.parallels || []).length, toasts: toastsView() };
    const okNotDue = deq(mine1, { calls: G.schedule.notDue.calls, timers: 0, lastFloor: G.schedule.notDue.lastFloor, parallels: G.schedule.notDue.parallels, toasts: toastsExpected(G.schedule.notDue.toasts) }) && ret1 === undefined;
    return okDisabled && okNotDue;
}, '');

await A('S2 scheduleParallelWeave：到点 → 定时器 1800ms 后自动执行（写 weaveLastFloor、落库、前后通知），与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        cfg.parallelWeaveInterval = 10;
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '调度新增', 正文: '调度推演出的潜在事件线。', 标签: ['调度'] }] } });
        const ret = scheduleParallelWeave({ start: 0, end: 4 }, ['码头']);
        const delay = timers.length === 1 ? timers[0].ms : -1;
        await timers[0].fn();
        const mine = { ret: ret === undefined ? null : ret, delay: delay, calls: aiCalls, lastFloor: Number(state.weaveLastFloor), parallels: parallelsView(), toasts: toastsView() };
        const exp = Object.assign({}, clone(G.schedule.due), { delay: 1800, parallels: G.schedule.due.parallels });
        exp.toasts = toastsExpected(G.schedule.due.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('S3 scheduleParallelWeave：忙位时排队重试（首次返回 busy → 2500ms 后再试），释放后成功，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        cfg.parallelWeaveInterval = 10;
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '忙后新增', 正文: '长任务释放后被动推演出的潜在事件线。', 标签: ['忙后'] }] } });
        busyFlag = true;
        scheduleParallelWeave({ start: 0, end: 5 }, []);
        await timers[0].fn();
        const mid = { calls: aiCalls, parallels: (state.parallels || []).length };
        const retryDelay = timers.length >= 2 ? timers[1].ms : -1;
        busyFlag = false;
        await timers[1].fn();
        const mine = { mid: mid, retryDelay: retryDelay, calls: aiCalls, lastFloor: Number(state.weaveLastFloor), parallels: parallelsView(), toasts: toastsView() };
        const exp = Object.assign({}, clone(G.schedule.busyRequeue), { retryDelay: 2500 });
        exp.toasts = toastsExpected(G.schedule.busyRequeue.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('S4 scheduleParallelWeave：调度中二次请求被丢弃（不排队、不替换），仅先到者执行 —— V1 怪癖原样', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        cfg.parallelWeaveInterval = 10;
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '先到请求', 正文: '第二次调度被丢弃，先到的请求生效。', 标签: ['先到'] }] } });
        scheduleParallelWeave({ start: 0, end: 3 }, ['码头']);
        scheduleParallelWeave({ start: 10, end: 12 }, ['战争']);
        const timerCount = timers.length;
        await timers[0].fn();
        const mine = { timerCount: timerCount, calls: aiCalls, lastFloor: Number(state.weaveLastFloor), parallels: parallelsView(), toasts: toastsView() };
        const exp = Object.assign({}, clone(G.schedule.double), { timerCount: 1 });
        exp.toasts = toastsExpected(G.schedule.double.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

// ============================================================
// R 组：runParallelWeave 直调
// ============================================================
await A('R1 runParallelWeave 默认区间：空入参 → start=0 / end=start+summaryFloors（30）· 空三键 skipped=empty，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        aiContent = JSON.stringify({ 平行事件: {} });
        const res = await runParallelWeave({}, {});
        const mine = {
            res: res, calls: aiCalls, lastFloor: Number(state.weaveLastFloor),
            floors: floorText(0, Number(cfg.summaryFloors) || 10), toasts: toastsView(),
        };
        const exp = Object.assign({}, clone(G.weaveRun.defaultRange));
        exp.toasts = toastsExpected(G.weaveRun.defaultRange.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('R2 runParallelWeave 成功：新增 1 / 更新 1 / 删除 1（提示词 system+user 全文逐字符、落库结果与通知与 V1 一致）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot(Object.assign({ parallels: seedParallels() }, seedContext()));
        aiContent = JSON.stringify({
            平行事件: {
                新增: [{ 标题: '黑市军械', 正文: '码头黑市可能流入一批军械，牵动本地势力。', 卦象: '坎', 因果线: '木箱断口 → 黑市军械', 类型: '阴谋', 日期: '1919-11-30', 时间: '夜', 涉及角色: ['角色甲'], 发生地点: '码头', 标签: ['黑市', '军械'], 演化目标可能性: [{ 目标: '军械流入', 可能性: 70 }, { 目标: '官府查抄', 可能性: 30 }] }],
                更新: [{ 标题: '远方的战争', 正文: '北方边境冲突升级，商路已断，本地粮价将涨。', 因果线: '边境冲突 → 商路中断 → 粮价上涨', 演化目标可能性: [{ 目标: '粮价上涨', 可能性: 80 }] }],
                删除: ['par1'],
            },
        });
        const res = await runParallelWeave({ start: 0, end: 3 }, { keywords: ['码头', '木箱'] });
        const mine = {
            res: res, calls: aiCalls, prompt: promptView(aiPrompts[0]),
            parallels: parallelsView(), afterCount: (state.parallels || []).length, lastFloor: Number(state.weaveLastFloor), toasts: toastsView(),
        };
        const exp = Object.assign({}, dropModel(G.weaveRun.success));
        exp.toasts = toastsExpected(G.weaveRun.success.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('R3 runParallelWeave 关键词命中：上下文改为「关键词命中待更新」并列出命中条目（提示词全文比对）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 平行事件: {} });
        const res = await runParallelWeave({ start: 1, end: 2 }, { keywords: ['战争'], force: true });
        const mine = { res: res, calls: aiCalls, prompt: promptView(aiPrompts[0]), toasts: toastsView() };
        const exp = clone(G.weaveRun.keywordsMatched);
        exp.toasts = toastsExpected(G.weaveRun.keywordsMatched.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('R4 runParallelWeave 无关键词：退化为列出既有平行事件（提示词全文比对）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 平行事件: {} });
        const res = await runParallelWeave({ start: 2, end: 3 }, { force: true });
        const mine = { res: res, calls: aiCalls, prompt: promptView(aiPrompts[0]), toasts: toastsView() };
        const exp = clone(G.weaveRun.noKeywords);
        exp.toasts = toastsExpected(G.weaveRun.noKeywords.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('R5 runParallelWeave 空三键 / AI 非 JSON：分别 skipped=empty 与 error=AI 未返回有效 JSON，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 平行事件: { 新增: [], 更新: [], 删除: [] } });
        const resE = await runParallelWeave({ start: 3, end: 4 }, { force: true });
        const mineE = { res: resE, calls: aiCalls, parallels: (state.parallels || []).length, toasts: toastsView() };
        const expE = clone(G.weaveRun.empty); expE.toasts = toastsExpected(G.weaveRun.empty.toasts);
        ok = deq(mineE, expE);
        boot({ parallels: seedParallels() });
        aiContent = '这不是 JSON 的推演结论。';
        const resF = await runParallelWeave({ start: 4, end: 5 }, { force: true });
        const mineF = { res: resF, calls: aiCalls, parallels: (state.parallels || []).length, toasts: toastsView() };
        const expF = clone(G.weaveRun.invalidJson); expF.toasts = toastsExpected(G.weaveRun.invalidJson.toasts);
        ok = ok && deq(mineF, expF);
    });
    return ok;
}, '');

await A('R6 runParallelWeave 输入签名去重：同楼层正文+同原子第二次 skipped=dedup（零 AI）；force 绕过去重', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '去重条', 正文: '同一正文与原子不被重复分析。', 标签: ['去重'] }] } });
        const first = await runParallelWeave({ start: 5, end: 6 }, {});
        const callsAfterFirst = aiCalls;
        const second = await runParallelWeave({ start: 5, end: 6 }, {});
        const mine = { first: first, second: second, callsFirst: callsAfterFirst, callsTotal: aiCalls, parallels: (state.parallels || []).length, toasts: toastsView() };
        const exp = clone(G.weaveRun.dedup); exp.toasts = toastsExpected(G.weaveRun.dedup.toasts);
        ok = deq(mine, exp);
        const forced = await runParallelWeave({ start: 5, end: 6 }, { force: true });
        const mine2 = { res: forced, calls: aiCalls, parallels: (state.parallels || []).length, toasts: toastsView() };
        const exp2 = clone(G.weaveRun.forceAfterDedup); exp2.toasts = toastsExpected(G.weaveRun.forceAfterDedup.toasts);
        ok = ok && deq(mine2, exp2);
    });
    return ok;
}, '');

await A('R7 runParallelWeave 忙位：管线占用 → {ok:false, error:"busy"} 且零 AI 调用，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '忙位条', 正文: '忙位时不应发起 AI 调用。', 标签: ['忙'] }] } });
        busyFlag = true;
        const res = await runParallelWeave({ start: 6, end: 7 }, {});
        busyFlag = false;
        const mine = { res: res, calls: aiCalls, parallels: (state.parallels || []).length, toasts: toastsView() };
        const exp = clone(G.weaveRun.busy); exp.toasts = toastsExpected(G.weaveRun.busy.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

// ============================================================
// A 组：runParallelAdvance
// ============================================================
await A('A1 runParallelAdvance 早退：无目标 / 未知 id / 全部已达衰退阈值 / 忙位 四态与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        const r1 = await runParallelAdvance({});
        const mine1 = { res: r1, calls: aiCalls, toasts: toastsView() };
        const exp1 = clone(G.advance.noTargets); exp1.toasts = toastsExpected(G.advance.noTargets.toasts);
        ok = deq(mine1, exp1);
        boot({ parallels: seedParallels() });
        const r2 = await runParallelAdvance({ ids: ['nope'] });
        const mine2 = { res: r2, calls: aiCalls, toasts: toastsView() };
        const exp2 = clone(G.advance.unknownId); exp2.toasts = toastsExpected(G.advance.unknownId.toasts);
        ok = ok && deq(mine2, exp2);
        boot({ parallels: seedParallels() });
        cfg.parallelDecayEnabled = true;
        cfg.parallelDecayCutoff = 0.0;
        const r3 = await runParallelAdvance({ all: true });
        const mine3 = { res: r3, calls: aiCalls, toasts: toastsView() };
        const exp3 = clone(G.advance.expiredFiltered); exp3.toasts = toastsExpected(G.advance.expiredFiltered.toasts);
        ok = ok && deq(mine3, exp3) && r3.skipped === 'none-active';
        cfg.parallelDecayEnabled = false; cfg.parallelDecayCutoff = 0.95;
        boot({ parallels: seedParallels() });
        busyFlag = true;
        const r4 = await runParallelAdvance({ all: true });
        busyFlag = false;
        const mine4 = { res: r4, calls: aiCalls, toasts: toastsView() };
        const exp4 = clone(G.advance.busy); exp4.toasts = toastsExpected(G.advance.busy.toasts);
        ok = ok && deq(mine4, exp4) && r4.ok === true && r4.skipped === 'busy';
    });
    return ok;
}, '');

await A('A2 runParallelAdvance 单条推进：富字段应用（类型/日期/时间/卦象/因果线/角色/地点/标签/目标可能性 + 越界钳制）与 V1 逐字段一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot(Object.assign({ parallels: seedParallels() }, seedContext()));
        aiContent = JSON.stringify({
            推进: [{
                id: 'par2', 标题: '远方的战争（升级）', 正文: '边境战事扩大，商队改道，本地粮价随之上涨，城中开始囤粮。',
                类型: '背景', 日期: '1919-12-05', 时间: '傍晚', 卦象: '震', 因果线: '边境冲突 → 商路中断 → 粮价上涨',
                涉及角色: ['角色乙', '角色丙'], 发生地点: '城内', 标签: ['战争', '粮价', '囤积'],
                演化目标可能性: [{ 目标: '粮价上涨', 可能性: 130 }, { 目标: '商路重开', 可能性: -20 }, { 目标: '（空目标）', 可能性: 'abc' }],
                importance: '0.9',
            }],
        });
        const res = await runParallelAdvance({ ids: ['par2'] });
        const mine = { res: res, calls: aiCalls, prompt: promptView(aiPrompts[0]), parallels: parallelsView(), toasts: toastsView() };
        const exp = Object.assign({}, dropModel(G.advance.single));
        exp.toasts = toastsExpected(G.advance.single.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('A3 runParallelAdvance 全部推进分批：7→8 条按 ADVANCE_CHUNK=6 分 2 批（2 次 AI、两批提示词全文），与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({
            parallels: seedParallels().concat([
                { id: 'par3', title: '丙的计划', text: '丙在暗中联络旧部。', type: '阴谋', tags: ['丙'] },
                { id: 'par4', title: '丁的商队', text: '丁的商队延后出发。', type: '背景', tags: ['丁'] },
                { id: 'par5', title: '戊的调查', text: '戊开始调查木箱来源。', type: '调查', tags: ['戊'] },
                { id: 'par6', title: '己的婚约', text: '己的婚约出现变数。', type: '情感', tags: ['己'] },
                { id: 'par7', title: '庚的告密', text: '庚向官府告密。', type: '阴谋', tags: ['庚'] },
                { id: 'par8', title: '辛的账本', text: '辛的账本不见了。', type: '悬念', tags: ['辛'] },
            ]),
        });
        aiContent = JSON.stringify({ 推进: [{ id: 'par2', 正文: '第一批推进结果。' }] });
        const res = await runParallelAdvance({ all: true });
        const mine = { res: res, calls: aiCalls, prompts: clone(aiPrompts), parallels: parallelsView(), toasts: toastsView() };
        const exp = clone(G.advance.chunked);
        exp.toasts = toastsExpected(G.advance.chunked.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('A4 runParallelAdvance：AI 未返回「推进」数组 → 保留原条目、updated=0，仅告警（与 V1 一致）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 别的键: [] });
        const res = await runParallelAdvance({ all: true });
        const mine = { res: res, calls: aiCalls, parallels: parallelsView(), toasts: toastsView() };
        const exp = clone(G.advance.invalidArray); exp.toasts = toastsExpected(G.advance.invalidArray.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

// ============================================================
// P 组：promoteParallelEvent / prunePromotedParallels
// ============================================================
await A('P1 promoteParallelEvent 失败态：未找到 / 内容过短（标题补足后仍 <8 字）与 V1 逐字一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        const r1 = promoteParallelEvent('nope');
        const mine1 = { res: r1, parallels: (state.parallels || []).length, atoms: (state.atoms || []).length, toasts: toastsView() };
        const exp1 = clone(G.promote.notFound); exp1.toasts = toastsExpected(G.promote.notFound.toasts);
        ok = deq(mine1, exp1);
        boot({ parallels: [{ id: 'p-short', title: '短', text: '很短' }] });
        const r2 = promoteParallelEvent('p-short');
        const mine2 = { res: r2, parallels: (state.parallels || []).length, atoms: (state.atoms || []).length, toasts: toastsView() };
        const exp2 = clone(G.promote.tooShort); exp2.toasts = toastsExpected(G.promote.tooShort.toasts);
        ok = ok && deq(mine2, exp2);
    });
    return ok;
}, '');

await A('P2 promoteParallelEvent 标题补足：text <8 字 → 用「标题：正文」补足后落库（tags 截断 5、type 兜底「转折」）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: [{ id: 'p-pad', title: '很长的平行标题', text: '很短', type: '转折', tags: ['甲'] }] });
        const res = promoteParallelEvent('p-pad');
        const mine = {
            res: res, atoms: atomsView(), parallels: parallelsView(), tombs: tombs('parallels'),
            tombsH: Object.keys(((state.deletedH || {}).parallels) || {}).length, toasts: toastsView(),
        };
        const exp = clone(G.promote.titlePad); exp.toasts = toastsExpected(G.promote.titlePad.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('P3 promoteParallelEvent 正常转正：生成情节（entities/locations/tags/importance/type/date）+ 自动移除平行记录并留 id 墓碑', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot(Object.assign({ parallels: seedParallels() }, seedContext()));
        const res = promoteParallelEvent('par1');
        const mine = {
            res: res, atoms: atomsView(), parallels: parallelsView(),
            tombs: tombs('parallels'), tombsH: Object.keys(((state.deletedH || {}).parallels) || {}).length,
            atomCount: (state.atoms || []).length, toasts: toastsView(),
        };
        const exp = clone(G.promote.success); exp.toasts = toastsExpected(G.promote.success.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('P4 promoteParallelEvent 幂等：`promotedTo` 指向既有情节 → 原地更新（updated:true，保留原 id/日期）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot(Object.assign({ parallels: seedParallels().concat([{ id: 'par9', title: '已转正', text: '这条已经转正过一次。', promotedTo: 'at_old', type: '转折' }]) }, seedContext()));
        state.atoms = (state.atoms || []).concat([{ id: 'at_old', title: '旧情节', text: '旧情节正文（足够长）。', date: '1919-11-01', tags: ['旧'], validity: 'active' }]);
        const res = promoteParallelEvent('par9');
        const mine = { res: res, atoms: atomsView(), parallels: parallelsView(), tombs: tombs('parallels'), toasts: toastsView() };
        const exp = clone(G.promote.idempotent); exp.toasts = toastsExpected(G.promote.idempotent.toasts);
        ok = deq(mine, exp);
    });
    return ok;
}, '');

await A('P5 promoteParallelEvent 标题===正文 / opts 覆盖：标题不重复进正文；opts.text 与 opts.at 生效', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: [{ id: 'p-same', title: '同标题同正文的内容足够长', text: '同标题同正文的内容足够长' }] });
        const r1 = promoteParallelEvent('p-same');
        const mine1 = { res: r1, atoms: atomsView(), parallels: parallelsView(), tombs: tombs('parallels') };
        ok = deq(mine1, clone(G.promote.titleEqualsText));
        boot({ parallels: [{ id: 'p-opts', title: '带参', text: '原始正文足够长。', type: '阴谋' }] });
        const r2 = promoteParallelEvent('p-opts', { text: '由调用方指定的转正正文内容。', at: '1920-01-01' });
        const mine2 = { res: r2, atoms: atomsView(), parallels: parallelsView() };
        ok = ok && deq(mine2, clone(G.promote.opts));
    });
    return ok;
}, '');

await A('P6 prunePromotedParallels：情节仍在的移除 / 情节已丢的保留 / `promotedTo="情节"` 占位移除，与 V1 一致', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({
            parallels: [
                { id: 'pr-a', title: 'A', text: '情节仍在。', promotedTo: 'at_keep' },
                { id: 'pr-b', title: 'B', text: '情节已删。', promotedTo: 'at_gone' },
                { id: 'pr-c', title: 'C', text: '占位转正。', promotedTo: '情节' },
                { id: 'pr-d', title: 'D', text: '未转正。' },
            ],
            atoms: [{ id: 'at_keep', title: 'K', text: '仍存在的情节正文。', validity: 'active' }],
        });
        const res = prunePromotedParallels();
        const mine = { res: res, parallels: parallelsView(), tombs: tombs('parallels'), toasts: toastsView() };
        const exp = clone(G.promote.prune); exp.toasts = toastsExpected(G.promote.prune.toasts);
        ok = deq(mine, exp) && res.removed === 2 && res.kept === 1;
    });
    return ok;
}, '');

await A('P7 机械助手与 V1 同源行为：weaveInputSig 稳定（同入参同签名、原子变化则变）/ advanceContextSeed 命中种子', async () => {
    boot(Object.assign({ parallels: seedParallels() }, seedContext()));
    const s1 = weaveInputSig(0, 3, '正文');
    const s2 = weaveInputSig(0, 3, '正文');
    state.atoms.push({ id: 'at2', title: '', text: '新增一条情节', validity: 'active' });
    const s3 = weaveInputSig(0, 3, '正文');
    const sigOk = !!s1 && s1 === s2 && s1 !== s3;
    const seed = advanceContextSeed(state.parallels[0]);
    const seedNone = advanceContextSeed({ id: 'x', title: '无', text: '无', tags: [], characters: [] });
    const match = matchParallelsByKeywords(['战争']);
    return sigOk && seed.length > 0 && seedNone.length === 0 && match.length === 1 && String(match[0].id) === 'par2';
}, '');

await A('P8 buildAdvanceContext / buildAdvancePrompt 直接调用：背景（最近正文 + 速览）与提示词逐字符等于 V1 oracle 捕获值', async () => {
    boot(Object.assign({ parallels: seedParallels() }, seedContext()));
    const targets = [state.parallels[1]];
    const mem = buildAdvanceContext(targets);
    const p = buildAdvancePrompt(targets, mem);
    return deq({ prompt: promptView(p) }, { prompt: G.advance.single.prompt });
}, '');

await A('P9 applyAdvanceUpdate 直调：只给正文/只给标题/空结果/中英字段别名/概率夹取与 0 兜底', async () => {
    boot();
    const p1 = { id: 'x1', title: 'T', text: '旧正文' };
    const okText = applyAdvanceUpdate(p1, { 正文: '新的推进正文内容。' }) === true && p1.text === '新的推进正文内容。' && p1.title === 'T';
    const p2 = { id: 'x2', title: '旧', text: '旧正文' };
    const okTitle = applyAdvanceUpdate(p2, { 标题: '新标题' }) === true && p2.title === '新标题' && p2.text === '旧正文';
    const p3 = { id: 'x3', title: 'T', text: 'T' };
    const okEmpty = applyAdvanceUpdate(p3, {}) === false;
    const p4 = { id: 'x4' };
    const okAlias = applyAdvanceUpdate(p4, { title: '英文标题', content: '英文正文内容。', gua: '乾', causalLine: '因果', characters: ['甲'], location: '城', tags: ['t'], goalOdds: [{ target: '目标A', likelihood: 42 }], importance: 2 }) === true
        && p4.title === '英文标题' && p4.gua === '乾' && p4.characters[0] === '甲' && p4.tags[0] === 't'
        && p4.goalOdds.length === 1 && p4.goalOdds[0].likelihood === 42 && p4.importance === 1;
    const p5 = { id: 'x5' };
    const okClamp = applyAdvanceUpdate(p5, { 正文: '钳制测试正文。', 演化目标可能性: [{ 目标: 'a', 可能性: 999 }, { 目标: 'b', 可能性: -3 }, { 可能性: 5 }, null] }) === true
        && p5.goalOdds.length === 2 && p5.goalOdds[0].likelihood === 100 && p5.goalOdds[1].likelihood === 0;
    return okText && okTitle && okEmpty && okAlias && okClamp;
}, '');

await A('P10 最近关键词载体：setParallelLastKeywords / parallelLastKeywords（最多 10 个、副本语义、非法入参回落空数组）', async () => {
    boot();
    setParallelLastKeywords(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    const ten = parallelLastKeywords();
    const tenLen = ten.length, tenLast = ten[9];
    ten.push('污染');
    const after = parallelLastKeywords();
    setParallelLastKeywords('不是数组');
    const bad = parallelLastKeywords();
    setParallelLastKeywords([]);
    return tenLen === 10 && tenLast === 'j' && after.length === 10 && after.indexOf('污染') < 0 && bad.length === 0;
}, '');

// ============================================================
// U 组：V2 编排 / 接线
// ============================================================
await A('U1 FTT.* 入口齐备（16 项）且无 hook 时按约定降级不抛错（devtools 侧 typeof 守卫）', async () => {
    boot(Object.assign({ parallels: seedParallels() }, seedContext()));
    installDevtools({
        weaveEnabled: () => weaveEnabled(),
        weavePassiveDue: (f) => weavePassiveDue(f),
        weaveInputSig: (s, e, t) => weaveInputSig(s, e, t),
        matchParallelsByKeywords: (k) => matchParallelsByKeywords(k),
        scheduleParallelWeave: (fr, kw) => scheduleParallelWeave(fr, kw),
        runParallelWeave: (fr, o) => runParallelWeave(fr, o || {}),
        advanceContextSeed: (p) => advanceContextSeed(p),
        buildAdvanceContext: (t) => buildAdvanceContext(t),
        buildAdvancePrompt: (t, m) => buildAdvancePrompt(t, m),
        applyAdvanceUpdate: (p, u) => applyAdvanceUpdate(p, u),
        runParallelAdvance: (o) => runParallelAdvance(o || {}),
        promoteParallelEvent: (id, o) => promoteParallelEvent(id, o || {}),
        prunePromotedParallels: () => prunePromotedParallels(),
        setParallelLastKeywords: (l) => setParallelLastKeywords(l),
        parallelLastKeywords: () => parallelLastKeywords(),
    });
    const F = globalThis.FTT;
    const names = ['weaveEnabled', 'weavePassiveDue', 'weaveInputSig', 'matchParallelsByKeywords', 'scheduleParallelWeave',
        'runParallelWeave', 'advanceContextSeed', 'buildAdvanceContext', 'buildAdvancePrompt', 'applyAdvanceUpdate',
        'runParallelAdvance', 'promoteParallelEvent', 'prunePromotedParallels', 'setParallelLastKeywords', 'parallelLastKeywords'];
    const missing = names.filter(n => typeof F[n] !== 'function');
    const enabled = F.weaveEnabled() === true;
    const match = F.matchParallelsByKeywords(['战争']).length;
    const seed = F.advanceContextSeed(state.parallels[0]).length;
    const pr = F.prunePromotedParallels();
    uninstallDevtools();
    const gone = globalThis.FTT === undefined;
    // 无 hook：全部走约定降级（不抛错）
    installDevtools({});
    const F2 = globalThis.FTT;
    const noHook = F2.weaveEnabled() === false && F2.weavePassiveDue(5) === true && F2.weaveInputSig(0, 1, '') === ''
        && F2.matchParallelsByKeywords(['x']).length === 0 && F2.scheduleParallelWeave({}, []) === null
        && F2.applyAdvanceUpdate({}, {}) === false && (await F2.runParallelWeave({}, {})).error === 'no-hook'
        && (await F2.runParallelAdvance({})).error === 'no-hook' && F2.promoteParallelEvent('x').reason === 'no-hook'
        && F2.prunePromotedParallels().removed === 0 && F2.parallelLastKeywords().length === 0;
    uninstallDevtools();
    return missing.length === 0 && enabled && match === 1 && seed > 0 && pr.removed === 0 && gone && noHook;
}, '');

await A('U2 总览「🧭 推演世界」按钮：位于「📤 提取记忆」右侧，文案 / title / id 与 V1 逐字一致', async () => {
    boot();
    const h = String(panelBodyHtml('overview') || '');
    const a = h.indexOf('data-ftt-action="extractNow"');
    const b = h.indexOf('data-ftt-action="parallelWeaveNow"');
    return a >= 0 && b > a && h.indexOf('id="ftt-weave-btn"') >= 0 && h.indexOf('>🧭 推演世界</button>') >= 0
        && h.indexOf('title="手动触发平行事件推演（独立交织管线）"') >= 0;
}, '');

await A('U3 平行页「🚀 全部推进」顶栏 + 行内「🚀 推进 / ⬆ 转正」：文案 / title / 显隐条件与 V1 一致（过期不显示推进、已转正不显示转正）', async () => {
    boot({ parallels: seedParallels() });
    const h = String(panelBodyHtml('parallels') || '');
    const topOk = h.indexOf('data-ftt-action="parallelAdvanceAll"') >= 0
        && h.indexOf('title="全部平行事件交 AI 逐一推进"') >= 0 && h.indexOf('🚀 全部推进') >= 0
        && h.indexOf('记忆数据随推进一并交给 AI 作背景与种子；事件可能只是世界背景/间接相关，不会强行牵引到主角。') >= 0;
    const rowOk = h.indexOf('data-ftt-action="parallelAdvance" data-id="par1"') >= 0
        && h.indexOf('title="推进该事件（附带记忆数据作种子）"') >= 0
        && h.indexOf('data-ftt-action="promoteParallel" data-id="par1"') >= 0
        && h.indexOf('title="转正为情节（需确认）"') >= 0
        && h.indexOf('⬆ 转正为情节') >= 0 && h.indexOf('仅幕后（角色不知情）') >= 0;
    // 已转正 → 无 ⬆ 按钮 + 备注「 · 已转正为情节」
    state.parallels[0].promotedTo = 'atom_x';
    const h2 = String(panelBodyHtml('parallels') || '');
    const promotedOk = h2.indexOf('data-ftt-action="promoteParallel" data-id="par1"') < 0
        && h2.indexOf(' · 已转正为情节') >= 0 && h2.indexOf('data-ftt-action="promoteParallel" data-id="par2"') >= 0;
    // 达衰退阈值 → 不显示 🚀
    state.parallels[0].promotedTo = '';
    cfg.parallelDecayEnabled = true;
    cfg.parallelDecayCutoff = 0.0;
    const h3 = String(panelBodyHtml('parallels') || '');
    const expiredOk = h3.indexOf('data-ftt-action="parallelAdvance" data-id="par1"') < 0;
    cfg.parallelDecayEnabled = false; cfg.parallelDecayCutoff = 0.95;
    return topOk && rowOk && promotedOk && expiredOk;
}, '');

await A('U4 面板动作 parallelWeaveNow：开关未开 → 逐字提示；开启 → AI 桩推演落库并写 r.state.note（读 state.note）', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot();
        cfg.parallelWeaveEnabled = false;
        const r0 = await panelAction('parallelWeaveNow', {});
        const note0 = String((r0.state || {}).note || '');
        const offOk = r0.reason === 'disabled' && note0 === '🧭 推演世界未开启（设置→提取记忆→推演世界）';
        boot();
        cfg.parallelWeaveEnabled = true;
        setParallelLastKeywords(['码头']);
        aiContent = JSON.stringify({ 平行事件: { 新增: [{ 标题: '面板推演', 正文: '面板按钮触发的推演结果。', 标签: ['面板'] }] } });
        const r1 = await panelAction('parallelWeaveNow', {});
        const note1 = String((r1.state || {}).note || '');
        const okRun = r1.ok === true && aiCalls === 1 && (state.parallels || []).length === 1
            && note1.indexOf('推演世界完成：新增 1 / 更新 0') >= 0 && aiPrompts.length === 1
            && JSON.stringify(aiPrompts[0]).indexOf('码头') >= 0;
        // 忙位提示
        boot();
        cfg.parallelWeaveEnabled = true;
        busyFlag = true;
        const r2 = await panelAction('parallelWeaveNow', {});
        busyFlag = false;
        const note2 = String((r2.state || {}).note || '');
        const busyOk = note2 === '⏳ 摘要/情节总结/推演/推进/修复进行中，请稍候';
        setParallelLastKeywords([]);
        ok = offOk && okRun && busyOk;
    });
    return ok;
}, '');

await A('U5 面板动作 parallelAdvance / parallelAdvanceAll：单条与全部推进分支（含 busy / none-active 提示）如实写 r.state.note', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 推进: [{ id: 'par1', 正文: '面板单条推进后的新阶段正文。' }] });
        const r1 = await panelAction('parallelAdvance', { id: 'par1' });
        const note1 = String((r1.state || {}).note || '');
        const ok1 = aiCalls === 1 && (state.parallels || []).find(p => p.id === 'par1').text === '面板单条推进后的新阶段正文。'
            && note1 === '🚀 平行事件推进完成：更新 1/1 条 · AI 调用 1 次 · 发送 ' + String(r1.parallelAdvance.sentChars) + ' 字 · 用时 0ms';
        // 全部推进（AI 未返回推进数组 → updated 0）
        boot({ parallels: seedParallels() });
        aiContent = JSON.stringify({ 推进: [] });
        const r2 = await panelAction('parallelAdvanceAll', {});
        const note2 = String((r2.state || {}).note || '');
        const ok2 = r2.ok === true && note2.indexOf('🚀 平行事件推进完成：更新 0/2 条') >= 0;
        // 忙位
        boot({ parallels: seedParallels() });
        busyFlag = true;
        const r3 = await panelAction('parallelAdvanceAll', {});
        busyFlag = false;
        const note3 = String((r3.state || {}).note || '');
        const ok3 = note3 === '⏳ 摘要/情节总结/推演/修复进行中，请稍候再推进';
        // 全部过期
        boot({ parallels: seedParallels() });
        cfg.parallelDecayEnabled = true;
        cfg.parallelDecayCutoff = 0.0;
        const r4 = await panelAction('parallelAdvanceAll', {});
        const note4 = String((r4.state || {}).note || '');
        const ok4 = note4 === '⏳ 当前无活动平行事件可推进';
        cfg.parallelDecayEnabled = false; cfg.parallelDecayCutoff = 0.95;
        ok = ok1 && ok2 && ok3 && ok4;
    });
    return ok;
}, '');

await A('U6 面板动作 promoteParallel：确认闸门（无对话框环境 → 取消，V1 同口径）；关闭确认 → 转正生成情节并移除平行记录', async () => {
    let ok = false;
    await withFixedNow(async () => {
        boot(Object.assign({ parallels: seedParallels() }, seedContext()));
        const r0 = await panelAction('promoteParallel', { id: 'par1' });
        const note0 = String((r0.state || {}).note || '');
        const cancelled = r0.ok === false && note0.indexOf('已取消转正') >= 0 && (state.atoms || []).length === 1 && (state.parallels || []).length === 2;
        // 关闭确认 → 直接转正
        cfg.parallelPromoteConfirm = false;
        const r1 = await panelAction('promoteParallel', { id: 'par1' });
        const note1 = String((r1.state || {}).note || '');
        const done = r1.ok === true && note1.indexOf('已转正为情节') >= 0 && note1.indexOf('自动移除') >= 0
            && (state.atoms || []).length === 2 && (state.parallels || []).length === 1 && tombs('parallels').indexOf('par1') >= 0;
        // 未找到 / 已转正
        const r2 = await panelAction('promoteParallel', { id: 'nope' });
        const note2 = String((r2.state || {}).note || '');
        state.parallels[0].promotedTo = 'atom_x';
        const r3 = await panelAction('promoteParallel', { id: 'par2' });
        const note3 = String((r3.state || {}).note || '');
        cfg.parallelPromoteConfirm = true;
        ok = cancelled && done && note2 === '未找到该平行事件' && note3 === '该平行事件已转正';
    });
    return ok;
}, '');

un();
R.done();
