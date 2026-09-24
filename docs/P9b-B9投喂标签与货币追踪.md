# P9b · B9-c 投喂标签自动分析 + 货币追踪（「👥 指定角色」标定）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（待发版）
> 参照物：**V1 `src/FTT记忆组件-v1.206.js`**（唯一引用/文案对照文件；V1 仓库只读）
> 关联：`ui/feed-scan.js`（新建）、`ui/panel.js`（货币页 + 6 个动作）、`ui/settings-pages.js`（投喂页分支）、
> `core/model/money.js`（选择器开关）、`index.js` / `devtools.js`（`FTT.*` 入口）、
> `tests/fixtures/v1-golden-feed-scan.json` / `v1-golden-cur-track.json`（真实 V1 oracle）、
> `tests/fixtures/gen-v1-golden-feed-scan.cjs` / `gen-v1-golden-cur-track.cjs`（oracle 生成器，已入库）、
> `tests/unit/feed-scan-golden.test.js`、`tests/unit/cur-track-golden.test.js`、`tests/smoke-test.js`（AG1–AG3）、
> `docs/P8-功能对齐总表.md` §6、`docs/P9a-B9关系表定位与选角色.md`、`docs/B9-测试完整性待修.md`

---

## 1. 覆盖范围（V1 能力 → V2 落点）

### 1.1 投喂标签自动分析

| V1 能力（v1.206 行号） | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| `latestAiFloorInfo`（696） | `ui/feed-scan.js#latestAiFloorInfo` | 从 `getLastMessageId()` 起**向前回溯最多 60 楼**（`i >= last - 60`），跳过隐藏楼 / 用户楼 / `role` 非 `assistant` 的楼 / 空白正文楼；命中即返回 `{text(trim 后), floor}`，否则 `{text:'', floor:-1}` |
| `rxNormTag`（713） | 同上 `rxNormTag` | 去 `<content>` / `</content>` 包裹（`^<\s*\/?\s*` + `\s*\/?\s*>$`）→ 去首尾 `【】［］（）"「『` 等括号/引号 → `trim` → 截 40 字 |
| `rxAnalyzeLatestText`（720） | 同上 `rxAnalyzeLatestText` | HTML 标签名（`<name ...>` 开标签计数 + `</name>` 判成对）与行内标记（`[【\[]([^】\]\n]{1,24})[】\]]`，必须含至少一个实义字符）；排序 = **成对优先 → 次数降序 → 名称 `localeCompare` 升序**；各取前 30；结果缓存于模块级 `rxTagScan`（`ts` 为 `Date.now()`） |
| `rxDedupeTagList`（755） | 同上 `rxDedupeTagList` | 逐个 `rxNormTag` → 去空 → 大小写不敏感去重 → **保序**；非数组入参返回空数组 |
| `rxPushFeedTag`（766） | 同上 `rxPushFeedTag` | 收录到 `cfg.feedRegexWhitelist` / `cfg.feedRegexBlacklist`（`kind === 'black'` 才算黑，**未知 kind 一律按白**）；返回 `{added, reason(''|'dup'|'empty'|'error'), tag, n, other}`；`other` = 该标签是否也存在于**另一侧**名单；成功后 `saveCfg()`（落盘失败被 try/catch 吞掉，不影响内存写入） |
| `rxTagScanHtml`（25157） | 同上 `rxTagScanHtml` | 三态：未分析占位 / 无正文告警 / 结果（`📄 第 N 楼 AI 正文 · M 字 · 标签 X 种 / 标记 Y 种（已收录高亮）` + 两行 chip）；每个 chip 带「＋白」「＋黑」，已收录者加 `ftt-chip-btn--on-w` / `-on-b` 高亮 |
| 设定页「投喂标签自动分析」节（25513–25517） | `ui/feed-scan.js#feedScanSectionHtml` + `ui/settings-pages.js` 的 `feed` 分支 | 节标题 + 两个按钮（`rxScanTags` / `rxScanClear`，**V1 无 title**，故 V2 同样不设）+ 说明 `<div class="ftt-muted ftt-my-1">` + 结果区 |
| 设定页「投喂白/黑名单标签」两节（25518–25527） | 同上 `feedTagListSectionsHtml` | 节标题 + `<textarea class="ftt-textarea">` + 说明；**保存时整表排重** |
| 动作 `rxScanTags`（27087） | `ui/panel.js` 的 `FEED_SCAN_ACTIONS` 分支 + `feedScanAction` | 分析 → `renderPanel()` → 有正文 `notify('info', {title:'已分析最新正文结构', text:'第 N 楼 · M 字 · HTML 标签 X 种 / 行内标记 Y 种；点标签右侧「＋白」/「＋黑」即可收录。'})`；无正文 `notify('warning', {title:'未取到最新正文', text:'当前会话没有可分析的 AI 回复（或正文为空）。'})` |
| 动作 `rxAddTag`（27094） | 同上 | 按 `data-ftt-kind`（非 black 一律 white）+ `data-ftt-tag` 收录；重复 → `已在白/黑名单中（自动排重）` / `X · 当前共 N 项`；空标签 → `未收录` / `标签为空，未收录。`；成功 → `已加入白/黑名单` / `X · 当前共 N 项（注意：该标签也存在于另一侧名单）` |
| 动作 `rxScanClear`（27103） | 同上 | `rxTagScan = null` + `renderPanel()`；**V1 无任何提示**（V2 同样不写 note） |
| `__FTT` 导出（28125） | `index.js` + `devtools.js` | `latestAiFloorInfo` / `rxAnalyzeLatestText` / `rxNormTag` / `rxDedupeTagList` / `rxPushFeedTag` / `rxTagScanHtml`（+ V2 诊断用 `rxTagScan` / `setRxTagScan` / `rxFeedTagLists` / `feedScanAction`） |

