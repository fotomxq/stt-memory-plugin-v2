# FTT记忆组件 V2 · 版本历史

> 本文件为 V2（SillyTavern 原生扩展）的版本史；V1（酒馆助手 iframe 脚本）版本史见 V1 仓库 `CHANGELOG.md`。
> 版本号与 git tag 同名（`vX.Y.Z`），由 `scripts/check-version-sync.js` 校验。

## v2.14.0（2026-09-26）· B8-5 遗忘域（记忆遗忘 + 通用遗忘清扫 + 设定页控件补齐）

**本版（B8-5）**：
1. **内核**（新增 `core/forget.js`，取自 V1 `09-AI摘要与楼层处理.js` 遗忘族）：
   ① 记忆遗忘机制（v1.63）：`memoryForgetAvg` / `memoryForgetScore`（**只按剧情日期**老化 × 低重要度加速缺口封顶 ×1.5，
   `imp ≥ 均值` 免疫）/ `memoryForgetExpired` / `scheduleMemoryForget`（3s 防抖，已接入 `mergeDelta` 记忆写入分支）/
   `runMemoryForget`（触发比例 + **不跌破保底** + 移除记 id 墓碑）；
   ② 通用遗忘清扫（v1.153）：`LOWUSE_FORGET_DIMS` 六维 + `lowUseSceneIsLeaf` + `lowUseSweepGate`/`lowUseSweepMark`（40 楼冷却闸门）+
   `sweepLowUseForget`（条目数/平均调用门槛 + 长期未现门槛 + 重要度保护 + 名册·档案只删零调用 + 每维度每轮 1 条 + 不跌破保底 + 墓碑）；
   ③ 诊断入口：`forgetState` / `forgetRunAll`（一次跑齐状态衰退 / 记忆遗忘 / 通用清扫 / 库存裁剪）/ `cancelForgetTimers`；
2. **`core/ingest.js`**：导出遗忘域共用助手（`storeMinFor`/`storeCapFor`/`enforceDimCaps`/`repairClampNum`/`memoryImportance`/`calcTimeDecay`/`STORE_LIMITS`/`DIM_CAP_KEYS`）；
   **修正 `calcTimeDecay`**：V1 的 `item <= 0` 会把 **1970 年前的剧情日期**（负毫秒）当成「无时间信息」→ 状态衰退 / 记忆遗忘 /
   平行事件衰退对 19~20 世纪剧情**整体失效**；V2 按 V1 注释语义（「无时间信息视为新」）只判 `!Number.isFinite(item)`（**有意偏差**，见 `docs/P8n` §2）；
3. **设定页控件补齐**：依 V1 源码顺序补入 B4 自动提取遗漏的 **20 个 `switchField` 开关**
   （feed 3 / analyze 2 / extract 6 / forget 3 / prompts 1 / parallels 2 / rumors 2 / debug 1），并把受影响的 8 个页面控件顺序对齐 V1；
   设定页控件 **127 → 147**；
4. **界面**（新增 `ui/forget.js`）：遗忘页改为 V1 **五分节布局**（状态记录衰退 / 记忆遗忘机制 / 存储保底·上限 / 通用遗忘清扫 /
   「平行事件衰退已移至平行页」提示）+ 一行 V2 只读诊断（当前条数 / 上限 / 保底 / 清扫冷却）；
5. **接线**：`FTT.*` 新增 6 个遗忘域入口（`forgetState`/`forgetRunAll`/`stateDecay`/`memoryForget`/`lowUseSweep`/`lowUseGate`）；
   `teardown` 清理遗忘定时器；
6. **黄金样本 8 组（oracle = 真实 V1 插件 v1.206）**：记忆遗忘打分、`runMemoryForget`（移除 + 墓碑 + 保底）、关闭/无时钟短路、
   场景叶子判定、清扫闸门三态、`sweepLowUseForget` 全流程、三类保护、`enforceDimCaps`。

**验证**：`tests/unit/forget-golden.test.js` **17 项** + 冒烟 **S1–S4**；门禁全绿：单元 **36 文件 / 498 断言**、
冒烟 **85 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**有意偏差（详见 `docs/P8n-B8-5遗忘域.md` §2）**：`calcTimeDecay` 对 1970 前剧情日期不再视为「无时间信息」
（V1 下该批数据完全不遗忘，黄金样本已记录 V1 的原值以便追溯）；页面新增只读诊断行；遗忘仍为**自动行为**
（V1 该页无手动按钮），另给 `FTT.forgetRunAll()` 诊断入口。

## v2.13.0（2026-09-26）· B8-4 内容弱化（NSFW）（词条库 + 固定规则转化库 + AI 弱化）

**本版（B8-4）**：
1. **内核**（新增 `core/nsfw.js`，取自 V1 `09-AI摘要与楼层处理.js` NSFW 族）：
   ① 识别词条库（63 条内置 + `cfg.nsfwKeywords` 自定义增/改/删/恢复内置，按「生效列表索引」定位）；
   ② 固定规则转化库（63 条与识别词条一一对应 + `cfg.nsfwRules` 自定义；`cfg.nsfwReplaceAuto` 默认开）；
   ③ `nsfwApplyRules`（**对原文单遍匹配 + 区间占位**：不链式二次转换、与规则顺序无关；重叠按长词优先；
   英文 `\b词\w*` + 误伤名单 cumulative/circumstance 一类普通词不改写不计命中）+ `nsfwKeywordHits`（同一判定口径 + 签名缓存预筛）；
   ④ `nsfwScan` / `nsfwSoftenPack`（12 维字段白名单 + 嵌套/数组展开；已总结隐藏的情节不参与；命中多者优先、单批 12 条）；
   ⑤ `nsfwFixedReplace`（零 AI 落地 + **镜像字段 text↔content 同步** + 刷新 `updatedAt`）；
   ⑥ `buildNsfwSoftenPrompt` / `applyNsfwSoftenResult`（**强校验**：结果不得仍含关键词、长度不得膨胀、只写命中字段）/
   `runNsfwSoften`（先固定规则替换，剩余交 AI 二次弱化；忙位互斥；如实回报含 `fixed` 阶段处理量）；
   ⑦ 分析侧开关 `nsfwSoftenEnabledOn` / `nsfwSoftenRuleText`（供 `core/prompt.js#buildSummaryPrompt` 追加规则）；
2. **共用 AI 钩子**（新增 `core/ai-hooks.js`）：`callAi` / `feedText` / `busy` 三钩子统一持有，
   `clock-ai.js` 的 `setClockAiHooks` 改为委托别名（B8-3 的调用方与测试不受影响）；
3. **界面**（新增 `ui/nsfw.js`）：设定「内容弱化」页 V1 四节（内容弱化 / 固定规则替换 / 转化库编辑器 / 识别词条库编辑器）
   + 状态行 + **10 个 V1 同名动作**（`nsfwSoften` `nsfwRuleApply` `nsfwKwAdd|Save|Del|Reset` `nsfwRuleAdd|Save|Del|Reset`，经面板统一分发）；
   总览工具行新增「🌶 弱化NSFW（N）」按钮与分析侧开关状态行（逐维度命中数）；
4. **接线**：`FTT.*` 新增 15 个内容弱化调试入口（`nsfwState`/`nsfwSoften`/`nsfwFixed`/`nsfwScan`/`nsfwHits`/`nsfwApply`/库增删改等）；
5. **黄金样本 14 组（oracle = 真实 V1 插件 v1.206 + `stubFetch` 固定 AI 返回）**：库规模与内容、替换 6 组文本、命中 6 组、
   单遍不链式 + 长词优先、词条库 6 步与转化库 5 步操作序列、扫描（隐藏情节排除）、打包、提示词逐字符、固定规则落地（含镜像同步与状态）、
   AI 结果应用（合格/无变化/仍含关键词/过长/未知编号/无法处理）、两条端到端路径（固定规则先跑 / AI 二次弱化，含状态改写）、状态摘要。

**验证**：`tests/unit/nsfw-golden.test.js` **22 项** + 冒烟 **R1–R5**；门禁全绿：单元 **35 文件 / 481 断言**、
冒烟 **81 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**偏差（详见 `docs/P8m-B8-4内容弱化NSFW.md` §2）**：AI 通道走共用注入钩子（ST `generateRaw`）；V1 的任务管线 UI（`pipeStart/…`/`abortTick`）
未移植，改为长任务在途**直接拒绝**；库条目动作优先取 payload，回退面板 DOM。

## v2.12.0（2026-09-26）· B8-3 时钟域 AI 管线（AI 捕捉正则 + AI 结合正文修复日期时间）

**本版（B8-3）**：
1. **内核**（新增 `core/clock-ai.js`，取自 V1 `09-AI摘要与楼层处理.js`）：
   ① 「AI 捕捉正文 → 生成正则」：取最近 N 楼投喂文本 → AI 产出 `{日期正则,时间正则,地点正则,说明}` →
   **三重校验**（可编译 / 不匹配空串 / 样本确有命中）→ 写入 `cfg.clockDateRegex/clockTimeRegex/clockLocationRegex` →
   保存配置 → **用样本试算**并回报「已应用/未采用 + 试算结果」；
   ② 「AI 结合正文修复日期时间」：`clockRepairPack`（上限 `cfg.clockRepairBatch`，默认 20/硬上限 200 + 截断数）、
   `buildClockRepairPrompt`（【时间锚点】+【近期正文】+【待修复清单】+ 输出契约）、`applyClockRepairResult`
   （**只允许改 日期/时间**，逐条过 `clockPatrolSafeDate` 安全闸门；不合格丢弃、清除清空、无法判定如实计数）、
   `runClockRepair`（无异常直接回报；**无可信锚点 → 拒绝执行且不调用 AI**；长任务在途拒绝；AI 无返回不改数据）；
2. **`host/floors.js` 补投喂文本**：`buildFeedFloorText(maxFloors)`、`buildFeedFloorTextRange(maxFloors, endFloor, opts)`（V1 同款，修复域与后续批次共用）；
3. **接线**：`index.js` 注入 AI 钩子（`callAi` 走 ST `generateRaw`、`feedText` 走 `host/floors`、`busy` 走 `extractBusy`）
   —— 内核不直连网络也不读宿主聊天；`FTT.*` 新增 `clockRegexGen` / `clockRepair` / `clockRepairPack`；
4. **界面**：基础页两个 V1 同名按钮（`clockRegexGen` AI 捕捉正文 → 生成正则、`clockRepair` AI 结合正文修复日期时间）
   取代原「属后续批次（B8-2）」占位说明；动作进 `CLOCK_ACTIONS` 由面板统一分发并回填提示；
