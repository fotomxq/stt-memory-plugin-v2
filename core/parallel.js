// ============================================================
// core/parallel.js —— **平行世界推演（weave）+ 平行事件推进（advance）+ 转正（promote）+ 清理（prune）**
//   （B8-7-b，逐字移植自 V1 v1.206 `src/modules/09-AI摘要与楼层处理.js` 与 `src/modules/04-面板与交互.js`：
//      `runParallelWeave` / `scheduleParallelWeave` / `weaveEnabled` / `weavePassiveDue`（约 12998~13158）、
//      `runParallelAdvance` 及其助手（约 13819~13965）、`promoteParallelEvent` / `prunePromotedParallels`（约 11114~11184））
//
// 定位（V1 v1.58/v1.59/v1.69/v1.72/v1.166/v1.196）：
//   ① **推演世界（交织管线）** `runParallelWeave(floorRange, opts)`：把「最近楼层正文 + 相关原子上下文」交 AI，
//      以八卦为纲、因果为线推演出**正文之外的潜在事件线**（`state.parallels`）。独立于提取/摘要管线：
//      · 被动调度 `scheduleParallelWeave(floorRange, keywords)`：提取成功后被调用 → 延迟 1.8s 执行；长任务占用时
//        排队等待（每 2.5s 轮询，最长 `WEAVE_WAIT_MS` = 2 分钟，超时放弃并记日志）；
//      · 楼层间隔闸门 `weavePassiveDue`：距上次被动触发不足 `cfg.parallelWeaveInterval`（默认 10）楼则跳过（手动 force 不受限）；
//      · 输入签名去重 `weaveInputSig`（楼层正文 + 原子内容哈希）：同输入不再重复分析（force 除外）；
//      · 关键词命中 `matchParallelsByKeywords`：命中的既有条目优先「更新」承前深化（标签/因果线/标题/卦象/角色）；
//      · 落库走 `core/ingest.js#mergeDelta`（V1 同源：`mergeDelta({平行事件: pc}, {start,end})`）；完成后顺带调度平行事件衰退。
//   ② **推进/演变** `runParallelAdvance(opts)`：把「最近楼层正文 + 近期记忆速览」作为背景与种子，
//      对 `{ids:[…]}` 或 `{all:true}` 的平行事件逐批（`ADVANCE_CHUNK` = 6）交 AI 向前推进一个阶段。
//      ⚠ V1 提示词明确「**禁止强行把事件牵引向 user 主角**」——保持各事件独立视角。
//   ③ **转正为情节** `promoteParallelEvent(id, opts)`：**只由用户显式动作触发**（推演 ≠ 事实）——
//      生成/更新一条**情节原子**（走正常注入与知情约束），随后**自动移除该平行记录**并留删除墓碑（v1.196）。
//      兼容历史存档（旧版只写 `promotedTo` 软标记）→ `prunePromotedParallels()` 载入时清理。
//   ④ **清理** `prunePromotedParallels()`：仅当被转正的情节**确实存在**时才移除，避免误删唯一记录。
//
// 复用（不重复实现）：
//   · 平库落库 / 上限裁剪 → `core/ingest.js#mergeDelta`；平行衰退调度 → `core/ingest.js#scheduleParallelDecay`；
//   · 已过期判定 → `core/recall.js#parallelExpired`；「参与运作的情节」→ `core/merge.js#activeAtoms`；
//   · 条目写入/删除（含删除墓碑）→ `core/entries.js#upsertEntry / deleteEntry`；
//   · 文本裁剪 → `core/model/scalars.js#dimCap / mergeTags`；哈希 → `core/util.js#hashText`；
//   · AI 调用 / 互斥 → `core/ai-hooks.js#aiCallText / aiBusy`；通知 → `core/model/runtime.js#notifyHooks`。
//
// 适配（与 V1 的差异，逐条见 docs/P8x-B8-7平行推演与转正.md）：
//   ① ESM 化 + 视图注入（`state` / `cfg` / `saveState` / `dbgLog` / `warn` / `notifyHooks` / `timerHooks` /
//      `getLastMessageId` / `getStoryNow` 全部来自 `core/model/runtime.js`；V1 是模块内全局）；
//   ② 楼层取文：V1 直接调宿主 `collectFloorLinesInRange(start, end, {})` → V2 改经**注入钩子**
//      `setParallelTextHooks({ floorLinesInRange })`（与 `core/clock-extract.js#setClockTextHooks` 同款写法，
//      内核不读宿主聊天）；宿主接线见 `index.js`（`host/floors.js#collectFloorLinesInRange`），未接线时返回空数组；
//   ③ `pipelineOccupied()`（V1 = `longTaskBusy() || syncOcc()`）→ 宿主互斥钩子 `aiBusy()` 叠加本模块自身的
//      `weaveBusy` / `advanceBusy`（V2 无存储同步占用概念；宿主 `aiBusy()` 即「摘要/提取在途」）；
//   ④ V1 的 `newTaskStart / abortTick / abortQuiet / pipeStart / pipeUpdate / pipeEnd / renderPanel` 未移植
//      （V2 无任务中断标志与管线状态 UI；中断/重绘由宿主与 UI 层负责）；
//   ⑤ `resolveParallelApiOverride()`（平行事件专用分析渠道预设 `cfg.parallelApiPreset`）**未移植** ——
//      V2 的 AI 通道由宿主统一接线（`aiCallText`），无「按域切换 API 预设」概念；V1 的调用标签原样透传
//      （`'[平行事件·交织]'` / `'平行事件推进'`）；
//   ⑥ 定时调度改用注入的 `timerHooks.set(fn, ms)`（V1 直接 `setTimeout`）—— 未接线时内核默认 no-op；
//   ⑦ 主流程增设可选 `opts.aiText` 注入点（与 `runRepair` / `runPlotSegmentSummary` 同约定，供黄金样本与离线测试）；
//   ⑧ `lastExtractKeywords`（V1 全局，由提取管线写入）→ 本模块 `setParallelLastKeywords / parallelLastKeywords`
//      （默认空数组）。关键词提取 `jsExtractKeywords` 已于本批（P9d）**逐字移植**到本模块（V1 约 11213~11232），
//      并由 `host/extract.js` 在提取合并成功后接线（`scheduleParallelWeave(floorRange, jsExtractKeywords(text))`）；
//      手动「推演世界」仍默认传空关键词（与 V1「关键词为空」时的行为一致：上下文退化为列出既有平行事件）。
//
// ⚠️ 与 V1 一致的**既有缺陷/怪癖**（如实保留、不擅自修正，黄金样本已固化）：
//   · `scheduleParallelWeave` 的「已在调度中」判定 `weaveBusy || weaveTimer` 会**静默丢弃后到的请求**
//     （不排队、不替换 pending）—— 先到者生效；
//   · 被动推演**只有** `runParallelWeave` 的失败/跳过路径不写 `weaveLastFloor`：去重跳过（`skipped:'dedup'`）时
//     楼层已先被计数（V1 顺序即如此：先写 `weaveLastFloor` 再判签名）；
//   · `runParallelAdvance` 的忙位返回 `{ ok: true, skipped: 'busy' }`（**ok 为 true**，与推演的 `{ok:false,error:'busy'}` 不一致）；
//   · `promoteParallelEvent` 的注释称「id + 内容哈希双墓碑」，但实际经 `deleteEntry('parallels', id)` 只写
//     **id 墓碑**（内容哈希墓碑由存储层「删除留痕」在保存时补记，见 `core/sweep.js#applyDeletedToArray` 的 learnH）
//     —— V1 源码里 `tombEntry(dim, p)` 的兜底分支**在真实路径上不可达**（`deleteEntry` 恒为函数）；
//   · `applyAdvanceUpdate` 对 `演化目标可能性` **只认中文键 `目标`**，`: likelihood` 缺省为 0 并夹取 [0,100]
//     （`可能性` 别名可用；空目标项被丢弃）；
//   · `buildAdvanceContext` 的「近期记忆速览」用 `activeAtoms()`（已总结隐藏的情节不进背景）。
// 一致性由 tests/unit/parallel-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, dbgLog, warn, notifyHooks, timerHooks, getLastMessageId, getStoryNow } from './model/runtime.js';
import { hashText, normText, normalizeList, clamp, extractJsonObject } from './util.js';
import { dimCap, mergeTags } from './model/scalars.js';
import { activeAtoms, tombEntry } from './merge.js';
import { mergeDelta, scheduleParallelDecay } from './ingest.js';
import { parallelExpired } from './recall.js';
import { upsertEntry, deleteEntry } from './entries.js';
import { rumorMarkParallelChange } from './rumor-evolve.js';
import { aiCallText, aiBusy } from './ai-hooks.js';
import { defaultCfg } from './config.js';

