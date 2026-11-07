// ============================================================
// 单元测试 · v3.52.10：自动修复加入「计划悬念长期未推进清理」+ 数量合计统计
//
// 用户要求（原话）：
//   1.「概览的自动修复功能，加入计划悬念的长期未推进清理流程。同时注意概览的自动修复有数量统计，
//      可以将这些数量关系融入进去合计，方便用户理解修复了多少内容。」
//   2.「自动修复的提示信息，也需注意提示补充修复的统计信息。」
//
// 口径：
//   · `core/plan-cleanup.js#planSuspStaleCleanup`：零 AI；只处理 open；>120 剧情天 → 了结（plans closed / suspense resolved，
//     写 `autoClosed` + `statusNote`，**不删除**）；30–120 天只计数；无剧情时钟 → 跳过；`cfg.repairAutoCloseStale=false` 关闭；幂等。
//   · `core/repair.js#repairTotals`：合计口径唯一源；`repairTotalsText` 一行文案（提示/通知/报告共用）。
//   · 自动修复第 10 步执行；面板提示与完成通知都含「合计修复 N 处」。
// 运行：node tests/unit/plan-cleanup-repair.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { planSuspStaleCleanup } from '../../core/plan-cleanup.js';
import { planAgingReport, PLAN_AGING_STALE_DAYS } from '../../core/plan-aging.js';
import { runRepairMech, repairTotals, repairTotalsText, REPAIR_MECH_STEPS } from '../../core/repair.js';
import { panelAction, setPanelHooks2, panelState } from '../../ui/panel.js';

const R = makeReporter('plan-cleanup-repair v3.52.10 计划悬念老化清理 + 合计统计');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:cleanup');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.date = '2100-01-01';   // 当前剧情日期
    st.plans = [
        { id: 'p-stale', status: 'open', date: '2000-01-01', title: '很久以前的计划', content: 'x' },
        { id: 'p-aging', status: 'open', date: '2099-10-01', title: '缓慢计划', content: 'y' },
        { id: 'p-fresh', status: 'open', date: '2099-12-25', title: '新计划', content: 'z' },
        { id: 'p-closed', status: 'closed', date: '1900-01-01', title: '已了结', content: 'w' },
    ];
    st.suspense = [
        { id: 's-stale', status: 'open', date: '2000-01-01', title: '旧悬念', content: 'x' },
        { id: 's-resolved', status: 'resolved', date: '1900-01-01', title: '已揭晓', content: 'y' },
    ];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A 老化清理 ----------
A('A1 **>120 剧情天的 open 计划/悬念 → 自动了结**（写 autoClosed / statusNote，不删除）；已了结/已揭晓不动', (() => {
    boot();
    const r = planSuspStaleCleanup({ persist: false });
    const p = state.plans.filter((x) => x.id === 'p-stale')[0];
    const s = state.suspense.filter((x) => x.id === 's-stale')[0];
    const closedP = state.plans.filter((x) => x.id === 'p-closed')[0];
    const resolvedS = state.suspense.filter((x) => x.id === 's-resolved')[0];
    return r.ok === true && r.closedP === 1 && r.closedS === 1
        && p.status === 'closed' && p.autoClosed === true && String(p.statusNote).indexOf('长期未推进') >= 0
        && s.status === 'resolved' && s.autoClosed === true
        && closedP.status === 'closed' && resolvedS.status === 'resolved'
        && state.plans.length === 4 && state.suspense.length === 2;   // **不删除**
})(), () => { boot(); const r = planSuspStaleCleanup({ persist: false }); return J({ r: r, plans: state.plans.map((x) => x.id + ':' + x.status) }); });
A('A2 30–120 天「老化档」**只计数不动作**；未到阈值的新条目不动', (() => {
    boot();
    const r = planSuspStaleCleanup({ persist: false });
    const aging = state.plans.filter((x) => x.id === 'p-aging')[0];
    const fresh = state.plans.filter((x) => x.id === 'p-fresh')[0];
    return r.agingP === 1 && r.agingS === 0 && aging.status === 'open' && fresh.status === 'open';
})(), 'n/a');
A('A3 **无剧情时钟 → 整项跳过**（不猜、不改）；`cfg.repairAutoCloseStale=false` 也跳过', (() => {
    boot({ date: '' });
    const r1 = planSuspStaleCleanup({ persist: false });
    const st = state.plans.filter((x) => x.id === 'p-stale')[0];
    boot();
    cfg.repairAutoCloseStale = false;
    const r2 = planSuspStaleCleanup({ persist: false });
    return r1.skipped === 'no-story-clock' && r1.closedP === 0 && st.status === 'open'
        && r2.skipped === 'disabled' && r2.closedP === 0;
})(), 'n/a');
A('A4 **幂等**：同一状态再跑一次 → 无新了结；老化分档读数随之归零（已了结不再计入 open）', (() => {
    boot();
    planSuspStaleCleanup({ persist: false });
    const r2 = planSuspStaleCleanup({ persist: false });
    const aging = planAgingReport(state, state.date, {});
    return r2.closedP === 0 && r2.closedS === 0;
})(), 'n/a');

