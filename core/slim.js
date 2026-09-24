// ============================================================
// core/slim.js —— **存储瘦身编解码（无损，可逆）**（B9-d，逐字移植自 V1
//   `src/FTT记忆组件-v1.206.js` 的「存储瘦身编解码」段：`SLIM_HASHED_FIELDS`(~5460)、
//   `SLIM_SYNONYM_GROUPS`(~5476)、`isSlimDefault`(~5485)、`slimEntryForStorage`(~5492)、
//   `hydrateSlimEntry`(~5530)、`slimDataForStorage`(~5554)、`hydrateStorageData`(~5574)、
//   `slimSnapshotStoreForStorage`(~5589)、`hydrateSnapshotStore`(~5611)）
//
// V1 需求与结论（原文照录）：
//   · 写盘前剥掉**运行期 / 可重算**字段：不写空值与默认值、`extra` 只保留顶层没有的槽位、
//     同义字段仅在「与哈希字段完全同值」时丢弃（text/content、name/title、pathStr/pathArr…）；
//   · 读盘时 `hydrate` 原样补回 → **内存态与旧版一致**；
//   · 哈希函数已对「缺失的空值」容错（`core/model/hash.js`）→ 瘦身**不改变任何条目的内容哈希**，
//     故跨端 `diffAtomData` / `dataAggHash` 口径不受影响（否则跨端会重复计条目）。
//   · 核心存档只留轻量 `snapIndex`（供展示「有哪些快照」），快照**内容**存独立快照文件
//     （V2 早已有独立快照文件：`adapters/sync.js#snapshotFilePushNow`）。
//
// 适配（与 V1 的唯一差别，逐条明示）：
//   ① 纯内核化：不读写任何模块级 `state`，全部为**纯函数入参**（V1 直接读全局 `state`）；
//   ② `snapshotIndexFrom` 复用 `core/cross-sync.js#snapIndexFrom`（V2 已在 B7-2 移植同名逻辑，
//      不重复实现；语义与 V1 逐字一致）；
//   ③ 本文件**不碰** `CompressionStream` / `DecompressionStream` / 字节流 —— gzip 属宿主/适配层能力
//      （`adapters/gzip.js`），内核保持纯净（scripts/check-core-purity.js 门禁）。
//
// 一致性由 tests/unit/slim-gzip-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { ATOM_DIM_KEYS } from './constants.js';
import { snapIndexFrom } from './cross-sync.js';

/** 各维度参与内容哈希的字段（瘦身时**绝不删除**，同义字段保留的是这些）—— V1 原表逐字 */
export const SLIM_HASHED_FIELDS = {
    atoms: ['text', 'title', 'date', 'time', 'type', 'entities', 'locations', 'tags'],
    currentStates: ['subject', 'field', 'value', 'status'],
    snapshots: ['name', 'identity', 'appearance', 'personality', 'background', 'relationships', 'social', 'future'],
    memories: ['owner', 'date', 'title', 'content', 'memCategory', 'tags'],
    items: ['name', 'qty', 'desc', 'location', 'carried', 'tags'],
    plans: ['content', 'tags', 'status', 'planner', 'participants', 'steps', 'prereq', 'blockers', 'progress', 'history', 'phase', 'statusNote'],
    suspense: ['content', 'tags', 'status', 'clues', 'resolveCondition', 'level', 'history', 'phase', 'statusNote'],
    scenes: ['name', 'pathArr', 'desc'],
    concepts: ['name', 'content', 'source', 'date', 'tags'],
    parallels: ['title', 'text', 'date', 'gua', 'causalLine', 'characters', 'location', 'goalOdds', 'tags', 'promotedTo'],
    // 通用知情关联层（引用类字段不进哈希，但必须参与瘦身白名单/保留判断）
    links: ['dim', 'refId', 'who', 'how', 'from', 'at', 'view', 'deviation', 'note', 'kind', 'public'],
    // 情节分段总结（时间范围 + 逐条剧情线参与哈希；raw/atomIds/manual 不进）
    plotSegments: ['header', 'start', 'end', 'lines'],
    // 传言（主体 / 说法 / 客观性 / 阶段与发酵度 / 传播者 / 载体 / 传导链路 / 谱系 / 联动引用参与哈希）
    rumors: ['subject', 'content', 'objectivity', 'stage', 'ferment', 'carriers', 'media', 'chain', 'source', 'tags', 'parallelRefs', 'pending', 'lineage'],
};

