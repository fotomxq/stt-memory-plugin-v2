// ============================================================
// core/plot-segment.js —— **情节分段总结**（B8-7-a，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.182，情节页「🧩 分段总结」子页专用）：
//   把情节打包交 AI 拆成**多段总结**（每段以 `### 时间范围` 为头、段内逐行 `1. 线路名: 概述`），
//   归档进 `state.plotSegments`。**该产物不注入** —— 不参与召回 / 注入 / 世界书 / 遗忘 / 质检等任何自动动作，
//   只供人工查阅；**唯一消失途径 = 手动删除**（AI 运行永不删段、永不覆盖已存在的时间范围）。
//   两个入口共用同一批核心（切批 / 提示词 / 解析 / 只增不减落库）：
//     ① **自动**：`runPlotSegmentSummary()` —— 全部有效情节按剧情时间从早到晚切批（`plotSegmentBatchAtoms`，默认 30）；
//     ② **手动多选**：`runPlotSegmentSummarySelected(ids)` —— 只处理勾选的那些情节（不做增量覆盖判定）。
//   数据形态：`{ id, header(时间范围原文), start, end, lines:[{label,text}], atomIds[], atomCount,
//     floorStart, floorEnd, raw(Markdown 原文), uses, manual, createdAt, updatedAt }`（归一化在 `core/model/segment.js`）。
//   段落「同一个」判定 `plotSegmentSameRange`：规范化头文本相同，或日期区间重叠 ≥ 较短视频的 50%。
//   可选增量（`plotSegmentIncremental`，默认关）：批次内情节**全部**已被现有段落覆盖时跳过该批。
//
// 复用（不重复实现）：
//   · 段落归一化 / 解析 / Markdown 还原 / 排序 → `core/model/segment.js`（V1 同源，已有黄金样本）；
//   · 「有效情节清单」口径 → `core/merge.js#activeAtoms`（v1.203：已总结隐藏的不再进入分段总结批次）；
//   · 剧情时间排序 → `core/recall.js#atomTimeAsc`；日期解析 → `core/clock.js#storyDateMsFromStr`；
//   · AI 调用 → `core/ai-hooks.js#aiCallText`；互斥 → `aiBusy()`；提示 → `notifyHooks.toast`。
//
// 适配（与 V1 的差异，逐条见 docs/P8w-B8-7情节总结与分段总结.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/warn/notifyHooks）；
//   ② `busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 两处忙位判据
//      → 统一走宿主互斥钩子 `aiBusy()`（与 `core/repair.js#runRepair` 同一写法）；
//      V1 「`busy.repair` → 任务进行中」那一道的文案未复刻（V2 单一钩子无法区分），统一取**管线占用**文案；
//   ③ V1 的 `pipelineBlockInfo` 的「存储同步进行中」分支未移植（V2 的同步占用由宿主 `aiBusy()` 统一表达）；
//   ④ V1 的 `newTaskStart/abortTick/abortQuiet/pipeStart/pipeUpdate/pipeEnd/renderPanel` 未移植
//      （V2 无任务管线 UI，重绘由 UI 层负责）；
//   ⑤ 主流程增设可选 `opts.aiText` 注入点（与 `runRepair` / `runItemRepair` 同约定）。
//
// ⚠️ 与 V1 一致的**既有怪癖**（如实保留、不擅自修正，黄金样本已固化）：
//   · `plotSegmentBatchSize` 对「非正 / 非有限」值一律回落到默认 30（`-5` 也是 30，不是 1）；
//   · `buildPlotSegmentPrompt` 直接用批对象上的 `b.index`，而 `plotSegmentBatchesFrom` 产出的批次**没有 index**
//     （只有 `plotSegmentPlan` / `plotSegmentPlanForIds` 才补 `index`）→ 直接传原始批次时提示词里会出现「第 undefined 批」；
//   · `applyPlotSegmentResult` 的「保护已存在」分支（`plotSegmentProtectManual !== false`）只跳过、不改写；
//     关闭保护时**只覆盖正文与更新时间戳**，`header`/`start`/`end`/`atomIds` 保持原值；
//   · `runPlotSegmentSummary` 的 `o.maxBatches` 仅在调用方显式传入时生效（默认 12）。
// 一致性由 tests/unit/plot-segment-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, dbgLog, warn, notifyHooks } from './model/runtime.js';
import { activeAtoms, tombEntries } from './merge.js';
import { atomTimeAsc, atomDateValid } from './recall.js';
import { atomTitle } from './model/scalars.js';
import { normalizePlotSegment, parsePlotSegmentText, plotSegmentsToText } from './model/segment.js';
import { clockDateTrim, storyDateMsFromStr, dateStrCmp } from './clock.js';
import { defaultCfg } from './config.js';
import { aiCallText, aiBusy } from './ai-hooks.js';

