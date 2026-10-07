// ============================================================
// 单元测试 · v3.28.0「**本地磁盘目录**」= 替代浏览器本地存储的真磁盘路径
//
// 用户纠正（原话）：「理解错误了，本地存储指替代浏览器变量、内存等本地数据存储方式，而不是指服务端的存储路径。
//   请修复该错误设计。」
//
// 口径（`adapters/local-disk.js`）：
//   · **路径保留原样**（不像「服务端扩展存储命名空间」那样剥盘符 / 折叠多级）；只去尾部分隔符；
//   · 能力探测：① `api.dev` 的文件类命名空间（按关键字发现 write/read 方法）；② Tauri 原始桥 fs 插件；
//     ③ 都没有 → 如实回报「宿主不提供写任意磁盘路径的接口」，**绝不假装成功**；
//   · 每次真实写入都要**写 → 回读逐字节校验**；校验不过不算成功；
//   · 写盘失败**不回退**浏览器层（浏览器变量 / 内存库保持停用）。
//
// 运行：node tests/unit/local-disk.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import {
    localDiskRaw, localDiskOn, localDiskPathKind, localDiskPathNorm, localDiskJoin,
    localDiskCapability, localDiskWrite, localDiskRead, localDiskProbeDir, localDiskInfo, localDiskReset,
    localDiskWriteParts, localDiskReadParts,
    localDiskPlatform, localDiskPlatformLabel, localDiskPathWarn, localDiskDirCandidates, localDiskPickDir,
} from '../../adapters/local-disk.js';

const R = makeReporter('local-disk v3.28.0 本地磁盘目录（替代浏览器本地存储）');
let diskCandDbg = null, lastPickDbg = null;   // A9/A11 现场（失败时打出来）
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, (typeof x === 'function') ? x() : x); };
const J = (v) => JSON.stringify(v);

/** 宿主桩：一个假的 `api.dev.files`（内存盘 + 记录调用） */
function makeDevHost() {
    const disk = new Map();
    const calls = [];
    const files = {
        async writeTextFile(a) { calls.push({ m: 'write', a: a }); disk.set(String(a.path), String(a.text != null ? a.text : a.content)); return { ok: true }; },
        async readTextFile(a) { const k = String(a.path); if (!disk.has(k)) throw new Error('ENOENT: ' + k); return { text: disk.get(k) }; },
    };
    const abi = { abiVersion: 1, ready: Promise.resolve(true), api: { dev: { files: files, backendLogs: { tail: async () => ({}) } }, extension: { store: {} } } };
    return { abi, disk, calls, files };
}
function useHost(h) {
    const out = h || null;
    try { delete globalThis.window.__TAURITAVERN__; } catch (e) { /* 忽略 */ }
    try { delete globalThis.window.__TAURI_INTERNALS__; } catch (e) { /* 忽略 */ }
    if (h) { try { globalThis.window.__TAURITAVERN__ = h.abi; } catch (e) { /* 忽略 */ } }
    localDiskReset();
    return out;
}
function boot(storage) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.storage = Object.assign({}, cfg.storage, storage || {});
    try { if (!globalThis.window) globalThis.window = {}; } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------
await A('A1 路径形态与归一：**保留真磁盘路径原样**（只去尾部分隔符）—— 与服务端命名空间的归一规则完全相反', async () => {
    boot({ localDiskDir: 'D:\\Downloads\\stn\\fft_v2_store\\' });
    const raw = localDiskRaw();
    return localDiskOn() === true
        && raw === 'D:\\Downloads\\stn\\fft_v2_store'
        && localDiskPathKind('D:\\FTT\\store') === 'windows-abs'
        && localDiskPathKind('\\\\srv\\share\\x') === 'unc'
        && localDiskPathKind('/mnt/store') === 'posix-abs'
        && localDiskPathKind('相对/目录') === 'relative'
        && localDiskPathKind('') === 'empty'
        && localDiskPathNorm('D:\\FTT\\store\\') === 'D:\\FTT\\store'
        && localDiskJoin('D:\\FTT\\store', '子\\a.json') === 'D:\\FTT\\store\\子\\a.json'
        && localDiskJoin('/mnt/store', 'a.json') === '/mnt/store/a.json';
}, () => ({ raw: localDiskRaw(), info: localDiskInfo() }));

