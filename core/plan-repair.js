// ============================================================
// core/plan-repair.js —— **计划/悬念修复管道**（B8-6c-4，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.140 悬念修复重设计 · v1.113 计划冗余合并 · 计划悬念页「🔧 修复计划/悬念」专用）：
//   用户要求：悬念的「修改」功能改用「本地标签组梳理 → 打包高度相关词条 → 交 AI 梳理/合并/修正」策略。
//   v1.101~v1.139：把**全部未解悬念 + 全部进行中计划**一起丢给 AI（无相关性筛选，库大时输入大、易漏项）。
//   本版：**悬念**改为打包核对（聚类/轮询/按编号应用），**计划保持原样**（仍走全量「了结」判定）。
//   四步与概念/记忆同款：
//     ① `suspenseMergeExact` 机械去重（同正文哈希，零 AI）：保留首个 id、uses 累加、重要度取大、
//        标题取非空者、标签并集（≤8）、日期取最早（v1.193 按剧情日期数值比较）；
//     ①-b `relRepairMaint` 关联层机械维护（零 AI；V2 复用 `core/rel-maint.js`）—— 与修复联动；
//     ②③ 标签组聚类 + 选组轮询（`core/group-repair.js#groupPick(GROUP_REPAIR_SPECS.suspense)`；
//        缺陷条目另列一组；悬念域 `sampleSingles` 孤例轮询 —— 「了结」判定不能只靠聚类）；
//     ④ 窄契约 AI，只发这些组 —— 合同：
//        `{"悬念库":{"合并":[…],"修订":[…],"了结":[n…],"删除":[n…]},"计划库":{"了结":["原文或标题"],"合并":[…]}}`
//        「了结」= 已被正文揭晓（移除 + `suspenseResolved` 计数）；「删除」= 冗余/占位（移除，不计已揭晓）。**禁止新增**。
//   应用层：`applySuspenseMergeGroups`（悬念按编号精确应用，合并时把被并入条目的**关联行重挂**保留主条，
//   v1.168）+ `applyPlanSuspMerge`（计划按 #P 编号合并 + `mergeDelta` 了结）。
//
// 复用（不重复实现）：
//   · 聚类/选组 → `core/group-repair.js`；正文投喂 → `core/ai-hooks.js#aiFeedText`；
//   · 关联层维护与重挂 → `core/rel-maint.js#relRepairMaint` / `core/entries.js#retargetRelRefs`；
//   · 计划「了结」入库 → `core/ingest.js#mergeDelta`；统一报告 → `core/repair.js#repairReport`。
//
// 适配（与 V1 的差异，逐条见 docs/P8v-B8-6c-4状态与计划悬念修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks）；
//   ② AI 调用改走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植
//      （V2 无任务管线 UI，重绘由 UI 层负责）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//      V1 `notify('repair', …)` 的 toastr 类型是 warning → V2 传 'warning'；
//   ⑤ `runPlanSuspRepair(opts)` 增设可选 `opts.aiText` 注入点（与 `runRepair`/`runMemoryRepair` 同约定）。
//
// ⚠️ 与 V1 一致的**既有缺陷**（如实保留、不擅自修正，黄金样本已固化）：
//   · `applyPlanSuspMerge` 只读 `delta[cat].merge`，而提示词合同里的中文键「合并」**不在 `CN_KEY_MAP`** 内
//     → 真实 AI 回包经 `normalizeDeltaKeys` 后落在 `delta.plans['合并']`，计划合并分支在**生产路径不会命中**；
//     V2 逐字保留同一写法（`applySuspenseMergeGroups` 对悬念域同时兼容「合并」/`merge` 两种形态，不受影响）。
//   · `runPlanSuspRepair` 里「无高相关悬念组且无进行中计划」的早退分支实际**不可达**（首个空库判据已先行返回）——
//     V2 逐字保留该分支（后续若调整判据顺序即按 V1 语义生效）。
// 一致性由 tests/unit/plan-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn } from './model/runtime.js';
import { repairNormText, repairKeyText, mergeDelta } from './ingest.js';
import { dimCap, clockDateTrim } from './model/scalars.js';
import { dateStrCmp } from './clock.js';
import { tombMany } from './merge.js';
import { repairIsGarbage, repairReport, repairBatchTags } from './repair.js';
import { retargetRelRefs } from './entries.js';
import { relRepairMaint, relMaintSummary, relMaintCounts, logRelMaint } from './rel-maint.js';
import { extractJsonObject } from './util.js';
import { GROUP_REPAIR_SPECS, groupPick } from './group-repair.js';
import { aiCallText, aiBusy, aiFeedText } from './ai-hooks.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';

