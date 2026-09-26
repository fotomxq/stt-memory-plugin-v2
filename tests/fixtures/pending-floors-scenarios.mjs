// ============================================================
// tests/fixtures/pending-floors-scenarios.mjs —— 「未摘要楼层跳过机制」oracle 与单测**共用**的场景表
// 用途：`gen-v1-golden-pending-floors.cjs`（真实 V1 v1.206 + 真实 V2）与 `tests/unit/pending-floors.test.js`
//   （实时复算 V2）读同一份场景，避免两侧各写一份而悄悄漂移。
// 场景字段：name / note / pre（算旧哈希的历史聊天，可选）/ marksFromPre / chat / marks / processedVer /
//   lastId / dims（记忆维度数据）/ expect（人读期望）/ deviation（与 V1 的差异说明，可空）。
//   `marks[].h === null` = 「已处理且内容未变」→ 两侧各自用当前哈希补齐。
// ============================================================

/** 合成楼层构造 */
export const ai = (mes, swipes) => ({ is_user: false, role: 'assistant', mes: mes, swipes: swipes || null });
export const user = (mes) => ({ is_user: true, role: 'user', mes: mes, swipes: null });
export const hidden = (mes) => ({ is_user: false, role: 'assistant', is_hidden: true, mes: mes, swipes: null });
export const F8 = (i) => ai(`第${i}楼：角色甲在仓库与码头之间来回奔忙，清点了三箱货物并记下两页账目。`);

export const ALL_DIMS = ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'currencies', 'plotSegments', 'rumors', 'links'];

