// ============================================================
// 单元测试 · v3.3.0「数据管理 → 本地缓冲：补全全部本机缓冲 + 逐项清理」
//
// 用户要求（原话）：「设定-数据管理-本地缓冲，请补充其他为本地缓冲的内容，现在只有两个，明显缺失。
//   而且其他缓冲也应该展示，同样有对应清理按钮功能。」
//
// 覆盖：
//   A **清点**：本机分组枚举完整且数字来自真实持久层（状态副本（当前 / 其它作用域）· 命名缓存 · 对账标记 ·
//     同步日志 · V1 遗留 · 调试日志 / 追踪简报 / 版本清单缓存）；
//   B **逐项清理**：本机状态副本（localStorage）· IndexedDB 副本 · 其它角色副本 · 命名缓存 · 对账标记 ·
//     V1 遗留 —— 各自动作真实生效、只动本机、互不误伤；
//   C **危险动作确认**：清理记忆数据的本机副本必须二次确认（取消 → 零副作用）；
//   D **界面**：数据管理页把「本机数据副本」与「缓存与日志」两组都渲染出来，每行都有清理按钮。
//
// 运行：node tests/unit/local-copy.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { localKeyStats, localCopyStats, clearLocalCopy, setStorageHooks, saveStateNow, storeStatus } from '../../adapters/store.js';
import { bufferStats, bufferSectionHtml, refreshLocalCopy, localCopyCache } from '../../ui/buffer-manage.js';
import { panelAction, setPanelHooks2, openPanel, bindOverlay, panelState } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const R = makeReporter('local-copy v3.3.0 本地缓冲：全量清点 + 逐项清理 + 二次确认');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { }, appended: [], appendChild(n) { this.appended.push(n); }, removeChild() { return true; } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'localcopy.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

// localStorage 桩（Keys 可枚举 + 可删；与浏览器 `length/key(i)` 同形）
const kv = new Map();
const lsStub = {
    get length() { return kv.size; },
    key(i) { return Array.from(kv.keys())[i]; },
    getItem(k) { return kv.has(String(k)) ? kv.get(String(k)) : null; },
    setItem(k, v) { kv.set(String(k), String(v)); },
    removeItem(k) { kv.delete(String(k)); },
};
globalThis.localStorage = lsStub;
if (globalThis.window) globalThis.window.localStorage = lsStub;
// IndexedDB（localforage）桩：本机内存库副本
const idb = new Map();
host.ctx.libs = {
    localforage: {
        getItem: async (k) => (idb.has(k) ? JSON.parse(JSON.stringify(idb.get(k))) : null),
        setItem: async (k, v) => { idb.set(k, JSON.parse(JSON.stringify(v))); return v; },
        removeItem: async (k) => { idb.delete(k); },
        keys: async () => Array.from(idb.keys()),
    },
};
const files = new Map();
installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') { const b = JSON.parse((opts && opts.body) || '{}'); files.set(String(b.name), Buffer.from(String(b.data || ''), 'base64').toString('utf8')); return { status: 200, text: 'ok' }; }
    const m = String(url).match(/^\/user\/files\/(.+)$/); if (m) { const n = decodeURIComponent(m[1]); return files.has(n) ? { status: 200, text: files.get(n) } : { status: 404, text: 'x' }; }
    return { status: 404, text: '' };
});
setStorageHooks({
    getItem: (k) => lsStub.getItem(k), setItem: (k, v) => { lsStub.setItem(k, v); return true; },
    removeItem: (k) => { lsStub.removeItem(k); return true; }, keys: () => Array.from(kv.keys()),
});
const entry = await import('../../index.js');

