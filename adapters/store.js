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
import { state, cfg as cfgRef, setPersistHooks, setKernelState, log as kernelLog, warn as kernelWarn } from '../core/model/runtime.js';
import { saveSettings } from './settings.js';
import { saveKernelCfg } from './config-store.js';
import { entryIndexBuild, entryIndexInit, primeAtomIndex, tombstoneSweep, tombstoneSweepPause, tombstoneSweepResume } from '../core/sweep.js';
import { storageEnvelope, storageHash } from '../core/envelope.js';
import { snapshotCreateFull, scheduleSnapshotIncr } from '../core/snapshots.js';
import { collectAtomHashes } from '../core/merge.js';
import { scopeId, emptyState } from '../core/state.js';
import { stateFileName } from './user-file.js';
// v2.77.0：文件通道统一走 `adapters/file-transport.js`（宿主原生存储 / 酒馆用户目录文件自动切换）
import { fileTransportReadAuto, fileTransportDelete } from './file-transport.js';
import { scheduleStorageSync, writeStateFileContent, stateFileGzipOn, stateFileGzName } from './sync.js';
import { scheduleWorldbookSync } from './worldbook.js';
import { hydrateStorageData } from '../core/slim.js';
// v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：保存 / 同步类动作也进管线状态
import { trackPipeline } from '../core/pipeline.js';
import { debugLogPush } from './debug-log.js';   // v2.87.0：内核 warn → 调试日志（kind = 异常）

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
 * v3.0.15（用户报告「上次更新后特别卡顿，尤其正文保存，可能直接卡死」）——**数据触碰时间戳**。
 *   内核任何「数据发生变化」的落盘请求（`saveState()` / `persistNow()`）都会刷新它；
 *   `lastFullPushAt` 是最近一次**真的写了服务端文件**的时刻。
 *   于是「自上次完整上传以来数据没有任何变化」的保存（事件驱动的空保存是常态：每次生成结束都会存一次）
 *   可以**跳过全部重活**（索引 / 墓碑扫 / 信封 / base64 / 上传 / 镜像排期）——
 *   这些产物全都由数据派生，数据没变就没有任何东西需要重算。
 *   安全性：① 任何数据变更都会经 `markDataTouched()` 刷新时间戳；
 *   ② 窗口 `SAVE_NOOP_WINDOW_MS`（60s）之外一律做完整保存（万一某条变更路径漏了标记，最多 60s 后自愈）；
 *   ③ 清空 / 导入 / 控制台编辑 / 快照还原等**直接写入**的路径显式 `force`（永不跳过）。
 */
let lastTouchAt = 0;
/**
 * v3.0.15：**变更序号**（不是时间戳）—— 时间戳只有毫秒精度，同一毫秒内的「数据变更 + 保存」
 *   会被误判成「无变化」而跳过写盘。序号单调递增，`saveStateNowInner` 成功上传后把
 *   `pushedSeq` 对齐到 `touchSeq`，于是「自上次完整上传以来数据是否动过」是**精确**判断。
 */
let touchSeq = 0;
let pushedSeq = 0;
/** 标记「数据已变化」（内核 `saveState()` / `persistNow()` 与直接写入路径调用） */
export function markDataTouched() { touchSeq += 1; lastTouchAt = Date.now(); return touchSeq; }
/** 最近一次**完整**上传（含服务端文件）的时刻与体积 */
let lastFullPushAt = 0;
let lastFullPushBytes = 0;
/** 空保存跳过的窗口（毫秒）；窗口外一律完整保存（自愈） */
export const SAVE_NOOP_WINDOW_MS = 60000;
/** 窗口可注入（单测用小值验证「窗口外一定完整保存」；生产恒用 `SAVE_NOOP_WINDOW_MS`） */
let noopWindowMs = SAVE_NOOP_WINDOW_MS;
export function setSaveNoopWindowMs(ms) { noopWindowMs = Math.max(0, Number(ms) || 0); return noopWindowMs; }
/**
 * v3.0.14/v3.0.15：**「多久算卡死」的统一阈值**（保存层与立即保存层共用同一旋钮）。
 *   一次保存/一次立即保存超过它仍未返回即视为卡死（宿主或服务端挂住），
 *   此时**不再复用那个永不 settle 的 Promise**，而是断开引用、重开一次（旧结果被忽略）。
 */
