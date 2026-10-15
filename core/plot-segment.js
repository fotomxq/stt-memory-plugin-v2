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
// 适配（与 V1 的差异，逐条见 docs/history/P8w-B8-7情节总结与分段总结.md）：
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

/**
 * v3.49.3（用户报告「情节的自动分段统计存在设计缺陷，会提交巨量数据」）：**每批的字符预算**（默认 8000，夹在 [500, 60000]；`0` = 关闭字符预算）。
 *   实测（`tests/local/plot-segment-audit.mjs` 只读核对真实存档）：824 条可见情节 → 28 批，最重一批 11275 字符；
 *   旧实现**只按条数**切批（30 条/批），没有任何体量上界 —— 情节正文均值 ~236 字符时尚可，一旦出现长条目就会单批失控。
 *   现在切批同时受「条数」与「字符」两个上界约束（取先到者），每批的估算字符数记在 `batch.chars`，供预告与测试读数。
 */
function plotSegmentMaxChars() {
    const n = Number(cfg && cfg.plotSegmentMaxChars);
    if (Number.isFinite(n) && n === 0) return 0;                       // 显式 0 = 关闭
    return Math.max(500, Math.min(60000, Number.isFinite(n) && n > 0 ? Math.round(n) : 8000));
}
/**
 * **一次点击最多提交几批**（v3.49.3；默认 1）。
 *   用户口径「需要统计的 30 个情节不可能这么大的数据量」→ 一次点击只交**一批**（≤ `plotSegmentBatchAtoms` 条 / ≤ `plotSegmentMaxChars` 字符），
 *   余下批次由用户自己决定是否继续（提示里如实写明还剩几批）。调用方仍可用 `opts.maxBatches` 显式放大（测试 / 特殊场景）。
 */
function plotSegmentMaxBatchesDefault() {
    const n = Number(cfg && cfg.plotSegmentMaxBatches);
    return Math.max(1, Math.min(40, Number.isFinite(n) && n > 0 ? Math.round(n) : 1));
}
/**
 * 一条情节在提示词里的**正文行**（单一事实源）：`buildPlotSegmentPrompt` 与切批的字符预算**共用**它，
 *   避免「预算按 A 口径算、真正发送按 B 口径算」的两套口径。
 */
function plotSegmentLineText(a) {
    const it = a || {};
    let title = '';
    try { title = String(atomTitle(it) || ''); } catch (e) { title = String(it.title || ''); }
    const body = String(it.text || it.content || '').replace(/\s+/g, ' ').slice(0, 300);
    const who = (Array.isArray(it.entities) ? it.entities : []).slice(0, 6).filter(Boolean).join('、');
    const loc = (Array.isArray(it.locations) ? it.locations : []).slice(0, 3).filter(Boolean).join('、');
    const fl = (Number(it.floorStart) || 0) && (Number(it.floorEnd) || 0) ? `第 ${it.floorStart}-${it.floorEnd} 楼` : '';
    return `${it.date ? `[${it.date}] ` : '[日期未知] '}${title && title !== body ? `${title} ｜ ` : ''}${body}${who ? ` ｜ 角色：${who}` : ''}${loc ? ` ｜ 地点：${loc}` : ''}${fl ? `（${fl}）` : ''}`;
}
/** 一条情节的估算字符数（行文本长度 + 换行） */
function plotSegmentLineCost(a) { try { return plotSegmentLineText(a).length + 1; } catch (e) { return 1; } }

/**
 * v3.50.3（用户要求「执行不能重叠起来」）：**本模块级在途闸** —— 与 `aiBusy()` 双保险。
 *   为什么还要它：`aiBusy()` 反映的是**宿主**的忙位，两次极快的点击可能在宿主置位之前都通过检查
 *   （`summary` 动作按设计**不在**管道守门名册里，见 `ui/pipe-guard.js` 头部），于是同一个批次被提交两次。
 *   这里用**同模块的同步标志**把窗口关掉：进入即置位，`finally` 清位（成功 / 失败 / 异常都清）。
 */
