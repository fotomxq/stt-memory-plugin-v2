// ============================================================
// 单元测试 · v3.38.0「本地存储路径」在**纯浏览器**（PC 网页版）也能用：浏览器内置目录（OPFS）
//
// 用户报告（原话）：「手机端必须使用内置路径，而跑到PC端，又不可用了。根据通知推测，可能你把服务端的方法，
//   用在了前端中？请核对原因，修复'本地存储路径'设定到本地时，应该通过浏览器方法去构建相关文件。」
//
// 核对出的根因（本文件即回归护栏）：
//   ① v3.28~v3.37 的「本地磁盘目录」只有**宿主**机制（TauriTavern `plugin:fs|*` / `api.dev`）+ 一个**本会话**
//      的文件夹句柄；纯浏览器（PC 酒馆网页版 / Firefox）两者都没有 → 每次读写失败、回退浏览器本地存储并弹告警；
//   ② 更要命的是 `localDiskCapability().ok === false` 时 `localDiskOn()` 仍为 true（设置看起来生效、实际不可用）；
//   ③ 相对目录名（如 `fft_v2_store`）在**没有宿主**的本机解析不出基准目录 → 直接失败（PC 端不可用）。
//   修复：新增**浏览器内置目录**（OPFS：`navigator.storage.getDirectory`）—— 纯浏览器方法，不需要宿主接口；
//     · 标记 `@browser/<目录名>` 设备中立（手机 / PC 同一配置都成立，各自写各自的浏览器目录）；
//     · 相对目录名无宿主基准目录时**自动落到**浏览器内置目录（PC 端因此可用）；
//     · 顺带修「显式路径被会话句柄劫持 → 探针假成功」与「配置留空 + 有句柄时各入口报 off」。
// 覆盖：A 标记与形态 · B 纯浏览器可用性（根因）· C 三后端路由 · D 面板动作与界面 · E 手机端（宿主仍在）不回归。
// 运行：node tests/unit/local-browser-dir.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost, makeOpfs, installGlobalOpfs } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    BROWSER_PREFIX, localDiskBrowserMarker, localDiskIsBrowserPath, localDiskBrowserName, localDiskPathKind,
    localDiskPathWarn, localDiskOn, localDiskInfo, localDiskCapability, localDiskReset, localDiskWrite, localDiskRead,
    localDiskList, localDiskProbeDir, localDiskResolveDir, localDiskEnsureResolved, localDiskUseBrowserDir, localDiskPickDir,
    localDiskWriteShards,
} from '../../adapters/local-disk.js';
import { browserFsWrite, browserFsRead, browserFsAvailable, browserFsReset } from '../../adapters/browser-fs.js';
import { syncAction, storagePageHtml, SYNC_ACTIONS } from '../../ui/sync.js';

const R = makeReporter('local-browser-dir v3.38.0 本地存储路径 · 浏览器内置目录（OPFS）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e));
const clone = (v) => JSON.parse(JSON.stringify(v));
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 假文件夹句柄（File System Access 最小子集；与 v3.35.0 测试同形，含子目录） */
function makeHandle(name) {
    const files = new Map();
    const h = {
        name: name, kind: 'directory',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFileHandle: async (n) => ({
            createWritable: async () => ({ write: async (t) => { files.set(String(n), String(t)); }, close: async () => { } }),
            getFile: async () => ({ text: async () => String(files.get(String(n)) || '') }),
        }),
        getDirectoryHandle: async () => ({ getFileHandle: h.getFileHandle, removeEntry: async () => { }, entries: async function* () { } }),
        removeEntry: async (n) => { files.delete(String(n)); },
        entries: async function* () { for (const [k] of files) yield [k, { name: k, kind: 'file', size: 0 }]; },
        _files: files,
    };
    return h;
}
/** 假宿主（Tauri 桥：应用数据目录 + fs 插件；模拟 Android / TauriTavern） */
function installTauriBase(base) {
    const fsMap = new Map();
    globalThis.window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, payload, opts) => {
            const c = String(cmd);
            if (c.indexOf('path|resolve_directory') >= 0) return base;
            if (c.indexOf('os|platform') >= 0) return 'android';
            if (c.indexOf('mkdir') >= 0) return null;
            const hdr = (opts && opts.headers) || {};
            const p = decodeURIComponent(String((payload && (payload.path || payload.filePath)) || hdr.path || ''));
            if (c.indexOf('write_text_file') >= 0) {
                const bytes = (payload instanceof Uint8Array) ? payload : (payload && payload.contents ? new TextEncoder().encode(String(payload.contents)) : new Uint8Array());
                fsMap.set(p, new TextDecoder().decode(bytes));
                return null;
            }
            if (c.indexOf('read_text_file') >= 0) return new TextEncoder().encode(String(fsMap.get(p) || ''));
            if (c.indexOf('exists') >= 0) return fsMap.has(p);
            if (c.indexOf('remove') >= 0) { fsMap.delete(p); return null; }
            return null;
        },
    };
    return fsMap;
}