await A('A2 能力探测：`api.dev` 下按关键字发现「文件类命名空间 + write/read 方法」→ 判定可写盘；没有 → 如实回报不可用（不假装）', async () => {
    useHost(makeDevHost());
    boot({ localDiskDir: 'D:\\FTT\\store' });
    const cap = localDiskCapability(true);
    const okCap = cap.ok === true && cap.mechanism === 'dev-api' && cap.ns === 'files'
        && cap.writeMethod === 'writeTextFile' && cap.readMethod === 'readTextFile';
    useHost(null);
    boot({ localDiskDir: 'D:\\FTT\\store' });
    const cap2 = localDiskCapability(true);
    return okCap && cap2.ok === false && String(cap2.note).indexOf('未提供') > 0;
}, () => ({ cap: localDiskCapability(true) }));

await A('A3 写入即校验：写盘 → **回读逐字节比对** → 通过才算成功；读回不一致/读不到 → 如实失败且不记账为成功', async () => {
    const h = useHost(makeDevHost());
    boot({ localDiskDir: 'D:\\FTT\\store' });
    const w = await localDiskWrite('a.json', '{"x":1}');
    const r = await localDiskRead('a.json');
    // 篡改 disk：写入成功但读回被改 → 校验必须失败
    h.files.readTextFile = async (a) => ({ text: 'TAMPERED' });
    const w2 = await localDiskWrite('b.json', '{"y":2}');
    const info = localDiskInfo();
    return w.ok === true && String(w.path) === 'D:\\FTT\\store\\a.json' && Number(w.bytes) === 7
        && r.ok === true && r.text === '{"x":1}'
        && w2.ok === false && String(w2.reason || w2.error).indexOf('verify') >= 0
        && Number(info.stats.writes) === 1 && Number(info.stats.failures) >= 1;
}, () => ({ info: localDiskInfo() }));

await A('A4 目录探针：写 → 回读 → 通过即 `ok`，并回报真实文件路径与机制；空路径 / 不可写如实失败', async () => {
    useHost(makeDevHost());
    boot({ localDiskDir: '' });
    const empty = await localDiskProbeDir('   ');
    const ok = await localDiskProbeDir('D:\\FTT\\store');
    useHost(null);
    boot({ localDiskDir: '' });
    const noCap = await localDiskProbeDir('D:\\FTT\\store');
    return empty.ok === false && empty.error === 'empty'
        && ok.ok === true && ok.mechanism === 'dev-api' && String(ok.path).indexOf('ftt2-local-probe.json') > 0
        && noCap.ok === false && String(noCap.error).length > 0;
}, () => ({ info: localDiskInfo() }));

await A('A5 只读状态：目录 / 能力 / 机制 / 统计齐全（UI 与诊断同源）', async () => {
    useHost(makeDevHost());
    boot({ localDiskDir: 'D:\\FTT\\store' });
    await localDiskWrite('c.json', 'x');
    const info = localDiskInfo();
    return info.enabled === true && info.dir === 'D:\\FTT\\store' && info.kind === 'windows-abs'
        && info.capability.ok === true && info.capability.mechanism === 'dev-api'
        && J(info.capability.devKeys).indexOf('files') > 0
        && Number(info.stats.writes) === 1 && Number(info.stats.lastBytes) === 1;
}, () => ({ info: localDiskInfo() }));

