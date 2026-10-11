// ============================================================
// 单元测试 · v3.45.5（`docs/D22` W4 数据维度 `技-25` ③）「角色履历」六类核心算法
// 设计稿：`docs/D26-角色履历设计稿.md`（§3.2 字段 / §3.3 留存与凝练 / §3.4 预填护栏 / §3.5 展示口径）
// 被测模块：`core/resume.js`（履历算法**唯一源**，纯内核叶子模块，零宿主依赖）
//
// 覆盖（`技-25` ③ 点名的六类 + 两条值当的）：
//   A 组：归一（`数-19`）—— 幂等 / `date`+`summary` 必填 / `source` 中英文别名 / `refs` 去重且 ≤8 / `importance` 夹取
//   B 组：遗弃确定性（`数-20`）—— 40 条裁到 ≤ 上限 / 高重要条目全留 / 同输入两次逐字相同 / ≤ 上限时一条不动
//   C 组：免疫 —— 阈值 0.95 时只有真 ≥0.95 者免疫；`importance` 缺省按 0 参与、不免疫
//   D 组：凝练幂等（`数-20` Q4）—— 二次运行零改动 / 长度 ≤ 目标 / 不动其它任何字段
//   E 组：预填上界与护栏（`数-21`）—— 拒收 `date > clockDate`（`reason:'future'`）并把通过者强制 `source:'canon'`
//   F 组：无时钟不预填 —— `clockDate` 空 → `kept.length === 0` 且理由 `'no-clock'`
//   G 组：排序（剧情时间倒序 + 确定性 tie-break）与统计（`bySource` / `nearLimit` = **预警线**，不是删除线）
//   H 组：契约自检 —— 常量 / `resumeEntryLine` / `resumeHealthReport` 聚合读数（`core/data-health.js` 直接消费它）
// 运行：node tests/unit/resume.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {
    RESUME_FIELD, RESUME_DEFAULT_MAX, RESUME_DEFAULT_TRIGGER_RATIO, RESUME_DEFAULT_IMMUNE, RESUME_DEFAULT_SUMMARY_MAX,
    resumeNormList, resumeEntryNorm, resumeSort, resumeEntryLine, resumeStoryMs,
    resumeCull, resumeCondense, resumeCanonGuard, resumeStats, resumeHealthReport,
} from '../../core/resume.js';

const R = makeReporter('resume v3.45.5 角色履历：归一 / 遗弃 / 免疫 / 凝练 / 预填 / 无时钟');
// 断言包装（与 `tests/unit/data-health.test.js` 同款：第三个参数可传**惰性求值**的现场数据，失败时才展开）
const A = (n, c, e) => {
    const det = () => (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e);
    return R.assert(n, !!c, det());
};
const J = (v) => JSON.stringify(v);

// ---------- A 组：归一（`数-19`）----------
// 一锅端：中文键 / 英文键混用、越界与百分数重要度、重复 refs、中文 source、缺必填字段、数组内重复
const RAW = [
    { date: '1919-11-29', time: '傍晚', summary: '甲在码头清点货物，登记入册。', importance: '1.5', refs: ['m1', 'm1', 'm2'], source: '原作' },
    { 日期: '1919-11-20', 简述: '乙把粮袋搬上第三条船。', 重要性: '-3', 来源: '手填', 关联记忆: ['m3'] },
    { date: '1919-11-20', summary: '乙把粮袋搬上第三条船。', source: 'story' },   // 与上一条 date+summary 相同 → 数组内去重
    { date: '', summary: '没有日期 → 丢弃' },                                    // 必填缺失 → 不入库
    { date: '1919-11-01' },                                                      // 没有简述 → 不入库
    { date: '1919-11-10', summary: '丙在账房抄录名册。', importance: '80%', source: '剧情' },
    { date: '1919-11-05', summary: '丁在巷口等了一夜。', source: '无法识别的来源' },
];
const ONCE = resumeNormList(RAW);
const TWICE = resumeNormList(ONCE);
const at = (list, d) => (list.filter((e) => e && e.date === d)[0] || {});

