// ============================================================
// core/clock-patrol.js —— **剧情时钟域**（B8-1，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① 手工强制改写锚点（v1.186）：`clockManualRaw` / `clockManualState` / `parseClockManualInput` /
//      `setClockManual` / `clearClockManual`（存 `state.state.clockManual`，随存档跨端同步；`cfg.clockManualLock` 默认锁定）；
//   ② 可信时间锚点（v1.187）：`clockPatrolMajority`（原子数据年份多数派）→ `clockPatrolAnchorInfo`
//      （手工 > 当前剧情时钟 > 多数派 > 一致性年份；不确定时 `usable=false`，宁可不修）；
//   ③ 零 AI 时间巡检（v1.184~v1.193）：`clockPatrolSafeDate`（唯一写回闸门）/ `clockPatrolScan`（扫描异常）/
//      `clockPatrolRepairItem`（按内容重解析 → 保留月日换年份 → 仅「格式非法」才清空）/
//      `runClockPatrolRepair`（写回前先建**全量快照**，可回滚；自动路径默认只统计）。
// 适配（与 V1 的差别）：纯内核化 —— V1 直接读写全局 `state`/`cfg` 并调用 `snapshotCreateFull`/`saveState`/`notify`，
//   V2 一律经注入视图（`state`/`cfg`/`saveState`/`notifyHooks`）与内核快照模块，UI 重绘由调用方负责。
// 一致性由 tests/unit/clock-patrol-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, getLastMessageId } from './model/runtime.js';
import {
    clockDateValid, clockDateTrim, clockYearOf, clockYearStr, clockDateAnomaly, clockParseDateText,
    clockReplaceYear, clockNormTime,
} from './clock.js';
import { latestPlotByFloor } from './recall.js';
// v2.44.0（用户报告）：手工录入同样可能粘进 HTML（如「码头仓库<br>」）→ 统一清洗后再解析
import { cleanValue, hasHtmlTag, htmlStats } from './html-text.js';
import { snapshotCreateFull } from './snapshots.js';
// v2.37.0「时钟取值追踪」：锚点从哪来（手工 > 当前时钟 > 多数派）、为什么可信、为什么只统计不修改
import {
    clockTraceStart, clockTraceChain, clockTracePick, clockTraceReject, clockTraceNote,
    clockTraceApplied, clockTraceFinish,
} from './clock-trace.js';

/** 巡检覆盖的维度（V1 `CLOCK_PATROL_DIMS`）与中文标签 */
const CLOCK_PATROL_DIMS = ['atoms', 'memories', 'plans', 'suspense', 'parallels'];
const CLOCK_DIM_LABEL = { atoms: '情节', memories: '记忆', plans: '计划', suspense: '悬念', parallels: '平行事件' };
const CLOCK_ANCHOR_SRC_LABEL = { manual: '手工改写', clock: '当前剧情时钟', plot: '最新情节', 'atoms-majority': '原子数据多数派' };

