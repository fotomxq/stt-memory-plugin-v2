# D30 · NSFW 弱化功能详细设计（留存稿）

> 文档版本：v1.1 ｜ 日期：2026-10-11 ｜ 类型：**设计稿（不发版）** ｜ 状态：**已落地（v3.45.2，W7 三行）**（记录现行实现 + 3 项加固的落地状态）
> v1.1 变更（随 v3.45.2 实现轮 · `docs/D22` **W7**）：§6「待确认问题清单」按用户裁决（**Q1–Q3 整批采纳建议默认**）转正为**决策记录**（含落地位置）；
>   §8 表下新增 **§8.1 落地状态**（逐条给实际落点与验收证据，真机项如实记「未取得」）；§2.8 补记本轮新增的两处只读读数；
>   附录补 **v3.45.2** 一行（三行格式：改了什么 / 为什么 / 证据）。**§1–§5、§7 与 §8 的实施规格表未改动**。
> 触发（用户原话）：「请将弱化NSFW功能的详细设计，在设计稿中留存，以确保后续方便维护和追溯。」
> **维度归属：跨维**（按 `开发守则.md` §2.5 以**业务**为最高维归档 —— 主体是内容弱化口径；影响 **应用**（入口与可核对性）/ **数据**（正文改写与等级留档）/ **技术**（词库、AI 接线与门禁）；表内逐行标实际维度）。
> 事实基准：程序 **v3.42.0**（`core/constants.js#VERSION`）。本稿属**设计轮次**（`开发守则.md` §1）：不改代码、不动版本号、不打 tag。
> 关联：`docs/02-数据架构.md`（NSFW 等级留档口径）· `docs/04-应用架构.md` §2.1（总览「🌶 弱化NSFW」按钮归属维护区）· `docs/D23-总览页布局与按钮功能定位设计稿.md` §3.2（五区契约）·
> `docs/D17-未落实事项台账.md` §1.14（事实登记 U179–U181）· `docs/D22-开发待办清单.md` §4.8（执行视图 W7）· `CHANGELOG.md`（唯一版本史）· `docs/history/` 对应批次档

---

## 1. 目标 / 非目标

**目标**：把「NSFW 弱化」这一**已生效功能**的完整设计写成**唯一基准** —— 入口与动作、扫描范围与命中判据、三段式处理、AI 提示词与调用接线、落地校验、等级留档、词条分析、转化库导入导出、覆盖矩阵、测试与门禁、维护影响面。
读者不看批次档也能正确实施与改造；排障时不必回读 12 份文档与 7 份批次档。

**非目标**（明确不做）：

| # | 明确不做 |
| --- | --- |
| N1 | **本轮不改任何代码 / 测试 / 配置键**，不动版本号、不打 tag（`开发守则.md` §1 设计轮次口径） |
| N2 | 不新增识别词条、不调整转化词（词条数与转化词数被 `docs/README.md` §3 的口径行锁定） |
| N3 | 不改提示词模板的默认文案（`core/config.js#PROMPT_TEMPLATES_V2` 的 `nsfwSoften` / `nsfwAnalyze`） |
| N4 | 不复述 `docs/history/**` 与 `CHANGELOG.md` 的原文，只指向（§2.7 B2 的留痕纪律） |
| N5 | 不改总览五区契约（新增总览按钮属 `docs/D23` 的裁决范围，本稿只登记为待确认问题 Q1） |

---

## 2. 现状核对（每条带 `文件#符号` 证据）

### 2.1 入口与动作分发（全部为**手动**触发）

| 入口 | 动作名 | 落点 | 是否调用 AI |
| --- | --- | --- | --- |
| 总览 · D 维护区「🌶 弱化NSFW（N）」 | `nsfwSoften` | `ui/panel.js` → `ui/nsfw.js#nsfwAction` → `core/nsfw.js#runNsfwSoften` | ✅（固定规则 + AI 两段） |
| 设定 → NSFW弱化「🌶 立即弱化（按词条库扫描）」 | `nsfwSoften` | 同上 | ✅ |
| 设定 → NSFW弱化「🔁 立即固定规则替换」 | `nsfwRuleApply` | `ui/nsfw.js#nsfwAction` → `core/nsfw.js#nsfwFixedReplace` | ❌ 零 AI |
| 设定 → NSFW弱化「🧠 词条分析」 | `nsfwAnalyze` | `core/nsfw-analyze.js#runNsfwAnalyze` | ✅（产物是**规则**，不是正文） |
| 设定 → NSFW弱化「🔖 立即补档」 | `nsfwLabelBackfill` | `core/nsfw.js#nsfwBackfill` | ❌ 零 AI |
| 调试出口 | —— | `index.js`（`FTT.nsfwState` / `FTT.nsfwSoften` / `FTT.nsfwAnalyze` 等）· `devtools.js` | 视调用而定 |

- 动作名全集 = `ui/nsfw.js#NSFW_ACTIONS`，由 `ui/panel.js` 统一分发（与 V1 动作名逐字一致）。
- **无自动触发**：`core/nsfw.js#runNsfwSoften` 只有「按钮」与「调试桥」两个调用点（`index.js` 暴露）—— 不会随保存 / 载入自行运行。
- 另一条**不额外发请求**的路径：分析侧开关 `core/nsfw.js#nsfwSoftenEnabledOn`（默认关），开启后由 `core/nsfw.js#nsfwSoftenRuleText` 把同一段模板追加进摘要提示词（`core/prompt.js#buildSummaryPrompt`），让**新记忆一开始就不产生**露骨内容。

### 2.2 扫描：覆盖范围与命中判据（零 AI）

