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
  `https://github.com/fotomxq/stt-memory-plugin`，分支 `main`，可在设置内改）——
  ① **首次启动自动检查**（`startupCheckedAt` 未写则必查；之后按 24h 间隔；开关可关，关闭后零远端请求）；
  ② **设置内手动检查**（「🔍 检查更新」按钮，不受开关与间隔限制，结果落盘并在状态行显示）；
  ③ 判定通道优先级 = **ST 原生端点**（`POST /api/extensions/version` 的 `isUpToDate`/commit，Git 真值）
  → 远端 `manifest.json` + `CHANGELOG.md` 回退（补版本号与更新要点）；端点为「有更新」而版本号相同时判为**同版本新提交**；
  ④ 「⬆ 立即更新（ST）」代为调用 `/api/extensions/update`（**仅用户点击**，自动路径永不调用）；
  ⑤ 全部请求 8s 超时、失败静默（不阻塞启动/发送/提取）；扩展**不下载、不写入、不执行远端代码**；
  ⑥ 状态持久化于 `extensionSettings.ftt_memory_v2.update`（`firstRunAt` / `startupCheckedAt` / `lastCheckAt` / `lastResult`），
  `/ftt` 与 `FTT.update()` 可查；新增 `core/update.js`（纯逻辑）、`host/update.js`（编排）、`adapters/update-state.js`（持久化）、
  `docs/更新检查机制.md`。
- **门禁**：单元 **9 文件 106 断言全过**；冒烟 **20/20**（含更新机制 E1–E8）；内核纯净度 **0 违规**；版本一致性 **通过**；文档规范 **0 违规**。
- **不与 V1 共存**：V1 与 V2 同装会重复注入，README 已提示；V1 数据不被本版读写（导入器在 P6）。
