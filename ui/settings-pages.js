// 由 V1 源码自动提取（103 控件 / 14 页）
export const SETTINGS_TABS = [
    {
        "id": "base",
        "label": "基础"
    },
    {
        "id": "feed",
        "label": "投喂范围"
    },
    {
        "id": "api",
        "label": "API"
    },
    {
        "id": "analyze",
        "label": "分析记忆"
    },
    {
        "id": "safety",
        "label": "内容弱化"
    },
    {
        "id": "extract",
        "label": "提取记忆"
    },
    {
        "id": "forget",
        "label": "遗忘"
    },
    {
        "id": "rumors",
        "label": "传言"
    },
    {
        "id": "parallels",
        "label": "平行"
    },
    {
        "id": "prompts",
        "label": "提示词"
    },
    {
        "id": "storage",
        "label": "存储"
    },
    {
        "id": "debug",
        "label": "调试"
    },
    {
        "id": "data",
        "label": "数据管理"
    },
    {
        "id": "about",
        "label": "关于"
    }
];

export const SETTINGS_CONTROLS = {
    "base": [
        { "key": "enabled", "label": "启用组件", "type": "checkbox" },
        { "key": "timelyAnalysis", "label": "⚡ 及时分析（实时模式）", "type": "checkbox" },
        { "key": "autoExtract", "label": "消息后自动摘取", "type": "checkbox", "forceWhen": "timelyAnalysis" },
        { "key": "autoSummary", "label": "生成后自动 AI 摘要", "type": "checkbox", "forceWhen": "timelyAnalysis" },
        { "key": "autoRepair", "label": "生成后自动修复", "type": "checkbox" },
        { "key": "injectCurrentPrompt", "label": "注入当前提示词", "type": "checkbox", "forceWhen": "timelyAnalysis" },
        { "key": "importanceBase", "label": "初始重要性(0次调用)", "type": "text" },
        { "key": "importancePerUse", "label": "每次调用增量", "type": "text" },
        { "key": "clockExtractEnabled", "label": "消息后自动提取（不再只靠 AI）", "type": "checkbox" },
        {
            "key": "clockRegexPreset",
            "label": "参考表达式预设",
            "type": "select",
            "options": [
                { "v": "cn", "label": "中文常用（阿拉伯/中文数字年月日 + 时刻词 + 24 小时制）" },
                { "v": "marker", "label": "标记式（【时间：】/ 时间：/ 地点：… 带值）" },
                { "v": "cn+marker", "label": "中文常用 + 标记式（推荐，最全）" },
                { "v": "story", "label": "正文头结构（▷ 日期（纪年）·季节 / ▷ 地点路径 / ▶第 N 天 起止时间）" },
                { "v": "none", "label": "仅用下方自定义正则" }
            ]
        },
        { "key": "clockDateRegex", "label": "自定义 · 日期正则", "type": "text" },
        { "key": "clockTimeRegex", "label": "自定义 · 时间正则", "type": "text" },
        { "key": "clockLocationRegex", "label": "自定义 · 地点正则", "type": "text" },
        { "key": "clockRelative", "label": "相对日期推进（次日/第二天/隔天/明日 等）", "type": "checkbox" },
        { "key": "clockForceDegrade", "label": "强制使用降级方案（最新情节的日期时间 + 最新的场景）", "type": "checkbox" },
        { "key": "clockAnomalyJumpYears", "label": "日期异常判定：与当前时钟相差超过 N 年（默认 50，0 = 关闭）", "type": "text" },
        { "key": "clockStoryDayEpoch", "label": "正文头「第 N 天」纪元首日（如 0001-01-01；留空 = 只记录天数不换算）", "type": "text" },
        { "key": "clockAutoPatrol", "label": "时间巡检：载入后自动巡检原子数据日期时间（默认开，默认只统计）", "type": "checkbox" },
        { "key": "clockPatrolAutoFix", "label": "时间巡检：自动修复（默认关 —— 只统计不修改）", "type": "checkbox" },
        { "key": "clockRepairBatch", "label": "AI 结合正文修复：单次提交条数（默认 20）", "type": "text" },
        { "key": "uiEffects", "label": "界面特效（动画 / 过渡 / 脉冲）", "type": "checkbox" }
    ],
    "feed": [
        {
            "key": "feedFloors",
            "label": "摘要使用最近楼层数",
            "type": "text"
        },
        {
            "key": "autoRepairOnMergeFail",
            "label": "提取合并失败后自动修复",
            "type": "checkbox"
        },
        {
            "key": "repairAutoAi",
            "label": "AI 修订措辞（关闭＝只做机械清理）",
            "type": "checkbox"
        },
        {
            "key": "repairFailDelaySec",
            "label": "失败后延迟自动修复(秒)",
            "type": "text"
        },
        {
            "key": "maxAutoRepairRounds",
            "label": "同楼层哈希未变最多自动修复次数",
            "type": "text"
        },
        {
            "key": "autoRepairEveryOps",
            "label": "每 N 次提取后最多 1 次（0＝不限）",
            "type": "text"
        },
        {
            "key": "repairMaxItems",
            "label": "每次交给 AI 的候选条目上限（1-60）",
            "type": "text"
        },
        {
            "key": "repairTagSimHigh",
            "label": "相关性「过高」阈值（≥ 优先核对，0.05-0.95）",
            "type": "text"
        },
        {
            "key": "repairTagSimLow",
            "label": "相关性「过低」阈值（≤ 不列入，0-0.9）",
            "type": "text"
        },
        {
            "key": "repairSampleRatio",
            "label": "每轮抽查比例（0.02-1，如 0.2=20%）",
            "type": "text"
        },
        {
            "key": "repairMinCandidates",
            "label": "每轮候选下限（不足按相关性补足）",
            "type": "text"
        },
        {
            "key": "repairCharacterMinSize",
            "label": "角色修复字数门限（档案有效字数 < 该值 → 列入待修复名单，10-400，0=不筛）",
            "type": "text"
        },
        {
            "key": "repairCharacterBatch",
            "label": "每轮条数（1-10，默认 3）",
            "type": "text"
        },
        {
            "key": "characterBirthDefaultAge",
            "label": "无年龄线索时的默认成年年龄（默认 25）",
            "type": "text"
        },
        {
            "key": "characterBirthInfer",
            "label": "角色修复强制补全出生日期（正文没写则合理推测，绝不留空）",
            "type": "checkbox"
        },
        // —— B8-6c 补齐：V1 设定④「质检维护」页里以**手写 div** 形式给出的 22 个控件
        //    （B4 的自动提取只覆盖 `f(...)` / `switchField(...)`，手写 `data-ftt-cfg` 块被漏掉；键与标签按 V1 原样、顺序按 V1）
        //    概念 / 记忆 / 悬念 / 物品 四域「相关组聚类修复」各 4 项（相关性阈值 · 每次核对组数 · 每次提交条数 · 组规模上限）
        { "key": "conceptRepairSim", "label": "概念修复相关性阈值（0.1-0.95，默认 0.45）", "type": "text" },
        { "key": "conceptRepairMaxClusters", "label": "概念修复每次核对组数（1-20，默认 3）", "type": "text" },
        { "key": "conceptRepairMaxItems", "label": "概念修复每次提交条数上限（2-120，默认 24）", "type": "text" },
        { "key": "conceptRepairMaxClusterSize", "label": "概念相关组规模上限（2-40，默认 8）", "type": "text" },
        { "key": "memoryRepairSim", "label": "记忆修复相关性阈值（0.1-0.95，默认 0.45）", "type": "text" },
        { "key": "memoryRepairMaxClusters", "label": "记忆修复每次核对组数（1-20，默认 3）", "type": "text" },
        { "key": "memoryRepairMaxItems", "label": "记忆修复每次提交条数上限（2-120，默认 24）", "type": "text" },
        { "key": "memoryRepairMaxClusterSize", "label": "记忆相关组规模上限（2-40，默认 8）", "type": "text" },
        { "key": "suspenseRepairSim", "label": "悬念修复相关性阈值（0.1-0.95，默认 0.45）", "type": "text" },
        { "key": "suspenseRepairMaxClusters", "label": "悬念修复每次核对组数（1-20，默认 3）", "type": "text" },
        { "key": "suspenseRepairMaxItems", "label": "悬念修复每次提交条数上限（2-120，默认 24）", "type": "text" },
        { "key": "suspenseRepairMaxClusterSize", "label": "悬念相关组规模上限（2-40，默认 8）", "type": "text" },
        { "key": "itemRepairSim", "label": "物品修复相关性阈值（0.1-0.95，默认 0.45）", "type": "text" },
        { "key": "itemRepairMaxClusters", "label": "物品修复每次核对组数（1-20，默认 3）", "type": "text" },
        { "key": "itemRepairMaxItems", "label": "物品修复每次提交条数上限（2-120，默认 24）", "type": "text" },
        { "key": "itemRepairMaxClusterSize", "label": "物品相关组规模上限（2-40，默认 8）", "type": "text" },
        //    物品「低调用清理」（零 AI）6 项：比例 / 物品数门槛 / 平均调用门槛 / 楼层门槛 / 清扫间隔 / 每轮最多删除
        { "key": "itemLowUsesRatio", "label": "低调用清理·比例（默认 0.05）", "type": "text" },
        { "key": "itemLowUsesMinItems", "label": "低调用清理·物品数门槛（默认 100）", "type": "text" },
        { "key": "itemLowUsesMinAvg", "label": "低调用清理·平均调用门槛（默认 5）", "type": "text" },
        { "key": "itemLowUsesMinFloors", "label": "低调用清理·楼层门槛（默认 200；0=不生效）", "type": "text" },
        { "key": "itemLowUsesEveryFloors", "label": "低调用清理·清扫间隔（默认 40 楼；0=不限制）", "type": "text" },
        { "key": "itemLowUsesMaxDelete", "label": "低调用清理·每轮最多删除（默认 1）", "type": "text" },
    ],
    "api": [],
    "analyze": [
        {
            "key": "summaryChunkSize",
            "label": "分段读取楼层数（每段分析量）",
            "type": "text"
        },
        {
            "key": "plotSegmentBatchAtoms",
            "label": "每次打包给 AI 的情节条数（默认 30）",
            "type": "text"
        },
        {
            "key": "plotSegmentProtectManual",
            "label": "保护已存在的时间范围（不覆盖）",
            "type": "checkbox"
        },
        {
            "key": "plotSegmentIncremental",
            "label": "只整理未覆盖的情节（增量）",
            "type": "checkbox"
        },
        {
            "key": "plotSegmentTextLimit",
            "label": "单条剧情线概述字数上限（默认 400）",
            "type": "text"
        },
    
    ],
    "safety": [],
    "extract": [
        {
            "key": "useVector",
            "label": "启用向量检索",
            "type": "checkbox"
        },
        {
            "key": "vectorTopN",
            "label": "向量 TopN",
            "type": "text"
        },
        {
            "key": "vectorMinScore",
            "label": "最低相似度",
            "type": "text"
        },
        {
            "key": "vectorTimeoutMs",
            "label": "超时(ms)",
            "type": "text"
        },
        {
            "key": "jsExtractEnabled",
            "label": "启用浏览器 JS 抽取",
            "type": "checkbox"
        },
        {
            "key": "useKeywordFlow",
            "label": "发送前提取关键词流程",
            "type": "checkbox"
        },
        {
            "key": "charBudget",
            "label": "注入字符预算（硬上限）",
            "type": "text"
        },
        {
            "key": "maxAtoms",
            "label": "最大情节原子数",
            "type": "text"
        },
        {
            "key": "atomsRecentRatio",
            "label": "情节近期配额比例（0-1，默认 0.4）",
            "type": "text"
        },
        {
            "key": "maxStates",
            "label": "最大状态记录条数",
            "type": "text"
        },
        {
            "key": "stateMinPerSubject",
            "label": "每角色最少状态条数（默认 1）",
            "type": "text"
        },
        {
            "key": "stateMaxPerSubject",
            "label": "每角色最多状态条数（超出裁最旧，默认 10）",
            "type": "text"
        },
        {
            "key": "maxSnapshots",
            "label": "最大角色档案条数",
            "type": "text"
        },
        {
            "key": "maxMemories",
            "label": "最大长期记忆条数",
            "type": "text"
        },
        {
            "key": "maxItems",
            "label": "最大物品条数",
            "type": "text"
        },
        {
            "key": "maxPlans",
            "label": "最大进行中计划条数",
            "type": "text"
        },
        {
            "key": "maxSuspense",
            "label": "最大未解悬念条数",
            "type": "text"
        },
        {
            "key": "currencyEnabled",
            "label": "货币（记录 + 注入）",
            "type": "checkbox"
        },
        {
            "key": "currencyDynamicEnabled",
            "label": "货币 · 动态识别其他角色",
            "type": "checkbox"
        },
        {
            "key": "maxCurrencies",
            "label": "货币注入上限（默认 8）",
            "type": "text"
        },
        {
            "key": "maxScenes",
            "label": "最大场景条目数",
            "type": "text"
        },
        {
            "key": "maxConcepts",
            "label": "最大概念条数",
            "type": "text"
        },
        {
            "key": "maxParallelsInj",
            "label": "平行事件(注入)上限（默认 8）",
            "type": "text"
        },
        {
            "key": "keywordFilterByContext",
            "label": "关键词按上下文过滤",
            "type": "checkbox"
        },
        // —— B8-6c 补齐：V1 设定⑥「提取记忆」页里**手写 div** 形式的「各大类单条字数上限」10 个控件
        //    （B4 自动提取同样漏掉手写块；V1 用 `dcl_*` 代理键写 `cfg.dimCharLimits.*`，V2 控件引擎原生支持点路径，故直接用真键）
        //    语义（V1 原样）：单条正文超上限**入库即硬截断**（历史数据不回溯），AI 提示词里的目标字数不变；
        //    注意 V2 的默认值整体高于 V1 的提示词目标（V2 硬截断留余量，见 `core/config.js` 注释），属既定偏差，不是控件默认值写错。
        { "key": "dimCharLimits.atoms", "label": "情节正文上限", "type": "text" },
        { "key": "dimCharLimits.states", "label": "状态值上限", "type": "text" },
        { "key": "dimCharLimits.snapshots", "label": "角色档案累计上限", "type": "text" },
        { "key": "dimCharLimits.memories", "label": "记忆正文上限", "type": "text" },
        { "key": "dimCharLimits.items", "label": "物品说明上限", "type": "text" },
        { "key": "dimCharLimits.plans", "label": "计划内容上限", "type": "text" },
        { "key": "dimCharLimits.suspense", "label": "悬念内容上限", "type": "text" },
        { "key": "dimCharLimits.scenes", "label": "场景描述上限", "type": "text" },
        { "key": "dimCharLimits.concepts", "label": "概念内容上限", "type": "text" },
        { "key": "dimCharLimits.parallels", "label": "平行事件(推演)上限", "type": "text" },
    ],
    "forget": [
        {
            "key": "stateDecayEnabled",
            "label": "启用状态记录衰退",
            "type": "checkbox"
        },
        {
            "key": "stateDecayRatio",
            "label": "触发比例（默认 0.5＝超出上限 50% 触发）",
            "type": "text"
        },
        {
            "key": "stateDecayCutoff",
            "label": "移除阈值（默认 0.95）",
            "type": "text"
        },
        {
            "key": "stateDecaySubjectYears",
            "label": "角色停更删除年限（剧情年，默认 0=不生效；填 >0 才启用「角色久未登场 → 整组删除其状态」）",
            "type": "text"
        },
        {
            "key": "stateDecayStaleYears",
            "label": "单条绝对久远年限（剧情年，默认 6）",
            "type": "text"
        },
        {
            "key": "stateRepairBatch",
            "label": "状态修复·每轮主体数（默认 3）",
            "type": "text"
        },
        {
            "key": "stateRepairMatchSim",
            "label": "主体匹配相似度（默认 0.72，低于视为无档案）",
            "type": "text"
        },
        {
            "key": "memoryForgetEnabled",
            "label": "启用记忆遗忘机制",
            "type": "checkbox"
        },
        {
            "key": "memoryForgetRatio",
            "label": "触发比例（默认 0.5＝超出存储上限 50% 触发）",
            "type": "text"
        },
        {
            "key": "memoryForgetCutoff",
            "label": "遗忘阈值（默认 0.95）",
            "type": "text"
        },
        {
            "key": "storeMinAtoms",
            "label": "情节保底（默认 100，清理不跌破）",
            "type": "text"
        },
        {
            "key": "storeMaxAtoms",
            "label": "情节存储上限（默认 400）",
            "type": "text"
        },
        {
            "key": "storeMinMemories",
            "label": "记忆保底条数（默认 200）",
            "type": "text"
        },
        {
            "key": "storeMaxMemories",
            "label": "记忆存储上限（默认 600）",
            "type": "text"
        },
        {
            "key": "storeMinSnapshots",
            "label": "角色档案保底（默认 100）",
            "type": "text"
        },
        {
            "key": "storeMaxSnapshots",
            "label": "角色档案上限（默认 300）",
            "type": "text"
        },
        {
            "key": "storeMinItems",
            "label": "物品保底（默认 150）",
            "type": "text"
        },
        {
            "key": "storeMaxItems",
            "label": "物品上限（默认 400）",
            "type": "text"
        },
        {
            "key": "storeMinConcepts",
            "label": "概念保底（默认 200）",
            "type": "text"
        },
        {
            "key": "storeMaxConcepts",
            "label": "概念上限（默认 600）",
            "type": "text"
        },
        {
            "key": "lowUseForgetEnabled",
            "label": "通用遗忘清扫（修复内执行、零 AI、缓慢）",
            "type": "checkbox"
        },
        {
            "key": "lowUseForgetRatio",
            "label": "低使用比例（默认 0.05）",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinItems",
            "label": "条目数门槛（默认 80）",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinAvg",
            "label": "平均调用门槛（默认 5）",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinFloors",
            "label": "长期未现楼层门槛（默认 300；0=不生效）",
            "type": "text"
        },
        {
            "key": "lowUseForgetMaxDelete",
            "label": "每轮最多清扫条数（默认 1）",
            "type": "text"
        },
        {
            "key": "lowUseForgetProtectImportance",
            "label": "重要度保护（默认 0.7，≥ 不清扫）",
            "type": "text"
        },
        {
            "key": "lowUseForgetEveryFloors",
            "label": "清扫间隔（默认 40 楼；0=不限制）",
            "type": "text"
        },
    
    ],
    "rumors": [
        {
            "key": "rumorEnabled",
            "label": "传言（记录 + 演化 + 注入）",
            "type": "checkbox"
        },
        {
            "key": "maxRumors",
            "label": "传言注入上限（默认 6）",
            "type": "text"
        },
        {
            "key": "rumorChangeEveryRounds",
            "label": "每隔 N 楼轮次演化一次（默认 5）",
            "type": "text"
        },
        {
            "key": "rumorChangeNeedRounds",
            "label": "单次变化过程所需轮次（默认 2，变化不会立刻生效）",
            "type": "text"
        },
        {
            "key": "rumorFissionFerment",
            "label": "触发裂变的最低发酵度（默认 80）",
            "type": "text"
        },
        {
            "key": "rumorFissionChance",
            "label": "裂变 / 变异概率（0-1，默认 0.3）",
            "type": "text"
        },
        {
            "key": "rumorParallelLinkSim",
            "label": "与平行事件联动的标签关联阈值（默认 0.34）",
            "type": "text"
        },
        {
            "key": "rumorParallelLinkChance",
            "label": "联动概率（0-1，默认 0.35）",
            "type": "text"
        },
        {
            "key": "rumorMediaLifeDays",
            "label": "载体基础寿命（剧情天数，默认 30；实际 = 本值 × 载体耐久度）",
            "type": "text"
        },
        {
            "key": "rumorDecayEnabled",
            "label": "启用传言衰退",
            "type": "checkbox"
        },
        {
            "key": "rumorDecayRatio",
            "label": "触发比例（默认 0.5＝超出存储上限 50% 触发）",
            "type": "text"
        },
        {
            "key": "rumorDecayCutoff",
            "label": "移除阈值（默认 0.95）",
            "type": "text"
        },
        {
            "key": "storeMinRumors",
            "label": "存储保底（默认 0＝无硬保底）",
            "type": "text"
        },
        {
            "key": "storeMaxRumors",
            "label": "存储上限（默认 200）",
            "type": "text"
        },
    
    ],
    "parallels": [
        {
            "key": "parallelWeaveEnabled",
            "label": "提取后自动推演平行事件",
            "type": "checkbox"
        },
        {
            "key": "parallelWeaveInterval",
            "label": "被动触发楼层间隔（默认 10 楼）",
            "type": "text"
        },
        {
            "key": "maxParallels",
            "label": "平行事件上限（默认 30）",
            "type": "text"
        },
        {
            "key": "maxParallelsInj",
            "label": "平行事件注入上限（默认 8）",
            "type": "text"
        },
        {
            "key": "parallelDecayEnabled",
            "label": "启用平行事件衰退",
            "type": "checkbox"
        },
        {
            "key": "parallelDecayRatio",
            "label": "触发比例（默认 0.5＝超出上限 50% 触发）",
            "type": "text"
        },
        {
            "key": "parallelDecayCutoff",
            "label": "移除阈值（默认 0.95）",
            "type": "text"
        },
    
    ],
    "prompts": [
        {
            "key": "atomCompactEnabled",
            "label": "启用半自动情节总结（体量达标自动聚合早期情节）",
            "type": "checkbox"
        },
        {
            "key": "atomCompactChars",
            "label": "触发体量（全库正文字符，默认 30000）",
            "type": "text"
        },
        {
            "key": "atomCompactTarget",
            "label": "聚合目标（默认压到当前 30%）",
            "type": "text"
        },
        {
            "key": "atomCompactRecent",
            "label": "保护窗口（最近 N 条，默认 20）",
            "type": "text"
        },
        {
            "key": "atomCompactRatio",
            "label": "可聚合占比（低于则降级月→年，默认 0.6）",
            "type": "text"
        },
        {
            "key": "atomCompactBatch",
            "label": "单轮批次数上限（默认 40）",
            "type": "text"
        },
    
    ],
    "storage": [
        {
            "key": "storage.stateFile",
            "label": "记忆数据独立文件（强烈建议开启）",
            "type": "checkbox"
        },
        {
            "key": "storage.stateFileBak",
            "label": "「立即同步」同时上传备份文件",
            "type": "checkbox"
        },
        {
            "key": "storage.snapshotFile",
            "label": "快照链独立文件",
            "type": "checkbox"
        },
        {
            "key": "storage.settingsMirror",
            "label": "仍镜像写回存档变量",
            "type": "checkbox"
        },
        {
            "key": "storage.tauriMirror",
            "label": "原生模式下同时镜像写酒馆文件",
            "type": "checkbox"
        },
        {
            "key": "storage.worldbook",
            "label": "世界书存储（可选）",
            "type": "checkbox"
        },
        {
            "key": "storage.worldbookPreventRecursion",
            "label": "词条不可递归",
            "type": "checkbox"
        },
        {
            "key": "storage.verifyOnLoad",
            "label": "载入时哈希校验",
            "type": "checkbox"
        },
        {
            "key": "storage.syncOnSave",
            "label": "保存时同步镜像",
            "type": "checkbox"
        },
        {
            "key": "storage.crossPullOnActivity",
            "label": "聊天活动后自动拉取对端",
            "type": "checkbox"
        },
        {
            "key": "storage.crossPullOnVisible",
            "label": "页面回到可见时自动拉取对端",
            "type": "checkbox"
        },
        {
            "key": "storage.syncMetaProbe",
            "label": "服务端清单预判（省流量·推荐开启）",
            "type": "checkbox"
        },
        {
            "key": "storage.syncLogServer",
            "label": "日志存到服务端（双端可见·推荐开启）",
            "type": "checkbox"
        },
        {
            "key": "storage.deletedKeepDays",
            "label": "删除墓碑保留（天）",
            "type": "text"
        },
        {
            "key": "storage.tauriNative",
            "label": "原生存储通道",
            "type": "select",
            "options": [
                { "v": "auto", "label": "自动（检测到 TauriTavern 即切换）" },
                { "v": "on", "label": "强制开启（TauriTavern 原生存储）" },
                { "v": "off", "label": "关闭（始终用酒馆用户目录文件）" }
            ]
        },
        {
            "key": "storage.worldbookName",
            "label": "选择世界书",
            "type": "select",
            "optionsFrom": "worldbookNames",
            "options": [ { "v": "", "label": "（选择世界书）" } ]
        },
        {
            "key": "storage.worldbookMode",
            "label": "调取方式",
            "type": "select",
            "options": [
                { "v": "constant", "label": "常驻蓝灯（constant，持续激活）" },
                { "v": "selective", "label": "绿色关键词触发（selective）" },
                { "v": "vectorized", "label": "向量触发（vectorized）" }
            ]
        },
        {
            "key": "storage.worldbookScanDepth",
            "label": "触发楼层（扫描深度）",
            "type": "text"
        },
        {
            "key": "storage.worldbookPosition",
            "label": "插入位置",
            "type": "select",
            "options": [
                { "v": "at_depth", "label": "系统插入深度 D（at_depth）" },
                { "v": "before_character_definition", "label": "角色定义前" },
                { "v": "after_character_definition", "label": "角色定义后" },
                { "v": "before_author_note", "label": "作者注释前" },
                { "v": "after_author_note", "label": "作者注释后" },
                { "v": "outlet", "label": "outlet" }
            ]
        },
        {
            "key": "storage.worldbookDepth",
            "label": "插入深度（层）",
            "type": "text"
        },
        {
            "key": "storage.worldbookProbability",
            "label": "激活概率(%)",
            "type": "text"
        },
        {
            "key": "storage.worldbookSticky",
            "label": "黏性(条,可空)",
            "type": "text"
        },
        {
            "key": "storage.worldbookCooldown",
            "label": "冷却(条,可空)",
            "type": "text"
        },
        {
            "key": "storage.worldbookDelay",
            "label": "延迟(楼,可空)",
            "type": "text"
        },
        {
            "key": "storage.worldbookMaxBytes",
            "label": "词条内容上限(字节)",
            "type": "text"
        },
        {
            "key": "syncTrafficGuard",
            "label": "楼层哈希差异门控（省流量·推荐开启）",
            "type": "checkbox"
        }
    ],
    "debug": [
        // v2.42.0：交互/宿主追踪的分级与分类开关（V1 只有 debugEnabled；本组为 V2 附加，调试页可见可关）
        { "key": "debugLevel", "label": "记录级别（error/warn/info/debug/trace）", "type": "text" },
        { "key": "debugTraceUi", "label": "记录用户交互（点击/变更/切页）", "type": "checkbox" },
        { "key": "debugTraceHost", "label": "记录插件↔宿主 API 调用", "type": "checkbox" },
        { "key": "debugTraceVerbose", "label": "详细模式（记录截断后的原始参数/返回）", "type": "checkbox" },
        {
            "key": "debugEnabled",
            "label": "记录调试日志",
            "type": "checkbox"
        },
    ],
    "data": [],
    "about": []
};

