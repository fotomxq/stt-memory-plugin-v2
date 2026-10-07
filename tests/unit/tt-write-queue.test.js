// ============================================================
// 单元测试 · v3.15.1「原生存储写入串行化」（闪退取证后的加固）
//
// 背景（真机取证）：崩的是**原生进程** `tauritavern.exe`（WER `0xc0000409` fastfail / `0xc0000005` 访问违例），
//   不是 webview 里的 JS；宿主日志崩溃前无错误行。而本插件此前**会并发写原生存储**：
//   `adapters/sync.js#storageWriteAll` 里主文件与快照是 `await` 的，**分片清单却是 fire-and-forget** →
//   常与「下一次保存的原生写」重叠。
//
// 本版口径：`adapters/tt-store.js` 给**所有原生写**（KV 的 put/del、Blob 的 put/del，含 `ttPutBytes` 的回退链）
//   加一条 **FIFO 串行队列** —— 任意时刻至多一个写在飞、不丢写、不改变先后语义、单次失败不阻塞队列；
//   `ttWriteStats()` / `ttWriteStatsReset()` 提供诊断（峰值并发应恒为 1）。
//   **只包装最底层**四个函数（`ttPutBytes` 内部会调它们，若也包装会自锁）。
// 运行：node tests/unit/tt-write-queue.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import {
    ttKvPut, ttKvDel, ttBlobPut, ttBlobDel, ttPutBytes, ttDelete, ttGetBytes,
    ttWriteStats, ttWriteStatsReset, ttResetSession, ttNativeOn, TT_NS,
} from '../../adapters/tt-store.js';

const R = makeReporter('tt-write-queue v3.15.1 原生存储写入串行化');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

/** 宿主桩：**给每次原生写加延迟**并记录并发峰值与调用顺序（用于证明「绝不重叠」） */
function makeHost2(opts) {
    const o = opts || {};
    const kv = new Map(); const blobs = new Map();
    const rec = { order: [], maxInFlight: 0, inFlight: 0, setJsonFail: 0, delayMs: Number(o.delayMs != null ? o.delayMs : 4) };
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const enter = async (label) => {
        rec.inFlight += 1;
        if (rec.inFlight > rec.maxInFlight) rec.maxInFlight = rec.inFlight;
        rec.order.push(label + '#s');
        await sleep(rec.delayMs);                       // 人为制造重叠窗口：若并发，峰值一定 >1
    };
    const leave = (label) => { rec.inFlight -= 1; rec.order.push(label + '#e'); };
    const store = {
        async setJson(a) { await enter('kv:' + String(a.key)); try { if (o.setJsonError && rec.setJsonFail < (o.setJsonErrorTimes || 1)) { rec.setJsonFail++; throw new Error(o.setJsonError); } kv.set(k(a), a.value); } finally { leave('kv:' + String(a.key)); } },
        async tryGetJson(a) { return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { if (!kv.has(k(a))) throw new Error('Not found: ' + k(a)); return kv.get(k(a)); },
        async deleteJson(a) { await enter('kvdel:' + String(a.key)); try { kv.delete(k(a)); } finally { leave('kvdel:' + String(a.key)); } },
        async listKeys(a) {
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
        async setBlob(a) { await enter('blob:' + String(a.key)); try { if (o.setBlobError) throw new Error(o.setBlobError); const d = a.data; blobs.set(k(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || [])); } finally { leave('blob:' + String(a.key)); } },
        async getBlob(a) { if (!blobs.has(k(a))) throw new Error('Not found: ' + k(a)); return new Blob([blobs.get(k(a))]); },
        async deleteBlob(a) { await enter('blobdel:' + String(a.key)); try { blobs.delete(k(a)); } finally { leave('blobdel:' + String(a.key)); } },
        async listBlobKeys(a) {
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
    };
    const abi = { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store } } };
    return { abi, store, kv, blobs, rec };
}

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({}), doc);
function useHost(h) {
    ttResetSession();
    ttWriteStatsReset();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    if (h) { try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ } }
    ttResetSession();
    return h;
}
useHost(makeHost2());

await A('Q1 检测前提：宿主桩被识别为 TauriTavern（否则后面的串行断言无意义）', async () => {
    return ttNativeOn() === true;
}, () => ({ on: ttNativeOn() }));

await A('Q2 三个并发 KV 写 → 宿主侧**严格串行**（峰值并发 = 1）且顺序 = 调用顺序（不重排）', async () => {
    const h = useHost(makeHost2({ delayMs: 5 }));
    const [a, b, c] = await Promise.all([
        ttKvPut('q2-a.json', 'AA'), ttKvPut('q2-b.json', 'BB'), ttKvPut('q2-c.json', 'CC'),
    ]);
    const st = ttWriteStats();
    const starts = h.rec.order.filter((x) => x.endsWith('#s'));
    return a.ok && b.ok && c.ok && h.rec.maxInFlight === 1 && st.maxInFlight === 1
        && J(starts) === J(['kv:q2-a.json#s', 'kv:q2-b.json#s', 'kv:q2-c.json#s'])
        && st.queued === 3 && st.done === 3 && st.failed === 0 && st.pending === 0;
}, () => ({ rec: ttWriteStats(), order: null }));

