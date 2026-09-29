// ============================================================
// host/floors.js —— 楼层读取与「已分析楼层」台账（**逐字对齐 V1**，宿主层）
// 事实源：V1 `floorStableText` / `getAssistantText` / `collectFloorLinesInRange` / `floorAnalyzableText` /
//   `hashFloorText` / `isFloorProcessed` / `recordProcessedFloors`（src/modules/09-AI摘要与楼层处理.js）。
// 分工：**取文与判据在宿主层**（需要 ST 聊天与 TH 能力）；台账写在内核容器 `state.processedFloors`
//   （V1 同名字段，故 V1 存档可直接沿用「哪些楼层已分析」）。
// ============================================================
import { hashText } from '../core/util.js';
import { applyFeedRegex } from '../core/prompt.js';
import { state, cfg, saveState, log, warn, notifyError, getLastMessageId } from '../core/model/runtime.js';
import { floorCoverage } from '../core/floor-cover.js';
import { getCtx } from './st-api.js';
import { DIMENSIONS } from '../core/constants.js';   // v2.93.0：楼层收缩时逐维修正陈旧区间
// v2.44.0（用户报告）：取文**保留 HTML**、在「过滤之后、交给 AI 之前」才剔标签 —— 顺序不可颠倒：
//   投喂白名单是**按标签名提取 `<content>…</content>`**（`core/prompt.js#applyFeedRegex`），
//   若在过滤前就把标签删掉，白/黑名单会永远匹配不到（v2.44.0 首版即为该缺陷，见 docs/P10j）。
//   另：**楼层哈希仍用原始稳定正文**（`floorStableText`），既有「已处理楼层」台账不会失效。
import { cleanText } from '../core/html-text.js';

/** V1 台账版本与哈希自检签名（签名 = hashText(固定样本)，故与 V1 逐字符同值） */
export const PROCESSED_VER = 'v1.174';
export const PROCESSED_SIG = (() => {
    try { return hashText(floorStableText({ swipes: ['【FTT 已处理楼层哈希自检样本 v1.174】'] })); } catch (e) { return 'sig'; }
})();
export function processedVerTag() { return `${PROCESSED_VER}:${PROCESSED_SIG}`; }

/** 稳定正文：优先 `swipes[0]`（原始首刷，不随选中刷/可视文本被改写而变）；否则取 mes 等字段（V1 逐字） */
export function floorStableText(msg) {
    try {
        if (!msg) return '';
        if (Array.isArray(msg.swipes) && typeof msg.swipes[0] === 'string' && msg.swipes[0].trim()) return msg.swipes[0];
        for (const k of ['message', 'mes', 'content']) { if (typeof msg[k] === 'string' && msg[k].trim()) return msg[k]; }
        return '';
    } catch (e) { return ''; }
}

/** 当前刷正文（V1 `getAssistantText`）：优先 `swipes[swipe_id]` */
export function assistantTextOf(msg) {
    try {
        if (!msg) return '';
        const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (Array.isArray(msg.swipes) && typeof msg.swipes[swipeId] === 'string' && msg.swipes[swipeId].trim()) return msg.swipes[swipeId];
        for (const k of ['message', 'mes', 'content']) { if (typeof msg[k] === 'string' && msg[k].trim()) return msg[k]; }
        return '';
    } catch (e) { return ''; }
}

/** 取第 i 楼原始消息（ST ctx.chat[i]；越界 → null） */
export function floorMessage(i) {
    try {
        const ctx = getCtx();
        const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
        const idx = Number(i);
        if (!Number.isFinite(idx) || idx < 0 || idx >= chat.length) return null;
        return chat[idx] || null;
    } catch (e) { return null; }
}

function roleOf(m) {
    if (!m) return '';
    if (m.is_user) return '用户';
    if (m.is_system) return 'system';
    return 'AI';
}

/**
 * 区间楼层原始行（V1 `collectFloorLinesInRange` 逐字：含 `[第N楼 角色]` 前缀、跳过隐藏楼）。
 * **返回原始正文（含 HTML 标签）**：投喂白名单要按标签名提取 `<content>…</content>`，
 *   故去标签只能发生在 `applyFeedRegex` **之后**（见 `buildFeedFloorText` / `floorAnalyzableText`）。
 */
