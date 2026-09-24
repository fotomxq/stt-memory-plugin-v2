// ============================================================
// core/item-repair.js —— **物品修复管道**（B8-6c-3，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.142 物品修复重设计 · 物品页「🔧 修复物品」专用）：
//   用户要求：① 利用**标签、名称**的相关性排名，提炼出**相关性最高的一组物品**，提交 AI 识别判断是否**融合**
//   并**完善描述**；② 针对**长期远低于平均调用次数**的物品，按**固定规则**在修复时删除。
//   旧实现（v1.101~v1.141）把整库物品 dump 给 AI 并要求回传「物品库.重建 = 完整最终列表」——
//   库大时输入输出都大、AI 难免漏项。
//   新实现五步（前三步零 AI；只有存在高相关组或客观缺陷条目才发 AI）：
//     ① `itemMergeExact` 机械去重：同规范名（去括号说明/空白）合并一条（货币合计数量、uses 累加、
//        标签并集、说明取更长、位置/携带取最新）；
//     ② `itemLowUsesPurge` 低调用清理：固定规则删除「长期远低于平均调用次数」的物品（阈值与门槛全部可配）；
//     ③ 标签/名称聚类 + 选组：相关度 = `max(标签组 Jaccard, 名称相似度)`，边 ≥ `cfg.itemRepairSim`（默认 0.45）**且**
//        （共享 ≥2 标签 **或** 名称相似度 ≥ 0.5）；组规模上限与游标轮询同通用引擎（`core/group-repair.js`）；
//        客观缺陷（说明超字数/标签 <3 个等）另列一组；
//     ④ 窄契约 AI：只发选中的物品组 + 近期正文，要求 `{"合并":[…],"修订":[…],"删除":[…]}`（**禁止新增物品**）；
//     ⑤ 按编号应用 `applyItemMergeGroups`：合并保主条 id、uses 累加、标签并集（并补齐到 3-8 个）、
//        说明取 AI 或更长者。
//
// 复用（不重复实现）：
//   · 聚类引擎与物品名口径 → `core/group-repair.js`（`GROUP_REPAIR_SPECS.items` / `groupPick` / `itemBaseNameKey`）；
//   · 低调用清扫闸门 → `core/forget.js#lowUseSweepGate/lowUseSweepMark`；存储保底 → `core/ingest.js#storeMinFor`；
//   · 正文投喂 → `core/ai-hooks.js#aiFeedText`（V1 `buildFeedFloorText` 的 V2 等价物）。
//
// 适配（与 V1 的差异，逐条见 docs/P8u-B8-6c-3物品与角色修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks）；
//   ② AI 调用改走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植
//      （V2 无任务管线 UI，重绘由 UI 层负责）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//   ⑤ `runItemRepair(opts)` 增设可选 `opts.aiText` 注入点（与 `runRepair`/`runMemoryRepair` 同约定）。
// 一致性由 tests/unit/item-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn, getLastMessageId } from './model/runtime.js';
import { repairNormText, repairClampNum, storeMinFor } from './ingest.js';
import { dimCap } from './model/scalars.js';
import { repairIsGarbage, repairReport, repairBatchTags } from './repair.js';
import { tombMany } from './merge.js';
import { GROUP_REPAIR_SPECS, groupPick, itemBaseNameKey } from './group-repair.js';
import { lowUseSweepGate, lowUseSweepMark } from './forget.js';
import { aiCallText, aiBusy, aiFeedText } from './ai-hooks.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';
import { extractJsonObject } from './util.js';

/** 用户提示（经宿主钩子；与 core/repair.js / core/group-repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/** 货币类物品判定（V1 `isCurrencyItemName`）：名称含币/钱/银两… 或说明前 40 字含货币字样 —— 融合时数量合计 */
function isCurrencyItemName(name, desc) {
    return /(币|货币|钱|银两|铜钱|银票|金票|铜板|coin|money)/i.test(String(name || '')) ||
        /(货币|现金|银两|铜钱|币)/.test(String(desc || '').slice(0, 40));
}

