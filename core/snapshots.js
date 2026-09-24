// ============================================================
// core/snapshots.js —— **快照链**（B7-1，逐字移植自 V1 `src/modules/05-记忆状态与存储抽象.js`）
// 覆盖：`snapshotCreateFull`（全量根快照）/ `snapshotCreateIncr`（增量）/ `snapshotMergeSnap`（合并）/
//   `snapshotConsolidate`（多根合并 + 超上限把最早 15 个增量并入根）/ `snapshotRestore`（按时间线回滚，
//   含「删除账本按序生效」以免复活已删条目）/ `snapshotClear` / `snapshotStats` / `scheduleSnapshotIncr`（防抖调度）。
// 适配（与 V1 的唯一差别）：
//   ① 落盘改为内核 `saveState()` 注入钩子（V1 用 `saveStateRaw`）；
//   ② 用户提示改经 `notifyHooks`（V1 用 `notify`）；面板重绘由 UI 层自行负责（此处 no-op）；
//   ③ 延迟调度改经 `timerHooks`（V1 用全局 `setTimeout`）；④ 存储策略上限/批次取 V1 常量（30 / 15）。
// 快照结构（V1 原样）：`{ id, kind:'root'|'incr', ts, baseId, hash, atomsHashes, atoms:{id: 序列化内容}, deleted }`
// ============================================================
import { state, cfg, log, warn, saveState, notifyHooks, timerHooks } from './model/runtime.js';
import { ATOM_DIM_KEYS } from './constants.js';
import { eachAtom, collectAtomHashes, ensureAtomHashes } from './merge.js';
import { atomContentHash } from './model/hash.js';
import { storageHash } from './envelope.js';
import { entryIndexInit, tombstoneSweepPause, tombstoneSweepResume } from './sweep.js';