// ---------- 楼层取文钩子（宿主注入；内核默认空） ----------
let textHooks = {
    /** 区间楼层原始行（V1 `collectFloorLinesInRange(start, end, {})`；返回字符串数组） */
    floorLinesInRange: () => [],
};
/** 注入取文钩子（宿主启动时调用；传 { floorLinesInRange }） */
export function setParallelTextHooks(next) { textHooks = Object.assign({}, textHooks, next || {}); return textHooks; }
/** 区间楼层行（异常 → 空数组） */
function floorLines(start, end) {
    try { const r = textHooks.floorLinesInRange(Number(start) || 0, Number(end) || 0); return Array.isArray(r) ? r : []; }
    catch (e) { return []; }
}

// ---------- V1 弹窗兼容入口（`notify(kind,{title,text})` / `toast(msg,type)`） ----------
/** V1 `LEGACY_STRIP_ICONS`：`toast()` 兼容入口剥离的前导图标（V1 原样） */
const LEGACY_STRIP_ICONS = ['✅', '⚠️', '❌', '🔄', '📤', '🧭', '📸', '🛠', '💀', '🚀', '🧠', '🗜', '⏪', '⏳', '🧪', '📥'];
/** 剥离前导图标（V1 `stripLegacyIcon` 逐字） */
function stripLegacyIcon(msg) {
    let s = String(msg == null ? '' : msg);
    for (const ic of LEGACY_STRIP_ICONS) { if (s.startsWith(ic)) { s = s.slice(ic.length).replace(/^\s+/, ''); break; } }
    return s;
}
/** 用户提示（V1 `notify(kind, {title, text})` 的 V2 等价；与 core/repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/** V1 遗留入口 `toast(msg, type)`：正文 + 类型（无标题；前导图标同 V1 剥离） */
function toast(text, kind) {
    try { notifyHooks.toast(stripLegacyIcon(text), String(kind || 'info')); } catch (e) { /* 忽略 */ }
}

/** 管线占用（V1 `pipelineOccupied()` = 长任务 **或** 存储同步在途；V2 = 宿主互斥钩子 + 本模块在途位） */
function pipelineOccupied() { return aiBusy() || weaveBusy || advanceBusy; }

