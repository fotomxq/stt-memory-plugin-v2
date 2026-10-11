// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-14`** —— 越界保留字段被约束
//   设计：`docs/D20` §3.4 / §8 `数-14`（① 楼层基线清零或分区 ② `floorStart` 上界校验 ③ `storyDay` 上界 + 来源标记）
//   实现：`core/reserved-fields.js`（上界与清零）· `core/migrate.js`（载入期清零）·
//         `core/ingest.js`（写入期楼层越界**只报告**）· `core/clock-extract.js`（`storyDay` 上界 + `storyDaySrc`）
//
// 本文件锁四件事（**每一条都写清「为什么这么处置」**）：
//   ① **楼层基线清零**（不是分区）：基线大于「本存档观察到的最大楼层 + 余量」时，它在**本存档里永远达不到**
//      —— 是功能上的死值；而按 chatKey 分区需要一个**不存在的归属记录**（属数据契约，不在本批）；
//   ② **`floorStart` 只报告不改写**：它极可能来自**另一条聊天**，改写会把真实来源夹成本聊天楼层，
//      而「来源可追溯」正是 `D12`/`D16` 一系列修复的基础；
//   ③ **`storyDay` 超界 → 0**（不是夹到上界）：53143 天不是「略大」而是解析错了，夹到上界＝把错误数据伪装成合理数据；
//   ④ **幂等**：清零只发生一次；清理后再次载入不再变化。
//
// 运行：node tests/unit/reserved-fields.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { migrateState, lastHealInfo } from '../../core/migrate.js';
import {
    FLOOR_BASELINE_FIELDS, FLOOR_BASELINE_SLACK, STORY_DAY_MAX, STORY_DAY_SRC_FIELD,
    checkFloorRange, clampReservedBaselines, clampStoryDay, observedMaxFloor, outOfRangeBaselines,
    reservedRangeIssues, storyDayOf,
} from '../../core/reserved-fields.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('reserved-fields v3.44.0 保留字段越界约束（D22 W4 数-14）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 真机形态：台账只到 14 楼，而两个基线与条目楼层写着 199 */
const SEED = () => Object.assign(emptyState(), {
    lastKnownFloor: 14,
    lastChatFloor: 14,
    weaveLastFloor: 199,
    parallelFloor: 199,
    processedFloors: [{ f: 0, h: 'a' }, { f: 14, h: 'b' }],
    atoms: [{ id: 'a1', title: '甲', text: '甲在码头发现木箱。', floorStart: 199, floorEnd: 199, storyDay: 53143 }],
});

A('V1 观察到的最大楼层：只认**存档自身**的证据（台账 / 基线 / 条目来源楼层），不依赖宿主 —— 内核保持纯净', (() => {
    const s = SEED();
    const empty = emptyState();
    return observedMaxFloor(s) === 199
        && observedMaxFloor({ lastKnownFloor: 14, processedFloors: [{ f: 9, h: 'x' }] }) === 14
        && observedMaxFloor({ lastChatFloor: 30 }) === 30
        && observedMaxFloor(empty) === -1 && observedMaxFloor(null) === -1;
})(), '');

A('V2 越界判定：基线 > 观察最大值 + 余量（' + FLOOR_BASELINE_SLACK + '）才算越界；受约束的字段只有 weaveLastFloor / parallelFloor', (() => {
    const s = SEED();
    const bad = outOfRangeBaselines(s);
    const ok = outOfRangeBaselines({ lastKnownFloor: 100, weaveLastFloor: 120, parallelFloor: -1 });
    return J(FLOOR_BASELINE_FIELDS) === J(['weaveLastFloor', 'parallelFloor'])
        && bad.length === 2 && bad[0].field === 'weaveLastFloor' && bad[0].value === 199
        && bad[0].max === 14 + FLOOR_BASELINE_SLACK                  // 上界取**台账**最大楼层（14），不是条目上的 199
        && ok.length === 0;                                        // 120 在 100+50 之内 → 不越界
})(), J(outOfRangeBaselines(SEED())));

A('V3 清零（就地、幂等）：越界基线 → `-1`（未知）；**不动**任何条目、台账与其它字段', (() => {
    const s = SEED();
    const atomsBefore = J(s.atoms), ledgerBefore = J(s.processedFloors);
    const r = clampReservedBaselines(s);
    const r2 = clampReservedBaselines(s);
    return r.changed === true && r.cleared.length === 2
        && s.weaveLastFloor === -1 && s.parallelFloor === -1
        && r2.changed === false && r2.cleared.length === 0
        && J(s.atoms) === atomsBefore && J(s.processedFloors) === ledgerBefore && s.lastKnownFloor === 14;
})(), '');

