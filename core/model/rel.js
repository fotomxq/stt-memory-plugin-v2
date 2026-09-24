// ============================================================
// rel.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（v1.165 知情关联层 · 纯归一化与只读视图））
// 生成方式：从 V1 段 07 按**传递闭包**提取目标函数与其纯内部辅助（避免 try/catch 静默吞掉常量依赖）；
//   仅 ESM 化 + 注入视图（cfg/state）；碰宿主/迁移/UI 的部分**不在此层**（属批次 3 的状态与合并层）。
// 一致性由 tests/unit/model-golden3.test.js 的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { cfg, state } from './runtime.js';

function normalizeRelLink(raw, dimHint) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        const dim = relLinkDimOk(raw.dim) ? String(raw.dim) : (relLinkDimOk(dimHint) ? String(dimHint) : '');
        if (!dim) return null;
        const refId = normText(raw.refId || raw.ref || '', 60);
        if (!refId) return null;
        // 角色名读取顺序：who → name（中文键「姓名」经 normalizeDeltaKeys 后为 name）→ 角色
        const who = normText(raw.who || raw.name || raw['姓名'] || raw.role || '', 40);
        const anchor = !who;
        const legal = REL_LINK_HOW_LEGAL[dim] || [];
        let how = anchor ? '' : relLinkHow(raw.how, dim);
        let note = normText(raw.note, 40);
        // 越界（该 dim 不合法的方式）→ 已归一为「知情」并留痕（不丢关联）
        if (!anchor && legal.indexOf('unspecified') >= 0 && relLinkHowOutOfRange(raw.how, dim) && !note) note = '方式越界，已归一为知情';
        if (dim === 'parallels' && !anchor) how = 'related';
        const told = how === 'told';
        const out = {
            id: relLinkId(dim, refId, who),
            dim, refId, who, how,
            from: told ? normText(raw.from || raw.by, 40) : '',
            at: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.at || raw.time || raw.date || '').trim()) ? String(raw.at || raw.time || raw.date).trim() : '',
            view: normText(raw.view, 60),
            deviation: relLinkDeviation(raw.deviation),
            note,
            uses: Number(raw.uses) || 0,
            floorStart: Math.max(0, Number(raw.floorStart) || 0),
            floorEnd: Math.max(0, Number(raw.floorEnd) || 0),
            updatedAt: Number(raw.updatedAt) || 0,
        };
        // 条目级属性：仅锚行保留（非锚行强制清空，避免冗余分叉）
        if (anchor) {
            const kind = String(raw.kind || '').trim();
            out.kind = REL_LINK_KINDS.indexOf(kind) >= 0 ? kind : (dim === 'plans' ? 'plan' : (dim === 'suspense' ? 'suspense' : (dim === 'parallels' ? 'parallel' : '')));
            out.public = raw.public === true;
            out.conceptRef = normText(raw.conceptRef, 60);
            out.atomRef = normText(raw.atomRef, 60);
            out.planRef = normText(raw.planRef, 60);
            out.suspenseRef = normText(raw.suspenseRef, 60);
            out.memRefs = normalizeRelRefList(raw.memRefs, 12, ['memories']);
            out.sourceRefs = normalizeRelRefList(raw.sourceRefs, 12, ['atoms', 'memories']);
        }
        return out;
    } catch (e) { return null; }
}
// 某条目的全部关联行（按可靠度 + 角色字典序稳定排序；跳过孤儿）

