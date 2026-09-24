// ============================================================
// core/forget.js —— **遗忘域**（B8-5：记忆遗忘机制 + 通用遗忘清扫；逐字移植自 V1 `09-AI摘要与楼层处理.js`）
// 覆盖：
//   ① 记忆遗忘机制（v1.63）：`memoryForgetAvg`（总体均值）/ `memoryForgetScore`（只按剧情日期老化 × 低重要度加速缺口，
//      封顶 ×1.5；≥ 均值者免疫）/ `memoryForgetExpired`（达阈值 `memoryForgetCutoff` 默认 0.9）/
//      `scheduleMemoryForget`（记忆写入后 3s 防抖）/ `runMemoryForget`（**不得跌破保底** `storeMinFor('memories')`；
//      移除留墓碑，跨端不再复活）；
//   ② 通用遗忘清扫（v1.153）：`LOWUSE_FORGET_DIMS`（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）/
//      `lowUseSceneIsLeaf`（场景只删叶子）/ `lowUseSweepGate` + `lowUseSweepMark`（**清扫间隔闸门**，默认 40 楼）/
//      `sweepLowUseForget`（条件：维度条目数 ≥ `lowUseForgetMinItems`、平均调用 ≥ `lowUseForgetMinAvg`、
//      删除「uses ≤ 平均 × ratio」且「≥ `lowUseForgetMinFloors` 楼未再出现」者；保护重要度 ≥ 阈值、名册/档案只删
//      「从未被调用（uses=0）」、每维度每轮最多 `lowUseForgetMaxDelete` 条、不跌破保底；移除留墓碑）。
// 说明：状态记录衰退（`runStateDecay` / `scheduleStateDecay`）与库存裁剪（`enforceDimCaps` / `storeCapFor` / `storeMinFor`）
//   已在 `core/ingest.js` 移植，本模块只做**记忆遗忘 + 通用清扫**并用同一批助手（不重复实现）。
//   V1 的触发口径：状态/记忆的衰退与遗忘是**自动**的（写入后防抖调度），通用清扫在「自动修复」管线内执行（B8-6 接线）；
//   本模块另导出 `forgetRunAll`（V2 诊断入口：一次跑齐三类清扫）供 `FTT.*` 与测试使用。
// 一致性由 tests/unit/forget-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { cfg, state, saveState, notifyHooks, dbgLog, timerHooks, getLastMessageId } from './model/runtime.js';
import { storyDateMsFromStr } from './clock.js';
import { tombMany } from './merge.js';
import {
    storeMinFor, storeCapFor, repairClampNum, memoryImportance, calcTimeDecay, runStateDecay, enforceDimCaps,
} from './ingest.js';

