// ============================================================
// core/migrate.js —— **逐字移植自 V1**（src/modules/05-记忆状态与存储抽象.js + 08/03/07 的相关族）
// 覆盖：结构健壮性迁移 `migrateState`（v1.160 容器/条目清洗 + 多版本迁移链）、`migratePlanSuspV1165`、
//   `migrateRelLinks`（关联层迁移）、跨端内容去重 `contentPickBest` / `contentDedupeArray`、日期数值化 `recallDateNum`。
// 适配：ESM 化 + 注入视图（cfg/state）；跨模块依赖（时钟、模型、哈希补全）经 import 复用，不重复移植。
// 一致性由 tests/unit/migrate-entries-golden.test.js 的黄金样本强制校验。
// ============================================================

import { clockDateParts, clockDateTrim } from './clock.js';
import { VERSION } from './constants.js';
import { ensureAtomHashes } from './merge.js';
import { atomContentHash } from './model/hash.js';
import { normalizeRelLink } from './model/rel.js';
import { rumorId } from './model/rumor.js';
import { cfg, state } from './model/runtime.js';
import { scenePathArr } from './model/scalars.js';
import { plotSegmentId } from './model/segment.js';
import { migrateSnapshotV1162, normalizeSnapshot } from './model/snapshot.js';
import { hashText, normalizeList } from './util.js';
function recallDateNum(s) {
    try {
        const p = clockDateParts(clockDateTrim(s));   // v1.193：负年份（公元前）→ 带符号数值
        if (!p) return NaN;
        return p.y * 10000 + p.m * 100 + p.d;
    } catch (e) { return NaN; }
}
// 条目重要度（importance 0..1 / strength 0..100 → 0..1；缺省 0.5）

function contentDedupeArray(cat, arr) {
    try {
        if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr.slice() : [];
        const out = [];
        const byH = new Map();          // h -> out 下标（保留首次出现位置）
        for (const it of arr) {
            if (!it || typeof it !== 'object') { out.push(it); continue; }
            const h = atomContentHash(cat, it);
            if (!h) { out.push(it); continue; }
            const i = byH.get(h);
            if (i === undefined) { byH.set(h, out.length); out.push(JSON.parse(JSON.stringify(it))); continue; }
            const ex = out[i];
            const win = contentPickBest(ex, it);
            const merged = JSON.parse(JSON.stringify(win));
            merged.floorStart = Math.min(Number(ex.floorStart) || 0, Number(it.floorStart) || 0) || (Number(win.floorStart) || 0);
            merged.floorEnd = Math.max(Number(ex.floorEnd) || 0, Number(it.floorEnd) || 0);
            merged.uses = (Number(ex.uses) || 0) + (Number(it.uses) || 0);
            out[i] = merged;
        }
        return out;
    } catch (e) { return (Array.isArray(arr) ? arr.slice() : []); }
}
// 原子展示内容（供快照列表预览与导出用，仅取实质字段）

function contentPickBest(a, b) {
    const ka = Number(a.updatedAt) || 0, kb = Number(b.updatedAt) || 0;
    if (ka !== kb) return ka > kb ? a : b;
    const da = recallDateNum(a.date || a.updatedAt) || 0, db = recallDateNum(b.date || b.updatedAt) || 0;
    if (da !== db) return da > db ? a : b;
    const fa = Number(a.floorEnd) || 0, fb = Number(b.floorEnd) || 0;
    if (fa !== fb) return fa > fb ? a : b;
    return b;   // 并列 → 清单靠后（更晚写入）胜
}

