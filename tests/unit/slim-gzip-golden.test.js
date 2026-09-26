// ============================================================
// 单元测试 · B9-d 条目瘦身 + gzip 存储（与**真实 V1 插件**逐项比对 + V2 读写向后兼容 + 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/fixtures/gen-v1-golden-slim-gzip.cjs` 直调生成）：
//   tests/fixtures/v1-golden-slim-gzip.json
//   （瘦身：slimEntryForStorage / hydrateSlimEntry / slimDataForStorage / hydrateStorageData /
//     snapshotIndexFrom / slimSnapshotStoreForStorage / hydrateSnapshotStore；
//    gzip：gzipToBase64 / gunzipFromBytes / bytesToBase64 / base64ToBytes / 写入路径（桩 fetch 捕获 base64 →
//     解字节 → 魔数比对）/ stateFileReadAny（按内容魔数读回））
// 覆盖：R1–R8 V1 逐项比对；B1–B4 **读写向后兼容**（明文旧文件可读 / gzip 新文件可读 / 压缩失败回退明文 / 默认关闭零变化）；
//   V1–V4 V2 编排与接线（保存流水线、UI 说明行、FTT 入口 + devtools typeof 守卫）。
// 说明：gzip 字节**不跨 V1/V2 比对**（两版信封字段不同），比对的是「命名/魔数/解出结构/瘦身键集/读回还原」；
//   V2 自身写入的字节长度与哈希另外做自一致性断言。
// ============================================================
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { storageEnvelope, storageHash } from '../../core/envelope.js';
import { dataAggHash } from '../../core/cross-sync.js';
import {
    SLIM_HASHED_FIELDS, SLIM_SYNONYM_GROUPS, isSlimDefault, slimEntryForStorage, hydrateSlimEntry,
    slimDataForStorage, hydrateStorageData, snapshotIndexFrom, slimSnapshotStoreForStorage, hydrateSnapshotStore,
} from '../../core/slim.js';
import {
    gzipToBase64, gunzipFromBytes, bytesToBase64, base64ToBytes, isGzipBytes, textToBytes, bytesToText, gzipAvailable,
} from '../../adapters/gzip.js';
import {
    setSyncStorageHooks, stateFileName, stateFileGzName, stateFileWriteName, snapshotFileName, snapshotFileGzName,
    snapshotFileWriteName, bakFileName, bakGzName, stateFileWrite, stateFileReadAny, snapshotFilePushNow,
    snapshotFileReadAny, slimFileEnvelope, slimGzipInfo, stateFileSlimOn, stateFileGzipOn, stateFileReadCandidates,
    fileCacheDropAll, resetSyncState, resetRemoteMarks,
} from '../../adapters/sync.js';
import { readStateFileAuto, uploadStateFileGz } from '../../adapters/user-file.js';
import { saveStateNow, setStorageHooks, loadFromServerFile } from '../../adapters/store.js';
import { slimGzipInfoHtml, storagePageHtml } from '../../ui/sync.js';
import { SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-slim-gzip.json'), 'utf8'));
const R = makeReporter('slim-gzip-golden B9-d 条目瘦身 + gzip 存储（V1 对齐 + 向后兼容）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 字节精确的内存文件系统（ST 用户目录；gzip 必须按原始字节往返） ----------
const files = new Map();                 // name → Uint8Array
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const unHost = installGlobalHost(host, doc);
const unFetch = installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        const b64 = String(body.data || '');
        const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
        files.set(String(body.name), bytes);
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

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

// 写入路径场景：**与 V1 oracle 同一原子/快照副本**（键集可直接与 fixture 比对）
const GZ_ATOM = G.scenario.atom;
const GZ_SNAP = {
    id: 'snap_g1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1',
    atomsHashes: { a1: 'h1' },
    atoms: { a1: { id: 'a1', __cat: 'atoms', text: '艾芙琳在红唇酒吧见到线人', title: '酒馆会面', content: '艾芙琳在红唇酒吧见到线人', tags: ['会面'], uses: 0 } },
};

/** 重启测试环境；`slim`/`gzip` 对应 `cfg.storage.stateFileSlim` / `stateFileGzip` */
function boot(opts) {
    const o = opts || {};
    resetSyncState(); resetRemoteMarks();
    files.clear(); lsm.clear(); fileCacheDropAll();
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage.stateFile = true; cfg.storage.stateFileBak = true; cfg.storage.snapshotFile = true;
    cfg.storage.syncMetaProbe = false; cfg.storage.syncLogServer = false;
    cfg.storage.stateFileSlim = o.slim === true;
    cfg.storage.stateFileGzip = o.gzip === true;
    setScopeKey('甲');
    setIdentityView({ characterName: '角色甲' });
    setKernelState(Object.assign(emptyState(), clone(o.state || { atoms: [clone(GZ_ATOM)], snapStore: [clone(GZ_SNAP)], snapFp: {}, updatedAt: 1700000000000 })));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return state;
}
/** 固定信封时间戳（`storageEnvelope` 取 Date.now → 会让 gzip 字节每次不同；测试只关心结构，但仍固定以便比对长度） */
function fixedEnvelope(st) {
    const env = storageEnvelope(st);
    env.ts = 1700000000000;
    if (env.payload) { env.payload.updatedAt = 1700000000000; env.hash = storageHash(env.payload); }
    return env;
}
/** 落盘文件解码（Node `zlib` 解 gzip —— 与浏览器端 CompressionStream 为**跨实现**互验） */
const gzOf = (name) => {
    const b = files.get(name);
    if (!b) return null;
    const gz = b[0] === 0x1f && b[1] === 0x8b;
    const text = gz ? gunzipSync(Buffer.from(b)).toString('utf8') : Buffer.from(b).toString('utf8');
    return { magic: [b[0], b[1]], gz, text };
};
const jsonOf = (name) => { const g = gzOf(name); if (!g) return null; try { return JSON.parse(g.text); } catch (e) { return null; } };

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================
R.assert('R1 slimEntryForStorage(atoms)：键集与逐字段输出与 V1 逐字一致（同义 content 去掉 / 空默认值不写 / extra 只留独有槽位）', (() => {
    const s = slimEntryForStorage('atoms', clone(G.scenario.atom));
    return J(Object.keys(s).sort()) === J(G.slimEntries.atom.keys) && J(s) === J(G.slimEntries.atom.out)
        && s.content === undefined && s.location === undefined && s.keywords === undefined
        && Array.isArray(s.extra) && s.extra.length === 1 && s.extra[0].name === 'unknownField';
})(), '');

R.assert('R2 hydrateSlimEntry 还原四域（atoms/scenes/currentStates/rumors）：键集与输出与 V1 逐字一致（同义回填 + name/title 缺一补一）', (() => {
    const bad = [];
    for (const k of ['atom', 'scene', 'stateRow', 'rumor']) {
        const cat = G.slimEntries[k].cat;
        const s = slimEntryForStorage(cat, clone(G.scenario[k]));
        const h = hydrateSlimEntry(cat, clone(s));
        if (J(s) !== J(G.slimEntries[k].out)) bad.push([k, 'slim', s]);
        if (J(Object.keys(h).sort()) !== J(G.hydratedEntries[k].keys)) bad.push([k, 'hydKeys', Object.keys(h).sort()]);
        if (J(h) !== J(G.hydratedEntries[k].out)) bad.push([k, 'hyd', h]);
    }
    return bad.length === 0
        && hydrateSlimEntry('scenes', clone(slimEntryForStorage('scenes', clone(G.scenario.scene)))).pathStr === '港区>酒吧'
        && hydrateSlimEntry('currentStates', clone(slimEntryForStorage('currentStates', clone(G.scenario.stateRow)))).content === '70';
})(), '');

R.assert('R3 瘦身**不改变内容哈希**（V1 黄金值 `hashKeep.before = hashKeep.after`，且 V2 与 V1 同值）', (() => {
    const before = dataAggHash({ atoms: [clone(G.scenario.atom)] });
    const hyd = hydrateStorageData(slimDataForStorage({ atoms: [clone(G.scenario.atom)] }));
    const after = dataAggHash({ atoms: hyd.atoms });
    return G.hashKeep.same === true && G.hashKeep.before === G.hashKeep.after
        && before === after && before === G.hashKeep.before;
})(), (() => ({ golden: G.hashKeep, v2: dataAggHash({ atoms: [clone(G.scenario.atom)] }) }))());

R.assert('R4 slimDataForStorage：数据体键集/`snapIndex`/快照剥离与 V1 逐字一致（无 snapStore/snapFp/scope；keepSnap 保留完整链）', (() => {
    const data = {
        scope: 'char:should-be-deleted',
        atoms: [clone(G.scenario.atom)], scenes: [clone(G.scenario.scene)], currentStates: [clone(G.scenario.stateRow)], rumors: [clone(G.scenario.rumor)],
        memories: [], items: [], plans: [], suspense: [], concepts: [], parallels: [], links: [], plotSegments: [],
        snapStore: [{ id: 'root_1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1', atoms: {}, atomsHashes: { a1: 'h1' } }],
        snapFp: { a1: { h: 'h1', cat: 'atoms' } }, updatedAt: 1700000000000,
    };
    const keep = slimDataForStorage(clone(data), { keepSnap: false });
    const keepSnap = slimDataForStorage(clone(data), { keepSnap: true });
    const keysOk = J(Object.keys(keep).sort()) === J(G.slimData.keys);
    const hydKeys = J(Object.keys(hydrateStorageData(clone(keep))).sort()) === J(G.slimData.hydratedKeys);
    return keysOk && hydKeys && J(keep.snapIndex) === J(G.slimData.snapIndex)
        && keep.snapStore === undefined && keep.snapFp === undefined && keep.scope === undefined
        && (keepSnap.snapStore !== undefined && keepSnap.snapStore.length === 1)
        && G.slimData.hasSnapStore === false && G.slimData.hasScope === false && G.slimData.keepSnapHasSnapStore === true;
})(), '');

R.assert('R5 snapshotIndexFrom：轻量索引（id/kind/ts/baseId/hash/covered）+ 无 id 过滤与 V1 逐字一致', (() => {
    const out = snapshotIndexFrom([
        { id: 'root_1', kind: 'root', ts: 1, baseId: null, hash: 'h1', atomsHashes: { a1: 'h1', a2: 'h2' } },
        { id: '', kind: 'root', ts: 2 },
    ]);
    return J(out) === J(G.snapIndex) && out.length === 1 && out[0].covered === 2;
})(), '');

R.assert('R6 slimSnapshotStoreForStorage / hydrateSnapshotStore：链内 atoms 逐条瘦身 + 还原与 V1 逐字一致（保留 deleted 与 atomsHashes）', (() => {
    // 与 V1 oracle 同一输入（快照副本含 `__cat` + 与 text 全等的 content + 默认 uses:0）
    const snapAtomIn = { id: 'a1', __cat: 'atoms', text: '艾芙琳在红唇酒吧见到线人', title: '酒馆会面', content: '艾芙琳在红唇酒吧见到线人', tags: ['会面'], uses: 0 };
    const snaps = [{ id: 'root_1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1', atomsHashes: { a1: 'h1' }, atoms: { a1: snapAtomIn }, deleted: { atoms: ['gone'] } }];
    const slim = slimSnapshotStoreForStorage(clone(snaps));
    const hyd = hydrateSnapshotStore(clone(slim));
    return J(slim) === J(G.slimSnapshot.out)
        && J(Object.keys(slim[0]).sort()) === J(G.slimSnapshot.keys)
        && J(Object.keys(slim[0].atoms.a1).sort()) === J(G.slimSnapshot.atomKeys)
        && J(Object.keys(hyd[0].atoms.a1).sort()) === J(G.slimSnapshot.hydratedAtomKeys)
        && J(hyd[0].atoms.a1) === J(G.slimSnapshot.hydratedAtom);
})(), '');

await A('R7 gzip 原语往返：gzipToBase64 → base64ToBytes（魔数 1f 8b）→ gunzipFromBytes 文本全等 + base64 反向一致 + 体积显著下降', async () => {
    const text = JSON.stringify({ atoms: Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, text: '艾芙琳在红唇酒吧与线人交谈，讨论维蒂帮的走私路线。'.repeat(2), title: '会面' + i })) });
    const gz = await gzipToBase64(text);
    const u8 = base64ToBytes(gz.b64);
    const back = await gunzipFromBytes(u8);
    const rawLen = Buffer.byteLength(text, 'utf8');
    return gz.ok === true && G.gzipRoundTrip.ok === true
        && u8[0] === G.gzipRoundTrip.magic[0] && u8[1] === G.gzipRoundTrip.magic[1]
        && isGzipBytes(u8) === true && back === text && back === text
        && bytesToBase64(u8) === gz.b64
        && u8.length < rawLen * 0.6 && G.gzipRoundTrip.shrinkRatio < 0.6
        && bytesToText(textToBytes('中文往返')) === '中文往返'
        && gzipAvailable() === true;
}, (() => ({ gzMagic: G.gzipRoundTrip.magic, ratio: G.gzipRoundTrip.shrinkRatio }))());

