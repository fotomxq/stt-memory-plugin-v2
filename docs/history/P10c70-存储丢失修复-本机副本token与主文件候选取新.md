# P10c70 · 修复存储丢失：本机副本作用域 token 写读不一致 + 服务端主文件读回旧明文（v3.40.2）

> 文档版本：v1.0 ｜ 日期：2026-10-10 ｜ 状态：生效（v3.40.2）
> 用户报告（原话）：「新版本3.40.2 1. 修复存储丢失的异常BUG，该BUG在刷新应用后触发，大量当前早已分析的内容全部丢失，但保留了早期数据。可能与加载顺序有关，或在启用本地存储路径后，没有正确读取到数据」
> 关联：`adapters/local-disk.js` · `adapters/store.js` · `index.js#loadFromLocalDisk` · `docs/D16` §3 第 9 条（L9 的**结论更正**见 §5）· `docs/D10` §1.2

## 1. 现象与判读

刷新应用后，**当前**已分析的内容大面积消失，但**早期**数据还在 —— 典型的「载入读回了旧副本」：读回来的不是「没有数据」，而是**某个更早时刻的快照**。用户给出的两个方向（加载顺序 / 启用本地存储路径后读不到数据）**都命中**，对应两条独立根因。

## 2. 根因① 本机副本的**作用域 token 写读不一致**（主因）

| 侧 | 取值 | 落点 |
| --- | --- | --- |
| **写** | `core/state.js#scopeId()` = `char:<hash(scopeKey)>` | `adapters/store.js` 保存流水线（单文件 + 结构化分片 + 快照分片） |
| **读** | `getScopeKey()` = 宿主注入的 `char:<hash>` | `index.js#loadFromLocalDisk` |

`scopeId()` 是对 `getScopeKey()` 的**二次哈希** —— 两串**永不相等**，于是本机副本**写得进、读不回**：

* 单文件：写 `ftt2-local-char_<hash₂>.json`，读 `ftt2-local-char_<hash₁>.json`；
* 结构化分片：写 `<目录>/scopeSlug(scopeId())/`，读 `<目录>/scopeSlug(getScopeKey())/`。

该缺陷自 **v3.28.0 引入「本地磁盘目录」起就存在**（写读两侧的 `.replace(...)` 各写了一遍，且从未被单测覆盖 —— 既有 `local-disk` 单测只用**显式文件名**调 `localDiskWrite` / `localDiskRead`，从没有过「经保存流水线写、经载入读」的往返用例）。

**真机证据（本次以单测固化）**：`localDiskInfo().stats` 呈 **`writes:3 / reads:0`** —— 写了 3 次、读了 **0** 次。

## 3. 复盘：`docs/D16` L9 的结论更正

`docs/D16` §3 第 9 条（「本机层『配了却读不到』」）的真机取证是「磁盘层**写 67 次全部成功**、文件确实在（单文件 5.55 MB），但**载入期 3 次未命中**」，并判读为「**载入期的读发生得太早**（OPFS / 句柄尚未就绪那一次）」。

按本版证据，这个判读是**不完整的**：「3 次未命中」不是偶发，而是 **3 次载入、100% 读不到**（文件名对不上，读多少次都一样）。v3.40.0 据此只加了两件事 —— ① 首次未命中**重试一次**；② 把「纯未命中」从 error 级降为 info 级、**不标记路径无效**。

* ① 对**真·读得太早**是有效防护（保留，不回退）；
* ② 让**每次刷新都能看到的那条 error 消失**了 —— 副作用是**把真因也一起藏了起来**（日志不再提示「本机层读不到」，用户与排查都失去了线索）。

本版按「**先修真因、再保留分级**」收口：读侧改用与写侧同源的 token（根因消失），同时**保留** L9 的重试与分级口径。

## 4. 根因② 服务端主文件**候选顺序与写侧相反**

`loadFromServerFile` 固定「先读明文 `.json`，读不到才试 `.json.gz`」：

```text
读：stateFileName()  →（失败且 gzip 开启）→ stateFileGzName()
写：stateFileWriteName() = gzip 开启时 → stateFileGzName()   // 只写 .gz！
```

* gzip **开启**后，新数据只进 `.json.gz`；盘上遗留的**旧明文**从此不再更新 —— 而**读侧永远先看明文**，明文读得到就**根本不会去看 `.gz`** → 每次刷新都回到早期那份；
* 这与 `adapters/sync.js#stateFileReadCandidates()` **自述**的候选顺序（「gzip 开启时 gz 优先 + 明文兜底」）以及 `stateFileReadAny` 的既有实现**自相矛盾** —— 同仓库里两个读取入口，只有 `loadFromServerFile` 是反的。

