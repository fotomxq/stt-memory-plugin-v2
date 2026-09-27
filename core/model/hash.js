// ============================================================
// core/model/hash.js —— **逐字移植自 V1**（V1 src/modules/05-记忆状态与存储抽象.js `atomContentHash`）
// 移植口径：算法与字段名保持与 V1 完全一致（保证 V1 数据可导入、跨端哈希一致）；
//   仅做两处适配：① 去掉 IIFE/全局依赖，改为 ESM 显式导入；② `cfg.dimCharLimits` 改为可注入的维度上限表。
// 一致性由 tests/unit/model-golden.test.js 使用 V1 源码切片产出的黄金样本强制校验。
// ============================================================
import { storageHash } from './scalars.js';
import { IDENTITY_FIELDS, IDENTITY_SLOTS, IDENTITY_HASH_PREFIX, hashPrefixOf } from './hashfields.js';

/**
 * 变更哈希（= 既有 `atomContentHash`，**行为零改动**）：用于**看变化** —— 增量快照差异、情节签名。
 * 逐维自定义字段表（V1 口径）；`docs/D8` R1 裁决 = B（两个指纹），本函数即「变更指纹」。
 */
function atomChangeHash(cat, a) { return atomContentHash(cat, a); }


function atomContentHash(cat, a) {
    try {
        if (!a || typeof a !== 'object') return '';
        const o = {};
        // 哈希对「被省略的空值」容错 —— 存储瘦身会把 ''/[]/0/false 等默认值不写盘，
        //   读入后这些字段可能缺失；若哈希把它们当成 undefined，同一内容在两端/两个版本间会算出不同哈希
        //   （跨端去重、快照差异、删除墓碑都会失准）。这里统一归一化：缺失 ≡ 空字符串/空数组/0/false。
        const S = (v) => (v === undefined || v === null ? '' : String(v));
        const A = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]));
        const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        const B = (v) => (v === true);
        if (cat === 'atoms') { o.t = S(a.text); o.title = S(a.title); o.d = S(a.date); o.time = S(a.time); o.type = S(a.type); o.ent = A(a.entities); o.loc = A(a.locations); o.tags = A(a.tags); }
        else if (cat === 'currentStates') { o.s = S(a.subject); o.f = S(a.field); o.v = S(a.value); o.st = S(a.status); }
        else if (cat === 'snapshots') { o.n = S(a.name); o.ident = S(a.identity); o.appear = S(a.appearance); o.pers = S(a.personality); o.bg = S(a.background); o.rel = S(a.relationships); o.mind = S(a.mind); o.soc = S(a.social); o.fut = S(a.future); o.loc = S(a.location); }
        // v1.165：通用知情关联层 —— 参与内容哈希的字段（**引用类字段不进哈希**：概念改名 / 情节修订 / 计划合并不引发跨端抖动）
        else if (cat === 'links') { o.dim = S(a.dim); o.ref = S(a.refId); o.who = S(a.who); o.how = S(a.how); o.from = S(a.from); o.at = S(a.at); o.view = S(a.view); o.dev = S(a.deviation); o.note = S(a.note); o.kind = S(a.kind); o.pub = B(a.public); }
        else if (cat === 'memories') { o.owner = S(a.owner); o.d = S(a.date); o.title = S(a.title); o.content = S(a.content); o.cat = S(a.memCategory); o.tags = A(a.tags); }
        else if (cat === 'items') { o.name = S(a.name); o.qty = N(a.qty); o.desc = S(a.desc); o.loc = S(a.location); o.carried = B(a.carried); o.tags = A(a.tags); }   // 标签参与内容哈希（标签变更 → 快照/同步识别为更新）
        else if (cat === 'plans' || cat === 'suspense') {
            o.content = S(a.content); o.tags = A(a.tags); o.st = S(a.status);
            // v1.165：结构化扩展字段参与内容哈希（引用类字段不进 —— 避免跨维度改名/合并引发抖动）
            o.title = S(a.title); o.goal = S(a.targetTime || a.resolveTime);
            o.planner = S(a.planner); o.part = A(a.participants); o.prog = N(a.progress);
            o.steps = A((a.steps || []).map(x => (x && (x.text || '')) + (x && x.done ? '✓' : '')));
            o.prereq = S(a.prereq); o.block = A(a.blockers);
            o.hist = A((a.history || []).map(x => String((x && x.at) || '') + ':' + String((x && x.text) || '') + ':' + String((x && x.result) || '')));
            o.clues = A((a.clues || []).map(x => String((x && x.at) || '') + ':' + String((x && x.text) || '') + ':' + String((x && x.by) || '')));
            o.resc = S(a.resolveCondition); o.level = S(a.level);
            // v1.166：阶段 / 状态备注（空值 ≡ 缺失 → 旧数据哈希不变，零跨端抖动）
            o.phase = S(a.phase); o.snote = S(a.statusNote);
        }
        else if (cat === 'scenes') { o.name = S(a.name); o.path = A(a.pathArr).length ? A(a.pathArr) : (a.pathStr ? String(a.pathStr).split('>') : []); o.desc = S(a.desc); }
        else if (cat === 'concepts') { o.name = S(a.name); o.content = S(a.content); o.source = S(a.source); o.d = S(a.date); o.tags = A(a.tags); }
        else if (cat === 'parallels') { o.t = S(a.title || a.text); o.d = S(a.date); o.desc = S(a.text); o.gua = S(a.gua); o.causal = S(a.causalLine); o.chars = A(a.characters); o.loc = S(a.location); o.goals = a.goalOdds === undefined || a.goalOdds === null ? '' : a.goalOdds; o.tags = A(a.tags); o.promoted = S(a.promotedTo); }   // v1.165：转正标记入哈希（来源引用不进）
        // v1.191：情节分段总结 —— 参与哈希的是「时间范围 + 逐条剧情线」；raw 为派生文本、atomIds 为引用、
        //   manual 为界面标记，均**不进哈希**（避免改名/重挂引用/手动标记引发跨端抖动）
        else if (cat === 'plotSegments') { o.header = S(a.header); o.start = S(a.start); o.end = S(a.end); o.lines = A((a.lines || []).map(x => S((x && x.label) || '') + '：' + S((x && x.text) || ''))); }
        // v1.192：传言 —— 参与哈希的是「实质状态」（主体 / 当前说法 / 客观性 / 阶段与发酵度 / 传播者 / 载体 /
        //   传导链路 / 谱系 / 联动引用）。链路项**不含轮次号**（各端轮次计数可能不同，会让同一条在两端算出差哈希），
        //   进行中的变化只记「类型 + 所需轮次」（进度不记）。运行时字段（uses/楼层/时间戳/h）一律不进。
        else if (cat === 'rumors') {
            o.subject = S(a.subject); o.content = S(a.content); o.obj = S(a.objectivity);
            o.stage = S(a.stage); o.ferment = N(a.ferment);
            o.carriers = A((a.carriers || []).map(x => S((x && (x.who || x.name)) || '') + ':' + S((x && x.role) || '')));
            o.media = A((a.media || []).map(x => S((x && x.type) || '') + ':' + S((x && x.name) || '') + ':' + S((x && x.at) || '') + ':' + (x && x.active === false ? '0' : '1') + ':' + N(x && x.durability)));
            o.chain = A((a.chain || []).map(x => S((x && x.kind) || '') + '@' + S((x && x.at) || '') + ':' + S((x && x.from) || '') + '>' + S((x && x.to) || '') + ':' + S((x && x.note) || '')));
            o.src = S(a.source);
            o.tags = A(a.tags);
            o.par = A(a.parallelRefs);
            o.pend = (a.pending && typeof a.pending === 'object') ? S((a.pending.kind || '') + ':' + N(a.pending.need)) : '';
            o.lin = S((a.lineage && a.lineage.rootId) || '') + '|' + S((a.lineage && a.lineage.parentId) || '') + '|' + A((a.lineage && a.lineage.children) || []);
        }
        else { return ''; }
        return storageHash(o);
    } catch (e) { return ''; }
}
// ==================== 同内容跨端去重 ====================
// 背景：原子条目（尤其情节 atoms）id 由 文本+起始/结束楼层 派生；两端各自楼层不同 → 同一剧情内容在
//   手机/PC 生成不同 id。跨端合并按 id 判「两端独有」→ 每次同步并集都把这些“同文异 id”拷贝再攒一份，
//   造成 条数/大小 持续漂移（如 1179/1.14MB vs 1384/3.26MB）。
// 修复：以「内容哈希（atomContentHash，已剔除 id/楼层/uses 等易变项）」为同一性判据 ——
//   同类别内内容相同（不同 id）只保留较新/较全的一条（updatedAt → 剧情日期 → 楼层 → 清单靠后），
//   floorStart/End 并区间、uses 累计；应用于 ①载入/迁移时清理本端历史重复 ②跨端合并后收敛两端。