export const FLUSH_STUCK_MS = 60000;
/** 看门狗阈值可注入（单测用小值验证卡死路径；生产恒用 `FLUSH_STUCK_MS`） */
let flushStuckMs = FLUSH_STUCK_MS;
export function setFlushStuckMs(ms) { flushStuckMs = Math.max(1, Number(ms) || FLUSH_STUCK_MS); return flushStuckMs; }
/** 保存合流（在途保存共享同一 Promise；期间到达的请求在其结束后**补跑一次**） */
let saveInFlight = null;
let saveInFlightAt = 0;
let savePendingOpts = null;
/** 本次保存流水线**取到数据**时的变更序号（见 `saveStateNowInner` 步骤③） */
let lastEnvelopeSeq = 0;

/**
 * 本次保存是否可以安全跳过（无任何变化 + 上次完整保存在窗口内 + 未显式要求 force/skipFile=false 之外的动作）。
 */
function noopSaveOk(o) {
    try {
        if (o.force === true) return false;
        if (!lastFullPushAt || !lastTouchAt) return false;
        if (touchSeq > pushedSeq) return false;                               // 上次完整保存之后又动过数据 → 必须保存
        return (Date.now() - lastFullPushAt) < noopWindowMs;
    } catch (e) { return false; }
}

/**
 * 立即保存（V1 `saveState()` 的 V2 实现）。
 * @param {object} [opts] reason / skipFile（不写服务端文件）/ force（跳过「无变化」短路）
 * @returns {Promise<object>} { ok, via, bytes, error, skipped? }
 */
export async function saveStateNow(opts) {
    const o = opts || {};
    const st = kernelState();
    if (!st) return { ok: false, error: '无可保存的 state（未注入）' };
    // v3.0.15：**合流** —— 同一时刻只允许一次完整保存（此前并发触发会各写一遍：1.3MB 信封 ×N，
    //   每次都阻塞主线程数百毫秒，正是用户看到的「特别卡顿 / 卡死」）。期间到达的请求在结束后补跑一次。
    if (saveInFlight) {
        // v3.0.15：**卡死也要能重开** —— 否则一次挂住的保存在这里把后续所有保存永久堵死（同 flush 层的教训）
        const stuck = (Date.now() - saveInFlightAt) > flushStuckMs;
        if (!stuck) {
            savePendingOpts = Object.assign({}, savePendingOpts || {}, o);
            return saveInFlight;
        }
        try { kernelWarn('上一次保存超过 ' + Math.round(flushStuckMs / 1000) + 's 未返回（疑似卡死）→ 重新开一次；上一次的结果将被忽略'); } catch (e) { /* 忽略 */ }
        saveInFlight = null;
        savePendingOpts = null;
    }
    const touchedBefore = touchSeq;                 // 本次保存开始时已记录到的变更序号
    void touchedBefore;
    if (noopSaveOk(o)) {
        return { ok: true, via: 'noop', bytes: lastFullPushBytes, error: '', skipped: 'no-change' };
    }
    const mine = trackPipeline('保存记忆文件', { kind: 'io', phase: '写入存储', join: true }, async () => saveStateNowInner(o))
        .then((r) => {
            if (saveInFlight === mine) {
                saveInFlight = null;
                const again = savePendingOpts;
                savePendingOpts = null;
                // v3.0.15：**只在「信封取数之后」数据又变了**时才补跑。
                //   · 并发请求同一份数据 → 第一次已经写全，不再重复写；
                //   · 保存流水线内部的派生写入（②b 快照维护会经 `saveState()` 触发一次嵌套保存）发生在
                //     **取数之前**，其内容已包含在本次信封里 → 也不再重复写（此前每次建快照都要多写一遍全量信封）。
                if (again && touchSeq > lastEnvelopeSeq) { try { void saveStateNow(again); } catch (e) { /* 忽略 */ } }
            }
            return r;
        });
    saveInFlight = mine;
    saveInFlightAt = Date.now();
    return mine;
}

