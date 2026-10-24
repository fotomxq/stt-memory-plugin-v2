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
    // 地图（v3.47.0 W16 数-22 / `docs/D27` §3.3 ③）：**与货币同口径，不纳入身份哈希** ——
    //   本维度 id 由内容派生（`mp_<层级|场所|上层|名称>` / `mr_<两端>`），跨端同一条算得**同一 id** → 以 **id 墓碑**为准；
    //   把 `sceneRef`/`parentId`/`fromId`/`toId` 塞进身份槽会把**引用**带进指纹（违反 `02` §2 I3），
    //   且 `route` 无 `name`/`desc` —— 空身份会让**两条不同路径算出同一 hash**、删除墓碑互相误伤。故登记为「不进」。
    maps: {},
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
    // v3.47.0（W16 数-22）：**内容类字段进哈希**（`docs/D27` §3.3 ③ 原文列出的六项 + `kind` 判别位）；
    //   **引用类不进**（`sceneRef` / `parentId` / `fromId` / `toId` / `evidence`）—— 否则场景改名 / 重挂父级
    //   会引发跨端抖动（`02` §2 I3）。`traversed` / `inferred` 亦**不在**本表（见 `core/model/map.js` 头部口径③）。
    maps: ['kind', 'level', 'name', 'desc', 'distance', 'timeCost', 'direction'],
    // v3.51.0（`docs/D53` §3.6 ③）：**内容类进哈希、引用类不进** ——
    //   `ledger`：`date`/`delta`/`note`/`source` 进；`currencyId`（引用）/ `dealId`（引用）**不进**；
    //   `deals`：`name`/`desc`/`kind`/`status`/`startDate`/`endDate`/`cycle`/`outlook` 进；`currencyId` **不进**。
    ledger: ['date', 'delta', 'note', 'source'],
    deals: ['name', 'desc', 'kind', 'status', 'startDate', 'endDate', 'cycle', 'outlook'],
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

/**
 * **非哈希的规范字段**（v3.44.0，`docs/D22` W4 `数-10`）—— 登记在这里 = 「**刻意不进白名单**」有据可查。
 *
 * 背景：`数-10` 把「最后一次出现」的旧字段名收敛为规范名（`items.lastSeenDate` ← `seenDate`/`date`；
 *   `scenes.lastSeenFloor` ← `floorSeen`，见 `core/field-names.js`）。收敛后**旧名保留**（双写回退口径）。
 *
 * 为什么**不**把它们加进 `HASH_FIELDS` 或 `slimWhitelistOf`：
 *   · 加进 `HASH_FIELDS` = **改内容哈希** → 跨端会把它当「内容变了」而重复计条目、快照会误判差异；
 *     那属 `docs/D15` §3 **类别① 数据契约**，须 `DATA_VERSION` 递增 + 双端兼容，不在本批范围。
 *   · 加进「同义字段组」也不成立：`SLIM_SYNONYM_GROUPS` 的不变量（R3）是「keeper 必须落在白名单内」，
 *     而这两个字段都不是哈希字段 → 组内没有合法 keeper（`tests/unit/slim-keeper.test.js` A2 会当场变红）。
 *   · 于是它们**两个名字都存**（各是一个短字符串 / 整数，体积可忽略；空值由 `isSlimDefault` 丢弃）。
 * 这份登记的作用：下次有人看到「有规范字段却不在白名单里」，能一眼看到这是**决定**而不是漏改。
 */
export const NON_HASH_CANONICAL_FIELDS = Object.freeze({
    items: Object.freeze(['lastSeenDate']),
    scenes: Object.freeze(['lastSeenFloor']),
});
