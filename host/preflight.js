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
import { clockAutoExtractOnce, clockExtractState } from '../core/clock-extract.js';
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

/** 只读诊断（设置页/总览/测试） */
export function preflightInfo() {
    const clock = clockSnapshot();
    return {
        autoClockOn: !(cfg && cfg.clockExtractEnabled === false),
        clock: clock,
        source: (() => { try { const t = clockExtractState(); return t || null; } catch (e) { return null; } })(),
    };
}
