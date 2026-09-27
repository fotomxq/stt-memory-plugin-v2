# P10at · 分析记忆后按「最新一条情节」同步日期/时间/地点/在场角色（v2.81.0）

> 文档版本：v1.0 ｜ 日期：2026-09-27 ｜ 状态：生效（v2.81.0）
> 触发（用户原话）：「日期、时间、地点、在场角色，在每次分析记忆后，如果情节发生更新，则按最新的一条更新相关记录。」
> 关联：`host/preflight.js`（`atomsSignature` / `recalibrateAfterExtract`）、`host/extract.js`（3 处合并点 + 批量汇总）、
> `core/clock-extract.js`（`resolvePresentNames` 修复）、`tests/unit/clock-after-extract.test.js`、`tests/smoke-test.js`（BD1）、
> `docs/04-应用架构.md` §3

---

## 1. 现状（修复前的两个缺口）

| # | 缺口 | 证据 |
| --- | --- | --- |
| ① | **落库后没有任何同步**：`calibrateBasics()` 只在**提取之前**校对一次，来源是**当时已存在**的情节；`host/extract.js` 的 3 处 `mergeDelta` 之后无人再解析 → 本轮新增/更新的那条情节带着新日期/地点/涉及角色，`state.state.{date,time,location,present}` 仍是旧值 | `host/preflight.js:38-72`、`host/extract.js:220/293/393`（修复前） |
| ② | **「在场角色 ← 最新情节的涉及角色」是死路径**（**V1 同款缺陷**）：`resolvePresentNames(textIn, plotIn)` 直读 `plot.entities`，而两个调用点传的都是**包装对象**（`latestTrustedPlot()` / `latestPlotByFloor()` 返回 `{dim, node, date, time, location}`，真正的节点在 `plot.node`）→ `plot.entities` 恒为 `undefined` → 永远落到 `keep-prev`（保留旧名单，绝不用最新情节更新在场） | `core/clock-extract.js` 的 `resolvePresentNames`（修复前）、两个调用点 `:321` / `:355`；V1 对照 `src/FTT记忆组件-v1.206.js:20196-20212` 与调用点 `:20080` / `:20189` |

## 2. 修法

| # | 改动 | 说明 |
| --- | --- | --- |
| ① | `host/preflight.js#atomsSignature()` | 情节容器签名 = `hash(排序后的 "id\|内容哈希")` —— **新增 / 原地更新 / 删除**都会改变签名；无情节 → 空串（视作「无基线」） |
| ② | `host/preflight.js#recalibrateAfterExtract(sigBefore)` | 签名未变 → **完全不碰时钟**（不解析、不落盘、不写日志，`skipped='atoms-unchanged'`）；变了 → 复用内核 `clockAutoExtractOnce()` 落盘四项 |
| ③ | `host/extract.js` 3 处合并点 | 合并**前**取签名 → 落库成功后调用同步（单楼 / 分段 / 独立分组各组），结果随 `postCalib` 返回 |
| ④ | `host/extract.js` 批量路径 | 汇总各段的 `postCalib`（有 `changed` 的优先），写入 `recordLastExtract` 与返回对象 —— 总览/调试可见 |
| ⑤ | `core/clock-extract.js#resolvePresentNames` | 兼容「包装对象 / 节点本身」两种入参（`const node = (plot && plot.node) \|\| plot;`）→ 修掉缺口 ② |

### 2.1 口径（有意为之的三点）

1. **与「提取前校对」的唯一差别：不传 `text`**。用户要求「按**最新的一条**更新相关记录」，故在场角色取自
   **最新情节的涉及角色**（来源标记 `plot-atom`），而不是再回读原始楼层正文（`latest-ai`）。
2. **开关沿用既有语义**：组件关闭 → `skipped='disabled'`；「消息后自动同步时钟」关闭（`cfg.clockExtractEnabled=false`）
   → `skipped='auto-off'` —— 与提取前校对**同一个开关**（不新增配置键）。
3. **手工锁定时钟仍最高优先**（既有口径）：`clockManualLock` 默认锁定 → 日期/时间/地点**不被自动提取改写**
   （`state.state` 三项保持原值），但**在场角色照旧按最新情节同步**；此时备注如实写「手工锁定时钟 → 日期/时间/地点保持不变」。

### 2.2 缺口 ② 属**有意偏离 V1**

V1 的 `resolvePresentNames` 与调用点形状与本仓库一致，缺陷相同 → 本版**修掉 V1 的缺陷**，
按规则登记为「有意偏离」（不改任何黄金样本；相关 oracle 未覆盖该路径，故全部既有测试保持通过）。

## 3. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增单测 `tests/unit/clock-after-extract.test.js` | ✅ 14 项：签名判定（未变跳过 / 新增 / **原地更新** / 删除 / 容器异常）· 四项字段跟随最新情节 · 最新情节缺地点时不清空旧值 · 组件关闭 / 自动同步关闭 / 无基线跳过 · **手工锁定仍优先** · 幂等 · 日志只在真同步时写一条 |
| 新增冒烟 `BD1` | ✅ 真实跑一次「分析记忆」→ 日期/时间/地点/在场角色全部跟随最新情节；`clockSrc.present='plot-atom'`；情节未变时不碰时钟 |
| 单元测试 | ✅ 104 文件 / 1590 断言 |
| 冒烟测试 | ✅ 169 项 |

## 4. 未做与边界

| 项 | 说明 |
| --- | --- |
| 不改「时钟唯一可信来源」口径 | 仍然**只取最新一条带日期的非总结情节**（`docs/history/P10o`），本次只是**在正确的时间点**执行它 |
| 不改手工锁定语义 | 锁定态下自动提取依然不写 `state.state` 的日期/时间/地点（手工值的效力在解析结果上） |
| 不新增配置键 | 复用 `cfg.clockExtractEnabled`；同步本身无需开关（只在情节真的变化时发生一次） |
| 不新增数据容器 | 签名是运行期只读计算；同步结果写回既有 `state.state` 字段 |
| UI | 总览「📤 最后一次提取」沿用既有 `calib` 展示；`postCalib` 已进入提取记录（本次未新增界面元素） |
