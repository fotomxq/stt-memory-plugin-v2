# P10as · 点击按钮不再「闪一下」（v2.80.1）

> 文档版本：v1.0 ｜ 日期：2026-09-27 ｜ 状态：生效（v2.80.1）
> 触发（用户原话）：「每次点击按钮，插件页面会闪一下，请修复该问题。」
> 关联：`ui/panel.js`（`panelHtml` / `panelModalInnerHtml` / `renderPanel` / `existingModalNode`）、
> `style.css`（`#ftt-panel .ftt-modal` 的入场动画）、`tests/unit/panel-rerender.test.js`、`tests/smoke-test.js`（BC1）、
> `docs/04-应用架构.md` §4

---

## 1. 根因（先复现到唯一解释）

| 环节 | 事实 | 落点 |
| --- | --- | --- |
| ① 每次点击都会重渲染 | `panelAction()` 在**每个动作结束**都调用 `renderPanel()` | `ui/panel.js:2163` |
| ② 重渲染是**整树替换** | `renderPanel()` 此前执行 `el.innerHTML = html`（`el` = `#ftt-panel`） | `ui/panel.js:1252`（修复前） |
| ③ 于是 `.ftt-modal` 节点被**销毁重建** | `panelHtml()` 返回的字符串里含 `<div class="ftt-modal">…</div>`，整树替换即重建该节点 | `ui/panel.js:1127`（修复前） |
| ④ 入场动画挂在 `.ftt-modal` 上 | `#ftt-panel .ftt-modal { animation: fttModalIn .22s cubic-bezier(…) both; }` | `style.css:404` |
| ⑤ 动画关键帧从**不可见**开始 | `from { opacity: 0; transform: translateY(10px) scale(.985) }` | `style.css:395` |

**结论**：节点重建 → CSS 动画重放 → 每次点击都有一次 **220ms 的淡入 + 下移**，即用户看到的「闪一下」。
点得越快越明显（动画被反复从头播放）。

## 2. 修法

| # | 改动 | 说明 |
| --- | --- | --- |
| ① | `panelHtml()` 拆出 `panelModalInnerHtml()` | 后者返回模态**内部** HTML（标题栏 + 标签条 + 分页正文）；`panelHtml()` 仍返回**完整**浮层 HTML → 外部接口与既有测试口径**逐字节不变** |
| ② | 新增 `existingModalNode(el)` | 取当前浮层里**已存在且可写**的 `.ftt-modal`（严格判定：必须是元素、`innerHTML` 必须是字符串，否则返回 `null`） |
| ③ | `renderPanel()` 优先**复用**该节点 | 只写 `modal.innerHTML = 内部 HTML` → 节点不重建 → **入场动画不重放** |
| ④ | 单次渲染 | 内部 HTML 只算一遍（`ensureButtonTypes` 后同时供两条路径使用），不再重复渲染 13 个分页 |
| ⑤ | 回落路径保持原样 | 首次打开 / 关闭后再打开 / 无 DOM 或伪节点 → 仍走 `el.innerHTML` 整树替换 |

**刻意保留的行为**（动效只应出现在该出现的地方）：

- **打开面板**时入场动画照旧播放（首次渲染没有既有模态节点 → 整树替换 → 动画播放）；
- **关闭后再打开**同样播放（`closePanel()` 清空后模态不存在）；
- **滚动恢复**（"点击不跳顶"）在复用路径下依旧执行：`applyPanelScroll` + `scheduleScrollRestore`；
- 面板宽度 CSS 变量下发、按钮 `type="button"` 双保险（字符串层 `ensureButtonTypes` + DOM 层 `hardenButtonTypes`）不变。

## 3. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增单测 `tests/unit/panel-rerender.test.js` | ✅ 11 项：节点同一性（同一对象）· 覆盖层不再被整树替换 · 两条路径内容一致 · `panelHtml()` 口径不变 · **连续 6 次真实动作后模态仍是同一节点** · 切页内容确实更新 · 关闭后再打开回到整树替换 · 无模态 / 伪节点安全回落 · 复用路径滚动恢复仍生效 · CSS 因果链自证 |
| 新增冒烟 `BC1` | ✅ 真实动作两次 → 模态节点复用、覆盖层只替换一次、内容确实切换 |
| 单元测试 | ✅ 103 文件 / 1576 断言 |
| 冒烟测试 | ✅ 168 项 |

## 4. 未做与边界

| 项 | 说明 |
| --- | --- |
| 模态内部仍整体重建 | 标题栏 / 标签条 / 分页正文仍随每次渲染重写（**不重建节点**，故无可见闪烁）；连续动画（如标题琥珀点呼吸）会重置相位，肉眼无感 |
| 不引入 DOM diff | 保持「字符串渲染 + 单点写入」的既有架构（无框架、无依赖），避免为动效引入复杂度 |
| 分页切换的动效 | 面板原本的 `ftt-body-in` 子元素动画规则从未被代码启用（死 CSS），本版未启用也未删除 —— 不在本次用户要求范围内 |
