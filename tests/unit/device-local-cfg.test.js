// ============================================================
// 单元测试 · v3.33.0「本地存储路径**不随服务端转移**」（设备本地键）
//
// 用户要求（原话）：「其次本地存储路径不能随服务端转移，因为不同端的存储路径可能有差异。」
//
// 事实与口径：
//   · 插件配置整体落在 ST `extensionSettings[模块名].cfg`，而 ST 配置**随服务端同步** ——
//     于是 `storage.localDiskDir` 会被搬到另一台设备（Android 收到 `D:\…` → 必然写不进去，
//     看起来就像「Android 上根本没法设置」）；
//   · 现口径：该键改走**设备本地**（`adapters/device-local.js`，localStorage 命名空间 `ftt2_dev_`）：
//     载入时以本机值为准（本机没有才把老配置里的那份一次性迁移进来），落盘副本里**恒为空**。
//
// 运行：node tests/unit/device-local-cfg.test.js
// ============================================================
import { makeReporter, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { loadKernelCfg, saveKernelCfg, lastLoadInfo, DEVICE_LOCAL_CFG_KEYS, deviceLocalCfgSnapshot, stripDeviceLocalCfg, cfgPathGet, cfgPathSet } from '../../adapters/config-store.js';
import { deviceLocalGet, deviceLocalSet, deviceLocalRemove, deviceLocalKeys, deviceLocalInfo, deviceLocalReset, deviceLocalAvailable, DEVICE_LOCAL_PREFIX } from '../../adapters/device-local.js';

const R = makeReporter('device-local-cfg v3.33.0 本地存储路径不随服务端转移');
const A = (n, cond, detail) => R.assert(n, cond === true, (typeof detail === 'function') ? detail() : detail);
const J = (v) => JSON.stringify(v);
const KEY = 'storage.localDiskDir';

/** 内存 localStorage 桩（模拟「这台设备」的本机存储） */
let lsMap = new Map();
function installLs(on) {
    lsMap = new Map();
    try {
        if (!globalThis.window) globalThis.window = {};
        if (on === false) { delete globalThis.window.localStorage; }
        else {
            Object.defineProperty(globalThis.window, 'localStorage', {
                configurable: true,
                value: {
                    get length() { return lsMap.size; },
                    key: (i) => Array.from(lsMap.keys())[i] == null ? null : Array.from(lsMap.keys())[i],
                    getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
                    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
                    removeItem: (k) => { lsMap.delete(String(k)); },
                },
            });
        }
    } catch (e) { /* 忽略 */ }
}

const host = makeHost({});
installGlobalHost(host, null);
const ctx = host.ctx;

/** 把「这台设备」的 ST 配置容器换成给定内容（模拟服务端同步过来的配置） */
function setServerCfg(cfgObj) {
    ctx.extensionSettings.ftm_test = ctx.extensionSettings.ftm_test || {};
    const store = (() => { const s = loadKernelCfg({ persist: false }); return s; })();
    void store;
    ctx.extensionSettings.ftt_memory_v2 = ctx.extensionSettings.ftt_memory_v2 || {};
    ctx.extensionSettings.ftt_memory_v2.cfg = JSON.parse(JSON.stringify(cfgObj || {}));
}

// ---------- A 设备本地存储本体 ----------
installLs(true);
deviceLocalReset();
A('A1 设备本地存储：读写删 + 键名前缀 + 只读状态（有 localStorage → `available=true`）', (() => {
    const setOk = deviceLocalSet(KEY, 'D:\\FTT\\store');
    const got = deviceLocalGet(KEY);
    const keys = deviceLocalKeys();
    const info = deviceLocalInfo();
    deviceLocalSet(KEY, '');
    return setOk === true && got === 'D:\\FTT\\store'
        && J(keys) === J([KEY]) && info.available === true && info.backend === 'localStorage'
        && info.values[KEY] === 'D:\\FTT\\store'
        && deviceLocalGet(KEY) === '' && deviceLocalGet('没写过的键') === ''
        && lsMap.has(DEVICE_LOCAL_PREFIX + KEY) === false
        && deviceLocalRemove(KEY) === true && deviceLocalKeys().length === 0;
})(), () => deviceLocalInfo());

installLs(false);
deviceLocalReset();
A('A2 无 localStorage（受限宿主 / Node）：退化为**内存副本**并如实标注 `available=false`（不假装已持久化）', (() => {
    const on = deviceLocalAvailable();
    deviceLocalSet(KEY, '/storage/emulated/0/ftt');
    const got = deviceLocalGet(KEY);
    const info = deviceLocalInfo();
    installLs(true);
    deviceLocalReset();
    return on === false && got === '/storage/emulated/0/ftt' && info.available === false && info.backend === 'memory';
})(), () => deviceLocalInfo());

// ---------- B 配置层的路由口径 ----------
installLs(true);
deviceLocalReset();
A('B1 老配置迁移：服务端同步过来的路径 → **本机**存一份，落盘副本里清空（配置从此不再带着路径走）', (() => {
    setServerCfg({ storage: { localDiskDir: 'D:\\Downloads\\stn\\fft_v2_store' } });
    const r = loadKernelCfg();
    const loaded = lastLoadInfo() || {};
    const persisted = cfgPathGet(ctx.extensionSettings.ftt_memory_v2.cfg, KEY);
    const migrated = Array.isArray(loaded.deviceMigrated) ? loaded.deviceMigrated : [];
    return cfgPathGet(cfg, KEY) === 'D:\\Downloads\\stn\\fft_v2_store'     // 内核视图里生效
        && deviceLocalGet(KEY) === 'D:\\Downloads\\stn\\fft_v2_store'      // 落到本机
        && persisted === ''                                                // 落盘副本里为空
        && migrated.indexOf(KEY) >= 0 && r.deviceLocal && r.deviceLocal.values[KEY] === 'D:\\Downloads\\stn\\fft_v2_store';
})(), () => ({ cfgPath: cfgPathGet(cfg, KEY), device: deviceLocalGet(KEY), persisted: cfgPathGet(ctx.extensionSettings.ftt_memory_v2.cfg, KEY), storage: (ctx.extensionSettings.ftt_memory_v2.cfg || {}).storage }));

A('B2 用户在本机改路径：写本机 + 落盘副本恒空（`saveKernelCfg` 的剥离口径）', (() => {
    cfgPathSet(cfg, KEY, 'E:\\FTT\\本机');
    const ok = saveKernelCfg();
    const persisted = cfgPathGet(ctx.extensionSettings.ftt_memory_v2.cfg, KEY);
    return ok === true && deviceLocalGet(KEY) === 'E:\\FTT\\本机' && persisted === ''
        && stripDeviceLocalCfg({ storage: { localDiskDir: 'X' } }).storage.localDiskDir === ''
        && cfgPathGet(cfg, KEY) === 'E:\\FTT\\本机';     // 内核视图不受影响
})(), () => ({ device: deviceLocalGet(KEY), persisted: cfgPathGet(ctx.extensionSettings.ftt_memory_v2.cfg, KEY) }));

A('B3 **不随服务端转移**（核心口径）：另一台设备（本机没有该键）载入同一份配置 → 路径为空，不会拿到别人的路径', (() => {
    // 设备 A 已把路径写进本机；服务端那份恒为空（B2 已验证）
    const serverCfg = JSON.parse(J(ctx.extensionSettings.ftt_memory_v2.cfg));
    // 换设备：本机设备本地存储清空（新设备没有任何 ftt2_dev_*），但服务端配置照旧（含用户其它设置）
    deviceLocalReset();
    ctx.extensionSettings.ftt_memory_v2.cfg = serverCfg;
    const r = loadKernelCfg();
    const migrated = Array.isArray(r.deviceMigrated) ? r.deviceMigrated : [];
    return cfgPathGet(cfg, KEY) === '' && deviceLocalGet(KEY) === '' && migrated.length === 0
        && cfg.charBudget === serverCfg.charBudget;      // 其它设置照常同步过来
})(), () => ({ cfgPath: cfgPathGet(cfg, KEY), device: deviceLocalGet(KEY) }));

installLs(true);
deviceLocalReset();
A('B4 设备本地键清单是**白名单**：只有「本地存储路径」走本机（不会误伤其它设置）', (() => {
    return J(DEVICE_LOCAL_CFG_KEYS) === J([KEY])
        && DEVICE_LOCAL_PREFIX === 'ftt2_dev_'
        && deviceLocalCfgSnapshot().keys.length === 1;
})(), () => deviceLocalCfgSnapshot());

R.done();