/** 用户提示（V1 `notify(kind, {title, text})` 的 V2 等价；与 core/repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/** 单次打包给 AI 的情节条数（V1 `plotSegmentBatchSize`）：`plotSegmentBatchAtoms`（默认 30），
 *  非正/非有限 → 30，四舍五入后夹在 [1, 200]。 */
function plotSegmentBatchSize() {
    const n = Number(cfg && cfg.plotSegmentBatchAtoms);
    return Math.max(1, Math.min(200, Number.isFinite(n) && n > 0 ? Math.round(n) : 30));
}

/** 情节清单（V1 `plotSegmentAtomList`）：有效（`validity !== 'inactive'`、有正文或标题、未隐藏）
 *  且按剧情时间从早到晚排序。v1.203：已总结隐藏的不再进入分段总结批次。 */
function plotSegmentAtomList() {
    try {
        const atoms = activeAtoms().filter(a => a && a.validity !== 'inactive' && String(a.text || a.title || '').trim());
        return atoms.slice().sort(atomTimeAsc);
    } catch (e) { return []; }
}

/** 已覆盖情节 id 集合（V1 `plotSegmentCoveredIds`）：现有段落 `atomIds` 求并集。 */
function plotSegmentCoveredIds() {
    const set = new Set();
    try {
        for (const s of (state.plotSegments || [])) {
            for (const id of ((s && s.atomIds) || [])) { const k = String(id || ''); if (k) set.add(k); }
        }
    } catch (e) { /* 忽略 */ }
    return set;
}

/** 切批公共核心（V1 `plotSegmentBatchesFrom`）：把「已按剧情时间从早到晚排好序」的情节切成 ≤ size 的批次。
 *  每批附 `ids / dateStart / dateEnd / floorStart / floorEnd`（**不含 `index`**，V1 原样）。 */
function plotSegmentBatchesFrom(list, size) {
    const batches = [];
    let cur = [];
    const flush = () => {
        if (!cur.length) return;
        const dates = cur.map(a => (atomDateValid(a.date) ? clockDateTrim(a.date) : '')).filter(Boolean).sort(dateStrCmp);
        const floors = cur.map(a => Number(a.floorStart) || Number(a.floorEnd) || 0).filter(Boolean);
        const floorsEnd = cur.map(a => Number(a.floorEnd) || Number(a.floorStart) || 0).filter(Boolean);
        const ids = cur.map(a => String(a.id || '')).filter(Boolean);
        batches.push({
            atoms: cur, ids,
            dateStart: dates[0] || '', dateEnd: dates[dates.length - 1] || '',
            floorStart: floors.length ? Math.min.apply(null, floors) : 0,
            floorEnd: floorsEnd.length ? Math.max.apply(null, floorsEnd) : 0,
        });
        cur = [];
    };
    for (const a of (Array.isArray(list) ? list : [])) {
        cur.push(a);
        if (cur.length >= size) flush();
    }
    flush();
    return batches;
}

/** 自动分段计划（V1 `plotSegmentPlan`）：`{ batches:[{index,…,covered}], total, covered }`；
 *  `covered` = 该批情节**全部**已被现有段落覆盖（供增量模式跳过）。 */
function plotSegmentPlan() {
    const list = plotSegmentAtomList();
    const covered = plotSegmentCoveredIds();
    const batches = plotSegmentBatchesFrom(list, plotSegmentBatchSize());
    batches.forEach((b, i) => {
        b.index = i + 1;
        b.covered = b.ids.length > 0 && b.ids.every(id => covered.has(id));
    });
    return { batches, total: list.length, covered: covered.size };
}

/** 手动勾选计划（V1 v1.201 `plotSegmentPlanForIds`）：只针对勾选 id 切批；
 *  不做增量覆盖判定（`covered` 恒 false）。 */
