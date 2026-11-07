// ============================================================
// 单元测试 · v3.52.11：概览「立即修复」增加**传言立即推进**（零 AI）+ 统计/提示同步
//
// 用户要求（原话）：「概览的立即修复功能，增加传言的立即推进流程。注意统计、提示信息同步补充修订。」
//
// 口径：
//   · 与传言页「🧪 立即演化」**同一条**零 AI 机械推进（载体老化 / 发酵 / 平行联动 / 裂变）；
//   · 零 AI → 不受 `cfg.repairAutoAi` 约束；`opts.rumor === false` 可跳过；钩子未接线 → 如实记 `no-hook`；
//   · 统计并入 `repairTotals`（载体停用 + 联动 + 酝酿 + 完成），提示 / 通知 / 报告同源。
// 运行：node tests/unit/repair-rumor-step.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { runRepair, repairTotals, repairTotalsText, setRepairHooks } from '../../core/repair.js';
import { panelAction, setPanelHooks2, panelState } from '../../ui/panel.js';

const R = makeReporter('repair-rumor-step v3.52.11 立即修复 → 传言立即推进');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:rumor');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.date = '2000-01-01';
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const RUMOR_RET = { ok: true, list: 3, aged: 2, links: 1, changes: 3, committed: 1, fissions: 1, ferment: 4 };

A('A1 钩子未接线 → `rumorSkipped = "no-hook"`（如实回报，不伪装成「无变化」）', (async () => {
    boot();
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: null });
    const r = await runRepair({ silent: true, cause: '测试', force: true, planSusp: false, rumor: undefined });
    return r.rumorSkipped === 'no-hook' && total(r).indexOf('传言推进') < 0;
})(), 'n/a');
A('A2 钩子返回统计 → 计入**合计**（载体停用+联动+酝酿+完成）+ 合计文案出现「传言推进 N」', (async () => {
    boot();
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: async () => Object.assign({}, RUMOR_RET) });
    const r = await runRepair({ silent: true, cause: '测试', force: true, planSusp: false });
    const t = repairTotals(r);
    const text = repairTotalsText(r);
    return r.rumorSkipped === '' && t.rumor === 7 && t.rumorAged === 2 && t.rumorChanges === 3
        && t.rumorFissions === 1 && text.indexOf('传言推进 7') >= 0;
})(), () => { boot(); setRepairHooks({ rumorEvolve: async () => Object.assign({}, RUMOR_RET) }); return 'n/a'; });
A('A3 `stage1.notes` 有「传言立即推进：…」明细（与传言页「立即演化」同一口径）', (async () => {
    boot();
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: async () => Object.assign({}, RUMOR_RET) });
    const r = await runRepair({ silent: true, cause: '测试', force: true, planSusp: false });
    const note = (r.stage1.notes || []).filter((n) => String(n).indexOf('传言立即推进：') === 0)[0] || '';
    return note.indexOf('载体停用 2') >= 0 && note.indexOf('平行联动 1') >= 0 && note.indexOf('酝酿变化 3') >= 0
        && note.indexOf('完成变化 1（裂变 1）') >= 0 && note.indexOf('发酵度更新 4') >= 0;
})(), 'n/a');
A('A4 `opts.rumor === false` → 跳过（`disabled`），不调用钩子', (async () => {
    boot();
    let calls = 0;
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: async () => { calls++; return Object.assign({}, RUMOR_RET); } });
    const r = await runRepair({ silent: true, cause: '测试', force: true, planSusp: false, rumor: false });
    return calls === 0 && r.rumorSkipped === 'disabled' && r.rumor === null;
})(), 'n/a');
A('A5 面板提示：合计在前 + 「传言立即推进」段（统计同步）', (async () => {
    boot();
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: async () => Object.assign({}, RUMOR_RET) });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('repair', {});
    const note = String(panelState().note || '');
    return r && r.ok === true && note.indexOf('自动修复：合计修复 ') === 0
        && note.indexOf('传言立即推进：载体停用 2 · 联动 1 · 酝酿 3 · 完成 1（裂变 1）') >= 0;
})(), () => String(panelState().note || '').slice(0, 220));
A('A6 完成通知含合计（含「传言推进 7」）', (async () => {
    boot();
    const toasts = [];
    const host = makeHost({ chat: [{ is_user: false, mes: 'x' }] });
    installGlobalHost(Object.assign({}, host, { toast: (msg) => toasts.push(String(msg)) }), makeDocument(['ftt-panel']));
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null, rumorEvolve: async () => Object.assign({}, RUMOR_RET) });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('repair', {});
    const msg = toasts.join('\n');
    return r && r.ok === true && msg.indexOf('合计修复 ') >= 0 && msg.indexOf('传言推进 7') >= 0;
})(), 'n/a');

function total(r) { try { return repairTotalsText(r); } catch (e) { return ''; } }
R.done();
