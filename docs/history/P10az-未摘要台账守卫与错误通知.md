# P10az · 未摘要楼层台账「未就绪守卫」+ 错误必须通知异常（v2.87.0）

> 文档版本：v1.0 ｜ 日期：2026-09-27 ｜ 状态：生效（v2.87.0）
> 触发（用户原话）：
> ①「总览的未摘要每次更新或重启后，都会提示大量早期楼层，该问题在之前版本已经存在，请核对原因并解决。」
> ②「一些错误信息除了日志记录外，应该通知异常，而不是什么都没反应。」
> 落点：`host/floors.js`（新 `chatReadyForFloors`）· `core/model/runtime.js`（`warn` / `notifyError`）· `adapters/store.js` · `ui/panel.js`

---

## 1. 问题①：重启/更新后「大量早期楼层」变回未摘要

### 1.1 根因（已复现）

`state.processedFloors` 是「哪些楼层分析过」的**哈希台账**（`{f, h}`）。升级期签名不符时由
`host/floors.js#migrateProcessedFloorsV170()` 按当前取文算法重算哈希 —— 其口径含一条 V1 规则：
**「该楼取不到正文 → 丢弃该标记」**。

插件**启动/更新的时刻，聊天往往还没同步进宿主 `ctx`**（`getCtx().chat` 为空，或消息尚未带回正文）——
此时 `hashFloorText()` 对每一楼都返回 `''`，于是：

| 步骤 | 结果 |
| --- | --- |
| `migrateProcessedFloorsV170()` 逐条重算 | 每条都「无正文」→ `dropped++` |
| 收尾写回 | `state.processedFloors = []`（**整本台账清空**）+ `processedVer = 当前签名` |
| 聊天随后同步完成 | 台账已空、签名已「最新」→ 不再触发迁移，**永久丢失** |
| 下一次扫描 | 只剩「该楼已有记忆数据」覆盖兜底；**早期楼层的数据早被存储上限裁剪** → 成片变回「未摘要」 |

复现（修复前）：31 条标记 → `migrateProcessedFloorsV170()` 返回 `{dropped:31}` → `processedFloors.length === 0`。
这与用户描述完全一致：**每次更新或重启后**（两次都会经过「签名不符 → 迁移」而聊天未必就绪），且「之前版本已经存在」。

### 1.2 修复：**聊天未就绪时一律不动台账**

新增 `host/floors.js#chatReadyForFloors()`（廉价只读判据）：

- `getCtx().chat` 为空 → 未就绪（`no-chat`）；
- 否则采样**首 / 中 / 尾**三楼，**全部拿不到正文** → 未就绪（`no-text`）。

三条维护路径全部加守卫（**读不到正文 = 延后，而不是丢弃**）：

| 路径 | 未就绪时的行为 |
| --- | --- |
| `migrateProcessedFloorsV170` | `skipped: 'chat-not-ready'` —— 不重算、不写回、**不盖新签名** |
| `processedDriftGuard` | `skipped: 'chat-not-ready'` —— 不判定漂移、不刷新 |
| `reconcileProcessedFloors` | `kept: <原条数>, skipped: 'chat-not-ready'` —— 不归位、不丢标记 |
| `scanPendingFloors` | 直接返回**空清单** + `chatReady:false` / `skipped.chatNotReady=1`，并**跳过全部台账维护** |

> 就绪之后下一次扫描会正常迁移（哈希刷新、条数不变），因此「早期楼层」不再冒出来。

### 1.3 与问题②的衔接

延后发生时**不再静默**：给一条节流提示「聊天尚未就绪，已处理楼层台账暂未刷新（不影响已分析记录）」，
同时写调试日志（`kind=摘要`，含 `reason` 与 `marks` 条数），便于事后核对。

## 2. 问题②：错误信息必须有可见提示

### 2.1 根因

| 位置 | 现状缺陷 |
| --- | --- |
| `adapters/store.js`（持久化钩子接线） | `warn: () => undefined` —— **内核所有 `warn(...)` 被静默丢弃**（连调试日志都没进） |
| `ui/panel.js#panelAction` | 动作异常只写调试日志 + 面板内备注，**没有用户可见提示**；动作被拒绝（`ok:false`）同样只有备注 |

### 2.2 修复：统一错误出口

`core/model/runtime.js`：

| 出口 | 行为 |
| --- | --- |
| `warn(...args)` | 一次调用做三件事：① 宿主 `persistHooks.warn` ② 写 `dbgLog('异常', …)`（保证至少进调试日志）③ 经 `notifyError` 发**用户可见提示**（文案前缀 `⚠️ `，kind=`error`） |
| `notifyError(text, {force})` | 提示通道：**同文案 60s 内只弹一次**、**每会话上限 5 条**；`force:true` 绕过节流与上限（用于**用户主动动作**的失败）；文案截断 200 字 |
| `warnStats()` / `resetWarnThrottle()` | 诊断与复位（测试、「清空日志」用） |

接线与调用点：

- `adapters/store.js`：`warn` 改为写调试日志（`kind=异常`），不再吞掉；
- `ui/panel.js`：动作**异常** → `notifyError(..., {force:true})`（用户点出来的，必须让他看见）；
  动作**被拒绝**（`ok:false`）→ `notifyError('操作未完成：<原因>')`（走节流）；
- `host/floors.js`：台账刷新延后 → 节流提示（见 §1.3）。

## 3. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增单测 | `error-notify`（7 项：三重出口 / 节流与上限 / force / 空文案与截断 / 面板异常与被拒绝 / 正常动作零噪声） |
| 扩展单测 | `pending-floors` 新增 E 组 4 项：未就绪不清台账（旧行为清 0）、三条维护路径延后、就绪后正常刷新且未摘要为空、**完整重启序列后台账存活** |
| 有意偏离登记 | `parallel-golden` 的 V1 toast 逐项比对**过滤新增的 `⚠️ ` 异常通道**（V1 无此通道；该通道由 `error-notify` 专门校验） |
| 单元测试 | ✅ **110 文件 / 1686 断言** |
| 冒烟测试 | ✅ **173 项** |

## 4. 未做与边界

| 项 | 说明 |
| --- | --- |
| 未把「延后」做成界面横幅 | 目前是**节流 toast + 调试日志**；若希望总览常显「台账刷新已延后」小字，可在下一轮加（不影响正确性） |
| 未逐一收敛全仓 `catch (e) { }` | 本轮先把**统一出口**（`warn`）修通：凡走 `warn` 的错误现在都有可见提示；仍有少量纯兜底 `catch {}`（如渲染兜底）保持静默，避免刷屏 |
| `processedFloors` 上限 | 仍是 `.slice(-5000)`（V1 口径），未改 |
