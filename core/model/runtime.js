// ============================================================
// core/model/runtime.js —— 内核的**注入视图**（配置 / 状态 / 剧情时钟）
// 目的：让逐字移植的 V1 归一化代码（按 `cfg.*` / `state.*` / `getStoryNow()` 读取）在 V2 里原样运行，
//   同时保持 `core/` 零宿主依赖 —— 由 host 层在启动与数据变更时注入，内核不主动读宿主。
// ============================================================
import { DIM_CHAR_LIMITS, VERSION } from '../constants.js';

/** 生效配置视图（与 V1 全局 `cfg` 等价；原地修改） */
export const cfg = {
    dimCharLimits: Object.assign({}, DIM_CHAR_LIMITS),
    // 计划 / 悬念结构化
    planStructEnabled: true,
    planRefsMax: 12,
    planStepsMax: 20,
    planHistoryMax: 30,
    cluesMax: 20,
    // 货币 / 情节分段（V1 同名配置键）
    currencyTrackedRoles: [],
    plotSegmentTextLimit: 400,
};

/**
 * 默认配置（与 V1 `defaultCfg` 相关键等价）：仅在内核读取「配置缺失时的兜底」时使用。
 * 注意：这里不是完整 defaultCfg（完整配置键在后续批次移入 core/config.js）。
 */
export const defaultCfg = {
    dimCharLimits: DIM_CHAR_LIMITS,
    currencyTrackedRoles: [],
    planRefsMax: 12,
    planStepsMax: 20,
    planHistoryMax: 30,
    cluesMax: 20,
    plotSegmentTextLimit: 400,
};

/** 持久化钩子（内核不直接落盘；由 host 层注入 real 实现） */
let persistHooks = { saveCfg: () => true, saveState: () => true, log: null };
/** 注入持久化钩子（host 启动时调用） */
export function setPersistHooks(next) {
    persistHooks = Object.assign({}, persistHooks, next || {});
    return persistHooks;
}
/** 逐字移植的 V1 代码会调用 `saveCfg()`；内核默认 no-op，宿主可注入真实保存 */
export function saveCfg() {
    try { return persistHooks.saveCfg(); } catch (e) { return false; }
}
/** 日志钩子（内核默认 no-op；宿主可注入真实日志） */
export function log(...args) {
    try { if (typeof persistHooks.log === 'function') return persistHooks.log(...args); } catch (e) { /* noop */ }
    return undefined;
}

/** 同上：`saveState()` */
export function saveState() {
    try { return persistHooks.saveState(); } catch (e) { return false; }
}

/** 代码版本（透出给内核使用；与 manifest.json 一致） */
export { VERSION };

/** 角色作用域稳定标识（宿主注入：优先角色文件名/名，见 host/st-api.js `currentCharScope`） */
let scopeKey = '';
/** 注入角色稳定标识（切换角色时调用） */
export function setScopeKey(next) {
    scopeKey = String(next == null ? '' : next);
    return scopeKey;
}
/** 当前角色稳定标识（未注入时空串） */
export function getScopeKey() {
    return scopeKey;
}

/** 生效状态视图（与 V1 全局 `state` 等价；由宿主注入当前角色的 state 对象） */
export let state = null;

/** 注入配置（只覆盖传入键；对象类键做浅合并） */
export function setModelOptions(patch) {
    const p = patch || {};
    for (const k of Object.keys(p)) {
        if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k]) && cfg[k] && typeof cfg[k] === 'object' && !Array.isArray(cfg[k])) {
            Object.assign(cfg[k], p[k]);
        } else {
            cfg[k] = p[k];
        }
    }
    return cfg;
}

/** 注入当前 state（宿主在载入/切换角色/合并后调用；传 null 表示未就绪） */
export function setKernelState(next) {
    state = next || null;
    return state;
}

/** 当前注入的 state（调试用） */
export function kernelState() {
    return state;
}

/**
 * 剧情时钟「现在」（逐字移植自 V1 `getStoryNow()`）：读 `state.state.date`，无则空串。
 * 注意：V1 用现实时间兜底的地方在 v1.171 起已改为「剧情日期优先、不用现实年份」，此处保持一致。
 */
export function getStoryNow() {
    try { if (state && state.state && state.state.date) return String(state.state.date); } catch (e) { /* 忽略 */ }
    return '';
}
