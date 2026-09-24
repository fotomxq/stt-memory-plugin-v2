// ============================================================
// core/group-repair.js —— **相关组聚类修复基础设施 + 记忆修复管道**
//   （B8-6c-1，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js` / `07-原子层与数据归一化.js`）
//
// 定位：V1 v1.139/v1.140 把「概念 / 记忆 / 物品 / 悬念」四个域的数据修复统一到**同一套通用聚类引擎**上：
//   ① `groupRelatedness`：每条 = 与同域其它条目的最大相似度（标签 Jaccard；标签普遍不足 → 名称+正文 bigram）；
//   ② `groupClusters`：建图（边 = 相关度 ≥ 阈值；标签基准另需**共享 ≥2 标签**；记忆域附加**归属分区**约束）
//      → 并查集连通分量 + 相似度从高到低贪心加边 + **组规模上限**（防 A~B、B~C ⇒ A~B~C 链式误合）；
//   ③ `groupPick`：多轮按 `state.repairCursor[spec.cursorKey]` 轮询（每轮上限：组数 / 条数）；
//      客观缺陷条目另列一组；悬念域另有 `sampleSingles`（孤例轮询，「了结」判定不能只靠聚类）；
//   ④ 应用层：`memoryMergeExact`（零 AI 机械去重）/ `buildMemoryRepairPrompt`（窄契约提示词）/
//      `applyMemoryMergeGroups`（按编号精确应用，禁止新增、跨归属合并拒收）/ `runMemoryRepair`（六步编排）。
//
// 本批（B8-6c-1）交付：通用聚类引擎（含 concepts / memories / items / suspense **四域** spec）+ 记忆修复全链路。
//   概念 / 物品 / 悬念三域的**应用层**（conceptMergeExact / applyItemMergeGroups / runSuspenseRepair 等）属后续批次；
//   本批只交付它们的 spec（`groupPick` 的通用输入），`GROUP_REPAIR_SPECS.concepts/items/suspense` 因此完整可用。
//
// 适配（与 V1 的差异，逐条见 docs/P8r-B8-6c-1记忆聚类修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks）；
//   ② AI 调用改走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ 提示词模板取 `cfg.promptTemplates.*`，兜底 `defaultCfg.promptTemplates.*`（V1 同源）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）。
// 一致性由 tests/unit/group-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn } from './model/runtime.js';
import { repairNormText, repairKeyText, repairSimilarity, repairClampNum } from './ingest.js';
import { repairTagSetOf, repairJaccard, repairDefectOf, repairIsGarbage, repairNameKey, repairReport, repairBatchTags } from './repair.js';
import { dimCap, clockDateTrim } from './model/scalars.js';
import { dateStrCmp } from './clock.js';
import { tombMany } from './merge.js';
import { retargetRelRefs } from './entries.js';
import { relRepairMaint, relMaintSummary, relMaintCounts, logRelMaint, mergeRelMaint } from './rel-maint.js';
import { extractJsonObject, snapNameKey } from './util.js';
import { aiCallText, aiBusy } from './ai-hooks.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';