5. **黄金样本 8 组（oracle = 真实 V1 插件 v1.206 + `stubFetch` 固定 AI 返回）**：正则三重校验 7 例、捕捉正则成功/失败两例
   （applied/skipped/hits/probe/regexes 全等）、异常清单打包、修复提示词（system+user 逐字符）、应用结果（修正 2/清空 1/丢弃 2/无法判定 1
   + 状态逐条）、端到端修复（含状态改写）、无可信锚点拒绝。

**验证**：`tests/unit/clock-ai-golden.test.js` **17 项** + 冒烟 **Q1–Q4**；门禁全绿：单元 **34 文件 / 459 断言**、
冒烟 **76 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**偏差（详见 `docs/P8l-B8-3时钟域AI管线.md` §2）**：AI 通道改为宿主 `generateRaw`（V1 自建 OpenAI 兼容请求 + 队列 + 可中断）；
任务占用以「直接拒绝」替代 V1 的管线 UI 提示；提示词模板来源 V2 用内置 `PROMPT_TEMPLATES_V2`。

## v2.11.2（2026-09-26）· 注释与文档澄清（行为与 v2.11.1 完全一致）

**本版仅**更新 `host/update.js` 文件头注释与 `docs/更新检查机制.md` 中的通道顺序描述（v2.11.1 已改为 HTTP 优先、
宿主 Git 端点默认关），使代码注释与文档不再出现「首选 ST 原生端点」的旧表述。**无任何行为变化**，
已装 v2.11.1 的用户无需重新安装（两者行为相同）。

## v2.11.1（2026-09-26）· 修复：无 git 宿主上的「后端错误：Git handshake failed」弹窗

**问题**（用户报告）：安装后宿主弹出「后端错误 / Failed to get extension version: Internal error: Git handshake failed:
An IO error occurred when talking to the server」；其它插件不触发。

**根因（两条，均已修）**：
1. `manifest.json` 的 `auto_update: true` 会让**酒馆自身**在加载期对第三方扩展做 Git 版本校验
   （`POST /api/extensions/version` → 服务端 `git fetch`）。在没有 git 能力 / 到 GitHub 不通的宿主（如 TauriTavern 原生移植）上
   该请求必然失败，宿主把它当「后端错误」弹窗；其它插件未开启该项，故只有本插件触发；
2. 本插件的「首次启动自动检查」会**主动**请求同一个端点（端点优先）——同样触发后端 git handshake。

**修复**：
1. `manifest.json` → `auto_update: false`（本插件自带更新检查，不依赖酒馆代做 git 检查）；
2. 更新检查改为**默认 HTTP 优先**：只用 GitHub raw 的 `manifest.json` + `CHANGELOG.md` 判定版本与更新要点；
   新增设置项 `useStGitEndpoint`（**默认 false**）—— 只有显式开启时才调用宿主 Git 端点（`/api/extensions/version`）；
3. 「立即更新（ST）」按钮在开关关闭时**不发起任何请求**，只回填引导文案（提示可开启开关，或按仓库说明手动更新：源码即发布物）；
4. 抽屉面板与浮层设定都新增「使用宿主 Git 更新端点（默认关）」开关（含原因说明）；浮层里更新相关键改写入**适配层设置**
   （此前误写内核 cfg，导致「启动时自动检查更新」等开关在浮层里改了不生效）；
5. 状态摘要新增 `stEndpoint`（on/off）便于诊断「为何没有 git 校验」。

**验证**：门禁全绿：单元 **33 文件 / 442 断言**（新增回归断言：默认路径 **0 次**端点请求、默认「立即更新」**0 次**请求且给引导、
开启后端点优先与更新端点可用）、冒烟 **72 项**（E2/E3/E6 改写为默认路径断言 + 新增 E6b 开启后调用）；文档 `docs/更新检查机制.md` §2.1 记录根因与修复。

## v2.11.0（2026-09-26）· B8-2 剧情时钟自动提取（正文头结构 + 多源择优 + 自动降级）

**本版（B8-2）**：
1. **内核**（新增 `core/clock-extract.js`，取自 V1 `09-AI摘要与楼层处理.js` 时钟提取族）：
   ① `extractClockFromHeader`（v1.188 正文头结构）：`▷日期（纪年）·季节(场景描述)` / `▷地点-路径` / `▶第 N 天 起止时间(状态)`
   → 日期 / 纪年 / 季节 / 场景描述 / 地点 / 剧情第 N 天 / 时间区间 / 状态说明；
   ② `extractClockFromText`：多源择优（**正文头 > 日期直取/时刻/中文点数/时段词 > 自定义正则 > 标记式带值 > 相对日期推进**），
   日期候选统一走 `CLOCK_DATE_SCAN`（「公元…」/中文数字/月日无年/公元前），各字段取最后一次命中；
   ③ `resolveStoryClock`（v1.173~v1.193 统一解析）：手工锁定优先 → 取文（显式正文 → 最新 AI 正文 → 最近 N 楼窗口）→
   日期候选（正则 / 最新情节 / 原子降级 / 沿用旧值）取最大 → **日期异常自动降级**（invalid/jump/backward 或强制降级开关）→
   时间/地点跟随胜出侧、降级补「最新场景」→ 正文头附加字段与「第 N 天」纪元换算 → 在场只认最新正文/最新情节（不跨楼层扩散）；
   ④ `latestSceneLocation` / `resolvePresentNames` / `storyClockReference`；
   ⑤ `clockAutoExtractOnce` / `scheduleClockExtract`：落盘 `state.state.*` + `clockSrc` 可解释来源 + 在场 + 快照 seen 标记，
   日期推进顺带调度状态记录衰退（`core/ingest.js` 导出 `scheduleStateDecay`）；
2. **`core/clock.js` 补全**：`clockAddDays`（先建基准日再 `setUTCFullYear`，避开「年份 <100 被映射到 19xx」，负年份安全）、
   导出 `clockMatchNotInline`（长日期尾部命中判据）；
3. **接线**：`index.js` 注入取文钩子（最新 AI 正文 + 最近楼层窗口，内核不直读聊天），消息/楼层事件触发 1.8s 防抖自动提取；
   `FTT.*` 新增 7 个调试入口（`clockResolve` / `clockExtractText` / `clockHeader` / `clockExtractOnce` / `clockExtractState` /
   `clockExtractSchedule` / `clockScene`）；总览「🕒 时钟来源」与正文头附加字段（时间区间/季节/纪年/剧情天数/场景描述）随之显示；
4. **黄金样本 27 例（oracle = 真实 V1 插件 v1.206）**：正文头 3 例、文本提取 9 例、统一解析 10 例、场景 2 例、在场 3 例，逐例一致。

**验证**：`tests/unit/clock-extract-golden.test.js` **12 项** + 冒烟 **P1–P5**；门禁全绿：单元 **33 文件 / 439 断言**、
冒烟 **71 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**偏差（详见 `docs/P8k-B8-2剧情时钟自动提取.md` §2）**：取文改经注入钩子（保留内核零宿主依赖）；提示/调度/重绘走注入钩子与 UI 层；
`clockRegexGen` / `clockRepair` 两条 AI 管线属 B8-3（基础页明示标注，不放假按钮）。

## v2.10.0（2026-09-26）· B8-1 剧情时钟域（手工锚点 + 零 AI 时间巡检 + 基础页对齐）

**本版（B8-1）**：
1. **内核**（新增 `core/clock-patrol.js`，取自 V1 `09-AI摘要与楼层处理.js` 时钟族）：
   ① 手工强制改写锚点（v1.186）：`clockManualRaw/State`、`parseClockManualInput`（日期宽松解析；**年份未知时只用库内可用年份，绝不用现实年份兜底**）、
   `setClockManual`（写 `state.state.clockManual` + 覆盖日期/时间/地点 + `clockSrc` manual 标记）、`clearClockManual`；
   ② 可信锚点（v1.187）：`clockPatrolMajority`（年份多数派）+ `clockPatrolAnchorInfo`（**手工 > 当前时钟 > 多数派 > 一致年份**，不确定即 `usable=false`）；
   ③ 零 AI 巡检（v1.184~v1.193）：`clockPatrolSafeDate`（唯一写回闸门）、`clockPatrolScan`、`clockPatrolRepairItem`
   （按内容重解析 → 保留月日换年份 → **仅「格式非法」才清空**）、`runClockPatrolRepair`（**写回前先建全量快照**；自动路径默认只统计；
   自动路径遇「锚点与库内多数年份冲突」只统计，手动 `force` 才按锚点校正）、`clockPatrolState` / `clockPatrolAutoOnce`；
2. **`core/clock.js` 补全**：`clockNormTime`（时刻/时段归一）、`CLOCK_DAY_PARTS`、`clockDateAnomaly`（invalid/jump/backward）、`clockReplaceYear`；
3. **界面**（新增 `ui/clock.js` + 基础页重做）：总览时钟区按 V1 同序（日期「纪年·季节」+ 🔒手工徽标 / 时间区间 / 地点 / 剧情第 N 天 /
   缺值「参考最近记忆」行 / 手工改写工具行与三项输入面板 / 在场角色 / 🕒 时钟来源可解释行 / 🩺 时间巡检状态行 + 手动巡检按钮）；
   动作名与 V1 逐字一致（`clockEdit` `clockEditCancel` `clockManualSave` `clockManualClear` `clockPatrol`）；
   基础页改为 V1 **五分节**布局并补齐 9 项控件（`enabled` / `autoRepair` / `clockExtractEnabled` / `clockRegexPreset` / `clockRelative` /
   `clockForceDegrade` / `clockAutoPatrol` / `clockPatrolAutoFix` / `uiEffects`），实现 V1 `swForce` 强制开关语义
   （「及时分析」开启 → 自动摘取/自动摘要/注入当前提示词 强制开启且禁用）；设定页控件 **118 → 127**（base 12 → 21）；
4. **接线**：`index.js` 载入后 2.6s 自动巡检一次（`cfg.clockAutoPatrol`，默认只统计）；`FTT.*` 新增 10 个时钟调试入口；
5. **黄金样本 19（oracle = 真实 V1 插件 v1.206）**：`clockNormTime`（14 组）/ `clockDateAnomaly`（5 组）/ `clockReplaceYear`（4 组）/
   `clockPatrolMajority` / `clockPatrolAnchorInfo`（五种来源）/ `parseClockManualInput`（5 组 + 无年份拒绝）/
   `setClockManual` 与 `clearClockManual` 状态效应 / `clockPatrolScan` 逐条 findings / `runClockPatrolRepair`（只统计 · 手动修复 · 自动冲突）逐项一致。

