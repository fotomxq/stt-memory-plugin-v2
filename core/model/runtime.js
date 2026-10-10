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

/**
 * 宿主通知钩子：内核需要「提示用户」时（V1 的 toast/sendToast）的唯一出口 —— 默认 no-op（静默）。
 * 宿主可注入到 ST 的 toastr；内核因此不依赖任何宿主弹窗 API。
 */
export const notifyHooks = { toast: () => undefined };
/** 注入通知钩子（宿主启动时调用） */
export function setNotifyHooks(next) { Object.assign(notifyHooks, next || {}); return notifyHooks; }

/**
 * 世界书能力视图（宿主注入、内核只读）：V1 直接调 TH 的 `getCurrentCharPrimaryLorebook` /
 *   `getCharWorldbookNames` / `getWorldbook`；V2 一律经此视图，缺失时返回空集（内核不触宿主 API）。
 */
export const worldbookHooks = {
    getActive: async () => ({ primary: null, additional: [], global: [] }),
    getEntries: async () => [],
};
/** 注入世界书钩子 */
export function setWorldbookHooks(next) { Object.assign(worldbookHooks, next || {}); return worldbookHooks; }

/**
 * 角色身份视图（宿主注入、内核只读）：`characterName` 用于「默认货币归属」等需要主角名的判断。
 * V1 这里调 TH 的 `getCurrentCharacterName()`；V2 由宿主把当前角色名注入进来。
 */
export const identityView = { characterName: '' };
/** 注入身份视图 */
export function setIdentityView(next) { Object.assign(identityView, next || {}); return identityView; }

/**
 * 定时器钩子：内核的「延迟调度」（平行事件衰退 / 状态衰退 / 记忆遗忘清扫）不直接用全局 `setTimeout`，
 * 而由宿主注入 —— 缺失时默认 **no-op**（不调度、不后台跑）。内核因此保持零宿主依赖。
 */
export const timerHooks = { set: () => 0, clear: () => undefined };
/** 注入定时器钩子（宿主启动时调用；传 { set, clear }） */
export function setTimerHooks(next) { Object.assign(timerHooks, next || {}); return timerHooks; }

/** 持久化钩子（内核不直接落盘；由 host 层注入 real 实现） */
let persistHooks = { saveCfg: () => true, saveState: () => true, persistNow: () => false, log: null, warn: null };
/** 注入持久化钩子（host 启动时调用） */
export function setPersistHooks(next) {
    persistHooks = Object.assign({}, persistHooks, next || {});
    return persistHooks;
}
/** 逐字移植的 V1 代码会调用 `saveCfg()`；内核默认 no-op，宿主可注入真实保存 */
export function saveCfg() {
    try { return persistHooks.saveCfg(); } catch (e) { return false; }
}
/**
 * 最后一条消息的楼层号（V1 由宿主 API `getLastMessageId()` 提供；内核默认 -1 = 未知）。
 * 宿主在启动与每次消息渲染后注入（host/st-api.js）。
 */
let lastMessageId = -1;
/** 注入最后楼层号 */
export function setLastMessageId(v) {
    const n = Number(v);
    lastMessageId = Number.isFinite(n) ? Math.floor(n) : -1;
    return lastMessageId;
}
/** 读最后楼层号（内核默认 -1） */
export function getLastMessageId() {
    return lastMessageId;
}

/**
 * 宿主聊天读取钩子（V1 直接调 TH API；V2 由 host/chat.js 注入）。
 * 内核只消费结果字符串，保持零宿主依赖。
 */
