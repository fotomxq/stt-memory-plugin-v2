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
        { "key": "clockExtractEnabled", "label": "消息后自动同步时钟（只取最新情节）", "type": "checkbox" },
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
            "label": "触发比例",
            "hint": "默认 0.5 = 超出存储上限 50% 时触发衰退",
            "type": "text"
        },
        {
            "key": "stateDecayCutoff",
            "label": "移除阈值",
            "hint": "默认 0.95：保留度低于该值即移除",
            "type": "text"
        },
        {
            "key": "stateDecaySubjectYears",
            "label": "角色停更删除年限（剧情年）",
            "hint": "默认 0 = 不生效；填 >0 才启用「角色久未登场 → 整组删除其状态」",
            "type": "text"
        },
        {
            "key": "stateDecayStaleYears",
            "label": "单条久远年限（剧情年）",
            "hint": "默认 6：单条状态久未出现超过该年限即移除",
            "type": "text"
        },
        {
            "key": "stateRepairBatch",
            "label": "修复每轮主体数",
            "hint": "默认 3：每次「修复状态」处理的主体数量",
            "type": "text"
        },
        {
            "key": "stateRepairMatchSim",
            "label": "主体匹配相似度",
            "hint": "默认 0.72：低于该值视为匹配不到角色档案",
            "type": "text"
        },
        {
            "key": "memoryForgetEnabled",
            "label": "启用记忆遗忘",
            "hint": "再次被写入即刷新（想起）；只按剧情日期，不跌破保底",
            "type": "checkbox"
        },
        {
            "key": "memoryForgetRatio",
            "label": "触发比例",
            "hint": "默认 0.5 = 超出存储上限 50% 时触发遗忘",
            "type": "text"
        },
        {
            "key": "memoryForgetCutoff",
            "label": "遗忘阈值",
            "hint": "默认 0.95：保留度低于该值的旧记忆被移除",
            "type": "text"
        },
        {
            "key": "storeMinAtoms",
            "label": "情节保底",
            "hint": "默认 100：自动机制不会清到该条数以下",
            "type": "text"
        },
        {
            "key": "storeMaxAtoms",
            "label": "情节上限",
            "hint": "默认 400：常规裁剪目标",
            "type": "text"
        },
        {
            "key": "storeMinMemories",
            "label": "记忆保底",
            "hint": "默认 200",
            "type": "text"
        },
        {
            "key": "storeMaxMemories",
            "label": "记忆上限",
            "hint": "默认 600",
            "type": "text"
        },
        {
            "key": "storeMinSnapshots",
            "label": "角色档案保底",
            "hint": "默认 100",
            "type": "text"
        },
        {
            "key": "storeMaxSnapshots",
            "label": "角色档案上限",
            "hint": "默认 300",
            "type": "text"
        },
        {
            "key": "storeMinItems",
            "label": "物品保底",
            "hint": "默认 150",
            "type": "text"
        },
        {
            "key": "storeMaxItems",
            "label": "物品上限",
            "hint": "默认 400",
            "type": "text"
        },
        {
            "key": "storeMinConcepts",
            "label": "概念保底",
            "hint": "默认 200",
            "type": "text"
        },
        {
            "key": "storeMaxConcepts",
            "label": "概念上限",
            "hint": "默认 600",
            "type": "text"
        },
        {
            "key": "lowUseForgetEnabled",
            "label": "启用通用遗忘清扫",
            "hint": "随「自动修复」执行，零 AI 调用、缓慢生效",
            "type": "checkbox"
        },
        {
            "key": "lowUseForgetRatio",
            "label": "低使用比例",
            "hint": "默认 0.05：调用次数低于全库平均值该比例才可能被清",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinItems",
            "label": "条目数门槛",
            "hint": "默认 80：该维度条目少于此值不清理",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinAvg",
            "label": "平均调用门槛",
            "hint": "默认 5：平均调用次数低于该值才考虑清理",
            "type": "text"
        },
        {
            "key": "lowUseForgetMinFloors",
            "label": "长期未现楼层",
            "hint": "默认 300 楼；0 = 不生效",
            "type": "text"
        },
        {
            "key": "lowUseForgetMaxDelete",
            "label": "每轮最多清扫",
            "hint": "默认 1 条（每维度）",
            "type": "text"
        },
        {
            "key": "lowUseForgetProtectImportance",
            "label": "重要度保护",
            "hint": "默认 0.7：重要度 ≥ 该值不清扫",
            "type": "text"
        },
        {
            "key": "lowUseForgetEveryFloors",
            "label": "清扫间隔（楼）",
            "hint": "默认 40 楼；0 = 不限制",
            "type": "text"
        },
    
    ],
    "rumors": [
        {
            "key": "rumorEnabled",
            "label": "启用传言",
            "hint": "记录 + 演化 + 注入一并开启",
            "type": "checkbox"
        },
        {
            "key": "maxRumors",
            "label": "注入上限",
            "hint": "默认 6：每次最多注入几条传言",
            "type": "text"
        },
        {
            "key": "rumorChangeEveryRounds",
            "label": "演化间隔（楼）",
            "hint": "默认 5：每隔 N 楼演化一次",
            "type": "text"
        },
        {
            "key": "rumorChangeNeedRounds",
            "label": "演化所需轮次",
            "hint": "默认 2：单次变化需要几个轮次才生效（不会立刻变）",
            "type": "text"
        },
        {
            "key": "rumorFissionFerment",
            "label": "裂变发酵度",
            "hint": "默认 80：达到该发酵度才可能裂变",
            "type": "text"
        },
        {
            "key": "rumorFissionChance",
            "label": "裂变 / 变异概率",
            "hint": "0-1，默认 0.3",
            "type": "text"
        },
        {
            "key": "rumorParallelLinkSim",
            "label": "平行联动相似度",
            "hint": "默认 0.34：与平行事件标签的关联阈值",
            "type": "text"
        },
        {
            "key": "rumorParallelLinkChance",
            "label": "平行联动概率",
            "hint": "0-1，默认 0.35",
            "type": "text"
        },
        {
            "key": "rumorMediaLifeDays",
            "label": "载体寿命（剧情天）",
            "hint": "默认 30；实际寿命 = 本值 × 载体耐久度",
            "type": "text"
        },
        {
            "key": "rumorDecayEnabled",
            "label": "启用传言衰退",
            "hint": "超出存储上限后按保留度淘汰旧传言",
            "type": "checkbox"
        },
        {
            "key": "rumorDecayRatio",
            "label": "衰退触发比例",
            "hint": "默认 0.5 = 超出存储上限 50% 时触发",
            "type": "text"
        },
        {
            "key": "rumorDecayCutoff",
            "label": "移除阈值",
            "hint": "默认 0.95：保留度低于该值即移除",
            "type": "text"
        },
        {
            "key": "storeMinRumors",
            "label": "存储保底",
            "hint": "默认 0 = 无硬保底",
            "type": "text"
        },
        {
            "key": "storeMaxRumors",
            "label": "存储上限",
            "hint": "默认 200",
            "type": "text"
        },
    
    ],
    "parallels": [
        {
            "key": "parallelWeaveEnabled",
            "label": "提取后自动推演",
            "hint": "每次提取记忆后织入平行事件（交织推演）",
            "type": "checkbox"
        },
        {
            "key": "parallelWeaveInterval",
            "label": "被动推演间隔（楼）",
            "hint": "默认 10 楼：被动触发的楼层间隔",
            "type": "text"
        },
        {
            "key": "maxParallels",
            "label": "存储上限",
            "hint": "默认 30：平行事件最多保留条数",
            "type": "text"
        },
        {
            "key": "maxParallelsInj",
            "label": "注入上限",
            "hint": "默认 8：每次最多注入几条平行事件",
            "type": "text"
        },
        {
            "key": "parallelDecayEnabled",
            "label": "启用平行事件衰退",
            "hint": "超出上限后按保留度淘汰旧事件",
            "type": "checkbox"
        },
        {
            "key": "parallelDecayRatio",
            "label": "衰退触发比例",
            "hint": "默认 0.5 = 超出上限 50% 时触发",
            "type": "text"
        },
        {
            "key": "parallelDecayCutoff",
            "label": "移除阈值",
            "hint": "默认 0.95：保留度低于该值即移除",
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
            "label": "快照存独立文件",
            "type": "checkbox"
        },
        {
            "key": "storage.settingsMirror",
            "label": "同时写回存档变量（兼容旧格式）",
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
            "label": "载入时校验数据完整性",
            "type": "checkbox"
        },
        {
            "key": "storage.syncOnSave",
            "label": "保存时同步到服务端",
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
            "label": "同步前先比对清单（省流量·推荐开启）",
            "type": "checkbox"
        },
        {
            "key": "storage.syncLogServer",
            "label": "日志存到服务端（双端可见·推荐开启）",
            "type": "checkbox"
        },
        {
            "key": "storage.deletedKeepDays",
            "label": "已删除条目的保留天数",
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
            "label": "仅变化时同步（省流量·推荐开启）",
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
import { CN_KEY_MAP } from '../core/config.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { worldbookNames } from '../host/worldbook.js';
import { promptsPageHtml, promptAction } from './prompts.js';
import { snapshotSectionHtml } from './snapshots.js';
import { hintDetailsHtml, paramListHtml, shortHintHtml } from './hints.js';
import { extractPageHtml } from './extract-page.js';
import { storagePageHtml } from './sync.js';
import { nsfwPageHtml } from './nsfw.js';
import { forgetPageHtml } from './forget.js';
import { debugPageHtml } from './debug.js';
import { aboutHtml as aboutPageHtml } from './about.js';
import { bufferSectionHtml } from './buffer-manage.js';
import { feedScanSectionHtml, feedTagListSectionsHtml } from './feed-scan.js';
// v2.65.0：显示界面开关 = V1 同款入口清单（顶栏 / 页面底部 / 悬浮 / 扩展菜单）
import { ENTRY_LOCATIONS, ENTRY_LABELS, ENTRY_DEFAULTS, FORCED_ENTRIES } from './entries.js';
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
    const hint = String(c.hint || '');
    const tip = hint ? (' title="' + esc(hint) + '"') : '';
    const mark = hint ? (' <span class="ftt-hint-mark"' + tip + '>ⓘ</span>') : '';
    if (type === 'checkbox') {
        // V1 `swForce`：被强制项（如「及时分析」开启时的 autoExtract/autoSummary/injectCurrentPrompt）显示为强制开启且禁用
        const forced = !!(c.forceWhen && (() => { try { return readControl(String(c.forceWhen)) === true; } catch (e) { return false; } })());
        const on = forced || (v !== false && v !== undefined && v !== null && v !== '' && v !== 0);
        return '<div class="ftt-field"><label' + tip + '>' + esc(label) + mark + '</label>'
            + '<label class="ftt-switch"' + tip + '><input type="checkbox" data-ftt-cfg="' + esc(key) + '"' + (on ? ' checked' : '') + (forced ? ' disabled' : '') + '><span class="ftt-slider"></span></label>'
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
        return '<div class="ftt-field"><label' + tip + '>' + esc(label) + mark + '</label><select data-ftt-cfg="' + esc(key) + '"' + tip + '>' + opts + '</select></div>';
    }
    if (type === 'textarea') {
        return '<div class="ftt-field ftt-field-col"><label' + tip + '>' + esc(label) + mark + '</label><textarea data-ftt-cfg="' + esc(key) + '"' + tip + ' rows="4">' + esc(v == null ? '' : v) + '</textarea></div>';
    }
    const missing = (v === undefined);
    return '<div class="ftt-field"><label' + tip + '>' + esc(label) + (missing ? ' <span class="ftt-muted">（未定义）</span>' : '') + mark + '</label>'
        + '<input type="' + (type === 'number' ? 'number' : 'text') + '" data-ftt-cfg="' + esc(key) + '"' + tip + ' value="' + esc(v == null ? '' : v) + '"></div>';
}

/**
 * 「显示界面开关」行（V1 v1.206 `buttonLocationRowsHtml()` 同款结构：`.ftt-loc-row` + `.ftt-loc-name` + 开关 + 显示/隐藏）。
 * v2.65.0（用户要求）：
 *   ① 与 V1 对齐：顶栏按钮 / 页面底部按钮 / 悬浮按钮 / 扩展菜单项 四项，顺序、名称、默认值、显示/隐藏 文案均与 V1 相同；
 *   ② **扩展菜单项强制开启**（`FORCED_ENTRIES`）：不渲染开关，只给一行「始终开启」；
 *   ③ V2 附加一项「扩展设置抽屉卡片」（`cfg.uiShowDrawer`，V1 无此形态）。
 * 开关用 V1 同款标记 `data-ftt-loc="<loc>"`（面板委托写 `cfg.buttonLocations[loc]` 并即时重建入口）。
 */
function entryLocationRowsHtml() {
    const loc = (() => { try { return cfg.buttonLocations || {}; } catch (e) { return {}; } })();
    const rows = ENTRY_LOCATIONS.map((l) => {
        const label = ENTRY_LABELS[l] || l;
        if (FORCED_ENTRIES.indexOf(l) >= 0) {
            return '<div class="ftt-loc-row"><span class="ftt-loc-name">' + esc(label) + '</span><span class="ftt-muted">始终开启（主入口，不可关闭）</span></div>';
        }
        const on = (loc[l] === undefined || loc[l] === null) ? ENTRY_DEFAULTS[l] === true : !!loc[l];
        return '<div class="ftt-loc-row"><span class="ftt-loc-name">' + esc(label) + '</span>'
            + '<label class="ftt-switch"><input type="checkbox" data-ftt-loc="' + esc(l) + '"' + (on ? ' checked' : '') + '><span class="ftt-slider"></span></label>'
            + '<span class="ftt-muted">' + (on ? '显示' : '隐藏') + '</span></div>';
    });
    const drawer = (() => { try { return cfg.uiShowDrawer === true; } catch (e) { return false; } })();
    rows.push('<div class="ftt-loc-row"><span class="ftt-loc-name">扩展设置抽屉卡片</span>'
        + '<label class="ftt-switch"><input type="checkbox" data-ftt-cfg="uiShowDrawer"' + (drawer ? ' checked' : '') + '><span class="ftt-slider"></span></label>'
        + '<span class="ftt-muted">' + (drawer ? '显示' : '隐藏') + '</span></div>');
    return rows.join('\n');
}

/**
 * 基础页正文（v2.51.0：组件开关 / 重要性计算 / 剧情时钟（只取最新情节）/ 情节日期时间修复 / 界面特效）。
 * v2.65.0：「显示界面开关」按 V1 v1.206 `buttonLocationRowsHtml()` 对齐（顶栏 / 页面底部 / 悬浮 / 扩展菜单项 +
 *   开关即时生效）；扩展菜单项强制开启、不展示开关（用户要求）；另加 V2 附加的「扩展设置抽屉卡片」；
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

        // v2.51.0 时钟改版（用户要求）：「只取最新情节」为唯一可信来源 —— 以下设定与提示按新设计重写，
        //   不再保留任何「正文正则/自定义正则/相对日期/强制降级/年份异常阈值/第N天纪元/自动巡检」等废弃内容。
        '<div class="ftt-section"><div class="ftt-sec-title">剧情时钟（总览 日期/时间/地点）</div>',
        rows(['clockExtractEnabled']),
        '<div class="ftt-muted">时钟只取<b>最新一条「情节」</b>的日期 / 时间 / 地点。</div>',
        hintDetailsHtml('说明', '<div>' + esc('其它维度（记忆 / 角色 / 物品 / 货币 / 传言 / 计划 / 悬念 / 场景 / 概念 / 平行事件）与正文解析都不参与；情节总结与已总结隐藏的情节也不算。最新情节没有日期时退到次新的带日期情节；完全没有可用情节则保持原值（不清空）。需要人工校正时用总览「✏️ 手工改写日期/时间/地点」。') + '</div>'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">情节日期时间修复（只针对情节）</div>',
        rows(['clockRepairBatch']),
        '<div class="ftt-muted">只检查<b>情节</b>里格式非法的日期与时间；无可信锚点时只报告、不修改。</div>',
        hintDetailsHtml('说明', '<div>' + esc('锚点 = 手工改写 ＞ 当前时钟（都来自可信情节）；写回前自动留全量快照，可回滚。') + '</div>'),
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="clockRepair" title="把情节里格式非法的日期/时间连同该条正文交 AI 判定并修复（只改情节的日期与时间字段）">🩺 AI 结合正文修复日期时间</button></div>',
        '<div class="ftt-hint">AI 修复只打包<b>情节</b>中格式非法的条目，逐条给新日期/时间；格式非法或偏离锚点的结果一律丢弃并如实回报。</div></div>',

        '<div class="ftt-section"><div class="ftt-sec-title">显示界面开关</div>',
        entryLocationRowsHtml(),
        shortHintHtml('插件自建入口的显示开关，改完即时生效；扩展菜单项是主入口，始终开启、不可关闭。'),
        hintDetailsHtml('说明', '<div>' + esc('顶栏按钮 = 酒馆顶栏的抽屉按钮；页面底部按钮 = 输入区快捷栏按钮；悬浮按钮 = 页面右下角圆形按钮；扩展菜单项 = 魔杖菜单里的「FTT记忆」（主入口，始终开启）。宿主缺少对应容器时该入口不会出现。悬浮按钮关闭后，若面板挂不上抽屉，仍会自动出现一次兜底入口，避免装上了却看不到。扩展设置抽屉卡片会在酒馆「扩展设置」区块内联渲染面板（默认关，用弹窗即可）。') + '</div>'),
        '</div>',

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
        '<div class="ftt-muted">开启后各维度<b>分别</b>构造提示词并<b>并行</b>请求；未开启的维度合并成一个「统一」请求。</div>',
        '<div class="ftt-muted">维度子开关在「附加设定 → 启用维度」；下方每组只选「API 分组」，未选 = 跟随主配置（分组在「API」页创建）。</div>',
        '</div>',
        '<div class="ftt-section"><div class="ftt-sec-title">各维度独立子开关与分组（独立分组时生效）</div>',
        dimPresetRowsHtml(),
        '</div>',
        list.map((c) => settingsControlHtml(c)).join('\n'),
    ].join('\n');
}

/**
 * 传言设定页（控件表 + 折叠说明）。
 * v2.57.0（用户要求：言简意赅 + 扩展提示走 UI 交互）：页面上只留一句「传言怎么流转」，
 *   每个参数的含义由控件 `hint`（悬停提示）与「ⓘ 参数说明」折叠块承载，不再把长解释铺在页面上。
 */
export function rumorsPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    return [
        shortHintHtml('传言：记录 → 按剧情轮次演化 → 注入；发酵到阈值可裂变。'),
        list.map((c) => settingsControlHtml(c)).join('\n'),
        hintDetailsHtml('参数说明',
            '<div>' + esc('裂变 = 发酵度达到阈值后按概率分裂出新传言（可与平行事件联动）；衰退 = 超出存储上限后按保留度淘汰旧传言。') + '</div>'
            + paramListHtml(list)),
    ].join('\n');
}

