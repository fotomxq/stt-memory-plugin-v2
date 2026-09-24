// ============================================================
// 单元测试 · 批次 5（core/migrate.js 迁移与去重 + core/entries.js 条目增删与关联写入）与 V1 一致
// 黄金样本：tests/fixtures/v1-golden-migrate-entries.json（**真实 V1 插件**（v1.206）经其测试桩加载后产出，
//   最忠实的 oracle；生成脚本把插件启动日志改道 stderr，stdout 仅 JSON）
// 口径：严格相等（JSON.stringify）；墙钟字段（updatedAt/createdAt/summarizedAt）与版本号（version）比较前归一。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setLastMessageId, setPersistHooks, VERSION } from '../../core/model/runtime.js';
import { migrateState, contentPickBest, contentDedupeArray, recallDateNum } from '../../core/migrate.js';
import { upsertEntry, deleteEntry, upsertRelLinks, sweepOrphanRelLinks } from '../../core/entries.js';
import { ensureAtomHashes, tombEntries } from '../../core/merge.js';
import { defaultCfg } from '../../core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-migrate-entries.json'), 'utf8'));
const R = makeReporter('migrate-entries-golden V1 移植保真度（批次 5）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);
const TS_KEYS = new Set(['updatedAt', 'createdAt', 'summarizedAt', 'lastUpdateDate', 'lastSeenDate', 'at']);
const normalize = (v) => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) {
            if (k === 'version') { o[k] = 'VERSION'; continue; }
            if (TS_KEYS.has(k) && (typeof v[k] === 'number' || v[k] === '')) { o[k] = 'TS'; continue; }
            o[k] = normalize(v[k]);
        }
        return o;
    }
    return v;
};
const JT = (v) => J(normalize(v));
const clone = (v) => JSON.parse(J(v));
const freshState = () => ({
    atoms: [], currentStates: [], snapshots: [], memories: [], items: [], plans: [], suspense: [], scenes: [], concepts: [], parallels: [], npcs: [],
    links: [], currencies: [], plotSegments: [], rumors: [], deleted: {}, deletedH: {}, vars: {}, stats: {},
    state: { date: '1919-11-29', time: '', location: '', present: [] },
});

cfg.clockAnomalyJumpYears = 50;
cfg.currencyTrackedRoles = [];
// 与 V1 oracle 一致：楼层号 3（V1 桩环境的最后楼层）
setLastMessageId(3);
// 与 V1 同流水线：V1 的 saveState() 会刷新原子内容哈希（ensureAtomHashes）；
// V2 由宿主注入持久化钩子，这里按同一口径注入（P2 的宿主保存流程必须照此接线）。
setPersistHooks({
    saveState: () => { ensureAtomHashes(); return true; },
    saveCfg: () => true,
});

// ---------- 结构迁移 ----------
R.assert('M1 migrateState 脏数据归一与 V1 逐字符一致（容器/条目清洗 + 版本迁移链）', (() => {
    const d = clone(I.DIRTY);
    setKernelState(d);
    const out = migrateState(d);
    setKernelState(null);
    return JT(out) === JT(G.migrate.dirty);
})(), 'dirty');
R.assert('M2 migrateState 干净数据幂等（不改动、version 保持当前）', (() => {
    const c = clone(I.CLEAN);
    setKernelState(c);
    const out = migrateState(c);
    setKernelState(null);
    return JT(out) === JT(G.migrate.clean) && out.version === VERSION;
})(), 'clean');
R.assert('M3 迁移关键点抽查（present 去脏 / items 补空数组 / deleted 补对象 / currentStates 只留有效条目）', (() => {
    const d = clone(I.DIRTY);
    setKernelState(d); const out = migrateState(d); setKernelState(null);
    const w = G.migrate.dirty;
    return J(out.state.present) === J(w.state.present) && J(out.items) === J(w.items)
        && J(out.deleted) === J(w.deleted) && out.currentStates.length === w.currentStates.length
        && J(out.vars) === J(w.vars) && J(out.stats) === J(w.stats);
})(), '');

// ---------- 跨端内容去重 ----------
R.assert('D1 contentPickBest 选优结果与 V1 一致（含合并 uses / 楼层区间）', (() => {
    const got = contentPickBest(clone(I.DUP[0]), clone(I.DUP[1]));
    return JT(got ? [got] : got) === JT([G.dedupe.pickFirst]);
})(), contentPickBest(clone(I.DUP[0]), clone(I.DUP[1])));
R.assert('D2 contentDedupeArray 同内容异 id 收敛与 V1 一致（atoms 3 → 2）', (() => {
    const got = contentDedupeArray('atoms', clone(I.DUP));
    return JT(got) === JT(G.dedupe.dedupeAtoms) && got.length === 2;
})(), contentDedupeArray('atoms', clone(I.DUP)).map(x => x.id));
R.assert('D3 contentDedupeArray 记忆维度同样收敛（保留较全一条）', (() => {
    const got = contentDedupeArray('memories', [{ id: 'm1', owner: '甲', content: '同一记忆', date: '1919-11-29' }, { id: 'm2', owner: '甲', content: '同一记忆', date: '1919-11-29', uses: 3 }]);
    return JT(got) === JT(G.dedupe.dedupeMemories);
})(), contentDedupeArray('memories', [{ id: 'm1', owner: '甲', content: '同一记忆' }, { id: 'm2', owner: '甲', content: '同一记忆', uses: 3 }]).map(x => x.id));
R.assert('D4 recallDateNum 数值化与 V1 一致（含公元前负数 / 非法 NaN）',
    J(['1919-11-29', '-0221-01-02', '1919-11', '1919', '', null].map(d => String(recallDateNum(d)))) === J(G.recallDateNum),
    ['1919-11-29', '-0221-01-02', '1919-11', '1919', '', null].map(d => String(recallDateNum(d))));

