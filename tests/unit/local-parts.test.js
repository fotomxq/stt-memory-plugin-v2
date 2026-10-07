// ============================================================
// 单元测试 · v3.32.0 快照 / 日志的**结构化拆分**（避免单一文件聚合）
//
// 用户要求（原话）：「本地存储的快照，也需要拆分结构化存储，避免单一文件聚合。日志文件也需要拆开做存储。」
//
// 口径（`adapters/local-parts.js`，纯函数）：
//   · 快照：一条一个文件 `snapshots/<id>.json` + `snapshots/manifest.json`（链顺序 + 逐条 hash/bytes/n/ts）；
//   · 日志：**按天分片** `logs/<kind>-<YYYY-MM-DD>[-n].json` + `logs/manifest.json`（各片 hash/bytes/条数/时间范围）；
//   · 合并：按 manifest 顺序还原；**坏一片只报那一片**（其余仍可用）。
//
// 运行：node tests/unit/local-parts.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { recoverSnapParts } from '../../index.js';
import {
    LOCAL_PARTS_V, SNAP_DIR, LOG_DIR, safePartName, snapPartFileName, logPartFileName, dayKeyOf,
    snapshotParts, joinSnapshotParts, logParts, joinLogParts,
} from '../../adapters/local-parts.js';

const R = makeReporter('local-parts v3.32.0 快照 / 日志结构化拆分');
const A = (n, c) => R.assert(n, c === true, '');
const J = (v) => JSON.stringify(v);

const SNAPS = [
    { id: 'root_1', kind: 'root', ts: '2026-10-07T01:00:00.000Z', atomsHashes: { a1: 'h1', a2: 'h2' }, atoms: [{ id: 'a1' }], deleted: {} },
    { id: 'incr_2', kind: 'incr', ts: '2026-10-07T02:00:00.000Z', atomsHashes: { a2: 'h2b' } },
    { id: 'incr_3', kind: 'incr', ts: '2026-10-07T03:00:00.000Z', atomsHashes: { a3: 'h3' } },
];
const at = (day, h) => new Date(day + 'T' + h + ':00:00').getTime();
const LOGS = [];
for (let i = 0; i < 7; i++) LOGS.push({ at: at('2026-10-06', '10') + i, kind: 'k', data: 'd' + i });
for (let i = 0; i < 3; i++) LOGS.push({ at: at('2026-10-07', '09') + i, kind: 'k', data: 'x' + i });

A('A1 快照拆分：**一条一个文件** + 清单（链顺序 / 逐条 hash·bytes·n），不再聚合成单一文件', (() => {
    const r = snapshotParts(SNAPS);
    const names = Object.keys(r.files);
    const mf = r.manifest;
    return r.ok === true && names.length === 3
        && names.indexOf('root_1.json') >= 0 && names.indexOf('incr_2.json') >= 0
        && mf.v === LOCAL_PARTS_V && mf.dir === SNAP_DIR && mf.count === 3
        && J(mf.order) === J(['root_1.json', 'incr_2.json', 'incr_3.json'])
        && mf.parts['root_1.json'].n === 2 && Number(mf.parts['root_1.json'].bytes) > 0
        && String(mf.parts['incr_2.json'].hash).length > 2
        && r.files['incr_3.json'] === JSON.stringify(SNAPS[2]);
})(), '');

A('A2 快照合并：按清单顺序还原**逐字一致**；删掉一片 → 只报那一片（其余仍在）', (() => {
    const r = snapshotParts(SNAPS);
    const back = joinSnapshotParts(r.manifest, r.files);
    const files2 = Object.assign({}, r.files); delete files2['incr_2.json'];
    const partial = joinSnapshotParts(r.manifest, files2);
    const files3 = Object.assign({}, r.files); files3['incr_3.json'] = '[{"id":"被改过"}]';
    const broken = joinSnapshotParts(r.manifest, files3);
    return back.ok === true && J(back.snapStore) === J(SNAPS) && back.bad.length === 0
        && partial.ok === false && J(partial.bad) === J(['incr_2.json']) && partial.snapStore.length === 2
        && broken.ok === false && J(broken.bad) === J(['incr_3.json']);
})(), '');

