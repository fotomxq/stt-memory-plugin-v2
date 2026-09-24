# P8q · B8-6b+ 关联层机械维护（修复第 1 段收尾 + AI 修订后复检）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.17.0）
> 关联：`core/rel-maint.js`（新建）、`core/repair.js`（第 1 段收尾 + AI 后复检接线）、`index.js`、`devtools.js`、
> `docs/P8o-B8-6a修复管线第1段.md`、`docs/P8p-B8-6b修复第2-3段.md`、`docs/P8-功能对齐总表.md`

---

## 1. 覆盖范围（V1 源 v1.168「修复记忆内的关系层机械维护」）

| V1 能力 | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| 孤儿关联行清扫 | `core/rel-maint.js#relRepairMaint` | 目标条目已不存在（按 `state[dim]` 的 `id` 校验）→ **始终清扫**（不受 `cfg.relOrphanAction` 约束，该开关只管「孤儿条目」处置）；删行前在明细 `sweptRows` 留痕（上限 50），删除走墓碑 → 跨端不复活 |
| 同 `(dim, refId, who)` 去重合并 | 同上 | 以 `REL_LINK_HOW_RANK[how]` 降序、`updatedAt` 降序取「更可靠者」为基，其余逐条**并集合并**：`from/at/view/note` 首见填充、`deviation` 从 `unknown` 升级、`public` 取或、`conceptRef/atomRef/planRef/suspenseRef` 首见填充、`memRefs/sourceRefs` 去重并集、`uses/updatedAt` 取最大；正文行写墓碑且 `id = relLinkId(dim,refId,who)` 重算 |
| 角色名按档案全名归一 | 同上 | 对 `who` 与 `from` 调 `snapFindByName`（同名优先、其次 ≥2 字前缀互含）→ 命中即改写并重算 `who` 行的稳定 `id`；明细 `renamedRows` |
| 悬空引用清理（锚行 `who === ''`） | 同上 | `conceptRef` 按**概念名称**匹配；`atomRef/planRef/suspenseRef` 按**条目 id** 校验；`memRefs`（允许 `memories`）与 `sourceRefs`（允许 `atoms/memories`）按允许维度裁剪；每处计 `staleRefs++` 且明细 `staleRows`（`x 条` 口径与 V1 同） |
| `how` / 偏差非法值归一 | 同上 | 具名行：`parallels` 恒 `related`，其余走 `relLinkHow`；偏差走 `relLinkDeviation`。锚行：`how` 置空、偏差保底 `unknown`。**只改语义字段，不动 id / 时间戳**；按「行」计数（一行内两字段都不合法计 1） |
| 降级统计 | `demoteRelLinkOrphans` | 具名关联只剩 1 人 → `demoted++`（不删行）；一条都没有且未了结 → `orphan` |
| 孤儿条目处置 | `relRepairMaint`（`cfg.relOrphanAction`） | `keep`（默认）= 只统计并提示，绝不改动；`clean` = 只清扫孤儿行、**不删条目**；`public` = 先清扫，再给「一条关联都没有」的条目补公开锚行（`kind`：`plans→plan` / `suspense→suspense` / 其余 `fact`，`note='孤儿条目转公开（修复）'`）；**`parallels` 恒不参与**（对任何角色都不可见） |
| 口径化输出 | `relMaintCounts` / `relMaintTouched` / `relMaintSummary` / `logRelMaint` | 计数对象（9 字段）；`Touched` = 任一实质性字段非 0；摘要只列实际发生的项（清扫/去重/改名/悬空/归一/转公开），无动作但有孤儿条目时返回「无孤儿关联需清理；仍有 N 条无关联条目」文案，全静默返回空串；日志逐条写 `清理/去重/改名/悬空` 明细（各上限 20） |
| 两次维护口径合并 | `mergeRelMaint` | 计数逐项相加、`details` 拼接后截断 50、`action` 取后一次；任一侧为空时直接返回另一侧 |
| 修复管线接线 | `core/repair.js` | 第 1 段收尾处 `relRepairMaint()`（`logRelMaint('立即修复', …)`，摘要入第 1 段 notes；无清理但有孤儿条目时给提示文案）；**AI 修订/删除之后**再跑一次 `relRepairMaint()` 并 `mergeRelMaint(前, 后)`（AI 可能产生新的孤儿行与悬空引用），`logRelMaint('修复（AI 后）', …)`，合并摘要追加进 notes，随 `runRepair` 返回值以 `relMaint` / `relCounts` 暴露 |
| `FTT.*` | `index.js` + `devtools.js` | `relMaint`（`relRepairMaint`）/ `relMaintCounts` / `relMaintTouched` / `relMaintSummary` / `mergeRelMaint` / `demoteRelLinkOrphans` |

