// 临时测量（用完即删）：数-31 ④「读放大先定位」—— 一次「保存 + 载入」的读取按来源分布
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import { readLedgerStats, resetReadLedger } from '../../core/read-ledger.js';
import { saveStateNow, loadFromServerFile, setStorageHooks, saveLedgerInfo } from '../../adapters/store.js';
import { resetShardMarks } from '../../adapters/shards.js';

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setContextProvider(() => makeHost({ chat: [] }).ctx);
const kv = new Map();
setStorageHooks({ getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => { kv.set(k, String(v)); return true; }, removeItem: (k) => { kv.delete(k); return true; } });
const files = new Map();
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') { const b = JSON.parse((opts && opts.body) || '{}'); files.set(String(b.name), Buffer.from(String(b.data || ''), 'base64').toString('utf8')); return { status: 200, text: 'ok' }; }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) { const n = decodeURIComponent(m[1]); return files.has(n) ? { status: 200, text: files.get(n) } : { status: 404, text: 'nf' }; }
    return { status: 404, text: '' };
});
setScopeKey('char:audit');
const st = emptyState();
st.atoms = [];
for (let i = 0; i < 200; i++) st.atoms.push({ id: 'a' + i, title: '情节' + i, text: '第 ' + i + ' 条情节正文（足够长，用于体积对比与读放大测量）。', date: '1919-11-29', tags: [], updatedAt: 1000 + i });
st.memories = [];
for (let i = 0; i < 60; i++) st.memories.push({ id: 'm' + i, owner: '甲', title: '记忆' + i, content: '记忆正文' + i + '（足够长）', updatedAt: 1000 + i });
setKernelState(st);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
resetShardMarks();

// 第一次保存（建基线）+ 载入
await saveStateNow({ reason: 'audit-1', force: true });
await loadFromServerFile();
resetReadLedger();
// 只改 1 条 → 保存 + 载入（测量这一次）
st.atoms[0].text += '！';
st.updatedAt = 9999;
const t0 = Date.now();
const r = await saveStateNow({ reason: 'audit-2' });
const saveMs = Date.now() - t0;
const t1 = Date.now();
await loadFromServerFile();
const loadMs = Date.now() - t1;
const stats = readLedgerStats();
const srcs = stats.bySrc || {};
const totalBytes = Object.keys(srcs).reduce((s, k) => s + (Number(srcs[k].bytes) || 0), 0);
console.log('=== 数-31 ④ 读放大定位（一次「只改 1 条 → 保存 + 载入」）===');
console.log('保存耗时 ' + saveMs + 'ms · 载入耗时 ' + loadMs + 'ms · 写入账本 totalBytes=' + ((saveLedgerInfo().last || {}).totalBytes) + 'B');
for (const k of Object.keys(srcs)) {
    const s = srcs[k];
    console.log('  ' + String(k).padEnd(10) + ' n=' + String(s.n).padStart(3) + '  ok=' + String(s.ok).padStart(3) + ' miss=' + String(s.miss).padStart(2)
        + ' bytes=' + String(s.bytes).padStart(8) + 'B  ' + (totalBytes ? Math.round(s.bytes * 100 / totalBytes) + '%' : '-') + '  ' + String(s.label || ''));
}
console.log('合计读取 ' + stats.totalReads + ' 次 / ' + totalBytes + 'B');
console.log('写入通道：' + ((saveLedgerInfo().last || {}).channels || []).map((c) => c.ch + '(' + c.writes + '写/' + c.bytes + 'B' + (c.skipped ? '/跳过' : '') + ')').join(' '));
