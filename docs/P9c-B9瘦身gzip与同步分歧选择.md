# P9c · B9-d 条目瘦身 + gzip 存储 + 跨端同步分歧选择

> 文档版本：v1.0 ｜ 日期：2026-09-25 ｜ 状态：生效（v2.31.0 之后待发版）
> 关联：`core/slim.js`（新建）、`adapters/gzip.js`（新建）、`adapters/user-file.js`、`adapters/sync.js`、
> `adapters/store.js`、`ui/sync.js`、`index.js`、`devtools.js`、`core/config.js`、
> `tests/fixtures/gen-v1-golden-slim-gzip.cjs`、`tests/fixtures/gen-v1-golden-sync-pick.cjs`、
> `docs/P8i-B7-2跨端同步.md`、`docs/P8-功能对齐总表.md`
> 引用文件：`/home/ubuntu/st/STT记忆插件/src/FTT记忆组件-v1.206.js`（V1 仓库只读）

---

## 1. 覆盖范围（V1 v1.206 → V2 落点 → 语义）

| V1 能力 | V1 位置 | V2 落点 | 语义（V1 原样） |
| --- | --- | --- | --- |
| 瘦身字段白名单 / 同义字段组 | `SLIM_HASHED_FIELDS`(~5460)、`SLIM_SYNONYM_GROUPS`(~5476) | `core/slim.js#SLIM_HASHED_FIELDS` / `SLIM_SYNONYM_GROUPS` | 各维度参与内容哈希的字段（瘦身绝不删除）+ 同义字段组（组内只留哈希字段那一份，值全等才丢） |
| 单条瘦身 / 还原 | `isSlimDefault`(~5485)、`slimEntryForStorage`(~5492)、`hydrateSlimEntry`(~5530) | `core/slim.js#isSlimDefault` / `slimEntryForStorage` / `hydrateSlimEntry` | 不写空值与默认值（''/null/undefined/[]/0/false/{}）；`extra` 只保留「顶层没有或值不同」的槽位；`scenes.pathArr/pathStr` 专用比较；`.json` 脏 `name` 删除；还原时同义回填 + `name`/`title` 缺一补一 |
| 数据体瘦身 / 还原 | `slimDataForStorage`(~5554)、`hydrateStorageData`(~5574) | `core/slim.js#slimDataForStorage` / `hydrateStorageData` | 剥快照内容 → 只留 `snapIndex`，删 `snapStore`/`snapFp`；删与信封重复的 `scope`；`keepSnap:true`（备份口径）保留完整链 |
| 快照轻量索引 | `snapshotIndexFrom`(~5580) | `core/slim.js#snapshotIndexFrom`（复用 B7-2 已移植的 `core/cross-sync.js#snapIndexFrom`） | `id/kind/ts/baseId/hash/covered`；无 `id` 项过滤 |
| 快照链瘦身 / 还原 | `slimSnapshotStoreForStorage`(~5589)、`hydrateSnapshotStore`(~5611) | `core/slim.js#slimSnapshotStoreForStorage` / `hydrateSnapshotStore` | 链内 `atoms` 副本按 `atom.__cat` 逐条瘦身；保留 `atomsHashes`/`deleted` |
| gzip 原语 | `bytesToBase64`(~5616)、`base64ToBytes`(~5627)、`gzipToBase64`(~5635)、`gunzipFromBytes`(~5645) | `adapters/gzip.js` 同名函数（+ `textToBytes`/`bytesToText`/`isGzipBytes`/`decodeBytesAuto`/`gzipAvailable`） | 浏览器端压缩（约 1/4 体积）；无 `CompressionStream`/`Blob`/`Response` → 回退明文 |
| 写入侧自动 gzip | `filesUploadContent`(~5691) | `adapters/sync.js#uploadContentMaybeGz` + `writeStateFileContent` + `stateFileWrite` | 先 gzip 再 base64 写 `.json.gz`；失败/不支持 → 回退明文 `.json`；写后即最新（缓存原文） |
| 读取侧魔数识别 | `decodeFileBytes`(~6028)、`fileNames` 的双扩展名候选(~6032) | `adapters/user-file.js#readStateFileAuto`（`1f 8b` 判定 → gunzip，否则 UTF-8 解码）、`adapters/sync.js#stateFileReadCandidates` | 与扩展名无关：明文旧文件与 gzip 新文件都能读 |
| 主/备份/快照文件名 | `fileNameFor`(~5987)、`SLIM_EXT_GZ`(~5448) | `adapters/sync.js#stateFileGzName` / `snapshotFileGzName` / `bakGzName`（基名 + `.json.gz`） | 基名 + `.json.gz`（V2 前缀 `ftt2-`） |
| 信封瘦身 | `slimFileEnvelope`(~6200) | `adapters/sync.js#slimFileEnvelope` | 瘦身后**重算** `storageHash(payload)`（否则读取侧 `envValid` 会拒绝自己的文件） |
| 分歧待选 | `crossPendingGet`/`crossPendingClear`(~6931) | `adapters/sync.js#crossPendingGet` / `crossPendingClear`（模块级 `{env, info, at}`，与 V1 同形） | 自动对账遇「两端各有独有/冲突且无端是超集」→ **不静默合并**，暂存最后一份对端信封 |
| 整体替换（含并发防护） | `applyRemoteReplaceState`(~7005)、`adoptRemoteEnvelope`(~6995) | `adapters/sync.js#applyRemoteReplaceState` / `adoptRemoteEnvelope` | 本端正在写记忆（长任务在途）→ **降级为并集合并**（返回 `'merge'`）；并集合并也失败 → 放弃替换（`null`）；否则整体替换。替换时**保留本端删除墓碑**并按「并集墓碑」过滤采纳数据 |
| 分歧横幅 | `renderStorageStatus()` 尾部(~26490) | `ui/sync.js#divergenceBannerHtml`（进入存储页「状态与操作」节） | 标题「⚠️ 跨端同步分歧 · 请选择保留哪个版本」+ 统计行（本地/对端条数与更新时间、时间差、仅本端/仅对端/冲突）+ 两个按钮 |
| 分歧动作 | `syncPickLocal`(~26862) / `syncPickRemote`(~26882) | `ui/sync.js#syncAction`（`SYNC_ACTIONS` 6 → 8 项） | 保留本端 = `storageWriteAll`（本端覆盖对端）；采用对端 = `applyRemoteReplaceState` 整体替换后再写回；两者都写同步日志 `action='分歧选择'` 并提示 |
| 诊断入口 | `__FTT` 导出清单(~28095/~28051) | `index.js` hooks + `devtools.js`（全部 `hooks && typeof === 'function'` 守卫；本批共 24 个入口） | 瘦身/gzip 原语 14 个（含 `slimInfo`）+ 分歧处置与自动对账 10 个（`crossComputeInfo`/`crossPendingGet`/`crossPendingView`/`crossPendingClear`/`applyRemoteReplaceState`/`adoptRemoteEnvelope`/`crossPullPolicy`/`storageEnvelope`/`storageHash`/`storageEnvValid`） |

