# FTT记忆组件 V2（SillyTavern 原生扩展）

> 文档版本：v2.1.0 ｜ 日期：2026-09-24 ｜ 状态：**可用版本 v2.1.0**（P0–P7：内核/存储/注入/提取/UI 全链路 + 弹窗主界面）
> 定位：V1（酒馆助手 iframe 脚本）的原生重写版 —— 标准 SillyTavern 扩展，无酒馆助手运行时依赖、无构建产物。
> 设计与迁移依据：V1 仓库 `docs/13-V2原生插件总体设计.md`、`docs/14-V2模块与功能迁移对照.md`。

## 1. 它是什么

把 V1 的长期记忆能力（**14 类记忆维度**、三层提取、预算注入、修复与遗忘、剧情时钟、关联层、传言、情节与分段总结）
搬到 **SillyTavern 原生扩展**形态：**安装即用、随 ST 更新、源码即发布物（无构建、无依赖）**。

v2.0.0 已可用：生成前**记忆注入**（永不 abort、不改 chat）→ 生成后**自动提取**（AI 返回 JSON 增量，按 V1 口径落库并记台账）
→ **设定面板**（内核配置 / 只读状态 / 动作按钮）→ **数据台**（14 维浏览·搜索·编辑·删除·注入自查）
→ **V1 数据导入**（干跑差异报告，写入不删源）→ **更新检查**（GitHub 仓库，首次启动自动 + 设置内手动）。
保真度由 **13 份黄金样本**（oracle = 真实 V1 插件，逐字符比对）与五道门禁（内核纯净度 / 内核标识符 / 词条 / 版本一致性 / 文档）强制。
各阶段文档见 `docs/P0…P6`；发布终检清单与**未完成边界**见 `docs/P6-发布与终检.md`。

## 2. 安装与使用

> 仓库地址（唯一）：`https://github.com/fotomxq/stt-memory-plugin-v2`；默认分支 `main`，首个可用版本 `v2.0.0`；当前最新 `v2.0.2`（面板可见性修复 + 自愈诊断 + 悬浮兜底入口）。

### 安装（源码即发布物：无构建、无依赖）

1. **ST 界面安装**：扩展 → 安装扩展 → 填仓库地址（或指定标签 `v2.0.0`）；
2. **手动安装**：把仓库目录放到 `SillyTavern/data/<user>/extensions/stt-memory-plugin-v2/`；
3. 在扩展列表启用「FTT记忆组件 V2」后即可用，无需任何构建步骤。

> 与 V1 不可同时启用：两者都会向提示词注入记忆，同时开启会重复注入。
>
> **找不到面板？** 面板在**扩展设置抽屉**里，标题为「FTT记忆组件 V2」（可点开的折叠抽屉）。
> v2.0.1 起可用 `/ftt` 与 `/ftt-panel` 自查（报告面板容器命中情况与失败原因），魔杖菜单里也有「FTT记忆组件」入口；
> v2.0.2 起若抽屉容器全不存在，会自动显示右下角悬浮「FTT」按钮（点击以弹窗打开面板）。
> 详见 `docs/排障-面板不显示.md`。

### 界面（v2.1.0 起：弹窗优先，对齐 V1）

| 入口 | 打开 |
| --- | --- |
| 扩展魔杖菜单「FTT记忆组件」 | **弹窗主界面**（总览 / 数据台 / 提取 / 设置 四个分页） |
| `/ftt-ui [overview\|console\|extract\|settings]` | 同上，可指定分页 |
| 右下角悬浮「FTT」按钮 | 扩展菜单入口不可用时出现，打开同一个弹窗 |
| `/ftt-panel` | 排障：报告面板容器候选命中情况并强制挂载抽屉卡片（`cfg.uiShowDrawer` 默认关闭） |

> 抽屉卡片默认**不再显示**（`cfg.uiShowDrawer=false`）；需要时在「设置」分页打开。

### 使用（默认即处于可用状态）

