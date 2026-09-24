# P9d · 独立分组抽取（`dimensionGrouping === 'separate'`）与被动调度接线

> 文档版本：v1.0 ｜ 日期：2026-09-25 ｜ 状态：生效（v2.32.0 之后待发版）
> 关联：`host/extract.js`（新增 `runSummarySeparate` / `summaryDimGroups` / `separateGroupingEnabled` / `V1_SUMMARY_DIM_KEYS`）、
> `core/parallel.js#jsExtractKeywords`（逐字移植）、`ui/settings-pages.js#analyzePageHtml`、`ui/settings-pages.js#applySettingsControl`（代理键）、
> `index.js` / `devtools.js`（4 项 `FTT.*`）、`tests/fixtures/gen-v1-golden-separate-dim.cjs` + `tests/fixtures/v1-golden-separate-dim.json`、
> `tests/unit/separate-dim-golden.test.js`、`tests/smoke-test.js`（AI1–AI3）、`docs/P8-功能对齐总表.md`、`docs/P8x-B8-7平行推演与转正.md`、`docs/P8w-B8-7情节总结与分段总结.md`

---

## 1. 覆盖范围（V1 v1.206 `runSummarySeparate` ~14785、分段分支 ~15477、`scheduleParallelWeave` ~13018、`jsExtractKeywords` ~11213）

| V1 能力 | V2 落点 | 语义（V1 原样） |
| --- | --- | --- |
| 独立分组开关 | `host/extract.js#separateGroupingEnabled` + `analyzeSegment` 分支 | `cfg.dimensionGrouping === 'separate'` 时按维度分组；默认 `'unified'`（V1 1432）。**事实核验**：V1 全仓 `dimensionGrouping` 仅 4 处 —— 默认值（1432）、分段路径分支（15477）、设定页代理键（25548 渲染 / 26693 保存）；**单楼分析 `runSummaryFloor` 与其它路径都没有该分支**（V2 同口径：只有 `analyzeSegment` 接入） |
| 分组构造 | 同上 `summaryDimGroups` | 生效维度**各自一组**（V1 `DIMENSIONS.filter(d => cfg.dimensionEnabled[d])`）+ 未启用维度**合成一个「统一」组**（V1 `DIMENSIONS.filter(d => !cfg.dimensionEnabled[d])`）。V1 的 `DIMENSIONS`（1135）为 10 个字符串键：`atoms/states/snapshots/memories/items/plans/scenes/concepts/currencies/rumors` —— **不含** `suspense`（悬念随 `plans` 组共用「计划库与悬念库」模板）、**不含** `parallels`（平行事件由交织管线产出） |
| 每组提示词 | 同上（复用 `core/prompt.js#buildSummaryPrompt`） | 每组调用一次 `buildSummaryPrompt(floorText, [dim])`；「统一」组用未启用维度子集。**逐字符**与 V1 真实请求体一致（黄金样本 `run1.groups[].messages`） |
| 并行请求 | 同上 `runSummarySeparate` | `Promise.all` 并行发起；每组独立解析 → 取该组切片 → `mergeDelta(sub, floorRange)`；单组失败**只影响自己**（不抛出、不影响其它组） |
| 逐组切片 | `host/extract.js#groupDeltaSlice` | `plans` 组一并带 `suspense`（`sub.plans = delta.plans; sub.suspense = delta.suspense`），其余 `sub[dim] = delta[dim]`；该组键全 `undefined` → 「无该维度数据」。**切片发生在 `mergeDelta` 的键归一之前** → AI 必须回英文维度键（见 §4 怪癖 ③） |
| 逐组计数 | 同上返回值 | 成功 = `mergeDelta` 的**返回对象**（真值），失败 = `false` / `{ok:false,error}`；段级汇总 = `结果.filter(r => r.ok)` |
| 合并成功 → 被动推演 | 同上（`scheduleParallelWeave(floorRange, jsExtractKeywords(floorText))`） | 每个成功组各调用一次（V1 14806 / 14829） |
| 关键词抽取 | `core/parallel.js#jsExtractKeywords`（**逐字移植**） | 零 AI / 零向量：特征词（情节标签·关键词 / 记忆 / 概念 / 角色名 / 场景名 / 计划正文前 8 字 / 状态主体 / 平行事件标签·关键词）必须**原样出现在正文**且长度 ≥ 2；按来源顺序去重；上限 10 |
| 单楼分析被动调度 | `host/extract.js#analyzeFloor` | 合并成功 → `scheduleParallelWeave({start:fid,end:fid}, jsExtractKeywords(text))`（V1 15240）；紧随其后**无条件** `scheduleAtomCompact()`（V1 15242） |
| 分段分析被动调度 | `host/extract.js#analyzeSegment`（统一路径） | 合并成功 → `scheduleParallelWeave({start,end}, jsExtractKeywords(text))`（V1 15490） |
| 批量收尾被动调度 | `host/extract.js#runAutoSummary` 的 `finally` | `scheduleAtomCompact()`（V1 15537；4s 防抖、体量未达标内部跳过） |
| 设定页开关 | `ui/settings-pages.js#analyzePageHtml` + `applySettingsControl` | V1「维度分组（总开关）」节（25546~25552）：`<label>独立分组</label>` + `data-ftt-cfg="dimensionSeparate"`；保存分支（26693）把勾选态写回真键 `cfg.dimensionGrouping`（`'separate'`/`'unified'`） |
| `FTT.*` | `index.js` + `devtools.js` | `jsExtractKeywords` / `runSummarySeparate` / `summaryDimGroups` / `separateGroupingEnabled`（4 项；devtools 侧全部 `hooks && typeof === 'function'` 守卫） |