**默认安全（本批最重要的口径）**：V2 的两项写入改造由**显式开关**控制，`core/config.js` 的两项默认为 `false`：

| 开关 | 默认 | 关闭时行为 | 开启后行为 |
| --- | --- | --- | --- |
| `cfg.storage.stateFileSlim` | `false` | 写入前不瘦身（主文件保留完整 `snapStore`，与 B7-2 逐字节一致） | 写入前 `slimFileEnvelope`（剥快照 → `snapIndex` + 条目瘦身 + 重算哈希） |
| `cfg.storage.stateFileGzip` | `false` | 写明文 `.json`（请求名/内容/请求序列与 B7-2 完全一致） | 先 gzip 再 base64 写 `.json.gz`；通道不支持或压缩失败 → **自动回退明文 `.json`** |

**读取永远按内容魔数**（`1f 8b`）识别：开启/关闭可随时来回切换，已存在的明文旧文件始终可读；开启 gzip 后读取候选名为 `[<基名>.json.gz, <基名>.json]`（gz 优先 + 明文兜底），关闭时只读明文名（**不产生额外请求**）。

---

## 2. 与 V1 的差异（逐条明示）

1. **默认关闭而非恒开**：V1 恒「瘦身 + 先 gzip 再 base64」，V2 为显式开关且默认 `false`。理由：V2 存储设计此前有意选明文（`docs/P8i` §适配），默认开启会改变既有文件扩展名与读请求序列（并使既有单测/冒烟的文件桩失真）。**这是本批与 V1 最大的行为差异**：`cfg.storage.stateFileSlim = cfg.storage.stateFileGzip = true` 后才与 V1 同口径。
2. **备份文件在开关关闭时不瘦身**：V1 备份恒为 `slimFileEnvelope(env, true)`（保留完整链）；V2 在瘦身开关关闭时备份与主文件同为未瘦身的完整信封（保持 B7-2 行为），开启后备份按 V1 口径保留完整链。
3. **不清理被 gz 取代的明文旧文件**：V1 `cleanupSupersededPlain`(~5680) 会在 gz 写入成功后删除**本会话读过**的同名 `.json`；V2 **不删除任何文件**（避免用户切回明文开关后无文件可读，也避免误删对端数据）。副作用：同时存在 `.json` 与 `.json.gz` 时占双份空间（读取 gz 优先）。
4. **无「写入名历史」记忆**：V1 `fileNameRemember`/`fileNameKnownNames`(~6010) 把最近写过的名字记入 localStorage 以优化候选顺序；V2 用固定候选名（`[gz, json]`），未移植该缓存。
5. **分歧来源仅一处**：V1 的 pending 由 `crossPullPolicy(label, opts)` 写入，而该方法被「保存后镜像 / 消息活动 / 页面可见 / 首次打开聊天」等多条被动路径调用；V2 无多后端与这些被动触发器，**唯一**写入点是最接近的等价路径 `adapters/sync.js#runStorageSync`（保存后镜像）。`crossSyncManual`（用户点「立即同步」）与 V1 一致——分歧时仍「原子融合」处置，**不产生待选**。
6. **同步日志触发源标签不同**：V1 分歧日志 `action` 取触发源标签（如「自动对账」）；V2 固定为 `保存后镜像`。`mode`/`note`/条数口径与 V1 逐字一致（见 §4 oracle 比对）。
7. **无同步占用管线 UI**：V1 的 `syncBusy*`/顶部「同步中」/总览管线行在 V2 不存在（V2 无任务管线 UI），故两个分歧动作**不显示「同步中」**，也无占用互斥；`applyRemoteReplaceState` 的并发防护改用 V2 的「长任务在途」判定（`host/extract.js#extractBusy`，等价 V1 `userWriteInFlight` 的提取侧）。
8. **提示出口与文案包装**：V1 `toast(text, kind)` 单串提示；V2 统一走 `notifyHooks.toast(msg, kind)`（`msg = 标题 + 空格 + 文字`）。分歧警示 V2 拆为标题 `⚠️ 跨端记忆存在分歧` + 文字 `请到 设定 → 存储 选择保留哪个版本（已附更新时间/条目差异统计）` —— **字符与 V1 单串一致，仅多一个连接空格**；`syncPickLocal`/`syncPickRemote` 的提示标题与文字与 V1 逐字一致。
9. **横幅时间格式**：V1 用 `Date.prototype.toLocaleString()`（随环境/时区变化）；V2 用既有 `fmtTime`（`YYYY-MM-DD HH:mm:ss`），便于单测逐字断言。横幅标题、统计项名称与顺序、按钮 `class` 与文案**逐字一致**。
10. **失败路径不做 dbgLog**：V1 分歧暂存与「替换降级」写 `dbgLog('对账', …)`；V2 的自动同步路径统一用运行时 `log(...)`（V2 的 debug-log 由 `ui/debug.js` 在 UI 层接线），未额外引入 `core/debug-log.js` 依赖。
11. **面板 note 为 V2 适配**：V1 分歧动作只提示 + 重绘；V2 额外把结果写入 `panelState().note`（面板统一提示位），文案为 V1 提示文字的连接形式（如 `已保留本地版本 —— 本端将覆盖对端`）。
12. **gzip 能力探测经 `globalThis`**：`adapters/gzip.js` 以 `globalThis.CompressionStream` / `globalThis.DecompressionStream` 访问压缩流（满足 `scripts/check-core-refs.js` 的标识符门禁；行为不变，且在「宿主移除该全局」时同样回退明文）。

