// ============================================================
// core/config.js —— **逐字移植自 V1**（src/modules/03-中文键映射与配置.js + 07 的 KIND_MAP）
// 覆盖：`defaultCfg` 全量默认配置（14 类维度 + 修复/遗忘/时钟/传言/NSFW/存储等键）、33 条提示词模板
//   `PROMPT_TEMPLATES_V2` 与默认版本、中文键映射 `CN_KEY_MAP` / `normalizeDeltaKeys`、维度标签、`KIND_MAP`。
// 适配：ESM 化 + 注入视图（cfg/state）；`KIND_MAP` 的 get/set 直接读写注入的 state（与 V1 同语义）。
// 生成方式：**显式清单**（不用闭包）+ 以「下一个顶层声明」为界并在顶层收尾行截断（避免吃到后续语句）。
// 一致性由 tests/unit/config-golden.test.js 的黄金样本强制校验。
// ============================================================
// v3.46.1（`docs/D22` W11 技-44）：三域联动的**默认提示词全文**落在新模块（`docs/05` §5 C11 + 体量棘轮）——
//   本文件只在 `PROMPT_TEMPLATES_V2.triLink` **引用**它（键与分组仍在 config，文案唯一事实源在那边）。
// v3.46.2（W13 应-30）：货币融合的默认提示词全文（新模块；见 PROMPT_TEMPLATES_V2.currencyMerge）
// v3.49.1（技-14 体量棘轮）：角色修复族 / 履历的默认键外移到独立模块，在此**原位置展开**（键值顺序不变）
import { CHARACTER_DEFAULTS } from './config-character.js';
import { RESUME_DEFAULTS } from './config-resume.js';   // v3.47.0（W16 应-33）：履历批量完善的提示词全文在新模块
import { normText, normalizeList, clamp, hashText } from './util.js';
import { cfg, state } from './model/runtime.js';
// v3.23.0：「每段正文数」默认值唯一事实源（`3`）—— 全部 AI 摘要入口共用同一段长口径
import { SUMMARY_CHUNK_DEFAULT } from './chunk.js';

