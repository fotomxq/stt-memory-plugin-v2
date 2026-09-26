// ============================================================
// core/ingest.js —— **逐字移植自 V1**（src/modules/09-AI摘要与楼层处理.js 的 AI delta 落库内核）
// 覆盖：`mergeDelta(delta, floorRange)` —— 把 AI 产出的归一化增量（atoms/states/snapshots/memories/items/
//   plans/suspense/scenes/concepts/parallels/currencies/rumors/links 的 add/update/remove）**按 V1 同一顺序**
//   写进容器：归一化 → 定位既有条目（id/标题/正文）→ 原地更新（保留 uses 与因果日志 log）→ 新增；
//   已「总结隐藏」的情节不接受 AI 改写（v1.203 数据安全口径）；remove 仅过滤不写墓碑（墓碑由保存流水线负责）。
// 依赖：模型层归一化（core/model/*）、条目层（core/entries.js）、配置键映射（core/config.js）与内核注入视图。
// ============================================================

import { clockDateTrim, storyDateMsFromStr } from './clock.js';
import { normalizeDeltaKeys } from './config.js';
import { upsertRelLinks } from './entries.js';
import { atomIsHidden, capAtomsKeepingHidden, tombEntries, tombMany, tombSet } from './merge.js';
import { normalizeAtom } from './model/atom.js';
import { normalizeConcept, normalizeCurrentState, normalizeItem, normalizeMemory, normalizeNpc, normalizeParallel, normalizePlan, normalizeScene, normalizeSuspense } from './model/dims.js';
import { mergeMoneyHistory, moneyNet, normalizeCurrency, roundMoney } from './model/money.js';
import { normalizeRumor, normalizeRumorChain, normalizeRumorLineage, rumorChildId, rumorStageByFerment, rumorSubjectKey } from './model/rumor.js';
import { cfg, dbgLog, getStoryNow, log, notifyHooks, saveState, state, timerHooks, warn } from './model/runtime.js';
import { mergeTags, scenePathArr } from './model/scalars.js';
import { normalizeSnapshot, refreshAllSnapshotAges, snapshotBodySig, stampNowForState, stampSnapshotTime, syncSnapshotAge } from './model/snapshot.js';
import { injectNameCore, parallelExpired } from './recall.js';
import { clamp, normText, normalizeList } from './util.js';

// V1 的 `toast/sendToast` 是宿主弹窗：V2 内核经宿主通知钩子发出（缺失即静默，不影响落库）
function toast(text, kind) { try { notifyHooks.toast(String(text == null ? '' : text), String(kind || 'info')); } catch (e) { } }
const DECAY_MS_HOUR = 3600 * 1000;

const DECAY_MS_DAY = 24 * DECAY_MS_HOUR;

const DECAY_MS_MONTH = 30.44 * DECAY_MS_DAY;

const DECAY_MS_YEAR = 365.25 * DECAY_MS_DAY;
// —— 通用 5 参数多级时间衰退（底层方法，供各大类复用）——
// 入参：earliestAt 大类最早更新时间 / latestAt 大类最晚更新时间 / nowAt 总览当前时间 /
//       itemAt 被判断原子自身时间 / count 大类条目数；返回衰退值 0..1

let decayTimer = null;
// 每次平行事件更新后延迟堆叠：3s 窗口内多次更新合并为一次统一衰退计算

const SCENE_ADMIN_SUFFIX = /[市区县镇村郡府道街路]$/;

let stateDecayTimer = null;
// 每次状态增改删后延迟堆叠：3s 窗口内多次更新合并为一次统一衰退计算

let memoryForgetTimer = null;
// 每次记忆写入/更新/删除后延迟堆叠：3s 窗口内多次更新合并为一次统一遗忘清扫

const RUMOR_CHAIN_KINDS = ['起源', '传播', '发酵', '消退', '异变', '裂变', '联动', '载体停用'];

// 兜底上限 = `core/config.js#defaultCfg` 的默认值（v2.76.0 整体上调：句表内合计 5600，
//   承载 2000-3000 条原子数据的任意分布；用户可在 设定 → 遗忘 → 存储保底与上限 自行调整）
const STORE_LIMITS = {
    atoms:     ['storeMinAtoms', 'storeMaxAtoms', 1200, '情节'],
    memories:  ['storeMinMemories', 'storeMaxMemories', 800, '记忆'],
    snapshots: ['storeMinSnapshots', 'storeMaxSnapshots', 400, '角色档案'],
    items:     ['storeMinItems', 'storeMaxItems', 500, '物品'],
    concepts:  ['storeMinConcepts', 'storeMaxConcepts', 700, '概念'],
    scenes:    ['storeMinScenes', 'storeMaxScenes', 400, '场景'],
    plans:     ['storeMinPlans', 'storeMaxPlans', 300, '计划'],
    suspense:  ['storeMinSuspense', 'storeMaxSuspense', 300, '悬念'],
    npcs:      ['storeMinNpcs', 'storeMaxNpcs', 300, '名册'],
    rumors:    ['storeMinRumors', 'storeMaxRumors', 300, '传言'],   // v1.192：传言（存储上限；传言另有自己的时间衰退清扫）
};

const DIM_CAP_KEYS = Object.keys(STORE_LIMITS).map(dim => [dim, STORE_LIMITS[dim][3]]);

