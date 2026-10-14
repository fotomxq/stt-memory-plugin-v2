// ============================================================
// 单元测试 · v3.49.0 总览「🌶 弱化NSFW」计数：**事件触发 + 10 秒延迟去抖**（`docs/D22` §4.21 W21 `技-49`）
//
// 用户要求（原话）：「总览弱化NSFW按钮的数量统计背后应该有被动或定时器，这个机制会造成性能浪费。
//   可做延迟执行，管道完成某个操作后（注意排除弱化NSFW功能），自动触发一个信号，然后延迟10秒检查；
//   在延迟期间可能会频繁触发信号，但自动忽略多余信号，以避免频繁更新。」
//
// 本文件锁六件事：
//   ① **不再每次渲染全库扫描**：有缓存就用缓存（`fromCache`），只有缺失 / 过期才就地算一次；
//   ② **信号 → 10 秒延迟**：`signalNsfwCountRefresh` 只**排一次**检查，延迟恰为 `NSFW_COUNT_DELAY_MS`（10000）；
//   ③ **窗口内合并**：延迟期间再来信号一律 `coalesced`，且**不重排**（时间点不后移）—— 避免「信号越频繁越不准时」；
//   ④ **排除弱化NSFW 自身**：该标签的信号直接 `excluded`（用户明确要求）；
//   ⑤ **看不见就不扫**：面板关着 / 不在总览 → 执行时跳过扫描并计数；
//   ⑥ **反向探针**：把延迟改成 0 / 允许窗口内重排 / 忘了排除弱化 → 本文件变红。
//
// 运行：node tests/unit/nsfw-count-tick.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    NSFW_COUNT_DELAY_MS, NSFW_COUNT_SKIP_LABELS,
    nsfwCountTickState, nsfwCountCache, nsfwCountSnapshot, nsfwCountVisible,
    signalNsfwCountRefresh, refreshNsfwCount, invalidateNsfwCount, updateNsfwCountDom,
    setNsfwCountHooks, resetNsfwCountTick,
} from '../../ui/nsfw-count-tick.js';

const R = makeReporter('nsfw-count-tick v3.49.0 弱化NSFW 计数：事件触发 + 10s 延迟去抖（D22 W21 技-49）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// ---------- 可控时钟 + 假定时器 ----------
let NOW = 1000000;
const timers = [];        // {fn, ms, id, alive}
let seq = 0;
let setCalls = 0, cleared = 0;
setNsfwCountHooks({
    now: () => NOW,
    setTimeout: (fn, ms) => { setCalls += 1; const t = { fn: fn, ms: ms, id: ++seq, alive: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { cleared += 1; const t = timers.filter((x) => x.id === id)[0]; if (t) t.alive = false; },
});
/** 跑掉所有存活定时器（模拟时间到） */
function fireTimers() {
    const live = timers.filter((t) => t.alive);
    for (const t of live) { t.alive = false; t.fn(); }
    return live.length;
}
/** 真·数据源：造一批含露骨关键词的条目（让 `nsfwScan` 真的能算出候选） */
function boot(entries) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    const st = emptyState();
    st.atoms = entries || [];
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save() { }, saveState() { } });
    return st;
}
// 文本必须**真的命中**关键词表（`core/nsfw.js#NSFW_KEYWORDS` 含「做爱」）——否则计数恒为 0，测不出真实扫描
const DIRTY = [{ id: 'a1', title: 'x', text: '两人在屋里做爱，之后各自睡去。', date: '1919-01-01', tags: [], validity: 'active', floorEnd: 1 }];

// ---------- 全局假 DOM（带那个按钮；E1 单独覆盖成「看不见」）----------
const BTN = { _t: '', _attrs: {}, get textContent() { return this._t; }, set textContent(v) { this._t = String(v); }, setAttribute(k, v) { this._attrs[k] = String(v); }, getAttribute(k) { return this._attrs[k] || null; } };
const DOC_BTN = { querySelector: (sel) => (String(sel) === '#ftt-nsfw-btn' ? BTN : null) };
const PREV_DOC = globalThis.document;
globalThis.document = DOC_BTN;

