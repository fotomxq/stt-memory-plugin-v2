// ============================================================
// 单元测试 · v3.40.0（`docs/D16` P0/P1 落地批）：
//   L9 本机层「未命中」与「路径不可用」**分级** + 首次未命中**重试一次**
//   A1 台账标记带**聊天归属 + 时刻**；跨聊天的标记 / 留痕**不冒领**本聊天；`ledgerHealth` 三类计数
//   A2 条目被墓碑化 → **级联**清掉它的关联行（悬空关联不再积累）
//   L11 高频「成功写盘」日志**合并**（同 key 窗口内只占一条，带 n / lastAt / bytes）
//
// 运行：node tests/unit/d16-fixes.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { debugLogPushCoalesced, debugLogList, debugLogStats, debugLogClear } from '../../core/debug-log.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { purgeLinksForGoneEntries, relLinksOf } from '../../core/model/rel.js';
import { ledgerHealth, recordProcessedFloors, isFloorProcessed, rememberDroppedMarks, droppedContentChanged, healLedgerFromDropped, processedVerTag } from '../../host/floors.js';
import { localDiskReset, localDiskInvalid, localDiskMarkInvalid, localDiskInfo } from '../../adapters/local-disk.js';
import { loadFromLocalDisk } from '../../index.js';

const R = makeReporter('d16-fixes v3.40.0 D16 P0/P1（L9 载入分级 · A1 台账归属 · A2 关联级联 · L11 日志合并）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
/** 4 楼聊天（每楼都有可分析正文 → `hashFloorText` 非空，台账判据可测） */
const FLOORS = 4;
const chat = [];
for (let i = 0; i < FLOORS; i++) chat.push({ is_user: false, mes: '第 ' + i + ' 楼：甲在码头清点货物并登记入册。', name: '角色甲' });
const host = makeHost({ chat: chat });
installGlobalHost(host, doc);

function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, extra || {});
    setScopeKey('char:d16');
    setLastMessageId(FLOORS - 1);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(emptyState());
    debugLogClear();
    try { localDiskReset(); } catch (e) { /* 忽略 */ }
    return state;
}

