# P10br · 本地调试：真实宿主自检、调试启动器与隐私门禁（v3.0.6）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.6）
> 触发（用户原话）：「本地安装有TauriTavern，请核对路径，想办法进入调试模式，构建单独的本地化单元测试目录及文件。
> 开发守则新增，当本地进行开发时，可使用本地调试。注意不要泄漏本地隐私信息，其次请勿修改插件之外的数据信息。」
> 相关：`开发守则.md` §6（新增「本地调试」条款）· `tests/local/README.md`（本层用法）·
> `scripts/check-local-leak.js`（隐私门禁）· `docs/history/P10ao`（v2.77.0 宿主原生存储，本层只读统计其容器）

---

## 1. 需求与缺口

此前没有任何「面向本机真实宿主」的开发入口。要挂进真实 TauriTavern 调试，只能靠人工：

| 缺口 | 后果 |
| --- | --- |
| 不知道宿主把扩展装在哪、装的是哪个版本 | 改完代码不知道有没有生效、装的是不是同一份 |
| 没有版本/漂移核对 | 「我明明改了」与「宿主没变」之间只能靠猜 |
| 没有隐私护栏 | 本地路径与主机名极易被顺手写进入库文件（公开仓库 = 直接发布） |
| 没有边界约定 | 容易顺手改宿主配置或插件用户数据，破坏用户环境 |

本批把上述四项补成常规能力。**产品运行时零改动**（`core/` `host/` `adapters/` `ui/` 未触碰）。

## 2. 本机侦察实测（仅记录结论，路径一律以环境变量形式书写）

按用户要求先核对路径。侦察**全程只读**，未修改宿主任何文件：

