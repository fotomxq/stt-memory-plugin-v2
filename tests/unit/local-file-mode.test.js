// ============================================================
// 单元测试 · 本地目录存储模式（v3.16.0「替代变量存储」→ v3.26.0「只留目录 + 服务端」+ 目录选择器）
//
// 用户要求（原话，v3.16.0）：「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，
//   避免超出限制。但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式。」
// 用户要求（原话，v3.26.0）：
//   ①「设置本机缓冲时，除了保留当前的 input，还需增加选择目录，可手动选择目录。」
//   ②「如果设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储。」
//
// 口径（v3.26.0 生效）：
//   · **留空 = 不开启**：零行为变化（本机缓冲照旧写 localStorage 变量 + 内存库）；
//   · 路径只允许**宿主数据目录之内**：盘符 / 前导斜杠 / `..` 剥离，非法字符转 `_`；
//   · **目录模式**：本机缓冲只写目录文件；**变量层与内存库不写也不读**（读路径同样跳过）；
//     目录写失败**不回退变量层**（回退等于偷偷写回用户明确要求停用的那一层），如实回报失败；
//   · 目录选择器：候选（预设 + 用过的目录）/ 新建（写探针 → 回读校验 → 采用）/ 系统文件夹（只取名字）/
//     校验当前目录；**校验不过绝不改配置**；
//   · 开启/关闭自动对齐：开启 → 变量层与内存库里较新的那份迁进目录并**清两层**（先写 → 回读校验 → 才清）；
//     关闭 → 目录内容迁回两层。任一步失败都不清数据。
// 运行：node tests/unit/local-file-mode.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, kernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { storageHash } from '../../core/envelope.js';
import { emptyState } from '../../core/state.js';
import { scopeId } from '../../core/state.js';
import {
    setStorageHooks, saveStateNow, localBufferState, localLayerInfo, switchLocalLayer, loadFromLocalFile,
    invalidateLocalBufferCache, pickLocalSource, localLayerReadProbe,
} from '../../adapters/store.js';
import {
    localFileEnable, localFileEnabled, localFilePath, localFilePathSanitize, localFileName, localFileNs, localFileNsLegacy,
    localFileWrite, localFileRead, localFileStatsGet, localFileFileKey, localFilePathAudit, localFileDirCandidates, localFileDirHistory,
    localFileDirRemember, localFileDirScanHost, localFileProbeDir, localFileRealLocation, LOCAL_DIR_HISTORY_MAX,
} from '../../adapters/local-file.js';
import { ttResetSession } from '../../adapters/tt-store.js';
import { syncAction, storagePageHtml, SYNC_ACTIONS } from '../../ui/sync.js';
import { applySettingsControl, SETTINGS_CONTROLS, settingsControlHtml } from '../../ui/settings-pages.js';
import { pickDirectoryName } from '../../ui/file-io.js';
import { loadMemoryState } from '../../index.js';
import { getCtx } from '../../host/st-api.js';

const R = makeReporter('local-file-mode v3.26.0 本地目录模式（只留目录 + 服务端）+ 目录选择器');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

/** 宿主桩：官方扩展存储（KV/Blob），记录每个 key 落在哪个命名空间 */
function makeHost2(opts) {
    const o = opts || {};
    const kv = new Map(); const blobs = new Map();
    const calls = { setJson: 0, setBlob: 0, getBlob: 0, tryGetJson: 0, listBlobKeys: 0 };
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const store = {
        async setJson(a) { calls.setJson++; if (o.setError) throw new Error(o.setError); kv.set(k(a), a.value); },
        async tryGetJson(a) { calls.tryGetJson++; return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { if (!kv.has(k(a))) throw new Error('Not found: ' + k(a)); return kv.get(k(a)); },
        async deleteJson(a) { kv.delete(k(a)); },
        async listKeys(a) {
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
        async setBlob(a) {
            calls.setBlob++; if (o.blobError) throw new Error(o.blobError);
            const d = a.data; blobs.set(k(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || []));
        },
        async getBlob(a) { calls.getBlob++; if (!blobs.has(k(a))) throw new Error('Not found: ' + k(a)); return new Blob([blobs.get(k(a))]); },
        async deleteBlob(a) { blobs.delete(k(a)); },
        async listBlobKeys(a) {
            calls.listBlobKeys++;
            const p = String(a.namespace) + '/' + String(a.table || 'main') + '/';
            return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length));
        },
    };
    // v3.26.0：宿主**可选**的目录枚举能力（只有显式给了才存在 —— 与真机「契约里没有」一致）
    if (o.listNamespaces) store.listNamespaces = async () => o.listNamespaces;
    const abi = { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store } } };
    return { abi, store, kv, blobs, calls };
}

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({}), doc);
const lsMap = new Map();                      // 变量层（localStorage）替身
const idbMap = new Map();                     // 内存库（localforage）替身
let idbReads = 0, idbWrites = 0;
let host = null;

