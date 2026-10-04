# tests/local · 本地调试与本地环境自检

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 类型：工具说明（随版本更新）｜ 状态：生效（v3.0.6）
> 规则依据：`开发守则.md` §6（本地调试）· 隐私门禁：`scripts/check-local-leak.js`

---

## 1. 这一层是干什么的

把插件挂进**本机真实宿主**（TauriTavern / SillyTavern）做开发调试，需要一个「看得见现状」的入口：
现在装的是哪个版本、跟开发仓库差多少、宿主到底有没有加载它、插件数据在哪、日志在哪。

`tests/local/` 就是这个入口。它与发布门禁**分开**：

| | 命令 | 依赖 | 属不属于发布门禁 |
| --- | --- | --- | --- |
| 单元 / 冒烟测试 | `npm test` · `npm run smoke` | 无宿主（`tests/harness/st-mock.js` 提供桩） | ✅ 属于 `npm run gate` |
| 本地环境自检 | `npm run local` | **本机真实宿主安装** | ❌ 不属于（换台机器结果就不同） |

## 2. 快速上手

```powershell
# 1) 只读自检：看现状（默认不写任何宿主文件，路径默认脱敏）
npm run local

# 2) 需要看全路径时
npm run local -- --show-paths

# 3) 改了代码后，把开发仓库的发布物同步进宿主扩展目录
npm run local -- --deploy --yes

# 3b) 部署时同步宿主副本到最新版（用户新约定，见 开发守则.md §6.4）
npm run local:sync                 # 只读检查：条件是否满足 / 两侧版本与提交是否一致
npm run local:sync -- --yes        # 执行：git fetch + merge --ff-only（宿主在跑也能替换）

# 4) 机器可读输出 / 存报告（报告落在 tests/local/out/，已 gitignore）
npm run local -- --json
npm run local -- --save
```

自动探测不到时（例如纯 SillyTavern 装在自定义目录），复制实参模板再填：

```powershell
Copy-Item tests\local\local.config.example.json tests\local\local.config.json
# 然后编辑 local.config.json —— 它已在 .gitignore 里，永不入库
```

## 3. 路径解析优先级

`tests/local/host.js` 一律**运行时解析**，源文件内**不出现任何机器特有路径**：

```text
tests/local/local.config.json（不入库，显式指定）
        ↓ 缺省时
平台约定自动探测：
  TauriTavern 应用数据根  %APPDATA%\com.tauritavern.client      （Windows）
                          ~/Library/Application Support/…        （macOS）
                          $XDG_CONFIG_HOME/… 或 ~/.config/…      （Linux）
  ST 用户目录             <应用数据根>\data\default-user
  扩展加载目录            <ST 用户目录>\extensions
```

## 4. 自检项（全部只读）

| 项 | 说明 |
| --- | --- |
| 宿主发现 | 逐路径标注来源（`config` / `auto`），找不到即失败 |
| 插件安装 | 宿主扩展目录下 `stt-memory-plugin-v2/manifest.json` 是否存在 |
| 版本一致性 | 开发仓库版本 vs 宿主部署版本 |
| git 元数据 | **直读 `.git/HEAD` 与 `.git/config`**，不调用 `git` 命令（避免 `safe.directory` 之类的全局配置改动，也规避宿主仓库属主与进程用户不一致时的 dubious-ownership 报错） |
| 漂移比对 | 两侧发布物逐文件 sha256 比对：仅开发有 / 内容不同 / 仅部署有 |
| 启用状态 | 抽取宿主 `settings.json` 的 `disabledExtensions`；ST 用 `third-party/<folder>` 表示第三方扩展 |
| 词条落地 | 部署副本 `i18n/zh-cn.json` 与 `en.json` 存在且键集一致 |
| 插件用户数据 | 宿主原生存储 `extension-store/ftt-files`、`ftt2-files` 的**只读**文件数与体积 |
| 调试开关 | 只读报告 `tauritavern-settings.json` 的 `dev` 段现状 |

## 5. 调试模式：三条通道（按可靠程度排序）

### 5.1 宿主日志（已验证可用）

