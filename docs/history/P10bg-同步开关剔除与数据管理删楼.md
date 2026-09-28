# P10bg · 同步开关剔除与写死逻辑 + 数据管理删楼（官方 API）+ 楼层校准（v2.94.0）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v2.94.0）
> 依据：`docs/D11-同步机制设计稿.md` v0.3 **§3.4 / §3.5 / §5 S1**、`docs/D12-楼层骤减的数据安全与删除操作设计稿.md` v0.2
>   **§4 / §8 / S3 / S4 / S4b**、`docs/D9-UI统一规范设计稿.md` **U4**
> 触发（用户原话）：「请按照设计稿这几轮的调整，核对并开发。我看很多用户其实完全无需操作的同步开关还在，大部分都可以移除，
>   并在代码写死逻辑。其次设定-数据管理哪里没有按钮，用**官方 API** 实现，不然其他插件也会异常。其他按建议走。」

---

## 1. 同步 / 存储开关剔除，行为写死内置（`D11` §3.4 / §3.5）

**用户判断**：「很多用户其实完全无需操作的同步开关还在，大部分都可以移除，并在代码写死逻辑。」

| 项 | 结论 |
| --- | --- |
| 剔除项（14） | `storage.stateFile` · `stateFileBak` · `snapshotFile` · `settingsMirror` · `tauriMirror` · `tauriNative` · `verifyOnLoad` · `syncOnSave` · `crossPullOnActivity` · `crossPullOnVisible` · `syncMetaProbe` · `syncLogServer` · `deletedKeepDays` · `syncTrafficGuard` |
| 保留项（12） | 全部 `storage.worldbook*`（世界书**纯偏好参数**：写错了只会少一条检索，不会造成数据不一致） |
| 口径（§3.5） | **凡设错就会导致数据不一致的开关一律不暴露** —— 改为**内置固定行为**，用户无需理解 |
| 用户仍可核对 | 存储页保留**只读状态行**：存储通道（自动识别宿主）· 记忆文件（主文件/备份/快照/最近写入）· 同步日志；**能看、不能改错** |
| 数字变化 | 设定控件总数 **172 → 158**；存储页控件 **26 → 12** |

> 实现方式（`ui/settings-pages.js`）：控件表按**键名过滤**后，在 `SETTINGS_CONTROLS` 定义之后追加一段**按 key 去重**
> （每页保留首个），保证「同一键不会因页面组装顺序出现两条」。

## 2. 设定 → 数据管理「✂️ 删除聊天楼层」（`D12` §4 / §8-E，阶段 S4）

**用户约定**：按钮落位「设定 → 数据管理」；**必须用官方 API** ——「不然其他插件也会异常」。

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 入口 | 三档固定按钮 **保留最近 6 / 10 / 12 层**（+ 只读诊断行：当前 N 层 · 插件 M 条 · 上次删楼时间/备份文件名） | `ui/settings-pages.js#floorTrimSectionHtml`；单测 F1/F2/F3、冒烟 BG1 |
| 预检 | 删几层 / 删哪一段 / 受影响条目数 / **其中有几层尚未提取**（`D12` §8-D 删前吸收提示）；按钮 `title` 里就给出结论 | `core/floor-trim.js#planFloorTrim`；单测 A1–A5 |
| 二次确认 | 统一 `confirmDialog`（`D9` U4），文案讲清「删的是聊天、不是记忆」+ 预检结论 + 未提取警告 | 单测（冒烟 BG1 的确认桩） |
| 自动备份 | 明文 JSON 信封写入**酒馆用户目录文件** `ftt2-floor-backup-<角色>-1\|2\|3.json`（**3 槽轮转**）；**失败即中止，一层都不删** | `adapters/floor-backup.js`；单测 D3、E1 |
| 删除 | **只走官方 API** `getContext().deleteMessage(id)`，**从后往前**逐个 `await` | `host/floor-trim.js`；单测 D1、冒烟 BG1 |
| 校准 | `M` 已知 → **精确编号重映射**（幸存段整体前移 M；被删段 → `0/0` + `floorStale`；跨越段 → 起点 0 + 终点前移 + `floorStale`）+ 台账重排 + `lastKnownFloor` 收紧 | 单测 B1–B3 |
| 记账 | 人工确认项一条（kind=删楼，含备份文件名与「记忆保留 N 条」）+ 调试日志 + 面板摘要 | 单测 D5、冒烟 BG1 |
| 降级（Q6） | 宿主无 `deleteMessage` → 按钮**禁用 + 写明原因**，执行返回 `unsupported`，**不静默失败** | 单测 C2、E3、F2 |
| 半途失败 | 如实返回 `partial`（已删 N / 请求 M），并按**实际删除量**校准编号 | 单测 E2 |

