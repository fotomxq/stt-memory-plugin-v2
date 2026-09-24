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

// 内核视图引用（配置 / 剧情时钟 / 召回函数）—— 延迟取用，允许测试替换
const runtimeRef = { cfg: kernelCfg, getStoryNow, buildMemoryBodyForInject };
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
const injectStats = { builds: 0, pushes: 0, empties: 0, keptLast: 0, stale: 0, lastChars: 0, lastAt: 0, lastError: '' };

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
export function wrapInjectText(body) {
    const b = String(body == null ? '' : body);
    if (!b.trim()) return '';
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
        guide = String(pt.injectGuide || '').trim();
    } catch (e) { guide = ''; }
    const lead = [
        '【FTT记忆注入】以下为该角色的长期记忆库，**按各条归属者的知情范围使用**（区块定义见下方说明）。',
        '区块标记（[当前状态] / [情节记忆] / [状态记录] / [角色档案] / [长期记忆] / [物品] / [货币] / [传言] / [计划] / [悬念] / [平行事件] / [场景地点] / [概念]）只用于区分资料类型，不属于剧情内容。',
        timeNote,
        guide,
    ].filter(Boolean).join('\n');
    return `${lead}\n\n${b}\n\n记忆结束。`;
}

/**
 * 构建并推送记忆注入（P3 主入口；同步、纯本地召回，不发起 AI 调用）。
 * @param {object} [opts] queryText 查询意图（默认空：与 V1 注入路径一致，交由本地召回按预算选条）
 * @returns {Promise<{ok:boolean, reason?:string, chars:number, injected:boolean}>}
 */
export async function pushMemoryInject(opts) {
    const o = opts || {};
    try {
        injectStats.builds += 1;
        if (!injectGateOpen()) return { ok: true, reason: 'gate-closed', chars: 0, injected: false };
        const mySeq = ++injectSeq;
        const cfg = runtimeRef.cfg || {};
        const body = runtimeRef.buildMemoryBodyForInject
            ? runtimeRef.buildMemoryBodyForInject(String(o.queryText || ''), {
                charBudget: cfg.charBudget, maxAtoms: cfg.maxAtoms, maxMemories: cfg.maxMemories,
                countUses: true, inject: true,
            })
            : '';
        const text = wrapInjectText(body);
        if (mySeq !== injectSeq) { injectStats.stale += 1; return { ok: true, reason: 'stale', chars: 0, injected: false }; }
        if (!text && lastInjectText) {
            injectStats.keptLast += 1;
            return { ok: true, reason: 'kept-last', chars: lastInjectText.length, injected: false };
        }
        if (!text) injectStats.empties += 1;
        const r = setInject(text, { position: PROMPT_POSITION.IN_PROMPT, depth: 0, scan: false, role: PROMPT_ROLE.SYSTEM });
        if (text) lastInjectText = text;
        injectStats.pushes += 1;
        injectStats.lastChars = text.length;
        injectStats.lastAt = Date.now();
        return { ok: !!r.ok, reason: r.reason, chars: text.length, injected: true };
    } catch (e) {
        injectStats.lastError = String((e && e.message) || e);
        return { ok: false, reason: 'error', chars: 0, injected: false };
    }
}

/** 重置注入态（clearInject 时同步清掉「上一次非空注入」记忆，V1 同款） */
export function resetInjectMemory() { lastInjectText = ''; return true; }

/** 注入通道是否可用 */
export function injectAvailable() {
    const ctx = getCtx();
    return !!(ctx && typeof ctx.setExtensionPrompt === 'function');
}