await A('R8 写入路径（瘦身 + gzip 开启）：主/备份/快照文件名 `.json.gz`、内容魔数、主文件仅留 snapIndex、备份保留完整链、快照链瘦身，读回按魔数解压并还原', async () => {
    boot({ slim: true, gzip: true });
    const w = await stateFileWrite(fixedEnvelope(state), { bak: true });
    const main = gzOf(w.name), bak = gzOf(w.uploaded[0] === w.name ? bakGzName() : bakGzName());
    const snap = gzOf(snapshotFileGzName());
    const mainJson = jsonOf(w.name);
    const bakJson = jsonOf(bakGzName());
    const snapJson = jsonOf(snapshotFileGzName());
    const back = await stateFileReadAny();
    const backAtom = ((back.env || {}).payload || {}).data ? back.env.payload.data.atoms[0] : null;
    const okMain = !!w.ok && w.gz === true && w.slim === true
        && /\.json\.gz$/.test(w.name) && w.name === stateFileGzName()
        && main && main.magic[0] === 0x1f && main.magic[1] === 0x8b
        && mainJson.payload.data.snapStore === undefined && mainJson.payload.data.snapFp === undefined
        && Array.isArray(mainJson.payload.data.snapIndex) && mainJson.payload.data.snapIndex.length === 1
        && J(Object.keys(mainJson.payload.data.atoms[0]).sort()) === J(G.writePath.main.atomKeys)
        && String(mainJson.hash) === storageHash(mainJson.payload);
    const okBak = !!bak && bak.magic[0] === 0x1f && bakJson.payload.data.snapStore !== undefined && G.writePath.bak.hasSnapStore === true;
    const okSnap = !!snap && snap.magic[0] === 0x1f && snapJson.count === 1 && !!snapJson.snapFp
        && J(Object.keys(snapJson.snapStore[0].atoms.a1).sort()) === J(G.writePath.snap.atomKeys);
    const okBack = !!back.env && back.from === 'state' && back.name === stateFileGzName()
        && (back.env.payload.data.atoms || []).length === 1
        && backAtom && backAtom.text === GZ_ATOM.text && backAtom.content === GZ_ATOM.text
        && backAtom.name === GZ_ATOM.title
        && J(Object.keys(backAtom).sort()) === J(G.readPath.atomKeys);
    return okMain && okBak && okSnap && okBack;
}, (() => ({ golden: { main: G.writePath.main.atomKeys, bak: G.writePath.bak, snap: G.writePath.snap } }))());

