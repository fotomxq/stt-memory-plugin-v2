// ============================================================
// 单元测试 · `docs/D22` `业-6` / `docs/D18` §4.3 ③ **显式归一判据**（时间衰退一律按剧情时间）
//
// 为什么需要这个文件：`业-6` 把「平行事件 / 传言」的衰退基准由**现实墙钟 `updatedAt`** 改为
//   **剧情时间**（`docs/D18` §4.1 P1–P3），并顺手把 `calcTimeDecay` 的两份实现收敛成一份（P5）。
//   这属 `开发守则.md` §2.4 **类别②（可偏离 V1，需登记）**，其判据按 `D18` §4.3 ③ 必须是
//   **显式判据**（不新建 V2 自基线）：
//     ① 同一剧情日期 + 不同现实时刻 → 衰老分**不变**（证明基准不再是墙钟）
//     ② 同一现实时刻 + 不同剧情日期 → 衰老分**变化**（证明基准确实是剧情时间）
//     ③ 剧情时钟为空 → 衰老分**恒为 0**（四域统一，`D18` §4.1 P3）
//
// 运行：node tests/unit/decay-story-time.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { calcTimeDecay as viaIngest, runStateDecay } from '../../core/ingest.js';
import { calcTimeDecay as viaDecay } from '../../core/decay.js';
import { parallelDecayScore, parallelExpired } from '../../core/recall.js';
import { rumorDecayScore } from '../../core/rumor-evolve.js';
import { memoryForgetScore } from '../../core/forget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('decay-story-time 业-6 衰退基准＝剧情时间（显式判据）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setScopeKey('甲');