function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.storage = Object.assign({}, cfg.storage, o.storage || {});
    setScopeKey('char:localfile');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    // 注意：内存库（localforage）是从**宿主上下文**里取的（`getCtx().libs.localforage`），
    //   故这里必须安装**同一个** host 实例，否则本地库桩取不到（会让断言变成「永远没读」的假通过）。
    const h = makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文。' }] });
    installGlobalHost(h, doc);
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'lf-a1', text: '甲在码头清点货物并登记入册。', title: '清点', tags: [], floorStart: 0, floorEnd: 0 }],
        memories: [{ id: 'lf-m1', title: '账册', content: '账册记着三只木箱。' }],
    }));
    lsMap.clear();
    idbMap.clear();
    idbReads = 0; idbWrites = 0;
    setStorageHooks({ getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => { if (o.setItemFail) return false; lsMap.set(k, String(v)); return true; }, removeItem: (k) => { lsMap.delete(k); return true; } });
    // 内存库桩：走宿主 `ctx.libs.localforage`（与生产同一取值路径）
    h.ctx.libs = {
        localforage: {
            getItem: async (k) => { idbReads += 1; return idbMap.has(k) ? JSON.parse(JSON.stringify(idbMap.get(k))) : null; },
            setItem: async (k, v) => { idbWrites += 1; idbMap.set(k, JSON.parse(JSON.stringify(v))); return v; },
            removeItem: async (k) => { idbMap.delete(k); return true; },
            keys: async () => Array.from(idbMap.keys()),
        },
    };
    invalidateLocalBufferCache();
    ttResetSession();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.showDirectoryPicker; } catch (e) { /* 忽略 */ }
    host = makeHost2(o.host || {});
    if (o.native !== false) { try { globalThis.window.__TAURITAVERN__ = host.abi; } catch (e) { /* 忽略 */ } }
    ttResetSession();
    return host;
}
const lsKey = () => 'ftt2_state_' + scopeId();
/** 目录文件是否落在这个命名空间下（`<ns>/local/`） */
const dirKeys = (ns) => Array.from(host.kv.keys()).concat(Array.from(host.blobs.keys())).filter((x) => x.indexOf(ns + '/local/') === 0);

await A('A1 **留空 = 不开启**：路径归一为空 → 不动作（写/读都返回 off），也不碰任何存储', async () => {
    boot({ storage: { localFilePath: '' } });
    const w = await localFileWrite('x', scopeId());
    const r = await localFileRead(scopeId());
    return localFileEnable() === false && localFileEnabled() === false && localFilePath() === ''
        && w.ok === false && w.reason === 'off' && r.ok === false && r.reason === 'off'
        && host.calls.setJson === 0 && host.calls.setBlob === 0 && lsMap.size === 0;
}, () => ({ info: localFileStatsGet() }));

await A('A2 路径归一：只保留**宿主数据目录之内**的相对目录（剥盘符 / 前导斜杠 / `..`，非法字符转 `_`）', async () => {
    const cases = [
        ['D:\\FTT\\data', 'FTT/data'], ['/abs/ftt', 'abs/ftt'], ['../x', 'x'], ['我的 数据', '我的_数据'],
        ['a//b/', 'a/b'], ['..', ''], ['', ''], ['   ', ''], ['ftt2-local', 'ftt2-local'],
    ];
    const bad = cases.filter(([inp, want]) => localFilePathSanitize(inp) !== want);
    return bad.length === 0;
}, () => ({ cases: ['D:\\FTT\\data', '/abs/ftt', '../x', '我的 数据', 'a//b/', '..'].map((x) => localFilePathSanitize(x)) }));

await A('A3 目录模式：本机缓冲写**目录**、不写变量层**也不写内存库**（`memLayersDisabled` 为真）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    const r = await saveStateNow({ force: true });
    const info = localLayerInfo();
    return r && r.ok !== false && localFileEnable() === true
        && dirKeys('ftt2-local').length === 1                  // 恰好一个目录文件（命名空间 = 约定目录）
        && lsMap.size === 0                                    // 变量层一个键都没写
        && idbWrites === 0                                     // 内存库一次都没写（v3.26.0）
        && String(r.via || '').indexOf('localStorage') < 0 && String(r.via || '').indexOf('indexedDB') < 0
        && info.enabled === true && info.path === 'ftt2-local' && info.memLayersDisabled === true
        && Number(info.idbSkipped) >= 1
        && localBufferState().layer === 'local-file'
        && localFileName(scopeId()).indexOf('ftt2-local/ftt2-local-') === 0
        && localFileNs() === 'ftt2-local';
}, () => ({ info: localLayerInfo(), keys: Array.from(host.kv.keys()), via: null }));

await A('A4 目录写失败：**不回退变量层**（如实回报失败；变量层与内存库都不写）—— v3.26.0 改判', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    ttResetSession();
    const r = await saveStateNow({ force: true });
    const st = localBufferState();
    return r && lsMap.size === 0 && idbWrites === 0
        && st.layer === 'local-file' && st.ok === false && st.skipped === 'write-failed'
        && String(st.reason || '').indexOf('不回退变量层') > 0
        && localFileStatsGet().failures >= 1;
}, () => ({ st: localBufferState(), lsChars: String(lsMap.get(lsKey()) || '').length }));

await A('A5 迁移（开启）：「先写 → 回读校验 → 才清两层」；源取**较新的那份**并如实回报', async () => {
    boot({ storage: { localFilePath: '' } });
    await saveStateNow({ force: true });                     // 先按变量层 + 内存库写一份
    const before = String(lsMap.get(lsKey()) || '');
    // 内存库放一份**更新的**信封（v3.26.0：两层一起看，取新者为源）
    const newer = JSON.parse(before);
    newer.payload.updatedAt = Number((newer.payload && newer.payload.updatedAt) || 0) + 5000;
    newer.payload.data.atoms = (newer.payload.data.atoms || []).concat([{ id: 'lf-from-idb', text: '只在内存库里的条目。', title: '内存库', tags: [] }]);
    idbMap.set(lsKey(), newer);
    cfg.storage.localFilePath = 'ftt2-local';
    const r = await switchLocalLayer();
    const fr = await localFileRead(scopeId());
    return before.length > 100 && r.ok === true && r.action === 'migrated' && r.from === 'idb'
        && r.cleared === 1 && r.idbCleared === true
        && fr.ok === true && String(fr.text).indexOf('lf-from-idb') > 0   // 迁进目录的是**内存库那份**
        && !lsMap.has(lsKey()) && !idbMap.has(lsKey())                   // 校验通过后才清两层
        && localFileDirHistory().indexOf('ftt2-local') >= 0;             // 用过的目录进了候选清单
}, () => ({ ls: lsMap.size, idb: idbMap.size }));

