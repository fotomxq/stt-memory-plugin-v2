# P8c · B2 条目操作与编辑器全量（V1 对齐）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效（v2.3.0）
> 关联：`ui/fields.js`（新）、`ui/panel.js`、`ui/console.js`、`core/config.js`、`core/entries.js`、`docs/P8-功能对齐总表.md`

---

## 1. 本批交付

| 项 | 说明 |
| --- | --- |
| **V1 字段表移植** | 新增 `ui/fields.js`：`kindFields(kind)`（13 维字段定义：key/label/type/options/hint）、`flattenSnapshot`（档案分组字段展开）、`deconstructEntry`（表单 → 入库 raw）。字段数与 V1 完全一致：情节 11 / 状态 5 / 角色 20 / 记忆 8 / 概念 7 / 物品 6 / 货币 7 / 分段 2 / 传言 10 / 计划 11 / 悬念 11 / 场景 3 / 平行 13 |
| **编辑器全字段** | 编辑器由字段表驱动：text/number/textarea/select/checkbox/`sceneParent`（下拉选父级）/`relTable`（关联：只读展示，编辑在 B5）；角色档案按 V1 分组语义保存（identity/personality/background/social/future + 外貌单字段 + 标签组） |
| **新增路径** | `add`（按当前分页新增）、`addStateFor`（预设主体）、`addChildScene`（预设父级，保存时由 `deconstructEntry` 拼出 `pathArr`） |
| **多选与批删** | `multiToggle`（单选/多选）、`selectAll`、`selectNone`、`bulkDelete`（逐条 `deleteEntry`，含跨端墓碑，返回删除条数） |
| **隐藏与速览** | `atomToggleHidden`（显示/隐藏「已总结」情节，附 V1 说明文案）、`atomPeek` / `atomPeekClose`（穿透查看被总结的原文） |
| **状态页分组** | 状态分页按主体分组渲染，组头带「➕ 添加」「🗑 删除分组」（`addStateFor` / `delStateGroup`） |
| **搜索与清理** | 每页搜索框 + `searchClear`（清词并清选择）；搜索字段为 V1 各维度搜索项的**超集**（见 §3） |
| **关闭语义** | `closeEntry` / `cancelEntry`（仅收起编辑器，不写库）、`editEntry`/`edit`（打开编辑器） |

## 2. 内核改动（为让状态维度可被规范化读写）

- `core/config.js#KIND_MAP` 增加 **`currentStates` 别名**（与 V1 的 `states` 指向同一容器）；
- `core/entries.js#kindNormalize` 同样识别 `currentStates`。

## 3. 有意偏离 V1（登记，不静默）

| 项 | V1 行为 | V2 行为 | 理由 |
| --- | --- | --- | --- |
| 状态删除墓碑的维度键 | `deleteEntry('states', …)` → 墓碑写进 `deleted.**states**`；但 V1 的 `ATOM_DIM_KEYS` 只含 `currentStates`，**其自身的跨端合并/清扫读不到该墓碑**（删了可能在别端复活） | V2 以**规范维度键** `currentStates` 写入墓碑（UI 分页 id 与标签仍与 V1 一致） | 用户删除必须真正生效；属**显式改进**，故在此登记 |
| 搜索字段 | 各维度各自定义搜索字段 | 取各维度主要文本字段的**超集**（id/标题/名称/正文/主体/归属/字段/值/说明/备注/位置/出身/经历/说话风格/标签/关键词/角色/实体） | 减少「明明有这条却搜不到」的情况；不改变匹配语义（仍是子串、大小写不敏感） |
| 无 DOM 回查的宿主 | — | `ui/panel.js` 在 `insertAdjacentHTML` 之后若无法用 `getElementById` 回查节点（无 DOM 树/极简宿主），改用**内存元素**承接渲染，保证「打开面板」始终成立 | 真实浏览器必能回查到节点，不会走该分支；仅为宿主健壮性 |

## 4. 测试（`tests/unit/panel.test.js`，18 项）

B1 的 12 项（样式并入 / DOM 同构 / 开关 / 总览 / 维度行 / 编辑器保存 / 删除墓碑 / 提取注入 / 切页 / 设置内嵌 / 卸载）+ B2 的 6 项：

- **B2-1** 字段表与 V1 一致（13 维字段数逐项比对 + 角色页出生日期/已去世字段存在）
- **B2-2** 新增三路径（`add` / `addStateFor` 预设主体 / `addChildScene` 预设父级 → 保存得到 `pathArr = ['城外','码头','仓库']`）
- **B2-3** 多选与批删（`selectAll` → `bulkDelete`：条目清空 + 逐条墓碑 + 选择清空）
- **B2-4** 隐藏过滤与速览（隐藏情节默认不显示、可切换显示、速览可展开/收起）
- **B2-5** 状态分组与整组删除（分组渲染 + 墓碑写规范键 + 搜索过滤 + `searchClear` 复原）
- **B2-6** `closeEntry` 不写库（保存前取快照比对）+ `deconstructEntry` 保存语义（数组/分组字段还原、重要度数值化）

**测试基建修复（重要）**：`tests/harness/st-mock.js#makeReporter.assert` 新增**防呆** —— 断言条件若是 Promise/thenable 直接判失败
（提示「未 await」）。本批一次查出并修正了 **15 处** `R.assert(name, (async () => …)())` 形式的**假绿**断言
（`panel.test.js` 12 处、`bootstrap.test.js` 2 处、`update-host.test.js` 1 处），并把面板用例改为「先 await 求值再断言」的 `A()` 助手形式。
这些断言此前恒为真、不具鉴别力；改正后暴露并修掉了 3 个真实缺陷（`states` 容器读取映射、状态墓碑维度键、搜索字段缺失）。

门禁：单元 **24 文件 / 322 断言**、冒烟 **55 项**、五道门禁全绿。

## 5. 下一批次（B3）

提取与楼层管理：区间化「未摘要楼层」清单、逐楼分析进度动效、中断当前分析、清除已处理记录，以及「立即 AI 摘要」的批量流程。
