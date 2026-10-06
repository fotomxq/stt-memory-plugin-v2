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
import { state, cfg as cfgRef, setPersistHooks, setKernelState, log as kernelLog, warn as kernelWarn, notifyHooks } from '../core/model/runtime.js';
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
// v3.0.21（用户要求「每次数据变动立刻分片提交到服务端存储」）：按维度分片 + 分片清单
import { writeStateShards, applyNewerShards, shardManifestName, META_SHARD, SHARD_DIMS } from './shards.js';
import { scheduleWorldbookSync } from './worldbook.js';
// v3.16.0（用户要求）：**本地文件存储模式** —— 路径非空时，本机缓冲层改走宿主的本地文件（无 localStorage 配额限制）
import { localFileEnabled, localFileWrite, localFileRead, localFileName, localFileFileKey, localFileStatsGet, localFilePath, localFilePathSanitize, localFileDirHistory, localFileDirRemember, localFileRealLocation } from './local-file.js';
// v3.26.5（用户要求「设置了目录则内存 / 变量 / 传统本地存储全部作废，仅用本地文件」）：对齐 / 换目录时
//   把**聊天元数据**（只读旧载体）也算进候选源 —— 它虽然不由 V2 写入，但「哪份最新就用哪份」才对得起用户。
import { chatMetaLoadState } from './chat-meta.js';
// v3.26.2（用户报告「本机缓冲超预算 → 本次跳过」会造成数据异常）：本机缓冲改**压缩留存**
import { gzipToBase64, gunzipFromBytes, base64ToBytes, gzipAvailable } from './gzip.js';
import { hydrateStorageData } from '../core/slim.js';
// v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：保存 / 同步类动作也进管线状态
import { trackPipeline } from '../core/pipeline.js';
import { debugLogPush } from './debug-log.js';   // v2.87.0：内核 warn → 调试日志（kind = 异常）
// v3.0.23（用户要求「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志，方便追踪问题」）
//   —— 载入路径的每一次读取都进**读取台账**（`core/read-ledger.js`），并逐层回报「读到什么 / 多久 / 多少条」。
import { readLedgerBegin, readLedgerEnd, readLedgerRecord, readLedgerStats } from '../core/read-ledger.js';
// v3.1.0（`docs/D13` R2/Q7）：关联层容量上限（保存流水线收尾处执行）
import { capRelLinks } from '../core/rel-maint.js';

const SAVE_DEBOUNCE_MS = 800;
let saveTimer = null;
let lastSave = { at: 0, ok: false, via: '', bytes: 0, error: '' };
let indexReady = false;

/** 保存记录（调试与 /ftt 输出） */
export function lastSaveInfo() {
    return Object.assign({}, lastSave);
}

/** localStorage 兼容钩子（宿主可注入；默认用 globalThis.localStorage）；v3.3.0：+`keys()`（缓冲清点需要枚举键） */
let storageHooks = {
    getItem: (k) => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; } catch (e) { return null; } },
    setItem: (k, v) => { try { if (globalThis.localStorage) { globalThis.localStorage.setItem(k, v); return true; } } catch (e) { /* 忽略 */ } return false; },
    removeItem: (k) => { try { if (globalThis.localStorage) { globalThis.localStorage.removeItem(k); return true; } } catch (e) { /* 忽略 */ } return false; },
    keys: () => {
        try {
            const ls = globalThis.localStorage;
            if (!ls) return [];
            const out = [];
            for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k != null) out.push(String(k)); }
            return out;
        } catch (e) { return []; }
    },
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

// ==================== v3.26.0：内存库（IndexedDB）层的读取 / 清除 / 回写 ====================
/**
 * 为什么需要这三个小函数：用户要求「设置了本地缓冲目录 → 不再使用内存或变量存储」。
 * 于是迁移（`switchLocalLayer`）必须**两层一起处理**：启用时把更新的那份迁进目录并清掉两层，
 * 关闭时把目录内容**同时**放回两层。读取口径与 `loadFromIndexedDB()` 一致（同一个键、同一个信封）。
 * 全部**不抛**（本机层故障绝不影响主流程）。
 */
