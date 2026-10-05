// ============================================================
// host/preflight.js —— **提取前校对「基本信息」**（v2.61.0，用户要求）
//
// 用户要求：「提取记忆优化，**第一步先校对时钟等基本信息**，然后再去提取。」
//
// 为什么需要：记忆提取的产物（情节/记忆/状态…）都会带日期，插件在合并时会用「当前剧情时钟」补日期，
//   AI 也需要知道「今天」才能把正文里的「昨天/三天后」折算成绝对日期。此前提取流程**直接用旧时钟**
//   （时钟由楼层事件另行防抖同步），于是：
//     · 刚推进的剧情还没同步时钟就提取 → 新条目拿到旧日期、相对时间折算错位；
//     · 提示词里没有「当前剧情日期 / 时间 / 地点 / 在场角色」，AI 只能自己猜。
// 本模块在提取**之前**跑一次校对（仍严格遵守「时钟唯一可信来源 = 最新一条非总结情节」的既定口径）：
//   ① 调用内核 `clockAutoExtractOnce()` —— 从最新情节解析并落盘 `state.state.{date,time,location,present}`
//      （尊重「消息后自动同步时钟」开关；关闭时如实跳过，不擅自覆盖）；
//   ② 汇总成一段【基本信息】文本，供提取提示词前置（AI 据此折算相对时间、沿用日期、保持连贯）；
//   ③ 返回「是否变化 / 校对前后值 / 跳过原因」，供总览「最后一次提取」与调试日志展示。
// 约定：不抛异常；任何一步失败都返回结构化结果，不影响提取主流程。
// ============================================================
import { cfg, state } from '../core/model/runtime.js';
import { noteChatKey } from './chat.js';
import { clockAutoExtractOnce, clockExtractState } from '../core/clock-extract.js';
import { clockManualState } from '../core/clock-patrol.js';
import { atomContentHash } from '../core/model/hash.js';
// v2.86.0（`docs/D7` §4.5）：每次提取落库后重算重要度（窗口调用占比）
import { recalcImportanceAfterExtract } from '../core/importance.js';
import { hashText } from '../core/util.js';
import { debugLogPush } from '../adapters/debug-log.js';

const str = (v) => String(v == null ? '' : v).trim();

/** 读当前时钟快照（校对前/后对比用） */
function clockSnapshot() {
    const s = (state && state.state) || {};
    return {
        date: str(s.date), time: str(s.time), location: str(s.location),
        present: Array.isArray(s.present) ? s.present.slice() : null,
    };
}

/**
 * 提取前校对基本信息（时钟 / 时间 / 地点 / 在场角色）。
 * @param {{text?:string}} [opts] `text` 显式正文（本轮投喂文本；不传则由内核取最新 AI 正文）
 * @returns {{ok:boolean, changed:boolean, skipped:string, before:object, clock:object, source:string, text:string, note:string}}
 */