/** 用户提示（经宿主钩子；与 core/repair.js / core/group-repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/** ① 悬念机械去重（零 AI，V1 `suspenseMergeExact`）：同内容哈希并成一条 ——
 *  「同正文 = 同一悬念」：标签并集（≤8）、uses 累加、重要度取大、标题取非空者、日期取最早（v1.193 数值比较）。
 *  注意：本函数**不写墓碑**（V1 原样 —— 消失条目的删除留痕由宿主 `saveState` 的 `tombstoneSweep` 负责）。 */
function suspenseMergeExact() {
    const st = { merged: 0 };
    try {
        const arr = state.suspense || [];
        if (arr.length < 2) return st;
        const byKey = new Map();
        const out = [];
        for (const s of arr) {
            if (!s || typeof s !== 'object') { out.push(s); continue; }
            const k = repairKeyText(s.content);
            if (!k) { out.push(s); continue; }
            const hit = byKey.get(k);
            if (hit === undefined) { byKey.set(k, out.length); out.push(s); continue; }
            // 同正文 = 同一悬念：并集标签/次数/重要度，日期取最早，标题取非空者
            const keep = out[hit];
            const tags = [];
            for (const x of (Array.isArray(keep.tags) ? keep.tags : []).concat(Array.isArray(s.tags) ? s.tags : [])) {
                const v = repairNormText(x).replace(/^#/, '');
                if (v && tags.indexOf(v) < 0) tags.push(v);
            }
            keep.tags = tags.slice(0, 8);
            keep.uses = (Number(keep.uses) || 0) + (Number(s.uses) || 0);
            keep.importance = Math.max(Number(keep.importance) || 0, Number(s.importance) || 0);
            if (!keep.title && s.title) keep.title = s.title;
            const ds = [keep.date, s.date].filter(d => /^-?\d{1,4}-\d{2}-\d{2}$/.test(String(d || '')));
            if (ds.length) keep.date = ds.slice().sort(dateStrCmp)[0];   // v1.193：按剧情日期数值取最早
            st.merged++;
        }
        if (st.merged > 0) state.suspense = out;
    } catch (e) { }
    return st;
}
/** ④ 悬念修复提示词（V1 `buildPlanSuspRepairPrompt`）：打包「未解悬念·相关组」+ 进行中计划全量清单（仅供了结判定）。
 *  模板取 `cfg.promptTemplates.planSuspRepair` → 兜底 `defaultCfg` → 兜底内置一句话；
 *  正文段 = `aiFeedText(max(1, cfg.repairFloors || cfg.feedFloors || 10)).slice(-8000)`（V1 `buildFeedFloorText`）。
 *  entries 为空且无进行中计划 → null；V1 的 try/catch 兜底分支一并保留。 */
function buildPlanSuspRepairPrompt(pick) {
    try {
        const p = pick || groupPick(GROUP_REPAIR_SPECS.suspense);
        const plans = (state.plans || []).filter(x => x && x.status === 'open');
        if (!p.entries.length && !plans.length) return null;
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.planSuspRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.planSuspRepair) || '').trim()
            || '合并同组内重复的悬念、修正措辞、了结已被正文揭晓的悬念；计划只做了结判定。';
        const ctxText = String(aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10)) || '').slice(-8000);
        const lines = [];
        let lastGroup = 0;
        for (const e of p.entries) {
            if (e.group !== lastGroup) { lines.push(e.defect ? '【缺陷条目（与相关性无关，不参与合并，可修订/了结/删除）】' : (e.single ? '【逐一核对（与相关性无关：无高相关同组条目，按轮询抽查进本批，仅做了结判定/删改）】' : `【相关组 ${e.group}】`)); lastGroup = e.group; }
            lines.push(`#S${e.n} ｜ 标题：${e.title || '（无）'} ｜ 相关度：${Number(e.sim).toFixed(2)} ｜ 标签：${(e.tags || []).join('/') || '（无）'} ｜ 日期：${e.date || '（无）'}${e.defect ? ` ｜ 问题：${e.defect}` : ''}\n   内容：${String(e.content).slice(0, 300)}`);
        }
        const body = [];
        body.push(`【未解悬念·待核对清单（本次唯一工作对象，共 ${p.picked} 组 / ${p.entries.length} 条；同组条目标签组相关性较高，可能指同一悬念，也可能只是相关；尾部「逐一核对」为无高相关同组者的轮询抽查，只做了结/删改）】`);
        body.push(lines.length ? lines.join('\n') : '（本次无高相关悬念组）');
        body.push('');
        body.push('【进行中的计划（仅作「了结」判定：不合并、不修订、不新增）】');
        body.push(plans.length ? plans.map((x, i) => `#P${i} ${x.content || ''}`).join('\n') : '（无进行中计划）');
        return [
            { role: 'system', content: `${tpl}\n只输出 JSON，不要解释。` },
            { role: 'user', content: `【近期正文（了结判定依据）】\n${ctxText || '（无正文）'}\n\n${body.join('\n')}\n\n输出：{"悬念库":{"合并":[{"保留":1,"并入":[2],"标题":"…","正文":"…","日期":"YYYY-MM-DD","标签":["…"]}],"修订":[{"编号":3,"字段":"内容","值":"…"}],"了结":[4],"删除":[5]},"计划库":{"了结":["计划原文或标题"],"合并":[{"保留编号":0,"合并编号":[2],"合并后正文":"…"}]}}（悬念按 #S 编号引用；计划了结按原文或标题、计划合并按 #P 编号；无改动就给空数组）。` },
        ];
    } catch (e) { return [{ role: 'system', content: '输出悬念的合并/修订/了结与计划的了结（JSON）。' }, { role: 'user', content: '请输出结果（JSON）。' }]; }
}

