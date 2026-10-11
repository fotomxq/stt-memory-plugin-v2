// ============================================================
// core/field-names.js —— **字段名规范（单一事实源）**（v3.44.0，`docs/D22` **W4** `数-10`）
//
// 用户要求（原话）：「新版本v.3.44.0 / 开发W4待开发事项。」
// 设计依据：`docs/D20` §3.4 / §8 `数-10` ——
//   「同一语义 **4 种日期字段名**（`date` / `seenDate` / `floorSeen` / `lastSeenDate`）」。
//
// 事实（本轮逐维核对，与 `docs/D20` K 表一致）：
//   | 维度 | 语义 | 现状字段名 | 性质 |
//   | --- | --- | --- | --- |
//   | 情节 / 记忆 / 概念 / 计划 / 悬念 / 平行 | 条目自身的剧情日期 | `date` | 已是规范名 |
//   | 物品 `items` | **最后一次出现**（剧情日期） | `seenDate`（回退 `date`） | 旧别名 |
//   | 场景 `scenes` | **最后一次出现**（楼层号） | `floorSeen`（数字） | 旧别名 |
//   | 角色 `snapshots` | 最后一次出现（剧情日期） | `lastSeenDate` | 已是规范名 |
//   | 全部条目 | 聊天归属 | `chatKey` | 已是规范名 |
//
// 结论（本次采用的规范化口径）：
//   · **同一个语义只认一个规范名**，「最后一次出现」按**形态**分两个字段（这是 `D20` 原文把
//     `floorSeen` 与三个日期名并称为「4 种日期字段名」的不精确之处 —— 它记录的其实是**楼层**）：
//       日期形态 → **`lastSeenDate`**（`YYYY-MM-DD`）
//       楼层形态 → **`lastSeenFloor`**（整数楼层）
//   · **只加不删、只补不覆盖**：迁移期把旧名的值**双写**到规范名（规范名已有值则一律不动），
//     旧名**保留**（`docs/D20` §8 `数-10` 的回退口径就是「保留旧字段（双写）」）→ 老版本、
//     老存档、老黄金样本继续可读，**`DATA_VERSION` 不变**。
//   · **不参与任何哈希**：两个规范名都**不在** `core/model/hashfields.js` 的字段表里 →
//     写入它们不改变内容哈希 / 身份哈希 / 跨端聚合哈希（`tests/unit/field-names.test.js` 断言这一点）。
//   · **归属缺失（`chatKey`）不回填**：`core/entry-meta.js#stampChatScope` 的纪律是
//     「只打不推断，宁可少打」—— 历史条目属于哪条聊天**无法从数据本身确定**，猜错等于把别条聊天的
//     情节提到最高档（比不打标更危险）。故本模块只**登记语义**，回填交给体检**如实报告**。
// ============================================================
import { normText } from './util.js';

/** 「最后一次出现」的**日期形态**规范字段名（`YYYY-MM-DD`） */
export const LAST_SEEN_DATE_FIELD = 'lastSeenDate';
/** 「最后一次出现」的**楼层形态**规范字段名（整数楼层，≥0） */
export const LAST_SEEN_FLOOR_FIELD = 'lastSeenFloor';
/** 聊天归属字段名（只读登记；**不回填**，理由见文件头） */
export const ATTRIBUTION_FIELD = 'chatKey';

/**
 * 旧别名表（**只读兼容**）：维度 → 读到「最后一次出现（日期）」时可接受的旧字段名，按优先级排列。
 * 只有 `items` 需要 —— `snapshots` 早就写的是规范名 `lastSeenDate`。
 */
export const LEGACY_SEEN_DATE = Object.freeze({
    items: Object.freeze(['seenDate', 'date']),
});

/** 旧别名表（楼层形态）：维度 → 旧字段名 */
export const LEGACY_SEEN_FLOOR = Object.freeze({
    scenes: Object.freeze(['floorSeen']),
});

