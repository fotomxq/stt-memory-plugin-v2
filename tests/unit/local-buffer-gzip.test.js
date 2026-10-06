// ============================================================
// 单元测试 · v3.26.2「本机缓冲超预算」修复 —— 压缩留存 + 停滞如实告知
//
// 用户报告（原话）：「新版本 修复错误：保存：本机缓冲超预算 → 本次跳过（服务端文件与 IndexedDB 不受影响）
//   {"chars":1994370,"budget":1800000} 该问题会造成数据异常，请核对解决思路，或在本地存储中用更好的方法留存数据。」
//
// 事实与思路：
//   · 本机缓冲是**本机层的兜底副本**；一旦超预算就整层停更 → 本机只剩 IndexedDB + 服务端，
//     「换设备 / 服务端读失败」时看到的是**旧副本**（观感即「数据回退」）；
//   · v3.26.2 起：明文超过 `LOCAL_BUFFER_GZ_MIN_CHARS`（或超过预算）→ **gzip → base64 压缩记录**
//     `{"ftt2gz":1,…}`（实测压缩比 ≈ 10~30×，2M 字符 → 几十~几百 KB）→ 「超预算」在正常体量下不再发生；
//   · 压缩记录读侧：明文仍走**同步**路径（零额外微任务），压缩记录多一次 `await` 解压，校验口径一致；
//   · 仍然装不下（内容不可压 / 预算被调得极小）或宿主不支持压缩 → **如实跳过** + 一次性可操作提示
//     （去设「本机缓冲目录」）+ **停滞标记**（下次启动能如实说「本机层自何时起未更新」）。
// 运行：node tests/unit/local-buffer-gzip.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { stateFileName } from '../../adapters/user-file.js';
import {
    setStorageHooks, saveStateNow, loadFromLocalStorage, loadFromLocalStorageGz, localBufferGzPending,
    localBufferState, localBufferStats, setLocalBufferMaxChars, invalidateLocalBufferCache,
    isLocalGzRecord, inflateLocalGzRecord, localStaleInfo, resetLocalSkipHint, localCopyStats, LOCAL_BUFFER_GZ_MIN_CHARS,
} from '../../adapters/store.js';
import { gzipAvailable } from '../../adapters/gzip.js';

const R = makeReporter('local-buffer-gzip v3.26.2 本机缓冲压缩留存（超预算不再丢本机层）');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
host.ctx.characters = [{ name: '缓冲测试', avatar: 'gzbuf.png' }];
host.ctx.characterId = 0;
setContextProvider(() => host.ctx);
installGlobalHost(host, doc);
const unFetch = installGlobalFetch((url, opts) => {
    // 服务端文件通道桩（与冒烟同口径）：**超预算跳过本机层时，服务端文件必须照写**
    if (String(url) === '/api/files/upload') {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        try { srvFiles.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8')); } catch (e) { /* 忽略 */ }
        return { status: 200, text: 'ok' };
    }
    if (String(url) === '/api/files/delete') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        const p = String((body && body.path) || '').replace(/^\/user\/files\//, '');
        if (p) srvFiles.delete(p);
        return { status: 200, text: 'ok' };
    }
    if (String(url).indexOf('/user/files/') === 0) {
        const name = decodeURIComponent(String(url).slice('/user/files/'.length));
        return srvFiles.has(name) ? { status: 200, text: srvFiles.get(name) } : { status: 404, body: {} };
    }
    return { status: 404, text: '' };
});
const srvFiles = new Map();

/** 可压缩的大正文（重复段落 → gzip 压缩比高，模拟真实存档里的重复结构） */
const bigText = (n) => ('甲在码头清点木箱并登记入册，乙在旁边核对账册。'.repeat(40) + '\n').repeat(Math.max(1, Number(n) || 1));

const kv = new Map();
const toasts = [];
let saved = null;

function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:gzbuf');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setNotifyHooks({ toast: (msg, kind) => { toasts.push([String(kind || ''), String(msg || '')]); }, notify: () => undefined });
    setLastMessageId(0);
    kv.clear();
    toasts.length = 0;
    setStorageHooks({
        getItem: (k) => (kv.has(k) ? kv.get(k) : null),
        setItem: (k, v) => { if (o.setItemFail) return false; kv.set(k, String(v)); return true; },
        removeItem: (k) => { kv.delete(k); return true; },
        keys: () => Array.from(kv.keys()),
    });
    localBufferSetAtomic(o);
    resetLocalSkipHint();
    setLocalBufferMaxChars(Number(o.maxChars) || 0);
    invalidateLocalBufferCache();
    // 大状态：atoms 里放可压缩的长正文
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < 20; i++) {
        st.atoms.push({ id: 'gzbuf-a' + i, title: '情节' + i, text: bigText(6), tags: ['码头'], floorStart: i, floorEnd: i });
    }
    setKernelState(st);
    return kv;
}
/** 便于测试在 boot 之内设置「等值跳过」等开关（保持签名整洁） */
function localBufferSetAtomic() { /* 预留：当前无需额外状态 */ }