function mergeDelta(delta0, floorRange) {
    const delta = normalizeDeltaKeys(delta0 || {});
    try {
        if (!delta || typeof delta !== 'object') return false;
        const beforeTotal = totalMemoryCount();
        const storyNow = getStoryNow();
        const fb = floorRange || {};
        for (const a of delta.atoms?.add || []) {
            const n = normalizeAtom(a, fb);
            if (n) {
                if (!n.date) { n.date = storyNow.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || ''; }
                const i = state.atoms.findIndex(x => x.id === n.id);
                // v1.203：命中的是「已总结隐藏」情节 → 不改写（其内容已并入总结，改动会破坏来源与稳定性）
                if (i >= 0) { if (!atomIsHidden(state.atoms[i])) { n.uses = state.atoms[i].uses || 0; state.atoms[i] = n; } }
                else state.atoms.push(n);
            }
        }
        // v1.50：情节原子「更新」—— 依据 id/标题/原文定位既有原子，替换为修正版并保留因果日志（原记录→新事实），
        //         供正文变动/叠加造成早期原子改变时修复使用；未命中则按新增处理
        for (const u of delta.atoms?.update || []) {
            const n = normalizeAtom(u, fb);
            if (!n) continue;
            const i = state.atoms.findIndex(x => x.id === n.id || (u && u.id && x.id === String(u.id)) || (u && u.title && x.title === String(u.title)) || (u && u.text && x.text === String(u.text)) || (u && u.title && x.text === String(u.title)));
            if (i < 0) { if (!n.date) { n.date = (storyNow.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0]; } state.atoms.push(n); continue; }
            const prev = state.atoms[i];
            if (atomIsHidden(prev)) continue;   // v1.203：已总结隐藏情节不接受 AI 更新
            n.id = prev.id; n.uses = prev.uses || 0;
            const prevLog = Array.isArray(prev.log) ? prev.log.slice() : [];
            if (n.text !== prev.text) {
                prevLog.push({ prev: String(prev.text || '').slice(0, 160), date: prev.date || '', floorStart: prev.floorStart || 0, floorEnd: prev.floorEnd || 0 });
                n.log = prevLog.slice(-3);
            } else { n.log = prevLog; }
            state.atoms[i] = n;
        }
        for (const id of delta.atoms?.remove || []) { state.atoms = (state.atoms || []).filter(x => x.id !== id && x.text !== id); }
        for (const s of delta.states?.add || []) {
            const n = normalizeCurrentState(s);
            if (n) {
                // v2.39.0：无剧情日期时 `st.date` 为空 → **不写**（绝不用现实墙钟冒充剧情时间）
                const st = stampNowForState(); if (st.date) { n.updatedAt = n.updatedAt || st.date; n.updatedAtTime = n.updatedAtTime || st.time; }
                const i = state.currentStates.findIndex(x => x.id === n.id);
                if (i >= 0) { state.currentStates[i] = { ...state.currentStates[i], ...n }; } else state.currentStates.push(n);
            }
        }
        for (const s of delta.states?.update || []) {
            const n = normalizeCurrentState(s);
            if (n) {
                const st = stampNowForState(); if (st.date) { n.updatedAt = st.date; n.updatedAtTime = st.time; }
                const i = state.currentStates.findIndex(x => x.id === n.id);
                if (i >= 0) {
                    const prev = state.currentStates[i];
                    // v1.50：值变化时自动把「旧值」写入变更史（因果：旧值→新值，保留楼层来源；含外部显式 history）
                    let hist = Array.isArray(prev.history) ? prev.history.slice() : [];
                    const explicit = Array.isArray(n.history) ? n.history : [];
                    if (n.value !== undefined && n.value !== prev.value && prev.value !== undefined && prev.value !== null) {
                        hist.push({ value: String(prev.value), floorStart: Number(n.floorStart) >= 0 ? n.floorStart : prev.floorStart, floorEnd: Number(n.floorEnd) >= 0 ? n.floorEnd : prev.floorEnd, updatedAt: prev.updatedAt || st.date });
                    }
                    state.currentStates[i] = { ...prev, ...n, history: hist.concat(explicit).slice(-8) };
                }
            }
        }
        for (const id of delta.states?.remove || []) { try { tombSet('currentStates', id); } catch (e) { } state.currentStates = (state.currentStates || []).filter(x => x.id !== id && x.subject !== id); }
        // v1.62：状态增改删后顺带调度状态记录衰退（防抖；无剧情时钟时内部自动跳过）
        try { scheduleStateDecay(); } catch (e) { }
        // v1.63：记忆增改删（=「被想起」）后延迟堆叠调度记忆遗忘清扫（B8-5）
        try { if (delta.memories && (delta.memories.add || delta.memories.update || delta.memories.remove)) scheduleMemoryForget(); } catch (e) { }
        // v1.101 修复：快照 新增 与 更新 可能同时出现 —— 用 concat 合并处理（旧 `a || b` 在 add 非空时短路丢掉 update）
        for (const s of [].concat(delta.snapshots?.add || [], delta.snapshots?.update || [])) {
            const n = normalizeSnapshot(s);
            if (n) {
                const i = state.snapshots.findIndex(x => x.id === n.id || x.name === n.name);
                if (i >= 0) {
                    const prev = state.snapshots[i];
                    n.uses = prev.uses || 0;
                    const merged = mergeSnapshotObjects(prev, n);
                    // v1.161：档案实质内容真的变了 → 记「最后一次更新时间」（剧情时间为基准）
                    if (snapshotBodySig(merged) !== snapshotBodySig(prev)) { try { stampSnapshotTime(merged, 'update'); } catch (e) { } }
                    state.snapshots[i] = merged;
                } else { try { stampSnapshotTime(n, 'update'); } catch (e) { } state.snapshots.push(n); }
            }
        }
        // v1.176：**每次更新角色 → 被动刷新年龄**（固定规则，零 AI）——
        //   只要档案里存在出生日期，就用剧情锚点重算 identity.age；这里做成"全局刷新"（档案数量很小，
        //   开销可忽略），因此剧情日期推进后即使某些角色本轮没被 AI 更新，其落盘年龄也不会过期。
        if ((delta.snapshots?.add || []).length || (delta.snapshots?.update || []).length) {
            try {
                const ageSync = refreshAllSnapshotAges();
                if (ageSync.fixed || ageSync.cleared) {
                    try { dbgLog('摘要', { action: '年龄被动刷新（每次更新角色）', fixed: ageSync.fixed, cleared: ageSync.cleared, items: (ageSync.items || []).slice(0, 8) }); } catch (e) { }
                }
            } catch (e) { }
        }
        // v1.113：删除角色档案 → 联动清除该角色的状态记录（角色不在了其“当前状态”一并失效）
        if (Array.isArray(delta.snapshots?.remove) && delta.snapshots.remove.length) {
            const delSet = new Set(delta.snapshots.remove.map(x => String(x).trim()));
            const removedNames = (state.snapshots || []).filter(x => delSet.has(String(x.id)) || delSet.has(String(x.name))).map(x => x.name);
            state.snapshots = (state.snapshots || []).filter(x => !delSet.has(String(x.id)) && !delSet.has(String(x.name)));
            try { tombMany('snapshots', delta.snapshots.remove); } catch (e) { }   // v1.117 墓碑
            try { sweepStatesForRemovedSnapshots(removedNames); } catch (e) { }
        }
        for (const m of delta.memories?.add || []) {
            const n = normalizeMemory(m);
            if (n) {
                // v1.63：记忆写入/更新即「想起」—— 无日期时自动补剧情日期（遗忘引擎时间轴；AI 自带日期保留）
                // v1.63 原意是「无日期时自动补**剧情日期**」；v2.39.0 起无剧情日期时**留空**（不再写现实日期）
                if (!n.date) { try { const st = stampNowForState(); if (st.date) n.date = st.date; } catch (e) { } }
                const i = state.memories.findIndex(x => x.id === n.id);
                if (i >= 0) state.memories[i] = n; else state.memories.push(n);
            }
        }
        for (const id of delta.memories?.remove || []) { try { tombSet('memories', id); } catch (e) { } try { dropRelLinks('memories', [id]); } catch (e) { } state.memories = (state.memories || []).filter(x => x.id !== id && x.title !== id); }
        // v1.63：记忆增改删后顺带调度遗忘清扫（防抖；无剧情时钟时内部自动跳过）
        try { scheduleMemoryForget(); } catch (e) { }
        // v1.104：物品新增/更新统一处理 —— 同名只更新不新增；数量为 0 自动删除
        for (const it of (delta.items?.add || []).concat(delta.items?.update || [])) {
            const n = normalizeItem(it);
            if (n) {
                // v1.103：物品落库打时间戳（楼层 + 剧情日期）—— 供同名单修复/多位置时“取最新”
                const fe0 = Number(fb && fb.end), fs0 = Number(fb && fb.start);
                if (Number.isInteger(fe0) && fe0 >= 0) n.floorEnd = Math.max(Number(n.floorEnd) || 0, fe0);
                if (Number.isInteger(fs0) && fs0 >= 0) n.floorStart = Math.max(Number(n.floorStart) || 0, fs0);
                if (!n.seenDate && storyNow && /^-?\d{1,4}-\d{2}-\d{2}/.test(String(storyNow))) n.seenDate = clockDateTrim(storyNow);
                if (Number(n.qty) === 0) {
                    // v1.104：数量为 0 → 该物品自动删除（含历史遗留同名条目）
                    state.items = (state.items || []).filter(x => x.id !== n.id && x.name !== n.name);
                    continue;
                }
                // v1.104：同名物品只更新不新增（兼容历史 id 不一致的同名重复）
                const hadCarried = it && (it.carried !== undefined || it['携带'] !== undefined);
                let i = state.items.findIndex(x => x.id === n.id);
                if (i < 0) i = state.items.findIndex(x => x.name === n.name);
                if (i >= 0) {
                    const prev = state.items[i];
                    const merged = { ...prev, ...n, uses: Number(prev.uses) || 0 };
                    if (n.qty === undefined) merged.qty = prev.qty;
                    if (!hadCarried) merged.carried = prev.carried;
                    if (!n.desc && prev.desc) merged.desc = prev.desc;
                    if (!n.location && prev.location) merged.location = prev.location;
                    if (!(n.tags || []).length) merged.tags = prev.tags || [];
                    state.items[i] = merged;
                } else state.items.push(n);
            }
        }
        for (const id of delta.items?.remove || []) { try { tombSet('items', id); } catch (e) { } state.items = (state.items || []).filter(x => x.id !== id && x.name !== id); }
        // v1.181：货币大类 —— 同一「归属 + 币种」只维护一条（额度覆盖、收支追加）；归属默认主角
        if (cfg.currencyEnabled !== false) {
            for (const cu of (delta.currencies?.add || []).concat(delta.currencies?.update || [])) {
                const n = normalizeCurrency(cu);
                if (!n) continue;
                const fe0 = Number(fb && fb.end), fs0 = Number(fb && fb.start);
                if (Number.isInteger(fe0) && fe0 >= 0) n.floorEnd = Math.max(Number(n.floorEnd) || 0, fe0);
                if (Number.isInteger(fs0) && fs0 >= 0) n.floorStart = Math.max(Number(n.floorStart) || 0, fs0);
                if (!n.date && storyNow && /^-?\d{1,4}-\d{2}-\d{2}/.test(String(storyNow))) n.date = clockDateTrim(storyNow);
                const key = (x) => `${String((x && x.owner) || '').replace(/\s+/g, '').toLowerCase()}|${String((x && x.name) || '').replace(/\s+/g, '').toLowerCase()}`;
                let i = state.currencies.findIndex(x => x.id === n.id);
                if (i < 0) i = state.currencies.findIndex(x => key(x) === key(n));
                if (i >= 0) {
                    const prev = state.currencies[i];
                    const hasAmount = cu && (cu.amount !== undefined || cu['额度'] !== undefined || cu.balance !== undefined);
                    const merged = Object.assign({}, prev, n, {
                        uses: Number(prev.uses) || 0,
                        history: mergeMoneyHistory(prev.history, n.history),   // 收支追加（去重 · 保留最近 12 笔）
                        // 额度：本次给了就用新的；没给（只报收支）→ 用「旧额度 + 本次收支净额」推算
                        amount: hasAmount ? n.amount : roundMoney((Number(prev.amount) || 0) + moneyNet(n.history)),
                    });
                    if (!n.unit && prev.unit) merged.unit = prev.unit;
                    if (!n.note && prev.note) merged.note = prev.note;
                    if (!(n.tags || []).length) merged.tags = prev.tags || [];
                    state.currencies[i] = merged;
                } else state.currencies.push(n);
            }
            for (const id of delta.currencies?.remove || []) {
                try { tombSet('currencies', id); } catch (e) { }
                state.currencies = (state.currencies || []).filter(x => x.id !== id && x.name !== id && String(x.owner || '') !== String(id));
            }
        }
        // v1.192：传言大类 —— 同一「主体」只维护一条（说法变化 = 更新）；AI 写「分裂自」或说法明显不同
        //   → 建立父子关联并**新增一个传言分支**（主体保持不变）；全部落库逻辑见 rumorApplyAiDelta()
        if (cfg.rumorEnabled !== false) {
            for (const r of delta.rumors?.add || []) { try { rumorApplyAiDelta(r, { floor: fb, update: false }); } catch (e) { } }
            for (const r of delta.rumors?.update || []) { try { rumorApplyAiDelta(r, { floor: fb, update: true }); } catch (e) { } }
            for (const id of delta.rumors?.remove || []) {
                const gone = (state.rumors || []).filter(x => x && (x.id === id || String(x.subject || '') === String(id)));
                try { tombSet('rumors', id); } catch (e) { }
                try { tombEntries('rumors', gone); } catch (e) { }   // v1.192：id + 内容哈希 双墓碑
                const goneIds = new Set(gone.map(x => x && x.id).filter(Boolean).map(String));
                state.rumors = (state.rumors || []).filter(x => x.id !== id && String(x.subject || '') !== String(id) && !goneIds.has(String(x.id || '')));
            }
        }
        // v1.104：存量数量为 0 的物品一律清除（含历史遗留）
        if (delta.items && ((delta.items.add && delta.items.add.length) || (delta.items.update && delta.items.update.length))) {
            state.items = (state.items || []).filter(x => Number(x.qty) !== 0);
        }
        for (const p of delta.plans?.add || []) {
            const n = normalizePlan(p);
            if (n) {
                if (n.status === 'closed') {
                    // v1.64：收到已完结计划 → 原文删除，只累计统计
                    state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
                    state.stats.plansClosed = Number(state.stats.plansClosed || 0) + 1;
                    const ci = state.plans.findIndex(x => x.id === n.id || String(x.content || '') === String(n.content || ''));
                    if (ci >= 0) { try { tombSet('plans', n.id); tombSet('plans', state.plans[ci] && state.plans[ci].id); } catch (e) { } state.plans.splice(ci, 1); }
                    continue;
                }
                const i = state.plans.findIndex(x => x.id === n.id);
                if (i >= 0) state.plans[i] = n; else state.plans.push(n);
            }
        }
        // v1.28/v1.38：了结匹配 —— id / 内容精确 / 双向包含（正文完结时 AI 措辞可能与存储略有差异）
        const closePlanIdx = (key) => {
            const k = String(key || '').trim();
            if (!k) return -1;
            let i = state.plans.findIndex(x => x.id === k || String(x.content || '').trim() === k);
            if (i >= 0) return i;
            return state.plans.findIndex(x => {
                const c = String(x.content || '');
                if (c.length <= 2) return false;
                if (c.includes(k) || k.includes(c)) return true;
                const nk = normMatchKey(k), nc = normMatchKey(c);
                return nk.length > 1 && nc.length > 1 && (nc.includes(nk) || nk.includes(nc));
            });
        };
        for (const id of delta.plans?.close || []) {
            const i = closePlanIdx(id);
            if (i >= 0) {
                // v1.64：已完结计划只留统计 —— 原文直接删除
                state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
                state.stats.plansClosed = Number(state.stats.plansClosed || 0) + 1;
                state.plans.splice(i, 1);
            }
        }
        for (const id of delta.plans?.remove || []) { try { dropRelLinks('plans', [id]); } catch (e) { } state.plans = (state.plans || []).filter(x => x.id !== id && x.content !== id); }
        for (const s of delta.suspense?.add || []) {
            const n = normalizeSuspense(s);
            if (n) {
                if (n.status === 'closed') {
                    // v1.64：收到已揭晓悬念 → 原文删除，只累计统计
                    state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
                    state.stats.suspenseResolved = Number(state.stats.suspenseResolved || 0) + 1;
                    const ci = state.suspense.findIndex(x => x.id === n.id || String(x.content || '') === String(n.content || ''));
                    if (ci >= 0) state.suspense.splice(ci, 1);
                    continue;
                }
                const i = state.suspense.findIndex(x => x.id === n.id);
                if (i >= 0) state.suspense[i] = n; else state.suspense.push(n);
            }
        }
        // v1.28/v1.38：悬念了结匹配 —— id / 内容精确 / 双向包含
        const closeSuspIdx = (key) => {
            const k = String(key || '').trim();
            if (!k) return -1;
            let i = state.suspense.findIndex(x => x.id === k || String(x.content || '').trim() === k);
            if (i >= 0) return i;
            return state.suspense.findIndex(x => {
                const c = String(x.content || '');
                if (c.length <= 2) return false;
                if (c.includes(k) || k.includes(c)) return true;
                const nk = normMatchKey(k), nc = normMatchKey(c);
                return nk.length > 1 && nc.length > 1 && (nc.includes(nk) || nk.includes(nc));
            });
        };
        for (const id of delta.suspense?.close || []) {
            const i = closeSuspIdx(id);
            if (i >= 0) {
                // v1.64：已揭晓悬念只留统计 —— 原文直接删除（不再留存 resolveTime）
                state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
                state.stats.suspenseResolved = Number(state.stats.suspenseResolved || 0) + 1;
                state.suspense.splice(i, 1);
            }
        }
        for (const id of delta.suspense?.remove || []) { try { dropRelLinks('suspense', [id]); } catch (e) { } state.suspense = (state.suspense || []).filter(x => x.id !== id && x.content !== id); }
        for (const n of delta.npcs?.add || []) { const nn = normalizeNpc(n); if (nn) { state.npcs = state.npcs || []; const i = state.npcs.findIndex(x => x.id === nn.id); if (i >= 0) state.npcs[i] = nn; else state.npcs.push(nn); } }
        for (const id of delta.npcs?.remove || []) { state.npcs = (state.npcs || []).filter(x => x.id !== id && x.name !== id); }
        for (const s of delta.scenes?.add || []) {
            const n = normalizeScene(s);
            if (!n) continue;
            const existing = findSceneNode(n.pathArr);
            if (existing) {
                // 分层：同路径层级 = 同一节点，合并描述（累积完整描述，取更长更全的）
                existing.name = n.name || existing.name;
                if (n.desc && (!existing.desc || n.desc.length > existing.desc.length)) existing.desc = n.desc;
            } else state.scenes.push(n);
        }
        for (const s of delta.scenes?.update || []) {
            const n = normalizeScene(s);
            if (!n) continue;
            const existing = findSceneNode(n.pathArr);
            if (existing) { existing.name = n.name || existing.name; if (n.desc) existing.desc = n.desc; }
            else state.scenes.push(n);
        }
        // v1.113：场景写入后做一次「重复地址并集」—— 同路径多记录合并为一个（如 不再出现第二个纽约层级）
        // v1.135：并集升级为「精确同路径 + 相似地名（纽约/纽约市）」两级归并（scenesUnionMergeAll）
        if ((delta.scenes && (delta.scenes.add || delta.scenes.update || delta.scenes.reparent || delta.scenes.remove)) && (state.scenes || []).length > 1) {
            try { (typeof scenesUnionMergeAll === 'function' ? scenesUnionMergeAll : scenesUnionMerge)(); } catch (e) { }
        }
        // v1.135：状态记录主体归并（同一角色的全名/名被 AI 当成两个人各记一组时自动合并）
        if (((state.currentStates || []).length > 1) && delta.states) {
            try { statesSubjectUnionMerge(); } catch (e) { }
        }
        for (const r of delta.scenes?.reparent || []) {
            const nm = normText(r?.name, 40) || normText(r?.id, 40);
            if (!nm) continue;
            const node = (state.scenes || []).find(x => x.name === nm);
            if (node) { const pa = scenePathArr(r); if (pa.length) { node.pathArr = pa; node.pathStr = pa.join('>'); } }
        }
        for (const id of delta.scenes?.remove || []) { state.scenes = (state.scenes || []).filter(x => x.id !== id && x.name !== id); }
        for (const c of delta.concepts?.add || []) {
            const n = normalizeConcept(c);
            if (n) { const i = state.concepts.findIndex(x => x.id === n.id); if (i >= 0) state.concepts[i] = n; else state.concepts.push(n); }
        }
        for (const id of delta.concepts?.remove || []) { state.concepts = (state.concepts || []).filter(x => x.id !== id && x.name !== id); }
        // v1.58 平行事件（交织管线产物）：新增/更新/删除
        for (const p of delta.parallels?.add || []) {
            const n = normalizeParallel(p);
            if (n) {
                n.updatedAt = Date.now();
                const i = state.parallels.findIndex(x => x.id === n.id);
                if (i >= 0) { n.uses = state.parallels[i].uses || 0; state.parallels[i] = n; } else state.parallels.push(n);
            }
        }
        for (const p of delta.parallels?.update || []) {
            const n = normalizeParallel(p);
            if (!n) continue;
            const i = state.parallels.findIndex(x => x.id === n.id || (p && p.title && x.title === String(p.title)));
            if (i < 0) { if (n.id) state.parallels.push(n); continue; }
            const prev = state.parallels[i];
            n.id = prev.id; n.uses = prev.uses || 0; n.updatedAt = Date.now();
            if (Array.isArray(prev.goalOdds) && (!Array.isArray(n.goalOdds) || !n.goalOdds.length)) n.goalOdds = prev.goalOdds;
            state.parallels[i] = n;
        }
        for (const id of delta.parallels?.remove || []) { try { dropRelLinks('parallels', [id]); } catch (e) { } state.parallels = (state.parallels || []).filter(x => x.id !== id && x.title !== id); }
        if (delta.state) {
            if (delta.state.date) state.state.date = clockDateTrim(delta.state.date);
            if (delta.state.time) state.state.time = String(delta.state.time).slice(0, 60);
            const locVal = delta.state.location || delta.state.locations || delta.state['所在位置'];
            if (typeof locVal === 'string' && locVal.trim()) state.state.location = locVal.trim().slice(0, 60);
        }
        if (delta.vars && typeof delta.vars === 'object') Object.assign(state.vars, delta.vars);
        // v1.165：把本轮「带关联的条目」（记忆 / 计划 / 悬念 / 平行事件）写入通用知情关联层
        //   （放在各维度均已落库之后：按 id / 标题 / 正文匹配目标条目，避免「先写关联后落库」空转）
        try { if (typeof applyDeltaRelLinks === 'function') applyDeltaRelLinks(delta); } catch (e) { }
        // v1.147：库存切片用「存储上限」（≥保底），不再用旧的 300/150/60 硬编码
        // v1.203：情节裁剪保留「已总结隐藏」条目（不参与淘汰 → 持久存储）
        state.atoms = capAtomsKeepingHidden(state.atoms, storeCapFor('atoms'));
        state.memories = (state.memories || []).slice(-storeCapFor('memories'));
        state.snapshots = (state.snapshots || []).slice(-storeCapFor('snapshots'));
        // v1.59：平行事件上限走设定（maxParallels 默认 30，超出自动挤出最旧）
        state.parallels = (state.parallels || []).slice(-Math.max(1, Number(cfg && cfg.maxParallels) || 30));
        try { scheduleParallelDecay(); } catch (e) { }
        // v1.101：状态固定模板的条数钳制 —— 每角色最多状态条数（超出裁掉最旧；最少为提示词要求）
        try { applyStateBounds(); } catch (e) { }
        // v1.143：各分类条数上限 JS 兜底（概念/场景/物品/计划/悬念/名册此前只有提示词约束）
        try { enforceDimCaps(); } catch (e) { }
        saveState();
        // v1.23：返回统计（新增条数 / 总条数），兼容布尔判断（truthy）
        const afterTotal = totalMemoryCount();
        const added = Math.max(0, afterTotal - beforeTotal);
        // v1.49：合并日志记录实际内容 —— 维度新增/删除/了结数、数据体量与条目截取
        try {
            const dimAct = {};
            for (const k of ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'npcs', 'scenes', 'concepts', 'parallels']) {
                const d = delta[k];
                if (d && typeof d === 'object') {
                    const acts = [];
                    if (d.add) acts.push(`+${(Array.isArray(d.add) ? d.add : []).length}`);
                    if (d.update) acts.push(`~${(Array.isArray(d.update) ? d.update : []).length}`);
                    if (d.remove) acts.push(`-${(Array.isArray(d.remove) ? d.remove : []).length}`);
                    if (d.close) acts.push(`了结${(Array.isArray(d.close) ? d.close : []).length}`);
                    if (acts.length) dimAct[k] = acts.join(' ');
                }
            }
            const st = state || {};
            dbgLog('摘要', {
                action: '增量合并', added, total: afterTotal, chars: JSON.stringify(state).length,
                dims: { atoms: (st.atoms || []).length, memories: (st.memories || []).length, states: (st.currentStates || []).length, snapshots: (st.snapshots || []).length, items: (st.items || []).length, plans: (st.plans || []).length, suspense: (st.suspense || []).length, scenes: (st.scenes || []).length, concepts: (st.concepts || []).length },
                changed: dimAct,
                excerpt: dbgExcerpt(JSON.stringify({ date: st.state && st.state.date, location: st.state && st.state.location }), 160),
            });
        } catch (e) { }
        return { ok: true, added, total: afterTotal };
    } catch (e) { warn('增量合并失败', e); return false; }
}
// ==================== v1.58/v1.59 交织管线（平行事件 · 独立触发管道） ====================
// v1.59：独立排队/去重 + 前后通知 + 上限(maxParallels) + 关键词关联更新。
//   - 独立排队：weave 走 enqueueWeave 独立队列 + weaveBusy/weaveTimer（v1.75（B1）起与摘要/修复/情节总结/推进统一互斥，
//     见 longTaskBusy：互斥位被占时被动推演排队等待（最长 WEAVE_WAIT_MS=2 分钟），防 state 读改写交错）；
//   - 输入去重：同楼层正文 + 原子内容签名（lastWeaveSig）未变则跳过，避免同一正文/原子被重复分析；
//   - 通知：触发前（楼层/关键词）与结束后（分析字数、提取/更新事件数）均有 toast 与调试日志；
//   - 上限：state.parallels 按 cfg.maxParallels（默认 30）挤出最旧；
//   - 关键词更新：提取记忆关键词命中既有平行事件（标签/因果线/标题/卦象/角色）→ 引导 AI 走「更新」承前深化。