---

## 3. V1 原生行为与怪癖（oracle 实测，原样保留）

1. **`slimEntryForStorage` 对非对象原样返回**；同义字段组只在「组内出现 ≥2 个键」且值与保留键 JSON 全等时才删除（`scenes.pathStr` 用 `Array.join('>')` 专用比较）。
2. **`slimDataForStorage` 非 `keepSnap` 时不但删 `snapStore`/`snapFp`，还删除顶层 `scope`**（与信封重复）。V2 逐字保留（开启瘦身时同样删 `scope`；读取侧只用信封的 `payload.scope`，故无影响）。
3. **`snapshotIndexFrom` 过滤无 `id` 项**，`covered` 取 `atomsHashes` 键数。
4. **写入路径恒先试 gzip**（不看开关能力，靠 `gzipToBase64` 内部失败返回 `{ok:false}`）；只有 gzip 上传失败才回退明文。V2 保留该顺序（开关把「是否尝试」提前到调用方）。
5. **瘦身文件的哈希是对瘦身后 payload 重算的**（`slimFileEnvelope`），并非保留原哈希 —— 这是读取侧 `envValid` 能通过的原因。
6. **备份保留完整链**（`slimFileEnvelope(env, true)`），`bakSlim:true` 时才与主文件同（V2 用同义反义口径：`o.bakSlim === true` 时与主文件同）。
7. **分歧暂存只保留更新的一份对端信封**：已有 pending 且其 `updatedAt >= 新对端` 时只记一条「分歧(已暂存较新待选)」、不覆盖、**不重复提示**。
8. **两个分歧动作都先清空待选再执行**（V1 在异步 IIFE 之前 `crossPendingClear()`），失败也不恢复 pending。
9. **`syncPickLocal` 不重新读取对端**（只 `storageWriteAll` 本端覆盖）。
10. **`applyRemoteReplaceState` 的降级语义**：长任务/发送在途 → 并集合并（返回 `'merge'`，真值 → 提示按「已采用对端版本」呈现）；并集合并也失败 → `null`（不改动 + 「已放弃」警示）。
11. **分歧横幅两个按钮没有 `title` 属性**（V1 原文如此）——V2 同样不加 `title`（逐字对齐，不臆造）。
12. **`adoptRemoteEnvelope` 整体替换仍保留本端删除墓碑**并按并集墓碑过滤（防止「删掉的条目被对端旧全量带回来」）。