| 项 | 口径 | 落点 |
| --- | --- | --- |
| 维度白名单 | **12 维**：情节 / 状态记录 / 角色档案 / 长期记忆 / 物品 / 计划 / 悬念 / 场景 / 概念 / 平行事件 / 传言 / 情节分段（货币与名册**不在其列**） | `core/nsfw.js#NSFW_FIELD_MAP` · `#NSFW_DIM_LABEL` |
| 容器解析 | 经 `KIND_MAP` 取**真实容器**（状态记录在 state 上叫 `currentStates`）；修正 V1「`state.states` 恒空 → 状态记录整维被跳过」的缺陷（**有意偏离 V1**） | `core/nsfw.js#nsfwDimList` |
| 字段展开 | 点号路径（含嵌套，如角色档案的 `personality.traits`）；数组逐元素展开；对象数组取 `text` / `content` / `desc` / `name` / `value`；情节的 `text ↔ content` 是**同值镜像**，只收一次 | `core/nsfw.js#nsfwTextFields` · `#nsfwMirrorKey` · `#nsfwMirrorGroup` |
| 隐藏情节 | 已总结隐藏的情节**不参与**扫描与替换 | `core/merge.js#atomIsHidden` |
| 命中判据 | 中文按子串；英文按词首通配 + 词界，并过**误伤名单**（`cumulative` / `cumbersome` 一类普通词既不计命中也不替换） | `core/nsfw.js#nsfwKeywordHits` · `#nsfwEnRegex` · `#nsfwEnWordOk` · `#NSFW_EN_INNOCENT` |
| 预筛 | 按词库签名缓存的组合正则，是精确判定的**超集**（不改变命中结果，只省无命中字段的循环） | `core/nsfw.js#nsfwKeywordProbe` |
| 排序与分批 | 命中数降序（同数按维度名）；单批 `core/nsfw.js#NSFW_SOFTEN_BATCH` 条，余量以 `truncated` 回报「可再点一次」 | `core/nsfw.js#nsfwSoftenPack` · `#nsfwScan` |
| 词条库 | 内置 **63（V1 原样在前）+ v3.10.0 追加 + v3.12.0 追加**，合计见 `docs/README.md` §3；`cfg.nsfwKeywords` 自定义非空即**以它为准**（可逐条改 / 恢复内置） | `core/nsfw.js#NSFW_KEYWORDS` · `#NSFW_KEYWORDS_V1` · `#NSFW_KEYWORDS_V310` · `#NSFW_KEYWORDS_V312` · `#nsfwKeywordList` · `#nsfwKeywordsCustomized` |
| 只读读数 | 扫描条数 / 字段数 / 命中处数 / 单批大小 / 词条与规则条数 / 自动开关态 | `core/nsfw.js#nsfwSoftenState` |

### 2.3 三段式处理（当前生效流程）

| 段 | 做什么 | 落点 | 关键纪律 |
| --- | --- | --- | --- |
| ① 零 AI 机械替换（默认开） | 按转化库对**原文单遍匹配 + 区间占位**替换，写回字段 | `core/nsfw.js#nsfwReplaceAutoOn` · `#nsfwFixedReplace` · `#nsfwApplyRules` · `#nsfwSetByPath` · `#nsfwSyncMirror` | 不链式二次转换（结果与规则顺序无关）；重叠按**长词优先**；英文走词首通配 + 误伤名单；写回后刷 `updatedAt` 并保存 |
| ② 剩余命中交 AI | 打包本批 → 组提示词 → 调模型 | `core/nsfw.js#buildNsfwSoftenPrompt` · `core/ai-hooks.js#aiCallText`（label `弱化NSFW`） | 只把**命中字段**入批，其余字段原样不动 |
| ③ 强校验落地 | 逐条校验后写回 | `core/nsfw.js#applyNsfwSoftenResult` | 丢弃：编号不在本批 / 结果仍含露骨词（按同一词条库复核）/ 超长 / 与原文相同；只写命中字段 + 镜像同步 + `updatedAt` + 保存 |

- **忙位门**：`core/ai-hooks.js#aiBusy`（摘要 / 提取 / 同步在途 → 本次拒绝，数据不动）。
- **短路（零请求）**：无命中且未开自动替换 → 直接返回；①跑完后剩余命中为空 → **不发 AI 请求**。
- **AI 无返回**：回报 `no-ai`，**①已落地的替换不回滚**（这是「宁可少改，不可回退已确认改动」的口径）。
- **失败不写坏**：③的每一条都是「要么写回合格文本，要么原样保留」。

### 2.4 AI 提示词与调用接线

| 项 | 口径 | 落点 |
| --- | --- | --- |
| system | 提示词模板 `nsfwSoften`（设定 → 提示词面板「④ 质检维护」可改）+「只输出 JSON，不要解释，不要复述原文」 | `core/config.js#PROMPT_TEMPLATES_V2` · `cfg.promptTemplates` |
| user | 待弱化清单：`#编号 ｜ 维度 ｜ 字段路径 ｜ 条目名 ｜ 命中词（最多 6 个） ｜ 留档等级 ｜ 原文`，原文**每条截断 600 字**；并给出输出契约 `{"弱化":[{"编号","文本","说明"}],"无法处理":[n]}` | `core/nsfw.js#buildNsfwSoftenPrompt` · `#NSFW_TEXT_CAP` |
| 模板口径（现行） | 保留剧情 / 关系 / 情绪 / 因果 / 后果；只把性行为与性器官的**露骨直述**换成柔性、克制、留白的表述；专名、数量、时间、地点、称谓照原样保留；**长度不超过原文**；不添加原文没有的情节与评价 | `core/config.js#PROMPT_TEMPLATES_V2` 的 `nsfwSoften` |
| 调用链 | `core/ai-hooks.js#aiCallText` → 钩子 `callAi`（`index.js` 装配期注入）→ `core/api-channel.js#purposeOfLabel`（`弱化NSFW` → **`main`**）+ `#resolveApiTarget` → `host/generation.js#rawGenerate` → 宿主 `ctx.generateRaw` | `core/ai-hooks.js` · `index.js` · `core/api-channel.js` · `host/generation.js#rawGenerate` |
| 管线状态 | 进「管线状态」：prompt 字符数 → token 估算、阶段、响应结构摘要、ETA 样本、流式块（宿主通道为**一次性返回**，无逐块回调） | `core/pipeline.js#beginPipeline` · `#addStreamChunk` · `#setPipelinePhase` · `#setPipelineKeys` · `#endPipeline` |
| 可中断性 | **不可中断**：`generateRaw` 是一次性请求，按钮在途只体现为「占用中」 | `host/generation.js#rawGenerate` |
| 用量账本 | 按 `usageLabel = 弱化NSFW` 归组记账（成功与失败都记一条） | `host/ai-usage.js` · `core/token-cost.js` |