## 2. 宿主可行性取证：`cfg.dimensionPresets` 在 V2 **不适用**（不实现、不放假控件）

**V1 的机制**（`runSummarySeparate` 14793~14796）：

```js
const presetName = (cfg.dimensionPresets && cfg.dimensionPresets[dim]) || '';
const override = presetName ? { preset: presetName } : overrideMain;
const resp = await callChatCompletion(prompt, override, `摘要[${DIM_LABELS[dim]}]`, 'analysis');
```

`override.preset` 只被 `resolveApiFor(override)`（V1 2445~2460）使用：命中 `cfg.apiPresets[preset]` 时改用**该自建连接的 url/key/model**，否则回落主配置。黄金样本已固化该行为：`states` 维指定「预设甲」→ 该组请求打到 `https://preset-a.example/v1/chat/completions` 且 `model = model-A`，其余组走主配置 `https://main.example/v1` + `model-main`。

**V2 的通道**（逐层取证）：

1. `host/extract.js` 的 AI 调用是**注入点** `gen = o.ai || rawGenerate`（`host/generation.js#rawGenerate`），签名只有 `{ systemPrompt, prompt, prefill, jsonSchema }`；
2. `host/generation.js#rawGenerate` 构造的 payload 也只含这 4 个键，随后 `await ctx.generateRaw(payload)`；
3. 宿主能力真值（本机 SillyTavern 源码 `public/script.js`）：
   - `export async function generateRaw({ prompt = '', api = null, instructOverride = false, quietToLoud = false, systemPrompt = '', responseLength = null, trimNames = true, prefill = '', jsonSchema = null } = {})`（4109）
   - `export async function generateRawData({ … 同上 … })`（3987）
   —— **没有任何 preset / 连接配置参数**（唯一的渠道类参数 `api` 是「文本补全 / 对话补全」的 API 类型标识，不是自建连接预设）；
4. `host/st-api.js#probeCapabilities` 也只探测 `generateRaw` / `generateQuietPrompt` / `ConnectionManagerRequestService`（连接管理器服务面向 Connection Profile，与 V1 的 `cfg.apiPresets` 不是一回事，且 V1 语义是「按维度换自建 url/key/model」，V2 无自建通道）。

**结论（如实判定）**：

- **实现**「按维度独立分组 + 并行请求」；
- **不实现**「按维度选预设」；
- `cfg.dimensionPresets` 与 `cfg.apiPresets` / `activeApiPreset` 在 V2 一律**标注为「V2 不适用（宿主通道不支持按次指定预设，避免放假控件）」**（与 `docs/P8-功能对齐总表.md` §6.1 既有登记同口径）；
- 设定页**只加「独立分组」开关**，**不加**任何预设下拉（单测/冒烟均断言「无 `data-ftt-dim-preset` / 无 `dimensionPresets` 控件」）；
- 黄金样本仍完整保留 V1 的 `dimensionPresets` 参与方式（`run1.groups[1].url/model`），用于**记录事实**而非要求 V2 复现。

## 3. 与 V1 的差异（逐条明示）