/** 平行设定页（V1：控件表 + 「推演/推进分析渠道」选择器，v1.206 25816） */
export function parallelsPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    return [
        shortHintHtml('平行事件：主线的「另一种可能」，不影响当前剧情。'),
        list.map((c) => settingsControlHtml(c)).join('\n'),
        hintDetailsHtml('参数说明',
            '<div>' + esc('被动推演按楼层间隔自动触发；衰退在超出存储上限后按保留度淘汰旧事件。') + '</div>'
            + paramListHtml(list)),
        '<div class="ftt-section"><div class="ftt-sec-title">推演/推进分析渠道</div>',
        parallelChannelFieldHtml(),
        '</div>',
    ].join('\n');
}

// v2.55.0（用户要求：页面上不要开发/历史内容）：删除原来的 PENDING_NOTE（提示词页/存储页各一条
//   「在 B6/B7 批次接入…」的**开发批次说明**）——那些批次早已交付，留着只会让用户看到过时的开发内容。

/**
 * 单页 HTML（V1 同款子标签 + 字段列表 + 可选动作块）。
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
    // 传言页（v2.57.0）：控件表 + 一句短提示 + 折叠「参数说明」
    if (pid === 'rumors') return rumorsPageHtml(list);
    // 提取页（v2.58.0）：V1 的三层结构布局（向量层含 Embedding / Rerank API 区块 + kw/mem 分组 + 测试按钮）
    if (pid === 'extract') return extractPageHtml(list, settingsControlHtml);
    // 调试页（B9-a）：V1 的「调试日志」开关节 + 「调试日志（…）」查看器节（`ui/debug.js#debugPageHtml`）
    if (pid === 'debug') return debugPageHtml(list);
    // 关于页（B9-a）：V1 的「关于 · FTT记忆组件 / 功能 / 版本更新」三节（`ui/about.js#aboutHtml`）
    //   v2.53.0：不再追加「V2 附加信息」开发块（`pageExtraHtml('about')` 已返回空串）
    if (pid === 'about') return aboutPageHtml();
    // 投喂页（B9-c）：V1 的控件行 + 「投喂标签自动分析」节 + 投喂白/黑名单两节（`ui/feed-scan.js`）
    //   控件表同名同序；扫描 / 一键收录入口为 B9-c 新增（V1 约 25513~25527 同段落）
    if (pid === 'feed') return list.map((c) => settingsControlHtml(c)).join('\n') + feedScanSectionHtml() + feedTagListSectionsHtml();
    const rows = list.map((c) => settingsControlHtml(c)).join('\n');
    const extra = (pid === 'prompts' ? promptsPageHtml() : '') + pageExtraHtml(pid);
    return rows + extra + (list.length || extra ? '' : '<div class="ftt-empty">（本页为动作页，见上述按钮）</div>');
}

/**
 * 页内动作块（只实现内核已就绪的：数据管理导出/导入/清台账/清空当前角色记忆；其余明确标注）
 *
 * v2.54.0 数据管理页重排（用户报告：「下面的导入和导出 UI 设计有问题，请完善」＋
 *   「提示信息过于罗嗦，完全没告清楚用户这是什么、使用有什么后果」）：
 *   ① 按**用途分块**：📤 导出备份 / 📥 导入存档（合并）/ ⚠️ 删除数据（不可恢复）/ 🧬 快照链 / 🗂 本地缓冲；
 *   ② 导出与导入不再和「清空」类按钮挤在同一行（危险动作隔离，各自带后果说明）；
 *   ③ 粘贴导入的文本框与它的「导入」按钮**紧挨在一起**（旧布局把按钮甩到缓冲分节之后）；
 *   ④ 每条提示只讲两件事：这是做什么的 + 做了会怎样（不写实现细节）。
 */