// ============================================================
// ui/settings-pages.js —— V1 设定 **14 组子页**（结构与控件表由 V1 源码自动提取，保证同名同序同键）
// 来源：V1 `src/modules/13-UI-设置与存储开关.js` 的 `subTabs` 与各页 `f(key,label,type)` / `swT` / `swForce` / `stSwitch` 调用
//   （提取脚本见 docs/P8e-B4设定子页.md）。共 **105 个配置控件**，键写回内核 `cfg`（`storage.*` 为 `cfg.storage.*`）。
// 说明：本批交付**框架 + 全部配置控件 + 数据管理动作**；依赖尚未移植内核的页面动作（提示词签名迁移、投喂标签分析、
//   货币追踪、预设/API 等）在页内明确标注，不使用假实现。
//   B9-a 起：**调试页**（日志查看器 + `dbgClear`）与**关于页**（版本清单读取 + 清缓存/重载）已接入
//   （`ui/debug.js` / `ui/about.js`，分别对应 V1 的 `debugHtml()` 与 `aboutHtml()`）；数据管理页新增 `reset`。
//   B9-c 起：**投喂页**追加 V1 的「投喂标签自动分析」节与投喂白/黑名单两节
//   （`ui/feed-scan.js`，对应 V1 `rxTagScanHtml()` 与 `rxScanTags`/`rxAddTag`/`rxScanClear` 三个动作）。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { defaultCfg, CN_KEY_MAP } from '../core/config.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { worldbookNames } from '../host/worldbook.js';
import { VERSION } from '../core/constants.js';
import { promptsPageHtml, promptAction } from './prompts.js';
import { snapshotSectionHtml } from './snapshots.js';
import { storagePageHtml } from './sync.js';
import { nsfwPageHtml } from './nsfw.js';
import { forgetPageHtml } from './forget.js';
import { debugPageHtml } from './debug.js';
import { aboutHtml as aboutPageHtml } from './about.js';
import { feedScanSectionHtml, feedTagListSectionsHtml } from './feed-scan.js';
// v2.35.0（B10-a）：API 子页（三通道 + API 分组预设 + 按用途渠道）
import { apiPageHtml, dimPresetRowsHtml, parallelChannelFieldHtml } from './api-page.js';

