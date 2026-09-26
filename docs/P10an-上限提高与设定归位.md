# P10an · 默认词条数量上限提高 + 提取记忆页非召回设定归位（v2.76.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.76.0）
> 触发（用户要求）：「各大类支持的**默认词条数量限制提高**，整体控制在 **2000-3000 原子数量**支持即可，
>   用户可自行修改现有设定来提升。设定-提取记忆中**很多设置根本不是召回处理用的**，请**正确归纳**到对应设定中。」

---

## 1. 默认上限提高（两层口径分开）

### 1.1 注入条数上限（`max*`）——合计 152 → **2980**（落在 2000-3000）

| 键 | 旧 | 新 | | 键 | 旧 | 新 |
| --- | --- | --- | --- | --- | --- | --- |
| `maxAtoms` | 16 | **800** | | `maxSuspense` | 8 | **120** |
| `maxMemories` | 8 | **400** | | `maxScenes` | 24 | **200** |
| `maxStates` | 30 | **400** | | `maxConcepts` | 10 | **200** |
| `maxSnapshots` | 10 | **200** | | `maxCurrency`(`maxCurrencies`) | 8 | **100** |
| `maxItems` | 16 | **200** | | `maxParallelsInj` | 8 | **100** |
| `maxPlans` | 8 | **120** | | `maxNpcs` | 24 | **80** |
| | | | | `maxRumors` | 6 | **60** |

**口径澄清**：这些是**候选条数上限**；真正决定注入体大小的是 **`charBudget`（默认 8000 字）** ——
条数放宽后，由预算按优先级（日期近度 → 楼层近度 → 命中度/重要度 + 关键词投票）择优填充，
单条放不下则整条跳过（不截断条目）。因此大库不再被「最多 16 条情节」这类小上限截住。

### 1.2 存储上限（`storeMax*`）——合计 3700 → **5600**

| 键 | 旧 | 新 | | 键 | 旧 | 新 |
| --- | --- | --- | --- | --- | --- | --- |
| `storeMaxAtoms` | 400 | **1200** | | `storeMaxPlans` | 200 | **300** |
| `storeMaxMemories` | 600 | **800** | | `storeMaxSuspense` | 200 | **300** |
| `storeMaxSnapshots` | 300 | **400** | | `storeMaxNpcs` | 200 | **300** |
| `storeMaxItems` | 400 | **500** | | `storeMaxRumors` | 200 | **300** |
| `storeMaxConcepts` | 600 | **700** | | `storeMaxCurrencies` | 300 | **400** |
| `storeMaxScenes` | 300 | **400** | | `maxParallels`（平行事件存储上限） | 30 | **200** |

- **保底（`storeMin*`）一律不变**（情节 100 / 记忆 200 / 角色 100 / 物品 150 / 概念 200）——
  任何自动清理、情节总结、遗忘都不得跌破保底（V1 v1.147 口径）。
- `core/ingest.js#STORE_LIMITS` 的**兜底值**同步为新默认（宿主未注入 cfg 时不再回落到旧上限）。
- 用户仍可自行修改：**设定 → 提取记忆 → 召回上限**（条数）/ **设定 → 遗忘 → 存储保底与上限**（存储）。

## 2. 非召回设定归位（控件总数不变 173，纯搬运）

| 页 | 旧 | 新 |
| --- | --- | --- |
| 分析记忆 | 5 项 | **17 项**（+ 货币记录 2 项 + 各大类单条字数上限 10 项） |
| 提取记忆 | 34 项 | **22 项**（只留召回相关） |

**搬到「分析记忆」的两组**（它们是**分析/入库口径**，与召回无关）：

1. **货币记录**：`currencyEnabled`（记录 + 注入总开关）、`currencyDynamicEnabled`（按正文出现的角色动态识别归属）
   —— 决定「分析记忆时抽不抽货币」；
2. **各大类单条字数上限**：`dimCharLimits.atoms/states/snapshots/memories/items/plans/suspense/scenes/concepts/parallels`
   —— 入库时的**硬截断**（`dimCap`），同时是提示词里字数要求的依据。

**「提取记忆」页保留并细分**（只留召回）：

| 分节 | 内容 |
| --- | --- |
| 提取记忆 · 三层结构 + 🟢 向量检索 + Embedding + Rerank + 检索参数 + 🟡 JS 抽取 + 🔴 AI 分析 + 关键词/记忆分析 API 分组 | 未变（v2.58 对齐 V1 的三层布局） |
| **注入预算** | `charBudget` + 短提示「预算才是注入体的真正上限」 |
| **召回上限（各大类注入条数）** | `maxAtoms` / `atomsRecentRatio` / `maxStates` / `stateMinPerSubject` / `stateMaxPerSubject` / `maxSnapshots` / `maxMemories` / `maxItems` / `maxPlans` / `maxSuspense` / `maxScenes` / `maxConcepts` / `maxParallelsInj` / `maxCurrencies` |
| **其它召回行为** | `keywordFilterByContext` |

## 3. 门禁

- 新增 `tests/unit/settings-capacity.test.js`（8 断言）：
  C1 注入合计 2980 且**每一类都提高**（旧合计 176）；C2 存储合计 5600、只升不降、保底不变；
  C3 设定项在册（提取页/遗忘页）且硬截断真实生效；C4 12 项归位（分析页有、提取页无、顺序正确）；
  C5 提取页只剩召回 22 项（含预算/上限/关键词过滤，无 `dimCharLimits.`/货币记录）；
  C6 分析页两节的分节位置与短提示；C7 控件总数仍 173（analyze 17 / extract 22）；C8 兜底值与新默认同源（1300 条情节裁到 1200）。
- 既有门禁同步：
  - `config-clock-golden` C1：新增「**有意提高的 25 个上限键**」白名单（并要求白名单内的值**确实更高**，防止白名单滥用）；
  - `forget-golden`：`MEM_CFG` 显式固定 `storeMaxMemories: 600`（黄金样本按 V1 默认录制，比对遗忘算法而非默认值）；
  - `settings-pages` P2（analyze 17 / extract 22）与 P2d（字数上限改断言分析页表尾）；`vector-layer` U1（「召回参数」→ 三个新分节）；
  - `analyze-grouping` A1/A2/A3/A4/A8/A9 更新为六节 18 键，并新增 A10 断言 12 项归位。