### 2.5 NSFW 等级留档（永久留档，与弱化解耦）

| 项 | 口径 | 落点 |
| --- | --- | --- |
| 字段 | `nsfw` = `none` / `weak` / `strong`（缺省 = 无） | `core/nsfw-level.js#NSFW_LEVEL_FIELD` · `#NSFW_LEVELS` |
| 三级释义 | 无 = 与 NSFW 完全无关；弱 = 有部分亲密或暗示但无露骨内容；强 = 完全是露骨内容（单一来源） | `core/nsfw-level.js#NSFW_LEVEL_LABELS` · `#NSFW_LEVEL_HINTS` · `#nsfwLevelLabel` · `#nsfwLevelHint` |
| 判级 | AI 显式标注优先（写入 delta 的标注键），其次按**写入当时原文**：命中词条库 → 强；命中弱级信号 → 弱 | `core/nsfw-level.js#NSFW_AI_LEVEL_KEYS` · `#nsfwLevelFromEntry` · `core/nsfw.js#nsfwClassifyItem` · `core/nsfw-level.js#NSFW_WEAK_SIGNALS` · `#nsfwWeakHit` |
| **只升不降** | 打标取「既有留档 / AI 标注 / 按原文判级」三者最高级；一旦为「强」不再回落 | `core/nsfw-level.js#nsfwStampLevel` · `#nsfwLevelMax` · `core/nsfw.js#nsfwStampItem` · `#nsfwStampEntry` |
| 弱化不改标签 | 两条弱化路径（`core/nsfw.js#nsfwFixedReplace` / `#applyNsfwSoftenResult`）**只写文本字段**，绝不触碰 `nsfw` | 同上 |
| 去重与跨端合并 | 取两侧较高者（弱化过的一侧不会冲掉原侧的「强」） | `core/nsfw-level.js#nsfwMergeLevel` |
| 派生条目继承 | 同 id 既有条目的留档被继承（AI 改写 / 弱化 / 重归一化都不得降档） | `core/entry-meta.js` |
| 补档 | 幂等全库补档 + 载入后自动补档一次 | `core/nsfw.js#nsfwBackfill` · `index.js` |
| 展示 | 列表行徽标（无 → 不显示）、分类页汇总行、条目编辑器只读行 | `ui/list-rows.js#nsfwBadgeHtml` · `#nsfwLegendHtml` · `ui/panel.js` |
| 统计 | 无 / 弱 / 强三级分布与逐维计数 | `core/nsfw.js#nsfwLabelStats` |

### 2.6 🧠 词条分析（AI 建库：产物是规则，不是正文）

| 步 | 口径 | 落点 |
| --- | --- | --- |
| 抽取 | 只取**留档为「强」**的条目文本字段（字段白名单与弱化**共用** `NSFW_FIELD_MAP`）；隐藏情节不参与、过短字段跳过 | `core/nsfw-analyze.js#nsfwAnalyzeCandidates` |
| 打包 | 每批固定处数、**未分析过的优先**（按内容指纹记账，改写后视为新数据） | `core/nsfw-analyze.js#nsfwAnalyzePack` · `#nsfwAnalyzeSeenCount` · `#nsfwAnalyzeSeenReset` |
| 提示词 | 专用模板 `nsfwAnalyze`（提示词面板可改）：找造成强 NSFW 的**词** + 柔化**替换词** + 理由，严格 JSON | `core/nsfw-analyze.js#buildNsfwAnalyzePrompt` · `core/config.js#PROMPT_TEMPLATES_V2` |
| 校验 | 「词」必须**原样出现**在该条原文；替换词不得仍含露骨词、不得与原词相同或包含原词；长度与字符集限制；**日常词黑名单 + 散布阈值**（在非强留档数据里出现过多即判为日常词丢弃） | `core/nsfw-analyze.js#applyNsfwAnalyzeResult` · `#nsfwAnalyzeSanitize` · `#NSFW_ANALYZE_SPREAD_MAX` |
| 落地 | 写**转化库**（立即可用于「🔁 立即固定规则替换」并同批补进**识别词条库**）；单次落库上限 | `core/nsfw.js#nsfwRuleAdd` · `#nsfwKeywordAdd` · `core/nsfw-analyze.js#NSFW_ANALYZE_MAX_ADD` |
| 记账 | 运行时账本（最近一次结果 + 最近若干条新增明细 + 指纹表），**不进数据模型** | `core/nsfw-analyze.js#nsfwAnalyzeState` · `#setNsfwAnalyzeHooks` · `adapters/settings.js` |
| 界面 | 「上次分析：时间 / 提交 / 新增 / 已在库 / 丢弃 / 已分析进度」只读行 + 重置进度按钮 | `ui/nsfw.js#nsfwPageHtml` |

### 2.7 转化库导出 / 导入（v3.21.0）

