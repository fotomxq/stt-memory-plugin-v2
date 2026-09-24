// ============================================================
// adapters/update-state.js —— 更新检查状态持久化（存在 extensionSettings 内，随设定同步）
// 字段：firstRunAt / startupCheckedAt / lastCheckAt / lastResult
// ============================================================
import { MODULE_NAME } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { saveSettings } from './settings.js';

function bucket() {
    const ctx = getCtx();
    if (!ctx || !ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') return null;
    const root = ctx.extensionSettings[MODULE_NAME] || (ctx.extensionSettings[MODULE_NAME] = {});
    if (!root.update || typeof root.update !== 'object') root.update = {};
    return root.update;
}

/** 读取更新状态（无宿主时返回内存兜底对象，不抛异常） */
export function readUpdateState() {
    const b = bucket();
    if (!b) return { firstRunAt: 0, startupCheckedAt: 0, lastCheckAt: 0, lastResult: null };
    return {
        firstRunAt: Number(b.firstRunAt) || 0,
        startupCheckedAt: Number(b.startupCheckedAt) || 0,
        lastCheckAt: Number(b.lastCheckAt) || 0,
        lastResult: b.lastResult || null,
    };
}

/** 写入部分字段并保存 */
export function writeUpdateState(patch) {
    const b = bucket();
    const p = patch || {};
    if (!b) return false;
    for (const k of Object.keys(p)) b[k] = p[k];
    saveSettings();
    return true;
}

/** 首次运行标记（幂等：已有 firstRunAt 则原样返回） */
export function ensureFirstRun(now) {
    const st = readUpdateState();
    if (st.firstRunAt) return st.firstRunAt;
    const at = Number(now) || Date.now();
    writeUpdateState({ firstRunAt: at });
    return at;
}
