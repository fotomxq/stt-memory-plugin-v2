// ============================================================
// 单元测试 · v3.27.0「辅助数据（日志 / 时间线 / 标记 / 版本清单 / 快照副本）跟随本地目录统一收纳」
//
// 用户要求（原话）：「新版本，快照、日志等信息，也应该主动跟随本地存储变动。如设置了本地路径，则应该存储到
//   对应目录下统一管理收纳。其次，请完善本地目录设置，如果设置了则显示完成路径，而不是简单的目录名称。」
//
// 口径（`adapters/aux-store.js`）：
//   · **留空 = 不开启**：读写仍走 localStorage，行为逐字不变；
//   · 目录模式：同步 API 走内存缓存 + **防抖异步落盘**到目录命名空间的 `aux` 表（`aux-<键名>.json`）；
//   · **先写后清**迁移：启动时把 localStorage 旧值写进目录 → 回读校验 → 才删旧键；
//   · 快照链 / 同步日志：写完服务端后**额外收录一份**到同一目录（只读路径不变）。
//
// 运行：node tests/unit/aux-store.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setPersistHooks, setScopeKey, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    auxFacade, auxFileName, auxLsGet, auxLsSet, auxLsRemove,
    auxStoreInit, auxStoreFlush, auxStoreInfo, auxStoreReset, auxMirrorFile, AUX_KEYS,
} from '../../adapters/aux-store.js';
import { ttResetSession } from '../../adapters/tt-store.js';

const R = makeReporter('aux-store v3.27.0 辅助数据随目录统一收纳');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

/** 宿主桩：官方扩展存储（KV/Blob） */
function makeStoreHost() {
    const kv = new Map(); const blobs = new Map();
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const store = {
        async setJson(a) { kv.set(k(a), a.value); },
        async tryGetJson(a) { return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { if (!kv.has(k(a))) throw new Error('Not found: ' + k(a)); return kv.get(k(a)); },
        async deleteJson(a) { if (!kv.has(k(a))) throw new Error('Not found: ' + k(a)); kv.delete(k(a)); },
        async listKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
        async setBlob(a) { const d = a.data; blobs.set(k(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || [])); },
        async getBlob(a) { if (!blobs.has(k(a))) throw new Error('Not found: ' + k(a)); return new Blob([blobs.get(k(a))]); },
        async deleteBlob(a) { blobs.delete(k(a)); },
        async listBlobKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
    };
    return { abi: { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store } } }, store, kv, blobs };
}

const doc = makeDocument([]);
installGlobalHost(makeHost({}), doc);

let lsMap = new Map();
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.storage = Object.assign({}, cfg.storage, o.storage || {});
    setScopeKey('char:aux');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(emptyState());
    lsMap = new Map();
    if (o.noLocalStorage !== true) {
        Object.defineProperty(globalThis.window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
                setItem: (k, v) => { lsMap.set(String(k), String(v)); },
                removeItem: (k) => { lsMap.delete(String(k)); },
            },
        });
    } else {
        try { delete globalThis.window.localStorage; } catch (e) { /* 忽略 */ }
    }
    auxStoreReset();
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    const h = makeStoreHost();
    if (o.native !== false) { try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ } }
    ttResetSession();
    return h;
}

// ------------------------------------------------------------
await A('A1 **留空 = 不开启**：门面就是 localStorage（行为逐字不变），不写任何目录文件', async () => {
    const h = boot({ storage: { localFilePath: '' } });
    const f = auxFacade();
    f.setItem('SPreset_FTTMemoryDebug', '[1,2]');
    const ok = f.getItem('SPreset_FTTMemoryDebug') === '[1,2]' && lsMap.get('SPreset_FTTMemoryDebug') === '[1,2]'
        && auxStoreInfo().mode === 'localStorage'
        && h.kv.size === 0 && h.blobs.size === 0;
    f.removeItem('SPreset_FTTMemoryDebug');
    return ok && f.getItem('SPreset_FTTMemoryDebug') === null;
}, () => ({ info: auxStoreInfo() }));

await A('A2 目录模式：**先写后清**迁移 —— localStorage 旧值写进目录（回读校验通过）后才清旧键，落点是 `aux/<文件名>`', async () => {
    const h = boot({ storage: { localFilePath: 'aux目录' } });
    lsMap.set('SPreset_FTTMemoryDebug', '["旧日志"]');
    lsMap.set('fttAboutJson', '{"ts":1,"data":{"a":1}}');
    const r = await auxStoreInit();
    const info = auxStoreInfo();
    const fileDbg = auxFileName('SPreset_FTTMemoryDebug');
    const keyDbg = Array.from(h.kv.keys()).concat(Array.from(h.blobs.keys())).filter((x) => x.indexOf('/aux/') > 0 && x.indexOf('aux-SPreset_FTTMemoryDebug') > 0);
    const decoded = (() => {
        const kk = keyDbg[0];
        if (!kk) return '';
        const v = h.kv.get(kk) || h.blobs.get(kk);
        // 官方 KV 通道存的是 `{k:'b64',v:<base64>}` 包装（Blob 通道是原始字节）
        if (v && typeof v === 'object' && typeof v.v === 'string') return Buffer.from(v.v, 'base64').toString('utf8');
        if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
        return '';
    })();
    return r.ok === true && r.migrated === 2
        && fileDbg.indexOf('aux-') === 0
        && lsMap.has('SPreset_FTTMemoryDebug') === false && lsMap.has('fttAboutJson') === false
        && decoded === '["旧日志"]'
        && info.mode === 'dir' && auxLsGet('SPreset_FTTMemoryDebug') === '["旧日志"]';
}, () => ({ info: auxStoreInfo() }));