function dbgExcerpt(text, max) {
    const t = String(text || '');
    return t.length > max ? t.slice(0, max) + '…' : t;
}

function calcTimeDecay(earliestAt, latestAt, nowAt, itemAt, count) {
    try {
        const now = Number(nowAt) || Date.now();
        const item = Number(itemAt);
        // B8-5 修正（**有意偏差**，V1 为 `item <= 0`）：剧情日期以 2000 为基准换算，**1970 年之前的剧情日期
        //   得到负毫秒值**，而 V1 的 `item <= 0` 会把它们当成「无时间信息」→ 状态衰退 / 记忆遗忘 / 平行事件衰退
        //   对 19~20 世纪的剧情**整体失效**（用户常见设定恰好是 1919 一类年份）。V1 注释写的是「无时间信息视为新」，
        //   故此处按注释语义只判「非有限数值」；负值（公元前 ~ 1969）是合法时间，正常参与衰减。
        if (!Number.isFinite(item)) return 0;                              // 无时间信息视为新
        const age = Math.max(0, now - item);
        // 1) 多级时间尺度（小时→天→月→年，各占一段权重，1 年以上完全饱和）
        const sHours = Math.min(1, age / DECAY_MS_HOUR);
        const sDays = Math.min(1, age / DECAY_MS_DAY);
        const sMonths = Math.min(1, age / DECAY_MS_MONTH);
        const sYears = Math.min(1, age / DECAY_MS_YEAR);
        const scale = 0.20 * sHours + 0.25 * sDays + 0.30 * sMonths + 0.25 * sYears;   // ≤1
        // 2) 类别跨度相对位置：条目越接近「最早更新」越老（=1），接近「最新更新」越新（≈0）
        let relFrac = 0;
        const e = Number(earliestAt), l = Number(latestAt);
        const spanBase = Math.max(1, (Number.isFinite(e) && Number.isFinite(l) ? l : now) - (Number.isFinite(e) ? e : now));
        if (Number.isFinite(e) && now > e) {
            relFrac = Math.min(1, Math.max(0, (now - item) / (now - e)));
            // 条目晚于最新更新（正在被维护）则相对位置按 0 计（最活跃）
            if (Number.isFinite(l) && item >= l) relFrac = 0;
            relFrac = Math.min(1, Math.max(0, relFrac));
        }
        // 3) 条目拥挤度：同类条目越多，整体越易衰退（+2%/条，封顶 ×1.5）
        const n = Math.max(1, Number(count) || 1);
        const crowd = Math.min(1.5, 1 + 0.02 * (n - 1));
        const base = Math.min(1, 0.55 * scale + 0.45 * relFrac);
        return Math.min(1, Math.max(0, base * crowd));
    } catch (e) { return 0; }
}
// 单条衰退值（平行事件专用包装，注入当前类目统计与当前时间）

function scheduleParallelDecay() {
    try {
        if (!cfg || cfg.parallelDecayEnabled === false) return;
        if (decayTimer) return;
        decayTimer = timerHooks.set(async () => {
            decayTimer = null;
            try { await runParallelDecay({}); } catch (e) { warn('平行事件衰退失败', e); }
        }, 3000);   // v1.60/1.61：更新延迟堆叠（3s 统一调度一次）
    } catch (e) { }
}
async function runParallelDecay(opts) {
    try {
        if (!cfg || cfg.parallelDecayEnabled === false) return { removed: 0, triggered: false, reason: 'disabled' };
        const o = opts || {};
        const list = state.parallels || [];
        const n = list.length;
        const cap = Math.max(1, Number(cfg.maxParallels) || 30);
        const ratio = Math.min(1, Math.max(0, Number(cfg.parallelDecayRatio) != null ? Number(cfg.parallelDecayRatio) : 0.5));
        const overRatio = n > Math.floor(cap * ratio);          // 超出上限 ×比例（默认 50%）
        const expired = list.filter(parallelExpired);           // 衰退值 ≥ 阈值 → 自动移除候选
        if (!o.force && !overRatio && !expired.length) return { removed: 0, triggered: false, overRatio, n, cap };
        if (expired.length) {
            const removeIds = new Set(expired.map(x => x.id || x.title || JSON.stringify(x).slice(0, 60)));
            state.parallels = list.filter(x => !removeIds.has(x.id || x.title || JSON.stringify(x).slice(0, 60)));
            saveState();
        }
        try {
            dbgLog('发送记忆', { action: '平行事件衰退', n, cap, overRatio, cutoff: Number(cfg.parallelDecayCutoff), removed: expired.length, titles: expired.slice(0, 6).map(x => x.title || x.id || '') });
        } catch (e) { }
        if (expired.length) {
            const remain = (state.parallels || []).length;
            try { toast(`💀 平行事件衰退：${expired.length} 条已达衰退阈值自动移除（剩 ${remain}/${cap}）`, 'info'); } catch (e) { }
        }
        return { removed: expired.length, triggered: overRatio || expired.length > 0, overRatio, n, cap, remain: (state.parallels || []).length };
    } catch (e) { return { removed: 0, triggered: false, error: String(e && e.message || e) }; }
}

