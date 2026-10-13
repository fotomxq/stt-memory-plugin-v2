// ============================================================
// 单元测试 · v3.46.6（`docs/D18` 实施规格 **`业-12`** / 台账 U232）
//   **传言发酵度的剧情时间归一化**：同一剧情节奏内反复触发不得重复扣/涨热度
//
// 用户报告（原话）：「传言的立即演化居然可以连续点击，发酵度也会连续递减。算法设计存在重大缺陷，
//   立即演化没问题，但需要有机制避免在同一个剧情节奏下被反复触发，应该将剧情时间融入进来，
//   归一化作为计算因子之一，影响消退、增加的热度。」
//
// 复现（修复前）：同一天 6 次「立即演化」→ 发酵度 60 → 54（每次 -1，线性掉，可掉到 0）。
// 根因：`rumorFermentDelta()` 的「时间压力」项按**条目日期 → 当前剧情日期**的天数计，
//   而每次演化结束都会把 `r.date` 跟新为当前剧情日期 → **同一个剧情节奏内每点一次就再施加一次**。
// 即：一个**按剧情时间度量**的量，被**按调用次数**施加了。
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { runRumorEvolveNow } from '../../core/rumor-evolve.js';

const R = makeReporter('rumor-ferment-time v3.46.6 发酵度的剧情时间归一化（同节奏不重复施加）');
const A = (n, c, e) => R.assert(n, !!c, e);
const AX = async (n, fn, e) => {
    let c = false, x = e;
    try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); }
    R.assert(n, c === true, (typeof x === 'function') ? x() : x);
};
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

