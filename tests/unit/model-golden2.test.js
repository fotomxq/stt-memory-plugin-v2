// ============================================================
// 单元测试 · core/model 批次 2（角色档案 / 年龄 / 货币 / 情节分段）与 V1 黄金样本一致
// 黄金样本：tests/fixtures/v1-golden-model2.json（V1 源码切片产出；生成口径见 docs/P1-内核平移.md §3）
// 口径：**严格相等**（JSON.stringify 逐字符比较，键顺序一致）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { setKernelState, cfg } from '../../core/model/runtime.js';
import { normalizeSnapshot, snapshotAgeInfo, snapshotAgeIsLocked, snapshotBirthAnomaly, snapshotBirthAnomalyLabel, snapshotBirthAnomalyShort, snapshotAppearanceText, parseBirthDateParts, birthDatePrecision, calcAge, foldSnapshotFlat, refreshAllSnapshotAges } from '../../core/model/snapshot.js';
import { formatMoney, roundMoney, moneyNet, normalizeMoneyFlow, normalizeCurrency, trackedCurrencyRoles, isTrackedCurrencyOwner, addTrackedCurrencyRole, removeTrackedCurrencyRole, clearTrackedCurrencyRoles, knownCharacterNames, defaultCurrencyOwner } from '../../core/model/money.js';
import { normalizePlotSegment, normalizePlotSegmentLines, plotSegmentId, plotSegmentRange, plotSegmentTimeKey, sortPlotSegments, plotSegmentsToText, parsePlotSegmentText } from '../../core/model/segment.js';
import { atomContentHash } from '../../core/model/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-model2.json'), 'utf8'));
const R = makeReporter('model-golden2 V1 移植保真度（批次 2）');
const J = (v) => JSON.stringify(v);
/**
 * 时间戳归一：情节分段（以及任何带 createdAt/updatedAt 的产物）会写入 `Date.now()`，
 * 跨进程无法逐字符相等 —— 比较前统一抹平为 0（**这两个字段是墙钟，不属于移植口径**）。
 */
const stripTs = (v) => {
    if (Array.isArray(v)) return v.map(stripTs);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (k === 'createdAt' || k === 'updatedAt') ? 0 : stripTs(v[k]);
        return o;
    }
    return v;
};
const JT = (v) => J(stripTs(v));
const I = G.inputs;

// 复刻黄金样本的注入状态（切片侧 state 桩）
setKernelState({
    state: { date: '1920-03-15', time: '黄昏', location: '码头' },
    protagonist: { name: '角色甲' },
    snapshots: [], npcs: [], atoms: [], memories: [], concepts: [], parallels: [], currencies: [], plotSegments: [],
});
Object.assign(cfg.dimCharLimits, G.dimCharLimits);

/** 逐项对比（返回首个差异） */
function cmp(list, got) {
    if (got.length !== list.length) return { ok: false, why: '条数 ' + got.length + ' != ' + list.length };
    for (let i = 0; i < list.length; i++) if (J(got[i]) !== J(list[i])) return { ok: false, why: '第 ' + i + ' 项不一致', got: got[i], want: list[i] };
    return { ok: true };
}

// ---------- 角色档案 ----------
const normSnaps = I.SNAPSHOTS.map(x => normalizeSnapshot(x));
R.assert('N1 normalizeSnapshot 与 V1 逐字符一致（含扁平字段折叠 / 外貌聚合 / 已去世三态 / 标签并集）',
    cmp(G.snapshots, normSnaps).ok === true, cmp(G.snapshots, normSnaps));
R.assert('N2 年龄信息 snapshotAgeInfo（出生日期精度 / 剧情日期锚点 / 已去世锁定）',
    cmp(G.ageInfo, normSnaps.map(x => snapshotAgeInfo(x))).ok === true, cmp(G.ageInfo, normSnaps.map(x => snapshotAgeInfo(x))));
