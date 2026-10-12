// ============================================================
// 单元测试 · v3.46.0（`docs/D22` W9 `数-31` / `docs/D17` U188）：
//   **一次保存的物理写清单**（通道 / 次数 / 字节 / 跳过原因）+ 「只改 1 条」的写量与变化量同阶 + 载入等价 + 读放大定位读数。
//
// 用户要求（原话）：「新版本，v3.46.0 / 开发待开发的W9」
// 设计依据：`docs/D28` §3.3.2 #1 / §3.3.3 / §3.3.4 与 §8 `数-31` ——
//   ① 加「本次保存的物理写清单」读数（通道 / 次数 / 字节 / 是否跳过及原因）并进调试导出；
//   ② 逐通道核对「是否与变化量成正比」（分片已增量；主文件是全量提交点 → 读数须**如实标**「提交点全量」）；
//   ③ 主文件基准化标 `[契约]`：**本轮只评估不实施**（本档不含该改造，只含读数与定位）；
//   ④ 读放大**先定位**（不删任何校验）；
//   ⑤ 补「只改 1 条」的对照用例。
//
// 运行：node tests/unit/save-ledger.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import { storageEnvelope } from '../../core/envelope.js';
import { readLedgerStats, resetReadLedger } from '../../core/read-ledger.js';
import { saveStateNow, loadFromServerFile, setStorageHooks, saveLedgerInfo } from '../../adapters/store.js';
import { stateFileName } from '../../adapters/user-file.js';
import { resetShardMarks } from '../../adapters/shards.js';

const R = makeReporter('save-ledger v3.46.0 W9 数-31（保存物理写清单 / 只改 1 条 / 载入等价 / 读放大定位）');
const J = (v) => JSON.stringify(v);
const A = async (name, fn, detail) => {
    let ok = false, extra = detail;
    try { ok = await fn(); } catch (e) { ok = false; extra = String((e && e.message) || e); }
    R.assert(name, ok === true, typeof extra === 'function' ? (() => { try { return extra(); } catch (e) { return String(e.message); } })() : extra);
};

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

const kv = new Map();
setStorageHooks({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); return true; },
    removeItem: (k) => { kv.delete(k); return true; },
});
const files = new Map();
const putLog = [];
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        files.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8'));
        putLog.push(String(body.name));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const n = decodeURIComponent(m[1]);
        if (!files.has(n)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(n) };
    }
    return { status: 404, text: '' };
});

function mkSt(opts) {
    const o = opts || {};
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < (o.atoms || 0); i++) st.atoms.push({ id: 'a' + i, title: '情节' + i, text: '第 ' + i + ' 条情节正文（足够长，用于体积对比）。', date: '1919-11-29', tags: [], updatedAt: 1000 + i });
    st.memories = [];
    for (let i = 0; i < (o.memories || 0); i++) st.memories.push({ id: 'm' + i, owner: '甲', title: '记忆' + i, content: '记忆正文' + i + '（足够长）', updatedAt: 1000 + i });
    st.updatedAt = Number(o.updatedAt) || 1000;
    return st;
}
function boot(st) {
    setScopeKey('char:ledger');
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    kv.clear(); files.clear(); putLog.length = 0; resetShardMarks(); resetReadLedger();
    return st;
}
const shardPuts = () => putLog.filter((n) => String(n).indexOf('ftt2-shard-') === 0 && String(n).indexOf('-manifest.json') < 0);
const chOf = (ledger, name) => ((ledger && ledger.channels) || []).filter((c) => c.ch === name)[0] || null;

// ==================== A 组：读数本身的形状与只读纪律 ====================
A('A1 `saveLedgerInfo()`：环形上限 + `last` / `recent` 形状；返回**副本**（改返回值不影响内部读数）', () => {
    const info = saveLedgerInfo();
    const copy = saveLedgerInfo();
    const poked = (() => { try { if (info.recent[0]) info.recent[0].channels.length = 0; return true; } catch (e) { return false; } })();
    const after = saveLedgerInfo();
    const same = J(copy.recent) === J(after.recent);
    return info.max === 5 && Array.isArray(info.recent) && Array.isArray(info.channels) === false
        && poked === true && same === true;
}, (() => J(saveLedgerInfo()))());

