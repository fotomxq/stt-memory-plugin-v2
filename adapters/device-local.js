// ============================================================
// adapters/device-local.js —— **设备本地**键值存储（v3.33.0，用户要求）
//
// 用户原话：「本地存储路径不能随服务端转移，因为不同端的存储路径可能有差异。」
//
// 事实：插件配置整体落在 ST `extensionSettings[模块名].cfg`（`adapters/settings.js`），
//   而 **ST 配置随服务端同步** —— 于是「本地存储路径」这种**因设备而异**的值会被搬到另一台设备上
//   （Android 收到 `D:\…` 这种 Windows 路径 → 校验必然失败 → 看起来「根本没法设置」）。
//
// 口径：这类键只写**本机**（`localStorage`，命名空间 `ftt2_dev_`），**绝不进入随服务端同步的配置**：
//   · 有 localStorage → 用它（同一浏览器/设备内跨刷新保留）；
//   · 没有（受限宿主 / Node 测试）→ 退化为**内存副本**，并如实标注 `available=false`（不假装已持久化）。
// 与「本地磁盘目录」的区别：这里存的是**配置项的值**（很小），不是记忆数据本身。
// ============================================================

/** 设备本地键前缀（与配置键同形：`storage.localDiskDir` → `ftt2_dev_storage.localDiskDir`） */
export const DEVICE_LOCAL_PREFIX = 'ftt2_dev_';

/** 无 localStorage 时的内存兜底（进程内有效；刷新即失，故 `available()=false`） */
const mem = new Map();

/** localStorage 取用（拿不到 → null） */
function ls() {
    try {
        const w = globalThis.window;
        if (w && w.localStorage && typeof w.localStorage.getItem === 'function') return w.localStorage;
    } catch (e) { /* 忽略 */ }
    try {
        const g = globalThis.localStorage;
        if (g && typeof g.getItem === 'function') return g;
    } catch (e) { /* 忽略 */ }
    return null;
}

/** 是否真的有设备本地持久层（有 localStorage = true；纯内存兜底 = false，如实回报） */
export function deviceLocalAvailable() { return !!ls(); }

/** 本地存储后端名（诊断用） */
export function deviceLocalBackend() { return ls() ? 'localStorage' : 'memory'; }

/** 键名（对外用逻辑键，如 `storage.localDiskDir`；落盘加前缀，避免与其它扩展/日志键冲突） */
export function deviceLocalKeyName(key) { return DEVICE_LOCAL_PREFIX + String(key == null ? '' : key); }

/** 读（不存在 → ''；不返回 null，调用方少一层判断） */
export function deviceLocalGet(key) {
    const k = deviceLocalKeyName(key);
    const s = ls();
    if (s) {
        try { const v = s.getItem(k); return v == null ? '' : String(v); } catch (e) { /* 落到内存 */ }
    }
    return mem.has(k) ? String(mem.get(k)) : '';
}

/** 写（空串 = 删除；返回是否已接受） */
export function deviceLocalSet(key, val) {
    const k = deviceLocalKeyName(key);
    const text = String(val == null ? '' : val);
    if (!text) return deviceLocalRemove(key);
    mem.set(k, text);
    const s = ls();
    if (s) { try { s.setItem(k, text); return true; } catch (e) { return false; } }
    return false;   // 无 localStorage：只有内存副本，如实说「未持久化」
}

/** 删（返回是否删除成功；无键也算成功） */
export function deviceLocalRemove(key) {
    const k = deviceLocalKeyName(key);
    mem.delete(k);
    const s = ls();
    if (s) { try { s.removeItem(k); return true; } catch (e) { return false; } }
    return true;
}

/** 已存在的设备本地键（去前缀；诊断 / UI 用） */
export function deviceLocalKeys() {
    const out = [];
    const s = ls();
    if (s) {
        try {
            for (let i = 0; i < s.length; i++) {
                const k = String(s.key(i) || '');
                if (k.indexOf(DEVICE_LOCAL_PREFIX) === 0) out.push(k.slice(DEVICE_LOCAL_PREFIX.length));
            }
        } catch (e) { /* 忽略 */ }
    }
    for (const k of mem.keys()) {
        const name = String(k).slice(DEVICE_LOCAL_PREFIX.length);
        if (out.indexOf(name) < 0) out.push(name);
    }
    return out.sort();
}

/** 只读状态（诊断 / UI：这台设备上到底存了哪些「不随服务端同步」的键） */
export function deviceLocalInfo() {
    const keys = deviceLocalKeys();
    const values = {};
    for (const k of keys) values[k] = deviceLocalGet(k);
    return { available: deviceLocalAvailable(), backend: deviceLocalBackend(), prefix: DEVICE_LOCAL_PREFIX, keys: keys, values: values };
}

/** 清空（测试 / 维护用） */
export function deviceLocalReset() {
    mem.clear();
    const s = ls();
    if (s) {
        try {
            const keys = [];
            for (let i = 0; i < s.length; i++) { const k = String(s.key(i) || ''); if (k.indexOf(DEVICE_LOCAL_PREFIX) === 0) keys.push(k); }
            for (const k of keys) s.removeItem(k);
        } catch (e) { /* 忽略 */ }
    }
    return true;
}

export default {
    DEVICE_LOCAL_PREFIX, deviceLocalAvailable, deviceLocalBackend, deviceLocalKeyName,
    deviceLocalGet, deviceLocalSet, deviceLocalRemove, deviceLocalKeys, deviceLocalInfo, deviceLocalReset,
};