function plotSegmentPlanForIds(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(x => String(x == null ? '' : x)).filter(Boolean));
    const list = want.size ? plotSegmentAtomList().filter(a => want.has(String(a.id || ''))) : [];
    const batches = plotSegmentBatchesFrom(list, plotSegmentBatchSize());
    batches.forEach((b, i) => { b.index = i + 1; b.covered = false; });
    return { batches, total: list.length, selected: want.size };
}

/** 提示词（V1 `buildPlotSegmentPrompt`）：system = 提示词面板「④ 质检维护 → 情节分段总结」模板
 *  （`cfg.promptTemplates.plotSegment` → `defaultCfg` → 内置兜底）；user = 本批情节清单 + 覆盖要求。 */
function buildPlotSegmentPrompt(batch) {
    const b = batch || {};
    if (!b.atoms || !b.atoms.length) return null;
    const tpl = String((cfg.promptTemplates && cfg.promptTemplates.plotSegment) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.plotSegment) || '').trim()
        || '把下面的情节按剧情线拆成多段总结，每段以 `### 时间范围` 为头，段内逐条列出剧情线（`1. 线路名: 概述`）；言简意赅、只陈述结论事实与数据。';
    const lines = [];
    for (const a of b.atoms) {
        let title = '';
        try { title = String(atomTitle(a) || ''); } catch (e) { title = String(a.title || ''); }
        const body = String(a.text || a.content || '').replace(/\s+/g, ' ').slice(0, 300);
        const who = (Array.isArray(a.entities) ? a.entities : []).slice(0, 6).filter(Boolean).join('、');
        const loc = (Array.isArray(a.locations) ? a.locations : []).slice(0, 3).filter(Boolean).join('、');
        const fl = (Number(a.floorStart) || 0) && (Number(a.floorEnd) || 0) ? `第 ${a.floorStart}-${a.floorEnd} 楼` : '';
        lines.push(`${a.date ? `[${a.date}] ` : '[日期未知] '}${title && title !== body ? `${title} ｜ ` : ''}${body}${who ? ` ｜ 角色：${who}` : ''}${loc ? ` ｜ 地点：${loc}` : ''}${fl ? `（${fl}）` : ''}`);
    }
    const dates = [b.dateStart, b.dateEnd].filter(Boolean);
    return [
        { role: 'system', content: tpl },
        { role: 'user', content: `【待整理情节（第 ${b.index} 批，按剧情时间从早到晚，共 ${b.atoms.length} 条${dates.length ? `；本批时间跨度 ${dates[0]}${dates.length > 1 && dates[1] !== dates[0] ? ' ~ ' + dates[1] : ''}` : ''}）】\n${lines.join('\n')}\n\n【输出要求】按上面的段落划分口径输出 \`### 时间范围\` 段落（Markdown 文本）；段内逐行给出剧情线（\`1. 线路名: 概述\`）；必须覆盖本批全部 ${b.atoms.length} 条情节（允许合并同类，但不得遗漏整段剧情），不要新增清单里没有的信息；只输出段落本身，不要解释、不要 JSON、不要代码块标记。` },
    ];
}
/** 段落「同一个」判定（V1 `plotSegmentSameRange`）：规范化头文本相同，或日期区间高度重叠
 *  （重叠 ≥ 较短视频跨度的 50%）—— 防止措辞漂移造成重复段落。 */
function plotSegmentSameRange(a, b) {
    try {
        const norm = (s) => String((s && s.header) || '').replace(/[\s年月日./-]/g, '').toLowerCase();
        if (norm(a) && norm(a) === norm(b)) return true;
        const d1 = String((a && a.start) || ''), e1 = String((a && a.end) || a && a.start || '');
        const d2 = String((b && b.start) || ''), e2 = String((b && b.end) || b && b.start || '');
        if (!d1 || !d2) return false;
        // v1.188：改用 storyDateMsFromStr（setUTCFullYear 口径）—— 0051 年区间比较不再被算到 1951
        const day = (s) => { const ms = storyDateMsFromStr(s); return Number.isFinite(ms) ? ms / 86400000 : NaN; };
        const s1 = day(d1), t1 = day(e1 || d1), s2 = day(d2), t2 = day(e2 || d2);
        if (![s1, t1, s2, t2].every(Number.isFinite)) return false;
        const lo1 = Math.min(s1, t1), hi1 = Math.max(s1, t1), lo2 = Math.min(s2, t2), hi2 = Math.max(s2, t2);
        const inter = Math.min(hi1, hi2) - Math.max(lo1, lo2);
        if (inter < 0) return false;
        const span = Math.min(hi1 - lo1, hi2 - lo2) + 1;
        return (inter + 1) / span >= 0.5;
    } catch (e) { return false; }
}