---

## 4. 验证

门禁（`npm run gate` 原始汇总行，本批收尾实跑）：

```text
内核纯净度检查：扫描 49 个文件（core/）
✅ 内核纯净度通过（0 违规）
标识符检查：扫描 93 个文件（core/ host/ adapters/ ui/ + 入口）
✅ 标识符门禁通过（0 未定义标识符）
词条门禁检查：2 种语言 · 54 条
✅ 词条门禁通过（键集一致 · JS 镜像与 JSON 同步）
✅ 版本一致性通过（2.31.0）
文档规范检查：43 个文件
✅ 文档规范通过（0 违规）
===== 单元测试汇总：59/59 个文件通过, 0 失败；断言 934 项 =====
========== V2 冒烟：130 通过, 0 失败 ==========
```

### 4.1 黄金样本（oracle = 真实 V1 插件 v1.206）

| fixture | 生成器（已入库） | 覆盖 |
| --- | --- | --- |
| `tests/fixtures/v1-golden-slim-gzip.json` | `tests/fixtures/gen-v1-golden-slim-gzip.cjs` | 瘦身/还原四域（`atoms`/`scenes`/`currentStates`/`rumors`）键集与逐字输出、`slimDataForStorage` 键集与 `snapIndex`、快照链瘦身/还原、gzip 往返（魔数/文本全等/`shrinkRatio`）、**写入路径**（桩 fetch 捕获 base64 → 解字节 → 名/魔数/结构）、**读取路径**（按魔数读回 + 还原）、明文旧文件读取、**压缩不可用时回退明文** |
| `tests/fixtures/v1-golden-sync-pick.json` | `tests/fixtures/gen-v1-golden-sync-pick.cjs` | `crossComputeInfo` 三态（divergence / replace-local / same）、自动对账分歧暂存（日志 mode/note/条数 + 提示文案）、已有更新待选不重复暂存、分歧横幅（标题/统计/按钮 class·文案·无 title）、`syncPickLocal`、`syncPickRemote`、无待选时点「采用对端」、`applyRemoteReplaceState` / `adoptRemoteEnvelope` |

