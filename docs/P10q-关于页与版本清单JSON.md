# P10q · 关于页改造：版本清单取代码库 JSON + 提示言简意赅 + 缓冲清理迁到数据管理（v2.53.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.53.0）
> 触发（用户要求）：「设定-关于中大量历史/文档提示需**言简意赅**，指明功能即可，**不扩散开发内容**；
> **版本更新应取代码库中的 json 文件**（修正获取逻辑，提示只留「获取中」/ 无法获取则告诉用户去哪看）；
> 『关于 · FTT记忆组件』的**重新获取**设计有错误，需修复；**清理本地缓冲**设计应移到**数据管理**，
> 展示缓冲统计让用户决定是否清理。」

---

## 1. 五个改动

| # | 要求 | 落地 |
| --- | --- | --- |
| ① | 版本更新取代码库 JSON | `ui/about.js#aboutCandidateUrls()` 第一候选 = `raw.githubusercontent.com/<updateRepo>/<updateBranch>/FTT-memory-changelog.json`（仓库/分支取更新检查设置，默认 `fotomxq/stt-memory-plugin-v2` / `main`，可被 `globalThis.__fttAboutRepo` 覆写）；扩展目录绝对路径与 V1 同款相对路径降为**离线兜底** |
| ② | 清单必须真实存在（否则功能是空的） | 新增仓库根 `FTT-memory-changelog.json`，由 `CHANGELOG.md` **生成**（`scripts/gen-changelog-json.js`）；`scripts/check-changelog-json.js` 进 `npm run gate`，校验「文件 == 重新生成的结果」+ 顶层版本 == `manifest.version` + 结构合法 → **不可能手改漂移** |
| ③ | 提示言简意赅、不扩散实现 | 状态行只有三态：`获取中…`、`已获取版本更新 · 共 N 个版本[（本次未联网，使用上次缓存）]`、`无法获取版本更新 —— 可在代码库查看：<仓库页>`。删除来源路径 / 时间戳 / emoji / 扩展目录 / 「文件该放哪」/ 缓存 TTL / 相对路径候选等说明 |
| ④ | 「重新获取」设计错误 | `aboutAction('aboutReload')` 先清在途标志 `aboutLoading` 与节流时刻 `aboutLastAttemptAt`，再强制 `aboutLoadJson(true)`；动作回报改由 `aboutStatusText()` **单一来源**生成，与页面状态行永远一致（旧实现命中在途 Promise/TTL 节流时直接返回上一轮结果，用户点了等于没点） |
| ⑤ | 清理本地缓冲 → 数据管理 | 新增 `aboutCacheStats()`（`{cached, versions, bytes}`）；数据管理页「本地缓冲」分节展示「版本清单缓存：已缓存 N 个版本 · 约 B 字节」（无缓存时按钮 `disabled`）与 `🧹 清除版本清单缓存`（动作 `aboutClearCache`），调试日志 / 交互追踪简报只留只读指针（各自页面清理） |

**关于页最终结构**（`aboutHtml()`）：关于节（一句话定位 + 当前版本 + 代码库链接 + `🔄 重新获取` + 状态行）
→ 功能节（`intro.what` + `intro.highlights`）→ 版本更新节（倒序，每条 = 版本/日期/标题 + **最多 3 条**要点）。
删除 `settings-pages.js#pageExtraHtml('about')` 的「V2 附加信息」块（版本 / 模块名 / 内核配置键数 / 对齐进度指引）。
兜底数据 `aboutFallback()` 的 `intro` 不再被渲染（读不到清单时只显示状态行），其文案也已简化为一句事实。

## 2. 清单数据契约

```json
{
  "name": "FTT记忆组件",
  "title": "SillyTavern 长期记忆扩展（V2 原生扩展）",
  "version": "2.53.0",
  "updatedAt": "2026-09-26",
  "generatedAt": "2026-09-26",
  "intro": { "what": "……", "highlights": ["……"], "entries": [], "notes": "" },
  "changelog": [
    { "version": "2.53.0", "date": "2026-09-26", "title": "关于页：……", "points": ["① ……", "② ……", "③ ……"] }
  ]
}
```

- `version` / `changelog[0].version` **必须等于当前版本**（门禁校验）；
- `date` 必须 `YYYY-MM-DD`；`points` 取该版本 CHANGELOG 段中带圈编号的改动条目，最多 3 条、每条最多 90 字；
- `intro.highlights` 是固定的功能要点（自动提取 / 按预算注入 / 剧情时钟 / 可追溯），由生成器统一给出。

## 3. 门禁与证据

- `tests/unit/about-golden.test.js` **重写为 V2 契约测试（30 断言）**：C 候选与常量（含仓库设置覆写归一）、
  L 读取/缓存/三态/坏 JSON/无 fetch 后恢复、R 强制重取与清缓存、H 渲染精简（无 `V2 附加信息`、无
  `aboutClearCache`、无 `扩展目录`/`入口与用法`/`fttAboutJson`）、B 缓冲统计与数据页、**D 用仓库真实清单渲染**；
- `tests/unit/settings-pages.test.js` P6：关于页含 `关于 · FTT记忆组件`、**不含** `内核配置键：`/`V2 附加信息`，
  数据管理页含 `本地缓冲` 与 `aboutClearCache`；
- 冒烟 `AE2`：候选首项 = 代码库 raw、失败提示指向仓库页、成功态计数/来源/缓存、关于页无开发块与清缓存按钮、
  数据页「本地缓冲」统计 + 无缓存时禁用；
- `npm run gate` 新增 `node scripts/check-changelog-json.js`。
- 合计：单元 **75 文件 / 1175 断言**、冒烟 **162 项**，全绿。

## 4. 与 V1 的有意偏离（因此不再逐字对照 V1 黄金样本）

V1 原始证据保留在 `tests/fixtures/v1-golden-about.json`（V1 v1.206 直调），但 V2 有 4 点有意不同：

1. 候选顺序 = 代码库 raw 优先（V1 只有相对路径；V1 里该 JSON 也从未随插件部署过）；
2. 状态行收敛为三态（V1 带来源路径、`toLocaleString()` 时间戳与 emoji）；
3. 关于页不渲染开发/历史块（V1 平铺「入口与用法 / 配置键数 / 缓存 TTL / 扩展目录」）；
4. 「清理本地缓冲」不在关于页，而在 设定 → 数据管理（带条数/字节统计）。

## 5. 未验证 / 风险

1. **真实浏览器 + 真实 GitHub raw 请求**未在本环境实测（本机无酒馆运行时）；契约经 fetch 桩 + 仓库真实清单渲染验证，
   真实网络下若离线，会自动落到扩展目录候选（随 zip 一起发布，见第 2 节文件）→ 再落到相对路径候选 → 最后缓存/失败态。
2. 清单是**生成物**：新增版本必须先写 `CHANGELOG.md` 再运行生成器，否则门禁 `check-changelog-json` 直接失败。
3. 旧版本条目（v2.0.x）在 CHANGELOG 中未用带圈编号，「要点」会取到该段的前几条粗体段落 —— 属真实历史文本，
   不做人工润色以免伪造。
