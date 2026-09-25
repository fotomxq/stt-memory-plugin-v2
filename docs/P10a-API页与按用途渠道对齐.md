# P10a · API 页与按用途渠道对齐（B10-a / v2.35.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.35.0）
> 触发：用户报告「**API 功能怎么没了？请核对 V1 版本对齐相关设定功能。**」
> 涉及：`core/api-channel.js`（新）· `host/api-channel.js`（新）· `host/generation.js` · `host/extract.js` · `ui/api-page.js`（新）· `ui/settings-pages.js` · `ui/panel.js` · `index.js` · `devtools.js` · `tests/harness/st-mock.js` · `tests/smoke-test.js`

---

## 1. 结论先说：用户的判断是对的

`docs/P8-功能对齐总表.md` §6.1 曾把 V1 的 API 一族（`presetSave/presetLoad/presetDelete`、`apiTest`、`apiModels`、
`apiTemperature/apiMaxTokens/apiTopP`、按用途预设、`dimensionPresets`）整批判为「**V2 不适用**」，理由是
「V2 统一走酒馆 `generateRaw`，宿主签名里没有 preset/连接参数」（本机 ST `public/script.js:4109` 属实）。

**该判定错在结论而非取证**：`generateRaw` 确实没有这些形参，但酒馆**向扩展暴露了另一条官方通道** ——

| 宿主能力 | 位置（本机 ST 检出 `/var/service/SillyTavern`） | 说明 |
| --- | --- | --- |
| `ConnectionManagerRequestService` | `public/scripts/st-context.js:292`（`getContext()` 暴露） | 官方扩展通道 API |
| `sendRequest(profileId, prompt, maxTokens, custom, overridePayload)` | `public/scripts/extensions/shared.js:419` | 按**连接配置**发送；`overridePayload` 展开进请求体 → 可覆盖 `temperature`/`top_p`/`max_tokens`/`model` |
| `getSupportedProfiles()` | `shared.js:525` | 列出可用连接配置（含 api/model/preset） |
| `ChatCompletionService.processRequest` | `public/scripts/custom-request.js:421/544`；`createRequestData` :428 | 更底层的请求构造 |
| `TempResponseLength.save(api, responseLength)` | `public/script.js:4009` / `4140` / `4153` | `generateRawData` 用 `responseLength` **临时改写** `oai_settings.openai_max_tokens` → `host` 通道**真的能**控制 `max_tokens` |

因此 V2 **可以**（也确实应该）恢复 V1 的 API 设定能力。本批把「不适用」改为**三通道实现**，并把
仍不可实现的部分（属**向量检索层**的 kw/mem/embedding/rerank 配置）如实登记为**未实现且不给控件**。

## 2. V1 API 设定逐项盘点（v1.206 取证）

| V1 项 | 位置 | 消费者 | V2 处置 |
| --- | --- | --- | --- |
| 「API 分组（预设管理）」= 分组名 + 💾 保存 / 📂 加载 / 🗑 删除 + 已存分组下拉 | 25530~25541；动作 27373~27407 | 主 API 与「提取记忆」共用 | **已实现**（`ui/api-page.js` 同结构；动作同名） |
| `apiBlockHtml`：API 类型（自定义 / 代理预设）、API 地址、API Key、模型、代理预设名、**选择模型**下拉、`temperature`/`max_tokens`/`top_p`、🧪 测试、📦 获取模型 | 24539~24561 | 主渠道 + Embedding/Rerank | **已实现**（形态换成三通道；参数三项保留同键同标签同 placeholder） |
| `testApi(override, kind)` | 2477 | 同上 | **已实现**（`host/api-channel.js#probeTarget`；端点拼接 / `Bearer` / `ping`+`max_tokens:1` / 报错文案逐字） |
| `fetchModels(override)` | 2509 | 同上 | **已实现**（`fetchModels`；端点 / `data`·`models` 两形态 / 空列表报错逐字） |
| 采样参数 `apiTemperature`(0.2) / `apiMaxTokens` / `apiTopP` | 1312~1314；请求体 2625~2627 | 所有自建连接调用 | **已实现**：`profile`/`direct` 通道直传；`host` 通道 `max_tokens` 经 `responseLength`，`temperature`/`top_p` **无法覆盖**（如实标注） |
| 主渠道 + 当前激活分组 `activeApiPreset` | 14789（`overrideMain`） | 摘要 / 各类修复 / NSFW / 时钟 | **已实现**：抽取管线主路径与所有 `aiCallText` 调用按标签解析 → `host/extract.js` 传 `purpose:'main'` |
| 各维度分组 `dimensionPresets[维度]` | 14795~14796 | 「独立分组」下每个维度的摘要请求 | **已实现**：`ui/api-page.js` 逐维度下拉 + `host/extract.js#runSeparateGroup` 传 `{purpose:'dim',dimension}` |
| 平行渠道 `parallelApiPreset` | 25816；消费者 13124 / 13941 | 交织推演 + 推进分析 | **已实现**（`purpose:'parallel'`，由标签 `[平行事件·…]`/`平行事件推进` 自动判定） |
| 「关键词提取」分组 `kwApiPreset` / `kwApiEnabled` + `kwApi` | 1497~1498；消费者 12575 | **向量检索层**的 AI 关键词提取 | **未实现**（见 §5）：内核解析已就位，UI **不给控件** |
| 「记忆分析发送」分组 `memApiPreset` / `memApiEnabled` + `memApi` | 1499~1500；消费者 12596 | **向量检索层**的记忆筛选发送 | **未实现**（同上） |
| Embedding / Rerank API（地址/Key/模型/代理预设） | 25643 / 25646 | `cfg.useVector` 的三层结构 | **未实现**（同上）；`probeTarget` 已按 V1 语义预留 `embedding`/`rerank` 两种 kind |
| 「代理预设」（`apiType === 'preset'` + `proxyPreset`） | 2453~2457 | 从酒馆**代理预设**取 url/key/model | **迁移为 `host` 通道**（V2 不能凭预设名复现酒馆代理；不放假控件） |

