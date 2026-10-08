// ============================================================
// 单元测试 · v3.35.0「选择文件夹后本地存储路径不显示 → 需人工填写」修复
// 用户报告（原话）：「设定-本地存储路径，如果选择文件夹，本地存储路径不会显示完整路径，而是需人工填写路径，修复该错误。」
//
// 根因：浏览器原生文件夹选择器（File System Access）出于隐私**不暴露绝对路径**，旧实现只在拿到「真路径」时
//   才写进路径框（`pk.path`），句柄场景返回 `path:''` → **路径框空白** → 用户只能手工填写（尽管文件其实已写进该文件夹）。
//
// 修复口径（v3.35.0）：
//   · 选中后返回并写入**句柄标记** `@handle/<文件夹名>`：路径框立刻有可见、可复制的值，无需人工填写；
//   · 该标记是本插件自认的「用本会话文件夹句柄写」，**绝不**被当成宿主相对路径解析到应用数据目录；
//   · 刷新后句柄失效 → `localDiskOn()` 返回 false（干净回退浏览器层，不再每次保存都失败告警）+
//     界面红字提示「重新选择文件夹 / 改填绝对路径 / 只填目录名」；
//   · 真路径（宿主系统对话框 / 宿主接口）仍然优先写入（行为不变）。
// 覆盖：
//   A 组 标记与形态（生成 / 判定 / 取名 / 单列一类）；
//   B 组 选中结果（浏览器句柄 → 写进路径框；宿主对话框 → 真路径优先；取消 → 不写）；
//   C 组 校验与解析（句柄探针走句柄、不解析成宿主路径；句柄失效如实报错）；
//   D 组 界面（设定 → 存储页显示标记 + 解释 + 失效提示；`enabled` 与回退口径）。
// 运行：node tests/unit/local-disk-pick-path.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    HANDLE_PREFIX, localDiskHandleMarker, localDiskIsHandlePath, localDiskHandleName, localDiskPathKind,
    localDiskOn, localDiskInfo, localDiskPickDir, localDiskProbeDir, localDiskResolveDir, localDiskReset,
} from '../../adapters/local-disk.js';
import { syncAction, storagePageHtml } from '../../ui/sync.js';

const R = makeReporter('local-disk-pick-path v3.35.0 选择文件夹后路径框显示');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e));
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 假文件夹句柄（File System Access API 的最小子集：写 / 读 / 列 / 删 + 权限） */
function makeHandle(name) {
    const files = new Map();
    const h = {
        name: name,
        kind: 'directory',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFileHandle: async (n) => ({
            createWritable: async () => ({ write: async (t) => { files.set(String(n), String(t)); }, close: async () => { } }),
            getFile: async () => ({ text: async () => String(files.get(String(n)) || '') }),
        }),
        getDirectoryHandle: async (n) => ({ _sub: String(n), getFileHandle: h.getFileHandle }),
        removeEntry: async (n) => { files.delete(String(n)); },
        entries: async function* () { for (const [k, v] of files) yield [k, { name: k, kind: 'file', size: v.length }]; },
        _files: files,
    };
    return h;
}

function boot(st) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:diskpick');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [] }), doc);
    setLastMessageId(-1);
    setKernelState(Object.assign(emptyState(), st || {}));
    setNotifyHooks({ toast: () => undefined });
    localDiskReset();
    return state;
}

// ---------- A 组：标记与形态 ----------
A('A1 句柄标记：`@handle/<文件夹名>` 生成 / 判定 / 取名（去尾斜杠）都正确；空名 → 空串', (() => {
    return HANDLE_PREFIX === '@handle/'
        && localDiskHandleMarker('fft_v2_store') === '@handle/fft_v2_store'
        && localDiskHandleMarker('fft_v2_store/') === '@handle/fft_v2_store'
        && localDiskHandleMarker('') === ''
        && localDiskIsHandlePath('@handle/x') === true && localDiskIsHandlePath('fft_v2_store') === false
        && localDiskIsHandlePath('D:\\a') === false && localDiskIsHandlePath('') === false
        && localDiskHandleName('@handle/x') === 'x' && localDiskHandleName('@handle/x/') === 'x'
        && localDiskHandleName('fft_v2_store') === '';
})(), '见断言');

