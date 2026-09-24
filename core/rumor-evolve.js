// ============================================================
// core/rumor-evolve.js —— **传言演化引擎**（B8-7 内核部分）
//   （逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js` 的 v1.192 传言引擎段：
//     行 13261~13820 的引擎主体 + 行 23377 的 `flattenRumor`）
//
// 设计口径（用户要求原文见 V1 段 03 的 v1.192 配置注释）：
//   ① 抽取：与其它分析记忆维度**同批**（模板 `rumors`）→ `rumorApplyAiDelta()` 落库；
//   ② 演化：**零 AI**。每满 `rumorChangeEveryRounds`（默认 5）个**楼层轮次**演化一次，逐条做：
//      载体按剧情时间老化 → 发酵度增减（活跃载体 / 传播者 / 联动 / 时间压力）→ 与「标签高度关联」的
//      平行事件按概率联动（**发酵 / 消退 / 推动平行世界发生新的变化**）→ 视概率酝酿裂变 → 阶段重算；
//      平行世界发生变化时轮次**重新计数**（`rumorMarkParallelChange()`）；
//   ③ 变化过程：所有变化先写入 `pending`（需 `rumorChangeNeedRounds` 轮才提交），每轮记录一条传导链路 ——
//      「传言的变化不可能立刻发生，会有变化过程」；
//   ④ 裂变：提交时以「父 id + 变体名」派生**稳定子 id** 新建传言（主体不变、记录父子关联与谱系世代）；
//   ⑤ 衰退：复用 `calcTimeDecay` 通用多级时间衰退（与平行事件同款参数），命中阈值自动移除并留墓碑。
//   ⑥ 概率全部由 `rumorRoll(seed)`（`hashText` 种子哈希）决定 —— **确定性**：两端各自演化得到同样结果，
//      跨端不抖动（黄金样本因此可复现：固定 seed + 固定剧情日期）。
//
// 本批（B8-7 内核部分）只交付**内核**：全部函数从本模块 export 且导入时零副作用。
//   **FTT 入口（`rumorEvolve` / `rumorAdvance` / `clearRumors` 动作）与面板接线待共享文件空闲后由队长另行安排。**
//
// 适配（与 V1 的差异，逐条见 docs/P8t-B8-7传言演化引擎.md）：
//   ① ESM 化 + 视图注入：`state` / `cfg` / `saveState` / `dbgLog` / `getStoryNow` / `getLastMessageId` /
//      `notifyHooks` / `timerHooks` 全部来自 `core/model/runtime.js`（V1 是模块内全局）；
//   ② 弹窗：V1 `notify(kind, {title,text})` / `toast(msg, type)` → 本文件局部 `notify(kind, title, text)` /
//      `toast(text, kind)`，与 `core/repair.js` / `core/group-repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//   ③ 延迟调度：V1 `setTimeout(..., 3000)` → `timerHooks.set(..., 3000)`（内核不直接握有宿主定时器）；
//   ④ `rumorInjLine` 已在 `core/recall.js` 逐字移植（V1 同一函数，注入层复用），本模块 **re-export** 不重复实现；
//   ⑤ `mergeRumorListBy`（V1 行 13316）按 V1 导出清单属**模型助手**，已上移到 `core/model/rumor.js` 导出；
//      本模块从模型层引入（消除「引擎 / 落库」两处各写一份的漂移风险）；
//   ⑥ 日期数学：V1 `storyDateMsFromStr` / `clockDateTrim` → `core/clock.js` 同名等价物（逐字移植批次已交付）。
//
// ⚠ 与 `core/ingest.js` 的关系（**已知重复，如实记录**）：B3 落库批次已把 `rumorEnabledOn` / `rumorTickState` /
//   `rumorStoryDate` / `rumorChainPush` / `mergeRumorListBy` / `rumorAiHas` / `rumorMergeAiInto` / `rumorApplyAiDelta`
//   的**私有副本**内联在 `core/ingest.js` 里（未导出）。本文件是引擎的**完整实现**，同一 V1 源行、行为一致；
//   接线时 `ingest.js` 应改为 `import` 本模块以消除重复。本批受「只新增文件」并发约束，不得改动 `ingest.js`。
// 一致性由 tests/unit/rumor-evolve-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, dbgLog, getStoryNow, getLastMessageId, notifyHooks, timerHooks } from './model/runtime.js';
import { clockDateTrim, storyDateMsFromStr } from './clock.js';
import { tombMany, tombEntries } from './merge.js';
import { calcTimeDecay, repairSimilarity } from './ingest.js';
import { repairTagSetOf, repairJaccard } from './repair.js';
import {
    normalizeRumor, normalizeRumorChain, normalizeRumorChainStep, normalizeRumorLineage,
    rumorChildId, rumorSubjectKey, rumorStageByFerment, mergeRumorListBy, RUMOR_VARIANTS,
} from './model/rumor.js';
import { hashText, normText } from './util.js';

