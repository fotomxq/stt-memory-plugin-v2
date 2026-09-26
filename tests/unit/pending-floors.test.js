// ============================================================
// 单元测试 · v2.64.0「未摘要楼层跳过机制」
//
// 用户报告：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，请核对跳过机制。
//   当**原子数据对应的楼层存在时，则不需要分析**。」
//
// 本批（`core/floor-cover.js` + `host/floors.js` + `ui/panel.js` + `index.js`）：
//   ① 新增跳过判据：任一记忆维度条目带**有效楼层区间**（`floorStart ≤ i ≤ floorEnd`，且不是 `0/0` 这种
//      「区间未知」默认值）→ 该楼已有数据 → 不列为未摘要、批量/单楼分析也不取它；
//   ② 台账维护对齐 V1：旧标记迁移补**版本短路**（此前 V2 无条件重刷哈希 → 内容被改写的楼会被永久判为已处理）、
//      移植 v1.70 哈希归位对账（20s 节流）与 v1.174 哈希漂移防呆；
//   ③ 修 V1 缺陷：归位对账只在「条数变化」时写回 → 顶部插入新楼（条数不变、楼层号整体后移）时归位结果被丢弃，
//      已分析楼被重复列为未摘要；现在只要归位结果不同就写回；
//   ④ `endFloor` 取「聊天末尾」与「最后一条消息」的较小者（V1 `pendingFloorList(0, getLastMessageId())` 口径）；
//   ⑤ 扫描明细可查：`scanPendingFloors()` / `FTT.pendingFloors({detail:true})` / `extractSummary().pendingSkipped`。
//
// V1 对照（oracle）：`tests/fixtures/v1-golden-pending-floors.json`
//   = 真实 V1 v1.206 `pendingFloorList` × 同一份合成聊天 × 真实 V2 清单（三份：v1 / v2NoCover / v2）。
// 运行：node tests/unit/pending-floors.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { floorCoverage, meaningfulFloorRange, floorRanges } from '../../core/floor-cover.js';
import {
    listUnprocessedFloors, scanPendingFloors, processedDriftGuard, reconcileProcessedFloors,
    migrateProcessedFloorsV170, processedVerTag, hashFloorText,
} from '../../host/floors.js';
import { analyzeFloors, extractSummary } from '../../host/extract.js';
import { panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';
import { SCENARIOS, ALL_DIMS } from '../fixtures/pending-floors-scenarios.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('pending-floors v2.64.0 未摘要楼层跳过机制');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'v1-golden-pending-floors.json'), 'utf8'));
const byName = (n) => FX.scenarios.filter((s) => s.name === n)[0];
const scen = (n) => SCENARIOS.filter((s) => s.name === n)[0];
/** 简单可分析楼层（陈旧 lastMessageId 用例） */
const F4 = (i) => ({ is_user: false, role: 'assistant', mes: '第' + i + '楼：角色甲在仓库清点货物并记下账目。', swipes: null });

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);