/**
 * 计划/悬念「冗余/重复内容合并」（V1 v1.113 `applyPlanSuspMerge`；编号 = 修复提示词清单 #P{n}/#S{n} 的数字）。
 * 直接移除被合并条目（不计入「了结」统计），保留条目的正文可用「合并后正文」覆盖。
 * v1.140 起：本函数实际只接收 `plans` 段（悬念合并/修订/了结已由 `applySuspenseMergeGroups` 按编号处理）。
 * ⚠️ 只读 `delta[cat].merge`（V1 原样）—— 提示词合同的中文键「合并」不在 `CN_KEY_MAP`，生产路径不命中（见文件头）。
 * @returns {{mergedPlans:number, mergedSusps:number, removed:number}}
 */
function applyPlanSuspMerge(delta) {
    const out = { mergedPlans: 0, mergedSusps: 0, removed: 0 };
    try {
        for (const cat of ['plans', 'suspense']) {
            const groups = (delta && delta[cat] && Array.isArray(delta[cat].merge)) ? delta[cat].merge : [];
            if (!groups.length) continue;
            const list = (state[cat] || []).filter(x => x && x.status === 'open');   // 与修复提示词清单同序
            if (!list.length) continue;
            for (const g of groups) {
                if (!g || typeof g !== 'object') continue;
                const keepI = Number(g['保留编号'] !== undefined ? g['保留编号'] : g.keepIndex);
                const rawDel = Array.isArray(g['合并编号']) ? g['合并编号'] : (Array.isArray(g.mergeIndex) ? g.mergeIndex : []);
                const mergedText = String((g['合并后正文'] !== undefined ? g['合并后正文'] : (g.mergedContent || '')) || '').trim();
                if (!Number.isInteger(keepI) || keepI < 0 || keepI >= list.length) continue;
                const keep = list[keepI];
                const removeSet = new Set();
                for (const di of rawDel) {
                    const n = Number(di);
                    if (Number.isInteger(n) && n >= 0 && n < list.length && n !== keepI) removeSet.add(list[n]);
                }
                if (!removeSet.size && !mergedText) continue;
                let removedHere = 0;
                state[cat] = (state[cat] || []).filter(x => {
                    if (x === keep) return true;
                    if (removeSet.has(x)) { removedHere++; return false; }
                    return true;
                });
                if (mergedText && keep) keep.content = mergedText;
                if (removedHere > 0) {
                    if (cat === 'plans') out.mergedPlans++; else out.mergedSusps++;
                    out.removed += removedHere;
                }
            }
        }
    } catch (e) { warn('计划/悬念合并失败', e); }
    return out;
}

