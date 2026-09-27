// ============================================================
// 单元测试 · v2.81.0「分析记忆后：情节有更新 → 按最新一条同步 日期/时间/地点/在场角色」
//
// 用户要求（原话）：「日期、时间、地点、在场角色，在每次分析记忆后，如果情节发生更新，
//   则按最新的一条更新相关记录。」
//
// 既有事实（修复前）：
//   · `host/preflight.js#calibrateBasics()` 只在**提取之前**校对一次（v2.61.0），来源是**当时已存在**的情节；
//   · 提取落库（`host/extract.js` 的 3 处 `mergeDelta`）之后**没有任何**时钟同步 →
//     本轮新增/更新的那条情节带着新日期/地点/涉及角色，`state.state.{date,time,location,present}` 仍是旧值，
//     要等下一次楼层事件（`scheduleClockExtract` 防抖）或下一次提取前校对才追上。
//
// 本版口径（`host/preflight.js#atomsSignature` + `#recalibrateAfterExtract`）：
//   ① 分析前取「情节容器签名」（条目数 + 排序后的 `id|内容哈希`）；
//   ② 落库成功后比对签名 —— **没变就完全不碰时钟**（不解析、不落盘、不写日志）；
//   ③ 变了则复用内核 `clockAutoExtractOnce()`：**唯一可信来源 = 最新一条带日期的非总结情节**
//      （date/time/location 取自该情节；在场角色取自该情节的涉及角色 `plot-atom`）；
//   ④ 与「提取前校对」的唯一差别：**不传 text** —— 用户要求「按最新的一条」，故不在场角色不再回读原始楼层正文。
//
// 覆盖：
//   A 组：签名判定（未变跳过 / 新增 / 原地更新 / 删除 / 容器异常）；
//   B 组：字段同步（日期 / 时间 / 地点 / 在场角色 各自跟随最新情节）；
//   C 组：开关与既有口径（组件关闭 / 自动同步关闭 / 无基线 / 手工锁定时钟仍优先 / 不抛异常）；
//   D 组：日志只在「真的执行了同步」时写一条（不刷噪声）。
// 运行：node tests/unit/clock-after-extract.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { atomsSignature, recalibrateAfterExtract } from '../../host/preflight.js';
import { debugLogList, debugLogClear } from '../../adapters/debug-log.js';
import { clockManualState } from '../../core/clock-patrol.js';

const R = makeReporter('clock-after-extract v2.81.0 分析后按最新情节同步');
async function A(name, cond, detail) {
    let ok = false, extra = detail;
    try { ok = await cond; } catch (e) { ok = false; extra = String((e && e.message) || e); }
    R.assert(name, ok === true, extra);
}
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const host = makeHost({});
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(host, doc);
globalThis.window = Object.assign({}, globalThis.window, {
    localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true },
});

/** 情节快照条件：a1（旧）/ a2（新，带地点与涉及角色） */
const A1 = { id: 'a1', text: '甲角色在码头交货。', date: '1919-11-10', time: '早晨', location: '码头', floorStart: 1, floorEnd: 1, uses: 0, tags: [], validity: 'active', entities: ['甲角色'] };
const A2 = { id: 'a2', text: '乙角色与丙角色在仓库盘货。', date: '1919-11-20', time: '黄昏', location: '仓库', floorStart: 5, floorEnd: 5, uses: 0, tags: [], validity: 'active', entities: ['乙角色', '丙角色'] };
const SNAPS = [{ id: 's1', name: '甲角色' }, { id: 's2', name: '乙角色' }, { id: 's3', name: '丙角色' }];

