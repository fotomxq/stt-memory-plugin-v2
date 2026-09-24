// ============================================================
// core/model/dims.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（各维度 normalize*））
// 移植口径：算法与字段名保持与 V1 完全一致（保证 V1 数据可导入、跨端哈希一致）；
//   仅做两处适配：① 去掉 IIFE/全局依赖，改为 ESM 显式导入；② `cfg.dimCharLimits` 改为可注入的维度上限表。
// 一致性由 tests/unit/model-golden.test.js 使用 V1 源码切片产出的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { dimCap, mergeTags, makeExtra, normStrList, normSteps, normHistory, normIdList, normPhase, normClues, scenePathArr, toChineseField, toChineseCategory } from './scalars.js';
import { cfg } from './runtime.js';

function normalizeCurrentState(e) {
    const subject = normText(e?.subject, 40);
    const field = toChineseField(normText(e?.field, 40));   // 状态字段中文兜底
    const value = dimCap('states', normText(e?.value, 2000));   // 内层限放宽，硬上限统一由 dimCap(cfg) 决定
    if (!subject || !field || !value) return null;
    const key = `${subject.toLowerCase()}::${field.toLowerCase()}`;
    const fs = Number(e?.floorStart);
    const fe = Number(e?.floorEnd);
    return {
        id: String(e?.id || `state_${hashText(key)}`),
        key, subject, field, value,
        status: e?.status === 'inactive' ? 'inactive' : 'active',
        importance: clamp(Number(e?.importance) || 0.6, 0, 1),
        floorStart: Number.isInteger(fs) && fs >= 0 ? fs : 0,
        floorEnd: Number.isInteger(fe) && fe >= 0 ? fe : 0,
        // 最后更新日期/时间（剧情时间；缺失时用现实时间）
        updatedAt: normText(e?.updatedAt, 10),
        updatedAtTime: normText(e?.updatedAtTime, 30),
        history: Array.isArray(e?.history) ? e.history.filter(h => h && h.value).map(h => ({ value: String(h.value).slice(0, 200), floorStart: Math.max(0, Number(h.floorStart) || 0), floorEnd: Math.max(0, Number(h.floorEnd) || 0) })) : [],
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'states',
        title: `${subject}·${field}`,
        content: value,
        strength: Math.round(clamp(Number(e?.importance) || 0.6, 0, 1) * 100),
        extra: makeExtra({ field, status: e?.status, updatedAt: e?.updatedAt, updatedAtTime: e?.updatedAtTime }),        };
}
// 记录状态的最后更新时刻（优先剧情时间，回退现实时间）

function normalizeMemory(e) {
    const owner = normText(e?.owner, 40) || '通用';
    const title = normText(e?.title, 60);
    const content = dimCap('memories', normText(e?.content || e?.text, 2000));
    if (!title && !content) return null;
    return {
        id: String(e?.id || `mem_${hashText(owner + title + content)}`),
        owner, date: normText(e?.date || '', 10), title, content,
        tags: mergeTags(e?.tags, e?.keywords),   // tags 统一
        keywords: [],
        memCategory: toChineseCategory(normText(e?.category || '一般', 20)),   // 记忆分类中文兜底（原子层 category 已被类目占用）
        importance: clamp(Number(e?.importance) || 0.5, 0, 1),
        floorStart: Math.max(0, Number(e?.floorStart) || 0),
        floorEnd: Math.max(0, Number(e?.floorEnd) || 0),
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'memories',
        title,
        content,
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ owner, category: e?.category, keywords: e?.keywords }),        };
}
// 概念（世界客观存在的理念/发现/领悟）

function normalizeConcept(e) {
    const name = normText(e?.name, 60);
    const content = dimCap('concepts', normText(e?.content || e?.text || e?.meaning, 2000));
    if (!name && !content) return null;
    return {
        id: String(e?.id || `con_${hashText(name + content)}`),
        name, content,
        source: normText(e?.source || e?.origin || '', 40),
        date: normText(e?.date || '', 10),
        tags: mergeTags(e?.tags, e?.keywords),   // tags 统一
        keywords: [],
        importance: clamp(Number(e?.importance) || 0.5, 0, 1),
        floorStart: Math.max(0, Number(e?.floorStart) || 0),
        floorEnd: Math.max(0, Number(e?.floorEnd) || 0),
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'concepts',
        title: name,
        content,
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ source: e?.source || e?.origin, keywords: e?.keywords }),        };
}
// ==================== 平行事件（正文之外、八卦推演的潜在事件）====================
// 结构：原子通用字段(title/text/type/date/time/tags/importance/uses/floor*) + 专属字段：
//   gua 卦象 / causalLine 因果线 / characters 涉及角色姓名 / location 发生地点 /
//   goalOdds 演化目标可能性[{target,likelihood 0-100}] / updatedAt 更新时间(内部毫秒)

