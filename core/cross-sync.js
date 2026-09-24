// ============================================================
// core/cross-sync.js —— **跨端同步内核**（B7-2，逐字移植自 V1 `src/modules/06-存储后端与三型归类.js`）
// 覆盖：`diffAtomData`（差异统计）/ `mergeDataObjects`（原子级双向合并 + 墓碑过滤 + 已处理楼层并集）/
//   `mergeSnapshotStores`（快照链并集重建）/ `dataAggHash`（聚合指纹）/ `atomEntryCount`（条目计数）/
//   `mirrorPushSig`（镜像推送签名门控）/ `snapshotSigOf`（快照链签名）/ `snapIndexFrom`（轻量快照索引）/
//   `mergeProcessedFloors`（已处理楼层并集，楼层正文哈希经 `opts.hashFloor` 注入）。
// 适配（与 V1 的唯一差别）：
//   ① 纯内核化 —— V1 直接读写 `state`/`hashFloorText`，此处全部改为**纯函数入参**（数据 + 注入的楼层哈希）；
//   ② 逐维度业务合并钩子保留（传言走 `core/model/rumor.js#mergeRumorObjects`，与 V1 `DIM_ENTRY_MERGERS` 同口径）。
// 一致性由 tests/unit/cross-sync-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { ATOM_DIM_KEYS } from './constants.js';
import { atomContentHash } from './model/hash.js';
import { storageHash } from './envelope.js';
import { hashText } from './util.js';
import { contentDedupeArray } from './migrate.js';
import { applyDeletedToArray } from './sweep.js';
import { mergeRumorObjects } from './model/rumor.js';

/** 条目计数（各大类原子合计；V1 `atomEntryCount`） */
function atomEntryCount(d) {
    let n = 0;
    for (const c of ATOM_DIM_KEYS) { try { n += ((d && d[c]) || []).length; } catch (e) { /* 忽略 */ } }
    return n;
}

/**
 * 数据聚合指纹（V1 `dataAggHash`）：各原子 `id + 内容哈希` 排序后聚合；
 * 另计入**非原子容器**（货币）—— 否则「两端只差货币」会被判成 same（永不合并）。
 */
function dataAggHash(d) {
    try {
        if (!d || typeof d !== 'object') return '';
        const parts = [];
        for (const cat of ATOM_DIM_KEYS) {
            const arr = d[cat] || [];
            for (const it of arr) {
                if (!it || typeof it !== 'object') continue;
                const id = String(it.id || '');
                const h = atomContentHash(cat, it) || '';
                parts.push(cat + ':' + id + ':' + h);
            }
        }
        for (const k of ['currencies']) {
            try { parts.push(k + ':@' + storageHash(JSON.stringify(d[k] === undefined ? null : d[k]))); } catch (e) { /* 忽略 */ }
        }
        parts.sort();
        return storageHash(parts.join('|'));
    } catch (e) { return ''; }
}

/** 原子差异统计（只读诊断）：same / onlyLocal / onlyRemote / conflict(同 id 不同内容哈希) */
function diffAtomData(localData, remoteData) {
    const stat = { same: 0, onlyLocal: 0, onlyRemote: 0, conflict: 0, conflictWinLocal: 0, conflictWinRemote: 0 };
    const localTs = Number((localData && localData.updatedAt) || 0) || 0;
    const remoteTs = Number((remoteData && remoteData.updatedAt) || 0) || 0;
    try {
        const maps = {};
        for (const cat of ATOM_DIM_KEYS) maps[cat] = { L: {}, R: {} };
        const fill = (d, side) => { for (const cat of ATOM_DIM_KEYS) { const arr = (d && d[cat]) || []; for (const it of arr) { if (it && typeof it === 'object' && it.id) maps[cat][side][String(it.id)] = it; } } };
        fill(localData, 'L'); fill(remoteData, 'R');
        for (const cat of ATOM_DIM_KEYS) {
            const L = maps[cat].L, R = maps[cat].R;
            for (const id of Object.keys(L)) {
                if (!(id in R)) { stat.onlyLocal++; continue; }
                const hL = atomContentHash(cat, L[id]), hR = atomContentHash(cat, R[id]);
                if (hL && hL === hR) stat.same++;
                else {
                    stat.conflict++;
                    const lw = Number(L[id].updatedAt) || 0, rw = Number(R[id].updatedAt) || 0;
                    if (rw > lw) stat.conflictWinRemote++;
                    else if (lw > rw) stat.conflictWinLocal++;
                    else if (remoteTs > localTs) stat.conflictWinRemote++;
                    else stat.conflictWinLocal++;
                }
            }
            for (const id of Object.keys(R)) if (!(id in L)) stat.onlyRemote++;
        }
    } catch (e) { /* 忽略 */ }
    return stat;
}