// ==================== 手工强制改写剧情日期 / 时间 / 地点（v1.186） ====================
/** 手工值（无有效值返回 null） */
function clockManualRaw() {
    try {
        const m = (state && state.state && state.state.clockManual) || null;
        if (!m || typeof m !== 'object') return null;
        const date = String(m.date || '').trim();
        const time = String(m.time || '').trim();
        const location = String(m.location || '').trim();
        if (!date && !time && !location) return null;
        return { date, time, location, at: Number(m.at) || 0 };
    } catch (e) { return null; }
}
/** 手工值 + 锁定态（`cfg.clockManualLock` 默认 true） */
function clockManualState() {
    const m = clockManualRaw();
    if (!m) return null;
    const lock = !(cfg && cfg.clockManualLock === false);
    return { date: m.date, time: m.time, location: m.location, at: m.at, lock };
}
/** 录入解析：日期 / 时间宽松解析（年份未知时只接受「库里可用年份」，绝不用现实年份兜底） */
function parseClockManualInput(input) {
    const o = input || {};
    const notes = [];
    // v2.44.0：三项先做 HTML 清洗（`码头仓库<br>` → `码头仓库`），并如实说明剔除了什么
    const rawAll = [o.date, o.time, o.location].map((x) => String(x == null ? '' : x)).join(' ');
    if (hasHtmlTag(rawAll)) {
        const cleaned = { date: cleanValue(o.date), time: cleanValue(o.time), location: cleanValue(o.location, 60) };
        const st = htmlStats(rawAll);
        notes.push('录入内容含 HTML 标签/实体，已自动剔除（标签 ' + (Number(st.tags) || 0) + ' 处'
            + (Number(st.entities) ? ('、实体 ' + st.entities + ' 处') : '') + '）'
            + (st.block && st.block.length ? ('，如 ' + st.block.join(' ')) : ''));
        o.date = cleaned.date; o.time = cleaned.time; o.location = cleaned.location;
    }
    const curDate = String((state.state && state.state.date) || '');
    const maj = clockPatrolMajority();
    const prevYear = clockDateValid(curDate) ? clockYearOf(curDate) : (maj && maj.year ? maj.year : '');
    let date = String(o.date == null ? '' : o.date).trim();
    if (date) {
        if (!clockDateValid(date)) {
            if (!prevYear) {
                notes.push(`日期「${date}」缺少年份，且当前剧情日期不可用 → 已忽略（请写完整年份，如 1919-11-29 或 公元1919年11月29日）`);
                date = '';
            } else {
                const parsed = clockParseDateText(date, prevYear);
                if (parsed) { notes.push(`日期「${date}」解析为 ${parsed}${/^\d{4}-\d{2}-\d{2}$/.test(String(o.date).trim()) ? '' : `（沿用年份 ${prevYear}）`}`); date = parsed; }
                else { notes.push(`日期「${date}」无法解析（需 年-月-日 / 公元…年…月…日）→ 已忽略`); date = ''; }
            }
        }
    }
    let time = String(o.time == null ? '' : o.time).trim();
    if (time) {
        const t = clockNormTime(time) || (/^(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)$/.test(time) ? time : '');
        if (t) { if (t !== time) notes.push(`时间「${time}」规范化为 ${t}`); time = t; }
        else { notes.push(`时间「${time}」无法识别（需 HH:MM 或时段词）→ 已忽略`); time = ''; }
    }
    const location = String(o.location == null ? '' : o.location).trim().slice(0, 60);
    return { ok: !!(date || time || location), date, time, location, notes };
}
/** 保存手工改写（同时写入当前剧情时钟与来源标记；默认锁定） */
function setClockManual(input) {
    try {
        const r = parseClockManualInput(input);
        if (!r.ok) return { ok: false, notes: r.notes.concat(['三项都为空 → 未写入（如需恢复自动请用「解锁」）']) };
        const lock = !(cfg && cfg.clockManualLock === false);
        state.state = state.state || {};
        state.state.clockManual = { date: r.date, time: r.time, location: r.location, at: Date.now() };
        if (r.date) state.state.date = r.date;
        if (r.time) state.state.time = r.time;
        if (r.location) state.state.location = r.location;
        try {
            state.state.clockSrc = Object.assign({}, state.state.clockSrc || {}, {
                date: 'manual', time: r.time ? 'manual' : '', location: r.location ? 'manual' : '',
                present: (state.state.clockSrc && state.state.clockSrc.present) || '',
                degraded: false, degradeReason: '', manual: true, manualLock: lock, at: getLastMessageId(),
            });
        } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }
        try { dbgLog('时钟', { action: '手工强制改写剧情时钟（v1.186）', date: r.date, time: r.time, location: r.location, lock, notes: r.notes }); } catch (e) { /* 忽略 */ }
        return { ok: true, date: r.date, time: r.time, location: r.location, lock, notes: r.notes };
    } catch (e) { return { ok: false, notes: [String((e && e.message) || e)] }; }
}
/** 解除手工锁定（恢复自动提取） */
function clearClockManual() {
    try {
        const had = !!clockManualRaw();
        if (state.state) {
            delete state.state.clockManual;
            try {
                const cs = state.state.clockSrc || {};
                delete cs.manual; delete cs.manualLock;
                if (cs.date === 'manual') cs.date = '';
                if (cs.time === 'manual') cs.time = '';
                if (cs.location === 'manual') cs.location = '';
            } catch (e) { /* 忽略 */ }
        }
        if (had) { try { saveState(); } catch (e) { /* 忽略 */ } }
        try { dbgLog('时钟', { action: '解除剧情时钟手工锁定（v1.186）' }); } catch (e) { /* 忽略 */ }
        return had;
    } catch (e) { return false; }
}