export { atomContentHash };

// ==================== 身份哈希（v2.86.0；`docs/D8` R1=B 的「认人」侧） ====================
// 依据 `docs/D8` §4：**4 基本槽 + 3 扩展槽**（标题 / 日期 / 内容 / 地点·如有 / 标签 / 类型 / 状态·如有）。
//   · 用途：跨端同内容去重、载入去重、**内容墓碑**（删除不复活）、复活防护、控制台显示；
//   · 与变更哈希**互补**：身份要「迟钝」（细节改动不该变成新条目），变更要「敏感」（改动必须被发现）；
//   · 集合类字段（标签等）**先排序再拼**（R3）→ 跨端同内容必得同哈希；
//   · 带口径**前缀** `i2:`（R19）：跨端遇异口径一律按「不同前缀 → 跳过内容去重」处理；
//   · 字段名登记在 `core/model/hashfields.js#IDENTITY_FIELDS`（单一事实源），本函数负责取值与变换。

/** 具名变换：把一个或多个源字段折算成某个槽位的字符串（键 = `IDENTITY_FIELDS` 里的名字） */
const ID_TRANSFORMS = {
    // 计划 / 悬念：内容槽并入步骤 / 线索文本（D8 R7）
    stepsText: (a) => (Array.isArray(a.steps) ? a.steps : []).map((x) => String((x && x.text) || '') + (x && x.done ? '✓' : '')).join('|'),
    cluesText: (a) => (Array.isArray(a.clues) ? a.clues : []).map((x) => String((x && x.text) || '')).join('|'),
    // 分段总结：逐条剧情线（有序）
    linesText: (a) => (Array.isArray(a.lines) ? a.lines : []).map((x) => String((x && x.label) || '') + '：' + String((x && x.text) || '')).join('|'),
};

