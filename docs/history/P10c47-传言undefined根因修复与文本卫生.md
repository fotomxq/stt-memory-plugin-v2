# P10c47 · 传言里的 `undefined` 根因修复 + 文本卫生（v3.26.1）

> 文档版本：v1.0 ｜ 日期：2026-10-06 ｜ 状态：生效（v3.26.1）
> 用户要求（原话）：「有传言中出现了undefined字样，其他原子数据可能也有，请核对原因并进行修复。同时建议如果AI回复不可控，可以用默认值来顶上去，避免出现异常数据。」
> 关联：`docs/history/P8t-B8-7传言演化引擎.md`（引擎的 V1 逐字移植 —— **本批有意偏离其中一处**，见 §4）·
>   `docs/history/P10c44-刷新后初始化两错-状态未注入.md`（载入期告警/留痕口径）·
>   `core/rumor-evolve.js`（掷骰与变化过程）· `core/util.js#scrubBadToken`（文本卫生）· `core/migrate.js#healthSelfHeal`（载入自愈）· `core/data-health.js`（只读体检）

---

## 1. 核对原因（先取证，再改代码）

**只读扫描真实存档**（宿主扩展存储里 185 万字符的状态文件，逐字段遍历字符串）：

| 命中位置 | 内容形态 | 份数 |
| --- | --- | --- |
| `rumors[1].content` | `…（说法演变为：undefined）` | 1（+ 2 份快照链副本） |
| `rumors[1].chain[7].note` | `说法完成演化（undefined）` | 1（+ 2 份快照链副本） |
| 其余全部维度（情节 / 状态 / 角色 / 记忆 / 物品 / 计划 / 悬念 / 场景 / 概念 / 平行 / 货币 / 分段） | **零命中** | —— |

**根因（确定性，逐函数复现）**：`core/rumor-evolve.js#rumorRoll(seed)` 把 `hashText()`（djb2 → **base36**，见 `core/util.js`）
按 **16 进制**解析 —— base36 合法字符含 `g`~`z`，而它们是**非法 16 进制字符**：

```text
rum_m1|variant|2020-01-01|1   → parseInt(...,16) 侥幸可解析 → 0.00005（极小，几乎必然"命中"）
rum_v2|variant|2020-06-01|1   → 含 g~z → NaN
rum_13oko38|variant|2020-05-01|1（真机那条）→ NaN
```

`NaN` 引发三处后果：

| 后果 | 机理 |
| --- | --- |
| **`undefined` 落盘**（用户看到的症状） | `rumorVariantFor` → `RUMOR_VARIANTS[Math.max(0, Math.min(len-1, Math.floor(NaN*len)))]` = `RUMOR_VARIANTS[NaN]` = `undefined` → 模板 `` `${before}（说法演变为：${variant}）` `` 拼出字面量 `undefined` |
| 概率判定失效 | `rumorMaybeStartChange`：`NaN < chance` 恒假 → 该传言**永不**裂变/变异；`rumorParallelLink`：`NaN >= chance` 恒假 → 联动分支**永远**走「推动」 |
| 掷骰不随轮次变化 | djb2 的末步是 `h*33 ^ c`，只改种子最后一个字符时哈希仅低位变化 → 直接取 `%100000` 会让同一传言的掷骰在 1..9 轮几乎不变（实测全落在 0.1959） |

## 2. 修复（三层：根因 / 默认值 / 全链路兜底）

| 层 | 落点 | 口径 |
| --- | --- | --- |
| ① 根因 | `core/rumor-evolve.js#rumorRoll` | 按 **base36** 解析 + **32 位终混**（`x^=x>>>16; x*=0x7feb352d; …`）→ 恒返回 `[0,1)` 有限数；同 seed 恒定（跨端一致）；2 万样本十等分桶差 < 7% |
| ② 默认值（用户建议） | `rumorPendingVariant()` / `rumorVariantFor()` | 变体名**永不返回空值**：`pending.target` 为空或本身就是历史脏 token → 回落确定性变体 → 再不济回落 `'变体'` |
| ③ 文本卫生 | `core/util.js`（`hasBadToken` / `scrubBadToken` / `walkStrings`）接进 **`normText`** | 三处写入口径（AI 增量补写 / 机械演化 / 手工编辑与导入）**共用同一个归一函数**，于是坏占位 token（`undefined` / `NaN` / `[object Object]`）不可能再落库 |

**`scrubBadToken` 的边界（防误伤）**：只清 token 以「**值**」形态出现的位置 —— 整字段 / 冒号后 / **以 token 结尾的括号**（`（说法演变为：undefined）` 整段删除）/ 分隔符旁；
`[object Object]` 任何位置都删（它不可能出现在正常正文里）。若正文里正常提到英文词（`the undefined behaviour`），或 token 嵌在词中间（`前缀undefined后缀`），**保持原样**。幂等。

