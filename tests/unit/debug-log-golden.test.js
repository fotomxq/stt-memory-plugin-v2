// ============================================================
// 单元测试 · B9-a 调试日志（**与真实 V1 插件 v1.206 逐项比对**）
// 黄金样本：tests/fixtures/v1-golden-debug-log.json（oracle = 真实 V1 插件 v1.206 直调，
//   `dbgLog` / `dbgGet` / `dbgClear` + localStorage 持久层；`Date.now` 固定基准 + 每次 +1ms，逐字节可复现）
// 覆盖：常量与键名 / 重启后从持久层读取 / 五类 data 归一 / 字符串不截断与对象截断 6000 /
//   上限 300 挤出最旧 / 持久化合并去重（内存胜）/ 同毫秒顺序（V1 怪癖）/ 清空语义 / 配额降级 /
//   `data=undefined` 不记录 / `kind=undefined` 键被丢 / 开关关闭不记录 / 统计口径 / **V2 已修与已知偏差逐条断言**
// 说明：本文件所有断言在 await 后取真实布尔值（不使用「Promise && true」这类恒真写法）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    DEBUG_CAP, DEBUG_KEY, DEBUG_DATA_MAX, setDebugLogHooks,
    debugLogPush, debugLogList, debugLogClear, debugLogSync, debugLogStats, debugLogMerge,
} from '../../core/debug-log.js';
import { debugLogLoad, debugLogSave, wireDebugLog } from '../../adapters/debug-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-debug-log.json'), 'utf8'));
const R = makeReporter('debug-log-golden B9-a 调试日志（V1 黄金样本逐项比对）');
const clone = (v) => JSON.parse(JSON.stringify(v));
const J = (v) => JSON.stringify(v);
const FIXED_NOW = G.meta.fixedNow;

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

/** localStorage 桩（可注入「配额不足」故障） */
function makeLS(opts) {
    const o = opts || {};
    const map = new Map();
    const api = {
        _map: map, _throwWhen: o.throwWhen || null,
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        removeItem: (k) => { map.delete(String(k)); },
        setItem: (k, v) => {
            if (typeof api._throwWhen === 'function' && api._throwWhen(String(k), String(v))) throw new Error('quota-exceeded');
            map.set(String(k), String(v));
        },
    };
    return api;
}

/** 确定性时钟：返回「固定基准 + 每次调用 +1ms」（与 oracle 同款） */
function tickClock(start) {
    const real = Date.now;
    let t = start;
    Date.now = () => (t += 1);
    return {
        freeze: (v) => { Date.now = () => v; },
        reset: (v) => { t = (v === undefined ? start : v); },
        off: () => { Date.now = real; },
    };
}

let LS = null;
function installLS(opts) {
    LS = makeLS(opts);
    globalThis.window = { localStorage: LS };
    setDebugLogHooks({ load: debugLogLoad, save: debugLogSave });
    return LS;
}
/** 与 V1 oracle 的 resetAll() 对齐：清内存 + 清持久层 + 时钟复位 */
function resetAll(clock) {
    try { debugLogClear(); } catch (e) { /* 忽略 */ }
    try { LS.removeItem(DEBUG_KEY); } catch (e) { /* 忽略 */ }
    if (clock) clock.reset(FIXED_NOW);
}
const proj = (l) => ({ at: Number(l.at) || 0, kind: (typeof l.kind === 'undefined' ? null : l.kind), data: (typeof l.data === 'string' ? l.data : null) });
const listProj = () => debugLogList().map(proj);
const storageArr = () => { const raw = LS.getItem(DEBUG_KEY); return raw === null ? null : JSON.parse(raw); };

Object.assign(cfg, clone(defaultCfg));
setKernelState(emptyState());

// ---------------- D0 常量与键名（与 V1 同值） ----------------
await A('D0 常量同值：DEBUG_KEY 与 V1 逐字一致；上限 300；`data` 序列化上限 6000', () => {
    return DEBUG_KEY === G.meta.debugKey && G.meta.debugKey === 'SPreset_FTTMemoryDebug'
        && DEBUG_CAP === 300 && G.cap.n === 300 && G.cap.storedN === 300
        && DEBUG_DATA_MAX === 6000 && G.truncate.object.len === 6000;
}, { key: DEBUG_KEY, cap: DEBUG_CAP, max: DEBUG_DATA_MAX });

