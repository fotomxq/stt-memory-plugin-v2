// ============================================================
// 单元测试 · v2.84.0「存储上限改总上限 + 各大类占比滚动条」与「设定里百分比统一滚动条」
//            v2.85.0「占比滚动条**拖动中实时联动**」与「保底高于上限时**被动下移**」
//
// 用户要求（原话）：
//   1. 存储保底上限需优化 UI 交互，改为总上限，涵盖所有原子数据总量，默认 3000 条。
//   2. 存储保底上限的各大类通过百分比滚动条拖动，以默认总上限为比例调节，动态确保满足 100%；
//      如遇到小数点，应按四舍五入取值。
//   3. 设定中所有针对百分比的 UI 交互，应该统一为可交互滚动条拖动，注意提示对应的默认值位置。
//   4. 各大类百分比滚动条没有联动，调节一个其他应该等比例变化。
//   5. 存储总上限的保底数据应该被动联动，如情节调节后，如果保底数据高于该数字则自动下移数字。
//
// 落点：`core/config.js`（storeTotalMax / storeShare）· `core/ingest.js`（占比归一 + 有效上限 + 保底夹取 + 兼容口径）
//   · `adapters/config-store.js`（启动自愈：历史存档里的越界保底自动下移）
//   · `ui/settings-pages.js`（RANGE_SPECS + 滚动条控件）· `ui/forget.js`（占比滚动条区）
//   · `ui/panel.js`（拖动中实时联动 + 松手提交 + 保底下移提示）
// 覆盖：
//   A 组：占比归一（四舍五入 / 合计恒 100 / 余数给最大项 / 非法回落默认）；
//   B 组：拖动一条 → 其余按原比例补齐（含 0 / 100 / 全 0 边界），合计恒 100；
//   C 组：有效上限 = 四舍五入(总上限 × 占比 / 100)（占比推导即权威值）；合计 == 总上限；
//   D 组：`storeCapFor` 三态（新口径 / 显式 0 / 缺键 → 旧逐维兼容）；
//   E 组：默认值口径（3000 / 份额和 100 / 表内默认占比与 defaultCfg 一致）；
//   F 组：UI —— 遗忘页「总上限滑块 + 10 条占比滚动条（含默认刻度）」+ 面板动作 `storeShare` 端到端写回；
//   G 组：**百分比统一滚动条** —— RANGE_SPECS 每个键在所属页面渲染为 `type="range"`、带默认值刻度与「默认 X」文字；
//   H 组：计数类控件未被误改（仍是数字输入）；
//   I 组：拖动**等比联动**的纯函数口径（不写配置 / 与一步到位逐值一致 / 不累计漂移）；
//   J 组：保底**被动下移**（只降不升 / 幂等 / 兼容口径下不动 / 拖动总上限同样触发）；
//   K 组：占比区 UI（每行保底文字 + 合计行联动标记 + 「已随上限下移」标注）。
// 运行：node tests/unit/store-cap.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    storeTotalMax, storeShareOf, storeShareDefault, normStoreShares, setStoreShare, storeEffectiveCaps, storeCapFor,
    storeMinFor, storeFloorRaw, allotStoreShares, clampStoreFloors, storeTotalMode,
    STORE_SHARE_DIMS, STORE_LIMITS, STORE_TOTAL_MAX_DEFAULT,
} from '../../core/ingest.js';
import { RANGE_SPECS, SETTINGS_CONTROLS, SETTINGS_TABS, settingsPageHtml, settingsControlHtml, controlDefault } from '../../ui/settings-pages.js';
import { shareFloorText } from '../../ui/forget.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('store-cap v2.85.0 存储总上限 / 占比滚动条联动 / 保底被动下移 / 百分比统一滚动条');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const sumOf = (obj) => Object.values(obj).reduce((n, v) => n + Number(v || 0), 0);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true },
});
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:storecap');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
}
boot();

// ---------- A 组：占比归一 ----------
A('A1 `normStoreShares`：四舍五入到整数、**合计恒为 100**（余数补给最大项），覆盖全部参与维度', (() => {
    const raw = { atoms: 22.4, memories: 15.5, snapshots: 7.6, items: 9.4, concepts: 13.2, scenes: 7.5, plans: 5.7, suspense: 5.7, npcs: 5.7, rumors: 5.7 };
    const n = normStoreShares(raw);
    return J(Object.keys(n)) === J(STORE_SHARE_DIMS) && sumOf(n) === 100
        && Object.values(n).every((v) => Number.isInteger(v) && v >= 0 && v <= 100)
        && n.atoms === 22 && n.memories === 16;                        // Math.round(22.4)=22 / Math.round(15.5)=16
})(), () => normStoreShares({ atoms: 22.4, memories: 15.5 }));

