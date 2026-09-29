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
    // v3.0.20：用户要求「清除已处理楼层记录」后总览重新列出第 0 层之后的所有待分析楼层
    clearProcessedFloors, recordProcessedFloors, processedStats,
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

// ============================================================
// E 组（v2.87.0 修复）：**聊天未就绪时不得清空「已处理楼层」台账**
// 用户报告：「总览的未摘要每次更新或重启后，都会提示大量早期楼层，该问题在之前版本已经存在。」
// 根因：插件启动/更新的时刻聊天可能尚未同步（`ctx.chat` 为空 / 消息无正文）→ `hashFloorText()` 全为空，
//   而旧口径「无正文 → 丢弃该标记」会把**整本台账**清空并盖上当前版本签名；聊天同步后台账已丢失，
//   只剩「已有记忆数据」兜底 → 早期楼层（数据早被上限裁剪）成片变回未摘要，且随下一次保存永久落盘。
// 本批：`host/floors.js#chatReadyForFloors()` 守卫三条维护路径（迁移 / 漂移防呆 / 归位对账）+ 扫描直接返回空。
// ============================================================
{
    const chatOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push({ is_user: i % 2 === 0, role: i % 2 === 0 ? 'user' : 'assistant', mes: '第' + i + '楼：角色甲在仓库清点货物并记下账目。' }); return a; };
    const marksOf = (n) => { const a = []; for (let i = 1; i <= n; i++) a.push({ f: i, h: 'old' + i }); return a; };
    const stWithMarks = (n) => { const st = emptyState(); st.processedFloors = marksOf(n); st.processedVer = 'v1.100:old'; st.lastKnownFloor = n; return st; };
    /** 换一份聊天上下文（模拟「插件刚启动、聊天还没同步」vs「聊天已同步」） */
    const useChat = (chat, lastId) => { installGlobalHost(makeHost({ chat }), doc); setLastMessageId(lastId); };

    // E1 未就绪：扫描直接返回空、`chatReady:false`，**台账一条不少**（旧行为会清成 0）
    setKernelState(stWithMarks(30)); useChat([], -1);
    const scanCold = scanPendingFloors();
    A('E1 聊天未就绪：扫描返回空 + `chatReady:false`/`skipped.chatNotReady`，**台账 30 条原样保留**（旧行为：清空为 0）',
        scanCold.floors.length === 0 && scanCold.chatReady === false && scanCold.skipped.chatNotReady === 1
        && state.processedFloors.length === 30 && (state.processedVer || '') === 'v1.100:old',
        J({ floors: scanCold.floors, marks: state.processedFloors.length, ver: state.processedVer }));

    // E2 未就绪：三条维护路径都**延后**（不丢标记、不盖新签名）
    const m1 = migrateProcessedFloorsV170();
    const m2 = processedDriftGuard(false, true);
    const m3 = reconcileProcessedFloors(false);
    A('E2 未就绪：迁移 / 漂移防呆 / 归位对账一律 `skipped:chat-not-ready`，台账与版本签名均不变',
        m1.skipped === 'chat-not-ready' && m2.skipped === 'chat-not-ready' && m3.skipped === 'chat-not-ready'
        && state.processedFloors.length === 30 && (state.processedVer || '') === 'v1.100:old',
        J({ m1: m1, m2: m2, m3: m3, marks: state.processedFloors.length }));

    // E3 就绪后：同一份台账被正常刷新（哈希变新、条数不丢），早期楼层**不会**冒出来
    setKernelState(stWithMarks(30)); useChat(chatOf(31), 30);
    const scanWarm = scanPendingFloors();
    const refreshed = (state.processedFloors || []).every((x) => String(x.h || '') !== '' && String(x.h).indexOf('old') !== 0);
    A('E3 聊天就绪后：台账被正常刷新（哈希全部更新、30 条不丢）→ 未摘要为空（不再成片冒早期楼层）',
        refreshed && state.processedFloors.length === 30 && scanWarm.floors.length === 0 && scanWarm.chatReady !== false,
        J({ floors: scanWarm.floors, marks: state.processedFloors.length, skipped: scanWarm.skipped }));

    // E4 回归：未就绪 → 就绪 的完整重启序列后，台账仍是 30 条（修复前后差异就在这一步）
    setKernelState(stWithMarks(30)); useChat([], -1);
    scanPendingFloors(); scanPendingFloors();                       // 启动期多次渲染
    migrateProcessedFloorsV170(); reconcileProcessedFloors(false);
    const survived = state.processedFloors.length;
    useChat(chatOf(31), 30);
    const scanAfter = scanPendingFloors();
    A('E4 重启序列（未就绪多次渲染 → 就绪）后：台账 30 条存活、未摘要为空',
        survived === 30 && state.processedFloors.length === 30 && scanAfter.floors.length === 0,
        J({ survived: survived, marks: state.processedFloors.length, floors: scanAfter.floors }));
}

