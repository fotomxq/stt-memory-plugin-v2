// ============================================================
// core/importance.js —— **重要度动态计算**（v2.86.0；依据 `docs/D7-重要度动态计算设计稿.md` v0.5）
// 口径（用户裁决，逐条对应 D7）：
//   · **重要度 = 窗口调用占比**：`imp(i) = uses(i) ÷ Σ uses(k)`，窗口 `k ∈ [i−R, i+R]`（**含自身**，R1=含自身）；
//   · 半径 `R = impWindowRadius`（默认 10）、每次重算**最近 N 条**（`impRecalcCount` 默认 20）；
//   · **第 N 条也要按它真实的 ±R 邻居算**（分母可越过重算边界，读窗外条目的 uses）；
//   · 出窗（第 N+1 条及更旧）**不再重算**（值恒定），但仍作为窗内条目的分母参与；
//   · **逐维独立**（D7 §4.6.1）：每个大类各自成序、各自开窗；**状态记录按「主体」分组**（组内成序）；
//   · 窗口内全部 0 次调用 → 0（R23）；结果存 3 位小数（四舍五入）；
//   · **不做任何读时归一化**（Q6 裁决）；淘汰 / 清扫 / 打分**直接用该值**，阈值以常数重标定（见 `config.js` / `recall.js`）。
// 触发：**每次提取记忆落库之后**（与 v2.81.0 的「分析后校准」同一挂点，见 `host/preflight.js#recalibrateAfterExtract`）。
// 性质：纯计算（无 DOM / 无宿主 / 无时间依赖）；同一 state 连续两次调用结果一致（幂等）。
// ============================================================
import { state, cfg } from './model/runtime.js';

/** 参与重要度窗口的维度（R24：10 维中的 9 个独立容器 + 状态记录按主体分组） */
export const IMP_DIMS = Object.freeze(['atoms', 'memories', 'snapshots', 'items', 'concepts', 'scenes', 'plans', 'suspense', 'rumors']);

/** 默认参数（R25：可配） */
export const IMP_WINDOW_RADIUS_DEFAULT = 10;
export const IMP_RECALC_COUNT_DEFAULT = 20;

function cfgNum(v, dft, lo, hi) {
    if (v === null || v === undefined || v === '') return dft;      // 未设置 / 清空 → 回落默认
    const n = Number(v);
    if (!Number.isFinite(n) || !(n > 0)) return dft;                // 非法 / 非正数 → 回落默认（半径与条数都必须为正）
    return Math.max(lo, Math.min(hi, Math.floor(n)));
}
/** 窗口半径（默认 10；1-50） */
export function impWindowRadius() { try { return cfgNum(cfg && cfg.impWindowRadius, IMP_WINDOW_RADIUS_DEFAULT, 1, 50); } catch (e) { return IMP_WINDOW_RADIUS_DEFAULT; } }
/** 每次重算条数（默认 20；1-200） */
export function impRecalcCount() { try { return cfgNum(cfg && cfg.impRecalcCount, IMP_RECALC_COUNT_DEFAULT, 1, 200); } catch (e) { return IMP_RECALC_COUNT_DEFAULT; } }
/** 开关（默认开；关闭则不重算，历史值保持不变） */
export function impRecalcEnabled() { try { return !(cfg && cfg.impRecalcEnabled === false); } catch (e) { return true; } }

/**
 * **窗口占比**（纯函数）：给定「按数组顺序（尾 = 最新）」的 uses 序列与下标，算占比。
 * @param {number[]} usesList 该维（或该主体组）的 uses 序列
 * @param {number} i 目标下标
 * @param {number} radius 窗口半径
 * @returns {number} 0–1（3 位小数）；窗口内合计为 0 → 0
 */
export function windowShare(usesList, i, radius) {
    const list = Array.isArray(usesList) ? usesList : [];
    if (i < 0 || i >= list.length) return 0;
    const R = Math.max(1, Math.floor(Number(radius) || IMP_WINDOW_RADIUS_DEFAULT));
    const lo = Math.max(0, i - R), hi = Math.min(list.length - 1, i + R);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += (Number(list[k]) || 0);
    if (!(sum > 0)) return 0;                                  // R23：窗口内全 0 调用 → 0
    const self = Number(list[i]) || 0;
    return Math.round((self / sum) * 1000) / 1000;
}