// ==================== 通用聚类引擎（V1 v1.140：概念 / 记忆 / 物品 / 悬念同一实现） ====================
// 设计（V1 原文口径）：
//   ① 相关度：每条 = 与同域其它条目的最大相似度（标签 Jaccard；标签普遍不足时退回名称+正文 bigram）；
//   ② 建图：边 = 相关度 ≥ `spec.cfgSim()`；标签基准下另需**共享 ≥2 个标签**（防单标签桥接串联）；
//      记忆域附加**归属分区**约束（`samePartition`）—— 不同归属角色的记忆绝不进同一组；
//   ③ 成组：并查集连通分量，相似度从高到低贪心加边 + **组规模上限**（超限连接丢弃，防 A~B、B~C ⇒ A~B~C 链式误合）；
//   ④ 选组：多轮按 `state.repairCursor[spec.cursorKey]` 轮询（每轮上限：组数/条数）；客观缺陷条目另列一组。
// 应用层（字段闭集与合并语义）由各维度自己的 apply* 负责 ——
//   概念：名称/内容/来源/日期/标签；记忆：标题/正文/日期/分类/标签（归属不变、uses/楼层并集）；悬念：标题/正文/日期/标签 +「了结」。
const GROUP_REPAIR_SPECS = {
    concepts: {
        label: '概念', cursorKey: 'concepts',
        list: function () { return state.concepts || []; },
        textOf: function (e) { return repairNormText(`${(e && e.name) || ''} ${(e && e.content) || ''}`); },
        samePartition: function () { return true; },
        entryOf: function (e, i, meta) {
            return {
                n: meta.n, group: meta.group, idx: i, id: e.id, name: repairNormText(e.name),
                content: repairNormText(e.content), source: repairNormText(e.source), date: repairNormText(e.date),
                tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [], sim: meta.sim, defect: meta.defect, single: meta.single,
            };
        },
        cfgSim: function () { return repairClampNum(cfg && cfg.conceptRepairSim, 0.1, 0.95, 0.45); },
        cfgMaxClusters: function () { return Math.max(1, Number(cfg && cfg.conceptRepairMaxClusters) || 3); },
        cfgMaxItems: function () { return Math.max(2, Number(cfg && cfg.conceptRepairMaxItems) || 24); },
        cfgMaxSize: function () { return Math.max(2, Math.min(40, Number(cfg && cfg.conceptRepairMaxClusterSize) || 8)); },
        defectOf: function (e) { return repairDefectOf('concepts', e); },
    },
    memories: {
        label: '记忆', cursorKey: 'memories',
        list: function () { return state.memories || []; },
        textOf: function (e) { return repairNormText(`${(e && e.title) || ''} ${(e && e.content) || ''}`); },
        samePartition: function (a, b) { return snapNameKey(a && a.owner) === snapNameKey(b && b.owner); },
        entryOf: function (e, i, meta) {
            return {
                n: meta.n, group: meta.group, idx: i, id: e.id, owner: repairNormText(e.owner),
                title: repairNormText(e.title), content: repairNormText(e.content), date: repairNormText(e.date),
                category: repairNormText(e.memCategory || e.category), tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
                sim: meta.sim, defect: meta.defect,
            };
        },
        cfgSim: function () { return repairClampNum(cfg && cfg.memoryRepairSim, 0.1, 0.95, 0.45); },
        cfgMaxClusters: function () { return Math.max(1, Number(cfg && cfg.memoryRepairMaxClusters) || 3); },
        cfgMaxItems: function () { return Math.max(2, Number(cfg && cfg.memoryRepairMaxItems) || 24); },
        cfgMaxSize: function () { return Math.max(2, Math.min(40, Number(cfg && cfg.memoryRepairMaxClusterSize) || 8)); },
        defectsAlways: true,   // 记忆：即使没有相关组，客观缺陷（超字数/模糊措辞/标签不合规/日期格式）也单独送修（有界）
        defectOf: function (e) { return repairDefectOf('memories', e); },
    },
    items: {
        label: '物品', cursorKey: 'items',
        list: function () { return state.items || []; },
        textOf: function (e) { return repairNormText(`${(e && e.name) || ''} ${(e && e.desc) || ''}`); },
        nameOf: function (e) { return repairNormText(e && e.name); },
        samePartition: function () { return true; },
        // v1.142：相关度 = max(标签组 Jaccard, 名称相似度) —— 用户要求「利用标签、名称的相关性排名」
        scoreOf: function (a, b, ctx) {
            const tagJ = repairJaccard(ctx.tagSets[ctx.i], ctx.tagSets[ctx.j]);
            const nameS = itemNameSim(a && a.name, b && b.name);
            return Math.max(tagJ, nameS);
        },
        // 成边条件：相关度 ≥ 阈值之外，还需「共享 ≥2 标签」或「名称相似度 ≥ 0.5」（否则单标签桥接会把无关物品串成团）
        edgeOk: function (a, b, ctx) {
            const sh = ctx.sharedCount(ctx.tagSets[ctx.i], ctx.tagSets[ctx.j]);
            const nameS = itemNameSim(a && a.name, b && b.name);
            return sh >= 2 || nameS >= 0.5;
        },
        entryOf: function (e, i, meta) {
            return {
                n: meta.n, group: meta.group, idx: i, id: e.id, name: repairNormText(e.name),
                desc: repairNormText(e.desc), qty: (e.qty === undefined || e.qty === null) ? null : Number(e.qty),
                location: repairNormText(e.location), carried: !!e.carried, uses: Number(e.uses) || 0,
                tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [], sim: meta.sim, defect: meta.defect, single: meta.single,
            };
        },
        cfgSim: function () { return repairClampNum(cfg && cfg.itemRepairSim, 0.1, 0.95, 0.45); },
        cfgMaxClusters: function () { return Math.max(1, Number(cfg && cfg.itemRepairMaxClusters) || 3); },
        cfgMaxItems: function () { return Math.max(2, Number(cfg && cfg.itemRepairMaxItems) || 24); },
        cfgMaxSize: function () { return Math.max(2, Math.min(40, Number(cfg && cfg.itemRepairMaxClusterSize) || 8)); },
        // 物品的 taggable=true → 「标签数量不合规（<3 个）」会被判为客观缺陷：无相关组时也送修，用于补齐标签
        defectsAlways: true,
        defectOf: function (e) { return repairDefectOf('items', e); },
    },
    suspense: {
        label: '悬念', cursorKey: 'suspense',
        list: function () { return (state.suspense || []).filter(x => x && x.status === 'open'); },
        textOf: function (e) { return repairNormText(`${(e && e.title) || ''} ${(e && e.content) || ''}`); },
        samePartition: function () { return true; },
        entryOf: function (e, i, meta) {
            return {
                n: meta.n, group: meta.group, idx: i, id: e.id, title: repairNormText(e.title),
                content: repairNormText(e.content), date: repairNormText(e.date),
                tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [], sim: meta.sim, defect: meta.defect, single: meta.single,
            };
        },
        cfgSim: function () { return repairClampNum(cfg && cfg.suspenseRepairSim, 0.1, 0.95, 0.45); },
        cfgMaxClusters: function () { return Math.max(1, Number(cfg && cfg.suspenseRepairMaxClusters) || 3); },
        cfgMaxItems: function () { return Math.max(2, Number(cfg && cfg.suspenseRepairMaxItems) || 24); },
        cfgMaxSize: function () { return Math.max(2, Math.min(40, Number(cfg && cfg.suspenseRepairMaxClusterSize) || 8)); },
        defectsAlways: true,   // 悬念：缺陷条目同样单独送修
        sampleSingles: true,   // 悬念有「了结」生命周期：孤例也要轮询进批次做 了结 判定（记忆无此需要）
        defectOf: function (e) { return repairDefectOf('suspense', e); },
    },
};
/** 按域取 spec（V1 `groupRepairSpec`；未知域名回退 concepts —— V1 原样） */
function groupRepairSpec(dimKey) { return GROUP_REPAIR_SPECS[dimKey] || GROUP_REPAIR_SPECS.concepts; }