/** 落库（V1 `applyPlotSegmentResult`）：只新增（同区间/同头已存在 → 跳过；不覆盖、不删除）。
 *  @returns {{added:number, skipped:number, dup:number, empty:number, ids:string[]}} */
function applyPlotSegmentResult(batch, segments) {
    const out = { added: 0, skipped: 0, dup: 0, empty: 0, ids: [] };
    try {
        const b = batch || {};
        const list = (state.plotSegments = Array.isArray(state.plotSegments) ? state.plotSegments : []);
        const protect = (cfg.plotSegmentProtectManual !== false);
        for (const seg of (Array.isArray(segments) ? segments : [])) {
            if (!seg || (!seg.header && !(seg.lines || []).length)) { out.empty++; continue; }
            if (!(seg.lines || []).length) { out.empty++; continue; }
            const hit = list.find(x => x && plotSegmentSameRange(x, seg));
            if (hit) {
                // 已存在同一时间范围 → 保护（默认不改写）；允许改写时也只更新正文与时间戳，绝不新增第二条
                if (!protect) {
                    hit.lines = seg.lines;
                    hit.raw = plotSegmentsToText([hit]);
                    hit.updatedAt = Date.now();
                }
                out.skipped++; out.dup++;
                continue;
            }
            const item = normalizePlotSegment({
                header: seg.header, lines: seg.lines, raw: plotSegmentsToText([seg]),
                atomIds: b.ids || [], atomCount: (b.ids || []).length,
                floorStart: b.floorStart || 0, floorEnd: b.floorEnd || 0,
                manual: false, createdAt: Date.now(), updatedAt: Date.now(),
            });
            if (!item) { out.empty++; continue; }
            list.push(item);
            out.added++;
            out.ids.push(String(item.id));
        }
        return out;
    } catch (e) { return out; }
}

/** 主流程（V1 `runPlotSegmentSummary`）：打包 → 逐批 AI → 解析 → 落库（只增不减）。
 *  早退：无有效情节 → `{made:0, skipped:true, total:0}`；`aiBusy()` → `{made:0, blocked:true}`；
 *  增量模式下批次全被覆盖 → `{made:0, skipped:true, total, batches:0}`。
 *  @param {object} [opts] maxBatches（默认 12，夹在 [1,40]）、aiText（V2 注入点）
 *  @returns {Promise<object>} V1 同形返回结构 */
