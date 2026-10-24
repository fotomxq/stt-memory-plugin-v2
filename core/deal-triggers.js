// ============================================================
// core/deal-triggers.js —— **长期收支触发器**（v3.51.0，`docs/D53` §3.9 · `docs/D22` W32 `数-46` / `技-59`）
//
// 用户 v1.1 第 4/5/7 条（原话）：
//   ④「长期收支是**孤立的存在**：建立 / 变更可经 AI，但**流水生成必须走固定代码**（用预测节点的数据），**不经 AI**」
//   ⑤「长期收支**自动生成流水**时，若**对应货币丢失 → 不生成**（留痕说明原因）」
//   ⑦「**剧情时间跳动**：在**总览自动分析之后**自动处置**长期收支触发器**；若跳动**猛烈**，按预测节点与**周期**
//      自动补齐下一个预测节点 —— **该内容不经过 AI**」
//
// 本模块**全程无 AI 调用**（`docs/D53` §3.9）：只做日期数学 + 写 `ledger` / `deals`。
//   · 判据（v3.51.5 用户要求「抵达剧情时间及之后日期自动触发」）：只要**剧情日期推进到/越过** `forecast.nextDate`
//     就兑现 —— **不再要求「跨度 ≥ 30 天」**（旧口径会让「只推进 1 天就到期」的条目永远不兑现）；回退/脏日期不处置；
//   · **叠加执行**（用户要求「超出多轮则自动叠加」）：兑现后按 `cycle` 推进水位，**直到**水位 > 当前剧情日期
//     或 `nextDate > endDate`（截止日期）为止；受 `cfg.dealCatchUpMax` 上限（超限置 `trigger.catchUpTruncated` 如实回报）；
//   · 货币丢失：**不生成**，写 `trigger.skippedReason='currency-missing'`，**不阻塞**其它标的物；
//   · `cycle` 缺失（推断不出）：**只做一笔**（无法确定性推进，不猜周期）；
//   · 幂等：以 `dealId + 节点日期` 去重（同一预测只兑现一次；重跑 / 多端都不重复）。
// ============================================================
import { cfg, dbgLog } from './model/runtime.js';
import { clockDateTrim, clockDateValid } from './clock.js';
import { bigDayNumber, bigDateFromDayNumber, bigYearStr } from './model/bigdate.js';
import { dealCycleDays, dealList, findDeal, inferForecastFallback, lastNodeDate, storyDayNumOf } from './model/deal.js';
import { applyLedgerEntry, findCurrency, ledgerOf } from './model/ledger.js';

/** 触发器阈值（可被配置覆盖；缺省按 `docs/D53` Q10 裁决：30 天 / 3 周期 / 24 节点） */
export function dealTriggerConf() {
    const num = (v, d, lo, hi) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
    };
    return {
        jumpMinDays: num(cfg && cfg.dealJumpMinDays, 30, 1, 3650),
        strongJumpCycles: num(cfg && cfg.dealStrongJumpCycles, 3, 1, 60),
        catchUpMax: num(cfg && cfg.dealCatchUpMax, 24, 1, 240),
    };
}

/** 剧情日序（整数；解析不了 → NaN）—— 复用既有数值时间轴 */
function dayNum(d) { return storyDayNumOf(d); }

/** 日期 + N 天（确定性；按整数日序加减，不涉时区） */
export function addStoryDays(dateStr, n) {
    try {
        const d0 = dayNum(dateStr);
        if (!Number.isFinite(d0)) return '';
        const p = bigDateFromDayNumber(d0 + Math.round(Number(n) || 0));
        if (!p) return '';
        return bigYearStr(p.y) + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
    } catch (e) { return ''; }
}

/** 剧情日期跨度（天数；任一不可解析 → NaN） */
function spanDays(from, to) {
    const a = dayNum(from), b = dayNum(to);
    return (Number.isFinite(a) && Number.isFinite(b)) ? (b - a) : NaN;
}

/** 跳动判定：`'jump'` 触发；`'backward'` / `'invalid'` / `''` 不触发 */
export function dealJumpKind(prevDate, curDate, conf) {
    const c = conf || dealTriggerConf();
    const p = clockDateTrim(prevDate), q = clockDateTrim(curDate);
    if (!p || !q || !clockDateValid(p) || !clockDateValid(q)) return 'invalid';
    const gap = spanDays(p, q);
    if (!Number.isFinite(gap)) return 'invalid';
    if (gap < 0) return 'backward';
    if (gap >= c.jumpMinDays) return 'jump';
    return '';
}

