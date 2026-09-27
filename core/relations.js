// ============================================================
// core/relations.js —— **关联层派生器 + 反向索引**（v2.83.0，实现 D2 §3 的边层）
//
// 用户要求：「开发之前设计的原子层之上的关联层。」
//
// 设计落点（docs/D2-关系约束层设计稿.md）：
//   · T1 让全部 14 个大类进入同一张关系网；T2 把散落的原子↔原子引用收敛为**有类型的边**并支持**反向查询**；
//   · §3.5 兼容策略阶段 1：`links` 作 `knows` 的只读投影源、各维度私有引用字段作**机械派生来源**，
//     **不迁移、不落库、不新增容器**（因此本版零数据模型风险，`DATA_VERSION` 不变）。
//   · §0 建议起点 S0：先让关系可见、可反查（本文件即 S0 的实现），落库容器（S2）与约束（§3.3）后续再做。
//
// 派生来源（逐条对应 D2 §2.3 的私有引用字段表）：
//   links 非锚行            → knows / knows-not（尊重 `cfg.relLinkEnabled` 总开关）
//   links 锚行              → public 标记 + member-of（conceptRef/atomRef/planRef/suspenseRef/memRefs）/ derived-from（sourceRefs）
//   parallels.sourceRefs    → derived-from（平行 ← 来源）
//   parallels.promotedTo    → derived-from（情节 ← 被转正的平行）
//   parallels.planRef/suspenseRef → member-of
//   plans.atomRefs/memRefs/suspenseRefs → member-of
//   suspense.planRefs/memRefs/atomRefs  → member-of
//   plotSegments.atomIds    → derived-from（分段 ← 情节）
//   atoms.mergedSummary.sourceIds → derived-from（总结 ← 被总结的情节）
//   rumors.lineage.parentId → derived-from（传言 ← 母传言）
//   rumors.parallelRefs     → mirrors（对称：传言 ↔ 平行事件）
//   items/currencies/memories.owner → owns（角色 ← 持有/归属）
//   atoms.locations / items.location / parallels.location → located-at（原子 → 场景，按名称/路径**精确**匹配）
//   scenes.pathArr          → member-of（子场景 → 父场景，按路径前缀解析）
//   **不派生**：`caused` / `before` / `co-occur`（机械推不出因果与共现；保留词表位，待 D4 联动语义接入）
//
// 口径：**零 AI、确定性、只读**。同一份数据重复派生得到同一结果（含排序）；不修改任何 state。
// ============================================================
import { state, cfg } from './model/runtime.js';
import { DIMENSIONS } from './constants.js';
import { relRef, relRefKey, relationId, relTypeSymmetric, REL_TYPES, relTypeKeys } from './model/relation.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v == null ? '' : v).trim();
const isObj = (v) => !!(v && typeof v === 'object' && !Array.isArray(v));

/** 关联层总开关（D1 G1 修复：与内核同一键 `cfg.relLinkEnabled`，不再是配置里不存在的 `relLayerEnabled`） */
export function relationLayerOn() { try { return cfg.relLinkEnabled !== false; } catch (e) { return true; } }

/** 维度中文名（UI/诊断用） */
export function relDimLabel(dim) {
    try {
        const d = DIMENSIONS.filter((x) => String(x.kind) === String(dim))[0];
        return d ? d.label : String(dim || '');
    } catch (e) { return String(dim || ''); }
}
/** 端点显示名：AtomRef → 条目标题；`{who}` → 角色名 */
export function relEndpointLabel(ref) {
    try {
        if (ref && ref.who) return String(ref.who);
        const dim = String((ref && ref.dim) || ''), id = String((ref && ref.id) || '');
        if (!dim || !id) return '';
        const e = arr(state[dim]).filter((x) => x && String(x.id) === id)[0];
        if (!e) return '（条目已不在库中）';
        const t = str(e.title) || str(e.name) || str(e.content) || str(e.text) || str(e.subject) || id;
        return t.length > 40 ? (t.slice(0, 39) + '…') : t;
    } catch (e) { return ''; }
}

