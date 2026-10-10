// ============================================================
// 单元测试 · v3.40.4（`docs/D22` `技-1` / `docs/D11` §3.2 R2）—— **落盘守门：载入完成前禁止落盘**
//
// 验收（`docs/D21` §8 技-1 行）：
//   **构造"载入未完成即触发保存" → 无任何写入且留痕；载入完成后保存正常落盘。**
//
// 覆盖：
//   A 组 内核守门纯函数：关/开闸 · 安全阀（超时自动放行并计数）· pending 记账与取走 · 幂等与复位；
//   B 组 **保存漏斗**（`adapters/store.js#saveStateNow`）：关闸期间保存 → **零写入**（本机层 / 服务端文件 /
//       内存库 / 分片全都没动）+ 读取台账留痕 + pending 记 1 + 返回 `blocked`；开闸后同一份数据**正常落盘**；
//   C 组 **同步层**（`adapters/sync.js#stateFileWrite` / `#snapshotFilePushNow`）：被保存流水线之外的入口
//       直接调用时同样被挡（守门不只在漏斗上）；
//   D 组 **不丢数据**：关闸期间被挡下的保存由开闸方 `takeWriteGatePending()` 取出并补跑 → 数据最终落盘。
//
// 运行：node tests/unit/load-gate-write.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import {
    cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setTimerHooks,
    setWriteGate, writeGateClosed, writeGateInfo, resetWriteGate, takeWriteGatePending,
    noteWriteBlocked, WRITE_GATE_MAX_MS,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { debugLogList, debugLogClear } from '../../core/debug-log.js';
import { readLedgerStats, readLedgerList } from '../../core/read-ledger.js';
import {
    setSyncStorageHooks, stateFileName, stateFileGzName, stateFileWrite, snapshotFilePushNow,
    fileCacheDropAll, resetSyncState, resetRemoteMarks,
} from '../../adapters/sync.js';
import { saveStateNow, setStorageHooks, loadFromLocalStorage } from '../../adapters/store.js';

const R = makeReporter('load-gate-write v3.40.4 落盘守门（技-1：载入未完成禁止落盘 + 安全阀 + 不丢数据）');
const clone = (v) => JSON.parse(JSON.stringify(v));
const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

// ---------- 宿主 / DOM 桩 ----------
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

/** 服务端文件通道桩（记录**每一次**上传，用于"零写入"断言） */
const files = new Map();
const uploads = [];
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        uploads.push(String(body.name));
        files.set(String(body.name), new Uint8Array(Buffer.from(String(body.data || ''), 'base64')));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, bytes: files.get(name) };
    }
    return { status: 404, text: '' };
});

const lsm = new Map();
setSyncStorageHooks({
    get: (k) => (lsm.has(k) ? lsm.get(k) : null),
    set: (k, v) => { lsm.set(k, String(v)); return true; },
    del: (k) => { lsm.delete(k); return true; },
});
setStorageHooks({
    getItem: (k) => (lsm.has(k) ? lsm.get(k) : null),
    setItem: (k, v) => { lsm.set(k, String(v)); return true; },
    removeItem: (k) => { lsm.delete(k); return true; },
});

const atomOf = (id, text) => ({ id: id, text: text, title: text, tags: [], uses: 1, updatedAt: 1700000000000 });
/** 重启测试环境（**不关闸**，各用例自己决定） */
function boot(atoms) {
    resetSyncState(); resetRemoteMarks(); resetWriteGate();
    files.clear(); uploads.length = 0; lsm.clear(); fileCacheDropAll();
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage.stateFile = true;
    cfg.storage.stateFileBak = false;
    cfg.storage.snapshotFile = false;
    cfg.storage.syncMetaProbe = false;
    cfg.storage.syncLogServer = false;
    cfg.storage.stateFileGzip = false;
    cfg.storage.stateFileSlim = false;
    cfg.storage.localDiskDir = '';
    setScopeKey('char:loadgate');
    setIdentityView({ characterName: '角色甲' });
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setKernelState(Object.assign(emptyState(), clone({ atoms: atoms || [atomOf('a1', '甲在码头清点货物。')] }), { updatedAt: 1700000000000 }));
    debugLogClear();
    return state;
}
/** 本次保存「有没有真的写出去」：本机层 + 服务端文件 + 内存库 三处都查 */
const wroteAnything = () => uploads.length > 0 || lsm.size > 0;
const led = () => { try { return readLedgerStats(); } catch (e) { return {}; } };
const ledList = () => { try { return (readLedgerList ? readLedgerList() : []) || []; } catch (e) { return []; } };
const logs = () => { try { return debugLogList() || []; } catch (e) { return []; } };

