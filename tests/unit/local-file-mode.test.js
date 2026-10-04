// ============================================================
// 单元测试 · v3.16.0「本地文件存储模式」（替代变量层 · 避免超出本地化限制）
//
// 用户要求（原话）：「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，避免超出限制。
//   但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式。」
//
// 口径：
//   · **留空 = 不开启**：零行为变化（本机缓冲照旧写 localStorage 变量）；
//   · 路径只允许**宿主数据目录之内**：盘符 / 前导斜杠 / `..` 剥离，非法字符转 `_`；
//   · 开启后本机缓冲层**改写宿主的本地文件**（不再写变量层）；写失败**回退变量层**（不丢数据）；
//   · 开启/关闭时自动**对齐两层**（变量 ↔ 文件）：先写 → 回读逐字节校验 → 才清源；任一步失败都不清数据。
// 运行：node tests/unit/local-file-mode.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { scopeId } from '../../core/state.js';
import {
    setStorageHooks, saveStateNow, localBufferState, localLayerInfo, switchLocalLayer, loadFromLocalFile,
    invalidateLocalBufferCache,
} from '../../adapters/store.js';
import {
    localFileEnable, localFileEnabled, localFilePath, localFilePathSanitize, localFileName, localFileNs,
    localFileWrite, localFileRead, localFileStatsGet,
} from '../../adapters/local-file.js';
import { ttResetSession } from '../../adapters/tt-store.js';
import { syncAction, storagePageHtml, SYNC_ACTIONS } from '../../ui/sync.js';
import { applySettingsControl, SETTINGS_CONTROLS, settingsControlHtml } from '../../ui/settings-pages.js';

const R = makeReporter('local-file-mode v3.16.0 本地文件存储模式（替代变量层）');
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
    const abi = { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store } } };
    return { abi, store, kv, blobs, calls };
}

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({}), doc);
const lsMap = new Map();                      // 变量层（localStorage）替身
let host = null;

function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.storage = Object.assign({}, cfg.storage, o.storage || {});
    setScopeKey('char:localfile');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文。' }] }), doc);
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'lf-a1', text: '甲在码头清点货物并登记入册。', title: '清点', tags: [], floorStart: 0, floorEnd: 0 }],
        memories: [{ id: 'lf-m1', title: '账册', content: '账册记着三只木箱。' }],
    }));
    lsMap.clear();
    setStorageHooks({ getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => { if (o.setItemFail) return false; lsMap.set(k, String(v)); return true; }, removeItem: (k) => { lsMap.delete(k); return true; } });
    invalidateLocalBufferCache();
    ttResetSession();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    host = makeHost2(o.host || {});
    if (o.native !== false) { try { globalThis.window.__TAURITAVERN__ = host.abi; } catch (e) { /* 忽略 */ } }
    ttResetSession();
    return host;
}
const lsKey = () => 'ftt2_state_' + scopeId();

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

await A('A3 开启后本机缓冲写**文件**、不再写变量层（`localBufferState().layer = local-file`）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    const r = await saveStateNow({ force: true });
    const info = localLayerInfo();
    const nsKeys = Array.from(host.kv.keys()).concat(Array.from(host.blobs.keys()));
    const hit = nsKeys.filter((x) => x.indexOf('ftt2-local/local/') === 0);
    return r && r.ok !== false && localFileEnable() === true
        && hit.length === 1                                  // 恰好一个文件（命名空间 = 约定目录）
        && lsMap.size === 0                                  // 变量层**一个键都没写**
        && info.enabled === true && info.path === 'ftt2-local'
        && localBufferState().layer === 'local-file'
        && localFileName(scopeId()).indexOf('ftt2-local/ftt2-local-') === 0
        && localFileNs() === 'ftt2-local';
}, () => ({ info: localLayerInfo(), keys: Array.from(host.kv.keys()) }));

await A('A4 文件写失败 → **回退变量层**（本机缓冲不丢；如实标注 layer=localStorage 与原因）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    // 无宿主 + 酒馆文件接口不可用（未桩 fetch → 失败）→ 文件写必然失败 → 回退变量层
    ttResetSession();
    const r = await saveStateNow({ force: true });
    const st = localBufferState();
    return r && lsMap.has(lsKey()) && String(lsMap.get(lsKey())).length > 100
        && st.layer === 'localStorage' && st.ok === true
        && localFileStatsGet().failures >= 1;
}, () => ({ st: localBufferState(), lsChars: String(lsMap.get(lsKey()) || '').length }));