// ============================================================
// B 组：读写向后兼容（本批硬要求）
// ============================================================
await A('B1 明文旧文件仍可读：磁盘上是明文 `.json`（无 gzip 开关）→ `stateFileReadAny` 按内容魔数识别并正常解析', async () => {
    boot({});
    const envPlain = fixedEnvelope(state);
    files.set(stateFileName(), new Uint8Array(Buffer.from(JSON.stringify(envPlain), 'utf8')));
    const r = await stateFileReadAny();
    const auto = await readStateFileAuto(stateFileName());
    return !!r.env && r.from === 'state' && r.gz === false
        && (r.env.payload.data.atoms || []).length === 1
        && r.env.payload.data.atoms[0].text === GZ_ATOM.text
        && auto.ok === true && auto.gz === false && JSON.parse(auto.text).payload.data.atoms.length === 1
        && G.legacyPlainRead.atoms === 1;
}, '');

await A('B2 gzip 新文件可读（默认关闭的实例也能读对端写的 `.json.gz`）：魔数识别 → 解压 → JSON 解析（不依赖扩展名）', async () => {
    boot({});                                   // 注意：本实例**未开启** gzip 开关
    const envGz = fixedEnvelope(state);
    const gz = await gzipToBase64(JSON.stringify(envGz));
    files.set(stateFileGzName(), base64ToBytes(gz.b64));
    const auto = await readStateFileAuto(stateFileGzName());
    const r = await stateFileReadAny();          // 读候选名在开关关闭时只含明文名 → 这里以直读魔数路径断言
    const parsed = auto.ok ? JSON.parse(auto.text) : null;
    return auto.ok === true && auto.gz === true
        && parsed && parsed.payload.data.atoms.length === 1 && parsed.payload.data.atoms[0].text === GZ_ATOM.text
        && r.env === null                                  // 开关关闭 → 不探测 `.json.gz`（请求序列与 B7-2 一致）
        && stateFileReadCandidates().length === 1;
}, '');

