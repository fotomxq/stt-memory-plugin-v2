// ============================================================
// 单元测试 · 批次 3（core/state.js + core/merge.js）与 V1 黄金样本一致
// 黄金样本：tests/fixtures/v1-golden-state-merge.json（V1 源码切片产出，角色 id 固定为 'test-char'）
// 口径：严格相等（JSON.stringify）；墓碑时间戳为墙钟，比较前抹平。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { setKernelState, setScopeKey, VERSION } from '../../core/model/runtime.js';
import { emptyState, scopeId, stateKey } from '../../core/state.js';
import { atomIsHidden, atomHiddenCount, activeAtoms, capAtomsKeepingHidden, releaseMergedSources, eachAtom, ensureAtomHashes, collectAtomHashes, tombstoneMap, tombstoneHMap, tombSet, tombSetH, tombEntry, tombMany, tombEntries } from '../../core/merge.js';
import { atomContentHash } from '../../core/model/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-state-merge.json'), 'utf8'));
const R = makeReporter('state-merge-golden V1 移植保真度（批次 3）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);
const stripTs = (v) => {
    if (Array.isArray(v)) return v.map(stripTs);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (k === 'updatedAt' || k === 'summarizedAt' || k === 'now') && typeof v[k] === 'number' ? 0 : stripTs(v[k]);
        return o;
    }
    return v;
};
const JT = (v) => J(stripTs(v));
const st = () => {
    const s = { atoms: [], memories: [], links: [], deleted: {}, deletedH: {}, state: {} };
    setKernelState(s);
    return s;
};

setScopeKey('test-char');

// ---------- 作用域与空状态 ----------
R.assert('S1 scopeId / stateKey 与 V1 同口径（char:<hash>；存档键前缀一致）',
    scopeId() === G.scope.id && stateKey() === G.scope.key, { got: [scopeId(), stateKey()], want: [G.scope.id, G.scope.key] });
R.assert('S2 emptyState 容器与字段与 V1 完全一致（14 维 + 墓碑账本 + 时钟 + 主角 + 快照链等）', (() => {
    const e = emptyState();
    const got = {
        keys: Object.keys(e), scope: e.scope,
        dims: ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'npcs', 'links', 'currencies', 'plotSegments', 'rumors'].map(k => Array.isArray(e[k]) ? k : k + ':' + typeof e[k]),
        hasDeleted: !!e.deleted, hasDeletedH: !!e.deletedH, vars: e.vars, snapStore: e.snapStore, state: e.state,
    };
    // V1 的 emptyState 写的是当时的 VERSION（切片用桩值），V2 写当前版本 —— 单独断言版本
    const want = JSON.parse(J(G.empty)); delete want.version;
    return JT(got) === JT(want) && e.version === VERSION;
})(), Object.keys(emptyState()));

// ---------- 隐藏条目保护 ----------
R.assert('H1 atomIsHidden / atomHiddenCount / activeAtoms（含 null 与空对象条目容错）', (() => {
    const s = st(); s.atoms = JSON.parse(J(I.ATOMS));
    return J(s.atoms.map(x => atomIsHidden(x))) === J(G.hidden.isHidden) && atomHiddenCount() === G.hidden.count
        && J(activeAtoms().map(x => x.id)) === J(G.hidden.activeIds);
})(), G.hidden);
R.assert('H2 capAtomsKeepingHidden：优先保留隐藏条目（cap=1 / cap=2）', (() => {
    const s = st(); s.atoms = JSON.parse(J(I.ATOMS));
    return J(capAtomsKeepingHidden(s.atoms, 1).map(x => x && x.id)) === J(G.hidden.cap1)
        && J(capAtomsKeepingHidden(s.atoms, 2).map(x => x && x.id)) === J(G.hidden.cap2);
})(), G.hidden);
R.assert('H3 releaseMergedSources：删除总结条 → 来源恢复显示（返回恢复条数）', (() => {
    const s = st(); s.atoms = JSON.parse(J(I.ATOMS));
    const r = releaseMergedSources({ id: 's1', mergedSummary: { sourceIds: ['a2', 'a3'] } });
    const got = { returned: r, atoms: s.atoms.map(x => x && ({ id: x.id, hidden: x.hidden === true, hasBy: !!x.summarizedBy })) };
    return JT(got) === JT(G.release);
})(), G.release);