export function collectFloorLinesInRange(start, end, opts) {
    const floors = [];
    const aiOnly = !!(opts && opts.aiOnly);
    try {
        for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) {
            const m = floorMessage(i);
            if (!m || m.is_hidden) continue;
            if (aiOnly && (m.is_user || (m.role && m.role !== 'assistant'))) continue;
            const text = assistantTextOf(m);   // **保留 HTML**：投喂白/黑名单按标签名过滤需要原始标签
            if (!text) continue;
            floors.push(`[第${i}楼 ${roleOf(m)}] ${text}`);
        }
    } catch (e) { warn('楼层投喂构建失败', e); }
    return floors;
}

/** 最近 N 楼原始行（V1 `collectFloorLines`） */
export function collectFloorLines(maxFloors) {
    try {
        const ctx = getCtx();
        const n = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
        const start = Math.max(0, n - Math.max(1, Number(maxFloors) || 1));
        return collectFloorLinesInRange(start, n - 1);
    } catch (e) { return []; }
}

/**
 * 投喂文本（V1 `buildFeedFloorText`）：最近 N 楼原始行 → **投喂标签过滤（此时标签仍在）** → 去 HTML 交 AI。
 * 顺序不可颠倒：白名单走 `<tag>…</tag>` 提取、黑名单按行匹配标签，必须在去标签**之前**；
 *   去标签则保证 AI 提示词与后续落库不含 `<br>`/`<div>`（v2.44.0 用户报告）。
 */
export function buildFeedFloorText(maxFloors) {
    try { return cleanText(applyFeedRegex(collectFloorLines(maxFloors).join('\n'))); } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}
/** 指定结束楼层的投喂文本（V1 `buildFeedFloorTextRange`：摘要用于排除生成中的最近楼） */
export function buildFeedFloorTextRange(maxFloors, endFloor, opts) {
    try {
        const end = Number(endFloor);
        const validEnd = Number.isInteger(end) && end >= 0 ? end : Math.max(0, (getCtx() && Array.isArray(getCtx().chat) ? getCtx().chat.length : 1) - 1);
        const n = Math.max(1, Number(maxFloors) || 10);
        return cleanText(applyFeedRegex(collectFloorLinesInRange(Math.max(0, validEnd - n + 1), validEnd, opts).join('\n')));
    } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}

/** 可分析正文（V1 `floorAnalyzableText`）：投喂正则过滤 + 去占位楼 */
export function floorAnalyzableText(i) {
    try {
        const f = Number(i);
        if (!Number.isFinite(f) || f < 0) return '';
        // 同样「先按标签过滤、再去标签」：过滤需要标签，投喂给 AI 的文本不能带标签
        const raw = String(cleanText(applyFeedRegex(collectFloorLinesInRange(f, f).join('\n'))) || '').trim();
        if (!raw) return '';
        const body = raw.replace(/^\[第\d+楼[^\]]*\]\s*/, '').trim();
        if (!body || /^(?:\.{2,}|…+|—+|-+|·+)$/.test(body)) return '';
        return raw;
    } catch (e) { return ''; }
}

/** 楼层内容哈希（V1 `hashFloorText`：稳定正文 → hashText） */
export function hashFloorText(i) {
    try {
        const m = floorMessage(Number(i));
        const text = m ? (floorStableText(m) || (typeof m.mes === 'string' ? m.mes : '')) : '';
        return text ? hashText(text) : '';
    } catch (e) { return ''; }
}

/** 台账条目楼层号（V1 兼容：`{f,h}` 或裸数字） */
const markFloor = (x) => Number(x && typeof x === 'object' ? x.f : x);

/** 该楼在「已处理楼层」台账里的标记（无 → undefined） */
function processedMarkOf(i) {
    try {
        const pf = state.processedFloors || [];
        const n = Number(i);
        return pf.find((x) => markFloor(x) === n);
    } catch (e) { return undefined; }
}

/**
 * 是否已分析（V1 `isFloorProcessed`）：
 *   ① 台账版本签名不符（插件/算法更新）→ 按当前算法重算台账（**不是**把历史楼层全判未分析）；
 *   ② 台账无该楼 → false；③ 内容哈希一致 → true；④ 内容变了 → false（视为需重新分析）。
 * @returns {boolean}
 */
export function isFloorProcessed(i) {
    try {
        if ((state.processedVer || '') !== processedVerTag()) { try { migrateProcessedFloorsV170(); } catch (e) { /* 忽略 */ } }
        const pf = state.processedFloors || [];
        const mark = pf.find((x) => markFloor(x) === Number(i));
        if (!mark) return false;
        const h = hashFloorText(i);
        if (!h) return false;
        if (!mark.h || mark.h === h) return true;
        return false;
    } catch (e) { return false; }
}

