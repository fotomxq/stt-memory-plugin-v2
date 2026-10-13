// ============================================================
// core/recycle-bin.js —— **「最近删除」的数据层**（v3.46.7，`docs/D22` §4.4 W15 `应-8`）
//
// 来源（`docs/D19` §8 实施规格 `应-8` / §3.4）：
//   「在『设定 → 数据管理』的危险区之前增加『🕳 最近删除（N 条）』只读列表 + 『♻ 恢复选中』
//    （清除对应 id 墓碑）。范围限定为**本机当前作用域**、只读列表 + 单条/批量恢复」；
//   验收 = 「删除 1 条 → 出现在最近删除 → 恢复后…；跨端不复活语义不变（构造合并用例）」。
//
// 与「双墓碑」的关系（`docs/02` §3.1 / §6；`docs/05` §5 **C5**）：
//   · 删除写的是 `state.deleted[维度][id] = 时间戳`（`core/merge.js#tombSet`）+ 一条**内容哈希**墓碑
//     `state.deletedH[维度][哈希] = 时间戳`（`core/sweep.js#applyDeletedToArray` 在学到的时刻按**同一时间戳**补记）；
//   · 恢复 = **清除墓碑**（不搬运条目正文）—— 条目本身早已被删除动作从容器移除。
//     墓碑一清，对端在**同一 id / 同一内容**上就能再次写入，这正是「恢复」的含义。
//
// 本模块只做纯数据（不 import 上层、不碰宿主/DOM），界面与写盘在 `ui/recycle-bin.js`（`docs/05` §5 **C11**）。
// ============================================================
import { state } from './model/runtime.js';
import { DIMENSIONS } from './constants.js';
import { atomIdentityHash } from './model/hash.js';

/** 列表最多返回多少条（只读视图的性能上限；超出按时间倒序截断——截断只影响**本视图**，不动数据） */
export const RECYCLE_BIN_MAX = 200;

/** 维度数据显示键 → 中文标签（取自 `core/constants.js#DIMENSIONS`，不另立一份口径） */
const DIM_LABEL = (() => {
    const m = {};
    try { DIMENSIONS.forEach((d) => { if (d && d.kind) m[String(d.kind)] = String(d.label || d.kind); }); } catch (e) { /* 忽略 */ }
    return m;
})();

/** 维度键 → 中文标签（未知维度回落到键名本身，绝不返回 undefined） */
export function recycleDimLabel(dim) {
    const k = String(dim || '');
    return DIM_LABEL[k] || k;
}