// ---------------- D1 重启后从持久层读取（V1 `dbgLoadFromStorage`） ----------------
await A('D1 重启读取：内存为空时从持久层载入并按时间降序（与 V1 逐项一致）', () => {
    installLS();
    debugLogClear();
    LS.setItem(DEBUG_KEY, J(G.reload.seeded));
    const loaded = listProj().filter((l) => G.reload.seeded.some((s) => s.at === l.at));
    return J(loaded) === J(G.reload.loaded);
}, (() => { try { return { got: listProj().slice(0, 3), want: G.reload.loaded }; } catch (e) { return String(e.message); } })());

// ---------------- D2 五类 data 归一（逐项比对 + 持久层逐字节一致） ----------------
await A('D2 基础归一：字符串原样 / 对象 JSON / null / 数字 / 数组（列表与持久层均与 V1 逐字节一致）', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    debugLogPush('类别A', '纯字符串');
    debugLogPush('类别B', { a: 1, b: 'x' });
    debugLogPush('类别C', null);
    debugLogPush('类别D', 123);
    debugLogPush('类别E', [1, 2, 3]);
    const got = listProj();
    const ok = J(got) === J(G.basic.list) && J(storageArr()) === J(G.basic.storage);
    clock.off();
    return ok;
}, (() => { try { return { got: listProj(), want: G.basic.list }; } catch (e) { return String(e.message); } })());

// ---------------- D3 截断：对象 JSON 截断 6000；字符串原样不截断 ----------------
await A('D3 截断口径：对象 JSON 截断 6000（首尾逐字符一致）；字符串**不截断**（V1 原样 7000）', () => {
    installLS();
    resetAll(null);
    debugLogPush('长对象', { big: 'x'.repeat(7000) });
    const o = debugLogList()[0];
    debugLogPush('长字符串', 'y'.repeat(7000));
    const s = debugLogList()[0];
    return o.data.length === G.truncate.object.len
        && o.data.slice(0, 40) === G.truncate.object.head && o.data.slice(-20) === G.truncate.object.tail
        && s.data.length === G.truncate.string.len && s.data.length === 7000;
}, (() => { try { return { obj: debugLogList()[1].data.length, str: debugLogList()[0].data.length }; } catch (e) { return String(e.message); } })());

// ---------------- D4 V1 原生行为：`data=undefined` 不记录（V2 记录空串 —— 已知偏差） ----------------
await A('D4 `data=undefined`：V1 抛错被吞→不记录（黄金样本 recorded=0）；V2 记录 1 条且 data 为空串（**已知偏差**）', () => {
    installLS();
    resetAll(null);
    const before = debugLogList().length;
    const ret = debugLogPush('空数据', undefined);
    const after = debugLogList().length;
    const head = debugLogList()[0];
    return G.undefinedData.recorded === 0 && G.undefinedData.storage === null
        && before === 0 && after === 1 && ret === true && head && head.data === '' && head.kind === '空数据';
}, (() => { try { return { v1: G.undefinedData, v2: listProj() }; } catch (e) { return String(e.message); } })());

// ---------------- D5 V1 原生行为：`kind=undefined` 记录但 JSON 键被丢（V2 归一为空串） ----------------
await A('D5 `kind=undefined`：V1 记录且 `kind` 键存在但 JSON 化被丢弃（kindType=undefined）；V2 归一为 `\'\'`（**已知偏差，JSON 层等价于「无 kind」**）', () => {
    installLS();
    resetAll(null);
    debugLogPush(undefined, 'kind 缺失');
    const e = debugLogList()[0];
    return G.undefinedKind.hasKindKey === true && G.undefinedKind.kindType === 'undefined'
        && /"at":\d+,"data":"kind 缺失"/.test(G.undefinedKind.json)
        && typeof e.kind === 'string' && e.kind === ''
        && J(storageArr()) === J([{ at: e.at, kind: '', data: 'kind 缺失' }])
        && JSON.parse(LS.getItem(DEBUG_KEY))[0].at === e.at;
}, (() => { try { return { v1: G.undefinedKind, v2: debugLogList()[0] }; } catch (e) { return String(e.message); } })());