/**
 * **聊天是否已就绪**（v2.87.0 修复「重启/更新后大量早期楼层冒出来」的关键守卫）。
 * 用户报告：「总览的未摘要每次更新或重启后，都会提示大量早期楼层，该问题在之前版本已经存在。」
 * 根因：插件启动/更新的时刻**聊天可能尚未同步进宿主 ctx**（`getCtx().chat` 为空或消息还没有正文）。
 *   此时 `hashFloorText()` 一律返回 `''`，而 `migrateProcessedFloorsV170()` 的口径是「无正文 → 丢弃该标记」
 *   → **整本台账被清空**并写入当前版本签名；等聊天同步完成后，台账已丢失，只剩「已有记忆数据」覆盖兜底，
 *   于是**早期楼层**（数据早被上限裁剪掉的那批）成片变回「未摘要」，且会随下一次保存永久落盘。
 * 判据（廉价、只读）：聊天为空 → 未就绪；否则取首/中/尾三楼采样，**全部拿不到正文** → 未就绪。
 * @returns {{ready:boolean, reason:string, total:number}}
 */
export function chatReadyForFloors() {
    try {
        const ctx = getCtx();
        const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
        const total = chat.length;
        if (total <= 0) return { ready: false, reason: 'no-chat', total: total };
        const probes = [0, Math.floor((total - 1) / 2), total - 1];
        let ok = 0;
        for (const i of probes) {
            const m = chat[i];
            if (!m) continue;
            if (String(floorStableText(m) || m.mes || '').trim()) ok++;
        }
        if (ok === 0) return { ready: false, reason: 'no-text', total: total };
        return { ready: true, reason: '', total: total };
    } catch (e) { return { ready: false, reason: 'error', total: 0 }; }
}

/** 台账归位刷新（V1 v1.170/v1.174 口径：签名不符时把已知楼层按当前算法重算哈希） */
export function migrateProcessedFloorsV170() {
    try {
        // V1 v1.85 同款短路：**版本签名一致 → 直接返回**。缺了这一句时「旧标记迁移」会在每次扫描时
        //   把标记哈希刷成当前正文哈希 —— 那会把「正文被改写、本该重新分析」的楼层也永久判为已处理。
        if ((state.processedVer || '') === processedVerTag()) return { migrated: 0, skipped: 'current' };
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        if (!pf.length) { state.processedVer = processedVerTag(); return { refreshed: 0, migrated: 0 }; }
        // v2.87.0：聊天未就绪时**绝不动台账**（否则「无正文 → 丢弃标记」会把整本台账清空，见 chatReadyForFloors）
        const ready = chatReadyForFloors();
        if (!ready.ready) {
            try { log('摘要', { action: '已处理楼层迁移延后（聊天未就绪）', reason: ready.reason, marks: pf.length }); } catch (e) { /* 忽略 */ }
            // v2.87.0：不再「什么都没反应」——给一次**节流**的用户提示（同文案 60s 内只弹一次）
            try { notifyError('聊天尚未就绪，已处理楼层台账暂未刷新（不影响已分析记录）'); } catch (e) { /* 忽略 */ }
            return { refreshed: 0, migrated: 0, skipped: 'chat-not-ready' };
        }
        const lastId = Number(getLastMessageId());
        let refreshed = 0, dropped = 0;
        const next = [];
        for (const x of pf) {
            const f = markFloor(x);
            if (!Number.isFinite(f) || f < 0) { dropped++; continue; }
            if (Number.isFinite(lastId) && lastId >= 0 && f > lastId) { dropped++; continue; }   // 楼层已不存在（删除/回滚）
            const h = hashFloorText(f);
            if (!h) { dropped++; continue; }        // 无正文 → 丢弃该标记（V1 同口径）
            next.push({ f, h });
            refreshed++;
        }
        state.processedFloors = next.slice(-5000);
        state.processedVer = processedVerTag();
        if (next.length) state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, Math.max.apply(null, next.map((x) => x.f)));
        log('摘要', { action: 'v1.84 旧标记批量迁移', migrated: refreshed, dropped: dropped });
        return { refreshed, migrated: refreshed, dropped };
    } catch (e) { return { refreshed: 0 }; }
}

