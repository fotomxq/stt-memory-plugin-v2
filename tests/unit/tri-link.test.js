// ============================================================
// 单元测试 · v3.46.1（`docs/D22` §4.12 **W11** 传言 · 计划 · 悬念三域联动；来源稿 `docs/D32` v1.0）
//
// 用户要求（原话）：「新版本，v3.46.1 / 开发待开发的W11」；`docs/D32` §6 的 Q1–Q8 已**整批采纳建议默认**（用户裁决）。
//
// 本档覆盖（对应 W11 的落点）：
//   A 数-33 关联层扩维（四处同批）：`rumors` 进白名单 + how 子表 + kind；**孤儿条目口径仍 4 维**（不因扩维冒孤儿）
//   B 数-35 打包三段：条数 / **不含情节正文**（不依赖提取）/ 截断如实计数
//   C 技-45 七条校验的**反向探针**（逐条构造非法 op → 必须被拒且原因可分）
//   D 数-34 P↔S 双向镜像 · 数-36 幂等与留痕槽位 · 应用**不新增/不删除条目**
// 运行：node tests/unit/tri-link.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { REL_LINK_DIMS as REL_DIMS_MODEL, REL_ORPHAN_ITEM_DIMS, normalizeRelLink, relOrphanStats, REL_LINK_HOW_LEGAL, REL_LINK_KINDS } from '../../core/model/rel.js';
import { RUNTIME_SLOTS } from '../../core/state-slots.js';
import {
    TRI_DIMS, TRI_PATCH_SPEC, TRI_RULES, TRI_LOG_MAX, triPack, triParse, triValidate, triApply, triSig,
    triClampPatch, triLogPush, triLogList, triNoteText, triCfg,
} from '../../core/tri-link.js';

const R = makeReporter('tri-link v3.46.1 W11（三域联动：扩维 / 打包 / 七条校验 / 应用与留痕）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setContextProvider(() => makeHost({ chat: [] }).ctx);

function boot(over) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:tri');
    const st = Object.assign(emptyState(), over || {});
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}
/** 一份最小的三域语料（1 传言 / 1 计划 / 1 悬念 + 两条事实锚） */
function seed() {
    return {
        rumors: [{ id: 'rum1', subject: '码头夜里卸过铜箱', content: '据说有人半夜看见铜箱', stage: '萌芽', ferment: 10, objectivity: '主观', chain: [], carriers: ['甲'] }],
        plans: [{ id: 'pln1', title: '把铜箱运出城', content: '计划正文', status: 'open', progress: 20, phase: '', history: [], blockers: [] }],
        suspense: [{ id: 'sus1', title: '铜箱里是什么', content: '悬念正文', status: 'open', level: '主线', clues: [], history: [] }],
        atoms: [{ id: 'a1', title: '第一次卸货', date: '1919-11-29', content: '正文不该进打包体' }, { id: 'a2', title: '甲受伤', date: '1919-11-30', content: '正文不该进打包体' }],
        links: [],
        state: { date: '1919-12-01' },
    };
}

// ==================== A 组：数-33 关联层扩维（四处同批） ====================
A('A1 扩维**四处同批**：`core/model/rel.js`（导出，可直接断言）· `core/entries.js` · `core/recall.js` 三处重复常量都含 `rumors`（**源码级**断言 —— 常量是刻意复制的，本档正是用来锁住它们同步），维护侧 `core/rel-maint.js` 引用同一常量；`kind` 增 `rumor`，how 子表给传言专属值', (() => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const declOf = (rel) => {
        const src = readFileSync(join(ROOT, rel), 'utf8');
        const m = src.match(/const REL_LINK_DIMS = \[([^\]]*)\]/);
        return m ? m[1] : '';
    };
    const entriesDims = declOf('core/entries.js');
    const recallDims = declOf('core/recall.js');
    const maintSrc = readFileSync(join(ROOT, 'core/rel-maint.js'), 'utf8');
    const legal = REL_LINK_HOW_LEGAL.rumors || [];
    return REL_DIMS_MODEL.indexOf('rumors') >= 0
        && entriesDims.indexOf("'rumors'") >= 0 && recallDims.indexOf("'rumors'") >= 0      // 四处同批（此处锁三处 + 维护侧引用）
        && maintSrc.indexOf('REL_LINK_DIMS') >= 0
        && REL_LINK_KINDS.indexOf('rumor') >= 0
        && legal.indexOf('heard') >= 0 && legal.indexOf('spread') >= 0
        && legal.indexOf('participant') < 0;                       // 传言的"亲历"没有意义（子表刻意不同）
})(), J({ model: REL_DIMS_MODEL, legal: REL_LINK_HOW_LEGAL.rumors }));