/** 环境：`host` = 'none'（纯浏览器）| 'tauri'（宿主）；`opfs` = 假 OPFS 或 null */
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:browserdir');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [] }), doc);
    setLastMessageId(-1);
    setKernelState(Object.assign(emptyState(), o.state || {}));
    setNotifyHooks({ toast: () => undefined });
    localDiskReset();
    browserFsReset();
    delete globalThis.window.__TAURI_INTERNALS__;
    const opfs = o.opfs === undefined ? makeOpfs() : o.opfs;
    uninstallOpfs = installGlobalOpfs(opfs, o.ua);
    const fsMap = (o.host === 'tauri') ? installTauriBase(o.base || 'C:/AppData/Local') : new Map();
    if (o.dir !== undefined) cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: o.dir });
    else cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'fft_v2_store' });
    return { opfs: opfs, fsMap: fsMap };
}
let uninstallOpfs = () => { };

// ============================================================
// A 组：标记与形态
// ============================================================
A('A1 `@browser/<目录名>` 标记：生成 / 判定 / 取名（去尾斜杠、只取第一段）都正确；普通目录名 / 宿主路径不被误判', (() => {
    return BROWSER_PREFIX === '@browser/'
        && localDiskBrowserMarker('fft_v2_store') === '@browser/fft_v2_store'
        && localDiskBrowserMarker('fft_v2_store/') === '@browser/fft_v2_store'
        && localDiskBrowserMarker('a/b') === '@browser/a'
        && localDiskBrowserMarker('') === ''
        && localDiskIsBrowserPath('@browser/x') === true && localDiskIsBrowserPath('@handle/x') === false
        && localDiskIsBrowserPath('fft_v2_store') === false && localDiskIsBrowserPath('D:\\a') === false
        && localDiskBrowserName('@browser/x/') === 'x' && localDiskBrowserName('@browser/x/sub') === 'x'
        && localDiskBrowserName('fft_v2_store') === '';
})(), '见断言');

A('A2 路径形态单列 `browser`：不被当成「相对目录名」（否则会再去解析宿主应用数据目录，指错位置）', (() => {
    return localDiskPathKind('@browser/fft_v2_store') === 'browser'
        && localDiskPathKind('fft_v2_store') === 'relative'
        && localDiskPathKind('@handle/x') === 'handle';
})(), '见断言');

A('A3 标记路径**没有跨平台告警**（设备中立：手机与 PC 同一配置都成立）', (() => {
    return localDiskPathWarn('@browser/fft_v2_store', 'android') === '' && localDiskPathWarn('@browser/x', 'desktop') === '';
})(), () => ({ android: localDiskPathWarn('@browser/x', 'android'), desktop: localDiskPathWarn('@browser/x', 'desktop') }));

A('A4 `localDiskOn()`：`@browser/x` 在**支持 OPFS** 的浏览器算开启；不支持时如实算未开启（绝不假装能写）', (() => {
    boot({ dir: '@browser/fft_v2_store' });
    const supported = localDiskOn();
    boot({ dir: '@browser/fft_v2_store', opfs: null });
    const unsupported = localDiskOn();
    return supported === true && unsupported === false;
})(), () => ({ supported: localDiskOn() }));

// ============================================================
// B 组：纯浏览器可用性 —— 用户报告的根因
// ============================================================
A('B1 根因回归：**没有任何宿主接口**的纯浏览器，现在 `capability.ok === true`、机制 = `browser-opfs`（修复前是 ok:false →「PC 端不可用」）', (() => {
    boot({ host: 'none', dir: 'fft_v2_store' });
    const c = localDiskCapability(true);
    return c.ok === true && c.mechanism === 'browser-opfs' && c.browserFs === true && c.tauriFs === false
        && String(c.note).indexOf('OPFS') > 0;
})(), () => localDiskCapability(true));

