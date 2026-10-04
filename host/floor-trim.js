// ============================================================
// host/floor-trim.js —— **内置「删除到最近 N 层」**（v2.94.0，`docs/D12` v0.2 §4 / §8-E / 阶段 S4）
//
// 用户约定：「在**设定-数据管理**中约定楼层删除的三个按钮（保留最近 6 / 10 / 12 层），确保插件可感知该操作。」
// 用户补充（本轮）：「**用官方 API 实现，不然其他插件也会异常。**」
//
// 因此删除只经**酒馆官方上下文 API**，且只改「官方会话数组 + 官方落盘 + 官方重渲染」，自作主张的东西一律不做。
//
// 流程（逐条对齐 D12 §4 前置/执行/结果，缺一不可）：
//   ① 能力探测（Q6）：宿主既没有批量截断能力、也没有 `deleteMessage` → 返回 `unsupported`，
//      按钮侧**提示不支持并禁用**，**不静默失败**；
//   ② 预检（§4 前置③）：将删除几层 / 删哪一段 / 受影响条目数 / 其中有几层**尚未提取**（§8-D 删前吸收提示）
//      + **删除方式**（批量截断 / 逐层）与逐层时的耗时预估；
//   ③ 二次确认（D9 U4）：由 UI 侧 `confirmDialog` 完成（本模块不弹窗，便于测试）；
//   ④ 自动备份（Q5）：**明文 JSON → 用户目录文件，3 槽轮转**；备份失败 → **中止删除**；
//   ⑤ 删除（§4 执行）——**v3.17.0 起只有两条路径，且默认那条永远是一次完成**：
//      · **首选：一次性批量截断**（`bulkCut`，见下）—— 官方会话数组 `chat.splice` 一次摘除前缀 +
//        `chatMetadata.tainted = true` + `await saveChat()` 落盘 + `clearChat()`/`printMessages()`
//        一次性重渲染 + **一次** `MESSAGE_DELETED` 通知；删后**按实际长度核对**，核对不过即如实失败；
//      · **最后手段：逐层 `deleteMessage`** —— 仅在宿主连批量截断都不可用时，且待删层数 ≤
//        `FLOOR_TRIM_SLOW_MAX`（3）层时执行；超过即**拒绝**并说明（宁可让用户去酒馆里手删，
//        也不把界面卡住几分钟）；过程中累计超 `FLOOR_TRIM_SLOW_BUDGET_MS` 立即中止。
//      两条路径都如实回报 `via`（`bulk` / `api`）与耗时。
//   ⑥ 校准（§3.2 + §8-B）：**精确编号重映射**（幸存楼层整体前移 M；被删段内区间 → 未知区间 + `floorStale`）+
//      台账重排 + `lastKnownFloor` 收紧；**绝不删除任何记忆条目**；
//   ⑦ 记账（§8-A 低噪声）：人工确认项一条（含备份文件名/槽位与「聊天已减小、记忆保留 N 条」）+ 调试日志。
//
// ── v3.17.0 根因修复：真机取证（本机 2026-10-05 01:59:58 → 02:05:43）──
//   用户报告：「使用插件内置删除楼层功能后，应用整体进入严重卡顿」。
//   证据（宿主侧，只读取证）：
//     · 插件调试日志：「删楼：酒馆自带命令 /cut 未生效 → 回退逐层删除 chat 242 > 12」（01:59:58）→
//       走的是 v3.4.0 的「逐层回退」；
//     · 交互时间线（`SPreset_FTTMemoryTrace`）：02:01:11 → 02:05:06 共 119 次
//       `host deleteMessage`（`site: host/floor-trim.js:253`），相邻间隔 **0.85–1.84 秒**；
//     · 聊天文件：01:59:58 起 242 层（4.32MB）逐层变短，02:05:40 才到 14 行（≈保留层数）；
//       WebView2 渲染进程工作集 3.1GB，期间应用整体卡顿。
//   结论：`executeSlashCommandsWithOptions` **存在** ≠ `/cut` 命令**存在/生效**（v3.4.0 的能力探测探错了对象）；
//     命令不生效时退回「逐层 deleteMessage」，而宿主每层要付一次
//     DOM 移除 + `saveChatDebounced` + `MESSAGE_DELETED`（各扩展全量刷新）→ ≈1.5 秒/层 → 230 层 ≈ 5 分 45 秒。
//   修复：删楼默认走**一次**批量截断；逐层只保留 ≤3 层的最后手段；并把「用哪条路径、花了多久」如实回报。
// ============================================================
import { state, log, warn, saveState } from '../core/model/runtime.js';
import { DIMENSIONS } from '../core/constants.js';
import {
    planFloorTrim, remapAfterTrim, trimSummaryText, FLOOR_TRIM_PRESETS,
    FLOOR_TRIM_SLOW_MAX, FLOOR_TRIM_SLOW_BUDGET_MS, floorTrimSlowSeconds,
} from '../core/floor-trim.js';
import { getCtx } from './st-api.js';
import { wireKernelChatHooks } from './chat.js';   // v3.0.16：删楼后立刻把「聊天视图 / 末楼快照」刷新为活值
import { hashFloorText, handleFloorShrink } from './floors.js';
import { nextFloorBackupSlot } from '../adapters/floor-backup.js';