### 1.2 货币追踪（「👥 指定角色」标定）

| V1 能力（v1.206 行号） | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| `let currencyTrackPicking`（22349）/ `trackPickState`（23745）/ `setTrackPick`（23746） | `core/model/money.js#trackPickState` / `setTrackPick` | 选择器开关的读写（真值化）；UI 事件与测试共用 |
| `currenciesHtml()` 顶部（24156–24166） | `ui/panel.js#currencyTopHtml` / `currencyStatText` | 统计胶囊 `共 N 条货币 · M 个归属（前 3 个归属计数…）`（V1 `catStat('currencies')`）+ **标定时追加 ` · 已标定 K 名`**；说明 `💰 默认只记主角（当前判定：X）持有的货币…额度按 万 / 亿 / 兆 / 京 动态显示，收支保留最近 12 笔。` |
| 标定胶囊（24168–24170） | `ui/panel.js#currencyTopHtml` | `⭐ 已标定跟踪：` + 每个角色一个 `ftt-badge ftt-badge--fact`，胶囊内 `✖` 直接取消标定（`curTrackToggle`）+ 尾注「被标定后：分析记忆会**恒定**考虑…」 |
| 按钮行（24171–24173） | `ui/panel.js#currencyTrackButtons` | `👥 指定角色（N）`（恒显，开启选择器时加 `ftt-primary`；`title="从「角色」大类里指定要跟踪货币的角色（可多选；被标定后分析记忆会同时考虑其货币情况）"`）+ `✖ 清空标定`（**仅在有标定角色时显示**；`title="取消全部标定角色"`） |
| 选择器（24175–24196） | `ui/panel.js#currencyPickPanelHtml` | 标题 `👥 指定跟踪角色 · 从「角色」大类选择（已标定 N 名）` + 说明 + 搜索框（`data-ftt-search="currencyTrackPick"`）+ 角色行（`已标定` 角标；`✅`/`➕` 带 `title="取消标定"` / `"标定为跟踪对象"`）+ `关闭`（`curTrackClose`）；角色名单 = `knownCharacterNames()`（角色档案去重后 `localeCompare` 排序）；空档案 / 无匹配两种空态文案与 V1 逐字一致 |
| 动作 `curTrackPick`（27480）/ `curTrackClose`（27486） | `ui/panel.js` | `curTrackPick` 是**纯开关**（`!picking`）；`curTrackClose` 直接置 false；两者**都无提示** |
| 动作 `curTrackToggle`（27487） | 同上 | `data-ftt-name` → 已标定（`isTrackedCurrencyOwner`）则移除并 `toast('已取消标定「X」','info')`；否则新增并 `notify('success', {title:'已标定「X」', text:'后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。'})`；**空名直接 break**（不提示、不重绘） |
| 动作 `curTrackClear`（27496） | 同上 | 清空全部标定；`toast(n ? '已清空 N 个标定角色' : '当前没有标定角色','info')` |
| 名单访问器（8811–8862） | `core/model/money.js`（**既有批次已交付**） | `trackedCurrencyRoles` / `isTrackedCurrencyOwner`（去空白 + 小写 + **简称双向包含**）/ `addTrackedCurrencyRole` / `removeTrackedCurrencyRole`（**只做精确匹配**）/ `clearTrackedCurrencyRoles` / `knownCharacterNames` |
| `buildCurrencyTrackedSection`（14497）/ `buildCurrencyLedgerText` | `core/prompt.js`（**既有批次已交付**） | 标定段**恒定**追加（`{{标定角色}}` / `{{角色}}` 占位替换）+ 当前货币账本作为更新参照；本批用 oracle 交叉验证段文本**逐字节一致** |
| `__FTT` 导出（v1.183 段） | `index.js` + `devtools.js` | `normalizeTrackedRoles` / `trackedCurrencyRoles` / `isTrackedCurrencyOwner` / `knownCharacterNames` / `addTrackedCurrencyRole` / `removeTrackedCurrencyRole` / `clearTrackedCurrencyRoles` / `trackPickState` / `setTrackPick` / `defaultCurrencyOwner` |

