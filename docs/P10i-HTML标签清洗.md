# P10i · 正文 HTML 标签清洗（`<br>` 不得污染数据，v2.44.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.44.0）
> 触发（用户原话）：「**地点捕捉把 `<br>` 这种 HTML 标签也捕捉进来了，应自动舍弃 HTML Tag 标签，避免污染数据。**」
> 涉及：`core/html-text.js`（新） · `core/clock-extract.js` · `core/clock-patrol.js` · `core/clock-ai.js` ·
> `host/chat.js` · `host/floors.js` · `tests/unit/html-pollution.test.js`（新） ·
> `tests/fixtures/v1-golden-html-pollution.json`（新，含生成器） · `tests/smoke-test.js`（AU1）

---

## 1. 问题定性（V1 缺陷 #5）

酒馆消息正文（`ctx.chat[i].mes` / `swipes[]`）是**可含 HTML 的富文本**：`<br>`、`<p>`、`<div>`、`<img>`、
`<span style=…>`、`&nbsp;` 等。V1（v1.206）在**取文与取值两处都不做清洗**，于是标签被当成「内容」入库：

| 场景 | V1 实测结果（oracle 证据） | 后果 |
| --- | --- | --- |
| 正文头地点行 `▷码头仓库<br>` | `location = '码头仓库<br>'`（`source: header`） | 总览/注入/导出全是 `码头仓库<br>`；与「码头仓库」不是同一地点 → 场景库匹配、注入自查全部错位 |
| 标记式 `【地点：<b>码头</b>&nbsp;仓库】` | `location = '<b>码头</b>&nbsp;仓库'` | 同上 |
| 自定义地点正则命中标签片段 | `location = '码头仓库<br>'` | 同上（用户自定义正则无法自保） |
| 全文以 `<br>` 换行（无 `\n`） | **地点行识别不到**（`location = null`） | 整段被 `<br>` 连成一行 → 正文头结构解析失效，地点整段丢失 |
| 手工改写录入 `码头仓库<br>` | `state.state.clockManual.location = '码头仓库<br>'` | 手工值污染，且被锁定后长期生效 |
| 投喂给 AI 的楼层文本 | 原样带 `<div>`/`<br>` | AI 分析被标签干扰；AI 可能把标签抄进提取结果 → 污染扩散 |
| AI 生成「地点正则」 | V1 无「含 HTML 特征」校验 | 按含标签样本总结出的正则会**长期**把标签写进数据 |

> 证据：`tests/fixtures/v1-golden-html-pollution.json`（生成器 `tests/fixtures/gen-v1-golden-html-pollution.cjs`，
> oracle = 真实 V1 插件 v1.206；两次运行逐字节一致）。单测 O 组直接断言该 fixture 里的污染事实。

**结论**：这是 **V1 故障明确修正 #5**（前四处见 `docs/P8-功能对齐总表.md` §6-9）。V1 已停止开发，本项只在 V2 修正。

---

## 2. 约定（三选一即视为缺陷）

清洗收敛到**一套纯函数**（`core/html-text.js`），语义固定为三条：

1. **块级标签 → 换行**：`<br>`、`</p>`、`</div>`、`</li>`、`</tr>`、`</h1..6>` … 视为换行 ——
   保留楼层原本的分行语义（这也是「全文 `<br>` 换行时地点行能重新被识别」的原因）。
2. **其余标签直接丢弃**；`<script>`/`<style>`/`<template>` **连同内容**丢弃，HTML 注释丢弃。
3. **实体解码在去标签之后**：`&nbsp;`→空格、`&amp;`→`&`、`&lt;`/`&gt;`、`&#39;`、`&#x4e2d;` …；
   顺序固定（先具名/数字、最后 `&amp;`），避免 `&amp;lt;` 被二次解码。

**保守性（不许放宽）**：`<` 之后**不是字母**的片段一律保留 —— `甲<10>乙`、`血压 < 正常`、`20<30` 都必须原样留下。
（这也是本模块**不做** `<[^<>]*>` 兜底删除的原因：那条正则会把剧情里的数值比较一并吃掉。）

---

## 3. 落点（取文边界 + 取值环节，双保险）

