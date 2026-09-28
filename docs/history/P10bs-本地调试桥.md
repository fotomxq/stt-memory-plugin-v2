# P10bs · 本地调试桥（v3.0.7）

> 文档版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：生效（v3.0.7）
> 触发（用户原话）：「我建议在插件调试页面，增加一个开启按钮，开启后暴露一个本地端口，内置好相关API方法，从而实现调试功能。」
> 「请确保该调试机制，可兼容酒馆原生，并兼容支持TauriTavern。如果不是TauriTavern，也不会直接崩溃。」
> 相关：`开发守则.md` §6（本地调试）· `tests/local/README.md`（本层用法与协议）· `docs/history/P10br`（v3.0.6 本地调试底座）·
>   TauriTavern 宿主契约 `docs/FrontendHostContract.md` 与 `docs/API/Dev.md`（第三方扩展可消费 `api.dev`）

---

## 1. 前提纠正：为什么是「反向桥」

用户设想的是「插件开启后暴露一个本地端口」。实现前先核实，结论是**这条路径物理上不成立**：

| 事实 | 证据 |
| --- | --- |
| WebView 页面**无法监听端口** | 浏览器/WebView 安全模型，页面不能 bind |
| TauriTavern 未打包任何 http-server 类 Tauri 插件 | `src-tauri/crates/tauritavern/Cargo.toml`：仅 `opener / fs / notification / dialog / clipboard-manager / single-instance / window-state`（`pilot` 只在 `devtools-pilot` 特性下） |
| 宿主**没有** Tauri `devtools` 特性 | 同文件：`tauri = { features = ["protocol-asset"] }`（Windows 另加 `tray-icon`）→ 发行版右键/F12 打不开 DevTools |
| 但**宿主 CSP 是关闭的** | `tauri.conf.json` → `app.security.csp: null` → 页面可连 `ws://127.0.0.1:<端口>` |

于是本版做**等价物：反向调试桥** —— 端口由**本机调试工具**监听，插件在真实宿主页面里**拨出**连接。
数据面与用户设想一致（外面通过一个本地端口调用插件内置好的 API），只是 TCP 方向相反。

## 2. 跨宿主设计（用户硬要求）

同一套机制拆成**两层能力**，宿主差异只影响第二层：

| 层 | 依赖 | 酒馆原生（浏览器） | TauriTavern |
| --- | --- | --- | --- |
| 传输 + 插件只读面 | 浏览器 `WebSocket` + 插件自身 | ✅ 可用 | ✅ 可用 |
| `host.*`（前端/后端日志、LLM 请求留档） | `window.__TAURITAVERN__.api.dev` | ⛔ 逐方法返回 `{available:false, reason}`，**不抛错** | ✅ 可用 |

设计要点：

1. **只用两端都有的能力**：传输层仅 `WebSocket`；宿主判定复用 `adapters/tt-store.js#ttDetected/ttAbi`
   （该模块自 v2.77.0 起已在消费宿主公开契约 `api.extension.store`），不新引入任何宿主假设。
2. **降级而非报错**：宿主探测整段包在 `try/catch` 内，失败按「非 TauriTavern」处理；
   `api.dev` 缺失或该版本没有某个子方法 → 返回原因字符串，调用侧永远拿到 `{ok:true, result:{available:false}}`。
3. **没有 WebSocket 也不崩**：`bridgeStart()` 返回 `{ok:false, reason}`，调试页照常渲染并写明原因。
4. **不触碰宿主全局于加载期**：`bridgeHost()` 只在被调用时才探测，且探测本身不抛。

## 3. 交付物

### 3.1 插件侧

| 文件 | 作用 |
| --- | --- |
| `adapters/debug-bridge.js`（新） | WebSocket 传输 + JSON-RPC 派发 + 白名单方法表 + 状态/统计；**纯派发核心 `bridgeDispatch()` 可单测**（不经网络） |
| `ui/debug.js` | 调试页新增「🔌 调试桥」区块：开关 / 端口 / 宿主与连接状态 / 最近调用与错误；`bridgeToggle`、`bridgePortSet` 两个动作 |
| `index.js` | 装配期调用 `installDebugBridge()`（只登记方法表，**不自动连接**） |

### 3.2 协议（JSON-RPC 风格，WebSocket 文本帧）

```text
插件 → 工具   {type:'hello', protocol, plugin:{name,moduleName,version}, host:{kind,tauriTavern,abiVersion,devApi}, methods:[…]}
工具 → 插件   {id, method, params}
插件 → 工具   {id, ok:true, result}  或  {id, ok:false, error:{code, message}}
错误码        E_METHOD（未登记） / E_CALL（方法内部抛错） / E_FATAL（派发框架自身）
```

### 3.3 白名单方法（**全部只读**；新增需同步单测快照）

```text
自省      sys.info · sys.methods · sys.host · sys.bridgeState
插件      ftt.snapshot · ftt.probe · ftt.stateSize · ftt.debugLogStats · ftt.debugPageInfo
          ftt.traceStats · ftt.clockTraceInfo · ftt.clockTraceSummary · ftt.fileTransport · ftt.chatMeta
真实数据  ftt.memoryShape（各维度条数）· ftt.memorySample（按维度取样；默认只回字段名与长度）
宿主      host.frontendLogsList · host.consoleCaptureGet · host.backendLogsTail
          host.llmLogsIndex · host.llmLogsPreview · host.llmLogsRaw · host.llmLogsKeep
```