## 2. 与 V1 的差异（逐条明示）

1. **楼层读取走宿主层**：V1 `latestAiFloorInfo` 调 TH 的 `getLastMessageId()` + `getChatMessages(i, {hide_state:'all', include_swipes:true})`（取 `msgs[0]`）；V2 用 `core/model/runtime.js#getLastMessageId()` + `host/floors.js#floorMessage(i)`（同一份 `ctx.chat[i]` 原始消息），取文函数 `assistantTextOf(m) || m.mes` 与 V1 `getAssistantText(m) || m.mes` 同实现（见 `host/floors.js` 文件头对照）。
2. **投喂白/黑名单文本域的配置键**：V1 写成**别名** `data-ftt-cfg="rx_whitelist"` / `"rx_blacklist"`，靠 `settingsApplyAll`（26567–26570）映射回 `cfg.feedRegexWhitelist` / `cfg.feedRegexBlacklist` 并 `rxDedupeTagList(value.split('\n'))`；V2 无「批量保存」层（每个控件即时写回），故文本域直接用 V2 规范键 `feedRegexWhitelist` / `feedRegexBlacklist`，排重改在面板 `change` 委托里对这两个键调用 `rxDedupeTagList(String(value).split('\n'))`（语义与 V1 相同，单测 V5 覆盖）。
3. **V1 `notify(title, text)` 的 V2 呈现**：V1 用 toastr 两行（title + text）；V2 面板只有一行 `state.note`，约定 `note = title ? title + '：' + text : text`（`toast(text)` 无标题 → note = text）。`feedScanAction()` 同时返回 `title` / `text`（与 V1 toast 字段**逐字一致**，供黄金样本比对）与合成后的 `note`。
4. **选择器搜索框**：V1 用通用筛选条 `searchBoxHtml('currencyTrackPick', '搜索角色名…', …)`（字段 / 排序 / 额外条件 / 模式 4 个下拉 + 计数 + 清除）；V2 沿用 B9-b「👥 选角色」面板的既有约定 —— 单输入框（`data-ftt-search="currencyTrackPick"`，placeholder 与 V1 逐字同为 `搜索角色名…`）+ `角色档案 N 名 · 显示 M 名` 提示行。搜索词仍走**同一页面搜索词槽**（V1 `pageSearchQuery['currencyTrackPick']` ↔ V2 `ps.q['currencyTrackPick']`），过滤语义一致（单测 R8 比对无匹配 / 命中两态投影）。
5. **属性名**：V1 用 `data-ftt-name`（`curTrackToggle`）；V2 面板 DOM 委托读 `dataset.name` → 行内按钮用 `data-name`（B9-b 起的既定约定，`data-ftt-action` 不变）。
6. **货币页 DOM 次序**：V1 为「head 胶囊 → 说明 → 标定胶囊 → 按钮行（含 ➕ 新增货币）→ 选择器 → 列表」；V2 复用维度页通用骨架，为「胶囊 + 说明 + 标定胶囊 → **通用工具行**（➕ 新增 / 单选多选 / ▸ 本批追加的 `👥 指定角色`、`✖ 清空标定`）→ 选择器 → 搜索行 → 列表」。V1 的 `➕ 新增货币` 在 V2 由通用 `➕ 新增`（`data-ftt-action="add" data-kind="currencies"`）承担，**不重复出按钮**。
7. **`✖` 取消标定在胶囊内**：V1 用 `<span class="ftt-rel-jump" data-ftt-action="curTrackToggle">`；V2 同名同结构（保留 `ftt-rel-jump` 类以复用 V1 样式），仅把 `data-ftt-name` 换成 `data-name`（同 §2.5）。
8. **可选调试入口**：V2 额外暴露 `rxTagScan` / `setRxTagScan` / `rxFeedTagLists` / `feedScanAction`（便于诊断），V1 只导出六个同名函数；`setRxTagScan` / `rxPushFeedTag` / 标定三个写入口与 V1 一致地**有意放开**（`devtools.js` 文件头已注明本类写入口）。
9. **选择器开关落在模型层**：V1 的 `currencyTrackPicking` 是 UI 层模块级变量；V2 放在 `core/model/money.js`（与名单访问器同文件，纯布尔 + 两个读写函数，**不触宿主/DOM**，通过内核纯净度门禁）。