/**
 * 对**一个序列**（同维同序；状态记录 = 同一主体组）重算最近 N 条的占比，并写回条目的 `importance`（`strength` 同步）。
 * @returns {{updated:number, frozen:number}}
 */
function recalcList(list, opts) {
    const arr = Array.isArray(list) ? list : [];
    const R = (opts && opts.radius) || impWindowRadius();
    const N = (opts && opts.count) || impRecalcCount();
    const usesList = arr.map((e) => Number(e && e.uses) || 0);
    const from = Math.max(0, arr.length - N);                  // 最近 N 条（含第 N 条；其窗口可越过该边界读窗外 uses）
    let updated = 0;
    for (let i = from; i < arr.length; i++) {
        const e = arr[i];
        if (!e || typeof e !== 'object') continue;
        const imp = windowShare(usesList, i, R);
        if (Number(e.importance) !== imp) { e.importance = imp; updated++; }
        // V1 兼容字段：strength = round(importance × 100)（D7 §3.3 C6）
        if (e.strength !== undefined) e.strength = Math.round(imp * 100);
    }
    return { updated: updated, frozen: from };
}

/**
 * **每次提取记忆后**重算重要度（D7 §4.5）：逐维独立；状态记录按「主体」分组（组内成序）。
 * @param {object} [opts] `{ dims?: string[], radius?: number, count?: number }`（便于单测限定范围）
 * @returns {{dims:object, updated:number, frozen:number, skipped?:string}}
 */
export function recalcImportanceAfterExtract(opts) {
    const o = opts || {};
    const out = { dims: {}, updated: 0, frozen: 0 };
    try {
        if (!impRecalcEnabled() && !o.force) { out.skipped = 'disabled'; return out; }
        const dims = Array.isArray(o.dims) && o.dims.length ? o.dims : IMP_DIMS;
        for (const dim of dims) {
            const arr = Array.isArray(state[dim]) ? state[dim] : [];
            if (!arr.length) { out.dims[dim] = { updated: 0, frozen: 0 }; continue; }
            const r = recalcList(arr, o);
            out.dims[dim] = r;
            out.updated += r.updated;
            out.frozen += r.frozen;
        }
        // 状态记录：按主体分组（D7 Q2 裁决；跨主体不比较）
        if (dims === IMP_DIMS || (Array.isArray(o.dims) && o.dims.indexOf('currentStates') >= 0)) {
            const groups = {};
            for (const e of (Array.isArray(state.currentStates) ? state.currentStates : [])) {
                if (!e || typeof e !== 'object') continue;
                const k = String(e.subject || '');
                (groups[k] = groups[k] || []).push(e);
            }
            let su = 0, sf = 0;
            for (const k of Object.keys(groups)) { const r = recalcList(groups[k], o); su += r.updated; sf += r.frozen; }
            if (Object.keys(groups).length) out.dims.currentStates = { updated: su, frozen: sf, groups: Object.keys(groups).length };
            out.updated += su;
            out.frozen += sf;
        }
        return out;
    } catch (e) { out.skipped = 'error'; return out; }
}

/** 只读诊断：列出某维（或状态某主体）最近 N 条的「当前值 / 重算值 / 是否冻结」（不写回） */
export function importancePreview(dim, opts) {
    const o = opts || {};
    const R = o.radius || impWindowRadius();
    const N = o.count || impRecalcCount();
    const list = (() => {
        if (dim === 'currentStates') {
            const subject = String(o.subject || '');
            return (Array.isArray(state.currentStates) ? state.currentStates : []).filter((e) => String((e && e.subject) || '') === subject);
        }
        return Array.isArray(state[dim]) ? state[dim] : [];
    })();
    const usesList = list.map((e) => Number(e && e.uses) || 0);
    const from = Math.max(0, list.length - N);
    return list.map((e, i) => ({
        id: String((e && e.id) || ''), uses: Number(e && e.uses) || 0,
        now: Number(e && e.importance) || 0,
        next: windowShare(usesList, i, R),
        frozen: i < from,
    }));
}