await A('A5 迁移（开启）：「先写 → 回读校验 → 才清变量层」；迁移结果如实回报', async () => {
    boot({ storage: { localFilePath: '' } });
    await saveStateNow({ force: true });                     // 先按变量层写一份
    const before = String(lsMap.get(lsKey()) || '');
    cfg.storage.localFilePath = 'ftt2-local';
    const r = await switchLocalLayer();
    const fr = await localFileRead(scopeId());
    return before.length > 100 && r.ok === true && r.action === 'migrated' && r.cleared === 1
        && fr.ok === true && fr.text === before                  // 文件内容与变量层逐字节一致
        && !lsMap.has(lsKey());                                  // 校验通过后才清变量键
}, () => ({ r: null, ls: lsMap.size }));

await A('A6 校验失败**不清数据**：文件写入「成功」但回读内容不一致 → 变量层原样保留', async () => {
    boot({ storage: { localFilePath: '' } });
    await saveStateNow({ force: true });
    const before = String(lsMap.get(lsKey()) || '');
    // 让宿主读回时返回被篡改的内容（写入成功、回读不一致）
    const bogus = { k: 'b64', v: Buffer.from('{"v":1,"scope":"x","payload":{"data":{"atoms":[]}},"hash":"deadbeef"}', 'utf8').toString('base64'), ts: Date.now() };
    host.store.tryGetJson = async () => ({ found: true, value: bogus });
    cfg.storage.localFilePath = 'ftt2-local';
    const r = await switchLocalLayer();
    return r.ok === false && r.action === 'error' && lsMap.has(lsKey()) && String(lsMap.get(lsKey())) === before;
}, () => ({ ls: lsMap.size }));

await A('A7 关闭时**迁回**变量层：文件有内容而变量层为空 → 回填变量层（文件保留当备份）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });                     // 写文件
    const fr = await localFileRead(scopeId());
    lsMap.clear();                                            // 模拟「变量层被清掉」
    cfg.storage.localFilePath = '';
    const r = await switchLocalLayer();
    return fr.ok === true && r.ok === true && r.action === 'restored'
        && String(lsMap.get(lsKey()) || '') === String(fr.text || '')
        && localFileEnable() === false;
}, () => ({ ls: lsMap.size }));

await A('A8 载入：`loadFromLocalFile()` 解析并校验信封；哈希不一致 → 丢弃（返回 null）', async () => {
    boot({ storage: { localFilePath: 'ftt2-local' } });
    await saveStateNow({ force: true });
    const ok = await loadFromLocalFile();
    // 篡改文件内容后应被哈希校验拦下
    const key = Array.from(host.kv.keys()).concat(Array.from(host.blobs.keys())).filter((x) => x.indexOf('ftt2-local/local/') === 0)[0];
    if (key && host.kv.has(key)) { const v = host.kv.get(key); host.kv.set(key, Object.assign({}, v, { v: Buffer.from('{"payload":{"data":{"atoms":[]}},"hash":"deadbeef"}').toString('base64') })); }
    else if (key) { host.blobs.set(key, new Uint8Array(Buffer.from('{"payload":{"data":{"atoms":[]}},"hash":"deadbeef"}', 'utf8'))); }
    const bad = await loadFromLocalFile();
    return ok && (ok.atoms || []).length === 1 && (ok.memories || []).length === 1 && bad === null;
}, () => ({ ok: !!(localBufferState()) }));

await A('B1 设定-存储：出现「本地文件目录」控件（text 输入 + 留空即不开启的说明），且动作在存储页可达', async () => {
    boot({ storage: { localFilePath: '' } });
    const ctrls = SETTINGS_CONTROLS.storage.map((c) => c.key);
    const html = String(storagePageHtml(SETTINGS_CONTROLS.storage) || '');
    const input = settingsControlHtml({ key: 'storage.localFilePath', label: '本地文件目录（留空 = 不开启）', type: 'text' });
    return ctrls.indexOf('storage.localFilePath') >= 0
        && input.indexOf('data-ftt-cfg="storage.localFilePath"') > 0 && input.indexOf('type="text"') > 0
        && html.indexOf('data-ftt-local-file-status') > 0 && html.indexOf('data-ftt-action="localFileAlign"') > 0
        && SYNC_ACTIONS.indexOf('localFileAlign') >= 0 && SYNC_ACTIONS.indexOf('localFileStatusRefresh') >= 0;
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
    return a1.ok !== false && String(a1.note).indexOf('本机层') >= 0
        && a2.ok === true && String(a2.note).indexOf('本地文件模式') >= 0
        && a2.detail && a2.detail.enabled === true;
}, () => ({ a1: null }));

R.done();