/**
 * ④ 悬念按编号精确应用（V1 `applySuspenseMergeGroups`）：合并 / 修订 / 了结 / 删除；**禁止新增**；只在本批清单内生效。
 *  - 操作块定位：`delta.suspense` → `delta['悬念库']` → `delta` 顶层（兼容归一化后 / 顶层中文键两种形态）；
 *  - 合并：保留主条 id；标题（≤60）、正文（`dimCap('suspense')` 且过 `repairIsGarbage`）、日期（`clockDateTrim`
 *    且形如 YYYY-MM-DD）按 AI 优先；标签 3-8 个才生效并清空 `keywords`；被并入条目 uses 累加、重要度取大、
 *    日期取最早、标签并集（≤8）；v1.168 关联行**重挂**保留主条（`retargeted`）；
 *  - 修订：字段闭集 标题 / 内容 / 日期 / 标签；
 *  - 了结（已被正文揭晓，计入 `state.stats.suspenseResolved`）与删除（冗余占位）都按编号，且都留墓碑。
 */
function applySuspenseMergeGroups(delta, pick) {
    const out = { fused: 0, revised: 0, closed: 0, deleted: 0, removed: 0, skipped: 0, retargeted: 0 };
    try {
        const entries = (pick && pick.entries) || [];
        if (!delta || typeof delta !== 'object' || !entries.length) return out;
        const ops = (delta.suspense && typeof delta.suspense === 'object') ? delta.suspense
            : ((delta['悬念库'] && typeof delta['悬念库'] === 'object') ? delta['悬念库'] : delta);   // 兼容 归一化后 / 顶层中文键 两种形态
        const byN = new Map();
        entries.forEach(e => byN.set(Number(e.n), e));
        const fd = (ops['合并'] !== undefined) ? ops['合并'] : ops.merge;
        const rv = (ops['修订'] !== undefined) ? ops['修订'] : ops.revise;
        const cl = (ops['了结'] !== undefined) ? ops['了结'] : ops.close;
        const dl = (ops['删除'] !== undefined) ? ops['删除'] : ops.remove;
        const findIdx = (id) => (state.suspense || []).findIndex(x => x && String(x.id) === String(id));
        const applyTags = (e, arr) => {
            const tags = (Array.isArray(arr) ? arr : String(arr || '').split(/[，,、#\s]+/)).map(x => repairNormText(x).replace(/^#/, '')).filter(Boolean);
            if (tags.length >= 3 && tags.length <= 8) { e.tags = tags.slice(0, 8); e.keywords = []; }
        };
        const deadIds = new Set();
        const closedIds = new Set();
        // v1.168：合并组 → 关联重挂映射（被并入悬念 id → 保留主条 id）
        const mergeTargets = [];
        // ① 合并（保留主条 id，uses 累加、标签/日期并集）
        if (Array.isArray(fd)) {
            for (const g of fd) {
                try {
                    if (!g || typeof g !== 'object') { out.skipped++; continue; }
                    const keepN = Number(String(g['保留'] !== undefined ? g['保留'] : g.keep).replace(/[^0-9]/g, ''));
                    const keep = byN.get(keepN);
                    if (!keep) { out.skipped++; continue; }
                    const mergeRaw = Array.isArray(g['并入']) ? g['并入'] : (Array.isArray(g.merge) ? g.merge : []);
                    const members = mergeRaw.map(x => byN.get(Number(String(x).replace(/[^0-9]/g, '')))).filter(Boolean).filter(m => m && m.id !== keep.id);
                    const ki = findIdx(keep.id);
                    if (ki < 0) { out.skipped++; continue; }
                    const primary = state.suspense[ki];
                    const nm = repairNormText(g['标题'] !== undefined ? g['标题'] : g.title).slice(0, 60);
                    const ct = dimCap('suspense', repairNormText(g['正文'] !== undefined ? g['正文'] : g.content));
                    const dt = clockDateTrim(repairNormText(g['日期'] !== undefined ? g['日期'] : g.date));
                    if (nm) primary.title = nm;
                    if (ct && !repairIsGarbage(ct, 4)) primary.content = ct;
                    if (/^-?\d{1,4}-\d{2}-\d{2}$/.test(dt)) primary.date = dt;
                    applyTags(primary, g['标签'] !== undefined ? g['标签'] : g.tags);
                    const tagSet = [];
                    const pushTags = (src) => { (Array.isArray(src) ? src : []).forEach(x => { const v = repairNormText(x).replace(/^#/, ''); if (v && tagSet.indexOf(v) < 0) tagSet.push(v); }); };
                    pushTags(primary.tags);
                    for (const m of members) {
                        const mi = findIdx(m.id);
                        if (mi < 0) continue;
                        const me = state.suspense[mi];
                        pushTags(me.tags);
                        primary.uses = (Number(primary.uses) || 0) + (Number(me.uses) || 0);
                        primary.importance = Math.max(Number(primary.importance) || 0, Number(me.importance) || 0);
                        const ds = [primary.date, me.date].filter(d => /^-?\d{1,4}-\d{2}-\d{2}$/.test(String(d || '')));
                        if (ds.length) primary.date = ds.slice().sort(dateStrCmp)[0];   // v1.193：按剧情日期数值取最早
                        deadIds.add(String(m.id));
                        // v1.168：记录「被并入 → 保留主条」，删除后用于关联重挂
                        if (primary.id && String(m.id) !== String(primary.id)) mergeTargets.push({ from: String(m.id), to: String(primary.id) });
                        out.removed++;
                    }
                    if (tagSet.length) primary.tags = tagSet.slice(0, 8);
                    out.fused++;
                } catch (e) { out.skipped++; }
            }
        }
        // ② 修订（字段闭集：标题/内容/日期/标签）
        if (Array.isArray(rv)) {
            for (const r of rv) {
                try {
                    if (!r || typeof r !== 'object') { out.skipped++; continue; }
                    const n = Number(String(r['编号'] !== undefined ? r['编号'] : r.n).replace(/[^0-9]/g, ''));
                    const en = byN.get(n);
                    if (!en) { out.skipped++; continue; }
                    const idx = findIdx(en.id);
                    if (idx < 0) { out.skipped++; continue; }
                    const e = state.suspense[idx];
                    const field = repairNormText(r['字段'] !== undefined ? r['字段'] : r.field);
                    const val = r['值'] !== undefined ? r['值'] : r.value;
                    if (!field) { out.skipped++; continue; }
                    if (field === '标签') { const before = JSON.stringify(e.tags || []); applyTags(e, val); if (JSON.stringify(e.tags || []) !== before) out.revised++; else out.skipped++; }
                    else if (field === '标题') { const v = repairNormText(val).slice(0, 60); if (v) { e.title = v; out.revised++; } else out.skipped++; }
                    else if (field === '内容') { const v = dimCap('suspense', repairNormText(val)); if (v && !repairIsGarbage(v, 4)) { e.content = v; out.revised++; } else out.skipped++; }
                    else if (field === '日期') { const v = clockDateTrim(repairNormText(val)); if (/^-?\d{1,4}-\d{2}-\d{2}$/.test(v)) { e.date = v; out.revised++; } else out.skipped++; }
                    else out.skipped++;
                } catch (e) { out.skipped++; }
            }
        }
        // ③ 了结（已被正文揭晓）/ ④ 删除（冗余占位）—— 都按编号，且都留墓碑（防跨端复活）
        const collect = (list, set) => {
            if (!Array.isArray(list)) return;
            for (const raw of list) {
                try {
                    const n = Number(String(raw).replace(/[^0-9]/g, ''));
                    const en = byN.get(n);
                    if (!en) { out.skipped++; continue; }
                    set.add(String(en.id));
                } catch (e) { out.skipped++; }
            }
        };
        collect(cl, closedIds);
        collect(dl, deadIds);
        const rm = (ids) => {
            if (!ids.size) return 0;
            try { tombMany('suspense', Array.from(ids)); } catch (e) { }
            const before = (state.suspense || []).length;
            state.suspense = (state.suspense || []).filter(x => !(x && ids.has(String(x.id))));
            return before - (state.suspense || []).length;
        };
        out.deleted = rm(deadIds);
        out.closed = rm(closedIds);
        // v1.168：关联重挂 —— 被并入悬念的关联行改挂保留主条（避免合并产生孤儿关联）
        try {
            const byTo = new Map();
            for (const p of mergeTargets) { if (!byTo.has(p.to)) byTo.set(p.to, []); byTo.get(p.to).push(p.from); }
            for (const [to, froms] of byTo) { try { retargetRelRefs('suspense', froms, to); } catch (e) { } }
            if (mergeTargets.length) out.retargeted = mergeTargets.length;
        } catch (e) { }
        if (out.closed) {
            state.stats = state.stats || { plansClosed: 0, suspenseResolved: 0 };
            state.stats.suspenseResolved = Number(state.stats.suspenseResolved || 0) + out.closed;
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 计划/悬念修复全链路（V1 `runPlanSuspRepair`）：
 *   空库 → `{made:0, skipped:true}`；`aiBusy()` → `{made:0, blocked:true}`；
 *   ① `suspenseMergeExact` 机械去重 → ①-b `relRepairMaint` 关联层机械维护 →
 *   ②③ `groupPick(GROUP_REPAIR_SPECS.suspense)` 聚类选组 → ④ 窄契约 AI →
 *   `applySuspenseMergeGroups`（悬念按编号）+ `applyPlanSuspMerge` + `mergeDelta`（计划了结）→ `saveState`。
 *   AI 判定无可了结/合并 → `{made:0, skipped:true, groups, checked, merged}`（如实上报，不虚报）。
 * V2 适配：互斥走 `aiBusy()`（等价 V1 的两道忙位判据）；AI 走 `aiCallText`；`opts.aiText` 为 V2 注入点；
 *   管线/渲染调用（`pipeStart`/`pipeUpdate`/`pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel`）未移植。
 * @param {object} [opts] aiText（V2 注入）
 * @returns {Promise<object>} V1 同形返回结构
 */
async function runPlanSuspRepair(opts) {
    const o = opts || {};
    try {
        const pOpen0 = (state.plans || []).filter(x => x && x.status === 'open');
        const sOpen0 = (state.suspense || []).filter(x => x && x.status === 'open');
        if (!pOpen0.length && !sOpen0.length) { notify('info', '计划/悬念修复：无可修复条目', '当前没有进行中的计划或未解悬念。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 都返回 blocked；
        //   V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        const beforeP = pOpen0.length, beforeS = sOpen0.length;
        const statsBefore = { pc: Number((state.stats && state.stats.plansClosed) || 0), sr: Number((state.stats && state.stats.suspenseResolved) || 0) };
        // ① 悬念机械去重（同内容，零 AI）
        const mech = suspenseMergeExact();
        // ①-b v1.168：关联层维护（零 AI）—— 与修复联动：**始终清理孤儿关联行** + 去重 / 角色名归一 /
        //   悬空引用清理 / how·偏差归一；孤儿条目按 relOrphanAction 处置（默认 keep 只提示）
        let relMaint = null;
        try { relMaint = relRepairMaint(); } catch (e) { }
        if (mech.merged > 0 || (relMaint && relMaint.changed)) saveState();
        try { logRelMaint('计划/悬念修复', relMaint); } catch (e) { }
        // ②③ 悬念标签组聚类 + 选组（轮询 + 上限）
        const spec = GROUP_REPAIR_SPECS.suspense;
        const pick = groupPick(spec);
        const plans = (state.plans || []).filter(x => x && x.status === 'open');
        if (!pick.entries.length && !plans.length) {
            const relTxt0 = relMaintSummary(relMaint);
            notify('info', '计划/悬念修复完成', `${mech.merged ? `已合并同内容悬念 ${mech.merged} 条；` : ''}未发现达到相关性阈值（${spec.cfgSim()}）的悬念组，且没有进行中的计划，无需 AI 处理。${relTxt0}`);
            try { dbgLog('摘要', { action: '计划/悬念修复：无高相关组', merged: mech.merged, relMaint: relMaintCounts(relMaint), plans: plans.length }); } catch (e) { }
            return { made: mech.merged, skipped: true, merged: mech.merged, groups: 0, before: beforeS, after: (state.suspense || []).length, relMaint: relMaintCounts(relMaint) };
        }
        // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 notifyHooks 只认 info/success/warning/error）
        notify('warning', '开始修复计划/悬念…', `进行中计划 ${plans.length} · 未解悬念 ${beforeS}${pick.entries.length ? ` · 高相关悬念组 ${pick.clusters.length}/${pick.total} 组（本次核对 ${pick.entries.length} 条${pick.defects ? ` · 其中缺陷条目 ${pick.defects}` : ''}）` : ' · 本次无高相关悬念组'}${mech.merged ? ` · 已机械去重 ${mech.merged} 条` : ''}`);
        const prompt = buildPlanSuspRepairPrompt(pick);
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '计划/悬念修复'));
        const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
        const sRes = applySuspenseMergeGroups(delta, pick);
        // 计划：只取 plans 段（了结 + 冗余合并）；悬念已由上面的编号应用处理，绝不再进 mergeDelta
        const plansDelta = { plans: delta.plans };
        const closePCnt = Array.isArray(delta.plans && delta.plans.close) ? delta.plans.close.length : 0;
        const mergeRes = applyPlanSuspMerge(plansDelta) || { mergedPlans: 0, mergedSusps: 0, removed: 0 };
        const changed = (sRes.fused || sRes.revised || sRes.closed || sRes.deleted || mergeRes.removed || closePCnt) ? 1 : 0;
        if (!changed) {
            notify('warning', '计划/悬念修复：无可了结/合并条目', `AI 判定本次核对的 ${pick.entries.length} 条悬念与 ${plans.length} 项计划均仍有效、无冗余重复（或未返回结果），未作改动。`);
            try { dbgLog('摘要', { action: '计划/悬念修复无改动', groups: pick.clusters.length, checked: pick.entries.length, plans: plans.length }); } catch (e) { }
            return { made: 0, skipped: true, groups: pick.clusters.length, checked: pick.entries.length, merged: mech.merged };
        }
        mergeDelta(plansDelta);
        saveState();
        const statsAfter = { pc: Number((state.stats && state.stats.plansClosed) || 0), sr: Number((state.stats && state.stats.suspenseResolved) || 0) };
        const closedP = Math.max(0, statsAfter.pc - statsBefore.pc);
        const parts = [];
        if (closedP) parts.push(`已了结计划 ${closedP} 项`);
        if (sRes.closed) parts.push(`已揭晓悬念 ${sRes.closed} 项`);
        if (sRes.fused) parts.push(`合并悬念 ${sRes.fused} 组（-${sRes.removed} 条）`);
        if (sRes.revised) parts.push(`修订悬念 ${sRes.revised} 条`);
        if (sRes.deleted) parts.push(`删除无效悬念 ${sRes.deleted} 条`);
        if (mergeRes.mergedPlans) parts.push(`合并计划 ${mergeRes.mergedPlans} 组`);
        if (mech.merged) parts.push(`机械去重 ${mech.merged} 条`);
        // v1.168：关联层机械维护结果（清理孤儿关联 / 去重 / 角色名归一 / 悬空引用 / 非法值归一）
        {
            const relTxt = relMaintSummary(relMaint);
            if (relTxt) parts.push(relTxt.replace(/^（关联维护：/, '关联维护：').replace(/）$/, ''));
        }
        notify('success', '计划/悬念修复完成', `${parts.join(' · ') || '无改动'}；进行中计划 ${(state.plans || []).filter(x => x && x.status === 'open').length} · 未解悬念 ${(state.suspense || []).filter(x => x && x.status === 'open').length}；${repairReport({ before: beforeS, after: (state.suspense || []).filter(x => x && x.status === 'open').length, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, defects: pick.defects, submittedTags: repairBatchTags(pick.entries), fused: sRes.fused, removed: sRes.removed, revised: sRes.revised, deleted: sRes.deleted, merged: mech.merged, skipped: sRes.skipped, extra: ('已了结计划 ' + closedP + ' 项 / 已揭晓悬念 ' + sRes.closed + ' 项') })}。`);
        try { dbgLog('摘要', { action: '计划/悬念修复完成（v1.140 悬念聚类核对）', closedP, closedS: sRes.closed, fusedS: sRes.fused, removedS: sRes.removed, revisedS: sRes.revised, deletedS: sRes.deleted, mergedP: mergeRes.mergedPlans, mechMerged: mech.merged, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, sim: spec.cfgSim() }); } catch (e) { }
        return { made: 1, closedP, closedS: sRes.closed, mergedP: mergeRes.mergedPlans, mergedS: sRes.fused, removedDup: mergeRes.removed + sRes.removed, revised: sRes.revised, deleted: sRes.deleted, merged: mech.merged, groups: pick.clusters.length, checked: pick.entries.length };
    } catch (e) {
        warn('计划/悬念修复失败', e);
        notify('error', '计划/悬念修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    suspenseMergeExact, buildPlanSuspRepairPrompt, applyPlanSuspMerge, applySuspenseMergeGroups, runPlanSuspRepair,
};
