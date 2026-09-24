// ============================================================
// 单元测试 · 批次 4（core/config.js 配置层 + core/clock.js 时钟族）与 V1 黄金样本一致
// 黄金样本：tests/fixtures/v1-golden-config-clock.json（V1 源码切片产出）
// 口径：严格相等（JSON.stringify；键顺序一致）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { CN_KEY_MAP, DIMENSIONS, DIM_LABELS, PROMPT_DEFAULT_VERSION, PROMPT_GROUPS, PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, ARMOR_PRESET_V1178_DEFAULT, defaultCfg, KIND_MAP, normalizeDeltaKeys } from '../../core/config.js';
import { clockDateTrim, clockDateParts, clockDateStr, clockDateValid, clockNormBcText, clockYearStr, storyDateMs, storyDateMsFromStr, clockDateFromParts, clockCnInt, clockValNum, clockValYear, clockYearOf, clockYearInRange, clockDateLabel, clockMonthDay, clockAnomalyJumpYears } from '../../core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-config-clock.json'), 'utf8'));
const R = makeReporter('config-clock-golden V1 移植保真度（批次 4）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);

cfg.clockAnomalyJumpYears = defaultCfg.clockAnomalyJumpYears;

// ---------- 配置层 ----------
R.assert('C1 defaultCfg：V1 的 217 键逐值一致 + 仅允许 V2 专有键（界面形态）', (() => {
    // 口径：V1 键必须**逐值**相同（保真）；V2 新增键须在白名单内（防悄悄加键/改键）
    // B9-d 例外（显式白名单）：`storage.stateFileSlim` / `storage.stateFileGzip` 为 V2 专有开关
    //   （V1 恒「瘦身 + gzip」、无对应开关），默认 false（默认安全）；V1 `storage` 的其余键仍逐值一致。
    const V2_ONLY = ['uiShowDrawer', 'uiShowFloating', 'uiFirstTab'];
    const V2_STORAGE_ONLY = ['stateFileSlim', 'stateFileGzip'];
    const v1 = G.defaultCfg || {};
    const diff = Object.keys(v1).filter((k) => k !== 'storage' && J(v1[k]) !== J(defaultCfg[k]));
    const v1s = v1.storage || {}, cur = defaultCfg.storage || {};
    const storageDiff = Object.keys(v1s).filter((k) => J(v1s[k]) !== J(cur[k]));
    const storageExtra = Object.keys(cur).filter((k) => !(k in v1s));
    const extra = Object.keys(defaultCfg).filter((k) => !(k in v1));
    return Object.keys(v1).length === 217 && diff.length === 0
        && extra.every((k) => V2_ONLY.indexOf(k) >= 0) && extra.length === V2_ONLY.length
        && storageDiff.length === 0 && J(storageExtra.slice().sort()) === J(V2_STORAGE_ONLY.slice().sort())
        && cur.stateFileSlim === false && cur.stateFileGzip === false;
})(), (() => {
    const v1 = G.defaultCfg || {};
    const v1s = v1.storage || {}, cur = defaultCfg.storage || {};
    return {
        keys: Object.keys(defaultCfg).length, v1Keys: Object.keys(v1).length, extra: Object.keys(defaultCfg).filter((k) => !(k in v1)),
        storageDiff: Object.keys(v1s).filter((k) => J(v1s[k]) !== J(cur[k])), storageExtra: Object.keys(cur).filter((k) => !(k in v1s)),
    };
})());
R.assert('C2 CN_KEY_MAP 中文键映射与 V1 一致（174 项）', J(CN_KEY_MAP) === J(G.cnKeyMap), Object.keys(CN_KEY_MAP).length);
R.assert('C3 normalizeDeltaKeys 与 V1 一致（嵌套对象 / 数组 / vars 原样保留）',
    J(I.DELTAS.map(d => normalizeDeltaKeys(d))) === J(G.deltaCases), I.DELTAS.map(d => normalizeDeltaKeys(d)));
R.assert('C4 维度清单与标签、提示词默认版本、模板键集合一致',
    J(DIMENSIONS) === J(G.dimensions) && J(DIM_LABELS) === J(G.dimLabels)
    && PROMPT_DEFAULT_VERSION === G.promptDefaultVersion
    && J(Object.keys(PROMPT_TEMPLATES_V2).sort()) === J(G.promptTemplateKeys), [PROMPT_DEFAULT_VERSION, Object.keys(PROMPT_TEMPLATES_V2).length]);
R.assert('C5 提示词分组 / 旧默认签名表 / 破甲预设默认值一致',
    J(PROMPT_GROUPS) === J(G.promptGroups) && J(Object.keys(PROMPT_LEGACY_SIGS).sort()) === J(G.promptLegacySigsKeys)
    && J(ARMOR_PRESET_V1178_DEFAULT) === J(G.armorPresetDefault), Object.keys(PROMPT_LEGACY_SIGS).length);
R.assert('C6 模板并入默认配置（defaultCfg.promptTemplates 与 PROMPT_TEMPLATES_V2 同值）',
    J(defaultCfg.promptTemplates) === J(PROMPT_TEMPLATES_V2), Object.keys(defaultCfg.promptTemplates).length);
R.assert('C7 KIND_MAP 维度键：V1 的 14 键齐全且 get/set 读写注入 state + V2 别名 currentStates（白名单）', (() => {
    // 口径：V1 的 14 个维度键必须存在且可读写注入 state；
    //   V2 追加 `currentStates` 别名（与 'states' 同容器，用于以规范维度键写墓碑）→ 白名单内允许。
    const V1_KEYS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'npcs', 'scenes', 'concepts', 'parallels', 'currencies', 'plotSegments', 'rumors'];
    const V2_ALIAS = ['currentStates'];
    const keys = Object.keys(KIND_MAP);
    const missing = V1_KEYS.filter((x) => keys.indexOf(x) < 0);
    const extra = keys.filter((x) => V1_KEYS.indexOf(x) < 0);
    setKernelState({ atoms: [{ id: 'a1' }], currentStates: [{ id: 'c1' }] });
    const g = KIND_MAP.atoms.get().map((x) => x.id);
    KIND_MAP.atoms.set([{ id: 'a2' }]);
    const after = (KIND_MAP.atoms.get() || []).map((x) => x.id);
    const statesIsArray = Array.isArray(KIND_MAP.states.get());
    const aliasSame = KIND_MAP.currentStates.get() === KIND_MAP.states.get();
    setKernelState(null);
    return missing.length === 0 && extra.length === V2_ALIAS.length && extra.every((x) => V2_ALIAS.indexOf(x) >= 0)
        && J(g) === J(['a1']) && J(after) === J(['a2']) && statesIsArray === true && aliasSame === true;
})(), Object.keys(KIND_MAP));