A('A2 路径形态单列 `handle`：不再被当成「相对目录名」（否则会被解析到宿主应用数据目录，指向错误位置）', (() => {
    return localDiskPathKind('@handle/fft_v2_store') === 'handle'
        && localDiskPathKind('fft_v2_store') === 'relative'
        && localDiskPathKind('D:\\a\\b') === 'windows-abs'
        && localDiskPathKind('/sdcard/x') === 'posix-abs'
        && localDiskPathKind('') === 'empty';
})(), '见断言');

// v3.38.0：本断言原先把 `storage` 传给了 kernel **state**（不是 `cfg`）→ 路径其实一直是空串，
//   等于「恒真」的假绿。现在显式写 `cfg.storage.localDiskDir`，并补上「有句柄 → 开启」「真路径 → 开启」两例。
await (async () => {
    boot({});
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '@handle/fft_v2_store' });
    const lost = localDiskOn();
    boot({});
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '@handle/fft_v2_store' });
    globalThis.window.showDirectoryPicker = async () => makeHandle('fft_v2_store');
    await localDiskPickDir();                        // 真的选一次 → 本会话才有句柄
    const withHandle = localDiskOn();
    boot({});
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'D:\\fft_v2_store' });
    const absPath = localDiskOn();
    A('A3 `localDiskOn()`：**句柄标记 + 句柄已失效** → 未开启（干净回退浏览器层，不误标无效）；本会话已选句柄 → 开启；真路径 → 开启', (() => {
        return lost === false && withHandle === true && absPath === true;
    })(), () => ({ lost: lost, withHandle: withHandle, absPath: absPath, dir: cfg.storage && cfg.storage.localDiskDir }));
})();

// ---------- B 组：选中结果写进路径框 ----------
await (async () => {
    boot({ storage: {} });
    const h = makeHandle('fft_v2_store');
    globalThis.window.showDirectoryPicker = async () => h;
    const pk = await localDiskPickDir();
    A('B1 浏览器「选择文件夹」→ 返回**句柄标记**并写进路径框（修复前返回 `path:\'\'` → 框里空白、要人工填写）', (() => {
        return pk.ok === true && pk.mechanism === 'fs-handle'
            && pk.path === '@handle/fft_v2_store' && pk.marker === '@handle/fft_v2_store' && pk.name === 'fft_v2_store'
            && String(pk.note).indexOf('@handle/fft_v2_store') > 0 && String(pk.note).indexOf('不暴露绝对路径') > 0;
    })(), () => ({ pk: pk }));

    const r = await syncAction('localDiskPick', {});
    A('B2 面板动作 `localDiskPick` 把标记**写进本机配置**（路径框渲染即来自配置 → 立刻可见、可复制，无需人工填写）', (() => {
        return r.ok === true && String(cfg.storage.localDiskDir) === '@handle/fft_v2_store'
            && String(r.note).indexOf('已选中文件夹') >= 0;
    })(), () => ({ dir: cfg.storage && cfg.storage.localDiskDir, note: r.note }));

    const html = String(storagePageHtml([]) || '');
    A('B3 存储页把标记与「这是什么」一起显示：路径 = 标记，并说明是浏览器选中的文件夹、绝对路径不可见、本会话内写入', (() => {
        return html.indexOf('data-ftt-disk-fullpath') > 0 && html.indexOf('@handle/fft_v2_store') > 0
            && html.indexOf('浏览器选中的文件夹') > 0 && html.indexOf('绝对路径不可见') > 0
            && html.indexOf('ftt2-local-＜角色＞.json') > 0;
    })(), () => html.slice(html.indexOf('data-ftt-disk-fullpath'), html.indexOf('data-ftt-disk-fullpath') + 320));

    // 宿主系统对话框（真路径）仍然优先
    boot({ storage: {} });
    const keepW = globalThis.window.showDirectoryPicker;
    delete globalThis.window.showDirectoryPicker;
    const tauriFs = new Map();
    globalThis.window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, payload, opts) => {
            const c = String(cmd);
            if (c.indexOf('dialog|open') >= 0) return 'D:\\stn\\fft_v2_store';
            const hdr = (opts && opts.headers) || {};
            const p = decodeURIComponent(String((payload && (payload.path || payload.filePath)) || hdr.path || ''));
            if (c.indexOf('mkdir') >= 0) return null;
            if (c.indexOf('write_text_file') >= 0) {
                const bytes = (payload instanceof Uint8Array) ? payload : (payload && payload.contents ? new TextEncoder().encode(String(payload.contents)) : new Uint8Array());
                tauriFs.set(p, new TextDecoder().decode(bytes));
                return null;
            }
            if (c.indexOf('read_text_file') >= 0) return new TextEncoder().encode(String(tauriFs.get(p) || ''));
            if (c.indexOf('exists') >= 0) return tauriFs.has(p);
            if (c.indexOf('remove') >= 0) { tauriFs.delete(p); return null; }
            return null;
        },
    };
    const pk2 = await localDiskPickDir();
    const r2 = await syncAction('localDiskPick', {});
    A('B4 有宿主系统对话框时**真路径优先**：返回绝对路径并写进路径框（句柄标记只是浏览器兜底；行为与修复前一致）', (() => {
        return pk2.ok === true && pk2.mechanism === 'dialog' && pk2.path === 'D:\\stn\\fft_v2_store'
            && String(cfg.storage.localDiskDir) === 'D:\\stn\\fft_v2_store'
            && String(r2.note).indexOf('D:\\stn\\fft_v2_store') > 0;
    })(), () => ({ pk2: pk2, dir: cfg.storage && cfg.storage.localDiskDir }));
    delete globalThis.window.__TAURI_INTERNALS__;
    globalThis.window.showDirectoryPicker = keepW;

    // 取消 → 不写
    boot({});
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: 'keep_me' });
    globalThis.window.showDirectoryPicker = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
    const r3 = await syncAction('localDiskPick', {});
    A('B5 用户取消选择 → 不覆盖已填路径（保持原值），如实回报「已取消选择」', (() => {
        return r3.ok === false && String(cfg.storage.localDiskDir) === 'keep_me' && String(r3.note).indexOf('取消') >= 0;
    })(), () => ({ dir: cfg.storage && cfg.storage.localDiskDir, note: r3.note }));
    delete globalThis.window.showDirectoryPicker;
})();