**验证**：`tests/unit/clock-patrol-golden.test.js` **23 项** + 冒烟 **O1–O5**；门禁全绿：单元 **32 文件 / 427 断言**、
冒烟 **66 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**偏差（详见 `docs/P8j-B8-1时钟巡检与手工锚点.md` §3）**：AI 两条管线（`clockRegexGen` / `clockRepair`）属 B8-2，
基础页以「属后续批次」明示标注、不放假按钮；V1 基础页的「显示界面开关（buttonLocation*）」由 V2 附加设定的入口开关承担，不重复渲染。

## v2.9.0（2026-09-26）· B7-2 跨端同步与镜像（文件通道 + 清单预判 + 快照文件 + 同步日志 + 流量门控）

**本版（B7-2）**：
1. **内核移植**（新增 `core/cross-sync.js`，取自 V1 `06-存储后端与三型归类.js`）：
   `dataAggHash` / `diffAtomData` / `mergeDataObjects`（原子级双向合并 + 墓碑过滤 + 已处理楼层并集 + 内容哈希去重 + 传言字段级并集）/
   `mergeSnapshotStores`（快照链并集重建）/ `snapshotSigOf` / `snapIndexFrom` / `mirrorPushSig` / `atomEntryCount`；
   新增 `core/sync-log.js`：`syncLogRecordKey` / `syncLogMerge`（服务端交叉并集合并）/ `syncLogPushRecord`（环形 30 条）/
   `syncLogStat` / `syncLogSource`（设备·浏览器短码）；
2. **适配层**（新增 `adapters/sync.js`）：记忆文件（主 + `-bak` 备份）读写、**清单(meta)预判**（对端未变 → 跳过大文件下载）、
   **快照链独立文件**上传/并集合并（承载 `snapStore` + `snapFp`）、`refreshFromServer`（刷新状态：取服务端真值 → 全部候选源并集合并 → 回推）、
   `crossSyncManual`（立即同步：超集整体替换 / 分歧原子融合，收尾必写备份 + 快照）、`scheduleStorageSync`（保存后 3s 防抖镜像）、
   两级流量门控（楼层哈希差异 + 镜像推送签名）、`storageVerify`（以最新有效源重写各镜像）、`storageBootstrap`（启动一次对账）；
   读缓存 + 单飞 + 服务端日志通道失败静默降级；
3. **接线**：`store.saveStateNow()` 保存后按 `cfg.storage.syncOnSave` 调度镜像；`index.js` 启动即异步对账、
   接入内核延迟调度钩子 `timerHooks`（**修掉 B7-1 遗留缺陷：此前未接线 → 增量快照在真实环境永不触发**）、
   `FTT.*` 新增 13 个同步调试入口；`teardown` 清理同步定时器；
4. **界面**（新增 `ui/sync.js` + 存储页重做）：V1 同款分节（记忆文件 / 原生存储 / 本机缓冲 / 一致性 / 世界书存储 / 状态与操作 / 同步日志）+
   V1 同名 5 个动作（`storageStatusRefresh` `storageSync` `storageVerify` `syncLogRefresh` `syncLogClear`）+
   同步日志渲染（本地 → 对端 → 同步后 条数/大小 + 哈希 + 本端源头）；存储页控件表补齐 13 项（墓碑天数、原生通道、
   世界书 8 项、流量门控 `syncTrafficGuard` 顶层键），设定页控件 **105 → 118**；
5. **黄金样本 13（oracle = 真实 V1 插件 v1.206）**：`dataAggHash` / `diffAtomData` / `mergeDataObjects`（统计 + 结构指纹 + 合并后聚合哈希）/
   `mergeSnapshotStores` / `snapshotIndexFrom` / `syncLogRecordKey` / `syncLogMerge` / `syncLogStat` / `syncLogSource` 逐项一致。

**验证**：`tests/unit/cross-sync-golden.test.js` **15 项** + `tests/unit/sync-adapter.test.js` **27 项**（文件通道 / 清单预判 /
快照并集 / 刷新 / 立即同步四态 / 门控四态 / 同步日志三态 / 校验修复 / 存储页与面板动作）+ 冒烟 **N1–N6**；
门禁全绿：单元 **31 文件 / 404 断言**、冒烟 **61 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。

**偏差（详见 `docs/P8i-B7-2跨端同步.md` §2）**：通道收敛为两型（无 V1 多后端治理视图与 TauriTavern 原生存储）；
世界书镜像属 B8（仅保留同名配置键）；文件名为 `ftt2-*` 明文 `.json` 且暂不瘦身/gzip（B9）；
`latestFloorFingerprint` 按 V1 注释语义修正（V1 把正文传给只收楼层号的函数）；同步不移植「占用管线」，改为长任务在途时拒绝/推迟。

## v2.8.0（2026-09-25）· B7-1 快照链（内核移植 + 界面 + 真实 V1 黄金样本）

**本版（B7-1）**：
1. **内核逐字移植**（新增 `core/snapshots.js`，259 行取自 V1 `05-记忆状态与存储抽象.js`）：
   `atomSerialize` / `snapFpFromCurrent` / `snapshotMergeSnap` / `snapshotConsolidate`（多根合并 + 超上限把最早 15 个增量并入根）/
   `snapshotCreateFull`（无原子不建空根）/ `snapshotCreateIncr`（只记变更 + `deleted` 删除账本）/
   `snapshotRestore`（时间线并集重建 + **删除账本按序生效**，回滚不误记删除）/ `snapshotClear` / `snapshotStats` / `scheduleSnapshotIncr`（400ms 防抖）；
   三处适配并在文件头写明：落盘走 `saveState()` 注入钩子、提示走 `notifyHooks`、延迟调度走 `timerHooks`；哈希助手复用 `core/merge.js`；
2. **保存流水线接线**（V1 `saveState()` 收尾口径）：`store.saveStateNow()` 之后 `maintainSnapshots()` —— 无原子跳过 / 无快照建根 / 否则调度增量；
3. **界面**（数据管理页「🧬 快照链」）：统计条 + 快照列表（类型·id·时间·条目数·删除账本·基线）+ 立即建根 / 整理 / 清空 / 逐条还原 / 删除；
   动作名与 V1 一致（`snapCreate`/`snapRestore`/`snapDelete`/`snapConsolidate`/`snapshotClear`）；
4. **黄金样本 12（oracle = 真实 V1 插件）**：固定序列（建根 → 新增 → 删除）下
   **快照结构指纹逐项一致**、**还原到根的集合一致**（`["a1","a2"]`）、**统计一致**（`{total:3,root:1,incr:2,covered:3,deleted:1}`）。

**验证**：新增 `tests/unit/snapshot-golden.test.js` **8 项**（指纹一致 / 统计一致 / 还原到根 / 还原到增量不复活已删 / 整理（自带+强制超限）/
清空与删除不动记忆本体 / 保存流水线接线 / 数据管理页接线）。门禁：单元 **29 文件 / 361 断言**、冒烟 **55 项**、五道门禁全绿；
文档 `docs/P8h-B7快照链.md`，`docs/P8-功能对齐总表.md` B7 拆为 B7-1 ✅ / B7-2 待做。

## v2.7.0（2026-09-24）· B6 提示词模板编辑（V1 迁移链 + 分组编辑器）

**本版（B6）**：
1. **迁移链逐字移植**（新增 `core/prompt-migrate.js`，纯逻辑零宿主依赖）：`promptSig`（FNV-1a→hex+长度）、
   `migratePromptTemplates`（只刷新「缺失/空 / 签名命中 `PROMPT_LEGACY_SIGS` / 等于新默认」，**用户自定义一律保留**）、
   `migrateArmorPreset`（v1.179 旧键迁移，用户文本优先、旧键一律删除、幂等）；
2. **接入载入层**：`adapters/config-store.js#loadKernelCfg()` 载入时先跑破甲迁移再跑模板升级（与 V1 `loadCfg` 同序），
   变更随合并结果落盘；`lastLoadInfo().prompt` 暴露迁移摘要；
3. **分组编辑器**（新增 `ui/prompts.js`）：按 `PROMPT_GROUPS` 渲染 **33 条 / 5 组**；每条含键名·组别·字数·**签名**·「已自定义/内置默认」
   与「保存 / 恢复默认」；顶部统计条（含**未分组键告警**）与上次迁移摘要；每组「本组恢复默认」；「全部恢复默认」；
   保留 ⓪ 组的 `armorPresetEnabled` 开关（走通用 `data-ftt-cfg` 写回）；**破甲预设导入**（粘贴 → 采用为 `armorPreset`）；
4. 设定 → 提示词页由占位说明替换为上述编辑器；写回唯一入口 `applyPrompt()` → `saveKernelCfg()`（ST 配置持久化）。

**验证**：新增 `tests/unit/prompts.test.js` **8 项**（`promptSig` 逐字含空串/中文、模板与分组统计、迁移保留自定义、破甲迁移幂等、
载入接线与 `lastLoadInfo`、写回与三种恢复、页面渲染、面板接线）。门禁：单元 **28 文件 / 353 断言**、冒烟 **55 项**、五道门禁全绿；
文档 `docs/P8g-B6提示词编辑.md`，`docs/P8-功能对齐总表.md` B6 打勾。

## v2.6.0（2026-09-24）· B5 关系表与注入自查

**本版（B5）**：
1. **关系表**（`ui/rel-table.js`）：记忆/计划/悬念/平行四个维度的「谁知道 / 谁相关」总览与编辑 ——
   行字段与类名同 V1（角色 / 知情方式 / 公共 / 来源 / 日期 / 备注），保存走 **V1 `relSaveBox` 的 `{ replace: true }` 口径**，
   单行删除仅改草稿、保存时生效；**清空该条目关联**走 V1 `dropRelLinks`（清空 + 留墓碑）；**清扫孤儿关联**（`sweepOrphanRelLinks`）；
   **清除「推定」关联**（留墓碑，不动人工/AI 行）；**按角色筛选**（按 V1 方式优先级排序）；
   编辑器内追加该条目的关系表；未保存改动以草稿承载并显示「（有未保存改动）」。