A('A1 归一**幂等**：`resumeNormList(resumeNormList(x))` 与一次归一**逐字段**相同（含键集合与 `refs` 顺序）', (() => {
    if (ONCE.length !== TWICE.length) return false;
    return ONCE.every((e, i) => {
        const f = TWICE[i];
        return e.date === f.date && e.time === f.time && e.summary === f.summary
            && e.importance === f.importance && e.source === f.source && J(e.refs) === J(f.refs)
            && J(Object.keys(e).sort()) === J(Object.keys(f).sort());
    }) && J(ONCE) === J(TWICE);
})(), () => ({ once: ONCE, twice: TWICE }));

A('A2 必填 `date` / `summary` **缺一即丢弃**（该条不予入库）；非法入参不抛（返回 null）', (() => {
    return resumeEntryNorm({ date: '1919-01-01' }) === null
        && resumeEntryNorm({ summary: '只有简述。' }) === null
        && resumeEntryNorm({ date: '', summary: '' }) === null
        && resumeEntryNorm(null) === null && resumeEntryNorm('不是对象') === null
        && resumeEntryNorm({ date: '1919-01-01', summary: '完整条目。' }) !== null
        && ONCE.length === 4;                       // 7 条原始 → 去重 1 条、缺必填 2 条
})(), () => ({ once: ONCE.length, invalid: [resumeEntryNorm({ date: '1919-01-01' }), resumeEntryNorm({ summary: 'x' })] }));

A('A3 `source` 归一为枚举：中文别名（原作 → canon / 手填 → manual / 剧情 → story）、未知一律回落 `story`', (() => {
    return at(ONCE, '1919-11-29').source === 'canon'
        && at(ONCE, '1919-11-20').source === 'manual'
        && at(ONCE, '1919-11-10').source === 'story'
        && at(ONCE, '1919-11-05').source === 'story'
        && resumeEntryNorm({ date: '1919-01-02', summary: '甲。', source: '史实' }).source === 'canon'
        && resumeEntryNorm({ date: '1919-01-02', summary: '甲。', source: '人工' }).source === 'manual'
        && resumeEntryNorm({ date: '1919-01-02', summary: '甲。' }).source === 'story';
})(), () => ONCE.map((e) => ({ date: e.date, source: e.source })));