await (async () => {
    boot({ host: 'none', dir: 'fft_v2_store' });
    const rs = await localDiskResolveDir('fft_v2_store');
    const er = await localDiskEnsureResolved();
    A('B2 相对目录名在无宿主的本机**自动落到浏览器内置目录**：`fft_v2_store` → `@browser/fft_v2_store`（设备中立，**不写回**配置）', (() => {
        return rs.ok === true && rs.dir === '@browser/fft_v2_store' && rs.browserMode === true && rs.resolved === false
            && er.browserMode === true && String(cfg.storage.localDiskDir) === 'fft_v2_store';   // 仍是目录名（可跨设备复用）
    })(), () => ({ rs: rs, dir: cfg.storage && cfg.storage.localDiskDir }));
})();

await (async () => {
    const env = boot({ host: 'none', dir: 'fft_v2_store' });
    const pr = await localDiskProbeDir('fft_v2_store');
    const w = await localDiskWrite('ftt2-local-a.json', JSON.stringify({ a: 1 }));
    const r = await localDiskRead('ftt2-local-a.json');
    const l = await localDiskList();
    A('B3 纯浏览器端到端：探针（写→回读→删）通过、写入 / 回读 / 列目录都成功，机制都是 `browser-opfs`；探针文件**已清理**（不留在用户目录里）', (() => {
        return pr.ok === true && pr.dir === '@browser/fft_v2_store' && pr.path === '@browser/fft_v2_store/ftt2-local-probe.json'
            && w.ok === true && w.mechanism === 'browser-opfs' && w.path === '@browser/fft_v2_store/ftt2-local-a.json'
            && r.ok === true && r.text === '{"a":1}'
            && l.ok === true && l.names.join(',') === 'ftt2-local-a.json'
            && env.opfs.files().join(',') === 'fft_v2_store/ftt2-local-a.json';
    })(), () => ({ pr: pr, w: w, files: env.opfs.files() }));

    const info = localDiskInfo();
    const html = String(storagePageHtml([]) || '');
    const b4 = {
        mode: info.browserMode === true, name: info.browserName === 'fft_v2_store', kind: info.kind === 'browser',
        fs: info.browserFs === true, display: String(info.display).indexOf('OPFS') > 0,
        block: html.indexOf('data-ftt-disk-browser') > 0, marker: html.indexOf('@browser/fft_v2_store') > 0,
        file: html.indexOf('ftt2-local-＜角色＞.json') > 0,
        cap: html.indexOf('浏览器内置目录：<b>可用</b>') > 0,
    };
    A('B4 界面如实呈现「浏览器内置目录」：状态 / 展示语 / 完整文件路径 / 后端可用性都写清楚（用户能看懂文件落在哪）', (() => {
        return Object.keys(b4).every((k) => b4[k] === true);
    })(), () => ({ b4: b4, hasCap: html.indexOf('浏览器内置目录') }));
})();

A('B5 真的什么都没有时（无宿主 + 浏览器无 OPFS）**如实失败**：能力 ok:false、写入报 no-capability（不假装成功、不留脏标记以外的副作用）', (() => {
    boot({ host: 'none', dir: 'fft_v2_store', opfs: null });
    const c = localDiskCapability(true);
    return c.ok === false && c.browserFs === false && String(c.note).indexOf('本机没有可用的本地目录机制') === 0;
})(), () => localDiskCapability(true));

await (async () => {
    boot({ host: 'none', dir: 'fft_v2_store', opfs: null });
    const w = await localDiskWrite('x.json', '{}');
    A('B6 无任何机制时的写入回执**如实**（`ok:false` + 原因文本），并把该路径标记为「无效」以便界面显著告警', (() => {
        const info = localDiskInfo();
        return w.ok === false && String(w.error).indexOf('本机没有可用的本地目录机制') >= 0
            && info.invalid.invalid === true;
    })(), () => ({ w: w, invalid: localDiskInfo().invalid }));
})();