// ---------- 最近一次提取的关键词（V1 全局 `lastExtractKeywords` 的 V2 等价） ----------
let lastExtractKeywords = [];
/** 写入最近提取关键词（提取域接线后调用；最多 10 个） */
export function setParallelLastKeywords(list) {
    lastExtractKeywords = Array.isArray(list) ? list.slice(0, 10) : [];
    return lastExtractKeywords.slice();
}
/** 读最近提取关键词（副本） */
export function parallelLastKeywords() { return Array.isArray(lastExtractKeywords) ? lastExtractKeywords.slice() : []; }

/**
 * 第二层：浏览器 JS 抽取关键词（**逐字移植** V1 v1.206 `jsExtractKeywords`，约 11213~11232）。
 * 从输入文本中提取与记忆库特征词（标签/关键词/角色名/场景名/计划原文/状态主体/平行事件标签）匹配的词，
 * 零 AI / 零向量 / 零网络：特征词必须**原样出现在正文**且长度 ≥ 2；按固定来源顺序去重；最多 10 个。
 * 用途（V1 同源）：`scheduleParallelWeave(floorRange, jsExtractKeywords(floorText))` 的被动推演关键词；
 *   V1 的另一处调用（`jsExtractMemory` 本地召回）在 V2 由 `core/recall.js` 的本地召回承担，不在本函数内。
 * 数据源顺序（V1 原样）：情节（`activeAtoms()`，已总结隐藏的不进索引）→ 记忆 → 概念 → 角色档案名
 *   → 场景名 → 计划正文前 8 字（双向包含取「正文含该片段」）→ 状态主体 → 平行事件标签/关键词。
 * @param {string} text 楼层正文
 * @returns {string[]} 最多 10 个命中特征词（异常 → 空数组，与 V1 一致：`warn` 后返回 []）
 */
export function jsExtractKeywords(text) {
    try {
        const t = String(text || '');
        if (!t) return [];
        const words = [];
        const add = (w) => { const s = String(w || '').trim(); if (s && s.length >= 2 && t.includes(s) && !words.includes(s)) words.push(s); };
        for (const a of activeAtoms()) (a.tags || []).concat(a.keywords || []).forEach(add);   // v1.203：已总结隐藏的不进索引
        for (const m of (state.memories || [])) (m.tags || []).concat(m.keywords || []).forEach(add);
        for (const c of (state.concepts || [])) (c.tags || []).concat(c.keywords || []).forEach(add);
        for (const s of (state.snapshots || [])) add(s.name);
        for (const sc of (state.scenes || [])) add(sc.name);
        for (const p of (state.plans || [])) { const frag = String(p.content || '').slice(0, 8); if (frag && t.includes(frag)) add(frag); }
        for (const s of (state.currentStates || [])) add(s.subject);
        // 平行事件参与关键词抽取（标签为特征词；标题/描述由正文命中直接匹配）
        for (const p of (state.parallels || [])) (p.tags || []).concat(p.keywords || []).forEach(add);
        return words.slice(0, 10);
    } catch (e) { warn('JS 关键词抽取失败', e); return []; }
}

// ==================== v1.58/v1.59 交织管线（平行事件 · 独立触发管道） ====================
// V1 口径（原文）：独立排队/去重 + 前后通知 + 上限(maxParallels) + 关键词关联更新。
let weaveBusy = false;
let weaveTimer = null;
let weavePending = null;       // 待执行 {floorRange, keywords, t0}
const WEAVE_WAIT_MS = 120000;  // v1.75（B1）：长任务互斥 —— 被动推演等待其它长任务释放的最长时限（2 分钟）
let lastWeaveSig = null;       // 上次已分析输入签名（楼层正文+原子内容）

/** 推演开关（V1 `weaveEnabled`）：`cfg.parallelWeaveEnabled !== false` 即开启（缺省开启） */
export function weaveEnabled() { return !!(cfg && cfg.parallelWeaveEnabled !== false); }
/** 输入签名：楼层正文哈希 + 原子（情节/状态/记忆）内容哈希 —— 用于「同样的正文/原子不被重复分析」 */
export function weaveInputSig(start, end, floorsText) {
    try {
        const atomSig = hashText((state.atoms || []).map(a => (a.id || '') + ':' + String(a.text || a.title || '').slice(0, 140)).join('|'));
        return hashText(start + '-' + end + '|' + String(floorsText || '') + '|' + atomSig);
    } catch (e) { return ''; }
}
/** v1.69：被动触发楼层间隔判定 —— 距上次被动触发不足 parallelWeaveInterval（默认 10）楼则跳过（手动 force 不受限） */
export function weavePassiveDue(endF) {
    try {
        const iv = Math.max(0, Number(cfg.parallelWeaveInterval) != null ? Math.floor(Number(cfg.parallelWeaveInterval)) : 10);
        if (iv <= 0) return true;
        const last = Number(state.weaveLastFloor) || -1;
        if (last < 0) return true;
        const e = Number(endF);
        return e >= 0 && (e - last) >= iv;
    } catch (e) { return true; }
}
/**
 * 提取记忆成功合并后调度：异步走独立 weave 队列推演/更新平行事件（不阻塞主提取）。
 * 早退：开关关闭 / 已在推演 / 已在调度中 → 直接返回（V1 不排队，**丢弃后到请求**）。
 * @param {{start:number,end:number}} floorRange
 * @param {string[]} [keywords]
 */
