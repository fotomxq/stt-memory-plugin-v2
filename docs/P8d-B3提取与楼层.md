# P8d · B3 提取与楼层管理（V1 对齐）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效（v2.4.0）
> 关联：`host/extract.js`、`host/floors.js`、`ui/panel.js`、`scripts/check-core-refs.js`、`docs/P8-功能对齐总表.md`

---

## 1. 本批交付（对齐 V1 `runAutoSummary` / `abortAnalysis` / `clearFloors`）

| 能力 | V2 实现 | V1 对照 |
| --- | --- | --- |
| **分段批量摘要** | `runAutoSummary({silent})`：取范围 → 按 `cfg.summaryChunkSize`（默认 10）切段 → **一段 = 一次 AI 调用**（段文本 = 该段楼层行经投喂正则过滤）→ `mergeDelta(delta, 段范围)` → `recordProcessedFloors(段起, 段止)` | `runAutoSummary` 的分段循环 |
| **手动模式** | `silent=false`：范围 = 最近 `cfg.feedFloors`（回退 `summaryFloors`，默认 10）楼，且**跳过最近 2 楼**（生成中的半成品楼）；`cfg.timelyAnalysis=true` 时不跳过 | `timelySummaryEffLast` |
| **静默补全** | `silent=true`：范围 = 全部**未摘要 AI 楼**；整段已处理则跳过（零 AI 调用） | `isFloorRangeProcessed` |
| **单楼分析** | `summaryFloor` → `analyzeFloor`（既有）→ 提示「第 N 楼：新增 X 条」 | 单楼按钮 |
| **中断** | `abortExtract()`：**协作式**——段与段之间检查标志并停止；已完成段与落盘内容保留；返回 `aborted` 段数；`abortPending()` / `batchProgress()` 可读 | `requestAbortAll`（V1 可中止在途 HTTP；V2 用 ST `generateRaw`，无法取消在途请求，故在**段边界**生效，已在面板按钮 tooltip 与本文档写明） |
| **清除已处理记录** | `clearFloors()` → `clearProcessedFloors()`：清空 `processedFloors`、复位 `lastKnownFloor=-1`、重写版本签名、落盘；**不删除任何记忆条目** | `case 'clearFloors'` |
| **进度与动效** | 面板头部 `ftt-head-busy` + 「🔄 分析中 N/M 段（第 a-b 楼）」；未摘要楼层按钮中**当前段**加 `.ftt-floor-pulse`（V1 同名类） | `busyNoteHtml` / `updateFloorAnimDom` |
| **工具行按钮** | 总览工具行按 V1 补齐：`⚡ 立即 AI 摘要`（批量）、`📤 提取记忆`（逐楼）、`📤 立即注入`、`✖ 中断`、`🧹 清除已处理记录` | 总览工具行 |

返回统计：`{ ok, made, added, failed, floors:'起-止', segments, aborted, ms }`，并落入 `extractStats().lastBatch`。

## 2. 门禁扩容（本批附带的质量改进）

B3 实测踩到 `host/extract.js` 漏导入 `getLastMessageId`（表现为 `reason:'no-message'`）——
**旧门禁只扫 `core/`，拦不住宿主层的未定义标识符**。本批把 `scripts/check-core-refs.js` 扩展为
**扫描 `core/` + `host/` + `adapters/` + `ui/` + 入口 `index.js`/`devtools.js`（51 个文件）**，
并分层放行允许的全局（宿主层可用 `document/window/localStorage/fetch/toastr/$/…`；core 仍由纯净度门禁单独管）。
同时修好三类误报：`import { X as Y }` 的源名、`export { X } from '…'` 的再导出名、同一行内的对象方法简写与其参数。
扩容后立即发现了本批那处漏导入。

## 3. 测试（`tests/unit/extract-batch.test.js`，9 项）

- **S1** 分段构建（`buildSegments`：4 楼/段切分与末段收口、chunk 守卫回退默认）
- **S2** 段分析：一次 AI 调用 + 整段落库与记账 + 段文本含 `[第N楼 AI]` 前缀
- **S3** 失败段（无 JSON）**不记账**，已记段不受影响；**S3b** 空段（越界楼层）直接跳过 AI
- **B1** 手动模式：最近 `feedFloors` 楼 → 2 段 → 2 次 AI → 全部记账
- **B2** 静默补全：覆盖全部未摘要 AI 楼；再次调用无待分析段 → **零新增 AI 调用**
- **B3** 中断：首段完成后请求中断 → 仅 1 次 AI 调用、仅 2 楼记账、`aborted>0`、busy 归位
- **B4** 清除已处理记录：台账清空 + `lastKnownFloor=-1` + **条目数不变**
- **B5** 面板接线：`⚡` 触发批量、`✖ 中断` 调钩子、`🧹` 回填条数、提示文案与按钮存在

门禁：单元 **25 文件 / 331 断言**、冒烟 **55 项**、六道门禁（内核纯净度 / 标识符 / 词条 / 版本一致性 / 文档 + 单元 + 冒烟）全绿。

## 4. 尚未完成（B4 起）

- V1 `extractNow`（📤 提取记忆）原有「三层提取 + 预览 + 关键词链」：本批为逐楼 AI 摘要路径；三层/关键词流程与预览属后续批次；
- 楼层断裂检测（`detectFloorBreak`：楼层删除/回滚时重算已处理标记）与「按刷选择分析」；
- 自动空闲检查（`autoIdleCheck`）与逐段 `pipeStart/pipeUpdate` 的管线状态行（总览「🧵 管线状态」）；
- 设定 **14 组子页**（B4）、关系表与注入自查（B5）、提示词编辑（B6）、快照与同步（B7）、高级域（B8）、导入导出与调试（B9）。