/** 键 → 中文名（反向使用 CN_KEY_MAP，用于补充 V1 未提取到标签的键） */
function cnLabel(key) {
    try {
        const hit = Object.keys(CN_KEY_MAP).filter((k) => CN_KEY_MAP[k] === key)[0];
        return hit || key;
    } catch (e) { return key; }
}

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 读取控件当前值（支持 `storage.` 嵌套键） */
export function readControl(key) {
    try {
        const k = String(key || '');
        if (k.indexOf('storage.') === 0) return (cfg.storage || {})[k.slice(8)];
        if (k.indexOf('.') > 0) {
            const [a, b] = k.split('.');
            return isPlain(cfg[a]) ? cfg[a][b] : undefined;
        }
        return cfg[k];
    } catch (e) { return undefined; }
}

/**
 * 写回控件值（唯一入口）：内核 cfg → 持久化 ST 配置。
 * @returns {{ok:boolean, key:string, value:*}}
 */
export function applySettingsControl(key, raw) {
    const k = String(key || '');
    if (!k) return { ok: false, key: k };
    try {
        // v2.35.0：V1 的「分组名」「已存分组」是**按钮入参**，`settingsApplyAll` 显式跳过它们（v1.206 26280 / 26692）
        //   —— V2 同样**不写入配置**（保持逐字语义；由 `ui/api-page.js` 的按钮动作按需读取 DOM 值）。
        if (k === 'presetName' || k === 'presetSelect') return { ok: true, key: k, transient: true };
        // P9d：V1 `settingsApplyAll`（v1.206 26693）的**代理键**原样保留 —— `data-ftt-cfg="dimensionSeparate"`（勾选态）
        //   写回真键 `cfg.dimensionGrouping`（`'separate'` / `'unified'`）。V2 沿用同一代理键，保持 V1 的控件 id 与勾选语义。
        if (k === 'dimensionSeparate') {
            cfg.dimensionGrouping = raw ? 'separate' : 'unified';
            try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
            return { ok: true, key: k, value: cfg.dimensionGrouping };
        }
        if (k.indexOf('storage.') === 0) {
            cfg.storage = Object.assign({}, cfg.storage || {});
            cfg.storage[k.slice(8)] = raw;
        } else if (k.indexOf('.') > 0) {
            const [a, b] = k.split('.');
            cfg[a] = Object.assign({}, isPlain(cfg[a]) ? cfg[a] : {});
            cfg[a][b] = raw;
        } else {
            cfg[k] = raw;
        }
        try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
        return { ok: true, key: k, value: raw };
    } catch (e) { return { ok: false, key: k }; }
}

