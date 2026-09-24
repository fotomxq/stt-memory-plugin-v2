// ============================================================
// adapters/store.js —— 保存流水线（P2 的核心接线）
// 背景：V1 的 `saveState()` 顺序为「建索引 → 删除自动留痕 → 写库 → 触发快照/镜像」；
//   批次 5 的黄金样本证明：**内容哈希墓碑与原子 `h` 刷新都在该流水线里**（不在 deleteEntry）。
// 本文件按同一顺序用 V2 内核组装，并把结果写进各后端：
//   ① 本机缓冲（localStorage / 注入的 storage 钩子，V1 同款信封）
//   ② 本机缓冲（IndexedDB via SillyTavern.libs.localforage，可用时）
//   ③ 服务端用户目录文件（adapters/user-file.js，大体积权威数据）
// 适配：所有后端经注入/能力探测，缺失即降级；任何失败都不抛出（写库失败只回报，不阻断交互）。
// ============================================================
import { MODULE_NAME } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { state, cfg as cfgRef, setPersistHooks, log as kernelLog, warn as kernelWarn } from '../core/model/runtime.js';
import { saveSettings } from './settings.js';
import { saveKernelCfg } from './config-store.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../core/sweep.js';
import { storageEnvelope, storageHash } from '../core/envelope.js';
import { snapshotCreateFull, scheduleSnapshotIncr } from '../core/snapshots.js';
import { collectAtomHashes } from '../core/merge.js';
import { scopeId } from '../core/state.js';
import { stateFileName, uploadStateFile, readStateFile, deleteStateFile } from './user-file.js';
import { scheduleStorageSync } from './sync.js';
import { scheduleWorldbookSync } from './worldbook.js';

const SAVE_DEBOUNCE_MS = 800;
let saveTimer = null;
let lastSave = { at: 0, ok: false, via: '', bytes: 0, error: '' };
let indexReady = false;

/** 保存记录（调试与 /ftt 输出） */
export function lastSaveInfo() {
    return Object.assign({}, lastSave);
}

/** localStorage 兼容钩子（宿主可注入；默认用 globalThis.localStorage） */
let storageHooks = {
    getItem: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (e) { return null; } },
    setItem: (k, v) => { try { if (globalThis.localStorage) { globalThis.localStorage.setItem(k, v); return true; } } catch (e) { /* 忽略 */ } return false; },
};
/** 注入本机存储（测试/宿主自定义） */
export function setStorageHooks(next) {
    storageHooks = Object.assign({}, storageHooks, next || {});
    return storageHooks;
}

function kernelState() {
    return state;
}

/** 保存后是否**不**调度跨端镜像（V1 同名配置键 `cfg.storage.syncOnSave === false`） */
function mirrorOnSaveDisabled() {
    try { return !!(cfgRef && cfgRef.storage && cfgRef.storage.syncOnSave === false); } catch (e) { return true; }
}

async function localforageLib() {
    try {
        const ctx = getCtx();
        const libs = ctx && ctx.libs;
        if (libs && libs.localforage) return libs.localforage;
        if (globalThis.SillyTavern && globalThis.SillyTavern.libs && globalThis.SillyTavern.libs.localforage) return globalThis.SillyTavern.libs.localforage;
    } catch (e) { /* 忽略 */ }
    return null;
}

/**
 * 立即保存（V1 `saveState()` 的 V2 实现）。
 * @param {object} [opts] reason / skipFile（不写服务端文件）/ sync（同步返回）
 * @returns {Promise<object>} { ok, via, bytes, error }
 */
export async function saveStateNow(opts) {
    const o = opts || {};
    const st = kernelState();
    if (!st) return { ok: false, error: '无可保存的 state（未注入）' };
    // ① 索引基线（首次）→ 刷新原子 h + 建当前索引
    try {
        if (!indexReady) { entryIndexInit(); indexReady = true; }
        entryIndexBuild(true);
    } catch (e) { kernelWarn('保存：刷新原子哈希失败', e); }
    // ② 删除自动留痕（先于写库：墓碑随本次信封一起持久化）
    try { tombstoneSweep(); } catch (e) { kernelWarn('保存：删除留痕失败', e); }
    // ②b 快照链维护（V1 `saveState()` 收尾口径）：无原子跳过 / 无快照建根 / 否则调度增量（timerHooks 防抖）
    try { maintainSnapshots(); } catch (e) { kernelWarn('保存：快照维护失败', e); }
    // ③ 组装信封
    let envelope = null;
    try {
        st.updatedAt = Date.now();
        envelope = storageEnvelope(st);
    } catch (e) { return { ok: false, error: '信封组装失败：' + String((e && e.message) || e) }; }
    const text = JSON.stringify(envelope);
    const bytes = text.length;
    const via = [];
    // ④ 本机缓冲（localStorage 信封）
    try {
        const key = 'ftt2_state_' + scopeId();
        if (storageHooks.setItem(key, text)) via.push('localStorage');
    } catch (e) { /* 忽略 */ }
    // ⑤ IndexedDB 缓冲（可用时）
    try {
        const lf = await localforageLib();
        if (lf && typeof lf.setItem === 'function') {
            await lf.setItem('ftt2_state_' + scopeId(), envelope);
            via.push('indexedDB');
        }
    } catch (e) { /* 忽略 */ }
    // ⑥ 服务端文件（大体积权威数据）
    if (o.skipFile !== true) {
        try {
            const r = await uploadStateFile(stateFileName(scopeId()), text);
            if (r.ok) via.push('file');
            else if (r.error) kernelLog('保存：服务端文件不可用（' + r.error + '）');
        } catch (e) { /* 忽略 */ }
    }
    lastSave = { at: Date.now(), ok: via.length > 0, via: via.join('+'), bytes, error: '' };
    try { saveSettings(); } catch (e) { /* 忽略 */ }
    // ⑦ 保存后镜像（V1 `saveState` 末尾的 scheduleStorageSync）：防抖 3s + 楼层/签名双门控
    //   （`cfg.storage.syncOnSave === false` 时不调度；手动「立即同步」不受此开关影响）
    try { if (!mirrorOnSaveDisabled()) scheduleStorageSync(false); } catch (e) { /* 忽略 */ }
    // ⑧ 世界书单向镜像（V1 `storageWriteAll` 末尾同款）：原子数据落主存储后**延迟 8s 防抖**推送词条。
    //   未开启 `cfg.storage.worldbook` 时零行为（不排定时器、不触宿主 API）；失败静默（下次数据变更再试）。
    try { scheduleWorldbookSync(); } catch (e) { /* 忽略 */ }
    return { ok: lastSave.ok, via: lastSave.via, bytes, error: '' };
}

