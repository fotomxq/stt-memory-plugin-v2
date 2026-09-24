# P9a · B9-b 关系表「双向定位跳转」+「👥 选角色」选择器

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（待发版）
> 参照物：**V1 `src/FTT记忆组件-v1.206.js`**（唯一引用/文案对照文件；V1 仓库只读）
> 关联：`ui/rel-table.js`（扩展）、`ui/panel.js`（接线）、`index.js` / `devtools.js`（`FTT.*` 入口）、
> `tests/fixtures/v1-golden-rel-nav.json`（真实 V1 oracle）、`tests/unit/rel-nav-golden.test.js`、`tests/smoke-test.js`（AF1–AF3）、
> `docs/P8-功能对齐总表.md` §6、`docs/P8f-B5关系表与注入自查.md`、`docs/B9-测试完整性待修.md`

---

## 1. 覆盖范围（V1 能力 → V2 落点）

| V1 能力（v1.206 行号） | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| `relJump`（27629） | `ui/rel-table.js#relJump`（状态迁移）+ `ui/panel.js` 动作 `relJump`（导航） | 条目行「🔗」→ 切到关系表并**定位**该条目：`relFilterDim = kind` / `relFilterWho = ''` / `relJumpRef = {dim,id,title}` / `relPickRef = null` / `editor = null`，标题取 `relEntryTitle`，随后用 rAF 把 `[data-ftt-rel-entry="dim\|id"]` 滚到视野中央 |
| `relGoto`（27753） | `rel-table.js#relGoto` + `panel.js` 动作 `relGoto` | 关系表行「↗ 打开条目」→ 打开条目所在页并**把该页搜索词设为条目标题**（`title` 优先，空则 `content/text` 前 12 字）；`tabOf` 映射 `{memories, currencies, plans, suspense→plans, parallels}`，`relJumpRef/relPickRef = null`、`editor = null` |
| `relClearFilter`（27652） | `rel-table.js#relClearFilter` + `panel.js` 动作 | 清 `relFilterDim='all'` / `relFilterWho=''` / `relJumpRef=null` / `relPickRef=null`（**不清** `pageSearchQuery`） |
| `relPick`（27696） | `panel.js` 动作 + `rel-table.js#relPickState/setRelPick` | 开关选择器：**同维度 + 同 editor 标记 + 同 id** 再点一次 → 收起（`same ? null : ref`） |
| `relPickClose`（27706） | 同上 | 直接收起 |
| `relPickAdd`（27711） | `panel.js` 动作 + `rel-table.js#relPickAppendRow` | 从选择器点 ➕ **追加一行关联角色**（不落库，仍需「💾 保存关联」）；三态提示：成功 / `已加角色「X」—— 点「💾 保存关联」落库`；重复 / `「X」已在关联表里（如需再加一行可手写）`；容器缺失 / `未找到关联表容器（请重新打开该条目）`（`name` 截断 12 字） |
| `relPickAppendRow`（24897） | `rel-table.js#relPickAppendRow` | 追加一行；重复判定先按 `snapNameKey` 归一（去空白与 `·・.．`、小写）再按 `trim` 精确；平行事件默认方式 `related`，其余 `unspecified` |
| `relKnownNames`（24886） | `rel-table.js#relKnownNames` | **只读角色档案**（`state.snapshots[].name`，按档案顺序去重）；V1 的第二来源 `knownCharacterNames()` 自身也只遍历 `snapshots`（V1:8851）→ V2 不另设来源，名单等价 |
| `relFindEntryId`（24851） | `rel-table.js#relFindEntryId` | 保存后定位：`id` 命中优先，否则按 `content/text` + `title/name` **精确**匹配（列表 `reverse()` 后取首个命中） |
| `relEntryTitle`（24755） | `rel-table.js#relEntryTitle` | `title` 与 `content/text` 不同则以「：」拼接，超 60 字截断为 59 + `…` |
| `relPickPanelHtml`（24919） | `rel-table.js#relPickPanelHtml` | 选择器面板：只列角色档案；`data-ftt-rel-pick="dim\|refId"`（编辑器 `dim\|editor`）；已关联者打「已在关联」角标；空档案 / 无匹配两种空态文案与 V1 逐字一致 |
| `relPickKey` / `relPickState` / `setRelPick` / `relFilterState` / `setRelFilter` | `rel-table.js` 同名函数 | 状态读写；`setRelPick` 做 `dim/id` 字符串化与 `editor` 布尔化，`setRelFilter` 对 `jump` 做同款归一；读取一律返回**副本** |
| 条目行「🔗 关联」（24130 / 24313 / 24345 / 24514） | `ui/panel.js#relJumpBtn` | 记忆 `🔗 关联（N）`（N = 知情人数，0 时不带角标）；计划「在「记忆 → 关系表」里编辑这条计划的知情者」；悬念「…这条悬念的知情者」；平行「在关系表里编辑相关角色」 |
| 维度/角色筛选（24978/24979） | `panel.js#subViewHtml`（rel 子页） | 「当前筛选：… 清除筛选」提示行；角色筛选只保留命中该角色的条目；**维度筛选在 V2 收窄**（见 §2.2） |

