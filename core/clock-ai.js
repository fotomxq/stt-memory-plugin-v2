// ============================================================
// core/clock-ai.js —— **时钟域 AI 管线**（B8-3，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① `genClockRegexes`（v1.184「AI 捕捉正文 → 生成正则」）：取最近 N 楼投喂文本 → AI 产出
//      {日期正则 / 时间正则 / 地点正则 / 说明} → JS **三重校验**（可编译 / 不匹配空串 / 样本确有命中）→
//      写入 `cfg.clockDateRegex`/`clockTimeRegex`/`clockLocationRegex` → 用样本**试算**并回报；
//   ② `clockRepairPack` / `buildClockRepairPrompt` / `applyClockRepairResult` / `runClockRepair`（v1.185「AI 结合正文修复」）：
//      把异常条目连同近期正文交 AI 判定；**只允许改 日期 / 时间 两个字段**，逐条过同一安全闸门
//      （`clockPatrolSafeDate`：格式合法 + 不触发年份异常），不合格丢弃；「清除」清空该字段；「无法判定」如实回报。
// 适配（与 V1 的差别）：AI 调用与取文经**注入钩子**（`setClockAiHooks`：`callAi` / `feedText` / `busy`），
//   内核不直连网络也不读宿主聊天；提示经 `notifyHooks`；面板重绘由 UI 层负责。
//   未移植 V1 的「任务管线占用」UI 提示（`pipeStart/pipeUpdate/pipeEnd`/`abortTick`）：V2 用 `busy()` 钩子
//   **在任务在途时直接拒绝**（与 B7-2 同步的处置一致），失败如实回报。
// 一致性由 tests/unit/clock-ai-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { cfg, state, saveState, saveCfg, notifyHooks, dbgLog } from './model/runtime.js';
import { extractJsonObject } from './util.js';
import { PROMPT_TEMPLATES_V2, normalizeDeltaKeys } from './config.js';
import { clockNormTime } from './clock.js';
import { clockPatrolAnchor, clockPatrolSafeDate, clockPatrolScan, CLOCK_DIM_LABEL } from './clock-patrol.js';
import { extractClockFromText } from './clock-extract.js';
import { setAiHooks, aiCallText, aiFeedText, aiBusy } from './ai-hooks.js';

// ---------- 注入钩子（宿主接线：AI 调用 / 投喂文本 / 长任务占用） ----------
// 钩子由 `core/ai-hooks.js` 统一持有（与内容弱化 NSFW、后续修复域共用同一接线）；
// `setClockAiHooks` 保留为兼容别名（B8-3 的调用方与测试使用）。
export function setClockAiHooks(next) { return setAiHooks(next); }

/** 提示词模板（配置优先 → 内置默认） */
function promptTpl(key, fallback) {
    try {
        const v = String((cfg.promptTemplates && cfg.promptTemplates[key]) || (PROMPT_TEMPLATES_V2 && PROMPT_TEMPLATES_V2[key]) || '').trim();
        return v || fallback;
    } catch (e) { return fallback; }
}
/** 用户提示（V1 `notify(kind,{title,text})` → 宿主通知钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/** AI 调用封装（统一成纯文本；失败返回空串） */
function callAiText(messages, label) { return aiCallText(messages, label); }
/** 长任务占用（钩子缺失/异常 → 视为不占用） */
function busyNow() { return aiBusy(); }

// ==================== ① AI 捕捉正文 → 生成时钟正则（v1.184） ====================
/** 校验 AI 返回的正则：去包裹 → 可编译 → 不匹配空串 */
function normalizeClockRegexFromAi(v) {
    try {
        let s = String(v == null ? '' : v).trim();
        if (!s) return { ok: false, reason: 'empty', re: '' };
        // 去掉 /…/gi 包裹与代码块标记
        s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
        const m = /^\/(.+)\/([gimsuy]*)$/.exec(s);
        if (m) s = m[1];
        if (!s) return { ok: false, reason: 'empty', re: '' };
        // 可编译 + 不能匹配空串（避免无限匹配/吞掉正文）
        try { new RegExp(s, 'g'); } catch (e) { return { ok: false, reason: 'invalid', re: s }; }
        try { if (new RegExp(s).test('')) return { ok: false, reason: 'matches-empty', re: s }; } catch (e) { /* 忽略 */ }
        return { ok: true, reason: '', re: s };
    } catch (e) { return { ok: false, reason: 'error', re: '' }; }
}
/** 提示词（V1 `buildClockRegexPrompt`） */
function buildClockRegexPrompt(sample) {
    const tpl = promptTpl('clockRegexGen', '从正文样本中总结「日期 / 时间 / 地点」的书写规律，输出三条 JavaScript 正则（不带斜杠与标志位）。');
    return [
        { role: 'system', content: tpl },
        { role: 'user', content: `【正文样本】\n${String(sample || '').slice(-6000)}\n\n输出：只输出一个合法 JSON 对象：{"日期正则":"…","时间正则":"…","地点正则":"…","说明":"…"}（正则不带 / 与 g 标志；不要输出代码块标记）。` },
    ];
}
/**
 * 用样本试算正则命中数（V1 `test`）。
 * @returns {number} 命中次数（正则可编译且样本命中）
 */
