// ============================================================
// host/inject.js —— 记忆注入通道（setExtensionPrompt）
// 事实源：script.js `setExtensionPrompt(key, value, position, depth, scan = false, role = 0, filter = null)`
// 约定：注入键唯一；关闭/禁用/无内容时必须显式置空，避免残留旧注入。
// ============================================================
import { INJECT_ID, PROMPT_POSITION, PROMPT_ROLE } from '../core/constants.js';
import { getCtx, safeCall } from './st-api.js';
import { cfg as kernelCfg, getStoryNow } from '../core/model/runtime.js';
import { buildMemoryBodyForInject } from '../core/recall.js';
import { clockDateLabel } from '../core/clock.js';
// v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：提取记忆（召回 + 注入构建）也是管线动作
import { beginPipeline, endPipeline, setPipelinePhase } from '../core/pipeline.js';
import { debugLogPush } from '../adapters/debug-log.js';
/** 调试日志（关闭调试时不写；失败静默） */
const dbgLog = (kind, data) => { try { debugLogPush(kind, data); } catch (e) { /* 静默 */ } };

// 内核视图引用（配置 / 剧情时钟 / 召回函数）—— 延迟取用，允许测试替换
const runtimeRef = { cfg: kernelCfg, getStoryNow, buildMemoryBodyForInject, extractFlow: null, recentFloorText: null };
/** 替换内核视图引用（仅测试与调试使用） */
export function setInjectRuntime(ref) { Object.assign(runtimeRef, ref || {}); return runtimeRef; }

export const DEFAULT_INJECT_OPTS = Object.freeze({
    position: PROMPT_POSITION.IN_PROMPT,
    depth: 0,
    scan: false,
    role: PROMPT_ROLE.SYSTEM,
});

/**
 * 写入注入文本。
 * @param {string} text 注入正文（空串 = 清空）
 * @param {object} [opts] position/depth/scan/role
 * @returns {{ ok: boolean, reason?: string, length: number }}
 */
export function setInject(text, opts) {
    const o = Object.assign({}, DEFAULT_INJECT_OPTS, opts || {});
    const value = String(text == null ? '' : text);
    const r = safeCall('setExtensionPrompt', INJECT_ID, value, o.position, o.depth, !!o.scan, o.role);
    return r.ok ? { ok: true, length: value.length } : { ok: false, reason: r.reason, length: 0 };
}

/** 清空注入（禁用扩展 / 关闭插件 / 无内容时都必须调） */
export function clearInject() {
    resetInjectMemory();
    return setInject('', DEFAULT_INJECT_OPTS);
}

/** 读回当前注入值（调试与断言用） */
export function readInject() {
    const ctx = getCtx();
    const p = ctx && ctx.extensionPrompts && ctx.extensionPrompts[INJECT_ID];
    return p ? String(p.value == null ? '' : p.value) : '';
}

// ============================================================
// P3：记忆注入（发送前把长期记忆库写进提示词）
// 逐字复刻 V1 `buildInjectText()` 的包装与 `pushInject()` 的推送口径：
//   ① 包装 = 固定结构头（区块标记说明 + 剧情日期口径 + 可配置「使用说明」）+ 正文 + `记忆结束。`
//   ② 开关 = 及时分析(timelyOn) 或 `cfg.injectCurrentPrompt`；关闭即不推送（不清空已有注入）
//   ③ 并发防护 = 序号令牌，只允许最新一次构建写入
//   ④ 构建为空时**保留上一次非空注入**（V1 v1.149 修复：一次异常不得把已有记忆清掉）
//   ⑤ 位置 = `setExtensionPrompt(INJECT_ID, text, 0, 0, false, role)`（POSITION.IN_PROMPT / depth 0）
//      —— V1 传 `role=null`，本实现用 ST 默认 `role=SYSTEM(0)`（语义等价、行为可预期），见 docs/P3 §3。
// ============================================================

let injectSeq = 0;
let lastInjectText = '';
const injectStats = { builds: 0, pushes: 0, empties: 0, keptLast: 0, stale: 0, joined: 0, lastChars: 0, lastAt: 0, lastMs: 0, lastLayer: '', lastError: '', lastOverhead: 0, lastBodyBudget: 0, overBudget: 0 };
// v2.74.0（用户要求）：「提取记忆…确保可以**并行处理**」——**单飞（single-flight）**：
//   同一时刻只允许一次「构建 + 推送」，并发调用者**共享同一次结果**（await 同一个 Promise），
//   既不互相覆盖注入（既有 seq 令牌仍然生效），也不会因为重复构建而重复调用向量 / AI 接口。
let inFlight = null;

