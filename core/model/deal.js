// ============================================================
// core/model/deal.js —— **长期收支（标的物）**（v3.51.0，`docs/D53` §3.4 · `docs/D22` W32 `数-44`）
//
// 用户要求（原话）：「**长期收支**，用于记录标的物的长期收支… 需记录**标的物名称、最初确定的日期、最后一次变动的日期、
//   截止日期、标的物现状、前景预判**。前景预判分为**三部分**：① 文字说明 ② 多个变动节点的记录
//   ③ 结合变动节点**预测下一个节点**可能发生的费用变动（数据）和变动可能的方向（增加或减少）。」
// v1.1 修订：②「长期收支新增**描述**（记录约定内容）」· ⑥「新增**锚定的货币**（必填），预测数据节点新增**对应的预测日期**」
//   · ⑦「剧情时间跳动时按预测节点与**周期**自动补齐」。
//
// 本模块口径（`docs/D53` §3.4 / §3.8）：
//   · `currencyId` **必填**（锚定货币；触发器用它生成流水，丢失则不生成）；
//   · `forecast.nextDate`：**AI 给了就以 AI 为准**；AI **留空**时按**前几轮收益趋势 + 周期**自动推算（`source:'auto'`，
//     v3.51.7 用户要求的「兜底设计」）—— 只有连「周期」都推断不出、又没有任何已发生节点时才拒绝（无法预测）；
//   · `outlook` 三段**分字段存放**（`text` / `nodes` / `forecast`），**禁止**把预测混进 `nodes`（「预测 ≠ 事实」护栏）；
//   · `lastChangeDate` 由 `outlook.nodes` 最大日期**自动维护**（界面只读）；
//   · `trigger` 由代码维护（`lastFiredDate` / `lastFiredNodeDate` / `catchUpTruncated` / `skippedReason`），**用户不可编辑**；
//   · `cycle` 缺省由 `nodes` 相邻间隔推断；推断不出 → 不自动补齐（只做"到期一笔"的普通处置）。
// ============================================================
import { state } from './runtime.js';
import { hashText, normText } from '../util.js';
import { clockDateTrim, storyDateMsFromStr } from '../clock.js';
import { BIG_DATE_FIELD_MAX } from './bigdate.js';
import { roundMoney } from './money.js';

/** 标的物类型（`other` 兜底） */
export const DEAL_KINDS = Object.freeze(['investment', 'royalty', 'loan', 'other']);
/** 周期取值域：`monthly` / `quarterly` / `yearly` / `weekly` / `custom:<天数>` */
export const DEAL_CYCLES = Object.freeze(['monthly', 'quarterly', 'yearly', 'weekly']);
/** 预测方向的冻结枚举（与 `delta` 符号不得矛盾；矛盾时以 `delta` 纠正） */
export const DEAL_DIRECTIONS = Object.freeze(['increase', 'decrease']);

/** 周期 → 天数（无法识别 → 0） */
export function dealCycleDays(cycle) {
    const s = String(cycle || '').trim().toLowerCase();
    if (!s) return 0;
    if (s === 'weekly') return 7;
    if (s === 'monthly') return 30;
    if (s === 'quarterly') return 90;
    if (s === 'yearly') return 365;
    const m = s.match(/^custom:(\d{1,5})$/);
    if (m) { const d = Number(m[1]); return Number.isFinite(d) && d > 0 ? d : 0; }
    return 0;
}
/** 规范化周期（非法 → 空串，交由 `nodes` 推断） */
export function normDealCycle(v) {
    const s = String(v || '').trim().toLowerCase();
    if (DEAL_CYCLES.indexOf(s) >= 0) return s;
    if (/^custom:\d{1,5}$/.test(s) && dealCycleDays(s) > 0) return s;
    return '';
}

/** 相邻节点间隔的众数 → 推断周期（推断不出 → 空串） */
export function inferCycleFromNodes(nodes) {
    try {
        const dates = (Array.isArray(nodes) ? nodes : []).map((n) => clockDateTrim(n && n.date)).filter(Boolean).sort();
        if (dates.length < 2) return '';
        const gaps = [];
        for (let i = 1; i < dates.length; i++) {
            const a = storyDayNumOf(dates[i - 1]), b = storyDayNumOf(dates[i]);
            const g = b - a;
            if (Number.isFinite(g) && g > 0) gaps.push(g);
        }
        if (!gaps.length) return '';
        const counts = {};
        for (const g of gaps) {
            const near = ['weekly', 'monthly', 'quarterly', 'yearly'].filter((k) => Math.abs(dealCycleDays(k) - g) <= 5)[0];
            const key = near || ('custom:' + Math.round(g));
            counts[key] = (counts[key] || 0) + 1;
        }
        const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
        return normDealCycle(best);
    } catch (e) { return ''; }
}
/** 日期 → 剧情日序（整数；解析不了 → NaN）—— 复用既有数值时间轴，不另造日期数学 */
export function storyDayNumOf(d) {
    try {
        const ms = storyDateMsFromStr(String(d || ''));
        return Number.isFinite(ms) ? Math.round(ms / 86400000) : NaN;
    } catch (e) { return NaN; }
}