## 3. V1 原生缺陷 / 怪癖（**原样保留**，未「顺手修正」）

1. **`latestAiFloorInfo` 只回溯 60 楼**：AI 正文在第 `last - 61` 楼及更早时判为「无正文」（黄金样本 `far` 场景：`last=70`、正文在 5 楼 → `floor=-1`）。
2. **`rxPushFeedTag` 空标签分支不算 `n`**：`n` 恒为 `0`（**不是**当前名单长度），与 `dup` 分支（`n` = 当前长度）不一致 —— oracle 实测已固化（`{added:false, reason:'empty', tag:'', n:0}`）。
3. **未知 kind 一律按白**：`isBlack = kind === 'black'`，传 `'weird'` 或缺失即写白名单（单测 R5 第 9 步）。
4. **`rxTagScanHtml` 不阻止重复点击**：已收录标签只做高亮，重复点击由 `rxPushFeedTag` 的 `dup` 分支回报（`notify` 文案带「自动排重」）。
5. **`rxScanClear` 无提示**：清空后没有任何 toast（V2 亦不写 note）。
6. **`rxTagScan` 跨重渲染保留**：只有 `rxScanClear` 或再次 `rxScanTags` 才改变；切页 / 切子页 / 重绘都不丢（单测 V4）。
7. **选择器「已标定」判定与「取消标定」判定口径不同**：选择器行内 `isOn` 用**去空白 + 小写精确比较**，而 `curTrackToggle` 用 `isTrackedCurrencyOwner`（额外支持**简称双向包含**）。
8. **由此派生的不一致（原样保留）**：标定名单为 `['角色']` 时点「角色乙」—— `isTrackedCurrencyOwner('角色乙')` 为 `true`（包含匹配）→ 走移除分支并提示 `已取消标定「角色乙」`，但 `removeTrackedCurrencyRole` 只做**精确**匹配 → **名单实际不变**。oracle 已固化该步（`['角色']` 移除「角色乙」后仍为 `['角色']`）；单测 V3 断言该怪癖。
9. **`curTrackPick` 是纯开关**：不重置搜索词、不重置页内其它状态；`curTrackClose` 与「再点一次 `curTrackPick`」等价（都置 false），差别仅在 `curTrackClose` 不改变其它任何状态。
10. **`curTrackToggle` 空名直接 break**：`if (!nm) break;` —— 不提示、不重绘。