await A('A6 校验失败**不清数据**：目录写入「成功」但回读内容不一致 → 变量层与内存库都原样保留', async () => {
    boot({ storage: { localFilePath: '' } });
    await saveStateNow({ force: true });
    const before = String(lsMap.get(lsKey()) || '');
    const idbBefore = idbMap.has(lsKey());
    // 让宿主读回时返回被篡改的内容（写入成功、回读不一致）
    const bogus = { k: 'b64', v: Buffer.from('{"v":1,"scope":"x","payload":{"data":{"atoms":[]}},"hash":"deadbeef"}', 'utf8').toString('base64'), ts: Date.now() };
    host.store.tryGetJson = async () => ({ found: true, value: bogus });
    cfg.storage.localFilePath = 'ftt2-local';
    const r = await switchLocalLayer();
    return r.ok === false && r.action === 'error' && lsMap.has(lsKey()) && String(lsMap.get(lsKey())) === before
        && idbMap.has(lsKey()) === idbBefore;
}, () => ({ ls: lsMap.size }));

await A('A7 关闭时**迁回两层**：目录有内容而两层都空 → 变量层与内存库同时回填（目录文件保留当备份）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });                     // 写目录
    const fr = await localFileRead(scopeId());
    lsMap.clear(); idbMap.clear();                            // 模拟「两层都被清掉」
    cfg.storage.localFilePath = '';
    const r = await switchLocalLayer();
    return fr.ok === true && r.ok === true && r.action === 'restored'
        && String(lsMap.get(lsKey()) || '') === String(fr.text || '')
        && idbMap.has(lsKey())
        && localFileEnable() === false;
}, () => ({ ls: lsMap.size, idb: idbMap.size }));

await A('A8 载入：`loadFromLocalFile()` 解析并校验信封；哈希不一致 → 丢弃（返回 null）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const ok = await loadFromLocalFile();
    // 篡改文件内容后应被哈希校验拦下
    const key = dirKeys('ftt2-local')[0];
    if (key && host.kv.has(key)) { const v = host.kv.get(key); host.kv.set(key, Object.assign({}, v, { v: Buffer.from('{"payload":{"data":{"atoms":[]}},"hash":"deadbeef"}').toString('base64') })); }
    else if (key) { host.blobs.set(key, new Uint8Array(Buffer.from('{"payload":{"data":{"atoms":[]}},"hash":"deadbeef"}', 'utf8'))); }
    const bad = await loadFromLocalFile();
    return ok && (ok.atoms || []).length === 1 && (ok.memories || []).length === 1 && bad === null;
}, () => ({ ok: !!(localBufferState()) }));

await A('C1 `pickLocalSource` 纯函数：取 `updatedAt` 更新的那份；两份都坏/都空 → from 为空（不拿坏数据覆盖）', async () => {
    const mk = (at, marks) => JSON.stringify({ payload: { updatedAt: at, data: { processedFloors: new Array(marks).fill({ f: 1 }) } } });
    const a = pickLocalSource(mk(100, 1), mk(200, 5));
    const b = pickLocalSource(mk(300, 7), mk(200, 5));
    const c = pickLocalSource('', mk(50, 2));
    const d = pickLocalSource('not-json', '');
    const e = pickLocalSource(mk(100, 1), mk(100, 9));
    return a.from === 'idb' && b.from === 'variable' && c.from === 'idb'
        && d.from === '' && d.text === '' && e.from === 'variable';
}, () => ({ a: pickLocalSource('{"payload":{"updatedAt":1}}', '{"payload":{"updatedAt":2}}') }));

await A('B1 设定-存储：**原 input 仍在** + 目录选择器出现 + 5 个选择目录动作可达', async () => {
    boot({ storage: { localFilePath: '' } });
    const ctrls = SETTINGS_CONTROLS.storage.map((c) => c.key);
    const html = String(storagePageHtml(SETTINGS_CONTROLS.storage) || '');
    const input = settingsControlHtml({ key: 'storage.localFilePath', label: '本地文件目录（留空 = 不开启）', type: 'text' });
    const acts = ['localFileDirUse', 'localFileDirCreate', 'localFileDirSystem', 'localFileDirScan', 'localFileDirProbe'];
    return ctrls.indexOf('storage.localFilePath') >= 0
        && input.indexOf('data-ftt-cfg="storage.localFilePath"') > 0 && input.indexOf('type="text"') > 0
        && html.indexOf('data-ftt-local-file-status') > 0 && html.indexOf('data-ftt-action="localFileAlign"') > 0
        && html.indexOf('data-ftt-local-dir-picker') > 0 && html.indexOf('data-ftt-local-dir-new') > 0
        && html.indexOf('真实落盘') > 0
        && acts.every((x) => SYNC_ACTIONS.indexOf(x) >= 0);
}, () => ({ ctrls: SETTINGS_CONTROLS.storage.map((c) => c.key) }));

await A('B2 改路径即落盘 + 归一 + 触发对齐（`applySettingsControl` 返回 switched:true）', async () => {
    boot({ storage: { localFilePath: '' } });
    const r = applySettingsControl('storage.localFilePath', 'D:\\FTT\\data');
    await new Promise((res) => setTimeout(res, 30));
    return r.ok === true && r.switched === true && cfg.storage.localFilePath === 'FTT/data'
        && localFilePath() === 'FTT/data';
}, () => ({ cfg: (cfg.storage || {}).localFilePath }));

await A('B3 存储页动作 `localFileAlign` / `localFileStatusRefresh` 经 `syncAction` 可达并回填提示', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const a1 = await syncAction('localFileAlign', {});
    const a2 = await syncAction('localFileStatusRefresh', {});
    // v3.26.5：目录副本已是最新时对齐是**核对**（`verified`）而不是「迁移」—— 提示相应改为「目录副本已核对（未覆盖）」
    return a1.ok !== false && /目录副本已核对|本机层/.test(String(a1.note))
        && a1.detail && String(a1.detail.action) === 'verified'
        && a2.ok === true && String(a2.note).indexOf('本地文件模式') >= 0
        && a2.detail && a2.detail.enabled === true;
}, () => ({ a1: null }));