function boot(atoms, clockState) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.enabled = true;
    cfg.clockExtractEnabled = true;
    setScopeKey('char:clock-after');
    setLastMessageId(9);
    setKernelState(Object.assign(emptyState(), {
        state: Object.assign({ date: '', time: '', location: '', present: null }, clockState || {}),
        atoms: (atoms || [A1]).map((x) => clone(x)),
        snapshots: clone(SNAPS),
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    debugLogClear();
}
const clockOf = () => ({ date: state.state.date, time: state.state.time, location: state.state.location, present: state.state.present });

// ---------- A 组：签名判定 ----------
await A('A1 情节**没变**（签名相同）→ 直接跳过：不解析、不落盘、state.state 一动不动', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const before = clockOf();
    const r = recalibrateAfterExtract(atomsSignature());
    return r.ok === false && r.skipped === 'atoms-unchanged' && r.changed === false
        && J(clockOf()) === J(before);
})(), () => J(clockOf()));

await A('A2 新增一条**更新**的情节 → 签名变化被识别（ok=true，skipped 为空）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push(clone(A2));                 // 模拟本轮分析落库新增
    const r = recalibrateAfterExtract(sig);
    return r.ok === true && r.skipped === '' && r.changed === true && sig !== atomsSignature();
})(), () => ({ sig: atomsSignature().slice(0, 24) }));

await A('A3 **原地更新**既有情节（同 id、改日期）→ 签名同样变化（内容哈希参与签名）', (() => {
    boot([A1, A2], { date: '1919-11-20', time: '黄昏', location: '仓库', present: ['乙角色'] });
    const sig = atomsSignature();
    state.atoms[1].date = '1919-11-25';          // 同 id 原地改内容
    const r = recalibrateAfterExtract(sig);
    return r.ok === true && state.atoms[1].date === '1919-11-25' && sig !== atomsSignature()
        && state.state.date === '1919-11-25';
})(), () => clockOf());

await A('A4 **删除**最新情节 → 签名变化，时钟退回次新的一条（仍只取情节）', (() => {
    boot([A1, A2], { date: '1919-11-20', time: '黄昏', location: '仓库', present: ['乙角色', '丙角色'] });
    const sig = atomsSignature();
    state.atoms = state.atoms.filter((x) => x.id !== 'a2');
    const r = recalibrateAfterExtract(sig);
    return r.ok === true && r.changed === true && state.state.date === '1919-11-10'
        && state.state.time === '早晨' && state.state.location === '码头';
})(), () => clockOf());

await A('A5 情节容器异常（非数组 / 空）→ 不抛错，且按「无变化」跳过（当前签名为空）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms = null;
    const r1 = recalibrateAfterExtract(sig);
    state.atoms = [];
    const r2 = recalibrateAfterExtract(sig);
    return r1.skipped === 'atoms-unchanged' && r2.skipped === 'atoms-unchanged' && r1.ok === false;
})(), () => 'safe');

// ---------- B 组：字段同步（按最新一条） ----------
await A('B1 日期 / 时间 / 地点 全部跟随**最新一条**情节（不是「最早」也不是「最常出现」）', (() => {
    boot([A1, A2], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push({ id: 'a3', text: '丁到达王城。', date: '1919-12-01', time: '深夜', location: '王城', floorStart: 9, floorEnd: 9, uses: 0, tags: [], validity: 'active', entities: ['甲角色'] });
    const r = recalibrateAfterExtract(sig);
    return r.ok === true && state.state.date === '1919-12-01' && state.state.time === '深夜'
        && state.state.location === '王城';
})(), () => clockOf());

await A('B2 在场角色跟随最新情节的**涉及角色**（来源 `plot-atom`，只认角色档案里已有的名字）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push(clone(A2));                  // entities: 乙、丙
    const r = recalibrateAfterExtract(sig);
    const present = state.state.present || [];
    return r.ok === true && present.length === 2 && present.indexOf('乙角色') >= 0 && present.indexOf('丙角色') >= 0
        && present.indexOf('甲角色') < 0
        && String((state.state.clockSrc || {}).present) === 'plot-atom';
})(), () => ({ present: state.state.present, src: (state.state.clockSrc || {}).present }));

