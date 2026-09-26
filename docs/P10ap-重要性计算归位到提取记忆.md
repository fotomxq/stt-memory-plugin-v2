# P10ap · 「重要性计算」归位到「提取记忆」页（v2.78.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.78.0）
> 触发（用户要求）：「设定的「重要性计算」是**提取记忆用的**，需迁移位置。」

---

## 1. 事实核对（为什么它属于「提取记忆」）

| 项 | 事实 | 出处 |
| --- | --- | --- |
| 读取方 | `calcImportance(item)` = `clamp(cfg.importanceBase + uses × cfg.importancePerUse, 0, 1)` | `core/recall.js` |
| 用途 | 召回打分 / 排序；列表行「调用N次 · 重要度M%」同读此函数 | `core/recall.js#importancePct` |
| 「调用次数」从哪来 | 条目**被召回命中**时 `markUsed` 累加 `uses` | `core/recall.js#markUsed` |
| 旁路影响 | 遗忘机制把重要度当保护阈值参考（`protectImp`） | `core/forget.js` |

即：这两项只影响**召回链路**（打分 + 命中累加），与投喂/分析/存储无关 → 应放在「提取记忆」页。

## 2. 变更

| 位置 | 变更 |
| --- | --- |
| 设定 → 基础 | 删除「重要性计算（调用次数驱动）」分节（原为 V1 位置）；原跨页指路句补为「『召回参数』与『重要性计算』在『提取记忆』页」 |
| 设定 → 提取记忆 | 新增分节「重要性计算（调用次数驱动）」，位于「召回上限（各大类注入条数）」之后、「其它召回行为」之前；含两项输入 + 一条短提示 + 折叠说明（公式、夹取范围、与召回/遗忘的关系） |
| 控件表 | `SETTINGS_CONTROLS`：`base` 11 → **9**、`extract` 22 → **24**（**纯搬运**，总数仍 **173**；键名与标签逐字不变 —— 与 V1 的排布**有意偏差**，仅位置不同） |
| 写回夹取 | `applySettingsControl` 对这两项按 V1 `settingsApplyAll`（v1.206 26743/26744）逐字夹取：`importanceBase ∈ [0,1]`、`importancePerUse ∈ [0,0.5]`，非法值回落 0 —— 此前 V2 只做类型转换、不夹取，用户可写出越界值 |

## 3. 验证

| 证据 | 结果 |
| --- | --- |
| `tests/unit/importance-placement.test.js`（新增 12 断言：控件表位置/标签逐字、基础页移除与指路、提取页独立分节与顺序、渲染键集合、夹取四态、写回返回值、召回打分真实生效、提示长度与去重） | 12 通过 / 0 失败 |
| `tests/unit/settings-pages.test.js` P2（逐页数量）、`tests/unit/settings-capacity.test.js` C5/C7、`tests/unit/analyze-grouping.test.js` A10 | 同步更新后全部通过 |
| 全量 `npm run gate` | 见 CHANGELOG 对应版本条目 |

## 4. 登记（本次未做，如实说明）

- `applySettingsControl` 目前只对**这两项**做了 V1 同口径夹取；V1 `settingsApplyAll` 还对约 30 个数值键做 `Math.max/min` 夹取
  （如 `maxAtoms` 下限 1、`vectorMinScore` 0-1、`lowUseForget*` 系列）。这是**既有偏差**（非本次引入），
  登记为待办项：后续如需严格对齐 V1 的「非法输入不得写坏配置」，应把整张夹取表补齐（含回归用例）。
- 与 V1 的排布差异：V1 把「重要性计算」放在「基础」页 —— 本版按用户要求迁入「提取记忆」页，属**有意偏差**；
  若要回退到 V1 排布，只需把两项控件移回 `SETTINGS_CONTROLS.base` 并恢复分节（语义与键名不受影响）。