2. **注入自查**（`ui/inject-check.js`）：与真实注入**同一代码路径**（`buildMemoryBodyForInject` 的 `diagnose` 模式）、
   只读零 AI 不动 uses；给出预算明细、**【注入约束】段原文**（含压缩/上限/位置）、逐维已召回计数、
   **未进注入的非公共信息**及原因（关键词未命中 / 候选未入选）；工具行同 V1（🔄 刷新 / 🔑 按最近关键词 / 🧭 按本地召回）。
3. **面板接线**：记忆页三子标签（📚 列表 / 🔗 关系表 / 🧷 约束自查）、计划与平行页两子标签；关系表子页含维度关联总览与跳转编辑。
4. **顺带修掉 3 个真实缺陷**（由新测试暴露）：`upsertRelLinks` 默认「合并」语义会让 UI 删除的行永不消失（改用 `replace`）；
   `relSweep`/`relDropInferred` 被放在维度校验之后导致 `dim-not-supported`（改为优先处理）；
   `relClearEntry` 用空数组合并等于什么都没做且不留墓碑（改用 `dropRelLinks`）。为复用 V1 实现，`core/entries.js` 增补导出 `dropRelLinks`。

**验证**：新增 `tests/unit/rel-inject.test.js` **8 项**；门禁：单元 **27 文件 / 345 断言**、冒烟 **55 项**、五道门禁全绿；
文档 `docs/P8f-B5关系表与注入自查.md`，`docs/P8-功能对齐总表.md` B5 打勾。

## v2.5.0（2026-09-24）· B4 设定 14 组子页（首批：框架 + 105 个配置控件）

**对齐方式**：不手写页面 —— 从 V1 `src/modules/13-UI-设置与存储开关.js` **自动提取**控件表
（`subTabs` 14 组 + 各页 `f/swT/swForce/stSwitch` 调用），得到 **105 个控件**并逐页统计：
基础 12 / 投喂范围 12 / 分析记忆 3 / 提取记忆 18 / 遗忘 25 / 传言 12 / 平行 5 / 提示词 5 / 存储 13（含 `storage.*` 13 项）。
生成结果内嵌于 `ui/settings-pages.js`，**键与标签不经人手维护**。

**本批交付**：
1. 设定分页改为 **V1 同名同序的 14 组子页**（`.ftt-subtab` 子标签条 + 当前页内容 + 页/控件计数提示）；
2. **105 项全部可渲染与写回**：开关用 V1 结构（`.ftt-switch + .ftt-slider`，附「已开启/已关闭」），文本/数字 `input`、下拉 `select`、正文域 `textarea`；
   写回唯一入口 `applySettingsControl()`（支持 `storage.*` 与 `a.b` 嵌套）→ `saveKernelCfg()`；
3. **数据管理页动作**：导出 JSON（`exportStateJson`，含格式/版本/作用域/时间戳，尝试写剪贴板）、导入 JSON
   （`importStateJson`：按 id **append-only** 合并，同 id 以当前为准，绝不删除现有数据）、清除已处理记录（复用 B3）；
4. **V2 附加设定块**：更新检查（自动开关 + 仓库 + 手动检查）、V1 数据导入（干跑/写入）、14 维启用勾选 —— 避免 V1 页面替换掉 V2 独有能力；
5. 依赖未移植内核的页面部分（提示词模板编辑 / 存储探测与同步 / 内容弱化库 / 调试面板 / API）**在页内明确标注待 B6–B9，不使用假实现**。

**验证**：新增 `tests/unit/settings-pages.test.js` **6 项**（页序与标签逐字、控件总数与逐页数量、**105 键全部可在配置里解析**、
渲染结构、写回与持久化、面板接线与导出导入钩子）；`panel.test.js` A3、`bootstrap.test.js` B10 改为新语义。
门禁：单元 **26 文件 / 337 断言**、冒烟 **55 项**、五道门禁全绿；文档 `docs/P8e-B4设定子页.md`。

## v2.4.0（2026-09-24）· B3 提取与楼层管理（分段批量摘要 / 中断 / 清台账）

**本版（B3）**：
1. **分段批量摘要**（V1 `runAutoSummary`）：`runAutoSummary({silent, chunkSize})` —— 按 `cfg.summaryChunkSize`（默认 10）
   切段，**一段 = 一次 AI 调用**（段文本 = 该段楼层行经投喂正则过滤），随后 `mergeDelta(delta, 段范围)` 并 `recordProcessedFloors(段起, 段止)`；
2. **手动/静默两种模式**：手动 = 最近 `cfg.feedFloors` 楼（跳过最近 2 楼半成品，及时分析下不跳过）；静默 = 全部未摘要 AI 楼，整段已处理则跳过（零 AI 调用）；
3. **中断（协作式）**：`abortExtract()` 在**段与段之间**生效（已完成段与落盘内容保留），返回 `aborted` 段数；`abortPending()`/`batchProgress()` 可读。
   说明：V1 可中止在途 HTTP，V2 走 ST `generateRaw` 无法取消在途请求 —— 已在按钮 tooltip 与文档写明；
4. **清除已处理记录** `clearFloors()`：清空台账、`lastKnownFloor=-1`、重签名并落盘，**不删除任何记忆条目**；
5. **进度与动效**：头部 `ftt-head-busy` + 「🔄 分析中 N/M 段（第 a-b 楼）」；未摘要楼层中当前段加 `.ftt-floor-pulse`（V1 同名类）；
   总览工具行补齐 `✖ 中断`、`🧹 清除已处理记录`；
6. **门禁扩容（重要）**：`scripts/check-core-refs.js` 由「只扫 core/」扩展为**扫描 core/ + host/ + adapters/ + ui/ + 入口（51 文件）**，
   分层放行允许的宿主全局；并修好三类误报（`import { X as Y }` 源名、`export { … } from` 再导出名、行内对象方法简写与参数）。
   扩容后立即拦到本批一处漏导入（`host/extract.js` 缺 `getLastMessageId`，此前表现为静默 `no-message`）。

**验证**：新增 `tests/unit/extract-batch.test.js` **9 项**（分段构建 / 整段记账 / 失败不记账 / 空段跳过 / 手动批量 / 静默补全跳过 / 协作式中断 / 清台账不删数据 / 面板接线与动效）；
`panel.test.js` A1 改为分别校验 `⚡` 批量与 `📤` 逐楼钩子。门禁：单元 **25 文件 / 331 断言**、冒烟 **55 项**、五道门禁全绿；
文档 `docs/P8d-B3提取与楼层.md`，`docs/P8-功能对齐总表.md` B3 打勾。

## v2.3.0（2026-09-24）· B2 条目操作与编辑器全量（V1 字段表）

**本版（B2）**：
1. **移植 V1 字段表**：新增 `ui/fields.js` —— `kindFields(kind)`（13 维字段定义）、`flattenSnapshot`（档案分组展开）、
   `deconstructEntry`（表单 → 入库 raw）；字段数与 V1 **逐维一致**（情节 11 / 状态 5 / 角色 20 / 记忆 8 / 概念 7 / 物品 6 /
   货币 7 / 分段 2 / 传言 10 / 计划 11 / 悬念 11 / 场景 3 / 平行 13）；
2. **编辑器全字段**：text/number/textarea/select/checkbox/`sceneParent`/`relTable`(只读，编辑在 B5)；
   角色页按 V1 分组语义保存；`add` / `addStateFor`（预设主体）/ `addChildScene`（预设父级 → `pathArr`）三条新增路径；
3. **条目操作**：单选/多选切换、全选、清空选择、`bulkDelete`（逐条留墓碑并回报条数）、`closeEntry`/`cancelEntry`（不写库仅收起）；
4. **情节页**：`atomToggleHidden`（显示/隐藏「已总结」情节 + V1 说明文案）、`atomPeek`/`atomPeekClose`（穿透查看被总结原文）；
5. **状态页**：按主体分组渲染，组头「➕ 添加」「🗑 删除分组」（`addStateFor` / `delStateGroup`）；
6. **搜索**：每页搜索 + `searchClear`；搜索字段取各维度字段**超集**；`core/config.js#KIND_MAP` 增 `currentStates` 别名
   （`kindNormalize` 同步），使状态维度既可用 V1 界面键、也能以规范键规范化与写墓碑；
7. **有意偏离 V1（已登记）**：状态删除墓碑写入规范维度键 `currentStates`（V1 写 `deleted.states`，而它自己的合并只认
   `currentStates` → 删除可能被别端复活）；`ui/panel.js` 对「无法回查 DOM 的极简宿主」增加内存元素兜底。

**测试基建修复（重要）**：`tests/harness/st-mock.js#makeReporter.assert` 增**防呆** —— 断言条件是 Promise/thenable 直接判失败。
本批借此查出并修正 **15 处「假绿」断言**（`R.assert(name, (async () => …)())` 恒为真），并因此暴露、修掉了 3 个真实缺陷
（状态容器读取映射、状态墓碑维度键、搜索字段缺失）。新增 `tests/unit/panel.test.js` B2-1～B2-6。

门禁：单元 **24 文件 / 322 断言**、冒烟 **55 项**、五道门禁全绿；文档 `docs/P8c-B2条目操作.md`、`docs/P8-功能对齐总表.md` 打勾更新。

## v2.2.0（2026-09-24）· V1 面板外壳与样式对齐（B1）

**用户要求**：「请完全对齐 V1 的各种功能，完整实现出来。注意页面尽可能的样式也对齐。」

**本版（B1）**：
1. **样式逐字搬运**：V1 `ensureStyle()` 的 **527 行 CSS**（437 处 `#ftt-panel` 规则）逐字并入 `style.css`（带「逐字移植自 V1」注释段）；
2. **DOM 同构**：新增 `ui/panel.js` —— 生成与 V1 `panelHtml()` **同名同层级**的浮层
   （`#ftt-panel > .ftt-modal > .ftt-modal-head / .ftt-tabs / .ftt-body[data-ftt-body]`，行/按钮/编辑器类名一致），
   V1 样式因此**无需改写即生效**；**13 个 V1 分页**（总览/情节/状态/角色/记忆/物品/货币/传言/计划悬念/场景/概念/平行/设置）；
3. **总览（可见子集）**：剧情时钟三行（含公元前/纪年/季节）、在场角色、注入审计、类目统计徽标、**已处理楼层区间 + 未摘要楼层逐楼按钮**、工具行（立即 AI 摘要 / 提取记忆 / 立即注入）；
4. **维度分页**：V1 行样式 + 搜索 + `.ftt-editor` 编辑器（标题/正文/日期/标签/重要度 + 内容哈希 + 关联只读）+ 删除（双墓碑）；计划页合并「计划 + 悬念」；
5. **入口统一**：魔杖菜单、`/ftt-ui [分页]`、`FTT.ui()`、悬浮「FTT」按钮均打开该浮层（不再依赖 `callGenericPopup`，可见性彻底解决）；
   `ui/popup.js` 降为**兼容转发层**；`/ftt` 状态行改为「界面：V1 同构浮层（13 个分页）」；
