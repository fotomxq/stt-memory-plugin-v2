// ============================================================
// 单元测试 · v3.0.22 总览「💾 保存（对齐所有存储）」
//
// 用户要求（原话）：「新版本 总览新增保存按钮，可对齐已开启的所有存储，包括内存、浏览器本地变量、服务端等，
//   全部对齐数据。」
//
// 语义：把**当前内存数据**依次写到**每一层已开启的存储**，并逐层回报（ok / skipped / error）：
//   本机缓冲（localStorage）· IndexedDB · 服务端记忆文件 · **分片**（本次强制全量 → 与内存逐字节一致）·
//   快照文件 · 清单文件 · 世界书镜像 · 跨端镜像 · 配置。
//
// 运行：node tests/unit/save-all.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { setKernelState, setScopeKey, setPersistHooks, cfg, resetWriteGate } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import { setStorageHooks } from '../../adapters/store.js';
import { stateFileName } from '../../adapters/user-file.js';
import { shardName, shardManifestName, resetShardMarks, SHARD_DIMS, META_SHARD } from '../../adapters/shards.js';

const R = makeReporter('save-all v3.0.22 总览「💾 保存（对齐所有存储）」');
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'saveall.png' }];
host.ctx.characterId = 0;
host.ctx.name2 = '角色甲';
const unHost = installGlobalHost(host, doc);
setContextProvider(() => host.ctx);

const kv = new Map();
setStorageHooks({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); return true; },
    removeItem: (k) => { kv.delete(k); return true; },
});
const files = new Map();
const putLog = [];
const unFetch = installGlobalFetch((url, opts) => {
    if (url === '/api/files/upload') {
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        files.set(String(body.name), Buffer.from(String(body.data || ''), 'base64').toString('utf8'));
        putLog.push(String(body.name));
        return { status: 200, text: 'ok' };
    }
    const m = String(url).match(/^\/user\/files\/(.+)$/);
    if (m) {
        const n = decodeURIComponent(m[1]);
        if (!files.has(n)) return { status: 404, text: 'not found' };
        return { status: 200, text: files.get(n) };
    }
    return { status: 404, text: '' };
});

const entry = await import('../../index.js');

// v3.40.4（`docs/D22` `技-1`）：`index.js` 的**模块级副作用**（多触发 + 有限轮询）会启动装配 → `init()`，
//   而装配期间**落盘守门是关着的**（这正是 v3.40.4 的预期行为：载入未完成不写任何通道）。
//   本用例**直接注入 state**、单测保存 / 清理 / 统计路径，**不复现首屏时序** → 先等这一次装配落定
//   （`init()` 返回时载入结束、守门自动放行），再把守门复位一次，确保用例起点是「可写」。
try { await entry.__internals.init(); } catch (e) { /* 桩宿主下可能失败，无妨 */ }
try { resetWriteGate(); } catch (e) { /* 忽略 */ }


