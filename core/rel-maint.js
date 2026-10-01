// ============================================================
// core/rel-maint.js —— **关联层机械维护**（B8-6b+，逐字移植自 V1 `src/modules/07-原子层与数据归一化.js` v1.168）
// 定位：修复管道（`core/repair.js#runRepairMech`）内的**零 AI** 收尾步骤，与 V1 `runAutoRepair` 第 1 段一一对应。
// 覆盖：
//   ① `demoteRelLinkOrphans`（降级统计：某条目的具名关联只剩 1 人 / 一条都没有）；
//   ② `relRepairMaint`：**始终清理孤儿关联行**（目标条目已不存在 → 删除并写墓碑）
//      → 同 (dim, refId, who) 去重（保留更可靠者并并集合并信息，丢弃行写墓碑）
//      → 角色名按**档案全名**归一（只在档案里确实存在同名角色时改写，并同步稳定 id）
//      → 悬空引用清理（概念按名称匹配；其余按条目 id 校验；`memRefs`/`sourceRefs` 按允许维度裁剪）
//      → `how` / 偏差非法值归一（只改语义字段，不动 id / 时间戳）
//      → 孤儿条目处置（仅 `cfg.relOrphanAction === 'public'` 时补公开锚行；`keep` 只提示、`clean` 也不删条目）；
//   ③ `relMaintCounts` / `relMaintTouched` / `relMaintSummary` / `logRelMaint`（口径化输出：通知文案 / 调试日志 / 测试断言共用）。
// 适配：ESM 化 + 注入视图（cfg/state）；提示与日志经 `dbgLog`；条目删除一律走墓碑。
// ============================================================
import { state, cfg, dbgLog, identityView } from './model/runtime.js';
import { tombEntries } from './merge.js';
import { sweepOrphanRelLinks, upsertRelLinks } from './entries.js';
import { snapFindByName } from './model/snapshot.js';
import { snapNameKey } from './util.js';
import {
    REL_LINK_DIMS, REL_LINK_HOW_RANK, relLinkId, relLinkHow, relLinkDeviation, relLinksOf, relOrphanStats,
} from './model/rel.js';

