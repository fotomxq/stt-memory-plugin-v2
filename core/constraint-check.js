// ============================================================
// core/constraint-check.js —— **约束的机械校验**（v3.50.22，`docs/D22` §4.3 W2 `业-2` / `docs/D2` §5.2 + §6 S3）
//
// 用户要求：「开发W2待开发事项。」→ 选取 `业-2`（`D2` S3：**约束可机械校验**，finding 沿用体检形态）。
//
// 两条口径（`docs/D2` §5.2）：
//   ① **落库前**（防 AI 幻觉）：条目带 `sourceRefs` 等「依据」时，指向的**楼层 / 条目**必须真实存在 ——
//      不存在的剔除并如实计 `dropped`（不是整条拒收，避免一次幻觉把整条好数据丢掉）；
//   ② **落库后**（体检）：机械派生 + 校验 → 产出 finding，形态沿用体检的
//      `{code, level, dim, id, field, value, detail}`，**只报告不改数据**（`N4`：不自动删改）。
//
// 覆盖的校验（都可机械判定，零 AI）：
//   · `ref-orphan`      依据指向不存在的条目（悬空引用 = 幻觉最典型形态）
//   · `ref-floor-missing` 依据里的楼层号超过「已见最大楼层」（引用未来楼层 = 幻觉）
//   · `causal-inverted` 依据条目的发生楼层**晚于**本条（因果倒挂）
//   · `evidence-invalid` 条目自带的 `evidence`（若给了）解析不出有效楼层
//
// 纯内核：不碰宿主 / DOM / 定时器（`scripts/check-core-purity.js`）；**只读**，绝不改 `state`。
// ============================================================
import { cfg } from './model/runtime.js';

/** 校验 code（与体检的 `counts` 键同名，便于汇总） */
export const CONSTRAINT_CODES = Object.freeze(['ref-orphan', 'ref-floor-missing', 'causal-inverted', 'evidence-invalid']);

/** 带「依据」字段的维度 → 引用允许指向的维度（`D2` §5.2 / `D4`） */
export const CONSTRAINT_REF_DIMS = Object.freeze({
    parallels: ['atoms', 'memories'],
    rumors: ['atoms', 'memories', 'parallels'],
    plans: ['atoms', 'memories'],
    suspense: ['atoms', 'memories'],
    memories: ['atoms'],
});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => String(v == null ? '' : v).trim();

/** 取条目的「依据」列表（`sourceRefs` / `关联来源` / `来源`），归一到 `[{dim, refId, floor}]` */
export function entryRefs(entry) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const raw = e.sourceRefs !== undefined ? e.sourceRefs : (e['关联来源'] !== undefined ? e['关联来源'] : e['来源']);
    const arr = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
    const out = [];
    for (const x of arr) {
        if (x == null) continue;
        if (typeof x === 'string') { if (str(x)) out.push({ dim: '', refId: str(x), floor: 0 }); continue; }
        if (typeof x !== 'object') continue;
        const dim = str(x.dim || x.kind || x['维度']);
        const refId = str(x.refId !== undefined ? x.refId : (x.id !== undefined ? x.id : x['条目']));
        const floor = num(x.floor !== undefined ? x.floor : (x['楼层'] !== undefined ? x['楼层'] : x.at));
        if (!refId && !floor) continue;
        out.push({ dim, refId, floor });
    }
    return out;
}

/** 取条目自带 `evidence`（若给了）：可解析为楼层号 / 引用对象 */
export function entryEvidence(entry) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const raw = e.evidence !== undefined ? e.evidence : e['依据'];
    if (raw === undefined || raw === null || raw === '') return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const x of arr) {
        if (x == null) continue;
        if (typeof x === 'number') { out.push({ floor: num(x), refId: '' }); continue; }
        if (typeof x === 'string') {
            const m = /(\d+)/.exec(x);
            // 纯文本依据：有楼层号 → 当楼层；**没有数字 → 判为不可解析**（floor=0、refId 空，供 evidence-invalid 报出）
            out.push({ floor: m ? num(m[1]) : 0, refId: '' });
            continue;
        }
        if (typeof x === 'object') {
            out.push({ floor: num(x.floor !== undefined ? x.floor : (x['楼层'] !== undefined ? x['楼层'] : x.at)), refId: str(x.refId !== undefined ? x.refId : x.id) });
        }
    }
    return out;
}

/** 建索引：维度 → id 集合；以及 id → floorStart（用于因果倒挂判定） */
export function buildConstraintIndex(state) {
    const s = (state && typeof state === 'object') ? state : {};
    const byDim = Object.create(null);
    const floorOf = Object.create(null);
    for (const dim of Object.keys(CONSTRAINT_REF_DIMS).concat(['atoms', 'memories', 'parallels'])) {
        const arr = Array.isArray(s[dim]) ? s[dim] : [];
        const set = new Set();
        for (const x of arr) {
            if (!x || typeof x !== 'object') continue;
            const id = str(x.id);
            if (id) { set.add(id); floorOf[dim + ':' + id] = num(x.floorStart) || num(x.floorEnd) || 0; }
        }
        byDim[dim] = set;
    }
    return { byDim: byDim, floorOf: floorOf };
}