// ------------------------------------------------------------
// v3.32.0（用户要求「快照 / 日志也拆分结构化存储」）：写回读**往返**
await A('A6 快照 / 日志结构化拆分：逐条 / 按天上文件 + 清单，**回读按清单校验 hash** 后逐字还原来路', async () => {
    const h = useHost(makeDevHost());
    boot({ localDiskDir: 'D:\\FTT\\store' });
    const snaps = [
        { id: 's1', kind: 'auto', ts: '2026-10-06T10:00:00Z', atomsHashes: { a1: 'h1' }, data: { atoms: [] } },
        { id: 's2', kind: 'manual', ts: '2026-10-06T11:00:00Z', atomsHashes: {}, data: { atoms: [] } },
    ];
    const logs = [
        { at: 1791300000000, tag: '存储', msg: '甲' },     // 同一天 3 条（cap=2 → 当天再切一片 `-2`）
        { at: 1791300000001, tag: '存储', msg: '乙' },
        { at: 1791300000002, tag: '存储', msg: '丙' },
        { at: 1791472800000, tag: '同步', msg: '丁' },     // 另一天
    ];
    const ws = await localDiskWriteParts('snapshots', snaps, 'default', {});
    const wl = await localDiskWriteParts('logs', logs, 'default', { kind: 'debug', cap: 2 });
    const rs = await localDiskReadParts('snapshots', 'default');
    const rl = await localDiskReadParts('logs', 'default');
    const keys = Array.from(h.disk.keys()).map((x) => x.replace('D:\\FTT\\store\\', ''));
    const logFiles = keys.filter((k) => k.indexOf('default\\logs\\debug-') === 0);
    return ws.ok === true && ws.count === 2 && ws.files === 3
        && wl.ok === true && wl.count === 4
        && keys.indexOf('default\\snapshots\\s1.json') >= 0 && keys.indexOf('default\\snapshots\\s2.json') >= 0
        && keys.indexOf('default\\snapshots\\manifest.json') >= 0
        && keys.indexOf('default\\logs\\manifest.json') >= 0
        && logFiles.length === 3 && logFiles.filter((k) => /-2\.json$/.test(k)).length === 1   // 2 天 + 当天超 cap 再切一片
        && rs.ok === true && J(rs.snapStore) === J(snaps) && rs.bad.length === 0
        && rl.ok === true && rl.entries.length === 4 && rl.bad.length === 0
        && rl.entries[0].msg === '甲' && rl.entries[3].msg === '丁';
}, () => ({ info: localDiskInfo() }));

await A('A7 拆分读的诚实口径：清单缺失 → 如实失败；**坏片只报坏片**，其余片照常返回（不清空）', async () => {
    const h = useHost(makeDevHost());
    boot({ localDiskDir: 'D:\\FTT\\store' });
    const none = await localDiskReadParts('snapshots', 'default');
    await localDiskWriteParts('snapshots', [{ id: 's1', data: {} }, { id: 's2', data: {} }], 'default', {});
    // 篡改 s1 的内容（与清单 hash 不符）→ 只报 s1，s2 仍可用
    h.disk.set('D:\\FTT\\store\\default\\snapshots\\s1.json', '{"id":"s1","data":{"tampered":true}}');
    const r = await localDiskReadParts('snapshots', 'default');
    return none.ok === false && none.error === 'no-manifest'
        && r.ok === false && J(r.bad) === J(['s1.json']) && r.snapStore.length === 1
        && String(r.snapStore[0].id) === 's2';
}, () => ({ info: localDiskInfo() }));

// ------------------------------------------------------------
// v3.33.0（用户报告「修复本地存储路径设置，无法设置 android」）：平台识别 / 路径形态冲突 / 候选目录 / 多机制选择器
/** 换一台「设备」：改 UA + 清会话缓存（平台缓存随之重置） */
function useUa(ua) {
    try { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: String(ua || '') } }); } catch (e) { /* 忽略 */ }
    localDiskReset();
}

await A('A8 平台识别与路径冲突提示：Android 收到 `D:\\…` 必须**当场点明**（这就是「Android 上设不了」的直接原因）', async () => {
    useHost(null);
    boot({ localDiskDir: 'D:\\FTT\\store' });
    useUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36');
    const android = localDiskPlatform();
    const warnWin = localDiskPathWarn('D:\\FTT\\store');
    const okPosix = localDiskPathWarn('/storage/emulated/0/Download/ftt_v2_store');
    useUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    const desk = localDiskPlatform();
    const warnPosix = localDiskPathWarn('/storage/emulated/0/Download/x');
    const okWin = localDiskPathWarn('D:\\FTT\\store');
    const warnRel = localDiskPathWarn('相对目录');
    return android.name === 'android' && android.source === 'userAgent'
        && warnWin.indexOf('Windows 路径') > 0 && warnWin.indexOf('Android') > 0 && okPosix === ''
        && desk.name === 'desktop' && warnPosix.indexOf('Android') > 0 && okWin === ''
        && warnRel.indexOf('绝对路径') > 0 && localDiskPlatformLabel('android') === 'Android';
}, () => ({ android: localDiskPlatform(), warn: localDiskPathWarn('D:\\FTT\\store') }));