// ==================== 可信时间锚点（v1.187） ====================
/** 原子数据里「有效日期」的年份分布 → { year, count, share, total, latest, consensus, years } */
function clockPatrolMajority() {
    try {
        const dates = [];
        for (const dim of CLOCK_PATROL_DIMS) {
            for (const it of (state[dim] || [])) {
                const d = String((it && it.date) || '').trim();
                if (clockDateValid(d)) dates.push(clockDateTrim(d));
            }
        }
        if (!dates.length) return null;
        const cnt = {};
        for (const d of dates) { const yk = clockYearStr(clockYearOf(d)); cnt[yk] = (cnt[yk] || 0) + 1; }
        const year = Object.keys(cnt).sort((a, b) => (cnt[b] - cnt[a]) || (b > a ? 1 : -1))[0];
        const same = dates.filter(d => clockYearStr(clockYearOf(d)) === year).sort();
        // consensus = 全部有效日期年份完全一致（含只有 1 条的情形）；trusted = 多数派占比 ≥60% 且 ≥2 条
        const years = Object.keys(cnt);
        return {
            year, count: cnt[year], share: cnt[year] / dates.length, total: dates.length, latest: same[same.length - 1],
            consensus: years.length === 1, years,
        };
    } catch (e) { return null; }
}
/** 锚点择优：手工 > 当前剧情时钟 > 多数派 > 一致性年份；不确定 → usable=false（宁可不修） */
function clockPatrolAnchorInfo() {
    const out = { date: '', source: '', usable: false, conflict: null, ambiguous: false };
    try {
        const maj = clockPatrolMajority();
        const majTrusted = !!(maj && (maj.share >= 0.6 && maj.count >= 2));
        const consensus = !!(maj && maj.consensus);
        const plot = latestPlotByFloor();
        const plotDate = (plot && clockDateValid(plot.date)) ? clockDateTrim(plot.date) : '';
        const markConflict = (dateStr) => {
            if (majTrusted && maj.year !== clockYearStr(clockYearOf(dateStr))) out.conflict = { year: maj.year, count: maj.count, total: maj.total };
        };
        // ① 手工强制改写（用户显式设定 —— 最高可信；与库内多数年份冲突时记录 conflict，由调用方决定是否放行）
        const man = clockManualRaw();
        if (man && clockDateValid(man.date)) {
            out.date = clockDateTrim(man.date); out.source = 'manual'; out.usable = true;
            markConflict(out.date);
            return out;
        }
        // ② 当前剧情时钟（有效即用）
        const cur = String((state.state && state.state.date) || '').trim();
        if (clockDateValid(cur)) {
            out.date = clockDateTrim(cur); out.source = 'clock'; out.usable = true;
            markConflict(out.date);
            return out;
        }
        // ③ 多数派优先于「最新情节」（单条脏数据可能正好是最新情节，采信它会把整库年份带偏）
        if (majTrusted) {
            out.date = (plotDate && clockYearStr(clockYearOf(plotDate)) === maj.year) ? (plotDate > maj.latest ? plotDate : maj.latest) : maj.latest;
            out.source = 'atoms-majority'; out.usable = true;
            if (plotDate && clockYearStr(clockYearOf(plotDate)) !== maj.year) out.conflict = { year: maj.year, count: maj.count, total: maj.total, from: 'plot' };
            return out;
        }
        // ③b 无多数派：只有「全部有效日期年份一致」时才用该年份；否则视为不可信 → 只统计
        if (consensus) {
            out.date = maj.latest; out.source = 'atoms-majority'; out.usable = true;
            return out;
        }
        // ④ 彻底没有有效日期 → 不可信（不再用年份众数/现实年份兜底）
        out.ambiguous = !!maj;
        return out;
    } catch (e) { return out; }
}
/** 兼容旧调用（仅返回日期字符串） */
function clockPatrolAnchor() { return clockPatrolAnchorInfo().date; }
/** 写回前的唯一安全闸门：格式必须合法，且（有锚点时）不得触发年份异常 */
function clockPatrolSafeDate(val, anchor) {
    try {
        const v = String(val == null ? '' : val).trim();
        if (!clockDateValid(v)) return '';
        if (clockDateValid(anchor) && clockDateAnomaly(v, anchor).bad) return '';
        return v.slice(0, 10);
    } catch (e) { return ''; }
}