R.assert('N3 锁定判定 snapshotAgeIsLocked', J(normSnaps.map(x => snapshotAgeIsLocked(x))) === J(G.ageLocked), normSnaps.map(x => snapshotAgeIsLocked(x)));
R.assert('N4 出生日期异常检测（含标签 / 短标签）', (() => {
    const got = normSnaps.map(x => ({ a: snapshotBirthAnomaly(x), label: snapshotBirthAnomalyLabel(x), short: snapshotBirthAnomalyShort(x) }));
    return J(got) === J(G.birthAnomaly);
})(), normSnaps.map(x => snapshotBirthAnomaly(x)));
R.assert('N5 外貌聚合 snapshotAppearanceText', J(I.SNAPSHOTS.map(x => snapshotAppearanceText(x))) === J(G.appearanceText), I.SNAPSHOTS.map(x => snapshotAppearanceText(x)));
R.assert('N6 出生日期解析与精度（年 / 年-月 / 年-月-日 / 公元前 / 空）', (() => {
    const got = ['1900-05-20', '1890-01', '1905-12-31', '-0221-01-02', '', null].map(x => ({ v: x, p: parseBirthDateParts(x), prec: birthDatePrecision(x) }));
    return J(got) === J(G.birthParts);
})(), G.birthParts);
R.assert('N7 年龄计算 calcAge（含跨生日 / 公元前 / 空锚点）', (() => {
    const got = [['1900-05-20', '1920-03-15'], ['1900-05-20', '1920-06-01'], ['1890-01', '1920-03-15'], ['-0221-01-02', '1920-03-15'], ['1900-05-20', ''], ['', '1920-03-15'], ['1905-12-31', '1900-01-01']]
        .map(([b, a]) => ({ b, a, age: calcAge(b, a) }));
    return J(got) === J(G.calcAge);
})(), G.calcAge);
R.assert('N8 扁平字段折叠 foldSnapshotFlat（散字段 → 分组对象 + 列表拆分）', (() => {
    const lit = { name: '折叠', gender: '女', traits: 'a,b', todos: 'x;y' };
    return J(foldSnapshotFlat(lit)) === J(G.helpers.foldFlat);
})(), foldSnapshotFlat({ name: '折叠', gender: '女', traits: 'a,b', todos: 'x;y' }));
R.assert('N9 档案内容哈希与 V1 一致', atomContentHash('snapshots', normSnaps[0]) === G.hashes.snapshot, atomContentHash('snapshots', normSnaps[0]));

// ---------- 货币 ----------
R.assert('M1 normalizeCurrency 与 V1 一致（id 派生 / 归属默认 / 额度数字 / 流水）',
    cmp(G.currencies, I.CURRENCIES.map(x => normalizeCurrency(x))).ok === true, cmp(G.currencies, I.CURRENCIES.map(x => normalizeCurrency(x))));
R.assert('M2 formatMoney / roundMoney / moneyNet 全用例一致', (() => {
    const got = I.MONEY_HELPERS.map(v => ({ v: String(v), f: formatMoney(v), r: roundMoney(v), n: moneyNet(v) }));
    return J(got) === J(G.money);
})(), I.MONEY_HELPERS.map(v => ({ v: String(v), f: formatMoney(v) })));
R.assert('M3 moneyNet 按流水数组求和（含非法项 / 空 / 非数组）', J([[{ delta: 1000 }, { delta: -250 }], [{ delta: -1 }, { delta: '2' }], [], 'x', null].map(h => moneyNet(h))) === J(G.moneyNetFlows), G.moneyNetFlows);
R.assert('M4 normalizeMoneyFlow（中文键 / 数值 / 空对象）', (() => {
    const got = [
        normalizeMoneyFlow({ at: '1919-11-29', delta: 1000, note: '卖货' }),
        normalizeMoneyFlow({ 日期: '1919-12-01', 增减: '支出', 数额: 250, 说明: '雇车' }),
        normalizeMoneyFlow({}),
    ];
    return J(got) === J(G.moneyFlows);
})(), G.moneyFlows);
R.assert('M5 标定角色增删清（走 cfg + saveCfg 钩子，与 V1 行为一致）', (() => {
    cfg.currencyTrackedRoles = [];
    const got = {
        def: trackedCurrencyRoles(),
        added: addTrackedCurrencyRole('角色甲'),
        isT: isTrackedCurrencyOwner('角色甲'),
        isF: isTrackedCurrencyOwner('角色乙'),
        removed: removeTrackedCurrencyRole('角色甲'),
        cleared: clearTrackedCurrencyRoles(),
    };
    return J(got) === J(G.helpers.trackedRoles);
})(), cfg.currencyTrackedRoles);
R.assert('M6 已知角色名（档案 + 名册，去重排序）', (() => {
    setKernelState(Object.assign({}, JSON.parse(J(G.inputs)), {}));
    const st = { state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, snapshots: normSnaps, npcs: [{ name: '船主' }], memories: [] };
    setKernelState(st);
    const got = knownCharacterNames();
    setKernelState({
        state: { date: '1920-03-15', time: '黄昏', location: '码头' },
        protagonist: { name: '角色甲' }, snapshots: [], npcs: [], atoms: [], memories: [],
    });
    return J(got) === J(G.helpers.knownNames);
})(), knownCharacterNames());
R.assert('M7 默认归属（主角设定优先 / 显式指定优先）', (() => {
    setKernelState({ state: { date: '1920-03-15' }, protagonist: { name: '主角甲' }, snapshots: [], npcs: [] });
    const got = [defaultCurrencyOwner(), defaultCurrencyOwner('指定者')];
    setKernelState({ state: { date: '1920-03-15', time: '黄昏', location: '码头' }, protagonist: { name: '角色甲' }, snapshots: [], npcs: [] });
    return J(got) === J(G.helpers.defaultOwner);
})(), G.helpers.defaultOwner);
R.assert('M8 货币 / 分段内容哈希与 V1 一致（含 currencies 不在 V1 哈希分支 → 空串）',
    atomContentHash('currencies', normalizeCurrency(I.CURRENCIES[0])) === G.hashes.currency
    && atomContentHash('plotSegments', normalizePlotSegment(I.SEGMENTS[0])) === G.hashes.segment,
    [atomContentHash('currencies', normalizeCurrency(I.CURRENCIES[0])), atomContentHash('plotSegments', normalizePlotSegment(I.SEGMENTS[0]))]);