## 4. 验证（本批）

### 4.1 黄金样本（oracle = **真实 V1 插件 v1.206**）

两份 fixture 均由**已入库**的生成器直调 V1（`/home/ubuntu/st/STT记忆插件/tests/unit/helpers.js#loadPlugin`）生成，**连跑两次逐字节一致**（`ts` 为 `Date.now()`，已在投影中删除）：

- `tests/fixtures/v1-golden-feed-scan.json`（生成器 `tests/fixtures/gen-v1-golden-feed-scan.cjs`）
  - `meta.v1SourceSnips`：`latestAiFloorInfo` / `rxNormTag` / `rxAnalyzeLatestText` / `rxDedupeTagList` / `rxPushFeedTag` / `rxTagScanHtml` / 三个动作 case / 设定页「投喂」节原文 / `settingsApplyAll` 的别名键映射 / 导出清单片段。
  - 纯函数：`latestAiFloorInfo` 四态（normal / userOnly / none / far）、`rxNormTag` 21 例、`rxDedupeTagList` 6 例、`rxPushFeedTag` 9 步（含两侧名单）、`rxAnalyzeLatestText` 6 例、`rxTagScanHtml` 5 态**逐字节**、设定页静态片段（标题 / 两个按钮原文 / 说明 / 未分析占位 / 两节文本域与说明）。
  - 动作类走**真实点击委托**（`F.openPanel()` 后在 `panel.listeners.click` 上派发伪事件 → V1 `handleAction` 真实执行）：切页 → 切设定子页 → 9 步动作（含 no-text 告警），逐步记录名单 / toast / 结果区关键片段。
- `tests/fixtures/v1-golden-cur-track.json`（生成器 `tests/fixtures/gen-v1-golden-cur-track.cjs`）
  - `meta.v1SourceSnips`：四个动作 case / `currenciesHtml` 的 head 与 picker 段 / `trackPickState` / `knownCharacterNames` / 名单增删 / 标定段与账本段 / 导出清单片段。
  - 纯函数：`knownCharacterNames`（4 条档案含重名 → 3 名 + 排序）、名单增删清空与 `isTrackedCurrencyOwner` **19 步**（含简称包含与 §3.8 的不一致）、`trackPickState`/`setTrackPick` 6 步、标定段与账本的「标定前 / 标定后」两组。
  - 动作类走**真实点击委托**（货币页 HTML 取自 `panel.innerHTML`，V1 `currenciesHtml()` 未导出）：11 步动作序（开关 / 标定 / 取消 / 空名 / 关闭 / 清空 ×2 / 标定后切页返回）逐步记录名单 / 开关 / toast / **页面投影**；另有空档案、搜索无匹配、搜索命中三态。

### 4.2 单元测试

- `tests/unit/feed-scan-golden.test.js` **17 项 / 0 失败**：
  R1 样本与源码证据、R2 `latestAiFloorInfo` 四态、R3 `rxNormTag` 21 例、R4 `rxDedupeTagList` 6 例、
  R5 `rxPushFeedTag` 9 步、R6 `rxAnalyzeLatestText` 6 例、R7 `rxTagScanHtml` 5 态**逐字节**、R8 设定节静态片段**逐字节**、
  R9 动作序 9 步、R10 无正文告警；
  V1 投喂页接线、V2 面板扫描与渲染、V3 收录落库与高亮、V4 清空与跨重渲染保留、V5 文本域 change 整表排重、V6 宿主楼层接线、V7 常量与未知动作。
- `tests/unit/cur-track-golden.test.js` **13 项 / 0 失败**：
  R1 样本与源码证据、R2 `knownCharacterNames`、R3 名单 19 步、R4 开关 6 步、R5 提示词段与账本、
  R6 货币页三态投影、R7 动作序 12 步（含合成步）、R8 空档案 / 无匹配 / 命中三态；
  V1 货币页接线与按钮 title 逐字、V2 端到端（标定 → 胶囊 → 提示词 → 清空）、V3 空名与 §3.8 怪癖、
  V4 `curTrackClose` 等价性与跨切页保留、V5 名单归一与默认归属。