// 内核弹窗出口（与 core/repair.js#notify 逐字一致：title + text 合并为一条 toast）
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/** V1 遗留入口 `toast(msg, type)`：正文 + 类型（无标题） */
function toast(text, kind) {
    try { notifyHooks.toast(String(text == null ? '' : text), String(kind || 'info')); } catch (e) { /* 忽略 */ }
}

// ==================== v1.192：传言引擎（抽取落库 · 纯机械演化 · 平行联动 · 裂变 · 衰退） ====================

function rumorEnabledOn() { return !!(cfg && cfg.rumorEnabled !== false); }

function rumorEveryRounds() {
    const v = Number(cfg && cfg.rumorChangeEveryRounds);
    return Number.isFinite(v) ? Math.max(1, Math.round(v)) : 5;   // 0/负数 = 至少 1 轮；非数字 = 默认 5
}
function rumorNeedRounds() { return Math.max(1, Math.round(Number(cfg && cfg.rumorChangeNeedRounds) || 2)); }

function rumorTickState() {
    try {
        const t = (state.rumorTick && typeof state.rumorTick === 'object') ? state.rumorTick : {};
        state.rumorTick = {
            round: Math.max(0, Math.round(Number(t.round) || 0)),
            lastFloor: Number.isFinite(Number(t.lastFloor)) ? Number(t.lastFloor) : -1,
            parallelFloor: Number.isFinite(Number(t.parallelFloor)) ? Number(t.parallelFloor) : -1,
            runs: Math.max(0, Math.round(Number(t.runs) || 0)),
            lastAt: Number(t.lastAt) || 0,
        };
        return state.rumorTick;
    } catch (e) { return { round: 0, lastFloor: -1, parallelFloor: -1, runs: 0, lastAt: 0 }; }
}
// 确定性掷骰：同一 seed 恒返回同一 0~1（跨端一致；测试可复现）
function rumorRoll(seed) {
    try { return (parseInt(hashText(String(seed == null ? '' : seed)), 16) % 100000) / 100000; } catch (e) { return 0; }
}
function rumorStoryDate() {
    try { const n = getStoryNow(); return (n && /^-?\d{1,4}-\d{2}-\d{2}/.test(String(n))) ? clockDateTrim(n) : ''; } catch (e) { return ''; }
}
// 剧情天数差（用 v1.188 的剧情日期数学；日期不可解析时返回 0 = 不老化）
function rumorDayDiff(from, to) {
    try {
        const ms = (d) => { try { return (typeof storyDateMsFromStr === 'function') ? storyDateMsFromStr(String(d || '')) : NaN; } catch (e) { return NaN; } };
        const a = ms(from), b = ms(to);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
        return Math.max(0, Math.round((b - a) / 86400000));
    } catch (e) { return 0; }
}
function rumorChainPush(r, step) {
    try {
        if (!r) return null;
        const t = rumorTickState();
        const s = normalizeRumorChainStep(Object.assign({ at: rumorStoryDate(), round: Number(t.runs) || 0 }, step || {}));
        if (!s) return null;
        r.chain = normalizeRumorChain((r.chain || []).concat([s]));
        return s;
    } catch (e) { return null; }
}
function rumorActiveMediaCount(r) {
    try { return (Array.isArray(r && r.media) ? r.media : []).filter(m => m && m.active !== false).length; } catch (e) { return 0; }
}
function rumorMediaWeight(r) {
    try {
        return (Array.isArray(r && r.media) ? r.media : []).filter(m => m && m.active !== false)
            .reduce((s, m) => s + Math.max(1, Number(m.durability) || 1), 0);
    } catch (e) { return 0; }
}
// 载体老化：超过「基础寿命 × 耐久度」的剧情天数 → 停止扩散（记链路）
function rumorAgeMedia(r) {
    try {
        const life = Math.max(1, Math.round(Number(cfg && cfg.rumorMediaLifeDays) || 30));
        const today = rumorStoryDate();
        let expired = 0;
        for (const m of (r.media || [])) {
            if (!m || m.active === false) continue;
            const base = m.at || r.date || '';
            const days = (base && today) ? rumorDayDiff(base, today) : 0;
            const limit = life * Math.max(1, Number(m.durability) || 1);
            if (days > limit) {
                m.active = false;
                expired++;
                rumorChainPush(r, { kind: '载体停用', from: m.name || m.type, note: `载体「${m.name || m.type}」超寿命（${days} 天 > ${limit} 天）停止扩散` });
            }
        }
        return expired;
    } catch (e) { return 0; }
}
// 发酵度增量：活跃载体（按耐久度加权）+ 传播者 + 联动带来的推力，减去「久未变化」与「无载体」的压力
function rumorFermentDelta(r) {
    try {
        const mediaBoost = Math.min(8, rumorMediaWeight(r));
        const carriers = (Array.isArray(r && r.carriers) ? r.carriers.length : 0);
        const days = (r && r.date) ? rumorDayDiff(r.date, rumorStoryDate()) : 0;
        const gain = 2 + mediaBoost + Math.min(6, carriers * 2) + ((r && (r.parallelRefs || []).length) ? 2 : 0);
        const loss = Math.min(12, Math.floor(days / 30) * 2) + (rumorActiveMediaCount(r) === 0 ? 3 : 0);
        return gain - loss;
    } catch (e) { return 0; }
}
// 与平行事件的「标签高度关联」相似度（标签 Jaccard；无标签 = 0）
function rumorParallelLinkScore(r, p) {
    try { return repairJaccard(repairTagSetOf(r), repairTagSetOf(p)); } catch (e) { return 0; }
}
// 联动：标签关联度 ≥ 阈值 → 按概率产出「发酵 / 消退 / 推动平行世界发生新的变化」三选一
function rumorParallelLink(r, idx) {
    try {
        const sim = Math.min(0.99, Math.max(0, Number(cfg && cfg.rumorParallelLinkSim) != null ? Number(cfg.rumorParallelLinkSim) : 0.34));
        const chance = Math.min(1, Math.max(0, Number(cfg && cfg.rumorParallelLinkChance) != null ? Number(cfg.rumorParallelLinkChance) : 0.35));
        if (chance <= 0) return null;
        let best = null, bestSim = 0;
        for (const p of (state.parallels || [])) {
            if (!p || p.promotedTo) continue;   // 已转正为情节的平行事件不再联动
            const s = rumorParallelLinkScore(r, p);
            if (s > bestSim) { bestSim = s; best = p; }
        }
        if (!best || bestSim < sim) return null;
        const seed = `${r.id}|link|${r.date || ''}|${idx}`;
        if (rumorRoll(seed) >= chance) return null;
        const roll = rumorRoll(`${r.id}|linkef|${r.date || ''}|${idx}`);
        const kind = roll < 0.4 ? '发酵' : (roll < 0.7 ? '消退' : '推动');
        if (!Array.isArray(r.parallelRefs)) r.parallelRefs = [];
        const pid = String(best.id || '');
        if (pid && r.parallelRefs.indexOf(pid) < 0) r.parallelRefs.push(pid);
        const pTitle = String(best.title || best.id || '');
        if (kind === '发酵') {
            r.ferment = Math.min(100, (Number(r.ferment) || 0) + 12);
            rumorChainPush(r, { kind: '联动', to: pTitle, note: `与平行事件「${pTitle}」标签高度关联（${bestSim.toFixed(2)}）→ 传言发酵 +12` });
        } else if (kind === '消退') {
            r.ferment = Math.max(0, (Number(r.ferment) || 0) - 15);
            rumorChainPush(r, { kind: '联动', to: pTitle, note: `与平行事件「${pTitle}」标签高度关联（${bestSim.toFixed(2)}）→ 传言消退 -15` });
        } else {
            // 推动平行世界发生新的变化：写入该平行事件的「预演」（字符串数组，≤40 字/条）
            if (!Array.isArray(best.previews)) best.previews = [];
            const line = `传言「${String(r.subject || '').slice(0, 12)}」发酵推动：${String(r.content || '').slice(0, 20)}`;
            best.previews.push(line.slice(0, 40));
            if (best.previews.length > 6) best.previews = best.previews.slice(-6);
            best.updatedAt = Date.now();
            r.ferment = Math.min(100, (Number(r.ferment) || 0) + 6);
            rumorChainPush(r, { kind: '联动', to: pTitle, note: `与平行事件「${pTitle}」标签高度关联（${bestSim.toFixed(2)}）→ **推动平行世界发生新的变化**（已写入其预演）` });
        }
        return { kind, sim: bestSim, parallelId: pid, title: pTitle };
    } catch (e) { return null; }
}
function rumorVariantFor(r, idx) {
    try {
        const i = Math.floor(rumorRoll(`${r.id}|variant|${r.date || ''}|${idx}`) * RUMOR_VARIANTS.length);
        return RUMOR_VARIANTS[Math.max(0, Math.min(RUMOR_VARIANTS.length - 1, i))];
    } catch (e) { return RUMOR_VARIANTS[0]; }
}
// 开始一个「变化过程」（同一时间只允许一个；需满 N 轮才提交 —— 变化不会立刻发生）
function rumorStartPending(r, kind, target, idx) {
    try {
        if (r.pending) return false;
        r.pending = { kind, need: rumorNeedRounds(), progress: 0, target: String(target || ''), at: rumorStoryDate() };
        rumorChainPush(r, { kind: kind === '裂变' ? '裂变' : '异变', note: `变化过程开始：${kind}「${String(target || '').slice(0, 30)}」（需 ${rumorNeedRounds()} 轮，不会立刻生效）` });
        return true;
    } catch (e) { return false; }
}
// 推进变化过程；满轮后提交（返回提交结果，未提交返回 null）
function rumorAdvancePending(r, idx) {
    try {
        const p = r.pending;
        if (!p) return null;
        p.progress = Math.min(Number(p.need) || 1, (Number(p.progress) || 0) + 1);
        if (p.progress < (Number(p.need) || 1)) {
            rumorChainPush(r, { kind: p.kind === '裂变' ? '裂变' : '异变', note: `变化过程推进：${p.kind}（${p.progress}/${p.need} 轮）` });
            return null;
        }
        return rumorCommitPending(r, idx);
    } catch (e) { return null; }
}
// 提交变化：裂变 = 新建分支（主体不变 + 父子关联 + 谱系世代）；变异 = 说法机械演化
function rumorCommitPending(r, idx) {
    try {
        const p = r.pending;
        if (!p) return null;
        if (p.kind === '裂变') {
            const variant = String(p.target || '').trim() || rumorVariantFor(r, idx);
            const cid = rumorChildId(r, variant);
            const exist = (state.rumors || []).find(x => x && x.id === cid);
            r.pending = null;
            if (exist) { rumorChainPush(r, { kind: '裂变', note: `分支「${variant}」已存在，跳过重复裂变` }); return { skipped: true, childId: cid, variant }; }
            const rootId = (r.lineage && r.lineage.rootId) || r.id;
            const child = normalizeRumor({
                id: cid,
                subject: r.subject,                                  // 用户要求：无论如何裂变都只有一个主体
                content: `${r.content}（${variant}）`,
                objectivity: r.objectivity,
                ferment: Math.max(10, Math.round((Number(r.ferment) || 0) * 0.6)),
                carriers: (r.carriers || []).slice(0, 6),
                media: (r.media || []).slice(0, 4),
                source: r.source,
                date: rumorStoryDate() || r.date,
                tags: (r.tags || []).slice(0, 5),
                lineage: { rootId, parentId: r.id, children: [], generation: (Number(r.lineage && r.lineage.generation) || 0) + 1 },
                chain: [{ at: rumorStoryDate() || r.date, kind: '起源', from: r.subject, to: `${r.subject}`, note: `由「${r.subject}」裂变而来（${variant}）` }],
                createdAt: Date.now(), updatedAt: Date.now(),
            });
            if (!child) return null;
            if (!Array.isArray(r.lineage.children)) r.lineage.children = [];
            if (r.lineage.children.indexOf(cid) < 0) r.lineage.children.push(cid);
            rumorChainPush(r, { kind: '裂变', to: String(r.subject), note: `分裂为新的传言分支「${variant}」（子条 ${cid}）` });
            state.rumors.push(child);
            return { childId: cid, variant, child };
        }
        if (p.kind === '变异') {
            const variant = String(p.target || '').trim() || rumorVariantFor(r, idx);
            const before = String(r.content || '');
            r.content = normText(`${before}（说法演变为：${variant}）`, Math.max(40, Number((cfg && cfg.dimCharLimits && cfg.dimCharLimits.rumors) || 240)));
            r.ferment = Math.min(100, (Number(r.ferment) || 0) + 8);
            r.pending = null;
            rumorChainPush(r, { kind: '异变', from: before.slice(0, 40), to: String(r.content).slice(0, 40), note: `说法完成演化（${variant}）` });
            return { variant };
        }
        r.pending = null;
        return null;
    } catch (e) { return null; }
}
// 是否开始新的变化（裂变优先：发酵度达标 + 有传播者 + 概率命中；其次「变异」= 说法走样）
function rumorMaybeStartChange(r, idx) {
    try {
        if (r.pending) return null;
        const f = Number(r.ferment) || 0;
        const fissFerment = Math.max(10, Math.min(100, Number(cfg && cfg.rumorFissionFerment) != null ? Number(cfg.rumorFissionFerment) : 80));
        const chance = Math.min(1, Math.max(0, Number(cfg && cfg.rumorFissionChance) != null ? Number(cfg.rumorFissionChance) : 0.3));
        if (chance <= 0) return null;
        const roster = (Array.isArray(r.carriers) ? r.carriers.length : 0);
        if (f >= fissFerment && roster >= 1 && rumorRoll(`${r.id}|fission|${r.date || ''}|${idx}`) < chance) {
            const v = rumorVariantFor(r, idx);
            return rumorStartPending(r, '裂变', v, idx) ? { kind: '裂变', variant: v } : null;
        }
        if (f >= 60 && rumorRoll(`${r.id}|mutate|${r.date || ''}|${idx}`) < chance * 0.8) {
            const v = rumorVariantFor(r, idx);
            return rumorStartPending(r, '变异', v, idx) ? { kind: '变异', variant: v } : null;
        }
        return null;
    } catch (e) { return null; }
}
// 机械演化主流程（纯 JS，零 AI 调用）：返回统计供通知 / 调试 / 测试使用
async function runRumorEvolve(opts) {
    const o = opts || {};
    const out = { ok: true, reason: String(o.reason || 'manual'), list: (state.rumors || []).length, aged: 0, ferment: 0, links: 0, changes: 0, committed: 0, fissions: 0, decay: null, disabled: false, fissionsIds: [] };
    try {
        if (!rumorEnabledOn()) { out.disabled = true; return out; }
        const tick = rumorTickState();
        tick.runs = (Number(tick.runs) || 0) + 1;
        tick.lastAt = Date.now();
        let idx = 0;
        for (const r of (state.rumors || [])) {
            idx++;
            if (!r || typeof r !== 'object') continue;
            try {
                if (rumorAgeMedia(r)) out.aged++;
                // ① 先推进已有「变化过程」（满轮提交）
                const committed = rumorAdvancePending(r, tick.runs);
                if (committed) {
                    out.committed++;
                    if (committed.childId) { out.fissions++; out.fissionsIds.push(committed.childId); }
                }
                // ② 发酵度（沉寂且无载体的传言不再回涨）
                if (String(r.stage) !== '沉寂' || rumorActiveMediaCount(r) > 0) {
                    const delta = rumorFermentDelta(r);
                    if (delta) { r.ferment = Math.max(0, Math.min(100, (Number(r.ferment) || 0) + delta)); out.ferment++; }
                }
                // ③ 平行联动（发酵 / 消退 / 推动平行世界变化）
                if (rumorParallelLink(r, tick.runs)) out.links++;
                // ④ 酝酿新的变化（裂变 / 变异）
                if (rumorMaybeStartChange(r, tick.runs)) out.changes++;
                // ⑤ 阶段重算 + 剧情日期跟新
                const st = rumorStageByFerment(r.ferment);
                if (st !== r.stage) {
                    rumorChainPush(r, { kind: (st === '消退' || st === '沉寂') ? '消退' : '发酵', note: `阶段：${r.stage || '—'} → ${st}（发酵度 ${r.ferment}）` });
                    r.stage = st;
                }
                const today = rumorStoryDate();
                if (today) r.date = today;
                r.updatedAt = Date.now();
            } catch (e) { }
        }
        try { out.decay = await runRumorDecay({ force: false }); } catch (e) { out.decay = null; }
        try { saveState(); } catch (e) { }
        try {
            dbgLog('摘要', { action: '传言演化（机械 · 零 AI）', reason: out.reason, runs: tick.runs, list: out.list, aged: out.aged, ferment: out.ferment, links: out.links, changes: out.changes, committed: out.committed, fissions: out.fissions, decay: out.decay });
        } catch (e) { }
        if (!o.silent && (out.aged || out.links || out.changes || out.committed)) {
            try {
                notify('success', '📢 传言演化完成',
                    `载体停用 ${out.aged} · 平行联动 ${out.links} · 酝酿变化 ${out.changes} · 完成变化 ${out.committed}（含裂变 ${out.fissions}）· 衰退移除 ${(out.decay && out.decay.removed) || 0}（共 ${(state.rumors || []).length} 条）`);
            } catch (e) { }
        }
        return out;
    } catch (e) { out.ok = false; out.error = String((e && e.message) || e); return out; }
}
async function runRumorEvolveNow(opts) { return runRumorEvolve(Object.assign({ reason: 'manual' }, opts || {})); }

