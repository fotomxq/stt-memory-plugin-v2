// ============================================================
// 单元测试 · v3.45.1（技-33）本机层「已停用旧路」的探测门 + 台账口径
//
// 设计来源：`docs/D29-实机取证发现与修复设计稿.md`
//   · §2 行 4（真机取证）：本机层**每次载入**都成对读失败 ——
//     `通道读取失败 · fft_v2_store-ftt2-local-<作用域>.json · 原因：miss`（平铺兜底名）与
//     `通道读取失败 · fft_v2_store/ftt2-local-<作用域>.json · 原因：miss`（旧命名空间同名文件）；
//     固定失败被计进「服务端文件 失败 N」，真失败被淹没。
//   · §3.2：本机层停止对已废弃命名空间路径的读探测（或在诊断中明确标为「旧路径 · 已停用 · 不参与判定」）。
//   · §6 R2（风险对策）：停探旧路径后**旧存档读不到** → 先只停「读判定」，**保留一次性迁移读取**；
//     回归用例必须覆盖「旧路径确有数据」的场景。
//
// 本文件锁住五条口径：
//   A1  旧路径确有数据 → 仍可载入（flat 兜底命中 / 旧命名空间命中），且**同会话每次载入都仍能命中**
//       （探测门只在「两条旧路全部未命中」后才置位，命中永不置位）；
//   A2  旧路全 miss → 第一次探测、第二次同 scope+path **不再探测**（请求计数不增长），返回 `legacySkipped:true`；
//   A3  两条旧路探测走 `noLedger` → **不写读取台账**（台账只多主名一条），由 `legacyProbes` 单独计数；
//       原生分支与酒馆文件分支都锁；
//   A4  `localFileDeprecatedPaths()` 如实列出平铺路 / 斜杠路 + `note`，`tried` 反映会话状态；
//   A5  主名命中时**完全不探测**旧路（零额外请求、`legacyProbes` 不增长）。
//
// 运行：node tests/unit/local-file-legacy-probe.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { readLedgerList, resetReadLedger } from '../../core/read-ledger.js';
import {
    localFileRead, localFileStatsReset, localFileStatsGet, localFileDeprecatedPaths, resetLocalFileLegacyProbe,
    localFileName, localFileFlatName, localFileNs, localFileNsLegacy,
} from '../../adapters/local-file.js';
import { resetFileTransportSession, fileTransportBackend, fileTransportUploadText } from '../../adapters/file-transport.js';
import { ttResetSession } from '../../adapters/tt-store.js';

const R = makeReporter('local-file-legacy-probe v3.45.1（技-33）已停用旧路：保留一次性迁移读取、退出判定与台账');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({ chat: [{ is_user: true, mes: '你好' }] }), doc);

