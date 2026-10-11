// ============================================================
// 单元测试 · v3.45.1（`docs/D22` §4.7 W6 **W6** · `数-28` · 台账 U176）
//   **本地快照分片与链长一致** —— 写入后按「当前链指纹集合」回收不属于当前链的派生分片。
//
// 真机事实（`docs/D29` §2 第 7 行）：`parts.snapshots = {count 28, files 28}` 而内存链长 `snapshots = 27`；
//   更早时点出现 `files 39` 对链长 25 —— 本地目录留着**不再属于当前链**的分片文件，
//   「还原口径」（清单里的链）与「体积/文件口径」（目录里实际几个文件）长期不一致。
//
// 本文件的护栏（逐条对应 `docs/D29` §5 R3 / §6 Q4 与 `docs/D22` 的验收）：
//   · 链变短 → 陈旧分片被回收；
//   · **仍被引用的文件绝不删**（改名副本也要保住）；不是我们写的文件绝不删；日志类绝不碰（Q4）；
//   · 链为空 / 本次写盘不完整 → 一个文件都不删（宁可回到堆积，也不误删）；
//   · 读数字段把「链」与「文件」的差异来源写清楚（`files` 含 `manifest.json` 索引；
//     读回侧只数清单 order 里的条目文件；`staleFiles` 就是不一致的来源）；
//   · 链级指纹复用**仓库既有**定义（`core/cross-sync.js#snapshotSigOf`），不新造第二种。
//
// 运行：node tests/unit/shard-recycle.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost, makeOpfs, installGlobalOpfs } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    localDiskWriteParts, localDiskReadParts, localDiskRecycleSnapParts, localDiskReset,
} from '../../adapters/local-disk.js';
import { browserFsWrite, browserFsReset } from '../../adapters/browser-fs.js';
import { snapshotSigOf } from '../../core/cross-sync.js';

const R = makeReporter('shard-recycle v3.45.1 W6 数-28 本地快照分片与链长一致（按当前链指纹集合回收）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e));
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
let uninstallOpfs = () => { };

/** 假 OPFS 环境（纯浏览器路径：`@browser/<目录名>`）+ 本机配置指向它 */
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '@browser/store' });
    setScopeKey('char:recycle');
    setLastMessageId(-1);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(emptyState());
    localDiskReset();
    browserFsReset();
    try { uninstallOpfs(); } catch (e) { /* 忽略 */ }
    const opfs = makeOpfs();
    uninstallOpfs = installGlobalOpfs(opfs);
    return opfs;
}
/** OPFS 里的相对路径前缀（`@browser/store` → `store`；scope `default`） */
const SNAP_DIR = 'store/default/snapshots';
const LOG_DIR = 'store/default/logs';
const snap = (id, ts) => ({ id: id, kind: 'incr', ts: ts, atomsHashes: { a1: 'h1' }, data: { atoms: [] } });

const opfs = boot();
const S3 = [snap('s1', '2026-10-01T00:00:00Z'), snap('s2', '2026-10-02T00:00:00Z'), snap('s3', '2026-10-03T00:00:00Z')];
const S2 = [snap('s1', '2026-10-01T00:00:00Z'), snap('s2', '2026-10-02T00:00:00Z')];
const namesIn = (dir) => opfs.files().filter((p) => p.indexOf(dir + '/') === 0).map((p) => p.slice(dir.length + 1));

// ============================================================
// A 组：写入 + 链变短 → 回收陈旧分片
// ============================================================
await (async () => {
    const w3 = await localDiskWriteParts('snapshots', S3, 'default', {});
    const r3 = await localDiskReadParts('snapshots', 'default');
    A('A1 写 3 条链：目录 = 3 个条目文件 + 1 个 manifest 索引；**读数字段说明差异来源**（读回 files 不含索引）', (() => {
        const names = namesIn(SNAP_DIR).sort();
        return w3.ok === true && w3.count === 3 && w3.files === 4 && w3.dataFiles === 3
            && J(names) === J(['manifest.json', 's1.json', 's2.json', 's3.json'])
            && r3.ok === true && r3.count === 3 && r3.chain === 3 && Object.keys(r3.files).length === 3 && r3.dataFiles === 3
            && r3.staleFiles === 0
            && String(w3.note).indexOf('manifest.json') > 0 && String(r3.note).indexOf('staleFiles=0') > 0
            && w3.stale === 0;
    })(), () => ({ w3: w3, r3: r3, names: namesIn(SNAP_DIR) }));

    // 手造三类「不该删」的旁证文件：改名副本（内容仍被链引用）/ 非快照 JSON / 非分片命名
    await browserFsWrite(SNAP_DIR + '/copy_of_s1.json', JSON.stringify(S3[0]));
    await browserFsWrite(SNAP_DIR + '/notes.json', JSON.stringify({ note: 1 }));
    await browserFsWrite(SNAP_DIR + '/readme.txt', 'user file, not ours');
})();

