// ============================================================
// 单元测试 · v3.1.0「容量上限与配额兜底」（`docs/D13` S2/S3，用户要求「按建议改善性能」）
//
// 覆盖 D13 的 R1 / R2 与 Q4–Q7 的建议默认值：
//   A **向量缓存**：内存副本加 LRU 上限（2000 条 / 32MB，先到者为准），只淘汰内存副本、不动持久层；
//   B **关联层**：上限 = max(200, 条目数 × 2)，超出先淘汰孤儿行、再按最旧优先，且写删除墓碑；
//   C **本机缓冲预算**：写入前按字符数判预算 —— 超预算如实跳过（服务端文件与 IndexedDB 不受影响）并留痕；
//   D **调试日志**：单条上限 6000 → 2000（**有意偏离 V1**，见 `tests/unit/debug-log-golden.test.js` D0）
//     —— 直接决定本机缓冲能否被状态信封 + 日志一起装下。
//
// 运行：node tests/unit/perf-caps.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { DEBUG_DATA_MAX, debugLogPush, debugLogList, debugLogClear } from '../../core/debug-log.js';
import { capRelLinks } from '../../core/rel-maint.js';
import {
    setVectorCacheCaps, vecCachePutMany, vecCacheGetMany, vectorCacheStats, resetVectorCacheState,
    VEC_CACHE_MAX_ENTRIES, VEC_CACHE_MAX_BYTES,
} from '../../adapters/vector-cache.js';
import {
    saveStateNow, setStorageHooks, setLocalBufferMaxChars, localBufferState, storeStatus, LOCAL_BUFFER_MAX_CHARS,
} from '../../adapters/store.js';

const R = makeReporter('perf-caps v3.1.0 向量缓存 LRU / 关联层上限 / 本机缓冲预算 / 调试日志单条上限');
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'caps.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);
await import('../../index.js');

// 本机缓冲桩（可注入失败 / 统计写入次数）
const kv = new Map();
let writeFail = false;
setStorageHooks({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { if (writeFail) return false; kv.set(k, String(v)); return true; },
    removeItem: (k) => { kv.delete(k); return true; },
});
const files = new Map();
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') { const b = JSON.parse((opts && opts.body) || '{}'); files.set(String(b.name), Buffer.from(String(b.data || ''), 'base64').toString('utf8')); return { status: 200, text: 'ok' }; }
    const m = String(url).match(/^\/user\/files\/(.+)$/); if (m) { const n = decodeURIComponent(m[1]); return files.has(n) ? { status: 200, text: files.get(n) } : { status: 404, text: 'x' }; }
    return { status: 404, text: '' };
});

function boot(st) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('caps.png');
    setKernelState(st || emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    kv.clear(); files.clear();
    return state;
}
const mkAtoms = (n) => Array.from({ length: n }, (_, i) => ({ id: 'a-' + i, title: '情节' + i, text: '【' + i + '】甲在码头清点铜箱并记账（正文足够长，用于把信封推到预算之上）。'.repeat(3), date: '1919-11-01', tags: ['码头'], updatedAt: 1000 + i }));

// ==================== A 组：向量缓存 LRU ====================
await (async () => {
    resetVectorCacheState();
    setVectorCacheCaps({ entries: 3, bytes: 1e9 });
    const vec = (i) => new Array(4).fill(i);
    await vecCachePutMany([0, 1, 2, 3, 4].map((i) => ({ key: 'k' + i, vector: vec(i) })));
    const s1 = vectorCacheStats();
    // 命中回填 + LRU 刷新：读 k2（把它置为最新）后再写入 k5 → 淘汰最旧的 k3（而不是 k2）
    setVectorCacheCaps({ entries: 3, bytes: 1e9 });
    await vecCachePutMany([{ key: 'k3', vector: vec(3) }, { key: 'k4', vector: vec(4) }, { key: 'k2', vector: vec(2) }]);   // 顺序：k3,k4,k2
    await vecCacheGetMany(['k3']);                                                                                          // k3 置新 → 顺序 k4,k2,k3
    await vecCachePutMany([{ key: 'k6', vector: vec(6) }]);                                                                 // 超 1 条 → 淘汰最旧 k4
    const s2 = vectorCacheStats();
    const after = await vecCacheGetMany(['k4', 'k2', 'k3', 'k6']);
    // 字节上限单独生效（维度很大时按体积淘汰）
    resetVectorCacheState(); setVectorCacheCaps({ entries: 100, bytes: 300 });
    await vecCachePutMany([0, 1, 2, 3, 4].map((i) => ({ key: 'big' + i, vector: new Array(40).fill(i) })));   // 每条 64+320=384B
    const s3 = vectorCacheStats();
    resetVectorCacheState(); setVectorCacheCaps({ entries: VEC_CACHE_MAX_ENTRIES, bytes: VEC_CACHE_MAX_BYTES });
    R.assert('A1 向量缓存内存副本有 LRU 上限（`docs/D13` R2/Q4）：条目上限生效（超出淘汰最旧、命中会刷新顺序）· 字节上限单独生效（大维度按体积淘汰）· `evicted`/`bytes`/`maxEntries`/`maxBytes` 可观测 · 默认上限 = 2000 条 / 32MB',
        s1.memory === 3 && s1.evicted === 2 && s1.maxEntries === 3
        && s2.memory === 3 && s2.evicted === 3
        && after.size === 3 && after.has('k3') && after.has('k4') && after.has('k6') && !after.has('k2')   // 命中 k3 后它被置新 → 淘汰的是更旧的 k2
        && s3.memory <= 1 && VEC_CACHE_MAX_ENTRIES === 2000 && VEC_CACHE_MAX_BYTES === 32 * 1024 * 1024,
        J({ s1, s2, s3, hits: Array.from(after.keys()) }));
})();

