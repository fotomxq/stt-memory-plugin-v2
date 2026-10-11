// ============================================================
// core/cross-sync.js —— **跨端同步内核**（B7-2，逐字移植自 V1 `src/modules/06-存储后端与三型归类.js`）
// 覆盖：`diffAtomData`（差异统计）/ `mergeDataObjects`（原子级双向合并 + 墓碑过滤 + 已处理楼层并集）/
//   `mergeSnapshotStores`（快照链并集重建）/ `dataAggHash`（聚合指纹）/ `atomEntryCount`（条目计数）/
//   `mirrorPushSig`（镜像推送签名门控）/ `snapshotSigOf`（快照链签名）/ `snapIndexFrom`（轻量快照索引）/
//   `mergeProcessedFloors`（已处理楼层并集，楼层正文哈希经 `opts.hashFloor` 注入）。
// v3.45.1（`docs/D22` W6 技-31 / 技-35）新增：
//   `consistencyReading`（一致性单一事实源读数：状态 → `{at, count, fingerprint}`，四处诊断共用）、
//   `capReductionOf`（上限裁剪**干跑**读数，只算不改）、`unionSelfCheck`（并集自检判据：下限扣除三类合法削减）。
//   `mergeDataObjects` 的 `stat` 同时新增 `conflict`（冲突合计）与 `reductions`（去重 / 墓碑削减量，按维度分列）。
// 适配（与 V1 的唯一差别）：
//   ① 纯内核化 —— V1 直接读写 `state`/`hashFloorText`，此处全部改为**纯函数入参**（数据 + 注入的楼层哈希）；
//   ② 逐维度业务合并钩子保留（传言走 `core/model/rumor.js#mergeRumorObjects`，与 V1 `DIM_ENTRY_MERGERS` 同口径）。
// 一致性由 tests/unit/cross-sync-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { ATOM_DIM_KEYS } from './constants.js';
import { nsfwMergeLevel } from './nsfw-level.js';   // v3.8.0：NSFW 等级留档（跨端合并取高）
import { mergeEntryProvenance } from './floor-cover.js';   // v3.22.1：溯源/降级标记「只升不降 + 补空」
import { atomContentHash } from './model/hash.js';
import { storageHash } from './envelope.js';
import { hashText } from './util.js';
import { contentDedupeArray } from './migrate.js';
import { applyDeletedToArray } from './sweep.js';
import { mergeRumorObjects } from './model/rumor.js';
import { capAtomsKeepingHidden } from './merge.js';   // v3.45.1（W6 技-31）：上限裁剪**干跑**（只读数，不改语义）

/**
 * v3.45.1（`docs/D22` W6 **`技-35`**）：**一致性的单一事实源读数**（只读、纯函数）。
 *
 * 真机事实（`docs/D29` §2 第 6 行）：同一份状态同时存在**四个数字** ——
 *   同步口径 **465** · 体检 `items` **488** · 本机层 `localItems` 与主文件解析 **482** · 读取台账「内存态」**479**；
 *   用户与开发者都**无法用一眼读数**判断「两边是否一致」，而 `技-31` 的判据分歧正源于此。
 *
 * 本函数给出**一个**读数（**同一份状态、同一口径、同一时点**）：`{ at, fingerprint, count }`。
 *   口径（写死在这里，四处诊断都必须引用本函数而不是各算各的）：
 *   · `count` = `atomEntryCount` = **原子层各大类条数合计**（`ATOM_DIM_KEYS`：情节 / 状态 / 角色 / 记忆 / 物品 /
 *     计划 / 悬念 / 场景 / 概念 / 平行 / 分段 / 传言 / 名册 …**按该常量自身顺序**）；
 *   · **不含**：墓碑（`deleted` / `deletedH`，它们是 id/内容哈希映射不是条目）、`links` 关联行（引用行）、
 *     `vars` / `vars` 类对象容器、快照链（`snapStore`）；**含**货币与名册（它们在 `ATOM_DIM_KEYS` 里）。
 *   · `fingerprint` = `dataAggHash`（各原子 `id + 内容哈希` 排序聚合 + 非原子容器「货币」）；
 *   · `at` = 取值时刻 —— **四处读数必须在同一时点取**才有可比性（这也是「同一时点」写进返回值的原因）。
 *
 * **四个旧口径的语义标注**（`docs/D13` §8.10 与 `04` 里那四个数字的来历，逐个写明差异来源）：
 * | 旧口径 | 计入什么 | 与 `count` 的差 |
 * | --- | --- | --- |
 * | 同步口径（`atomEntryCount`） | 原子层各大类 | **就是本读数**（基准） |
 * | 体检 `scanned.items` | **所有被扫容器**的条目数，**含 `links` 关联行**、含非原子容器 | 比 `count` 大（关联行被算了进去） |
 * | 本机层 `localItems` / 主文件解析条数 | **信封里存了什么就数什么**（含墓碑审计字段、含 `links`） | 与落盘内容相关，可能比 `count` 大或小 |
 * | 读取台账「内存态」 | **读取动作**的统计（哪一层读到多少条），不是状态快照 | 反映「哪次读了什么」，本身不构成一致性判据 |
 * `docs/D29` §6 **Q2 已裁决**：读数**并入现有出口**（`ftt.dataHealth` / `ftt.loadDiag`），不新开桥方法。
 * @param {object} st 状态（缺省调用方传入；本函数不读全局，保持内核纯净）
 * @returns {{at:number, count:number, fingerprint:string, dims:object, semantics:object}}
 */