// ---------------- D6 开关关闭不记录 ----------------
await A('D6 `cfg.debugEnabled=false` 直接丢弃（V1 同口径）；重新开启后记录，at/内容与黄金样本一致', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    const prev = cfg.debugEnabled;
    cfg.debugEnabled = false;
    const off = debugLogPush('关闭', '不应记录');
    const mid = debugLogList().length;
    cfg.debugEnabled = true;
    const on = debugLogPush('开启', '应记录');
    cfg.debugEnabled = prev !== false;
    const head = proj(debugLogList()[0]);
    clock.off();
    return G.disabled.before === 0 && mid === 0 && off === false && on === true
        && J({ before: 0, afterDisabled: mid, afterEnabled: debugLogList().length, head: head }) === J(G.disabled);
}, (() => { try { return { disabled: G.disabled, n: debugLogList().length }; } catch (e) { return String(e.message); } })());

// ---------------- D7 上限 300：挤出最旧 ----------------
await A('D7 上限 300：push 305 → 保留最新 300（首尾条目与 at 区间与 V1 逐项一致），持久层同为 300', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    for (let i = 1; i <= 305; i++) debugLogPush('上限', '第' + i + '条');
    const list = debugLogList();
    const got = {
        n: list.length, storedN: storageArr().length,
        head: proj(list[0]), tail: proj(list[list.length - 1]),
        sortedDesc: list.every((l, i) => i === 0 || Number(list[i - 1].at) >= Number(l.at)),
        atSpan: [Number(list[list.length - 1].at), Number(list[0].at)],
    };
    clock.off();
    return J(got) === J(G.cap);
}, (() => { try { return { n: debugLogList().length, head: debugLogList()[0], tail: debugLogList()[debugLogList().length - 1] }; } catch (e) { return String(e.message); } })());

// ---------------- D8 持久化合并去重（V1 每次 push 即合并；V2 仅在启动对账/显式 sync 时合并） ----------------
await A('D8 持久化合并去重：V2 `debugLogSync()` 的对账结果与 V1 每次 push 的合并结果**逐项一致**（内存胜、`at|kind` 去重、降序截断）', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    clock.reset(FIXED_NOW);
    debugLogPush('dup', 'mem1');       // at = FIXED_NOW+1
    debugLogPush('later', 'mem2');     // at = FIXED_NOW+2
    // 「其它实例」在本端已有条目之后写入持久层（V1 的 merge 步骤 = V2 的 debugLogSync）
    LS.setItem(DEBUG_KEY, J([
        { at: FIXED_NOW + 1, kind: 'dup', data: 'STORED_DUP' },   // 与本端内存同 at|kind → 内存胜
        { at: FIXED_NOW - 20, kind: '旧', data: 'storedB' },
        { at: FIXED_NOW - 30, kind: '旧', data: 'storedA' },
    ]));
    debugLogSync();
    const afterSync = listProj();
    const storage = storageArr();
    clock.off();
    return J(afterSync) === J(G.persistMerge.list) && J(storage) === J(G.persistMerge.storage)
        && afterSync.length === 4 && afterSync[1].data === 'mem1';
}, (() => { try { return { v1: G.persistMerge.list, v2: listProj() }; } catch (e) { return String(e.message); } })());

