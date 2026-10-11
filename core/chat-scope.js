// ============================================================
// core/chat-scope.js —— **情节的「聊天归属」口径**（v3.20.0）//
// 背景（真机取证，用户报告「最新的情节已经变化，但还是识别为错误的时间」）：
//   本插件的记忆容器是**按角色**存的（`scope: char:xxxx`）——同一个角色的**每一条聊天**共用
//   同一份 `state.atoms`。于是「情节」里混着**别条聊天**的故事线：
//   真机数据里 `书籍` 这条聊天只有 24 楼（628 年长安线），而 `atoms` 里同时躺着
//   198 年罗马线、327/438 年昆仑山线的旧情节，楼层号一路排到 508。
//   时钟的「最新情节」是**按楼层/位置排序**取第一条 → 那些陈旧情节（楼层号更大、
//   或删楼后被账本代理定位到本聊天的楼层上）会**长期压住**本聊天真正的最新情节，
//   用户看到的就是「情节明明更新了，时间还是错的」，且**每次删楼都复发一次**。
//
// 修法（本模块只提供判据，纯函数、无宿主/无 DOM）：
//   ① **聊天归属分级 `chatTier()`**：条目自带 `chatKey` 且等于当前聊天 → 第一档；
//      没有 `chatKey`（升级前的历史数据，保守视为「可能就是本聊天」）→ 第二档；
//      有 `chatKey` 但属于**别条聊天** → 第三档（排到最后，等价于降级）。
//   ② **位置越界降级 `plotOverflow()`**：条目的「当前位置」超过当前聊天末楼 →
//      这个楼层在**本聊天里根本不存在**，不可能是「剧情当下」→ 与「原文已移除」同档降级。
//      （真机取证：修复日志「最新情节在第 508 楼、当前只有第 13 楼」正是这一条失控。）
//   两条都只**降级、不排除** —— 与 v3.16.1「原文已移除降级」同一纪律：全部条目都被降级时
//   仍能取到值，保持向后兼容（宁可给旧值，也不给「无值」）。
// ============================================================

// ============================================================
// v3.45.1（`docs/D22` §4.7 W6 · `数-29` U177）——**无聊天归属的存量数据收口**（只读判定 + 幂等补写）
//
// 真机事实（`docs/D29` §2 第 8 行）：`plotScope` 20 条情节里 5 条无 `chatKey`（`legacy 5`）；
//   台账 **32/34** 条标记既无 `chatKey` 也无时间戳（`marksLegacyNoChat 32`）。
//
// 纪律（照抄 `core/entry-meta.js#stampChatScope` 的头注「**只打不推断，宁可少打**」）：
//   · 一轮 AI「更新」或跨聊天上下文**都不足以证明归属** —— 误标成「本聊天」= 把它提到最高档，比不打标更危险；
//   · 于是**只在「当前聊天键 + 内容指纹」双命中**（有实证的唯一判定）时才补写；判不出来的一律不写，
//     并保留**独立计数**（`plotScopeSnapshot().legacy` / `ledgerHealth().marksLegacyNoChat`；
//     `docs/D29` §6 **Q3** 已裁决：保留、不删、不掩盖）；
//   · 只补空值，已有 `chatKey` / `ck` **一律不动**；重复执行不产生任何变化（幂等）。
//
// 指纹一律复用**仓库已有的**定义，绝不新造第二种：
//   · 条目 = `core/model/hash.js#atomContentHash`（既有内容哈希）。`chatKey` **刻意不在** `HASH_FIELDS` /
//     `IDENTITY_FIELDS` 里（见 `core/model/hashfields.js`）→ 补写归属**不改变任何内容哈希**，
//     不会引发跨端「内容变了」的重复计条或快照误判；
//   · 台账标记 = 标记自身的 `h`（宿主 `host/floors.js#hashFloorText(f)` 写入的**楼层正文指纹**）
//     ＋ 注入的同一解析器 —— 注入形态与 `core/cross-sync.js#mergeProcessedFloors(a, b, hashFloor)` **完全一致**
//     （本模块不直接读宿主；解析器由 `core/migrate.js` 从 `core/repair.js#repairHookState()` 取，
//     那是 `index.js#installHostBridges()` 装配时已接好的既有出口）。
// ============================================================
import { state } from './model/runtime.js';
import { atomContentHash } from './model/hash.js';

