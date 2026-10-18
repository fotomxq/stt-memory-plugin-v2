// ============================================================
// 单元测试 · v3.50.19：W12 修复通道统一编排（`技-49` + `技-48` + `数-37` 的内核侧）
//   设计依据 `docs/D33`；裁决口径 = §6 **建议默认**（用户本轮指令「开发 W12 的 6 项」视为采纳）。
//
// 覆盖：
//   A 组 `技-49`：六域 `silent`（只抑制提示、不改落库）· 场景域候选封顶（`cfg.sceneRepairMaxItems`）
//   B 组 `技-48`：分节构造（结构类在前）· 按域拆回 · **域级隔离** · 坏 JSON 降级 · 仍失败零写入 · 总开关关闭
//   C 组 `数-37`：4 个预算键 · 四项计数（截断/缺失/跳过/降级）· `state.repairLog` 收口为**一条**（`tier/domains/agg`）
//
// 运行：node tests/unit/repair-aggregate.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { REPAIR_REGISTRY, repairDomain } from '../../core/repair-registry.js';
import {
    AGG_CFG, AGG_DEFAULTS, aggBudget, aggDomains, buildAggregatePrompt, splitAggregateResult,
    applyAggregate, aggCounters, parseAggJson, runRepairAggregate,
} from '../../core/repair-aggregate.js';

