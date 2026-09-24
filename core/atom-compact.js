// ============================================================
// core/atom-compact.js —— **情节总结**（B8-7-a，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.206 术语对齐后共两条入口，产物形态完全一致：一条带 `mergedSummary` 标记的**真情节原子**）：
//   ① **半自动「情节总结」（早期情节聚合）** —— 全部原子正文合计 ≥ `atomCompactChars`（默认 3 万）时，
//      摘要/提取完成后的检查点自动调度（`scheduleAtomCompact`），或用户在「设定 → 提示词」页点
//      「🧷 立即聚合早期情节」手动触发（`runAtomCompact({force:true})`）。
//      口径：情节按剧情日期从旧到新分「早期」段；保护最近 `atomCompactRecent`（默认 20）条不参与；
//      目标 = `max(保护窗口, 当前×atomCompactTarget, 存储保底)`；粒度降级 日→月→年（同粒度「同 key 且 ≥2 条」归组，
//      可融合占比 < `atomCompactRatio`（默认 0.6）则降级）；单轮组数 ≤ `atomCompactBatch`（默认 40），
//      每组提示词一次（`COMPACT_GROUPS_PER_CALL` = 25 组/次调用）；AI 回 `{"groups":[{key,标题,内容,标签,重要度}]}`。
//   ② **手动「情节总结」（多选合并）** —— 情节页多选模式勾选若干条 →「🧷 情节总结」（`runAtomMergeSummary`）：
//      合并成**一条** `【A~B 总结】` 情节原子（正常参与注入与运作），原情节**保留但隐藏**。
//   v1.206 共同语义：被总结的原情节**不删除、不记删除墓碑**，只打 `hidden` + `summarizedBy` 标记
//   （跨端不复活、持久保存，唯一消失途径 = 人工删除）；隐藏条目不参与注入 / 召回 / 淘汰裁剪 / 再次聚合 /
//   修复质检等任何自动动作（V2 侧由 `core/merge.js#activeAtoms/atomIsHidden` 统一承担）。
//
// 复用（不重复实现）：
//   · 「参与运作的情节清单」/ 隐藏判定 → `core/merge.js#activeAtoms / atomIsHidden / atomHiddenCount`；
//   · 存储保底 → `core/ingest.js#storeMinFor`；字段裁剪 → `core/model/scalars.js#dimCap`；
//   · AI 调用 → `core/ai-hooks.js#aiCallText`；互斥 → `aiBusy()`；提示（toast）→ `notifyHooks.toast`。
//
// 适配（与 V1 的差异，逐条见 docs/P8w-B8-7情节总结与分段总结.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/warn/notifyHooks/timerHooks）；
//   ② `pipelineOccupied()` → 宿主互斥钩子 `core/ai-hooks.js#aiBusy()`（V2 无 `busy.summary/compact/repair` 全局忙位）；
//   ③ V1 的 `newTaskStart/abortTick/abortQuiet/pipeStart/pipeUpdate/pipeEnd/renderPanel` 未移植
//      （V2 无任务管线 UI 与中断标志，重绘由 UI 层负责）；
//   ④ 定时调度改用注入的 `timerHooks.set(fn, ms)`（V1 直接 `setTimeout`）—— 未接线时内核默认 no-op；
//   ⑤ 两条入口都增设可选 `opts.aiText` 注入点（与 `runRepair` / `runItemRepair` 同约定，供黄金样本与离线测试）。
//
// ⚠️ 与 V1 一致的**既有缺陷/怪癖**（如实保留、不擅自修正，黄金样本已固化）：
//   · `applyCompactGroup` 的总结 id 由「标题 + 正文前 40 字 + 组 key」哈希得出：AI 两次给不同措辞 → 生成第二条总结
//     （非同组幂等，只有完全相同的结果才判重）；
//   · `runAtomCompact` 的 `plan.target` 取 `max(recentN, ceil(before×ratio), floor)`，**用「参与运作条数」**判断终止；
//     当保底/目标 > 实际条数时先被 `nothing-early` 早退，`force` 也绕不过「保底」分支（保底优先于 force）；
//   · `atomMergeSummary` 的 `reason:'exists'` 分支在**真实使用路径上不可达**（首次合并后来源已被隐藏，
//     再次调用时 `usable.length` 为 0 → 走 `reason:'empty'`）；本批逐字保留该分支。
//   · `runAtomCompact` 的 `catch` 在 V1 里先判「用户中断」（`abortQuiet`）再告警；V2 无中断标志 → 一律按异常告警。
// 一致性由 tests/unit/atom-compact-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, dbgLog, warn, notifyHooks, timerHooks } from './model/runtime.js';
import { activeAtoms, atomIsHidden, atomHiddenCount } from './merge.js';
import { storeMinFor } from './ingest.js';
import { dimCap } from './model/scalars.js';
import { hashText, normText, normalizeList, clamp, extractJsonObject } from './util.js';
import { clockDateParts, clockDateTrim, clockYearStr, clockDateStr, dateStrCmp } from './clock.js';
import { atomDateValid } from './recall.js';
import { aiCallText, aiBusy } from './ai-hooks.js';

