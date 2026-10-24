// ============================================================
// 单元测试 · **货币跨端「金额 / 记录」同步**（v3.50.32，用户报告「货币跨端不同步金额、记录」）
//
// 三处根因（代码取证，缺一都不会出现「两端各说各话」）：
//   ① 保存**先写后拉**（`adapters/store.js#saveStateNowInner` 先整份写回服务端，3 秒后才由
//      「保存后镜像」去拉）→ 等它去拉时远端已被本端旧内存覆盖 → 对端刚记的金额/流水在服务端消失；
//   ② 会话内**读缓存无 TTL**（`adapters/sync.js#filesReadContentCached`）→ 自动路径读到的永远是本会话早先那份；
//   ③ 货币**没有条目级时间戳**（`core/model/money.js#normalizeCurrency` 从不写 `updatedAt`）→
//      冲突仲裁退化为「整份信封时间」（谁后保存谁赢）→ 另一端的较新额度被旧副本盖掉、流水被裁剪挤掉。
//
// 本档锁四组：
//   A 条目级修改时间（归一保留 / AI 落库打标 / 面板与快速记账打标）；
//   B 合并仲裁（账本时间优先于信封时间 · 流水并集 · 12 笔上限保留较新账本的记录）；
//   C 自动对账（回到前台 / 写前拉取：绕开会话读缓存 · 清单预判 · 开关与节流）；
//   D 保存流水线端到端（写主文件**之前**并入远端，写出的服务端文件里已是合并结果；清空/导入不拉取）。
// 反向探针：把 `mergeCurrencyEntry` 的流水顺序改回「本端在前」→ B3 必红；
//   去掉 `dropRemoteFileReadCache` → C5 必红；去掉保存流水线的写前拉取 → D1 必红。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { storageEnvelope, storageHash } from '../../core/envelope.js';
import { normalizeCurrency } from '../../core/model/money.js';
import { mergeCurrencyArrays, mergeDataObjects } from '../../core/cross-sync.js';
import { mergeDelta } from '../../core/ingest.js';
import { upsertEntry } from '../../core/entries.js';
import {
    setSyncStorageHooks, stateFileName, metaFileName, crossAutoPull, pullRemoteBeforeWrite,
    resetSyncState, fileCacheDropAll, autoPullInfo,
} from '../../adapters/sync.js';
import { saveStateNow } from '../../adapters/store.js';

const R = makeReporter('currency-cross-ledger v3.50.32 货币跨端金额/记录同步（账本时间戳 + 自动对账）');
const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra === undefined ? 'n/a' : extra);
};
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- 内存文件系统（酒馆用户目录）+ fetch 桩 ----------
const files = new Map();
const fetchCalls = [];
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
installGlobalFetch(async (url, opts) => {
    fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    if (String(url).indexOf('/api/files/upload') === 0) {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400 };
        let text = '';
        try { text = Buffer.from(String(body.data || ''), 'base64').toString('utf8'); } catch (e) { text = ''; }
        files.set(String(body.name), text);
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const name = decodeURIComponent(m[1]);
        if (!files.has(name)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(name) };
    }
    return { status: 404, text: '' };
});

const lsm = new Map();
setSyncStorageHooks({
    get: (k) => (lsm.has(k) ? lsm.get(k) : null),
    set: (k, v) => { lsm.set(k, String(v)); return true; },
    del: (k) => { lsm.delete(k); return true; },
});

/** 货币条目（`updatedAt` = 条目级账本修改时间；不传则不写该键） */
function cur(amount, history, updatedAt, extra) {
    const out = {
        id: 'cur_' + String(amount) + '_' + String(updatedAt || 0),
        owner: '主角', name: '银元', unit: '枚', amount: amount,
        history: clone(history || []), date: '1919-11-29', uses: 0, tags: [],
    };
    if (Number(updatedAt) > 0) out.updatedAt = Number(updatedAt);
    return Object.assign(out, extra || {});
}
const flow = (date, delta, note) => ({ date: date, delta: delta, note: note });

