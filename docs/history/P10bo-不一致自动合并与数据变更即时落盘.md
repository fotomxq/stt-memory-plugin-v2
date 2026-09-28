# P10bo · 本地/服务端不一致自动下载合并 + 原子数据变更即时落盘（v3.0.3）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.3）
> 触发（用户原话）：「新版本 如果发现本地与服务端不一致，自动下载合并。每次被动提取记忆及原子数据发生变化，
>   后应该触发保存到服务器的操作。」
> 相关：`docs/history/P10be`（v2.91.0 墓碑账本收敛与冲突总览提示）· `docs/history/P10bg`（v2.94.0 同步开关剔除）·
>   `docs/D11` §3.4/§3.5（同步行为内置，不设开关）· `docs/02-数据架构` §6

---

## 1. 两条要求与落点

| 要求 | 落点（唯一漏斗） | 语义 |
| --- | --- | --- |
| 发现**本地与服务端不一致** → **自动下载合并** | `adapters/sync.js#runStorageSyncInner`（「保存后镜像」的对账分支） | 不再**暂存待选**；一律**自动下载 + 原子合并**，并把合并结果**推回服务端** |
| 每次**被动提取记忆**及**原子数据发生变化** → 触发**保存到服务器** | `core/ingest.js#mergeDelta`（所有原子数据变更的唯一漏斗）+ `host/extract.js` 三个提取入口 → `core/model/runtime.js#persistNow` → `adapters/store.js#flushStateNow` | 在防抖保存（800ms）之外，**立刻**落一次盘（含服务端文件 `ftt2-state-<slug>.json`） |

## 2. 不一致 → 自动下载合并

### 2.1 判定与合并规则（沿用既有内核，不改裁决）

```text
① 对账：crossComputeInfo(state, remoteData, remoteTs) → mode ∈ {equal, superset, subset, divergence, …}
② 拉取：crossFindRemoteEnv()（服务端真值）
③ 合并：applyRemoteMergeToState(rem)  ← 现在**无论哪种 mode 都走这条路**
         · 原子层：按 id 对齐 + 内容指纹判更新（更新方胜）→ **并集**
         · 删除：双墓碑（`applyDeletedToArray`）生效 → 已删条目不会复活
         · 非原子容器（currencies 等）：整侧取较新
④ 回写：合并后的本端状态照常走保存流水线 → 推送服务端（同一轮完成，无需再点同步）
```

**改动前**：`mode === 'divergence'` 时 `stashDivergence(rem, info)` → 暂存「待选对端」，存储页弹**横幅**
（「保留本地 / 采用对端」两个按钮）等用户决定，**本轮不合并也不回写**。
**改动后**：同一条路径直接合并 + 回写；横幅只在**旧版本遗留的待选**（或测试注入）时出现。

### 2.2 留痕（不再静默，也不阻塞）

| 通道 | 内容 |
| --- | --- |
| 待人工确认项（设定 / 总览） | `跨端分歧（已自动合并）`：本地 N 条 / 对端 M 条，冲突 K 条按时间取新 |
| 同步日志 | `mode` = `推送(分歧已自动合并)`，`note` = 「两端分歧 → **已自动下载并原子合并**（并集 + 时间取新 + 墓碑生效），合并结果已推回服务端」 |
| 动作返回值 | `divergence: 'auto-merged'`（旧值 `divergence` 仅用于人工处置路径） |
| 存储页「状态与操作」 | 一行说明：不一致时**自动下载并合并**，再推回服务端；无需人工选择（`data-ftt-auto-merge`） |

### 2.3 人工处置仍保留（向后兼容）

`syncPickLocal` / `syncPickRemote` 两个动作、横幅渲染、`crossPendingView/Clear` 全部保留，
并新增 `crossPendingSet`（`globalThis.FTT` 同名入口）用于：① 处置**旧版本遗留**的待选；② 回归测试注入。
新装 / 正常运行时**不会**产生待选，也就不会出现横幅。

## 3. 原子数据变更 → 立即写服务端

### 3.1 为什么改这里

`saveState()` / `scheduleSave()` 是 **800ms 防抖**（合并连续变更，省流量、省 IO）。但用户要的是
「数据刚变 → 马上写服务端」的**确定性**：被动提取（自动分析新楼层）后若宿主随即关闭 / 切设备，
防抖窗口内的数据可能还没落服务端。

### 3.2 接线（内核 → 宿主）

