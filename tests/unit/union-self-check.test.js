// 单元测试 · 跨端合并「并集自检」判据（`docs/D22` W6 **技-31**；v3.45.1）
//   背景（`docs/D29` §2 第 2 行真机证据）：`{"action":"合并自检","atomsBeforeLocal":115,"atomsBeforeRemote":20,
//     "atomsAfter":20,"conflict":0,"unionMin":115}` → 旧判据（`after < unionMin`）**必然误报**：
//     合并实现本身还会做 ①内容去重 ②墓碑过滤 ③上限裁剪，三者都会让条数**合法**下降。
//   本版：下限 = 并集下限 − 三类削减（**分别回报**，`docs/D29` R1），只有仍低于下限才登记待确认项。
//   反向探针：真丢失（同 id 被丢弃且无墓碑/去重/裁剪可解释）**必须**报警。
import { makeReporter } from '../harness/st-mock.js';
import { unionSelfCheck, capReductionOf, mergeDataObjects } from '../../core/cross-sync.js';

const R = makeReporter('cross-sync 并集自检判据（W6 技-31 v3.45.1）');
const A = (n, c, e) => R.assert(n, !!c, e);

// A1 真机原始用例：三类合法削减全部解释得了 → **不**判异常
A('A1 三类合法削减（墓碑 30 / 去重 60 / 裁剪 5）解释得了 115 → 20 → **不**登记异常（修掉真机误报）', (() => {
    const r = unionSelfCheck({ beforeLocal: 115, beforeRemote: 20, after: 20, reductions: { tombstone: 30, dedupe: 60, cap: 5 } });
    return r.unionMin === 115 && r.reductions.total === 95 && r.lowerBound === 20 && r.after === 20
        && r.anomaly === false && r.unexplained === 0 && r.detail.indexOf('通过') === 0;
})(), (() => unionSelfCheck({ beforeLocal: 115, beforeRemote: 20, after: 20, reductions: { tombstone: 30, dedupe: 60, cap: 5 } }))());

// A2 反向探针：三类削减都算上仍低于下限 → **必须**报警，并把「无解释消失的条数」报出来
A('A2 反向探针：真丢失（115 → 20，但削减只解释了 80）→ anomaly=true，unexplained=15（**真丢失去报警**）', (() => {
    const r = unionSelfCheck({ beforeLocal: 115, beforeRemote: 20, after: 20, reductions: { tombstone: 20, dedupe: 55, cap: 5 } });
    return r.lowerBound === 35 && r.anomaly === true && r.unexplained === 15
        && r.detail.indexOf('仍有 15 条无解释地消失') === 0;
})(), (() => unionSelfCheck({ beforeLocal: 115, beforeRemote: 20, after: 20, reductions: { tombstone: 20, dedupe: 55, cap: 5 } }))());

// A3 R1 明确要求：三个削减量**分别回报**（不合并成一个数）
A('A3 三个削减量分别回报（`reductions` 分开给，不合并成一个数）', (() => {
    const r = unionSelfCheck({ beforeLocal: 10, beforeRemote: 4, after: 10, reductions: { tombstone: 1, dedupe: 2, cap: 3 } });
    return r.reductions.tombstone === 1 && r.reductions.dedupe === 2 && r.reductions.cap === 3 && r.reductions.total === 6
        && r.lowerBound === 4 && r.anomaly === false;
})(), '见断言');

// A4 边界：无任何削减时判据退回「原始条数比较」（真丢失照样报）；负数/非数字一律按 0，不产生假报
A('A4 边界：无削减 → 退回原始比较；非法输入按 0 处理（不假报、不抛）', (() => {
    const a = unionSelfCheck({ beforeLocal: 10, beforeRemote: 3, after: 9 });
    const b = unionSelfCheck({ beforeLocal: 10, beforeRemote: 3, after: 10 });
    const c = unionSelfCheck(null);
    const d = unionSelfCheck({ beforeLocal: -5, beforeRemote: 'x', after: NaN, reductions: { dedupe: -3, tombstone: null, cap: undefined } });
    return a.anomaly === true && a.unexplained === 1
        && b.anomaly === false
        && c.unionMin === 0 && c.after === 0 && c.anomaly === false
        && d.unionMin === 0 && d.reductions.total === 0 && d.anomaly === false;
})(), '见断言');

// A5 合并路径真的把三类削减记进 stat（去重 / 墓碑**按维度**分列）——
//   这是 A1 的输入来源：不接上这一步，判据再对也没有数可用
A('A5 `mergeDataObjects`：`stat.reductions`（去重 / 墓碑，按维度分列）+ `stat.conflict` 合计（冲突提示此前永不触发）', (() => {
    const base = {
        updatedAt: 1000,
        atoms: [{ id: 'L1', text: '同文', updatedAt: 900 }, { id: 'L2', text: '同文', updatedAt: 800 }],
        deleted: { atoms: { R1: 5000 } },
    };
    const remote = { updatedAt: 2000, atoms: [{ id: 'R1', text: '远端' }, { id: 'R2', text: '远端2' }] };
    const r = mergeDataObjects(base, remote, {});
    const red = r.stat.reductions;
    const dim = red.byDim.atoms || {};
    return dim.dedupe === 1                                  // L1/L2 同内容异 id → 去重削 1
        && dim.tombstone === 1                               // R1 命中 id 墓碑（无墙钟）→ 墓碑削 1
        && red.dedupe === 1 && red.tombstone === 1
        && (r.data.atoms || []).length === 2                 // L1 + R2（L2 被去重、R1 被墓碑）
        && Number(r.stat.conflict) === 0
        && typeof r.stat.reductions === 'object';
})(), '见断言');

// A6 冲突合计确实会被赋值（旧代码在自检里读 `stat.conflict`，而 `mergeDataObjects` 从未写过它 → 「跨端合并冲突」永不登记）
A('A6 `stat.conflict` = conflictWinLocal + conflictWinRemote（同 id 不同内容 → > 0，使「跨端合并冲突」能登记）', (() => {
    const base = { updatedAt: 1000, atoms: [{ id: 'X', text: '旧文', updatedAt: 100 }] };
    const remote = { updatedAt: 2000, atoms: [{ id: 'X', text: '新文', updatedAt: 900 }] };
    const r = mergeDataObjects(base, remote, {});
    return Number(r.stat.conflict) === 1 && r.stat.conflictWinRemote === 1
        && String((r.data.atoms[0] || {}).text) === '新文';
})(), '见断言');

// A7 上限裁剪干跑：**只读数**（不改入参）、隐藏条目永不裁剪（与 `capAtomsKeepingHidden` 同口径）
A('A7 `capReductionOf`：只读数（不修改入参）+ 隐藏条目永不裁剪', (() => {
    const arr = [];
    for (let i = 1; i <= 10; i++) arr.push({ id: 'a' + i, text: 't' + i });
    arr.push({ id: 'h1', text: 'hidden', hidden: true });
    const before = JSON.parse(JSON.stringify(arr));
    const r = capReductionOf(arr, 4);
    return r.cap === 4 && r.before === 11 && r.hit === 6 && r.after === 5     // 可见 10 条留最新 4 条 + 隐藏 1 条
        && JSON.stringify(arr) === JSON.stringify(before)                   // 入参一字未改（干跑，非裁剪）
        && capReductionOf([], 4).hit === 0 && capReductionOf(null, 4).hit === 0;
})(), (() => capReductionOf([{ id: 'a' }], 4))());

R.done();
