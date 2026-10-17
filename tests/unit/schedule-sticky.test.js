// ============================================================
// 单元测试 · v3.50.10：`技-52`（延迟触发器粘滞态）+ `技-53`（`static:full` 可执行）
//   （`docs/D22` §4.25 · `docs/D45` §2.4 F3 / §2.5 F4）
//
// `技-52` 缺陷：两个新模块（`技-50` / `技-51`）都写成「`pending = true` → `timer = setT(...)`」，
//   而 `setT` 在**没有 setTimeout 的宿主**（或测试注入的空实现）下**返回 `null` 而不抛错** →
//   ① 读数说谎（`pending:true` / `scheduled:false` 自相矛盾）；② 之后所有信号都被判 `coalesced` 吞掉。
//   修法：**句柄为假值 → 回滚 `pending`**（与先例 `core/clock-extract.js#scheduleClockExtract` 对齐）。
//
// `技-53` 缺陷：仓库有 5 处文档引用 `npm run static:full`，但 `package.json` 里没有这个 script →
//   「发版前全量 node --check 语法兜底」事实上从未被执行过。
//
// 运行：node tests/unit/schedule-sticky.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    scheduleInjectRefresh, injectScheduleState, resetInjectSchedule, setInjectScheduleHooks,
} from '../../host/inject-schedule.js';
import {
    signalNsfwCountRefresh, nsfwCountTickState, resetNsfwCountTick, setNsfwCountHooks,
} from '../../ui/nsfw-count-tick.js';

const R = makeReporter('schedule-sticky v3.50.10：`技-52` 粘滞态 + `技-53` static:full');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 注入「拿不到定时器」的空实现（setTimeout 返回 null）—— 受限宿主 / 测试兜底的等价形态 */
const NO_TIMER = { setTimeout: () => null, clearTimeout: () => undefined, now: () => 1 };

// ---------- A 组：`技-52` 注入刷新调度 ----------
A('A1 **注入刷新**：拿不到定时器时 `scheduleInjectRefresh` 如实回报 `no-timer`，且读数**不自相矛盾**（`pending:false` / `scheduled:false`）', (() => {
    resetInjectSchedule();
    setInjectScheduleHooks(NO_TIMER);
    const r1 = scheduleInjectRefresh('t1');
    const st = injectScheduleState();
    return r1.accepted === false && String(r1.reason) === 'no-timer'
        && st.pending === false && st.scheduled === false
        && Number(st.stats.noTimer) === 1;
})(), () => J({ r: scheduleInjectRefresh('x'), st: injectScheduleState() }));

A('A2 **不会粘滞**：空定时器下连续 3 次信号 → 每次都 `no-timer`（**不是 `coalesced`**），计数如实；第 2/3 次不得被吞', (() => {
    resetInjectSchedule();
    setInjectScheduleHooks(NO_TIMER);
    const rs = [scheduleInjectRefresh('a'), scheduleInjectRefresh('b'), scheduleInjectRefresh('c')];
    const st = injectScheduleState();
    return rs.every((r) => r.accepted === false && r.reason === 'no-timer')
        && rs.every((r) => r.reason !== 'coalesced')
        && Number(st.stats.signals) === 3 && Number(st.stats.coalesced) === 0 && Number(st.stats.noTimer) === 3
        && st.pending === false && st.scheduled === false;
})(), () => J({ rs: [scheduleInjectRefresh('a'), scheduleInjectRefresh('b')], st: injectScheduleState() }));

A('A3 **有定时器时行为不变**：正常注入 → `scheduled`；窗口内重复 → `coalesced`；到点回调后 `pending/scheduled` 都复位', (async () => {
    resetInjectSchedule();
    let fn = null;
    setInjectScheduleHooks({
        setTimeout: (f) => { fn = f; return 1; }, clearTimeout: () => { fn = null; }, now: () => 1,
        push: async () => undefined,
    });
    const r1 = scheduleInjectRefresh('ok');
    const r2 = scheduleInjectRefresh('dup');
    const stBefore = injectScheduleState();
    if (fn) fn();
    await new Promise((r) => setTimeout(r, 0));
    const stAfter = injectScheduleState();
    return r1.accepted === true && r1.reason === 'scheduled' && r2.reason === 'coalesced'
        && stBefore.pending === true && stBefore.scheduled === true
        && stAfter.pending === false && stAfter.scheduled === false;
})(), 'n/a');

