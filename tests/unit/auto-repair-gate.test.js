// ============================================================
// 单元测试 · v3.50.23：W3 `应-6`（ui-spec 升阻断）+ `应-17`（自动修复触发与闸门修正）
//
// `应-6`（`docs/D19` §8）：`check-ui-spec` 从 warning 升为**阻断** —— 「构造违规 → `npm run gate` 失败」。
// `应-17`（`docs/D25` Q1/Q2 裁决）：① 补 `state.autoRepair.lastAt` 写入点（恢复「距上次修复 N 次」）；
//   ② 触发源明确为**仅合并失败**（闸门只做限流）；③ 死键 `cfg.autoRepair` 处置为**别名**（勾选真的生效）。
//
// 运行：node tests/unit/auto-repair-gate.test.js
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { autoRepairOpDue, bumpRepairOp, markAutoRepairDone, scheduleAutoRepairOnMergeFail, cancelRepairTimers } from '../../core/repair.js';

const R = makeReporter('auto-repair-gate v3.50.23：W3 `应-6`（ui-spec 阻断）+ `应-17`（lastAt / 触发源 / 死键）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('rg23'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });
setKernelState(emptyState());

// ---------- A 组：应-6（ui-spec 阻断） ----------
A('A1 `check-ui-spec` **默认阻断**：无违规时 exit 0；源码里 `--warn` 是逃生阀、`--strict` 保留为同义', (() => {
    const src = readFileSync(join(ROOT, 'scripts', 'check-ui-spec.js'), 'utf8');
    let code = -1;
    try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-ui-spec.js')], { cwd: ROOT, stdio: 'pipe' }); code = 0; }
    catch (e) { code = Number(e.status) || 1; }
    return code === 0 && src.indexOf("process.argv.includes('--warn')") >= 0
        && src.indexOf('const strict = !warnOnly;') >= 0
        && src.indexOf('process.exit(strict && hits.length ? 1 : 0)') >= 0;
})(), 'n/a');

A('A2 **反向探针**：往 ui 文件里临时注入违规（多出一处真 `<table>`，触发 C12 额度）→ 默认 **exit 1**；`--warn` 时仍 exit 0', (() => {
    const target = join(ROOT, 'ui', 'row-select.js');
    const back = readFileSync(target, 'utf8');
    const probe = '\n// 探针违规（测试用，随后还原）：真表格超出登记额度\nexport const __probeTable = "<table><tr><td>x</td></tr></table>";\n';
    let strictCode = 0, warnCode = 0;
    try {
        writeFileSync(target, back + probe, 'utf8');
        try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-ui-spec.js')], { cwd: ROOT, stdio: 'pipe' }); strictCode = 0; }
        catch (e) { strictCode = Number(e.status) || 1; }
        try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-ui-spec.js'), '--warn'], { cwd: ROOT, stdio: 'pipe' }); warnCode = 0; }
        catch (e) { warnCode = Number(e.status) || 1; }
    } finally {
        try { writeFileSync(target, back, 'utf8'); } catch (e) { /* 忽略 */ }
    }
    return strictCode === 1 && warnCode === 0;
})(), 'n/a');

// ---------- B 组：应-17 ① lastAt 写入点 ----------
A('B1 **`lastAt` 有写入点了**：`bumpRepairOp()` 计数、`markAutoRepairDone()` 把当前 ops 落到 lastAt', (() => {
    setKernelState(emptyState());
    bumpRepairOp(); bumpRepairOp(); bumpRepairOp();
    const before = J(state.autoRepair);
    markAutoRepairDone();
    return state.autoRepair.ops === 3 && state.autoRepair.lastAt === 3;
})(), () => J(state.autoRepair));

A('B2 **闸门恢复原意**：`autoRepairEveryOps=3` 时，修复后再计数 1/2 次仍不放行（`ops-lastAt < 3`），第 3 次才放行', (() => {
    setKernelState(emptyState());
    cfg.autoRepairEveryOps = 3;
    bumpRepairOp(); bumpRepairOp(); bumpRepairOp();
    const due1 = autoRepairOpDue();               // 3 - 0 = 3 → 放行
    markAutoRepairDone();                         // 记为已修（lastAt = 3）
    const afterFix = autoRepairOpDue();           // 3 - 3 = 0 → 不放行（旧实现会恒放行 ✗）
    bumpRepairOp(); const d1 = autoRepairOpDue(); // 4 - 3 = 1 → 不放行
    bumpRepairOp(); const d2 = autoRepairOpDue(); // 5 - 3 = 2 → 不放行
    bumpRepairOp(); const d3 = autoRepairOpDue(); // 6 - 3 = 3 → 放行
    cfg.autoRepairEveryOps = defaultCfg.autoRepairEveryOps;
    return due1 === true && afterFix === false && d1 === false && d2 === false && d3 === true;
})(), () => J(state.autoRepair));

A('B3 `autoRepairEveryOps = 0` → **不限制**（恒放行）；上限 `maxAutoRepairRounds` 与闸门互不干扰', (() => {
    setKernelState(emptyState());
    cfg.autoRepairEveryOps = 0;
    const a = autoRepairOpDue();
    const b = autoRepairOpDue();
    cfg.autoRepairEveryOps = defaultCfg.autoRepairEveryOps;
    return a === true && b === true;
})(), 'n/a');

// ---------- C 组：应-17 ②③ 触发源 + 死键 ----------
A('C1 **触发源 = 仅合并失败**：`scheduleAutoRepairOnMergeFail` 在两个开关都为 false 时**不排期**；任一为 true 才排期', (() => {
    const back = { a: cfg.autoRepairOnMergeFail, b: cfg.autoRepair };
    const r = {};
    try {
        cfg.autoRepairOnMergeFail = false; cfg.autoRepair = false;
        r.none = scheduleAutoRepairOnMergeFail();
        cancelRepairTimers();
        cfg.autoRepairOnMergeFail = true; cfg.autoRepair = false;
        r.byMerge = scheduleAutoRepairOnMergeFail();
        cancelRepairTimers();
        cfg.autoRepairOnMergeFail = false; cfg.autoRepair = true;
        r.byLegacy = scheduleAutoRepairOnMergeFail();
        cancelRepairTimers();
    } finally { cfg.autoRepairOnMergeFail = back.a; cfg.autoRepair = back.b; cancelRepairTimers(); }
    return r.none === false && r.byMerge === true && r.byLegacy === true;
})(), 'n/a');

A('C2 **死键处置**：`cfg.autoRepair` 不再是「没人读」的键（源码里出现读取点），且默认值保持 `false`（不改变开箱行为）', (() => {
    const src = readFileSync(join(ROOT, 'core', 'repair.js'), 'utf8');
    return src.indexOf('cfg.autoRepair !== true') >= 0
        && defaultCfg.autoRepair === false
        && defaultCfg.autoRepairOnMergeFail === true;
})(), 'n/a');

A('C3 `lastAt` 写入只在**真的有改动**时发生（空跑不写，避免闸门被无意义重置）', (() => {
    setKernelState(emptyState());
    bumpRepairOp(); bumpRepairOp();
    const src = readFileSync(join(ROOT, 'core', 'repair.js'), 'utf8');
    return src.indexOf("if ((Number(made) || 0) > 0 || (ai && (ai.revised || ai.deleted))) markAutoRepairDone();") >= 0
        && state.autoRepair.lastAt === undefined;
})(), 'n/a');

R.done();
