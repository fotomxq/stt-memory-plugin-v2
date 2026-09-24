// ============================================================
// 单元测试 · B9-d 跨端同步分歧选择（与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/fixtures/gen-v1-golden-sync-pick.cjs` 直调生成）：
//   tests/fixtures/v1-golden-sync-pick.json
//   （`crossComputeInfo` / 自动对账分歧暂存 / 分歧横幅 / `syncPickLocal` / `syncPickRemote` /
//     同步日志留痕 / `applyRemoteReplaceState` / `adoptRemoteEnvelope`）
// 覆盖：R1–R7 V1 逐项比对；V1–V4 V2 编排与接线（自动同步不静默合并 + 横幅渲染 + 面板动作 + FTT 入口）。
// 与 V1 的动作来源差异（如实记录）：V1 的自动对账入口是 `crossPullPolicy`（同步日志 action 取触发源标签），
//   V2 无该函数，等价入口是 `adapters/sync.js#runStorageSync`（「保存后镜像」）→ 日志 action 为 `保存后镜像`；
//   比对时**只比 mode/note/changed/条数**（action 属触发源标签，非处置语义）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import {
    cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setTimerHooks, setNotifyHooks,
    setChatHooks, setLastMessageId,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { storageEnvelope, storageHash } from '../../core/envelope.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    setSyncStorageHooks, stateFileName, bakFileName, stateFileReadAny, stateFileWrite, crossComputeInfo, crossPendingGet,
    crossPendingView, crossPendingClear, applyRemoteReplaceState, adoptRemoteEnvelope, runStorageSync,
    syncLogList, syncLogClear, resetSyncState, resetRemoteMarks, fileCacheDropAll, fileCacheStats,
} from '../../adapters/sync.js';
import { runAutoSummary } from '../../host/extract.js';
import { divergenceBannerHtml, storagePageHtml, syncAction, SYNC_ACTIONS } from '../../ui/sync.js';
import { SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { panelAction, openPanel, panelBodyHtml, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-sync-pick.json'), 'utf8'));
const R = makeReporter('sync-pick-golden B9-d 跨端同步分歧选择（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 字节精确的内存文件系统 ----------
const files = new Map();
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const unHost = installGlobalHost(host, doc);
const unFetch = installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        files.set(String(body.name), new Uint8Array(Buffer.from(String(body.data || ''), 'base64')));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, bytes: files.get(name) };
    }
    return { status: 404, text: '' };
});

const lsm = new Map();
setSyncStorageHooks({
    get: (k) => (lsm.has(k) ? lsm.get(k) : null),
    set: (k, v) => { lsm.set(k, String(v)); return true; },
    del: (k) => { lsm.delete(k); return true; },
});
let toasts = [];
setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 场景取自 fixture 的 `scenario`（与 V1 oracle 同一输入，避免手抄漂移）
const LOCAL = clone(G.scenario.local);
const REMOTE_DATA = clone(G.scenario.remote);