/**
 * 已处理楼层并集（V1 `mergeProcessedFloors`）：双端各自分析的区段互相保留；
 * 同楼层哈希不一致时以「与当前楼层正文哈希一致」的一侧为准（仍不一致则保留本地）。
 * @param {Array} a 本地已处理楼层
 * @param {Array} b 远端已处理楼层
 * @param {Function} [hashFloor] 楼层正文哈希解析器（V1 `hashFloorText`）；缺省时退化为「保留本地」
 */
function mergeProcessedFloors(a, b, hashFloor) {
    try {
        const map = new Map();
        const put = (x) => { const f = Number(x && x.f); if (Number.isFinite(f)) map.set(f, { f, h: String((x && x.h) || '') }); };
        for (const x of (a || [])) put(x);
        for (const x of (b || [])) put(x);
        const localH = new Map((a || []).map(x => [Number(x && x.f), String((x && x.h) || '')]));
        for (const x of (b || [])) {
            const f = Number(x && x.f); if (!Number.isFinite(f)) continue;
            const lh = localH.get(f);
            const nh = String((x && x.h) || '');
            if (lh === undefined || lh === nh) continue;              // 仅本地 / 双端一致 → 保留现状
            let cur = ''; try { cur = hashFloor ? String(hashFloor(f) || '') : ''; } catch (e) { cur = ''; }
            const win = (nh && nh === cur) ? nh : lh;                 // 与当前正文一致者胜出；否则保留本地
            const e = map.get(f); if (e) e.h = win;
        }
        return Array.from(map.values()).sort((m, n) => m.f - n.f);
    } catch (e) { return (a || []).slice(); }
}

/** 逐维度业务合并钩子（V1 `DIM_ENTRY_MERGERS`；目前仅传言做字段级并集） */
const DIM_ENTRY_MERGERS = { rumors: (a, b, ctx) => mergeRumorObjects(a, b, ctx) };

/**
 * 原子级合并：远端并入本地（本地独有保留 / 远端独有补齐 / 冲突按更新方胜 → 同墙钟取数据更新的那侧）。
 * @param {object} baseData 本地数据
 * @param {object} remoteData 远端数据
 * @param {object} [opts] hashFloor（楼层哈希解析器，供已处理楼层并集用）
 * @returns {{data:object, stat:{added:number, conflictWinLocal:number, conflictWinRemote:number, same:number}}}
 */
function mergeDataObjects(baseData, remoteData, opts) {
    const out = JSON.parse(JSON.stringify(baseData || {}));
    const stat = { added: 0, conflictWinLocal: 0, conflictWinRemote: 0, same: 0 };
    const baseTs = Number((baseData && baseData.updatedAt) || 0) || 0;
    const remTs = Number((remoteData && remoteData.updatedAt) || 0) || 0;
    const copyVal = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
    const hashFloor = opts && opts.hashFloor;
    try {
        const maps = {};
        for (const cat of ATOM_DIM_KEYS) maps[cat] = { L: {}, R: {} };
        // 本地侧从**已深拷贝的 out** 取条目（本地独有 / 内容相同 / 本地胜出三条分支直接复用克隆树内对象）
        const fill = (d, side) => { for (const cat of ATOM_DIM_KEYS) { const arr = (d && d[cat]) || []; for (const it of arr) { if (it && typeof it === 'object' && it.id) maps[cat][side][String(it.id)] = it; } } };
        fill(out, 'L'); fill(remoteData, 'R');
        for (const cat of ATOM_DIM_KEYS) {
            const L = maps[cat].L, R = maps[cat].R;
            let merged = [];
            for (const id of Object.keys(L)) {
                if (!(id in R)) { merged.push(L[id]); continue; }
                const hL = atomContentHash(cat, L[id]), hR = atomContentHash(cat, R[id]);
                if (hL && hL === hR) { merged.push(L[id]); stat.same++; continue; }
                const lw = Number(L[id].updatedAt) || 0, rw = Number(R[id].updatedAt) || 0;
                const winRemote = rw > lw || (rw === lw && remTs > baseTs);
                const dimMerger = DIM_ENTRY_MERGERS[cat];
                if (dimMerger) {
                    let custom = null;
                    try { custom = dimMerger(copyVal(L[id]), copyVal(R[id]), { winRemote, baseTs, remTs }); } catch (e) { custom = null; }
                    if (custom) { merged.push(custom); if (winRemote) stat.conflictWinRemote++; else stat.conflictWinLocal++; continue; }
                }
                merged.push(winRemote ? copyVal(R[id]) : L[id]);       // 本地胜出 → 复用克隆树内对象
                if (winRemote) stat.conflictWinRemote++; else stat.conflictWinLocal++;
            }
            for (const id of Object.keys(R)) { if (id in L) continue; merged.push(copyVal(R[id])); stat.added++; }
            // 合并后按内容哈希去重（同内容异 id 只留较新一条，防条数/体积跨端漂移）
            if (merged.length > 1) merged = contentDedupeArray(cat, merged);
            if (merged.length || (out[cat] || []).length) out[cat] = merged;
        }
        // 跨端删除墓碑应用（id + 内容哈希；合并后过滤，删除跨端传播、不复活）
        try {
            const delBase = (baseData && baseData.deleted) || {};
            const delRem = (remoteData && remoteData.deleted) || {};
            const delHBase = (baseData && baseData.deletedH) || {};
            const delHRem = (remoteData && remoteData.deletedH) || {};
            const delOut = {}, delHOut = {};
            for (const cat of ATOM_DIM_KEYS) {
                const arr = Array.isArray(out[cat]) ? out[cat] : [];
                const r = applyDeletedToArray(cat, arr, delBase, delRem, delHBase, delHRem, true);
                if (r.arr.length || (out[cat] && out[cat].length)) out[cat] = r.arr;
                else if (Array.isArray(out[cat]) && !out[cat].length && (delBase[cat] || delRem[cat])) out[cat] = r.arr;
                if (r.del && Object.keys(r.del).length) delOut[cat] = r.del;
                if (r.delH && Object.keys(r.delH).length) delHOut[cat] = r.delH;
            }
            const hadAny = ((delBase && Object.keys(delBase).length) || (delRem && Object.keys(delRem).length));
            const hadAnyH = ((delHBase && Object.keys(delHBase).length) || (delHRem && Object.keys(delHRem).length));
            if (Object.keys(delOut).length || hadAny) out.deleted = delOut;
            if (Object.keys(delHOut).length || hadAnyH) out.deletedH = delHOut;
        } catch (e) { /* 忽略 */ }
        // 已处理楼层为可并集数据（双端各自分析的区段互相保留）
        try {
            const pa = (baseData && baseData.processedFloors) || [], pb = (remoteData && remoteData.processedFloors) || [];
            if (pa.length || pb.length) out.processedFloors = mergeProcessedFloors(pa, pb, hashFloor);
        } catch (e) { /* 忽略 */ }
        // 非原子维度：整体取较新一侧（时间相同保留本地）
        if (remTs > baseTs && remoteData) {
            for (const k of ['summaries', 'npcs', 'protagonist', 'vars', 'varTemplates', 'state', 'currencies']) {
                if (remoteData[k] !== undefined) out[k] = copyVal(remoteData[k]);
            }
        }
        out.updatedAt = Math.max(baseTs, remTs);
    } catch (e) { /* 忽略 */ }
    return { data: out, stat };
}