/** `chatKey` 归一：去空白、限长（防止把整条聊天元数据塞进来）；非字符串 → `''` */
export function normalizeChatKey(raw) {
    try {
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        return s.slice(0, 80);
    } catch (e) { return ''; }
}

/**
 * 相关度档位（**越小越优先**）：
 *   · `0` = 本聊天（自带 `chatKey` 且与当前一致）
 *   · `1` = 归属未知（升级前的历史数据；没有 `chatKey` 字段）
 *   · `2` = 别条聊天（自带 `chatKey` 且与当前不同）
 * 当前聊天标识未知（空）时**一律为 0** —— 判不出来就不改行为（不倒退）。
 * @param {object} entry
 * @param {string} currentKey 当前聊天标识
 * @returns {number}
 */
export function chatTier(entry, currentKey) {
    const cur = normalizeChatKey(currentKey);
    if (!cur) return 0;
    const k = normalizeChatKey(entry && entry.chatKey);
    if (!k) return 1;
    return k === cur ? 0 : 2;
}

/**
 * 条目的**当前位置**（`floorNow*` 优先，缺失才回落到来源楼层）——与
 * `core/recall.js#trustedPlotList` / `core/floor-cover.js#meaningfulFloorRange` 同口径。
 * @param {object} entry
 * @returns {number}
 */
export function plotPositionOf(entry) {
    try {
        const e = entry || {};
        const ns = Number.isInteger(e.floorNowStart) ? e.floorNowStart : (Number(e.floorStart) || 0);
        const ne = Number.isInteger(e.floorNowEnd) ? e.floorNowEnd : (Number(e.floorEnd) || 0);
        return Math.max(ns, ne);
    } catch (e) { return 0; }
}

/**
 * 位置越界：条目的当前位置**超出当前聊天末楼**（那个楼层在本聊天里不存在）。
 *   末楼未知（`< 0` / 非整数）→ 一律不判越界（判不出来就不改行为）。
 * @param {object} entry
 * @param {number} chatTail 当前聊天末楼（`state.lastChatFloor` / 现场末楼）
 * @returns {boolean}
 */
export function plotOverflow(entry, chatTail) {
    try {
        const tail = Number(chatTail);
        if (!Number.isInteger(tail) || tail < 0) return false;
        const pos = plotPositionOf(entry);
        return pos > tail;
    } catch (e) { return false; }
}

/**
 * 「剧情当下可信度」降级档：`0` = 活情节（含位置在册），`1` = 已降级
 *   （原文已移除 / 位置越界）。与 v3.16.1 的 `originGone` 降级合并成同一档，
 *   保持排序判据只有一层，便于现有单测与调试追踪文案延续。
 * @param {object} entry
 * @param {number} chatTail
 * @returns {number}
 */
export function plotDemoted(entry, chatTail) {
    try {
        if (entry && entry.originGone === true) return 1;
        return plotOverflow(entry, chatTail) ? 1 : 0;
    } catch (e) { return 0; }
}

/** 当前聊天的标识（宿主注入；未注入 → `''` = 判不出来，排序不改行为） */
export function currentChatKey() {
    try { return normalizeChatKey(state && state.chatKey); } catch (e) { return ''; }
}

/**
 * 当前聊天的**末楼**（排序用「位置越界」判据的基准）：取状态里记的
 *   `lastChatFloor` / `lastKnownFloor` 较大值（`host/floors.js` 每次楼层巡检 / 删楼处理都会刷新，
 *   其中 `lastKnownFloor` 是「聊天至少曾有这么长」的高水位）。
 *
 * 为什么**刻意不用现场末楼**（内核注入的 `getLastMessageId()`）：
 *   · 它是「本轮看到的聊天长度」，在宿主尚未载入完、或调用方给的是合成数据时可能**比情节楼层小**；
 *     此时按「现场」判越界会把**有效情节误降级**（时钟反而退回旧值）——诊断/测试与真机都会踩；
 *   · 真机要防的场景（删楼后旧情节仍占着已不存在的楼层）在**下一次楼层巡检**后 `lastChatFloor`
 *     就已收紧，足够及时；且这条判据只是**兜底**，主判据是「聊天归属」（`chatTier`）。
 *   · 全都未知 → `-1`（`plotOverflow` 直接放行，不臆断）。
 * @returns {number}
 */