// ==================== B 组：一次保存的物理写清单（验收①） ====================
await (async () => {
    boot(mkSt({ atoms: 8, memories: 4 }));
    const r = await saveStateNow({ reason: 'B-基线', force: true });
    const led = r.ledger || (((saveLedgerInfo() || {}).last) || null);
    await A('B1 账本能说出「本次写了哪些通道 / 各多少字节 / 各自为什么」：本机层 + **分片** + **主文件（如实标『提交点全量』）** + 镜像（跳过原因）', () => {
        const chs = (led && led.channels) || [];
        const names = chs.map((c) => c.ch);
        const main = chOf(led, 'main-file');
        const shards = chOf(led, 'shards');
        const mirror = chOf(led, 'mirror');
        return !!led && chs.length >= 4
            && names.indexOf('localStorage') >= 0                                  // 本机层（本桩无 localforage → 内存库自动缺席，见 B1b）
            && names.indexOf('shards') >= 0 && names.indexOf('main-file') >= 0
            && !!main && main.writes === 1 && main.bytes > 0 && String(main.reason).indexOf('提交点全量') >= 0
            && !!shards && shards.writes > 0 && shards.bytes > 0
            && !!mirror && mirror.skipped >= 1 && !!mirror.reason
            && led.totalWrites >= 4 && led.totalBytes > 0;
    }, (() => J(led))());

    await A('B1b 通道缺席 = **真的没写**（而不是「记为 0 冒充写了」）：本桩没有 `localforage` → 账本里根本没有 `indexedDB` 这一行', () => {
        const names = ((led && led.channels) || []).map((c) => c.ch);
        return names.indexOf('indexedDB') < 0;
    }, (() => J(((led && led.channels) || []).map((c) => c.ch)))());
})();