function relSummaryLine(dim, refId, maxN) {
    try {
        const d = String(dim || ''), r = String(refId || '');
        const rows = relLinksOf(d, r);
        const anchor = rows.find(x => !x.who) || null;
        const people = rows.filter(x => x.who);
        const n = Math.max(1, Number(maxN) || 6);
        if (d === 'parallels') {
            return people.length ? `相关：${people.slice(0, n).map(x => x.who).join('、')}（角色不知情）` : '仅幕后（角色不知情）';
        }
        if (anchor && anchor.public) return (d === 'plans' ? '公开计划（人尽皆知）' : (d === 'suspense' ? '公开悬念（人尽皆知）' : '公开事实（人尽皆知）'));
        if (!people.length) return '';
        const order = ['author', 'involved', 'participant', 'witness', 'join', 'investigating', 'told', 'inferred', 'rumor', 'unspecified'];
        const groups = [];
        for (const how of order) {
            const list = people.filter(x => x.how === how);
            if (!list.length) continue;
            groups.push(`${relHowLabelOf(how)}：${list.slice(0, n).map(x => x.who).join('、')}`);
        }
        return groups.join(' · ');
    } catch (e) { return ''; }
}
// 孤儿统计（界面角标 / 修复报告 / 约束段自查共用）：
//   rows = 关联行指向的条目已不存在（渲染忽略）；items = 条目存在但一条关联都没有（孤儿条目）

function relLinksOf(dim, refId) {
    try {
        const d = String(dim || ''), r = String(refId || '');
        const arr = (state && state.links) || [];
        const list = arr.filter(x => x && String(x.dim) === d && String(x.refId) === r);
        list.sort((a, b) => {
            const ra = REL_LINK_HOW_RANK[a.how] || 0, rb = REL_LINK_HOW_RANK[b.how] || 0;
            if (ra !== rb) return rb - ra;
            return String(a.who || '').localeCompare(String(b.who || ''));
        });
        return list;
    } catch (e) { return []; }
}

function relOrphanStats() {
    const out = { rows: 0, items: 0, byDim: {}, itemDims: {} };
    try {
        const links = (state && state.links) || [];
        const dims = (typeof REL_LINK_DIMS !== 'undefined' && REL_LINK_DIMS.length) ? REL_LINK_DIMS : ['memories', 'plans', 'suspense', 'parallels'];
        const exists = (dim, refId) => ((state && state[dim]) || []).some(x => x && String(x.id) === String(refId));
        for (const r of links) {
            if (!r) continue;
            if (!exists(String(r.dim), String(r.refId))) { out.rows++; out.byDim[String(r.dim)] = (out.byDim[String(r.dim)] || 0) + 1; }
        }
        for (const dim of dims) {
            for (const it of ((state && state[dim]) || [])) {
                if (!it || !it.id) continue;
                const has = links.some(x => x && String(x.dim) === dim && String(x.refId) === String(it.id));
                if (!has) { out.items++; out.itemDims[dim] = (out.itemDims[dim] || 0) + 1; }
            }
        }
    } catch (e) { }
    return out;
}
// 关联维护（**修复管道零 AI 步骤**调用）—— 按 cfg.relOrphanAction 处置孤儿：
//   keep（默认）= 只统计并提示，绝不改动（历史数据不臆造关联）；
//   clean = 删除「目标条目已不存在」的孤儿关联行（留墓碑，跨端不复活）；
//   public = 先 clean，再给「一条关联都没有」的条目补锚行 public=true（转公开事实/公开计划；
//            平行事件恒不可见，不参与转公开）。

const REL_LINK_KINDS = ['fact', 'plan', 'suspense', 'parallel'];
// 关联行稳定 id：同维度 + 同条目 + 同角色唯一（跨端去重键）

function relLinkHowOutOfRange(v, dim) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return false;
    const hit = REL_LINK_HOW_CN[raw] || raw.toLowerCase();
    const legal = REL_LINK_HOW_LEGAL[dim] || [];
    return legal.indexOf(hit) < 0;
}

function normalizeDeltaKeys(delta) {
    if (Array.isArray(delta)) return delta.map(normalizeDeltaKeys);
    if (delta && typeof delta === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(delta)) {
            const nk = CN_KEY_MAP[k] || k;
            if (nk === 'vars') { out[nk] = v; continue; }
            out[nk] = normalizeDeltaKeys(v);
        }
        return out;
    }
    return delta;
}