## 3. V2 实现：三通道

```text
通道（cfg.apiChannel）
├─ host    —— 跟随酒馆当前连接（默认；走 ctx.generateRaw，与 v2.34.0 行为逐字节一致）
├─ profile —— 酒馆「连接配置」（Connection Manager profile）：经 ConnectionManagerRequestService.sendRequest
│             · 鉴权/地址/模型/预设由酒馆管理；插件按次覆盖 temperature / top_p / max_tokens
└─ direct  —— 自建连接（V1 等价物）：插件自己 fetch(`${apiUrl}/chat/completions`)
              · Authorization: Bearer <apiKey>；temperature / top_p / max_tokens 全部直传
              · 浏览器直连 → 受目标服务 CORS 限制，失败时如实回报并提示改用 profile 通道
```

**旧数据迁移**（`core/api-channel.js#mainApiChannel` / `presetChannel`）：
`cfg.apiChannel` 未设置时 —— `apiType==='preset'` → `host`；否则「已填地址 + 模型」→ `direct`；其余 → `host`。
（`host` 即 V2 既有行为，故**未配置过的用户升级后行为完全不变**。）

**参数生效矩阵**（实测口径，UI 已逐行标注）：

| 参数 | `host` | `profile` | `direct` |
| --- | --- | --- | --- |
| `max_tokens` | ✅ 经宿主 `responseLength`（`public/script.js:4009`） | ✅ `sendRequest` 形参 | ✅ 请求体 |
| `temperature` | ❌ 宿主 `generateRaw` 无该形参（`public/script.js:4109`） | ✅ `overridePayload` | ✅ 请求体 |
| `top_p` | ❌ 同上 | ✅ `overridePayload` | ✅ 请求体 |

**用途解析优先级**（`resolveApiTarget`，逐条对齐 V1）：
显式 `override.preset` → 该用途分组（`dimensionPresets[dim]` / `parallelApiPreset` / `kwApiPreset` / `memApiPreset`）
→ 该用途内联独立配置（仅 `kwApi`/`memApi`）→ 当前激活分组 `activeApiPreset` → 主配置。
**采样参数始终取主配置** —— 与 V1 一致（V1 的分组条目只有 `apiType/apiUrl/apiKey/model/proxyPreset`，不含参数）。

## 4. 与 V1 的差异（逐条登记，非缺陷）

1. **形态**：V1 的「API 设定」是自建直连的字段组；V2 先给「通道」下拉，再给该通道需要的字段
   （`profile` 用连接配置下拉；`direct` 用地址/Key/模型）。V1 的「代理预设名」文本框**不再出现**（见 §2 末行）。
2. **写回时机**：V1 的 API 块字段由「💾 保存设置」（`savecfg` → `settingsApplyAll`）批量落盘；V2 控件即时写回并落盘
   （与 §6.1 对 `savecfg` 的既有判定一致）。因此 V1 `collectApiBlock`「从 DOM 收集 API 块」在 V2 = 直接读 cfg。
