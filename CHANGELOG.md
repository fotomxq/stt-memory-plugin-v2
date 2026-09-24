# FTT记忆组件 V2 · 版本历史

> 本文件为 V2（SillyTavern 原生扩展）的版本史；V1（酒馆助手 iframe 脚本）版本史见 V1 仓库 `CHANGELOG.md`。
> 版本号与 git tag 同名（`vX.Y.Z`），由 `scripts/check-version-sync.js` 校验。

## v2.0.0（2026-09-24）

**P0：可安装骨架 + 宿主 API 探针结论（原生扩展形态立项）**

- **用户要求**：「开始开发V2版」（承接 V2 设计稿 `docs/13`+`docs/14`：结合现有架构与功能体系，构建酒馆原生插件）。
- **本版范围（P0）**：
  1. 扩展骨架：`manifest.json`（含 `generate_interceptor` / `hooks` / `i18n` / `auto_update`）+ ESM 入口 `index.js` +
     `settings.html` + `style.css` + `i18n/`（zh-cn / en）；
  2. 四层骨架：`core/`（纯内核：常量 + 工具，零宿主依赖）、`host/`（st-api / events / inject / interceptor / generation）、
     `adapters/`（settings）、`ui/`（settings-panel / commands）、`devtools.js`（`window.FTT`）；
  3. 依赖方向门禁：`scripts/check-core-purity.js`（core 不得引用宿主层或浏览器标识符）；
  4. 版本一致性门禁：`scripts/check-version-sync.js`（manifest / package / constants / CHANGELOG / git tag）；
  5. 文档门禁：`scripts/check-docs.js`（围栏 / 语言标注 / 标题层级 / HTML / 行尾空白 / 头部元信息）；
  6. 测试基建：`tests/harness/st-mock.js`（宿主桩：getContext + 最小 DOM）、7 个单元用例文件、
     `tests/smoke-test.js`（有宿主全链路装配 + 无宿主导入不崩）；
  7. 探针结论：`docs/P0-探针报告.md`（源码级核对 ST release 分支：注入 API 签名与枚举、getContext 能力面、
     **ST 原生 git 更新端点**、世界书 / 弹窗 / 宏 / 命令 / 连接配置等）。
- **行为**：安装后 `activate` 挂载生成前拦截器（**永不 abort**）；`APP_READY` 时初始化：
  能力探测 → 配置初始化 → 设置面板挂载 → 事件绑定（`GENERATION_ENDED` / `USER_MESSAGE_RENDERED` / `CHAT_CHANGED`）
  → 注册 `/ftt` 命令与 `{{fttVersion}}`/`{{fttStatus}}` 宏 → 安装 `window.FTT`；禁用/删除时 `teardown()` 全部解绑并清空注入。
- **未做（后续阶段）**：提取/注入闭环（P3 接入 V1 内核）、数据模型与存储适配（P2）、数据台 UI（P4）、
  高级域（P5：时钟 / 关联 / 传言 / NSFW / 情节总结 / 分段总结 / 修复 / 遗忘）、V1 数据导入向导（P6）。
- **更新检查机制（Git 通道，本版新增）**：以 **GitHub 项目地址**为更新检查地址（`updateRepo` 默认
  `https://github.com/fotomxq/stt-memory-plugin-v2`，分支 `main`，可在设置内改）——
  ① **首次启动自动检查**（`startupCheckedAt` 未写则必查；之后按 24h 间隔；开关可关，关闭后零远端请求）；
  ② **设置内手动检查**（「🔍 检查更新」按钮，不受开关与间隔限制，结果落盘并在状态行显示）；
  ③ 判定通道优先级 = **ST 原生端点**（`POST /api/extensions/version` 的 `isUpToDate`/commit，Git 真值）
  → 远端 `manifest.json` + `CHANGELOG.md` 回退（补版本号与更新要点；**仓库根无 `manifest.json` 时用 `CHANGELOG.md` 首条版本兜底**）；端点为「有更新」而版本号相同时判为**同版本新提交**；
  ④ 「⬆ 立即更新（ST）」代为调用 `/api/extensions/update`（**仅用户点击**，自动路径永不调用）；
  ⑤ 全部请求 8s 超时、失败静默（不阻塞启动/发送/提取）；扩展**不下载、不写入、不执行远端代码**；
  ⑥ 状态持久化于 `extensionSettings.ftt_memory_v2.update`（`firstRunAt` / `startupCheckedAt` / `lastCheckAt` / `lastResult`），
  `/ftt` 与 `FTT.update()` 可查；新增 `core/update.js`（纯逻辑）、`host/update.js`（编排）、`adapters/update-state.js`（持久化）、
  `docs/更新检查机制.md`。