| 场景 | 行为 |
| --- | --- |
| 打开聊天 | `APP_READY` 装配：能力探测 → 载入本角色记忆容器（本机缓冲 → 服务端文件 → 空容器）→ 挂设置面板 → 建索引基线 |
| 每次生成前 | 发送前刷新**记忆注入**（结构头 + 记忆正文 + 使用说明 + `记忆结束。`），**永不 abort、不改 chat** |
| 每次生成后 | 自动**提取**最后一个未分析楼层 → AI 返回 JSON 增量 → 按 V1 口径落库 → 台账记账 → 落盘（可在面板关闭） |
| 配置 | 扩展设置抽屉：内核配置（注入开关 / 预算 / 条数上限 / 自动提取 / **14 维启用**）、状态块、动作按钮、更新、**数据台** |
| 数据台 | 14 维浏览 / 搜索 / 查看与编辑 / 删除（留 id + 内容哈希双墓碑）/ **注入自查**（哪些条目真的进了注入） |
| V1 数据 | `/ftt-import` 干跑差异报告 → `apply` 写入（append-only，**不删除 V1 源数据**） |
| 命令 | `/ftt` 状态；`/ftt-analyze [楼号\|list]` 提取；`/ftt-import [apply]` 导入 |
| 更新 | 首次启动自动检查（GitHub）+ 设置内手动检查；「立即更新」调用 ST 原生更新端点 |

## 3. 命令与宏

| 入口 | 说明 |
| --- | --- |
| `/ftt` | 输出状态：版本 / 宿主连接 / 能力探测 / 事件绑定 / 拦截器统计 |
| `{{fttVersion}}` | 版本号 |
| `{{fttStatus}}` | 状态文本 |
| 控制台 `FTT` | 调试导出：`FTT.snapshot()` / `FTT.probe()` / `FTT.interceptor()` / `FTT.injectLength()` |

## 4. 更新检查（Git 通道）

| 时机 | 行为 |
| --- | --- |
| **首次启动** | 自动检查一次（判定通道：ST 原生 `POST /api/extensions/version`；不可用时回退远端 `manifest.json` + `CHANGELOG.md`） |
| 后续启动 | 距上次检查 ≥ 24h 才自动检查（可关：设置项「启动时自动检查更新」） |
| 设置内「🔍 检查更新」 | 手动检查（不受开关/间隔限制），结果落盘并在状态行显示 |
| 设置内「⬆ 立即更新（ST）」 | 代为调用 ST 更新端点执行 `git pull`（**仅用户点击**） |
| `/ftt`、`FTT.update()` | 查看更新配置、最近检查结果与状态文案 |

默认检查地址 = **本项目的 GitHub 仓库**（设置内可改）：`https://github.com/fotomxq/stt-memory-plugin-v2`（分支 `main`）。
失败一律静默（不阻塞启动/发送/提取）；扩展**不下载、不写入、不执行远端代码** —— 拉取代码只由 ST 或用户手工完成。
详见 `docs/更新检查机制.md`。

## 5. 开发

```bash
npm run gate     # 全部门禁（内核纯净度 + 版本一致性 + 单元 + 冒烟）
npm test         # 单元测试
npm run smoke    # 冒烟测试
node scripts/check-docs.js   # 文档规范
```

### 5.1 分层与依赖方向

```text
ui/ ─► host/ ─► adapters/ ─► core/
ui/ ──────────────────────► core/          （只读内核）
core/ ◄─ 禁止 import host/ adapters/ ui/    （由 scripts/check-core-purity.js 强制）
```

| 层 | 职责 | 关键文件 |
| --- | --- | --- |
| `core/` | 纯逻辑：常量、工具、数据模型、算法、提示词（无 DOM / 无宿主） | `constants.js`、`util.js`、`model/`（runtime / scalars / atom / dims / hash / snapshot / money / segment / rel / rumor）+ `state.js` / `merge.js` / `config.js`（217 键默认配置 + 33 条提示词模板）/ `clock.js`（剧情时钟族）/ `migrate.js`（结构迁移 + 跨端去重）/ `entries.js`（条目增删 + 关联写入）/ `recall.js`（排序 / 评分 / 在场 / 注入体 / 约束段）—— 自 V1 逐字移植，**黄金样本强校验** |
| `host/` | 宿主适配：上下文探测、事件、注入、生成前钩子、AI 调用 | `st-api.js`、`events.js`、`inject.js`、`interceptor.js`、`generation.js` |
| `adapters/` | 存储适配：配置 / 会话元数据 / 文件 / 本机缓冲 | `settings.js` |
| `ui/` | 界面：设置抽屉、命令与宏、数据台（P4） | `settings-panel.js`、`commands.js` |

### 5.2 内核移植与保真度