/** 端点键 → 可读坐标（`atoms|a1`） */
export function relEndpointCoord(ref) {
    try { return ref && ref.who ? ('角色|' + String(ref.who)) : relRefKey(ref); } catch (e) { return ''; }
}

/** 确定性端点排序键（对称边归一 + 输出排序都用它） */
function endKey(ref) { return ref && ref.who ? ('who:' + String(ref.who)) : relRefKey(ref); }

/** 对称边归一：端点按键排序，保证同一条关系两端写法得到同一记录 */
function canonEdge(type, from, to) {
    if (!relTypeSymmetric(type)) return { from, to };
    return endKey(from) <= endKey(to) ? { from, to } : { from: to, to: from };
}

/** 场景解析表（名称 / 路径 → 场景 id），用于 location → located-at */
function sceneIndex() {
    const byName = new Map(), byPath = new Map(), byId = new Map();
    for (const s of arr(state.scenes)) {
        if (!s || !s.id) continue;
        byId.set(String(s.id), s);
        const name = str(s.name);
        if (name && !byName.has(name)) byName.set(name, String(s.id));
        const path = str(s.pathStr);
        if (path && !byPath.has(path)) byPath.set(path, String(s.id));
    }
    return { byName, byPath, byId };
}

/**
 * 派生全部关联边（只读、确定性）。
 * @param {{max?:number}} [opts] `max` 边数上限（默认 2000；超出时截断并置 `truncated`）
 * @returns {{edges:Array, truncated:boolean, linksOff:boolean, scanned:number}}
 */