/** 物品规范名（V1 `itemBaseNameKey`）：去掉末尾括号说明（（…）(…)【…】）与空白后的名称 —— 「怀表」「银色怀表（旧）」归为同一件 */
function itemBaseNameKey(name) {
    try { return repairNormText(name).replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/\s+/g, '').toLowerCase(); } catch (e) { return ''; }
}
/** 物品名称相似度（0-1，V1 `itemNameSim`）：完全同名 = 1；一方包含另一方按长度比给分（「钥匙」/「铜钥匙」=0.7）；
 *  否则退回 bigram 相似度（注意 repairSimilarity 对 <4 字名称会返回 0，故前两级是必要的） */
function itemNameSim(a, b) {
    try {
        const na = itemBaseNameKey(a), nb = itemBaseNameKey(b);
        if (!na || !nb) return 0;
        if (na === nb) return 1;
        if (na.length >= 2 && nb.length >= 2 && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0)) {
            const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
            return ratio >= 0.5 ? 0.7 : 0.45;
        }
        return repairSimilarity(na, nb);
    } catch (e) { return 0; }
}

/** 相关度（V1 `groupRelatedness`）：每条 = 与同域其它条目的最大相似度（标签 Jaccard；标签普遍不足 → 名称+正文 bigram） */
function groupRelatedness(spec) {
    const arr = (spec && spec.list()) || [];
    const n = arr.length;
    const tagSets = arr.map(e => repairTagSetOf(e));
    const texts = arr.map(e => spec.textOf(e));
    const sharedCount = (a, b) => { let k = 0; for (const x of a) if (b.indexOf(x) >= 0) k++; return k; };
    const tagRich = tagSets.filter(s => s.length >= 2).length >= Math.max(2, Math.floor(n * 0.3));
    const sims = new Array(n).fill(0);
    const basis = new Array(n).fill(tagRich ? 'tags' : 'text');
    for (let i = 0; i < n; i++) {
        const useTags = tagRich && tagSets[i].length >= 2;
        let best = 0;
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            // v1.142：spec.scoreOf 可自定义该维度的「相关度」口径（如物品 = 标签组 Jaccard 与 名称相似度 取最大）
            const v = spec.scoreOf
                ? (Number(spec.scoreOf(arr[i], arr[j], { i, j, tagSets, texts, sharedCount })) || 0)
                : (useTags ? repairJaccard(tagSets[i], tagSets[j]) : repairSimilarity(texts[i], texts[j]));
            if (v > best) best = v;
        }
        sims[i] = Number(best.toFixed(3));
        basis[i] = useTags ? 'tags' : 'text';
    }
    return { sims, basis, tagRich };
}

/** 相关组（连通分量，V1 `groupClusters`）：边 = 相关度 ≥ 阈值（标签基准需共享 ≥2 标签、且需同分区）；
 *  只返回 ≥2 条的组，按（条数 → 组内最大相关度）降序 */
function groupClusters(spec) {
    try {
        const arr = (spec && spec.list()) || [];
        const n = arr.length;
        if (n < 2) return [];
        const thr = spec.cfgSim();
        const maxSize = spec.cfgMaxSize();
        const rel = groupRelatedness(spec);
        const tagSets = arr.map(e => repairTagSetOf(e));
        const texts = arr.map(e => spec.textOf(e));
        const samePart = spec.samePartition || function () { return true; };
        const sharedCount = (a, b) => { let k = 0; for (const x of a) if (b.indexOf(x) >= 0) k++; return k; };
        const edges = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (!samePart(arr[i], arr[j])) continue;
                let v = 0;
                let okEdge = true;
                if (spec.scoreOf) {
                    // v1.142：自定义口径（物品 = max(标签 Jaccard, 名称相似度)）；成边另受 spec.edgeOk 约束
                    v = Number(spec.scoreOf(arr[i], arr[j], { i, j, tagSets, texts, sharedCount })) || 0;
                    if (spec.edgeOk) okEdge = !!spec.edgeOk(arr[i], arr[j], { i, j, tagSets, texts, sharedCount, score: v });
                } else {
                    const useTags = rel.basis[i] === 'tags' && rel.basis[j] === 'tags';
                    if (useTags) {
                        const sh = sharedCount(tagSets[i], tagSets[j]);
                        if (sh < 2) continue;                   // 只共享 1 个标签 → 不足以判定同一词条
                        v = repairJaccard(tagSets[i], tagSets[j]);
                    } else {
                        v = repairSimilarity(texts[i], texts[j]);
                    }
                }
                if (okEdge && v >= thr) edges.push({ i, j, v });
            }
        }
        edges.sort((a, b) => b.v - a.v);
        const parent = new Array(n).fill(0).map((_, i) => i);
        const size = new Array(n).fill(1);
        const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; } return r; };
        const union = (a, b) => {
            const ra = find(a), rb = find(b);
            if (ra === rb) return true;
            if (size[ra] + size[rb] > maxSize) return false;    // 超过组规模上限 → 丢弃该连接（防串联）
            parent[rb] = ra; size[ra] += size[rb];
            return true;
        };
        for (const e of edges) union(e.i, e.j);
        const groups = new Map();
        for (let i = 0; i < n; i++) {
            const r = find(i);
            if (!groups.has(r)) groups.set(r, []);
            groups.get(r).push(i);
        }
        const out = [];
        for (const idxs of groups.values()) {
            if (idxs.length < 2) continue;
            let maxSim = 0;
            for (const i of idxs) maxSim = Math.max(maxSim, rel.sims[i]);
            out.push({ idxs, size: idxs.length, maxSim: Number(maxSim.toFixed(3)), basis: rel.basis[idxs[0]] });
        }
        out.sort((a, b) => (b.size - a.size) || (b.maxSim - a.maxSim));
        return out;
    } catch (e) { return []; }
}