// ==================== B 组：关联层上限 ====================
{
    const st = boot(emptyState());
    st.memories = Array.from({ length: 3 }, (_, i) => ({ id: 'm-' + i, owner: '甲', title: '记忆' + i, content: 'x', updatedAt: 1 }));
    st.plans = [{ id: 'pl-0', title: '计划', status: 'open', updatedAt: 1 }];
    st.suspense = [];
    // 默认上限 = max(200, 4 条 × 2) = 200 → 不超限
    st.links = Array.from({ length: 150 }, (_, i) => ({ dim: 'memories', refId: 'm-' + (i % 3), who: '角色' + i, how: 'witness' }));
    const r0 = capRelLinks(st, {});
    const under = st.links.length === 150 && r0.changed === false;
    // 超过 200 → 裁剪到 200（无孤儿 → 淘汰最旧的 50 行）
    st.links = Array.from({ length: 260 }, (_, i) => ({ id: 'L' + i, dim: 'memories', refId: 'm-' + (i % 3), who: '角色' + i, how: 'witness' }));
    st.deleted = {}; st.deletedH = {};
    const r1 = capRelLinks(st, {});
    const len1 = st.links.length;                       // 立即取长度（后续阶段会再次改动 links）
    const tailKept = st.links[0].who === '角色60' && st.links[st.links.length - 1].who === '角色259';
    const tombN = Object.keys((st.deleted || {}).links || {}).length;
    // 孤儿优先：混入 20 条指向不存在条目的行 → 先淘汰这 20 条（保留更多有效行）
    st.links = Array.from({ length: 210 }, (_, i) => ({ dim: 'memories', refId: 'm-' + (i % 3), who: '有效' + i, how: 'witness', id: 'L' + i }));
    for (let i = 0; i < 20; i++) st.links.push({ dim: 'memories', refId: 'missing-' + i, who: '孤儿' + i, how: 'witness', id: 'X' + i });
    st.deleted = {}; st.deletedH = {};
    const r2 = capRelLinks(st, {});
    const orphansGone = st.links.every((x) => String(x.refId).indexOf('missing-') !== 0) && st.links.length === 200;
    // dryRun 不改动
    st.links = Array.from({ length: 260 }, (_, i) => ({ dim: 'memories', refId: 'm-' + (i % 3), who: '角色' + i, how: 'witness' }));
    const r3 = capRelLinks(st, { dryRun: true });
    R.assert('B1 关联层容量上限（`docs/D13` R2/Q7）：上限 = `max(200, 条目数 × 2)`；不超限**零改动**；超出**先淘汰孤儿行**、再按最旧优先裁到上限；被淘汰行写删除墓碑（防跨端复活）；`dryRun` 只报告不改动',
        under && r1.changed === true && r1.dropped === 60 && len1 === 200 && tailKept && tombN === 60
        && r2.orphans === 20 && orphansGone
        && r3.changed === false && r3.dropped > 0 && st.links.length === 260,
        J({ under, r1: Object.assign({}, r1, { kept: len1 }), tombN, tailKept, r2, orphansGone, r3 }));
}

