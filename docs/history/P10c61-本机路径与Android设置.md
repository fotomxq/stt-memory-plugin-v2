# P10c61 · 「本地存储路径」改**设备本地**（不随服务端转移）+ 修复 Android 上设不了（v3.33.0）

> 文档版本：v1.0 ｜ 日期：2026-10-07 ｜ 状态：生效（v3.33.0）
> 用户要求（原话）：「新版本 修复本地存储路径设置，无法设置android。其次本地存储路径不能随服务端转移，因为不同端的存储路径可能有差异。」
> 关联：`adapters/device-local.js`（新）· `adapters/config-store.js`（设备本地键）· `adapters/local-disk.js`（平台 / 路径告警 / 候选目录 / 多机制选择器）·
>   `ui/sync.js` 存储页 · `ui/debug.js#ftt.localDir` · `docs/history/P10c56`（本地存储语义纠正）· `P10c58`（一个路径框）

## 1. 两个真实问题

**问题一：路径随服务端转移。** 插件配置整体落在 ST `extensionSettings[模块名].cfg`，而**这份配置随服务端同步**——
桌面上设的 `D:\Downloads\stn\fft_v2_store` 会被原样搬到 Android 上。路径是**设备属性**，不是账号属性。

**问题二：Android 上「根本没法设置」。** 两个原因叠加：
* 同步过来的 `D:\…` 在 Android 上必然写不进去 → 「✅ 校验」失败 → 用户看到的就是「设置了也没用」；
* 选择目录只有**浏览器 File System Access**（`showDirectoryPicker`）一条路 —— Android WebView 通常没有它，
  点了只得到一句「当前宿主不支持」，**没有别的出路**（也没有任何提示告诉用户还能怎么填）。

## 2. 口径：哪些键是「设备本地」

```text
配置（随服务端同步，extensionSettings[模块名].cfg）
  └── storage.localDiskDir  →  落盘副本里**恒为空**（剥离后写入）
设备本地（只存本机，localStorage: ftt2_dev_storage.localDiskDir）
  └── storage.localDiskDir  =  D:\FTT\store      ← 这台设备真正生效的路径
```

* **载入**（`loadKernelCfg`）：以本机值为准；本机没有时，把老配置里的那份**一次性迁移**到本机（`deviceMigrated` 留痕），
  随后内核视图用本机值、落盘副本写空；**先深拷贝再剥离**（`applyKernelCfg` 让 `cfg.storage` 与合并对象同引用，直接剥离会把内核视图也清掉）。
* **落盘**（`saveKernelCfg`）：内核视图的值 → 本机；落盘副本写空。
* **无 localStorage**（受限宿主 / Node 测试）：退化为**内存副本**并标注 `available=false` —— 不假装已持久化。
* 白名单只有一项（`DEVICE_LOCAL_CFG_KEYS`）：**只有「本地存储路径」走本机**，不会误伤其它设置（其它设置照旧跨端同步）。

## 3. Android 的三条出路（选择器多机制）

| 顺序 | 机制 | 说明 |
| --- | --- | --- |
| ① | 宿主**系统对话框**（Tauri `dialog` 插件） | 给出**真路径**（跨刷新有效）；Android 上走 SAF |
| ② | 浏览器 **File System Access**（句柄） | Chromium 系可用；Android 一般没有；**绝对路径不可见**、刷新后需重选（且此时**不写路径框**，避免把「文件夹名」当路径存成相对路径） |
| ③ | 宿主 `api.dev` 的**选目录方法** | 关键字发现（`pick/select/choose` + `dir/folder/path`） |

**每个机制都必须通过写探针**（写 → 回读逐字节校验 → 删除自己的探针文件）才算成功；全都失败 → 如实列出「尝试过什么、各自为什么失败」。

另有两条不依赖选择器的出路：

* **「📁 候选目录」**（`localDiskDirCandidates`）：Tauri `path` 插件的标准目录（`AppLocalData` / `Download` / `Document` / `Home` / `Temp` …）、
  宿主 `api.*` 里形如路径的字段 / 零参方法、以及 **Android 常见公共目录建议**（`/storage/emulated/0/Download/ftt_v2_store` 等，
  标注「需宿主放行」）。**点选即探针实测**：写不进去如实拒绝，**不写入配置**。
* **手填路径 + 校验**：`localDiskPathWarn` 会在路径形态与本机平台不匹配时当场告警（Android 收到 `D:\…`、
  桌面收到 `/storage/emulated/0/…`、相对路径），把「为什么写不进去」说在前面。

## 4. 只读核对（用户可自查）

* 存储页「💾 本地存储路径」分节：本机平台 + 「路径只存本机（**不随服务端同步**）」+ 平台冲突红字告警 + 完整路径 + 候选目录 + 能力/失败明细；
* 调试桥 `ftt.localDir.deviceLocal`：本机存着哪些「不随服务端同步」的键与值（含 `backend`：`localStorage` / `memory`）；
* 调试桥 `ftt.localDir.disk`：平台、路径形态告警、句柄、能力机制与统计。

## 5. 测试与门禁

* 新增 `tests/unit/device-local-cfg.test.js`（**6 项**）：设备本地存储本体（读写删 / 键名前缀 / 无 localStorage 的内存兜底与 `available=false`）·
  老配置迁移（本机落一份、落盘副本清空）· 用户改路径的剥离口径 · **不随服务端转移**（另一台设备拿到的路径为空、其它设置照常同步）· 白名单只有一项；
* `tests/unit/local-disk.test.js` 增 4 项：平台识别与路径冲突提示 · 候选目录（含 Android 建议）· 选择器全不可用时如实回报 · 宿主对话框 + 探针实测；
* `tests/unit/local-file-mode.test.js` 增 2 项：存储页「设备本地 / 平台 / 告警 / 候选目录按钮」渲染与动作可达 · `localDiskDirs` / `localDiskDirUse`
  （候选可写才写入配置、不可写如实拒绝）；
* 全量：**165 文件 / 2533 断言** + 冒烟 **220 项**；静态门禁（含 `docs-facts`）全绿。

## 6. 下一步（已登记）

* 文件夹句柄**跨刷新持久化**（IndexedDB）：选中的文件夹句柄存起来，刷新后先用 `queryPermission` 续用；
* Android 真机核对（当前为宿主能力推断 + 桩测试，未在 Android 设备上实测 `dialog` / `path` 插件是否可用）；
* 存储页展示分片清单（快照 / 日志逐片文件、大小、hash、坏片提示，v3.32.0 起已写盘）。
