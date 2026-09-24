// ============================================================
// 单元测试 · core/model 与 V1 黄金样本逐字节一致（移植保真度门禁）
// 黄金样本来源：V1 仓库源码切片（逐段提取 V1 原码，不改语义）在固定输入下的输出，
//   生成脚本见 V1 仓库流程记录；样本文件 tests/fixtures/v1-golden.json。
// 口径：**严格相等**（JSON.stringify 逐字符比较，键顺序也一致 —— 因为 V2 是逐字移植）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { normalizeAtom } from '../../core/model/atom.js';
import { normalizeCurrentState, normalizeMemory, normalizeConcept, normalizeParallel, normalizeItem, normalizePlan, normalizeSuspense, normalizeNpc, normalizeScene } from '../../core/model/dims.js';
import { atomContentHash } from '../../core/model/hash.js';
import { dimCap, atomTitle, toChineseField, toChineseCategory, mergeTags, makeExtra, detectValueType, clockDateTrim } from '../../core/model/scalars.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden.json'), 'utf8'));
const R = makeReporter('model-golden V1 移植保真度');
const J = (v) => JSON.stringify(v);

/** 对比函数：返回 { ok, diffIndex } */
function cmpDim(name, got, want) {
    if (got.length !== want.length) return { ok: false, why: '条数 ' + got.length + ' != ' + want.length };
    for (let i = 0; i < want.length; i++) {
        if (J(got[i]) !== J(want[i])) {
            return { ok: false, why: '第 ' + i + ' 条不一致', got: got[i], want: want[i] };
        }
    }
    return { ok: true };
}

const hashesGot = {
    atom: atomContentHash('atoms', normalizeAtom(G.inputs.ATOMS[0], null)),
    atomSlim: atomContentHash('atoms', { text: '角色甲在码头发现被破坏的木箱，断口整齐。', title: '码头发现' }),
    state: atomContentHash('currentStates', { subject: '角色甲', field: '心境', value: '戒备' }),
    plan: atomContentHash('plans', normalizePlan(G.inputs.PLANS[0])),
    item: atomContentHash('items', { name: '铜制钥匙', qty: 2, tags: ['钥匙'] }),
    bad: atomContentHash('atoms', null),
};

const cases = [
    ['G1 情节 normalizeAtom（含最短长度过滤 / fallback 楼层 / 标签并集）', cmpDim('atoms', G.inputs.ATOMS.map(x => normalizeAtom(x, { start: 7, end: 9 })), G.atoms)],
    ['G2 状态 normalizeCurrentState（字段中文化 / key 派生）', cmpDim('currentStates', G.inputs.STATES.map(x => normalizeCurrentState(x)), G.currentStates)],
    ['G3 记忆 normalizeMemory', cmpDim('memories', G.inputs.MEMS.map(x => normalizeMemory(x)), G.memories)],
    ['G4 概念 normalizeConcept', cmpDim('concepts', G.inputs.CONCEPTS.map(x => normalizeConcept(x)), G.concepts)],
    ['G5 平行事件 normalizeParallel', cmpDim('parallels', G.inputs.PARALLELS.map(x => normalizeParallel(x)), G.parallels)],
    ['G6 物品 normalizeItem', cmpDim('items', G.inputs.ITEMS.map(x => normalizeItem(x)), G.items)],
    ['G7 计划 normalizePlan（步骤/历史/线索/阶段）', cmpDim('plans', G.inputs.PLANS.map(x => normalizePlan(x)), G.plans)],
    ['G8 悬念 normalizeSuspense', cmpDim('suspense', G.inputs.SUSPENSE.map(x => normalizeSuspense(x)), G.suspense)],
    ['G9 名册 normalizeNpc', cmpDim('npcs', G.inputs.NPCS.map(x => normalizeNpc(x)), G.npcs)],
    ['G10 场景 normalizeScene（路径归一）', cmpDim('scenes', G.inputs.SCENES.map(x => normalizeScene(x)), G.scenes)],
];
for (const [name, r] of cases) R.assert(name, r.ok === true, r.why ? { why: r.why, got: r.got, want: r.want } : undefined);

R.assert('H1 内容哈希六例与 V1 完全一致（djb2+FNV 双哈希口径）', J(hashesGot) === J(G.hashes), { got: hashesGot, want: G.hashes });
R.assert('H2 哈希对缺省字段容错（瘦身后仍同哈希）',
    atomContentHash('atoms', { text: 'x' }) === atomContentHash('atoms', { text: 'x', title: '', entities: [], locations: [], tags: [] }),
    atomContentHash('atoms', { text: 'x' }));
R.assert('H3 哈希对非法输入返回空串（不抛异常）', atomContentHash('atoms', null) === '' && atomContentHash('atoms', 42) === '', atomContentHash('atoms', 42));

R.assert('S1 维度字数上限默认值与 V1 defaultCfg 一致（12 项）', J(dimCap('atoms', 'x'.repeat(500)).length) === J(G.helpers.dimCapAtoms), [dimCap('atoms', 'x'.repeat(500)).length, G.helpers.dimCapAtoms]);
R.assert('S2 标量助手与 V1 一致（标题兜底 / 字段中文化 / 标签并集 / extra / 值类型 / 日期裁剪）', (() => {
    const got = {
        dimCapAtoms: dimCap('atoms', 'x'.repeat(500)).length,
        atomTitleFromText: atomTitle({ text: '第一行标题。\n第二行' }),
        toChineseFieldMood: toChineseField('mood'),
        toChineseCategoryTrade: toChineseCategory('trade'),
        mergeTags: mergeTags(['a', 'a', 'b'], ['b', 'c']),
        makeExtra: makeExtra({ type: '事件', time: '黄昏', nothing: '' }),
        detectValueType: [detectValueType('s'), detectValueType(3), detectValueType(true), detectValueType(['a'])],
        clockDateTrim: clockDateTrim('1919-11-29T18:00:00Z'),
    };
    return J(got) === J(G.helpers);
})(), G.helpers);

R.done();