A('A2 非法 / 缺失 / 越界一律安全：非对象→默认表；负数→0；>100→100；未知维度忽略；结果仍合计 100', (() => {
    const a = normStoreShares(null);
    const b = normStoreShares({ atoms: -5, memories: 999, zzz: 50 });
    // 负数夹到 0；>100 夹到 100；未给出的维度回落默认占比；随后整体归一 → 合计恒 100
    return sumOf(a) === 100 && a.atoms === storeShareDefault('atoms')
        && b.atoms === 0 && b.memories > 0 && b.memories <= 100 && b.zzz === undefined
        && Object.keys(b).length === STORE_SHARE_DIMS.length && sumOf(b) === 100;
})(), () => normStoreShares({ atoms: -5, memories: 999 }));

// ---------- B 组：拖动配平 ----------
A('B1 拖动一条 → 其余按**原比例**补齐，四舍五入后合计恒 100（用户要求「动态确保满足 100%」）', (() => {
    boot();
    const before = normStoreShares(defaultCfg.storeShare);
    const after = setStoreShare('atoms', 40);
    const others = STORE_SHARE_DIMS.filter((d) => d !== 'atoms');
    const ratioKept = others.every((d) => {
        const expect = Math.round((before[d] / (100 - before.atoms)) * 60);   // 60 = 100 - 40
        return Math.abs(after[d] - expect) <= 1;                             // 允许 ±1（四舍五入与余数配平）
    });
    return after.atoms === 40 && sumOf(after) === 100 && ratioKept
        && J(Object.keys(after)) === J(STORE_SHARE_DIMS);
})(), () => ({ before: normStoreShares(defaultCfg.storeShare), after: setStoreShare('atoms', 40) }));

A('B2 边界：拖到 100 → 其余归 0；拖到 0 → 其余按比例占满 100；原本全 0 时按均分补齐', (() => {
    boot();
    cfg.storeShare = { atoms: 0, memories: 0, snapshots: 0, items: 0, concepts: 0, scenes: 0, plans: 0, suspense: 0, npcs: 0, rumors: 0 };
    const full = setStoreShare('atoms', 100);
    const zero = setStoreShare('atoms', 0);
    const evenOk = STORE_SHARE_DIMS.filter((d) => d !== 'atoms').every((d) => even_d(d) === 1);
    function even_d(d) { return (zero[d] === 11 || zero[d] === 12) ? 1 : 0; }   // 100/9 ≈ 11，余数给一项 → 12
    return full.atoms === 100 && sumOf(full) === 100 && STORE_SHARE_DIMS.filter((d) => d !== 'atoms').every((d) => full[d] === 0)
        && zero.atoms === 0 && sumOf(zero) === 100 && evenOk;
})(), () => ({ full: setStoreShare('atoms', 100), zero: setStoreShare('atoms', 0) }));

A('B3 未知维度 / 非数字输入不改变配置（返回归一后的现值），不抛错', (() => {
    boot();
    const keep = J(normStoreShares(cfg.storeShare));
    const a = setStoreShare('不存在', 50);
    const b = setStoreShare('atoms', 'abc');
    return J(a) === keep && b.atoms === 0 && sumOf(b) === 100;
})(), '见断言');

// ---------- C 组：有效上限 ----------
A('C1 有效上限 = 四舍五入(总上限 × 占比 ÷ 100)（占比推导即权威值）；占比合计 100 时上限合计 = 总上限', (() => {
    boot();
    cfg.storeTotalMax = 3000;
    const eff = storeEffectiveCaps();
    const exact = STORE_SHARE_DIMS.every((d) => eff.caps[d] === Math.max(1, Math.round(3000 * eff.shares[d] / 100)));
    return eff.total === 3000 && sumOf(eff.shares) === 100 && eff.sum === 3000
        && eff.caps.atoms === Math.round(3000 * eff.shares.atoms / 100) && exact
        && storeCapFor('atoms') === eff.caps.atoms;
})(), () => storeEffectiveCaps());

