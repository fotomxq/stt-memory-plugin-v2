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
// v3.45.6（用户报告「货币总是没有同步」）新增：
//   `mergeCurrencyArrays`（货币**逐条并集**：同「归属 + 币种」一条、冲突取新、收支流水并集）、
//   `diffCurrencyData`（货币差异统计：same / onlyLocal / onlyRemote / conflict + 胜负）。
//   一并改动三处口径：① `mergeDataObjects` 的货币从「非原子容器整侧取较新」改为**逐条并集 + 双墓碑**
//   （此前只单向覆盖 → 只差货币时永远丢一侧）；② `crossComputeInfo` 把货币差异并入「是否超集」判据
//   （此前货币差异在差异统计里不可见 → 误判 `replace-remote` / `replace-local` 整体替换）；
//   ③ `consistencyReading` 的口径说明按实测更正（`currencies` / `npcs` **不在** `ATOM_DIM_KEYS` 内）。
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
// v3.45.6：货币收支流水并集（同日期 + 同额 + 同说明视为同一笔，保留最近 12 笔）—— 与入库路径同一个函数
import { mergeMoneyHistory } from './model/money.js';
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
 *   · `count` = `atomEntryCount` = **原子层各大类条数合计**（`ATOM_DIM_KEYS`：情节 / 状态记录 / 角色档案 / 记忆 /
 *     物品 / 计划 / 悬念 / 场景 / 概念 / 平行事件 / 关联层 / 分段总结 / 传言 —— **按该常量自身顺序**，共 13 项）；
 *   · **不含**：墓碑（`deleted` / `deletedH`，它们是 id/内容哈希映射不是条目）、`vars` 一类对象容器、
 *     快照链（`snapStore`）；**另有 `currencies`（货币）与 `npcs`（名册）不计入本数** ——
 *     二者**不在** `ATOM_DIM_KEYS` 内（货币的指纹另由 `dataAggHash` 计入）。
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
            scope: '原子层各大类条数合计（ATOM_DIM_KEYS 共 13 项，按该常量自身顺序）',
            // v3.45.6：本块**按代码实测更正**（旧文案写「不含 links、含货币与名册」—— 与 `ATOM_DIM_KEYS`
            //   的实际内容相反：`links` / `plotSegments` 就在该常量里，`currencies` / `npcs` 不在）。
            includes: ['links', 'plotSegments'],
            excludes: ['deleted', 'deletedH', 'vars', 'snapStore', 'currencies', 'npcs'],
            note: '四处诊断必须引用本读数（同一状态、同一口径、同一时点）；`currencies` / `npcs` **不在** `ATOM_DIM_KEYS` 内故不计入本数（货币另由 `dataAggHash` 计入聚合指纹）；旧口径的差异来源见 docs/D13 §8.10.4',
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

// ==================== v3.45.6：货币（非原子容器）的**逐条合并** ====================
// 用户报告：「货币总是没有同步。」
// 原因（三条同源）：
//   ① `currencies` **不在** `ATOM_DIM_KEYS` 内（见 `core/constants.js`；`docs/D8` R11 裁定「货币暂不纳入哈希」）
//      → `mergeDataObjects` 的原子逐条合并**根本不处理货币**，只把它当作「非原子容器」整侧取较新；
//   ② `dataAggHash` **计入**货币原始 JSON（含 `uses` / `floor*` 等易变字段）→ 两端「只差货币」时 `aggSame=false`，
//      而 `diffAtomData` 又看不见货币 → `crossComputeInfo` 判成 `replace-remote` / `replace-local`（**整体替换**）；
//   ③ 于是：远端信封较新 → 本端独有货币被整维丢掉；本端较新 → 对端货币**永远不被并入**；
//      「立即同步」的 `adoptRemoteEnvelope`（整体替换）更是直接丢弃本端全部货币。
// 本版把货币收敛为与其它维度同口径的处置：**逐条并集 + 冲突取新 + 收支流水并集 + id/内容双墓碑**。
// 有意保持不动的部分（V1 逐字一致，`tests/unit/cross-sync-golden.test.js` 锁定）：
//   `dataAggHash` 的算法与 `atomEntryCount` 的维度集合**一字未改**（改它们会让 V1 黄金样本失效）。