// ---------- C 组：校验与解析 ----------
await (async () => {
    // 句柄探针：走句柄（写 → 回读 → 删），**不**解析成宿主路径
    boot({ storage: {} });
    const h = makeHandle('fft_v2_store');
    globalThis.window.showDirectoryPicker = async () => h;
    await localDiskPickDir();
    const rs = await localDiskResolveDir('@handle/fft_v2_store');
    const pr = await localDiskProbeDir('@handle/fft_v2_store');
    A('C1 句柄标记**不参与宿主路径解析**（原样返回，`resolved:false` + `handleMode:true`），探针走句柄并写→回读→删探针通过', (() => {
        return rs.ok === true && rs.dir === '@handle/fft_v2_store' && rs.resolved === false && rs.handleMode === true
            && pr.ok === true && pr.handleMode === true && pr.mechanism === 'fs-handle'
            && pr.dir === '@handle/fft_v2_store' && h._files.size === 0;      // 探针文件已删干净
    })(), () => ({ rs: rs, pr: pr, files: Array.from(h._files.keys()) }));

    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '@handle/fft_v2_store' });
    const info = localDiskInfo();
    A('C2 `localDiskInfo()` 句柄模式给界面足够的可读信息（标记 + 展示语 + 句柄是否活着）；`enabled` 为真', (() => {
        return info.enabled === true && info.handleMode === true && info.kind === 'handle'
            && info.dir === '@handle/fft_v2_store' && info.handleLive === true
            && String(info.display).indexOf('fft_v2_store') >= 0 && String(info.display).indexOf('绝对路径不可见') > 0;
    })(), () => ({ info: info }));

    // 句柄失效（刷新后）：探针如实报错、不写标记；界面给红字提示
    localDiskReset();
    cfg.storage = Object.assign({}, cfg.storage || {}, { localDiskDir: '@handle/fft_v2_store' });
    const pr2 = await localDiskProbeDir('@handle/fft_v2_store');
    const info2 = localDiskInfo();
    const html = String(storagePageHtml([]) || '');
    A('C3 句柄失效（刷新后）→ 校验如实回报 `handle-lost`（不解析成宿主路径、不假装成功）；界面红字提示重选，且 `enabled=false` 回退浏览器层', (() => {
        return pr2.ok === false && pr2.error === 'handle-lost' && String(pr2.note).indexOf('重新') > 0
            && info2.handleLive === false
            && html.indexOf('句柄已失效') > 0 && html.indexOf('重新「📂 选择文件夹…」') > 0;
    })(), () => ({ pr2: pr2, htmlLen: html.length, hasLost: html.indexOf('句柄已失效'), dir: info2.dir, enabled: info2.enabled }));
})();

R.done();