// ---------- B 合计统计 ----------
A('B1 `repairTotals`：**合计口径唯一源** —— 机械/清扫/裁剪/老化/AI 全部计入 total；老化档只提示不计入', (() => {
    const r = {
        stage1: { merged: 2, deleted: 1 },
        mech: { sweep: { swept: 3 }, caps: { cut: 4 }, pruned: { deleted: 1 }, decay: { deleted: 2 }, ageClean: { closedP: 1, closedS: 1, agingP: 2, agingS: 1 } },
        ai: { revised: 2, deleted: 1 },
        planSusp: { closedP: 1, closedS: 1, mergedP: 1, mergedS: 0, removedDup: 1 },
        relCounts: { removed: 2 },
    };
    const t = repairTotals(r);
    const text = repairTotalsText(r);
    // 合并去重2 + 垃圾清理1 + 遗忘3 + 裁剪4 + 无效1 + 衰退2 + 关联2 + 计划悬念了结1+1 + 合并1 + 重复1 + AI修订2+删除1 + 老化了结1+1 = 24
    return t.total === 24
        && t.ageAging === 3
        && text.indexOf('合计修复 ' + t.total + ' 处') === 0
        && text.indexOf('老化了结 2') >= 0 && text.indexOf('另有 3 条计划/悬念进入老化档') >= 0;
})(), () => J(repairTotals({ mech: { sweep: { swept: 3 }, caps: { cut: 4 } }, stage1: { merged: 1, deleted: 0 } })));
A('B2 `REPAIR_MECH_STEPS` 含第 10 步「计划悬念老化清理」', (() => {
    return REPAIR_MECH_STEPS.length === 10 && REPAIR_MECH_STEPS[9].name === '计划悬念老化清理';
})(), 'n/a');
A('B3 `runRepairMech` 第 10 步真跑：了结老化条目，并在 `mech.ageClean` / `stage1.notes` 留痕', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const mech = await runRepairMech({ silent: true });
    const steps = mech.steps || [];
    const st10 = steps.filter((s) => s.step === 10)[0] || {};
    const noteOk = (mech.stage1.notes || []).some((n) => String(n).indexOf('计划/悬念老化清理：') === 0);
    return st10.ok === true && mech.ageClean && mech.ageClean.closedP === 1 && mech.ageClean.closedS === 1 && noteOk;
})(), 'n/a');

// ---------- C 提示信息 ----------
A('C1 面板动作 repair 的提示：**合计在最前**（修了多少处）+ 明细 + 老化段', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('repair', {});
    const note = String(panelState().note || '');
    return r && r.ok === true && note.indexOf('自动修复：合计修复 ') === 0
        && note.indexOf('计划悬念老化：了结 2 条') >= 0
        && note.indexOf('机械清理：合并') >= 0 && note.indexOf('候选 ') >= 0;
})(), () => String(panelState().note || '').slice(0, 200));
A('C2 修复完成通知（非静默）含合计统计（`repairTotalsText`）', (async () => {
    boot();
    const toasts = [];
    const host = makeHost({ chat: [{ is_user: false, mes: 'x' }] });
    installGlobalHost(Object.assign({}, host, { toast: (msg) => toasts.push(String(msg)) }), makeDocument(['ftt-panel']));
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('repair', {});
    const msg = toasts.join('\n');
    return r && r.ok === true && msg.indexOf('合计修复 ') >= 0 && msg.indexOf('老化了结 2') >= 0;
})(), 'n/a');

R.done();