let chatHooks = {
    getChatMessages: () => [],
    getAssistantText: () => '',
    latestAiFloorText: () => '',
    dbgLog: () => undefined,
    // v3.40.0（`docs/D16` L11）：合并式日志钩子（未接线 → `dbgLogCoalesced` 退化为 `dbgLog`）
    dbgLogCoalesced: null,
};
/**
 * 接线前告警的暂存（v3.24.1）。
 *
 * 背景（真机取证受阻的根因）：`warn(...)` 的三个出口里，`persistHooks.warn` 与 `chatHooks.dbgLog`
 *   **都要等 host 接线后才有实现**；而插件初始化早期（刷新后 `init()` 里 `wireKernelChatHooks()` 之前）
 *   发生的告警只有 toast 一个出口能生效 → 用户看到弹窗，调试日志 / 调试桥里却**一条都查不到**。
 * 口径：每条 `warn()` 文案先落进这个有界暂存；`setChatHooks()` **首次**接线时 `flushWarnBacklog()`
 *   把它们一次性补记进调试日志（`kind='异常'`）并清空（幂等：事件刷新会反复调 `setChatHooks`，不重复写）。
 */
export const WARN_BACKLOG_MAX = 20;
let warnBacklog = [];
/** 读告警暂存（最近 `WARN_BACKLOG_MAX` 条；只读快照） */
export function warnBacklogList() { try { return warnBacklog.slice(); } catch (e) { return []; } }
/** 清空告警暂存（接线补记后调用 / 测试复位） */
export function clearWarnBacklog() { warnBacklog = []; return true; }
/** 记一条暂存（只保留最近 N 条） */
function pushWarnBacklog(msg) {
    try {
        warnBacklog.push({ at: Date.now(), msg: String(msg == null ? '' : msg) });
        if (warnBacklog.length > WARN_BACKLOG_MAX) warnBacklog.splice(0, warnBacklog.length - WARN_BACKLOG_MAX);
    } catch (e) { /* noop */ }
}
/**
 * 把「接线前暂存的告警」一次性补记进调试日志（只记一次；失败静默）。
 * @returns {number} 实际补记条数
 */
