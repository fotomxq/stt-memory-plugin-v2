# P10ae · 扩展菜单主入口修复（v2.67.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.67.0）
> 触发（用户报告）：「**底部扩展菜单看不到面板激活的按钮**，请修复该问题，该设计为**强制打开，不允许用户关闭**。
>   其他位置的显示可根据需求调整。」

---

## 1. 根因（两处真实缺陷）

| # | 缺陷 | 事实 |
| --- | --- | --- |
| ① | **陈旧标志** | `ui/menu.js#menuInstalled()` 此前只要模块里存着节点引用就返回 `true`。酒馆**每次打开魔杖菜单都会重建** `#extensionsMenu` 的内容（清空后按扩展设置重新填充）→ 我们插入的 `#ftt-menu-button` 被清掉，模块却仍以为「已安装」→ **再也不会补回**。表现：菜单里看不到入口（或只在安装那一刻之后短暂存在） |
| ② | **安装时机** | `#extensionsMenu` 由酒馆按需创建；插件初始化（`init()` / 模块级 bootstrap / 可见性探针早期轮次）时它常常**还不存在** → `installMenuEntry` 返回「未找到 #extensionsMenu」；此后除手动改开关外**不再重试**。探针在有其它可见入口（如默认开启的页面底部按钮或悬浮兜底）后即停止，菜单项就此永久缺失 |

## 2. 修复

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `ui/menu.js#menuInstalled()` | 校验节点**是否仍挂在文档里**（优先 `isConnected`，其次 `document.contains`，再退 `parentNode`），并回查 `getElementById('ftt-menu-button')`；陈旧引用会被清掉 → 「已安装」不再说谎 |
| ② | `ui/menu.js#ensureMenuEntry()`（新增，幂等） | 先绑定观察再安装；返回 `reinserted` 便于诊断。调用点：`index.js` 初始化、每次 `syncEntryButtons`、**可见性探针每一轮**、点击魔杖按钮之后、`MutationObserver` 回调 |
| ③ | `ui/menu.js#bindMenuWatch()`（新增） | ① 捕获阶段监听 `document` 点击：命中 `#extensionsMenuButton` / `#extensionsMenu` → **下一个宏任务**补一次（酒馆正是在这次点击里重建菜单）；② 对 `#extensionsMenu` 绑 `MutationObserver(childList)`：内容被清空且我们的项不在 → 清掉「字符串插入标记」并补回；容器被整体替换时会在下次 `ensureMenuEntry` 重新绑定观察 |
| ④ | 菜单项形态 | 改用酒馆扩展菜单项的**标准结构**：`list-group-item flex-container flexGap5 interactable` + 图标（`fa-solid fa-brain extensionsMenuExtensionButton`）+ `<span>FTT记忆</span>`，并加 `tabindex="0"` / `role="button"` 与键盘 Enter/Space 触发；**V1 同名 id `ftt-menu-button`、文案与 title 不变**（`style.css`/`docs/P10ac` 的对齐口径不受影响） |
| ⑤ | 退化宿主 | 宿主不支持 `createElement`/`appendChild` 时仍走字符串插入；此时在容器上留 `__fttMenuInjected` 标记避免重复插入（重复项会真的出现在菜单里），菜单被重建时由观察者清标记再补回 |
| ⑥ | 强制语义与自查 | `syncEntryButtons` 的 `menu` 走 `ensureMenuEntry`（`cfg.buttonLocations.menu=false` 依旧不生效）；`/ftt` 的「入口：」一行把**扩展菜单项**无论装没装上**都列出来**；新增 `FTT.menuInfo()`（`menuFound / installed / watched / observing / wandId`）与 `FTT.ensureMenu()`（手动补一次）；teardown 走 `uninstallMenuEntry()` → 同时解绑观察与定时器 |

## 3. 其他位置的显示（用户允许按需调整）

- 「其他位置的显示可根据需求调整」→ 本轮**未改动**顶栏 / 页面底部 / 悬浮三个入口的默认值与行为（页面底部按钮仍按 V1 默认开启，顶栏/悬浮默认关）。
- 只做了一处诊断口径调整：`/ftt` 的入口一行现在把「未显示」也包含扩展菜单项（强制项必须可见于诊断，否则「看不到」时无从核对）。

## 4. 门禁

- 新增 `tests/unit/menu-entry.test.js`（8 断言，迷你 DOM 含 `contains`/`isConnected` 与可手动触发的 `MutationObserver` 打桩）：
  M1 安装形态（V1 id + 标准结构 + 无障碍属性）；M2 清空菜单后 `menuInstalled()` 变 false 且 `ensureMenuEntry()` 立即补回（`reinserted=true`）；
  M3 点击魔杖按钮 → 下一个宏任务补回；M4 `MutationObserver` 补回且**不重复插入**；M5 初始化时容器不存在 → 如实报告、容器出现后补装成功；
  M6 `cfg.buttonLocations.menu=false` 仍安装；M7 卸载后监听解绑、清空菜单不再补回；M8 `menuInfo()` 字段如实。
- 既有断言同步：`bootstrap` B3（改为校验真实节点/字符串插入两路）、`entry-buttons` B2/C3（新结构与 `wandId`）、冒烟 M2（入口诊断一行）。