await A('B3 压缩失败回退明文：通道不支持压缩（移除 CompressionStream）→ 写 `.json` 明文且内容为 JSON（V1 同款回退）', async () => {
    boot({ slim: true, gzip: true });
    const saved = globalThis.CompressionStream;
    try {
        // 模拟「不支持压缩」：整体移除（`gzipAvailable` → false → `uploadStateFileGz` 直接失败）
        // eslint-disable-next-line no-global-assign
        globalThis.CompressionStream = undefined;
        const r = await uploadStateFileGz(stateFileGzName(), '{"x":1}');
        const w = await stateFileWrite(fixedEnvelope(state), { bak: false });
        const g = gzOf(w.name);
        const text = g ? g.text : '';
        return r.ok === false && r.reason === 'no-gzip'
            && w.ok === true && w.gz === false && /\.json$/.test(w.name) && w.name === stateFileName()
            && g && g.magic[0] !== 0x1f && text.charAt(0) === '{'
            && G.gzUnavailableFallback.isPlainJson === true && G.gzUnavailableFallback.bodyEndsJson === true;
    } finally {
        if (saved === undefined) delete globalThis.CompressionStream; else globalThis.CompressionStream = saved;
    }
}, '');

await A('B4 默认（两个开关均关闭）行为与 B7-2 完全一致：写入名为明文 `.json`、内容不瘦身（保留 snapStore）、上传非 gzip', async () => {
    boot({});
    const w = await stateFileWrite(fixedEnvelope(state), { bak: true });
    const main = gzOf(w.name);
    const json = jsonOf(w.name);
    const auto = await readStateFileAuto(stateFileName());
    return stateFileSlimOn() === false && stateFileGzipOn() === false
        && w.ok === true && w.gz === false && w.slim === false && w.name === stateFileName()
        && /\.json$/.test(w.name) && main.magic[0] === 0x7b                       // '{'
        && json.payload.data.snapStore !== undefined && json.payload.data.snapIndex === undefined
        && auto.ok === true && auto.gz === false
        && slimFileEnvelope(fixedEnvelope(state), false).payload.data.snapStore === undefined;   // 显式调用才瘦身
}, '');

