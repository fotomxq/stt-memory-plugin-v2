// ============================================================
// 单元测试 · `docs/D22` `业-3` / `docs/D6` §7 **P0 通用提升契约**（`core/promote.js`）
//
// 本批（v3.41.0）把「平行事件 → 情节」这一个特例抽成通用入口 `promoteToAtom(source, opts)`：
//   · 规格表逐行对应 `docs/D6` §4 的 **14 维度**（开放 9 / 不开放 2 / 不适用 1 / 不参与 2）；
//   · **P0 = 纯重构** —— 唯一接线维度是 `parallels`，其余开放维度（P1/P2/P4）如实拒绝，不静默降级；
//   · 平行路径行为**逐字不变**（由 `tests/unit/parallel-golden.test.js` P 组以真实 V1 oracle 锁定）；
//     本文件补的是「通用契约本身」的判据：规格表覆盖、拒绝口径、与薄封装的**等价性**、幂等与留痕。
//
// 运行：node tests/unit/promote-contract.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { promoteToAtom, promoteSpecDims, promoteWiredDims, PROMOTE_SPECS } from '../../core/promote.js';
import { promoteParallelEvent } from '../../core/parallel.js';

const R = makeReporter('promote-contract D6 P0 通用提升契约');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setScopeKey('甲');

const FIXED_NOW = 1575158400000;   // 2019-12-01
async function withFixedNow(fn) {
    const real = Date.now;
    Date.now = () => FIXED_NOW;
    try { return await fn(); } finally { Date.now = real; }
}