const key = () => 'ftt2_state_' + scopeId();
const stored = () => String(kv.get(key()) || '');

// ============================================================
const gzOk = (() => { try { return gzipAvailable(); } catch (e) { return false; } })();

await A('A1 压缩留存：大状态保存后本机记录是**压缩记录**（`via` 含 `localStorage-gz`），存储体积远小于明文', async () => {
    if (!gzOk) return true;                                   // 宿主无 CompressionStream → 由 A4 覆盖
    boot({});
    const r = await saveStateNow({ force: true });
    const st = localBufferState();
    const plain = st.chars;
    const storedChars = stored().length;
    return r.ok !== false && String(r.via).indexOf('localStorage-gz') >= 0
        && isLocalGzRecord(stored()) === true && st.ok === true && st.gz === true
        && plain >= LOCAL_BUFFER_GZ_MIN_CHARS && storedChars < plain / 2
        && localBufferStats().gzipWrites >= 1;
}, () => ({ stored: stored().slice(0, 40), state: localBufferState() }));

await A('A2 读路径：明文走同步（压缩记录时同步返回 null 且**不误报信封损坏**）；异步 `loadFromLocalStorageGz()` 解压后与写入内容一致', async () => {
    if (!gzOk) return true;
    boot({});
    await saveStateNow({ force: true });
    const sync = loadFromLocalStorage();                       // 压缩记录 → 同步路径如实让路
    const pending = localBufferGzPending();
    const st = await loadFromLocalStorageGz();
    const want = (() => { try { return JSON.parse(stored()); } catch (e) { return null; } })();
    return sync === null && pending === true && !!st && Number(want && want.chars) > 0
        && Array.isArray(st.atoms) && st.atoms.length === 20
        && String(st.atoms[0].text).length > 100
        && localBufferStats().gzipReads >= 1;
}, () => ({ pending: localBufferGzPending(), items: null }));

await A('A3 超预算不再丢本机层：预算压到明文之下 → **压缩留存**（`overBudget` 不增长、记录可读回）', async () => {
    if (!gzOk) return true;
    boot({});
    await saveStateNow({ force: true });
    const plainChars = localBufferState().chars;
    boot({ maxChars: Math.max(2000, Math.floor(plainChars / 4)) });   // 明文装不下、压缩后装得下
    const over0 = localBufferStats().overBudget;
    const r = await saveStateNow({ force: true });
    const st = localBufferState();
    const back = await loadFromLocalStorageGz();
    return r.ok !== false && st.gz === true && st.ok === true && isLocalGzRecord(stored()) === true
        && stored().length <= st.budget && localBufferStats().overBudget === over0
        && !!back && back.atoms.length === 20 && localStaleInfo() === null;
}, () => ({ st: localBufferState(), over: localBufferStats().overBudget }));