### 2.1 为什么必须用官方 API（本档的技术要点）

酒馆 `public/script.js#deleteMessage(id)` 的副作用**不止**从数组里摘一条：

```text
chat.splice(id, 1) → DOM 移除 → deleteItemizedPromptForMessage → chat_metadata.tainted = true
  → updateViewMessageIds → saveChatDebounced() → eventSource.emit(MESSAGE_DELETED, chat.length)
```

因此**自己改 `ctx.chat`**（旧式做法）会跳过 `saveChatDebounced()` 与 `MESSAGE_DELETED`：
别的插件（自动摘要、聊天记录器、剧情插件…）**收不到「消息被删除」这条事件**，其内部台账就会与真实聊天错位 ——
这正是用户说的「不然其他插件也会异常」。本版一律 `await ctx.deleteMessage(id)`，插件只做**编号校准**这一件自己不做的额外事。

> 附带约束：该官方方法在 DOM 中找不到 `mesid` 元素时会**静默 return**，故实现**每步核对 `chat.length` 是否真的减少**，
> 没有减少即中止并按「已删 N 层」如实回报（`partial`）——不把失败装成成功。

## 3. 设定 → 存储「🧱 楼层校准」（`D12` §3.4，阶段 S3）

用户会**主动删楼**（酒馆对高楼层支持差），因此编号失准必须能自查、能手动兜底：

- 只读诊断：当前层数 · 已分析标记数 · **最近一次收缩时间** · 「楼层信息已失效」条目数；
- 动作「🔄 重新校准楼层」：按当前聊天现实重跑一次收缩处理（哈希归位台账 + 超界区间降级 `0/0` + 基线收紧），**幂等**；
- **只改编号、绝不删除条目**；判据与自动哨兵同一口径（`lastKnownFloor - 5` 容忍带，≤5 层正常抖动不算收缩）。

> 单测 G1/G2/G3；冒烟 BG2（面板审计 + 真实点击：无收缩幂等短路 → 人为删楼后重算且**条目一条不变**）。

## 4. `chatMetadata` 主载体：只读接入与差异报告（`D11` S1 / `D12` S4b）

用户裁决（`D12` §8-C）：「**载体必须比消息活得久** —— 记忆数据主载体是 `chatMetadata`（随聊天存活）；
**不得**把消息 `extra` 作为唯一载体（删楼会连带删掉）。」

本版是阶段的 **S1（只读接入）**：新增 `adapters/chat-meta.js`

| 能力 | 说明 |
| --- | --- |
| 探测 | `chatMetaCapability()`：`ctx.chatMetadata` 可读？`ctx.saveMetadata` 存在（**仅诊断**）？缺失 → `unsupported` **降级**（仍走文件通道，数据不受影响） |
| 读取 | `chatMetaRead()`：命名空间 `ftt_memory_v2` 下的信封 `{format,version,scope,at,state}`；兼容「裸 state」 |
| 差异 | `chatMetaDiffReport(state)`：逐维条数差 / 体积 / 时间先后 → 结论 `same` / `live-only` / `meta-only` / `meta-newer` / `live-newer` / `unsupported` / `empty` |
| 出口 | 设定 → 调试页新分节「📎 chatMetadata 主载体（只读差异报告）」+ 调试包字段 `chatMeta`（人读文本，**不含记忆正文**） |
| 纪律 | **只读不写**：单测断言「报告前后 chatMetadata 深比较一致，且从不调用 `saveMetadata`」（写路径属 S3） |

## 5. 危险动作二次确认（`D9` U4 / 检查项 C7）

用户真实点击路径统一加一道闸（`ui/panel.js` 点击委托的**最前面**）：命中 `DANGER_ACTION_PROMPTS` 即先 `confirmDialog`，
**取消直接 return（零副作用）**。清单 11 项：删除条目 · 批量删除 · 清空调试日志 · 清空时间线 · 清空同步日志 ·
清空 NSFW 词条库 · 导入合并 · 恢复快照 · 清空分段总结 · 清空注入 · 清除已处理楼层。

> 只拦**用户真实点击**；程序化调用 `panelAction()`（斜杠命令 / devtools / 测试）不受影响 —— 冒烟 BH1 对三态逐一验证。
> `npm run ui-spec --strict`：**C7×1 → 0 命中**（整体 0 命中）。