6. **对齐总表**：新增 `docs/P8-功能对齐总表.md` —— V1 面板动作去重 **110 个**、UI 源码 5,906 行、设定 **14 组子页**，
   按 **B1–B9** 分批（含逐动作打勾清单与「尚未移植内核」清单）；`docs/P8b-V1面板外壳.md` 记录 B1 交付细节。

**验证**：新增 `tests/unit/panel.test.js` **12 项**（样式并入 / DOM 同构 / 打开关闭 / 总览 / 维度与编辑器 / 删除墓碑 / 提取与注入 / 切页 / 设置内嵌 / 卸载），
冒烟 M1–M2 改为浮层断言；门禁：单元 **24 文件 / 316 断言**、冒烟 **55 项**、五道门禁全绿。

## v2.1.0（2026-09-24）· 弹窗主界面（对齐 V1 交互形态）

**用户要求**：「原先扩展内增加按钮，会弹窗方式处置，**包括访问记忆**」；「扩展看到了『FTT记忆组件 V2』卡片，
这个设计完全没必要，因为原先 V1 弹窗已经身经百战很好用了」。

**改动**：
1. 新增 `ui/popup.js`（约 230 行）—— **弹窗 + 分页**主界面，四个分页：
   **总览**（状态/维度计数/注入审计/快捷动作）、**数据台**（14 维浏览·搜索·编辑·删除·注入自查，复用 `ui/console.js`）、
   **提取**（未分析楼层清单 + 逐楼分析 + 全部分析 + 统计）、**设置**（内核配置 / 更新 / V1 导入 / 诊断，复用设定面板表单与绑定）；
2. **弹窗为默认形态**：扩展魔杖菜单「FTT记忆组件」、新增命令 `/ftt-ui [分页]`、`FTT.ui()` 均打开弹窗；
   悬浮「FTT」按钮（扩展菜单不可用时）打开同一个弹窗；弹窗宿主用 `callGenericPopup`，不可用时自动退回挂抽屉；
3. **抽屉卡片默认关闭**（用户偏好）：新增内核配置 `uiShowDrawer`（默认 `false`）、`uiShowFloating`（默认 `true`）、`uiFirstTab`（默认 `overview`）；
   `/ftt-panel` 保留为排障/强制挂载入口；`/ftt` 状态新增「界面：弹窗优先…」与装配诊断行；
4. 渲染与动作分离（`popupHtml` / `popupBodyHtml` / `popupAction` / `bindPopup`），无 `querySelectorAll` 环境可完整测；
   弹窗样式进 `style.css`（`.ftt-pop*`、`.ftt-float-btn`）；
5. 词条补充弹窗相关 8 条（总览/数据台/提取/设置/刷新/分页…），词条门禁保持双语键集一致。

**回归修复**：`state-merge-golden` T1 改为断言 V1 的「墓碑时间戳取最大」语义（此前用 `Date.now()` 隐式比较，同/跨毫秒会偶发失败）；
配置保真门禁改为「V1 的 217 键逐值一致 + 仅允许 3 个 V2 专有界面键」，避免以后加界面键就要改计数。

**验证**：单元 **23 文件 / 304 断言**、冒烟 **55 项**（新增 M1–M2 弹窗用例，B3/E/I/L 在开启抽屉开关的前提下继续覆盖抽屉路径），五道门禁全绿；文档 `docs/P7-弹窗主界面.md`。

## v2.0.2（2026-09-24）· 可见性兜底（悬浮入口）+ 更新检查的传输层失败处理

**背景**：用户在 TauriTavern 里仍反馈「看不到面板」，并给出后端日志：
`ERROR tauritavern::user_error: Failed to get extension version: Internal error: Git handshake failed: An IO error occurred when talking to the server`。

**判断**：这类 `Git handshake failed / IO error` 是**宿主的 git 取远端失败（网络不通）**，属于**更新检查**路径，
与面板显示无关，也不会阻止扩展加载（宿主把它记为用户级错误）。但它有两个副作用：① 后端日志噪声；
② 无法区分「扩展名不存在」与「网络不通」，因为此前的 `postJson` 只回报 `HTTP 500`。

**本版改动**：
1. **悬浮入口兜底**（`ui/floating.js`）：当扩展设置抽屉的三个候选容器**一个都找不到**时，
   自动在页面右下角显示固定的「FTT」小按钮；点击即以**弹窗**（`callGenericPopup`）展示完整面板；
   抽屉容器一旦恢复，自动挂回抽屉并**移除**悬浮按钮（不干扰正常用户）。探针连续 4 次挂载失败（约 3 秒）后启用兜底并停止轮询，不再无限重试。
2. **更新检查的传输层处理**（`host/update.js`）：`postJson` 透传宿主错误文本；
   识别 `handshake / IO error / network / timeout / fetch failed` 等**网络级**失败后**短路**
   （不再重复调用 `global` 端点 —— 此前一次检查会触发两次 git 握手，失败时日志翻倍），
   并进入**会话内退避（6 小时）**；`runStUpdate`（立即更新）同样短路。
   新增 `resetTransportBackoff()` / `transportBackoffActive()` 便于手动重试与诊断。
3. 诊断扩展：`FTT.floatingInfo()`、`FTT.openPanel()`；`/ftt-panel` 输出追加悬浮入口状态；
   面板状态块与 `/ftt` 状态行同样包含。

**验证**：单元新增 B9–B11（无抽屉时启用悬浮 / 无 body 明确拒绝 / 点击弹窗展示面板 / 容器恢复后自动切换）、
U10（传输层失败只打一次端点 + 进入退避 + 错误分类）；冒烟新增 L5（悬浮兜底全链路）。
门禁：单元 **23 文件 / 304 断言**、冒烟 **53 项** 全绿。

## v2.0.1（2026-09-24）· 修复「安装后看不到面板」

**现象**（用户实测）：TauriTavern 里扩展已成功安装（后端日志 `Extension installed: FTT记忆组件 V2 v2.0.0`、
目录 `…/extensions/stt-memory-plugin-v2`），但界面上找不到任何 FTT 面板/入口。

**根因**：v2.0.0 的初始化**只挂在 `APP_READY` 事件上**——
① 宿主若不发该事件（或事件时机早于插件脚本加载，且不补发），`init()` 永不执行 → 面板、命令、注入、提取全部静默不生效；
② 挂载容器只认 `#extensions_settings2`，不同发行版/原生移植的设置区块 id 并不统一 → 即使初始化了也插不进去；
③ 诊断入口（`/ftt`、`window.FTT`）也在 `init()` 里注册 → 出问题时用户**没有任何自查手段**。

**修复**：
1. **多触发装配**：`APP_READY` / `APP_INITIALIZED` / `DOMContentLoaded` / `window.load` / **有限轮询**（20 次 × 750ms）/
   命令调用，任一先到即初始化；`ensureReady()` 去重保证只跑一次。已就绪但面板容器当时不存在时，只重试挂载。
2. **容器回退**：按 `#extensions_settings2` → `#extensions_settings` → `#rm_extensions_block` 依次尝试，
   并在面板状态块与命令里报告实际容器或失败原因。
3. **诊断入口提前注册**（模块加载即注册，不依赖任何事件）：`/ftt`、**新增 `/ftt-panel`**、`/ftt-analyze`、`/ftt-import`
   与 `window.FTT`（新增 `FTT.panelInfo()` / `FTT.menuInfo()` / `FTT.forceMount()`）。
4. **可见性兜底**：向扩展魔杖菜单（`#extensionsMenu`）插入「FTT记忆组件」入口，点击即强制挂载并给结果提示。
5. 面板状态块新增「面板挂载：已挂载 → #容器 / 未挂载（原因）」诊断行；`/ftt` 状态新增「装配：已初始化/触发链/面板/菜单入口」行。

**验证**：新增 `tests/unit/bootstrap.test.js`（8 项）——**全程不发任何事件**仍完成装配与挂载、
容器回退、无容器时的可诊断与自愈、无事件源宿主的 `ensureReady`、菜单入口、teardown 后恢复；
冒烟新增 L1–L4（触发来源、`/ftt-panel`、状态块诊断行、菜单入口）。门禁：单元 **23 文件 / 300 断言**、冒烟 **52 项** 全绿。

## v2.0.0（2026-09-24）· 首个可用版本

> 本版本为 **P0–P6 全阶段交付**：可安装骨架 → 内核平移（13 份黄金样本，oracle = 真实 V1 插件）→
> 宿主与存储 → 注入闭环 → 提取落库与内核完整性 → 提取编排 → 设定面板与数据台 → 词条与发布终检。
> 发布物自足性、终检清单与未完成边界见 `docs/P6-发布与终检.md`。



**P0：可安装骨架 + 宿主 API 探针结论（原生扩展形态立项）**

- **用户要求**：「开始开发V2版」（承接 V2 设计稿 `docs/13`+`docs/14`：结合现有架构与功能体系，构建酒馆原生插件）。
- **本版范围（P0）**：
  1. 扩展骨架：`manifest.json`（含 `generate_interceptor` / `hooks` / `i18n` / `auto_update`）+ ESM 入口 `index.js` +
     `settings.html` + `style.css` + `i18n/`（zh-cn / en）；
  2. 四层骨架：`core/`（纯内核：常量 + 工具，零宿主依赖）、`host/`（st-api / events / inject / interceptor / generation）、
     `adapters/`（settings）、`ui/`（settings-panel / commands）、`devtools.js`（`window.FTT`）；
  3. 依赖方向门禁：`scripts/check-core-purity.js`（core 不得引用宿主层或浏览器标识符）；
  4. 版本一致性门禁：`scripts/check-version-sync.js`（manifest / package / constants / CHANGELOG / git tag）；
  5. 文档门禁：`scripts/check-docs.js`（围栏 / 语言标注 / 标题层级 / HTML / 行尾空白 / 头部元信息）；
  6. 测试基建：`tests/harness/st-mock.js`（宿主桩：getContext + 最小 DOM）、7 个单元用例文件、
     `tests/smoke-test.js`（有宿主全链路装配 + 无宿主导入不崩）；
  7. 探针结论：`docs/P0-探针报告.md`（源码级核对 ST release 分支：注入 API 签名与枚举、getContext 能力面、
     **ST 原生 git 更新端点**、世界书 / 弹窗 / 宏 / 命令 / 连接配置等）。
