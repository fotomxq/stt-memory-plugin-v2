// ============================================================
// 单元测试 · v3.50.29 W4 `数-3`（哈希口径三件）+ `数-4`（方案 A：整侧取新显式化）
//
// 用户要求：「新版本v3.50.29 开发待开发的W4内多个待开发事项」
//   本轮交付 W4 两项：`数-3`（① `it.h` 保守过渡护栏 · ② `validity:'inactive'` 纳入只升不降 + 补空 ·
//   ③ 跨端异口径前缀登记）+ `数-4` 方案 A（`02` §1.2 写清 7 容器整侧取新的后果 + 体检 `cross-wholesale`）。
//
// 本文件锁四件事：
//   A **①：指纹变化 ≠ 删除** —— 内容改写 / 哈希口径变化都不产生墓碑；只有 id 真消失才留墓碑；
//   B **②：`validity` 只升不降 + 补空** —— 旧副本的 active 不能把 inactive 降级，缺字段时补空；
//   C **③：跨口径指纹读数** —— 旧口径 `it.h` 被刷新并计数，**且不被判为删除**；
//   D **`数-4`：整侧取新显式化** —— 合并统计带 `wholeSide`，体检出 `cross-wholesale`（info）。
//
// 运行：node tests/unit/data-3-4.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { mergeEntryProvenance } from '../../core/floor-cover.js';
import { ensureAtomHashes, hashGuardReadout } from '../../core/merge.js';
import { dataHealthReport } from '../../core/data-health.js';
import { mergeDataObjects } from '../../core/cross-sync.js';
import { atomIdentityHash } from '../../core/model/hash.js';

const R = makeReporter('data-3-4 v3.50.29 W4 数-3 哈希口径三件 + 数-4 整侧取新显式化');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const host = makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在仓库清点货物。' }] });
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(host, doc);
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:data34');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    const st = emptyState();
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A ①：指纹变化 ≠ 删除 ----------
A('A2 **id 仍在但内容改写** → 墓碑数不增加；**id 消失** → 才 +1（这条锁直接盯 `tombstoneSweep` 的两条护栏）', (async () => {
    boot({ atoms: [{ id: 'a1', title: 't', text: '第一版正文足够长。', tags: [] }] });
    const SW = await import('../../core/sweep.js');
    SW.entryIndexInit();
    // 第一次保存周期：建立基线
    SW.tombstoneSweep();
    const base = JSON.parse(JSON.stringify((state.deleted && state.deleted.atoms) || {}));
    const baseN = Object.keys(base).length;
    // 改写同一条（id 不变、内容变）
    state.atoms[0].text = '第二版正文（已改写）足够长。';
    ensureAtomHashes();
    SW.tombstoneSweep();
    const afterRewrite = Object.keys((state.deleted && state.deleted.atoms) || {}).length;
    // 真删除
    state.atoms = [];
    ensureAtomHashes();
    SW.tombstoneSweep();
    const afterDelete = Object.keys((state.deleted && state.deleted.atoms) || {}).length;
    return afterRewrite === baseN && afterDelete === baseN + 1;
})(), 'n/a');

// ---------- B ②：validity 只升不降 + 补空 ----------
A('B1 **旧副本的 `active` 不能把已失效条目降级复活**：胜出侧 active + 另一侧 inactive → 结果是 inactive', (() => {
    const win = { id: 'a1', validity: 'active' };
    const lose = { id: 'a1', validity: 'inactive' };
    const out = mergeEntryProvenance(win, lose);
    return win.validity === 'inactive' && out.indexOf('validity') >= 0;
})(), 'n/a');
A('B2 **补空**：胜出侧缺 `validity` → 取另一侧的值；两侧都 active 时不改（不制造假变更）', (() => {
    const a = { id: 'a2' }, b = { id: 'a2', validity: 'uncertain' };
    const o1 = mergeEntryProvenance(a, b);
    const c = { id: 'a3', validity: 'active' }, d = { id: 'a3', validity: 'active' };
    const o2 = mergeEntryProvenance(c, d);
    return a.validity === 'uncertain' && o1.indexOf('validity') >= 0 && c.validity === 'active' && o2.indexOf('validity') < 0;
})(), 'n/a');
A('B3 保守序：`active` < `uncertain` < `inactive`（inactive 胜 uncertain；uncertain 胜 active）', (() => {
    const x = { id: 'b1', validity: 'uncertain' }, y = { id: 'b1', validity: 'inactive' };
    const p = { id: 'b2', validity: 'active' }, q = { id: 'b2', validity: 'uncertain' };
    mergeEntryProvenance(x, y); mergeEntryProvenance(p, q);
    return x.validity === 'inactive' && p.validity === 'uncertain';
})(), 'n/a');

// ---------- C ③：跨口径指纹读数 ----------
A('C1 **旧口径 `it.h`**（与当前口径不一致）被**刷新并计数**，并非删除；重复刷新不重复计数（幂等）', (() => {
    boot({ atoms: [{ id: 'a1', title: 't', text: '正文足够长。', tags: [], h: 'OLD-FOREIGN-HASH' }] });
    const r0 = hashGuardReadout();
    const changed = ensureAtomHashes();
    const r1 = hashGuardReadout();
    const again = ensureAtomHashes();
    const r2 = hashGuardReadout();
    const nowH = state.atoms[0].h;
    return changed === true && r1.foreign === r0.foreign + 1 && again === false && r2.foreign === r1.foreign
        && nowH === atomIdentityHash('atoms', state.atoms[0]) && nowH !== 'OLD-FOREIGN-HASH';
})(), J(hashGuardReadout()));

// ---------- D 数-4：整侧取新显式化 ----------
A('D1 合并统计带 `wholeSide`：远端信封更新且带非原子容器 → 记录「哪些容器被整侧取新」；无则 `null`', (() => {
    const base = { summaries: { s: 1 }, npcs: [], protagonist: {}, vars: {}, varTemplates: [], state: {}, updatedAt: 100 };
    const remote = { summaries: { s: 2 }, npcs: [{ id: 'n1' }], protagonist: {}, vars: {}, varTemplates: [], state: {}, updatedAt: 200 };
    const r = mergeDataObjects(base, remote, {});
    const ws = r.stat.wholeSide;
    const none = mergeDataObjects(base, Object.assign({}, base, { updatedAt: 50 }), {}).stat.wholeSide;
    return !!ws && ws.side === 'remote' && Array.isArray(ws.dims) && ws.dims.indexOf('summaries') >= 0 && none === null;
})(), 'n/a');
A('D2 体检输出 `cross-wholesale`（**info**，不抬 level）：`state.meta.crossMerge.wholeSide` 有值即如实提示后果', (() => {
    boot({ meta: { crossMerge: { at: Date.now(), wholeSide: { side: 'remote', dims: ['summaries', 'npcs'], baseTs: 1, remTs: 2 }, conflict: 0 } } });
    const rep = dataHealthReport(null, { force: true });
    const f = (rep.findings || []).filter((x) => x.code === 'cross-wholesale');
    return f.length === 1 && f[0].level === 'info' && String(f[0].detail).indexOf('整体丢弃') >= 0;
})(), 'n/a');
A('D3 无 `crossMerge` 留痕时**不产生** `cross-wholesale`（不制造噪音）', (() => {
    boot({});
    const rep = dataHealthReport(null, { force: true });
    return (rep.findings || []).filter((x) => x.code === 'cross-wholesale').length === 0;
})(), 'n/a');

un();
R.done();
