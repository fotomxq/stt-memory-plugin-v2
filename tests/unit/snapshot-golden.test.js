// ============================================================
// 单元测试 · B7-1 快照链（与**真实 V1 插件**逐项比对 + 整理/还原/清空/接线）
// 黄金样本：tests/fixtures/v1-golden-snapshot.json（oracle = 真实 V1 插件 v1.206）
//   序列：建根 → 新增 a3（增量1）→ 删除 a2（增量2）→ 统计与还原结果
// 口径：结构指纹（kind/baseId/atoms 键/atomsHashes/deleted）逐项一致；还原到根得到 a1+a2；还原到增量2 不得复活 a2。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setTimerHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { snapshotCreateFull, snapshotCreateIncr, snapshotConsolidate, snapshotRestore, snapshotClear, snapshotStats, SNAP_CAP } from '../../core/snapshots.js';
import { snapshotSectionHtml, snapshotAction, snapshotInspectItems, snapshotInspectState } from '../../ui/snapshots.js';
import { saveStateNow, maintainSnapshots } from '../../adapters/store.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-snapshot.json'), 'utf8'));
const R = makeReporter('snapshot-golden B7-1 快照链（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
const unFetch = installGlobalFetch(() => ({ status: 200, body: {} }));

/** 与 oracle 相同的结构指纹 */
const fp = (snaps) => (snaps || []).map((s) => ({
    kind: s.kind, hasBase: !!s.baseId && s.kind === 'incr', atomIds: Object.keys(s.atoms || {}).sort(),
    hashLen: String(s.hash || '').length > 0, hasHashes: Object.keys(s.atomsHashes || {}).sort(),
    deleted: Object.keys(s.deleted || {}).sort(),
})).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'root' ? -1 : 1));

function boot(extra) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), { atoms: clone(G.atomsInput), snapStore: [] }, extra || {}));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    entryIndexInit();
}

// ---------- 与 V1 oracle 逐项比对 ----------
boot();
const root = snapshotCreateFull();
state.atoms.push(clone(G.added));
entryIndexBuild(true);
const incr1 = snapshotCreateIncr();
state.atoms = state.atoms.filter((x) => x.id !== G.removedId);
entryIndexBuild(true);
const incr2 = snapshotCreateIncr();
const st = snapshotStats();

R.assert('S1 快照结构指纹与真实 V1 插件逐项一致（类型 / 基线 / 原子键 / 哈希表 / 删除账本）', (() => {
    return J(fp(state.snapStore)) === J(G.snapStore) && st.total === 3 && st.root === 1 && st.incr === 2;
})(), (() => { const st2 = snapshotStats(); return { got: fp(state.snapStore), want: G.snapStore, stats: st2 }; })());

R.assert('S2 统计与 V1 一致（total/root/incr/covered/deleted）', (() => {
    return J(st) === J(G.stats) && st.covered === 3 && st.deleted === 1;
})(), st);

R.assert('S3 还原到根快照：得到该时刻的原子集合（新增的 a3 不出现、被删的 a2 回来），与 V1 相同', (() => {
    const r = snapshotRestore(root.id);
    return r.ok === true && J(state.atoms.map((x) => x.id)) === J(G.restoredIds)
        && J(G.restoredIds) === J(['a1', 'a2']);
})(), state.atoms.map((x) => x.id));

R.assert('S4 还原到「最新增量」：按删除账本不复活已删条目（V1 v1.196 口径）', (() => {
    boot();
    const r0 = snapshotCreateFull();
    state.atoms.push(clone(G.added));
    entryIndexBuild(true);
    snapshotCreateIncr();
    state.atoms = state.atoms.filter((x) => x.id !== G.removedId);
    entryIndexBuild(true);
    const i2 = snapshotCreateIncr();
    const r = snapshotRestore(i2.id);
    const ids = state.atoms.map((x) => x.id).sort();
    return r.ok === true && J(ids) === J(['a1', 'a3']) && ids.indexOf(G.removedId) < 0 && !!r0;
})(), state.atoms.map((x) => x.id));