// ==================== 零 AI 巡检（v1.184~v1.193） ====================
/** 扫描各维度的 date/time 异常（不改数据） */
function clockPatrolScan(anchorInfo) {
    const info = anchorInfo || clockPatrolAnchorInfo();
    const out = { anchor: info.date, anchorSource: info.source, anchorUsable: info.usable, anchorConflict: info.conflict || null, scanned: 0, findings: [] };
    try {
        const anchor = out.anchor;
        for (const dim of CLOCK_PATROL_DIMS) {
            for (const it of (state[dim] || [])) {
                if (!it || typeof it !== 'object') continue;
                out.scanned++;
                const d = String(it.date || '').trim();
                if (d && !clockDateValid(d)) out.findings.push({ dim, id: it.id, field: 'date', value: d, reason: 'invalid', fixable: true });
                else if (d && anchor) {
                    const a = clockDateAnomaly(d, anchor);
                    if (a.bad && a.reason !== 'invalid') out.findings.push({ dim, id: it.id, field: 'date', value: d, reason: a.reason, years: a.years, fixable: true });
                }
                const t = String(it.time || '').trim();
                if (t && !clockNormTime(t)) out.findings.push({ dim, id: it.id, field: 'time', value: t, reason: 'time-invalid', fixable: true });
            }
        }
        return out;
    } catch (e) { return out; }
}
/** 单条修复：只在能确定安全值时改动，否则一律保留原值 */
function clockPatrolRepairItem(it, finding, anchor) {
    try {
        const anchorOk = clockDateValid(anchor);
        const text = [it.title, it.text, it.content, it.desc, it.note, it.causalLine].filter(Boolean).join(' ');
        if (finding.field === 'date') {
            // 没有可信锚点就**不解析**（旧版这里用现实当前年份兜底 → 写出 2026 之类的现实年份）
            if (!anchorOk) return { changed: false, note: '无可信锚点 → 保留原值' };
            const invalid = finding.reason === 'invalid';       // 格式非法 / 日期不存在
            // v2.50.0（用户报告「时间巡检修复会改错时钟数据」→ **V1 故障明确修正 #7**）：
            //   V1 对**所有**异常都先做「按内容重解析」——包括「格式合法但年份漂移(jump/backward)」的条目。
            //   于是一条日期本来正确的记录，只要**内容里顺带提到别的年份**（如「三年前的1916年」），
            //   就会被覆盖成内容里的那个日期（安全闸门只校验「不异常」，挡不住这种误覆盖）→ 改错时钟数据。
            //   本批收紧：**只有「格式非法/日期不存在」才允许按内容重解析**；
            //   「格式合法但年份漂移」只允许**保留月日、把年份改为锚点年**，改不动就保留原值。
            if (invalid) {
                const prevYear = clockYearOf(anchor);
                const parsed = clockParseDateText(text, prevYear);
                const safeParsed = clockPatrolSafeDate(parsed, anchor);
                if (safeParsed) { it.date = safeParsed; return { changed: true, note: `按内容重解析 → ${safeParsed}` }; }
            }
            // 保留月日、把年份改为锚点年（年份漂移类脏数据）
            if (clockDateValid(finding.value)) {
                const fixed = clockPatrolSafeDate(clockReplaceYear(finding.value, clockYearOf(anchor)), anchor);
                if (fixed) { it.date = fixed; return { changed: true, note: `年份校正（保留月日）→ ${fixed}` }; }
            }
            // 只有「格式非法/日期不存在」才允许清空；格式合法但年份漂移一律保留原值
            if (invalid && it.date) { it.date = ''; return { changed: true, note: '日期非法且无法重解析 → 清空' }; }
            return { changed: false, note: (invalid ? '无法可靠修正 → 保留原值' : '年份异常但无法可靠校正 → 保留原值（不按内容重解析）') };
        }
        if (finding.field === 'time') {
            const m = /(\d{1,2})[:：](\d{1,2})/.exec(text) || /(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)/.exec(text);
            const fixed = m ? clockNormTime(m[0]) : '';
            if (fixed) { it.time = fixed; return { changed: true, note: `时间重解析 → ${fixed}` }; }
            it.time = '';
            return { changed: true, note: '时间非法且无法重解析 → 清空' };
        }
        return { changed: false, note: '' };
    } catch (e) { return { changed: false, note: '' }; }
}
/**
 * 时间巡检与修复（零 AI）。
 * @param {object} [opts] silent（不提示）/ scanOnly（只统计）/ force（手动点击：允许「锚点与库内多数年份冲突」时按锚点校正）
 */
