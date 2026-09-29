# P10bz · 修「保存记忆文件」显示 2.6 万秒（管线运行泄漏 + 宿主看门狗）（v3.0.14）

> 文档版本：v1.0 ｜ 日期：2026-09-29 ｜ 状态：生效（v3.0.14）
> 触发（用户原话）：「新版本 保存记忆文件，会执行超长时间，我这边在管线状态观测到2.6万秒的提示。请修复太异常。」
> 相关：`docs/history/P10bm`（v3.0.0 管线块 0..N 行）· `docs/history/P10bo`（v3.0.3 数据变更即时落盘 —— 引入 `flushStateNow` 合流）·
>   `docs/history/P10bn`（v3.0.2 批次管线行）

---

## 1. 根因：合流运行时**回传了别的行的 id**

`core/pipeline.js#beginPipeline(label, {join:true})` 的语义是「同标签已在跑 → 不再新开一行，共享同一行」，
用**引用计数**配对收尾。但它的合流分支直接返回了聚合快照：

```js
if (o.join) {
    const same = runs.filter((r) => r.label === key);
    if (same.length) {
        const r = same[same.length - 1];
        r.refs += 1;
        return snapshot();          // ← 缺陷：snapshot().runId = **最新开始的那一行**（可能是别的行！）
    }
}
```

`trackPipeline` 用返回的 `runId` 收尾，于是并发下（**保存 + AI 请求 + 同步同时进行是常态**）出现：

```text
① beginPipeline('保存记忆文件', {join:true})  → 新开 run#1，runId=1          ✔（此时最新就是它）
② beginPipeline('批量摘要',     {kind:'ai'})   → run#2
③ beginPipeline('保存记忆文件', {join:true})  → 合流到 run#1，refs=2，但返回 **runId=2**（AI 那一行）✘
④ 第一次保存收尾 endPipeline(true, 1) → refs 2→1 → **run#1 留在表里**
⑤ 第二次保存收尾 endPipeline(true, 2) → 把 **AI 行**结束掉（误杀），run#1 仍在
⇒ run#1「保存记忆文件」永久残留 → UI 的「已用时」无上限增长 → 用户实测 2.6 万秒（≈7.2 小时）
```

**受影响的不止保存**：`adapters/store.js`（保存记忆文件）与 `adapters/worldbook.js`（世界书镜像）都用了 `join: true`。

复现（本仓库直跑，`node`）：

```text
修复前：begin ids = 1, 2, 2   ← 第三次合流拿到 AI 行的 id   ；两路收尾后残留 ["保存记忆文件#1"]
修复后：begin ids = 1, 2, 1   ← 正确回传被合流那一行        ；两路收尾后只剩 ["批量摘要#2"]
```

## 2. 修复（四层，根因 + 三道防线）

| 层 | 落点 | 作用 |
| --- | --- | --- |
| **① 根因** | `core/pipeline.js#beginPipeline` | 合流分支返回 `Object.assign(snapshot(), { runId: r.id })` —— **必须回传被合流那一行的 id**（`trackPipeline` 据此收尾） |
| **② 兜底** | `core/pipeline.js#reapStaleRuns`（导出）+ `PIPELINE_STALE_MS = 15min` | 任何原因造成的**卡死 / 泄漏**运行，超过阈值在读取快照时**就地撤下**；**不记 ETA 样本**，写调试日志；`lastPipelineInfo()` 带 `stale:true` 与「超时收尾（未计入预计耗时样本）」。纯内核：不加定时器，只在 `snapshot()` / `listPipelineRuns()` 顺手清理 → **2.6 万秒这种读数不可能再出现** |
| **③ 样本** | `core/pipeline.js#recordPipelineRun` + `PIPELINE_SAMPLE_MAX_MS = 15min` | 异常大的耗时**不入 ETA 历史**（样本表每标签只有 5 格，一次 7 小时就会把「预计剩」永久拉成数小时） |
| **④ 宿主** | `adapters/user-file.js`（`USER_FILE_TIMEOUT_MS = 30s`） | 所有服务端文件请求（upload / user files 读取 / delete，含 gzip 自动识别读）都带 `AbortController` 看门狗 → 挂住的请求 30s 即如实返回 `timeout(30000ms)`，**保存不会再永不结束**（本地已写成功的部分不受影响）；无 `AbortController` 的环境退化为普通 fetch，不因缺能力而抛错 |
| **④ 宿主** | `adapters/store.js`（`FLUSH_STUCK_MS = 60s` + `setFlushStuckMs`） | v3.0.3 的「立即保存合流」在**挂住**时会把后续所有立即保存**永久堵死**；现在超过阈值即判卡死 → **重开一次**保存，旧 Promise 之后 resolve 也不再回写模块状态（`if (flushInFlight === mine)` 守卫） |

调试留痕：新增管线日志钩子（`setPipelineHooks({ log })` → `debugLogPush('管线', …)`），超时收尾与异常样本都会进调试日志。

## 3. 验证

| 门禁 | 结果 |
| --- | --- |
| 新增单测 | `pipeline` **G1**（根因：合流回传正确 id，两次保存共享一行且各自收尾后该行消失、AI 行不受影响）· **G2**（兜底：泄漏运行 17 分钟后撤下、不记样本、日志留痕、`stale:true`）· **G3**（2.6 万秒不入样本，正常耗时照常入账）· **G4**（两条看门狗常量齐备）· `store-chat` **S9**（fetch 永不返回 → `timeout(30ms)`，正常请求确实带 `AbortSignal`）· **S10**（阈值内合流为同一 Promise；超阈值判卡死 → 重开并落盘成功 + 告警） |
| 新增冒烟 | **BM3**（真实 `saveStateNow` 并发两路 + AI 请求在途 → 收尾后「保存记忆文件」行必须消失、AI 行不被误杀；修复前永久残留） |
| 既有测试适配 | 冒烟 `B1` 前置让出一个宏任务（0ms）—— 「加载期探针即完成装配」的**语义不变**（仍未发 APP_READY），去掉的是对微任务轮次的隐含依赖（服务端文件请求加超时后多两次 await，此前"恰好同步可见"不再成立） |
| 单元测试 | ✅ **125 文件 / 1982 断言** |
| 冒烟测试 | ✅ **189 项**（188 → 189，新增 BM3） |
| 内核纯净度 / 标识符 / 词条 / 本地隐私 / 文档 | ✅ 0 违规 |
| UI 规范检查 | ✅ 0 命中（含 `--strict`） |
| 版本一致性 | ✅ 四处 == `3.0.14`，tag `v3.0.14` |

## 4. 改动文件

| 文件 | 性质 |
| --- | --- |
| `core/pipeline.js` | 合流 `runId` 根因修复；`reapStaleRuns` + `PIPELINE_STALE_MS`；`PIPELINE_SAMPLE_MAX_MS` 样本上限；`hooks.log` 诊断钩子 |
| `adapters/user-file.js` | `fetchWithTimeout`（`USER_FILE_TIMEOUT_MS = 30s`，可用 `opts.timeoutMs` 覆盖）+ `fetchErrText` 统一超时文案；upload / read / readAuto / delete 全部接入 |
| `adapters/store.js` | `flushStateNow` 卡死看门狗（`FLUSH_STUCK_MS` / `setFlushStuckMs`）+ 在途 Promise 归属守卫 |
| `index.js` | `wirePipelineHooks` 增 `log` → 调试日志（`管线` 类别） |
| `tests/unit/pipeline.test.js` · `tests/unit/store-chat.test.js` · `tests/smoke-test.js` | 新增 G1–G4 / S9–S10 / BM3；B1 时序收敛 |