// ---------- ① 缓存语义：不再每次渲染全库扫 ----------
resetNsfwCountTick();
boot(DIRTY);
A('A1 没有缓存时**就地算一次**（`fromCache:false`），且计数与内核口径**逐值一致**（`nsfwSoftenState().candidates`）', (async () => {
    const s = nsfwCountSnapshot();
    const core = await import('../../core/nsfw.js');
    let direct = -1; try { direct = Number(core.nsfwSoftenState().candidates) || 0; } catch (e) { direct = -1; }
    return s.fromCache === false && nsfwCountTickState().stats.inline === 1 && s.candidates === direct && direct >= 1;
})(), J(nsfwCountSnapshot()));
A('A2 10 秒内再取值 → **直接用缓存**（不再扫库：`inline` 计数不涨）', (() => {
    const before = nsfwCountTickState().stats.inline;
    const a = nsfwCountSnapshot();
    const b = nsfwCountSnapshot();
    const after = nsfwCountTickState().stats.inline;
    return a.fromCache === true && b.fromCache === true && after === before;
})(), J(nsfwCountTickState().stats));
A('A3 超过一个延迟周期（>10s）→ 再就地算一次（窗口续上，而不是永远陈旧）', (() => {
    const before = nsfwCountTickState().stats.inline;
    NOW += NSFW_COUNT_DELAY_MS + 1;
    const s = nsfwCountSnapshot();
    return s.fromCache === false && nsfwCountTickState().stats.inline === before + 1;
})(), J(nsfwCountTickState().stats));

// ---------- ② 信号 → 10 秒延迟（且只排一次） ----------
resetNsfwCountTick();
setCalls = 0; cleared = 0; timers.length = 0;
A('B1 管道完成信号 → **排一次延迟检查**，延迟恰为用户要求的 10000ms', (() => {
    const r = signalNsfwCountRefresh('提取记忆');
    return r.accepted === true && r.reason === 'scheduled' && setCalls === 1
        && timers.length === 1 && timers[0].ms === NSFW_COUNT_DELAY_MS && NSFW_COUNT_DELAY_MS === 10000
        && nsfwCountTickState().scheduled === true;
})(), J({ r: signalNsfwCountRefresh, delay: NSFW_COUNT_DELAY_MS }));
A('B2 **延迟期间不执行**（时间没到 → `runs` 不涨，缓存未更新）', (() => {
    const runs = nsfwCountTickState().stats.runs;
    NOW += NSFW_COUNT_DELAY_MS - 1;          // 差 1ms
    return nsfwCountTickState().stats.runs === runs;
})(), J(nsfwCountTickState().stats));

// ---------- ③ 窗口内多余信号：忽略且不重排 ----------
A('C1 延迟窗口内再来 3 个信号 → 全部 `coalesced`（自动忽略多余信号）', (() => {
    const r1 = signalNsfwCountRefresh('自动修复');
    const r2 = signalNsfwCountRefresh('推演');
    const r3 = signalNsfwCountRefresh('传言演化');
    return r1.reason === 'coalesced' && r2.reason === 'coalesced' && r3.reason === 'coalesced'
        && nsfwCountTickState().stats.dropped === 3;
})(), J(nsfwCountTickState().stats));
A('C2 **不重排**：窗口内信号不会把检查时间点往后推（`setCalls` 仍为 1，无 clear）—— 这是「避免频繁更新」的关键', (() => {
    return setCalls === 1 && cleared === 0 && timers.filter((t) => t.alive).length === 1;
})(), J({ setCalls, cleared, alive: timers.filter((t) => t.alive).length }));
A('C3 时间到 → 执行一次检查并刷新缓存（`runs` +1，`scheduled` 归位）', (() => {
    boot(DIRTY);
    NOW += 2;
    const runs = nsfwCountTickState().stats.runs;
    const n = fireTimers();
    const st = nsfwCountTickState();
    return n === 1 && st.stats.runs === runs + 1 && st.scheduled === false && st.pending === false;
})(), J(nsfwCountTickState()));

// ---------- ④ 排除「弱化NSFW」自身 ----------
resetNsfwCountTick();
setCalls = 0; timers.length = 0;
A('D1 `弱化NSFW` 的完成信号被**排除**（不排检查、计入 `excluded`）', (() => {
    const r = signalNsfwCountRefresh('弱化NSFW');
    return r.accepted === false && r.reason === 'excluded' && setCalls === 0
        && nsfwCountTickState().stats.excluded === 1 && nsfwCountTickState().scheduled === false;
})(), J(nsfwCountTickState()));
A('D2 排除表口径固定（`弱化NSFW` 与动作名 `nsfwSoften` 都在表内 —— 改名字也不会漏排除）', (() => {
    return NSFW_COUNT_SKIP_LABELS.indexOf('弱化NSFW') >= 0 && NSFW_COUNT_SKIP_LABELS.indexOf('nsfwSoften') >= 0
        && signalNsfwCountRefresh('nsfwSoften').reason === 'excluded'
        && signalNsfwCountRefresh('').reason === 'scheduled';      // 其它（含空标签）照常排
})(), J(NSFW_COUNT_SKIP_LABELS));