export function scheduleParallelWeave(floorRange, keywords) {
    try {
        if (!weaveEnabled() || weaveBusy || weaveTimer) return;
        const fr0 = floorRange || {};
        const endF0 = Number(fr0.end) >= 0 ? Number(fr0.end) : (Number(fr0.start) >= 0 ? Number(fr0.start) : -1);
        // v1.69：楼层间隔闸门（默认每 10 楼被动触发 1 次）
        if (!weavePassiveDue(endF0)) {
            try { dbgLog('发送记忆', { action: '平行事件间隔未到', floor: endF0, last: Number(state.weaveLastFloor) || -1, interval: Number(cfg.parallelWeaveInterval) != null ? Number(cfg.parallelWeaveInterval) : 10, skip: true }); } catch (e) { /* 忽略 */ }
            return;
        }
        const fr = floorRange || {};
        weavePending = { floorRange: fr, keywords: Array.isArray(keywords) ? keywords.slice(0, 10) : [], t0: Date.now() };
        // v1.75（B1）：长任务互斥 —— 摘要/修复/情节总结/推进占用时，被动推演不丢弃而是排队等待（2 分钟内轮询，
        // 间隔 2.5s）；互斥位释放后自动执行。避免 weave 与 summary/advance/compact 在 state 读改写上交错。
        const fireWeave = async () => {
            weaveTimer = null;
            const task = weavePending; weavePending = null;
            try {
                const r = await runParallelWeave(task && task.floorRange, { keywords: task && task.keywords });
                if (r && r.error === 'busy' && task && (Date.now() - (task.t0 || Date.now())) < WEAVE_WAIT_MS) {
                    weavePending = task;
                    weaveTimer = timerHooks.set(fireWeave, 2500);
                    return;
                }
                if (r && r.error === 'busy' && task) {
                    try { dbgLog('发送记忆', { action: '平行事件推演放弃（长任务持续占用超过 2 分钟）', start: task.floorRange && task.floorRange.start, end: task.floorRange && task.floorRange.end }); } catch (e) { /* 忽略 */ }
                }
            } catch (e) { warn('交织管线失败', e); }
        };
        weaveTimer = timerHooks.set(fireWeave, 1800);
    } catch (e) { /* 忽略 */ }
}
/** 关键词 → 命中既有平行事件（标签/因果线/标题/卦象/涉及角色包含任一关键词）＝「需更新候选」 */
export function matchParallelsByKeywords(keywords) {
    try {
        const kws = (keywords || []).map(k => String(k || '').toLowerCase()).filter(k => k && k.length >= 2);
        if (!kws.length) return [];
        const hay = (p) => [p.title, p.gua, p.causalLine, String((p.characters || []).join(' ')), String((p.tags || []).join(' '))].join(' ').toLowerCase();
        return (state.parallels || []).filter(p => kws.some(k => hay(p).includes(k)));
    } catch (e) { return []; }
}
/**
 * 推演世界主流程（V1 `runParallelWeave`）。
 * 早退：管线占用 → `{ok:false, error:'busy'}`；同输入签名（非 force）→ `{ok:true, skipped:'dedup'}`；
 * AI 无 JSON / 无「平行事件」键 → `{ok:false, error:'AI 未返回有效 JSON'}`；三键皆空 → `{ok:true, skipped:'empty'}`。
 * @param {{start?:number,end?:number}} [floorRange]
 * @param {{keywords?:string[], force?:boolean, aiText?:string}} [opts]
 * @returns {Promise<object>} V1 同形返回结构
 */
