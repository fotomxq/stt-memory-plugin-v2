// ============================================================
// core/state-repair.js —— **状态记录修复管道**（B8-6c-4，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.158 · 状态页「🔧 修复状态」专用；v1.205 追加固定规则）：
//   用户要求：状态页新增修复按钮 —— ① 先自动匹配角色，**找不到则删除对应状态组**；
//   ② 再套用其它可行规则清理 / 整理 / 规范化；③ 最后抽取交给 AI 修复整理。
//   实现顺序（严格按用户口径）：
//     ⓪ v1.205：`removeStatesOfDeceased` 固定规则 —— **已去世角色**（`snapshotAgeIsLocked`，身份.已去世）的
//        状态记录先机械移除（按主体名归一后全等匹配整组移除 + 内容哈希墓碑，零 AI、幂等）；
//     ① `stateRepairMatch` 自动匹配角色：先复用 `statesSubjectUnionMerge()` 把「同一角色的不同称呼」归并
//        （规范名优先角色档案），再把每个主体与【角色档案 / 名册 / 主角 / 当前在场 / 当前角色】核对 ——
//        精确 / 姓名核一致（`stateSubjectSamePerson`）/ 包含（去分隔符后一方含另一方且长度差 ≤4）/
//        名称 bigram 相似度 ≥ `cfg.stateRepairMatchSim`（默认 0.72）→ 命中；一个都对不上 → **整组删除**
//        （留 id + 内容哈希双墓碑，跨端不复活）。**名册为空时一律不删**（`noRoster` 安全阀，避免把全部状态误删）；
//     ② `stateRepairClean`（零 AI）：空值/占位值丢弃 → 字段别名归一到 6 个规范字段 → 同主体同字段去重
//        （保更新者、uses 累加、楼层取更大、history 归并）→ 值截断到「状态」字数上限
//        （`cfg.dimCharLimits.states`，默认 130）→ 每角色条数上限 `stateMaxPerSubject`（保调用次数高者）；
//     ③ `pickStateRepairTargets` + `buildStateRepairPrompt` + `applyStateRepair`：抽最薄弱的 N 名主体
//        （规范字段填充少 → 更新时间旧 → 调用次数低；已去世主体不提交 AI），连同「现有字段现状 + 允许字段闭集 +
//        聚焦近期正文」交 AI；按「主体 + 字段」严格校验后应用（更新 / 删除 / 无依据）——
//        只允许写规范字段或该主体已有字段，禁止新增角色组。
//
// 复用（不重复实现）：
//   · 「同人称呼」判据与同字段历史归并 → `core/ingest.js#stateSubjectSamePerson` / `mergeStateHistory`
//     （V2 新增导出，避免与 `statesSubjectUnionMerge` 各写一份）；
//   · 条目归一/硬截断 → `core/model/dims.js#normalizeCurrentState` / `core/model/scalars.js#dimCap`；
//   · 已去世锁定判据 → `core/model/snapshot.js#snapshotAgeIsLocked`；
//   · 双墓碑 → `core/merge.js#tombEntries`；统一报告 → `core/repair.js#repairReport`；
//   · 正文投喂 → `core/ai-hooks.js#aiFeedText`（V1 `buildFeedFloorText` 的 V2 等价物）。
//   · 状态固定模板条数钳制 `applyStateBounds` 在 V2 **已有等价实现**（`core/ingest.js#applyStateBounds`，
//     与 V1 v1.101 逐字一致）——本批不重复移植，仅在单测里与 V1 oracle 逐字段对齐自证。
//
// 适配（与 V1 的差异，逐条见 docs/P8v-B8-6c-4状态与计划悬念修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks）；
//   ② AI 调用改走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植
//      （V2 无任务管线 UI，重绘由 UI 层负责）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//      V1 `notify('repair', …)` 的 toastr 类型是 warning → V2 传 'warning'；
//   ⑤ `runStateRepair(opts)` 增设可选 `opts.aiText` 注入点（与 `runRepair`/`runMemoryRepair` 同约定）；
//   ⑥ V1 `stateRepairRoster` 的弱来源用 `getCurrentCharacterId()`（角色 **id**）；V2 由宿主注入的
//      `identityView.characterName`（当前角色名）承担同一位置 —— 该来源**不计入 strong**（不参与「未匹配即删除」安全阀）。
//   ⑦ `characterRepairContext` 在 V2 属 `core/character-repair.js`（本批禁改），未导出 → 本文件按 V1 口径
//      就地实现 `stateRepairContext`（与 V2 该文件内实现逐字相同，由黄金样本强制校验）。
// 一致性由 tests/unit/state-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn, getStoryNow, identityView } from './model/runtime.js';
import {
    repairNormText, repairClampNum, statesSubjectUnionMerge, stateSubjectSamePerson, mergeStateHistory,
} from './ingest.js';
import { normalizeCurrentState } from './model/dims.js';
import { dimCap } from './model/scalars.js';
import { snapshotAgeIsLocked } from './model/snapshot.js';
import { tombMany, tombEntries } from './merge.js';
import { repairReport } from './repair.js';
import { aiCallText, aiBusy, aiFeedText } from './ai-hooks.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';
import { extractJsonObject, snapNameKey } from './util.js';