// ---------- 删除墓碑 ----------
R.assert('T1 tombSet / tombSetH 分账与幂等（重复写入不覆盖时间戳）', (() => {
    const s = st();
    s.deleted = {}; s.deletedH = {};
    tombSet('atoms', 'a9');
    const t1 = s.deleted.atoms.a9;
    tombSet('atoms', 'a9');
    const t2 = s.deleted.atoms.a9;
    tombSetH('atoms', 'content-hash-1');
    const h1 = s.deletedH.atoms['content-hash-1'];
    tombSetH('atoms', 'content-hash-1');
    const h2 = s.deletedH.atoms['content-hash-1'];
    return Number.isFinite(t1) && t1 === t2 && Number.isFinite(h1) && h1 === h2
        && !!s.deleted.atoms && !!s.deletedH.atoms && !s.deletedH.memories;
})(), '');
R.assert('T2 墓碑账本结构与 V1 一致（id 墓碑 + 内容哈希墓碑分账；空 id 被忽略）', (() => {
    const s = st();
    s.deleted = {}; s.deletedH = {};
    const many = tombMany('memories', ['m1', 'm2', '']);
    const entries = tombEntries('memories', [{ text: '第一条记忆内容' }, { content: '第二条记忆内容' }]);
    const got = {
        ids: Object.keys(s.deleted.memories || {}).sort(),
        hIds: Object.keys(s.deletedH.memories || {}).sort(),
        many, entries,
    };
    const want = {
        ids: Object.keys(G.tombstones.deleted.memories).sort(),
        hIds: Object.keys(G.tombstones.deletedH.memories).sort(),
        many: G.tombstones.many, entries: G.tombstones.entries,
    };
    return J(got) === J(want);
})(), '');
R.assert('T3 内容哈希墓碑键 = atomContentHash/内容指纹（与 V1 同口径）', (() => {
    const s = st(); s.deleted = {}; s.deletedH = {};
    tombEntries('memories', [{ text: '第一条记忆内容' }, { content: '第二条记忆内容' }]);
    return J(Object.keys(s.deletedH.memories).sort()) === J(Object.keys(G.tombstones.deletedH.memories).sort());
})(), Object.keys(G.tombstones.deletedH.memories));

// ---------- 哈希补全与遍历 ----------
R.assert('E1 eachAtom 遍历原子维度（含 plotSegments 等新维度）', (() => {
    const s = st();
    s.atoms = [{ id: 'e1', text: '情节一正文足够长。' }];
    s.memories = [{ id: 'e2', owner: '甲', content: '记忆一正文' }];
    s.plotSegments = [{ id: 'e3', header: '1919-11-29 ~ 1919-11-30' }];
    const seen = [];
    eachAtom((cat, it) => seen.push(cat + ':' + it.id));
    return J(seen) === J(G.eachAtom);
})(), G.eachAtom);
R.assert('E2 ensureAtomHashes：缺失补全、已有保留（与 V1 一致）', (() => {
    const s = st();
    s.atoms = [{ id: 'h1', text: '需要补哈希的情节正文（足够长）。', title: '补哈希', date: '1919-11-29' },
               { id: 'h2', text: '第二条需要补哈希的情节正文。', title: '补哈希二', date: '1919-11-30', h: 'preset-hash' }];
    s.memories = [{ id: 'm1', owner: '甲', content: '一条记忆正文' }];
    const before = s.atoms.map(x => x.h || '(none)');
    const added = ensureAtomHashes();
    return J(before) === J(G.hashes.before) && J(s.atoms.map(x => x.h)) === J(G.hashes.after) && !!added;
})(), G.hashes);
R.assert('E3 collectAtomHashes 返回结构（agg / map / order）与 V1 一致', (() => {
    const s = st();
    s.atoms = [{ id: 'h1', text: '需要补哈希的情节正文（足够长）。', title: '补哈希', date: '1919-11-29', h: G.hashes.after[0] }];
    s.memories = [];
    const c = collectAtomHashes();
    return J(Object.keys(c).sort()) === J(G.hashes.collectedKeys) && typeof c.agg === 'string' && Array.isArray(c.order) && !!c.map;
})(), Object.keys(collectAtomHashes()).sort());
R.assert('E4 哈希值与 atomContentHash 同源（同一内容 → 同一 h）', (() => {
    const a = { id: 'h1', text: '需要补哈希的情节正文（足够长）。', title: '补哈希', date: '1919-11-29' };
    return atomContentHash('atoms', a) === G.hashes.after[0];
})(), atomContentHash('atoms', { id: 'h1', text: '需要补哈希的情节正文（足够长）。', title: '补哈希', date: '1919-11-29' }));

setKernelState(null);
R.done();