function runClockPatrolRepair(opts) {
    const o = opts || {};
    const info = clockPatrolAnchorInfo();
    // v2.37.0：锚点取值链追踪（「这个锚点是从哪来的、为什么可信、为什么不修改」）
    const trace = clockTraceStart('patrol', '时间巡检与修复（零 AI）');
    clockTraceChain(trace, '① 锚点择优：手工强制改写 > 当前剧情时钟 > 原子数据年份多数派（≥60% 且 ≥2 条）> 全库有效日期年份一致');
    clockTraceChain(trace, '② 异常判定：格式非法 / 与锚点年份相差超阈值（jump|backward）');
    clockTraceChain(trace, '③ 修复闸门：写回前先建全量快照；自动路径遇「锚点与库内多数年份冲突（≥3 条）」只统计不修改');
    clockTracePick(trace, 'date', {
        value: info.date || '',
        from: info.source,
        why: info.source === 'manual' ? '手工强制改写（最高可信）'
            : (info.source === 'clock' ? '当前剧情时钟有效即用'
                : (info.source === 'atoms-majority' ? '原子数据年份多数派（单条脏数据可能正好是最新情节，故多数派优先）'
                    : '没有可用锚点（当前剧情日期与原子数据都拿不出可信日期）')),
    });
    if (info.conflict) {
        clockTraceReject(trace, { field: 'date', value: info.conflict.year, from: 'atoms-majority', why: '锚点年份与库内多数年份冲突（' + Number(info.conflict.count) + '/' + Number(info.conflict.total) + ' 条）' + (o.force ? ' → 本次为手动点击，按锚点校正' : ' → 自动路径据此只统计不修改') });
    }
    const rep = {
        scanned: 0, found: 0, fixed: 0, skipped: 0, remain: 0, reasons: {}, details: [], at: Date.now(),
        anchor: info.date, anchorSource: info.source, anchorUsable: info.usable, anchorConflict: info.conflict || null,
        scanOnly: !!o.scanOnly, blocked: '', snap: '',
    };
    try {
        const scan = clockPatrolScan(info);
        rep.scanned = scan.scanned;
        rep.found = scan.findings.length;
        for (const f of scan.findings) { rep.reasons[f.reason] = (rep.reasons[f.reason] || 0) + 1; }
        // 自动路径（非手动点击）遇到「锚点与库内多数年份冲突」→ 只统计，绝不按锚点整库校正
        const autoConflict = !o.force && !!(info.conflict && info.conflict.count >= 3);
        const canWrite = !o.scanOnly && info.usable && !autoConflict;
        if (rep.found && !canWrite) {
            rep.remain = rep.found;
            rep.blocked = autoConflict ? 'anchor-conflict' : (!info.usable ? (info.ambiguous ? 'ambiguous-anchor' : 'no-anchor') : 'scan-only');
            clockPatrolLast = rep;
            clockTraceNote(trace, '只统计未修改：' + rep.blocked + '；扫描 ' + rep.scanned + ' 条，异常 ' + rep.found + ' 条；原因分布 ' + JSON.stringify(rep.reasons));
            clockTraceApplied(trace, { fields: [], locked: true, unchanged: rep.findings.slice(0, 8).map((f) => f.dim + '.' + f.field + '=' + String(f.value).slice(0, 12) + '（' + f.reason + '）'), note: '未修改任何数据' });
            clockTraceFinish(trace);
            try {
                dbgLog('时钟', {
                    action: '时间巡检（只统计，不修改）',
                    why: rep.blocked, scanned: rep.scanned, found: rep.found, anchor: rep.anchor || '(无)',
                    anchorFrom: CLOCK_ANCHOR_SRC_LABEL[rep.anchorSource] || rep.anchorSource || '',
                    anchorWhy: trace.picks.date ? trace.picks.date.why : '',
                    anchorChain: '手工强制改写 > 当前剧情时钟 > 原子多数派 > 全库年份一致',
                    conflict: info.conflict ? (info.conflict.year + '（' + Number(info.conflict.count) + '/' + Number(info.conflict.total) + ' 条）') : '',
                    reasons: rep.reasons,
                    samples: rep.findings.slice(0, 5).map((f) => (CLOCK_DIM_LABEL[f.dim] || f.dim) + '·' + f.field + '=' + String(f.value).slice(0, 16) + '（' + f.reason + '）'),
                    traceId: trace.id,
                    how: '取值追踪：FTT.clockTrace("patrol") / 设定→调试「🕒 时钟取值追踪」',
                });
            } catch (e) {
                try { dbgLog('异常', { kind: '时钟巡检日志构造失败', message: String((e && e.message) || e), stage: 'patrol' }); } catch (e2) { /* 忽略 */ }
            }
            if (!o.silent) {
                const why = rep.blocked === 'scan-only'
                    ? '自动巡检默认只统计（如需自动修复，请在设定开启「巡检后自动修复」）'
                    : (rep.blocked === 'anchor-conflict'
                        ? `当前锚点（${rep.anchor}）与库内多数日期年份（${info.conflict.year}，${info.conflict.count}/${info.conflict.total} 条）冲突`
                        : (rep.blocked === 'ambiguous-anchor' ? '库内日期年份分歧过大 → 找不到可信锚点' : '找不到可信时间锚点（当前剧情日期与原子数据都没有可用日期）'));
                notify('warning', '时间巡检：只统计，未修改',
                    `${why}。共扫描 ${rep.scanned} 条，发现异常 ${rep.found} 条（未改动任何数据）。请先在总览「✏️ 手工改写日期/时间/地点」确认正确的剧情日期作为锚点，再点「🩺 时间巡检修复」。`);
            }
            return rep;
        }
        if (rep.found) {
            // 写回前先留**全量快照**（可到 数据管理 → 快照 还原）
            try { const s = snapshotCreateFull(); if (s && s.id) rep.snap = s.id; } catch (e) { /* 忽略 */ }
            for (const f of scan.findings) {
                const list = state[f.dim] || [];
                const it = list.find(x => x && String(x.id) === String(f.id));
                if (!it) continue;
                const r = clockPatrolRepairItem(it, f, scan.anchor);
                if (r.changed) { rep.fixed++; rep.details.push(`${CLOCK_DIM_LABEL[f.dim] || f.dim} · ${f.field}：${String(f.value).slice(0, 12)} → ${r.note}`); }
                else { rep.skipped++; rep.remain++; }
            }
            if (rep.fixed) { try { saveState(); } catch (e) { /* 忽略 */ } }
        }
        clockPatrolLast = rep;
        clockTraceNote(trace, '扫描 ' + rep.scanned + ' 条，异常 ' + rep.found + ' 条 → 修复 ' + rep.fixed + ' · 保留原值 ' + rep.remain + '；原因分布 ' + JSON.stringify(rep.reasons) + (rep.snap ? ('；写回前快照 ' + String(rep.snap).slice(0, 12)) : ''));
        clockTraceApplied(trace, { fields: rep.details.slice(0, 10).map((d) => ({ field: 'date/time', from: '', to: d, changed: true })), locked: false, unchanged: [], note: rep.snap ? ('已先建全量快照：' + rep.snap) : '' });
        clockTraceFinish(trace);
        try {
            if (rep.fixed || rep.found) dbgLog('时钟', {
                action: '时间巡检与自动修复（v1.187）',
                anchor: rep.anchor, anchorFrom: CLOCK_ANCHOR_SRC_LABEL[rep.anchorSource] || rep.anchorSource || '',
                anchorWhy: trace.picks.date ? trace.picks.date.why : '',
                scanned: rep.scanned, found: rep.found, fixed: rep.fixed, skipped: rep.skipped, remain: rep.remain, reasons: rep.reasons,
                details: rep.details.slice(0, 6),
                snap: rep.snap ? String(rep.snap).slice(0, 16) : '',
                traceId: trace.id,
                how: '取值追踪：FTT.clockTrace("patrol") / 设定→调试「🕒 时钟取值追踪」',
            });
        } catch (e) {
            try { dbgLog('异常', { kind: '时钟巡检日志构造失败', message: String((e && e.message) || e), stage: 'patrol' }); } catch (e2) { /* 忽略 */ }
        }
        if (!o.silent) {
            const src = CLOCK_ANCHOR_SRC_LABEL[rep.anchorSource] || rep.anchorSource || '';
            const anchorTxt = rep.anchor ? `${rep.anchor}${src ? `（${src}）` : ''}` : '（无）';
            const conflictTxt = rep.anchorConflict ? `（锚点与库内多数年份 ${rep.anchorConflict.year} 冲突：${rep.anchorConflict.count}/${rep.anchorConflict.total} 条；本次按锚点校正，请核对）` : '';
            if (rep.found) notify(rep.fixed ? 'success' : 'warning', rep.fixed ? '时间巡检完成：已修复' : '时间巡检完成：发现异常',
                `巡检 ${rep.scanned} 条（锚点 ${anchorTxt}${conflictTxt}）：异常 ${rep.found} 条 → 修复 ${rep.fixed} 条${rep.remain ? ` · 保留原值 ${rep.remain} 条` : ''}${rep.snap ? '（已先留快照，可到数据管理还原）' : ''}。${rep.details.length ? '例：' + rep.details.slice(0, 3).join('；') : ''}`);
            else notify('info', '时间巡检完成', `巡检 ${rep.scanned} 条原子数据（锚点 ${anchorTxt}）：未发现日期/时间异常。`);
        }
        return rep;
    } catch (e) {
        clockPatrolLast = rep;
        return rep;
    }
}
/** 巡检结果快照（总览展示用） */
let clockPatrolLast = null;
function clockPatrolState() { return clockPatrolLast; }
/** 载入后自动巡检一次（`cfg.clockAutoPatrol`；默认只统计，`cfg.clockPatrolAutoFix` 才自动修复） */
function clockPatrolAutoOnce() {
    try {
        if (!cfg || cfg.clockAutoPatrol === false) return null;
        const autoFix = !!(cfg && cfg.clockPatrolAutoFix === true);
        return runClockPatrolRepair({ silent: true, scanOnly: !autoFix });
    } catch (e) { return null; }
}

/** 用户提示（V1 `notify(kind,{title,text})` → 宿主通知钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

export {
    CLOCK_PATROL_DIMS, CLOCK_DIM_LABEL, CLOCK_ANCHOR_SRC_LABEL,
    clockManualRaw, clockManualState, parseClockManualInput, setClockManual, clearClockManual,
    clockPatrolMajority, clockPatrolAnchorInfo, clockPatrolAnchor, clockPatrolSafeDate,
    clockPatrolScan, clockPatrolRepairItem, runClockPatrolRepair, clockPatrolState, clockPatrolAutoOnce,
};
