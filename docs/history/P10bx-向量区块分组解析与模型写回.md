# P10bx · 向量区块的分组解析与模型写回（v3.0.12）

> 文档版本：v1.0 ｜ 日期：2026-09-29 ｜ 状态：生效（v3.0.12）
> 触发（用户原话）：「新版本，设定的向量API相关配置全不可用，请修复错误。」
> 追问确认（用户原话）：「API分组看到的是主线API的模型清单。获取模型无效。」
> 相关：`docs/history/P10v`（向量层与提取页对齐）· `P10a`（API 页与按用途渠道对齐）· `docs/01`（现状总览）

---

## 1. 现象与定位

设定 →「提取记忆」页的 **Embedding / Rerank API** 区块：字段都看得见，但 **🧪 测试** 与 **📦 获取模型**
一律无效；且用户看到「模型清单是主线 API 的」。真机上同区块的摘要行却写着「当前生效：… ← 分组「x」」。

**这种「说可用、点不动」的自相矛盾，直接指向两处读了不同的解析实现**：

| 位置 | 走哪条解析 | 结果 |
| --- | --- | --- |
| 区块摘要行（`ui/extract-page.js` ← `vectorLayerInfo()`） | `host/embeddings.js#vectorTarget()` | **正确解析 API 分组** → 显示可用 |
| 🧪 测试 / 📦 获取模型（`ui/api-page.js`） | `domBlockTarget()` **短路** `vectorTarget()` | 恒判失败 |

## 2. 根因（三个同族缺陷）

1. **分组完全不参与解析**：`domBlockTarget()` 见屏幕上「API 地址」为空即返回
   `{ok:false, error:'… API 未配置（缺少地址）'}`；调用方写的是
   `domBlockTarget(pfx) || vectorTarget(kind)` —— **带 `ok:false` 的真值对象把 `||` 短路**，
   唯一会解析分组的 `vectorTarget(kind)` 永不执行。而「地址留空 + 用分组」正是 V2 配置向量 API 的正规方式。
2. **「📦 获取模型」要求先填模型**：同函数还要求 `model` 非空，否则报「未配置模型」——
   而拉模型清单正是**用来选模型**的前置动作（`host/api-channel.js#fetchModels` 只需 `apiUrl` + `apiKey`）。
3. **区块「选择模型」写错键**：`ui/panel.js` 的 `fttModelSelect` 分支**写死 `cfg.model`**（主 API 的模型键）。
   v2.79.0 起 Embedding / Rerank 各有自己的下拉（`data-ftt-cfg="embeddingModel"` / `"rerankModel"`），
   于是从区块下拉选模型会**静默改写主 API 的模型**，区块自己的模型键永远为空 → 恒报「未配置模型」。

三条叠加的最终表现，就是用户说的「**向量 API 相关配置全不可用**」。

## 3. 交付

| 位置 | 修法 |
| --- | --- |
| `ui/api-page.js#domBlockValues`（原 `domBlockTarget`） | **只取值、不判定**：读屏幕上「地址 / Key / 模型 / 分组名」；页面上没有该区块 → `null`（回落 cfg） |
| `ui/api-page.js#blockTarget(pfx, kind, {requireModel})` | **逐字段合并**：屏幕值优先（V1 `collectApiBlock` 语义不变），缺项由 `vectorTarget()` 的**分组解析**补齐；分组也不含地址 → 如实报错并点名分组 |
| `ui/api-page.js#apiModels` | 传 `requireModel: false` —— 拉模型清单不再要求先有模型 |
| `ui/panel.js`（`fttModelSelect`） | 按控件**自己的 `data-ftt-cfg` 键**写回；无该属性（主 API 的旧下拉）回落 `model`，行为逐字不变 |

## 4. 边界与兼容（诚实登记）

- **屏幕值优先**保持原语义：用户刚改完、`change` 尚未派发时，按输入框当前值解析（V1 同口径）；
- **分组缺地址**不静默：错误串里带上分组名（`缺少地址，且分组「x」不含地址`），与 `vectorTarget()` 文案同源；
- **主 API 侧不受影响**：`API 页` 的 🧪 测试 / 📦 获取模型 仍走 `resolveApiTarget({purpose:'main'})`；
  主 API 的模型下拉（无 `data-ftt-cfg`）写回仍是 `cfg.model`（冒烟 `AK2` 原断言不变）；
- **不改配置结构**：`embeddingProxyPreset` / `rerankProxyPreset` 语义与键名保持与 V1 对齐。

## 5. 验证

- 单元：**125 文件 / 1972 断言**（v3.0.12 前为 125 / 1967）；`tests/unit/vector-layer.test.js` 33 → **38 项**：
  - `A10` 分组配置（地址留空）→ 📦 获取模型 走**分组地址**并回填本区块；
  - `A11` 同上 → 🧪 测试 真发请求到分组地址（不再误报「缺少地址」）；
  - `A12` 分组不含地址 → 如实报错（含分组名），不假装拉到模型；
  - `A13` 屏幕地址优先于分组；
  - `A14` 拉模型不再要求先填模型。
- 冒烟：**188 项**（新增 `AK2b`：区块「选择模型」写回本区块键，且**不动**主 API 的 `cfg.model`）；
- **附带修复 · 冒烟 `BL1` 自足化**：排查中该断言恒红。归因结论：**与本版改动无关** ——
  在**未改动的 v3.0.11 归档树**上同样恒红（`git archive v3.0.11` → 干净目录 → `node tests/smoke-test.js` 复现）。
  真因是该断言经 `customKeywords()` 取词，而词源**只来自库里既有条目的 tags**（`jsExtractKeywords`）
  或「设想里出现过的库内片段」（`ideaCorpusTerms(corpusText())`）—— 它此前**依赖前序断言残留的库数据**
  （即**跨断言耦合**），残留内容一变（前序改过 `state.atoms`）就必失败。
  现由该断言自备一条带「码头」标签的情节并在 `finally` 还原，3/3 稳定通过。
  **教训**：断言必须自足 —— 依赖「现场残留」的断言会把无关改动变成红灯，浪费一次完整归因。
- 门禁：`npm run gate` 全绿（含核心纯度 / i18n / 版本同步 / 文档规范 / 本地隐私 / CHANGELOG JSON）。

## 6. 用户侧验收步骤

1. 更新插件到 **v3.0.12** 并刷新页面；
2. 设定 →「提取记忆」→ Embedding 区块：**只选「使用 API 分组」**（地址留空）→ 点「📦 获取模型」，
   应显示「✅ Embedding 获取到 N 个模型」且下拉里出现**该分组端点**的模型；
3. 从下拉选一个模型 → 摘要行应变为「当前生效：<所选模型>」，且**主 API 的模型不会被改动**；
4. 点「🧪 测试」→ 应回「✅ 可用（<n>ms）」，失败时给出真实原因（如 CORS / 鉴权 / 404）。

本版**未修改插件仓库之外的任何数据**；文档与测试里不出现本机用户名、主机名、绝对路径或局域网地址。
