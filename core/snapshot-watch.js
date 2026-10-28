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

/** 该名字/ id 是否被关注（按 id 或姓名精确匹配） */
export function isWatchedSnapshotKey(key) {
    try {
        const k = String(key == null ? '' : key).trim();
        if (!k) return false;
        const list = Array.isArray(state.snapshots) ? state.snapshots : [];
        return list.some((s) => s && s.watch === true && (String(s.id) === k || String(s.name) === k));
    } catch (e) { return false; }
}

/**
 * v3.52.6（用户报告「关注后仍被自动删除」）：**关注档案保活** —— 从一批待删除的 id / 姓名里剔除被关注者。
 *   用于 AI 删除、修复删除、上限裁剪等**自动**路径；用户手动删除（`core/entries.js`）不经过这里。
 * @param {Array<string>} keys 待删除的 id / 姓名
 * @returns {{keep:Array<string>, blocked:number}} `keep` = 实际允许删除的键；`blocked` = 被关注而拦下的条数
 */
export function dropWatchedKeys(keys) {
    const out = [];
    let blocked = 0;
    for (const k of (Array.isArray(keys) ? keys : [])) {
        if (isWatchedSnapshotKey(k)) { blocked += 1; continue; }
        out.push(String(k == null ? '' : k).trim());
    }
    return { keep: out.filter(Boolean), blocked: blocked };
}

/**
 * v3.52.6：**上限裁剪保活** —— 按「保留最近 N 条」裁 `snapshots` 时，被关注的档案**永不裁掉**
 *   （旧实现 `slice(-cap)` 按容器顺序一刀切，被关注但排在前面/条目多时会被静默删除）。
 *   `cap` 为软上限：被关注者超出时允许超出（用户意志优先，`docs/D28` B13②）。
 * @param {Array} arr snapshots
 * @param {number} cap 上限（≤0 视为不裁）
 */
export function capSnapshotsKeepingWatched(arr, cap) {
    const list = Array.isArray(arr) ? arr : [];
    const n = Math.max(0, Math.floor(Number(cap) || 0));
    if (!n || list.length <= n) return list.slice();
    const watched = list.filter((s) => s && s.watch === true);
    if (!watched.length) return list.slice(-n);
    const watchedSet = new Set(watched);
    const rest = list.filter((s) => !watchedSet.has(s));
    const room = Math.max(0, n - watched.length);
    const keepRest = room > 0 ? rest.slice(-room) : [];
    const keepSet = new Set(keepRest.concat(watched));
    return list.filter((s) => keepSet.has(s));   // 保持原容器顺序（跨端并集/去重口径不变）
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