// ==================== v1.192：传言引擎（抽取落库 · 纯机械演化 · 平行联动 · 裂变 · 衰退） ====================
// 设计口径（用户要求原文见 module03 的 v1.192 配置段注释）：
//   ① 抽取：与其它分析记忆维度**同批**（模板 `rumors`）→ `rumorApplyAiDelta()` 落库；
//   ② 演化：**零 AI**。每满 `rumorChangeEveryRounds`（默认 5）个**楼层轮次**演化一次，逐条做：
//      载体按剧情时间老化 → 发酵度增减（活跃载体 / 传播者 / 联动 / 时间压力）→ 阶段重算 →
//      与「标签高度关联」的平行事件按概率联动（**发酵 / 消退 / 推动平行世界发生新的变化**）→ 视概率酝酿裂变；
//      平行世界发生变化时轮次**重新计数**（`rumorMarkParallelChange()`）；
//   ③ 变化过程：所有变化先写入 `pending`（需 `rumorChangeNeedRounds` 轮才提交），每轮记录一条传导链路 ——
//      「传言的变化不可能立刻发生，会有变化过程」；
//   ④ 裂变：提交时以「父 id + 变体名」派生**稳定子 id** 新建传言（主体不变、记录父子关联与谱系世代）；
//   ⑤ 衰退：复用 `calcTimeDecay` 通用多级时间衰退（与平行事件同款参数），命中阈值自动移除并留墓碑。
// 概率全部由 `rumorRoll(seed)`（种子哈希）决定 —— **确定性**：两端各自演化会得到同样结果，避免跨端抖动。

function rumorEnabledOn() { return !!(cfg && cfg.rumorEnabled !== false); }

function rumorTickState() {
    try {
        const t = (state.rumorTick && typeof state.rumorTick === 'object') ? state.rumorTick : {};
        state.rumorTick = {
            round: Math.max(0, Math.round(Number(t.round) || 0)),
            lastFloor: Number.isFinite(Number(t.lastFloor)) ? Number(t.lastFloor) : -1,
            parallelFloor: Number.isFinite(Number(t.parallelFloor)) ? Number(t.parallelFloor) : -1,
            runs: Math.max(0, Math.round(Number(t.runs) || 0)),
            lastAt: Number(t.lastAt) || 0,
        };
        return state.rumorTick;
    } catch (e) { return { round: 0, lastFloor: -1, parallelFloor: -1, runs: 0, lastAt: 0 }; }
}
// 确定性掷骰：同一 seed 恒返回同一 0~1（跨端一致；测试可复现）

function rumorStoryDate() {
    try { const n = getStoryNow(); return (n && /^-?\d{1,4}-\d{2}-\d{2}/.test(String(n))) ? clockDateTrim(n) : ''; } catch (e) { return ''; }
}
// 剧情天数差（用 v1.188 的剧情日期数学；日期不可解析时返回 0 = 不老化）

function rumorChainPush(r, step) {
    try {
        if (!r) return null;
        const t = rumorTickState();
        const s = normalizeRumorChainStep(Object.assign({ at: rumorStoryDate(), round: Number(t.runs) || 0 }, step || {}));
        if (!s) return null;
        r.chain = normalizeRumorChain((r.chain || []).concat([s]));
        return s;
    } catch (e) { return null; }
}

function mergeRumorListBy(a, b, keyOf) {
    const seen = new Set(), out = [];
    for (const x of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
        if (!x) continue;
        let k = '';
        try { k = String(keyOf(x)); } catch (e) { k = JSON.stringify(x); }
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(x);
    }
    return out;
}
// 载体老化：超过「基础寿命 × 耐久度」的剧情天数 → 停止扩散（记链路）

function rumorAiHas(raw, keys) {
    try {
        if (!raw || typeof raw !== 'object') return false;
        for (const k of keys) {
            const v = raw[k];
            if (v === undefined || v === null) continue;
            if (typeof v === 'string' && !v.trim()) continue;
            if (Array.isArray(v) && !v.length) continue;
            return true;
        }
    } catch (e) { }
    return false;
}
// 「AI 增量 + 既有条目」合并：AI 明确的字段覆盖；未提供的字段保留旧值；集合类字段一律并集；
//   机械演化字段（stage/ferment/pending/chain/lineage/uses/时间戳）永不由 AI 覆盖。

function rumorMergeAiInto(prev, n0, raw) {
    const p = prev || {};
    const n = n0 || {};
    const num = (v) => Number(v) || 0;
    const out = Object.assign({}, p, n);
    out.id = p.id || n.id;
    out.uses = num(p.uses);
    out.createdAt = p.createdAt || n.createdAt;
    out.updatedAt = Date.now();
    out.lineage = normalizeRumorLineage(p.lineage, out.id);
    out.pending = p.pending || null;
    out.chain = Array.isArray(p.chain) ? p.chain : (Array.isArray(n.chain) ? n.chain : []);
    if (!rumorAiHas(raw, ['subject', '主体', 'name', 'title'])) out.subject = p.subject || n.subject;
    if (!rumorAiHas(raw, ['content', 'text', '正文', '说法'])) out.content = p.content || n.content;
    if (!rumorAiHas(raw, ['objectivity', '客观性'])) out.objectivity = p.objectivity || n.objectivity;
    if (!rumorAiHas(raw, ['source', '来源'])) out.source = p.source || '';
    if (!rumorAiHas(raw, ['date', '日期'])) out.date = p.date || n.date;
    if (!rumorAiHas(raw, ['ferment', '发酵度'])) out.ferment = num(p.ferment) || num(n.ferment);
    if (!rumorAiHas(raw, ['stage', '阶段'])) out.stage = p.stage || rumorStageByFerment(out.ferment);
    else out.stage = rumorStageByFerment(out.ferment);
    out.floorStart = num(p.floorStart) || num(n.floorStart);
    out.floorEnd = Math.max(num(p.floorEnd), num(n.floorEnd));
    out.tags = mergeRumorListBy(p.tags, n.tags, x => String(x)).slice(0, 8);
    out.carriers = mergeRumorListBy(p.carriers, n.carriers, x => String((x && x.who) || '') + '|' + String((x && x.role) || '')).slice(0, 12);
    out.media = mergeRumorListBy(p.media, n.media, x => String((x && x.type) || '') + '|' + String((x && x.name) || '') + '|' + String((x && x.at) || '')).slice(0, 12);
    out.parallelRefs = Array.from(new Set([].concat(p.parallelRefs || [], n.parallelRefs || []).map(x => String(x || '')).filter(Boolean))).slice(0, 12);
    out.title = out.subject;
    out.text = out.content;
    return out;
}
// AI 增量落库：① 显式「分裂自」→ 父条目的新分支；② 同主体 + 说法相近 → 同一主体的演化（更新）；
//   ③ 同主体 + 说法差异大 → 视为**分裂**（新建分支，主体不变）；④ 无同主体 → 全新传言（记「起源」链路）

function rumorApplyAiDelta(raw, opts) {
    try {
        if (!rumorEnabledOn()) return null;
        const o = opts || {};
        const n0 = normalizeRumor(raw);
        if (!n0) return null;
        const fb = o.floor || {};
        const fe0 = Number(fb.end), fs0 = Number(fb.start);
        if (Number.isInteger(fe0) && fe0 >= 0) n0.floorEnd = Math.max(Number(n0.floorEnd) || 0, fe0);
        if (Number.isInteger(fs0) && fs0 >= 0) n0.floorStart = Math.max(Number(n0.floorStart) || 0, fs0);
        const today = rumorStoryDate();
        if (!n0.date && today) n0.date = today;
        const split = String((raw && (raw.splitFrom || raw['分裂自'] || raw['演化自'] || raw['分裂来源'])) || '').trim();
        const subjKey = (x) => rumorSubjectKey((x && x.subject) || '');
        let parent = null, prev = null;
        if (split) {
            parent = (state.rumors || []).find(x => x && (String(x.subject || '') === split || subjKey(x) === rumorSubjectKey(split))) || null;
            if (!parent) prev = null;
        }
        if (!parent) {
            const cands = (state.rumors || []).filter(x => x && subjKey(x) === subjKey(n0) && subjKey(n0));
            if (cands.length) {
                prev = cands.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
                let sim = 0;
                try { sim = repairSimilarity(prev.content, n0.content); } catch (e) { sim = 0; }
                const probe = String(n0.content || '').slice(0, 12), hay = String(prev.content || '');
                const near = sim >= 0.34 || (probe.length >= 6 && hay.indexOf(probe) >= 0) || (String(hay).slice(0, 12).length >= 6 && String(n0.content || '').indexOf(String(hay).slice(0, 12)) >= 0);
                if (!near) { parent = prev; prev = null; }   // 说法差异大 → 分裂
            }
        }
        // 全新传言
        if (!parent && !prev) {
            n0.lineage = normalizeRumorLineage({ rootId: n0.id, parentId: '', children: [], generation: 0 }, n0.id);
            n0.chain = normalizeRumorChain([{ at: n0.date || today, kind: '起源', from: n0.source || '', to: n0.subject, note: `首次记录（${n0.objectivity}）：${String(n0.content).slice(0, 60)}` }].concat(n0.chain || []));
            n0.createdAt = Date.now();
            n0.updatedAt = Date.now();
            state.rumors.push(n0);
            return { added: true, item: n0, mode: 'new' };
        }
        // 分裂为新分支
        if (parent) {
            const sameSubject = rumorSubjectKey(parent.subject) === subjKey(n0);
            // 分支键：同一主体下的不同说法各自成支（按说法前 8 字派生）—— 同一说法重复出现则命中同一条（幂等）
            const variant = sameSubject ? ('AI分支·' + String(n0.content || '').replace(/\s+/g, '').slice(0, 8)) : String(n0.subject || '').slice(0, 40);
            const cid = rumorChildId(parent, variant);
            const rootId = (parent.lineage && parent.lineage.rootId) || parent.id;
            const exist = (state.rumors || []).find(x => x && x.id === cid);
            if (exist) {
                const merged = rumorMergeAiInto(exist, n0, raw);
                merged.id = cid;
                merged.lineage = exist.lineage;
                merged.createdAt = exist.createdAt;
                state.rumors[state.rumors.indexOf(exist)] = merged;
                return { updated: true, item: merged, mode: 'branch-update' };
            }
            n0.id = cid;
            n0.subject = parent.subject || n0.subject;    // 主体保持同一个（用户要求）
            n0.lineage = normalizeRumorLineage({ rootId, parentId: parent.id, children: [], generation: (Number(parent.lineage && parent.lineage.generation) || 0) + 1 }, cid);
            n0.chain = normalizeRumorChain([{ at: n0.date || today, kind: '起源', from: parent.subject, to: n0.subject, note: `分裂自「${parent.subject}」（${variant}）` }].concat(n0.chain || []));
            if (!Array.isArray(parent.lineage.children)) parent.lineage.children = [];
            if (parent.lineage.children.indexOf(cid) < 0) parent.lineage.children.push(cid);
            rumorChainPush(parent, { kind: '裂变', to: String(n0.subject), note: `分裂出分支「${variant}」` });
            parent.updatedAt = Date.now();
            n0.createdAt = Date.now();
            n0.updatedAt = Date.now();
            state.rumors.push(n0);
            return { added: true, item: n0, mode: 'branch-new' };
        }
        // 同一主体的演化（更新）：AI 明确给出的字段覆盖，其余保留；集合字段并集；机械字段不动
        const base = rumorMergeAiInto(prev, n0, raw);
        const changed = String(prev.content || '') !== String(base.content || '');
        base.chain = normalizeRumorChain((prev.chain || []).concat([{
            at: base.date || prev.date || today,
            kind: changed ? '异变' : '传播',
            from: '', to: '',
            note: changed ? `说法演变为：${String(base.content).slice(0, 60)}` : '同主体说法再次出现（传播）',
        }]));
        if (changed) base.ferment = Math.min(100, Math.max(Number(prev.ferment) || 0, Number(base.ferment) || 0) + 10);
        base.stage = rumorStageByFerment(base.ferment);
        state.rumors[state.rumors.indexOf(prev)] = base;
        return { updated: true, item: base, mode: changed ? 'evolve' : 'spread' };
    } catch (e) { return null; }
}
// 清空传言（留删除墓碑；仅手动）