A('A3 日志拆分：**按天分片**（不同日期不同文件），逐片记条数与时间范围', (() => {
    const r = logParts(LOGS, 'debug', { cap: 500 });
    const names = Object.keys(r.files);
    const mf = r.manifest;
    return r.ok === true && names.length === 2
        && names.indexOf('debug-2026-10-06.json') >= 0 && names.indexOf('debug-2026-10-07.json') >= 0
        && mf.dir === LOG_DIR && mf.kind === 'debug' && mf.count === 10
        && mf.parts['debug-2026-10-06.json'].n === 7 && mf.parts['debug-2026-10-07.json'].n === 3
        && Number(mf.parts['debug-2026-10-06.json'].from) > 0 && Number(mf.parts['debug-2026-10-06.json'].to) >= Number(mf.parts['debug-2026-10-06.json'].from);
})(), '');

A('A4 日志超限再切：单片条数超过 `cap` → 同一天多片（`-2`、`-3`…），清单逐片可核', (() => {
    const r = logParts(LOGS, 'sync', { cap: 3 });
    const names = Object.keys(r.files);
    const day06 = names.filter((x) => x.indexOf('sync-2026-10-06') === 0);
    const back = joinLogParts(r.manifest, r.files);
    return r.ok === true && day06.length === 3                                  // 7 条 / 每片 3 → 3 片
        && names.indexOf('sync-2026-10-06-2.json') >= 0 && names.indexOf('sync-2026-10-06-3.json') >= 0
        && back.ok === true && back.entries.length === 10
        && back.entries[0].data === 'd0' && back.entries[back.entries.length - 1].data === 'x2';
})(), '');

A('A5 命名与按天键：文件名安全化（非法字符转 `_`）；`dayKeyOf` 非法时间 → `unknown`', (() => {
    return safePartName('a/b:c*d') === 'a_b_c_d' && safePartName('') === 'part'
        && snapPartFileName('root_1') === 'root_1.json'
        && logPartFileName('debug', '2026-10-07') === 'debug-2026-10-07.json'
        && dayKeyOf(at('2026-10-07', '09')) === '2026-10-07'
        && dayKeyOf(0) === 'unknown' && dayKeyOf('x') === 'unknown';
})(), '');

A('A6 空 / 坏输入安全：空快照链 → 空清单（不抛）；非数组日志 → 空分片', (() => {
    const s = snapshotParts(null);
    const s2 = snapshotParts([]);
    const l = logParts(null, 'debug');
    const l2 = logParts('not-array', 'debug');
    return s.ok === true && Object.keys(s.files).length === 0 && s.manifest.count === 0
        && s2.ok === true && Object.keys(s2.files).length === 0
        && l.ok === true && l.manifest.count === 0 && l2.ok === true && Object.keys(l2.files).length === 0
        && joinSnapshotParts(null, null).snapStore.length === 0 && joinLogParts(null, null).entries.length === 0;
})(), '');

// ------------------------------------------------------------
// v3.32.0：载入侧「**只补不覆盖**」——快照链为空时才用分片复原，绝不清空既有链
cfg.storage = Object.assign({}, cfg.storage, { localDiskDir: '' });   // 不配磁盘目录 → 分片读只会 `off`
const keep = { updatedAt: 1, snapStore: [{ id: 's1', data: {} }] };
const empty = { updatedAt: 1, snapStore: [] };
const r1 = await recoverSnapParts(null);
const r2 = await recoverSnapParts(keep);
const r3 = await recoverSnapParts(empty);
A('A7 载入兜底口径：非对象原样返回；**链非空则一字不动**；分片不可用时如实保留空链（绝不凭空造数据）', (() => {
    return r1 === null && r2 === keep && J(r2.snapStore) === J([{ id: 's1', data: {} }])
        && r3 === empty && J(r3.snapStore) === J([]);
})(), '');

R.done();