/** 重启测试环境（同一文件系统 / 本机缓冲，便于模拟「另一端」与「会话重启」） */
function boot(opts) {
    const o = opts || {};
    resetSyncState();
    fileCacheDropAll();
    files.clear();
    fetchCalls.length = 0;
    if (o.keepLocalStorage !== true) lsm.clear();
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:currency-cross');
    setIdentityView({ characterName: '角色甲' });
    setKernelState(Object.assign(emptyState(), clone(o.state || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return state;
}
/** 服务端主文件（= 对端写的那一份） */
function putRemote(data, at) {
    const env = storageEnvelope(clone(data));
    env.payload.updatedAt = Number(at) || Date.now();
    env.ts = env.payload.updatedAt;
    env.hash = storageHash(env.payload);
    files.set(stateFileName(), JSON.stringify(env));
    return env;
}
/** 服务端清单（让自动对账能走「清单预判」快速路径） */
function putRemoteMeta(env) {
    files.set(metaFileName(), JSON.stringify({
        v: 1, scope: env.payload.scope, ts: Date.now(),
        state: { name: stateFileName(), hash: String(env.hash || ''), entries: 0 },
        snap: { name: 'x', sig: 'y' }, log: { name: 'z', count: 0 },
    }));
    return env;
}
const mainGetsSince = (n) => fetchCalls.slice(n).filter((c) => c.method === 'GET' && c.url.indexOf(encodeURIComponent(stateFileName())) >= 0).length;
const amountOf = (list, name) => { const e = (list || []).filter((x) => x && x.name === (name || '银元'))[0]; return e ? Number(e.amount) : NaN; };
const histNotes = () => (((state.currencies || [])[0] || {}).history || []).map((f) => String((f && f.note) || ''));

setLastMessageId(3);

// ============================================================
// A 组：条目级修改时间（打标口径）
// ============================================================
await A('A1 `normalizeCurrency` 保留条目级 `updatedAt`；入参没给时**不写该键**（V1 黄金样本逐字不变）', () => {
    const withAt = normalizeCurrency({ owner: '主角', name: '银元', amount: 5, updatedAt: 1700000000123 });
    const noAt = normalizeCurrency({ owner: '主角', name: '银元', amount: 5 });
    const bad = normalizeCurrency({ owner: '主角', name: '银元', amount: 5, updatedAt: 'oops' });
    return withAt.updatedAt === 1700000000123
        && !Object.prototype.hasOwnProperty.call(noAt, 'updatedAt')
        && !Object.prototype.hasOwnProperty.call(bad, 'updatedAt');
}, () => normalizeCurrency({ owner: '主角', name: '银元', amount: 5 }));

await A('A2 AI 落库（`mergeDelta` 更新货币）→ 条目 `updatedAt` 被写入且**比旧条目新**（额度覆盖 + 流水追加不变）', () => {
    boot({ state: { currencies: [cur(62, [flow('1919-11-29', 62, '初始')], 1000)] } });
    const before = Number((state.currencies[0] || {}).updatedAt) || 0;
    mergeDelta({ 货币: { 更新: [{ 归属: '主角', 币种: '银元', 额度: 12, 单位: '枚', 收支: [{ 日期: '1919-11-30', 增减: '支出', 数额: 50, 说明: '买面包' }] }] } });
    const e = (state.currencies || [])[0] || {};
    return (Number(e.updatedAt) || 0) > before && Number(e.amount) === 12
        && Array.isArray(e.history) && e.history.length === 2 && String(e.history[1].note) === '买面包';
}, () => state.currencies);

await A('A3 面板编辑 / 快速记账（`upsertEntry`）同样打条目级时间戳（跨端按它取新）', () => {
    boot({ state: { currencies: [cur(62, [], 1000)] } });
    const before = Number((state.currencies[0] || {}).updatedAt) || 0;
    const ok = upsertEntry('currencies', { id: state.currencies[0].id, owner: '主角', name: '银元', amount: 112, unit: '枚' });
    const e = (state.currencies || [])[0] || {};
    return ok === true && Number(e.amount) === 112 && (Number(e.updatedAt) || 0) > before && e.updatedAt <= Date.now();
}, () => state.currencies);

// ============================================================
// B 组：合并仲裁（账本时间优先 · 流水并集 · 12 笔上限）
// ============================================================
await A('B1 同一条冲突：**条目时间更新的一方胜**，即便「信封时间」指向另一方（旧实现退化为信封时间）', () => {
    const localNew = cur(150, [], 2000);
    const remoteOld = cur(100, [], 1000);
    const a = mergeCurrencyArrays([localNew], [remoteOld], { preferRemote: true })[0];     // 信封看似「对端更新」
    const b = mergeCurrencyArrays([remoteOld], [localNew], { preferRemote: false })[0];    // 反向
    return Number(a.amount) === 150 && Number(b.amount) === 150;
}, () => ({
    preferRemote: mergeCurrencyArrays([cur(150, [], 2000)], [cur(100, [], 1000)], { preferRemote: true })[0],
    preferLocal: mergeCurrencyArrays([cur(100, [], 1000)], [cur(150, [], 2000)], { preferRemote: false })[0],
}));

await A('B2 `mergeDataObjects`：远端信封较新、但本端账本较新 → 额度取本端；**两端流水并集**（记录不丢）', () => {
    const local = { updatedAt: 1000, currencies: [cur(150, [flow('1919-11-29', 50, '卖船板')], 2000)] };
    const remote = { updatedAt: 9000, currencies: [cur(100, [flow('1919-11-30', -20, '买药')], 1000)] };
    const out = mergeDataObjects(clone(local), clone(remote), {}).data.currencies || [];
    const e = out[0] || {};
    const notes = (e.history || []).map((f) => String(f.note));
    return out.length === 1 && Number(e.amount) === 150
        && notes.indexOf('卖船板') >= 0 && notes.indexOf('买药') >= 0;
}, () => mergeDataObjects(clone({ updatedAt: 1000, currencies: [cur(150, [flow('1919-11-29', 50, '卖船板')], 2000)] }), clone({ updatedAt: 9000, currencies: [cur(100, [flow('1919-11-30', -20, '买药')], 1000)] }), {}).data.currencies);

await A('B3 流水 12 笔上限：两端各 12 笔时，**较新账本的 12 笔被完整保留**（旧实现把「对端」的 12 笔留下、本端较新记录被挤掉）', () => {
    const older = [];
    const newer = [];
    for (let i = 1; i <= 12; i++) older.push(flow('1919-11-' + String(i).padStart(2, '0'), i, '旧' + i));
    for (let i = 1; i <= 12; i++) newer.push(flow('1919-12-' + String(i).padStart(2, '0'), 100 + i, '新' + i));
    // 较新账本 = 本端（条目时间 2000）；信封时间故意指向对端（preferRemote:true）
    const e = mergeCurrencyArrays([cur(200, newer, 2000)], [cur(100, older, 1000)], { preferRemote: true })[0];
    const notes = (e.history || []).map((f) => String(f.note));
    return notes.length === 12 && notes.indexOf('新12') >= 0 && notes.indexOf('旧12') < 0;
}, () => {
    const older = []; const newer = [];
    for (let i = 1; i <= 12; i++) older.push(flow('1919-11-' + String(i).padStart(2, '0'), i, '旧' + i));
    for (let i = 1; i <= 12; i++) newer.push(flow('1919-12-' + String(i).padStart(2, '0'), 100 + i, '新' + i));
    return mergeCurrencyArrays([cur(200, newer, 2000)], [cur(100, older, 1000)], { preferRemote: true })[0];
});

// ============================================================
// C 组：自动对账（回到前台 / 写前拉取）
// ============================================================
await A('C1 回到前台自动对账：把对端较新的**额度**与**流水**并入本端（只并集，不整体替换）', async () => {
    boot({ state: { currencies: [cur(50, [flow('1919-11-29', 50, '初始')], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [flow('1919-12-01', 850, '卖货')], 2000)] }, 9000);
    putRemoteMeta(env);
    const rep = await crossAutoPull('visible', { force: true, from: 'test' });
    const notes = histNotes();
    return rep.ok === true && rep.changed === true && Number(amountOf(state.currencies)) === 900
        && notes.indexOf('初始') >= 0 && notes.indexOf('卖货') >= 0;
}, () => state.currencies);

await A('C2 清单预判：远端未变（清单哈希 == 本端已合入）→ 跳过主文件下载（零大文件 GET）', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [], 2000)] }, 9000);
    putRemoteMeta(env);
    await crossAutoPull('visible', { force: true });                 // 第一次：下载并合入（同时记下远端哈希）
    putRemoteMeta(env);                                             // 清单不变（对端没再改）
    const mark = fetchCalls.length;
    const rep = await crossAutoPull('visible', { force: true });     // 第二次：应命中清单预判
    return rep.skipped === 'unchanged' && mainGetsSince(mark) === 0;
}, () => autoPullInfo());

