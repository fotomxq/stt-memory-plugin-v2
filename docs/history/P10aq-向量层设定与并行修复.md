# P10aq · Embedding / Rerank 设定与向量层修复（v2.79.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.79.0）
> 触发（用户要求）：「修复错误，Embedding、Rerank **设定存在严重错误**、**串行问题**。」
> 方法：先复现（可观测的桩 + 真实动作调用），再逐条修，最后每条都有单测断言兜住。

---

## 1. 复现到的五个缺陷（每条都先有证据）

| # | 缺陷 | 复现证据（修复前） | 影响 |
| --- | --- | --- | --- |
| ① | **「📦 获取模型」串到主 API**：Embedding / Rerank 区块里的该按钮走 `resolveApiTarget({purpose:'main'})`，而**不是本区块**的地址 | 在 Embedding 区块填好地址+模型后点它：`{"ok":false,"note":"❌ 获取模型失败：当前通道为「跟随酒馆当前连接」…"}`，且**一个请求都没发** | 区块里的设置项形同虚设；用户看到的是主 API 的报错 |
| ② | **没有「选择模型」下拉**：V1 每个区块都有（`modelSelect`），V2 丢了 | 页面上只有手填「模型」输入框 | 拉不到模型列表 → 只能手打模型名，写错即整层不可用 |
| ③ | **串行**：库向量与关键词向量是**互相独立**的两个请求，却串行等待 | 两个 30ms 往返 = **63ms**，`maxConcurrent = 1` | 每次冷缓存召回白等一个 RTT |
| ④ | **Rerank 白付一次调用**：先用余弦截到 TopN 再精排 → 精排只能重排这 TopN | `rerankCandidates = topN`（如 2） | 精排无法改变入选集合，付出 API 费用却零收益 |
| ⑤ | **维度不一致静默全空**：换 Embedding 模型（维度变化）后，旧缓存向量与查询向量维度不符 → `cosineSimilarity` 恒 0 | 召回 `ok:false / reason:'no-hit'`，**没有任何提示** | 换模型后召回静默失效，用户以为「AI 没记住」 |
| ⑥ | **不完整返回被当成成功**（V1 同款实现缺陷）：V1/V2 都用 `new Array(n)` 建结果数组，**空槽会被 `Array.prototype.some` 跳过** | 3 条请求只回 1 条 → `{"ok":true,"vectors":[[1,2],null,null]}` | 半份向量进入打分/缓存，结果不可预期 |
| ⑦ | 区块「🧪 测试」忽略 `cfg.vectorTimeoutMs`（恒用默认 120s） | 超时设 15s 也不生效 | 测试卡住时长与设置不一致 |

## 2. 修复

| # | 修复 | 落点 |
| --- | --- | --- |
| ① | `apiModels` 支持 `data-ftt-api-pfx`：按**本区块**地址/Key 拉模型；未配置时报**本区块**的原因；结果按区块分开存放 | `ui/api-page.js` |
| ② | 每个区块新增「选择模型」下拉（`data-ftt-model-select="emb|rerank"`，`data-ftt-cfg="<该区块模型键>"`），选中即写回；选项来自该区块的获取结果，当前值自动保留 | `ui/extract-page.js` |
| ③ | 库向量与关键词向量改 `Promise.all` 并行发出（同一时刻 ≤2 个在途请求）；失败语义不变（先判库、再判关键词） | `host/vector-recall.js` |
| ④ | 精排前取更宽候选 `max(TopN×4, 20)`（受库大小限制），精排后截 TopN；`stats` 增 `rerankCandidates / rerankKept` | `host/vector-recall.js` |
| ⑤ | 维度不符的缓存条目视为未命中 → **重新嵌入**（成功覆盖缓存；失败从缓存**真删**，避免每次召回重试注定失败的比对）；`stats.dimMismatch` 如实计数 + 调试日志 `向量/dim-mismatch` | `host/vector-recall.js`、`adapters/vector-cache.js`（新增 `vecCacheDeleteMany`） |
| ⑥ | 结果数组显式填 `null` 再校验 → 缺项一律失败，错误文案带缺项计数（`Embedding 返回不完整（1/3 条缺失）`，保留 V1 前缀） | `host/embeddings.js` |
| ⑦ | `probeTarget(target, kind, timeoutMs)` 支持超时入参；区块测试传 `cfg.vectorTimeoutMs` | `host/api-channel.js`、`ui/api-page.js` |

另外：「🧪 测试」现在与 V1 `collectApiBlock(pfx)` 同口径 —— **以屏幕上当前输入值为准**（DOM 优先，读不到 DOM 时回落 `cfg`），
避免「刚打完字就点测试」测到旧值。

## 3. 修复后证据

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 冷缓存召回（两次 30ms 往返的桩） | 63ms，`maxConcurrent=1` | **44ms**（embed 段 21ms），`maxConcurrent=2` |
| Rerank 候选 | `= topN` | `= min(库, max(topN×4, 20))`，精排后截 topN |
| 换模型（4 维 → 8 维） | 静默 `no-hit` | `stats.dimMismatch=3`，重嵌后 `ok:true`；重嵌失败则清掉旧维度向量 |
| 少返回一条 embedding | `ok:true` + `null` | `ok:false`（`1/3 条缺失`） |
| Embedding 区块「获取模型」 | 报主 API 的错、0 请求 | 请求 `https://emb.../v1/models`，回填本区块下拉 |

## 4. 验证

| 证据 | 结果 |
| --- | --- |
| `tests/unit/vector-parallel.test.js`（新增 12 断言：并行度与耗时 / 失败语义 / 候选放宽（小库·大库·未配置三态）/ 维度自愈与重嵌失败清理 / 不完整返回 / 测试超时信号） | 12 通过 / 0 失败 |
| `tests/unit/vector-layer.test.js`（新增 A7/A7b/A8/A9 与 U4：区块级获取模型、按区块分开的模型态、未配置区块的本区块报错、DOM 优先、模型下拉渲染） | 33 通过 / 0 失败 |
| 全量 `npm run gate` | 见 CHANGELOG 对应版本条目 |

## 5. 登记（本次未做）

- 缓存键是 `类别:id`，**不含模型指纹**：同维度但不同模型的向量在缓存里无法区分（换模型后前若干次召回可能混用旧模型向量）。
  彻底解法是键里带模型哈希（V1 无此设计，改动会让既有缓存全部作废）；当前靠「维度不同即自愈」覆盖最常见情况。
- 真实服务返回异形（如 `{embeddings:[[…]]}`）仍按「返回不完整」降级 —— 与 V1 同口径，未扩展解析。