## 3. 存量脏数据（用户无需手工清理）

| 环节 | 行为 |
| --- | --- |
| 载入自愈 | `core/migrate.js#healthSelfHeal` 新增第 ⑥ 步：逐条深度清坏 token（深 ≤4 / 字符串 ≤20000 双上限），计数进 `lastHealInfo().texts`（面板/日志留痕口径与既有自愈一致）；**只清 token、绝不删条目** |
| 只读体检 | `core/data-health.js` 新增发现码 `text-bad-token`（warn，带 dim / id / 字段路径），与调试桥 `ftt.dataHealth` 同源 —— 残留时能直接定位 |
| 快照链 | 快照里那两份副本属**历史留痕**：`healthSelfHeal` 的维度表不含 `snapStore`（快照链的 `sig` 与内容绑定，改写内容会让链自检失真），故**不主动回填**；若用户从快照还原，还原出的状态会再走一次载入自愈 → 同样被清干净 |

## 4. 有意偏离 V1（如实记录）

V1 的同一函数就有这个缺陷 —— 黄金样本本身就是证据：`rum_m1` 的变体恒为「夸大版」、`rum_v2` 恒为 **`undefined`**（`tests/fixtures/v1-golden-rumor-evolve.json` 里的 `variants` 段）。

因此修好掷骰后，**机械演化的掷骰结果与据此发生的决策必然不同于 V1**：

* `tests/unit/rumor-evolve-golden.test.js` 中受影响的 8 项（**Z3 / Z10 / Z12 / Z16 / Z17 / Z18 / Z20 / Z21**）改为与新增的
  **V2 自基线**逐字比对：`tests/fixtures/rumor-evolve-v2-baseline.json`（由本版实现生成、文件内与测试头都明确标注「自基线」，只锁回归）；
  自基线可用 `FT_EVOLVE_BASELINE=1 node tests/unit/rumor-evolve-golden.test.js` 再生成（改动掷骰口径时需人工核对）；
* 其余断言（结构归一 / id 派生 / 墓碑与衰退打分 / 文案模板 / 通知接线 / AI 补写窄契约）**仍与 V1 oracle 逐字一致**；
* Z12 反过来成了**用户 BUG 的回归判据**：任何 id / 日期 / 下标都必须返回变体表内的非空字符串（V1 会返回 `undefined`）。

## 5. 测试与门禁

* 新增 `tests/unit/text-hygiene.test.js`（**13 项**）：`scrubBadToken` 形态与幂等 / 不误伤 / `normText` 唯一入口 / `walkStrings` 上限与只读语义 /
  `rumorRoll` 有限性与分布（含两个 NaN 真实病例）/ `rumorVariantFor` 永不空 / 提交「变异」的脏 target 回归 /
  「变化过程」三连链路无 `undefined` / AI 增量补写的脏 token 清理与必填字段兜底 / `healthSelfHeal` 存量自愈（含嵌套与幂等）/
  `migrateState` 全链 / 体检 `text-bad-token` / **全维度覆盖面**（各维度文本字段同一口径）；
* 冒烟新增 **BY1**（端到端）：真实面板跑传言演化（全库无 `undefined`）→ 载入期自愈清掉存量脏数据并留痕 → 只读体检列出 `text-bad-token` → 两个历史 NaN 病例已修；
* `rumor-evolve-golden` 改判 8 项（见 §4）+ 新增 V2 自基线 fixture；
* 全量：**158 文件 / 2446 断言** + 冒烟 **217 项**；静态门禁（含 `check-docs-facts`）全绿。

## 6. 未验证项与后续

| 项 | 状态 |
| --- | --- |
| 真机刷新后：那条传言的正文与链路里的 `undefined` 被**载入自愈**清掉（旧快照副本仍在） | **未验证**（待刷新；可用调试桥 `ftt.entries {dim:'rumors'}` 核对，或 `ftt.dataHealth` 应无 `text-bad-token`） |
| 真机：机械演化（「🧪 立即演化」）不再写出 `undefined`，且裂变/变异/联动开始按概率正常发生 | **未验证**（掷骰已由单测锁定；真机观察几次演化即可） |
| 是否把 `'null'` / `'无'` / `'不详'` 也纳入占位清理 | **暂不做**：这些是**内容判断**（可能是用户真实文风），纳入会误伤；角色档案那类「未知/不详」已有专门的机械清理口径 |
| 快照链里那两份历史副本 | **不主动改写**（快照＝历史留痕）；如需彻底清除可在数据管理页删快照链 |