export function currentChatTail() {
    try {
        const a = Number(state && state.lastChatFloor);
        const b = Number(state && state.lastKnownFloor);
        const cand = [a, b].filter((x) => Number.isInteger(x) && x >= 0);
        return cand.length ? Math.max.apply(null, cand) : -1;
    } catch (e) { return -1; }
}

/**
 * 情节的**归属/位置体检快照**（只读；供调试桥 `ftt.plotScope` 与调试日志）。
 * 只统计条数与楼层，**不含任何正文**（隐私口径与其它诊断一致）。
 * @param {Array<object>} [list] 默认 `state.atoms`
 * @returns {object}
 */
export function plotScopeSnapshot(list) {
    try {
        const arr = Array.isArray(list) ? list : ((state && Array.isArray(state.atoms)) ? state.atoms : []);
        const key = currentChatKey();
        const tail = currentChatTail();
        const out = { chatKey: key ? key.slice(0, 12) + '…' : '', tail: tail, total: arr.length, current: 0, legacy: 0, other: 0, overflow: 0, originGone: 0, newest: [] };
        // v3.45.1（`数-29` 步骤③ · `docs/D29` §6 **Q3** 裁决）：补归属之后**不把计数归零**——
        //   `legacy` 就是「升级前历史数据」的**独立计数**（无 `chatKey` 且判不出唯一归属），
        //   `legacyNote` 把这条口径写在读数字段里（`ui/debug.js#ftt.plotScope` 会整份透出）。
        out.legacyNote = 'legacy = 升级前历史数据（无 chatKey；只读判定为「当前聊天键 + 内容指纹」双命中时才补写，判不出的一律不写、不删、不掩盖）';
        const cur = [];
        for (const a of arr) {
            if (!a) continue;
            const t = chatTier(a, key);
            if (t === 0) out.current++; else if (t === 1) out.legacy++; else out.other++;
            if (plotOverflow(a, tail)) out.overflow++;
            if (a.originGone === true) out.originGone++;
            if (t === 0) cur.push(a);
        }
        const pos = (a) => plotPositionOf(a);
        out.newest = cur.slice().sort((x, y) => pos(y) - pos(x)).slice(0, 5).map((a) => ({
            floor: pos(a), date: String(a.date || ''), time: String(a.time || ''),
            gone: a.originGone === true, hidden: a.hidden === true,
        }));
        return out;
    } catch (e) { return { error: String((e && e.message) || e) }; }
}

// ============================================================
// v3.45.1（`数-29`）——存量归属的**只读判定 + 幂等补写**
// ============================================================

/**
 * 条目的**内容指纹**（只读；复用仓库既有的内容哈希，绝不新造第二种）。
 *   `chatKey` 不在哈希字段表里 → 本函数对「补写前后的同一条目」返回同一值（补写不改指纹）。
 * @param {string} dim 维度键（`atoms` / `memories` / …）
 * @param {object} entry
 * @returns {string} 空串 = 该条目算不出内容指纹 → 判不出归属（不写）
 */
export function contentFingerprintOf(dim, entry) {
    try {
        if (!entry || typeof entry !== 'object') return '';
        return String(atomContentHash(String(dim || 'atoms'), entry) || '');
    } catch (e) { return ''; }
}

