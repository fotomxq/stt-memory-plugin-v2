// ============================================================
// 单元测试 · v3.0.21 「存储异常 / 退出应用后大量回滚」的一劳永逸修法
//
// 用户要求（原话）：「修复存储异常，当退出应用后，插件的数据大量回滚。之前发现是内存问题，
//   建议一劳永逸，第一次启动不用内存或本地数据。每次数据变动立刻分片提交到服务端存储，实现实时存储能力。」
//
// 本文件覆盖三件事：
//   A **分片提交**：按维度分片（每片单独成文件 + 一份清单），只上传**内容变化过**的片；
//   B **载入恢复**：主文件写入滞后/失败时，载入会把「比主文件更新」的分片应用回来（不再回滚）；
//   C **异常缩水守卫**：无墓碑的大规模缩水 → 拒绝写覆盖（残缺状态再也盖不掉服务端的好数据）。
//
// 运行：node tests/unit/shards.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { setKernelState, setScopeKey, setPersistHooks, getScopeKey } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import { storageEnvelope, storageHash } from '../../core/envelope.js';
import {
    saveStateNow, loadFromServerFile, loadFromLocalStorage, setStorageHooks, primeShrinkBaseline, lastSaveInfo,
} from '../../adapters/store.js';
import { stateFileName } from '../../adapters/user-file.js';
import { writeStateShards, readShardManifest, applyNewerShards, shardName, shardManifestName, resetShardMarks, shardMarks, META_SHARD } from '../../adapters/shards.js';

const R = makeReporter('shards v3.0.21 分片提交 / 载入恢复 / 异常缩水守卫');
const J = (v) => JSON.stringify(v);
const A = async (name, fn, detail) => {
    let ok = false, extra = detail;
    try { ok = await fn(); } catch (e) { ok = false; extra = String((e && e.message) || e); }
    R.assert(name, ok === true, typeof extra === 'function' ? (() => { try { return extra(); } catch (e) { return String(e.message); } })() : extra);
};

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

// ---------- 桩：本机缓冲 + 服务端“文件系统”（按文件名存文本） ----------
const kv = new Map();
setStorageHooks({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); return true; },
    removeItem: (k) => { kv.delete(k); return true; },
});
const files = new Map();
const putLog = [];
const unFetch = installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        files.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8'));
        putLog.push(String(body.name));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const n = decodeURIComponent(m[1]);
        if (!files.has(n)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(n) };
    }
    return { status: 404, text: '' };
});

/** 造一个 dims 可控的状态 */
function mkSt(opts) {
    const o = opts || {};
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < (o.atoms || 0); i++) st.atoms.push({ id: 'a' + i, title: '情节' + i, text: '第 ' + i + ' 条情节正文（足够长）。', date: '1919-11-29', tags: [], updatedAt: 1000 + i });
    st.memories = [];
    for (let i = 0; i < (o.memories || 0); i++) st.memories.push({ id: 'm' + i, owner: '甲', title: '记忆' + i, content: '记忆正文' + i, updatedAt: 1000 + i });
    st.processedFloors = [];
    for (let i = 0; i < (o.marks || 0); i++) st.processedFloors.push({ f: i, h: 'h' + i });
    st.updatedAt = Number(o.updatedAt) || 1000;
    return st;
}
function boot(st) {
    setScopeKey('char:shards');
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    kv.clear(); files.clear(); putLog.length = 0; resetShardMarks();
    return st;
}
const mainName = () => stateFileName(scopeId());
const shardPuts = () => putLog.filter((n) => String(n).indexOf('ftt2-shard-') === 0 && String(n).indexOf('-manifest.json') < 0);
const manifestPuts = () => putLog.filter((n) => String(n).indexOf('-manifest.json') > 0);

// ==================== A 组：分片提交（只传变化过的片） ====================
await A('A1 首次保存：每个维度分片 + meta 片 + 清单各写一次；主文件仍是**完整信封**（同步/备份/导入/V1 迁移全部照旧）', async () => {
    const st = boot(mkSt({ atoms: 6, memories: 3, marks: 4 }));
    const r = await saveStateNow({ reason: 'A1', force: true });
    const shards = shardPuts();
    const env = JSON.parse(files.get(mainName()) || '{}');
    return r.ok === true && r.via.indexOf('file') >= 0
        && shards.indexOf(shardName(scopeId(), 'atoms')) >= 0 && shards.indexOf(shardName(scopeId(), 'memories')) >= 0
        && shards.indexOf(shardName(scopeId(), META_SHARD)) >= 0 && manifestPuts().length === 1
        && !!env.payload && Array.isArray(env.payload.data.atoms) && env.payload.data.atoms.length === 6
        && env.hash === storageHash(env.payload);
}, () => J({ puts: putLog, shards: shardPuts() }));