3. **「选择模型」下拉**：V1 是把选中值回填到**模型输入框的 DOM**（26224，等保存设置才落盘）；V2 即时写回 `cfg.model`。
4. **结果呈现**：V1 的 `apiTest` 直接改 `#ftt-api-result-<pfx>` 的 `textContent`、`apiModels` 直接改 `<select>` 的
   `innerHTML`；V2 用**模块态 + 渲染**呈现（同一位置、同一文案：`✅ 可用（Nms）` / `❌ …` / `✅ 获取到 N 个模型`）。
5. **「分组名」「已存分组」不落配置**：与 V1 **一致**（V1 26280 / 26692 显式跳过这两个键）；V2 额外保证这两项
   变更**不触发重绘**（否则会清空用户正在输入的分组名）。
6. **直连超时**：V1 无超时（仅用户手动中断）；V2 加 120s 兜底（`DIRECT_TIMEOUT_MS`），避免界面挂死。
7. **无障碍降级**：`ConnectionManagerRequestService` 缺失（酒馆「连接管理」扩展被禁用/版本过旧）时不报错崩溃，
   下拉显示「（读取失败：…）」并保留手填通道；`fetch` 缺失时 `direct` 通道如实报「当前环境没有 fetch」。
8. **V1 缺陷 #3（本批修正，非"保留怪癖"）**：V1 `settingsApplyAll` 的收尾分支是
   `else if (!key.startsWith('api')) cfg[key] = el.value;`（v1.206 **26746**），把 `apiTemperature` / `apiMaxTokens` /
   `apiTopP` 这三个**唯一的 `api` 前缀文本控件**一并排除 → **V1 的三个参数输入框永远写不进 cfg**，
   请求里恒用默认 `0.2 / 不限 / 1`（黄金样本 `quirks.q23` 有实测证据：DOM 设 `0.9`/`123` 后 `cfg` 仍为 `0.2`/`''`）。
   V2 的参数控件走通用即时写回 → **真实生效**；本批在黄金样本单测里**显式断言该差异**（P1 的 `savecfg` 改判分支）。
9. **V1 缺陷 #4（本批不复制）**：V1 在「API」子页点「💾 保存设置」会顺带把**不在本页**的控件按默认处理 ——
   分组策略读到 null 走 `follow`（`cfg.kwApiEnabled/memApiEnabled` 被清为 `false`）并清空 `cfg.feedWorldbooks`
   （`quirks.q18`）。V2 无 `savecfg`（控件即时写回），故该连带副作用**不存在**。
10. **直连请求体**：V1 `callChatCompletion` 的真实请求体含 `stream:false`（黄金样本 `resolve.overrides.cases[].requests[].body`）；
    V2 `direct` 通道**逐字带上**（避免个别服务默认开启流式导致解析失败）。
11. **kw/mem 内联块**：V1 `resolveKwApiOverride`/`resolveMemApiOverride` 的 Enabled 分支直接返回内联
    `apiUrl/apiKey/model`，缺地址时 `callChatCompletion` **抛错**（不回落主配置）。V2 内核 `targetFromInline`
    对应返回 `channel:'direct'`（不回落 `host`）→ 宿主如实报「未配置 API 地址」，失败口径一致。
    注：该用途属向量层（§5），V2 暂未接线，逻辑已就位并已被黄金样本 R3 的 15 例（含 1 例缺地址）覆盖。

## 5. 未实现项（**不给控件**，避免假控件）

V1 的 `kwApi`（关键词提取）/ `memApi`（记忆分析发送）/ Embedding / Rerank 四组配置**只服务于向量检索层**
（`cfg.useVector` 的三层结构：① 向量检索 → ② 浏览器 JS 抽取 → ③ AI 分析）。该层在 V2 **整体尚未实现**
（全仓 `grep -rn "useVector" core/ host/ ui/ index.js` 仅命中 `core/config.js` 的默认值），因此：

- 本批**不渲染**这四组控件（控件没有消费者 = 假控件，违反既有纪律）；
- 内核解析逻辑**已就位**（`resolveApiTarget` 支持 `purpose:'kw'|'mem'` 与 `kwApi`/`memApi` 内联配置），
  `host/api-channel.js#probeTarget` 也保留了 `embedding`/`rerank` 两种 kind 的 V1 语义；
- 向量层批次落地后**无需再改本批文件**，只需在 UI 加控件并接线。

### 5.1 与 V1 直调的「调用点 vs 裸函数」口径（重要）

V1 的 `resolveApiFor(override)` **本身不读 `cfg.activeApiPreset`**（怪癖 q02；黄金样本
`resolve.apiFor.cases[no-override-reads-activeApiPreset]` 实测返回主配置）。真正让「当前激活分组」生效的是
**调用点**：`overrideMain = { preset: cfg.activeApiPreset || undefined, apiType, apiUrl, apiKey, model, proxyPreset }`
（v1.206 **14789**）。

