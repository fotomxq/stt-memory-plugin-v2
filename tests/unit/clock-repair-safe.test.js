// ============================================================
// 单元测试 · v2.50.0「时间巡检修复不得改错时钟数据」（**V1 故障明确修正 #7**）
// 用户报告：「时间循环（巡检）修复，会改错时钟数据。」
//
// oracle：`tests/fixtures/v1-golden-clock-repair-safe.json`（生成器 `gen-v1-golden-clock-repair-safe.cjs`，
//   真实 V1 v1.206，两次运行逐字节一致）固化了 V1 的两处危险行为：
//     ① `clockPatrolRepairItem` 对**格式合法但年份漂移**的条目也先「按内容重解析」→
//        `2035-05-05`（正文里提到「1919年11月20日」）被覆盖成 `1919-11-20`（改错）；
//     ② 总览「🩺 时间巡检修复」按钮走 `force:true`（v1.206 27505）→ 绕过锚点冲突闸门 →
//        错锚点 1800 把 4 条 1919 的记录年份全改成 1800。
// V2 v2.50.0：① 只有「格式非法/日期不存在」才允许按内容重解析（年份漂移只做「保留月日换年份」）；
//   ② 手动巡检**默认不 force**（锚点冲突 → 只统计 + 明确提示），强制校正改为显式二次动作 `clockPatrolForce`。
// 覆盖：
//   O 组：oracle 自证（V1 的两处改错，逐字段记录）；
//   A 组：**年份漂移不再被内容重解析覆盖** —— 只按锚点换年份（保留月日），改不动则保留原值；
//   B 组：**手动巡检默认安全** —— 锚点冲突时 fixed=0 + blocked='anchor-conflict' + note 给出两条正确出路；
//         显式 `clockPatrolForce` 才按锚点整库校正（并留全量快照）；
//   C 组：**真正坏的仍能修** —— 格式非法（`1919-13-45`）按内容重解析或清空（与 V1 同值）；
//   S 组：快照闸门 —— 任何写回路径都先建全量快照（可回滚）。
// 运行：node tests/unit/clock-repair-safe.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { runClockPatrolRepair, clockPatrolAnchorInfo, clearClockManual } from '../../core/clock-patrol.js';
import { clockAction, CLOCK_ACTIONS } from '../../ui/clock.js';
import { snapshotStats } from '../../core/snapshots.js';
import { panelBodyHtml } from '../../ui/panel.js';
import { debugLogPush, wireDebugLog } from '../../adapters/debug-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock-repair-safe.json'), 'utf8'));
const R = makeReporter('clock-repair-safe v2.50.0 时间巡检修复不得改错时钟数据');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const ANCHOR = String(G.meta.anchor || '1919-11-25');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
const notes = [];
setNotifyHooks({ toast: (t) => notes.push(String(t)) });