/**
 * **执行触发器**（确定性；**绝不调用 AI**；失败静默由调用方兜底）。
 * @param {{prevDate?:string, curDate?:string, now?:number}} [opts]
 * @returns {{ok:boolean, jump:string, fired:number, skipped:number, truncated:number, deals:number, noAi:boolean}}
 */
export function runDealTriggers(opts) {
    const out = { ok: true, jump: '', fired: 0, skipped: 0, truncated: 0, deals: 0, noAi: true };
    try {
        const o = opts || {};
        const conf = dealTriggerConf();
        const cur = clockDateTrim(o.curDate || '');
        if (!clockDateValid(cur)) return Object.assign(out, { ok: false, warning: 'no-story-date' });
        const prev = clockDateTrim(o.prevDate || '');
        const jump = dealJumpKind(prev, cur, conf);
        out.jump = jump;
        // v3.51.5：**回退不处置**（真跳到过去 → 不生成历史流水）；脏 prev 也不处置；prev 为空 = 首次运行 → 照常处置
        if (jump === 'backward') return out;
        if (jump === 'invalid' && prev) return Object.assign(out, { ok: false, warning: 'bad-prev-date' });
        const deals = dealList();
        out.deals = deals.length;
        const curDay = dayNum(cur);
        for (const d0 of deals) {
            if (!d0 || !d0.id) continue;
            const d = findDeal(d0.id) || d0;
            if (!findCurrency(String(d.currencyId || ''))) {
                // v1.1 第 5 条：锚定货币丢失 → 不生成，留痕，不阻塞其它标的物
                try { d.trigger = Object.assign({}, d.trigger || {}, { skippedReason: 'currency-missing' }); } catch (e) { /* 忽略 */ }
                out.skipped += 1;
                continue;
            }
            try { d.trigger = Object.assign({}, d.trigger || {}, { skippedReason: '' }); } catch (e) { /* 忽略 */ }
            const fc = (d.outlook && d.outlook.forecast) ? d.outlook.forecast : null;
            if (!fc || !clockDateValid(clockDateTrim(fc.nextDate))) continue;
            const cycleDays = Number(dealCycleDays(d.cycle)) || 0;
            const endDay = clockDateValid(clockDateTrim(d.endDate)) ? dayNum(clockDateTrim(d.endDate)) : null;
            // 已兑现节点集合（幂等：同一 `dealId + 节点日期` 只兑现一次）
            const fired = new Set(ledgerOf(d.currencyId).filter((x) => String(x.dealId || '') === String(d.id)).map((x) => String(x.date)));
            let nodeDate = clockDateTrim(fc.nextDate);
            let firedHere = 0;
            let guard = 0;
            let truncatedHere = false;
            while (nodeDate && clockDateValid(nodeDate) && dayNum(nodeDate) <= curDay) {
                if (guard++ > 10000) break;                    // 理论护栏（防死循环）
                if (endDay != null && dayNum(nodeDate) > endDay) { nodeDate = ''; break; }   // 越过截止日期 → 本条结束
                if (firedHere >= conf.catchUpMax) {            // 上限：如实标记，不静默丢弃
                    truncatedHere = true;
                    break;
                }
                if (fired.has(String(nodeDate))) {             // 已兑现 → 推进到下一节点（不重复记账、不占上限）
                    if (!cycleDays) { nodeDate = ''; break; }
                    nodeDate = addStoryDays(nodeDate, cycleDays);
                    continue;
                }
                const delta = Number(fc.delta) || 0;
                if (delta === 0) {                             // 无金额预测：只推进水位，不生成流水
                    try { d.outlook.nodes = (Array.isArray(d.outlook.nodes) ? d.outlook.nodes : []).concat([{ date: nodeDate, delta: 0, note: String(fc.note || '') }]); } catch (e) { /* 忽略 */ }
                    try { d.trigger.lastFiredNodeDate = nodeDate; d.trigger.lastFiredDate = cur; } catch (e) { /* 忽略 */ }
                } else {
                    const r = applyLedgerEntry({ currencyId: d.currencyId, owner: (findCurrency(d.currencyId) || {}).owner || '', date: nodeDate, delta: delta, note: (fc.note || ('长期收支兑现：' + d.name)), source: 'deal', dealId: d.id }, { now: Number(o.now) || Date.now() });
                    if (!r || r.ok !== true) { out.skipped += 1; break; }
                    out.fired += 1;
                    try { d.outlook.nodes = (Array.isArray(d.outlook.nodes) ? d.outlook.nodes : []).concat([{ date: nodeDate, delta: delta, note: String(fc.note || '') }]); } catch (e) { /* 忽略 */ }
                    try { d.trigger.lastFiredNodeDate = nodeDate; d.trigger.lastFiredDate = cur; } catch (e) { /* 忽略 */ }
                }
                firedHere += 1;
                fired.add(String(nodeDate));
                if (!cycleDays) { nodeDate = ''; break; }      // 缺周期 → 只做这一笔
                nodeDate = addStoryDays(nodeDate, cycleDays);   // **叠加执行**：继续推进，直到水位 > 当前剧情日期
            }
            try {
                d.lastChangeDate = lastNodeDate(d.outlook.nodes);
                /**
                 * 预测水位：还有下一节点且未越过截止日期 → 写回；
                 * v3.51.7（用户要求「轮动 1 轮后，根据周期推测到下一轮」+「兜底设计」）：
                 *   · 已兑现后**没有**下一节点（AI 没给 / 被截止清空）→ 用**趋势 + 周期**兜底补一个（`source:'auto'`）；
                 *   · 预测本来就是自动推算（`source:'auto'`）→ 兑现后用**新趋势**刷新金额（前几轮收益变化会影响下一轮）；
                 *   · 越过 `endDate` → 不兜底（本条已结束）。
                 */
                const nextOk = nodeDate && clockDateValid(nodeDate) && (endDay == null || dayNum(nodeDate) <= endDay);
                if (nextOk) {
                    const nextFc = Object.assign({}, fc, { nextDate: nodeDate });
                    if (String(fc.source || '') === 'auto') {
                        const fb = inferForecastFallback(d.outlook.nodes, d.cycle, d.startDate);
                        if (fb.nextDate && clockDateValid(fb.nextDate)) { nextFc.delta = fb.delta; nextFc.direction = fb.direction; nextFc.source = 'auto'; }
                    }
                    d.outlook.forecast = nextFc;
                } else {
                    const fb = inferForecastFallback(d.outlook.nodes, d.cycle, d.startDate);
                    const fbOk = fb.nextDate && clockDateValid(fb.nextDate) && (endDay == null || dayNum(fb.nextDate) <= endDay);
                    d.outlook.forecast = fbOk
                        ? Object.assign({}, fc, { nextDate: fb.nextDate, delta: fb.delta, direction: fb.direction, note: '', source: 'auto' })
                        : Object.assign({}, fc, { nextDate: '' });
                }
                d.trigger.catchUpTruncated = truncatedHere;
                if (truncatedHere) out.truncated += 1;
                d.updatedAt = Number(o.now) || Date.now();
            } catch (e) { /* 忽略 */ }
        }
        try { dbgLog('摘要', { action: '长期收支触发器（确定性·无 AI）', jump: jump, deals: out.deals, fired: out.fired, skipped: out.skipped, truncated: out.truncated }); } catch (e) { /* 忽略 */ }
    } catch (e) { out.ok = false; out.warning = String((e && e.message) || e); }
    return out;
}

