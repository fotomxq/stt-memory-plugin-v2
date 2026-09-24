// ============================================================
// core/entries.js —— **逐字移植自 V1**（src/modules/07-原子层与数据归一化.js 的条目层 + 05 的墓碑）
// 覆盖：条目写入 `upsertEntry`（按维度归一 → 按 id/内容哈希合并 → 落盘）、条目删除 `deleteEntry`
//   （级联清理：关联行 / 依赖该角色的状态 / 隐藏来源恢复 / 双墓碑）、关联层写入 `upsertRelLinks` 与孤儿清扫 `sweepOrphanRelLinks`。
// 适配：ESM 化 + 注入视图（state/cfg/持久化钩子 + `getLastMessageId()`）；墓碑与隐藏保护复用 core/merge.js。
// 注：`relMaintRun`（关联维护编排，V1 里含 UI 文案与统计展示）留待「修复/维护层」批次接线。
// 一致性由 tests/unit/migrate-entries-golden.test.js 的黄金样本强制校验。
// ============================================================

import { KIND_MAP } from './config.js';
import { ATOM_DIM_KEYS } from './constants.js';
import { releaseMergedSources, tombEntries, tombMany, tombSet } from './merge.js';
import { normalizeAtom } from './model/atom.js';
import { normalizeConcept, normalizeCurrentState, normalizeItem, normalizeMemory, normalizeNpc, normalizeParallel, normalizePlan, normalizeScene, normalizeSuspense } from './model/dims.js';
import { normalizeCurrency } from './model/money.js';
import { normalizeRelLink, relLinkId } from './model/rel.js';
import { normalizeRumor } from './model/rumor.js';
import { cfg, getLastMessageId, log, saveState, state } from './model/runtime.js';
import { mergeTags, scenePathArr } from './model/scalars.js';
import { normalizePlotSegment } from './model/segment.js';
import { normalizeSnapshot, stampSnapshotTime, syncSnapshotAge } from './model/snapshot.js';
import { normalizeList, snapNameKey } from './util.js';
function sweepOrphanRelLinks() {
    let n = 0;
    try {
        const arr = (state && state.links) || [];
        const exists = (dim, refId) => ((state && state[dim]) || []).some(x => x && String(x.id) === String(refId));
        const gone = arr.filter(x => x && !exists(String(x.dim), String(x.refId)));
        if (!gone.length) return 0;
        n = gone.length;
        state.links = arr.filter(x => x && exists(String(x.dim), String(x.refId)));
        try { tombEntries('links', gone); } catch (e) { }
    } catch (e) { }
    return n;
}
// 从「条目输入」写关联（AI 抽取 / 编辑器保存共用）：接受 关联 / 知情者 / relLinks 数组
//   · 总开关关闭（relLinkEnabled=false）时不做任何事（退回现状口径）
//   · 默认并集语义：未提及的既有角色保留；replace=true 时整组替换（编辑器全量保存用）

function upsertRelLinks(dim, refId, list, opts) {
    try {
        const o = opts || {};
        const d = String(dim || ''), r = String(refId || '');
        if (!relLinkDimOk(d) || !r) return { added: 0, updated: 0, removed: 0 };
        const all = Array.isArray(state.links) ? state.links : [];
        const existing = all.filter(x => x && String(x.dim) === d && String(x.refId) === r);
        const others = all.filter(x => !(x && String(x.dim) === d && String(x.refId) === r));
        const incoming = [];
        for (const raw of (Array.isArray(list) ? list : [])) {
            const n = normalizeRelLink(Object.assign({ dim: d, refId: r }, raw || {}), d);
            if (!n) continue;
            n.updatedAt = Number(n.updatedAt) || Date.now();
            const i = incoming.findIndex(x => x.who === n.who);
            if (i >= 0) incoming[i] = n; else incoming.push(n);
        }
        let merged;
        if (o.replace === true) merged = incoming;
        else {
            merged = existing.slice();
            for (const n of incoming) {
                const i = merged.findIndex(x => x.who === n.who);
                if (i >= 0) merged[i] = n; else merged.push(n);
            }
        }
        const max = relLinkDefaultMax();
        if (merged.length > max) {
            merged.sort((a, b) => ((REL_LINK_HOW_RANK[b.how] || 0) - (REL_LINK_HOW_RANK[a.how] || 0)) || String(a.who).localeCompare(String(b.who)));
            const anchorRow = merged.find(x => !x.who);
            const picked = anchorRow ? [anchorRow] : [];
            for (const x of merged) { if (picked.length >= max) break; if (!x.who || picked.indexOf(x) >= 0) continue; picked.push(x); }
            merged = picked;
        }
        state.links = others.concat(merged);
        return { added: Math.max(0, merged.length - existing.length), updated: Math.min(merged.length, existing.length), removed: Math.max(0, existing.length - merged.length) };
    } catch (e) { return { added: 0, updated: 0, removed: 0 }; }
}
// 级联清理：删除条目时同步删除其全部关联行（留墓碑，跨端不复活）

