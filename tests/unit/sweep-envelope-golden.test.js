// ============================================================
// 单元测试 · 批次 7（core/sweep.js 删除自动留痕与墓碑应用 + core/envelope.js 存储信封）与 V1 一致
// 黄金样本：tests/fixtures/v1-golden-sweep-envelope.json（oracle = 真实 V1 插件 v1.206）
// 口径：严格相等（JSON.stringify）；墓碑时间戳（墙钟）比较前归一。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { entryIndexInit, tombstoneSweep, applyTombstonesToState, entryIndexBuild } from '../../core/sweep.js';
import { storageEnvelope, storageHash, STORAGE_ENV_VERSION } from '../../core/envelope.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-sweep-envelope.json'), 'utf8'));
const R = makeReporter('sweep-envelope-golden V1 移植保真度（批次 7）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));
const tsNorm = (v) => {
    if (Array.isArray(v)) return v.map(tsNorm);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (typeof v[k] === 'number' && v[k] > 1e12) ? 'TS' : tsNorm(v[k]);
        return o;
    }
    return v;
};
const JT = (v) => J(tsNorm(v));
const fresh = () => ({
    atoms: clone(I.ATOMS), currentStates: [], snapshots: [], memories: clone(I.MEMS), items: [], plans: [], suspense: [], scenes: [],
    concepts: [], parallels: [], npcs: [], links: [], currencies: [], plotSegments: [], rumors: [], deleted: {}, deletedH: {}, vars: {}, stats: {},
    state: { time: '', date: '', location: '', sceneFocus: null },
});

R.assert('S1 条目索引构建（entryIndexBuild / entryIndexInit 幂等建立基线）', (() => {
    setKernelState(fresh());
    const idx = entryIndexBuild(true);
    entryIndexInit();
    return !!idx && typeof idx === 'object' && Object.keys(idx).length > 0;
})(), '');
R.assert('S2 删除自动留痕 tombstoneSweep 与 V1 一致（id 墓碑 + 内容哈希墓碑，双账本分维度）', (() => {
    const st = fresh(); setKernelState(st);
    entryIndexInit();
    // 移除一条情节与一条记忆（与 oracle 同口径）
    st.atoms = st.atoms.filter(x => x.id !== 'a2');
    st.memories = st.memories.filter(x => x.id !== 'm2');
    tombstoneSweep();
    const got = { deleted: clone(st.deleted || {}), deletedH: clone(st.deletedH || {}) };
    return JT(got) === JT(G.afterSweep);
})(), G.afterSweep.deleted);
R.assert('S3 墓碑内容哈希键与 V1 完全一致（同一内容跨端同哈希）',
    J(Object.keys(tsNorm((() => {
        const st = fresh(); setKernelState(st); entryIndexInit();
        st.atoms = st.atoms.filter(x => x.id !== 'a2');
        st.memories = st.memories.filter(x => x.id !== 'm2');
        tombstoneSweep();
        return st.deletedH;
    })()).atoms).sort()) === J(Object.keys(G.afterSweep.deletedH.atoms).sort()), Object.keys(G.afterSweep.deletedH.atoms));
R.assert('S4 applyTombstonesToState 与 V1 一致（被删条目按 id + 内容哈希双重剔除；返回 true）', (() => {
    // 与 oracle 同口径：同一份 state 先留痕（墓碑进 state.deleted/deletedH），再让被删条目「复活」并施加墓碑
    const st = fresh(); setKernelState(st);
    entryIndexInit();
    st.atoms = st.atoms.filter(x => x.id !== 'a2');
    st.memories = st.memories.filter(x => x.id !== 'm2');
    tombstoneSweep();
    const learn = { deleted: clone(st.deleted), deletedH: clone(st.deletedH) };
    st.atoms = clone(I.ATOMS);        // 模拟对端把被删条目又并集回来
    st.memories = clone(I.MEMS);
    const ret = applyTombstonesToState(learn);
    const got = { ret, atoms: (st.atoms || []).map(x => x && x.id), memories: (st.memories || []).map(x => x && x.id) };
    return JT(got) === JT(G.applied);
})(), G.applied);
R.assert('S5 存储信封结构与 V1 一致（v / scope / payload{scope,updatedAt,data} / hash / ts）', (() => {
    const st = fresh(); setKernelState(st);
    const e1 = storageEnvelope(st);
    const e2 = storageEnvelope(st);
    return J(Object.keys(e1).sort()) === J(G.envelopeKeys) && e1.v === STORAGE_ENV_VERSION
        && e1.scope === e2.scope && !!e1.payload && e1.payload.data === e2.payload.data
        && typeof e1.hash === 'string' && e1.hash.length > 0 && typeof e1.ts === 'number';
})(), G.envelopeKeys);
R.assert('S6 信封 payload.data 即注入的 state（内部一致；V1 信封包裹其活 state，V2 包裹注入态）', (() => {
    const st = fresh(); setKernelState(st);
    const e = storageEnvelope(st);
    return J(e.payload.data) === J(st) && e.payload.scope === e.scope;
})(), '');

R.assert('S7 信封 hash 为 payload 的双轮 FNV-1a 哈希（内部一致，跨端可校验）',
    storageEnvelope(fresh()).hash === storageHash(storageEnvelope(fresh()).payload), '');
R.assert('S8 storageHash 与 V1 逐字符一致（固定样本）', storageHash({ a: 1, b: ['x', 'y'] }) === G.hashSample, storageHash({ a: 1, b: ['x', 'y'] }));

setKernelState(null);
R.done();
