// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-12`** —— 计划 / 悬念能开环
//   设计：`docs/D20` §3.4 / §8 `数-12`（① 一键闭环 ② 老化策略 ③ 体检「长期 open」计数）
//   实现：`core/plan-aging.js`（只读分档，纯函数）· `core/entries.js#closeEntries`（写侧：与既有「了结」同一语义）·
//         `ui/panel.js`（「⌛ 长期未推进」筛选 + 「⌛ 了结长期未推进（N）」危险动作）· `core/data-health.js`（hygiene）
//
// 本文件锁四件事：
//   ① **分档口径按剧情时间**（不是现实墙钟）：同一份存档在不同时刻得到同一结果；
//   ② **无剧情时钟 → 不老化**（`unknown`，不产生候选）—— 宁可不给按钮，也不给一个乱算的按钮；
//   ③ **闭环可增长统计**：`closeEntries` 把条目移出容器并计入 `stats.plansClosed / suspenseResolved`，
//      同时**级联删除关联行**；空清单 → 不写、返回 `ok:false`（不静默了结任何东西）；
//   ④ **不自动删数据**：老化只**报告 + 筛选**，真正的了结必须由用户点击（危险动作 → 二次确认）。
//
// 运行：node tests/unit/plan-aging.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { closeEntries } from '../../core/entries.js';
import {
    PLAN_AGING_FRESH_DAYS, PLAN_AGING_STALE_DAYS, agingBucketOf, closeKeyOf, entryAgeDays, planAgingReport, storyDayGap,
} from '../../core/plan-aging.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('plan-aging v3.44.0 计划悬念开环（D22 W4 数-12）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

const SEED = () => Object.assign(emptyState(), {
    state: { date: '1919-11-29', time: '夜', location: '码头' },
    plans: [
        { id: 'p1', status: 'open', title: '旧计划', content: '很久以前定下的计划内容。', date: '1919-01-01' },
        { id: 'p2', status: 'open', title: '新计划', content: '刚定下的计划内容。', date: '1919-11-25' },
    ],
    suspense: [
        { id: 's1', status: 'open', title: '老悬念', content: '很久以前留下的疑问内容。', date: '1919-05-01' },
        { id: 's2', status: 'open', title: '新悬念', content: '刚刚留下的疑问内容。', date: '1919-11-28' },
    ],
    links: [
        { id: 'l1', dim: 'plans', refId: 'p1', who: '甲', how: 'author', at: '1919-01-01' },
        { id: 'l2', dim: 'suspense', refId: 's1', who: '甲', how: 'involved' },
    ],
    stats: { plansClosed: 0, suspenseResolved: 0 },
});

A('P1 天数差（近似，只用于分档）：同日 = 0；未来日期 = 0（不产生负年龄）；不可解析 = NaN', (() => {
    const d = (a, b) => storyDayGap(a, b);
    return d('1919-11-29', '1919-11-29') === 0 && d('1919-11-30', '1919-11-29') === 0
        && d('1919-01-01', '1919-11-29') === 328
        && Number.isNaN(d('', '1919-11-29')) && Number.isNaN(d('1919-11-29', ''));
})(), J([storyDayGap('1919-01-01', '1919-11-29')]));

A('P2 分档阈值：≤ ' + PLAN_AGING_FRESH_DAYS + ' 天新鲜 / ≤ ' + PLAN_AGING_STALE_DAYS + ' 天缓慢 / 更久「长期未推进」；不可判定 = unknown（**不老化**）', (() => {
    return agingBucketOf(0) === 'fresh' && agingBucketOf(PLAN_AGING_FRESH_DAYS) === 'fresh'
        && agingBucketOf(PLAN_AGING_FRESH_DAYS + 1) === 'aging' && agingBucketOf(PLAN_AGING_STALE_DAYS) === 'aging'
        && agingBucketOf(PLAN_AGING_STALE_DAYS + 1) === 'stale' && agingBucketOf(NaN) === 'unknown'
        && entryAgeDays({ date: '1919-01-01' }, '1919-11-29') === 328
        && Number.isNaN(entryAgeDays({ date: '1919-01-01' }, ''));
})(), '');

A('P3 老化报告（只读）：已 `closed` 的不在面内；按分档逐维计数；候选清单只含 aging + stale', (() => {
    const s = SEED();
    s.plans.push({ id: 'p3', status: 'closed', title: '已完成', content: '已了结的计划内容。', date: '1900-01-01' });
    const r = planAgingReport(s, '1919-11-29');
    return r.dims.plans.open === 2 && r.dims.plans.stale === 1 && r.dims.plans.fresh === 1
        && r.dims.suspense.open === 2 && r.dims.suspense.stale === 1
        && r.total === 2 && r.candidates.every((c) => c.bucket === 'stale' || c.bucket === 'aging')
        && r.candidates.map((c) => c.id).sort().join(',') === 'p1,s1';
})(), J(planAgingReport(SEED(), '1919-11-29').dims));

A('P4 **无剧情时钟 → 全部 unknown、候选为空**（不用现实墙钟替代：同一份存档在任何时刻都必须得到同一结论）', (() => {
    const r = planAgingReport(SEED(), '');
    return r.total === 0 && r.byBucket.unknown === 4 && r.candidates.length === 0;
})(), J(planAgingReport(SEED(), '').byBucket));

A('P5 一键闭环的**写侧**：按 id 列表了结 → 条目移出容器、`stats` 计数 +N、级联删除其关联行；空清单 → 不写任何东西', (() => {
    setKernelState(SEED());
    const beforeLinks = (state.links || []).length;
    const r = closeEntries('plans', ['p1']);
    const r2 = closeEntries('suspense', ['s1']);
    const r3 = closeEntries('plans', []);                       // 空清单
    return r.ok === true && r.closed === 1 && r.statKey === 'plansClosed' && r.statValue === 1
        && r2.ok === true && r2.closed === 1 && r2.statKey === 'suspenseResolved' && r2.statValue === 1
        && r.links === 1 && r2.links === 1 && beforeLinks === 2 && (state.links || []).length === 0
        && state.plans.length === 1 && state.suspense.length === 1
        && r3.ok === false && r3.closed === 0;
})(), '');

A('P6 闭环**只动给定的 id**：不在清单里的条目一条不少；维度不合法直接拒绝（不猜）', (() => {
    setKernelState(SEED());
    const r = closeEntries('plans', ['p2', '不存在']);
    const bad = closeEntries('atoms', ['a1']);
    return r.closed === 1 && state.plans.length === 1 && state.plans[0].id === 'p1'
        && state.stats.plansClosed === 1 && bad.ok === false && bad.closed === 0;
})(), '');

A('P7 体检出口：`plan-long-open` 进 `hygiene`（分维计数、写清当前剧情日期），**不**进 `findings`', (() => {
    const rep = dataHealthReport(SEED());
    const f = rep.hygiene.findings.filter((x) => x.code === 'plan-long-open');
    return rep.hygiene.counts['plan-long-open'] === 2 && f.length === 2
        && f[0].detail.indexOf('1919-11-29') > 0
        && rep.findings.filter((x) => x.code === 'plan-long-open').length === 0;
})(), '');

A('P8 「了结」的定位文本（供 AI 路径复用）：有标题用标题，否则用正文前 40 字；两者都无 → 空串', (() => {
    return closeKeyOf({ title: '旧计划', content: '内容' }) === '旧计划'
        && closeKeyOf({ content: '一二三四五六七八九十' }) === '一二三四五六七八九十'
        && closeKeyOf({ title: '  ' }) === '' && closeKeyOf({}) === '';
})(), '');

R.done();