await A('C3 开关关闭（`storage.crossPullOnVisible = false`）→ 不动作、状态逐字节不变', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    cfg.storage.crossPullOnVisible = false;
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [], 2000)] }, 9000);
    putRemoteMeta(env);
    const before = J(state.currencies);
    const rep = await crossAutoPull('visible', { force: true });
    return rep.skipped === 'off' && J(state.currencies) === before && Number(amountOf(state.currencies)) === 50;
}, () => autoPullInfo());

await A('C4 节流：短时间内第二次「回到前台」不重复拉取；`force` 可绕开（手动/测试入口）', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [], 2000)] }, 9000);
    putRemoteMeta(env);
    const r1 = await crossAutoPull('visible', {});
    const r2 = await crossAutoPull('visible', {});
    const r3 = await crossAutoPull('visible', { force: true });
    return r1.ok === true && r2.skipped === 'throttled' && r3.ok === true;
}, () => autoPullInfo());

await A('C5 会话读缓存必须被绕过：先读旧远端，再换新远端 → 第二次自动对账**读到新内容**（根因②反向锁）', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    putRemote({ updatedAt: 9000, currencies: [cur(100, [], 2000)] }, 9000);
    const r1 = await crossAutoPull('visible', { force: true });
    putRemote({ updatedAt: 12000, currencies: [cur(888, [], 5000)] }, 12000);   // 对端又改了一次
    const r2 = await crossAutoPull('visible', { force: true });
    return r1.changed === true && r2.changed === true && Number(amountOf(state.currencies)) === 888;
}, () => state.currencies);

