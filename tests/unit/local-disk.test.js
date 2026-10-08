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
    localDiskPlatform, localDiskPlatformLabel, localDiskPathWarn, localDiskPickDir,
    localDiskBaseDir, localDiskResolveDir, localDiskEnsureResolved,
} from '../../adapters/local-disk.js';

const R = makeReporter('local-disk v3.28.0 本地磁盘目录（替代浏览器本地存储）');
let lastPickDbg = null, A9Dbg = null;   // A9/A11 现场（失败时打出来）
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
    // v3.38.0：口径改为「本机是否有**任一**可用机制」—— 纯浏览器可走浏览器内置目录（OPFS）；
    //   测试环境两者都没有 → 如实回报 `ok:false` 并写明「本机没有可用的本地目录机制」。
    return okCap && cap2.ok === false && String(cap2.note).indexOf('本机没有可用的本地目录机制') === 0;
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
// v3.33.0/v3.34.0（用户报告「兼容 android 端的 TauriTavern，当前存在问题可能是方法用错了，会弹出报错」）：
//   平台识别 / 路径形态提示 / **TauriTavern 正确调用形态** / 目录名解析到应用数据目录 / 选择器
//   —— 形态口径来自客户端构建实测：写 = 原始字节 body + `headers.path`；读 = `{path, options}` 返回字节；
//      路径 = `{directory: <BaseDirectory 数值枚举>}`；对话框 = `{options:{directory:true}}`。
// ------------------------------------------------------------
/** 换一台「设备」：改 UA + 清会话缓存（平台缓存随之重置） */
function useUa(ua) {
    try { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: String(ua || '') } }); } catch (e) { /* 忽略 */ }
    localDiskReset();
}
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** **规范形态**的宿主桩：只认 TauriTavern 实测口径，其余一律拒绝（用来证明「方法用对了」） */
function makeTauriHost(opts) {
    const o = opts || {};
    const disk = new Map();
    const calls = [];
    const dirs = Object.assign({ 15: '/data/user/0/com.tauritavern.client/files' }, o.dirs || {});
    try {
        globalThis.window.__TAURI_INTERNALS__ = {
            invoke: async (cmd, arg, opt) => {
                const headers = (opt && opt.headers) || {};
                calls.push({ cmd: cmd, arg: arg, headers: headers, isBytes: (arg instanceof Uint8Array) });
                if (cmd === 'plugin:path|resolve_directory') {
                    const n = Number(arg && arg.directory);
                    if (dirs[n]) return dirs[n];
                    throw new Error('path resolve denied');
                }
                if (cmd === 'plugin:dialog|open') {
                    if (o.dialog === undefined) throw new Error('dialog unavailable');
                    return o.dialog;
                }
                if (cmd === 'plugin:fs|mkdir') { disk.set('dir:' + String(arg && arg.path), true); return null; }
                if (cmd === 'plugin:fs|exists') return disk.has(String(arg && arg.path));
                if (cmd === 'plugin:fs|remove') { disk.delete(String(arg && arg.path)); return null; }
                if (cmd === 'plugin:fs|read_text_file') {
                    const k = String(arg && arg.path);
                    if (!disk.has(k)) throw new Error('ENOENT');
                    return new TextEncoder().encode(String(disk.get(k)));     // 返回**字节**
                }
                if (cmd === 'plugin:fs|write_text_file') {
                    // 只有「原始字节 body + headers.path」才认；JSON 参数形态一律拒绝（旧实现就错在这里）
                    if (!(arg instanceof Uint8Array) || !headers.path) throw new Error('invalid args: missing file path');
                    const k = decodeURIComponent(String(headers.path));
                    if (o.denyWrite) throw new Error('forbidden path: ' + k);
                    disk.set(k, new TextDecoder('utf-8').decode(arg));
                    return null;
                }
                throw new Error('not allowed: ' + cmd);
            },
        };
    } catch (e) { /* 忽略 */ }
    return { disk: disk, calls: calls };
}

await A('A8 平台识别与路径冲突提示：Android 收到 `D:\…` 当场点明「改成只填目录名」（跨设备同步来的绝对路径在别的平台必然写不进去）', async () => {
    useHost(null);
    boot({ localDiskDir: 'D:\\FTT\\store' });
    useUa(ANDROID_UA);
    const android = localDiskPlatform();
    const warnWin = localDiskPathWarn('D:\\FTT\\store');
    const okPosix = localDiskPathWarn('/data/user/0/com.tauritavern.client/files/fft_v2_store');
    const warnRel = localDiskPathWarn('fft_v2_store');       // 只填目录名 → **不再是告警**（v3.34.0 推荐用法）
    useUa(DESKTOP_UA);
    const desk = localDiskPlatform();
    const okWin = localDiskPathWarn('D:\\FTT\\store');
    return android.name === 'android' && android.source === 'userAgent'
        && warnWin.indexOf('Windows 路径') > 0 && warnWin.indexOf('Android') > 0 && warnWin.indexOf('目录名') > 0
        && okPosix === '' && warnRel === ''
        && desk.name === 'desktop' && okWin === ''      // 同平台绝对路径不在这里告警（是否放行由探针实测）
        && localDiskPlatformLabel('android') === 'Android';
}, () => ({ warn: localDiskPathWarn('D:\\FTT\\store') }));