`FTT.*` 新增 16 个入口（`index.js` 注入 hooks + `devtools.js` 逐个 `typeof` 守卫）：
`relPickState` / `setRelPick` / `relFilterState` / `setRelFilter` / `relClearFilter` / `relPickQuery` / `setRelPickQuery` /
`relKnownNames` / `relPickAppendRow` / `relPickPanelHtml` / `relEntryTitle` / `relFindEntryId` / `relIsRelDim` /
`relDimLabelOf` / `relJump` / `relGoto`。

## 2. 与 V1 的差异（逐条明示）

### 2.1 必要偏离（V2 架构决定，行为序与 V1 一致）

1. **跳转落点**：V1 的关系表是**一个总览页**（挂在「记忆 → 关系表」子标签下，用「维度筛选下拉」在四个维度间切换），
   故 `relJump` **恒切 `activeTab = 'memories'`**、只把 `relFilterDim` 设为该条目维度。
   V2 的关系表按**分页**隔离维度（`ui/panel.js#REL_TABDS`：记忆页→记忆、计划悬念页→计划 + 悬念两段、平行页→平行），
   一页只显示一个维度 → `relJump` 切到**条目所在页**并只把**该维度**的子标签置 `rel`（`ps.relSub[dim] = 'rel'`）。
   单测 R9 断言两者 `filter`（维度/角色/跳转引用）逐字段一致，落点差异单独登记。
2. **「维度筛选」不适用（收窄）**：V1 的 `data-ftt-relfilter="dim"` 下拉在 V2 无对应物 —— 页面即维度。
   `relFilterState().dim` 仍按 V1 归一并保留字段（供口径对照与诊断），但**不参与过滤**；
   `relClearFilter` 因此实际清「**角色筛选 + 跳转定位 + 选角色态**」。单测 R10 显式断言「把 dim 设为 `plans` 后记忆页的关系总览仍照常列出记忆条目」。
3. **`relPickAppendRow` 签名**：V1 首参是 **DOM 容器**（`box.insertAdjacentHTML`），V2 无 DOM 容器（关系行由草稿数组承载）
   → 首参改为 `dim`，并显式给出 `refId`（行容器 = 草稿槽 `dim|refId`），第 4 参 `opts.editor` 表示编辑器作用域。
   三态返回值不变：`true` / `'dup'` / `false`；V1 的「容器缺失」（`!box || !box.insertAdjacentHTML`）在 V2 映射为
   **条目引用为空 / 非关联维度 / 空名 / 关联层关闭**（均返回 `false`）。单测 R5 逐步比对 11 个 V1 用例。
4. **编辑器作用域键**：V1 编辑器的关系表容器键是 `dim|editor`；V2 统一用 `dim|refId`（草稿槽即条目引用）。
   选择器**面板的键仍与 V1 一致**（编辑器 = `dim|editor`），单测 R8/V4 断言。
5. **`relEdit` 需要切回列表子标签**：V1 关系表卡片是**卡内行内编辑**；V2 的编辑表单在列表子标签下渲染
   （`dimBodyList` 在 `curSub === 'rel'` 时提前返回），故 V2 的 `relEdit` 先把该维度子标签置回 `list`，否则编辑器不可见。