/** 注入统计（/ftt 与调试导出） */
export function pushStats() { return Object.assign({}, injectStats, { seq: injectSeq, lastChars: lastInjectText.length }); }

/** 生效开关：及时分析 或 「注入当前提示词」 */
export function injectGateOpen() {
    try {
        const { cfg } = runtimeRef;
        return !!(cfg && (cfg.timelyAnalysis === true || cfg.injectCurrentPrompt === true));
    } catch (e) { return false; }
}

/**
 * 组装注入包装（结构头 + 正文 + 结束标记）。逐字对齐 V1 `buildInjectText()`。
 * @param {string} body 记忆正文（空串 → 返回 ''）
 * @returns {string}
 */
export function wrapInjectText(body, opts) {
    const b = String(body == null ? '' : body);
    if (!b.trim()) return '';
    const noGuide = !!(opts && opts.noGuide === true);
    let now = '';
    try { now = runtimeRef.getStoryNow ? String(runtimeRef.getStoryNow() || '') : ''; } catch (e) { now = ''; }
    let dateLabel = now;
    try { if (now) dateLabel = clockDateLabel(now); } catch (e) { /* 保持原样 */ }
    const timeNote = now
        ? `当前剧情日期：${dateLabel}（「今天」即此日）。条目标注的「（今天）（昨天）（前天）（N天前）（N个月前）（N年前）」均相对该日期，越近越贴近当前。`
        : '记忆条目中若含相对时间标注（今天/昨天/前天/N天前/N个月前/N年前），请据此判断事件远近。';
    let guide = '';
    try {
        const pt = (runtimeRef.cfg && runtimeRef.cfg.promptTemplates) || {};
        guide = noGuide ? '' : String(pt.injectGuide || '').trim();
    } catch (e) { guide = ''; }
    // v2.88.0（用户要求：「提取记忆的注入内容，应改为 markdown 结构」）——
    //   注入体外框同样 Markdown 化；`记忆结束。` 作为结束哨兵**保留**（V1 文案，冒烟断言依赖）。
    const lead = [
        '# FTT 记忆注入',
        '> 以下为该角色的长期记忆库，**按各条归属者的知情范围使用**（各区块定义见下方说明）。',
        '> 区块标题（`## 当前状态` / `## 情节记忆` / `## 状态记录` / `## 角色档案` / `## 长期记忆` / `## 物品` / `## 货币` / `## 传言` / `## 计划` / `## 悬念` / `## 平行事件` / `## 场景地点` / `## 概念` / `## 注入约束`）只用于区分资料类型，不属于剧情内容。',
        timeNote,
        guide,
    ].filter(Boolean).join('\n');
    return `${lead}\n\n${b}\n\n记忆结束。`;
}

/**
 * 注入框架的固定开销（结构头 + 「使用说明」模板 + 结束哨兵）的字符数。
 * v3.10.3（真机取证 A2）：`charBudget` 此前**只约束召回条目体**，框架不计入 ——
 *   默认「使用说明」模板本身就有 3726 字，加上结构头与日期行 ≈ 4300 字，
 *   于是「设 8000 却实际注入 11955」（超 49%，真机实测）。本函数让预算能把它算进去。
 * @param {{noGuide?:boolean}} [opts] `noGuide` = 只算「不可省」的部分（结构头 + 哨兵）
 * @returns {number}
 */
export function injectFrameOverhead(opts) {
    try { return Math.max(0, String(wrapInjectText('\u0000', opts)).length - 1); } catch (e) { return 0; }
}

/**
 * 预算分配（纯函数，便于单测）：把 `charBudget`（**最终注入体**的硬上限）分成「框架」与「正文」。
 *
 * 规则（保守、可解释）：
 *   ① 框架**不可省**部分（结构头 + 哨兵）先扣除；
 *   ② 「使用说明」模板可省：若扣除它之后正文仍放得下 `minBody`，则**保留**说明；
 *      否则**丢弃说明**把预算让给记忆正文（记忆是载荷、说明是注解），并如实标记 `guideDropped`；
 *   ③ 连「不可省框架」都放不下 → `ok:false`（不注入），由调用方如实回报原因 —— **绝不静默超预算**。
 * @param {number} cap 最终注入体上限（`cfg.charBudget`）
 * @param {number} frameFixed 不可省框架字符数
 * @param {number} guideLen 「使用说明」模板字符数
 * @param {number} [minBody] 正文最小可用预算（默认 400）
 * @returns {{ok:boolean, bodyBudget:number, useGuide:boolean, guideDropped:boolean, frame:number, reason:string}}
 */