export function deriveRelations(opts) {
    const o = opts || {};
    const max = Math.max(1, Number(o.max) || 2000);
    const linksOff = !relationLayerOn();
    const map = new Map();          // id → edge（去重：同一关系只留一条）
    const add = (type, from, to, extra) => {
        try {
            if (!REL_TYPES[String(type)]) return;
            if (!from || !to) return;
            if (endKey(from) === endKey(to)) return;          // 自环拒收（D2 N3）
            const c = canonEdge(type, from, to);
            const how = str(extra && extra.how);
            const id = relationId(type, c.from, c.to, how);
            if (!id || map.has(id)) return;
            map.set(id, {
                id, type,
                from: c.from, to: c.to, how,
                public: !!(extra && extra.public === true),
                deviation: str(extra && extra.deviation),
                at: str(extra && extra.at),
                floor: Number((extra && extra.floor) || 0),
                source: REL_SYNC[String((extra && extra.source) || 'mech')] || 'mech',
                note: str(extra && extra.note).slice(0, 60),
            });
        } catch (e) { /* 单条失败不影响其余 */ }
    };
    const ref = (dim, id) => relRef(dim, id);
    const anchoredRef = (v, dim) => {          // 引用项 {dim,refId} / {dim,id} / 纯 id 字符串
        if (isObj(v)) { const d = str(v.dim || v.category); const i = str(v.refId || v.id || v.ref); return (d && i) ? relRef(d, i) : null; }
        const i = str(v);
        return (dim && i) ? relRef(dim, i) : null;
    };
    const scene = sceneIndex();
    const scan = { n: 0 };

    // ① links：锚行（条目级属性）+ 非锚行（知情）
    for (const l of arr(state.links)) {
        if (!l) continue;
        const atom = ref(l.dim, l.refId);
        if (!atom) continue;
        scan.n += 1;
        if (linksOff) continue;                                 // 关联层关闭 → 不做 links 投影（其它字段派生不受影响）
        const who = str(l.who);
        if (!who) {                                             // 锚行：引用与公开标记
            const pub = l.public === true;
            const pairs = [['member-of', l.conceptRef, 'concepts'], ['member-of', l.atomRef, 'atoms'],
                ['member-of', l.planRef, 'plans'], ['member-of', l.suspenseRef, 'suspense']];
            for (const [t, v, d] of pairs) { const to = str(v) ? ref(d, str(v)) : null; if (to) add(t, atom, to, { source: 'mech', public: pub }); }
            for (const m of arr(l.memRefs)) { const to = anchoredRef(m, 'memories'); if (to) add('member-of', atom, to, { source: 'mech', public: pub }); }
            for (const s of arr(l.sourceRefs)) { const to = anchoredRef(s); if (to) add('derived-from', atom, to, { source: 'mech', public: pub }); }
            continue;
        }
        // 非锚行：认知边（`deviation=unaware` → knows-not，对齐 D2 §3.2）
        const anchor = arr(state.links).filter((x) => x && String(x.dim) === String(l.dim) && String(x.refId) === String(l.refId) && !str(x.who))[0] || null;
        add(str(l.deviation) === 'unaware' ? 'knows-not' : 'knows', atom, { who: who }, {
            how: l.how, public: !!(anchor && anchor.public === true), deviation: l.deviation,
            at: l.at, floor: Number(l.floorEnd) || 0, source: 'mech',
        });
    }

    // ② parallels：来源 / 转正 / 关联计划与悬念
    for (const p of arr(state.parallels)) {
        if (!p || !p.id) continue;
        scan.n += 1;
        const self = ref('parallels', p.id);
        for (const s of arr(p.sourceRefs)) { const to = anchoredRef(s); if (to) add('derived-from', self, to, { source: 'mech', at: p.date }); }
        const prom = str(p.promotedTo);
        if (prom && prom !== '情节') { const atom = ref('atoms', prom); if (atom) add('derived-from', atom, self, { source: 'mech', at: p.date }); }
        if (str(p.planRef)) { const to = ref('plans', str(p.planRef)); if (to) add('member-of', self, to, { source: 'mech' }); }
        if (str(p.suspenseRef)) { const to = ref('suspense', str(p.suspenseRef)); if (to) add('member-of', self, to, { source: 'mech' }); }
    }

    // ③ plans / suspense：结构化引用
    for (const p of arr(state.plans)) {
        if (!p || !p.id) continue;
        scan.n += 1;
        const self = ref('plans', p.id);
        for (const [d, list] of [['atoms', p.atomRefs], ['memories', p.memRefs], ['suspense', p.suspenseRefs]]) {
            for (const x of arr(list)) { const to = ref(d, x); if (to) add('member-of', self, to, { source: 'mech' }); }
        }
    }
    for (const s of arr(state.suspense)) {
        if (!s || !s.id) continue;
        scan.n += 1;
        const self = ref('suspense', s.id);
        for (const [d, list] of [['plans', s.planRefs], ['memories', s.memRefs], ['atoms', s.atomRefs]]) {
            for (const x of arr(list)) { const to = ref(d, x); if (to) add('member-of', self, to, { source: 'mech' }); }
        }
    }

    // ④ 分段总结 / 情节总结 → 来源
    for (const g of arr(state.plotSegments)) {
        if (!g || !g.id) continue;
        scan.n += 1;
        const self = ref('plotSegments', g.id);
        for (const x of arr(g.atomIds)) { const to = ref('atoms', x); if (to) add('derived-from', self, to, { source: 'mech' }); }
    }
    for (const a of arr(state.atoms)) {
        if (!a || !a.id) continue;
        scan.n += 1;
        const ms = isObj(a.mergedSummary) ? a.mergedSummary : null;
        if (ms) { const self = ref('atoms', a.id); for (const x of arr(ms.sourceIds)) { const to = ref('atoms', x); if (to) add('derived-from', self, to, { source: 'mech', note: '情节总结' }); } }
    }

    // ⑤ 传言：谱系父子 + 与平行事件的镜像
    for (const r of arr(state.rumors)) {
        if (!r || !r.id) continue;
        scan.n += 1;
        const self = ref('rumors', r.id);
        const parent = str(r.lineage && r.lineage.parentId);
        if (parent) { const to = ref('rumors', parent); if (to) add('derived-from', self, to, { source: 'mech' }); }
        for (const x of arr(r.parallelRefs)) { const to = ref('parallels', x); if (to) add('mirrors', self, to, { source: 'mech', at: r.date }); }
    }

    // ⑥ 归属（owns）：物品 / 货币 / 记忆的 owner → 角色
    const OWNER_DIMS = [['items', arr(state.items)], ['currencies', arr(state.currencies)], ['memories', arr(state.memories)]];
    for (const [dim, list] of OWNER_DIMS) {
        for (const e of list) {
            if (!e || !e.id) continue;
            scan.n += 1;
            const owner = str(e.owner);
            if (!owner || owner === '通用') continue;            // 「通用」= 无归属，不建边（不臆造）
            add('owns', { who: owner }, ref(dim, e.id), { source: 'mech' });
        }
    }

    // ⑦ 位置（located-at）：原子 → 场景（名称 / 路径**精确**匹配；匹配不到不建边）
    const LOC_SOURCES = [['atoms', arr(state.atoms), 'locations'], ['items', arr(state.items), 'location'], ['parallels', arr(state.parallels), 'location']];
    for (const [dim, list, field] of LOC_SOURCES) {
        for (const e of list) {
            if (!e || !e.id) continue;
            scan.n += 1;
            const raw = field === 'locations' ? arr(e.locations) : (str(e[field]) ? [str(e[field])] : []);
            for (const loc of raw) {
                const name = str(loc);
                if (!name) continue;
                const sid = scene.byName.get(name) || scene.byPath.get(name) || null;
                if (sid && sid !== String(e.id)) add('located-at', ref(dim, e.id), ref('scenes', sid), { source: 'inferred', note: name });
            }
        }
    }

    // ⑧ 场景层级（member-of）：子场景 → 父场景（按路径前缀解析，确定性）
    for (const s of arr(state.scenes)) {
        if (!s || !s.id) continue;
        scan.n += 1;
        const path = arr(s.pathArr).map(str).filter(Boolean);
        if (path.length < 2) continue;
        const parentPath = path.slice(0, path.length - 1).join('>');
        const pid = scene.byPath.get(parentPath);
        if (pid && pid !== String(s.id)) add('member-of', ref('scenes', s.id), ref('scenes', pid), { source: 'mech' });
    }

    // 输出：先按词表顺序（认知 → 结构 → 归属 → 位置 → 推演），再按端点和端点键 —— 两端重复派生结果完全一致
    const order = relTypeKeys();
    let edges = Array.from(map.values()).sort((a, b) => {
        const ta = order.indexOf(a.type), tb = order.indexOf(b.type);
        if (ta !== tb) return ta - tb;
        const fa = endKey(a.from), fb = endKey(b.from);
        if (fa !== fb) return fa < fb ? -1 : 1;
        const ga = endKey(a.to), gb = endKey(b.to);
        if (ga !== gb) return ga < gb ? -1 : 1;
        return a.how < b.how ? -1 : (a.how > b.how ? 1 : 0);
    });
    let truncated = false;
    if (edges.length > max) { edges = edges.slice(0, max); truncated = true; }
    return { edges, truncated, linksOff, scanned: scan.n };
}
/** 来源白名单（避免派生器造出词表外的 source） */
const REL_SYNC = { mech: 'mech', manual: 'manual', ai: 'ai', inferred: 'inferred' };