/** 分歧场景：本端 L1 + x1=70；对端文件 R1 + x1=40（无端是超集） */
function boot(opts) {
    const o = opts || {};
    resetSyncState(); resetRemoteMarks();
    files.clear(); lsm.clear(); fileCacheDropAll();
    Object.assign(cfg, clone(defaultCfg));
    cfg.storage.stateFile = true; cfg.storage.stateFileBak = true; cfg.storage.snapshotFile = true;
    cfg.storage.syncMetaProbe = false; cfg.storage.syncLogServer = false;
    cfg.syncTrafficGuard = false;
    setScopeKey('甲');
    setIdentityView({ characterName: '角色甲' });
    setKernelState(Object.assign(emptyState(), clone(LOCAL)));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    toasts = [];
    if (o.withRemote !== false) putRemote();
    return state;
}
/** 写入「对端」的主文件 + 备份文件（与真实对端一致：两者都存在；否则 `crossFindRemoteEnv` 会挑到本端刚写的备份） */
function putRemote(data, ts) {
    const d = clone(data || REMOTE_DATA);
    const t = Number(ts) || 1700000003000;
    const env = storageEnvelope(Object.assign({}, state, d));
    env.ts = t;
    env.payload.updatedAt = t;
    env.hash = storageHash(env.payload);
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(env), 'utf8'));
    files.set(stateFileName(), bytes);
    files.set(bakFileName(), bytes);
    return env;
}
const stateView = () => ({
    atomIds: (state.atoms || []).map((x) => x.id).sort(),
    stateValues: (state.currentStates || []).map((x) => x.id + '=' + x.value).sort(),
});
const pendingProj = () => {
    const p = crossPendingView();
    if (!p) return null;
    return { hasEnv: p.hasEnv, localN: p.localN, remoteN: p.remoteN, tsDiff: p.tsDiff, onlyLocal: p.onlyLocal, onlyRemote: p.onlyRemote, conflict: p.conflict };
};
/** 同步日志投影（剔除 ts/ms/src 时间/环境派生值） */
const logsProj = () => syncLogList().map((r) => ({ action: String(r.action || ''), mode: String(r.mode || ''), changed: !!r.changed, localN: Number(r.localN) || 0, remoteN: Number(r.remoteN) || 0, afterN: Number(r.afterN) || 0, note: String(r.note || '') }));

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================
boot();
R.assert('R1 crossComputeInfo 分歧判定与 V1 逐字一致（divergence + onlyLocal/onlyRemote/conflict 统计），且单端超集/一致两态判定一致（非恒真）', (() => {
    const info = crossComputeInfo(state, clone(REMOTE_DATA), REMOTE_DATA.updatedAt);
    const localSupData = Object.assign({}, clone(REMOTE_DATA), { atoms: REMOTE_DATA.atoms.concat(LOCAL.atoms) });
    const localSup = crossComputeInfo(localSupData, clone(REMOTE_DATA), REMOTE_DATA.updatedAt);
    const same = crossComputeInfo(clone(REMOTE_DATA), clone(REMOTE_DATA), REMOTE_DATA.updatedAt);
    return info.mode === G.computeInfo.mode && info.aggSame === G.computeInfo.aggSame
        && info.localN === G.computeInfo.localN && info.remoteN === G.computeInfo.remoteN
        && info.tsDiff === G.computeInfo.tsDiff && info.newer === G.computeInfo.newer
        && info.diff.same === G.computeInfo.diff.same && info.diff.onlyLocal === G.computeInfo.diff.onlyLocal
        && info.diff.onlyRemote === G.computeInfo.diff.onlyRemote && info.diff.conflict === G.computeInfo.diff.conflict
        && info.diff.conflictWinLocal === G.computeInfo.diff.conflictWinLocal && info.diff.conflictWinRemote === G.computeInfo.diff.conflictWinRemote
        && localSup.mode === G.computeControls.localSuperset && same.mode === G.computeControls.same;
})(), (() => crossComputeInfo(state, clone(REMOTE_DATA), REMOTE_DATA.updatedAt))());

await A('R2 自动同步遇分歧：暂存待选（不静默合并）+ 同步日志 mode/note/条数与 V1 一致 + 本端数据未被改动', async () => {
    boot();
    const before = stateView();
    const r = await runStorageSync(true);
    const logs = logsProj();
    const div = logs.filter((x) => x.mode === '分歧待选择')[0];
    const gd = G.divergence.logs[0];
    return crossPendingGet() !== null
        && pendingProj() !== null
        && pendingProj().localN === G.divergence.pendingAfterPull.localN && pendingProj().remoteN === G.divergence.pendingAfterPull.remoteN
        && pendingProj().onlyLocal === G.divergence.pendingAfterPull.onlyLocal && pendingProj().onlyRemote === G.divergence.pendingAfterPull.onlyRemote
        && pendingProj().conflict === G.divergence.pendingAfterPull.conflict
        && !!div && div.changed === gd.changed && div.localN === gd.localN && div.remoteN === gd.remoteN
        && div.afterN === gd.afterN && div.note === gd.note
        && J(stateView()) === J(before)                    // 不静默合并：本端 L1/x1=70 未被对端覆盖
        && String(r.mode || '').indexOf('pull-merge-push') >= 0 && r.divergence === 'divergence';
}, (() => ({ pending: pendingProj(), logs: logsProj() }))());