/** 记录已分析楼层（V1 `recordProcessedFloors`：`{f,h}` 台账 + 版本签名 + lastKnownFloor + 落盘） */
export function recordProcessedFloors(start, end) {
    try {
        state.processedFloors = state.processedFloors || [];
        const map = new Map();
        for (const x of state.processedFloors) { const f = markFloor(x); if (Number.isFinite(f)) map.set(f, x); }
        for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) map.set(i, { f: i, h: hashFloorText(i) });
        state.processedFloors = Array.from(map.values()).slice(-5000);
        state.processedVer = processedVerTag();
        const endN = Number(end) || 0;
        if (endN > (Number(state.lastKnownFloor) || -1)) state.lastKnownFloor = endN;
        saveState();
        return { ok: true, count: state.processedFloors.length };
    } catch (e) { warn('已处理楼层记录失败', e); return { ok: false }; }
}

// ============================================================
// v2.64.0「未摘要楼层跳过机制」（用户报告：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，
//   请核对跳过机制。当**原子数据对应的楼层存在时，则不需要分析**。」）
// 清单前的**台账维护**与**跳过判据**（顺序与 V1 `pendingFloorList` 一致，逐条对齐后补一条 V2 新规则）：
//   ① `migrateProcessedFloorsV170()`：升级期旧标记按当前取文口径重算（幂等），避免升级后成片变回未摘要；
//   ② `processedDriftGuard(false)`：**必须先于归位对账** —— 取文口径整体漂移时按当前算法刷新全部标记
//      （保留「已处理」语义），否则对账会把「哈希对不上的标记」当内容变更全部丢弃；
//   ③ `reconcileProcessedFloors(false)`（20s 节流）：其他插件增删/隐藏楼层造成的索引错位 → 按哈希归位；
//   ④ 逐楼跳过：非 AI 楼 / 隐藏楼 / 无可分析正文（占位楼、被投喂白黑名单过滤）/ 台账已处理 /
//      **该楼已有记忆数据（v2.64.0 新增，见 `core/floor-cover.js`）**。
// ============================================================
const RECONCILE_MS = 20000;
let lastReconcileTs = 0;
const DRIFT_MS = 20000;
let lastDriftTs = 0;

/**
 * 哈希漂移防呆（V1 v1.174 `processedDriftGuard` 逐条移植）：
 *   已存标记里**过半**与当前哈希对不上、且基数 ≥10 时，判定为「取文口径漂移」（宿主/插件更新、取文方式变化、
 *   swipes 不再返回…），一次性按当前算法刷新全部标记 —— 而不是把历史已分析楼层整体抛成「未摘要」。
 *   少量失配（<50%）仍按「内容真的被改写」处理，只列真正变化的那几楼。
 * @param {boolean} [notify] 是否提示用户（清单路径传 false）
 * @param {boolean} [force] 跳过 20s 节流
 */
export function processedDriftGuard(notify, force) {
    try {
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        if (pf.length < 10) return { skipped: 'too-few' };
        const ready = chatReadyForFloors();
        if (!ready.ready) return { skipped: 'chat-not-ready' };      // v2.87.0：聊天未就绪 → 不判定漂移、不动台账
        const lastId = Number(getLastMessageId());
        if (!Number.isFinite(lastId) || lastId < 0 || lastId > 5000) return { skipped: 'no-chat-or-too-large' };
        const known = Number(state.lastKnownFloor);
        if (Number.isFinite(known) && known >= 0 && lastId < known - 5) return { skipped: 'floor-shrunk' };   // 真删楼 → 交给断裂检测
        const now = Date.now();
        // 节流：完整判定要逐楼算哈希。节流期内先用**抽样**兜底 —— 末尾 5 个标记全部失配即认定漂移，立刻升级为完整判定
        if (!force && (now - lastDriftTs) < DRIFT_MS) {
            const sample = pf.slice(-5);
            let sChecked = 0, sMismatch = 0;
            for (const m of sample) {
                const f = Number(m && m.f);
                if (!Number.isFinite(f) || f < 0 || f > lastId) continue;
                const h = hashFloorText(f);
                if (!h) continue;
                sChecked++;
                if (String((m && m.h) || '') !== h) sMismatch++;
            }
            if (!(sChecked >= 3 && sMismatch === sChecked)) return { skipped: 'throttled' };
        }
        lastDriftTs = now;
        let checked = 0, mismatch = 0;
        for (const m of pf) {
            const f = Number(m && m.f);
            if (!Number.isFinite(f) || f < 0 || f > lastId) continue;
            const h = hashFloorText(f);
            if (!h) continue;                       // 楼层不存在 / 无正文 → 不计入漂移判定
            checked++;
            if (String((m && m.h) || '') !== h) mismatch++;
        }
        if (checked < 10) return { skipped: 'too-few-existing' };
        const ratio = mismatch / checked;
        if (ratio < 0.5) return { checked: checked, mismatch: mismatch, ratio: ratio, drifted: false };
        // 漂移 → 全量按当前算法刷新（楼层号不变 → 仍视为「已处理」，不重新分析）
        const out = [];
        let dropped = 0;
        for (const m of pf) {
            const f = Number(m && m.f);
            if (!Number.isFinite(f) || f < 0 || f > lastId) { dropped++; continue; }
            const h = hashFloorText(f);
            if (!h) { dropped++; continue; }
            out.push({ f: f, h: h });
        }
        state.processedFloors = out;
        state.processedVer = processedVerTag();
        state.lastKnownFloor = Math.max(Number.isFinite(known) ? known : -1, lastId);
        saveState();
        log('摘要', { action: '已处理楼层哈希漂移 → 全量刷新', before: pf.length, after: out.length, dropped: dropped, ratio: Number(ratio.toFixed(3)) });
        return { drifted: true, before: pf.length, after: out.length, dropped: dropped, ratio: ratio };
    } catch (e) { warn('已处理楼层漂移防呆失败', e); return { skipped: 'error' }; }
}