const CN_KEY_MAP = {
    '当前状态': 'state', '情节': 'atoms', '状态记录': 'states', '角色档案': 'snapshots', '平行事件': 'parallels',
    '记忆库': 'memories', '物品库': 'items', '计划库': 'plans', '悬念库': 'suspense',
    '概念库': 'concepts', '概念': 'concepts', '平行事件': 'parallels',
    '名册': 'npcs', '场景库': 'scenes', '变量': 'vars',
    '地图库': 'maps', '地图': 'maps', '空间单元': 'place', '所属场所': 'sceneRef', '上层': 'parentId', '起点': 'fromId', '终点': 'toId', '距离': 'distance', '耗时': 'timeCost', '所需时间': 'timeCost', '走过': 'traversed', '方向': 'direction', '别名': 'aliases', '证据': 'evidence',   // v3.47.3（W18 数-22）：地图库键与字段名；`层级` 已在下方既有映射（→ level），不重复登记
    // v1.14 修复：SNAP_GROUP_MAP 必须在 loadState/migrateState 调用前初始化（TDZ），故置于此处
    '新增': 'add', '更新': 'update', '删除': 'remove', '重建': 'rebuild', '了结': 'close',
    '合并': 'merge',   // v3.50.5（`应-41`）：计划修复合同的中文键「合并」此前不在表内 → 应用器永不命中（`D45` §2.3 F2）
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

const DIMENSIONS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'];   // v1.192：新增传言（与其他分析记忆维度一起抽取）

const DIM_LABELS = { atoms: '情节', states: '状态', snapshots: '角色', memories: '记忆', items: '物品', plans: '计划悬念', scenes: '场景', concepts: '概念', parallels: '平行事件', currencies: '货币', rumors: '传言' };

const PROMPT_DEFAULT_VERSION = 'v1.195';   // v1.195：新增「内容弱化（NSFW）」模板（分析侧开关 / 总览手动按钮共用核心）

const PROMPT_GROUPS = [
    { title: '⓪ 破限提示词（分析记忆前置）', desc: '分析记忆时贴在系统提示词最前面的自定义文本，用于约束口径与风格；开关关闭即不生效。', keys: ['armorPreset'], switchKey: 'armorPresetEnabled', switchLabel: '启用破限提示词', extra: 'armorPresetFile' },
    { title: '① 通用总则', desc: '所有维度抽取的顶层规范（最前置投喂：输出格式 / 日期 / 维度边界 / 推断与编造 / 标签 / 上限）', keys: ['general'] },
    { title: '② 维度抽取模板', desc: '各维度的抽取骨架：记录什么 / 边界 / 字段 / 上限 / 输出 / 示例（货币维度另有动态识别与标定跟踪模板）。', keys: ['state', 'atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'npcs', 'scenes', 'maps', 'concepts', 'currencies', 'currenciesDynamic', 'currenciesTracked', 'rumors', 'vars', 'parallels'] },
    { title: '③ 召回与注入辅助', desc: '关键词提取 / 记忆筛选发送 / 注入使用说明 —— 决定「查什么、发什么、怎么用」', keys: ['keywordExtract', 'memorySend', 'injectGuide'] },
    { title: '④ 质检维护', desc: '质检修复规则 + 各维专用修复 + 角色履历补全 + 分段总结 + 内容弱化与词条分析（与「NSFW弱化」页共用）。', keys: ['repair', 'sceneRepair', 'conceptRepair', 'memoryRepair', 'itemRepair', 'characterRepair', 'resumeRepair', 'planSuspRepair', 'triLink', 'currencyMerge', 'resumeBatch', 'statesRepair', 'plotSegment', 'clockRepair', 'nsfwSoften', 'nsfwAnalyze'] },
];

import { PROMPT_TEMPLATES_V2 } from './prompts-v2.js';   // v3.50.15（`技-56`）：提示词表外提（内容零改动）

/**
 * v3.44.0（`docs/D22` W4 `数-11` ①）：**关联锚点强制补丁**的文本（**不可编辑的常量，不是提示词模板**）。
 *
 * 为什么不做成可编辑模板：
 *   · 它必须与代码里的判据**逐字对齐** —— 在场的知情方式集合在 `core/rel-maint.js#REL_ANCHOR_PRESENT_HOWS`
 *     （participant / witness / author / involved），机械回填与体检也按同一集合算。让用户改提示词会造成
 *     「AI 按 A 规则写、插件按 B 规则判」的**口径分叉** —— 那比不能改更糟。
 *   · 也避免新增一个 `promptTemplates.*` 键：`scripts/check-config-decl.js` 的基线是**「只减不增」**，
 *     新键没有独立控件就不允许（见该脚本头部说明）。
 * 开关：`cfg.relAnchorRuleEnabled`（默认关；「设定 → 分析记忆 → 入库卫生」）。关闭时**完全不追加**。
 */
const REL_ANCHOR_RULE_V2 = [
    '【关联锚点（强制，逐条检查）】写「关联」数组时，三个锚点字段按下述规则**必填**：',
    '1. 「知情时间」—— 方式为 亲历 / 目击 / 当事人 / 策划 时**必须**填（= 这件事发生的剧情日期，YYYY-MM-DD）；',
    '   方式为 被告知 / 推断 / 传闻 时**不要**填（他们的知情时间晚于事发，填了就是错的）。',
    '2. 「告知者」—— 方式为「被告知」时**必须**填姓名（确实不知道是谁告诉的，就把方式改成 推断 或 传闻，不要留空）。',
    '3. 「差异」—— 这个人的看法 / 感受与共同正文**不同**时**必须**填（与他人一致才可省略）。',
    '写不出上述任一必填项时，说明这条关联**依据不足** —— 宁可少列一个人，也不要编造锚点。',
].join('\n');
/** 关联锚点强制补丁的默认文本（只读出口；`core/prompt.js` 在开关开启时追加） */
export const REL_ANCHOR_RULE_DEFAULT = REL_ANCHOR_RULE_V2;

const PROMPT_LEGACY_SIGS = {
    general: ['22754696-1196', '1d47b568-618', '799e6b14-1074', '8ee41858-1367', 'f1b36d20-1359'],   // v1.192：末位为改版前默认（13 键 → 15 键，补货币/传言）
    state: ['e5ed159e-586', '655e56b2-583', '87aae907-293', 'a8b08d6c-425', '97981ec0-583'],
    atoms: ['fd5497d4-1144', '948d47cf-1376', '6fcc64e0-923', '1da0e8e4-1158'],
    states: ['bf6f78e6-849', 'c3bb7e0-993', '3ea7d668-651', '84ddb943-1126'],
    snapshots: ['7fa44918-960', '83a70188-861', '5af9bc26-787', 'c708d9e0-1055', 'd0e90699-1142', '62057628-1134', '9cae6248-1452'],   // v1.193：末位为改版前默认（出生日期补「公元前（负年份）」口径）   // v1.164：末位为 v1.163 默认文本（新增「已去世」开关与「出生日期不得晚于剧情日期」规则）
    memories: ['1afd958-935', '66e90544-779', '3abb2e78-731', '29675321-948', 'd4d5a225-927'],   // v1.165：末位为改版前默认（补「关联」契约）
    items: ['e501a834-1275', 'cbd1f618-832', 'dcabb80-718', '56c4ec06-641', 'fd5403c-1694'],
    plans: ['581307f0-2153', '3d2e83c0-1244', 'a9a3b6d4-1074', 'f5f38d07-2167', 'cdd5f837-2145', 'f158c858-2604'],   // v1.166：末位为 v1.165 默认（补「阶段 / 状态备注」）
    npcs: ['fbf4e928-568', '20810327-173', 'b82514f6-393', '77c892c8-581'],
    scenes: ['5019821f-744', '82a5971c-671', '1de91640-602', 'd2129918-1277'],
    concepts: ['858705b0-883', '189f5eb-941', '2a64da68-682', '39910a83-896'],
    vars: ['28f9c978-439', 'e97c6bf8-126', '44ae84d8-289', '68a8e368-439'],
    parallels: ['407db468-1534', '5b48d578-1502', 'bbcc1e74-1357', 'bec1b746-1548', '60eac488-1526'],   // v1.165：末位为改版前默认（补来源/预演契约）
    keywordExtract: ['327cfd0f-136', '82cbdbc0-136', '58c5dc90-136', 'ffe04b7-136'],
    memorySend: ['984750f0-179', 'ca6f85a8-165', 'b748f0ae-179', '6cce7f3c-179', '1ecb1003-171', '990ee78e-254'],   // v1.175：末位为改版前默认（补「情节按时间从早到晚」要求）
    injectGuide: ['450a24e8-256', 'cc355fe8-256', '32699d8e-256', 'f38ed9e8-620', 'df4e3770-1580', '8440850-1572', '429079e8-2795', '40515a08-2964', '836b4216-3178'],   // v1.192：末位为改版前默认（补 [传言] 区块定义与传播纪律）
    repair: ['c731651b-850', 'e4d36e28-850', 'c5fef078-782', '4a1d9270-759', '29afb69e-804'],
    sceneRepair: ['9c570b46-388', '2a8058de-385', '8901eccc-399', 'd5e0f038-385', 'adafd230-385'],
    conceptRepair: ['845c39e4-480', 'f7b5408-480', '11580d18-536', '79350028-480', '3a53be20-832'],
    memoryRepair: ['59eb26b0-450', '30d4add8-450', '6e82de60-617', 'b9f82fb0-450', 'b886ea6e-741'],
    itemRepair: ['4f496f8-498', 'c912a618-498', '7a685680-667', '6464f6f6-498', '65411bea-826'],
    characterRepair: ['ce7cf2f0-585', '2c8fe3c2-585', '4460d67e-581', '77115f9a-585', 'cad69178-518', '21027420-911', 'c6f5ede-973', '90f80586-965', '66205eb2-1245', '3daf64ca-1575'],   // v1.193：末位为改版前默认（补「公元前（负年份）」出生日期口径）   // v1.177：末位为改版前默认（v1.164 版；本版改为「一次性补齐 + 相关原子数据依据 + 标签必给 + 自检」）
    planSuspRepair: ['777355ca-572', '6cd768f6-572', '17617e88-643', 'bc62f118-572', '20d5a242-830'],
    statesRepair: ['7067e508-620'],   // v1.158 新增：此前无默认文本（缺失时自动补默认，用户改过后保留）
    // v1.181：货币两条模板为**新增键**（此前无默认文本）—— 空数组 = 「无历史默认」，与 statesRepair 同口径
    currencies: [],
    currenciesDynamic: [],
    // v1.182：情节分段总结为**新增键**（此前无默认文本）
    plotSegment: [],
    // v1.183：货币「标定跟踪」为**新增键**（此前无默认文本）
    currenciesTracked: [],
    // v1.184：时钟正则生成为**新增键**（此前无默认文本）
    // v1.185：日期时间修复为**新增键**（此前无默认文本）
    clockRepair: [],
    // v1.192：传言为**新增键**（此前无默认文本）
    rumors: [],
    // v1.195：内容弱化（NSFW）为**新增键**（此前无默认文本）
    nsfwSoften: [],
    // 注：v3.19.0 的 `nsfwAnalyze`（NSFW 词条分析）是 **V2 专用模板**（V1 无此键）→ 本表是 V1 旧默认签名镜像，
    //   不给它留空数组，保持「表内键集 = V1 键集」的可比对性（缺失键在迁移里天然视为「无历史默认」）。
};

const ARMOR_PRESET_V1178_DEFAULT = [
    '【提取记忆预设】你是剧情事件摘要器：只依据原文逐条提炼事件 / 状态 / 记忆，不补充原文没有的现实信息，',
    '不因题材而省略或改写事实，保留专有名词、数量与时间；输出结构严格按下方系统提示的 JSON 契约，不要自行改变格式。',
].join('\n');

const defaultCfg = {
    enabled: true,
    autoExtract: true,
    // 界面形态（用户要求：对齐 V1 的**弹窗**主界面；抽屉卡片默认不再显示，需要时可打开）
    uiShowDrawer: false,          // 是否同时在扩展设置抽屉里渲染面板卡片（默认否 = 只用弹窗）
    uiShowFloating: true,         // 扩展菜单入口不可用时，是否在右下角显示悬浮「FTT」按钮
    uiFirstTab: 'overview',       // 弹窗默认打开的分页（overview | console | extract | settings）
    // v1.134：同步流量保护总开关（**顶层键**，与 V1 同名同位置）—— 关闭后自动同步不再做
    //   「楼层哈希差异门控」与「镜像推送签名门控」，回到「每轮全量读 + 写」的旧行为。
    syncTrafficGuard: true,
    autoSummary: false,
    // v1.96：及时分析（实时模式）—— 开启后发送前分析未摘要楼层(含最新楼)、强制 自动摘取/AI摘要/注入、
    //   分析与提取总基于最新楼层、最新楼层改动自动回滚重分析
    timelyAnalysis: false,
    autoRepair: false,
    parallelWeaveEnabled: true,  // v1.58：提取记忆后自动调度「交织管线」推演/更新平行事件
    parallelApiPreset: '',        // v1.92：平行事件（推演/推进）分析渠道预设；留空 = 主渠道
    maxParallels: 200,            // v1.59：平行事件上限（默认 30，超出自动挤出最旧；设定可调）
    parallelDecayEnabled: true,  // v1.60/1.61：平行事件衰退机制（多级时间衰退，年月日时综合；条目数超上限×比例触发清扫，衰退值达阈值自动移除）
    parallelDecayRatio: 0.5,     // 触发比例：条目数 > 上限×该比例 时触发衰退清扫
    parallelDecayCutoff: 0.95,    // v1.145：0.9→0.95（调低清扫强度，更难被清）
    parallelWeaveInterval: 10,   // v1.69：推演事件被动触发楼层间隔（默认每 10 楼自动推演 1 次；手动按钮不受限）
    stateDecayEnabled: true,     // v1.62：状态记录（角色状态）衰退 —— 只按剧情日期老化（无剧情时钟不衰退）
    stateDecayRatio: 0.5,        // 触发比例：状态条数 > 上限(maxStates)×该比例 时触发衰退清扫
    stateDecayCutoff: 0.95,       // v1.145：0.9→0.95（调低清扫强度，更难被清）
    stateDecaySubjectYears: 0,   // v1.145：默认 0 = 不生效（原 2：长期未现角色整组删除过于猛烈，改由用户按需开启）
    //                            超过该年数 → 整组删除该角色状态（角色久未登场其状态一并失效；0/空=不启用角色级清扫）
    stateDecayStaleYears: 6,     // v1.145：单条状态「绝对久远度」达阈值年限（原 3 年 → 6 年；调低清扫速度）
    memoryForgetEnabled: true,   // v1.63：记忆遗忘机制（本质=衰退）—— 只按剧情日期；importance ≥ 总体均值免疫，低于均值按缺口加速遗忘
    memoryForgetRatio: 0.5,      // 触发比例：记忆条数 > 存储上限(150)×该比例 时触发统一遗忘清扫
    memoryForgetCutoff: 0.95,     // v1.145：0.9→0.95（调低清扫强度，更难被清）
    atomCompactEnabled: true,    // v1.67：早期情节半自动总结（走提取记忆 AI 管道；体量达标触发）
    atomCompactChars: 30000,     // 触发体量阈值：全部原子正文合计字符 ≥ 该值触发检查
    atomCompactTarget: 0.3,      // 聚合目标：参与运作（未隐藏）的情节数 ≤ 当前 ×该比例（默认 30%）
    atomCompactRecent: 20,       // 保护窗口：最近 N 条情节（楼层/日期最新）不参与聚合
    atomCompactRatio: 0.6,       // 可融合占比门槛：低于该值（默认 60%）日期粒度降级月份→年份
    atomCompactBatch: 40,        // 单轮批次数上限（防单次 API 调用过多）
    injectCurrentPrompt: true,
    charBudget: 8000,
    // v2.76.0（用户要求）：「各大类支持的默认词条数量限制提高，整体控制在 2000-3000 原子数量支持即可，
    //   用户可自行修改现有设定来提升。」→ 注入条数上限整体上调（合计 2980，落在 2000-3000）：
    //   **条数只是候选上限**，真正决定注入体大小的是 `charBudget`（默认 8000 字）—— 条数放宽后
    //   由预算按优先级择优填充，大库不再被「16 条情节」这类小上限截住。
    maxAtoms: 800,
    // v1.175：情节注入的两段配额比例（近期档 = 只按剧情时间取最新，不受关键词门槛限制；其余走机制档）
    //   0 = 关闭近期档（全部按原机制；仍保证输出按时间从早到晚）；1 = 只取最新（机制档让位）
    atomsRecentRatio: 0.4,
    maxMemories: 400,
    // v1.40：各注入维度独立条数上限（预算内轮询均等分布，单条超预算则整条跳过不截断）
    maxStates: 400,
    // v1.101：状态固定模板 —— 每角色 最少/最多 状态条数（超出自动裁掉最旧；最少为提示词要求，不自动生成）
    stateMinPerSubject: 1,
    stateMaxPerSubject: 10,
    maxSnapshots: 200,
    maxItems: 200,
    maxPlans: 120,
    maxSuspense: 120,
    maxScenes: 200,
    maxConcepts: 200,
    maxNpcs: 80,                  // v1.143：名册条数上限（此前无名册上限，靠提示词约束）
    // v1.147：**存储保底/上限**（与上面「注入条数上限」区分）—— 防止清理/情节总结/遗忘把库存打到过低：
    //   保底 = 任何自动清理都不得跌破；上限 = 常规裁剪到该值（上限取 max(上限, 保底)）
    // v2.84.0（用户要求）：「存储上限」改为**总上限 + 各大类占比** ——
    //   · `storeTotalMax`：**所有原子数据的合计上限**（默认 3000 条），不再逐维填绝对条数；
    //   · `storeShare`：各大类占该总上限的**百分比**（整数、合计恒为 100，由 UI 滚动条动态维持）；
    //     某维有效上限 = 四舍五入(总上限 × 占比 / 100)，且不低于该维保底（`storeMin*`）。
    //   · 旧的逐维 `storeMax*` 键**保留兼容**（仅在 `storeTotalMax` 缺失时作为回落口径），设定页不再暴露。
    storeTotalMax: 3000,             // 所有原子数据合计上限（条）
    storeShare: { atoms: 23, memories: 15, snapshots: 8, items: 9, concepts: 13, scenes: 4, maps: 4, plans: 6, suspense: 6, npcs: 6, rumors: 6 },   // v3.47.3（W18 数-22）：`maps` 占比从 `scenes` 拆 4 点，合计仍恒为 100
    storeMinAtoms: 100, storeMaxAtoms: 1200,          // 情节：保底 100（上限见 storeTotalMax × storeShare.atoms）
    storeMinMemories: 200, storeMaxMemories: 800,    // 记忆：保底 200
    storeMinSnapshots: 100, storeMaxSnapshots: 400,  // 角色档案：保底 100
    storeMinItems: 150, storeMaxItems: 500,          // 物品：保底 150
    storeMinConcepts: 200, storeMaxConcepts: 700,    // 概念：保底 200
    storeMinScenes: 0, storeMaxScenes: 400,          // 场景（无硬保底）
    storeMinMaps: 0, storeMaxMaps: 400, mapTrailPhrase: '前往{path}',   // v3.47.3（W18 数-22/应-21）：地图（无硬保底，与场景同口径）+ 「前往」套话模板（{place}/{room}/{path}；设定 → 基础 → 地图套话 可改）
    storeMinPlans: 0, storeMaxPlans: 300,            // 计划
    storeMinSuspense: 0, storeMaxSuspense: 300,      // 悬念
    storeMinNpcs: 0, storeMaxNpcs: 300,              // 名册
    maxParallelsInj: 100,          // v1.66：平行事件注入上限 —— 标题+描述按关键词触发并入提取记忆（平行事件总上限仍 maxParallels）
    // ==================== v1.181：货币大类（当前主角持有的货币；多主角支持） ====================
    // 用户要求：① 记录当前主角持有的货币；多主角支持，涉及其他角色**必须人工/正文明确指定**，否则默认只记主角；
    //   ② 支持币种（贝壳 / 银元 / 美元 / 信用点…）；③ 额度为**数字**，显示时按 万/亿/兆/京 动态适配；
    //   ④ 归属默认只是主角名，明确指定其他角色时记该角色（提示词随发现的角色动态变化）；
    //   ⑤ 提示词两条：`currencies`（通用记录，默认）与 `currenciesDynamic`（按发现的角色动态识别）；
    //   ⑥ 条目内支持**收支记录**（history：收入/支出 + 结余）；⑦ 记录/注入开关默认开启。
    currencyEnabled: true,           // 记录 + 注入总开关（默认开；关 = 不抽取该维度、也不注入 [货币] 区块）
    currencyDynamicEnabled: true,    // 动态提示词：按本轮正文**发现的其他角色**追加识别说明（默认开）
    maxCurrencies: 100,                // 注入条数上限
    storeMinCurrencies: 0, storeMaxCurrencies: 400,   // 条数上限（无硬保底）
    // ==================== v1.195：NSFW 弱化（分析侧开关 + 总览手动处理，共用同一套核心） ====================
    // 用户要求：「新增功能用于弱化 NSFW 的内容，如果发现有相关内容，用更柔性的话术替代，不露骨」；
    //   「① 设定中开启，默认关闭；开启后分析记忆加入提示词，避免数据出现 NSFW 露骨内容」；
    //   「② 总览修复按钮右侧新增按钮（弱化 NSFW），点击后按关键词找潜在需处理的原子数据，交 AI 弱化」。
    // 语义：**默认关**（不改变任何人的既有行为）；开关只管「分析记忆提示词侧」，
    //   提示词模板 `nsfwSoften` 是两边共用的核心（手动按钮把它 + 待弱化清单一起投喂）。
    nsfwSoftenEnabled: false,        // 分析记忆时追加「内容弱化（NSFW）」规则（默认关）
    // v1.197：NSFW 识别词条库（可在设定「内容弱化」页增删改）——
    //   留空 = 使用内置标准词条（module09 的 NSFW_KEYWORDS）；一旦在页面增删改，
    //   会把内置列表**物化**成这里的自定义列表（首次编辑自动种子化），「恢复内置默认」则清空回内置。
    nsfwKeywords: [],
    // v1.198：NSFW **固定规则替换**（零 AI 的机械转化）——
    //   用户要求：「支持固定规则替换方法，可在设定中单击按钮触发，通过固定规则库识别并转化原子数据的匹配词汇」；
    //   「匹配转化的内容同样在设定中展示和管理，内置一套标准转化库，默认词条与上一版新增的匹配词一致」；
    //   「固定规则转化有自动开关，**默认开启**：开启时在交给 AI 弱化之前先跑一次固定规则，再交 AI 处置第二次」。
    //   `nsfwRules` 留空 = 用内置标准转化库（module09 的 NSFW_RULES，键 = NSFW_KEYWORDS 那 63 条）；
    //   一旦在页面增删改即物化为自定义列表，「恢复内置默认」清空回内置。
    nsfwReplaceAuto: true,           // AI 弱化前先跑固定规则（默认开）
    nsfwRules: [],
    // ==================== v1.182：情节分段总结（情节页「🧩 分段总结」子标签） ====================
    // 用户要求：「情节中新增子标签，用于生成情节分段总结，将情节打包给 AI，分解为多段总结结构」；
    //   「该部分内容无法被 AI 读取，所以无需注入提示词或其他处理，主要将情节分段整理后保存，
    //    **除非手动删除对应段落**」；「以三个井的 markdown 为头，表明发生的时间范围」；
    //   「区分段落采用**情节分拆**为准，避免混淆在一起」；「手动点击总结、查看、编辑或删除条目」。
    // 语义：只增不减（AI 不覆盖同时间范围的已有段落、也不删除任何段落；唯一消失途径 = 手动删除）。
    plotSegmentBatchAtoms: 30,       // 单次打包给 AI 的情节条数（按剧情时间从早到晚切批）
    // v3.49.3（用户报告「情节的自动分段统计存在设计缺陷，会提交巨量数据」）：**体量上界**与**一次一批**
    plotSegmentMaxChars: 8000,       // 每批提交的**字符预算**（500-60000；0 = 不限）——与条数**取先到者**
    plotSegmentMaxBatches: 1,        // **一次点击最多提交几批**（1-40；默认 1 = 只交一批，余下可再点继续）
    // v3.50.4（用户要求「必须保留至少 10 条最近的情节，这个强制兜底」）：**最新 N 条永不进分段总结**
    //   （口径与「情节总结（半自动）」的 `atomCompactRecent` 同源，但**强制下限 10**；设 0 也会被兜到 10）
    plotSegmentReserveRecent: 10,    // 保留最近的情节条数（**至少 10**；10-200）
    plotSegmentProtectManual: true,  // 同一「时间范围」段落已存在时不覆盖（保护手动编辑）
    plotSegmentTextLimit: 400,       // 单条剧情线概述的字数上限（入库硬截断）
    plotSegmentIncremental: true,    // 只整理「尚未被现有段落覆盖」的情节批次（**v3.49.3 起默认开**：全量重跑会把整库反复提交；删段后该批自动重新可见 → 增量不会丢内容）
    // ==================== v1.183：货币「指定角色」标定（跟踪其他角色的货币） ====================
    // 用户要求：「货币需新增指定角色的按钮，可指定角色大类中已知角色作为新的标定」；
    //   「被标定后，后续分析记忆应同时考虑对应角色货币情况」。
    // 语义：标定名单 = 用户在「货币」页用「👥 指定角色」按钮从**角色大类（角色档案）**里挑出的角色名；
    //   ① 提示词：这些角色**恒定**追加「货币 · 标定跟踪」段（即使本轮正文没写到他们），
    //     并把「当前货币账本」（主角 + 标定角色）作为**更新参照**投喂，让 AI 结合现状判断是否变化；
    //   ② 注入：标定角色的货币与主角同样**恒定注入**（不再要求关键词/在场命中）；
    //   ③ 名单随配置跨端同步；空数组 = 行为与 v1.182 完全一致。
    currencyTrackedRoles: [],
    // ==================== v1.192：传言大类（与其他分析记忆一起抽取 · 内置传导链路与裂变 · 与平行世界联动） ====================
    // 用户要求：「新增大类，传言。该模块与其他分析记忆一起处理，主要捕捉正文可能存在的一些客观、主观传言。」
    //   「传言内置传导链路，相同的传言可能会发生裂变、变化。」「与平行世界联动，如果标签高度关联的，
    //    有一定概率联动，从而推动传言发酵、消退，或推动平行世界发生新的变化。」
    //   「平行时间发生变化后，每隔 N 轮触发传言变化。该设定默认为 5，在设定可改。」
    //   「传言的传导链路应被完整记录，如果分裂则记录关联信息，分裂为新的传言。」
    //   「传言无论如何裂变，都只有一个主体，该主体会变化。」「传言的变化不可能立刻发生，会有变化过程。」
    //   「传言需记录关联角色，以及客观事物（传媒、报刊、大字报、书、刻字等等），会随着剧情时间变化而发酵或衰退。」
    //   「传言衰退机制复用当前衰退机制，在设定中补充传言的衰退约定设置。」
    // 语义：① 抽取 = 与其他维度同一次 AI 摘要（模板 `rumors`）；② 演化 = **纯机械、零 AI**
    //   （阶段 / 发酵度 / 载体老化 / 裂变，全部记入 `chain` 传导链路）；③ 变化有过程（`pending` 需满 N 轮才提交）；
    //   ④ 与平行事件按**标签关联度**联动（发酵 / 消退 / 推动平行事件变化）；⑤ 衰退复用 `calcTimeDecay` 通用机制。
    rumorEnabled: true,               // 记录 + 演化 + 注入总开关（默认开；关 = 不抽取该维度、不演化、不注入 [传言] 区块）
    rumorChangeEveryRounds: 5,        // 每隔 N 楼轮次触发一次传言变化（默认 5；平行世界发生变化后重新计数）
    rumorChangeNeedRounds: 2,         // 单次「变化过程」需要推进的轮次数（默认 2 —— 变化不会立刻生效）
    rumorFissionFerment: 80,          // 触发「裂变」所需的最低发酵度（0-100，默认 80）
    // v3.46.6（用户报告「立即演化可以连续点击、发酵度连续递减」）：**发酵度增减的剧情节奏窗口**（单位 = 剧情天）。
    //   口径：发酵度的增减**只在剧情时间推进时才施加**，且按「距上次变化经过的剧情天数 ÷ 本窗口」**归一化**
    //   —— 同一剧情节奏内反复点「立即演化」不再重复扣/涨热度（详见 `docs/D18` 实施规格 `业-7` 与批次档 `P10c97`）。
    //   默认 1 天（= 一个剧情节奏）；数值越小越敏感（0.25 = 每 6 小时可施加一次）。
    rumorFermentWindowDays: 1,
    rumorFissionChance: 0.3,          // 每次演化的裂变概率（0-1，默认 0.3；0 = 不裂变）
    rumorParallelLinkSim: 0.34,       // 与平行事件「标签高度关联」的判定阈值（标签 Jaccard，默认 0.34）
    rumorParallelLinkChance: 0.35,    // 标签高度关联时的联动概率（0-1，默认 0.35）
    rumorMediaLifeDays: 30,           // 传播载体基础寿命（剧情天数；实际 = 本值 × 载体耐久度）
    rumorDecayEnabled: true,          // 传言衰退（复用通用多级时间衰退，与平行事件同款）
    rumorDecayRatio: 0.5,             // 触发比例：条数 > 存储上限 × 该比例时触发衰退清扫
    rumorDecayCutoff: 0.95,           // 移除阈值：衰退值 ≥ 该值自动移除（留墓碑）
    maxRumors: 60,                     // 注入条数上限
    storeMinRumors: 0, storeMaxRumors: 300,   // 存储保底/上限（保底 0 = 无硬保底）
    // ==================== v1.184：剧情时钟增强（公元兼容 / AI 捕捉正则 / 降级方案 / 时间巡检） ====================
    // 用户要求：① 日期/时间/地点识别兼容「公元XX年」「公元X年」「公元XX年X月X日」等结构；
    //   ② 设定中增加「AI 捕捉正文日期·时间·地点 → 形成正则」的按钮；
    //   ③ 若捕捉的日期**异常** → 自动降级采用「最新情节的日期与时间」+「最新的场景」；
    //   ④ 设定增加「强制使用降级处理方案」开关（开启则强制降级，否则走默认自动提取）；
    //   ⑤ 总览自动修复：巡检时间异常并自动修复错误的原子数据日期/时间。
    // v1.187：巡检**自动修复**开关（默认关）——用户反馈「时间巡检修复把情节日期全搞坏了」：
    //   载入即静默改写日期风险过高（锚点错时会把整库年份改错），故默认**只统计不修改**；
    //   需要自动修复的用户可在设定里显式开启（锚点仍必须可信）。
    //   按「纪元首日 + (N-1) 天」换算日期；留空（默认）= 只记录天数、不换算。
    // v1.185：AI 结合正文修复日期时间（**独立修复**，只在设定里点按钮时执行；与上面的零 AI 巡检互不干扰）
    //   用户要求：「设定增加按钮，用于修复原子数据异常的日期时间，结合正文修复。该设计独立修复使用。」
    clockRepairBatch: 20,            // 单次提交给 AI 的异常条目上限（按维度顺序取前 N 条）
    // v1.186：手工强制改写剧情日期/时间/地点（**锚点可修**）
    //   用户要求：「锚点日期错了，但没有修复手段。请加入手工强制改写日期和时间、地点的方法。」
    //   语义：在总览点「✏️ 手工改写」录入后写入 `state.state.clockManual = {date,time,location,at}`；
    //   `clockManualLock`（默认 true）= **锁定**：自动提取（正则/降级）不再覆盖这三项，直到用户「🔓 解锁」；
    //   关 = 只写一次，之后仍可被自动提取覆盖。
    clockManualLock: true,
    keywordFilterByContext: true,
    // ==================== v1.179：分析记忆前置提示词（v1.178「破甲预设」重设计） ====================
    // 用户要求：「破甲预设放错地方了，这个是用于**分析记忆**用的，请放入**提示词面板**」；
    //   「就是**提取正文然后分析**的前置提示词」。
    // 位置：正文已作为**提示词模板** `promptTemplates.armorPreset`（提示词面板「⓪ 分析记忆前置提示词」组）；
    //   本键只保留**总开关**（默认开）—— 模板留空会在下次载入时被默认值补齐，故关闭请用本开关。
    armorPresetEnabled: true,
    // v2.35.0 起的三通道：'' = 未显式选择（按旧数据迁移推断：地址+模型齐备 → direct，否则 host）
    apiChannel: '',
    apiProfileId: '',
    apiType: 'custom',
    apiUrl: '',
    apiKey: '',
    model: '',
    proxyPreset: '',
    // v1.22：OpenAI 兼容参数（留空采用默认：temperature=0.2、max_tokens=不设、top_p=1）
    apiTemperature: 0.2,
    apiMaxTokens: '',
    apiTopP: '',
    // v1.19：三层**召回**结构（发送前；v3.45.0 正名，见 `docs/D22` W5 `技-20`）—— 第一层向量检索(useVector) / 第二层浏览器JS抽取(jsExtractEnabled) / 第三层AI分析(**useKeywordFlow**)
//   注：`memApiEnabled`/`memApi` 是第三层走哪条**API 通道**的配置，不是该层的开关（两个轴，别混）。
    useVector: false,
    jsExtractEnabled: true,
    embeddingUrl: '',
    embeddingKey: '',
    embeddingModel: '',
    embeddingProxyPreset: '',
    rerankUrl: '',
    rerankKey: '',
    rerankModel: '',
    rerankProxyPreset: '',
    vectorTopN: 5,
    vectorMinScore: 0.35,
    vectorWeight: 0.4,
    vectorTimeoutMs: 15000,
    summaryFloors: 30,
    // v1.32：分段读取楼层数（每次分析不是全量，分段排队处理）
    // v3.23.0（用户要求「全部AI摘要需支持分段处理，且默认采用 **3 个正文**进行切片，分批进行处理。
    //   避免一次性分析记忆。」）：默认值 **10 → 3**，并成为**全部摘要入口**（批量摘要 / 多楼·全量提取 /
    //   推演世界）的**统一段长上界**（唯一事实源 = `core/chunk.js#SUMMARY_CHUNK_DEFAULT`）。
    summaryChunkSize: SUMMARY_CHUNK_DEFAULT,
    // v3.44.0（`docs/D22` W4 `数-11` ①）：**关联锚点强制补丁**开关（默认**关**）。
    //   开启时把 `promptTemplates.relAnchorRule` 追加到「AI 摘要」提示词（与既有的 NSFW 弱化规则同一形态）。
    //   默认关的理由：那段文本会改变**最高频路径**的提示词，而 V2 的该提示词与 V1 **逐字符一致**
    //   （`tests/fixtures/v1-golden-prompt.json` 锁死）—— 默认关 = 默认输出与 V1 逐字节相同。
    relAnchorRuleEnabled: false,
    // v3.44.0（`docs/D22` W4 `数-13` ①）：**空壳条目入库拦截**开关（默认**关**）。
    //   开启后 `core/shell-guard.js` 会在写入路径丢掉「完全不承载信息」的新增条目并计数（面板提示 + 调试日志）。
    //   默认关的理由是**实测出来的，不是保守**：V1 黄金样本 `v1-golden-ingest.json` 里有一条悬念
    //   `{"content":"木箱断口之谜：来源不明"}`（11 字、无其它字段）—— V1 **接受**它；按「正文 + 标识 < 12 字
    //   且无其它有值字段」的判据会被拦下，于是 `ingest-golden` M1/M2（与 V1 逐字一致）当场变红。
    //   V1 已接受的入库结果属**移植契约**，不能被一个新守卫单方面改掉 → 默认关。
    //   `数-13` 的默认可见价值由 **② 体检**（`entry-shell`）与 **③ 筛选视图**（列表页「🫥 空壳」）承担 —— 两者零行为变更。
    shellGuardEnabled: false,
    // v2.86.0（`docs/D7`）：重要度改为「窗口调用占比」（每次提取后重算最近 N 条；逐维独立、状态按主体分组）
    impRecalcEnabled: true,      // 是否启用重要度重算（关闭则保留历史值）
    impWindowRadius: 10,         // 窗口半径（前后各 R 条，含自身 → 窗口 2R+1 条）
    impRecalcCount: 20,          // 每次重算「最近 N 条」（第 N 条同样按真实 ±R 邻居算；更旧的冻结）
    importanceBase: 0.12,
    importancePerUse: 0.06,
    feedFloors: 2,
    repairFloors: 10,
    // v1.50：自动修复（提取记忆分支线）—— 失败自动触发与次数上限
    autoRepairOnMergeFail: true,   // 提取记忆合并失败（JSON 错误/结构错乱等）时延迟自动修复一次
    repairFailDelaySec: 15,        // 上述延迟秒数
    maxAutoRepairRounds: 3,        // 最新楼层哈希未变动时，自动修复至多重复次数（可设）
    autoRepairEveryOps: 8,       // v1.90：自动修复频率闸门 —— 每 N 次 提取记忆/摘要 后最多自动修复 1 次（0=不限制，恢复旧行为）
    // v1.137：自动修复重设计（三段式：JS 机械清理 → 候选筛选 → 窄契约 AI 措辞修订）
    repairMaxItems: 20,
    // v3.50.19（`docs/D22` W12 `技-49` / `数-37`）：修复聚合的预算（`docs/D33` §6 Q8 默认值）
    sceneRepairMaxItems: 12,          // 场景域候选封顶（聚合路径只提交前 N 个场景节点）
    repairAggEnabled: true,           // 聚合总开关（关 → 回退各域单发）
    repairAggMaxItems: 80,            // 每域候选上限
    repairAggMaxChars: 12000,          // 聚合提示词总字数上限
    repairAggMaxDomains: 9,            // 参与域上限（9 = 全部）
    constraintCheckEnabled: true,      // v3.50.22（`业-2`）：约束机械校验（体检 finding + 入库前剔除幻觉依据）          // 每次最多交给 AI 的候选条目数（1-60；机械清理不受此限制）
    repairAutoAi: true,          // 自动触发时是否使用 AI 措辞修订（false = 自动修复只做 JS 机械清理，零 AI、秒级）
    // v1.138：候选筛选策略 —— 同维度标签组相关性 + 按比例随机抽查（轮询覆盖）
    repairTagSimHigh: 0.5,       // 相关性「过高」阈值：≥ 该值 → 优先列入核对（重点查是否重复）
    repairTagSimLow: 0.15,       // 相关性「过低」阈值：≤ 该值 → 不列入（同维度孤例，无重复风险）
    repairSampleRatio: 0.2,      // 每次抽查比例（占中间带条目数；0.05-1）—— 不做全量盘点
    repairMinCandidates: 5,      // 每轮候选下限：不足时按相关性从高到低补足（保证每轮都有足量数据可修）
    // v3.46.1（`docs/D22` W11 数-35 / `docs/D32` §3.4 + §3.3 + Q2）：**三域联动（🔗 联动构建）**的五个键。
    //   口径：本功能**不读楼层**（不调 aiFeedText）、**不新增/不删除条目**、只建关联 + 推进受限字段（`docs/D32` §3.8）。
    triLinkEnabled: true,        // 总开关（false = 两个入口按钮隐藏 + 程序化调用返回 `disabled`）
    triLinkStateAdvance: true,   // 是否允许 AI 改受限状态字段（false = 只建关联 + 留痕；Q2 的退档开关）
    triLinkMaxItems: 60,         // 每域打包条数上限（1-200）
    triLinkPackMaxChars: 20000,  // 打包总字数上限（1000-80000；超限按"视野优先级"从段①末尾截断并如实计数）
    triLinkMaxOps: 40,           // 单轮应用的动作数上限（1-120；超出即拒收该条）
    // v3.46.2（`docs/D22` §4.14 W13 `应-30`，用户直接要求）：**货币融合（🔀 AI 语义合并）**的三个键。
    //   口径：指定一个角色的全部货币交给 AI 整理 —— 只做「语义同义的合并」，不读楼层、不跨角色、不凭空换算。
    currencyMergeEnabled: true,     // 总开关（false = 货币页按钮隐藏 + 程序化调用返回 `disabled`）
    currencyMergeMaxItems: 120,     // 单次打包条数上限（1-400；超出按名字序截断并如实计数）
    currencyMergeSumAmount: true,   // 额度策略：**默认 true = 合并时求和**（用户裁决 v3.46.2）；false = 保留最新额度、不累加（与机械修正同口径）
    // v3.45.3（用户要求「各大类现有修复功能，每次限定可能抽取 3 个数据，改为默认抽取 6 个。且该约定可在设定中设置修改」）：
    //   下面 6 个「每轮抽取量」默认由 **3 → 6**（`repairCharacterBatch` / `stateRepairBatch` 与四域的
    //   `*RepairMaxClusters`）；**改的是默认值，不是上限** —— 六个键在设定页都能改（角色修复 / 遗忘·修复状态 /
    //   各域相关组修复），且各处的读取兜底同步为 6（`core/character-repair.js` / `core/state-repair.js` / `core/group-repair.js`）。
    //   **未动**：`maxAutoRepairRounds`（同楼层自动修复**轮次**上限，不是抽取量）与 `repairMaxItems`（候选池 20 条）。
    // v1.139：概念修复（概念页专用）—— 标签组聚类 → 高相关一组提交 AI 梳理合并
    conceptRepairSim: 0.45,      // 概念「同一概念」相关性阈值（标签 Jaccard / 名称+内容相似度 ≥ 该值即连成一组）
    conceptRepairMaxClusters: 6, // 每次最多核对的相关组数（轮询推进，多轮覆盖全部组；v3.45.3 默认 3→6）
    conceptRepairMaxItems: 24,   // 每次最多提交给 AI 的概念条数（跨组合计上限）
    conceptRepairMaxClusterSize: 8, // 相关组规模上限（2-40）—— 防止「链式传递」把互不相关的条目串成一大团
    // v1.140：记忆修复（记忆页专用）—— 同一策略（标签组聚类 → 打包高相关组交 AI 梳理/合并/修正）
    memoryRepairSim: 0.45,          // 记忆「同一件事」相关性阈值（标签 Jaccard / 标题+正文相似度 ≥ 该值即连成一组；同归属内判定）
    memoryRepairMaxClusters: 6,     // 每次最多核对的记忆组数（轮询推进，多轮覆盖全部组；v3.45.3 默认 3→6）
    memoryRepairMaxItems: 24,       // 每次最多提交给 AI 的记忆条数（跨组合计上限）
    memoryRepairMaxClusterSize: 8,  // 记忆相关组规模上限（2-40，防链式串联）
    // v1.140：悬念修复（计划悬念页专用）—— 同一策略（计划保持原样，仅悬念改打包核对）
    suspenseRepairSim: 0.45,        // 悬念「同一悬念」相关性阈值（标签 Jaccard / 标题+内容相似度）
    suspenseRepairMaxClusters: 6,   // 每次最多核对的悬念组数（轮询推进；v3.45.3 默认 3→6）
    suspenseRepairMaxItems: 24,     // 每次最多提交给 AI 的悬念条数（跨组合计上限）
    suspenseRepairMaxClusterSize: 8,// 悬念相关组规模上限（2-40，防链式串联）
    // v1.143：通用「低使用长期未现」遗忘清扫 —— 补齐概念/场景/名册/计划/悬念/角色档案的遗忘机制
    lowUseForgetEnabled: true,      // 总开关（修复流程内执行：零 AI、确定性）
    lowUseForgetRatio: 0.05,        // v1.153：0.1→0.05（只清调用 ≤ 平均 5% 的极端低使用条目）
    lowUseForgetMinItems: 80,       // v1.153：40→80（库规模门槛再提高，中等库不被动清扫）
    lowUseForgetMinAvg: 5,          // v1.153：3→5（平均调用更高才启用）
    lowUseForgetMinFloors: 300,     // v1.153：0→300（**默认缓慢处理旧数据**：只动 ≥300 楼未再出现的极旧条目）
    lowUseForgetMaxDelete: 1,       // v1.153：3→1（每维度每轮最多清扫 1 条：缓慢滴灌）
    lowUseForgetEveryFloors: 40,    // v1.153：清扫间隔（楼层）—— 距上次清扫不足该值则整项跳过（0=不限制）
    lowUseForgetProtectImportance: 0.2, // v2.86.0：0.7→0.2 —— 重要度已改为「窗口调用占比」（均匀分布均值≈1/21≈4.8%），0.2≈4 倍平均，与旧「0.7 属高重要度」的筛除力度同量级（`docs/D7` §4.9 C1）
    // v1.142：物品修复（物品页专用）—— 标签/名称相关性聚类 → 打包交 AI 判断融合 + 低调用固定规则清理
    itemRepairSim: 0.45,            // 物品相关度阈值（相关度 = max(标签组 Jaccard, 名称相似度) ≥ 该值成组）
    itemRepairMaxClusters: 6,       // 每次最多核对的物品组数（轮询推进；v3.45.3 默认 3→6）
    itemRepairMaxItems: 24,         // 每次最多提交给 AI 的物品条数（跨组合计上限）
    itemRepairMaxClusterSize: 8,    // 物品相关组规模上限（2-40，防链式串联）
    itemLowUsesRatio: 0.05,         // v1.153：0.1→0.05（只清极端低使用的物品）
    itemLowUsesMinItems: 100,       // v1.153：50→100（门槛再提高）
    itemLowUsesMinAvg: 5,           // v1.153：3→5（平均调用更高才启用）
    itemLowUsesMinFloors: 200,      // v1.153：0→200（默认缓慢处理：只动 ≥200 楼未再出现的旧物品）
    itemLowUsesMaxDelete: 1,        // v1.153：3→1（每轮最多 1 件：缓慢滴灌）
    itemLowUsesEveryFloors: 40,     // v1.153：清扫间隔（楼层）—— 距上次清扫不足该值则跳过（0=不限制）
    ...CHARACTER_DEFAULTS,   // v3.49.1：角色修复族默认键（外移 `core/config-character.js`；含年龄高寿规则）
    ...RESUME_DEFAULTS,      // v3.49.1：履历默认键（外移 `core/config-resume.js`；键/值/顺序逐字不变）

    resumeBatchEnabled: true, resumeBatchDays: 30,                // 批量档总开关（false = 按钮隐藏 + 程序化调用返回 `disabled`）· 「近期」窗口天数（按剧情日期回看；1-3650） // v3.47.0（`docs/D22` §4.16 W16 `应-33`）：**履历批量完善**四键 —— 按「近期更新的记忆」抽角色 → 一批放进**一次** AI 请求（与个体档共用机械段与复核）
    resumeBatchMaxRoles: 8, resumeBatchMemoryPerRole: 6,          // 一次请求最多几个角色（1-30；超出按命中数降序截断并计数）· 每角色带入几条近期记忆（1-30）
    // v1.158：状态记录修复（状态页「🔧 修复状态」）—— 自动匹配角色 → 删无主状态组 → 机械清理/规范化 → 交 AI 整理
    stateRepairBatch: 6,             // 每轮交给 AI 的主体（角色）数（1-10；v3.45.3 默认 3→6）—— 目标收敛、质量优先
    stateRepairMatchSim: 0.72,       // 主体 ↔ 角色档案/名册 的名称相似度阈值（0.5-0.95）—— 低于该值视为「无档案主体」
    // ==================== v1.165：通用知情关联层 + 计划悬念结构化 + 固定注入约束（docs/11） ====================
    relLinkEnabled: true,            // 通用知情关联层总开关（记忆/计划/悬念/平行事件；关 = 退回 owner / characters 口径 = 现状行为）
    relLinkMax: 12,                  // 单条目关联行上限（含锚行）
    relLinkPresenceInfer: true,      // 记忆修复时按在场名单自动补「亲历」关联（note 标注「按在场名单推定」）
    planLinkDefaultScope: 'planner+join',              // 计划无关联时的保守回退口径：planner+join / planner / characters
    suspLinkDefaultScope: 'involved+investigating',    // 悬念无关联时的保守回退口径：involved+investigating / involved / characters
    relLinkToWorldbook: true,        // 世界书镜像是否附关联摘要行（记忆/计划/悬念/平行事件四类）
    relOrphanAction: 'keep',         // 孤儿关联/孤儿条目处置：keep（保留并提示）/ clean（自动清理）/ public（转公开）
    planStructEnabled: true,         // 计划/悬念/平行事件的结构化扩展总开关（关 = 不写新字段、不迁移）
    planHistoryMax: 30,              // 计划/悬念 history 上限（超出按时间折叠为「早期 N 步」）
    planStepsMax: 20,                // 计划 steps 上限
    cluesMax: 20,                    // 悬念 clues（线索）上限
    planRefsMax: 12,                 // 各类引用字段（memRefs / sourceRefs / planRefs 等）上限
    parallelPromoteConfirm: true,    // 平行事件转正必须用户确认（默认必须：推演 ≠ 事实）
    injectConstraintBlock: true,     // 固定约束段（机械生成、与关键词召回解耦；见 docs/11 §5.5）
    injectConstraintMaxChars: 400,   // 约束段字符上限（超出按优先级截断 + 末尾总括句）
    injectConstraintPosition: 'tail',// 约束段位置：tail（末尾，推荐）/ head（开头）
    injectConstraintNameAll: false,  // 未被召回的非公共信息是否逐条点名标题（默认只给聚合计数）
    // v1.118：同步流量保护 —— 自动同步按「最新楼层哈希 vs 已归档记录」门控（无差异跳过、零网络）；
    //   内容未变化也不重复写回镜像；「立即同步」不受门控（保留全量同步）。false/0 = 关闭门控（旧行为）
    syncTrafficGuard: true,
    // v1.134：原 v1.119「刷新后自动全量同步一次」（bootFullSync/bootFullSyncDelaySec/
    //   bootFullSyncCooldownSec）已移除 —— 属静止状态定时同步（打开页面不做任何操作也会在 10s 后
    //   触发一次 22~35s 的全量大同步）。现在打开页面只做一次启动对账（storageBootstrap：清单命中时
    //   零大文件下载），其余全部由被动事件触发。
    // [v1.86] 剧情时钟自动提取（总览 日期/时间/地点 —— 多层：正则直取→标记式→时段词/24小时制→
    //          相对日期推进→AI 摘要层→原子数据最近信息兜底参考；默认正则优先，不纯依赖 AI）
    clockExtractEnabled: true,     // 自动从正文提取剧情时钟（消息/生成结束后）
    feedWorldbooks: [],
    feedWorldbookEntries: {},
    feedRegexWhitelist: [],
    feedRegexBlacklist: [],
    debugEnabled: true,
    // v2.42.0：交互/宿主/命令追踪（「调试日志」的分级与分类开关；V1 只有 debugEnabled）
    debugLevel: 'debug',          // error | warn | info | debug | trace
    debugTraceUi: true,           // 记录用户交互（点击/变更/切页/搜索）
    debugTraceHost: true,         // 记录插件↔宿主 API 调用
    debugTraceVerbose: false,     // true = 记录截断后的原始参数/返回（默认只记摘要与长度）
    apiPresets: {},
    activeApiPreset: '',
    dimensionGrouping: 'unified',
    dimensionEnabled: {},
    dimensionPresets: {},
    buttonLocations: { topbar: false, qr: true, float: false, menu: false },
    // v1.122：UI 设计统一 —— 界面特效开关（动画/过渡/脉冲；关闭即静态界面）
    uiEffects: true,
    // [v1.26] 存储架构：多后端并行存储 + 一致性校验
    storage: {
        localStorage: true,      // 本机缓冲·内部同步缓存（v1.83：仅缓冲，无 UI 开关；权威=存档变量）
        indexedDB: true,        // 本机缓冲（IndexedDB，v1.83：仅缓冲/常驻，无开关；权威=存档变量）
        chatVariable: true,     // 存档变量（TH 全局变量 fttMemoryState:<角色>）—— v1.83 起为**唯一跨端核心基准**（强制）
        // v3.16.0（用户要求）：「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，避免超出限制。
        //   但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式。」
        //   语义：**留空 = 不开启**（本机缓冲层照旧走 localStorage 变量）；非空 = 启用本地文件模式 ——
        //   本机缓冲改写/读**宿主的本地文件**（TauriTavern：扩展存储命名空间 → 真实目录
        //   `data_root/_tauritavern/extension-store/<路径>/…`；网页版酒馆：用户目录 `user/files/<路径>/…`），
        //   不再受 localStorage 配额限制（旧模式信封超过 1.8M 字符会**静默停更**）。
        //   路径只允许**宿主数据目录之内**：盘符 / 前导斜杠 / `..` 会被剥离，非法字符转 `_`。
        localFilePath: '',      // 本地文件目录（相对宿主数据目录；空 = 不开启）
        // v3.28.0（用户纠正设计）：「**本地磁盘目录**」= 一条**真磁盘路径**（如 `D:\FTT\store`），用来**替代
        //   浏览器本地存储**（localStorage 变量 + 内存库 IndexedDB），**不是**服务端存储路径 ——
        //   与上面的 `localFilePath`（宿主扩展存储命名空间，属**参与官方同步的服务端数据集**）语义完全不同。
        //   能不能真写盘取决于宿主是否提供文件 API；能力探测见 `adapters/local-disk.js`，拿不到就如实降级。
        localDiskDir: '',
        // v3.26.0（用户要求「增加选择目录，可手动选择目录」）：**用过的目录清单**（最近在前，上限 8 条）——
        //   目录选择器的候选来源之一。为什么放在配置里而不是 localStorage：本机缓冲改走本地目录后
        //   变量层**整体停用**（`localFilePath` 非空即不写 localStorage），候选清单不能反过来依赖它。
        localFileDirs: [],
        // [v1.83] 存储架构收敛：取消「文件夹存储」与「插入楼层」两种方式；
        //         本机(localStorage/IndexedDB)仅作缓冲回退；存档变量为所有存储的核心基准；
        //         世界书存储为可选单向灌输（下方开关）。
        verifyOnLoad: true,     // 载入时哈希校验
        syncOnSave: true,       // 保存时同步到权威(存档变量)与镜像
        // [v1.82] 跨端自动同步增强 —— v1.134 起为**纯被动触发**（无静止状态定时同步）
        crossPullOnActivity: true,   // 聊天活动（消息/切聊天/生成结束）后触发跨端拉取
        crossPullOnVisible: true,    // v1.134：页面回到可见时触发一次跨端拉取（false=关闭，唯一非消息入口）
        syncMetaProbe: true,         // v1.134：服务端「清单(meta)」预判 —— 对端未变化时跳过整份下载（省流量）
        // v1.134：原 crossSyncIntervalSec（周期心跳，默认 60s）已移除 —— 静止状态不再定时同步
        // v1.125：同步日志服务端化 —— 日志镜像到服务端用户目录
        //   （data/<用户>/user/files/ftt-log-<角色>.json），打开页面时拉取最新并与本机交叉合并
        //   （双端可见、换端不丢）；false = 仅本机 localStorage（旧行为）。
        //   注意：本键属于 storage 组（设置页「存储」子页 st_ 开关直接读写 cfg.storage.*）
        syncLogServer: true,
        // ==================== v1.127：存储机制 = 独立文件（从 settings 剥离） ====================
        // 背景：记忆数据此前整包塞在 settings（TH 全局变量 fttMemoryState:<角色>）里 —— 每次保存都是
        //   一次整份 settings 写入（体量大、易与 Cocktail Plus/其它插件互相覆盖），且与「设定」耦合。
        // 现在：记忆数据上传为**服务端用户目录独立文件**（data/<用户>/user/files/），文件名为
        //   `ftt-state-<名称slug>-<角色作用域哈希>.json`（固化命名：同角色恒定同一文件；
        //   ST 文件名校验只允许 [a-zA-Z0-9_-.] ，故中文名转 ASCII slug，缺失时用名称哈希短码）。
        //   读取/合并/上传全走文件通道；settings 通道降级为「只读迁移 + 文件通道不可用时的写入兜底」。
        stateFile: true,        // 记忆数据独立文件（主存储 · 服务端用户目录）
        stateFileBak: true,     // 每次「立即同步」额外上传一个 `-bak` 备份文件（同步兼顾备份）
        snapshotFile: true,     // 快照链独立文件（`ftt-snap-…`），与状态文件解耦、双端并集合并
        settingsMirror: false,  // 是否仍把整包写回 settings 存档变量（默认否=剥离；文件通道不可用时自动兜底写入）
        deletedKeepDays: 365,   // 删除墓碑（含内容哈希墓碑）保留天数 —— 过期才回收，防止「删了又被对端唤醒」
        // ==================== B9-d：条目瘦身 + gzip 存储（V2 专属开关 · **默认关闭 = 默认安全**） ====================
        // V1 恒「瘦身 + 先 gzip 再 base64」写 `.json.gz`；V2 存储设计此前有意选明文，故改为**显式开关**：
        //   · 关闭（默认）：写入名/内容/请求序列与 B7-2 完全一致（既有文件与既有测试口径不受影响）；
        //   · 开启：写入前先瘦身（`core/slim.js`），再按需 gzip（`adapters/gzip.js`）写 `.json.gz`；
        //     读取侧**一律按内容魔数**（1f 8b）识别 gzip 与明文（`adapters/user-file.js#readStateFileAuto`），
        //     明文旧文件始终可读，开关可随时来回切换；
        //     通道不支持压缩或压缩失败 → 自动回退明文 `.json`（绝不写坏文件）。
        stateFileSlim: false,   // 条目瘦身（剥运行期/可重算字段 + 快照内容剥离为 snapIndex）
        stateFileGzip: false,   // 主/备份/快照文件 gzip 写入（`.json.gz`；写入失败回退明文）
        // ==================== v1.150 / v2.77.0：宿主平台 TauriTavern（原生存储 · 自动兼容切换） ====================
        // v2.77.0：本通道**已实现**（`adapters/tt-store.js` 官方契约 + `adapters/file-transport.js` 后端路由）——
        //   命名空间 `ftt2-files`、表 `main`；小载荷走 KV JSON、大载荷（记忆文件/备份/快照）走 Blob；
        //   读取未命中回退酒馆用户目录文件；详见 docs/P10ao。
        // TauriTavern（SillyTavern 的 Tauri/Rust 原生移植）提供 `window.__TAURITAVERN__.api.extension.store`
        //   作为扩展专用持久化（KV + Blob，落 `_tauritavern/extension-store/`）。检测到该宿主特征/API 时，
        //   文件通道（记忆文件 / -bak 备份 / 快照文件 / 清单文件 / 同步日志镜像）自动改走原生存储；
        //   读取优先原生、缺失时回退酒馆用户目录文件（兼容从普通酒馆迁移过来的旧文件）。
        tauriNative: 'auto',    // auto=检测到即切换；on=强制走原生存储；off=始终用酒馆用户目录文件
        tauriMirror: false,     // 原生模式下**额外**镜像写一份 /user/files（便于退回普通酒馆时沿用；默认关，避免双份大文件上传）
        // [v1.35] 被动触发器：消息变动且主体空闲时自动检查待分析楼层
        autoIdleCheck: true,    // 达到分段策略阈值（summaryChunkSize）自动开展分析
        // [v1.27] 世界书存储
        worldbook: false,       // 世界书存储（记忆写入所选世界书词条）
        worldbookName: '',      // 选定世界书
        worldbookMode: 'selective', // 调取方式: constant(常驻蓝灯) | selective(绿色关键词) | vectorized(向量)
        worldbookScanDepth: 6,  // 触发楼层（关键词扫描深度，默认 6）
        worldbookPosition: 'at_depth', // 位置: at_depth=系统插入深度D（默认）
        worldbookRole: 'system',// 消息身份（at_depth 时有效）
        worldbookDepth: 9999,   // 插入深度（默认 9999 层）
        worldbookPreventRecursion: true, // 词条不可递归（双向禁止，防进一步递归）
        worldbookProbability: 100, // 激活概率(%)
        worldbookSticky: null,  // 黏性（激活后持续 n 条消息）
        worldbookCooldown: null,// 冷却（激活后 n 条消息内不再激活）
        worldbookDelay: null,   // 延迟（至少 n 楼才可激活）
        worldbookMaxBytes: 262144, // 词条内容上限（防世界书膨胀，默认 256KB）
    },
    // [v1.10] 请求/记忆 API 分组分离
    useKeywordFlow: false,       // 发送前先提取关键词
    kwApiEnabled: false,         // 关键词提取 API 独立配置开关
    kwApi: { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' },
    kwApiPreset: '',             // 关键词提取 API 使用预设名（优先于独立配置）
    memApiEnabled: false,        // 记忆分析 API 独立配置开关
    memApi: { apiType: 'custom', apiUrl: '', apiKey: '', model: '', proxyPreset: '' },
    memApiPreset: '',            // 记忆分析 API 使用预设名
    promptTemplates: {},   // v1.132：默认文本统一由 PROMPT_TEMPLATES_V2 提供（见下方 v1.132 段）
    // [v1.51] 各大类单条正文字数上限（中文按字；AI 摘要/修复时写入提示词约束，入库时对超限正文硬截断）
    // v1.135：默认值整体上调（用户要求「每个大类默认字数长度适当加大；分析提示词不变，JS 截断的默认长度优化」）——
    //   提示词里的目标字数（如 情节 ≤180 字）保持原样不变，本处是**入库硬截断**的上限，留出余量避免把
    //   提示词已允许的内容整段砍掉（旧默认值：情节180/状态60/档案300/记忆120/物品80/计划100/悬念100/场景120/概念160/平行336）。
    dimCharLimits: {
        atoms: 360,        // 情节：总结式提炼（提示词目标 ≤260，JS 硬截断留余量）
        states: 130,       // 状态：当下成立的字段值（提示词 ≤90）
        snapshots: 600,    // 角色档案：结构化长档案（提示词 ≤420）
        memories: 260,     // 记忆：特定角色对某事的个人记忆（提示词 ≤180）
        items: 160,        // 物品：获取/转交/销毁/变化的记录（提示词 ≤120）
        plans: 200,        // 计划：目标 + 因果（提示词 ≤140）
        suspense: 200,     // 悬念：未解疑问 + 因果/伏笔（提示词 ≤140）
        currencies: 200,   // v1.181 货币：币种 + 归属 + 额度 + 收支备注（提示词：备注 ≤80 / 单条收支说明 ≤40）
        rumors: 240,       // v1.192 传言：当前形态的说法 + 客观性 + 传播者/载体（提示词：说法 ≤180）
        scenes: 260,       // 场景：地点节点描述（提示词 ≤180）
        concepts: 320,     // 概念：内在机理 + 产生的结果（提示词 ≤240）
        parallels: 560,    // 平行事件：正文之外推演描述（提示词 ≤460）
    },

};

const KIND_MAP = {
    atoms: { get: () => state.atoms, set: (v) => { state.atoms = v; } },
    states: { get: () => state.currentStates, set: (v) => { state.currentStates = v; } },
    // 别名（V2 新增）：规范维度键 `currentStates` 与 V1 界面键 `states` 指向同一容器 ——
    //   让「删除/墓碑」既能被 V1 口径调用，也能以规范键写入（V1 的清理/合并只认规范键）。
    currentStates: { get: () => state.currentStates, set: (v) => { state.currentStates = v; } },
    snapshots: { get: () => state.snapshots, set: (v) => { state.snapshots = v; } },
    memories: { get: () => state.memories, set: (v) => { state.memories = v; } },
    items: { get: () => state.items, set: (v) => { state.items = v; } },
    plans: { get: () => state.plans, set: (v) => { state.plans = v; } },
    suspense: { get: () => state.suspense, set: (v) => { state.suspense = v; } },
    npcs: { get: () => state.npcs, set: (v) => { state.npcs = v; } },
    scenes: { get: () => state.scenes, set: (v) => { state.scenes = v; } },
    concepts: { get: () => state.concepts, set: (v) => { state.concepts = v; } },
    parallels: { get: () => state.parallels, set: (v) => { state.parallels = v; } },
    currencies: { get: () => state.currencies, set: (v) => { state.currencies = v; } },   // v1.181：货币大类
    plotSegments: { get: () => state.plotSegments, set: (v) => { state.plotSegments = v; } },   // v1.182：情节分段总结（只归档，不注入）
    rumors: { get: () => state.rumors, set: (v) => { state.rumors = v; } },   // v1.192：传言（记录 + 机械演化 + 注入）
    maps: { get: () => state.maps, set: (v) => { state.maps = v; } },   // v3.47.3（W18 数-22）：地图（空间单元 + 路径）
};

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

// V1 口径：默认提示词模板并入 `defaultCfg.promptTemplates`（逐字同源）
Object.assign(defaultCfg.promptTemplates, PROMPT_TEMPLATES_V2);

export { CN_KEY_MAP, DIMENSIONS, DIM_LABELS, PROMPT_DEFAULT_VERSION, PROMPT_GROUPS, PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, ARMOR_PRESET_V1178_DEFAULT, defaultCfg, KIND_MAP, normalizeDeltaKeys };
