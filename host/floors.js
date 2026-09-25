// ============================================================
// host/floors.js —— 楼层读取与「已分析楼层」台账（**逐字对齐 V1**，宿主层）
// 事实源：V1 `floorStableText` / `getAssistantText` / `collectFloorLinesInRange` / `floorAnalyzableText` /
//   `hashFloorText` / `isFloorProcessed` / `recordProcessedFloors`（src/modules/09-AI摘要与楼层处理.js）。
// 分工：**取文与判据在宿主层**（需要 ST 聊天与 TH 能力）；台账写在内核容器 `state.processedFloors`
//   （V1 同名字段，故 V1 存档可直接沿用「哪些楼层已分析」）。
// ============================================================
import { hashText } from '../core/util.js';
import { applyFeedRegex } from '../core/prompt.js';
import { state, cfg, saveState, log, warn } from '../core/model/runtime.js';
import { getCtx } from './st-api.js';
// v2.44.0（用户报告）：投喂/时钟/修复取文统一剔 HTML 标签；**楼层哈希仍用原始稳定正文**（`floorStableText`），
//   因此既有「已处理楼层」台账不会因本次清洗而整体失效（避免一次无谓的全量重提取）
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

/** 区间楼层原始行（V1 `collectFloorLinesInRange` 逐字：含 `[第N楼 角色]` 前缀、跳过隐藏楼） */
export function collectFloorLinesInRange(start, end, opts) {
    const floors = [];
    const aiOnly = !!(opts && opts.aiOnly);
    try {
        for (let i = Math.max(0, Number(start) || 0); i <= (Number(end) || 0); i++) {
            const m = floorMessage(i);
            if (!m || m.is_hidden) continue;
            if (aiOnly && (m.is_user || (m.role && m.role !== 'assistant'))) continue;
            const text = cleanText(assistantTextOf(m));   // v2.44.0：投喂文本剔除 HTML（`<br>` → 换行）
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

/** 投喂文本（V1 `buildFeedFloorText`）：最近 N 楼原始行 → 投喂正则过滤（时钟/修复类管线共用） */
export function buildFeedFloorText(maxFloors) {
    try { return applyFeedRegex(collectFloorLines(maxFloors).join('\n')); } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}
/** 指定结束楼层的投喂文本（V1 `buildFeedFloorTextRange`：摘要用于排除生成中的最近楼） */
export function buildFeedFloorTextRange(maxFloors, endFloor, opts) {
    try {
        const end = Number(endFloor);
        const validEnd = Number.isInteger(end) && end >= 0 ? end : Math.max(0, (getCtx() && Array.isArray(getCtx().chat) ? getCtx().chat.length : 1) - 1);
        const n = Math.max(1, Number(maxFloors) || 10);
        return applyFeedRegex(collectFloorLinesInRange(Math.max(0, validEnd - n + 1), validEnd, opts).join('\n'));
    } catch (e) { warn('楼层投喂构建失败', e); return ''; }
}

/** 可分析正文（V1 `floorAnalyzableText`）：投喂正则过滤 + 去占位楼 */
export function floorAnalyzableText(i) {
    try {
        const f = Number(i);
        if (!Number.isFinite(f) || f < 0) return '';
        const raw = String(applyFeedRegex(collectFloorLinesInRange(f, f).join('\n')) || '').trim();
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

/** 台账归位刷新（V1 v1.170/v1.174 口径：签名不符时把已知楼层按当前算法重算哈希） */
export function migrateProcessedFloorsV170() {
    try {
        const pf = Array.isArray(state.processedFloors) ? state.processedFloors : [];
        if (!pf.length) { state.processedVer = processedVerTag(); return { refreshed: 0 }; }
        let refreshed = 0;
        const next = [];
        for (const x of pf) {
            const f = markFloor(x);
            if (!Number.isFinite(f)) continue;
            const h = hashFloorText(f);
            if (!h) continue;                       // 楼层已不存在 → 丢弃该标记（V1 同口径）
            next.push({ f, h });
            refreshed++;
        }
        state.processedFloors = next.slice(-5000);
        state.processedVer = processedVerTag();
        return { refreshed };
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

/**
 * 未分析楼层清单（V1 同口径：跳过用户楼与隐藏楼、跳过占位楼；`endFloor` 默认最后一楼）。
 * @returns {number[]}
 */
export function listUnprocessedFloors(opts) {
    const o = opts || {};
    const ctx = getCtx();
    const total = (ctx && Array.isArray(ctx.chat)) ? ctx.chat.length : 0;
    const end = Number.isFinite(Number(o.endFloor)) ? Number(o.endFloor) : total - 1;
    const out = [];
    try {
        for (let i = Math.max(0, Number(o.startFloor) || 0); i <= end; i++) {
            const m = floorMessage(i);
            if (!m || m.is_hidden || m.is_user) continue;
            if (!floorAnalyzableText(i)) continue;
            if (isFloorProcessed(i)) continue;
            out.push(i);
        }
    } catch (e) { /* 忽略 */ }
    if (Number(o.limit) > 0) return out.slice(0, Number(o.limit));
    return out;
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

/** 台账统计（诊断用） */
export function processedStats() {
    try {
        return { ver: state.processedVer || '', tag: processedVerTag(), marks: (state.processedFloors || []).length, lastKnownFloor: Number(state.lastKnownFloor) || -1 };
    } catch (e) { return { ver: '', tag: processedVerTag(), marks: 0, lastKnownFloor: -1 }; }
}