V2 的 `resolveApiTarget` 把这两层**合并**（`activeApiPreset` 作为第 ④ 步），等价于 V1 的调用点口径。
黄金样本单测 R1 因此对 22 例做**双层判定**：可复现的 17 例按调用点口径逐例比对，并单独断言
`callsiteDiff === 1`（即 q02 那一例：V1 裸调返回主配置、V2 返回激活分组）。

其余 6 例为 N/A（样本单测里显式跳过并计数）：
内联 override 形态 4 例（V1 的 `{apiUrl,apiKey,model}` / `{model}` 覆盖只可能来自 kw/mem 内联块或调试用途，
V2 无该调用形态）· 代理预设查表 2 例（§4 末、R2 已断言「不伪造」）。

> 登记位置：`docs/P8-功能对齐总表.md` §6.3（新增）。

## 6. 验证

- `npm run gate` 全绿：单元 **61 文件 / 967 断言**（新增 `tests/unit/api-channel-golden.test.js` **16 项**）、
  冒烟 **139 项**（新增 **AK1–AK3**）、内核纯净度 0、内核标识符 0、词条 54、版本一致、文档 0 违规。
- 冒烟 AK 覆盖：
  - **AK1** API 子页真实渲染（V1 同款分节/文案/标记齐全）+ 分组三动作端到端（保存 → 加载 → 删除 → 空名拒绝 → 重复删除拒绝）；
  - **AK2** 用途渠道真实生效（`parallelApiPreset` / `dimensionPresets` 解析；维度下拉与模型下拉的**真实 change 委托**写入）；
  - **AK3** 三通道端到端（`direct`：端点拼接 `/chat/completions`、`Authorization: Bearer`、请求体三参数；
    `probeTarget` 成功/未配地址/未配模型/HTTP 500 四种文案；`fetchModels` 解析与 `HTTP 500` 文案；
    `profile`：`sendRequest` 的 id/messages/maxTokens/`overridePayload` 实收；`host`：`generateRaw` 实收
    `responseLength` 且**不含** temperature）。
- V1 oracle：`tests/fixtures/v1-golden-api.json`（**257,359 B**，真实 V1 v1.206；生成器入库
  `tests/fixtures/gen-v1-golden-api.cjs` 1,058 行，**队长独立复跑两次 → `cmp` 逐字节一致**，md5
  `13fcb2228c7798ebc1c241d0a231fdb4`）。样本含 7 个顶层键：`meta`（含 25 条怪癖台账与 18 段 V1 源码片段）·
  `resolve`（`resolveApiFor` 直调 22 例 + kw/mem/parallel 间接取证 15 例 + 生效预览 6 例）·
  `apiBlockHtml`（main/emb 两块 + 5 个 extras）· `apiPage`（真渲染投影，`panelsAgreeOnSubBody=true`）·
  `presetActions`（真实点击 14 步 / 13 toast）· `netSemantics`（`testApi` 6 + 端点后缀 16 + 错误 9 +
  `fetchModels` 8 + 非 200 + 点击委派 4）· `quirks` 25 条。
  这 16 项断言逐段比对：R0 样本自证 / R1 可复现 17 例 / R2 代理预设「不伪造」+ V1 自身回落 5 例 /
  R3 用途 override 15 例（与 V1 **真实请求**比对）/ R4 生效预览 6 例 / N1 端点 16 例 / N2 `testApi` 请求与形态 6 例 /
  N3 错误与 HTTP 文案 10 例 / N4 `fetchModels` 12 例 / P1 预设动作 13 步 + `savecfg` 改判 /
  U1 API 页结构 / U2 原位渲染与「不放假控件」 / U3 结果文案与降级 / Q1 怪癖台账裁决 / D1 通道降级 / D2 纯内核解析。

## 7. 对 §6.1 的更正

`docs/P8-功能对齐总表.md` §6.1 中，以下行**整行删除并改判为「已实现（B10-a，v2.35.0）」**：
`presetSave` `presetLoad` `presetDelete` · `apiTest` `apiModels` · `apiTemperature/apiMaxTokens/apiTopP` ·
按用途 API 预设（`kwApiPreset`/`memApiPreset`/`parallelApiPreset`/`activeApiPreset` 选择器）· `dimensionPresets`。
其中 `kwApiPreset`/`memApiPreset` 与 Embedding/Rerank **改判为「属向量检索层，未实现」**（§6.3 登记），
「代理预设」改判为 **`host` 通道迁移**。`savecfg` / `promptPreview` 的既有判定**不变**（另新增 §6.3「向量检索层未实现」登记）。