/**
 * v3.51.0（`docs/D53` §3.9 · W32 `技-59`）：**触发器接线**（薄包装，依赖由调用方注入 → 单测不碰宿主）。
 *   · 取「解析前后剧情日期」判跳动（`jump` 才处置；`backward`/`invalid` 不兑现）；
 *   · 失败静默：**绝不**影响聊天、注入与保存。
 * @param {{prevDate?:string, curDate?:string, now?:number}} [opts]
 * @param {{getStoryNow:Function, saveStateNowQuiet:Function, runtime:object}} deps
 * @returns {Promise<object>}
 */
export async function dealTriggersAfterExtract(opts, deps) {
    try {
        const o = opts || {};
        const d = deps || {};
        const curDate = String(o.curDate || (d.getStoryNow ? d.getStoryNow() : '') || '');
        const prevDate = String(o.prevDate || (d.runtime && d.runtime.lastDealTriggerDate) || '');
        const r = runDealTriggers({ prevDate: prevDate, curDate: curDate, now: o.now });
        try { if (d.runtime) d.runtime.lastDealTriggerDate = curDate; } catch (e) { /* 忽略 */ }
        if (r && r.fired) { try { if (d.saveStateNowQuiet) void d.saveStateNowQuiet('deal-triggers'); } catch (e) { /* 忽略 */ } }
        return r;
    } catch (e) { return { ok: false, warning: String((e && e.message) || e) }; }
}