/** 实际保存（v3.0.0：外层 `saveStateNow` 只负责把它纳入管线状态） */
async function saveStateNowInner(o) {
    const st = kernelState();
    if (!st) return { ok: false, error: '无可保存的 state（未注入）' };
    // ① 索引基线（首次）→ 刷新原子 h + 建当前索引
    //   v3.0.15：建好的索引**交给墓碑扫复用**（`primeAtomIndex`）—— 此前 `atomIndexCur` 从没被赋值，
    //   同一份数据每次保存被完整哈希**两遍**（2000 条情节实测各 ~38ms），纯浪费。
    try {
        if (!indexReady) { entryIndexInit(); indexReady = true; }
        try { primeAtomIndex(entryIndexBuild(true)); } catch (e) { entryIndexBuild(true); }
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
        // v3.0.15：记下「本次信封取到的是哪个变更序号」——之后（更晚）的变更才需要补跑一次保存
        lastEnvelopeSeq = touchSeq;
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
            // B9-d：与 `adapters/sync.js#stateFileWrite` 同源的内容写入（瘦身/gzip 开关关闭时行为与 B7-2 一致）
            const r = await writeStateFileContent(envelope, text);
            if (r.ok) via.push('file');
            else if (r.error) kernelLog('保存：服务端文件不可用（' + r.error + '）');
        } catch (e) { /* 忽略 */ }
    }
    lastSave = { at: Date.now(), ok: via.length > 0, via: via.join('+'), bytes, error: '' };
    // v3.0.15：记录「最近一次完整保存」的时刻（供下次「数据无变化 → 直接短路」判断；见 `noopSaveOk`）
    if (via.indexOf('file') >= 0) { lastFullPushAt = lastSave.at; lastFullPushBytes = bytes; pushedSeq = touchSeq; }
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
    // B9-d：`stateFileGzip` 关闭（默认）时**仅读规范明文名** —— 与 B7-2 的请求序列/时序逐字节一致（零额外请求）；
    //   开启时先试 `.json.gz` 再回退明文（V1 的候选顺序）。读取按**内容魔数**解压（`readStateFileAuto`）。
    let r = await fileTransportReadAuto(stateFileName(scopeId()));
    if ((!r || !r.ok) && stateFileGzipOn()) r = await fileTransportReadAuto(stateFileGzName());
    if (!r || !r.ok) return null;
    try {
        const env = JSON.parse(r.text);
        if (env && env.payload) {
            const h = storageHash(env.payload);
            if (env.hash && env.hash !== h) return null;
            // B9-d：瘦身还原（写盘前剥掉的同义字段/空值由核心兜底；此处补回显示层字段）
            try { hydrateStorageData(env.payload.data); } catch (e) { /* 忽略 */ }
            return env.payload.data || null;
        }
        return env || null;
    } catch (e) { return null; }
}

/** 删除服务端文件（数据管理用） */
export async function removeServerFile() {
    return fileTransportDelete(stateFileName(scopeId()));
}

/**
 * 给内核接线持久化钩子：内核里任何 `saveState()` / `saveCfg()` 调用都会落到本模块。
 * @returns {object} 接线摘要
 */
/**
 * v3.0.3（用户要求）：「每次被动提取记忆及原子数据发生变化，后应该触发保存到服务器的操作。」
 *
 * `scheduleSave` 是**防抖**保存（800ms 内多次变更合并成一次）；本函数是**立即**保存（含服务端文件），
 * 用于「数据刚变 → 马上写服务端」的确定性语义。纪律：
 *   · **并发合并**：已有 flush 在途时不再叠加，只记一个「还有变更」的标记，在途结束后**补跑一次**；
 *   · 失败不抛（与保存流水线同口径），错误进 `lastSave.error` 与调试日志。
 * @param {string} [reason]
 * @returns {Promise<object>} 保存结果（与 `saveStateNow` 同形）
 */
let flushInFlight = null;
let flushInFlightAt = 0;
let flushPendingReason = '';
/**
 * v3.0.14：**立即保存的看门狗**。一次 flush 超过该时长仍未返回即视为**卡死**（宿主/服务端挂住），
 *   此时不再让后续 flush 继续复用那个永不 settle 的 Promise（v3.0.3 的合流语义在「挂住」时会
 *   把所有后续立即保存**永久堵死**，用户看到的就是「保存记忆文件」一直不结束）。
 */
export function flushStateNow(reason, opts) {
    const o = opts || {};
    const why = String(reason || 'flush');
    const stuck = !!(flushInFlight && (Date.now() - flushInFlightAt) > flushStuckMs);
    if (flushInFlight && !stuck) { flushPendingReason = why; return flushInFlight; }
    if (stuck) {
        // 卡死：断开引用（旧 Promise 之后 resolve 也不会再回写本模块状态）→ 本次重新开一次保存
        try { kernelWarn('立即保存超过 ' + Math.round(flushStuckMs / 1000) + 's 未返回（疑似卡死）→ 重开一次；上一次的结果将被忽略'); } catch (e) { /* 忽略 */ }
        flushInFlight = null;
        flushPendingReason = '';
    }
    const mine = Promise.resolve()
        .then(() => saveStateNow(Object.assign({}, o, { reason: why })))
        .catch((e) => ({ ok: false, error: String((e && e.message) || e), via: '', bytes: 0 }))
        .then((r) => {
            if (flushInFlight === mine) {            // 只由**当前**在途的那次收尾（卡死的旧 Promise 到此不再影响状态）
                flushInFlight = null;
                const again = flushPendingReason;
                flushPendingReason = '';
                if (again) void flushStateNow(again, o);
            }
            return r;
        });
    flushInFlight = mine;
    flushInFlightAt = Date.now();
    return mine;
}