/**
 * **落库前**：剔除指向不存在目标的依据（防幻觉）。
 * @param {string} dim 维度键
 * @param {object} entry 条目
 * @param {{state?:object, maxFloor?:number}} [ctx]
 * @returns {{entry:object, kept:Array, dropped:Array}}
 */
export function filterInvalidRefs(dim, entry, ctx) {
    const c = ctx || {};
    const e = (entry && typeof entry === 'object') ? Object.assign({}, entry) : {};
    const idx = c.index || buildConstraintIndex(c.state || {});
    const maxFloor = num(c.maxFloor) || 0;
    const refs = entryRefs(e);
    const allowed = CONSTRAINT_REF_DIMS[String(dim)] || null;
    const kept = [], dropped = [];
    for (const r of refs) {
        const dimOk = !r.dim ? true : (!allowed || allowed.indexOf(r.dim) >= 0);
        const exists = r.refId ? (idx.byDim[(r.dim || String(dim))] ? idx.byDim[(r.dim || String(dim))].has(r.refId) : false) : true;
        const floorOk = r.floor > 0 ? (!maxFloor || r.floor <= maxFloor) : true;
        if (dimOk && exists && floorOk) kept.push(r);
        else dropped.push(r);
    }
    if (refs.length) e.sourceRefs = kept.map((r) => ({ dim: r.dim, refId: r.refId, floor: r.floor }));
    return { entry: e, kept: kept, dropped: dropped };
}

/**
 * **落库后**：机械校验，产出 finding（只读、不改数据）。
 * @param {object} state 内核 state
 * @param {{maxFloor?:number, dims?:Array, cap?:number}} [opts]
 * @returns {Array<{code:string, level:string, dim:string, id:string, field:string, value:*, detail:string}>}
 */
export function constraintFindings(state, opts) {
    const s = (state && typeof state === 'object') ? state : {};
    const o = opts || {};
    const maxFloor = num(o.maxFloor) || 0;
    const cap = Math.max(1, num(o.cap) || 200);
    const dims = Array.isArray(o.dims) && o.dims.length ? o.dims : Object.keys(CONSTRAINT_REF_DIMS);
    const idx = buildConstraintIndex(s);
    const out = [];
    const push = (code, dim, id, field, value, detail) => {
        if (out.length >= cap) return;
        out.push({ code: code, level: 'warn', dim: dim, id: String(id), field: field, value: value, detail: detail });
    };
    for (const dim of dims) {
        const arr = Array.isArray(s[dim]) ? s[dim] : [];
        for (const e of arr) {
            if (!e || typeof e !== 'object') continue;
            const id = str(e.id);
            const selfFloor = num(e.floorStart) || num(e.floorEnd) || 0;
            // ① 依据 → 悬空 / 未来楼层 / 因果倒挂
            for (const r of entryRefs(e)) {
                const rd = r.dim || dim;
                const known = idx.byDim[rd] ? idx.byDim[rd].has(r.refId) : false;
                if (r.refId && !known) {
                    push('ref-orphan', dim, id, 'sourceRefs', r.refId, '依据指向不存在的条目（疑似幻觉）：' + rd + '#' + r.refId);
                    continue;
                }
                if (r.floor > 0 && maxFloor > 0 && r.floor > maxFloor) {
                    push('ref-floor-missing', dim, id, 'sourceRefs', r.floor, '依据楼层超过已见最大楼层（' + maxFloor + '）：' + r.floor);
                    continue;
                }
                if (r.refId && selfFloor > 0) {
                    const refFloor = num(idx.floorOf[rd + ':' + r.refId]) || r.floor || 0;
                    if (refFloor > 0 && refFloor > selfFloor) {
                        push('causal-inverted', dim, id, 'sourceRefs', r.refId, '因果倒挂：依据的发生楼层（' + refFloor + '）晚于本条（' + selfFloor + '）');
                    }
                }
            }
            // ② 条目自带 evidence（若给了）解析不出有效楼层
            for (const ev of entryEvidence(e)) {
                if (!ev.floor && !ev.refId) {
                    push('evidence-invalid', dim, id, 'evidence', String((e && e.evidence) || ''), 'evidence 解析不出有效楼层或条目引用');
                    break;
                }
            }
        }
    }
    return out;
}

/** 校验器总开关（`cfg.constraintCheckEnabled`，默认开；关 → 一条都不报） */
export function constraintCheckOn() {
    try { return (cfg && cfg.constraintCheckEnabled) !== false; } catch (e) { return true; }
}
