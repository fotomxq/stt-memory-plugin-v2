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
import { state, cfg, saveState, notifyHooks, dbgLog, getLastMessageId } from './model/runtime.js';
import { tombMany } from './merge.js';
import { contentDedupeArray } from './migrate.js';
import {
    repairNormText, repairKeyText, repairClampNum, scenesUnionMergeAll, statesSubjectUnionMerge,
    runStateDecay, runParallelDecay, applyStateBounds, enforceDimCaps,
} from './ingest.js';
import { runMemoryForget, sweepLowUseForget } from './forget.js';

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
    const stage1 = { merged: m1.merged, deleted: pruned.deleted + decay.deleted, notes: m1.notes.concat(pruned.notes, decay.notes) };
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
    return { before, after, stage1, sweep: sweepRes, caps: capRes, pruned, decay, report, fixed, ms: Date.now() - t0 };
}

export {
    REPAIR_DIM_SPEC, REPAIR_BANNED, REPAIR_PLACEHOLDER, REPAIR_GUARD,
    repairNameKey, repairIsGarbage, repairGarbageOf, repairBannedOf,
    repairMergeDedupe, repairMergeByName, repairDecayPass, repairPruneGarbage,
    latestFloorHash, autoRepairOpDue, bumpRepairOp, autoRepairTake,
    repairBatchTags, repairReport, repairLogPush, repairTotalCount,
    runRepairMech,
};
