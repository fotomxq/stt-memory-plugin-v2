# P8z · B9-a 调试页（日志查看器 + 清空）/ 关于页（版本清单 + 清缓存 + 重载）/ 数据管理 `reset`

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：**已交付待发版**（按批次纪律：未改 `CHANGELOG.md` / `manifest.json` / `package.json` / `core/constants.js`，未 commit / tag / push）
> 关联：`ui/debug.js`（新建）、`ui/about.js`（新建）、`adapters/store.js#resetState`（新增）、`ui/settings-pages.js`、`ui/panel.js`、
> `index.js`、`devtools.js`、`tests/unit/debug-log-golden.test.js`（新建）、`tests/unit/about-golden.test.js`（新建）、
> `tests/unit/store-chat.test.js`（扩展）、`tests/smoke-test.js`（AE1–AE3）、`docs/P8-功能对齐总表.md` §6/§7
> 参照物：V1 仓库 `src/FTT记忆组件-v1.206.js`（**唯一**引用/文案对照文件；V1 仓库只读，未修改）

---

## 1. 覆盖范围（V1 能力 → V2 落点）

| V1 能力（v1.206 行号） | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| 调试日志内核 `dbgLog` / `dbgGet` / `dbgClear`（约 550–613） | `core/debug-log.js`（v2.23.0 已就位，本批**未改**）+ `adapters/debug-log.js`（localStorage 接线） | 内存环形缓冲、最新在前、上限 300、`data` 字符串原样 / 其余 JSON 截断 6000；持久化键 `SPreset_FTTMemoryDebug`；`cfg.debugEnabled === false` 不记录 |
| 调试页渲染 `debugHtml()`（约 24657–24712） | `ui/debug.js#debugLogHtml` | 类别标签（`🧠 分析记忆`/`📤 提取记忆`/… ）与配色、单条摘要（`label`/`action`/`error`/`status`/`chars`/`ms`…）、类别计数行、每条大小与总占用（`formatBytes`）、逐条 `details.ftt-dbg-item` |
| 设定页「调试」子页（约 25946–25954） | `ui/debug.js#debugPageHtml` + `ui/settings-pages.js`（`pid === 'debug'` 分支） | 「调试日志」开关 + 「关闭后不再记录新日志；已存日志仍可查看。」+「调试日志（上一轮请求的…）」查看器节 |
| 动作 `case 'dbgClear'`（约 27245） | `ui/debug.js#debugAction` + `ui/panel.js` 分发（`DEBUG_ACTIONS`） | `dbgClear()` → 重绘 → 提示「已清空调试日志」 |
| 关于页常量与读取 `ABOUT_JSON_PATHS`(~794)、`ABOUT_CACHE_KEY`、`aboutFallback()`(~799)、`aboutReadCache/aboutWriteCache`、`aboutCandidateUrls()`(~820)、`aboutFetchFns/aboutTryFetch`、`aboutLoadJson(force)`(~854)、`aboutEnsureLoaded()`(~893)、`getAboutData/getAboutState`(~906)、`aboutSortDesc`(~909) | `ui/about.js` 同名导出 | 两轮 × 多候选 × `cache:'no-store'` + 6s 超时；成功写缓存 `{ts,data}`；全失败 → 用上次缓存（`cached`）→ 再退化为内嵌兜底 `aboutFallback()`（**只说明读不到，不伪造版本内容**） |
| 关于页渲染 `aboutHtml()`（约 25180–25234） | `ui/about.js#aboutHtml` | 「关于 · FTT记忆组件」（版本行 / 版本不一致警告 / 两个按钮 / 状态行）/「它是什么」/「版本更新（倒序 · 最新在最前）」逐条版本条目 |
| 动作 `case 'aboutReload'` / `case 'aboutClearCache'`（约 27126 / 27133） | `ui/about.js#aboutAction` + `ui/panel.js` 分发（`ABOUT_ACTIONS`） | 重新获取（成功/失败两态如实提示）；清缓存 = `removeItem('fttAboutJson')` + 数据置 `null` + 状态复位 `idle` |
| `resetState()`（约 3440）+ 动作 `case 'reset'`（约 27241） | `adapters/store.js#resetState`（适配层能力）+ `ui/panel.js` 的 `reset` 分支 + 数据管理页按钮（`ui/settings-pages.js`） | 「抑制整批墓碑 → `state = emptyState()` → `saveState()` → 补 `tombstoneSweepResume()+entryIndexInit()`」；确认文案逐字一致 |
| `__FTT` 导出 `dbgLog/dbgClear/dbgGet`、`ABOUT_JSON_PATHS/aboutFallback/aboutLoadJson/aboutEnsureLoaded/aboutCandidateUrls/aboutSortDesc/aboutHtml/getAboutData/getAboutState`、`resetState` | `index.js` + `devtools.js`（`FTT.*` 18 个入口） | 同名能力（V2 另有 `dbgLogGet`/`debugLogStats`/`aboutState`/`aboutData`/`aboutInfo`/`aboutDirUrl` 等诊断入口） |