/** ① 机械去重（零 AI，V1 `itemMergeExact`）：同规范名（`itemBaseNameKey`，去括号说明/空白）合并一条。
 *  合并语义：保留首个 id、uses 累加、标签并集（≤8）、说明取更长者；**数量** —— 货币类合计，其它取先有的非空值
 *  （不擅自累加普通道具）；位置/携带/`seenDate` 取楼层最新者（同楼层保留主条，`location` 仅在主条为空时补）；
 *  `floorStart` 取最小、`floorEnd` 取最大。注意：本函数**不写墓碑**（V1 原样 —— 删除留痕由宿主 `saveState` 的
 *  `tombstoneSweep` 负责）。 */
function itemMergeExact() {
    const st = { merged: 0 };
    try {
        const arr = state.items || [];
        if (arr.length < 2) return st;
        const byKey = new Map();
        const out = [];
        for (const it of arr) {
            if (!it || typeof it !== 'object') { out.push(it); continue; }
            const k = itemBaseNameKey(it.name);
            if (!k) { out.push(it); continue; }
            const hit = byKey.get(k);
            if (hit === undefined) { byKey.set(k, out.length); out.push(it); continue; }
            const keep = out[hit];
            const tags = [];
            for (const x of (Array.isArray(keep.tags) ? keep.tags : []).concat(Array.isArray(it.tags) ? it.tags : [])) {
                const v = repairNormText(x).replace(/^#/, '');
                if (v && tags.indexOf(v) < 0) tags.push(v);
            }
            keep.tags = tags.slice(0, 8);
            keep.uses = (Number(keep.uses) || 0) + (Number(it.uses) || 0);
            // 数量：货币类合计，其它取先有的非空值（不擅自累加普通道具）
            if (isCurrencyItemName(keep.name, keep.desc) || isCurrencyItemName(it.name, it.desc)) {
                const q1 = Number(keep.qty), q2 = Number(it.qty);
                if (Number.isFinite(q1) || Number.isFinite(q2)) keep.qty = (Number.isFinite(q1) ? q1 : 0) + (Number.isFinite(q2) ? q2 : 0);
            } else if (keep.qty === undefined || keep.qty === null) {
                if (it.qty !== undefined && it.qty !== null) keep.qty = it.qty;
            }
            // 说明取更长者；位置/携带取楼层最新者（同楼层保留主条）
            if (String(it.desc || '').length > String(keep.desc || '').length) keep.desc = it.desc;
            const kFe = Number(keep.floorEnd) || Number(keep.floorStart) || 0;
            const iFe = Number(it.floorEnd) || Number(it.floorStart) || 0;
            if (iFe > kFe) { if (it.location) keep.location = it.location; keep.carried = !!it.carried; if (it.seenDate) keep.seenDate = it.seenDate; }
            else if (!keep.location && it.location) keep.location = it.location;
            const fs0 = Number(keep.floorStart) || 0, fs1 = Number(it.floorStart) || 0;
            keep.floorStart = (fs0 && fs1) ? Math.min(fs0, fs1) : (fs0 || fs1);
            keep.floorEnd = Math.max(Number(keep.floorEnd) || 0, Number(it.floorEnd) || 0);
            st.merged++;
        }
        if (st.merged > 0) state.items = out;
    } catch (e) { }
    return st;
}

/** ② 低调用清理（固定规则，零 AI，V1 `itemLowUsesPurge`）：
 *  规则：物品数 ≥ `itemLowUsesMinItems`（默认 100）且平均调用 ≥ `itemLowUsesMinAvg`（默认 5）时，
 *  删除「uses ≤ 平均 × `itemLowUsesRatio`（默认 0.05）」且「≥ `itemLowUsesMinFloors`（默认 200）楼未再出现」的物品；
 *  保护：无楼层信息（来历不明）、随身携带、货币类；每轮最多删 `itemLowUsesMaxDelete`（默认 1）件，
 *  按调用次数升序、同龄更旧优先；不跌破存储保底（`storeMinFor('items')`，v1.147）。
 *  v1.153 缓慢处理：清扫间隔闸门 `itemLowUsesEveryFloors`（默认 40 楼一次），距上次清扫不足则整项跳过。 */
function itemLowUsesPurge() {
    const out = { removed: 0, names: [], avg: 0, threshold: 0, protectedCount: 0, skipped: '', total: 0, lastFloor: 0 };
    try {
        const arr = state.items || [];
        out.total = arr.length;
        const minItems = Math.max(1, Number((cfg && cfg.itemLowUsesMinItems)) || 100);
        const minAvg = Math.max(0, Number((cfg && cfg.itemLowUsesMinAvg) != null ? cfg.itemLowUsesMinAvg : 5));
        const ratio = repairClampNum(cfg && cfg.itemLowUsesRatio, 0.01, 0.9, 0.05);
        const minFloors = Math.max(0, Number((cfg && cfg.itemLowUsesMinFloors) != null ? cfg.itemLowUsesMinFloors : 200));
        const maxDel = Math.max(1, Number((cfg && cfg.itemLowUsesMaxDelete)) || 1);
        // v1.153：默认缓慢处理旧数据（长期未现 200 楼 + 每轮最多 1 件）；保留 0=不生效语义供用户关闭
        if (!(minFloors > 0)) { out.skipped = 'long-absent-disabled'; return out; }
        // v1.153：清扫间隔闸门（默认 40 楼一次）
        const everyFloors = Math.max(0, Number((cfg && cfg.itemLowUsesEveryFloors) != null ? cfg.itemLowUsesEveryFloors : 40));
        const gate = lowUseSweepGate('item', everyFloors);
        if (!gate.ok) { out.skipped = 'cooldown'; out.cooldown = { last: gate.last, need: gate.every, wait: gate.wait, floor: gate.lastFloor }; return out; }
        const itemFloor = storeMinFor('items');                 // v1.147：物品保底（默认 150）
        if (arr.length <= itemFloor) { out.skipped = 'at-floor'; return out; }
        if (arr.length < minItems) { out.skipped = 'library-too-small'; return out; }
        let sum = 0, cnt = 0;
        for (const it of arr) { if (!it) continue; sum += Number(it.uses) || 0; cnt++; }
        if (!cnt) { out.skipped = 'no-data'; return out; }
        const avg = sum / cnt;
        out.avg = Number(avg.toFixed(2));
        if (avg < minAvg) { out.skipped = 'avg-too-low'; return out; }
        const thr = avg * ratio;
        out.threshold = Number(thr.toFixed(2));
        const lastFloor = (() => { try { return Math.max(0, Number(getLastMessageId()) || 0); } catch (e) { return 0; } })();
        out.lastFloor = lastFloor;
        const cands = [];
        for (const it of arr) {
            if (!it) continue;
            const uses = Number(it.uses) || 0;
            if (uses > thr) continue;
            const seen = Math.max(Number(it.floorEnd) || 0, Number(it.floorStart) || 0);
            if (!seen) { out.protectedCount++; continue; }
            const age = lastFloor - seen;
            if (age < minFloors) { out.protectedCount++; continue; }
            if (it.carried) { out.protectedCount++; continue; }
            try { if (isCurrencyItemName(it.name, it.desc)) { out.protectedCount++; continue; } } catch (e) { }
            cands.push({ it, uses, age });
        }
        cands.sort((x, y) => (x.uses - y.uses) || (y.age - x.age));
        const del = cands.slice(0, Math.max(0, Math.min(maxDel, arr.length - itemFloor)));   // v1.147：不跌破保底
        if (!del.length) { lowUseSweepMark('item', lastFloor); out.skipped = 'too-recent'; out.every = everyFloors; return out; }
        const ids = new Set(del.map(d => String(d.it.id)));
        try { tombMany('items', Array.from(ids)); } catch (e) { }
        state.items = arr.filter(x => !(x && ids.has(String(x.id))));
        out.removed = del.length;
        out.names = del.map(d => `${d.it.name}(${d.uses}次·${d.age}楼)`);
        lowUseSweepMark('item', lastFloor);   // v1.153：推进清扫间隔（缓慢滴灌）
        out.every = everyFloors;
    } catch (e) { }
    return out;
}

/** ④ 窄契约提示词（V1 `buildItemRepairPrompt`）：只发选中的高相关组 + 近期正文；不含全库。
 *  模板取 `cfg.promptTemplates.itemRepair` → 兜底 `defaultCfg.promptTemplates.itemRepair` → 兜底内置一句话。
 *  正文段：`aiFeedText(max(1, cfg.repairFloors || cfg.feedFloors || 10)).slice(-8000)`（V1 `buildFeedFloorText`）。 */
function buildItemRepairPrompt(pick) {
    const p = pick || groupPick(GROUP_REPAIR_SPECS.items);
    if (!p.entries.length) return null;
    const tpl = String((cfg.promptTemplates && cfg.promptTemplates.itemRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.itemRepair) || '').trim()
        || '判断同组物品是否同一物件：是则融合为一条并完善说明；输出 合并/修订/删除（禁止新增）。';
    const ctxText = String(aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10)) || '').slice(-8000);
    const lines = [];
    let lastGroup = 0;
    for (const e of p.entries) {
        if (e.group !== lastGroup) { lines.push(e.defect ? '【缺陷条目（与相关性无关，不参与合并，可修订或删除）】' : `【相关组 ${e.group}】`); lastGroup = e.group; }
        const meta = [
            `名称：${e.name || '（无）'}`,
            `相关度：${Number(e.sim).toFixed(2)}`,
            `标签：${(e.tags || []).join('/') || '（无标签）'}`,
            e.location ? `位置：${e.location}` : '',
            (e.qty === null || e.qty === undefined) ? '' : `数量：${e.qty}`,
            e.carried ? '携带：是' : '',
            `调用：${e.uses}次`,
            e.defect ? `问题：${e.defect}` : '',
        ].filter(Boolean).join(' ｜ ');
        lines.push(`#${e.n} ｜ ${meta}\n   说明：${String(e.desc || '').slice(0, 200) || '（无）'}`);
    }
    return [
        { role: 'system', content: `${tpl}\n只输出 JSON，不要解释。` },
        { role: 'user', content: `【近期正文（判断流转/是否同一物件的唯一依据）】\n${ctxText || '（无正文）'}\n\n【待核对物品组（本次唯一工作对象，共 ${p.picked} 组 / ${p.entries.length} 条；同组条目「标签组相关性」或「名称相似」较高，可能指同一物件，也可能只是同类物品）】\n${lines.join('\n')}\n\n输出：{"合并":[{"保留":1,"并入":[2,3],"名称":"…","说明":"…","位置":"…","数量":1,"标签":["…"]}],"修订":[{"编号":4,"字段":"说明","值":"…"}],"删除":[5]}（只输出需要改动的编号；无改动就输出空数组）。` },
    ];
}