await A('A4 压缩不可用（或压完仍装不下）→ **如实跳过** + 停滞标记 + 一次性可操作提示（服务端与内存库不受影响）', async () => {
    boot({ maxChars: 900 });
    const keepCS = globalThis.CompressionStream;
    try { delete globalThis.CompressionStream; } catch (e) { globalThis.CompressionStream = undefined; }
    let r = null; let st = null;
    try {
        r = await saveStateNow({ force: true });
        st = localBufferState();
    } finally { try { globalThis.CompressionStream = keepCS; } catch (e) { /* 忽略 */ } }
    const stale = localStaleInfo();
    const hint = toasts.filter((t) => t[1].indexOf('本机缓冲目录') > 0);
    return st && st.ok === false && st.skipped === 'over-budget' && st.chars > st.budget
        && String(r.via).indexOf('localStorage') < 0 && String(r.via).indexOf('file') >= 0
        && !!stale && Number(stale.at) > 0 && Number(stale.chars) > Number(stale.budget)
        && hint.length === 1 && localBufferStats().gzUnavailable >= 1;
}, () => ({ st: localBufferState(), stale: localStaleInfo(), toasts: toasts.slice(0, 2) }));

await A('A5 停滞标记生命周期：任何一次成功写入即清除（本机层重新跟上 → 面板不再显示「未更新」）', async () => {
    boot({ maxChars: 900 });
    const keepCS = globalThis.CompressionStream;
    try { delete globalThis.CompressionStream; } catch (e) { globalThis.CompressionStream = undefined; }
    try { await saveStateNow({ force: true }); } finally { try { globalThis.CompressionStream = keepCS; } catch (e) { /* 忽略 */ } }
    const marked = !!localStaleInfo();
    setLocalBufferMaxChars(0);
    const r = await saveStateNow({ force: true });                 // 预算恢复 → 成功写入
    return marked === true && r.ok !== false && localStaleInfo() === null && localBufferState().ok === true;
}, () => ({ stale: localStaleInfo() }));

await A('A6 明文向后兼容：小状态仍写**明文信封**、同步读回一致（零额外微任务路径不变）', async () => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:gzbufsmall');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setNotifyHooks({ toast: () => undefined, notify: () => undefined });
    kv.clear();
    setStorageHooks({ getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => { kv.set(k, String(v)); return true; }, removeItem: (k) => { kv.delete(k); return true; }, keys: () => Array.from(kv.keys()) });
    setLocalBufferMaxChars(0);
    invalidateLocalBufferCache();
    const st0 = emptyState();
    st0.atoms = [{ id: 'small-1', title: '小', text: '短正文。', tags: [] }];
    setKernelState(st0);
    const r = await saveStateNow({ force: true });
    const raw = String(kv.get('ftt2_state_' + scopeId()) || '');
    const back = loadFromLocalStorage();
    return r.ok !== false && raw.indexOf('"ftt2gz"') < 0 && isLocalGzRecord(raw) === false
        && localBufferGzPending() === false && !!back && (back.atoms || []).length === 1
        && String(r.via).indexOf('localStorage-gz') < 0;
}, () => ({ rawHead: stored().slice(0, 30) }));

await A('A7 `inflateLocalGzRecord`：压缩记录能解回明文；非压缩记录 / 坏 base64 → 空串（不抛）', async () => {
    if (!gzOk) return true;
    boot({});
    await saveStateNow({ force: true });
    const text = await inflateLocalGzRecord(stored());
    const bogus = await inflateLocalGzRecord('{"ftt2gz":1,"chars":9,"b64":"!!!not-base64!!!"}');
    return text.indexOf('"payload"') > 0 && text.length > 1000 && bogus === '' && (await inflateLocalGzRecord('{"v":1}')) === '';
}, () => ({ }));

await A('A8 `localCopyStats()` 对压缩记录仍给出信封时间与条数（面板不显示 0）', async () => {
    if (!gzOk) return true;
    boot({});
    await saveStateNow({ force: true });
    const c = await localCopyStats();
    return c.local.gz === true && Number(c.local.updatedAt) > 0 && Number(c.local.items) >= 20
        && c.local.present === true && Number(c.budget) > 0;
}, () => ({ }));

unFetch();
R.done();