// ==================== 配置 ====================

function relLinkDeviation(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return 'unknown';
    const zh = REL_LINK_DEVIATION_CN[raw];
    const hit = String(zh || raw).toLowerCase();
    return REL_LINK_DEVIATION.indexOf(hit) >= 0 ? hit : 'unknown';
}
// 引用项归一（{dim, refId} 数组；用于平行事件来源）

function relLinkId(dim, refId, who) { return 'lnk_' + hashText(String(dim || '') + '|' + String(refId || '') + '|' + String(who || '')); }

const REL_LINK_HOW_LEGAL = {
    memories: ['participant', 'witness', 'told', 'inferred', 'rumor', 'unspecified'],
    plans: ['author', 'join', 'told', 'inferred', 'investigating', 'unspecified'],
    suspense: ['involved', 'investigating', 'witness', 'told', 'inferred', 'rumor', 'unspecified'],
    parallels: ['related'],
};
// 可靠度（合并 / 上限截断取更可靠者；数值越大越可靠）

function normalizeRelRefList(v, limit, allowDims) {
    const out = [];
    const push = (o) => {
        if (!o || typeof o !== 'object') return;
        const d = String(o.dim || o.category || '').trim();
        const r = String(o.refId || o.id || o.ref || '').trim().slice(0, 60);
        if (!r) return;
        if (allowDims && allowDims.indexOf(d) < 0) return;
        if (!d) return;
        if (out.some(x => x.dim === d && x.refId === r)) return;
        out.push({ dim: d, refId: r });
    };
    (Array.isArray(v) ? v : []).forEach(push);
    return out.slice(0, Math.max(1, Number(limit) || 12));
}
// v1.165：计划 / 悬念 / 平行事件的结构化字段归一（上限取自 cfg；幂等；非法值丢弃）

function relLinkDimOk(dim) { return REL_LINK_DIMS.indexOf(String(dim || '')) >= 0; }

function relLinkHow(v, dim) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return 'unspecified';
    const zh = REL_LINK_HOW_CN[String(v == null ? '' : v).trim()];
    const hit = zh || s;
    const legal = REL_LINK_HOW_LEGAL[dim] || REL_LINK_HOW_LEGAL.memories;
    if (legal.indexOf(hit) >= 0) return hit;
    return legal.indexOf('unspecified') >= 0 ? 'unspecified' : legal[0];
}
// how 是否超出该 dim 的合法子集（用于判定是否需要记 note）

function relHowLabelOf(how) { try { return REL_LINK_HOW_LABEL[how] || '知情'; } catch (e) { return '知情'; } }

const REL_LINK_HOW_RANK = { author: 9, involved: 9, participant: 8, witness: 7, join: 7, investigating: 6, told: 5, unspecified: 4, inferred: 3, rumor: 2, related: 1 };

const REL_LINK_DIMS = ['memories', 'plans', 'suspense', 'parallels'];

const REL_LINK_HOW_CN = {
    '亲历': 'participant', '目击': 'witness', '被告知': 'told', '推断': 'inferred', '传闻': 'rumor', '知情': 'unspecified',
    '策划': 'author', '主导': 'author', '发起': 'author', '参与': 'join', '加入': 'join',
    '当事人': 'involved', '在查': 'investigating', '调查': 'investigating', '追查': 'investigating',
    '相关': 'related', '关联': 'related', '受影响': 'related',
};

