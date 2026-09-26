// ============================================================
// core/clock-patrol.js —— **剧情时钟域**（B8-1，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① 手工强制改写锚点（v1.186）：`clockManualRaw` / `clockManualState` / `parseClockManualInput` /
//      `setClockManual` / `clearClockManual`（存 `state.state.clockManual`，随存档跨端同步；`cfg.clockManualLock` 默认锁定）；
//   ② 可信时间锚点（v2.51.0 改版）：`clockPatrolAnchorInfo` = 手工强制改写 > 当前剧情时钟（不再有「原子数据多数派」）
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
    // v2.51.0：年份回退只用**当前剧情时钟**（来自最新情节）—— 不再用「原子数据多数派」
    const prevYear = clockDateValid(curDate) ? clockYearOf(curDate) : '';
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
/** 锚点择优：手工 > 当前剧情时钟 > 多数派 > 一致性年份；不确定 → usable=false（宁可不修） */
function clockPatrolAnchorInfo() {
    // v2.51.0 改版：锚点**只有**手工强制改写 > 当前剧情时钟（其值本身也来自最新情节）。
    //   不再用「原子数据年份多数派/全库一致」等跨条目统计（用户要求：其他数据皆不可信）。
    const out = { date: '', source: '', usable: false, conflict: null, ambiguous: false };
    try {
        const man = clockManualRaw();
        if (man && clockDateValid(man.date)) { out.date = clockDateTrim(man.date); out.source = 'manual'; out.usable = true; return out; }
        const cur = String((state.state && state.state.date) || '').trim();
        if (clockDateValid(cur)) { out.date = clockDateTrim(cur); out.source = 'clock'; out.usable = true; return out; }
        return out;
    } catch (e) { return out; }
}

/** 当前锚点日期（手工 > 当前剧情时钟；v2.51.0 改版后仅此两源） */
function clockPatrolAnchor() { return clockPatrolAnchorInfo().date; }

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
/** 最近一次巡检结果（总览展示用） */
let clockPatrolLast = null;
/**
 * 巡检扫描（v2.51.0 改版）：**只扫「情节」**，且只报**格式非法/日期不存在**的条目。
 *   · 其它数据类别（记忆/角色/物品/货币/传言/计划/悬念/场景/概念/平行）**不参与**（用户要求「皆不可信」）；
 *   · 情节总结（`mergedSummary`）与已总结隐藏的原情节（`hidden`/`summarizedBy`）不参与；
 *   · 不再做「年份漂移/异常阈值」判定（该设定已删除）——时钟只取最新情节，无需跨条目比对。
 */