// ============================================================
// A 组：内核守门纯函数
// ============================================================
await A('A1 关闸 / 开闸幂等：`setWriteGate(true)` 后 `writeGateClosed()` 为真，开闸后为假；重复调用不改变语义', (() => {
    resetWriteGate();
    const a = writeGateClosed();
    setWriteGate(true, '测试关闸'); const b = writeGateClosed();
    setWriteGate(true, '再来一次'); const c = writeGateClosed();
    const mid = writeGateInfo();
    setWriteGate(false); const d = writeGateClosed();
    setWriteGate(false); const e = writeGateClosed();
    return a === false && b === true && c === true && mid.closed === true && mid.reason === '测试关闸'
        && d === false && e === false;
}), '');

await A('A2 **安全阀**：关闸超过 `WRITE_GATE_MAX_MS` 仍未开 → 自动放行 + `timeouts` 如实计数（绝不静默卡死写入）', (() => {
    resetWriteGate();
    const keep = Date.now;
    try {
        const t0 = keep();
        Date.now = () => t0;                       // 关闸时刻
        setWriteGate(true, '安全阀测试');
        const during = writeGateClosed();
        Date.now = () => t0 + WRITE_GATE_MAX_MS + 1;   // 超时
        const after = writeGateClosed();
        const info = writeGateInfo();
        return during === true && after === false && info.timeouts === 1 && WRITE_GATE_MAX_MS > 0;
    } finally { Date.now = keep; }
}), '');

await A('A3 pending 记账与取走：每次被挡 `noteWriteBlocked` 计 1；`takeWriteGatePending()` 取走即清零（幂等）', (() => {
    resetWriteGate();
    setWriteGate(true, 'pending 测试');
    noteWriteBlocked('x#one'); noteWriteBlocked('x#two');
    const before = writeGateInfo();
    const n1 = takeWriteGatePending();
    const n2 = takeWriteGatePending();
    const after = writeGateInfo();
    setWriteGate(false);
    return before.blocked === 2 && before.pending === 2 && before.lastBlockedWhere === 'x#two'
        && n1 === 2 && n2 === 0 && after.pending === 0;
}), '');

// ============================================================
// B 组：保存漏斗（`saveStateNow`）
// ============================================================
await A('B1 **构造"载入未完成即触发保存" → 零写入 + 留痕**：关闸时 `saveStateNow` 返回 `blocked`，本机层 / 服务端文件 / 内存库**一处都没写**，读取台账与调试日志各留一条', async () => {
    boot();
    setWriteGate(true, '模拟首屏载入中');
    const r = await saveStateNow({ reason: '载入未完成就保存（用例）' });
    const gate = writeGateInfo();
    const txt = JSON.stringify(logs());
    const lt = JSON.stringify(ledList().slice(-6));
    const out = !!r && r.ok === false && r.blocked === true && r.reason === 'load-gate'
        && wroteAnything() === false                     // ★ 零写入
        && gate.blocked >= 1 && gate.pending >= 1        // ★ 记账（开闸后要补跑）
        && txt.indexOf('落盘守门') >= 0                   // ★ 调试日志留痕
        && lt.indexOf('load-gate') >= 0;                 // ★ 读取台账留痕
    return out;
}, '');