| 项 | 口径 | 落点 |
| --- | --- | --- |
| 导出 | 导出**当前生效**库（自定义非空用它，否则用内置标准库）；带信封 `kind`（防误导入别的库）+ `schema`（备将来换格式）+ `source` + `count` + `rules`；真实落文件 + 复制剪贴板 + 页面文本框兜底 | `core/nsfw.js#nsfwRulesExportPayload` · `#nsfwRulesExportText` · `#NSFW_RULES_IO_KIND` · `#NSFW_RULES_IO_SCHEMA` |
| 导入 | **合并**语义：只新增、**不覆盖既有匹配词、不删除任何条目**；逐条走「＋ 新增」同一套修剪 / 长度上限 / 大小写不敏感去重；入库即落盘 | `core/nsfw.js#nsfwRulesParseImport` · `#nsfwRulesImportText` · `#nsfwRuleAdd` |
| 宽容解析 | 信封 / 裸数组 / 多种容器键 / 多种字段别名 / 逐行「匹配词→转化词」文本 | `core/nsfw.js#nsfwRulesParseImport` |
| 口径边界 | 导入**不做 AI 语义校验**（「替换词本身仍露骨」不拦）—— 规则库合并的合理性由使用者把关 | `core/nsfw.js#nsfwRulesParseImport` |

### 2.8 界面与只读读数

| 面 | 内容 | 落点 |
| --- | --- | --- |
| 设定 → NSFW弱化 | 五分节：📌 等级留档 / NSFW弱化 / 固定规则替换 / 转化库 / 识别词条库（V1 四节同序 + 留档分节） | `ui/nsfw.js#nsfwPageHtml` · `ui/settings-pages.js` |
| 总览 | 「🌶 弱化NSFW（N）」按钮，tooltip 写「按关键词找出露骨内容并**交 AI 弱化**」+ 留档分布 | `ui/panel.js` |
| 覆盖说明 | 页脚写明覆盖维度与「已总结隐藏的情节不参与扫描与替换」 | `ui/nsfw.js#nsfwPageHtml` |
| 调试 | `FTT.nsfwState` 等只读入口 | `index.js` · `devtools.js` |
| **v3.45.2 新增只读读数**（`docs/D22` W7） | ① **「上次弱化」状态行**（`data-ftt-nsfw-soften-state`）：时间 / 提交 / 已弱化 / 丢弃 / 超长跳过 / 无法处理 / 余量 / 固定规则处数 —— 来自**运行时账本** `nsfwSoftenLog`（`应-23`）；② **「其中超长 N 处」**（写在同一分节的扫描行 `data-ftt-nsfw-state` 上）：原文长度 > `NSFW_TEXT_CAP` 的命中字段数 —— 这些字段**不参与弱化**（`数-30` 的两道闸门），写明原因以免被误读为「漏了」 | `ui/nsfw.js#nsfwPageHtml` · `core/nsfw.js#nsfwSoftenState` |

### 2.9 测试与门禁

| 层 | 覆盖 | 落点 |
| --- | --- | --- |
| V1 黄金样本 | 词条库前缀逐字一致、扫描/打包结构、固定替换与 AI 落地口径 | `tests/unit/nsfw-golden.test.js` · `tests/fixtures/v1-golden-nsfw.json` |
| 等级留档 | 三级判级、只升不降、弱化后标签不变、状态记录参与扫描（修 V1 缺陷） | `tests/unit/nsfw-level.test.js` |
| 词条分析 | 抽取口径、校验表逐条、误伤护栏、落地与账本、端到端 | `tests/unit/nsfw-analyze.test.js` |
| 转化库 I/O | 导出信封三态、合并语义、宽容解析、如实计数、失败零副作用 | `tests/unit/nsfw-rules-io.test.js` |
| 冒烟 | 真实点击「固定规则替换」与「AI 弱化」两条路径、页面分节与动作按钮齐备、管线状态行 | `tests/smoke-test.js`（R1–R5 / BO1 / BI2） |
| 数字口径 | 识别词条数 / 转化词数 / 弱级信号词数由门禁逐行实测 | `docs/README.md` §3 · `scripts/check-docs-facts.js` |

---

## 3. 设计口径（方案）

### 3.1 为什么分三段：零 AI 优先，AI 只处理「规则做不到的部分」

1. **能机械替换的一律不花 token**：词面命中的情形由转化库直接落地（①），且**先跑规则再重新打包**（②只处理剩余命中）—— 这既省调用，也让「规则能覆盖的部分」结果完全可预测。
2. **顺序不可颠倒**：若先交 AI，规则替换会作用在已被改写的文本上，词条命中率下降、「哪些是原文事实」也失去参照。
3. **可解释性**：①的每一次替换都能由「词 → 转化词」逐条复盘；②的每一条都有 AI 给出的「说明」+ 落地前校验结论。

### 3.2 为什么「改文本」这一步必须调用模型

| # | 结构性理由 |
| --- | --- |
| A | **词库是有限枚举**：识别词条只覆盖已列举的字面形态；新造词、隐喻借代、外文变体、整段行为叙述却不含单词的表述，在**扫描阶段**就漏掉 —— 加词条只能收敛，无法推广到未列举的表述 |
| B | **命中也只能逐词换字**：`core/nsfw.js#NSFW_REPLACE_PAIRS` 是「词 → 固定转化词」的一对一映射；同段多词命中时会出现搭配不当、重复用词、语气漂移，而 `core/nsfw.js#nsfwApplyRules` 明确**不做链式二次转换** |
| C | **需要「区分剧情与描写」**：模板要求关系 / 情绪 / 因果 / 后果照实保留，只删动作细节、体位、体液、声响 —— 这是语义判断，词表无法区分 |
| D | **落地标准要求一次成文**：结果仍含露骨词即丢弃、长度不许膨胀 —— 整段改写比规则拼接更可能同时满足「不含露骨词 + 更短 + 语义不漏」 |