// ==================== C 组：本机缓冲预算 ====================
await (async () => {
    boot(emptyState());
    state.atoms = mkAtoms(60);
    const r1 = await saveStateNow({ reason: 'caps-budget-1', force: true });
    const wrote = kv.has('ftt2_state_' + scopeId()) && localBufferState().ok === true && String(r1.via).indexOf('localStorage') >= 0;
    const charsNow = localBufferState().chars;
    // 把预算压到当前信封之下 → **v3.26.2 起先试压缩留存**（用户报告「超预算 → 本次跳过」的那条报错）
    const before = kv.get('ftt2_state_' + scopeId());
    setLocalBufferMaxChars(Math.max(100, charsNow - 100));
    state.atoms[0].text = '改一条以触发真实写入（正文足够长）。'.repeat(6);
    const r2 = await saveStateNow({ reason: 'caps-budget-2', force: true });
    const st2 = localBufferState();
    const gzSavedOk = st2.ok === true && st2.gz === true && String(r2.via).indexOf('localStorage-gz') >= 0
        && kv.get('ftt2_state_' + scopeId()) !== before && String(kv.get('ftt2_state_' + scopeId())).indexOf('"ftt2gz":1') >= 0;
    // **压缩不可用**（如宿主没有 CompressionStream）→ 回到「如实跳过」的老口径（绝不静默）
    const keepCS = globalThis.CompressionStream;
    try { delete globalThis.CompressionStream; } catch (e) { globalThis.CompressionStream = undefined; }
    state.atoms[2].text = '再改一条（压缩不可用，将如实跳过）。'.repeat(6);
    const beforeSkip = kv.get('ftt2_state_' + scopeId());
    const r2b = await saveStateNow({ reason: 'caps-budget-2b', force: true });
    const st2b = localBufferState();
    const skippedOk = st2b.ok === false && st2b.skipped === 'over-budget' && st2b.chars > st2b.budget
        && String(r2b.via).indexOf('localStorage') < 0 && String(r2b.via).indexOf('file') >= 0
        && kv.get('ftt2_state_' + scopeId()) === beforeSkip;
    try { globalThis.CompressionStream = keepCS; } catch (e) { /* 忽略 */ }
    // 恢复预算 → 正常写入（并清掉「停滞标记」）
    setLocalBufferMaxChars(0);
    const r3 = await saveStateNow({ reason: 'caps-budget-3', force: true });
    const restored = localBufferState().ok === true && kv.get('ftt2_state_' + scopeId()) !== before;
    // 宿主拒绝写入（配额抛错）→ 也如实留痕（不再静默）
    writeFail = true;
    state.atoms[1].text = '再改一条（宿主将拒绝写入）。'.repeat(6);
    const r4 = await saveStateNow({ reason: 'caps-budget-4', force: true });
    writeFail = false;
    const st4 = localBufferState();
    const failOk = st4.ok === false && st4.skipped === 'write-failed' && String(r4.via).indexOf('localStorage') < 0;
    const status = storeStatus();
    R.assert('C1 本机缓冲字符预算（`docs/D13` R1/Q5）：正常写✅；**超预算先试压缩留存**（v3.26.2：写压缩记录、不丢本机层）；压缩不可用时**如实跳过**（服务端文件与 IndexedDB 不受影响、旧内容不被清空）并可在 `localBufferState()` / `storeStatus().localBuffer` 读到原因；宿主拒绝写入（配额）同样如实留痕；恢复预算后照常写',
        wrote && gzSavedOk && skippedOk && restored && failOk
        && status.localBuffer && typeof status.localBuffer.budget === 'number' && LOCAL_BUFFER_MAX_CHARS === 1800000,
        J({ wrote, charsNow, gz: { ok: st2.ok, gz: st2.gz, stored: st2.storedChars, plain: st2.chars }, skipped: { ok: st2b.ok, skipped: st2b.skipped, chars: st2b.chars, budget: st2b.budget }, restored, failOk, st4 }));
})();

// ==================== D 组：调试日志单条上限 ====================
{
    debugLogClear();
    debugLogPush('限额', { big: 'x'.repeat(5000) });
    const l = debugLogList()[0] || { data: '' };
    R.assert('D1 调试日志单条上限 6000 → **2000** 字符（`docs/D13` R1/Q6，有意偏离 V1，登记于 P10c9）：300 条满载从 1.8M 字符降到 0.6M 字符，给状态信封腾出本机缓冲配额；截断方式与 V1 相同（对象取序列化前缀，字符串原样不截断）',
        DEBUG_DATA_MAX === 2000 && String(l.data).length === 2000,
        J({ max: DEBUG_DATA_MAX, len: String(l.data).length }));
}

R.done();
