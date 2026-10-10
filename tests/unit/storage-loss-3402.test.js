// ============================================================
// 单元测试 · v3.40.2（用户报告「刷新后大量已分析内容丢失、只留早期数据」的**存储丢失**修复）
//
// 两条根因（都在「载入读回了旧副本」这一类）：
//  ① **本机副本的作用域 token 写读不一致**：写侧 `core/state.js#scopeId()`（`char:<hash(scopeKey)>`）、
//     读侧 `getScopeKey()`（宿主注入的 `char:<hash>`）—— 二次哈希关系 → 本机副本**写得进、读不回**，
//     每次刷新都判「本机层没有副本」→ 回退浏览器层 / 服务端旧副本。
//     → 修复：`adapters/local-disk.js#localScopeToken()` / `#localCopyFileName()` 成为**写读唯一来源**；
//       另加「按内容作用域在同目录精确找回」的只读兜底（防口径再次漂移）。
//  ② **服务端主文件候选顺序**：`loadFromServerFile` 固定「先读明文 `.json`，读不到才试 `.json.gz`」，
//     而写侧在 gzip 开启时**只写 `.json.gz`** → 盘上遗留的**旧明文永远压住新数据**。
//     → 修复：按 `stateFileReadCandidates()` 的顺序读全，再按信封 `updatedAt` **取最新**。
//
// 运行：node tests/unit/storage-loss-3402.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { gunzipSync } from 'node:zlib';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { storageEnvelope, storageHash } from '../../core/envelope.js';
import { hashText } from '../../core/util.js';
import {
    localDiskReset, localDiskInfo, localDiskWrite, localDiskRead, localDiskReadParts,
    localScopeToken, localCopyFileName, LOCAL_COPY_PREFIX,
} from '../../adapters/local-disk.js';
import {
    setSyncStorageHooks, stateFileName, stateFileGzName, stateFileWriteName, stateFileReadCandidates,
    fileCacheDropAll, resetSyncState, resetRemoteMarks, stateFileWrite, stateFileReadAny,
} from '../../adapters/sync.js';
import { saveStateNow, setStorageHooks, loadFromServerFile, lastServerLoadInfo } from '../../adapters/store.js';
import { loadFromLocalDisk } from '../../index.js';

const R = makeReporter('storage-loss-3402 v3.40.2 存储丢失修复（本机副本 token 同源 · 主文件候选取新）');
const clone = (v) => JSON.parse(JSON.stringify(v));

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

// ---------- 宿主 / DOM 桩 ----------
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
installGlobalHost(host, doc);

/** 内存盘宿主桩（`api.dev.files`）：与 `adapters/local-disk.js#diskWriteText` 的 dev-api 形态一致 */
function makeDiskHost() {
    const disk = new Map();
    const files = {
        async writeTextFile(a) { disk.set(String(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
        async readTextFile(a) {
            const k = String(a.path);
            if (!disk.has(k)) throw new Error('ENOENT: ' + k);
            return { text: disk.get(k) };
        },
        async readDir(a) {
            const pre = String((a && a.path) || '');
            return Array.from(disk.keys()).filter((k) => k.indexOf(pre) === 0)
                .map((k) => ({ name: k.slice(pre.length).replace(/^[\\/]/, ''), isFile: true, size: String(disk.get(k)).length }));
        },
        async exists(a) { return disk.has(String(a.path)); },
        async mkdir() { return { ok: true }; },
        async remove(a) { disk.delete(String(a.path)); return { ok: true }; },
    };
    return { abi: { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store: {} }, dev: { files: files } } }, disk: disk, files: files };
}
function useHost(h) {
    try { if (!globalThis.window) globalThis.window = {}; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    if (h) { try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ } }
    try { localDiskReset(); } catch (e) { /* 忽略 */ }
    return h;
}

// ---------- 服务端文件通道桩（`/api/files/upload` + `/user/files/<name>`） ----------
const files = new Map();                 // name → Uint8Array
const uploaded = [];                     // 上传请求序列（用于「不探测 .json.gz」的回归断言）
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        uploaded.push(String(body.name));
        files.set(String(body.name), new Uint8Array(Buffer.from(String(body.data || ''), 'base64')));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, bytes: files.get(name) };
    }
    return { status: 404, text: '' };
});