- **行为**：安装后 `activate` 挂载生成前拦截器（**永不 abort**）；`APP_READY` 时初始化：
  能力探测 → 配置初始化 → 设置面板挂载 → 事件绑定（`GENERATION_ENDED` / `USER_MESSAGE_RENDERED` / `CHAT_CHANGED`）
  → 注册 `/ftt` 命令与 `{{fttVersion}}`/`{{fttStatus}}` 宏 → 安装 `window.FTT`；禁用/删除时 `teardown()` 全部解绑并清空注入。
- **未做（后续阶段）**：提取/注入闭环（P3 接入 V1 内核）、数据模型与存储适配（P2）、数据台 UI（P4）、
  高级域（P5：时钟 / 关联 / 传言 / NSFW / 情节总结 / 分段总结 / 修复 / 遗忘）、V1 数据导入向导（P6）。
- **更新检查机制（Git 通道，本版新增）**：以 **GitHub 项目地址**为更新检查地址（`updateRepo` 默认
  `https://github.com/fotomxq/stt-memory-plugin-v2`，分支 `main`，可在设置内改）——
  ① **首次启动自动检查**（`startupCheckedAt` 未写则必查；之后按 24h 间隔；开关可关，关闭后零远端请求）；
  ② **设置内手动检查**（「🔍 检查更新」按钮，不受开关与间隔限制，结果落盘并在状态行显示）；
  ③ 判定通道优先级 = **ST 原生端点**（`POST /api/extensions/version` 的 `isUpToDate`/commit，Git 真值）
  → 远端 `manifest.json` + `CHANGELOG.md` 回退（补版本号与更新要点；**仓库根无 `manifest.json` 时用 `CHANGELOG.md` 首条版本兜底**）；端点为「有更新」而版本号相同时判为**同版本新提交**；
  ④ 「⬆ 立即更新（ST）」代为调用 `/api/extensions/update`（**仅用户点击**，自动路径永不调用）；
  ⑤ 全部请求 8s 超时、失败静默（不阻塞启动/发送/提取）；扩展**不下载、不写入、不执行远端代码**；
  ⑥ 状态持久化于 `extensionSettings.ftt_memory_v2.update`（`firstRunAt` / `startupCheckedAt` / `lastCheckAt` / `lastResult`），
  `/ftt` 与 `FTT.update()` 可查；新增 `core/update.js`（纯逻辑）、`host/update.js`（编排）、`adapters/update-state.js`（持久化）、
  `docs/更新检查机制.md`。
- **P1 内核平移（批次 1：模型层，本版新增）**：把 V1 的归一化内核**逐段提取**进 `core/model/` ——
  `scalars.js`（17 个助手 + 3 张常量表 + 可注入 `cfg` 视图）、`atom.js`（`normalizeAtom`）、
  `dims.js`（状态 / 记忆 / 概念 / 平行 / 物品 / 计划 / 悬念 / 名册 / 场景 九个 `normalize*`）、`hash.js`（`atomContentHash` 双哈希）；
  `core/constants.js` 增 `DIM_CHAR_LIMITS`（逐字取自 V1 `defaultCfg`）；`hashText` 对齐 V1（**djb2 → base36**，
  而非 FNV/十六进制 —— 它决定 id 派生与删除墓碑）、`normText` 恢复 V1 语义（**保留换行**）、`clamp` / `normalizeList` 与 V1 一致；
  角色作用域改为 `char:hashText(avatar → name2 → 索引)`（与原 TH 角色 id 口径尽量靠近）。
  **保真度门禁**：V1 源码切片产出黄金样本 `tests/fixtures/v1-golden.json`（10 维度固定夹具 + 6 组哈希 + 7 项助手），
  `model-golden.test.js` 复放并要求 **JSON 逐字符相等**（15 项断言）。详见 `docs/P1-内核平移.md`。
- **P1 内核平移（批次 2：档案 / 年龄 / 货币 / 分段）**：新增
  `core/model/runtime.js`（**注入视图**：`cfg` / `state` / `getStoryNow` / `defaultCfg` + `saveCfg`·`saveState` 持久化钩子，
  由宿主注入 —— 内核保持零宿主依赖，V1 代码逐字不改）、
  `core/model/snapshot.js`（612 行：`normalizeSnapshot` + 年龄族 `snapshotAge*`/`calcAge`/`syncSnapshotAge`/`refreshAllSnapshotAges`
  + 出生日期族 `parseBirthDateParts`/`birthDatePrecision`/`birthDateInFuture`/`snapshotBirthAnomaly*` + 时间采样 + `migrateSnapshotV1162`）、
  `core/model/money.js`（210 行：`normalizeCurrency`/`formatMoney`（万·亿·兆·京·垓）/`moneyNet`/流水 + 标定角色 `trackedCurrencyRoles` 增删清 + `defaultCurrencyOwner`）、
  `core/model/segment.js`（188 行：情节分段总结 `normalizePlotSegment`/`plotSegmentId`/`plotSegmentRange`/`plotSegmentTimeKey`/排序/文本互转）；
  `scalars.js` 追加 `SNAP_GROUP_MAP`/`splitListText`/`normalizeTrackedRoles`。
  **黄金样本 2**（`tests/fixtures/v1-golden-model2.json`）：`model-golden2.test.js` **23 项断言**逐字符比对
  （档案 / 年龄与锁定 / 出生异常 / `calcAge` 跨生日与公元前 / 货币含 1.23 亿显示 / 分段含时间倒序与文本互转）；
  时间戳（`createdAt`/`updatedAt`，墙钟）比较前抹平，其余字段严格相等。
- **P1 内核平移（批次 2b：关联层 / 传言）**：新增 `core/model/rel.js`（292 行：`normalizeRelLink` 维度白名单与方式越界留痕、
  `relLinksOf`、`relOrphanStats`、`relSummaryLine` + `REL_LINK_*` 常量族）与 `core/model/rumor.js`（324 行：`normalizeRumor`、
  `rumorId`/`rumorChildId`/`rumorSubjectKey`、传播者与载体解析、链路/谱系/待办归一、`rumorStageByFerment`、`mergeRumorObjects`）；
  **模型层至此覆盖全部 14 类维度**。关联层的写入/维护（`upsertRelLinks`/`relMaintRun`/`migrateRelLinks`/`sweepOrphanRelLinks`）
  因触碰墓碑与迁移，留待批次 3 的状态与合并层。
  **黄金样本 3**（`tests/fixtures/v1-golden-model3.json`）：`model-golden3.test.js` **16 项断言**（含 9 条关联夹具、中文键传言、
  阶段映射边界、三类合并）。同时引入「**重抛探针**」：把切片里的 `catch { return ... }` 临时改为 `throw`，暴露并补齐
  被静默吞掉的 10 项常量依赖（`REL_LINK_HOW_CN`、`RUMOR_STAGES` 等）。
- **P1 内核平移（批次 3：状态与合并层 · 无时钟依赖部分）**：新增 `core/state.js`（51 行：`scopeId` —— 角色标识改为注入视图、
  `stateKey`、`emptyState` 28 键容器）与 `core/merge.js`（144 行：删除墓碑 `tombSet`/`tombSetH`/`tombEntry`/`tombMany`/`tombEntries`、
  隐藏条目保护 `atomIsHidden`/`activeAtoms`/`capAtomsKeepingHidden`/`releaseMergedSources`、内容哈希补全 `eachAtom`/`ensureAtomHashes`/`collectAtomHashes`）；
  `constants.js` 补 `ATOM_DIM_KEYS`。黄金样本 4（`tests/fixtures/v1-golden-state-merge.json`）**12 项断言**：
  作用域与空状态、隐藏保护与来源恢复、墓碑分账与幂等、哈希补全与遍历。
  **明确延后**（依赖配置/时钟/全表）：`migrateState`、`contentDedupeArray`、`upsertEntry`/`deleteEntry`、`upsertRelLinks`/`relMaintRun`。
  过程经验（已写入文档）：**宽依赖函数不可用闭包移植** —— 首次尝试闭包膨胀到 148/1067 项，改为显式清单 + 严格静态检查 + 黄金样本兜底。
- **P1 内核平移（批次 6：召回与注入层 · 内核收尾）**：新增 `core/recall.js`（1362 行：时间排序、评分与命中、匹配器、
  在场判定、各类注入行、**注入体装配** `buildMemoryBodyForInject`、**固定约束段** `buildInjectConstraints`、使用计数）；
  `runtime.js` 增 `getChatMessages`/`getAssistantText`/`latestAiFloorText`/`dbgLog`/`warn` 注入钩子。
  **内核移植至此全部完成**（`core/` 19 个文件：模型 10 + 状态合并 4 + 配置时钟 2 + 召回注入 1 + 常量/工具）。
  黄金样本 7（oracle = 真实 V1 插件，14 类维度注入态 + 固定预算）：`recall-golden.test.js` **12 项断言**，
  含**注入体在两个预算下逐字符一致**与约束段逐字符一致。
  **生成器精化**（本轮踩到并修好，写入 docs/P1-内核平移.md §2.12）：① 取标识符前剔除注释与字符串；② 处理函数体内局部名遮蔽；
  ③ 排除对象键与属性访问；④ 移植体**常量先行**避免 `const` TDZ。并借 `warn` 注入钩子发现并补入 `relConceptSuffix`、`clockDateLabel`。
