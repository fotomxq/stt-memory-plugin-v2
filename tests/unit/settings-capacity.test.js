// ============================================================
// 单元测试 · v2.76.0「默认词条数量上限提高 + 提取记忆页非召回设定归位」
//
// 用户要求（原文）：「各大类支持的默认词条数量限制提高，整体控制在 2000-3000 原子数量支持即可，
//   用户可自行修改现有设定来提升。设定-提取记忆中很多设置根本不是召回处理用的，请正确归纳到对应设定中。」
//
// 本批：
//   ① **默认上限提高**（`core/config.js`，`core/ingest.js#STORE_LIMITS` 兜底同步）：
//      · 注入条数上限（`max*`）：合计 **2980**（落在用户要求的 2000-3000；此前合计仅 152）；
//        条数只是**候选上限**，真正决定注入体大小的是 `charBudget`（默认 8000 字）。
//      · 存储上限（`storeMax*`）：合计 **5600**（承载 2000-3000 条库存的任意分布；此前 3700）。
//      · 用户仍可在 设定 → 提取记忆（召回上限）/ 设定 → 遗忘（存储保底与上限）自行修改。
//   ② **非召回设定归位**：`currencyEnabled` / `currencyDynamicEnabled`（货币记录口径）与
//      `dimCharLimits.*`（入库硬截断 10 项）由「提取记忆」页搬到「分析记忆」页；
//      「提取记忆」页只留召回相关（三层流程 / 检索参数 / 注入预算 / 召回条数上限 / 关键词过滤 + API 分组）。
//
// 运行：node tests/unit/settings-capacity.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, settingsPageHtml, settingsPagesInfo } from '../../ui/settings-pages.js';
import { dimCap } from '../../core/model/scalars.js';
import { enforceDimCaps, storeCapFor, STORE_LIMITS, STORE_TOTAL_MAX_DEFAULT } from '../../core/ingest.js';

const R = makeReporter('settings-capacity v2.76.0 上限提高与设定归位');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('甲');
setKernelState(emptyState());
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 旧默认（v2.75.0）与新的下限——用于「只升不降」断言 */
const CAP_RAISE = {
    maxAtoms: 16, maxMemories: 8, maxStates: 30, maxSnapshots: 10, maxItems: 16, maxPlans: 8, maxSuspense: 8,
    maxScenes: 24, maxConcepts: 10, maxNpcs: 24, maxParallels: 30, maxParallelsInj: 8, maxCurrencies: 8, maxRumors: 6,
    storeMaxAtoms: 400, storeMaxMemories: 600, storeMaxSnapshots: 300, storeMaxItems: 400, storeMaxConcepts: 600,
    storeMaxScenes: 300, storeMaxPlans: 200, storeMaxSuspense: 200, storeMaxNpcs: 200, storeMaxRumors: 200,
    storeMaxCurrencies: 300,
};
const INJ_KEYS = ['maxAtoms', 'maxMemories', 'maxStates', 'maxSnapshots', 'maxItems', 'maxPlans', 'maxSuspense',
    'maxScenes', 'maxConcepts', 'maxNpcs', 'maxParallelsInj', 'maxCurrencies', 'maxRumors'];
const STORE_KEYS = Object.keys(CAP_RAISE).filter((k) => k.indexOf('storeMax') === 0);

A('C1 注入条数上限整体提高且合计落在 2000-3000：2980（此前 152）', (() => {
    const sum = INJ_KEYS.reduce((n, k) => n + Number(defaultCfg[k]), 0);
    const before = INJ_KEYS.reduce((n, k) => n + Number(CAP_RAISE[k]), 0);
    return sum === 2980 && sum >= 2000 && sum <= 3000 && before === 176
        && INJ_KEYS.every((k) => Number(defaultCfg[k]) > Number(CAP_RAISE[k]));
})(), J({ 注入合计: INJ_KEYS.reduce((n, k) => n + Number(defaultCfg[k]), 0) }));