export { FLOOR_TRIM_PRESETS, FLOOR_TRIM_SLOW_MAX };

/** 宿主注入的钩子：备份写入 / 明文导出 / 轮转账本读写 / 人工确认项登记 / 删除后刷新 */
let hooks = {
    writeBackup: null,        // async (scope, slot, text, opts) => {ok, name, slot, ...}
    exportJson: null,         // () => string（明文 JSON 信封）
    getLog: null,             // () => {slot?:number, items?:Array}
    saveLog: null,            // (log) => void
    noteConflict: null,       // (item) => void
    notify: null,             // (kind, text) => void
    afterMutate: null,        // (info) => void —— 聊天被真的改短后（重渲染可能清空了 extension_prompts）→ 宿主重推注入
};
export function setFloorTrimHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function floorTrimHooks() { return Object.assign({}, hooks); }

/** 轮转账本（宿主未接线时退化为进程内记录，仅影响「上次槽位」的连续性） */
let localLog = { slot: -1, items: [] };
function readLog() {
    try { if (typeof hooks.getLog === 'function') { const v = hooks.getLog(); if (v && typeof v === 'object') return v; } } catch (e) { /* 忽略 */ }
    return localLog;
}
function writeLog(next) {
    localLog = next;
    try { if (typeof hooks.saveLog === 'function') hooks.saveLog(next); } catch (e) { /* 忽略 */ }
}