function pageExtraHtml(pid) {
    if (pid === 'data') {
        return [
            // ① 导出
            '<div class="ftt-section"><div class="ftt-sec-title">📤 导出备份</div>',
            '<div class="ftt-hint">把当前角色的全部记忆导出成 JSON 文件并下载到本机（同时复制到剪贴板），可用于备份或迁移到同一角色的其它设备。</div>',
            '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="exportState" title="导出当前角色全部记忆为 JSON 文件（触发浏览器下载）">⬇ 导出 JSON 文件</button></div>',
            '</div>',
            // ② 导入（文件 + 粘贴两条路，各自与说明和按钮成组）
            '<div class="ftt-section"><div class="ftt-sec-title">📥 导入存档（合并）</div>',
            '<div class="ftt-hint">把 JSON 里的记忆<b>并入</b>当前角色：相同跳过、新条目插入、变更以文件为准；<b>不会删除</b>本地记忆。</div>',
            '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="importStateOpen" title="选择 JSON 存档文件后增量合并（相同跳过 / 新增插入 / 变更覆盖，不删除本地数据）">⬆ 选择文件导入</button></div>',
            '<div class="ftt-field ftt-field-col"><label>或者把 JSON 内容粘贴到这里：</label>'
            + '<textarea data-ftt-import="1" rows="4" placeholder="{ ... }"></textarea></div>',
            '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="importStateApply" title="导入上方文本框中的 JSON（合并规则同上）">⬆ 导入粘贴内容</button></div>',
            '</div>',
            // ③ 危险动作单独成块
            '<div class="ftt-section"><div class="ftt-sec-title">⚠️ 删除数据（不可恢复）</div>',
            '<div class="ftt-hint">下面两项都会永久删除本地记录，<b>删除前建议先「⬇ 导出 JSON 文件」备份</b>。</div>',
            '<div class="ftt-row">',
            '<button class="ftt-btn" data-ftt-action="clearFloors" title="只清「已处理楼层」的计数，不删除任何记忆条目">🧹 清除已处理楼层记录</button>',
            // B9-a：V1 数据管理页第 4 个按钮（`data-ftt-action="reset"`，文案逐字「🗑 清空当前角色记忆」）。
            //   V1 原始标记是 `<button class="ftt-btn" data-ftt-action="reset" class="ftt-hint-err">` —— **重复 class 属性**会被浏览器忽略后者，
            //   即 V1 实际拿不到 `ftt-hint-err` 的红色样式（原生标记缺陷）；V2 用既有 `ftt-err` 等价呈现并补上 title。
            '<button class="ftt-btn ftt-err" data-ftt-action="reset" title="删除当前角色的全部记忆（不可恢复）">🗑 清空当前角色记忆</button>',
            '</div>',
            '<div class="ftt-hint ftt-mb-0">· 清除已处理楼层记录：只重置「哪些楼层已摘要」，记忆条目一条不删；</div>',
            '<div class="ftt-hint">· 清空当前角色记忆：删除该角色的全部记忆条目，其它角色不受影响。</div>',
            '</div>',
            // ④ 快照链（只统计 + 动作，明细折叠在「高级」里）
            '<div class="ftt-section"><div class="ftt-sec-title">🧬 快照链（自动备份）</div>', snapshotSectionHtml(), '</div>',
            // ⑤ 本地缓冲（统计 + 清理；v2.53.0 起从「关于」页迁来）
            '<div class="ftt-section">', bufferSectionHtml(), '</div>',
        ].join('\n');
    }
    if (pid === 'about') {
        // v2.53.0（用户要求）：「关于」页不再附开发/历史说明（原「V2 附加信息」＝ 版本 / 模块名 / 内核配置键数 /
        //   对齐进度指引）—— 该页只由 `ui/about.js#aboutHtml()` 呈现「功能 + 版本更新」，言简意赅。
        return '';
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