/**
 * 反向索引（D2 T2 / D4 §2.2）：**谁依赖我** —— 以 `ref` 为终点的全部边。
 * @param {object} ref `{dim,id}`（或 `{who}`）
 * @param {{max?:number, edges?:Array}} [opts] 可传入已派生的边集合，避免重复派生
 * @returns {Array} 边数组（含 `fromLabel` 便于 UI 直接展示）
 */
export function dependents(ref, opts) {
    const o = opts || {};
    const key = endKey(ref);
    if (!key) return [];
    const edges = arr(o.edges).length ? o.edges : deriveRelations({ max: o.max }).edges;
    return edges.filter((e) => endKey(e.to) === key).map((e) => Object.assign({}, e, {
        fromLabel: relEndpointLabel(e.from), fromCoord: relEndpointCoord(e.from), fromDimLabel: relDimLabel(e.from && e.from.dim),
    }));
}
/** 正向：我引用了谁 / 谁知道我（以 `ref` 为起点） */
export function relationsOf(ref, opts) {
    const o = opts || {};
    const key = endKey(ref);
    if (!key) return [];
    const edges = arr(o.edges).length ? o.edges : deriveRelations({ max: o.max }).edges;
    return edges.filter((e) => endKey(e.from) === key).map((e) => Object.assign({}, e, {
        toLabel: relEndpointLabel(e.to), toCoord: relEndpointCoord(e.to), toDimLabel: relDimLabel(e.to && e.to.dim),
    }));
}