6. **动作属性名**：V1 用 `data-ftt-kind/-id/-name/-editor`，V2 面板 DOM 委托读 `dataset.kind/id/name/editor`
   → 新增按钮统一改用 `data-kind/-id/-name/-editor`（与 V2 既有 `dimBodyList` 行内按钮一致；`data-ftt-action` 不变）。
7. **`relWho` 语义更正**：V2 早期实现在「按角色筛选」时会顺带打开首条命中条目的编辑器（V1 只重绘）。
   B9-b 按 V1 更正为「只写 `relFilterWho` + 重绘」，并改由 `ui/rel-table.js` 持有筛选态（`ps.relWho` 退役为
   `panelState().relWho` 的只读透出）。

### 2.2 V1 原生怪癖（**原样保留**，未"顺手修正"）

1. **`relGoto` 不重置子标签**：V1 只切 `activeTab` / `activePlanSub` 与页面搜索词，**不重置 `activeMemSub`**
   → 记忆维度下 `relGoto` 后仍停在「关系表」子标签，搜索词只在手动切回列表后可见。V2 原样保留（不主动切回 list）。
2. **`relGoto(suspense, …)` 把搜索词写进计划页**：V1 `tabOf` 把 `suspense` 映射到 `plans`，`pageSearchQuery['suspense']` **永不被 relGoto 写入**。
   V2 原样（`REL_TAB_OF` 与 V1 逐键一致；单测 V3 断言 `search.plans === '断口之谜'`）。
3. **`relClearFilter` 不清搜索词**：V1 不动 `pageSearchQuery`（含 `relPick` 的搜索词）→ 选角色搜索词跨次保留。V2 原样。
4. **`relSave` 关选择器**：V1 `case 'relSave'` 在保存后 `relPickRef = null`。V2 在 `relAction('relSave')` 内同样清（单测 V5 断言）。
5. **`relClearFilter` 在 V1 无任何提示**：V2 为面板统一用 `setNote('已清除关系表筛选')` 回报（V2 面板无 toast，属呈现层适配）。

## 3. 验证（本批）

### 3.1 黄金样本（oracle = **真实 V1 插件 v1.206**）

`tests/fixtures/v1-golden-rel-nav.json`（由 `/tmp/gen-golden-b9b-rel-nav.cjs` 经 `tests/unit/helpers.js#loadPlugin`
直调 V1 生成，**连跑两次逐字节一致**，非手写）：

- `meta.v1SourceSnips`：V1 六个动作 case（`relJump`/`relGoto`/`relClearFilter`/`relPick`/`relPickClose`/`relPickAdd`）、
  `relSave`/`relAddRow`、两处 change 委托（`fttRelfilter`/`fttRelwho`）、`fttMsub` 重置、以及
  `relEntryTitle`/`relFindEntryId`/`relKnownNames`/`relPickAppendRow`/`relPickState`/`relFilterState`/`relPickPanelHtml`
  的**源码原文**（作为动作序/归一序证据）。
- **动作类走真实点击委托**：`F.openPanel()` 后在 `panel.listeners.click` 上派发伪事件（`target.dataset` 用 V1 的
  `fttAction/fttKind/fttId/fttName/fttEditor`）→ V1 `handleAction` 真实执行，逐步记录
  `relFilterState()` / `relPickState()` / `memSubState()` / 各页面搜索框 value / 定位提示 / 关系表条目是否渲染 / toast 文案。
  （`relJump`/`relGoto`/`relClearFilter`/`relPick*` 在 V1 **不是导出函数**，只存在于 `handleAction` 的 case 内。）
- 纯函数/状态类：`relKnownNames`（重名去重 4→3）、`relEntryTitle` 11 例、`relFindEntryId` 9 例、
  `relPickAppendRow` 11 步三态（含 `trim` 同名与 `snapNameKey` 归一「角色·甲」）、`relPickState` 6 步、
  `relFilterState` 6 步（含副本语义）、`relPickPanelHtml` 4 组投影 + 空档案文案、
  `relPickAdd` 三态 toast 文案 + 追加后的行内容。

### 3.2 单元测试 `tests/unit/rel-nav-golden.test.js`（**19 项 / 0 失败**）

