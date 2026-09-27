# P10ab · 未摘要楼层跳过机制核对（v2.64.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.64.0）
> 触发（用户报告）：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，请**核对跳过机制**。
>   当**原子数据对应的楼层存在时，则不需要分析**。」

---

## 1. 核对方法（oracle，而非只看代码）

- `tests/fixtures/gen-v1-golden-pending-floors.cjs`：加载**真实 V1 v1.206**（`tests/unit/helpers.js` 的
  `makeTavernEnv` + `loadPlugin`，直调 `pendingFloorList`），并对**同一份合成聊天 / 同一份状态**跑**真实 V2**
  （`host/floors.js`），产出 `tests/fixtures/v1-golden-pending-floors.json`。
- fixture 每个场景记录三份清单：`v1`（V1 原样）、`v2NoCover`（V2 关闭「已有记忆数据」跳过）、`v2`（V2 默认）。
  于是「移植差异」与「新增判据」可分开核对。
- 纪律：日志走 stderr、stdout 只输出 JSON、`process.exit(0)`、连跑两次逐字节一致（已核对 md5 相同）。
- 单测 `tests/unit/pending-floors.test.js` 读同一场景表（`tests/fixtures/pending-floors-scenarios.mjs`）**实时复算 V2**
  并逐项比对 fixture，因此 fixture 与实现不会互相漂移。

## 2. 判据总表（核对结论）

| # | 判据 | V1 | V2 本批前 | V2 本批 | 依据 |
| --- | --- | --- | --- | --- | --- |
| ① | 用户楼 | 跳过（`floorIsAi` 只认非 user） | 跳过 | 跳过 | V1 15000 |
| ② | 隐藏楼 | 跳过（取文时跳过 hidden → 无可分析正文） | 跳过 | 跳过 | V1 `collectFloorLinesInRange` |
| ③ | 占位楼 / 空正文 / 被投喂白黑名单过滤 | 跳过 | 跳过 | 跳过 | V1 15001 `floorAnalyzableText`（**列表与执行同源**，v1.174） |
| ④ | 正文只有 HTML 标签 | **不跳过**（不去标签） | 跳过（v2.44.0 起去标签） | 跳过 | 见 §3 D2 |
| ⑤ | 台账已处理（哈希一致） | 跳过 | 跳过 | 跳过 | V1 `isFloorProcessed` |
| ⑥ | 台账在册但哈希不符（正文被改写） | **重新分析** | 重新分析 | 重新分析（**优先于**覆盖判据） | V1 14966 |
| ⑦ | 旧标记升级迁移 | 版本签名不符时按当前口径重算哈希 | 做了，但**缺版本短路**（每次扫描都重刷哈希 → 被改写的楼被永久判为已处理；且超范围标记不清） | 补版本短路 + 超范围标记丢弃 | V1 14910 |
| ⑧ | 哈希归位对账（其他插件增删楼导致索引错位） | v1.70 有，20s 节流；**只在条数变化时写回** | 未移植 | 移植 + 修「条数不变、楼层号整体后移」不写回的缺陷 | V1 15080 |
| ⑨ | 哈希漂移防呆（取文口径变化） | v1.174 有：≥10 枚标记且 ≥50% 失配 → 按当前算法整体刷新（保留「已处理」语义） | 未移植 | 移植 | V1 15018 |
| ⑩ | **已有记忆数据（原子数据）覆盖该楼** | 无此判据 | 无 | **新增：跳过** | 用户要求（本批） |
| ⑪ | 扫描区间 `endFloor` | `pendingFloorList(0, getLastMessageId())`（宿主活值 = `chat.length-1`） | 用内核 `getLastMessageId()` 快照，**落后时会漏扫新楼** | 用实时聊天末尾；快照只作诊断（`lastId` / `lastIdStale`） | 见 §4 |

## 3. 新增判据（⑩，用户要求）

- 位置：`core/floor-cover.js`（内核纯函数，零 AI、只读）。
- 规则：任一记忆维度（情节 / 状态 / 角色档案 / 记忆 / 物品 / 计划 / 悬念 / 场景 / 概念 / 平行事件 / 货币 /
  分段总结 / 传言 / 关联层）的条目带**有效楼层区间**且 `floorStart ≤ i ≤ floorEnd` → 第 i 楼「已有数据」。
- 有效区间定义（`meaningfulFloorRange`）：整数、`0 ≤ floorStart ≤ floorEnd`，且**不是 `0/0`**。
  `0/0` 是「区间未知」的默认值（手工新增、按时间对齐、导入缺楼层字段的条目都会是 `0/0`），据此跳过会误吞第 0 楼。
- 区间合并：相邻（`4-5` 与 `6-7`）与重叠区间并成一段，`has(i)` 二分查找（数千条也不会慢）。
- 优先级：**台账优先** —— 在册且哈希不符（正文被改写过）的楼层仍要重新分析，覆盖判据不得压住「内容已变」。
- 可见性：总览「✅ 已处理 N 楼 · 待摘要 M 楼 · 已有记忆数据 K 楼」；
  `FTT.pendingScan()` / `FTT.pendingFloors({detail:true})` / `extractSummary().pendingSkipped` 给出跳过明细
  （`user / hidden / missing / noText / processed / covered`）。

## 4. 附带修复：内核 `lastMessageId` 落后会漏扫新楼

V2 内核的 `getLastMessageId()` 是**聊天同步时的快照**（`host/chat.js` 在载入/事件时刷新）。新楼刚进入 `ctx.chat`
而宿主尚未触发同步事件时，它偏小；若据此砍掉扫描区间，**新楼永远不会被列进未摘要**（比「多列」更危险：
自动提取追不上新楼）。因此 `scanPendingFloors` 一律按**实时聊天长度**取区间（= V1 宿主活值的语义），
快照只作为诊断字段返回（`lastId` / `lastIdStale`）。冒烟 H2 曾真实捕捉到该回归（楼层 push 后未同步 → 被漏掉）。

## 5. 与 V1 的已记录差异（fixture `documentedDeviations`）

| id | 场景 | 内容 |
| --- | --- | --- |
| D1 | `relocate` | V1 归位对账只在条数变化时写回 → 顶部插入新楼（条数不变、楼层号整体后移）时旧标记仍指旧楼层号，1/2/3 楼被重复列为未摘要；V2 只要归位结果不同就写回 |
| D2 | `html-only` | V2 v2.44.0 起在投喂前去除 HTML 标签 → 纯标签正文视为无可分析内容（V1 不去标签） |
| D3 | `covered-by-atoms` / `covered-by-segments` / `range-0-0` | V2 新增「已有记忆数据 → 跳过」（用户要求）；区间 `0/0` 视为未知、不作证据 |

## 6. 门禁

- `tests/unit/pending-floors.test.js`（17 断言）：oracle 不变量（**V2 从不比 V1 多列**、`v2 ⊆ v2NoCover ⊆ v1`、
  差异必须带说明）、10 场景实时复算（清单 / 台账 / 覆盖数逐项等于 fixture）、跳过分桶、覆盖边界
  （`0/0` 不算、相邻合并、倒挂与负值忽略、隐藏条目照算）、优先序（内容已改写必须重新分析）、
  列表与执行同源（`analyzeFloors` 不重复分析被覆盖的楼）、诊断出口、总览联动、`lastMessageId` 落后不漏扫。
- 生成器连跑两次逐字节一致；fixture 与生成器输出 md5 相同。