// ---------- 情节分段总结 ----------
R.assert('S1 normalizePlotSegment 与 V1 一致（时间范围头 / 逐条剧情线 / 只增不减字段；时间戳已抹平）',
    JT(G.segments) === JT(I.SEGMENTS.map(x => normalizePlotSegment(x))), { got: stripTs(I.SEGMENTS.map(x => normalizePlotSegment(x)))[0], want: stripTs(G.segments)[0] });
R.assert('S2 分段排序 sortPlotSegments（时间倒序）', J(sortPlotSegments(I.SEGMENTS.map(x => normalizePlotSegment(x)).filter(Boolean)).map(x => x && x.header)) === J(G.sortedSegments), G.sortedSegments);
R.assert('S3 分段拼回文本 plotSegmentsToText', plotSegmentsToText(I.SEGMENTS.map(x => normalizePlotSegment(x)).filter(Boolean)) === G.segmentsText, plotSegmentsToText(I.SEGMENTS.map(x => normalizePlotSegment(x)).filter(Boolean)));
R.assert('S4 解析分段文本 parsePlotSegmentText（逐条剧情线；时间戳已抹平）', JT(parsePlotSegmentText('### 1919-11-29 ~ 1919-11-30\n1. 交易线: 甲与乙敲定转运。\n2. 情感线: 关系转暖。')) === JT(G.parsedSegments), parsePlotSegmentText('x'));
R.assert('S5 分段 id / 区间 / 时间键 与 V1 一致', (() => {
    const seg = normalizePlotSegment(I.SEGMENTS[0]);
    return plotSegmentId({ start: '1919-11-29', end: '1919-11-30' }, '甲与乙敲定转运') === G.helpers.plotSegmentId
        && J(plotSegmentRange(seg)) === J(G.helpers.plotSegmentRange)
        && plotSegmentTimeKey(seg) === G.helpers.timeKey
        && J(normalizePlotSegmentLines(I.SEGMENTS[0].lines)) === J(G.helpers.segmentLines);
})(), G.helpers);

// ---------- 刷新年龄（写回 state.snapshots；校验状态级函数可被注入态安全调用） ----------
R.assert('N10 refreshAllSnapshotAges 在注入态下安全运行（返回统计对象，不抛异常）', (() => {
    const st = { state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, snapshots: JSON.parse(J(normSnaps)), npcs: [] };
    setKernelState(st);
    const r = refreshAllSnapshotAges();
    setKernelState({ state: { date: '1920-03-15', time: '黄昏', location: '码头' }, protagonist: { name: '角色甲' }, snapshots: [], npcs: [] });
    return !!(r && typeof r === 'object');
})(), '');

R.done();