两个生成器均按既定纪律：日志走 stderr（`loadPlugin` 之前覆写 `console.log`）、stdout 只输出 JSON、结尾 `process.exit(0)`、**连跑两次逐字节一致**（输出已剔除 `ts`/`ms`/`src` 等时间与环境派生值；横幅的更新时间归一为 `<t>`）。`syncPickLocal`/`syncPickRemote` 属 `handleAction` 的 case（未导出）→ 走 **真实点击委托**（`F.openPanel()` 后在 `panel.listeners.click` 派发伪事件）；分歧横幅由 V1 `renderStorageStatus()` 真实写入（mock document 的 `querySelector` 只对 `[data-ftt-storage-status]` 返回代理盒，V1 代码零改动）。

### 4.2 新增单元测试

| 文件 | 项数 | 内容 |
| --- | --- | --- |
| `tests/unit/slim-gzip-golden.test.js` | **17** | R1–R8 与 V1 逐项比对（含写入路径的主/备份/快照名与魔数、主文件仅留 `snapIndex`、备份保留完整链、读回还原）；B1–B5 **读写向后兼容**（明文旧文件可读 / gzip 新文件可读 / 压缩失败回退明文 / 默认关闭零变化 / 候选名切换）；V1–V4 V2 编排与接线（保存流水线 `saveStateNow` 写真 `.json.gz` 且 `loadFromServerFile` 可读回、存储页说明行、FTT 入口、devtools 无 hook 降级） |
| `tests/unit/sync-pick-golden.test.js` | **13** | R1–R10 与 V1 逐项比对（分歧判定三态、暂存不静默合并、不重复暂存、横幅逐字、两个动作的日志/提示/数据结果、无待选不改动、整体替换、**长任务在途降级为并集合并**）；V1–V4 V2 编排与接线（面板动作与 `SYNC_ACTIONS` 8 项、横幅仅在有 pending 时渲染、选后重新对账可收敛、FTT 入口与降级） |

### 4.3 冒烟（`tests/smoke-test.js`，位于 AG 之后、D 之前）

- `AH1`：`FTT.*` 入口齐备（24 个）+ 瘦身/索引/gzip 原语真实生效（`content` 同义丢弃、无 id 过滤、gzip 往返文本全等与魔数、默认关闭时写入名仍为明文名）。
- `AH2`：存储页如实呈现瘦身/gzip 开关与写入名（关闭/开启两态）；无待选时 `syncPickRemote` 经面板分发 → `r.state.note === '未找到待选对端（未改动本端）'` 且本端未改动、无横幅按钮。
- `AH3`：真实自动对账（`FTT.crossPullPolicy`，等价 V2 `runStorageSync`）遇分歧 → **暂存待选 + 横幅 + 不静默合并**；`syncPickLocal` 覆盖对端、`syncPickRemote` 整体替换，两者同步日志 mode/note 与 V1 一致。