| 项 | 实测结论 |
| --- | --- |
| 安装目录 | `%LOCALAPPDATA%\TauriTavern\`（`tauritavern.exe`；另有 `default\`、`frontend-templates\`） |
| ST 后端配置 | `%LOCALAPPDATA%\TauriTavern\default\config.yaml`（标准 ST 格式：`dataRoot: ./data`、`port: 8000`、`logging.minLogLevel: 0` 即 DEBUG、`extensions.enabled: true`） |
| 应用数据根 | `%APPDATA%\com.tauritavern.client\`（`data\` · `logs\` · `security\`） |
| **宿主扩展加载目录** | `%APPDATA%\com.tauritavern.client\data\default-user\extensions\`（本机 36 个扩展） |
| 本插件（已装） | 该目录下 `stt-memory-plugin-v2\`，**git 检出**，版本 **3.0.4**，**启用中** |
| 启用判据 | ST `settings.json` 的 `disabledExtensions` 里**没有** `third-party/stt-memory-plugin-v2` |
| 插件用户数据 | `…\data\_tauritavern\extension-store\ftt-files`（5 文件）与 `ftt2-files`（6 文件）—— **只读统计，不触碰** |
| 日志 | `%APPDATA%\com.tauritavern.client\logs\tauritavern.log.<日期>` + `llm-api-*.request/response` |
| 调试开关 | `tauritavern-settings.json` 的 `dev` 段：`frontend_console_capture`（默认 false）、`llm_api_keep`（5） |
| 运行期 | 探测时宿主正在运行；仅监听一个非 HTTP 端口 → **没有**现成的外部调试口 |
| DevTools 能力 | WebView2 运行时已装；`tauritavern.exe` 内含 `devtools` 支持（多处命中）与 wry 默认参数 `disable-features=msWebOOUI,msPdfOOUI` |

两条由此确立的实现约束：

1. **不能调 `git` 命令**去读部署副本的元数据 —— 该目录属主与进程用户不一致时会触发
   `detected dubious ownership`，而「给 git 加 `safe.directory`」属于修改全局配置（越界）。
   故 `readGitHead` / `readGitRemote` **直读 `.git/HEAD`、`.git/refs/**`、`.git/config`**。
2. **不能整体 `JSON.parse` 宿主 `settings.json`** —— 实测该文件约 10 MB 且为单行 JSON，
   整体解析会长时间卡住。故只用锚定正则抽取 `disabledExtensions` 一段。

## 3. 交付物

### 3.1 目录结构（机制入库，实参不入库）

```text
tests/local/
├── README.md                    ✅ 入库：用法 · 优先级 · 边界 · 未验证事项
├── host.js                      ✅ 入库：宿主发现 + 只读读取 + 漂移/部署计划（纯逻辑）
├── run.js                       ✅ 入库：自检入口（npm run local）
├── launch-debug.cmd             ✅ 入库：带 CDP / 代理启动宿主
├── local.config.example.json    ✅ 入库：实参模板（全占位符）
├── local.config.json            ❌ 不入库（含本机路径，.gitignore）
└── out/                         ❌ 不入库（自检报告产物，.gitignore）
scripts/check-local-leak.js      ✅ 入库：隐私门禁（已接入 npm run gate）
tests/unit/local-harness.test.js ✅ 入库：上述逻辑的单元测试（临时目录伪造宿主，34 断言）
```

### 3.2 路径解析：入库文件零机器路径

优先级为「显式实参 → 平台约定自动探测」，全部在运行时由 `env` / `home` 解析：

```text
tests/local/local.config.json（不入库，可缺省）
        ↓ 缺省时
TauriTavern 应用数据根：%APPDATA%\com.tauritavern.client            （Windows）
                        ~/Library/Application Support/…              （macOS）
                        $XDG_CONFIG_HOME/… 或 ~/.config/…            （Linux）
ST 用户目录：<应用数据根>/data/default-user
扩展目录：  <ST 用户目录>/extensions
```

入库源码里出现的是 `com.tauritavern.client`、`default-user`、`extensions` 这类**与用户名无关**的标识，
以及 `%APPDATA%` / `%LOCALAPPDATA%` 这类环境变量引用。

### 3.3 自检项（`npm run local`，全部只读）

宿主发现（逐项标注来源 `config` / `auto`）· 插件安装 · 版本一致性 · git 元数据（直读）·
发布物逐文件 sha256 漂移比对 · 宿主启用状态 · 词条落地（`i18n` 键集）· 插件用户数据只读统计 ·
宿主调试开关现状。输出**默认脱敏**，`--show-paths` 才打全路径；另有 `--json` / `--save` / `--strict`。

### 3.4 调试模式：三条通道

| 通道 | 状态 |
| --- | --- |
| 宿主日志（`logs/tauritavern.log.*`，随包 `config.yaml` 已是 DEBUG 级） | 已验证存在 |
| 插件自带调试面（`window.FTT` / `/ftt` / 调试页 / 导出调试包） | 已验证存在（既有能力） |
| `dev.frontend_console_capture` 与 DevTools（内置 + `launch-debug.cmd` 的 CDP） | 开关存在；**CDP 生效性待实测**（见 §7） |

### 3.5 部署守卫（`--deploy`）

必须同时给 `--yes`；目标目录必须已有本插件 `manifest.json`；**只写不删**（部署侧多余文件保持不动）；
**永不触碰部署副本的 `.git`**；不写入扩展目录以外的任何位置。其**计划逻辑**（`planDeploy`）为纯函数并有单测覆盖。

## 4. 隐私与边界（本批的硬约束）

### 4.1 「不泄漏」做成可执行门禁

`scripts/check-local-leak.js` 已接入 `npm run gate`。判据刻意**机器无关**：

| 规则 | 判据 | 豁免 |
| --- | --- | --- |
| `user-profile-path` | `C:\Users\<name>` / `/home/<name>` / `/Users/<name>` | 占位符形态：`<name>`、`%USERNAME%`、`$HOME`、`{user}`、`username`、用户名中文等 |
| `hostname` | 当前机器主机名（≥5 字符才判） | —— |
| `repo-abs-path` | **本次扫描的仓库根绝对路径**出现在文件里（自适应：检出在哪就判哪条，换机器同样有效） | 同上白名单 |

设计要点：

1. **门禁自身不回显命中内容**（只给规则名 + 首字符打码片段），否则门禁会成为新的泄漏渠道。
2. `repo-abs-path` **由一次真实漏检驱动**：本批的批次档初稿把本机检出路径抄进了
   `P10bq` 文档，而前两条规则都拦不住（它既不含用户主目录，也不含主机名）。
   故补上这条自适应规则，并在 `local-harness` 里加了 E10/E11 两向断言锁定它。
3. 两条白名单，语义不同、互不替代：
   - `ALLOW_SUBSTRINGS`：**上游作者构建机的 Linux 路径**，自 v1 起已公开出现在
     `开发守则.md`、`docs/` 与 `tests/fixtures/gen-*.cjs`（oracle 生成器的绝对路径）。
     它们是**既有公开事实**；不加白名单，作者在自己机器上跑门禁会误报。
   - `ALLOW_SYNTHETIC`：单元测试里**编造的假路径**（`tests/unit/trace.test.js` 的 V8 裸帧样本
     `file:///home/u/...`，假用户名为单字符 `u`）。按行豁免而**不放宽规则** —— 放宽「用户名段」判据
     会同时漏掉真泄漏。
3. 扫描跳过 `tests/local/local.config.json` 与 `tests/local/out/`：它们按设计就含本机路径，且不入库。

### 4.2 「不改插件之外的数据」写进守则

`开发守则.md` 新增 §6「本地调试」，其中 §6.2 明列不可越线：

1. 宿主配置（`config.yaml` / `settings.json` / `tauritavern-settings.json`）与插件用户数据
   （`_tauritavern/extension-store/**`）**一律只读**；需要动宿主开关（如 `frontend_console_capture`）
   时**由用户手动改**，工具只提示不代改。
2. 写操作只可能在两处：`--deploy --yes` 的插件发布物、`tests/local/out/` 的报告。
3. 本地实参放 `local.config.json`（gitignore），模板为 `local.config.example.json`。

## 5. 验证

| 门禁 | 结果 |
| --- | --- |
| 单元测试 | ✅ **123 文件 / 1883 断言**（新增 `local-harness` **34 项**：平台目录解析 A1–A5 · 宿主发现 B1–B4 · 只读读取 C1–C10 · 漂移与部署计划 D1–D4 · 隐私门禁 E1–E11） |
| 冒烟测试 | ✅ 187 项 |
| 隐私门禁 | ✅ 扫描 491 个文本文件，0 命中（含「干净树 0 命中 / 埋入真泄漏即命中」两向断言；并在本批自查中**真实抓到两处**：测试文件里误用本机主机名、以及本批次档初稿里的本机检出路径） |
| 其它门禁 | ✅ 内核纯净度 / 标识符 / 词条 / 版本一致性 / 文档规范 / 版本清单 / UI 规范 全 0 违规 |
| 归档自足性 | ✅ `git archive` → 改名目录冷复跑全门禁通过 |

**本机真实宿主实测**（`npm run local`，只读）：

```text
✅ 宿主发现：ST 用户目录 %APPDATA%\com.tauritavern.client\data\default-user（来源：auto）
✅ 宿主发现：TauriTavern 可执行文件 %LOCALAPPDATA%\TauriTavern\tauritavern.exe
✅ 插件安装：已安装版本 3.0.4
⚠️  版本一致性：开发仓库 3.0.5 ≠ 宿主部署 3.0.4
✅ 开发仓库 git：refs/heads/main @ c4a4b4989896
✅ 部署副本 git：refs/heads/main @ 61679f048ab5
⚠️  漂移比对：仅开发有 8 · 内容不同 10 · 仅部署有 0（合计 18）
✅ 启用状态：已在宿主启用（不在 disabledExtensions 中）
✅ 词条落地：54 条 × 2 语言，键集一致
✅ 插件用户数据：ftt-files 5 文件/4903 KB · ftt2-files 6 文件/970 KB（只读统计）
ℹ️  前端 console 捕获：未开启 —— 需你手动置 true（本工具不代改宿主配置）
```

即：路径核对、版本/漂移、启用状态、词条落地、只读统计**全部跑通**，且输出已脱敏。

## 6. 改动文件

| 文件 | 性质 |
| --- | --- |
| `tests/local/host.js` · `run.js` · `launch-debug.cmd` · `README.md` · `local.config.example.json` | 新增（机制入库） |
| `scripts/check-local-leak.js` | 新增（隐私门禁，接入 `npm run gate`） |
| `tests/unit/local-harness.test.js` | 新增（32 断言） |
| `.gitignore` | 新增忽略 `tests/local/local.config.json`、`tests/local/out/` |
| `开发守则.md` | 新增 §6「本地调试」，文档版本 v1.0 → v1.1 |
| `package.json` | 新增 `local` / `local:leak` 脚本；`gate` 接入隐私门禁 |
| `manifest.json` · `package.json` · `core/constants.js` · `CHANGELOG.md` | 版本 `3.0.5` → `3.0.6`（四处一致） |
| `docs/README.md` | §3 数字口径（版本 · 单测规模 · 历史档数） |
| `docs/03-技术架构.md` · `docs/05-开发指南.md` | 门禁清单与测试体系补本层；顺带修正**过时**的测试规模数字 |
| `docs/history/P10br-本地调试与本地环境自检.md` | 本档 |

## 7. 未验证事项与缺口（如实登记）

1. **CDP 远程调试口能否起来 —— 未实测**。`launch-debug.cmd` 走
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>`，但 TauriTavern 所用 wry
   会自行下发 browser arguments（exe 内含 `disable-features=msWebOOUI,msPdfOOUI`），此时该环境变量
   **可能被忽略**。实测需先完全退出正在运行的宿主（单实例），本批未执行。若不起效，改用内置 DevTools
   （右键检查 / F12）。
2. **`dev.frontend_console_capture = true` 的落盘位置与格式 —— 未实测**。本工具只读该开关，
   按 §4.2 边界不代改宿主配置。
3. **`--deploy` 未在真实宿主上执行过**。计划逻辑有单测覆盖，但「写进宿主扩展目录后宿主能否正常加载」
   未经实测；且宿主若开启扩展自动更新，部署会让副本成为脏工作树、下次更新可能冲突。
   README §6 已写明，首次使用请先备份该扩展目录。
4. **本层不覆盖真实浏览器的端到端点击**。它做的是环境核对与部署，不做 UI 自动化；真实交互仍由
   冒烟测试的宿主桩承担（同 `P9a` / `P9e` 的既有登记）。

> 本批**顺带修正**了当前层文档的过时测试规模数字（`docs/03-技术架构.md` 与 `docs/05-开发指南.md`
> 仍写 102 文件 / 1565 断言 / 冒烟 167 项）。该过时在 `docs/history/P10bq` §6.2 已登记，本批因
> 门禁清单与测试体系两处本来就要改，一并改为实测值（123 文件 / 1881 断言 / 冒烟 187 项）。
> 另：`docs/05-开发指南.md` 的「`tests/` 行数」原写 29125，**计数基不明且已无法复现**
> （实测：`.js`/`.mjs`/`.cjs` 共 35321 行、fixture JSON 另 52274 行、合计 87678 行）。
> 本批改为 **35321 行并显式标注口径**（只算脚本，不含 fixture JSON），使其可复现；
> `docs/README.md` 目录树注释里过时的「历史批次层（92 份）」也一并改为与 §3 一致的 112 份。