/** 用户提示（经宿主钩子；与 core/repair.js / core/group-repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

// V1 v1.158：状态记录的 6 个规范字段 + 字段别名表 + 「空话占位」判据（逐字）
const STATE_REPAIR_FIELDS = ['身体状况与伤势', '情绪与心理状态', '短期目标', '长期目标', '处境', '当前担忧'];
const STATE_FIELD_ALIAS = {
    '身体状况': '身体状况与伤势', '身体': '身体状况与伤势', '伤势': '身体状况与伤势', '健康': '身体状况与伤势', '伤病': '身体状况与伤势',
    '情绪': '情绪与心理状态', '心理状态': '情绪与心理状态', '心情': '情绪与心理状态', '心理': '情绪与心理状态', '精神状态': '情绪与心理状态',
    '目标': '短期目标', '当前目标': '短期目标', '近期目标': '短期目标', '当下目标': '短期目标',
    '长远目标': '长期目标', '长期计划': '长期目标', '远期目标': '长期目标',
    '位置': '处境', '当前处境': '处境', '所在': '处境', '状态': '处境', '情况': '处境',
    '担忧': '当前担忧', '忧虑': '当前担忧', '顾虑': '当前担忧', '担心': '当前担忧',
};
const STATE_VALUE_JUNK = /^(?:[-—–~～.。·・\s]*|无|暂无|未知|不详|不明|n\/?a|null|undefined|nan|待定|同上|略|（无）|\(无\))$/i;

/** 字段归一（V1 `stateCanonField`）：规范字段 → 保持；别名 → 规范；含规范字段关键字（如「身体状况与伤势（左臂）」）
 *  → 规范；关键字正则兜底；否则返回 ''（无法归一的字段由调用方决定保留或丢弃） */
function stateCanonField(f) {
    try {
        const t = repairNormText(f);
        if (!t) return '';
        if (STATE_REPAIR_FIELDS.indexOf(t) >= 0) return t;
        if (STATE_FIELD_ALIAS[t]) return STATE_FIELD_ALIAS[t];
        for (const c of STATE_REPAIR_FIELDS) { if (t.indexOf(c) >= 0) return c; }
        if (/身体|伤势|健康|伤病/.test(t)) return '身体状况与伤势';
        if (/情绪|心理|心情|精神/.test(t)) return '情绪与心理状态';
        if (/长期|长远|远期/.test(t)) return '长期目标';
        if (/短期|目标/.test(t)) return '短期目标';
        if (/担忧|忧虑|顾虑|担心/.test(t)) return '当前担忧';
        if (/处境|位置|所在|状态|情况/.test(t)) return '处境';
        return '';
    } catch (e) { return ''; }
}
/** 值是否为「空话占位」（V1 `stateValueJunk`，私有；正则与 V1 逐字一致） */
function stateValueJunk(v) { try { return STATE_VALUE_JUNK.test(repairNormText(v)); } catch (e) { return true; } }
/** 名称 bigram 相似度（V1 `stateNameSim`，私有；与 `repairSimilarity` 的差异：对 <4 字名称同样有效） */
function stateNameSim(a, b) {
    try {
        const grams = (s) => {
            const t = String(s || '').replace(/[\s·・.．\-_]/g, '').toLowerCase();
            const out = [];
            for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
            return out.length ? out : (t ? [t] : []);
        };
        const ga = grams(a), gb = grams(b);
        if (!ga.length || !gb.length) return 0;
        const setB = Object.create(null);
        for (const g of gb) setB[g] = (setB[g] || 0) + 1;
        let hit = 0;
        for (const g of ga) { if (setB[g] > 0) { hit++; setB[g]--; } }
        return (2 * hit) / (ga.length + gb.length);
    } catch (e) { return 0; }
}

/** 主体候选名册（V1 `stateRepairRoster`）：角色档案（权威）> 名册 > 主角 > 当前在场 > 当前角色。
 *  `strong` = 「有据可依」的来源条数（档案 / 名册 / 主角 / 在场）；当前角色名只作匹配补充、**不计入 strong**
 *  —— 否则「档案与名册全空」时安全阀永不触发，可能把全部状态误删。 */