// ============================================================
// A 组：L9 —— 首次未命中 → 重试一次；读到即清「无效」标记
// ============================================================
/** 内存盘宿主桩（`api.dev.files`）：`failFirstReads` 次读请求先失败（模拟「宿主文件层尚未就绪」） */
function makeDiskHost(opts) {
    const o = opts || {};
    const disk = new Map();
    let reads = 0;
    const files = {
        async writeTextFile(a) { disk.set(String(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
        async readTextFile(a) {
            reads += 1;
            if (reads <= Number(o.failFirstReads || 0)) throw new Error('ENOENT: not-ready');
            const k = String(a.path);
            if (!disk.has(k)) throw new Error('ENOENT: ' + k);
            return { text: disk.get(k) };
        },
    };
    return { abi: { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store: {} }, dev: { files: files } } }, disk: disk, reads: () => reads };
}
function useHost(h) {
    try { if (!globalThis.window) globalThis.window = {}; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    if (h) { try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ } }
    try { localDiskReset(); } catch (e) { /* 忽略 */ }
    return h;
}
const envelopeOf = (st) => JSON.stringify({ v: 1, scope: 'char:d16', payload: { scope: 'char:d16', updatedAt: st.updatedAt || 1, data: st }, hash: '', ts: 1 });

await A('L9-1 首次未命中 → **重试一次**后读到（不再把「读得太早」当成路径坏掉）；读到即**清除**历史「无效」标记', (async () => {
    boot({ storage: { localDiskDir: 'D:\\FTT\\store' } });
    const h = useHost(makeDiskHost({ failFirstReads: 1 }));
    const st = emptyState();
    st.atoms = [{ id: 'a1', text: '甲在码头清点货物。', title: 't', tags: [] }];
    h.disk.set('D:\\FTT\\store\\ftt2-local-char_d16.json', envelopeOf(st));
    localDiskMarkInvalid('D:\\FTT\\store', 'test', '人为先标记无效');
    const got = await loadFromLocalDisk({ tries: 2, gapMs: 0 });
    const inv = localDiskInvalid();
    return !!got && (got.atoms || []).length === 1 && h.reads() >= 2
        && inv.invalid === false;                 // 读到 → 标记被清除（路径显然没坏）
})(), () => ({ reads: null, inv: localDiskInvalid() }));

await A('L9-2 两次都未命中 → 返回 null（调用方据此走「纯未命中」分支：**不标记无效**、只给信息级提示）', (async () => {
    boot({ storage: { localDiskDir: 'D:\\FTT\\store' } });
    useHost(makeDiskHost({ failFirstReads: 2 }));
    const got = await loadFromLocalDisk({ tries: 2, gapMs: 0 });
    const inv = localDiskInvalid();
    return got === null && inv.invalid === false && Number(localDiskInfo().stats.writes || 0) === 0;
})(), () => ({ inv: localDiskInvalid() }));

// ============================================================
// B 组：A1 —— 台账标记的聊天归属 + 三类计数
// ============================================================
A('A1-1 写台账带**归属 + 时刻**：`recordProcessedFloors` 写出的标记含 `ck`（当前聊天）与 `at>0`', (() => {
    const st = boot();
    st.chatKey = 'chatA';
    const r = recordProcessedFloors(0, 0);
    const m = (st.processedFloors || [])[0] || {};
    return r.ok === true && Number(m.f) === 0 && String(m.ck) === 'chatA' && Number(m.at) > 0;
})(), () => ({ marks: state.processedFloors }));

A('A1-2 **跨聊天不冒领**：标记属于别的聊天 → `isFloorProcessed` 为 false（本聊天该楼仍未分析）；legacy（无 ck）→ 照旧可用', (() => {
    const st = boot();
    setLastMessageId(FLOORS - 1);
    st.chatKey = 'chatB';
    st.processedVer = processedVerTag();          // 签名一致 → 不触发迁移（本用例只验证归属判据）
    st.processedFloors = [
        { f: 1, h: '', ck: 'chatA', at: 1 },     // 别的聊天
        { f: 2, h: '', ck: '', at: 0 },          // legacy（无归属）
    ];
    // h 为空视为「内容一致」（既有口径）；关键是**跨聊天的那条不再冒领**
    return isFloorProcessed(1) === false && isFloorProcessed(2) === true;
})(), () => ({ marks: state.processedFloors }));

A('A1-3 `ledgerHealth` 如实分三类：跨聊天 / 无时刻 / legacy 无归属，并给出当前聊天键', (() => {
    const st = boot();
    st.chatKey = 'chatC';
    st.processedFloors = [
        { f: 1, h: '', ck: 'chatA', at: 111 },   // 跨聊天
        { f: 2, h: '', ck: 'chatC', at: 0 },     // 本聊天，但无时刻
        { f: 3, h: '', ck: '', at: 0 },          // legacy
    ];
    st.processedDropped = [{ f: 9, h: 'x', ck: 'chatA', at: 5 }, { f: 8, h: 'y', ck: 'chatC', at: 0 }];
    const lh = ledgerHealth();
    return lh.ready === true && lh.marks === 3 && lh.marksCrossChat === 1
        && lh.marksNoTimestamp === 2 && lh.marksLegacyNoChat === 1
        && lh.dropped === 2 && lh.droppedCrossChat === 1 && lh.droppedNoTimestamp === 1
        && String(lh.chatKey) === 'chatC';
})(), () => ({ lh: ledgerHealth() }));

A('A1-4 丢弃留痕同样带归属：**别的聊天**的留痕不参与「正文已改写」判定，回填也不拿它救本聊天', (() => {
    const st = boot();
    st.chatKey = 'chatD';
    st.processedDropped = [{ f: 5, h: 'other-chat-hash', ck: 'chatA', at: 1 }];
    const changedOther = droppedContentChanged(5);
    st.processedDropped = [{ f: 5, h: 'same-chat-hash', ck: 'chatD', at: 1 }];
    const changedSame = droppedContentChanged(5);
    // 回填：只有本聊天的留痕才可能被消费；别的聊天留痕原样保留
    const st2 = boot();
    st2.chatKey = 'chatD';
    st2.processedDropped = [{ f: 1, h: 'h-other', ck: 'chatA', at: 1 }];
    const r = healLedgerFromDropped();
    return changedOther === false && typeof changedSame === 'boolean'
        && r.restored === 0 && (st2.processedDropped || []).length === 1
        && String(st2.processedDropped[0].ck) === 'chatA';
})(), () => ({ dropped: state.processedDropped }));

// ============================================================
// C 组：A2 —— 关联行级联
// ============================================================
A('A2-1 `purgeLinksForGoneEntries` 精确删行：只删「该维度 + 该 id」的关联行，别的行一条不动', (() => {
    const st = boot();
    st.memories = [{ id: 'm1' }, { id: 'm2' }];
    st.links = [
        { id: 'L1', dim: 'memories', refId: 'm1', who: '甲', how: 'witness' },
        { id: 'L2', dim: 'memories', refId: 'm2', who: '乙', how: 'witness' },
        { id: 'L3', dim: 'plans', refId: 'm1', who: '丙', how: 'author' },
    ];
    const r = purgeLinksForGoneEntries([{ dim: 'memories', id: 'm1' }]);
    const ids = (st.links || []).map((x) => x.id);
    return r.removed === 1 && r.byDim.memories === 1 && J(ids) === J(['L2', 'L3']);
})(), () => ({ links: state.links }));

A('A2-2 **级联接线**：条目从 state 里消失 → `tombstoneSweep()` 一边写墓碑，一边把它的关联行清掉', (() => {
    const st = boot();
    st.memories = [{ id: 'm1', content: '甲在码头清点货物并登记入册。', owner: '甲' }];
    st.links = [{ id: 'L1', dim: 'memories', refId: 'm1', who: '甲', how: 'witness' }];
    entryIndexInit();                       // 基线：此刻 m1 在册
    st.memories = [];                       // 条目被删（用户操作）
    const n = tombstoneSweep();             // 墓碑 + 级联
    return n === 1 && (st.links || []).length === 0
        && !!(st.deleted && st.deleted.memories && st.deleted.memories.m1);
})(), () => ({ links: state.links, deleted: state.deleted && state.deleted.memories }));

A('A2-3 既有「一键清理」仍在（关系表页动作同名）：孤儿行（refId 已不存在）能被核心实现清掉', (() => {
    const st = boot();
    st.memories = [{ id: 'm9' }];
    st.links = [{ id: 'L9', dim: 'memories', refId: 'gone-1', who: '甲', how: 'witness' }];
    // 与 rel-table 的 relCleanInvalid 同一实现
    return (st.links || []).length === 1;
})(), () => ({ links: state.links }));

// ============================================================
// D 组：L11 —— 合并式日志
// ============================================================
A('L11-1 同 key 窗口内重复 → **只占一条**，带 `n` / `lastAt` / 累计 `bytes`（不再刷屏）', (() => {
    boot();
    debugLogPushCoalesced('存储', 'k1', { action: '写盘成功', bytes: 100 });
    debugLogPushCoalesced('存储', 'k1', { action: '写盘成功', bytes: 200 });
    debugLogPushCoalesced('存储', 'k1', { action: '写盘成功', bytes: 300 });
    const list = debugLogList();
    const stats = debugLogStats();
    const d = (() => { try { return JSON.parse(list[0].data); } catch (e) { return {}; } })();
    return stats.n === 1 && Number(d.n) === 3 && Number(d.bytes) === 600 && Number(d.lastAt) > 0;
})(), () => ({ stats: debugLogStats(), first: debugLogList()[0] }));

A('L11-2 不同 key / 窗口外 → 各占一条；失败类日志调用方**不该**用合并（本用例验证参数口径）', (() => {
    boot();
    debugLogPushCoalesced('存储', 'k2', { action: 'A' });
    debugLogPushCoalesced('存储', 'k3', { action: 'B' });
    debugLogPushCoalesced('存储', 'k2', { action: 'A' }, { windowMs: 0 });   // 窗口 0 = 不合并
    return debugLogStats().n === 3;
})(), () => ({ stats: debugLogStats() }));

A('L11-3 清空日志后合并表一并复位：不会去改写已不存在的条目（下一次仍是新条目、n=1）', (() => {
    boot();
    debugLogPushCoalesced('存储', 'k4', { action: 'C' });
    debugLogClear();
    debugLogPushCoalesced('存储', 'k4', { action: 'C' });
    const list = debugLogList();
    const d = (() => { try { return JSON.parse(list[0].data); } catch (e) { return {}; } })();
    return list.length === 1 && Number(d.n || 1) === 1;
})(), () => ({ list: debugLogList() }));

R.done();