export function planInjectBudget(cap, frameFixed, guideLen, minBody) {
    const c = Math.max(0, Number(cap) || 0);
    const ff = Math.max(0, Number(frameFixed) || 0);
    const gl = Math.max(0, Number(guideLen) || 0);
    const min = Math.max(0, Number(minBody == null ? 400 : minBody) || 0);
    const withGuide = c - ff - gl;
    if (withGuide >= min) return { ok: true, bodyBudget: withGuide, useGuide: true, guideDropped: false, frame: ff + gl, reason: '' };
    const withoutGuide = c - ff;
    if (withoutGuide >= min) return { ok: true, bodyBudget: withoutGuide, useGuide: false, guideDropped: true, frame: ff, reason: 'guide-dropped' };
    return { ok: false, bodyBudget: 0, useGuide: false, guideDropped: gl > 0, frame: ff, reason: 'budget-too-small' };
}

/**
 * 构建并推送记忆注入（P3 主入口）。
 *
 * v2.58.0（对齐 V1 的三层提取）：开启「启用向量检索」后，发送前先走**第一层向量检索**
 *   （关键词 → embedding → 余弦 TopN →（可）Rerank 精排）——命中即用向量召回的行作为注入体；
 *   未命中/未配置/请求失败则**自动降级**到既有本地召回（第二层 JS 抽取）。
 *   此处不直接依赖 host 模块，流程由 `runtimeRef.extractFlow`（`index.js` 注入 `host/extract-flow.js`）
 *   提供 —— 保持本模块在测试中可独立替换。
 * @param {object} [opts] queryText 查询意图 / floorText 最近楼层正文（向量层的关键词来源）
 * @returns {Promise<{ok:boolean, reason?:string, chars:number, injected:boolean, hitLayer?:string}>}
 */
export async function pushMemoryInject(opts) {
    const o = opts || {};
    // 并发调用：直接共享在途的那一次（并行安全，且不重复消耗向量/AI 请求）
    if (inFlight) { injectStats.joined += 1; return await inFlight; }
    inFlight = (async () => {
        try { return await buildAndPushInject(o); }
        finally { inFlight = null; }
    })();
    return await inFlight;
}

/** 是否有一次「构建 + 推送」在途（诊断 / 测试） */
export function injectInFlight() { return !!inFlight; }