## 2. oracle 与黄金样本（真实 V1 插件 v1.206 直调）

| fixture | oracle 脚本 | 断言数 | 内容 |
| --- | --- | --- | --- |
| `tests/fixtures/v1-golden-debug-log.json` | `/tmp/gen-golden-b9a-debug.cjs` | 16 项（`tests/unit/debug-log-golden.test.js`） | 重启后从持久层读取 / 五类 `data` 归一（列表与持久层逐字节）/ 对象截断 6000 与字符串不截断 / `data=undefined` 不记录 / `kind=undefined` 键被丢 / 开关关闭不记录 / 上限 300 挤出最旧 / 持久化合并去重（内存胜）/ 同毫秒顺序 / 清空 / 配额降级 120 / `dbgEstTokens·dbgStats` |
| `tests/fixtures/v1-golden-about.json` | `/tmp/gen-golden-b9a-about.cjs` | 15 项（`tests/unit/about-golden.test.js`） | 候选地址 / `aboutFallback` / 初始态 / `aboutSortDesc` 四组 / 成功读取（状态·数据·缓存 `{ts,data}`·调用次数）/ 非 force 命中内存 / `aboutEnsureLoaded` / `cached` / `fail` / 三态渲染投影（分节·按钮·计数·倒序条目·版本不一致警告·状态行）/ `noFetch` |
| `tests/fixtures/v1-golden-reset.json` | `/tmp/gen-golden-b9a-reset.cjs` | 7 项（`tests/unit/store-chat.test.js` S8–S14） | 复位前富状态快照 / 复位后逐字段（18 容器计数 + 双墓碑 + 台账 + 统计 + 时钟 + 主角/变量/游标）/ 29 键键集 / `emptyState()` 深比较 / 幂等 / 动作闸门（取消·确认文案逐字·清空） |

- 三个 oracle 脚本的纪律与既有批次一致：日志走 **stderr**、`stdout` 只输出 JSON、结尾 `process.exit(0)`、**连跑两次逐字节一致**（本批实测 `cmp` 相同）；
  `console.log` 在 `loadPlugin` **之前**覆写（否则 V1 启动期/异步日志污染 stdout）。
- 确定性时钟：调试日志用「固定基准 + 每次调用 +1ms」（`at` 可逐字节复现）；关于页与 reset 用固定 `Date.now`。
- `tests/fixtures/v1-golden-reset.json` 是**本批新增的第三份 fixture**（任务清单只点名两份；reset 无独立 fixture 会让「逐字段对照」退化为手写期望），特此说明。

## 3. 与 V1 的差异（逐条明示）

### 3.1 调试日志 / 调试页

1. **「最新在前」的边界**：V1 每次 `dbgLog` 都做一次稳定排序（`sort((b,a)=>b.at-a.at)`），**同毫秒多条时保留插入顺序**（`s1→s2→s3`，与它注释里宣称的「最新在前」矛盾，是原生怪癖）；V2 环形缓冲用 `unshift`，同毫秒为 `s3→s2→s1`（真·最新在前）。黄金样本 `sameAtQuirk` 固化了 V1 侧事实。
2. **持久层合并时机**：V1 在**每次** `dbgLog` 的 `dbgPersist` 里把「存储中内存没有的条目」并入（多实例共存防覆盖，v1.49 修复口径）；V2 的 push 只写回自身内存，合并发生在**启动 `wireDebugLog()` 对账一次**与显式 `debugLogSync()`。
   由此产生一条**可观测偏差**：若「其它实例」在本端 push **之前**写入持久层，V1 会在该次 push 里先合并（不丢），V2 的 push 会整体写回、**覆盖掉那些条目**（`sync` 也追不回）。黄金样本 `persistMerge` 固化的是 V1 侧结果（4 条）；单测 D8/D8b 同时断言 V2 的实际行为。