async function runPlotSegmentSummary(opts) {
    const o = opts || {};
    try {
        const plan = plotSegmentPlan();
        if (!plan.total) {
            notify('info', '情节分段总结：暂无可整理情节', '当前没有有效情节原子（或全部已失效）。请先运行「AI 摘要」生成情节。');
            return { made: 0, skipped: true, total: 0 };
        }
        // V1 有两道忙位判据（`busy.repair` → 「任务进行中」/ 管线占用 → `pipelineBlockInfo`）；
        //   V2 由宿主 `aiBusy()` 统一表达 → 取**管线占用**那一道的文案（与 runAtomMergeSummary 同口径）。
        if (aiBusy()) { notify('warning', '当前任务占用中', '摘要/情节总结/推演/推进结束后再生成。'); return { made: 0, blocked: true }; }
        let batches = plan.batches;
        if (cfg.plotSegmentIncremental === true) batches = batches.filter(b => !b.covered);
        if (!batches.length) {
            notify('info', '情节分段总结：已是最新', `当前 ${plan.total} 条情节已全部被现有段落覆盖（增量模式）。`);
            return { made: 0, skipped: true, total: plan.total, batches: 0 };
        }
        const maxBatches = Math.max(1, Math.min(40, Number(o.maxBatches) || 12));
        const run = batches.slice(0, maxBatches);
        const t0 = Date.now();
        try {
            const stat = { added: 0, skipped: 0, dup: 0, empty: 0, batches: run.length };
            notify('warning', '开始生成情节分段总结…', `情节 ${plan.total} 条 → 本批 ${run.length} 批（每批 ≤ ${plotSegmentBatchSize()} 条）${plan.covered ? ` · 已被现有段落覆盖 ${plan.covered} 条` : ''}`);
            for (let i = 0; i < run.length; i++) {
                const b = run[i];
                const prompt = buildPlotSegmentPrompt(b);
                if (!prompt) break;
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '情节分段总结'));
                const segs = parsePlotSegmentText(resp);
                const r = applyPlotSegmentResult(b, segs);
                stat.added += r.added; stat.skipped += r.skipped; stat.dup += r.dup; stat.empty += r.empty;
                saveState();
                try { dbgLog('摘要', { action: `情节分段总结（第 ${i + 1}/${run.length} 批）`, added: r.added, dup: r.dup, empty: r.empty, dates: [b.dateStart, b.dateEnd].filter(Boolean).join(' ~ ') }); } catch (e) { }
            }
            const after = (state.plotSegments || []).length;
            const parts = [`新增 ${stat.added} 段`];
            if (stat.dup) parts.push(`跳过已存在 ${stat.dup} 段`);
            if (stat.empty) parts.push(`忽略空段 ${stat.empty}`);
            parts.push(`当前共 ${after} 段`);
            if (batches.length > run.length) parts.push(`本次只处理前 ${run.length}/${batches.length} 批（可再次点击继续）`);
            notify('success', '情节分段总结完成', `${parts.join(' · ')}。${(!stat.added && stat.dup) ? '（同时间范围段落已存在，未重复保存）' : ''}`);
            try { dbgLog('摘要', { action: '情节分段总结完成（v1.182）', atoms: plan.total, batches: run.length, batchesTotal: batches.length, added: stat.added, dup: stat.dup, empty: stat.empty, segments: after, ms: Date.now() - t0 }); } catch (e) { }
            return { made: stat.added, added: stat.added, dup: stat.dup, empty: stat.empty, batches: run.length, total: plan.total, segments: after };
        } catch (e) {
            warn('情节分段总结失败', e);
            notify('error', '情节分段总结失败', String((e && e.message) || e).slice(0, 100));
            return { made: 0, error: String((e && e.message) || e) };
        }
    } catch (e) { return { made: 0, error: String((e && e.message) || e) }; }
}

/** 主流程（V1 v1.201 `runPlotSegmentSummarySelected`）：**总结所选** —— 只把勾选的情节按剧情时间打包交 AI，
 *  结果仍落到 `state.plotSegments`（与自动分段总结同一归档区，不注入、唯一消失途径是手动删除）。
 *  早退：无可整理 → `{made:0, skipped:true, total:0, selected}`；`aiBusy()` → `{made:0, blocked:true}`。
 *  @param {Array} ids 勾选的情节 id
 *  @param {object} [opts] maxBatches（默认 12，夹在 [1,40]）、aiText（V2 注入点）
 *  @returns {Promise<object>} V1 同形返回结构 */