export function flushWarnBacklog() {
    let n = 0;
    try {
        const list = warnBacklog.slice();
        if (!list.length) return 0;
        warnBacklog = [];
        for (const it of list) {
            try {
                dbgLog('异常', { action: '初始化期告警（调试日志接线前暂存，现补记）', message: String((it && it.msg) || '').slice(0, 300), at: Number((it && it.at) || 0) });
                n++;
            } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* noop */ }
    return n;
}

/** 注入聊天/日志读取钩子（host 启动时调用） */
export function setChatHooks(next) {
    chatHooks = Object.assign({}, chatHooks, next || {});
    // v3.24.1：**接线时补记接线前的告警**（有则补、补完清空 → 天然幂等；`setChatHooks` 会被事件反复调用，
    //   但没有暂存时这里零开销）。否则初始化早期的告警只活在弹窗里 —— 真机排查时「日志全空」的原因。
    if (warnBacklog.length) flushWarnBacklog();
    return chatHooks;
}
/** 取聊天消息数组（默认空） */
export function getChatMessages() { try { return chatHooks.getChatMessages() || []; } catch (e) { return []; } }
/** 取最新 AI 楼层正文（默认空串） */
export function getAssistantText() { try { return String(chatHooks.getAssistantText() || ''); } catch (e) { return ''; } }
/** 取用于在场/时钟解析的最新 AI 回复正文（默认空串） */
export function latestAiFloorText() { try { return String(chatHooks.latestAiFloorText() || ''); } catch (e) { return ''; } }
/** 调试日志（内核默认 no-op） */
export function dbgLog(...args) { try { return chatHooks.dbgLog(...args); } catch (e) { return undefined; } }
/**
 * v3.40.0（`docs/D16` L11）：**合并式**调试日志 —— 同一 `key` 在窗口内的重复「成功」日志只占一条
 *   （带 `n` / `lastAt` / `bytes`）；宿主未接线合并钩子时**自动退化为普通 `dbgLog`**（行为不变、不丢日志）。
 * @param {string} kind 分类
 * @param {string} key 合并键（同一件事才用同一个键）
 * @param {object} data 载荷
 * @param {{windowMs?:number, force?:boolean}} [opts]
 */
export function dbgLogCoalesced(kind, key, data, opts) {
    try {
        if (typeof chatHooks.dbgLogCoalesced === 'function') return chatHooks.dbgLogCoalesced(kind, key, data, opts);
        return chatHooks.dbgLog(kind, data);
    } catch (e) { return undefined; }
}

/** 日志钩子（内核默认 no-op；宿主可注入真实日志） */
export function log(...args) {
    try { if (typeof persistHooks.log === 'function') return persistHooks.log(...args); } catch (e) { /* noop */ }
    return undefined;
}

/**
 * 告警出口（v2.87.0 修复：**不再「什么都没反应」**）。
 * 用户报告：「一些错误信息除了日志记录外，应该通知异常，而不是什么都没反应。」
 * 现状缺陷：`adapters/store.js` 把 `persistHooks.warn` 接成了 `() => undefined` —— 内核所有 `warn(...)` 被丢弃，
 *   既没进调试日志，也没有任何用户可见提示。
 * 现口径（一次调用，三件事）：
 *   ① 交宿主注入的 `persistHooks.warn`（写调试日志）；
 *   ② 写 `dbgLog`（保证至少进调试日志，供调试页/调试包取证）；
 *   ③ 经 `notifyHooks.toast(..., 'error')` 给用户**可见的异常提示**（带节流，避免连环报错刷屏）。
 */
export function warn(...args) {
    const msg = (() => {
        try {
            const a = args.map((x) => (x instanceof Error ? (x.message || String(x)) : (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (e2) { return String(x); } })() : String(x == null ? '' : x))));
            return a.filter(Boolean).join(' ').slice(0, 300);
        } catch (e) { return ''; }
    })();
    // v3.24.1（初始化顺序取证的基石）：**先留存，再分发** —— 初始化早期（`dbgLog` 尚未接线）的告警
    //   此前只会弹一个 toast、调试日志里什么都没有（真机「只看到弹窗、日志查不到」的原因）。
    //   暂存见 `pushWarnBacklog`；`setChatHooks` 首次接线时一次性补记进调试日志。
    pushWarnBacklog(msg);
    try { if (typeof persistHooks.warn === 'function') persistHooks.warn(...args); } catch (e) { /* noop */ }
    try { dbgLog('异常', { action: '内核告警', message: msg, args: args.length }); } catch (e) { /* noop */ }
    try { notifyError(msg); } catch (e) { /* noop */ }
    return undefined;
}

// 告警提示的**节流**：同一条文案 60s 内只弹一次（累计计数）；**每会话最多 5 条**，避免连环报错刷屏。
const WARN_THROTTLE_MS = 60000;
const WARN_MAX_PER_SESSION = 5;
let warnSeen = Object.create(null);
let warnShown = 0;

/**
 * 用户可见的异常提示（节流）；`force=true` 绕过节流与上限（用于明确的用户动作失败）。
 * @param {string} text 提示文案
 * @param {object} [opts] `{ force?:boolean, kind?:string }`
 */
export function notifyError(text, opts) {
    const o = opts || {};
    const key = String(text == null ? '' : text).slice(0, 200);
    if (!key) return { shown: false, reason: 'empty' };
    const now = Date.now();
    if (!o.force) {
        if (warnShown >= WARN_MAX_PER_SESSION) return { shown: false, reason: 'cap' };
        const last = warnSeen[key] || 0;
        if (now - last < WARN_THROTTLE_MS) { warnSeen[key] = last; return { shown: false, reason: 'throttled' }; }
    }
    warnSeen[key] = now;
    warnShown += 1;
    try { notifyHooks.toast('⚠️ ' + key, String(o.kind || 'error')); } catch (e) { /* noop */ }
    return { shown: true, count: warnShown };
}
/** 告警提示统计（诊断 / 单测） */
export function warnStats() { try { return { shown: warnShown, seen: Object.keys(warnSeen).length, max: WARN_MAX_PER_SESSION }; } catch (e) { return { shown: 0, seen: 0, max: WARN_MAX_PER_SESSION }; } }
/** 复位告警节流（测试与「清空日志」用） */
export function resetWarnThrottle() { warnSeen = Object.create(null); warnShown = 0; return true; }