A('A2 传言的锚行可承载结构化引用（`planRef` / `suspenseRef`）：`normalizeRelLink` 保留它们；**孤儿条目口径仍 4 维**（扩维不会一夜冒出上百条「孤儿」）', (() => {
    const st = boot(seed());
    const row = normalizeRelLink({ dim: 'rumors', refId: 'rum1', who: '', planRef: 'pln1', suspenseRef: 'sus1', public: true }, 'rumors');
    st.links = [row];
    const orph = relOrphanStats();
    return !!row && row.planRef === 'pln1' && row.suspenseRef === 'sus1' && row.public === true
        && J(REL_ORPHAN_ITEM_DIMS) === J(['memories', 'plans', 'suspense', 'parallels'])
        && orph.itemDims.rumors === undefined;                     // 传言**不参与**孤儿条目计数
})(), (() => J({ dims: REL_ORPHAN_ITEM_DIMS, orph: relOrphanStats() }))());

// ==================== B 组：数-35 打包三段 ====================
A('B1 打包三段**只读**且**不读楼层正文**：含三域条目 / 关联行 / 事实锚（`{id,标题,日期}`），**不含情节正文**，`ids` 可用于端点校验', (() => {
    const st = boot(seed());
    const p = triPack({ scope: 'rumors' });
    const hasAtomBody = p.text.indexOf('正文不该进打包体') >= 0;
    return p.counts.rumors === 1 && p.counts.plans === 1 && p.counts.suspense === 1
        && p.ids.rumors.rum1 === true && p.ids.plans.pln1 === true && p.ids.suspense.sus1 === true
        && (p.sections.facts || []).length === 2 && p.sections.facts[0].id === 'a1'
        && hasAtomBody === false                                   // **不打包情节正文**（Q5：只给 id/标题/日期）
        && st.rumors[0].stage === '萌芽' && st.plans[0].progress === 20;   // 打包不改任何数据
})(), (() => { const p = triPack({ scope: 'rumors' }); return J({ counts: p.counts, chars: p.chars, facts: (p.sections.facts || []).length }); })());

A('B2 截断**如实计数**：`triLinkMaxItems` 调小后每域按上限截断，`truncated.items` 记下被截条数（不静默丢弃）', (() => {
    const many = seed();
    many.rumors = [];
    for (let i = 0; i < 8; i++) many.rumors.push({ id: 'rum' + i, subject: '传言' + i, content: 'x', stage: '萌芽', ferment: 0 });
    const st = boot(many);
    cfg.triLinkMaxItems = 3;
    const p = triPack({ scope: 'rumors' });
    return p.counts.rumors === 3 && p.truncated.items === 5 && triCfg().maxItems === 3;
})(), (() => { cfg.triLinkMaxItems = 2; const p = triPack({ scope: 'rumors' }); return J({ c: p.counts, t: p.truncated }); })());

// ==================== C 组：技-45 七条校验（反向探针） ====================
A('C1 合法 op 通过；**七条判据各有一条反向探针**被拒且原因可分（端点不存在 / 同域 / 白名单外字段 / 无关联 / knows 缺人 / 知情边界 / 非单调）', (() => {
    const st = boot(seed());
    const p = triPack({ scope: 'rumors' });
    const good = { src: { dim: 'rumors', id: 'rum1' }, dst: { dim: 'plans', id: 'pln1' }, link: 'about', effect: 'annex', patch: { statusNote: '风险上升' }, evidence: { ref: 'a1', quote: '卸货' }, reason: 'L3' };
    const cases = [
        ['endpoint-not-packed', Object.assign({}, good, { dst: { dim: 'plans', id: 'nope' } })],
        ['same-dim', Object.assign({}, good, { dst: { dim: 'rumors', id: 'rum1' } })],
        ['patch-not-allowed', Object.assign({}, good, { patch: { content: '改写正文' } })],
        ['no-link', Object.assign({}, good, { link: 'mirrors' })],
        ['knows-without-who', Object.assign({}, good, { link: 'knows' })],
        ['no-knowledge-basis', Object.assign({}, good, { link: 'knows', who: '乙' })],
    ];
    const results = {};
    for (const [want, op] of cases) {
        const v = triValidate([op], p);
        results[want] = v.rejected.length === 1 && (v.rejected[0].reasons || []).indexOf(want) >= 0;
    }
    // 单调性：目标条目已有更晚的留痕 → 当前剧情日期更早 → 拒收
    st.plans[0].history = [{ text: '更晚的留痕', at: '1920-01-01' }];
    const mono = triValidate([good], triPack({ scope: 'rumors' }));
    results['not-monotonic'] = mono.rejected.length === 1 && (mono.rejected[0].reasons || []).indexOf('not-monotonic') >= 0;
    // 合法 op：清掉那条未来留痕后必须通过
    st.plans[0].history = [];
    const ok = triValidate([good], triPack({ scope: 'rumors' }));
    const allRejected = Object.keys(results).every((k) => results[k] === true);
    return allRejected && ok.accepted.length === 1 && ok.rejected.length === 0
        && ok.accepted[0].patch.statusNote === '风险上升';
})(), (() => {
    boot(seed());
    const p = triPack({ scope: 'rumors' });
    const v = triValidate([{ src: { dim: 'rumors', id: 'rum1' }, dst: { dim: 'plans', id: 'pln1' }, link: 'knows' }], p);
    return J(v.reasons);
})());