// ---------- 记忆遗忘机制（v1.63） ----------
/** 记忆平均重要度（空库返回 0.5） */
function memoryForgetAvg() {
    const list = state.memories || [];
    if (!list.length) return 0.5;
    const sum = list.reduce((s, m) => s + memoryImportance(m), 0);
    return sum / list.length;
}
/** 单条遗忘值（0 = 免疫/无剧情时钟；>0 才参与遗忘） */
function memoryForgetScore(m) {
    const imp = memoryImportance(m);
    const avg = memoryForgetAvg();
    if (imp >= avg) return 0;                                // 不低于总体均值 → 免疫遗忘
    const now = storyDateMsFromStr(state.state && state.state.date);
    if (!now) return 0;                                      // 无剧情时钟 → 永不遗忘
    const list = state.memories || [];
    const ts = list.map(x => storyDateMsFromStr(x && x.date)).filter(t => !!t);   // 负年份（公元前）同样计入
    const earliest = ts.length ? Math.min.apply(null, ts) : 0;
    const latest = ts.length ? Math.max.apply(null, ts) : 0;
    const t = calcTimeDecay(earliest, latest, now, storyDateMsFromStr(m && m.date), list.length);
    // v1.145：加速缺口封顶 ×1.5（调低遗忘速度，避免信息被快速删除）
    const deficit = imp <= 0 ? 1.5 : Math.min(1.5, avg / imp);
    return Math.min(1, t * deficit);
}
/** 是否达遗忘阈值（受 `cfg.memoryForgetEnabled` 与 `cfg.memoryForgetCutoff` 控制） */
function memoryForgetExpired(m) {
    if (!cfg || cfg.memoryForgetEnabled === false) return false;
    const cutoff = Number(cfg.memoryForgetCutoff) != null ? Number(cfg.memoryForgetCutoff) : 0.9;
    return memoryForgetScore(m) >= Math.min(1, Math.max(0, cutoff));
}
/** 延迟堆叠调度（3s 窗口内多次记忆更新合并为一次清扫） */
let memoryForgetTimer = null;
function scheduleMemoryForget() {
    try {
        if (!cfg || cfg.memoryForgetEnabled === false) return false;
        if (!state || !state.state || !state.state.date) return false;   // 无剧情时钟不调度
        if (memoryForgetTimer) return false;
        memoryForgetTimer = timerHooks.set(async () => {
            memoryForgetTimer = null;
            try { await runMemoryForget({}); } catch (e) { /* 忽略 */ }
        }, 3000);
        return true;
    } catch (e) { return false; }
}
/**
 * 记忆遗忘清扫（V1 `runMemoryForget`）：达阈值且未跌破保底的低重要度旧记忆被移除并留墓碑。
 * @param {object} [opts] force（忽略触发比例，直接清理达阈值者）
 */
async function runMemoryForget(opts) {
    try {
        if (!cfg || cfg.memoryForgetEnabled === false) return { removed: 0, triggered: false, reason: 'disabled' };
        if (!state || !state.state || !state.state.date) return { removed: 0, triggered: false, reason: 'no-story-clock' };
        const o = opts || {};
        const list = state.memories || [];
        const n = list.length;
        const cap = storeCapFor('memories');
        const floor = storeMinFor('memories');                  // 保底 —— 遗忘不得跌破
        const ratio = Math.min(1, Math.max(0, Number(cfg.memoryForgetRatio) != null ? Number(cfg.memoryForgetRatio) : 0.5));
        const overRatio = n > Math.floor(cap * ratio);           // 超出存储上限 ×比例
        const avg = memoryForgetAvg();
        const expiredAll = list.filter(memoryForgetExpired);     // 遗忘值 ≥ 阈值 → 自动移除候选
        const removable = Math.max(0, n - floor);
        const expired = expiredAll.slice(0, removable);
        if (!o.force && !overRatio && !expired.length) return { removed: 0, triggered: false, overRatio, n, cap, floor };
        if (expired.length) {
            const removeIds = new Set(expired.map(x => x.id || JSON.stringify(x).slice(0, 60)));
            // v1.117：遗忘移除记墓碑（跨端不再复活已遗忘记忆）
            try { tombMany('memories', Array.from(removeIds)); } catch (e) { /* 忽略 */ }
            state.memories = list.filter(x => !removeIds.has(x.id || JSON.stringify(x).slice(0, 60)));
            try { saveState(); } catch (e) { /* 忽略 */ }
        }
        try {
            dbgLog('发送记忆', { action: '记忆遗忘清扫', n, cap, overRatio, avg, cutoff: Number(cfg.memoryForgetCutoff), removed: expired.length, titles: expired.slice(0, 6).map(x => String(x.title || x.content || x.id || '').slice(0, 30)) });
        } catch (e) { /* 忽略 */ }
        if (expired.length) {
            const remain = (state.memories || []).length;
            try { notify('info', `🧠 记忆遗忘清扫：${expired.length} 条低重要度旧记忆自动遗忘（剩 ${remain}）`, ''); } catch (e) { /* 忽略 */ }
        }
        return { removed: expired.length, triggered: overRatio || expired.length > 0, overRatio, n, cap, avg, remain: (state.memories || []).length };
    } catch (e) { return { removed: 0, triggered: false, error: String((e && e.message) || e) }; }
}