// ---------------- D8b V1 原生行为 vs V2：push 前已存在的持久层条目（已知偏差） ----------------
await A('D8b **已知偏差**：持久层在本端 push **之前**已有其它实例条目时，V1 会在 push 的 persist 里先合并（黄金样本 afterPush=4 条）；V2 push 直接整体写回（旧条目被覆盖，sync 也追不回）', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    LS.setItem(DEBUG_KEY, J([
        { at: FIXED_NOW + 1, kind: 'dup', data: 'STORED_DUP' },
        { at: FIXED_NOW - 20, kind: '旧', data: 'storedB' },
        { at: FIXED_NOW - 30, kind: '旧', data: 'storedA' },
    ]));
    clock.reset(FIXED_NOW);
    debugLogPush('dup', 'mem1');
    const afterFirstPush = listProj();
    debugLogPush('later', 'mem2');
    debugLogSync();
    const afterSync = listProj();
    clock.off();
    // V1（黄金样本）：第一条 push 之后内存即 3 条（dup + storedB + storedA），最终 4 条
    return G.persistMerge.list.length === 4
        && afterFirstPush.length === 1 && afterFirstPush[0].data === 'mem1'
        && afterSync.length === 2 && afterSync.map((l) => l.data).join(',') === 'mem2,mem1'
        && storageArr().length === 2;
}, (() => { try { return { v1Final: G.persistMerge.list.map((l) => l.data), v2Final: listProj().map((l) => l.data) }; } catch (e) { return String(e.message); } })());

// ---------------- D9 同毫秒多条：V1 保留插入顺序（怪癖）→ V2 最新在前（已知偏差） ----------------
await A('D9 同毫秒多条：V1 稳定排序保留**插入顺序**（s1→s2→s3，与注释宣称的「最新在前」矛盾）；V2 `unshift` 为最新在前（s3→s2→s1）（**已知偏差，已登记**）', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    clock.freeze(FIXED_NOW);
    debugLogPush('同刻', 's1');
    debugLogPush('同刻', 's2');
    debugLogPush('同刻', 's3');
    const got = {
        at: Number(debugLogList()[0].at) || 0,
        order: debugLogList().map((l) => l.data),
        storageOrder: storageArr().map((l) => l.data),
    };
    clock.off();
    return J(G.sameAtQuirk.order) === J(['s1', 's2', 's3'])
        && got.at === G.sameAtQuirk.at
        && J(got.order) === J(['s3', 's2', 's1']) && J(got.storageOrder) === J(['s3', 's2', 's1']);
}, (() => { try { return { v1: G.sameAtQuirk, v2: listProj() }; } catch (e) { return String(e.message); } })());

// ---------------- D10 清空：内存 + 持久层 ----------------
await A('D10 清空：V1 内存清空且 `localStorage` 键被**删除**（removeItem → null，`dbgClear` 返回 undefined）；V2 内存清空且写回 `[]`（**已知偏差**），并返回清空条数', () => {
    installLS();
    resetAll(null);
    debugLogPush('清空前', 'a');
    debugLogPush('清空前', 'b');
    const before = debugLogList().length;
    const storageBefore = LS.getItem(DEBUG_KEY) !== null;
    const ret = debugLogClear();
    const after = debugLogList().length;
    const raw = LS.getItem(DEBUG_KEY);
    return G.clear.before === 2 && G.clear.retType === 'undefined' && G.clear.storageAfterIsNull === true
        && before === 2 && after === 0 && ret === 2 && storageBefore === true && raw === '[]' && J(storageArr()) === '[]';
}, (() => { try { return { v1: G.clear, v2: { ret: '2', storage: LS.getItem(DEBUG_KEY) } }; } catch (e) { return String(e.message); } })());

// ---------------- D11 存储配额不足：V1 降级为最近 120 条；V2 无降级（已知偏差） ----------------
await A('D11 配额不足：V1 `dbgPersist` 捕获写入异常后降级为最近 120 条（黄金样本 events[0]=135→120）；V2 适配层捕获后**不做降级**（内存仍 300，**已知偏差**）', () => {
    const LIMIT = G.quotaFallback.limit;
    installLS({ throwWhen: (k, v) => k === DEBUG_KEY && v.length > LIMIT });
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    let prevN = 0;
    const events = [];
    for (let i = 1; i <= G.quotaFallback.pushes; i++) {
        debugLogPush('配额', 'p' + i + '-' + 'x'.repeat(100));
        const n = debugLogList().length;
        if (n < prevN) events.push({ i: i, before: prevN, after: n });
        prevN = n;
    }
    const v2 = { eventsN: events.length, finalN: debugLogList().length };
    clock.off();
    installLS();     // 恢复正常桩（后续用例）
    return G.quotaFallback.fallbackSlicedTo === 120 && G.quotaFallback.events[0].before === 135
        && v2.eventsN === 0 && v2.finalN === G.quotaFallback.pushes;
}, (() => { try { return { v1: G.quotaFallback, v2: { n: debugLogList().length } }; } catch (e) { return String(e.message); } })());

