// ============================================================
// core/repair.js —— **数据修复管线**（B8-6a：第 1 段「JS 机械清理」+ 报告口径）
// 逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`：
//   ① `repairMergeDedupe`（第 1 段 a）：内容哈希并集（`contentDedupeArray`，10 维）
//      + 同名称并集（物品/概念/角色档案/名册，字段只增不减、货币类数量合计）
//      + 场景两级并集（`scenesUnionMergeAll`：同路径 + 相似地名）+ 状态主体「全名/名」归并（`statesSubjectUnionMerge`）；
//   ② `repairPruneGarbage`：空/占位/过短垃圾条目清理（按维度字段与有效字符下限判定）+ 已了结/已揭晓的计划与悬念残留清理，**写墓碑**；
//   ③ `repairDecayPass`：各衰退任务按自身阈值执行（状态衰退 / 记忆遗忘 / 平行事件衰退）+ 每角色状态条数钳制；
//   ④ 频率与上限闸门：`autoRepairOpDue`（每 N 次提取 1 次）/ `bumpRepairOp` / `autoRepairTake`（同楼层哈希至多 N 次；哈希变化或手动修复后重置）；
//   ⑤ 报告口径：`repairReport` / `repairBatchTags` / `repairLogPush`；
//   ⑥ `runRepairMech`（V2 编排入口，等价于 V1 `runAutoRepair` 的**第 1 段**）：机械合并 → 遗忘清扫 → 条数上限兜底 → 垃圾清理 → 衰退清扫；
//      返回与 V1 同形的 `{ stage1, sweep, caps, pruned, decay, makeLog }`，供通知与调试日志复用。
// 说明（本批范围）：V1 的第 2 段（候选筛选 + 相关性/抽查轮询）与第 3 段（窄契约 AI 修订）属 **B8-6b**；
//   本批已把第 1 段与报告口径全部落地，`repair` 动作在 AI 段接入前会**如实说明**「AI 修订段未执行」（不伪造 AI 结果）。
//   同时保留 V1 的 `repairAutoAi`（关闭 = 只做机械清理）语义：该开关关闭时，V1 的行为正是本批所交付的范围。
// 一致性由 tests/unit/repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, getLastMessageId, getStoryNow, timerHooks } from './model/runtime.js';
import { tombMany } from './merge.js';
import { contentDedupeArray } from './migrate.js';
import {
    repairNormText, repairKeyText, repairClampNum, repairSimilarity, scenesUnionMergeAll, statesSubjectUnionMerge,
    runStateDecay, runParallelDecay, applyStateBounds, enforceDimCaps,
} from './ingest.js';
import { runMemoryForget, sweepLowUseForget } from './forget.js';
import { relRepairMaint, relMaintSummary, relMaintCounts, relMaintTouched, logRelMaint, mergeRelMaint } from './rel-maint.js';
import { extractJsonObject } from './util.js';
import { aiCallText, aiBusy } from './ai-hooks.js';
import { PROMPT_TEMPLATES_V2 } from './config.js';

// ---------- 注入钩子（宿主接线：楼层正文哈希） ----------
// 内核不得直接读宿主聊天（`check-core-purity`）：楼层面板哈希经钩子注入，默认返回空串
//   （等价于「无法判定楼层是否变化」→ 每次自动修复都重置计数上限，行为保守）。
let repairHooks = {
    /** 楼层稳定正文哈希（V1 `hashFloorText(i)`；宿主接 `host/floors.js`） */
    floorHash: () => '',
};
/** 注入修复域钩子（与 AI 钩子同一套注入风格；宿主在 `index.js` 接线） */
export function setRepairHooks(next) { repairHooks = Object.assign({}, repairHooks, next || {}); return repairHooks; }

// ---------- 维度规格与判定表（V1 原样） ----------
/** 各维度「正文/名称字段 + 目标字数 + 是否可打标签」（V1 `REPAIR_DIM_SPEC`） */
const REPAIR_DIM_SPEC = {
    atoms: { label: '情节', field: '内容', get: (e) => e.text, set: (e, v) => { e.text = v; }, hard: 'atoms', target: 180, taggable: true },
    memories: { label: '记忆', field: '内容', get: (e) => e.content, set: (e, v) => { e.content = v; }, hard: 'memories', target: 120, taggable: true },
    concepts: { label: '概念', field: '内容', get: (e) => e.content, set: (e, v) => { e.content = v; }, hard: 'concepts', target: 160, taggable: true },
    parallels: { label: '平行事件', field: '内容', get: (e) => e.text, set: (e, v) => { e.text = v; }, hard: 'parallels', target: 336, taggable: true },
    items: { label: '物品', field: '说明', get: (e) => e.desc, set: (e, v) => { e.desc = v; }, hard: 'items', target: 80, taggable: true },
    plans: { label: '计划', field: '内容', get: (e) => e.content, set: (e, v) => { e.content = v; }, hard: 'plans', target: 100, taggable: true },
    suspense: { label: '悬念', field: '内容', get: (e) => e.content, set: (e, v) => { e.content = v; }, hard: 'suspense', target: 100, taggable: true },
    scenes: { label: '场景', field: '描述', get: (e) => e.desc, set: (e, v) => { e.desc = v; }, hard: 'scenes', target: 120, taggable: false },
    currentStates: { label: '状态记录', field: '值', get: (e) => e.value, set: (e, v) => { e.value = v; }, hard: 'states', target: 60, taggable: false },
    npcs: { label: '名册', field: '描述', get: (e) => e.desc, set: (e, v) => { e.desc = v; }, hard: null, target: 60, taggable: true },
};
/** 模糊措辞黑名单（V1 `REPAIR_BANNED`） */
const REPAIR_BANNED = ['尽量', '酌情', '适当', '或许', '大概', '差不多', '等等', '之类', '建议', '视情况', '必要时', '若干'];
/** 空/占位文本（V1 `REPAIR_PLACEHOLDER`） */
const REPAIR_PLACEHOLDER = /^(测试|占位|待填|待补|示例|样本|todo|tbd|xxx+|无|暂无|空|n\/a|-+|—+|\.+)$/i;
const REPAIR_CJK_RE = /[\u4e00-\u9fff]/;
/** 各维度「垃圾判定字段」与有效字符下限（名称类只看名称，正文类看正文） */
const REPAIR_GUARD = {
    atoms: [(e) => e.text, 4], memories: [(e) => e.content, 4], concepts: [(e) => e.content, 4],
    parallels: [(e) => e.text, 4], currentStates: [(e) => e.value, 2],
    items: [(e) => e.name, 2], npcs: [(e) => e.name, 2], scenes: [(e) => e.name || e.desc, 2],
};