## 5. 修复

| # | 落点 | 改动 |
| --- | --- | --- |
| ① | `adapters/local-disk.js` | 新增 **`localScopeToken()`**（= `scopeId()`，写读唯一来源）与 **`localCopyFileName(scope)`**（单文件名的唯一来源）；导出 `LOCAL_COPY_PREFIX` |
| ② | `adapters/store.js`（写侧） | 单文件 / 快照分片 / 结构化分片三处改用 `localCopyFileName(localScopeToken())` / `localScopeToken()` |
| ③ | `index.js`（读侧） | `loadFromLocalDisk` 改用同一 token 与同一文件名函数；分片与快照分片同 token |
| ④ | `index.js#findLocalCopyByScope` | **按内容作用域找回**（只读兜底）：单文件与分片都未命中时，在同目录列出 `ftt2-local-*.json`，按信封 `payload.scope` 与本角色**精确相等**认领（同时容忍历史口径 `char:<hash>` 形态）；多份取 `payload.updatedAt` 最新；**信封哈希校验不放宽**（不通过的一律不用）；读取量封顶 8 个文件 |
| ⑤ | `adapters/store.js#loadFromServerFile` | 按 `stateFileReadCandidates()` 把候选**读全**，再按信封 `payload.updatedAt` **取最新**；多份并存时写一条对账日志（可核对「是不是读回了旧明文」） |
| ⑥ | `adapters/local-disk.js#localDiskList` | 补 **dev-api 分支**（`api.dev.<ns>` 形态的宿主下列目录此前**恒失败**，而找回兜底正依赖它）；与 `diskWriteText` / `diskReadText` 的 dev-api 路由同口径 |

**为什么读侧向写侧对齐（而不是相反）**：盘上既有数据就是写侧写出来的（真机取证见 `adapters/local-file.js` 注释里的实际落盘键名 `ftt2-local_…-char_<hash>.json`），把读侧对齐到写侧=**立刻能读回存量数据**；反过来改写侧则会让既有文件继续读不回来。

**默认零行为变化**：gzip 关闭（默认）时 `stateFileReadCandidates()` 只有明文一个候选 → 请求序列与 B7-2 **逐字节一致**（单测 GZ-3 锁定，`slim-gzip-golden` B2 的既有口径亦不动）。

## 6. 测试与门禁

* 新增 `tests/unit/storage-loss-3402.test.js`（**13 项**）：
  * 本机副本：**写读同源**（真实 `saveStateNow` → `loadFromLocalDisk` 往返）/ 落盘名与读侧候选名**逐字符相同** / 单文件删掉后由**结构化分片**读回 / **口径漂移按内容找回**（含异角色诱饵必须被忽略）/ 哈希不符仍拒绝 / 墓碑账本随副本往返 / 目录关闭时如实返回 null；
  * 服务端主文件：gzip 开启 + **旧明文**不得压住新 gz / 压缩不可用回退明文仍可读 / **默认口径请求序列不变** / `stateFileReadAny` 与 `stateFileWriteName` 口径一致；
* **反向验证（先看它红）**：把 `index.js` 与 `adapters/store.js` 的改动**临时回退**（即回退修复 ②③④⑤，只留 `local-disk.js` 的新函数以便用例能加载）后重跑 → 该文件 **6 项失败**，其中 RG-3 直接打印 `{"writes":3,"reads":0,…}`（本机层只写不读）；恢复修复后 13/13 全绿；
* 全量：**170 文件 / 2608 断言** + 冒烟 **223 项**；静态门禁（含 `docs-facts` / `ui-spec`）全绿；`docs/README.md` §3 与 `docs/05-开发指南.md` §2 的计数同提交更新。

## 7. 未做（如实登记）

| 项 | 说明 |
| --- | --- |
| `docs/D10` §1.2 **`R3` / `R4`**（合并后上限裁剪 · id 墓碑误伤） | **不在本版** —— 归 `docs/D21` `技-4`（`R4` 属**数据契约**，须先裁决 `docs/D21` Q3） |
| `R5`（原生通道与文件通道并存） | 同上，归 `技-4`；本版未动通道选择顺序 |
| 真机复核 | 需用户刷新后经调试接口核对：`ftt.localDir.disk` 的 `reads` 应随载入增长、调试日志应出现「本机层：按内容作用域找回本机副本」或不再出现「本机层未命中」 |