## 2. 与 V1 的差异（逐条明示）

1. **`relMaintRun`（非修复路径的关联维护编排）未移植**：V1 v1.206 内该函数**只有定义、无任何调用点**（也不在导出清单里），属死代码；其能力已被 `sweepOrphanRelLinks`（关系表页「🧽 清扫孤儿关联」按钮，V2 已等价接线）+ `relRepairMaint` 覆盖。移植无调用方的代码只会增加不可验证面，故按「不移植死代码」处理。
2. **第二次维护的触发条件**：V1 在各「修复规格」（记忆/情节/物品/概念/角色/场景/计划悬念）各自的 AI 段之后分别调用一次；V2 是单一三段式管道，故在「AI 修订或删除 > 0」时跑一次复检（同口径、不重复劳动）。AI 未调用时**不跑**第二次（无新增孤儿行的来源）。
3. **`runRepair` 的 `made` 口径**：V2 的 `made` 是「条目级改动数」（合并 + 清理 + AI 修订 + AI 删除）；V1 返回的是 0/1 标志位。关联层改动不计入 `made`（与 v2.16.0 前的既有行为一致，未在本批次改变），改动情况由 `relCounts` / notes 如实回报。
4. **AI 后复检的日志标签**：V1 为「记忆修复（AI 后）」，V2 统一为「修复（AI 后）」（单管道无「记忆」子域之分，调试日志动作名随之统一）。

## 3. 验证（v2.17.0）

- 门禁：`npm run gate` → 单元 **39 文件 / 539 断言**、冒烟 **96 项**、内核纯净度 0、内核标识符 0、词条 54 键、版本一致、文档 0 违规。
- 黄金样本：`tests/fixtures/v1-golden-rel-maint.json`（oracle = **真实 V1 插件 v1.206**，经 `tests/unit/helpers.js#loadPlugin` 直接调用 `relRepairMaint` / `mergeRelMaint`），
  单元 `tests/unit/rel-maint-golden.test.js` **16 项**：
  - R1–R5 `keep`：计数逐字段 / 明细（清扫行·去重行·改名行·悬空引用）/ 清理后关联表**逐行**（合并行 how 取更可靠者 + 字段并集 + 悬空引用清空）/ 墓碑 keys / `relMaintCounts·Touched·Summary` 口径；
  - R6–R7 `public`：计数 + 公开锚行（`dim/refId/kind/note`）；
  - R8 `relLinkEnabled=false` 完全不动；R9 空库（`changed=false` / 摘要空串）；R10 `clean`（只清扫不补锚行）；
  - R11 角色名归一（`who` + `from` 双字段 + 稳定 `id` 重算）；R12 只有孤儿条目的摘要分支；R13 `mergeRelMaint`（计数相加 + 明细拼接 + 空值守卫）；
  - R14 `logRelMaint` 两态（有改动写日志返回 true / 无改动返回 false 且不写）；
  - R15–R16 编排：`runRepair` 在 AI 删除条目后**再跑一次**关联维护（新孤儿行被清扫、留墓碑、合并摘要入 notes）；`repairAutoAi=false` 的自动路径不跑第二次且口径保持第 1 段。
- 冒烟 V1–V4：keep（清扫 + 去重合并 + 非法值归一 + 墓碑）、public（按维度补锚行、`parallels` 不参与）、面板「🛠 自动修复」端到端回报「关联维护」摘要、`FTT.*` 六个入口齐备。

## 4. 后续（B8-6c 起）

- 逐维度专用修复（记忆/情节/物品/概念/角色/场景/计划悬念 + 状态边界）与 `statesRepair`。
- 情节总结 / 分段总结 / 传言演化 / 平行推演与转正 / 世界书单向镜像。