function consistencyReading(st) {
    const s = (st && typeof st === 'object') ? st : {};
    const dims = {};
    let count = 0;
    for (const c of ATOM_DIM_KEYS) {
        let n = 0;
        try { n = Array.isArray(s[c]) ? s[c].length : 0; } catch (e) { n = 0; }
        dims[c] = n;
        count += n;
    }
    return {
        at: Date.now(),
        count: count,
        fingerprint: String(dataAggHash(s) || ''),
        dims: dims,
        semantics: {
            scope: '原子层各大类条数合计（ATOM_DIM_KEYS）',
            excludes: ['deleted', 'deletedH', 'links', 'vars', 'snapStore'],
            includes: ['currencies', 'npcs'],
            note: '四处诊断必须引用本读数（同一状态、同一口径、同一时点）；旧口径的差异来源见 docs/D13 §8.10',
        },
    };
}

/**
 * 条目计数（各大类原子合计；V1 `atomEntryCount`） */
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
    const stat = { added: 0, conflictWinLocal: 0, conflictWinRemote: 0, same: 0, conflict: 0, reductions: { dedupe: 0, tombstone: 0, byDim: {} } };
    const red = stat.reductions;
    const redBump = (cat, key, n) => {
        const v = Math.max(0, Number(n) || 0);
        if (!v) return;
        red[key] += v;
        const d = red.byDim[cat] || (red.byDim[cat] = { dedupe: 0, tombstone: 0 });
        d[key] += v;
    };
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
                if (hL && hL === hR) {
                    nsfwMergeLevel(L[id], R[id]);                 // v3.8.0：留档取高
                    mergeEntryProvenance(L[id], R[id]);            // v3.22.1：内容相同 ≠ 标记相同（标记不参与内容哈希），同样只升不降
                    merged.push(L[id]); stat.same++; continue;
                }
                const lw = Number(L[id].updatedAt) || 0, rw = Number(R[id].updatedAt) || 0;
                const winRemote = rw > lw || (rw === lw && remTs > baseTs);
                const dimMerger = DIM_ENTRY_MERGERS[cat];
                if (dimMerger) {
                    let custom = null;
                    try { custom = dimMerger(copyVal(L[id]), copyVal(R[id]), { winRemote, baseTs, remTs }); } catch (e) { custom = null; }
                    if (custom) { merged.push(custom); if (winRemote) stat.conflictWinRemote++; else stat.conflictWinLocal++; continue; }
                }
                const winner = winRemote ? copyVal(R[id]) : L[id];
                // v3.8.0：**NSFW 等级留档只升不降** —— 胜出条目的文本可能被弱化过，另一侧的「强」不能被丢掉
                nsfwMergeLevel(winner, winRemote ? L[id] : R[id]);
                // v3.22.1：**溯源 / 降级标记同样只升不降、位置指纹只补空** ——
                //   否则「较旧那份副本没有 originGone / floorNow*」时，标记会随整对象替换而消失，
                //   被判「原文已移除」的旧聊天情节会复活成活情节并把时钟压回旧故事线（真机取证见 core/floor-cover.js#mergeEntryProvenance）。
                mergeEntryProvenance(winner, winRemote ? L[id] : R[id]);
                merged.push(winner);       // 本地胜出 → 复用克隆树内对象
                if (winRemote) stat.conflictWinRemote++; else stat.conflictWinLocal++;
            }
            for (const id of Object.keys(R)) { if (id in L) continue; merged.push(copyVal(R[id])); stat.added++; }
            // 合并后按内容哈希去重（同内容异 id 只留较新一条，防条数/体积跨端漂移）
            // v3.45.1（W6 技-31）：**去重削减量入账** —— 它会让条数合法地下降，必须与「真丢失」区分开
            if (merged.length > 1) { const n0 = merged.length; merged = contentDedupeArray(cat, merged); redBump(cat, 'dedupe', n0 - merged.length); }
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
                redBump(cat, 'tombstone', arr.length - r.arr.length);   // 墓碑命中（跨端删除传播，合法削减）
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
    stat.conflict = stat.conflictWinLocal + stat.conflictWinRemote;   // v3.45.1（W6 技-31）：冲突**合计**（旧代码在自检里读 `stat.conflict`，而它此前从未被赋值 → 「跨端合并冲突」永远不登记）
    return { data: out, stat };
}