await A('B5 开启 gzip 时读取候选名含 gz 优先 + 明文兜底（写入名/快照写入名同步切换）', async () => {
    boot({ gzip: true });
    const cands = stateFileReadCandidates();
    return cands.length === 2 && cands[0] === stateFileGzName() && cands[1] === stateFileName()
        && stateFileWriteName() === stateFileGzName() && snapshotFileWriteName() === snapshotFileGzName()
        && /\.json\.gz$/.test(stateFileGzName()) && /\.json\.gz$/.test(snapshotFileGzName()) && /\.json\.gz$/.test(bakGzName());
}, '');

// ============================================================
// V 组：V2 编排与接线
// ============================================================
await A('V1 保存流水线（store.js）：开启瘦身+gzip 后 `saveStateNow` 写出的服务端主文件为 `.json.gz` 且仅留 snapIndex；`loadFromServerFile` 能把它读回来', async () => {
    boot({ slim: true, gzip: true, state: { atoms: [clone(GZ_ATOM)], snapStore: [clone(GZ_SNAP)], snapFp: {}, updatedAt: 1700000000000 } });
    // 保存流水线默认 800ms 防抖 → 直接调 saveStateNow
    await saveStateNow({ reason: 'test' });
    const mainBytes = files.get(stateFileGzName());
    const json = jsonOf(stateFileGzName());
    const loaded = await loadFromServerFile();
    return !!mainBytes && mainBytes[0] === 0x1f && mainBytes[1] === 0x8b
        && !!json && json.payload.data.snapStore === undefined
        && Array.isArray(json.payload.data.snapIndex) && json.payload.data.snapIndex.length === 1
        && !!loaded && Array.isArray(loaded.atoms) && loaded.atoms.length === 1 && loaded.atoms[0].text === GZ_ATOM.text;
}, '');