await A('A3 目录模式读写闭环：`auxLsSet` → `auxStoreFlush()` 落盘 → **新会话**（reset + init）能原值读回', async () => {
    boot({ storage: { localFilePath: 'aux目录' } });
    auxLsSet('SPreset_FTTMemoryTrace', '[{"kind":"x"}]');
    const f1 = await auxStoreFlush();
    const info1 = auxStoreInfo();
    // 模拟刷新：清内存与 init 标记，重新从目录加载
    auxStoreReset();
    const r2 = await auxStoreInit();
    const back = auxLsGet('SPreset_FTTMemoryTrace');
    return f1.ok === true && f1.written === 1 && info1.pending === 0
        && back === '[{"kind":"x"}]' && r2.loaded >= 1;
}, () => ({ info: auxStoreInfo() }));

await A('A4 目录模式删除：`auxLsRemove` + flush → 目录里的文件被真正删掉（不留空壳）', async () => {
    const h = boot({ storage: { localFilePath: 'aux目录' } });
    auxLsSet('fttAboutJson', '{"x":1}');
    await auxStoreFlush();
    const before = Array.from(h.kv.keys()).concat(Array.from(h.blobs.keys())).filter((x) => x.indexOf('/aux/') > 0).length;
    auxLsRemove('fttAboutJson');
    const f = await auxStoreFlush();
    const after = Array.from(h.kv.keys()).concat(Array.from(h.blobs.keys())).filter((x) => x.indexOf('/aux/') > 0).length;
    return before === 1 && after === 0 && f.ok === true && auxLsGet('fttAboutJson') === null;
}, () => ({ info: auxStoreInfo() }));

await A('A5 `auxMirrorFile`（快照链 / 同步日志的目录副本）：目录模式 → 收录一份到 `aux/`；留空 → 如实 `skipped:off` 不动作', async () => {
    const h = boot({ storage: { localFilePath: 'aux目录' } });
    const m1 = await auxMirrorFile('ftt2-snap-char-aux.json', '{"snap":1}');
    const files = Array.from(h.kv.keys()).concat(Array.from(h.blobs.keys())).filter((x) => x.indexOf('/aux/') > 0);
    const off = boot({ storage: { localFilePath: '' } });
    const m2 = await auxMirrorFile('ftt2-log-char-aux.json', '[]');
    return m1.ok === true && files.length === 1 && files[0].indexOf('aux-ftt2-snap-char-aux.json') > 0
        && m2.ok === false && m2.skipped === 'off' && off.kv.size === 0;
}, () => ({ info: auxStoreInfo() }));

await A('A6 退化语义：**没设目录且宿主没有 localStorage**（Node / 受限宿主）→ `auxFacade()` 返回 null（调用方照旧走「纯内存」分支）', async () => {
    boot({ storage: { localFilePath: '' }, noLocalStorage: true });
    return auxFacade() === null && auxStoreInfo().mode === 'localStorage';
}, () => ({ info: auxStoreInfo() }));

await A('A7 只读状态如实计数：目录 / 浏览器两种模式下都给出每个键的落点、字节数与迁移摘要', async () => {
    boot({ storage: { localFilePath: 'aux目录' } });
    auxLsSet('SPreset_FTTMemoryDebug', '[1]');
    await auxStoreFlush();
    const info = auxStoreInfo();
    const item = (info.items || []).filter((x) => x.key === 'SPreset_FTTMemoryDebug')[0] || {};
    const keysOk = J((info.items || []).map((x) => x.key)) === J(AUX_KEYS);
    boot({ storage: { localFilePath: '' } });
    lsMap.set('SPreset_FTTMemoryDebug', '[2]');
    const info2 = auxStoreInfo();
    const item2 = (info2.items || []).filter((x) => x.key === 'SPreset_FTTMemoryDebug')[0] || {};
    return keysOk && info.mode === 'dir' && item.where === 'dir' && item.bytes === 3
        && info2.mode === 'localStorage' && item2.where === 'localStorage' && item2.bytes === 3;
}, () => ({ info: auxStoreInfo() }));

R.done();