/**
 * 已处理楼层哈希归位对账（V1 v1.70/v1.174 `reconcileProcessedFloors` 逐条移植）：
 *   其他插件增删/隐藏楼层导致索引错位时，按「当前内容哈希 ∈ 历史已处理哈希集」把标记归位到新索引
 *   （内容未变只挪位置 → 保持已处理，不再冒出）。
 *   大批量失配（≥50% 且基数 ≥10）**不删标记** —— 交给 `processedDriftGuard` 按当前口径整体刷新。
 */
export function reconcileProcessedFloors(notify) {
    try {
        const pf = state.processedFloors || [];
        if (!pf.length) return { kept: 0, dropped: 0 };
        // v2.87.0：聊天未就绪 → 不归位、不丢标记（**先于**版本判定，保证重启期的原因一致可诊断）
        const ready = chatReadyForFloors();
        if (!ready.ready) return { kept: pf.length, skipped: 'chat-not-ready' };
        if ((state.processedVer || '') !== processedVerTag()) return { skipped: 'pre-upgrade' };   // 升级期由 isFloorProcessed 逐楼刷新
        const lastId = Number(getLastMessageId());
        if (!Number.isFinite(lastId) || lastId < 0 || lastId > 5000) return { skipped: 'no-chat-or-too-large' };
        const oldHashes = new Set();
        for (const m of pf) { const h = m && m.h; if (h) oldHashes.add(h); }
        if (!oldHashes.size) return { kept: 0, dropped: 0 };
        const keep = [];
        for (let f = 0; f <= lastId; f++) {
            const h = hashFloorText(f);
            if (h && oldHashes.has(h)) keep.push({ f: f, h: h });
        }
        const before = pf.length;
        const dropped = before - keep.length;
        if (before >= 10 && dropped / before >= 0.5) {
            log('摘要', { action: '已处理楼层对账跳过（整体失配）', before: before, wouldDrop: dropped });
            return { kept: before, dropped: 0, skipped: 'mass-mismatch' };
        }
        // v2.64.0（V1 缺陷修复）：V1 只在 `dropped !== 0` 时写回 —— 于是「条数不变、只是楼层号整体挪位」
        //   （顶部插入一条新消息，其余内容整体后移）时**归位结果被丢弃**：标记仍指向旧楼层号，
        //   表现为旧楼层继续「已处理」、新位置反而被列为未摘要（用户报告「不应该分析的会被展示出来」）。
        //   现在只要归位结果与现有标记不同就写回（内容未变的楼仍是已处理，只是落到正确楼层号）。
        const relocated = keep.length !== before || keep.some((x, i) => markFloor(pf[i]) !== x.f);
        if (dropped !== 0 || relocated) {
            state.processedFloors = keep;
            if (keep.length) {
                const maxF = Math.max.apply(null, keep.map((x) => x.f));
                state.lastKnownFloor = Math.max(Number(state.lastKnownFloor) || -1, maxF);
            }
            saveState();
            log('摘要', { action: '已处理楼层对账（哈希归位）', before: before, kept: keep.length, dropped: dropped, relocated: relocated });
            if (notify && dropped > 0) log('摘要', { action: '已处理楼层对账完成', dropped: dropped });
        }
        return { kept: keep.length, dropped: dropped, relocated: relocated };
    } catch (e) { warn('已处理楼层对账失败', e); return { dropped: -1 }; }
}