await A('B4 目录候选：预设 + 用过的目录（去重 / 最近在前 / 上限 ' + LOCAL_DIR_HISTORY_MAX + ' / 落**配置**不落变量层）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local', localFileDirs: [] } });
    const r1 = localFileDirRemember('导出目录');
    const r2 = localFileDirRemember('存档/甲');
    const r3 = localFileDirRemember('导出目录');            // 重复 → 提到最前，不新增
    const cand = localFileDirCandidates();
    const paths = cand.items.map((x) => x.path);
    const histBeforeBatch = localFileDirHistory();
    for (let i = 0; i < 12; i++) localFileDirRemember('批量' + i);
    const hist = localFileDirHistory();
    const presets = paths.filter((p) => p === 'ftt2-files' || p === 'ftt2-local');
    return r1.ok === true && r2.ok === true && r3.ok === true
        && histBeforeBatch[0] === '导出目录' && histBeforeBatch.length === 2
        && hist.length === LOCAL_DIR_HISTORY_MAX && hist[0] === '批量11'
        && presets.length === 2
        && Array.isArray(cfg.storage.localFileDirs) && cfg.storage.localFileDirs.length === LOCAL_DIR_HISTORY_MAX
        && cand.items.some((x) => x.current === true)
        && cand.host && cand.host.supported === false;       // 宿主桩未提供枚举能力 → 如实 false
}, () => ({ hist: localFileDirHistory() }));

await A('B5 目录探针：可写目录 ok（探针**写完即删**）；不可写目录 ok=false 且不抛', async () => {
    boot({ storage: { localFilePath: '' } });
    const ok = await localFileProbeDir('校验目录');
    const left = dirKeys(localFileNs('校验目录'));
    // 换一个「写必失败」的宿主：原生不可用 + 无 fetch → 写不进
    boot({ storage: { localFilePath: '' }, native: false });
    const bad = await localFileProbeDir('写不进去');
    return ok.ok === true && ok.path === '校验目录' && ok.ns === localFileNs('校验目录')
        && /^[A-Za-z0-9_.-]+$/.test(ok.ns)                    // 命名空间必须是宿主允许的字符集
        && left.length === 0                                  // 探针文件已清理
        && bad.ok === false && typeof bad.error === 'string' && bad.error.length > 0;
}, () => ({ }));

await A('B6 `localFileDirUse`：采用候选目录 → 配置落盘 + 三层对齐（迁移 + 清两层）+ 进候选清单', async () => {
    boot({ storage: { localFilePath: '' } });
    await saveStateNow({ force: true });                     // 先在变量层/内存库有数据
    const r = await syncAction('localFileDirUse', { dir: '选定目录' });
    const fr = await localFileRead(scopeId());
    return r.ok === true && cfg.storage.localFilePath === '选定目录'
        && fr.ok === true && !lsMap.has(lsKey()) && !idbMap.has(lsKey())
        && localFileDirHistory().indexOf('选定目录') >= 0
        && String(r.note).indexOf('选定目录') > 0 && String(r.note).indexOf('探针校验通过') > 0;
}, () => ({ r: null, cfgPath: cfg.storage.localFilePath }));

await A('B7 `localFileDirCreate`：新建并校验后采用；**校验不过绝不改配置**（不给用户切到写不进去的目录）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    const okR = await syncAction('localFileDirCreate', { dir: '新建目录' });
    const okPath = cfg.storage.localFilePath;
    // 换成写必失败的宿主 → 新建校验必然失败
    boot({ storage: { localFilePath: 'ftt2-local' }, native: false });
    const badR = await syncAction('localFileDirCreate', { dir: '写不进去' });
    const empty = await syncAction('localFileDirCreate', { dir: '   ' });
    return okR.ok === true && okPath === '新建目录'
        && badR.ok === false && cfg.storage.localFilePath === 'ftt2-local'
        && empty.ok === false && String(empty.note).indexOf('请先') >= 0;
}, () => ({ okPath: null }));

await A('B8 `localFileDirSystem`：系统文件夹只取**名字**（如实告知宿主限制）；空文件夹如实说明', async () => {
    boot({ storage: { localFilePath: '' } });
    globalThis.showDirectoryPicker = async () => ({ name: '系统选中的目录' });
    const r = await syncAction('localFileDirSystem', {});
    delete globalThis.showDirectoryPicker;
    // 空文件夹：`<input webkitdirectory>` 只在含文件时返回路径 → 如实回报 empty-folder
    const orig = doc.createElement;
    doc.createElement = () => ({
        style: {}, setAttribute() { }, click() { if (this.onchange) this.onchange(); },
        files: [], addEventListener() { }, remove() { },
    });
    const r2 = await syncAction('localFileDirSystem', {});
    doc.createElement = orig;
    return r.ok === true && cfg.storage.localFilePath === '系统选中的目录'
        && String(r.note).indexOf('宿主限制') > 0
        && r2.ok === false && String(r2.note).indexOf('空') > 0;
}, () => ({ cfgPath: cfg.storage.localFilePath }));

await A('B9 `localFileDirScan`：宿主**没有**枚举能力 → 如实回报 no-api；宿主提供 → 列出目录', async () => {
    boot({ storage: { localFilePath: '' } });
    const no = await localFileDirScanHost();
    const r1 = await syncAction('localFileDirScan', {});
    boot({ storage: { localFilePath: '' }, host: { listNamespaces: ['甲目录', '乙 目录'] } });
    const yes = await localFileDirScanHost();
    return no.ok === false && no.reason === 'no-api' && no.dirs.length === 0
        && r1.ok === false && String(r1.note).indexOf('扫描未成功') >= 0
        && yes.ok === true && yes.dirs.length === 2 && yes.dirs[1] === '乙_目录'   // 归一后入列
        && localFileDirCandidates().host.supported === true;
}, () => ({ yes: null }));

