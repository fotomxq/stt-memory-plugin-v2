# P10c62 · 兼容 Android 端 TauriTavern：修对 Tauri 插件调用形态 + 目录名落到应用数据目录（v3.34.0）

> 文档版本：v1.0 ｜ 日期：2026-10-07 ｜ 状态：生效（v3.34.0）
> 用户要求（原话）：「android也是TauriTavern，不需要增加什么候选目录。其次请兼容android端的TauriTavern，当前存在问题可能是方法用错了，会弹出报错。」
> 关联：`adapters/local-disk.js`（传输层 / 解析 / 探针）· `ui/sync.js` 存储页 · `index.js`（启动自愈）· `docs/history/P10c61`（上一轮：设备本地路径）

## 1. 根因（三条一起）

1. **调用形态错**：旧实现把 `plugin:fs|write_text_file` 当普通 JSON 命令调用（`{ path, contents }`），
   而 TauriTavern（Tauri v2 插件）要的是**原始字节 body + `headers.path`** → 宿主报错（`missing file path`），并**弹窗**。
2. **盲试放大报错**：一次写要试 3 个命令名 × 6 种参数形态 = 18 次 IPC；每次失败都被宿主当成一次错误 → 用户看到的就是「一直弹报错」。
3. **放行范围**：宿主的 fs scope 是**应用数据目录**（`$APPCACHE` / `$APPDATA` / `$APPLOCALDATA` / `$LOCALDATA` / `$RESOURCE`），
   `D:\…`、`/storage/emulated/0/…` 这类绝对路径**一律被拒**；而配置里存的恰恰是另一台设备同步来的绝对路径。

## 2. 实测口径（从客户端构建里读出来的，逐条写进代码注释）

| 用途 | 正确形态 |
| --- | --- |
| 写 | `invoke('plugin:fs\|write_text_file', new TextEncoder().encode(text), { headers: { path: encodeURIComponent(path), options: '{}' } })` |
| 读 | `invoke('plugin:fs\|read_text_file', { path, options })` → **字节**（ArrayBuffer / Uint8Array / number[]）→ UTF-8 解码 |
| 建目录 | `invoke('plugin:fs\|mkdir', { path, options: { recursive: true } })` |
| 存在 / 删除 | `invoke('plugin:fs\|exists' \| 'plugin:fs\|remove', { path, options })` |
| 目录解析 | `invoke('plugin:path\|resolve_directory', { directory: <BaseDirectory 数值枚举> })`；`Audio=1 … Data=4, LocalData=5, Document=6, Download=7, Temp=12, AppData=14, **AppLocalData=15**, AppCache=16, AppLog=17, Desktop=18, Home=21` |
| 选择文件夹 | `invoke('plugin:dialog\|open', { options: { directory: true, multiple: false } })` |

命令清单也一并核对过：该构建包含 `app / dialog / event / fs / image / menu / notification / opener / path / resources / tray / webview / window` 插件（**没有** TauriTavern 自定义文件插件）。

## 3. 现在的行为

* **写盘纪律**：先 `mkdir -p`（新子目录自己建）→ 写 → **回读逐字节校验** → 探针用完**存在才删**（绝不盲删别人的文件）；
* **形态缓存**：成功后记 `fsShape`（`v2-raw` / `v1-json`），同会话不再试另一种；
  **只在错误像「参数形态不对」时**才换形态 —— 放行范围类拒绝（forbidden / not allowed / scope）**只发一次 IPC**（不再连环弹错）；
* **只填目录名**：`fft_v2_store` → 解析到 `$APPLOCALDATA/fft_v2_store`（Android：应用私有目录；桌面：应用本地数据目录），
  **把解析后的完整路径写回配置**（启动时 `localDiskEnsureResolved()` 也跑一次，UI 显示的是完整路径）；
* **诚实失败**：绝对路径被拒时如实报「宿主只放行应用数据目录（该路径被拒绝）—— 可只填一个目录名」，
  标记路径无效并按既有纪律**回退浏览器层**（变量 + 内存库），不假装成功；
* **候选目录已移除**（用户明确不需要）：存储页只留「📂 选择文件夹…」「✅ 校验本地磁盘目录」「🔄 刷新磁盘状态」，
  `SYNC_ACTIONS` 21 → 19。

## 4. 只读核对

* 存储页「💾 本地存储路径」：本机平台 · 宿主应用数据目录 · 完整路径 · 能力与失败明细（含**传输形态** `fsShape`）；
* 调试桥 `ftt.localDir.disk`：`base` / `baseLabel` / `fsShape` / `platform` / `pathWarn`；
* 调试桥 `ftt.diskProbe`：解析 + 写探针 → 回读 → 删探针 的完整结果。

## 5. 测试与门禁

* `tests/unit/local-disk.test.js` 重写 v3.33/3.34 段（**13 项**）：平台与路径提示 ·
  **形态正确性**（写=字节+headers、读=`{path,options}` 且返回字节、一次写只发一次 IPC）·
  目录名 → 应用数据目录（数值枚举 15、mkdir、探针文件用完即删）· 放行范围拒绝时**只发一次**且如实标记无效 ·
  选择器（全不可用如实回报；对话框 `{options:{directory:true}}` + 探针通过）· 启动自愈幂等；
* `tests/unit/local-file-mode.test.js` E3/E4 改写：存储页「设备本地 / 平台 / 无候选目录按钮」·
  `localDiskProbe` 解析 + 回填完整路径 + 被拒时不改坏配置；
* 全量：**165 文件 / 2535 断言** + 冒烟 **220 项**；静态门禁（含 `docs-facts` / `ui-spec` 提示行 ≤90 字）全绿。

## 6. 下一步（已登记）

* **Android 真机核对**（本轮的形态来自客户端构建静态实测 + 桩测试，**未在 Android 设备上跑通**）：
  刷新后在「设定 → 存储」填 `fft_v2_store` → 点「✅ 校验本地磁盘目录」，把结果告诉我；
* 文件夹句柄跨刷新持久化（IndexedDB）；
* 存储页展示分片清单（快照 / 日志逐片文件、大小、hash、坏片提示）。