await A('R3 已有更新待选时不重复暂存（V1 只保留最新一份对端信封，mode=`分歧(已暂存较新待选)`）', async () => {
    boot();
    await runStorageSync(true);
    const p1 = crossPendingGet();
    syncLogClear();
    // 同一份对端再对账一次（updatedAt 相同 → 不覆盖）：重放远端文件（上一轮已把本端推送覆盖过去）
    putRemote();
    fileCacheDropAll();
    await runStorageSync(true);
    const p2 = crossPendingGet();
    const logs = logsProj();
    const dup = logs.filter((x) => x.mode === '分歧(已暂存较新待选)')[0];
    return !!p1 && !!p2 && Number(p2.env.payload.updatedAt) === Number(p1.env.payload.updatedAt)
        && Number(p2.info.localN) === Number(p1.info.localN)
        && !!dup && dup.note === '已有更新的分歧待选，未重复暂存' && dup.changed === false
        && String(G.meta.notes.join('')).indexOf('分歧(已暂存较新待选)') >= 0;
}, (() => logsProj()));

await A('R5 分歧横幅渲染（异步暂存后）：与 V1 黄金逐字一致（标题/统计归一形态/按钮 class·文案/无 title）', async () => {
    boot();
    await runStorageSync(true);
    const html = String(divergenceBannerHtml());
    const gb = G.divergence.banner;
    const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const btn = (action) => {
        const m = html.match(new RegExp('<button class="([^"]*)" data-ftt-action="' + action + '"([^>]*)>([^<]*)</button>'));
        if (!m) return null;
        return { cls: m[1], hasTitleAttr: /title=/.test(String(m[2] || '')), text: m[3] };
    };
    const lb = btn('syncPickLocal'), rb = btn('syncPickRemote');
    const desc = grab(/<div class="ftt-desc ftt-my-1">([\s\S]*?)<\/div>/);
    const descNorm = desc === null ? null : String(desc).replace(/（更新 [^）]*）/g, '（更新 <t>）');
    return html.indexOf('ftt-warn-box') >= 0 && html.indexOf('ftt-pend-title') >= 0
        && grab(/<b class="ftt-pend-title">([^<]*)<\/b>/) === gb.title
        && descNorm === gb.descNorm
        && html.indexOf('ftt-row ftt-mt-2') >= 0
        && lb && rb && lb.cls === gb.localBtn.cls && lb.text === gb.localBtn.text && lb.hasTitleAttr === false && gb.localBtn.hasTitleAttr === false
        && rb.cls === gb.remoteBtn.cls && rb.text === gb.remoteBtn.text && rb.hasTitleAttr === false && gb.remoteBtn.hasTitleAttr === false;
}, (() => ({ golden: G.divergence.banner, v2: divergenceBannerHtml() }))());

await A('R6 syncPickLocal「保留本端（覆盖对端）」：清空待选 + 写服务端文件 + 留痕 `分歧选择/保留本端(覆盖对端)` + 提示，与 V1 逐项一致，本端数据保留', async () => {
    boot();
    await runStorageSync(true);
    syncLogClear();
    toasts = [];
    const before = stateView();
    const r = await syncAction('syncPickLocal', {});
    const logs = logsProj();
    const gl = G.pickLocal.logs[0];
    return r.ok === true && r.action === 'syncPickLocal'
        && crossPendingGet() === null
        && logs.length === 1 && logs[0].action === gl.action && logs[0].mode === gl.mode
        && logs[0].changed === gl.changed && logs[0].localN === gl.localN && logs[0].remoteN === gl.remoteN
        && logs[0].note === gl.note
        && toasts.length === 1 && toasts[0][0] === 'success'
        && toasts[0][1] === (G.pickLocal.toasts[0].title + ' ' + G.pickLocal.toasts[0].text)
        && J(stateView()) === J(before) && files.has(stateFileName()) && String(r.note).indexOf('已保留本地版本') >= 0;
}, (() => ({ logs: logsProj(), toasts, pending: pendingProj() }))());

