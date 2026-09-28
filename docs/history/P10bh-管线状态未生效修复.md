# P10bh · 修复「管线状态」：倒计时 / 流文字展示从未真正生效（v2.95.0）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v2.95.0）
> 依据：`docs/history/P10bc-管线状态流式摘要与token倒计时.md`（v2.90.0 原始交付与口径）
> 触发（用户原话）：「管线状态之前要求追加的倒计时、流文字展示等，都没有生效。请核对并修复。」

---

## 1. 结论先说：v2.90.0 交付了内核，但**接错了地方**

`core/pipeline.js`（token / ETA / 流式 / 结构摘要）与面板那一行本身是好的，
但**没有任何一条真实链路把它喂饱**。用户看到的因此一直是旧版的「正在分析记忆（AI 摘要） · 分段 x/y · 已用时 Ns」，
或者干脆是「空闲」。四处断点如下。

| # | 断点 | 事实 | 用户可见症状 |
| --- | --- | --- | --- |
| ① | **摘要管线从未进管线状态** | v2.90.0 声明的唯一接入点是 `core/ai-hooks.js#aiCallText`；但 `host/extract.js` 的**三处**摘要 AI 调用（独立分组每组 `:214` / 单楼分析 `:288` / 分段摘要 `:405`）都直连 `rawGenerate` → 绕过该出口 | 用户真正盯着的「批量摘要 / 单楼分析」**token=0、无倒计时、无阶段、无结构摘要** |
| ② | **面板只认批次忙位** | `pipelineStatusText()` 与 500ms 心跳都以 `hooks.busy()`（= `extractBusy()`）为闸门 | **单路 AI**（弱化NSFW / 自动修复 / 推演 / 时钟 / 情节总结）全程「空闲」，那一行没机会出场 |
| ③ | **流文字展示是假的** | 非流式通道把**整段响应**当「流式 1 块」上报；且没有任何真实分块来源 | 「流式 1 块」是谎报；响应字数只在最后一次性出现 |
| ④ | **ETA 样本接线太晚** | `setPipelineHooks` 只在 `openPanelPopup` 里接线（且 `pipelineEta` 一度未登记，见 P10bg §6） | 倒计时永远停在「（默认）」 |

## 2. 逐条修复

| 断点 | 修复 | 位置 |
| --- | --- | --- |
| ① | 三处摘要调用统一改经新增 `genTracked(gen, args, label, phase, callLabel)` 记账：`beginPipeline` → 透传 `onToken` → 响应后 `noteResponseText` + `setPipelineKeys` + 阶段「解析响应」→ `endPipeline` | `host/extract.js` |
| ② | 忙位改为 **批次忙 或 管线忙**；单路任务显示「正在处理：<行为>」并同样启停心跳（500ms） | `ui/panel.js#pipelineStatusText` / `#syncPipelineTick` |
| ③ | 新增 `noteResponseText()`（整段响应只记字符数、**不计块**）与真分块 `addStreamChunk()`；接通**酒馆官方流式通道** `sendRequest(..., {stream:true})` → 生成器 `for await` → 按 ST 的**累计文本**口径切成增量回调 | `core/pipeline.js` / `host/api-channel.js#sendViaProfile` / `host/generation.js#rawGenerate` |
| ④ | `pipelineEta` 历史读写移到**装配期**接线（`wirePipelineHooks()`），与其它内核钩子同批 | `index.js` |

### 2.1 为什么「官方流式」只在「酒馆连接配置」通道可用

实测 ST `release` 源码：

- `generateRaw` → `generateRawData` 走的是**一次性**请求（`await sendOpenAIRequest('quiet', …)` / `fetch` + `response.json()`），
  **不提供任何逐块回调**；`event_types.STREAM_TOKEN_RECEIVED` 只在**酒馆自己的聊天生成**（`StreamingProcessor.generate()`）里发出。
  故「跟随酒馆当前连接」与「自建连接」通道**结构上拿不到分块**（自建连接还受黄金样本约束：请求体恒为 `stream:false`）。
