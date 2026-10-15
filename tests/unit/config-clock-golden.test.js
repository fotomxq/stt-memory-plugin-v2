// ============================================================
// 单元测试 · 批次 4（core/config.js 配置层 + core/clock.js 时钟族）与 V1 黄金样本一致
// 黄金样本：tests/fixtures/v1-golden-config-clock.json（V1 源码切片产出）
// 口径：严格相等（JSON.stringify；键顺序一致）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { CN_KEY_MAP, DIMENSIONS, DIM_LABELS, PROMPT_DEFAULT_VERSION, PROMPT_GROUPS, PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, ARMOR_PRESET_V1178_DEFAULT, defaultCfg, KIND_MAP, normalizeDeltaKeys } from '../../core/config.js';
import { clockDateTrim, clockDateParts, clockDateStr, clockDateValid, clockNormBcText, clockYearStr, storyDateMs, storyDateMsFromStr, clockDateFromParts, clockCnInt, clockValNum, clockValYear, clockYearOf, clockYearInRange, clockDateLabel, clockMonthDay, clockAnomalyJumpYears } from '../../core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-config-clock.json'), 'utf8'));
const R = makeReporter('config-clock-golden V1 移植保真度（批次 4）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);

cfg.clockAnomalyJumpYears = defaultCfg.clockAnomalyJumpYears;

// ---------- 配置层 ----------
R.assert('C1 defaultCfg：V1 的 217 键逐值一致（v2.51.0 删除的 10 个时钟键除外）+ 仅允许 V2 专有键（界面形态）', (() => {
    // 口径：V1 键必须**逐值**相同（保真）；V2 新增键须在白名单内（防悄悄加键/改键）
    // B9-d 例外（显式白名单）：`storage.stateFileSlim` / `storage.stateFileGzip` 为 V2 专有开关
    //   （V1 恒「瘦身 + gzip」、无对应开关），默认 false（默认安全）；V1 `storage` 的其余键仍逐值一致。
    // V2 专有键（V1 无）：界面形态 3 项 + API 三通道 2 项（v2.35.0 起；`''` = 未显式选择，按旧数据迁移推断）
    const V2_ONLY = ['uiShowDrawer', 'uiShowFloating', 'uiFirstTab', 'rumorFermentWindowDays', 'apiChannel', 'apiProfileId',
        // v2.86.0（`docs/D7` v0.5）：重要度改「窗口调用占比」→ 三个 V2 专有参数（V1 只有 importanceBase/importancePerUse，键保留兼容）
        'impRecalcEnabled', 'impWindowRadius', 'impRecalcCount',
        // v3.46.1（`docs/D22` W11 数-35）：三域联动五键（V2 专有；V1 无此功能）
        'triLinkEnabled', 'triLinkStateAdvance', 'triLinkMaxItems', 'triLinkPackMaxChars', 'triLinkMaxOps',
        // v3.46.2（W13 应-30）：货币融合三键（V2 专有）
        'currencyMergeEnabled', 'currencyMergeMaxItems', 'currencyMergeSumAmount',
        // v3.47.0（W16 应-33）：履历批量四键（V2 专有）
        'resumeBatchEnabled', 'resumeBatchDays', 'resumeBatchMaxRoles', 'resumeBatchMemoryPerRole',
        // v3.49.1（用户要求）：年龄高寿 → 主动标记去世的阈值键（V2 专有）
        'repairDeceasedAge',
        // v3.49.3（用户报告「情节自动分段统计提交巨量数据」）：情节分段的**体量上界**与**一次一批**（V2 专有）
        'plotSegmentMaxChars', 'plotSegmentMaxBatches', 'plotSegmentReserveRecent',
        // v2.84.0（用户要求）：存储上限改「总上限 + 各大类占比」→ 两个 V2 专有键（V1 只有逐维 storeMax*，键仍保留兼容）
        'storeTotalMax', 'storeShare',
        // v3.47.0（`docs/D22` W16 `数-22`）：地图维度的两个存储键（V2 专有 —— V1 无 `maps` 维度）
        'storeMinMaps', 'storeMaxMaps', 'mapTrailPhrase',   // v3.47.0（W16 应-21）：地图套话模板（V2 专有）
        // v2.42.0：交互/宿主追踪的分级与分类开关（V1 只有 debugEnabled）
        'debugLevel', 'debugTraceUi', 'debugTraceHost', 'debugTraceVerbose',
        // v3.44.0（`docs/D22` W4）：入库卫生两开关（`数-11` ① 关联锚点强制补丁 · `数-13` ① 空壳入库拦截）——
        //   两者**默认关**（默认值即「不改任何既有行为」），开启后才改变提示词 / 入库结果。
        'relAnchorRuleEnabled', 'shellGuardEnabled',
        // v3.45.5（`docs/D22` W4 · `docs/D26` 履历链）：角色履历的 6 个口径键（V1 无「履历」概念）——
        //   总开关 / 条数上限（软阈值）/ 接近上限预警比例 / 重要性免疫阈值 / 凝练目标字数 / 原作人物预填开关。
        'snapshotResumeEnabled', 'snapshotResumeMax', 'snapshotResumeTriggerRatio',
        'snapshotResumeImmune', 'snapshotResumeSummaryMax', 'snapshotResumeCanonFill'];
    const V2_STORAGE_ONLY = ['stateFileSlim', 'stateFileGzip',
    // v3.16.0（用户要求「增加本地文件存储模式，用于替代变量存储」）：本机缓冲的本地文件目录（空 = 不开启）
    // v3.26.0（用户要求「增加选择目录，可手动选择目录」）：用过的目录清单（目录选择器的候选来源之一；
    //   放配置而不是 localStorage —— 目录模式下变量层整体停用，候选清单不能反过来依赖它）
    'localFilePath', 'localFileDirs', 'localDiskDir'];   // v3.28.0：本地磁盘目录（真磁盘路径，替代浏览器本地存储）
    // v2.51.0 时钟改版（用户要求）：V1 的这 10 个时钟设定**有意删除**（只取最新情节后全部失效，插件内不留废弃项）——
    //   删除项必须在 V2 中**不存在**且不落入「V2 专有键」白名单。
    const REMOVED_V1_KEYS = ['clockForceDegrade', 'clockAnomalyJumpYears', 'clockAutoPatrol', 'clockPatrolAutoFix',
        'clockStoryDayEpoch', 'clockRegexPreset', 'clockDateRegex', 'clockTimeRegex', 'clockLocationRegex', 'clockRelative'];
    // v2.76.0（用户要求）：「各大类支持的默认词条数量限制提高，整体控制在 2000-3000 原子数量支持即可」——
    //   以下 25 个**条数/存储上限**的默认值**有意提高**（V1 逐值相同的口径在此让位于该要求）：
    //   注入条数上限合计 2980（落在 2000-3000），存储上限合计 5600（承载 2-3k 条库存的任意分布）。
    const RAISED_CAP_KEYS = ['maxAtoms', 'maxMemories', 'maxStates', 'maxSnapshots', 'maxItems', 'maxPlans', 'maxSuspense',
        'maxScenes', 'maxConcepts', 'maxNpcs', 'maxParallels', 'maxParallelsInj', 'maxCurrencies', 'maxRumors',
        'storeMaxAtoms', 'storeMaxMemories', 'storeMaxSnapshots', 'storeMaxItems', 'storeMaxConcepts', 'storeMaxScenes',
        'storeMaxPlans', 'storeMaxSuspense', 'storeMaxNpcs', 'storeMaxRumors', 'storeMaxCurrencies'];
    // v2.86.0（`docs/D7` §4.9 C1）：「重要度」值域改为窗口占比（典型 0-30%）→ 清扫保护阈值 0.7 → 0.2（≈4 倍窗口均值）
    // v3.23.0（用户要求「全部AI摘要需支持分段处理，且默认采用 **3 个正文**进行切片，分批进行处理。避免一次性分析记忆。」）：
    //   「每段正文数」默认值 **10 → 3**（`core/chunk.js#SUMMARY_CHUNK_DEFAULT`，成为全部摘要入口的统一段长上界）——
    //   语义键不变、用户可改，属**默认值有意偏离**（样本一字不改，仅在此登记）。
    // v3.45.3（用户要求「各大类现有修复功能，每次限定可能抽取 3 个数据，改为默认抽取 6 个。且该约定可在设定中设置修改」）：
    //   **六处「每轮抽取量」默认值 3 → 6** —— 角色修复条数 / 状态修复主体数 / 概念·记忆·悬念·物品四域的
    //   「每次核对组数」（`*RepairMaxClusters`）。六个键在设定页都能改（用户要求的「可在设定中设置修改」），
    //   故属**默认值有意偏离**，不是键语义变化；V1 样本一字未改，只在此登记并逐键复核（见下方 `deviated` 判据）。
    //   **未动**：`maxAutoRepairRounds`（同楼层自动修复**轮次**上限）与 `repairMaxItems`（候选池 20 条）—— 都不是「每轮抽取量」。
    // v3.49.3（用户报告「情节的自动分段统计存在设计缺陷，会提交巨量数据」）：
    //   `plotSegmentIncremental` 默认值 **false → true** —— 语义键不变、用户可改（设定页有开关），属**默认值有意偏离**：
    //   实测（`tests/local/plot-segment-audit.mjs`）真实存档 800+ 条情节时，旧默认「每次全量重跑」会让**每次点击都重复提交整库**；
    //   改为默认增量（只整理尚未被现有段落覆盖的批次）后不再重复提交。V1 样本一字未改，只在此登记。
    const DEVIATED_KEYS = ['lowUseForgetProtectImportance', 'summaryChunkSize',
        'repairCharacterBatch', 'stateRepairBatch',
        'conceptRepairMaxClusters', 'memoryRepairMaxClusters', 'suspenseRepairMaxClusters', 'itemRepairMaxClusters',
        'plotSegmentIncremental'];
    const v1 = G.defaultCfg || {};
    const diff = Object.keys(v1).filter((k) => k !== 'storage' && k !== 'promptTemplates' && REMOVED_V1_KEYS.indexOf(k) < 0
        && RAISED_CAP_KEYS.indexOf(k) < 0 && DEVIATED_KEYS.indexOf(k) < 0 && J(v1[k]) !== J(defaultCfg[k]));
    const stillThere = REMOVED_V1_KEYS.filter((k) => k in defaultCfg);
    const v1s = v1.storage || {}, cur = defaultCfg.storage || {};
    const storageDiff = Object.keys(v1s).filter((k) => J(v1s[k]) !== J(cur[k]));
    const storageExtra = Object.keys(cur).filter((k) => !(k in v1s));
    const extra = Object.keys(defaultCfg).filter((k) => !(k in v1));
    // 白名单内的键必须**确实**与 V1 不同（防白名单被滥用成「随便改」）
    const raised = RAISED_CAP_KEYS.filter((k) => (k in v1) && Number(defaultCfg[k]) > Number(v1[k]));
    // 偏离白名单内的键必须**确实**与 V1 不同（防白名单滥用）
    const deviated = DEVIATED_KEYS.filter((k) => (k in v1) && J(defaultCfg[k]) !== J(v1[k]));
    return Object.keys(v1).length === 217 && diff.length === 0 && stillThere.length === 0
        && deviated.length === DEVIATED_KEYS.length
        && raised.length === RAISED_CAP_KEYS.length
        && extra.every((k) => V2_ONLY.indexOf(k) >= 0) && extra.length === V2_ONLY.length
        && storageDiff.length === 0 && J(storageExtra.slice().sort()) === J(V2_STORAGE_ONLY.slice().sort())
        && cur.stateFileSlim === false && cur.stateFileGzip === false;
})(), (() => {
    const v1 = G.defaultCfg || {};
    const v1s = v1.storage || {}, cur = defaultCfg.storage || {};
    return {
        keys: Object.keys(defaultCfg).length, v1Keys: Object.keys(v1).length, extra: Object.keys(defaultCfg).filter((k) => !(k in v1)),
        storageDiff: Object.keys(v1s).filter((k) => J(v1s[k]) !== J(cur[k])), storageExtra: Object.keys(cur).filter((k) => !(k in v1s)),
    };
})());
// v3.47.0（`docs/D22` W16 `数-22`）：**V2 专有中文键**（V1 无地图维度）—— 与 V1 黄金逐项比对时显式剔除，
//   并**单独断言**这些键确实在册（归一 ≠ 删键）。样本一字未改（`开发守则.md` §4）。
const V2_CN_ONLY = ['地图库', '地图', '空间单元', '所属场所', '上层', '起点', '终点', '距离', '耗时', '所需时间', '走过', '方向', '别名', '证据'];
R.assert('C2 CN_KEY_MAP 中文键映射与 V1 一致（V1 的 174 项逐项相同；V2 专有键另列白名单）', (() => {
    const got = {};
    Object.keys(CN_KEY_MAP).forEach((k) => { if (V2_CN_ONLY.indexOf(k) < 0) got[k] = CN_KEY_MAP[k]; });
    return J(got) === J(G.cnKeyMap) && V2_CN_ONLY.every((k) => CN_KEY_MAP[k] !== undefined);
})(), Object.keys(CN_KEY_MAP).length);
R.assert('C3 normalizeDeltaKeys 与 V1 一致（嵌套对象 / 数组 / vars 原样保留）',
    J(I.DELTAS.map(d => normalizeDeltaKeys(d))) === J(G.deltaCases), I.DELTAS.map(d => normalizeDeltaKeys(d)));
/** v3.19.0 / v3.45.5：**V2 专用提示词键**（V1 无）—— 模板键集合与分组结构比对时两者都要剔除 */
const V2_PROMPT_ONLY = ['nsfwAnalyze', 'resumeRepair', 'triLink', 'currencyMerge', 'resumeBatch', 'maps'];   // v3.46.1：+triLink；v3.47.0（W16 应-33）：+resumeBatch；v3.47.3（W17 数-22）：+maps（地图抽取模板）
R.assert('C4 维度清单与标签、提示词默认版本、模板键集合一致',
    // v3.47.0（`docs/D22` W16 `数-22`）：`core/config.js#DIMENSIONS` 是 **V1 摘要维度清单**（10 项，逐字对齐），
    //   地图不是 V1 维度 → **不进这份清单**（它进的是 `core/constants.js#DIMENSIONS` 的容器清单）；
    //   新增的只是**模板键** `maps` → 已在 `V2_PROMPT_ONLY` 里登记。
    J(DIMENSIONS) === J(G.dimensions) && J(DIM_LABELS) === J(G.dimLabels)
    && PROMPT_DEFAULT_VERSION === G.promptDefaultVersion
    // v2.51.0：`clockRegexGen`（AI 生成时钟正则）随「正文直取」一并移除 → 模板键集合 = V1 键集合减去它
    // v3.19.0 / v3.45.5 / v3.47.0：`nsfwAnalyze` / `resumeRepair` / `triLink` / `currencyMerge` / `maps` 都是 V2 专用键 → 一并剔除
    && J(Object.keys(PROMPT_TEMPLATES_V2).filter((k) => V2_PROMPT_ONLY.indexOf(k) < 0).sort()) === J((G.promptTemplateKeys || []).filter((k) => k !== 'clockRegexGen').sort()),
    [PROMPT_DEFAULT_VERSION, Object.keys(PROMPT_TEMPLATES_V2).length]);
// v2.51.0：`clockRegexGen`（AI 生成时钟正则）随「正文直取」一并移除 —— 比对时两侧同步剔除该键与对应文案
// v2.60.0（用户要求：去罗嗦/去历史）：分组**描述**已重写为 V2 文案，故此处的 V1 逐字比对只保留
//   「标题 + keys」结构（描述另在 C5b 做 V2 自检：非空、≤ 60 字、与模板条数一致）。
const normPromptGroup = (g) => Object.assign({}, g, {
    desc: undefined,
    // v3.19.0：`nsfwAnalyze`、v3.45.5：`resumeRepair` —— 两者都是 V2 专用键（V1 分组里没有）
    keys: (g.keys || []).filter((k) => k !== 'clockRegexGen' && V2_PROMPT_ONLY.indexOf(k) < 0),
});
R.assert('C5 提示词分组 / 旧默认签名表 / 破甲预设默认值一致（剔除已移除的时钟正则生成项）',
    J(PROMPT_GROUPS.map(normPromptGroup)) === J((G.promptGroups || []).map(normPromptGroup))
    && J(Object.keys(PROMPT_LEGACY_SIGS).sort()) === J((G.promptLegacySigsKeys || []).filter((k) => k !== 'clockRegexGen').sort())
    && J(ARMOR_PRESET_V1178_DEFAULT) === J(G.armorPresetDefault), Object.keys(PROMPT_LEGACY_SIGS).length);
R.assert('C5b 提示词分组描述为 V2 精简文案（非空、≤ 60 字、不吃掉分组结构）', (() => {
    const bad = PROMPT_GROUPS.filter((g) => !String(g.desc || '').trim() || String(g.desc).length > 60);
    return bad.length === 0 && PROMPT_GROUPS.length >= 5 && PROMPT_GROUPS.every((g) => (g.keys || []).length > 0);
})(), PROMPT_GROUPS.map((g) => String(g.desc || '').length));

R.assert('C6 模板并入默认配置（defaultCfg.promptTemplates 与 PROMPT_TEMPLATES_V2 同值）',
    J(defaultCfg.promptTemplates) === J(PROMPT_TEMPLATES_V2), Object.keys(defaultCfg.promptTemplates).length);
R.assert('C7 KIND_MAP 维度键：V1 的 14 键齐全且 get/set 读写注入 state + V2 别名 currentStates / 新维度 maps（白名单）', (() => {
    // 口径：V1 的 14 个维度键必须存在且可读写注入 state；
    //   V2 追加 `currentStates` 别名（与 'states' 同容器，用于以规范维度键写墓碑）→ 白名单内允许。
    const V1_KEYS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'npcs', 'scenes', 'concepts', 'parallels', 'currencies', 'plotSegments', 'rumors'];
    // v3.47.0（`docs/D22` W16 `数-22`）：V2 新增的**维度键**（V1 无 `maps` 维度）—— 与 `currentStates` 别名同列白名单
    const V2_ALIAS = ['currentStates', 'maps'];
    const keys = Object.keys(KIND_MAP);
    const missing = V1_KEYS.filter((x) => keys.indexOf(x) < 0);
    const extra = keys.filter((x) => V1_KEYS.indexOf(x) < 0);
    setKernelState({ atoms: [{ id: 'a1' }], currentStates: [{ id: 'c1' }] });
    const g = KIND_MAP.atoms.get().map((x) => x.id);
    KIND_MAP.atoms.set([{ id: 'a2' }]);
    const after = (KIND_MAP.atoms.get() || []).map((x) => x.id);
    const statesIsArray = Array.isArray(KIND_MAP.states.get());
    const aliasSame = KIND_MAP.currentStates.get() === KIND_MAP.states.get();
    setKernelState(null);
    return missing.length === 0 && extra.length === V2_ALIAS.length && extra.every((x) => V2_ALIAS.indexOf(x) >= 0)
        && J(g) === J(['a1']) && J(after) === J(['a2']) && statesIsArray === true && aliasSame === true;
})(), Object.keys(KIND_MAP));