### 4.4 既有测试的必要更新（逐条）

1. `tests/unit/sync-adapter.test.js`：`SYNC_ACTIONS.length` 6 → **8**（新增两个分歧动作）。
2. `tests/unit/config-clock-golden.test.js` C1：V1 键保真口径不变，新增**显式嵌套白名单** `storage.stateFileSlim` / `storage.stateFileGzip`（V2 专有开关，默认 `false`）——其余 V1 `storage` 键仍逐值一致。
3. 其余 57 个既有单测文件与冒烟**零改动**（开关默认关闭 → 读写路径与 B7-2 一致）。

---

## 5. 未实现 / 后续建议

1. **未新增设定页控件**：两个开关为内核 `cfg.storage.*` 键（默认值已在 `core/config.js` 注明），可在设定导入 JSON 中切换或用 `FTT.slimInfo()` 诊断后设置；**不做假控件**，也不与 V1 的控件数口径冲突。若后续要暴露 UI，建议在存储页「记忆文件」节加两个 `switchField`（需同步更新 `settings-pages.test.js` 的控件计数断言）。
2. **未移植 V1 的明文旧文件清理**（`cleanupSupersededPlain`）与**写入名历史缓存**（`fileNameRemember`/`fileNameKnownNames`）——见 §2 第 3/4 条。
3. **未实现 TauriTavern 原生存储通道**下的 gzip（V2 未移植该通道）；`adapters/gzip.js#gzipAvailable()` 在缺少压缩流时如实回退明文。
4. **`promptPreview` 核实结论（本批专项）**：V1 **没有** `promptPreview` 动作或函数 ——
   - `grep -c "promptPreview" src/FTT记忆组件-v1.206.js` → `0`（退出码 1，无匹配）；
   - `grep -rin "promptpreview" src/`（含 `modules/` 全部 18 个分片）→ 无输出；
   - v1.204 / v1.205 / v1.206 三个版本分别计数均为 `0`；`grep -on "promptPreview[A-Za-z]*"` 亦无输出；
   - V1 全部 `data-ftt-action` 值中**没有任何含 `preview`（忽略大小写）的动作**；含 `function …preview…` 的命名函数同样为 0。
   V2 的提示词/注入预览能力已由 B5 的「注入自查」（`ui/inject-check.js#injectCheckPanelHtml` / `injectCheckAction` / `injectCheckStats`，含约束段原样预览与未召回原因）覆盖，故在 `docs/P8-功能对齐总表.md` §6.1「V2 不适用」表新增一行说明「V1 无此动作」。
   注：`docs/P8i`、`docs/P8l`、`docs/P8m`、`docs/P8n`、`docs/P8p`、`docs/P8r`、`docs/P8t`、`docs/P8y`、`docs/P8z`、`docs/P9a` 的「后续批次」前瞻清单里仍把它写作 B9 待办项 —— 那是**历史留存文本**（各批交付时的当时口径），本批不做批量改写，以总表与本文档为最新结论。
5. **无法验证的假设**（如实交底）：
   - 真实酒馆服务端对 `.json.gz` 文件名的接受度未实测（V1 生产已验证同一命名与「先 gzip 再 base64」上传，V2 沿用同一端点与命名规则；V2 侧用字节精确桩覆盖）；
   - 真实浏览器与 Node 的 `CompressionStream('gzip')` 输出字节不必相同（gzip 头可能含不同元数据）——本批只断言「魔数/可解压/文本全等/体积显著下降」，**不做跨实现字节相等断言**；
   - gzip 开启时若用户把开关关回 `false`，读取侧不会探测 `.json.gz`（只读明文名）→ V1 文件仍在但不可见；这是开关语义的必然结果，已在 §1 注记（切换需重新开启开关，或手动重命名文件）。