export async function runParallelWeave(floorRange, opts) {
    try {
        if (pipelineOccupied()) return { ok: false, error: 'busy' };   // v1.148：同步在途同样视为占用
        weaveBusy = true;
        try {
            const o = opts || {};
            const force = !!o.force;
            const fr = floorRange || {};
            const start = Number(fr.start) >= 0 ? Number(fr.start) : 0;
            const end = Number(fr.end) >= 0 ? Number(fr.end) : (start + (Number(cfg.summaryFloors) || 10));
            // v1.69：被动触发记录最近楼层（间隔依据；force 手动触发不计数）
            if (!force && Number(state.weaveLastFloor || -1) < end) {
                state.weaveLastFloor = end;
                try { saveState(); } catch (e) { /* 忽略 */ }
            }
            const lines = floorLines(start, end);
            const floorsText = lines.join('\n').slice(0, 6000);
            const keywords = Array.isArray(o.keywords) ? o.keywords.slice(0, 10) : [];
            // —— 独立管道输入去重：同楼层正文 + 同原子内容不再重复分析（手动 force 除外）——
            const sig = weaveInputSig(start, end, floorsText);
            if (!force && sig && lastWeaveSig === sig) {
                notify('weave', '推演世界：已跳过重复分析', `楼层 ${start}-${end} 正文与原子未变化。`);
                try { dbgLog('发送记忆', { action: '平行事件去重跳过', start, end, sig }); } catch (e) { /* 忽略 */ }
                return { ok: true, skipped: 'dedup', start, end };
            }
            const kwStr = keywords.length ? ' · 🔑 ' + keywords.join('、') : '';
            // —— 触发前通知（楼层 / 关键词 / 分析字数）——
            notify('weave', '推演世界开始…', `楼层 ${start}-${end}${kwStr} · 分析 ${floorsText.length} 字`);
            const matched = matchParallelsByKeywords(keywords);
            const ctx = [];
            const push = (label, arr, n, fn) => { (arr || []).slice(0, n).forEach(it => { const st = fn(it); if (st) ctx.push('[' + label + '] ' + st); }); };
            push('情节', activeAtoms(), 18, a => a.text || a.title);
            push('状态', state.currentStates, 10, s => s.subject && s.field ? s.subject + '·' + s.field + '：' + s.value : '');
            push('角色', state.snapshots, 8, s => s.name);
            push('记忆', state.memories, 10, m => m.title || m.content);
            push('悬念', state.suspense, 8, sp => sp.content);
            push('计划', state.plans, 6, p => p.content);
            if (matched.length) {
                ctx.push('【平行事件 · 关键词命中待更新（优先用「更新」承前深化其因果/卦象/目标可能性）】');
                matched.slice(0, 8).forEach(p => ctx.push('[平行] ' + (p.title || '') + '【卦:' + (p.gua || '') + ' 因果:' + String(p.causalLine || '').slice(0, 90) + '】'));
            } else {
                push('平行事件(既有)', state.parallels, 20, p => (p.title || '') + '【卦:' + (p.gua || '') + ' 因果:' + String(p.causalLine || '').slice(0, 90) + '】');
            }
            const pt = cfg.promptTemplates || defaultCfg.promptTemplates;
            const sysMsg = [
                pt.general || '',
                '以下是交织管线（平行事件推演）专用指令（八卦为纲、因果为线）：',
                pt.parallels || ((defaultCfg.promptTemplates || {}).parallels) || '',
            ].join('\n\n');
            const userMsg = [
                '最近正文：\n' + floorsText,
                '相关原子上下文：\n' + ctx.join('\n').slice(0, 4000),
                '触发关键词（提取记忆所得，用于关联更新）：' + (keywords.length ? keywords.join('、') : '（无）'),
                '输出规则：只输出一个 JSON 对象（键为「平行事件」：{新增:[...], 更新:[...], 删除:[...]}），不要解释；' +
                    '更新 = 用「标题或原文」定位既有平行事件并承前深化（关键词命中标签/因果线/标题/卦象/角色的既有条目**优先更新**）；' +
                    '若近期正文没有值得推演或更新的潜在点则输出 {"平行事件": {}}。',
            ].join('\n\n');
            const prompt = [
                { role: 'system', content: sysMsg },
                { role: 'user', content: userMsg },
            ];
            const beforeCount = (state.parallels || []).length;
            // V1：`callChatCompletion(prompt, resolveParallelApiOverride(), '[平行事件·交织]', 'weave')`
            const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '[平行事件·交织]'));
            const delta = extractJsonObject(resp);
            if (!delta || !delta['平行事件']) return { ok: false, error: 'AI 未返回有效 JSON' };
            const pc = delta['平行事件'] || {};
            const addN = Array.isArray(pc['新增']) ? pc['新增'].length : 0;
            const updN = Array.isArray(pc['更新']) ? pc['更新'].length : 0;
            const delN = Array.isArray(pc['删除']) ? pc['删除'].length : 0;
            if (!addN && !updN && !delN) {
                lastWeaveSig = sig;
                notify('weave', '推演世界完成', `分析 ${floorsText.length} 字 · 无新增/更新点（共 ${state.parallels.length} 条）`);
                return { ok: true, skipped: 'empty', start, end };
            }
            const merged = mergeDelta({ 平行事件: pc }, { start: start, end: end });
            const afterCount = (state.parallels || []).length;
            // —— 触发后通知：楼层 / 分析字数 / 提取事件数量 ——
            notify('success', `推演世界完成：楼层 ${start}-${end}`, `分析 ${floorsText.length} 字 · 新增 ${addN} / 更新 ${updN}${delN ? ' / 删除 ' + delN : ''}（平行事件共 ${afterCount} 条）`);
            try {
                dbgLog('发送记忆', { action: '平行事件推演完成', start, end, chars: floorsText.length, add: addN, update: updN, del: delN, before: beforeCount, after: afterCount, keywords: keywords.slice(0, 6), matched: matched.length });
            } catch (e) { /* 忽略 */ }
            lastWeaveSig = sig;
            // v1.192：平行世界发生变化 → 传言轮次重新计数（之后每隔 N 轮触发一次传言变化）
            try { if (addN || updN || delN) rumorMarkParallelChange(end); } catch (e) { /* 忽略 */ }
            return { ok: true, merged: merged, added: addN, updated: updN, start, end };
        } finally {
            weaveBusy = false;
            // v1.60：推演完成后顺带触发衰退清扫（防抖）
            try { scheduleParallelDecay(); } catch (e) { /* 忽略 */ }
        }
    } catch (e) {
        // V1 此处先判「用户中断」（abortQuiet）；V2 无中断标志 → 一律按异常告警。
        warn('交织管线异常', e); return { ok: false, error: String(e && e.message || e) };
    }
}

// ==================== v1.72 平行事件「推进/演变」（手动 · 全部/单条） ====================
// 平行事件页顶部「全部推进」或每条右侧「推进」：把 记忆数据（最近楼层正文 + 相关原子上下文）与
// 「需推进的平行事件」现状一并交给 AI 逐一向前推进演变。
// 注意：这些事件**不一定与 user 主角直接相关**——可能只是世界背景/间接相关——提示词明确
// 「禁止强行把事件牵引向 user 主角」（仅当事件本身已涉及主角才提主角），保持各自独立视角客观推进。
let advanceBusy = false;
const ADVANCE_CHUNK = 6;

