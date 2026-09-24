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
        {
            "key": "importanceBase",
            "label": "初始重要性(0次调用)",
            "type": "text"
        },
        {
            "key": "importancePerUse",
            "label": "每次调用增量",
            "type": "text"
        },
        {
            "key": "clockDateRegex",
            "label": "自定义 · 日期正则",
            "type": "text"
        },
        {
            "key": "clockTimeRegex",
            "label": "自定义 · 时间正则",
            "type": "text"
        },
        {
            "key": "clockLocationRegex",
            "label": "自定义 · 地点正则",
            "type": "text"
        },
        {
            "key": "clockAnomalyJumpYears",
            "label": "日期异常判定：与当前时钟相差超过 N 年（默认 50，0 = 关闭）",
            "type": "text"
        },
        {
            "key": "clockStoryDayEpoch",
            "label": "正文头「第 N 天」纪元首日（如 0001-01-01；留空 = 只记录天数不换算）",
            "type": "text"
        },
        {
            "key": "clockRepairBatch",
            "label": "AI 结合正文修复：单次提交条数（默认 20）",
            "type": "text"
        },
        {
            "key": "timelyAnalysis",
            "label": "⚡ 及时分析（实时模式）",
            "type": "checkbox"
        },
        {
            "key": "autoExtract",
            "label": "消息后自动摘取",
            "type": "checkbox"
        },
        {
            "key": "autoSummary",
            "label": "生成后自动 AI 摘要",
            "type": "checkbox"
        },
        {
            "key": "injectCurrentPrompt",
            "label": "注入当前提示词",
            "type": "checkbox"
        }
    ],
    "feed": [
        {
            "key": "feedFloors",
            "label": "摘要使用最近楼层数",
            "type": "text"
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
        }
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
            "key": "plotSegmentTextLimit",
            "label": "单条剧情线概述字数上限（默认 400）",
            "type": "text"
        }
    ],
    "safety": [],
    "extract": [
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
        }
    ],
    "forget": [
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
        }
    ],
    "rumors": [
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
        }
    ],
    "parallels": [
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
            "key": "parallelDecayRatio",
            "label": "触发比例（默认 0.5＝超出上限 50% 触发）",
            "type": "text"
        },
        {
            "key": "parallelDecayCutoff",
            "label": "移除阈值（默认 0.95）",
            "type": "text"
        }
    ],
    "prompts": [
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
        }
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
    "debug": [],
    "data": [],
    "about": []
};