const CN_KEY_MAP = {
    '当前状态': 'state', '情节': 'atoms', '状态记录': 'states', '角色档案': 'snapshots', '平行事件': 'parallels',
    '记忆库': 'memories', '物品库': 'items', '计划库': 'plans', '悬念库': 'suspense',
    '概念库': 'concepts', '概念': 'concepts', '平行事件': 'parallels',
    '名册': 'npcs', '场景库': 'scenes', '变量': 'vars',
    // v1.14 修复：SNAP_GROUP_MAP 必须在 loadState/migrateState 调用前初始化（TDZ），故置于此处
    '新增': 'add', '更新': 'update', '删除': 'remove', '重建': 'rebuild', '了结': 'close',
    '内容': 'text', '类型': 'type', '日期': 'date', '时间': 'time',
    '角色': 'entities', '地点': 'locations', '标签': 'tags', '关键词': 'keywords',
// v1.58 平行事件专属字段中文键：因果线/卦象/涉及角色姓名/发生地点/更新时间/演化目标可能性
'因果线': 'causalLine', '卦象': 'gua', '涉及角色姓名': 'characters', '涉及角色': 'characters', '发生地点': 'location', '演化目标可能性': 'goalOdds', '目标': 'target', '可能性': 'likelihood',
    '重要度': 'importance', '未了结': 'unresolved', '有效性': 'validity', '永久性': 'permanence',
    '所在位置': 'location', '时刻': 'time',
    '主体': 'subject', '字段': 'field', '值': 'value', '状态': 'status',
    '姓名': 'name', '性别': 'gender', '出生日期': 'birthDate', '年龄备注': 'ageNote',
    // v1.164：角色「已去世」开关（AI 输出「已去世」「是否死亡」都归一为 identity.deceased）
    '已去世': 'deceased', '是否死亡': 'deceased',
    '种族': 'species', '职业': 'occupation', '称号': 'title', '家族': 'family',
    '身高': 'height', '体型': 'build', '头发': 'hair', '眼睛': 'eyes', '肤色': 'skin', '特征': 'distinguishing',
    '性格特质': 'traits', '小癖好': 'quirks', '价值观': 'values', '说话风格': 'speechStyle',
    '出身': 'origin', '背景': 'history',
    '情绪': 'emotion', '当前目标': 'currentGoal', '担忧': 'concern',
    '与主角关系': 'relationToUser', '对主角态度': 'attitudeToUser',
    '待办': 'todos', '承诺': 'commitments',
    '城市': 'city', '区域': 'area', '建筑': 'building', '室内': 'interior',
    '关系列表': 'relationships', '关系名': 'name', '关系类型': 'relation', '态度': 'attitude',
    '身份': 'identity', '外貌': 'appearance', '性格': 'personality', '背景资料': 'background', '内心': 'mind', '社交': 'social', '未来': 'future', '位置': 'location',
    '归属': 'owner', '标题': 'title', '正文': 'content', '分类': 'category',
    // v1.165：通用知情关联层（AI 输出的「关联 / 知情者」数组 → relLinks；链路项字段归一）
    '关联': 'relLinks', '知情者': 'relLinks', '关联关系': 'relLinks',
    '方式': 'how', '知情方式': 'how', '告知者': 'from', '告知来源': 'from', '知情时间': 'at',
    '差异': 'view', '偏差': 'deviation', '备注': 'note',
    '记忆类型': 'kind', '公开': 'public',
    '关联概念': 'conceptRef', '关联情节': 'atomRef', '关联计划': 'planRef', '关联悬念': 'suspenseRef',
    '关联记忆': 'memRefs', '关联来源': 'sourceRefs',
    '来源': 'source',   // v1.165 补缺口：概念库「来源」此前未映射（AI 输出的来源会被丢弃）
    // v1.165：计划 / 悬念 / 平行事件的结构化扩展字段
    '策划者': 'planner', '参与人': 'participants', '步骤': 'steps', '前提': 'prereq', '前提条件': 'prereq',
    '阻碍': 'blockers', '进度': 'progress', '进展': 'history', '线索': 'clues', '揭晓条件': 'resolveCondition',
    // v1.166：计划 / 悬念「阶段」轻量状态机（进行中 / 受阻 / 放弃）与状态备注
    '阶段': 'phase', '状态备注': 'statusNote', '阶段备注': 'statusNote',
    '层级': 'level', '预演': 'previews', '转正': 'promotedTo',
    '名称': 'name', '数量': 'qty', '说明': 'desc', '携带': 'carried',
    // v1.181：货币大类（归属 / 币种 / 单位 / 额度 / 收支 / 备注）
    '货币': 'currencies', '归属': 'owner', '持有者': 'owner', '币种': 'name', '货币名': 'name', '单位': 'unit',
    '额度': 'amount', '持有额度': 'amount', '金额': 'amount', '余额': 'amount', '收支': 'history', '流水': 'history',
    '计划内容': 'content', '目标时间': 'targetTime', '悬念内容': 'content', '揭晓时间': 'resolveTime',
    '描述': 'desc', '随行': 'follow',
    '路径': 'path',
    // v1.95：概念修复「相似概念融合」—— AI 重建条目可附被并入的原条目（编号或名称）
    '合并自': 'mergedFrom',
    // v1.192：传言大类（主体 / 当前形态 / 客观性 / 传播者 / 载体 / 传导链路 / 分裂来源）
    //   说明：「主体」「来源」「正文」「标签」「日期」「重要度」复用既有映射，此处只补传言专属键。
    '传言': 'rumors', '传言库': 'rumors',
    '客观性': 'objectivity', '客观主观': 'objectivity',
    '传播者': 'carriers', '传播人': 'carriers', '传谣者': 'carriers', '听闻者': 'carriers',
    '载体': 'media', '传播载体': 'media', '传媒': 'media',
    '传导': 'chain', '传导链路': 'chain', '传播链路': 'chain', '传播过程': 'chain',
    '发酵度': 'ferment', '说法': 'content', '传言内容': 'content',
    '分裂自': 'splitFrom', '分裂来源': 'splitFrom', '演化自': 'splitFrom',
};
// v1.14 修复：SNAP_GROUP_MAP 必须在 loadState/migrateState 调用前初始化（TDZ），故置于 CN_KEY_MAP 之后

