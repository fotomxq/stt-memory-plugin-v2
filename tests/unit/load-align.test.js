// ============================================================
// 单元测试 · v3.0.23「载入全层对齐 + 读取台账」
//
// 用户要求（原话）：
//   ①「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志，方便追踪问题。」
//   ②「初次激活插件读取的数据还是没有对齐，请核对是否存在bug。」
//
// 本文件把「没对齐」的**三个真实成因**钉成回归：
//   A **本机内存库（IndexedDB）写而不读**：保存流水线一直写它，载入路径却从没读过 ——
//     浏览器本地变量被清掉而 IndexedDB 还在时，数据看起来整个丢了；
//   B **主文件不可用时分片一片都不读**：v3.0.21 的分片是实时通道，但旧实现只要主文件缺失 /
//     哈希不过就 `return null`（发生在应用分片之前）→ **恰恰在分片存在的场合**丢数据；
//   C **chatMetadata（随聊天走的载体）不参与载入**：换设备 / 恢复聊天备份 / 初次激活时，
//     聊天自带的那份记忆一个字节都不参与载入。
//   另加 D **载入竞态**：载入是异步的，期间用户导入的数据被后完成的载入清空（实测复现）。
//
// 运行：node tests/unit/load-align.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, kernelStateSeq } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { MODULE_NAME } from '../../core/constants.js';
import { stateFileName } from '../../adapters/user-file.js';
import { chatMetaCapability } from '../../adapters/chat-meta.js';
import { saveStateNow, setStorageHooks, loadFromServerFile, lastServerLoadInfo, loadFromIndexedDB } from '../../adapters/store.js';
import { shardName, resetShardMarks } from '../../adapters/shards.js';
import { readLedgerList, readLedgerStats, readLedgerLines, resetReadLedger, READ_SRC_LABEL } from '../../core/read-ledger.js';

const R = makeReporter('load-align v3.0.23 载入全层对齐（内存库 / 分片 / 聊天元数据 / 竞态）+ 读取台账');
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
/** 断言诊断值（惰性求值；失败时才需要，但此处统一算好便于排查） */
const D = (fn) => { try { return typeof fn === 'function' ? fn() : fn; } catch (e) { return String((e && e.message) || e); } };

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'char-align.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

// ---------- 桩：本机缓冲（localStorage）/ 本机内存库（IndexedDB / localforage）/ 服务端文件 ----------
const kv = new Map();
setStorageHooks({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); return true; },
    removeItem: (k) => { kv.delete(k); return true; },
});
const idb = new Map();
host.ctx.libs = {
    localforage: {
        getItem: async (k) => (idb.has(k) ? clone(idb.get(k)) : null),
        setItem: async (k, v) => { idb.set(k, clone(v)); return v; },
    },
};
const files = new Map();
const unFetch = installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        files.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8'));
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

const entry = await import('../../index.js');
const RT = await import('../../core/model/runtime.js');
const mainName = () => stateFileName(scopeId());
const localKey = () => 'ftt2_state_' + scopeId();

