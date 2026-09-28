# P10bm · 管线状态：全请求覆盖 + 默认隐藏 / 自动出现 / 并行多行（v3.0.0）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.0）
> 触发（用户原话）：
> 「1. 所有 AI 请求无论是否存在并行，都应该在管线出现提示信息；
>   2. 管线状态默认不显示，如果有请求、同步等各类动作时自动出现，且如果有并行时出现两个或两个以上，根据需求展现。」
> 相关：`docs/history/P10bc`（v2.90.0 管线状态内核）· `docs/history/P10bh`（v2.95.0「单路 AI 也要显示」）

---

## 1. ① 覆盖面：所有请求 / 各类动作都进管线

**改造前的缺口**：只有 **AI 文本调用**进管线（`core/ai-hooks.js#aiCallText` 与 `host/extract.js#genTracked`）。
向量请求、连通性测试、保存、同步、世界书镜像、召回构建**都看不见**。本版逐条补齐：

| 文件 | 管线标签 | 类别 | 备注 |
| --- | --- | --- | --- |
| `host/embeddings.js` | 向量检索（embedding） | `ai` | token 按输入文本量估算 |
| `host/embeddings.js` | 精排（rerank） | `ai` | |
| `host/api-channel.js` | 连通性测试（chat/…） | `ai` | 用户点「🧪 测试」 |
| `host/api-channel.js` | 获取模型列表 | `ai` | 用户点「📦 获取模型」 |
| `host/inject.js` | 提取记忆（召回 + 注入） | `task` | 内部走向量检索时会**再出现一条**向量行（嵌套可见） |
| `adapters/store.js` | 保存记忆文件 | `io` | 合流（见 §3） |
| `adapters/sync.js` | 跨端同步（含备份）· 刷新状态（取服务端）· 保存后对账同步 · 校验并修复 | `sync` | 即使被 busy / 长任务拒绝也**如实收尾** |
| `adapters/worldbook.js` | 世界书镜像（单向写入） | `sync` | 合流 |

新增内核 API：

```js
// 一行接线：自带收尾（异常也结束、不吞异常）
await trackPipeline('跨端同步', { kind: 'sync', phase: '拉取对端' }, async (ctl) => {
    ctl.phase('推送对端');            // 阶段
    ctl.chunk('…');                   // 真流式块（可选）
    ctl.respond(text);                // 整段响应（可选）
    ctl.keys(['情节']);               // 结构摘要（可选）
    return …;
});
```

**接线纪律**：`host/inject.js` 的登记**嵌在原函数体内**（`beginPipeline` + 既有 `try` 的 `finally`），
**不新增 async 层** —— 否则 `pushMemoryInject` 的完成时序会多一个微任务，`injectInFlight()` 的观察窗变化会让
既有时序敏感测试（`recall-parallel` F3）失败。这条经验写进注释，后续接线沿用。

## 2. ② 展示：默认隐藏 · 自动出现 · 并行一行一条

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 容器 | 常驻一行 `[data-ftt-pipeline-label]`，空闲时写「空闲」 | `[data-ftt-pipeline-box]` **块 + 0..N 行**（`data-ftt-pipeline-row="<runId>"`），整块默认 `display:none` |
| 空闲 | 常驻显示「空闲」 | **整块隐藏**（总览更干净） |
| 出现的时机 | 只在「忙位期间」心跳；后台动作要等下一次整页重绘 | 心跳**常驻总览**（面板开着 + 停在总览即 500ms），后台动作一启动就出现（无需重绘） |
| 并行 | 永远一行（聚合读数） | **一行一条**（最新在前），每行独立读秒 / token / 倒计时 / 流式 / 阶段 |
| 批次进度 | 挂在唯一那一行 | 只挂在**批量摘要那一行**（不再误挂到第一行） |
| 停表 | 忙位结束即停 | 切页 / 关闭面板 / 卸载 / 拿不到块节点才停（不泄漏定时器） |

单行文本形状（`pipelineRunLine()`）：

```text
[AI] 批量摘要 · ⏱ 12s · 🪙 12.1k tok · 预计剩 8s · 流式 37 块 / 1.9k 字 · 阶段：解析响应 · 分段 3/8 · 第 1-8 楼
[同步] 跨端同步（含备份） · ⏱ 2s · 预计剩 8s（默认） · 阶段：推送对端
[存储] 保存记忆文件 · ⏱ 0s · 预计剩 1s（默认） · 阶段：写入存储 · 合并 2 次
```