A('C2 钳制与解析：`ferment` 单轮 Δ ≤ 25 且夹在 0-100；`progress` Δ ≤ 20；`stage` 只能改到**相邻档**；坏 JSON / 无 ops 一律解析失败', (() => {
    const st = boot(seed());
    const rum = st.rumors[0], pln = st.plans[0];
    rum.ferment = 90;
    const f1 = triClampPatch('rumors', { ferment: 200 }, rum);
    const p1 = triClampPatch('plans', { progress: 100 }, pln);
    const s1 = triClampPatch('rumors', { stage: '消退' }, rum);      // 萌芽 → 消退：跨档 → 拒
    const s2 = triClampPatch('rumors', { stage: '扩散' }, rum);      // 萌芽 → 扩散：相邻 → 过
    return f1.ferment === 100 && p1.progress === 40 && s1 === null && s2.stage === '扩散'
        && triParse('not json') === null && triParse('{"ops":[]}').ops.length === 0
        && triParse('```json\n{"ops":[{"a":1}]}\n```').ops.length === 1;
})(), '');

// ==================== D 组：数-34 镜像 · 数-36 幂等与留痕 · 纪律 ====================
A('D1 `about` 落库：**源条目锚行**承载 `planRef`（R→P）；P↔S **双向镜像**同写两侧锚行；条目数**一条不增不减**', (() => {
    const st = boot(seed());
    const links = [
        { src: { dim: 'rumors', id: 'rum1' }, dst: { dim: 'plans', id: 'pln1' }, link: 'about', patch: {}, effect: 'annex' },
        { src: { dim: 'plans', id: 'pln1' }, dst: { dim: 'suspense', id: 'sus1' }, link: 'about', patch: {}, effect: 'annex' },
    ];
    const before = { r: st.rumors.length, p: st.plans.length, s: st.suspense.length };
    const out = triApply(links);
    const rumAnchor = (st.links || []).filter((x) => x.dim === 'rumors' && x.refId === 'rum1' && !x.who)[0] || {};
    const planAnchor = (st.links || []).filter((x) => x.dim === 'plans' && x.refId === 'pln1' && !x.who)[0] || {};
    const susAnchor = (st.links || []).filter((x) => x.dim === 'suspense' && x.refId === 'sus1' && !x.who)[0] || {};
    return rumAnchor.planRef === 'pln1'
        && planAnchor.suspenseRef === 'sus1' && susAnchor.planRef === 'pln1'          // **双向镜像**
        && before.r === st.rumors.length && before.p === st.plans.length && before.s === st.suspense.length
        && out.links >= 3;
})(), (() => J((state.links || []).map((x) => [x.dim, x.refId, x.who || '-', x.planRef || '', x.suspenseRef || ''])))());

A('D2 `knows` 落库：人行写在**源条目**（`who` + `how`）；`state.triLinkLog` 末 5 条（第 6 条挤掉第 1 条）；RUNTIME_SLOTS 已登记该槽位', (() => {
    const st = boot(seed());
    st.links = [{ dim: 'rumors', refId: 'rum1', who: '', how: '', planRef: 'pln1', public: true }];   // 先有公开锚行（过知情边界）
    triApply([{ src: { dim: 'rumors', id: 'rum1' }, dst: { dim: 'plans', id: 'pln1' }, link: 'knows', who: '甲', patch: {} }]);
    const row = (st.links || []).filter((x) => x.dim === 'rumors' && x.refId === 'rum1' && x.who === '甲')[0] || {};
    for (let i = 0; i < 7; i++) triLogPush({ scope: 'rumors', ops: i, links: 1 });
    const log = triLogList();
    return row.how === 'heard' && log.length === TRI_LOG_MAX && log[TRI_LOG_MAX - 1].ops === 6
        && !!RUNTIME_SLOTS.triLinkLog && RUNTIME_SLOTS.triLinkLog.disposition === 'runtime';
})(), (() => J({ log: triLogList().length, row: (state.links || []).filter((x) => x.who === '甲')[0] }))());

A('D3 幂等与提示行：同「打包指纹 + ops」得到**同一个签名**（重复提交可被跳过）；提示行按 §3.9 口径给出四项计数', (() => {
    const st = boot(seed());
    const p = triPack({ scope: 'rumors' });
    const ops = [{ src: { dim: 'rumors', id: 'rum1' }, dst: { dim: 'plans', id: 'pln1' }, link: 'about', effect: 'annex', patch: {}, evidence: { ref: 'a1' }, reason: 'L3' }];
    const v = triValidate(ops, p);
    const s1 = triSig(p, v.accepted), s2 = triSig(triPack({ scope: 'rumors' }), v.accepted);
    const text = triNoteText({ links: 2, notes: 1, fields: 3 }, 4, { items: 1 });
    return !!s1 && s1 === s2 && text.indexOf('关联 2') >= 0 && text.indexOf('留痕 1') >= 0 && text.indexOf('状态 3') >= 0
        && text.indexOf('拒绝 4') >= 0 && text.indexOf('截断 1') >= 0
        && TRI_RULES.length === 13 && TRI_DIMS.length === 3 && !!TRI_PATCH_SPEC.plans.progress;
})(), '');

R.done();
