// ============================================================
// 单元测试 · v3.10.4 本机缓冲读写策略（真机取证 A4）与读取台账镜像准入（A5）
//
// 真机实测（只读调试桥）：
//   · A4：一次会话里「本机缓冲」被读 **19 次 × 1.05MB（≈19.9MB）**，单次 1–12ms
//         （233ms 那次是服务端主文件的解析，不是本层）；每次状态变化**全量重写 1.11MB**（3 分钟 11 次）；
//   · A5：调试日志环 300 条里 **208 条是「读取」（69%）**，把对账/摘要/修复/异常挤掉。
// 本文件锁定两条对症措施：**解析缓存**（仍每次读原文，但不重复解析 1MB）、**等值跳过**（同源不重写），
//   以及「只有失败 / 未命中 / 慢读才镜像进调试日志」；并锁定**没有**引入时间节流（本层必须保存后即可读）。
// 运行：node tests/unit/local-buffer-io.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import {
    loadFromLocalStorage, removeLocalKeys, saveStateNow, setStorageHooks, markDataTouched,
    localBufferStats, localBufferState, setLocalBufferMaxChars, invalidateLocalBufferCache,
} from '../../adapters/store.js';
import { readLedgerRecord, setReadLedgerHooks, readLedgerStats, resetReadLedger, readLedgerMirrorWorthy } from '../../core/read-ledger.js';

const R = makeReporter('local-buffer-io v3.10.4 本机缓冲读写策略（A4）与日志镜像准入（A5）');
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第0楼正文' }] }), doc);

const store = new Map();
let gets = 0, sets = 0;
function installStoreHooks() {
    gets = 0; sets = 0;
    setStorageHooks({
        getItem: (k) => { gets += 1; return store.has(k) ? store.get(k) : null; },
        setItem: (k, v) => { sets += 1; store.set(k, String(v)); return true; },
        removeItem: (k) => { store.delete(k); return true; },
    });
}

/** 造一份**够大**的状态（足以让「重复解析」在真机上放大） */
function bigState(n) {
    const s = emptyState();
    const pad = '甲在码头清点货物并记录编号。'.repeat(6);
    s.atoms = [];
    for (let i = 0; i < (n || 40); i++) s.atoms.push({ id: 'a' + i, title: '情节' + i, text: pad + i, date: '1919-11-01', tags: ['码头'], uses: 0 });
    return s;
}

async function boot(opts) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, (opts && opts.cfg) || {});
    setScopeKey('char:bufio');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    setKernelState(bigState((opts && opts.atoms) || 40));
    store.clear();
    installStoreHooks();
    setLocalBufferMaxChars((opts && opts.maxChars != null) ? opts.maxChars : 0);
    invalidateLocalBufferCache();
    resetReadLedger();
    // 首次落盘（建立本机缓冲）
    await saveStateNow({ reason: 'test-init', force: true, skipFile: true });
}

