# P10ac · 显示界面开关与入口按钮（v2.65.0，对齐 V1 + 扩展菜单项强制开启）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.65.0）
> 触发（用户要求）：「设定的**显示界面开关**存在问题，应该**与 V1 对齐**，且**根据需求展示对应的按钮入口**。
>   其中注意，当前扩展中的**窗口入口选项是强制开启的，禁止被关闭，且不展示该开关**。」

---

## 1. 问题（修复前）

| # | 现象 | 事实 |
| --- | --- | --- |
| ① | 「设定 → 基础 → 显示界面开关」**没有任何开关** | 只有一句占位说明「V2 的入口形态在『基础 → V2 附加设定』中配置（悬浮按钮 / 菜单入口 / 抽屉卡片），此处不重复」——而 V2 附加设定里并没有这些开关 |
| ② | 配置键存在但完全没接线 | `cfg.buttonLocations = { topbar:false, qr:true, float:false, menu:false }`（`core/config.js:996`，逐字移植自 V1）在 V2 里**没有任何读取方**，也没有任何界面能改它 |
| ③ | 入口形态与 V1 不一致 | V1 有顶栏 / 页面底部 / 悬浮 / 扩展菜单四项；V2 只有扩展菜单（`ftt_v2_menu_btn`）与「挂不上抽屉才出现」的兜底悬浮（`ftt_v2_float_btn`），且 id 与 V1 不同 → `style.css` 里 V1 的 `#ftt-float-button` 等规则**用不上**（悬浮按钮实际上是无样式裸文字） |
| ④ | 主入口无法固定 | 扩展菜单入口是 V2 唯一「必然可见」的入口，却与其它入口同等对待（可被配置关掉、且没有说明） |

## 2. V1 事实源（v1.206）

| 项 | 位置 | 内容 |
| --- | --- | --- |
| 入口清单 | 1130 | `BTN_LOCATIONS = ['topbar','qr','float','menu']` |
| 入口名称 | 1131 | `顶栏按钮` / `页面底部按钮` / `悬浮按钮` / `扩展菜单项` |
| 默认值 | 1428 | `{ topbar:false, qr:true, float:false, menu:false }`（载入归一化 2396/2412） |
| 设置区块 | 25401~25404 | `<div class="ftt-sec-title">显示界面开关</div>` + `buttonLocationRowsHtml()` |
| 行结构 | 24538 | `.ftt-loc-row` → `.ftt-loc-name` + `.ftt-switch[data-ftt-loc]` + 文案 `显示/隐藏` |
| 启停 | 23021 `syncButtons()` | `topbar`/`float`/`menu` 为真才建；`qr` 只要 `loc.qr !== false` 就建 |
| 落地元素 | 22936/22959/22996/23007 | `#ftt-topbar-button`（插在 `#persona-management-button` 前）／`#ftt-qr-button`（`#send_form` → `#qr--bar` → `.ftt-qr-buttons`）／`#ftt-float-button`（body，文案 `📖`）／`#ftt-menu-button`（`#extensionsMenu`，文案 `FTT记忆`） |
| 保存 | 26591~26594 + 26711 | `data-ftt-loc` → `cfg.buttonLocations[l] = checked` → `saveCfg()` → `syncButtons()`（**保存后即时生效**） |

## 3. 本批落地