A('C2 总上限可调、占比随之缩放：总上限 1000 时情节 = 230（3000 → 1000 等比）；保底高于份额结果时**保底下移**（v2.85.0 用户要求）', (() => {
    boot();
    cfg.storeTotalMax = 1000;
    const a = storeCapFor('atoms');                       // 23% → 230
    cfg.storeShare = normStoreShares(Object.assign({}, defaultCfg.storeShare, { plans: 0 }));
    cfg.storeMinPlans = 500;                              // 保底 500 > 0%×1000 → 上限权威，保底跟下来
    const moved = clampStoreFloors();
    const p = storeCapFor('plans');
    const clamped = Number(cfg.storeMinPlans);             // 下移后的落盘值（下面切兼容口径会重设该键，故先取）
    // 兼容口径（storeTotalMax=0）下仍是 V1 的「保底兜底上限」，不改历史语义
    cfg.storeTotalMax = 0; cfg.storeMaxPlans = 300; cfg.storeMinPlans = 500;
    const legacy = storeCapFor('plans');
    const planMove = moved.filter((m) => m.dim === 'plans')[0] || null;
    return a === 230 && p === 1 && clamped === 1 && legacy === 500
        && !!planMove && planMove.from === 500 && planMove.to === 1;
})(), () => ({ atoms: storeCapFor('atoms'), moved: clampStoreFloors() }));

A('C3 总上限缺省/非法 → 默认 3000；`storeTotalMax` 读取稳健（字符串数字也认）', (() => {
    boot();
    delete cfg.storeTotalMax;
    const a = storeTotalMax();
    cfg.storeTotalMax = '2500';
    const b = storeTotalMax();
    cfg.storeTotalMax = -1;
    const c = storeTotalMax();
    return a === STORE_TOTAL_MAX_DEFAULT && b === 2500 && c === STORE_TOTAL_MAX_DEFAULT;
})(), () => ({ d: STORE_TOTAL_MAX_DEFAULT }));

// ---------- D 组：兼容口径 ----------
A('D1 `storeCapFor` 三态：总上限有效 → 新口径；显式置 0 或**缺键** → 旧逐维 `storeMax*` 兼容口径（老存档不炸）', (() => {
    boot();
    cfg.storeTotalMax = 3000; cfg.storeShare = clone(defaultCfg.storeShare);
    const neo = storeCapFor('memories');                  // 15% × 3000 = 450
    cfg.storeTotalMax = 0; cfg.storeMaxMemories = 800;
    const legacyZero = storeCapFor('memories');
    delete cfg.storeTotalMax;
    const legacyMissing = storeCapFor('memories');
    return neo === 450 && legacyZero === 800 && legacyMissing === 800;
})(), () => ({ neo: 450, legacy: 800 }));

// ---------- E 组：默认值口径 ----------
A('E1 默认口径：总上限 3000；份额合计 100；表内每个维度的默认占比与 `defaultCfg.storeShare` 逐值一致', (() => {
    const t = Number(defaultCfg.storeTotalMax);
    const table = STORE_SHARE_DIMS.every((d) => Number(STORE_LIMITS[d][4]) === Number(defaultCfg.storeShare[d]));
    return t === 3000 && STORE_TOTAL_MAX_DEFAULT === 3000
        && sumOf(defaultCfg.storeShare) === 100 && table
        && J(STORE_SHARE_DIMS) === J(Object.keys(defaultCfg.storeShare));
})(), () => defaultCfg.storeShare);

// ---------- F 组：UI（遗忘页 + 面板动作）----------
A('F1 遗忘页：总上限渲染为滚动条；10 个维度各一条占比滚动条（0-100/步进 1）、带默认刻度与读数；旧逐维上限控件不再出现', (() => {
    boot();
    const h = settingsPageHtml('forget');
    const totalOk = /type="range"[^>]*data-ftt-cfg="storeTotalMax"/.test(h);
    const rows = (h.match(/data-ftt-share="([a-z]+)"/g) || []).map((x) => x.replace(/.*?="([a-z]+)".*/, '$1'));
    return totalOk && J(rows) === J(STORE_SHARE_DIMS)
        && (h.match(/--ftt-range-def:/g) || []).length >= STORE_SHARE_DIMS.length + 1
        && h.indexOf('data-ftt-share-out="atoms"') >= 0 && h.indexOf('合计 <b>100%</b>') >= 0
        && h.indexOf('data-ftt-cfg="storeMaxAtoms"') < 0 && h.indexOf('data-ftt-cfg="storeMinAtoms"') >= 0;
})(), () => (settingsPageHtml('forget').match(/data-ftt-share="[a-z]+"/g) || []).length);