const REL_LINK_HOW_RANK = { author: 9, involved: 9, participant: 8, witness: 7, join: 7, investigating: 6, told: 5, unspecified: 4, inferred: 3, rumor: 2, related: 1 };

function relLinkDefaultMax() { const n = Number(cfg && cfg.relLinkMax); return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 12; }
// how 归一（中文/英文别名；越界 → unspecified；平行事件恒为 related）

function relLinkDimOk(dim) { return REL_LINK_DIMS.indexOf(String(dim || '')) >= 0; }

const REL_LINK_DIMS = ['memories', 'plans', 'suspense', 'parallels'];

function deleteEntry(kind, id) {
    const km = KIND_MAP[kind];
    if (!km) return false;
    const arr = km.get() || [];
    // 场景父级删除 → 子场景级联删除（路径前缀 = 同一棵子树：如删除「城市甲>街区乙」，
    //   其下「城市甲>街区乙>地点丁」等后代一并清除，避免子级孤悬）。虚节点（无记录）不在此列。
    if (kind === 'scenes') {
        const target = arr.find(x => x.id === id);
        if (!target) return false;
        const delPath = scenePathArr(target).join('>');
        const removedIds = arr.filter(x => {
            if (x.id === id) return true;
            const p = scenePathArr(x).join('>');
            return (p === delPath || (delPath && p.startsWith(delPath + '>')));
        }).map(x => x.id);
        const kept = arr.filter(x => {
            if (x.id === id) return false;
            const p = scenePathArr(x).join('>');
            // 同路径（重复记录，视为同一节点）与路径以删除节点为前缀的子孙 → 一并删除
            return !(p === delPath || (delPath && p.startsWith(delPath + '>')));
        });
        km.set(kept);
        // 级联删除记墓碑（跨端不再复活被删场景及其子孙）
        try { tombMany('scenes', removedIds); } catch (e) { }
        saveState();
        return true;
    }
    // 删除角色（档案）时联动清除该角色的全部状态记录（角色不在了，其“当前状态”一并失效）
    if (kind === 'snapshots') {
        const removed = arr.filter(x => x.id === id);
        km.set(arr.filter(x => x.id !== id));
        // 档案删除记墓碑
        try { tombSet('snapshots', id); } catch (e) { }
        try { sweepStatesForRemovedSnapshots(removed.map(x => x.name)); } catch (e) { }
        // v1.165：角色删除 → 移除其关联行（不静默丢条目；剩 0 人的条目成为孤儿，按配置处置）
        try { removed.forEach(x => { if (x && x.name) removeRelLinksForWho(x.name); }); } catch (e) { }
        saveState();
        return true;
    }
    const target0 = arr.find(x => x && String(x.id) === String(id));
    km.set(arr.filter(x => x.id !== id));
    // 删除记墓碑（跨端删除同步）
    try { tombSet(kind, id); } catch (e) { }
    // v1.165：删除条目 → 级联删除其关联行（留墓碑，跨端不复活）
    try { dropRelLinks(kind, [id]); } catch (e) { }
    // v1.203：删除的是「合并总结」情节 → 让被它总结的原情节恢复显示（数据始终保留，只是重新可见）
    if (kind === 'atoms' && target0 && target0.mergedSummary) {
        try { const n = releaseMergedSources(target0); if (n) log(`合并总结已删除：恢复显示 ${n} 条被总结情节`); } catch (e) { }
    }
    saveState();
    return true;
}
// v1.165：角色删除后的关联降级——剩 1 人的共同记忆回落为私密（owner 保留）、剩 0 人成为孤儿（渲染忽略 + 记忆页提示）