**显式不登记**：`dbgClear` / `clockTraceClear` / `dbgExport` / `dbgExportLog` / `exportBundle` /
`setConsoleCaptureEnabled` / `llmLogsSetKeep` 等改动型动作与写入型开关 —— 由单测的显式黑名单断言锁定。

### 3.4 工具侧（仓库内，零依赖）

`tests/local/bridge.mjs`：本机参考桥接服务。Node 自带 WebSocket **客户端**但没有服务端，而本仓库
「源码即发布物、无运行时依赖」→ 自带实现 RFC 6455 的握手与帧编解码（text / close / ping / pong；
客户端掩码）。支持交互模式、`--call` 一次性调用与 `--selftest` 自检（内置假插件，无需真实宿主）。

## 4. 安全边界

1. **只读**：只派发白名单方法；未登记一律 `E_METHOD`。白名单里有断言要求「不含已知改动型动作」。
2. **默认关闭且不持久化**：端口只存内存、开关每次加载回到关闭态 —— 不存在「上次开了这次自动开」。
3. **取样默认不回正文**：`ftt.memorySample` 默认只回字段名与长度；要正文须显式 `values:true`。
4. **不写宿主**：`host.*` 只取不设（`setConsoleCaptureEnabled` / `exportBundle` 未登记）。
5. **失败不改主流程**：装配失败、连接失败、调用超时、宿主探测失败，全部收敛为状态字符串。

## 5. 验证

| 项 | 结果 |
| --- | --- |
| 单元测试 | ✅ **124 文件 / 1923 断言**（新增 `debug-bridge` **40 项**） |
| 桥接自检 | ✅ `npm run local:bridge:selftest`：握手 / 帧编解码 / 调用回传 / 未登记拒绝 四项全通过 |
| 冒烟测试 | ✅ 187 项 |
| 其它门禁 | ✅ 内核纯净度 / 标识符 / 词条 / 版本一致性 / 文档规范 / 本地隐私 / 版本清单 / UI 规范 全 0 违规 |
| 归档自足性 | ✅ `git archive` → 改名目录冷复跑全门禁通过 |

`debug-bridge` 40 项中，**跨宿主部分**（用户硬要求）覆盖：

- C1/C2/C3 酒馆原生：识别为 `vanilla`、`host.*` 逐方法降级为 `{available:false, reason}`、`sys.host` 仍可读；
- C4/C5 TauriTavern：识别为 `tauritavern`（含 ABI 版本与 `api.dev` 可用性），`host.*` 真的调到桩并回传；
- C6 TauriTavern 但该版本没有 `api.dev`：仍只降级不抛；
- C7 无 `WebSocket` 环境：`supported=false`、`bridgeStart()` 返回原因且**不抛**、状态仍可读；
- E 组：酒馆原生下逐个方法调用都返回帧、不抛；`start/stop` 幂等且不抛。

## 6. 改动文件

| 文件 | 性质 |
| --- | --- |
| `adapters/debug-bridge.js` | 新增：传输 + 派发 + 白名单 + 状态统计 |
| `tests/local/bridge.mjs` | 新增：零依赖参考桥接服务（含 `--selftest`） |
| `tests/unit/debug-bridge.test.js` | 新增：40 断言（含跨宿主三态与降级） |
| `ui/debug.js` | 新增「🔌 调试桥」区块 + `bridgeToggle` / `bridgePortSet` 动作 + `installDebugBridge` |
| `index.js` | 装配期登记调试桥方法表（不自动连接） |
| `package.json` | 版本 → `3.0.7`；新增 `local:bridge` / `local:bridge:selftest` 脚本 |
| `manifest.json` · `core/constants.js` · `CHANGELOG.md` | 版本 `3.0.6` → `3.0.7`（四处一致） |
| `tests/local/README.md` | 新增调试桥用法与协议一节 |
| `docs/04-应用架构.md` | 调试页新增区块登记 |
| `docs/README.md` | §3 数字口径（版本 / 单测规模 / 历史档数） |
| `docs/history/P10bs-本地调试桥.md` | 本档 |

## 7. 未验证事项与缺口（如实登记）

1. **未在真实 TauriTavern 上跑通一次完整桥接会话**。已验证的是：插件侧逻辑（40 项单测，含模拟
   TauriTavern 宿主）与工具侧传输（自检）。真实宿主里的端到端仍需用户在插件「调试 → 🔌 调试桥」
   开启一次并观察连接 —— 该步骤需要用户在场操作宿主。
2. **`api.dev` 的实际形状未在本机核对**。契约取自 TauriTavern 主仓库 `docs/API/Dev.md`；本机 canary
   构建（2026-09-24）是否完全一致，可由 `sys.host` 与 `srv` 首次 `host.frontendLogsList` 调用旁证。
3. **HTTPS 部署下的酒馆原生受混合内容限制**：若 SillyTavern 以 HTTPS 提供，页面连
   `ws://127.0.0.1` 会被浏览器拦截（TauriTavern 因 `csp: null` 且为 `http://` 源不受影响）。
   届时需要把桥接服务放到 TLS 之后或改用其它通道 —— 本版未处理，仅由状态与错误行如实反映。
4. **调试桥没有鉴权**：只监听 `127.0.0.1` 且只读，但本机其它进程可连。若今后要开放写操作或监听
   非回环地址，必须先补令牌鉴权 —— 本版**刻意**只读以缩小暴露面。