/** 已发生节点的最后日期（`lastChangeDate` 自动维护源） */
export function lastNodeDate(nodes) {
    try {
        const ds = (Array.isArray(nodes) ? nodes : []).map((n) => clockDateTrim(n && n.date)).filter(Boolean).sort();
        return ds.length ? ds[ds.length - 1] : '';
    } catch (e) { return ''; }
}

/** 归一化一个预测节点（`nextDate` 必填） */
function normForecast(raw) {
    const f = (raw && typeof raw === 'object') ? raw : {};
    const nextDate = clockDateTrim(normText(f.nextDate !== undefined ? f.nextDate : (f['预测日期'] || f.date), BIG_DATE_FIELD_MAX));
    // v3.51.7：预测日期**可以留空**（由 `normalizeDeal` 用趋势兜底补上）；这里只做归一，不做必填拒绝
    let delta = roundMoney(Number(f.delta !== undefined ? f.delta : f['数额']));
    if (!Number.isFinite(delta)) delta = 0;
    const dirRaw = String(f.direction || f['方向'] || '').trim().toLowerCase();
    let direction = DEAL_DIRECTIONS.indexOf(dirRaw) >= 0 ? dirRaw : '';
    // 矛盾 → 以 delta 符号纠正并留痕（`docs/D53` §3.4）
    let corrected = false;
    if (delta !== 0) {
        const want = delta > 0 ? 'increase' : 'decrease';
        if (direction && direction !== want) { direction = want; corrected = true; }
        else if (!direction) direction = want;
    }
    return {
        nextDate: nextDate,
        delta: delta,
        direction: direction,
        note: normText(f.note !== undefined ? f.note : f['说明'], 80),
        source: (String(f.source || '') === 'manual') ? 'manual' : (String(f.source || '') === 'auto' ? 'auto' : 'ai'),
        corrected: corrected,
    };
}

/**
 * v3.51.7（用户要求「下一个预测阶段增加兜底设计」）：**趋势外推**——
 *   根据前几轮已发生节点的金额，判定「预计收益点 / 预计收益费用」：
 *   · 金额（delta）：取最近 ≤3 个节点的**线性趋势**（最小二乘斜率）外推一步；不足 2 个节点 → 取最后一个节点金额；
 *     全无节点 → 0（只给日期，金额未知）；
 *   · 日期（nextDate）：最后变动日期（无则起始日期）`+ cycleDays`；周期未知 → 空（无法横推）。
 * 纯函数、可复现，**不读 AI**。
 * @param {Array} nodes 已发生节点
 * @param {string} cycle 周期（weekly/monthly/quarterly/yearly/custom:N）
 * @param {string} startDate 起始日期（无节点时的基准）
 * @returns {{nextDate:string, delta:number, direction:string, note:string, source:string, basis:string}}
 */
export function inferForecastFallback(nodes, cycle, startDate) {
    const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && clockDateTrim(n.date));
    const last = list.length ? list[list.length - 1] : null;
    const base = last ? clockDateTrim(last.date) : clockDateTrim(startDate);
    const days = dealCycleDays(cycle);
    const nextDate = (base && days > 0) ? addDays(base, days) : '';
    // 线性趋势（最近 ≤3 个节点）：x = 0,1,2…；斜率 = Σ(x-x̄)(y-ȳ)/Σ(x-x̄)²；预测 = ȳ + 斜率·(n-1 处的下一步)
    let delta = 0;
    let basis = 'none';
    const ys = list.slice(-3).map((n) => roundMoney(Number(n.delta) || 0));
    if (ys.length === 1) { delta = ys[0]; basis = 'last'; }
    else if (ys.length >= 2) {
        const n = ys.length;
        const xm = (n - 1) / 2;
        const ym = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) * (i - xm); }
        const slope = den > 0 ? (num / den) : 0;
        delta = roundMoney(ym + slope * (n - xm));   // 下一节点（x = n）
        basis = 'trend';
    }
    const direction = delta > 0 ? 'increase' : (delta < 0 ? 'decrease' : 'increase');
    return { nextDate: nextDate, delta: delta, direction: direction, note: '', source: 'auto', basis: basis };
}

/** 日期 + N 天（本模块内的确定性实现，避免与触发器模块循环依赖） */
function addDays(dateStr, n) {
    try {
        const ms = storyDateMsFromStr(clockDateTrim(dateStr));
        if (!Number.isFinite(ms)) return '';
        const d = new Date(ms + Math.round(Number(n) || 0) * 86400000);
        const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
        return String(y) + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
    } catch (e) { return ''; }
}

