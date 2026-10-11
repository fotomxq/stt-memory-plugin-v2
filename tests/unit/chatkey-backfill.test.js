// ============================================================
// 单元测试 · v3.45.1（`docs/D22` §4.7 W6 · `数-29` · 台账 U177）
//   **无聊天归属的存量数据收口** —— 只读判定「可唯一归属」，幂等补写 `chatKey` / `ck`。
//
// 真机事实（`docs/D29` §2 第 8 行）：`plotScope` 20 条情节里 5 条无 `chatKey`（`legacy 5`）；
//   台账 **32/34** 条标记既无 `chatKey` 也无时间戳（`marksLegacyNoChat 32`）。
//
// 本文件的护栏（逐条对应 `docs/D29` §5 R4 / §6 Q3 与 `docs/D22` 的验收）：
//   · **双命中才补**：① 同维度已有「本聊天 + 同内容指纹」的条目；② 条目当前位置的楼层正文指纹在本聊天里可复核；
//     台账标记同理（`h` 与注入的楼层哈希解析器逐字相等 / 同指纹已有归属）；
//   · 判不出来的一律**不写**，并保留独立计数（`plotScope.legacy` / `marksLegacyNoChat`）；
//   · **只补空值**：已有 `chatKey`（尤其属于别条聊天的）一律不动；重复执行幂等（第二次 `changed === false`）；
//   · **不删一条**：补写前后总条数与台账标记总数都不变；
//   · 载入期自愈（`migrateState` 第 ⑩ 步）不再把 v3.40.0 写上的 `ck` / `at` 抹掉。
//
// 运行：node tests/unit/chatkey-backfill.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    backfillChatScope, backfillMarkScope, backfillChatAttribution,
    plotScopeSnapshot, contentFingerprintOf,
} from '../../core/chat-scope.js';
import { atomContentHash } from '../../core/model/hash.js';
import { migrateState, lastHealInfo } from '../../core/migrate.js';
import { setRepairHooks } from '../../core/repair.js';
import { ledgerHealth, hashFloorText, processedVerTag } from '../../host/floors.js';

const R = makeReporter('chatkey-backfill v3.45.1 W6 数-29 无聊天归属的存量数据收口（双命中才补、只补空值、幂等）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e));
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
/** 6 楼聊天（每楼都有可分析正文 → `hashFloorText(f)` 非空，楼层指纹判据可测） */
const FLOORS = 6;
const chat = [];
for (let i = 0; i < FLOORS; i++) chat.push({ is_user: false, mes: '第 ' + i + ' 楼：甲在码头清点货物并登记入册。', name: '角色甲' });
const host = makeHost({ chat: chat });
installGlobalHost(host, doc);

/** 一条情节（内容固定，便于构造「同内容异 id」的副本） */
const ATOM = (id, extra) => Object.assign({ id: id, title: '码头', text: '甲在码头清点货物并登记入册。', date: '628-07-10', tags: ['码头'] }, extra || {});

function boot(extra) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:chatkey');
    setLastMessageId(FLOORS - 1);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(Object.assign(emptyState(), extra || {}));
    setRepairHooks({ floorHash: (i) => hashFloorText(i) });   // 与 `index.js#installHostBridges()` 同一接线
    return state;
}

// ============================================================
// A 组：条目（情节）归属的双命中判定
// ============================================================
A('A1 双命中① 「本聊天 + 同内容指纹」：同维度已有一条带 `chatKey` 的同内容条目 → 副本被补上归属（指纹复用 `atomContentHash`）', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [ATOM('a1', { chatKey: 'chat-A' }), ATOM('a2')];
    // 前提：内容指纹与 id 无关（同一内容两条 → 同一指纹）
    const sameHash = contentFingerprintOf('atoms', st.atoms[0]) === contentFingerprintOf('atoms', st.atoms[1]);
    const r = backfillChatScope(st, { chatKey: 'chat-A' });
    return sameHash && r.changed === true && r.filled === 1 && r.legacy === 0
        && String(st.atoms[1].chatKey) === 'chat-A'
        && String(st.atoms[0].chatKey) === 'chat-A'
        && st.atoms.length === 2;                       // **不删一条**
})(), () => ({ atoms: state.atoms }));

A('A2 双命中② 「当前聊天里该楼正文指纹可复核」：`floorNowHash` 与注入解析器逐字相等 → 补归属；指纹不符 → 不补', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [
        ATOM('b1', { floorNowStart: 3, floorNowEnd: 3, floorNowHash: hashFloorText(3) }),                       // 在本聊天里可复核
        ATOM('b2', { title: '别处', text: '乙在船上清点货物并登记入册。', floorNowStart: 4, floorNowEnd: 4, floorNowHash: 'not-in-this-chat' }),   // 复核不过
    ];
    const r = backfillChatScope(st, { chatKey: 'chat-A', hashFloor: hashFloorText });
    return r.changed === true && r.filled === 1 && r.legacy === 1
        && String(st.atoms[0].chatKey) === 'chat-A'
        && !st.atoms[1].chatKey;
})(), () => ({ atoms: state.atoms }));

