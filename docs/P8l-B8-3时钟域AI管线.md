# P8l · B8-3 时钟域 AI 管线（AI 捕捉正则 + AI 结合正文修复日期时间）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.12.0）
> 关联：`core/clock-ai.js`（新）、`host/floors.js`（补投喂文本）、`ui/clock.js`、`ui/settings-pages.js`、
> `index.js`、`devtools.js`、`docs/P8-功能对齐总表.md`

---

## 1. 覆盖范围（V1 源 `09-AI摘要与楼层处理.js` 两条 AI 管线）

| V1 能力 | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| `normalizeClockRegexFromAi` | `core/clock-ai.js` | 正则三重校验：去 ```` /…/gi ```` 包裹与代码块 → **可编译** → **不匹配空串**（避免无限匹配吞正文） |
| `buildClockRegexPrompt` | 同上 | system 取配置模板 `promptTemplates.clockRegexGen`（缺省用内置默认）+ user 附正文样本与「只输出 JSON」契约 |
| `genClockRegexesFromText` → `genClockRegexes` | 同上 | 取最近 N 楼投喂文本 → AI 产出 `{日期正则,时间正则,地点正则,说明}` → 逐条校验 + **样本命中判定**（无命中不采用）→ 写入 `cfg.clockDateRegex/clockTimeRegex/clockLocationRegex` → 保存配置 → **用样本试算**并回报「已应用/未采用 + 试算结果」 |
| `clockRepairPack` | 同上 | 异常清单打包：上限 `cfg.clockRepairBatch`（默认 20，硬上限 200）+ 截断数；每条含维度标签 / 字段 / 现值 / 原因 / 当前登记日期时间 / 截断后的正文 / 楼层区间 |
| `buildClockRepairPrompt` | 同上 | system 取 `promptTemplates.clockRepair` + user 附【时间锚点】【近期正文（`repairFloors`→`feedFloors`→10 楼，截尾 8000 字）】【待修复清单】+ 输出契约 `{"修正":[{编号,日期,时间,依据}],"清除":[编号],"无法判定":[编号]}` |
| `applyClockRepairResult` | 同上 | **只允许改 日期 / 时间 两个字段**：逐条过 `clockPatrolSafeDate`（格式合法 + 有锚点时不触发年份异常）；不合格丢弃并计数；`清除` 清空对应字段；`无法判定` 只计数 |
| `runClockRepair` | 同上 | 端到端：无异常 → 直接回报；**无可信锚点 → 拒绝执行且不调用 AI**（避免把现实年份写进剧情）；长任务在途 → 拒绝；AI 无返回 → 如实回报不改数据；有改动才落盘 |
| `buildFeedFloorText` / `buildFeedFloorTextRange` | `host/floors.js` | 投喂文本（最近 N 楼原始行 → 投喂正则过滤）；供时钟正则/修复与后续修复域共用 |
| 界面动作 | `ui/clock.js` + `ui/settings-pages.js` | 基础页两个 V1 同名按钮：`clockRegexGen`（🤖 AI 捕捉正文 → 生成正则）、`clockRepair`（🩺 AI 结合正文修复日期时间）；动作名进 `CLOCK_ACTIONS`，经面板统一分发 |
| `FTT.*` | `index.js` + `devtools.js` | `clockRegexGen` / `clockRepair` / `clockRepairPack` |

## 2. 与 V1 的偏差（逐条明示）

1. **AI 调用通道**：V1 自建 OpenAI 兼容请求（`cfg.apiUrl` + `cfg.model` + `D.fetch`，带并发队列与 90s 超时、可被「中断」按钮中止）；
   V2 统一走**宿主生成能力**（`host/generation.js#rawGenerate` → ST `generateRaw`），提示词仍按 V1 的 messages 结构构造
   （`promptToGenerateArgs` 合并 system/其余）。因此 V2 不涉及 API 地址/密钥配置，也不需要自建请求队列。
2. **取文与占用**：取文经注入钩子（`setClockAiHooks({ callAi, feedText, busy })`），内核不直连网络也不读宿主聊天；
   V1 的「任务管线占用」UI（`pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`）未移植，
   V2 以 `busy()` 钩子（宿主接 `extractBusy()`）**在任务在途时直接拒绝**并如实提示（与 B7-2 同步的处置一致）。
3. **提示词模板来源**：V1 取 `cfg.promptTemplates` + `defaultCfg.promptTemplates`；V2 取 `cfg.promptTemplates` +
   内置 `PROMPT_TEMPLATES_V2`（两处模板均已在 B6 交付，键名相同：`clockRegexGen` / `clockRepair`）。
4. **未移植的 V1 细节**：`notify('repair', …)` 的过程提示样式（V2 用普通 info 提示）、`abortQuiet` 的中断语义
   （V2 无「中断 AI 请求」通道，ST `generateRaw` 不可取消）。

## 3. 验证（v2.12.0）

- 门禁：`npm run gate` → 单元 **34 文件 / 459 断言**、冒烟 **76 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。
- 单元 `tests/unit/clock-ai-golden.test.js` **17 项**：
  - 与**真实 V1 插件**（`tests/unit/helpers.js` 加载 v1.206 + `stubFetch` 固定 AI 返回）逐项比对：
    `normalizeClockRegexFromAi` 7 组、`genClockRegexes` 成功/失败两例（applied/skipped/hits/probe/regexes 全等）、
    `clockRepairPack`、`buildClockRepairPrompt`（system+user 逐字符）、`applyClockRepairResult`（修正 2 / 清空 1 / 丢弃不合格 2 /
    无法判定 1 + 状态逐条）、`runClockRepair` 端到端（含状态改写）、无可信锚点拒绝；
    黄金样本：`tests/fixtures/v1-golden-clock-ai.json`（含楼层正文 / 三份 AI 返回 / 异常场景 / delta 回放输入）。
  - V2 自身行为：提示词构建、无可用正文不调用 AI、长任务占用拒绝、AI 无返回不改数据、无异常条目直接回报、
    未命中项不覆盖既有正则、基础页两个按钮就位、面板动作 `clockRegexGen` / `clockRepair` 分发与提示回填。
- 冒烟 Q1–Q4：按钮与 `FTT.*` 入口、AI 捕捉正则写入 cfg 与试算、AI 修复只改日期/时间字段（无可信锚点拒绝且不调用 AI）、
  面板动作可达。

## 4. 后续（B8-4 起）

- **B8-4+**：各类修复（记忆/原子/物品/概念/角色/场景/计划悬念）、NSFW 弱化（词条库 + 固定规则库）、
  情节总结与分段总结管线、传言演化、平行推演与转正、遗忘清扫、世界书单向镜像。
- **B9**：调试页（日志/缓存/重载）、预设导入导出、条目瘦身与 gzip 传输、`promptPreview`。