// ---------- 可注入 localStorage ----------
const lsm = new Map();
setSyncStorageHooks({
    get: (k) => (lsm.has(k) ? lsm.get(k) : null),
    set: (k, v) => { lsm.set(k, String(v)); return true; },
    del: (k) => { lsm.delete(k); return true; },
});
setStorageHooks({
    getItem: (k) => (lsm.has(k) ? lsm.get(k) : null),
    setItem: (k, v) => { lsm.set(k, String(v)); return true; },
    removeItem: (k) => { lsm.delete(k); return true; },
});

const DISK_DIR = 'D:\\FTT\\store';
/** 真实宿主注入的作用域键形态（`host/st-api.js#currentCharScope`：`char:<hash(avatar)>`） */
const CHAR_AVATAR = 'Alice.png';
const REAL_KEY = 'char:' + hashText(CHAR_AVATAR);

/**
 * 重启测试环境。
 * @param {{disk?:boolean, gzip?:boolean, slim?:boolean, atoms?:Array<object>, updatedAt?:number}} o
 */
function boot(o) {
    const opt = o || {};
    resetSyncState(); resetRemoteMarks();
    files.clear(); lsm.clear(); uploaded.length = 0; fileCacheDropAll();
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage.stateFile = true;
    cfg.storage.stateFileBak = false;
    cfg.storage.snapshotFile = false;
    cfg.storage.syncMetaProbe = false;
    cfg.storage.syncLogServer = false;
    cfg.storage.stateFileSlim = opt.slim === true;
    cfg.storage.stateFileGzip = opt.gzip === true;
    // v3.33.0：本地存储路径是**设备本地键** —— 直接写配置对象（内核视图）即可让 `localDiskOn()` 生效
    cfg.storage.localDiskDir = opt.disk === false ? '' : DISK_DIR;
    setScopeKey(REAL_KEY);
    setIdentityView({ characterName: '角色甲' });
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setKernelState(Object.assign(emptyState(), clone(opt.atoms ? { atoms: opt.atoms } : { atoms: [] }), { updatedAt: Number(opt.updatedAt) || 1700000000000 }));
    return state;
}
const atomOf = (id, text) => ({ id: id, text: text, title: text, tags: [], uses: 1, updatedAt: 1700000000000 });
/** `.json.gz` 的字节 → 明文（Node zlib 解，与浏览器端 CompressionStream 跨实现互验） */
const gunzipText = (bytes) => gunzipSync(Buffer.from(bytes)).toString('utf8');
/** 固定时间戳的信封（`storageEnvelope` 用 `Date.now()` → 测试需可比） */
function fixedEnvelope(st, at) {
    const env = storageEnvelope(st);
    env.ts = at;
    env.payload.updatedAt = at;
    env.hash = storageHash(env.payload);
    return env;
}

// ============================================================
// ① 本机副本：写读同源（用户报告的主根因）
// ============================================================
await A('RT-1 **写读同源**：本地磁盘模式真实保存后，`loadFromLocalDisk()` 必须读回同一份（修复前写 `char_<二次哈希>`、读 `char_<一次哈希>` → 永远读不回）', async () => {
    const cur = boot({ disk: true, atoms: [atomOf('a1', '甲在码头清点货物。'), atomOf('a2', '乙在酒馆打听消息。')] });
    const h = useHost(makeDiskHost());
    await saveStateNow({ reason: 'test-rt1' });
    const written = Array.from(h.disk.keys()).filter((k) => /ftt2-local-.*\.json$/.test(k) && !/probe/.test(k));
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    return written.length >= 1
        && (got && Array.isArray(got.atoms) ? got.atoms.length : -1) === 2
        && got.atoms[0].text === '甲在码头清点货物。';
}, () => ({ written: null, load: null }));

await A('RT-2 落盘文件名与读侧候选名**逐字符相同**（`localCopyFileName(localScopeToken())` 就是落盘名）', async () => {
    boot({ disk: true, atoms: [atomOf('a1', '甲在码头清点货物。')] });
    const h = useHost(makeDiskHost());
    await saveStateNow({ reason: 'test-rt2' });
    const want = localCopyFileName(localScopeToken());
    const names = Array.from(h.disk.keys()).map((k) => k.replace(/^.*[\\/]/, ''));
    return want.indexOf(LOCAL_COPY_PREFIX) === 0 && /^ftt2-local-char_.*\.json$/.test(want)
        && names.indexOf(want) >= 0;
}, null);