// ---------- 通用遗忘清扫（v1.153） ----------
/** 清扫维度（V1 `LOWUSE_FORGET_DIMS`）：tomb=null 表示该维度无 id 墓碑（V1 原样） */
const LOWUSE_FORGET_DIMS = [
    { dim: 'concepts', label: '概念', tomb: 'concepts' },
    { dim: 'scenes', label: '场景', tomb: 'scenes', leafOnly: true },
    { dim: 'npcs', label: '名册', tomb: null, zeroOnly: true },
    { dim: 'plans', label: '计划', tomb: null },
    { dim: 'suspense', label: '悬念', tomb: null },
    { dim: 'snapshots', label: '角色档案', tomb: 'snapshots', zeroOnly: true },
];
/** 场景「叶子」判定：没有被别的节点当作祖先路径（否则删父节点会让子节点失去层级） */
function lowUseSceneIsLeaf(arr, idx) {
    try {
        const me = arr[idx];
        const myPath = Array.isArray(me && me.pathArr) ? me.pathArr.map(x => String(x)) : [];
        if (!myPath.length) return true;
        for (let i = 0; i < arr.length; i++) {
            if (i === idx) continue;
            const p = Array.isArray(arr[i] && arr[i].pathArr) ? arr[i].pathArr.map(x => String(x)) : [];
            if (p.length > myPath.length && myPath.every((v, k) => p[k] === v)) return false;
        }
        return true;
    } catch (e) { return false; }
}
function lowUseSweepFloorKey(kind) { return String(kind || 'general') + 'Floor'; }
/** 清扫间隔闸门：距上次清扫不足 everyFloors 楼 → 本轮整项跳过（缓慢滴灌） */
function lowUseSweepGate(kind, everyFloors) {
    const every = Math.max(0, Number(everyFloors) || 0);
    const lastFloor = (() => { try { return Math.max(0, Number(getLastMessageId()) || 0); } catch (e) { return 0; } })();
    let last = 0;
    try { last = Math.max(0, Number((state.lowUseForget && state.lowUseForget[lowUseSweepFloorKey(kind)]) || 0)); } catch (e) { /* 忽略 */ }
    if (every > 0 && last > 0 && (lastFloor - last) < every) return { ok: false, every, last, lastFloor, wait: every - (lastFloor - last) };
    return { ok: true, every, last, lastFloor, wait: 0 };
}
function lowUseSweepMark(kind, lastFloor) {
    try {
        const o = Object.assign({}, (state.lowUseForget && typeof state.lowUseForget === 'object') ? state.lowUseForget : {});
        o[lowUseSweepFloorKey(kind)] = Math.max(0, Number(lastFloor) || 0);
        state.lowUseForget = o;
    } catch (e) { /* 忽略 */ }
}
/**
 * 通用遗忘清扫（V1 `sweepLowUseForget`）
 * @param {object} [opts] dims 限定维度
 * @returns {{swept:number, dims:object, skipped:string[], avg:object, candidates:number, cooldown?:object}}
 */
