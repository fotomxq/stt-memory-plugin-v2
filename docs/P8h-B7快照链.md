# P8h · B7-1 快照链（内核移植 + 界面 + 黄金样本）

> 文档版本：v1.0 ｜ 日期：2026-09-25 ｜ 状态：生效（v2.8.0）
> 关联：`core/snapshots.js`（新）、`ui/snapshots.js`（新）、`adapters/store.js`、`docs/P8-功能对齐总表.md`

---

## 1. 内核移植（**逐字取自 V1** `src/modules/05-记忆状态与存储抽象.js`，259 行块）

| 函数 | 语义（V1 原样） |
| --- | --- |
| `atomSerialize(cat,it)` | 备份用序列化：深拷贝实质内容 + `__cat`，剔除 `h/uses/floor*/updatedAt/history/log` 等可再生成字段 |
| `snapFpFromCurrent()` | 当前「原子指纹」（用于判断增量是否有变化） |
| `snapshotMergeSnap(base, s)` | 把快照 `s` 的原子/哈希/删除账本并入 `base` |
| `snapshotConsolidate()` | **多根合并为一**；总量超上限（30）时把**最早 15 个增量**并入根（while 循环直至 ≤ 上限） |
| `snapshotCreateFull()` | 全量根快照（无原子 → 返回 null，不建空根） |
| `snapshotCreateIncr()` | 增量快照（只记录相对基线新增/变更的原子 + 删除账本 `deleted`） |
| `snapshotRestore(id)` | 按「该快照及之前所有快照」的时间线并集重建各维；**删除账本按序生效**（不复活已删条目）；还原属回滚 → 抑制删除留痕 |
| `snapshotClear()` / `snapshotStats()` | 清空（不动记忆本体，指纹一并复位）/ 统计（读取即整理） |
| `scheduleSnapshotIncr()` | 增量防抖调度（400ms） |

**唯一的三处适配**（写在文件头）：① 落盘改走内核 `saveState()` 注入钩子（V1 用 `saveStateRaw`）；
② 用户提示改经 `notifyHooks`；③ 延迟调度改经 `timerHooks`（内核默认 no-op）；面板重绘由 UI 层负责。
另：`ensureAtomHashes`/`collectAtomHashes` 直接复用 `core/merge.js`（不重复移植）。

## 2. 保存流水线接线（V1 `saveState()` 收尾口径）

`adapters/store.js#saveStateNow()` 在「索引刷新 → 删除留痕」之后调用 `maintainSnapshots()`：
**无原子 → 跳过；无快照 → 建全量根；已有快照 → 调度增量（防抖）**。
`maintainSnapshots()` 已导出，便于诊断与测试。

## 3. 界面（数据管理页 → 🧬 快照链）

统计条（总数/根/增量/覆盖条数/上限）+ 列表（类型 · id · 时间 · 条目数 · 删除账本 · 基线）+ 动作：
**🌱 立即建根**、**🧹 整理（并入根）**、**🗑 清空快照**、逐条 **↩ 还原** 与 **🗑 删除**。
面板动作名与 V1 一致：`snapCreate` / `snapRestore` / `snapDelete` / `snapConsolidate` / `snapshotClear`。

## 4. 黄金样本（oracle = **真实 V1 插件**，`tests/fixtures/v1-golden-snapshot.json`）

固定序列：建根 → 新增 a3（增量 1）→ 删除 a2（增量 2）→ 统计与还原。比对结果：

```text
[verify snapshot chain] OK（快照结构逐项一致）         ← kind / baseId / atoms 键 / atomsHashes / deleted 指纹
[restore] v1=["a1","a2"] v2=["a1","a2"] same=true      ← 还原到根的时刻态一致
[stats]   v1={"total":3,"root":1,"incr":2,"covered":3,"deleted":1}
          v2={"total":3,"root":1,"incr":2,"covered":3,"deleted":1}
```

## 5. 测试（`tests/unit/snapshot-golden.test.js`，8 项）

S1 结构指纹与 V1 逐项一致 · S2 统计一致 · S3 还原到根得到该时刻集合 · S4 还原到最新增量**不复活**已删条目 ·
S5 整理（创建自带整理：链长 ≤ 上限且根唯一；强制超限后显式整理按批次折叠）· S6 清空/删除只动快照链不动记忆本体 ·
S7 保存流水线接线（自动建根 → 调度增量，`timerHooks` 注入后可观察链增长）· S8 数据管理页区块与动作转发。

门禁：单元 **29 文件 / 361 断言**、冒烟 **55 项**、五道门禁全绿。

## 6. 下一批（B7-2）

跨端同步与镜像：拉取合并与 meta 预判、同步日志、流量门控；快照**独立文件**（`ftt-snap-…json.gz`）上传/并集合并；
存储页的探测/测试/同步动作。