await A('R7 syncPickRemote「采用对端（整体替换）」：清空待选 + `applyRemoteReplaceState` 整体替换 + 留痕 `采用对端(整体替换)` + 提示，与 V1 逐项一致', async () => {
    boot();
    await runStorageSync(true);
    syncLogClear();
    toasts = [];
    const r = await syncAction('syncPickRemote', {});
    const logs = logsProj();
    const gl = G.pickRemote.logs[0];
    return r.ok === true && r.action === 'syncPickRemote'
        && crossPendingGet() === null
        && logs.length === 1 && logs[0].action === gl.action && logs[0].mode === gl.mode
        && logs[0].changed === gl.changed && logs[0].localN === gl.localN && logs[0].remoteN === gl.remoteN
        && logs[0].note === gl.note
        && toasts.length === 1 && toasts[0][0] === 'success'
        && toasts[0][1] === (G.pickRemote.toasts[0].title + ' ' + G.pickRemote.toasts[0].text)
        && J(stateView()) === J({ atomIds: G.pickRemote.stateAfter.atomIds, stateValues: G.pickRemote.stateAfter.stateValues })
        && Number(state.updatedAt) === G.pickRemote.stateAfter.updatedAt
        && files.has(stateFileName());
}, (() => ({ logs: logsProj(), toasts, state: stateView() }))());

await A('R8 无待选时点「采用对端」：留痕 `未找到待选对端`（changed=false）+ 警示提示 + **不改动本端**（V1 原样）', async () => {
    boot();
    syncLogClear();
    toasts = [];
    const before = stateView();
    const r = await syncAction('syncPickRemote', {});
    const logs = logsProj();
    const gl = G.pickRemoteNoPending.logs[0];
    return r.ok === false
        && logs.length === 1 && logs[0].mode === gl.mode && logs[0].changed === gl.changed && logs[0].note === gl.note
        && toasts.length === 1 && toasts[0][0] === 'warning'
        && toasts[0][1] === G.pickRemoteNoPending.toasts[0].title
        && J(stateView()) === J(before) && G.pickRemoteNoPending.stateUnchanged === true;
}, (() => ({ logs: logsProj(), toasts }))());

await A('R9 applyRemoteReplaceState / adoptRemoteEnvelope 直调：整体采用对端（与 V1 黄金 atomIds/字段值一致）', async () => {
    boot();
    const env = storageEnvelope(Object.assign({}, state, clone(REMOTE_DATA)));
    const r = applyRemoteReplaceState(env);
    const after = stateView();
    const adopted = adoptRemoteEnvelope(env);
    return r === G.applyReplace.ret
        && J(after.atomIds) === J(G.applyReplace.atomIds) && J(after.stateValues) === J(G.applyReplace.stateValues)
        && adopted === G.adoptEnvelope.ret && J(stateView().atomIds) === J(G.adoptEnvelope.atomIds);
}, (() => ({ state: stateView() }))());

await A('R10 长任务在途（提取进行中）→「整体替换」降级为并集合并（V1 `userWriteInFlight` 口径：返回 `merge`，两端条目都保留）', async () => {
    boot();
    // 制造一个真实的「提取在途」窗口：AI 钩子返回受控 Promise（断言期间保持 busy）
    let release = null;
    const gate = new Promise((res) => { release = res; });
    host.ctx.chat = [{ is_user: true, mes: '一' }, { is_user: false, mes: '二' }, { is_user: false, mes: '三' }, { is_user: false, mes: '四' }];
    setLastMessageId(3);
    const running = runAutoSummary({ ai: () => gate.then(() => ({ ok: true, text: '{"summaries":[{"title":"甲","content":"甲在地点丁发现物品戊。"}]}' })) });
    await sleep(10);
    const env = storageEnvelope(Object.assign({}, state, clone(REMOTE_DATA)));
    const ret = applyRemoteReplaceState(env);
    const merged = stateView();
    release();
    await running;
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai' }), feedText: () => '', busy: () => false });
    // 降级为并集合并 → 本端 L1 与对端 R1 都在；x1 冲突按更新方胜（对端 40）
    return ret === 'merge'
        && merged.atomIds.indexOf('L1') >= 0 && merged.atomIds.indexOf('R1') >= 0
        && merged.stateValues.indexOf('x1=40') >= 0;
}, (() => ({ ret: 'merge', state: stateView() }))());