/** 起一套干净内核态（`state.state.date` 固定，供 `promotedAt` 回落用） */
function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.storeMinAtoms = 0;
    const st = Object.assign(emptyState(), clone(stateLike || {}));
    st.state = Object.assign({}, st.state || {});
    if (!st.state.date) st.state.date = '1919-12-01';   // `promotedAt` 默认回落剧情时钟日期
    setKernelState(st);
    try { entryIndexInit(); } catch (e) { /* 忽略 */ }
    setPersistHooks({
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setNotifyHooks({ toast: () => undefined });
    return st;
}
const PAR = { id: 'par1', title: '平行标题', text: '这条推演已经成真了。', type: '转折', date: '1919-11-20', characters: ['甲'], tags: ['甲'] };
const parState = () => ({ parallels: [clone(PAR)] });
/** 与平行路径等价性比对用的状态快照（只取提升会写到的地方） */
const stateView = () => clone({ parallels: state.parallels, atoms: state.atoms, deleted: state.deleted, deletedH: state.deletedH });

// ============================================================
// S 组：规格表与 `docs/D6` §4 / §8.2 一致
// ============================================================
A('S1 规格表覆盖 `docs/D6` §4 的 14 维度：开放 9 · 不开放 2 · 不适用 1 · 不参与 2',
    (() => {
        const dims = promoteSpecDims().slice().sort();
        const expect = ['atoms', 'concepts', 'currencies', 'currentStates', 'items', 'links', 'memories',
            'parallels', 'plans', 'plotSegments', 'rumors', 'scenes', 'snapshots', 'suspense'].sort();
        const open = dims.filter(d => PROMOTE_SPECS[d].open);
        const closed = dims.filter(d => !PROMOTE_SPECS[d].open);
        return J(dims) === J(expect) && dims.length === 14 && open.length === 9 && closed.length === 5
            && J(open.slice().sort()) === J(['concepts', 'currentStates', 'items', 'memories', 'parallels',
                'plans', 'rumors', 'scenes', 'suspense'].sort())
            && J(closed.slice().sort()) === J(['atoms', 'currencies', 'links', 'plotSegments', 'snapshots'].sort());
    })(), J({ dims: promoteSpecDims().length, open: promoteSpecDims().filter(d => PROMOTE_SPECS[d].open).length }));

A('S2 P0 接线面：`wired` 只有 `parallels`；其余 8 个开放维度均带 `phase` 且指向 `D6` §7 的阶段',
    (() => {
        const wired = promoteWiredDims();
        const pending = promoteSpecDims().filter(d => PROMOTE_SPECS[d].open && !PROMOTE_SPECS[d].wired);
        const phases = pending.map(d => PROMOTE_SPECS[d].phase);
        return J(wired) === J(['parallels']) && pending.length === 8
            && phases.every(p => ['P1', 'P2', 'P4'].indexOf(p) >= 0)
            && phases.filter(p => p === 'P1').length === 5 && phases.filter(p => p === 'P2').length === 1
            && phases.filter(p => p === 'P4').length === 2;
    })(), J({ wired: promoteWiredDims(), phases: promoteSpecDims().filter(d => PROMOTE_SPECS[d].open && !PROMOTE_SPECS[d].wired).map(d => d + ':' + PROMOTE_SPECS[d].phase) }));

A('S3 默认原条处置与 `docs/D6` §8.2 Q2 裁决一致：非平行开放维度 `promoted` · 平行保持 `removed`',
    (() => {
        const open = promoteSpecDims().filter(d => PROMOTE_SPECS[d].open);
        const bad = open.filter(d => {
            const want = d === 'parallels' ? 'removed' : 'promoted';
            return PROMOTE_SPECS[d].disposition !== want;
        });
        const noCond = open.filter(d => !String(PROMOTE_SPECS[d].condition || '').trim());
        return bad.length === 0 && noCond.length === 0;
    })(), J(promoteSpecDims().filter(d => PROMOTE_SPECS[d].open).map(d => d + '=' + PROMOTE_SPECS[d].disposition)));

// ============================================================
// N 组：拒绝口径（不静默降级）
// ============================================================
A('N1 未知维度如实拒绝，原因串带维度名（不抛异常、不写库）',
    (() => {
        boot(parState());
        const r = promoteToAtom({ dim: 'nope', id: 'par1' });
        return r.ok === false && r.reason === '未知维度：nope'
            && (state.atoms || []).length === 0 && (state.parallels || []).length === 1;
    })(), J(promoteToAtom({ dim: 'nope', id: 'x' })));

A('N2 不开放维度逐个如实拒绝，原因来自规格表（`open:false` 的 5 个维度全覆盖）',
    (() => {
        boot(parState());
        const closed = promoteSpecDims().filter(d => !PROMOTE_SPECS[d].open);
        return closed.every(d => {
            const r = promoteToAtom({ dim: d, id: 'x' });
            return r.ok === false && r.reason === PROMOTE_SPECS[d].reason && !!String(r.reason || '').trim();
        });
    })(), J(promoteSpecDims().filter(d => !PROMOTE_SPECS[d].open).map(d => [d, promoteToAtom({ dim: d, id: 'x' }).reason])));

A('N3 未接线的开放维度如实拒绝，原因指向 `docs/D6` §7 阶段（P0 不假装支持 P1/P2/P4）',
    (() => {
        boot(parState());
        const pending = promoteSpecDims().filter(d => PROMOTE_SPECS[d].open && !PROMOTE_SPECS[d].wired);
        return pending.every(d => {
            const r = promoteToAtom({ dim: d, id: 'x' });
            return r.ok === false && String(r.reason).indexOf('尚未落地') > 0 && String(r.reason).indexOf(PROMOTE_SPECS[d].phase) > 0;
        });
    })(), J(promoteToAtom({ dim: 'memories', id: 'm1' })));

A('N4 来源不存在 → 原因串与 V1 逐字一致（`parallels` 的 `notFoundReason`）',
    (() => {
        boot(parState());
        const r = promoteToAtom({ dim: 'parallels', id: 'nope' });
        return r.ok === false && J(r) === J({ ok: false, reason: '未找到该平行事件' })
            && (state.atoms || []).length === 0;
    })(), J(promoteToAtom({ dim: 'parallels', id: 'nope' })));

// ============================================================
// E 组：与薄封装等价 + 幂等 + 留痕
// ============================================================
await (async () => {
    let ok = false, extra = '';
    await withFixedNow(async () => {
        boot(parState());
        const viaGeneric = promoteToAtom({ dim: 'parallels', id: 'par1' });
        const viewGeneric = stateView();
        boot(parState());
        const viaWrapper = promoteParallelEvent('par1');
        const viewWrapper = stateView();
        ok = J(viaGeneric) === J(viaWrapper) && J(viewGeneric) === J(viewWrapper)
            && J(Object.keys(viaGeneric).sort()) === J(['atomId', 'ok', 'promotedAt', 'removed', 'updated']);
        extra = J({ viaGeneric: viaGeneric, equal: J(viewGeneric) === J(viewWrapper) });
    });
    A('E1 通用入口与 `promoteParallelEvent` **行为等价**：返回值与落库结果逐字相同（返回键集也一致）', ok, extra);
})();

await (async () => {
    let ok = false, extra = '';
    await withFixedNow(async () => {
        boot(parState());
        const first = promoteToAtom({ dim: 'parallels', id: 'par1' });
        const atomCount1 = (state.atoms || []).length;
        const atomsSnapshot = clone(state.atoms);
        // 把来源条放回（平行路径的处置是 `removed`），再提升一次 → 应原地更新同一条情节
        state.parallels = [Object.assign(clone(PAR), { promotedTo: first.atomId })];
        const second = promoteToAtom({ dim: 'parallels', id: 'par1' });
        ok = first.updated === false && second.updated === true && second.ok === true
            && second.atomId === first.atomId && (state.atoms || []).length === atomCount1
            && J(state.atoms) === J(atomsSnapshot);
        extra = J({ first: first, second: second, atomCount: [atomCount1, (state.atoms || []).length] });
    });
    A('E2 幂等键 `source:{dim,id}`：同一来源二次提升 → 原地更新上次生成的那条情节（不新增事实）', ok, extra);
})();

await (async () => {
    let ok = false, extra = '';
    await withFixedNow(async () => {
        boot(parState());
        const r1 = promoteToAtom({ dim: 'parallels', id: 'par1' });
        boot(parState());
        const r2 = promoteToAtom({ dim: 'parallels', id: 'par1' }, { text: '由调用方指定的提升正文内容。', at: '1920-01-01' });
        ok = r1.promotedAt === '1919-12-01' && r2.promotedAt === '1920-01-01'
            && String((state.atoms || [])[0] && state.atoms[0].text) === '由调用方指定的提升正文内容。'
            && r2.removed === true;
        extra = J({ defaultAt: r1.promotedAt, overrideAt: r2.promotedAt });
    });
    A('E3 留痕：`promotedAt` 默认回落剧情时钟日期、`opts.at` 可覆盖（与 `D6` §3 环节 7 一致）', ok, extra);
})();

await (async () => {
    let ok = false, extra = '';
    await withFixedNow(async () => {
        boot({ parallels: [{ id: 'p-short', title: '短', text: '很短' }] });
        const r = promoteToAtom({ dim: 'parallels', id: 'p-short' });
        ok = r.ok === false && r.reason === '内容过短：情节正文需 ≥8 字（请先补全平行事件描述）'
            && (state.atoms || []).length === 0 && (state.parallels || []).length === 1;
        extra = J(r);
    });
    A('E4 前置校验（环节 ②）：正文 <8 字且标题补足后仍不足 → 拒绝且不落库', ok, extra);
})();

R.done();
