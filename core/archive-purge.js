// ============================================================
// core/archive-purge.js —— **删除「其它存档」（非当前聊天存档）的全部数据**（v3.52.16）
//
// 用户要求（原话）：「设置的删除角色删除数据位置，新增其他删除选择。包括删除非当前存档的其他存档数据。
//   该操作可以删除非当前存档的其他所有存档数据。」
//
// 事实背景（`core/archive-scope.js`）：记忆容器按**角色**存，同一角色的多条聊天存档共用一份容器；
//   v3.52.7 起按 `chatKey` 分区 —— 其它存档的条目**默认隐藏**且不参与注入/清理，但**仍占空间**。
//   本模块给出一个**显式、不可逆**的出口：只删「其它存档」（`chatKey` 非空且 ≠ 当前存档）的条目。
//
// 口径（与手动删除同一路径，保证一致性）：
//   · 逐条走 `core/entries.js#deleteEntry` → **写双墓碑**（跨端不复活）+ 级联关联行 / 货币流水等；
//   · **不动**当前存档与「历史遗留（无归属）」—— 后者没有归属，无法安全判定为「其它存档」；
//   · 楼层台账：删掉 `processedFloors` / `processedDropped` 里**属于其它存档的标记**（`ck` 非空且 ≠ 当前）；
//   · 关联行 / 账本 / 长期收支 / 分段总结：相同 `chatKey` 判定，随所属容器一起清；
//   · 当前存档键未知 → **拒绝执行**（`no-current-archive`）：判不出来就绝不猜着删。
// ============================================================
import { state, saveState, dbgLog } from './model/runtime.js';
import { currentArchiveKey, entryArchiveKey } from './archive-scope.js';
import { deleteEntry } from './entries.js';

/** 参与清理的容器（与 `KIND_MAP` 对齐；links / 楼层台账单独处理） */
const PURGE_DIMS = Object.freeze([
    'atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense',
    'concepts', 'scenes', 'npcs', 'rumors', 'parallels', 'currencies', 'maps',
    'plotSegments', 'ledger', 'deals',
]);

/** 该条目是否属于「其它存档」（有归属且 ≠ 当前） */
function isOtherArchive(x, cur) {
    const k = entryArchiveKey(x);
    return !!k && k !== cur;
}

/**
 * 删除「其它存档」的全部数据（**不可逆**；调用方必须已经二次确认）。
 * @returns {{ok:boolean, reason?:string, removed:number, dims:object, marks:number, links:number, note:string}}
 */
export function purgeOtherArchives() {
    const out = { ok: false, reason: '', removed: 0, dims: {}, marks: 0, links: 0, note: '' };
    try {
        const cur = currentArchiveKey();
        if (!cur) return Object.assign(out, { ok: false, reason: 'no-current-archive', note: '无法删除其它存档：当前存档标识读不到（宿主未提供聊天元数据）' });
        // ① 各维度条目：走统一删除路径（墓碑 + 级联）
        for (const dim of PURGE_DIMS) {
            const arr = Array.isArray(state[dim]) ? state[dim] : null;
            if (!arr || !arr.length) continue;
            const ids = arr.filter((x) => x && isOtherArchive(x, cur)).map((x) => String(x.id || '')).filter(Boolean);
            if (!ids.length) continue;
            let n = 0;
            for (const id of ids) {
                try { if (deleteEntry(dim, id)) n += 1; } catch (e) { /* 忽略：单条失败不中断其余（逐条独立） */ }
            }
            if (n) { out.dims[dim] = n; out.removed += n; }
        }
        // ② 关联行：按自身归属清理（删掉条目后它们已是孤儿；这里一并清，避免残留）
        try {
            const links = Array.isArray(state.links) ? state.links : [];
            const keep = links.filter((x) => !(x && isOtherArchive(x, cur)));
            if (keep.length !== links.length) { out.links = links.length - keep.length; state.links = keep; }
        } catch (e) { /* 忽略 */ }
        // ③ 楼层台账：删掉其它存档的标记与留痕（含 `ck` 非空且 ≠ 当前）
        try {
            const dropMarks = (key) => {
                const arr = Array.isArray(state[key]) ? state[key] : [];
                const keep = arr.filter((x) => !(x && String((x.ck || '') || '').trim() && String(x.ck) !== cur));
                const n = arr.length - keep.length;
                if (n) state[key] = keep;
                return n;
            };
            out.marks = dropMarks('processedFloors') + dropMarks('processedDropped');
        } catch (e) { /* 忽略 */ }
        if (out.removed || out.links || out.marks) {
            try { saveState(); } catch (e) { /* 忽略：落盘失败不影响内存已完成的清理 */ }
            try {
                dbgLog('摘要', {
                    action: '删除其它存档数据（用户确认后）', currentArchive: cur.slice(0, 12),
                    removed: out.removed, dims: out.dims, links: out.links, marks: out.marks,
                });
            } catch (e) { /* 忽略 */ }
        }
        const bits = [];
        if (out.removed) bits.push('条目 ' + out.removed + ' 条（' + Object.keys(out.dims).map((k) => k + ' ' + out.dims[k]).join(' / ') + '）');
        if (out.links) bits.push('关联行 ' + out.links + ' 行');
        if (out.marks) bits.push('楼层台账 ' + out.marks + ' 条');
        out.note = bits.length
            ? ('已删除其它存档数据：' + bits.join(' · ') + ' —— 已留删除记录，跨端不会复活')
            : '没有其它存档的数据需要删除（当前存档与历史遗留均未改动）';
        out.ok = true;
        return out;
    } catch (e) {
        return Object.assign(out, { ok: false, reason: 'error', note: '删除其它存档失败：' + String((e && e.message) || e) });
    }
}