/**
 * 证据②：条目的**当前位置**是否仍「在本聊天里可复核」。
 *   判据 = 条目自带 `floorNowHash`（`core/floor-cover.js` 头注：`host/floors.js` 定位时写入的
 *   **该楼正文内容哈希**）与**注入的楼层哈希解析器**对同一楼层的返回值**逐字相等**。
 *   相等 ⇒ 这一楼的正文此刻就在本聊天里、且与条目记录的一致 ⇒ 「这条情节出自本聊天」是可实证的，
 *   不是从上下文猜的（与 `tests/unit/chat-scope.test.js` 的「第 3 楼在本聊天里在册＝`hashFloorText(3)`」同一口径）。
 * @param {object} entry
 * @param {Function|null} hashFloor 楼层正文哈希解析器（宿主 `hashFloorText`；未注入 → 判不出 → false）
 * @returns {boolean}
 */
export function floorFingerprintHit(entry, hashFloor) {
    try {
        if (typeof hashFloor !== 'function') return false;
        const h = String((entry && entry.floorNowHash) || '');
        if (!h) return false;
        const pos = plotPositionOf(entry);
        if (!Number.isInteger(pos) || pos < 0) return false;
        return String(hashFloor(pos) || '') === h;
    } catch (e) { return false; }
}

/**
 * **条目维度的存量归属补写**（只读判定 + 只补空值；幂等）。
 *
 * 双命中（两条证据任一成立即算「可唯一判定」，都**不是**推断）：
 *   · 证据①：**同维度**下已有一条带 `chatKey === 当前聊天键` 的条目，其**内容指纹与它逐字相同**
 *     ⇒ 这份内容已经在本聊天名下登记过，本条是它的副本/另一段切片；
 *   · 证据②：`floorFingerprintHit`（当前聊天里该楼正文指纹与条目记录一致）。
 * 判不出来（指纹空、两条都不命中）→ **不写**，计入 `legacy`（= 「升级前历史数据」独立计数）。
 * 已有 `chatKey` 的条目（含属于**别的聊天**的）一律不动 —— 绝不覆盖、绝不改判。
 *
 * @param {object} [st] 状态容器（缺省用内核 `state`）
 * @param {{chatKey?:string, dims?:string[], hashFloor?:Function}} [opts]
 *   `chatKey` 缺省取 `currentChatKey()`（内核当前聊天标识）；`dims` 缺省 `['atoms']`
 *   —— 真机事实只有情节（`plotScope.legacy`）；其余维度沿用「只打不推断」的保守口径，
 *   不做一次载入期多维度批量改写。
 * @returns {{changed:boolean, filled:number, legacy:number, dims:object, skipped:string}}
 */
export function backfillChatScope(st, opts) {
    const o = opts || {};
    const out = { changed: false, filled: 0, legacy: 0, dims: {}, skipped: '' };
    try {
        const s = st || state;
        if (!s || typeof s !== 'object') { out.skipped = 'no-state'; return out; }
        const key = normalizeChatKey(o.chatKey != null ? o.chatKey : currentChatKey());
        // 当前聊天标识读不到 → 一律不写（判不出来就不改行为；与 `stampChatScope` 同纪律）
        if (!key) { out.skipped = 'no-chat-key'; return out; }
        const dims = (Array.isArray(o.dims) && o.dims.length) ? o.dims.map(String) : ['atoms'];
        const hashFloor = (typeof o.hashFloor === 'function') ? o.hashFloor : null;
        for (const dim of dims) {
            const arr = Array.isArray(s[dim]) ? s[dim] : null;
            if (!arr || !arr.length) continue;
            // 证据集合：本维度里**已经**带当前聊天归属的条目的内容指纹（只读，来自既有数据）
            const attributed = Object.create(null);
            for (const it of arr) {
                if (!it || typeof it !== 'object') continue;
                if (normalizeChatKey(it.chatKey) !== key) continue;
                const h = contentFingerprintOf(dim, it);
                if (h) attributed[h] = 1;
            }
            let filled = 0, legacy = 0;
            for (const it of arr) {
                if (!it || typeof it !== 'object') continue;
                if (normalizeChatKey(it.chatKey)) continue;            // 只补空值：绝不覆盖已有归属
                const h = contentFingerprintOf(dim, it);
                const sameContent = !!(h && attributed[h]);            // 证据①
                const inThisChat = !sameContent && floorFingerprintHit(it, hashFloor);   // 证据②
                if (sameContent || inThisChat) {
                    it.chatKey = key;                                  // 只补这一个字段；不动任何别的内容
                    if (h) attributed[h] = 1;                          // 内容相同的后续副本同样可判（同一条证据）
                    filled++;
                    out.changed = true;
                } else legacy++;
            }
            out.dims[dim] = { filled: filled, legacy: legacy, total: arr.length };
            out.filled += filled;
            out.legacy += legacy;
        }
        return out;
    } catch (e) { out.skipped = String((e && e.message) || e); return out; }
}