/** 同义字段组（组内只保留「哈希字段」那一份；仅当值完全一致时丢弃其它）—— V1 原表逐字 */
export const SLIM_SYNONYM_GROUPS = {
    atoms: [['text', 'content']],
    currentStates: [['value', 'content']],
    snapshots: [['name', 'title']],
    memories: [],
    items: [['desc', 'content']],
    plans: [],
    suspense: [],
    scenes: [['desc', 'content'], ['name', 'title'], ['pathArr', 'pathStr']],
    concepts: [['name', 'title']],
    parallels: [['text', 'content']],
    links: [],
    plotSegments: [['lines', 'items'], ['header', '时间范围'], ['header', 'title']],
    // 传言（主体 ↔ 标题同值时只留哈希字段）
    rumors: [['subject', 'title'], ['content', 'text']],
};

/** 空值 / 默认值判定（V1 `isSlimDefault`：'' / null / undefined / [] / {} / 0 / false） */
export function isSlimDefault(v) {
    return v === '' || v === null || v === undefined
        || (Array.isArray(v) && v.length === 0)
        || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
        || v === 0 || v === false;
}

/** 单条瘦身（写盘用；`hydrateSlimEntry` 可逆）—— V1 `slimEntryForStorage` 逐字移植 */
export function slimEntryForStorage(cat, it) {
    try {
        if (!it || typeof it !== 'object') return it;
        const hashed = SLIM_HASHED_FIELDS[cat] || [];
        const out = {};
        for (const f of Object.keys(it)) {
            if (f === 'extra') continue;                 // 单独处理
            if (isSlimDefault(it[f])) continue;          // 空值/默认值不写盘（读入由 migrate/哈希归一化兜底）
            out[f] = it[f];
        }
        // 同义字段：只留哈希字段那一份（值一致才丢）
        for (const grp of (SLIM_SYNONYM_GROUPS[cat] || [])) {
            const present = grp.filter(f => out[f] !== undefined);
            if (present.length < 2) continue;
            const keeper = present.find(f => hashed.includes(f)) || present[0];
            const kv = out[keeper];
            for (const f of present) {
                if (f === keeper) continue;
                const same = (f === 'pathStr' && Array.isArray(kv))
                    ? (String(out[f]) === kv.join('>'))
                    : (JSON.stringify(out[f]) === JSON.stringify(kv));
                if (same) delete out[f];
            }
        }
        if (/\.json$/.test(String(out.name || ''))) delete out.name;   // 历史脏数据（把文件名写进了 name）
        // extra：只保留「顶层没有或值不同」的槽位（实测 94% 槽位是顶层字段的重复回显）
        if (Array.isArray(it.extra)) {
            const keep = it.extra.filter((s) => {
                if (!s || typeof s !== 'object') return false;
                const top = it[s.name];
                return !(top !== undefined && JSON.stringify(top) === JSON.stringify(s.value));
            });
            if (keep.length) out.extra = keep;
        }
        return out;
    } catch (e) { return it; }
}