A('A4 `refs` **去重**且不超过 8 条（引用类字段不进内容副本，数量上限防一次性刷屏）', (() => {
    const r = resumeNormList([{ date: '1920-01-01', summary: '关联压测条目。', refs: ['r1', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'] }]);
    const refs = r[0].refs;
    return refs.length === 8 && new Set(refs).size === 8 && refs[0] === 'r1' && refs[7] === 'r8'
        && at(ONCE, '1919-11-29').refs.length === 2 && J(at(ONCE, '1919-11-20').refs) === J(['m3']);
})(), () => ({ refs: resumeNormList([{ date: '1920-01-01', summary: 's', refs: ['r1', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] }])[0].refs }));

A('A5 `importance` 夹取 0..1：越界（1.5 → 1）、负数（-3 → 0）、百分数（80% → 0.8）、**缺省 → `null` 不猜**', (() => {
    return at(ONCE, '1919-11-29').importance === 1
        && at(ONCE, '1919-11-20').importance === 0
        && at(ONCE, '1919-11-10').importance === 0.8
        && at(ONCE, '1919-11-05').importance === null
        && resumeEntryNorm({ date: '1919-01-02', summary: '甲。', importance: '' }).importance === null
        && resumeEntryNorm({ date: '1919-01-02', summary: '甲。', importance: '乱写' }).importance === null;
})(), () => ONCE.map((e) => ({ date: e.date, importance: e.importance })));

// ---------- B 组：遗弃确定性（`数-20`）----------
/** 造 n 条履历（日期互不相同、跨年递增；`high` 里的下标给 0.85 高重要度） */
function makeResume(n, opts) {
    const o = opts || {};
    const out = [];
    for (let i = 0; i < n; i++) {
        const y = 1920 + Math.floor(i / 12);
        const mo = String((i % 12) + 1).padStart(2, '0');
        const date = String(y) + '-' + mo + '-01';
        const e = { date: date, summary: '第 ' + i + ' 件大事记。' };
        if ((o.high || []).indexOf(i) >= 0) e.importance = 0.85;
        out.push(e);
    }
    return out;
}
const FORTY = resumeNormList(makeResume(40, { high: [0, 1, 2, 39] }));          // 4 条高重要（含最久远的三条）
const NOW_MS = resumeStoryMs(FORTY[0]);                                          // 剧情时间基准 = 最新一条
const CULL1 = resumeCull(FORTY, { max: 30, immune: RESUME_DEFAULT_IMMUNE, nowMs: NOW_MS });
const CULL2 = resumeCull(FORTY, { max: 30, immune: RESUME_DEFAULT_IMMUNE, nowMs: NOW_MS });

A('B1 40 条 → 裁到 ≤ 上限（软阈值 30）：`checked=true`、共遗弃 10 条、留 30 条', (() => {
    return FORTY.length === 40 && CULL1.checked === true
        && CULL1.list.length === 30 && CULL1.max === 30 && CULL1.dropped.length === 10
        && CULL1.list.length + CULL1.dropped.length === FORTY.length;
})(), () => ({ kept: CULL1.list.length, dropped: CULL1.dropped.length, max: CULL1.max }));

A('B2 高重要条目（importance 0.85 ≥ 免疫线 0.7）**全留** —— 哪怕它们是最久远的三条', (() => {
    const keptDates = CULL1.list.map((e) => e.date);
    const highDates = FORTY.filter((e) => e.importance === 0.85).map((e) => e.date);
    return highDates.length === 4
        && highDates.every((d) => keptDates.indexOf(d) >= 0)
        && CULL1.immuneKept === 4
        && CULL1.dropped.every((e) => !(e.importance >= 0.7));
})(), () => ({ highDates: FORTY.filter((e) => e.importance === 0.85).map((e) => e.date), kept: CULL1.list.map((e) => e.date) }));

A('B3 遗弃**确定性**：同输入两次 `dropped` 逐字相同（且正好是最久远的 10 条 —— 「同分更久远者先走」）', (() => {
    // `dropped` 保持**展示序**（剧情时间倒序）：i = 12 … 3
    const want = [];
    for (let i = 12; i >= 3; i--) {
        const y = 1920 + Math.floor(i / 12);
        const mo = String((i % 12) + 1).padStart(2, '0');
        want.push(String(y) + '-' + mo + '-01');
    }
    return J(CULL1.dropped) === J(CULL2.dropped) && J(CULL1.list) === J(CULL2.list)
        && J(CULL1.dropped.map((e) => e.date)) === J(want);
})(), () => ({ dropped: CULL1.dropped.map((e) => e.date), again: CULL2.dropped.map((e) => e.date) }));

A('B4 `len <= max` → `checked === false` 且**一条不动**（Q3：`≤ 上限` 从不自动遗弃，`triggerRatio` 只作预警）', (() => {
    const exact = resumeNormList(makeResume(30, { high: [0] }));
    const r = resumeCull(exact, { max: 30, immune: RESUME_DEFAULT_IMMUNE, nowMs: resumeStoryMs(exact[0]) });
    return r.checked === false && r.dropped.length === 0 && J(r.list) === J(exact)
        && resumeCull([], { max: 30 }).checked === false
        && resumeCull([], { max: 30 }).list.length === 0;
})(), () => { const e = resumeNormList(makeResume(30, { high: [0] })); const r = resumeCull(e, { max: 30 }); return { checked: r.checked, dropped: r.dropped.length, kept: r.list.length }; });

// ---------- C 组：免疫 ----------
const IMM = resumeNormList([
    { date: '1920-01-05', summary: '真正高重要（0.96）。', importance: 0.96 },
    { date: '1920-01-04', summary: '刚好达线（0.95）。', importance: 0.95 },
    { date: '1920-01-03', summary: '差一点（0.94 → 不免疫）。', importance: 0.94 },
    { date: '1920-01-02', summary: '缺省重要度之一（按 0 参与）。' },
    { date: '1920-01-01', summary: '缺省重要度之二（按 0 参与）。' },
]);

A('C1 `immune = 0.95` → **只有真 ≥0.95 者免疫**（0.96 / 0.95 免疫，0.94 照删）', (() => {
    const r = resumeCull(IMM, { max: 3, immune: 0.95, nowMs: resumeStoryMs(IMM[0]) });
    const keptImp = r.list.map((e) => e.importance);
    return r.checked === true && r.list.length === 3 && r.dropped.length === 2
        && r.immuneKept === 2
        && keptImp.indexOf(0.96) >= 0 && keptImp.indexOf(0.95) >= 0
        && r.dropped.every((e) => !(e.importance >= 0.95));
})(), () => { const r = resumeCull(IMM, { max: 3, immune: 0.95 }); return { kept: r.list.map((e) => e.importance), dropped: r.dropped.map((e) => e.importance), immuneKept: r.immuneKept }; });

A('C2 `importance` **缺省（`null`）按 0 参与、不免疫**：阈值调高后缺省条目照常被遗弃（不猜、不自保）', (() => {
    const nullCount = IMM.filter((e) => e.importance === null).length;
    const r = resumeCull(IMM, { max: 2, immune: 0.95, nowMs: resumeStoryMs(IMM[0]) });
    return nullCount === 2 && resumeEntryNorm({ date: '1920-01-01', summary: '甲。' }).importance === null
        && r.list.length === 2 && r.dropped.length === 3
        && r.list.every((e) => e.importance >= 0.95)                       // 只剩免疫者
        && r.dropped.filter((e) => e.importance === null).length === 2;    // 缺省者全数被弃
})(), () => { const r = resumeCull(IMM, { max: 2, immune: 0.95 }); return { kept: r.list.map((e) => e.importance), dropped: r.dropped.map((e) => e.importance) }; });

// ---------- D 组：凝练幂等（`数-20` Q4）----------
const LONG = '甲'.repeat(80);                       // 无句读 → 硬截 + `…`
const SRC_C = [{ date: '1919-11-29', time: '傍晚', summary: LONG, importance: 0.8, refs: ['m1', 'm2'], source: 'canon' }];
const COND1 = resumeCondense(SRC_C, { summaryMax: RESUME_DEFAULT_SUMMARY_MAX });
const COND2 = resumeCondense(COND1.list, { summaryMax: RESUME_DEFAULT_SUMMARY_MAX });

A('D1 凝练**幂等**：首次 `condensed === 1`，二次运行 `condensed === 0` 且逐字不变', (() => {
    return COND1.condensed === 1 && COND2.condensed === 0
        && J(COND1.list) === J(COND2.list)
        && COND1.list[0].summary.length <= RESUME_DEFAULT_SUMMARY_MAX;
})(), () => ({ first: COND1.condensed, second: COND2.condensed, text: COND1.list[0].summary }));

A('D2 凝练结果长度 ≤ 目标（默认 60 字），且**不动** `date` / `time` / `importance` / `refs` / `source`（逐字段比对）', (() => {
    const b = SRC_C[0], a = COND1.list[0];
    return a.summary !== b.summary && a.summary.length <= RESUME_DEFAULT_SUMMARY_MAX
        && a.date === b.date && a.time === b.time && a.importance === b.importance
        && a.source === b.source && J(a.refs) === J(b.refs)
        && J(Object.keys(a).sort()) === J(Object.keys(b).sort())
        && SRC_C[0].summary === LONG;                       // 纯函数：不改入参
})(), () => ({ src: SRC_C[0], out: COND1.list[0] }));

A('D3 优先在**句读边界**收口（先句末 → 再分句 → 顿号，都没有才硬截加 `…`）', (() => {
    const boundary = '甲'.repeat(30) + '。' + '乙'.repeat(50);
    const r = resumeCondense([{ date: '1919-11-29', summary: boundary }], { summaryMax: 60 });
    const hard = resumeCondense([{ date: '1919-11-29', summary: '丙'.repeat(80) }], { summaryMax: 60 });
    return r.condensed === 1 && r.list[0].summary === '甲'.repeat(30) + '。'
        && r.list[0].summary.indexOf('乙') < 0
        && resumeCondense(r.list, { summaryMax: 60 }).condensed === 0
        && hard.list[0].summary.slice(-1) === '…' && hard.list[0].summary.length === 60;
})(), () => { const b = '甲'.repeat(30) + '。' + '乙'.repeat(50); return resumeCondense([{ date: '1919-11-29', summary: b }], { summaryMax: 60 }).list[0].summary; });

// ---------- E 组：预填上界与护栏（`数-21`）----------
const GUARD = resumeCanonGuard([
    { date: '1919-11-01', summary: '剧情前的旧事之一。', source: 'story' },
    { date: '1919-11-29', summary: '上界当天（允许）。', source: 'manual' },
    { date: '1919-11-30', summary: '上界之后（拒收）。' },
    { date: '不是日期', summary: '坏日期。' },
    { summary: '缺日期（无效条目）。' },
], '1919-11-29');

A('E1 硬护栏①：`resumeCanonGuard` **拒收 `date > clockDate`** 的条目（`reason === \'future\'`），上界当天允许通过', (() => {
    const future = GUARD.rejected.filter((r) => r.reason === 'future');
    return GUARD.clockDate === '1919-11-29' && GUARD.kept.length === 2 && GUARD.rejected.length === 3
        && future.length === 1 && future[0].entry.date === '1919-11-30'
        && GUARD.kept.map((e) => e.date).indexOf('1919-11-29') >= 0
        && GUARD.kept.every((e) => e.date <= GUARD.clockDate)
        && GUARD.rejected.some((r) => r.reason === 'bad-date') && GUARD.rejected.some((r) => r.reason === 'invalid');
})(), () => GUARD);

A('E2 硬护栏②：**通过的条目 `source` 一律强制为 `\'canon\'`**（与剧情内条目在界面上可区分），结果按剧情时间倒序', (() => {
    return GUARD.kept.every((e) => e.source === 'canon')
        && GUARD.kept[0].date === '1919-11-29'
        && J(GUARD.kept.map((e) => e.date)) === J(['1919-11-29', '1919-11-01']);
})(), () => GUARD.kept);

// ---------- F 组：无时钟不预填 ----------
A('F1 `clockDate` 为空（空串 / null / undefined）→ **一律拒绝**、`kept.length === 0`，理由 `\'no-clock\'`', (() => {
    const one = [{ date: '1919-11-01', summary: '剧情前的旧事。' }];
    const a = resumeCanonGuard(one, '');
    const b = resumeCanonGuard(one, null);
    const c = resumeCanonGuard(one, undefined);
    return a.kept.length === 0 && a.rejected.length === 1 && a.rejected[0].reason === 'no-clock'
        && b.kept.length === 0 && b.rejected[0].reason === 'no-clock'
        && c.kept.length === 0 && c.rejected[0].reason === 'no-clock'
        && a.clockDate === '';
})(), () => ({ empty: resumeCanonGuard([{ date: '1919-11-01', summary: 'x' }], ''), nullClock: resumeCanonGuard([{ date: '1919-11-01', summary: 'x' }], null) }));

// ---------- G 组：排序与统计 ----------
const SORT_SRC = [
    { date: '1920-01-01', summary: 'B 同日期低重要。', importance: 0.2 },
    { date: '1920-01-01', summary: 'A 同日期高重要。', importance: 0.9 },
    { date: '1920-01-02', summary: 'C 最晚。' },
    { date: '不是日期', summary: 'D 无时钟（排最后）。' },
    { date: '1920-01-01', summary: 'C 同日期高重要。', importance: 0.9 },
];
const SORTED = resumeSort(SORT_SRC);

A('G1 `resumeSort` = **剧情时间倒序**，同日期按 `importance` 降序、再按 `summary` 字典序升序（确定性 tie-break）', (() => {
    return J(SORTED.map((e) => e.summary)) === J(['C 最晚。', 'A 同日期高重要。', 'C 同日期高重要。', 'B 同日期低重要。', 'D 无时钟（排最后）。'])
        && SORTED.length === SORT_SRC.length && SORT_SRC[0].summary === 'B 同日期低重要。';   // 不改入参
})(), () => SORTED.map((e) => ({ date: e.date, summary: e.summary, imp: e.importance })));

A('G2 排序**确定性**：重复排序结果逐字不变（已排好的再排仍是同一序）', (() => {
    return J(resumeSort(SORT_SRC)) === J(SORTED) && J(resumeSort(SORTED)) === J(SORTED);
})(), () => ({ once: resumeSort(SORT_SRC).map((e) => e.summary), twice: resumeSort(SORTED).map((e) => e.summary) }));

const STAT_SRC = [
    { date: '1920-01-03', summary: '甲的第一件事。', source: 'canon', importance: 0.8, refs: ['m1', 'm9'] },
    { date: '1920-01-02', summary: '甲的第二件事。', source: '手填' },
    { date: '1920-01-01', summary: '甲的第三件事。', source: 'story', importance: 0.1 },
];

A('G3 `resumeStats`：`bySource` 三态齐全；孤儿引用只在**给了记忆索引**时才判（`refs` 指向不存在的记忆 id）', (() => {
    const st = resumeStats(STAT_SRC, { max: 30, triggerRatio: 0.8, immune: 0.7, memoryTexts: ['m1'] });
    const noIndex = resumeStats(STAT_SRC, { max: 30, triggerRatio: 0.8, immune: 0.7 });
    return st.total === 3 && J(st.bySource) === J({ story: 1, canon: 1, manual: 1 })
        && st.orphanRefs === 1 && st.immune === 1 && st.over === false && st.nearLimit === false
        && st.condensed === 0 && st.clockless === 0 && st.dupSuspects === 0
        && st.longest === String('甲的第一件事。').length
        && noIndex.orphanRefs === 0;                      // 没有记忆索引 → 不臆断孤儿
})(), () => ({ withIndex: resumeStats(STAT_SRC, { memoryTexts: ['m1'] }), noIndex: resumeStats(STAT_SRC, {}) }));

A('G4 `triggerRatio` 语义 = **接近上限的预警线**，不是删除线：24/30 条报 `nearLimit`（`over=false`）且**一条不删**', (() => {
    const list = [];
    for (let i = 0; i < 24; i++) list.push({ date: '1920-01-' + String(i + 1).padStart(2, '0'), summary: '预警线条目 ' + i + '。' });
    const near = resumeStats(list, { max: 30, triggerRatio: 0.8 });
    const below = resumeStats(list.slice(0, 23), { max: 30, triggerRatio: 0.8 });
    const cull = resumeCull(list, { max: 30, triggerRatio: 0.8, immune: 0.7, nowMs: resumeStoryMs(list[23]) });
    return RESUME_DEFAULT_TRIGGER_RATIO === 0.8
        && near.nearLimit === true && near.over === false && near.total === 24
        && below.nearLimit === false
        && cull.checked === false && cull.dropped.length === 0 && cull.list.length === 24 && cull.nearLimit === true;
})(), () => { const l = []; for (let i = 0; i < 24; i++) l.push({ date: '1920-01-' + String(i + 1).padStart(2, '0'), summary: 'x' + i }); return { stats: resumeStats(l, { max: 30, triggerRatio: 0.8 }), cull: resumeCull(l, { max: 30, triggerRatio: 0.8 }) }; });

// ---------- H 组：契约自检 ----------
A('H1 常量契约：`RESUME_FIELD` / 上限 30（软阈值）/ 预警比例 0.8 / 免疫线 0.7 / 凝练目标 60 字', (() => {
    return RESUME_FIELD === 'resume' && RESUME_DEFAULT_MAX === 30 && RESUME_DEFAULT_TRIGGER_RATIO === 0.8
        && RESUME_DEFAULT_IMMUNE === 0.7 && RESUME_DEFAULT_SUMMARY_MAX === 60;
})(), () => ({ field: RESUME_FIELD, max: RESUME_DEFAULT_MAX, ratio: RESUME_DEFAULT_TRIGGER_RATIO, immune: RESUME_DEFAULT_IMMUNE, summaryMax: RESUME_DEFAULT_SUMMARY_MAX }));

A('H2 `resumeEntryLine` 人读行（面板 / 导出 / 命令**同源**）：日期 · 简述（重要 / 关联 / 原作），缺字段不补噪声', (() => {
    const line = resumeEntryLine({ date: '1919-11-29', time: '傍晚', summary: '甲在码头清点货物。', importance: 0.8, refs: ['m1', 'm2'], source: 'canon' });
    const bare = resumeEntryLine({ date: '1919-11-29', summary: '甲在码头清点货物。' });
    return line === '1919-11-29 傍晚 · 甲在码头清点货物。（重要 0.8 · 关联 2 · 原作）'
        && bare === '1919-11-29 · 甲在码头清点货物。'
        && resumeEntryLine(null) === '';
})(), () => ({ line: resumeEntryLine({ date: '1919-11-29', time: '傍晚', summary: '甲在码头清点货物。', importance: 0.8, refs: ['m1', 'm2'], source: 'canon' }), bare: resumeEntryLine({ date: '1919-11-29', summary: '甲在码头清点货物。' }) }));

A('H3 `resumeHealthReport` 聚合读数（`core/data-health.js` 的顶层 `resume` 键直接消费它）：只统计**有履历**的角色', (() => {
    const rep = resumeHealthReport([
        { id: 's1', name: '甲', resume: [
            { date: '1919-11-29', summary: '甲在码头清点货物，登记入册。', source: 'canon', importance: 0.8, refs: ['m1', 'm9'] },
            { date: '1919-11-01', summary: '甲在码头清点货物，登记入册。', source: 'story' },        // 前 12 字相同 → 疑似重复
            { date: '不是日期', summary: '日期写坏的条目。' },
        ],
          background: { history: '甲在码头清点货物，登记入册。这是历史正文。' } },
        { id: 's2', name: '乙', resume: [] },
        { id: 's3', name: '丙' },
    ], { max: 30, triggerRatio: 0.8, immune: 0.7, summaryMax: 60, memoryIds: ['m1'] });
    const empty = resumeHealthReport([]);
    return rep.snapshots === 3 && rep.withResume === 1 && rep.items.length === 1 && rep.items[0].id === 's1'
        && rep.total === 3 && rep.overCount === 0 && rep.nearCount === 0 && rep.max === 30
        && rep.orphanRefs === 1 && rep.dupSuspects === 1 && rep.dupWithHistory === 2 && rep.clockless === 1
        && rep.canonTotal === 1 && rep.storyTotal === 2 && rep.manualTotal === 0
        && rep.items[0].toCondense === 0 && rep.items[0].immune === 1
        && empty.snapshots === 0 && empty.total === 0 && empty.items.length === 0 && empty.note === undefined;
})(), () => resumeHealthReport([{ id: 's1', resume: [{ date: '不是日期', summary: '甲在码头清点货物，登记入册。' }, { date: '1919-11-01', summary: '甲在码头清点货物，登记入册。' }], background: { history: '甲在码头清点货物，登记入册。' } }], { memoryIds: ['m1'] }));

R.done();
