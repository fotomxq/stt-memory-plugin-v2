# P10ag · 生日日期异常误判修复（v2.69.0）

> 文档版本：v1.0 ｜ 日期：2026-09-26 ｜ 状态：生效（v2.69.0）
> 触发（用户报告）：「主角大类当主角为 **0001-01-01** 出生，剧情到 **0191-09-23** 时，会触发**生日日期异常**。
>   请核对原因并修复该异常判断。」

---

## 1. 根因

`core/model/snapshot.js#snapshotBirthAnomaly()`（V1 v1.206 8235~8270 逐字移植）的 `overage` 判据：

```js
const age = Number(calcAge(bd, ageAnchorDate()));
if (Number.isFinite(age) && age > 120 && !(parts.y < 0)) return 'overage';
```

- `120` 是「**现实人类寿命**」的经验阈值；
- 唯一豁免是「**出生年为负（公元前）**」。

于是两类**设定而非数据错误**的情况被误判：

| 场景 | 事实 | 误判 |
| --- | --- | --- |
| 用户报告：主角 0001-01-01 出生、剧情 0191-09-23 | 自设纪元 / 编年从 0001-01-01 起算，主角 190 岁 | `overage` |
| 非人 / 长生设定：高等精灵 0719 年出生、剧情 1919 年 | 1200 岁对精灵是常态 | `overage` |

**影响面**（用户实际看到的）：角色档案列表挂「⚠️ 出生日期异常」角标 → 角色页「🔧 修复角色」出现「（⚠️N 优先）」→
`buildCharacterRepairQueue()` 把异常角色**无视字数门限**排进**优先档**（`future > after-record > overage > bad-format`），
主角被反复拉去 AI 修复。

## 2. 修复（只放宽 `overage`）

`core/model/snapshot.js`：

```js
if (Number.isFinite(age) && age > 120 && !(parts.y < 0)) {
    if (!snapshotLongLived(s) && !snapshotLowEpochCalendar(anchor)) return 'overage';
}
```

| 新增 | 判据 | 说明 |
| --- | --- | --- |
| `snapshotLongLived(s)` | 档案内容（`species` / `race` / `title` / `occupation` / `family` / `birthNote` / `background.origin·history` / `tags` / 外貌）命中非人·长生信号（精灵、龙裔、仙神、亡灵、巫妖、吸血鬼、狼人、兽人、亚人、人造体、机器人、异种、史莱姆…） | **只看档案内容，不看姓名**（与 V1 的「未来来客豁免」同一纪律：角色名叫「龙傲天」而档案是凡人 → 照常判） |
| `snapshotLowEpochCalendar(anchor)` | 剧情锚点年份 **< 1000** → 视为自设纪元 / 编年起点 | 阈值的适用前提是「现实人类寿命」；0191 年这种纪元下 190 岁是设定。锚点缺失 → 不额外豁免（保持 V1 行为） |

**未放宽**（逐字保持 V1）：`future`（出生晚于剧情日期）、`after-record`（出生晚于该角色记录日期）、`bad-format`（解析失败）、
`birthSource='fallback'` 占位符、`SNAP_FUTURE_ORIGIN_RE` 穿越/未来来客豁免、公元前出生豁免。

**边界**：锚点 `1000-01-01` → 仍判（凡人 300 岁）；锚点 `0999-12-31` → 豁免。已用场景钉死。

## 3. oracle（V1 对照）

`tests/fixtures/gen-v1-golden-birth-anomaly.cjs`（真实 V1 v1.206 `snapshotBirthAnomaly` × 11 场景，共用场景表
`tests/fixtures/birth-anomaly-scenarios.mjs`）→ `tests/fixtures/v1-golden-birth-anomaly.json`。

| 场景 | V1 | V2 | 说明 |
| --- | --- | --- | --- |
| low-epoch-overage（用户场景 0001→0191） | `overage` | `''` | **差异 1**：非现实纪元豁免 |
| long-lived-species（精灵 1200 岁） | `overage` | `''` | **差异 2**：非人/长生豁免 |
| boundary-0999（锚点 0999） | `overage` | `''` | **差异 3**：纪元边界另一侧 |
| real-epoch-overage（0019→1919 笔误） | `overage` | `overage` | 一致（真异常保留） |
| boundary-1000（锚点 1000） | `overage` | `overage` | 一致（边界） |
| bc-birth / future-birth / after-record / bad-format / fallback-placeholder / traveler-future-origin | 同 | 同 | 一致 |

四种异常的 **label / short 文案**与 V1 逐字相同（fixture 记录 `labels`/`shorts`，单测比对）。

## 4. 门禁

`tests/unit/birth-anomaly.test.js`（10 断言）：

- A1 oracle 齐备（11 场景 / 3 处差异 / 标签表一致）；A2 11 场景实时结论 = 期望；A3 差异有据（不同者必带说明，恰 3 处）；
- A4 用户场景不再判异常且**年龄仍如实算出 190**（`snapshotAge` 也是 `190`，只是不再挂异常）；
- A5 真异常未被放宽（笔误 / 边界 1000 / 未来出生 / 倒挂 / 脏格式）；A6 长生豁免只看内容不看姓名（8 类命中 / 3 类不命中 / 姓名不影响）；
- B1 列表行角标不再出现（真异常仍出现）；B2 「🔧 修复角色」角标；B3 `buildCharacterRepairQueue().anomalyList` 不含主角、含真异常；
- B4 标签文案未动（与 oracle 逐字一致）。
