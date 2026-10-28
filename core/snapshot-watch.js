// ============================================================
// core/snapshot-watch.js —— **角色关注名单**（v3.52.2 W34 `数-47`）
//
// 用户要求：「角色新增标记功能，将角色标记为关注，避免被自动清理。」
//
// 口径：
//   · 关注 = `snapshots[].watch === true`（用户标记，**不进内容哈希**，不参与跨端内容仲裁）；
//   · 被关注的档案在两类**自动清理**里豁免：① 存档上限裁剪（`core/ingest.js#enforceDimCaps`）
//     ② 通用遗忘清扫（`core/forget.js` 低使用清扫的 snapshots 项）；
//   · 「关注名单」也用于物品清理（`core/items-cleanup.js`）：未关注角色的物品才是候选；
//   · 主角恒在豁免名单（`defaultCurrencyOwner()` 判定），不需要额外标记。
// ============================================================
import { state } from './model/runtime.js';
import { defaultCurrencyOwner } from './model/money.js';

/** 名称规范化（去空白 + 忽略大小写；与货币归属判定同口径） */
function normName(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); }

/** 是否被关注 */
export function snapshotWatched(snap) { return !!(snap && snap.watch === true); }

/** 关注名单（角色名数组；去重） */
export function watchedRoleNames() {
    try {
        const list = Array.isArray(state.snapshots) ? state.snapshots : [];
        const out = [];
        const seen = new Set();
        for (const s of list) {
            if (!s || !snapshotWatched(s)) continue;
            const n = String(s.name || '').trim();
            if (!n || seen.has(normName(n))) continue;
            seen.add(normName(n));
            out.push(n);
        }
        return out;
    } catch (e) { return []; }
}

/**
 * 该角色名是否**受保护**（关注 或 主角）。
 * @param {string} name
 * @returns {boolean}
 */
export function roleProtected(name) {
    const n = normName(name);
    if (!n) return false;
    try {
        if (normName(defaultCurrencyOwner()) === n) return true;
        return watchedRoleNames().some((x) => {
            const k = normName(x);
            return k === n || k.indexOf(n) >= 0 || n.indexOf(k) >= 0;
        });
    } catch (e) { return false; }
}

/**
 * 切换某条档案的关注态（按 id 或姓名查找）。
 * @param {string} idOrName
 * @param {boolean} [force] 省略 = 取反
 * @returns {{ok:boolean, watch?:boolean, name?:string, note:string}}
 */
export function toggleSnapshotWatch(idOrName, force) {
    try {
        const key = String(idOrName || '');
        const list = Array.isArray(state.snapshots) ? state.snapshots : [];
        const s = list.filter((x) => x && (String(x.id) === key || String(x.name) === key))[0];
        if (!s) return { ok: false, note: '未找到该角色档案' };
        const next = (force === undefined || force === null) ? (s.watch !== true) : force === true;
        if (next) s.watch = true; else { try { delete s.watch; } catch (e) { s.watch = false; } }
        s.updatedAt = Date.now();                     // 跨端按条目时间取新（与其它条目级修改一致）
        const nm = String(s.name || '');
        return { ok: true, watch: next, name: nm, note: next ? ('⭐ 已关注「' + nm + '」：不会被自动清理') : ('已取消关注「' + nm + '」') };
    } catch (e) { return { ok: false, note: '切换关注失败：' + String((e && e.message) || e) }; }
}
