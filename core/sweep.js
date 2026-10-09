// ============================================================
// core/sweep.js —— **逐字移植自 V1**（src/modules/05-记忆状态与存储抽象.js 的删除自动留痕与墓碑应用）
// 覆盖：条目索引（`entryIndexInit` / `entryIndexBuild` / `entryIndexPrev` / `atomIndexCur`）、
//   删除自动留痕 `tombstoneSweep`（对照上一次索引 → 消失条目写 id + 内容哈希双墓碑）及其暂停/恢复/抑制开关、
//   墓碑应用 `applyTombstonesToState`（跨端拉取后按墓碑剔除条目）与墓碑树合并。
// 语义：**保存流水线的一部分** —— V1 的 `saveState()` 顺序为「建索引 → 留痕 → 写库」，V2 在 adapters/store.js 中照此接线。
// 一致性由 tests/unit/sweep-envelope-golden.test.js 的黄金样本强制校验（oracle = 真实 V1 插件）。
// ============================================================

import { ATOM_DIM_KEYS } from './constants.js';
import { tombSet, tombSetH } from './merge.js';
// v2.86.0（`docs/D8` R1=B）：墓碑索引 / 复活防护 = **身份哈希**
import { atomIdentityHash } from './model/hash.js';
import { state, log } from './model/runtime.js';
// v3.40.0（`docs/D16` A2）：条目被墓碑化时**级联**清掉指向它的关联行（悬空关联不再积累）
import { purgeLinksForGoneEntries as relPurgeForGone } from './model/rel.js';
let entryIndexPrev = null;

let tombstoneSweepSuppress = 0;      // 整体替换类操作（快照还原等）临时抑制，避免把“回滚”误记为删除
// v1.200 性能优化（P2，详见 docs/等待改进/性能分析与优化报告-v1.199.md）：
//   旧实现每次保存把全部条目哈希 **3 遍**（tombstoneSweep 建当前索引 1 遍 + entryIndexInit 再建 1 遍 +
//   saveStateRaw 的 ensureAtomHashes 1 遍）。三处算的都是「同一函数在同一份数据上的同一结果」，
//   这里合并为**一次遍历**：同时刷新 it.h、建立当前 id→哈希索引；索引在同一保存周期内复用（atomIndexCur）。

let atomIndexCur = null;
// 一次遍历：刷新内容哈希 it.h（= ensureAtomHashes 的职责）+ 返回当前 id→哈希索引（= entryIndexBuild 的职责）

function entryIndexBuild(refreshHashes) {
    const idx = {};
    for (const cat of ATOM_DIM_KEYS) {
        const m = {};
        for (const it of (state[cat] || [])) {
            if (!it || typeof it !== 'object') continue;
            let h = '';
            try { h = atomIdentityHash(cat, it); } catch (e) { h = ''; }
            if (refreshHashes !== false && h && it.h !== h) it.h = h;
            if (it.id !== undefined && it.id !== null) m[String(it.id)] = h;
        }
        idx[cat] = m;
    }
    return idx;
}

function entryIndexInit() { try { entryIndexPrev = entryIndexBuild(true); } catch (e) { entryIndexPrev = null; } }

/**
 * v3.0.15：把**已建好的当前索引**交给下一次 `tombstoneSweep()` 复用。
 *   背景：`adapters/store.js` 的保存流水线先 `entryIndexBuild(true)`（全量哈希一遍）再 `tombstoneSweep()`，
 *   而后者内部 `atomIndexCur || entryIndexBuild(true)` —— `atomIndexCur` 从没有被赋过值，于是**同一份数据
 *   每次保存被完整哈希两遍**（2000 条情节实测 ~38ms/遍，纯浪费）。这里补上「交接」这一步：
 *   保存流水线把刚建好的索引交进来，扫墓碑时直接用同一份（语义完全等价：两次构建之间没有任何数据变更）。
 * @param {object} idx `entryIndexBuild()` 的返回值
 */
function primeAtomIndex(idx) { atomIndexCur = (idx && typeof idx === 'object') ? idx : null; return atomIndexCur; }

function tombstoneSweepPause() { tombstoneSweepSuppress++; }

function tombstoneSweepResume() { if (tombstoneSweepSuppress > 0) tombstoneSweepSuppress--; }