| 层 | 位置 | 做了什么 |
| --- | --- | --- |
| 取文边界（宿主） | `host/chat.js#toKernelMessage` | `mes` 读入即清洗（**含标签才清洗**）→ AI 提示词、时钟、在场解析都拿到干净文本；命中时记时间线 `kernel/html-clean` |
| 取文边界（宿主） | `host/floors.js#collectFloorLinesInRange` | 楼层投喂/窗口文本清洗 → `floorAnalyzableText` / `buildFeedFloorText*` 自动干净；**楼层哈希仍用原始稳定正文**（`floorStableText` 不动 → 既有「已处理楼层」台账不失效，避免一次无谓的全量重提取） |
| 取值环节（内核） | `core/clock-extract.js` | ① **只在文本确实含标签/实体时**才清洗（无标签路径与 V1 逐字一致，黄金样本不受影响）；② 正文头解析前先清洗；③ 地点取值再经 `cleanValue` 兜底（单行化）；④ HTML 统计经侧信道 `clockExtractDiag().html` 导出，并写入**时钟取值追踪**（回答「地点为什么少了标签」） |
| 取值环节（内核） | `core/clock-patrol.js#parseClockManualInput` | 手工录入三项先清洗，并在 `notes` 里如实回报「已自动剔除 HTML 标签/实体 N 处（如 `<br>`）」 |
| 取值环节（内核） | `core/clock-ai.js#normalizeClockRegexFromAi` | 含 HTML 标签特征（`<tag` / `&nbsp;` 等）的 AI 正则一律**拒绝**（`reason: 'html-tag'`），不写进 `cfg`，并在「未采用」里显示原因 |

**为什么双保险**：即使某条取文路径漏接（例如未来新增钩子或测试直接传文本），取值环节仍会兜底清洗；
反之若取值环节漏改，取文边界也已把标签挡在门外。

---

## 4. 门禁（防回归）

| 门禁 | 覆盖 |
| --- | --- |
| `tests/unit/html-pollution.test.js`（29 断言，O/V/H/B/M/T 组） | O 组 **oracle 自证**（V1 确实把标签写进 location / 手工锚点 / 投喂文本）· V 组 **修正后逐例断言**（正文头/标记式/自定义正则/`<br>` 换行恢复/端到端落盘/无标签逐字不变）· H 组 纯函数语义（块级换行、实体、`<10>` 不误删、script/注释）· B 组 宿主边界（楼层文本、可分析文本、**哈希口径不变**、聊天读入）· M 组 手工锚点 + AI 正则拒绝 · T 组 追踪可见（时钟追踪备注 + 时间线事件 + 侧信道统计） |
| `tests/smoke-test.js` **AU1** | 真实宿主楼层正文（含 `<br>`/`<div>`）→ 自动提取落盘地点/场景不含标签；手工改写保存被清洗且 note 说明 |
| fixture 纪律 | `v1-golden-html-pollution.json` 由提交的生成器产出，stdout 仅 JSON、日志走 stderr、`exit(0)`、**两次运行逐字节一致** |

**本批修掉的真缺陷（登记）**：`core/html-text.js` 首次落地时的两个实现坑 —— ① 兜底正则 `<[^<>]*>` 会误删
`甲<10>乙`（已删除该兜底，并在单测 H3 锁死「`<` 后非字母保留」）；② 注释 `<!--…-->` 未纳入 `hasHtmlTag`
判定 → 含注释的正文会走「无 HTML」快路径而漏清洗（已补 `COMMENT_TEST`，H4 锁死）。

---

## 5. 不做什么（边界）

- **不改楼层哈希口径**：`floorStableText`/`hashFloorText` 仍用**原始正文** —— 清洗只作用于「投喂/取值文本」，
  否则存量用户的「已处理楼层」台账会集体失效（全量重提取）。这是一条有意的取舍，写入本节以免后人"顺手统一"。
- **不重写正文本身**：插件不修改宿主聊天数据（`ctx.chat` 只读），清洗只在内存中的文本副本上进行。
- **不做 Markdown/BBcode 清洗**：只处理 HTML 标签与实体；`**加粗**`、`[color]` 之类不改（避免误伤剧情文本）。