await A('B10 `localFileRealLocation` 如实给出真实落盘位置（宿主原生 → 扩展存储目录；**两种通道都列出** + 真实键名；不假装能选任意磁盘路径）', async () => {
    boot({ storage: { localFilePath: '我的目录' } });
    const r = localFileRealLocation('我的目录', 'char:abc123');
    const ns = localFileNs('我的目录');
    const off = localFileRealLocation('');
    // v3.26.0：非 ASCII 目录名的命名空间会带**路径短哈希**（否则中文目录会双双变成 `____` 互相覆盖）
    // v3.26.5（真机取证）：本机缓冲信封必然 ≥96KB → 实际落在 `blobs/local/`（旧文案只写 kv/local/ → 用户照它去找会找不到）；
    //   文件名也含目录前缀（磁盘上叫 `ftt2-local_ftt2-local-char_abc123.json`），故 `key` 必须与磁盘逐字一致。
    const blob = r.files.filter((x) => x.channel === 'blob')[0] || {};
    const kv = r.files.filter((x) => x.channel === 'kv')[0] || {};
    const key = localFileFileKey('char:abc123');
    return r.known === true && r.backend === 'tt-native'
        && r.text.indexOf('_tauritavern/extension-store/' + ns + '/') > 0
        && r.text.indexOf('blobs/local/') > 0
        && r.key === key && key.indexOf('ftt2-local-char_abc123.json') > 0
        && blob.path === '_tauritavern/extension-store/' + ns + '/blobs/local/' + key
        && kv.path === '_tauritavern/extension-store/' + ns + '/kv/local/' + key
        && ns !== '我的目录' && ns.indexOf('-') > 0 && localFileNs('剧情目录') !== ns
        && off.text.indexOf('未开启') >= 0;
}, () => ({ real: localFileRealLocation('我的目录', 'char:abc123'), ns: localFileNs('我的目录') }));

await A('B12 命名空间碰撞修复 + 旧命名空间只读兼容：不同中文目录不再写进同一个命名空间', async () => {
    boot({ storage: { localFilePath: '记忆缓冲' } });
    const a = localFileNs('记忆缓冲');
    const b = localFileNs('剧情缓冲');
    const legacy = localFileNsLegacy('记忆缓冲');
    await saveStateNow({ force: true });
    const onNew = dirKeys(a).length;
    // 把这份内容改放到**旧命名空间**（模拟 v3.16.0~v3.25.x 写下的数据）→ 仍应能读回
    const key = dirKeys(a)[0];
    const val = host.kv.get(key);
    const tail = String(key).slice(String(key).indexOf('/local/'));
    host.kv.delete(key);
    host.kv.set(legacy + tail, val);
    const r = await localFileRead(scopeId());
    return a !== b && a !== legacy && legacy === '____'
        && onNew === 1 && r.ok === true && r.legacyNs === true && String(r.text).length > 100;
}, () => ({ a: localFileNs('记忆缓冲'), b: localFileNs('剧情缓冲'), legacy: localFileNsLegacy('记忆缓冲') }));

await A('B11 `pickDirectoryName`：优先 `showDirectoryPicker`（空文件夹也能拿到名字）；不可用时报错不抛', async () => {
    boot({ storage: {} });
    globalThis.showDirectoryPicker = async () => ({ name: '空目录也行' });
    const a = await pickDirectoryName({});
    globalThis.showDirectoryPicker = async () => { const e = new Error('The user aborted a request'); throw e; };
    const b = await pickDirectoryName({});
    delete globalThis.showDirectoryPicker;
    const orig = doc.createElement;
    doc.createElement = () => ({ style: {}, setAttribute() { }, click() { if (this.onchange) this.onchange(); }, files: [{ webkitRelativePath: '甲乙/一.txt' }], remove() { } });
    const c = await pickDirectoryName({});
    doc.createElement = orig;
    return a.ok === true && a.name === '空目录也行' && a.via === 'picker'
        && b.ok === false && b.reason === 'cancelled'
        && c.ok === true && c.name === '甲乙' && c.via === 'webkitdirectory';
}, () => ({ }));

await A('C2 载入路径：目录模式下 `loadMemoryState()` **不读变量层也不读内存库**（只认目录 + 服务端）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await loadMemoryState();                                 // 先让宿主角色 → 作用域落地（后续都按同一作用域造数据）
    const sc = scopeId();
    const key = 'ftt2_state_' + sc;
    await saveStateNow({ force: true });                     // 目录里有一份（1 原子 + 1 记忆）
    const dirRaw = String((await localFileRead(sc)).text);
    const env = JSON.parse(dirRaw);
    env.payload.updatedAt = Number(env.payload.updatedAt || 0) - 1000;         // 目录那份更旧
    env.payload.data.atoms = (env.payload.data.atoms || []).concat([{ id: 'lf-dir-only', text: '目录独有。', title: '目录', tags: [] }]);
    env.hash = storageHash(env.payload);                     // 改过载荷 → 必须重算信封哈希（否则会被校验丢弃）
    await localFileWrite(JSON.stringify(env), sc);
    // 变量层与内存库各埋一份**更新的、带独有条目**的副本 → 目录模式下它们必须被无视
    const ghost = JSON.parse(JSON.stringify(env));
    ghost.payload.updatedAt = Number(ghost.payload.updatedAt || 0) + 999999;
    ghost.payload.data.atoms = [{ id: 'lf-ghost', text: '停用层里的幽灵条目。', title: '幽灵', tags: [] }];
    ghost.hash = storageHash(ghost.payload);
    lsMap.set(key, JSON.stringify(ghost));
    idbMap.set(key, ghost);
    const reads0 = idbReads;
    const r = await loadMemoryState();
    const ids = ((kernelState() && kernelState().atoms) || []).map((x) => x.id);
    return ids.indexOf('lf-ghost') < 0                       // 幽灵条目没被并集进来
        && ids.indexOf('lf-dir-only') >= 0                   // 目录那份是唯一本机真相
        && idbReads === reads0                               // 内存库一次都没读
        && lsMap.has(key);                                   // 变量层里的旧副本原样未动
}, () => ({ via: null }));