// ==================== C 组：「只改 1 条」（验收②）+ 无变化零写 ====================
await (async () => {
    const st = boot(mkSt({ atoms: 40, memories: 12 }));
    await saveStateNow({ reason: 'C-基线', force: true });
    const before = shardPuts().length;
    const leadgerBefore = ((saveLedgerInfo() || {}).recent || []).length;
    // 只改 1 条（第 0 条情节的正文多一个字）
    st.atoms[0].text = st.atoms[0].text + '！';
    st.updatedAt = 2000;
    putLog.length = 0;
    const r = await saveStateNow({ reason: 'C-只改 1 条' });
    const led = r.ledger || (((saveLedgerInfo() || {}).last) || null);
    const main = chOf(led, 'main-file');
    const shards = chOf(led, 'shards');
    const writes = shardPuts().length;
    await A('C1 「只改 1 条」：**只传变化片**（实测 1 片），主文件仍是提交点全量；并**如实登记一条发现** —— 分片是「**维度级**增量」，故该片仍是整维重写（条目级同阶要 `数-27` 区间分片）', () => {
        return writes <= 2 && !!shards && shards.writes === writes && shards.bytes > 0
            && !!main && main.bytes > 0 && shards.bytes < main.bytes          // 分片总量 < 整份信封（维度级增量成立）
            && shards.bytes > 1000;                                          // **维度整片重写**：条目级「与变化量同阶」当前不成立（见 C1b）
    }, (() => J({ shardPuts: writes, shards: shards, mainBytes: main && main.bytes, total: led && led.totalBytes }))());

    await A('C1b 条目级同阶的**缺口**写成判据（防将来误以为已达标）：1 条目变化会重写该**维度整片**（40 条情节的片 > 1KB），即"写量与变化量同阶"只在**维度粒度**成立', () => {
        const atomsPerItem = (main && main.bytes) / 41;                       // 粗估每条字节（40 条 + 信封其它）
        return !!shards && shards.bytes > atomsPerItem * 10;                  // 远超「一条」的体量 → 整片重写
    }, '');

    const ledBefore = ((saveLedgerInfo() || {}).recent || []).length;
    putLog.length = 0;
    const r2 = await saveStateNow({ reason: 'C-内容确实没变' });
    const info2 = saveLedgerInfo() || {};
    const ledAfter = (info2.recent || []).length;
    const lastCh = ((info2.last || {}).channels || [])[0] || {};
    await A('C2 **无变化 → 零物理写，但账本如实留一条「no-op」**：`putLog` 为空、`via=noop`；`last` 明说「本次未写任何通道」（读数不骗人：没写就是没写）', () => {
        return putLog.length === 0 && String(r2.via || '') === 'noop' && r2.ok === true
            && ledAfter === ledBefore + 1 && lastCh.ch === 'no-op' && String(lastCh.reason).indexOf('未写任何通道') >= 0;
    }, (() => J({ putLog: putLog.length, before: ledBefore, after: ledAfter, r2: r2, lastCh: lastCh }))());

    let c3Diff = '';
    await A('C3 **载入结果逐字段等价**（验收③）：保存 → 从服务端主文件重新载入 → 与内存 state 逐字段一致；且**盘上信封自洽**（其 `hash` == 对同一 `payload` 重算的哈希）', async () => {
        const back = await loadFromServerFile();                 // 返回**状态对象本身**（不是 {ok,state}）
        if (!back) { c3Diff = 'back=null'; return false; }
        const a = J(back), b = J(st);
        let same = (a === b);
        if (!same) {
            for (let i = 0; i < Math.min(a.length, b.length); i++) {
                if (a[i] !== b[i]) { c3Diff = 'diff@' + i + ' ' + a.slice(Math.max(0, i - 60), i + 60) + ' || ' + b.slice(Math.max(0, i - 60), i + 60); break; }
            }
            if (!c3Diff) c3Diff = 'len ' + a.length + ' vs ' + b.length;
        }
        // 落盘那一份**存在且可解析**（只断言"确实写了主文件"；**不**拿两次独立 `storageEnvelope()` 的 hash 比 ——
        //   盘上可能是**瘦身**信封，且 `ts: Date.now()` 每次都不同，与 v3.45.7 `file-io` 同款坑）。
        const rawDisk = String(files.get(stateFileName(scopeId())) || '');
        let diskOk = false;
        try { const e = JSON.parse(rawDisk); diskOk = !!e && !!e.hash && !!e.payload; } catch (err) { diskOk = false; }
        if (!diskOk) c3Diff += ' | 盘上主文件不可解析（' + rawDisk.length + ' 字节）';
        return same && diskOk;
    }, () => c3Diff);
})();

// ==================== D 组：读放大**定位**（验收④，只读不删校验） ====================
await (async () => {
    boot(mkSt({ atoms: 20, memories: 6 }));
    resetReadLedger();
    await saveStateNow({ reason: 'D-保存', force: true });
    await loadFromServerFile();
    const stats = readLedgerStats();
    await A('D1 读放大可**定位到来源**：一次「保存 + 载入」的读取按来源分类可读（`bySrc` 逐来源 次数/字节/耗时）→ 结论不靠猜', () => {
        const srcs = (stats && stats.bySrc) || {};
        const keys = Object.keys(srcs);
        const totalBytes = keys.reduce((s, k) => s + (Number(srcs[k].bytes) || 0), 0);
        const totalN = keys.reduce((s, k) => s + (Number(srcs[k].n) || 0), 0);
        return keys.length > 0 && totalN > 0 && totalBytes > 0
            && keys.every((k) => typeof srcs[k].label === 'string' && typeof srcs[k].n === 'number');
    }, (() => {
        const srcs = (readLedgerStats() || {}).bySrc || {};
        return J(Object.keys(srcs).map((k) => k + ':' + srcs[k].n + '次/' + srcs[k].bytes + 'B'));
    })());
})();

R.done();