A('A3 判不出来的**仍可见**（Q3：登记为「升级前历史数据」并保留独立计数）：`legacy` 计数 + `plotScope` 读数字段说明，总数不变', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [
        ATOM('c1', { chatKey: 'chat-A' }),
        ATOM('c2', { title: '孤证', text: '丙在偏厅独自核对账簿，无人见证。' }),            // 内容独一份、无楼层指纹 → 判不出来
        ATOM('c3', { title: '别处', text: '乙在船上清点货物并登记入册。' }),                 // 同上
    ];
    const before = plotScopeSnapshot(st.atoms);
    const r = backfillChatScope(st, { chatKey: 'chat-A', hashFloor: hashFloorText });
    const after = plotScopeSnapshot(st.atoms);
    return r.filled === 0 && r.legacy === 2
        && before.total === 3 && after.total === 3                      // 不删一条
        && before.legacy === 2 && after.legacy === 2                    // 无法判定的仍可见
        && after.current === 1
        && String(after.legacyNote).indexOf('升级前历史数据') > 0;
})(), () => ({ snap: plotScopeSnapshot() }));

A('A4 **只补空值**：已有归属（含属于**别条聊天**的）一律不动；当前聊天键读不到 → 一个字段都不写', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [ATOM('d1', { chatKey: 'chat-B' }), ATOM('d2')];
    const r1 = backfillChatScope(st, { chatKey: 'chat-A' });
    const otherKept = String(st.atoms[0].chatKey) === 'chat-B' && r1.filled === 0;
    // 当前聊天标识读不到（宿主未注入）→ 判不出来就不改行为
    const st2 = boot();
    st2.chatKey = '';
    st2.atoms = [ATOM('d3', { chatKey: 'chat-A' }), ATOM('d4')];
    const r2 = backfillChatScope(st2, {});
    return otherKept && r2.skipped === 'no-chat-key' && r2.changed === false && r2.filled === 0
        && st2.atoms[1].chatKey === undefined;
})(), () => ({ atoms: state.atoms }));

A('A5 幂等：重复执行 → 第二次 `changed === false` / `filled === 0`，`chatKey` 值一字不变', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [ATOM('e1', { chatKey: 'chat-A' }), ATOM('e2')];
    const r1 = backfillChatScope(st, { chatKey: 'chat-A' });
    const snap = J(st.atoms);
    const r2 = backfillChatScope(st, { chatKey: 'chat-A' });
    return r1.changed === true && r1.filled === 1
        && r2.changed === false && r2.filled === 0 && r2.legacy === 0
        && J(st.atoms) === snap;
})(), () => ({ atoms: state.atoms }));

// ============================================================
// B 组：台账标记（`processedFloors` / `processedDropped`）
// ============================================================
A('B1 台账标记双命中：`h` 与注入解析器逐字相等 → 补 `ck`；指纹不符 / 无指纹 → 不补；**别条聊天的标记不动**', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.processedVer = processedVerTag();                                // 签名一致 → 不触发既有台账迁移（本用例只验归属判据）
    st.processedFloors = [
        { f: 2, h: hashFloorText(2) },                                  // 命中② → 补
        { f: 1, h: 'stale-hash' },                                      // 复核不过 → 不补
        { f: 3, h: hashFloorText(3), ck: 'chat-B', at: 5 },             // 别条聊天 → 不动
    ];
    st.processedDropped = [{ f: 4, h: hashFloorText(4) }];               // 命中② → 补
    const lhBefore = ledgerHealth();
    const r = backfillMarkScope(st, { chatKey: 'chat-A', hashFloor: hashFloorText });
    const lhAfter = ledgerHealth();
    return r.changed === true && r.filled === 2 && r.legacy === 1
        && String(st.processedFloors[0].ck) === 'chat-A'
        && !st.processedFloors[1].ck
        && String(st.processedFloors[2].ck) === 'chat-B'
        && String(st.processedDropped[0].ck) === 'chat-A'
        // 验收：`marksLegacyNoChat` 下降、**总数不变**（不删一条）
        && lhBefore.marks === 3 && lhAfter.marks === 3
        && lhBefore.marksLegacyNoChat === 2 && lhAfter.marksLegacyNoChat === 1
        && lhBefore.dropped === 1 && lhAfter.dropped === 1;
})(), () => ({ lh: ledgerHealth(), pf: state.processedFloors }));

A('B2 台账标记幂等 + 无当前聊天键时不写（与 A4 同纪律）', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.processedVer = processedVerTag();
    st.processedFloors = [{ f: 2, h: hashFloorText(2) }, { f: 1, h: 'stale-hash' }];
    const r1 = backfillMarkScope(st, { chatKey: 'chat-A', hashFloor: hashFloorText });
    const snap = J(st.processedFloors);
    const r2 = backfillMarkScope(st, { chatKey: 'chat-A', hashFloor: hashFloorText });
    const st2 = boot();
    st2.chatKey = '';
    st2.processedFloors = [{ f: 2, h: hashFloorText(2) }];
    const r3 = backfillMarkScope(st2, { chatKey: '', hashFloor: hashFloorText });
    return r1.filled === 1 && r2.changed === false && r2.filled === 0 && J(st.processedFloors) === snap
        && r3.skipped === 'no-chat-key' && st2.processedFloors[0].ck === undefined;
})(), () => ({ pf: state.processedFloors }));