/** V1 常量：快照总数上限与「并入根的批次」、增量防抖延迟 */
const SNAP_CAP = 30;
const SNAP_BATCH = 15;
const SNAP_INCR_DELAY = 400;
/** 快照自身写库期间抑制再次调度（V1 同名变量语义） */
let snapSaving = false;
/** 存储策略（V1 `storePolicy('snapshot')`：上限 30 / 并入批次 15） */
function storePolicy(kind) { return (String(kind) === 'snapshot') ? { cap: SNAP_CAP, evict: { batch: SNAP_BATCH } } : null; }
/** 落盘（V1 的 `saveStateRaw`：本模块不再自建写库逻辑，统一走内核注入钩子） */
function saveStateRaw() { try { return saveState(); } catch (e) { return false; } }
/** 用户提示（V1 `notify(kind,{title,text})` → 宿主通知钩子） */
function notify(kind, opts) {
    try {
        const o = opts || {};
        const text = [String(o.title || ''), String(o.text || '')].filter(Boolean).join(' ');
        if (text) notifyHooks.toast(text, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/** 面板重绘：快照内核不直接碰 UI（调用方在动作完成后重渲染） */
function renderPanel() { /* no-op：UI 层负责 */ }

    // 原子内容序列化（备份用）：深拷贝实质内容 + 类别标记；剔除 h/uses/floor/日志等运行态可再生成字段
    function atomSerialize(cat, it) {
        try {
            const o = JSON.parse(JSON.stringify(it));
            for (const k of ['h', 'uses', 'floorStart', 'floorEnd', 'updatedAt', 'updatedAtTime', 'history', 'log', '__cat']) delete o[k];
            o.__cat = cat;
            return o;
        } catch (e) { return { __cat: cat }; }
    }
    // 为所有原子补全/刷新 h 字段（缺省补全；内容未变的 h 幂等不变；saveState 前统一调用）
    // 收集当前全部原子的 {id: {h, cat, item}} 与聚合 hash
    // ==================== 快照整理与删除动作账本 ====================
    // 删除动作账本：每个快照记录「自上一快照以来被删除的原子」{id: {h, cat}} —— 只存哈希不存原文（便于汇总与还原剔除）。
    // 快照指纹 state.snapFp：上一快照时刻全部原子 id → {h, cat}；删除 = 指纹有、当前无（两次快照间只记一次）。
    function snapFpFromCurrent() {
        const cur = collectAtomHashes();
        const fp = {};
        for (const id of cur.order) fp[id] = { h: cur.map[id].h, cat: cur.map[id].cat };
        return fp;
    }
    // 把 src 快照并入 target（atoms/atomsHashes 后写覆盖；deleted 账本并集；聚合 hash 重算）
    function snapshotMergeSnap(target, src) {
        try {
            if (!target || !src) return;
            if (src.atoms) for (const id in src.atoms) target.atoms[id] = src.atoms[id];
            if (src.atomsHashes) for (const id in src.atomsHashes) target.atomsHashes[id] = src.atomsHashes[id];
            if (src.deleted) target.deleted = Object.assign(target.deleted || {}, src.deleted);
            if (target.atomsHashes) {
                const ids = Object.keys(target.atomsHashes).sort();
                target.hash = storageHash(ids.map(id => `${id}:${target.atomsHashes[id] || ''}`).join('|'));
            }
        } catch (e) { }
    }
    // 快照整理：
    //   R3 全局只允许一个根快照 —— 出现多个按 ts 合并为一个（后根内容覆盖先根，含 deleted 账本）；
    //   R2 总量 > SNAP_CAP(30) —— 每次把「最早 15 个增量」并入根快照（可多轮至 ≤30 或仅剩根）；
    //   发生变更后落库（saveStateRaw，不触发快照递归）。返回 {roots, folded, changed}
    function snapshotConsolidate() {
        try {
            const snaps0 = state.snapStore = state.snapStore || [];
            if (!snaps0.length) return { roots: 0, folded: 0, changed: false };
            const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
            let changed = false;
            // R3：多根合并为一个
            let roots = snaps0.filter(s => s.kind === 'root').sort(byTs);
            if (roots.length > 1) {
                const base = roots[0];
                for (let i = 1; i < roots.length; i++) snapshotMergeSnap(base, roots[i]);
                const baseId = base.id;
                const keepIncr = state.snapStore.filter(s => s.kind !== 'root');
                state.snapStore = [base, ...keepIncr].sort(byTs);
                changed = true;
                roots = [state.snapStore.find(s => s.id === baseId) || base];
            }
            const root = roots[0] || null;
            // R2：总量超限 → 最早 15 个增量并入根（可多轮）
            let folded = 0;
            // v1.151：上限/批次由「统一存储抽象」的 snapshot 分类策略给出（缺省回退原常量）
            const snapPolicy = (typeof storePolicy === 'function') ? storePolicy('snapshot') : null;
            const capNow = (snapPolicy && snapPolicy.cap > 0) ? snapPolicy.cap : SNAP_CAP;
            const batchNow = (snapPolicy && snapPolicy.evict && snapPolicy.evict.batch) ? snapPolicy.evict.batch : 15;
            while ((state.snapStore || []).length > capNow) {
                const store = state.snapStore;
                const incrs = store.filter(s => s.kind !== 'root').sort(byTs);
                const batch = incrs.slice(0, batchNow);
                if (!root || !batch.length) break;
                for (const s of batch) snapshotMergeSnap(root, s);
                const dropIds = new Set(batch.map(s => s.id));
                state.snapStore = [root, ...store.filter(s => s.id !== root.id && !dropIds.has(s.id))].sort(byTs);
                folded += batch.length;
                changed = true;
            }
            if (changed) saveStateRaw();
            return { roots: root ? 1 : 0, folded, changed };
        } catch (e) { warn('快照整理失败', e); return { roots: -1, folded: 0, changed: false }; }
    }
    function snapshotTs() { return new Date().toISOString(); }
    function snapshotId(kind) { return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; }
    // 快照结构：{ id, kind:'root'|'incr', ts, baseId, hash(聚合), atomsHashes:{id:h}(去重/差异识别), atoms:{id: 序列化内容}(备份) }
    // 全量根快照：备份当前全部原子（无原子时返回 null，不建空根）
    function snapshotCreateFull() {
        try {
            ensureAtomHashes();
            const { map, agg } = collectAtomHashes();
            if (!Object.keys(map).length) return null;
            const atoms = {};
            const atomsHashes = {};
            for (const id of Object.keys(map)) { atomsHashes[id] = map[id].h; atoms[id] = atomSerialize(map[id].cat, map[id].it); }
            const snap = { id: snapshotId('root'), kind: 'root', ts: snapshotTs(), baseId: null, hash: agg, atomsHashes, atoms };
            (state.snapStore = state.snapStore || []).push(snap);
            state.snapFp = snapFpFromCurrent();          // 指纹 = 当前全部原子（删除动作从下一增量起算）
            trimSnapshots();
            saveStateRaw();
            return snap;
        } catch (e) { warn('根快照创建失败', e); return null; }
    }
    // 增量快照：与所有快照的 atomsHashes 并集对比，只备份「内容 hash 变化/新增」的原子（已完全一致的跳过 → 不重复备份）
    function snapshotCreateIncr() {
        try {
            ensureAtomHashes();
            const snaps = state.snapStore = state.snapStore || [];
            const last = snaps[snaps.length - 1] || null;
            const known = {};
            for (const s of snaps) { if (s && s.atomsHashes) { for (const id in s.atomsHashes) known[id] = s.atomsHashes[id]; } }
            const cur = collectAtomHashes();
            const changedIds = [];
            for (const id of cur.order) {
                if (!(id in known) || known[id] !== cur.map[id].h) changedIds.push(id);
            }
            // 删除动作 = 上一指纹中有、当前已消失的原子（两次快照间只记一次；只存哈希不存原文）
            const fp = (state.snapFp && typeof state.snapFp === 'object') ? state.snapFp : null;
            const deleted = {};
            if (fp) for (const id in fp) { if (!(id in cur.map)) deleted[id] = fp[id]; }
            const delN = Object.keys(deleted).length;
            if (!changedIds.length && !delN) {
                snapshotConsolidate();                   // 无变化也顺手整理（多根合并 / 超限并入）
                return last || snapshotCreateFull();     // 无变化且有快照 → 跳过；无快照 → 建根
            }
            if (!changedIds.length && !last && !cur.order.length) return null;   // 全删且无基线 → 无快照可建
            const atoms = {};
            const atomsHashes = {};
            for (const id of changedIds) { atomsHashes[id] = cur.map[id].h; atoms[id] = atomSerialize(cur.map[id].cat, cur.map[id].it); }
            const snap = { id: snapshotId('incr'), kind: 'incr', ts: snapshotTs(), baseId: last ? last.id : null, hash: storageHash(atomsHashes), atomsHashes, atoms };
            if (delN) snap.deleted = deleted;            // 本增量期间被删除的原子动作（便于汇总/还原剔除）
            snaps.push(snap);
            state.snapFp = snapFpFromCurrent();          // 指纹推进到当前，删除只记一次
            trimSnapshots();
            saveStateRaw();
            return snap;
        } catch (e) { warn('增量快照创建失败', e); return null; }
    }
    function trimSnapshots() {
        // 不再「挤最旧增量」—— 上限 30，超出把最早 15 个增量并入根快照；多根自动合并为单根
        try { snapshotConsolidate(); } catch (e) { }
    }
    // 兜底检测：存在无快照记录的原子（从未被任何快照覆盖）→ 若已有快照则立即增量补全；无任何快照 → 全量根快照
    function snapshotEnsureBase() {
        try {
            const snaps = state.snapStore = state.snapStore || [];
            ensureAtomHashes();
            const known = {};
            for (const s of snaps) if (s && s.atomsHashes) for (const id in s.atomsHashes) known[id] = s.atomsHashes[id];
            const cur = collectAtomHashes();
            const uncovered = cur.order.filter(id => !(id in known));
            if (!snaps.length) return snapshotCreateFull();
            if (uncovered.length) return snapshotCreateIncr();
            return null;
        } catch (e) { return null; }
    }
    // 400ms 防抖增量调度（原子数据变动后由 saveState 触发）
    let snapTimer = null;
    function scheduleSnapshotIncr() {
        try {
            if (snapTimer) return;
            snapTimer = timerHooks.set(() => {
                snapTimer = null;
                try { snapshotCreateIncr(); } catch (e) { }
            }, SNAP_INCR_DELAY);
        } catch (e) { }
    }
    // 找到指定快照 id
    function snapshotFind(id) { return (state.snapStore || []).find(s => s.id === id) || null; }
    // 删除全部快照（不动记忆本体）
    function snapshotClear() {
        state.snapStore = [];
        state.snapFp = {};                               // 指纹一并复位
        snapSaving = true; try { saveStateRaw(); } finally { snapSaving = false; }
        return true;
    }
    // 回溯还原：以目标快照为基，把「其后所有快照中记录的原子内容」按序应用（增量补全语义），
    // 生成到该时刻的完整原子集合。返回 {ok, added, replaced, removed}
    function snapshotRestore(id) {
        try {
            const snaps = state.snapStore || [];
            const idx = snaps.findIndex(s => s.id === id);
            if (idx < 0) return { ok: false, error: '未找到快照' };
            // 还原到目标快照时刻：取「该快照及之前所有快照」的 atoms 并集（后出现的覆盖先出现的）。
            // 根快照=全量基线；增量=在该基线上的变更补全 → 0..idx 并集即该时刻的完整数据态。
            const merged = {};   // id → serialized atom
            for (let i = 0; i <= idx; i++) {
                const s = snaps[i];
                if (s && s.atoms) { for (const aid in s.atoms) merged[aid] = s.atoms[aid]; }
            }
            // 删除动作参与还原 —— 沿时间线按序应用：快照含该原子 → 出现；该快照 deleted 账本命中 → 剔除
            //        （其后重新出现则再次计入；修复旧版「还原会把已删原子复活」问题）
            const effective = new Set();
            for (let i = 0; i <= idx; i++) {
                const s = snaps[i];
                if (!s) continue;
                if (s.atoms) for (const aid in s.atoms) effective.add(aid);
                if (s.deleted) for (const aid in s.deleted) effective.delete(aid);
            }
            // 用 merged 内容重建各维数组（按 __cat 归类；保留现有 id 稳定）
            const rebuilt = {};
            for (const cat of ATOM_DIM_KEYS) rebuilt[cat] = [];
            let added = 0;
            for (const aid of Object.keys(merged)) {
                if (!effective.has(aid)) continue;       // 该时刻已被删除的原子不还原
                const atom = merged[aid];
                const cat = atom.__cat || 'atoms';
                if (!ATOM_DIM_KEYS.includes(cat)) continue;
                const clean = JSON.parse(JSON.stringify(atom));
                delete clean.__cat;
                // 保留 h/uses/floor 由 ensureAtomHashes/saveState 重算；快照内容不含这些（atomSerialize 已剔除）
                rebuilt[cat].push(clean);
                added++;
            }
            // 替换 state 各维（快照外的维度字段保持现状，如 vars/state/processedFloors）
            for (const cat of ATOM_DIM_KEYS) state[cat] = rebuilt[cat];
            state.snapFp = snapFpFromCurrent();          // 指纹对齐还原后的数据态（后续删除动作从新基线起算）
            // 快照还原是「回滚」，不是删除 —— 抑制自动留痕，避免把被回滚掉的条目作为删除推给对端
            tombstoneSweepPause();
            try { snapSaving = true; saveStateRaw(); } finally { snapSaving = false; tombstoneSweepResume(); }
            entryIndexInit();                            // 索引对齐还原后的数据态
            try { if (typeof renderPanel === 'function') renderPanel(); } catch (e) { }
            notify('info', { title: '已还原到快照', text: `${String(id).slice(0, 14)}…（${added} 条原子；含该快照前增量补全）` });
            return { ok: true, added };
        } catch (e) { warn('快照还原失败', e); return { ok: false, error: String(e.message || e).slice(0, 120) }; }
    }
    // 快照检查（调试/UI 摘要）：读取前先整理（单根 + 超限并入），返回统计（含删除动作汇总）
    function snapshotStats() {
        snapshotConsolidate();                           // 读取即整理（多根合并 / 超 30 早 15 并入根）
        const snaps = state.snapStore || [];
        const rootN = snaps.filter(s => s.kind === 'root').length;
        const incrN = snaps.length - rootN;
        const covered = {};
        let deleted = 0;
        for (const s of snaps) {
            if (s && s.atomsHashes) for (const id in s.atomsHashes) covered[id] = true;
            if (s && s.deleted) deleted += Object.keys(s.deleted).length;
        }
        return { total: snaps.length, root: rootN, incr: incrN, covered: Object.keys(covered).length, deleted };
    }
    // ==================== 删除自动留痕（覆盖所有删除路径） ====================
    // 需求④：记录被删除的原子数据，避免被删除后又被某一端唤醒。
    // 手工在各删除点写墓碑容易漏（UI 删除 / AI 增量删除 / 状态衰退 / 遗忘 / 情节总结 / 级联删角色…）。
    // 这里做**统一兜底**：每次保存前对比「上一次的 id→内容哈希索引」，凡本次消失且同内容也已不在的条目
    // 自动补记 id + 内容哈希墓碑（同内容仍在＝去重/换 id，不算删除）。删除点无需各自改造。

export {
    SNAP_CAP, SNAP_BATCH, SNAP_INCR_DELAY,
    snapshotCreateFull, snapshotCreateIncr, snapshotConsolidate, snapshotMergeSnap,
    snapshotRestore, snapshotClear, snapshotStats, snapshotFind, atomSerialize,
    scheduleSnapshotIncr,
};
