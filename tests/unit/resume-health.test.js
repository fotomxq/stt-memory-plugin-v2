// ============================================================
// 单元测试 · v3.45.5（`docs/D22` W4 数据维度 `技-25` ①）「履历体检」
// 设计稿：`docs/D26-角色履历设计稿.md` §8 技-25 行（「体检增设：履历条数 · 超限状态 · 疑似重复」）
// 被测：`core/data-health.js#dataHealthReport` 的**新增顶层键** `out.resume`
//   + 六个履历体检码（`resume-over-limit` / `resume-needs-condense` / `resume-suspect-dup` /
//     `resume-dup-with-history` / `resume-orphan-ref` / `resume-clockless`）
//
// 口径（本测试逐条钉死）：
//   · 老存档 / 无履历 → **一个履历发现都不多**（缺 `resume` 字段与 `resume: []` 完全等价）；
//   · 明细**按角色聚合**：62 条履历（2 个角色各 31 条）只产生 2 条 `resume-over-limit`（每角色一条），
//     绝不是「一条履历一个 finding」；
//   · `dim` 一律 `'snapshots'`；明细风格 `{dim, id, field, value, detail}`；
//   · 只有 `resume-orphan-ref` 是 **warn**，其余 5 个是 **info** → 体检 `level` 由 warn 主导（`ok` 仍为 `true`）；
//   · 开关 `cfg.snapshotResumeEnabled = false` → **零履历发现**且 `out.resume.note === 'disabled'`
//     （如实标注「未体检」，不静默当作「健康」）；
//   · **只读**：调用前后把 `state` 深拷贝比对，逐字段相同。
// 运行：node tests/unit/resume-health.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { dataHealthReport } from '../../core/data-health.js';
import { resumeHealthReport } from '../../core/resume.js';

const R = makeReporter('resume-health v3.45.5 履历体检（docs/D22 W4 技-25 ①）');
// 断言包装（与 `tests/unit/data-health.test.js` 同款：第三个参数可传**惰性求值**的现场数据）
const A = (n, c, e) => {
    const det = () => (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e);
    return R.assert(n, !!c, det());
};
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:resume-health');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在码头清点货物。' }] }), doc);
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), st || {}));
    return state;
}

/** 六个履历体检码（顺序与文件头一致） */
const RESUME_CODES = ['resume-over-limit', 'resume-needs-condense', 'resume-suspect-dup', 'resume-dup-with-history', 'resume-orphan-ref', 'resume-clockless'];
const isResumeCode = (c) => String(c).indexOf('resume-') === 0;

/** 干净存档：结构与字段都合规，且**没有** `resume` 字段（老存档形态） */
const CLEAN = () => ({
    snapshots: [{ id: 's1', name: '角色甲', appearance: '身着青布长衫。', background: { history: '早年在码头做工。' } }],
    memories: [{ id: 'm1', title: '码头', content: '甲在码头清点货物。' }],
});

/**
 * 一个角色的履历：**31 条**（超上限 30）→ 六类异常各一处。
 *   ① 80 字简述（无句读 → 待凝练）② 前 12 字相同的两条（疑似重复）③ `refs` 指向不存在的记忆 id（孤儿引用）
 *   ④ `date: '不是日期'`（无时钟）⑤ 简述前 8 字见 `background.history`（与历史疑似重复）
 */