function dropRelLinks(dim, ids) {
    let n = 0;
    try {
        const d = String(dim || '');
        const set = new Set((Array.isArray(ids) ? ids : [ids]).filter(x => x !== undefined && x !== null && x !== '').map(x => String(x)));
        if (!set.size) return 0;
        const arr = (state && state.links) || [];
        const gone = arr.filter(x => x && String(x.dim) === d && set.has(String(x.refId)));
        if (!gone.length) return 0;
        n = gone.length;
        state.links = arr.filter(x => !(x && String(x.dim) === d && set.has(String(x.refId))));
        try { tombEntries('links', gone); } catch (e) { }
    } catch (e) { }
    return n;
}
// 引用重挂：条目合并（记忆 / 计划 / 悬念 / 平行事件）后把关联与引用指回主条
/** V1 `retargetRelRefs`（v1.168）：被并入条目的关联行改挂保留主条；同角色多行取「更可靠方式」的一行；不留孤儿行、不写墓碑 */
function retargetRelRefs(dim, fromIds, toId) {
    let n = 0;
    try {
        const d = String(dim || ''), to = String(toId || '');
        const set = new Set((Array.isArray(fromIds) ? fromIds : [fromIds]).map(x => String(x)).filter(x => x && x !== to));
        if (!set.size || !to) return 0;
        const arr = (state && state.links) || [];
        const keep = [];
        const byWho = new Map();
        for (const row of arr) {
            if (!row) continue;
            if (String(row.dim) === d && set.has(String(row.refId))) {
                const moved = Object.assign({}, row, { refId: to, id: relLinkId(d, to, row.who) });
                const prev = byWho.get(String(moved.who));
                if (!prev) { byWho.set(String(moved.who), moved); } else if ((REL_LINK_HOW_RANK[moved.how] || 0) > (REL_LINK_HOW_RANK[prev.how] || 0)) { byWho.set(String(moved.who), moved); }
                n++;
                continue;
            }
            keep.push(row);
        }
        // 去掉与主条已有行冲突的 who
        const merged = keep.filter(x => !(x && String(x.dim) === d && String(x.refId) === to && byWho.has(String(x.who))));
        state.links = merged.concat(Array.from(byWho.values()));
    } catch (e) { }
    return n;
}

function sweepStatesForRemovedSnapshots(names) {
    try {
        const fulls = new Set();
        const cores = {};
        for (const nm of (names || [])) {
            const f = String(nm || '').trim();
            if (!f) continue;
            fulls.add(f);
            const c = injectNameCore(f);
            (cores[c] = cores[c] || []).push(f);
        }
        if (!fulls.size) return 0;
        const beforeList = (state.currentStates || []).slice();
        const before = beforeList.length;
        state.currentStates = beforeList.filter((s) => {
            const subj = String((s && s.subject) || '').trim();
            if (!subj) return true;
            if (fulls.has(subj)) return false;                       // 主体=被删角色全名
            const c = injectNameCore(subj);
            const arr = cores[c];
            if (arr && arr.length === 1 && subj.includes('·')) return false;  // 主体=「角色·后缀」，且该姓名核唯一对应被删角色
            return true;
        });
        // 联动清除的状态记墓碑（跨端删除同步）
        try {
            const afterList = state.currentStates || [];
            tombMany('currentStates', beforeList.filter(s => afterList.indexOf(s) < 0).map(s => s && s.id));
        } catch (e) { }
        return before - (state.currentStates || []).length;
    } catch (e) { return 0; }
}

// ==================== v1.165：通用知情关联层（state.links[]） ====================
// 设计事实源：docs/11-记忆大类改造设计（事实与知情链路）§2–§3。要点：
//   ① **记忆原子不动**（owner 等既有字段保留，仅在无关联时作回退口径）；计划 / 悬念 / 平行事件原子本版扩展；
//   ② 「谁与某条目相关、怎么相关」= 独立原子维度 links[]（一行 = 一个「条目 ↔ 角色」关联）——
//      因此自动继承内容哈希 / 跨端逐条合并 / 内容去重 / 删除墓碑 / 瘦身白名单 / 快照链（已加入 ATOM_DIM_KEYS）；
//   ③ **锚行**（who === ''）承载条目级属性（事实标记 / 公开 / 各类引用），非锚行这些字段一律清空（避免冗余分叉）；
//   ④ how 的合法子集按 dim 限定，越界归一为 unspecified 并记 note；平行事件的关联**恒为 related**
//      （语义 = 相关/受影响 ≠ 知情：平行事件对任何角色都不可见）；
//   ⑤ 引用类字段（conceptRef / atomRef / planRef / suspenseRef / memRefs / sourceRefs）**不进内容哈希**。

function injectNameCore(name) { return String(name || '').split(/[·・.．\s]+/)[0].trim(); }
// 全名 → 「管用名」候选清单（按特异性降序：全名 → 各有效片段 → 首尾组合）