- **P1 内核平移（批次 1：模型层，本版新增）**：把 V1 的归一化内核**逐段提取**进 `core/model/` ——
  `scalars.js`（17 个助手 + 3 张常量表 + 可注入 `cfg` 视图）、`atom.js`（`normalizeAtom`）、
  `dims.js`（状态 / 记忆 / 概念 / 平行 / 物品 / 计划 / 悬念 / 名册 / 场景 九个 `normalize*`）、`hash.js`（`atomContentHash` 双哈希）；
  `core/constants.js` 增 `DIM_CHAR_LIMITS`（逐字取自 V1 `defaultCfg`）；`hashText` 对齐 V1（**djb2 → base36**，
  而非 FNV/十六进制 —— 它决定 id 派生与删除墓碑）、`normText` 恢复 V1 语义（**保留换行**）、`clamp` / `normalizeList` 与 V1 一致；
  角色作用域改为 `char:hashText(avatar → name2 → 索引)`（与原 TH 角色 id 口径尽量靠近）。
  **保真度门禁**：V1 源码切片产出黄金样本 `tests/fixtures/v1-golden.json`（10 维度固定夹具 + 6 组哈希 + 7 项助手），
  `model-golden.test.js` 复放并要求 **JSON 逐字符相等**（15 项断言）。详见 `docs/P1-内核平移.md`。
- **P1 内核平移（批次 2：档案 / 年龄 / 货币 / 分段）**：新增
  `core/model/runtime.js`（**注入视图**：`cfg` / `state` / `getStoryNow` / `defaultCfg` + `saveCfg`·`saveState` 持久化钩子，
  由宿主注入 —— 内核保持零宿主依赖，V1 代码逐字不改）、
  `core/model/snapshot.js`（612 行：`normalizeSnapshot` + 年龄族 `snapshotAge*`/`calcAge`/`syncSnapshotAge`/`refreshAllSnapshotAges`
  + 出生日期族 `parseBirthDateParts`/`birthDatePrecision`/`birthDateInFuture`/`snapshotBirthAnomaly*` + 时间采样 + `migrateSnapshotV1162`）、
  `core/model/money.js`（210 行：`normalizeCurrency`/`formatMoney`（万·亿·兆·京·垓）/`moneyNet`/流水 + 标定角色 `trackedCurrencyRoles` 增删清 + `defaultCurrencyOwner`）、
  `core/model/segment.js`（188 行：情节分段总结 `normalizePlotSegment`/`plotSegmentId`/`plotSegmentRange`/`plotSegmentTimeKey`/排序/文本互转）；
  `scalars.js` 追加 `SNAP_GROUP_MAP`/`splitListText`/`normalizeTrackedRoles`。
  **黄金样本 2**（`tests/fixtures/v1-golden-model2.json`）：`model-golden2.test.js` **23 项断言**逐字符比对
  （档案 / 年龄与锁定 / 出生异常 / `calcAge` 跨生日与公元前 / 货币含 1.23 亿显示 / 分段含时间倒序与文本互转）；
  时间戳（`createdAt`/`updatedAt`，墙钟）比较前抹平，其余字段严格相等。
- **P1 内核平移（批次 2b：关联层 / 传言）**：新增 `core/model/rel.js`（292 行：`normalizeRelLink` 维度白名单与方式越界留痕、
  `relLinksOf`、`relOrphanStats`、`relSummaryLine` + `REL_LINK_*` 常量族）与 `core/model/rumor.js`（324 行：`normalizeRumor`、
  `rumorId`/`rumorChildId`/`rumorSubjectKey`、传播者与载体解析、链路/谱系/待办归一、`rumorStageByFerment`、`mergeRumorObjects`）；
  **模型层至此覆盖全部 14 类维度**。关联层的写入/维护（`upsertRelLinks`/`relMaintRun`/`migrateRelLinks`/`sweepOrphanRelLinks`）
  因触碰墓碑与迁移，留待批次 3 的状态与合并层。
  **黄金样本 3**（`tests/fixtures/v1-golden-model3.json`）：`model-golden3.test.js` **16 项断言**（含 9 条关联夹具、中文键传言、
  阶段映射边界、三类合并）。同时引入「**重抛探针**」：把切片里的 `catch { return ... }` 临时改为 `throw`，暴露并补齐
  被静默吞掉的 10 项常量依赖（`REL_LINK_HOW_CN`、`RUMOR_STAGES` 等）。