/** 防抖保存（V1 `syncOnSave` 同款） */
export function scheduleSave(reason) {
    if (saveTimer) { try { clearTimeout(saveTimer); } catch (e) { /* 忽略 */ } }
    const delay = Number(_debounceMs) > 0 ? Number(_debounceMs) : SAVE_DEBOUNCE_MS;
    saveTimer = setTimeout(() => { saveTimer = null; void saveStateNow({ reason }); }, delay);
    return true;
}
let _debounceMs = SAVE_DEBOUNCE_MS;
/** 覆盖防抖时长（测试用；0 = 用默认） */
export function setSaveDebounce(ms) {
    _debounceMs = Number(ms) || 0;
    return true;
}

/** 取消待执行的防抖保存 */
export function cancelScheduledSave() {
    if (saveTimer) { try { clearTimeout(saveTimer); } catch (e) { /* 忽略 */ } saveTimer = null; return true; }
    return false;
}

/**
 * 载入本机缓冲（校验信封哈希；损坏即拒绝，交由服务端文件兜底）
 * @returns {object|null} state 或 null
 */
export function loadFromLocalStorage() {
    try {
        const key = 'ftt2_state_' + scopeId();
        const raw = storageHooks.getItem(key);
        if (!raw) return null;
        const env = JSON.parse(raw);
        if (!env || !env.payload) return null;
        const h = storageHash(env.payload);
        if (env.hash && env.hash !== h) { kernelWarn('载入：本机缓冲哈希不一致 → 丢弃', ''); return null; }
        return env.payload.data || null;
    } catch (e) { return null; }
}

/** 服务端文件载入（返回 state 或 null） */
export async function loadFromServerFile() {
    const r = await readStateFile(stateFileName(scopeId()));
    if (!r.ok) return null;
    try {
        const env = JSON.parse(r.text);
        if (env && env.payload) {
            const h = storageHash(env.payload);
            if (env.hash && env.hash !== h) return null;
            return env.payload.data || null;
        }
        return env || null;
    } catch (e) { return null; }
}

/** 删除服务端文件（数据管理用） */
export async function removeServerFile() {
    return deleteStateFile(stateFileName(scopeId()));
}

/**
 * 给内核接线持久化钩子：内核里任何 `saveState()` / `saveCfg()` 调用都会落到本模块。
 * @returns {object} 接线摘要
 */
export function wirePersistHooks() {
    setPersistHooks({
        saveState: () => { void saveStateNow({ reason: 'kernel' }); return true; },
        saveCfg: () => saveKernelCfg(),
        log: (m, e) => { if (e !== undefined) kernelLog(m, e); },
        warn: () => undefined,
    });
    return { debounceMs: SAVE_DEBOUNCE_MS, storage: 'localStorage+indexedDB+file' };
}

/**
 * 快照链维护（V1 `saveState()` 口径）：
 *   ① 当前没有任何原子 → 跳过（不建空根）；② 还没有快照 → 建**全量根快照**；③ 已有快照 → 调度**增量快照**（防抖）。
 * 说明：增量调度经 `timerHooks`（内核默认 no-op → 测试/无宿主环境不会后台跑；宿主可注入真实定时器）。
 */
export function maintainSnapshots() {
    try {
        const hasAtoms = collectAtomHashes().order.length > 0;
        if (!hasAtoms) return { skipped: 'no-atoms' };
        const snaps = (state && Array.isArray(state.snapStore)) ? state.snapStore : [];
        if (!snaps.length) { const r = snapshotCreateFull(); return { created: r ? 'root' : 'none' }; }
        scheduleSnapshotIncr();
        return { scheduled: 'incr' };
    } catch (e) { return { error: String((e && e.message) || e) }; }
}

/**
 * 启动即建立索引基线（V1 `saveState` 之外的 `entryIndexInit()` 调用点：载入数据后立刻对齐）——
 * 此后任何「消失的条目」才会被留痕；不在每次保存里重建基线（那会让删除永远检测不到）。
 */
export function primeStateIndex() {
    try { entryIndexInit(); indexReady = true; return true; } catch (e) { return false; }
}

/** 存储接线状态（调试用） */
export function storeStatus() {
    return { scope: scopeId(), module: MODULE_NAME, last: lastSaveInfo(), indexReady };
}
