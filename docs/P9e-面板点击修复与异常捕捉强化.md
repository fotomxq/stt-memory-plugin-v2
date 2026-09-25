# P9e · 面板点击修复（设置子标签无效）+ 调试/异常捕捉强化

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.34.0）
> 关联：`ui/panel.js`、`ui/settings-pages.js`、`ui/debug.js`、`host/events.js`、`core/debug-log.js`、`adapters/debug-log.js`、`index.js`、`devtools.js`、`tests/smoke-test.js`

---

## 1. 用户报告与根因（三处叠加，均已修复）

**报告**：设置的子标签点击无效。

| # | 根因 | 说明 | 修复 |
| --- | --- | --- | --- |
| ①（主因） | `ui/panel.js#ensureOverlay()` 在**宿主里已存在 `#ftt-panel` 节点**时直接 `return el`，**跳过了 `bindOverlay()`** | 面板点击委托只在「新建节点」路径绑定；酒馆重渲染 UI / 二次打开 / 预注册节点等场景下（真实使用中很常见）**委托从未绑定** → 面板上**所有**按钮与子标签都点不动 | 早退分支也调用 `bindOverlay()`（该函数以 `el.__fttBound` 幂等，重复调用安全） |
| ② | 设定子标签标记与 V1 不一致 | V2 用 `<button class="ftt-btn ftt-sm ftt-subtab" data-ftt-settings="<id>">`；**V1 是** `<a href="javascript:void(0)" class="ftt-subtab" data-ftt-subtab="<id>">`（v1.206 L25988，点击处理 `e.target.dataset.fttSubtab` L26167） | 改为 **V1 同款标记**（属性名、标签、类名、href 全对齐） |
| ③ | 点击分发「无 `data-ftt-action` 即 `return`」 | 属性型控件（设定子标签 / 记忆子标签 `data-ftt-msub` / 情节子标签 `data-ftt-asub`）**没有** `data-ftt-action` → 被早退吞掉；因此**记忆「🔗 关系表 / 🧷 约束自查」与情节「🧩 分段总结」子标签也一直点不动** | 在 `!act` 分支内**先**处理三类属性型控件（并保留 `data-ftt-settings` 旧标记兼容），再走原有的「点空白关闭」逻辑 |

**验证**：新增冒烟 **AJ1–AJ3**，用**真实点击派发**（向面板元素的 `click` 委托传 `{target:{dataset:…}}`）断言：
- AJ1：设定子标签点击 → `settingsSub` 切换并重绘对应子页（同时断言 V1 同款标记、且旧的 `ftt-btn ftt-sm ftt-subtab` 不再出现）；
- AJ2：记忆子标签 → `relSub` 切换；情节子标签 → `atomSub` 切换；并断言宿主已有节点时 `__fttBound === true`（锁定根因①）；
- 单元 `panel.test.js#A3` / `bootstrap.test.js#B10` / `separate-dim-golden.test.js#U1` 同步改为 V1 同款标记断言（并新增 `href`/`class` 断言防回归）。

## 2. 调试强化：异常捕捉（本轮新增）

| 能力 | 落点 | 口径 |
| --- | --- | --- |
| 全局脚本错误 | `host/events.js#installErrorCapture`（`window.addEventListener('error')`） | 记录 `kind='脚本错误'`：message / source / line / col / stack（截断 2000 字） |
| 未处理的 Promise 拒绝 | 同上（`'unhandledrejection'`） | 记录 `kind='未处理的 Promise 拒绝'`：reason 归一（Error → message+stack；其它 → 字符串/JSON） |
| 面板动作失败 | `ui/panel.js` 动作分发的 `catch` | 记录 `kind='面板动作失败'`：action + message + stack |
| 写入与去重 | `core/debug-log.js`（环形缓冲 300 条，最新在前） | 统一 `kind='异常'`；**同类同址 1 秒内去重**；单条 ≤2000 字；受 `cfg.debugEnabled !== false` 控制 |
| 查看 | `ui/debug.js`（设定 → 调试）新增「⚠ 异常捕捉」只读区 | 计数 + 最近一条（时间/类别/消息/来源行号）+ 最近 3 条摘要 |
| 一键诊断 | `FTT.dbgDump()` | version / ready / debug（持久化接线）/ errCapture / errors / lastErrors / stats / recent(10) / probe.missing / lastError |
| 其它入口 | `FTT.dbgErrors(limit)` / `dbgErrorCount()` / `dbgLastError()` / `errCaptureState()` | 供用户自查与排障 |
| 生命周期 | `index.js#init` 安装、`teardown` 解绑 | 无 `window.addEventListener`（Node 测试/受限宿主）时返回 `false`，纯内存退化 |