function parseStoryDateMs(s) {
    try {
        // v1.188：改用 storyDateMsFromStr（setUTCFullYear 口径）—— 旧写法把 0051 年算成 1951 年，
        //   会让状态衰退基准/时间差整体偏移。
        const ms = storyDateMsFromStr(s);
        return Number.isFinite(ms) ? ms : 0;
    } catch (e) { return 0; }
}
// v1.109：类目级时间基准一次计算（runStateDecay 多条共用）—— 旧实现 stateDecayScore 对**每条**状态
//   都重建「全表日期统计」（list.map+parseStoryDateMs，O(n²)）；状态条目多时，消息后 3s 自动衰退
//   会在主线程整段卡顿（浏览器标签页崩溃排查项之一，PC 端条目最大最易触发）。基准只算一次 → O(n)。

function scenesUnionMerge() {
    try {
        const list = state.scenes || [];
        if (!list.length) return 0;
        const byPath = new Map();
        for (const sc of list) {
            if (!sc || typeof sc !== 'object') continue;
            const k = Array.isArray(sc.pathArr) ? sc.pathArr.join('>') : String(sc.pathStr || '');
            if (!k) continue;
            const ex = byPath.get(k);
            if (!ex) { byPath.set(k, sc); continue; }
            // 同路径重复 → 并集：描述取更长/更全者，统计取大
            if (sc.desc && (!ex.desc || sc.desc.length > ex.desc.length)) ex.desc = sc.desc;
            ex.uses = Math.max(Number(ex.uses) || 0, Number(sc.uses) || 0);
            ex.floorSeen = Math.max(Number(ex.floorSeen) || 0, Number(sc.floorSeen) || 0);
            if (!ex.name && sc.name) ex.name = sc.name;
        }
        const merged = Array.from(byPath.values());
        const removed = list.length - merged.length;
        if (removed > 0) state.scenes = merged;
        return removed;
    } catch (e) { return 0; }
}
// ==================== 场景「相似地名」归并（用户反馈③） ====================
// 现象：同一地点被反复写入（「纽约」与「纽约市」、「曼哈顿」与「曼哈顿区」各成一条，
//   甚至树里出现两套相似分支）。先在提示词层要求「先查已有清单、同地异名合并」，
//   这里再做一层**保守**的 JS 兜底：同一上级下、名称互为前缀且仅差一个行政后缀（市/区/县/镇/村/郡/府/道/街/路）
//   视为同一地点 → 并入**列表中更早出现**的那条，并把其下子级路径一并改名（消除两套相似路径）。
//   仅差一个非行政字（如「东区」/「东城区」之外的「香港」/「香港岛」）不合并，避免误合。

function stateDecayBaseline(list) {
    const now = parseStoryDateMs(state.state && state.state.date);
    const ts = [];
    for (const x of (list || [])) { const t = parseStoryDateMs(x && x.updatedAt); if (t) ts.push(t); }   // v1.193：负年份（公元前）同样计入基准
    const earliest = ts.length ? Math.min.apply(null, ts) : 0;
    const latest = ts.length ? Math.max.apply(null, ts) : 0;
    return { now, earliest, latest, n: (list || []).length };
}
// 单条衰退值（状态专用包装）：nowAt=当前剧情日期；earliest/latest=同类目状态各自 updatedAt 剧情日期
// v1.109：bl 为可选预计算基准（stateDecayBaseline），省略时按旧逻辑单次全表统计（外部调用兼容）

function stateDecayScore(s, bl) {
    const b = bl || stateDecayBaseline(state.currentStates || []);
    const now = b.now;
    if (!now) return 0;                                // 无剧情时钟 → 永不衰退
    const updTs = parseStoryDateMs(s && s.updatedAt);
    const base = calcTimeDecay(b.earliest, b.latest, now, updTs, b.n);
    // v1.92：同时考虑「单条自身更新日期」的绝对久远度 —— 距当前剧情日期过久即趋近移除；
    // v1.145：年限阈值改为可配 stateDecayStaleYears（默认 6 年，原硬编码 3 年）—— 调低清扫速度
    let score = base;
    if (updTs) {
        const staleYears = (now - updTs) / 31557600000;   // 天文年毫秒
        const staleLimit = Math.max(1, Number(cfg && cfg.stateDecayStaleYears) || 6);
        score = Math.max(score, Math.min(1, staleYears / staleLimit));
    }
    if (!(s && s.status === 'inactive')) return score;
    return Math.min(1, score + 0.1);                     // 失效状态优先移除（v1.62）
}

function sceneSegNorm(s) { try { return String(s == null ? '' : s).replace(/[\s·・.．]/g, '').toLowerCase(); } catch (e) { return ''; } }

function stateExpired(s, bl) {
    if (!cfg || cfg.stateDecayEnabled === false) return false;
    const cutoff = Number(cfg.stateDecayCutoff) != null ? Number(cfg.stateDecayCutoff) : 0.9;
    return stateDecayScore(s, bl) >= Math.min(1, Math.max(0, cutoff));
}
// v1.106：角色级停更年限（剧情年；0/空/非正数 = 不启用角色级整组清扫）

function sceneSegSamePlace(a, b) {
    try {
        const x = sceneSegNorm(a), y = sceneSegNorm(b);
        if (!x || !y) return false;
        if (x === y) return true;
        const short = x.length <= y.length ? x : y;
        const long = x.length <= y.length ? y : x;
        if (short.length < 2 || long.indexOf(short) !== 0) return false;      // 必须前缀关系
        const tail = long.slice(short.length);
        return tail.length >= 1 && tail.length <= 2 && SCENE_ADMIN_SUFFIX.test(tail);
    } catch (e) { return false; }
}

function stateDecaySubjectYearsNum() {
    try {
        const v = Number(cfg && cfg.stateDecaySubjectYears);
        return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
}
// v1.106：角色级停更清扫 —— 某角色的全部状态中「最近更新」（subject 组内最新 updatedAt）距当前剧情日期
//   超过 停更年限 → 该角色整组状态删除（角色久未登场 → 其“当前状态”一并失效，避免长期残留）

function scenePathArrOf(sc) {
    try {
        if (Array.isArray(sc && sc.pathArr) && sc.pathArr.length) return sc.pathArr.map(x => String(x));
        const s = String((sc && sc.pathStr) || '');
        return s ? s.split('>').map(x => x.trim()).filter(Boolean) : [];
    } catch (e) { return []; }
}

function stateDecaySubjectSweep(list) {
    const out = [];
    try {
        const years = stateDecaySubjectYearsNum();
        if (!(years > 0) || !state || !state.state || !state.state.date) return out;
        const now = parseStoryDateMs(state.state.date);
        if (!now) return out;
        const cutoffMs = now - years * 31557600000;          // 天文年毫秒
        const latestOf = {};
        const hasDate = {};
        for (const s of (list || [])) {
            const subj = String((s && s.subject) || '').trim();
            if (!subj) continue;
            const t = parseStoryDateMs(s && s.updatedAt);
            if (t) {
                hasDate[subj] = true;
                if (!latestOf[subj] || t > latestOf[subj]) latestOf[subj] = t;
            }
        }
        for (const subj of Object.keys(latestOf)) {
            if (!hasDate[subj]) continue;
            if (latestOf[subj] > cutoffMs) continue;          // 组内最近仍有更新 → 保留
            out.push(subj);
        }
        return out;
    } catch (e) { return out; }
}

function scenePathLike(pa, pb) {
    try {
        if (!Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;
        for (let i = 0; i < pa.length; i++) if (!sceneSegSamePlace(pa[i], pb[i])) return false;
        return true;
    } catch (e) { return false; }
}
// 返回被归并掉的节点数（0 = 无变化；调用方负责 saveState）

function scenesSimilarNameMerge() {
    try {
        const list = (state.scenes || []).slice();
        if (list.length < 2) return 0;
        const drop = new Set();
        const renames = [];                       // { fromN, to, parentArr }
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (!a || drop.has(a.id)) continue;
            const pa = scenePathArrOf(a);
            if (!pa.length) continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (!b || drop.has(b.id)) continue;
                const pb = scenePathArrOf(b);
                if (!pb.length || pb.length !== pa.length) continue;                     // 同层级
                // 上级用「相似比较」而非严格相等 —— 上级本身也被归并（纽约 / 纽约市）时，
                //   其子级（曼哈顿 / 曼哈顿区）仍应被判为同一上级下，从而一并归并
                if (!scenePathLike(pa.slice(0, -1), pb.slice(0, -1))) continue;            // 同上级
                if (!sceneSegSamePlace(pa[pa.length - 1], pb[pb.length - 1])) continue;
                renames.push({ fromN: sceneSegNorm(pb[pb.length - 1]), to: String(pa[pa.length - 1]), parentArr: pb.slice(0, -1).map(x => String(x)) });
                if (b.desc && (!a.desc || String(b.desc).length > String(a.desc).length)) a.desc = b.desc;
                a.uses = Math.max(Number(a.uses) || 0, Number(b.uses) || 0);
                a.floorSeen = Math.max(Number(a.floorSeen) || 0, Number(b.floorSeen) || 0);
                if (!a.name && b.name) a.name = b.name;
                drop.add(b.id);
            }
        }
        if (!drop.size) return 0;
        // 子级路径改名（模糊比较上级，兼容上级本身也被改名的情况；迭代两轮以传播到更深层）
        const renameIn = (pa) => {
            const out = pa.slice();
            for (let idx = 1; idx < out.length; idx++) {
                const parentArr = out.slice(0, idx);
                for (const r of renames) {
                    if (sceneSegNorm(out[idx]) === r.fromN && scenePathLike(parentArr, r.parentArr)) { out[idx] = r.to; break; }
                }
            }
            return out;
        };
        let renamed = 0;
        for (let pass = 0; pass < 2; pass++) {
            for (const sc of list) {
                if (!sc || drop.has(sc.id)) continue;
                const pa = scenePathArrOf(sc);
                if (!pa.length) continue;
                const na = renameIn(pa);
                if (na.join('>') !== pa.join('>')) {
                    sc.pathArr = na;
                    sc.pathStr = na.join('>');
                    sc.name = na[na.length - 1];
                    renamed++;
                }
            }
            if (!renamed) break;
        }
        const finalList = list.filter(sc => sc && !drop.has(sc.id));
        const total = list.length - finalList.length;
        if (total > 0) {
            state.scenes = finalList;
            try { log(`场景相似地名归并：合并 ${total} 个节点${renamed ? ` · 子级路径改名 ${renamed} 处` : ''}`); } catch (e) { }
        }
        return total;
    } catch (e) { return 0; }
}
// 场景并集 = 同路径精确并集 + 相似地名（同上级 + 行政后缀差异）归并