await A('B2 **开闸后同一份数据正常落盘**（守门只挡载入窗口，不放过后遗症）：开闸 → 保存 → 服务端文件与本机层都写了', async () => {
    boot();
    setWriteGate(true, '先关');
    await saveStateNow({ reason: '关闸期' });
    const blockedWrites = uploads.length;
    setWriteGate(false);
    const r = await saveStateNow({ reason: '开闸后' });
    const stored = loadFromLocalStorage();
    return blockedWrites === 0 && !!r && r.ok === true && uploads.length > 0
        && !!stored && Array.isArray(stored.atoms) && stored.atoms.length === 1;
}, '');

await A('B3 守门不影响**读取**：关闸期间载入路径照常可读（本机层读得回上次写入的内容）', async () => {
    boot();
    setWriteGate(false);
    await saveStateNow({ reason: '先有一份' });
    const before = loadFromLocalStorage();
    setWriteGate(true, '关闸');
    const after = loadFromLocalStorage();
    setWriteGate(false);
    return !!before && !!after && after.atoms.length === before.atoms.length;
}, '');

// ============================================================
// C 组：同步层（保存流水线之外的入口）
// ============================================================
await A('C1 `stateFileWrite` 被直接调用时同样被挡（守门不只在漏斗上）：返回 `reason=load-gate`，未产生任何上传', async () => {
    boot();
    setWriteGate(true, '直调同步层');
    const r = await stateFileWrite({ v: 1, payload: { scope: 'x', updatedAt: 1, data: { atoms: [] } }, hash: '' }, { bak: false });
    const gate = writeGateInfo();
    return !!r && r.ok === false && r.reason === 'load-gate' && r.blocked === true
        && uploads.length === 0 && gate.blocked >= 1;
}, '');

await A('C2 `snapshotFilePushNow` 被直接调用时同样被挡（快照链属记忆数据）', async () => {
    boot();
    cfg.storage.snapshotFile = true;
    state.snapStore = [{ id: 'snap1', kind: 'root', atomsHashes: {} }];
    setWriteGate(true, '直调快照');
    const r = await snapshotFilePushNow();
    const gate = writeGateInfo();
    setWriteGate(false);
    return !!r && r.ok === false && r.reason === 'load-gate' && uploads.length === 0 && gate.blocked >= 1;
}, '');

// ============================================================
// D 组：不丢数据（被挡下的保存由开闸方补跑）
// ============================================================
await A('D1 **不丢数据**：关闸期自愈写回被挡下 → 开闸方 `takeWriteGatePending()` 取出并补跑后，数据真的落盘（不是"修了不落盘"）', async () => {
    boot([atomOf('heal1', '载入期自愈后的新内容。')]);
    setWriteGate(true, '载入中（自愈写回被挡）');
    const blocked = await saveStateNow({ reason: '载入期数据自愈' });
    const pend = takeWriteGatePending();                 // 开闸方的动作
    setWriteGate(false);
    const after = await saveStateNow({ reason: '落盘守门放行后补跑（被挡下 ' + pend + ' 次）' });
    const stored = loadFromLocalStorage();
    const text = stored ? JSON.stringify(stored) : '';
    return !!blocked && blocked.blocked === true && pend === 1
        && !!after && after.ok === true
        && text.indexOf('载入期自愈后的新内容') >= 0;
}, '');

await A('D2 `resetWriteGate()`（teardown 口径）把守门与计数一并复位：卸载后不会再挡住下一次装配的写入', async () => {
    boot();
    setWriteGate(true, '卸载前');
    noteWriteBlocked('x#y');
    resetWriteGate();
    const info = writeGateInfo();
    const r = await saveStateNow({ reason: '复位后' });
    return info.closed === false && info.blocked === 0 && info.pending === 0 && info.timeouts === 0
        && !!r && r.ok === true && uploads.length > 0;
}, '');

R.assert('R1 回归：默认（没关过闸）时守门完全透明 —— 保存照常，`blocked`/`timeouts` 均为 0', (() => {
    const info = writeGateInfo();
    return info.blocked === 0 && info.timeouts === 0 && writeGateClosed() === false;
})(), JSON.stringify(writeGateInfo()));

R.done();