/** 起一套内核态：剧情时钟 + 一条传言 + 一条平行事件 + 两条记忆（一低重要一高重要，供遗忘免疫判据） */
function boot(storyDate, rumorDate, parallelDate, memoryDate) {
    Object.assign(cfg, clone(defaultCfg));
    const st = Object.assign(emptyState(), {
        state: { time: '', date: String(storyDate || ''), location: '', sceneFocus: null },
        rumors: [{
            id: 'r1', subject: '主体', content: '说法。', date: String(rumorDate || ''), media: [], chain: [],
            parallelRefs: [], lineage: { rootId: 'r1', parentId: '', children: [], generation: 0 },
        }],
        parallels: [{ id: 'p1', title: '平行标题', text: '平行正文足够长。', date: String(parallelDate || '') }],
        memories: [
            { id: 'm_low', title: '低重要', content: '低重要记忆。', date: String(memoryDate || ''), importance: 0.1 },
            { id: 'm_high', title: '高重要', content: '高重要记忆。', date: '1919-01-01', importance: 0.9 },
        ],
    });
    setKernelState(st);
    try { entryIndexInit(); } catch (e) { /* 忽略 */ }
    setPersistHooks({
        saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setNotifyHooks({ toast: () => undefined });
    return st;
}
/** 固定现实墙钟（`Date.now`）执行 —— 判据 ①② 的对照组就是它 */
function withNow(ms, fn) {
    const real = Date.now;
    Date.now = () => ms;
    try { return fn(); } finally { Date.now = real; }
}
const scores = () => ({
    parallel: Number(parallelDecayScore(state.parallels[0]).toFixed(9)),
    rumor: Number(rumorDecayScore(state.rumors[0]).toFixed(9)),
});

// ============================================================
// D1 收敛为单一实现（`docs/D18` §4.1 P5）+ 机制反向探针
// ============================================================
A('D1 时间衰退只有一份实现：`core/ingest.js#calcTimeDecay` 与 `core/decay.js#calcTimeDecay` 是同一函数，且 `core/recall.js` 的私有副本已删除',
    (() => {
        const recallSrc = readFileSync(join(ROOT, 'core', 'recall.js'), 'utf8');
        const decaySrc = readFileSync(join(ROOT, 'core', 'decay.js'), 'utf8');
        const ingestSrc = readFileSync(join(ROOT, 'core', 'ingest.js'), 'utf8');
        return viaIngest === viaDecay
            && recallSrc.indexOf('function calcTimeDecay(') < 0
            && ingestSrc.indexOf('function calcTimeDecay(') < 0
            && decaySrc.indexOf('export function calcTimeDecay(') > 0
            && decaySrc.indexOf('Date.now(') < 0;                 // 底层件**不读时钟**：基准由调用方给
    })(), '见断言');

A('D2 底层件只吃参数（`docs/D18` §4.1 P4：不改强度）—— 同参同值，且**负数毫秒（公元前~1969）照常参与**',
    (() => {
        const a = viaDecay(0, 0, 1000 * 86400 * 400, 0, 1);
        const b = viaDecay(0, 0, 1000 * 86400 * 400, 0, 1);
        const ancient = viaDecay(-62167219200000, -62167219200000, -62135596800000, -62167219200000, 1);
        const noItem = viaDecay(0, 0, 1e12, NaN, 1);
        return a === b && a > 0 && ancient > 0 && noItem === 0;
    })(), J({ sample: viaDecay(0, 0, 1000 * 86400 * 400, 0, 1) }));

// ============================================================
// D3 判据①：同一剧情日期 + 不同现实时刻 → 衰老分不变
// ============================================================
A('D3 判据① 现实墙钟推进 40 年，平行事件与传言的衰老分**逐位不变**（基准已不含墙钟）',
    (() => {
        const snap = (ms) => withNow(ms, () => {
            boot('1919-11-29', '1910-01-01', '1910-01-01', '1910-01-01');
            return scores();
        });
        const t1 = snap(1000000000000);      // 2001
        const t2 = snap(4102444800000);      // 2100
        return J(t1) === J(t2) && t1.parallel > 0 && t1.rumor > 0;
    })(), J(withNow(1000000000000, () => { boot('1919-11-29', '1910-01-01', '1910-01-01', '1910-01-01'); return scores(); })));

// ============================================================
// D4 判据②：同一现实时刻 + 不同剧情日期 → 衰老分变化（越久远越大）
// ============================================================
A('D4 判据② 现实墙钟固定，条目剧情日期由「1 天前」挪到「10 年前」→ 平行事件与传言的衰老分**都升高**',
    (() => {
        const FIXED = 1000000000000;
        const near = withNow(FIXED, () => { boot('1919-11-29', '1919-11-28', '1919-11-28', '1919-11-28'); return scores(); });
        const far = withNow(FIXED, () => { boot('1919-11-29', '1910-01-01', '1910-01-01', '1910-01-01'); return scores(); });
        return far.parallel > near.parallel && far.rumor > near.rumor && far.rumor > 0.9 && near.rumor < 0.3;
    })(), J((() => {
        boot('1919-11-29', '1919-11-28', '1919-11-28', '1919-11-28'); const near = scores();
        boot('1919-11-29', '1910-01-01', '1910-01-01', '1910-01-01'); const far = scores();
        return { near: near, far: far };
    })()));

// ============================================================
// D5 判据③：剧情时钟为空 → 四域衰老分恒为 0（`docs/D18` §4.1 P3）
// ============================================================
await (async () => {
    // 先证「有剧情时钟时确实会衰退」，再证「无剧情时钟时不衰退」——否则 0 可能来自别的分支
    boot('1919-11-29', '1910-01-01', '1910-01-01', '1910-01-01');
    const withClock = {
        parallel: parallelDecayScore(state.parallels[0]) > 0,
        rumor: rumorDecayScore(state.rumors[0]) > 0,
        memory: memoryForgetScore(state.memories[0]) > 0,
    };
    boot('', '1910-01-01', '1910-01-01', '1910-01-01');
    const noClock = {
        parallel: parallelDecayScore(state.parallels[0]),
        parallelExpired: parallelExpired(state.parallels[0]),
        rumor: rumorDecayScore(state.rumors[0]),
        memory: memoryForgetScore(state.memories[0]),
    };
    const stateRet = await runStateDecay({});
    A('D5 判据③ 剧情时钟为空 → 平行事件 / 传言 / 记忆 / 状态记录**四域一律不衰退**（状态走 `no-story-clock` 短路）',
        withClock.parallel && withClock.rumor && withClock.memory
        && noClock.parallel === 0 && noClock.parallelExpired === false && noClock.rumor === 0 && noClock.memory === 0
        && stateRet && stateRet.reason === 'no-story-clock',
        J({ withClock: withClock, noClock: noClock, stateRet: stateRet }));
})();

R.done();