// ============================================================
// C 组：载入期接线（`migrateState` 第 ⑩ 步）+ 自愈不再抹掉归属
// ============================================================
A('C1 载入期自愈接线：`migrateState` 一次跑完条目 + 标记的补写，`lastHealInfo()` 如实给出「补上的 / 仍判不出的」四个数', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    // 条目：一条靠楼层指纹命中；一条判不出来（保留 legacy）
    st.atoms = [
        ATOM('f1', { floorNowStart: 5, floorNowEnd: 5, floorNowHash: hashFloorText(5) }),
        ATOM('f2', { title: '别处', text: '乙在船上清点货物并登记入册。' }),
    ];
    st.processedFloors = [{ f: 2, h: hashFloorText(2) }, { f: 1, h: 'stale-hash' }];
    st.processedVer = '';                                   // 只触发一般迁移
    const out = migrateState(st);
    const hi = lastHealInfo() || {};
    const snap = plotScopeSnapshot(st.atoms);
    return String(st.atoms[0].chatKey) === 'chat-A' && st.atoms[1].chatKey === undefined
        && String(st.processedFloors[0].ck) === 'chat-A' && st.processedFloors[1].ck === undefined
        && hi.scope === 1 && hi.marks === 1 && hi.legacyScope === 1 && hi.legacyMarks === 1
        && snap.total === 2 && snap.legacy === 1 && out.atoms.length === 2;
})(), () => ({ hi: lastHealInfo(), atoms: state.atoms, pf: state.processedFloors }));

A('C2 自愈**不再抹掉** v3.40.0 写上的 `ck` / `at`：脏台账清洗只丢非法/重复项，归属与时刻原样保留', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.processedVer = processedVerTag();                    // 关掉既有台账迁移，只验本模块的自愈口径
    st.processedFloors = [
        { f: 2, h: 'h2', ck: 'chat-A', at: 123 },           // 归属 + 时刻
        { f: 3, h: 'h3' },                                   // legacy（无归属、无时刻）
        { f: 'x', h: 'bad' },                                // 非法楼层 → 丢弃（既有口径）
    ];
    st.processedDropped = [{ f: 4, h: 'h4', ck: 'chat-B', at: 9 }];
    const before = st.processedFloors.length + st.processedDropped.length;
    migrateState(st);
    const lh = ledgerHealth();
    return st.processedFloors.length === 2 && st.processedDropped.length === 1
        && st.processedFloors.length + st.processedDropped.length === before - 1   // 只丢非法那一条
        && String(st.processedFloors[0].ck) === 'chat-A' && Number(st.processedFloors[0].at) === 123
        && !st.processedFloors[1].ck && !st.processedFloors[1].at
        && String(st.processedDropped[0].ck) === 'chat-B' && Number(st.processedDropped[0].at) === 9
        // 修复前：每次载入把两者的 ck/at 整批抹掉 → `marksNoTimestamp` 会等于标记总数；现在只剩真正无时刻的那一条
        && lh.marks === 2 && lh.marksNoTimestamp === 1 && lh.marksLegacyNoChat === 1
        && lh.droppedNoTimestamp === 0;
})(), () => ({ pf: state.processedFloors, dropped: state.processedDropped, lh: ledgerHealth() }));

A('C3 汇总入口 `backfillChatAttribution` 只读不删：条目与标记一起收口，返回两部分独立计数', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [ATOM('g1', { chatKey: 'chat-A' }), ATOM('g2')];
    st.processedFloors = [{ f: 2, h: hashFloorText(2) }];
    const r = backfillChatAttribution(st, { hashFloor: hashFloorText });
    return r.changed === true && r.entries.filled === 1 && r.marks.filled === 1
        && st.atoms.length === 2 && st.processedFloors.length === 1
        && String(st.atoms[1].chatKey) === 'chat-A' && String(st.processedFloors[0].ck) === 'chat-A';
})(), () => ({ atoms: state.atoms, pf: state.processedFloors }));

A('C4 与既有内容哈希同源：补写归属**不改变**任何内容指纹（`chatKey` 刻意不在哈希字段表里）', (() => {
    const st = boot();
    st.chatKey = 'chat-A';
    st.atoms = [ATOM('h1', { chatKey: 'chat-A' }), ATOM('h2')];
    const before = atomContentHash('atoms', st.atoms[1]);
    backfillChatScope(st, { chatKey: 'chat-A' });
    const after = atomContentHash('atoms', st.atoms[1]);
    return before === after && before.length > 2 && contentFingerprintOf('atoms', st.atoms[1]) === before;
})(), '见断言');

R.done();
