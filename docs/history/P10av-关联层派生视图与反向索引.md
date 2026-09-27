# P10av · 关联层（原子层之上的边层）：派生视图 + 反向索引（v2.83.0）

> 文档版本：v1.0 ｜ 日期：2026-09-27 ｜ 状态：生效（v2.83.0）
> 触发（用户原话）：「开发之前设计的原子层之上的关联层。」
> 设计依据：`docs/D2-关系约束层设计稿.md` §3（边模型）/ §3.5（兼容策略阶段 1）/ §0（建议起点 S0）、
> `docs/D5` §2–§3（锚定与方向性）、`docs/D4` §2.2（反向索引）
> 关联：`core/model/relation.js`（新）、`core/relations.js`（新）、`ui/constraint-page.js`、`ui/settings-pages.js`、
> `ui/rel-table.js`、`index.js`、`tests/unit/relation-layer.test.js`、`tests/smoke-test.js`（BF1）、`docs/02-数据架构.md` §4

---

## 1. 这一版做了什么（对照设计）

| D2 的设计目标 | 本版落实 |
| --- | --- |
| **T1** 让 14 个大类进入同一张关系网 | 派生器遍历 13 个原子维度 + `links`，按**统一端点**（`{dim,id}` / `{who}`）建边 |
| **T2** 把散落的原子↔原子引用收敛为**有类型的边** + **反向查询** | `deriveRelations()` 输出有类型的边；`dependents()` / `relationsOf()` 提供反查 |
| §3.1 统一原子引用 `AtomRef` | `core/model/relation.js#relRef` / `relRefKey`（非法即 `null`，不臆造） |
| §3.2 10 类关系词表 + 边字段 | `REL_TYPES`（含方向性 `sym` 与是否派生 `derived`）；边字段对齐 `normRelation()` |
| §3.4 稳定 id（对称边归一） | `relationId()`：对称边按端点排序 → 两端写法同 id（不双写）；有向边方向不同即不同边 |
| §3.5 阶段 1：**不迁移、不落库** | 本版**零数据模型变更**：`DATA_VERSION` 仍为 1，无新容器、无迁移 |
| **D1 G1** 开关键名分裂 + 无 UI 入口 | `ui/rel-table.js#relLayerOn` 改读内核真实键 `cfg.relLinkEnabled`；设定 → 分析记忆 补上三项控件 |
| §0 建议起点 **S0**（只读派生 + 可见可查） | 设定 → 约束新增「🔗 关联层」区块（统计 + 查询），`FTT.*` 6 个只读入口 |

## 2. 派生来源（逐条可核对）

| 来源字段 | 边 | 说明 |
| --- | --- | --- |
| `links` 非锚行（`who`） | `knows` / `knows-not` | 知情方式 `how`、公开标记（取同条目锚行）、剧情日期 `at`；`deviation=unaware` → `knows-not` |
| `links` 锚行 | `member-of` / `derived-from` | `conceptRef`/`atomRef`/`planRef`/`suspenseRef`/`memRefs` → 隶属；`sourceRefs` → 来源 |
| `parallels.sourceRefs` | `derived-from` | 平行 ← 已成事实的情节/记忆 |
| `parallels.promotedTo` | `derived-from` | 情节 ← 被转正的平行（转正是**晋升**，D5 §5.3） |
| `parallels.planRef` / `suspenseRef` | `member-of` | |
| `plans.atomRefs` / `memRefs` / `suspenseRefs` | `member-of` | |
| `suspense.planRefs` / `memRefs` / `atomRefs` | `member-of` | |
| `plotSegments.atomIds` | `derived-from` | 分段 ← 情节 |
| `atoms.mergedSummary.sourceIds` | `derived-from` | 情节总结 ← 被总结的情节 |
| `rumors.lineage.parentId` | `derived-from` | 传言 ← 母传言（谱系） |
| `rumors.parallelRefs` | `mirrors` | **对称边**：传言 ↔ 平行事件 |
| `items` / `currencies` / `memories`.owner | `owns` | 角色 ← 持有/归属（`owner='通用'` 不建边） |
| `atoms.locations` / `items.location` / `parallels.location` | `located-at` | 与场景**名称/路径精确匹配**才建边（来源标记 `inferred`） |
| `scenes.pathArr` | `member-of` | 子场景 → 父场景（按路径前缀解析） |

**刻意不派生**：`caused` / `before` / `co-occur` —— 机械推不出因果与共现，强行推导只会制造噪声；
三者在词表里**保留位置**（`REL_TYPES` 中 `derived: false`），待 `D4` 的联动语义或后续版本接入。

