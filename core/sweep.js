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
import { atomContentHash } from './model/hash.js';
import { state } from './model/runtime.js';
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
            try { h = atomContentHash(cat, it); } catch (e) { h = ''; }
            if (refreshHashes !== false && h && it.h !== h) it.h = h;
            if (it.id !== undefined && it.id !== null) m[String(it.id)] = h;
        }
        idx[cat] = m;
    }
    return idx;
}

function entryIndexInit() { try { entryIndexPrev = entryIndexBuild(true); } catch (e) { entryIndexPrev = null; } }

function tombstoneSweepPause() { tombstoneSweepSuppress++; }

function tombstoneSweepResume() { if (tombstoneSweepSuppress > 0) tombstoneSweepSuppress--; }

function tombstoneSweep() {
    try {
        // v1.200（P2）：任一提前返回都要丢弃「本周期缓存的当前索引」，避免被后续保存误复用（陈旧索引会误判删除）
        if (!entryIndexPrev) { atomIndexCur = null; entryIndexInit(); return 0; }
        if (tombstoneSweepSuppress > 0) { atomIndexCur = null; entryIndexInit(); return 0; }
        const ts = Date.now();
        let n = 0;
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
                try { tombSet(cat, id, ts); if (h) tombSetH(cat, h, ts); n++; } catch (e) { }
            }
        }
        entryIndexPrev = curIdx;        // 直接把本次索引作为下一次基线（旧实现 entryIndexInit 会再算一遍）
        atomIndexCur = null;
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
        const h = atomContentHash(dim, it);
        const th = h ? mergedH[h] : 0;
        const wall = entryWallMs(it);
        const deadById = !!t && (wall === 0 || t >= wall);
        const deadByHash = !!th && (wall === 0 || th >= wall);
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

export { entryIndexBuild, entryIndexInit, entryIndexPrev, tombstoneSweep, tombstoneSweepPause, tombstoneSweepResume, tombstoneSweepSuppress, applyTombstonesToState, applyDeletedToArray, deletedByDim, deletedHByDim, entryWallMs, mergeTombMaps, mergeTombTrees, atomIndexCur };
