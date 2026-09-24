// ============================================================
// core/clock-extract.js —— **剧情时钟自动提取管线**（B8-2，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① `extractClockFromHeader`（v1.188 正文头结构：`▷ 日期（纪年）·季节(场景描述)` / `▷ 地点-路径` / `▶第 N 天 起止时间(状态)`）；
//   ② `extractClockFromText`（多源择优：正文头 > 日期直取/时刻/时段词 > 自定义正则 > 标记式带值 > 相对日期推进）；
//   ③ `resolveStoryClock`（v1.173 统一解析：手工锁定 > 正则/最新情节/原子降级/沿用旧值 多源择优 + 日期异常自动降级 +
//      时间/地点跟随胜出侧 + 在场角色只聚焦最新正文/最新情节 + 正文头附加字段 + 「第 N 天」纪元换算）；
//   ④ `clockAutoExtractOnce` / `scheduleClockExtract`（落盘 state.state.* + clockSrc 可解释来源 + 在场 + 快照 seen 标记）；
//   ⑤ `latestSceneLocation` / `resolvePresentNames` / `storyClockReference`。
// 适配（与 V1 的差别）：① 取文改经**注入钩子**（`setClockTextHooks`：最新 AI 正文 / 楼层窗口文本），
//   内核不直接读宿主聊天（V1 调 `latestAiFloorText`/`collectFloorLinesInRange`）；② 提示经 `notifyHooks`、
//   延迟调度经 `timerHooks`、面板重绘由 UI 层负责；③ `clockDateValid` 等日期族复用 `core/clock.js`。
// 一致性由 tests/unit/clock-extract-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, dbgLog, timerHooks, latestAiFloorText, getLastMessageId } from './model/runtime.js';
import {
    clockDateValid, clockDateParts, clockDateFromParts, clockParseDateText, clockNormTime, clockValNum,
    clockAddDays, clockMatchNotInline, clockNormBcText, clockYearOf, clockAnomalyJumpYears, clockDateAnomaly,
    CLOCK_DATE_SCAN, CLOCK_DAY_PARTS,
} from './clock.js';
import { latestPlotByFloor, atomLatestDated, matchPresentNames } from './recall.js';
import { clockManualRaw } from './clock-patrol.js';
import { stampSnapshotsSeen } from './model/snapshot.js';
import { scheduleStateDecay } from './ingest.js';

// ---------- 取文钩子（宿主注入；内核默认只用运行时「最新 AI 正文」） ----------
let textHooks = {
    /** 最新 AI 正文（默认取运行时注入的 chatHooks.latestAiFloorText） */
    latestAiText: () => { try { return String(latestAiFloorText() || ''); } catch (e) { return ''; } },
    /** 最近楼层窗口文本（V1 `collectFloorLinesInRange(last-n+1, last)`；宿主注入） */
    floorWindowText: () => '',
};
export function setClockTextHooks(next) { textHooks = Object.assign({}, textHooks, next || {}); return textHooks; }

/** 相对日期推进词表（V1 `CLOCK_RELATIVE_OFFSET`） */
const CLOCK_RELATIVE_OFFSET = { '今天': 0, '今日': 0, '当天': 0, '当日': 0, '同日': 0, '明天': 1, '明日': 1, '次日': 1, '翌日': 1, '第二天': 1, '隔天': 1, '后天': 2, '后日': 2, '第三天': 2, '大后天': 3, '昨天': -1, '昨日': -1, '前天': -2, '前日': -2, '前两天': -2 };
/** 正文头结构标记与行首清理（V1 `CLOCK_HEADER_MARK`） */
const CLOCK_HEADER_MARK = /^[\s▷►▶▼▽»>·•\-—*]*/;

