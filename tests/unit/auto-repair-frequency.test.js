// ============================================================
// 单元测试 · v3.52.20：自动修复**频率闸门**（分析 10 次及以上才触发 1 次）
//
// 用户要求（原话）：「避免高频触发自动修复，尤其是非手动形式的触发，必须在分析10次及以上才会触发1次。」
//
// 口径：
//   · `cfg.autoRepairEveryOps` 默认 **10**（0 = 不限）；
//   · **每一次分析**（单楼 / 分段，含 AI 失败 / 无 JSON / 合并失败）都计入闸门；
//   · **所有静默触发**（`silent:true`，不论有没有 cause）都必须过闸门；手动（不带 silent）不受限；
//   · 自动路径**放行即消耗配额**（本次无论是否产生变更都算触发过 1 次），避免「跑空 → 下次分析又触发」。
// 运行：node tests/unit/auto-repair-frequency.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { autoRepairOpDue, bumpRepairOp, markAutoRepairDone, runRepair, scheduleAutoRepairOnMergeFail, cancelRepairTimers } from '../../core/repair.js';
import { analyzeFloors } from '../../host/extract.js';
import { setAiHooks } from '../../core/ai-hooks.js';

const R = makeReporter('auto-repair-frequency v3.52.20：分析 10 次才允许 1 次自动修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const CHAT = Array.from({ length: 30 }, (_, i) => ({ is_user: false, mes: '第 ' + i + ' 楼正文：甲在码头清点货物并记录数量与地点。' }));
installGlobalHost(makeHost({ chat: CHAT }), makeDocument(['ftt-panel']));
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.repairMaxItems = 0;               // 不调用 AI（本测试只验证闸门）
    cfg.repairAggEnabled = false;
    setScopeKey('char:arf');
    setLastMessageId(CHAT.length - 1);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => 0 });
    setNotifyHooks({ toast: () => undefined });
    setKernelState(emptyState());
    setLoadPhase('ready');
    return state;
}
const badAi = async () => ({ ok: false, error: 'boom' });

A('A1 默认值：`autoRepairEveryOps = 10`（0 = 不限；旧默认 8 → 10）', (() => {
    return Number(defaultCfg.autoRepairEveryOps) === 10;
})(), 'n/a');
A('A2 **每一次分析都计数**（含 AI 失败）：连续失败 3 次 → `state.autoRepair.ops = 3`', (async () => {
    boot();
    for (let i = 0; i < 3; i++) await analyzeFloors({ ids: [i], ai: badAi });
    return Number(state.autoRepair.ops) === 3;
})(), () => J(state.autoRepair));
A('A3 闸门口径：9 次分析 → 自动修复**不放行**；第 10 次 → 放行；放行即消耗配额（第 11 次又不放行）', (async () => {
    boot();
    cfg.autoRepairEveryOps = 10;
    for (let i = 0; i < 9; i++) bumpRepairOp();
    const due9 = autoRepairOpDue();                 // 9 - 0 = 9 < 10 → false
    bumpRepairOp();                                 // 第 10 次
    const due10 = autoRepairOpDue();                // 10 → true
    markAutoRepairDone();                           // 修复后 lastAt = 10
    bumpRepairOp();                                 // 第 11 次
    const due11 = autoRepairOpDue();                // 1 < 10 → false
    return due9 === false && due10 === true && due11 === false;
})(), () => J(state.autoRepair));
A('A4 **静默但无 cause** 也过闸门（自动路径全覆盖）：闸门未到点时 `runRepair({silent:true})` → `auto-repair-frequency`', (async () => {
    boot();
    cfg.autoRepairEveryOps = 10;
    for (let i = 0; i < 5; i++) bumpRepairOp();
    const r = await runRepair({ silent: true });
    return r && r.blocked === true && r.reason === 'auto-repair-frequency';
})(), 'n/a');
A('A5 到点后自动修复**放行并消耗配额**（本次即使无变更，也视为触发过 1 次）；随后立即再触发 → 又被拦', (async () => {
    boot();
    cfg.autoRepairEveryOps = 10;
    for (let i = 0; i < 10; i++) bumpRepairOp();
    const r1 = await runRepair({ silent: true });
    const r2 = await runRepair({ silent: true });
    return r1 && r1.blocked !== true && Number(state.autoRepair.lastAt) === 10
        && r2 && r2.blocked === true && r2.reason === 'auto-repair-frequency';
})(), () => J({ ops: state.autoRepair && state.autoRepair.ops, lastAt: state.autoRepair && state.autoRepair.lastAt }));
A('A6 **手动修复不受频率闸门限制**（不带 silent → 不进 isAuto 分支）', (async () => {
    boot();
    cfg.autoRepairEveryOps = 10;
    const r = await runRepair({ cause: '手动' });
    return r && r.blocked !== true && (r.reason !== 'auto-repair-frequency');
})(), 'n/a');
A('A7 合并失败自动修复的**排期**仍受开关保护（不因闸门改动而失效）', (() => {
    boot();
    const back = { a: cfg.autoRepairOnMergeFail, b: cfg.autoRepair };
    const r = {};
    try {
        cfg.autoRepairOnMergeFail = true; cfg.autoRepair = false;
        r.on = scheduleAutoRepairOnMergeFail(); cancelRepairTimers();
        cfg.autoRepairOnMergeFail = false; cfg.autoRepair = false;
        r.off = scheduleAutoRepairOnMergeFail(); cancelRepairTimers();
    } finally { cfg.autoRepairOnMergeFail = back.a; cfg.autoRepair = back.b; cancelRepairTimers(); }
    return r.on === true && r.off === false;
})(), 'n/a');

R.done();