// 楼层轮次计数：每新增 1 楼算 1 轮；满 N 轮触发一次传言演化（异步触发，不阻塞提取收尾）
function rumorTickAdvance(floor) {
    try {
        if (!rumorEnabledOn()) return { ok: false, disabled: true, triggered: false };
        const t = rumorTickState();
        let f = Number(floor);
        if (!Number.isFinite(f) || f < 0) { try { f = Number(getLastMessageId()); } catch (e) { f = -1; } }
        if (Number.isFinite(f) && f >= 0 && f > (Number(t.lastFloor) || -1)) {
            t.round = (Number(t.round) || 0) + 1;
            t.lastFloor = f;
        }
        const every = rumorEveryRounds();
        if ((Number(t.round) || 0) < every) return { ok: true, round: t.round, every, triggered: false };
        t.round = 0;
        try { Promise.resolve().then(() => runRumorEvolve({ reason: 'tick' })).catch(() => { }); } catch (e) { }
        return { ok: true, round: 0, every, triggered: true };
    } catch (e) { return { ok: false, triggered: false, error: String((e && e.message) || e) }; }
}
// 平行世界发生变化后：传言轮次**重新计数**（「平行时间发生变化后，每隔 N 轮触发传言变化」）
function rumorMarkParallelChange(floor) {
    try {
        const t = rumorTickState();
        t.round = 0;
        t.parallelFloor = Number.isFinite(Number(floor)) ? Number(floor) : (Number(t.lastFloor) || -1);
        try { dbgLog('摘要', { action: '平行世界发生变化 → 传言轮次重新计数', floor: t.parallelFloor, every: rumorEveryRounds() }); } catch (e) { }
        return t;
    } catch (e) { return null; }
}
let rumorEvolveTimer = null;
function scheduleRumorEvolve(reason) {
    try {
        if (!rumorEnabledOn()) return;
        if (rumorEvolveTimer) return;
        rumorEvolveTimer = timerHooks.set(() => {
            rumorEvolveTimer = null;
            try { runRumorEvolve({ reason: reason || 'scheduled' }); } catch (e) { }
        }, 3000);
    } catch (e) { }
}
// —— 传言衰退（复用 calcTimeDecay 通用多级时间衰退；参数与平行事件同款） ——
function rumorDecayScore(r) {
    const list = state.rumors || [];
    const ts = list.map(x => Number(x && x.updatedAt) || 0).filter(t => t > 0);
    const earliest = ts.length ? Math.min.apply(null, ts) : 0;
    const latest = ts.length ? Math.max.apply(null, ts) : (Number(r && r.updatedAt) || 0);
    return calcTimeDecay(earliest, latest, Date.now(), Number(r && r.updatedAt) || 0, list.length);
}
function rumorExpired(r) {
    if (!cfg || cfg.rumorDecayEnabled === false) return false;
    const cutoff = Number(cfg.rumorDecayCutoff) != null ? Number(cfg.rumorDecayCutoff) : 0.95;
    return rumorDecayScore(r) >= Math.min(1, Math.max(0, cutoff));
}
let rumorDecayTimer = null;
function scheduleRumorDecay() {
    try {
        if (!cfg || cfg.rumorDecayEnabled === false) return;
        if (rumorDecayTimer) return;
        rumorDecayTimer = timerHooks.set(() => {
            rumorDecayTimer = null;
            try { runRumorDecay({}); } catch (e) { }
        }, 3000);
    } catch (e) { }
}
async function runRumorDecay(opts) {
    try {
        if (!cfg || cfg.rumorDecayEnabled === false) return { removed: 0, triggered: false, reason: 'disabled' };
        const o = opts || {};
        const list = state.rumors || [];
        const n = list.length;
        const cap = Math.max(1, Number(cfg.storeMaxRumors) || 200);
        const ratio = Math.min(1, Math.max(0, Number(cfg.rumorDecayRatio) != null ? Number(cfg.rumorDecayRatio) : 0.5));
        const overRatio = n > Math.floor(cap * ratio);
        const expired = list.filter(rumorExpired);
        if (!o.force && !overRatio && !expired.length) return { removed: 0, triggered: false, overRatio, n, cap };
        if (expired.length) {
            const ids = expired.map(x => x && x.id).filter(Boolean).map(String);
            try { tombMany('rumors', ids); } catch (e) { }
            try { tombEntries('rumors', expired); } catch (e) { }   // v1.192：同时留内容哈希墓碑（同内容换 id 也不复活）
            const gone = new Set(ids);
            state.rumors = list.filter(x => !(x && gone.has(String(x.id || ''))));
            try { saveState(); } catch (e) { }
        }
        try {
            dbgLog('摘要', { action: '传言衰退', n, cap, overRatio, cutoff: Number(cfg.rumorDecayCutoff), removed: expired.length, subjects: expired.slice(0, 6).map(x => x.subject || x.id || '') });
        } catch (e) { }
        if (expired.length) {
            const remain = (state.rumors || []).length;
            try { toast(`💀 传言消退：${expired.length} 条已达衰退阈值自动移除（剩 ${remain}/${cap}）`, 'info'); } catch (e) { }
        }
        return { removed: expired.length, triggered: overRatio || expired.length > 0, overRatio, n, cap, remain: (state.rumors || []).length };
    } catch (e) { return { removed: 0, triggered: false, error: String((e && e.message) || e) }; }
}
// AI 增量是否提供了某个字段（用于「没给就保留旧值」—— 尤其是机械演化字段 stage/ferment 绝不能被默认值覆盖）
function rumorAiHas(raw, keys) {
    try {
        if (!raw || typeof raw !== 'object') return false;
        for (const k of keys) {
            const v = raw[k];
            if (v === undefined || v === null) continue;
            if (typeof v === 'string' && !v.trim()) continue;
            if (Array.isArray(v) && !v.length) continue;
            return true;
        }
    } catch (e) { }
    return false;
}
// 「AI 增量 + 既有条目」合并：AI 明确的字段覆盖；未提供的字段保留旧值；集合类字段一律并集；
//   机械演化字段（stage/ferment/pending/chain/lineage/uses/时间戳）永不由 AI 覆盖。
function rumorMergeAiInto(prev, n0, raw) {
    const p = prev || {};
    const n = n0 || {};
    const num = (v) => Number(v) || 0;
    const out = Object.assign({}, p, n);
    out.id = p.id || n.id;
    out.uses = num(p.uses);
    out.createdAt = p.createdAt || n.createdAt;
    out.updatedAt = Date.now();
    out.lineage = normalizeRumorLineage(p.lineage, out.id);
    out.pending = p.pending || null;
    out.chain = Array.isArray(p.chain) ? p.chain : (Array.isArray(n.chain) ? n.chain : []);
    if (!rumorAiHas(raw, ['subject', '主体', 'name', 'title'])) out.subject = p.subject || n.subject;
    if (!rumorAiHas(raw, ['content', 'text', '正文', '说法'])) out.content = p.content || n.content;
    if (!rumorAiHas(raw, ['objectivity', '客观性'])) out.objectivity = p.objectivity || n.objectivity;
    if (!rumorAiHas(raw, ['source', '来源'])) out.source = p.source || '';
    if (!rumorAiHas(raw, ['date', '日期'])) out.date = p.date || n.date;
    if (!rumorAiHas(raw, ['ferment', '发酵度'])) out.ferment = num(p.ferment) || num(n.ferment);
    if (!rumorAiHas(raw, ['stage', '阶段'])) out.stage = p.stage || rumorStageByFerment(out.ferment);
    else out.stage = rumorStageByFerment(out.ferment);
    out.floorStart = num(p.floorStart) || num(n.floorStart);
    out.floorEnd = Math.max(num(p.floorEnd), num(n.floorEnd));
    out.tags = mergeRumorListBy(p.tags, n.tags, x => String(x)).slice(0, 8);
    out.carriers = mergeRumorListBy(p.carriers, n.carriers, x => String((x && x.who) || '') + '|' + String((x && x.role) || '')).slice(0, 12);
    out.media = mergeRumorListBy(p.media, n.media, x => String((x && x.type) || '') + '|' + String((x && x.name) || '') + '|' + String((x && x.at) || '')).slice(0, 12);
    out.parallelRefs = Array.from(new Set([].concat(p.parallelRefs || [], n.parallelRefs || []).map(x => String(x || '')).filter(Boolean))).slice(0, 12);
    out.title = out.subject;
    out.text = out.content;
    return out;
}
// AI 增量落库：① 显式「分裂自」→ 父条目的新分支；② 同主体 + 说法相近 → 同一主体的演化（更新）；
//   ③ 同主体 + 说法差异大 → 视为**分裂**（新建分支，主体不变）；④ 无同主体 → 全新传言（记「起源」链路）
function rumorApplyAiDelta(raw, opts) {
    try {
        if (!rumorEnabledOn()) return null;
        const o = opts || {};
        const n0 = normalizeRumor(raw);
        if (!n0) return null;
        const fb = o.floor || {};
        const fe0 = Number(fb.end), fs0 = Number(fb.start);
        if (Number.isInteger(fe0) && fe0 >= 0) n0.floorEnd = Math.max(Number(n0.floorEnd) || 0, fe0);
        if (Number.isInteger(fs0) && fs0 >= 0) n0.floorStart = Math.max(Number(n0.floorStart) || 0, fs0);
        const today = rumorStoryDate();
        if (!n0.date && today) n0.date = today;
        const split = String((raw && (raw.splitFrom || raw['分裂自'] || raw['演化自'] || raw['分裂来源'])) || '').trim();
        const subjKey = (x) => rumorSubjectKey((x && x.subject) || '');
        let parent = null, prev = null;
        if (split) {
            parent = (state.rumors || []).find(x => x && (String(x.subject || '') === split || subjKey(x) === rumorSubjectKey(split))) || null;
            if (!parent) prev = null;
        }
        if (!parent) {
            const cands = (state.rumors || []).filter(x => x && subjKey(x) === subjKey(n0) && subjKey(n0));
            if (cands.length) {
                prev = cands.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
                let sim = 0;
                try { sim = repairSimilarity(prev.content, n0.content); } catch (e) { sim = 0; }
                const probe = String(n0.content || '').slice(0, 12), hay = String(prev.content || '');
                const near = sim >= 0.34 || (probe.length >= 6 && hay.indexOf(probe) >= 0) || (String(hay).slice(0, 12).length >= 6 && String(n0.content || '').indexOf(String(hay).slice(0, 12)) >= 0);
                if (!near) { parent = prev; prev = null; }   // 说法差异大 → 分裂
            }
        }
        // 全新传言
        if (!parent && !prev) {
            n0.lineage = normalizeRumorLineage({ rootId: n0.id, parentId: '', children: [], generation: 0 }, n0.id);
            n0.chain = normalizeRumorChain([{ at: n0.date || today, kind: '起源', from: n0.source || '', to: n0.subject, note: `首次记录（${n0.objectivity}）：${String(n0.content).slice(0, 60)}` }].concat(n0.chain || []));
            n0.createdAt = Date.now();
            n0.updatedAt = Date.now();
            state.rumors.push(n0);
            return { added: true, item: n0, mode: 'new' };
        }
        // 分裂为新分支
        if (parent) {
            const sameSubject = rumorSubjectKey(parent.subject) === subjKey(n0);
            // 分支键：同一主体下的不同说法各自成支（按说法前 8 字派生）—— 同一说法重复出现则命中同一条（幂等）
            const variant = sameSubject ? ('AI分支·' + String(n0.content || '').replace(/\s+/g, '').slice(0, 8)) : String(n0.subject || '').slice(0, 40);
            const cid = rumorChildId(parent, variant);
            const rootId = (parent.lineage && parent.lineage.rootId) || parent.id;
            const exist = (state.rumors || []).find(x => x && x.id === cid);
            if (exist) {
                const merged = rumorMergeAiInto(exist, n0, raw);
                merged.id = cid;
                merged.lineage = exist.lineage;
                merged.createdAt = exist.createdAt;
                state.rumors[state.rumors.indexOf(exist)] = merged;
                return { updated: true, item: merged, mode: 'branch-update' };
            }
            n0.id = cid;
            n0.subject = parent.subject || n0.subject;    // 主体保持同一个（用户要求）
            n0.lineage = normalizeRumorLineage({ rootId, parentId: parent.id, children: [], generation: (Number(parent.lineage && parent.lineage.generation) || 0) + 1 }, cid);
            n0.chain = normalizeRumorChain([{ at: n0.date || today, kind: '起源', from: parent.subject, to: n0.subject, note: `分裂自「${parent.subject}」（${variant}）` }].concat(n0.chain || []));
            if (!Array.isArray(parent.lineage.children)) parent.lineage.children = [];
            if (parent.lineage.children.indexOf(cid) < 0) parent.lineage.children.push(cid);
            rumorChainPush(parent, { kind: '裂变', to: String(n0.subject), note: `分裂出分支「${variant}」` });
            parent.updatedAt = Date.now();
            n0.createdAt = Date.now();
            n0.updatedAt = Date.now();
            state.rumors.push(n0);
            return { added: true, item: n0, mode: 'branch-new' };
        }
        // 同一主体的演化（更新）：AI 明确给出的字段覆盖，其余保留；集合字段并集；机械字段不动
        const base = rumorMergeAiInto(prev, n0, raw);
        const changed = String(prev.content || '') !== String(base.content || '');
        base.chain = normalizeRumorChain((prev.chain || []).concat([{
            at: base.date || prev.date || today,
            kind: changed ? '异变' : '传播',
            from: '', to: '',
            note: changed ? `说法演变为：${String(base.content).slice(0, 60)}` : '同主体说法再次出现（传播）',
        }]));
        if (changed) base.ferment = Math.min(100, Math.max(Number(prev.ferment) || 0, Number(base.ferment) || 0) + 10);
        base.stage = rumorStageByFerment(base.ferment);
        state.rumors[state.rumors.indexOf(prev)] = base;
        return { updated: true, item: base, mode: changed ? 'evolve' : 'spread' };
    } catch (e) { return null; }
}
// 清空传言（留删除墓碑；仅手动）
function clearRumors() {
    try {
        const list = (state.rumors || []).slice();
        try { tombEntries('rumors', list); } catch (e) { }
        state.rumors = [];
        try { saveState(); } catch (e) { }
        return list.length;
    } catch (e) { return 0; }
}
// v1.192：传言 → 编辑器回填（传播者/载体转为逐行文本；机械演化字段可直接人工修正）（V1 行 23377）
function flattenRumor(item) {
    const it = item || {};
    return {
        subject: it.subject || '',
        content: it.content || '',
        objectivity: it.objectivity || '主观',
        stage: it.stage || '萌芽',
        ferment: Number(it.ferment) || 0,
        carriersText: (Array.isArray(it.carriers) ? it.carriers : [])
            .map(c => `${(c && c.who) || ''}${c && c.role && c.role !== '传播者' ? ':' + c.role : ''}`).filter(Boolean).join('\n'),
        mediaText: (Array.isArray(it.media) ? it.media : [])
            .map(m => [m && m.type, m && m.name, (m && m.at) || '', Number(m && m.durability) || 1].join('|')).join('\n'),
        source: it.source || '',
        date: it.date || '',
        tags: (Array.isArray(it.tags) ? it.tags : []).join(', '),
    };
}