await (async () => {
    // 链变短：s3 不再属于当前链 → 必须被回收；三个旁证文件必须原样留下
    const w2 = await localDiskWriteParts('snapshots', S2, 'default', {});
    const rc = w2.recycle || {};
    const r2 = await localDiskReadParts('snapshots', 'default');
    const skip = {};
    for (const s of (rc.skipped || [])) skip[s.name] = s.reason;
    const names = namesIn(SNAP_DIR).sort();
    A('A2 链变短（3→2）：**陈旧分片被回收**、清单同步收紧、仍被引用的/别人的文件**一个不删**（逐个比对后如实报原因）', (() => {
        return w2.ok === true && rc.ok === true && J(rc.removed) === J(['s3.json'])
            && names.indexOf('s3.json') < 0
            && names.indexOf('manifest.json') >= 0 && names.indexOf('s1.json') >= 0 && names.indexOf('s2.json') >= 0
            && names.indexOf('copy_of_s1.json') >= 0 && names.indexOf('notes.json') >= 0 && names.indexOf('readme.txt') >= 0
            && skip['copy_of_s1.json'] === 'still-referenced'
            && skip['notes.json'] === 'not-snapshot-part'
            && skip['readme.txt'] === 'not-part-name'
            && r2.ok === true && r2.count === 2 && Object.keys(r2.files).length === 2 && r2.dataFiles === 2 && r2.staleFiles === 2;   // 两个多出来的 .json（readme.txt 不是分片命名）
    })(), () => ({ w2: w2, skip: skip, names: namesIn(SNAP_DIR), r2: r2 }));

    A('A3 链级指纹复用**仓库既有定义**：`recycle.chainSig === snapshotSigOf(当前链)`（不新造第二种指纹）', (() => {
        return String(rc.chainSig).length > 2 && rc.chainSig === snapshotSigOf(S2) && rc.chainSig !== snapshotSigOf(S3);
    })(), () => ({ got: rc.chainSig, want: snapshotSigOf(S2) }));
})();

// ============================================================
// B 组：范围与闸门
// ============================================================
await (async () => {
    // Q4：只回收快照分片；日志类派生文件**本项不碰**
    const logs = [
        { at: 1791300000000, tag: '存储', msg: '甲' },
        { at: 1791300000001, tag: '存储', msg: '乙' },
    ];
    const wl = await localDiskWriteParts('logs', logs, 'default', { kind: 'debug', cap: 500 });
    const before = namesIn(LOG_DIR).sort();
    const w2b = await localDiskWriteParts('snapshots', S2, 'default', {});   // 再写一次快照（可能触发回收核对）
    const after = namesIn(LOG_DIR).sort();
    A('B1 Q4 范围守卫：**日志类派生文件不参与回收**（`logs/` 一个字节不动），回收只在 `snapshots/` 内发生', (() => {
        return wl.ok === true && before.length >= 2 && J(before) === J(after)
            && after.indexOf('manifest.json') >= 0 && after.some((n) => /^debug-\d{4}-\d{2}-\d{2}\.json$/.test(n))
            && (w2b.recycle || {}).ok === true;
    })(), () => ({ before: before, after: after, w2b: w2b }));
})();