function removeRelLinksForWho(name) {
    const touched = [];
    try {
        const k = snapNameKey(name);
        if (!k) return touched;
        const before = (state && state.links) || [];
        const gone = before.filter(x => x && x.who && snapNameKey(x.who) === k);
        if (!gone.length) return touched;
        for (const g of gone) touched.push({ dim: g.dim, refId: g.refId });
        state.links = before.filter(x => !(x && x.who && snapNameKey(x.who) === k));
        try { tombEntries('links', gone); } catch (e) { }
    } catch (e) { }
    return touched;
}
// 孤儿关联（目标条目已不存在）：渲染忽略；**只在显式修复时**清理（载入/保存不动，避免误删「对端刚建、本端未拉到」的关联）

// 取字段值（对象路径）

function upsertEntry(kind, raw, opts) {
    const km = KIND_MAP[kind];
    if (!km) return false;
    const floor = { start: getLastMessageId(), end: getLastMessageId() };
    const n = kindNormalize(kind, raw, floor);
    if (!n) return false;
    // 手动把物品数量设为 0 → 该条目自动删除（不保留空条目）
    if (kind === 'items' && Number(n.qty) === 0) {
        km.set((km.get() || []).filter(x => x.id !== n.id && x.name !== n.name));
        saveState();
        return true;
    }
    // 手动把计划/悬念保存为「已关闭/已揭晓」→ 原文直接删除，只累计统计（不再驻留 closed 条目）
    if ((kind === 'plans' || kind === 'suspense') && n.status === 'closed') {
        state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
        const key = kind === 'plans' ? 'plansClosed' : 'suspenseResolved';
        state.stats[key] = Number(state.stats[key] || 0) + 1;
        km.set((km.get() || []).filter(x => !(x.id === n.id || String(x.content || '') === String(n.content || ''))));
        // v1.165：了结即原文删除 → 级联删除其关联行（跨端同步删除）
        try { dropRelLinks(kind, [n.id]); } catch (e) { }
        saveState();
        return true;
    }
    const arr = km.get() || [];
    const i = arr.findIndex(x => x.id === n.id || (kind === 'snapshots' && x.name === n.name));
    if (i >= 0) {
        n.uses = Number(arr[i]?.uses) || 0;
        if (kind === 'snapshots') {
            // v1.161：编辑器保存 = 一次真实更新 → 记「最后一次更新时间」（剧情时间为基准）
            const merged = mergeSnapshotObjects(arr[i], n, opts);
            try { stampSnapshotTime(merged, 'update'); } catch (e) { }
            arr[i] = merged;
        } else arr[i] = { ...arr[i], ...n };
    } else {
        if (kind === 'snapshots') { try { stampSnapshotTime(n, 'update'); } catch (e) { } }
        arr.push(n);
    }
    km.set(arr);
    saveState();
    return true;
}

function kindNormalize(kind, raw, floor) {
    switch (kind) {
        case 'atoms': return normalizeAtom(raw, floor);
        case 'states':
        case 'currentStates': return normalizeCurrentState(raw);   // 规范键别名（见 core/config.js KIND_MAP 注释）
        case 'snapshots': return normalizeSnapshot(raw);
        case 'memories': return normalizeMemory(raw);
        case 'items': return normalizeItem(raw);
        case 'plans': return normalizePlan(raw);
        case 'suspense': return normalizeSuspense(raw);
        case 'npcs': return normalizeNpc(raw);
        case 'scenes': return normalizeScene(raw);
        case 'concepts': return normalizeConcept(raw);
        case 'parallels': return normalizeParallel(raw);
        case 'currencies': return normalizeCurrency(raw);   // v1.181：货币大类
        case 'plotSegments': return normalizePlotSegment(raw);   // v1.182：情节分段总结
        case 'rumors': return normalizeRumor(raw);   // v1.192：传言
        default: return null;
    }
}
// 审计修复：mergeSnapshotObjects 增「来源语义」参数 ——
//   默认（AI 增量「更新」/跨端合并）：空串/空数组 不覆盖旧值（语义，防把未变化字段冲空）；
//   opts.clearEmpty=true（编辑器全量保存）：空值按“用户有意清空”处理 → 字段可真正清空
//   （修复 后 性别/职业/标签 等一旦填写便无法在编辑器里清掉的回归）。