function sweepLowUseForget(opts) {
    const out = { swept: 0, dims: {}, skipped: [], avg: {}, candidates: 0 };
    try {
        if (!(cfg && cfg.lowUseForgetEnabled)) { out.skipped.push('disabled'); return out; }
        const everyFloors = Math.max(0, Number((cfg && cfg.lowUseForgetEveryFloors) != null ? cfg.lowUseForgetEveryFloors : 40));
        const lastFloorNow = (() => { try { return Math.max(0, Number(getLastMessageId()) || 0); } catch (e) { return 0; } })();
        const gate = lowUseSweepGate('general', everyFloors);
        if (!gate.ok) {
            out.skipped.push('cooldown');
            out.cooldown = { last: gate.last, need: gate.every, wait: gate.wait, floor: gate.lastFloor };
            return out;
        }
        const ratio = repairClampNum(cfg && cfg.lowUseForgetRatio, 0.01, 0.9, 0.1);
        const minItems = Math.max(2, Number((cfg && cfg.lowUseForgetMinItems)) || 40);
        const minAvg = Math.max(0, Number((cfg && cfg.lowUseForgetMinAvg) != null ? cfg.lowUseForgetMinAvg : 3));
        const minFloors = Math.max(0, Number((cfg && cfg.lowUseForgetMinFloors) != null ? cfg.lowUseForgetMinFloors : 0));
        const maxDel = Math.max(1, Number((cfg && cfg.lowUseForgetMaxDelete)) || 3);
        const protectImp = repairClampNum(cfg && cfg.lowUseForgetProtectImportance, 0, 1, 0.6);
        // 「长期未现」门槛默认 0 = 本项清扫不生效（用户填 >0 才启用）
        if (!(minFloors > 0)) { out.skipped.push('long-absent-disabled'); return out; }
        const lastFloor = lastFloorNow;
        const only = (opts && Array.isArray(opts.dims)) ? opts.dims : null;
        let sweepConsidered = false;   // 本轮是否真正对某维度做过清扫尝试（决定是否占用冷却）
        for (const spec of LOWUSE_FORGET_DIMS) {
            if (only && only.indexOf(spec.dim) < 0) continue;
            const arr = Array.isArray(state[spec.dim]) ? state[spec.dim] : [];
            const dimFloor = storeMinFor(spec.dim);              // 保底（不跌破）
            if (arr.length <= dimFloor) { out.skipped.push(spec.dim + ':at-floor'); continue; }
            if (arr.length < minItems) { out.skipped.push(spec.dim + ':too-few'); continue; }
            let sum = 0;
            for (const e of arr) { if (e) sum += Number(e.uses) || 0; }
            const avg = sum / Math.max(1, arr.length);
            out.avg[spec.dim] = Number(avg.toFixed(2));
            if (avg < minAvg) { out.skipped.push(spec.dim + ':avg-low'); continue; }
            sweepConsidered = true;
            const thr = avg * ratio;
            const cands = [];
            let lowUseSeenCount = 0;                       // 低使用但「不够旧」的条数（跳过原因用）
            for (let i = 0; i < arr.length; i++) {
                const e = arr[i];
                if (!e || typeof e !== 'object') continue;
                const uses = Number(e.uses) || 0;
                if (uses > thr) continue;
                if (spec.zeroOnly && uses !== 0) continue;
                if (Number(e.importance) >= protectImp) continue;
                const seen = Math.max(Number(e.floorEnd) || 0, Number(e.floorStart) || 0);
                if (!seen) continue;                       // 无楼层信息 → 来历不明，不删
                const age = lastFloor - seen;
                if (age < minFloors) { lowUseSeenCount++; continue; }   // 未「长期未现」→ 不删
                if (spec.leafOnly && !lowUseSceneIsLeaf(arr, i)) continue;
                cands.push({ e, uses, age, i });
            }
            out.candidates += cands.length;
            if (!cands.length) { out.skipped.push(spec.dim + (lowUseSeenCount ? ':too-recent' : ':no-candidate')); continue; }
            cands.sort((x, y) => (x.uses - y.uses) || (y.age - x.age));
            const del = cands.slice(0, Math.max(0, Math.min(maxDel, arr.length - dimFloor)));   // 不跌破保底
            const ids = del.map(d => String(d.e.id));
            try { if (spec.tomb) tombMany(spec.tomb, ids); } catch (e) { /* 忽略 */ }
            const idSet = new Set(ids);
            state[spec.dim] = arr.filter(x => !(x && idSet.has(String(x.id))));
            out.swept += del.length;
            out.dims[spec.dim] = { label: spec.label, removed: del.length, names: del.map(d => `${d.e.name || d.e.title || d.e.content || d.e.subject || d.e.id}(${d.uses}次·${d.age}楼)`) };
        }
        // 记录本轮清扫楼层（下次需再等 everyFloors 楼才允许清扫）；仅当本轮确实对某维度做过尝试时才占冷却
        if (sweepConsidered) lowUseSweepMark('general', lastFloorNow);
        out.floor = lastFloorNow;
        out.every = everyFloors;
    } catch (e) { /* 忽略 */ }
    return out;
}