function tombstoneSweep() {
    try {
        // v1.200（P2）：任一提前返回都要丢弃「本周期缓存的当前索引」，避免被后续保存误复用（陈旧索引会误判删除）
        if (!entryIndexPrev) { atomIndexCur = null; entryIndexInit(); return 0; }
        if (tombstoneSweepSuppress > 0) { atomIndexCur = null; entryIndexInit(); return 0; }
        const ts = Date.now();
        let n = 0;
        const gone = [];   // v3.40.0（`docs/D16` A2）：本轮确证消失的条目 → 关联行**级联**清理
        // v1.200（P2）：复用本保存周期已建立的「当前 id→哈希索引」（含已刷新的 it.h），不再重复哈希全量条目
        const curIdx = atomIndexCur || entryIndexBuild(true);
        for (const cat of ATOM_DIM_KEYS) {
            const prev = entryIndexPrev[cat] || {};
            const cur = curIdx[cat] || {};
            const curH = {};
            for (const id of Object.keys(cur)) { const h = cur[id]; if (h) curH[h] = 1; }
            for (const id of Object.keys(prev)) {
                if (id in cur) continue;
                const h = prev[id];
                if (h && curH[h]) continue;         // 同内容仍在（去重/换 id 合并）→ 不是删除
                try { tombSet(cat, id, ts); if (h) tombSetH(cat, h, ts); n++; gone.push({ dim: cat, id: id }); } catch (e) { }
            }
        }
        entryIndexPrev = curIdx;        // 直接把本次索引作为下一次基线（旧实现 entryIndexInit 会再算一遍）
        atomIndexCur = null;
        // v3.40.0（`docs/D16` A2）：条目确证消失 → **级联**删掉指向它的关联行（悬空关联不再积累）
        if (gone.length) {
            try {
                const pr = relPurgeForGone(gone);
                if (pr && pr.removed) {
                    try { log('关联', { action: '级联清理悬空关联行（条目已删除）', removed: pr.removed, byDim: pr.byDim }); } catch (e) { /* 忽略 */ }
                }
            } catch (e) { /* 级联失败不影响墓碑 */ }
        }
        return n;
    } catch (e) { return 0; }
}
try { entryIndexInit(); } catch (e) { }   // 启动即建立索引基线（此后任何消失的条目都会自动留痕）
// 快照：仅当确有原子数据时才建根/调度（避免空状态被 init saveState 建出「空根快照」，
// 也避免空快照污染跨端对账 —— 无原子 → 跳过快照段）

function deletedHByDim(delH, dim) {
    try { return (delH && delH[dim] && typeof delH[dim] === 'object' && !Array.isArray(delH[dim])) ? delH[dim] : {}; } catch (e) { return {}; }
}
// 墓碑回收（TTL）：超过 keepDays 的 id/内容哈希墓碑才允许丢弃 —— 时间窗足够长，避免旧端复活被删条目

function entryWallMs(it) {
    try { const v = Number(it && it.updatedAt); if (Number.isFinite(v) && v > 1e12) return v; } catch (e) { }
    return 0;
}

function deletedByDim(del, dim) {
    try { return (del && del[dim] && typeof del[dim] === 'object' && !Array.isArray(del[dim])) ? del[dim] : {}; } catch (e) { return {}; }
}
// 双端墓碑按 id 取“较新时间”合并

function mergeTombMaps(a, b) {
    const out = {};
    const push = (m) => { if (!m || typeof m !== 'object') return; for (const k of Object.keys(m)) { const v = Number(m[k]) || 0; if (!out[k] || v > out[k]) out[k] = v; } };
    push(a); push(b);
    // v2.92.0（`docs/D10` Q3 裁决）：墓碑账本**上限 + 过期回收** —— 每维保留**最新 500 条**、丢弃**早于 90 天**的墓碑。
    //   目的：账本不再无限增长（旧账本反复参与合并会扩大误伤面、增大存档体积）；近期账本仍完整保留防复活能力。
    const TOMB_CAP = 500, TOMB_TTL_MS = 90 * 24 * 3600 * 1000;
    const now = Date.now();
    const keys = Object.keys(out);
    if (keys.length > TOMB_CAP) {
        keys.sort((x, y) => (Number(out[y]) || 0) - (Number(out[x]) || 0));
        for (const k of keys.slice(TOMB_CAP)) delete out[k];
    }
    // 只对可信墙钟（> 1e12，与 entryWallMs 同口径）做过期判定：合成/相对时间戳不参与，避免误删
    for (const k of Object.keys(out)) { const t = Number(out[k]) || 0; if (t > 1e12 && (now - t) > TOMB_TTL_MS) delete out[k]; }
    return out;
}
// 整棵墓碑树合并（{dim:{key:ts}}）—— 整体采纳对端信封时用于「墓碑并集」