/** 事件关联记忆种子：以该事件的 标签/标题/角色 命中 情节/记忆/状态/计划/悬念（局部来龙去脉） */
export function advanceContextSeed(p) {
    try {
        const terms = [];
        for (const t of (p.tags || [])) terms.push(String(t).toLowerCase());
        if (p.title) terms.push(String(p.title).toLowerCase());
        for (const c of (p.characters || [])) terms.push(String(c).toLowerCase());
        if (!terms.some(t => t && t.length >= 2)) return [];
        const hit = (hay) => { const h = String(hay || '').toLowerCase(); return terms.some(t => t && t.length >= 2 && (h.includes(t) || t.includes(h))); };
        const lines = [];
        const add = (label, arr, pick) => { (arr || []).slice(0, 50).forEach(x => { const v = pick(x); if (hit(v)) lines.push(`- ${label}${String(v).slice(0, 140)}`); }); };
        add('情节:', activeAtoms(), a => a.text || a.title || '');
        add('记忆:', state.memories, m => `${m.title || ''} ${m.content || ''}`);
        add('状态:', state.currentStates, s => `${s.subject} ${s.field} ${s.value}`);
        add('计划:', state.plans, pl => pl.content || '');
        add('悬念:', state.suspense, su => su.content || '');
        return lines.slice(0, 12);
    } catch (e) { return []; }
}
/** 推进所需记忆数据（背景）：最近楼层正文 + 各维度近期速览 */
export function buildAdvanceContext(targets) {
    const lines = [];
    try {
        const lastId = getLastMessageId();
        if (lastId >= 0) {
            const feedN = Math.max(1, Number(cfg.feedFloors) || Number(cfg.summaryFloors) || 10);
            const lines0 = floorLines(Math.max(0, lastId - feedN + 1), lastId);
            lines.push('【最近正文（记忆背景）】\n' + lines0.join('\n').slice(-3000));
        }
    } catch (e) { /* 忽略 */ }
    lines.push('【近期记忆速览】');
    const pushD = (label, arr, n, fn) => { (arr || []).slice(0, n).forEach(it => { const s = fn(it); if (s) lines.push(`[${label}] ${s}`); }); };
    pushD('情节', activeAtoms(), 14, a => a.text || a.title);
    pushD('状态', state.currentStates, 8, s => s.subject && s.field ? s.subject + '·' + s.field + '：' + s.value : '');
    pushD('记忆', state.memories, 8, m => (m.title || '') + '：' + (m.content || ''));
    pushD('计划', state.plans, 4, pl => pl.content);
    pushD('悬念', state.suspense, 4, su => su.content);
    return lines.join('\n').slice(0, 6000);
}
/** 推进提示词（V1 `buildAdvancePrompt` 逐字） */
export function buildAdvancePrompt(targets, memText) {
    const sys = [
        '你是推演引擎，负责把既有「平行事件」逐条**向前推进/演变**（时间向前推进一个阶段）。',
        '这些平行事件**不一定与 user 主角直接相关**——可能只是世界背景、间接影响或他处独立事件。',
        '**禁止强行把事件牵引向 user 主角**：仅当事件现状本身已涉及主角时才可提及主角；否则保持其独立视角与世界逻辑，客观推进。',
        '对每条事件输出 1 条推进结果：正文=**新一阶段的演变**（承接现状并延伸因果，给出后续进展/新变化/新悬念，不要重复旧文本）；',
        '可同步更新 类型/日期/卦象/因果线/涉及角色/发生地点/标签 与 演化目标可能性（可增减分支或调整概率）；',
        'id 必须原样返回、与输入一一对应；某条暂无可推进内容时可省略该条。',
        '只输出一个 JSON 对象：{"推进":[{"id":"…","标题":"…","正文":"…","类型":"…","卦象":"…","因果线":"…","涉及角色":["…"],"演化目标可能性":[{"目标":"…","可能性":60}]}]}',
    ].join('\n');
    const ev = [];
    for (const p of targets) {
        const seed = advanceContextSeed(p);
        ev.push(`[事件 ${p.id}] 标题:${p.title || ''}｜正文:${p.text || ''}｜卦:${p.gua || ''}｜因果:${String(p.causalLine || '').slice(0, 160)}｜角色:${(p.characters || []).join('、') || '（未知）'}｜走向:${(p.goalOdds || []).map(g => `${g.target}(${Number(g.likelihood) || 0}%)`).join('、') || '（未定）'}`);
        if (seed.length) ev.push(`  关联记忆种子:\n    ${seed.join('\n    ')}`);
    }
    const user = [
        memText,
        '以下是需要推进的平行事件（含关联记忆种子，供了解来龙去脉与作为演变依据）：\n' + ev.join('\n'),
    ].join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}
