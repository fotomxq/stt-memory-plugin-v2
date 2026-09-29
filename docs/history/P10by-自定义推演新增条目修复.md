# P10by · 自定义平行推演「没有正确新增条目」修复（v3.0.13）

> 文档版本：v1.0 ｜ 日期：2026-09-29 ｜ 状态：生效（v3.0.13）
> 触发（用户原话）：「新版本 自定义平行推演触发后，没有正确新增平行条目，请修复该错误。」
> 相关：`docs/history/P10bl`（v2.99.0 自定义平行推演首版）· `docs/history/P10bo`（v3.0.3 数据变更即时落盘）

---

## 1. 复现结论（真实路径逐步验证）

在真实内核路径（`ui/panel.js#parallelCustomRun` → `index.js` 钩子 → `core/parallel.js#runParallelCustom` →
`core/ingest.js#mergeDelta` → 面板列表）上逐环节复现，确认**四条同源缺陷**，它们叠加起来正是「推演完成但看不到新增条目」：

| # | 缺陷 | 现象 |
| --- | --- | --- |
| ① | **新增条目缺日期**（AI 省略「日期」时无人兜底） | `mergeDelta` 对**情节**有「缺日期 → 用当前剧情日期」的兜底，**平行事件没有**；而列表按剧情日期倒序（`sortRecentByStoryDate`）→ 刚推演出来的条目日期为空 → **被排到整列表最后**，用户在第一屏看不到 → 「没有新增」 |
| ② | **没有任何「刚新增的是哪一条」的视觉指示** | 即使排在可见处，新行与旧行外观一致，长列表里无法辨认 |
| ③ | **返回形态只认一种** | 解析只接受 `{"平行事件":{"新增":[…]}}`；模型返回 `{"平行事件":[…]}`（数组）/ `{"新增":[…]}`（少一层）/ `{"平行事件":{"新增":{"0":{…}}}}`（对象表）/ `add`（英文键）/ 字符串条目 / `{"平行事件":{标题,正文}}`（单条）时，一律被当成「这段设想没有可推演的点」，**AI 明明产出了条目却什么都没落库** |
| ④ | **提示复述 AI 的意图而非落库事实** | `r.added/updated` 直接取 AI 的 `新增/更新` 数组长度；若条目因**同哈希 id** 被并入既有条目（或 `mergeDelta` 抛异常返回 `false`），仍然提示「新增 1」——**谎报成功** |

复现证据（本仓库内，`node` 直跑真实内核 + 面板）：

```text
修复前：新增条目 date='' → 列表顺序：旧线5, 旧线4, 旧线3, 旧线2, 旧线1, 新推演线   ← 新条目在最后
修复后：新增条目 date='1919-12-01'（= 当前剧情日期）→ 列表顺序：新推演线, 旧线5, …    ← 新条目在最前
```

## 2. 修复

### 2.1 日期兜底（`core/parallel.js#fillCustomAddDates`）

`「新增」` 条目未给日期（`日期`/`date` 皆空）时，用 `getStoryNow()` 的当天（`YYYY-MM-DD`）补齐 —— 与
`mergeDelta` 对**情节**的既有兜底同口径；**AI 已给日期则一律不覆盖**，`「更新」` 条目不动（更新路径本就逐字段保留旧值）。
无剧情日期时不补（绝不用现实年份冒充剧情时间，沿用 v2.39.0 口径）。

### 2.2 返回形态容错（`core/parallel.js#coerceParallelDelta`）

新增纯函数把 AI 返回的「平行事件」节点归一为 `{新增, 更新, 删除}`：数组形态、对象表形态、英文键
（`add/update/remove`）、字符串条目（→ `{标题}`）、**单条对象**（`{"标题":…,"正文":…}`）、以及少一层包装
（顶层直接给 `新增/更新`）全部接纳。归一**只改变取用方式，不改任何字段口径**（仍走同一条 `mergeDelta` + `normalizeParallel`）。

### 2.3 如实统计（`core/parallel.js#countCustomOutcome`）

以 `state.parallels` 的**前后差异**为准：

- `added` = 落库后新出现的 id 条数（真正新增的行）
- `updated` = 前后都在、内容变了的条数
- `dup` = AI 要求「新增」却没产生新行的条数（内容与既有条目一致 → 并入同一条）

提示与返回值改用这组数字；`added + updated === 0` 时按 **warning** 提示「本次没有产生新的平行条目」；
`mergeDelta` 返回 `false`（异常）时 **不再谎报成功**，改为 `{ok:false, error:'merge-failed'}` + 警示提示 + 调试日志。

### 2.4 「🆕 本次新增」定位（`ui/panel.js`）

落库成功后把新条目 id 记入 `ps.flash`：该行渲染出 `data-ftt-flash-id="…"` 锚点 + **🆕 本次新增** 徽标，
并在重绘后用 `requestAnimationFrame` + `scrollIntoView({block:'center'})` **滚入视野**（与 `relJump` 同款；
无 DOM / 无 rAF 时静默跳过）。切页（`tab` 动作）即清标记；`panelState().flashIds` 透出当前标记。
提示与通知同步写明新增/更新条数与「已在列表中标记「🆕 本次新增」」。

## 3. 验证

| 门禁 | 结果 |
| --- | --- |
| 新增单测 | `parallel-design` **C7**（日期兜底：省略→当天、给了→不覆盖）· **C8**（六种返回形态全部落库）· **C9**（真实结果统计：同内容第二次 → `added 0 / updated 1 / dup 1`，新内容 → `added 1` + `newIds`）· **D4**（端到端：日期兜底 + 面板标记 + `flashIds` + 切页清除） |
| 既有测试适配 | 无（`parallel-golden` V1 对齐 33 项、`parallel-design` 原 21 项全部保持通过 —— 改动只在**自定义推演**这条 V2 独有路径上） |
| 冒烟测试 | ✅ **188 项**（`BL3` 增断言：AI **故意不给日期** → 条目日期 = 当前剧情日期、列表出现该行与「🆕 本次新增」、`r.newIds` 与锚点一致） |
| 单元测试 | ✅ **125 文件 / 1976 断言** |
| 内核纯净度 / 标识符 / 词条 / 本地隐私 / 文档 | ✅ 0 违规 |
| UI 规范检查 | ✅ 0 命中（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `3.0.13`，tag `v3.0.13` |

## 4. 改动文件

| 文件 | 性质 |
| --- | --- |
| `core/parallel.js` | 新增 `coerceParallelDelta` / `fillCustomAddDates` / `countCustomOutcome`；`runParallelCustom` 改为多形态取用 + 日期兜底 + 如实统计 + 落库失败如实报错；返回值增 `dup / newIds / requested / before / after` |
| `ui/panel.js` | `ps.flash` 标记（切页清除）+ 行内 `data-ftt-flash-id` 锚点与「🆕 本次新增」徽标 + 重绘后滚入视野；`panelState().flashIds`；`parallelCustomRun` 的提示/通知改用真实结果 |
| `tests/unit/parallel-design.test.js` | 新增 C7 / C8 / C9 / D4 |
| `tests/smoke-test.js` | `BL3` 增断言（缺日期兜底 + 新增标记） |