function mergeTombTrees(a, b) {
    const out = {};
    const dims = {};
    pushDims(a); pushDims(b);
    function pushDims(m) { if (m && typeof m === 'object') for (const d of Object.keys(m)) dims[d] = 1; }
    for (const d of Object.keys(dims)) {
        const merged = mergeTombMaps((a && a[d]) || {}, (b && b[d]) || {});
        if (Object.keys(merged).length) out[d] = merged;
    }
    return out;
}
// 把 state.deleted / state.deletedH 应用到各维度（原地过滤 + 写回墓碑）

function applyTombstonesToState(learn) {
    try {
        const del = state.deleted = (state.deleted && typeof state.deleted === 'object') ? state.deleted : {};
        const delH = state.deletedH = (state.deletedH && typeof state.deletedH === 'object') ? state.deletedH : {};
        for (const cat of ATOM_DIM_KEYS) {
            const arr = Array.isArray(state[cat]) ? state[cat] : [];
            const r = applyDeletedToArray(cat, arr, del, del, delH, delH, learn !== false);
            state[cat] = r.arr;
            if (r.del && Object.keys(r.del).length) del[cat] = r.del; else delete del[cat];
            if (r.delH && Object.keys(r.delH).length) delH[cat] = r.delH; else delete delH[cat];
        }
        return true;
    } catch (e) { return false; }
}
// 应用墓碑过滤 + 失效墓碑回收：条目已被删除（墓碑时间 ≥ 条目墙钟时间；无墙钟时间的条目直接视为被删）
// → 从 arr 移除；若条目墙钟晚于墓碑（删除后又重新写入/编辑）→ 保留并作废该墓碑。
// 同时按 **内容哈希墓碑** 过滤（同内容换 id 复活也挡住），并返回 hash 墓碑映射；
//   `learnH` 为真时把「因 id 墓碑被剔除的条目」的内容哈希补记进 hash 墓碑（合并即学习，无需逐站点改造）。

function applyDeletedToArray(dim, arr, delA, delB, delHA, delHB, learnH) {
    const merged = mergeTombMaps(deletedByDim(delA, dim), deletedByDim(delB, dim));
    const mergedH = mergeTombMaps(deletedHByDim(delHA, dim), deletedHByDim(delHB, dim));
    if (!Object.keys(merged).length && !Object.keys(mergedH).length) return { arr: (arr || []), del: {}, delH: {} };
    const learn = learnH !== false;
    const out = [];
    for (const it of (arr || [])) {
        if (!it || it.id === undefined || it.id === null) { out.push(it); continue; }
        const idKey = String(it.id);
        const t = merged[idKey];
        const h = atomIdentityHash(dim, it);
        const th = h ? mergedH[h] : 0;
        const wall = entryWallMs(it);
        const deadById = !!t && (wall === 0 || t >= wall);
        // v2.91.0（用户报告「跨端同步后情节等数据总是丢失」）——**内容墓碑的删除判据加严**：
        //   原口径与 id 墓碑一致（`wall === 0` 也删）→ 只要某条与任一内容墓碑同内容，且该条**没有墙钟时间**
        //   （跨端同步进来 / 旧存档 / 由瘦身或对端写入而缺 `updatedAt`），就会被**静默删除**。
        //   现改为：内容墓碑**只删「有明确墙钟且不晚于墓碑」的条目**；墙钟未知的条目**只能由 id 墓碑删除**。
        //   代价：极少数「同内容换 id 复活且无墙钟」的条目会漏挡（属**保守**方向 —— 宁可多留，不可误删）。
        const deadByHash = !!th && wall > 0 && th >= wall;
        if (deadById || deadByHash) {
            // 已删除：跳过；并把内容哈希补记进 hash 墓碑（供后续对端“换 id 复活”时继续挡住）。
            // 注意：墓碑本身必须保留（随信封持久化），否则对端下次合并又会被并集复活。
            if (learn && h) { const t2 = Math.max(Number(t) || 0, Number(th) || 0, Date.now()); if (!mergedH[h] || mergedH[h] < t2) mergedH[h] = t2; }
            continue;
        }
        out.push(it);
        if (t) delete merged[idKey];      // 条目墙钟晚于墓碑（删除后重写）→ 保留并作废该墓碑
        if (th) delete mergedH[h];        // 同内容在上次删除后又重新写入 → 作废 hash 墓碑
    }
    return { arr: out, del: merged, delH: mergedH };
}

export { entryIndexBuild, entryIndexInit, entryIndexPrev, primeAtomIndex, tombstoneSweep, tombstoneSweepPause, tombstoneSweepResume, tombstoneSweepSuppress, applyTombstonesToState, applyDeletedToArray, deletedByDim, deletedHByDim, entryWallMs, mergeTombMaps, mergeTombTrees, atomIndexCur };