> **推论（维护要点）**：要**降低** AI 依赖，正确方向不是删掉②，而是让①的覆盖面持续变大 —— 即用「🧠 词条分析」把强留档数据里的新词回灌进转化库。

### 3.3 为什么 AI 结果要强校验（宁可少改，不可写坏）

- 只在**命中字段**上写回，其余字段与整条目结构不动；
- 四条硬门槛（编号合法 / 不含露骨词 / 长度受限 / 与原文不同）任一不过即**丢弃并计数**，不"打折入库"；
- 写回后同步镜像字段（`text ↔ content`）并刷新 `updatedAt`，使跨端合并按「较新」取用弱化后的文本；
- 全部丢弃时如实回报「AI 未给出可用结果」，**不伪造成功**。

### 3.4 留档为何「只升不降」

- 「按原文判定」是留档的定义：弱化改的是**措辞**，不是**事实程度**；若允许降档，「曾经是强」就无法追溯。
- 因此弱化的两条路径只写文本；去重与跨端合并取高；派生条目继承既有等级。
- **边界（必须知道）**：弱化**不会**降低留档等级，也不作为「是否已弱化」的判据 —— 判断某条是否被弱化过，要看正文本身或调试日志，不能看 `nsfw` 字段。

### 3.5 覆盖矩阵与不覆盖项

| 覆盖（12 维） | 不覆盖 |
| --- | --- |
| 情节（标题 / 正文 / 内容镜像）· 状态记录 · 角色档案（外貌 / 性格各子字段 / 背景 / 社交）· 长期记忆 · 物品 · 计划 · 悬念 · 场景 · 概念 · 平行事件 · 传言 · 情节分段（头 / 逐行） | **货币**与**名册**（不在白名单）· **已总结隐藏的情节** · 白名单以外的字段（如 id / 标签 / 时间等非文本字段）· **「弱」级**条目（见 Q3） |

### 3.6 维护入口与影响面（改什么 → 连带什么）

| 想改 | 落点 | 必须同批同步 |
| --- | --- | --- |
| 加 / 改识别词条 | `core/nsfw.js#NSFW_KEYWORDS_V310` · `#NSFW_KEYWORDS_V312`（内置）或设定页自定义库 | `docs/README.md` §3 的「NSFW 识别词条 / 转化词」行 + `tests/unit/nsfw-level.test.js` 与 `tests/unit/nsfw-golden.test.js` 的相关断言 |
| 加 / 改转化词 | `core/nsfw.js#NSFW_REPLACE_PAIRS` | 同上（缺转化词的条目会被 `NSFW_RULES` 自动跳过） |
| 改弱化 / 词条分析的提示词 | `core/config.js#PROMPT_TEMPLATES_V2`（模板 `nsfwSoften` / `nsfwAnalyze`，或用设定页覆盖） | **两侧同时生效**（分析侧开关 + 手动按钮共用同一模板） |
| 改单批条数 / 长度上限 | `core/nsfw.js#NSFW_SOFTEN_BATCH` · `#NSFW_TEXT_CAP` | 提示词里的「不超过原文」口径与通知文案 |
| 换模型 / 省 token | 弱化归 `main` 用途（`core/api-channel.js#purposeOfLabel`） | API 页的分组设置；目前**无**弱化专用用途（见 Q1） |
| 排障读数 | `core/nsfw.js#nsfwSoftenState` · `index.js` 的 `FTT.*` · `devtools.js` · 调试日志分类「弱化」 | —— |
| 动留档语义 | `core/nsfw-level.js#nsfwStampLevel` · `#nsfwMergeLevel` | `docs/02-数据架构.md` 的留档口径 + `core/entry-meta.js` 继承 |

---

## 4. 分阶段落地（均已生效；每阶段独立可用、可单独回退）

| 阶段 | 内容 | 生效版本 | 独立可用性 | 单独回退方式 |
| --- | --- | --- | --- | --- |
| **S0** | 识别词条库 + 固定规则转化库 + 零 AI 机械替换（`nsfwRuleApply`） | v2.13.0 | ✅ 零 AI、零配置即可用 | 清空自定义库并「恢复内置默认」；或关闭自动开关只留手动按钮 |
| **S1** | AI 弱化（提示词 + 强校验落地 + 忙位门 + 分析侧开关） | v2.13.0 | ✅ 与 S0 解耦（S0 已先落地） | 不点「🌶 立即弱化」即不发生 AI 调用；关掉分析侧开关即不再进摘要提示词 |
| **S2** | NSFW 等级留档（三级 + 只升不降 + 补档 + 徽标） | v3.8.0 | ✅ 只读展示，不影响弱化结果 | 不补档即维持「无」；已打标不回退（只升不降是口径，不是开关） |
| **S3** | 🧠 词条分析（AI 找词 → 写转化库） | v3.19.0 | ✅ 不点则零影响；产物是规则 | 点「♻ 重置分析进度」只清进度，不动两条库 |
| **S4** | 转化库导出 / 导入（合并语义） | v3.21.0 | ✅ 纯库 I/O | 不导出 / 不导入即维持现状；导入只增不删，可逐条删 |

---

## 5. 风险与对策

