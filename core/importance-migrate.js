// ============================================================
// core/importance-migrate.js —— **旧数据重要度迁移重算 + C3 权重切换**（v3.50.24，`docs/D22` W4 `数-1`）
//
// 缺陷（`docs/D20` §8 `数-1` / `docs/D7` §4.9 C3）：
//   · 存量条目的 `importance` 是 **V1 语义值**（≈0.5：`base + uses×per`），而 v2.86.0 起新语义是
//     **窗口调用占比**（≈1/21 ≈ 0.048）→ 两套尺度混在一份数据里；
//   · 因此召回打分里的重要度权重**一直不敢改**（`0.15` → `1.6` 会把重要度项放大 ~10 倍，
//     在旧值上会**改变注入择优**，破坏 V1 注入保真）。
//
// 本模块把两件事**同批**做掉（裁决 `D20` Q4：**仅窗内 + 逐批**）：
//   ① `migrateLegacyImportance()`：先按新语义**重算窗内条目**（复用 `recalcImportanceAfterExtract({force})`），
//      再把**窗外**的旧尺度值**整体缩放到新尺度**（÷10，保留相对次序）→ 一份数据只有一种尺度；
//   ② 迁移完成后 `state.meta.importanceV2 = true`；召回权重按此标志切换
//      （`0.15`（旧）→ `1.6`（新）），于是**迁移前/后的注入择优等价**。
//
// 幂等：`importanceV2 === true` 时直接跳过（一次性动作）。纯内核：不碰宿主 / DOM / 定时器。
// ============================================================
import { state } from './model/runtime.js';
import { IMP_DIMS, recalcImportanceAfterExtract } from './importance.js';

/** 迁移标志的位置（`state.meta`，随存档走；缺失即未迁移） */
export const IMP_MIGRATE_FLAG = 'importanceV2';
/** 旧尺度 → 新尺度的缩放（旧均值 ≈0.5、新均值 ≈1/21≈0.048 → ÷10 使「均值贡献」基本不变） */
export const IMP_LEGACY_SCALE = 0.1;
/** C3 权重：迁移前 / 迁移后（`docs/D7` §4.9 C3） */
export const IMP_WEIGHT_LEGACY = 0.15;
export const IMP_WEIGHT_V2 = 1.6;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round3 = (n) => Math.round(num(n) * 1000) / 1000;

/** 是否已完成迁移（只读） */
export function importanceMigrated(st) {
    try {
        const s = st || state || {};
        return !!(s.meta && s.meta[IMP_MIGRATE_FLAG] === true);
    } catch (e) { return false; }
}

/** 当前应使用的 C3 权重（迁移前 0.15 / 迁移后 1.6） */
export function importanceWeight(st) {
    return importanceMigrated(st) ? IMP_WEIGHT_V2 : IMP_WEIGHT_LEGACY;
}

/**
 * **执行迁移**（一次性；幂等）。
 *
 * @param {{state?:object, force?:boolean, scaleOutside?:number}} [opts]
 * @returns {{ok:boolean, migrated:boolean, recalc:object, scaled:number, dims:object}}
 */
export function migrateLegacyImportance(opts) {
    const o = opts || {};
    const s = o.state || state || {};
    const out = { ok: true, migrated: false, recalc: null, scaled: 0, dims: {} };
    try {
        if (importanceMigrated(s) && !o.force) { out.skipped = 'already'; return out; }
        // ① 窗内：按新语义重算（窗口占比）
        let recalc = null;
        try { recalc = recalcImportanceAfterExtract({ force: true }); } catch (e) { recalc = null; }
        out.recalc = recalc;
        // ② 窗外：旧尺度整体缩放（保留相对次序；只做一次）
        const scale = Number.isFinite(Number(o.scaleOutside)) ? Number(o.scaleOutside) : IMP_LEGACY_SCALE;
        for (const dim of IMP_DIMS) {
            const arr = Array.isArray(s[dim]) ? s[dim] : [];
            if (!arr.length) continue;
            const touched = num(recalc && recalc.dims && recalc.dims[dim] && recalc.dims[dim].updated);
            // 重算只覆盖「最近 N 条」→ 前面那些仍是旧尺度
            const outside = Math.max(0, arr.length - (touched || 0));
            let n = 0;
            for (let i = 0; i < outside; i++) {
                const e = arr[i];
                if (!e || typeof e !== 'object') continue;
                const v = num(e.importance);
                if (v <= 0) continue;
                e.importance = round3(v * scale);
                if (e.strength !== undefined) e.strength = Math.round(Math.max(0, Math.min(1, e.importance)) * 100);
                n++;
            }
            out.dims[dim] = { outside: outside, scaled: n };
            out.scaled += n;
        }
        // ③ 打标（此后权重切到 1.6；再调也不会重跑）
        s.meta = (s.meta && typeof s.meta === 'object') ? s.meta : {};
        s.meta[IMP_MIGRATE_FLAG] = true;
        out.migrated = true;
        return out;
    } catch (e) {
        return { ok: false, migrated: false, recalc: null, scaled: 0, dims: {}, error: String((e && e.message) || e) };
    }
}
