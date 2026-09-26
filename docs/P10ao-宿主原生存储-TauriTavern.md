# P10ao · 宿主原生存储（TauriTavern）与文件通道后端路由（v2.77.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.77.0）
> 触发（用户要求）：「当主体酒馆为 **TauriTavern** 时，**优化存储设计**，采用**官方认可的存储方式**进行存储，
>   确保**同步等机制满足条件**。」

---

## 1. 问题：TauriTavern 上没有可用的文件通道

V2 的记忆文件 / 备份 / 快照 / 清单 / 同步日志镜像此前**只有一条通道**：酒馆服务端用户目录文件
（`POST /api/files/upload` · `GET /user/files/<name>` · `POST /api/files/delete`）。

TauriTavern 是 SillyTavern 的 Tauri v2 原生移植（Rust 后端，无 Node 服务端），其提供的路由集合中
**没有** `/api/files/*`（`src/tauri/main/routes/*` 无 files 路由）。后果：

- 写入失败 → 记忆数据只能落在本机缓冲（localStorage / IndexedDB），换端即丢；
- 读取必然 404 → 启动对账、清单预判、快照并集、同步日志合并全部退化为「无对端」。

## 2. 官方认可的存储方式（事实源）

| 项 | 官方口径 | 出处 |
| --- | --- | --- |
| 入口唯一性 | 「如果某个能力属于宿主公开契约，优先以 `window.__TAURITAVERN__.api.*` 为唯一文档入口」 | [API 总览](https://tauritavern.github.io/api/) |
| 扩展持久化 | `window.__TAURITAVERN__.api.extension.store`：全局 KV JSON + Blob | `docs/API/Extension.md` |
| 就绪等待 | `await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__)` | `docs/API/README.md` |
| 通道选型 | 「建议**绝大多数情况下使用 KV JSON**」；「存**大型文件**时，需要时再用 Blob」 | `docs/API/Extension.md` |
| 命名规则 | namespace / table / key 仅 `[A-Za-z0-9_.-]`，非空，不以 `.` 开头 | `docs/API/Extension.md` |
| 落盘位置 | `data_root/_tauritavern/extension-store/<ns>/kv/<table>/<key>.json` 与 `.../blobs/<table>/<key>` | `docs/API/Extension.md` |
| ST 迁移建议 | 「SillyTavern **从未提供**标准的扩展数据持久化机制」→ 大数据应迁到 `store.*` | `docs/API/Migration.md` |
| **官方同步** | 同步数据集 `extensions.store` = 目录 `_tauritavern/extension-store`，属 **TT-Sync / LAN Sync 默认范围** | `ttsync-core` `dataset/catalog.rs`、`dataset/profile.rs#TAURI_TAVERN_DEFAULT_DATASETS` |

**同步闭环结论**：宿主原生存储目录本身就在官方同步的默认数据集里，且「每个文件原子发布 + 保留修改时间，
增量判断依赖文件大小与修改时间」——因此**每个 key 一个文件**的写入天然满足增量同步条件。

## 3. 实现（新增两个适配层模块）

### 3.1 `adapters/tt-store.js` —— 官方契约适配

```text
写入选型：载荷 < 96KB（清单 meta / 同步日志 log）→ store.setJson({namespace,table,key,value:{k:'b64',v,ts}})
          载荷 ≥ 96KB（记忆文件 / -bak / 快照）    → store.setBlob({namespace,table,key,data:Uint8Array})
读取顺序：写入通道 → 另一通道 → 未命中（交由上层回退文件通道）
```

- **命名空间** `ftt2-files`（官方规则内；与 V1 的 `ftt-files` 并存不冲突，后者作为**只读**迁移入口）；
- **表** `main`（官方默认表，落盘路径与 V1 一致，便于人工核对与迁移）；
- **Blob 直传字节**：官方 `setBlob` 接受 `Uint8Array`，省掉 base64 膨胀（+33%）与 JSON 转义/格式化算力；
- **未命中不惊动宿主**（V1 v1.156 实测缺陷的结构性规避）：
  - KV：**只信 `tryGetJson` 的 `found`**，`found:false` 后绝不再追问 `getJson`（宿主会对缺失键抛错并打印 Not found）；
  - Blob：官方没有 `tryGetBlob`，故先用 `listBlobKeys` 判存在（3s 列表缓存、写入/删除即失效），
    `ttBlobGet` 内部也先过存在性判定 → 缺失键**不会**调用 `getBlob`；
  - 负缓存 30s：同一 key 短期内不再重复探测；写入/删除后立即撤销；
- **能力降级**：宿主未提供 Blob 方法 → 自动退回 KV（能力探测，不做配置开关）；单通道写失败 →
  在原生存储内的另一通道降级（KV ⇄ Blob），**绝不写坏/丢数据**。

### 3.2 `adapters/file-transport.js` —— 文件通道后端路由

五类载荷（记忆文件 / `-bak` / 快照 / 清单 / 同步日志镜像）统一经此入口，后端自动识别切换：

| 场景 | 行为 |
| --- | --- |
| 未检测到 TauriTavern | **零行为变化**：直接返回 `adapters/user-file.js` 的同一 Promise（不多一层 await、不多一次请求） |
| 检测到（`auto`，默认） | 写：原生优先；`tauriMirror` 开启时额外镜像写一份酒馆文件；失败自动回退酒馆文件 |
| 读 | 原生优先 → 未命中回退酒馆文件（旧数据迁移）；按 key 记住命中的后端，避免反复探测 |
| 删 | **两个后端都删**（避免「删了又被另一通道唤醒」） |
| `cfg.storage.tauriNative = on` | 无宿主 / API 未就绪时不激活，写入回退文件通道（不丢数据） |
| `cfg.storage.tauriNative = off` | 始终用酒馆用户目录文件（即便检测到宿主） |
| 探测噪声抑制 | 原生已接管且文件通道 404/鉴权失败 → **本会话停用回退**，不再无谓请求 |

## 4. 界面与诊断

- 设定 → 存储新增「存储通道（自动识别宿主）」分区：只读状态行（当前通道 + 已写/命中读/未命中计数）
  + 折叠「通道详情」（命名空间 / 写入分布 / 未命中抑制 / 最近错误）+ 两个开关（后端选择、镜像写文件）。
- 调试包新增 `env.storageChannel`（后端、路由数、文件通道是否停用及原因、最近一次写入），排障时先看它。
- 控制台/命令入口：`FTT.fileChannel()`、`FTT.fileChannelKeys()`、`FTT.ttChannel()`、`FTT.ttMissStats()`、
  `FTT.ttStoreOverview()`、`FTT.fileChannelDropCache()`。

## 5. 验证

| 证据 | 结果 |
| --- | --- |
| `tests/unit/tt-store.test.js`（官方契约：KV/Blob 选型、未命中不追问、负缓存、幂等删除、形状兼容、超时、旧命名空间、诊断） | 46 通过 / 0 失败 |
| `tests/unit/file-transport.test.js`（无宿主零变化、自动切换、off/on、镜像、失败回退、双端删除、读路由、探测停用、页面接线） | 28 通过 / 0 失败 |
| 既有通道回归（`sync-adapter` / `store-chat` / `slim-gzip-golden` / `sync-pick-golden` / `v1-importer`） | 全部通过（无宿主路径逐字节不变） |

## 6. 边界与未验证项

- 真机验证：本仓库测试以**官方契约桩**覆盖（含宿主「缺失键抛 Not found」的行为），未在真实 TauriTavern
  桌面上做端到端人工验证；如需，可用 `FTT.fileChannelKeys()` 与 `FTT.ttStoreOverview()` 核对落盘键。
- 官方 `Blob` 与 KV 的同步粒度：两者都落在 `_tauritavern/extension-store` 下，均属 `extensions.store` 数据集；
  若用户的同步范围**未勾选**该项，则原生存储的数据不参与同步（与勾选 `user.files` 与否同理）。