async function idbEnvelopeText() {
    try {
        const lf = await localforageLib();
        if (!lf || typeof lf.getItem !== 'function') return '';
        const v = await lf.getItem('ftt2_state_' + scopeId());
        if (v == null) return '';
        return (typeof v === 'string') ? v : JSON.stringify(v);
    } catch (e) { return ''; }
}
/** 删除内存库里的当前作用域副本（返回是否真的删了） */
async function idbRemoveCopy() {
    try {
        const lf = await localforageLib();
        if (!lf || typeof lf.removeItem !== 'function') return false;
        await lf.removeItem('ftt2_state_' + scopeId());
        return true;
    } catch (e) { return false; }
}
/** 把信封文本写回内存库（关闭目录模式时恢复本机层；解析失败即不写） */
async function idbWriteEnvelope(text) {
    try {
        const lf = await localforageLib();
        if (!lf || typeof lf.setItem !== 'function') return false;
        const env = JSON.parse(String(text));
        if (!env || !env.payload) return false;
        await lf.setItem('ftt2_state_' + scopeId(), env);
        return true;
    } catch (e) { return false; }
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
 * v3.0.18（用户报告「前期修复的存储异常 / 重开应用后存档丢失**再次出现**」）——**内容签名**。
 *
 * v3.0.15 的「数据无变化 → 保存短路」只信**内核 `saveState()` 钩子**打的时间戳，等于假设
 *   「所有会改数据的地方都记得调 `saveState()`」。事实并非如此：例如面板「删除快照」
 *   （`ui/snapshots.js#snapshotAction` 的 `snapDelete`）直接改 `state.snapStore` 而**不落盘**，
 *   这类改动在窗口内会被短路掉 → 只活在内存里；此时若重开应用 / 刷新页面，**改动就丢了**
 *   （用户看到的「存档丢失」）。
 *
 * 现在的判据是**内容级**的：只有「当前数据 + 容器时间戳」算出的签名与**上次成功上传的内容**
 *   **逐字节相同**才跳过 —— 任何改动（不管有没有调 `saveState()`）都逃不过比对，
 *   于是短路不可能吞掉任何变化；`touchSeq` 只作为「已经知道变了 → 不必再算签名」的**快速路径**。
 */
let lastPushSig = '';          // 上次成功上传的**信封哈希**（`storageEnvelope` 已经算过，零额外成本）
let lastPushScope = '';        // 该次信封的 scope
let lastPushEnvAt = 0;         // 该次信封的 payload.updatedAt（比对时用它复现同一份载荷）
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
 * v3.1.0（`docs/D13` R1/Q5）：**本机缓冲（localStorage）的字符预算**。
 *
 * 实测（D13 §3.1/§3.5）：极端形状（4040 条）状态信封 = **2.64M 字符**，而 5MB 按 UTF-16 折算 ≈ **2,621,440 字符**
 *   —— 单键就压线；再叠加调试日志（上限 0.6M 字符，见 Q6）必然越界。越界时 `setItem` 抛错被 `catch` 吞掉，
 *   用户看不到任何提示（表现为「本机缓冲层静默停更」）。
 * 现在：**写入前先按字符数判预算**，超预算直接跳过本机缓冲（仍写 IndexedDB + 服务端文件），
 *   并把「跳过 / 写入失败」如实记进调试日志与 `localBufferState()`，供面板与调试包读取。
 * 预算默认 1.8M 字符（≈3.4MB UTF-16），给调试日志 / 追踪尾部 / 其它扩展留出余量。
 */
export const LOCAL_BUFFER_MAX_CHARS = 1800000;
let localBufferMaxChars = LOCAL_BUFFER_MAX_CHARS;
/** 覆盖预算（测试用；0 = 用默认） */
export function setLocalBufferMaxChars(n) { localBufferMaxChars = Math.max(0, Number(n) || 0); return localBufferMaxChars; }

// ============================================================
// v3.26.2（用户报告：「保存：本机缓冲超预算 → 本次跳过 … {"chars":1994370,"budget":1800000}」
//   ——「该问题会造成数据异常，请核对解决思路，或在本地存储中用更好的方法留存数据。」）
//
// 事实：本机缓冲是**本机层的兜底副本**；超预算就整层停更 → 本机只留 IndexedDB 与服务端，
//   「本机缓冲」不再是最近一次的数据（换设备 / 服务端读失败时看到的是**旧副本** → 观感就是数据回滚）。
//
// 解决思路（本批）：**不再直接放弃，而是压缩后留存** ——
//   ① 明文信封超过 `LOCAL_BUFFER_GZ_MIN_CHARS`（或超过预算）时，先 `gzip → base64` 写一条**压缩记录**
//      `{"ftt2gz":1,"at":…,"chars":<原始字符数>,"b64":"…"}`；真实状态 2M 字符 → 记录通常几十~几百 KB，
//      于是「超预算」在正常体量下不再发生（压缩比见 `docs/D13`：≈35×）；
//   ② 仍然超预算（内容不可压 / 预算被调得很小）或**宿主不支持压缩**时：如实跳过 + **一次性可操作提示**
//      （告诉用户去「设定 → 存储」设「本机缓冲目录」，该模式下本机缓冲写本地目录、不受浏览器配额限制）；
//   ③ 一旦发生跳过，落一条**停滞标记**（`ftt2_LocalStale`，几百字节）→ 下次启动能如实告诉用户
//      「本机层自 <时间> 起未更新」，而不是让人以为本机副本是新的；任一次成功写入即清除该标记；
//   ④ 读路径两种格式都认（明文走原来的**同步**路径、零额外微任务；压缩记录多一次 `await` 解压），
//      校验口径完全一致（信封完整 + 载荷哈希）。
//
// 纪律：压缩记录**只是本机缓存**，不是数据契约 —— 服务端文件 / 分片 / 快照 / IndexedDB 的格式一字未动。
// ============================================================
/** 明文信封超过该字符数就用压缩记录留存（200K：低于它压缩收益小、还平白多一次解压） */
export const LOCAL_BUFFER_GZ_MIN_CHARS = 200000;
/** 压缩记录的固定前缀（用于**同步**判定「这一条需要解压」——避免无谓的 JSON.parse 1MB 文本） */
const LOCAL_GZ_MARK = '{"ftt2gz":1';
/** 本机层停滞标记的键（只在「跳过」时写入；成功写入即删） */
const LOCAL_STALE_KEY = 'ftt2_LocalStale';

/** 存放形态：`empty` / `plain`（明文信封）/ `gz`（压缩记录） */
function localRecordKind(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return 'empty';
    return (s.charCodeAt(0) === 0x7b && s.slice(0, 16).indexOf('"ftt2gz"') >= 0) ? 'gz' : 'plain';
}
/** v3.26.2：该本机记录文本是否是**压缩记录**（供别的模块识别，如 `adapters/sync.js` 的校验并修复） */
export function isLocalGzRecord(raw) {
    try { return localRecordKind(raw) === 'gz'; } catch (e) { return false; }
}
/**
 * v3.26.2：把**压缩记录**解压回明文信封文本（异步；失败返回 `''`）。
 * 校验口径与读路径一致：记录形状 → base64 → gunzip；任何一步失败都返回空串（调用方按未命中处理）。
 */
export async function inflateLocalGzRecord(raw) {
    try {
        if (!isLocalGzRecord(raw)) return '';
        const rec = JSON.parse(String(raw));
        const u8 = base64ToBytes(String((rec && rec.b64) || ''));
        if (!u8 || !u8.length) return '';
        const text = await gunzipFromBytes(u8);
        return (text === null || text === undefined) ? '' : String(text);
    } catch (e) { return ''; }
}
/** 该作用域的本机记录是否需要**异步解压**（供载入路径决定是否多一次 await） */
export function localBufferGzPending(scope) {
    try { return localRecordKind(storageHooks.getItem('ftt2_state_' + (scope || scopeId()))) === 'gz'; } catch (e) { return false; }
}
/** 组装压缩记录文本 */
function gzRecordText(plainChars, b64) {
    return LOCAL_GZ_MARK + ',"at":' + Date.now() + ',"chars":' + Number(plainChars || 0) + ',"b64":"' + String(b64 || '') + '"}';
}
/** 明文信封解析（同步；两条读路径**共用同一校验口径**） */
function parseLocalEnvelopeText(raw) {
    try {
        const env = JSON.parse(String(raw));
        if (!env || !env.payload) return { ok: false, reason: 'bad-envelope', state: null };
        const h = storageHash(env.payload);
        if (env.hash && env.hash !== h) return { ok: false, reason: 'hash-mismatch', state: null, hash: h };
        return { ok: true, reason: '', state: env.payload.data || null, hash: h };
    } catch (e) { return { ok: false, reason: 'parse-failed', state: null, error: String((e && e.message) || e) }; }
}
/** 本机层「停滞」的**内存态**（v3.26.2）：为真时**不允许**走「等值跳过」——
 *  否则「上次被跳过（标记在）+ 内容没变」会让本机层永远补不上（真机上表现为本机副本长期陈旧）。 */
let localStaleMarked = false;
/** 本机层停滞标记（如实告知「本机层自何时起未更新」；无标记 → null） */
export function localStaleInfo() {
    try {
        const raw = storageHooks.getItem(LOCAL_STALE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!(o && typeof o === 'object')) return null;
        localStaleMarked = true;                    // 读到标记 → 内存态同步（跨会话也生效）
        return { at: Number(o.at) || 0, chars: Number(o.chars) || 0, budget: Number(o.budget) || 0, reason: String(o.reason || '') };
    } catch (e) { return null; }
}
function localStaleMark(chars, budget, reason) {
    localStaleMarked = true;
    try { storageHooks.setItem(LOCAL_STALE_KEY, JSON.stringify({ at: Date.now(), chars: Number(chars) || 0, budget: Number(budget) || 0, reason: String(reason || '') })); } catch (e) { /* 忽略 */ }
}
function localStaleClear() {
    // 注意：**不做 getItem 预检**（避免给「本机缓冲读取次数」这类既有口径加噪声）；
    // 删不存在的键是幂等无副作用的（同时也是跨会话清除上一条停滞标记的唯一途径）。
    localStaleMarked = false;
    try { storageHooks.removeItem(LOCAL_STALE_KEY); } catch (e) { /* 忽略 */ }
}
/** 「本机缓冲跳过」的**一次性**可操作提示（每个会话最多一次；避免每次保存都弹） */
let localSkipHintShown = false;
function localSkipHintOnce(chars, budget) {
    if (localSkipHintShown) return false;
    localSkipHintShown = true;
    try {
        const msg = '本机缓冲已超出浏览器配额（' + Number(chars || 0).toLocaleString() + ' > ' + Number(budget || 0).toLocaleString()
            + ' 字符）→ 本机层停更（服务端与内存库不受影响）。'
            + '建议：设定 → 存储 → 设置「本机缓冲目录」——该模式下本机缓冲写本地目录，不受配额限制。';
        if (notifyHooks && typeof notifyHooks.toast === 'function') notifyHooks.toast(msg, 'warning');
    } catch (e) { /* 忽略 */ }
    return true;
}
/** 测试/诊断用：重置一次性提示开关 */
export function resetLocalSkipHint() { localSkipHintShown = false; return true; }

/** 最近一次本机缓冲写入结论（诊断 / 面板 / 调试包） */
let localBuffer = { at: 0, ok: false, skipped: 'never-written', chars: 0, budget: LOCAL_BUFFER_MAX_CHARS, reason: '' };
export function localBufferState() { return Object.assign({}, localBuffer, { stats: localBufferStats() }); }

// ============================================================
// v3.10.4（真机取证 A4）：本机缓冲的**读放大**与**写放大**
//
// 实测（只读调试桥）：一次会话里「本机缓冲」被读 19 次、每次 1.05MB（累计 ≈19.9MB），
//   单次 1–12ms（**233ms 那次是服务端主文件的解析**，不是本层）；而每次状态变化都**全量重写** 1.11MB
//   （3 分钟内 11 次）。风险：同步全量写造成卡顿；localStorage 配额（5–10MB）被单键长期占住 1.1MB。
//
// 本版做的（都**只作用于本层**，且不改变任何读写语义）：
//   ① **解析缓存**：仍然每次都读原始文本（**真相优先**），文本未变时不再重复 `JSON.parse` + 信封哈希；
//   ② **等值跳过**：信封与上次写入**逐字节同源**（同哈希 + 同长度）→ localStorage / IndexedDB 都不重写；
//   ③ 配额守卫沿用 v3.1.0（超字符预算 → 跳过并如实留痕），并把读写计数并入诊断。
//   ⇒ **刻意不做时间节流**：本机缓冲是「保存后必须立刻可读」的一层（v3.0.23 的读写对齐纪律，
//     由 `store-chat` 的 S2/S3/S7 断言锁定），按时间推迟写入会让该层短暂落后于内存态，得不偿失。
//     真机上写入次数由**内容真实变化次数**决定；把它降下来的另一半来自 A5 ——
//     调试日志此前**每次 push 都整体重写 localStorage**（含 69% 的「读取」噪声），A5 直接砍掉了那部分写放大。
// ============================================================

let localParseCache = null;           // { key, raw, payload, items }：文本未变 → 复用解析结果
let localLastSig = '';               // 上次写入的载荷签名（长度 + 信封哈希，避免比较 1MB 字符串）
const localStats = { reads: 0, parseHits: 0, writes: 0, unchanged: 0, idbWrites: 0, idbSkipped: 0, overBudget: 0, failed: 0, gzipWrites: 0, gzipReads: 0, gzUnavailable: 0, lastWriteAt: 0, lastSkipReason: '' };
/** 本机缓冲读写统计（诊断 / 面板 / 调试包；`localBufferState().stats` 同源） */
export function localBufferStats() { return Object.assign({}, localStats); }

/**
 * 忘记本层已知状态（v3.10.4）：**解析缓存** + **上次写入签名** 一起清掉。
 * 任何「本层已被外部改动」的路径都必须调用它 —— 否则会出现两类缺口：
 *   ① 刚清空却仍能读回旧信封（解析缓存残留）；
 *   ② **清空后同内容保存被「等值跳过」→ 本机缓冲一直不被写回**（签名残留，真机上由 `local-copy` B1 复现）。
 */
export function invalidateLocalBufferCache() {
    localParseCache = null;
    localLastSig = '';
    return true;
}
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
/** v3.1.0：最近一次关联层裁剪（诊断；`changed=false` 时保留上一次记录） */
let lastRelCap = { at: 0, before: 0, after: 0, max: 0, dropped: 0, orphans: 0, changed: false };

/**
 * 本次保存是否可以安全跳过（无任何变化 + 上次完整保存在窗口内 + 未显式要求 force/skipFile=false 之外的动作）。
 */
function noopSaveOk(o, st) {
    try {
        if (o.force === true) return false;
        if (!lastFullPushAt || !lastPushSig) return false;
        if ((Date.now() - lastFullPushAt) >= noopWindowMs) return false;      // 窗口外一律完整保存（自愈）
        if (touchSeq > pushedSeq) return false;                               // 快速路径：内核已标记「数据变过」→ 直接保存
        return pushSigOf(st) === lastPushSig;                                 // ★ 权威判据：与上次上传的内容逐字节比对
    } catch (e) { return false; }
}

/**
 * 载荷内容签名：用**上次上传时那份信封的 `scope + payload.updatedAt`** 复现载荷，只把数据换成当前内存数据。
 * 于是「签名相同」⇔「当前数据与上次上传的内容逐字节相同」（比较的就是同一个哈希函数、同一份键序）。
 */
function pushSigOf(st) {
    try {
        if (!lastPushSig) return '';
        return storageHash({ scope: lastPushScope || scopeId(), updatedAt: Number(lastPushEnvAt) || 0, data: st });
    } catch (e) { return ''; }
}

/**
 * v3.0.21：**条目数统计**（原子维度 + 货币；用于「异常缩水」守卫）
 * @param {object} st 状态
 * @returns {{total:number, dims:object}}
 */
function countsOf(st) {
    const dims = {};
    let total = 0;
    try {
        for (const d of SHARD_DIMS) {
            const n = Array.isArray(st && st[d]) ? st[d].length : 0;
            dims[d] = n;
            total += n;
        }
    } catch (e) { /* 忽略 */ }
    return { total: total, dims: dims };
}

/** 上一次**成功写入**（或载入来源）的条目数基线 */
let lastPushCounts = null;
/** 是否已记录基线（载入来源也算，避免首次保存就误判） */
export function primeShrinkBaseline(st) { try { lastPushCounts = countsOf(st); return lastPushCounts; } catch (e) { return null; } }

/**
 * 「异常缩水」判定：本次要写的状态相比基线丢了 `dropped` 条，而本次**新增的删除墓碑**只有 `tombstoned` 条，
 *   且 `dropped - tombstoned` 超过容差（比例 ≥ 30% 且至少 20 条）→ 判为异常（疑似读到残缺状态），**拒绝写覆盖**。
 * 说明：用户显式删除会写墓碑（`deleted/deletedH`）→ 不会被拦；清空 / 导入 / 手动同步走 `force`。
 * @param {object} st 待写状态
 */
function shrinkGuardCheck(st) {
    try {
        const now = countsOf(st);
        if (!lastPushCounts || !Number.isFinite(Number(lastPushCounts.total))) return { blocked: false, detail: null };
        const before = Number(lastPushCounts.total) || 0;
        const after = Number(now.total) || 0;
        const dropped = Math.max(0, before - after);
        const tombstoned = (() => {
            try {
                let n = 0;
                for (const d of SHARD_DIMS) {
                    const a = (st && st.deleted && st.deleted[d]) || {};
                    const b = (st && st.deletedH && st.deletedH[d]) || {};
                    n += Object.keys(a).length + Object.keys(b).length;
                }
                const prev = (lastPushCounts && lastPushCounts.tombs) || 0;
                return Math.max(0, n - prev);
            } catch (e) { return 0; }
        })();
        const unexplained = dropped - tombstoned;
        const ratio = before > 0 ? (dropped / before) : 0;
        const blocked = before >= 30 && unexplained >= 20 && ratio >= 0.3;
        return {
            blocked: blocked, before: before, after: after, dropped: dropped, tombstoned: tombstoned, ratio: ratio,
            detail: { before: before, after: after, dropped: dropped, tombstoned: tombstoned, ratio: Math.round(ratio * 100) / 100 },
        };
    } catch (e) { return { blocked: false, detail: null }; }
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
    const inFlightForced = (o.force === true);      // 本次在途保存是否已「强制完整保存」（供合流补跑判定复用）
    if (noopSaveOk(o, st)) {
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
                // v3.0.18：**内核路径**只在「信封取数之后数据又变了」时补跑（避免保存自身的派生写入造成循环）；
                //   其它调用方（控制台 / 导入 / 清空 / 事件防抖保存…）一律补跑一次 —— 它们的改动不一定经内核钩子，
                //   v3.0.15 只看 `touchSeq` 时这类「保存期间到达的改动」会被静默吞掉（数据丢失的另一条路径）。
                //   · 「同在途的那次已经是强制完整保存」时，一个同样强制（`force`）的合流请求已被满足 → 不再重复写
                const needAgain = !!again && (
                    touchSeq > lastEnvelopeSeq
                    || again.fromKernel !== true && !(again.force === true && inFlightForced)
                );
                if (needAgain) { try { void saveStateNow(again); } catch (e) { /* 忽略 */ } }
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
    // ⑤b v3.0.21（用户要求「修复存储异常，当退出应用后，插件的数据大量回滚…建议一劳永逸」）——
    //   **无墓碑的大规模缩水 → 拒绝写盘覆盖**。
    //   回滚的真实成因：内存里偶然拿到一份**残缺状态**（聊天未就绪 / 作用域切换 / 载入竞态）时，
    //   后续保存会把这份残缺状态**覆盖**到本机缓冲与服务端文件上，于是「一退出应用数据就大量回滚」。
    //   判据与「楼层骤缩」同源：本次条目数与**上一次成功写入**（或载入来源）比较，
    //   丢掉的条目数**明显超过**本次新增的删除墓碑数（说明不是用户显式删除）→ 判为异常，**本次一律不写**，
    //   只留调试日志与告警；用户明确的操作（清空记忆 / 导入 / 手动同步）走 `force` 不受限。
    //   ⚠️ 必须放在**② 删除留痕之前**：`tombstoneSweep()` 会把本次消失的条目自动记成墓碑，
    //   若放在它之后，「残缺状态」看上去就与「用户显式删除」一模一样（守卫会失效）。
    if (o.force !== true) {
        try {
            const guard = shrinkGuardCheck(st);
            if (guard.blocked) {
                lastSave = { at: Date.now(), ok: false, via: '', bytes: 0, error: 'shrink-guard' };
                try { kernelWarn('保存被拦下：条目数异常缩水（疑似读到残缺状态）→ **未覆盖**本机缓冲与服务端数据', guard.detail); } catch (e) { /* 忽略 */ }
                try { debugLogPush('异常', { action: '保存拦截（异常缩水）', before: guard.before, after: guard.after, dropped: guard.dropped, tombstoned: guard.tombstoned }); } catch (e) { /* 忽略 */ }
                return { ok: false, via: '', bytes: 0, error: 'shrink-guard', blocked: true, guard: guard };
            }
        } catch (e) { /* 守卫失败不阻塞保存（保守方向：照常写） */ }
    }
    // ① 索引基线（首次）→ 刷新原子 h + 建当前索引
    //   v3.0.15：建好的索引**交给墓碑扫复用**（`primeAtomIndex`）—— 此前 `atomIndexCur` 从没被赋值，
    //   同一份数据每次保存被完整哈希**两遍**（2000 条情节实测各 ~38ms），纯浪费。
    try {
        if (!indexReady) { entryIndexInit(); indexReady = true; }
        try { primeAtomIndex(entryIndexBuild(true)); } catch (e) { entryIndexBuild(true); }
    } catch (e) { kernelWarn('保存：刷新原子哈希失败', e); }
    // ② 删除自动留痕（先于写库：墓碑随本次信封一起持久化）
    try { tombstoneSweep(); } catch (e) { kernelWarn('保存：删除留痕失败', e); }
    // ②c v3.1.0（`docs/D13` R2/Q7）：**关联层容量上限**（上限 = max(200, 条目数×2)；超出先删孤儿、再淘汰最旧行）。
    //   放在墓碑扫之后：本次真正消失的条目已留痕，孤儿判定与新墓碑一致；幂等（不超限零改动）。
    try {
        const capRes = capRelLinks(st, {});
        if (capRes && capRes.changed) {
            lastRelCap = Object.assign({ at: Date.now() }, capRes);
            try { debugLogPush('存储', { action: '关联层超上限 → 已裁剪', before: capRes.before, after: capRes.after, max: capRes.max, dropped: capRes.dropped, orphans: capRes.orphans }); } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 裁剪失败不影响保存 */ }
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
    // ④ 本机缓冲（localStorage 信封）—— v3.1.0：**写入前按字符预算判定**（超预算如实跳过并留痕）
    //   v3.10.4（A4）：再加一道**等值跳过** —— 与上次写入逐字节同源（同信封哈希 + 同长度）时不重写 1MB。
    //   v3.16.0（用户要求「本地文件存储模式替代变量存储」）：**路径非空时本层改走本地文件**（无 localStorage 配额限制）。
    let localViaFile = false;
    try { localViaFile = localFileEnabled(); } catch (e) { localViaFile = false; }
    try {
        const key = 'ftt2_state_' + scopeId();
        const budget = localBufferMaxChars > 0 ? localBufferMaxChars : LOCAL_BUFFER_MAX_CHARS;
        const sig = String(envelope && envelope.hash ? envelope.hash : '') + ':' + text.length;
        // v3.26.2：本机层处于「停滞」状态时**不允许等值跳过** —— 否则「上次被跳过 + 内容没变」会永远补不上
        if (localLastSig !== '' && localLastSig === sig && !localStaleMarked) {
            localStats.unchanged += 1;
            localStats.lastSkipReason = 'unchanged';
            localBuffer = { at: Date.now(), ok: true, skipped: 'unchanged', chars: text.length, budget: budget, reason: '与上次写入内容相同 → 跳过', layer: localViaFile ? 'local-file' : 'localStorage' };
            try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: true, miss: true, bytes: 0, reason: 'unchanged', note: '与上次写入内容相同 → 跳过（不重复写 1MB）', extra: { layer: localViaFile ? 'local-file' : 'localStorage' } }); } catch (e) { /* 忽略 */ }
        } else if (localViaFile) {
            // **本地文件模式**：写到用户约定的路径（宿主的本地文件），**不再写 localStorage**（= 取代变量层）
            const wr = await localFileWrite(text, scopeId());
            if (wr && wr.ok) {
                via.push('local-file');
                markLocalWritten(sig, text.length);
                lastPathMemory = String(wr.path || localFilePath());
                localBuffer = { at: Date.now(), ok: true, skipped: '', chars: text.length, budget: budget, reason: '', layer: 'local-file', backend: String(wr.backend || '') };
                try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: true, bytes: text.length, extra: { budget: budget, layer: 'local-file', path: String(localFileStatsGet().path || '') } }); } catch (e) { /* 忽略 */ }
            } else {
                // v3.26.0（用户要求「设置了本地缓冲目录则不再使用内存或变量存储，只保留本地目录和服务端存储」）：
                //   文件写失败**不再回退变量层** —— 回退等于偷偷把数据写回用户明确要求停用的那一层
                //   （且下一次读取会因「变量层有货」而与用户预期不符）。此处如实回报失败，由用户按提示处理。
                localStats.failed += 1;
                localStats.lastSkipReason = 'file-write-failed';
                localBuffer = { at: Date.now(), ok: false, skipped: 'write-failed', chars: text.length, budget: budget, reason: '本地目录写入失败（本地模式不回退变量层）', layer: 'local-file' };
                try { kernelWarn('保存：本地目录写入失败（本地模式不写变量层；服务端文件不受影响）', { path: String(localFileStatsGet().path || ''), error: String((wr && wr.error) || '') }); } catch (e) { /* 忽略 */ }
                try { debugLogPush('存储', { action: '本地目录写入失败 → 不回退变量层', path: String(localFileStatsGet().path || ''), error: String((wr && wr.error) || ''), chars: text.length }); } catch (e) { /* 忽略 */ }
                try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: false, bytes: text.length, reason: 'file-write-failed', note: '本地模式：写目录失败 → 不回退变量层' }); } catch (e) { /* 忽略 */ }
            }
        } else {
            // 普通模式：明文 / 压缩二选一，再按预算判定（v3.26.2 起**压缩优先**）
            //   · 明文超过 `LOCAL_BUFFER_GZ_MIN_CHARS` 或超过预算 → 试压缩；
            //   · 压缩记录**更省**时才用它（超预算时它是唯一可行路径）；
            //   · 仍然装不下 / 宿主不支持压缩 → 如实跳过 + 停滞标记 + 一次性可操作提示。
            const wantGz = text.length >= LOCAL_BUFFER_GZ_MIN_CHARS || (budget > 0 && text.length > budget);
            let rec = '';
            let gzTried = false;
            let gzOk = false;
            if (wantGz) {
                gzTried = true;
                const g = await (async () => { try { return await gzipToBase64(text); } catch (e) { return null; } })();
                gzOk = !!(g && g.ok && g.b64);
                if (gzOk) rec = gzRecordText(text.length, g.b64);
            }
            const useGz = !!(rec && (text.length > budget || rec.length < text.length));
            const stored = useGz ? rec : text;
            if (budget > 0 && stored.length > budget) {
                // 装不下（压缩不可用 / 压完仍超预算）→ 如实跳过，并把「本机层自何时起未更新」记下来
                localStats.overBudget += 1;
                localStats.lastSkipReason = 'over-budget';
                if (gzTried && !gzOk) localStats.gzUnavailable += 1;
                localBuffer = {
                    at: Date.now(), ok: false, skipped: 'over-budget', gz: false, gzTried: gzTried,
                    chars: text.length, storedChars: stored.length, budget: budget,
                    reason: rec ? '压缩后仍超过本机缓冲预算' : (gzOk ? '明文超过预算' : (gzTried ? '压缩不可用' : '明文超过预算')),
                };
                try {
                    kernelWarn('保存：本机缓冲超预算 → 本次跳过（已尝试压缩留存；服务端文件与 IndexedDB 不受影响）',
                        { chars: text.length, budget: budget, gzTried: gzTried, gzOk: gzOk, gzStoredChars: rec.length, gzAvailable: gzipAvailable() });
                } catch (e) { /* 忽略 */ }
                try { debugLogPush('存储', { action: '本机缓冲超预算 → 跳过写入（压缩未能解决）', chars: text.length, budget: budget, gzTried: gzTried, gzStoredChars: rec.length, gzAvailable: gzipAvailable() }); } catch (e) { /* 忽略 */ }
                try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: false, miss: true, bytes: text.length, reason: 'over-budget', extra: { budget: budget, gzTried: gzTried, gzStoredChars: rec.length }, note: '超过字符预算且压缩未能解决 → 跳过（服务端文件与 IndexedDB 不受影响）' }); } catch (e) { /* 忽略 */ }
                localStaleMark(text.length, budget, 'over-budget');
                localSkipHintOnce(text.length, budget);
            } else if (storageHooks.setItem(key, stored)) {
                via.push(useGz ? 'localStorage-gz' : 'localStorage');
                if (useGz) localStats.gzipWrites += 1;
                markLocalWritten(sig, text.length);
                localBuffer = {
                    at: Date.now(), ok: true, skipped: '', gz: useGz, gzTried: gzTried,
                    chars: text.length, storedChars: stored.length, budget: budget, reason: '', layer: 'localStorage',
                };
                try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: true, bytes: stored.length, extra: { budget: budget, gz: useGz, plainChars: text.length, layer: 'localStorage' } }); } catch (e) { /* 忽略 */ }
                if (useGz) {
                    try { debugLogPush('存储', { action: '本机缓冲已压缩留存', plainChars: text.length, storedChars: stored.length, budget: budget }); } catch (e) { /* 忽略 */ }
                }
            } else {
                localStats.failed += 1;
                localStats.lastSkipReason = useGz ? 'gz-write-failed' : 'write-failed';
                localBuffer = {
                    at: Date.now(), ok: false, skipped: 'write-failed', gz: useGz, gzTried: gzTried,
                    chars: text.length, storedChars: stored.length, budget: budget,
                    reason: useGz ? '压缩记录被宿主拒绝写入（配额不足？）' : '宿主拒绝写入（常见原因：配额不足）',
                };
                try { kernelWarn('保存：本机缓冲写入被拒（配额不足？）→ 服务端文件与 IndexedDB 不受影响', { chars: text.length, storedChars: stored.length, gz: useGz }); } catch (e) { /* 忽略 */ }
                try { debugLogPush('存储', { action: '本机缓冲写入失败', chars: text.length, storedChars: stored.length, gz: useGz, budget: budget }); } catch (e) { /* 忽略 */ }
                try { readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: false, bytes: stored.length, reason: useGz ? 'gz-write-failed' : 'write-failed' }); } catch (e) { /* 忽略 */ }
                localStaleMark(text.length, budget, useGz ? 'gz-write-failed' : 'write-failed');
                localSkipHintOnce(text.length, budget);
            }
        }
    } catch (e) { /* 忽略 */ }
    // ⑤ IndexedDB 缓冲（可用时）—— **不做等值跳过**：它是异步写、不阻塞主线程，
    //   且与 localStorage 是两层独立真相（本层写失败后仍需能自愈），耦合跳过会留下「永远补不上」的缺口。
    //   v3.26.0（用户要求）：**本地目录模式下本层整体停用**（不写、不读）—— 本机只留「目录 + 服务端」两层。
    if (localViaFile) {
        localStats.idbSkipped += 1;
    } else {
        try {
            const lf = await localforageLib();
            if (lf && typeof lf.setItem === 'function') {
                await lf.setItem('ftt2_state_' + scopeId(), envelope);
                localStats.idbWrites += 1;
                via.push('indexedDB');
            }
        } catch (e) { /* 忽略 */ }
    }
    // ⑥ 服务端文件（大体积权威数据）—— v3.0.21：**先写变化过的分片**（每片单独成文件），再写主文件（提交点）。
    //   主文件写入滞后/失败时，分片仍持有最新内容 → 下次载入会把「比主文件新」的分片应用回来，不再回滚。
    if (o.skipFile !== true) {
        //   分片的时间戳 = **本次信封的时间戳**（同一批写入归属同一次），载入侧据此判断「谁更新」
        //   注：`force` **不**透传给分片 —— 分片靠**内容哈希**判断要不要重传，内容没变的片一个字节都不发
        //   （`force` 只用于「必须写主文件（提交点）」的语义：清空 / 导入 / 退出前落盘）。
        try {
            await writeStateShards(st, {
                force: o.shardsForce === true,      // v3.0.22：「对齐所有存储」时强制重传全部片（确保分片与内存完全一致）
                at: Number(envelope && envelope.payload && envelope.payload.updatedAt) || 0,
            });
        } catch (e) { /* 分片失败不影响主文件写入 */ }
    }
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
    if (via.indexOf('file') >= 0) {
        lastFullPushAt = lastSave.at;
        lastFullPushBytes = bytes;
        pushedSeq = touchSeq;
        // v3.0.21：记下本次成功写入的条目数 —— 下一次保存的「异常缩水」守卫以它为基线
        try { lastPushCounts = countsOf(st); } catch (e) { lastPushCounts = null; }
        // v3.0.18：记下**这次真正上传的内容**（信封哈希 + scope + 信封时间戳）——
        //   下次据此复现同一份载荷做比对（不用再多算一次哈希）
        try {
            lastPushSig = String((envelope && envelope.hash) || '');
            lastPushScope = String((envelope && envelope.payload && envelope.payload.scope) || '');
            lastPushEnvAt = Number((envelope && envelope.payload && envelope.payload.updatedAt) || 0);
        } catch (e) { lastPushSig = ''; }
    }
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
    const tok = readLedgerBegin('读本机缓冲', 'local', { target: 'ftt2_state_' + scopeId() });
    try {
        const key = 'ftt2_state_' + scopeId();
        // v3.10.4（A4）：**仍然每次都读原始文本**（真相优先：外部改动立刻可见），
        //   文本与上次逐字符相同 → 复用上次的解析结果（省掉 1MB 的 `JSON.parse` + 信封哈希）。
        const raw = storageHooks.getItem(key);
        localStats.reads += 1;
        if (!raw) { localParseCache = null; readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-local-buffer', note: '本机缓冲为空（首次使用或已清理）' }); return null; }
        // v3.26.2：压缩记录**需要异步解压** → 本同步路径如实让路（由载入侧的 `loadFromLocalStorageGz()` 接手），
        //   不把它误判成「信封损坏」而报假警。
        if (localRecordKind(raw) === 'gz') {
            localParseCache = null;
            readLedgerEnd(tok, { ok: true, miss: true, reason: 'gz-record', note: '本机缓冲是压缩记录 → 由异步路径解压读取' });
            return null;
        }
        const c = localParseCache;
        if (c && c.key === key && c.raw === raw) {
            localStats.parseHits += 1;
            readLedgerEnd(tok, { ok: true, bytes: String(raw).length, items: c.items, note: '命中解析缓存（文本未变 → 不重复解析信封）', extra: { parse: 'cached' } });
            return c.payload;
        }
        const pr = parseLocalEnvelopeText(raw);
        if (!pr.ok) {
            localParseCache = null;
            readLedgerEnd(tok, { ok: false, reason: pr.reason, bytes: String(raw).length, hash: pr.hash });
            if (pr.reason === 'bad-envelope') kernelWarn('载入：本机缓冲信封不完整 → 丢弃', '');
            else if (pr.reason === 'hash-mismatch') kernelWarn('载入：本机缓冲哈希不一致 → 丢弃', '');
            return null;
        }
        const st = pr.state;
        localParseCache = { key: key, raw: raw, payload: st, items: countsOf(st).total };
        readLedgerEnd(tok, { ok: true, bytes: String(raw).length, items: localParseCache.items, hash: pr.hash, note: '信封校验通过' });
        return st;
    } catch (e) {
        localParseCache = null;
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return null;
    }
}