const CASE = {
    condense: '凝练' + '甲'.repeat(78),                                   // 80 字（> 凝练目标 60）
    dupA: '同日两记：乙先到码头卸货，丙随后登船。',
    dupB: '同日两记：乙先到码头卸货，丙随后登船。',
    orphan: '一条带孤儿引用的履历。',
    clockless: '日期写坏的履历。',
    history: '丁在城外遇袭后改名，从此不与人往来。',
};
const HISTORY_TEXT = '早年：丁在城外遇袭后改名换姓，独自谋生。';         // 含 CASE.history 的前 8 字
function resumeEntries() {
    const arr = [
        { date: '1919-11-01', summary: CASE.condense, importance: 0.8, source: 'canon', refs: ['m1'] },
        { date: '1919-11-02', summary: CASE.dupA },
        { date: '1919-11-03', summary: CASE.dupB },
        { date: '1919-11-04', summary: CASE.orphan, refs: ['不存在'] },
        { date: '不是日期', summary: CASE.clockless },
        { date: '1919-11-05', summary: CASE.history },
    ];
    for (let i = 6; i < 31; i++) arr.push({ date: '1919-12-' + String(i - 5).padStart(2, '0'), summary: '第 ' + i + ' 件日常事记，记录在册。' });
    return arr;
}
/** 两个角色（各 31 条）→ 用来证明「按角色聚合」：发现的条数 = 角色数，不是履历条数 */
const DIRTY = () => ({
    snapshots: [
        { id: 's1', name: '角色甲', appearance: '身着青布长衫。', background: { history: HISTORY_TEXT }, resume: resumeEntries() },
        { id: 's2', name: '角色乙', appearance: '背着一只旧木箱。', background: { history: HISTORY_TEXT }, resume: resumeEntries() },
    ],
    memories: [{ id: 'm1', title: '码头', content: '甲在码头清点货物。' }],
});

// ---------- A 组：干净存档（老存档形态，无 `resume` 字段）----------
boot(CLEAN());
const CLEAN_REP = dataHealthReport();

A('A1 无履历的存档：**不含任何 `resume-*` 码**，`ok` / `level` 仍是改前的 `true` / `ok`，摘要明细为空', (() => {
    return CLEAN_REP.ok === true && CLEAN_REP.level === 'ok'
        && CLEAN_REP.findings.length === 0 && J(CLEAN_REP.counts) === J({})
        && Object.keys(CLEAN_REP.counts).filter(isResumeCode).length === 0
        && CLEAN_REP.findings.filter((f) => isResumeCode(f.code)).length === 0
        && CLEAN_REP.scanned.dims === 16 /* v3.47.0（W16 数-22）：14 ATOM_DIM_KEYS(+maps) + currencies + npcs */ && CLEAN_REP.scanned.items === 2;
})(), () => ({ level: CLEAN_REP.level, counts: CLEAN_REP.counts, scanned: CLEAN_REP.scanned }));

A('A2 新增顶层键 `resume` 恒在：老存档给出全零读数（`withResume: 0`）且**不打** `note`，`scanned.resumeItems` 为 0', (() => {
    return !!CLEAN_REP.resume && CLEAN_REP.resume.snapshots === 1 && CLEAN_REP.resume.withResume === 0
        && CLEAN_REP.resume.total === 0 && CLEAN_REP.resume.items.length === 0
        && CLEAN_REP.resume.note === undefined && CLEAN_REP.resume.max === 30
        && CLEAN_REP.scanned.resumeItems === 0;
})(), () => CLEAN_REP.resume);

A('A3 `resume: []`（空履历）与**缺 `resume` 字段**完全等价：读数、`counts`、`level` 逐字相同', (() => {
    const withEmpty = JSON.parse(JSON.stringify(CLEAN()));
    withEmpty.snapshots[0].resume = [];
    const r = dataHealthReport(withEmpty);
    return J(r.counts) === J(CLEAN_REP.counts) && r.level === CLEAN_REP.level && r.ok === CLEAN_REP.ok
        && r.findings.length === 0 && J(r.resume) === J(CLEAN_REP.resume) && r.scanned.resumeItems === 0;
})(), () => { const w = JSON.parse(JSON.stringify(CLEAN())); w.snapshots[0].resume = []; return dataHealthReport(w).resume; });

// ---------- B 组：六类异常逐类检出（异常大礼包：2 角色 × 31 条）----------
boot(DIRTY());
const STATE_BEFORE = JSON.parse(JSON.stringify(state));
const REPORT = dataHealthReport();
const STATE_AFTER = JSON.parse(JSON.stringify(state));
const idsOf = (code) => [...new Set(REPORT.findings.filter((f) => f.code === code).map((f) => f.id))].sort();
const one = (code) => REPORT.findings.filter((f) => f.code === code)[0] || {};