- **P1 内核平移（批次 7：墓碑清扫与存储信封）+ P2 宿主接线首批（本版新增）**：新增 `core/sweep.js`（160 行：`entryIndexInit` /
  `entryIndexBuild` / `tombstoneSweep` / 索引与墓碑计量）与 `core/envelope.js`（30 行：`storageEnvelope` / `storageHash` / `storageVerify`），
  补齐 V1 `saveState()` 流水线中「消失条目写 id + 内容哈希双墓碑」「刷新全部原子 `h`」两段内核逻辑；
  黄金样本 8（oracle = 真实 V1 插件）：`sweep-envelope-golden.test.js` **8 项断言**（索引基线、墓碑判定与幂等、信封形状与哈希校验、篡改拒绝）。
  宿主接线：`host/chat.js`（`wireKernelChatHooks`：消息数组 / 最新 AI 正文 / 最后楼层号 / 角色稳定键 → 内核注入视图）、
  `adapters/store.js`（`saveStateNow` 复刻 V1 六步流水线并写 localStorage / IndexedDB / 服务端文件三级后端，
  `loadFromLocalStorage` 带哈希校验、`scheduleSave` 防抖、`wirePersistHooks` 接线、`storeStatus` 诊断）、
  `adapters/user-file.js`（ST 原生 `/api/files/{upload,delete}` + `/user/files/<name>`，命名 `ftt2-state-<slug>.json`，
  与 V1 的 `ftt-state-*` 并存以便导入器读取）；`tests/unit/store-chat.test.js` **13 项断言**（全部为 await 后真实条件，
  显式排除恒真假绿写法）。**入口接线**：`index.js` 的 `init()` 在挂面板后执行 `loadMemoryState()`
  （本机缓冲 → 服务端文件 → 空容器 → `migrateState` → 注入内核 + 楼层号），并新增 `CHARACTER_MESSAGE_RENDERED` 视图刷新、
  `GENERATION_ENDED` 防抖落盘、`CHAT_CHANGED` 换作用域重载；冒烟新增 B2b（接线来源与聊天视图）共 **21 项**，
  文档 `docs/P2-宿主与存储.md` v1.1 记录全过程。本阶段未完成项（V1 数据导入器、快照链、跨端收敛与镜像同步、配置载入迁移校验）已列于 `docs/P2-宿主与存储.md` §5。
- **安装位置无关（终检修复，本版新增）**：新增 `host/paths.js` —— 扩展目录名从模块自身 `import.meta.url` 反推
  （`…/scripts/extensions/<name>/…`，按本扩展顶层目录定位边界；推导不出回退常量 `EXTENSION_FOLDER`），
  `ui/settings-panel.js`（模板渲染）与 `host/update.js`（`/api/extensions/{version,update}` 的 `extensionName`）统一改用解析值。
  **背景**：归档级终检（把 tag 导出到与仓库不同名的目录后跑门禁）发现目录名此前写死 —— 改名安装会导致
  设置面板模板渲染失败与更新端点静默失效；`manifest.test.js` M9 已改为断言解析逻辑与常量约定。
- **P6：词条（i18n）与发布终检（本版新增）**：`i18n/{zh-cn,en}.json`（**47 条**，键＝界面中文字面量）+
  生成的 ESM 镜像 `i18n/{zh-cn,en}.js`（运行时直接 import，无需 fetch）+ `adapters/i18n.js`
  （`registerLocaleData()` 调 `ctx.addLocaleData(locale, dict)`（兼容两参/单参），`t(key, vars)` 支持占位，缺失回退键本身）；
  `scripts/check-i18n.js` 词条门禁强制「两份 JSON 键集一致 + JS 镜像与 JSON 逐值一致」，已进 `npm run gate`；
  `/ftt` 增语言行，`FTT.t` / `FTT.i18n` / `FTT.folderInfo` 调试入口。
  README 重写为 v2.0.0（安装即用 / 使用场景 / 发布终检），新增 `docs/P6-发布与终检.md`
  （发布物形态、**10 项终检清单**、归档级自足性验证流程、§3.1 终检修复、未完成边界）。**打 tag `v2.0.0`。**
  门禁：单元 **22 文件 / 292 断言**、冒烟 **48 项**、内核纯净度 0、内核标识符 0、词条通过、版本一致性（`--strict` 亦过）、文档规范 0。
- **P5 次批：数据台（本版新增）**：新增 `ui/console.js`（约 290 行）—— V1 数据面板的 V2 最小可用集：
  ① **14 维浏览**（维度标签行 + 条数，列表最新在前）；② **搜索**（id / 标题 / 名称 / 正文 / 归属 / 标签 / 关键词，大小写不敏感）；
  ③ **查看与编辑**（标题·正文·日期·标签·重要度；附 `relLinksOf` 关联行与 `atomContentHash` 内容哈希；必要字段缺失不写入并给出原因）；
  ④ **删除**走 `deleteEntry` → **id + 内容哈希双墓碑**（跨端与快照不会复活）；⑤ **注入自查** `injectAudit`
  （逐条判定是否进入当前注入，给 `chars/injected/missing/rows`）；⑥ 渲染与动作分离：`consoleHtml()` / `consoleAction()`
  （tab/search/open/save/delete/cancel/refresh/audit）/ `writeConsole()`（真实 DOM 整块替换）/ `bindConsole()`（按 `data-ftt-console` 接线），
  无 `querySelectorAll` 的环境由调用方直接调动作入口，逻辑可完整测；⑦ 面板接线：「🗂 刷新数据台」按钮 + `#ftt_v2_console` 容器，
  挂载后立即渲染，回退 HTML 同样带容器。测试：冒烟 J1–J6（含**保存后读回 localStorage 信封**校验与删除墓碑断言）。
  门禁：单元 **22 文件 / 292 断言**、冒烟 **45/45**、内核纯净度 0、内核标识符 0、版本一致性 OK、文档规范 0；文档 `docs/P5b-数据台.md`。
  未完成：多选批删/批标、关联编辑（关系表 UI）、分页与虚拟滚动、快照回滚页。
- **P5 首批：设定面板（本版新增）**：
  ① `settings.html` 扩展为「基础开关 / 记忆与注入（内核配置）/ 状态与动作 / 更新」四段，新增
  **注入当前提示词、注入预算、注入情节与记忆条数上限、生成结束后自动提取、14 维启用勾选**；
  ② `ui/settings-panel.js` 新增唯一写入口 `applyPanelCfg(id, value)`（绑定表 `PANEL_CFG_BINDINGS`）+ `applyPanelDim(kind,on)`
  —— 改动落到内核 `cfg` 视图并 `saveKernelCfg()` 持久化到 `extensionSettings.ftt_memory_v2.cfg`，随后刷新状态块；
  读取侧一律取 `cfg.*`，**杜绝「面板显示 settings、内核读 cfg」的两套配置分叉**；
  ③ 只读状态块（`statusBlockText`）：版本 / 作用域 / 内核配置键数 / 当前注入字数 / 提取运行·成功·失败·最近原因 / 待分析楼层 / 存储来源；
  ④ 动作按钮：分析未分析楼层、待分析清单、清空注入、V1 导入（干跑）与 V1 导入（写入），结果显示在动作提示行，
  异常只提示不抛；钩子由 `index.js` 注入（`mountSettingsPanel({ hooks, status })`），避免 `ui/ → host/` 反向依赖；
  ⑤ `fallbackPanelHtml` 同步补齐同类控件（模板不可用时仍可配置与操作）；`style.css` 新增区块样式。
  测试：冒烟 I1–I4（真实 `settings.html` 渲染 + change 事件持久化 + 维度开关 + 四个动作按钮）。
  门禁：单元 **22 文件 / 292 断言**、冒烟 **39/39**、内核纯净度 0、内核标识符 0、版本一致性 OK、文档规范 0；文档 `docs/P5-设定面板.md`。
  未完成：数据台（条目浏览/编辑/搜索/多选/关联/注入自查）、提示词模板编辑页、高级域参数页、i18n 词条补全。
- **P4 首批：提取编排闭环（本版新增）**：
  ① `core/prompt.js`（339 行）移植 V1 `buildSummaryPrompt` 及其闭包 14 项（`armorPresetText` / `buildExistingIndexText` /
  `buildCurrencyLedgerText` / `buildWorldbookFeedText` / `applyFeedRegex` / 正则编译等）—— 系统提示词＝分析前置提示词 +
  通用规范 + 各维度说明 + 变量规范，用户消息＝世界书参考（可选）+ **已有条目索引** + **当前货币账本** + 本轮对话；
  黄金样本 11（oracle = 真实 V1 插件）**两条消息逐字符一致**；世界书能力改经注入视图 `worldbookHooks`。
  ② `host/floors.js`：楼层取文与判据逐字对齐 V1 —— `floorStableText`（内容哈希用原始首刷）/`assistantTextOf`（分析用当前刷）/
  `collectFloorLinesInRange`（`[第N楼 角色]` 行、跳过隐藏楼）/`floorAnalyzableText`（投喂正则 + 排除占位楼）/`hashFloorText`；
  以及「已分析楼层」台账 `state.processedFloors`（`{f,h}`，上限 5000）+ `state.processedVer = v1.174:11n8nlu`
  （签名 = `hashText('【FTT 已处理楼层哈希自检样本 v1.174】')`，与 V1 同值 → **V1 存档可直接沿用**）、
  `recordProcessedFloors` / `isFloorProcessed`（内容改写即视为未分析）/ `listUnprocessedFloors`。
  ③ `host/extract.js`：串起**取文 → 提示词 → AI(generateRaw) → `extractJsonObject` → `mergeDelta` → 台账 → 落盘**；
  `analyzeFloor` / `analyzeFloors`（忙碌互斥）/ `autoExtractLatest`（取最后一个未分析楼层，受 `cfg.autoExtract` 保护）/
  `extractStats` / `extractSummary`；六类失败姿态（`empty-floor`/`no-generate`/`ai-error`/`no-json`/`merge-fail`/`error`）
  只回报原因并计数，**不抛出、不 abort、不改 chat、不写台账**。
  ④ 入口：`GENERATION_ENDED` 自动提取、`/ftt-analyze [楼号|list]` 命令、`FTT.analyze`/`FTT.pendingFloors`/`FTT.extractStatus`、
  `/ftt` 状态行新增「提取：运行/成功/失败/待分析」。
  ⑤ 测试：`tests/unit/extract-prompt-flow.test.js` **15 项断言** + 冒烟 H1–H6（真实宿主桩）。门禁：单元 **22 文件 / 292 断言**、
  冒烟 **35/35**、内核纯净度 0、内核标识符 0、版本一致性 OK、文档规范 0；文档 `docs/P4-提取编排.md`。
  未完成：分维度并行提取（V1 `runSummarySeparate`）、关键词流程与及时分析、楼层对账/哈希漂移批量刷新、JSON 失败自动修复链。