A('C2 存储上限整体提高：合计 5600（此前 3700），任何单类都不降且能承载 2-3k 条库存', (() => {
    const sum = STORE_KEYS.reduce((n, k) => n + Number(defaultCfg[k]), 0);
    const before = STORE_KEYS.reduce((n, k) => n + Number(CAP_RAISE[k]), 0);
    const atoms = Number(defaultCfg.storeMaxAtoms);
    return sum === 5600 && before === 3700 && STORE_KEYS.every((k) => Number(defaultCfg[k]) > Number(CAP_RAISE[k]))
        && atoms >= 1000 && Number(defaultCfg.maxParallels) > CAP_RAISE.maxParallels
        // 保底不变（任何自动清理都不得跌破既定保底）
        && Number(defaultCfg.storeMinAtoms) === 100 && Number(defaultCfg.storeMinMemories) === 200;
})(), J({ 存储合计: STORE_KEYS.reduce((n, k) => n + Number(defaultCfg[k]), 0) }));

A('C3 上限仍可由用户改（设定项在册）且真实生效：改小 → 入库硬截断随之收紧；存储总上限/占比也在册（v2.84.0 口径）', (() => {
    const injKeys = SETTINGS_CONTROLS.extract.map((c) => String(c.key));
    const storeKeys = SETTINGS_CONTROLS.forget.map((c) => String(c.key));
    const upOk = ['maxAtoms', 'maxMemories', 'charBudget'].every((k) => injKeys.indexOf(k) >= 0)
        // v2.84.0（用户要求）：逐维 storeMax* 由「总上限 + 占比滚动条」取代 → 在册的是 storeTotalMax + 保底
        && storeKeys.indexOf('storeTotalMax') >= 0 && storeKeys.indexOf('storeMinAtoms') >= 0
        && storeKeys.indexOf('storeMaxAtoms') < 0;
    const long = '甲'.repeat(80);
    const keep = cfg.dimCharLimits.atoms;
    cfg.dimCharLimits.atoms = 30;
    const capped = dimCap('atoms', long);
    cfg.dimCharLimits.atoms = keep;
    return upOk && capped.length === 30;
})(), '见断言');

