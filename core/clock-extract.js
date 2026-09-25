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
// v2.44.0（用户报告）：「地点捕捉把 `<br>` 这种 HTML 标签也捕捉进来了」→ 正文/取值统一清洗（纯内核，见 docs/P10i）
import { cleanText, cleanValue, hasHtmlTag, htmlStats } from './html-text.js';
// v2.37.0「时钟取值追踪」：把「值从哪来 / 为什么取它 / 还有什么没被采用」记成结构化追踪（纯记录，不参与判定）
import {
    clockTraceStart, clockTraceText, clockTraceChain, clockTracePick, clockTraceReject,
    clockTraceDegrade, clockTraceApplied, clockTraceFinish, clockTraceLast, clockTraceSummary, clockTraceNote,
    clockSrcLabel, clockDegradeLabel,
} from './clock-trace.js';

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
        // v2.44.0：先剔除 HTML 标签（`▷码头仓库<br>` 曾把整行含标签当地点写进 state.state.location）
        const text = clockNormBcText(cleanText(String(text0 || '')));   // 公元前写法先归一
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
 * v2.37.0「时钟取值追踪」侧信道：最近一次 `extractClockFromText` 的**采用值与全部候选**（含原始片段）。
 * 返回结构本身保持与 V1 逐字一致，故诊断信息单独导出；`resolveStoryClock` 在调用后立即读取。
 */
let lastExtractDiag = { picked: {}, candidates: {}, html: null };
/** 最近一次文本提取的诊断信息（采用值 + 落选候选 + HTML 清洗统计） */
export function clockExtractDiag() { return lastExtractDiag; }

/**
 * 主提取（V1 `extractClockFromText`）：text=正文（可多楼层拼接，取最后一次出现的表达）；prev={date,time,location}
 */
