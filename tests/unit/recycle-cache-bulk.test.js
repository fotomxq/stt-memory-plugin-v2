// ============================================================
// 单元测试 · v3.52.13：最近删除只列最近 10 条 + 支持手动删除；缓存与日志聚合为一个清理按钮
//
// 用户要求（原话）：
//   1.「最近删除只保留最近10条，同时支持手动删除。」
//   2.「缓存与日志改为清理，总大小、条数、剩余大小和条数。不要零碎记录和分开，内部方法不变，只是打包聚合为一个按钮清理。」
//
// 口径：
//   · `RECYCLE_BIN_MAX = 10` —— **只影响列表视图**（墓碑数据不删）；每行有「🗑 删除」（`rbPurge`，危险确认）+
//     顶部「🗑 清空全部记录」（`rbPurgeAll`），二者与恢复走同一条清墓碑路径；
//   · 缓存与日志：`ui/cache-bulk.js#cacheBulkStats` 聚合「条数/大小」，`cacheBulkClear` 调用**既有**内部清理入口，
//     返回 `before → after`（剩余条数/大小）；界面只有一个 `data-ftt-action="cacheClearAll"` 按钮。
// 运行：node tests/unit/recycle-cache-bulk.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { recycleBinList, RECYCLE_BIN_MAX } from '../../core/recycle-bin.js';
import { recycleBinSectionHtml, recycleBinAction } from '../../ui/recycle-bin.js';
import { cacheBulkStats, cacheBulkClear, cacheBulkText } from '../../ui/cache-bulk.js';
import { panelAction, setPanelHooks2, panelState } from '../../ui/panel.js';

const R = makeReporter('recycle-cache-bulk v3.52.13 最近删除 10 条 / 缓存日志聚合清理');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:rb');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.deleted = {};
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const mkDeleted = (n) => {
    const m = {};
    for (let i = 0; i < n; i++) m['id' + String(i).padStart(3, '0')] = 1000 + i;   // 越大越新
    return m;
};

// ---------- A 最近删除 ----------
A('A1 `RECYCLE_BIN_MAX = 10`：**列表只列最近 10 条**（视图上限，不动墓碑数据）', (() => {
    boot({ deleted: { memories: mkDeleted(25) } });
    const data = recycleBinList();
    const html = recycleBinSectionHtml();
    const rows = (html.match(/data-ftt-action="rbToggle"/g) || []).length;
    return RECYCLE_BIN_MAX === 10 && data.items.length === 10 && data.total === 25 && data.truncated === 15
        && rows === 10 && html.indexOf('仅列最近 10 条') >= 0 && Object.keys(state.deleted.memories).length === 25;
})(), () => { boot({ deleted: { memories: mkDeleted(25) } }); const d = recycleBinList(); return J({ n: d.items.length, total: d.total, trunc: d.truncated }); });
A('A2 每行**支持手动删除**（`rbPurge`）＋顶部「清空全部记录」（`rbPurgeAll`）；都是危险动作', (() => {
    boot({ deleted: { memories: mkDeleted(3) } });
    const html = recycleBinSectionHtml();
    const r = recycleBinAction('rbPurge', { rbDim: 'memories', rbId: 'id002' });
    const left = Object.keys(state.deleted.memories || {}).length;
    return html.indexOf('data-ftt-action="rbPurge"') >= 0 && html.indexOf('data-ftt-action="rbPurgeAll"') >= 0
        && r.result.ok === true && r.result.recycleBin.restored === 1 && left === 2
        && String(r.note).indexOf('已删除') >= 0;
})(), 'n/a');
A('A3 `rbPurgeAll`：清空全部墓碑记录（含内容墓碑），列表回到空（区块不渲染）', (() => {
    boot({ deleted: { memories: mkDeleted(12), items: { x1: 5 } } });
    const r = recycleBinAction('rbPurgeAll', {});
    const html = recycleBinSectionHtml();
    return r.result.ok === true && r.result.recycleBin.restored === 13
        && Object.keys(state.deleted || {}).every((k) => Object.keys(state.deleted[k] || {}).length === 0)
        && html === '';
})(), () => J({ note: recycleBinAction('rbPurgeAll', {}).note }));

// ---------- B 缓存与日志聚合 ----------
A('B1 `cacheBulkStats`：聚合为「条数 + 大小」，含明细 9 类以内（只读）', (() => {
    boot();
    const st = cacheBulkStats();
    return Array.isArray(st.items) && st.items.length >= 5 && Number(st.count) >= 0 && Number(st.bytes) >= 0
        && typeof cacheBulkText(st) === 'string' && cacheBulkText(st).indexOf('项') > 0;
})(), () => J(cacheBulkStats().items.map((x) => x.label)));
A('B2 `cacheBulkClear`：调用**既有内部入口**逐个清理（debugAction 4 个 + 宿主钩子 5 个），返回 before→after', (async () => {
    boot();
    const called = [];
    const debugAction = async (a) => { called.push(a); return { ok: true }; };
    const hooks = {
        vectorCacheClear: async () => { called.push('vectorCacheClear'); return { ok: true }; },
        aboutClearCache: async () => { called.push('aboutClearCache'); return { ok: true }; },
        nameCacheClear: async () => { called.push('nameCacheClear'); return { ok: true }; },
        syncMarkClear: async () => { called.push('syncMarkClear'); return { ok: true }; },
        syncLogClear: async () => { called.push('syncLogClear'); return { ok: true }; },
    };
    const before = cacheBulkStats();
    const r = await cacheBulkClear({ debugAction: debugAction, hooks: hooks });
    const expect = ['dbgClear', 'dbgTraceClear', 'readLedgerClear', 'clockTraceClear', 'vectorCacheClear', 'aboutClearCache', 'nameCacheClear', 'syncMarkClear', 'syncLogClear'];
    return r.ok === true && J(called) === J(expect)
        && r.before && r.after && r.results.length === 9
        && String(r.note).indexOf('已清理缓存与日志') >= 0 && String(r.note).indexOf('剩余') >= 0
        && Number(r.after.count) <= Number(before.count);
})(), 'n/a');
A('B3 面板动作 `cacheClearAll`：一个动作完成全部清理并回写提示（含 before→after 统计）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('cacheClearAll', {});
    const note = String(panelState().note || '');
    return r && r.ok === true && r.action === 'cacheClearAll' && r.cache && r.cache.results.length === 9
        && note.indexOf('已清理缓存与日志') >= 0;
})(), () => String(panelState().note || '').slice(0, 160));

R.done();