3. **清空语义**：V1 `dbgClear()` 用 `localStorage.removeItem(DEBUG_KEY)`（键变为 `null`），返回 `undefined`；V2 `debugLogClear()` 写回 `[]` 并返回清空条数（适配层 `save([])`），便于动作如实回报。
4. **配额降级**：V1 写入异常时降级为「最近 120 条」（v1.23 起），黄金样本实测 135→120；V2 的适配层捕获写入异常后**不降级**（内存保持 300，持久层停留在上一次成功的内容）。
5. **`data === undefined`**：V1 `JSON.stringify(undefined).slice(...)` 抛错被 `try/catch` 吞掉 → **该条日志静默丢失**；V2 记录该条且 `data` 为空串。
6. **`kind === undefined`**：V1 记录后 `JSON.stringify` 会丢掉 `kind` 键（`typeof kind === 'undefined'`）；V2 归一为 `''`（JSON 层等价「无类别」，UI 标签回落为原键名）。
7. **提示通道**：V1 `toast('已清空调试日志','info')`；V2 写面板 `note`（文案逐字同值），面板提示一律读 `r.state.note`。
8. **`formatBytes`**：V1 是模块内私有函数（未导出）；V2 在 `ui/debug.js` 内**逐字复制**（与 `ui/sync.js#fmtBytes` 同实现），避免为一行工具函数改动既有导出面。
9. **`debugLogStats()` 为 V2 新增**（V1 无该函数）；黄金样本的计数期望由 V1 列表**派生**（不是另写一份期望值）。

### 3.2 关于页

1. **取文件路径（本页最关键的形态差异）**：V1 是 iframe 脚本，按**相对路径** `fetch('FTT-memory-changelog.json')`（相对父页 base 解析），并用 `window.parent.location` / `D.location` / `location.origin` 补一组绝对地址兜底；V2 是**原生扩展**（无 iframe），规范路径是**扩展目录的 HTTP 挂载根** `/scripts/extensions/<扩展目录>/FTT-memory-changelog.json`（`host/paths.js#extensionFolder()` 运行时推导，与 `renderExtensionTemplateAsync` 的挂载路径同源；证据：`docs/P0-探针报告.md` §1、`core/constants.js#EXTENSION_FOLDER` 注释）。
   故 V2 候选顺序 = **扩展目录绝对路径** → V1 同款两条相对路径（兜底），每轮 3 条候选（V1 为 2 条）→ 失败路径的请求次数由 4 变 6（单测 A7/A8 已固化两侧数值）。
2. **不移植 iframe base 兜底**：那是 iframe base 不一致导致 404 的补丁；原生扩展不存在该问题。
3. **兜底文案按 V2 形态改写**（3 处）：`aboutFallback().title` = `SillyTavern 长期记忆插件（原生扩展形态）`（V1 为「…（酒馆助手 / TavernHelper 经典脚本）」）；`intro.what` 的「未随 **JS** 一起部署」改为「未随**扩展**一起部署」；`intro.notes` 与失败状态行给出**扩展目录路径**（V1 给的是「与插件 JS 放在同一目录」）。其余字段（`name`/`updatedAt`/`generatedAt`/`fallback`/`intro.highlights`/`intro.entries`/`changelog`）与 V1 逐字段一致。
4. **缓存 TTL 常量**：V1 取统一存储抽象的 `storeCacheTtl(true)`（默认 10 分钟）；V2 固化为 `ABOUT_TTL_MS = 10 * 60 * 1000`（同值，去掉对未移植抽象的依赖）。
5. **自动重试加闸门**：V1 `aboutEnsureLoaded()` 判定 `cached`/`fail` 恒为 stale → 每次渲染都会立刻把状态改成 `loading` 并再发一轮读取（见 §4 缺陷 #1）；V2 增加「自动重试最小间隔 = 缓存 TTL（10 分钟）」，状态文案与 V1 语义一致（「打开本页自动重试」仍成立，只是有节流）。**V2 渲染 `cached`/`fail` 两态时展示的是真实状态行**（`📦 上次缓存（…）… 打开本页自动重试` / `⚠️ 版本清单读取失败 · 确认 … 在扩展目录（…）`），而黄金样本中 V1 渲染出的两态状态行都是 `⏳ 正在读取版本清单…`。
6. **在途去重标志的写法**：V1 `aboutLoading = (async()=>{…})()` 在「无 `await` 的早退分支」会被 `finally` 抢先清空、随后又被赋值覆盖 → 标志永久污染（见 §4 缺陷 #2）；V2 用「身份比对后清空」（`if (aboutLoading === p) aboutLoading = null`）。单测 A14 断言 V2 修好（恢复 fetch 后能立刻重读），黄金样本 `noFetch.poisoned=true` 固化 V1 侧事实。
7. **V2 仓库当前没有 `FTT-memory-changelog.json`**：按「不伪造版本数据」纪律，未读取到时如实走 `fail` + 兜底提示（冒烟 AE2 覆盖缺失态）；清单文件属部署物，若后续随扩展一起部署即自动生效。
8. 成功读取仍写 `localStorage['fttAboutJson'] = {ts, data}`（与 V1 同键同形），因此「🧹 清除本地缓存」的删除对象与 V1 完全一致。