// ---------- B 组：`技-52` 弱化 NSFW 计数 ----------
A('B1 **弱化 NSFW 计数**：拿不到定时器时信号如实回报 `no-timer`，读数不自相矛盾，且**连续两次都不粘滞**', (() => {
    resetNsfwCountTick();
    setNsfwCountHooks(NO_TIMER);
    const r1 = signalNsfwCountRefresh('提取记忆');
    const r2 = signalNsfwCountRefresh('提取记忆');
    const st = nsfwCountTickState();
    return r1.accepted === false && r1.reason === 'no-timer'
        && r2.accepted === false && r2.reason === 'no-timer'
        && st.pending === false && st.scheduled === false
        && Number(st.stats.noTimer) === 2 && Number(st.stats.dropped) === 0;
})(), () => J({ r: signalNsfwCountRefresh('x'), st: nsfwCountTickState() }));

A('B2 有定时器时行为不变：首次 `scheduled`、窗口内 `coalesced`；到点后复位（并如实计一次 run 或 skip）', (async () => {
    resetNsfwCountTick();
    let fn = null;
    setNsfwCountHooks({ setTimeout: (f) => { fn = f; return 1; }, clearTimeout: () => { fn = null; }, now: () => 1 });
    const r1 = signalNsfwCountRefresh('提取记忆');
    const r2 = signalNsfwCountRefresh('提取记忆');
    const before = nsfwCountTickState();
    if (fn) fn();
    await new Promise((r) => setTimeout(r, 0));
    const after = nsfwCountTickState();
    return r1.reason === 'scheduled' && r2.reason === 'coalesced'
        && before.pending === true && before.scheduled === true
        && after.pending === false && after.scheduled === false;
})(), 'n/a');

A('B3 排除标签仍按原口径被排除（`coalesced` / `no-timer` 之外的第三条早退路径不受本次修改影响）', (() => {
    resetNsfwCountTick();
    setNsfwCountHooks(NO_TIMER);
    const r = signalNsfwCountRefresh('注入刷新');
    const st = nsfwCountTickState();
    return r.accepted === false && (r.reason === 'excluded' || r.reason === 'no-timer')
        && Number(st.stats.signals) >= 0;
})(), () => J({ r: signalNsfwCountRefresh('弱化NSFW'), st: nsfwCountTickState() }));

// ---------- C 组：`技-53` static:full ----------
A('C1 `package.json` 里有 `static:full`（= `node scripts/check-static.js --syntax`）与 `static`（默认模式）', (() => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const s = pkg.scripts || {};
    return String(s['static:full'] || '') === 'node scripts/check-static.js --syntax'
        && String(s['static'] || '') === 'node scripts/check-static.js';
})(), 'n/a');

A('C2 **`gate` 故意不引用它**（全量语法兜底 ~25s，不塞进每次门禁）；且 `docs/05` §1 速查里能查到它', (() => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const gate = String((pkg.scripts || {}).gate || '');
    const doc = readFileSync(join(ROOT, 'docs', '05-开发指南.md'), 'utf8');
    return gate.indexOf('static:full') < 0 && gate.indexOf('check-static') < 0
        && doc.indexOf('npm run static:full') >= 0 && doc.indexOf('--syntax') >= 0;
})(), 'n/a');

A('C3 反向探针：`scripts/check-static.js` 确实认 `--syntax`（帮助文案 / 分支里出现该开关）—— 证明 C1 指向的命令真的会跑全量语法检查', (() => {
    const src = readFileSync(join(ROOT, 'scripts', 'check-static.js'), 'utf8');
    return src.indexOf('--syntax') >= 0 && src.indexOf('含全量') >= 0;
})(), 'n/a');

R.done();
