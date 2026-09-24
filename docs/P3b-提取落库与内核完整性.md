# P3 次批 · 提取落库内核与内核完整性门禁

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效
> 关联：`core/ingest.js`、`scripts/check-core-refs.js`、`core/model/runtime.js`（注入视图）、
> `adapters/store.js`（索引基线修正）、`docs/P2-宿主与存储.md`、`docs/P3-注入闭环.md`

---

## 1. 本批做了什么

1. **移植 AI 增量落库内核** `core/ingest.js`（`mergeDelta`，1513 行 / 66 项闭包）——AI 产出的归一化增量
   （atoms / states / snapshots / memories / items / plans / suspense / concepts / parallels / currencies /
   rumors / links 的 add / update / remove / close）**按 V1 同一顺序**写进容器；
2. **新增内核完整性门禁** `scripts/check-core-refs.js`（未定义标识符静态检查，已进 `npm run gate`）；
3. 借该门禁发现并修复 **一类静默数据丢失缺陷**（§3）、把宿主耦合改为**注入视图**（§4）；
4. 修正保存流水线的**索引基线语义**（§5，真实缺陷）；
5. 受影响黄金样本改用**真实 V1 插件**重算（§6）。

## 2. `mergeDelta` 落库口径（与 V1 逐字一致）

| 维度 | 关键口径（V1 原样） |
| --- | --- |
| atoms | `add` 归一化（缺日期补剧情日期）→ 按 id 就地替换；`update` 按 id / 标题 / 正文定位，命中则**保留 uses 与因果 `log`（仅正文变化时追加 `{prev,date,floorStart,floorEnd}`，最多 3 条）**；`remove` 仅过滤 |
| 已总结隐藏情节 | `atomIsHidden` 命中的条目 **不接受 AI 改写**（v1.203 数据安全口径） |
| memories | 缺日期补剧情日期；`remove` 写 **id 墓碑 + 内容哈希墓碑**并清孤儿关联 |
| items | 同名只更新不新增；`qty === 0` 自动删除（含历史同名残留）；带 `floorStart/floorEnd/seenDate` |
| currencies | 同一「归属 + 币种」只维护一条（额度覆盖、收支追加 `history`） |
| rumors | 走 `rumorApplyAiDelta`（同主体维护一条；分裂/说法不同 → 建父子分支） |
| plans / suspense | `normalize*` 要求 `content`；`status:'closed'` → 原文删除并累计 `stats.plansClosed` / `suspenseResolved`；`close` 支持 id / 内容精确 / 双向包含匹配 |
| snapshots | add/update 合并 + `refreshAllSnapshotAges()`（有出生日期即按剧情锚点重算年龄）；`remove` 联动清除该角色状态记录并写墓碑 |
| 统一收尾 | 写回关联层 → 各维度存储上限裁剪（`capAtomsKeepingHidden` 保留隐藏情节）→ 状态条数钳制 → 维度上限 → `saveState()` → 返回 `{ ok, added, total }` |

`saveState()` / `dbgLog` / `cfg` / `state` / `getStoryNow` 全部经 `core/model/runtime.js` 注入，内核零宿主依赖。

## 3. 门禁揪出的「静默数据丢失」缺陷（已修）

V1 的归一化函数大量使用 `try { … } catch (e) { return null; }`。逐字移植时若**漏搬被引用的辅助函数**，
`ReferenceError` 会被这些 `catch` 吞掉，表现不是崩溃而是「某类条目悄悄写不进去」。`check-core-refs.js`
扫描 `core/` 后一次性找出 7 处：

| 缺失标识符 | 归属 | 影响 |
| --- | --- | --- |
| `splitListText` | `core/util.js`（新定义，`scalars/segment/snapshot/money/rumor` 改由 util 提供） | 物品/货币/传言等**标签为逗号文本**时整条归一失败 → 条目被丢弃 |
| `snapNameKey` | `core/util.js`（新定义；recall/entries/snapshot 共用） | 角色档案按名匹配（含注入在场判定）失效 |
| `normalizeRelRefList` | `core/model/rel.js`（补导出） | 计划的结构化引用字段整段丢失 |
| `clockDateParts/Str/Valid/ParseDateText/storyDateMsFromStr/clockYearStr/clockNormBcText/dateStrCmp` | `core/clock.js`（补 `dateStrCmp`、`clockParseDateText`，其余补 import） | 分段/档案的日期解析与排序静默失败 |
| `SNAP_APPEARANCE_LABELS/LIMIT`、`SNAP_BIRTH_ANOMALY_*`、`SNAP_FUTURE_ORIGIN_RE`、`ensureSnapshotBirthDate`、`storyAnchorDate`、`storyClockReference` 等 | `core/model/snapshot.js`（移植补全） | 外貌聚合、出生日期回填、年龄锚点全部失效 |
| `parallelRelPrefix` | `core/recall.js`（移植补全） | 平行事件注入行缺前缀 |
| `defaultCfg`（segment） | `core/config.js`（补 import） | 分段正文上限回退不到默认值 |