export function calibrateBasics(opts) {
    const o = opts || {};
    const before = clockSnapshot();
    let changed = false;
    let skipped = '';
    // v3.20.0：**每次分析前先同步「当前聊天标识」** —— 新落库的情节据此打 `chatKey`（聊天归属），
    //   时钟据此刻意只采信本聊天的情节（否则别条聊天/旧聊天的情节会压住本聊天的最新情节 →
    //   「最新情节已经变化，但还是识别为错误的时间」，真机取证见 core/chat-scope.js）。
    //   放在这里的原因：所有分析路径（单楼 / 批量 / 自动）都会先经过 `calibrateBasics()`，单点覆盖、且在合并之前。
    try { noteChatKey(); } catch (e) { /* 忽略：标识读不到就只是不打标 */ }
    try {
        if (!cfg || cfg.enabled === false) skipped = 'disabled';
        else if (cfg.clockExtractEnabled === false) skipped = 'auto-off';
        else changed = clockAutoExtractOnce(o.text != null ? { text: String(o.text) } : {}) === true;
    } catch (e) { skipped = 'error'; }
    const clock = clockSnapshot();
    // 基本信息文本（只有存在的字段才出现 —— 不写「未知」占位，避免提示词噪声）
    const lines = [];
    if (clock.date) lines.push('【当前剧情日期】' + clock.date + '（「今天」即此日；正文里的相对时间按此折算）');
    if (clock.time) lines.push('【当前时间】' + clock.time);
    if (clock.location) lines.push('【当前地点】' + clock.location);
    if (clock.present && clock.present.length) lines.push('【在场角色】' + clock.present.slice(0, 12).join('、'));
    const text = lines.length ? ('【基本信息 · 提取前已校对】\n' + lines.join('\n')) : '';
    const src = (() => { try { const t = clockExtractState(); return str(t && t.source && t.source.date); } catch (e) { return ''; } })();
    const note = (() => {
        if (skipped === 'disabled') return '校对已跳过（组件未启用）';
        if (skipped === 'auto-off') return '校对已跳过（「消息后自动同步时钟」已关闭）';
        if (skipped === 'error') return '校对失败（沿用当前时钟）';
        const brief = [clock.date, clock.time, clock.location].filter(Boolean).join(' ');
        if (!brief) return '无可校对信息（还没有带日期的情节）';
        return changed ? ('已校对：' + brief) : ('时钟无变化：' + brief);
    })();
    // 用独立类别 '校对' 记日志：'时钟' 类别是「时钟取值解析」的专用流（冒烟 AN1 断言其最后一条为解析结果），
    //   提取前校对另立一类，避免把解析流顶掉（用户仍可在调试页按类别筛选）。
    try { debugLogPush('校对', { action: '提取前校对', changed: changed, skipped: skipped, date: clock.date, time: clock.time, location: clock.location, source: src }); } catch (e) { /* 忽略 */ }
    return {
        ok: !!text, changed: changed, skipped: skipped, before: before, clock: clock,
        source: src, text: text, note: note,
    };
}

/** 把校对结果前置到提示词的用户消息上（`buildSummaryPrompt` 本身保持 V1 逐字，不动内核） */
export function withBasics(messages, calib) {
    try {
        const list = Array.isArray(messages) ? messages.slice() : [];
        const pre = calib && calib.text ? String(calib.text) : '';
        if (!pre || !list.length) return list;
        const idx = list.map((m) => str(m && m.role)).lastIndexOf('user');
        const at = idx >= 0 ? idx : (list.length - 1);
        list[at] = Object.assign({}, list[at], { content: pre + '\n\n' + String((list[at] && list[at].content) || '') });
        return list;
    } catch (e) { return Array.isArray(messages) ? messages.slice() : []; }
}

/**
 * 情节容器签名（v2.81.0）—— 判定「本轮分析是否改动了情节」。
 * 口径：`条目数 + hash(排序后的 "id|内容哈希")`。**新增 / 更新 / 删除**都会改变签名；
 *   只读、O(n)（n 受 `cfg.maxAtoms` 约束），不落盘、不入哈希。
 * @returns {string} 签名（异常时返回空串 → 调用方按「无基线」跳过）
 */
export function atomsSignature() {
    try {
        const list = Array.isArray(state.atoms) ? state.atoms : [];
        const parts = [];
        for (const a of list) {
            if (!a || typeof a !== 'object') continue;
            parts.push(String(a.id || '') + '|' + atomContentHash('atoms', a));
        }
        if (!parts.length) return '';                 // 无情节 → 无签名（调用方按「无基线」跳过，不空跑解析）
        parts.sort();
        return parts.length + '|' + hashText(parts.join('\u0001'));
    } catch (e) { return ''; }
}