- **P1 内核平移（批次 3：状态与合并层 · 无时钟依赖部分）**：新增 `core/state.js`（51 行：`scopeId` —— 角色标识改为注入视图、
  `stateKey`、`emptyState` 28 键容器）与 `core/merge.js`（144 行：删除墓碑 `tombSet`/`tombSetH`/`tombEntry`/`tombMany`/`tombEntries`、
  隐藏条目保护 `atomIsHidden`/`activeAtoms`/`capAtomsKeepingHidden`/`releaseMergedSources`、内容哈希补全 `eachAtom`/`ensureAtomHashes`/`collectAtomHashes`）；
  `constants.js` 补 `ATOM_DIM_KEYS`。黄金样本 4（`tests/fixtures/v1-golden-state-merge.json`）**12 项断言**：
  作用域与空状态、隐藏保护与来源恢复、墓碑分账与幂等、哈希补全与遍历。
  **明确延后**（依赖配置/时钟/全表）：`migrateState`、`contentDedupeArray`、`upsertEntry`/`deleteEntry`、`upsertRelLinks`/`relMaintRun`。
  过程经验（已写入文档）：**宽依赖函数不可用闭包移植** —— 首次尝试闭包膨胀到 148/1067 项，改为显式清单 + 严格静态检查 + 黄金样本兜底。
- **P1 内核平移（批次 6：召回与注入层 · 内核收尾）**：新增 `core/recall.js`（1362 行：时间排序、评分与命中、匹配器、
  在场判定、各类注入行、**注入体装配** `buildMemoryBodyForInject`、**固定约束段** `buildInjectConstraints`、使用计数）；
  `runtime.js` 增 `getChatMessages`/`getAssistantText`/`latestAiFloorText`/`dbgLog`/`warn` 注入钩子。
  **内核移植至此全部完成**（`core/` 19 个文件：模型 10 + 状态合并 4 + 配置时钟 2 + 召回注入 1 + 常量/工具）。
  黄金样本 7（oracle = 真实 V1 插件，14 类维度注入态 + 固定预算）：`recall-golden.test.js` **12 项断言**，
  含**注入体在两个预算下逐字符一致**与约束段逐字符一致。
  **生成器精化**（本轮踩到并修好，写入 docs/P1-内核平移.md §2.12）：① 取标识符前剔除注释与字符串；② 处理函数体内局部名遮蔽；
  ③ 排除对象键与属性访问；④ 移植体**常量先行**避免 `const` TDZ。并借 `warn` 注入钩子发现并补入 `relConceptSuffix`、`clockDateLabel`。
- **P1 内核平移（批次 7：墓碑清扫与存储信封）+ P2 宿主接线首批（本版新增）**：新增 `core/sweep.js`（160 行：`entryIndexInit` /
  `entryIndexBuild` / `tombstoneSweep` / 索引与墓碑计量）与 `core/envelope.js`（30 行：`storageEnvelope` / `storageHash` / `storageVerify`），
  补齐 V1 `saveState()` 流水线中「消失条目写 id + 内容哈希双墓碑」「刷新全部原子 `h`」两段内核逻辑；
  黄金样本 8（oracle = 真实 V1 插件）：`sweep-envelope-golden.test.js` **8 项断言**（索引基线、墓碑判定与幂等、信封形状与哈希校验、篡改拒绝）。
  宿主接线：`host/chat.js`（`wireKernelChatHooks`：消息数组 / 最新 AI 正文 / 最后楼层号 / 角色稳定键 → 内核注入视图）、
  `adapters/store.js`（`saveStateNow` 复刻 V1 六步流水线并写 localStorage / IndexedDB / 服务端文件三级后端，
  `loadFromLocalStorage` 带哈希校验、`scheduleSave` 防抖、`wirePersistHooks` 接线、`storeStatus` 诊断）、
  `adapters/user-file.js`（ST 原生 `/api/files/{upload,delete}` + `/user/files/<name>`，命名 `ftt2-state-<slug>.json`，
  与 V1 的 `ftt-state-*` 并存以便导入器读取）；`tests/unit/store-chat.test.js` **13 项断言**（全部为 await 后真实条件，
  显式排除恒真假绿写法）。**入口接线**：`index.js` 的 `init()` 在挂面板后执行 `loadMemoryState()`
  （本机缓冲 → 服务端文件 → 空容器 → `migrateState` → 注入内核 + 楼层号），并新增 `CHARACTER_MESSAGE_RENDERED` 视图刷新、
  `GENERATION_ENDED` 防抖落盘、`CHAT_CHANGED` 换作用域重载；冒烟新增 B2b（接线来源与聊天视图）共 **21 项**，
  文档 `docs/P2-宿主与存储.md` v1.1 记录全过程。本阶段未完成项（V1 数据导入器、快照链、跨端收敛与镜像同步、配置载入迁移校验）已列于 `docs/P2-宿主与存储.md` §5。