await A('B3 最新情节**没有地点/时间**时不清空旧值（既有口径：该字段保持原值）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push({ id: 'a4', text: '某件无地点的事发生了。', date: '1919-12-02', floorStart: 11, floorEnd: 11, uses: 0, tags: [], validity: 'active', entities: [] });
    const r = recalibrateAfterExtract(sig);
    return r.ok === true && state.state.date === '1919-12-02'
        && state.state.location === '码头' && state.state.time === '早晨';
})(), () => clockOf());

// ---------- C 组：开关与既有口径 ----------
await A('C1 组件未启用（cfg.enabled=false）→ skipped=disabled，不改动任何记录', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push(clone(A2));
    cfg.enabled = false;
    const before = clockOf();
    const r = recalibrateAfterExtract(sig);
    return r.skipped === 'disabled' && J(clockOf()) === J(before);
})(), () => clockOf());

await A('C2 「消息后自动同步时钟」关闭（cfg.clockExtractEnabled=false）→ skipped=auto-off，不动记录（与提取前校对同一开关口径）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push(clone(A2));
    cfg.clockExtractEnabled = false;
    const before = clockOf();
    const r = recalibrateAfterExtract(sig);
    return r.skipped === 'auto-off' && J(clockOf()) === J(before);
})(), () => clockOf());

await A('C3 无基线签名（null / 空串）→ skipped=no-baseline（调用方未取基线时不冒然同步）', (() => {
    boot([A1], { date: '', time: '', location: '', present: null });
    const r1 = recalibrateAfterExtract(null);
    const r2 = recalibrateAfterExtract('');
    return r1.skipped === 'no-baseline' && r2.skipped === 'no-baseline' && r1.ok === false;
})(), () => 'no-baseline');

await A('C4 **手工锁定时钟仍最高优先**（既有口径不变）：情节更新**不覆盖** state.state 的日期/时间/地点（锁定态下自动提取不写入），在场角色照旧同步', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'], clockManual: { date: '1920-01-01', time: '正午', location: '王城', at: 9 } });
    const manual = clockManualState();
    const sig = atomsSignature();
    state.atoms.push(clone(A2));
    const r = recalibrateAfterExtract(sig);
    // 手工值的效力在「解析结果」上（`clockExtractState()` 采用手工值）；落盘的 state.state 三项在锁定态下**不被自动提取改写**
    return !!manual && manual.lock === true
        && state.state.date === '1919-11-10' && state.state.time === '早晨' && state.state.location === '码头'
        && r.ok === true && (state.state.present || []).indexOf('乙角色') >= 0
        && String(r.note).indexOf('手工锁定时钟') >= 0;
})(), () => ({ clock: clockOf(), manual: clockManualState() }));

await A('C5 幂等：同一次同步重复执行不会反复改写（第二次签名已一致 → 跳过）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    state.atoms.push(clone(A2));
    const r1 = recalibrateAfterExtract(sig);
    const after = clockOf();
    const r2 = recalibrateAfterExtract(atomsSignature());     // 以新签名为基线再来一次（等价于空跑）
    return r1.changed === true && r2.skipped === 'atoms-unchanged' && J(clockOf()) === J(after);
})(), () => clockOf());

// ---------- D 组：日志 ----------
await A('D1 只在**真的执行同步**时写一条「校对 · 分析后同步」；情节未变 / 开关关闭都不写（不刷噪声）', (() => {
    boot([A1], { date: '1919-11-10', time: '早晨', location: '码头', present: ['甲角色'] });
    const sig = atomsSignature();
    const n0 = debugLogList().length;
    recalibrateAfterExtract(sig);                            // 未变 → 不写
    const n1 = debugLogList().length;
    state.atoms.push(clone(A2));
    recalibrateAfterExtract(sig);                            // 变了 → 写一条
    const n2 = debugLogList().length;
    const last = debugLogList()[0] || {};
    // 条目形状（core/debug-log.js）：{ at, kind, data }，`data` 是 JSON 字符串
    const hit = String(last.kind || '') === '校对' && String(last.data || '').indexOf('分析后同步') >= 0;
    return n0 === n1 && n2 === n1 + 1 && hit;
})(), () => ({ logs: debugLogList().slice(0, 2) }));

R.done();