- `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, { stream: true }, override)`
  在 `stream: true` 时**返回一个函数**；调用它得到异步生成器，逐块产出 `{ text, state }`，
  其中 `text` 是**累计文本**（不是增量）—— 这是酒馆官方 `/profile-genstream` 的用法（`connection-manager/index.js`）。
  本版据此实现：按「与已收文本的差集」切增量 → `addStreamChunk`；生成器为空或抛错 → **静默回落**一次性请求。

API 页「通道差异说明」已如实标注：只有「酒馆连接配置」通道支持逐块流式；
另两个通道仍会给 token 计数与预估倒计时（信息不缺失，只是没有块数）。

## 3. 顺带加固

| 项 | 说明 |
| --- | --- |
| **并发安全** | 摘要「独立分组」最多并行 10 路请求。旧实现只有一个 `cur` 槽 → 后开始的覆盖前一个、先结束的清空还在跑的 → 状态时有时无。现在按 `runId` 维护活跃表，快照**聚合**为一条读数并显示「并发 N 路」 |
| **结构摘要更干净** | `summarizeResponseKeys()` 改为**优先解析 JSON 只取顶层键**。旧实现用正则扫 `"key":`，把 `{"atoms":{"add":[{"title":…}]}}` 显示成「atoms / add / title / text / date」——既吵闹又泄漏内部结构；解析失败（流式中/截断）再回退正则 |
| **只读诊断** | 新增 `lastPipelineInfo()`（上次行为 / 耗时 / 识别到的顶层键 / 响应字数，**不含正文**），供面板与调试排查 |
| **门禁补强** | `scripts/check-core-refs.js` 补上 `for await (const x of …)` 的声明识别（此前会把它误报成「未定义标识符」，挡住一切异步迭代写法） |

## 4. 修复后的那一行（真实读数）

```text
空闲
正在处理：批量摘要 · ⏱ 12s · 🪙 12.1k tok · 预计剩 8s · 流式 37 块 / 1.9k 字 · 并发 2 路 · 阶段：解析响应
正在分析记忆（AI 摘要） · 分段 1/4 · 第 1-8 楼 · 批量摘要 · 已用时 7s · ⏱ 0s · 🪙 6.1k tok · 预计剩 20s（默认）
```

- 「已用时」= 批次读秒（既有口径）；`⏱` = **当前这次 AI 调用**的读数（两者含义不同，批次线并存，单路线只留一个避免重复）；
- 「预计剩」跑过一轮后即去掉「（默认）」，改用**实测均值**（每行为最近 5 次，样本 ≥3 时去最大最小各一个）；
- 「流式 N 块 / N 字」只在**真的收到分块**时出现。

## 5. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增单测 | `tests/unit/pipeline.test.js` **F1–F9 + D1b**（10 项）：单楼/分段真实进管线 · 结构摘要入库且**不泄漏正文** · 流式块只在真分块时出现 · 并发聚合 · 面板单路忙位 · 阶段进行态 · 官方流式通道的**增量切分**与两种回落 · 倒计时随实测收敛 · 英文键响应只取顶层键 |
| 新增冒烟 | **BI1**（真实分段摘要**在途期间**读那一行：标签 / token / 倒计时 / 阶段齐备，且样本真的落进 ST 扩展设置 `pipelineEta`）· **BI2**（批次空闲、仅管线忙时状态行与 500ms 心跳都活起来；管线结束即停表） |
| 单元测试 | ✅ **117 文件 / 1771 断言** |
| 冒烟测试 | ✅ **178 项** |
| UI 规范检查 | ✅ 0 命中（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `2.95.0`，tag `v2.95.0` |

## 6. 边界与未做

| 项 | 口径 |
| --- | --- |
| token 仍是**估算** | `ceil(字符数/4)`；宿主不返回 usage，文案不声称精确 |
| 「流式」的粒度 | 块数 = 酒馆连接配置通道收到的生成器节拍（服务端分包粒度），**不是** UI 逐字刷新的帧数 |
| 未做 | 分段级 ETA（按已完成段的实测速度外推剩余段）；`/profile-genstream` 那种带思考过程的独立流式显示窗 |