/** 应用单条推进结果（id 稳定保留；updatedAt 刷新 → 衰退重置） */
export function applyAdvanceUpdate(p, u) {
    try {
        const o = u || {};
        const text = dimCap('parallels', normText(o.正文 || o.text || o.content || o.描述 || '', 400));
        const title = normText(o.标题 || o.title || '', 60);
        if (!title && !text) return false;
        if (title) p.title = title;
        if (text) p.text = text;
        if (o.type) p.type = normText(o.type, 20);
        if (o.date) p.date = normText(o.date, 10);
        if (o.time) p.time = normText(o.time, 20);
        if (o.卦象 || o.gua) p.gua = normText(o.卦象 || o.gua, 80);
        if (o.因果线 || o.causalLine) p.causalLine = normText(o.因果线 || o.causalLine, 600);
        if (o.涉及角色 || o.characters) p.characters = normalizeList(o.涉及角色 || o.characters);
        if (o.发生地点 || o.location) p.location = normText(o.发生地点 || o.location, 60);
        if (o.标签 || o.tags) p.tags = normalizeList(o.标签 || o.tags).slice(0, 8);
        if (Array.isArray(o.演化目标可能性) || Array.isArray(o.goalOdds)) {
            const gs = Array.isArray(o.演化目标可能性) ? o.演化目标可能性 : o.goalOdds;
            const odds = [];
            for (const g of gs) { if (!g || typeof g !== 'object') continue; const target = normText(g.target || g.目标, 100); if (!target) continue; let like = Number(g.likelihood !== undefined ? g.likelihood : g.可能性); if (!Number.isFinite(like)) like = 0; odds.push({ target, likelihood: clamp(Math.round(like), 0, 100) }); }
            p.goalOdds = odds;
        }
        if (o.importance !== undefined) p.importance = clamp(Number(o.importance) != null ? Number(o.importance) : 0.5, 0, 1);
        p.updatedAt = Date.now();
        return true;
    } catch (e) { return false; }
}
/**
 * 推进主流程（V1 `runParallelAdvance`）：逐批（≤6 条）交 AI 「推进」，按 id 精确应用。
 * 早退：无目标 → `{ok:true, skipped:'no-targets'}`；管线占用 → `{ok:true, skipped:'busy'}`；
 * 目标全数列已过期 → `{ok:true, skipped:'none-active'}`（`parallelExpired` 过滤）。
 * @param {{ids?:string[], all?:boolean, aiText?:string}} [opts]
 * @returns {Promise<object>} V1 同形返回结构
 */
export async function runParallelAdvance(opts) {
    try {
        const o = opts || {};
        const list = state.parallels || [];
        const wantIds = o.all ? list.map(p => p.id) : (Array.isArray(o.ids) ? o.ids.map(String) : []);
        if (!wantIds.length) return { ok: true, skipped: 'no-targets' };
        if (pipelineOccupied()) return { ok: true, skipped: 'busy' };   // v1.148：同步在途同样视为占用
        const targets = list.filter(p => p && wantIds.includes(String(p.id)) && !parallelExpired(p));
        if (!targets.length) return { ok: true, skipped: 'none-active' };
        advanceBusy = true;
        try {
            const t0 = Date.now();
            const memText = buildAdvanceContext(targets);
            const chunks = Math.ceil(targets.length / ADVANCE_CHUNK);
            // v1.73：发送前通知 —— 目标条数 / 分批 / 记忆背景字数
            try { toast(`🚀 平行事件推进开始：目标 ${targets.length} 条 · 分批 ${chunks} · 记忆背景 ${memText.length} 字`, 'info'); } catch (e) { /* 忽略 */ }
            let updated = 0;
            let aiCalls = 0;
            let sentChars = 0;
            for (let s = 0; s < targets.length; s += ADVANCE_CHUNK) {
                const chunk = targets.slice(s, s + ADVANCE_CHUNK);
                const prompt = buildAdvancePrompt(chunk, memText);
                sentChars += (String(prompt[0].content || '').length + String(prompt[1].content || '').length);
                aiCalls++;
                // V1：`callChatCompletion(prompt, resolveParallelApiOverride(), '平行事件推进', 'analysis')`
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '平行事件推进'));
                const obj = extractJsonObject(resp);
                const arr = obj && Array.isArray(obj.推进) ? obj.推进 : [];
                if (!arr.length) { warn('平行事件推进：AI 未返回有效 推进 数组', ''); continue; }
                const byId = {};
                for (const it of arr) { const id = String((it && (it.id !== undefined ? it.id : '')) || '').trim(); if (id) byId[id] = it; }
                for (const p of chunk) {
                    const u = byId[String(p.id)];
                    if (!u) continue;
                    if (applyAdvanceUpdate(p, u)) updated++;
                }
            }
            if (updated) saveState();
            try { dbgLog('发送记忆', { action: '平行事件推进', target: targets.length, updated, aiCalls, sentChars, ms: Date.now() - t0, ids: targets.slice(0, 6).map(p => p.id) }); } catch (e) { /* 忽略 */ }
            // v1.73：分析结束后通知 —— 更新数 / AI 调用 / 发送字数 / 用时
            try { toast(`🚀 平行事件推进完成：更新 ${updated}/${targets.length} 条 · AI 调用 ${aiCalls} 次 · 发送 ${sentChars} 字 · 用时 ${Date.now() - t0}ms`, updated ? 'success' : 'info'); } catch (e) { /* 忽略 */ }
            return { ok: true, target: targets.length, updated, aiCalls, sentChars, ms: Date.now() - t0 };
        } finally { advanceBusy = false; }
    } catch (e) {
        // V1 此处先判「用户中断」（abortQuiet）；V2 无中断标志 → 一律按异常告警。
        warn('平行事件推进失败', e); return { ok: false, error: String(e && e.message || e).slice(0, 120) };
    }
}

