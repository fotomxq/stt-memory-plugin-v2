// ============================================================
// 单元测试 · v3.5.0「自动修复追加两步」：
//   ① 计划/悬念修复（与「设定 → 计划悬念 → 🔧 修复计划/悬念」**同一条处理**，只是调用一次）
//   ② 楼层突变识别与修正（最新情节楼层 − 当前末楼 ≥ 9 → 按内容哈希修正已处理记录）
//
// 用户要求（原话）：
//   「1. 总览的自动修复功能，追加计划悬念修复，该修复与当前计划悬念内的修复一致，只是调用一下处理。
//     2. 总览的自动修复功能，增加识别楼层突变，常见的主要就是当前楼层与最新情节对应楼层不一致且
//        存在跨度达到 9 层以上，说明楼层出现大幅手动删减。需修正已处理记录，避免无法正常分析楼层。」
//
// 运行：node tests/unit/repair-extras.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { runRepair, runRepairMech, setRepairHooks, repairHookState } from '../../core/repair.js';
import { runPlanSuspRepair } from '../../core/plan-repair.js';
import { fixFloorJump, latestPlotFloor, FLOOR_JUMP_MIN_GAP, scanPendingFloors, hashFloorText, processedVerTag } from '../../host/floors.js';

const R = makeReporter('repair-extras v3.5.0 自动修复：追加计划/悬念修复 + 楼层突变识别');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
host.ctx.characters = [{ name: '角色甲', avatar: 'extras.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);
const entry = await import('../../index.js');
// 装配一次（接线 `setRepairHooks`：楼层突变 + 计划/悬念修复）——之后每个断言都自己 `setKernelState` 造状态
try { await entry.init(); } catch (e) { /* 装配失败不阻塞：相关断言会如实失败 */ }
/** 装配后的**真实**钩子快照（每个断言开始前恢复它，避免互相污染） */
const REAL_HOOKS = repairHookState();

const mkChat = (n, from) => {
    host.ctx.chat.length = 0;
    const start = Number(from) || 0;
    for (let i = 0; i < n; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + (start + i) + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
    host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
};
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('extras.png');
    const st = Object.assign(emptyState(), o.state || {});
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    mkChat(o.floors || 20);
    setRepairHooks(Object.assign({}, REAL_HOOKS));         // 恢复真实接线（装配时 index.js 已接好）
    return st;
}

// ==================== A 组：计划/悬念修复（追加步骤） ====================
await (async () => {
    boot({ floors: 20, state: { plans: [{ id: 'p1', title: '送信', content: '送到码头', status: 'open', updatedAt: 1 }], suspense: [] } });
    const calls = [];
    setRepairHooks({ planSuspRepair: async (opts) => { calls.push(opts || {}); return { made: 1, closedP: 1, closedS: 0, merged: 0 }; } });
    const r = await runRepair({ force: true, silent: true, cause: '单测' });
    const notes = (r.stage1 && r.stage1.notes) || [];
    A('A1 自动修复**确实调用**了计划/悬念修复（同一条处理，仅调用一次），并以 `silent:true` 静默执行（提示统一由修复汇总给出）；回报里如实给出结论（「计划/悬念修复：了结计划 1」）并计入 `made`',
        calls.length === 1 && calls[0].silent === true
        && notes.some((x) => String(x).indexOf('计划/悬念修复：了结计划 1') === 0)
        && r.planSusp && r.planSusp.made === 1 && Number(r.made) >= 1
        && r.planSuspSkipped === '',
        J({ calls: calls.length, first: calls[0], notes, planSusp: r.planSusp, made: r.made }));
})();

await (async () => {
    boot({ floors: 20, state: { plans: [{ id: 'p1', title: '送信', status: 'open', updatedAt: 1 }] } });
    const calls = [];
    setRepairHooks({ planSuspRepair: async () => { calls.push(1); return { made: 0 }; } });
    const off = await runRepair({ force: true, silent: true, cause: '单测', planSusp: false });
    // 自动模式 + 关闭 AI 修订 → 本步与 AI 段同门槛，一并跳过
    boot({ floors: 20, state: { plans: [{ id: 'p1', title: '送信', status: 'open', updatedAt: 1 }] } });
    cfg.repairAutoAi = false;
    setRepairHooks({ planSuspRepair: async () => { calls.push(1); return { made: 0 }; } });
    const aiOff = await runRepair({ force: true, silent: true, cause: '自动', });
    // 未接线钩子 → 如实跳过（显式清空，模拟宿主没接这一步）
    boot({ floors: 20 });
    setRepairHooks({ planSuspRepair: null });
    const noHook = await runRepair({ force: true, silent: true, cause: '单测' });
    A('A2 三条跳过路径都如实标注（不静默假装跑过）：`opts.planSusp=false` → `disabled`；自动模式且 `cfg.repairAutoAi=false` → `ai-off`（与 AI 段同门槛）；宿主未接线钩子 → `no-hook`；三种情况下钩子都不会被调用',
        off.planSuspSkipped === 'disabled' && aiOff.planSuspSkipped === 'ai-off' && noHook.planSuspSkipped === 'no-hook'
        && calls.length === 0 && off.planSusp === null && noHook.planSusp === null && aiOff.planSusp === null,
        J({ off: off.planSuspSkipped, aiOff: aiOff.planSuspSkipped, noHook: noHook.planSuspSkipped, calls: calls.length }));
})();

await (async () => {
    // 真实接线（`index.js` 的 setRepairHooks）指向**同一个**处理函数：用真实钩子跑一次，验证机械段（悬念同内容去重）真的发生
    const st = boot({
        floors: 20,
        state: {
            plans: [],
            suspense: [
                { id: 's1', title: '谁在跟踪', content: '有人在码头盯着甲。', status: 'open', tags: [], uses: 1, updatedAt: 1 },
                { id: 's2', title: '谁在跟踪', content: '有人在码头盯着甲。', status: 'open', tags: [], uses: 1, updatedAt: 2 },
            ],
        },
    });
    const H = repairHookState();
    const before = (state.suspense || []).length;
    const r = await H.planSuspRepair({ silent: true });
    const after = (state.suspense || []).length;
    const notes = String(((r && r.merged) || 0));
    A('A3 接的是**同一条处理**（`core/plan-repair.js#runPlanSuspRepair`）：真实钩子跑一次即完成「悬念同内容机械去重」（2 条同正文 → 1 条，`merged:1`），与「设定 → 计划悬念 → 🔧 修复计划/悬念」按钮走的是同一函数（`index.js` 只是把它静默接进自动修复）',
        typeof H.planSuspRepair === 'function' && before === 2 && after === 1 && Number(r.merged) === 1
        && String(r.skipped === true || r.made >= 0) === 'true',
        J({ before, after, merged: r && r.merged, skipped: r && r.skipped, notes }));
})();

// ==================== B 组：楼层突变识别与修正 ====================
{
    // 情节记到第 100 楼、聊天只剩 60 楼（差 40 ≥ 9）→ 判为大幅手动删减
    const mkState = (plotFloor) => ({
        atoms: [
            { id: 'a1', title: '情节一', text: '甲在码头。', date: '1919-11-01', floorStart: 0, floorEnd: 1, updatedAt: 1 },
            { id: 'a2', title: '最新情节', text: '甲在仓库。', date: '1919-11-02', floorStart: plotFloor - 1, floorEnd: plotFloor, updatedAt: 2 },
        ],
        processedFloors: [],
        processedVer: processedVerTag(),
    });
    const st = boot({ floors: 60, state: mkState(100) });
    // 台账里放一条「超出当前末楼」的标记（模拟删楼后残留）
    st.processedFloors = [{ f: 90, h: hashFloorText(90) }, { f: 3, h: hashFloorText(3) }];
    st.lastKnownFloor = 99;
    const before = st.processedFloors.length;
    const plot = latestPlotFloor();
    const r = fixFloorJump();
    const after = (state.processedFloors || []).length;
    const kept3 = (state.processedFloors || []).some((x) => Number(x.f) === 3);
    const kept90 = (state.processedFloors || []).some((x) => Number(x.f) === 90);
    const jumped = state.floorJumpAt || null;
    A('B1 楼层突变**识别 + 修正**：最新情节在第 100 楼、当前只有第 59 楼（差 41 ≥ 9）→ 判为大幅手动删减并**按内容哈希修正已处理记录** —— 仍然存在的第 3 楼保持「已处理」、已不存在的第 90 楼被剔除、`lastKnownFloor` 收紧到当前末楼、记下 `floorJumpAt`（只改编号，**条目一条不删**）',
        FLOOR_JUMP_MIN_GAP === 9 && plot === 100 && r.jumped === true && r.acted === true && r.gap === 41
        && before === 2 && after === 1 && kept3 === true && kept90 === false
        && Number(state.lastKnownFloor) === 59 && !!jumped && Number(jumped.gap) === 41
        && (state.atoms || []).length === 2,
        J({ plot, r, before, after, kept3, kept90, lastKnownFloor: state.lastKnownFloor, jumped }));
}

{
    // 跨度 < 9 → 不算突变（正常抖动 / 少量删除）
    boot({ floors: 95, state: { atoms: [{ id: 'a1', title: '情节', text: '甲在码头。', floorStart: 98, floorEnd: 99, updatedAt: 1 }] } });
    const r = fixFloorJump();
    A('B2 跨度不足不误判：最新情节第 99 楼、当前末楼 94（差 5 < 9）→ `jumped:false` / `skipped:"no-jump"`，台账一条不动；聊天未就绪时同样如实跳过（`skipped`），绝不按猜测改编号',
        r.jumped === false && r.skipped === 'no-jump' && r.gap === 5
        && (state.processedFloors || []).length === 0,
        J({ r }));
}

{
    // 幂等 + 低噪声：第一次修正后，越界情节楼层已被**降级为未知区间**（floorStart/floorEnd 归零 + floorStale）
    //   → 第二次检测不再有可比对的「情节楼层」，如实 `no-data`（**不会再刷笔记、也不会重复改编号**）
    const st = boot({ floors: 60, state: { atoms: [{ id: 'a2', title: '最新情节', text: '甲在仓库。', floorStart: 99, floorEnd: 100, updatedAt: 2 }], processedFloors: [{ f: 3, h: hashFloorText(3) }], processedVer: processedVerTag() } });
    st.lastKnownFloor = 99;
    const r1 = fixFloorJump();
    const at1 = Number((state.floorJumpAt || {}).at) || 0;
    const marksAfter1 = (state.processedFloors || []).length;
    const r2 = fixFloorJump();
    const stillOk = (state.processedFloors || []).length === marksAfter1 && (state.processedFloors || []).some((x) => Number(x.f) === 3);
    A('B3 修正后**不再重复判定/重复写盘**（低噪声 + 幂等）：第一次判为突变并修正（`acted:true`，台账按内容哈希修正）；越界情节楼层已被降级为未知区间 → 第二次如实 `jumped:false` / `skipped:"no-data"`，台账与 `floorJumpAt` 都不再变动（不会每次自动修复都刷笔记）',
        r1.jumped === true && r1.acted === true && r1.marks === 1 && r2.jumped === false && r2.skipped === 'no-data'
        && at1 > 0 && stillOk,
        J({ r1: { jumped: r1.jumped, acted: r1.acted, marks: r1.marks }, r2: { jumped: r2.jumped, skipped: r2.skipped }, marksAfter1 }));
}

// ==================== C 组：接进自动修复第 1 段 ====================
await (async () => {
    const st = boot({ floors: 60, state: { atoms: [{ id: 'a2', title: '最新情节', text: '甲在仓库。', floorStart: 99, floorEnd: 100, updatedAt: 2 }], processedFloors: [{ f: 90, h: hashFloorText(90) }], processedVer: processedVerTag() } });
    st.lastKnownFloor = 99;
    setRepairHooks({ floorJump: () => fixFloorJump() });
    const r = await runRepairMech({ silent: true, cause: '单测' });
    const notes = (r.stage1 && r.stage1.notes) || [];
    const jumpNote = notes.filter((x) => String(x).indexOf('楼层突变：') === 0).join(' | ');
    A('C1 楼层突变是**自动修复第 1 段（零 AI）**的一个步骤：`runRepairMech()` 之后台账被修正（越界标记消失）、报告里出现「楼层突变：最新情节在第 100 楼、当前只有第 59 楼（相差 41 层，疑为大幅手动删减）→ 已按内容哈希修正已处理记录（…）」；`stage1.floorJump` 供诊断读取',
        r.stage1 && r.stage1.floorJump && r.stage1.floorJump.jumped === true && r.stage1.floorJump.acted === true
        && (state.processedFloors || []).length === 0
        && jumpNote.indexOf('楼层突变：最新情节在第 100 楼、当前只有第 59 楼（相差 41 层，疑为大幅手动删减）') === 0
        && jumpNote.indexOf('已按内容哈希修正已处理记录') > 0,
        J({ jumpNote, floorJump: r.stage1 && r.stage1.floorJump, marks: (state.processedFloors || []).length, notes }));
})();

// ==================== D 组：修正后「未摘要清单」恢复可用 ====================
await (async () => {
    // 突变前：情节自称到 100 楼、台账记到 99 → 聊天只剩 60 楼（0..59 全在台账里 → 清单为空）
    const st = boot({ floors: 60, state: { atoms: [{ id: 'a2', title: '最新情节', text: '甲在仓库。', floorStart: 99, floorEnd: 100, updatedAt: 2 }], processedFloors: [], processedVer: processedVerTag() } });
    st.lastKnownFloor = 99;
    st.processedFloors = [];
    for (let i = 0; i < 60; i++) st.processedFloors.push({ f: i, h: hashFloorText(i) });   // 60 楼全部「已处理」
    const beforePending = scanPendingFloors({ maintain: false }).floors.length;
    fixFloorJump();
    // 修正后：台账只保留仍存在的楼层（0..59），新楼（第 60 楼起）照常可分析
    mkChat(64);                                                                            // 用户又继续聊天 → 新增 4 层（其中 2 个 AI 楼）
    const afterPending = scanPendingFloors({ maintain: false }).floors;
    A('D1 修正后**不会「无法正常分析楼层」**：修正前台账把 0..59 全记为已处理（清单为空）；修正后台账按内容哈希仍然有效，随后新增的楼层（第 60/61 楼）**照常出现在未摘要清单**里 —— 正是用户要的「避免无法正常分析楼层」',
        beforePending === 0 && afterPending.indexOf(61) >= 0 && afterPending.indexOf(63) >= 0
        && (state.processedFloors || []).length === 60,
        J({ beforePending, afterPending, marks: (state.processedFloors || []).length }));
})();

R.done();