/** 单个控件 HTML（V1 同款字段/开关结构：`.ftt-field` / `.ftt-switch` / `.ftt-slider` / `data-ftt-cfg`） */
export function settingsControlHtml(c) {
    const key = String(c.key || '');
    const label = String(c.label || cnLabel(key));
    const v = readControl(key);
    const type = c.type || 'text';
    if (type === 'checkbox') {
        // V1 `swForce`：被强制项（如「及时分析」开启时的 autoExtract/autoSummary/injectCurrentPrompt）显示为强制开启且禁用
        const forced = !!(c.forceWhen && (() => { try { return readControl(String(c.forceWhen)) === true; } catch (e) { return false; } })());
        const on = forced || (v !== false && v !== undefined && v !== null && v !== '' && v !== 0);
        return '<div class="ftt-field"><label>' + esc(label) + '</label>'
            + '<label class="ftt-switch"><input type="checkbox" data-ftt-cfg="' + esc(key) + '"' + (on ? ' checked' : '') + (forced ? ' disabled' : '') + '><span class="ftt-slider"></span></label>'
            + '<span class="ftt-muted">' + (on ? '已开启' : '已关闭') + (forced ? '（由「及时分析」强制开启）' : '') + '</span></div>';
    }
    if (type === 'select') {
        // 动态选项（B8-7 世界书）：`optionsFrom: 'worldbookNames'` 时由宿主世界书列表填充（V1 `worldbookNamesHtml` 同源）
        let list = Array.isArray(c.options) ? c.options : [];
        if (String(c.optionsFrom || '') === 'worldbookNames') {
            try {
                const names = worldbookNames();
                list = list.concat(names.map((n) => ({ v: n, label: n })));
            } catch (e) { /* 宿主无世界书接口 → 仅保留占位项 */ }
        }
        const norm = (o) => (o && typeof o === 'object') ? { v: String(o.v == null ? '' : o.v), label: String(o.label == null ? o.v : o.label) } : { v: String(o == null ? '' : o), label: String(o == null ? '' : o) };
        const cur = String(v == null ? '' : v);
        const items = (list.length ? list : [cur]).map(norm);
        const opts = items.map((o) => '<option value="' + esc(o.v) + '"' + (cur === o.v ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('');
        return '<div class="ftt-field"><label>' + esc(label) + '</label><select data-ftt-cfg="' + esc(key) + '">' + opts + '</select></div>';
    }
    if (type === 'textarea') {
        return '<div class="ftt-field ftt-field-col"><label>' + esc(label) + '</label><textarea data-ftt-cfg="' + esc(key) + '" rows="4">' + esc(v == null ? '' : v) + '</textarea></div>';
    }
    const missing = (v === undefined);
    return '<div class="ftt-field"><label>' + esc(label) + (missing ? ' <span class="ftt-muted">（未定义）</span>' : '') + '</label>'
        + '<input type="' + (type === 'number' ? 'number' : 'text') + '" data-ftt-cfg="' + esc(key) + '" value="' + esc(v == null ? '' : v) + '"></div>';
}

/**
 * 基础页正文（V1 的分节布局：组件开关 / 重要性计算 / 剧情时钟自动提取 / 时钟降级与时间巡检 / 界面特效）。
 * 说明：V1 的「显示界面开关（buttonLocation*）」在 V2 由「基础 → V2 附加设定」的悬浮/菜单开关承担，此处不重复；
 *   「AI 捕捉正文 → 生成正则」与「AI 结合正文修复日期时间」两条 AI 管线属 B8-2（本页先如实标注，不放假实现）。
 */
export function basePageHtml(controls, extrasHtml) {
    const list = Array.isArray(controls) ? controls : [];
    const find = (k) => list.filter((c) => String(c.key) === k)[0];
    const row = (k) => { const c = find(k); return c ? settingsControlHtml(c) : ''; };
    const rows = (keys) => keys.map((k) => row(k)).filter(Boolean).join('\n');
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">组件开关</div>',
        rows(['enabled', 'timelyAnalysis', 'autoExtract', 'autoSummary', 'autoRepair', 'injectCurrentPrompt']),
        '<div class="ftt-muted">内置自动触发：消息后提取记忆；「注入当前提示词」开启则一并注入，关闭则仅提取记忆（不越权注入）。</div>',
        '<div class="ftt-muted">「记录调试日志」在「调试」页；「召回参数」在「提取记忆」页。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">重要性计算（调用次数驱动）</div>',
        rows(['importanceBase', 'importancePerUse']),
        '<div class="ftt-muted">重要性 = 初始值 + 调用次数 × 增量，自动计算。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">剧情时钟自动提取（总览 日期/时间/地点）</div>',
        rows(['clockExtractEnabled', 'clockRegexPreset', 'clockDateRegex', 'clockTimeRegex', 'clockLocationRegex', 'clockRelative']),
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="clockRegexGen" title="把最近楼层正文交给 AI，总结日期/时间/地点的书写规律并生成三条正则（会校验：可编译、不匹配空串、样本中有命中）">🤖 AI 捕捉正文 → 生成正则</button></div>',
        '<div class="ftt-hint">AI 只依据正文样本总结写法（兼容「公元1919年11月29日」「公元9年」「一九一九年三月一日」等），生成后自动写入上方三个输入框并给出试算结果；不合适可手动改写或清空。该操作只影响总览的 日期/时间/地点 自动提取。</div>',
        '<div class="ftt-muted">取用顺序：正则直取 → 标记式带值 → 时段词/时刻 → 相对日期推进 → AI 摘要的当前状态 → 无结果时展示最近记忆参考（不写入）。仅影响总览 日期/时间/地点 的自动提取。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">时钟降级与时间巡检（总览）</div>',
        rows(['clockForceDegrade', 'clockAnomalyJumpYears', 'clockStoryDayEpoch', 'clockAutoPatrol', 'clockPatrolAutoFix', 'clockRepairBatch']),
        '<div class="ftt-muted">判定项：① 日期格式非法；② 年份比当前时钟/最新情节晚超过 N 年（如 1919 剧情里出现 2011）；③ 早超过 N 年（剧情时间大幅倒退）。命中即降级，并在总览「🕒 时钟来源」里注明原因。</div>',
        '<div class="ftt-muted">巡检 情节 / 记忆 / 计划 / 悬念 / 平行事件 的 日期 与 时间：格式非法 → 按内容重解析（解析不出则清空）；年份漂移 → 按内容重解析或保留月日改年份。安全口径：① 锚点不可信 → 只统计不修改；② 任何写回都要求「格式合法 + 不触发年份异常」；③ 格式合法但年份漂移、又无法可靠修正 → 保留原值；④ 写回前自动留一份全量快照。总览「🩺 时间巡检修复」为手动修复（按当前锚点校正年份，请先确认锚点正确）。</div>',
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="clockRepair" title="把异常日期/时间连同最近正文交 AI 判定并修复（只改日期与时间字段；独立修复，不影响自动巡检）">🩺 AI 结合正文修复日期时间</button></div>',
        '<div class="ftt-hint">独立修复：只在点这个按钮时执行 —— 依据【近期正文】+【时间锚点】逐条判定正确值，插件只接受格式合法且年份未超阈值的修正（不合格丢弃、无法判定如实回报）。上面的「时间巡检」是零 AI 的机械修复，两者互不干扰。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">显示界面开关</div>',
        '<div class="ftt-muted">V2 的入口形态在「基础 → V2 附加设定」中配置（悬浮按钮 / 菜单入口 / 抽屉卡片），此处不重复。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">界面特效</div>',
        rows(['uiEffects']),
        '<div class="ftt-muted">关闭后面板与消息弹窗不再播放动画/过渡（适合低配设备）；系统「减少动态效果」自动按关闭处理。</div></div>',

        // v2.43.0：V2 独有分节（更新检查 / V1 数据导入 / 维度开关 / 面板宽度）生在**基础页内**，
        //   由调用方注入（本模块不得反向依赖 ui/panel.js，避免循环依赖）。
        (extrasHtml ? String(extrasHtml) : ''),
    ].filter(Boolean).join('\n');
}

/**
 * 分析记忆页正文（V1「维度分组（总开关）」节 + 本页控件表同名同序）。
 * V1 事实源：v1.206 25546~25552（手写 HTML，非控件表项）+ 26693（代理键 `dimensionSeparate` 的保存分支）。
 * V2 适配（见 docs/P9d）：
 *   ① 控件键用 V1 **代理键** `dimensionSeparate`（勾选态）→ `applySettingsControl` 写回真键 `cfg.dimensionGrouping`；
 *   ② V1 该节还引导「逐维度开子开关并选 API 分组」——V2 的维度子开关在「V2 附加设定」的「启用维度」里（`cfg.dimensionEnabled`）；
 *      「各维度单独选预设」**不适用**（宿主生成通道 `generateRaw` 不支持按次指定预设，见 `host/generation.js`），
 *      故**不做预设下拉**，并在文案里如实标注（避免假控件）。
 */
export function analyzePageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const separate = (() => { try { return cfg.dimensionGrouping === 'separate'; } catch (e) { return false; } })();
    // 开关标签「独立分组」与关闭态说明「统一分组（一次请求全部维度）」**与 V1 逐字**；
    //   v2.35.0：V1 开启态原文「独立分组（各维度可单独选预设并行请求）」现已**成立**（按维度选 API 分组已实现），故逐字恢复。
    const stateText = separate ? '独立分组（各维度可单独选预设并行请求）' : '统一分组（一次请求全部维度）';
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">维度分组（总开关）</div>',
        '<label class="ftt-field"><label style="width:170px">独立分组</label>'
        + '<label class="ftt-switch"><input type="checkbox" data-ftt-cfg="dimensionSeparate"' + (separate ? ' checked' : '') + '><span class="ftt-slider"></span></label>'
        + '<span class="ftt-muted">' + esc(stateText) + '</span></label>',
        '<div class="ftt-muted">开启后各维度**分别**构造提示词并**并行**请求，逐维度过账；未开启的维度合并成一个「统一」请求。</div>',
        '<div class="ftt-muted">V2 适配：维度子开关在「基础 → V2 附加设定 → 启用维度」（V1 的开关列在本节各行），故本节的维度行只出「分组」下拉。</div>',
        '<div class="ftt-muted">各维度 API 分组：选中的维度按该分组的连接单独请求（V1 同键 `cfg.dimensionPresets`，v1.206 14795）；未选中的维跟随主配置。分组在「API」页创建。</div>',
        '</div>',
        '<div class="ftt-section"><div class="ftt-sec-title">各维度独立子开关与分组（独立分组时生效）</div>',
        dimPresetRowsHtml(),
        '</div>',
        list.map((c) => settingsControlHtml(c)).join('\n'),
    ].join('\n');
}