/** 名称归并键（V1 `repairNameKey`） */
function repairNameKey(s) { try { return repairNormText(s).replace(/[\s·・.．]/g, '').toLowerCase(); } catch (e) { return ''; } }
/** 垃圾/占位文本判定（空、纯标点、占位词、过短且无实义）；`minKey` = 有效字符下限 */
function repairIsGarbage(text, minKey) {
    const min = Math.max(1, Number(minKey) || 4);
    const t = repairNormText(text);
    if (!t) return true;
    if (REPAIR_PLACEHOLDER.test(t)) return true;
    const key = repairKeyText(t);
    if (!key) return true;                                  // 纯标点/空白
    if (key.length < min) return true;                      // 过短
    if (key.length < 6 && !REPAIR_CJK_RE.test(key)) return true;   // 过短的纯符号/字母串
    return false;
}
/** 条目是否垃圾/占位（V1 `repairGarbageOf`） */
function repairGarbageOf(dim, e) {
    const g = REPAIR_GUARD[dim];
    if (!g) return false;
    try { return repairIsGarbage(g[0](e), g[1]); } catch (err) { return false; }
}
/** 命中的模糊措辞（V1 `repairBannedOf`） */
function repairBannedOf(text) {
    const t = repairNormText(text);
    return REPAIR_BANNED.filter(w => t.indexOf(w) >= 0);
}

// ---------- 第 1 段 a：合并冗余 ----------
/** 内容哈希并集 + 同名称并集 + 场景两级并集 + 状态主体归并（V1 `repairMergeDedupe`） */
function repairMergeDedupe() {
    const st = { merged: 0, notes: [] };
    try {
        const DIMS = ['atoms', 'currentStates', 'memories', 'items', 'scenes', 'concepts', 'parallels', 'plans', 'suspense', 'snapshots'];
        for (const dim of DIMS) {
            const arr = state[dim];
            if (!Array.isArray(arr) || arr.length < 2) continue;
            const before = arr.length;
            const out = contentDedupeArray(dim, arr);
            if (out.length < before) {
                state[dim] = out;
                st.merged += before - out.length;
                st.notes.push(`${dim}-同内容 ${before - out.length}`);
            }
        }
        // 同名称并集（物品/概念/角色档案/名册）：同名称只留一条，字段并集
        st.merged += repairMergeByName('items', (e) => e.name);
        st.merged += repairMergeByName('concepts', (e) => e.name);
        st.merged += repairMergeByName('snapshots', (e) => e.name);
        st.merged += repairMergeByName('npcs', (e) => e.name);
        // 场景：同路径精确并集 + 相似地名（纽约/纽约市）归并
        try { const n = scenesUnionMergeAll(); if (n > 0) { st.merged += n; st.notes.push(`scenes-并集 ${n}`); } } catch (e) { /* 忽略 */ }
        // 状态主体：同一角色「全名 / 名」两组 → 归并为一条主体
        try { const n = statesSubjectUnionMerge(); if (n > 0) { st.merged += n; st.notes.push(`states-主体归并 ${n}`); } } catch (e) { /* 忽略 */ }
    } catch (e) { /* 忽略 */ }
    return st;
}
/** 同名称并集：保留字段更全/更晚的一条，把另一条的非空字段补齐进来（只增不减，绝不丢信息） */
function repairMergeByName(dim, keyFn) {
    let merged = 0;
    try {
        const arr = state[dim];
        if (!Array.isArray(arr) || arr.length < 2) return 0;
        const byKey = new Map();
        const out = [];
        for (const it of arr) {
            if (!it || typeof it !== 'object') { out.push(it); continue; }
            const k = repairNameKey(keyFn(it));
            if (!k) { out.push(it); continue; }
            const ex = byKey.get(k);
            if (!ex) { byKey.set(k, it); out.push(it); continue; }
            // 合并进 ex：非空字段补齐；数组取并集；数量：货币类合计，其余取较大；uses 累计；楼层区间并集
            for (const key of Object.keys(it)) {
                if (key === 'id') continue;
                const a = ex[key], b = it[key];
                if (Array.isArray(a) || Array.isArray(b)) {
                    const set = [];
                    for (const v of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) if (set.indexOf(v) < 0) set.push(v);
                    ex[key] = set;
                } else if (b !== undefined && b !== null && String(b).trim() !== '' && (a === undefined || a === null || String(a).trim() === '')) {
                    ex[key] = b;
                }
            }
            if (dim === 'items') {
                const cur = String(ex.name || '');
                const money = /[币钱]|银两|铜钱|金票|银票/.test(cur);
                const qa = Number(ex.qty) || 0, qb = Number(it.qty) || 0;
                if (money) ex.qty = qa + qb; else ex.qty = Math.max(qa, qb) || ex.qty;
            }
            ex.floorStart = Math.min(Number(ex.floorStart) || 0, Number(it.floorStart) || 0) || (Number(ex.floorStart) || 0);
            ex.floorEnd = Math.max(Number(ex.floorEnd) || 0, Number(it.floorEnd) || 0);
            ex.uses = (Number(ex.uses) || 0) + (Number(it.uses) || 0);
            merged++;
        }
        if (merged > 0) state[dim] = out;
    } catch (e) { /* 忽略 */ }
    return merged;
}