function boot(st) {
    setScopeKey('角色甲');
    setKernelState(st || emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    kv.clear(); files.clear(); putLog.length = 0; resetShardMarks();
}

R.assert('S0 入口齐备：`runSaveAll`（index 编排）与 `FTT.saveAll`（devtools/命令同源入口）都在册', (() => {
    const F = globalThis.FTT;
    return typeof entry.runSaveAll === 'function' && !!F && typeof F.saveAll === 'function';
})(), typeof entry.runSaveAll);

// ---------- A 组：逐层对齐与逐层回报 ----------
const A1 = await (async () => {
    const st = emptyState();
    st.atoms = [{ id: 'sa-a1', title: '情节甲', text: '甲在码头清点铜箱（正文足够长）。', date: '1919-11-29', tags: [], updatedAt: Date.now() }];
    st.memories = [{ id: 'sa-m1', owner: '甲', title: '记忆甲', content: '镖局与盐商有旧约。', updatedAt: Date.now() }];
    boot(st);
    const keepWorldbook = cfg.storage.worldbook;
    cfg.storage.worldbook = false;                       // 世界书关闭 → 必须如实跳过
    const r = await entry.runSaveAll({ silent: true });
    cfg.storage.worldbook = keepWorldbook;
    const scope = scopeId();
    const shards = Array.from(files.keys()).filter((n) => n.indexOf('ftt2-shard-') === 0 && n.indexOf('-manifest') < 0);
    const env = JSON.parse(files.get(stateFileName(scope)) || '{}');
    const atomsShard = JSON.parse(files.get(shardName(scope, 'atoms')) || '{}');
    const local = JSON.parse(kv.get('ftt2_state_' + scope) || '{}');
    return {
        r, scope, shards, env, atomsShard, local,
        ok: r.ok === true
            && String(r.layers.state.via).indexOf('localStorage') >= 0 && String(r.layers.state.via).indexOf('file') >= 0
            && r.layers.meta && r.layers.meta.ok === true && r.layers.settings && r.layers.settings.ok === true
            && !!(r.layers.worldbook && r.layers.worldbook.skipped)
            && (r.skipped || []).indexOf('worldbook') >= 0 && (r.failed || []).length === 0
            // 分片：全部维度 + meta 片都落盘，且本片内容与内存一致
            && shards.length >= (SHARD_DIMS.length + 1)
            && files.has(shardManifestName(scope))
            && (atomsShard.payload || []).some((x) => x.id === 'sa-a1')
            // 主文件仍是完整信封，且本机缓冲也是同一份数据
            && ((env.payload && env.payload.data && env.payload.data.atoms) || []).some((x) => x.id === 'sa-a1')
            && ((local.payload && local.payload.data && local.payload.data.atoms) || []).some((x) => x.id === 'sa-a1'),
    };
})();
R.assert('A1 一次点击把当前内存写到**每一层**并逐层回报：本机缓冲(localStorage)+服务端文件+分片(含 meta)+清单+快照/清单层+配置；关闭的层（世界书）如实 skipped；失败列表为空',
    A1.ok, J({ layers: A1.r.layers, failed: A1.r.failed, skipped: A1.r.skipped, shards: A1.shards.length }));

// ---------- B 组：分片「全量重传」（对齐语义） ----------
const B1 = await (async () => {
    const st = emptyState();
    st.atoms = [{ id: 'sa-b1', title: '情节乙', text: '乙在仓库清点货箱（正文足够长）。', date: '1919-11-30', tags: [], updatedAt: Date.now() }];
    boot(st);
    await entry.runSaveAll({ silent: true });            // 第一次：写下全部片
    putLog.length = 0;
    const r2 = await entry.runSaveAll({ silent: true }); // 第二次：内存**没变**，但「对齐」要求每层都重写
    const shardPuts = putLog.filter((n) => n.indexOf('ftt2-shard-') === 0 && n.indexOf('-manifest') < 0);
    return { r2, shardPuts: shardPuts.length, puts: putLog.length };
})();
R.assert('B1 「对齐」语义 = **每个片都重传**（即使内容没变）：第二次点击仍重写全部维度分片 + 清单 + 主文件（普通保存会按内容哈希跳过未变的片，这是两者的区别）',
    B1.r2.ok === true && B1.shardPuts >= (SHARD_DIMS.length + 1) && B1.puts > B1.shardPuts,
    J({ shardPuts: B1.shardPuts, puts: B1.puts }));

// ---------- C 组：面板接线（总览按钮 + 动作分发 + 忙位） ----------
const C1 = await (async () => {
    const st = emptyState();
    st.atoms = [{ id: 'sa-c1', title: '情节丙', text: '丙在码头清点铜箱（正文足够长）。', date: '1919-12-01', tags: [], updatedAt: Date.now() }];
    boot(st);
    const P = await import('../../ui/panel.js');
    let called = 0;
    P.openPanel('overview');
    P.setPanelHooks2({
        pending: () => [], notify: () => true,
        saveAll: async () => { called += 1; return { ok: true, layers: { state: { ok: true, via: 'localStorage+file', bytes: 1234 }, worldbook: { skipped: 'disabled' }, settings: { ok: true } }, failed: [], skipped: ['worldbook'] }; },
    });
    const html = String(P.panelBodyHtml('overview') || '');
    const hasBtn = html.indexOf('data-ftt-action="saveAll"') >= 0 && html.indexOf('💾 保存（对齐所有存储）') >= 0;
    const r = await P.panelAction('saveAll', {});
    const note = String(P.panelState().note || '');
    return {
        hasBtn, r, note, called,
        busyAfter: P.saveAllState().busy,
        ok: hasBtn && called === 1 && r.ok === true && r.action === 'saveAll'
            && note.indexOf('已对齐所有存储') === 0 && note.indexOf('本机缓冲✓') >= 0 && note.indexOf('服务端✓') >= 0
            && note.indexOf('世界书') >= 0 && P.saveAllState().busy === false,
    };
})();
R.assert('C1 总览新增按钮并真实分发：`data-ftt-action="saveAll"` + 文案「💾 保存（对齐所有存储）」；点击调用一次 `hooks.saveAll`，提示行按层列出结果（本机缓冲✓ / 服务端✓ / 世界书（disabled）…），忙位复位',
    C1.ok, J({ hasBtn: C1.hasBtn, called: C1.called, note: C1.note, busy: C1.busyAfter }));

// ---------- D 组：忙碌期间重复点击被拒（防连点） ----------
const D1 = await (async () => {
    boot(emptyState());
    const P = await import('../../ui/panel.js');
    let release = null, calls = 0;
    P.openPanel('overview');
    P.setPanelHooks2({
        pending: () => [], notify: () => true,
        saveAll: async () => { calls += 1; await new Promise((r2) => { release = r2; }); return { ok: true, layers: {}, failed: [], skipped: [] }; },
    });
    const first = P.panelAction('saveAll', {});
    await new Promise((r2) => setTimeout(r2, 10));
    const busy = P.saveAllState().busy;
    const second = await P.panelAction('saveAll', {});
    if (release) release();
    const r1 = await first;
    return { ok: busy === true && second.ok === false && second.reason === 'busy' && calls === 1 && r1.ok === true && P.saveAllState().busy === false, busy, second, calls };
})();
R.assert('D1 对齐在途时重复点击被拒（`reason:"busy"`）且只调用一次 —— 长耗时动作的防连点口径与其它动作一致',
    D1.ok, J({ busy: D1.busy, second: { ok: D1.second.ok, reason: D1.second.reason }, calls: D1.calls }));

unFetch();
unHost();
R.done();