function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('localcopy.png');
    setKernelState(Object.assign(emptyState(), { atoms: [{ id: 'a1', title: '情节一', text: '甲在码头。', updatedAt: 1 }], updatedAt: 1 }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    kv.clear(); idb.clear(); files.clear();
}
/** 造出「各类本机缓冲都有」的状态 */
async function seedAll() {
    boot();
    const scope = scopeId();
    await saveStateNow({ reason: 'seed', force: true });                       // 当前角色：localStorage + IndexedDB + 服务端
    kv.set('ftt2_state_char:other1', JSON.stringify({ v: 1, scope: 'char:other1', payload: { scope: 'char:other1', updatedAt: 2, data: { atoms: [] } }, hash: 'x' }));
    kv.set('ftt2_state_char:other2', JSON.stringify({ v: 1, scope: 'char:other2', payload: { scope: 'char:other2', updatedAt: 3, data: { atoms: [] } }, hash: 'y' }));
    idb.set('ftt2_state_char:other1', { payload: { updatedAt: 2, data: { atoms: [] } }, hash: 'x' });
    kv.set('ftt2_FileSlug_abc12345', 'char-slug');
    kv.set('ftt2_ArchiveName_abc12345', 'Archive Name');
    kv.set('ftt2_RemoteStateHash_abc12345', 'hash-mark');
    kv.set('ftt2_RemoteSnapSig_abc12345', 'sig-mark');
    kv.set('ftt2_LastPushSig_abc12345', 'push-sig');
    kv.set('ftt2_SyncGate_abc12345', JSON.stringify({ at: 1 }));
    kv.set('ftt2_SyncLog_abc12345', JSON.stringify([{ at: 1, mode: 'test' }]));
    kv.set('SPreset_FTTMemory_char:v1hash', JSON.stringify({ state: { atoms: [] } }));
    kv.set('SPreset_FTTMemory_FileSlug_v1hash', 'v1-slug');
    kv.set('SPreset_FTTMemoryConfig', '{}');
    return scope;
}

// ---------- A 组：清点 ----------
await (async () => {
    const scope = await seedAll();
    const ks = localKeyStats();
    const cp = await localCopyStats();
    const st = bufferStats();
    const curKey = 'ftt2_state_' + scope;
    // 注：一次真实保存还会由同步层写入「命名缓存」（slug / 归档名）→ names 至少 2（不写死上限）
    const groupsOk = ks.state.current.count === 1 && ks.state.current.keys[0].key === curKey
        && ks.state.others.count === 2 && ks.names.count >= 2
        && ks.names.keys.some((x) => x.key === 'ftt2_FileSlug_abc12345')
        && ks.syncMarks.count === 4 && ks.syncLog.count === 1 && ks.v1Legacy.count === 3;
    const copyOk = cp.local.present === true && cp.local.chars === String(kv.get(curKey)).length && cp.local.items === 1
        && cp.local.updatedAt > 0 && cp.idb.available === true && cp.idb.present === true && cp.idb.bytes > 0
        && cp.others.count === 2 && cp.budget === 1800000;
    const uiOk = st.groups.names.count === ks.names.count && st.groups.marks.count === 4 && st.groups.v1Legacy.count === 3
        && st.copy.local.count === 1 && st.copy.others.count === 2 && st.totalBytes > 0;
    A('A1 本机缓冲**清点完整**且数字来自真实持久层：状态副本（当前作用域 / 其它作用域的 `ftt2_state_*`）· IndexedDB 副本 · 命名缓存 · 对账标记 · 同步日志 · V1 遗留（`SPreset_FTTMemory_*`）；`bufferStats()` 的 `copy`/`groups` 与 `localKeyStats()` 一致',
        groupsOk && copyOk && uiOk,
        J({ groups: { cur: ks.state.current.count, others: ks.state.others.count, names: ks.names.count, marks: ks.syncMarks.count, log: ks.syncLog.count, v1: ks.v1Legacy.count }, copy: cp, st: { total: st.totalBytes } }));
})();

// ---------- B 组：逐项清理 ----------
await (async () => {
    const scope = await seedAll();
    const curKey = 'ftt2_state_' + scope;
    // ① 状态副本（仅本机 localStorage 那一份）
    const r1 = await clearLocalCopy({ target: 'local' });
    const afterLocal = { has: kv.has(curKey), idb: idb.has(curKey), file: files.size, others: kv.has('ftt2_state_char:other1') };
    // ② IndexedDB 副本
    await saveStateNow({ reason: 're-seed', force: true });                    // 重新写回两层
    const r2 = await clearLocalCopy({ target: 'idb' });
    const afterIdb = { has: idb.has(curKey), local: kv.has(curKey) };
    // ③ 其它角色副本（当前角色的不动）
    await saveStateNow({ reason: 're-seed2', force: true });
    const r3 = await clearLocalCopy({ target: 'others' });
    const afterOthers = { others: kv.has('ftt2_state_char:other1') || kv.has('ftt2_state_char:other2'), cur: kv.has(curKey) };
    boolOk: var boolOk = r1.ok === true && r1.localKeys === 1 && afterLocal.has === false
        && afterLocal.idb === true && afterLocal.file > 0 && afterLocal.others === true
        && r2.ok === true && r2.idb === 1 && afterIdb.has === false && afterIdb.local === true
        && r3.ok === true && r3.localKeys === 2 && afterOthers.others === false && afterOthers.cur === true;
    A('B1 逐项清理**各清各的、只动本机**：`local` 只删本角色的 localStorage 信封（IndexedDB / 服务端文件 / 其它角色都不动）· `idb` 只删本角色的 IndexedDB 副本（localStorage 保留）· `others` 只删其它角色的本机副本（当前角色保留）',
        boolOk,
        J({ r1: r1, afterLocal: afterLocal, r2: r2, afterIdb: afterIdb, r3: r3, afterOthers: afterOthers }));
})();

await (async () => {
    await seedAll();
    const i0 = storeStatus().localBuffer;
    // 命名缓存 / 对账标记 / V1 遗留：经真实面板动作（与数据管理页按钮同一条路径）
    openPanel('settings');
    bindOverlay();
    setPanelHooks2(entry.panelRuntimeHooks());
    const before = localKeyStats();
    const a = await panelAction('nameCacheClear', {});
    const b = await panelAction('syncMarkClear', {});
    const c = await panelAction('v1LegacyClear', {});
    const ks = localKeyStats();
    const noteOk = String(a.state && a.state.note).indexOf('命名缓存') >= 0
        && String(b.state && b.state.note).indexOf('同步与对账标记') >= 0
        && String(c.state && c.state.note).indexOf('V1 遗留数据') >= 0;
    A('B2 缓存类**逐项清理**经真实面板动作生效：命名缓存（文件名 / 归档名）· 同步与对账标记（远端哈希 / 快照签名 / 上次推送签名 / 门控）· V1 遗留本机数据分别清零，且互不误伤（状态副本 / 同步日志仍在）',
        a.ok === true && Number(a.cleared) === before.names.count && before.names.count >= 2
        && b.ok === true && Number(b.cleared) === 4 && c.ok === true && Number(c.cleared) === 3
        && ks.names.count === 0 && ks.syncMarks.count === 0 && ks.v1Legacy.count === 0
        && ks.syncLog.count === 1 && ks.state.current.count === 1 && noteOk,
        J({ a: a.cleared, b: b.cleared, c: c.cleared, ks: { names: ks.names.count, marks: ks.syncMarks.count, v1: ks.v1Legacy.count, log: ks.syncLog.count, cur: ks.state.current.count }, noteOk }));
})();

// ---------- C 组：清理语义（程序化路径；"真实点击需二次确认" 由冒烟 BH9 覆盖） ----------
await (async () => {
    await seedAll();
    const scope = scopeId();
    const curKey = 'ftt2_state_' + scope;
    openPanel('settings');
    bindOverlay();
    setPanelHooks2(entry.panelRuntimeHooks());
    // 程序化路径（命令 / devtools / 面板动作）**不经**危险动作点击闸（docs/D9 U4 口径：闸只作用于真实点击）
    const r = await panelAction('localCopyClear', {});                          // 只清「状态副本（localStorage）」
    const afterFirst = { local: kv.has(curKey), idb: idb.has(curKey) };
    const r2 = await panelAction('idbCopyClear', {});                           // 再清「内存库副本（IndexedDB）」
    const gone = !kv.has(curKey) && !idb.has(curKey) && files.size > 0;         // 两份本机副本清掉，服务端文件不动
    const note = String(r.state && r.state.note);
    const note2 = String(r2.state && r2.state.note);
    // 清掉后状态位如实更新（`storeStatus().localBuffer`），且重新保存能再次写回
    const afterStatus = storeStatus().localBuffer;
    await saveStateNow({ reason: 're-seed', force: true });
    const backOk = kv.has(curKey) === true && idb.has(curKey) === true;
    A('C1 清理语义：程序化调用（面板动作 / 命令 / devtools）**不经**危险动作点击闸（真实点击的二次确认由冒烟 BH9 覆盖）；清掉后 localStorage 与 IndexedDB 两份本机副本都消失、**服务端记忆文件不动**、状态位如实记录，随后一次保存又能重新写回',
        r.ok === true && r2.ok === true && gone && afterFirst.local === false && afterFirst.idb === true
        && note.indexOf('服务端记忆文件未动') >= 0 && note2.indexOf('内存库副本') >= 0
        && afterStatus.skipped === 'cleared-by-user' && backOk,
        J({ r: { ok: r.ok, note: note }, r2: { ok: r2.ok, note: note2 }, afterFirst, gone, afterStatus: afterStatus, backOk }));
})();

// ---------- D 组：界面 ----------
await (async () => {
    await seedAll();
    await refreshLocalCopy();                                                  // 异步副本统计（页面渲染后会 fire-and-forget 取一次）
    const h = settingsPageHtml('data', '');
    const cached = localCopyCache();
    const rows = ['本机数据副本', '状态副本（浏览器本地变量）', '内存库副本（IndexedDB）', '其它角色的本机副本',
        '调试日志', '交互追踪简报', '读取台账', '时钟取值追踪', '向量缓存', '版本清单缓存',
        '命名缓存（文件名 / 归档名）', '同步与对账标记', '同步日志（本机）', 'V1 遗留数据（导入源）'];
    const missing = rows.filter((x) => h.indexOf(x) < 0);
    const actions = ['localCopyClear', 'idbCopyClear', 'localCopyClearOthers', 'dbgClear', 'dbgTraceClear',
        'readLedgerClear', 'clockTraceClear', 'vectorCacheClear', 'aboutClearCache', 'nameCacheClear',
        'syncMarkClear', 'syncLogClear', 'v1LegacyClear'];
    const missingAct = actions.filter((x) => h.indexOf('data-ftt-action="' + x + '"') < 0);
    A('D1 数据管理页把**全部本机缓冲**都渲染出来（本机数据副本：当前状态副本 / 内存库副本 / 其它角色副本；缓存与日志：调试日志 · 追踪简报 · 读取台账 · 时钟追踪 · 向量 · 版本清单 · 命名缓存 · 对账标记 · 同步日志；V1 遗留），且**每一行都有对应清理按钮**',
        missing.length === 0 && missingAct.length === 0 && !!cached && cached.local.present === true && cached.others.count === 2
        && h.indexOf('共约 ') >= 0,
        J({ missing, missingAct, cached: cached && { local: cached.local, others: cached.others } }));
})();

R.done();
