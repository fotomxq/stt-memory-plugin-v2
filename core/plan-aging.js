// ============================================================
// core/plan-aging.js —— **计划 / 悬念的老化分档与「长期 open」候选**（v3.44.0，`docs/D22` **W4** `数-12`）
//
// 设计依据：`docs/D20` §3.4 / §8 `数-12` ——
//   事实：「计划 / 悬念各 30 条**全为 open**，`stats.plansClosed = 0`、`suspenseResolved = 0` → 永不开环」；
//   步骤：① 提供一键闭环；② 加老化策略；③ 体检输出「长期 open」计数；
//   验收：「`stats.plansClosed` / `suspenseResolved` 可增长；体检计数可见」。
//
// 本模块只做**只读分档**（纯函数：`st` + `nowDate` 入参，不读全局时钟），把「哪些条目已经很久没动过」
//   变成**可判定、可复现**的清单；**真正闭环的动作在 `core/entries.js#closeEntry`**（用户点击 → 二次确认），
//   二者分工与本仓库既有口径一致（读侧只报告、写侧才改数据）。
//
// 「老化策略」的口径（诚实写明，与 `docs/D20` 的字面要求对齐方式）：
//   · **不自动删除、不自动了结** —— 本轮同时采纳了 `docs/D28` Q1「**不删数据**」的边界
//     （`docs/D22` §4.5 `数-25` 的前置裁决），自动了结一个仍然 open 的计划就是在替用户判定剧情；
//   · 老化 = **按「多久没被正文推动」分档**，把 `stale` 档交给用户一键了结（①的「一键闭环」）；
//     分档依据是**该条目自身的剧情日期**与**当前剧情日期**之差（与衰退口径同源：无剧情时钟则不老化）。
//
// 为什么按**条目自身日期**而不是 `updatedAt`（现实墙钟）：本仓库已把「衰退基准」统一为**剧情时间**
//   （`docs/D18` §4 / v3.41.0 `业-6`）——现实墙钟会随「用户什么时候打开插件」变化，同一份存档
//   在不同时间得到不同的老化结果，不可复现。
// ============================================================
import { clockDateParts, clockDateTrim } from './clock.js';

/** 老化档位阈值（剧情天数）：≤ `fresh` 天算新鲜；`fresh`~`aging` 之间算「缓慢」；> `aging` 天算「长期未推进」 */
export const PLAN_AGING_FRESH_DAYS = 30;
export const PLAN_AGING_STALE_DAYS = 120;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 剧情日期 → 近似天数序数（跨月按 30 天、跨年按 365 天；**只用于分档比较**，不用于展示） */
function dateOrdinal(s) {
    try {
        const p = clockDateParts(clockDateTrim(s));
        if (!p) return NaN;
        return p.y * 365 + (p.m - 1) * 30 + (p.d - 1);
    } catch (e) { return NaN; }
}

/**
 * 两个剧情日期相差的**近似天数**（同日 = 0；`to` 早于 `from` → 0；任一不可解析 → `NaN`）。
 * 「未来日期」不产生负年龄：对老化而言它等价于「刚出现」，取 0 比取负数更不容易误判。
 */
export function storyDayGap(from, to) {
    const a = dateOrdinal(from), b = dateOrdinal(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    return Math.max(0, b - a);
}

/**
 * 单条计划/悬念的年龄（剧情天数）。
 * 时刻取 `date`（条目自身的剧情日期）；**无日期或无剧情时钟 → `NaN`（不老化）**。
 */
export function entryAgeDays(it, nowDate) {
    const d = String((isObj(it) && (it.date || it.createdTime)) || '');
    return storyDayGap(d, nowDate);
}

/** 档位：`fresh` / `aging` / `stale` / `unknown`（无法判定 = 不老化） */
export function agingBucketOf(days) {
    if (!Number.isFinite(days)) return 'unknown';
    if (days <= PLAN_AGING_FRESH_DAYS) return 'fresh';
    if (days <= PLAN_AGING_STALE_DAYS) return 'aging';
    return 'stale';
}

/**
 * 老化报告（只读；`数-12` ②③ 的共用判据）。
 * @param {object} st 存档
 * @param {string} nowDate 当前**剧情日期**（`YYYY-MM-DD`；空 → 全部 `unknown`，不老化）
 * @param {{freshDays?:number, staleDays?:number, maxSamples?:number}} [opts]
 * @returns {{nowDate:string, dims:object, candidates:Array, total:number, byBucket:object}}
 */
export function planAgingReport(st, nowDate, opts) {
    const o = opts || {};
    const fresh = Number.isFinite(Number(o.freshDays)) ? Number(o.freshDays) : PLAN_AGING_FRESH_DAYS;
    const stale = Number.isFinite(Number(o.staleDays)) ? Number(o.staleDays) : PLAN_AGING_STALE_DAYS;
    const maxSamples = Math.max(0, Number(o.maxSamples) || 50);
    const out = { nowDate: String(nowDate || ''), dims: {}, candidates: [], total: 0, byBucket: { fresh: 0, aging: 0, stale: 0, unknown: 0 } };
    try {
        const s = isObj(st) ? st : {};
        for (const dim of ['plans', 'suspense']) {
            const arr = Array.isArray(s[dim]) ? s[dim] : [];
            const dimStat = { open: 0, stale: 0, aging: 0, fresh: 0, unknown: 0 };
            for (const it of arr) {
                if (!isObj(it)) continue;
                if (String(it.status || 'open') === 'closed') continue;   // 已了结的不在老化面内
                dimStat.open++;
                const days = entryAgeDays(it, out.nowDate);
                const b = (Number.isFinite(days) && days > stale) ? 'stale'
                    : (Number.isFinite(days) && days > fresh) ? 'aging'
                        : (Number.isFinite(days) ? 'fresh' : 'unknown');
                out.byBucket[b]++;
                if (b === 'stale') dimStat.stale++; else if (b === 'aging') dimStat.aging++; else if (b === 'fresh') dimStat.fresh++; else dimStat.unknown++;
                if (b === 'stale' || b === 'aging') {
                    out.total++;
                    if (out.candidates.length < maxSamples) {
                        out.candidates.push({
                            dim: dim, id: String(it.id || ''), bucket: b,
                            days: Number.isFinite(days) ? days : null,
                            label: String(it.title || it.content || '').slice(0, 30),
                        });
                    }
                }
            }
            out.dims[dim] = dimStat;
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 一键闭环的**定位文本**生成（`core/entries.js#closeEntry` 的既有匹配口径：id / 内容精确 / 双向包含）。
 * 返回该条目在「了结」列表里最容易命中的写法 —— 有标题用标题，否则用正文前 40 字。
 * （纯函数：只生成文本，不改数据；真正的了结在写侧。）
 */
export function closeKeyOf(it) {
    try {
        const t = String((isObj(it) && (it.title || it.subject)) || '').trim();
        if (t) return t;
        return String((isObj(it) && it.content) || '').trim().slice(0, 40);
    } catch (e) { return ''; }
}