/** 用户提示（V1 `toast(msg, type)` 的 V2 等价：文本原样、类型透传） */
function toast(text, kind) {
    try { notifyHooks.toast(String(text == null ? '' : text), String(kind || 'info')); } catch (e) { /* 忽略 */ }
}
/** 用户提示（V1 `notify(kind, {title, text})` 的 V2 等价；与 core/repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

// V1 `COMPACT_GRAINS` / `COMPACT_GROUPS_PER_CALL`
const COMPACT_GRAINS = ['day', 'month', 'year'];
const COMPACT_GROUPS_PER_CALL = 25;

/** 体量计量（V1 `atomBodyChars`）：全部原子正文合计字符 —— 只累加各维度的「正文主体字段」，
 *  结构深度字段（如 `pathArr` / `steps` / `history` / `clues`）不逐层累加（粗估即可）。 */
function atomBodyChars() {
    let n = 0;
    const add = (v) => { try { const t = String(v || ''); if (t) n += t.length; } catch (e) { } };
    for (const a of (state.atoms || [])) { add(a.title); add(a.text); }
    for (const s of (state.currentStates || [])) { add(s.subject); add(s.field); add(s.value); }
    for (const m of (state.memories || [])) { add(m.title); add(m.content); }
    for (const i of (state.items || [])) { add(i.name); add(i.desc); }
    for (const p of (state.plans || [])) add(p.content);
    for (const s of (state.suspense || [])) add(s.content);
    for (const sc of (state.scenes || [])) { add(sc.name); add(sc.desc || sc.description); }
    for (const c of (state.concepts || [])) { add(c.name); add(c.content); }
    for (const p of (state.parallels || [])) { add(p.title); add(p.text); }
    for (const sn of (state.snapshots || [])) add(sn.name);
    return n;
}

/** 剧情日期 → 粒度键（day=`YYYY-MM-DD` / month=`YYYY-MM` / year=`YYYY`；不可解析返回 `''`）。
 *  v1.193：走 `clockDateParts`（负年份/公元前安全）。 */