// ---------- 时钟族 ----------
R.assert('K1 clockDateTrim / clockDateParts 与 V1 一致（含公元前 / 空值 / ISO）',
    J(I.DATES.map(d => clockDateTrim(d))) === J(G.clock.trim) && J(I.DATES.map(d => clockDateParts(clockDateTrim(d)))) === J(G.clock.parts), I.DATES.map(d => clockDateTrim(d)));
R.assert('K2 clockDateStr / clockDateValid 与 V1 一致',
    J([[1919, 11, 29], [-221, 1, 2], [9, 1, 1]].map(([y, m, d]) => clockDateStr(y, m, d))) === J(G.clock.str)
    && J(I.DATES.map(d => clockDateValid(d))) === J(G.clock.valid), I.DATES.map(d => clockDateValid(d)));
R.assert('K3 clockNormBcText 公元前归一与 V1 一致', J(['公元前221年', '前221年', '公元1919年', '公元前221年11月29日', '无', ''].map(t => clockNormBcText(t))) === J(G.clock.bcNorm), G.clock.bcNorm);
R.assert('K4 clockYearStr / storyDateMs / storyDateMsFromStr 与 V1 一致',
    J([1919, -221, 9, 0].map(y => clockYearStr(y))) === J(G.clock.yearStr)
    && J(['1919-11-29', '-0221-01-02', '1919-11', '1919', ''].map(d => storyDateMs(d))) === J(G.clock.storyMs)
    && J(['1919-11-29', '-0221-01-02', 'bad'].map(d => storyDateMsFromStr(d))) === J(G.clock.storyMsFromStr), G.clock.storyMs);
