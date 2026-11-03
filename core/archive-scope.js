// ============================================================
// core/archive-scope.js —— **存档（聊天）分区口径**（v3.52.7）
//
// 用户要求（原话）：「不同的存档，数据应该加以区分，避免混淆。」并在澄清中选择：
//   「按聊天存档隔离」+「每个聊天存档一份（角色内隔离）」。
//
// 背景：记忆容器**按角色**存（`scope: char:xxxx`）—— 同一角色的每条聊天共用同一份 `atoms/snapshots/…`。
//   v3.20.0 只给**新落库条目**打了 `chatKey`（聊天归属，`core/entry-meta.js#stampChatScope`），
//   但**读取侧从未按它分区** → 换一条聊天存档仍会看到别条存档的记忆（用户看到的「混淆」）。
//
// 本版口径（**读侧分区，写侧不动骨架**）：
//   ① 分区键 = 条目自带的 `chatKey`（缺省 = 升级前历史数据，记为 `legacy`）；
//   ② 当前存档 = `state.chatKey`（宿主从聊天文件元数据读，见 `host/chat.js#currentChatKey`）；
//   ③ **列表 / 计数 / 注入 / 自动裁剪**只针对「当前存档 + legacy」，**其它存档的条目一律隐藏且不动**；
//   ④ `legacy` 条目**保留可见并打「旧存档」徽标**（宁可显式标出来，也不静默藏数据）；
//      用户可一键「归入当前存档」（`adoptLegacyEntries`，幂等、需确认）；
//   ⑤ 当前存档键**读不到**（`state.chatKey` 为空）→ **fail-open**：不过滤任何条目（与 V1 行为一致，
//      也保证单元测试 / 冷启动不误伤数据）。
//
// ❗ 物理存储仍是「每个角色一份」（`char:<角色>`）：本版只在**逻辑视图**上隔离 —— 不改 `scope`、
//   不迁移服务端文件、不改 `DATA_VERSION`（见 `docs/D59` / `docs/D60` 的边界登记）。
// ============================================================
import { state } from './model/runtime.js';

/** 条目上的分区字段（与 `core/entry-meta.js#stampChatScope` 同一事实源） */
export const ARCHIVE_FIELD = 'chatKey';

/** 规范化分区键（去空白；空串 = 未归属） */
export function normalizeArchiveKey(v) {
    return String(v == null ? '' : v).replace(/\s+/g, '').slice(0, 80);
}

/**
 * v3.52.8：给**任何**新建数据打当前存档键（无键才写；只补空值，幂等）。
 *   用于不在 `preserveEntryMeta` 漏斗里的容器（关联行 / 货币账本 / 分段总结 等）——
 *   用户报告「有些数据没有同步被切分存档」正是这些容器缺 `chatKey`，切档后仍整份可见。
 * @param {object} obj 数据对象（就地修改）
 * @returns {object} 同一个对象
 */
export function stampEntryArchive(obj) {
    try {
        if (!obj || typeof obj !== 'object') return obj;
        const cur = currentArchiveKey();
        if (!cur) return obj;
        if (!entryArchiveKey(obj)) obj[ARCHIVE_FIELD] = cur;
        return obj;
    } catch (e) { return obj; }
}

/** 当前存档键（`state.chatKey`；读不到 → ''） */
export function currentArchiveKey() {
    try { return normalizeArchiveKey(state && state.chatKey); } catch (e) { return ''; }
}

/** 条目所属存档键（`chatKey` / 兼容短键 `ck`） */
export function entryArchiveKey(x) {
    try {
        if (!x || typeof x !== 'object') return '';
        return normalizeArchiveKey(x[ARCHIVE_FIELD] !== undefined ? x[ARCHIVE_FIELD] : x.ck);
    } catch (e) { return ''; }
}

/**
 * 条目分区档位：
 *   · `'all'`    —— 当前存档键未知（fail-open：不分档）
 *   · `'current'`—— 属于当前存档
 *   · `'legacy'` —— 无归属（升级前历史数据；可见但会打标）
 *   · `'other'`  —— 属于**别的存档**（隐藏、不参与注入与自动裁剪）
 * @returns {'all'|'current'|'legacy'|'other'}
 */
export function archiveTierOf(x) {
    const cur = currentArchiveKey();
    if (!cur) return 'all';
    const k = entryArchiveKey(x);
    if (!k) return 'legacy';
    return k === cur ? 'current' : 'other';
}

/** 是否在当前存档视图里可见（`all` / `current` / `legacy` 可见；`other` 隐藏） */
export function archiveVisible(x) { return archiveTierOf(x) !== 'other'; }

/** 过滤出可见条目（不修改入参） */
export function filterArchiveVisible(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr.filter((x) => archiveVisible(x));
}