// ---------- 条目写入 / 删除 ----------
R.assert('E1 upsertEntry 四类新增均成功（与 V1 返回一致）', (() => {
    const st = freshState(); setKernelState(st);
    const r = {
        atomsNew: upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' }),
        memoriesNew: upsertEntry('memories', { owner: '甲', title: '码头记忆', content: '甲记得木箱断口整齐。', date: '1919-11-29' }),
        currenciesNew: upsertEntry('currencies', { name: '银元', amount: 123456789, currency: '银元' }),
        duplicateAgain: upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' }),
    };
    return J(r) === J(G.entries.upsert);
})(), G.entries.upsert);
R.assert('E2 写入后容器条数与 V1 一致（重复写入不新增：同内容哈希合并）', (() => {
    const st = freshState(); setKernelState(st);
    upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' });
    upsertEntry('memories', { owner: '甲', title: '码头记忆', content: '甲记得木箱断口整齐。', date: '1919-11-29' });
    upsertEntry('currencies', { name: '银元', amount: 123456789, currency: '银元' });
    upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' });
    return J({ atoms: st.atoms.length, memories: st.memories.length, currencies: st.currencies.length, links: st.links.length }) === J(G.entries.counts.afterUpsert);
})(), G.entries.counts.afterUpsert);
R.assert('E3 写入产物与 V1 逐字符一致（情节条目全字段）', (() => {
    const st = freshState(); setKernelState(st);
    upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' });
    return JT(st.atoms[0]) === JT(G.entries.stateAfterUpsert.atoms[0]);
})(), '');
R.assert('E4 deleteEntry 删除与 V1 一致（返回 + id 墓碑 + 条数）', (() => {
    const st = freshState(); setKernelState(st);
    upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' });
    upsertEntry('memories', { owner: '甲', title: '码头记忆', content: '甲记得木箱断口整齐。', date: '1919-11-29' });
    const atomId = st.atoms[0].id, memId = st.memories[0].id;
    const d = { atom: deleteEntry('atoms', atomId), memory: deleteEntry('memories', memId) };
    const got = { atoms: st.atoms.length, memories: st.memories.length, deletedIds: Object.keys((st.deleted || {}).atoms || {}).sort() };
    const want = { atoms: G.entries.counts.afterDelete.atoms, memories: G.entries.counts.afterDelete.memories, deletedIds: G.entries.counts.afterDelete.deletedIds };
    return J(d) === J(G.entries.delete) && JT(got) === JT(want);
})(), G.entries.counts.afterDelete);
R.assert('E5 内容哈希墓碑路径与 V1 一致（V1 由 saveState 流水线写入；V2 的宿主 saveState 必须照此接线，属 P2）', (() => {
    const st = freshState(); setKernelState(st);
    upsertEntry('atoms', { title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' });
    const atom = st.atoms[0];
    deleteEntry('atoms', atom.id);
    // V1 的 saveState() 会对已删除条目补写内容哈希墓碑；此处直接验证哈希键与 V1 完全相同
    tombEntries('atoms', [atom]);
    const keys = Object.keys((st.deletedH || {}).atoms || {}).sort();
    const wantKeys = Object.keys((G.entries.deletedHAfterSave || {}).atoms || {}).sort();
    return J(keys) === J(wantKeys);
})(), G.entries.deletedHAfterSave && G.entries.deletedHAfterSave.atoms);

// ---------- 关联层写入与清扫 ----------
R.assert('L1 upsertRelLinks 三行写入与 V1 一致（added/updated/removed + 关联行内容）', (() => {
    const st = freshState(); setKernelState(st);
    const up = upsertRelLinks('memories', 'm1', clone(I.REL_ROWS), { source: 'test' });
    return J(up) === J(G.entries.rels.upsert) && JT(st.links) === JT(G.entries.rels.links);
})(), G.entries.rels.upsert);
R.assert('L2 清扫后重新写入与 V1 一致（added=3 / links=3）', (() => {
    const st = freshState(); setKernelState(st);
    upsertRelLinks('memories', 'm1', clone(I.REL_ROWS), { source: 'test' });
    sweepOrphanRelLinks();
    const up2 = upsertRelLinks('memories', 'm1', clone(I.REL_ROWS), { source: 'test' });
    const got = { links: st.links.length, added: up2.added, updated: up2.updated };
    return J(up2) === J(G.entries.rels.upsertAgain) && J(got) === J(G.entries.counts.afterUpsertAgain);
})(), G.entries.rels.upsertAgain);
R.assert('L3 sweepOrphanRelLinks 孤儿清扫条数与 V1 一致（无目标条目 → 全部清除）', (() => {
    const st = freshState(); setKernelState(st);
    upsertRelLinks('memories', 'm1', clone(I.REL_ROWS), { source: 'test' });
    const swept = sweepOrphanRelLinks();
    return swept === G.entries.sweep && st.links.length === G.entries.counts.afterSweep.links;
})(), sweepOrphanRelLinks());

setKernelState(null);
R.done();