await A('C6 写前拉取 `pullRemoteBeforeWrite`：可用且已并入远端；`skipFile` 的本机层保存不受影响', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    putRemote({ updatedAt: 9000, currencies: [cur(700, [], 2000)] }, 9000);
    const rep = await pullRemoteBeforeWrite('test');
    const ok = await saveStateNow({ reason: 'test-skip-file', skipFile: true, force: true });
    return !!rep && rep.ok === true && Number(amountOf(state.currencies)) === 700 && !!ok;
}, () => state.currencies);

// ============================================================
// D 组：保存流水线端到端（写主文件之前并入远端）
// ============================================================
await A('D1 保存（force）→ **先并入远端再写主文件**：内存态与写出的服务端文件里都是合并后的额度（旧实现写出去的是旧内存）', async () => {
    boot({ state: { currencies: [cur(50, [flow('1919-11-29', 50, '初始')], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [flow('1919-12-01', 850, '卖货')], 2000)] }, 9000);
    putRemoteMeta(env);
    const w = await saveStateNow({ reason: 'test-write', force: true });
    const pushed = JSON.parse(String(files.get(stateFileName()) || '{}'));
    const pushedCur = (((pushed || {}).payload || {}).data || {}).currencies || [];
    return !!w && w.ok === true && Number(amountOf(state.currencies)) === 900
        && Number(amountOf(pushedCur)) === 900 && histNotes().indexOf('卖货') >= 0;
}, () => ({ mem: state.currencies }));

await A('D2 清空 / 导入这类「用户显式替换」保存：`pullRemote:false` → **不把对端旧数据并回来**（清得掉、导得进）', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [], 2000)] }, 9000);
    putRemoteMeta(env);
    const w = await saveStateNow({ reason: 'reset', force: true, pullRemote: false });
    const pushed = JSON.parse(String(files.get(stateFileName()) || '{}'));
    const pushedCur = (((pushed || {}).payload || {}).data || {}).currencies || [];
    return !!w && w.ok === true && Number(amountOf(state.currencies)) === 50 && Number(amountOf(pushedCur)) === 50;
}, () => state.currencies);

await A('D3 幂等：对同一份远端连续两次自动对账，第二次不再改动本端（清单命中 → 不重复合入）', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    const env = putRemote({ updatedAt: 9000, currencies: [cur(900, [], 2000)] }, 9000);
    putRemoteMeta(env);
    const r1 = await crossAutoPull('visible', { force: true });
    const first = J(state.currencies);
    const r2 = await crossAutoPull('visible', { force: true });
    return r1.changed === true && (r2.skipped === 'unchanged' || r2.changed === false) && J(state.currencies) === first;
}, () => state.currencies);

await A('D4 兜底：无远端不抛（ok=true + skipped）；重复调用不产生重复条目', async () => {
    boot({ state: { currencies: [cur(50, [], 1000)] } });
    const r = await crossAutoPull('visible', { force: true });                 // 无远端
    const r2 = await crossAutoPull('visible', { force: true });
    return r.ok === true && (r.skipped === 'no-remote' || r.skipped === 'unchanged')
        && r2.ok === true && (state.currencies || []).length === 1;
}, () => autoPullInfo());

R.done();