/**
 * 快照链并集重建：双方快照按「atomsHashes 内容」去重、按 ts 排序
 * （不同设备链可共存为单一可还原历史）。
 */
function mergeSnapshotStores(localSnaps, remoteSnaps) {
    try {
        const byKey = new Map();
        const push = (sp) => { if (!sp || typeof sp !== 'object') return; let k = ''; try { k = JSON.stringify(sp.atomsHashes || {}); } catch (e) { k = String(sp.id || ''); } if (k && !byKey.has(k)) byKey.set(k, sp); };
        (localSnaps || []).forEach(push);
        (remoteSnaps || []).forEach(push);
        return Array.from(byKey.values()).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    } catch (e) { return (localSnaps || []).slice(); }
}

/** 快照链签名（id+ts 列表哈希）：未变化不重复上传（省流量） */
function snapshotSigOf(snaps) {
    try {
        const arr = Array.isArray(snaps) ? snaps : [];
        return hashText(arr.map(s => String((s && s.id) || '') + ':' + String((s && s.ts) || '')).join('|'));
    } catch (e) { return ''; }
}

/** 轻量快照索引（V1 `snapshotIndexFrom`：写主文件时用，只留 id/kind/ts/baseId/hash/覆盖数） */
function snapIndexFrom(snaps) {
    try {
        return (Array.isArray(snaps) ? snaps : []).map(s => ({
            id: s && s.id, kind: s && s.kind, ts: s && s.ts, baseId: s && s.baseId, hash: s && s.hash,
            covered: s && s.atomsHashes ? Object.keys(s.atomsHashes).length : 0,
        })).filter(x => x.id);
    } catch (e) { return []; }
}

/**
 * 镜像推送签名（V1 `mirrorPushSig`）：内容（原子聚合哈希 + 非原子关键字段）未变化 → 跳过写回。
 * 注意：签名**不含 updatedAt**（每次保存都会刷新它，否则永远「变了」）。
 */
function mirrorPushSig(d) {
    try {
        const s = d || {};
        const parts = [dataAggHash(s)];
        parts.push(JSON.stringify(s.vars || {}));
        parts.push(JSON.stringify(s.state || {}));
        parts.push(JSON.stringify(s.protagonist || {}));
        parts.push(JSON.stringify(s.stats || {}));
        parts.push(JSON.stringify(s.deleted || {}));
        parts.push(String((s.summaries || []).length));
        parts.push(String((s.snapStore || []).length));
        return hashText(parts.join('|'));
    } catch (e) { return ''; }
}

export {
    atomEntryCount, dataAggHash, diffAtomData, mergeDataObjects, mergeProcessedFloors,
    mergeSnapshotStores, snapshotSigOf, snapIndexFrom, mirrorPushSig, DIM_ENTRY_MERGERS,
};