function countRegexHits(re, sample) {
    if (!re || !re.ok) return 0;
    try { const rr = new RegExp(re.re, 'g'); const hits = String(sample).match(rr); return hits ? hits.length : 0; } catch (e) { return 0; }
}
/**
 * 纯函数：把 AI 返回的解析对象应用到 cfg（三重校验 + 命中判定 + 写回 + 试算）。
 * @returns {{applied:string[], skipped:string[], hits:object, probe:object, regexes:object}}
 */
function applyClockRegexResult(sample, parsed) {
    const j = parsed || {};
    const pick = (k, en) => (j[k] !== undefined ? j[k] : j[en]);
    const dr = normalizeClockRegexFromAi(pick('日期正则', 'dateRegex'));
    const tr = normalizeClockRegexFromAi(pick('时间正则', 'timeRegex'));
    const lr = normalizeClockRegexFromAi(pick('地点正则', 'locationRegex'));
    const applied = [];
    const skipped = [];
    const hits = { date: countRegexHits(dr, sample), time: countRegexHits(tr, sample), location: countRegexHits(lr, sample) };
    if (dr.ok && hits.date > 0) { cfg.clockDateRegex = dr.re; applied.push(`日期（命中 ${hits.date} 处）`); } else skipped.push('日期' + (dr.ok ? '（样本无命中）' : `（${dr.reason}）`));
    if (tr.ok && hits.time > 0) { cfg.clockTimeRegex = tr.re; applied.push(`时间（命中 ${hits.time} 处）`); } else skipped.push('时间' + (tr.ok ? '（样本无命中）' : `（${tr.reason}）`));
    if (lr.ok && hits.location > 0) { cfg.clockLocationRegex = lr.re; applied.push(`地点（命中 ${hits.location} 处）`); } else skipped.push('地点' + (lr.ok ? '（样本无命中）' : `（${lr.reason}）`));
    // 试算：用新正则跑一遍样本
    let probe = { date: '', time: '', location: '' };
    try { probe = extractClockFromText(sample, { date: String((state.state && state.state.date) || ''), time: '', location: '' }); } catch (e) { /* 忽略 */ }
    return { applied, skipped, hits, probe, regexes: { date: cfg.clockDateRegex || '', time: cfg.clockTimeRegex || '', location: cfg.clockLocationRegex || '' }, note: String(pick('说明', 'note') || '').slice(0, 120) };
}
/**
 * 「AI 捕捉正文 → 生成正则」（设定页按钮；V1 `genClockRegexesFromText`）。
 * @param {object} [opts] floors（取最近 N 楼；默认 `cfg.feedFloors`）/ sample（显式样本，测试与调试）
 */
