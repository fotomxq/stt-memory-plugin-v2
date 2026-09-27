# P10af · 状态大类总是没数据：提示词维度键不匹配（v2.68.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.68.0）
> 触发（用户报告）：「状态大类**总是没数据**，请核对**提示词**、**分析记忆**等位置是否存在问题。」

---

## 1. 真根因

提示词构造器按 **V1 模板键**逐维度拼装维度说明：

```js
// core/prompt.js#buildSummaryPrompt（V1 逐字）
for (const d of dimList) { if (d === 'plans') lines.push(pt.plans || ''); else if (pt[d]) lines.push(pt[d]); }
```

V1 的 `DIMENSIONS` = `['atoms','states','snapshots','memories','items','plans','scenes','concepts','currencies','rumors']`
—— **就是模板键**；而 V2 的容器 kind 是 `currentStates`（`core/constants.js#DIMENSIONS`）。

提取链路把 **V2 kind** 直接传了进去：

```js
// host/extract.js（修复前）
const dims = (Array.isArray(o.dims) && o.dims.length ? o.dims : enabledDims());   // ← V2 kind：含 currentStates
const messages = await buildSummaryPrompt(text, dims);                             // pt['currentStates'] → undefined
```

于是：

| 维度 | V2 kind | `pt[kind]` | 结果 |
| --- | --- | --- | --- |
| 状态记录 | `currentStates` | ❌ 不存在 | **「状态记录」抽取说明（1104 字）从不进提示词 → AI 不知道要抽状态 → 状态大类长期为空** |
| 情节 / 角色档案 / 记忆 / 物品 / 计划 / 场景 / 概念 / 货币 / 传言 | 同名 | ✅ | 正常 |
| 平行事件 | `parallels` | ✅ 存在（该模板属交织管线） | **被误塞进摘要提示词**（V1 摘要不抽平行事件） |
| 关联层 / 分段总结 / 悬念 | `links` / `plotSegments` / `suspense` | ❌ | 被忽略（悬念随 `plans` 模板一起请求） |

## 2. 修复

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `host/extract.js#summaryDimsForPrompt()`（新增） | 把任意维度输入（V2 kind 或 V1 键）投影为 **V1 摘要维度键**：`currentStates`→`states`（`KIND_TO_SUMMARY_DIM`），按 V1 顺序去重，剔除无摘要模板的容器；全部被剔除时回落全 10 维 |
| ② | `host/extract.js` | `analyzeFloor` / `analyzeSegment` 的提示词维度一律走 `summaryDimsForPrompt()`（`runSummarySeparate` 早已用 V1 键分组，口径就此统一） |
| ③ | `host/extract.js#enabledDims()` | 维度开关认 **V1 别名键**：`dimensionEnabled.states === false` 也视为「状态关闭」；**精确键优先**（`currentStates:true` 可覆盖遗留的 `states:false`） |
| ④ | `ui/settings-panel.js#dimsCheckboxHtml()` | 勾选态与执行侧同口径（V1 存档关过「状态」时界面显示为关） |
| ⑤ | 诊断 | `extractSummary().promptDims`、`FTT.summaryDims()` 直接列出「本次会请求哪些维度」 |

## 3. 黄金样本为什么没拦住这个 BUG（已修）

旧 `tests/fixtures/v1-golden-prompt.json` 的 `dims` 记的是 **V2 容器 kind**（`currentStates`/`parallels`/`plotSegments`/`npcs`），
即把「错误的维度输入」喂给了 V1 的 `buildSummaryPrompt`，于是「缺状态模板、混入平行事件」被固化成「V1 原样」——
`extract-prompt-flow` 的逐字节比对因此一直是绿的。

现在新增 `tests/fixtures/gen-v1-golden-prompt.cjs`：从 **V1 源码**读出 `const DIMENSIONS = [...]`（v1.206 1128）作为输入，
重新生成样本并记录每段模板签名。重建结果：

- `dims = ['atoms','states','snapshots','memories','items','plans','scenes','concepts','currencies','rumors']`（V1 键）；
- 模板签名 **10/10 全在** + `【当前状态】` 锚点在；**`【平行事件】`不在**；
- system 段长度 18666 → 17553 字（新增「状态记录」1104 字、去掉误入的「平行事件」模板）；
- `extract-prompt-flow` 的逐字节比对在新样本下**依旧通过** → 证明 V2 的提示词构造器确实与 V1 逐字一致，
  此前不一致的只是**喂进去的维度键**。

## 4. 门禁

`tests/unit/state-extract.test.js`（13 断言）：

- R1 键投影（含顺序与回落）；R2 **真实流水线**（`analyzeFloor` 捕获提示词）含「状态记录」且不含「平行事件」；R3 黄金样本签名；
- S1 单楼 states 落库（主体/字段/值）；S2 「更新」合并为一条并写入变更史；S3 批量分析同源；S4 中文键 `{"状态记录":{"新增":[…]}}` 经 `CN_KEY_MAP` 归一后落库；
- T1 V1 别名键关闭生效；T2 V2 精确键关闭生效且精确键优先、勾选框同口径；T3 显式 `dims:['currentStates']` 只带状态模板；
- U4 状态页能看到该条；U5 `promptDims` 诊断；U6 `summaryDimGroups` 同源。

## 5. 排查同类问题的固定动作

某大类「总是没数据」时按顺序看：

1. `FTT.summaryDims()` / `extractSummary().promptDims` —— **该维度在不在本次请求里**；
2. 提示词原文（调试日志「摘要」类里的 `dims` 字段 / `FTT.debugLogExport()`）—— 该维度的**抽取说明段**在不在；
3. `deltaKeys`（`lastExtractRecord()`）—— AI 有没有按维度键返回；
4. 键名映射 `CN_KEY_MAP`（中文键 → 英文键）与 `mergeDelta` 的对应分支。