- **P1 内核平移（批次 5：迁移与条目层）**：新增 `core/migrate.js`（353 行：`migrateState` 结构健壮性清洗与多版本迁移链、
  `migratePlanSuspV1165`/`migrateRelLinks`、跨端内容去重 `contentPickBest`/`contentDedupeArray`、`recallDateNum`）与
  `core/entries.js`（347 行：`upsertEntry` 写入合并、`deleteEntry` 级联删除与 id 墓碑、`upsertRelLinks`、`sweepOrphanRelLinks`）；
  `runtime.js` 增 `getLastMessageId()` 注入钩子。**批次 3 的延后项全部回填**。
  黄金样本 6 改用**更忠实的 oracle：真实 V1 插件**（V1 测试桩加载 v1.206 直调导出函数）—— `migrate-entries-golden.test.js` **15 项断言**：
  脏数据迁移逐字符一致、迁移幂等、去重选优、条目增删与墓碑、关联写入与孤儿清扫。
  **行为发现（逐字保留，不顺手改）**：① `upsertEntry` 返回布尔；② V1 的内容哈希墓碑与原子 `h` 刷新在 **`saveState()` 流水线**里
  （**P2 宿主保存流程必须照此接线**，已在黄金样本与测试标注）；③ `upsertRelLinks` 非完全幂等（V1 亦为 `added=1/updated=2`）；
  ④ V1 桩环境楼层号 = 3（V2 用注入钩子对齐）。延后：`relMaintRun`（含 UI 统计，留维护层接线）。
- **P1 内核平移（批次 4：配置与时钟层）**：新增 `core/config.js`（1130 行：`defaultCfg` **217 键全量默认配置**、
  `PROMPT_TEMPLATES_V2` **33 条提示词模板**与 `PROMPT_DEFAULT_VERSION`、`PROMPT_GROUPS`/`PROMPT_LEGACY_SIGS`/破甲预设默认值、
  `CN_KEY_MAP`（174 项）与 `normalizeDeltaKeys`、`DIMENSIONS`/`DIM_LABELS`、`KIND_MAP` 14 维 get/set）与
  `core/clock.js`（225 行：剧情时钟族 —— 裁剪/解析/格式化/校验/公元前归一/中文数字/数值化时间戳）；`runtime.js` 增 `log()` 注入钩子。
  黄金样本 5（`tests/fixtures/v1-golden-config-clock.json`）**15 项断言**：配置整体逐字符相等 + 13 条日期样本贯穿时钟族。
  **工具缺陷修复**：① 括号配对提取遇正则/字符串花括号失衡 → 改「下一个顶层声明 + 顶层收尾行截断」；
  ② 截断误切函数内层 `}` → 改为顶层缩进匹配；③ **内核纯净度门禁误判配置键名**（`storage.localStorage`）→ 门禁剔除字符串字面量、
  排除对象键与属性访问，并用「临时植入真实宿主调用」反向自测确认仍能拦下。
- **许可确立（AGPL-3.0）**：新增仓库根 `LICENSE`（GNU 官方 AGPL-3.0 全文，逐字未改，**LF 换行、662 行 / 34,523 B，md5 `eb1e647870add0502f8f010b19de32af`**，与 gnu.org 官方 txt 一致）；
  `package.json` 增 `license: AGPL-3.0` 与 `author`；README §7 由「待确认」改为正式许可说明（含 §13 网络交互条款提示）。
- **门禁**：单元 **16 文件 221 断言全过**（`manifest.test.js` 新增许可一致性断言）；冒烟 **20/20**（含更新机制 E1–E8）；内核纯净度 **0 违规**（core/ 12 文件）；版本一致性 **通过**；文档规范 **0 违规**。
- **不与 V1 共存**：V1 与 V2 同装会重复注入，README 已提示；V1 数据不被本版读写（导入器在 P6）。