| # | 风险 | 对策（现行） | 现状 |
| --- | --- | --- | --- |
| R1 | 词库有限 → **漏**（未列举的露骨表述扫不到） | ②AI 整段改写兜底 + 用「🧠 词条分析」把新词回灌转化库 + 允许自定义库 | 已内置 |
| R2 | 词面**误伤**（跨语境词，如「项圈 / 失禁 / 交尾」） | 转化词一律取柔性表述；库可逐条编辑 / 恢复内置；代价是**该段文字被弱化，但不丢数据** | 已内置并登记 |
| R3 | AI 结果不合格（仍露骨 / 膨胀 / 无变化 / 编号漂移） | 四条硬门槛**直接丢弃**并如实计数回报 | 已内置 |
| R4 | 长字段被「只看前 600 字」的结果覆盖 → 尾部有丢失风险 | 见 §8 的 `数-30`（先只读核实，再加落地判据） | **未核实 + 待加固** |
| R5 | AI 不可用 / 忙位冲突 | ①已落地部分保留、如实回报 `no-ai`；忙位直接拒绝且不动数据 | 已内置 |
| R6 | 被误当**零成本**动作 | 按钮 tooltip 与设定页均写明「交 AI 弱化」；零 AI 替代入口在设定页「🔁 立即固定规则替换」 | 已写明；总览不指路（见 Q1） |
| R7 | 提示词被改坏 | 两侧共用同一模板（改一次两边都变，不会只坏一侧）；排障看 `FTT.nsfwState` 与调试日志分类「弱化」 | 已内置 |
| R8 | 弱化与留档被混为一谈（以为弱化后等级会降） | 模板、通知、编辑器只读行三处都写明「按原文判定，弱化后不变」 | 已内置 |

---

## 6. 决策记录（原「待确认问题清单」，v1.1 随 v3.45.2 转正）

> **裁决方式**：用户裁决「**Q1–Q3 整批采纳建议默认**」（v3.45.2 实现轮）。下表由「问题 + 建议默认」转正为**已裁决**，
> 结论与落地位置一并登记；本节结论**不再改动**，如需变更另起新稿（`开发守则.md` §2.4 的沿革纪律）。

| # | 问题 | 裁决（原建议默认 → **采纳**） | 落地位置（v3.45.2） |
| --- | --- | --- | --- |
| **Q1** | 是否需要一个**显式的「仅固定规则（零 AI）」入口**（总览维护区，或在总览按钮上加二次选择）？ | **不新增总览按钮**：沿用设定页既有的「🔁 立即固定规则替换」，只在总览按钮 tooltip 里指路 —— **零代码改动、不触碰 `docs/D23` §3.2 的五区契约** | 无需改动（总览按钮 tooltip 与设定页动作沿用现状；`docs/D23` 按钮定位表不变） |
| **Q2** | 单批条数（`NSFW_SOFTEN_BATCH`）与每条投喂上限（`NSFW_TEXT_CAP`）是否调整？ | **维持现状**：真机尚无 AI 侧耗时与 token 的分批样本，改动没有依据 —— `NSFW_SOFTEN_BATCH` 仍 **12**、`NSFW_TEXT_CAP` 仍 **600** | 两个常量值未动；本轮的工作是**让 600 这个上限不再造成正文截断**（见 `数-30` / §8.1），而不是调它 |
| **Q3** | **「弱」级**条目是否也纳入弱化范围？ | **不纳入**：弱级按定义「无露骨内容」，纳入只会白耗 AI 并可能改动本不需改写的文本 | `core/nsfw.js#nsfwScan` 的命中判据未动（仍按识别词条库命中；留档等级只作展示与回填，不作筛选条件） |

---

## 7. 维度归属与优先级

| 项 | 内容 |
| --- | --- |
| **本篇维度** | **跨维**，按 `开发守则.md` §2.5 以**业务**（内容弱化口径）为最高维归档；影响 **应用**（入口与可核对性）/ **数据**（正文改写与留档）/ **技术**（词库、AI 接线、门禁） |
| **影响面排序** | 业务（口径）≻ 应用（用户可见动作与读数）≻ 数据（正文与留档）≻ 技术（词库与接线） |
| **与同维其它稿的关系** | 与 `docs/D23`（总览按钮归属）、`docs/02-数据架构.md`（留档口径）为**引用关系**，不另立口径；`docs/D13`（体积与成本）只管读数口径 |
| **实施规格的排序** | §8 三行按 §2.5 维度序排列：应用 → 数据 → 技术 |
| **不适用项** | `数-30` 触碰「正文完整性」，但**不改数据契约**（字段与语义不变、`DATA_VERSION` 不变）；若加固选择「分段提交」仍需保证合并结果逐字不失真 |

---

## 8. 实施规格

> 三行来自本轮核对的新发现（事实登记 `docs/D17` §1.14 的 U179–U181；执行视图 `docs/D22` §4.8 的 W7）。
> 「落点」写 `文件#符号`；不写绝对行号（`开发守则.md` §2.3 / 判据 C9）。