// ============================================================
// C 组：三后端路由（浏览器内置目录 / 会话句柄 / 宿主 fs）
// ============================================================
await (async () => {
    // ① 显式 `@browser/...` 与 ② 显式宿主路径：**互不串台**
    const env = boot({ host: 'tauri', base: 'C:/AppData/Local', dir: '@browser/mine' });
    const wb = await localDiskWrite('b.json', 'B');
    A('C1 配置 = `@browser/mine` 时写入走**浏览器内置目录**（即使本机也有宿主 fs）：文件出现在 OPFS 里，不落宿主目录', (() => {
        return wb.ok === true && wb.mechanism === 'browser-opfs'
            && env.opfs.files().join(',') === 'mine/b.json' && env.fsMap.size === 0;
    })(), () => ({ wb: wb, opfs: env.opfs.files(), host: Array.from(env.fsMap.keys()) }));

    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'C:/AppData/Local/fft_v2_store' });
    const wh = await localDiskWrite('h.json', 'H');
    A('C2 配置 = 宿主绝对路径时写入走**宿主 fs**：文件落宿主目录，OPFS 不新增文件（后端按路径判定，不按“谁能用”猜）', (() => {
        return wh.ok === true && String(wh.mechanism).indexOf('tauri-fs') >= 0
            && env.fsMap.has('C:/AppData/Local/fft_v2_store/h.json') && env.opfs.files().join(',') === 'mine/b.json';
    })(), () => ({ wh: wh, opfs: env.opfs.files(), host: Array.from(env.fsMap.keys()) }));
})();

await (async () => {
    // ③ 修「假成功」：本会话选了文件夹句柄后，校验一个**显式绝对路径**不应写进句柄
    boot({ dir: '', opfs: makeOpfs() });
    const h = makeHandle('picked');
    globalThis.window.showDirectoryPicker = async () => h;
    await localDiskPickDir();
    const pr = await localDiskProbeDir('D:\\nope\\fft_v2_store');
    A('C3 修复「探针假成功」：会话句柄存在时，校验**显式绝对路径**不再被句柄劫持（以前会写进那个文件夹并「校验通过」）', (() => {
        return pr.ok === false && String(pr.dir) === 'D:\\nope\\fft_v2_store' && h._files.size === 0;
    })(), () => ({ pr: pr, handleFiles: Array.from(h._files.keys()) }));

    const pr2 = await localDiskProbeDir('@handle/picked');
    A('C4 而句柄**标记**仍然走句柄（写 → 回读 → 删探针）—— 路由按标记判定，两边都不误伤', (() => {
        return pr2.ok === true && pr2.handleMode === true && pr2.mechanism === 'fs-handle' && h._files.size === 0;
    })(), () => ({ pr2: pr2, handleFiles: Array.from(h._files.keys()) }));
    delete globalThis.window.showDirectoryPicker;
})();

await (async () => {
    // ④ 配置留空 + 本会话有句柄：以前各入口一律 `off`（选了文件夹却写不出文件）
    boot({ dir: '', opfs: makeOpfs() });
    const h = makeHandle('picked2');
    globalThis.window.showDirectoryPicker = async () => h;
    await localDiskPickDir();
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '' });   // 模拟「只选了文件夹、没填路径」
    const w = await localDiskWrite('only-handle.json', 'X');
    A('C5 修复「留空 + 有句柄」：`localDiskWrite` 现在真的能写入句柄（旧实现 `effectiveDir()` 返回空 → 一律 `off`，与 `localDiskOn()=true` 自相矛盾）', (() => {
        return w.ok === true && w.mechanism === 'fs-handle' && h._files.get('only-handle.json') === 'X';
    })(), () => ({ w: w, files: Array.from(h._files.keys()) }));
    delete globalThis.window.showDirectoryPicker;
})();

// ============================================================
// D 组：面板动作与界面（「🧩 浏览器内置目录」）
// ============================================================
await (async () => {
    boot({ host: 'none', dir: 'fft_v2_store' });
    const r = await syncAction('localDiskBrowserDir', {});
    A('D1 面板动作 `localDiskBrowserDir`：一键使用浏览器内置目录 → 写进本机配置（`@browser/<目录名>`）并如实回报；已登记进 `SYNC_ACTIONS`', (() => {
        return r.ok === true && r.action === 'localDiskBrowserDir'
            && String(cfg.storage.localDiskDir) === '@browser/fft_v2_store'
            && String(r.note).indexOf('浏览器内置目录') > 0 && String(r.note).indexOf('@browser/fft_v2_store') > 0
            && SYNC_ACTIONS.indexOf('localDiskBrowserDir') >= 0;
    })(), () => ({ r: r, dir: cfg.storage && cfg.storage.localDiskDir }));

    const html = String(storagePageHtml([]) || '');
    A('D2 存储页给出这个入口：按钮 + 说明「纯浏览器方法 / 不需要宿主接口 / 刷新后仍有效」', (() => {
        return html.indexOf('data-ftt-action="localDiskBrowserDir"') > 0 && html.indexOf('🧩 浏览器内置目录') > 0
            && html.indexOf('不需要宿主接口') > 0;
    })(), () => html.slice(html.indexOf('localDiskBrowserDir') - 60, html.indexOf('localDiskBrowserDir') + 200));
})();