// ---------- ⑤ 看不见就不扫 ----------
resetNsfwCountTick();
setCalls = 0; timers.length = 0;
A('E1 执行时**面板关着 / 不在总览**（DOM 里没有那个按钮）→ 跳过扫描并计数（算力留给用户在看时）', (() => {
    globalThis.document = { querySelector: () => null };          // 桩：找不到 `#ftt-nsfw-btn`
    const runs = nsfwCountTickState().stats.runs;
    const skipped0 = nsfwCountTickState().stats.skipped;
    signalNsfwCountRefresh('提取记忆');
    fireTimers();
    const skipped = nsfwCountTickState().stats.skipped;
    const ok = nsfwCountTickState().stats.runs === runs && skipped === skipped0 + 1 && nsfwCountVisible() === false;
    globalThis.document = DOC_BTN;
    return ok;
})(), 'n/a');
A('E2 看得见时执行 → 真的刷新缓存并**就地**更新按钮文案与 title', (() => {
    const btn = BTN;
    btn.textContent = '';
    boot(DIRTY);
    const runs = nsfwCountTickState().stats.runs;
    signalNsfwCountRefresh('提取记忆');
    fireTimers();
    const ok = nsfwCountTickState().stats.runs === runs + 1
        && /^🌶 弱化NSFW（\d+）$/.test(String(btn.textContent))
        && String(btn._attrs.title).indexOf('NSFW 等级留档：无 ') >= 0
        && String(btn._attrs.title).indexOf('（按原文判定，弱化后不变）') > 0;
    return ok;
})(), 'n/a');
A('E3 文本未变时**不重复写 DOM**（就地更新不能变成每 10 秒写一次 DOM）', (() => {
    let writes = 0;
    const btn = {
        _t: '', _attrs: {},
        get textContent() { return this._t; },
        set textContent(v) { writes += 1; this._t = String(v); },
        setAttribute() { }, getAttribute(k) { return this._attrs[k] || null; },
    };
    globalThis.document = { querySelector: () => btn };
    refreshNsfwCount();                 // 第一次：算出并写入
    const first = writes;
    refreshNsfwCount();                 // 第二次：同样的数据 → 不应再写
    const ok = first === 1 && writes === 1;
    globalThis.document = DOC_BTN;
    return ok;
})(), 'n/a');

// ---------- ⑥ 作废缓存（弱化动作结束后的即时口径） ----------
resetNsfwCountTick();
A('F1 `invalidateNsfwCount()` → 下一次取值**就地重算**（点完弱化立刻看到新数字，且只算这一次）', (() => {
    boot(DIRTY);
    nsfwCountSnapshot();                                   // 先填上缓存
    const had = !!nsfwCountCache();
    const invalidated = invalidateNsfwCount();
    const before = nsfwCountTickState().stats.inline;
    const s = nsfwCountSnapshot();
    return had && invalidated === true && s.fromCache === false && nsfwCountTickState().stats.inline === before + 1;
})(), J(nsfwCountTickState().stats));

// ---------- ⑦ 反向探针 ----------
A('G1 反向探针①：延迟口径若被改成 0（= 回到「立即执行」）→ B1/B2 会变红', () => {
    return NSFW_COUNT_DELAY_MS === 10000 && NSFW_COUNT_DELAY_MS > 0;
}, J(NSFW_COUNT_DELAY_MS));
A('G2 反向探针②：若窗口内信号「重排定时器」→ C2 会变红（本判据直接盯着 clear 与 set 次数）', (() => {
    resetNsfwCountTick();
    setCalls = 0; cleared = 0; timers.length = 0;
    signalNsfwCountRefresh('提取记忆');
    signalNsfwCountRefresh('提取记忆');
    signalNsfwCountRefresh('提取记忆');
    return setCalls === 1 && cleared === 0;
})(), J({ setCalls, cleared }));
A('G3 反向探针③：若忘了排除「弱化NSFW」→ D1 会变红（此处验证排除判据真的生效）', (() => {
    resetNsfwCountTick();
    setCalls = 0; timers.length = 0;
    const ex = signalNsfwCountRefresh('弱化NSFW');
    const ok = ex.reason === 'excluded' && setCalls === 0;
    resetNsfwCountTick();
    return ok;
})(), 'n/a');
A('G4 反向探针④：若渲染层回到「每次必扫」→ A2 会变红（本判据盯着 `inline` 计数不涨）', (() => {
    resetNsfwCountTick();
    boot(DIRTY);
    nsfwCountSnapshot();
    const before = nsfwCountTickState().stats.inline;
    nsfwCountSnapshot(); nsfwCountSnapshot(); nsfwCountSnapshot();
    return nsfwCountTickState().stats.inline === before;
})(), 'n/a');

resetNsfwCountTick();
globalThis.document = PREV_DOC;
R.done();
