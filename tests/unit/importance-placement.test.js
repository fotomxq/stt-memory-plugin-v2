// ============================================================
// 单元测试 · v2.86.0「重要度口径与设定落位」（`docs/D7` v0.5；取代 v2.78.0 的「初始重要性 + 每次调用增量」）
// 口径（用户裁决）：
//   · 重要度 = **窗口调用占比**（每次提取后重算最近 N 条；第 N 条按真实 ±R 邻居算；更旧的冻结）；
//   · **逐维独立**、状态记录按「主体」分组；窗口内全 0 调用 → 0；
//   · 展示口径**统一为存储值**（Q5 方案 A「单轨替换」）：`importancePct` 不再由 uses 现算；
//   · 旧的 `importanceBase` / `importancePerUse` **控件下线**（键保留兼容），代之以三个窗口参数（计数类 → 文本输入）；
//   · 清扫保护阈值（C1）按新值域重标定为 0.2（V1 为 0.7），按比例类渲染为滚动条。
// 运行：node tests/unit/importance-placement.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { calcImportance, importancePct, recallImportance } from '../../core/recall.js';
import {
    windowShare, recalcImportanceAfterExtract, importancePreview,
    impWindowRadius, impRecalcCount, impRecalcEnabled, IMP_DIMS,
    IMP_WINDOW_RADIUS_DEFAULT, IMP_RECALC_COUNT_DEFAULT,
} from '../../core/importance.js';
import { SETTINGS_CONTROLS, RANGE_SPECS, settingsPageHtml, applySettingsControl } from '../../ui/settings-pages.js';