await (async () => {
    boot({ host: 'none', dir: 'fft_v2_store', opfs: null });
    const r = await syncAction('localDiskBrowserDir', {});
    A('D3 浏览器不支持 OPFS 时该动作**如实失败**（不假装、不改配置）', (() => {
        return r.ok === false && String(r.note).indexOf('不支持') > 0 && String(cfg.storage.localDiskDir) === 'fft_v2_store';
    })(), () => ({ r: r, dir: cfg.storage && cfg.storage.localDiskDir }));

    const direct = await localDiskUseBrowserDir('zzz');
    A('D4 直调 `localDiskUseBrowserDir` 在无 OPFS 时同样如实失败（`reason:unsupported`，带尝试记录）', (() => {
        return direct.ok === false && direct.reason === 'unsupported' && Array.isArray(direct.tried) && direct.tried.length >= 1;
    })(), () => direct);
})();

// ============================================================
// E 组：手机端（宿主仍在）不回归
// ============================================================
await (async () => {
    const env = boot({ host: 'tauri', base: 'C:/AppData/Local', dir: 'fft_v2_store', opfs: makeOpfs() });
    const rs = await localDiskResolveDir('fft_v2_store');
    const pr = await localDiskProbeDir('fft_v2_store');
    A('E1 有宿主时**宿主优先**（手机端行为不变）：相对目录名仍解析到宿主应用数据目录、探针走宿主 fs —— 浏览器内置目录只是没有宿主时的兜底', (() => {
        return rs.ok === true && rs.dir === 'C:/AppData/Local/fft_v2_store' && rs.resolved === true && !rs.browserMode
            && pr.ok === true && env.fsMap.size === 0;     // 探针写后已删
    })(), () => ({ rs: rs, pr: pr, host: Array.from(env.fsMap.keys()), opfs: env.opfs.files() }));
})();

await (async () => {
    const env = boot({ host: 'tauri', base: 'C:/AppData/Local', dir: 'fft_v2_store', opfs: makeOpfs() });
    const w = await localDiskWriteShards({ scope: 'char:a', payload: { scope: 'char:a', updatedAt: 7, data: { meta: { clock: 'x' }, plot: [1, 2] } } }, 'char:a');
    A('E2 结构化分片写入在宿主路径下仍走宿主 fs（统一路由后不回归）：分片 + 清单都落宿主目录，OPFS 不新增文件', (() => {
        const keys = Array.from(env.fsMap.keys());
        return w.ok === true && String(w.dir || '').indexOf('C:/AppData/Local') === 0
            && keys.length >= 2 && keys.every((k) => k.indexOf('C:/AppData/Local/fft_v2_store/') === 0)
            && keys.some((k) => k.endsWith('manifest.json'))
            && env.opfs.files().length === 0;
    })(), () => ({ w: w, host: Array.from(env.fsMap.keys()), opfs: env.opfs.files() }));
})();

A('E3 `browserFsAvailable()` 无 OPFS 时如实为 false（能力探测不猜、缓存后重置也一致）', (() => {
    boot({ host: 'none', opfs: null });
    const a = browserFsAvailable();
    browserFsReset();
    return a === false && browserFsAvailable() === false;
})(), '见断言');

await (async () => {
    boot({ host: 'none', opfs: null });
    const w = await browserFsWrite('a/b.json', 'x');
    const r = await browserFsRead('a/b.json');
    A('E4 `browserFsWrite/Read` 无 OPFS 时返回 `ok:false`（写回执带 `no-opfs`；读回执 `miss:true`）—— 上层能据此如实告警', (() => {
        return w.ok === false && w.error === 'no-opfs' && r.ok === false && r.miss === true;
    })(), () => ({ w: w, r: r }));
})();

try { uninstallOpfs(); } catch (e) { /* 忽略 */ }
R.done();
