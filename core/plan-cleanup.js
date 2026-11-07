// ============================================================
// core/plan-cleanup.js —— **计划 / 悬念「长期未推进」清理**（v3.52.10）
//
// 用户要求（原话）：「概览的自动修复功能，加入计划悬念的长期未推进清理流程。」
//
// 口径（零 AI、确定性、可复现；与 `core/plan-aging.js` 的分档同源）：
//   · 只处理 `status === 'open'` 的计划 / 悬念；已了结 / 已揭晓一律跳过；
//   · 年龄 = 条目自身剧情日期 → 当前剧情日期（`entryAgeDays`；无剧情时钟 → 整项跳过，不猜）；
//   · **长期未推进**（> `PLAN_AGING_STALE_DAYS` 天）→ **了结**（计划 `closed` / 悬念 `resolved`），
//     写 `statusNote` 与 `autoClosed: true` 留痕（**不删除**，遵守 `docs/D28` 不删数据纪律）；
//   · 「老化档」（30–120 天）**只计数、不动**（交用户或 AI 修复判断）。
//
// 设计口径变更（如实登记）：`docs/D20` §3.4 `数-12` 原定「**不自动了结**」（交用户一键闭环）；
//   本轮由用户**明确要求**把「长期未推进清理」并入概览自动修复 → 改为自动了结，但保持：
//   ① 只了结不删除；② 留 `autoClosed`/`statusNote` 可追溯；③ 可在设定 `repairAutoCloseStale=false` 关闭。
// ============================================================
import { state, cfg, saveState, dbgLog } from './model/runtime.js';
import { entryAgeDays, PLAN_AGING_FRESH_DAYS, PLAN_AGING_STALE_DAYS } from './plan-aging.js';

/** 单条是否可清理：仅 open 且年龄 > stale 天（无日期 → 不清理） */
function isStaleOpen(it, nowDate, staleDays) {
    if (!it || typeof it !== 'object') return false;
    if (String(it.status || 'open') !== 'open') return false;
    const days = entryAgeDays(it, nowDate);
    return Number.isFinite(days) && days > staleDays;
}

/**
 * 执行「长期未推进」清理（幂等；重复调用不会重复了结已了结条目）。
 * @param {{persist?:boolean, silent?:boolean}} [opts]
 * @returns {{ok:boolean, closedP:number, closedS:number, agingP:number, agingS:number, scannedP:number, scannedS:number, staleDays:number, nowDate:string, skipped:string, changed:boolean, note:string}}
 */
export function planSuspStaleCleanup(opts) {
    const o = opts || {};
    const out = {
        ok: true, closedP: 0, closedS: 0, agingP: 0, agingS: 0, scannedP: 0, scannedS: 0,
        staleDays: PLAN_AGING_STALE_DAYS, nowDate: '', skipped: '', changed: false, note: '',
    };
    try {
        if (cfg && cfg.repairAutoCloseStale === false) { out.skipped = 'disabled'; out.note = '计划/悬念老化清理：已关闭（设定 repairAutoCloseStale=false）'; return out; }
        const nowDate = String((state && state.date) || '').trim();
        out.nowDate = nowDate;
        if (!nowDate) { out.skipped = 'no-story-clock'; out.note = '计划/悬念老化清理：无剧情日期（无法按剧情时间判定老化）'; return out; }
        const staleDays = PLAN_AGING_STALE_DAYS, freshDays = PLAN_AGING_FRESH_DAYS;
        const mark = (it, dim) => {
            const days = entryAgeDays(it, nowDate);
            if (!Number.isFinite(days)) return;
            if (days > staleDays) {
                it.status = dim === 'plans' ? 'closed' : 'resolved';
                it.autoClosed = true;
                it.closedAt = nowDate;
                const why = '长期未推进（>' + staleDays + ' 剧情天：上次推动于 ' + String(it.date || '') + '），自动修复了结';
                it.statusNote = it.statusNote ? (String(it.statusNote) + '；' + why) : why;
                out.changed = true;
                if (dim === 'plans') out.closedP += 1; else out.closedS += 1;
            } else if (days > freshDays) {
                if (dim === 'plans') out.agingP += 1; else out.agingS += 1;
            }
        };
        for (const it of (Array.isArray(state.plans) ? state.plans : [])) {
            if (!it || typeof it !== 'object' || String(it.status || 'open') !== 'open') continue;
            out.scannedP += 1;
            mark(it, 'plans');
        }
        for (const it of (Array.isArray(state.suspense) ? state.suspense : [])) {
            if (!it || typeof it !== 'object' || String(it.status || 'open') !== 'open') continue;
            out.scannedS += 1;
            mark(it, 'suspense');
        }
        if (out.changed) {
            try {
                state.stats = state.stats || {};
                state.stats.plansClosed = Number(state.stats.plansClosed || 0) + out.closedP;
                state.stats.suspenseResolved = Number(state.stats.suspenseResolved || 0) + out.closedS;
            } catch (e) { /* 忽略 */ }
            if (o.persist !== false) { try { saveState(); } catch (e) { /* 忽略 */ } }
            try { dbgLog('摘要', { action: '计划/悬念：长期未推进自动了结', closedP: out.closedP, closedS: out.closedS, agingP: out.agingP, agingS: out.agingS, nowDate: nowDate }); } catch (e) { /* 忽略 */ }
        }
        const bits = [];
        if (out.closedP) bits.push('了结计划 ' + out.closedP);
        if (out.closedS) bits.push('了结悬念 ' + out.closedS);
        if (out.agingP || out.agingS) bits.push('另有老化档 ' + (out.agingP + out.agingS) + ' 条（仅提示）');
        out.note = '计划/悬念老化清理：' + (bits.length ? bits.join(' · ') : '无需清理');
        return out;
    } catch (e) {
        return Object.assign(out, { ok: false, skipped: 'error', note: '计划/悬念老化清理失败：' + String((e && e.message) || e) });
    }
}