/** 同上：`saveState()` */
export function saveState() {
    try { return persistHooks.saveState(); } catch (e) { return false; }
}
/**
 * v3.0.3（用户要求）：「每次被动提取记忆及原子数据发生变化，后应该触发保存到服务器的操作。」
 *   `saveState()` 走的是**防抖**落盘（800ms 后合并写）；本钩子要求宿主**立刻**落一次（含服务端文件），
 *   用于「数据刚变 → 马上写服务端」的确定性语义（并发调用由宿主的 flush 合并，不会叠加写）。
 * @param {string} [reason] 落盘原因（进保存记录 / 调试日志）
 * @returns {Promise<object>|object} 宿主实现（内核不 await，避免把同步调用点变成异步）
 */
export function persistNow(reason) {
    try { return persistHooks.persistNow(String(reason || '')); } catch (e) { return false; }
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
/**
 * v3.0.23（用户报告「初次激活插件读取的数据还是没有对齐」里的**竞态**成因）：内核状态的**注入序号**。
 *   载入是「读各层 → 合并 → 注入」的异步过程；期间任何**别的**注入（导入 JSON / V1 导入 / 清空记忆 /
 *   跨端合并）都会把状态换成更新的那一份。旧实现里载入**无条件覆盖** → 后完成的载入会把刚导入的数据
 *   清成空（时序稍变就复现：实测 `init` 的载入落在用户导入之后 → 刚导入的条目被清空）。
 *   现在载入在注入前比对序号：**期间有人动过状态就不覆盖**（那一份更新），并如实回报 `superseded`。
 */
let stateSeq = 0;
export function kernelStateSeq() { return stateSeq; }

export function setKernelState(next) {
    state = next || null;
    stateSeq += 1;
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

// ==================== v3.14.0：**载入闸门**（首屏数据读取期间的 UI 拦截） ====================
/**
 * 背景（用户要求）：「刚加载插件后数据还未完整读取，应有读取拦截提示，避免报错，等加载完成后再展示内容。」
 *
 * 首屏时序：`init()` 先装入口（扩展菜单项 / 浮层兜底），**之后**才 `await loadMemoryState()` ——
 *   这段时间里内核 state 还是空的（或上一次作用域的残留）。此时若用户点开面板，旧行为会直接渲染
 *   「总记忆数 0 / 待分析 0 层」一类**残缺视图**，执行动作更是可能基于不完整数据（甚至有写坏存档的风险）。
 *
 * 闸门口径（内核零宿主依赖，UI / index 各自读它）：
 *   · `phase = 'idle'`（默认，**未开始过载入** → 不拦截，保持既有行为与测试兼容）
 *   · `phase = 'loading'`：首屏载入进行中 → **拦截**：面板只显示读取提示、动作一律拒绝
 *   · `phase = 'ready'` / `'failed'`：载入结束 → 正常展示（失败也放行，避免把用户永久挡在门外）
 */
export const loadGate = { phase: 'idle', startedAt: 0, finishedAt: 0, note: '', error: '', waitedMs: 0, timeout: false };
/** 载入阶段的合法取值 */
export const LOAD_PHASES = Object.freeze(['idle', 'loading', 'ready', 'failed']);
/**
 * 拦截的**超时兜底**（毫秒）：超过这个时长仍未结束载入 → 自动放行（`phase` 变 `ready` 且 `timeout:true`）。
 * 理由：宿主某个读取 API 挂起（promise 永不 settle）时，绝不应该把界面**永久**挡在门外 ——
 * 放行后用户至少能看到已有数据，调试页/读取台账仍可查原因。
 */
export const LOAD_GATE_MAX_MS = 20000;

/**
 * 设置载入阶段（index.js 在载入前后调用；`info` 可带 `{note, error, via, items}`）。
 * @param {'idle'|'loading'|'ready'|'failed'} phase
 * @param {{note?:string, error?:string, via?:string, items?:number}} [info]
 * @returns {object} 闸门快照
 */
export function setLoadPhase(phase, info) {
    const p = LOAD_PHASES.indexOf(String(phase)) >= 0 ? String(phase) : 'idle';
    const i = info || {};
    const now = Date.now();
    loadGate.phase = p;
    loadGate.timeout = false;
    if (p === 'loading') { loadGate.startedAt = now; loadGate.finishedAt = 0; loadGate.error = ''; }
    else if (p === 'ready' || p === 'failed') {
        loadGate.finishedAt = now;
        if (p === 'failed') loadGate.error = String(i.error || '');
    } else { loadGate.startedAt = 0; loadGate.finishedAt = 0; loadGate.error = ''; }
    loadGate.note = String(i.note || '');
    loadGate.waitedMs = (loadGate.startedAt && loadGate.finishedAt) ? Math.max(0, loadGate.finishedAt - loadGate.startedAt) : 0;
    if (i.via !== undefined) loadGate.via = String(i.via || '');
    if (i.items !== undefined) loadGate.items = Number(i.items) || 0;
    return loadGateInfo();
}

/**
 * 是否处于「首屏读取中」→ UI 应拦截（唯一判据：`phase === 'loading'`，且**未超过超时兜底**）。
 * 超时（`LOAD_GATE_MAX_MS`）会自动放行一次，`loadGate.timeout = true` 如实留痕。
 */
export function loadBlocked() {
    if (loadGate.phase !== 'loading') return false;
    const waited = loadGate.startedAt ? (Date.now() - loadGate.startedAt) : 0;
    if (waited > LOAD_GATE_MAX_MS) {
        loadGate.phase = 'ready';
        loadGate.finishedAt = Date.now();
        loadGate.waitedMs = Math.max(0, loadGate.finishedAt - loadGate.startedAt);
        loadGate.timeout = true;
        loadGate.note = '读取超时（>' + LOAD_GATE_MAX_MS + 'ms）：已放行界面，数据可能不完整';
        return false;
    }
    return true;
}

/** 闸门快照（只读拷贝；UI / 调试页 / 命令用） */
export function loadGateInfo() {
    const blocked = loadBlocked();
    return {
        phase: loadGate.phase, blocked: blocked,
        startedAt: loadGate.startedAt, finishedAt: loadGate.finishedAt,
        waitedMs: blocked && loadGate.startedAt ? Math.max(0, Date.now() - loadGate.startedAt) : loadGate.waitedMs,
        via: loadGate.via || '', items: Number(loadGate.items) || 0,
        note: loadGate.note || '', error: loadGate.error || '', timeout: loadGate.timeout === true,
    };
}

// ==================== v3.40.4：**落盘守门**（`docs/D22` `技-1` · `docs/D11` §3.2 第 1 条「对齐 R2」） ====================
/**
 * **载入流水线完成之前，禁止任何记忆数据落盘**（参考实现 R2：ready 之前只读不写）。
 *
 * 为什么必须有（`docs/D21` §3.1 K2）：`init()` 里**入口先于载入安装**，而宿主事件
 *   （收到消息 → 自动提取 / 自动修复 / 时钟同步）是**页面级**的 —— 首屏还没读完就触发的保存，
 *   会拿**未就绪或半份**的内核态去覆盖远端与本地副本（「载入未完成即保存可能覆盖远端」）。
 *   UI 层的载入闸门（`loadBlocked()` / v3.14.0）只挡住了**用户动作**，挡不住宿主事件驱动的写入。
 *
 * 口径（三条）：
 *   ① **载入开始 → 关；载入结束（成功**或**失败）→ 开** —— 失败也放行：绝不把用户永久锁在「不能保存」，
 *      失败后的数据安全由既有的**异常缩水守卫**（`adapters/store.js#shrinkGuardCheck`）兜底；
 *   ② **安全阀**：关闸超过 `WRITE_GATE_MAX_MS`（与载入闸门同为 20s）仍未开 → **自动放行并如实计数**
 *      （`timeouts`），绝不静默卡死写入；载入真的挂住时也不该让用户丢掉保存能力；
 *   ③ **不丢数据**：被挡下的保存请求会被**记住**（`pending`），由开闸方（`index.js`）在放行后**补跑一次**
 *      （典型：载入期数据自愈的写回 —— 它由 `scheduleSave` 在载入过程中触发，若直接丢弃就等于「修了不落盘」）。
 *
 * 内核只维护状态与计数（零宿主依赖）；记账（读取台账 / 调试日志）由适配层在调用点完成。
 */
export const WRITE_GATE_MAX_MS = LOAD_GATE_MAX_MS;
const writeGateState = {
    closed: false, closedAt: 0, reason: '', releasedAt: 0,
    blocked: 0, pending: 0, timeouts: 0, lastBlockedAt: 0, lastBlockedWhere: '',
};
/**
 * 关闸 / 开闸（幂等）。
 * @param {boolean} closed true = 载入中，禁止落盘；false = 放行
 * @param {string} [reason] 关闸原因（进快照，便于诊断）
 * @returns {object} 快照
 */
export function setWriteGate(closed, reason) {
    const want = closed === true;
    if (want && !writeGateState.closed) {
        writeGateState.closed = true;
        writeGateState.closedAt = Date.now();
        writeGateState.reason = String(reason || '');
    } else if (!want && writeGateState.closed) {
        writeGateState.closed = false;
        writeGateState.releasedAt = Date.now();
        writeGateState.reason = '';
    } else if (want && reason && !writeGateState.reason) {
        writeGateState.reason = String(reason);
    }
    return writeGateInfo();
}
/** 是否处于「载入中，禁止落盘」（含安全阀：超时自动放行并计数） */
export function writeGateClosed() {
    if (!writeGateState.closed) return false;
    const waited = writeGateState.closedAt ? (Date.now() - writeGateState.closedAt) : 0;
    if (waited > WRITE_GATE_MAX_MS) {
        writeGateState.closed = false;
        writeGateState.releasedAt = Date.now();
        writeGateState.timeouts += 1;
        writeGateState.reason = '';
        return false;
    }
    return true;
}
/**
 * 记一次「被守门挡下的写入」：计数 + 记 pending（开闸方据此补跑一次）。
 * @param {string} where 调用点标识（`文件#函数`）
 */
export function noteWriteBlocked(where) {
    writeGateState.blocked += 1;
    writeGateState.pending += 1;
    writeGateState.lastBlockedAt = Date.now();
    writeGateState.lastBlockedWhere = String(where || '');
    return writeGateState.blocked;
}
/** 取走 pending（开闸方调用；取走即清零，天然幂等） */
export function takeWriteGatePending() {
    const n = writeGateState.pending;
    writeGateState.pending = 0;
    return n;
}
/** 守门快照（只读拷贝；诊断 / 测试 / 调试页用） */
export function writeGateInfo() {
    return {
        closed: writeGateClosed(), closedAt: writeGateState.closedAt, reason: writeGateState.reason,
        releasedAt: writeGateState.releasedAt, blocked: writeGateState.blocked, pending: writeGateState.pending,
        timeouts: writeGateState.timeouts, lastBlockedAt: writeGateState.lastBlockedAt,
        lastBlockedWhere: writeGateState.lastBlockedWhere, maxMs: WRITE_GATE_MAX_MS,
    };
}
/** 复位守门（teardown / 测试用） */
export function resetWriteGate() {
    writeGateState.closed = false; writeGateState.closedAt = 0; writeGateState.reason = '';
    writeGateState.releasedAt = Date.now(); writeGateState.blocked = 0; writeGateState.pending = 0;
    writeGateState.timeouts = 0; writeGateState.lastBlockedAt = 0; writeGateState.lastBlockedWhere = '';
    return writeGateInfo();
}