## 3. 口径与边界

| 项 | 说明 |
| --- | --- |
| **只读** | 派生不改任何 `state`（单测断言「派生前后 `JSON.stringify(state)` 一致」） |
| **确定性** | 无随机；输出按「词表顺序 → 起点键 → 终点键 → how」排序，两次派生逐字节一致（跨端可比） |
| **有界** | 单次派生 `max` 默认 2000 条边，超出**截断并如实标记** `truncated`（不静默丢） |
| **自环拒收** | `A → A` 一律不建边（D2 N3） |
| **死链可见** | 端点指向已不存在条目 → 计入 `stats.dangling`（沿用既有孤儿口径，扩展为全类型） |
| **不落库** | 无新容器、无 `DATA_VERSION` 变更、无迁移 —— 属于 D2 §3.5 的「阶段 1」 |
| **开关语义** | `cfg.relLinkEnabled=false` → 只停「谁知道」边（`linksOff=true`），其它引用仍照常派生 |
| **性能** | 单次 O(容器条目数 + 引用数)；UI 每次渲染派生一次（不缓存，避免陈旧） |

## 4. 界面与调试入口

| 入口 | 内容 |
| --- | --- |
| 设定 → **约束** → 🔗 关联层 | 统计（边合计 · 按类型 · 死链 · 是否截断 · 开关状态）+ 查询（`atoms:a1` 坐标或标题关键字）→ 正反两向边列表 |
| 设定 → **分析记忆** → 关联层（谁知道 / 谁相关） | **新增开关入口**：`relLinkEnabled`（启用）/ `relLinkMax`（单条目行数上限）/ `relOrphanAction`（孤儿处置） |
| `FTT.relations()` | 一次派生的完整快照（`{edges, stats, truncated, linksOff}`） |
| `FTT.relationStats()` | 仅统计 |
| `FTT.dependents(dim, id)` | **谁依赖我**（反向索引） |
| `FTT.relationsOf(dim, id)` | 我引用了谁 / 谁知道我（正向） |
| `FTT.relationQuery(q)` | 查询解析（坐标或关键字 → 候选端点） |
| `FTT.relationLayerOn()` | 关联层开关状态 |

## 5. 门禁与回归

| 门禁 | 结果 |
| --- | --- |
| 新增 `tests/unit/relation-layer.test.js` | ✅ 19 项：边模型（归一 / 对称归一 id / 词表校验）· 逐来源派生（认知 / 结构 / 归属 / 位置 / 场景层级）· 不派生因果类 · 开关口径 · 确定性 · 上限截断 · 反向索引双向 · 端点标签 · 快照统计与死链 · 查询解析 · 设定入口与开关统一 |
| 新增冒烟 `BF1` | ✅ `FTT.*` 6 个入口可用；设定 → 约束 渲染「🔗 关联层」并可用**真实动作** `linkQuery` 查询；设定 → 分析记忆 提供开关 |
| 受影响测试 | `settings-pages`（176 / analyze 20）· `settings-capacity`（C7）· `importance-placement`（A1）· `constraint-page`（A2）· `analyze-grouping`（七节 / 21 键 / 5 条提示）· `rel-nav-golden`（开关键统一） |
| 单元测试 | ✅ 105 文件 / 1617 断言 |
| 冒烟测试 | ✅ 171 项 |

## 6. 未做（按 D2 的阶段表，逐项登记）

| D2 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **S0** 只读派生 + 可见可查 | 本版 | ✅ **已交付** |
| S1 开关统一 + 界面入口 | 本版一并交付（原属 D1 G1） | ✅ 已交付 |
| **S2** `relations` / `constraints` 两容器落库 + 6 处接线 + `DATA_VERSION` 递增 + 注入约束段分区升级 | 边可编辑、AI 可产出、跨端逐条合并 | ⬜ 待做 |
| S3 校验（finding：知情违反 / 因果倒挂 / 互斥同真 / 时间越界） | —— | ⬜ 待做 |
| S4 演化接线（传言传导走边、平行目标受约束加权、时钟判据形式化） | 见 `D4` | ⬜ 待做 |
| S5 UI 深化（边编辑、冲突面板、裁决理由） | 见 `D5` §7 的 W5 | ⬜ 待做 |
| S6 跨端（边的稳定 id 已就绪，落库后即可参与逐条合并） | —— | ⬜ 待做 |