// ==================== F 组：v3.0.20 「清除已处理楼层记录」（用户要求） ====================
// 用户报告（原话）：「设定-数据存储-清除已处理楼层记录，该功能异常，应该直接将已分析楼层统计归零，
//   确保可以在总览中重新看到第0层之后的所有待分析楼层。」
// 根因：台账清空后，逐楼跳过还有第二条判据「该楼已有记忆数据」（v2.64.0 按用户要求新增）——
//   分析过的楼层本来就有情节数据，于是台账清了、清单却还是空的（用户看到的「清了没变化」）。
//   V1 的 `clearFloors` 只有台账判据，故清空即全部重现；这里补回该语义（清空时的末楼号及之前不再按覆盖跳过）。
A('F1 清除已处理楼层记录：台账归零 + 统计归零，且**该楼号及之前不再按「已有记忆数据」跳过** → 总览重新列出第 0 层之后的所有待分析楼层（AI 楼）', (() => {
    const chat = [];
    for (let i = 0; i < 12; i++) chat.push({ is_user: i % 2 === 0, role: i % 2 === 0 ? 'user' : 'assistant', mes: '第' + i + '楼：角色甲在仓库清点货物并记下账目。' });
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < 12; i += 2) st.atoms.push({ id: 'f' + i, title: '情节' + i, text: '第' + i + '楼情节。', floorStart: i, floorEnd: i + 1, tags: [] });
    // 注意：本文件前面的小节会 `installGlobalHost(makeHost(...))` 换宿主 → 这里同样**装一个新宿主**再断，
    //   不能改旧的 `host.ctx`（`getCtx()` 已经不是它了）。
    installGlobalHost(makeHost({ chat: chat }), doc);
    boot(st);
    setLastMessageId(11);
    st.processedFloors = chat.map((_, i) => ({ f: i, h: hashFloorText(i) }));
    st.processedVer = processedVerTag();
    st.lastKnownFloor = 11;
    const before = scanPendingFloors();
    const r = clearProcessedFloors();
    const after = scanPendingFloors({ maintain: false });
    const stats = processedStats();
    // 重新分析（记录台账）后，这些楼层照常从清单消失 —— 既有「已处理」语义不受影响
    recordProcessedFloors(0, 11);
    const refilled = scanPendingFloors({ maintain: false });
    // 清空前：台账在册 → 6 个 AI 楼按「已处理」跳过（届时「已有记忆数据」判据还没轮到）
    return before.floors.length === 0 && Number(before.skipped.processed) === 6 && Number(before.skipped.covered) === 0
        && r.ok === true && r.cleared === 12 && r.coverUpTo === 11
        && stats.marks === 0 && stats.coverResetUpTo === 11                        // 统计归零（含覆盖失效标记）
        // 清空后：6 个 AI 楼**全部重现**（既无台账，也不再按「已有记忆数据」跳过）
        && J(after.floors) === J([1, 3, 5, 7, 9, 11]) && Number(after.skipped.covered) === 0
        && Number(after.skipped.processed) === 0
        && J(refilled.floors) === J([]) && Number(refilled.skipped.processed) === 6;   // 台账重新记上 → 不再列出
})(), () => J({ marks: processedStats().marks, coverResetUpTo: processedStats().coverResetUpTo, floors: scanPendingFloors({ maintain: false }).floors }));

A('F2 覆盖失效只在**清空时的末楼号及之前**生效：之后新增的楼层（及其「已有记忆数据」）仍按常规判据跳过 —— 既满足「重新看到全部待分析楼层」，又保住 v2.64.0 的覆盖跳过语义', (() => {
    const chat = [];
    for (let i = 0; i < 10; i++) chat.push({ is_user: i % 2 === 0, role: i % 2 === 0 ? 'user' : 'assistant', mes: '第' + i + '楼：角色甲在仓库清点货物。' });
    const st = emptyState();
    installGlobalHost(makeHost({ chat: chat }), doc);
    boot(st);
    setLastMessageId(9);
    st.processedFloors = chat.map((_, i) => ({ f: i, h: hashFloorText(i) }));
    st.processedVer = processedVerTag();
    st.lastKnownFloor = 9;
    clearProcessedFloors();                                    // coverUpTo = 9
    // 之后又聊了两层（10/11），其中第 11 楼已有情节数据（覆盖）→ 应被常规判据跳过
    const ctx = host.ctx; void ctx;   // 仅说明：宿主已换成上面那个新桩
    const now = (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') ? globalThis.SillyTavern.getContext() : null;
    now.chat.push({ is_user: false, role: 'assistant', mes: '第10楼：新正文。' });
    now.chat.push({ is_user: false, role: 'assistant', mes: '第11楼：新正文。' });
    st.atoms.push({ id: 'fx', title: '新情节', text: '第11楼情节。', floorStart: 11, floorEnd: 11, tags: [] });
    const sc = scanPendingFloors({ maintain: false });
    return J(sc.floors) === J([1, 3, 5, 7, 9, 10]) && Number(sc.skipped.covered) === 1;
})(), () => J(scanPendingFloors({ maintain: false }).skipped));

R.done();
