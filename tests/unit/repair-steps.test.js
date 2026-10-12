// ============================================================
// 单元测试 · v3.45.10（`docs/D22` W8 `技-37` / `docs/D17` U184）：
//   **第 ① 段九步的逐步留痕** —— 每步记 `{ step, ok, ms, err }`；日志只列非 ok 项；`runRepair` 返回值透出 `steps`。
//
// 用户要求（原话）：「新版本，v3.45.10 / 开发待开发的W8」
// 事实：`docs/D17` U184 —— 「第①段 9 步静默吞错：`core/repair.js#runRepairMech` 的 9 步各自独立 `try/catch`，
//   抛错既不写 `notes` 也不进日志 → 用户与排障者只能从『某步计数为 0』间接推测，**无法判定『哪一步失败』**」。
//
// 本档要证明的三件事（对应 `技-37` 的三条验收）：
//   ① 正常一次：**9 步全 ok**（名单与实跑同源：`REPAIR_MECH_STEPS`）；
//   ② 某步抛错：记 `ok:false + err`，且**后续步仍执行**（不中断整段）；
//   ③ 失败项**只列非 ok**（正常时不占日志地方），并且 `runRepair` 的返回值能拿到 `steps`。
//
// 运行：node tests/unit/repair-steps.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    runRepair, runRepairMech, setRepairHooks, REPAIR_MECH_STEPS, REPAIR_STEP_ERR_CAP,
    repairStepRecord, runRepairStep, repairStepFailures, repairStepsSummary,
} from '../../core/repair.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('repair-steps v3.45.10 W8 技-37（第①段九步逐步留痕）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

installGlobalHost(makeHost({ chat: [] }), (() => { const d = makeDocument(['ftt-panel']); d.body = { insertAdjacentHTML() { }, addEventListener() { } }; return d; })());

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('steps.png');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setRepairHooks({ floorJump: null, clockSync: null, planSuspRepair: null });   // 回到「未接线」基线
}

// ==================== A 组：名单与纯函数 ====================
A('A1 **九步名单与 `docs/04` §2.2 同源**（顺序固定 1→9）：`REPAIR_MECH_STEPS` 恰好 9 项、编号连续、名字逐字一致', (() => {
    const names = REPAIR_MECH_STEPS.map((s) => s.name);
    const want = ['机械去重', '遗忘清扫', '条数裁剪', '垃圾清理', '衰退清扫', '关联层维护', '清理无效关系', '楼层突变识别', '剧情时钟刷新'];
    return REPAIR_MECH_STEPS.length === 9
        && REPAIR_MECH_STEPS.every((s, i) => s.step === i + 1 && !!s.note)
        && J(names) === J(want);
})(), J(REPAIR_MECH_STEPS.map((s) => s.step + ':' + s.name)));

A('A2 `repairStepRecord`（纯函数）：没抛错 → `ok:true` 且 `err` 为空串；抛错 → `ok:false` 且 `err` 是**截断后**的消息；`ms` 非负', (() => {
    const ok = repairStepRecord(3, '条数裁剪', Date.now() - 5, null);
    const long = 'x'.repeat(500);
    const bad = repairStepRecord(8, '楼层突变识别', Date.now(), new Error(long));
    const nil = repairStepRecord(1, '机械去重', Date.now(), '纯字符串错误');
    return ok.ok === true && ok.err === '' && ok.step === 3 && ok.name === '条数裁剪' && ok.ms >= 5
        && bad.ok === false && bad.err.length === REPAIR_STEP_ERR_CAP && bad.err === long.slice(0, REPAIR_STEP_ERR_CAP)
        && nil.ok === false && nil.err === '纯字符串错误';
})(), '');

await (async () => {
    let ran2 = 0;
    let r1 = null, r2 = null, steps = null;
    await (async () => {
        steps = [];
        r1 = await runRepairStep(steps, REPAIR_MECH_STEPS[0], () => { throw new Error('第一步故意抛错'); });
        r2 = await runRepairStep(steps, REPAIR_MECH_STEPS[1], () => { ran2++; return { swept: 2 }; });
    })();
    A('A3 `runRepairStep`：某步抛错**不中断** —— 第一步抛错后，第二步照样跑（这是「后续步仍执行」的单步契约）', (() => {
        return r1.ok === false && String(r1.err).indexOf('故意抛错') > 0
            && r2.ok === true && r2.val.swept === 2 && ran2 === 1
            && steps.length === 2 && steps[0].ok === false && steps[1].ok === true;
    })(), J(steps));
})();