/** 单条还原（读盘用）—— V1 `hydrateSlimEntry` 逐字移植 */
export function hydrateSlimEntry(cat, it) {
    try {
        if (!it || typeof it !== 'object') return it;
        const hashed = SLIM_HASHED_FIELDS[cat] || [];
        for (const grp of (SLIM_SYNONYM_GROUPS[cat] || [])) {
            const present = grp.filter(f => it[f] !== undefined && it[f] !== null);
            if (!present.length) continue;
            const keeper = present.find(f => hashed.includes(f)) || present[0];
            for (const f of grp) {
                if (f === keeper || it[f] !== undefined) continue;
                if (f === 'pathStr' && Array.isArray(it[keeper])) it.pathStr = it[keeper].join('>');
                else if (f === 'pathArr' && typeof it[keeper] === 'string') it.pathArr = String(it[keeper]).split('>');
                else it[f] = it[keeper];
            }
        }
        // 显示层常同时读 name/title（即使不在同义组里）→ 缺一补一
        if (cat === 'scenes' || cat === 'snapshots' || cat === 'concepts' || cat === 'atoms' || cat === 'items' || cat === 'memories' || cat === 'plans' || cat === 'suspense' || cat === 'parallels' || cat === 'rumors') {
            if (it.name === undefined && it.title !== undefined) it.name = it.title;
            if (it.title === undefined && it.name !== undefined) it.title = it.name;
        }
        return it;
    } catch (e) { return it; }
}

/**
 * 数据体瘦身（核心文件：剥快照内容 → 只留 `snapIndex`；条目逐条瘦身；去掉与信封重复的 `scope`）
 * V1 `slimDataForStorage(data, opts)` 逐字移植（`opts.keepSnap=true` 时保留完整链 —— 备份文件用）。
 */
export function slimDataForStorage(data, opts) {
    try {
        const o = Object.assign({}, data);
        if (!(opts && opts.keepSnap)) {
            o.snapIndex = snapIndexFrom(data.snapStore);
            delete o.snapStore;
            delete o.snapFp;
        }
        for (const cat of ATOM_DIM_KEYS) {
            if (Array.isArray(o[cat])) o[cat] = o[cat].map(it => slimEntryForStorage(cat, it));
        }
        delete o.scope;                 // 与信封 scope 重复
        return o;
    } catch (e) { return data; }
}

/** 数据体还原（读文件后调用）—— V1 `hydrateStorageData` 逐字移植 */
export function hydrateStorageData(data) {
    try {
        if (!data || typeof data !== 'object') return data;
        for (const cat of ATOM_DIM_KEYS) {
            if (Array.isArray(data[cat])) data[cat] = data[cat].map(it => hydrateSlimEntry(cat, it));
        }
        return data;
    } catch (e) { return data; }
}

/** 快照轻量索引（供核心存档展示「有哪些快照」，不含内容）—— V1 `snapshotIndexFrom`（V2 别名） */
export const snapshotIndexFrom = snapIndexFrom;

/** 快照链瘦身（写入快照文件用：链内 atoms 副本同样逐条瘦身）—— V1 `slimSnapshotStoreForStorage` 逐字移植 */
export function slimSnapshotStoreForStorage(snaps) {
    try {
        return (Array.isArray(snaps) ? snaps : []).map(s => {
            const o = { id: s.id, kind: s.kind, ts: s.ts, baseId: s.baseId, hash: s.hash };
            if (s.atomsHashes) o.atomsHashes = s.atomsHashes;
            if (s.atoms) {
                const a = {};
                for (const id of Object.keys(s.atoms)) {
                    const atom = s.atoms[id];
                    const cat = (atom && atom.__cat) || 'atoms';
                    a[id] = slimEntryForStorage(cat, atom);
                }
                o.atoms = a;
            }
            if (s.deleted) o.deleted = s.deleted;
            return o;
        });
    } catch (e) { return snaps; }
}

/** 快照链还原（读快照文件后调用）—— V1 `hydrateSnapshotStore` 逐字移植 */
export function hydrateSnapshotStore(snaps) {
    try {
        return (Array.isArray(snaps) ? snaps : []).map(s => {
            if (s && s.atoms) { for (const id of Object.keys(s.atoms)) { const atom = s.atoms[id]; hydrateSlimEntry((atom && atom.__cat) || 'atoms', atom); } }
            return s;
        });
    } catch (e) { return snaps; }
}
