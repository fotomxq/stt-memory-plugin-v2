# P10ar · 状态大类去掉「：」+ 关系表/约束自查收进「设定 → 约束」（v2.80.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.80.0）
> 触发（用户要求）：「状态大类列表不应该总是显示『：』，请去掉该符号。」
> 「记忆大类的关系表、关系约束放入设定-约束标签中。」
> 追问确认（本轮直问直答）：「约束」页收**四个维度**（记忆 / 计划 / 悬念 / 平行事件）的关系表，页内可切维度。

---

## 1. 改动一：状态行去掉「：」

| 项 | 内容 |
| --- | --- |
| 事实核对 | V1 `statesHtml()`（v1.206 约 24008）的行是 `` `<b>${field}</b>：${value}` `` —— 冒号**无条件**输出：值为空时留下拖尾冒号（`**心情**：`），字段为空时留下前导冒号（`**：**值`） |
| 落点 | `ui/list-rows.js#stateRowMainHtml`（状态页在 `ui/panel.js#statesBody` 按主体分组渲染，逐行调它） |
| 新口径 | **取消冒号**，改「字段 值」空格分隔；**字段或值为空时只输出有内容的一侧**（无字段 → 只显示值；无值 → 只显示字段），两种残缺数据都不再产出孤立标点 |
| 渲染对照 | `{field:'体力', value:'疲惫'}` → `<b>体力</b> 疲惫`；`{field:'心情', value:''}` → `<b>心情</b>`；`{field:'', value:'旧伤未愈'}` → `旧伤未愈` |

**与 V1 的关系**：属**有意偏离**（V1 有冒号）。`meta` 行（`调用N次[ · 更新 日期 时间]`）与主体分组、排序、空态文案**未动** ——
`tests/unit/state-align.test.js` 的投影改为「`<b>` 可选 + 分隔文本 + meta」，字段/值仍与 V1 oracle 逐条比对（P3），
另加 P3b 专断言「整段无冒号 + 两种残缺数据不出孤立标点」；`tests/unit/list-rows-golden.test.js` 对 states 一维按同一规则归一 oracle（V 组）。

## 2. 改动二：关系表与约束自查收进「设定 → 约束」

### 2.1 迁移前后

| | 迁移前（V1 同构） | 迁移后（v2.80.0） |
| --- | --- | --- |
| 位置 | 列表页子标签：`📚 列表 / 🔗 关系表 / 🧷 约束自查`（记忆页三档；计划悬念 / 平行页两档） | **设定 → 约束**（第 10 个子页，插在「平行」之后、「提示词」之前） |
| 维度 | 由**页面位置**决定（一页一维度，`REL_TABDS`） | **页内切换**（`data-ftt-cdim`，`REL_DIMS` 四项） |
| 列表页 | 带子标签条 | **只保留列表** |
| 状态 | `ps.relSub[tab]`（`'list' \| 'rel' \| 'check'`） | `ui/constraint-page.js` 模块内 `constraintDim`（与 `ui/rel-table.js` 持有筛选态同构） |
| 动作 | `msub`（`data-ftt-msub`） | `constraintDim`（`data-ftt-cdim`） |

### 2.2 页内结构（`ui/constraint-page.js#constraintPageHtml()`）

1. **维度切换条**：`🔗 记忆 / 🔗 计划 / 🔗 悬念 / 🔗 平行事件`（缺省「记忆」，非法值回落第一项）；
2. **关联统计 + 按角色筛选**：`关联行合计 N（记忆 a · 计划 b · 悬念 c · 平行事件 d）· 推定 · 孤儿 · 公共`、`data-ftt-rel-who`（V1 `relFilterWho` 口径）、「👥 选角色」选择器与「当前筛选…清除筛选」；
3. **关联总览**：按条目聚合（V1 关系表总览口径，`relOverviewHtml` 由 `ui/panel.js` 迁入本模块）；定位目标即使暂无关联也列出；
4. **🧷 约束自查**：`ui/inject-check.js#injectCheckPanelHtml()`（注入约束段原样预览 + 未进注入的非公共信息 + 两种口径切换）。

### 2.3 落点与动作（语义保持）

| 动作 | 变化 |
| --- | --- |
| `relJump` | 落点由「条目所在列表页 + 该维度子标签」改为 **设定页 + `settingsSub='constraint'` + 该维度**（状态迁移仍由 `ui/rel-table.js#relJump` 承担：清角色筛选 / 置跳转引用 / 关选择器）；提示语改为「已定位到『约束 → 关系表』：<维度>」 |
| `relEdit` | 面板侧**切回该条目的列表页**（`REL_TAB_OF`：悬念与计划共用「计划悬念」页）并打开编辑器 —— 关联小表随编辑器渲染在编辑器下方 |
| `relGoto` / `relClearFilter` / `relWho` / `relPick*` / `relSave` 等 | **未改**（状态迁移与文案逐字不变） |
| `constraintDim` | 新增：切维度只重置「跳转定位 + 选角色态」，**不清角色筛选**（与 V1 `fttMsub` 点击分支同口径），并确保停留在约束子页 |
| `msub` | **移除**（列表页已无子标签）；DOM 委托的 `data-ftt-msub` 同步换为 `data-ftt-cdim` |
| 条目行 title | 由「在『记忆 → 关系表』里…」改为「在『设定 → 约束 → 关系表』里…」（`ui/list-rows.js` 三个维度 + `ui/panel.js#relJumpBtn`） |

### 2.4 控件表

`SETTINGS_CONTROLS.constraint = []`（**无配置控件**）—— 正文由 `ui/panel.js#settingsBody` 在设定页容器内注入
`constraintPageHtml()`；`ui/settings-pages.js#settingsPageHtml('constraint')` 返回空串（不渲染「本页为动作页」兜底空态）。
设定子页总数 **14 → 15**，配置控件总数 **仍 173**（`settings-pages` P2 断言）。

## 3. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 版本一致性 / 内核纯净度 / 内核标识符 / 词条 / 文档规范 / 版本清单 JSON | ✅ 全绿 |
| 单元测试 | ✅ 102 文件 / 1565 断言（新增 `tests/unit/constraint-page.test.js` 13 项；`state-align` +1、`list-rows-golden` +1） |
| 冒烟测试 | ✅ 167 项（新增 BB1 状态行去冒号、BB2 约束页端到端） |

改动涉及的既有测试（均已按新结构更新）：`list-rows-golden`（states 归一）、`state-align`（投影 + P3b）、
`settings-pages`（P1 子页表 + P2/新增 P2d）、`ui-wording`（27 → 28 页）、`rel-inject`（R7 改为约束页）、
`rel-nav-golden`（R10/R12 + V1/V2/V4/V5/V6 落点）、`smoke-test`（AF2 / AJ2 + BB1/BB2）。

## 4. 未做与边界（如实登记）

| 项 | 说明 |
| --- | --- |
| 列表页「🔗 关联」入口 | **保留**（仍在记忆 / 计划 / 悬念 / 平行行上）—— 它是一键跳到该条目的关系总览，不是子标签 |
| 编辑器内关联小表 | **保留**（`relTableHtml(dim, id, {editor:true})` 随编辑器渲染在列表页）：逐条编辑仍走「✏️ 编辑」 |
| `relFilterState().dim` | 仍只作对照/诊断字段，不参与过滤（一屏一维度） |
| V1 原生怪癖 | `relGoto` 不再有「停在关系表子标签导致搜索词不可见」的问题（子标签已不存在）——该怪癖随迁移消失，`ui/rel-table.js` 文件头已同步注明 |