`core/model/*` 由 V1 源码**逐段提取**生成（算法、字段名、字段顺序完全一致），并由
`tests/unit/model-golden.test.js` 用 **V1 源码切片产出的黄金样本**（`tests/fixtures/v1-golden.json`）做**逐字符**比对 ——
覆盖**全部 14 类维度**归一化（情节 / 状态 / 档案 / 记忆 / 物品 / 计划 / 悬念 / 场景 / 概念 / 平行 / 货币 / 分段 / 关联层 / 传言）
+ 内容哈希 + 年龄与出生日期族 + 标量助手 + 状态容器与删除墓碑/隐藏保护 + 全量配置与时钟族 + 结构迁移与条目增删 + 召回与注入体 + 墓碑清扫与存储信封，共 **116 项断言**
（批次 1：15、批次 2：23、批次 2b：16、批次 3：12、批次 4：15、批次 5：15、批次 6：12、批次 7：8）。
**内核移植已全部完成**（`core/` 21 个文件），后续为宿主层接线与 P2–P6。
其中批次 5 的黄金样本改由**真实 V1 插件**（测试桩加载 v1.206）产出，比源码切片更忠实。
口径与后续批次见 `docs/P1-内核平移.md`；宿主接线见 `docs/P2-宿主与存储.md`。

### 5.2b 宿主接线（P2 首批）

`host/chat.js` 把 ST 聊天只读地映射进内核注入视图（消息数组 / 最新 AI 正文 / 最后楼层号 / 角色稳定键），
`adapters/store.js` 复刻 V1 的保存流水线（**索引初始化 → 原子 `h` 刷新 → 内容哈希墓碑 → 信封 → 三级后端**，
含哈希校验载入与防抖保存），`adapters/user-file.js` 走 ST 原生 `/api/files/*` 通道（`ftt2-state-*.json`，与 V1 文件并存）。
本层由 `tests/unit/store-chat.test.js`（13 项）与 `tests/unit/sweep-envelope-golden.test.js`（8 项）覆盖；
入口侧 `index.js` 在 `APP_READY` 后执行 `loadMemoryState()`（本机缓冲 → 服务端文件 → 空容器 → 迁移 → 注入内核），
并接 `CHARACTER_MESSAGE_RENDERED`（刷新视图）、`GENERATION_ENDED`（防抖落盘）、`CHAT_CHANGED`（换作用域重载）。
**V1 数据导入器**（`adapters/import-v1.js`）以只读方式发现 V1 数据（服务端 `ftt-state-*` 主文件/备份、旧 settings 信封、本机命名缓存），
产出逐维度差异报告（`/ftt-import`，默认干跑），`apply` 时按 id **append-only** 合并（同 id 以当前为准、墓碑并集）后走保存流水线，
**绝不删除 V1 源数据**；命名/作用域派生与 V1 oracle 逐字符对齐（黄金样本 9）。
尚未完成的快照链 / 跨端同步 / V1 配置迁移见 `docs/P2-宿主与存储.md` §7。

**P3 首批（记忆注入闭环）**：`adapters/config-store.js` 把 `core/config.js` 的 217 键默认配置与 ST 配置容器双向同步
（已存值优先、未知键保留、`stableStringify` 判定写盘），`host/inject.js` 复刻 V1 的注入包装与推送
（开关 / 序号并发防护 / **空构建保留上次注入** / clearInject 重置），生成前拦截器在记录统计后刷新注入且**永不 abort、不改 chat**。
详见 `docs/P3-注入闭环.md`。

**P3 次批（提取落库内核 + 内核完整性）**：`core/ingest.js` 移植 V1 的 `mergeDelta`（13 类维度 add/update/remove/close
按 V1 顺序落库，含「已总结隐藏情节不接受 AI 改写」「情节就地更新保留 uses 与因果 log」「同名物品只更新」等口径），
黄金样本 10 用真实 V1 插件逐字符比对。新增门禁 `scripts/check-core-refs.js`（内核未定义标识符静态检查）——
它一次揪出 7 处「被 `catch` 吞掉的 `ReferenceError`」类**静默数据丢失**缺陷（已全部补全），并把宿主耦合改为
注入视图（`notifyHooks` / `identityView` / `timerHooks`，内核不碰全局定时器与弹窗）。另修正保存流水线的**索引基线**
语义（`primeStateIndex()` 只在载入后建立一次，否则删除永远不写墓碑）。详见 `docs/P3b-提取落库与内核完整性.md`。

**P4 首批（提取编排，闭环打通）**：`core/prompt.js` 移植 V1 `buildSummaryPrompt`（含维度说明 / 已有条目索引 /
货币账本 / 世界书参考 / 投喂正则），黄金样本 11 与真实 V1 插件**逐字符一致**；`host/floors.js` 复刻楼层取文与判据
（稳定首刷哈希、当前刷正文、占位/隐藏楼排除、投喂正则）与「已分析楼层」台账（`state.processedFloors` +
版本签名 `v1.174:11n8nlu`，与 V1 存档兼容）；`host/extract.js` 串起
**取文 → 提示词 → AI → JSON → `mergeDelta` → 台账 → 落盘**，并提供 `/ftt-analyze`、`FTT.analyze`、
`GENERATION_ENDED` 自动提取（受 `cfg.autoExtract` 保护）与忙碌互斥；六类失败姿态一律不抛出、不写台账、不影响聊天。
详见 `docs/P4-提取编排.md`。