// ============================================================
// ui/settings-pages.js —— V1 设定 **14 组子页**（结构与控件表由 V1 源码自动提取，保证同名同序同键）
// 来源：V1 `src/modules/13-UI-设置与存储开关.js` 的 `subTabs` 与各页 `f(key,label,type)` / `swT` / `swForce` / `stSwitch` 调用
//   （提取脚本见 docs/P8e-B4设定子页.md）。共 **105 个配置控件**，键写回内核 `cfg`（`storage.*` 为 `cfg.storage.*`）。
// 说明：本批交付**框架 + 全部配置控件 + 数据管理动作**；依赖尚未移植内核的页面动作（NSFW 词条/规则库、提示词签名迁移、
//   存储探测、调试面板）在页内以「待 B6/B7/B8 批次」标注，不使用假实现。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { defaultCfg, CN_KEY_MAP } from '../core/config.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { VERSION } from '../core/constants.js';
import { promptsPageHtml, promptAction } from './prompts.js';
import { snapshotSectionHtml } from './snapshots.js';
import { storagePageHtml } from './sync.js';

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
        const on = v !== false && v !== undefined && v !== null && v !== '' && v !== 0;
        return '<div class="ftt-field"><label>' + esc(label) + '</label>'
            + '<label class="ftt-switch"><input type="checkbox" data-ftt-cfg="' + esc(key) + '"' + (on ? ' checked' : '') + '><span class="ftt-slider"></span></label>'
            + '<span class="ftt-muted">' + (on ? '已开启' : '已关闭') + '</span></div>';
    }
    if (type === 'select') {
        const list = Array.isArray(c.options) ? c.options : [];
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

/** 页内「待后续批次」说明（不使用假实现） */
const PENDING_NOTE = {
    api: 'API 页在 V1 用于配置自定义 API/代理；V2 走宿主（ST 自身）的生成能力，因此本页仅保留相关配置键，模型/连接选择在 ST 的「连接」面板。',
    safety: '内容弱化的**词条库与固定规则库编辑**依赖尚未移植的内核（B8 批次）；本页先提供开关类配置。',
    debug: '调试页的日志面板与缓存清理（B9 批次）；本页先提供调试相关配置键。',
    prompts: '提示词页的**模板分组编辑/恢复默认/签名迁移**在 B6 批次接入；本页先提供提示词相关开关与破限前置文本开关。',
    storage: '存储页的**探测/测试/同步动作**依赖 B7 批次的内核；本页先提供存储开关。',
};

/** 单页 HTML（V1 同款子标签 + 字段列表 + 可选动作块 + 待办说明） */
export function settingsPageHtml(pageId) {
    const pid = String(pageId || SETTINGS_TABS[0].id);
    const list = Array.isArray(SETTINGS_CONTROLS[pid]) ? SETTINGS_CONTROLS[pid] : [];
    // 存储页：V1 的**分节布局**（记忆文件 / 原生存储 / 缓冲 / 一致性 / 世界书 / 状态与操作 / 同步日志）
    //   控件表仍由 SETTINGS_CONTROLS.storage 提供（同名同序），只是不再平铺渲染。
    if (pid === 'storage') return storagePageHtml(list);
    const rows = list.map((c) => settingsControlHtml(c)).join('\n');
    const extra = (pid === 'prompts' ? promptsPageHtml() : '') + pageExtraHtml(pid);
    const note = PENDING_NOTE[pid] ? '<div class="ftt-hint">' + esc(PENDING_NOTE[pid]) + '</div>' : '';
    return rows + extra + note + (list.length ? '' : (extra || note ? '' : '<div class="ftt-empty">（本页为动作页，见上述按钮）</div>'));
}

/** 页内动作块（只实现内核已就绪的：数据管理导出/导入/清台账；其余明确标注） */
function pageExtraHtml(pid) {
    if (pid === 'data') {
        return [
            '<h4 class="ftt-h4-inline">数据管理</h4>',
            snapshotSectionHtml(),
            '<div class="ftt-row">',
            '<button class="ftt-btn" data-ftt-action="exportState" title="导出当前角色记忆为 JSON（可保存为文件）">⬇ 导出 JSON</button>',
            '<button class="ftt-btn" data-ftt-action="importStateOpen" title="粘贴 JSON 导入（合并进当前容器）">⬆ 导入 JSON</button>',
            '<button class="ftt-btn ftt-err" data-ftt-action="clearFloors" title="只清「已处理楼层」记录，不删除任何记忆条目">🧹 清除已处理记录</button>',
            '</div>',
            '<div class="ftt-field ftt-field-col"><label>导入 JSON（粘贴后点「导入」）</label><textarea data-ftt-import="1" rows="4" placeholder="{ ... }"></textarea></div>',
            '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="importStateApply">⬆ 导入</button></div>',
        ].join('\n');
    }
    if (pid === 'about') {
        return [
            '<h4 class="ftt-h4-inline">关于</h4>',
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
    return SETTINGS_TABS.map((t) => '<button class="ftt-btn ftt-sm ftt-subtab' + (t.id === cur ? ' ftt-on' : '') + '" data-ftt-settings="' + esc(t.id) + '">' + esc(t.label) + '</button>').join(' ');
}

/** 设置页诊断（页/控件统计；测试与排障用） */
export function settingsPagesInfo() {
    return {
        pages: SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label, controls: (SETTINGS_CONTROLS[t.id] || []).length })),
        totalControls: Object.keys(SETTINGS_CONTROLS).reduce((n, k) => n + SETTINGS_CONTROLS[k].length, 0),
    };
}