/** 平行设定页（V1：控件表 + 「推演/推进分析渠道」选择器，v1.206 25816） */
export function parallelsPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    return [
        list.map((c) => settingsControlHtml(c)).join('\n'),
        '<div class="ftt-section"><div class="ftt-sec-title">推演/推进分析渠道</div>',
        parallelChannelFieldHtml(),
        '</div>',
    ].join('\n');
}

/** 页内「待后续批次」说明（不使用假实现） */
const PENDING_NOTE = {
    prompts: '提示词页的**模板分组编辑/恢复默认/签名迁移**在 B6 批次接入；本页先提供提示词相关开关与破限前置文本开关。',
    storage: '存储页的**探测/测试/同步动作**依赖 B7 批次的内核；本页先提供存储开关。',
};

/**
 * 单页 HTML（V1 同款子标签 + 字段列表 + 可选动作块 + 待办说明）。
 * @param {string} pageId 子页 id
 * @param {string} [extrasHtml] 仅**基础页**使用的「V2 附加设定」分节 HTML（v2.43.0：位置从页脚改为基础页内）
 */
export function settingsPageHtml(pageId, extrasHtml) {
    const pid = String(pageId || SETTINGS_TABS[0].id);
    const list = Array.isArray(SETTINGS_CONTROLS[pid]) ? SETTINGS_CONTROLS[pid] : [];
    // 存储页：V1 的**分节布局**（记忆文件 / 原生存储 / 缓冲 / 一致性 / 世界书 / 状态与操作 / 同步日志）
    //   控件表仍由 SETTINGS_CONTROLS.storage 提供（同名同序），只是不再平铺渲染。
    // API 页（B10-a / v2.35.0）：V1 同款两分节（API 分组（预设管理）+ API 设定（主 API 配置））+ 「按用途渠道」
    //   —— 控件为 V1 形态的自定义标记（`data-ftt-api` 在 V2 一律落成 `data-ftt-cfg`，见 ui/api-page.js 头注）
    if (pid === 'api') return apiPageHtml();
    if (pid === 'storage') return storagePageHtml(list);
    // 内容弱化（NSFW）页：V1 的**手写四节**（内容弱化 / 固定规则替换 / 转化库 / 识别词条库）
    if (pid === 'safety') return nsfwPageHtml();
    // 遗忘页：V1 的**五分节布局**（状态衰退 / 记忆遗忘 / 存储保底上限 / 通用清扫）+ V2 只读诊断行
    if (pid === 'forget') return forgetPageHtml(list);
    // 基础页：V1 的**分节布局**（组件开关 / 重要性 / 剧情时钟 / 巡检 / 界面特效），控件表同名同序
    if (pid === 'base') return basePageHtml(list, extrasHtml);
    // 分析记忆页（P9d）：V1 的「维度分组（总开关）」节 + 控件表同名同序
    if (pid === 'analyze') return analyzePageHtml(list);
    // 平行页（B10-a）：控件表 + V1 原位「推演/推进分析渠道」选择器
    if (pid === 'parallels') return parallelsPageHtml(list);
    // 调试页（B9-a）：V1 的「调试日志」开关节 + 「调试日志（…）」查看器节（`ui/debug.js#debugPageHtml`）
    if (pid === 'debug') return debugPageHtml(list);
    // 关于页（B9-a）：V1 的「关于 · FTT记忆组件 / 它是什么 / 版本更新」三节（`ui/about.js#aboutHtml`）+ V2 附加信息
    if (pid === 'about') return aboutPageHtml() + pageExtraHtml('about');
    // 投喂页（B9-c）：V1 的控件行 + 「投喂标签自动分析」节 + 投喂白/黑名单两节（`ui/feed-scan.js`）
    //   控件表同名同序；扫描 / 一键收录入口为 B9-c 新增（V1 约 25513~25527 同段落）
    if (pid === 'feed') return list.map((c) => settingsControlHtml(c)).join('\n') + feedScanSectionHtml() + feedTagListSectionsHtml();
    const rows = list.map((c) => settingsControlHtml(c)).join('\n');
    const extra = (pid === 'prompts' ? promptsPageHtml() : '') + pageExtraHtml(pid);
    const note = PENDING_NOTE[pid] ? '<div class="ftt-hint">' + esc(PENDING_NOTE[pid]) + '</div>' : '';
    return rows + extra + note + (list.length ? '' : (extra || note ? '' : '<div class="ftt-empty">（本页为动作页，见上述按钮）</div>'));
}