**P5 首批（设定面板）**：`settings.html` + `ui/settings-panel.js` 提供内核配置控件（注入开关/预算/条数上限/自动提取/
**14 维启用勾选**）、只读状态块（版本·作用域·内核配置键数·注入字数·提取统计·待分析楼层·存储来源）与动作按钮
（分析未分析楼层 / 待分析清单 / 清空注入 / V1 导入干跑与写入）。面板改动经**唯一写入口** `applyPanelCfg` 落到内核视图并
经 `saveKernelCfg` 持久化到 ST 配置，读取侧一律取 `cfg.*`（不存在两套配置分叉）；模板不可用时回退 HTML 同样包含这些控件。
详见 `docs/P5-设定面板.md`。

**P5 次批（数据台）**：`ui/console.js` 提供 14 维浏览、搜索（id/标题/正文/归属/标签/关键词）、条目查看与编辑
（标题·正文·日期·标签·重要度，附关联行与内容哈希）、删除（**留 id + 内容哈希双墓碑**）与**注入自查**
（逐条判定是否进入当前注入，给出命中/未命中合计）；渲染与动作分离（`consoleHtml` / `consoleAction` / `bindConsole`），
无 `querySelectorAll` 的环境可直接调动作入口，故逻辑可完整测。详见 `docs/P5b-数据台.md`。

改动内核算法时：先更新黄金样本，再让 V2 对齐（避免 V1/V2 算法悄悄分叉）。

### 5.3 硬规则

- 生成前拦截器（`generate_interceptor`）**永不调用 `abort`**：任何失败都必须放行，保证消息发得出去；
- 内核纯净：`core/` 只接受显式入参、返回结果，不读写宿主与全局；
- 删除必须留墓碑、聚合/总结类保留原文（沿用 V1 v1.203–v1.206 的数据安全口径）；
- 版本三处一致（`manifest.json` / `package.json` / `core/constants.js`）由门禁强制。

## 6. 目录

```text
.
├── manifest.json          # ST 扩展清单（generate_interceptor / hooks / i18n / auto_update）
├── index.js               # 入口：装配 + 生命周期钩子导出
├── settings.html          # 扩展设置抽屉模板（Handlebars）
├── style.css              # 面板样式（继承 ST 主题变量）
├── core/                  # 纯内核（零宿主依赖）
│   └── model/             # 数据模型：V1 逐字移植 + tests/fixtures/v1-golden.json 保真度门禁
├── host/                  # 宿主适配层
├── adapters/              # 存储适配层
├── ui/                    # 界面层（settings-panel 设定面板 / console 数据台 / commands 命令与宏）
├── devtools.js            # window.FTT 调试导出
├── i18n/                  # zh-cn / en 词条（JSON 给 ST 扫描 + JS 镜像给运行时，门禁强制同步）
├── tests/                 # 宿主桩 + 单元 + 冒烟
├── scripts/               # 门禁脚本（内核纯净度 / 内核标识符 / 版本一致性 / 文档规范）
└── docs/                  # P0 探针报告 / 更新检查 / P1 内核平移 / P2 宿主与存储 / P3 注入闭环 / P3b 提取落库 / P4 提取编排 / P5 设定面板 / P5b 数据台 / P6 发布与终检 / P7 弹窗主界面 / 排障-面板不显示
```

## 7. 许可

**GNU Affero General Public License v3.0（AGPL-3.0）** —— 见仓库根目录 `LICENSE`（GNU 官方文本，逐字未改）。

- 版权：Copyright (C) 2026 fotomxq
- 选它的原因：本扩展是**网络服务型软件**（随 SillyTavern 服务端向用户提供功能），AGPL-3.0 的第 13 条
  「远程网络交互」正好覆盖这一场景，符合官方内容库对开源 libre 许可的要求；
- 使用/修改/再分发：遵守 AGPL-3.0 全文即可；**修改后对外提供服务时，须按 §13 向使用者提供对应源码**；
- 本仓库内的 `LICENSE` 为许可原文，**不得修改**；如需在其它作品中引用本扩展，请保留版权与许可声明。