## 6. 修复：三个「运行时账本」键从未真正落盘（v2.90.0 / v2.92.0 遗留缺陷）

| 项 | 事实 |
| --- | --- |
| 症状 | 设定 → 存储的「⚠️ 待确认」与总览倒计时样本**一刷新就没了**（人工确认项 / 管线耗时历史从不持久化） |
| 根因 | `adapters/settings.js#setSetting(key, value)` 对**不在 `DEFAULT_SETTINGS` 的键** `return false` **且不写**；而 `index.js` 注入的 `save: (list) => setSetting('syncConflicts', list)` 与 `saveHistory: (h) => setSetting('pipelineEta', h)` 用的键**从未登记** → 每次调用静默失败 |
| 修复 | 把 `syncConflicts` / `pipelineEta` / `floorTrimLog` 登记进 `DEFAULT_SETTINGS`；并让缺失键的**对象/数组默认值深拷贝**（否则与冻结的默认表共享引用，首次 `push` 即抛错） |
| 回归 | `tests/unit/inject-settings.test.js` 新增 **S11**（三键在册且真的能落盘）、**S12**（默认值深拷贝、不污染 `DEFAULT_SETTINGS`） |

> 这三个键都是**运行账本**（不是记忆数据），故继续留在 ST 扩展设置里 → `DATA_VERSION` 不变。

## 7. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 内核纯净度 | ✅ 0 违规（新 `core/floor-trim.js` 纯内核：无宿主标识符） |
| 标识符门禁 | ✅ 0 未定义标识符 |
| 文档规范 | ✅ 0 违规 |
| UI 规范检查 | ✅ **0 命中**（含 `--strict`；此前 C7×1） |
| 单元测试 | ✅ **117 文件 / 1761 断言**（新增 floor-trim 25 项 + chat-meta 16 项 + inject-settings 2 项；既有 5 项按新口径改写） |
| 冒烟测试 | ✅ **176 项**（新增 BG1 / BG2 / BH1） |
| 版本一致性 | ✅ manifest / package / constants / CHANGELOG 四处 == `2.94.0`，tag `v2.94.0` |

## 8. 本版**未做**（下一批）

| 项 | 说明 |
| --- | --- |
| `D11` S2 / S3 | 写路径切换为 `chatMetadata` 主通道 + 一次性迁移（本版只做到 S1 只读） |
| `D9` U1 | 列表页统一 **50 条 / 屏** + 「显示更多」+ 搜索/筛选变更即重置首屏 |
| `D9` U11 | 表格类数据（货币流水 / 同步日志 / 导入结果）统一为「列表行 + 折叠明细」 |
| `D10` Q2/Q4/Q5/Q6 | 存储简化剩余接线 |

## 9. 文件清单（本版改动）

| 文件 | 性质 |
| --- | --- |
| `core/floor-trim.js` | 新增（纯内核：预检 / 精确编号重映射 / 摘要文案） |
| `host/floor-trim.js` | 新增（宿主执行：能力探测 / 预检 / 备份 / 官方 API 删除 / 校准 / 记账 / 重新校准） |
| `adapters/floor-backup.js` | 新增（删前明文备份 · 3 槽轮转） |
| `adapters/chat-meta.js` | 新增（`chatMetadata` 只读接入与差异报告） |
| `adapters/settings.js` | 修复（三个账本键登记 + 默认值深拷贝） |
| `host/st-api.js` | 能力探测新增 `deleteMessage` |
| `ui/settings-pages.js` | 存储控件过滤（172→158）+ 数据管理「删除聊天楼层」分节 |
| `ui/sync.js` | 存储页「🧱 楼层校准」分节 |
| `ui/panel.js` | 删楼 / 校准动作 + `keep` 入参透传 + **U4 危险动作确认闸** |
| `ui/debug.js` | 调试页「📎 chatMetadata 主载体」分节 + 调试包字段 |
| `index.js` | 删楼 / 校准钩子接线（账本落 ST 扩展设置 `floorTrimLog`） |
| `tests/harness/st-mock.js` | 官方删楼接口桩（含 `noDeleteMessage` 降级态） |
| `tests/unit/floor-trim.test.js` · `chat-meta.test.js` | 新增 |
| `tests/unit/inject-settings.test.js` | 新增 S11 / S12 回归 |
| `tests/unit/{settings-pages,storage-page,file-transport,settings-capacity,constraint-page,relation-layer}.test.js` | 按新口径改写（控件数 / 开关剔除 / 只读状态行保留） |
| `tests/smoke-test.js` | 新增 BG1 / BG2 / BH1 |