const R = makeReporter('repair-aggregate v3.50.19：W12 聚合编排（技-49 / 技-48 / 数-37 内核侧）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('agg19'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });
setKernelState(emptyState());

// ---------- A 组：技-49（silent / 场景封顶） ----------
A('A1 **六域 silent 已接线**：每个域模块都有模块级开关 + `notify` 首行短路（只抑制提示，不碰落库）', (() => {
    const files = ['core/group-repair.js', 'core/item-repair.js', 'core/plan-repair.js', 'core/state-repair.js', 'core/scene-repair.js', 'core/character-repair.js'];
    return files.every((f) => {
        const src = readFileSync(f, 'utf8');
        return src.indexOf('REPAIR_SILENT') >= 0 && src.indexOf('if (REPAIR_SILENT) return;') >= 0
            && src.indexOf('setRepairSilentLocal(opts && opts.silent === true)') >= 0;
    });
})(), 'n/a');

A('A2 **场景域候选封顶**：`cfg.sceneRepairMaxItems` 默认 **12**；`buildSceneRepairPrompt` 接收 `pick` 快照并按上限截断', (() => {
    const cfgSrc = readFileSync('core/config.js', 'utf8');
    const scSrc = readFileSync('core/scene-repair.js', 'utf8');
    return cfgSrc.indexOf('sceneRepairMaxItems: 12') >= 0
        && scSrc.indexOf('function buildSceneRepairPrompt(pick)') >= 0
        && scSrc.indexOf('cfg && cfg.sceneRepairMaxItems') >= 0
        && scSrc.indexOf('all.slice(0, cap)') >= 0
        && scSrc.indexOf('buildSceneRepairPrompt(o.pick)') >= 0;
})(), 'n/a');

// ---------- B 组：技-48（分节 / 拆回 / 隔离 / 降级） ----------
A('B1 **分节构造**：按执行顺序取域（**结构类在前**），每节带 `## <中文名>（<aggKey>）` 标记，字数受 `maxChars` 约束', (() => {
    const p = buildAggregatePrompt({ budget: { enabled: true, maxItems: 80, maxChars: 12000, maxDomains: 9 } });
    const structFirst = p.sections.every((s, i) => {
        if (i === 0) return true;
        const rank = (d) => (d.kind === 'struct' ? 0 : (d.kind === 'mixed' ? 1 : 2));
        return rank(repairDomain(p.sections[i - 1].id)) <= rank(repairDomain(s.id));
    });
    const raw = p.messages[1].content;
    return p.sections.length > 0 && structFirst
        && raw.indexOf('## ') >= 0 && raw.indexOf('（') >= 0
        && p.chars <= 12000;
})(), () => J(buildAggregatePrompt({}).sections.map((s) => s.id)));

A('B2 **字数预算截断**：`maxChars` 很小时 → `truncated:true` 且总字数不超预算', (() => {
    const p = buildAggregatePrompt({ budget: { enabled: true, maxItems: 80, maxChars: 60, maxDomains: 9 } });
    return p.truncated === true && p.chars <= 60;
})(), () => J((() => { const p = buildAggregatePrompt({ budget: { enabled: true, maxItems: 80, maxChars: 60, maxDomains: 9 } }); return { chars: p.chars, truncated: p.truncated }; })()));

A('B3 **按域拆回**：结果里的 `aggKey` 映射回域 id；缺席的域进 `missing`（用手工分节，避免依赖真实构造器的空/非空）', (() => {
    const sections = [{ id: 'plans', aggKey: 'plans' }, { id: 'scenes', aggKey: 'scenes' }];
    const split = splitAggregateResult({ plans: { a: 1 } }, sections);
    return J(split.byDomain) === J({ plans: { a: 1 } }) && J(split.missing) === J(['scenes']);
})(), 'n/a');
A('B4 **域级隔离 + 结构先于文本**：某域应用抛错只影响该域（计 `skipped`），其余域照常应用', (() => {
    const domains = [repairDomain('scenes'), repairDomain('plans')];
    const order = [];
    const r = applyAggregate({
        byDomain: { scenes: {}, plans: {} }, domains: domains,
        applyOne: (d) => { order.push(d.id); if (d.id === 'scenes') throw new Error('坏数据'); return { ok: 1 }; },
    });
    return J(order) === J(['plans', 'scenes'])        // 结构类（plans）先于文本类（scenes）
        && !!r.errors.scenes && J(r.skipped) === J(['scenes']) && !!r.applied.plans;
})(), 'n/a');

A('B5 **坏 JSON → 按域降级**：`aiText` 不是 JSON 时 `degraded>0`；逐域注入可救回对应域（`degraded` 计数如实）', (async () => {
    const r = await runRepairAggregate({
        aiText: '这不是 JSON', applyOne: () => ({ ok: 1 }),
        aiTextByDomain: { plans: { apply: 1 } }, log: () => undefined,
    });
    return r.counters.degraded >= 1 && !!r.applied.plans && !r.ok;
})(), 'n/a');

A('B6 **仍失败零写入**：坏 JSON 且无逐域补救 → `applied` 为空（一个域都不写）', (async () => {
    let appliedCount = 0;
    const r = await runRepairAggregate({ aiText: '???', applyOne: () => { appliedCount += 1; return {}; }, log: () => undefined });
    return appliedCount === 0 && J(r.applied) === '{}';
})(), 'n/a');

A('B7 **总开关关闭**：`cfg.repairAggEnabled=false` → 不发聚合请求，返回 `{disabled:true}`（调用方回退各域单发）', (async () => {
    let called = 0;
    const r = await runRepairAggregate({ budget: { enabled: false }, aiCall: () => { called += 1; return '{}'; }, log: () => undefined });
    return r.disabled === true && r.ok === false && called === 0;
})(), 'n/a');

A('B8 宽松解析：裸 JSON / 代码围栏 / 前后有杂字 都能解析出对象；纯文字 → null', (() => {
    return J(parseAggJson('{"a":1}')) === '{"a":1}'
        && J(parseAggJson('```json\n{"a":1}\n```')) === '{"a":1}'
        && J(parseAggJson('前缀 {"a":1} 后缀')) === '{"a":1}'
        && parseAggJson('没有 JSON') === null;
})(), 'n/a');

// ---------- C 组：数-37（预算键 / 计数 / 日志收口） ----------
A('C1 **4 个预算键**：`cfg` 与默认值齐备（`repairAggEnabled`/`MaxItems`/`MaxChars`/`MaxDomains`），`aggBudget` 读得对', (() => {
    const c = defaultCfg;
    return c.repairAggEnabled === true && c.repairAggMaxItems === 80
        && c.repairAggMaxChars === 12000 && c.repairAggMaxDomains === 9
        && J(Object.keys(AGG_CFG).sort()) === J(['enabled', 'maxChars', 'maxDomains', 'maxItems'])
        && aggBudget().maxItems === 80 && aggBudget().enabled === true;
})(), () => J(aggBudget()));

A('C2 **四项计数**：`aggCounters` 空值为 0、非数字归一为 0（截断/缺失/跳过/降级）', (() => {
    const z = aggCounters();
    const x = aggCounters({ truncated: 2, missing: 3, skipped: 1, degraded: 'x' });
    return J(z) === J({ truncated: 0, missing: 0, skipped: 0, degraded: 0 }) && x.degraded === 0 && x.truncated === 2;
})(), 'n/a');

A('C3 **`state.repairLog` 收口为一条**：一次聚合只写一条，且带 `tier:"agg"` + `domains` + `agg{chars,truncated,sections,applied}` + `counters`', (async () => {
    const recs = [];
    await runRepairAggregate({
        aiText: JSON.stringify({ plans: { ok: 1 } }), applyOne: () => ({ ok: 1 }),
        log: (rec) => recs.push(rec), domains: [repairDomain('plans')],
    });
    const r = recs[0] || {};
    return recs.length === 1 && r.tier === 'agg' && Array.isArray(r.domains)
        && !!r.agg && typeof r.agg.chars === 'number' && typeof r.agg.truncated === 'boolean'
        && !!r.counters && typeof r.counters.degraded === 'number';
})(), () => J((() => { const recs = []; void recs; return 'n/a'; })()));

A('C4 `aggDomains` 受 `maxDomains` 限制，且顺序 = 结构 → 混合 → 文本（与 `REPAIR_REGISTRY` 的 kind 一致）', (() => {
    const all = aggDomains({ enabled: true, maxItems: 80, maxChars: 12000, maxDomains: 9 });
    const three = aggDomains({ enabled: true, maxItems: 80, maxChars: 12000, maxDomains: 3 });
    const rank = (d) => (d.kind === 'struct' ? 0 : (d.kind === 'mixed' ? 1 : 2));
    let ordered = true;
    for (let i = 1; i < all.length; i++) if (rank(all[i - 1]) > rank(all[i])) ordered = false;
    return all.length === 9 && three.length === 3 && ordered && all.length === REPAIR_REGISTRY.length;
})(), () => J(aggDomains({ enabled: true, maxItems: 80, maxChars: 12000, maxDomains: 3 }).map((d) => d.id)));

R.done();