/**
 * v3.45.1（`docs/D22` W6 **`技-31`**）：**上限裁剪干跑读数**（纯函数，只算不改）。
 *
 * 真机事实（`docs/D29` §2 第 2 行）：合并自检登记「并集自检异常」（`115 → 20`），而合并实现本身还会做
 * 内容去重（`contentDedupeArray`）、墓碑过滤（`applyDeletedToArray`）与**上限裁剪**
 * （`core/merge.js#capAtomsKeepingHidden`，真正落库点在 `core/ingest.js` 的 ingest 路径）；
 * 三者都会让 `after < unionMin` —— 旧判据必然误报，且**真丢失无法与误报区分**。
 *
 * 本函数给出「若此刻执行上限裁剪会削掉几条」的**只读**估计（隐藏条目永不裁剪，与 `capAtomsKeepingHidden` 同口径），
 * 供 `adapters/sync.js` 的自检**扣减**用 —— 它**不修改**入参数组，也不改变任何保存语义。
 * @param {Array} arr 候选条目（通常 `state.atoms`）
 * @param {number} cap 该维度存储上限（`core/ingest.js#storeCapFor('atoms')`）
 * @returns {{cap:number, before:number, after:number, hit:number}}
 */
function capReductionOf(arr, cap) {
    try {
        const list = Array.isArray(arr) ? arr : [];
        const n = Math.max(1, Number(cap) || 1);
        const kept = capAtomsKeepingHidden(list, n);
        const after = Array.isArray(kept) ? kept.length : list.length;
        return { cap: n, before: list.length, after: after, hit: Math.max(0, list.length - after) };
    } catch (e) { return { cap: 0, before: 0, after: 0, hit: 0 }; }
}

/**
 * v3.45.1（`docs/D22` W6 **`技-31`**）：**并集自检判据**（纯函数，可单测；`docs/D29` §3.2 与 §8 `技-31` 行）。
 *
 * 修正后的下限：`并集下限 = max(本端合并前条数, 远端合并前条数) − 墓碑命中 − 内容去重命中 − 上限裁剪命中`
 *   —— 三个削减量**分别回报**（`docs/D29` R1 明确要求「不合并成一个数」），只有**修正后仍低于下限**才判异常。
 * 如此：三类合法削减不再误报；而「同 id 被丢弃且无墓碑 / 无去重 / 无裁剪可解释」的**真丢失**仍然报警
 *   （`unexplained` = 差多少条没有解释，用于待确认项文案）。
 *
 * 反向探针（`docs/D29` R1）：构造真丢失用例 → `anomaly === true`；构造三类合法削减用例 → `anomaly === false`。
 * @param {{beforeLocal:number, beforeRemote:number, after:number, reductions?:{dedupe?:number,tombstone?:number,cap?:number}}} input
 * @returns {{unionMin:number, after:number, lowerBound:number, reductions:{dedupe:number,tombstone:number,cap:number,total:number}, anomaly:boolean, unexplained:number, detail:string}}
 */
function unionSelfCheck(input) {
    const i = (input && typeof input === 'object') ? input : {};
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const beforeLocal = num(i.beforeLocal);
    const beforeRemote = num(i.beforeRemote);
    const after = num(i.after);
    const r = (i.reductions && typeof i.reductions === 'object') ? i.reductions : {};
    const dedupe = num(r.dedupe), tombstone = num(r.tombstone), cap = num(r.cap);
    const total = dedupe + tombstone + cap;
    const unionMin = Math.max(beforeLocal, beforeRemote);
    const lowerBound = Math.max(0, unionMin - total);
    const anomaly = after < lowerBound;
    const unexplained = anomaly ? (lowerBound - after) : 0;
    const detail = anomaly
        ? '仍有 ' + unexplained + ' 条无解释地消失（下限 ' + lowerBound + ' 条 = 合并前较大者 ' + unionMin
          + '〔本端 ' + beforeLocal + ' / 远端 ' + beforeRemote + '〕− 合法削减 ' + total
          + '〔墓碑 ' + tombstone + ' / 去重 ' + dedupe + ' / 裁剪 ' + cap + '〕，合并后 ' + after + ' 条）'
        : '通过：合并后 ' + after + ' 条 ≥ 下限 ' + lowerBound + ' 条（合并前较大者 ' + unionMin
          + ' − 合法削减 ' + total + '〔墓碑 ' + tombstone + ' / 去重 ' + dedupe + ' / 裁剪 ' + cap + '〕）';
    return { unionMin, after, lowerBound, reductions: { dedupe, tombstone, cap, total }, anomaly, unexplained, detail };
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
    consistencyReading, capReductionOf, unionSelfCheck,
};
