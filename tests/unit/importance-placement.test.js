// ============================================================
// 单元测试 · v2.78.0「重要性计算」归位到「提取记忆」页
//
// 用户要求（原文）：「设定的「重要性计算」是提取记忆用的，需迁移位置。」
// 事实核对：`core/recall.js#calcImportance` 读 `cfg.importanceBase` / `cfg.importancePerUse`，
//   公式 = `clamp(初始值 + 调用次数 × 每次增量, 0, 1)`；「调用次数」（`uses`）在条目**被召回命中**时
//   由 `markUsed` 累加（列表行的「重要度M%」也读同一函数）→ 属**召回/提取记忆**链路。
//   V1 把这两项放在「基础」页；本次按用户要求迁到「提取记忆」页（**有意的排布偏差**，键名与标签逐字不变）。
// 覆盖：
//   A 控件表位置（base 移除 / extract 增入，总数 173 不变）
//   B 基础页不再出现该分节与输入，且保留一句跨页指路
//   C 提取页出现独立分节（标题 / 两个输入 / 短提示 / 折叠说明）且不在「其它召回行为」里
//   D 写回夹取与 V1 逐字一致（初始值 0-1、每次增量 0-0.5、非法值回落 0）
//   E 真实生效：召回打分（calcImportance / importancePct）读的就是这两项
// 运行：node tests/unit/importance-placement.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, settingsPageHtml, settingsPagesInfo, applySettingsControl } from '../../ui/settings-pages.js';
import { calcImportance, importancePct } from '../../core/recall.js';

const R = makeReporter('importance-placement v2.78.0 重要性计算归位');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('char:imp');
setKernelState(emptyState());
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

const IMP_KEYS = ['importanceBase', 'importancePerUse'];
const keysOf = (pid) => SETTINGS_CONTROLS[pid].map((c) => String(c.key));
const cfgKeysOf = (pid) => Array.from(settingsPageHtml(pid).matchAll(/data-ftt-cfg="([^"]+)"/g)).map((m) => m[1]);

// ---------- A 控件表位置 ----------
A('A1 两项已从「基础」页控件表移除、增入「提取记忆」页控件表（纯搬运：总数仍 173）', (() => {
    const base = keysOf('base'), ex = keysOf('extract');
    const info = settingsPagesInfo();
    const m = {};
    info.pages.forEach((p) => { m[p.id] = p.controls; });
    return IMP_KEYS.every((k) => base.indexOf(k) < 0 && ex.indexOf(k) >= 0)
        && info.totalControls === 173 && m.base === 9 && m.extract === 24;
})(), J({ base: keysOf('base'), extractCount: keysOf('extract').length, total: settingsPagesInfo().totalControls }));

A('A2 键名与标签**逐字不变**（V1 文案；只换页面，不改语义）', (() => {
    const find = (k) => SETTINGS_CONTROLS.extract.filter((c) => c.key === k)[0] || {};
    return find('importanceBase').label === '初始重要性(0次调用)' && find('importanceBase').type === 'text'
        && find('importancePerUse').label === '每次调用增量' && find('importancePerUse').type === 'text';
})(), J(SETTINGS_CONTROLS.extract.filter((c) => IMP_KEYS.indexOf(String(c.key)) >= 0)));

// ---------- B 基础页 ----------
A('B1 基础页不再出现该分节与两个输入，并在提示里保留一句跨页指路', (() => {
    const h = settingsPageHtml('base');
    return h.indexOf('重要性计算（调用次数驱动）') < 0
        && h.indexOf('data-ftt-cfg="importanceBase"') < 0 && h.indexOf('data-ftt-cfg="importancePerUse"') < 0
        && h.indexOf('「召回参数」与「重要性计算」在「提取记忆」页') > 0;
})(), '见断言');

A('B2 基础页分节不回归，且控件数量随搬运减少 2（渲染键 = 控件表 9 + 抽屉卡片开关 1）', (() => {
    const h = settingsPageHtml('base');
    const ks = cfgKeysOf('base');
    return h.indexOf('组件开关') > 0 && h.indexOf('剧情时钟（总览 日期/时间/地点）') > 0
        && h.indexOf('情节日期时间修复（只针对情节）') > 0 && h.indexOf('显示界面开关') > 0
        && IMP_KEYS.every((k) => ks.indexOf(k) < 0)
        && ks.length === SETTINGS_CONTROLS.base.length + 1;   // +「扩展设置抽屉卡片」开关（由入口行渲染）
})(), J(cfgKeysOf('base')));

// ---------- C 提取页 ----------
A('C1 提取页出现独立分节：标题 + 两个输入 + 公式短提示 + 折叠说明', (() => {
    const h = settingsPageHtml('extract');
    return h.indexOf('重要性计算（调用次数驱动）') > 0
        && h.indexOf('data-ftt-cfg="importanceBase"') > 0 && h.indexOf('data-ftt-cfg="importancePerUse"') > 0
        && h.indexOf('重要度 = 初始值 + 调用次数 × 每次增量；被召回命中一次即累加一次。') > 0
        && h.indexOf('初始值 0-1、每次增量 0-0.5') > 0;
})(), '见断言');