## 4. 宿主耦合改为注入视图（内核保持纯净）

| V1 的宿主调用 | V2 做法 |
| --- | --- |
| `toast(...)`（平行/状态衰退提示，2 处） | `core/model/runtime.js#notifyHooks` + `setNotifyHooks`；宿主接到 `toastr`，缺失即静默 |
| `getCurrentCharacterName()`（货币默认归属） | `identityView.characterName` + `setIdentityView`；`index.js#installHostBridges` 注入 `name2/name1` |
| `setTimeout/clearTimeout`（三种延迟衰退调度） | `timerHooks` + `setTimerHooks`；**默认 no-op**（宿主未注入即不调度，内核不碰全局定时器） |

## 5. 保存流水线的索引基线修正（真实缺陷）

V1 `saveState()`（v1.206）顺序为：`entryIndexBuild(true)` → `tombstoneSweep()` → 写库；
`tombstoneSweep()` 自己维护「上一次基线」（结尾 `entryIndexPrev = curIdx`）。
因此**基线只能在启动/载入时建立一次**（V1 在启动与回滚后调 `entryIndexInit()`）。

`adapters/store.js` 原本的 `if (!indexReady) entryIndexInit()` 语义正确，但缺少「载入后立即对齐」这一步；
本批新增 `primeStateIndex()` 并在 `index.js#loadMemoryState()` 末尾调用。**若在每次保存里重建基线，
删除将永远检测不到（墓碑不写）** —— 这正是单测 M9 暴露的风险点，已在代码与测试注释中标注。

## 6. 黄金样本改用真实 V1 插件重算

批次 1–2b 的模型样本由「V1 源码切片」产出，切片缺依赖 → 样本记录的是**降级后的中间态**
（例如 `age:''`、`appearance:''`、`clockDateTrim:''`、分段 `start/end:''`、平行事件 `null`）。
补全依赖后 V2 与真实 V1 一致，而这些旧样本反而成了「错误的真值」。本批处理：

- 能直接调用的导出函数：`clockDateTrim`、`normalizePlotSegment`、`sortPlotSegments`、`parsePlotSegmentText`、
  `plotSegmentId/Range/TimeKey`、`normalizeCurrency`、`atomContentHash`、`snapshotAgeInfo`、`snapshotAppearanceText`、
  `snapshotBirthAnomaly*`、`migrateState` → **真实 V1 插件直算后写回样本**；
- 未导出的规范化器（`normalizeSnapshot`、`normalizeParallel`）：用 `mergeDelta` **逐条输入**落库读回（避免同名合并），
  剥掉流水线字段（`h`/`floorStart`/`floorEnd`/`updatedAt`/`lastUpdateDate` 等）后**逐字段核验**再写回；
- `migrateState` 的 oracle 必须复刻测试的**别名场景**（同一对象既是内核 state 又是入参）与楼层/配置口径，否则锚点不同、结果不同；
- 墙钟字段（`updatedAt`/`createdAt`/平行事件 `updatedAt`/分段 `timeKey` 第三段）**不进移植口径**，
  测试改为抹平后比较（`timeKey` 只比对前两段并校验段数为 3）。

## 7. 本批测试

| 文件 | 断言 | 覆盖 |
| --- | --- | --- |
| `tests/unit/ingest-golden.test.js` | 10 | 黄金样本 10（oracle = 真实 V1 插件）：13 类维度落库**逐字符一致**、返回统计、情节就地更新（uses/log）、楼层范围透传、内容哈希一致、单值容器/变量、年龄锚定、传言归一、幂等、**删除留痕**、脏增量不抛 |
| 受影响的旧样本 | — | `model-golden`(15)、`model-golden2`(23)、`migrate-entries-golden`(15) 全部回到全绿，且真值改由真实 V1 插件产出 |

门禁口径：单元 **21 文件 / 277 断言**、冒烟 **29/29**、内核纯净度 0、**内核标识符 0**、版本一致性 OK、文档规范 0。

## 8. 尚未完成

| 项 | 说明 |
| --- | --- |
| AI 提取编排 | 楼层正文 → 三层提取链（关键词 → JS 抽取 → AI 分析）→ `mergeDelta`；提示词模板、通知与链路元数据 |
| 提取落库接线 | `GENERATION_ENDED` → 取楼层正文 → 增量 → `saveStateNow()`（本批已具备内核与保存两端） |
| 使用计数 / 注入自查 | `countUses` 落库、候选 vs 注入解释面板 |
| 快照链 / 跨端同步 | 见 `docs/P2-宿主与存储.md` §7 |