`%APPDATA%\com.tauritavern.client\logs\` 下有 `tauritavern.log.<日期>`；随包 `config.yaml` 的
`logging.minLogLevel: 0`（DEBUG）与 `enableAccessLog: true` 已开。`tauritavern-settings.json` 的
`dev.llm_api_keep` 决定保留最近几份 LLM 请求/响应留档（`llm-api-*.request.json` / `.response.sse`）。

### 5.2 插件自带的调试面（已验证可用）

插件自身就有完整调试面，**不需要动宿主**：`window.FTT` 只读导出、`/ftt` 与 `/ftt-panel` 命令、
面板「调试」页、`⬇ 导出调试包`。

### 5.3 前端 console 捕获与 DevTools（宿主侧开关，本工具**不代改**）

- `tauritavern-settings.json` 的 `dev.frontend_console_capture`（默认 `false`）：置 `true` 可把前端
  console 收进宿主日志。**它属宿主配置，本工具只读、只提示，绝不代改** —— 由你手动编辑。
- DevTools：`tauritavern.exe` 已编入 `devtools` 支持，窗口内右键 → 检查(Inspect)，或 F12 / Ctrl+Shift+I。
- `tests\local\launch-debug.cmd`：带 CDP 远程调试口启动（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=<端口>`），可选注入代理。

```powershell
tests\local\launch-debug.cmd 9222
# 起来后访问 http://127.0.0.1:9222/json 检查端点
```

> ⚠️ **待实测**：CDP 依赖 WebView2 读取该环境变量，而 TauriTavern 所用 wry 会自行下发 browser
> arguments（exe 内含 `disable-features=msWebOOUI,msPdfOOUI`），此时环境变量**可能被忽略**。
> 若 9222 不响应，改用 5.3 第二条的内置 DevTools。另：TauriTavern 是单实例，**必须先完全退出
> （含托盘图标）**再跑本脚本。

### 5.4 调试桥（v3.0.7）：在真实宿主里跑只读探针

前三条是「看」，这条是「调」—— 让本机工具通过一个本地端口，调用**插件内置好的只读 API**，
从而在真实宿主页面里做实际数据测试。

```powershell
node tests/local/bridge.mjs            # 监听 127.0.0.1:8791，进入交互
# 然后在插件「调试 → 🔌 调试桥」点「▶ 开启调试桥」，插件会主动连过来
#   bridge> ls                          # 列出插件登记的白名单方法
#   bridge> call ftt.memoryShape        # 各维度记忆条数
#   bridge> call host.llmLogsIndex      # 最近几次 LLM 请求（TauriTavern 专属）
#   bridge> call ftt.pendingScan        # 未摘要清单 + 逐项跳过计数（台账诊断，只读零副作用）
#   bridge> call ftt.floorDiag {"i":2}  # 单楼诊断：这一楼「为什么」被判为未摘要

node tests/local/bridge.mjs --call sys.info          # 一次性调用
node tests/local/bridge.mjs --call ftt.memorySample --params-file params.json   # 传参（免 shell 引号问题）
node tests/local/bridge.mjs --selftest               # 自检（内置假插件，无需真实宿主）
npm run local:bridge:selftest                        # 同上

# 调试**手机等其它设备**上的 TauriTavern（v3.0.8）：
#   ① 调试机监听局域网：node tests/local/bridge.mjs --host 0.0.0.0
#   ② 手机端插件「调试 → 🔌 调试桥」把「目标主机」填**调试机的局域网地址**（如 192.168.x.x），端口一致
#   ③ 手机与调试机需在同一局域网；手机连上后本端会打印握手信息
node tests/local/bridge.mjs --host 0.0.0.0
```

> ⚠ **局域网模式的安全代价**：调试桥**只读但无鉴权**。默认只监听回环；一旦 `--host 0.0.0.0`
> 且插件目标改为局域网地址，**同网任何设备都能读到**这些只读数据（记忆条数与取样、调试日志统计、
> 宿主日志与 LLM 请求留档）。请在可信网络下临时使用，用完即停；长期开放应先补令牌鉴权。

**为什么端口在本机工具这边**：WebView 页面无法监听端口，TauriTavern 也没有 http-server 类 Tauri
插件，所以「插件自己暴露端口」做不到。这里端口由 `bridge.mjs` 监听、插件**拨出**连接 —— 数据面等价。

**跨宿主**（硬要求）：

| 层 | 酒馆原生（浏览器） | TauriTavern |
| --- | --- | --- |
| 传输 + 插件只读方法 | ✅ | ✅ |
| `host.*`（前端/后端日志、LLM 请求留档） | ⛔ 逐方法返回 `available:false`，**不报错** | ✅（走官方 `api.dev`，只读不设置） |