// ---------- 诊断汇总与统一入口 ----------
/** 遗忘域状态（配置 + 触发条件，只读；供设置页状态行与 `FTT.*`） */
function forgetState() {
    try {
        const lastFloor = (() => { try { return Math.max(0, Number(getLastMessageId()) || 0); } catch (e) { return 0; } })();
        const gate = lowUseSweepGate('general', Math.max(0, Number(cfg && cfg.lowUseForgetEveryFloors != null ? cfg.lowUseForgetEveryFloors : 40)));
        return {
            stateDecay: { enabled: !(cfg && cfg.stateDecayEnabled === false), ratio: cfg && cfg.stateDecayRatio, cutoff: cfg && cfg.stateDecayCutoff, states: (state.currentStates || []).length, cap: Math.max(1, Number(cfg && cfg.maxStates) || 30) },
            memoryForget: { enabled: !!(cfg && cfg.memoryForgetEnabled === true), ratio: cfg && cfg.memoryForgetRatio, cutoff: cfg && cfg.memoryForgetCutoff, memories: (state.memories || []).length, cap: storeCapFor('memories'), floor: storeMinFor('memories'), avg: Number(memoryForgetAvg().toFixed(3)) },
            lowUse: { enabled: !!(cfg && cfg.lowUseForgetEnabled), dims: LOWUSE_FORGET_DIMS.map(d => d.dim), lastFloor: Number((state.lowUseForget && state.lowUseForget.generalFloor) || 0), now: lastFloor, gateOk: gate.ok, every: gate.every, wait: gate.wait },
        };
    } catch (e) { return { stateDecay: {}, memoryForget: {}, lowUse: {} }; }
}
/**
 * 一次跑齐三类清扫（V2 诊断/测试入口：V1 中它们分别由时钟推进调度、记忆写入调度与「自动修复」管线触发）
 * @param {object} [opts] force（状态衰退/记忆遗忘忽略触发比例）
 */
async function forgetRunAll(opts) {
    const o = opts || {};
    const out = { at: Date.now(), decay: null, forget: null, sweep: null };
    try { out.decay = await runStateDecay({ force: !!o.force }); } catch (e) { out.decay = { error: String((e && e.message) || e) }; }
    try { out.forget = await runMemoryForget({ force: !!o.force }); } catch (e) { out.forget = { error: String((e && e.message) || e) }; }
    try { out.sweep = sweepLowUseForget(o.sweep || {}); } catch (e) { out.sweep = { error: String((e && e.message) || e) }; }
    try { out.caps = enforceDimCaps(); } catch (e) { out.caps = { error: String((e && e.message) || e) }; }
    return out;
}
/** 清空待执行的遗忘定时器（组件卸载/测试隔离） */
function cancelForgetTimers() {
    try { if (memoryForgetTimer) { timerHooks.clear(memoryForgetTimer); memoryForgetTimer = null; } } catch (e) { /* 忽略 */ }
    return true;
}
/** 用户提示（经宿主钩子） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

export {
    LOWUSE_FORGET_DIMS,
    memoryForgetAvg, memoryForgetScore, memoryForgetExpired, scheduleMemoryForget, runMemoryForget,
    lowUseSceneIsLeaf, lowUseSweepGate, lowUseSweepMark, sweepLowUseForget,
    forgetState, forgetRunAll, cancelForgetTimers,
};