/** 页内动作块（只实现内核已就绪的：数据管理导出/导入/清台账/清空当前角色记忆；其余明确标注） */
function pageExtraHtml(pid) {
    if (pid === 'data') {
        return [
            '<h4 class="ftt-h4-inline">数据管理</h4>',
            snapshotSectionHtml(),
            '<div class="ftt-row">',
            '<button class="ftt-btn" data-ftt-action="exportState" title="导出当前角色记忆为 JSON（可保存为文件）">⬇ 导出 JSON</button>',
            '<button class="ftt-btn" data-ftt-action="importStateOpen" title="粘贴 JSON 导入（合并进当前容器）">⬆ 导入 JSON</button>',
            '<button class="ftt-btn ftt-err" data-ftt-action="clearFloors" title="只清「已处理楼层」记录，不删除任何记忆条目">🧹 清除已处理记录</button>',
            // B9-a：V1 数据管理页第 4 个按钮（`data-ftt-action="reset"`，文案逐字「🗑 清空当前角色记忆」）。
            //   V1 原始标记是 `<button class="ftt-btn" data-ftt-action="reset" class="ftt-hint-err">` —— **重复 class 属性**会被浏览器忽略后者，
            //   即 V1 实际拿不到 `ftt-hint-err` 的红色样式（原生标记缺陷）；V2 用既有 `ftt-err` 等价呈现并补上 title。
            '<button class="ftt-btn ftt-err" data-ftt-action="reset" title="清空当前角色的全部 FTT 记忆（不可恢复，建议先导出备份）">🗑 清空当前角色记忆</button>',
            '</div>',
            '<div class="ftt-field ftt-field-col"><label>导入 JSON（粘贴后点「导入」）</label><textarea data-ftt-import="1" rows="4" placeholder="{ ... }"></textarea></div>',
            '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="importStateApply">⬆ 导入</button></div>',
        ].join('\n');
    }
    if (pid === 'about') {
        return [
            '<h4 class="ftt-h4-inline">V2 附加信息</h4>',
            '<div class="ftt-item">版本：' + esc(VERSION) + ' · 模块：ftt_memory_v2</div>',
            '<div class="ftt-item">内核配置键：' + Object.keys(cfg || {}).length + ' · 默认配置键：' + Object.keys(defaultCfg || {}).length + '</div>',
            '<div class="ftt-hint">与 V1 的功能对齐按批次推进（B1–B9），进度见 docs/P8-功能对齐总表.md。</div>',
        ].join('\n');
    }
    return '';
}

