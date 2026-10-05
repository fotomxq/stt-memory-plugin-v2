// ============================================================
// core/entry-meta.js —— **条目元字段统一补齐**（v3.8.0：楼层溯源 + NSFW 等级留档）
//
// 背景：各维度 `normalizeX()` 只产出「自己的字段」，凡是它不认识的字段都会被丢掉 ——
//   而 `floorStart/floorEnd` 这类**溯源**字段与 `nsfw` 这类**留档**字段恰恰不属于「AI 抽出来的内容」，
//   它们由插件自己维护。于是所有归一化调用点统一走本模块：
//   · 楼层溯源（v3.7.0）：`preserveFloorProvenance(raw, norm)` —— 补齐 `floorNow*` / `originGone`；
//   · NSFW 等级（v3.8.0）：从**写入原文**判级并**只升不降**地写回 `nsfw`（无/弱/强），
//     同时继承同 id 既有条目的留档（AI 改写、弱化、重归一化都不得把「强」降下来）。
//
// 为什么单独一个文件：`core/ingest.js` 依赖 `core/entries.js`，而 `core/entries.js` 也需要打标 ——
//   放在 ingest 里会形成循环导入；本模块只依赖 `config/floor-cover/nsfw`，可被两者共用。
// ============================================================
import { KIND_MAP } from './config.js';
import { normalizeChatKey } from './chat-scope.js';
import { preserveFloorProvenance } from './floor-cover.js';
import { nsfwClassifyItem, nsfwLevelFromEntry, nsfwLevelMax, nsfwLevelOf, nsfwStampLevel } from './nsfw.js';
import { state } from './model/runtime.js';

/** 维度键 → 真实容器（`states` 实为 `currentStates`；与 `core/config.js#KIND_MAP` 同口径） */
function entryListOf(dim) {
    try {
        const km = KIND_MAP[String(dim)];
        const v = km && typeof km.get === 'function' ? km.get() : null;
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}

/**
 * v3.20.0：**给新落库的条目打「聊天归属」**（`chatKey` = 本条记忆出自哪条聊天）。
 *
 * 为什么需要：记忆容器是**按角色**存的（`scope: char:xxxx`），同一角色的多条聊天共用同一份 `atoms` ——
 *   别条聊天的情节混在里面，楼层号在本聊天里没有意义，却会参与「最新情节」排序 →
 *   时钟长期显示别条故事的时间（真机取证见 `core/chat-scope.js` 头注）。
 *
 * 纪律（**只打不推断，宁可少打**）：
 *   · **仅新条目**（本维度里还没有同 id 的条目）才打标 —— 更新既有条目时一律**继承**它原来的归属；
 *     为什么不给「更新」补标：一次 AI「更新」不足以证明条目属于本聊天（它可能是被上下文带进来的
 *     别条聊天情节），而**误标成「本聊天」= 把它提到最高档**，比不打标更危险；不打标只影响排序档位。
 *   · 当前聊天标识为空（宿主未注入）→ 一律不打标（判不出来就不改行为）。
 * @param {string} dim 维度键
 * @param {object} norm 归一化结果（就地补齐）
 */
function stampChatScope(dim, norm) {
    try {
        if (!norm || typeof norm !== 'object') return;
        const id = norm.id !== undefined ? String(norm.id) : '';
        const prev = id ? entryListOf(dim).find((x) => x && String(x.id) === id) : null;
        if (prev) {
            // 更新既有条目：**继承原归属**（与楼层溯源同一纪律 —— 归一化只认识 AI 给的字段，
            //   `chatKey` 属于插件自维护的元字段，不继承就会在每次 AI 更新时被冲掉）。
            const pk = normalizeChatKey(prev.chatKey);
            if (pk && !normalizeChatKey(norm.chatKey)) norm.chatKey = pk;
            return;
        }
        const key = normalizeChatKey(state && state.chatKey);
        if (!key) return;                 // 当前聊天标识读不到 → 不打标（判不出来就不改行为）
        if (!normalizeChatKey(norm.chatKey)) norm.chatKey = key;
    } catch (e) { /* 忽略 */ }
}

/**
 * 归一化后补齐「插件自维护的元字段」（楼层溯源 + NSFW 等级留档 + 聊天归属）。
 * @param {string} dim 维度键（`atoms` / `states` / `snapshots` / …；`states` 指状态记录）
 * @param {object} raw 写入原文（含 AI 的 `NSFW` / `露骨程度` 标注键，可缺）
 * @param {object} norm 归一化结果（就地补齐并返回）
 * @returns {object} `norm`
 */
export function preserveEntryMeta(dim, raw, norm) {
    try { preserveFloorProvenance(raw, norm); } catch (e) { /* 忽略 */ }
    try { stampChatScope(dim, norm); } catch (e) { /* 忽略 */ }
    try {
        if (!norm || typeof norm !== 'object') return norm;
        const id = norm.id !== undefined ? String(norm.id) : '';
        const prev = id ? entryListOf(dim).find((x) => x && String(x.id) === id) : null;
        const level = nsfwLevelMax(
            nsfwLevelOf(norm),                 // 归一化已保留的（来自 raw 或 AI 标注键）
            nsfwLevelOf(prev),                 // **继承既有留档**：只升不降（AI 改写/弱化不得冲掉）
            nsfwLevelFromEntry(raw),           // AI 显式标注的等级
            nsfwClassifyItem(dim, raw)         // 按**写入当时**的原文判级
        );
        nsfwStampLevel(norm, level);
    } catch (e) { /* 忽略 */ }
    return norm;
}

export { nsfwLevelOf, nsfwLevelMax, nsfwStampLevel, nsfwClassifyItem, nsfwLevelFromEntry, preserveFloorProvenance };