function stateRepairRoster() {
    const out = { names: [], source: Object.create(null), strong: 0 };
    const push = (n, src, strong) => {
        const t = repairNormText(n);
        if (!t) return;
        const k = snapNameKey(t);
        if (!k || out.source[k]) return;
        out.source[k] = src; out.names.push(t);
        if (strong) out.strong++;
    };
    try { (state.snapshots || []).forEach(s => push(s && s.name, '档案', true)); } catch (e) { }
    try { (state.npcs || []).forEach(n => push(n && n.name, '名册', true)); } catch (e) { }
    try { push(state.protagonist && state.protagonist.name, '主角', true); } catch (e) { }
    try { ((state.state && Array.isArray(state.state.present)) ? state.state.present : []).forEach(n => push(n, '在场', true)); } catch (e) { }
    // V1：`push(getCurrentCharacterId(), '当前角色', false)` —— V2 由宿主身份视图注入当前角色名
    try { push(identityView.characterName, '当前角色', false); } catch (e) { }
    return out;
}
/** 单个主体 → 规范名（V1 `stateSubjectMatch`）：'' = 未匹配 */
function stateSubjectMatch(subject, roster, simMin) {
    const raw = repairNormText(subject);
    if (!raw) return '';
    const k = snapNameKey(raw);
    if (!k) return '';
    // 档案里同 key → 直接取档案名（规范）
    try {
        const hit = (state.snapshots || []).find(s => snapNameKey(s && s.name) === k);
        if (hit) return repairNormText(hit.name);
    } catch (e) { }
    let best = '', bestSim = 0;
    for (const n of (roster && roster.names) || []) {
        if (stateSubjectSamePerson(n, raw)) return n;                  // 精确 / 姓名核一致
        const nk = snapNameKey(n);
        if (!nk) continue;
        if ((nk.indexOf(k) >= 0 || k.indexOf(nk) >= 0) && Math.abs(nk.length - k.length) <= 4) return n;
        const s = stateNameSim(k, nk);
        if (s > bestSim) { bestSim = s; best = n; }
    }
    return (bestSim >= simMin) ? best : '';
}

/** ① 自动匹配角色 → 未匹配整组删除（V1 `stateRepairMatch`；名册为空则不删）。
 *  先 `statesSubjectUnionMerge()` 归并「同一角色的不同称呼」（规范名优先角色档案）→ 再逐主体核对 →
 *  未匹配者写 id + 内容哈希双墓碑（维度名 `currentStates`）后整组移除。 */
function stateRepairMatch(opts) {
    const o = opts || {};
    const out = { groups: 0, merged: 0, renamed: 0, removed: 0, removedSubjects: [], kept: 0, noRoster: false };
    try {
        const simMin = repairClampNum(o.sim, 0.5, 0.95, Number(cfg && cfg.stateRepairMatchSim) || 0.72);
        if (!Array.isArray(state.currentStates) || !state.currentStates.length) return out;
        // 先归并「同一角色不同称呼」（复用既有实现：规范名优先角色档案）
        try { out.merged = Number(statesSubjectUnionMerge()) || 0; } catch (e) { out.merged = 0; }
        const roster = stateRepairRoster();
        out.noRoster = !roster.strong;      // 无强来源（档案/名册/主角/在场）→ 不做「未匹配即删除」
        const bySubject = {};
        for (const s of (state.currentStates || [])) {
            const subj = repairNormText(s && s.subject) || '（无主体）';
            (bySubject[subj] = bySubject[subj] || []).push(s);
        }
        out.groups = Object.keys(bySubject).length;
        const drop = [];
        for (const subj of Object.keys(bySubject)) {
            const canon = stateSubjectMatch(subj, roster, simMin);
            if (!canon) {
                if (out.noRoster) { out.kept++; continue; }        // 安全阀：名册为空不删
                for (const e of bySubject[subj]) drop.push(e);
                out.removedSubjects.push(subj);
                continue;
            }
            if (canon !== subj) { bySubject[subj].forEach(e => { if (e) e.subject = canon; }); out.renamed++; }
            out.kept++;
        }
        if (drop.length) {
            const ids = drop.map(e => e && e.id).filter(Boolean);
            try { tombMany('currentStates', ids); } catch (e) { }        // 维度名必须是 currentStates（V1 v1.205 修正）
            try { tombEntries('currentStates', drop); } catch (e) { }   // 同时写内容哈希墓碑（同内容换 id 也不复活）
            const kill = new Set(drop);          // 以对象引用判成员（普通对象做键会被转成同一字符串）
            state.currentStates = (state.currentStates || []).filter(e => !kill.has(e));
            out.removed = drop.length;
        }
        if (out.removed || out.renamed || out.merged) { try { saveState(); } catch (e) { } }
    } catch (e) { }
    return out;
}

/** ② 机械清理与规范化（零 AI，V1 `stateRepairClean`）：空值/占位丢弃 → 字段别名归一 → 值截断 →
 *  同主体同字段去重（保更新者 → 时刻 → 楼层；uses 累加、楼层并集、history 归并）→ 每角色条数上限
 *  （`cfg.stateMaxPerSubject`，保调用次数高 → 楼层新）。删除走 id + 内容哈希双墓碑。 */