/** 需要规范化「最后一次出现」的维度（= 上两张表的键；测试据此逐维覆盖） */
export const FIELD_NAME_DIMS = Object.freeze(Object.keys(LEGACY_SEEN_DATE).concat(Object.keys(LEGACY_SEEN_FLOOR)));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** 读「最后一次出现（日期）」：**规范名优先**，回退旧别名（只读；不写） */
export function seenDateOf(dim, it) {
    if (!isObj(it)) return '';
    const own = normText(it[LAST_SEEN_DATE_FIELD], 10);
    if (own) return own;
    for (const k of (LEGACY_SEEN_DATE[String(dim)] || [])) {
        const v = normText(it[k], 10);
        if (v) return v;
    }
    return '';
}

/** 读「最后一次出现（楼层）」：**规范名优先**，回退旧别名（只读；不写） */
export function seenFloorOf(dim, it) {
    if (!isObj(it)) return 0;
    const own = Number(it[LAST_SEEN_FLOOR_FIELD]);
    if (Number.isInteger(own) && own >= 0) return own;
    for (const k of (LEGACY_SEEN_FLOOR[String(dim)] || [])) {
        const n = Number(it[k]);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return 0;
}

/**
 * 判定一条条目是否**只带旧名、缺规范名**（体检用：取值为「有内容」才算数，空值不算异常）。
 * @returns {{date:boolean, floor:boolean}} 为 `true` 表示该形态有旧值但缺规范名
 */
export function legacyNameGaps(dim, it) {
    const out = { date: false, floor: false };
    if (!isObj(it)) return out;
    const d = String(dim);
    if (!nonEmpty(it[LAST_SEEN_DATE_FIELD])) {
        for (const k of (LEGACY_SEEN_DATE[d] || [])) { if (nonEmpty(it[k])) { out.date = true; break; } }
    }
    if (!nonEmpty(it[LAST_SEEN_FLOOR_FIELD])) {
        for (const k of (LEGACY_SEEN_FLOOR[d] || [])) { if (nonEmpty(it[k]) && Number.isInteger(Number(it[k]))) { out.floor = true; break; } }
    }
    return out;
}

/** 条目是否缺聊天归属（体检用；**不回填**） */
export function attributionMissing(it) {
    return isObj(it) && !nonEmpty(it[ATTRIBUTION_FIELD]);
}

/**
 * **规范化单条条目**（就地写入；幂等；只补不覆盖）。
 * 语义 → 规范名的双写：`items.lastSeenDate` ← 旧 `seenDate`/`date`；`scenes.lastSeenFloor` ← 旧 `floorSeen`。
 * 规范名已有值（即使与旧名不同）**一律不动** —— 规范名是权威，旧名只是历史遗留。
 * @param {string} dim 维度键
 * @param {object} it 条目（就地修改）
 * @returns {{changed:boolean, written:string[]}} 是否写入、写了哪些规范字段
 */
export function canonicalizeEntryFields(dim, it) {
    const out = { changed: false, written: [] };
    try {
        if (!isObj(it)) return out;
        const d = String(dim);
        if (!FIELD_NAME_DIMS.includes(d)) return out;
        // 日期形态
        if ((LEGACY_SEEN_DATE[d] || []).length && !nonEmpty(it[LAST_SEEN_DATE_FIELD])) {
            const v = seenDateOf(d, it);
            if (v) { it[LAST_SEEN_DATE_FIELD] = v; out.changed = true; out.written.push(LAST_SEEN_DATE_FIELD); }
        }
        // 楼层形态（`0` = 未记录，不写：写 0 与「没有这个字段」在语义上无法区分，只会制造噪声）
        if ((LEGACY_SEEN_FLOOR[d] || []).length && !nonEmpty(it[LAST_SEEN_FLOOR_FIELD])) {
            const n = seenFloorOf(d, it);
            if (n > 0) { it[LAST_SEEN_FLOOR_FIELD] = n; out.changed = true; out.written.push(LAST_SEEN_FLOOR_FIELD); }
        }
        return out;
    } catch (e) { return out; }
}