A('C4 归位：货币记录与「各大类单条字数上限」都在分析记忆页，提取记忆页不再出现', (() => {
    const keys = (pid) => Array.from(settingsPageHtml(pid).matchAll(/data-ftt-cfg="([^"]+)"/g)).map((m) => m[1]);
    const an = keys('analyze'), ex = keys('extract');
    const moved = ['currencyEnabled', 'currencyDynamicEnabled'].concat(
        ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels'].map((k) => 'dimCharLimits.' + k));
    return moved.length === 12 && moved.every((k) => an.indexOf(k) >= 0 && ex.indexOf(k) < 0)
        && an.indexOf('currencyEnabled') < an.indexOf('dimCharLimits.atoms');
})(), J({ analyze: settingsPageHtml('analyze').length, extract: settingsPageHtml('extract').length }));

A('C5 提取记忆页只剩召回相关：三层 + 检索参数 + 注入预算 + 召回上限 + 重要性计算（窗口参数 3 项）+ 关键词过滤（25 项，无 dimCharLimits./货币记录）', (() => {
    const list = SETTINGS_CONTROLS.extract.map((c) => String(c.key));
    // v2.78.0：「重要性计算」两项也归本页（召回打分 —— 调用次数在召回命中时累加）
    const recallOk = ['useVector', 'vectorTopN', 'vectorMinScore', 'vectorTimeoutMs', 'jsExtractEnabled', 'useKeywordFlow',
        // v2.86.0：重要度改「窗口调用占比」→ 旧的 importanceBase/importancePerUse 下线，代之以三个窗口参数
        'charBudget', 'impRecalcEnabled', 'impWindowRadius', 'impRecalcCount', 'keywordFilterByContext'].every((k) => list.indexOf(k) >= 0)
        // `maxNpcs` / `maxRumors` 分别在其它页（名册与传言），不在本页
        && INJ_KEYS.filter((k) => k !== 'maxNpcs' && k !== 'maxRumors').concat(['atomsRecentRatio', 'stateMinPerSubject', 'stateMaxPerSubject']).every((k) => list.indexOf(k) >= 0);
    const h = settingsPageHtml('extract');
    return list.length === 25 && recallOk
        && h.indexOf('注入预算') > 0 && h.indexOf('召回上限（各大类注入条数）') > 0
        && h.indexOf('重要性计算（窗口调用占比）') > 0
        && h.indexOf('dimCharLimits.') < 0 && h.indexOf('data-ftt-cfg="currencyEnabled"') < 0;
})(), J(SETTINGS_CONTROLS.extract.map((c) => c.key)));

A('C6 分析记忆页对应分节与短提示：货币记录（记录口径）+ 各大类单条字数上限（入库硬截断），节内控件的分节正确', (() => {
    const h = settingsPageHtml('analyze');
    const at = (s) => h.indexOf(s);
    return at('货币记录') > 0 && at('各大类单条字数上限') > at('货币记录')
        && at('data-ftt-cfg="currencyEnabled"') > at('货币记录') && at('data-ftt-cfg="currencyEnabled"') < at('各大类单条字数上限')
        && at('data-ftt-cfg="dimCharLimits.atoms"') > at('各大类单条字数上限')
        && h.indexOf('决定「分析记忆」时是否抽取货币') > 0 && h.indexOf('入库时的硬截断') > 0;
})(), '见断言');

A('C7 总量口径：v2.78.0 纯搬运 173 → v2.83.0 关联层 +3 = 176 → v2.84.0 存储上限改口径 −5 → 171 → v2.86.0 重要度口径改 +1（base 9 / analyze 20 / extract 25 / forget 24 / rumors 13）', (() => {
    const info = settingsPagesInfo();
    const m = {};
    info.pages.forEach((p) => { m[p.id] = p.controls; });
    return info.totalControls === 159 && m.analyze === 20 && m.extract === 25 && m.base === 9 && m.feed === 37
        && m.forget === 24 && m.rumors === 13;
})(), J(settingsPagesInfo().pages.map((p) => p.id + ':' + p.controls)));

A('C8 兜底口径（v2.84.0）：默认配置走**新口径**（总上限 3000 → 情节 3000×23% = 690）；把总上限置 0 或删掉该键则走旧的逐维 `storeMax*` 兼容口径（老存档 / V1 黄金样本可用）', (() => {
    const st = emptyState();
    const many = [];
    for (let i = 0; i < 1300; i++) many.push({ id: 'a' + i, text: '第' + i + '条情节正文足够长。', date: '1919-11-01', floorStart: 0, floorEnd: 0, tags: [], importance: 0.2, uses: 0 });
    st.atoms = many;
    setKernelState(st);
    const keep = { total: cfg.storeTotalMax, shares: cfg.storeShare, max: cfg.storeMaxAtoms };
    let cut = 0, legacyZero = null, legacyMissing = null;
    try {
        cfg.storeTotalMax = 3000;
        cfg.storeShare = JSON.parse(JSON.stringify(defaultCfg.storeShare));
        const r = enforceDimCaps();
        cut = Number((r && r.cut) || 0);
        cfg.storeTotalMax = 0; cfg.storeMaxAtoms = 1200;          // 显式 0 → 旧口径
        legacyZero = storeCapFor('atoms');
        delete cfg.storeTotalMax;                                  // 缺键（未迁移的老配置）→ 旧口径
        legacyMissing = storeCapFor('atoms');
    } finally { cfg.storeTotalMax = keep.total; cfg.storeShare = keep.shares; cfg.storeMaxAtoms = keep.max; }
    return cut === 610 && (state.atoms || []).length === 690
        && legacyZero === 1200 && legacyMissing === 1200
        && STORE_TOTAL_MAX_DEFAULT === 3000 && J(STORE_LIMITS.atoms.slice(2, 5)) === J([1200, '情节', 23]);
})(), J({ atoms: (state.atoms || []).length }));

R.done();