A('C2 分节位置：在「召回上限」之后，且两项**不落在**「其它召回行为」里', (() => {
    const h = settingsPageHtml('extract');
    const at = (s) => h.indexOf(s);
    const imp = at('data-ftt-cfg="importanceBase"');
    const cap = at('召回上限（各大类注入条数）');
    const other = at('其它召回行为');
    return cap > 0 && imp > cap && (other < 0 || imp < other);
})(), J({ caps: settingsPageHtml('extract').indexOf('召回上限（各大类注入条数）'), imp: settingsPageHtml('extract').indexOf('data-ftt-cfg="importanceBase"') }));

A('C3 提取页控件表 22 → 24；渲染键（含 API 区块自有字段）里也含两项，非召回项仍不出现', (() => {
    const ks = cfgKeysOf('extract');
    return SETTINGS_CONTROLS.extract.length === 24 && IMP_KEYS.every((k) => ks.indexOf(k) >= 0)
        && ks.every((k) => k.indexOf('dimCharLimits.') < 0) && ks.indexOf('currencyEnabled') < 0;
})(), J({ table: SETTINGS_CONTROLS.extract.length, rendered: cfgKeysOf('extract') }));

// ---------- D 写回夹取（V1 逐字口径） ----------
A('D1 初始重要性夹取在 0-1（含非法值与越界）', (() => {
    const r1 = applySettingsControl('importanceBase', 0.42);
    const ok1 = r1.ok === true && cfg.importanceBase === 0.42;
    applySettingsControl('importanceBase', 5);
    const hi = cfg.importanceBase;
    applySettingsControl('importanceBase', -3);
    const lo = cfg.importanceBase;
    applySettingsControl('importanceBase', 'abc');
    const bad = cfg.importanceBase;
    applySettingsControl('importanceBase', 0.12);
    return ok1 && hi === 1 && lo === 0 && bad === 0;
})(), J({ v: cfg.importanceBase }));

A('D2 每次调用增量夹取在 0-0.5（含非法值）', (() => {
    applySettingsControl('importancePerUse', 0.9);
    const hi = cfg.importancePerUse;
    applySettingsControl('importancePerUse', 0.2);
    const ok = cfg.importancePerUse;
    applySettingsControl('importancePerUse', 'x');
    const bad = cfg.importancePerUse;
    applySettingsControl('importancePerUse', 0.06);
    return hi === 0.5 && ok === 0.2 && bad === 0;
})(), J({ v: cfg.importancePerUse }));

A('D3 夹取结果同时如实回给调用方（面板/调用点看到的即落库值）', (() => {
    const r1 = applySettingsControl('importanceBase', 9);
    const r2 = applySettingsControl('importancePerUse', 9);
    const r3 = applySettingsControl('importanceBase', 0.12);
    const r4 = applySettingsControl('importancePerUse', 0.06);
    return r1.ok === true && r1.value === 1 && r2.ok === true && r2.value === 0.5
        && r3.value === 0.12 && r4.value === 0.06 && cfg.importanceBase === 0.12 && cfg.importancePerUse === 0.06;
})(), J({ base: cfg.importanceBase, per: cfg.importancePerUse }));

// ---------- E 真实生效 ----------
A('E1 召回打分读的就是这两项：重要度 = 初始值 + 调用次数 × 增量（夹取 0-1）', (() => {
    cfg.importanceBase = 0.2; cfg.importancePerUse = 0.1;
    const a = calcImportance({ uses: 4 });
    const b = calcImportance({ uses: 0 });
    const c = calcImportance({ uses: 100 });
    return Math.abs(a - 0.6) < 1e-9 && Math.abs(b - 0.2) < 1e-9 && c === 1 && importancePct({ uses: 4 }) === 60;
})(), J({ uses4: calcImportance({ uses: 4 }), uses100: calcImportance({ uses: 100 }) }));

A('E2 页面提示口径：本模块新增提示不超过 90 字且页面内不重复', (() => {
    const h = settingsPageHtml('extract');
    const hints = Array.from(h.matchAll(/<div class="ftt-muted[^"]*"[^>]*>([\s\S]*?)<\/div>/g))
        .map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    const long = hints.filter((t) => t.length > 90);
    const dup = hints.filter((t, i) => hints.indexOf(t) !== i);
    const mine = hints.filter((t) => t.indexOf('重要度 = 初始值') === 0);
    return long.length === 0 && dup.length === 0 && mine.length === 1;
})(), J({ hints: settingsPageHtml('extract').match(/<div class="ftt-muted[^"]*"[^>]*>([\s\S]*?)<\/div>/g) ? 'checked' : '' }));

R.done();