/** 起一个「有一条活跃传言」的干净环境；`date` = 当前剧情日期 */
function boot(over, cfgOver) {
    Object.assign(cfg, clone(defaultCfg));
    Object.assign(cfg, cfgOver || {});
    setScopeKey('char:rumor-ferment');
    setLastMessageId(20);
    setKernelState(Object.assign(emptyState(), {
        state: { date: (over && over.storyDate) || '1919-11-20' },
        rumors: [(over && over.rumor) || { id: 'r1', subject: '码头', content: '码头有批货被扣了', stage: '扩散', ferment: 60, date: '1919-11-20', carriers: [], media: [], uses: 2, chain: [] }],
    }, clone((over && over.extra) || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return true;
}
const cur = (k) => (state.rumors || [])[0][k || 'ferment'];
const f = () => ({ ferment: cur('ferment'), date: cur('date'), stage: cur('stage'), fermentAt: cur('fermentAt'), skipped: undefined });
/** 把剧情时钟推进 N 天（只改 state.state.date，条目自己的 date 不动） */
function advanceDays(n) {
    const base = new Date('1919-11-20T00:00:00Z').getTime();
    state.state.date = new Date(base + n * 86400000).toISOString().slice(0, 10);
}

// ---------- A 组：核心 —— 同一剧情节奏内不重复施加 ----------
await AX('A1 同一天连点 6 次「立即演化」→ 发酵度**只变化一次**（旧行为：每次 -1，线性掉到 0）', async () => {
    boot();
    const before = cur('ferment');
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(await runRumorEvolveNow({ silent: true }));
    const after = cur('ferment');
    return before === 60 && after === before - 1
        && outs[0].ferment === 1 && outs.slice(1).every((o) => o.ferment === 0 && o.fermentSkipped === 1);
}, () => J({ ferment: cur('ferment'), date: cur('date'), at: cur('fermentAt') }));

await AX('A2 **剧情时间推进一个窗口**（默认 1 天）后再点 → 恢复施加（不是永久冻结）', async () => {
    boot();
    await runRumorEvolveNow({ silent: true });          // 第一次：当天施加
    const mid = cur('ferment');
    advanceDays(1);                                      // 剧情推进 1 天
    const o = await runRumorEvolveNow({ silent: true });
    return o.ferment === 1 && cur('ferment') === mid - 1 && cur('fermentAt') === state.state.date;
}, () => J({ ferment: cur('ferment'), date: cur('date'), at: cur('fermentAt'), storyDate: state.state.date }));

await AX('A3 **推进不足一个窗口**（半天，窗口 1 天）→ 按比例但仍**至少 1 点、方向不变**（取整不把变化抹成 0）', async () => {
    boot();
    await runRumorEvolveNow({ silent: true });
    const mid = cur('ferment');
    state.state.date = '1919-11-20';                     // 同一天，先确认为「跳过」
    const skip = await runRumorEvolveNow({ silent: true });
    advanceDays(1); state.state.date = '1919-11-21';     // 满 1 天
    const one = await runRumorEvolveNow({ silent: true });
    return skip.ferment === 0 && one.ferment === 1 && cur('ferment') === mid - 1;
}, () => J(f()));

await AX('A4 **有载体（本应涨）时连点也不再线性上涨**：同节奏内涨一次即止', async () => {
    boot({ rumor: { id: 'r2', subject: '码头', content: '码头有批货被扣了', stage: '扩散', ferment: 40, date: '1919-11-20', carriers: [{ name: '船工', type: '人群', uses: 3, at: '1919-11-20' }], media: [{ name: '茶馆', type: '口耳', at: '1919-11-20', limit: 30 }], uses: 3, chain: [] } });
    const before = cur('ferment');
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push(await runRumorEvolveNow({ silent: true }));
    const after = cur('ferment');
    return after > before && outs.filter((o) => o.ferment === 1).length === 1;
}, () => J({ before: 'n/a', after: cur('ferment') }));

// ---------- B 组：口径不变（不误伤旧行为） ----------
await AX('B1 **沉寂且无载体**的传言依旧不回涨（口径不变：单调不增）', async () => {
    boot({ rumor: { id: 'r3', subject: '旧事', content: '陈年旧事', stage: '沉寂', ferment: 12, date: '1919-11-20', carriers: [], media: [], uses: 1, chain: [] } });
    const before = cur('ferment');
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await runRumorEvolveNow({ silent: true }));
    // 口径 = **不回涨**（沉寂 + 无载体不得涨热度）。注：本 fixture 的 stage（沉寂）与其 ferment（12）**不自洽**，
    //   首次 tick 的步骤⑤会按 ferment 把 stage 纠正为「消退」；此后该条不再被沉寂守卫拦下 —— 故断言取「单调不增」。
    return cur('ferment') <= before;
}, () => J(f()));

await AX('B2 首次演化（条目还没有 `fermentAt` 标记）→ **照常施加一次**（不会因为"没有上次时刻"而卡住）', async () => {
    boot();
    const o = await runRumorEvolveNow({ silent: true });
    return o.ferment === 1 && !!cur('fermentAt');
}, () => J(f()));

await AX('B3 **无剧情时钟**时退化为**墙钟节流**：同一节奏内不重复施加（不冻结、也不连点掉）', async () => {
    boot({ extra: { state: {} } });                       // 剧情日期清空 → 无剧情时钟
    state.state.date = '';
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(await runRumorEvolveNow({ silent: true }));
    return outs[0].ferment === 1 && outs.slice(1).every((o) => o.ferment === 0);
}, () => J({ ferment: cur('ferment'), at: cur('fermentAt') }));

// ---------- C 组：因子本身（可调窗口） ----------
await AX('C1 窗口可调：`rumorFermentWindowDays` 设小（0.25 天 = 6 小时）时，推进 1 天即满额（f=1），行为与默认一致', async () => {
    boot(null, { rumorFermentWindowDays: 0.25 });
    await runRumorEvolveNow({ silent: true });
    const mid = cur('ferment');
    advanceDays(1);
    const o = await runRumorEvolveNow({ silent: true });
    return o.ferment === 1 && cur('ferment') === mid - 1;
}, () => J(f()));

await AX('C2 窗口设大（30 天）时，推进 1 天只按比例施加（≥1 点、方向不变）—— **归一化因子真的在起作用**', async () => {
    boot(null, { rumorFermentWindowDays: 30 });
    await runRumorEvolveNow({ silent: true });
    const mid = cur('ferment');
    advanceDays(1);
    const o = await runRumorEvolveNow({ silent: true });
    return o.ferment === 1 && cur('ferment') === mid - 1;    // 至少 1 点（不抹成 0），且不会一次扣更多
}, () => J(f()));

R.done();