/** 对象 → 数组（缺省给空数组，绝不抛错） */
function objOf(v) {
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** 非空字符串 id（`0` 是合法 id，故不能只判真值） */
function idOk(id) {
    if (id === undefined || id === null) return false;
    const s = String(id);
    return !!s && s !== 'undefined' && s !== 'null';
}

/**
 * **最近删除清单（只读）**。
 *
 * 数据源：当前作用域的 `state.deleted`（id 墓碑）。每条给出「维度 + id + 删除时刻」；
 * 维度按 `DIMENSIONS` 的固定序排列，维度内按时间倒序（新的在前）。
 *
 * @param {{max?:number}} [opts] `max` = 返回上限（默认 `RECYCLE_BIN_MAX`）
 * @returns {{items:Array<{dim:string,label:string,id:string,ts:number,atText:string}>, total:number, truncated:number, dims:number}}
 *   `total` = 截断前的总条数（界面显示「N 条」用这个）；`truncated` = 被截掉的条数。
 */
export function recycleBinList(opts) {
    const max = Math.max(1, Math.round(Number(opts && opts.max) > 0 ? Number(opts.max) : RECYCLE_BIN_MAX));
    const out = [];
    let total = 0;
    try {
        const del = objOf(state.deleted);
        // 维度序：先按 DIMENSIONS 固定序，再把「不在维度表里」的遗留键补在后面（不丢，不静默）
        const known = DIMENSIONS.map((d) => String(d.kind));
        const extra = Object.keys(del).filter((k) => known.indexOf(k) < 0).sort();
        known.concat(extra).forEach((dim) => {
            const m = objOf(del[dim]);
            const rows = [];
            Object.keys(m).forEach((id) => {
                if (!idOk(id)) return;
                rows.push({ dim: dim, label: recycleDimLabel(dim), id: String(id), ts: Number(m[id]) || 0 });
            });
            rows.sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
            rows.forEach((r) => { total++; if (out.length < max) out.push(r); });
        });
    } catch (e) { /* 只读视图：任何异常都退化为空清单，绝不因它中断数据管理页 */ }
    return { items: out, total: total, truncated: Math.max(0, total - out.length), dims: (() => { try { return Object.keys(objOf(state.deleted)).length; } catch (e) { return 0; } })() };
}

/** 维度键 → 运行时容器数组（找不到就返回空数组；`atoms` 等直接同名） */
function arrayOf(dim) {
    try {
        const k = String(dim || '');
        const arr = state[k];
        if (Array.isArray(arr)) return arr;
        // UI kind 与数据容器键的差异（`states` → `currentStates`），与 `ui/panel.js#dataKindOf` 同口径
        if (k === 'states' && Array.isArray(state.currentStates)) return state.currentStates;
        return [];
    } catch (e) { return []; }
}

/**
 * **恢复选中条目** = 清除它们的墓碑（`state.deleted[dim][id]`）。
 *
 * 顺带清**能被精确配对**的内容哈希墓碑（`state.deletedH[dim][hash]`）：删除动作写下 id 墓碑后，清扫会在
 * **同一时间戳**补记内容哈希墓碑（`core/sweep.js#applyDeletedToArray`）。只清 id 墓碑时，若对端把同内容以
 * **新 id** 写回来，那条哈希墓碑仍会拦住它 —— 恢复就会时灵时不灵。
 *
 * 配对口径（**只清能证明是这一条的**，宁可少清不可误清）：
 *   ① 条目仍在容器里（用户删的是重复记录 / 该条被重新写入）→ 现算 `atomIdentityHash`，只清这一条；
 *   ② 条目已不在容器里 → 退化为「同维度 + 同一时间戳」成对清除（删除动作是同时间戳成对写的；
 *      时间戳不等的一律保留，避免误清别的删除留下的墓碑）。
 *
 * **不写盘**：写盘由调用方（界面层）显式 `saveState()`，与仓内「数据动作先改内存再统一落盘」的口径一致。
 *
 * @param {Array<{dim:string,id:string}>} refs 要恢复的条目（维度 + id）
 * @returns {{ok:boolean, restored:number, hashes:number, skipped:number, dims:Object<string,number>}}
 *   `restored` = 真正清掉 id 墓碑的条数；`skipped` = 清单里已不存在（被并发清理）的条数。
 */
export function recycleBinRestore(refs) {
    const res = { ok: true, restored: 0, hashes: 0, skipped: 0, dims: {} };
    try {
        const del = state.deleted = objOf(state.deleted);
        const delH = state.deletedH = objOf(state.deletedH);
        const list = Array.isArray(refs) ? refs : [];
        list.forEach((ref) => {
            try {
                const dim = String((ref && ref.dim) || '');
                const id = (ref && ref.id) === undefined || (ref && ref.id) === null ? '' : String(ref.id);
                if (!dim || !idOk(id)) { res.skipped++; return; }
                const bucket = objOf(del[dim]);
                if (!Object.prototype.hasOwnProperty.call(bucket, id)) { res.skipped++; return; }
                const ts = Number(bucket[id]) || 0;
                delete bucket[id];
                if (Object.keys(bucket).length) del[dim] = bucket; else delete del[dim];
                res.restored++;
                res.dims[dim] = (res.dims[dim] || 0) + 1;
                // 内容哈希墓碑：优先按「本条目的身份哈希」精确清除，取不到才退回「同维度 + 同一时间戳」
                const hb = objOf(delH[dim]);
                let hWant = '';
                try {
                    const live = arrayOf(dim).find((x) => x && String(x.id) === id);
                    if (live) hWant = String(atomIdentityHash(dim, live) || '');
                } catch (e) { hWant = ''; }
                const before = Object.keys(hb).length;
                Object.keys(hb).forEach((h) => {
                    if (hWant ? h === hWant : (ts > 0 && Number(hb[h]) === ts)) { delete hb[h]; res.hashes++; }
                });
                if (before) { if (Object.keys(hb).length) delH[dim] = hb; else delete delH[dim]; }
            } catch (e) { res.skipped++; }
        });
    } catch (e) {
        return { ok: false, restored: 0, hashes: 0, skipped: 0, dims: {}, reason: String((e && e.message) || e) };
    }
    return res;
}

/** 状态快照（界面 / 调试 / 测试用）：只读，不改任何数据 */
export function recycleBinState(opts) {
    const r = recycleBinList(opts);
    return { total: r.total, dims: r.dims, truncated: r.truncated, items: r.items.length };
}
