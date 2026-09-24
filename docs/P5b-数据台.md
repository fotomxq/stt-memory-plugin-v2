# P5 次批 · 数据台（浏览 / 搜索 / 编辑 / 删除 / 注入自查）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效
> 关联：`ui/console.js`、`ui/settings-panel.js`、`core/entries.js`、`core/model/rel.js`、`host/inject.js`、`docs/P5-设定面板.md`

---

## 1. 定位与范围

V1 数据面板的 V2 最小可用集：**人能看见、能改、能核对**。

| 能力 | 实现 |
| --- | --- |
| 维度浏览 | 14 类维度标签行（`DIMENSIONS`）+ 每维条数；列表**最新在前**（`consoleList`） |
| 搜索 | `entryMatches`：id / 标题 / 名称 / 正文 / 归属 / 标签 / 关键词，大小写不敏感，未命中返回空 |
| 查看与编辑 | `consoleEntry` 给出条目副本 + **关联行**（`relLinksOf`）+ **内容哈希**（`atomContentHash`）；编辑器可改标题/名称、正文/内容、日期、标签（支持 `、` 分隔）、重要度 |
| 保存 | `consoleSave` → `core/entries.js#upsertEntry`（按维度归一化）→ `saveStateNow()` 落盘；必要字段缺失（如记忆无正文、情节正文 < 8 字）**不写入**并给出原因 |
| 删除 | `consoleDelete` → `deleteEntry`（**id + 内容哈希双墓碑**，跨端/快照不会复活）→ `saveStateNow()` |
| 注入自查 | `injectAudit`：逐条判断是否出现在当前注入正文中，给出 `chars / injected / missing / rows`（V1「注入自查」轻量版） |
| 状态提示 | 顶部合计行（总条数 · 注入字数 · 命中/未命中）+ 动作提示行（保存/删除结果） |

## 2. 交互模型（渲染与动作分离）

```text
consoleAction(action, payload)   ← 唯一动作入口（tab / search / open / save / delete / cancel / refresh / audit）
   ├─ 改 ui/console.js 模块内状态 cs（tab / q / open / note）
   ├─ 需要写库时走 core/entries.js（写入方）
   └─ 返回 { ok, …, html, state }：调用方把 html 写进容器
```

- `consoleHtml()` 只产 HTML（不含外层容器）；
- `writeConsole(html)` 写入 `#ftt_v2_console`：真实 DOM 用 `innerHTML` **整块替换**（不累积），桩环境退化为 `insertAdjacentHTML`；
- `bindConsole()` 在**有 `querySelectorAll`** 的真实 DOM 上按 `[data-ftt-console]` 接线（tab / open / del / save / cancel + 搜索框）；
  无此能力的环境（Node 桩、扩展测试）由调用方直接调 `consoleAction`，因此**逻辑可完整测**；
- 保存按钮从编辑器输入框取值（`ftt_con_title/text/date/tags/imp`）后调 `consoleAction('save', …)`。

## 3. 面板接线

`settings.html` 新增「数据台」区块：`🗂 刷新数据台` 按钮 + `#ftt_v2_console` 容器；
`mountSettingsPanel()` 渲染面板后立即 `writeConsole()` + `bindConsole()`（数据台失败不影响面板挂载）；
`fallbackPanelHtml` 同样带容器。刷新按钮调 `consoleAction('refresh')` 并回填「数据台已刷新」。

## 4. 测试

`tests/smoke-test.js` J1–J6（真实宿主桩 + 真实 `settings.html`）：

1. J1 数据台随面板渲染：维度标签 / 搜索框 / 条目行 / 注入合计（14 维、总数、注入字数）；
2. J2 搜索与列表：正文命中、标签命中、未命中为空；
3. J3 编辑保存：`upsertEntry` 写回内核容器 **且信封已落盘**（读回 localStorage 信封校验新值）；
4. J4 删除：条目消失 + **id 墓碑写入** + 提示文案；
5. J5 注入自查：分析一楼后注入非空，命中 + 未命中 = 全部条目行；
6. J6 动作入口：`tab/search/cancel` 生效、未知动作返回失败、刷新按钮回填提示。

门禁口径：单元 **22 文件 / 292 断言**、冒烟 **45/45**、内核纯净度 0、内核标识符 0、版本一致性 OK、文档规范 0。

## 5. 尚未完成

| 项 | 说明 |
| --- | --- |
| 多选批删 / 批量打标 | V1 数据面板的多选与批量动作 |
| 关联编辑 | 当前只读展示关联行；写入需接 `upsertRelLinks`（关系表 UI） |
| 分页与虚拟滚动 | 当前单页上限 50 条（`cs.limit`），大库需分页 |
| 快照 / 回滚页 | 依赖快照链（未移植） |
| 提示词模板编辑页 / 高级域参数页 | 见 `docs/P5-设定面板.md` §6 |