function stateRepairClean() {
    const out = { junk: 0, merged: 0, renamedField: 0, trimmed: 0, capped: 0, before: 0, after: 0 };
    try {
        const list = Array.isArray(state.currentStates) ? state.currentStates.slice() : [];
        out.before = list.length;
        if (!list.length) { out.after = 0; return out; }
        const limit = Math.max(20, Number((cfg.dimCharLimits && cfg.dimCharLimits.states)) || 130);
        const drop = new Set();                // 以对象引用判成员（无 id 的条目也能删）
        // 空值/占位 + 字段归一 + 值截断 + 主体去空白
        for (const e of list) {
            if (!e) { continue; }
            const v = repairNormText(e.value);
            if (!v || stateValueJunk(v)) { drop.add(e); out.junk++; continue; }
            const f = repairNormText(e.field);
            const canon = stateCanonField(f);
            if (!f || !canon) { if (!f) { drop.add(e); out.junk++; continue; } }
            if (canon && canon !== f) { e.field = canon; out.renamedField++; }
            if (v.length > limit) { e.value = v.slice(0, limit); out.trimmed++; } else if (v !== e.value) e.value = v;
            e.subject = repairNormText(e.subject);
        }
        // 同主体同字段去重（保更新者：updatedAt → updatedAtTime → floorEnd）
        const sorted = list.slice().sort((a, b) => {
            const da = String((a && a.updatedAt) || ''), db = String((b && b.updatedAt) || '');
            if (da !== db) return db.localeCompare(da);
            const ta = String((a && a.updatedAtTime) || ''), tb = String((b && b.updatedAtTime) || '');
            if (ta !== tb) return tb.localeCompare(ta);
            return (Number(b && b.floorEnd) || 0) - (Number(a && a.floorEnd) || 0);
        });
        const seen = Object.create(null);
        for (const e of sorted) {
            if (!e || drop.has(e)) continue;
            const k = snapNameKey(e.subject) + '|' + repairNormText(e.field).toLowerCase();
            const prev = seen[k];
            if (!prev) { seen[k] = e; continue; }
            prev.uses = (Number(prev.uses) || 0) + (Number(e.uses) || 0);
            prev.floorEnd = Math.max(Number(prev.floorEnd) || 0, Number(e.floorEnd) || 0);
            if (!repairNormText(prev.value) && repairNormText(e.value)) prev.value = e.value;
            try { prev.history = mergeStateHistory(prev.history, e.history); } catch (e0) { }
            drop.add(e); out.merged++;
        }
        // 每角色条数上限（保调用次数高 → 楼层新）
        const cap = Math.max(1, Number(cfg.stateMaxPerSubject) || 10);
        const bySub = Object.create(null);
        for (const e of sorted) { if (!e || drop.has(e)) continue; const k = snapNameKey(e.subject); (bySub[k] = bySub[k] || []).push(e); }
        for (const k of Object.keys(bySub)) {
            const arr = bySub[k].slice().sort((a, b) => (Number(b.uses) || 0) - (Number(a.uses) || 0) || (Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0));
            for (const e of arr.slice(cap)) { drop.add(e); out.capped++; }
        }
        const dropList = list.filter(e => e && drop.has(e));
        if (dropList.length) {
            try { tombMany('currentStates', dropList.map(e => e.id).filter(Boolean)); } catch (e) { }   // 维度名必须是 currentStates
            try { tombEntries('currentStates', dropList); } catch (e) { }                              // 补内容哈希墓碑
            state.currentStates = list.filter(e => !(e && drop.has(e)));
            try { saveState(); } catch (e) { }
        } else if (out.renamedField || out.trimmed) { try { saveState(); } catch (e) { } }
        out.after = (state.currentStates || []).length;
    } catch (e) { out.after = (state.currentStates || []).length; }
    return out;
}

/** 已去世角色的名称键（V1 `deceasedNameKeys`，私有）：`snapshotAgeIsLocked`（身份.已去世）为真的档案名 */
function deceasedNameKeys() {
    const keys = [], names = [];
    try {
        for (const s of ((state && state.snapshots) || [])) {
            if (!s || !s.name) continue;
            if (snapshotAgeIsLocked(s)) {
                const k = snapNameKey(s.name);
                if (k) { keys.push(k); names.push(String(s.name)); }
            }
        }
    } catch (e) { }
    return { keys: keys, names: names };
}
/** ⓪ 固定规则（V1 v1.205 `removeStatesOfDeceased`）：已去世角色的状态记录**整组机械移除**（零 AI）。
 *  按 `snapNameKey(subject)` 与档案名键**全等**匹配（称呼差异残留由 `pickStateRepairTargets` 再兜一道）；
 *  移除写「id + 内容哈希」双墓碑（维度名 = `currentStates`），跨端不会被旧副本复活；
 *  幂等：没有可移除项时不落盘、不计数（第二次调用零变化）。 */