```text
core/ingest.js#mergeDelta         ── saveState(); persistNow('原子数据变更')
host/extract.js#analyzeFloor      ── persistNow('提取记忆（单楼）')     ← 被动自动提取走的就是这条
host/extract.js#runSeparateGroup  ── persistNow('提取记忆（分组）')
host/extract.js#analyzeSegment    ── persistNow('提取记忆（分段）')     ← 批量摘要
        │
core/model/runtime.js#persistNow(reason) → persistHooks.persistNow(reason)
        │
adapters/store.js#flushStateNow(reason) → saveStateNow({reason})
        → localStorage + IndexedDB + **服务端用户文件** + 保存后镜像（跨端同步）
```

- `mergeDelta` 是**所有**原子数据变更的唯一漏斗（被动提取 / 平行推演 / 档位修复 / 导入合并 / 清理都经它），
  故在此兜底；三个提取入口额外显式触发，保证「提取完成」这一时刻明确写服务端（而非等下一次防抖）。
- 内核侧 `persistNow` **不 await**（避免把同步调用点变成异步）；宿主 `flushStateNow` 返回 Promise，错误进
  `lastSave.error` / 调试日志，不抛、不阻断主流程。

### 3.3 并发纪律（`flushStateNow`）

```text
在途已有 flush → 不叠加写入，只记一个「还有变更」标记；在途结束后**补跑一次**（合并为一次保存）
失败           → 记错误，不抛；理由（reason）进保存记录与调试日志
```

由此，一次批量摘要里「每段落库」不会产生 N 次并发写服务端；同一时刻最多一次保存在途，尾部变更不丢。

## 4. 顺带修复：并发时聚合读数**选代表运行**（`core/pipeline.js#snapshot`）

`persistNow` 让「保存记忆文件」也经常占一条管线行，于是出现**串台**：AI 请求在跑，而聚合读数的
标题 / 阶段取的是**最早开始**的那一路（= 后台保存），用户看到「正在处理：保存记忆文件 · 阶段：请求 AI（第 13 楼）」。
现在聚合读数按**代表运行**取值：

1. 有 AI 运行 → 取**最新开始的 AI 运行**（管线主线就是 AI 请求）；
2. 没有 AI 运行 → 取**最新开始**的那一次（同步 / 存储 / 任务）。

`elapsed` 仍是**最早开始**到现在（= 本轮忙了多久），逐条行读数不受影响。

## 5. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 单元测试 | ✅ **122 文件 / 1846 断言**（`pipeline.test.js` 新增 **F5b** 锁定「代表运行」；`sync-pick-golden.test.js` 改判自动合并） |
| 冒烟测试 | ✅ **187 项**（`AH3` 改为自动合并；`BI1/BI2/BM2` 适配「并发后台保存行」口径） |
| 内核纯净度 / 标识符 / 词条 | ✅ 0 违规 |
| UI 规范检查 | ✅ 0 命中（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `3.0.3`，tag `v3.0.3` |

**有意偏差登记**（黄金样本 → 新行为，均在测试内注明）：
`sync-pick-golden` 的 R2/R3/R5/R6/R7/V1/V2（分歧不再暂存 → 自动合并 / 幂等 / 仍可注入旧待选）、
冒烟 `AH3`（自动合并 + 说明行）、`BI1/BI2/BM2`（后台保存行并存 → 断言改为「行存在 / 该行消失」）。

## 6. 改动文件

| 文件 | 性质 |
| --- | --- |
| `core/model/runtime.js` | 新增 `persistHooks.persistNow`（默认 `() => false`）与导出 `persistNow(reason)` |
| `adapters/store.js` | 新增 `flushStateNow(reason)`（在途合并 + 补跑）+ 接线进 `wirePersistHooks()` |
| `core/ingest.js` | `mergeDelta` 落库后 `persistNow('原子数据变更')` |
| `host/extract.js` | 单楼 / 分组 / 分段三个提取入口落库后 `persistNow(…)` |
| `adapters/sync.js` | 「保存后镜像」分歧分支改为**自动合并 + 回写**；同步日志与待确认项留痕；`crossPendingSet` 导出 |
| `index.js` | `FTT.crossPendingSet`（旧待选人工处置 / 测试注入） |
| `ui/sync.js` | 存储页「状态与操作」新增自动合并说明行（`data-ftt-auto-merge`） |
| `core/pipeline.js` | 聚合读数改为**代表运行**（AI 优先，其次最新） |
| `tests/unit/pipeline.test.js` · `tests/unit/sync-pick-golden.test.js` · `tests/smoke-test.js` | 新增 / 改判 |