// ---------- 酒馆用户目录文件通道桩（每次请求都记名 —— 用来证明「探测了几次」） ----------
const files = new Map();
let reqs = [];
async function memFetch(url) {
    const name = decodeURIComponent(String(url).replace(/^\/user\/files\//, ''));
    reqs.push(name);
    if (files.has(name)) return { status: 200, text: files.get(name) };
    return { status: 404, text: 'not found' };
}
const unFetch = installGlobalFetch(memFetch);

// ---------- 宿主原生存储桩（只为证明 `noLedger` 在**原生分支**同样生效） ----------
function makeTtHost() {
    const kv = new Map(); const blobs = new Map();
    const c = { tryGet: 0, set: 0, getBlob: 0 };
    const k = (a) => String(a.namespace) + '/' + String(a.table || 'main') + '/' + String(a.key);
    const store = {
        async setJson(a) { c.set++; kv.set(k(a), a.value); },
        async tryGetJson(a) { c.tryGet++; return kv.has(k(a)) ? { found: true, value: kv.get(k(a)) } : { found: false }; },
        async getJson(a) { if (!kv.has(k(a))) throw new Error('Not found: ' + k(a)); return kv.get(k(a)); },
        async deleteJson(a) { kv.delete(k(a)); },
        async listKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(kv.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
        async setBlob(a) { const d = a.data; blobs.set(k(a), (d instanceof Uint8Array) ? d : new Uint8Array(d || [])); },
        async getBlob(a) { c.getBlob++; if (!blobs.has(k(a))) throw new Error('Not found: ' + k(a)); return new Blob([blobs.get(k(a))]); },
        async deleteBlob(a) { blobs.delete(k(a)); },
        async listBlobKeys(a) { const p = String(a.namespace) + '/' + String(a.table || 'main') + '/'; return Array.from(blobs.keys()).filter((x) => x.indexOf(p) === 0).map((x) => x.slice(p.length)); },
    };
    return { abi: { abiVersion: 1, ready: Promise.resolve(true), api: { extension: { store: store } } }, store, kv, blobs, calls: c };
}

let host = null;
/** 复位环境：默认走酒馆用户目录文件通道（无宿主）；`native:true` 时装上 TauriTavern 原生存储桩 */
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.storage.localFilePath = (o.path === undefined) ? 'fft_v2_store' : String(o.path);
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    host = o.native ? makeTtHost() : null;
    if (host) { try { globalThis.window.__TAURITAVERN__ = host.abi; } catch (e) { /* 忽略 */ } }
    ttResetSession();
    resetFileTransportSession();
    // 探测门与三个计数器都复位（每个用例独立；`resetLocalFileLegacyProbe` 是生产代码里的测试钩子）
    resetLocalFileLegacyProbe();
    localFileStatsReset();
    resetReadLedger();
    files.clear();
    reqs = [];
    return host;
}

await A('A1 旧路径确有数据 → **仍可载入**：平铺兜底名命中（`ok:true` + `flat:true`），且同一会话后续读取仍能命中（摘门不因命中而置位 · `docs/D29` §6 R2）', async () => {
    boot({ path: 'fft_v2_store' });
    const scope = 'x';
    const flat = localFileFlatName(scope, 'fft_v2_store');
    files.set(flat, '{"payload":{"data":{"atoms":[{"id":"legacy-flat"}]}}}');
    const r1 = await localFileRead(scope, 'fft_v2_store');
    const r2 = await localFileRead(scope, 'fft_v2_store');
    const r3 = await localFileRead(scope, 'fft_v2_store');
    const d = localFileDeprecatedPaths(scope, 'fft_v2_store');
    return r1.ok === true && r1.flat === true && String(r1.text).indexOf('legacy-flat') > 0
        && r2.ok === true && r2.flat === true
        && r3.ok === true && r3.flat === true
        && d.tried === false                                   // 命中 → 永不置位
        && Number(d.hits) >= 3
        && reqs.filter((n) => n === flat).length === 3;         // 每次载入都真的去捞了旧路
}, () => ({ d: localFileDeprecatedPaths('x', 'fft_v2_store'), reqs: reqs.slice() }));

await A('A1b 旧命名空间确有数据 → 仍可载入（`legacyNs:true`）；同一会话后续读取仍能命中（原生分支 · v3.26.0 只读兼容回归）', async () => {
    const h = boot({ path: '记忆缓冲', native: true });
    const scope = 'x';
    const legacyNs = localFileNsLegacy('记忆缓冲');
    // 模拟 v3.16.0~v3.25.x 写下的旧命名空间数据（用**公开写路径**落到旧命名空间，保证键名归一一致）
    const w = await fileTransportUploadText(localFileName(scope, '记忆缓冲'),
        '{"payload":{"data":{"atoms":[{"id":"legacy-ns"}]}}}', { ns: legacyNs, table: 'local', stName: localFileName(scope, '记忆缓冲') });
    const r1 = await localFileRead(scope, '记忆缓冲');
    const r2 = await localFileRead(scope, '记忆缓冲');
    return fileTransportBackend() === 'tt-native' && w.ok === true && legacyNs !== localFileNs('记忆缓冲')
        && r1.ok === true && r1.legacyNs === true && String(r1.text).indexOf('legacy-ns') > 0
        && r2.ok === true && r2.legacyNs === true
        && localFileDeprecatedPaths(scope, '记忆缓冲').tried === false
        && Number(localFileDeprecatedPaths(scope, '记忆缓冲').hits) >= 2
        && h.calls.set >= 1;
}, () => ({ d: localFileDeprecatedPaths('x', '记忆缓冲'), ns: localFileNs('记忆缓冲'), legacy: localFileNsLegacy('记忆缓冲') }));

await A('A2 旧路全部 miss → 第一次会探测，第二次同一 scope+path **不再探测**（桩住的请求次数不再增长），并返回 `legacySkipped:true`', async () => {
    boot({ path: 'fft_v2_store' });
    const scope = 'x';
    const slash = localFileName(scope, 'fft_v2_store');
    const flat = localFileFlatName(scope, 'fft_v2_store');
    const r1 = await localFileRead(scope, 'fft_v2_store');
    const after1 = reqs.slice();
    const p1 = localFileDeprecatedPaths(scope, 'fft_v2_store').probes;
    const r2 = await localFileRead(scope, 'fft_v2_store');
    const after2 = reqs.slice();
    const d2 = localFileDeprecatedPaths(scope, 'fft_v2_store');
    return r1.ok === false && r1.miss === true && r1.legacySkipped === undefined
        && after1.length === 2 && after1[0] === slash && after1[1] === flat   // 第一次：主名 + 平铺旧路
        && after2.length === 3 && after2[2] === slash                        // 第二次：只剩主名（旧路已被摘门）
        && r2.ok === false && r2.miss === true && r2.legacySkipped === true
        && typeof r2.error === 'string' && r2.error.length > 0               // `error` 仍是普通字符串
        && d2.tried === true && Number(d2.probes) === Number(p1)             // 探测计数不再增长
        && Number(localFileStatsGet().legacyProbes) === Number(p1);
}, () => ({ reqs: reqs.slice(), d: localFileDeprecatedPaths('x', 'fft_v2_store'), st: localFileStatsGet() }));

await A('A3 两条旧路探测**不写读取台账**（`noLedger`）：台账只多主名一条，而 `legacyProbes` 两条都计数（酒馆文件分支）', async () => {
    boot({ path: '记忆缓冲' });                       // 该目录的旧命名空间与现行不同 → 两条旧路都在
    const scope = 'x';
    const ns = localFileNs('记忆缓冲');
    const legacyNs = localFileNsLegacy('记忆缓冲');
    const slash = localFileName(scope, '记忆缓冲');
    const flat = localFileFlatName(scope, '记忆缓冲');
    const r = await localFileRead(scope, '记忆缓冲');
    const list = readLedgerList();
    const d = localFileDeprecatedPaths(scope, '记忆缓冲');
    return ns !== legacyNs && r.ok === false && r.miss === true
        && list.length === 1                                         // 只有**主名**进了台账
        && list[0].target === slash && list[0].ok === false
        && list.every((x) => x.target !== flat)                      // 平铺旧路一条都没进
        && Number(d.probes) === 2 && Number(localFileStatsGet().legacyProbes) === 2
        && reqs.filter((n) => n === flat).length === 1               // 但**确实探测过**（只是不记台账）
        && reqs.filter((n) => n === slash).length === 2;             // 主名 + 旧命名空间同名路
}, () => ({ list: readLedgerList().map((x) => [x.target, x.action]), d: localFileDeprecatedPaths('x', '记忆缓冲'), reqs: reqs.slice() }));

await A('A3b 原生分支同样走 `noLedger`：旧路探测不写台账（主名仍每条一记）', async () => {
    boot({ path: '记忆缓冲', native: true });
    const scope = 'x';
    const slash = localFileName(scope, '记忆缓冲');
    const r = await localFileRead(scope, '记忆缓冲');
    const list = readLedgerList();
    const d = localFileDeprecatedPaths(scope, '记忆缓冲');
    return fileTransportBackend() === 'tt-native' && r.ok === false && r.miss === true
        && list.length === 1 && list[0].target === slash
        && Number(d.probes) === 2;
}, () => ({ list: readLedgerList().map((x) => x.target), d: localFileDeprecatedPaths('x', '记忆缓冲') }));

await A('A4 `localFileDeprecatedPaths()` 列出平铺路与斜杠路（带 `note`）；`tried` 随「旧路全 miss」的会话状态为 true', async () => {
    boot({ path: 'fft_v2_store' });
    const scope = 'x';
    const flat = 'fft_v2_store-ftt2-local-x.json';
    const slash = 'fft_v2_store/ftt2-local-x.json';
    const before = localFileDeprecatedPaths(scope, 'fft_v2_store');
    await localFileRead(scope, 'fft_v2_store');                       // 旧路全 miss → 置位
    const after = localFileDeprecatedPaths(scope, 'fft_v2_store');
    return before.tried === false && after.tried === true
        && flat === localFileFlatName(scope, 'fft_v2_store') && slash === localFileName(scope, 'fft_v2_store')
        && after.names.indexOf(flat) >= 0 && after.names.indexOf(slash) >= 0
        && after.ns === 'fft_v2_store' && after.legacyNs === 'fft_v2_store'
        && String(after.note).indexOf('旧路径') >= 0
        && String(after.note).indexOf('停用') > 0
        && String(after.note).indexOf('不参与判定') > 0
        && String(after.note).indexOf('一次性迁移读取') > 0
        && Number(after.probes) >= 1;
}, () => ({ d: localFileDeprecatedPaths('x', 'fft_v2_store') }));

await A('A5 主名命中时**完全不探测**旧路：零额外请求、`legacyProbes` / `legacyHits` 都不增长', async () => {
    boot({ path: 'fft_v2_store' });
    const scope = 'x';
    const slash = localFileName(scope, 'fft_v2_store');
    files.set(slash, '{"payload":{"data":{"atoms":[{"id":"primary"}]}}}');
    const p0 = localFileDeprecatedPaths(scope, 'fft_v2_store');
    const r = await localFileRead(scope, 'fft_v2_store');
    const d = localFileDeprecatedPaths(scope, 'fft_v2_store');
    return r.ok === true && r.flat === undefined && r.legacyNs === undefined
        && String(r.text).indexOf('primary') > 0
        && reqs.length === 1 && reqs[0] === slash                   // 只有主名那一次请求
        && Number(d.probes) === Number(p0.probes) && Number(d.hits) === 0
        && d.tried === false
        && Number(localFileStatsGet().legacyProbes) === Number(p0.probes);
}, () => ({ reqs: reqs.slice(), d: localFileDeprecatedPaths('x', 'fft_v2_store') }));

unFetch();
unHost();
R.done();