/** 货币比较用的文本归一（去空白 + 小写，与 `core/model/money.js` 的归属 / 币种归一同比） */
function curKeyText(v) { try { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); } catch (e) { return ''; } }
/** 货币比较用的数值归一（`'5'` 与 `5` 视为同值；非法值回原文，避免把 `NaN` 归一成同一个数） */
function curNumText(v) {
    try { const n = Number(v); return Number.isFinite(n) ? String(n) : String(v == null ? '' : v); } catch (e) { return ''; }
}
/** 从条目里取「归属」原文（兼容 V1 原始字段名 `who` / `持有者`） */
function curOwnerOf(it) {
    if (!it || typeof it !== 'object') return '';
    const v = (it.owner !== undefined) ? it.owner : (it['归属'] !== undefined ? it['归属'] : (it.holder !== undefined ? it.holder : it.who));
    return curKeyText(v);
}
/** 从条目里取「币种」原文（兼容 V1 原始字段名 `kind` / `币种` / `currency`） */
function curNameOf(it) {
    if (!it || typeof it !== 'object') return '';
    const v = (it.name !== undefined) ? it.name : (it['币种'] !== undefined ? it['币种'] : (it.currency !== undefined ? it.currency : it.kind));
    return curKeyText(v);
}
/**
 * 货币条目**身份键**：优先「归属 + 币种」（= `core/ingest.js` 与 `core/model/money.js#normalizeCurrency`
 * 的唯一性口径：同一归属 + 同一币种只保留一条；id 本身就是由它派生的 `cur_<hash>`），
 * 二者不全时退回 `id`；再没有 → 空串（**永不合并**，原样保留）。
 */
function currencyIdentityKey(it) {
    try {
        if (!it || typeof it !== 'object') return '';
        const owner = curOwnerOf(it), name = curNameOf(it);
        if (owner && name) return 'on:' + owner + '|' + name;
        const id = String(it.id == null ? '' : it.id);
        return id ? ('id:' + id) : '';
    } catch (e) { return ''; }
}
/**
 * 货币条目**内容签名**（判断「同一条是否内容相同」）：与**账本语义**有关的字段；
 * **不含** `id` / `uses` / `floor*` / `updatedAt` / `nsfw` / 溯源标记等易变或非内容字段 ——
 * 与 `atomContentHash` 的「看变化」口径同理（引用类 / 运行态字段不进哈希）。
 */
function currencyContentSig(it) {
    try {
        if (!it || typeof it !== 'object') return '';
        const hist = (Array.isArray(it.history) ? it.history : []).map(f => String((f && f.date) || '') + '|' + curNumText(f && f.delta) + '|' + String((f && f.note) || ''));
        const tags = (Array.isArray(it.tags) ? it.tags.map(String) : []).slice().sort();
        return [
            'o=' + curOwnerOf(it), 'n=' + curNameOf(it),
            'u=' + curKeyText(it.unit), 'a=' + curNumText(it.amount),
            'note=' + String(it.note == null ? '' : it.note),
            'd=' + String(it.date == null ? '' : it.date),
            't=' + tags.join(','), 'h=' + hist.join(';'),
        ].join('|');
    } catch (e) { return ''; }
}
/**
 * 单条货币冲突仲裁：**条目 `updatedAt` 较新者胜**；并列（多见于两端都没有墙钟的 AI 写入）
 * → **信封时间较新的一侧胜**（`preferRemote` = 远端信封更新）—— 与 `mergeDataObjects` 的原子冲突同口径。
 * @returns {boolean} true = 远端胜
 */