await A('Q3 混合写（KV put / Blob put / KV del / Blob del）并发 → 仍然峰值并发 1，且按调用顺序执行', async () => {
    const h = useHost(makeHost2({ delayMs: 4 }));
    const r = await Promise.all([
        ttKvPut('q3-kv.json', 'X'),
        ttBlobPut('q3-blob.json', new Uint8Array([1, 2, 3])),
        ttKvDel('q3-kv.json'),
        ttBlobDel('q3-blob.json'),
    ]);
    const starts = h.rec.order.filter((x) => x.endsWith('#s'));
    return r.every((x) => x.ok !== false) && h.rec.maxInFlight === 1
        && J(starts) === J(['kv:q3-kv.json#s', 'blob:q3-blob.json#s', 'kvdel:q3-kv.json#s', 'blobdel:q3-blob.json#s'])
        && ttWriteStats().maxInFlight === 1 && ttWriteStats().pending === 0;
}, () => ({ order: null, stats: ttWriteStats() }));

await A('Q4 Blob 写失败 → 回退 KV：两次原生写**串行**（不是并发），且回退确实发生', async () => {
    const h = useHost(makeHost2({ delayMs: 4, setBlobError: 'blob boom' }));
    const r = await ttPutBytes('q4-big.json', new Uint8Array(8 * 1024 * 1024), { channel: 'blob' });
    const starts = h.rec.order.filter((x) => x.endsWith('#s'));
    return r.ok === true && r.channel === 'kv' && !!r.afterBlobError
        && h.rec.maxInFlight === 1 && J(starts) === J(['blob:q4-big.json#s', 'kv:q4-big.json#s']);
}, () => ({ stats: ttWriteStats() }));

await A('Q5 单次写抛错 → 该调用如实失败，但**队列继续**（后续写照常成功），失败计数如实', async () => {
    const h = useHost(makeHost2({ delayMs: 2, setJsonError: 'kv boom', setJsonErrorTimes: 1 }));
    const bad = await ttKvPut('q5-a.json', 'AA');
    const good = await ttKvPut('q5-b.json', 'BB');
    const st = ttWriteStats();
    return bad.ok === false && good.ok === true && st.failed === 1 && st.done === 1
        && h.rec.maxInFlight === 1 && st.pending === 0;
}, () => ({ bad: null, stats: ttWriteStats() }));

await A('Q6 同键后写胜：并发两次同键写 → 宿主调用顺序 A→B，最终值为 B（串行不改变先后语义）', async () => {
    const h = useHost(makeHost2({ delayMs: 3 }));
    await Promise.all([ttKvPut('q6.json', 'ONE'), ttKvPut('q6.json', 'TWO')]);
    const got = h.kv.get(String(TT_NS) + '/main/q6.json');
    return got && got.v === 'TWO' && h.rec.maxInFlight === 1;
}, () => ({ stats: ttWriteStats() }));

await A('Q7 读操作不进写队列（读仍可并发）：并发 3 次读不被串行化拖慢，且不改变写统计', async () => {
    useHost(makeHost2({ delayMs: 2 }));
    await ttKvPut('q7.json', 'AA');
    const before = ttWriteStats();
    const reads = await Promise.all([ttGetBytes('q7.json'), ttGetBytes('q7.json'), ttGetBytes('q7.json')]);
    const after = ttWriteStats();
    return reads.every((r) => r.found === true) && after.queued === before.queued && after.done === before.done;
}, () => ({ stats: ttWriteStats() }));

await A('Q8 `ttDelete`（KV + Blob 双删）也走队列：并发删除不重叠；**缺失键不再发无谓删除**（v3.26.7：先探存在再删，避免宿主报「Not found」后端错误）', async () => {
    const h = useHost(makeHost2({ delayMs: 3 }));
    await ttKvPut('q8.json', 'AA'); await ttBlobPut('q8.json', new Uint8Array([9]));
    const st0 = ttWriteStats().queued;
    const rs = await Promise.all([ttDelete('q8.json'), ttDelete('q8-missing.json')]);
    return rs.every((x) => x.ok === true) && h.rec.maxInFlight === 1
        && rs[1].alreadyAbsent === true && rs[0].alreadyAbsent === false
        && ttWriteStats().queued === st0 + 2 && ttWriteStats().pending === 0;
}, () => ({ stats: ttWriteStats() }));

await A('Q9 诊断口径：统计可读且可重置（`last` 记录标签与耗时；重置后归零）', async () => {
    useHost(makeHost2({ delayMs: 2 }));
    await ttKvPut('q9.json', 'AA');
    const st = ttWriteStats();
    const ok = st.last && String(st.last.label).indexOf('kv-put:') === 0 && st.last.ok === true && st.last.ms >= 0 && st.last.at > 0;
    ttWriteStatsReset();
    const st2 = ttWriteStats();
    return ok && st2.queued === 0 && st2.done === 0 && st2.maxInFlight === 0 && st2.last === null;
}, () => ({ stats: ttWriteStats() }));

await A('Q10 调试桥只读方法 `ftt.writeStats`：与内核同源（真机核对「是否还有并发写」的入口）', async () => {
    useHost(makeHost2({ delayMs: 2 }));
    await ttKvPut('q10.json', 'AA');
    const UDBG = await import('../../ui/debug.js');
    const DBM = await import('../../adapters/debug-bridge.js');
    DBM.setBridgeMethods(UDBG.buildBridgeMethods());
    const r = await DBM.bridgeDispatch({ id: 'w', method: 'ftt.writeStats', params: {} });
    const v = r && r.result;
    return r.ok === true && v && v.queued === 1 && v.done === 1 && v.maxInFlight === 1
        && v.last && String(v.last.label).indexOf('kv-put:') === 0;
}, () => ({ stats: ttWriteStats() }));

R.done();