A('V4 载入期接线：`migrateState` 清零并计入 `lastHealInfo().floors`；第二次载入不再变化', (() => {
    const s = SEED();
    migrateState(s);
    const h1 = lastHealInfo();
    const snap = J(s);
    const s2 = clone(s);
    migrateState(s2);
    const h2 = lastHealInfo();
    return h1.floors === 2 && s.weaveLastFloor === -1 && s.parallelFloor === -1
        && h2.floors === 0 && J(s2) === snap;
})(), '');

A('V5 `floorStart` 上界校验（**写入期**专用）：可信上界 = 本批楼层 / 存档基线取大 + 余量；超界**只报告不改写**', (() => {
    const entries = [
        { dim: 'atoms', id: 'a1', floorStart: 199, floorEnd: 199 },
        { dim: 'atoms', id: 'a2', floorStart: 5, floorEnd: 6 },
    ];
    const r = checkFloorRange({ start: 0, end: 20 }, entries, { lastKnownFloor: 14 });
    const none = checkFloorRange({}, [], {});                       // 没有任何可信楼层 → 不报假警
    return r.limit === 20 + FLOOR_BASELINE_SLACK && r.bad.length === 2
        && r.bad[0].id === 'a1' && r.bad[0].field === 'floorStart' && r.bad[0].value === 199
        && entries[0].floorStart === 199                            // **未被改写**（来源可追溯优先）
        && none.limit === -1 && none.bad.length === 0;
})(), J(checkFloorRange({ start: 0, end: 20 }, [{ dim: 'atoms', id: 'a1', floorStart: 199 }], { lastKnownFloor: 14 }).bad));

A('V6 `storyDay`：读值（非有限 / 负数 → 0）；上界收敛 —— 超界 → **0**（不夹到上界，避免把错值伪装成合理值）', (() => {
    return storyDayOf({ storyDay: 12 }) === 12 && storyDayOf({ storyDay: -3 }) === 0 && storyDayOf({}) === 0
        && STORY_DAY_MAX === 20000
        && J(clampStoryDay(12)) === J({ value: 12, clamped: false })
        && J(clampStoryDay(53143)) === J({ value: 0, clamped: true })
        && J(clampStoryDay(0)) === J({ value: 0, clamped: false })
        && J(clampStoryDay('x')) === J({ value: 0, clamped: false });
})(), J([clampStoryDay(53143), clampStoryDay(12)]));

A('V7 `storyDay` 来源标记：写入侧常量名唯一（`storyDaySrc`，值 `ai`）；体检把「天数 + 来源」一起报出来', (() => {
    const s = SEED();
    const issues = reservedRangeIssues(s);
    const sd = issues.filter((x) => x.field === 'storyDay')[0] || {};
    return STORY_DAY_SRC_FIELD === 'storyDaySrc'
        && issues.length === 3                                       // 两基线 + 一天数
        && sd.value === 53143 && sd.dim === 'atoms' && sd.id === 'a1'
        && String(sd.detail).indexOf('来源标记') > 0;
})(), J(reservedRangeIssues(SEED()).map((x) => x.field)));

A('V8 体检出口：越界属**异常**（进 `findings`，warn 级），不是卫生计数 —— 它会抬高 `level`，必须被看到', (() => {
    const rep = dataHealthReport(SEED());
    const f = rep.findings.filter((x) => x.code === 'field-out-of-range');
    return f.length === 3 && f.every((x) => x.level === 'warn') && rep.level === 'warn'
        && rep.counts['field-out-of-range'] === 3
        && !(rep.hygiene && rep.hygiene.counts && rep.hygiene.counts['field-out-of-range']);
})(), J(dataHealthReport(SEED()).counts));

A('V9 正常数据零误报：基线在观察值之内 / `storyDay` 未超界 → 无任何越界发现，清理也不改动数据', (() => {
    const s = Object.assign(emptyState(), {
        lastKnownFloor: 14, weaveLastFloor: 12, parallelFloor: -1, storyDay: 0,
        atoms: [{ id: 'a1', text: '正文足够长的情节。', floorStart: 3, floorEnd: 4, storyDay: 30 }],
    });
    const before = J(s);
    const r = clampReservedBaselines(s);
    return reservedRangeIssues(s).length === 0 && r.changed === false && J(s) === before;
})(), '');

R.done();