- R 组（与 V1 逐项比对）：R1 样本与源码动作序证据、R2 `relEntryTitle`、R3 `relFindEntryId`、R4 `relKnownNames`、
  R5 `relPickAppendRow` 三态、R6 `relPickState`、R7 `relFilterState` + `relClearFilter`、R8 `relPickPanelHtml`、
  R9 `relJump`（四维）、R10 `relClearFilter` 收窄语义、R11 `relGoto`（四维映射）、R12 `relPickAdd` 三态文案。
- V 组（V2 编排/接线，7 项）：V1 条目行「🔗 关联（N）」四页入口、V2 `relJump` 面板编排、
  V3 `relGoto` 页面搜索词、V4 选择器开关与搜索分流、V5 端到端（跳转→选角色→追加→落库→总览出现）、
  V6 `msub` 重置定位/选择器态（不清角色筛选）与关联层关闭、V7 常量与只读诊断。

### 3.3 冒烟 `tests/smoke-test.js` AF1–AF3（3 项）

- AF1：16 个 `FTT.*` 入口齐备 + `setRelPick` 归一/副本 + `setRelFilter` 归一 + `relClearFilter` 四项清空 +
  `relKnownNames` 去重 + `relPickAppendRow` 三态 + `relSave` 落库并关选择器；
- AF2：条目行「🔗 关联（N）」；`relJump` 切页-子标签-定位提示-清除筛选；`relWho` 不再顺带开编辑器；`relGoto` 搜索词（悬念→计划页）；
- AF3：选择器面板结构（角色档案点名/➕/关闭/搜索/已在关联角标）+ `relPickAdd` 三态提示**与 V1 toast 逐字一致** +
  追加进草稿 → `relSave` 落库 → 关系总览出现。

### 3.4 门禁（`npm run gate`）

- 内核纯净度 0 违规（扫 48 文件）、标识符门禁 0 未定义（扫 90 文件）、词条 54 键、版本一致 2.29.0、文档 0 违规；
- 单元 **55/55 文件 · 874 断言 · 0 失败**；冒烟 **124 通过 / 0 失败**。

## 4. 未实现项 / 遗留

1. **V1 的「维度筛选下拉」（`data-ftt-relfilter="dim"`）不实现**（§2.1-2 的收窄；`dim` 字段仅为口径保留）。
2. **`relFillBatch` 的界面入口**（V1 v1.194 起已从界面移除，仅保留程序化接口）在 V2 同样不设按钮 —— 与 V1 一致。
3. **面板 `toast`**：V2 面板统一用 `state.note` 呈现结果（V1 用 toastr）；文案逐字对齐，呈现通道不同。
4. **真实浏览器端到端未跑**：本批验证走宿主机桩（`tests/harness/st-mock.js`）+ 真实 V1 oracle 比对；
   `scrollIntoView`（`relJump` 的滚动定位）在桩 DOM 下走 `typeof raf === 'function'` 守卫，未在真实浏览器验证滚动生效。
5. **`relRowDel` 的 DOM 索引**：V2 行内删除按钮此前只带 `data-ftt-rel-idx` 而面板委托不传 `idx` → 真实 DOM 点击拿不到行号
   （测试直调 `relAction('relRowDel', {idx})` 不受影响）。B9-b 已在点击委托里补传 `idx`（`dataset.relIdx`），
   但**未加真实 DOM 点击的自动化断言**（桩 DOM 无 closest/querySelectorAll 链路）。
6. **已知的其它 V2 关系表缺口（不在本批范围）**：关系总览行不提供「➕ 加一行角色」（在编辑器内提供）；
   计划悬念页的「关系表」子标签在 `ps.relSub` 上按 **plans / suspense** 两个维度键分别记录，而子标签点击只写当前分页键
   （`ps.tab` = `plans`）→ 同页两段的子标签联动仍不一致（V2 既有行为，本批未改）。

## 5. 后续（B9 余项）

- 投喂标签分析 `rxScanTags` / `rxAddTag` / `rxScanClear`；货币追踪 `curTrack*`；同步源选择 `syncPickLocal` / `syncPickRemote`；
  条目瘦身与 gzip（`.json.gz`）；`promptPreview`（模板预览）。
- 本批未发版、未提交（按批次纪律：不 commit / tag / push），由队长决定提交与发版时点。