function mkSt(opts) {
    const o = opts || {};
    // 每个断言块用**互不相同**的内容（`tag`）：保存流水线的 `tombstoneSweep` 会按**内容哈希**留删除墓碑，
    //   若不同块造出同样内容，后一块的「消失条目」会把前一块的内容判成已删除（这是正确行为，测试必须避开）。
    const tag = String(o.tag || 'x');
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < (o.atoms || 0); i++) st.atoms.push({ id: 'a-' + tag + '-' + i, title: '情节' + i, text: '【' + tag + '】第 ' + i + ' 条情节正文（足够长）。', date: '1919-11-29', tags: [], updatedAt: 1000 + i });
    st.memories = [];
    for (let i = 0; i < (o.memories || 0); i++) st.memories.push({ id: 'm-' + tag + '-' + i, owner: '甲', title: '记忆' + i, content: '【' + tag + '】记忆正文' + i, updatedAt: 1000 + i });
    st.updatedAt = Number(o.updatedAt) || 1000;
    return st;
}
/** 清掉本地两层与聊天载体（模拟「换设备 / 清缓存 / 恢复聊天备份」的各种组合） */
function clearLayers(opts) {
    const o = opts || {};
    if (o.local !== false) kv.clear();
    if (o.idb !== false) idb.clear();
    if (o.files !== false) files.clear();
    if (o.chatmeta !== false) delete host.ctx.chatMetadata[MODULE_NAME];
}
function setChatMeta(st, at) {
    host.ctx.chatMetadata[MODULE_NAME] = { format: 'ftt-memory-v2-meta', version: '1', at: Number(at) || 0, scope: scopeId(), state: clone(st) };
}
function boot(st) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char-align.png');
    setKernelState(st || emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    resetShardMarks();
    resetReadLedger();
    return st || state;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== A 组：本机内存库（IndexedDB）真的被读 ====================
await (async () => {
    const st = boot(mkSt({ atoms: 2, memories: 1, updatedAt: 4000, tag: 'A' }));
    await saveStateNow({ reason: 'A-基线', force: true });
    const idbWrote = idb.has(localKey()) && kv.has(localKey()) && files.has(mainName());
    // 模拟「浏览器本地变量被清掉 / 换了存储分区」，而 IndexedDB 还在
    clearLayers({ idb: false, chatmeta: false });
    const r = await entry.loadMemoryState();
    const rec = readLedgerList().find((x) => x.src === 'idb');
    R.assert('LA1 **根因回归**：保存流水线写进 IndexedDB 的本机内存库**在载入时真的被读**（此前写而不读 → 本地变量被清掉时数据看起来全丢）；载入来源回报 `idb`，台账记条数与耗时',
        idbWrote && r.via === 'idb' && (state.atoms || []).length === 2 && (state.memories || []).length === 1
        && !!rec && rec.ok === true && Number(rec.items) === 3 && Number(rec.ms) >= 0,
        D(() => J({ idbWrote, r, atoms: (state.atoms || []).length, rec })));
})();

// ==================== B 组：主文件不可用 → 分片仍然被读 ====================
await (async () => {
    const st = boot(mkSt({ atoms: 3, memories: 1, updatedAt: 5000, tag: 'B1' }));
    await saveStateNow({ reason: 'B-基线', force: true });
    files.delete(mainName());                       // 主文件没了（写入失败 / 被清理），分片还在
    clearLayers({ files: false });
    const srv = await loadFromServerFile();
    const info = lastServerLoadInfo();
    const viaShards = info.via === 'shards' && (info.applied || []).indexOf('atoms') >= 0;
    const r = await entry.loadMemoryState();
    R.assert('LA2 **根因回归**：主文件缺失时**不再直接返回 null**（旧实现 `applyNewerShards` 之前就返回 → 分片白写了）；现在以 `mainAt=0` 应用全部分片重建状态，载入结论如实回报 `via:"shards"` 与应用的维度',
        !!srv && (srv.atoms || []).length === 3 && viaShards && r.via === 'file' && (state.atoms || []).length === 3,
        D(() => J({ srv: !!(srv), atoms: (srv && srv.atoms || []).length, info, r, files: Array.from(files.keys()).length })));
})();

await (async () => {
    const st = boot(mkSt({ atoms: 2, memories: 2, updatedAt: 6000, tag: 'B2' }));
    await saveStateNow({ reason: 'B2-基线', force: true });
    // 主文件被写坏（信封在、内容被改，哈希对不上）——旧实现同样直接丢弃、分片一片不读
    const env = JSON.parse(files.get(mainName()));
    env.payload.data.atoms = [];
    files.set(mainName(), JSON.stringify(env));
    clearLayers({ files: false });
    const srv = await loadFromServerFile();
    const info = lastServerLoadInfo();
    const rec = readLedgerList().find((x) => x.reason === 'hash-mismatch');
    R.assert('LA3 主文件**哈希不过**时同样落到分片重建（旧实现：只写一条内核 warn，分片一个字节都不读、台账无痕）；台账记下 `hash-mismatch` 这条可追踪的失败原因',
        !!srv && (srv.atoms || []).length === 2 && info.via === 'shards' && info.reason === 'hash-mismatch' && !!rec,
        D(() => J({ srv: !!(srv), atoms: (srv && srv.atoms || []).length, info, rec })));
})();

// ==================== C 组：chatMetadata（随聊天走的载体）参与载入 ====================
await (async () => {
    boot(emptyState());
    clearLayers({});
    setChatMeta(mkSt({ atoms: 2, memories: 1, updatedAt: 7000, tag: 'C1' }), 7000);
    const cap = chatMetaCapability();
    const r = await entry.loadMemoryState();
    const rec = readLedgerList().find((x) => x.src === 'chatmeta');
    // 载入取的必须是**快照**：chatMetadata 里的对象一个字段都不许被内核改动（本阶段「只读不写」）
    const liveMeta = host.ctx.chatMetadata[MODULE_NAME].state;
    const notSameObject = state !== liveMeta && state.atoms !== liveMeta.atoms;
    const metaUntouched = liveMeta.atoms.length === 2 && liveMeta.updatedAt === 7000;
    R.assert('LA4 **初次激活对齐**：服务端还没有数据、本机两层也是空的时候，聊天里（chatMetadata，随聊天备份一起走）那 2 条情节 + 1 条记忆被当作**基底**载入（此前只当差异报告读 → 用户看到的「数据没有对齐」）；台账记下条数与时间',
        cap.readable === true && r.base === 'chatmeta' && r.via === 'chatmeta'
        && (state.atoms || []).length === 2 && (state.memories || []).length === 1
        && !!rec && Number(rec.items) === 3 && notSameObject && metaUntouched,
        D(() => J({ cap, r, atoms: (state.atoms || []).length, rec, notSameObject, metaUntouched })));
})();

await (async () => {
    const st = boot(mkSt({ atoms: 1, updatedAt: 8000, tag: 'C2a' }));
    await saveStateNow({ reason: 'C2-基线', force: true });
    const baseAt = Number(JSON.parse(files.get(mainName())).payload.updatedAt) || 0;
    clearLayers({ files: false });
    // ① 聊天载体比基底**更新** → 并集进来（那台设备上新加的内容不能丢）
    setChatMeta(mkSt({ atoms: 2, updatedAt: baseAt + 10000, tag: 'C2a2' }), baseAt + 10000);
    const r1 = await entry.loadMemoryState();
    const added = (state.atoms || []).length;
    // ② 聊天载体比基底**旧**（例如用户刚清空过记忆）→ 跳过并集，**绝不复活**旧数据
    const st2 = boot(mkSt({ atoms: 1, updatedAt: 9000, tag: 'C2b' }));
    await saveStateNow({ reason: 'C2-基线2', force: true });
    const baseAt2 = Number(JSON.parse(files.get(mainName())).payload.updatedAt) || 0;
    clearLayers({ files: false });
    setChatMeta(mkSt({ atoms: 5, updatedAt: baseAt2 - 10000, tag: 'C2b-old' }), baseAt2 - 10000);
    const r2 = await entry.loadMemoryState();
    const skippedMeta = (r2.skipped || []).some((s) => s.src === 'chatmeta' && s.reason === 'not-newer');
    R.assert('LA5 聊天载体的两条口径：**比基底更新**时并集并入（跨设备新数据不丢）；**比基底旧**时跳过（否则「清空记忆」会被旧副本复活）',
        r1.unioned.indexOf('chatmeta') >= 0 && added === 3 && Number((r1.contributed || {}).chatmeta) === 2
        && skippedMeta && (state.atoms || []).length === 1,
        D(() => J({ r1, added, skippedMeta, r2, atoms: (state.atoms || []).length })));
})();

// ==================== D 组：载入竞态（后完成的载入不得清掉新数据） ====================
await (async () => {
    boot(emptyState());
    clearLayers({});
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const un2 = installGlobalFetch(async (url, opts) => {
        if (String(url).indexOf('/user/files/') === 0) { await gate; return { status: 404, text: 'not found' }; }
        if (url === '/api/files/upload') return { status: 200, text: 'ok' };
        return { status: 404, text: '' };
    });
    const gen0 = kernelStateSeq();
    const p = entry.loadMemoryState();
    await Promise.resolve();
    await Promise.resolve();
    // 载入读盘期间，用户导入了一份数据（真实场景：面板导入 / V1 导入 / 跨端合并）
    const imported = mkSt({ atoms: 5, updatedAt: 12345, tag: 'D' });
    setKernelState(imported);
    release();
    const r = await p;
    un2();
    R.assert('LA6 **竞态回归**：载入读盘期间用户导入 / 合并进来的状态**不会被后完成的载入清空**（旧实现无条件覆盖 → 实测「导入完 2 条 → 变成 0 条」）；本次载入如实回报 `superseded`',
        r.superseded === true && (state.atoms || []).length === 5 && state === imported && kernelStateSeq() > gen0,
        D(() => J({ r, atoms: (state.atoms || []).length, superseded: r.superseded })));
})();

// ==================== E 组：作用域未就绪（初次激活的另一种「没对齐」） ====================
await (async () => {
    boot(emptyState());
    clearLayers({});
    host.ctx.characters = [];
    host.ctx.name2 = '';
    const r = await entry.loadMemoryState();
    const rec = readLedgerList().find((x) => x.reason === 'scope-key-empty');
    const sch = entry.scheduleScopeReload(5);
    const cancelled = entry.cancelScopeReload();
    host.ctx.characters = [{ name: '角色甲', avatar: 'char-align.png' }];
    host.ctx.name2 = '角色甲';
    await sleep(20);
    R.assert('LA7 角色稳定键未就绪时如实记账并回报 `scopeEmpty`，且安排**一次**可撤销的延迟重载（`init` 据此自动纠正；此前会静默按 `default` 作用域读别人的文件）',
        r.scopeEmpty === true && !!rec && sch.scheduled === true && cancelled === true && entry.SCOPE_RELOAD_DELAY_MS === 1500,
        D(() => J({ r, rec, sch, cancelled, delay: entry.SCOPE_RELOAD_DELAY_MS })));
})();

// ==================== F 组：纯函数对齐口径 + 读取台账统计 ====================
{
    const A = entry.alignLoadedLayers;
    const file = mkSt({ atoms: 1, updatedAt: 100, tag: 'F1' });
    const local = mkSt({ atoms: 1, updatedAt: 900, tag: 'F2' });
    const idbSt = mkSt({ atoms: 2, updatedAt: 950, tag: 'F3' });
    const metaNew = mkSt({ atoms: 3, updatedAt: 999, tag: 'F4' });
    const metaOld = mkSt({ atoms: 3, updatedAt: 1, tag: 'F5' });
    const r1 = A({ file: file, local: local, idb: idbSt, chatmeta: metaNew });
    const r2 = A({ local: local, idb: idbSt, chatmeta: metaOld });
    const r3 = A({});
    R.assert('LA8 对齐纯函数：基底 = 服务端文件（有则必用）→ 否则本地三层里 `updatedAt` 最新的一份；本机缓冲与内存库**始终**并集；聊天载体只在**比基底更新**时并集；`report` 逐层给出 at/条数/是否采用/贡献条数',
        r1.base === 'file' && r1.unioned.indexOf('local') >= 0 && r1.unioned.indexOf('idb') >= 0 && r1.unioned.indexOf('chatmeta') >= 0
        && r1.report.file.used === true && r1.report.local.used === true
        && r2.base === 'idb' && r2.unioned.indexOf('chatmeta') < 0 && r2.skipped.some((s) => s.src === 'chatmeta' && s.reason === 'not-newer')
        && r3.st === null && r3.via === 'new' && r3.base === '',
        D(() => J({ r1: { base: r1.base, unioned: r1.unioned }, r2: { base: r2.base, unioned: r2.unioned, skipped: r2.skipped }, r3: { via: r3.via } })));
}

await (async () => {
    const st = boot(mkSt({ atoms: 2, memories: 1, updatedAt: 1000, tag: 'G' }));
    await saveStateNow({ reason: 'G-基线', force: true });
    clearLayers({ idb: false, chatmeta: false });
    await entry.loadMemoryState();
    const stats = readLedgerStats();
    const srcs = Object.keys(stats.bySrc);
    const all = readLedgerList();
    const transport = all.find((x) => String(x.action).indexOf('通道读取') === 0);
    const need = ['local', 'idb', 'file', 'shard', 'meta', 'memory'];
    const missing = need.filter((k) => srcs.indexOf(k) < 0);
    R.assert('LA9 读取台账覆盖「服务端 / 本地 / 内存」每一层：逐条含来源 / 动作 / 目标 / 耗时 / 体积 / 条数 / 结果，分来源统计可直接读；通道级读取（走哪个后端）也有记录；台账文本只给数字与字段名',
        missing.length === 0 && stats.totalReads >= 6 && stats.ok >= 1 && !!transport
        && all.every((x) => Number(x.at) > 0 && Number(x.ms) >= 0 && READ_SRC_LABEL[x.src] !== undefined)
        && readLedgerLines(5).length === Math.min(5, all.length),
        D(() => J({ srcs, missing, total: stats.totalReads, transport: !!transport })));
})();

R.done();
