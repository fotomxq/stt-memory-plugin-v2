// ============================================================
// core/merge.js —— **逐字移植自 V1**（src/modules/05 与 07：删除墓碑 / 隐藏条目保护 / 内容哈希补全）
// 适配：ESM 化 + 注入视图（state / 持久化钩子 saveState）；墓碑键与字段名与 V1 完全一致。
// 范围：本批只含**无时钟依赖**的部分；内容去重（`contentPickBest`/`contentDedupeArray`，需 `recallDateNum`）
//   与条目增删（`upsertEntry`/`deleteEntry`，依赖 `KIND_MAP` 全表）随「配置与时钟」批次补入。
// 一致性由 tests/unit/merge-golden.test.js 的黄金样本强制校验。
// ============================================================
import { hashText, normalizeList } from './util.js';
import { state, saveState } from './model/runtime.js';
import { atomContentHash } from './model/hash.js';
import { storageHash } from './model/scalars.js';
import { ATOM_DIM_KEYS } from './constants.js';

function atomIsHidden(a) {
    try { return !!(a && (a.hidden === true || String(a.summarizedBy || '').trim())); } catch (e) { return false; }
}

function atomHiddenCount() {
    try { return (state.atoms || []).filter(x => atomIsHidden(x)).length; } catch (e) { return 0; }
}
// 「参与运作」的情节清单（排除已总结隐藏的）—— 所有自动动作统一用它取数

function activeAtoms() {
    try { return (state.atoms || []).filter(a => a && !atomIsHidden(a)); } catch (e) { return []; }
}
// 存储上限裁剪：隐藏条目**永不裁剪**（持久保留）；可见条目保留最新 cap 条（保持原顺序，避免跨端抖动）

function capAtomsKeepingHidden(arr, cap) {
    const list = Array.isArray(arr) ? arr : [];
    const n = Math.max(1, Number(cap) || 1);
    const visible = list.filter(x => !atomIsHidden(x));
    if (visible.length <= n) return list.slice();
    const keep = new Set(visible.slice(-n).map(x => x && x.id));
    return list.filter(x => atomIsHidden(x) || keep.has(x && x.id));
}
// 人工删除「合并总结」情节 → 其来源情节恢复显示（数据始终保留，只是重新可见）

function releaseMergedSources(summary) {
    try {
        const ids = (summary && summary.mergedSummary && Array.isArray(summary.mergedSummary.sourceIds)) ? summary.mergedSummary.sourceIds : [];
        if (!ids.length) return 0;
        const want = new Set(ids.map(x => String(x)));
        let n = 0;
        for (const a of (state.atoms || [])) {
            if (!a || !want.has(String(a.id))) continue;
            if (a.summarizedBy && String(a.summarizedBy) !== String(summary.id)) continue;   // 已被别的总结接管 → 不动
            if (a.hidden === true || a.summarizedBy) { delete a.hidden; delete a.summarizedBy; delete a.summarizedAt; n++; }
        }
        return n;
    } catch (e) { return 0; }
}

function eachAtom(fn) {
    for (const cat of ATOM_DIM_KEYS) {
        const arr = state[cat] || [];
        for (const it of arr) { if (it && typeof it === 'object') fn(cat, it); }
    }
}
// 原子内容序列化（备份用）：深拷贝实质内容 + 类别标记；剔除 h/uses/floor/日志等运行态可再生成字段

function ensureAtomHashes() {
    try {
        let changed = false;
        eachAtom((cat, it) => {
            const h = atomContentHash(cat, it);
            if (h && it.h !== h) { it.h = h; changed = true; }
        });
        return changed;
    } catch (e) { return false; }
}
// 收集当前全部原子的 {id: {h, cat, item}} 与聚合 hash

function collectAtomHashes() {
    const map = {};
    const order = [];
    eachAtom((cat, it) => {
        const id = String(it.id || '');
        if (id) { map[id] = { h: it.h || atomContentHash(cat, it), cat, it }; order.push(id); }
    });
    order.sort();
    const agg = storageHash(order.map(id => `${id}:${map[id].h || ''}`).join('|'));
    return { map, order, agg };
}
// ==================== 快照整理与删除动作账本 ====================
// 删除动作账本：每个快照记录「自上一快照以来被删除的原子」{id: {h, cat}} —— 只存哈希不存原文（便于汇总与还原剔除）。
// 快照指纹 state.snapFp：上一快照时刻全部原子 id → {h, cat}；删除 = 指纹有、当前无（两次快照间只记一次）。

function tombstoneMap() {
    if (!state.deleted || typeof state.deleted !== 'object' || Array.isArray(state.deleted)) state.deleted = {};
    return state.deleted;
}

function tombstoneHMap() {
    if (!state.deletedH || typeof state.deletedH !== 'object' || Array.isArray(state.deletedH)) state.deletedH = {};
    return state.deletedH;
}

function tombSet(dim, id, ts) {
    try {
        const idS = String(id);
        if (!idS || idS === 'undefined' || idS === 'null') return;
        const m = tombstoneMap();
        if (!m[dim] || typeof m[dim] !== 'object') m[dim] = {};
        const t = Number(ts) > 0 ? Number(ts) : Date.now();
        const cur = m[dim][idS];
        m[dim][idS] = (cur && cur > t) ? cur : t;
    } catch (e) { }
}

function tombSetH(dim, hash, ts) {
    try {
        const h = String(hash || '');
        if (!h) return;
        const m = tombstoneHMap();
        if (!m[dim] || typeof m[dim] !== 'object') m[dim] = {};
        const t = Number(ts) > 0 ? Number(ts) : Date.now();
        const cur = m[dim][h];
        m[dim][h] = (cur && cur > t) ? cur : t;
    } catch (e) { }
}
// 条目 → 内容哈希墓碑（删除时调用；条目对象仍在手上时最省事）

function tombEntry(dim, entry, ts) {
    try {
        if (!entry || typeof entry !== 'object') return;
        if (entry.id !== undefined && entry.id !== null) tombSet(dim, entry.id, ts);
        tombSetH(dim, atomContentHash(dim, entry), ts);
    } catch (e) { }
}

function tombMany(dim, ids, ts) {
    const t = Number(ts) > 0 ? Number(ts) : Date.now();
    (Array.isArray(ids) ? ids : []).forEach(id => { try { tombSet(dim, id, t); } catch (e) { } });
}
// ==================== 内容哈希墓碑（防「删除后被对端唤醒」） ====================
// 按 id 的墓碑只能挡住「同一条目原样回来」；若对端把它以新 id 重新写入（AI 重生成同内容、
// 合并时的内容哈希去重换 id、快照还原），id 墓碑失效 → 该条被“唤醒”。故删除动作除 id 之外
// 再按 **内容哈希** 记一份墓碑，合并时同内容条目（条目墙钟 ≤ 墓碑时间）一并剔除。

function tombEntries(dim, entries, ts) {
    try { (Array.isArray(entries) ? entries : []).forEach(en => { try { tombEntry(dim, en, ts); } catch (e) { } }); } catch (e) { }
}

export { atomIsHidden, atomHiddenCount, activeAtoms, capAtomsKeepingHidden, releaseMergedSources, eachAtom, ensureAtomHashes, collectAtomHashes, tombstoneMap, tombstoneHMap, tombSet, tombSetH, tombEntry, tombMany, tombEntries };
