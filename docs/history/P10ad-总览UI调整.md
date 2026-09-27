# P10ad · 总览 UI 调整（v2.66.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.66.0）
> 触发（用户要求）：「新版本，UI 调整：① 总览的最后一次提取应该放到**最后末端**；② 查看提取内容**高度不足**；
>   ③ **时钟来源这些提示信息完全没用**；④ 最后总览的整体 UI 布局**微调优化**。」

---

## 1. 改动总表

| # | 用户要求 | 落地 |
| --- | --- | --- |
| ① | 最后一次提取放最后末端 | `ui/panel.js#overviewBody`：把整块（一行摘要 + 「查看提取内容」折叠）从「注入概览之后、工具行之前」移到**总览末尾**；总览顺序变为：时钟 → 🧵 管线状态 → 🧷 注入概览 → 工具行 → 📚 类目统计 → ⏳ 未摘要 → ✅ 已处理 → 📤 最后一次提取 |
| ② | 查看提取内容高度不足 | 折叠正文 `<div class="ftt-pre ftt-scroll-40">`（`max-height: 40px`，只够两行）→ `<div class="ftt-pre ftt-extract-pre">`；`style.css` 新增 `.ftt-extract-pre { min-height: 160px; max-height: 46vh; overflow-y: auto; border…; }` |
| ③ | 时钟来源提示没用 | `ui/clock.js` 删除 `clockSrcHtml()`（`data-ftt-clock-src`）与「最近一次取值」摘要行（`data-ftt-clock-trace`），并清掉随之无用的导入；取值口径与候选/落盘详情仍在 **设定 → 调试「🕒 时钟取值追踪」**（`ui/debug.js`，未改） |
| ④ | 整体布局微调 | ① 总览统一容器 `.ftt-overview`（收紧 `.ftt-item` 内边距 6→4px、`.ftt-row` 8→6px、`.ftt-hint` 2px，最后一项去虚线）；② 日期/时间/地点/在场由**四条独立分隔行**合并为**一个紧凑时钟块**（`.ftt-item--col[data-ftt-clock]` + `.ftt-clock-line`，行间只留一条点线）；③ 未摘要楼层列表 `.ftt-pend-list` 限高 `32vh` 可滚（40+ 按钮不再无限撑高总览） |

## 2. 保持不变

- 「最后一次提取」的**内容与标记**不变：`data-ftt-last-extract` / `data-ftt-last-extract-line`、时间/来源/楼层/新增/AI 字数/维度/关键词，
  以及 v2.61.0 的「🕒 已校对 / 时钟未变」校对结果；空态文案改为「点上方『📤 提取记忆』」（按钮在它上方了）。
- 时钟三行文案（`📅 日期：` / `⏱ 时间：` / `📍 地点：`）与 🔒 手工徽标、手工改写工具行与编辑面板、`👥 在场角色` 一字未改。
- 时钟取值逻辑与「只取最新情节」口径未动（本批只动展示）。

## 3. 门禁

- 新增 `tests/unit/overview-layout.test.js`（6 断言）：
  O1 总览容器与**末端顺序**（最后提取之后不再有其它组件）；O2 提取内容用 `.ftt-extract-pre` 且 CSS 的 `min-height ≥ 120px`、
  不再出现 `ftt-scroll-40`；O3 总览无 `data-ftt-clock-src` / `data-ftt-clock-trace` / 「时钟来源」，而追踪本身仍在；
  O4 时钟为**单个** `data-ftt-clock` 容器 + 四条 `.ftt-clock-line`；O5 布局 CSS 齐备（`.ftt-overview` 间距、`.ftt-clock-line`、`.ftt-pend-list` 限高）；
  O6 45 个未摘要楼层时仍有 40 个按钮 + 「…+5」，限高由 CSS 承担。
- 同步更新既有断言：`clock-trace` U2（改为断言总览**不再**有这两行提示）、`clock-extract-golden` U1、`overview-last-extract` U4（位置改为末端）、
  冒烟 O1（时钟紧凑块 + 无时钟来源行）。