A('B1 六类码**各出现**，且**按角色聚合**：62 条履历只产生 2 条/码（每角色一条，绝不是一条履历一个 finding）', (() => {
    return RESUME_CODES.every((c) => REPORT.counts[c] === 2)
        && RESUME_CODES.every((c) => REPORT.findings.filter((f) => f.code === c).length === 2)
        && RESUME_CODES.every((c) => J(idsOf(c)) === J(['s1', 's2']))
        && REPORT.findings.length === 12;
})(), () => ({ counts: REPORT.counts, byCode: RESUME_CODES.map((c) => [c, REPORT.findings.filter((f) => f.code === c).map((f) => f.id)]) }));

A('B2 体检里**只有**这六个码：构造数据本身没有其它异常（`counts` 键集合逐字相等）', (() => {
    return J(Object.keys(REPORT.counts).sort()) === J(RESUME_CODES.slice().sort());
})(), () => REPORT.counts);

A('B3 读数与明细：`resume.max = 30`、`total = 62`、`overCount = 2`、`scanned.resumeItems = 62`，明细字段风格 `{dim,id,field,value,detail}`', (() => {
    const fieldsOk = RESUME_CODES.every((c) => REPORT.findings.filter((f) => f.code === c).every((f) =>
        f.dim === 'snapshots' && typeof f.id === 'string' && typeof f.field === 'string'
        && typeof f.value === 'number' && typeof f.detail === 'string' && f.detail.length > 10));
    return REPORT.resume.max === 30 && REPORT.resume.snapshots === 2 && REPORT.resume.withResume === 2
        && REPORT.resume.total === 62 && REPORT.resume.overCount === 2 && REPORT.resume.nearCount === 0
        && REPORT.resume.items.length === 2 && REPORT.scanned.resumeItems === 62
        && fieldsOk;
})(), () => ({ resume: REPORT.resume, scanned: REPORT.scanned }));

A('B4 逐码的 `field` / `value` 与次数都对得上（超限取 31、待凝练 1、疑似重复 1、与历史重复 1、孤儿引用 1、无时钟 1）', (() => {
    return one('resume-over-limit').field === 'resume.total' && one('resume-over-limit').value === 31
        && one('resume-needs-condense').field === 'resume.toCondense' && one('resume-needs-condense').value === 1
        && one('resume-suspect-dup').field === 'resume.dupSuspects' && one('resume-suspect-dup').value === 1
        && one('resume-dup-with-history').field === 'resume.dupWithHistory' && one('resume-dup-with-history').value === 1
        && one('resume-orphan-ref').field === 'resume.orphanRefs' && one('resume-orphan-ref').value === 1
        && one('resume-clockless').field === 'resume.clockless' && one('resume-clockless').value === 1
        // 四个口径要点必须写进 detail（能被人读懂、能照做）
        && one('resume-over-limit').detail.indexOf('软阈值') >= 0
        && one('resume-over-limit').detail.indexOf('30') >= 0
        && one('resume-suspect-dup').detail.indexOf('只提示') >= 0
        && one('resume-clockless').detail.indexOf('排序') >= 0
        && one('resume-orphan-ref').detail.indexOf('不存在') >= 0;
})(), () => RESUME_CODES.map((c) => one(c)));

A('B5 等级：只有 `resume-orphan-ref` 是 **warn**（其余 5 个 info）→ 体检 `level` 为 `warn` 主导，`ok` 仍为 `true`', (() => {
    return one('resume-orphan-ref').level === 'warn'
        && RESUME_CODES.filter((c) => c !== 'resume-orphan-ref').every((c) => one(c).level === 'info')
        && REPORT.level === 'warn' && REPORT.ok === true;
})(), () => ({ level: REPORT.level, ok: REPORT.ok, levels: RESUME_CODES.map((c) => [c, one(c).level]) }));

A('B6 **只读**：调用前后把 `state` 深拷贝比对，逐字段相同（不改任何字段、不落盘）', (() => {
    return J(STATE_BEFORE) === J(STATE_AFTER)
        && J(STATE_BEFORE.snapshots) === J(state.snapshots)
        && state.snapshots[0].resume.length === 31 && state.snapshots[1].resume.length === 31;
})(), () => ({ before: STATE_BEFORE.snapshots.length, after: STATE_AFTER.snapshots.length }));