/** 归一化标的物（`docs/D53` §3.4）；缺 `name` / `currencyId` → `null`；预测可留空（→ 兜底推算） */
export function normalizeDeal(e) {
    try {
        const src = (e && typeof e === 'object') ? e : {};
        const name = normText(src.name !== undefined ? src.name : src['名称'], 60);
        const currencyId = normText(src.currencyId !== undefined ? src.currencyId : (src['货币'] || src.currency), 60);
        if (!name) return null;
        if (!currencyId) return null;                             // v1.1 第 6 条：锚定货币必填
        const startDate = clockDateTrim(normText(src.startDate !== undefined ? src.startDate : src['最初确定的日期'], BIG_DATE_FIELD_MAX));
        if (!startDate) return null;
        const outlookRaw = (src.outlook && typeof src.outlook === 'object') ? src.outlook : {};
        const nodes = (Array.isArray(outlookRaw.nodes) ? outlookRaw.nodes : []).map((n) => {
            const x = (n && typeof n === 'object') ? n : {};
            const date = clockDateTrim(normText(x.date !== undefined ? x.date : x['日期'], BIG_DATE_FIELD_MAX));
            if (!date) return null;
            return {
                date: date,
                delta: Number.isFinite(Number(x.delta !== undefined ? x.delta : x['数额'])) ? roundMoney(Number(x.delta !== undefined ? x.delta : x['数额'])) : 0,
                note: normText(x.note !== undefined ? x.note : x['说明'], 80),
            };
        }).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const cycle = normDealCycle(src.cycle) || inferCycleFromNodes(nodes);
        const forecastRaw = normForecast(outlookRaw.forecast || src.forecast);
        /**
         * v3.51.7（用户要求「如果 AI 明确，则以 AI 为准；如果制空，则采用该设计」）：
         *   AI 给了完整预测 → **以 AI 为准**；预测日期留空 → 用**趋势 + 周期**兜底（`source:'auto'`）；
         *   兜底也推不出日期（周期未知且无节点/起始日期）→ **拒绝**（没有日期就没有意义，`D53` 原口径）。
         */
        const fallback = inferForecastFallback(nodes, cycle, startDate);
        const forecast = (forecastRaw && forecastRaw.nextDate)
            ? forecastRaw
            : (fallback.nextDate
                ? { nextDate: fallback.nextDate, delta: (forecastRaw && forecastRaw.delta) || fallback.delta, direction: '', note: (forecastRaw && forecastRaw.note) || '', source: 'auto', corrected: false }
                : null);
        if (!forecast) return null;
        if (!forecast.direction && forecast.delta !== 0) forecast.direction = forecast.delta > 0 ? 'increase' : 'decrease';
        if (forecast.direction === '' && forecast.delta === 0) forecast.direction = fallback.direction;
        const out = {
            id: String(src.id || ('deal_' + hashText(name + '|' + startDate))),
            name: name,
            desc: normText(src.desc !== undefined ? src.desc : (src['描述'] || src['约定']), 400),
            kind: DEAL_KINDS.indexOf(String(src.kind || '')) >= 0 ? String(src.kind) : 'other',
            startDate: startDate,
            lastChangeDate: lastNodeDate(nodes),
            endDate: clockDateTrim(normText(src.endDate !== undefined ? src.endDate : src['截止日期'], BIG_DATE_FIELD_MAX)),
            status: normText(src.status !== undefined ? src.status : src['现状'], 200),
            currencyId: currencyId,
            cycle: cycle,
            uses: Number(src.uses) || 0,
            floorStart: Number.isInteger(Number(src.floorStart)) && Number(src.floorStart) > 0 ? Number(src.floorStart) : 0,
            floorEnd: Number.isInteger(Number(src.floorEnd)) && Number(src.floorEnd) > 0 ? Number(src.floorEnd) : 0,
            updatedAt: Number(src.updatedAt) || 0,
            outlook: { text: normText(outlookRaw.text !== undefined ? outlookRaw.text : (src['前景预判'] || ''), 400), nodes: nodes, forecast: forecast },
        };
        // `trigger` 由代码维护（只读；不信任外部传入的任何运行态之外的字段）
        const t = (src.trigger && typeof src.trigger === 'object') ? src.trigger : {};
        out.trigger = {
            lastFiredDate: clockDateTrim(normText(t.lastFiredDate, BIG_DATE_FIELD_MAX)),
            lastFiredNodeDate: clockDateTrim(normText(t.lastFiredNodeDate, BIG_DATE_FIELD_MAX)),
            catchUpTruncated: t.catchUpTruncated === true,
            skippedReason: normText(t.skippedReason, 60),
        };
        return out;
    } catch (e) { return null; }
}

/** 当前标的物列表 */
export function dealList() {
    try { return Array.isArray(state.deals) ? state.deals : []; } catch (e) { return []; }
}
/** 找标的物 */
export function findDeal(id) {
    const key = String(id || '');
    return dealList().filter((d) => d && String(d.id) === key)[0] || null;
}