/**
 * v2.93.0（`docs/D12` v0.2 裁决）——**楼层收缩处理**（补上 V1 遗留但缺失的「断裂检测」）。
 * 背景：用户会**主动删楼**以减小聊天体积（酒馆对高楼层支持差）→ 这是**常态**操作，必须低噪声且**不丢数据**。
 * 口径（逐条对应 D12）：
 *   · 判据（Q2）：`getLastMessageId() < lastKnownFloor - 容忍` 且**聊天已就绪**（复用 `chatReadyForFloors`）；
 *   · 台账（Q3）：**强制跑一次哈希归位**（绕过 20s 节流与 `mass-mismatch` 守卫 —— 此时整体失配是**预期**）；
 *   · 编号（Q1）：条目的 `floorStart/floorEnd` 与分段总结 `start/end` 若已超过当前末楼 → **只改编号**：
 *     置「未知区间」(`0/0`) 并打 `floorStale: true`（**绝不删除条目**）；
 *   · 基线（Q9）：`lastKnownFloor` **收紧**为当前末楼；
 *   · 低噪声（D12 §8-A）：登记一条**按类型合并计数**的人工确认项 + 调试日志；
 *   · 幂等：无收缩、或聊天未就绪 → 直接返回（不动作）。
 * @param {{force?:boolean, silent?:boolean}} [opts]
 * @returns {{ok:boolean, skipped?:string, removedFloors?:number, staleEntries?:number, dims?:object, marks?:number, lastId?:number}}
 */
export function handleFloorShrink(opts) {
    const o = opts || {};
    try {
        const ready = chatReadyForFloors();
        if (!ready.ready) return { ok: true, skipped: 'chat-not-ready' };
        const total = ready.total;
        const lastId = total - 1;
        const known = Number(state.lastKnownFloor);
        const TOL = 5;
        const shrunk = Number.isFinite(known) && known >= 0 && lastId < known - TOL;
        if (!shrunk && !o.force) return { ok: true, skipped: 'no-shrink', lastId: lastId };
        // ① 台账：强制哈希归位（收缩时整体失配属预期，故绕过 mass-mismatch 守卫）
        let marks = 0;
        try {
            const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
            const keep = [];
            for (let f = 0; f <= lastId; f++) {
                const h = hashFloorText(f);
                if (!h) continue;
                if (pf.some((x) => String((x && x.h) || '') === h)) keep.push({ f: f, h: h });
            }
            state.processedFloors = keep;
            state.processedVer = processedVerTag();
            marks = keep.length;
        } catch (e) { /* 归位失败不阻塞后续 */ }
        // ② 编号重映射：超出当前末楼的区间 → 未知区间 + floorStale（只改编号，不删条目）
        const dims = {};
        let staleEntries = 0;
        const fix = (dim, arr, fields) => {
            let n = 0;
            for (const it of (Array.isArray(arr) ? arr : [])) {
                if (!it || typeof it !== 'object') continue;
                const a = Number(it[fields[0]]), b = Number(it[fields[1]]);
                const bad = (Number.isFinite(a) && a > lastId && a > 0) || (Number.isFinite(b) && b > lastId && b > 0);
                if (!bad) continue;
                try { it[fields[0]] = 0; it[fields[1]] = 0; it.floorStale = true; n++; } catch (e) { /* 单项失败不影响其余 */ }
            }
            if (n) { dims[dim] = n; staleEntries += n; }
            return n;
        };
        for (const d of DIMENSIONS) fix(d.kind, state[d.kind], ['floorStart', 'floorEnd']);
        try { for (const x of (state.currentStates || [])) { const fe = Number(x && x.floorEnd); if (Number.isFinite(fe) && fe > lastId && fe > 0) { x.floorStart = 0; x.floorEnd = 0; x.floorStale = true; staleEntries++; dims.currentStates = (dims.currentStates || 0) + 1; } } } catch (e) { /* 忽略 */ }
        try { fix('plotSegments', (state.plotSegments || []).map((g) => Object.assign(g, { start: g.start, end: g.end })), ['start', 'end']); } catch (e) { /* 忽略 */ }
        // ③ 基线收紧（Q9）
        try { state.lastKnownFloor = lastId; state.floorShrinkAt = Date.now(); } catch (e) { /* 忽略 */ }
        const removedFloors = Math.max(0, (Number.isFinite(known) ? known : lastId) - lastId);
        // ④ 低噪声记账：合并计数 + 调试日志（D12 §8-A：常态操作，不刷屏）
        try {
            if (typeof onFloorShrink === 'function') onFloorShrink({ removedFloors: removedFloors, staleEntries: staleEntries, marks: marks, lastId: lastId });
        } catch (e) { /* 忽略 */ }
        try { log('楼层', { action: '楼层收缩处理', removedFloors: removedFloors, lastId: lastId, staleEntries: staleEntries, marks: marks }); } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }
        return { ok: true, removedFloors: removedFloors, staleEntries: staleEntries, dims: dims, marks: marks, lastId: lastId };
    } catch (e) {
        try { warn('楼层收缩处理失败', e); } catch (e2) { /* 忽略 */ }
        return { ok: false, skipped: 'error' };
    }
}
/** 收缩回调（宿主注入；用于登记人工确认项 —— 内核不直接依赖 UI/冲突模块） */
let onFloorShrink = null;
export function setFloorShrinkHook(fn) { onFloorShrink = (typeof fn === 'function') ? fn : null; return true; }