let plotSegmentInFlight = false;
/** 是否正在跑分段总结（渲染禁用态 / 调试 / 测试用） */
function plotSegmentBusy() { return plotSegmentInFlight; }

/**
 * v3.50.3（用户要求「如发现已提交则避免重复提交」）：**提交账本**的批次指纹。
 *   取该批 ids 的**排序后 FNV-1a 短哈希**（账本只留 10 条，不存正文、不跨端）——同一批（同一组 id）重复提交可被识别。
 */
function plotSegmentSubmitSig(batch) {
    try {
        const ids = ((batch && batch.ids) || []).map(x => String(x)).slice().sort();
        if (!ids.length) return '';
        const s = ids.join("|");
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        return 'b' + ids.length + '-' + h.toString(36) + '-' + ids[0] + '-' + ids[ids.length - 1];
    } catch (e) { return ''; }
}
/** 提交账本（`state.plotSegmentLog`，末 10 条；登记 runtime、不跨端） */
function plotSegmentLogList() {
    try { return Array.isArray(state.plotSegmentLog) ? state.plotSegmentLog : []; } catch (e) { return []; }
}
/** 该批是否**已经提交过**（含失败：只要发出去过就算，防重复提交） */
function plotSegmentSubmitted(sig) {
    if (!sig) return false;
    try { return plotSegmentLogList().some(x => x && String(x.sig) === sig); } catch (e) { return false; }
}
/** 记一笔提交（末 10 条，含结果；落盘由调用方负责） */
function plotSegmentLogPush(entry) {
    try {
        const list = plotSegmentLogList().slice();
        list.push(Object.assign({ at: Date.now() }, entry || {}));
        state.plotSegmentLog = list.slice(-10);
    } catch (e) { /* 忽略 */ }
}
/** 删除段落 / 清空时**释放名额**：把含这些 id 的账本条目摘掉（用户显式删除 = 允许重新生成） */
function plotSegmentLogRelease(ids) {
    try {
        const want = new Set((Array.isArray(ids) ? ids : []).map(x => String(x)));
        if (!want.size) { state.plotSegmentLog = []; return; }
        state.plotSegmentLog = plotSegmentLogList().filter(x => !(x && Array.isArray(x.ids) && x.ids.some(id => want.has(String(id)))));
    } catch (e) { /* 忽略 */ }
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
function plotSegmentBatchesFrom(list, size, maxChars) {
    const limit = (maxChars == null) ? plotSegmentMaxChars() : Math.max(0, Number(maxChars) || 0);
    const batches = [];
    let cur = [];
    let curChars = 0;                                   // v3.49.3：本批累计估算字符
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
            chars: curChars,                            // v3.49.3：该批的估算字符数（预告 / 读数用）
            // v3.50.3（用户要求「必须满足『每次打包给 AI 的情节条数』后方可执行1次」）：
            //   **满批** = 条数达上限 **或** 字符预算达上限（只有最后一批可能两者都没到 → 不许提交，等后续情节凑满）
            full: (cur.length >= size) || (limit > 0 && curChars >= limit),
        });
        cur = [];
        curChars = 0;
    };
    for (const a of (Array.isArray(list) ? list : [])) {
        cur.push(a);
        curChars += plotSegmentLineCost(a);
        // v3.49.3：**条数与字符取先到者**（limit = 0 表示不限字符；至少保留 1 条，避免空批死循环）
        if (cur.length >= size || (limit > 0 && curChars >= limit && cur.length >= 1)) flush();
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
    // v3.49.3：计划级读数（供「提交前预告」与测试）——本次待整理条数 / 字符 / 批数 / 每批上界
    const chars = batches.reduce((s, b) => s + (Number(b.chars) || 0), 0);
    /**
     * v3.50.3（用户要求）：**可提交** = 未覆盖 **且** 满批。
     *   未总结条数（`pending`）= 可见情节里**尚未被任何段落覆盖**的条数 —— 用户口径「最近必须至少有 N 条情节是未总结的，才能加入总结」。
     *   `eligible` = 可提交的批数，`full` = 满批数（供预告与机会提示）。
     */
    const pending = list.filter(a => !covered.has(String(a.id || ''))).length;
    const eligibleBatches = batches.filter(b => !b.covered && b.full === true);
    const eligible = eligibleBatches.length;
    const pendingEligible = eligibleBatches.reduce((s, b) => s + b.atoms.length, 0);
    return {
        batches, total: list.length, covered: covered.size, chars: chars,
        batchAtoms: plotSegmentBatchSize(), batchChars: plotSegmentMaxChars(),
        pending: pending, eligible: eligible, pendingEligible: pendingEligible,
        fullBatches: batches.filter(b => b.full === true).length,
    };
}