/** 最新的场景（场景库）—— 降级方案的地点来源（V1 `latestSceneLocation` 逐字） */
function latestSceneLocation() {
    try {
        const list = (state.scenes || []).filter(x => x && (x.name || x.pathStr || (Array.isArray(x.pathArr) && x.pathArr.length)));
        if (!list.length) return '';
        const pathOf = (s) => String(s.pathStr || (Array.isArray(s.pathArr) ? s.pathArr.join('·') : '') || s.name || '').trim();
        const curLoc = String((state.state && state.state.location) || '');
        if (curLoc) {
            const hit = list.find(s => { const p = pathOf(s); return p && (p === curLoc || curLoc.indexOf(p) >= 0 || p.indexOf(curLoc) >= 0); });
            if (hit) return pathOf(hit);
        }
        const sorted = list.slice().sort((a, b) => ((Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0))
            || ((Number(b.uses) || 0) - (Number(a.uses) || 0))
            || ((Array.isArray(b.pathArr) ? b.pathArr.length : 0) - (Array.isArray(a.pathArr) ? a.pathArr.length : 0)));
        return pathOf(sorted[0]) || '';
    } catch (e) { return ''; }
}

/** 兜底参考：原子数据「最新存在日期」的节点（仅供总览展示，不写入） */
function storyClockReference() {
    try {
        const n = atomLatestDated();
        if (!n) return { date: '', time: '', location: '' };
        return { date: n.date || '', time: n.time || '', location: n.location || '' };
    } catch (e) { return { date: '', time: '', location: '' }; }
}

/**
 * 正文头结构化解析（v1.188）。
 * 示例：`▷0051年1月2日（东汉建武二十七年）·冬(死寂的长街)` / `▷凉州卫-中央大街-钟鼓楼下` / `▶第17602天 08:52->09:05(状态)`
 */
