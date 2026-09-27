# P10aa · 管线状态读秒改为动态心跳（v2.63.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.63.0）
> 触发（用户要求）：「管线状态的**计时器不动**，需改进，应该是**动态变化**的。」

---

## 1. 问题

总览「🧵 管线状态」行的「已用时 Ns」只在**面板重绘**那一刻算一次。
分析一条长聊天要几十秒，而这期间面板通常不再重绘 → 读秒**停在首帧的值不动**（多为不显示或长期 0s）。

## 2. V1 对照（只读 oracle：`src/FTT记忆组件-v1.205.js`）

| V1 机制 | 位置 | 说明 |
| --- | --- | --- |
| `pipelineTickStart()` / `pipelineTickStop()` | 14547 / 14559 | 忙位期间 `setInterval(updatePipelineStatusDom, 500)`；无任务不空转；拿不到行节点不起表 |
| `busy.pipe.startedAt` + `pipelineElapsedSec()` | 14563 / 14572 | 起点是**任务真实开始时刻**，每次读都按 `Date.now()` 重算 |
| `updatePipelineStatusDom()` | 14613 | 只改那一行 `textContent`（**内容未变不写**），不整页重绘；并顺带刷新标题栏忙位提示与中断按钮 |
| 行标记 | — | `[data-ftt-pipeline-label]` |
| 空闲文案 | 14597 | 「暂无」 |

## 3. V2 落地

| # | 文件 | 改动 |
| --- | --- | --- |
| ① | `host/extract.js` | 新增 `extractState.busySince`；`analyzeFloors` / `runAutoSummary` 开始时置 `Date.now()`，`finally` 清零；`batchProgress()` 增加 `since` 字段 |
| ② | `ui/panel.js` | 新增 `pipelineStatusText(now)`（渲染与心跳共用的纯计算）、`updatePipelineStatusDom(now)`（只改文本、未变不写）、模块级 500ms 心跳 `syncPipelineTick()` / `stopPipelineTick()` / `pipelineTickState()` |
| ③ | `ui/panel.js` | 起停时机：`renderPanel()` **写完 DOM 之后**调用（此刻那一行才真的存在）；`closePanel()` / `unmountPanel()` 停表；切离总览停表；空闲停表；拿不到节点或管线已结束 → 心跳自停 |
| ④ | `ui/panel.js` | 行标记改名 `data-ftt-pipeline-label`（与 V1 同名，替换 v2.52.0 的 `data-ftt-pipeline`） |

读秒起点优先级：`batchProgress().since`（批次真实起点，对应 V1 `busy.pipe.startedAt`）→ 面板首次观察到忙位的时刻（`busySince`）。
前者保证「面板中途打开也显示真实用时」，后者保证「拿不到批次起点时也不会长期 0s」。

## 4. 与 V1 的已知差异（有意保留）

| 项 | V1 | V2 | 原因 |
| --- | --- | --- | --- |
| 空闲文案 | 「暂无」 | 「空闲」 | v2.52.0 用户明确要求写得直白（既有差异，不改） |
| 文本字段 | `task` + `detail`（楼层/分段/已读取正文/已提取/目标/已更新/已发送/阶段）多字段范本 | 「正在分析记忆（AI 摘要）· 分段 x/y · 第 a-b 楼 · 已用时 Ns · 已请求中断」 | V2 忙位目前只建了「摘要/批量」一类任务；字段扩展需先在内核建 `busy.pipe` 等价模型，未在本批范围内（记入后续） |
| 中断按钮 | 始终存在，按忙位改文案与透明度 | 只在忙位时渲染（v2.52.0 用户要求） | 既有差异，不改 |
| 起表前置检查 | 起表前查节点 | 首个心跳复查节点 | V2 的表是在「写完 DOM 之后」起的，检查时机等价 |

## 5. 门禁

- 新增 `tests/unit/pipeline-tick.test.js`（12 断言）：
  - S1–S4：空闲文案 / 批次真实起点 / 纯函数读秒（`now` 前移则秒数增长）/ 无起点时的回落；
  - T1–T4：忙位起表**仅一个 + 500ms**、行标记为 `data-ftt-pipeline-label`、心跳只改文本且**未变不写**、反复渲染不重复起表、空闲停表并清零起点；
  - Z1–Z4：切离总览停表并切回重起、`closePanel` / `unmountPanel` 停表、心跳自停（管线结束 / 无节点）。
- 真机路径人工核对（真实 `setInterval` + 真实时钟）：批次起点早于开面板 3s，开面板 1.25s 后该行为
  `正在分析记忆（AI 摘要） · 分段 1/3 · 第 5-8 楼 · 已用时 4s`；`closePanel()` 后心跳停止。