await A('A9 候选目录：宿主 `path` 插件给出的标准目录逐个收集（Android 上填不出路径时的主要出路）', async () => {
    useHost(null);
    boot({ localDiskDir: '' });
    useUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36');
    const dirs = {
        AppLocalData: '/data/user/0/com.tauritavern.client/files',
        Download: '/storage/emulated/0/Download',
    };
    try {
        globalThis.window.__TAURI_INTERNALS__ = {
            invoke: async (cmd, arg) => {
                if (cmd === 'plugin:path|resolve_directory' && dirs[String((arg && arg.directory) || '')]) return dirs[arg.directory];
                throw new Error('not allowed: ' + cmd);
            },
        };
    } catch (e) { /* 忽略 */ }
    const c = await localDiskDirCandidates();
    diskCandDbg = c;
    const paths = c.items.map((x) => x.path);
    const out = c.platform === 'android'
        && paths.indexOf('/data/user/0/com.tauritavern.client/files') >= 0
        && paths.indexOf('/storage/emulated/0/Download') >= 0
        && c.items.filter((x) => x.source === 'tauri-path').length === 2
        && c.items.some((x) => x.source === 'suggested')           // Android 公共目录**建议**（需探针实测）
        && c.notes.join(' ').indexOf('Android') >= 0;
    useHost(null);
    return out;
}, (() => ({ cand: diskCandDbg })));

await A('A10 选择器全都不可用时：**如实回报尝试过什么**（不假装成功、不静默）', async () => {
    useHost(null);
    boot({ localDiskDir: '' });
    useUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36');
    const pk = await localDiskPickDir();
    lastPickDbg = pk;
    const mechs = pk.tried.map((x) => x.mechanism);
    return pk.ok === false && pk.reason === 'unsupported'
        && mechs.indexOf('dialog') >= 0 && mechs.indexOf('fs-handle') >= 0 && mechs.indexOf('dev-api') >= 0
        && String(pk.note).indexOf('候选目录') > 0 && String(pk.note).indexOf('Android') > 0;
}, () => ({ pk: lastPickDbg }));

await A('A11 选择器走宿主对话框：拿到**真路径**并**写探针实测**（写→回读→删），通过才算选中', async () => {
    useHost(null);
    boot({ localDiskDir: '' });
    useUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36');
    const disk = new Map();
    try {
        globalThis.window.__TAURI_INTERNALS__ = {
            invoke: async (cmd, arg) => {
                const a = (arg && arg.args) ? arg.args : arg;
                const path = String((a && ((a.path && a.path.path) || a.path)) || '');
                if (cmd === 'plugin:dialog|open') return '/storage/emulated/0/ftt_v2_store';
                if (/write/.test(cmd)) { disk.set(path, String(a.contents != null ? a.contents : (a.text != null ? a.text : a.data))); return null; }
                if (/read_text_file/.test(cmd)) { if (!disk.has(path)) throw new Error('ENOENT'); return disk.get(path); }
                if (cmd === 'plugin:path|resolve_directory') throw new Error('no path plugin');
                throw new Error('not allowed: ' + cmd);
            },
        };
    } catch (e) { /* 忽略 */ }
    const pk = await localDiskPickDir();
    const out = pk.ok === true && pk.mechanism === 'dialog' && pk.path === '/storage/emulated/0/ftt_v2_store'
        && String(pk.name) === 'ftt_v2_store' && Array.isArray(pk.tried) && pk.tried[0] && pk.tried[0].ok === true
        && Array.from(disk.keys()).some((k) => /ftt2-local-probe\.json$/.test(k));
    useHost(null);
    return out;
}, () => ({ pk: lastPickDbg }));

R.done();
