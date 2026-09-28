# P10bq · 跨平台可移植性修复（v3.0.5）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.5）
> 触发（用户原话）：「三项一起修，按发版轮次走 v3.0.5」—— 修在中文 Windows 全新克隆上暴露的三处可移植性缺陷。
> 相关：`开发守则.md` §3（发版四步 · 推送策略）· `docs/05-开发指南` §3（黄金样本规则：新增「默认 locale 冻结」）·
>   `docs/history/P10ar`（v2.80.0 状态行去冒号，同属 `state-align` 投影口径）· `docs/history/P1`（保真度策略与黄金样本）

---

## 1. 缺口（怎么发现的）

在 Windows 上全新克隆仓库后直接跑 `npm run gate`：**6 道门禁通过、单元测试 4 文件失败**；
`gate` 因短路未执行冒烟（单独跑冒烟 **187 项全绿**）。四项失败归到三处互不相关的根因：

| # | 现象 | 根因 | 性质 |
| --- | --- | --- | --- |
| F1 | `tombstone-safety.test.js` 无法加载 | 6 行 import 写死绝对路径 `/home/ubuntu/st/ftt-memory-v2/...` | **真缺陷** |
| F2 | `cur-track-golden` · `model-golden2` · `state-align` 共 6 项断言失败 | 排序用**裸** `String#localeCompare`；oracle 录制机默认 locale 为 `en`，本机为 `zh-CN` | 跨平台脆弱 |
| F3 | `check-changelog-json` 报「清单与 CHANGELOG.md 不同步」 | Windows `core.autocrlf=true` 把该 JSON 检出成 CRLF，而门禁做**逐字节**比对 | 跨平台脆弱 |

> 注意 F1 的严重性不止「一个测试跑不了」：它在单测汇总里**恒为失败**，即单元测试在任何非
> `/home/ubuntu/st/ftt-memory-v2` 的路径下**永远不可能全绿** —— 这是仓库自身「改行为就同步架构篇 +
> 跑全门禁」（`开发守则.md` §1）流程的硬阻塞。

## 2. 取证（每条都有实测证据）

### 2.1 F1：绝对路径导入

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'D:\home\ubuntu\st\ftt-memory-v2\tests\harness\st-mock.js'
  imported from <本机仓库根>\tests\unit\tombstone-safety.test.js