// ---------------- D12 统计口径（由黄金样本列表派生） ----------------
await A('D12 `debugLogStats()`：n/cap 与逐类别计数由黄金样本列表派生后一致；newestAt = 最新条目 at', () => {
    installLS();
    const clock = tickClock(FIXED_NOW);
    resetAll(clock);
    // 按 oracle 的 push 顺序回放（A→E；黄金样本 list 为最新在前，故反向）
    debugLogPush('类别A', '纯字符串');
    debugLogPush('类别B', { a: 1, b: 'x' });
    debugLogPush('类别C', null);
    debugLogPush('类别D', 123);
    debugLogPush('类别E', [1, 2, 3]);
    const s = debugLogStats();
    const want = {};
    for (const l of G.basic.list) want[l.kind] = (want[l.kind] || 0) + 1;
    const ok = s.n === G.basic.list.length && s.cap === 300 && J(s.kinds) === J(want) && s.newestAt === G.basic.list[0].at
        && J(listProj()) === J(G.basic.list);
    clock.off();
    return ok;
}, (() => { try { return debugLogStats(); } catch (e) { return String(e.message); } })());

// ---------------- D13 merge 纯函数与 V1 去重口径一致（内存胜 + 降序 + 截断 300） ----------------
await A('D13 `debugLogMerge` 去重口径：与内存同 `at|kind` 的存储条目被丢弃（保留内存版本），其余按时间降序并入', () => {
    const mem = [{ at: 300, kind: 'A', data: 'mem300' }, { at: 100, kind: 'B', data: 'mem100' }];
    const stored = [
        { at: 300, kind: 'A', data: 'STORED_DUP' },
        { at: 200, kind: 'C', data: 'stored200' },
        { at: 50, kind: 'D', data: 'stored50' },
    ];
    const merged = debugLogMerge(mem, stored);
    return merged.length === 4 && merged.map((l) => l.at).join(',') === '300,200,100,50'
        && merged.filter((l) => l.at === 300)[0].data === 'mem300'
        && merged.filter((l) => l.at === 200)[0].data === 'stored200'
        && debugLogMerge(new Array(400).fill(0).map((_, i) => ({ at: i, kind: 'k', data: 'd' })), []).length === 300;
}, (() => { try { return debugLogMerge([{ at: 300, kind: 'A' }], [{ at: 300, kind: 'A' }, { at: 200, kind: 'C' }]); } catch (e) { return String(e.message); } })());

// ---------------- D14 持久化接线（wireDebugLog）与损坏数据容忍 ----------------
await A('D14 `wireDebugLog()`：具备 localStorage 时 persistent=true 并完成一次对账；损坏 JSON 容忍为空、条目做最小归一', () => {
    installLS();
    resetAll(null);
    LS.setItem(DEBUG_KEY, J([{ at: FIXED_NOW - 5, kind: '接线', data: 'from-storage' }]));
    debugLogClear();                                   // 清内存（同时写回 []）
    LS.setItem(DEBUG_KEY, J([{ at: FIXED_NOW - 5, kind: '接线', data: 'from-storage' }]));
    const w = wireDebugLog();
    const list = listProj();
    LS.setItem(DEBUG_KEY, '{not json');
    const broken = debugLogLoad();
    LS.setItem(DEBUG_KEY, J([{ at: 10, kind: 'k', data: 'd' }, null, 'x']));
    const tolerant = debugLogLoad();
    return w.persistent === true && w.synced === 1
        && list.length === 1 && list[0].data === 'from-storage'
        && J(broken) === '[]' && tolerant.length === 1 && tolerant[0].at === 10;
}, (() => { try { return { w: wireDebugLog(), n: debugLogList().length }; } catch (e) { return String(e.message); } })());

try { delete globalThis.window; } catch (e) { /* 忽略 */ }
R.done();