await A('A2 **只上传变化过的片**：改一条情节再存 → 只重传 atoms（+清单）；记忆/台账等未变的分片一个字节都不发', async () => {
    const st = boot(mkSt({ atoms: 6, memories: 3, marks: 4 }));
    await saveStateNow({ reason: 'A2-初始', force: true });
    putLog.length = 0;
    st.atoms[0].text = '第 0 条情节正文被改写过（足够长）。';
    st.updatedAt = 2000;
    const r = await saveStateNow({ reason: 'A2-改动' });           // 不传 force：走「只传变化过的片」的正常路径
    const shards = shardPuts();
    return r.ok === true
        && shards.length === 1 && shards[0] === shardName(scopeId(), 'atoms')
        && manifestPuts().length === 1
        && shardMarks().atoms !== undefined;
}, () => J({ shards: shardPuts(), tries: putLog }));

await A('A3 分片内容可读回且带内容哈希校验：清单给出每片的 `{at,hash,bytes,n}`；`applyNewerShards` 只应用**比给定时戳更新**的片', async () => {
    const st = boot(mkSt({ atoms: 5, memories: 2, marks: 3 }));
    await saveStateNow({ reason: 'A3', force: true });
    const m = await readShardManifest(scopeId());
    const okManifest = !!m && !!m.marks && !!m.marks.atoms && !!m.marks[META_SHARD]
        && /^[a-z0-9]+$/.test(String(m.marks.atoms.hash)) && Number(m.marks.atoms.n) === 5;
    // 目标态：从零开始，只应用「比 0 更新」的分片 → 载入后应拿到 5 条情节 + 3 条台账
    const fresh = emptyState();
    const ap = await applyNewerShards(fresh, 0, { slug: scopeId() });
    const later = emptyState();
    const ap2 = await applyNewerShards(later, Date.now() + 1000, { slug: scopeId() });
    return okManifest && ap.applied.length >= 2 && (fresh.atoms || []).length === 5
        && (fresh.memories || []).length === 2 && (fresh.processedFloors || []).length === 3
        && ap2.applied.length === 0;
}, () => J({ marks: undefined }));

await A('A4 分片损坏 / 缺失 → 静默忽略（绝不影响主文件载入）：删掉 atoms 片后 `applyNewerShards` 跳过它，主文件照常可用', async () => {
    const st = boot(mkSt({ atoms: 4, memories: 2, marks: 2 }));
    await saveStateNow({ reason: 'A4', force: true });
    files.delete(shardName(scopeId(), 'atoms'));
    const fresh = emptyState();
    const ap = await applyNewerShards(fresh, 0, { slug: scopeId() });
    const loaded = await loadFromServerFile();
    return ap.skipped.indexOf('atoms') >= 0 && ap.applied.indexOf('atoms') < 0
        && ap.applied.indexOf('memories') >= 0
        && !!loaded && (loaded.atoms || []).length === 4;      // 主文件仍是完整信封
}, () => J({ }));

// ==================== B 组：载入恢复（主文件滞后 → 分片补回） ====================
await A('B1 **根因回归**：主文件写入滞后/失败（只写进了分片）时，载入会把更新的分片应用回来 —— 数据不再「大量回滚」', async () => {
    const st = boot(mkSt({ atoms: 5, memories: 2, marks: 2 }));
    await saveStateNow({ reason: 'B1-基线', force: true });
    // 模拟：主文件留在旧内容（把当前主文件快照存下来，稍后恢复），随后只写分片（主文件写入失败）
    const mainSnapshot = files.get(mainName());
    st.atoms.push({ id: 'a-new', title: '新情节', text: '主文件没写进去、只进了分片的情节。', date: '1919-12-01', tags: [], updatedAt: 9999 });
    st.updatedAt = 5000;
    const w = await writeStateShards(st, { force: true });        // 只写分片（模拟主文件写入失败）
    files.set(mainName(), mainSnapshot);                          // 主文件回到旧内容
    const loaded = await loadFromServerFile();
    const ids = (loaded && loaded.atoms || []).map((x) => x.id);
    const okB = w.ok === true && !!loaded && ids.indexOf('a-new') >= 0 && (loaded.atoms || []).length === 6;
    if (!okB) console.log('B1-DEBUG ' + J({ w: w, ids: ids, mainAt: (JSON.parse(files.get(mainName()) || '{}').payload || {}).updatedAt, marks: (await readShardManifest(scopeId()) || {}).marks && (await readShardManifest(scopeId())).marks.atoms, files: Array.from(files.keys()) }));
    return okB;
}, () => J({ atoms: undefined }));

