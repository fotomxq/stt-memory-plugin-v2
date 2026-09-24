# P8b · V1 面板外壳对齐（批次 B1 交付）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效（v2.2.0）
> 关联：`ui/panel.js`、`ui/popup.js`（兼容层）、`ui/console.js`、`ui/settings-panel.js`、`style.css`、`docs/P8-功能对齐总表.md`

---

## 1. 交付内容

| 项 | 说明 |
| --- | --- |
| **样式逐字搬运** | V1 `ensureStyle()` 的 527 行 CSS（437 处 `#ftt-panel` 规则）逐字并入 `style.css`，带「逐字移植自 V1」注释段与提取说明 |
| **DOM 同构** | `ui/panel.js#panelHtml()` 生成与 V1 `panelHtml()` **同名同层级**的结构：`#ftt-panel > .ftt-modal > .ftt-modal-head / .ftt-tabs / .ftt-body[data-ftt-body]`，因此 V1 CSS 原样生效 |
| **13 个 V1 分页** | 总览 / 情节 / 状态 / 角色 / 记忆 / 物品 / 货币 / 传言 / 计划悬念 / 场景 / 概念 / 平行 / 设置（id 与标签与 V1 一致） |
| **总览（可见子集）** | 剧情时钟三行（日期/时间/地点，含公元前/纪年/季节）、在场角色、注入审计行、类目统计徽标、已处理楼层区间、**未摘要楼层按钮**（V1 `.ftt-floor-btn`）、工具行（立即 AI 摘要 / 提取记忆 / 立即注入） |
| **维度分页** | V1 行样式（`.ftt-item ftt-inline` + `.ftt-btn`）+ 搜索（`data-ftt-search`）+ 编辑（`.ftt-editor`，字段：标题/正文/日期/标签/重要度 + 内容哈希 + 关联只读）+ 删除（留 id + 内容哈希双墓碑）；计划页合并「计划 + 悬念」两段（对应 V1 的 `plans` 子标签） |
| **设置分页** | 暂内嵌 V2 现有设置表单；B4 替换为 V1 的 14 组子页 |
| **入口** | 魔杖菜单「FTT记忆组件」、`/ftt-ui [分页]`、`FTT.ui(tab)`、右下角悬浮「FTT」按钮 → 均打开浮层；抽屉卡片仍由 `cfg.uiShowDrawer` 控制（默认关） |
| **兼容层** | `ui/popup.js` 改为转发（`popupHtml/popupTabs/popupAction/popupInfo` → panel 对应实现），既有导入与调试入口不失效 |

## 2. 行为对齐

| V1 行为 | V2 实现 |
| --- | --- |
| 点标签切页 | 事件委托 `[data-ftt-tab]` → `panelAction('tab')`；切页清空编辑态并重渲染 |
| ✕ 关闭 / 点击遮罩关闭 / Esc 关闭 | `data-ftt-action="close"`、遮罩点击、`keydown` Esc（`bindEscClose`） |
| 顶部「总记忆数 N」 | 14 类目条目之和（`totalMemory()`） |
| 每个未摘要楼层可单独分析 | `.ftt-floor-btn[data-ftt-floor]` → `panelAction('summaryFloor')` → `host/extract` |
| 编辑/删除即改库 | 复用 `ui/console.js` 的 `consoleSave` / `consoleDelete`（`upsertEntry` / `deleteEntry` + 落盘） |

## 3. 测试（`tests/unit/panel.test.js`，12 项）

S1 样式并入（关键类 + `#ftt-panel` 规则 ≥300）；S2 DOM 同构（13 个 `.ftt-body` + 头部/关闭钮/`总记忆数`）；
S3 打开/关闭；P1 总览各行与未摘要按钮；P2 维度行样式与编辑/删除按钮、计划页含悬念；
P3 空态与搜索过滤（不影响其它分页）；P4 编辑器展开 + 保存落库（标题/重要度/标签/哈希/关联）；
P5 删除留墓碑；A1 提取（全部/单楼）与立即注入；A2 切页与关闭动作；A3 设置分页内嵌表单；A4 未知动作与卸载。

冒烟 M1–M2：真实宿主桩下 `/ftt-ui`、`FTT.ui()` 打开浮层、13 分页清单、切页渲染、`/ftt` 状态行「界面：V1 同构浮层」。
门禁：单元 **24 文件 / 316 断言**、冒烟 **55 项**、五道门禁全绿。

## 4. 下一批次（B2）预告

条目操作与编辑器全量：新增/删除/多选批删/上下移/子场景/状态分组/隐藏与速览，
编辑器字段按维度字段表补齐（V1 `kindFields(kind)` 定义），并补 `selectAll/selectNone/searchClear` 等动作。
