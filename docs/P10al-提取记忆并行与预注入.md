# P10al · 提取记忆不占管道：并行召回 + 发送前提取（v2.74.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.74.0）
> 触发（用户要求）：「提取记忆应该**不占用管道**，因为提取记忆用的是**独立的向量或固定 JS 为主**。
>   确保提取记忆可以**并行处理**，而且在**用户请求发送前提取好记忆**，按照**开关约定注入提示词信息**。」

---

## 1. 问题

「📤 提取记忆」按钮原先调用 `runExtract` = **AI 摘要管道**（`analyzeFloors`）：

- 它会置位/检查忙碌位 `extractState.busy` → 与「⚡ 立即 AI 摘要」**互相排队**（谁先跑谁占管道）；
- 而『提取记忆』的定位是**发送前召回**：向量层（本地/远端 embedding）与 JS 抽取层都是**零 AI 的本地能力**，
  完全可以随时并行跑；只有第三层（mem API）才需要 AI 通道。

## 2. 本批改动

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `index.js#runRecallNow()`（新入口） | 发送前召回：`pushMemoryInject` + 统计（`ok/hitLayer/count/chars/injected/ms/busy`）；**不设置也不检查**摘要忙碌位 → 与长任务**并行** |
| ② | `ui/panel.js` | 「📤 提取记忆」改走 `hooks.recall`（未接线时回落旧 `hooks.extract`，不会出现「入口未就绪」）；note 文案：`召回完成：N 条（层级）· 注入 X 字 · Yms（与在途长任务并行）`；按钮 title 说明「零 AI 为主 / 不占用分析管道 / 可与 AI 摘要并行 / 发送前自动刷新一次」 |
| ③ | `host/inject.js` | **单飞（single-flight）**：并发调用共享同一次构建结果（`pushStats().joined`），不重复消耗向量/AI 请求，也不互相覆盖注入（seq 令牌保留）；返回体新增 `count` / `ms`；新增 `injectInFlight()` 诊断 |
| ④ | `host/extract-flow.js` | 长任务在途（`aiBusy()`）时**默认跳过 AI 层**（向量/JS 层照常），不与在途任务抢 AI 通道；`allowAiDuringBusy: true` 可强制保留（诊断 / 单层测试）；trace 里记 `{layer:'ai', skipped:'busy'}` |
| ⑤ | `index.js` | `panelRuntimeHooks` 增 `recall` / `recallState`；`FTT.recallNow()` / `FTT.recallState()`（`{inFlight, stats}`） |

**未改动**：三层流程本身的判据与顺序（向量 → JS → AI，命中即返回）、注入包装与位置（`setExtensionPrompt(INJECT_ID, …, POSITION.IN_PROMPT, depth 0, role SYSTEM)`）、
「构建为空时保留上一次非空注入」、拦截器**永不 abort**；`runExtract`（AI 摘要）仍是原语义，两条路互不影响。

## 3. 发送前提取与开关约定

```text
用户点发送 → ST 调 fttGenerateInterceptor(chat, ctxSize, abort, type)
   → 闸门：拦截器开关 interceptorEnabled !== false 且 injectEnabled !== false
   → await pushMemoryInject()        ← 这里完成「提取好记忆」（并发时与其他调用共享单飞结果）
   → 注入写入 setExtensionPrompt（注入体 = 固定结构头 + 记忆正文 + 记忆结束。）
   → 放行请求（永不 abort）
```

- **注入闸门**：`injectCurrentPrompt` 或 `timelyAnalysis` 任一为真才推送；两者都关 → `gate-closed`，**不推送也不清空**已有注入；
- **层开关**：`useVector`（向量层）/ `jsExtractEnabled`（JS 抽取层）/ `useKeywordFlow`（AI 层）决定走哪一层，命中即返回；
- **并行**：面板手动点「📤 提取记忆」与拦截器刷新、与长任务（摘要/修复/推演）都可以同时发生 —— 单飞保证不重复构建，忙位跳过 AI 层保证不抢通道。

## 4. 门禁

`tests/unit/recall-parallel.test.js`（14 断言）：

- P1 并发只构建一次（`joined` = 1）且两次结果一致、完成后 `injectInFlight() === false`；P2 并发只推送一次、`lastLayer='js'`；
- B1 长任务在途时召回照常成功（`busy=true`）、**不改动忙碌位**；B2 空闲态 `extractBusy()` 前后均 false 且摘要 `runs` 不变；
  B3 旧入口 `runExtract` 仍占用忙碌位（两条路互不影响）；
- C1 忙位时 **AI 层调用次数为 0**，空闲时 AI 层被调用（`generateRaw` 计数）；
- D1 注入闸门（都关 → `gate-closed`、不清空）；D2 层开关（JS 层命中 / 全关 → `no-hit`）；
- E1 拦截器 `await` 结束时注入已写好、`lastPush.ms >= 0`、**abort 调用数 0**；E2 开关关闭时拦截器不刷新、不覆盖已有注入；
- F1 面板按钮走召回（note 含条数/层级/字数/耗时），F2 未接线 `hooks.recall` 时回落旧入口；
- F3 诊断字段（`joined` / `lastMs` / `lastLayer`）；F4 按钮文案含「不占用分析管道 / 可与 AI 摘要并行 / 发送前也会自动刷新一次」。