/**
 * v3.26.2：**读压缩留存的本机缓冲**（异步；只在记录是压缩格式时才需要）。
 * 口径与明文路径**完全一致**（信封完整 + 载荷哈希），只是多一步 `gunzip`；
 * 任何失败都如实记账并返回 null（交由服务端文件 / IndexedDB 兜底）。
 * @returns {Promise<object|null>} state 或 null
 */
export async function loadFromLocalStorageGz() {
    const tok = readLedgerBegin('读本机缓冲（压缩）', 'local', { target: 'ftt2_state_' + scopeId() });
    try {
        const raw = storageHooks.getItem('ftt2_state_' + scopeId());
        if (!raw) { readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-local-buffer' }); return null; }
        if (localRecordKind(raw) !== 'gz') { readLedgerEnd(tok, { ok: true, miss: true, reason: 'not-gz' }); return loadFromLocalStorage(); }
        const rec = JSON.parse(String(raw));
        const plainChars = Number((rec && rec.chars) || 0);
        const u8 = base64ToBytes(String((rec && rec.b64) || ''));
        if (!u8 || !u8.length) { readLedgerEnd(tok, { ok: false, reason: 'gz-b64-broken', bytes: String(raw).length }); kernelWarn('载入：本机缓冲压缩记录无法解码 → 丢弃', ''); return null; }
        const text = await gunzipFromBytes(u8);
        if (text === null || text === undefined) { readLedgerEnd(tok, { ok: false, reason: 'gunzip-failed', bytes: String(raw).length }); kernelWarn('载入：本机缓冲解压失败 → 丢弃（服务端文件与内存库仍在）', ''); return null; }
        const pr = parseLocalEnvelopeText(text);
        if (!pr.ok) {
            readLedgerEnd(tok, { ok: false, reason: pr.reason, bytes: String(raw).length, hash: pr.hash });
            if (pr.reason === 'bad-envelope') kernelWarn('载入：本机缓冲（压缩）信封不完整 → 丢弃', '');
            else if (pr.reason === 'hash-mismatch') kernelWarn('载入：本机缓冲（压缩）哈希不一致 → 丢弃', '');
            return null;
        }
        localStats.gzipReads += 1;
        readLedgerEnd(tok, {
            ok: true, bytes: String(raw).length, items: countsOf(pr.state).total, hash: pr.hash,
            note: '压缩记录解压 + 信封校验通过',
            extra: { gz: true, plainChars: plainChars, storedChars: String(raw).length },
        });
        return pr.state;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return null;
    }
}

/** v3.16.0：本地文件模式「上次用过的路径」的内存副本（配置里清空路径后，仍要能按它迁回变量层） */
let lastPathMemory = '';

/** 本机缓冲层的模式信息（面板 / 调试包用；v3.16.0 本地文件模式，v3.26.0 目录模式停用变量层与内存库） */
export function localLayerInfo() {
    let file = null;
    try { file = localFileStatsGet(); } catch (e) { file = null; }
    const key = 'ftt2_state_' + scopeId();
    let localChars = 0;
    let gz = false;
    let plainChars = 0;
    try {
        const raw = storageHooks.getItem(key);
        localChars = String(raw == null ? '' : raw).length;
        gz = localRecordKind(raw) === 'gz';
        if (gz) { try { plainChars = Number((JSON.parse(String(raw)) || {}).chars) || 0; } catch (e) { plainChars = 0; } }
        else plainChars = localChars;
    } catch (e) { localChars = 0; }
    const on = !!(file && file.enabled);
    const stale = (() => { try { return localStaleInfo(); } catch (e) { return null; } })();
    // v3.26.5（真机取证「保存到本地文件后，是否没有正常读取和写入？」）：目录模式下界面必须能**逐项核对**
    //   目录层到底写没写、读没读 —— 这里把「真实键名 / 两种通道路径 / 读回时间 / 失败原因」一并交出去。
    const real = (() => { try { return localFileRealLocation(String((file && file.path) || ''), scopeId()); } catch (e) { return null; } })();
    return {
        enabled: on, path: String((file && file.path) || ''), name: String((file && file.name) || ''),
        backend: String((file && file.backend) || ''), fileBytes: Number((file && file.lastBytes) || 0),
        writes: Number((file && file.writes) || 0), reads: Number((file && file.reads) || 0),
        failures: Number((file && file.failures) || 0), lastReason: String((file && file.lastReason) || ''),
        misses: Number((file && file.misses) || 0),
        fileLastAt: Number((file && file.lastAt) || 0),
        fileLastReadAt: Number((file && file.lastReadAt) || 0),
        fileLastWriteAt: Number((file && file.lastWriteAt) || 0),
        channel: String((file && file.lastChannel) || ''),
        fileKey: String((real && real.key) || '') || (() => { try { return localFileFileKey(scopeId()); } catch (e) { return ''; } })(),
        realFiles: (real && Array.isArray(real.files)) ? real.files : [],
        localChars: localChars, budget: localBufferMaxChars > 0 ? localBufferMaxChars : LOCAL_BUFFER_MAX_CHARS,
        // v3.26.2：压缩留存现状（`gz` = 本机记录是压缩记录；`plainChars` = 原始字符数；`stale` = 本机层停滞标记）
        gz: gz, plainChars: plainChars,
        overBudget: String(localBuffer.skipped || '') === 'over-budget',
        stale: stale,
        gzipAvailable: (() => { try { return gzipAvailable(); } catch (e) { return false; } })(),
        // v3.26.0：目录模式下**内存库与变量层都已停用**（读与写都不再经过这两层）
        // v3.26.5：**聊天元数据层同样停用**（目录模式只读「目录文件 + 服务端文件」）
        memLayersDisabled: on,
        idbWrites: Number(localStats.idbWrites || 0), idbSkipped: Number(localStats.idbSkipped || 0),
        probes: Number((file && file.probes) || 0),
        dirs: (() => { try { return localFileDirHistory(); } catch (e) { return []; } })(),
        last: Object.assign({}, localBuffer),
    };
}

/**
 * v3.16.0（用户要求「开启后将取代变量方式」）——**按当前路径约定切换本机层**：
 * v3.26.0（用户要求「设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储」）
 *   —— 本函数随之升级为**三层对齐**：
 *   · 路径非空（开启）：把**变量层**与**内存库（IndexedDB）**里更新的那份信封迁到本地文件
 *     （写 → 回读逐字节校验 → 才清源），迁移成功后**两层都不再被写入**（保存流水线④走文件、⑤整体跳过）。
 *   · 路径为空（关闭）：若两层都空而文件有内容 → **迁回**两层（变量层 + 内存库；文件保留当备份，不删）。
 * 全程**先写后清**：任何一步失败都不清数据；返回结构化结果供面板如实展示。
 * @returns {Promise<{ok:boolean, action:'migrated'|'restored'|'none'|'error', bytes:number, cleared:number, from:string, reason:string}>}
 */
export async function switchLocalLayer(opts) {
    const o = opts || {};
    const key = 'ftt2_state_' + scopeId();
    // v3.16.0：记住「上次用过的路径」—— 关闭模式后配置里已没有路径，仍要能按它把文件内容迁回变量层。
    //   来源优先级：调用方给的 `previousPath`（设定页改路径时天然知道旧值）→ 本次会话内存
    //   → v3.16.0~v3.25.x 写下的旧标记（**只读兼容，新版本不再写它**）→ 用过的目录清单
    const LAST_KEY = 'ftt2_LastLocalFilePath';
    const lastPath = (() => {
        if (o.previousPath) return String(o.previousPath);
        if (lastPathMemory) return String(lastPathMemory);
        try {
            const old = String(storageHooks.getItem(LAST_KEY) || '');
            if (old) return old;
        } catch (e) { /* 忽略 */ }
        try { return String(localFileDirHistory()[0] || ''); } catch (e) { return ''; }
    })();
    let raw = '';
    try { raw = String(storageHooks.getItem(key) || ''); } catch (e) { raw = ''; }
    try {
        if (localFileEnabled()) {
            // v3.26.0：内存库（IndexedDB）也是要停用的一层 → 迁移时**两层一起看**，取更新的一份为源
            // v3.26.5（用户要求「仅采用本地文件存储」）：候选源扩到四类 —— 变量层 / 内存库 / **目录文件本身** /
            //   **聊天元数据**；另把**上一次用过的目录**（`previousPath`，换目录时）也算进来。
            //   并且：**目录文件已是最新时绝不覆盖**（旧实现在这里会把变量层的旧内容写回目录 → 数据回退）。
            const idbText = await idbEnvelopeText();
            const curPath = localFilePath();
            const prevPath = String(o.previousPath || '');
            const prevNorm = localFilePathSanitize(prevPath);
            const fileNow = await (async () => { try { return await localFileRead(scopeId()); } catch (e) { return null; } })();
            // 换目录时（previousPath 与当前不同）额外读**旧目录**：它往往才是最新的那份
            const filePrev = (prevNorm && prevNorm !== curPath)
                ? await (async () => { try { return await localFileRead(scopeId(), prevPath); } catch (e) { return null; } })()
                : null;
            // v3.26.5 注意：`chatMetaLoadState()` 返回的是**读取记录**（`{ok,present,...,state}`），
            //   信封必须用 `rec.state` 组装 —— 直接传记录会让 `storageEnvelope` 拿不到 `updatedAt`
            //   （回落成「此刻」）→ 聊天元数据会假装永远最新，把真正的候选源全压掉。
            const metaRec = (() => { try { return chatMetaLoadState(); } catch (e) { return null; } })();
            const metaState = (metaRec && metaRec.state && typeof metaRec.state === 'object') ? metaRec.state : null;
            const metaText = (() => { try { return metaState ? JSON.stringify(storageEnvelope(metaState)) : ''; } catch (e) { return ''; } })();
            const candFile = (fileNow && fileNow.ok && fileNow.text) ? String(fileNow.text)
                : ((filePrev && filePrev.ok && filePrev.text) ? String(filePrev.text) : '');
            const src = pickLocalSource(raw, idbText, candFile, metaText);
            localFileDirRemember(localFilePath());
            // ① 目录副本已是最新（含跨目录迁移时「旧目录更新」的情形）→ 只做**读回校验**，不写、不清
            if (src.from === 'file') {
                const fromPrev = !(fileNow && fileNow.ok && fileNow.text) && !!(filePrev && filePrev.ok && filePrev.text);
                if (fromPrev) {
                    // 旧目录更新 → 把它迁进新目录（写 → 回读逐字节校验 → 才认）
                    const wr2 = await localFileWrite(src.text, scopeId());
                    const rr2 = wr2 && wr2.ok ? await localFileRead(scopeId()) : null;
                    if (!wr2 || !wr2.ok || !rr2 || !rr2.ok || String(rr2.text) !== src.text) {
                        return { ok: false, action: 'error', bytes: 0, cleared: 0, from: 'file', reason: '旧目录内容迁入新目录失败（写或回读校验不一致）→ 旧目录文件保留可用', previousPath: prevNorm };
                    }
                    markLocalWritten('', 0);
                    lastPathMemory = localFilePath();
                    try { debugLogPush('存储', { action: '换目录：旧目录内容已迁入新目录', from: prevNorm, to: localFilePath(), bytes: src.text.length }); } catch (e) { /* 忽略 */ }
                    return { ok: true, action: 'moved-dir', bytes: src.text.length, cleared: 0, from: 'file', reason: '已把旧目录（' + prevNorm + '）里更新的一份迁进新目录（' + localFilePath() + '，写 → 回读校验通过）', previousPath: prevNorm };
                }
                markLocalWritten('', 0);
                lastPathMemory = localFilePath();
                try { debugLogPush('存储', { action: '目录副本已是最新 → 未覆盖（变量层 / 内存库 / 聊天元数据保持停用）', path: localFilePath(), bytes: src.text.length }); } catch (e) { /* 忽略 */ }
                return { ok: true, action: 'verified', bytes: src.text.length, cleared: 0, idbCleared: false, from: 'file', reason: '目录副本已是最新（' + src.text.length + ' 字符，读回校验通过）→ 未覆盖任何层；变量层 / 内存库 / 聊天元数据保持停用' };
            }
            if (!src.text) {
                lastPathMemory = localFilePath();
                return { ok: true, action: 'none', bytes: 0, cleared: 0, from: '', reason: '目录、变量层、内存库与聊天元数据都为空（无需迁移）' };
            }
            const wr = await localFileWrite(src.text, scopeId());
            if (!wr || !wr.ok) return { ok: false, action: 'error', bytes: 0, cleared: 0, from: src.from, reason: '写入本地目录失败：' + String((wr && wr.error) || '') };
            const rr = await localFileRead(scopeId());
            if (!rr || !rr.ok || String(rr.text) !== src.text) {
                return { ok: false, action: 'error', bytes: 0, cleared: 0, from: src.from, reason: '回读校验不一致 → 变量层与内存库保持不动（不丢数据）' };
            }
            // 校验通过 → 清**两层**（变量键 + 内存库副本）+ 重置写入签名（下一次保存一定写文件）
            let cleared = 0;
            try { cleared = removeLocalKeys([key]).removed || 0; } catch (e) { cleared = 0; }
            const idbCleared = await idbRemoveCopy();
            markLocalWritten('', 0);
            localFileDirRemember(localFilePath());
            lastPathMemory = localFilePath();
            try { debugLogPush('存储', { action: '本地目录模式：变量层与内存库已迁移并停用', path: String(localFileStatsGet().path || ''), bytes: src.text.length, cleared: cleared, idbCleared: idbCleared, from: src.from }); } catch (e) { /* 忽略 */ }
            const fromLabel = { idb: '内存库', variable: '变量层', chatmeta: '聊天元数据', file: '目录文件' }[src.from] || src.from;
            return { ok: true, action: 'migrated', bytes: src.text.length, cleared: cleared, idbCleared: idbCleared, from: src.from, reason: '已迁移 ' + src.text.length + ' 字符到本地目录（来源：' + fromLabel + '），并清空变量层（' + cleared + ' 个键）' + (idbCleared ? '与内存库副本' : '') };
        }
        // 关闭模式：两层都空而文件有内容 → 按**上次路径**迁回（保住本机层，不让用户一关就少一层）
        const usePath = lastPath || '';
        const idbHas = !!(await idbEnvelopeText());
        if (!raw && !idbHas && usePath) {
            const fr = await localFileRead(scopeId(), usePath);
            if (fr && fr.ok && fr.text) {
                const text = String(fr.text);
                const okL = storageHooks.setItem(key, text);
                const idbBack = await idbWriteEnvelope(text);
                if (okL || idbBack) {
                    markLocalWritten('', 0);
                    try { debugLogPush('存储', { action: '本地目录模式：已关闭 → 内容迁回变量层与内存库', path: usePath, bytes: text.length, variable: !!okL, idb: idbBack }); } catch (e) { /* 忽略 */ }
                    return { ok: true, action: 'restored', bytes: text.length, cleared: 0, from: 'file', reason: '已从本地目录（' + usePath + '）迁回本机层（变量层' + (okL ? '✓' : '✗') + ' / 内存库' + (idbBack ? '✓' : '✗') + '，' + text.length + ' 字符）' };
                }
                return { ok: false, action: 'error', bytes: 0, cleared: 0, from: 'file', reason: '迁回本机层失败（配额不足？）→ 本地目录文件保留可用' };
            }
        }
        return { ok: true, action: 'none', bytes: 0, cleared: 0, from: '', reason: '本地目录模式未开启' };
    } catch (e) {
        return { ok: false, action: 'error', bytes: 0, cleared: 0, from: '', reason: String((e && e.message) || e) };
    }
}

/**
 * v3.26.0：在「变量层信封文本」与「内存库信封文本」之间挑**更新**的一份作为迁移源（纯函数，便于单测）。
 * 判据 = 信封 `payload.updatedAt`；无法解析的一份**不参与**比较（绝不用坏数据覆盖好数据）。
 * v3.26.5（用户要求「设置了目录则内存 / 变量 / 传统本地存储全部作废，仅用本地文件」）：候选扩到**四类** ——
 *   变量层 / 内存库 / **当前目录文件** / **聊天元数据**（只读旧载体）。多给的参数按位置可选，旧调用（两个参数）
 *   行为逐字不变（并列时仍取变量层）。
 * @param {string} varText 变量层信封文本
 * @param {string} idbText 内存库信封文本
 * @param {string} [fileText] 目录文件信封文本
 * @param {string} [metaText] 聊天元数据（由 state 现组装的信封文本）
 * @returns {{text:string, from:'variable'|'idb'|'file'|'chatmeta'|'', at:number}}
 */
export function pickLocalSource(varText, idbText, fileText, metaText) {
    const atOf = (t) => {
        if (!t) return -1;
        try {
            const env = JSON.parse(String(t));
            if (!env || !env.payload) return -1;
            return Number((env.payload && env.payload.updatedAt) || 0);
        } catch (e) { return -1; }
    };
    const cands = [
        { from: 'variable', text: varText },
        { from: 'idb', text: idbText },
        { from: 'file', text: fileText },
        { from: 'chatmeta', text: metaText },
    ].map((x) => ({ from: x.from, text: x.text ? String(x.text) : '', at: atOf(x.text) }))
        .filter((x) => x.at >= 0);
    if (!cands.length) return { text: '', from: '', at: -1 };
    // 稳定排序（`Array.sort` 稳定）→ 并列时保持 [变量层, 内存库, 目录, 聊天元数据] 的顺序（旧行为：并列取变量层）
    cands.sort((a, b) => b.at - a.at);
    return { text: cands[0].text, from: cands[0].from, at: cands[0].at };
}

/**
 * v3.26.5（真机取证「保存到本地文件后，是否没有正常读取和写入？」）——
 * **本机层「载入视角」的只读事实探针**（诊断用）：目录模式**真的去读目录文件**并如实回报
 * 「命中/未命中 / 字节 / 信封哈希是否一致 / 条数 / 时间戳」；普通模式读变量层（localStorage）。
 * 只读：不写、不清、不改任何层（`localFileRead` 会进读取台账，便于与真实载入对照）。
 * @returns {Promise<{mode:string,key:string,present:boolean,bytes?:number,hashOk?:boolean,items?:number,at?:number,path?:string,fileKey?:string,real?:Array<object>,miss?:boolean,error?:string,gz?:boolean}>}
 */
export async function localLayerReadProbe() {
    const key = 'ftt2_state_' + scopeId();
    try {
        if (localFileEnabled()) {
            const out = { mode: 'local-file', key: key, present: false, path: localFilePath(), name: localFileName(scopeId()), fileKey: localFileFileKey(scopeId()), backend: (() => { try { return localFileStatsGet().backend; } catch (e) { return ''; } })() };
            try { out.real = localFileRealLocation(out.path, scopeId()).files; } catch (e) { out.real = []; }
            const r = await localFileRead(scopeId());
            if (r && r.ok && r.text) {
                const raw = String(r.text);
                out.present = true;
                out.bytes = raw.length;
                out.channel = String(r.channel || '');
                out.backend = String(r.backend || out.backend || '');
                try {
                    const env = JSON.parse(raw);
                    out.hashOk = !env.hash || env.hash === storageHash(env.payload);
                    out.at = Number((env.payload && env.payload.updatedAt) || 0);
                    out.items = countsOf(env.payload && env.payload.data).total;
                } catch (e) { out.hashOk = false; }
            } else { out.miss = true; out.error = String((r && r.error) || 'miss'); }
            return out;
        }
        const out = { mode: 'localStorage', key: key, present: false };
        const raw = storageHooks.getItem(key);
        out.present = !!raw;
        if (raw) { out.bytes = String(raw).length; out.gz = localRecordKind(raw) === 'gz'; }
        return out;
    } catch (e) { return { mode: 'error', key: key, present: false, error: String((e && e.message) || e) }; }
}

/**
 * v3.16.0（用户要求「本地文件存储模式替代变量存储」）——**读本地文件层的状态**（异步）。
 *
 * 为什么单独一个函数：`loadFromLocalStorage()` 是**同步**的（载入流水线按同步调用它，微任务时序被既有测试锁定），
 *   而本地文件读是异步的 → 载入侧只在**路径非空**时多一次 `await`（关闭时零额外微任务、零行为变化）。
 * 校验口径与变量层**完全一致**：信封完整 + 载荷哈希一致，否则丢弃（交由宿主文件兜底）。
 * @returns {Promise<object|null>} state 或 null
 */
export async function loadFromLocalFile() {
    const key = 'ftt2_state_' + scopeId();
    const tok = readLedgerBegin('读本机缓冲（本地文件）', 'local', { target: localFileName(scopeId()), note: '本地文件模式（v3.16.0）' });
    try {
        const r = await localFileRead(scopeId());
        if (!r || !r.ok || !r.text) {
            readLedgerEnd(tok, { ok: true, miss: true, reason: String((r && r.error) || 'no-local-file'), note: '本地文件未命中 → 回落变量层' });
            return null;
        }
        const raw = String(r.text);
        localStats.reads += 1;
        const env = JSON.parse(raw);
        if (!env || !env.payload) { localParseCache = null; readLedgerEnd(tok, { ok: false, reason: 'bad-envelope', bytes: raw.length }); kernelWarn('载入：本地文件信封不完整 → 丢弃', ''); return null; }
        const h = storageHash(env.payload);
        if (env.hash && env.hash !== h) {
            localParseCache = null;
            readLedgerEnd(tok, { ok: false, reason: 'hash-mismatch', bytes: raw.length, hash: h, note: '本地文件信封哈希不一致 → 丢弃' });
            kernelWarn('载入：本地文件信封哈希不一致 → 丢弃', '');
            return null;
        }
        const st = env.payload.data || null;
        localParseCache = { key: 'file:' + key, raw: raw, payload: st, items: countsOf(st).total };
        readLedgerEnd(tok, { ok: true, bytes: raw.length, items: localParseCache.items, hash: h, note: '本地文件信封校验通过', extra: { layer: 'local-file', path: String(localFileStatsGet().path || '') } });
        return st;
    } catch (e) {
        localParseCache = null;
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return null;
    }
}

/**
 * v3.0.23（用户报告「初次激活插件读取的数据还是**没有对齐**」）——**本机内存库（IndexedDB）读取**。
 *
 * 这是个**真实的读写不对称 bug**：保存流水线从 v2.x 起就写 IndexedDB（`localforage.setItem`，第 ⑤ 步），
 *   但**载入路径从来没有读过它** —— 本机有两层缓冲（localStorage / IndexedDB），却只读了一层。
 *   于是「浏览器本地变量被清掉（清缓存 / 隐私模式 / 换了存储分区）而 IndexedDB 还在」时，
 *   数据看起来整个丢了，正是用户说的「初次激活读取的数据没有对齐」。
 * 口径与 `loadFromLocalStorage` **完全一致**（同一信封、同一哈希校验、损坏即丢弃），只是换了一层存储。
 * @returns {Promise<object|null>} state 或 null
 */
export async function loadFromIndexedDB() {
    const tok = readLedgerBegin('读本机内存库', 'idb', { target: 'ftt2_state_' + scopeId() });
    try {
        const lf = await localforageLib();
        if (!lf || typeof lf.getItem !== 'function') { readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-indexeddb', note: '宿主未提供 localforage → 本层不可用' }); return null; }
        const env = await lf.getItem('ftt2_state_' + scopeId());
        if (!env) { readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-idb-buffer' }); return null; }
        let bytes = 0;
        try { bytes = JSON.stringify(env).length; } catch (e) { bytes = 0; }
        if (!env.payload) { readLedgerEnd(tok, { ok: false, reason: 'bad-envelope', bytes: bytes }); return null; }
        const h = storageHash(env.payload);
        if (env.hash && env.hash !== h) {
            readLedgerEnd(tok, { ok: false, reason: 'hash-mismatch', bytes: bytes, hash: h });
            kernelWarn('载入：本机内存库哈希不一致 → 丢弃', '');
            return null;
        }
        const st = env.payload.data || null;
        readLedgerEnd(tok, { ok: true, bytes: bytes, items: countsOf(st).total, hash: h, note: '信封校验通过' });
        return st;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return null;
    }
}

/**
 * v3.0.23：**主文件不可用时的分片重建**（用户报告「初次激活读取的数据还是没有对齐」的第二个成因）。
 *
 * v3.0.21 把「按维度分片」定为**实时通道**、主文件只是**提交点** —— 但只要主文件缺失 / 损坏 /
 *   哈希不过，旧实现就 `return null`（**在 `applyNewerShards` 之前**），于是**恰恰在分片存在的场合**
 *   一片都不读：分片白写了，用户看到「数据没了」。
 * 现在：主文件拿不到就以 `mainAt = 0` 应用全部分片（每片仍逐片校验内容哈希），能拼出多少算多少；
 *   一片都没有才算未命中。纯附加：主文件正常时本函数根本不会被调用。
 * @param {string} reason 主文件为何不可用（写进台账与日志）
 * @returns {Promise<{st:object|null, applied:string[], at:number}>}
 */
async function loadStateFromShards(reason) {
    const out = { st: null, applied: [], at: 0 };
    const tok = readLedgerBegin('读分片重建状态', 'shard', { target: shardManifestName(scopeId()), note: String(reason || '') });
    try {
        const st = emptyState();
        const ap = await applyNewerShards(st, 0, { slug: scopeId() });
        out.applied = (ap && ap.applied) || [];
        out.at = Number((ap && ap.at) || 0);
        if (!out.applied.length) { readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-shards', note: '主文件不可用且没有可用分片' }); return out; }
        out.st = st;
        readLedgerEnd(tok, {
            ok: true, items: countsOf(st).total,
            extra: { applied: out.applied, at: out.at },
            note: '主文件不可用 → 由 ' + out.applied.length + ' 个分片重建（' + out.applied.join(',') + '）',
        });
        return out;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return out;
    }
}

/** 最近一次服务端载入的结论（诊断 / 台账；`via` = file | shards | none） */
let lastServerLoad = { at: 0, via: 'none', ok: false, bytes: 0, mainAt: 0, applied: [], reason: '', reasonText: '' };
export function lastServerLoadInfo() { return Object.assign({}, lastServerLoad, { applied: (lastServerLoad.applied || []).slice() }); }

/** 服务端文件载入（返回 state 或 null） */
export async function loadFromServerFile() {
    // B9-d：`stateFileGzip` 关闭（默认）时**仅读规范明文名** —— 与 B7-2 的请求序列/时序逐字节一致（零额外请求）；
    //   开启时先试 `.json.gz` 再回退明文（V1 的候选顺序）。读取按**内容魔数**解压（`readStateFileAuto`）。
    let r = await fileTransportReadAuto(stateFileName(scopeId()), { src: 'file', role: '主文件' });
    if ((!r || !r.ok) && stateFileGzipOn()) r = await fileTransportReadAuto(stateFileGzName(), { src: 'file', role: '主文件(gz)' });
    if (!r || !r.ok) {
        // v3.0.23：**主文件缺失 → 仍有分片可用**（见 `loadStateFromShards`）
        const sr = await loadStateFromShards('main-file-missing');
        lastServerLoad = { at: Date.now(), via: sr.st ? 'shards' : 'none', ok: !!sr.st, bytes: 0, mainAt: 0, applied: sr.applied, reason: String((r && r.error) || 'miss'), reasonText: sr.st ? '主文件不可用 → 分片重建' : '主文件与分片都不可用' };
        try { debugLogPush('对账', { action: '载入：主文件不可用' + (sr.st ? ('，已用 ' + sr.applied.length + ' 个分片重建') : '，分片也没有'), reason: lastServerLoad.reason, applied: sr.applied }); } catch (e) { /* 忽略 */ }
        return sr.st;
    }
    const tok = readLedgerBegin('解析主文件', 'file', { target: stateFileName(scopeId()) });
    try {
        const env = JSON.parse(r.text);
        if (env && env.payload) {
            const h = storageHash(env.payload);
            if (env.hash && env.hash !== h) {
                readLedgerEnd(tok, { ok: false, reason: 'hash-mismatch', bytes: String(r.text).length, hash: h, note: '主文件信封哈希不一致 → 改用分片' });
                const sr = await loadStateFromShards('main-file-hash-mismatch');
                lastServerLoad = { at: Date.now(), via: sr.st ? 'shards' : 'none', ok: !!sr.st, bytes: String(r.text).length, mainAt: 0, applied: sr.applied, reason: 'hash-mismatch', reasonText: sr.st ? '主文件哈希不一致 → 分片重建' : '主文件哈希不一致且无可用分片' };
                try { kernelWarn('载入：服务端主文件哈希不一致 → 已丢弃，改用分片', ''); } catch (e) { /* 忽略 */ }
                return sr.st;
            }
            // B9-d：瘦身还原（写盘前剥掉的同义字段/空值由核心兜底；此处补回显示层字段）
            try { hydrateStorageData(env.payload.data); } catch (e) { /* 忽略 */ }
            const st = env.payload.data || null;
            const mainAt = Number(env.payload.updatedAt) || 0;
            let applied = [];
            // v3.0.21（用户要求「一劳永逸」修「退出应用后大量回滚」）：
            //   主文件是**提交点**，但它可能**滞后于分片**（写入超时 / 进程被杀 / 切后台）——
            //   载入时把「比主文件更新」的分片应用回来（每片带内容哈希校验），于是那些改动不再丢。
            if (st) {
                try {
                    const ap = await applyNewerShards(st, mainAt);
                    applied = (ap && ap.applied) || [];
                    if (applied.length) {
                        readLedgerRecord({
                            action: '应用更新的分片', src: 'shard', target: shardManifestName(scopeId()),
                            ok: true, items: countsOf(st).total, ms: 0,
                            extra: { applied: applied, mainAt: mainAt },
                            note: '主文件滞后 → 用 ' + applied.length + ' 个更新的分片覆盖对应维度',
                        });
                        try { debugLogPush('对账', { action: '载入：应用更新的分片（主文件滞后）', dims: applied, shardAt: ap.at, mainAt: mainAt }); } catch (e) { /* 忽略 */ }
                    }
                } catch (e) { /* 分片不可用不影响主文件载入 */ }
                // 载入来源即「异常缩水」守卫的基线：避免把「本来就只有这么多条」误判成缩水
                try { primeShrinkBaseline(st); } catch (e) { /* 忽略 */ }
            }
            readLedgerEnd(tok, {
                ok: !!st, bytes: String(r.text).length, items: countsOf(st).total, hash: h,
                miss: !st,
                extra: { applied: applied, mainAt: mainAt, backend: String((r && r.backend) || '') },
                note: '信封校验通过（主文件时间 ' + mainAt + '）',
            });
            if (!st) {
                // 信封在、数据体不在（异常写入）→ 仍按「分片可用就重建」处理，不把用户的数据判成没有
                const sr = await loadStateFromShards('main-file-empty-data');
                lastServerLoad = { at: Date.now(), via: sr.st ? 'shards' : 'none', ok: !!sr.st, bytes: String(r.text).length, mainAt: mainAt, applied: sr.applied, reason: 'empty-data', reasonText: sr.st ? '主文件无数据体 → 分片重建' : '主文件无数据体且无分片' };
                return sr.st;
            }
            lastServerLoad = { at: Date.now(), via: 'file', ok: true, bytes: String(r.text).length, mainAt: mainAt, applied: applied, reason: '', reasonText: '主文件正常' };
            return st;
        }
        readLedgerEnd(tok, { ok: false, reason: 'no-payload', bytes: String(r.text).length, note: '信封缺 payload → 改用分片' });
        const sr = await loadStateFromShards('main-file-no-payload');
        lastServerLoad = { at: Date.now(), via: sr.st ? 'shards' : 'none', ok: !!sr.st, bytes: String(r.text).length, mainAt: 0, applied: sr.applied, reason: 'no-payload', reasonText: sr.st ? '主文件无 payload → 分片重建' : '主文件无 payload 且无分片' };
        return sr.st;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e), bytes: String((r && r.text) || '').length, note: '主文件解析失败 → 改用分片' });
        const sr = await loadStateFromShards('main-file-parse-error');
        lastServerLoad = { at: Date.now(), via: sr.st ? 'shards' : 'none', ok: !!sr.st, bytes: 0, mainAt: 0, applied: sr.applied, reason: String((e && e.message) || e), reasonText: sr.st ? '主文件解析失败 → 分片重建' : '主文件解析失败且无分片' };
        return sr.st;
    }
}

/**
 * v3.3.0（用户要求）：「设定-数据管理-本地缓冲，请补充其他为本地缓冲的内容……其他缓冲也应该展示，
 *   同样有对应清理按钮功能。」
 *
 * 本段是**本机（浏览器）缓冲的清点与清理单一来源** —— 数据管理页「本地缓冲」分节的每一行数字都来自这里，
 *   每个分组都有对应清理入口。分组口径（键前缀 → 归属模块）：
 *
 * | 分组 | 键前缀 | 归属 |
 * | --- | --- | --- |
 * | `state` | `ftt2_state_<scope>` | 本模块（状态信封；每角色一份） |
 * | `names` | `ftt2_FileSlug_` · `ftt2_ArchiveName_` | `adapters/sync.js`（文件名/归档名解析缓存） |
 * | `syncMarks` | `ftt2_RemoteStateHash_` · `ftt2_RemoteSnapSig_` · `ftt2_LastPushSig_` · `ftt2_SyncGate_` | `adapters/sync.js`（对账门控标记） |
 * | `syncLog` | `ftt2_SyncLog_` | `adapters/sync.js`（同步日志，上限 30 条） |
 * | `v1Legacy` | `SPreset_FTTMemory_char:` / `_FileSlug_` / `_FileNames_` / `_ArchiveName_` / `Config` | V1 遗留（`adapters/import-v1.js` 读；导入源，清理后无法再迁移） |
 * | `debug` / `trace` / `about` | `SPreset_FTTMemoryDebug` · `SPreset_FTTMemoryTrace` · `fttAboutJson` | 调试日志 / 追踪简报 / 版本清单缓存 |
 *
 * 注：向量缓存在 IndexedDB（`FTTMemoryVectorCache`），由 `adapters/vector-cache.js` 自己统计与清空。
 */
export const LOCAL_KEY_GROUPS = Object.freeze({
    state: ['ftt2_state_'],
    names: ['ftt2_FileSlug_', 'ftt2_ArchiveName_'],
    syncMarks: ['ftt2_RemoteStateHash_', 'ftt2_RemoteSnapSig_', 'ftt2_LastPushSig_', 'ftt2_SyncGate_'],
    syncLog: ['ftt2_SyncLog_'],
    v1Legacy: ['SPreset_FTTMemory_char:', 'SPreset_FTTMemory_FileSlug_', 'SPreset_FTTMemory_FileNames_', 'SPreset_FTTMemory_ArchiveName_', 'SPreset_FTTMemoryConfig'],
    debug: ['SPreset_FTTMemoryDebug'],
    trace: ['SPreset_FTTMemoryTrace'],
    about: ['fttAboutJson'],
});

/** UTF-8 字节数（无 TextEncoder 时退化为字符数；与数据管理页口径一致） */
export function localByteLen(v) {
    const s = String(v == null ? '' : v);
    try { if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length; } catch (e) { /* 退化 */ }
    return s.length;
}

/** 本机键清点：按分组给出 `{keys:[{key, chars, bytes}], count, bytes, chars}`（**只读**，不写任何东西） */
export function localKeyStats() {
    const out = {};
    for (const g of Object.keys(LOCAL_KEY_GROUPS)) out[g] = { keys: [], count: 0, bytes: 0, chars: 0 };
    try {
        const all = (typeof storageHooks.keys === 'function') ? (storageHooks.keys() || []) : [];
        const scope = scopeId();
        for (const key of all) {
            const k = String(key);
            for (const g of Object.keys(LOCAL_KEY_GROUPS)) {
                if (!LOCAL_KEY_GROUPS[g].some((p) => k.indexOf(p) === 0)) continue;
                const raw = (() => { try { return storageHooks.getItem(k); } catch (e) { return null; } })();
                const chars = String(raw == null ? '' : raw).length;
                const bytes = localByteLen(raw);
                const rec = { key: k, chars: chars, bytes: bytes, current: (g === 'state' && k === 'ftt2_state_' + scope) };
                out[g].keys.push(rec);
                out[g].count += 1;
                out[g].bytes += bytes;
                out[g].chars += chars;
                break;                              // 一个键只归一个分组（前缀表按优先级排列）
            }
        }
        // `state` 分组：把「当前作用域」与「其它作用域」分开（UI 需要分别展示与清理）
        const cur = out.state.keys.filter((x) => x.current);
        const other = out.state.keys.filter((x) => !x.current);
        out.state.current = { keys: cur, count: cur.length, bytes: cur.reduce((n, x) => n + x.bytes, 0), chars: cur.reduce((n, x) => n + x.chars, 0) };
        out.state.others = { keys: other, count: other.length, bytes: other.reduce((n, x) => n + x.bytes, 0), chars: other.reduce((n, x) => n + x.chars, 0) };
    } catch (e) { /* 清点失败 → 保持零值 */ }
    return out;
}

/** 删除若干本机键（返回 `{removed, failed}`；失败不抛） */
export function removeLocalKeys(keys) {
    const list = (Array.isArray(keys) ? keys : []).map((k) => String(k)).filter(Boolean);
    let removed = 0; const failed = [];
    // v3.10.4：删过本机键 → **读取缓存必须失效**（否则「刚清空却仍能读回旧信封」）
    if (list.length) invalidateLocalBufferCache();
    for (const k of list) {
        const ok = (() => { try { return storageHooks.removeItem(k) !== false; } catch (e) { return false; } })();
        if (ok) removed += 1; else failed.push(k);
    }
    return { removed: removed, failed: failed };
}

/** IndexedDB（localforage，本机内存库）里的状态副本清点 */
export async function idbCopyStats() {
    const out = { available: false, count: 0, bytes: 0, keys: [], current: false };
    try {
        const lf = await localforageLib();
        if (!lf || typeof lf.getItem !== 'function') return out;
        out.available = true;
        const keys = (typeof lf.keys === 'function') ? (await lf.keys() || []) : [];
        for (const k of keys) {
            const key = String(k);
            if (key.indexOf('ftt2_state_') !== 0) continue;
            const v = await lf.getItem(key);
            let bytes = 0;
            try { bytes = JSON.stringify(v == null ? null : v).length; } catch (e) { bytes = 0; }
            out.keys.push({ key: key, bytes: bytes, current: key === 'ftt2_state_' + scopeId() });
            out.count += 1;
            out.bytes += bytes;
        }
        out.current = out.keys.some((x) => x.current);
        return out;
    } catch (e) { return out; }
}

/** 当前作用域的本机副本清点（localStorage 信封 / 压缩记录 + IndexedDB 副本） */
export async function localCopyStats() {
    const ks = localKeyStats();
    const cur = ks.state.current;
    const idb = await idbCopyStats();
    let envelopeAt = 0, items = 0, gz = false;
    try {
        const raw = storageHooks.getItem('ftt2_state_' + scopeId());
        if (raw) {
            gz = localRecordKind(raw) === 'gz';
            // v3.26.2：压缩记录要**解压后**才算得出信封时间与条数（否则面板会显示 0）
            const text = gz ? await (async () => {
                try {
                    const rec = JSON.parse(String(raw));
                    const u8 = base64ToBytes(String((rec && rec.b64) || ''));
                    if (!u8 || !u8.length) return '';
                    return String(await gunzipFromBytes(u8) || '');
                } catch (e) { return ''; }
            })() : raw;
            if (text) {
                const env = JSON.parse(text);
                envelopeAt = Number((env && env.payload && env.payload.updatedAt) || 0);
                items = countsOf((env && env.payload && env.payload.data) || null).total;
            }
        }
    } catch (e) { /* 忽略 */ }
    return {
        scope: scopeId(),
        local: { present: cur.count > 0, chars: cur.chars, bytes: cur.bytes, updatedAt: envelopeAt, items: items, gz: gz },
        idb: { available: idb.available, present: idb.current, bytes: (idb.keys.filter((x) => x.current)[0] || {}).bytes || 0 },
        others: { count: ks.state.others.count, bytes: ks.state.others.bytes, keys: ks.state.others.keys.map((x) => x.key) },
        budget: localBufferMaxChars > 0 ? localBufferMaxChars : LOCAL_BUFFER_MAX_CHARS,
        stale: (() => { try { return localStaleInfo(); } catch (e) { return null; } })(),
    };
}

/**
 * 清理本机副本（localStorage 信封 / IndexedDB 副本 / 其它角色副本）。
 * @param {{target?:'local'|'idb'|'both'|'others'}} [opts]
 *   `local` = 只清当前角色的 localStorage 信封；`idb` = 只清当前角色的 IndexedDB 副本；
 *   `both`（默认）= 两者都清；`others` = 清**其它角色**的 localStorage 信封（当前角色不动）。
 *   一律**只动本机**：服务端记忆文件、IndexedDB 之外的持久层都不碰。
 */
export async function clearLocalCopy(opts) {
    const o = opts || {};
    const target = String(o.target || 'both');
    const scope = scopeId();
    const stateKeys = (() => {
        try {
            const ls = (typeof storageHooks.keys === 'function') ? (storageHooks.keys() || []) : [];
            return ls.map(String).filter((k) => k.indexOf('ftt2_state_') === 0);
        } catch (e) { return []; }
    })();
    const curKey = 'ftt2_state_' + scope;
    let localKeys = [];
    if (target === 'others') localKeys = stateKeys.filter((k) => k !== curKey);
    else if (target === 'local' || target === 'both') localKeys = [curKey];
    const rm = localKeys.length ? removeLocalKeys(localKeys) : { removed: 0, failed: [] };
    let idbRemoved = 0;
    if (target === 'idb' || target === 'both') {
        try {
            const lf = await localforageLib();
            if (lf && typeof lf.removeItem === 'function') { try { await lf.removeItem(curKey); idbRemoved += 1; } catch (e) { /* 忽略 */ } }
        } catch (e) { /* IndexedDB 不可用 → 只清 localStorage */ }
    }
    if (target === 'local' || target === 'both' || target === 'others') {
        localBuffer = {
            at: Date.now(), ok: false, skipped: 'cleared-by-user', chars: 0,
            budget: localBufferMaxChars > 0 ? localBufferMaxChars : LOCAL_BUFFER_MAX_CHARS,
            reason: target === 'others' ? '用户清除了其它角色的本机副本' : '用户清除了当前角色的本机副本',
        };
    }
    try { debugLogPush('存储', { action: '清理本机副本', target: target, localKeys: rm.removed, idb: idbRemoved }); } catch (e) { /* 忽略 */ }
    // `cleared` = 本机键删除数（与 `localKeys` 同值；供面板/devtools 统一读一个字段）
    return { ok: true, target: target, cleared: rm.removed, localKeys: rm.removed, failed: rm.failed, idb: idbRemoved };
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
        saveState: () => { markDataTouched(); void saveStateNow({ reason: 'kernel', fromKernel: true }); return true; },
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
/** 本层写入记账（写成功后调用）：记签名并让解析缓存失效 */
function markLocalWritten(sig, chars) {
    localLastSig = String(sig || '');
    localParseCache = null;                      // 本层写过 → 解析结果不再复用
    localStats.writes += 1;
    localStats.lastWriteAt = Date.now();
    localBuffer = Object.assign({}, localBuffer, { chars: chars });
    localStaleClear();                           // v3.26.2：本层已重新跟上 → 清掉「停滞标记」
    return true;
}

/** 存储接线状态（调试用） */
export function storeStatus() {
    // v3.0.23：把「读取台账」与「最近一次服务端载入结论」并入存储诊断（调试页 / 调试包 / FTT.storeStatus 同源）
    let reads = null;
    try { reads = readLedgerStats(); } catch (e) { reads = null; }
    let serverLoad = null;
    try { serverLoad = lastServerLoadInfo(); } catch (e) { serverLoad = null; }
    let local = null;
    try { local = localBufferState(); } catch (e) { local = null; }
    let relCap = null;
    try { relCap = Object.assign({}, lastRelCap); } catch (e) { relCap = null; }
    return { scope: scopeId(), module: MODULE_NAME, last: lastSaveInfo(), indexReady, reads: reads, serverLoad: serverLoad, localBuffer: local, relCap: relCap };
}