/** 集合类字段（先排序再拼，R3）：这些字段按「集合」语义参与身份哈希 */
const ID_SET_FIELDS = { tags: true, locations: true, pathArr: true, entities: true, characters: true, participants: true };

/** 槽位取值：单值 → 字符串；数组 → 集合排序或按序拼接（D8 §4.1「沿用现归一化：缺失 ≡ ''/[]」） */
function idSlotValue(name, a) {
    const S = (v) => (v === undefined || v === null ? '' : String(v));
    if (ID_TRANSFORMS[name]) { try { return S(ID_TRANSFORMS[name](a || {})); } catch (e) { return ''; } }
    const v = a ? a[name] : undefined;
    if (Array.isArray(v)) {
        const list = v.map((x) => (x && typeof x === 'object' ? S(x.name || x.text || x.who || '') : S(x))).filter((x) => x !== '');
        return (ID_SET_FIELDS[name] ? list.slice().sort() : list).join('|');
    }
    if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return ''; } }
    return S(v);
}

/**
 * **身份哈希**（`i2:` 前缀 + 键序固定的槽位表）：
 *   · 未登记的维度（如货币）→ `''`：不参与身份判定（沿用「无分支 → ''」口径）；
 *   · 四槽位 + 三扩展槽**全空** → 仍返回哈希（空内容也有身份），与变更哈希的 `''` 语义区分开。
 */
function atomIdentityHash(cat, a) {
    try {
        if (!a || typeof a !== 'object') return '';
        const spec = IDENTITY_FIELDS[cat];
        if (!spec) return '';
        // 空表（如货币，D8 R11「暂不纳入」）→ 不参与身份判定
        if (!IDENTITY_SLOTS.some((sl) => Array.isArray(spec[sl]) && spec[sl].length)) return '';
        // 关联层（D8 R11）为例外：引用型无四槽语义 → 直接复用变更哈希的字段集（前缀区分口径）
        if (cat === 'links') {
            const raw = atomContentHash(cat, a);
            return raw ? (IDENTITY_HASH_PREFIX + raw) : '';
        }
        // 兼容**未归一化的历史数据**（V1 导入 / 旧存档 / 旧版对端载荷）：角色档案的内容副本尚未生成时，
        //   身份指纹退化为「变更指纹」（仍带 `i2:` 前缀），避免「同名但字段不同的两条档案」被误判为同一条。
        if (cat === 'snapshots' && idSlotValue('content', a) === '') {
            const raw = atomContentHash(cat, a);
            return raw ? (IDENTITY_HASH_PREFIX + 'legacy:' + raw) : '';
        }
        const o = {};
        for (const slot of IDENTITY_SLOTS) {
            const names = spec[slot];
            if (!names || !names.length) continue;
            const parts = [];
            for (const n of names) { const v = idSlotValue(n, a); if (v !== '') parts.push(n + '=' + v); }
            if (parts.length) o[slot] = parts.join('&');
        }
        return IDENTITY_HASH_PREFIX + storageHash(o);
    } catch (e) { return ''; }
}

export { atomIdentityHash, atomChangeHash, hashPrefixOf, IDENTITY_HASH_PREFIX };