const REL_LINK_DEVIATION = ['accurate', 'partial', 'misconception', 'denial', 'unaware', 'unknown'];

const REL_LINK_DEVIATION_CN = { '准确': 'accurate', '片面': 'partial', '有误': 'misconception', '误解': 'misconception', '不信': 'denial', '否认': 'denial', '存疑': 'unaware', '未知': 'unknown' };

const REL_LINK_HOW_LABEL = { participant: '亲历', witness: '目击', told: '被告知', inferred: '推断', rumor: '传闻', unspecified: '知情', author: '策划', join: '参与', involved: '当事人', investigating: '在查', related: '相关' };

const SNAP_GROUP_MAP = {
    gender: 'identity', birthDate: 'identity', ageNote: 'identity', species: 'identity', occupation: 'identity', title: 'identity', family: 'identity',
    deceased: 'identity',   // v1.164：已去世开关归入身份组
    height: 'appearance', build: 'appearance', hair: 'appearance', eyes: 'appearance', skin: 'appearance', distinguishing: 'appearance',
    traits: 'personality', quirks: 'personality', values: 'personality', speechStyle: 'personality',
    origin: 'background', history: 'background',
    emotion: 'mind', currentGoal: 'mind', concern: 'mind',
    relationToUser: 'social', attitudeToUser: 'social',
    todos: 'future', commitments: 'future',
    city: 'location', area: 'location', building: 'location', interior: 'location',
};

// B8-6b+ 关联维护：以下常量/助手供 `core/rel-maint.js`（修复管道零 AI 步骤）复用
export {
    normalizeRelRefList, normalizeRelLink, relSummaryLine, relLinksOf, relOrphanStats,
    REL_LINK_KINDS, REL_LINK_DIMS, REL_LINK_HOW_RANK,
    relLinkId, relLinkHow, relLinkDeviation,
};