R.assert('K5 clockDateFromParts / clockCnInt / clockValNum / clockValYear 与 V1 一致',
    J([['1919', '11', '29'], ['-0221', '1', '2'], ['1919'], ['', '2', '3']].map(p => clockDateFromParts(p, '1919-01-01'))) === J(G.clock.dateFromParts)
    && J(['一九一九', '二二一', '九', '三〇', '', 'abc'].map(t => clockCnInt(t))) === J(G.clock.cnInt)
    && J([' 12 ', '十一', 'x', ''].map(t => clockValNum(t))) === J(G.clock.valNum)
    && J(['1919', '公元前221年', 'x'].map(t => clockValYear(t))) === J(G.clock.valYear), G.clock.cnInt);
R.assert('K6 clockYearOf / clockYearInRange / clockDateLabel / clockMonthDay 与 V1 一致',
    J(['1919-01-01', '-0221-01-02', '', null].map(t => clockYearOf(t))) === J(G.clock.yearOf)
    && J([-9999, -221, 0, 1919, 99999].map(y => clockYearInRange(y))) === J(G.clock.yearInRange)
    && J(['1919-11-29', '-0221-01-02', '1919-11', '', null].map(d => clockDateLabel(d))) === J(G.clock.dateLabel)
    && J(['1919-11-29', '1919-11', '', null].map(d => clockMonthDay(d))) === J(G.clock.monthDay), G.clock.dateLabel);
R.assert('K7（v2.51.0 已移除该设定）时钟不再有「日期异常判定阈值」——确认废弃键已从默认配置删除', (() => {
    return !('clockAnomalyJumpYears' in defaultCfg) && !('clockForceDegrade' in defaultCfg) && !('clockAutoPatrol' in defaultCfg);
})(), Object.keys(defaultCfg).filter((k) => /^clock/.test(k)));
R.assert('K8 日期校验与本设定无关（阈值设定已删除，校验行为不变）', (() => {
    const before = clockDateValid('1919-11-29');
    const after = clockDateValid('1919-11-29');
    return before === true && after === true && clockDateValid('1919-13-45') === false;
})(), '');

R.done();