**安全边界**：只派发白名单内的**只读**方法（清空/删除/修复/导出落盘一律不登记）；开关**默认关闭且
不持久化**（刷新即关）；取样默认只回字段名与长度，要正文须显式 `values:true`；**默认只连本机**
（目标主机默认 `127.0.0.1`，要调手机端才显式改为局域网地址）。**本版未加鉴权** —— 因此刻意保持只读；
若今后要开放写操作或长期监听局域网，须先补令牌。

**台账诊断（v3.0.9，只读零副作用）**：`ftt.ledger`（台账标记 + 版本签名一致性）· `ftt.chatReady`（聊天就绪判定）·
`ftt.pendingScan`（未摘要清单 + 逐项跳过计数：user/hidden/missing/noText/processed/covered/chatNotReady）·
`ftt.pendingFloors`（清单）· `ftt.floorDiag(i)`（单楼逐项判据：swipes/mes 长度、`hashStable`/`hashMes`、
台账标记值与是否同哈希、签名一致性、是否被覆盖、最终是否进未摘要）·
`ftt.loadDiag()`（**载入链路四处并排**：内存台账 / 本机缓冲 / 服务端文件 / 台账相关调试日志，
含信封哈希是否自洽）。
它们一律走 `maintain:false` 与纯比较 —— **不触发任何台账维护写入**（该不变量由单测 F8 锁定）。

**协议**（WebSocket 文本帧，JSON）：

```text
插件 → 工具   {type:'hello', protocol, plugin:{…}, host:{kind,tauriTavern,abiVersion,devApi}, methods:[…]}
工具 → 插件   {id, method, params}
插件 → 工具   {id, ok:true, result}  |  {id, ok:false, error:{code, message}}
```

## 6. 部署（`--deploy`）

把开发仓库的发布物同步进宿主扩展目录，用于「改完立刻在真实宿主里看效果」。
守卫如下，均为刻意设计：

- 必须同时给 `--yes`，否则拒绝执行（退出码 2）；
- 目标目录必须已有本插件的 `manifest.json`，否则拒绝；
- **只写不删**：部署副本里多出来的文件保持不动，绝不清理；
- **永不触碰部署副本的 `.git`**（不提交、不切换、不覆盖）；
- 不写入宿主扩展目录以外的任何位置。

> 宿主若开了扩展自动更新（`config.yaml` 的 `extensions.autoUpdate`），`--deploy` 会让部署副本变成
> 脏工作树；下次宿主自动更新可能提示冲突。调试完可用宿主原生更新或重新克隆恢复。
> 建议部署前先完全退出宿主，避免文件占用。

## 6b. 部署同步宿主副本（`npm run local:sync`，用户新约定）

**用户新约定（原话）**：「如果在本地运行，且启动了调试端口，则在部署时除了 git 提交外，额外替换
TauriTavern 下的插件到最新版。」

```powershell
npm run local:sync                  # 只读检查：条件是否满足 + 两侧版本/提交是否一致（不写、不调 git 写操作）
npm run local:sync -- --yes         # 执行：git fetch <开发仓库> <分支> + merge --ff-only
npm run local:sync -- --show-paths  # 打全路径（默认脱敏）
```

它与 §6 的 `--deploy` 是**两条路**，按部署副本形态自动分流：

| 部署副本形态 | 采用方式 | 命令 | 特点 |
| --- | --- | --- | --- |
| 干净的 git 检出、与开发仓库同源 | **git 快进**（首选） | `npm run local:sync -- --yes` | 只 `fetch` + `merge --ff-only`；**宿主在跑也能替换**；两侧提交可精确核对 |
| 非 git 目录 / 有本地改动 / 异源 | **文件级替换** | `npm run local -- --deploy --yes` | 只写不删、不碰 `.git`；**要求宿主已退出**（见 §6 守卫） |

判定逻辑是纯函数 `host.js#planHostSync()`（七态：无宿主 / 非 git 检出 / 有本地改动 / 异源 / 已一致 /
漂移 / git 不可用），由单测 `local-harness` 的 **D5** 锁定。**拒绝态一律 `ok:false`**：有本地改动或
异源时**绝不覆盖**，只报告。

**改动的分级（v3.11.1）** —— 真机上遇到过「HEAD 停在旧提交、工作树里多出几个仓库后续提交的文档/测试」：