// ============================================================
// v3.26.5（用户报告：「本机缓冲设计可能存在问题，保存到本地文件后，是否没有正常读取和写入？
//   请修复相关问题。如果设置了，则内存和变量及传统本地存储方案全部作废，仅采用本地文件存储。」）
//
// 真机只读取证（调试桥）：
//   · 目录**写**是正常的（`<ns>/blobs/local/ftt2-local_ftt2-local-char_xxxxxx.json` 一直在更新）；
//   · 但**界面与诊断都在说谎**：`localFileStatsGet().backend` 恒为 `''`（被统计对象里的空串覆盖）、
//     「真实落盘」只写 `kv/local/`（大信封实际在 `blobs/local/`）且文件名漏了目录前缀、
//     数据管理页在目录模式下只列「浏览器变量 / 内存库」两行（按设计恒为空）→ 整页看起来「本机什么都没有」；
//   · `ftt.loadDiag` 恒只查 localStorage → 目录模式恒报 `present:false`；
//   · 「立即对齐」在目录模式下拿变量层的**旧**内容覆盖目录文件（数据回退风险），换目录时不迁移旧目录内容。
// 本批：① 统计/位置/诊断如实；② 对齐「取最新、不覆盖、可换目录」；③ 目录模式**三层全停用**（+聊天元数据）。
// ============================================================
await A('D1 统计不再自相矛盾：`localFileStatsGet().backend` / `localLayerInfo().backend` = 真实后端（此前被统计对象里的空串覆盖 → 存储页恒显示「后端 —」）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const st = localFileStatsGet();
    const info = localLayerInfo();
    return st.backend === 'tt-native' && info.backend === 'tt-native'
        && Number(st.writes) >= 1 && Number(st.lastWriteAt) > 0 && Number(st.lastAt) > 0
        && String(info.fileKey) === localFileFileKey(scopeId())
        && String(info.fileKey).indexOf('ftt2-local_ftt2-local-char_') >= 0
        && Array.isArray(info.realFiles) && info.realFiles.some((x) => String(x.path).indexOf('/blobs/local/') > 0);
}, () => ({ st: localFileStatsGet(), info: localLayerInfo(), scope: scopeId() }));

await A('D2 `localLayerReadProbe` 按**模式**如实回报：目录模式下真的去读目录文件（命中 → 哈希一致 / 条数 / 时间戳；未命中 → 如实 miss），不再恒查 localStorage', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    const miss = await localLayerReadProbe();
    await saveStateNow({ force: true });
    const hit = await localLayerReadProbe();
    return miss.mode === 'local-file' && miss.present === false && miss.miss === true
        && hit.mode === 'local-file' && hit.present === true && hit.hashOk === true
        && Number(hit.bytes) > 0 && Number(hit.items) > 0 && Number(hit.at) > 0
        && String(hit.fileKey) === localFileFileKey(scopeId());
}, () => ({ hit: null, be: localFileStatsGet().backend }));

await A('D3 `pickLocalSource` 扩到四源（变量 / 内存库 / 目录 / 聊天元数据）：取 `updatedAt` 最新的一份；两参旧行为逐字不变（并列取变量层）', async () => {
    const env = (at) => JSON.stringify({ payload: { updatedAt: at, data: {} } });
    return pickLocalSource(env(100), env(200)).from === 'idb'
        && pickLocalSource(env(100), env(50), env(900), env(10)).from === 'file'
        && pickLocalSource(env(100), env(50), env(10), env(900)).from === 'chatmeta'
        && pickLocalSource(env(100), env(100)).from === 'variable'
        && pickLocalSource('', '').from === '' && pickLocalSource('bad', '').from === '';
}, () => ({}));

await A('D4 对齐**不再拿旧内容覆盖新目录**：目录副本已是最新 → `action=verified`（内容逐字不变、变量层不清）；变量层更新时才迁进目录并清变量层', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const key = lsKey();
    const dirBefore = String((await localFileRead(scopeId())).text);
    // ① 变量层塞一份**更旧**的副本 → 对齐只能校验、绝不能覆盖目录
    lsMap.set(key, JSON.stringify({ payload: { updatedAt: 1, data: { atoms: [{ id: 'stale-var', text: '旧内容。', title: '旧', tags: [] }] } } }));
    const r1 = await switchLocalLayer();
    const dirAfter1 = String((await localFileRead(scopeId())).text);
    const lsKept1 = lsMap.has(key);          // 必须在 r2 之前取（r2 会清变量层）
    // ② 变量层换成**更新**的一份 → 迁进目录 + 回读校验通过 + 清变量层
    const fresh = JSON.stringify({ payload: { updatedAt: Date.now() + 60000, data: { atoms: [{ id: 'fresh-var', text: '新内容。', title: '新', tags: [] }] } } });
    lsMap.set(key, fresh);
    const r2 = await switchLocalLayer();
    const dirAfter2 = String((await localFileRead(scopeId())).text);
    return r1.ok === true && r1.action === 'verified' && dirAfter1 === dirBefore && lsKept1
        && r2.ok === true && r2.action === 'migrated' && dirAfter2 === fresh && lsMap.has(key) === false;
}, () => ({ r: null }));