/** 选组（轮询 + 上限，V1 `groupPick`）：返回 { entries, clusters, picked, defects, singles, total, cursor }
 *  注意 total 口径与 v1.139 一致：有组时 = 相关组数；无组时 = 同域条目数（供提示词/日志用） */
function groupPick(spec) {
    try {
        const arr = (spec && spec.list()) || [];
        const all = groupClusters(spec);
        const maxClusters = spec.cfgMaxClusters();
        const maxItems = spec.cfgMaxItems();
        const cur = all.length ? (Math.abs(Number(state.repairCursor && state.repairCursor[spec.cursorKey]) || 0) % all.length) : 0;
        const picked = [];
        let count = 0;
        for (let k = 0; k < all.length && picked.length < maxClusters; k++) {
            const c = all[(cur + k) % all.length];
            if (count + c.idxs.length > maxItems && picked.length) continue;
            picked.push(c);
            count += c.idxs.length;
            if (count >= maxItems) break;
        }
        const entries = [];
        const rel = groupRelatedness(spec);
        picked.forEach((c, ci) => {
            c.idxs.forEach((i) => {
                const e = arr[i];
                if (!e) return;
                entries.push(spec.entryOf(e, i, { n: entries.length + 1, group: ci + 1, sim: Number(rel.sims[i]) || 0 }));
            });
        });
        // 客观缺陷条目（空占位/超字数/模糊措辞/标签数量不合规/日期格式）—— 与相关性无关，单列「缺陷条目」组。
        //   是否在「无相关组」时也附带，按 spec.defectsAlways 决定：
        //   概念保持 v1.139 语义（无相关组 → 零 AI）；记忆/悬念 defectsAlways=true（缺陷本身值得单独送修，条数有界）。
        const inBatch = new Set(entries.map(e => String(e.id)));
        let defectN = 0;
        for (let i = 0; spec && (spec.defectsAlways || all.length) && i < arr.length && entries.length < maxItems; i++) {
            const e = arr[i];
            if (!e || inBatch.has(String(e.id))) continue;
            const df = spec.defectOf(e);
            if (!df) continue;
            entries.push(spec.entryOf(e, i, { n: entries.length + 1, group: picked.length + 1, sim: Number(rel.sims[i]) || 0, defect: df.label }));
            defectN++;
        }
        // ④（可选）逐一抽查：没有相关组的孤例也需要核对（悬念的「了结」判定不能只靠聚类，否则孤例永远不会被了结）——
        //   按独立游标 state.repairCursor[<dim>Ring] 轮询抽取，每轮不同、多轮覆盖全库，条数受同一 items 上限约束。
        let singleN = 0;
        if (spec.sampleSingles && entries.length < maxItems) {
            const taken = new Set(entries.map(e => String(e.id)));
            const pool = [];
            for (let i = 0; i < arr.length; i++) { const e = arr[i]; if (e && !taken.has(String(e.id))) pool.push(i); }
            if (pool.length) {
                const ck = spec.cursorKey + 'Ring';
                const start = Math.abs(Number(state.repairCursor && state.repairCursor[ck]) || 0) % pool.length;
                const budget = maxItems - entries.length;
                for (let k = 0; k < pool.length && singleN < budget; k++) {
                    const i = pool[(start + k) % pool.length];
                    entries.push(spec.entryOf(arr[i], i, { n: entries.length + 1, group: picked.length + 2, sim: Number(rel.sims[i]) || 0, single: true }));
                    singleN++;
                }
                try { state.repairCursor = Object.assign({}, state.repairCursor || {}, { [ck]: (start + singleN) % pool.length }); } catch (e) { }
            }
        }
        try { state.repairCursor = Object.assign({}, state.repairCursor || {}, { [spec.cursorKey]: all.length ? (cur + picked.length) % all.length : 0 }); } catch (e) { }
        return { entries, clusters: picked, picked: picked.length, defects: defectN, singles: singleN, total: all.length, cursor: cur };
    } catch (e) { return { entries: [], clusters: [], picked: 0, defects: 0, singles: 0, total: 0, cursor: 0 }; }
}

// ==================== 记忆修复（V1 v1.140：标签组聚类 → 打包高相关组交 AI 梳理/合并/修正） ====================
// 用户要求：记忆的「修改」功能改用与概念同款策略 —— 先在本地梳理、结合**标签组**找出高度相关的词条，
//   再把这些词条**打包成组**发给 AI 做梳理/合并/修正。
// 旧实现（v1.95~v1.139）：把**整库记忆清单**（编号 #0 起）发给 AI 并要求回传「记忆库.融合」——
//   库大时输入输出都大、AI 难免漏项；跨归属角色是否误合只靠提示词约束。
// 新实现四步（前两步零 AI，只有存在高相关组才发 AI）：
//   ① 机械去重：**同一归属内**「同正文哈希」与「同标题（标题 ≥4 字）」的记忆先并成一条
//      （保留首个 id、uses 累加、标签/楼层并集、正文取更长、日期取最早、重要度取大）；
//   ② 标签组聚类：相关度 = 标签 Jaccard（某条标签不足 → 退回「标题 + 正文」bigram 相似度），
//      边 ≥ `cfg.memoryRepairSim`（默认 0.45）即连成一组；**归属分区**：不同归属角色的记忆**绝不连边**
//      （比旧提示词的软约束更硬，杜绝跨角色误合并）；防串联规则同通用引擎（共享 ≥2 标签 + 组规模上限）；
//   ③ 选组轮询：`state.repairCursor.memories` 推进，每轮 ≤ `memoryRepairMaxClusters` 组 /
//      ≤ `memoryRepairMaxItems` 条；客观缺陷条目（空占位/超字数/标签不合规…）另列一组；
//   ④ 窄契约 AI：只发这些组，要求返回
//      `{"合并":[{"保留":n,"并入":[m…],"标题":…,"正文":…,"日期":…,"分类":…,"标签":[…]}],
//        "修订":[{"编号":n,"字段":…,"值":…}],"删除":[n…]}` —— **禁止新增**；JS 按编号精确应用
//      （编号只在本批清单内有效；跨归属的合并一律拒收）。