await A('F2 面板动作 `storeShare` 端到端：拖动「情节」到 40% → 写入 `cfg.storeShare`、其余按比例补齐、note 如实说明、页面读数同步', (async () => {
    boot();
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'forget' });
    const r = await panelAction('storeShare', { dim: 'atoms', value: 40 });
    const shares = cfg.storeShare || {};
    const html = String(panelBodyHtml('settings') || '');
    return r.ok === true && Number(shares.atoms) === 40 && sumOf(shares) === 100
        && String(r.state.note).indexOf('已调整「情节」占比为 40%') >= 0
        && html.indexOf('value="40"') >= 0 && html.indexOf('合计 <b>100%</b>') >= 0;
})(), () => ({ shares: cfg.storeShare, note: '见断言' }));

await A('F3 未知维度：动作如实失败（ok=false）且不改配置', (async () => {
    boot();
    const keep = J(cfg.storeShare);
    const r = await panelAction('storeShare', { dim: 'zzz', value: 30 });
    return r.ok === false && J(cfg.storeShare) === keep;
})(), '见断言');

// ---------- G 组：百分比统一滚动条 ----------
A('G1 每个百分比类设置都渲染成滚动条（不再是文本框），且**带默认值刻度 + 「默认 X」文字提示**', (() => {
    boot();
    const pageOf = (k) => SETTINGS_TABS.map((t) => t.id).filter((p) => settingsPageHtml(p).indexOf('data-ftt-cfg="' + k + '"') >= 0)[0];
    const bad = [];
    for (const k of Object.keys(RANGE_SPECS)) {
        const page = pageOf(k);
        if (!page) { bad.push(k + ':未渲染'); continue; }
        const html = settingsPageHtml(page);
        const re = new RegExp('type="range"[^>]*data-ftt-cfg="' + k.replace('.', '\\.') + '"');
        const def = controlDefault(k);
        if (!re.test(html)) bad.push(k + ':非滚动条');
        else if (def !== null && html.indexOf('默认 ' + String(Math.round(Number(def) * 1000) / 1000)) < 0 && html.indexOf('默认 ' + String(def)) < 0) bad.push(k + ':缺默认值提示');
    }
    return Object.keys(RANGE_SPECS).length >= 25 && bad.length === 0;
})(), () => Object.keys(RANGE_SPECS).length);

A('G2 滚动条元数据与标签口径一致：min < max、step > 0、默认值落在区间内；世界书激活概率按 0-100 百分比刻度', (() => {
    const bad = Object.keys(RANGE_SPECS).filter((k) => {
        const s = RANGE_SPECS[k];
        const def = controlDefault(k);
        return !(s.min < s.max) || !(Number(s.step) > 0) || (def !== null && (Number(def) < s.min || Number(def) > s.max));
    });
    const wb = RANGE_SPECS['storage.worldbookProbability'];
    return bad.length === 0 && wb.min === 0 && wb.max === 100 && wb.unit === '%'
        && RANGE_SPECS.importancePerUse.max === 0.5;
})(), () => RANGE_SPECS);

A('G3 计数类控件**不被误改**：条数 / 年限 / 楼层数仍是数字输入（拖动条不适合精确填写）', (() => {
    boot();
    const countKeys = ['stateMinPerSubject', 'itemLowUsesMaxDelete', 'lowUseForgetMaxDelete', 'feedFloors', 'stateDecaySubjectYears', 'memoryForgetRatioProtectDummy'];
    const notRange = countKeys.filter((k) => RANGE_SPECS[k] === undefined);
    const h = settingsControlHtml({ key: 'stateMinPerSubject', label: '每角色最少状态条数（默认 1）', type: 'text' });
    const h2 = settingsControlHtml({ key: 'feedFloors', label: '摘要使用最近楼层数', type: 'text' });
    return notRange.length === countKeys.length && h.indexOf('type="text"') >= 0 && h2.indexOf('type="text"') >= 0
        && h.indexOf('type="range"') < 0;
})(), '见断言');

