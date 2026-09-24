# P8m · B8-4 内容弱化（NSFW）（识别词条库 + 固定规则转化库 + AI 弱化）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.13.0）
> 关联：`core/nsfw.js`（新）、`core/ai-hooks.js`（新，共用 AI 钩子）、`core/prompt.js`（复用规则文本）、`ui/nsfw.js`（新）、
> `ui/settings-pages.js`、`ui/panel.js`、`index.js`、`devtools.js`、`docs/P8-功能对齐总表.md`

---

## 1. 覆盖范围（V1 源 `09-AI摘要与楼层处理.js` NSFW 族 + `13` safety 页 + `14` 动作）

| V1 能力 | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| 识别词条库（v1.197） | `core/nsfw.js` | 内置 **63 条**（中文原样匹配、英文不区分大小写）；`cfg.nsfwKeywords` 自定义库（非空即生效）；增/改/删/恢复内置 —— 按「生效列表索引」定位，首次编辑把内置库**物化**为自定义列表 |
| 固定规则转化库（v1.198/199） | 同上 | 内置 **63 条**（与识别词条**逐条对应**，顺序一致）；`cfg.nsfwRules` 自定义库（`{from,to}`）；`cfg.nsfwReplaceAuto`（默认开：交 AI 前先跑一次机械替换） |
| `nsfwApplyRules` | 同上 | **对原文单遍匹配 + 区间占位**：不链式二次转换（A→B 的规则不会再被 B→C 命中）、结果与规则顺序无关；重叠按「匹配词更长者优先」；中文字面替换、英文 `\b词\w*`（忽略大小写）+ **误伤名单**（cumulative / circumstance 一类普通词既不替换也不计命中） |
| `nsfwKeywordHits` / 预筛 | 同上 | 与替换**同一判定口径**；按「生效词条库签名」缓存的预筛正则（无命中字段直接跳过逐词循环，不改变命中结果） |
| `nsfwScan` / `nsfwSoftenPack` | 同上 | 12 维字段白名单（含嵌套对象/数组展开）逐字段扫描；**已总结隐藏的情节不参与**；命中多者优先，单批 12 条 + 截断数 |
| `nsfwFixedReplace` | 同上 | 零 AI 落地：命中即写回 + **镜像字段同步**（情节 `text ↔ content`）+ 刷新 `updatedAt`（跨端合并取较新） |
| `buildNsfwSoftenPrompt` / `applyNsfwSoftenResult` | 同上 | 提示词取模板 `promptTemplates.nsfwSoften`；应用时**强校验**：结果不得仍含关键词、长度不得超过 `max(24, min(600, 原文×1.4))`、只写命中字段；「无变化 / 无法处理 / 未知编号」分别计数 |
| `runNsfwSoften` | 同上 | 先跑固定规则替换（默认开）→ 剩余命中交 AI 二次弱化；忙位互斥；如实回报（含 `fixed` 阶段已处理量） |
| 分析侧规则 | `core/prompt.js` + `core/nsfw.js` | `cfg.nsfwSoftenEnabled`（默认关）开启时把模板 `nsfwSoften` 追加进 `buildSummaryPrompt` 系统提示词，让「读正文 → 分析成记忆」这一步就不产生露骨描写 |
| 设定页「内容弱化」 | `ui/nsfw.js` | V1 四节：内容弱化 / 固定规则替换（不调用 AI 的机械转化）/ 转化库编辑器 / 识别词条库编辑器 + 状态行与动作按钮 |
| 总览入口 | `ui/panel.js` | V1 同款「🌶 弱化NSFW（N）」按钮（工具行内）+ 分析侧开关开启时的状态行（含逐维度命中数） |
| 动作名（V1 逐字） | `ui/nsfw.js` + `ui/panel.js` | `nsfwSoften` / `nsfwRuleApply` / `nsfwKwAdd` `nsfwKwSave` `nsfwKwDel` `nsfwKwReset` / `nsfwRuleAdd` `nsfwRuleSave` `nsfwRuleDel` `nsfwRuleReset`（共 10 个） |
| `FTT.*` | `index.js` + `devtools.js` | `nsfwState` / `nsfwSoften` / `nsfwFixed` / `nsfwScan` / `nsfwHits` / `nsfwApply` / `nsfwKeywords` / `nsfwRules` / `nsfwKeywordAdd|Delete|Reset` / `nsfwRuleAdd|Delete|Reset` |