/**
 * 未摘要楼层扫描（清单 + 跳过计数，供界面/诊断/命令共用；执行侧与列表**同源**，V1 v1.174 纪律）。
 * 跳过项：非 AI 楼（含用户楼）/ 隐藏楼 / 无可分析正文（占位楼、投喂白黑名单过滤）/ 台账已处理 /
 *   已有记忆数据（`covered`）。
 * @param {object} [opts] startFloor / endFloor / limit / maintain=false 关闭台账维护 / ignoreCovered=true 关闭覆盖跳过
 * @returns {{floors:number[], startFloor:number, endFloor:number, lastId:number, lastIdStale:boolean, covered:number, skipped:object}}
 */
export function scanPendingFloors(opts) {
    const o = opts || {};
    const ctx = getCtx();
    const total = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
    const lastId = Number(getLastMessageId());
    // end = **实时聊天末尾**（= V1 宿主 `getLastMessageId()` 的活值，它也是 `chat.length - 1`）。
    //   注意：V2 内核里的 `getLastMessageId()` 是**聊天同步时的快照**（`host/chat.js` 在载入/事件时刷新），
    //   新楼刚 push 进来、宿主尚未同步时它会偏小；据此砍掉区间会漏掉新楼 → 自动提取永远追不上新楼。
    //   故这里只把它当**诊断**信息（`lastId` / `lastIdStale`），区间一律按实时聊天长度取。
    const tail = total - 1;
    const end = Number.isFinite(Number(o.endFloor)) ? Number(o.endFloor) : tail;
    const lastIdStale = Number.isFinite(lastId) && lastId >= 0 && lastId !== tail;
    const startFloor = Math.max(0, Number(o.startFloor) || 0);
    const skipped = { user: 0, hidden: 0, missing: 0, noText: 0, processed: 0, covered: 0, chatNotReady: 0 };
    const out = [];
    try {
        // v2.87.0：聊天未就绪（插件刚启动 / 更新后尚未同步）→ **不做任何台账维护**，并如实标记，避免误判大批楼层。
        const ready = chatReadyForFloors();
        if (!ready.ready) {
            skipped.chatNotReady = 1;
            return { floors: [], startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: 0, skipped: skipped, chatReady: false, chatReason: ready.reason };
        }
        if (o.maintain !== false) {
            // v2.93.0（`docs/D12`）：**先处理楼层骤减**（用户会主动删楼减体积）—— 幂等，无收缩即短路返回
            try { handleFloorShrink(); } catch (e) { /* 忽略 */ }
            try { migrateProcessedFloorsV170(); } catch (e) { /* 忽略 */ }
            try { processedDriftGuard(false); } catch (e) { /* 忽略 */ }
            const now = Date.now();
            if (now - lastReconcileTs > RECONCILE_MS) { lastReconcileTs = now; try { reconcileProcessedFloors(false); } catch (e) { /* 忽略 */ } }
        }
        const cov = floorCoverage(state);
        const skipCovered = (o.ignoreCovered !== true);
        for (let i = startFloor; i <= end; i++) {
            const m = floorMessage(i);
            if (!m) { skipped.missing++; continue; }
            if (m.is_hidden) { skipped.hidden++; continue; }
            if (m.is_user) { skipped.user++; continue; }
            if (!floorAnalyzableText(i)) { skipped.noText++; continue; }
            // 台账优先（V1 语义）：① 在册且哈希一致 → 已处理，跳过；
            //   ② **在册但哈希不符 = 该楼正文被改写过** → 必须重新分析（此时「已有记忆数据」不构成跳过理由，
            //      否则编辑过的楼层会被旧数据永久压住）；③ 不在册（台账缺失/迁移丢失/导入未带）才用覆盖判据兜底。
            const mark = processedMarkOf(i);
            if (mark && isFloorProcessed(i)) { skipped.processed++; continue; }
            const contentChanged = !!mark;
            if (!contentChanged && skipCovered && cov.has(i)) { skipped.covered++; continue; }   // v2.64.0：该楼已有记忆数据，无需分析
            out.push(i);
        }
        return { floors: out, startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: cov.floors, skipped: skipped };
    } catch (e) { /* 忽略 */ }
    return { floors: out, startFloor: startFloor, endFloor: end, lastId: Number.isFinite(lastId) ? lastId : -1, lastIdStale: lastIdStale, covered: 0, skipped: skipped };
}