A('G4 滚动条控件含实时读数容器（`output[data-ftt-range-out]`）与默认位置变量（`--ftt-range-def`），供面板 input 委托刷新', (() => {
    boot();
    const h = settingsControlHtml({ key: 'conceptRepairSim', label: '概念修复相关性阈值（0.1-0.95，默认 0.45）', type: 'text' });
    const def = controlDefault('conceptRepairSim');                 // 0.45
    const pos = Math.round(((def - RANGE_SPECS.conceptRepairSim.min) / (RANGE_SPECS.conceptRepairSim.max - RANGE_SPECS.conceptRepairSim.min)) * 1000) / 10;
    return h.indexOf('data-ftt-range-out="conceptRepairSim"') >= 0 && h.indexOf('<output') >= 0
        && h.indexOf('--ftt-range-def:' + pos + '%') >= 0 && h.indexOf('默认 0.45') >= 0
        && h.indexOf('min="0.1"') >= 0 && h.indexOf('max="0.95"') >= 0 && h.indexOf('step="0.01"') >= 0;
})(), () => settingsControlHtml({ key: 'conceptRepairSim', label: 'x', type: 'text' }));

A('G5 控件总数口径（v2.84.0）：逐维上限控件被总上限取代 → forget 24、rumors 13；比例类控件仍在册（只改呈现形态）', (() => {
    const forgetKeys = SETTINGS_CONTROLS.forget.map((c) => String(c.key));
    const rumorKeys = SETTINGS_CONTROLS.rumors.map((c) => String(c.key));
    return forgetKeys.length === 24 && rumorKeys.length === 13
        && forgetKeys.indexOf('storeTotalMax') >= 0 && forgetKeys.indexOf('storeMaxAtoms') < 0
        && rumorKeys.indexOf('storeMaxRumors') < 0 && rumorKeys.indexOf('storeMinRumors') >= 0
        && forgetKeys.indexOf('stateDecayRatio') >= 0 && rumorKeys.indexOf('rumorFissionChance') >= 0;
})(), () => ({ forget: SETTINGS_CONTROLS.forget.length, rumors: SETTINGS_CONTROLS.rumors.length }));

// ---------- I 组：v2.85.0 拖动中的等比联动（用户要求：调节一个其他应该等比例变化）----------
A('I1 `allotStoreShares` 是**纯函数**：不写任何配置；被拖动项权威，其余按基准比例等比例变化（合计恒 100）', (() => {
    boot();
    const keep = J(cfg.storeShare);
    const base = normStoreShares(defaultCfg.storeShare);
    const half = allotStoreShares(base, 'atoms', 40);
    const full = allotStoreShares(base, 'atoms', 80);
    const others = STORE_SHARE_DIMS.filter((d) => d !== 'atoms');
    const ratioOk = others.every((d) => Math.abs(half[d] - Math.round((base[d] / (100 - base.atoms)) * 60)) <= 1
        && Math.abs(full[d] - Math.round((base[d] / (100 - base.atoms)) * 20)) <= 1);
    return J(cfg.storeShare) === keep && half.atoms === 40 && full.atoms === 80
        && sumOf(half) === 100 && sumOf(full) === 100 && ratioOk;
})(), () => ({ half: allotStoreShares(normStoreShares(defaultCfg.storeShare), 'atoms', 40) }));

A('I2 逐档拖动（每档都从**同一基准**算）与一步到位结果**逐值一致** —— 拖动过程不会因四舍五入而累计漂移', (() => {
    boot();
    const base = normStoreShares(defaultCfg.storeShare);
    let step = base;
    for (let v = 24; v <= 60; v += 1) step = allotStoreShares(base, 'atoms', v);
    const oneShot = allotStoreShares(base, 'atoms', 60);
    return J(step) === J(oneShot) && sumOf(step) === 100 && step.atoms === 60;
})(), () => allotStoreShares(normStoreShares(defaultCfg.storeShare), 'atoms', 60));