function normalizeParallel(e) {
    try {
        if (!e || typeof e !== 'object') return null;
        const text = dimCap('parallels', normText(e.text || e.content || e.正文 || e.内容 || e.desc || '', 2000));
        const title = normText(e.title || e.标题 || text.slice(0, 30) || '', 60);
        const type = normText(e.type || '', 20);
        const date = normText(e.date || '', 10);
        const time = normText(e.time || '', 20);
        const gua = normText(e.gua || e.卦象 || '', 80);
        const causalLine = normText(e.causalLine || e.因果线 || '', 600);
        const characters = normalizeList(e.characters || e.涉及角色姓名 || e.涉及角色 || []);
        const location = normText(e.location || e.发生地点 || '', 60);
        const goalOdds = [];
        const gsrc = Array.isArray(e.goalOdds) ? e.goalOdds : (Array.isArray(e.演化目标可能性) ? e.演化目标可能性 : []);
        for (const g of gsrc) {
            if (!g || typeof g !== 'object') continue;
            const target = normText(g.target || g.目标 || '', 100);
            if (!target) continue;
            let like = Number(g.likelihood !== undefined ? g.likelihood : g.可能性);
            if (!Number.isFinite(like)) like = 0;
            goalOdds.push({ target, likelihood: clamp(Math.round(like), 0, 100) });
        }
        return {
            // AI/新增无 id 时按内容生成稳定 id（标题+正文+因果线），避免多条新增互相覆盖（此前空 id 全落到同一条）
            id: String(e.id || ('par_' + hashText(title + '|' + text + '|' + causalLine))),
            title, text, type, date, time, gua, causalLine, characters, location, goalOdds,
            updatedAt: Number(e.updatedAt) || Date.now(),
            tags: normalizeList(e.tags || []),
            importance: clamp(Number(e.importance) || 0.5, 0, 1),
            uses: Number(e.uses) || 0,
            floorStart: Number(e.floorStart) || 0,
            floorEnd: Number(e.floorEnd) || 0,
            // v1.165：来源引用（**只允许已发生的情节 / 记忆**；不得互为来源）/ 预演 / 转正标记
            ...(cfg && cfg.planStructEnabled === false ? {} : {
                sourceRefs: normalizeRelRefList(e.sourceRefs || e['关联来源'] || e['来源'], Math.max(1, Number(cfg && cfg.planRefsMax) || 12), ['atoms', 'memories']),
                previews: normStrList(e.previews || e['预演'], 6, 40),
                planRef: normText(e.planRef || '', 60),
                suspenseRef: normText(e.suspenseRef || '', 60),
                promotedTo: normText(e.promotedTo || e['转正'] || '', 60),
                promotedAt: normText(e.promotedAt || '', 40),
                constraintNote: normText(e.constraintNote || '', 60),
            }),
        };
    } catch (err) { return null; }
}

function normalizeItem(e) {
    const name = normText(e?.name, 40);
    if (!name) return null;
    const fs = Number(e?.floorStart), fe = Number(e?.floorEnd);
    return {
        id: String(e?.id || `item_${hashText(name)}`),
        name,
        qty: Number.isFinite(Number(e?.qty)) ? Number(e.qty) : undefined,
        desc: dimCap('items', normText(e?.desc, 2000)),
        location: normText(e?.location, 40),
        carried: e?.carried !== false,
        uses: Number(e?.uses) || 0,
        // 物品时间戳（同名单/多位置时取最新；由 AI 摘要落库时按楼层/剧情日期打标）
        floorStart: Number.isInteger(fs) && fs > 0 ? fs : 0,
        floorEnd: Number.isInteger(fe) && fe > 0 ? fe : 0,
        seenDate: normText(e?.seenDate || e?.date, 10),
        // 物品与记忆同规格携带 标签（触发关键词）
        tags: mergeTags(Array.isArray(e?.tags) ? e?.tags : splitListText(e?.tags), e?.keywords),   // 兼容数组与逗号文本
        keywords: [],
        // 原子层：标准化字段 + 可扩展插槽
        category: 'items',
        title: name,
        content: dimCap('items', normText(e?.desc, 2000)),
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ qty: e?.qty, location: e?.location, carried: e?.carried !== false, keywords: e?.keywords }),        };
}

