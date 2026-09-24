// ============================================================
// 单元测试 · core/model 批次 2b（关联层 links / 传言 rumors）与 V1 黄金样本一致
// 黄金样本：tests/fixtures/v1-golden-model3.json（V1 源码切片产出，含「重抛探针」补齐被 try/catch 吞掉的常量依赖）
// 口径：严格相等（JSON.stringify）；传言的 createdAt/updatedAt 为墙钟，比较前抹平。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { setKernelState, cfg } from '../../core/model/runtime.js';
import { normalizeRelLink, relLinksOf, relOrphanStats, relSummaryLine } from '../../core/model/rel.js';
import { normalizeRumor, rumorId, rumorChildId, rumorSubjectKey, normalizeRumorCarriers, normalizeRumorMediaList, normalizeRumorChain, normalizeRumorLineage, normalizeRumorPending, parseRumorCarriersText, parseRumorMediaText, rumorStageByFerment, mergeRumorObjects } from '../../core/model/rumor.js';
import { atomContentHash } from '../../core/model/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-model3.json'), 'utf8'));
const R = makeReporter('model-golden3 V1 移植保真度（批次 2b：links / rumors）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);
const stripTs = (v) => {
    if (Array.isArray(v)) return v.map(stripTs);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (k === 'createdAt' || k === 'updatedAt' || k === 'rev') ? (typeof v[k] === 'number' ? 0 : v[k]) : stripTs(v[k]);
        return o;
    }
    return v;
};
const JT = (v) => J(stripTs(v));

Object.assign(cfg.dimCharLimits, G.dimCharLimits);
setKernelState({ state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, snapshots: [], npcs: [], links: [], atoms: [], memories: [] });

// ---------- 关联层 ----------
const links = I.LINKS.map(x => normalizeRelLink(x));
R.assert('L1 normalizeRelLink 与 V1 一致（维度白名单 / 非锚行清空条目级属性 / 越界方式留痕 / parallels 强制 related）',
    JT(G.links) === JT(links), { got: stripTs(links)[0], want: stripTs(G.links)[0] });
R.assert('L2 非法输入与非法维度返回 null（与 V1 一致）', JT(G.links) === JT(links) && links.filter(Boolean).length === 5, links.filter(Boolean).length);
R.assert('L3 relLinksOf（按条目取关联行 / 缺失返回空 / 全量计数）', (() => {
    setKernelState({ state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, links: links.filter(Boolean) });
    const got = { all: relLinksOf('memories', 'm1'), missing: relLinksOf('memories', 'nope'), count: relLinksOf().length };
    // 注：无参调用返回空（V1 语义：必须给维度与 refId），count 恒为 0，与黄金样本一致
    return JT(got.all) === JT(G.linksOf.all) && JT(got.missing) === JT(G.linksOf.missing) && got.count === G.linksOf.count;
})(), relLinksOf('memories', 'm1'));
R.assert('L4 relOrphanStats（孤立关联统计：5 行均无对应条目 → 5 行孤立，按维度计数）', (() => {
    // 与黄金样本生成时的注入态一致：links 有值，其余维度为空
    setKernelState({ state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, links: links.filter(Boolean), memories: [], plans: [], suspense: [], parallels: [], atoms: [] });
    const got = relOrphanStats();
    setKernelState({ state: { date: '1920-03-15' }, protagonist: { name: '角色甲' }, links: [], snapshots: [], npcs: [] });
    return JT(got) === JT(G.linksOf.orphans);
})(), relOrphanStats());
R.assert('L5 relSummaryLine 摘要行与 V1 一致', relSummaryLine(links.filter(Boolean)[0]) === G.linksOf.summary, relSummaryLine(links.filter(Boolean)[0]));
R.assert('L6 关联行内容哈希与 V1 一致', atomContentHash('links', links.filter(Boolean)[0]) === G.hashes.link, atomContentHash('links', links.filter(Boolean)[0]));

// ---------- 传言 ----------
const rumors = I.RUMORS.map(x => normalizeRumor(x));
R.assert('R1 normalizeRumor 与 V1 一致（主体/说法正文/客观性/阶段与发酵度/传播者/载体/链路/谱系/待办）',
    JT(G.rumors) === JT(rumors), { got: stripTs(rumors)[0], want: stripTs(G.rumors)[0] });
R.assert('R2 过滤规则一致（缺主体或正文 → null）', rumors.filter(Boolean).length === 3, rumors.filter(Boolean).length);
R.assert('R3 rumorId / rumorChildId / rumorSubjectKey 与 V1 一致',
    JT(I.RUMORS.map(x => ({ id: rumorId(x.subject, x.content), child: rumorChildId('码头货栈失窃', '码头货栈失窃·二'), key: rumorSubjectKey(x.subject) }))) === JT(G.rumorIds),
    I.RUMORS.map(x => rumorId(x.subject, x.content)));
R.assert('R4 传播者文本解析 parseRumorCarriersText', JT([I.CARRIERS_TEXT, '角色甲', '', null].map(t => parseRumorCarriersText(t))) === JT(G.carriers), G.carriers);
R.assert('R5 载体文本解析 parseRumorMediaText', JT([I.MEDIA_TEXT, '大字报', '', null].map(t => parseRumorMediaText(t))) === JT(G.media), G.media);
R.assert('R6 阶段映射 rumorStageByFerment（-5 / 0 / 10…200）', JT([-5, 0, 10, 30, 50, 70, 90, 100, 200].map(f => ({ f, s: rumorStageByFerment(f) }))) === JT(G.stages), G.stages);
R.assert('R7 mergeRumorObjects（合并 / 自合并 / 空合并）', (() => {
    const a = normalizeRumor(I.RUMORS[0]);
    const b = normalizeRumor({ subject: '码头货栈失窃', content: '货栈被搬空且无人察觉，有人说看见陌生人。', objectivity: '主观', ferment: 80, stage: '发酵', carriers: '角色丁', tags: ['新标签'] });
    const got = { a, b, merged: mergeRumorObjects(a, b), self: mergeRumorObjects(a, a), empty: mergeRumorObjects(a, null) };
    return JT(got) === JT(G.merge);
})(), stripTs(G.merge.merged));
R.assert('R8 单项归一（链路 / 谱系 / 待办 / 传播者 / 载体）', (() => {
    const got = {
        chain: normalizeRumorChain([{ kind: '起源', at: '1919-11-29', text: '甲目睹' }, { kind: '乱写' }]),
        lineage: normalizeRumorLineage({ parent: '码头货栈失窃', gen: 2 }),
        pending: normalizeRumorPending({ to: '扩散', rounds: 2 }),
        carriersNorm: normalizeRumorCarriers([{ role: '源头', name: '甲' }, { role: '乱写', name: '乙' }, '丙']),
        mediaNorm: normalizeRumorMediaList([{ type: '口耳相传', durability: 3 }, { type: '乱写' }, '报刊']),
    };
    return JT(got) === JT(G.helpers);
})(), G.helpers);
R.assert('R9 传言内容哈希与 V1 一致', atomContentHash('rumors', rumors.filter(Boolean)[0]) === G.hashes.rumor, atomContentHash('rumors', rumors.filter(Boolean)[0]));
R.assert('R10 rumorId 单参形式与 V1 一致', rumorId('码头货栈失窃') === G.hashes.rumorId, rumorId('码头货栈失窃'));

R.done();