// ---------- 时钟族 ----------
R.assert('K1 clockDateTrim / clockDateParts 与 V1 一致（含公元前 / 空值 / ISO）',
    J(I.DATES.map(d => clockDateTrim(d))) === J(G.clock.trim) && J(I.DATES.map(d => clockDateParts(clockDateTrim(d)))) === J(G.clock.parts), I.DATES.map(d => clockDateTrim(d)));
R.assert('K2 clockDateStr / clockDateValid 与 V1 一致',
    J([[1919, 11, 29], [-221, 1, 2], [9, 1, 1]].map(([y, m, d]) => clockDateStr(y, m, d))) === J(G.clock.str)
    && J(I.DATES.map(d => clockDateValid(d))) === J(G.clock.valid), I.DATES.map(d => clockDateValid(d)));
R.assert('K3 clockNormBcText 公元前归一与 V1 一致', J(['公元前221年', '前221年', '公元1919年', '公元前221年11月29日', '无', ''].map(t => clockNormBcText(t))) === J(G.clock.bcNorm), G.clock.bcNorm);
R.assert('K4 clockYearStr / storyDateMs / storyDateMsFromStr 与 V1 一致',
    J([1919, -221, 9, 0].map(y => clockYearStr(y))) === J(G.clock.yearStr)
    && J(['1919-11-29', '-0221-01-02', '1919-11', '1919', ''].map(d => storyDateMs(d))) === J(G.clock.storyMs)
    && J(['1919-11-29', '-0221-01-02', 'bad'].map(d => storyDateMsFromStr(d))) === J(G.clock.storyMsFromStr), G.clock.storyMs);
R.assert('K5 clockDateFromParts / clockCnInt / clockValNum / clockValYear 与 V1 一致',
    J([['1919', '11', '29'], ['-0221', '1', '2'], ['1919'], ['', '2', '3']].map(p => clockDateFromParts(p, '1919-01-01'))) === J(G.clock.dateFromParts)
    && J(['一九一九', '二二一', '九', '三〇', '', 'abc'].map(t => clockCnInt(t))) === J(G.clock.cnInt)
    && J([' 12 ', '十一', 'x', ''].map(t => clockValNum(t))) === J(G.clock.valNum)
    && J(['1919', '公元前221年', 'x'].map(t => clockValYear(t))) === J(G.clock.valYear), G.clock.cnInt);
R.assert('K6 clockYearOf / clockYearInRange / clockDateLabel / clockMonthDay 与 V1 一致',
    J(['1919-01-01', '-0221-01-02', '', null].map(t => clockYearOf(t))) === J(G.clock.yearOf)
    && J([-9999, -221, 0, 1919, 99999].map(y => clockYearInRange(y))) === J(G.clock.yearInRange)
    && J(['1919-11-29', '-0221-01-02', '1919-11', '', null].map(d => clockDateLabel(d))) === J(G.clock.dateLabel)
    && J(['1919-11-29', '1919-11', '', null].map(d => clockMonthDay(d))) === J(G.clock.monthDay), G.clock.dateLabel);
R.assert('K7 clockAnomalyJumpYears 读注入配置（默认 50）', clockAnomalyJumpYears() === G.clock.anomalyCfg, clockAnomalyJumpYears());
R.assert('K8 注入 cfg 变化可影响校验（阈值 0 = 关闭异常判定）', (() => {
    const before = clockDateValid('1919-11-29');
    cfg.clockAnomalyJumpYears = 0;
    const off = clockDateValid('1919-11-29');
    cfg.clockAnomalyJumpYears = defaultCfg.clockAnomalyJumpYears;
    return before === true && off === true;
})(), '');

R.done();