// ==================== v1.166 / v1.196 平行事件「转正为情节」 ====================
/**
 * 平行事件「转正为情节」（v1.166 / **v1.196：转正后自动移除平行记录**）——
 * **只由用户显式动作触发**：推演 ≠ 事实（Q20-A），转正生成/更新一条**情节**（走正常注入与知情约束）；
 * v1.196 起：**新情节落库后自动删除该平行事件**（留 id 墓碑，防跨端合并/快照还原把它带回来）。
 * 兼容：历史存档里仍带 `promotedTo`（旧软标记）的条目，载入时按 `prunePromotedParallels()` 清理。
 * @param {string} id 平行事件 id
 * @param {{text?:string, at?:string}} [opts] 可覆盖正文与转正时间
 * @returns {{ok:boolean, atomId?:string, updated?:boolean, removed?:boolean, promotedAt?:string, reason?:string}}
 */
export function promoteParallelEvent(id, opts) {
    try {
        const p = ((state && state.parallels) || []).find(x => x && String(x.id) === String(id));
        if (!p) return { ok: false, reason: '未找到该平行事件' };
        const o = opts || {};
        let text = String(o.text || p.text || '').trim();
        const title0 = String(p.title || '').trim();
        // 原子层要求正文 ≥8 字：过短时用标题补足（标题本身不重复进正文）
        if (text.length < 8 && title0 && title0 !== text) text = `${title0}：${text}`.replace(/：$/, '').trim();
        if (text.length < 8) return { ok: false, reason: '内容过短：情节正文需 ≥8 字（请先补全平行事件描述）' };
        const title = String(p.title || '').trim();
        const date = String(p.date || '').trim();
        const prevId = String(p.promotedTo || '').trim();
        const prevAtom = prevId ? (state.atoms || []).find(x => x && String(x.id) === prevId) : null;
        const raw = {
            title: (title && title !== text) ? title : '',
            text,
            type: String(p.type || '').trim() || '转折',
            date: date || (prevAtom ? String(prevAtom.date || '') : ''),
            time: String(p.time || '').trim(),
            entities: normalizeList(p.characters),
            locations: p.location ? [String(p.location).trim()] : [],
            tags: mergeTags(Array.isArray(p.tags) ? p.tags.slice(0, 5) : [], []),
            importance: Number(p.importance) || 0.6,
        };
        if (prevAtom) raw.id = prevAtom.id;             // 幂等：原地更新既有情节
        if (!upsertEntry('atoms', raw)) return { ok: false, reason: '情节写入失败' };
        const hit = ((state.atoms) || []).slice().reverse().find(x => x && String(x.text || '').trim() === text && (!raw.id || String(x.id) === String(raw.id)));
        const atomId = hit ? String(hit.id) : (raw.id || prevId || '');
        // v1.196：先留痕（写 promotedTo/promotedAt，供本次调用与迁移判断），再**从平行库中移除**该条
        p.promotedTo = atomId || '情节';
        let at = String(o.at || '').trim();
        // ⚠ V1 怪癖逐字保留：`(getStoryNow() || {}).date` —— V1/V2 的 `getStoryNow()` 返回**字符串**，
        //   取其 `.date` 恒为 undefined → 实际总是回落到 `state.state.date`。
        if (!at) { try { at = String((typeof getStoryNow === 'function' ? (getStoryNow() || {}).date : '') || (state.state && state.state.date) || ''); } catch (e) { at = ''; } }
        p.promotedAt = at || p.promotedAt || '';
        p.updatedAt = Date.now();
        // 自动移除平行记录：走 deleteEntry（与「删除条目」同口径的 id 墓碑，防跨端合并复活）
        let removed = false;
        try {
            const before = (state.parallels || []).length;
            if (typeof deleteEntry === 'function') removed = !!deleteEntry('parallels', p.id);
            else {
                // ⚠ V1 该兜底分支在真实路径上**不可达**（`deleteEntry` 恒为函数）；逐字保留以备移植对照
                state.parallels = (state.parallels || []).filter(x => !(x && String(x.id) === String(p.id)));
                try { tombEntry('parallels', p); } catch (e) { /* 忽略 */ }
                removed = (state.parallels || []).length < before;
            }
        } catch (e) { warn('转正后移除平行记录失败', e); }
        saveState();
        return { ok: true, atomId: p.promotedTo, updated: !!prevAtom, removed: removed, promotedAt: p.promotedAt };
    } catch (e) { return { ok: false, reason: '转正异常' }; }
}
/**
 * v1.196：历史存档清理 —— 旧版「转正」只写 `promotedTo`（软标记、条目仍在库），按新规则应移除；
 * **仅当被转正的情节仍存在**时才移除（情节已被删则保留原平行记录，避免丢唯一信息）。
 * @returns {{removed:number, kept:number}}
 */
export function prunePromotedParallels() {
    const out = { removed: 0, kept: 0 };
    try {
        const list = Array.isArray(state.parallels) ? state.parallels : [];
        const doomed = [];
        for (const p of list) {
            if (!p || !String(p.promotedTo || '').trim()) continue;
            const pid = String(p.promotedTo).trim();
            const atomExists = pid === '情节' ? true : (state.atoms || []).some(x => x && String(x.id) === pid);
            if (atomExists) doomed.push(p); else out.kept++;
        }
        for (const p of doomed) {
            try { if (typeof deleteEntry === 'function') { if (deleteEntry('parallels', p.id)) out.removed++; else out.kept++; } }
            catch (e) { out.kept++; }
        }
        if (out.removed) { try { saveState(); } catch (e) { /* 忽略 */ } }
        return out;
    } catch (e) { return out; }
}

// 全部函数均以 `export function` 就地导出（无集中导出块，避免与 V1 命名对照时遗漏）。