1. **AI 通道**：V1 自建 `callChatCompletion`（可带 `preset` / `apiType` / `apiUrl` / `apiKey` / `model` 覆盖 + 采样参数）；V2 统一走注入钩子（`o.ai` 注入点 / 宿主 `generateRaw`），因此 §2 的按维度预设**不适用**。调用标签与 V1 同源，作为生成函数的第二参数透传（`gen(args, '摘要[状态]')`；宿主 `rawGenerate` 忽略它）——用于测试与排障定位「哪一组」，不改变请求体。
2. **失败文案**：V1 的失败原因来自自建通道（例：`摘要 API 500: boom` / fetch 异常原文）；V2 来自注入通道（`{ok:false,error}` / 抛错原文）。故单测只比对「哪几组失败 + 失败原因非空」，不比对通道文案（fixture 里保存的是 V1 原文）。
3. **「生效维度」的判据**：V1 `runSummarySeparate` 用 `cfg.dimensionEnabled[d]` **真值**判定，且 V1 迁移器会给每个维度补 `false`（V1 2392）→ **V1 默认配置在独立分组下等价于「单个统一请求」**。V2 沿用既有 `enabledDims()`（`map[kind] !== false`，**空表 = 全部启用**）→ V2 默认（`dimensionEnabled = {}`）在独立分组下是 **10 组并行**。要复现 V1 默认，需把各维度显式置 `false`。该差异是「沿用 V2 既有维度语义」的**有意选择**（否则面板显示「全部启用」而分组按「全部未启用」处理，自相矛盾），已由 `G1`/`V1` 断言固化。
4. **维度键映射**：V2 `core/constants.js#DIMENSIONS` 是 14 个 `{kind,part,label}` 容器（含 V1 没有的 `currentStates` / `links` / `plotSegments` / `suspense` / `parallels`）。分组前投影到 V1 摘要维度键：`currentStates → states`（别名，`KIND_MAP` 同源），`links` / `plotSegments` / `parallels` / `suspense` **不参与分组**（V1 `DIMENSIONS` 不含它们；`suspense` 随 `plans` 组）。本批**不改** `core/constants.js`，映射表落在 `host/extract.js`。
5. **`o.dims` 覆盖**：V1 `runSummarySeparate` 无维度入参；V2 保留既有「`o.dims` 显式给出即只用该子集」约定（`summaryDimGroups(dimsOverride)`）。
6. **中断与管线状态**：V1 的 `newTaskStart` / `abortTick` / `pipeStart` / `pipeUpdate` / `renderPanel` 未移植（V2 无任务中断标志与管线状态 UI）；并行分组因此没有「中断后不再发起该维度请求」这一步（V2 的协作式中断只在段与段之间生效，与既有一致）。
7. **段级汇总口径**：V1 分段分支按**组**计成败（`made += okN; failCount += results.length - okN; totalCount = totalCount || results.length`）；V2 `analyzeSegment` 返回组明细（`groups/groupOk/groupFailed/groupResults`），`runAutoSummary` 仍按**段**计成败（段的成败 = 「至少一组成功」）。V1 通知里的「N/M 段成功」与 `totalCount` 在独立分组下本就口径混乱（组数当段数用），V2 不照搬该计数，但把**原始组明细**完整返回以便核对。
8. **`scheduleAtomCompact` 的排程点**：与 V1 逐点对应（单楼 15242 / 批量收尾 15537），**分段路径本身不排**（V1 亦不排，见黄金样本 `run3/run5.weaveTimers` 与冒烟 AI2 的 `4000ms = 0` 断言）。
9. **保存/落盘链路**：V1 的 `scheduleAtomCompact` 调用点**不在**存储保存函数里，而在上述两个提取检查点；本批据实接在 `host/extract.js`（未改动 `adapters/store.js`）。`scheduleParallelWeave` 同理（V1 四处调用点全在提取管线内）。
10. **`cfg.dimensionPresets` 的默认值与迁移**：V2 `core/config.js` 早已有该键（`{}`，与 V1 1434 同默认值），故**未新增配置键**；`core/migrate.js` **未改**（V1 的「逐维补空串 + `dimensionApis → dimensionPresets` 迁移」在 V2 无任何读取方，补上即为死代码 —— 保守不动；原始 `dimensionApis` 由 V1 数据导入器按需处理，不在本批范围）。
11. **`state.weaveLastFloor` 的写入顺序**：V2 与 V1 完全一致（先写 `weaveLastFloor` 再判签名去重），故「去重跳过时楼层已计数」的既有怪癖不变（`docs/P8x` 已登记）。

## 4. V1 原生缺陷 / 怪癖（**原样保留**，黄金样本与单测固化）