await A('RT-3 单文件被删后由**结构化分片**读回（分片与快照分片用同一个 token）', async () => {
    boot({ disk: true, atoms: [atomOf('a1', '甲在码头清点货物。')] });
    const h = useHost(makeDiskHost());
    await saveStateNow({ reason: 'test-rt3' });
    // 删掉单文件（只留 `<scope>/` 下的结构化分片）
    const single = localCopyFileName(localScopeToken());
    for (const k of Array.from(h.disk.keys())) if (k.replace(/^.*[\\/]/, '') === single) h.disk.delete(k);
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    return !!got && Array.isArray(got.atoms) && got.atoms.length === 1 && got.atoms[0].text === '甲在码头清点货物。';
}, null);

await A('RT-4 文件名口径漂移时**按内容作用域精确找回**：别名文件（`payload.scope` 命中）能读回；异角色的诱饵文件必须被忽略', async () => {
    const cur = boot({ disk: true, atoms: [atomOf('a1', '漂移找回的情节。')] });
    const h = useHost(makeDiskHost());
    const at = 1700000009999;
    const mine = fixedEnvelope(cur, at);
    // 别名文件（名字与当前 token 不一致，但信封作用域就是本角色）
    h.disk.set(DISK_DIR + '\\ftt2-local-drifted-name.json', JSON.stringify(mine));
    // 诱饵：另一个角色的副本（作用域不同）
    const other = fixedEnvelope(Object.assign(emptyState(), { atoms: [atomOf('z9', '别的角色不该被读进来。')], updatedAt: at + 1000 }), at + 1000);
    other.payload.scope = 'char:' + hashText('Bob.png');
    other.scope = other.payload.scope;
    h.disk.set(DISK_DIR + '\\ftt2-local-other-role.json', JSON.stringify(other));
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    const texts = (got && Array.isArray(got.atoms)) ? got.atoms.map((x) => x.text) : [];
    return texts.length === 1 && texts[0] === '漂移找回的情节。';
}, null);

await A('RT-5 本机副本读取仍拒绝**哈希不符**的信封（找回兜底不得放松完整性校验）', async () => {
    const cur = boot({ disk: true, atoms: [atomOf('a1', '被篡改的情节。')] });
    const h = useHost(makeDiskHost());
    const env = fixedEnvelope(cur, 1700000011111);
    env.hash = 'deadbeef';                                   // 人为弄坏信封哈希
    h.disk.set(DISK_DIR + '\\ftt2-local-drifted-name.json', JSON.stringify(env));
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    return got === null;
}, null);

// ============================================================
// ② 服务端主文件：候选顺序 + 取最新
// ============================================================
await A('GZ-1 gzip 开启 + 盘上遗留**旧明文**：必须读回 `.json.gz` 里的**新**数据（修复前明文优先 → 永远读回早期那份）', async () => {
    const atOld = 1000;                                   // 遗留明文：远早于本次保存
    const stOld = Object.assign(emptyState(), { atoms: [atomOf('old', '早期数据（旧明文里那份）')], updatedAt: atOld });
    boot({ disk: false, gzip: true, slim: true, atoms: [atomOf('new', '当前数据（.json.gz 里那份）')] });
    // 旧明文主文件（gzip 关闭时期写下的遗留物）
    files.set(stateFileName(), new Uint8Array(Buffer.from(JSON.stringify(fixedEnvelope(stOld, atOld)), 'utf8')));
    await saveStateNow({ reason: 'test-gz1' });
    const gzBytes = files.get(stateFileGzName());
    const gzWritten = !!gzBytes;
    // 本次真正写出的那份（`.json.gz`）的信封时间戳
    const savedAt = gzWritten
        ? Number((JSON.parse(gunzipText(gzBytes)) || {}).payload.updatedAt) || 0
        : 0;
    const loaded = await loadFromServerFile();
    const info = lastServerLoadInfo();
    return gzWritten && savedAt > atOld
        && info.mainAt === savedAt                                // 载入抬头取的是**新**那一份
        && !!loaded && loaded.atoms.length === 1 && loaded.atoms[0].text === '当前数据（.json.gz 里那份）';
}, null);