// ---------- J 组：v2.85.0 保底**被动下移**（用户要求：保底高于该数字则自动下移）----------
A('J1 占比调小 → 保底高于新上限时**自动下移**到上限（只降不升）；上限即占比推导值，不再被保底顶上去', (() => {
    boot();
    cfg.storeTotalMax = 390;                                      // 23% × 390 = 89.7 → 90
    cfg.storeMinAtoms = 500;                                      // 保底 500 高于上限 90
    const cap = storeCapFor('atoms');
    const floorBefore = storeFloorRaw('atoms');                   // 配置原值仍是 500
    const floorView = storeMinFor('atoms');                       // 对外口径 = 夹到 90
    const moved = clampStoreFloors();                             // 提交时落盘
    const floorAfter = Number(cfg.storeMinAtoms);
    const again = clampStoreFloors();                             // 幂等：已等于上限则不再动
    const atomMove = moved.filter((m) => m.dim === 'atoms')[0] || null;
    return cap === 90 && floorBefore === 500 && floorView === 90 && floorAfter === 90 && again.length === 0
        && !!atomMove && atomMove.from === 500 && atomMove.to === 90
        && moved.filter((m) => m.dim === 'atoms').length === 1;
})(), '见断言');

A('J2 占比调小触发下移（`setStoreShare` 内联落盘口径）：情节保底 500 → 拖到 3% 后保底 90；兼容口径下**不动**保底', (() => {
    boot();
    cfg.storeTotalMax = 3000;
    cfg.storeMinAtoms = 500;
    const next = setStoreShare('atoms', 3);                       // 3% × 3000 = 90
    const movedFloor = Number(cfg.storeMinAtoms);
    const cap = storeCapFor('atoms');
    // 兼容口径（storeTotalMax = 0）：不得改动任何保底，且上限回到 V1 的 max(storeMax*, 保底)
    cfg.storeTotalMax = 0; cfg.storeMaxAtoms = 1200; cfg.storeMinAtoms = 500;
    const legacyMoved = clampStoreFloors();
    return next.atoms === 3 && sumOf(next) === 100 && movedFloor === 90 && cap === 90
        && legacyMoved.length === 0 && Number(cfg.storeMinAtoms) === 500 && storeCapFor('atoms') === 1200;
})(), () => ({ atoms: storeCapFor('atoms'), floor: cfg.storeMinAtoms }));

A('J3 拖动「总上限」后保底同样被动下移：总上限 300 → 情节上限 69，保底 200 跟到 69', (() => {
    boot();
    cfg.storeMinAtoms = 200;
    cfg.storeTotalMax = 300;                                      // 23% × 300 = 69
    const moved = clampStoreFloors();
    const atomMove = moved.filter((m) => m.dim === 'atoms')[0] || null;
    // 总上限只有 300 → 其余保底（记忆 200 / 概念 200 / 物品 150 …）同样被下移，这里只校验情节这一项
    return Number(cfg.storeMinAtoms) === 69 && storeCapFor('atoms') === 69
        && !!atomMove && atomMove.from === 200 && atomMove.to === 69 && atomMove.label === '情节';
})(), () => ({ floor: cfg.storeMinAtoms, moved: clampStoreFloors() }));

// ---------- K 组：v2.85.0 占比区 UI（行尾保底文字 / 合计行标记）----------
A('K1 占比区：每行带 `data-ftt-share-floor` 保底文字（默认 x% · 保底 M 条）、合计行带联动重写标记', (() => {
    boot();
    const h = settingsPageHtml('forget');
    const floors = (h.match(/data-ftt-share-floor="([a-z]+)"/g) || []).length;
    return floors === STORE_SHARE_DIMS.length
        && h.indexOf('data-ftt-share-sum') >= 0
        && h.indexOf('合计 <b>100%</b>') >= 0
        && h.indexOf('保底 100 条') >= 0 && h.indexOf('保底 200 条') >= 0;
})(), () => (settingsPageHtml('forget').match(/data-ftt-share-floor="[a-z]+"/g) || []).length);

A('K2 保底被下移时行尾文字**如实标注**「已随上限下移」（`shareFloorText` 与首屏渲染同源）', (() => {
    boot();
    const txt = shareFloorText('atoms', 90);                      // 预览上限 90 < 保底 500
    cfg.storeMinAtoms = 5000;                                     // 保底远超上限 → 渲染显示夹取后的数字 + 标注
    const htmlLow = settingsPageHtml('forget');
    cfg.storeMinAtoms = 500;                                      // 低于上限 → 原样显示、不标注
    const htmlOk = settingsPageHtml('forget');
    return txt.indexOf('保底 90 条（已随上限下移）') >= 0
        && htmlLow.indexOf('保底 690 条（已随上限下移）') >= 0
        && htmlOk.indexOf('保底 500 条') >= 0 && htmlOk.indexOf('已随上限下移') < 0;
})(), () => shareFloorText('atoms', 90));

R.done();