1. **`results[].ok` 是 `mergeDelta` 的返回对象而非布尔**：合并成功时 `ok = {ok:true,added,total}`（真值），仅异常/非对象增量时为 `false`。故 `if (ok) scheduleParallelWeave(...)` 判的是「对象非空」——语义上等价于「未抛异常」，V2 原样保留（`G3` 固化 `rawOkType`）。
2. **未启用的维度仍会被请求**：它们被并成一个「统一」组照常发 AI（V1 注释即「未开启的维度跟随主配置统一请求」）。不是遗漏，是设计。
3. **切片先于键归一 → 中文键响应判「无该维度数据」**：V1 在 `mergeDelta`（内部才 `normalizeDeltaKeys`）**之前**按原始键取 `delta[dim]`，故 AI 若回 `{"情节":…}` / `{"状态记录":…}` 之类中文键，「统一/单维」全部判无数据、零落库、零排程。黄金样本 `run5` 固化（4/4 组 `无该维度数据`）；V2 逐字同构（`G6`）。
4. **独立分组不累加 `totalAdded`**：V1 分段分支只累加 `made`/`failCount`，`totalAdded` 恒为 0 → 完成通知里「本次提取 0 条」。V2 `analyzeSegment` 的独立分组分支据此返回 `added: 0`（原样保留，`V1`/冒烟 AI2 断言）。
5. **形参 `silent` 在 V1 函数体内从未被引用**：`runSummarySeparate(floorText, floorRange, silent)` 的 `silent` 只出现在签名里（黄金样本 `runSummarySeparateSilentUnused = true`；V2 直接不设该参数）。
6. **`scheduleParallelWeave` 的「已在调度中」静默丢弃后到请求**：独立分组下 N 个成功组各调用一次，但模块级 `weaveTimer` 只允许第一次建定时器（`G3`/`W5`/冒烟 AI2：3 组成功 → 仍只有 1 个 1.8s 定时器）。既有怪癖，`docs/P8x` 已登记。
7. **间隔闸门对每个成功组各记一次日志**：`!weavePassiveDue` 时每组各写一条「平行事件间隔未到」调试日志（黄金样本 `run3.intervalSkipLogs = 4`），定时器 0 个。

## 5. 验证（v2.32.0 之后 · 本批）

| 项 | 内容 |
| --- | --- |
| oracle fixture | `tests/fixtures/v1-golden-separate-dim.json`（真实 V1 v1.206 直调；`run1` 分组/提示词/预设参与、`run2` 三种失败互不影响、`run3` 间隔未到、`run4` 驱动定时器观测关键词与楼层、`run5` 中文键怪癖；连跑两次逐字节一致） |
| 生成器 | `tests/fixtures/gen-v1-golden-separate-dim.cjs`（日志走 stderr、stdout 只输出 JSON、结尾 `process.exit(0)`） |
| 单测 | `tests/unit/separate-dim-golden.test.js`（**17 项**：G1–G6 V1 逐项比对 + V1–V3 V2 编排 + W1–W6 被动调度接线 + U1 设定页开关 + F1 `FTT.*` 入口；计时器全部由注入钩子驱动） |
| 冒烟 | `tests/smoke-test.js` **AI1–AI3**（3 项；`await assert(...)` 写法 + 注入定时器驱动，`// ---------- AI 独立分组抽取 + 被动调度接线 ----------`） |
| 全量门禁 | `npm run gate`（单元 **60 文件 / 951 断言**、冒烟 **133 项**，全绿） |

**冒烟隔离说明**：提取合并成功会自动排程 1.8s 被动推演，若在 H 段之后仍开启，该定时器会在无关小节里发起 AI 请求并污染各节的调用计数 —— 故 H 段入口显式 `rt.cfg.parallelWeaveEnabled = false`（小节内注释），该接线仅由 AI2/AI3 用**注入定时器**显式驱动验证。

## 6. 未实现 / 未验证

1. **按维度选预设**（`cfg.dimensionPresets`）：V2 不适用（§2），未实现亦不设控件。
2. **`abortTick` 级别的并行分组中断**：V2 无任务中断标志，未验证「并发组请求中途中断」。
3. **真实宿主端到端**：未在真实 SillyTavern 里跑「开关 → 分段抽取 → 多组并行请求」的完整链路（单测/冒烟均为宿主桩 + 注入定时器）。
4. **`silent` 语义**：V1 该形参未被使用，V2 未设，故不存在对应行为差异需要验证。
5. **V1 通知文案**：独立分组下 V1 的完成通知（`分段分析完成：X/Y 段成功`）在 V2 由面板批量汇总承担，未逐字复刻（V2 无 V1 的 `notify('analysis'/'success')` 进度弹窗体系）。