/**
 * **分析记忆之后**的同步（v2.81.0，用户要求）：
 *   「日期、时间、地点、在场角色，在每次分析记忆后，如果情节发生更新，则按最新的一条更新相关记录。」
 *
 * 触发：调用方在 `mergeDelta` **之前**取 `atomsSignature()`，落库成功后把它传进来；
 *   签名未变（情节没动）→ **完全不碰时钟**（不解析、不落盘、不写日志）。
 * 来源：复用内核 `clockAutoExtractOnce()` —— 与「提取前校对」同一口径（**唯一可信来源 = 最新一条带日期的非总结情节**）。
 * 与提取前校对的**唯一差别（有意为之）**：**不传 `text`**。用户要求「按最新的一条更新相关记录」，
 *   故在场角色取自**最新情节的涉及角色**（来源标记 `plot-atom`），而不是再回读原始楼层正文（`latest-ai`）。
 * 开关：内核自会尊重 `cfg.clockExtractEnabled`（关闭即不改动）；手工锁定时钟（`clockManualLock` 默认开）
 *   仍优先，日期/时间/地点不被覆盖，在场角色照旧同步 —— 均为既有口径，本函数不额外加规则。
 * @param {string} sigBefore 分析前的情节签名（`atomsSignature()`）
 * @returns {{ok:boolean, changed:boolean, skipped:string, note:string, before:object|null, clock:object|null}}
 */
export function recalibrateAfterExtract(sigBefore) {
    const out = { ok: false, changed: false, skipped: '', note: '', before: null, clock: null, imp: null };
    try {
        if (!cfg || cfg.enabled === false) { out.skipped = 'disabled'; out.note = '组件未启用'; return out; }
        // v2.86.0（`docs/D7` §4.5）：**每次提取记忆落库后**重算重要度（窗口调用占比）。
        //   与时钟开关无关（重要度与时钟是两件事），故放在这里、先于任何时钟分支；逐维独立、幂等。
        try { out.imp = recalcImportanceAfterExtract(); } catch (e) { out.imp = null; }
        if (cfg.clockExtractEnabled === false) { out.skipped = 'auto-off'; out.note = '「消息后自动同步时钟」已关闭 → 分析后不同步'; return out; }
        if (typeof sigBefore !== 'string' || !sigBefore) { out.skipped = 'no-baseline'; out.note = '无情节基线 → 跳过'; return out; }
        const sigNow = atomsSignature();
        // 当前签名为空（无情节 / atoms 容器异常）同样按「无变化」处理：不解析、不落盘
        if (!sigNow || sigNow === sigBefore) { out.skipped = 'atoms-unchanged'; return out; }
        out.before = clockSnapshot();
        out.changed = clockAutoExtractOnce() === true;      // 不传 text：在场角色按「最新情节」判定
        out.clock = clockSnapshot();
        out.ok = true;
        const brief = [out.clock.date, out.clock.time, out.clock.location].filter(Boolean).join(' ');
        // 手工锁定判定与内核同源：`clockManualState()` 返回 `{..., lock}`（`cfg.clockManualLock` 默认锁定）
        const locked = (() => { try { const m = clockManualState(); return !!(m && m.lock); } catch (e) { return false; } })();
        if (locked) {
            // 手工锁定时钟（默认）：日期/时间/地点**不写入** state.state（既有口径），但「在场角色」照旧按最新情节同步
            out.note = '情节已更新；手工锁定时钟 → 日期/时间/地点保持不变（在场角色已按最新情节同步）';
        } else if (out.changed) {
            out.note = '情节已更新 → 已按最新情节同步' + (brief ? '：' + brief : '');
        } else {
            out.note = '情节已更新，但日期/时间/地点与在场角色均无变化' + (brief ? '（' + brief + '）' : '');
        }
        // 仅在真的执行了同步时写日志（情节没动 / 关掉开关都不刷日志，避免噪声）
        try {
            debugLogPush('校对', {
                action: '分析后同步', changed: out.changed,
                date: out.clock.date, time: out.clock.time, location: out.clock.location,
                present: out.clock.present,
            });
        } catch (e) { /* 忽略 */ }
    } catch (e) { out.skipped = 'error'; out.note = '同步失败（已忽略）'; }
    return out;
}

/** 只读诊断（设置页/总览/测试） */
export function preflightInfo() {
    const clock = clockSnapshot();
    return {
        autoClockOn: !(cfg && cfg.clockExtractEnabled === false),
        clock: clock,
        source: (() => { try { const t = clockExtractState(); return t || null; } catch (e) { return null; } })(),
    };
}
