// ============================================================
// 单元测试 · v3.31.0 本机层**结构化分片**（逐维文件 / 逐维键，而不是聚合成单一文件）
//
// 用户要求（原话）：「本地文件可以拆碎了保存，这样方便分片处理，呈现结构化、体系化，而不是聚合到单一文件。
//   其他本地存储文件同理。」
//
// 口径（`adapters/local-shards.js`，**纯函数**）：
//   · 切分：`splitParts(env)` → `{meta, <维度>…}`（meta = 非维度字段：state/vars/stats/deleted/台账…）；
//   · 合并：`joinParts(parts)` → 同一份 data（可再包成信封）；
//   · 清单：`buildManifest(parts)` 逐片记 hash/bytes/n；`verifyParts()` **坏一维只报那一维**；
//   · 命名：目录 = `<scope>/<维度>.json` + `manifest.json`；浏览器 = `ftt2_ls_<scope>__<维度>`。
//
// 运行：node tests/unit/local-shards.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { emptyState } from '../../core/state.js';
import {
    LOCAL_SHARD_V, META_SHARD, shardDims, scopeSlug, shardFileName, shardKeyName,
    manifestFileName, manifestKeyName, splitParts, joinParts, buildManifest, verifyParts, allShardNames,
} from '../../adapters/local-shards.js';

const R = makeReporter('local-shards v3.31.0 本机层结构化分片（逐维文件 / 逐维键）');
const A = (n, c) => R.assert(n, c === true, '');
const J = (v) => JSON.stringify(v);

/** 造一份有内容的信封 */
function mkEnv() {
    const st = emptyState();
    st.updatedAt = 1791300000000;
    st.atoms = [{ id: 'a1', text: '甲在码头。', title: 't', tags: [] }, { id: 'a2', text: '乙在船上。', title: 't2', tags: [] }];
    st.memories = [{ id: 'm1', title: '账册', content: '记着三只木箱。' }];
    st.items = [{ id: 'i1', title: '铜箱', content: '两只。' }];
    st.processedFloors = [{ f: 3, h: 'h3' }];
    st.vars = { foo: 1 };
    st.chatKey = 'chat-1';
    return { v: 1, scope: 'char:1xbib3t', payload: { scope: 'char:1xbib3t', updatedAt: st.updatedAt, data: st }, hash: 'x', ts: 1 };
}

A('A1 切分：逐维成片（meta = 非维度字段），维度数 = DIMENSIONS 的维度数 + meta', (() => {
    const r = splitParts(mkEnv());
    return r.ok === true && r.at === 1791300000000 && r.scope === 'char:1xbib3t'
        && J(Object.keys(r.parts)) === J(allShardNames())
        && r.parts.meta.processedFloors.length === 1 && r.parts.meta.vars.foo === 1 && r.parts.meta.chatKey === 'chat-1'
        && r.parts.atoms.length === 2 && r.parts.memories.length === 1 && r.parts.items.length === 1
        && r.parts.rumors.length === 0 && r.counts[META_SHARD] >= 3 && r.counts.atoms === 2;
})(), '');

A('A2 合并：`joinParts(splitParts(env))` 与原 data **逐字等价**（无维度被漏、无字段被吞）', (() => {
    const env = mkEnv();
    const r = splitParts(env);
    const back = joinParts(r.parts);
    // 逐维数组顺序与内容一字不差；meta 字段（processedFloors / vars / chatKey …）全部回到顶层
    return back.ok === true && J(back.data.atoms) === J(env.payload.data.atoms)
        && J(back.data.memories) === J(env.payload.data.memories)
        && J(back.data.processedFloors) === J(env.payload.data.processedFloors)
        && back.data.chatKey === 'chat-1' && back.data.vars.foo === 1
        && back.dims.atoms === 2 && back.dims.memories === 1 && back.dims.rumors === 0;
})(), '');

A('A3 清单：逐片记 `hash/bytes/n`，版本号固定；条目数 = 分片数（meta + 维度）', (() => {
    const parts = splitParts(mkEnv()).parts;
    const mf = buildManifest(parts, { at: 1791300000000, scope: 'char:1xbib3t' });
    return mf.v === LOCAL_SHARD_V && mf.at === 1791300000000 && mf.scope === 'char:1xbib3t'
        && Object.keys(mf.parts).length === allShardNames().length
        && mf.parts.atoms.n === 2 && Number(mf.parts.atoms.bytes) > 0 && String(mf.parts.atoms.hash).length > 2;
})(), '');

A('A4 校验：片段与清单一致 → `ok`；**改坏一维只报那一维**（其余仍可用）', (() => {
    const parts = splitParts(mkEnv()).parts;
    const mf = buildManifest(parts);
    const good = verifyParts(parts, mf);
    const broken = JSON.parse(J(parts));
    broken.atoms = [{ id: 'a1', text: '被改过。', title: 't', tags: [] }];      // 只动 atoms
    const bd = verifyParts(broken, mf);
    const missing = JSON.parse(J(parts)); delete missing.items;
    const ms = verifyParts(missing, mf);
    return good.ok === true && good.bad.length === 0
        && bd.ok === false && J(bd.bad) === J(['atoms']) && bd.dims.rumors === 0
        && ms.ok === false && J(ms.bad) === J(['items']);
})(), '');

A('A5 命名（结构化落点）：目录 = `<scope>/<维度>.json` + `manifest.json`；浏览器 = `ftt2_ls_<scope>__<维度>`', (() => {
    return scopeSlug('char:1xbib3t') === 'char_1xbib3t'
        && shardFileName('atoms') === 'atoms.json' && shardFileName() === 'meta.json'
        && manifestFileName() === 'manifest.json'
        && shardKeyName('char:1xbib3t', 'atoms') === 'ftt2_ls_char_1xbib3t__atoms'
        && manifestKeyName('char:1xbib3t') === 'ftt2_ls_char_1xbib3t__manifest'
        && shardDims().length >= 13 && shardDims().indexOf('atoms') === 0;
})(), '');

A('A6 空态 / 坏输入安全：`splitParts(null)` 如实失败；`joinParts({})` 给空对象（不抛）', (() => {
    const a = splitParts(null);
    const b = joinParts({});
    const c = splitParts({ payload: { data: {} } });
    return a.ok === false && a.reason === 'no-data' && b.ok === true && !!b.data
        && c.ok === true && c.counts.atoms === 0 && Object.keys(c.parts).length === allShardNames().length;
})(), '');

R.done();