function clockPatrolScan(anchorInfo) {
    const info = anchorInfo || clockPatrolAnchorInfo();
    const out = { anchor: info.date, anchorSource: info.source, anchorUsable: info.usable, anchorConflict: null, scanned: 0, findings: [] };
    try {
        for (const it of (state.atoms || [])) {
            if (!it || typeof it !== 'object') continue;
            if (it.hidden === true || String(it.summarizedBy || '').trim() || it.mergedSummary) continue;   // 总结/已总结隐藏 → 不参与
            out.scanned++;
            const d = String(it.date || '').trim();
            if (d && !clockDateValid(d)) out.findings.push({ dim: 'atoms', id: it.id, field: 'date', value: d, reason: 'invalid', fixable: true });
            const t = String(it.time || '').trim();
            if (t && !clockNormTime(t) && !/^(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)$/.test(t)) {
                out.findings.push({ dim: 'atoms', id: it.id, field: 'time', value: t, reason: 'invalid', fixable: true });
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * 单条修复（v2.51.0）：只处理**格式非法/日期不存在**的字段（情节自己的字段）。
 * 日期：先按该条正文重解析（结果必须是合法日期，且在有锚点时不得与锚点相差过大）→ 否则清空；
 * 时间：按正文重解析为 HH:MM 或时段词 → 否则清空。
 */
function clockPatrolRepairItem(it, finding, anchor) {
    try {
        const text = [it.title, it.text, it.content, it.desc, it.note, it.causalLine].filter(Boolean).join(' ');
        if (finding.field === 'date') {
            const parsed = clockParseDateText(text, clockDateValid(anchor) ? clockYearOf(anchor) : '');
            const safe = clockPatrolSafeDate(parsed, anchor);
            if (safe) { it.date = safe; return { changed: true, note: `按情节正文重解析 → ${safe}` }; }
            if (it.date) { it.date = ''; return { changed: true, note: '日期非法且无法重解析 → 清空（该情节将不再提供时钟）' }; }
            return { changed: false, note: '无法修正 → 保留原值' };
        }
        if (finding.field === 'time') {
            const m = /(\d{1,2})[:：](\d{1,2})/.exec(text) || /(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)/.exec(text);
            const fixed = m ? clockNormTime(m[0]) : '';
            if (fixed) { it.time = fixed; return { changed: true, note: `按情节正文重解析 → ${fixed}` }; }
            it.time = '';
            return { changed: true, note: '时间非法且无法重解析 → 清空' };
        }
        return { changed: false, note: '' };
    } catch (e) { return { changed: false, note: '' }; }
}

/**
 * 时间巡检与修复（v2.51.0 改版：**只针对情节**）。
 * 锚点 = 手工强制改写（最高）＞ 当前剧情时钟（其本身也来自最新情节）；无锚点 → 只统计不修改。
 * @param {object} [opts] silent / scanOnly / force（兼容旧签名；force 已无差别）
 */
function runClockPatrolRepair(opts) {
    const o = opts || {};
    const info = clockPatrolAnchorInfo();
    const trace = clockTraceStart('patrol', '时间巡检与修复（只针对情节）');
    clockTraceChain(trace, '① 锚点：手工强制改写 > 当前剧情时钟（其值也来自最新情节）');
    clockTraceChain(trace, '② 扫描范围：**只有情节**（排除情节总结 / 已总结隐藏）；只报「格式非法」的日期与时间');
    clockTracePick(trace, 'date', { value: info.date || '', from: info.source, why: info.source === 'manual' ? '手工强制改写（最高可信）' : (info.source === 'clock' ? '当前剧情时钟（来自最新情节）' : '没有可用锚点（无手工值且当前时钟为空/非法）') });
    const rep = { scanned: 0, found: 0, fixed: 0, skipped: 0, remain: 0, reasons: {}, details: [], at: Date.now(), anchor: info.date, anchorSource: info.source, anchorUsable: info.usable, anchorConflict: null, scanOnly: !!o.scanOnly, blocked: '', snap: '' };
    try {
        const scan = clockPatrolScan(info);
        rep.scanned = scan.scanned;
        rep.found = scan.findings.length;
        for (const f of scan.findings) rep.reasons[f.reason] = (rep.reasons[f.reason] || 0) + 1;
        const canWrite = !o.scanOnly && info.usable;
        if (rep.found && !canWrite) {
            rep.remain = rep.found;
            rep.blocked = info.usable ? 'scan-only' : 'no-anchor';
            clockPatrolLast = rep;
            clockTraceNote(trace, '只统计未修改：' + rep.blocked + '；扫描情节 ' + rep.scanned + ' 条，异常 ' + rep.found + ' 条');
            clockTraceFinish(trace);
            try { dbgLog('时钟', { action: '时间巡检（只统计，不修改）', why: rep.blocked, scanned: rep.scanned, found: rep.found, anchor: rep.anchor || '(无)', traceId: trace.id }); } catch (e) { /* 忽略 */ }
            if (!o.silent) {
                notify('warning', '时间巡检：只统计，未修改',
                    (info.usable ? '本次为只统计模式' : '找不到可信锚点（当前剧情时钟为空或非法）—— 请先在总览「✏️ 手工改写日期/时间/地点」写入正确日期作为锚点')
                    + '。共扫描情节 ' + rep.scanned + ' 条，发现格式非法的日期/时间 ' + rep.found + ' 条（未改动任何数据）。');
            }
            return rep;
        }
        if (rep.found) {
            try { const sn = snapshotCreateFull(); if (sn && sn.id) rep.snap = sn.id; } catch (e) { /* 忽略 */ }
            for (const f of scan.findings) {
                const it = (state.atoms || []).find((x) => x && String(x.id) === String(f.id));
                if (!it) continue;
                const r = clockPatrolRepairItem(it, f, scan.anchor);
                if (r.changed) { rep.fixed++; rep.details.push('情节 · ' + f.field + '：' + String(f.value).slice(0, 12) + ' → ' + r.note); }
                else { rep.skipped++; rep.remain++; }
            }
            if (rep.fixed) { try { saveState(); } catch (e) { /* 忽略 */ } }
        }
        clockPatrolLast = rep;
        clockTraceNote(trace, '扫描情节 ' + rep.scanned + ' 条，异常 ' + rep.found + ' 条 → 修复 ' + rep.fixed + ' · 保留原值 ' + rep.remain + (rep.snap ? ('；写回前快照 ' + String(rep.snap).slice(0, 12)) : ''));
        clockTraceFinish(trace);
        try {
            if (rep.fixed || rep.found) dbgLog('时钟', { action: '时间巡检与修复（只针对情节）', scanned: rep.scanned, found: rep.found, fixed: rep.fixed, remain: rep.remain, anchor: rep.anchor || '(无)', snap: rep.snap || '', details: rep.details.slice(0, 5), traceId: trace.id });
        } catch (e) { /* 忽略 */ }
        if (!o.silent && rep.found) {
            notify(rep.fixed ? 'success' : 'info', '时间巡检完成（只针对情节）',
                '扫描情节 ' + rep.scanned + ' 条 · 异常 ' + rep.found + ' 条 → 修复 ' + rep.fixed + ' 条'
                + (rep.remain ? (' · 保留 ' + rep.remain + ' 条') : '') + (rep.snap ? '（已留快照，可回滚）' : ''));
        }
        return rep;
    } catch (e) {
        rep.blocked = 'error';
        clockTraceNote(trace, '巡检异常：' + String((e && e.message) || e));
        clockTraceFinish(trace);
        return rep;
    }
}

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
    CLOCK_DIM_LABEL, CLOCK_ANCHOR_SRC_LABEL,
    clockManualRaw, clockManualState, parseClockManualInput, setClockManual, clearClockManual,
    clockPatrolAnchorInfo, clockPatrolAnchor, clockPatrolSafeDate,
    clockPatrolScan, clockPatrolRepairItem, runClockPatrolRepair, clockPatrolState, clockPatrolAutoOnce,
};