function migrateRelLinks(s) {
    let changed = false;
    try {
        if (!s || typeof s !== 'object') return false;
        if (!Array.isArray(s.links)) { s.links = []; changed = true; }
        const beforeJson = JSON.stringify(s.links);
        const out = [];
        const seen = new Set();
        for (const raw of s.links) {
            const n = normalizeRelLink(raw);
            if (!n) continue;
            const key = n.dim + '|' + n.refId + '|' + n.who;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(n);
        }
        // 每条目关联行上限（超出按可靠度截断，锚行优先保留）
        const max = relLinkDefaultMax();
        const groups = new Map();
        for (const r of out) { const k = r.dim + '|' + r.refId; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        const final = [];
        for (const [, list] of groups) {
            if (list.length <= max) { final.push(...list); continue; }
            const sorted = list.slice().sort((a, b) => ((REL_LINK_HOW_RANK[b.how] || 0) - (REL_LINK_HOW_RANK[a.how] || 0)) || String(a.who).localeCompare(String(b.who)));
            const anchorRow = sorted.find(x => !x.who);
            const picked = anchorRow ? [anchorRow] : [];
            for (const r of sorted) { if (picked.length >= max) break; if (!r.who || picked.indexOf(r) >= 0) continue; picked.push(r); }
            final.push(...picked);
        }
        s.links = final;
        if (JSON.stringify(final) !== beforeJson) changed = true;
    } catch (e) { }
    return changed;
}

// ==================== v1.166：关联层维护 / 摘要 / 批量补 / 转正（docs/11 §7、§9.2） ====================
// 关联摘要一行（世界书词条 / 界面列表 / 约束预览共用）—— 只读、确定性、无 AI。
//   记忆 / 计划 / 悬念：`亲历：甲 · 被告知：乙`；公开锚行 → 「公开事实 / 公开计划」；
//   平行事件：恒为「相关（角色不知情）」——相关 ≠ 知情。

const REL_LINK_HOW_RANK = { author: 9, involved: 9, participant: 8, witness: 7, join: 7, investigating: 6, told: 5, unspecified: 4, inferred: 3, rumor: 2, related: 1 };

function relLinkDefaultMax() { const n = Number(cfg && cfg.relLinkMax); return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 12; }
// how 归一（中文/英文别名；越界 → unspecified；平行事件恒为 related）

function migratePlanSuspV1165(s) {
    let changed = false;
    try {
        if (!s || typeof s !== 'object') return false;
        if (cfg && cfg.planStructEnabled === false) return false;
        const ensureArr = (o, k) => { if (!Array.isArray(o[k])) { o[k] = []; changed = true; } };
        const ensureStr = (o, k) => { if (typeof o[k] !== 'string') { o[k] = ''; changed = true; } };
        for (const p of (Array.isArray(s.plans) ? s.plans : [])) {
            if (!p || typeof p !== 'object') continue;
            ensureArr(p, 'steps'); ensureArr(p, 'blockers'); ensureArr(p, 'history'); ensureArr(p, 'suspenseRefs'); ensureArr(p, 'memRefs'); ensureArr(p, 'participants');
            ensureStr(p, 'planner'); ensureStr(p, 'prereq');
            // v1.166：阶段 / 状态备注（空字符串 = 进行中；哈希把缺失当空 → 纯补空键不引发跨端抖动）
            ensureStr(p, 'phase'); ensureStr(p, 'statusNote');
            if (typeof p.progress !== 'number' || !Number.isFinite(p.progress)) { p.progress = (p.status === 'closed' ? 100 : 0); changed = true; }
        }
        for (const x of (Array.isArray(s.suspense) ? s.suspense : [])) {
            if (!x || typeof x !== 'object') continue;
            ensureArr(x, 'clues'); ensureArr(x, 'history'); ensureArr(x, 'planRefs'); ensureArr(x, 'memRefs');
            ensureStr(x, 'resolveCondition'); ensureStr(x, 'level');
            ensureStr(x, 'phase'); ensureStr(x, 'statusNote');
        }
        for (const y of (Array.isArray(s.parallels) ? s.parallels : [])) {
            if (!y || typeof y !== 'object') continue;
            ensureArr(y, 'sourceRefs'); ensureArr(y, 'previews');
            ensureStr(y, 'planRef'); ensureStr(y, 'suspenseRef'); ensureStr(y, 'promotedTo'); ensureStr(y, 'promotedAt'); ensureStr(y, 'constraintNote');
        }
    } catch (e) { }
    return changed;
}
// ==================== 快照系统====================
// 双能力：备份（根快照全量兜底）+ 增量补全（原子变更后 400ms 防抖增量备份）。
// 原子数据底层自带内容哈希 h（缺省自动补全，见 ensureAtomHashes）；快照除自身 hash 外，
// 还携带 atomsHashes{原子id: h} 列 —— 记录该快照已覆盖哪些原子版本，用于：
//   ① 识别哪些原子已做过快照（内容 h 相同 → 不重复备份）；
//   ② 原子更新后 h 重算（与快照记录不符）→ 交下一次增量快照捕获。

function migrateState(s) {
    let changed = false;
    // 删除墓碑容器归一（旧数据无该键 → 补空对象）
    if (!s || typeof s !== 'object') return s;
    // ==================== v1.160：容器 / 条目健壮性归一（潜在缺陷修复） ====================
    // 背景：损坏的本机存档、被手工编辑过的 localStorage、跨端合并残留、旧版本写入的不同结构，都可能让
    //   维度数组里混入 `null` / 非对象条目，或把容器写成 null / 非数组。此前这类脏数据会一路走到渲染层，
    //   导致**整页抛错**并被「单页错误隔离卡片」顶掉（用户看到「XX 页渲染出错」）。
    // 处理：数组容器缺省为 []，并**丢弃非对象条目**；对象容器（变量 / 快照库 / 统计 / 游标 …）缺省为 {}；
    //   剧情时钟必须是对象、在场名单必须是字符串数组。只清洗「结构性垃圾」，不触碰任何有效条目内容
    //   （幂等：干净数据不会置位 changed）。
    {
        // 注意：snapStore 是**数组**（快照链：root/incr 条目），不是对象 —— 必须按数组归一
        const ARR_KEYS = ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'npcs', 'snapStore', 'links', 'currencies', 'plotSegments', 'rumors'];   // v1.192：补 currencies / plotSegments / rumors（此前三个容器未纳入健壮性清洗名单）
        for (const k of ARR_KEYS) {
            const v = s[k];
            if (!Array.isArray(v)) { s[k] = []; changed = true; continue; }
            // 丢弃结构垃圾：null / 原始值 / **空对象**（无任何字段的条目不承载信息，渲染层也只会产出空行）
            const clean = v.filter(x => x && typeof x === 'object' && Object.keys(x).length > 0);
            if (clean.length !== v.length) { s[k] = clean; changed = true; }
        }
        const OBJ_KEYS = ['vars', 'stats', 'repairCursor', 'lowUseForget'];
        for (const k of OBJ_KEYS) {
            const v = s[k];
            if (v === null || (v !== undefined && (typeof v !== 'object' || Array.isArray(v)))) { s[k] = {}; changed = true; }
            // 缺失（undefined）保持缺失：消费方普遍用 `state.x || {}` 兜底，不强加空对象以免产生无意义 diff
        }
        if (s.state === undefined || s.state === null) { s.state = {}; changed = true; }
        else if (typeof s.state !== 'object' || Array.isArray(s.state)) { s.state = {}; changed = true; }
        else if (s.state.present !== undefined) {
            if (!Array.isArray(s.state.present)) { s.state.present = []; changed = true; }
            else {
                const p = s.state.present.filter(x => typeof x === 'string' && x.trim());
                if (p.length !== s.state.present.length) { s.state.present = p; changed = true; }
            }
        }
        if (s.processedFloors !== undefined && !Array.isArray(s.processedFloors)) { s.processedFloors = []; changed = true; }
    }
    if (!s.deleted || typeof s.deleted !== 'object' || Array.isArray(s.deleted)) { s.deleted = {}; changed = true; }
    // 内容哈希墓碑容器归一
    if (!s.deletedH || typeof s.deletedH !== 'object' || Array.isArray(s.deletedH)) { s.deletedH = {}; changed = true; }
    if (Array.isArray(s.plans)) {
        const kept = [];
        const susp = Array.isArray(s.suspense) ? s.suspense : [];
        for (const p of s.plans) {
            if (p && (p.kind === '悬念' || p.kind === 'suspense')) {
                susp.push({ id: p.id || `sus_${hashText(p.content || '')}`, content: p.content, createdTime: p.createdTime || '', targetTime: p.targetTime || '', status: p.status || 'open' });
                changed = true;
            } else if (p) { kept.push(p); }
        }
        s.plans = kept;
        s.suspense = susp;
    }
    if (Array.isArray(s.atoms)) {
        for (const a of s.atoms) {
            if (a && a.date === undefined) { a.date = a.eventTime && /^-?\d{1,4}-\d{2}-\d{2}/.test(a.eventTime) ? clockDateTrim(a.eventTime) : ''; a.time = a.eventTime || ''; changed = true; }
            if (a && typeof a.text === 'string' && /^(测试|test)[原子数据条目项目]*[:：]\s*/i.test(a.text.trim())) { a.text = a.text.replace(/^(测试|test)[原子数据条目项目]*[:：]\s*/i, '').trim(); changed = true; }
            if (a && a.uses === undefined) { a.uses = 0; changed = true; }
            if (a && a.tags === undefined) { a.tags = []; changed = true; }
        }
    }
    if (Array.isArray(s.memories)) {
        for (const m of s.memories) {
            if (m && m.owner === undefined) { m.owner = m.owner || '通用'; m.date = m.date || ''; changed = true; }
            if (m && m.uses === undefined) { m.uses = 0; changed = true; }
            if (m && m.tags === undefined) { m.tags = []; changed = true; }
        }
    }
    if (Array.isArray(s.snapshots)) { for (const x of s.snapshots) { if (x && x.uses === undefined) { x.uses = 0; changed = true; } } }
    if (Array.isArray(s.items)) { for (const x of s.items) { if (x && x.uses === undefined) { x.uses = 0; changed = true; } } }
    // v1.181：货币大类（旧存档无该容器 → 补空数组；条目补 uses 与收支数组）
    if (!Array.isArray(s.currencies)) { s.currencies = []; changed = true; }
    else {
        for (const x of s.currencies) {
            if (!x || typeof x !== 'object') continue;
            if (x.uses === undefined) { x.uses = 0; changed = true; }
            if (!Array.isArray(x.history)) { x.history = []; changed = true; }
            if (!Number.isFinite(Number(x.amount))) { x.amount = Number(x.amount) || 0; changed = true; }
        }
    }
    // v1.182：情节分段总结（旧存档无该容器 → 补空数组；条目补齐 id / lines / 时间戳）
    if (!Array.isArray(s.plotSegments)) { s.plotSegments = []; changed = true; }
    else {
        for (const x of s.plotSegments) {
            if (!x || typeof x !== 'object') continue;
            if (!String(x.id || '').trim()) { x.id = plotSegmentId(x); changed = true; }
            if (!Array.isArray(x.lines)) { x.lines = []; changed = true; }
            if (x.uses === undefined) { x.uses = 0; changed = true; }
            if (x.createdAt === undefined) { x.createdAt = Number(x.updatedAt) || Date.now(); changed = true; }
        }
    }
    // v1.192：传言（旧存档无该容器 → 补空数组；条目补齐 id / 子数组 / 机械演化字段）
    if (!Array.isArray(s.rumors)) { s.rumors = []; changed = true; }
    else {
        for (const x of s.rumors) {
            if (!x || typeof x !== 'object') continue;
            if (!String(x.id || '').trim()) { x.id = rumorId(x); changed = true; }
            if (!Array.isArray(x.carriers)) { x.carriers = []; changed = true; }
            if (!Array.isArray(x.media)) { x.media = []; changed = true; }
            if (!Array.isArray(x.chain)) { x.chain = []; changed = true; }
            if (!Array.isArray(x.tags)) { x.tags = []; changed = true; }
            if (!x.lineage || typeof x.lineage !== 'object') { x.lineage = { rootId: x.id, parentId: '', children: [], generation: 0 }; changed = true; }
            else if (!Array.isArray(x.lineage.children)) { x.lineage.children = []; changed = true; }
            if (x.uses === undefined) { x.uses = 0; changed = true; }
            if (x.createdAt === undefined) { x.createdAt = Number(x.updatedAt) || Date.now(); changed = true; }
        }
    }
    if (Array.isArray(s.plans)) { for (const x of s.plans) { if (x && x.uses === undefined) { x.uses = 0; changed = true; } } }
    if (Array.isArray(s.suspense)) { for (const x of s.suspense) { if (x && x.uses === undefined) { x.uses = 0; changed = true; } } }
    // 移除「角色名册」大类，数据合并进「角色」（snapshots），同角色补全字段、新角色建档
    if (Array.isArray(s.npcs) && s.npcs.length) {
        s.snapshots = Array.isArray(s.snapshots) ? s.snapshots : [];
        for (const n of s.npcs) {
            if (!n || !n.name) continue;
            const nm = String(n.name).trim();
            const existing = s.snapshots.find(x => x.name === nm);
            if (existing) {
                if (n.title && !existing.identity?.occupation) { existing.identity = existing.identity || {}; existing.identity.occupation = String(n.title); }
                if (n.desc && !existing.background?.history) { existing.background = existing.background || {}; existing.background.history = String(n.desc); }
                if (n.gender && !existing.identity?.gender) { existing.identity = existing.identity || {}; existing.identity.gender = String(n.gender); }
            } else {
                // 名册的「地点」不再并入角色档案（v1.162 起角色档案无位置字段）
                const snap = normalizeSnapshot({ ...n, title: n.title || undefined, occupation: n.title || undefined, history: n.desc || undefined, gender: n.gender || undefined });
                if (snap) s.snapshots.push(snap);
            }
            changed = true;
        }
        s.npcs = [];
        changed = true;
    } else if (Array.isArray(s.npcs) && !s.npcs.length) {
        s.npcs = [];
    }
    // ==================== v1.162：角色档案 schema 收敛（幂等） ====================
    // 用户要求：删掉「内心（情绪/当前目标/担忧）」与「位置（城市/区域/建筑/室内）」等**高动态且没意义**的字段；
    //   「年龄备注」→「年龄」（只由出生年月 + 当前剧情日期自动计算，不人工填写）；
    //   外貌特征（身高/发型/瞳色/…)聚合为**单字段文本**。旧数据的收敛逻辑见 migrateSnapshotV1162()（模块 07）。
    if (Array.isArray(s.snapshots)) {
        for (const x of s.snapshots) {
            if (x && typeof x === 'object') { if (migrateSnapshotV1162(x)) changed = true; }
        }
    }
    if (Array.isArray(s.scenes)) {
        for (const x of s.scenes) {
            if (!x) continue;
            if (x.uses === undefined) { x.uses = 0; changed = true; }
            // 分层场景迁移（path 字符串 → pathArr/pathStr 数组）
            if (x.pathArr === undefined) {
                const arr = scenePathArr(x);
                if (arr.length) { x.pathArr = arr; x.pathStr = arr.join('>'); changed = true; }
                else if (x.pathStr === undefined) { x.pathStr = ''; changed = true; }
            } else if (x.pathStr === undefined) { x.pathStr = Array.isArray(x.pathArr) ? x.pathArr.join('>') : ''; changed = true; }
        }
    }
    if (Array.isArray(s.concepts)) {
        for (const c of s.concepts) { if (c && c.tags === undefined) { c.tags = []; changed = true; } }
    }
    // tags 与 keywords 统一为 tags —— 历史条目 keywords 自动合并进 tags（去重，避免数据丢失）
    const mergeKwHist = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const x of arr) {
            if (x && Array.isArray(x.keywords) && x.keywords.length) {
                const t = normalizeList(x.tags || []);
                let d = false;
                for (const k of x.keywords) { const kk = String(k || '').trim(); if (kk && !t.includes(kk)) { t.push(kk); d = true; } }
                if (d) { x.tags = t; changed = true; }
            }
        }
    };
    mergeKwHist(s.atoms); mergeKwHist(s.memories); mergeKwHist(s.concepts);
    mergeKwHist(s.plans); mergeKwHist(s.suspense); mergeKwHist(s.scenes); mergeKwHist(s.currentStates);
    // 旧版 processedFloors（纯数字数组）→ 哈希标记对象；补 lastKnownFloor
    if (Array.isArray(s.processedFloors) && s.processedFloors.length && typeof s.processedFloors[0] !== 'object') {
        s.processedFloors = s.processedFloors.map(f => ({ f: Number(f), h: '' })).filter(x => Number.isFinite(x.f));
        changed = true;
    }
    if (s.lastKnownFloor === undefined) { s.lastKnownFloor = -1; changed = true; }
    // 已完结计划/已揭晓悬念只留统计 —— 存量 status='closed' 条目迁移为纯计数后原文删除（旧版仅标记不删）
    if ((Array.isArray(s.plans) && s.plans.some(x => x && x.status === 'closed')) || (Array.isArray(s.suspense) && s.suspense.some(x => x && x.status === 'closed'))) {
        s.stats = s.stats || { plansClosed: 0, suspenseResolved: 0 };
        const pc = (s.plans || []).filter(x => x && x.status === 'closed').length;
        const sr = (s.suspense || []).filter(x => x && x.status === 'closed').length;
        if (pc) { s.plans = s.plans.filter(x => !(x && x.status === 'closed')); s.stats.plansClosed = Number(s.stats.plansClosed || 0) + pc; changed = true; }
        if (sr) { s.suspense = s.suspense.filter(x => !(x && x.status === 'closed')); s.stats.suspenseResolved = Number(s.stats.suspenseResolved || 0) + sr; changed = true; }
    }
    if (changed) s.version = VERSION;
    // 同内容跨端去重（情节 id 含楼层 → 两端/历史可能攒出「同文异 id」重复；载入即收敛，
    //   只保留较新/较全一条并并 floor 区间/uses）
    try {
        const dims = ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels'];
        for (const cat of dims) {
            if (Array.isArray(s[cat]) && s[cat].length > 1) {
                const before = s[cat].length;
                s[cat] = contentDedupeArray(cat, s[cat]);
                if (s[cat].length !== before) changed = true;
            }
        }
    } catch (e) { }
    if (changed) s.version = VERSION;
    // v1.165：通用知情关联层归一（容器 / 非法行 / how 合法子集 / 去重 / 超限截断；幂等）
    try { if (typeof migrateRelLinks === 'function' && migrateRelLinks(s)) changed = true; } catch (e) { }
    // v1.165：计划 / 悬念 / 平行事件结构化字段（幂等补默认）
    try { if (typeof migratePlanSuspV1165 === 'function' && migratePlanSuspV1165(s)) changed = true; } catch (e) { }
    if (changed) s.version = VERSION;
    return s;
}

// v1.165：计划 / 悬念 / 平行事件的结构化字段迁移（幂等）——只补空容器与可由既有字段推出的初值，
//   绝不臆造内容（历史不由正文倒推、线索不凭空生成、来源不自动推断）；总开关关闭时不动。

export { migrateState, migratePlanSuspV1165, migrateRelLinks, contentPickBest, contentDedupeArray, recallDateNum };