A('A4 摘要与失败项：正常 → 「9/9 步 ok」且失败项**为空数组**；有失败 → 摘要点名**第几步 + 哪一步**（日志只列非 ok）', (() => {
    const allOk = [{ step: 1, name: 'a', ok: true, ms: 1, err: '' }, { step: 2, name: 'b', ok: true, ms: 1, err: '' }];
    const oneBad = allOk.concat([{ step: 8, name: '楼层突变识别', ok: false, ms: 3, err: 'boom' }]);
    return repairStepFailures(allOk).length === 0
        && repairStepsSummary(allOk) === '机械清理 2/9 步 ok'
        && repairStepFailures(oneBad).length === 1 && repairStepFailures(oneBad)[0].step === 8
        && repairStepsSummary(oneBad).indexOf('2/3 步 ok') > 0 && repairStepsSummary(oneBad).indexOf('第 8 步 楼层突变识别') > 0
        && repairStepsSummary([]) === '';
})(), '');

// ==================== B 组：端到端（第 ① 段九步） ====================
await (async () => {
    boot();
    const mech = await runRepairMech({ silent: true });
    const steps = mech.steps || [];
    A('B1 正常一次自动修复：**9 步全 ok**（含未接线的第 8/9 步 —— 它们如实记 `skipped=no-hook` 而不是失败）', (() => {
        return steps.length === 9 && steps.every((s) => s.ok === true)
            && J(steps.map((s) => s.step)) === J([1, 2, 3, 4, 5, 6, 7, 8, 9])
            && steps.every((s) => typeof s.ms === 'number' && s.ms >= 0 && s.err === '')
            && mech.stepsSummary === '机械清理 9/9 步 ok'
            && mech.floorJumpSkipped === 'no-hook' && mech.clockSyncSkipped === 'no-hook';
    })(), J(steps.map((s) => s.step + (s.ok ? '✔' : '✘'))));
})();

await (async () => {
    boot();
    let clockCalls = 0;
    setRepairHooks({
        floorJump: () => { throw new Error('楼层钩子炸了'); },
        clockSync: async () => { clockCalls++; return { changed: true, date: '第 9 天', time: '清晨', location: '码头', storyDay: 9 }; },
    });
    const mech = await runRepairMech({ silent: true });
    const steps = mech.steps || [];
    const s8 = steps.filter((s) => s.step === 8)[0] || {};
    A('B2 第 8 步抛错：该步记 **`ok:false` + `err`**，且**第 9 步仍然执行**（实测：clockSync 钩子被调用、结果照常进 `stage1`）——「哪一步失败」从此可判定', (() => {
        return steps.length === 9 && s8.ok === false && String(s8.err).indexOf('楼层钩子炸了') >= 0
            && steps.filter((s) => s.step === 9)[0].ok === true
            && clockCalls === 1 && !!(mech.stage1 && mech.stage1.clockSync && mech.stage1.clockSync.changed)
            && repairStepFailures(steps).length === 1
            && repairStepsSummary(steps).indexOf('8/9 步 ok') > 0;
    })(), J({ clockCalls: clockCalls, s8: s8, summary: repairStepsSummary(steps) }));
})();

A('B3 第 1 步不再裸奔（源码级回归判据）：`runRepairMech` 里九步**全部**经 `runRepairStep` 包裹 —— 此前第 1 步是裸调用，一抛错会中断整段机械清理', (() => {
    const src = readFileSync(join(ROOT, 'core', 'repair.js'), 'utf8');
    const wrapped = (src.match(/runRepairStep\(steps, S\([1-9]\)/g) || []).length;
    return wrapped === 9
        && src.indexOf('const m1 = repairMergeDedupe();') < 0        // 旧的裸调用形态已消失
        && src.indexOf('REPAIR_MECH_STEPS') > 0;
})(), '');

await (async () => {
    boot();
    const out = await runRepair({ silent: true, cause: '测试', force: true, planSusp: false });
    A('B4 `runRepair`（总览自动修复）**返回值透出 `steps`**：编排层无需再猜第 ① 段跑没跑成', (() => {
        return Array.isArray(out.steps) && out.steps.length === 9
            && out.steps.every((s) => s.ok === true)
            && out.stepsSummary === '机械清理 9/9 步 ok'
            && !!(out.mech && Array.isArray(out.mech.steps));
    })(), J({ keys: out.steps ? out.steps.length : null, summary: out.stepsSummary, made: out.made }));
})();

R.done();
