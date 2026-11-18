// ============================================================
// 单元测试 · v3.52.16：删除「其它存档」（非当前聊天存档）的全部数据
//
// 用户要求（原话）：「设置的删除角色删除数据位置，新增其他删除选择。包括删除非当前存档的其他存档数据。
//   该操作可以删除非当前存档的其他所有存档数据。」
//
// 口径：
//   · 只删 `chatKey` 非空且 ≠ 当前存档（`other`）的条目；**当前存档 + 历史遗留（无归属）一律不动**；
//   · 走 `deleteEntry`（写双墓碑 + 级联关联行）；关联行 / 楼层台账按同一归属判定清理；
//   · 当前存档键未知 → 拒绝（`no-current-archive`），绝不猜着删；
//   · 危险动作二次确认（`DANGER_ACTION_PROMPTS.purgeOtherArchives`）；按钮显示条数，无数据时禁用。
// 运行：node tests/unit/archive-purge.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { purgeOtherArchives } from '../../core/archive-purge.js';
import { archiveStats } from '../../core/archive-scope.js';
import { panelAction, setPanelHooks2, panelState, dangerActionPromptOf } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const R = makeReporter('archive-purge v3.52.16 删除其它存档数据');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:purge');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.chatKey = 'chat:A';
    st.memories = [
        { id: 'm-a', owner: '甲', title: '本档', content: 'a', chatKey: 'chat:A' },
        { id: 'm-b', owner: '甲', title: '别档', content: 'b', chatKey: 'chat:B' },
        { id: 'm-lg', owner: '甲', title: '遗留', content: 'c' },
    ];
    st.items = [{ id: 'i-b', name: '别档物品', chatKey: 'chat:B' }, { id: 'i-a', name: '本档物品', chatKey: 'chat:A' }];
    st.ledger = [{ id: 'l-b', currencyId: 'c1', date: '1920-01-01', delta: -5, note: 'b', chatKey: 'chat:B' }];
    st.plotSegments = [{ id: 's-b', header: '别档分段', lines: ['x'], chatKey: 'chat:B' }];
    st.links = [{ id: 'lk-b', dim: 'memories', refId: 'm-b', who: '甲', how: 'participant', chatKey: 'chat:B' }, { id: 'lk-a', dim: 'memories', refId: 'm-a', who: '甲', how: 'participant', chatKey: 'chat:A' }];
    st.processedFloors = [{ f: 1, h: 'h1', ck: 'chat:A' }, { f: 2, h: 'h2', ck: 'chat:B' }];
    st.processedDropped = [{ f: 3, h: 'h3', ck: 'chat:B' }, { f: 4, h: 'h4' }];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

A('A1 只删**其它存档**：条目 / 关联行 / 楼层台账按 `chatKey` 清理；当前存档与历史遗留一条不动', (() => {
    boot();
    const r = purgeOtherArchives();
    const ids = (k) => (state[k] || []).map((x) => x.id);
    const tombs = Object.keys((state.deleted || {}).memories || {});
    return r.ok === true && r.removed === 4 && r.dims.memories === 1 && r.dims.items === 1 && r.dims.ledger === 1 && r.dims.plotSegments === 1
        && J(ids('memories')) === J(['m-a', 'm-lg']) && J(ids('items')) === J(['i-a'])
        && tombs.indexOf('m-b') >= 0                                   // 写双墓碑（跨端不复活）
        // 条目删除已级联清掉其关联行 → `r.links` 为 0；楼层台账只删 ck=B 的两条（无归属的遗留标记保留）
        && (state.links || []).every((x) => x.chatKey === 'chat:A') && r.links === 0
        && (state.processedFloors || []).every((x) => x.ck === 'chat:A') && r.marks === 2
        && (state.processedDropped || []).some((x) => x.f === 4)
        && String(r.note).indexOf('已删除其它存档数据') >= 0;
})(), () => { boot(); const r = purgeOtherArchives(); return J({ r: r, m: state.memories.map((x) => x.id) }); });
A('A2 幂等：再跑一次 → 无其它存档数据（0 条，提示如实）', (() => {
    boot();
    purgeOtherArchives();
    const r2 = purgeOtherArchives();
    return r2.ok === true && r2.removed === 0 && r2.links === 0 && r2.marks === 0
        && String(r2.note).indexOf('没有其它存档的数据需要删除') >= 0;
})(), 'n/a');
A('A3 当前存档键未知 → **拒绝执行**（判不出来就不猜着删）', (() => {
    boot({ chatKey: '' });
    const r = purgeOtherArchives();
    return r.ok === false && r.reason === 'no-current-archive' && state.memories.length === 3;
})(), 'n/a');
A('A4 面板动作 + 危险确认 + 数据管理页按钮（含条数；无数据时禁用）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const html = settingsPageHtml('data', '');
    const r = await panelAction('purgeOtherArchives', {});
    const note = String(panelState().note || '');
    return html.indexOf('data-ftt-action="purgeOtherArchives"') >= 0
        && html.indexOf('删除其它存档数据（4 条）') >= 0
        && /确认删除「其它存档」的全部数据/.test(String(dangerActionPromptOf('purgeOtherArchives') || ''))
        && r && r.ok === true && r.removed === 4 && note.indexOf('已删除其它存档数据') >= 0;
})(), 'n/a');
A('A5 无其它存档时按钮禁用（不误导用户点空操作）', (() => {
    boot({ memories: [{ id: 'm-a', owner: '甲', title: '本档', content: 'a', chatKey: 'chat:A' }], items: [], ledger: [], plotSegments: [], links: [], processedFloors: [], processedDropped: [] });
    const html = settingsPageHtml('data', '');
    const m = html.match(/<button[^>]*data-ftt-action="purgeOtherArchives"[^>]*>/);
    return !!m && /disabled/.test(m[0]) && html.indexOf('删除其它存档数据（0 条）') >= 0
        && archiveStats().other === 0;
})(), () => { boot(); return J(archiveStats()); });

R.done();