/**
 * **台账标记（`processedFloors` / `processedDropped`）的存量归属补写**（只读判定 + 只补空值；幂等）。
 *
 * 双命中（任一成立）：
 *   · 证据①：同一容器里已有**带本聊天 `ck`** 的标记，其楼层正文指纹 `h` 与它逐字相同；
 *   · 证据②：注入的楼层哈希解析器对该标记楼层 `f` 的返回值 = 标记自身的 `h`
 *     （该楼正文此刻仍在本聊天里、且与标记记录一致 ⇒ 这条「已处理」确实属于本聊天）。
 * `h` 为空 / 两条都不命中 → 不写，计入 `legacy`（独立计数，见 `host/floors.js#ledgerHealth`
 *   的 `marksLegacyNoChat`）。
 * @param {object} [st]
 * @param {{chatKey?:string, hashFloor?:Function}} [opts]
 * @returns {{changed:boolean, filled:number, legacy:number, skipped:string}}
 */
export function backfillMarkScope(st, opts) {
    const o = opts || {};
    const out = { changed: false, filled: 0, legacy: 0, skipped: '' };
    try {
        const s = st || state;
        if (!s || typeof s !== 'object') { out.skipped = 'no-state'; return out; }
        const key = normalizeChatKey(o.chatKey != null ? o.chatKey : currentChatKey());
        if (!key) { out.skipped = 'no-chat-key'; return out; }
        const hashFloor = (typeof o.hashFloor === 'function') ? o.hashFloor : null;
        for (const holder of ['processedFloors', 'processedDropped']) {
            const arr = Array.isArray(s[holder]) ? s[holder] : null;
            if (!arr || !arr.length) continue;
            const attributed = Object.create(null);
            for (const m of arr) {
                if (!m || typeof m !== 'object') continue;
                if (normalizeChatKey(m.ck) !== key) continue;
                const h = String(m.h || '');
                if (h) attributed[h] = 1;
            }
            for (const m of arr) {
                if (!m || typeof m !== 'object') continue;
                if (normalizeChatKey(m.ck)) continue;                  // 只补空值：别的聊天的标记一律不动
                const h = String(m.h || '');
                let hit = !!(h && attributed[h]);                      // 证据①
                if (!hit && h && hashFloor) {                          // 证据②
                    const f = Number(m.f);
                    if (Number.isInteger(f) && f >= 0) {
                        try { hit = String(hashFloor(f) || '') === h; } catch (e) { hit = false; }
                    }
                }
                if (hit) { m.ck = key; out.filled++; out.changed = true; }
                else out.legacy++;
            }
        }
        return out;
    } catch (e) { out.skipped = String((e && e.message) || e); return out; }
}

/**
 * 存量归属收口的**唯一入口**（条目 + 台账标记；`core/migrate.js#healthSelfHeal` 第 ⑩ 步调用）。
 * 只读判定 + 只补空值 + 幂等；返回两部分的独立计数（补上的 / 仍无法判定的）。
 * @param {object} [st]
 * @param {{chatKey?:string, dims?:string[], hashFloor?:Function}} [opts]
 * @returns {{changed:boolean, entries:object, marks:object}}
 */
export function backfillChatAttribution(st, opts) {
    const entries = backfillChatScope(st, opts);
    const marks = backfillMarkScope(st, opts);
    return { changed: !!(entries.changed || marks.changed), entries: entries, marks: marks };
}