> V1 无此能力（V1 只在各处 `try/catch` + `dbgLog`）；本批为 V2 的**增强项**（明确标注为「超出 V1」的能力，不冒充 V1 行为）。

## 3. 测试框架修复（本轮顺带发现）

冒烟断言器（v2.25.0 起带 thenable 防呆）存在一个**残留漏洞**：**未 `await` 的 thenable 断言若排在文件末尾**，
防呆判定的微任务尚未执行，脚本就已 `process.exit(0)` → 该断言**既不计数也不报错（静默消失）**。
修复：断言器登记 `pendingGuards`（暴露 `settle()`，**不置 `awaited`** 以免掩盖漏写），收尾统一 `settle()` 并等待两个宏任务后再汇总。
—— 本批新增的 AJ1–AJ3 曾因漏写 `await` 触发该漏洞（无任何输出），修复后此类断言必定计入失败。

## 4. 用户提供的 TauriTavern 日志解读（只读分析，非本插件缺陷）

| 日志现象 | 结论 |
| --- | --- |
| `Failed to get extension version: Internal error: Git handshake failed: An IO error occurred when talking to the server` | **TauriTavern 自身**「按 git 查询各扩展版本」的网络失败：日志里对**约 40 个扩展**（`/World`、`/Outfit-Manager`、`/ST-Prompt-Template`、`/st-memory-enhancement`、`/stt-memory-plugin-v2` …）**逐个出现同样报错**，与本插件代码无关。本插件 `manifest.json` 保持 **`auto_update: false`**（v2.11.1 起的修复），且自建更新检查走 `raw.githubusercontent.com` 的 **HTTP** 路径、**不使用 git** |
| `Extension installed: FTT记忆组件 V2 v2.0.0` / `v2.0.1` | 当时安装的是 **v2.0.0 → v2.0.1**（2026-09-24），远早于当前最新 tag **v2.33.0/2.34.0**；建议升级（TauriTavern 的 git 更新在其网络下失败，可改用「直接下载 zip / 覆盖安装」） |
| `Failed to generate chat completion: Custom OpenAI endpoint failed with status 500: Upstream quota exhausted` | 用户 API 提供方的**配额耗尽**，与本插件无关 |
| `WARN ... Conflict: Another local mutation is already running` | TauriTavern 的本地并发写冲突（其扩展安装/更新互斥），非本插件触发 |
| `/silly-tavern-reminder`、`/ST-Prompt-Template` 等安装/更新失败 | 同类 git 网络问题，与 FTT 无关 |

## 5. 验证

- 门禁全绿：单元 **60 文件 / 951 断言**、冒烟 **136 项**（新增 AJ1–AJ3，且断言器收尾 flush 生效）、
  内核纯净度 0、内核标识符 0、词条 54、版本一致、文档 0 违规；`git archive` 解包复验同样全绿。
- 修复前后对照（队长实测）：修复前真实点击派发 → `settingsSub` 不变（`base`→`base`）、`relSub` 不变、`atomSub` 不变；
  修复后 → `base→feed→storage`、`relSub.memories='rel'`、`atomSub='segments'` 全部生效。