await A('D5 **换目录**：把「上一次用过的目录」里更新的一份迁进新目录（写 → 回读校验通过），旧目录文件保留不动', async () => {
    boot({ storage: { localFilePath: '目录甲' } });
    await saveStateNow({ force: true });
    const textA = String((await localFileRead(scopeId())).text);
    const nsA = localFileNs('目录甲');
    const keysA = dirKeys(nsA).slice();
    // 切到「目录乙」（配置已改）→ 旧目录甲里的内容必须迁过来（先清掉聊天元数据，避免别处遗留的更新副本抢走「最新」）
    try { getCtx().chatMetadata = {}; } catch (e) { /* 忽略 */ }
    cfg.storage.localFilePath = '目录乙';
    const r = await switchLocalLayer({ previousPath: '目录甲' });
    const textB = await localFileRead(scopeId());
    return r.ok === true && r.action === 'moved-dir'
        && textB.ok === true && String(textB.text) === textA
        && dirKeys(nsA).length === keysA.length && dirKeys(nsA).length > 0;      // 旧目录原样保留
}, () => ({ moved: null }));

await A('D6 目录模式下**聊天元数据层也不读**（只留目录 + 服务端）；关闭目录模式后恢复并集（对照）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const sc = scopeId();
    // chatMetadata 里放一份「更新」且带独有条目的副本（V2 只读它，从不写）
    const metaState = Object.assign(emptyState(), {
        updatedAt: Date.now() + 999999,
        atoms: [{ id: 'lf-meta-only', text: '聊天元数据独有条目。', title: '元数据', tags: [] }],
    });
    const CTX = getCtx();
    CTX.chatMetadata = {};
    CTX.chatMetadata['ftt_memory_v2'] = { format: 'ftt-memory-v2-meta', version: '1', at: Date.now() + 999999, scope: sc, state: metaState };
    const rDir = await loadMemoryState();
    const idsDir = ((kernelState() && kernelState().atoms) || []).map((x) => x.id);
    // 关闭目录模式 → 同一份 chatMetadata 应当重新被并集进来（证明「是目录模式让它停用」而不是数据不可用）
    cfg.storage.localFilePath = '';
    const rOff = await loadMemoryState();
    const idsOff = ((kernelState() && kernelState().atoms) || []).map((x) => x.id);
    return idsDir.indexOf('lf-meta-only') < 0 && idsOff.indexOf('lf-meta-only') >= 0
        && !!rDir && !!rOff;
}, () => ({ meta: null }));

await A('D7 v3.27.1 路径审计：**填绝对路径会被归一成命名空间名**（盘符/前导斜杠/`..` 被剥、多级折叠），如实列出原因；拿得到数据根目录时给出「目录联接」命令与真实落点', async () => {
    boot({ storage: { localFilePath: 'fft_v2_store' } });
    // ① 绝对路径（真机场景：用户填 D:\Downloads\stn\fft_v2_store）
    const a1 = localFilePathAudit('D:\\Downloads\\stn\\fft_v2_store', 'C:\\data-root');
    // ② 纯相对目录名 → 无改写
    const a2 = localFilePathAudit('fft_v2_store', 'C:\\data-root');
    // ③ 上跳 / 前导斜杠 → 剥掉
    const a3 = localFilePathAudit('/abs/../x', 'C:\\data-root');
    return a1.remapped === true && a1.effective === 'Downloads/stn/fft_v2_store'
        && a1.reasons.join('|').indexOf('盘符') >= 0 && a1.reasons.join('|').indexOf('命名空间') >= 0
        && a1.real.indexOf('_tauritavern/extension-store/') > 0
        && !!a1.junction && a1.junction.command.indexOf('mklink /J') === 0
        && a1.junction.command.indexOf('_tauritavern\\extension-store\\') > 0
        && a1.junction.from.indexOf('C:\\data-root') === 0 && a1.junction.to === 'D:\\Downloads\\stn\\fft_v2_store'
        && a2.remapped === false && a2.effective === 'fft_v2_store' && a2.junction === null
        && a3.effective === 'abs/x' && a3.remapped === true;
}, () => ({ audit: localFilePathAudit('D:\\Downloads\\stn\\fft_v2_store', 'C:\\data-root') }));

// ============================================================
// v3.28.1（用户要求）：「如果写盘失败回退浏览器层，但必须明显提醒用户，且标记用户设置的路径无效。」
// ============================================================
await A('E1 本地磁盘目录**写盘失败 → 回退浏览器层**：变量层真的写入、内存库照写、该路径被标记「无效」，并**弹一次醒目提醒**', async () => {
    boot({ storage: { localFilePath: '', localDiskDir: 'D:\\不可写\\store' } });   // 宿主无 dev 文件 API → 能力缺失 → 必然写失败
    const RT2 = await import('../../core/model/runtime.js');
    const LD = await import('../../adapters/local-disk.js');
    const toasts = [];
    RT2.setNotifyHooks({ toast: (text, kind) => { toasts.push({ text: String(text), kind: String(kind) }); return true; } });
    invalidateLocalBufferCache();
    const saved = await saveStateNow({ force: true });
    const b = localBufferState();
    const inf = LD.localDiskInfo();
    const ok = saved && saved.ok !== false && b && String(b.layer) === 'localStorage'
        && String(lsMap.get(lsKey()) || '').length > 100            // 回退真的写进了浏览器变量层
        && idbWrites > 0                                            // 内存库照写（回退口径一致）
        && inf.invalid && inf.invalid.invalid === true              // 路径被标记无效
        && toasts.some((t) => t.kind === 'warning' && t.text.indexOf('本地磁盘目录') > 0);
    RT2.setNotifyHooks({});
    return ok;
}, () => ({ info: localDiskInfo(), layer: localBufferState() }));