### 3.3 `reset`（清空当前角色记忆）

1. **实现位置**：清空状态属内核/适配层能力 → 落在 `adapters/store.js#resetState`；UI（`ui/panel.js`）只做确认闸门与提示（可经 `hooks.resetState` 替换）。
2. **逐步对齐 V1**：`tombstoneSweepPause()` → `setKernelState(emptyState())`（V1 直接给 `state` 赋值；V2 的 `state` 由宿主注入，只能经内核注入视图）→ `saveStateNow({reason:'reset'})`（同一保存流水线）→ `finally { tombstoneSweepResume(); primeStateIndex(); }`（V1 为 `entryIndexInit()`）。
3. **返回值**：V1 `resetState()` 无返回值；V2 返回 `{ok, cleared:{total,per,tombs}, via, bytes, error}`，供面板如实回报「N 条已清除 · 落盘通道」（语义不变，只增回报）。
4. **`snapStore` materialize**：V1 `saveState()` 收尾会执行 `state.snapStore = state.snapStore || []`（即使无原子）；V2 在 `resetState` 里显式补这一步，使**复位后的内存态键集与 V1 完全一致**（黄金样本 `afterKeys` 为 29 键；未补则 V2 少 `snapStore` 一键）。
5. **确认闸门**：确认文案**逐字一致**（`确认清空当前角色的 FTT 记忆？此操作不可恢复，建议先导出备份。`，黄金样本从 V1 源码正则提取）；V1 用浏览器原生 `confirm`（无标题），V2 走 `confirmDialog`（`hooks.confirm` → 原生 `confirm` → **无对话框时按取消处理**，与 V1「无对话框不执行」同级效果，可测）。
6. **按钮标记**：V1 原标记 `<button class="ftt-btn" data-ftt-action="reset" class="ftt-hint-err">🗑 清空当前角色记忆</button>` 存在**重复 `class` 属性**（浏览器只认第一个 → 红色样式实际不生效，属原生标记缺陷）；V2 用既有 `ftt-err` 等价呈现并补 `title`，文案逐字一致。
7. **面板提示文案**为 V2 自有（`已清空当前角色的 FTT 记忆（N 条已清除 · 落盘 …）` / 取消态 `已取消清空（记忆未改动）`）；V1 的 toast 是 `已清空`。

## 4. V1 原生缺陷（原样保留 / 本批修复，均列明）

| # | 缺陷 | 证据（oracle 实测） | 本批处置 |
| --- | --- | --- | --- |
| 1 | **关于页渲染→重试风暴**：`aboutHtml()` 开头调 `aboutEnsureLoaded()`，而 `cached`/`fail` 恒被判 stale → 每次渲染都立刻置 `loading` 并再发一轮读取；配合「成功（`cached` 时 `ok=true`）后 `renderPanel()`」形成**无界重试**，且 `cached`/`fail` 两态状态行几乎无法被用户看到 | 黄金样本 `htmlCached.statusText`/`htmlFail.statusText` 均为 `⏳ 正在读取版本清单…`，且各自 `ensureCalls` 各 1 次 | **已修**（重试间隔闸门 = 缓存 TTL；`ui/about.js#aboutEnsureLoaded`），并在单测 A10/A11 断言两侧差异 |
| 2 | **`aboutLoadJson` 在途标志污染**：`!fns.length` 分支在任何 `await` 之前 `return`，而 `aboutLoading = (async()=>{…})()` 的赋值发生在 `finally` 之后 → 该分支走完后标志永久停在已 resolve 的旧 Promise，**此后所有读取都返回那次 no-fetch 结果**（即使 fetch 已恢复） | 黄金样本 `noFetch.poisoned=true`：`res1=res2=res3`（含恢复 fetch 后的第三次）逐字节相同 | **已修**（身份比对后清空），单测 A14 断言 |
| 3 | 同毫秒多条 `dbgGet()` 顺序与注释宣称的「最新在前」相反（稳定排序保留插入顺序） | 黄金样本 `sameAtQuirk.order = ["s1","s2","s3"]` | **原样保留不修**（V2 内核用 `unshift`，属已知偏差，§3.1-1） |
| 4 | `dbgLog(kind, undefined)` 因 `JSON.stringify(undefined).slice` 抛错被 `try/catch` 吞掉 → 该条**静默丢失** | 黄金样本 `undefinedData.recorded=0`、`storage=null` | **原样保留不修**（V2 记空串，§3.1-5） |
| 5 | 数据管理页 `reset` 按钮**重复 `class` 属性** → `ftt-hint-err` 红色样式实际不生效 | V1 源码原标记（`src/FTT记忆组件-v1.206.js` 约 25959 行） | **V2 标记修正**（`ftt-err` + `title`），文案逐字一致 |
| 6 | V1 `saveState()` 会 materialize `state.snapStore`（保存副作用改变内存态键集） | 黄金样本 `afterKeys` 含 `snapStore`（V2 `emptyState()` 里没有该键） | **V2 显式对齐**（`resetState` 内补 `snapStore = []`，附 V1 出处注释） |

