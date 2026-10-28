// ============================================================
// core/items-cleanup.js —— **清理未关注角色的物品**（v3.52.2 W34 `应-54` / `数-47`）
//
// 用户要求：「物品新增按钮，可清理未关注角色的物品。注意清理前，需先排查询问用户，
//   列出即将清理掉的物品清单，然后确认后再删除。」
//
// 口径（**先预览后删除**，两步式）：
//   · **候选** = `items[].owner` 非空 且 该 owner **不在**受保护名单（关注名单 + 主角）；
//   · `owner` 为空 / 未归属的物品**一律不动**（没有归属就无从判断，宁可保留）；
//   · 第一步 `itemsCleanupPlan()` **只计算不写**（返回逐条清单 + 分组统计 + 保留原因）；
//   · 第二步由 UI 二次确认（危险动作确认框）后才 `applyItemsCleanup()`：逐条 `deleteEntry('items', id)`
//     → **留双墓碑**（跨端不复活）+ 级联删除关联行，与手动删除同一条路径。
// ============================================================
import { state, dbgLog } from './model/runtime.js';
import { roleProtected } from './snapshot-watch.js';
import { defaultCurrencyOwner } from './model/money.js';
import { deleteEntry } from './entries.js';

/** 名称规范化（去空白 + 忽略大小写） */
function normName(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); }

/** 已知角色名（档案 + 主角；用于「位置 → 归属」推断） */
function knownRoleNames() {
    try {
        const out = [];
        const seen = new Set();
        const add = (n) => { const k = normName(n); if (k && !seen.has(k)) { seen.add(k); out.push(String(n).trim()); } };
        add(defaultCurrencyOwner());
        for (const s of (Array.isArray(state.snapshots) ? state.snapshots : [])) if (s && s.name) add(s.name);
        return out;
    } catch (e) { return []; }
}
/** 位置是否就是某个角色名（精确或互相包含；与货币归属判定同口径） */
function locationRoleOf(location, roles) {
    const l = normName(location);
    if (!l) return '';
    for (const r of roles) {
        const k = normName(r);
        if (k && (k === l || k.indexOf(l) >= 0 || l.indexOf(k) >= 0)) return r;
    }
    return '';
}
/**
 * **有效归属**（v3.52.4）：
 *   ① 显式 `owner` 优先；
 *   ② 否则**推断**：`carried !== false` 且 `location` 命中已知角色名 → 该角色（物品库模板口径：
 *      「位置写角色名或地点名 + 携带=随身携带」，故「位置是角色 + 随身」等价于「在该角色手里」）；
 *   ③ 都不成立 → 空（未归属，清理时不动）。
 * @returns {{owner:string, inferred:boolean}}
 */
function effOwnerOf(it, roles) {
    const explicit = String((it && it.owner) || '').trim();
    if (explicit) return { owner: explicit, inferred: false };
    if (!it || it.carried === false) return { owner: '', inferred: false };
    const byLoc = locationRoleOf(it.location, roles);
    return byLoc ? { owner: byLoc, inferred: true } : { owner: '', inferred: false };
}

/**
 * 生成**只读**清理计划（不写任何数据）。幂等：同一状态多次调用结果一致。
 * @returns {{ok:boolean, items:Array, byOwner:Array, total:number, kept:number, unowned:number, protectedOwners:string[], note:string}}
 */
export function itemsCleanupPlan() {
    try {
        const list = Array.isArray(state.items) ? state.items : [];
        const roles = knownRoleNames();
        const items = [];
        const byOwnerMap = new Map();
        let kept = 0, unowned = 0, inferredCount = 0;
        const protectedOwners = [];
        for (const it of list) {
            if (!it || !it.id) continue;
            const eo = effOwnerOf(it, roles);
            const owner = eo.owner;
            if (owner && eo.inferred) inferredCount += 1;
            if (!owner) { unowned += 1; continue; }
            if (roleProtected(owner)) {
                kept += 1;
                if (protectedOwners.indexOf(owner) < 0 && String(defaultOwnerProtected(owner))) protectedOwners.push(owner);
                continue;
            }
            items.push({ id: String(it.id), name: String(it.name || ''), owner: owner, inferred: eo.inferred, qty: Number(it.qty) || 0, location: String(it.location || ''), carried: it.carried !== false });
            if (!byOwnerMap.has(owner)) byOwnerMap.set(owner, []);
            byOwnerMap.get(owner).push(it);
        }
        const byOwner = [...byOwnerMap.entries()].map(([owner, arr]) => ({ owner: owner, count: arr.length })).sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
        const total = items.length;
        const inferTxt = inferredCount ? ('（其中 ' + inferredCount + ' 件按「位置是角色名且随身携带」推断归属）') : '';
        const note = total
            ? ('即将清理 ' + total + ' 件物品（属于 ' + byOwner.length + ' 个未关注角色）：' + byOwner.slice(0, 5).map((g) => g.owner + '×' + g.count).join('、') + inferTxt + '。确认后删除，跨端不复活。')
            : ('没有需要清理的物品（未归属 ' + unowned + ' 件 / 已保留 ' + kept + ' 件属于关注角色或主角）' + inferTxt);
        return { ok: true, items: items, byOwner: byOwner, total: total, kept: kept, unowned: unowned, inferred: inferredCount, protectedOwners: protectedOwners, note: note };
    } catch (e) {
        return { ok: false, items: [], byOwner: [], total: 0, kept: 0, unowned: 0, protectedOwners: [], note: '清理计划不可用：' + String((e && e.message) || e) };
    }
}
/** 该 owner 是否被保护（给分组统计用；真判定在 roleProtected） */
function defaultOwnerProtected(owner) { try { return roleProtected(owner); } catch (e) { return false; } }

/**
 * **应用**清理（调用方必须已完成二次确认）：逐条走 `deleteEntry('items', id)`（留双墓碑 + 级联关联行）。
 * @param {{items?:Array}} [plan] 省略 = 现算一次
 * @returns {{ok:boolean, removed:number, failed:number, note:string}}
 */
export function applyItemsCleanup(plan) {
    try {
        const p = (plan && Array.isArray(plan.items)) ? plan : itemsCleanupPlan();
        const targets = Array.isArray(p.items) ? p.items : [];
        if (!targets.length) return { ok: true, removed: 0, failed: 0, note: '没有需要清理的物品（数据未改动）' };
        let removed = 0, failed = 0;
        for (const it of targets) {
            try {
                if (deleteEntry('items', String(it.id))) removed += 1; else failed += 1;
            } catch (e) { failed += 1; }
        }
        try { dbgLog('摘要', { action: '清理未关注角色的物品（用户确认后）', removed: removed, failed: failed, owners: (p.byOwner || []).slice(0, 8) }); } catch (e) { /* 忽略 */ }
        return {
            ok: true, removed: removed, failed: failed,
            note: '已清理 ' + removed + ' 件物品' + (failed ? ('（失败 ' + failed + ' 件）') : '') + ' —— 已留删除记录，跨端不会复活',
        };
    } catch (e) { return { ok: false, removed: 0, failed: 0, note: '清理失败：' + String((e && e.message) || e) }; }
}