// ---------- 整理（超上限并入根） ----------
R.assert('S5 整理：创建过程**自带整理**（链长不超上限、根唯一）；显式整理在超限时把最早 15 个增量并入根', (() => {
    boot();
    snapshotCreateFull();
    for (let i = 0; i < 40; i++) {
        state.atoms.push({ id: 'x' + i, text: '第 ' + i + ' 条情节正文足够长。' });
        entryIndexBuild(true);
        snapshotCreateIncr();          // V1：创建后即整理 → 链长始终 ≤ 上限
    }
    const st1 = snapshotStats();
    const autoOk = state.snapStore.length <= SNAP_CAP && st1.root === 1 && st1.total <= SNAP_CAP;
    const idem = snapshotConsolidate();                       // 已在限内 → 幂等（不折叠）
    // 强制超限：直接塞入 20 个空增量，再整理 → 应折叠 15 个批次
    for (let i = 0; i < 20; i++) {
        state.snapStore.push({ id: 'dummy' + i, kind: 'incr', ts: new Date(Date.now() + i).toISOString(), baseId: state.snapStore[0].id, hash: 'h', atomsHashes: {}, atoms: {}, deleted: {} });
    }
    const over = state.snapStore.length;
    const c = snapshotConsolidate();
    const st2 = snapshotStats();
    const rootId = state.snapStore.filter((x) => x.kind === 'root')[0].id;
    const r = snapshotRestore(rootId);
    return autoOk && idem.folded === 0 && idem.changed === false
        && over > SNAP_CAP && c.folded >= 15 && c.changed === true && st2.total <= SNAP_CAP   // while 循环按批次折叠直至 ≤ 上限
        && r.ok === true && state.atoms.length > 0;
})(), (() => { try { const st2 = snapshotStats(); return { total: st2.total, root: st2.root }; } catch (e) { return String(e.message); } })());

// ---------- 清空与删除 ----------
R.assert('S6 清空/删除快照：只动快照链与指纹，**不删除记忆条目**；删除单个快照后统计递减', (() => {
    boot();
    snapshotCreateFull();
    state.atoms.push(clone(G.added));
    entryIndexBuild(true);
    snapshotCreateIncr();
    const n0 = snapshotStats().total;
    const atoms0 = state.atoms.length;
    const del = snapshotAction('snapDelete', { id: state.snapStore[0].id });
    const n1 = snapshotStats().total;
    const clear = snapshotAction('snapshotClear', {});
    const st2 = snapshotStats();
    return n0 === 2 && del.ok === true && n1 === 1 && clear.ok === true
        && st2.total === 0 && state.atoms.length === atoms0 && mainOk(state);
})(), (() => { try { return snapshotStats(); } catch (e) { return String(e.message); } })());

function mainOk(s) { try { return Array.isArray(s.atoms) && s.atoms.length >= 2; } catch (e) { return false; } }