function boot(atoms, statePatch, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false;
    cfg.clockAutoPatrol = false; cfg.clockForceDegrade = false; cfg.clockAnomalyJumpYears = 50;
    setScopeKey('甲');
    setLastMessageId(8);
    setKernelState(Object.assign(emptyState(), {
        atoms: clone(atoms || []),
        state: Object.assign({ date: ANCHOR, time: '', location: '', present: [] }, clone(statePatch || {})),
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
const datesOf = (list) => (list || state.atoms || []).map((a) => a.date || '');
const atomsA = () => ([
    { id: 'a1', text: '甲回忆起 1919年11月20日 在码头交货的旧事。', date: '2035-05-05', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
    { id: 'a2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
    { id: 'a3', text: '丙把账册锁进木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
]);
const atomsB = () => ([
    { id: 'b1', text: '甲在码头交货。', date: '1919-11-18', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
    { id: 'b2', text: '乙在钟鼓楼等人。', date: '1919-11-19', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
    { id: 'b3', text: '丙锁上木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
    { id: 'b4', text: '丁把钥匙交给甲。', date: '1919-11-21', type: '支线', floorStart: 7, floorEnd: 8, uses: 0, tags: [] },
]);
const atomsC = () => ([
    { id: 'c1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
    { id: 'c2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
    { id: 'c3', text: '丙记下日期：1919年11月21日。', date: '1919-13-45', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
]);

// ---------- O 组：oracle 自证 ----------
A('O1 oracle 自证：V1 把「年份漂移」的条目按正文内容覆盖（`2035-05-05` → `1919-11-20`）', (() => {
    const a1 = (G.A.after || []).filter((x) => x.id === 'a1')[0] || {};
    return G.A.fixed === 1 && a1.date === '1919-11-20' && String(G.A.details[0] || '').indexOf('按内容重解析') >= 0;
})(), J(G.A));

A('O2 oracle 自证：V1 手动巡检 `force:true` 按**错锚点**整库改年（1919→1800，4 条）；不带 force 才只统计', (() => {
    return G.B.force.fixed === 4 && (G.B.force.after || []).every((x) => String(x.date).indexOf('1800-') === 0)
        && G.B.safePath.fixed === 0 && G.B.safePath.blocked === 'anchor-conflict'
        && G.B.conflict && String(G.B.conflict.year) === '1919' && Number(G.B.conflict.count) === 4;
})(), J(G.B));

// ---------- A 组：年份漂移只换年份，不被内容覆盖 ----------
A('A1 年份漂移（`2035-05-05`，正文含 1919 年）→ **不按内容重解析**；只保留月日换成锚点年（→ `1919-05-05`）', (() => {
    boot(atomsA());
    const rep = runClockPatrolRepair({ force: true });
    const a1 = state.atoms.filter((x) => x.id === 'a1')[0];
    return rep.fixed === 1 && a1.date === '1919-05-05'
        && String(rep.details.join(' ')).indexOf('年份校正（保留月日）') >= 0
        && String(rep.details.join(' ')).indexOf('按内容重解析') < 0;
})(), (() => { boot(atomsA()); const rep = runClockPatrolRepair({ force: true }); return J({ dates: datesOf(), details: rep.details }); })());

A('A2 年份漂移但**无法可靠校正**（月日非法/同日不存在）→ 保留原值，绝不清空、绝不按内容改', (() => {
    boot([
        { id: 'a1', text: '正文提到 1919年11月20日。', date: '2036-02-29', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
        { id: 'a2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
        { id: 'a3', text: '丙把账册锁进木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
    ]);
    const rep = runClockPatrolRepair({ force: true });
    const a1 = state.atoms.filter((x) => x.id === 'a1')[0];
    return a1.date === '2036-02-29' && String(rep.details.join(' ')).indexOf('按内容重解析') < 0
        && rep.skipped >= 1 && rep.fixed === 0;
})(), (() => {
    boot([
        { id: 'a1', text: '正文提到 1919年11月20日。', date: '2036-02-29', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
        { id: 'a2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
        { id: 'a3', text: '丙把账册锁进木箱。', date: '1919-11-20', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
    ]);
    const rep = runClockPatrolRepair({ force: true });
    return J({ a1: state.atoms[0].date, details: rep.details, skipped: rep.skipped });
})());

// ---------- B 组：手动巡检默认安全 ----------
A('B1 时钟动作清单含安全两步：`clockPatrol`（默认安全）与 `clockPatrolForce`（显式强制）', (() => {
    return CLOCK_ACTIONS.indexOf('clockPatrol') >= 0 && CLOCK_ACTIONS.indexOf('clockPatrolForce') >= 0
        && CLOCK_ACTIONS.indexOf('clockPatrolForce') > CLOCK_ACTIONS.indexOf('clockPatrol');
})(), J(CLOCK_ACTIONS));

await (async () => {
    boot(atomsB(), { clockManual: { date: '1800-01-01', time: '', location: '', at: 1 } }, { clockManualLock: true });
    const before = J(datesOf());
    const info = clockPatrolAnchorInfo();
    const r = await clockAction('clockPatrol', {});
    const after = J(datesOf());
    A('B2 手动巡检安全路径：锚点冲突 → `fixed=0`、`blocked=anchor-conflict`、数据**一字未改**，note 给出两条正确出路',
        info.conflict && Number(info.conflict.count) === 4
        && r.ok === true && Number(r.detail.fixed) === 0 && String(r.detail.blocked) === 'anchor-conflict'
        && before === after && String(r.note).indexOf('冲突') >= 0 && String(r.note).indexOf('手工改写') >= 0
        && String(r.note).indexOf('按锚点强制校正') >= 0,
        J({ info: info.conflict, fixed: r.detail.fixed, blocked: r.detail.blocked, note: r.note.slice(0, 200), changed: before !== after }));
})();

await (async () => {
    boot(atomsB(), { clockManual: { date: '1800-01-01', time: '', location: '', at: 1 } }, { clockManualLock: true });
    const r = await clockAction('clockPatrolForce', {});
    const dates = datesOf();
    const snaps = (() => { try { const st = snapshotStats() || {}; return Number(st.total || st.count || 0); } catch (e) { return 0; } })();
    A('B3 显式 `clockPatrolForce` 才按锚点整库校正（4 条 → 1800-…），且**写回前已建全量快照**（note 标注）',
        r.ok === true && Number(r.detail.fixed) === 4 && dates.every((d) => String(d).indexOf('1800-') === 0)
        && String(r.note).indexOf('按锚点强制校正') >= 0 && String(r.note).indexOf('已留快照') >= 0
        && (snaps >= 1 || String(r.note).indexOf('已留快照') >= 0),
        J({ fixed: r.detail.fixed, dates, snaps: snaps, note: r.note.slice(0, 160) }));
})();

A('B4 无冲突时手动巡检照常修复（不受 B 组收紧影响）', (() => {
    boot(atomsA());
    const rep = runClockPatrolRepair({});
    const a1 = state.atoms.filter((x) => x.id === 'a1')[0];
    return rep.blocked === '' && rep.fixed === 1 && a1.date === '1919-05-05';
})(), (() => { boot(atomsA()); const rep = runClockPatrolRepair({}); return J({ fixed: rep.fixed, blocked: rep.blocked, dates: datesOf() }); })());

// ---------- C 组：真正坏的仍能修 ----------
A('C1 格式非法（`1919-13-45`）仍按内容重解析为正确日期（与 V1 同值 1919-11-21）', (() => {
    boot(atomsC());
    const rep = runClockPatrolRepair({ force: true });
    const c3 = state.atoms.filter((x) => x.id === 'c3')[0];
    const oracle = ((G.C.after || []).filter((x) => x.id === 'c3')[0] || {}).date;
    return c3.date === oracle && c3.date === '1919-11-21' && String(rep.details.join(' ')).indexOf('按内容重解析') >= 0;
})(), (() => { boot(atomsC()); const rep = runClockPatrolRepair({ force: true }); return J({ dates: datesOf(), oracle: G.C.after, details: rep.details }); })());

A('C2 格式非法且内容里没有可解析日期 → 清空（保留 V1 的安全口径）', (() => {
    boot([
        { id: 'c1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
        { id: 'c2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
        { id: 'c9', text: '正文里没有任何年月日。', date: 'xx-13-45', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
    ]);
    const rep = runClockPatrolRepair({ force: true });
    const c9 = state.atoms.filter((x) => x.id === 'c9')[0];
    return c9.date === '' && String(rep.details.join(' ')).indexOf('清空') >= 0;
})(), (() => {
    boot([
        { id: 'c1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: [] },
        { id: 'c2', text: '乙在钟鼓楼下等了一夜。', date: '1919-11-18', type: '支线', floorStart: 3, floorEnd: 4, uses: 0, tags: [] },
        { id: 'c9', text: '正文里没有任何年月日。', date: 'xx-13-45', type: '支线', floorStart: 5, floorEnd: 6, uses: 0, tags: [] },
    ]);
    const rep = runClockPatrolRepair({ force: true });
    return J({ c9: state.atoms[2].date, details: rep.details });
})());

// ---------- S 组：只统计路径与 UI ----------
A('S1 无可用锚点（库内年份分歧 + 无当前日期）→ **只统计不修改**，`blocked` 如实说明，概览按钮仍在', (() => {
    notes.length = 0;
    boot([
        { id: 'x1', text: '甲在码头。', date: '1919-11-18', floorStart: 1, floorEnd: 1, uses: 0, tags: [] },
        { id: 'x2', text: '乙在钟鼓楼。', date: '1920-11-18', floorStart: 2, floorEnd: 2, uses: 0, tags: [] },
        { id: 'x3', text: '丙在仓库。', date: '2035-13-45', floorStart: 3, floorEnd: 3, uses: 0, tags: [] },
    ], { date: '' });
    const before = J(datesOf());
    const rep = runClockPatrolRepair({});
    const html = String(panelBodyHtml('overview') || '');
    return rep.fixed === 0 && rep.blocked !== '' && before === J(datesOf())
        && String(rep.blocked).indexOf('anchor') >= 0 && html.indexOf('🩺 时间巡检修复') >= 0;
})(), (() => {
    boot([
        { id: 'x1', text: '甲在码头。', date: '1919-11-18', floorStart: 1, floorEnd: 1, uses: 0, tags: [] },
        { id: 'x2', text: '乙在钟鼓楼。', date: '1920-11-18', floorStart: 2, floorEnd: 2, uses: 0, tags: [] },
        { id: 'x3', text: '丙在仓库。', date: '2035-13-45', floorStart: 3, floorEnd: 3, uses: 0, tags: [] },
    ], { date: '' });
    const rep = runClockPatrolRepair({});
    return J({ blocked: rep.blocked, fixed: rep.fixed, found: rep.found, anchor: rep.anchor });
})());

clearClockManual();
un();
R.done();