/** 手动勾选计划（V1 v1.201 `plotSegmentPlanForIds`）：只针对勾选 id 切批；
 *  不做增量覆盖判定（`covered` 恒 false）。 */
function plotSegmentPlanForIds(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(x => String(x == null ? '' : x)).filter(Boolean));
    const list = want.size ? plotSegmentAtomList().filter(a => want.has(String(a.id || ''))) : [];
    const batches = plotSegmentBatchesFrom(list, plotSegmentBatchSize());
    batches.forEach((b, i) => { b.index = i + 1; b.covered = false; });
    const chars = batches.reduce((s, b) => s + (Number(b.chars) || 0), 0);
    return { batches, total: list.length, selected: want.size, chars: chars, batchAtoms: plotSegmentBatchSize(), batchChars: plotSegmentMaxChars(),
        // 所选路径**不受「凑满一批」限制**（用户显式指定）；但仍回报满批数供预告
        eligible: batches.length, fullBatches: batches.filter(b => b.full === true).length, pending: list.length, pendingEligible: list.length };
}

/** 提示词（V1 `buildPlotSegmentPrompt`）：system = 提示词面板「④ 质检维护 → 情节分段总结」模板
 *  （`cfg.promptTemplates.plotSegment` → `defaultCfg` → 内置兜底）；user = 本批情节清单 + 覆盖要求。 */