/** ⑤ 按编号精确应用（V1 `applyItemMergeGroups`）：合并 / 修订 / 删除；**禁止新增物品**。
 *  - 操作块定位：`delta.items` → `delta['物品库']` → `delta` 顶层（兼容 `normalizeDeltaKeys` 归一后与中文键两种形态）。
 *  - 合并：主条沿用 id；`名称`（≤40 且过 `repairIsGarbage`，2 字起）、`说明`（`dimCap('items')` 硬截断且过
 *    `repairIsGarbage`）、`位置`（≤40）、`数量`（有限数）、`携带`（AI 给出才覆盖）按 AI 值优先；标签 3-8 个才生效
 *    并清空 `keywords`；被并入条目的标签并集（≤8）、uses 累加；货币类数量合计；说明取更长者（AI 未给时）；
 *    位置/携带/`seenDate` 取楼层最新者；`floorStart` 取最小、`floorEnd` 取最大。
 *  - 修订：字段闭集 名称 / 说明 / 位置 / 数量 / 携带 / 标签。
 *  - 删除与被并入条目统一走 `tombMany('items')` 写墓碑 + 移除。 */
function applyItemMergeGroups(delta, pick) {
    const out = { fused: 0, revised: 0, deleted: 0, removed: 0, skipped: 0 };
    try {
        const entries = (pick && pick.entries) || [];
        if (!delta || typeof delta !== 'object' || !entries.length) return out;
        const byN = new Map();
        entries.forEach(e => byN.set(Number(e.n), e));
        const ops = (delta.items && typeof delta.items === 'object') ? delta.items
            : ((delta['物品库'] && typeof delta['物品库'] === 'object') ? delta['物品库'] : delta);   // 兼容 归一化后 / 顶层中文键 两种形态
        const fd = (ops['合并'] !== undefined) ? ops['合并'] : ops.merge;
        const rv = (ops['修订'] !== undefined) ? ops['修订'] : ops.revise;
        const dl = (ops['删除'] !== undefined) ? ops['删除'] : ops.remove;
        const findIdx = (id) => (state.items || []).findIndex(x => x && String(x.id) === String(id));
        const hardCap = (() => { try { return Number((cfg.dimCharLimits && cfg.dimCharLimits.items) || (defaultCfg.dimCharLimits && defaultCfg.dimCharLimits.items) || 80) || 80; } catch (e) { return 80; } })();
        const applyTags = (e, arr) => {
            const tags = (Array.isArray(arr) ? arr : String(arr || '').split(/[，,、#\s]+/)).map(x => repairNormText(x).replace(/^#/, '')).filter(Boolean);
            if (tags.length >= 3 && tags.length <= 8) { e.tags = tags.slice(0, 8); e.keywords = []; }
        };
        const deadIds = new Set();
        // ① 合并（保主条 id/uses；标签并集；说明取 AI 或更长者；数量按货币规则）
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
                    const primary = state.items[ki];
                    const nm = repairNormText(g['名称'] !== undefined ? g['名称'] : g.name).slice(0, 40);
                    const ds = repairNormText(g['说明'] !== undefined ? g['说明'] : g.desc);
                    const loc = repairNormText(g['位置'] !== undefined ? g['位置'] : g.location).slice(0, 40);
                    const qtyRaw = (g['数量'] !== undefined) ? g['数量'] : g.qty;
                    const qtyNum = (qtyRaw === '' || qtyRaw === null || qtyRaw === undefined) ? null : Number(qtyRaw);
                    const aiDesc = !!(ds && !repairIsGarbage(ds, 4));
                    const aiLoc = !!loc;
                    const aiQty = (qtyNum !== null && Number.isFinite(qtyNum));
                    const aiCarried = (g['携带'] !== undefined || g.carried !== undefined);
                    if (nm && !repairIsGarbage(nm, 2)) primary.name = nm;
                    if (aiDesc) primary.desc = dimCap('items', ds);            // AI 完善后的说明优先
                    if (aiLoc) primary.location = loc;                          // AI 给出的位置优先（结合正文最新流转）
                    if (aiCarried) primary.carried = !!(g['携带'] !== undefined ? g['携带'] : g.carried);
                    if (aiQty) primary.qty = qtyNum;
                    applyTags(primary, g['标签'] !== undefined ? g['标签'] : g.tags);
                    const tagSet = [];
                    const pushTags = (src) => { (Array.isArray(src) ? src : []).forEach(x => { const v = repairNormText(x).replace(/^#/, ''); if (v && tagSet.indexOf(v) < 0) tagSet.push(v); }); };
                    pushTags(primary.tags);
                    let qtySum = Number(primary.qty);
                    let currency = false;
                    try { currency = isCurrencyItemName(primary.name, primary.desc); } catch (e) { }
                    for (const m of members) {
                        const mi = findIdx(m.id);
                        if (mi < 0) continue;
                        const me = state.items[mi];
                        pushTags(me.tags);
                        primary.uses = (Number(primary.uses) || 0) + (Number(me.uses) || 0);
                        try { if (isCurrencyItemName(me.name, me.desc)) currency = true; } catch (e) { }
                        if (currency) { const q = Number(me.qty); if (Number.isFinite(q)) qtySum = (Number.isFinite(qtySum) ? qtySum : 0) + q; }
                        else if (!aiQty && (primary.qty === undefined || primary.qty === null) && me.qty !== undefined && me.qty !== null) primary.qty = me.qty;
                        if (!aiDesc && String(me.desc || '').length > String(primary.desc || '').length) primary.desc = me.desc;
                        const mFe = Number(me.floorEnd) || Number(me.floorStart) || 0;
                        const pFe = Number(primary.floorEnd) || Number(primary.floorStart) || 0;
                        if (mFe > pFe) { if (!aiLoc && me.location) primary.location = me.location; if (!aiCarried) primary.carried = !!me.carried; if (me.seenDate) primary.seenDate = me.seenDate; }
                        const fs0 = Number(primary.floorStart) || 0, fs1 = Number(me.floorStart) || 0;
                        primary.floorStart = (fs0 && fs1) ? Math.min(fs0, fs1) : (fs0 || fs1);
                        primary.floorEnd = Math.max(Number(primary.floorEnd) || 0, Number(me.floorEnd) || 0);
                        deadIds.add(String(me.id));
                        out.removed++;
                    }
                    if (!aiQty && currency && Number.isFinite(qtySum)) primary.qty = qtySum;
                    if (tagSet.length) primary.tags = tagSet.slice(0, 8);
                    out.fused++;
                } catch (e) { out.skipped++; }
            }
        }
        // ② 修订（字段闭集：名称/说明/位置/数量/携带/标签）
        if (Array.isArray(rv)) {
            for (const r of rv) {
                try {
                    if (!r || typeof r !== 'object') { out.skipped++; continue; }
                    const n = Number(String(r['编号'] !== undefined ? r['编号'] : r.n).replace(/[^0-9]/g, ''));
                    const en = byN.get(n);
                    if (!en) { out.skipped++; continue; }
                    const idx = findIdx(en.id);
                    if (idx < 0) { out.skipped++; continue; }
                    const e = state.items[idx];
                    const field = repairNormText(r['字段'] !== undefined ? r['字段'] : r.field);
                    const val = r['值'] !== undefined ? r['值'] : r.value;
                    if (!field) { out.skipped++; continue; }
                    if (field === '标签') { const before = JSON.stringify(e.tags || []); applyTags(e, val); if (JSON.stringify(e.tags || []) !== before) out.revised++; else out.skipped++; }
                    else if (field === '名称') { const v = repairNormText(val).slice(0, 40); if (v && !repairIsGarbage(v, 2)) { e.name = v; out.revised++; } else out.skipped++; }
                    else if (field === '说明') { const v = dimCap('items', repairNormText(val)); if (v && !repairIsGarbage(v, 4)) { e.desc = v; out.revised++; } else out.skipped++; }
                    else if (field === '位置') { const v = repairNormText(val).slice(0, 40); if (v) { e.location = v; out.revised++; } else out.skipped++; }
                    else if (field === '数量') { const v = Number(val); if (Number.isFinite(v)) { e.qty = v; out.revised++; } else out.skipped++; }
                    else if (field === '携带') { const v = !!(val === true || String(val).trim() === 'true' || String(val).trim() === '是'); e.carried = v; out.revised++; }
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
            try { tombMany('items', Array.from(deadIds)); } catch (e) { }
            const before = (state.items || []).length;
            state.items = (state.items || []).filter(x => !(x && deadIds.has(String(x.id))));
            out.deleted = before - (state.items || []).length;
        }
        return out;
    } catch (e) { return out; }
}

/**
 * 物品修复全链路（V1 `runItemRepair`，五步）：
 *   ① `itemMergeExact` 机械去重（零 AI，有改动即落盘）
 *   → ② `itemLowUsesPurge` 低调用固定规则清理（零 AI，有改动即落盘）
 *   → ③ `groupPick(GROUP_REPAIR_SPECS.items)` 标签/名称聚类选组
 *   → ④ `buildItemRepairPrompt` + AI → ⑤ `applyItemMergeGroups` 按编号精确应用。
 * 无高相关组且无缺陷条目时**不发 AI**（如实说明「已机械合并 N 件 / 低调用清理 … / 未发现达阈值物品组」并早退，
 * `made` 取「机械合并或清理是否有改动」的 0/1）。
 * V2 适配：互斥走 `aiBusy()`（等价 V1 `busy.repair` + 摘要/压缩/推演/推进/同步占用）；AI 走 `aiCallText`；
 *   `opts.aiText` 为 V2 注入点（显式指定 AI 返回，测试用；缺省走 `aiCallText`）；
 *   V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植。
 * @param {object} [opts] aiText（V2 注入）
 * @returns {Promise<object>} V1 同形返回结构
 */
async function runItemRepair(opts) {
    const o = opts || {};
    try {
        let list = state.items || [];
        if (!list.length) { notify('info', '物品修复：暂无物品', '请先通过「AI 摘要」生成物品或手动添加后再修复。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 都返回 blocked；
        //   V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        const t0 = Date.now();
        const beforeCount = list.length;
        // ① 机械去重（同规范名，零 AI）
        const mech = itemMergeExact();
        if (mech.merged > 0) { saveState(); list = state.items || []; }
        // ② 低调用清理（固定规则，零 AI）
        const purge = itemLowUsesPurge();
        if (purge.removed > 0) { saveState(); list = state.items || []; }
        // ③ 标签/名称相关性聚类 + 选组（游标轮询）
        const spec = GROUP_REPAIR_SPECS.items;
        const pick = groupPick(spec);
        // v1.153：默认缓慢处理旧数据 —— 冷却/门槛未到时如实说明，而不是静默
        const purgeNote = purge.removed
            ? `低调用清理 ${purge.removed} 件（低于平均 ${purge.avg} 次的 ${Math.round((Number(cfg.itemLowUsesRatio) || 0.05) * 100)}%＝${purge.threshold} 次，且 ≥${Number(cfg.itemLowUsesMinFloors) || 200} 楼未再出现）`
            : (purge.skipped === 'cooldown'
                ? `物品低调用清理：间隔未到（距上次清扫 ${Math.max(0, ((purge.cooldown && purge.cooldown.floor) || 0) - ((purge.cooldown && purge.cooldown.last) || 0))} 楼 / 需 ${(purge.cooldown && purge.cooldown.need) || 40} 楼）→ 本轮跳过`
                : (purge.skipped === 'too-recent' ? `物品低调用清理：暂无 ≥${Number(cfg.itemLowUsesMinFloors) || 200} 楼未出现的旧物品` : ''));
        if (!pick.entries.length) {
            const parts = [];
            if (mech.merged) parts.push(`已机械合并同规范名 ${mech.merged} 件`);
            if (purgeNote) parts.push(purgeNote);
            parts.push(`未发现达到相关性阈值（${spec.cfgSim()}）的物品组，无需 AI 判断融合`);
            notify('info', '物品修复完成', parts.join('；') + '。');
            try { dbgLog('摘要', { action: '物品修复：无高相关组', items: beforeCount, mechMerged: mech.merged, purge: purge.removed, purgeSkipped: purge.skipped, sim: spec.cfgSim() }); } catch (e) { }
            return { made: (mech.merged || purge.removed) ? 1 : 0, skipped: true, merged: mech.merged, purged: purge.removed, groups: 0, before: beforeCount, after: (state.items || []).length };
        }
        // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 notifyHooks 只认 info/success/warning/error）
        notify('warning', '开始修复物品数据…', `当前 ${beforeCount} 件物品 · 高相关组 ${pick.clusters.length}/${pick.total} 组（本次核对 ${pick.entries.length} 条${pick.defects ? ` · 其中缺陷条目 ${pick.defects}` : ''}）${mech.merged ? ` · 已机械合并 ${mech.merged} 件` : ''}${purge.removed ? ` · 已清理低调用 ${purge.removed} 件` : ''}`);
        const prompt = buildItemRepairPrompt(pick);
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '物品修复'));
        const delta = normalizeDeltaKeys(extractJsonObject(resp) || {});
        const r = applyItemMergeGroups(delta, pick);
        const after = (state.items || []).length;
        if (r.fused > 0 || r.revised > 0 || r.deleted > 0) saveState();
        const parts = [];
        if (r.fused) parts.push(`合并 ${r.fused} 组（-${r.removed} 件）`);
        if (r.revised) parts.push(`修订 ${r.revised} 件`);
        if (r.deleted) parts.push(`删除 ${r.deleted} 件`);
        if (mech.merged) parts.push(`机械合并 ${mech.merged} 件`);
        if (purgeNote) parts.push(purgeNote);
        if (parts.length) notify('success', '物品修复完成', `${parts.join(' · ')}；${repairReport({ before: beforeCount, after: after, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, defects: pick.defects, submittedTags: repairBatchTags(pick.entries), fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, merged: mech.merged, purged: purge.removed, skipped: r.skipped })}。`);
        else notify('info', '物品修复完成', `AI 认为本次无需融合或修订；${repairReport({ before: beforeCount, after: after, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, defects: pick.defects, submittedTags: repairBatchTags(pick.entries), skipped: r.skipped })}。`);
        try { dbgLog('摘要', { action: '物品修复完成（v1.142 聚类核对）', before: beforeCount, after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, mechMerged: mech.merged, purged: purge.removed, groups: pick.clusters.length, groupsTotal: pick.total, checked: pick.entries.length, sim: spec.cfgSim(), ms: Date.now() - t0 }); } catch (e) { }
        return { made: (r.fused || r.revised || r.deleted || mech.merged || purge.removed) ? 1 : 0, before: beforeCount, after, fused: r.fused, removed: r.removed, revised: r.revised, deleted: r.deleted, skipped: r.skipped, merged: mech.merged, purged: purge.removed, groups: pick.clusters.length, checked: pick.entries.length };
    } catch (e) {
        warn('物品修复失败', e);
        notify('error', '物品修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export {
    isCurrencyItemName, itemMergeExact, itemLowUsesPurge,
    buildItemRepairPrompt, applyItemMergeGroups, runItemRepair,
};
