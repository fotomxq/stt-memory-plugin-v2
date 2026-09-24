// ============================================================
// adapters/config-store.js —— 内核配置视图（`core/model/runtime.js#cfg`）与 ST 配置的同步
// 背景：逐字移植的 V1 内核按 `cfg.*` 读取配置（例如 `cfg.charBudget` / `cfg.promptTemplates.injectGuide`），
//   而 V2 的配置落盘在 ST `extensionSettings[MODULE_NAME].cfg`（`adapters/settings.js`）。
// 本模块负责两侧同步：启动时「默认配置 ⊕ 已存配置 → 内核视图」；内核调用 `saveCfg()` 时「内核视图 → 已存配置」。
// 口径：缺键补默认、己存值优先；用户改动永不因升级被静默覆盖。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { defaultCfg } from '../core/config.js';
import { getSettings, saveSettings } from './settings.js';

/** 深拷贝（配置为纯数据；函数/undefined 不支持，配置里也不该有） */
export function deepClone(v) {
    try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return null; }
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 稳定序列化（递归排序键）：用于「配置是否有变化」的判定 —— 避免键序差异造成无意义写盘 */
export function stableStringify(v) {
    try {
        const walk = (x) => {
            if (Array.isArray(x)) return x.map(walk);
            if (isPlain(x)) {
                const o = {};
                Object.keys(x).sort().forEach((k) => { o[k] = walk(x[k]); });
                return o;
            }
            return x === undefined ? null : x;
        };
        return JSON.stringify(walk(v));
    } catch (e) { return ''; }
}

/** 合并：基础（默认）⊕ 已存（用户）—— 对象递归，其余以已存为准 */
export function mergeCfg(base, saved) {
    const out = deepClone(base) || {};
    if (!isPlain(saved)) return out;
    for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (isPlain(v) && isPlain(out[k])) out[k] = mergeCfg(out[k], v);
        else if (v !== undefined) out[k] = deepClone(v);
    }
    return out;
}

/** 把配置写进内核视图（原地修改同一对象：内核各模块持有该引用） */
export function applyKernelCfg(merged) {
    const src = isPlain(merged) ? merged : {};
    for (const k of Object.keys(src)) cfg[k] = src[k];
    for (const k of Object.keys(cfg)) { if (!(k in src)) delete cfg[k]; }
    return cfg;
}

/**
 * 启动载入：默认 ⊕ 已存 → 内核视图；已存容器缺键时补写回 ST 配置。
 * @param {object} [opts] persist=false 时不写回
 * @returns {{keys:number, changed:boolean, defaults:number, saved:number}}
 */
export function loadKernelCfg(opts) {
    const o = opts || {};
    const store = getSettings();
    const defaults = deepClone(defaultCfg) || {};
    const saved = isPlain(store.cfg) ? store.cfg : {};
    const merged = mergeCfg(defaults, saved);
    const changed = stableStringify(saved) !== stableStringify(merged);
    store.cfg = merged;
    applyKernelCfg(merged);
    if (changed && o.persist !== false) { try { saveSettings(); } catch (e) { /* 忽略 */ } }
    return { keys: Object.keys(merged).length, changed, defaults: Object.keys(defaults).length, saved: Object.keys(saved).length };
}

/** 内核 → ST 配置（内核调用 saveCfg() 时走这里） */
export function saveKernelCfg() {
    try {
        const store = getSettings();
        store.cfg = deepClone(cfg) || {};
        saveSettings();
        return true;
    } catch (e) { return false; }
}

/** 当前内核配置键数（诊断用） */
export function kernelCfgStats() { return { keys: Object.keys(cfg).length }; }