function scheduleStateDecay() {
    try {
        if (!cfg || cfg.stateDecayEnabled === false) return;
        if (!state || !state.state || !state.state.date) return;   // 无剧情时钟不调度
        if (stateDecayTimer) return;
        stateDecayTimer = timerHooks.set(async () => {
            stateDecayTimer = null;
            try { await runStateDecay({}); } catch (e) { warn('状态记录衰退失败', e); }
        }, 3000);
    } catch (e) { }
}
async function runStateDecay(opts) {
    try {
        if (!cfg || cfg.stateDecayEnabled === false) return { removed: 0, triggered: false, reason: 'disabled' };
        if (!state || !state.state || !state.state.date) return { removed: 0, triggered: false, reason: 'no-story-clock' };
        const o = opts || {};
        const list = state.currentStates || [];
        const n = list.length;
        const cap = Math.max(1, Number(cfg.maxStates) || 30);
        const ratio = Math.min(1, Math.max(0, Number(cfg.stateDecayRatio) != null ? Number(cfg.stateDecayRatio) : 0.5));
        const overRatio = n > Math.floor(cap * ratio);          // 超出上限 ×比例（默认 50%）
        // v1.109：时间基准一次计算，多条共用（消除每条重建全表统计的 O(n²) 卡顿路径）
        const decayBl = stateDecayBaseline(list);
        const expired = list.filter(x => stateExpired(x, decayBl)); // 单条衰退值 ≥ 阈值 → 自动移除候选
        // v1.106：角色级停更清扫 —— 角色久未更新（组内最近更新超停更年限）→ 整组删除
        const removedSubjects = stateDecaySubjectSweep(list);
        if (!o.force && !overRatio && !expired.length && !removedSubjects.length) return { removed: 0, triggered: false, overRatio, n, cap };
        // 统一删除：单条衰退 + 角色整组停更（同一批过滤，一次落盘）
        const removeIds = new Set(expired.map(x => x.id || x.title || JSON.stringify(x).slice(0, 60)));
        const subjSet = new Set(removedSubjects);
        const kept = list.filter(x => !removeIds.has(x.id || x.title || JSON.stringify(x).slice(0, 60)) && !subjSet.has(String((x && x.subject) || '').trim()));
        const removed = n - kept.length;
        if (removed > 0) {
            // v1.117：衰退移除记墓碑（跨端不再复活已淘汰状态）
            try { tombMany('currentStates', list.filter(x => kept.indexOf(x) < 0).map(x => x && (x.id || x.title || ''))); } catch (e) { }
            state.currentStates = kept;
            saveState();
        }
        try {
            dbgLog('发送记忆', { action: '状态记录衰退', n, cap, overRatio, cutoff: Number(cfg.stateDecayCutoff), removed, subjects: removedSubjects.slice(0, 8), entryExpired: expired.length });
        } catch (e) { }
        if (removed > 0) {
            const remain = (state.currentStates || []).length;
            const subjNote = removedSubjects.length ? ` · 角色停更整组移除：${removedSubjects.slice(0, 4).join('、')}${removedSubjects.length > 4 ? ' 等' : ''}` : '';
            try { toast(`💀 状态记录衰退：${removed} 条自动移除（剩 ${remain}）${subjNote}`, 'info'); } catch (e) { }
        }
        return { removed, triggered: overRatio || removed > 0, overRatio, n, cap, remain: (state.currentStates || []).length, removedSubjects };
    } catch (e) { return { removed: 0, triggered: false, error: String(e && e.message || e) }; }
}

// ==================== v1.63 记忆遗忘机制（本质=衰退 · 只按剧情日期 · 重要性参与） ====================
// 记忆（长期记忆 memories）=「被想起才维持」：每次 AI 写入/更新记忆即视为一次「想起」（mergeDelta 记忆增改时
//   自动补剧情日期，AI 自带日期保留）；遗忘按**只按剧情日期**老化（无剧情时钟 → 永不遗忘，同 v1.62 状态口径）。
//   重要性挂钩「当前全部记忆 importance 的总体均值 avg」：**importance ≥ avg 的记忆免疫遗忘（score=0）**；
//   低于 avg 的才参与 —— 且按相对缺口加速（缺口越大忘得越快：score = 时间衰退 × min(2, avg/imp)，封顶 ×2 仍渐进淡出）；
//   单条 score ≥ memoryForgetCutoff（默认 0.9）→ 自动移除；条目数 > 存储上限(150)×memoryForgetRatio（默认 50%）
//   触发统一调度；记忆写入/更新/删除后 3s 延迟堆叠调度一次（与平行/状态同口径）。

function scenesUnionMergeAll() {
    let n = 0;
    try { n += scenesUnionMerge(); } catch (e) { }
    try { n += scenesSimilarNameMerge(); } catch (e) { }
    return n;
}
// ==================== 状态主体「同一角色不同称呼」归并 ====================
// 用户反馈⑥：状态记录里同一角色既以全名、又以「名」各记一组（如「亨德里克·范·德·贝克」与
//   「亨德里克」），实际是一个人却被重复记录两次，西方长姓名尤其明显。
// 判定（保守：宁可漏合，不可错合）：忽略大小写与空白后 ——
//   ① 完全相同；或 ② 一方的「姓名核」（首个片段）等于另一方整体（「名」↔「全名」）。
//   「只写姓」不归并（同姓可能是另一个人），「昵称/称号」也不自动归并（由提示词约束 AI 统一称呼）。

function memoryImportance(m) { return clamp(Number(m && m.importance) || 0.5, 0, 1); }

function memoryForgetAvg() {
    const list = state.memories || [];
    if (!list.length) return 0.5;
    const sum = list.reduce((s, m) => s + memoryImportance(m), 0);
    return sum / list.length;
}
// 单条遗忘值（0=免疫/无剧情时钟；>0 才参与遗忘）

function stateSubjectCore(name) {
    try { return String(name || '').trim().split(/[·・.．\s]+/)[0].toLowerCase(); } catch (e) { return ''; }
}

function memoryForgetScore(m) {
    const imp = memoryImportance(m);
    const avg = memoryForgetAvg();
    if (imp >= avg) return 0;                                // 不低于总体均值 → 免疫遗忘
    const now = parseStoryDateMs(state.state && state.state.date);
    if (!now) return 0;                                      // 无剧情时钟 → 永不遗忘
    const list = state.memories || [];
    const ts = list.map(x => parseStoryDateMs(x && x.date)).filter(t => !!t);   // v1.193：负年份（公元前）同样计入
    const earliest = ts.length ? Math.min.apply(null, ts) : 0;
    const latest = ts.length ? Math.max.apply(null, ts) : 0;
    const t = calcTimeDecay(earliest, latest, now, parseStoryDateMs(m && m.date), list.length);
    // v1.145：加速缺口封顶 ×2 → ×1.5（调低遗忘速度，避免信息被快速删除）
    const deficit = imp <= 0 ? 1.5 : Math.min(1.5, avg / imp);
    return Math.min(1, t * deficit);
}

function stateSubjectSamePerson(a, b) {
    try {
        const x = String(a || '').trim().toLowerCase();
        const y = String(b || '').trim().toLowerCase();
        if (!x || !y) return false;
        if (x === y) return true;
        const cx = stateSubjectCore(a), cy = stateSubjectCore(b);
        return !!((cx && cx === y) || (cy && cy === x));
    } catch (e) { return false; }
}
// 同人同字段冲突 → 保留更新者（剧情日期 → 时刻 → 楼层 → 使用次数）

function stateItemNewer(a, b) {
    try {
        const da = String((a && a.updatedAt) || ''), db = String((b && b.updatedAt) || '');
        if (da !== db) return da > db;
        const ta = String((a && a.updatedAtTime) || ''), tb = String((b && b.updatedAtTime) || '');
        if (ta !== tb) return ta > tb;
        const fa = Number(a && a.floorEnd) || 0, fb = Number(b && b.floorEnd) || 0;
        if (fa !== fb) return fa > fb;
        return (Number(a && a.uses) || 0) > (Number(b && b.uses) || 0);
    } catch (e) { return true; }
}

function memoryForgetExpired(m) {
    if (!cfg || cfg.memoryForgetEnabled === false) return false;
    const cutoff = Number(cfg.memoryForgetCutoff) != null ? Number(cfg.memoryForgetCutoff) : 0.9;
    return memoryForgetScore(m) >= Math.min(1, Math.max(0, cutoff));
}

function scheduleMemoryForget() {
    try {
        if (!cfg || cfg.memoryForgetEnabled === false) return;
        if (!state || !state.state || !state.state.date) return;   // 无剧情时钟不调度
        if (memoryForgetTimer) return;
        memoryForgetTimer = timerHooks.set(async () => {
            memoryForgetTimer = null;
            try { await runMemoryForget({}); } catch (e) { warn('记忆遗忘清扫失败', e); }
        }, 3000);
    } catch (e) { }
}
async function runMemoryForget(opts) {
    try {
        if (!cfg || cfg.memoryForgetEnabled === false) return { removed: 0, triggered: false, reason: 'disabled' };
        if (!state || !state.state || !state.state.date) return { removed: 0, triggered: false, reason: 'no-story-clock' };
        const o = opts || {};
        const list = state.memories || [];
        const n = list.length;
        const cap = storeCapFor('memories');                 // v1.147：用存储上限（默认 600，≥保底 200）
        const floor = storeMinFor('memories');               // v1.147：保底 —— 遗忘不得跌破
        const ratio = Math.min(1, Math.max(0, Number(cfg.memoryForgetRatio) != null ? Number(cfg.memoryForgetRatio) : 0.5));
        const overRatio = n > Math.floor(cap * ratio);          // 超出存储上限 ×比例（默认 50%）
        const avg = memoryForgetAvg();
        const expiredAll = list.filter(memoryForgetExpired);    // 遗忘值 ≥ 阈值 → 自动移除候选
        const removable = Math.max(0, n - floor);               // 保底：最多只能清到 floor 条
        const expired = expiredAll.slice(0, removable);
        if (!o.force && !overRatio && !expired.length) return { removed: 0, triggered: false, overRatio, n, cap, floor };
        if (expired.length) {
            const removeIds = new Set(expired.map(x => x.id || JSON.stringify(x).slice(0, 60)));
            // v1.117：遗忘移除记墓碑（跨端不再复活已遗忘记忆）
            try { tombMany('memories', Array.from(removeIds)); } catch (e) { }
            state.memories = list.filter(x => !removeIds.has(x.id || JSON.stringify(x).slice(0, 60)));
            saveState();
        }
        try {
            dbgLog('发送记忆', { action: '记忆遗忘清扫', n, cap, overRatio, avg, cutoff: Number(cfg.memoryForgetCutoff), removed: expired.length, titles: expired.slice(0, 6).map(x => String(x.title || x.content || x.id || '').slice(0, 30)) });
        } catch (e) { }
        if (expired.length) {
            const remain = (state.memories || []).length;
            try { toast(`🧠 记忆遗忘清扫：${expired.length} 条低重要度旧记忆自动遗忘（剩 ${remain}）`, 'info'); } catch (e) { }
        }
        return { removed: expired.length, triggered: overRatio || expired.length > 0, overRatio, n, cap, avg, remain: (state.memories || []).length };
    } catch (e) { return { removed: 0, triggered: false, error: String(e && e.message || e) }; }
}

// ==================== v1.67 情节总结（半自动 · 聚合早期情节；走提取记忆 AI 管道） ====================
// 触发：全部原子正文合计字符 ≥ atomCompactChars（默认 3 万）→ 摘要/提取完成后的检查点自动调度（亦可手动）；
// 范围：情节原子按剧情日期从旧到新分「早期」段；保护最近 atomCompactRecent（默认 20）条（楼层/日期最新）不参与；
// 目标：参与运作（未隐藏）的情节数 ≤ 当前 × atomCompactTarget（默认 30%）；
// 粒度降级（日→月→年）：同一粒度把「同日（月/年）且 ≥2 条」归组 → 每组压成 1 条（date=组粒度起点）；
//   若该粒度「可融合占比」（可归组原子/早期池原子）低于 atomCompactRatio（默认 60%）→ 降级下一粒度；
//   单轮组数 ≤ atomCompactBatch（默认 40），AI 分批返回 {"groups":[{key,标题,内容,标签,重要度}]}；
// 提示词：内容保留时间先后/因果/过程与关键要素（人名/地名/物品/数字），描述部分补全过程，防因果顺序错乱。