- 类别标签：`AI` / `同步` / `存储` / `任务`（`PIPELINE_KIND_LABEL`）；
- 既有 `pipelineStatusText()` / `snapshot()` / `pipelineSuffix()` 文本口径**保留**（兼容既有调用点与测试）；
- 样式：新增 `#ftt-panel .ftt-pipe-line`（不换行 + 溢出省略），块本身用 flex 列。

## 3. 同标签合流（引用计数）

一次落库链里可能调用两次「保存记忆文件」（保存流水线内部再触发一次），若各占一行会刷屏。
`beginPipeline(label, { join: true })` 在**同标签已在跑**时不再新开行，而是给已有行 `refs += 1`；
`endPipeline` 按引用计数递减，**最后一个**才真正移除并记录耗时样本；行上显示「合并 N 次」。

## 4. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增单测 | `tests/unit/pipeline-coverage.test.js`（**9 项**）：向量 / 精排 / 连通性测试 / 获取模型 / 保存 / 跨端同步 / 刷新状态 在途各出现一行且类别正确 · 并行两路都在 · 异常成对收尾（不吞异常）· **静态审计**（`host/ adapters/` 里所有直接用 `globalThis.fetch` 的业务文件都必须在管线登记表内 —— 防止以后新增请求漏登记） |
| 重写单测 | `tests/unit/pipeline-tick.test.js`（**17 项**）：S 文本口径不变 · T 心跳与「内容没变不写」· **W 三项要求**（默认隐藏 / 自动出现 / 三路并行三行 / 行数随结束递减 / 每行信息量 / `trackPipeline` 一行接线）· Z 停表与不泄漏 |
| 既有测试适配 | `overview-layout` O1、`panel` P1 改为新容器标记；`panel-audit` L5 白名单补 `pipeline-row` 说明；冒烟 BI2 改为块口径 |
| 新增冒烟 | **BM1**（空闲隐藏 → 真实单楼分析期间自动出现且**不带批次进度** → 结束后该行消失）· **BM2**（AI + 同步 + 存储三路并行 → 三行，逐路结束递减至隐藏） |
| 单元测试 | ✅ **121 文件 / 1833 断言** |
| 冒烟测试 | ✅ **185 项** |
| UI 规范检查 | ✅ 0 命中（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `3.0.0`，tag `v3.0.0` |

## 5. 改动文件

| 文件 | 性质 |
| --- | --- |
| `core/pipeline.js` | `kind` · `PIPELINE_KIND_LABEL` · `listPipelineRuns()` · `pipelineRunLine()` · `pipelineLines()` · `trackPipeline()` · `beginPipeline({join})` 引用计数 |
| `ui/panel.js` | 管线块 `[data-ftt-pipeline-box]` + 0..N 行（`pipelineBoxRowsHtml()` / `updatePipelineStatusDom()`）；心跳常驻总览；批次进度只挂批量摘要行；「✖ 中断」只随批次出现 |
| `style.css` | `.ftt-pipe-line` 行样式 |
| `core/ai-hooks.js` · `host/extract.js` | AI 文本调用 / 摘要调用的运行类别标为 `ai` |
| `host/embeddings.js` | 向量 / 精排请求登记 |
| `host/api-channel.js` | 连通性测试 / 获取模型登记 |
| `host/inject.js` | 提取记忆（召回 + 注入）登记（内嵌、不新增 async 层） |
| `adapters/store.js` | 保存记忆文件登记（合流） |
| `adapters/sync.js` | 四个入口加壳（`…Inner`）+ 登记 |
| `adapters/worldbook.js` | 世界书镜像登记（合流） |
| `tests/unit/pipeline-coverage.test.js` | 新增 |
| `tests/unit/pipeline-tick.test.js` | 重写为 v3.0.0 口径 |
| `tests/unit/{overview-layout,panel,panel-audit}.test.js` · `tests/smoke-test.js` | 标记与断言适配 + BM1/BM2 |

## 6. 边界（有意保留）

| 项 | 口径 |
| --- | --- |
| 行序 | **最新开始的在前**（新动作出现在顶部，便于看到「刚刚开始的那个」） |
| 显示门槛 | 无（极短动作可能落在两次心跳之间、从未被看见 —— 这正好避免了闪烁） |
| `pipelineStatusText()` | 保留为「单行聚合文本」的兼容口径（命令 / 诊断 / 既有测试用）；总览改用块 |
| 非网络类长动作 | 目前只登记了会明显占用时间的（保存 / 同步 / 镜像 / 召回 / AI / 向量）；纯计算型（快照整理、脚本化修复）本身很快且有各自的完成提示 |
