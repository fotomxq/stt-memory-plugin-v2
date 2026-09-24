// ============================================================
// 单元测试 · B9 前置：调试日志环形缓冲（V1 v1.49 `dbgLog`/`dbgClear`/`dbgPersist` 口径）
// 覆盖：环形缓冲与上限（300，最新在前）/ `data` 归一（字符串原样、对象 JSON 截断 6000）/ `cfg.debugEnabled=false` 不记录 /
//   合并去重口径（`at|kind`，降序截断、旧存储不倒灌）/ 清空（内存 + 宿主持久层）/ 宿主持久化接线（localStorage 桩）/
//   损坏数据容忍 / 统计出口。
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    DEBUG_CAP, DEBUG_KEY, DEBUG_DATA_MAX, setDebugLogHooks, debugLogPush, debugLogList, debugLogClear, debugLogSync, debugLogStats, debugLogMerge,
} from '../../core/debug-log.js';
import { debugLogLoad, debugLogSave, wireDebugLog } from '../../adapters/debug-log.js';

const R = makeReporter('debug-log B9 前置（V1 对齐）');
const clone = (v) => JSON.parse(JSON.stringify(v));

/** localStorage 桩（含 getItem/setItem/removeItem） */
function makeLS() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(String(k)); },
        _map: map,
    };
}
function boot(extra) {
    Object.assign(cfg, clone(defaultCfg));
    setKernelState(Object.assign(emptyState(), extra || {}));
    setDebugLogHooks({ load: () => [], save: () => undefined });
    debugLogClear();
}

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

await A('D1 环形缓冲：push 后最新在前；超过 300 条自动挤出最旧；list 返回副本（改动不影响内存）', () => {
    boot();
    for (let i = 1; i <= 305; i++) debugLogPush('测试', '第' + i + '条');
    const list = debugLogList();
    const unsorted = list.every((l, i) => i === 0 || (Number(list[i - 1].at) || 0) >= (Number(l.at) || 0));
    const newest = list[0] && String(list[0].data) === '第305条';
    const oldest = list[list.length - 1] && String(list[list.length - 1].data) === '第6条';
    list.push({ at: 1, kind: 'x', data: 'y' });
    return list.length === DEBUG_CAP + 1 && debugLogList().length === DEBUG_CAP && debugLogList()[0].data === '第305条'
        && newest && oldest && unsorted;
}, (() => { try { const l = debugLogList(); return { n: l.length, head: l[0], tail: l[l.length - 1] }; } catch (e) { return String(e.message); } })());

await A('D2 data 归一与开关：字符串原样；对象 JSON 化并截断 6000；`cfg.debugEnabled === false` 时**不记录**', () => {
    boot();
    const okStr = debugLogPush('类别A', '纯字符串');
    const okObj = debugLogPush('类别A', { a: 1, b: 'x'.repeat(7000) });
    const list = debugLogList();
    const long = list[0];
    cfg.debugEnabled = false;
    const off = debugLogPush('类别A', '不应记录');
    cfg.debugEnabled = true;
    return okStr === true && okObj === true && off === false
        && String(list[1].data) === '纯字符串'
        && long.data.length === DEBUG_DATA_MAX && String(long.data).indexOf('"a":1') >= 0
        && list[0].kind === '类别A' && Number(list[0].at) > 0
        && debugLogList().length === 2;                       // 被开关拦下的那条没进缓冲
}, (() => { try { return debugLogList().map((l) => [l.kind, String(l.data).slice(0, 20)]); } catch (e) { return String(e.message); } })());

await A('D3 合并去重（V1 v1.49 口径）：以内存为基准，仅补入存储中未出现的 `at|kind`，统一按时间降序截断；旧存储不倒灌', () => {
    boot();
    const mem = [{ at: 300, kind: 'A', data: 'mem300' }, { at: 100, kind: 'B', data: 'mem100' }];
    const stored = [
        { at: 300, kind: 'A', data: 'dup' },          // 与内存同 at|kind → 去重（保留内存版本）
        { at: 200, kind: 'C', data: 'stored200' },    // 内存没有 → 补入
        { at: 50, kind: 'D', data: 'stored50' },
    ];
    const merged = debugLogMerge(mem, stored);
    return merged.length === 4 && merged.map((l) => l.at).join(',') === '300,200,100,50'
        && merged.filter((l) => l.at === 300)[0].data === 'mem300'
        && merged.filter((l) => l.at === 200)[0].data === 'stored200';
}, (() => { try { return debugLogMerge([{ at: 300, kind: 'A' }], [{ at: 300, kind: 'A' }, { at: 200, kind: 'C' }]); } catch (e) { return String(e.message); } })());

await A('D4 持久化接线：wireDebugLog 后 push 落 localStorage（V1 键名与数组 JSON）；clear 清内存并清持久层；损坏数据容忍为空', () => {
    boot();
    const store = makeLS();
    globalThis.window = { localStorage: store };
    const w = wireDebugLog();
    debugLogPush('持久', { n: 1 });
    debugLogPush('持久', { n: 2 });
    const raw = store.getItem(DEBUG_KEY);
    const parsed = JSON.parse(raw);
    const persistedOk = Array.isArray(parsed) && parsed.length === 2 && parsed[0].kind === '持久';
    const cleared = debugLogClear();
    const afterClear = store.getItem(DEBUG_KEY);
    // 损坏数据 → load 返回空、不抛
    store.setItem(DEBUG_KEY, '{not json');
    const broken = debugLogLoad();
    store.setItem(DEBUG_KEY, JSON.stringify([{ at: 10, kind: 'k', data: 'd' }, null, 'x']));
    const tolerant = debugLogLoad();
    const wired = debugLogSync();
    delete globalThis.window;
    return w.persistent === true && persistedOk && cleared === 2 && afterClear === '[]'
        && Array.isArray(broken) && broken.length === 0
        && tolerant.length === 1 && tolerant[0].kind === 'k' && wired === 1;
}, (() => { try { return { ls: !!globalThis.window, n: debugLogList().length }; } catch (e) { return String(e.message); } })());

await A('D5 无 localStorage（Node/受限宿主）时退化为纯内存：wireDebugLog 返回 persistent=false 且 push/list 正常', () => {
    boot();
    delete globalThis.window;
    const w = wireDebugLog();
    debugLogPush('内存', 'm1');
    const save = debugLogSave([{ at: 1, kind: 'k', data: 'd' }]);
    const st = debugLogStats();
    return w.persistent === false && save === false && debugLogList().length === 1
        && st.n === 1 && st.cap === DEBUG_CAP && Number(st.kinds['内存']) === 1 && Number(st.newestAt) > 0;
}, (() => { try { return debugLogStats(); } catch (e) { return String(e.message); } })());

R.done();