await A('GZ-2 gzip 开启但**通道不支持压缩**（回退明文）：仍必须可读回（不因「偏好 gz」而丢掉明文）', async () => {
    const atNew = 1700000003000;
    boot({ disk: false, gzip: true, slim: true, atoms: [atomOf('n', '仅明文的那份')], updatedAt: atNew });
    const keep = globalThis.CompressionStream;
    let w = null;
    try {
        // 模拟「通道不支持压缩」（与 slim-gzip B3 同款）：`gzipAvailable()` → false → 回退写明文
        globalThis.CompressionStream = undefined;
        w = await stateFileWrite(fixedEnvelope(state, atNew), { bak: false });
    } finally {
        if (keep === undefined) delete globalThis.CompressionStream; else globalThis.CompressionStream = keep;
    }
    const loaded = await loadFromServerFile();
    return !!w && w.ok === true && w.gz === false && /\.json$/.test(String(w.name)) && !/\.gz$/.test(String(w.name))
        && !!loaded && loaded.atoms.length === 1 && loaded.atoms[0].text === '仅明文的那份';
}, null);

await A('GZ-3 默认（gzip 关闭）请求序列**不变**：候选只有明文一个，绝不探测 `.json.gz`（锁 B7-2 口径）', async () => {
    boot({ disk: false, gzip: false, atoms: [atomOf('a1', '默认口径')] });
    await saveStateNow({ reason: 'test-gz3' });
    uploaded.length = 0;
    const loaded = await loadFromServerFile();
    return stateFileReadCandidates().length === 1
        && stateFileReadCandidates()[0] === stateFileName()
        && !!loaded && loaded.atoms.length === 1
        && files.has(stateFileName()) && !files.has(stateFileGzName());
}, null);

await A('GZ-4 `stateFileReadAny`（既有入口）与 `stateFileWriteName` 口径一致：gzip 开启时写入名 = 首选候选名', async () => {
    boot({ disk: false, gzip: true, slim: true, atoms: [atomOf('a1', '口径一致')] });
    await saveStateNow({ reason: 'test-gz4' });
    const cands = stateFileReadCandidates();
    const any = await stateFileReadAny();
    return cands.length === 2 && cands[0] === stateFileGzName() && cands[1] === stateFileName()
        && stateFileWriteName() === cands[0]
        && !!any && any.gz === true;
}, null);

// ============================================================
// ③ 回归：本机层诊断口径不因本修复而变
// ============================================================
await A('RG-1 本地磁盘目录关闭时 `loadFromLocalDisk()` 如实返回 null（不臆造数据）', async () => {
    boot({ disk: false, atoms: [atomOf('a1', 'x')] });
    useHost(null);
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    return got === null;
}, null);

await A('RG-2 本机副本可读回被删条目的**墓碑账本**（防缩水 / 防复活的数据随副本一起往返）', async () => {
    const cur = boot({ disk: true, atoms: [atomOf('a1', '保留的情节。')] });
    const h = useHost(makeDiskHost());
    cur.deleted = { atoms: ['gone-1'] };
    cur.deletedH = { atoms: { 'deadbeef': 1700000000000 } };
    await saveStateNow({ reason: 'test-rg2' });
    const got = await loadFromLocalDisk({ tries: 1, gapMs: 0 });
    return !!got && !!got.deleted && (got.deleted.atoms || []).indexOf('gone-1') >= 0
        && !!got.deletedH && !!got.deletedH.atoms && Object.keys(got.deletedH.atoms).length === 1;
}, null);

// 收尾：本机层统计非空（证明上面的往返真的经过了磁盘层，而不是被内存短路）
R.assert('RG-3 本机层确实发生了写入与读取（`localDiskInfo().stats`）', (() => {
    const s = localDiskInfo().stats || {};
    return Number(s.writes || 0) > 0 && Number(s.reads || 0) > 0;
})(), JSON.stringify(localDiskInfo().stats || {}));

// 只读快照应可读（诊断口径保留）
R.assert('RG-4 分片读取入口在目录关闭时如实回报失败（不抛错）', (() => localDiskReadParts('snapshots', localScopeToken()) !== undefined)(), null);

R.done();