| 编号 | 维度 | 目标 | 落点 | 前置 | 步骤 | 验收 | 回退 | 台账 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `应-23` | 应用 | 「弱化」跑完后留下**可追溯的只读留痕**（时间 / 提交 / 已弱化 / 丢弃 / 余量），形态与同页「🧠 词条分析」一致 | `core/nsfw.js#runNsfwSoften` · `core/nsfw.js#nsfwSoftenState` · `ui/nsfw.js#nsfwPageHtml` · `adapters/settings.js` | 无 | ① 在 `core/nsfw.js#runNsfwSoften` 收尾处把本次结果（时间、提交数、已弱化、丢弃、无法处理、余量、固定规则处理处数）写入运行时账本，形态对齐 `core/nsfw-analyze.js#nsfwAnalyzeState` 的 `last`；② 在 `core/nsfw.js#nsfwSoftenState` 增 `last` 字段（无记录 = `null`）；③ 在 `ui/nsfw.js#nsfwPageHtml` 的「NSFW弱化」分节加一行只读状态；④ 账本键登记进 `adapters/settings.js`（运行时账本，不进 `core/constants.js#DATA_VERSION` 的数据模型）；⑤ 在 `tests/unit/nsfw-golden.test.js` 增断言：跑一次弱化后 `last` 字段齐全且页面含时间与三项计数 | `node tests/unit/run.js` 新增断言通过；真实点击「🌶 立即弱化」后，设定页「NSFW弱化」分节出现「上次弱化：时间 → 提交 / 已弱化 / 丢弃 / 余量」，刷新页面后仍在（账本落盘） | 去掉状态行渲染与 `last` 字段即回到现状（账本键不影响数据模型，可保留） | U179 |
| `数-30` | 数据 | 弱化**不得**用「只看到前 600 字的改写结果」覆盖整段原文；超限字段改为跳过或分段 | `core/nsfw.js#buildNsfwSoftenPrompt` · `core/nsfw.js#applyNsfwSoftenResult` · `core/nsfw.js#NSFW_TEXT_CAP` | 无（**先只读核实**：真实存档是否存在原文长度 > `core/nsfw.js#NSFW_TEXT_CAP` 的候选字段） | ① 只读核实：对真实存档跑 `FTT.nsfwScan()`，统计 `text` 长度超过投喂上限的条数与维度（只读，不改数据），结论写进本轮批次档；② 在打包侧对超限字段**不入本批**并计入 `oversize`；③ 在落地侧写回前复核实测长度，超限则拒绝写回并计数；④ 回报与通知里如实列出 `oversize` 条数；⑤ 在 `tests/unit/nsfw-golden.test.js` 增断言：构造超限字段 → 正文逐字不变且 `oversize` = 1 | `node tests/unit/run.js` 新增断言通过；构造一条超限字段运行弱化后，该字段正文**逐字不变**，回报含「超长跳过 1 条」；`FTT.nsfwScan()` 命中口径不变 | 去掉打包侧与落地侧两处判据即回到现状（只影响打包与写回，不动词条库与提示词） | U180 |
| `技-36` | 技术 | 转化库**无重复匹配词**，且「词条数 / 转化词数」的关系被单测锁死 | `core/nsfw.js#NSFW_REPLACE_PAIRS` · `tests/unit/nsfw-golden.test.js` | 无 | ① 删除 `core/nsfw.js#NSFW_REPLACE_PAIRS` 中重复的 `'口交'` 键（V1 段与 v3.10.0 段各一条、值相同，保留 V1 段）；② 增断言「`core/nsfw.js#NSFW_RULES` 的 `from` 集合大小 = 数组长度」（无重复）与「`core/nsfw.js#NSFW_KEYWORDS` 的每个词都有转化词」；③ 复跑 `scripts/check-docs-facts.js` 确认 `docs/README.md` §3 的「NSFW 识别词条 / 转化词」行仍与实测一致 | `node tests/unit/run.js` 全绿；`node scripts/check-docs-facts.js` 通过（§3 该行数值不变） | 纯删除 + 断言，撤销即恢复原状 | U181 |

### 8.1 落地状态（v3.45.2 实现轮 · 逐条如实登记）

> 落点以**实际改动的文件**为准；验收证据一律指向可复跑的命令或测试断言；**真机项如实记「未取得」**（本机没有真机存档）。

| 编号 | 状态 | 实际落点 | 验收证据 / 未取得的部分 |
| --- | --- | --- | --- |
| `应-23` | ✅ | `core/nsfw.js`（`setNsfwSoftenHooks` / `logSoftenRun` / `nsfwSoftenLogReset` · `nsfwSoftenState().last` · `runNsfwSoften` 五处收尾记账）· `ui/nsfw.js#nsfwPageHtml`（`data-ftt-nsfw-soften-state` 只读行）· `adapters/settings.js#DEFAULT_SETTINGS.nsfwSoftenLog` · `index.js#wireNsfwSoftenHooks`（装配期接线） | `nsfw-golden.test.js` **W5**（时间 + 提交/已弱化/丢弃 计数 + 页面含时间与三项计数 + **账本真的落到宿主**（模拟 ST 扩展设置）⇒「刷新后仍在」）/ **W6**（忙位被拒**不记账**）；记账口径：**只存计数与时刻、不存正文**，`DATA_VERSION` 不变。**未取得**：真机跑一次后在真实 ST 界面刷新复读（本机无真机） |
| `数-30` | ✅ | `core/nsfw.js#nsfwSoftenPack`（超限**不入本批** + `oversize`）· `#applyNsfwSoftenResult`（写回前**按实测长度复核** + `oversize`）· `#buildNsfwSoftenPrompt`（引用常量，删掉重复字面量 `600`）· `#nsfwSoftenState`（`oversize` 只读计数）· `runNsfwSoften`（回报 / 通知 / 调试日志都列出「超长跳过 N 条」）· `ui/nsfw.js`（扫描行显示「其中超长 N 处」） | `nsfw-golden.test.js` **W2**（打包侧排除 + 只读计数）/ **W3**（**旧清单**也拦得住：正文逐字不变且 `oversize=1`）/ **W4**（端到端：回报与通知都含「超长跳过 1 条」，同批短字段照常弱化）。**反向探针**：拆掉打包侧闸门 → W2/W4 红；拆掉落地侧闸门 → W3 红（文本已留档于批次档）。**未取得**：真机 `FTT.nsfwScan()` 的超限统计（本机无真机存档）——已给出**只读口径**（`nsfwSoftenState().oversize` 与设定页扫描行），真机一步可读 |
| `技-36` | ✅ | `core/nsfw.js#NSFW_REPLACE_PAIRS`（删重复键 `'口交'`）· `tests/unit/nsfw-golden.test.js` **W1** | W1 三条判据：`NSFW_RULES` 的 `from` 无重复 · 每个识别词条都有转化词 · **源码级检查对象字面量无重复键**（重复键在求值后不可见，只能读源码核 —— 这正是 U181 的埋雷形态），并交叉核对「字面量键数 == 求值后键数」。**反向探针**：把 `'口交'` 写回去 → W1 红。`docs/README.md` §3 的 329 / 329 与 `check-docs-facts` 不变 |