/** 记忆归属键（V1 `memoryOwnerKey`）：空归属统一归「通用」，避免空串与缺失被判成两个分区 */
function memoryOwnerKey(e) { return snapNameKey(e && e.owner) || '通用'; }

/** 用户提示（经宿主钩子；与 core/repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/** ① 机械去重（零 AI，V1 `memoryMergeExact`）：同归属内 同正文 / 同标题（标题 ≥4 字）
 *  合并语义：保留首个 id、uses 累加、楼层并集、重要度取大、日期取最早、正文取更长、标签并集（≤8）
 *  v1.168：合并同时把被并入条目的关联行**重挂**到保留条目（`retargetRelRefs`，关联不丢也不留孤儿行）。
 *  注意：本函数**不写墓碑**（V1 原样 —— 与 repairMergeDedupe 的机械合并口径不同）。 */
function memoryMergeExact() {
    const st = { merged: 0, notes: [] };
    try {
        const arr = state.memories || [];
        if (arr.length < 2) return st;
        const pickBest = (a, b) => {
            const ac = String(a.content || ''), bc = String(b.content || '');
            return bc.length > ac.length ? b : a;
        };
        const unionInto = (keep, drop) => {
            const tags = [];
            for (const x of (Array.isArray(keep.tags) ? keep.tags : []).concat(Array.isArray(drop.tags) ? drop.tags : [])) {
                const v = repairNormText(x).replace(/^#/, '');
                if (v && tags.indexOf(v) < 0) tags.push(v);
            }
            keep.tags = tags.slice(0, 8);
            keep.uses = (Number(keep.uses) || 0) + (Number(drop.uses) || 0);
            const fs0 = Number(keep.floorStart) || 0, fs1 = Number(drop.floorStart) || 0;
            keep.floorStart = (fs0 && fs1) ? Math.min(fs0, fs1) : (fs0 || fs1);
            keep.floorEnd = Math.max(Number(keep.floorEnd) || 0, Number(drop.floorEnd) || 0);
            keep.importance = Math.max(Number(keep.importance) || 0, Number(drop.importance) || 0);
            const ds = [keep.date, drop.date].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')));
            if (ds.length) keep.date = ds.sort()[0];
        };
        // ①a 同归属 + 同正文哈希
        const byHash = new Map();
        const pass1 = [];
        // v1.168：合并 → 关联行重挂（被并入条目的关联挂到保留条目；同角色取更可靠方式）
        const mergePairs = [];
        for (const m of arr) {
            if (!m || typeof m !== 'object') { pass1.push(m); continue; }
            const h = memoryOwnerKey(m) + '|' + repairKeyText(m.content);
            if (!repairKeyText(m.content)) { pass1.push(m); continue; }
            const hit = byHash.get(h);
            if (hit === undefined) { byHash.set(h, pass1.length); pass1.push(m); continue; }
            const keep = pass1[hit];
            if (m.id && keep.id && String(m.id) !== String(keep.id)) mergePairs.push({ from: String(m.id), to: String(keep.id) });
            unionInto(keep, m);
            const best = pickBest(keep, m);
            if (best !== keep) { best.id = keep.id; pass1[hit] = best; }
            st.merged++;
        }
        // ①b 同归属 + 同标题（标题 ≥4 字，避免「事件」这类泛标题误合）
        const byTitle = new Map();
        const pass2 = [];
        for (const m of pass1) {
            if (!m || typeof m !== 'object') { pass2.push(m); continue; }
            const tk = repairNameKey(m.title);
            if (!tk || tk.length < 4) { pass2.push(m); continue; }
            const h = memoryOwnerKey(m) + '|' + tk;
            const hit = byTitle.get(h);
            if (hit === undefined) { byTitle.set(h, pass2.length); pass2.push(m); continue; }
            const keep = pass2[hit];
            if (m.id && keep.id && String(m.id) !== String(keep.id)) mergePairs.push({ from: String(m.id), to: String(keep.id) });
            unionInto(keep, m);
            const best = pickBest(keep, m);
            if (best !== keep) { best.id = keep.id; pass2[hit] = best; }
            st.merged++;
        }
        if (st.merged > 0) {
            state.memories = pass2;
            st.notes.push('同归属重复');
            // v1.168：把被并入条目的关联重挂到保留条目（合并后关联不丢、也不留孤儿行）
            try {
                const byTo = new Map();
                for (const p of mergePairs) { if (!byTo.has(p.to)) byTo.set(p.to, []); byTo.get(p.to).push(p.from); }
                for (const [to, froms] of byTo) { try { retargetRelRefs('memories', froms, to); } catch (e) { } }
                st.retargeted = mergePairs.length;
            } catch (e) { }
        }
    } catch (e) { }
    return st;
}

/** ③ 窄契约提示词（V1 `buildMemoryRepairPrompt`）：只发选中的高相关组；不含全库。
 *  模板取 `cfg.promptTemplates.memoryRepair` → 兜底 `defaultCfg.promptTemplates.memoryRepair` → 兜底内置一句话。 */
function buildMemoryRepairPrompt(pick) {
    const p = pick || groupPick(GROUP_REPAIR_SPECS.memories);
    if (!p.entries.length) return null;
    const tpl = String((cfg.promptTemplates && cfg.promptTemplates.memoryRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.memoryRepair) || '').trim()
        || '把同组内记录同一件事的记忆合并为一条；输出 合并/修订/删除（禁止新增）。';
    const lines = [];
    let lastGroup = 0;
    for (const e of p.entries) {
        if (e.group !== lastGroup) { lines.push(e.defect ? '【缺陷条目（与相关性无关，不参与合并，可修订或删除）】' : `【相关组 ${e.group}】`); lastGroup = e.group; }
        lines.push(`#${e.n} ｜ 归属：${e.owner || '通用'} ｜ 标题：${e.title || '（无）'} ｜ 相关度：${Number(e.sim).toFixed(2)} ｜ 分类：${e.category || '一般'} ｜ 标签：${(e.tags || []).join('/') || '（无）'} ｜ 日期：${e.date || '（无）'}${e.defect ? ` ｜ 问题：${e.defect}` : ''}\n   正文：${String(e.content).slice(0, 300)}`);
    }
    return [
        { role: 'system', content: `${tpl}\n只输出 JSON，不要解释。` },
        { role: 'user', content: `【待核对记忆组（本次唯一工作对象，共 ${p.picked} 组 / ${p.entries.length} 条；同组条目「归属 + 标签组」相关性较高，可能记录同一件事，也可能只是相关 —— **不同归属角色的记忆不会出现在同一组，也不要把不同归属的条目合并**）】\n${lines.join('\n')}\n\n输出：{"合并":[{"保留":1,"并入":[2,3],"标题":"…","正文":"…","日期":"YYYY-MM-DD","分类":"…","标签":["…"]}],"修订":[{"编号":4,"字段":"正文","值":"…"}],"删除":[5]}（只输出需要改动的编号；无改动就输出空数组）。` },
    ];
}

/** ④ 按编号精确应用（V1 `applyMemoryMergeGroups`）：合并 / 修订 / 删除；**禁止新增**；跨归属合并拒收。
 *  - 合并：保留主条 id 与归属；标题/正文/日期/分类由 AI 给出则采用（正文走 `dimCap`、日期走 `clockDateTrim`）；
 *    uses 累加、楼层并集（start min / end max）、重要度取大、日期取最早（`dateStrCmp`）、标签并集（≤8）；
 *    被并入条目删除 + 写墓碑，并把其关联行**重挂**保留主条（`retargetRelRefs`），返回 `retargeted` 计数。
 *  - 修订：字段闭集 标题 / 正文 / 日期 / 分类 / 标签（归属不可改）。
 *  - 删除：命中编号 → 收进 deadIds 统一写墓碑 + 移除。 */
function applyMemoryMergeGroups(delta, pick) {
    const out = { fused: 0, revised: 0, deleted: 0, removed: 0, skipped: 0, retargeted: 0 };
    try {
        const entries = (pick && pick.entries) || [];
        if (!delta || typeof delta !== 'object' || !entries.length) return out;
        const byN = new Map();
        entries.forEach(e => byN.set(Number(e.n), e));
        const ops = (delta['记忆库'] !== undefined && delta['记忆库'] && typeof delta['记忆库'] === 'object') ? delta['记忆库'] : delta;
        const fd = (ops['合并'] !== undefined) ? ops['合并'] : ops.merge;
        const rv = (ops['修订'] !== undefined) ? ops['修订'] : ops.revise;
        const dl = (ops['删除'] !== undefined) ? ops['删除'] : ops.remove;
        const findIdx = (id) => (state.memories || []).findIndex(x => x && String(x.id) === String(id));

        const applyTags = (e, arr) => {
            const tags = (Array.isArray(arr) ? arr : String(arr || '').split(/[，,、#\s]+/)).map(x => repairNormText(x).replace(/^#/, '')).filter(Boolean);
            if (tags.length >= 3 && tags.length <= 8) { e.tags = tags.slice(0, 8); e.keywords = []; }
        };
        const deadIds = new Set();
        // v1.168：合并组 → 关联重挂映射（被并入条目 id → 保留主条 id）
        const mergeTargets = [];
        // ① 合并（同一归属内；保留主条 id/归属，uses 累加、标签/楼层并集）
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
                    const primary = state.memories[ki];
                    // 跨归属合并一律拒收（归属分区是硬约束）
                    if (members.some(m => snapNameKey(m.owner) !== snapNameKey(keep.owner))) { out.skipped++; continue; }
                    const nm = repairNormText(g['标题'] !== undefined ? g['标题'] : g.title).slice(0, 60);
                    const ct = dimCap('memories', repairNormText(g['正文'] !== undefined ? g['正文'] : g.content));
                    const dt = clockDateTrim(repairNormText(g['日期'] !== undefined ? g['日期'] : g.date));
                    const cat = repairNormText(g['分类'] !== undefined ? g['分类'] : g.category).slice(0, 20);
                    if (nm) primary.title = nm;
                    if (ct && !repairIsGarbage(ct, 4)) primary.content = ct;
                    if (/^-?\d{1,4}-\d{2}-\d{2}$/.test(dt)) primary.date = dt;
                    if (cat) primary.memCategory = cat;
                    applyTags(primary, g['标签'] !== undefined ? g['标签'] : g.tags);
                    const tagSet = [];
                    const pushTags = (src) => { (Array.isArray(src) ? src : []).forEach(x => { const v = repairNormText(x).replace(/^#/, ''); if (v && tagSet.indexOf(v) < 0) tagSet.push(v); }); };
                    pushTags(primary.tags);
                    for (const m of members) {
                        const mi = findIdx(m.id);
                        if (mi < 0) continue;
                        const me = state.memories[mi];
                        pushTags(me.tags);
                        primary.uses = (Number(primary.uses) || 0) + (Number(me.uses) || 0);
                        const fs0 = Number(primary.floorStart) || 0, fs1 = Number(me.floorStart) || 0;
                        primary.floorStart = (fs0 && fs1) ? Math.min(fs0, fs1) : (fs0 || fs1);
                        primary.floorEnd = Math.max(Number(primary.floorEnd) || 0, Number(me.floorEnd) || 0);
                        primary.importance = Math.max(Number(primary.importance) || 0, Number(me.importance) || 0);
                        const ds = [primary.date, me.date].filter(d => /^-?\d{1,4}-\d{2}-\d{2}$/.test(String(d || '')));
                        if (ds.length) primary.date = ds.slice().sort(dateStrCmp)[0];   // v1.193：按剧情日期数值取最早
                        deadIds.add(String(m.id));
                        // v1.168：记录「被并入 → 保留主条」，删除后用于关联重挂（合并后不产生孤儿关联）
                        if (primary.id && String(m.id) !== String(primary.id)) mergeTargets.push({ from: String(m.id), to: String(primary.id) });
                        out.removed++;
                    }
                    if (tagSet.length) primary.tags = tagSet.slice(0, 8);
                    out.fused++;
                } catch (e) { out.skipped++; }
            }
        }
        // ② 修订（字段闭集：标题/正文/日期/分类/标签；归属不可改）
        if (Array.isArray(rv)) {
            for (const r of rv) {
                try {
                    if (!r || typeof r !== 'object') { out.skipped++; continue; }
                    const n = Number(String(r['编号'] !== undefined ? r['编号'] : r.n).replace(/[^0-9]/g, ''));
                    const en = byN.get(n);
                    if (!en) { out.skipped++; continue; }
                    const idx = findIdx(en.id);
                    if (idx < 0) { out.skipped++; continue; }
                    const e = state.memories[idx];
                    const field = repairNormText(r['字段'] !== undefined ? r['字段'] : r.field);
                    const val = r['值'] !== undefined ? r['值'] : r.value;
                    if (!field) { out.skipped++; continue; }
                    if (field === '标签') { const before = JSON.stringify(e.tags || []); applyTags(e, val); if (JSON.stringify(e.tags || []) !== before) out.revised++; else out.skipped++; }
                    else if (field === '标题') { const v = repairNormText(val).slice(0, 60); if (v) { e.title = v; out.revised++; } else out.skipped++; }
                    else if (field === '正文') { const v = dimCap('memories', repairNormText(val)); if (v && !repairIsGarbage(v, 4)) { e.content = v; out.revised++; } else out.skipped++; }
                    else if (field === '日期') { const v = clockDateTrim(repairNormText(val)); if (/^-?\d{1,4}-\d{2}-\d{2}$/.test(v)) { e.date = v; out.revised++; } else out.skipped++; }
                    else if (field === '分类') { const v = repairNormText(val).slice(0, 20); if (v) { e.memCategory = v; out.revised++; } else out.skipped++; }
                    else out.skipped++;
                } catch (e) { out.skipped++; }
            }
        }
        // ③ 删除
        if (Array.isArray(dl)) {
            for (const raw of dl) {
                try {
                    const n = Number(String(raw).replace(/[^0-9]/g, ''));
                    const en = byN.get(n);
                    if (!en) { out.skipped++; continue; }
                    deadIds.add(String(en.id));
                } catch (e) { out.skipped++; }
            }
        }
        if (deadIds.size) {
            try { tombMany('memories', Array.from(deadIds)); } catch (e) { }
            const before = (state.memories || []).length;
            state.memories = (state.memories || []).filter(x => !(x && deadIds.has(String(x.id))));
            out.deleted = before - (state.memories || []).length;
            // v1.168：关联重挂 —— 被并入条目的关联行改挂保留主条（同角色取更可靠方式），避免合并产生孤儿关联
            try {
                const byTo = new Map();
                for (const p of mergeTargets) { if (!byTo.has(p.to)) byTo.set(p.to, []); byTo.get(p.to).push(p.from); }
                for (const [to, froms] of byTo) { try { retargetRelRefs('memories', froms, to); } catch (e) { } }
                if (mergeTargets.length) out.retargeted = mergeTargets.length;
            } catch (e) { }
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 记忆修复全链路（V1 `runMemoryRepair`，六步）：
 *   ① `memoryMergeExact` 机械去重（零 AI，含关联重挂）→ ①-b `relRepairMaint` 关系层机械维护（零 AI，前）
 *   → ②③ `groupPick` 聚类选组 → ④ `buildMemoryRepairPrompt` + AI → ⑤ `applyMemoryMergeGroups` 精确应用
 *   → ⑥ 再跑一次 `relRepairMaint` 并以 `mergeRelMaint` 合并两次口径（AI 合并/删除可能产生新的孤儿行与悬空引用）。
 * V2 适配：互斥走 `aiBusy()`（等价 V1 `busy.repair` + 摘要/压缩/推演/推进/同步占用）；AI 走 `aiCallText`；
 *   V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植（V2 无任务管线 UI，重绘由 UI 层负责）；
 *   `opts.aiText` 为 V2 注入点（显式指定 AI 返回，测试用；缺省走 `aiCallText`）。
 * @param {object} [opts] aiText（V2 注入）/ silent
 * @returns {Promise<object>} V1 同形返回结构（made / before / after / fused / removed / revised / deleted / skipped / merged / retargeted / relMaint / groups / groupsTotal / checked）
 */
async function runMemoryRepair(opts) {
    const o = opts || {};
    try {
        let list = state.memories || [];
        if (!list.length) { notify('info', '记忆修复：暂无记忆', '请先通过「AI 摘要」生成长期记忆或手动添加后再修复。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair`（本管道在途）与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()`（他管道在途）
        //   都返回 `{made:0, blocked:true}`；V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        const t0 = Date.now();
        {
            const beforeCount = list.length;
            // ① JS 机械去重（同归属内 同正文/同标题）—— 零 AI（合并同时把关联重挂到保留条目）
            const mech = memoryMergeExact();
            // ①-b v1.168：**关系层机械维护**（零 AI）—— 与修复联动：
            //   · **始终清理孤儿关联行**（目标条目已不存在；不受 relOrphanAction 影响，写墓碑跨端同步删除）
            //   · 同 (条目, 角色) 去重合并 / 角色名按档案全名归一 / 悬空引用清理 / how·偏差归一
            //   · 剩 1 人回落私密、剩 0 人孤儿条目按 relOrphanAction 处置（默认只提示）
            let relMaint = null;
            try { relMaint = relRepairMaint(); } catch (e) { }
            if (mech.merged > 0 || (relMaint && relMaint.changed)) { saveState(); list = state.memories || []; }
            try { logRelMaint('记忆修复', relMaint); } catch (e) { }
            // ②③ 标签组聚类 + 选组（轮询 + 上限）
            const spec = GROUP_REPAIR_SPECS.memories;
            const pick = groupPick(spec);
            if (!pick.entries.length) {
                const relTxt1 = relMaintSummary(relMaint);
                const msg = (mech.merged
                    ? `已合并同归属的重复记忆 ${mech.merged} 条；未发现达到相关性阈值（${spec.cfgSim()}）的记忆组，无需 AI 梳理。`
                    : `未发现达到相关性阈值（${spec.cfgSim()}）的记忆组（当前 ${beforeCount} 条记忆彼此相关度均较低，或分属不同归属），无需 AI 梳理。`) + relTxt1;
                notify('info', '记忆修复完成', msg);
                try { dbgLog('摘要', { action: '记忆修复：无高相关组', memories: beforeCount, merged: mech.merged, relMaint: relMaintCounts(relMaint), sim: spec.cfgSim(), ms: 0 }); } catch (e) { }
                return { made: (mech.merged || (relMaint && relMaint.changed)) ? 1 : 0, skipped: true, merged: mech.merged, groups: 0, before: beforeCount, after: (state.memories || []).length, relMaint: relMaintCounts(relMaint) };
            }
            // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 的 notifyHooks 只认 info/success/warning/error，故取等价类型）
            notify('warning', '开始修复记忆数据…', `当前 ${beforeCount} 条记忆 · 高相关组 ${pick.clusters.length}/${pick.total} 组（本次核对 ${pick.entries.length} 条${pick.defects ? ` · 其中缺陷条目 ${pick.defects}` : ''}）${mech.merged ? ` · 已机械去重 ${mech.merged} 条` : ''}${relMaintSummary(relMaint)}`);
            const prompt = buildMemoryRepairPrompt(pick);
            const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '记忆修复'));
            const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
            const r = applyMemoryMergeGroups(delta, pick);
            // ①-c v1.168：AI 合并后**再跑一次**关系层维护（合并/删除可能产生新的孤儿行与悬空引用）
            let relMaint2 = null;
            try { relMaint2 = relRepairMaint(); } catch (e) { }
            if (relMaint2 && relMaint2.changed) { relMaint = mergeRelMaint(relMaint, relMaint2); }
            try { logRelMaint('记忆修复（AI 后）', relMaint2); } catch (e) { }
            const after = (state.memories || []).length;
            if (r.fused > 0 || r.revised > 0 || r.deleted > 0) saveState();
            const parts = [];
            if (r.fused) parts.push(`合并 ${r.fused} 组（-${r.removed} 条）`);
            if (r.revised) parts.push(`修订 ${r.revised} 条`);
            if (r.deleted) parts.push(`删除 ${r.deleted} 条`);
            if (mech.merged) parts.push(`机械去重 ${mech.merged} 条`);
            const relTxt = relMaintSummary(relMaint);
            if (relTxt) parts.push(relTxt.replace(/^（关联维护：/, '关联维护：').replace(/）$/, ''));
            if (parts.length) notify('success', '记忆修复完成', `${parts.join(' · ')}；标签/调用次数/楼层已按并集归并；${repairReport({ before: beforeCount, after: after, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, defects: pick.defects, submittedTags: repairBatchTags(pick.entries), fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, merged: mech.merged, skipped: r.skipped })}。`);
            else notify('info', '记忆修复完成', `AI 认为本次无需合并或修订；${repairReport({ before: beforeCount, after: after, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, defects: pick.defects, submittedTags: repairBatchTags(pick.entries), skipped: r.skipped })}。`);
            try { dbgLog('摘要', { action: '记忆修复完成（v1.140 聚类核对）', before: beforeCount, after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, mechMerged: mech.merged, retargeted: r.retargeted || 0, relMaint: relMaintCounts(relMaint), groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, sim: spec.cfgSim(), ms: Date.now() - t0 }); } catch (e) { }
            return { made: (r.fused || r.revised || r.deleted || mech.merged || (relMaint && relMaint.changed)) ? 1 : 0, before: beforeCount, after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, merged: mech.merged, retargeted: r.retargeted || 0, relMaint: relMaintCounts(relMaint), groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length };
        }
    } catch (e) {
        warn('记忆修复失败', e);
        notify('error', '记忆修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    GROUP_REPAIR_SPECS, groupRepairSpec, itemBaseNameKey, itemNameSim,
    groupRelatedness, groupClusters, groupPick,
    memoryOwnerKey, memoryMergeExact, buildMemoryRepairPrompt, applyMemoryMergeGroups, runMemoryRepair,
};
