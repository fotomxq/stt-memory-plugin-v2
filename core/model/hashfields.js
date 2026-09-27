// ============================================================
// core/model/hashfields.js —— **哈希字段元数据（单一事实源）**
// 依据：`docs/D8-内容哈希与瘦身白名单设计稿.md`（v0.4）
//   · **身份哈希**（`atomIdentityHash`，R1=B 的「认人」侧）：4 基本槽 + 3 扩展槽（标题/日期/内容/地点·如有/标签/类型/状态·如有）；
//   · **变更哈希**（`atomContentHash`，R1=B 的「看变化」侧）：沿用 V1 逐维字段表，行为零改动（快照差异 / 情节签名用）；
//   · **瘦身白名单**（`core/slim.js#SLIM_HASHED_FIELDS`）由本表**派生**（R16），消除两张手写表的漂移（D8 §5.2 F2）。
// 口径：
//   · 本表只登记**字段名**，不登记变换（重命名/映射/拼接仍写在 `hash.js` 的实现里）；
//   · `tests/unit/hash-fields-sync.test.js` 会核对「本表登记的字段名都能在 `hash.js` 对应分支里找到」→ 防漂移；
//   · 集合类字段（标签等）在身份哈希里**先排序再拼**（D8 R3），保证跨端同内容同哈希。
// ============================================================

/** 身份哈希**口径前缀**（D8 R19：跨端异口径 → 前缀不同即跳过内容去重，只按 id 合并） */
export const IDENTITY_HASH_PREFIX = 'i2:';

/** 身份哈希里的**具名变换**（不是真实字段名；派生白名单时跳过） */
export const IDENTITY_TRANSFORM_NAMES = Object.freeze(['stepsText', 'cluesText', 'linesText']);

/** 身份哈希槽位顺序（固定，参与 `storageHash` 的键序） */
export const IDENTITY_SLOTS = Object.freeze(['title', 'date', 'content', 'loc', 'tags', 'type', 'status']);

/**
 * **身份哈希**各维槽位 → 源字段（D8 §4.2 映射表 + R2–R12 裁决）。
 * 说明：值为字符串数组；数组元素可能是「字段名」或实现里的**具名变换**（见 `hash.js` 的 `ID_TRANSFORMS`）。
 */
export const IDENTITY_FIELDS = Object.freeze({
    atoms: { title: ['title'], date: ['date'], content: ['text'], loc: ['locations'], tags: ['tags'], type: ['type'], status: ['validity'] },
    memories: { title: ['title', 'owner'], date: ['date'], content: ['content'], tags: ['tags'], type: ['memCategory'] },
    snapshots: { title: ['name'], content: ['content'], tags: ['tags'] },
    items: { title: ['name'], content: ['desc'], loc: ['location'], tags: ['tags'] },
    concepts: { title: ['name'], date: ['date'], content: ['content'], tags: ['tags'] },
    scenes: { title: ['name'], content: ['desc'], loc: ['pathArr'] },
    plans: { title: ['title'], content: ['content', 'stepsText'], tags: ['tags'], status: ['status'] },
    suspense: { title: ['title'], content: ['content', 'cluesText'], tags: ['tags'], status: ['status'] },
    parallels: { title: ['title'], date: ['date'], content: ['text'], loc: ['location'], tags: ['tags'], type: ['type'] },
    rumors: { title: ['subject'], content: ['content'], tags: ['tags'], status: ['stage'] },
    plotSegments: { title: ['header'], date: ['start', 'end'], content: ['linesText'] },
    currentStates: { title: ['subject', 'field'], content: ['value'], status: ['status'] },
    // 关联层（D8 R11：引用型无四槽语义 → **保留现字段集为例外**，由 hash.js 的既有分支承担）
    links: { title: ['refId'] },
    // 货币（D8 R11：暂不纳入身份哈希）
    currencies: {},
});

/**
 * **变更哈希**字段表（= V1 逐维表，`core/model/hash.js#atomContentHash` 的实现口径）。
 * 用途：① 瘦身白名单派生（与身份字段取**并集**，见 D8 D-S4）；② 与 hash.js 的漂移核对测试。
 */
export const HASH_FIELDS = Object.freeze({
    atoms: ['text', 'title', 'date', 'time', 'type', 'entities', 'locations', 'tags'],
    currentStates: ['subject', 'field', 'value', 'status'],
    snapshots: ['name', 'identity', 'appearance', 'personality', 'background', 'relationships', 'mind', 'social', 'future', 'location'],
    memories: ['owner', 'date', 'title', 'content', 'memCategory', 'tags'],
    items: ['name', 'qty', 'desc', 'location', 'carried', 'tags'],
    plans: ['content', 'tags', 'status', 'title', 'targetTime', 'resolveTime', 'planner', 'participants', 'progress', 'steps', 'prereq', 'blockers', 'history', 'phase', 'statusNote'],
    suspense: ['content', 'tags', 'status', 'title', 'targetTime', 'resolveTime', 'planner', 'participants', 'progress', 'clues', 'resolveCondition', 'level', 'history', 'phase', 'statusNote'],
    scenes: ['name', 'pathArr', 'desc'],
    concepts: ['name', 'content', 'source', 'date', 'tags'],
    parallels: ['title', 'text', 'date', 'gua', 'causalLine', 'characters', 'location', 'goalOdds', 'tags', 'promotedTo'],
    links: ['dim', 'refId', 'who', 'how', 'from', 'at', 'view', 'deviation', 'note', 'kind', 'public'],
    plotSegments: ['header', 'start', 'end', 'lines'],
    rumors: ['subject', 'content', 'objectivity', 'stage', 'ferment', 'carriers', 'media', 'chain', 'source', 'tags', 'parallelRefs', 'pending', 'lineage'],
});

/**
 * 瘦身白名单 = **变更字段 ∪ 身份字段**（D8 D-S4）。
 * 它只用于「同义字段组保留哪一份」（keeper），**不决定**字段是否保存（D8 §5.1）。
 */
export function slimWhitelistOf(cat) {
    const out = [];
    const push = (f) => { if (f && out.indexOf(f) < 0) out.push(f); };
    for (const f of (HASH_FIELDS[cat] || [])) push(f);
    const idf = IDENTITY_FIELDS[cat] || {};
    for (const slot of IDENTITY_SLOTS) {
        for (const f of (idf[slot] || [])) {
            if (IDENTITY_TRANSFORM_NAMES.indexOf(f) >= 0) continue;   // 具名变换不是字段
            push(f);
        }
    }
    return out;
}

/** 哈希口径前缀（无前缀 = 升级前的旧口径；见 D8 R19） */
export function hashPrefixOf(h) {
    const s = String(h || '');
    const i = s.indexOf(':');
    return i > 0 ? s.slice(0, i + 1) : '';
}
