// ============================================================
// core/model/relation.js —— **关联层边模型**（纯逻辑，逐条对齐 D2 §3 / D5 §3.1）
//
// 设计依据（docs/D2-关系约束层设计稿.md）：
//   · D2 §3.1 统一原子引用 `AtomRef = {dim, id}` —— 全层唯一寻址方式；
//   · D2 §3.2 边字段（type / how / public / deviation / at / source / note …）+ 10 类关系词表；
//   · D2 §3.4 稳定 id：**对称边**（`co-occur` / `mirrors`）按端点排序归一为一条，**有向边**按 from→to；
//   · D5 §3.1 三类方向性（对称 / 有向 / 互为反向）与「反对称对只存规范方向」；
//   · D5 §2 裁决链：`source` 权威序 `manual > ai > mech > inferred`（此处只登记权重，不参与过滤）。
//
// 本版（v2.83.0）**只做只读派生**：边由既有数据机械推导（`core/relations.js`），
//   不落库、不新增容器 —— 对应 D2 §3.5「阶段 1：links 作只读投影源，私有引用字段作派生来源」。
// ============================================================
import { hashText } from '../util.js';

/**
 * 关系类型词表（D2 §3.2 的 10 类；`sym` = 对称边，`derived` = 本版是否由机械派生产生）。
 * 未派生的类型（`caused` / `before` / `co-occur`）保留词表位，待后续版本按 D4 的联动语义接入。
 */
export const REL_TYPES = Object.freeze({
    knows: { label: '知情', group: '认知', sym: false, derived: true },
    'knows-not': { label: '不知情', group: '认知', sym: false, derived: true },
    'derived-from': { label: '来源', group: '结构', sym: false, derived: true },
    'member-of': { label: '隶属', group: '结构', sym: false, derived: true },
    owns: { label: '归属', group: '归属', sym: false, derived: true },
    'located-at': { label: '位于', group: '位置', sym: false, derived: true },
    mirrors: { label: '镜像', group: '推演', sym: true, derived: true },
    caused: { label: '因果', group: '事实', sym: false, derived: false },
    before: { label: '先于', group: '时序', sym: false, derived: false },
    'co-occur': { label: '同场', group: '时序', sym: true, derived: false },
});

/** 关系类型中文名（未知类型原样返回） */
export function relTypeLabel(type) { try { const t = REL_TYPES[String(type)]; return t ? t.label : String(type || ''); } catch (e) { return String(type || ''); } }
/** 是否对称边（对称边按端点排序归一为一条，避免 A↔B 双写） */
export function relTypeSymmetric(type) { try { return !!(REL_TYPES[String(type)] && REL_TYPES[String(type)].sym); } catch (e) { return false; } }
/** 类型词表里的全部键（UI 排序与测试用，顺序即声明顺序） */
export function relTypeKeys() { return Object.keys(REL_TYPES); }

/** 来源权威序（D5 §2 的 L2）：仅作权重与展示，不做过滤 */
export const REL_SOURCE_RANK = Object.freeze({ manual: 3, ai: 2, mech: 1, inferred: 0 });
/** 来源中文名 */
export function relSourceLabel(src) {
    return ({ manual: '人工', ai: 'AI', mech: '机械派生', inferred: '推断' })[String(src)] || String(src || '');
}

/**
 * 归一化一个原子引用（D2 §3.1）。
 * @param {string} dim 维度键（`DIMENSIONS[].kind`）
 * @param {*} id 条目 id
 * @returns {{dim:string, id:string}|null} 非法（缺维度或 id）→ null
 */
export function relRef(dim, id) {
    try {
        const d = String(dim == null ? '' : dim).trim();
        const i = String(id == null ? '' : id).trim();
        if (!d || !i) return null;
        return { dim: d, id: i };
    } catch (e) { return null; }
}
/** 端点键（去重 / 排序 / 索引用的字符串形式） */
export function relRefKey(ref) {
    try { return ref && ref.dim && ref.id ? (String(ref.dim) + '|' + String(ref.id)) : ''; } catch (e) { return ''; }
}
/** 端点是否合法（必须是 `{dim, id}`） */
export function relRefOk(ref) { return !!(ref && typeof ref === 'object' && String(ref.dim || '') && String(ref.id || '')); }

/**
 * 稳定边 id（D2 §3.4）：
 *   · 对称边 → `type + 排序后的两端点`（同一关系无论谁写都得到同一 id → 不会双写）；
 *   · 有向边 → `type + from + to`（方向不同即不同关系）。
 * `how` / `who` 参与身份：同一个原子对同一角色的不同「知情方式」视为不同边（与 `links` 稳定 id 口径一致）。
 * @param {string} type 关系类型
 * @param {object} from 起点（AtomRef）
 * @param {object} to 终点（AtomRef 或 `{who}`）
 * @param {string} [how] 细分方式
 * @returns {string} `rel_<hash>`
 */
export function relationId(type, from, to, how) {
    try {
        const t = String(type || '');
        const f = relRefKey(from) || ('who:' + String((from && from.who) || ''));
        const g = relRefKey(to) || ('who:' + String((to && to.who) || ''));
        const ends = relTypeSymmetric(t) ? [f, g].sort() : [f, g];
        return 'rel_' + hashText([t, ends[0], ends[1], String(how || '')].join('|'));
    } catch (e) { return ''; }
}

/**
 * 归一化一条边（供派生器与后续「落库/合并」共用；非法返回 null）。
 * 字段对齐 D2 §3.2；`strength` 由调用方给（其余缺失一律取默认，不臆造）。
 */
export function normRelation(raw) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        const type = String(raw.type || '');
        if (!REL_TYPES[type]) return null;
        // 端点既可以是 AtomRef（`{dim, id}`），也可以是角色端点 `{who}`（D2 §3.1 的特殊端点）
        const whoOf = (side) => {
            const w = String((side && side.who) || '').trim();
            return w ? { who: w } : null;
        };
        const from = relRef(raw.from && raw.from.dim, raw.from && raw.from.id) || whoOf(raw.from) || (raw.fromWho ? { who: String(raw.fromWho) } : null);
        const to = relRef(raw.to && raw.to.dim, raw.to && raw.to.id) || whoOf(raw.to) || (raw.toWho ? { who: String(raw.toWho) } : null);
        if (!from || !to) return null;
        const how = String(raw.how || '');
        return {
            id: String(raw.id || relationId(type, from, to, how)),
            type, from, to, how,
            public: raw.public === true,
            deviation: String(raw.deviation || ''),
            at: String(raw.at || ''),
            floor: Number(raw.floor) || 0,
            strength: Number.isFinite(Number(raw.strength)) ? Math.max(0, Math.min(1, Number(raw.strength))) : 0.5,
            source: REL_SOURCE_RANK[String(raw.source)] !== undefined ? String(raw.source) : 'mech',
            note: String(raw.note || '').slice(0, 60),
        };
    } catch (e) { return null; }
}