function buildPlotSegmentPrompt(batch) {
    const b = batch || {};
    if (!b.atoms || !b.atoms.length) return null;
    const tpl = String((cfg.promptTemplates && cfg.promptTemplates.plotSegment) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.plotSegment) || '').trim()
        || '把下面的情节按剧情线拆成多段总结，每段以 `### 时间范围` 为头，段内逐条列出剧情线（`1. 线路名: 概述`）；言简意赅、只陈述结论事实与数据。';
    // v3.49.3：行文本改由 `plotSegmentLineText` 产出（与切批的字符预算**同一口径**）
    const lines = b.atoms.map((a) => plotSegmentLineText(a));
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
                /**
                 * v3.49.3（**只读核对时发现的真缺陷**，`tests/local/plot-segment-audit.mjs` 的增量演练）：
                 *   「同时间范围 → 跳过」这条路径**没有把本批的 `atomIds` 并进已存在的那一段** ——
                 *   于是「增量模式」下该批永远处于**未被覆盖**状态 → 每点一次都重新提交同一批（**永不收敛**）。
                 *   实测：2 批的库第一轮跑 1 批后，第 2 批因为解析出的区间与已有段相同而只记 `dup`，
                 *   它的 `atomIds` 从未被登记 → 之后每次点击都在重复提交第 2 批。
                 *
                 * 现在：命中同段时，把本批 ids **并入**该段（并集，只增不减）——覆盖判定从此收敛；
                 *   段的**正文与时间范围仍不被改写**（保护手动编辑的口径不变）。
                 */
                try {
                    const ids = Array.isArray(hit.atomIds) ? hit.atomIds.slice() : [];
                    const add = (b.ids || []).map((x) => String(x)).filter((x) => x && ids.indexOf(x) < 0);
                    if (add.length) {
                        hit.atomIds = ids.concat(add);
                        hit.atomCount = hit.atomIds.length;
                        if (b.floorStart && (!hit.floorStart || b.floorStart < hit.floorStart)) hit.floorStart = b.floorStart;
                        if (b.floorEnd && (Number(b.floorEnd) || 0) > (Number(hit.floorEnd) || 0)) hit.floorEnd = b.floorEnd;
                        hit.updatedAt = Date.now();
                        // 注意：**不**往 `out.ids` 里塞 —— 那是「本次新增段」的 V1 语义（dup 不产新段），保持返回结构逐字一致
                    }
                } catch (e) { /* 并集失败不影响既有口径 */ }
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
    // v3.50.3（用户要求「执行不能重叠起来」）：**同步在途闸**（早于任何 await / 数据读取）
    if (plotSegmentInFlight) {
        notify('warning', '情节分段总结进行中', '上一次提交还没返回 —— 本次点击已忽略（避免重复提交）。');
        return { made: 0, blocked: true, reason: 'inflight' };
    }
    plotSegmentInFlight = true;
    try {
        const plan = plotSegmentPlan();
        if (!plan.total) {
            notify('info', '情节分段总结：暂无可整理情节', '当前没有有效情节原子（或全部已失效）。请先运行「AI 摘要」生成情节。');
            return { made: 0, skipped: true, total: 0 };
        }
        // V1 有两道忙位判据（`busy.repair` → 「任务进行中」/ 管线占用 → `pipelineBlockInfo`）；
        //   V2 由宿主 `aiBusy()` 统一表达 → 取**管线占用**那一道的文案（与 runAtomMergeSummary 同口径）。
        if (aiBusy()) { notify('warning', '当前任务占用中', '摘要/情节总结/推演/推进结束后再生成。'); return { made: 0, blocked: true }; }
        /**
         * v3.50.3（用户要求「必须满足『每次打包给 AI 的情节条数』后方可执行 1 次；默认 30 则最近必须至少有 30 条情节是未总结的」）：
         *   ① 先看**未总结条数**（`plan.pending` = 可见情节里尚未被任何段落覆盖的条数）；
         *   ② 只有**满批**（条数达上限 **或** 字符预算达上限）且未覆盖的批才允许提交 —— 最后那批"没凑满"的**不提交**，等后续情节凑满；
         *   ③ 增量模式关掉时也照样只看"未覆盖"的批（用户口径是"未总结"，与模式无关）。
         */
        const threshold = plotSegmentBatchSize();
        if (!o.ignoreThreshold && plan.pending < threshold) {
            const need = threshold - plan.pending;
            notify('info', '情节分段总结：未总结情节不足',
                `当前未总结 ${plan.pending} 条，未达到「每次打包给 AI 的情节条数」${threshold} 条 —— 还差 ${need} 条才能加入总结（可先在设定 → 分析记忆 调小该值）。`);
            return { made: 0, skipped: true, reason: 'below-threshold', total: plan.total, pending: plan.pending, threshold: threshold, need: need, batches: 0 };
        }
        /**
         * `o.ignoreThreshold === true`（**V1 平价档专用**）：越过 v3.50.3 的两道新规矩 —— 既不看「未总结 ≥ 每批条数」，
         *   也**包含未满的尾部批次**（V1 就是把最后那批一起处理）。生产路径（界面 / 用户点击）**从不**传它。
         */
        let batches = o.ignoreThreshold === true
            ? plan.batches.filter(b => !b.covered)
            : plan.batches.filter(b => !b.covered && b.full === true);
        if (!batches.length) {
            notify('info', '情节分段总结：已是最新', `当前 ${plan.total} 条情节已全部被现有段落覆盖（或未凑满一批）—— 未总结 ${plan.pending} 条，凑满 ${threshold} 条后即可继续。`);
            return { made: 0, skipped: true, total: plan.total, pending: plan.pending, batches: 0 };
        }
        // v3.49.3（用户报告「会提交巨量数据」）：默认**一次点击只提交一批**（每批 ≤ `plotSegmentBatchAtoms` 条 / ≤ `plotSegmentMaxChars` 字符）——
        //   实测（`tests/local/plot-segment-audit.mjs`）：824 条情节 = 28 批，旧默认 12 批/次 → 单击 12 次请求・10.3 万字符。
        const maxBatches = Math.max(1, Math.min(40, Number(o.maxBatches) || plotSegmentMaxBatchesDefault()));
        const run = batches.slice(0, maxBatches);
        const t0 = Date.now();
        try {
            const stat = { added: 0, skipped: 0, dup: 0, empty: 0, batches: run.length, skippedSubmitted: 0 };
            const runChars = run.reduce((s, b) => s + (Number(b.chars) || 0), 0);
            // v3.49.3：**开工通知的措辞保持 V1 逐字不变**（黄金样本口径）——体量预告改放**调试日志**与**界面**（分段总结子页统计行）
            notify('warning', '开始生成情节分段总结…', `情节 ${plan.total} 条 → 本批 ${run.length} 批（每批 ≤ ${plotSegmentBatchSize()} 条）${plan.covered ? ` · 已被现有段落覆盖 ${plan.covered} 条` : ''}`);
            try { dbgLog('摘要', { action: '情节分段总结：体量预告（v3.49.3）', 待整理: plan.total, 共几批: batches.length, 本次提交几批: run.length, 本次条数: run.reduce((s, b) => s + b.atoms.length, 0), 本次估算字符: runChars, 每批条数上限: plotSegmentBatchSize(), 每批字符预算: plotSegmentMaxChars(), 增量模式: cfg.plotSegmentIncremental === true }); } catch (e) { /* 忽略 */ }
            for (let i = 0; i < run.length; i++) {
                const b = run[i];
                const sig = plotSegmentSubmitSig(b);
                // v3.50.3（用户要求「如发现已提交则避免重复提交」）：同一批（同一组 id）已提交过 → 跳过（含上次失败）
                if (plotSegmentSubmitted(sig)) {
                    stat.skippedSubmitted++;
                    try { dbgLog('摘要', { action: '情节分段总结：跳过已提交批次（v3.50.3）', sig: sig, dates: [b.dateStart, b.dateEnd].filter(Boolean).join(' ~ ') }); } catch (e) { }
                    continue;
                }
                const prompt = buildPlotSegmentPrompt(b);
                if (!prompt) break;
                plotSegmentLogPush({ sig: sig, ids: (b.ids || []).slice(), n: b.atoms.length, chars: Number(b.chars) || 0, added: 0, dup: 0, ok: false });
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '情节分段总结'));
                const segs = parsePlotSegmentText(resp);
                const r = applyPlotSegmentResult(b, segs);
                stat.added += r.added; stat.skipped += r.skipped; stat.dup += r.dup; stat.empty += r.empty;
                // 记账更新（同一 sig：把结果补上；提交即入账，失败也留痕 → 不会被重复提交）
                try {
                    const list = plotSegmentLogList();
                    for (let k = list.length - 1; k >= 0; k--) {
                        if (String(list[k].sig) === sig) { list[k].added = r.added; list[k].dup = r.dup; list[k].ok = true; break; }
                    }
                    state.plotSegmentLog = list.slice(-10);
                } catch (e) { /* 忽略 */ }
                saveState();
                try { dbgLog('摘要', { action: `情节分段总结（第 ${i + 1}/${run.length} 批）`, added: r.added, dup: r.dup, empty: r.empty, dates: [b.dateStart, b.dateEnd].filter(Boolean).join(' ~ ') }); } catch (e) { }
            }
            const after = (state.plotSegments || []).length;
            const parts = [`新增 ${stat.added} 段`];
            if (stat.dup) parts.push(`跳过已存在 ${stat.dup} 段`);
            if (stat.empty) parts.push(`忽略空段 ${stat.empty}`);
            if (stat.skippedSubmitted) parts.push(`跳过已提交 ${stat.skippedSubmitted} 批（防重复提交）`);
            parts.push(`当前共 ${after} 段`);
            if (batches.length > run.length) parts.push(`本次只处理前 ${run.length}/${batches.length} 批（可再次点击继续）`);
            notify('success', '情节分段总结完成', `${parts.join(' · ')}。${(!stat.added && stat.dup) ? '（同时间范围段落已存在，未重复保存）' : ''}`);
            try { dbgLog('摘要', { action: '情节分段总结完成（v1.182）', atoms: plan.total, batches: run.length, batchesTotal: batches.length, added: stat.added, dup: stat.dup, empty: stat.empty, segments: after, ms: Date.now() - t0 }); } catch (e) { }
            return { made: stat.added, added: stat.added, dup: stat.dup, empty: stat.empty, batches: run.length, total: plan.total, segments: after,
                pending: plan.pending, threshold: threshold, skippedSubmitted: stat.skippedSubmitted };
        } catch (e) {
            warn('情节分段总结失败', e);
            notify('error', '情节分段总结失败', String((e && e.message) || e).slice(0, 100));
            return { made: 0, error: String((e && e.message) || e) };
        }
    } catch (e) { return { made: 0, error: String((e && e.message) || e) }; }
    // v3.50.3：**任何出口都清在途闸**（成功 / 失败 / 异常 / 早退），否则之后再也点不动
    finally { plotSegmentInFlight = false; }
}