async function genClockRegexes(opts) {
    const o = opts || {};
    try {
        if (busyNow()) {
            notify('warning', '任务进行中', '已有分析/修复/同步任务在运行，请稍候再试。');
            return { ok: false, blocked: true };
        }
        const floors = Math.max(1, Number(o.floors) || Number(cfg.feedFloors) || 10);
        const sample = String(o.sample != null ? o.sample : aiFeedText(floors)).trim();
        if (!sample) {
            notify('error', 'AI 捕捉正则：没有可用正文', '最近楼层没有可分析的正文（或在投喂过滤后为空）。');
            return { ok: false, reason: 'no-text' };
        }
        const resp = await callAiText(buildClockRegexPrompt(sample), 'AI 捕捉时钟正则');
        if (!resp) { notify('warning', 'AI 捕捉正则：无返回', 'AI 未返回内容（可能未配置模型或请求失败）。'); return { ok: false, reason: 'no-ai' }; }
        const parsed = extractJsonObject(resp) || {};
        const r = applyClockRegexResult(sample, parsed);
        try { saveCfg(); } catch (e) { /* 落盘失败不阻塞 */ }
        if (r.applied.length) {
            notify('success', 'AI 捕捉正则完成',
                `已应用：${r.applied.join(' · ')}${r.skipped.length ? `；未采用：${r.skipped.join(' / ')}` : ''}。试算结果：日期 ${r.probe.date || '（未识别）'} · 时间 ${r.probe.time || '（未识别）'} · 地点 ${r.probe.location || '（未识别）'}${r.note ? `。说明：${r.note}` : ''}`);
        } else {
            notify('warning', 'AI 捕捉正则：未采用任何正则', `未采用：${r.skipped.join(' / ')}。可能是样本里没有明确的时间/地点写法，或 AI 返回的正则不适合本插件（会匹配空串 / 无法编译）。`);
        }
        try { dbgLog('时钟', { action: 'AI 捕捉时钟正则（v1.184）', floors, chars: sample.length, dateRe: r.regexes.date, timeRe: r.regexes.time, locationRe: r.regexes.location, hits: r.hits, probe: r.probe, note: r.note }); } catch (e) { /* 忽略 */ }
        return { ok: r.applied.length > 0, applied: r.applied, skipped: r.skipped, hits: r.hits, probe: r.probe, regexes: r.regexes };
    } catch (e) {
        notify('error', 'AI 捕捉正则失败', String((e && e.message) || e).slice(0, 120));
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// ==================== ② AI 结合正文修复日期时间（v1.185） ====================
/** 打包异常条目（V1 `clockRepairPack`）：单次提交上限 `cfg.clockRepairBatch`（默认 20，硬上限 200） */
function clockRepairPack(opts) {
    void opts;                                    // V1 签名保留（当前无选项）
    const cap = Math.max(1, Math.min(200, Number((cfg && cfg.clockRepairBatch) || 20)));
    const out = { anchor: '', anchorUsable: false, anchorSource: '', entries: [], total: 0, truncated: 0 };
    try {
        const scan = clockPatrolScan();
        out.anchor = scan.anchor;
        out.anchorUsable = scan.anchorUsable;
        out.anchorSource = scan.anchorSource;
        out.total = scan.findings.length;
        const picked = scan.findings.slice(0, cap);
        out.truncated = Math.max(0, scan.findings.length - picked.length);
        let n = 0;
        for (const f of picked) {
            const dim = f.dim;
            const it = (state[dim] || []).find(x => x && String(x.id) === String(f.id));
            if (!it) continue;
            n++;
            const text = [it.title, it.text, it.content, it.desc, it.note, it.causalLine].filter(Boolean).join(' ｜ ');
            const floors = (Number(it.floorStart) || 0) && (Number(it.floorEnd) || 0) ? `第 ${it.floorStart}-${it.floorEnd} 楼` : '';
            out.entries.push({
                n, dim, id: String(it.id), field: f.field, value: String(f.value || ''), reason: f.reason,
                label: CLOCK_DIM_LABEL[dim] || dim,
                date: String(it.date || ''), time: String(it.time || ''),
                text: String(text).slice(0, 300), floors,
            });
        }
        return out;
    } catch (e) { return out; }
}
/** 提示词（V1 `buildClockRepairPrompt`；floorsText 未传时经注入钩子取近期正文） */
function buildClockRepairPrompt(pack, floorsText) {
    try {
        const p = pack || clockRepairPack();
        if (!p.entries.length) return null;
        const tpl = promptTpl('clockRepair', '结合正文判断每条异常的日期/时间应为什么值；只输出 JSON（修正/清除/无法判定）。');
        const REASON = { invalid: '日期格式非法或不存在', jump: '年份远超当前剧情时钟', backward: '年份早于当前剧情时钟过多', 'time-invalid': '时间写法不规范' };
        const lines = p.entries.map(e => `#${e.n} ｜ ${e.label} ｜ 字段：${e.field === 'time' ? '时间' : '日期'} ｜ 现值：${e.value || '（空）'} ｜ 问题：${REASON[e.reason] || e.reason} ｜ 当前登记：日期 ${e.date || '（空）'} · 时间 ${e.time || '（空）'}${e.floors ? ` ｜ ${e.floors}` : ''}\n   内容：${e.text || '（无）'}`);
        const ctxRaw = (floorsText == null)
            ? aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10))
            : String(floorsText);
        const ctx = ctxRaw.slice(-8000);
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释。` },
            { role: 'user', content: `【时间锚点】当前剧情时钟：${p.anchor || '（无）'}\n\n【近期正文（判断依据，优先依据）】\n${ctx || '（无正文）'}\n\n【待修复清单（本次唯一工作对象，共 ${p.entries.length} 条）】\n${lines.join('\n')}\n\n输出：{"修正":[{"编号":1,"日期":"YYYY-MM-DD","时间":"傍晚","依据":"…"}],"清除":[2],"无法判定":[3]}（按 #编号 引用；无改动就给空数组）。` },
        ];
    } catch (e) { return null; }
}
/** 应用 AI 结果（V1 `applyClockRepairResult`）：只改 日期/时间，逐条过安全闸门 */
function applyClockRepairResult(pack, delta) {
    const out = { applied: 0, cleared: 0, skipped: 0, unknown: 0, details: [] };
    try {
        const p = pack || { entries: [], anchor: '' };
        const byN = new Map();
        for (const e of p.entries) byN.set(Number(e.n), e);
        const anchor = p.anchor || clockPatrolAnchor();
        const d = delta || {};
        const fix = (d['修正'] !== undefined) ? d['修正'] : d.fix;
        const clr = (d['清除'] !== undefined) ? d['清除'] : d.clear;
        const unk = (d['无法判定'] !== undefined) ? d['无法判定'] : d.unknown;
        for (const raw of (Array.isArray(fix) ? fix : [])) {
            try {
                if (!raw || typeof raw !== 'object') { out.skipped++; continue; }
                const n = Number(String(raw['编号'] !== undefined ? raw['编号'] : raw.n).replace(/[^0-9]/g, ''));
                const e = byN.get(n);
                if (!e) { out.skipped++; continue; }
                const it = (state[e.dim] || []).find(x => x && String(x.id) === String(e.id));
                if (!it) { out.skipped++; continue; }
                const dateRaw = String(raw['日期'] !== undefined ? raw['日期'] : (raw.date || '')).trim();
                const timeRaw = String(raw['时间'] !== undefined ? raw['时间'] : (raw.time || '')).trim();
                const note = String(raw['依据'] !== undefined ? raw['依据'] : (raw.basis || '')).slice(0, 40);
                let changed = false;
                if (dateRaw) {
                    // 统一走安全闸门（格式合法 + 有锚点时不触发年份异常）；无锚点 → 一律不写日期
                    const safe = clockPatrolSafeDate(dateRaw, anchor);
                    if (safe) { it.date = safe; changed = true; }
                    else out.skipped++;
                }
                if (timeRaw) {
                    const t = clockNormTime(timeRaw) || (/^(凌晨|清晨|早晨|早上|上午|中午|午间|午后|下午|傍晚|黄昏|晚上|夜晚|深夜|夜里|半夜|午夜)$/.test(timeRaw) ? timeRaw : '');
                    if (t) { it.time = t; changed = true; } else out.skipped++;
                }
                if (changed) { out.applied++; out.details.push(`${e.label} #${n} → ${it.date || '（空）'}${it.time ? ' ' + it.time : ''}${note ? `（${note}）` : ''}`); }
            } catch (e) { out.skipped++; }
        }
        for (const raw of (Array.isArray(clr) ? clr : [])) {
            try {
                const n = Number(String(raw).replace(/[^0-9]/g, ''));
                const e = byN.get(n);
                if (!e) { out.skipped++; continue; }
                const it = (state[e.dim] || []).find(x => x && String(x.id) === String(e.id));
                if (!it) { out.skipped++; continue; }
                if (e.field === 'time') it.time = ''; else it.date = '';
                out.cleared++;
                out.details.push(`${e.label} #${n} → 清空${e.field === 'time' ? '时间' : '日期'}`);
            } catch (e) { out.skipped++; }
        }
        for (const raw of (Array.isArray(unk) ? unk : [])) {
            try { const n = Number(String(raw).replace(/[^0-9]/g, '')); if (byN.get(n)) out.unknown++; } catch (e) { /* 忽略 */ }
        }
        return out;
    } catch (e) { return out; }
}
/**
 * 「AI 结合正文修复日期时间」（设定页按钮；V1 `runClockRepair`）
 * @param {object} [opts] silent / aiText（显式 AI 返回文本，测试用）/ floorsText
 */