export const SCENARIOS = [
    {
        name: 'relocate',
        note: '索引错位（顶部插入新楼）：旧标记指向的正文整体后移 → 哈希归位对账应把标记挪到新索引',
        pre: [ai('甲在仓库找到木箱。'), ai('乙在码头等待船只。'), ai('丙沿山道追踪脚印。')],
        marksFromPre: true,
        chat: [ai('【新增】开场独白：雨夜的城镇静得反常。'), ai('甲在仓库找到木箱。'), ai('乙在码头等待船只。'), ai('丙沿山道追踪脚印。'), F8(4), F8(5)],
        lastId: 5,
        expect: { v2: [0, 4, 5], marksAfter: [1, 2, 3] },
        deviation: 'V1 只在条数变化时写回归位结果（顶部插入新楼后标记仍指旧楼层号，1/2/3 楼被重复列为未摘要）；V2 只要归位结果不同就写回',
    },
    {
        name: 'skip-basic',
        note: '基础跳过：用户楼 / 隐藏楼 / 占位楼（…）不列；台账已处理楼不列；其余列出',
        chat: [F8(0), user('（玩家输入）我去仓库看看。'), ai('…'), F8(3), hidden('（隐藏楼）'), F8(5), F8(6)],
        marks: [{ f: 3, h: null }],
        lastId: 6,
        expect: { v2: [0, 5, 6], marksAfter: [3] },
        deviation: '',
    },
    {
        name: 'html-only',
        note: '正文只有 HTML 标签：V1 会列出，V2 视为无可分析内容',
        chat: [F8(0), ai('<br><div></div>'), ai('   '), F8(3)],
        lastId: 3,
        expect: { v2: [0, 3], marksAfter: [] },
        deviation: 'V2 v2.44.0 起在投喂前去除 HTML 标签（宿主层 `cleanText`），纯标签正文 → 无可分析内容；V1 不去标签故会列出',
    },
    {
        name: 'range-0-0',
        note: '区间 0/0 = 「区间未知」（默认值）→ 不作为覆盖证据；有明确区间的条目才跳过该楼',
        chat: [F8(0), F8(1), F8(2), F8(3), F8(4), F8(5)],
        lastId: 5,
        dims: {
            atoms: [{ id: 'a0', text: '开场独白的雨夜描述，城镇静得反常。', floorStart: 0, floorEnd: 0 }],
            memories: [{ id: 'm3', owner: '甲', title: '账目', content: '三箱货物两页账。', floorStart: 3, floorEnd: 3 }],
        },
        expect: { v2: [0, 1, 2, 4, 5], marksAfter: [], covered: [3] },
        deviation: 'V2 新增「已有记忆数据 → 跳过」：memories 3-3 覆盖第 3 楼；atoms 0/0 视为区间未知、不作证据（第 0 楼仍列出）',
    },
    {
        name: 'covered-by-atoms',
        note: '用户要求：已有情节数据的楼层不再列为未摘要',
        chat: [F8(0), F8(1), F8(2), F8(3), F8(4), F8(5)],
        lastId: 5,
        dims: {
            atoms: [
                { id: 'a1', text: '甲在仓库找到木箱并清点货物。', floorStart: 1, floorEnd: 2 },
                { id: 'a2', text: '乙在码头等到船只靠岸。', floorStart: 3, floorEnd: 3 },
            ],
        },
        expect: { v2: [0, 4, 5], marksAfter: [], covered: [1, 2, 3] },
        deviation: 'V2 新增（用户 v2.64.0 要求）：情节覆盖 1-3 楼 → 不再列为未摘要',
    },
    {
        name: 'covered-by-segments',
        note: '分段总结（plotSegments）覆盖的区间同样算「已有记忆数据」',
        chat: [F8(0), F8(1), F8(2), F8(3)],
        lastId: 3,
        dims: {
            plotSegments: [{ id: 's1', title: '第 0-2 楼', floorStart: 0, floorEnd: 2, raw: '### 第 0-2 楼\n- 甲清点货物。' }],
        },
        expect: { v2: [3], marksAfter: [], covered: [0, 1, 2] },
        deviation: 'V2 新增：分段总结覆盖 0-2 楼 → 不再列为未摘要（V1 无此判据）',
    },
    {
        name: 'drift-refresh',
        note: '哈希整体漂移（取文口径变化）：≥10 枚标记全部失配 → 按当前算法整体刷新，不重新分析',
        chat: Array.from({ length: 12 }, (_, i) => F8(i)),
        marks: Array.from({ length: 12 }, (_, i) => ({ f: i, h: 'STALE_ALGO_HASH_' + i })),
        lastId: 11,
        expect: { v2: [], marksAfter: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        deviation: '',
    },
    {
        name: 'ver-upgrade',
        note: '升级迁移：processedVer 为旧版 → 旧哈希按当前取文口径重算 → 仍视为已处理',
        chat: [F8(0), F8(1), F8(2), F8(3)],
        marks: [{ f: 1, h: 'LEGACY_OLD_ALGO_HASH' }, { f: 2, h: 'LEGACY_OLD_ALGO_HASH' }],
        processedVer: 'v1.60:legacy',
        lastId: 3,
        expect: { v2: [0, 3], marksAfter: [1, 2] },
        deviation: '',
    },
    {
        name: 'covered-but-changed',
        note: '台账在册但哈希不符（该楼正文被改写过）→ 必须重新分析：覆盖判据不得压住「内容已变」的楼层',
        chat: [F8(0), F8(1), F8(2)],
        marks: [{ f: 1, h: 'HASH_OF_OLD_REVISION' }],
        lastId: 2,
        dims: {
            atoms: [{ id: 'a', text: '甲在仓库清点货物并记下两页账目。', floorStart: 0, floorEnd: 2 }],
        },
        expect: { v2: [1], marksAfter: [1], covered: [0, 2] },
        deviation: 'V2 覆盖判据让位于台账「内容已改写」语义（V1 无覆盖判据，此项 v2NoCover 与 v1 同值）',
    },
    {
        name: 'end-floor',
        note: '显式 endFloor 口径：V1 `pendingFloorList(0, 4)` 与 V2 `listUnprocessedFloors({endFloor:4})` 只扫到第 4 楼',
        chat: Array.from({ length: 10 }, (_, i) => F8(i)),
        lastId: 9,
        endFloorOpt: 4,
        expect: { v2: [0, 1, 2, 3, 4], marksAfter: [] },
        deviation: '',
    },
];
