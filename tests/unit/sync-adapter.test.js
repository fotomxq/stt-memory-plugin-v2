// ============================================================
// 单元测试 · B7-2 跨端同步适配层（文件通道 / 清单预判 / 快照文件 / 刷新与立即同步 / 流量门控 / 同步日志 / 校验）
// 口径：与 V1 `06-存储后端与三型归类.js` 的被动同步一致（去掉 V1 的多后端抽象，收敛为「本机缓冲 + 服务端记忆文件」）。
// 桩：内存文件系统（POST /api/files/upload + GET /user/files/<name>）+ 可注入 localStorage + 假定时器不必要（直接调同步 API）。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { storageEnvelope } from '../../core/envelope.js';
import { dataAggHash, snapshotSigOf } from '../../core/cross-sync.js';
import {
    setSyncStorageHooks, stateFileName, bakFileName, snapshotFileName, metaFileName, syncLogServerFile,
    storageSlug, scopeHash8, stateFileWrite, stateFileReadAny, metaFilePushNow, metaFileRead, metaStateSkipOk,
    metaSnapSkipOk, snapshotFilePushNow, snapshotFilePullMerge, snapshotSig, refreshFromServer, crossSyncManual,
    scheduleStorageSync, runStorageSync, syncFloorDiffersFromArchive, syncGateMark, latestFloorFingerprint,
    mirrorPushNeeded, mirrorPushMark, syncLogPush, syncLogList, syncLogClear, syncLogServerMerge, syncLogServerStatus,
    storageVerify, storageStatusInfo, resetSyncState, resetRemoteMarks, storageBootstrap, crossComputeInfo,
    stateFileEnabled, snapshotFileEnabled, syncLogServerEnabled, fileCacheStats, fileCacheDropAll,
} from '../../adapters/sync.js';
import { storagePageHtml, syncLogHtml, stateFileStatusHtml, syncAction, SYNC_ACTIONS } from '../../ui/sync.js';
import { SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { panelAction, openPanel, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('sync-adapter B7-2 跨端同步（文件通道 + 流量门控 + 同步日志）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 内存文件系统（ST 用户目录） ----------
const files = new Map();
const fetchCalls = [];
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const unHost = installGlobalHost(host, doc);
const unFetch = installGlobalFetch(async (url, opts) => {
    fetchCalls.push({ url, method: (opts && opts.method) || 'GET' });
    if (url.indexOf('/api/files/upload') === 0) {
        let body = null;
        try { body = JSON.parse(opts.body || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        let text = '';
        try { text = typeof atob === 'function' ? Buffer.from(String(body.data || ''), 'base64').toString('utf8') : String(body.data || ''); } catch (e) { text = ''; }
        files.set(String(body.name), text);
        return { status: 200, text: 'ok' };
    }
    const m = url.match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(name) };
    }
    return { status: 404, text: '' };
});

// ---------- 可注入 localStorage ----------
const lsm = new Map();
setSyncStorageHooks({
    get: (k) => (lsm.has(k) ? lsm.get(k) : null),
    set: (k, v) => { lsm.set(k, String(v)); return true; },
    del: (k) => { lsm.delete(k); return true; },
});

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 重启测试环境（同一文件系统/本机缓冲，便于模拟「另一端」） */
function boot(opts) {
    const o = opts || {};
    resetSyncState();
    resetRemoteMarks();
    files.clear();
    fetchCalls.length = 0;
    if (o.keepLocalStorage !== true) lsm.clear();
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey(o.scope || '甲');
    setIdentityView({ characterName: o.archive || '角色甲' });
    setKernelState(Object.assign(emptyState(), clone(o.state || { atoms: [atom('a1', '本地情节一')] })));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return state;
}
/** 装好「楼层正文」宿主上下文（V2 楼层哈希走 ctx.chat[idx]；楼层号走内核注入视图） */
function bootChat() {
    host.ctx.chat = [{ is_user: true, mes: '第一楼' }, { is_user: false, mes: '第二楼' }, { is_user: false, mes: '第三楼' }, { is_user: false, mes: '第四楼正文' }];
    setLastMessageId(3);
}
function atom(id, text, extra) {
    return Object.assign({ id, text, title: text, date: '1919-11-29', tags: [], uses: 0, floorStart: 1, floorEnd: 2, updatedAt: 1000 }, extra || {});
}
const envOf = (d) => { const e = storageEnvelope(d); return e; };

// ============================================================
// A 组：命名与开关
// ============================================================
boot();
R.assert('A1 文件名规则：主文件沿用 V2 既有命名（不孤立已写文件）；备份/快照/清单/日志带 `-<scope8>` 前缀区分', (() => {
    const sn = stateFileName(), b = bakFileName(), sp = snapshotFileName(), mf = metaFileName(), lg = syncLogServerFile();
    const s8 = scopeHash8();
    return sn.indexOf('ftt2-state-') === 0 && sn.slice(-5) === '.json'
        && b.indexOf('ftt2-bak-') === 0 && b.indexOf('-' + s8) > 0
        && sp.indexOf('ftt2-snap-') === 0 && sp.indexOf('-' + s8) > 0
        && mf.indexOf('ftt2-meta-') === 0 && mf.indexOf('-' + s8) > 0
        && lg.indexOf('ftt2-log-') === 0 && lg.indexOf('-' + s8) > 0
        && storageSlug().length > 0 && sn !== b && b !== sp && sp !== mf && mf !== lg;
})(), { sn: stateFileName(), b: bakFileName(), sp: snapshotFileName(), mf: metaFileName(), lg: syncLogServerFile() });

R.assert('A2 开关（V1 同名配置键）：stateFile / snapshotFile / syncLogServer / syncMetaProbe 关闭即停用', (() => {
    const on = stateFileEnabled() && snapshotFileEnabled() && syncLogServerEnabled();
    cfg.storage.stateFile = false; cfg.storage.snapshotFile = false; cfg.storage.syncLogServer = false;
    const off = !stateFileEnabled() && !snapshotFileEnabled() && !syncLogServerEnabled();
    Object.assign(cfg, clone(defaultCfg));
    return on && off;
})(), '');

// ============================================================
// B 组：记忆文件写入 + 清单预判
// ============================================================
await A('B1 写记忆文件：上传主文件 + 自动写备份 + 刷新清单/远端指纹（清单载荷含 name/hash/entries/snap.sig）', async () => {
    boot();
    const env = envOf(state);
    const r = await stateFileWrite(env, { bak: true });
    await metaFilePushNow(env, String(env.hash));
    const got = JSON.parse(files.get(stateFileName()) || 'null');
    const bak = JSON.parse(files.get(bakFileName()) || 'null');
    const meta = JSON.parse(files.get(metaFileName()) || 'null');
    return r.ok === true && r.bak === true && got && got.payload && bak && bak.payload
        && meta && meta.v === 1 && meta.state.name === stateFileName()
        && meta.state.hash === String(env.hash) && meta.state.entries >= 1
        && meta.snap && meta.snap.name === snapshotFileName() && typeof meta.snap.sig === 'string';
}, (() => ({ files: Array.from(files.keys()) }))());

await A('B2 清单预判命中：远端哈希 == 本端上次已合入 → metaStateSkipOk（跳过大文件下载，省流量）', async () => {
    const mm = await metaFileRead();
    const ok = metaStateSkipOk(mm);
    // 换一个远端哈希 → 不再命中
    const name = stateFileName();
    const before = files.get(name);
    // 模拟「远端文件被别的端改写」：清单里的文件级哈希不再等于本端已合入的哈希 → 不跳过
    files.set(metaFileName(), JSON.stringify({ v: 1, scope: JSON.parse(before).payload.scope, state: { name, hash: 'deadbeef' }, snap: { sig: 'x' } }));
    fileCacheDropAll();
    const mm2 = await metaFileRead();
    fileCacheDropAll();
    const nope = metaStateSkipOk(mm2);
    files.set(name, before);
    fileCacheDropAll();
    return ok === true && nope === false;
}, '');

// ============================================================
// C 组：快照链独立文件（上传 / 并集合并 / 清单命中跳过）
// ============================================================
await A('C1 快照文件上传：独立文件（含 snapStore + snapFp），签名与清单同步刷新', async () => {
    boot();
    state.snapStore = [{ id: 'root_a', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'ha', atomsHashes: { a1: 'h1' }, atoms: {} }];
    state.snapFp = { a1: { h: 'h1', cat: 'atoms' } };
    const r = await snapshotFilePushNow();
    await metaFilePushNow(null, '');                      // 远端推送后其清单同步（含最新快照签名）
    const got = JSON.parse(files.get(snapshotFileName()) || 'null');
    return r.ok === true && got && got.snapStore.length === 1 && got.snapFp && got.snapFp.a1
        && got.count === 1 && r.count === 1;
}, (() => files.get(snapshotFileName())));

await A('C2 快照并集合并：对端独立链补全本端（按 atomsHashes 去重 + ts 排序），并记录远端签名', async () => {
    // 远端文件里追加一条不同 atomsHashes 的增量
    const remote = {
        v: 1, scope: JSON.parse(files.get(snapshotFileName())).scope, updatedAt: Date.now(), count: 2,
        snapStore: [
            { id: 'root_a', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'ha', atomsHashes: { a1: 'h1' }, atoms: {} },
            { id: 'incr_b', kind: 'incr', ts: '2024-02-01T00:00:00.000Z', baseId: 'root_a', hash: 'hb', atomsHashes: { b1: 'h9' }, atoms: {} },
        ],
        snapFp: {},
    };
    files.set(snapshotFileName(), JSON.stringify(remote));
    // 对端推送后其清单里的快照签名随之为新链签名（本端据此判断「远端变了」→ 下载并并集合并）
    files.set(metaFileName(), JSON.stringify({ v: 1, scope: remote.scope, state: { name: stateFileName(), hash: 'x' }, snap: { sig: snapshotSigOf(remote.snapStore) } }));
    fileCacheDropAll();
    const changed = await snapshotFilePullMerge();
    const ids = (state.snapStore || []).map((s) => s.id);
    return changed === true && ids.length === 2 && ids[1] === 'incr_b';
}, (() => (state.snapStore || []).map((s) => s.id)));

await A('C3 清单预判命中：远端快照签名未变 → 跳过整份快照下载（零 GET）', async () => {
    // 远端再次推送后其清单里的快照签名 == 本端已合入的签名 → 本轮应直接跳过
    const rem = JSON.parse(files.get(snapshotFileName()));
    const sig = snapshotSigOf(rem.snapStore);
    files.set(metaFileName(), JSON.stringify({ v: 1, scope: rem.scope, state: { name: stateFileName(), hash: 'x' }, snap: { sig } }));
    fileCacheDropAll();
    fetchCalls.length = 0;
    const again = await snapshotFilePullMerge();
    // 只发一次「小清单」GET；**整份快照文件不下载**（流量保护的关键语义）
    const metaGets = fetchCalls.filter((c) => c.url.indexOf(encodeURIComponent(metaFileName())) >= 0).length;
    const snapGets = fetchCalls.filter((c) => c.url.indexOf(encodeURIComponent(snapshotFileName())) >= 0).length;
    return again === false && snapGets === 0 && metaGets >= 1;
}, (() => fetchCalls));

// ============================================================
// D 组：刷新状态（取服务端最新并合并）+ 墓碑不复活
// ============================================================
await A('D1 refreshFromServer：并入对端独有条目（本端独有保留）、并按双端墓碑剔除已删条目、回推服务端', async () => {
    boot();
    state.atoms = [atom('a1', '本地情节一'), atom('a2', '本地要删')];
    state.deleted = { atoms: { a2: 9000 } };                        // 本端删除墓碑
    const remote = Object.assign(emptyState(), {
        atoms: [atom('a1', '本地情节一'), atom('a2', '对端仍留着的旧条目'), atom('a5', '对端独有')],
        updatedAt: Date.now() + 1000,
    });
    const renv = envOf(remote);
    files.set(stateFileName(), JSON.stringify(renv));
    files.set(metaFileName(), JSON.stringify({ v: 1, scope: renv.payload.scope, state: { name: stateFileName(), hash: 'x' }, snap: { sig: 'y' } }));
    fileCacheDropAll();
    const rep = await refreshFromServer();
    const ids = state.atoms.map((x) => x.id).sort();
    return rep.err === '' && rep.file && rep.file.entries >= 2
        && ids.indexOf('a5') >= 0 && ids.indexOf('a1') >= 0
        && ids.indexOf('a2') < 0                                   // 墓碑挡住对端旧条目（删除不复活）
        && rep.merged && rep.merged.entries >= 2 && rep.pushed === true;
}, (() => ({ ids: state.atoms.map((x) => x.id), pushed: true })));

await A('D2 启动对账 storageBootstrap：清单命中 → 跳过远端下载（why=meta-unchanged），日志与服务端交叉合并', async () => {
    fileCacheDropAll();
    await metaFilePushNow(storageEnvelope(state), String(storageEnvelope(state).hash));
    fileCacheDropAll();
    const rep = await storageBootstrap();
    return rep && (rep.why === 'meta-unchanged' || rep.merged === false) && rep.log !== null;
}, (() => ({ why: 'meta-unchanged | merged=false' })));

// ============================================================
// E 组：「立即同步」四种处置（无对端 / 对端超集 / 本端超集 / 分歧融合）
// ============================================================
await A('E1 立即同步：无对端 → mode=none（日志记「无对端」，仍写本端 + 备份）', async () => {
    boot();
    const r = await crossSyncManual();
    const log = syncLogList();
    return r.mode === 'none' && log.length === 1 && log[0].action === '手动立即同步' && log[0].mode === '无对端'
        && files.has(stateFileName()) && files.has(bakFileName());
}, (() => ({ mode: (syncLogList()[0] || {}).mode })));

await A('E2 立即同步：对端为超集 → 整体采用对端（mode=replace / side=remote），本端删除墓碑仍生效', async () => {
    boot();
    state.atoms = [atom('a1', '本地情节一')];
    const remote = Object.assign(emptyState(), { atoms: [atom('a1', '本地情节一'), atom('a9', '对端新增')], updatedAt: Date.now() + 5000 });
    files.set(stateFileName(), JSON.stringify(envOf(remote)));
    fileCacheDropAll();
    const r = await crossSyncManual();
    const ids = state.atoms.map((x) => x.id).sort();
    return r.mode === 'replace' && r.side === 'remote' && r.info && r.info.mode === 'replace-remote'
        && ids.join(',') === 'a1,a9';
}, (() => ({ mode: 'replace-remote' })));

await A('E3 立即同步：本端为超集 → 保留本地（mode=replace / side=local），随后推送覆盖对端', async () => {
    boot();
    state.atoms = [atom('a1', '本地情节一'), atom('a8', '本地新增')];
    const remote = Object.assign(emptyState(), { atoms: [atom('a1', '本地情节一')], updatedAt: Date.now() - 5000 });
    files.set(stateFileName(), JSON.stringify(envOf(remote)));
    fileCacheDropAll();
    const r = await crossSyncManual();
    const pushed = JSON.parse(files.get(stateFileName()));
    return r.mode === 'replace' && r.side === 'local' && r.info.mode === 'replace-local'
        && (pushed.payload.data.atoms || []).length === 2;
}, (() => ({ n: (JSON.parse(files.get(stateFileName())).payload.data.atoms || []).length })));

await A('E4 立即同步：两端分歧（两边各有一条同 id 冲突且各自更新）→ 原子融合（mode=merge，冲突按更新方胜）', async () => {
    boot();
    state.atoms = [atom('a1', '本地较新', { updatedAt: 9000 }), atom('a2', '本地较旧', { updatedAt: 1000 })];
    const remote = Object.assign(emptyState(), {
        atoms: [atom('a1', '对端较旧', { updatedAt: 1000 }), atom('a2', '对端较新', { updatedAt: 9000 })],
        updatedAt: Date.now() + 1000,
    });
    files.set(stateFileName(), JSON.stringify(envOf(remote)));
    fileCacheDropAll();
    const info = crossComputeInfo(state, remote, remote.updatedAt);
    const r = await crossSyncManual();
    const byId = {};
    state.atoms.forEach((x) => { byId[x.id] = x.text; });
    const log = syncLogList()[0];
    return info.mode === 'divergence' && r.mode === 'merge' && byId.a1 === '本地较新' && byId.a2 === '对端较新'
        && log.mode === '双向原子融合' && Number(log.remoteN) >= 2;
}, (() => ({ a: state.atoms.map((x) => x.id + ':' + x.text) })));

// ============================================================
// F 组：流量门控（楼层哈希差异 + 镜像推送签名）
// ============================================================
await A('F1 楼层指纹：= {楼层号, 该楼正文稳定哈希}（V1 注释语义；V1 代码把正文传给只收楼层号的函数 → 见文档「偏差」）', async () => {
    boot();
    bootChat();
    const fp = latestFloorFingerprint();
    return !!fp && fp.f === 3 && String(fp.h).length > 0;
}, (() => latestFloorFingerprint()));

await A('F2 楼层门控四态：未归档 / 正文变化 / 已归档未同步 → differs；已归档且已同步 → 不 differs（零网络）', async () => {
    boot();
    bootChat();
    const fp = latestFloorFingerprint();
    state.processedFloors = [];
    const g1 = syncFloorDiffersFromArchive().why;                    // unarchived
    state.processedFloors = [{ f: 3, h: 'zzz' }];
    const g2 = syncFloorDiffersFromArchive().why;                    // changed
    state.processedFloors = [{ f: 3, h: fp.h }];
    const g3 = syncFloorDiffersFromArchive().why;                    // unsynced
    syncGateMark(fp);
    const g4 = syncFloorDiffersFromArchive();                        // same
    cfg.syncTrafficGuard = false;
    const g5 = syncFloorDiffersFromArchive().why;                    // guard-off
    cfg.syncTrafficGuard = true;
    return g1 === 'unarchived' && g2 === 'changed' && g3 === 'unsynced' && g4.differs === false && g4.why === 'same' && g5 === 'guard-off';
}, '');

await A('F3 镜像推送签名门控：内容变化 → 需推送；标记后同内容 → 跳过（不重复写回）', async () => {
    boot();
    state.atoms = [atom('a1', '一')];
    const n1 = mirrorPushNeeded();
    mirrorPushMark();
    const n2 = mirrorPushNeeded();
    state.atoms.push(atom('a2', '二'));
    const n3 = mirrorPushNeeded();
    cfg.syncTrafficGuard = false;
    const n4 = mirrorPushNeeded();
    cfg.syncTrafficGuard = true;
    return n1 === true && n2 === false && n3 === true && n4 === true;
}, '');

await A('F4 runStorageSync：楼层无差异 → 零网络请求跳过；force → 执行拉取合并并推送；同内容再跑 → 签名门控跳过', async () => {
    boot();
    bootChat();
    const fp = latestFloorFingerprint();
    state.processedFloors = [{ f: 3, h: fp.h }];
    syncGateMark(fp);
    fileCacheDropAll();
    fetchCalls.length = 0;
    const r1 = await runStorageSync(false);
    const netAfterSkip = fetchCalls.length;
    const r2 = await runStorageSync(true);
    const netAfterForce = fetchCalls.length;
    mirrorPushMark();
    state.processedFloors = [];                                       // 让楼层门控放行，命中签名门控
    const r3 = await runStorageSync(false);
    return r1.skipped === 'gate' && netAfterSkip === 0
        && (r2.ok >= 0 && r2.mode === 'push-only' || r2.mode === 'pull-merge-push') && netAfterForce > 0
        && r3.skipped === 'mirror-sig';
}, (() => ({ r2: 'ok' })));

R.assert('F5 scheduleStorageSync：syncOnSave=false 不调度；开启时返回已排程（防抖 3s 在 runStorageSync 内执行）', (() => {
    boot();
    cfg.storage.syncOnSave = false;
    const off = scheduleStorageSync(false);
    cfg.storage.syncOnSave = true;
    const on = scheduleStorageSync(false);
    resetSyncState();
    return off === false && on === true;
})(), '');

// ============================================================
// G 组：同步日志（本机环形 + 服务端交叉并集合并）
// ============================================================
await A('G1 本机日志：push 记录自动补 ts/src（设备·浏览器短码），新→旧，清空后为空', async () => {
    boot();
    syncLogClear();
    syncLogPush({ action: '第一条', note: 'n1', localN: 1 });
    syncLogPush({ action: '第二条', note: 'n2', localN: 2 });
    const list = syncLogList();
    const ok = list.length === 2 && list[0].action === '第二条' && Number(list[0].ts) > 0 && String(list[0].src || '').length > 0;
    syncLogClear();
    return ok && syncLogList().length === 0;
}, (() => syncLogList()));

await A('G2 服务端日志交叉合并：union 去重（ts 新→旧）+ 仅本机更全时回传（不整份覆盖对端）', async () => {
    boot();
    syncLogClear();
    const remoteLog = [{ ts: 500, src: 'B', action: '对端记录', mode: '推送', note: 'r', localN: 1, localHash: 'x' }];
    files.set(syncLogServerFile(), JSON.stringify(remoteLog));
    syncLogPush({ action: '本机记录', mode: '合并', note: 'l', localN: 2, localHash: 'y' });
    const r = await syncLogServerMerge({ force: true });
    const local = syncLogList();
    const up = JSON.parse(files.get(syncLogServerFile()));
    const hasBoth = local.some((x) => x.action === '对端记录') && local.some((x) => x.action === '本机记录');
    return r.ok === true && r.remoteN === 1 && r.mergedN === 2 && hasBoth && up.length === 2 && r.uploaded === true;
}, (() => ({ log: syncLogList(), server: files.get(syncLogServerFile()) })));

await A('G3 清空日志：本机清空 + 服务端镜像置空（避免下次启动把旧记录合回来）', async () => {
    syncLogClear();
    await sleep(10);
    const up = files.get(syncLogServerFile());
    return syncLogList().length === 0 && up === '[]';
}, (() => ({ up: files.get(syncLogServerFile()) })));

await A('G4 同步日志服务端状态：enabled/file/url 与开关联动', async () => {
    const s = syncLogServerStatus();
    cfg.storage.syncLogServer = false;
    const s2 = syncLogServerStatus();
    Object.assign(cfg, clone(defaultCfg));
    return s.enabled === true && s.file === syncLogServerFile() && s.url === '/user/files/' + syncLogServerFile() && s2.enabled === false;
}, '');

// ============================================================
// H 组：校验并修复 + 状态汇总
// ============================================================
await A('H1 storageVerify：逐后端（本机缓冲/主文件/备份/快照/清单）报告 has/ok；损坏后端会被「以有效源修复」', async () => {
    boot();
    const env = envOf(state);
    await stateFileWrite(env, { bak: true });
    state.snapStore = [{ id: 'root_a', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'ha', atomsHashes: { a1: 'h1' }, atoms: {} }];
    await snapshotFilePushNow();
    await metaFilePushNow(env, String(env.hash));
    const good = await storageVerify(false);
    // 破坏主文件哈希 → 校验失败，修复后重新写回一致内容
    const broken = JSON.parse(files.get(stateFileName()));
    broken.hash = 'broken';
    files.set(stateFileName(), JSON.stringify(broken));
    fileCacheDropAll();
    const bad = await storageVerify(true);
    const fixed = JSON.parse(files.get(stateFileName()));
    const badNames = (bad.details || []).filter((d) => d.has && !d.ok).map((d) => d.name);
    return good.details.length >= 4 && good.bad === 0 && badNames.length >= 1 && bad.repaired === true && fixed.hash !== 'broken';
}, (() => null));

R.assert('H2 storageStatusInfo：作用域/文件/快照/日志/远端指纹/门控 汇总齐备（调试与 UI 状态行同源）', (() => {
    boot();
    const s = storageStatusInfo();
    return !!s.scope && !!s.file && !!s.snapshot && !!s.log && !!s.gates && !!s.mirror
        && s.file.name === stateFileName() && typeof s.gates.traffic === 'boolean' && typeof s.gates.mirrorNeeded === 'boolean'
        && s.snapshot.name === snapshotFileName() && s.log.file === syncLogServerFile();
})(), (() => storageStatusInfo()));

// ============================================================
// I 组：UI（存储页分节 + 动作分发）
// ============================================================
R.assert('I1 存储页：V1 分节（记忆文件/原生存储/本机缓冲/一致性/世界书/状态与操作/同步日志）+ V1 同名动作按钮', (() => {
    const html = storagePageHtml(SETTINGS_CONTROLS.storage);
    return html.indexOf('记忆文件（服务端 · 核心基准）') >= 0 && html.indexOf('本机缓冲（仅缓冲 · 权威=记忆文件）') >= 0
        && html.indexOf('一致性') >= 0 && html.indexOf('世界书存储（单向写入 · 由下方开关联动）') >= 0
        && html.indexOf('状态与操作') >= 0 && html.indexOf('🔄 同步日志（最近 30 条 · 本角色）') >= 0
        && html.indexOf('data-ftt-action="storageStatusRefresh"') >= 0 && html.indexOf('data-ftt-action="storageSync"') >= 0
        && html.indexOf('data-ftt-action="storageVerify"') >= 0 && html.indexOf('data-ftt-action="syncLogRefresh"') >= 0
        && html.indexOf('data-ftt-action="syncLogClear"') >= 0 && html.indexOf('data-ftt-state-file-status') >= 0
        && html.indexOf('data-ftt-sync-log-status') >= 0 && html.indexOf('data-ftt-sync-log') >= 0;
})(), '');

await A('I2 面板动作接线：syncLogClear / syncLogRefresh / storageVerify / storageSync / storageStatusRefresh / worldbookRefresh 均经 panelAction 可达并回填提示', async () => {
    boot();
    openPanel('settings');
    setPanelHooks2({});
    await panelAction('settingsSub', { sub: 'storage' });
    const page = panelBodyHtml('settings');
    syncLogPush({ action: 'x', note: 'y' });
    const r1 = await panelAction('syncLogClear', {});
    const r2 = await panelAction('syncLogRefresh', {});
    const r3 = await panelAction('storageVerify', {});
    const r4 = await panelAction('storageSync', {});
    const r5 = await panelAction('storageStatusRefresh', {});
    const r6 = await panelAction('worldbookRefresh', {});
    return page.indexOf('data-ftt-settings-page="storage"') >= 0 && page.indexOf('data-ftt-action="storageSync"') >= 0
        && r1.ok === true && r1.note.indexOf('清空') >= 0
        && r2.ok === true && !!r2.note
        && r3.ok === true && !!r3.note
        && r4.ok === true && !!r4.note
        && r5.ok === true && !!r5.note
        && r6.ok === true && Array.isArray(r6.names) && String(r6.note).indexOf('世界书') >= 0   // B8-7：世界书列表刷新（无宿主接口时如实告警）
        && SYNC_ACTIONS.length === 8;      // B9-d：+syncPickLocal / syncPickRemote
}, (() => ({ acts: SYNC_ACTIONS })));

await A('I3 UI 动作直调：syncAction 未知动作不崩、日志 HTML 含「本地 → 对端 → 同步后」三段', async () => {
    boot();
    syncLogPush({ action: '保存后镜像', mode: '推送(门控)', changed: false, localN: 1, localBytes: 100, remoteN: 1, remoteBytes: 100, afterN: 1, afterBytes: 100, localHash: 'abcdef0123456789', remoteHash: '', afterHash: 'abcdef0123456789', note: '内容未变化' });
    const html = syncLogHtml();
    const bad = await syncAction('nope', {});
    return html.indexOf('本地 1 条') >= 0 && html.indexOf('→ 对端') >= 0 && html.indexOf('→ 同步后') >= 0
        && html.indexOf('abcdef012345') >= 0 && html.indexOf('内容未变化') >= 0
        && bad.ok === false && stateFileStatusHtml().indexOf('记忆文件') >= 0 && fileCacheStats().names >= 0;
}, '');

unFetch();
unHost();
R.done();