/**
 * 分区统计（给面板横幅用）：
 * @param {Array<string>} dims 维度容器键（缺省 = 十二类条目容器）
 * @returns {{current:number, legacy:number, other:number, total:number, currentKey:string, known:boolean, dims:object}}
 */
export function archiveStats(dims) {
    const keys = Array.isArray(dims) && dims.length ? dims : ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'concepts', 'scenes', 'npcs', 'rumors', 'parallels', 'currencies', 'maps', 'links', 'ledger', 'deals', 'plotSegments'];
    const out = { current: 0, legacy: 0, other: 0, total: 0, currentKey: currentArchiveKey(), known: !!currentArchiveKey(), dims: {} };
    try {
        for (const k of keys) {
            const arr = Array.isArray(state[k]) ? state[k] : [];
            const d = { current: 0, legacy: 0, other: 0 };
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                const t = archiveTierOf(e);
                if (t === 'current' || t === 'all') d.current += 1;
                else if (t === 'legacy') d.legacy += 1;
                else d.other += 1;
            }
            out.dims[k] = d;
            out.current += d.current; out.legacy += d.legacy; out.other += d.other;
        }
        out.total = out.current + out.legacy + out.other;
        return out;
    } catch (e) { return out; }
}

/**
 * 把 **legacy（无归属）条目归入当前存档**（用户显式确认后调用；幂等）。
 *   · 只补空值：已有 `chatKey` 的一律不动（别的存档的条目绝不改）；
 *   · 当前存档键未知 → 不写（判不出来就不改）；
 *   · `chatKey` 不在内容哈希里（`core/model/hashfields.js`）→ 归档**不改变任何内容哈希**，不引发跨端计条。
 * @returns {{ok:boolean, adopted:number, note:string}}
 */
export function adoptLegacyEntries() {
    try {
        const cur = currentArchiveKey();
        if (!cur) return { ok: false, adopted: 0, note: '当前存档标识读不到（宿主未提供聊天元数据），无法归档' };
        let adopted = 0;
        for (const k of Object.keys(state || {})) {
            const arr = state[k];
            if (!Array.isArray(arr) || !arr.length) continue;
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                if (entryArchiveKey(e)) continue;          // 已有归属 → 不动（别的存档绝不改）
                e[ARCHIVE_FIELD] = cur;
                adopted += 1;
            }
        }
        // v3.52.9（用户报告「点击生效后过一段时间又出现」）：**记住用户的归档选择** ——
        //   之后每次载入只要当前存档键已知，就自动把仍无归属的历史数据归入本档（幂等），
        //   避免「点一次 → 载入/同步又冒出新的遗留 → 再提示」的循环。
        if (adopted) { try { state.archiveAdoptAuto = true; } catch (e) { /* 忽略 */ } }
        return { ok: true, adopted: adopted, note: adopted ? ('已把 ' + adopted + ' 条历史数据归入当前存档') : '没有需要归档的历史数据' };
    } catch (e) { return { ok: false, adopted: 0, note: '归档失败：' + String((e && e.message) || e) }; }
}

/**
 * v3.52.9：**载入期自动归档**（仅在用户已确认过一次后生效）——
 *   `state.archiveAdoptAuto === true` 且当前存档键已知 → 把仍无归属的历史条目归入本档（幂等、只补空值）。
 *   用 `migrateState` 末尾调用一次即可；不满足条件时零副作用（不改任何数据）。
 * @returns {{ok:boolean, adopted:number}}
 */
export function autoAdoptOnLoad() {
    try {
        if (!state || state.archiveAdoptAuto !== true) return { ok: false, adopted: 0 };
        if (!currentArchiveKey()) return { ok: false, adopted: 0 };
        return adoptLegacyEntries();
    } catch (e) { return { ok: false, adopted: 0 }; }
}

/**
 * 上限裁剪的**分区安全版**：只对「当前存档 + legacy」按尾裁，**别的存档原样保留**。
 *   （替代裸 `arr.slice(-cap)`：旧实现按容器顺序一刀切，会把别条存档的条目也裁掉。）
 * @param {Array} arr
 * @param {number} cap 上限（≤0 = 不裁）
 */
export function capVisibleKeepingOthers(arr, cap) {
    const list = Array.isArray(arr) ? arr : [];
    const n = Math.max(0, Math.floor(Number(cap) || 0));
    if (!n || list.length <= n) return list.slice();
    const vis = [];
    for (let i = 0; i < list.length; i++) if (archiveVisible(list[i])) vis.push(i);
    if (vis.length <= n) return list.slice();               // 可见条目没超上限 → 不动（总数可超：别的存档不算本档配额）
    const keepVis = new Set(vis.slice(vis.length - n));     // 「最近 N 条」= 可见条目里的尾部
    return list.filter((e, i) => keepVis.has(i) || !archiveVisible(e));
}