await A('E2 该路径重新「校验」通过 → 无效标记清除（可恢复正常磁盘层）', async () => {
    const h = boot({ storage: { localFilePath: '', localDiskDir: 'D:\\可写\\store' } });
    const LD = await import('../../adapters/local-disk.js');
    // 装上「dev 文件 API」能力（内存盘桩）：写 → 回读一致
    const disk = new Map();
    h.abi.api.dev = {
        files: {
            async writeTextFile(a) { disk.set(String(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
            async readTextFile(a) { const k = String(a.path); if (!disk.has(k)) throw new Error('ENOENT'); return { text: disk.get(k) }; },
        },
    };
    ttResetSession();
    LD.localDiskReprobe();
    LD.localDiskMarkInvalid('D:\\可写\\store', 'test', 'x');      // 先人为标记无效
    const pr = await LD.localDiskProbeDir('D:\\可写\\store');      // 校验通过 → 清除
    const inf = LD.localDiskInfo();
    return pr.ok === true && inf.invalid.invalid === false && disk.size > 0;
}, () => ({ info: localDiskInfo() }));

// ============================================================
// v3.33.0（用户要求）：「本地存储路径不能随服务端转移」
// v3.34.0（用户要求）：「兼容 android 端的 TauriTavern；当前存在问题可能是方法用错了，会弹出报错」
// ============================================================
await A('E3 存储页如实说明**设备本地**：路径只存本机（不随服务端同步）+ 本机平台 + 跨平台路径告警 + **不再有候选目录按钮**（用户明确不要）', async () => {
    boot({ storage: { localFilePath: '', localDiskDir: 'D:\\FTT\\store' } });
    const LD = await import('../../adapters/local-disk.js');
    // 假装本机是 Android：`D:\…` 这种从桌面同步过来的路径必须**当场点明**（否则用户只会看到「校验失败」）
    try { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36' } }); } catch (e) { /* 忽略 */ }
    LD.localDiskReset();
    const html = String(storagePageHtml(SETTINGS_CONTROLS.storage) || '');
    const CS = await import('../../adapters/config-store.js');
    const snap = CS.deviceLocalCfgSnapshot();
    const d = LD.localDiskInfo();
    return html.indexOf('data-ftt-disk-platform') > 0 && html.indexOf('不随服务端同步') > 0
        && html.indexOf('data-ftt-disk-warn') > 0 && html.indexOf('Windows 路径') > 0
        && html.indexOf('只填一个') > 0                                        // 提示「只填目录名即可」
        && html.indexOf('localDiskDirs') < 0 && html.indexOf('localDiskDirUse') < 0   // 候选目录已移除
        && d.platform === 'android' && String(d.pathWarn).length > 0
        && snap.keys.indexOf('storage.localDiskDir') >= 0;
}, () => ({ info: localDiskInfo() }));

await A('E4 存储页动作 `localDiskProbe`：只填**目录名** → 解析到宿主应用数据目录 → 探针通过 → 把**完整路径写回**本机配置', async () => {
    boot({ storage: { localFilePath: '', localDiskDir: 'fft_v2_store' } });
    const LD = await import('../../adapters/local-disk.js');
    LD.localDiskReset();
    // TauriTavern 口径的宿主桩：路径插件（AppLocalData=15）+ fs（写 = 原始字节 + headers.path）
    const disk = new Map();
    let wroteProbe = 0;
    try {
        globalThis.window.__TAURI_INTERNALS__ = {
            invoke: async (cmd, arg, opt) => {
                const headers = (opt && opt.headers) || {};
                if (cmd === 'plugin:path|resolve_directory') { if (Number(arg && arg.directory) === 15) return '/data/user/0/com.tauritavern.client/files'; throw new Error('denied'); }
                if (cmd === 'plugin:fs|mkdir') return null;
                if (cmd === 'plugin:fs|exists') return disk.has(String(arg && arg.path));
                if (cmd === 'plugin:fs|remove') { disk.delete(String(arg && arg.path)); return null; }
                if (cmd === 'plugin:fs|read_text_file') { const k = String(arg && arg.path); if (!disk.has(k)) throw new Error('ENOENT'); return new TextEncoder().encode(String(disk.get(k))); }
                if (cmd === 'plugin:fs|write_text_file') {
                    if (!(arg instanceof Uint8Array) || !headers.path) throw new Error('invalid args: missing file path');
                    const full = decodeURIComponent(String(headers.path));
                    disk.set(full, new TextDecoder('utf-8').decode(arg));
                    if (/ftt2-local-probe\.json$/.test(full)) wroteProbe++;
                    return null;
                }
                throw new Error('not allowed: ' + cmd);
            },
        };
    } catch (e) { /* 忽略 */ }
    ttResetSession();
    LD.localDiskReprobe();
    const pr = await syncAction('localDiskProbe', {});
    const okDir = String((cfg.storage || {}).localDiskDir || '');
    // 宿主拒绝写入（放行范围外）→ 探针如实失败，**不把配置改坏**
    try { globalThis.window.__TAURI_INTERNALS__.invoke = async (cmd) => { if (cmd === 'plugin:fs|mkdir') return null; throw new Error('forbidden path'); }; } catch (e) { /* 忽略 */ }
    LD.localDiskReset();
    LD.localDiskReprobe();
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '/storage/emulated/0/不许可/store' });
    const bad = await syncAction('localDiskProbe', {});
    return pr.ok === true && okDir === '/data/user/0/com.tauritavern.client/files/fft_v2_store'
        && wroteProbe >= 1 && disk.size === 0 && String(pr.note).indexOf('应用数据目录') < 0 && String(pr.note).indexOf('可写') > 0
        && bad.ok === false && String(bad.note).indexOf('应用数据目录') > 0
        && String((cfg.storage || {}).localDiskDir) === '/storage/emulated/0/不许可/store';
}, () => ({ cfg: (cfg.storage || {}).localDiskDir }));

R.done();