/** 降级统计（V1 `demoteRelLinkOrphans`）：具名关联只剩 1 人 → demoted；一条都没有且未了结 → orphan */
function demoteRelLinkOrphans() {
    const out = { orphan: 0, demoted: 0 };
    try {
        const groups = new Map();
        for (const r of ((state && state.links) || [])) {
            if (!r || !r.who) continue;
            const k = String(r.dim) + '|' + String(r.refId);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        const linkSet = new Set(Array.from(groups.keys()));
        for (const dim of REL_LINK_DIMS) {
            for (const it of ((state && state[dim]) || [])) {
                if (!it || !it.id) continue;
                const k = dim + '|' + String(it.id);
                const rows = (groups.get(k) || []).filter(r => r.who);
                if (!linkSet.has(k) && rows.length === 0) continue;
                if (rows.length === 1) out.demoted++;
                else if (rows.length === 0 && it.status !== 'closed') out.orphan++;
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * 关联层机械维护（V1 `relRepairMaint`；零 AI）
 * @param {object} [opts] action（孤儿条目处置：keep/clean/public；缺省读 `cfg.relOrphanAction`）
 */
function relRepairMaint(opts) {
    const o = opts || {};
    const res = {
        action: 'keep', swept: 0, deduped: 0, renamed: 0, staleRefs: 0, normalized: 0,
        demoted: 0, orphanItems: 0, publicized: 0, changed: false,
        details: { sweptRows: [], dedupedRows: [], renamedRows: [], staleRows: [] },
    };
    try {
        if (cfg && cfg.relLinkEnabled === false) return res;
        const dims = (REL_LINK_DIMS && REL_LINK_DIMS.length) ? REL_LINK_DIMS : ['memories', 'plans', 'suspense', 'parallels'];
        const exists = (dim, refId) => ((state && state[dim]) || []).some(x => x && String(x.id) === String(refId));
        // ① 孤儿关联行（目标条目已不存在）→ **始终清理**（先在明细里留痕，再删 + 墓碑）
        const gone = ((state && state.links) || []).filter(r => r && !exists(String(r.dim), String(r.refId)));
        if (gone.length) {
            res.details.sweptRows = gone.slice(0, 50).map(r => ({ dim: String(r.dim), refId: String(r.refId), who: String(r.who || '') }));
            res.swept = sweepOrphanRelLinks();
            if (res.swept) res.changed = true;
        }
        // ② 同 (dim, refId, who) 去重：保留更可靠者并合并信息（差异 / 告知者 / 时间 / 备注 / 公开 / 概念）
        const groups = new Map();
        for (const r of ((state && state.links) || [])) {
            if (!r) continue;
            const k = String(r.dim) + '|' + String(r.refId) + '|' + String(r.who || '');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        const keepRows = [];
        const dropRows = [];
        for (const [, list] of groups) {
            if (list.length === 1) { keepRows.push(list[0]); continue; }
            const sorted = list.slice().sort((a, b) => ((REL_LINK_HOW_RANK[b.how] || 0) - (REL_LINK_HOW_RANK[a.how] || 0)) || ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)));
            const merged = Object.assign({}, sorted[0]);
            for (const x of sorted.slice(1)) {
                if (!merged.from && x.from) merged.from = x.from;
                if (!merged.at && x.at) merged.at = x.at;
                if (!merged.view && x.view) merged.view = x.view;
                if (!merged.note && x.note) merged.note = x.note;
                if ((!merged.deviation || merged.deviation === 'unknown') && x.deviation && x.deviation !== 'unknown') merged.deviation = x.deviation;
                if (!merged.public && x.public) merged.public = true;
                if (!merged.conceptRef && x.conceptRef) merged.conceptRef = x.conceptRef;
                if (!merged.atomRef && x.atomRef) merged.atomRef = x.atomRef;
                if (!merged.planRef && x.planRef) merged.planRef = x.planRef;
                if (!merged.suspenseRef && x.suspenseRef) merged.suspenseRef = x.suspenseRef;
                const mr = Array.isArray(merged.memRefs) ? merged.memRefs.slice() : [];
                for (const y of (Array.isArray(x.memRefs) ? x.memRefs : [])) { if (!mr.some(z => z && y && z.dim === y.dim && z.refId === y.refId)) mr.push(y); }
                merged.memRefs = mr;
                const sr = Array.isArray(merged.sourceRefs) ? merged.sourceRefs.slice() : [];
                for (const y of (Array.isArray(x.sourceRefs) ? x.sourceRefs : [])) { if (!sr.some(z => z && y && z.dim === y.dim && z.refId === y.refId)) sr.push(y); }
                merged.sourceRefs = sr;
                merged.uses = Math.max(Number(merged.uses) || 0, Number(x.uses) || 0);
                merged.updatedAt = Math.max(Number(merged.updatedAt) || 0, Number(x.updatedAt) || 0) || Date.now();
                dropRows.push(x);
            }
            merged.id = relLinkId(merged.dim, merged.refId, merged.who);
            keepRows.push(merged);
        }
        if (dropRows.length) {
            res.details.dedupedRows = dropRows.slice(0, 50).map(r => ({ dim: String(r.dim), refId: String(r.refId), who: String(r.who || '') }));
            res.deduped = dropRows.length;
            state.links = keepRows;
            try { tombEntries('links', dropRows); } catch (e) { /* 忽略 */ }
            res.changed = true;
        }
        // ③ 角色名按**档案全名归一**（who / from；只在档案里确实存在同名角色时改写）
        for (const r of ((state && state.links) || [])) {
            if (!r) continue;
            for (const key of ['who', 'from']) {
                const v = String(r[key] || '').trim();
                if (!v) continue;
                let canon = '';
                try { const sn = snapFindByName(v); if (sn && sn.name) canon = String(sn.name).trim(); } catch (e) { /* 忽略 */ }
                if (canon && canon !== v) {
                    res.details.renamedRows.push({ dim: String(r.dim), refId: String(r.refId), field: key, from: v, to: canon });
                    r[key] = canon;
                    if (key === 'who') r.id = relLinkId(r.dim, r.refId, canon);
                    res.renamed++;
                    res.changed = true;
                }
                if (res.details.renamedRows.length >= 50) break;
            }
        }
        // ④ 悬空引用清理（锚行）：概念按**名称**匹配；其余引用按**条目 id** 校验（不存在即丢弃）
        const conceptNames = new Set(((state && state.concepts) || []).map(c => String((c && c.name) || '').trim()).filter(Boolean));
        const refExists = (dim, id) => ((state && state[dim]) || []).some(x => x && String(x.id) === String(id));
        for (const r of ((state && state.links) || [])) {
            if (!r || r.who) continue;
            const mark = (field, value) => {
                if (res.details.staleRows.length < 50) res.details.staleRows.push({ dim: String(r.dim), refId: String(r.refId), field, value: String(value || '') });
                res.staleRefs++;
                res.changed = true;
            };
            if (r.conceptRef && !conceptNames.has(String(r.conceptRef).trim())) { mark('conceptRef', r.conceptRef); r.conceptRef = ''; }
            if (r.atomRef && !refExists('atoms', r.atomRef)) { mark('atomRef', r.atomRef); r.atomRef = ''; }
            if (r.planRef && !refExists('plans', r.planRef)) { mark('planRef', r.planRef); r.planRef = ''; }
            if (r.suspenseRef && !refExists('suspense', r.suspenseRef)) { mark('suspenseRef', r.suspenseRef); r.suspenseRef = ''; }
            const pruneRefs = (field, allowDims) => {
                const list = Array.isArray(r[field]) ? r[field] : [];
                const keep = list.filter(x => x && allowDims.some(d => refExists(d, x.refId)));
                if (keep.length !== list.length) { mark(field, list.length - keep.length + ' 条'); r[field] = keep; }
            };
            pruneRefs('memRefs', ['memories']);
            pruneRefs('sourceRefs', ['atoms', 'memories']);
        }
        // ⑤ how / 偏差 非法值归一（只改语义字段，不动 id / 时间戳）
        for (const r of ((state && state.links) || [])) {
            if (!r) continue;
            const howNext = r.who ? (String(r.dim) === 'parallels' ? 'related' : relLinkHow(r.how, r.dim)) : '';
            const devNext = r.who ? relLinkDeviation(r.deviation) : (r.deviation || 'unknown');
            if (howNext !== String(r.how || '') || devNext !== String(r.deviation || 'unknown')) {
                r.how = howNext;
                r.deviation = devNext;
                res.normalized++;
                res.changed = true;
            }
        }
        // ⑥ 降级统计：剩 1 人回落私密（不删行）；**孤儿条目**按「一条关联都没有」口径统计
        const dm = demoteRelLinkOrphans();
        res.demoted = Number(dm && dm.demoted) || 0;
        res.orphanItems = Number(relOrphanStats().items) || 0;
        // ⑦ 孤儿条目处置：仅 `public` 才补公开锚行（`keep` 只提示、`clean` 也不删条目 —— 条目删除属破坏性动作）
        const action = String(o.action || (cfg && cfg.relOrphanAction) || 'keep');
        res.action = action;
        if (action === 'public') {
            for (const dim of dims) {
                if (dim === 'parallels') continue;      // 平行事件对任何角色都不可见，不存在「转公开」
                for (const it of ((state[dim]) || [])) {
                    if (!it || !it.id) continue;
                    if (relLinksOf(dim, it.id).length) continue;
                    const kind = dim === 'plans' ? 'plan' : (dim === 'suspense' ? 'suspense' : 'fact');
                    const r2 = upsertRelLinks(dim, it.id, [{ who: '', public: true, kind, note: '孤儿条目转公开（修复）' }], { replace: false });
                    if ((r2.added || 0) > 0) { res.publicized++; res.changed = true; }
                }
            }
        }
    } catch (e) { /* 忽略 */ }
    return res;
}

/** 关联维护结果的口径化输出（V1 `relMaintCounts`） */
function relMaintCounts(m) {
    if (!m) return null;
    return {
        swept: Number(m.swept) || 0, deduped: Number(m.deduped) || 0, renamed: Number(m.renamed) || 0,
        staleRefs: Number(m.staleRefs) || 0, normalized: Number(m.normalized) || 0,
        demoted: Number(m.demoted) || 0, orphanItems: Number(m.orphanItems) || 0,
        publicized: Number(m.publicized) || 0, action: String(m.action || 'keep'),
    };
}
/** 是否真的改动了什么（V1 `relMaintTouched`） */
function relMaintTouched(m) {
    const c = relMaintCounts(m);
    if (!c) return false;
    return !!(c.swept || c.deduped || c.renamed || c.staleRefs || c.normalized || c.publicized);
}
/** 通知用摘要（只列实际发生的项；无动作时返回空串）—— V1 `relMaintSummary` */
function relMaintSummary(m) {
    const c = relMaintCounts(m);
    if (!c) return '';
    const parts = [];
    if (c.swept) parts.push(`清理孤儿关联 ${c.swept} 行`);
    if (c.deduped) parts.push(`关联去重 ${c.deduped} 行`);
    if (c.renamed) parts.push(`角色名归一 ${c.renamed} 处`);
    if (c.staleRefs) parts.push(`悬空引用清理 ${c.staleRefs} 处`);
    if (c.normalized) parts.push(`非法值归一 ${c.normalized} 行`);
    if (c.publicized) parts.push(`孤儿条目转公开 ${c.publicized} 条`);
    if (!parts.length) {
        if (c.orphanItems) return `（关联维护：无孤儿关联需清理；仍有 ${c.orphanItems} 条无关联条目，可在「记忆 → 关系表」查看）`;
        return '';
    }
    return `（关联维护：${parts.join(' · ')}）`;
}
/**
 * 两次维护（AI 前 / AI 后）结果合并 —— V1 `mergeRelMaint`
 * 语义：计数逐项相加、明细拼接后截断 50 条、`changed` 恒为 true（V1 原样）。
 */
function mergeRelMaint(a, b) {
    const x = relMaintCounts(a), y = relMaintCounts(b);
    if (!x) return b || null;
    if (!y) return a || null;
    const out = { action: y.action || x.action, changed: true, details: {} };
    for (const k of ['swept', 'deduped', 'renamed', 'staleRefs', 'normalized', 'demoted', 'orphanItems', 'publicized']) {
        out[k] = (Number(x[k]) || 0) + (Number(y[k]) || 0);
    }
    if (out.publicized || out.swept || out.deduped) out.changed = true;
    for (const k of ['sweptRows', 'dedupedRows', 'renamedRows', 'staleRows']) {
        const da = ((a && a.details) || {})[k] || [];
        const db2 = ((b && b.details) || {})[k] || [];
        out.details[k] = da.concat(db2).slice(0, 50);
    }
    return out;
}
/** 调试日志（明细逐条，便于事后核对清理了哪些行）—— V1 `logRelMaint` */
function logRelMaint(label, m) {
    try {
        const c = relMaintCounts(m);
        if (!c || !relMaintTouched(m)) return false;
        const d = (m && m.details) || {};
        dbgLog('摘要', {
            action: String(label || '') + '：关联层机械维护',
            counts: c,
            清理明细: (d.sweptRows || []).slice(0, 20),
            去重明细: (d.dedupedRows || []).slice(0, 20),
            改名明细: (d.renamedRows || []).slice(0, 20),
            悬空引用: (d.staleRows || []).slice(0, 20),
        });
        return true;
    } catch (e) { return false; }
}

/**
 * v3.1.0（`docs/D13` R2「未封顶清单」，Q7 建议默认值）：**关联层容量上限**。
 *
 * 背景：`state.links` 只按「引用目标是否还存在」清理（`sweepOrphanRelLinks`），**没有条数上限** ——
 *   条目 × 涉及角色 的关系行会持续累积（内存与每次载入/保存的体积都随之增长）。
 * 口径（与 Q7 一致）：上限 = `max(200, 现存条目数 × 2)`；超出时**先淘汰孤儿行**（目标条目已不存在），
 *   再按**行序最旧者优先**淘汰（links 行没有独立时间戳，「最久未用」不可计算，故用插入序；
 *   淘汰只影响关联视图，不改动任何条目数据，且被淘汰行**写删除墓碑**以免跨端复活）。
 *   幂等：不超限时零改动、零分配。
 * @param {object} [st] 目标状态（缺省内核 state）
 * @param {{max?:number, dryRun?:boolean}} [opts]
 * @returns {{ok:boolean, before:number, after:number, max:number, dropped:number, orphans:number, changed:boolean}}
 */
function capRelLinks(st, opts) {
    const o = opts || {};
    const out = { ok: true, before: 0, after: 0, max: 0, dropped: 0, orphans: 0, changed: false };
    try {
        const src = st || state || {};
        const links = Array.isArray(src.links) ? src.links : [];
        out.before = links.length;
        const dims = REL_LINK_DIMS;
        let count = 0;
        for (const dim of dims) count += Array.isArray(src[dim]) ? src[dim].length : 0;
        const cap = Number(o.max) > 0 ? Number(o.max) : Math.max(200, count * 2);
        out.max = cap;
        if (links.length <= cap) { out.after = links.length; return out; }
        // ① 引用目标已不存在 → 直接淘汰
        const exists = (dim, refId) => ((src[dim] || [])).some((x) => x && String(x.id) === String(refId));
        const keep = [], drop = [];
        for (const r of links) {
            if (!r) { drop.push(r); continue; }
            if (!exists(String(r.dim), String(r.refId))) { drop.push(r); out.orphans += 1; continue; }
            keep.push(r);
        }
        // ② 仍超限 → 从**最旧**（数组前部）开始淘汰，保留最近的 cap 行
        if (keep.length > cap) { const cut = keep.length - cap; drop.push(...keep.splice(0, cut)); }
        out.after = keep.length;
        out.dropped = drop.length;
        if (!drop.length) return out;
        if (o.dryRun === true) { out.changed = false; return out; }
        src.links = keep;
        try { tombEntries('links', drop.filter((x) => x && x.id)); } catch (e) { /* 墓碑失败不影响裁剪 */ }
        out.changed = true;
        return out;
    } catch (e) { out.ok = false; return out; }
}

/**
 * v3.2.0（用户要求）：「设定的关系表，需要在自动修复中补充一个步骤，自动清理无效关系。」
 *
 * 与既有 `relRepairMaint()` 的分工：那一步是 **V1 逐字移植**的维护（孤儿行 / 去重 / 角色名归一 / 悬空引用 / 非法值归一），
 *   **不做**「这个角色根本不存在」这类判定。本函数补上这一步 —— 只清**结构上就没有意义**的关联行：
 *
 * | 类别 | 判据 | 说明 |
 * | --- | --- | --- |
 * | `dangling` | 目标条目不存在（`state[dim]` 里找不到 `refId`） | 等同既有孤儿口径；本步**一并处理**，不依赖调用顺序 |
 * | `badDim` | `dim` 不在 `REL_LINK_DIMS`（记忆 / 计划 / 悬念 / 平行） | 历史数据 / 导入残留 |
 * | `badRef` | `refId` 为空 | 无指向的行没有意义 |
 * | `empty` | 无 `who`，且条目级属性与语义字段**全空**（kind/public/各 ref/refs/how/from/at/view/note 都空） | 纯空行 |
 * | `ghost` | 有 `who`，但该名字**不在任何已知名册**（角色档案 / 名册 / 主角·玩家名 / 状态主体 / 记忆归属 / 货币归属 / 平行相关角色） | 「幽灵角色」：档案被删、改名残留、AI 幻觉名 —— 关系表里最典型的「无效关系」 |
 *
 * 纪律：
 *   · **写删除墓碑**（`tombEntries('links', …)`）→ 跨端不会复活；
 *   · **幂等**：没有无效行时零改动、零分配；
 *   · `dryRun` 只报告不改动（供界面预览 / 诊断）；
 *   · 名册判定**宽松**（多来源 + `snapFindByName` 模糊匹配）→ 宁可漏删，不可误删人工关联。
 * @param {{dryRun?:boolean, st?:object}} [opts]
 * @returns {{ok:boolean, scanned:number, removed:number, kept:number, reasons:object, changed:boolean, details:object}}
 */
function cleanInvalidRelLinks(opts) {
    const o = opts || {};
    const out = { ok: true, scanned: 0, removed: 0, kept: 0, reasons: { dangling: 0, ghost: 0, empty: 0, badDim: 0, badRef: 0 }, changed: false, details: { rows: [] } };
    try {
        // 关联层总开关关闭 = 「不读写关联行」（与 `relRepairMaint` 同口径）→ 不做清理（数据保持原样，重开后由修复再清）
        if (!o.st && cfg && cfg.relLinkEnabled === false) return out;
        const src = o.st || state || {};
        const links = Array.isArray(src.links) ? src.links : [];
        out.scanned = links.length;
        if (!links.length) return out;
        const dims = (REL_LINK_DIMS && REL_LINK_DIMS.length) ? REL_LINK_DIMS : ['memories', 'plans', 'suspense', 'parallels'];
        const exists = (dim, refId) => ((src[dim] || [])).some((x) => x && String(x.id) === String(refId));
        const known = relKnownNameSet(src);
        const nameOk = (who) => {
            const k = snapNameKey(who);
            if (!k) return true;                                   // 无 who 的行不由本判据处理
            if (known.has(k)) return true;
            try { if (snapFindByName(who)) return true; } catch (e) { /* 忽略 */ }
            return false;
        };
        const hasAnchorData = (r) => !!(r.kind || r.public === true
            || r.conceptRef || r.atomRef || r.planRef || r.suspenseRef
            || (Array.isArray(r.memRefs) && r.memRefs.length) || (Array.isArray(r.sourceRefs) && r.sourceRefs.length));
        const hasSemantics = (r) => !!(r.how || r.from || r.at || r.view || r.note);
        const keep = [], drop = [];
        for (const r of links) {
            if (!r) { drop.push(r); out.reasons.empty += 1; continue; }
            const dim = String(r.dim == null ? '' : r.dim);
            const refId = String(r.refId == null ? '' : r.refId);
            const who = String(r.who == null ? '' : r.who).trim();
            let why = '';
            if (!dim || dims.indexOf(dim) < 0) why = 'badDim';
            else if (!refId) why = 'badRef';
            else if (!exists(dim, refId)) why = 'dangling';
            else if (who ? !nameOk(who) : (!hasAnchorData(r) && !hasSemantics(r))) why = who ? 'ghost' : 'empty';
            if (!why) { keep.push(r); continue; }
            out.reasons[why] = (out.reasons[why] || 0) + 1;
            if (out.details.rows.length < 50) out.details.rows.push({ reason: why, dim: dim, refId: refId, who: who });
            drop.push(r);
        }
        out.kept = keep.length;
        out.removed = drop.length;
        if (!out.removed) return out;
        if (o.dryRun === true) return out;                          // 预演：只报告
        src.links = keep;
        try { tombEntries('links', drop.filter((x) => x && x.id)); } catch (e) { /* 墓碑失败不影响清理 */ }
        out.changed = true;
        return out;
    } catch (e) { out.ok = false; return out; }
}

/** 已知名册键集合（幽灵角色判定；多来源 + 归一化，宽松优先） */
function relKnownNameSet(st) {
    const src = st || state || {};
    const set = new Set();
    const add = (v) => { const k = snapNameKey(v); if (k) set.add(k); };
    try { for (const s of (src.snapshots || [])) add(s && s.name); } catch (e) { /* 忽略 */ }
    try { for (const n of (src.npcs || [])) add(n && (n.name || n.title)); } catch (e) { /* 忽略 */ }
    try { add(src.protagonist && (src.protagonist.name || src.protagonist.subject)); } catch (e) { /* 忽略 */ }
    try { for (const x of (src.currentStates || [])) { add(x && x.subject); const s2 = String((x && x.subject) || ''); if (s2.indexOf('·') > 0) add(s2.split('·')[0]); } } catch (e) { /* 忽略 */ }
    try { for (const m of (src.memories || [])) add(m && m.owner); } catch (e) { /* 忽略 */ }
    try { for (const c of (src.currencies || [])) add(c && c.owner); } catch (e) { /* 忽略 */ }
    try { for (const p of (src.parallels || [])) for (const who2 of ((p && p.characters) || [])) add(who2); } catch (e) { /* 忽略 */ }
    // 主角 / 玩家名（宿主身份视图注入；取不到就不加 —— 不臆造）
    try { add(identityView && identityView.characterName); } catch (e) { /* 忽略 */ }
    try { add(cfg && cfg.protagonistName); } catch (e) { /* 忽略 */ }
    return set;
}

/** 无效关系统计（**只读**；关系表统计行与诊断用） */
function relInvalidStats(st) {
    const r = cleanInvalidRelLinks({ dryRun: true, st: st });
    return { total: r.scanned, invalid: r.removed, reasons: r.reasons, details: r.details };
}

/** 通知用摘要（只列实际发生的类别） */
function relInvalidSummary(m) {
    const r = (m && m.reasons) || {};
    const parts = [];
    if (r.dangling) parts.push('孤儿 ' + r.dangling);
    if (r.ghost) parts.push('幽灵角色 ' + r.ghost);
    if (r.empty) parts.push('空行 ' + r.empty);
    if (r.badDim) parts.push('非法维度 ' + r.badDim);
    if (r.badRef) parts.push('空指向 ' + r.badRef);
    if (!parts.length) return '';
    return '清理无效关系 ' + Number(m.removed || 0) + ' 行（' + parts.join(' · ') + '）';
}

/** 调试日志（明细逐条，便于事后核对清理了哪些行） */
function logRelInvalid(label, m) {
    try {
        if (!m || !m.removed) return false;
        dbgLog('摘要', { action: String(label || '') + '：清理无效关系', counts: { scanned: m.scanned, removed: m.removed, reasons: m.reasons }, 明细: ((m.details || {}).rows || []).slice(0, 20) });
        return true;
    } catch (e) { return false; }
}

export { demoteRelLinkOrphans, relRepairMaint, relMaintCounts, relMaintTouched, relMaintSummary, logRelMaint, mergeRelMaint, capRelLinks, cleanInvalidRelLinks, relInvalidStats, relInvalidSummary, logRelInvalid };