const R = makeReporter('importance-placement v2.86.0 重要度口径与设定落位');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot(patch) {
    Object.assign(cfg, clone(defaultCfg));
    if (patch) Object.assign(cfg, patch);
    setScopeKey('char:imp');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();

const mem = (id, uses, importance) => ({ id, title: '记忆' + id, content: '正文', uses, importance: importance === undefined ? 0.5 : importance, floorStart: 1, floorEnd: 1 });

// ---------- A 组：窗口占比的数学口径 ----------
A('A1 `windowShare`：**含自身**的 21 条窗口（半径 10）＝ uses(i) ÷ Σ uses(窗口内)（用户例：窗口合计 15、自身 5 → 33.3%；第 20 条 → 18.8%）', (() => {
    const list = [1, 0, 2, 1, 0, 0, 3, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 1, 0, 3, 0, 1, 2, 0, 5];   // 26 条（旧→新）
    const newest = windowShare(list, list.length - 1, IMP_WINDOW_RADIUS_DEFAULT);
    return newest === 0.333 && windowShare(list, list.length - 20, 10) === 0.188;   // 从最新起算的第 20 条（分母含窗外）
})(), () => windowShare([1, 0, 2, 1, 0, 0, 3, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 1, 0, 3, 0, 1, 2, 0, 5], 25, 10));

A('A2 边界：数组两端截断（不补 0、不循环）；窗口内全 0 调用 → 0；`uses` 非法 → 视作 0；越界下标 → 0', (() => {
    const head = windowShare([4, 0, 0], 0, 10);                  // 仅 3 条可用 → 4/4 = 1
    const zeros = windowShare([0, 0, 0, 0], 2, 10);              // 全 0 → 0（R23）
    const junk = windowShare([Number.NaN, 2, 3], 1, 10);         // NaN 视作 0 → 2/5 = 0.4
    const edge = windowShare([1, 1], 5, 10);                     // 越界 → 0
    return head === 1 && zeros === 0 && junk === 0.4 && edge === 0;
})(), '见断言');

A('A3 取值 3 位小数（四舍五入）；默认 10 / 20；配置越界：上界夹取、非正/非法回落默认', (() => {
    boot();
    const a = windowShare([1, 1, 1], 1, 10);                     // 1/3 → 0.333
    boot({ impWindowRadius: 99, impRecalcCount: 999 });
    const r = impWindowRadius(), n = impRecalcCount();           // → 50 / 200（上界夹取）
    boot({ impWindowRadius: 'x', impRecalcCount: -5 });           // 非法 / 非正 → 回落默认
    const r2 = impWindowRadius(), n2 = impRecalcCount();
    boot({ impRecalcCount: null });
    return a === 0.333 && IMP_WINDOW_RADIUS_DEFAULT === 10 && IMP_RECALC_COUNT_DEFAULT === 20
        && r === 50 && n === 200 && r2 === 10 && n2 === 20 && impRecalcCount() === 20 && impRecalcEnabled() === true;
})(), () => ({ a: windowShare([1, 1, 1], 1, 10), r: impWindowRadius(), n: impRecalcCount() }));

// ---------- B 组：重算范围与冻结 ----------
A('B1 **只重算最近 20 条**：21 条里最旧一条保持原值（冻结）；**第 20 条用真实 ±10 邻居**（分母读到窗外）', (() => {
    boot();
    const list = [];
    for (let i = 0; i < 21; i++) list.push(mem('m' + i, i === 0 ? 9 : 1));   // 最旧一条 uses 9，其余各 1
    state.memories = list;
    const before = list.map((e) => e.importance);
    const r = recalcImportanceAfterExtract({ dims: ['memories'] });
    // 「最近第 20 条」（序号 1）窗口 = 序号 0..11 → 9 + 11 = 20 → 1/20 = 0.05（**分母含窗外那条 uses=9**）
    // 最新条（序号 20）窗口 = 序号 10..20 → 11 条各 1 → 1/11 ≈ 0.091
    return r.dims.memories.frozen === 1 && r.dims.memories.updated === 20
        && list[0].importance === before[0] && list[0].importance === 0.5
        && list[1].importance === 0.05 && list[20].importance === 0.091;
})(), '见断言');

A('B2 出窗（更旧）后**值恒定**：再次重算不再变化；其 uses 仍作为窗内条目的分母参与', (() => {
    boot();
    const list = [];
    for (let i = 0; i < 22; i++) list.push(mem('m' + i, 1));
    state.memories = list;
    recalcImportanceAfterExtract({ dims: ['memories'] });
    const frozenVal = list[0].importance;                        // 已出窗（最近 20 = 序号 2..21）
    list[0].uses = 99;                                           // 窗外条目 uses 变化
    recalcImportanceAfterExtract({ dims: ['memories'] });
    return list[0].importance === frozenVal && frozenVal === 0.5;
})(), '见断言');

A('B3 幂等 + 逐维独立：同一 state 连续两次结果一致；只动目标维（其它维度零改动）；参与维 9 个', (() => {
    boot();
    state.memories = [mem('a', 2), mem('b', 1), mem('c', 1)];
    state.items = [{ id: 'i1', name: '剑', uses: 5, importance: 0.77 }];
    recalcImportanceAfterExtract({ dims: ['memories'] });
    const first = state.memories.map((e) => e.importance);
    const r2 = recalcImportanceAfterExtract({ dims: ['memories'] });
    return J(first) === J(state.memories.map((e) => e.importance)) && r2.dims.memories.updated === 0
        && state.items[0].importance === 0.77 && IMP_DIMS.length === 9;
})(), '见断言');

A('B4 状态记录**按主体分组**（D7 Q2 裁决）：不同角色的状态各自成序、互不混算', (() => {
    boot();
    state.currentStates = [
        { id: 's1', subject: '甲', field: '情绪', value: 'x', uses: 1, importance: 0.5 },
        { id: 's2', subject: '乙', field: '情绪', value: 'y', uses: 9, importance: 0.5 },
        { id: 's3', subject: '甲', field: '状态', value: 'z', uses: 3, importance: 0.5 },
    ];
    const r = recalcImportanceAfterExtract();
    // 甲组窗口合计 4 → s1=0.25 / s3=0.75；乙组独占 → 1
    return state.currentStates[0].importance === 0.25 && state.currentStates[2].importance === 0.75
        && state.currentStates[1].importance === 1 && r.dims.currentStates.groups === 2;
})(), '见断言');

A('B5 关闭开关 → 不重算（保留历史值）；`strength`（V1 兼容字段）随占比同步', (() => {
    boot({ impRecalcEnabled: false });
    state.memories = [mem('a', 2), mem('b', 2)];
    const r = recalcImportanceAfterExtract({ dims: ['memories'] });
    const kept = state.memories.every((e) => e.importance === 0.5);
    boot();
    state.memories = [{ id: 'a', uses: 3, importance: 0.5, strength: 50 }, { id: 'b', uses: 1, importance: 0.5, strength: 50 }];
    recalcImportanceAfterExtract({ dims: ['memories'] });
    return r.skipped === 'disabled' && kept && state.memories[0].importance === 0.75 && state.memories[0].strength === 75;
})(), '见断言');

A('B6 只读诊断：列出「当前值 / 重算值 / 是否冻结」，不写回任何条目', (() => {
    boot();
    state.memories = [mem('a', 1, 0.9), mem('b', 3, 0.9)];
    const pv = importancePreview('memories');
    return pv.length === 2 && pv[0].now === 0.9 && pv[0].next === 0.25 && pv[1].next === 0.75
        && pv.every((x) => x.frozen === false) && state.memories[0].importance === 0.9;
})(), () => importancePreview('memories'));

// ---------- C 组：展示口径统一（Q5 方案 A） ----------
A('C1 `importancePct` 读**存储值**（窗口占比），不再由 uses 现算；`recallImportance` 与之一致（同源）', (() => {
    const e = { uses: 100, importance: 0.18 };
    const legacy = Math.round(calcImportance(e) * 100);          // V1 兼容函数仍在，但不再用于展示
    return importancePct(e) === 18 && importancePct({ uses: 100 }) === 0
        && recallImportance(e) === 0.18 && legacy === 100;
})(), () => ({ pct: importancePct({ uses: 100, importance: 0.18 }), legacy: Math.round(calcImportance({ uses: 100, importance: 0.18 }) * 100) }));

// ---------- D 组：设定落位与阈值重标定 ----------
A('D1 提取记忆页：旧两项（`importanceBase` / `importancePerUse`）**已下线**，代之以 3 个窗口参数（计数类 → 文本输入，不进 RANGE_SPECS）', (() => {
    const keys = SETTINGS_CONTROLS.extract.map((c) => String(c.key));
    const h = settingsPageHtml('extract');
    const find = (k) => SETTINGS_CONTROLS.extract.filter((c) => String(c.key) === k)[0];
    return keys.indexOf('importanceBase') < 0 && keys.indexOf('importancePerUse') < 0
        && keys.indexOf('impRecalcEnabled') >= 0 && keys.indexOf('impWindowRadius') >= 0 && keys.indexOf('impRecalcCount') >= 0
        && find('impRecalcEnabled').type === 'checkbox' && find('impWindowRadius').type === 'text'
        && RANGE_SPECS.impWindowRadius === undefined && RANGE_SPECS.impRecalcCount === undefined
        && h.indexOf('data-ftt-cfg="impWindowRadius"') > 0 && h.indexOf('data-ftt-cfg="importanceBase"') < 0
        && h.indexOf('重要性计算（窗口调用占比）') > 0;
})(), () => SETTINGS_CONTROLS.extract.map((c) => c.key));

A('D2 三个窗口参数可写回并生效（开关 / 半径 / 条数）', (() => {
    boot();
    const r1 = applySettingsControl('impWindowRadius', 5);
    const r2 = applySettingsControl('impRecalcCount', 7);
    applySettingsControl('impRecalcEnabled', false);
    const off = impRecalcEnabled() === false;
    applySettingsControl('impRecalcEnabled', true);
    return r1.ok === true && Number(cfg.impWindowRadius) === 5 && Number(cfg.impRecalcCount) === 7
        && impWindowRadius() === 5 && impRecalcCount() === 7 && off && impRecalcEnabled() === true && r2.ok === true;
})(), () => ({ r: cfg.impWindowRadius, n: cfg.impRecalcCount }));

A('D3 C1 阈值重标定（D7 §4.9）：`lowUseForgetProtectImportance` 默认 **0.2**（≈4 倍窗口均值）且按比例类渲染为**滚动条**', (() => {
    boot();
    const html = settingsPageHtml('forget');
    const re = /type="range"[^>]*data-ftt-cfg="lowUseForgetProtectImportance"/;
    return Number(defaultCfg.lowUseForgetProtectImportance) === 0.2
        && RANGE_SPECS.lowUseForgetProtectImportance !== undefined
        && RANGE_SPECS.lowUseForgetProtectImportance.max === 1
        && re.test(html) && html.indexOf('默认 0.2') > 0;
})(), () => defaultCfg.lowUseForgetProtectImportance);

R.done();