/** 主流程（V1 v1.201 `runPlotSegmentSummarySelected`）：**总结所选** —— 只把勾选的情节按剧情时间打包交 AI，
 *  结果仍落到 `state.plotSegments`（与自动分段总结同一归档区，不注入、唯一消失途径是手动删除）。
 *  早退：无可整理 → `{made:0, skipped:true, total:0, selected}`；`aiBusy()` → `{made:0, blocked:true}`。
 *  @param {Array} ids 勾选的情节 id
 *  @param {object} [opts] maxBatches（默认 12，夹在 [1,40]）、aiText（V2 注入点）
 *  @returns {Promise<object>} V1 同形返回结构 */
async function runPlotSegmentSummarySelected(ids, opts) {
    const o = opts || {};
    // v3.50.3（用户要求「执行不能重叠起来」）：与自动入口**共用同一个在途闸**（两个入口不许互相重叠）
    if (plotSegmentInFlight) {
        notify('warning', '情节分段总结进行中', '上一次提交还没返回 —— 本次点击已忽略（避免重复提交）。');
        return { made: 0, blocked: true, reason: 'inflight' };
    }
    plotSegmentInFlight = true;
    try {
        const plan = plotSegmentPlanForIds(ids);
        if (!plan.total) {
            notify('info', '总结所选：没有可整理的情节', '勾选的情节为空、已失效或已被删除。请重新勾选后再试。');
            return { made: 0, skipped: true, total: 0, selected: plan.selected };
        }
        if (aiBusy()) { notify('warning', '当前任务占用中', '摘要/情节总结/推演/推进结束后再生成。'); return { made: 0, blocked: true }; }
        const maxBatches = Math.max(1, Math.min(40, Number(o.maxBatches) || plotSegmentMaxBatchesDefault()));
        // 所选路径**不受「凑满一批」门槛限制**（用户显式勾选，见 `docs/D41` §1.2 N6）——但仍受在途闸与"已提交去重"约束
        const run = plan.batches.slice(0, maxBatches);
        const t0 = Date.now();
        try {
            const stat = { added: 0, skipped: 0, dup: 0, empty: 0, batches: run.length, skippedSubmitted: 0 };
            const runChars = run.reduce((s, b) => s + (Number(b.chars) || 0), 0);
            notify('warning', '开始总结所选情节…', `已勾选 ${plan.selected} 条 · 其中有效 ${plan.total} 条 → 本次 ${run.length} 批（每批 ≤ ${plotSegmentBatchSize()} 条）`);
            try { dbgLog('摘要', { action: '总结所选情节：体量预告（v3.49.3）', 已勾选: plan.selected, 有效: plan.total, 共几批: plan.batches.length, 本次提交几批: run.length, 本次估算字符: runChars, 每批字符预算: plotSegmentMaxChars() }); } catch (e) { /* 忽略 */ }
            for (let i = 0; i < run.length; i++) {
                const b = run[i];
                const sig = plotSegmentSubmitSig(b);
                if (plotSegmentSubmitted(sig)) { stat.skippedSubmitted++; continue; }   // v3.50.3：已提交过 → 不重复提交
                const prompt = buildPlotSegmentPrompt(b);
                if (!prompt) break;
                plotSegmentLogPush({ sig: sig, ids: (b.ids || []).slice(), n: b.atoms.length, chars: Number(b.chars) || 0, added: 0, dup: 0, ok: false });
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '总结所选情节'));
                const segs = parsePlotSegmentText(resp);
                const r = applyPlotSegmentResult(b, segs);
                stat.added += r.added; stat.skipped += r.skipped; stat.dup += r.dup; stat.empty += r.empty;
                try {
                    const list = plotSegmentLogList();
                    for (let k = list.length - 1; k >= 0; k--) {
                        if (String(list[k].sig) === sig) { list[k].added = r.added; list[k].dup = r.dup; list[k].ok = true; break; }
                    }
                    state.plotSegmentLog = list.slice(-10);
                } catch (e) { /* 忽略 */ }
                saveState();
                try { dbgLog('摘要', { action: `总结所选情节（第 ${i + 1}/${run.length} 批）`, selected: plan.selected, valid: plan.total, added: r.added, dup: r.dup, empty: r.empty, dates: [b.dateStart, b.dateEnd].filter(Boolean).join(' ~ ') }); } catch (e) { }
            }
            const after = (state.plotSegments || []).length;
            const parts = [`新增 ${stat.added} 段`];
            if (stat.dup) parts.push(`跳过同时间范围已存在 ${stat.dup} 段`);
            if (stat.empty) parts.push(`忽略空段 ${stat.empty}`);
            if (stat.skippedSubmitted) parts.push(`跳过已提交 ${stat.skippedSubmitted} 批（防重复提交）`);
            parts.push(`当前共 ${after} 段（见「🧩 分段总结」子页）`);
            notify('success', '总结所选情节完成', `${parts.join(' · ')}。`);
            try { dbgLog('摘要', { action: '总结所选情节完成（v1.201）', selected: plan.selected, valid: plan.total, batches: run.length, added: stat.added, dup: stat.dup, empty: stat.empty, segments: after, ms: Date.now() - t0 }); } catch (e) { }
            return { made: stat.added, added: stat.added, dup: stat.dup, empty: stat.empty, batches: run.length, total: plan.total, selected: plan.selected, segments: after, skippedSubmitted: stat.skippedSubmitted };
        } catch (e) {
            warn('总结所选情节失败', e);
            notify('error', '总结所选情节失败', String((e && e.message) || e).slice(0, 100));
            return { made: 0, error: String((e && e.message) || e) };
        }
    } catch (e) { return { made: 0, error: String((e && e.message) || e) }; }
    // v3.50.3：所选入口同样在任何出口清在途闸
    finally { plotSegmentInFlight = false; }
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
        // v3.50.3：清空 = 用户显式删除 → **释放提交账本**（被摘掉的情节允许重新生成）
        try { plotSegmentLogRelease([]); } catch (e) { /* 忽略 */ }
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
    plotSegmentBatchSize, plotSegmentMaxChars, plotSegmentMaxBatchesDefault, plotSegmentLineText, plotSegmentLineCost,
    // v3.50.3（用户要求）：在途闸读数 + 提交账本（只读）+ 批次指纹
    plotSegmentBusy, plotSegmentSubmitSig, plotSegmentLogList,
    plotSegmentAtomList, plotSegmentCoveredIds, plotSegmentBatchesFrom,
    plotSegmentPlan, plotSegmentPlanForIds, buildPlotSegmentPrompt, plotSegmentSameRange,
    applyPlotSegmentResult, runPlotSegmentSummary, runPlotSegmentSummarySelected,
    clearPlotSegments, deletePlotSegment, flattenPlotSegment,
};