/** 当前聊天长度（宿主权威值；无宿主返回 0） */
function chatLen() {
    try {
        const ctx = getCtx();
        return (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
    } catch (e) { return 0; }
}

/** 插件当前持有的条目总数（只读诊断） */
function entryCount() {
    try {
        let n = 0;
        for (const d of DIMENSIONS) n += (Array.isArray(state[d.kind]) ? state[d.kind].length : 0);
        return n;
    } catch (e) { return 0; }
}

// ============================================================
// v3.17.0：**删楼进行中**标志（`floorTrimBusy()`）。
//   用途：批量截断的兜底路径会调 `reloadCurrentChat()`，它会发 `CHAT_CHANGED` → 我们自己的
//   `onChatChanged` 会去**重读落盘状态**；而此刻内存里的编号重映射（⑥）还没落盘（写队列是异步的），
//   一旦重读就会把内存态换回删楼前的旧编号 → 重映射被无声撤销。故删楼全程置位，宿主侧跳过这次重读
//   （内存态此刻才是权威）。
// ============================================================
let busy = false;
/** 删楼是否正在进行（宿主 `onChatChanged` 据此跳过「重读落盘状态」） */
export function floorTrimBusy() { return busy; }

/**
 * 批量截断能力探测：是否能用**官方会话数组 + 官方落盘 + 官方重渲染**一次删掉前缀。
 * 只判「有没有 / 是不是函数」，**不产生任何副作用**。
 *
 * v3.17.1（稳健性）：落盘函数按 **`saveChat` → `saveChatConditional`** 依次认 —— 不同 ST 版本的
 *   `st-context.js` 导出键名不同（现行版本是 `saveChat: saveChatConditional`，部分宿主/旧版直接导出
 *   `saveChatConditional`）；重渲染优先 `clearChat`+`printMessages`（不重读磁盘、不发 `CHAT_CHANGED`），
 *   缺一才退 `reloadCurrentChat`。两条都认不出才判定「不支持批量」。
 * @returns {{ok:boolean, mode:string, saveVia:string, reason:string}}
 */
function bulkCapability(ctx) {
    const c = ctx || null;
    if (!c) return { ok: false, mode: '', saveVia: '', reason: 'no-host' };
    if (!Array.isArray(c.chat)) return { ok: false, mode: '', saveVia: '', reason: 'no-chat' };
    const saveVia = (typeof c.saveChat === 'function') ? 'saveChat'
        : ((typeof c.saveChatConditional === 'function') ? 'saveChatConditional' : '');
    if (!saveVia) return { ok: false, mode: '', saveVia: '', reason: 'no-save-chat' };
    const redraw = (typeof c.clearChat === 'function' && typeof c.printMessages === 'function');
    if (redraw) return { ok: true, mode: 'clear+print', saveVia: saveVia, reason: '' };
    if (typeof c.reloadCurrentChat === 'function') return { ok: true, mode: 'reload', saveVia: saveVia, reason: '' };
    return { ok: false, mode: '', saveVia: '', reason: 'no-redraw' };
}

/**
 * 能力探测（D12 Q6）：宿主是否提供**官方**删楼能力。
 * v3.17.0：`bulk` = 一次性批量截断可用（首选）；`slow` = 逐层 `deleteMessage` 可用（最后手段）。
 * v3.17.1：`bulkSave` 如实回报批量路径用的是哪个官方落盘函数（`saveChat` / `saveChatConditional`），便于诊断。
 * 只判「有没有 / 是不是函数」，**不产生任何副作用**。
 * @returns {{ok:boolean, supported:boolean, bulk:boolean, bulkMode:string, bulkSave:string, slow:boolean, slowMax:number, reason:string, detail?:string}}
 */
export function floorTrimCapability() {
    const fallback = { ok: false, supported: false, bulk: false, bulkMode: '', bulkSave: '', slow: false, slowMax: FLOOR_TRIM_SLOW_MAX, reason: 'error', detail: '' };
    try {
        const ctx = getCtx();
        if (!ctx) return Object.assign({}, fallback, { reason: 'no-host' });
        if (!Array.isArray(ctx.chat)) return Object.assign({}, fallback, { reason: 'no-chat' });
        const bulk = bulkCapability(ctx);
        const slow = (typeof ctx.deleteMessage === 'function');
        // 对外口径保持稳定：两条路都没有 = `unsupported-host`（细分原因放 `detail`，便于诊断但不改按钮文案）
        if (!bulk.ok && !slow) return Object.assign({}, fallback, { reason: 'unsupported-host', detail: bulk.reason || '' });
        return {
            ok: true, supported: true,
            bulk: !!bulk.ok, bulkMode: bulk.mode || '', bulkSave: bulk.saveVia || '',
            slow: slow, slowMax: FLOOR_TRIM_SLOW_MAX,
            reason: '', detail: '',
        };
    } catch (e) {
        return fallback;
    }
}

/**
 * v3.17.0：**一次性批量截断**（首选删除路径；全程只碰官方 API）。
 *
 * 为什么不是「逐层 deleteMessage」：真机实测宿主每层要付一次 DOM 移除 + `saveChatDebounced()` +
 *   `MESSAGE_DELETED`（各扩展全量刷新）≈1.5 秒 → 230 层 ≈ 5 分 45 秒界面卡死（见文件头取证）。
 * 这里把同样的官方副作用**各做一次**：
 *   ① `ctx.chat.splice(0, M)` —— 官方会话数组（其它扩展同款用法：`getContext().chat` 是活引用）；
 *   ② `ctx.chatMetadata.tainted = true` —— 官方字段（与官方 `deleteMessage` 同口径：条件保存据此落盘）；
 *   ③ `await ctx.saveChat()` —— 官方落盘（`saveChatConditional`）；
 *   ④ `await ctx.clearChat(); await ctx.printMessages()` —— 官方 DOM 重建（缺一即退 `reloadCurrentChat`）；
 *   ⑤ `await eventSource.emit(MESSAGE_DELETED, chat.length)` —— **一次**通知其它扩展（payload 与官方同口径）。
 * 失败一律**恢复原状**（`unshift` 放回）并如实回报 —— 绝不留下「内存删了、盘上没删」的半截状态。
 *
 * @param {object} ctx 宿主上下文
 * @param {number} removeCount 从**头部**删除的层数 M
 * @returns {Promise<{ok:boolean, deleted:number, mode:string, redraw:string, reason?:string, error?:string}>}
 */
async function bulkCut(ctx, removeCount) {
    const cap = bulkCapability(ctx);
    if (!cap.ok) return { ok: false, deleted: 0, mode: '', redraw: '', reason: cap.reason };
    const M = Math.max(0, Math.floor(Number(removeCount) || 0));
    if (M <= 0) return { ok: true, deleted: 0, mode: cap.mode, redraw: '' };
    const before = ctx.chat.length;
    let removed = null;
    try { removed = ctx.chat.splice(0, M); }
    catch (e) { return { ok: false, deleted: 0, mode: cap.mode, redraw: '', reason: 'splice-failed', error: String((e && e.message) || e) }; }
    const deleted = Math.max(0, before - ctx.chat.length);
    if (deleted <= 0) {
        // 数组没变短（宿主给的是副本 / 只读数组）→ 还原并如实回报，不假装成功
        try { if (removed && removed.length) ctx.chat.unshift.apply(ctx.chat, removed); } catch (e) { /* 忽略 */ }
        return { ok: false, deleted: 0, mode: cap.mode, redraw: '', reason: 'no-effect' };
    }
    try { if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') ctx.chatMetadata.tainted = true; } catch (e) { /* 忽略 */ }
    // ③ 落盘：失败即放回（不做「内存删了、盘上没删」的半截状态）
    //   v3.17.1：按探测结果调用宿主**实际导出**的那个官方落盘函数（`saveChat` / `saveChatConditional`）
    try { await ctx[cap.saveVia || 'saveChat'](); }
    catch (e) {
        try { if (removed && removed.length) ctx.chat.unshift.apply(ctx.chat, removed); } catch (e2) { /* 忽略 */ }
        return { ok: false, deleted: 0, mode: cap.mode, redraw: '', saveVia: cap.saveVia || '', reason: 'save-failed', error: String((e && e.message) || e) };
    }
    // ④ 重渲染：优先「清显示 + 重画」（不重读磁盘、不发 CHAT_CHANGED），不可用才退整聊重载
    let redraw = '';
    try {
        if (cap.mode === 'clear+print') { await ctx.clearChat(); await ctx.printMessages(); redraw = 'clear+print'; }
        else { await ctx.reloadCurrentChat(); redraw = 'reload'; }
    } catch (e) {
        try {
            if (cap.mode === 'clear+print' && typeof ctx.reloadCurrentChat === 'function') { await ctx.reloadCurrentChat(); redraw = 'reload'; }
        } catch (e2) { /* 忽略：渲染失败不影响删除本身，用户刷新页面即恢复 */ }
    }
    // ⑤ 一次事件通知（与官方 `deleteMessage` 同口径：参数是**删除后**的 chat.length）
    try {
        const es = ctx.eventSource;
        const t = (ctx.eventTypes && ctx.eventTypes.MESSAGE_DELETED) || 'MESSAGE_DELETED';
        if (es && typeof es.emit === 'function') await es.emit(t, ctx.chat.length);
    } catch (e) { /* 忽略：通知失败不影响删除本身 */ }
    return { ok: true, deleted: deleted, mode: cap.mode, redraw: redraw };
}

/**
 * 只读诊断（数据管理页那行「当前 N 层 · 插件 M 条 · 上次删楼 …」）。
 * @returns {{supported:boolean, reason:string, bulk:boolean, bulkMode:string, slow:boolean, slowMax:number,
 *            via:string, floors:number, entries:number,
 *            last:{at:number, keep:number, removed:number, stale:number, backup:string, via:string, ms:number}|null,
 *            presets:number[]}}
 */
export function floorTrimStatus() {
    const cap = floorTrimCapability();
    const lg = readLog();
    const items = Array.isArray(lg && lg.items) ? lg.items : [];
    const last = items.length ? items[items.length - 1] : null;
    return {
        supported: cap.supported,
        bulk: !!cap.bulk,                       // v3.17.0：宿主能否一次批量截断（默认路径）
        bulkMode: cap.bulkMode || '',
        bulkSave: cap.bulkSave || '',           // v3.17.1：批量路径实际用的官方落盘函数名（诊断用）
        slow: !!cap.slow,                       // 逐层 `deleteMessage`（最后手段；>3 层即拒绝）
        slowMax: FLOOR_TRIM_SLOW_MAX,
        via: cap.supported ? (cap.bulk ? 'bulk' : 'api') : 'none',
        reason: cap.reason,
        floors: chatLen(),
        entries: entryCount(),
        last: last ? {
            at: Number(last.at) || 0,
            keep: Number(last.keep) || 0,
            removed: Number(last.removed) || 0,
            stale: Number(last.stale) || 0,
            backup: String(last.backup || ''),
            via: String(last.via || ''),
            ms: Number(last.ms) || 0,
        } : null,
        presets: FLOOR_TRIM_PRESETS.slice(),
    };
}

/** 被删段中「尚未提取」的楼层数（§8-D 删前吸收预检；按内容哈希判台账） */
function unextractedInRange(removeCount) {
    try {
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        const set = {};
        for (const x of pf) set[String((x && x.h) || '')] = true;
        let n = 0;
        for (let f = 0; f < removeCount; f++) {
            const h = hashFloorText(f);
            if (!h || !set[h]) n++;
        }
        return n;
    } catch (e) { return 0; }
}

/**
 * 预检（**只读**）：三档按钮与确认框都用它给出「将删除 / 受影响 / 尚未提取 / 走哪条路径」。
 * @param {number} keep 保留最近层数
 * @returns {{ok:boolean, reason:string, supported:boolean, bulk:boolean, slowCount:number, slowSeconds:number,
 *            blocked:boolean, plan:object, unextracted:number, summary:string}}
 */
export function floorTrimPrecheck(keep) {
    const cap = floorTrimCapability();
    const plan = planFloorTrim({ chatLen: chatLen(), keep: keep, state: state });
    const un = plan.ok ? unextractedInRange(plan.removeCount) : 0;
    // v3.17.0：宿主没有批量截断能力时，删除只能逐层 → 层数超过上限即**拦下**（避免几分钟的界面卡顿）
    const slowCount = (plan.ok && !cap.bulk) ? plan.removeCount : 0;
    const blocked = slowCount > FLOOR_TRIM_SLOW_MAX;
    return {
        ok: !!plan.ok && cap.supported && !blocked,
        reason: (!cap.supported) ? cap.reason : (plan.ok ? (blocked ? 'slow-path-refused' : '') : String(plan.reason || '')),
        supported: cap.supported,
        bulk: !!cap.bulk,
        slowCount: slowCount,
        slowSeconds: floorTrimSlowSeconds(slowCount),
        blocked: blocked,
        plan: plan,
        unextracted: un,
        summary: trimSummaryText(plan, { unextracted: un, supported: cap.supported, slowCount: slowCount }),
    };
}

/**
 * 执行删楼（**唯一会改聊天与编号的入口**）。
 * @param {{keep:number, backup?:boolean, confirmed?:boolean, _deleteOne?:Function, _now?:Function}} opts
 *        `_deleteOne(id)` / `_now()` 仅供测试注入；生产一律走官方上下文 API。
 * @returns {Promise<object>} 见各分支 `{ok, reason?, deleted?, requested?, via?, ms?, backup?, remap?, summary?}`
 */
export async function floorTrimApply(opts) {
    const o = opts || {};
    const injected = (typeof o._deleteOne === 'function');
    const now = (typeof o._now === 'function') ? () => Number(o._now()) : () => Date.now();
    if (busy) return { ok: false, reason: 'busy', summary: '上一次删楼还没结束' };
    const keep = Math.floor(Number(o.keep) || 0);
    const pre = floorTrimPrecheck(keep);
    if (!pre.supported) {
        return { ok: false, reason: pre.reason || 'unsupported-host', unsupported: true, summary: pre.summary };
    }
    // v3.17.0：只能逐层、且层数超上限 → **拒绝**（明确告知，不静默地把界面卡住几分钟）。
    //   测试注入 `_deleteOne` 视为「显式选择慢速路径」，不受上限约束。
    if (pre.blocked && !injected) {
        const msg = '宿主不支持批量截断，逐层删除 ' + Number(pre.plan && pre.plan.removeCount) + ' 层预计约 '
            + floorTrimSlowSeconds(pre.plan && pre.plan.removeCount) + ' 秒（界面会卡顿）→ 已拒绝执行；'
            + '请到酒馆聊天界面自行删除更早的楼层，本插件会在之后自动校准编号';
        return { ok: false, reason: 'slow-path-refused', blocked: true, plan: pre.plan, summary: msg, precheck: pre };
    }
    // `pre.blocked` 但注入了 `_deleteOne`（测试显式选择慢速路径）→ 不受上限约束，继续执行
    if (!pre.ok && !pre.blocked) return { ok: false, reason: pre.reason || 'precheck-failed', plan: pre.plan, summary: pre.summary };
    const plan = pre.plan;
    const ctx = getCtx();
    const del = injected ? o._deleteOne
        : ((ctx && typeof ctx.deleteMessage === 'function') ? ctx.deleteMessage.bind(ctx) : null);

    // ④ 自动备份（Q5：3 槽轮转；失败即中止 —— 不允许「删了但没备份」）
    let backup = { ok: false, skipped: true, slot: -1, name: '' };
    if (o.backup !== false) {
        const lg = readLog();
        const slot = nextFloorBackupSlot(lg && lg.slot);
        let text = '';
        try { text = (typeof hooks.exportJson === 'function') ? String(hooks.exportJson() || '') : ''; } catch (e) { text = ''; }
        if (!text) return { ok: false, reason: 'backup-unavailable', summary: pre.summary };
        // v3.0.17：把该槽位**上一份备份的文件名**一并交给写入方 —— 写完新文件（名字带日期时间）后删旧文件，
        //   于是「3 份轮转」的上限不变，而每份备份都自带时间戳。
        const prevName = (() => { try { return String(((lg && lg.names) || {})[String(slot)] || ''); } catch (e) { return ''; } })();
        let wr = null;
        try {
            wr = (typeof hooks.writeBackup === 'function')
                ? await hooks.writeBackup(String(state.scope || ''), slot, text, { prevName: prevName })
                : null;
        } catch (e) { wr = { ok: false, error: String((e && e.message) || e) }; }
        if (!wr || !wr.ok) {
            return { ok: false, reason: 'backup-failed', backup: wr || null, error: String((wr && wr.error) || ''), summary: pre.summary };
        }
        backup = { ok: true, slot: slot, name: String(wr.name || ''), chars: Number(wr.chars) || 0 };
    }

    // ⑤ 删除：**首选一次性批量截断**；批量不可用且层数 ≤ 上限时才逐层回退
    const t0 = now();
    const before = chatLen();
    const want = plan.removeCount;
    let deleted = 0;
    let failedAt = -1;
    let via = '';
    let bulkInfo = null;
    let slowMs = 0;
    let slowAborted = '';
    busy = true;
    let result = null;
    try {
        const cap = floorTrimCapability();
        if (cap.bulk && !injected) {
            bulkInfo = await bulkCut(ctx, want);
            if (bulkInfo.ok && bulkInfo.deleted > 0) { deleted = bulkInfo.deleted; via = 'bulk'; }
            else {
                try { warn('删楼：批量截断未生效 → ' + String(bulkInfo.reason || '') + (bulkInfo.error ? ('（' + bulkInfo.error + '）') : '')); } catch (e) { /* 忽略 */ }
            }
        }
        if (deleted < want && del) {
            const remain = want - deleted;
            if (!injected && remain > FLOOR_TRIM_SLOW_MAX) {
                // 批量失败且只能逐层、层数又超上限 → 中止（不再制造几分钟的界面卡顿）
                const msg = '批量截断不可用、逐层删除 ' + remain + ' 层预计约 ' + floorTrimSlowSeconds(remain)
                    + ' 秒（界面会卡顿）→ 已中止；聊天未变，可到酒馆聊天界面自行删除更早的楼层';
                return { ok: false, reason: 'slow-path-refused', blocked: true, plan: plan, summary: msg, precheck: pre, via: 'bulk-failed' };
            }
            // 逐层回退：从后往前（先删该段中最大的下标，早先下标保持稳定）；每步核对 `chat` 是否真的变短
            const t1 = now();
            for (let id = plan.removeCount - 1 - deleted; id >= 0 && deleted < plan.removeCount; id--) {
                if (now() - t1 > FLOOR_TRIM_SLOW_BUDGET_MS) { slowAborted = 'budget'; break; }
                try { await del(id); } catch (e) {
                    failedAt = id;
                    try { warn('删楼失败（已中止）', e); } catch (e2) { /* 忽略 */ }
                    break;
                }
                if (chatLen() >= before - deleted) { failedAt = id; break; }   // 该次调用没有真的删掉（DOM 未渲染等）
                deleted++;
            }
            slowMs = Math.max(0, now() - t1);
            if (!via) via = 'api';
        }
        const deleteMs = Math.max(0, now() - t0);

        // ⑥ 校准：只按**实际删掉的层数**重映射（半途失败也保持编号自洽）
        //   v3.0.19：先记下**重映射之前**的全部台账哈希 —— 下面按内容归位时要用它把「仍然存在但被前移丢掉的」
        //   楼层标记找回来（删除只成功一部分时，前移量与实际下标会有偏差）。
        const preMarkHashes = (() => {
            try { return (Array.isArray(state.processedFloors) ? state.processedFloors : []).map((x) => String((x && x.h) || '')).filter(Boolean); }
            catch (e) { return []; }
        })();
        const remap = remapAfterTrim(state, deleted, chatLen() - 1);
        // ⑥b v3.0.16（用户报告「使用内置删除楼层后，无法衔接继续分析，新增正文无法分析」）：
        //   ① **立刻刷新聊天视图**（内核 `getLastMessageId()` 是快照，删完仍是旧值；不同步的话
        //      依赖快照的下游——批量摘要的区间、时钟窗口、遗忘/修复的末楼基准——都还按旧值算，
        //      结果是「扫到已不存在的楼层 → 没有可分析楼层」）；
        //   ② 把「按末楼推进」的基线一起收紧（推演间隔 / 传言轮次不会因删楼而错位）。
        try { wireKernelChatHooks(); } catch (e) { /* 忽略：刷新失败不影响删除本身 */ }
        // ⑥b-2 v3.17.0：批量路径的 `clearChat()` 会清空 `extension_prompts`（ST 官方行为）→
        //   交给宿主立刻重推注入，避免「删楼后这一轮注入为空」。
        if (deleted > 0) { try { if (typeof hooks.afterMutate === 'function') hooks.afterMutate({ deleted: deleted, via: via }); } catch (e) { /* 忽略 */ } }
        // ⑥c v3.0.19（用户报告「删除后无法正常继续分析」）：**再跑一次「楼层收缩处理」（force）** ——
        //   ⑥ 的「按 M 整体前移」只在「删除的是**连续前 M 层**」时成立；一旦删除**只成功了一部分**
        //   （宿主中途失败、中间某层没删掉 → 前缀里出现「洞」），前移量就对不上实际下标，
        //   台账/条目的楼层号会**挪错位置** —— 新楼层可能被错误地判成「已处理」或「已有记忆数据」，
        //   于是「删楼后新正文无法分析」。这里按**内容哈希**把台账归位（`handleFloorShrink` 的既有能力：
        //   逐楼算哈希、命中历史已处理哈希的才保留），并把越界区间降级为未知区间 —— 幂等、只改编号不删条目。
        try { handleFloorShrink({ force: true, extraHashes: preMarkHashes }); } catch (e) { /* 忽略：不影响删除本身 */ }
        try {
            const last = Math.max(-1, chatLen() - 1);
            if (Number(state.weaveLastFloor) > last) state.weaveLastFloor = last;
            const t = state.rumorTick;
            if (t && typeof t === 'object') {
                if (Number(t.lastFloor) > last) t.lastFloor = last;
                if (Number(t.parallelFloor) > last) t.parallelFloor = last;
            }
        } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }

        // ⑦ 记账（低噪声：按类型合并计数；失败不算「删除失败」，删除本身已成立）
        const after = chatLen();
        const entries = entryCount();
        const viaText = (via === 'bulk') ? ('批量截断（一次完成' + (bulkInfo && bulkInfo.redraw ? (' · ' + bulkInfo.redraw) : '') + '）')
            : (via === 'api' ? '逐层 API（慢）' : '未删除');
        const slowNote = (via === 'api') ? ('；逐层 ' + slowMs + 'ms' + (slowAborted ? ('（' + slowAborted + ' 中止）') : '')) : '';
        const summary = '聊天已减小：-' + deleted + ' 层（保留最近 ' + plan.keep + ' 层）；记忆保留 ' + entries + ' 条'
            + '；编号已校准 ' + remap.shifted + ' 条、失效 ' + (remap.staled + remap.partial) + ' 条'
            + '；删除方式 ' + viaText + '（' + deleteMs + 'ms' + slowNote + '）'
            + (backup.ok ? '；备份 ' + backup.name : '');
        const rec = {
            at: now(), keep: plan.keep, removed: deleted, requested: plan.removeCount,
            stale: remap.staled + remap.partial, shifted: remap.shifted, backup: backup.name,
            floorsBefore: plan.total, floorsAfter: after, entries: entries,
            via: via, ms: deleteMs,                              // v3.17.0：删除路径（bulk / api）与耗时（便于核对效率）
        };
        const lg = readLog();
        const items = (Array.isArray(lg && lg.items) ? lg.items : []).concat([rec]).slice(-3);   // 账本也只留 3 条
        // v3.0.17：记住**每个槽位当前的文件名**（备份名带时间戳后不再是固定名）——下一次写同槽位时据此删旧
        const names = Object.assign({}, (lg && lg.names) || {});
        if (backup.ok && backup.name) names[String(backup.slot)] = String(backup.name);
        writeLog({ slot: backup.ok ? backup.slot : (Number(lg && lg.slot) || -1), items: items, names: names });
        try {
            if (typeof hooks.noteConflict === 'function') {
                hooks.noteConflict({
                    kind: '删楼',
                    detail: '删除 ' + deleted + ' 层（保留最近 ' + plan.keep + ' 层）；记忆保留 ' + entries + ' 条；'
                        + '备份 ' + (backup.name || '（未生成）'),
                    count: 1,
                });
            }
        } catch (e) { /* 忽略 */ }
        try { log('楼层', { action: '删楼', keep: plan.keep, deleted: deleted, requested: plan.removeCount, shifted: remap.shifted, stale: rec.stale, backup: backup.name, via: via, ms: deleteMs, slowMs: slowMs, command: '' }); } catch (e) { /* 忽略 */ }
        try { if (typeof hooks.notify === 'function') hooks.notify('info', summary); } catch (e) { /* 忽略 */ }

        if (failedAt >= 0 || deleted < plan.removeCount) {
            result = {
                ok: false, reason: 'partial', partial: true, unsupported: false,
                deleted: deleted, requested: plan.removeCount, failedAt: failedAt,
                via: via, ms: deleteMs, backup: backup, remap: remap, summary: summary,
                precheck: pre,
            };
        } else {
            result = {
                ok: true, deleted: deleted, requested: plan.removeCount,
                via: via, ms: deleteMs, backup: backup, remap: remap, summary: summary, precheck: pre,
            };
        }
    } finally {
        busy = false;
    }
    return result;
}

/**
 * v2.94.0（`docs/D12` §3.4 / 阶段 S3）——**「重新校准楼层」**（设定 → 存储；幂等手动动作）。
 *
 * 与「删楼」的区别：删楼是**插件发起**（已知 M → 精确前移）；本动作是**兜底重算** ——
 *   适用于「用户在酒馆里自己删了楼」或「跨端合并后编号可疑」等情况：
 *   按当前聊天现实重跑一次 §3.1/§3.2 的收缩处理（哈希归位台账 + 超出当前末楼的区间降级为未知区间 +
 *   `lastKnownFloor` 收紧）。**只改编号，绝不删除条目**；无收缩时也安全（幂等）。
 *
 * @returns {Promise<{ok:boolean, skipped?:string, removedFloors?:number, staleEntries?:number, marks?:number, lastId?:number, stale:number}>}
 */
export async function floorRecalibrate() {
    // 判据与自动哨兵**同一口径**（`handleFloorShrink` 的 `lastKnownFloor - 5` 容忍带）：
    //   ≤5 层的正常抖动（回滚一次编辑等）不算收缩 —— 手动按钮也不该把它当收缩去改编号。
    //   真的收缩了就走完整流程；没收缩如实回 `skipped:'no-shrink'`（幂等，不动任何数据）。
    const r = await handleFloorShrink({});
    return Object.assign({ stale: countStaleEntries() }, r || {});
}

/**
 * 楼层信息已失效的条目数（只读诊断）。
 * v3.7.0（用户要求）：**来源楼层不再被清零** → 失效的两种形态是
 *   ① `originGone`（原文已移除，找不到对应楼层哈希 —— 主流）；② 历史 `floorStale`（当前位置未知，老数据）。
 */
export function countStaleEntries() {
    try {
        let n = 0;
        for (const d of DIMENSIONS) {
            for (const it of (Array.isArray(state[d.kind]) ? state[d.kind] : [])) if (it && (it.originGone === true || it.floorStale === true)) n++;
        }
        return n;
    } catch (e) { return 0; }
}

/**
 * 楼层校准只读诊断（设定 → 存储 的那一行；`docs/D12` §3.4）。
 * @returns {{at:number, stale:number, floors:number, marks:number, lastKnownFloor:number}}
 */
export function floorCalibrateStatus() {
    try {
        return {
            at: Number(state.floorShrinkAt) || 0,
            stale: countStaleEntries(),
            floors: chatLen(),
            marks: Array.isArray(state.processedFloors) ? state.processedFloors.length : 0,
            lastKnownFloor: Number(state.lastKnownFloor) || -1,
        };
    } catch (e) {
        return { at: 0, stale: 0, floors: 0, marks: 0, lastKnownFloor: -1 };
    }
}