| 部署副本状态 | 处理 |
| --- | --- |
| 已跟踪文件被**修改 / 删除** | **一律拒绝**（可能是你改的） |
| 只有**未跟踪**文件，未带开关 | 拒绝，并提示可用 `--adopt-untracked` |
| 只有**未跟踪**文件 + `--adopt-untracked` | 逐个与**开发仓库同名文件**做 sha256：**全部逐字节相同** → 删除这些残留后快进（快进会把它们原样恢复）；**任何一个不同** → 拒绝（视为你的文件，绝不删） |

```powershell
npm run local:sync -- --adopt-untracked --yes   # 仅在你确认这些残留就是仓库文件时使用
```

条件探测（如实打印，不猜）：CDP `debugPort`（默认 9222，取自 `local.config.json`）可访问 **或**
插件侧「🔌 调试桥」已开（短听 8791 收到插件连入 —— 桥是**反向**的，端口在工具这侧，见 §5.4）。

**硬性边界**：只动宿主扩展目录下本插件自己的子目录；**永不** `reset --hard` / `clean` /
`checkout -f` / `push`；插件用户数据与宿主配置一律不碰。**替换后必须刷新页面才生效**（插件在页面
加载时装配；刷新后调试桥回到关闭属设计）。

## 7. 隐私与边界（硬性）

1. **入库文件不得出现机器特有路径或主机名** —— 由 `scripts/check-local-leak.js` 强制（在 `npm run gate` 中）。
   本目录下只有 `local.config.example.json` 是模板，全部为占位符。
2. **本地实参与产物一律不入库**：`local.config.json`、`out/`（见 `.gitignore`）。
3. **输出默认脱敏**：用户主目录被替换为 `%APPDATA%` / `~` 等占位符；`--show-paths` 才打全路径。
4. **只读边界**：宿主配置（`config.yaml` / `settings.json` / `tauritavern-settings.json`）与
   插件用户数据（`_tauritavern/extension-store/**`）**一律只读**。写操作只可能发生在
   `--deploy --yes` / `local:sync --yes` 时的插件发布物，以及 `--save` 时本目录的 `out/`。
5. 门禁自身**也不回显命中内容**（只给规则名 + 打码片段），避免门禁变成泄漏渠道。

## 8. 文件说明

| 文件 | 入库 | 作用 |
| --- | --- | --- |
| `host.js` | ✅ | 宿主发现与逐项只读读取、漂移比对、部署计划（纯逻辑，可单测） |
| `run.js` | ✅ | 自检入口（`npm run local`） |
| `sync-host.mjs` | ✅ | 部署同步宿主副本（`npm run local:sync`）：探测调试端口 → `planHostSync()` 判定 → 只 `fetch` + `merge --ff-only` |
| `bridge.mjs` | ✅ | 调试桥服务：零依赖 WebSocket 服务端 + 交互/一次性调用 + `--selftest` + `--host`（默认回环） |
| `launch-debug.cmd` | ✅ | 带 CDP / 代理启动 TauriTavern |
| `local.config.example.json` | ✅ | 实参模板（占位符） |
| `local.config.json` | ❌ | 本地实参（含本机路径，gitignore） |
| `out/` | ❌ | 自检报告与一次性探针脚本产物（gitignore） |

## 9. 未验证事项（如实登记）

1. **CDP 远程调试口是否真能起来**：受 wry 自带 browser arguments 影响，见 §5.3 的「待实测」。
2. **`dev.frontend_console_capture = true` 的具体落盘位置与格式**：本工具只读该开关，未开启实测。
3. **`--deploy` 未在真实宿主上执行过**：其**计划逻辑**（`planDeploy`）有单元测试覆盖，但
   「写进宿主扩展目录后宿主能否正常加载」未经本机实测 —— 首次使用请先自行备份该扩展目录。
4. **调试桥未在真实宿主上跑通过一次完整会话**（v3.0.7）：插件侧逻辑（40 项单测，含模拟 TauriTavern）
   与工具侧传输（`--selftest`）都已验证；真实宿主里的端到端需用户在插件「调试 → 🔌 调试桥」开启一次。
   另：若 SillyTavern 以 HTTPS 提供，页面连 `ws://127.0.0.1` 会被混合内容策略拦截。
   **v3.0.8 更新**：本地 TauriTavern 上**已端到端跑通**（见 `docs/history/P10bt`）；但**手机端未实测**
   —— 调试机当时无法访问用户给出的手机地址。局域网模式无鉴权，属用户已知取舍。
