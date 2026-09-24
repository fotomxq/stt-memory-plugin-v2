# P8f · B5 关系表与注入自查（V1 对齐）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效（v2.6.0）
> 关联：`ui/rel-table.js`（新）、`ui/inject-check.js`（新）、`core/entries.js`（导出 `dropRelLinks`）、`docs/P8-功能对齐总表.md`

---

## 1. 关系表（对齐 V1 `12B-UI-关系表.js` / `relEditorTableHtml` / `relRowHtml` / `relSaveBox`）

| 项 | 实现 |
| --- | --- |
| 可编辑维度 | `memories` / `plans` / `suspense` / `parallels`（V1 `REL_LINK_DIMS`；平行事件的关系 = 「相关」，角色一律不知情） |
| 行字段 | 角色名 · 知情方式（亲历/目击/被告知/推断/传闻/知情/策划·主导/参与/当事人/在查；V1 `relHowOptions`）· 公共 · 来源（how=told 时占位「告知者」）· 日期 · 备注 · 🗑 |
| 类名与结构 | `.ftt-rel-box` / `.ftt-rel-table` / `data-ftt-rel-body="dim|refId"` / `[data-ftt-rel-row]` / `[data-ftt-relf=…]`（与 V1 一致，直接吃 V1 样式） |
| 保存口径 | **`upsertRelLinks(dim, refId, rows, { replace: true })` + `saveState()`** —— 与 V1 `relSaveBox` 完全一致（「当前行集合即全集」，被删的行才会真正移除）；空角色名行不落库并回报 `skipped` |
| 删除单行 | 行内 🗑 → 草稿删除（**保存前不落库**，与 V1 `relRowDel` 只改 DOM 的语义等价） |
| 清空该条目关联 | `dropRelLinks(dim,[id])`（V1 同名函数）—— 清空且**留墓碑**，跨端不复活（为复用 V1 实现，`core/entries.js` 增补导出 `dropRelLinks`） |
| 清扫孤儿关联 | `sweepOrphanRelLinks()`（目标条目已不存在的关联行） |
| 清除「推定」关联 | 删除 note 含「推定」的关联行并**留墓碑**（不动人工/AI 写入的行） |
| 按角色筛选 | `relByWho(who)`：返回该角色在各维度的关联（含知情方式与条目摘要），按 V1 的方式优先级排序 |
| 未保存草稿 | V2 用**草稿数组**（`relDrafts`）承载未保存行，并显示「（有未保存改动）/（已同步）」；**与 V1 的差异已登记**：V1 从 DOM 读行，V2 用草稿 + `bindRelTable()` 把输入写回草稿（无 DOM 环境也能完整驱动） |

## 2. 注入自查（对齐 V1 `injectCheckPanelHtml` / `injectCheckData`）

- **同源**：直接调 `buildMemoryBodyForInject(query, { diagnose: true, countUses: false, inject: true })` —— 与真实注入**同一代码路径**；
- **只读**：不写 state、不动 `uses`、零 AI（测试断言条目数不变）；
- 产出：预算明细（总预算 / 条目可用 / 约束预留 / 已用）· **【注入约束】段原文**（含是否被预算压缩、上限、位置）· 逐维**已召回计数** ·
  **未进注入的非公共信息**及原因（`not-matched` 关键词未命中 / `candidate-not-selected` 候选未入选〔条数上限或预算不足〕）· 知情角色摘要；
- 两种口径：`checkMode=kw`（按最近一次提取的关键词）与 `checkMode=bare`（按本地召回优先级），工具行与 V1 同名（🔄 刷新预览 / 🔑 按最近关键词 / 🧭 按本地召回）。

## 3. 面板接线（V1 `activeMemSub` 口径）

记忆页子标签 **📚 列表 / 🔗 关系表 / 🧷 约束自查**；计划悬念页与平行页子标签 **📚 列表 / 🔗 关系表**；
编辑器内追加该条目的**关系表**（新增条目保存时同时落关联，与 V1 编辑器一致）；
关系表子页提供维度关联总览（按条目聚合：谁/什么方式/是否公共）+ 按角色筛选 + 「🔗 编辑」跳转到条目编辑器。

## 4. 本批修掉的 3 个真实缺陷（由测试暴露）

1. **`upsertRelLinks` 的默认语义是「合并」**（`replace !== true`）→ 若按合并保存，用户在 UI 里删掉的行**永远不会真正移除**。
   已按 V1 `relSaveBox` 改为 `{ replace: true }`；
2. **`relSweep` / `relDropInferred` 是维度无关动作**，但在实现里被放在「维度校验之后」→ 无 dim 时直接 `dim-not-supported`；
   已改为优先处理；
3. **`relClearEntry` 原先用 `upsertRelLinks(…, [])`** —— 在合并语义下等于「什么都不做」（清空无效）且不留墓碑；
   已改为 V1 的 `dropRelLinks(dim,[id])`（清空 + 墓碑）。

## 5. 测试（`tests/unit/rel-inject.test.js`，8 项）

R1 维度/方式/结构 · R2 草稿语义（新增/改字段只动草稿，库不变）· R2b 保存（`replace` 语义、空行跳过、草稿清空、库真的变了）·
R3 三个清理动作（孤儿/推定/清空 + 计数）· R4 按角色筛选与方式排序 · R5 自查只读同源（预算/约束段原文/已召回/未召回原因，且数据不变）·
R6 两口径切换 · R7 面板接线（三子标签切换、动作转发、保存提示）。

门禁：单元 **27 文件 / 345 断言**、冒烟 **55 项**、五道门禁全绿。

## 6. 下一批（B6）

提示词模板编辑：33 条模板分组编辑、恢复默认（单条/全部）、模板签名与迁移、破限前置文本（`armorPreset`）导入与预览。