/**
 * 一次派生的快照 + 统计（UI 只派生一次即够）。
 * @returns {{edges:Array, stats:object, truncated:boolean, linksOff:boolean}}
 */
export function relationSnapshot(opts) {
    const o = opts || {};
    const d = deriveRelations({ max: o.max });
    const stats = { total: d.edges.length, byType: {}, byFromDim: {}, byToDim: {}, chars: 0, dangling: 0, scanned: d.scanned, truncated: d.truncated, linksOff: d.linksOff };
    for (const e of d.edges) {
        stats.byType[e.type] = (stats.byType[e.type] || 0) + 1;
        if (e.from && e.from.dim) stats.byFromDim[e.from.dim] = (stats.byFromDim[e.from.dim] || 0) + 1;
        if (e.to && e.to.dim) stats.byToDim[e.to.dim] = (stats.byToDim[e.to.dim] || 0) + 1;
        if (e.to && e.to.who) stats.chars += 1;
    }
    // 死链：端点指向的条目已不存在（沿用既有孤儿口径，扩展为全类型）
    try {
        for (const e of d.edges) {
            const bad = [e.from, e.to].some((r) => r && r.dim && !arr(state[r.dim]).some((x) => x && String(x.id) === String(r.id)));
            if (bad) stats.dangling += 1;
        }
    } catch (e2) { /* 忽略 */ }
    return { edges: d.edges, stats, truncated: d.truncated, linksOff: d.linksOff };
}

/**
 * 查询解析：把用户输入变成候选端点。
 *   · `dim:id` 形式 → 精确端点（如 `atoms:a1`、`parallels:par_x`）；
 *   · 其它文本 → 在各维度条目里按标题/正文**子串**匹配（上限 8 条，确定性顺序）。
 * @returns {Array<{ref:object, dimLabel:string, title:string, coord:string}>}
 */
export function relationQueryRefs(q, opts) {
    const o = opts || {};
    const text = str(q);
    if (!text) return [];
    const out = [];
    const m = /^([A-Za-z]+)\s*[:：]\s*(.+)$/.exec(text);
    if (m) {
        const dim = str(m[1]), id = str(m[2]);
        const known = DIMENSIONS.some((d) => String(d.kind) === dim);
        if (known) {
            const hit = arr(state[dim]).filter((x) => x && String(x.id) === id)[0];
            out.push({ ref: relRef(dim, id), dimLabel: relDimLabel(dim), title: hit ? relEndpointLabel({ dim: dim, id: id }) : '（条目已不在库中）', coord: dim + ':' + id });
            return out;
        }
    }
    const low = text.toLowerCase();
    for (const d of DIMENSIONS) {
        for (const e of arr(state[d.kind])) {
            if (!e || !e.id) continue;
            const hay = [e.title, e.name, e.content, e.text, e.subject, e.value, e.desc].map((x) => str(x).toLowerCase()).join(' ');
            if (!hay || hay.indexOf(low) < 0) continue;
            out.push({ ref: relRef(d.kind, e.id), dimLabel: relDimLabel(d.kind), title: relEndpointLabel({ dim: d.kind, id: e.id }), coord: d.kind + ':' + String(e.id) });
            if (out.length >= Math.max(1, Number(o.max) || 8)) return out;
        }
    }
    return out;
}

/** 只读诊断（FTT 入口与测试用） */
export function relationStats() { const s = relationSnapshot(); return s.stats; }