function normalizePlan(e) {
    const content = dimCap('plans', normText(e?.content, 2000));
    if (!content) return null;
    // v1.165：结构化扩展（结构化总开关关闭时一律不写 —— 灰度/回退）
    const structOn = !(cfg && cfg.planStructEnabled === false);
    const stepsMax = Math.max(1, Number(cfg && cfg.planStepsMax) || 20);
    const histMax = Math.max(1, Number(cfg && cfg.planHistoryMax) || 30);
    const refsMax = Math.max(1, Number(cfg && cfg.planRefsMax) || 12);
    const status0 = e?.status === 'closed' ? 'closed' : 'open';
    const progress0 = (() => { const raw = e?.progress; const n = Number(typeof raw === 'string' ? raw.replace(/[^0-9.]/g, '') : raw); if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n))); return status0 === 'closed' ? 100 : 0; })();
    return {
        id: String(e?.id || `plan_${hashText(content)}`),
        kind: '计划',
        content,
        // 计划补原子层字段 —— 标题/时间/角色 与情节同级（注入与清单显式展示；无标题留空由展示层兜底）
        title: normText(e?.title || '', 60),
        date: normText(e?.date || '', 10),
        time: normText(e?.time || '', 20),
        characters: normalizeList(e?.characters || e?.entities || []),
        createdTime: normText(e?.createdTime, 40),
        targetTime: normText(e?.targetTime, 40),
        status: e?.status === 'closed' ? 'closed' : 'open',
        tags: mergeTags(e?.tags, e?.keywords),   // 计划补标签（检索用）
        importance: clamp(Number(e?.importance) || 0.5, 0, 1),
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'plans',
        content,
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        // v1.165：结构化扩展字段（计划：策划者 / 参与人 / 步骤 / 前提 / 阻碍 / 进度 / 进展历史 / 关联）
        ...(structOn ? {
            planner: normText(e?.planner || e?.['策划者'] || '', 40),
            participants: normStrList(e?.participants || e?.['参与人'], refsMax, 40),
            steps: normSteps(e?.steps || e?.['步骤'], stepsMax),
            prereq: normText(e?.prereq || e?.['前提'] || e?.['前提条件'] || '', 60),
            blockers: normStrList(e?.blockers || e?.['阻碍'], 8, 40),
            progress: progress0,
            history: normHistory(e?.history || e?.['进展'], histMax),
            suspenseRefs: normIdList(e?.suspenseRefs || e?.['关联悬念'], refsMax),
            memRefs: normIdList(e?.memRefs || e?.['关联记忆'], refsMax),
            atomRefs: normIdList(e?.atomRefs || e?.['关联情节'], refsMax),
            // v1.166：阶段（轻量状态机）+ 状态备注（不改 status 语义；status 若被写成中文阶段词则顺带当阶段线索）
            phase: normPhase(e?.phase || e?.['阶段'] || (e?.status !== 'open' && e?.status !== 'closed' && e?.status !== undefined ? e.status : '')),
            statusNote: normText(e?.statusNote || e?.['状态备注'] || e?.['阶段备注'] || '', 60),
        } : {}),
        extra: makeExtra({ kind: '计划', title: e?.title || '', date: e?.date || '', time: e?.time || '', characters: e?.characters || e?.entities || [], createdTime: e?.createdTime, targetTime: e?.targetTime, status: status0 }),        };
}