await A('A9 **方法用对了吗**：写 = 原始字节 body + `headers.path`；读 = `{path, options}` 且返回**字节** —— 一次写只发一次 IPC（不盲试、不弹报错）', async () => {
    useHost(null);
    const h = makeTauriHost({});
    boot({ localDiskDir: 'fft_v2_store' });   // 相对目录名 → 解析到应用数据目录
    useUa(ANDROID_UA);
    const w = await localDiskWrite('a.json', '{"x":1}');
    const r = await localDiskRead('a.json');
    const writes = h.calls.filter((c) => c.cmd === 'plugin:fs|write_text_file');
    const reads = h.calls.filter((c) => c.cmd === 'plugin:fs|read_text_file');
    const info = localDiskInfo();
    const cond = {
        w: w.ok === true, mech: String(w.mechanism).indexOf('v2-raw') > 0,
        r: r.ok === true && r.text === '{"x":1}',
        wn: writes.length, wb: writes[0] ? writes[0].isBytes : null, wh: writes[0] ? String(writes[0].headers.path).length : -1,
        rn: reads.length, rp: reads[0] ? String(reads[0].arg && reads[0].arg.path).length : -1,
        shape: info.fsShape,
    };
    // 读共 2 次：① localDiskWrite 内部的写后回读校验；② 本测试显式 localDiskRead（都是 {path, options} 形态）
    const ok = cond.w && cond.mech && cond.r && cond.wn === 1 && cond.wb === true && cond.wh > 0 && cond.rn === 2 && cond.rp > 0 && cond.shape === 'v2-raw';
    A9Dbg = cond;
    return ok;
}, () => ({ cond: A9Dbg, info: localDiskInfo() }));

await A('A10 只填一个**目录名** → 解析到宿主应用数据目录（`$APPLOCALDATA`，数值枚举 15）并把完整路径写回配置', async () => {
    useHost(null);
    const h = makeTauriHost({});
    boot({ localDiskDir: 'fft_v2_store' });
    useUa(ANDROID_UA);
    const pr = await localDiskProbeDir('fft_v2_store');
    const info = localDiskInfo();
    const mk = h.calls.filter((c) => c.cmd === 'plugin:fs|mkdir');
    const ds = h.calls.filter((c) => c.cmd === 'plugin:path|resolve_directory');
    return pr.ok === true && pr.resolved === true
        && pr.dir === '/data/user/0/com.tauritavern.client/files/fft_v2_store'
        && String(pr.base).indexOf('AppLocalData') > 0
        && mk.length >= 1 && String(mk[0].arg.path) === '/data/user/0/com.tauritavern.client/files/fft_v2_store'
        && ds.length >= 1 && Number(ds[0].arg.directory) === 15
        && info.base === '/data/user/0/com.tauritavern.client/files' && info.fsShape === 'v2-raw'
        && Array.from(h.disk.keys()).every((k) => k.indexOf('dir:') === 0 || !/ftt2-local-probe\.json$/.test(k));   // 探针文件已删
}, () => ({ info: localDiskInfo() }));

await A('A11 宿主拒绝时**如实失败**（不假装成功、不反复盲试）：写被拒 → 探针失败 + 路径标记无效；只发规范形态那一次', async () => {
    useHost(null);
    const h = makeTauriHost({ denyWrite: true });
    boot({ localDiskDir: 'fft_v2_store' });
    useUa(ANDROID_UA);
    const pr = await localDiskProbeDir('fft_v2_store');
    const info = localDiskInfo();
    const writes = h.calls.filter((c) => c.cmd === 'plugin:fs|write_text_file');
    return pr.ok === false && String(pr.error).indexOf('应用数据目录') > 0
        && info.invalid && info.invalid.invalid === true
        && writes.length === 1;     // 放行范围类拒绝**只发一次**：不换参数形态重试 → 不再多弹报错
}, () => ({ info: localDiskInfo() }));

await A('A12 选择器：全不可用时如实回报尝试过什么；宿主对话框可用时 → 用 `{options:{directory:true}}` 拿到真路径并**探针实测**通过', async () => {
    // ① 全不可用
    useHost(null);
    boot({ localDiskDir: '' });
    useUa(DESKTOP_UA);
    const bad = await localDiskPickDir();
    lastPickDbg = bad;
    const mechs = bad.tried.map((x) => x.mechanism);
    const ok1 = bad.ok === false && mechs.indexOf('dialog') >= 0 && mechs.indexOf('fs-handle') >= 0
        && String(bad.note).indexOf('目录名') > 0;
    // ② 宿主对话框可用（Android 上给应用数据目录里的路径）
    useHost(null);
    const h = makeTauriHost({ dialog: '/data/user/0/com.tauritavern.client/files/fft_v2_store' });
    boot({ localDiskDir: '' });
    useUa(ANDROID_UA);
    const pk = await localDiskPickDir();
    lastPickDbg = pk;
    const dlg = h.calls.filter((c) => c.cmd === 'plugin:dialog|open');
    return ok1 && pk.ok === true && pk.mechanism === 'dialog'
        && pk.path === '/data/user/0/com.tauritavern.client/files/fft_v2_store'
        && dlg.length === 1 && dlg[0].arg && dlg[0].arg.options && dlg[0].arg.options.directory === true;
}, () => ({ pk: lastPickDbg }));

await A('A13 启动自愈 `localDiskEnsureResolved`：配置里只有目录名 → 解析成完整路径并**写回配置**（之后任何写入都不再需要解析）', async () => {
    useHost(null);
    makeTauriHost({});
    boot({ localDiskDir: 'fft_v2_store' });
    useUa(ANDROID_UA);
    const r = await localDiskEnsureResolved();
    const after = String((cfg.storage || {}).localDiskDir || '');
    const base = await localDiskBaseDir(false);
    const again = await localDiskEnsureResolved();
    return r.ok === true && r.resolved === true && after === '/data/user/0/com.tauritavern.client/files/fft_v2_store'
        && base.ok === true && base.label === 'AppLocalData'
        && again.resolved === false;      // 已是绝对路径 → 幂等（不再解析）
}, () => ({ cfg: (cfg.storage || {}).localDiskDir }));

R.done();