/** 实际的构建与推送（由 `pushMemoryInject` 单飞包装调用） */
async function buildAndPushInject(o) {
    const t0 = Date.now();
    // v3.0.0（用户要求「有请求、同步等各类动作时自动出现」）：提取记忆（召回 + 注入构建）进管线状态。
    //   内部若走向量检索，会**再出现一条「向量检索（embedding）」行** —— 嵌套/并行都看得见。
    //   登记**直接嵌在本函数内**（不新增 async 层）→ `pushMemoryInject` 的完成时序与观察窗保持逐字不变。
    let pipeRun = {};
    try { pipeRun = beginPipeline('提取记忆（召回 + 注入）', { kind: 'task', phase: '召回候选' }) || {}; } catch (e) { pipeRun = {}; }
    try {
        injectStats.builds += 1;
        if (!injectGateOpen()) return { ok: true, reason: 'gate-closed', chars: 0, injected: false };
        const mySeq = ++injectSeq;
        const cfg = runtimeRef.cfg || {};
        // v3.10.3（A2）：`charBudget` 是**最终注入体**的硬上限 —— 先扣框架（结构头 + 哨兵），
        //   再决定是否保留「使用说明」模板，剩下的才是正文预算。此前框架完全不计入，
        //   真机实测「设 8000 → 注入 11955」（默认说明模板就有 3726 字）。
        const budget = (() => {
            try {
                const frameFixed = injectFrameOverhead({ noGuide: true });
                const guideLen = Math.max(0, injectFrameOverhead({}) - frameFixed);
                return planInjectBudget(cfg.charBudget == null ? 8000 : cfg.charBudget, frameFixed, guideLen);
            } catch (e) { return { ok: true, bodyBudget: Number(cfg.charBudget) || 8000, useGuide: true, guideDropped: false, frame: 0, reason: '' }; }
        })();
        injectStats.lastOverhead = budget.frame;
        injectStats.lastBodyBudget = budget.bodyBudget;
        if (budget.guideDropped) {
            try { dbgLog('发送记忆', { action: '预算不足 → 本次注入丢弃「使用说明」模板，把预算让给记忆正文', cap: Number(cfg.charBudget) || 0, frame: budget.frame, bodyBudget: budget.bodyBudget }); } catch (e) { /* 静默 */ }
        }
        if (!budget.ok) {
            injectStats.overBudget += 1;
            return { ok: true, reason: 'budget-too-small', chars: 0, count: 0, injected: false, overhead: budget.frame, bodyBudget: 0 };
        }
        let body = '';
        let hitLayer = '';
        // ① 三层流程（仅在启用向量层或 AI 层时进入；否则保持既有同步本地召回路径不变）
        if (typeof runtimeRef.extractFlow === 'function' && (cfg.useVector === true || cfg.useKeywordFlow === true)) {
            try {
                const ft = String(o.floorText || (typeof runtimeRef.recentFloorText === 'function' ? (runtimeRef.recentFloorText() || '') : '') || o.queryText || '');
                const flow = await runtimeRef.extractFlow(ft, {
                    queryText: String(o.queryText || ''),
                    charBudget: budget.bodyBudget,
                });
                if (flow && flow.ok && flow.lines.length) { body = flow.lines.join('\n'); hitLayer = flow.hitLayer || ''; }
            } catch (e) { /* 向量/AI 层失败 → 降级到本地召回 */ }
        }
        // ② 本地召回（第二层 JS 抽取 / 兜底）
        if (!body && runtimeRef.buildMemoryBodyForInject) {
            body = runtimeRef.buildMemoryBodyForInject(String(o.queryText || ''), {
                charBudget: budget.bodyBudget, maxAtoms: cfg.maxAtoms, maxMemories: cfg.maxMemories,
                countUses: true, inject: true,
            });
        }
        const text = wrapInjectText(body, { noGuide: budget.useGuide === false });
        if (mySeq !== injectSeq) { injectStats.stale += 1; return { ok: true, reason: 'stale', chars: 0, injected: false }; }
        const ms = Date.now() - t0;
        const count = String(body || '').split('\n').filter((x) => String(x).trim()).length;
        if (!text && lastInjectText) {
            injectStats.keptLast += 1;
            injectStats.lastMs = ms;
            return { ok: true, reason: 'kept-last', chars: lastInjectText.length, count: 0, injected: false, hitLayer: hitLayer, ms: ms };
        }
        if (!text) injectStats.empties += 1;
        const r = setInject(text, { position: PROMPT_POSITION.IN_PROMPT, depth: 0, scan: false, role: PROMPT_ROLE.SYSTEM });
        if (text) lastInjectText = text;
        injectStats.pushes += 1;
        injectStats.lastChars = text.length;
        injectStats.lastAt = Date.now();
        injectStats.lastMs = ms;
        injectStats.lastLayer = String(hitLayer || (body ? 'js' : ''));
        injectStats.lastHitLayer = hitLayer;
        return { ok: !!r.ok, reason: r.reason, chars: text.length, count: count, injected: true, hitLayer: hitLayer, ms: ms, overhead: budget.frame, bodyBudget: budget.bodyBudget, guideDropped: budget.guideDropped === true };
    } catch (e) {
        injectStats.lastError = String((e && e.message) || e);
        return { ok: false, reason: 'error', chars: 0, count: 0, injected: false, ms: Date.now() - t0 };
    } finally {
        try { endPipeline(true, pipeRun.runId); } catch (e2) { /* 忽略 */ }
    }
}

/** 重置注入态（clearInject 时同步清掉「上一次非空注入」记忆，V1 同款） */
export function resetInjectMemory() { lastInjectText = ''; return true; }

/** 注入通道是否可用 */
export function injectAvailable() {
    const ctx = getCtx();
    return !!(ctx && typeof ctx.setExtensionPrompt === 'function');
}
