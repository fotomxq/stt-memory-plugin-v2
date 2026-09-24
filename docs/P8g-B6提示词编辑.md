# P8g · B6 提示词模板编辑（V1 迁移链 + 分组编辑器）

> 文档版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：生效（v2.7.0）
> 关联：`core/prompt-migrate.js`（新）、`ui/prompts.js`（新）、`adapters/config-store.js`、`docs/P8-功能对齐总表.md`

---

## 1. 迁移链（**逐字移植 V1** v1.132 / v1.179）

| 函数 | V1 口径 | 位置 |
| --- | --- | --- |
| `promptSig(s)` | FNV-1a 32 位（`0x811c9dc5` / `0x01000193`）→ `hex + '-' + 长度`；**用于识别「当前文本仍是某个历史默认」** | `core/prompt-migrate.js` |
| `migratePromptTemplates(pt)` | 只替换三类模板：**缺失/空**、**签名命中 `PROMPT_LEGACY_SIGS[key]`**、**等于新默认**；其余（用户自定义）**保留**；返回新对象并记录 `{version, refreshed[], kept[]}` | 同上 |
| `migrateArmorPreset(target)` | 旧键 `armorPreset`：非 v1.178 官方默认且非空 → 迁入 `promptTemplates.armorPreset`（用户文本优先）；无论哪种情况**删除旧键**；幂等 | 同上 |

**接入点**：`adapters/config-store.js#loadKernelCfg()` —— 载入时先跑破甲预设迁移、再跑模板升级（与 V1 `loadCfg` 一致），
变更会随合并结果一并落盘；`lastLoadInfo().prompt` 暴露本次迁移摘要（设置页提示 + 诊断）。

> 为什么放在 `core/`：这是**纯判定逻辑**（零宿主依赖），放 core 可被配置载入层复用；UI 只负责渲染与写回。
> `ui/prompts.js` 再导出这些函数，保持 UI API 不变。

## 2. 分组编辑器（`ui/prompts.js`）

- 按 `PROMPT_GROUPS` 渲染 **5 组 / 33 条**模板（⓪ 破限提示词 · ① 通用总则 · ② 维度抽取模板 · ③ 召回与注入辅助 · ④ 质检维护）；
- 每条模板一个 `.ftt-prompt-editor`：标签行（键名 · 所属组 · 字数 · **签名** · 「已自定义 / 内置默认」）+ textarea + 「💾 保存」/「↩ 恢复默认」；
- 顶部统计条（33 条 / 5 组 / 自定义条数 / 默认版本 / **未分组键告警**）+ 上次载入迁移摘要（刷新了哪些、保留哪些）+「↩ 全部恢复默认」；
- 每组标题行带「↩ 本组恢复默认」，并保留该组在 V1 里的开关（如 ⓪ 组的 `armorPresetEnabled`，走通用 `data-ftt-cfg` 写回）；
- **破甲预设导入**：粘贴文本 →「⬇ 采用为破甲预设」写入 `armorPreset` 模板（V1 的同目录 `FTT-memory-preset.txt` 自动采用依赖宿主文件通道，见 B9 批次，页内已写明）；
- 写回唯一入口 `applyPrompt(key, text)` → `cfg.promptTemplates[key]` → `saveKernelCfg()`（ST 配置持久化）；未知键拒绝。

## 3. 测试（`tests/unit/prompts.test.js`，8 项）

P1 `promptSig` 与 V1 逐字（`''`→`811c9dc5-0`、`'abc'`→`1a47e90c-3`）·
P2 模板与分组（33/5/无未分组/默认版本/文本非空/组归属）·
P3 迁移判定（缺失→刷新、自定义→保留、等于新默认→幂等）·
P4 破甲预设迁移（用户文本迁入并删键、v1.178 默认被忽略但删键、幂等）·
P5 载入接线（`loadKernelCfg` 跑迁移、用户自定义保留、`lastLoadInfo().prompt` 可读）·
P6 写回（保存 → 内核 cfg + ST 配置容器；恢复单条/整组/全部 → 回到内置默认）·
P7 页面渲染（5 组标题 + 33 个编辑块 + 工具行 + 破甲导入 + 自定义标记）·
P8 面板接线（设定 → 提示词页可见编辑器；保存/恢复单条/破甲导入/整组/全部动作与提示）。

门禁：单元 **28 文件 / 353 断言**、冒烟 **55 项**、五道门禁全绿。

## 4. 下一批（B7）

快照链与跨端同步（**需先补内核**）：`snapStore`（root/incr、上限 30 并入根、`rebuildFromSnapshots`）、
跨端拉取合并与 meta 预判、同步日志、流量门控，随后是存储页的探测/测试/同步动作。
