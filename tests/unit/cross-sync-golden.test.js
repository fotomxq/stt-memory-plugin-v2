// ============================================================
// 单元测试 · B7-2 跨端同步内核（与**真实 V1 插件**逐项比对）
// 黄金样本：tests/fixtures/v1-golden-sync.json（oracle = 真实 V1 插件 v1.206，由 tests/unit/helpers.js loadPlugin 加载）
// 覆盖：dataAggHash / diffAtomData / mergeDataObjects / mergeSnapshotStores / snapshotIndexFrom（snapIndexFrom）/
//   mirrorPushSig / syncLogRecordKey / syncLogMerge / syncLogStat / syncLogSource / 同步日志环形入队。
// 说明：V1 的 `latestFloorFingerprint` 把「楼层正文」传给只接受楼层号的 `hashFloorText`（实际比对一个无关哈希），
//   V2 按 V1 **注释所述语义**（楼层号 + 正文稳定哈希）实现 —— 该偏差在 sync-adapter.test.js 中单独断言并注释。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    atomEntryCount, dataAggHash, diffAtomData, mergeDataObjects, mergeSnapshotStores,
    snapshotSigOf, snapIndexFrom, mirrorPushSig,
} from '../../core/cross-sync.js';
import {
    SYNC_LOG_MAX, syncLogRecordKey, syncLogMerge, syncLogPushRecord, syncLogStat, syncLogShortHash, syncLogSource,
} from '../../core/sync-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-sync.json'), 'utf8'));
const R = makeReporter('cross-sync-golden B7-2 跨端同步内核（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 与 oracle 相同的合并结果结构指纹 */
const fp = (d) => ({
    atoms: (d.atoms || []).map(x => x.id + ':' + x.text).sort(),
    items: (d.items || []).map(x => x.id + ':' + x.name).sort(),
    plans: (d.plans || []).map(x => x.id + ':' + x.text).sort(),
    processedFloors: (d.processedFloors || []).map(x => x.f + ':' + x.h),
    deletedAtoms: Object.keys((d.deleted || {}).atoms || {}).sort(),
    vars: d.vars, summaries: (d.summaries || []).length,
    currencies: clone(d.currencies || []), updatedAt: d.updatedAt,
});

R.assert('S1 聚合指纹 dataAggHash：本地/远端与真实 V1 插件逐字符一致', (() => {
    return dataAggHash(clone(G.local)) === G.localAgg && dataAggHash(clone(G.remote)) === G.remoteAgg;
})(), { gotL: dataAggHash(clone(G.local)), wantL: G.localAgg });

R.assert('S2 差异统计 diffAtomData：same/onlyLocal/onlyRemote/conflict(+胜负) 与 V1 一致', (() => {
    return J(diffAtomData(clone(G.local), clone(G.remote))) === J(G.diff);
})(), { got: diffAtomData(clone(G.local), clone(G.remote)), want: G.diff });

R.assert('S3 合并统计 mergeDataObjects：added/conflictWinLocal/conflictWinRemote/same 与 V1 一致', (() => {
    const r = mergeDataObjects(clone(G.local), clone(G.remote));
    return J(r.stat) === J(G.mergeStat);
})(), (() => { const r = mergeDataObjects(clone(G.local), clone(G.remote)); return { got: r.stat, want: G.mergeStat }; })());

// 已处理楼层并集的判据是「该楼层当前正文哈希」——V1 直接调 hashFloorText（宿主），V2 由调用方注入同值解析器
const hashFloor = (i) => (Number(i) === 3 ? G.floorHash3 : '');

R.assert('S4 合并结果：结构指纹（原子/物品/计划/已处理楼层/墓碑/变量/摘要/货币/updatedAt）+ 聚合哈希与 V1 一致', (() => {
    const r = mergeDataObjects(clone(G.local), clone(G.remote), { hashFloor });
    return J(fp(r.data)) === J(G.merged) && dataAggHash(r.data) === G.mergedAgg;
})(), (() => { const r = mergeDataObjects(clone(G.local), clone(G.remote), { hashFloor }); return { got: fp(r.data), want: G.merged, gotAgg: dataAggHash(r.data), wantAgg: G.mergedAgg }; })());

R.assert('S4b 已处理楼层并集：无楼层哈希解析器时退回 V1 的「保留本地」分支（同楼层哈希不一致 → 本地）', (() => {
    const r = mergeDataObjects(clone(G.local), clone(G.remote));
    const f3 = (r.data.processedFloors || []).find((x) => x.f === 3);
    const f2 = (r.data.processedFloors || []).find((x) => x.f === 2);
    return !!f3 && f3.h === 'local-h3' && !!f2 && f2.h === 'h2' && (r.data.processedFloors || []).length === 3;
})(), (() => { const r = mergeDataObjects(clone(G.local), clone(G.remote)); return r.data.processedFloors; })());

R.assert('S5 快照链并集 mergeSnapshotStores：按 atomsHashes 去重 + ts 升序，结果与 V1 一致', (() => {
    const got = mergeSnapshotStores(clone(G.snapA), clone(G.snapB)).map(s => s.id);
    return J(got) === J(G.snapUnion);
})(), { got: mergeSnapshotStores(clone(G.snapA), clone(G.snapB)).map(s => s.id), want: G.snapUnion });

R.assert('S6 轻量快照索引 snapIndexFrom：id/kind/ts/baseId/hash/covered 与 V1 一致', (() => {
    const got = snapIndexFrom(clone(G.snapA).concat(clone(G.snapB)));
    return J(got) === J(G.snapIndex);
})(), { got: snapIndexFrom(clone(G.snapA).concat(clone(G.snapB))), want: G.snapIndex });

R.assert('S7 快照链签名 snapshotSigOf：id+ts 变化即变、空链稳定（未变化不重复上传的判据）', (() => {
    const a = snapshotSigOf(clone(G.snapA));
    const b = snapshotSigOf(clone(G.snapA));
    const c = snapshotSigOf(clone(G.snapB));
    const d = snapshotSigOf([]);
    return a === b && a !== c && d === snapshotSigOf([]) && snapIndexFrom([]).length === 0;
})(), { a: snapshotSigOf(clone(G.snapA)), c: snapshotSigOf(clone(G.snapB)) });

R.assert('S8 镜像推送签名 mirrorPushSig：快照链变化 → 变；仅 updatedAt 变化 → 不变（V1 同口径）', (() => {
    const st = Object.assign(clone(G.local), { snapStore: clone(G.snapA), stats: { plansClosed: 1 } });
    const s1 = mirrorPushSig(st);
    const st2 = clone(st); st2.snapStore = clone(G.snapA).concat(clone(G.snapB));
    const s2 = mirrorPushSig(st2);
    const st3 = clone(st2); st3.updatedAt = 999999;
    return s1 !== s2 && mirrorPushSig(st3) === s2 && String(s1).length === G.mirrorPush.len;
})(), '');

R.assert('S9 同步日志记录指纹 syncLogRecordKey：与 V1 逐字符一致（服务端合并去重的键）', (() => {
    return syncLogRecordKey(G.logRec) === G.logKey;
})(), { got: syncLogRecordKey(G.logRec), want: G.logKey });

R.assert('S10 同步日志应用并集合并 syncLogMerge：去重 + ts 新→旧 + 上限，与 V1 顺序一致', (() => {
    const got = syncLogMerge(clone(G.logA), clone(G.logB), SYNC_LOG_MAX).map(r => r.ts + ':' + r.src + ':' + r.mode);
    return J(got) === J(G.logMerge) && syncLogMerge(clone(G.logA), clone(G.logB), SYNC_LOG_MAX).length === G.logMergeCap;
})(), { got: syncLogMerge(clone(G.logA), clone(G.logB), SYNC_LOG_MAX).map(r => r.ts + ':' + r.src + ':' + r.mode), want: G.logMerge });

R.assert('S11 同步日志统计 syncLogStat：条目数（原子合计）+ 数据字节与 V1 一致', (() => {
    return J(syncLogStat(clone(G.local))) === J(G.logStat);
})(), { got: syncLogStat(clone(G.local)), want: G.logStat });

R.assert('S12 本端源头 syncLogSource：设备·浏览器(短码)·平台与 V1 对同一 navigator 的结果一致', (() => {
    const nav = G.nav || {};
    return syncLogSource(nav) === G.logSource && syncLogSource({}) === '测试/非浏览器环境';
})(), { got: syncLogSource(G.nav || {}), want: G.logSource });

R.assert('S13 同步日志环形入队 syncLogPushRecord：头部插入 + 自动 ts/src + 上限 30（新→旧）', (() => {
    let list = [];
    for (let i = 1; i <= 35; i++) list = syncLogPushRecord(list, { action: 'a' + i }, { src: 'X' });
    const head = list[0];
    return list.length === SYNC_LOG_MAX && head.action === 'a35' && head.src === 'X' && Number(head.ts) > 0
        && list[SYNC_LOG_MAX - 1].action === 'a6';
})(), (() => { let list = []; for (let i = 1; i <= 35; i++) list = syncLogPushRecord(list, { action: 'a' + i }, { src: 'X' }); return { n: list.length, head: list[0] && list[0].action, tail: list[list.length - 1] && list[list.length - 1].action }; })());

R.assert('S14 短哈希展示 syncLogShortHash / 条目计数 atomEntryCount：V1 口径（前 12 位；原子合计）', (() => {
    return syncLogShortHash('0123456789abcdef') === '0123456789ab'
        && syncLogShortHash('') === ''
        && atomEntryCount(clone(G.local)) === G.logStat.n;
})(), { n: atomEntryCount(clone(G.local)), want: G.logStat.n });

R.done();