function mergeStateHistory(a, b) {
    try {
        const out = [];
        const seen = Object.create(null);
        for (const h of ([]).concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
            if (!h || !h.value) continue;
            const k = String(h.value) + '|' + String(h.floorStart || 0) + '-' + String(h.floorEnd || 0);
            if (seen[k]) continue;
            seen[k] = 1;
            out.push(h);
        }
        return out.slice(-20);   // 只留最近 20 条历史，防膨胀
    } catch (e) { return []; }
}
// 归并同一角色的不同称呼为一条主体（返回合并掉的条目数；0 = 无变化。调用方负责 saveState 落盘，
//   消失的条目由 saveState 的 tombstoneSweep 自动留墓碑 → 跨端不会被旧副本复活）

function statesSubjectUnionMerge() {
    try {
        const list = state.currentStates || [];
        if (list.length < 2) return 0;
        const snapNames = (state.snapshots || []).map(s => String((s && s.name) || '').trim()).filter(Boolean);
        const groups = [];
        for (const s of list) {
            if (!s || !s.subject) continue;
            let g = null;
            for (const x of groups) { if (stateSubjectSamePerson(x.name, s.subject) || x.items.some(it => stateSubjectSamePerson(it.subject, s.subject))) { g = x; break; } }
            if (!g) { g = { name: String(s.subject).trim(), items: [] }; groups.push(g); }
            g.items.push(s);
            const nm = String(s.subject).trim();
            if (nm.length > g.name.length) g.name = nm;      // 先取组内最长者（通常是全名）
        }
        // 规范名优先角色档案中的姓名（与「状态记录」提示词「主体必须与角色档案一致」同源）
        for (const g of groups) {
            const hit = snapNames.find(n => g.items.some(it => stateSubjectSamePerson(n, it.subject)));
            if (hit) g.name = hit;
        }
        let removed = 0;
        const out = [];
        for (const g of groups) {
            const byField = new Map();
            for (const s of g.items) {
                const fk = String(s.field || '').toLowerCase();
                const prev = byField.get(fk);
                if (!prev) { byField.set(fk, s); continue; }
                const newer = stateItemNewer(s, prev) ? s : prev;
                const older = (newer === s) ? prev : s;
                newer.history = mergeStateHistory(older.history, newer.history);
                newer.uses = Math.max(Number(newer.uses) || 0, Number(older.uses) || 0);
                newer.floorStart = Math.min(Number(newer.floorStart) || 0, Number(older.floorStart) || 0);
                newer.floorEnd = Math.max(Number(newer.floorEnd) || 0, Number(older.floorEnd) || 0);
                if (older.status === 'active') newer.status = 'active';
                byField.set(fk, newer);
                removed++;
            }
            for (const s of byField.values()) {
                const nm = String(g.name || s.subject).trim();
                if (s.subject !== nm) {
                    s.subject = nm;
                    s.key = `${nm.toLowerCase()}::${String(s.field || '').toLowerCase()}`;
                    s.title = `${nm}·${s.field}`;
                }
                out.push(s);
            }
        }
        if (!removed) return 0;
        const before = list.length;
        state.currentStates = out;
        try { log(`状态记录主体归并：同一角色的不同称呼已合并（${before} → ${out.length} 条，删除 ${removed} 条重复）`); } catch (e) { }
        return removed;
    } catch (e) { return 0; }
}
// 场景全量重建（场景页修复按钮 —— 修正结构错乱/用词）。以 AI 给出的「最终节点列表」为准：
//   归一化 + 同路径去重；逐级补全中间层；路径未变时保留原 id/uses/floorSeen/描述兜底。

function findSceneNode(pathArr) {
    const key = (Array.isArray(pathArr) ? pathArr : []).join('>');
    if (!key) return null;
    return (state.scenes || []).find(x => (Array.isArray(x.pathArr) ? x.pathArr.join('>') : String(x.pathStr || '')) === key) || null;
}
// 构建场景树文本（参考柏宝书：按路径排序、逐级缩进、聚合重复层级）

function totalMemoryCount() {
    const c = state;
    return (c.atoms || []).length + (c.currentStates || []).length + (c.snapshots || []).length +
        (c.memories || []).length + (c.items || []).length + (c.plans || []).length + (c.suspense || []).length +
        (c.scenes || []).length + (c.concepts || []).length;
}
// 类目统计（标签页内展示）

function normRumorChainKind(v) {
    const s = String(v == null ? '' : v).trim();
    const hit = RUMOR_CHAIN_KINDS.find(x => s === x || (s && s.indexOf(x) >= 0));
    return hit || '传播';
}
// 主体归一（识别同一谱系）：去空白 / 全角括号统一 / 去尾部标点 —— 使「码头沉船？」「码头 沉船」视为同一主体

function normalizeRumorChainStep(raw) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        const kind = normRumorChainKind(raw.kind || raw['类型']);
        const note = normText(raw.note || raw['说明'] || raw['备注'], 160);
        const at = normText(raw.at || raw['日期'] || raw.date, 20);
        const from = normText(raw.from || raw['从'], 60);
        const to = normText(raw.to || raw['到'], 60);
        if (!note && !at && !from && !to) return null;
        return { at, round: Math.max(0, Math.round(Number(raw.round) || 0)), kind, from, to, note };
    } catch (e) { return null; }
}

function mergeSnapshotObjects(old, n, opts) {
    const ce = !!(opts && opts.clearEmpty);
    const oldI = old.identity || {}, oldP = old.personality || {}, oldB = old.background || {}, oldS = old.social || {}, oldF = old.future || {};
    // 增量合并不以空串覆盖旧值（角色档案「更新」只传变化部分 —— 未变化字段留空即保持旧值，
    //   避免 AI/编辑器增量更新把 性别/职业 等既有字段冲成空）
    const fill = (o, nObj) => {
        const r = Object.assign({}, o);
        for (const [k, v] of Object.entries(nObj || {})) { if (v !== undefined && v !== null && v !== '') r[k] = v; }
        return r;
    };
    const fillCe = (o, nObj) => Object.assign({}, o, nObj || {});
    const nl = (arr) => normalizeList(arr);
    // v1.161：两个「剧情时间」采样字段取**更晚的一次观测** —— 避免 AI 增量更新（空值不覆盖）
    //   与编辑器全量保存（clearEmpty）把已有记录冲空
    const laterPair = (od, ot, nd, nt) => {
        const a = String(od || ''), b = String(nd || '');
        if (!b) return { d: a, t: String(ot || '') };
        if (!a) return { d: b, t: String(nt || '') };
        if (b > a) return { d: b, t: String(nt || '') };
        if (b < a) return { d: a, t: String(ot || '') };
        return { d: a, t: String(nt || ot || '') };
    };
    const tUp = laterPair(old.lastUpdateDate, old.lastUpdateTime, n.lastUpdateDate, n.lastUpdateTime);
    const tSeen = laterPair(old.lastSeenDate, old.lastSeenTime, n.lastSeenDate, n.lastSeenTime);
    // v1.162：年龄为派生字段 —— 合并后按「出生日期 + 当前剧情日期」重算，且**不采信**外部传入的年龄
    // v1.164：「已去世」为三态开关 —— 新值 undefined（本次未提及）保留旧值，true/false 视为明确表态（fill/fillCe 已按此语义）
    // v1.162：年龄为派生字段 —— 合并后按「出生日期 + 剧情时间锚点」重算，且**不采信**外部传入的年龄；
    //   v1.171：无剧情锚点时不清空（保留合理的旧值），只在旧值不合理（如被现实年份算出的 1xx 岁）时清掉
    const mergedIdentity = ce ? fillCe(oldI, n.identity) : fill(oldI, n.identity);
    // v1.162/v1.171/v1.176：年龄为派生字段 —— 合并后统一走 syncSnapshotAge()（出生日期 + 剧情锚点重算，
    //   不采信外部传入的年龄；算不出时保留合理存档值、清掉不合理的历史污染值）
    try { syncSnapshotAge({ identity: mergedIdentity }); } catch (e) { }
    return {
        ...old, ...n,
        lastUpdateDate: tUp.d, lastUpdateTime: tUp.t, lastSeenDate: tSeen.d, lastSeenTime: tSeen.t,
        tags: ce ? nl(n.tags || []) : mergeTags((n.tags && n.tags.length ? n.tags : (Array.isArray(old.tags) ? old.tags : [])), []),
        identity: mergedIdentity,
        // v1.162：外貌为单字段文本 —— 增量更新时「非空新值覆盖旧值，空值保留旧值」；
        //   编辑器全量保存（clearEmpty）时空值 = 用户有意清空
        appearance: ce ? String(n.appearance || '') : (String(n.appearance || '').trim() || String(old.appearance || '')),
        personality: ce ? {
            traits: nl(n.personality.traits || []),
            quirks: nl(n.personality.quirks || []),
            values: nl(n.personality.values || []),
            speechStyle: String(n.personality.speechStyle || '').trim(),
        } : {
            traits: n.personality.traits.length ? n.personality.traits : (oldP.traits || []),
            quirks: n.personality.quirks.length ? n.personality.quirks : (oldP.quirks || []),
            values: n.personality.values.length ? n.personality.values : (oldP.values || []),
            speechStyle: n.personality.speechStyle || oldP.speechStyle || '',
        },
        background: ce ? fillCe(oldB, n.background) : fill(oldB, n.background),
        relationships: ce ? n.relationships.slice() : (n.relationships.length ? n.relationships : (old.relationships || [])),
        social: ce ? fillCe(oldS, n.social) : fill(oldS, n.social),
        future: ce ? { todos: nl(n.future.todos || []), commitments: nl(n.future.commitments || []) } : { todos: n.future.todos.length ? n.future.todos : (oldF.todos || []), commitments: n.future.commitments.length ? n.future.commitments : (oldF.commitments || []) },
    };
}

function normMatchKey(t) {
    return String(t || '').replace(/[？?！!。，,、；;：:·、\s]/g, '').trim().toLowerCase();
}

// ==================== 楼层哈希与断裂识别（v1.34 / v1.70 修复）====================
// 已处理楼层标记：state.processedFloors = [{ f: 楼层号, h: 楼层内容哈希 }]
//  - 哈希 = 楼层文本 hashText：内容被编辑/重排后哈希变化 → 该楼需重新分析（防重复/防误判）
//  - v1.70 修复：唯一性判定**不用易变内容** ——
//    ①哈希锚定「稳定正文」：取 swipes[0]（原始首刷）而非当前选中刷/可视文本 —— 切刷、其他插件隐藏改写当前文本不会误判；
//    ②升级迁移：processedVer!=='v1.70' 时旧标记哈希一次性按稳定正文刷新（已分析楼层不被误判为未摘要）；
//    ③哈希归位对账（reconcileProcessedFloors）：其他插件增删/隐藏楼层导致索引错位时，
//      按「当前内容哈希 ∈ 历史已处理哈希集」把标记归位到新索引（内容未变只挪位置 → 保持已处理，不再冒出）。
//  - 断裂检测：最新楼层 < 记录的 lastKnownFloor - 容差 → 楼层被删除/回滚 → 按哈希重算标记

function sweepStatesForRemovedSnapshots(names) {
    try {
        const fulls = new Set();
        const cores = {};
        for (const nm of (names || [])) {
            const f = String(nm || '').trim();
            if (!f) continue;
            fulls.add(f);
            const c = injectNameCore(f);
            (cores[c] = cores[c] || []).push(f);
        }
        if (!fulls.size) return 0;
        const beforeList = (state.currentStates || []).slice();
        const before = beforeList.length;
        state.currentStates = beforeList.filter((s) => {
            const subj = String((s && s.subject) || '').trim();
            if (!subj) return true;
            if (fulls.has(subj)) return false;                       // 主体=被删角色全名
            const c = injectNameCore(subj);
            const arr = cores[c];
            if (arr && arr.length === 1 && subj.includes('·')) return false;  // 主体=「角色·后缀」，且该姓名核唯一对应被删角色
            return true;
        });
        // 联动清除的状态记墓碑（跨端删除同步）
        try {
            const afterList = state.currentStates || [];
            tombMany('currentStates', beforeList.filter(s => afterList.indexOf(s) < 0).map(s => s && s.id));
        } catch (e) { }
        return before - (state.currentStates || []).length;
    } catch (e) { return 0; }
}