function removeStatesOfDeceased(opts) {
    const o = opts || {};
    const out = { removed: 0, subjects: [], deceased: 0, scanned: 0 };
    try {
        const list = Array.isArray(state.currentStates) ? state.currentStates : [];
        if (!list.length) return out;
        const dk = deceasedNameKeys();
        out.deceased = dk.keys.length;
        if (!dk.keys.length) return out;
        const keySet = new Set(dk.keys);
        const drop = [];
        for (const e of list) {
            if (!e) continue;
            out.scanned++;
            const k = snapNameKey(e.subject);
            if (k && keySet.has(k)) drop.push(e);
        }
        if (!drop.length) return out;
        // 墓碑（id + 内容哈希，维度名 = currentStates）：与其他删除路径同口径，跨端不复活
        try { tombEntries('currentStates', drop); } catch (e) { }
        const kill = new Set(drop);            // 以对象引用判成员
        state.currentStates = list.filter(e => !kill.has(e));
        out.removed = drop.length;
        out.subjects = Array.from(new Set(drop.map(e => String((e && e.subject) || '')).filter(Boolean)));
        try { if (o.save !== false) saveState(); } catch (e) { }
        try { dbgLog('修复', { action: '移除已去世角色的状态记录（v1.205 固定规则）', deceased: dk.names.slice(0, 8), removed: out.removed, subjects: out.subjects.slice(0, 8) }); } catch (e) { }
    } catch (e) { }
    return out;
}

/** ③ 选最薄弱的主体（V1 `pickStateRepairTargets`）：规范字段填充少 → 更新时间旧 → 调用次数低；
 *  每轮 ≤ `cfg.stateRepairBatch`（默认 3，上限 10）；v1.205：已去世角色的状态不提交给 AI（固定规则已移除，
 *  此处再兜一道 —— 即使因称呼差异残留也不提交）。 */
function pickStateRepairTargets(limit) {
    const out = { list: [], total: 0, batch: 1 };
    try {
        const batch = Math.max(1, Math.min(10, Number(limit) || Number(cfg && cfg.stateRepairBatch) || 3));
        out.batch = batch;
        const bySub = {};
        // v1.205：已去世角色的状态已由固定规则移除；这里再兜一道 —— 即使因称呼差异残留，也不提交给 AI
        const deadKeys = new Set(deceasedNameKeys().keys);
        for (const e of (state.currentStates || [])) {
            if (!e) continue;
            const nm = repairNormText(e.subject);
            if (!nm) continue;
            if (deadKeys.size && deadKeys.has(snapNameKey(nm))) continue;
            (bySub[nm] = bySub[nm] || []).push(e);
        }
        const rows = Object.keys(bySub).map((name) => {
            const arr = bySub[name];
            const fieldMap = {};
            let uses = 0, last = 0, lastAt = '';
            for (const e of arr) {
                const f = stateCanonField(e.field) || repairNormText(e.field);
                if (f) fieldMap[f] = repairNormText(e.value);
                uses += Number(e.uses) || 0;
                last = Math.max(last, Number(e.floorEnd) || 0);
                const at = String(e.updatedAt || '');
                if (at > lastAt) lastAt = at;
            }
            const missing = STATE_REPAIR_FIELDS.filter(f => !repairNormText(fieldMap[f]));
            return { name, arr, fieldMap, filled: STATE_REPAIR_FIELDS.length - missing.length, missing, uses, last, lastAt };
        });
        rows.sort((a, b) => a.filled - b.filled || String(a.lastAt || '').localeCompare(String(b.lastAt || '')) || a.uses - b.uses);
        out.total = rows.length;
        out.list = rows.slice(0, batch);
    } catch (e) { }
    return out;
}

/** 近期正文聚焦（V1 `characterRepairContext`；V2 该函数属 `core/character-repair.js` 且未导出，按 V1 口径就地实现）：
 *  只保留提到目标角色的行（提高信噪比、降低 token）；命中过少（< 200 字）时退回整段末尾 10000 字。 */
function stateRepairContext(names) {
    let full = '';
    try { full = String(aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10)) || ''); } catch (e) { full = ''; }
    if (!full) return '';
    try {
        const set = (names || []).filter(Boolean);
        if (set.length) {
            const lines = String(full).split('\n');
            const hit = lines.filter(ln => set.some(n => ln.indexOf(n) >= 0)).join('\n').trim();
            if (hit.length >= 200) return hit.slice(-10000);
        }
    } catch (e) { }
    return String(full).slice(-10000);
}

/** ③ 状态修复提示词（V1 `buildStateRepairPrompt`）：只发本轮目标主体的**字段级现状** + 缺失规范字段清单 +
 *  聚焦近期正文 + 允许字段闭集；模板取 `cfg.promptTemplates.statesRepair` → 兜底 `defaultCfg` → 兜底内置一句话。
 *  V1 的 try/catch 兜底分支（内联两句固定文案）一并保留。 */