// ---------- 第 1 段 b：删除衰退/无效 ----------
/** 各衰退任务按自身阈值执行 + 每角色状态钳制（V1 `repairDecayPass`） */
async function repairDecayPass() {
    const out = { deleted: 0, notes: [] };
    try {
        const r1 = await runStateDecay({}); if (r1 && r1.removed) { out.deleted += r1.removed; out.notes.push(`状态衰退 ${r1.removed}`); }
        const r2 = await runMemoryForget({}); if (r2 && r2.removed) { out.deleted += r2.removed; out.notes.push(`记忆遗忘 ${r2.removed}`); }
        const r3 = await runParallelDecay({}); if (r3 && r3.removed) { out.deleted += r3.removed; out.notes.push(`平行衰退 ${r3.removed}`); }
        const r4 = applyStateBounds(); const cut = Number(r4 && r4.cut) || 0; if (cut) { out.deleted += cut; out.notes.push(`状态条数钳制 ${cut}`); }
    } catch (e) { /* 忽略 */ }
    return out;
}
/** 空/占位/过短垃圾条目清理 + 已了结/已揭晓的计划与悬念残留清理（V1 `repairPruneGarbage`） */
function repairPruneGarbage() {
    const out = { deleted: 0, notes: [] };
    try {
        const SPEC = ['atoms', 'memories', 'concepts', 'parallels', 'scenes', 'npcs', 'items', 'currentStates'];
        for (const dim of SPEC) {
            const arr = state[dim];
            if (!Array.isArray(arr) || !arr.length) continue;
            const doomed = arr.filter(e => repairGarbageOf(dim, e));
            if (!doomed.length) continue;
            try { tombMany(dim, doomed.map(e => e && e.id)); } catch (e) { /* 忽略 */ }
            state[dim] = arr.filter(e => doomed.indexOf(e) < 0);
            out.deleted += doomed.length;
            out.notes.push(`${dim}-垃圾清理 ${doomed.length}`);
        }
        // 已了结/已揭晓但原文残留的计划与悬念 → 清理（关闭时应只留统计）
        for (const dim of ['plans', 'suspense']) {
            const arr = state[dim];
            if (!Array.isArray(arr) || !arr.length) continue;
            const closed = arr.filter(e => e && e.status && e.status !== 'open');
            if (!closed.length) continue;
            try { tombMany(dim, closed.map(e => e && e.id)); } catch (e) { /* 忽略 */ }
            state[dim] = arr.filter(e => closed.indexOf(e) < 0);
            out.deleted += closed.length;
            out.notes.push(`${dim}-已关闭残留 ${closed.length}`);
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

// ---------- 频率与上限闸门 ----------
/** 最新楼层哈希（V1 `latestFloorHash`：同楼层内容未变 → 自动修复次数上限判据） */
function latestFloorHash() {
    try {
        const i = Number(getLastMessageId());
        if (!(i >= 0)) return '(none)';
        let h = '';
        try { h = String(repairHooks.floorHash(i) || ''); } catch (e) { h = ''; }
        return h || '(empty)';
    } catch (e) { return '(none)'; }
}
/** 频率闸门：每 N 次「提取记忆」才允许一次自动修复（0 = 不限制） */
function autoRepairOpDue() {
    try {
        const N = Math.max(0, Number(cfg && cfg.autoRepairEveryOps) || 0);
        if (!N) return true;
        const a = (state.autoRepair && typeof state.autoRepair === 'object') ? state.autoRepair : {};
        return (Number(a.ops) || 0) - (Number(a.lastAt) || 0) >= N;
    } catch (e) { return true; }
}
/** 记录一次「提取记忆/摘要」完成（频率闸门计数） */
function bumpRepairOp() {
    try {
        const a = (state.autoRepair && typeof state.autoRepair === 'object') ? state.autoRepair : {};
        a.ops = (Number(a.ops) || 0) + 1;
        state.autoRepair = a;
    } catch (e) { /* 忽略 */ }
}
/** 自动修复次数上限（同楼层哈希未变至多 `cfg.maxAutoRepairRounds` 次；哈希变化或手动修复后重置） */
function autoRepairTake(forceReset) {
    try {
        const max = Math.max(1, Number(cfg.maxAutoRepairRounds) || 3);
        const h = latestFloorHash();
        const cur = (state.autoRepair && typeof state.autoRepair === 'object') ? state.autoRepair : {};
        if (forceReset || h !== cur.hash) { cur.hash = h; cur.n = 0; }
        cur.n = Number(cur.n) || 0;
        if (!forceReset && cur.n >= max) return { allowed: false, n: cur.n, max };
        if (!forceReset) cur.n += 1;
        state.autoRepair = cur;
        try { saveState(); } catch (e) { /* 忽略 */ }
        return { allowed: true, n: cur.n, max };
    } catch (e) { return { allowed: true, n: 1, max: 3 }; }
}

// ---------- 报告口径 ----------
/** 本轮提交的标签（去重、上限 12） */
function repairBatchTags(entries) {
    const out = [];
    try {
        for (const e of (Array.isArray(entries) ? entries : [])) {
            for (const x of (Array.isArray(e && e.tags) ? e.tags : [])) {
                const v = repairNormText(x).replace(/^#/, '');
                if (v && out.indexOf(v) < 0) out.push(v);
                if (out.length >= 12) return out;
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}
/** 修复统计统一口径（V1 `repairReport`）：修复前 → 提交 X/Y → 修复后 合并·修订·删除… */
function repairReport(o) {
    try {
        const s = [];
        const before = (o && o.before !== undefined) ? o.before : null;
        const after = (o && o.after !== undefined) ? o.after : null;
        s.push(`修复前 ${before !== null ? before : '?'} 条 → 修复后 ${after !== null ? after : '?'} 条`);
        if (o && (o.groups !== undefined || o.checked !== undefined)) {
            const bits = [];
            if (o.checked !== undefined) bits.push(`${o.checked} 条`);
            if (o.groups !== undefined) bits.push(`${o.groups} 组`);
            if (o.groupsTotal !== undefined) bits.push(`共 ${o.groupsTotal} 组`);
            if (o.defects) bits.push(`缺陷条目 ${o.defects}`);
            s.push(`本轮提交 ${bits.join(' / ')}`);
        }
        const tags = (o && Array.isArray(o.submittedTags)) ? o.submittedTags : [];
        if (tags.length) s.push(`提交标签 #${tags.join(' #')}`);
        const names = (o && Array.isArray(o.submittedNames)) ? o.submittedNames : [];
        if (names.length) s.push(`提交对象 ${names.slice(0, 8).join('、')}${names.length > 8 ? ` 等 ${names.length} 个` : ''}`);
        const ch = [];
        if (o && o.fused) ch.push(`合并 ${o.fused} 组(-${o.removed || 0} 条)`);
        if (o && o.revised) ch.push(`修订 ${o.revised} 条`);
        if (o && o.deleted) ch.push(`删除 ${o.deleted} 条`);
        if (o && o.merged) ch.push(`机械去重 ${o.merged} 条`);
        if (o && o.purged) ch.push(`低调用清理 ${o.purged} 条`);
        if (o && o.swept) ch.push(`遗忘清扫 ${o.swept} 条`);
        if (o && o.rolesChanged) ch.push(`补全 ${o.rolesChanged} 名/${o.changed || 0} 字段`);
        s.push(ch.length ? `修复后 ${ch.join(' · ')}` : '修复后 无改动');
        if (o && o.skipped) s.push(`跳过 ${o.skipped} 条`);
        if (o && o.queueLeft !== undefined) s.push(`本轮剩余待修 ${o.queueLeft} 条`);
        if (o && o.extra) s.push(String(o.extra));
        return s.join('；');
    } catch (e) { return ''; }
}
/** 修复记录（最近 5 条 → `state.repairLog`，供总览/设定页展示） */
function repairLogPush(rec) {
    try {
        const arr = Array.isArray(state.repairLog) ? state.repairLog.slice() : [];
        arr.unshift(Object.assign({ ts: Date.now() }, rec || {}));
        state.repairLog = arr.slice(0, 5);
        return state.repairLog.length;
    } catch (e) { return 0; }
}
/** 总数据量（修复前后计数用） */
function repairTotalCount() {
    try {
        const DIMS = ['atoms', 'currentStates', 'memories', 'items', 'scenes', 'concepts', 'parallels', 'plans', 'suspense', 'snapshots'];
        let n = 0;
        for (const d of DIMS) n += Array.isArray(state[d]) ? state[d].length : 0;
        return n;
    } catch (e) { return 0; }
}
/** 用户提示（经宿主钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/**
 * 第 1 段：JS 机械清理（零 AI、确定性）—— V1 `runAutoRepair` 的第 1 段逐行等价。
 * @param {object} [opts] silent（不提示）
 * @returns {Promise<{before:number, after:number, stage1:object, sweep:object, caps:object, pruned:object, decay:object, report:string, fixed:number}>}
 */
async function runRepairMech(opts) {
    const o = opts || {};
    const t0 = Date.now();
    const before = repairTotalCount();
    const m1 = repairMergeDedupe();
    let sweepRes = { swept: 0, dims: {}, skipped: [] };
    try { sweepRes = sweepLowUseForget(); } catch (e) { /* 忽略 */ }
    let capRes = { cut: 0, dims: {} };
    try { capRes = enforceDimCaps(); } catch (e) { /* 忽略 */ }
    if (m1.merged > 0 || sweepRes.swept > 0 || capRes.cut > 0) { try { saveState(); } catch (e) { /* 忽略 */ } }
    let pruned = { deleted: 0, notes: [] };
    try { pruned = repairPruneGarbage(); if (pruned.deleted > 0) { try { saveState(); } catch (e) { /* 忽略 */ } } } catch (e) { /* 忽略 */ }
    let decay = { deleted: 0, notes: [] };
    try { decay = await repairDecayPass(); } catch (e) { /* 忽略 */ }
    // v1.168：关系层机械维护（零 AI）—— 与修复联动：始终清理孤儿关联行（写墓碑）+ 去重 / 角色名归一 / 悬空引用清理 /
    //   how·偏差归一；孤儿条目按 `cfg.relOrphanAction` 处置（默认 keep 只提示）—— V1 在第 1 段收尾处调用。
    const stage1 = { merged: m1.merged, deleted: pruned.deleted + decay.deleted, notes: m1.notes.concat(pruned.notes, decay.notes) };
    let relMaint = null;
    try {
        relMaint = relRepairMaint();
        if (relMaint && relMaint.changed) {
            try { saveState(); } catch (e) { /* 忽略 */ }
            const txt = relMaintSummary(relMaint);
            if (txt) stage1.notes.push(txt.replace(/^（关联维护：/, '关联维护：').replace(/）$/, ''));
        } else if (relMaint && relMaint.orphanItems) {
            stage1.notes.push(`关联维护：无孤儿关联需清理；${relMaint.orphanItems} 条无关联条目按「${relMaint.action}」处置（可在「记忆 → 关系表」查看）`);
        }
        logRelMaint('立即修复', relMaint);
    } catch (e) { /* 忽略 */ }
    stage1.relMaint = relMaint;
    const after = repairTotalCount();
    const swept = Number(sweepRes.swept) || 0;
    const cut = Number(capRes.cut) || 0;
    const fixed = stage1.merged + swept + cut;
    const report = repairReport({
        before, after,
        merged: stage1.merged, deleted: stage1.deleted, swept, extra: stage1.notes.slice(0, 6).join(' · '),
    });
    try {
        repairLogPush({
            auto: o.silent === true, cause: String(o.cause || '手动'), merged: stage1.merged, deleted: stage1.deleted,
            swept, cut, total: before, ms: Date.now() - t0, extra: stage1.notes.slice(0, 6).join(' · '),
        });
    } catch (e) { /* 忽略 */ }
    try {
        dbgLog('修复', { action: '第 1 段 机械清理（零 AI）', before, after, merged: stage1.merged, deleted: stage1.deleted, swept, cut, notes: stage1.notes, ms: Date.now() - t0 });
    } catch (e) { /* 忽略 */ }
    if (o.silent !== true) {
        notify('success', '机械清理完成（零 AI）',
            `机械去重 ${stage1.merged} 条 · 垃圾/残留清理 ${stage1.deleted} 条 · 遗忘清扫 ${swept} 条 · 条数裁剪 ${cut} 条；${report}`);
    }
    return { before, after, stage1, sweep: sweepRes, caps: capRes, pruned, decay, relMaint, report, fixed, ms: Date.now() - t0 };
}

// ==================== 第 2 段：候选筛选（客观缺陷 + 标签组相关性 + 按比例抽查轮询） ====================
/** 修订允许写入的字段（按维度；标题类字段各维度通用）—— V1 `REPAIR_FIELD_KEYS` */
const REPAIR_FIELD_KEYS = { '内容': 'main', '值': 'main', '说明': 'main', '描述': 'main', '标题': 'title', '标签': 'tags' };
/** 单维度两两比较规模上限与超规模时的随机样本数（V1 常量） */
const REPAIR_CORR_MAX_N = 400;
const REPAIR_CORR_SAMPLE = 120;
/** 修复日志上限（V1 `REPAIR_LOG_MAX`） */
const REPAIR_LOG_MAX = 5;

function repairRand(n) { try { return Math.floor(Math.random() * Math.max(1, n)); } catch (e) { return 0; } }
/** 标签集合（去 # 前缀、小写、去重） */
function repairTagSetOf(e) {
    const t = Array.isArray(e && e.tags) ? e.tags : [];
    const out = [];
    for (const x of t) {
        const k = repairNormText(x).replace(/^#/, '').toLowerCase();
        if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
}
/** 标签组 Jaccard 相似度 */
function repairJaccard(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    let hit = 0;
    for (const x of a) if (b.indexOf(x) >= 0) hit++;
    return hit / (a.length + b.length - hit);
}
/** 同维度相关性：每条 = 与同维度其他条目的最大相似度（0~1）+ 判定基数（tags/text） */
function repairCorrelationMap(dim, arr) {
    const n = arr.length;
    const spec = REPAIR_DIM_SPEC[dim] || {};
    const tagSets = arr.map(e => repairTagSetOf(e));
    const texts = arr.map(e => repairNormText(spec.get ? spec.get(e) : ''));
    const tagRich = tagSets.filter(s => s.length >= 2).length >= Math.max(2, Math.floor(n * 0.3));
    const sims = new Array(n).fill(0);
    const basis = new Array(n).fill(tagRich ? 'tags' : 'text');
    const full = n <= REPAIR_CORR_MAX_N;
    for (let i = 0; i < n; i++) {
        const useTags = tagRich && tagSets[i].length >= 2;
        const lim = full ? n : Math.min(n, REPAIR_CORR_SAMPLE);
        let best = 0;
        for (let k = 0; k < lim; k++) {
            const j = full ? k : repairRand(n);
            if (j === i) continue;
            const v = useTags ? repairJaccard(tagSets[i], tagSets[j]) : repairSimilarity(texts[i], texts[j]);
            if (v > best) best = v;
        }
        sims[i] = Number(best.toFixed(3));
        basis[i] = useTags ? 'tags' : 'text';
    }
    return { sims, basis, tagRich, approx: !full };
}
/** 客观缺陷（与相关性无关，一律列入）：垃圾/超字数/模糊措辞/裸问句/日期与标签格式 */
function repairDefectOf(dim, e) {
    const spec = REPAIR_DIM_SPEC[dim] || {};
    const text = repairNormText(spec.get ? spec.get(e) : '');
    const tags = Array.isArray(e && e.tags) ? e.tags : [];
    const date = String((e && e.date) || '').trim();
    if (repairGarbageOf(dim, e)) return { rank: 0, label: '空占位/无意义文本' };
    if (text.length > spec.target) return { rank: 2, label: `超出该维度目标字数（≤${spec.target} 字，现 ${text.length} 字）` };
    const bad = repairBannedOf(text);
    if (bad.length) return { rank: 3, label: `含模糊措辞（${bad.slice(0, 3).join('/')}）` };
    if ((dim === 'plans' || dim === 'suspense') && /[？?]\s*$/.test(text)) return { rank: 4, label: '计划/悬念写成裸问句（需含主体 + 事实锚点）' };
    if (date && !/^-?\d{1,4}-\d{2}-\d{2}$/.test(date)) return { rank: 5, label: `日期格式不合规（应为 YYYY-MM-DD 或公元前 -YYYY-MM-DD，现「${date.slice(0, 16)}」）` };
    if (spec.taggable && (tags.length < 3 || tags.length > 5)) return { rank: 5, label: `标签数量不合规（需 3-5 个，现 ${tags.length} 个）` };
    return null;
}
/**
 * 候选筛选（V1 `repairCollectCandidates`）：客观缺陷一律列入 → 高相关优先核对 → 中间带按比例抽查（轮询游标 + 随机步长）
 *   → 候选不足时用中间带按相关性补足（绝不用低相关孤例凑数）。
 * @param {number} limit 本轮上限（`cfg.repairMaxItems`）
 * @param {object} [stat] 统计出参（total/defects/corrHigh/sampled/topped/corrLowSkipped/cursors）
 */
function repairCollectCandidates(limit, stat) {
    const max = Math.max(1, Number(limit) || Number(cfg && cfg.repairMaxItems) || 20);
    const hi = repairClampNum(cfg && cfg.repairTagSimHigh, 0.05, 0.95, 0.5);
    const lo = repairClampNum(cfg && cfg.repairTagSimLow, 0, Math.max(0.05, hi - 0.05), 0.15);
    const ratio = repairClampNum(cfg && cfg.repairSampleRatio, 0.02, 1, 0.2);
    const minC = Math.max(1, Number((cfg && cfg.repairMinCandidates)) || 5);
    const st = Object.assign({ total: 0, corrHigh: 0, corrLowSkipped: 0, sampled: 0, defects: 0, topped: 0, cursors: {} }, stat || {});
    const cands = [];
    try {
        const cursors = Object.assign({}, (state.repairCursor && typeof state.repairCursor === 'object') ? state.repairCursor : {});
        for (const dim of Object.keys(REPAIR_DIM_SPEC)) {
            const spec = REPAIR_DIM_SPEC[dim];
            const arr = state[dim];
            if (!Array.isArray(arr) || !arr.length) continue;
            st.total += arr.length;
            const corr = repairCorrelationMap(dim, arr);
            const rows = [];
            arr.forEach((e, i) => {
                if (!e) return;
                const text = repairNormText(spec.get(e));
                const defect = repairDefectOf(dim, e);
                const sim = Number(corr.sims[i]) || 0;
                rows.push({ dim, dimLabel: spec.label, dimKey: dim, i, id: e.id, field: spec.field, text, title: repairNormText(e.title || e.name || ''), target: spec.target, tags: Array.isArray(e.tags) ? e.tags : [], sim, basis: corr.basis[i], defect });
            });
            const defects = rows.filter(r => r.defect);
            st.defects += defects.length;
            const highs = rows.filter(r => !r.defect && r.sim >= hi);
            st.corrHigh += highs.length;
            const middle = rows.filter(r => !r.defect && r.sim > lo && r.sim < hi);
            const lowRows = rows.filter(r => !r.defect && r.sim <= lo);
            st.corrLowSkipped += lowRows.length;
            let sampledRows = [];
            if (middle.length) {
                const sampleN = Math.max(1, Math.round(middle.length * ratio));
                const cur = Math.abs(Number(cursors[dim]) || 0) % middle.length;
                const stride = 1 + repairRand(Math.max(1, Math.floor(middle.length / 3)));
                const chosen = new Set();
                for (let k = 0; k < sampleN; k++) chosen.add((cur + k * stride) % middle.length);
                sampledRows = Array.from(chosen).map(idx => middle[idx]).filter(Boolean);
                cursors[dim] = (cur + sampleN * stride) % middle.length;
                st.sampled += sampledRows.length;
            }
            for (const r of defects) cands.push(Object.assign({}, r, { why: '缺陷', rank: r.defect.rank, label: r.defect.label }));
            for (const r of highs) cands.push(Object.assign({}, r, {
                why: '高相关', rank: 1,
                label: `与同维度条目高度相关（${r.basis === 'tags' ? '标签组' : '正文'}相似度 ${r.sim.toFixed(2)}）→ 重点核对是否重复`,
            }));
            for (const r of sampledRows) cands.push(Object.assign({}, r, {
                why: '抽查', rank: 6,
                label: `按比例抽查核对（相似度 ${r.sim.toFixed(2)}${r.basis === 'tags' ? '·标签组' : '·正文'}）`,
            }));
            const topUpTarget = Math.max(1, Math.min(minC, arr.length));
            if (arr.length >= Math.max(3, minC) && cands.filter(c => c.dimKey === dim).length < topUpTarget) {
                const rest = middle.filter(r => sampledRows.indexOf(r) < 0 && highs.indexOf(r) < 0).sort((a, b) => b.sim - a.sim);
                for (const r of rest) {
                    if (cands.filter(c => c.dimKey === dim).length >= topUpTarget) break;
                    cands.push(Object.assign({}, r, { why: '补足', rank: 6, label: `补足候选（相似度 ${r.sim.toFixed(2)}）` }));
                    st.topped++;
                }
            }
        }
        cands.sort((a, b) => (a.rank - b.rank) || (b.sim - a.sim) || (String(b.text).length - String(a.text).length));
        const out = cands.slice(0, max);
        out.forEach((c, i) => { c.n = i + 1; });
        st.cursors = cursors;
        try { state.repairCursor = cursors; } catch (e) { /* 忽略 */ }
        if (stat && typeof stat === 'object') Object.assign(stat, st);
        return out;
    } catch (e) { return []; }
}

// ==================== 第 3 段：窄契约 AI 修订 ====================
/** 窄契约提示词（V1 `buildRepairPrompt`）：只含候选清单，不含全库与整段正文 */
function buildRepairPrompt(candsIn) {
    const cands = Array.isArray(candsIn) ? candsIn : repairCollectCandidates(cfg && cfg.repairMaxItems);
    if (!cands.length) return null;
    const pt = cfg.promptTemplates || {};
    const guide = String(pt.repair || (PROMPT_TEMPLATES_V2 && PROMPT_TEMPLATES_V2.repair) || '').trim();
    const lines = cands.map(c => `#${c.n} ｜ ${c.dimLabel} ｜ 字段「${c.field}」${c.title ? ` ｜ 标题「${c.title}」` : ''} ｜ 目标 ≤${c.target} 字 ｜ 相关度 ${(Number(c.sim) || 0).toFixed(2)} ｜ 来源：${c.why || '抽查'} ｜ 问题：${c.label}\n   现有文本：${String(c.text).slice(0, 400)}`);
    const storyNote = getStoryNow() ? `当前剧情日期：${getStoryNow()}。` : '';
    return [
        { role: 'system', content: `${guide}\n只输出 JSON，不要解释文字。` },
        { role: 'user', content: `【待修订清单（本次唯一工作对象，共 ${cands.length} 条；「相关度」= 与同维度其他条目的标签组/正文相似度，越高越可能重复）】${storyNote}\n${lines.join('\n')}\n\n输出：{"修订":[{"编号":1,"字段":"内容","值":"改写后的完整文本"}],"删除":[2,5]}（只输出需要改动的编号；没有需要改的就输出 {"修订":[],"删除":[]}）。` },
    ];
}
/** 按编号精确应用（V1 `repairApplyAiResult`）：禁止新增；逐条校验维度/字段/字数/闭集 */
function repairApplyAiResult(delta, cands) {
    const out = { revised: 0, deleted: 0, skipped: 0 };
    try {
        const list = Array.isArray(cands) ? cands : [];
        if (!delta || typeof delta !== 'object') return out;
        const byN = new Map();
        list.forEach(c => byN.set(Number(c.n), c));
        const hardCap = (dimKey) => {
            const spec = REPAIR_DIM_SPEC[dimKey];
            const k = spec && spec.hard;
            const v = Number((cfg && cfg.dimCharLimits && cfg.dimCharLimits[k]) || 0);
            return v > 0 ? v : (spec ? spec.target : 300);
        };
        const findEntry = (dim, id) => {
            const arr = state[dim];
            if (!Array.isArray(arr)) return null;
            return arr.find(e => e && String(e.id) === String(id)) || null;
        };
        const delIds = [];
        const delRaw = Array.isArray(delta['删除']) ? delta['删除'] : (Array.isArray(delta.remove) ? delta.remove : []);
        for (const raw of delRaw) {
            const n = Number(String(raw).replace(/[^0-9]/g, ''));
            const c = byN.get(n);
            if (!c) { out.skipped++; continue; }
            const ent = findEntry(c.dim, c.id);
            if (!ent) { out.skipped++; continue; }
            delIds.push({ dim: c.dim, id: c.id });
        }
        if (delIds.length) {
            for (const d of delIds) {
                try { tombMany(d.dim, [d.id]); } catch (e) { /* 忽略 */ }
                const arr = state[d.dim] || [];
                state[d.dim] = arr.filter(e => !(e && String(e.id) === String(d.id)));
                out.deleted++;
            }
        }
        const revRaw = Array.isArray(delta['修订']) ? delta['修订'] : (Array.isArray(delta.revise) ? delta.revise : []);
        for (const r of revRaw) {
            try {
                if (!r || typeof r !== 'object') { out.skipped++; continue; }
                const n = Number(String(r['编号'] !== undefined ? r['编号'] : r.n).replace(/[^0-9]/g, ''));
                const c = byN.get(n);
                if (!c) { out.skipped++; continue; }
                const field = String(r['字段'] !== undefined ? r['字段'] : (r.field || c.field)).trim();
                const kind = REPAIR_FIELD_KEYS[field];
                if (!kind) { out.skipped++; continue; }
                const ent = findEntry(c.dim, c.id);
                if (!ent) { out.skipped++; continue; }
                const spec = REPAIR_DIM_SPEC[c.dim];
                if (!spec) { out.skipped++; continue; }
                if (kind === 'main') {
                    let v = repairNormText(r['值'] !== undefined ? r['值'] : r.value);
                    if (!v) { out.skipped++; continue; }
                    const cap = hardCap(c.dim);
                    if (v.length > cap) v = v.slice(0, cap);
                    if (repairIsGarbage(v, 4)) { out.skipped++; continue; }
                    spec.set(ent, v);
                    out.revised++;
                } else if (kind === 'title') {
                    const v = repairNormText(r['值'] !== undefined ? r['值'] : r.value).slice(0, 40);
                    if (!v) { out.skipped++; continue; }
                    ent.title = v;
                    out.revised++;
                } else if (kind === 'tags') {
                    let arr = r['值'] !== undefined ? r['值'] : r.value;
                    if (typeof arr === 'string') arr = arr.split(/[，,、#\s]+/);
                    if (!Array.isArray(arr)) { out.skipped++; continue; }
                    const tags = arr.map(x => repairNormText(x).replace(/^#/, '')).filter(Boolean).slice(0, 5);
                    if (tags.length < 3) { out.skipped++; continue; }
                    ent.tags = tags;
                    ent.keywords = [];
                    out.revised++;
                }
            } catch (e) { out.skipped++; }
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 三段式修复（V1 `runAutoRepair` 的精简编排）：① 机械清理 → ② 候选筛选 → ③ 窄契约 AI 修订。
 * @param {object} [opts] silent / cause / aiText（显式 AI 返回，测试用）/ force（跳过频率与上限闸门）
 */
async function runRepair(opts) {
    const o = opts || {};
    const isAuto = o.silent === true && !!o.cause;
    if (aiBusy()) {
        if (o.silent !== true || o.cause) notify('warning', isAuto ? '自动修复被占用，已跳过' : '修复进行中', '已有修复/摘要/同步任务在运行，请稍候。');
        return { made: 0, blocked: true };
    }
    if (isAuto && !o.force && !autoRepairOpDue()) return { made: 0, blocked: true, reason: 'auto-repair-frequency' };
    if (o.force !== true) {
        const tk = o.silent === true ? autoRepairTake(false) : autoRepairTake(true);
        if (!tk.allowed) {
            if (isAuto) notify('warning', '自动修复已达上限，本次跳过', `同楼层内容未变已自动修复 ${tk.n}/${tk.max} 次；内容变化或手动修复后重置。`);
            return { made: 0, blocked: true, reason: 'auto-repair-limit(' + tk.n + '/' + tk.max + ')' };
        }
    }
    const t0 = Date.now();
    // ① 机械清理
    const mech = await runRepairMech({ silent: true, cause: o.cause });
    const stage1 = mech.stage1;
    // ② 候选筛选
    let cands = [];
    const pickStat = {};
    try { cands = repairCollectCandidates(cfg && cfg.repairMaxItems, pickStat); } catch (e) { /* 忽略 */ }
    try {
        dbgLog('修复', {
            action: '修复候选筛选（v1.138 相关性+抽查）',
            条目总数: pickStat.total || 0, 客观缺陷: pickStat.defects || 0, 高相关: pickStat.corrHigh || 0,
            抽查: pickStat.sampled || 0, 补足: pickStat.topped || 0, 低相关跳过: pickStat.corrLowSkipped || 0,
            进入候选: cands.length,
        });
    } catch (e) { /* 忽略 */ }
    // ③ AI 窄契约修订（最多 1 次请求；自动模式可用 repairAutoAi 关闭）
    const ai = { revised: 0, deleted: 0, skipped: 0, used: false, error: '' };
    const aiAllowed = cands.length > 0 && (!isAuto || cfg.repairAutoAi !== false);
    if (aiAllowed) {
        try {
            const prompt = buildRepairPrompt(cands);
            if (prompt) {
                ai.used = true;
                const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '修复'));
                const delta = resp ? extractJsonObject(resp) : null;
                if (delta) {
                    const r = repairApplyAiResult(delta, cands);
                    ai.revised = r.revised; ai.deleted = r.deleted; ai.skipped = r.skipped;
                    if (ai.revised > 0 || ai.deleted > 0) { try { saveState(); } catch (e) { /* 忽略 */ } }
                } else { ai.error = 'AI 未返回有效 JSON'; }
            }
        } catch (e) {
            ai.error = String((e && e.message) || e).slice(0, 80);
        }
    }
    // ③-b v1.168：AI 合并 / 删除之后**再跑一次**关系层机械维护（AI 可能产生新的孤儿行与悬空引用）——
    //   V1 在「记忆修复」AI 之后调用 `relRepairMaint()`，并以 `mergeRelMaint(前, 后)` 合并两次口径。
    let relMaint = (stage1 && stage1.relMaint) || null;
    if (ai.revised > 0 || ai.deleted > 0) {
        let relMaint2 = null;
        try { relMaint2 = relRepairMaint(); } catch (e) { /* 忽略 */ }
        if (relMaint2 && relMaint2.changed) relMaint = mergeRelMaint(relMaint, relMaint2);
        try { logRelMaint('修复（AI 后）', relMaint2); } catch (e) { /* 忽略 */ }
        try {
            const txt = relMaintSummary(relMaint);
            if (txt && relMaintTouched(relMaint)) stage1.notes.push(txt.replace(/^（关联维护：/, '关联维护：').replace(/）$/, ''));
        } catch (e) { /* 忽略 */ }
    }
    const relCounts = relMaintCounts(relMaint);
    const made = stage1.merged + stage1.deleted + ai.revised + ai.deleted;
    const ms = Date.now() - t0;
    try {
        repairLogPush({
            auto: isAuto, cause: String(o.cause || ''), merged: stage1.merged, deleted: stage1.deleted,
            revised: ai.revised, aiDeleted: ai.deleted, candidates: cands.length, aiUsed: ai.used, skipped: ai.skipped, ms,
            total: pickStat.total || 0, defects: pickStat.defects || 0, corrHigh: pickStat.corrHigh || 0,
            sampled: pickStat.sampled || 0, topped: pickStat.topped || 0, lowSkipped: pickStat.corrLowSkipped || 0,
            notes: stage1.notes.slice(0, 8),
        });
    } catch (e) { /* 忽略 */ }
    try { saveState(); } catch (e) { /* 忽略 */ }
    const report = repairReport({
        before: mech.before, after: mech.after,
        checked: cands.length, groups: pickStat.defects || 0, groupsTotal: pickStat.total || 0, defects: pickStat.defects || 0,
        submittedTags: repairBatchTags(cands), merged: stage1.merged, deleted: stage1.deleted,
        revised: ai.revised, skipped: ai.skipped, swept: Number((mech.sweep || {}).swept) || 0,
        extra: stage1.notes.slice(0, 6).join(' · '),
    });
    try {
        dbgLog('修复', {
            action: '数据修复完成（v1.137 三段式 · v1.138 相关性抽查）', auto: isAuto, cause: String(o.cause || '').slice(0, 40),
            merged: stage1.merged, deleted: stage1.deleted, revised: ai.revised, aiDeleted: ai.deleted,
            candidates: cands.length, aiUsed: ai.used, aiSkipped: ai.skipped, ms,
            total: pickStat.total || 0, defects: pickStat.defects || 0, corrHigh: pickStat.corrHigh || 0,
            sampled: pickStat.sampled || 0, topped: pickStat.topped || 0,
            notes: stage1.notes.slice(0, 10), aiError: ai.error || undefined,
            entries: repairTotalCount(),
        });
    } catch (e) { /* 忽略 */ }
    if (o.silent !== true) {
        notify(ai.revised || ai.deleted ? 'success' : 'info', isAuto ? '自动修复完成' : '修复完成',
            `机械清理：合并 ${stage1.merged} · 清理 ${stage1.deleted} · 遗忘清扫 ${Number((mech.sweep || {}).swept) || 0} · 条数裁剪 ${Number((mech.caps || {}).cut) || 0}；`
            + `候选 ${cands.length} 条（缺陷 ${pickStat.defects || 0} · 高相关 ${pickStat.corrHigh || 0} · 抽查 ${pickStat.sampled || 0} · 补足 ${pickStat.topped || 0}）；`
            + (ai.used ? `AI 修订 ${ai.revised} 条 · 删除 ${ai.deleted} 条 · 丢弃 ${ai.skipped} 条${ai.error ? `（${ai.error}）` : ''}` : '未调用 AI')
            + `；${report}`);
    }
    return { made, ms, stage1, ai, cands, pickStat, mech, report, aiUsed: ai.used, relMaint, relCounts };
}
/** 提取合并失败后延迟自动修复一次（V1 `scheduleAutoRepairOnMergeFail`；默认 15s，可用 `cfg.repairFailDelaySec` 调） */
let autoRepairFailTimer = null;
function scheduleAutoRepairOnMergeFail() {
    try {
        if (!cfg || cfg.autoRepairOnMergeFail !== true) return false;
        if (aiBusy()) return false;
        if (autoRepairFailTimer) return false;
        const delayMs = Math.max(1, Number(cfg.repairFailDelaySec) || 15) * 1000;
        autoRepairFailTimer = timerHooks.set(() => {
            autoRepairFailTimer = null;
            try { dbgLog('修复', { action: '提取失败自动修复触发', delaySec: Math.round(delayMs / 1000) }); } catch (e) { /* 忽略 */ }
            try { void runRepair({ silent: true, cause: '提取合并失败后自动触发' }); } catch (e) { /* 忽略 */ }
        }, delayMs);
        return true;
    } catch (e) { return false; }
}
/** 清空修复域定时器（卸载/测试隔离） */
function cancelRepairTimers() {
    try { if (autoRepairFailTimer) { timerHooks.clear(autoRepairFailTimer); autoRepairFailTimer = null; } } catch (e) { /* 忽略 */ }
    return true;
}

export {
    REPAIR_FIELD_KEYS, REPAIR_CORR_MAX_N, REPAIR_CORR_SAMPLE, REPAIR_LOG_MAX,
    repairRand, repairTagSetOf, repairJaccard, repairCorrelationMap, repairDefectOf,
    repairCollectCandidates, buildRepairPrompt, repairApplyAiResult, runRepair,
    scheduleAutoRepairOnMergeFail, cancelRepairTimers,
    REPAIR_DIM_SPEC, REPAIR_BANNED, REPAIR_PLACEHOLDER, REPAIR_GUARD,
    repairNameKey, repairIsGarbage, repairGarbageOf, repairBannedOf,
    repairMergeDedupe, repairMergeByName, repairDecayPass, repairPruneGarbage,
    latestFloorHash, autoRepairOpDue, bumpRepairOp, autoRepairTake,
    repairBatchTags, repairReport, repairLogPush, repairTotalCount,
    runRepairMech,
};