function mergeSnapshotObjects(old, n, opts) {
    const ce = !!(opts && opts.clearEmpty);
    const oldI = old.identity || {}, oldP = old.personality || {}, oldB = old.background || {}, oldS = old.social || {}, oldF = old.future || {};
    // 增量合并不以空串覆盖旧值（角色档案「更新」只传变化部分 —— 未变化字段留空即保持旧值，
    //   避免 AI/编辑器增量更新把 性别/职业 等既有字段冲成空）
    const fill = (o, nObj) => {
        const r = Object.assign({}, o);
        for (const [k, v] of Object.entries(nObj || {})) { if (v !== undefined && v !== null && v !== '') r[k] = v; }
        return r;
    };
    const fillCe = (o, nObj) => Object.assign({}, o, nObj || {});
    const nl = (arr) => normalizeList(arr);
    // v1.161：两个「剧情时间」采样字段取**更晚的一次观测** —— 避免 AI 增量更新（空值不覆盖）
    //   与编辑器全量保存（clearEmpty）把已有记录冲空
    const laterPair = (od, ot, nd, nt) => {
        const a = String(od || ''), b = String(nd || '');
        if (!b) return { d: a, t: String(ot || '') };
        if (!a) return { d: b, t: String(nt || '') };
        if (b > a) return { d: b, t: String(nt || '') };
        if (b < a) return { d: a, t: String(ot || '') };
        return { d: a, t: String(nt || ot || '') };
    };
    const tUp = laterPair(old.lastUpdateDate, old.lastUpdateTime, n.lastUpdateDate, n.lastUpdateTime);
    const tSeen = laterPair(old.lastSeenDate, old.lastSeenTime, n.lastSeenDate, n.lastSeenTime);
    // v1.162：年龄为派生字段 —— 合并后按「出生日期 + 当前剧情日期」重算，且**不采信**外部传入的年龄
    // v1.164：「已去世」为三态开关 —— 新值 undefined（本次未提及）保留旧值，true/false 视为明确表态（fill/fillCe 已按此语义）
    // v1.162：年龄为派生字段 —— 合并后按「出生日期 + 剧情时间锚点」重算，且**不采信**外部传入的年龄；
    //   v1.171：无剧情锚点时不清空（保留合理的旧值），只在旧值不合理（如被现实年份算出的 1xx 岁）时清掉
    const mergedIdentity = ce ? fillCe(oldI, n.identity) : fill(oldI, n.identity);
    // v1.162/v1.171/v1.176：年龄为派生字段 —— 合并后统一走 syncSnapshotAge()（出生日期 + 剧情锚点重算，
    //   不采信外部传入的年龄；算不出时保留合理存档值、清掉不合理的历史污染值）
    try { syncSnapshotAge({ identity: mergedIdentity }); } catch (e) { }
    return {
        ...old, ...n,
        lastUpdateDate: tUp.d, lastUpdateTime: tUp.t, lastSeenDate: tSeen.d, lastSeenTime: tSeen.t,
        tags: ce ? nl(n.tags || []) : mergeTags((n.tags && n.tags.length ? n.tags : (Array.isArray(old.tags) ? old.tags : [])), []),
        identity: mergedIdentity,
        // v1.162：外貌为单字段文本 —— 增量更新时「非空新值覆盖旧值，空值保留旧值」；
        //   编辑器全量保存（clearEmpty）时空值 = 用户有意清空
        appearance: ce ? String(n.appearance || '') : (String(n.appearance || '').trim() || String(old.appearance || '')),
        personality: ce ? {
            traits: nl(n.personality.traits || []),
            quirks: nl(n.personality.quirks || []),
            values: nl(n.personality.values || []),
            speechStyle: String(n.personality.speechStyle || '').trim(),
        } : {
            traits: n.personality.traits.length ? n.personality.traits : (oldP.traits || []),
            quirks: n.personality.quirks.length ? n.personality.quirks : (oldP.quirks || []),
            values: n.personality.values.length ? n.personality.values : (oldP.values || []),
            speechStyle: n.personality.speechStyle || oldP.speechStyle || '',
        },
        background: ce ? fillCe(oldB, n.background) : fill(oldB, n.background),
        relationships: ce ? n.relationships.slice() : (n.relationships.length ? n.relationships : (old.relationships || [])),
        social: ce ? fillCe(oldS, n.social) : fill(oldS, n.social),
        future: ce ? { todos: nl(n.future.todos || []), commitments: nl(n.future.commitments || []) } : { todos: n.future.todos.length ? n.future.todos : (oldF.todos || []), commitments: n.future.commitments.length ? n.future.commitments : (oldF.commitments || []) },
    };
}

export { upsertEntry, deleteEntry, upsertRelLinks, sweepOrphanRelLinks, dropRelLinks, retargetRelRefs };
