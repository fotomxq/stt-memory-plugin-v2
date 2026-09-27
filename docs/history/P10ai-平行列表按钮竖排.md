# P10ai · 平行大类列表：右侧按钮竖向排列（v2.71.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.71.0）
> 触发（用户要求）：「平行大类中的 UI 布局需优化，尤其是**列表右侧按钮会大量挤占空间**。
>   **默认应该将按钮竖向排列**，V1 也有类似处理。」

---

## 1. V1 事实源

| 项 | 位置（v1.206） | 内容 |
| --- | --- | --- |
| 行结构 | 24481 | `<div class="ftt-item" …><div class="ftt-item-main">…9 行内容…</div><div class="ftt-item-ops ftt-ops-col">…</div></div>` |
| 操作区顺序 | 24481 | 🚀 `parallelAdvance` → ⬆ `promoteParallel` →（多选模式的勾选框）→ ✏️ `editEntry` → 🗑 `delEntry` |
| 条件渲染 | 24479/24480 | 已达衰退阈值（`parallelExpired`）→ 不渲染 🚀；已转正（`promotedTo` 非空）→ 不渲染 ⬆ |
| 竖向 CSS | 22758 | `#ftt-panel .ftt-ops-col { flex-direction: column; align-items: center; justify-content: center; flex: 0 0 auto; }` |
| 使用范围 | 全库 | `ftt-item-ops ftt-ops-col` **仅 1 处**（平行页）；其余维度沿用横向 `.ftt-item-ops` |

V2 此前把四个按钮（🚀/⬆ + ✏️/🗑）横排塞在行右侧 → 主体内容（描述、源起、目标、统计、标签、相关角色）被横向挤压，
正是用户报告的现象。

## 2. 修复

`ui/panel.js#listBody` 的行装配：

```js
// v2.71.0：平行行 = V1 同款竖排操作列；其余维度保持横向
const opsInner = (par ? par.ops : '') + peekBtn + editBtn + delBtn;
const ops = (kind === 'parallels') ? ('<div class="ftt-item-ops ftt-ops-col">' + opsInner + '</div>') : opsInner;
return '<div class="ftt-item ftt-inline">' + box
     + '<span class="ftt-grow">' + listRowMainHtml(kind, e) + relJump + '</span>' + ops + '</div>';
```

- 行主体仍由 `.ftt-grow`（`flex: 1; min-width: 0`）占满剩余宽度 → 不再被按钮挤压；
- 按钮顺序与条件渲染**照旧**（🚀 → ⬆ → ✏️ → 🗑；衰退/转正条件不变）；
- CSS 沿用 V1 已移植的 `#ftt-panel .ftt-ops-col`（未改 `style.css`）；窄屏规则 `.ftt-item-ops { flex-wrap: wrap }` 只影响横向布局，竖排列不受影响。

## 3. 有意保留的差异

| 项 | V1 | V2 | 说明 |
| --- | --- | --- | --- |
| 多选勾选框位置 | 在竖排操作列内（最后一项之前） | 在**行首**（左侧方框） | V2 各页统一口径（`data-ftt-select` 一律在左），未在本批改动 |
| 其余维度的操作区 | 横向 `.ftt-item-ops` | 同样横向（按钮直接是行的子节点） | 与 V1 一致：只有平行页竖向 |

## 4. 门禁

- oracle：`tests/fixtures/gen-v1-golden-parallels-row.cjs`（真实 V1 `parallelsHtml()`，3 条样本：普通 / 已转正 / 巨旧；
  另用 `parallelDecayCutoff = 0` 观察「全部视为衰退」分支）→ `tests/fixtures/v1-golden-parallels-row.json`：
  记录每行 `opsClass / opsActions / hasMain / hasOpsCol`、CSS 规则原文、`ftt-item-ops ftt-ops-col` 在全库的使用次数（=1）；
  连跑两次逐字节一致（投影中不含时间戳）。
- `tests/unit/parallels-layout.test.js`（9 断言）：
  A1 oracle 齐备（竖向类名 / 顺序 / 使用范围）；A2 竖向语义来自 CSS `flex-direction: column`；
  B1 V2 平行行为 `ftt-item-ops ftt-ops-col`；B2 动作顺序与 V1 同（V2 动作名 `edit/delete` 映射 `editEntry/delEntry`）；
  B3 条件渲染（已转正无 ⬆、达阈值无 🚀、巨旧条目在同列中无 🚀）；B4 主体仍在 `.ftt-grow`（内容顺序未动）；
  B5 其余维度保持横向；B6 多选模式勾选框在行首且竖排不受影响；B7 窄屏规则不受影响。