function extractClockFromHeader(text0) {
    const out = { date: '', era: '', season: '', sceneDesc: '', location: '', storyDay: 0, time: '', timeEnd: '', status: '' };
    try {
        const text = clockNormBcText(String(text0 || ''));   // 公元前写法先归一
        if (!text || !/[▷►▶▼▽»]/.test(text)) return out;
        const lines = text.split(/\r?\n/);
        for (const raw of lines) {
            if (!raw || !/[▷►▶▼▽»]/.test(raw)) continue;
            const line = raw.replace(CLOCK_HEADER_MARK, '').trim();
            if (!line) continue;
            const dm = /(?:公元|前)?\s*(-?\d{1,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(line);
            const daym = /第\s*(\d+)\s*天/.exec(line);
            const rng = /(\d{1,2})\s*[:：]\s*(\d{1,2})\s*(?:->|→|~|～|—|–|至)\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(line);
            const tm = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(line);
            if (dm) {
                const d = clockDateFromParts([dm[1], dm[2], dm[3]], '');
                if (d) out.date = d;
                // 纪年：紧跟日期之后的第一个括号（括号内含时间/天数语义则不算）
                const after = line.slice(dm.index + dm[0].length);
                const em = /^\s*[（(]([^）)]{1,30})[）)]/.exec(after);
                if (em && !/第\s*\d+\s*天|\d{1,2}\s*[:：]\s*\d{1,2}/.test(em[1])) out.era = em[1].trim();
                const sm = /[·・|｜]\s*([春夏秋冬])\s*季?/.exec(line);
                if (sm) out.season = sm[1];
                const parens = [];
                const rp = /[（(]([^）)]{2,80})[）)]/g; let pm;
                while ((pm = rp.exec(line)) !== null) parens.push(pm[1].trim());
                const desc = parens.filter(x => x && x !== out.era).pop();
                if (desc) out.sceneDesc = desc;
            }
            if (daym) { const n = Number(daym[1]); if (Number.isInteger(n) && n > 0 && n < 1000000) out.storyDay = n; }
            if (rng) {
                const t1 = clockNormTime(`${rng[1]}:${rng[2]}`), t2 = clockNormTime(`${rng[3]}:${rng[4]}`);
                if (t1 && t2) { out.time = t1; out.timeEnd = t2; }
            } else if (tm) {
                const t1 = clockNormTime(`${tm[1]}:${tm[2]}`);
                if (t1) out.time = t1;
            }
            const stm = /[（(]([^）)]{1,60})[）)]\s*$/.exec(line);
            if (stm && (tm || daym)) out.status = stm[1].trim();
            // 地点行：无日期/天数/时间、长度受限、像路径或地名（含中文、无句读）
            if (!dm && !daym && !tm) {
                const looksPlace = line.length <= 60 && !/[，。！？；]/.test(line) && /[\u4e00-\u9fff]/.test(line);
                if (looksPlace) out.location = line;
            }
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 主提取（V1 `extractClockFromText`）：text=正文（可多楼层拼接，取最后一次出现的表达）；prev={date,time,location}
 */
function extractClockFromText(text0, prevOpts) {
    const out = { date: null, time: null, location: null, source: {}, timeEnd: '', season: '', era: '', storyDay: 0, sceneDesc: '', statusText: '', header: false };
    try {
        const text = String(text0 || '');
        if (!text) return out;
        const prev = prevOpts || {};
        const hits = { date: [], time: [], location: [] };
        const push = (field, val, idx, src) => { if (val !== null && val !== undefined && String(val).trim()) hits[field].push({ val: String(val).trim(), idx: Number(idx) || 0, src }); };
        const lastIdx = text.length;
        const prevYear = clockYearOf(prev.date);
        // L1 日期直取（预设 cn 的通用年月日正则 + 中文数字 + 自定义追加）
        const presetKey = (cfg && cfg.clockRegexPreset) || 'cn+marker';
        const useCn = presetKey !== 'marker' && presetKey !== 'none';
        const useMarker = presetKey !== 'cn' && presetKey !== 'none';
        if (useCn) {
            let m;
            for (const re of CLOCK_DATE_SCAN) {
                const rr = new RegExp(re.source, 'g');
                while ((m = rr.exec(text)) !== null) {
                    if (!clockMatchNotInline(text, m)) continue;   // 跳过长日期尾部命中
                    const d = clockDateFromParts([m[1], m[2], m[3]], prevYear);
                    if (d) push('date', d, m.index, 'regex');
                }
            }
            // 时间：24h / 中文点数
            const rt = /(\d{1,2})[:：](\d{1,2})(?::\d{2})?/g;
            while ((m = rt.exec(text)) !== null) { const t = clockNormTime(m[0]); if (t) push('time', t, m.index, 'regex'); }
            const rp = /(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点时]\s*(半|一刻|三刻)?\s*(?:分)?/g;
            while ((m = rp.exec(text)) !== null) { const t = clockNormTime(m[0]); if (t) push('time', t, m.index, 'regex'); }
            // 纯时段词（不带数字，也登记为时间候选；权重低于带数字）
            for (const p of CLOCK_DAY_PARTS) { let i = text.indexOf(p); while (i >= 0) { push('time', p, i, 'daypart'); i = text.indexOf(p, i + 1); } }
        }
        // 正文头结构优先（索引加 boost 让它压过同文本里的零散正则命中）
        const hdr = (useCn || useMarker) ? extractClockFromHeader(text) : null;
        if (hdr && (hdr.date || hdr.location || hdr.time || hdr.storyDay || hdr.season || hdr.era)) {
            const boost = lastIdx + 1000;
            if (hdr.date) push('date', hdr.date, boost + 3, 'header');
            if (hdr.time) push('time', hdr.time, boost + 2, 'header');
            if (hdr.location) push('location', hdr.location, boost + 1, 'header');
            out.header = true;
            out.era = hdr.era || out.era;
            out.season = hdr.season || out.season;
            out.sceneDesc = hdr.sceneDesc || out.sceneDesc;
            out.storyDay = hdr.storyDay || out.storyDay;
            out.timeEnd = hdr.timeEnd || out.timeEnd;
            out.statusText = hdr.status || out.statusText;
        }
        // 自定义正则（叠加；每组取最后命中）；空源不编译；非法正则忽略
        const customRE = (src) => { const t = String(src || '').trim(); if (!t) return null; try { return new RegExp(t, 'g'); } catch (e) { return null; } };
        const cre = customRE(cfg && cfg.clockDateRegex); if (cre) { let m; while ((m = cre.exec(text)) !== null) { const val = (m.length >= 4) ? (clockDateFromParts([m[1], m[2], m[3]], prevYear) || m[0]) : ((m[1] || m[0]).trim()); push('date', val, m.index, 'custom'); } }
        const tre = customRE(cfg && cfg.clockTimeRegex); if (tre) { let m; while ((m = tre.exec(text)) !== null) { const raw = ((m.length >= 2 && m[1] !== undefined) ? m[1] : m[0]).trim(); push('time', clockNormTime(raw) || raw.slice(0, 20), m.index, 'custom'); } }
        const lre = customRE(cfg && cfg.clockLocationRegex); if (lre) { let m; while ((m = lre.exec(text)) !== null) { const raw = ((m.length >= 2 && m[1] !== undefined) ? m[1] : m[0]).trim(); push('location', raw, m.index, 'custom'); } }
        // L2 标记式带值（含 【…】 括号式；地点也走标记式）
        const markerKeys = { '日期': 'date', '时间': 'time', '时刻': 'time', '地点': 'location', '所在位置': 'location', '位置': 'location', '场景': 'location', '场所': 'location' };
        if (useMarker) {
            const rm = /【(日期|时间|时刻|地点|所在位置|位置|场景|场所)\s*[:：]?\s*([^】\n]{1,60})/g;
            let m; while ((m = rm.exec(text)) !== null) { const f = markerKeys[m[1]]; if (f) push(f, m[2].trim(), m.index, 'marker'); }
            const rp2 = /(?:^|[^\u4e00-\u9fffA-Za-z0-9])(日期|时间|时刻|地点|所在位置|位置|场景|场所)\s*[:：]\s*([^，。！？；;\n】]{1,60})/g;
            while ((m = rp2.exec(text)) !== null) { const f = markerKeys[m[1]]; if (f) push(f, m[2].trim(), m.index, 'marker'); }
        }
        // L4 相对日期推进（须已有 prev.date；取最后一次相对词）
        if (cfg && cfg.clockRelative && prev.date && useCn) {
            let bestOff = null, bestIdx = -1;
            for (const w in CLOCK_RELATIVE_OFFSET) { const i = text.indexOf(w); if (i >= 0 && i > bestIdx) { bestIdx = i; bestOff = CLOCK_RELATIVE_OFFSET[w]; } }
            const rn = /([一二两三四五六七八九十百]+|\d+)\s*[日天]\s*(?:后|之后|过后)/g; let m2; while ((m2 = rn.exec(text)) !== null) { if (m2.index > bestIdx) { bestIdx = m2.index; const n = clockValNum(m2[1]); bestOff = Number.isInteger(n) ? n : 2; } }
            const rnb = /([一二两三四五六七八九十百]+|\d+)\s*[日天]\s*前/g; while ((m2 = rnb.exec(text)) !== null) { if (m2.index > bestIdx) { bestIdx = m2.index; const n = clockValNum(m2[1]); bestOff = -(Number.isInteger(n) ? n : 1); } }
            if (bestOff !== null) push('date', clockAddDays(prev.date, bestOff), bestIdx, 'relative');
        }
        // 归一：各字段取最后一次命中（时间：带数字 > 纯时段词；日期取最后一次）
        for (const field of ['date', 'time', 'location']) {
            if (!hits[field].length) continue;
            const sorted = hits[field].sort((a, b) => b.idx - a.idx || (a.src === 'regex' ? -1 : 0));
            const pick = sorted[0];
            if (field === 'date') { const d = clockParseDateText(pick.val, prevYear) || pick.val; out.date = String(d).slice(0, 10); }
            else if (field === 'time') { const t = clockNormTime(pick.val); out.time = (t || pick.val).slice(0, 20); }
            else out.location = pick.val.slice(0, 60);
            out.source[field] = pick.src;
        }
        return out;
    } catch (e) { return out; }
}

/** 在场解析（v1.173）：① 最新 AI 正文 → ② 最新情节节点的涉及角色 → ③ 保留上一次（不清空） */
function resolvePresentNames(textIn, plotIn) {
    try {
        const text = String(textIn || '').trim();
        if (text) {
            const hit = matchPresentNames(text);
            if (hit.present && hit.present.length) return { list: hit.present, source: 'latest-ai' };
        }
        const plot = plotIn || latestPlotByFloor();
        const ents = (plot && plot.entities) || [];
        if (ents.length) {
            const hit2 = matchPresentNames(ents.join('、'));
            if (hit2.present && hit2.present.length) return { list: hit2.present, source: 'plot-atom' };
        }
        const prev = (state && state.state && Array.isArray(state.state.present)) ? state.state.present.filter(Boolean) : null;
        return { list: (prev && prev.length) ? prev : null, source: 'keep-prev' };   // null = 不限制（保持旧名单，不清空）
    } catch (e) { return { list: null, source: 'keep-prev' }; }
}

/**
 * 剧情时钟统一解析（V1 `resolveStoryClock`）：多源择优 + 日期异常自动降级。
 * opts.text：显式正文（不传则取注入钩子的「最新 AI 正文」→ 楼层窗口回退）
 */
function resolveStoryClock(opts) {
    const o = opts || {};
    const out = {
        date: '', time: '', location: '', present: null,
        source: { date: '', time: '', location: '', present: '' },
        degraded: false, textMode: 'none', jumpYears: 0,
        timeEnd: '', season: '', era: '', storyDay: 0, sceneDesc: '', statusText: '', header: false,
    };
    try {
        const cur = (state && state.state) || {};
        const prev = { date: String(cur.date || '').trim(), time: String(cur.time || '').trim(), location: String(cur.location || '').trim() };
        // 手工强制改写优先：锁定时直接采用手工值；未锁定则作为「已存值」参与择优
        const manual = clockManualRaw();
        const manualLock = !!(manual && (!cfg || cfg.clockManualLock !== false));
        if (manualLock) {
            out.date = manual.date || prev.date;
            out.time = manual.time || prev.time;
            out.location = manual.location || prev.location;
            out.source.date = manual.date ? 'manual' : (prev.date ? 'prev' : '');
            out.source.time = manual.time ? 'manual' : '';
            out.source.location = manual.location ? 'manual' : '';
            out.manual = true;
            const presText0 = String(o.text != null ? o.text : (textHooks.latestAiText() || '')).trim();
            const pres = resolvePresentNames(presText0, latestPlotByFloor());
            out.source.present = pres.source;
            out.present = pres.list;
            return out;
        }
        if (manual && (manual.date || manual.time || manual.location)) {
            if (manual.date) prev.date = manual.date;
            if (manual.time) prev.time = manual.time;
            if (manual.location) prev.location = manual.location;
        }
        // ① 正则来源（最新 AI 正文 → 楼层窗口回退，仅用于日期/时间/地点）
        let text = String(o.text != null ? o.text : '').trim();
        let mode = text ? 'given' : 'none';
        if (!text) {
            try { text = String(textHooks.latestAiText() || '').trim(); } catch (e) { text = ''; }
            if (text) mode = 'latest-ai';
        }
        if (!text) {
            const last = Number(getLastMessageId());
            if (last >= 0) {
                try { text = String(textHooks.floorWindowText() || '').trim(); } catch (e) { text = ''; }
                if (text) mode = 'floor-window';
            }
        }
        out.textMode = mode;
        let r = null;
        if (text) { try { r = extractClockFromText(text, prev); } catch (e) { r = null; } }
        const plot = latestPlotByFloor();
        const glob = atomLatestDated();
        // 降级判定：① 用户强制降级；② 捕捉到的日期异常（格式非法 / 与锚点相差超阈值）
        const forceDegrade = !!(cfg && cfg.clockForceDegrade === true);
        const probeDate = (r && clockDateValid(r.date)) ? String(r.date).slice(0, 10) : '';
        let anomaly = { bad: false, reason: '' };
        if (probeDate) { try { anomaly = clockDateAnomaly(probeDate, prev.date || (plot && plot.date) || (glob && glob.date) || ''); } catch (e) { anomaly = { bad: false, reason: '' }; } }
        const degrade = forceDegrade || anomaly.bad || !probeDate;
        const reason = forceDegrade ? 'force' : (anomaly.bad ? ('anomaly:' + anomaly.reason) : (probeDate ? '' : 'no-date'));
        const regexCand = (probeDate && !degrade) ? { date: probeDate, src: 'regex', time: String(r.time || ''), location: String(r.location || '') } : null;
        const asCand = (srcObj, src) => (srcObj && clockDateValid(srcObj.date))
            ? { date: String(srcObj.date).slice(0, 10), src, time: String(srcObj.time || ''), location: String(srcObj.location || '') } : null;
        const cands = [regexCand, asCand(plot, 'plot'), asCand(glob, 'atom-latest')].filter(Boolean);
        const hasPrev = clockDateValid(prev.date);
        if (hasPrev) cands.push({ date: prev.date, src: 'prev', time: '', location: '' });
        const PRI = { plot: 3, regex: 2, 'atom-latest': 1, prev: 0 };
        let win = null;
        if (cands.length) {
            cands.sort((a, b) => String(b.date).localeCompare(String(a.date)) || ((PRI[b.src] || 0) - (PRI[a.src] || 0)));
            win = cands[0];
            out.date = win.date;
            out.source.date = (win.src === 'prev') ? (hasPrev ? 'prev' : '') : win.src;
            out.degraded = forceDegrade || anomaly.bad || (!(r && clockDateValid(r.date)) && !(plot && clockDateValid(plot.date)));
            out.degradeReason = forceDegrade ? 'force'
                : (anomaly.bad ? ('anomaly:' + anomaly.reason) : (out.degraded ? 'no-date' : ''));
            if (hasPrev && out.date > prev.date) {
                const dy = clockYearOf(out.date) - clockYearOf(prev.date);
                out.jumpYears = dy;
            }
        } else if (degrade) {
            out.degradeReason = reason;
        }
        // 时间 / 地点：有胜出日期时只从同一天/同一节点取；否则按 正则 → 最新情节 → 原子降级
        const srcOf = (c) => c === r ? ((c && c.source && c.source.date === 'header') ? 'header' : 'regex') : (c === plot ? 'plot' : (c === glob ? 'atom-latest' : ''));
        const sameDay = (c) => (c && clockDateValid(c.date) && String(c.date).slice(0, 10) === out.date) ? c : null;
        const own = win ? (win.src === 'plot' ? plot : (win.src === 'regex' ? r : (win.src === 'atom-latest' ? glob : null))) : null;
        const order = out.date
            ? [own, sameDay(r), sameDay(plot), sameDay(glob)].filter(Boolean)
            : [r, plot, glob].filter(Boolean);
        for (const c of order) { if (c && c.time && !out.time) { out.time = String(c.time).slice(0, 20); out.source.time = srcOf(c); } }
        for (const c of order) { if (c && c.location && !out.location) { out.location = String(c.location).slice(0, 60); out.source.location = srcOf(c); } }
        // 正文头结构带出的附加字段（只在最新正文用了结构头时带出）
        try {
            const hdrSrc = (r && (r.header === true || (r.source && r.source.date === 'header'))) ? r : null;
            if (hdrSrc) {
                out.timeEnd = String(hdrSrc.timeEnd || '').slice(0, 10);
                out.season = String(hdrSrc.season || '').slice(0, 4);
                out.era = String(hdrSrc.era || '').slice(0, 30);
                out.sceneDesc = String(hdrSrc.sceneDesc || '').slice(0, 80);
                out.storyDay = Number(hdrSrc.storyDay) || 0;
                out.statusText = String(hdrSrc.statusText || '').slice(0, 60);
                out.header = true;
                if (out.time) out.source.time = 'header';
                if (out.location) out.source.location = 'header';
            }
            // 可选换算：正文只给「第 N 天」时，用配置的纪元首日把天数换算成日期（默认关：不换算）
            const epoch = String((cfg && cfg.clockStoryDayEpoch) || '').trim();
            if (!out.date && out.storyDay > 0 && clockDateValid(epoch)) {
                const d = clockAddDays(epoch.slice(0, 10), out.storyDay - 1);
                if (clockDateValid(d)) { out.date = d; out.source.date = 'storyday'; }
            }
        } catch (e) { /* 忽略 */ }
        // 降级时地点补「最新的场景」（仅在降级路径且前面没能给出地点时）
        if (degrade && !out.location) {
            try {
                const sc = latestSceneLocation();
                if (sc) { out.location = String(sc).slice(0, 60); out.source.location = 'scene'; }
            } catch (e) { /* 忽略 */ }
        }
        // 在场角色：只聚焦最新 AI 正文或最新情节分析（窗口回退文本不用于在场，避免跨楼层扩散）
        const presText = (mode === 'latest-ai' || mode === 'given') ? text : '';
        const pres = resolvePresentNames(presText, plot);
        out.source.present = pres.source;
        out.present = pres.list;
        return out;
    } catch (e) { return out; }
}

// ---------- 自动提取落盘（V1 `clockAutoExtractOnce`） ----------
/** 最近一次自动提取的结果（调试/界面用） */
let clockExtractLast = null;
export function clockExtractState() { return clockExtractLast; }

/**
 * 解析并入账本（V1 `clockAutoExtractOnce`）：写 `state.state.*` + `clockSrc` 可解释来源 + 在场 + 快照 seen 标记。
 * @param {object} [opts] silent / force（忽略 cfg.clockExtractEnabled / enabled / 长任务占用）
 * @returns {boolean} 是否有改动
 */
export function clockAutoExtractOnce(opts) {
    const o = opts || {};
    try {
        if (!o.force) {
            if (!cfg || !cfg.enabled || !cfg.clockExtractEnabled) return false;
        }
        const lastId = Number(getLastMessageId());
        if (lastId < 0) return false;
        const prev = {
            date: String((state.state && state.state.date) || ''),
            time: String((state.state && state.state.time) || ''),
            location: String((state.state && state.state.location) || ''),
        };
        const res = resolveStoryClock(o.text != null ? { text: o.text } : undefined);
        clockExtractLast = res;
        if (!res.date && !res.time && !res.location && res.present === null) return false;
        // 手工强制改写（默认锁定）→ 不覆盖 日期/时间/地点，只继续维护「在场」与来源说明
        const manualLocked = !!(res.manual && (!cfg || cfg.clockManualLock !== false));
        let changed = false;
        if (!manualLocked) {
            if (res.date && res.date !== prev.date) { state.state.date = res.date; changed = true; }
            if (res.time && res.time !== prev.time) { state.state.time = res.time; changed = true; }
            if (res.location && res.location !== prev.location) { state.state.location = res.location; changed = true; }
            // 正文头结构字段随剧情时钟一起落盘（有则写入；本次未采用结构头 → 不清空旧值）
            if (res.header) {
                const put = (k, v) => {
                    const c0 = String((state.state && state.state[k]) || '');
                    const nv = String(v == null ? '' : v).slice(0, 80);
                    if (c0 !== nv) { state.state[k] = nv; changed = true; }
                };
                put('timeEnd', res.timeEnd || '');
                put('season', res.season || '');
                put('era', res.era || '');
                put('sceneDesc', res.sceneDesc || '');
                put('statusText', res.statusText || '');
                const sd = Number(res.storyDay) || 0;
                if (Number(state.state.storyDay) !== sd) { state.state.storyDay = sd; changed = true; }
            }
        }
        // 在场角色：只来自最新正文 / 最新情节分析；两侧都无 → 保留旧名单
        const curPres = Array.isArray(state.state.present) ? state.state.present : null;
        const presKey = (arr) => (arr || []).slice().sort().join('\u0001');
        const presChanged = Array.isArray(res.present) && presKey(curPres) !== presKey(res.present);
        if (presChanged) state.state.present = res.present.slice();
        // 记录来源（可解释，不参与内容哈希）
        try {
            state.state.clockSrc = {
                date: res.source.date || (changed ? 'regex' : ''),
                time: res.source.time || '',
                location: res.source.location || '',
                present: res.source.present || '',
                textMode: res.textMode || '',
                degraded: !!res.degraded,
                degradeReason: res.degradeReason || '',
                jumpYears: res.jumpYears || 0,
                manual: !!res.manual,
                manualLock: manualLocked,
                at: lastId,
            };
        } catch (e) { /* 忽略 */ }
        // 在场角色 → 记「最后一次见面时间」
        let seenChanged = false;
        try { seenChanged = stampSnapshotsSeen(presChanged ? res.present : (curPres || res.present || [])); } catch (e) { /* 忽略 */ }
        const srcLabel = { regex: '正则（最新正文）', header: '正文头结构（▷/▶）', storyday: '剧情天数换算', plot: '最新情节', 'atom-latest': '原子数据降级', prev: '沿用已有值', manual: '手工强制改写' };
        if (changed || presChanged || seenChanged) {
            try { saveState(); } catch (e) { /* 忽略 */ }
            // 剧情日期推进 → 顺带调度状态记录衰退
            if (changed) { try { scheduleStateDecay(); } catch (e) { /* 忽略 */ } }
            try {
                dbgLog('时钟', {
                    action: '自动解析剧情时钟/在场（多源择优 + 降级）',
                    text: res.textMode === 'latest-ai' ? (lastId + '(最新AI回复)') : (res.textMode === 'floor-window' ? ('第' + Math.max(0, lastId - (Number(cfg.feedFloors) || 2) + 1) + '-' + lastId + '楼(窗口回退·仅日期/时间/地点)') : res.textMode),
                    date: state.state.date, dateFrom: srcLabel[res.source.date] || res.source.date || '',
                    time: state.state.time, location: state.state.location,
                    present: state.state.present, presentFrom: srcLabel[res.source.present] || res.source.present || '',
                    degraded: !!res.degraded, jumpYears: res.jumpYears || 0,
                });
            } catch (e) { /* 忽略 */ }
            return true;
        }
        return false;
    } catch (e) { return false; }
}

/** 消息后自动提取时钟（1.8s 防抖；`cfg.clockExtractEnabled`） */
let clockTickTimer = null;
export function scheduleClockExtract() {
    try {
        if (!cfg || !cfg.enabled || !cfg.clockExtractEnabled) return false;
        if (clockTickTimer) return false;
        clockTickTimer = timerHooks.set(() => {
            clockTickTimer = null;
            try { clockAutoExtractOnce(); } catch (e) { /* 忽略 */ }
        }, 1800);
        return true;
    } catch (e) { return false; }
}

export {
    CLOCK_RELATIVE_OFFSET, CLOCK_HEADER_MARK,
    extractClockFromHeader, extractClockFromText, resolveStoryClock, resolvePresentNames,
    latestSceneLocation, storyClockReference,
};