- **P3 次批：提取落库内核（`core/ingest.js#mergeDelta`）+ 内核完整性门禁（本版新增）**：
  ① 移植 V1 `mergeDelta`（1513 行 / 66 项闭包）——13 类维度的 add/update/remove/close 按 V1 同一顺序落库，
  含「已总结隐藏情节不接受 AI 改写」「情节就地更新保留 uses 与因果 log（最多 3 条）」「同名物品只更新不新增、qty=0 自动删除」
  「同一归属+币种只维护一条」「传言按主体维护、分裂建分支」「plans/suspense 的 closed 只留统计」「snapshots remove 联动清状态」
  「存储上限裁剪保留隐藏情节」等口径；`saveState()` 经注入钩子落盘 → 返回 `{ok, added, total}`。
  黄金样本 10（`tests/unit/ingest-golden.test.js` **10 项断言**，oracle = 真实 V1 插件）：13 类维度**逐字符一致**、
  情节更新保留 uses/log、楼层范围透传、内容哈希一致、年龄锚定、传言归一、幂等、删除留痕、脏增量不抛。
  ② 新增门禁 `scripts/check-core-refs.js`（内核未定义标识符静态检查，已进 `npm run gate`，支持 `--explain=` 诊断）——
  一次揪出 **7 处**「V1 `catch` 静默吞掉 `ReferenceError`」导致的数据丢失缺陷并全部补全：
  `splitListText`/`snapNameKey`（归位 `core/util.js`）、`normalizeRelRefList`（补导出）、`dateStrCmp`/`clockParseDateText`
  与 clock 族 import、`SNAP_*` 常量与 `ensureSnapshotBirthDate`/`storyAnchorDate`/`storyClockReference`（snapshot 补全）、
  `parallelRelPrefix`（recall 补全）、segment 的 `defaultCfg` import。
  ③ 宿主耦合改为**注入视图**：`notifyHooks`（toast）、`identityView`（当前角色名）、`timerHooks`（延迟衰退调度，
  默认 no-op，内核不碰全局定时器）；`index.js#installHostBridges` 接线 toastr 与角色名。
  ④ **修正保存流水线的索引基线语义**：新增 `adapters/store.js#primeStateIndex()` 并在载入后调用 ——
  基线只能在启动/载入时建立一次（V1 同款），否则「每次保存重建基线」会让删除永远检测不到、墓碑永不写入。
  ⑤ 黄金样本真值升级：批次 1–2b 的模型样本由「源码切片」产出，切片缺依赖 → 记录的是降级中间态
  （`age:''`/`appearance:''`/`clockDateTrim:''`/分段 `start:''`/平行事件 `null`）；本批改为**真实 V1 插件**直算
  （未导出的规范化器逐条走 `mergeDelta` 落库读回后逐字段核验），`migrateState` 的 oracle 复刻测试的**别名场景**；
  墙钟字段（`updatedAt`/`createdAt`/分段 `timeKey` 第三段）不入移植口径，测试抹平后比较。
  门禁：单元 **21 文件 / 277 断言**、冒烟 29/29、内核纯净度 0、内核标识符 0、版本一致性 OK、文档规范 0；文档 `docs/P3b-提取落库与内核完整性.md`。
- **P3 首批：记忆注入闭环（本版新增）**：
  ① `adapters/config-store.js`（约 90 行）—— 内核配置视图与 ST 配置容器双向同步：
  `loadKernelCfg` = `core/config.js` **217 键默认配置** ⊕ 已存配置（已存优先、对象递归、缺键补默认、未知键保留），
  `saveKernelCfg` 在内核调用 `saveCfg()` 时写回 ST 配置，`stableStringify`（递归排序键）判定是否需要补写以避免键序造成无意义写盘；
  ② `host/inject.js` 新增 `wrapInjectText` / `pushMemoryInject` / `pushStats` / `injectGateOpen`，**逐字复刻 V1 `buildInjectText()` 包装**
  （【FTT记忆注入】标题 + 区块标记说明 + 剧情日期口径（`clockDateLabel`）+ 可配置使用说明 + `记忆结束。`）与 `pushInject()` 口径
  （开关＝及时分析或 `cfg.injectCurrentPrompt`；序号并发防护；**空构建保留上一次非空注入**（V1 v1.149）；`clearInject` 重置上次注入；
  位置 `POSITION.IN_PROMPT` / depth 0；异常只记 `lastError`）；有意偏离一处并登记：V1 传 `role=null`，V2 用 ST 默认 `role=SYSTEM`；
  ③ `host/interceptor.js`：生成前 `await pushMemoryInject()` 刷新注入并记 `injectedLength`，**永不 abort、不改 chat**；
  ④ `index.js`：启动 `loadKernelCfg()`、楼层事件（用户/角色消息）刷新注入、`saveCfg` 钩子接 `saveKernelCfg`、`/ftt` 增「内核配置 / 注入」两行；
  ⑤ 测试：`tests/unit/inject-push.test.js` **12 项断言** + 冒烟 G1–G3（配置同步 / 楼层事件注入 / 拦截器端到端）；文档 `docs/P3-注入闭环.md`。
  未完成（P3 次批）：三层提取链（关键词 → JS 抽取 → AI 分析）与提取落库、使用计数、注入自查面板、V1 提示词模板迁移。
- **P2 次批：V1 数据导入器（本版新增）**：新增 `adapters/import-v1.js`（约 380 行）—— 只读发现 V1 三类数据源
  （服务端 `ftt-state-<slug>-<scope8>.json[.gz]` 与 `-bak`、旧 settings 信封 `SPreset_FTTMemory_char:<hash>`、
  本机命名缓存 `FileSlug_/FileNames_/ArchiveName_<scope8>`，另含 `SPreset_FTTMemoryConfig`），
  gzip 支持（`DecompressionStream` + 魔数识别）、信封哈希校验（独立 FNV-1a 实现，篡改即拒）、
  **干跑差异报告**（逐维度 v1/current/add/exist/conflict + 墓碑计数）、`mergeV1IntoCurrent` **append-only 合并**
  （同 id 以当前为准、墓碑并集、单值容器仅在当前为空时采用、scope 归位当前、两侧深拷贝保证 **V1 源零改动**）；
  入口 `/ftt-import`（默认干跑，「apply」才写入）、`FTT.importV1` / `FTT.importStatus`、`index.js#runV1Import`（写入后走完整保存流水线）。
  **重要事实（黄金样本 9，oracle = 真实 V1 插件）**：V1 作用域来自 TH `getCurrentCharacterId`（测试环境 `char:1157z2a`），
  V2 用角色稳定键（`char:2mcm47`）——**两边定义不同**，故导入器枚举候选作用域逐一试文件名，绝不假设相等；
  命名公式 `scopeHash8 = (hashText(scope)+hashText('ftt-scope:'+scope)).slice(0,8)`、`slugFallback='n'+hashText(scope).slice(0,6)`、
  文件名 `ftt-state-<slug>-<scope8>` 已逐字符对齐 V1。测试：`tests/unit/v1-importer.test.js` **13 项断言** +
  冒烟 F1–F5（导入入口 / 干跑 / apply 落盘 / 命令 / 状态行）；`tests/harness/st-mock.js` 的 fetch 桩新增 `arrayBuffer()` 以支持 gzip 字节。
- **P1 内核平移（批次 5：迁移与条目层）**：新增 `core/migrate.js`（353 行：`migrateState` 结构健壮性清洗与多版本迁移链、
  `migratePlanSuspV1165`/`migrateRelLinks`、跨端内容去重 `contentPickBest`/`contentDedupeArray`、`recallDateNum`）与
  `core/entries.js`（347 行：`upsertEntry` 写入合并、`deleteEntry` 级联删除与 id 墓碑、`upsertRelLinks`、`sweepOrphanRelLinks`）；
  `runtime.js` 增 `getLastMessageId()` 注入钩子。**批次 3 的延后项全部回填**。
  黄金样本 6 改用**更忠实的 oracle：真实 V1 插件**（V1 测试桩加载 v1.206 直调导出函数）—— `migrate-entries-golden.test.js` **15 项断言**：
  脏数据迁移逐字符一致、迁移幂等、去重选优、条目增删与墓碑、关联写入与孤儿清扫。
  **行为发现（逐字保留，不顺手改）**：① `upsertEntry` 返回布尔；② V1 的内容哈希墓碑与原子 `h` 刷新在 **`saveState()` 流水线**里
  （**P2 宿主保存流程必须照此接线**，已在黄金样本与测试标注）；③ `upsertRelLinks` 非完全幂等（V1 亦为 `added=1/updated=2`）；
  ④ V1 桩环境楼层号 = 3（V2 用注入钩子对齐）。延后：`relMaintRun`（含 UI 统计，留维护层接线）。
- **P1 内核平移（批次 4：配置与时钟层）**：新增 `core/config.js`（1130 行：`defaultCfg` **217 键全量默认配置**、
  `PROMPT_TEMPLATES_V2` **33 条提示词模板**与 `PROMPT_DEFAULT_VERSION`、`PROMPT_GROUPS`/`PROMPT_LEGACY_SIGS`/破甲预设默认值、
  `CN_KEY_MAP`（174 项）与 `normalizeDeltaKeys`、`DIMENSIONS`/`DIM_LABELS`、`KIND_MAP` 14 维 get/set）与
  `core/clock.js`（225 行：剧情时钟族 —— 裁剪/解析/格式化/校验/公元前归一/中文数字/数值化时间戳）；`runtime.js` 增 `log()` 注入钩子。
  黄金样本 5（`tests/fixtures/v1-golden-config-clock.json`）**15 项断言**：配置整体逐字符相等 + 13 条日期样本贯穿时钟族。
  **工具缺陷修复**：① 括号配对提取遇正则/字符串花括号失衡 → 改「下一个顶层声明 + 顶层收尾行截断」；
  ② 截断误切函数内层 `}` → 改为顶层缩进匹配；③ **内核纯净度门禁误判配置键名**（`storage.localStorage`）→ 门禁剔除字符串字面量、
  排除对象键与属性访问，并用「临时植入真实宿主调用」反向自测确认仍能拦下。
- **许可确立（AGPL-3.0）**：新增仓库根 `LICENSE`（GNU 官方 AGPL-3.0 全文，逐字未改，**LF 换行、662 行 / 34,523 B，md5 `eb1e647870add0502f8f010b19de32af`**，与 gnu.org 官方 txt 一致）；
  `package.json` 增 `license: AGPL-3.0` 与 `author`；README §7 由「待确认」改为正式许可说明（含 §13 网络交互条款提示）。
- **门禁**：单元 **16 文件 221 断言全过**（`manifest.test.js` 新增许可一致性断言）；冒烟 **20/20**（含更新机制 E1–E8）；内核纯净度 **0 违规**（core/ 12 文件）；版本一致性 **通过**；文档规范 **0 违规**。
- **不与 V1 共存**：V1 与 V2 同装会重复注入，README 已提示；V1 数据不被本版读写（导入器在 P6）。