export {
    // —— 配置 / 轮次 / 掷骰 / 日期 ——
    rumorEnabledOn, rumorEveryRounds, rumorNeedRounds, rumorTickState, rumorRoll, rumorStoryDate, rumorDayDiff,
    // —— 链路 / 载体 / 发酵 ——
    rumorChainPush, rumorActiveMediaCount, rumorMediaWeight, mergeRumorListBy, rumorAgeMedia, rumorFermentDelta,
    // —— 平行联动 / 变体 / 变化过程 ——
    rumorParallelLinkScore, rumorParallelLink, rumorVariantFor,
    rumorStartPending, rumorAdvancePending, rumorCommitPending, rumorMaybeStartChange,
    // —— 演化主流程 / 轮次推进 ——
    runRumorEvolve, runRumorEvolveNow, rumorTickAdvance, rumorMarkParallelChange, scheduleRumorEvolve,
    // —— 衰退 ——
    rumorDecayScore, rumorExpired, scheduleRumorDecay, runRumorDecay,
    // —— AI 补写窄契约 / 清空 / 编辑器回填 ——
    rumorAiHas, rumorMergeAiInto, rumorApplyAiDelta, clearRumors, flattenRumor,
};
// 注入行：已在 `core/recall.js` 逐字移植（V1 行 13790），此处 re-export 保持引擎 API 完整，不重复实现
export { rumorInjLine } from './recall.js';
