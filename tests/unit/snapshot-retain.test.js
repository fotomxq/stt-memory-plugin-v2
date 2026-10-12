// ============================================================
// 单元测试 · v3.46.0（`docs/D22` W9 `数-32` / `docs/D17` U189）：
//   **快照链保留窗** —— 超窗增量在整理时**并入根快照**（档位变少、**内容一个字节不丢**），窗内增量不动。
//
// 用户要求（原话）：「新版本，v3.46.0 / 开发待处理的W9」
// 设计依据：`docs/D28` §3.3.2 #7（快照链真增量 + 合并 + **回收窗**）与 §8 `数-32`：
//   ① 快照链：真增量 + 合并 + **保留窗**；④ 每步补「载入 / 回滚结果等价」的对照用例；⑤ 在 UI 如实说明可回滚范围与保留窗。
//   **语义红线**（`docs/D28` §1.1 与 §3.2 A 案）：**语义数据一条不删** —— 保留窗只并掉"独立档位"，
//   被并的增量内容全部进根，`atomsHashes` 并集逐键不变（本档 A3 用等价断言锁死）。
//
// 运行：node tests/unit/snapshot-retain.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SNAP_CAP, SNAP_RETAIN_DAYS, snapshotConsolidate } from '../../core/snapshots.js';
import { snapshotSectionHtml } from '../../ui/snapshots.js';

const R = makeReporter('snapshot-retain v3.46.0 W9 数-32（快照链保留窗：档位变少 · 内容不丢）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

const DAY = 24 * 3600 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

/** 造一条快照（结构同 `core/snapshots.js`：`{id, kind, ts, baseId, hash, atomsHashes, atoms}`） */
function mkSnap(id, kind, daysAgo, hashes) {
    return { id: id, kind: kind, ts: iso(daysAgo), baseId: kind === 'root' ? null : 'root_1', hash: 'h_' + id, atomsHashes: clone(hashes), atoms: {} };
}
/** 所有快照的 `atomsHashes` **并集**（= 链覆盖到的原子集合；等价性就看它） */
function unionHashes(list) {
    const out = {};
    for (const s of (list || [])) for (const id in (s.atomsHashes || {})) out[id] = s.atomsHashes[id];
    return out;
}
function bootWith(snaps) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:retain');
    const st = emptyState();
    st.snapStore = snaps;
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}

A('A1 常量与 UI 说明：`SNAP_RETAIN_DAYS` = 30（保留窗由内核常量给出）；快照区块**如实写明可回滚范围**（含「并入根：档位变少，内容不丢」）', (() => {
    bootWith([mkSnap('root_1', 'root', 1, { a: '1' })]);        // 渲染统计行需要内核态（否则 state 为 null）
    const html = String(snapshotSectionHtml() || '');
    return SNAP_RETAIN_DAYS === 30 && SNAP_CAP === 30
        && html.indexOf('可回滚范围') >= 0 && html.indexOf('最近 30 天') >= 0
        && html.indexOf('并入根') >= 0 && html.indexOf('内容不丢') >= 0;
})(), (() => { try { bootWith([mkSnap('root_1', 'root', 1, { a: '1' })]); return String(snapshotSectionHtml()).slice(0, 220); } catch (e) { return String(e.message); } })());

A('A2 超窗增量**并入根**（档位消失、计数如实回报 `aged`）；窗内增量**原样保留**（不误伤）', (() => {
    const st = bootWith([
        mkSnap('root_1', 'root', 60, { a1: 'h1', a2: 'h2' }),
        mkSnap('incr_old', 'incr', 45, { a3: 'h3' }),        // 超窗（> 30 天）
        mkSnap('incr_old2', 'incr', 40, { a4: 'h4' }),       // 超窗
        mkSnap('incr_new', 'incr', 2, { a5: 'h5' }),         // 窗内
    ]);
    const before = unionHashes(st.snapStore);
    const res = snapshotConsolidate();
    const ids = st.snapStore.map((s) => s.id);
    const root = st.snapStore.filter((s) => s.kind === 'root')[0] || {};
    const after = unionHashes(st.snapStore);
    return res.aged === 2 && res.roots === 1
        && ids.indexOf('incr_old') < 0 && ids.indexOf('incr_old2') < 0 && ids.indexOf('incr_new') >= 0
        && root.atomsHashes && root.atomsHashes.a3 === 'h3' && root.atomsHashes.a4 === 'h4'   // **内容进了根**
        && J(after) === J(before);                                                            // **并集逐键不变**
})(), (() => J({ ids: state.snapStore.map((s) => s.id), aged: (state.snapStore || []).length }))());

A('A3 **等价性（红线）**：保留窗前后的 `atomsHashes` 并集**逐键相同** —— 语义内容一个字节不丢（只并掉档位）', (() => {
    const st = bootWith([
        mkSnap('root_1', 'root', 90, { x: 'hx' }),
        mkSnap('i1', 'incr', 80, { y: 'hy' }),
        mkSnap('i2', 'incr', 70, { z: 'hz' }),
    ]);
    const before = clone(unionHashes(st.snapStore));
    const res = snapshotConsolidate();
    const after = unionHashes(st.snapStore);
    return res.aged === 2 && J(before) === J(after)
        && Object.keys(after).sort().join(',') === 'x,y,z';
})(), '');

A('A4 全窗内（都很新）→ **不动**：`aged === 0`、链长不变（保留窗不是"清空快照"）', (() => {
    const st = bootWith([
        mkSnap('root_1', 'root', 10, { a: '1' }),
        mkSnap('i1', 'incr', 5, { b: '2' }),
        mkSnap('i2', 'incr', 1, { c: '3' }),
    ]);
    const res = snapshotConsolidate();
    return res.aged === 0 && st.snapStore.length === 3 && res.folded === 0;
})(), (() => J(state.snapStore.map((s) => s.id)))());

A('A5 超上限仍按既有 R2 口径合并（保留窗与总量整理**互不代替**）：31 条新快照 → `folded > 0` 且总数降到 ≤ `SNAP_CAP`', (() => {
    const many = [mkSnap('root_1', 'root', 5, { r: '0' })];
    for (let i = 0; i < 30; i++) many.push(mkSnap('i' + i, 'incr', 4, { ['k' + i]: 'h' + i }));
    const st = bootWith(many);
    const res = snapshotConsolidate();
    return res.aged === 0 && res.folded > 0 && st.snapStore.length <= SNAP_CAP && res.roots === 1;
})(), (() => J({ len: state.snapStore.length, folded: (state.snapStore || []).length }))());

R.done();