async function runPlotSegmentSummarySelected(ids, opts) {
    const o = opts || {};
    try {
        const plan = plotSegmentPlanForIds(ids);
        if (!plan.total) {
            notify('info', '总结所选：没有可整理的情节', '勾选的情节为空、已失效或已被删除。请重新勾选后再试。');
            return { made: 0, skipped: true, total: 0, selected: plan.selected };
        }
        if (aiBusy()) { notify('warning', '当前任务占用中', '摘要/情节总结/推演/推进结束后再生成。'); return { made: 0, blocked: true }; }
        const maxBatches = Math.max(1, Math.min(40, Number(o.maxBatches) || 12));
        const run = plan.batches.slice(0, maxBatches);
        const t0 = Date.now();
        try {
            const stat = { added: 0, skipped: 0, dup: 0, empty: 0, batches: run.length };
            notify('warning', '开始总结所选情节…', `已勾选 ${plan.selected} 条 · 其中有效 ${plan.total} 条 → 本次 ${run.length} 批（每批 ≤ ${plotSegmentBatchSize()} 条）`);
            for (let i = 0; i < run.length; i++) {
                const b = run[i];
                const prompt = buildPlotSegmentPrompt(b);
                if (!prompt) break;
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '总结所选情节'));
                const segs = parsePlotSegmentText(resp);
                const r = applyPlotSegmentResult(b, segs);
                stat.added += r.added; stat.skipped += r.skipped; stat.dup += r.dup; stat.empty += r.empty;
                saveState();
                try { dbgLog('摘要', { action: `总结所选情节（第 ${i + 1}/${run.length} 批）`, selected: plan.selected, valid: plan.total, added: r.added, dup: r.dup, empty: r.empty, dates: [b.dateStart, b.dateEnd].filter(Boolean).join(' ~ ') }); } catch (e) { }
            }
            const after = (state.plotSegments || []).length;
            const parts = [`新增 ${stat.added} 段`];
            if (stat.dup) parts.push(`跳过同时间范围已存在 ${stat.dup} 段`);
            if (stat.empty) parts.push(`忽略空段 ${stat.empty}`);
            parts.push(`当前共 ${after} 段（见「🧩 分段总结」子页）`);
            notify('success', '总结所选情节完成', `${parts.join(' · ')}。`);
            try { dbgLog('摘要', { action: '总结所选情节完成（v1.201）', selected: plan.selected, valid: plan.total, batches: run.length, added: stat.added, dup: stat.dup, empty: stat.empty, segments: after, ms: Date.now() - t0 }); } catch (e) { }
            return { made: stat.added, added: stat.added, dup: stat.dup, empty: stat.empty, batches: run.length, total: plan.total, selected: plan.selected, segments: after };
        } catch (e) {
            warn('总结所选情节失败', e);
            notify('error', '总结所选情节失败', String((e && e.message) || e).slice(0, 100));
            return { made: 0, error: String((e && e.message) || e) };
        }
    } catch (e) { return { made: 0, error: String((e && e.message) || e) }; }
}

/** 清空分段总结（V1 `clearPlotSegments`；仅用户显式点击，AI 流程永不调用）。
 *  v1.191：分段总结已并入原子维度（`ATOM_DIM_KEYS`）→ 删除必须**留墓碑**（id + 内容哈希），
 *  否则对端仍持有这些段时会按「并集」把它们唤醒回来。
 *  @returns {number} 清理的段数 */
function clearPlotSegments() {
    try {
        const list = (state.plotSegments || []).slice();
        const n = list.length;
        try { tombEntries('plotSegments', list); } catch (e) { /* 忽略 */ }
        state.plotSegments = [];
        saveState();
        notifyHooks.toast(`已清理 ${n} 段情节分段总结`, 'info');
        return n;
    } catch (e) { return 0; }
}

/** 删除单个分段（V1 `deletePlotSegment`；留 id + 内容哈希墓碑、幂等）。
 *  @returns {number} 实际删除条数（0/1） */
function deletePlotSegment(id) {
    try {
        const key = String(id || '');
        const before = (state.plotSegments || []).length;
        const gone = (state.plotSegments || []).filter(x => x && String(x.id) === key);
        state.plotSegments = (state.plotSegments || []).filter(x => !(x && String(x.id) === key));
        const removed = before - (state.plotSegments || []).length;
        try { tombEntries('plotSegments', gone); } catch (e) { /* 忽略 */ }
        if (removed) { saveState(); notifyHooks.toast('已删除该分段总结', 'info'); }
        return removed;
    } catch (e) { return 0; }
}

/** 分段 → 编辑器回填（V1 `flattenPlotSegment`）：`header` + 一行一条的线路文本。 */
function flattenPlotSegment(item) {
    const it = item || {};
    const lines = Array.isArray(it.lines) ? it.lines : [];
    return {
        header: it.header || '',
        linesText: lines.map(ln => `${ln && ln.label ? ln.label : '剧情线'}：${ln && ln.text ? ln.text : ''}`).join('\n'),
    };
}

export {
    plotSegmentBatchSize, plotSegmentAtomList, plotSegmentCoveredIds, plotSegmentBatchesFrom,
    plotSegmentPlan, plotSegmentPlanForIds, buildPlotSegmentPrompt, plotSegmentSameRange,
    applyPlotSegmentResult, runPlotSegmentSummary, runPlotSegmentSummarySelected,
    clearPlotSegments, deletePlotSegment, flattenPlotSegment,
};