function currencyRemoteWins(l, r, preferRemote) {
    const lw = Number(l && l.updatedAt) || 0;
    const rw = Number(r && r.updatedAt) || 0;
    if (rw !== lw) return rw > lw;
    return !!preferRemote;
}
/**
 * 同一条货币的两份拷贝合并（胜出方为基底；收支流水并集；NSFW / 溯源标记「只升不降 + 补空」）。
 * 口径：**额度 / 单位 / 备注等账本值取胜出方**（它们是「当前持有额」，不是可累加的量）；
 *   **收支流水并集**（`core/model/money.js#mergeMoneyHistory`：同日期 + 同额 + 同说明视为同一笔，保留最近 12 笔），
 *   否则只报收支的那一端流水会被整条覆盖掉。
 */
function mergeCurrencyEntry(l, r, preferRemote) {
    const remoteWins = currencyRemoteWins(l, r, preferRemote);
    const win = JSON.parse(JSON.stringify(remoteWins ? r : l));
    const lose = remoteWins ? l : r;
    try { nsfwMergeLevel(win, lose); } catch (e) { /* 忽略 */ }
    try { mergeEntryProvenance(win, lose); } catch (e) { /* 忽略 */ }
    try {
        const lh = Array.isArray(l && l.history) ? l.history : [];
        const rh = Array.isArray(r && r.history) ? r.history : [];
        if (lh.length || rh.length) {
            const merged = mergeMoneyHistory(lh, rh);
            const cur = Array.isArray(win.history) ? win.history : [];
            // 只有真的并入/变化才写回 `history` —— 让「无收支」的条目与 V1 结果**逐字段一致**
            if (JSON.stringify(merged) !== JSON.stringify(cur)) win.history = merged;
        }
    } catch (e) { /* 忽略 */ }
    return win;
}
/**
 * **货币逐条并集**（纯函数；本地在前、远端在后 → 冲突仲裁取「更新的那一侧」）。
 * @param {Array} localArr 本端货币
 * @param {Array} remoteArr 对端货币
 * @param {{preferRemote?:boolean}} [opts] 冲突并列时是否远端优先（调用方传「远端信封更新」）
 * @returns {Array} 并集后的货币数组（**不修改入参**；无身份键的条目原样保留）
 */
function mergeCurrencyArrays(localArr, remoteArr, opts) {
    try {
        const preferRemote = !!(opts && opts.preferRemote);
        const out = [];
        const idx = Object.create(null);
        const put = (it, isRemote) => {
            if (!it || typeof it !== 'object') return;
            const k = currencyIdentityKey(it);
            if (!k) { out.push(JSON.parse(JSON.stringify(it))); return; }
            const i = idx[k];
            if (i === undefined) { idx[k] = out.length; out.push(JSON.parse(JSON.stringify(it))); return; }
            if (isRemote) out[i] = mergeCurrencyEntry(out[i], it, preferRemote);
        };
        for (const it of (Array.isArray(localArr) ? localArr : [])) put(it, false);
        for (const it of (Array.isArray(remoteArr) ? remoteArr : [])) put(it, true);
        return out;
    } catch (e) { return (Array.isArray(localArr) ? localArr.slice() : []); }
}
/**
 * **货币差异统计**（与 `diffAtomData` 同口径，供 `crossComputeInfo` 判定「是否超集」用）：
 * `same` / `onlyLocal` / `onlyRemote` / `conflict`(+ 胜负)。
 * 注意：`diffAtomData` **不含**货币（它按 `ATOM_DIM_KEYS` 遍历，为保持与 V1 逐字一致不改），
 *   故货币差异必须**单独算一份**，否则「只差货币」会被误判成超集 → 整体替换。
 */