R.assert('V2 存储页说明行如实呈现开关与写入名（`slimGzipInfoHtml` 进入存储页「状态与操作」节）', (() => {
    boot({});
    const offHtml = slimGzipInfoHtml();
    const offInfo = slimGzipInfo();
    boot({ slim: true, gzip: true });
    const onHtml = slimGzipInfoHtml();
    const pageHtml = storagePageHtml(SETTINGS_CONTROLS.storage);
    // v2.56.0：说明行精简（去掉「通道支持压缩」「魔数」等实现细节），只留开关状态 + 当前写入名 + 旧文件仍可读
    return offHtml.indexOf('data-ftt-slim-gzip') >= 0 && offHtml.indexOf('条目瘦身 关闭（默认）') >= 0
        && offHtml.indexOf('gzip 写入 关闭（默认）') >= 0
        && offInfo.slim === false && offInfo.gzip === false && offInfo.gzipAvailable === true
        && offInfo.writeName === stateFileName() && offInfo.gzName === stateFileGzName()
        && onHtml.indexOf('条目瘦身 <b>已开启</b>') >= 0 && onHtml.indexOf('gzip 写入 <b>已开启</b>') >= 0
        && onHtml.indexOf('读取自动识别格式，旧文件仍可读') >= 0
        && onHtml.indexOf('魔数') < 0 && offHtml.indexOf('支持压缩') < 0
        && pageHtml.indexOf('data-ftt-slim-gzip') >= 0;
})(), '');

R.assert('V3 FTT 入口齐备（V1 `__FTT` 同名能力）：slimEntryForStorage / hydrateSlimEntry / slimDataForStorage / hydrateStorageData / snapshotIndexFrom / slimSnapshotStoreForStorage / hydrateSnapshotStore / gzipToBase64 / gunzipFromBytes / bytesToBase64 / base64ToBytes / slimFileEnvelope / slimInfo', (() => {
    boot({ slim: true, gzip: true });
    const on = installDevtools({
        slimEntryForStorage: (cat, it) => slimEntryForStorage(cat, it),
        hydrateSlimEntry: (cat, it) => hydrateSlimEntry(cat, it),
        slimDataForStorage: (d, o) => slimDataForStorage(d, o || {}),
        hydrateStorageData: (d) => hydrateStorageData(d),
        snapshotIndexFrom: (s) => snapshotIndexFrom(s),
        slimSnapshotStoreForStorage: (s) => slimSnapshotStoreForStorage(s),
        hydrateSnapshotStore: (s) => hydrateSnapshotStore(s),
        slimFileEnvelope: (e, k) => slimFileEnvelope(e, k === true),
        gzipToBase64: (t) => gzipToBase64(t),
        gunzipFromBytes: (u8) => gunzipFromBytes(u8),
        bytesToBase64: (u8) => bytesToBase64(u8),
        base64ToBytes: (b64) => base64ToBytes(b64),
        isGzipBytes: (u8) => isGzipBytes(u8),
        slimInfo: () => slimGzipInfo(),
    });
    const F = globalThis.FTT;
    const names = ['slimEntryForStorage', 'hydrateSlimEntry', 'slimDataForStorage', 'hydrateStorageData', 'snapshotIndexFrom',
        'slimSnapshotStoreForStorage', 'hydrateSnapshotStore', 'slimFileEnvelope', 'gzipToBase64', 'gunzipFromBytes',
        'bytesToBase64', 'base64ToBytes', 'isGzipBytes', 'slimInfo'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const slim = F.slimEntryForStorage('atoms', clone(G.scenario.atom));
    const info = F.slimInfo();
    const idx = F.snapshotIndexFrom([{ id: 'r1', kind: 'root', ts: 1, atomsHashes: { a: 1 } }]);
    uninstallDevtools();
    return on === true && missing.length === 0
        && J(slim) === J(G.slimEntries.atom.out)
        && info.slim === true && info.gzip === true && info.writeName === stateFileGzName()
        && idx.length === 1 && idx[0].covered === 1
        && globalThis.FTT === undefined;
})(), '');

await A('V4 FTT 无 hook 时按约定降级（不抛错）；devtools 侧 `typeof` 守卫生效', async () => {
    boot({});
    installDevtools({});
    const gz = await globalThis.FTT.gzipToBase64('x');
    const noHook = globalThis.FTT.slimEntryForStorage('atoms', { id: 'x' });
    const info = globalThis.FTT.slimInfo();
    uninstallDevtools();
    return gz && gz.ok === false && gz.b64 === ''
        && noHook === null && info === null
        && globalThis.FTT === undefined;
}, '');

unFetch();
unHost();
R.done();