(async function main() {
    // ---------- A 组：解析缓存（削本层 CPU 放大；**不牺牲真相**） ----------
    await boot({});
    const key = 'ftt2_state_' + scopeId();

    A('A1 首次载入：真实读取 + 真实解析（parseHits 不增）', (() => {
        const before = localBufferStats();
        const st = loadFromLocalStorage();
        const after = localBufferStats();
        return st && st.atoms.length === 40 && gets === 1
            && after.reads === before.reads + 1 && after.parseHits === before.parseHits;
    })(), () => ({ stats: localBufferStats(), gets: gets }));

    A('A2 文本未变时重复载入：**仍然读原文**（真相优先）但**不再解析**（parseHits +2，内容一致）', (() => {
        const before = localBufferStats();
        const g0 = gets;
        const s1 = loadFromLocalStorage();
        const s2 = loadFromLocalStorage();
        const after = localBufferStats();
        return s1 && s2 && s1.atoms.length === 40 && gets === g0 + 2
            && after.parseHits === before.parseHits + 2;
    })(), () => ({ stats: localBufferStats(), gets: gets }));

    A('A3 外部改动（绕过本层写入直接改桩）：**下次载入立刻看到新内容** —— 缓存不引入陈旧', (() => {
        const env = JSON.parse(store.get(key));
        env.payload.data.atoms.push({ id: 'ext-1', title: '外部改动', text: '由外部直接写入的内容。', date: '1919-11-05', tags: [] });
        env.hash = '';                                   // 外部写入方未必重算哈希：置空即跳过校验，专注验证「不陈旧」
        store.set(key, JSON.stringify(env));
        const st = loadFromLocalStorage();
        return !!st && st.atoms.some((a) => a.id === 'ext-1');
    })(), '见断言');

    A('A4 本层写入 → 解析缓存失效（下一载入重新解析并拿到新内容）', (async () => {
        const before = localBufferStats();
        state.atoms.push({ id: 'a-new', title: '新情节', text: '新写入的内容，用于验证解析缓存失效。', date: '1919-11-06', tags: [] });
        markDataTouched();
        await saveStateNow({ reason: 'test-write', skipFile: true });
        const mid = localBufferStats();
        const st = loadFromLocalStorage();
        return st && st.atoms.some((a) => a.id === 'a-new') && mid.parseHits === before.parseHits;
    })(), '见断言');

    // ---------- B 组：写入闸门（削写放大，且**不改读写语义**） ----------
    await boot({});

    A('B1 内容未变（仅 markDataTouched 触碰）→ **等值跳过**写入，如实记 `unchanged`，不再重写 1MB', (async () => {
        const s0 = sets;
        markDataTouched();
        await saveStateNow({ reason: 'test-touch', skipFile: true });
        const st = localBufferStats();
        return sets === s0 && st.unchanged === 1 && localBufferState().skipped === 'unchanged'
            && st.lastSkipReason === 'unchanged';
    })(), () => ({ sets: sets, stats: localBufferStats() }));

    A('B2 等值跳过**不误伤真实变更**：内容变了必须立刻写（「保存后即可读」语义不变）', (async () => {
        const s0 = sets;
        state.atoms.push({ id: 'b-1', title: '真实变更', text: '内容确实变了，必须立刻落进本机缓冲。', date: '1919-11-03', tags: [] });
        markDataTouched();
        await saveStateNow({ reason: 't1', skipFile: true });
        const raw = store.get(key) || '';
        return sets === s0 + 1 && raw.indexOf('真实变更') > 0 && localBufferStats().unchanged === 1;
    })(), () => ({ sets: sets, stats: localBufferStats() }));

    A('B3 连续两次改不同内容：**两次都写**（不引入时间节流，避免本层落后于内存态）', (async () => {
        const s0 = sets;
        state.atoms.push({ id: 'b-3a', title: '连续A', text: '第一次改动。', date: '1919-11-04', tags: [] });
        markDataTouched();
        await saveStateNow({ reason: 't2', skipFile: true });
        state.atoms.push({ id: 'b-3b', title: '连续B', text: '紧接着的第二次改动。', date: '1919-11-04', tags: [] });
        markDataTouched();
        await saveStateNow({ reason: 't3', skipFile: true });
        const raw = store.get(key) || '';
        return sets === s0 + 2 && raw.indexOf('连续B') > 0;
    })(), () => ({ sets: sets, stats: localBufferStats() }));

    A('B4 超预算仍然跳过（回归保护：与 v3.1.0 口径一致，如实记 over-budget）', (async () => {
        setLocalBufferMaxChars(10);
        const s0 = sets;
        state.atoms.push({ id: 'b-4', title: '超预算', text: '信封远超 10 字符预算。', date: '1919-11-05', tags: [] });
        markDataTouched();
        await saveStateNow({ reason: 'tiny-budget', force: true, skipFile: true });
        const ok = sets === s0 && localBufferState().skipped === 'over-budget' && localBufferStats().overBudget === 1;
        setLocalBufferMaxChars(0);
        return ok;
    })(), () => ({ sets: sets, local: localBufferState() }));

    A('B5 清理本机键 → 解析缓存失效 **且上次写入签名清空**：清空后不得读回旧信封，**连「同内容保存」也必须重新写回**', (async () => {
        const before = loadFromLocalStorage();
        const r = removeLocalKeys([key]);
        const after = loadFromLocalStorage();
        const s0 = sets;
        markDataTouched();                                     // 内容未变，只触碰
        await saveStateNow({ reason: 're-save-after-clear', skipFile: true });
        // 若签名没被清掉 → 这次会被「等值跳过」→ 本机缓冲永远空着（local-copy B1 曾间歇性复现）
        return !!before && r.removed === 1 && after === null && sets === s0 + 1 && !!store.get(key);
    })(), '见断言');

    // ---------- C 组：A5 镜像准入 ----------
    A('C1 `readLedgerMirrorWorthy`：失败 / 未命中 / 慢读 → 真；常规成功快读 → 假', (() => {
        const yes = readLedgerMirrorWorthy({ ok: false, ms: 1 })
            && readLedgerMirrorWorthy({ ok: true, miss: true, ms: 1 })
            && readLedgerMirrorWorthy({ ok: true, ms: 150 })
            && readLedgerMirrorWorthy({ ok: true, ms: 100 });
        const no = readLedgerMirrorWorthy({ ok: true, miss: false, ms: 9 }) === false
            && readLedgerMirrorWorthy({ ok: true, ms: 0 }) === false;
        return yes && no;
    })(), '见断言');

    A('C2 台账出口只镜像**值得的**：常规成功读取不进日志环（真机 208/300 的根因），失败与 `mirror:true` 才进', (() => {
        const got = [];
        setReadLedgerHooks({ log: (rec) => got.push(rec) });
        resetReadLedger();
        readLedgerRecord({ action: '通道读取', src: 'file', ok: true, ms: 9, bytes: 11800 });
        readLedgerRecord({ action: '通道读取', src: 'file', ok: true, ms: 12, bytes: 11800 });
        const afterRoutine = got.length;
        readLedgerRecord({ action: '通道读取', src: 'shard', ok: false, ms: 3, reason: 'HTTP 500' });
        readLedgerRecord({ action: '写本机缓冲', src: 'local', ok: true, miss: true, reason: 'unchanged' });
        readLedgerRecord({ action: '手工', src: 'other', ok: true, ms: 1, mirror: true });
        setReadLedgerHooks({ log: () => undefined });
        return afterRoutine === 0 && got.length === 3
            && got[0].ok === false && got[1].miss === true && got[2].action === '手工';
    })(), () => ({ total: readLedgerStats().count }));

    R.done();
})().catch((e) => { console.error('❌ local-buffer-io.test.js 异常中断:', e); process.exit(1); });