function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.timelyAnalysis = false;
    cfg.summaryChunkSize = 4;
    setScopeKey('角色甲');
    setPersistHooks({
        saveState: () => true,
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setKernelState(st || emptyState());
    setPanelHooks2({});
    return state;
}

/** 按场景装配内核状态（与 oracle 生成器同口径） */
function mountScenario(sc) {
    const st = emptyState();
    for (const k of ALL_DIMS) st[k] = Array.isArray((sc.dims || {})[k]) ? JSON.parse(JSON.stringify(sc.dims[k])) : [];
    st.lastKnownFloor = -1;
    host.ctx.chat = sc.chat.map((m) => Object.assign({}, m));
    boot(st);
    if (sc.marksFromPre) {
        host.ctx.chat = sc.pre.map((m) => Object.assign({}, m));
        setLastMessageId(sc.pre.length - 1);
        st.processedFloors = sc.pre.map((_, i) => ({ f: i, h: hashFloorText(i) }));
        st.processedVer = processedVerTag();
        host.ctx.chat = sc.chat.map((m) => Object.assign({}, m));
    } else {
        st.processedFloors = (sc.marks || []).map((m) => ({ f: Number(m.f), h: m.h === null ? hashFloorText(Number(m.f)) : String(m.h) }));
        st.processedVer = sc.processedVer ? String(sc.processedVer) : processedVerTag();
    }
    setLastMessageId(Number(sc.lastId));
    return st;
}

/** 场景的显式扫描参数（endFloorOpt → 与 oracle 生成器同口径） */
function scanOpt(sc) { return (sc.endFloorOpt === undefined) ? {} : { endFloor: Number(sc.endFloorOpt) }; }

/** 场景对应的台账维护（与 oracle 生成器里「首次扫描自动触发」等价，此处显式调用以保证不依赖 20s 节流窗口） */
function maintain(sc) {
    if (sc.marksFromPre) { processedDriftGuard(false, true); reconcileProcessedFloors(false); return; }
    if (sc.name === 'drift-refresh') { processedDriftGuard(false, true); return; }
    if (sc.processedVer) { migrateProcessedFloorsV170(); return; }
}

// ==================== A 组：V1 oracle 对照不变量 ====================
A('A1 oracle 齐备：10 个场景 · 3 条已记录差异 · V1 台账签名与当前一致', FX.scenarios.length === 10 && FX.documentedDeviations.length === 3
    && FX.v1Tag === processedVerTag(), J({ n: FX.scenarios.length, tag: FX.v1Tag, mine: processedVerTag() }));

A('A2 不回退：V2 从不比 V1 基线「多列」楼层（onlyV2 恒空）', FX.scenarios.every((s) => s.onlyV2.length === 0),
    J(FX.scenarios.map((s) => ({ n: s.name, onlyV2: s.onlyV2 }))));

A('A3 包含关系：v2 ⊆ v2NoCover ⊆ v1（覆盖跳过只减不增）',
    FX.scenarios.every((s) => s.v2.every((f) => s.v2NoCover.indexOf(f) >= 0) && s.v2NoCover.every((f) => s.v1.indexOf(f) >= 0)),
    J(FX.scenarios.map((s) => s.name).filter((n) => {
        const s = byName(n);
        return !(s.v2.every((f) => s.v2NoCover.indexOf(f) >= 0) && s.v2NoCover.every((f) => s.v1.indexOf(f) >= 0));
    })));

A('A4 差异有据：onlyV1 / 覆盖跳过 / 台账变化非空的场景必须带差异说明；无差异场景 V2 与 V1 逐项相同',
    FX.scenarios.every((s) => {
        const hasDelta = s.onlyV1.length > 0 || s.coveredSkipped.length > 0 || J(s.v2MarksAfter) !== J(s.v1MarksAfter);
        if (hasDelta) return s.deviation.length > 0;
        return J(s.v2NoCover) === J(s.v1) && J(s.v2) === J(s.v1);
    }),
    J(FX.scenarios.map((s) => ({ n: s.name, onlyV1: s.onlyV1, cov: s.coveredSkipped, marksDiff: J(s.v2MarksAfter) !== J(s.v1MarksAfter), dev: s.deviation.length > 0 }))));

A('A5 fixture 自洽：expect.v2 / expect.marksAfter / expect.covered 与记录值吻合',
    FX.scenarios.every((s) => (s.expect.v2 === undefined || J(s.expect.v2) === J(s.v2))
        && (s.expect.marksAfter === undefined || J(s.expect.marksAfter) === J(s.v2MarksAfter))
        && (s.expect.covered === undefined || J(s.expect.covered) === J(s.coveredSkipped))),
    J(FX.scenarios.map((s) => s.name)));

// ==================== B 组：实时复算 V2（对齐 oracle 记录） ====================
A('B1 实时复算：9 个场景的 v2 / v2NoCover / 台账 / 覆盖数逐项等于 oracle 记录', (() => {
    const bad = [];
    for (const sc of SCENARIOS) {
        mountScenario(sc);
        maintain(sc);
        const opt = scanOpt(sc);
        const v2NoCover = listUnprocessedFloors(Object.assign({ ignoreCovered: true, maintain: false }, opt));
        const v2 = listUnprocessedFloors(Object.assign({ maintain: false }, opt));
        const marks = (state.processedFloors || []).map((m) => Number(m.f)).sort((a, b) => a - b);
        const cov = floorCoverage(state).floors;
        const f = byName(sc.name);
        if (!(J(v2) === J(f.v2) && J(v2NoCover) === J(f.v2NoCover) && J(marks) === J(f.v2MarksAfter) && cov === f.coverageFloors)) {
            bad.push({ n: sc.name, v2: v2, expV2: f.v2, v2nc: v2NoCover, expNc: f.v2NoCover, marks: marks, expMarks: f.v2MarksAfter, cov: cov, expCov: f.coverageFloors });
        }
    }
    return bad.length === 0;
})(), '见断言');

A('B2 归位修复可复现：顶部插入新楼后台账归位到 1/2/3，已分析楼不再重复列为未摘要', (() => {
    const sc = scen('relocate');
    mountScenario(sc);
    maintain(sc);
    const marks = (state.processedFloors || []).map((m) => Number(m.f)).sort((a, b) => a - b);
    return J(marks) === J([1, 2, 3]) && J(listUnprocessedFloors({ maintain: false })) === J([0, 4, 5]);
})(), J((state.processedFloors || []).map((m) => Number(m.f))));

// ==================== C 组：跳过判据、边界与联动 ====================
A('C1 跳过明细分桶：用户楼 1 / 隐藏楼 1 / 占位楼 1 / 台账已处理 1（其余为待摘要）', (() => {
    const sc = scen('skip-basic');
    mountScenario(sc);
    const s = scanPendingFloors({ maintain: false });
    return s.skipped.user === 1 && s.skipped.hidden === 1 && s.skipped.noText === 1 && s.skipped.processed === 1
        && s.skipped.covered === 0 && J(s.floors) === J(byName('skip-basic').v2) && s.endFloor === 6 && s.lastId === 6;
})(), J(scanPendingFloors({ maintain: false })));

A('C2 覆盖跳过计数：情节覆盖 1-3 楼 → covered 3、清单只剩 0/4/5', (() => {
    mountScenario(scen('covered-by-atoms'));
    const s = scanPendingFloors({ maintain: false });
    return s.skipped.covered === 3 && J(s.floors) === J([0, 4, 5]) && s.covered === 3;
})(), J(scanPendingFloors({ maintain: false })));

A('C3 覆盖判定边界：0/0 不算证据、相邻区间合并、倒挂/负值忽略、隐藏条目照算', (() => {
    const st = emptyState();
    st.atoms = [
        { id: 'z', text: '区间未知的条目，默认 0/0。', floorStart: 0, floorEnd: 0 },
        { id: 'r1', text: '第一段区间的条目正文足够长。', floorStart: 2, floorEnd: 3 },
        { id: 'r2', text: '紧邻第二段区间的条目正文足够长。', floorStart: 4, floorEnd: 5 },
        { id: 'bad1', text: '倒挂区间（结束小于开始）应被忽略。', floorStart: 9, floorEnd: 7 },
        { id: 'bad2', text: '负楼层应被忽略的条目正文足够长。', floorStart: -2, floorEnd: 3 },
        { id: 'hid', text: '已被总结隐藏的原情节仍算已有数据。', floorStart: 8, floorEnd: 8, hidden: true },
    ];
    st.memories = [{ id: 'm', owner: '甲', title: '账', content: '内容足够长。', floorStart: 7, floorEnd: 7 }];
    const ranges = floorRanges(st).ranges;
    const cov = floorCoverage(st);
    // 相邻区间（7-7 与 8-8）按并集合并为一段
    return J(ranges) === J([[2, 5], [7, 8]]) && cov.floors === 6
        && cov.has(2) && cov.has(5) && !cov.has(0) && !cov.has(1) && !cov.has(6) && cov.has(7) && cov.has(8) && !cov.has(9)
        && meaningfulFloorRange({ floorStart: 0, floorEnd: 0 }) === null
        && J(meaningfulFloorRange({ floorStart: 3, floorEnd: 9 })) === J([3, 9]);
})(), J(floorRanges(state).ranges));

A('C4 开关：ignoreCovered=true 时被覆盖的楼层重新出现（诊断用），默认不出现', (() => {
    mountScenario(scen('covered-by-segments'));
    return J(listUnprocessedFloors({ maintain: false })) === J([3])
        && J(listUnprocessedFloors({ maintain: false, ignoreCovered: true })) === J([0, 1, 2, 3]);
})(), J(listUnprocessedFloors({ maintain: false, ignoreCovered: true })));

A('C5 升级短路：processedVer 一致时旧标记迁移不重刷哈希（否则被改写的楼会被永久判为已处理）', (() => {
    mountScenario(scen('skip-basic'));
    const before = J(state.processedFloors);
    const r = migrateProcessedFloorsV170();
    return r.skipped === 'current' && J(state.processedFloors) === before;
})(), J(state.processedFloors));

A('C7 优先序：台账在册但哈希不符（正文被改写）→ 必须重新分析，覆盖判据不得压住内容变化', (() => {
    mountScenario(scen('covered-but-changed'));
    const s = scanPendingFloors({ maintain: false });
    return J(s.floors) === J([1]) && s.skipped.covered === 2 && s.covered === 3
        && J(listUnprocessedFloors({ maintain: false, ignoreCovered: true })) === J([0, 1, 2]);
})(), J((() => { mountScenario(scen('covered-but-changed')); return scanPendingFloors({ maintain: false }); })()));

A('C6 区间口径：内核 lastMessageId 落后（新楼刚入聊天、宿主尚未同步）时不得漏扫新楼', (() => {
    host.ctx.chat = [F4(0), F4(1), F4(2), F4(3)];
    boot(emptyState());
    setLastMessageId(1);                        // 快照落后（真实场景：push 新楼后未触发同步事件）
    const s = scanPendingFloors({ maintain: false });
    return s.endFloor === 3 && s.lastId === 1 && s.lastIdStale === true && J(s.floors) === J([0, 1, 2, 3]);
})(), J(scanPendingFloors({ maintain: false })));

// ==================== D 组：列表与执行同源 / 诊断出口 / 面板联动 ====================
{
    mountScenario(scen('covered-by-atoms'));
    const pending = listUnprocessedFloors({ maintain: false });
    const calls = [];
    const r = await analyzeFloors({
        ai: async () => { calls.push(1); return { ok: true, text: J({ atoms: { add: [{ title: '新事件', text: '甲在码头清点货物并记录去向（正文足够长）。' }] } }) }; },
    });
    A('D1 列表与执行同源：analyzeFloors 只分析未摘要清单（覆盖的 1/2/3 楼不被重复分析）',
        J(r.floors) === J(pending) && calls.length === pending.length
        && r.floors.indexOf(1) < 0 && r.floors.indexOf(2) < 0 && r.floors.indexOf(3) < 0,
        J({ floors: r.floors, pending: pending, calls: calls.length }));
}

{
    mountScenario(scen('covered-by-segments'));
    const sum = extractSummary();
    A('D2 诊断出口：extractSummary() 给出 pending 数 / pendingCovered / pendingSkipped / pendingEnd',
        sum.pending === 1 && sum.pendingCovered === 3 && sum.pendingEnd === 3
        && sum.pendingSkipped && sum.pendingSkipped.covered === 3 && typeof sum.pendingSkipped.processed === 'number',
        J({ pending: sum.pending, covered: sum.pendingCovered, end: sum.pendingEnd, skipped: sum.pendingSkipped }));
}

{
    mountScenario(scen('covered-by-atoms'));
    setPanelHooks2({ pending: (o) => listUnprocessedFloors(o || {}), busy: () => false, batchProgress: () => ({}), lastExtract: () => null });
    const html = panelBodyHtml('overview');
    A('D3 总览联动：待摘要 3 楼 + 「已有记忆数据 3 楼」一句话（覆盖数可见）',
        html.indexOf('未摘要 3 楼') > 0 && html.indexOf('已有记忆数据 3 楼') > 0 && html.indexOf('第4楼') > 0,
        '见断言');
}

R.done();