function buildStateRepairPrompt(pickIn) {
    try {
        const pick = pickIn || pickStateRepairTargets();
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.statesRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.statesRepair) || '').trim() || '整理角色状态记录：合并同义字段、规范化字段名、改写不规范取值；输出「状态记录」的更新与删除。';
        const names = pick.list.map(t => t.name);
        const ctx = stateRepairContext(names);
        const blocks = pick.list.map((t, i) => {
            const lines = [];
            lines.push(`#${i + 1} 主体「${t.name}」（现有 ${t.arr.length} 条 · 已填规范字段 ${t.filled}/${STATE_REPAIR_FIELDS.length} · 最近更新 ${t.lastAt || '—'} · 楼层 ${t.last || 0}）`);
            lines.push('  现有字段（未列出的规范字段 = 当前为空）：');
            let shown = 0;
            for (const f of STATE_REPAIR_FIELDS) {
                const v = repairNormText(t.fieldMap[f]);
                if (!v) continue;
                shown++;
                lines.push(`    ${f} = ${v.slice(0, 120)}`);
            }
            for (const e of t.arr) {
                const f = repairNormText(e.field);
                if (!f || STATE_REPAIR_FIELDS.indexOf(f) >= 0) continue;
                lines.push(`    ${f}（非规范字段：可改写为规范字段或删除） = ${repairNormText(e.value).slice(0, 120)}`);
                shown++;
            }
            if (!shown) lines.push('    （全部为空）');
            lines.push(`  缺失的规范字段：${t.missing.join('、') || '（无）'}`);
            return lines.join('\n');
        });
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释文字。` },
            { role: 'user', content: `【待修复状态（本轮共 ${pick.list.length} 名主体，按规范字段填充由少到多排序）】\n${blocks.join('\n')}\n\n【近期正文（补齐与改写的唯一依据）】\n${ctx || '（无正文）'}\n\n字段只允许取：${STATE_REPAIR_FIELDS.join(' / ')}（或该主体已存在的非规范字段 —— 用「更新」把它改成规范字段名）。输出：{"状态记录":{"更新":[{"主体":"…","字段":"…","值":"…"}],"删除":[{"主体":"…","字段":"…"}],"无依据":["…"]}}。要求：① 同一主体同一字段只保留一条；② 值 ≤90 字、只写「当下仍然成立」的事实，不写来龙去脉；③ **没有正文依据就不要输出该条**（宁缺勿造）；④ 只处理上面列出的主体，不要新增主体。` },
        ];
    } catch (e) { return [{ role: 'system', content: '整理角色状态记录，输出 JSON。' }, { role: 'user', content: '请输出状态记录的修复结果（JSON）。' }]; }
}

/** ③ 应用 AI 结果（V1 `applyStateRepair`）：严格校验主体属于本轮目标、字段属于规范闭集或该主体已有字段。
 *  - 操作块定位：`delta.states` → `delta.currentStates`；更新数组 `update` / `add`；
 *  - 更新：非规范字段若该主体已有同名条目 → **改写成规范字段名**（`renamedField`）；值未变 → `unchanged`；
 *    无对应条目 → 新建条目（`normalizeCurrentState`，`added`）；值超限按 `cfg.dimCharLimits.states` 截断；
 *  - 删除（`ops['删除']` / `ops.delete`）：对象写法 `{主体,字段}` 或文本写法「主体·字段」/「主体 字段」
 *    （按本轮目标主体名做**前缀**匹配 —— 长名本身含「·」，不能简单 split）；整组删除走双墓碑；
 *  - 注意（V1 原样）：生产路径的 delta 已过 `normalizeDeltaKeys`（「删除」→ `remove`），而本函数只认
 *    `ops['删除']` / `ops.delete` → 该分支在真实 AI 回包下**不会命中**（既有行为，如实保留、不擅自修正）。 */
function applyStateRepair(delta, pickIn) {
    const out = { changed: 0, added: 0, deleted: 0, unchanged: 0, invalid: 0, unknownRole: 0, noBasis: 0, renamedField: 0 };
    try {
        const pick = pickIn || pickStateRepairTargets();
        const byKey = Object.create(null);
        for (const t of pick.list) byKey[snapNameKey(t.name)] = t;
        const ops = (delta && (delta.states || delta.currentStates)) || {};
        const limit = Math.max(20, Number((cfg.dimCharLimits && cfg.dimCharLimits.states)) || 130);
        const findTarget = (nm) => { const k = snapNameKey(nm); return k ? (byKey[k] || null) : null; };
        const liveOf = (subject) => (state.currentStates || []).filter(e => e && snapNameKey(e.subject) === snapNameKey(subject));
        const existingOf = (subject, field) => liveOf(subject).find(e => repairNormText(e.field).toLowerCase() === repairNormText(field).toLowerCase()) || null;
        // 更新（含补齐规范字段 / 把非规范字段改写成规范字段）
        const ups = Array.isArray(ops.update) ? ops.update : (Array.isArray(ops.add) ? ops.add : []);
        for (const u of ups) {
            if (!u || typeof u !== 'object') { out.invalid++; continue; }
            const nmRaw = (u['主体'] !== undefined) ? u['主体'] : (u.subject !== undefined ? u.subject : (u.name || ''));
            const t = findTarget(nmRaw);
            if (!t) { out.unknownRole++; continue; }
            const fRaw = repairNormText((u['字段'] !== undefined) ? u['字段'] : (u.field || ''));
            const v = repairNormText((u['值'] !== undefined) ? u['值'] : (u.value || ''));
            if (!fRaw || !v || stateValueJunk(v)) { out.invalid++; continue; }
            const canon = stateCanonField(fRaw);
            const own = existingOf(t.name, fRaw);
            const finalField = canon || (own ? repairNormText(own.field) : '');
            if (!finalField) { out.invalid++; continue; }     // 既非规范字段、也不属于该主体已有字段 → 拒收
            if (canon && own && repairNormText(own.field) !== canon) { own.field = canon; out.renamedField++; }
            const target = existingOf(t.name, finalField) || own;
            const val = v.length > limit ? v.slice(0, limit) : v;
            if (target) {
                if (repairNormText(target.value) === val) { out.unchanged++; continue; }
                target.value = val;
                try { target.updatedAt = target.updatedAt || getStoryNow() || ''; } catch (e) { }
                out.changed++;
            } else {
                const fresh = normalizeCurrentState({ subject: t.name, field: finalField, value: val, uses: 0, floorEnd: Number(t.last) || 0, updatedAt: getStoryNow() || '' });
                if (!fresh) { out.invalid++; continue; }
                state.currentStates = state.currentStates || [];
                state.currentStates.push(fresh);
                out.changed++; out.added++;
            }
        }
        // 删除（字段级）
        const dels = Array.isArray(ops['删除']) ? ops['删除'] : (Array.isArray(ops.delete) ? ops.delete : []);
        for (const d of dels) {
            let nmRaw = '', fRaw = '';
            if (d && typeof d === 'object') { nmRaw = (d['主体'] !== undefined) ? d['主体'] : (d.subject || ''); fRaw = repairNormText((d['字段'] !== undefined) ? d['字段'] : (d.field || '')); }
            else if (typeof d === 'string') {
                // 定位文本写法：「主体·字段」/「主体 字段」—— 按本轮目标主体名做前缀匹配（长名本身含「·」，故不能简单 split）
                const sTxt = repairNormText(d);
                let hitName = '';
                for (const tt of pick.list) { if (tt && tt.name && sTxt.indexOf(tt.name) === 0 && tt.name.length > hitName.length) hitName = tt.name; }
                if (hitName) { nmRaw = hitName; fRaw = repairNormText(sTxt.slice(hitName.length).replace(/^[\s·・.．\-—:：]+/, '')); }
                else nmRaw = sTxt;
            }
            const t = findTarget(nmRaw);
            if (!t) { out.unknownRole++; continue; }
            const kill = liveOf(t.name).filter(e => !fRaw || repairNormText(e.field).toLowerCase() === fRaw.toLowerCase() || (stateCanonField(e.field) || '') === (stateCanonField(fRaw) || ''));
            if (!kill.length) { out.invalid++; continue; }
            try { tombMany('currentStates', kill.map(e => e && e.id).filter(Boolean)); } catch (e) { }   // 维度名必须是 currentStates
            try { tombEntries('currentStates', kill); } catch (e) { }                                    // 补内容哈希墓碑
            const K = new Set(kill);      // 对象引用判成员
            state.currentStates = (state.currentStates || []).filter(e => !K.has(e));
            out.deleted += kill.length;
            out.changed++;
        }
        out.noBasis = Array.isArray(ops['无依据']) ? ops['无依据'].length : (Array.isArray(ops.noBasis) ? ops.noBasis.length : 0);
        if (out.changed) { try { saveState(); } catch (e) { } }
    } catch (e) { }
    return out;
}

/**
 * 状态修复全链路（V1 `runStateRepair` 编排：⓪ 固定规则移除已去世 → ① 匹配角色 → ② 机械清理 → ③ AI 整理）：
 *   空库 → `{made:0, skipped:true}`；`aiBusy()` → `{made:0, blocked:true}`；
 *   机械段之后无可提交主体 → `{made, skipped:true, match, clean}`（`made` = 机械段是否有改动）；
 *   成功 → `{made, before, after, match, clean, ai, targets, queueLeft}`。
 * V2 适配：互斥走 `aiBusy()`（等价 V1 `busy.repair` + 摘要/压缩/推演/推进/同步占用）；AI 走 `aiCallText`；
 *   `opts.aiText` 为 V2 注入点（显式指定 AI 返回，测试用；缺省走 `aiCallText`）；
 *   V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植（重绘由 UI 层负责）。
 * @param {object} [opts] aiText（V2 注入）
 * @returns {Promise<object>} V1 同形返回结构
 */
async function runStateRepair(opts) {
    const o = opts || {};
    try {
        const list0 = state.currentStates || [];
        if (!list0.length) { notify('info', '状态修复：暂无状态记录', '请先通过「AI 摘要」生成状态或手动添加后再修复。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 都返回 blocked；
        //   V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        const beforeCount = (state.currentStates || []).length;
        // ⓪ v1.205：固定规则 —— 已去世角色的状态记录**先机械移除**（无需 AI，也不交给 AI 处理）
        const dead = removeStatesOfDeceased();
        // ① 自动匹配角色（未匹配 → 删除整组）
        const match = stateRepairMatch();
        // ② 机械清理 / 规范化
        const clean = stateRepairClean();
        const midCount = (state.currentStates || []).length;
        const mechNote = [];
        if (dead && dead.removed) mechNote.push(`移除已去世角色的状态 ${dead.removed} 条（${(dead.subjects || []).slice(0, 6).join('、')}${(dead.subjects || []).length > 6 ? ' 等' : ''}）`);
        if (match.merged) mechNote.push(`归并同人称呼 ${match.merged} 条`);
        if (match.renamed) mechNote.push(`主体规范化 ${match.renamed} 组`);
        if (match.removed) mechNote.push(`删除无档案主体 ${match.removed} 条（${(match.removedSubjects || []).slice(0, 6).join('、')}${(match.removedSubjects || []).length > 6 ? ' 等' : ''}）`);
        if (match.noRoster) mechNote.push('⚠️ 角色档案/名册为空 → 本轮不做「未匹配即删除」');
        if (clean.junk) mechNote.push(`清理空值/占位 ${clean.junk} 条`);
        if (clean.merged) mechNote.push(`同字段去重 ${clean.merged} 条`);
        if (clean.renamedField) mechNote.push(`字段规范化 ${clean.renamedField} 条`);
        if (clean.trimmed) mechNote.push(`超长截断 ${clean.trimmed} 条`);
        if (clean.capped) mechNote.push(`超出每角色上限清理 ${clean.capped} 条`);
        // ③ 抽取交 AI
        const pick = pickStateRepairTargets();
        if (!pick.list.length) {
            notify('info', '状态修复完成', `已按规则整理，无可提交 AI 的主体${mechNote.length ? '：' + mechNote.join(' · ') : ''}。`);
            return { made: (match.removed || clean.junk || clean.merged) ? 1 : 0, skipped: true, match, clean };
        }
        // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 notifyHooks 只认 info/success/warning/error）
        notify('warning', '开始修复状态记录…', `当前 ${beforeCount} 条状态 · 主体 ${pick.total} 名 → 本轮只提交最薄弱的 ${pick.list.length} 名：${pick.list.map(t => t.name).join('、')}${mechNote.length ? ` · 已先按规则整理：${mechNote.join(' · ')}` : ''}`);
        const prompt = buildStateRepairPrompt(pick);
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '状态修复'));
        const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
        const r = applyStateRepair(delta, pick);
        const after = (state.currentStates || []).length;
        const aiNote = [];
        if (r.changed) aiNote.push(`AI 更新 ${r.changed} 条${r.added ? `（补齐 ${r.added} 条）` : ''}`);
        if (r.deleted) aiNote.push(`AI 删除 ${r.deleted} 条`);
        if (r.renamedField) aiNote.push(`AI 字段规范化 ${r.renamedField} 条`);
        if (r.unchanged) aiNote.push(`值未变 ${r.unchanged} 条`);
        if (r.invalid) aiNote.push(`无效字段 ${r.invalid} 条`);
        if (r.unknownRole) aiNote.push(`主体不在本轮目标 ${r.unknownRole} 条`);
        if (r.noBasis) aiNote.push(`AI 标注无依据 ${r.noBasis} 条`);
        const anyChange = (match.removed || clean.junk || clean.merged || clean.renamedField || r.changed);
        notify(anyChange ? 'success' : 'info', anyChange ? '状态修复完成' : '状态修复：本轮无实际变化', `${repairReport({ before: beforeCount, after: after, checked: pick.list.length, groups: pick.list.length, groupsTotal: pick.total, submittedNames: pick.list.map(t => t.name), revised: r.changed, deleted: r.deleted, merged: clean.merged, extra: mechNote.concat(aiNote).join(' · ') || '无改动' })}。`);
        try { dbgLog('摘要', { action: '状态修复完成', before: beforeCount, mid: midCount, after: after, match, clean, ai: r, targets: pick.list.map(t => t.name) }); } catch (e) { }
        return { made: anyChange ? 1 : 0, before: beforeCount, after, match, clean, ai: r, targets: pick.list.length, queueLeft: Math.max(0, pick.total - pick.list.length) };
    } catch (e) {
        warn('状态修复失败', e);
        notify('error', '状态修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    STATE_REPAIR_FIELDS, STATE_FIELD_ALIAS,
    stateCanonField, stateValueJunk, stateNameSim,
    stateRepairRoster, stateSubjectMatch, stateRepairMatch, stateRepairClean,
    deceasedNameKeys, removeStatesOfDeceased,
    pickStateRepairTargets, stateRepairContext, buildStateRepairPrompt, applyStateRepair, runStateRepair,
};