### 4.3 冒烟 `tests/smoke-test.js` **AG1–AG3**

- AG1：19 个 `FTT.*` 入口齐备 + 归一 / 整表排重 + `rxPushFeedTag` 五态（收录 / 重复 / 另一侧 / 空 n=0）+ 最新 AI 楼层扫描（成对标签 + 行内标记，**楼层号按真实压入结果定位**）+ 标定名单增删清空与选择器开关；
- AG2：投喂页（扫描节 + 两个按钮 + 两个真实键文本域 + 未分析占位）→ `rxScanTags` / `rxAddTag` 白黑与大小写重复的 note 逐字 → 文本域即时回显 + 结果区高亮；货币页（未标定态 → `curTrackPick` → 选择器标题 / 搜索框 / 关闭 / 行内 `data-name` → `curTrackToggle` → 胶囊 + 角标 + 清空按钮）；提示一律读 `r.state.note`；
- AG3：`rxScanClear` 无提示且回到占位、无正文时 `rxScanTags` 如实警示（`last=-1`）、`curTrackClose` 关闭选择器、空名不标定、`curTrackClear` 逐次回报条数。

### 4.4 门禁（`npm run gate`）

```text
内核纯净度检查：扫描 48 个文件（core/）
✅ 内核纯净度通过（0 违规）
✅ 标识符门禁通过（0 未定义标识符）
词条门禁检查：2 种语言 · 54 条
✅ 词条门禁通过（键集一致 · JS 镜像与 JSON 同步）
版本一致性检查：
✅ 版本一致性通过（2.30.0）
文档规范检查：43 个文件
✅ 文档规范通过（0 违规）
===== 单元测试汇总：57/57 个文件通过, 0 失败；断言 904 项 =====
========== V2 冒烟：127 通过, 0 失败 ==========
```

## 5. 未实现项 / 遗留

1. **V1 设定页「投喂世界书」节未实现**（V1 25528–25530：`<div data-ftt-wb-list>` 与 `renderWorldbookSettings()` 的世界书勾选/条目树）。该节属设定页**世界书投喂**能力，与本批（标签扫描/收录）无耦合；V2 侧 `cfg.feedWorldbooks` / `feedWorldbookEntries` 键存在但无界面与投喂读取，**按「不使用假实现」原则不放假控件**，留给后续批次（需先落 `renderWorldbookSettings` 等价内核）。
2. **V1 选择器筛选条的下拉组（字段/排序/额外条件/模式）不复刻**（§2.4）；V2 选择器只有角色名搜索。
3. **面板 toast 通道不同**：V2 面板统一用 `state.note`（V1 用 toastr，且无 toast 队列）；文案逐字对齐，呈现通道与「粘性」（上一次提示会保留到下一次写 note）不同。
4. **真实浏览器端到端未跑**：本批验证走宿主机桩（`tests/harness/st-mock.js`）+ 真实 V1 oracle 比对；文本域 `change` 委托用桩 DOM 的监听器直接驱动（`openPanel()` 后显式 `bindOverlay()`，因为桩 DOM 预注册了 `#ftt-panel` 使 `ensureOverlay` 走「已存在」早退分支），**真实浏览器点击未自动化**。
5. **`rxTagScanHtml` 的 `ftt-scan-chip` / `ftt-chip-btn--on-w/-b` 样式**：沿用 V1 同名类（`style.css` 已逐字并入 V1 段），本批未新增样式；未做视觉回归。
6. **`R1` 的 oracle 生成器路径**：两份生成器已入库 `tests/fixtures/*.cjs`（非 `.test.js`，单元运行器不加载；文件内注释写明用法），
   其余历史批次（B9-a/B9-b 等）的生成器仍在 `/tmp`，本批不改动历史。
7. 本批未发版、未提交（按批次纪律：不 commit / tag / push），由队长决定提交与发版时点。