function extractClockFromText(text0, prevOpts) {
    const out = { date: null, time: null, location: null, source: {}, timeEnd: '', season: '', era: '', storyDay: 0, sceneDesc: '', statusText: '', header: false };
    try {
        const rawText = String(text0 || '');
        if (!rawText) return out;
        // v2.44.0：**只在文本确实含 HTML 标签/实体时才清洗** —— 其余路径逐字保持 V1 行为
        //   （黄金样本 `J(got)===J(oracle)` 不受影响）；HTML 统计经侧信道导出，供追踪说明「为什么值变了」。
        const html = hasHtmlTag(rawText) ? htmlStats(rawText) : null;
        const text = html ? cleanText(rawText) : rawText;
        const prev = prevOpts || {};
        const hits = { date: [], time: [], location: [] };
        // v2.37.0「时钟取值追踪」：候选**连原始片段一起**记录（`raw` = 命中位置前 12 字 / 后 40 字，压平空白），
        //   以便回答「这个值是从哪句正文里读出来的、为什么是它」（见 core/clock-trace.js 与 docs/P10c）。
        const rawAt = (idx) => String(text).slice(Math.max(0, Number(idx) - 12), Math.max(0, Number(idx)) + 40).replace(/\s+/g, ' ').trim();
        const push = (field, val, idx, src, rawHint) => { if (val !== null && val !== undefined && String(val).trim()) hits[field].push({ val: String(val).trim(), idx: Number(idx) || 0, src, raw: String(rawHint == null ? rawAt(idx) : rawHint).replace(/\s+/g, ' ').trim().slice(0, 60) }); };
        const picked = {};   // 采信值（各字段一条；与 `others` 一起经侧信道导出）
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
            // 正文头候选的 idx 是**加成后的合成索引**（用于压过零散命中），故原文片段单独给出（前两行标记行）
            const hdrRaw = String(text).split(/\r?\n/).filter((l) => /[▷►▶▼▽»]/.test(l)).slice(0, 2).join(' / ');
            if (hdr.date) push('date', hdr.date, boost + 3, 'header', hdrRaw);
            if (hdr.time) push('time', hdr.time, boost + 2, 'header', hdrRaw);
            if (hdr.location) push('location', hdr.location, boost + 1, 'header', hdrRaw);
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
        // v2.37.0：同时把**采用值与全部落选候选**（含原始片段/命中位置/来源键）记进 `out.picked`，
        //   供追踪结构如实说明「为什么是它、还有什么没被采用」。
        for (const field of ['date', 'time', 'location']) {
            if (!hits[field].length) continue;
            const sorted = hits[field].sort((a, b) => b.idx - a.idx || (a.src === 'regex' ? -1 : 0));
            const pick = sorted[0];
            if (field === 'date') { const d = clockParseDateText(pick.val, prevYear) || pick.val; out.date = String(d).slice(0, 10); }
            else if (field === 'time') { const t = clockNormTime(pick.val); out.time = (t || pick.val).slice(0, 20); }
            else out.location = cleanValue(pick.val, 60);
            out.source[field] = pick.src;
            picked[field] = {
                val: pick.val, idx: pick.idx, src: pick.src, raw: pick.raw || '',
                others: sorted.slice(1).map((c) => ({ val: c.val, idx: c.idx, src: c.src, raw: c.raw || '' })),
            };
        }
        // v2.37.0：候选/采用值经**侧信道**导出（`clockExtractDiag()`），**不写进返回对象** ——
        //   返回结构必须与 V1 逐字一致（黄金样本用 `J(got)===J(oracle)` 校验）。
        lastExtractDiag = { picked, candidates: hits, html: html };
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
    // v2.37.0：追踪对象**不进 out**（保持与 V1 逐字一致的返回结构，黄金样本继续按 `J(got)===J(oracle)` 校验），
    //   而是存进 `core/clock-trace.js` 的环形缓冲，由 `FTT.clockTrace()` / 调试页 / 日志读取。
    const trace = clockTraceStart('resolve', '统一解析剧情时钟（多源择优 + 降级）');
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
            clockTraceChain(trace, '① 手工强制改写（cfg.clockManualLock 默认锁定）');
            clockTracePick(trace, 'date', { value: out.date, from: out.source.date, why: manual.date ? '手工值直接采用；锁定中，自动提取不覆盖' : '手工未给日期 → 沿用已有值' });
            clockTracePick(trace, 'time', { value: out.time, from: out.source.time || (out.time ? 'prev' : ''), why: manual.time ? '手工值直接采用；锁定中，自动提取不覆盖' : '手工未给时间 → 沿用已有值' });
            clockTracePick(trace, 'location', { value: out.location, from: out.source.location || (out.location ? 'prev' : ''), why: manual.location ? '手工值直接采用；锁定中，自动提取不覆盖' : '手工未给地点 → 沿用已有值' });
            clockTraceDegrade(trace, { degraded: false, reason: '', detail: '手工锁定：跳过正文/数据侧全部候选' });
            const presText0 = String(o.text != null ? o.text : (textHooks.latestAiText() || '')).trim();
            const pres = resolvePresentNames(presText0, latestPlotByFloor());
            out.source.present = pres.source;
            out.present = pres.list;
            clockTracePick(trace, 'present', { value: (pres.list || []).join('、'), from: pres.source, why: pres.source === 'latest-ai' ? '最新 AI 正文里点名到已建档角色' : (pres.source === 'plot-atom' ? '最新情节的涉及角色' : '本轮无点名 → 沿用旧名单（不限制）') });
            clockTraceFinish(trace);
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
        // 取文来源（追踪用）：模式 + 楼层来源 + 字符数 + 样本前 80 字
        // 注意：`last` 在上面的 if 块内声明（块级作用域），此处必须重新取楼层号 —— 否则追踪构造会抛 ReferenceError
        //   并被外层 catch 吞掉 → 表现为「解析结果突然变空」（本批实际踩到过，故在此留注释与回归断言）。
        const traceLastId = Number(getLastMessageId());
        const floorsTxt = (() => {
            if (mode === 'latest-ai') return '第' + traceLastId + '楼（最新 AI 回复）';
            if (mode === 'floor-window') return ('第' + Math.max(0, traceLastId - (Number(cfg && cfg.feedFloors) || 2) + 1) + '-' + traceLastId + '楼（窗口回退·仅日期/时间/地点）');
            if (mode === 'given') return '调用方给定';
            return '（无正文）';
        })();
        clockTraceText(trace, { mode, floors: floorsTxt, chars: text.length, sample: text.slice(0, 80) });
        clockTraceChain(trace, mode === 'floor-window' ? '② 取文：最新 AI 正文为空 → 回退楼层窗口（在场角色不参与）' : (mode === 'none' ? '② 取文：没有可用正文' : '② 取文：最新 AI 正文'));
        let r = null;
        let diag = null;
        if (text) { try { r = extractClockFromText(text, prev); diag = clockExtractDiag(); } catch (e) { r = null; } }
        // v2.44.0：HTML 清洗**如实入追踪**（用户要求「取值逻辑可追踪」）——回答「地点为什么少了标签」
        const htmlDiag = (diag && diag.html) ? diag.html : null;
        const htmlDropped = htmlDiag ? (Number(htmlDiag.tags) || 0) + (Number(htmlDiag.entities) || 0) : 0;
        if (htmlDropped > 0) {
            clockTraceNote(trace, '已剔除正文中的 HTML：标签 ' + (Number(htmlDiag.tags) || 0) + ' 处'
                + (Number(htmlDiag.entities) ? ('、实体 ' + htmlDiag.entities + ' 处') : '')
                + (htmlDiag.block && htmlDiag.block.length ? ('（如 ' + htmlDiag.block.join(' ') + '）') : '')
                + ' —— 避免 `<br>` 之类标签被当作地点/场景写入数据');
        }
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
        // ── 追踪：正文侧候选（含原始片段）与降级判定 ──
        clockTraceChain(trace, '③ 正文侧候选：正文头结构 > 日期正则/自定义正则 > 标记式 > 相对日期推进（各取最后一次命中）');
        clockTraceChain(trace, '④ 数据侧候选：最新情节 > 原子数据最新日期 > 沿用已有值（按日期字符串取最大，同日按 情节>正文>原子>沿用 优先级）');
        // 正文侧落选候选 + **如实**的落选原因（正文头结构带位置加成 / 纯时段词权重更低 / 同来源取最后一次）
        const rejectSeen = {};
        const rejectOnce = (cand) => {
            const key = [cand.field, cand.value, cand.from, Number(cand.idx) || 0].join('\u0001');
            if (rejectSeen[key]) { rejectSeen[key] += 1; return; }
            rejectSeen[key] = 1;
            clockTraceReject(trace, cand);
        };
        const loserWhy = (field, cand, pickSrc, pickIdx, pickVal) => {
            if (String(cand.val) === String(pickVal)) return '与采用值**相同**但来源不同（同值副本 → 采用更优先的来源）';
            if (field === 'time' && cand.src === 'daypart') return '纯时段词权重低于带数字的时间（正文侧归一规则）';
            if (pickSrc === 'header' && cand.src !== 'header') return '正文头结构（▷/▶）带位置加成，压过同文本里的零散命中（v1.188）';
            if (Number(cand.idx) < Number(pickIdx)) return '同来源中更早出现（正文侧取**最后一次**命中）';
            return '命中位置/来源优先级排在采用值之后';
        };
        if (r && diag && diag.picked) {
            for (const f of ['date', 'time', 'location']) {
                const pk = diag.picked[f];
                if (!pk) continue;
                for (const o2 of (pk.others || [])) {
                    rejectOnce({ field: f, value: o2.val, from: o2.src, idx: o2.idx, raw: o2.raw, why: loserWhy(f, o2, pk.src, pk.idx, pk.val) });
                }
            }
        }
        if (probeDate) {
            clockTracePick(trace, 'date.probe', { value: probeDate, from: (r && r.source && r.source.date) || 'regex', why: '正文侧解析出的日期（参与择优与异常判定）' });
        }
        clockTraceDegrade(trace, {
            degraded: forceDegrade || anomaly.bad || !probeDate,
            reason,
            detail: forceDegrade ? '设定 clockForceDegrade=true → 强制走降级路径'
                : (anomaly.bad ? ('正文日期 ' + probeDate + ' 与参考锚点（' + String(prev.date || (plot && plot.date) || (glob && glob.date) || '（无）') + '）比较：' + anomaly.reason + (anomaly.years ? ('（相差 ' + anomaly.years + ' 年）') : ''))
                    : (probeDate ? '' : '正文侧没有解析出合法日期')),
        });
        clockTraceChain(trace, '⑤ 日期异常闸门：格式非法 / 年份远超当前时钟 / 剧情时间大幅倒退 → 该正文日期不采用（降级）');
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
            // ── 追踪：日期取值与落选候选（说清「为什么是它」） ──
            const dateWhy = {
                regex: '正文侧解析出的日期（正文头结构优先；正则取最后一次命中），且通过异常闸门',
                plot: '最新情节节点的日期（正文侧没有可用日期 / 正文日期被判定异常）',
                'atom-latest': '原子数据里最新存在日期（正文与情节都不可用时降级）',
                prev: '沿用当前剧情时钟（没有更新的候选）',
            }[win.src] || '按择优规则采用';
            // 正文侧的精确来源：V1 的 `out.source.date` 对正文侧**统一标成 'regex'**（即使实际来自正文头结构，
            //   见 v1.206 `regexCand = { date: probeDate, src: 'regex' }`）。追踪用**精确来源**（header/regex），
            //   并把这处 V1 口径差异记进备注，避免日志把「正文头结构」误报成「正文正则」。
            const bodySrc = (r && r.source && r.source.date === 'header') ? 'header' : 'regex';
            const traceSrc = (out.source.date === 'regex') ? bodySrc : out.source.date;
            if (out.source.date === 'regex' && bodySrc === 'header') clockTraceNote(trace, 'V1 口径 out.source.date 对正文侧统一记为 "regex"；本次实际命中「正文头结构（▷/▶）」（追踪按精确来源记录）');
            clockTracePick(trace, 'date', { value: out.date, from: traceSrc, why: dateWhy + '；比较口径：日期字符串取最大，同日按 最新情节>正文>原子降级>沿用旧值' });
            for (const c of cands.slice(1)) {
                rejectOnce({
                    field: 'date', value: c.date, from: c.src,
                    why: '择优未选中：' + (String(c.date) < String(win.date) ? '日期更早' : '同日但来源优先级更低（最新情节>正文>原子降级>沿用旧值）'),
                });
            }
            if (probeDate && !regexCand) {
                clockTraceReject(trace, { field: 'date', value: probeDate, from: (r && r.source && r.source.date) || 'regex', why: '正文日期未通过异常闸门（' + (anomaly.reason || '格式非法') + '）→ 不参与择优' });
            }
        } else if (degrade) {
            out.degradeReason = reason;
            clockTraceReject(trace, { field: 'date', value: probeDate || '（无）', from: (r && r.source && r.source.date) || 'regex', why: '降级：' + (reason || '无可用日期') + ' → 无候选，保持原值' });
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
        // ── 追踪：时间 / 地点（说明「与胜出日期同源优先 → 同一天其它来源」这条链） ──
        const chainTxt = out.date ? '与胜出日期同源优先 → 同日期的其它来源' : '正文 → 最新情节 → 原子数据';
        const sideWhy = { regex: '正文正则/正文头结构命中', header: '正文头结构（▷/▶）命中', custom: '自定义正则命中', marker: '标记式命中', daypart: '正文只有纯时段词（权重低于带数字的时间）', plot: '取最新情节节点', 'atom-latest': '取原子数据最新节点', scene: '降级路径补「最新场景」' };
        clockTracePick(trace, 'time', { value: out.time, from: out.source.time, why: (out.time ? '按「' + chainTxt + '」取值；' : '本次没有可用时间；') + (sideWhy[out.source.time] || '') });
        clockTracePick(trace, 'location', { value: out.location, from: out.source.location, why: (out.location ? '按「' + chainTxt + '」取值；' : '本次没有可用地点；') + (sideWhy[out.source.location] || '') });
        for (const c of order) {
            const src = srcOf(c);
            if (c && c.time && out.time && String(c.time).slice(0, 20) !== out.time) clockTraceReject(trace, { field: 'time', value: String(c.time).slice(0, 20), from: src, why: '已有更优先来源提供时间 → 未采用（' + chainTxt + '）' });
            if (c && c.location && out.location && String(c.location).slice(0, 60) !== out.location) clockTraceReject(trace, { field: 'location', value: String(c.location).slice(0, 60), from: src, why: '已有更优先来源提供地点 → 未采用（' + chainTxt + '）' });
        }
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
                if (clockDateValid(d)) { out.date = d; out.source.date = 'storyday'; clockTracePick(trace, 'date', { value: d, from: 'storyday', why: '正文只给「第 ' + out.storyDay + ' 天」→ 按设定 clockStoryDayEpoch（' + epoch.slice(0, 10) + '）换算成日期' }); }
            }
        } catch (e) { /* 忽略 */ }
        // 降级时地点补「最新的场景」（仅在降级路径且前面没能给出地点时）
        if (degrade && !out.location) {
            try {
                const sc = latestSceneLocation();
                if (sc) { out.location = String(sc).slice(0, 60); out.source.location = 'scene'; clockTracePick(trace, 'location', { value: out.location, from: 'scene', why: '降级路径 + 前面没有地点 → 补「最新场景」（按 floorEnd/uses/路径长度排序取最新）' }); }
            } catch (e) { /* 忽略 */ }
        }
        // 在场角色：只聚焦最新 AI 正文或最新情节分析（窗口回退文本不用于在场，避免跨楼层扩散）
        const presText = (mode === 'latest-ai' || mode === 'given') ? text : '';
        const pres = resolvePresentNames(presText, plot);
        out.source.present = pres.source;
        out.present = pres.list;
        clockTraceChain(trace, '⑥ 在场角色：只聚焦最新 AI 正文 / 最新情节（窗口回退文本不参与，避免跨楼层扩散）');
        clockTracePick(trace, 'present', {
            value: (pres.list || []).join('、'),
            from: pres.source,
            why: pres.source === 'latest-ai' ? '最新 AI 正文里点名到已建档角色'
                : (pres.source === 'plot-atom' ? '最新情节的涉及角色（正文无点名）'
                    : '本轮无点名 → 沿用旧名单（不清空）'),
        });
        clockTraceFinish(trace);
        return out;
    } catch (e) { clockTraceFinish(trace, '统一解析剧情时钟（异常中止）'); return out; }
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
        // v2.37.0：取本次解析的取值追踪（`resolveStoryClock` 已写入环形缓冲），用于补「实际落盘差异」并写日志
        const trace = clockTraceLast('resolve');
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
                // v2.37.0 修复：V1 这里比较 `Number(state.state.storyDay) !== sd`，而 V2 的 `emptyState()` **没有 storyDay 键**
                //   → `Number(undefined) === NaN !== 0` 恒成立 → **每次提取都误判为「有改动」**（多写一次 state、
                //   日志恒为「自动解析剧情时钟」）。改为把缺失键视作 0（V1 的 state 本来就带该键，故语义等价）。
                const curSd = Number(state.state.storyDay) || 0;
                if (curSd !== sd) { state.state.storyDay = sd; changed = true; }
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
        // 来源中文标签统一取自 core/clock-trace.js（**全量登记**：正则/正文头/自定义正则/标记式/纯时段词/相对推进/
        //   纪元换算/最新情节/原子降级/最新场景/沿用旧值/手工——此前日志与面板各有一份**残缺**映射，缺键会打印英文原键）
        const srcLabel = {};
        const srcLabelOf = (k) => { const key = String(k || ''); if (!key) return ''; if (!srcLabel[key]) srcLabel[key] = clockSrcLabel(key); return srcLabel[key]; };
        // 日志里的「来源」优先取追踪记录的**精确**来源（V1 的 `out.source.date` 对正文侧统一记 'regex'，
        //   即使实际来自正文头结构 → 直接用它会把「正文头结构」误报成「正文正则」）
        const traceSrcLabel = (field, fallbackKey) => {
            const p = trace && trace.picks ? trace.picks[field] : null;
            return (p && p.fromLabel) ? p.fromLabel : srcLabelOf(fallbackKey);
        };
        // 落盘差异（prev → next）：供日志/调试页回答「这次到底改了什么、没改什么」
        const appliedFields = [
            { field: 'date', from: prev.date, to: String((state.state && state.state.date) || ''), changed: !manualLocked && !!res.date && res.date !== prev.date },
            { field: 'time', from: prev.time, to: String((state.state && state.state.time) || ''), changed: !manualLocked && !!res.time && res.time !== prev.time },
            { field: 'location', from: prev.location, to: String((state.state && state.state.location) || ''), changed: !manualLocked && !!res.location && res.location !== prev.location },
        ];
        if (trace) {
            clockTraceApplied(trace, {
                fields: appliedFields,
                locked: manualLocked,
                unchanged: appliedFields.filter((x) => !x.changed).map((x) => x.field + (manualLocked ? '（手工锁定）' : '（本轮无新值或同值）')),
                present: { list: Array.isArray(state.state.present) ? state.state.present.slice() : null, from: res.source.present, changed: presChanged },
                note: seenChanged ? '另有「最后一次见面时间」标记更新' : '',
            });
            clockTraceFinish(trace);   // 幂等：把同一条追踪移到缓冲首位（不重复）
        }
        if (changed || presChanged || seenChanged) {
            try { saveState(); } catch (e) { /* 忽略 */ }
            // 剧情日期推进 → 顺带调度状态记录衰退
            if (changed) { try { scheduleStateDecay(); } catch (e) { /* 忽略 */ } }
            try {
                const t = trace || null;
                dbgLog('时钟', {
                    // —— 与既有口径兼容的字段（语义不变，便于既有检索习惯） ——
                    action: changed ? '自动解析剧情时钟/在场（多源择优 + 降级）' : '在场/见面时间维护（日期·时间·地点本轮无改动）',
                    text: res.textMode === 'latest-ai' ? (lastId + '(最新AI回复)') : (res.textMode === 'floor-window' ? ('第' + Math.max(0, lastId - (Number(cfg.feedFloors) || 2) + 1) + '-' + lastId + '楼(窗口回退·仅日期/时间/地点)') : res.textMode),
                    date: state.state.date, dateFrom: traceSrcLabel('date', res.source.date), dateFromV1: srcLabelOf(res.source.date),
                    time: state.state.time, timeFrom: traceSrcLabel('time', res.source.time),          // v2.37.0：补上原来缺的「时间来源」
                    location: state.state.location, locationFrom: traceSrcLabel('location', res.source.location),   // 同上：地点来源
                    present: state.state.present, presentFrom: traceSrcLabel('present', res.source.present),
                    degraded: !!res.degraded, jumpYears: res.jumpYears || 0,
                    // —— v2.37.0「取值追踪」：从哪取的值 / 取值逻辑 / 有什么没被采用 / 实际改了什么 ——
                    traceId: t ? t.id : '',
                    textMode: res.textMode, textChars: t ? t.text.chars : 0, textFloors: t ? t.text.floors : '', sample: t ? t.text.sample : '',
                    dateWhy: t && t.picks.date ? t.picks.date.why : '',
                    timeWhy: t && t.picks.time ? t.picks.time.why : '',
                    locationWhy: t && t.picks.location ? t.picks.location.why : '',
                    presentWhy: t && t.picks.present ? t.picks.present.why : '',
                    chain: t ? t.chain : [],
                    rejects: t ? t.rejects.slice(0, 6).map((r) => r.field + '=' + r.value + '←' + r.fromLabel + '（' + r.why + '）') : [],
                    rejectsTotal: t ? t.rejects.length : 0,
                    degradeReason: clockDegradeLabel(res.degradeReason || ''),
                    applied: appliedFields.filter((x) => x.changed).map((x) => x.field + '：' + (x.from || '（空）') + ' → ' + (x.to || '（空）')),
                    unchanged: manualLocked ? '手工锁定（日期/时间/地点未覆盖）' : appliedFields.filter((x) => !x.changed).map((x) => x.field).join('/'),
                    seenStamped: seenChanged ? 1 : 0,
                    how: '取值追踪：FTT.clockTrace() / 设定→调试「🕒 时钟取值追踪」；来源键见 core/clock-trace.js#CLOCK_SRC_LABEL',
                });
            } catch (e) {
                // 时钟日志**构造失败不得静默**（v2.37.0）：写入「异常」类，便于排障时发现日志缺口的真实原因
                try { dbgLog('异常', { kind: '时钟取值日志构造失败', message: String((e && e.message) || e), stage: 'extract' }); } catch (e2) { /* 忽略 */ }
            }
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