await A('B2 主文件**更新**时不重复应用（分片 `at` 不晚于主文件）→ 不会把旧分片盖回来', async () => {
    const st = boot(mkSt({ atoms: 3, memories: 1, marks: 1 }));
    await saveStateNow({ reason: 'B2', force: true });
    // 之后又有一次新改动 + 一次完整保存（主文件与分片同时推进）
    st.atoms.push({ id: 'a2', title: '后续', text: '后续情节。', date: '1919-12-02', tags: [], updatedAt: 7777 });
    st.updatedAt = 7000;
    await saveStateNow({ reason: 'B2-后续', force: true });
    const loaded = await loadFromServerFile();
    return (loaded.atoms || []).length === 4 && (loaded.atoms || []).map((x) => x.id).indexOf('a2') >= 0;
}, () => J({ }));

// ==================== C 组：异常缩水守卫（残缺状态盖不掉好数据） ====================
await A('C1 **一劳永逸**：无墓碑的大规模缩水（读写到残缺状态）→ 保存被**拦下**，服务端文件与本机缓冲都保持原样', async () => {
    const st = boot(mkSt({ atoms: 200, memories: 50, marks: 100 }));
    await saveStateNow({ reason: 'C1-正常', force: true });
    const before = files.get(mainName());
    const beforeLocal = kv.get('ftt2_state_' + scopeId());
    // 模拟「内存里拿到一份残缺状态」：条目掉了 90%，没有任何删除墓碑
    st.atoms = st.atoms.slice(0, 10);
    st.memories = [];
    st.updatedAt = 9000;
    const r = await saveStateNow({ reason: 'C1-残缺' });
    const ok = r.ok === false && r.error === 'shrink-guard' && r.blocked === true
        && files.get(mainName()) === before && kv.get('ftt2_state_' + scopeId()) === beforeLocal
        && (lastSaveInfo() || {}).error === 'shrink-guard';
    if (!ok) console.log('C1-DEBUG ' + J({ r: r, fileSame: files.get(mainName()) === before, localSame: kv.get('ftt2_state_' + scopeId()) === beforeLocal, last: lastSaveInfo(), hasFile: files.has(mainName()), hasLocal: kv.has('ftt2_state_' + scopeId()) }));
    return ok;
}, () => J({ save: lastSaveInfo() }));

await A('C2 用户**显式删除**不会被拦：缩水伴随足量删除墓碑 → 照常写盘（守卫只看「无墓碑的缩水」）', async () => {
    const st = boot(mkSt({ atoms: 200, memories: 20, marks: 5 }));
    await saveStateNow({ reason: 'C2-基线', force: true });
    const dropped = st.atoms.slice(100);
    st.atoms = st.atoms.slice(0, 100);
    st.deleted = { atoms: {} };
    st.deletedH = { atoms: {} };
    for (const it of dropped) st.deleted.atoms[it.id] = Date.now();
    st.updatedAt = 9100;
    const r = await saveStateNow({ reason: 'C2-显式删除' });
    return r.ok === true && r.error !== 'shrink-guard';
}, () => J({ save: lastSaveInfo() }));

await A('C3 `force`（清空记忆 / 导入 / 手动同步等明确动作）不受守卫限制', async () => {
    const st = boot(mkSt({ atoms: 200, memories: 20, marks: 5 }));
    await saveStateNow({ reason: 'C3-基线', force: true });
    const empty = emptyState();
    setKernelState(empty);
    const r = await saveStateNow({ reason: 'C3-清空', force: true });
    return r.ok === true && r.error !== 'shrink-guard';
}, () => J({ save: lastSaveInfo() }));

R.done();