// ============================================================
// V 组：V2 编排与接线
// ============================================================
await A('V1 面板接线：`syncPickLocal`/`syncPickRemote` 进入 `SYNC_ACTIONS`（8 项）并经 `panelAction` 可达、提示写入 `panelState().note`；存储页仅在有待选时渲染横幅', async () => {
    boot();
    openPanel('settings'); setPanelHooks2({});
    await panelAction('settingsSub', { sub: 'storage' });
    const page0 = String(panelBodyHtml('settings') || '');
    const pageModules = storagePageHtml(SETTINGS_CONTROLS.storage);
    await runStorageSync(true);
    const page1 = String(panelBodyHtml('settings') || '');
    const r1 = await panelAction('syncPickLocal', {});
    const note = String(panelState().note || '');
    return SYNC_ACTIONS.length === 8 && SYNC_ACTIONS.indexOf('syncPickLocal') >= 0 && SYNC_ACTIONS.indexOf('syncPickRemote') >= 0
        && pageModules.indexOf('data-ftt-action="syncPickLocal"') < 0
        && page0.indexOf('data-ftt-action="syncPickLocal"') < 0
        && page1.indexOf('data-ftt-action="syncPickLocal"') >= 0 && page1.indexOf('data-ftt-action="syncPickRemote"') >= 0
        && page1.indexOf('⚠️ 跨端同步分歧 · 请选择保留哪个版本') >= 0
        && r1.ok === true && r1.action === 'syncPickLocal' && note.indexOf('已保留本地版本') >= 0;
}, (() => ({ note: panelState().note }))());

await A('V2 自动同步不静默合并（V2 编排差异）：分歧时 `runStorageSync` 返回 divergence 且提示已发；重新对账可再次暂存（选择后可继续收敛）', async () => {
    boot();
    toasts = [];
    const r1 = await runStorageSync(true);
    const t1 = toasts.slice();
    await syncAction('syncPickLocal', {});
    // 「保留本端」后把对端改成更新的超集 → 下一次自动对账应走合并（不再分歧）
    const sup = Object.assign({}, clone(REMOTE_DATA), { atoms: REMOTE_DATA.atoms.concat(LOCAL.atoms, [{ id: 'R2', text: '对端新增补充', title: '补充', date: '1936-12-08', tags: [], uses: 1, floorStart: 0, floorEnd: 2 }]), updatedAt: 1700000004000 });
    putRemote(sup, 1700000004000);
    fileCacheDropAll();
    syncLogClear();
    const r2 = await runStorageSync(true);
    const logs = logsProj();
    return r1.divergence === 'divergence' && t1.length === 1 && t1[0][0] === 'warning'
        && t1[0][1].indexOf('跨端记忆存在分歧') >= 0
        && crossPendingGet() === null
        && String(r2.divergence || '') === ''
        && !logs.some((x) => x.mode === '分歧待选择')
        && (state.atoms || []).some((x) => x.id === 'R2');
}, (() => ({ r1: 'divergence', logs: logsProj(), toasts }))());

R.assert('V3 FTT 入口齐备（V1 `__FTT` 同名能力）：crossComputeInfo / crossPendingGet / crossPendingView / crossPendingClear / applyRemoteReplaceState / adoptRemoteEnvelope', (() => {
    boot();
    const on = installDevtools({
        crossComputeInfo: (l, r, t) => crossComputeInfo(l, r, t),
        crossPendingGet: () => crossPendingGet(),
        crossPendingView: () => crossPendingView(),
        crossPendingClear: () => crossPendingClear(),
        applyRemoteReplaceState: (e) => applyRemoteReplaceState(e),
        adoptRemoteEnvelope: (e) => adoptRemoteEnvelope(e),
    });
    const F = globalThis.FTT;
    const names = ['crossComputeInfo', 'crossPendingGet', 'crossPendingView', 'crossPendingClear', 'applyRemoteReplaceState', 'adoptRemoteEnvelope'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const info = F.crossComputeInfo(state, clone(REMOTE_DATA), REMOTE_DATA.updatedAt);
    const cleared = F.crossPendingClear();
    uninstallDevtools();
    return on === true && missing.length === 0 && info.mode === G.computeInfo.mode && cleared === true && globalThis.FTT === undefined;
})(), '');

await A('V4 FTT 无 hook 时按约定降级（不抛错），devtools 侧 `typeof` 守卫生效', async () => {
    boot();
    installDevtools({});
    const p = globalThis.FTT.crossPendingGet();
    const v = globalThis.FTT.crossPendingView();
    const c = globalThis.FTT.crossPendingClear();
    const rep = globalThis.FTT.applyRemoteReplaceState(null);
    uninstallDevtools();
    return p === null && v === null && c === false && rep === false && globalThis.FTT === undefined
        && crossPendingGet() === null && fileCacheStats().names >= 0;
}, '');

unFetch();
unHost();
R.done();