function diffCurrencyData(localData, remoteData) {
    const stat = { same: 0, onlyLocal: 0, onlyRemote: 0, conflict: 0, conflictWinLocal: 0, conflictWinRemote: 0 };
    try {
        const localTs = Number((localData && localData.updatedAt) || 0) || 0;
        const remoteTs = Number((remoteData && remoteData.updatedAt) || 0) || 0;
        const preferRemote = remoteTs > localTs;
        const L = Object.create(null), R = Object.create(null);
        const fill = (d, side) => {
            for (const it of (Array.isArray(d && d.currencies) ? d.currencies : [])) {
                if (!it || typeof it !== 'object') continue;
                const k = currencyIdentityKey(it);
                if (k) side[k] = it;
            }
        };
        fill(localData, L); fill(remoteData, R);
        for (const k of Object.keys(L)) {
            if (!(k in R)) { stat.onlyLocal++; continue; }
            if (currencyContentSig(L[k]) === currencyContentSig(R[k])) { stat.same++; continue; }
            stat.conflict++;
            if (currencyRemoteWins(L[k], R[k], preferRemote)) stat.conflictWinRemote++; else stat.conflictWinLocal++;
        }
        for (const k of Object.keys(R)) if (!(k in L)) stat.onlyRemote++;
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
            // v3.45.6：**货币逐条并集**（用户报告「货币总是没有同步」）——
            //   旧口径把 `currencies` 归入「非原子容器整侧取较新」（见下方列表），于是：
            //   远端较新 → 本端独有货币被整维丢掉；本端较新 → 对端货币永不并入。此处改为与其它维度同口径：
            //   逐条并集（同「归属 + 币种」一条、冲突取新、收支流水并集）+ **同一套 id/内容双墓碑**。
            try {
                const cl = Array.isArray(out.currencies) ? out.currencies : [];
                const cr = Array.isArray(remoteData && remoteData.currencies) ? remoteData.currencies : [];
                if (cl.length || cr.length) {
                    const mergedCur = mergeCurrencyArrays(cl, cr, { preferRemote: remTs > baseTs });
                    const rc = applyDeletedToArray('currencies', mergedCur, delBase, delRem, delHBase, delHRem, true);
                    redBump('currencies', 'tombstone', mergedCur.length - rc.arr.length);   // 货币删除同样跨端生效（合法削减）
                    out.currencies = rc.arr;
                    if (rc.del && Object.keys(rc.del).length) delOut.currencies = rc.del;
                    if (rc.delH && Object.keys(rc.delH).length) delHOut.currencies = rc.delH;
                }
            } catch (e) { /* 忽略 */ }
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
        // v3.45.6：`currencies` **已移出本列表** —— 它在上面走逐条并集（整侧覆盖正是「货币不同步」的成因）
        // v3.50.29（`docs/D20` `数-4` 方案 A）：**登记「哪些容器被整侧取新」**（只读事实，供体检显示），
        //   并如实写清后果：对端对该容器的改动会被**整体丢弃**（`docs/02` §1.2 已显式说明）。
        if (remTs > baseTs && remoteData) {
            const whole = [];
            for (const k of ['summaries', 'npcs', 'protagonist', 'vars', 'varTemplates', 'state']) {
                if (remoteData[k] !== undefined) { out[k] = copyVal(remoteData[k]); whole.push(k); }
            }
            stat.wholeSide = { side: 'remote', dims: whole, baseTs: baseTs, remTs: remTs };
        }
        out.updatedAt = Math.max(baseTs, remTs);
    } catch (e) { /* 忽略 */ }
    stat.conflict = stat.conflictWinLocal + stat.conflictWinRemote;
    // v3.50.29（`docs/D20` `数-4` 方案 A）：`stat.wholeSide` = 本次合并**被整侧取新**的非原子容器（无则缺省）
    if (!stat.wholeSide) stat.wholeSide = null;   // v3.45.1（W6 技-31）：冲突**合计**（旧代码在自检里读 `stat.conflict`，而它此前从未被赋值 → 「跨端合并冲突」永远不登记）
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
    // v3.45.6：货币逐条合并（并集）与货币差异统计（`adapters/sync.js` 与单测共用）
    mergeCurrencyArrays, diffCurrencyData, currencyIdentityKey,
};