```

`/home/ubuntu/st/ftt-memory-v2/...` 是 POSIX 绝对路径，在 Windows 上被解析为「当前盘符下的
`\home\ubuntu\...`」，故必然找不到。核查全仓：其余 **121** 个 `tests/unit/*.test.js` 一律使用相对导入
（`../harness/st-mock.js`、`../../core/...`），**只有该文件**是绝对路径。

### 2.2 F2：默认 locale 决定汉字排序

V1 与 V2 在这些位置用的是**不传 locales** 的 `localeCompare`（V1 原样移植）：
`core/model/money.js#knownCharacterNames`、`ui/panel.js#statesHtml`（主体分组）、`ui/scene-tree.js`、
`core/model/scalars.js` 等。其汉字顺序随宿主默认 locale 变化，实测本机：

```text
['甲','乙','丙'].sort((a,b)=>a.localeCompare(b))
  默认（zh-CN，Windows 用户区域）→ 丙,甲,乙   ← 拼音序
  'en'                          → 丙,乙,甲   ← 码点序，与 oracle 一致
```

对照 oracle 逐条确认「录制机口径 = `en`」：

| fixture | oracle 值 | 说明 |
| --- | --- | --- |
| `v1-golden-cur-track.json#knownNames.out` | `["角色丙","角色乙","角色甲"]` | 码点序 |
| `v1-golden-model2.json#knownNames` | `["角色丁","角色丙","角色乙","角色戊","角色甲"]` | 丁 `U+4E01` < 丙 `U+4E19` < 乙 `U+4E59` < 戊 `U+620A` < 甲 `U+7532`，纯码点序 |

**Windows 上无法用环境变量绕过**：实测 `LANG` / `LC_ALL` 三组取值（空 / `en_US.UTF-8` / `C`），
`Intl.DateTimeFormat().resolvedOptions().locale` 恒为 `zh-CN`，排序结果不变 —— 只能从**进程内**冻结。

### 2.3 F3：行尾与逐字节比对

`scripts/check-changelog-json.js` 的判据是 `prev !== next`（第 30 行），即**逐字节**比较工作区文件与
生成器当场算出的文本。Windows 上 `core.autocrlf=true` 会在检出时把 LF 转成 CRLF，于是：

```text
❌ 清单与 CHANGELOG.md 不同步（运行 node scripts/gen-changelog-json.js 重新生成）
```

而 `git diff --numstat FTT-memory-changelog.json` **输出为空** —— 证明内容零差异，差异只在行尾。

## 3. 修复

### 3.1 F1：改为相对导入

`tests/unit/tombstone-safety.test.js` 的 6 行 import 改为 `../harness/` 与 `../../core/`，与全仓一致。

### 3.2 F2：在测试宿主桩内冻结默认 locale

三个候选方案与取舍：

| 方案 | 结果 | 为何不选 / 选 |
| --- | --- | --- |
| A. 改**生产**排序为固定 locale | 用户可见顺序被改变（`zh` 用户由拼音序变码点序） | 属**行为变更**，按 `开发守则.md` §3.1 应走 `3.1.0`；且触碰「`core/` 逐字移植」的保真度基线 |
| B. 在测试里逐个归一后再比对 | 断言被**削弱**（丢掉「顺序与 V1 一致」这一事实），6 处分散，新增测试仍会再踩 | 与「黄金样本逐值一致」的目的相悖 |
| C. **在测试进程内冻结默认 locale**（本版采用） | 断言强度不变、生产零改动、落点唯一 | ✅ |

落点选 `tests/harness/st-mock.js`：它是全仓唯一的宿主桩，且三个受影响测试文件**都** import 它
（已 grep 核实），因此 `npm test`（经 `run.js` 逐文件子进程）与「单文件直跑」两种方式都生效。
实现只包一层：**未显式传 locales** 时补 `'en'`，显式传参一律原样透传。

### 3.3 F3：新增 `.gitattributes`

新增 `.gitattributes`：`* text=auto eol=lf`。本仓库「源码即发布物」（无构建、无依赖），行尾属于发布物的
一部分，故统一钉死为 LF —— 与 `开发守则.md` §3.2 的「归档自足性复跑」口径一致。

## 4. 验证

| 门禁 | 结果 |
| --- | --- |
| 单元测试 | ✅ **122 文件 / 1849 断言**，0 失败（修复前 118/122 · 4 文件失败） |
| 断言数自证 | 1849 与 `docs/README.md` §3 登记口径**吻合** —— 反证「录制机 = `en`」的判断成立（修复前因失败文件的断言不计入，累计仅 1795） |
| 冒烟测试 | ✅ **187 项**，0 失败 |
| 内核纯净度 / 标识符 / 词条 / 文档规范 / 版本清单 / UI 规范 | ✅ 全部 0 违规（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `3.0.5`，tag `v3.0.5` |
| 归档自足性 | ✅ `git archive` → 改名目录冷复跑全门禁通过 |

回归面确认：F2 的冻结是**全局**生效（所有经 `st-mock.js` 启动的测试），故已整体复跑全量单元 + 冒烟，
未出现「修好 3 个、弄坏别的」的情况。

## 5. 改动文件

| 文件 | 性质 |
| --- | --- |
| `tests/unit/tombstone-safety.test.js` | 6 行 import：绝对路径 → 相对路径 |
| `tests/harness/st-mock.js` | 新增测试进程内默认 locale 冻结（未显式传 locales → `en`） |
| `.gitattributes` | 新增：`* text=auto eol=lf` |
| `CHANGELOG.md` | 头部追加 v3.0.5 条目（只增不改） |
| `docs/05-开发指南.md` | 黄金样本规则新增「默认 locale 冻结」条目 |
| `docs/README.md` | §3 数字口径：版本 → `3.0.5`、历史批次档数 110 → 111 |
| `docs/history/P10bq-跨平台可移植性修复.md` | 本档 |
| `manifest.json` · `package.json` · `core/constants.js` | 版本号 `3.0.4` → `3.0.5`（四处一致之三） |

## 6. 缺口与后续登记（本版**未**处理）

1. **测试不再覆盖「宿主 locale 差异」这一真实行为**：冻结到 `en` 之后，「`zh` 用户实际看到拼音序」
   在测试里不可见。这是为复现 oracle 而做的**刻意取舍**（方案 A 的代价已在 §3.2 说明）。
   若将来要「钉死产品排序口径」，应作为**独立的设计稿 + 行为变更版本**（`3.1.0`）处理。
2. **当前层文档的测试规模已过时**（本次核对发现，`docs/README.md` §3 才是权威口径）：
   - `docs/03-技术架构.md:94`「单元 102 文件 / 1565 断言」、`:95`「冒烟 167 项」；
   - `docs/05-开发指南.md:32`「单元（102 文件）」、`:41`「102 文件 / 1565 断言」、`:42`「冒烟 167 项」；
   - `docs/README.md:33` 目录树注释「历史批次层（92 份）」。
   实际值：单元 **122 文件 / 1849 断言**、冒烟 **187 项**、历史档 **111 份**。
   本版只改了 §3 权威口径（按 `docs/README.md` §5.5「改了会变数字的东西 → 同步本文件 §3」），
   其余按「登记不顺手改」留给下一轮。