## 5. 验证

- `npm run gate`（原始汇总行见交付报告）：内核纯净度 0 违规、内核标识符 0、词条门禁通过、版本一致性通过、文档 0 违规；
  单元 **54 文件 / 855 断言 0 失败**；冒烟 **121 通过 / 0 失败**（新增 AE1–AE3）。
- 新增单测：`tests/unit/debug-log-golden.test.js` **16 项**（含 5 项「已知偏差」显式断言）、`tests/unit/about-golden.test.js` **15 项**；
  `tests/unit/store-chat.test.js` 扩展 **7 项**（S8–S14，含动作闸门与逐字确认文案）。
- 冒烟新增：
  - `AE1` 调试页（`FTT.*` 18 入口 + 页内控件/查看器/计数/类别标签/清空按钮 + `dbgClear` 动作清空内存与 `localStorage` + 空态文案 + 开关闸门）；
  - `AE2` 关于页（候选地址 = 扩展目录优先 + 清单缺失如实失败 + 成功读取的来源/计数/缓存 + 页面三节与按钮 + 清缓存删键复位 + 渲染投影）；
  - `AE3` `reset`（数据管理页按钮文案 + 取消态 + 确认文案逐字 + 确认后清空且零整批墓碑）。
- 冒烟小节内注入的 `globalThis.window.localStorage` / `globalThis.confirm` 桩均在小节内清理；版本清单桩（`aboutJsonText`）在小节内复位为空。

## 6. 未实现 / 无法验证

1. **V2 仓库无 `FTT-memory-changelog.json`**：成功态只能靠桩验证（单测 + 冒烟已覆盖两种态）；真实部署后「扩展目录可读」的端到端未在真实酒馆环境验证。
2. **真实浏览器 TZ / locale**：关于页状态行含 `new Date(st.ts).toLocaleString()`（与 V1 同款）；单测只断言前缀 `✅ 版本清单已读取 · N 个版本 · `，未逐字比对本地化时间串。
3. **多实例（多标签页）并存**：§3.1-2 的「push 覆盖其它实例条目」只在 Node 环境下按语义断言，未做真实多标签页验证。
4. **调试页的 `data` 体量**：未做超大日志（300 × 6000 字）下的渲染性能测量。
5. `FTT.resetState()`（`devtools.js` 暴露的写入口）是**破坏性动作且无二次确认**（确认只存在于面板动作），属有意为之的调试能力；已在 `devtools.js` 注释中写明「本文件原约定只读，B9-a 起按 V1 同名能力放开 4 个写入口」。

## 7. 后续（B9 余项）

- `relJump`/`relGoto`（关系表双向定位）、`relPick*`（选角色追加关联行）、`relClearFilter`；
- 投喂标签分析 `rxScanTags`/`rxAddTag`/`rxScanClear`；货币追踪 `curTrack*`；同步源选择 `syncPickLocal`/`syncPickRemote`；条目瘦身与 gzip（`.json.gz`）；`promptPreview`。
- 判定不做：`presetSave`/`presetLoad`/`presetDelete`、`apiTest`、`apiModels`、`apiTemperature`/`apiMaxTokens`/`apiTopP`、按用途 API 预设选择器、`savecfg`（见 `docs/P8-功能对齐总表.md` §6.1）。