// ==================== v1.165：通用知情关联层（state.links[]） ====================
// 设计事实源：docs/11-记忆大类改造设计（事实与知情链路）§2–§3。要点：
//   ① **记忆原子不动**（owner 等既有字段保留，仅在无关联时作回退口径）；计划 / 悬念 / 平行事件原子本版扩展；
//   ② 「谁与某条目相关、怎么相关」= 独立原子维度 links[]（一行 = 一个「条目 ↔ 角色」关联）——
//      因此自动继承内容哈希 / 跨端逐条合并 / 内容去重 / 删除墓碑 / 瘦身白名单 / 快照链（已加入 ATOM_DIM_KEYS）；
//   ③ **锚行**（who === ''）承载条目级属性（事实标记 / 公开 / 各类引用），非锚行这些字段一律清空（避免冗余分叉）；
//   ④ how 的合法子集按 dim 限定，越界归一为 unspecified 并记 note；平行事件的关联**恒为 related**
//      （语义 = 相关/受影响 ≠ 知情：平行事件对任何角色都不可见）；
//   ⑤ 引用类字段（conceptRef / atomRef / planRef / suspenseRef / memRefs / sourceRefs）**不进内容哈希**。

function dropRelLinks(dim, ids) {
    let n = 0;
    try {
        const d = String(dim || '');
        const set = new Set((Array.isArray(ids) ? ids : [ids]).filter(x => x !== undefined && x !== null && x !== '').map(x => String(x)));
        if (!set.size) return 0;
        const arr = (state && state.links) || [];
        const gone = arr.filter(x => x && String(x.dim) === d && set.has(String(x.refId)));
        if (!gone.length) return 0;
        n = gone.length;
        state.links = arr.filter(x => !(x && String(x.dim) === d && set.has(String(x.refId))));
        try { tombEntries('links', gone); } catch (e) { }
    } catch (e) { }
    return n;
}
// 引用重挂：条目合并（记忆 / 计划 / 悬念 / 平行事件）后把关联与引用指回主条

function applyEntryRelLinks(dim, refId, raw, opts) {
    try {
        if (!refId || !raw) return 0;
        if (cfg && cfg.relLinkEnabled === false) return 0;
        const arr = raw.relLinks || raw.links || null;
        if (!Array.isArray(arr) || !arr.length) return 0;
        if (typeof upsertRelLinks !== 'function') return 0;
        const r = upsertRelLinks(dim, refId, arr, opts);
        return (r.added || 0) + (r.updated || 0);
    } catch (e) { return 0; }
}
// v1.165：把一批「带关联的条目输入」写成关联行（按 id 或名称/标题/正文定位已落库条目）

function applyDeltaRelLinks(delta) {
    let n = 0;
    try {
        if (!delta || typeof delta !== 'object') return 0;
        const list = (v) => (Array.isArray(v) ? v : []);
        const pick = (dim, arr, match) => {
            for (const raw of arr) {
                if (!raw || typeof raw !== 'object') continue;
                const rel = raw.relLinks || raw.links;
                if (!Array.isArray(rel) || !rel.length) continue;
                const target = (state[dim] || []).find(x => x && match(x, raw));
                if (target && target.id) n += applyEntryRelLinks(dim, target.id, raw);
            }
        };
        pick('memories', list(delta.memories && delta.memories.add).concat(list(delta.memories && delta.memories.update)),
            (x, r) => String(x.id) === String(r.id || '') || (r.title && String(x.title) === String(r.title)) || (r.content && String(x.content) === String(r.content)));
        pick('plans', list(delta.plans && delta.plans.add).concat(list(delta.plans && delta.plans.update)),
            (x, r) => String(x.id) === String(r.id || '') || (r.content && String(x.content) === String(r.content)));
        pick('suspense', list(delta.suspense && delta.suspense.add).concat(list(delta.suspense && delta.suspense.update)),
            (x, r) => String(x.id) === String(r.id || '') || (r.content && String(x.content) === String(r.content)));
        pick('parallels', list(delta.parallels && delta.parallels.add).concat(list(delta.parallels && delta.parallels.update)),
            (x, r) => String(x.id) === String(r.id || '') || (r.title && String(x.title) === String(r.title)));
    } catch (e) { }
    return n;
}
// 载入迁移（幂等）：容器归一 / 丢弃非法行 / how 合法子集 / 去重 / 每条目超限截断

function repairNormText(s) { try { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); } catch (e) { return ''; } }

function repairKeyText(s) { try { return repairNormText(s).replace(/[，。；、！？：""''（）()\[\]【】\s·・.,;:!?"'`~\-—_/\\|]/g, '').toLowerCase(); } catch (e) { return ''; } }

function repairBigrams(s) {
    const t = repairKeyText(s);
    const out = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
}

function repairSimilarity(a, b) {
    try {
        const A = new Set(repairBigrams(a));
        const B = new Set(repairBigrams(b));
        if (A.size < 3 || B.size < 3) return 0;
        let hit = 0;
        for (const g of A) if (B.has(g)) hit++;
        return hit / Math.max(1, Math.min(A.size, B.size));
    } catch (e) { return 0; }
}

// —— 第 1 段 a：合并冗余（内容哈希并集 + 同名称并集 + 场景两级并集 + 状态主体归并）——

function repairClampNum(v, lo, hi, dft) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.min(hi, Math.max(lo, n));
}

function storeMinFor(dim) {
    try { const e = STORE_LIMITS[dim]; const v = Number(cfg && e && cfg[e[0]]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; } catch (e) { return 0; }
}
// 有效上限 = max(配置上限, 保底) —— 保证任何裁剪都不会跌破保底

function storeCapFor(dim) {
    try {
        const e = STORE_LIMITS[dim];
        const v = Number(cfg && e && cfg[e[1]]);
        const cap = Number.isFinite(v) && v > 0 ? Math.floor(v) : (e ? e[2] : 0);
        return Math.max(1, Math.max(cap, storeMinFor(dim)));
    } catch (e) { return 1; }
}

function enforceDimCaps() {
    const out = { cut: 0, dims: {} };
    try {
        const protectImp = repairClampNum(cfg && cfg.lowUseForgetProtectImportance, 0, 1, 0.8);
        for (const pair of DIM_CAP_KEYS) {
            const dim = pair[0], label = pair[1];
            const cap = storeCapFor(dim);                     // v1.147：存储上限（≥ 保底）
            const arr = Array.isArray(state[dim]) ? state[dim] : [];
            if (!cap || arr.length <= cap) continue;
            const idx = arr.map((e, i) => i);
            idx.sort((a, b) => {
                const ia = Number(arr[a] && arr[a].importance) || 0;
                const ib = Number(arr[b] && arr[b].importance) || 0;
                const pa = ia >= protectImp ? 1 : 0, pb = ib >= protectImp ? 1 : 0;
                if (pa !== pb) return pb - pa;
                const ua = Number(arr[a] && arr[a].uses) || 0, ub = Number(arr[b] && arr[b].uses) || 0;
                if (ua !== ub) return ub - ua;
                return b - a;
            });
            const keepIdx = new Set(idx.slice(0, cap));
            const dropped = arr.filter((e, i) => !keepIdx.has(i));
            const keep = arr.filter((e, i) => keepIdx.has(i));
            const ids = dropped.map(e => e && e.id).filter(Boolean).map(String);
            try { if (ids.length) tombMany(dim, ids); } catch (e) { }
            state[dim] = keep;
            out.cut += dropped.length;
            out.dims[dim] = { label: label, removed: dropped.length };
        }
    } catch (e) { }
    return out;
}

// 返回 { swept, dims: {dim: {removed, names[]}}, skipped, avg }
// v1.153：**默认缓慢处理旧数据** —— 清扫间隔闸门（距上次清扫不足 N 楼则整项跳过）+ 记录本轮清扫楼层。
//   与「长期未现门槛 300 楼 / 每维度每轮最多 1 条」配套，形成缓慢滴灌：旧数据最终会被处理，但每次只动极少。

function applyStateBounds() {
    try {
        const mn = Math.max(0, Number(cfg && cfg.stateMinPerSubject) || 0);
        const mx = Math.max(mn, Number(cfg && cfg.stateMaxPerSubject) || 10);
        const all = state.currentStates || [];
        const act = [];
        const inact = [];
        for (const s of all) { (s && s.status === 'inactive' ? inact : act).push(s); }
        const groups = {};
        act.forEach(s => { (groups[s.subject] = groups[s.subject] || []).push(s); });
        let cut = 0;
        const kept = [];
        for (const list of Object.values(groups)) {
            if (list.length > mx) {
                list.sort((a, b) => { const ka = Number(a.floorEnd) || 0, kb = Number(b.floorEnd) || 0; if (ka !== kb) return kb - ka; return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
                cut += list.length - mx;
                list.length = mx;
            }
            kept.push.apply(kept, list);
        }
        state.currentStates = kept.concat(inact);
        return { cut };
    } catch (e) { return { cut: -1 }; }
}
// ==================== v1.142 物品修复重设计（标签/名称相关性聚类 → 打包交 AI 融合 + 低调用固定规则清理） ====================
// 用户要求：① 利用**标签、名称**的相关性排名，提炼出**相关性最高的一组物品**，提交 AI 识别判断是否**融合**并**完善描述**；
//   ② 针对**长期远低于平均调用次数**的物品，按**固定规则**在修复时删除。
// 旧实现（v1.101~v1.141）：把整库物品 dump 给 AI 并要求回传「物品库.重建 = 完整最终列表」—— 库大时输入输出都大，AI 难免漏项。
// 新实现五步（前三步零 AI；只有存在高相关组或客观缺陷条目才发 AI）：
//   ① `itemMergeExact` 机械去重：同规范名（去括号说明/空白）合并一条（货币合计数量、uses 累加、标签并集、说明取更长、位置/携带取最新）；
//   ② `itemLowUsesPurge` 低调用清理：固定规则删除「长期远低于平均调用次数」的物品（阈值与门槛全部可配，见 cfg.itemLow*）；
//   ③ 标签/名称聚类 + 选组：相关度 = `max(标签组 Jaccard, 名称相似度)`，边 ≥ `cfg.itemRepairSim`（默认 0.45）**且**
//      （共享 ≥2 标签 **或** 名称相似度 ≥ 0.5）；组规模上限与游标轮询同通用引擎；客观缺陷（说明超字数/标签 <3 个等）另列一组；
//   ④ 窄契约 AI：只发选中的物品组 + 近期正文，要求 `{"合并":[…],"修订":[…],"删除":[…]}`（**禁止新增物品**）；
//   ⑤ 按编号应用 `applyItemMergeGroups`：合并保主条 id、uses 累加、标签并集（并补齐到 3-8 个）、说明取 AI 或更长者。
// 物品规范名：去掉末尾括号说明（（…）(…)【…】）与空白后的名称 —— 「怀表」「银色怀表（旧）」归为同一件

// v1.92：剧情日期推进后顺带调度「状态记录衰退」（B8-2 时钟自动提取会调用）—— 供 clock-extract 复用
// B8-5：遗忘域共用助手导出（`core/forget.js` 与测试复用，避免重复实现）
export {
    mergeDelta, scheduleStateDecay, runStateDecay,
    storeMinFor, storeCapFor, enforceDimCaps, repairClampNum, memoryImportance, calcTimeDecay,
    STORE_LIMITS, DIM_CAP_KEYS,
    // B8-6：修复管线共用助手（同一套文本规范化/相似度，避免重复实现）
    repairNormText, repairKeyText, repairBigrams, repairSimilarity,
    scenesUnionMergeAll, statesSubjectUnionMerge,
    // B8-6c-4：状态修复复用「同人同字段」判据与历史归并（`core/state-repair.js` 与测试复用，避免重复实现）
    stateSubjectSamePerson, mergeStateHistory,
    runParallelDecay, scheduleParallelDecay, applyStateBounds,
};
