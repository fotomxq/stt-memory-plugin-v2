# P10am · 总览「查看提取内容」改为查看注入内容（v2.75.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.75.0）
> 触发（用户要求）：「总览中查看提取内容，应该展示的是**注入内容**，而不是**提取的 JSON 结构**。」

---

## 1. 改动

总览「📤 最后一次提取」下面的折叠块，**内容源**由「最后一次提取的 AI 回复原文（JSON）」改为
「**当前实际注入给 AI 的正文**」：

| 项 | 修复前 | 现在 |
| --- | --- | --- |
| 折叠标题 | 查看提取内容（AI 回复原文，最多 N 字） | 查看注入内容（当前注入给 AI 的正文，N 字） |
| 内容 | `lastExtract().text`（AI 回复，形如 `{"atoms":{"add":[…]}}`） | `readInject()`（ST 注入通道读回：结构头 + 各区块正文 + `记忆结束。`） |
| 无内容时 | 整块不渲染 | **如实说明原因**：注入开关关闭 / 未命中 / 记忆库为空 + 如何打开 |
| 高度 | `.ftt-extract-pre`（v2.66.0 起 min-height 160px / max-height 46vh） | 同（沿用） |
| 标记 | 无 | 内容块带 `data-ftt-inject-preview`（测试与排障锚点） |

## 2. 落点

- `ui/panel.js#overviewBody`：折叠块改为渲染 `hooks.injectText()` 的返回值；不再依赖 `lastExtract().text`。
- `index.js#panelRuntimeHooks`：新增 `injectText: () => readInject()`（`host/inject.js#readInject` 读回 ST 注入通道）。
- AI 回复原文**仍然留存**（不丢数据）：`FTT.lastExtract().text`、调试日志（「摘要」类）与「最后一次提取」一行里的
  `AI N 字`/维度/关键词都还在，只是不再占用总览版面。

## 3. 与其它批次的衔接

- v2.59.0 引入的「最后一次提取」组件**保留**（时间/来源/楼层/新增/维度/关键词/校对结果一行不变）；
- v2.66.0 的 `.ftt-extract-pre` 高度修复**继续生效**（折叠块内容换源但样式类不变）；
- v2.74.0 的召回/注入链路不变：注入内容就是「向量 → JS → AI」三层流程按开关写入提示词的那一份，
  因此这个折叠块现在**所见即所注入**，可直接用来核对开关与召回结果。

## 4. 门禁

- `tests/unit/overview-last-extract.test.js`
  - U3 改为：折叠块 = 注入内容（标题字数与实际注入长度一致、内容以 `【FTT记忆注入】` 开头、`data-ftt-inject-preview` 存在），
    且**不含** AI 回复里的条目 id / `"atoms"` 字样；
  - 新增 U4b：注入为空时总览给出「当前没有注入内容（注入开关关闭 / 未命中 / 记忆库为空）」；
  - 测试内按开关真实推送一次注入（`cfg.injectCurrentPrompt = true` + `pushMemoryInject`）以覆盖有内容分支。
- `tests/unit/overview-layout.test.js` O2：折叠块改按「查看注入内容」定位，断言 `.ftt-extract-pre` 与注入样本。
- 冒烟 `BA3`：改为在**折叠块切片内**断言「是注入内容、无 JSON 原文」——注意 `popupAction().html` 是整块面板 HTML
  （可能含其它分页内容），因此不再对整页做 `indexOf` 判定。
