# P10bv · 载入链路诊断（台账丢失环节锁定）（v3.0.10）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.10）
> 触发（用户原话）：「已经更新并复现过一次，还是老样子。」
> 相关：`docs/history/P10bu`（v3.0.9 台账诊断）· `P10bs`（调试桥）· `P10az`（台账守卫）· `docs/D12`（楼层骤减）

---

## 1. 本版之前已锁定的硬事实

用 v3.0.9 的只读诊断在真实宿主上取证，**推翻了「哈希跨重载不稳定」这一假设**：

| 观测 | 值 | 含义 |
| --- | --- | --- |
| `ftt.floorDiag(2).hashStable` | `1hzkdfp` | **与聊天文件、与台账存的旧值三方一致** |
| `ftt.floorDiag(2).markPresent` | **`false`** | 内存台账里**没有**这条标记 → 进未摘要 |
| `ftt.floorDiag(70).hashStable` | `1fkxejl`（≠ 台账旧值 `zu4voh`） | 哈希确实对不上 |
| `ftt.floorDiag(70).covered` | **`true`** | 被「该楼已有记忆数据」兜底挡住 → **不进清单** |
| `ftt.ledger` | `marks: 0` · `processedVer` 与签名**一致** · `lastKnownFloor = 70` | 内存台账为空 |
| 持久层文件 | **16 条**标记、`processedVer` 同一签名 | 写入是好的 |
| 离线复放 `migrateState(文件数据)` | `processedFloors` **原样 16 条** | 迁移不是元凶 |

**两个结论**：

1. 此前「界面与哈希判据方向相反」是**假象** —— 70 楼不是「被判为已处理」，而是**被覆盖兜底隐藏**；
   2/4 楼是真·未摘要，因为**内存台账里没有它们的标记**。
2. 真正的缺陷是：**写入正常、载入后内存台账为空** —— 丢失发生在载入链路的某一环。

## 2. 本版交付：`ftt.loadDiag`（只读，四处并排）

| 区块 | 内容 |
| --- | --- |
| `memory` | 内存台账：`marks` / `processedVer` / `lastKnownFloor` / 当前签名 `tag` |
| `localBuffer` | `localStorage` 的 `ftt2_state_<scope>`：**是否存在**、字节数、解出的台账三件套，以及**信封哈希是否自洽** |
| `file` | 服务端文件（与载入同一条只读读取）：同上四项 |
| `ledgerLog` | **台账相关调试日志**（迁移 / 归位 / 漂移 / 对账 / 收缩 / 标记），含计数、原因与时间 |

设计要点：

- 只做 `getItem` 与只读读取，**不写任何存储**；
- **不触发任何台账维护**（不调 `isFloorProcessed()`、不调 migrate/drift/reconcile/shrink），
  该不变量由单测 **F12** 锁定；
- `hashOk` 一栏专门回答「信封哈希不符 → 载入被拒 → 回落空状态」这条嫌疑。

## 3. 为什么先加观测而不是先改逻辑

载入链路的候选环节有四个（本机缓冲 / 服务端文件 / 迁移 / 台账维护），且**破坏性写回是无条件**的
（`handleFloorShrink` 的 `state.processedFloors = keep`）。在不知道是哪一环之前改逻辑，等于**拿用户
正在使用的真实记忆做实验** —— 一旦改错，会把还能救的台账彻底写没。故本版仍只加观测。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| 单元测试 | ✅ **124 文件 / 1942 断言**（`debug-bridge` 57 → **59 项**：新增 F11/F12） |
| 冒烟测试 | ✅ 187 项 |
| 其它门禁 | ✅ 内核纯净度 / 标识符 / 词条 / 版本一致性 / 文档规范 / 本地隐私 / 版本清单 / UI 规范 全 0 违规 |
| 归档自足性 | ✅ `git archive` → 改名目录冷复跑全门禁通过 |

## 5. 改动文件

| 文件 | 性质 |
| --- | --- |
| `ui/debug.js` | 新增只读 `ftt.loadDiag` + `ledgerOfEnvelopeText()` / `ledgerLogEntries()` / `loadDiag()` |
| `tests/unit/debug-bridge.test.js` | 57 → 59 项（F11 四处齐备 · F12 零副作用） |
| `manifest.json` · `package.json` · `core/constants.js` · `CHANGELOG.md` | 版本 `3.0.9` → `3.0.10` |
| `tests/local/README.md` | §5.4 补 `ftt.loadDiag` |
| `docs/README.md` | §3 数字口径 |
| `docs/history/P10bv-载入链路诊断.md` | 本档 |

## 6. 下一步

用户更新到 v3.0.10 并刷新后，读一次 `ftt.loadDiag` 即可定因：

| 观测 | 结论 |
| --- | --- |
| `localBuffer.present = true` 且 `marks = 0` | **本机缓冲被写坏并优先于文件载入** → 修本机缓冲的写入/读取优先级 |
| `localBuffer` 的 `hashOk = false` | 本机缓冲被拒 → 回落服务端文件；再看 `file.hashOk` |
| `file.hashOk = false` | 服务端文件被拒 → 载入回落 `emptyState()`，台账整体丢失 |
| `memory.marks = 0` 但 `localBuffer/file.marks = 16` | 载入**读到了**却没进内存 → 元凶在注入或紧随其后的维护写入（届时看 `ledgerLog`） |
| `ledgerLog` 里有「v1.84 旧标记批量迁移」`dropped = 16` | 迁移在聊天未就绪时清空了台账（尽管有 `chatReadyForFloors` 守卫，需查守卫为何放行） |