| # | 文件 | 改动 |
| --- | --- | --- |
| ① | `ui/entries.js`（新增） | `ENTRY_LOCATIONS` / `ENTRY_LABELS` / `ENTRY_DEFAULTS` / `FORCED_ENTRIES`；`installTopbarEntry` / `installQrEntry`（V1 逐条移植，含旧脚本残留清理）+ 复用 menu/floating；`syncEntryButtons()`（V1 `syncButtons()` 等价物）、`entryButtonsState()`、`uninstallAllEntries()`、`normalizeEntryLocations()` |
| ② | `ui/menu.js` / `ui/floating.js` | 改用 **V1 同名 id 与标记**（`ftt-menu-button` / `ftt-float-button`），`style.css` 里 V1 的样式随之生效；悬浮按钮增加「来源」区分（`user` / `fallback`） |
| ③ | `ui/settings-pages.js` | 「显示界面开关」按 V1 `buttonLocationRowsHtml()` 重写：三个开关（顶栏 / 页面底部 / 悬浮，`data-ftt-loc`）+ **扩展菜单项一行「始终开启（主入口，不可关闭）」不带开关** + V2 附加的「扩展设置抽屉卡片」开关；一句短提示 + 折叠说明 |
| ④ | `ui/panel.js` | 新增 `data-ftt-loc` 委托（写 `cfg.buttonLocations[<loc>]` → `hooks.syncEntries()` 即时重建入口 → 重绘）；`uiShowDrawer` 改动时调 `hooks.showDrawer()` 立即挂载/卸载抽屉卡片 |
| ⑤ | `index.js` | 启动即 `syncEntryButtons(cfg.buttonLocations)`（菜单项强制）；`forceMountPanel` / `ensureVisibleEntry` / 探针统一走入口同步；兜底悬浮标记 `reason='fallback'`；`panelRuntimeHooks` 增加 `syncEntries` / `showDrawer`；`FTT.entryButtons()` 等诊断入口；`/ftt` 状态列出各入口 |
| ⑥ | `tests/` | 新增 oracle（`gen-v1-golden-entry-buttons.cjs` + fixture）与 `tests/unit/entry-buttons.test.js`（14 断言）；`bootstrap` / `panel` / `smoke` 的入口 id 断言同步 |

## 4. 有意差异（用户要求 / V2 形态）

| 项 | V1 | V2 | 原因 |
| --- | --- | --- | --- |
| 扩展菜单项 | 可关闭（`loc.menu` 为真才建） | **强制开启**，设置页**不展示开关**，只给一行「始终开启（主入口，不可关闭）」；`normalizeEntryLocations` 把 `menu` 写回 `true`（V1 存档/跨端带来的 `false` 不生效） | 用户明确要求；它是 V2 唯一必然可见的主入口 |
| 悬浮按钮 | 单一来源（用户开关） | 用户开关 + **可见性兜底**（面板挂不上时自动出现，`reason='fallback'`） | 保留 V2 原有的「装上了但看不到」防护；设置里关闭**只移除用户开启的那一个** |
| 扩展设置抽屉卡片 | 无此形态 | 同一区块内一项开关（`cfg.uiShowDrawer`），改完立即挂载/卸载 | V2 附加入口形态，此前该配置无界面可达 |
| 顶栏按钮的点击绑定 | 只绑 `.drawer-toggle` | 优先绑 `.drawer-toggle`；宿主返回的结构里找不到该子节点时退化为绑根节点 | 兼容不同发行版/原生移植的 DOM（找不到就整块不可点 → 退化为可点，宁可多绑不可不响应） |

## 5. 如实性说明（不做假入口）

- 宿主缺少对应容器时**不安装**并返回原因：无 `#top-settings-holder` → 顶栏按钮不出现；无 `#send_form` → 页面底部按钮不出现；
  无 `#extensionsMenu` → 扩展菜单项报「未找到」；面板与扩展容器都没有 → 悬浮兜底报「无可插入的容器」。
  `/ftt` 状态与 `FTT.entryButtons()` 会列出「已显示 / 未显示」。
- 关闭路径统一走 `parentNode.removeChild`（V1 用 `getElementById(id).remove()`，语义等价）；模块同时跟踪节点，
  兼容不解析 `insertAdjacentHTML` 的宿主。

## 6. 门禁

- oracle：`tests/fixtures/gen-v1-golden-entry-buttons.cjs`（真实 V1 v1.206）→ `tests/fixtures/v1-golden-entry-buttons.json`
  （入口清单 / 名称 / 默认值 / 元素 id / 区块行语义投影（默认态与全关态）/ `syncButtons()` 落地观察 / 三条说明），
  连跑两次逐字节一致。
- `tests/unit/entry-buttons.test.js`（14 断言）：A 组 oracle 对齐（常量 / 区块逐行 / 强制项无开关 / 短提示）；
  B 组真实安装（默认态、全开四入口的 id 与位置、关闭即移除、强制项、点击回调、缺容器如实报告、兜底来源保留）；
  C 组设定页开关经**真实 change 委托**即时生效（`cfg.buttonLocations` 写回 + `hooks.syncEntries` 调用、
  `uiShowDrawer` → `hooks.showDrawer`、菜单 id 诊断）。