> **本版未做（如实登记）**：`NSFW_SOFTEN_BATCH` / `NSFW_TEXT_CAP` 的调整（Q2 裁决：无真机样本，维持现状）· 「弱」级纳入弱化（Q3 裁决：不纳入）·
> 总览新增「仅固定规则」入口（Q1 裁决：不新增）· `NSFW_TEXT_CAP` 的**一词两用**语义拆分（见 `docs/D17` **U214**，本轮只把两处引用统一到常量并加固闸门）。

---

## 附录 · 版本变更史

> 口径（`开发守则.md` §2.7）：**正文只写当前生效的口径**，本节只作追溯；**冲突时以正文为准**（B2/B3）。
> 本节条目为**指向**（原文已在 `CHANGELOG.md` 与 `docs/history/`，不复述）；版本倒序，每版三行（改了什么 / 为什么 / 证据）。

### NSFW 弱化（`core/nsfw.js` · `ui/nsfw.js` · `core/nsfw-level.js` · `core/nsfw-analyze.js`）

**v3.45.2（2026-10-11）**
- **改了什么**：落实本稿 §8 的三行加固 —— ①「弱化」跑完记**运行时账本**（`nsfwSoftenLog`）并在设定页出「上次弱化」只读行（`应-23`）；② **超限字段不入本批**（打包侧）+ **写回前按实测长度复核**（落地侧），两处 `oversize` 如实回报与通知（`数-30`）；③ 删掉 `NSFW_REPLACE_PAIRS` 的重复键 `'口交'` 并加两条守门断言（含**源码级**重复键检查，`技-36`）。顺带把提示词里重复写死的 `600` 改成引用 `NSFW_TEXT_CAP`。
- **为什么**：用户要求「新版本v3.45.2 / 开发W7待开发事项」；三行分别回答「跑完不可追溯」「未复现的正文截断风险」「词库埋雷」。
- **证据**：`CHANGELOG.md` 的 `v3.45.2` 条目 · `docs/history/P10c82-W7NSFW弱化留存与加固落地.md` · `tests/unit/nsfw-golden.test.js` 的 **W1–W6**（含四条反向探针）。

**v3.21.0（2026-10-05）**
- **改了什么**：转化库支持导出 / 导入（合并语义：只新增、不覆盖、不删除）。
- **为什么**：用户要求「NSFW弱化的转化库新增支持导出和导入」。
- **证据**：`CHANGELOG.md` 的 `v3.21.0` 条目 · `docs/history/P10c39-转化库导出导入.md`。

**v3.19.0（2026-10-05）**
- **改了什么**：新增「🧠 词条分析」——抽强留档数据交 AI 找涉敏词与替换词，校验后写入转化库并同批补进识别词条库。
- **为什么**：用户要求「抽取分析被标记为强NSFW的原子数据……最后输出保存到转化库，用于后续弱化NSFW使用」。
- **证据**：`CHANGELOG.md` 的 `v3.19.0` 条目 · `docs/history/P10c36-NSFW词条分析.md`。

**v3.12.0（2026-10-04）**
- **改了什么**：再追加 185 条识别词条（生僻 / 重口味，含逐条转化词），弱级信号词同步扩到 78 条。
- **为什么**：用户要求「NSFW弱化新增一些生僻词汇，尤其是涉及到重口味的内容」。
- **证据**：`CHANGELOG.md` 的 `v3.12.0` 条目 · `docs/history/P10c25-NSFW生僻与重口味词条扩充.md`。

**v3.10.0（2026-09-30）**
- **改了什么**：设定页改名「NSFW弱化」；识别词条库与转化库追加 81 条；弱级信号词扩到 71 条。
- **为什么**：用户要求「设定-内容弱化名称改为"NSFW弱化"」+「补充新的词条进去，扩大NSFW识别范围」。
- **证据**：`CHANGELOG.md` 的 `v3.10.0` 条目 · `docs/history/P10c18-NSFW弱化改名与词条库扩充.md`。

**v3.8.0（2026-09-30）**
- **改了什么**：原子数据新增 `nsfw` 等级字段（无 / 弱 / 强，只升不降、永久留档）；弱化两条路径从此只写文本、不改标签；修掉 V1「状态记录整维未参与扫描」的移植缺陷（**有意偏离 V1**）。
- **为什么**：用户要求「原子数据新增字段……分等级……当弱化 NSFW 功能修复后，NSFW 标签不会改变，用于永久性留档」。
- **证据**：`CHANGELOG.md` 的 `v3.8.0` 条目 · `docs/history/P10c16-原子数据NSFW等级留档.md`。

**v2.13.0（2026-09-26）**
- **改了什么**：NSFW 弱化功能建立 —— 识别词条库 + 固定规则转化库 + 零 AI 机械替换 + AI 弱化（提示词 / 强校验落地 / 忙位门）+ 分析侧开关 + 设定页与总览入口。
- **为什么**：用户要求「新增功能用于弱化 NSFW 的内容，如果发现有相关内容，用更柔性的话术替代，不露骨」+ 总览修复按钮右侧新增弱化按钮。
- **证据**：`CHANGELOG.md` 的 `v2.13.0` 条目 · `docs/history/P8m-B8-4内容弱化NSFW.md`。

**留档展示的后续改动（同族，供追溯）**
- `docs/history/P10c17-各分类NSFW标签提示.md`（各分类标签提示）· `docs/history/P10c22-NSFW标签末行化.md`（标签移到末行、释义单一来源）。