// ---------- 快照内容查看（V1 `snapshotInspect`）----------
R.assert('S7 查看快照内容 snapshotInspect：清单口径与 V1 一致（类别 · 摘要 60 字截断）、行内展开/再点收起、快照不存在返回 not-found；**不改动记忆本体**', (() => {
    // 额外放一条记忆 / 物品 / 概念，确保清单跨类别（V1 的类别中文映射被真实覆盖）
    boot({
        memories: [{ id: 'snap-s7-m', title: '记忆一', content: '角色甲记得钥匙。', date: '2020-01-01', importance: 0.5, tags: [], uses: 1, floorStart: 1, floorEnd: 2 }],
        items: [{ id: 'snap-s7-i', name: '铜钥匙', desc: '开门的钥匙。', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }],
        concepts: [{ id: 'snap-s7-c', name: '天机阁', content: '情报机构。', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }],
    });
    snapshotCreateFull();
    const snap = state.snapStore[state.snapStore.length - 1];
    const sid = snap.id;
    const atoms0 = state.atoms.length;
    const items = snapshotInspectItems(sid);
    const wantCat = { atoms: '情节', currentStates: '状态', snapshots: '角色', memories: '记忆', items: '物品', currencies: '货币', plans: '计划', suspense: '悬念', scenes: '场景', concepts: '概念' };
    const catOk = items.every((x) => x.catLabel === (wantCat[x.cat] || x.cat));
    const seen = {}; items.forEach((x) => { seen[x.cat] = true; });
    const multiDim = !!(seen.atoms && seen.memories && seen.items && seen.concepts);
    const briefOk = items.every((x) => x.brief.length <= 60 && x.brief.length > 0);
    const open = snapshotAction('snapshotInspect', { id: sid });
    const htmlOpen = snapshotSectionHtml();
    const opened = snapshotInspectState() === sid && htmlOpen.indexOf('data-ftt-snap-inspect="' + sid + '"') >= 0
        && htmlOpen.indexOf('包含 ' + items.length + ' 条原子') >= 0 && htmlOpen.indexOf('🔍') >= 0;
    const close = snapshotAction('snapshotInspect', { id: sid });
    const closed = snapshotInspectState() === '' && snapshotSectionHtml().indexOf('data-ftt-snap-inspect=') < 0;
    const miss = snapshotAction('snapshotInspect', { id: 'no-such-snap' });
    return Array.isArray(items) && items.length === Object.keys(snap.atoms).length && items.length >= 5
        && catOk && multiDim && briefOk
        && open.ok === true && open.items.length === items.length && opened
        && close.ok === true && close.id === '' && closed
        && miss.ok === false && miss.reason === 'not-found' && snapshotInspectItems('no-such-snap') === null
        && state.atoms.length === atoms0 && mainOk(state);
})(), (() => { try { return { inspect: snapshotInspectState(), snaps: (state.snapStore || []).length }; } catch (e) { return String(e.message); } })());

// ---------- 保存流水线接线 ----------
/** 异步断言助手（防「Promise 恒真」的假绿） */
async function A(name, fn, detail) {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
}

await A('S7 保存流水线：无快照时自动建根；已有快照则调度增量（timerHooks 注入定时器后可观察到链增长）', async () => {
    boot();
    let timers = 0;
    setTimerHooks({ set: (fn) => { timers++; fn(); return 1; }, clear: () => undefined });
    const r1 = await saveStateNow({ reason: 'test' });
    const st1 = snapshotStats();
    state.atoms.push(clone(G.added));
    entryIndexBuild(true);
    const r2 = await saveStateNow({ reason: 'test2' });
    const st2 = snapshotStats();
    setTimerHooks({ set: () => 0, clear: () => undefined });
    return r1.ok === true && st1.total === 1 && st1.root === 1
        && r2.ok === true && st2.total === 2 && st2.incr === 1 && timers === 1
        && maintainSnapshots().scheduled === 'incr';
}, (() => { try { return snapshotStats(); } catch (e) { return String(e.message); } })());

// ---------- 界面接线 ----------
await A('S8 数据管理页：快照区块（统计/列表/还原/删除/建根/整理/清空）与动作转发、提示文案', async () => {
    boot();
    snapshotCreateFull();
    state.atoms.push(clone(G.added));
    entryIndexBuild(true);
    snapshotCreateIncr();
    openPanel('settings');
    setPanelHooks2({});
    const sub = await panelAction('settingsSub', { sub: 'data' });
    const page = panelBodyHtml('settings');
    const cons = await panelAction('snapConsolidate', {});
    const create = await panelAction('snapCreate', {});
    const restore = await panelAction('snapRestore', { snapId: state.snapStore[0].id });
    const clear = await panelAction('snapshotClear', {});
    return sub.ok === true && page.indexOf('🧬 快照链') >= 0 && page.indexOf('data-ftt-action="snapCreate"') >= 0
        && page.indexOf('data-ftt-action="snapRestore"') >= 0 && page.indexOf('data-ftt-action="snapConsolidate"') >= 0
        && page.indexOf('data-ftt-action="snapshotClear"') >= 0
        && cons.ok === true && create.ok === true && restore.ok === true && clear.ok === true
        && String(clear.html).indexOf('（暂无快照') >= 0;
}, (() => { try { return { total: snapshotStats().total }; } catch (e) { return String(e.message); } })());

unFetch();
un();
R.done();
