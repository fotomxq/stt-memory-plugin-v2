// ============================================================
// core/conflicts.js —— **需人工确认的冲突登记**（v2.92.0；`docs/D10` Q10 同步自检哨兵）
// 用户要求：「如果发生冲突需手动确认的，除了在设定中展示外，还需在**总览页面提示**，方便用户更好的感知。」
// 口径：
//   · 只登记**需要人管**的事（跨端合并冲突、并集自检不通过、快照覆盖面缩小…），**不叫「错误」**（错误走 `warn`/异常通道）；
//   · 按 `kind + detail` 去重，重复发生只累加 `count` 与 `lastAt`，避免刷屏；上限 50 条（超出丢最旧）；
//   · 处理动作只有两种语义：**标记已确认**（人看过了）与**清空**；不做自动「修复」（合并一律并集，宁可多留）；
//   · 持久化由宿主注入（本项目落 ST 扩展设置 `syncConflicts`，**不进数据模型** → DATA_VERSION 不变）。
// ============================================================

export const CONFLICT_CAP = 50;

let hooks = { get: () => [], save: () => undefined, now: () => Date.now() };
let seq = 0;   // 同毫秒插入的稳定次序（避免上限裁剪时误保留最早的那批）
export function setConflictHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function conflictHooks() { return Object.assign({}, hooks); }

function load() {
    try { const a = hooks.get(); return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []; } catch (e) { return []; }
}
function save(list) { try { hooks.save(Array.isArray(list) ? list : []); } catch (e) { /* 落盘失败不影响运行 */ } }

/**
 * 登记一条待人工确认项（按 kind+detail 去重）。
 * @param {{kind:string, detail:string, count?:number, scope?:string}} item
 * @returns {{ok:boolean, id:string, count:number, total:number}}
 */
export function noteConflict(item) {
    const o = item || {};
    const kind = String(o.kind || 'other').slice(0, 40);
    const detail = String(o.detail || '').slice(0, 160);
    const id = kind + '|' + detail;
    const list = load();
    const at = Number(hooks.now()) || Date.now();
    const found = list.filter((x) => String(x.id) === id)[0];
    if (found) {
        found.count = Math.max(1, Number(found.count) || 1) + Math.max(1, Number(o.count) || 1);
        found.lastAt = at;
    } else {
        list.push({ id: id, kind: kind, detail: detail, count: Math.max(1, Number(o.count) || 1), firstAt: at, lastAt: at, seq: ++seq, scope: String(o.scope || '').slice(0, 60) });
    }
    // 最新在前；同毫秒按 seq 倒序（保证超上限时裁掉的是**最早**的那批）
    list.sort((a, b) => ((Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)) || ((Number(b.seq) || 0) - (Number(a.seq) || 0)));
    const next = list.slice(0, CONFLICT_CAP);
    save(next);
    return { ok: true, id: id, count: (found ? found.count : Math.max(1, Number(o.count) || 1)), total: next.length };
}

/** 待确认项列表（副本，倒序：最新在前） */
export function listConflicts() { return load().slice(); }
/** 待确认数量（总览徽标用） */
export function pendingConflictCount() {
    try { return load().reduce((n, x) => n + Math.max(1, Number(x.count) || 1), 0); } catch (e) { return 0; }
}
/** 待确认**条目**数（去重后的种类数） */
export function pendingConflictKinds() { return load().length; }

/** 标记某条已确认（按 id 或 kind） */
export function resolveConflict(idOrKind) {
    const k = String(idOrKind || '');
    const list = load();
    const next = list.filter((x) => String(x.id) !== k && String(x.kind) !== k);
    save(next);
    return { ok: true, removed: list.length - next.length, remain: next.length };
}
/** 全部标记已确认 */
export function clearConflicts() { const n = load().length; save([]); return { ok: true, cleared: n }; }

/** 供 UI 展示的一句话摘要（不泄露内容）：`跨端合并冲突 ×2 · 并集自检异常 ×1` */
export function conflictsSummary() {
    try {
        const list = load();
        if (!list.length) return '';
        return list.map((x) => String(x.kind) + ' ×' + Math.max(1, Number(x.count) || 1)).join(' · ').slice(0, 120);
    } catch (e) { return ''; }
}
/** 复位（测试用） */
export function resetConflicts() { save([]); return true; }