/** 子标签条 HTML（V1 同款：`.ftt-tabs` 内的小标签） */
export function settingsSubTabsHtml(current) {
    const cur = String(current || SETTINGS_TABS[0].id);
    // V1 v1.206 L25988 逐字结构：`<a href="javascript:void(0)" class="ftt-subtab[ ftt-on]" data-ftt-subtab="<id>">`
    //   —— 修复（v2.34.0）：V2 此前用 `<button data-ftt-settings>`，**属性名与 V1 不一致**，且因面板点击分发
    //   「无 data-ftt-action 即 return」而**点击无效**。现按 V1 同款标记 + 分发前置处理修复。
    return SETTINGS_TABS.map((t) => '<a href="javascript:void(0)" class="ftt-subtab' + (t.id === cur ? ' ftt-on' : '') + '" data-ftt-subtab="' + esc(t.id) + '">' + esc(t.label) + '</a>').join('');
}

/** 设置页诊断（页/控件统计；测试与排障用） */
export function settingsPagesInfo() {
    return {
        pages: SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label, controls: (SETTINGS_CONTROLS[t.id] || []).length })),
        totalControls: Object.keys(SETTINGS_CONTROLS).reduce((n, k) => n + SETTINGS_CONTROLS[k].length, 0),
    };
}