## 2. 与 V1 的偏差（逐条明示）

1. **AI 通道**：V1 自建 OpenAI 兼容请求；V2 走共用注入钩子 `core/ai-hooks.js`（宿主接线：ST `generateRaw`），
   与 B8-3 时钟域 AI 管线同一套接线；`clock-ai.js` 的 `setClockAiHooks` 保留为兼容别名（内部委托同一钩子）。
2. **任务管线 UI 未移植**：V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`（顶部管线提示与中断）在 V2 不存在；
   本批以 `busy()` 钩子（宿主接 `extractBusy()`）**在长任务在途时拒绝**并如实提示。
3. **未移植的 V1 细节**：`abortQuiet` 的中断语义（ST `generateRaw` 不可取消）；`nsfwSoftenState()` 的按维度标签映射仍按 V1
   （UI 侧显示中文标签）。
4. **库条目动作的取值来源**：V1 从面板 DOM 读输入框；V2 优先取 payload（`{text}`/`{idx}`/`{from,to}`），
   无 payload 时回退 DOM（`data-ftt-nsfw-*`）—— 语义一致，便于测试与命令行调用。

## 3. 验证（v2.13.0）

- 门禁：`npm run gate` → 单元 **35 文件 / 481 断言**、冒烟 **81 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。
- 单元 `tests/unit/nsfw-golden.test.js` **22 项**：
  - 与**真实 V1 插件**（`tests/unit/helpers.js` 加载 v1.206 + `stubFetch` 固定 AI 返回）逐项比对：
    库规模与内容（63/63/12 维/单批 12）、`nsfwApplyRules` 6 组文本、`nsfwKeywordHits` 6 组、单遍不链式 + 长词优先、
    词条库 6 步操作序列、转化库 5 步操作序列、`nsfwScan`（隐藏情节排除 + 嵌套/数组展开）、`nsfwSoftenPack`、
    `buildNsfwSoftenPrompt`（逐字符）、`nsfwFixedReplace`（含镜像同步与状态）、`applyNsfwSoftenResult`（合格/无变化/仍含关键词/过长/未知编号/无法处理）、
    `runNsfwSoften` 两条路径（固定规则先跑 → 无需 AI；关自动阶段 → AI 二次弱化 + 状态）、`nsfwSoftenState`；
    黄金样本：`tests/fixtures/v1-golden-nsfw.json`（含回放输入）。
  - V2 自身行为：分析侧规则开关与 `buildSummaryPrompt` 追加、无命中不调用 AI、长任务拒绝、AI 无返回不改数据、
    设定页四节与 10 个动作按钮、词条库/转化库动作（payload 取值）、面板分发 `nsfwSoften` / `nsfwRuleApply`。
- 冒烟 R1–R5：设定页渲染、固定规则替换零 AI 落库（含 `updatedAt`）、AI 弱化（含关键词结果被丢弃）、
  `FTT.*` 入口与库动作、总览「🌶 弱化NSFW」按钮与状态行。

## 4. 后续（B8-5 起）

- **B8-5+**：各类修复（记忆/原子/物品/概念/角色/场景/计划悬念）、情节总结与分段总结管线、传言演化、
  平行推演与转正、遗忘清扫、世界书单向镜像。
- **B9**：调试页（日志/缓存/重载）、预设导入导出、条目瘦身与 gzip 传输、`promptPreview`。