/**
 * 未分析楼层清单（`scanPendingFloors().floors` 的薄封装；`opts.limit` 保留 V1 语义）。
 * @returns {number[]}
 */
export function listUnprocessedFloors(opts) {
    const o = opts || {};
    const scan = scanPendingFloors(o);
    if (Number(o.limit) > 0) return scan.floors.slice(0, Number(o.limit));
    return scan.floors;
}

/**
 * 清除「已处理楼层」台账（V1 `clearFloors`）：清空数组 + 复位 `lastKnownFloor` + 落盘。
 * 只清「哪些楼层已分析」的记账，**不删除任何记忆条目**（V1 同口径）。
 */
export function clearProcessedFloors() {
    try {
        const before = (state.processedFloors || []).length;
        state.processedFloors = [];
        state.lastKnownFloor = -1;
        state.processedVer = processedVerTag();
        saveState();
        return { ok: true, cleared: before };
    } catch (e) { return { ok: false, cleared: 0 }; }
}

/**
 * v3.0.16（用户报告「使用内置删除楼层后，无法衔接继续分析，新增正文无法分析」）——**活值**末楼号。
 *
 * 背景：内核的 `getLastMessageId()` 是**聊天同步时的快照**（`host/chat.js#wireKernelChatHooks` 在
 * 「载入 / 生成结束 / 消息渲染 / 切聊天」时刷新）。内置删楼走官方 `deleteMessage()`（只发 `MESSAGE_DELETED`，
 * 我们未订阅该事件）→ 删完那一刻快照**仍是被删前的旧值**（例如聊天只剩 10 楼而快照还是 199）。
 * 凡是用快照算**区间**的地方（最典型：`runAutoSummary` 的 `effLast`）就会扫到已不存在的楼层 →
 * 全是 `missing` → 「本次没有可分析楼层」→ 用户看到的就是「删楼后新正文无法分析」。
 *
 * 本函数按宿主**活值**取末楼号（优先级：宿主 `getContext().getLastMessageId()` → `chat.length - 1`
 * → 内核快照兜底），供所有「算区间」的宿主侧调用点使用；内核快照仍用于诊断与 V1 对齐。
 * @returns {number} 末楼号（无聊天 → -1）
 */
export function liveLastFloorId() {
    try {
        const ctx = getCtx();
        const fc = (ctx && typeof ctx.getLastMessageId === 'function') ? Number(ctx.getLastMessageId()) : NaN;
        if (Number.isFinite(fc) && fc >= 0) return Math.floor(fc);
        const total = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
        if (total > 0) return total - 1;
    } catch (e) { /* 落回内核快照 */ }
    try { const snap = Number(getLastMessageId()); return Number.isFinite(snap) ? snap : -1; } catch (e) { return -1; }
}

/** 台账统计（诊断用） */
export function processedStats() {
    try {
        return { ver: state.processedVer || '', tag: processedVerTag(), marks: (state.processedFloors || []).length, lastKnownFloor: Number(state.lastKnownFloor) || -1 };
    } catch (e) { return { ver: '', tag: processedVerTag(), marks: 0, lastKnownFloor: -1 }; }
}