await (async () => {
    // 闸门①：链为空 → 一个文件都不删（宁可回到堆积）
    await browserFsWrite(SNAP_DIR + '/s9.json', JSON.stringify(snap('s9', '2026-10-09T00:00:00Z')));
    const r1 = await localDiskRecycleSnapParts('default', { dir: '@browser/store/default/snapshots', manifest: { count: 0, order: [], parts: {} }, snapList: [], written: true });
    // 闸门②：本次写盘不完整（清单没写成）→ 不删（盘上清单仍指向旧链，删了就破坏还原）
    const r2 = await localDiskRecycleSnapParts('default', { dir: '@browser/store/default/snapshots', manifest: { count: 2, order: ['s1.json', 's2.json'], parts: {} }, snapList: S2, written: false });
    const names = namesIn(SNAP_DIR).sort();
    A('B2 保守闸门：**链为空** / **本次写盘不完整** → 都不删（如实报 `empty-chain` / `write-incomplete`），文件原样留着', (() => {
        return r1.ok === false && r1.reason === 'empty-chain' && r1.removed.length === 0
            && r2.ok === false && r2.reason === 'write-incomplete' && r2.removed.length === 0
            && names.indexOf('s9.json') >= 0;
    })(), () => ({ r1: r1, r2: r2, names: namesIn(SNAP_DIR) }));
    await browserFsWrite(SNAP_DIR + '/s9.json', '');   // （清空内容，下面 A7 幂等用例单独 boot）
})();

await (async () => {
    // 幂等 / 短路：同一条链再写一次 → 不必再列目录核对（链指纹未变）
    const opfs2 = boot();
    const w1 = await localDiskWriteParts('snapshots', S3, 'default', {});
    const w2 = await localDiskWriteParts('snapshots', S3, 'default', {});
    const names = opfs2.files().filter((p) => p.indexOf(SNAP_DIR + '/') === 0);
    A('B3 幂等与短路：同一条链重复写盘 → 第二次不再列目录核对（`reason:"unchanged"`）、不重复删；目录内容与链一致', (() => {
        const rc1 = w1.recycle || {};
        const rc2 = w2.recycle || {};
        return rc1.ok === true && rc1.reason === '' && rc2.ok === true && rc2.reason === 'unchanged'
            && rc2.removed.length === 0
            && names.length === 4 && names.filter((p) => /\/s\d\.json$/.test(p)).length === 3;
    })(), () => ({ w1: w1.recycle, w2: w2.recycle, names: opfs2.files() }));
})();

try { uninstallOpfs(); } catch (e) { /* 忽略 */ }

// ============================================================
// C 组：第二条后端（宿主 `api.dev.files` 形态）上的回收也要真的落地
//   —— 这一组同时守住 v3.45.1 给 `diskRemove` 补的 dev-api 删除路由：
//     少了它，这类宿主上回收只会报 `remove-failed`（陈旧分片永远清不掉）。
// ============================================================
/** 假宿主：`api.dev.files`（读写 + 列目录 + 删除），与 tests/unit/local-disk.test.js 的桩同形 */
function makeDevHost() {
    const disk = new Map();
    const sep = (p) => String(p).replace(/\//g, '\\');
    const files = {
        async writeTextFile(a) { disk.set(sep(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
        async readTextFile(a) { const k = sep(a.path); if (!disk.has(k)) throw new Error('ENOENT: ' + k); return { text: disk.get(k) }; },
        async readDir(a) {
            const p = sep(a.path);
            const out = [];
            for (const k of disk.keys()) {
                if (k.indexOf(p + '\\') !== 0) continue;
                const rest = k.slice(p.length + 1);
                if (rest && rest.indexOf('\\') < 0) out.push({ name: rest, isFile: true, size: 0 });
            }
            return out;
        },
        async removeFile(a) { return { ok: disk.delete(sep(a.path)) }; },
    };
    return { abi: { abiVersion: 1, ready: Promise.resolve(true), api: { dev: { files: files }, extension: { store: {} } } }, disk: disk };
}
await (async () => {
    const h = makeDevHost();
    try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ }
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'D:\\FTT\\store' });
    localDiskReset();
    const w3 = await localDiskWriteParts('snapshots', S3, 'default', {});
    const w2 = await localDiskWriteParts('snapshots', S2, 'default', {});   // 链变短 → 回收
    const keys = Array.from(h.disk.keys()).map((k) => k.replace('D:\\FTT\\store\\default\\snapshots\\', ''));
    A('C1 宿主 `api.dev` 后端上的回收同样真实生效：陈旧分片被删、当前链与清单都在（`diskRemove` 的 dev-api 路由是这条路径的前提）', (() => {
        return w3.ok === true && w2.ok === true
            && J((w2.recycle || {}).removed) === J(['s3.json'])
            && keys.indexOf('s3.json') < 0 && keys.indexOf('s1.json') >= 0 && keys.indexOf('s2.json') >= 0
            && keys.indexOf('manifest.json') >= 0;
    })(), () => ({ w2: w2, keys: keys }));
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    localDiskReset();
})();

R.done();