export function wirePersistHooks() {
    setPersistHooks({
        // v3.0.15：内核 `saveState()` = 「数据已变化」的落盘请求 → 刷新触碰时间戳（决定能否走「无变化」短路）
        saveState: () => { markDataTouched(); void saveStateNow({ reason: 'kernel' }); return true; },
        // v3.0.3（用户要求）：内核「数据变化 → 立刻写服务端」的落地点（并发自动合并，见 flushStateNow）
        persistNow: (reason) => { markDataTouched(); void flushStateNow(reason || 'kernel'); return true; },
        saveCfg: () => saveKernelCfg(),
        log: (m, e) => { if (e !== undefined) kernelLog(m, e); },
        // v2.87.0 修复：此前是 `() => undefined` —— 内核所有 `warn(...)` 被静默丢弃（用户报告「什么都没反应」）。
        //   现在写进调试日志（kind = 异常，便于调试页筛选与调试包取证）；用户可见提示由 `runtime.js#warn` 统一发出。
        warn: (...a) => { try { debugLogPush('异常', { action: '内核告警', message: a.map((x) => (x instanceof Error ? x.message : String(x == null ? '' : x))).join(' ').slice(0, 300) }); } catch (e) { /* 忽略 */ } },
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
 * **清空当前角色的 FTT 记忆**（V1 `resetState()` ~3440 的 V2 等价实现；B9-a）。
 *
 * V1 原文（逐条对齐）：
 * ```js
 * function resetState() {
 *     // 整库清空保持「单端语义」—— 抑制自动留痕（不生成整批墓碑把对端也清掉）
 *     tombstoneSweepPause();
 *     try { state = emptyState(); saveState(); }
 *     finally { tombstoneSweepResume(); entryIndexInit(); }
 * }
 * ```
 * 适配差异：
 *   ① `state = emptyState()` → 内核注入视图 `setKernelState(emptyState())`（V2 的 `state` 由宿主注入，不可直接赋值）；
 *   ② `saveState()` → 本模块 `saveStateNow({ reason:'reset' })`（同一保存流水线：索引 → 墓碑留痕（此处被抑制）→ 写库）；
 *   ③ `entryIndexInit()` → `primeStateIndex()`（对齐空容器基线，使复位后的首次真实删除仍能被留痕）；
 *   ④ V1 无返回值；V2 额外返回 `{ ok, cleared, via, bytes }` 供面板如实回报（**不改 V1 语义**）。
 *
 * @returns {Promise<{ok:boolean, action:string, cleared:object, via:string, bytes:number, error?:string}>}
 */
export async function resetState() {
    // 清空前的计数快照（面板回报用；只读，不影响 V1 语义）
    const cleared = (() => {
        try {
            const keys = ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'currencies', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'plotSegments', 'rumors', 'links', 'summaries', 'processedFloors'];
            const per = {};
            let total = 0;
            for (const k of keys) { const n = Array.isArray(state && state[k]) ? state[k].length : 0; per[k] = n; total += n; }
            return { total: total, per: per, tombs: Object.keys((state && state.deleted) || {}).length };
        } catch (e) { return { total: 0, per: {}, tombs: 0 }; }
    })();
    tombstoneSweepPause();                       // V1：抑制自动留痕（不生成整批墓碑把对端也清掉）
    let saved = null;
    try {
        setKernelState(emptyState());            // V1：state = emptyState()
        saved = await saveStateNow({ reason: 'reset', force: true });        // v3.0.15：清空是直接写入 → 永不走「无变化」短路
        // V1 `saveState()` 收尾会 materialize `state.snapStore = state.snapStore || []`（无原子也执行，紧接 `saveStateRaw` 之后）；
        //   此处同款，使**复位后的内存态键集**与 V1 一致（黄金样本 tests/fixtures/v1-golden-reset.json#afterKeys 为 29 键）。
        if (state && !Array.isArray(state.snapStore)) state.snapStore = [];
    } finally {
        tombstoneSweepResume();
        primeStateIndex();                       // V1：entryIndexInit()
    }
    const ok = !!(saved && saved.ok);
    return { ok: ok, action: 'resetState', cleared: cleared, via: String((saved && saved.via) || ''), bytes: Number((saved && saved.bytes) || 0), error: ok ? '' : String((saved && saved.error) || '保存失败') };
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