async function runClockRepair(opts) {
    const o = opts || {};
    try {
        const pack = clockRepairPack();
        if (!pack.total) {
            notify('info', '日期时间修复：无异常条目', `巡检 ${clockPatrolScan().scanned} 条原子数据（锚点 ${pack.anchor || '（无剧情日期）'}）：没有需要修复的日期/时间。`);
            return { made: 0, skipped: true, total: 0 };
        }
        // 必须有可信锚点才让 AI 改日期（否则模型容易按现实年份给出「合法但错误」的日期）
        if (pack.anchorUsable === false) {
            notify('warning', '日期时间修复：缺少可信锚点',
                '当前剧情日期不可用、原子数据也没有可信的多数年份 → 为避免把现实年份写进剧情，本次未调用 AI 也未改动任何数据。请先在总览「✏️ 手工改写日期/时间/地点」设定正确的剧情日期，再点本按钮。');
            return { made: 0, skipped: true, blocked: true, noAnchor: true };
        }
        if (busyNow()) { notify('warning', '任务进行中', '已有修复任务在运行，请稍候。'); return { made: 0, blocked: true }; }
        const prompt = buildClockRepairPrompt(pack, o.floorsText);
        if (!prompt) { notify('info', '日期时间修复：无待修复条目', '清单为空。'); return { made: 0, skipped: true }; }
        const t0 = Date.now();
        notify('info', '开始修复日期时间（结合正文）…', `异常 ${pack.total} 条 · 本次提交 ${pack.entries.length} 条${pack.truncated ? `（余 ${pack.truncated} 条下次继续）` : ''} · 锚点 ${pack.anchor || '（无剧情日期）'}`);
        const resp = String(o.aiText != null ? o.aiText : await callAiText(prompt, '日期时间修复'));
        if (!resp) { notify('warning', '日期时间修复：AI 无返回', 'AI 未返回内容（可能未配置模型或请求失败），未改动任何数据。'); return { made: 0, error: 'no-ai', total: pack.total }; }
        const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
        const r = applyClockRepairResult(pack, delta);
        if (r.applied || r.cleared) { try { saveState(); } catch (e) { /* 忽略 */ } }
        const parts = [];
        if (r.applied) parts.push(`修正 ${r.applied} 条`);
        if (r.cleared) parts.push(`清空 ${r.cleared} 条`);
        if (r.skipped) parts.push(`丢弃不合格 ${r.skipped} 条`);
        if (r.unknown) parts.push(`无法判定 ${r.unknown} 条`);
        if (o.silent !== true) {
            notify(parts.length ? 'success' : 'warning', parts.length ? '日期时间修复完成' : '日期时间修复：AI 未给出可用结果',
                parts.length
                    ? `${parts.join(' · ')}；${r.details.length ? '例：' + r.details.slice(0, 3).join('；') : ''}`
                    : 'AI 未返回可用修正（可能正文里也没有可依据的时间表达）。可先用「🩺 时间巡检修复」（零 AI）做机械修复，或补齐正文后重试。');
        }
        try { dbgLog('时钟', { action: '时间修复（结合正文 · v1.185）', anchor: pack.anchor, total: pack.total, submitted: pack.entries.length, truncated: pack.truncated, applied: r.applied, cleared: r.cleared, skipped: r.skipped, unknown: r.unknown, ms: Date.now() - t0 }); } catch (e) { /* 忽略 */ }
        return { made: r.applied + r.cleared, applied: r.applied, cleared: r.cleared, skipped: r.skipped, unknown: r.unknown, total: pack.total, submitted: pack.entries.length, details: r.details };
    } catch (e) {
        notify('error', '日期时间修复失败', String((e && e.message) || e).slice(0, 120));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    normalizeClockRegexFromAi, buildClockRegexPrompt, applyClockRegexResult, genClockRegexes,
    clockRepairPack, buildClockRepairPrompt, applyClockRepairResult, runClockRepair,
};