// ---------- C 组：与 `core/resume.js` 同源 ----------
A('C1 顶层 `resume` 与 `resumeHealthReport(state.snapshots, rOpts)` **逐字同源**（同一算法源；`rOpts` 就是内核里的那六个配置键 + 记忆 id 表）', (() => {
    const mine = resumeHealthReport(state.snapshots, {
        max: cfg.snapshotResumeMax, triggerRatio: cfg.snapshotResumeTriggerRatio,
        immune: cfg.snapshotResumeImmune, summaryMax: cfg.snapshotResumeSummaryMax,
        memoryIds: (state.memories || []).map((m) => m && m.id).filter(Boolean).map(String),
    });
    return J(mine) === J(REPORT.resume) && mine.orphanRefs === 2 && mine.dupSuspects === 2
        && mine.dupWithHistory === 2 && mine.clockless === 2;
})(), () => ({ mine: resumeHealthReport(state.snapshots, { memoryIds: ['m1'] }), got: REPORT.resume }));

A('C2 六个配置键在默认配置里齐备（体检读数与遗弃 / 凝练共享同一组阈值）', (() => {
    return cfg.snapshotResumeEnabled === true && cfg.snapshotResumeMax === 30 && cfg.snapshotResumeTriggerRatio === 0.8
        && cfg.snapshotResumeImmune === 0.7 && cfg.snapshotResumeSummaryMax === 60 && cfg.snapshotResumeCanonFill === true;
})(), () => ({ enabled: cfg.snapshotResumeEnabled, max: cfg.snapshotResumeMax, ratio: cfg.snapshotResumeTriggerRatio, immune: cfg.snapshotResumeImmune, summaryMax: cfg.snapshotResumeSummaryMax, canonFill: cfg.snapshotResumeCanonFill }));

// ---------- D 组：开关关闭 → 未体检（如实标注，不静默当作「健康」）----------
// 配置改动用**保存 → 覆盖 → 还原**的写法（受污染的 `cfg` 会让后续断言读到别人的口径）
const PREV_ENABLED = cfg.snapshotResumeEnabled;
cfg.snapshotResumeEnabled = false;
const OFF_REP = dataHealthReport();
cfg.snapshotResumeEnabled = PREV_ENABLED;                                  // 还原

A('D1 开关关闭：`out.resume.note === \'disabled\'`、读数全零、**零履历发现**，`scanned.resumeItems` 为 0', (() => {
    return PREV_ENABLED === true && OFF_REP.resume.note === 'disabled'
        && OFF_REP.resume.snapshots === 0 && OFF_REP.resume.withResume === 0 && OFF_REP.resume.total === 0
        && OFF_REP.resume.items.length === 0 && OFF_REP.scanned.resumeItems === 0
        && J(OFF_REP.counts) === J({}) && OFF_REP.findings.length === 0;
})(), () => ({ note: OFF_REP.resume.note, counts: OFF_REP.counts, scanned: OFF_REP.scanned }));

A('D2 关闭后 `level` 回到 `ok`（履历异常不再计入），但 `note` 明说「未体检」—— 两者必须同时成立才不算误导', (() => {
    return OFF_REP.level === 'ok' && OFF_REP.ok === true
        && Object.keys(OFF_REP.counts).filter(isResumeCode).length === 0
        && OFF_REP.resume.note === 'disabled';
})(), () => ({ level: OFF_REP.level, note: OFF_REP.resume.note }));

A('D3 还原开关后读数**逐字回到**开启时的结果（配置改动不残留、不污染其它断言）', (() => {
    const again = dataHealthReport();
    return cfg.snapshotResumeEnabled === true && J(again.counts) === J(REPORT.counts)
        && J(again.resume) === J(REPORT.resume) && again.level === 'warn';
})(), () => ({ enabled: cfg.snapshotResumeEnabled, counts: dataHealthReport().counts }));

R.done();