function normalizeSuspense(e) {
    const content = dimCap('suspense', normText(e?.content, 2000));
    if (!content) return null;
    const structOn2 = !(cfg && cfg.planStructEnabled === false);
    const cluesMax = Math.max(1, Number(cfg && cfg.cluesMax) || 20);
    const histMax2 = Math.max(1, Number(cfg && cfg.planHistoryMax) || 30);
    const refsMax2 = Math.max(1, Number(cfg && cfg.planRefsMax) || 12);
    const status1 = e?.status === 'closed' ? 'closed' : 'open';
    return {
        id: String(e?.id || `sus_${hashText(content)}`),
        kind: '悬念',
        content,
        // 悬念补原子层字段 —— 标题/时间/角色 与情节同级
        title: normText(e?.title || '', 60),
        date: normText(e?.date || '', 10),
        time: normText(e?.time || '', 20),
        characters: normalizeList(e?.characters || e?.entities || []),
        createdTime: normText(e?.createdTime, 40),
        resolveTime: normText(e?.resolveTime || '', 40),
        status: e?.status === 'closed' ? 'closed' : 'open',
        tags: mergeTags(e?.tags, e?.keywords),   // 悬念补标签
        importance: clamp(Number(e?.importance) || 0.5, 0, 1),
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'suspense',
        content,
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        // v1.165：结构化扩展字段（悬念：线索清单 / 揭晓条件 / 层级 / 推进历史 / 关联）
        ...(structOn2 ? {
            clues: normClues(e?.clues || e?.['线索'], cluesMax),
            resolveCondition: normText(e?.resolveCondition || e?.['揭晓条件'] || '', 60),
            level: (() => { const lv = normText(e?.level || e?.['层级'] || '', 10); return ['主线', '支线', '彩蛋'].indexOf(lv) >= 0 ? lv : ''; })(),
            history: normHistory(e?.history || e?.['进展'], histMax2),
            planRefs: normIdList(e?.planRefs || e?.['关联计划'], refsMax2),
            memRefs: normIdList(e?.memRefs || e?.['关联记忆'], refsMax2),
            atomRefs: normIdList(e?.atomRefs || e?.['关联情节'], refsMax2),
            // v1.166：阶段（轻量状态机）+ 状态备注
            phase: normPhase(e?.phase || e?.['阶段'] || (e?.status !== 'open' && e?.status !== 'closed' && e?.status !== undefined ? e.status : '')),
            statusNote: normText(e?.statusNote || e?.['状态备注'] || e?.['阶段备注'] || '', 60),
        } : {}),
        extra: makeExtra({ kind: '悬念', title: e?.title || '', date: e?.date || '', time: e?.time || '', characters: e?.characters || e?.entities || [], createdTime: e?.createdTime, resolveTime: e?.resolveTime, status: status1 }),        };
}

function normalizeNpc(e) {
    const name = normText(e?.name, 40);
    if (!name) return null;
    return {
        id: String(e?.id || `npc_${hashText(name)}`),
        name, gender: normText(e?.gender, 10), title: normText(e?.title, 40),
        desc: normText(e?.desc, 150), location: normText(e?.location, 40), follow: e?.follow === true,
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'snapshots',
        title: name,
        content: normText(e?.desc, 150),
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ gender: e?.gender, title: e?.title, location: e?.location, follow: e?.follow === true }),        };
}

function normalizeScene(e) {
    const name = normText(e?.name, 40);
    if (!name) return null;
    const pathArr = scenePathArr(e);
    const pathStr = pathArr.join('>');
    return {
        id: String(e?.id || `scene_${hashText(pathStr || name)}`),
        name, pathArr, pathStr, desc: dimCap('scenes', normText(e?.desc, 2000)),
        floorSeen: Math.max(0, Number(e?.floorSeen) || 0),
        uses: Number(e?.uses) || 0,
        // 原子层：标准化字段 + 可扩展插槽
        category: 'scenes',
        title: name,
        content: dimCap('scenes', normText(e?.desc, 2000)),
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ pathStr, floorSeen: e?.floorSeen }),        };
}
// 场景重复地址并集 —— 同路径（pathStr）多记录合并为一个（描述取更全者、uses/floorSeen 取大），
//   避免出现「第二个纽约」这类同层级重复节点；返回移除条数（调用方负责 saveState）

export { normalizeCurrentState, normalizeMemory, normalizeConcept, normalizeParallel, normalizeItem, normalizePlan, normalizeSuspense, normalizeNpc, normalizeScene };