function atomDateGrainKey(dateStr, grain) {
    const p = clockDateParts(clockDateTrim(dateStr));
    if (!p) return '';
    const ys = clockYearStr(p.y);
    if (grain === 'year') return ys;
    if (grain === 'month') return `${ys}-${String(p.m).padStart(2, '0')}`;
    return `${ys}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 组粒度起点日期（日=当日 / 月=当月 1 日 / 年=当年 1 月 1 日）。
 *  ⚠️ V1 原样：`key` 以 `-` 切分后 `Number('')` = 0 → 负年份（`-0221-01-02`）**返回空串**（保留该怪癖）。 */
function grainStartDateStr(key) {
    const p = String(key || '').split('-').map(Number);
    if (!p.length || !p[0]) return '';
    if (p.length === 1) return clockDateStr(p[0], 1, 1);
    if (p.length === 2) return clockDateStr(p[0], p[1], 1);
    return clockDateStr(p[0], p[1], p[2]);
}

/** 情节总结计划（纯计算，V1 `atomCompactPlan`）：体量 / 保护窗口 / 目标 / 早期池。
 *  v1.203：已总结隐藏的情节不参与再聚合（`activeAtoms()` 取数）。 */
function atomCompactPlan() {
    const c = cfg || {};
    const all = activeAtoms().slice();
    const recentN = Math.max(0, Number(c.atomCompactRecent) != null ? Math.floor(Number(c.atomCompactRecent)) : 20);
    const sorted = all.slice().sort((a, b) => ((Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0)) || (String(b.date || '') < String(a.date || '') ? -1 : String(b.date || '') > String(a.date || '') ? 1 : 0));
    const recent = sorted.slice(0, recentN);
    const recentIds = new Set(recent.map(x => x && x.id));
    const pool = all.filter(x => x && x.id && !recentIds.has(x.id));
    const before = all.length;
    const floor = storeMinFor('atoms');                 // v1.147：情节保底（默认 100）
    const target = Math.max(recentN, Math.ceil(before * (Number(c.atomCompactTarget) != null ? Math.min(1, Math.max(0, Number(c.atomCompactTarget))) : 0.3)), floor);
    return { totalChars: atomBodyChars(), threshold: Number(c.atomCompactChars) != null ? Number(c.atomCompactChars) : 30000, before, recentN, target, floor, pool };
}

/** 某粒度的可融合分组（V1 `atomGroupPlan`）：组 = 同 key 且 ≥2 条；`ratio` = 可归组原子 / 早期池原子。 */
function atomGroupPlan(grain) {
    const { pool } = atomCompactPlan();
    const byKey = {};
    for (const a of pool) { const k = atomDateGrainKey(a.date, grain); if (!k) continue; (byKey[k] = byKey[k] || []).push(a); }
    const groups = Object.keys(byKey).map(k => ({ key: k, items: byKey[k] })).filter(g => g.items.length >= 2);
    const eligible = groups.reduce((s, g) => s + g.items.length, 0);
    return { groups, eligible, poolN: pool.length, ratio: pool.length ? eligible / pool.length : 0 };
}

/** 情节总结提示词（V1 `buildAtomCompactPrompt`，v1.206 术语对齐为「情节总结」）：每组 1 条；
 *  内容必须保留时间先后/因果/过程与关键要素（描述部分补全过程，防因果顺序错乱）。 */
function buildAtomCompactPrompt(chunk) {
    const sys = [
        '你是记忆档案员，对同一时间段内的大量早期情节做「情节总结」—— 把同组多条情节聚合成 1 条精简的情节总结条。规则：',
        '1. 每组只输出 1 条情节原子，key 必须原样返回（一一对应，不多不少）。',
        '2. 内容 = 对组内各条的**顺序化压缩总结**：保留时间先后与因果过程 —— 谁/在何时做了什么、导致什么、结果如何；',
        '   人名/地名/物品/组织/数字等关键要素不可省略；宁可在 180 字内写满，也不可因压缩丢失因果顺序（描述部分补全过程，避免因果顺序错乱）。',
        '3. 标题 = 一句话（≤20 字）概括本组。',
        '4. 标签 = 组内高频标签取前 6。',
        '5. 重要度 = 该组最重要事件的 0-1 小数。',
        '只输出一个合法 JSON 对象：{"groups":[{"key":"1919-11-29","标题":"…","内容":"…","标签":["…"],"重要度":0.8}]}',
    ].join('\n');
    const lines = [];
    for (const g of chunk) {
        lines.push(`[组 ${g.key}]`);
        g.items.forEach(a => lines.push(`- ${a.date ? '[' + a.date + ']' : ''}${a.title ? a.title + '：' : ''}${a.text || ''}${(a.tags || []).length ? '（标签:' + a.tags.slice(0, 4).join('/') + '）' : ''}`));
    }
    return [{ role: 'system', content: sys }, { role: 'user', content: lines.join('\n') }];
}

/** 粒度标签（V1 `compactGrainLabel`，用于总结标题的「【… 总结】」标记）：日 / 月 / 年 */
function compactGrainLabel(grain, key) {
    const k = String(key || '');
    if (grain === 'year') return `${k} 年`;
    if (grain === 'month') {
        const p = k.split('-');
        return (p.length >= 2) ? `${p[0]} 年 ${p[1]} 月` : `${k} 月`;
    }
    return k;
}

/** 应用一组「情节总结」（V1 `applyCompactGroup`，v1.206）：**原文保留但隐藏**（`hidden` + `summarizedBy`，
 *  不删除、不记删除墓碑），新增 1 条带 `mergedSummary`（`by:'auto'`）标记的情节总结原子。
 *  幂等：同一 id 已存在 → 返回 `null`（不重复写入）。
 *  @returns {object|null} 新增的总结原子（失败/已存在为 null） */
function applyCompactGroup(g, out, grain) {
    try {
        const title = normText(out.标题 || out.title || '', 60);
        const text = dimCap('atoms', normText(out.内容 || out.content || '', 300));
        if (!title && !text) return null;
        const tagSet = [];
        for (const a of g.items) for (const t of (a.tags || [])) { const tt = String(t).trim(); if (tt && !tagSet.includes(tt)) tagSet.push(tt); }
        const srcIds = g.items.map(x => String(x.id || '')).filter(Boolean);
        const sumId = 'atom_c_' + hashText(String(title || '') + '|' + String(text || '').slice(0, 40) + '|' + g.key);
        const list = (state.atoms = Array.isArray(state.atoms) ? state.atoms : []);
        if (list.some(x => x && String(x.id) === sumId)) return null;      // 幂等：同组已总结过
        const label = compactGrainLabel(String(grain || 'day'), g.key);
        const now = Date.now();
        const marker = `【${label} 总结】`;
        const sum = {
            id: sumId,
            title: (marker + (title ? ' ' + title : '')).slice(0, 40),
            text, type: '总结', date: grainStartDateStr(g.key),
            tags: (Array.isArray(out.标签) ? normalizeList(out.标签) : tagSet).slice(0, 6),
            keywords: [], entities: [], locations: [],
            importance: clamp(Number(out.重要度) != null ? Number(out.重要度) : 0.6, 0, 1),
            validity: 'active', permanence: 'permanent', uses: 0,
            floorStart: Math.min.apply(null, g.items.map(x => (Number(x.floorStart) >= 0 ? Number(x.floorStart) : 0))),
            floorEnd: Math.max.apply(null, g.items.map(x => (Number(x.floorEnd) >= 0 ? Number(x.floorEnd) : 0))),
            mergedSummary: {
                label, start: grainStartDateStr(g.key), end: '', sourceIds: srcIds, sourceCount: srcIds.length,
                at: now, by: 'auto', grain: String(grain || 'day'),
            },
            createdAt: now, updatedAt: now,
        };
        list.push(sum);
        // **原文保留但隐藏**（不删除、不记墓碑）
        const want = new Set(srcIds);
        for (const a of list) {
            if (!a || !want.has(String(a.id))) continue;
            if (a.mergedSummary) continue;                 // 已是总结条（不会被作为组内原文，防御性跳过）
            a.hidden = true; a.summarizedBy = sumId; a.summarizedAt = now; a.updatedAt = now;
        }
        return sum;
    } catch (e) { warn('应用情节总结组失败', e); return null; }
}

// V1 `compactTimer` / `compactWaitDeadline`（延迟重试窗口）
let compactTimer = null;
let compactWaitDeadline = 0;

/** 摘要/提取完成后的检查点：防抖调度（体量未达标内部自动跳过）。
 *  V1：禁用时直接返回；已有排程则忽略；窗口截止 = now + 120000；4 秒后 `runAtomCompact({})`。
 *  V2 适配：定时器由宿主注入（`timerHooks`），未接线 = 不调度。 */
function scheduleAtomCompact() {
    try {
        if (!cfg || cfg.atomCompactEnabled === false) return;
        if (compactTimer) return;
        compactWaitDeadline = Date.now() + 120000;   // v1.75（B1）：长任务互斥下情节总结自动重试窗口 2 分钟
        compactTimer = timerHooks.set(() => {
            compactTimer = null;
            try { runAtomCompact({}); } catch (e) { warn('情节总结（半自动）失败', e); }
        }, 4000);
    } catch (e) { /* 忽略 */ }
}

/** 情节总结（半自动）主流程（V1 `runAtomCompact`）。
 *  早退语义（顺序与 V1 完全一致）：禁用 → `disabled`；`aiBusy()` → `busy`（非 force 且在 2 分钟窗口内 → 再排 4s 重试）；
 *  参与运作条数 ≤ 保底 → `floor`（force 也绕不过）；非 force 且体量 < 阈值 → `below-threshold`；
 *  早期池 < 2 条或已 ≤ 目标 → `nothing-early`。成功 → `{ok:true, summarized, hidden, before, after, target, grains}`。
 *  @param {object} [opts] force（忽略体量阈值；不参与忙位排队）
 *  @returns {Promise<object>} V1 同形返回结构 */
async function runAtomCompact(opts) {
    const o = opts || {};
    try {
        if (!cfg || cfg.atomCompactEnabled === false) return { ok: true, skipped: 'disabled' };
        if (aiBusy()) {   // v1.148：长任务 **或** 存储同步在途 → 同样延迟重试
            // v1.75（B1）：长任务占用时自动情节总结不丢弃 —— 2 分钟窗口内延迟重试（手动 force 不排队）
            if (!o.force && Date.now() < compactWaitDeadline && !compactTimer) {
                compactTimer = timerHooks.set(() => {
                    compactTimer = null;
                    try { runAtomCompact({}); } catch (e) { warn('情节总结（半自动）失败', e); }
                }, 4000);
            }
            return { ok: true, skipped: 'busy' };
        }
        const plan = atomCompactPlan();
        if (activeAtoms().length <= storeMinFor('atoms')) return { ok: true, skipped: 'floor', before: plan.before, floor: plan.floor };   // v1.147：已达保底 → 不聚合
        if (!o.force && plan.totalChars < plan.threshold) return { ok: true, skipped: 'below-threshold', totalChars: plan.totalChars, threshold: plan.threshold };
        if (plan.pool.length < 2 || activeAtoms().length <= plan.target) return { ok: true, skipped: 'nothing-early', before: plan.before, target: plan.target };
        try {
            const ratioTh = Math.min(1, Math.max(0, Number(cfg.atomCompactRatio) != null ? Number(cfg.atomCompactRatio) : 0.6));
            const maxGroups = Math.max(1, Number(cfg.atomCompactBatch) != null ? Math.floor(Number(cfg.atomCompactBatch)) : 40);
            let hiddenTotal = 0;          // 被总结并隐藏（不删除）的原情节条数
            let summarizedTotal = 0;      // 新增的情节总结条数
            const grainsUsed = [];
            for (const grain of COMPACT_GRAINS) {
                // v1.206：原文保留隐藏 → 条数不减；终止条件改看「参与运作（未隐藏）的情节数」
                if (activeAtoms().length <= plan.target) break;
                const gp = atomGroupPlan(grain);
                if (!gp.groups.length) continue;
                if (gp.ratio < ratioTh) continue;          // 可融合占比不足 → 降级（日期不足降月、月不足降年）
                const chosen = gp.groups.slice().sort((a, b) => (a.items[0].date < b.items[0].date ? -1 : a.items[0].date > b.items[0].date ? 1 : 0)).slice(0, maxGroups);
                if (!chosen.length) continue;
                grainsUsed.push(grain);
                for (let s = 0; s < chosen.length; s += COMPACT_GROUPS_PER_CALL) {
                    const chunk = chosen.slice(s, s + COMPACT_GROUPS_PER_CALL);
                    const resp = await aiCallText(buildAtomCompactPrompt(chunk), '情节总结（半自动）');
                    const obj = extractJsonObject(resp);
                    const list = obj && Array.isArray(obj.groups) ? obj.groups : [];
                    if (!list.length) { warn('情节总结（半自动）：AI 未返回有效 groups', ''); continue; }
                    const byKey = {};
                    for (const it of list) { const k = String((it && (it.key !== undefined ? it.key : '')) || '').trim(); if (k && (it.标题 || it.title)) byKey[k] = it; }
                    for (const g of chunk) {
                        const out = byKey[g.key] || byKey[g.items[0].date];
                        if (!out) continue;
                        if (applyCompactGroup(g, out, grain)) { summarizedTotal += 1; hiddenTotal += g.items.length; }
                    }
                }
                if (summarizedTotal > 0) saveState();
                if (activeAtoms().length <= plan.target) break;
            }
            if (summarizedTotal > 0) {
                const after = activeAtoms().length;
                try { dbgLog('发送记忆', { action: '情节总结（半自动）', before: plan.before, after, target: plan.target, summarized: summarizedTotal, hidden: hiddenTotal, stored: (state.atoms || []).length, grains: grainsUsed, chars: atomBodyChars() }); } catch (e) { }
                toast(`🧷 情节总结（半自动）完成：聚合 ${summarizedTotal} 条总结 · 覆盖 ${hiddenTotal} 条原情节（参与运作 ${plan.before} → ${after}，目标 ≤ ${plan.target} · ${grainsUsed.join('→')} 粒度；原文保留并隐藏，可点 🧩 穿透查看）`, 'success');
                return { ok: true, summarized: summarizedTotal, hidden: hiddenTotal, before: plan.before, after, target: plan.target, grains: grainsUsed };
            }
            return { ok: true, skipped: 'no-merge', before: plan.before, after: activeAtoms().length, target: plan.target };
        } catch (e) {
            // V1 v1.136：用户中断 → 静默收尾（已完成并落盘的情节总结保留）；V2 无中断标志，统一按异常处理
            warn('情节总结（半自动）异常', e);
            return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
        }
    } catch (e) {
        warn('情节总结（半自动）异常', e);
        return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
    }
}

// ==================== 情节批量「合并总结」（多选 → 合并为一条 A~B 总结） ====================
/** 合并区间与标记（V1 `atomMergeRange`）：日期起止 / 楼层起止 / 标题标记（`A ~ B` / `第 A-B 楼` / `N 条情节`）。 */
function atomMergeRange(items) {
    const out = { start: '', end: '', label: '' };
    try {
        const list = (Array.isArray(items) ? items : []).filter(Boolean);
        const dates = list.map(a => (atomDateValid(a.date) ? clockDateTrim(a.date) : '')).filter(Boolean).sort(dateStrCmp);
        if (dates.length) { out.start = dates[0]; out.end = dates[dates.length - 1]; }
        const floors = list.map(a => Number(a.floorStart) || Number(a.floorEnd) || 0).filter(Boolean);
        const floorsEnd = list.map(a => Number(a.floorEnd) || Number(a.floorStart) || 0).filter(Boolean);
        if (floors.length) out.floorStart = Math.min.apply(null, floors);
        if (floorsEnd.length) out.floorEnd = Math.max.apply(null, floorsEnd);
        if (out.start || out.end) out.label = (out.start && out.end && out.start !== out.end) ? `${out.start} ~ ${out.end}` : (out.start || out.end);
        else if (floors.length) out.label = `第 ${out.floorStart}-${out.floorEnd} 楼`;
        else out.label = `${list.length} 条情节`;
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 合并提示词（V1 `buildAtomMergePrompt`，内置；system 固定口径，user = 所选情节清单）。
 *  隐藏条目先被过滤；可用条目 < 2 → `null`。 */
function buildAtomMergePrompt(items) {
    const list = (Array.isArray(items) ? items : []).filter(a => a && !atomIsHidden(a));
    if (list.length < 2) return null;
    const sys = [
        '你是记忆档案员。把同一批情节**合并成一条**紧凑的情节总结。规则：',
        '1. 只输出 1 条情节；按时间先后与因果关系串成连贯叙述（谁 / 何时 / 做了什么 / 导致什么 / 结果如何）。',
        '2. 人名 / 地名 / 物品 / 组织 / 数字等关键要素不可省略；不得编造清单里没有的信息。',
        '3. 合并重复与冗长描写，但**不得丢失任何一条原情节的关键事实**（允许合并同类）。',
        '4. 标题 = 一句话（≤20 字）概括本段剧情；重要度 = 0-1 小数（取整批最高）；标签 = 高频标签取前 6。',
        '只输出一个合法 JSON 对象：{"标题":"…","内容":"…","标签":["…"],"重要度":0.8}',
    ].join('\n');
    const lines = [];
    for (const a of list) {
        const title = String(a.title || '').trim();
        const body = String(a.text || a.content || '').replace(/\s+/g, ' ').slice(0, 300);
        const who = (Array.isArray(a.entities) ? a.entities : []).slice(0, 6).filter(Boolean).join('、');
        const loc = (Array.isArray(a.locations) ? a.locations : []).slice(0, 3).filter(Boolean).join('、');
        const fl = (Number(a.floorStart) || 0) && (Number(a.floorEnd) || 0) ? `第 ${a.floorStart}-${a.floorEnd} 楼` : '';
        lines.push(`${a.date ? `[${a.date}] ` : '[日期未知] '}${title && title !== body ? `${title} ｜ ` : ''}${body}${who ? ` ｜ 角色：${who}` : ''}${loc ? ` ｜ 地点：${loc}` : ''}${fl ? `（${fl}）` : ''}`);
    }
    const range = atomMergeRange(list);
    return [
        { role: 'system', content: sys },
        { role: 'user', content: `【待合并情节（共 ${list.length} 条${range.label ? `；时间跨度 ${range.label}` : ''}）】\n${lines.join('\n')}\n\n【输出】只输出上面约定的 JSON 对象，不要解释、不要代码块标记。` },
    ];
}

/** 解析合并结果（V1 `parseAtomMergeResult`）：JSON 优先（中文键优先）；失败退化为「整段文本即正文」
 *  （含围栏剥离）；正文归一空白后为空 → `null`。 */
function parseAtomMergeResult(resp) {
    const raw = String(resp == null ? '' : resp).trim();
    if (!raw) return null;
    const out = { title: '', text: '', tags: [], importance: null };
    try {
        const obj = extractJsonObject(raw);
        if (obj && typeof obj === 'object') {
            out.title = String(obj['标题'] || obj.title || '').trim();
            out.text = String(obj['内容'] || obj.content || obj['正文'] || obj.text || '').trim();
            const tg = obj['标签'] || obj.tags;
            if (Array.isArray(tg)) out.tags = normalizeList(tg).slice(0, 6);
            const im = obj['重要度'] !== undefined ? obj['重要度'] : obj.importance;
            if (im !== undefined && im !== null && Number.isFinite(Number(im))) out.importance = clamp(Number(im), 0, 1);
        }
    } catch (e) { /* 忽略 */ }
    if (!out.text) {
        // 退化：去掉代码围栏后整段作为正文
        out.text = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    }
    out.text = out.text.replace(/\s+/g, ' ').trim();
    return out.text ? out : null;
}

/** 落库（V1 `atomMergeSummary`）：新增 1 条「A~B 总结」情节（`mergedSummary.by='manual'`，正常参与运作）
 *  + 把所选原情节标记隐藏（保留、持久、不参与任何自动动作）。
 *  返回 V1 同形结构 `{ok, reason, summaryId, merged, hidden, skipped, label}`（`reason` ∈ `''|empty|need2|exists|tooShort|error`）。 */
function atomMergeSummary(ids, ai) {
    const out = { ok: false, reason: '', summaryId: '', merged: 0, hidden: 0, skipped: 0, label: '' };
    try {
        const want = new Set((Array.isArray(ids) ? ids : []).map(x => String(x == null ? '' : x)).filter(Boolean));
        const picked = (state.atoms || []).filter(a => a && want.has(String(a.id)));
        const usable = picked.filter(a => !atomIsHidden(a) && String(a.text || '').trim());
        out.skipped = picked.length - usable.length;
        if (usable.length < 2) { out.reason = usable.length ? 'need2' : 'empty'; return out; }
        const range = atomMergeRange(usable);
        out.label = range.label;
        const sumId = 'atom_m_' + hashText(usable.map(a => String(a.id)).sort().join('|'));
        if ((state.atoms || []).some(a => a && String(a.id) === sumId)) { out.reason = 'exists'; out.summaryId = sumId; return out; }
        const body = dimCap('atoms', normText(String((ai && ai.text) || '').replace(/\s+/g, ' ').trim(), 300));
        if (!body || body.length < 8) { out.reason = 'tooShort'; return out; }
        // 关键要素并集（角色 / 地点 / 标签）—— AI 未给标签时用所选并集兜底
        const ents = [], locs = [], tags = [];
        for (const a of usable) {
            for (const e of (Array.isArray(a.entities) ? a.entities : [])) { const t = String(e).trim(); if (t && ents.indexOf(t) < 0) ents.push(t); }
            for (const l of (Array.isArray(a.locations) ? a.locations : [])) { const t = String(l).trim(); if (t && locs.indexOf(t) < 0) locs.push(t); }
            for (const g of (Array.isArray(a.tags) ? a.tags : [])) { const t = String(g).trim(); if (t && tags.indexOf(t) < 0) tags.push(t); }
        }
        const aiTags = (ai && Array.isArray(ai.tags) && ai.tags.length) ? ai.tags : tags;
        const impMax = usable.reduce((m, a) => Math.max(m, Number(a.importance) || 0), 0);
        const titleBase = String((ai && ai.title) || '').trim();
        const marker = `【${range.label || usable.length + ' 条'} 总结】`;
        const title = (marker + (titleBase ? ' ' + titleBase : '')).slice(0, 40);
        const now = Date.now();
        const sum = {
            id: sumId, kind: 'plot_atom', text: body, title,
            type: '总结', date: range.start || (String(usable[0].date || '').trim()), time: '',
            entities: ents.slice(0, 12), locations: locs.slice(0, 8),
            tags: normalizeList(aiTags).slice(0, 6), keywords: [],
            importance: (ai && Number.isFinite(ai.importance)) ? ai.importance : Math.max(0.6, impMax),
            validity: 'active', permanence: 'permanent', uses: 0,
            floorStart: Number(range.floorStart) || 0, floorEnd: Number(range.floorEnd) || 0,
            mergedSummary: {
                label: range.label || '', start: range.start || '', end: range.end || '',
                sourceIds: usable.map(a => String(a.id)), sourceCount: usable.length, at: now,
                by: 'manual',   // v1.206：来源（manual = 手动多选合并 / auto = 半自动聚合早期情节）
            },
            createdAt: now, updatedAt: now,
        };
        state.atoms = Array.isArray(state.atoms) ? state.atoms : [];
        state.atoms.push(sum);
        // 原情节：**保留**但隐藏 + 记录来源（不删除、不记墓碑 → 跨端也不会消失）
        for (const a of usable) {
            a.hidden = true;
            a.summarizedBy = sumId;
            a.summarizedAt = now;
            a.updatedAt = now;
        }
        out.ok = true; out.summaryId = sumId; out.merged = usable.length; out.hidden = usable.length;
        return out;
    } catch (e) { out.reason = 'error'; return out; }
}

/** 主流程（手动触发，V1 `runAtomMergeSummary`）：忙位互斥 → 组装提示词 → AI → 解析 → 落库
 *  （新增 1 条总结 + 原情节隐藏）。
 *  早退：无可用情节 → `{made:0, skipped:true, total:0, picked}`；<2 条 → `{made:0, skipped:true, total, picked}`；
 *  `aiBusy()` → `{made:0, blocked:true}`；AI 空 → `{made:0, error:'emptyResult', total}`；
 *  落库失败 → `{made:0, skipped:true, reason, total}`。
 *  @param {Array} ids 勾选的情节 id
 *  @param {object} [opts] aiText（V2 注入点）
 *  @returns {Promise<object>} V1 同形返回结构 */
async function runAtomMergeSummary(ids, opts) {
    const o = opts || {};
    try {
        const want = new Set((Array.isArray(ids) ? ids : []).map(x => String(x == null ? '' : x)).filter(Boolean));
        const picked = (state.atoms || []).filter(a => a && want.has(String(a.id)));
        const usable = picked.filter(a => !atomIsHidden(a) && String(a.text || '').trim());
        if (!usable.length) {
            notify('warning', '情节总结：未选中可用情节', '请在「📜 情节列表」切到多选模式勾选情节（已总结隐藏的情节不参与再次合并）。');
            return { made: 0, skipped: true, total: 0, picked: picked.length };
        }
        if (usable.length < 2) {
            notify('info', '情节总结：至少选择 2 条情节', `本次仅选中 ${usable.length} 条可用情节（已总结隐藏的不计入）。`);
            return { made: 0, skipped: true, total: usable.length, picked: picked.length };
        }
        // V1 有两道忙位判据（`busy.repair` → 「任务进行中」；`busy.summary|compact|weave|advance|sync` → `pipelineBlockInfo`）。
        //   V2 由宿主 `aiBusy()` 钩子统一表达 → 取**管线占用**那一道的文案（最常见的占用来源）。
        if (aiBusy()) { notify('warning', '当前任务占用中', '摘要/情节总结/推演/推进结束后再合并。'); return { made: 0, blocked: true }; }
        const range = atomMergeRange(usable);
        const prompt = buildAtomMergePrompt(usable);
        if (!prompt) { notify('info', '合并总结：无待合并内容', '所选情节内容为空。'); return { made: 0, skipped: true }; }
        try {
            const t0 = Date.now();
            notify('warning', '开始合并所选情节…', `已勾选 ${picked.length} 条 · 可合并 ${usable.length} 条（已总结隐藏跳过 ${picked.length - usable.length} 条）${range.label ? ` · 跨度 ${range.label}` : ''}`);
            const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '情节合并总结'));
            const ai = parseAtomMergeResult(resp);
            if (!ai) {
                notify('warning', '合并总结：AI 未返回可用内容', '结果为空或过短，未做任何改动（原情节保持原样）。');
                return { made: 0, error: 'emptyResult', total: usable.length };
            }
            const r = atomMergeSummary(Array.from(want), ai);
            if (!r.ok) {
                const why = r.reason === 'exists' ? '该批情节已合并过（同一条总结已存在）' : (r.reason === 'tooShort' ? '总结正文过短' : '未生成总结');
                notify('info', '合并总结：未落库', `${why}。原情节保持原样。`);
                return { made: 0, skipped: true, reason: r.reason, total: usable.length };
            }
            saveState();
            notify('success', '情节总结完成（手动）', `新增 1 条情节总结「${r.label}」· 覆盖 ${r.merged} 条原情节（原文保留并隐藏，不参与注入与淘汰；可在总结上点 🧩 穿透查看）`);
            try { dbgLog('摘要', { action: '情节合并总结（v1.203）', picked: picked.length, merged: r.merged, skipped: r.skipped, label: r.label, summaryId: r.summaryId, ms: Date.now() - t0 }); } catch (e) { }
            return { made: 1, added: 1, merged: r.merged, hidden: r.hidden, skipped: r.skipped, summaryId: r.summaryId, label: r.label, total: usable.length };
        } catch (e) {
            warn('情节合并总结失败', e);
            notify('error', '情节合并总结失败', String((e && e.message) || e).slice(0, 100));
            return { made: 0, error: String((e && e.message) || e) };
        }
    } catch (e) { return { made: 0, error: String((e && e.message) || e) }; }
}

export {
    COMPACT_GRAINS, COMPACT_GROUPS_PER_CALL,
    atomBodyChars, atomDateGrainKey, grainStartDateStr, atomCompactPlan, atomGroupPlan,
    buildAtomCompactPrompt, compactGrainLabel, applyCompactGroup, scheduleAtomCompact, runAtomCompact,
    atomMergeRange, buildAtomMergePrompt, parseAtomMergeResult, atomMergeSummary, runAtomMergeSummary,
    atomHiddenCount,
};
