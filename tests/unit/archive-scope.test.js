// ============================================================
// 单元测试 · v3.52.7：**存档（聊天）分区** —— 不同存档的数据区分，避免混淆
//
// 用户要求（原话）：「不同的存档，数据应该加以区分，避免混淆。」
//   澄清选择：按聊天存档隔离 · 每个聊天存档一份（角色内隔离）。
//
// 口径（`core/archive-scope.js`）：
//   · 分区键 = 条目 `chatKey`；当前存档 = `state.chatKey`；
//   · 当前档未知 → **fail-open**（不过滤，行为与旧版一致）；
//   · 已知 → 列表/计数/注入/自动裁剪只取「当前档 + legacy（无归属，可见并打标）」，**其它存档隐藏且不动**；
//   · `adoptLegacyEntries` 只补空归属（幂等，别的存档不动）。
// 运行：node tests/unit/archive-scope.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { currentArchiveKey, entryArchiveKey, archiveTierOf, archiveVisible, filterArchiveVisible, archiveStats, adoptLegacyEntries, capVisibleKeepingOthers } from '../../core/archive-scope.js';
import { panelAction, setPanelHooks2, panelBodyHtml } from '../../ui/panel.js';
import { recordProcessedFloors, isFloorProcessed, reconcileProcessedFloors, hashFloorText } from '../../host/floors.js';
import { stampEntryArchive, autoAdoptOnLoad } from '../../core/archive-scope.js';
import { normalizeRelLink } from '../../core/model/rel.js';
import { normalizeLedgerEntry } from '../../core/model/ledger.js';
import { migrateState } from '../../core/migrate.js';
import { consoleSummary } from '../../ui/console.js';

const R = makeReporter('archive-scope v3.52.7 存档分区');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed, chatKey) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:archive');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.protagonist = { name: '主角' };
    st.chatKey = chatKey || '';
    st.memories = [
        { id: 'm-cur', owner: '甲', title: '本档记忆', content: '本档', chatKey: 'chat:A' },
        { id: 'm-other', owner: '甲', title: '别档记忆', content: '别档', chatKey: 'chat:B' },
        { id: 'm-legacy', owner: '甲', title: '历史记忆', content: '旧' },
    ];
    st.items = [
        { id: 'i-cur', name: '本档物品', chatKey: 'chat:A' },
        { id: 'i-legacy', name: '历史物品' },
    ];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const titles = (html, kind) => {
    const out = [];
    const re = new RegExp('data-ftt-action="edit" data-kind="' + kind + '" data-id="([^"]+)"', 'g');
    let m;
    while ((m = re.exec(String(html || '')))) out.push(m[1]);
    return out;
};

// ---------- A 分区判定 ----------
A('A1 **fail-open**：当前存档键未知 → 一律可见、不分档（旧版行为；冷启动/单元测试不误伤）', (() => {
    boot({}, '');
    return currentArchiveKey() === '' && archiveTierOf(state.memories[0]) === 'all'
        && state.memories.every((x) => archiveVisible(x));
})(), 'n/a');
A('A2 已知存档：current / legacy / other 三档判定（`ck` 短键也认）', (() => {
    boot({}, 'chat:A');
    return archiveTierOf({ chatKey: 'chat:A' }) === 'current'
        && archiveTierOf({}) === 'legacy'
        && archiveTierOf({ chatKey: 'chat:B' }) === 'other'
        && archiveTierOf({ ck: 'chat:A' }) === 'current'
        && archiveVisible({ chatKey: 'chat:B' }) === false
        && filterArchiveVisible(state.memories).length === 2;
})(), 'n/a');
A('A3 `archiveStats`：分类计数（本档 / 旧存档 / 其它），当前键与 known 标记', (() => {
    boot({}, 'chat:A');
    const s = archiveStats(['memories', 'items']);
    return s.known === true && s.currentKey === 'chat:A' && s.current === 2 && s.legacy === 2 && s.other === 1 && s.total === 5;
})(), () => J(archiveStats(['memories', 'items'])));

// ---------- B 视图 / 计数 ----------
A('B1 列表页**只显示当前档 + 旧存档**（别的存档隐藏）；旧存档行打「旧存档」标', (async () => {
    boot({}, 'chat:A');
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'memories' });
    const html = String(panelBodyHtml('memories') || '');
    const ids = titles(html, 'memories');
    return J(ids) === J(['m-legacy', 'm-cur']) && html.indexOf('data-ftt-archive-legacy') >= 0 && ids.indexOf('m-other') < 0;
})(), 'n/a');
A('B2 总记忆数（面板统计口径）**不含别的存档**', (() => {
    boot({}, 'chat:A');
    const s = consoleSummary();
    return s.dims.filter((d) => d.kind === 'memories')[0].count === 2 && s.dims.filter((d) => d.kind === 'items')[0].count === 2;
})(), () => J(consoleSummary().dims.filter((d) => d.kind === 'memories')));
A('B3 横幅：存档短键 / 本档数 / 旧存档数 / 其它存档数；有遗留时给「归入当前」入口', (async () => {
    boot({}, 'chat:A');
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'memories' });
    const html = String(panelBodyHtml('memories') || '');
    return html.indexOf('data-ftt-archive-bar') >= 0 && html.indexOf('本档 2 条') >= 0
        && html.indexOf('旧存档遗留') >= 0 && html.indexOf('其它存档') >= 0
        && html.indexOf('data-ftt-action="archiveAdopt"') >= 0;
})(), 'n/a');

// ---------- C 归档与裁剪 ----------
A('C1 `adoptLegacyEntries`：只补空归属（别的存档不动），幂等', (() => {
    boot({}, 'chat:A');
    const r1 = adoptLegacyEntries();
    const r2 = adoptLegacyEntries();
    const other = state.memories.filter((x) => x.id === 'm-other')[0];
    return r1.ok === true && r1.adopted === 2 && r2.adopted === 0
        && other.chatKey === 'chat:B'
        && state.memories.filter((x) => x.id === 'm-legacy')[0].chatKey === 'chat:A'
        && archiveStats(['memories', 'items']).legacy === 0;
})(), () => J({ adopted: adoptLegacyEntries().adopted }));
A('C2 当前档未知时**不归档**（判不出来就不写）', (() => {
    boot({}, '');
    const r = adoptLegacyEntries();
    return r.ok === false && r.adopted === 0 && state.memories.filter((x) => x.id === 'm-legacy')[0].chatKey === undefined;
})(), 'n/a');
A('C3 面板动作 `archiveAdopt`：归档 + 落盘 + 提示条数', (async () => {
    boot({}, 'chat:A');
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const r = await panelAction('archiveAdopt', {});
    return r && r.ok === true && r.adopted === 2 && String(r.note).indexOf('归入当前存档') >= 0
        && state.memories.every((x) => x.chatKey);
})(), 'n/a');
A('C4 上限裁剪**不裁别的存档**：只在本档 + 遗留里按尾裁', (() => {
    const arr = [
        { id: 'a1', chatKey: 'chat:A' }, { id: 'b1', chatKey: 'chat:B' },
        { id: 'a2', chatKey: 'chat:A' }, { id: 'lg' },
        { id: 'a3', chatKey: 'chat:A' },
    ];
    boot({}, 'chat:A');
    const out = capVisibleKeepingOthers(arr, 2).map((x) => x.id);
    return J(out) === J(['b1', 'lg', 'a3']) && out.indexOf('b1') >= 0;
})(), () => { boot({}, 'chat:A'); return J(capVisibleKeepingOthers([{ id: 'a1', chatKey: 'chat:A' }, { id: 'b1', chatKey: 'chat:B' }, { id: 'a2', chatKey: 'chat:A' }, { id: 'lg' }, { id: 'a3', chatKey: 'chat:A' }], 2).map((x) => x.id)); });

// ---------- D v3.52.8：楼层台账按存档切分（切档后已分析楼层不再「神秘复现」） ----------
A('D1 已分析楼层标记**按存档写**：`recordProcessedFloors` 写入本档 ck；同楼层号在另一档的标记**不被覆盖**', (() => {
    const chat = [
        { is_user: false, mes: 'a0' }, { is_user: true, mes: 'u1' }, { is_user: false, mes: 'a2' },
        { is_user: false, mes: 'a3' }, { is_user: false, mes: 'a4' }, { is_user: false, mes: 'a5' },
    ];
    boot({ chatKey: 'chat:A' }, 'chat:A');
    globalThis.__fttChat = chat;
    setLastMessageId(5);
    recordProcessedFloors(2, 3);
    const mine = (state.processedFloors || []).filter((m) => m && m.ck === 'chat:A').map((m) => m.f);
    // 切到 B 档，再分析同一楼号 → A 档标记必须还在
    state.chatKey = 'chat:B';
    recordProcessedFloors(2, 2);
    const aMarks = (state.processedFloors || []).filter((m) => m && m.ck === 'chat:A').map((m) => m.f);
    const bMarks = (state.processedFloors || []).filter((m) => m && m.ck === 'chat:B').map((m) => m.f);
    return mine.indexOf(2) >= 0 && mine.indexOf(3) >= 0
        && aMarks.join(',') === '2,3' && bMarks.indexOf(2) >= 0 && bMarks.length === 1;
})(), () => J(state.processedFloors));
A('D2 `isFloorProcessed` 只认**本档**标记：A 档已分析的第 3 楼，在 B 档（正文不同）不算已分析', (() => {
    const st = boot({ chatKey: 'chat:B' }, 'chat:B');
    st.processedFloors = [{ f: 3, h: 'hash-of-A-text', ck: 'chat:A' }];
    globalThis.__fttChat = [{ is_user: false, mes: 'x0' }, { is_user: true, mes: 'u1' }, { is_user: false, mes: 'b2' }, { is_user: false, mes: 'b3' }];
    setLastMessageId(3);
    return isFloorProcessed(3) === false;
})(), 'n/a');
A('D3 归位对账**不丢弃别的存档的标记**（切回 A 档时台账仍在 → 楼层不复现）', (() => {
    const st = boot({ chatKey: 'chat:B' }, 'chat:B');
    globalThis.__fttChat = [{ is_user: false, mes: 'b0' }, { is_user: true, mes: 'u1' }, { is_user: false, mes: 'b2' }];
    setLastMessageId(2);
    st.processedVer = '';   // 跳过升级期短路
    st.processedFloors = [
        { f: 1, h: 'hash-A1', ck: 'chat:A' },
        { f: 2, h: hashFloorText(2), ck: 'chat:B' },
    ];
    const r = reconcileProcessedFloors(false);
    const kept = (state.processedFloors || []).filter((m) => m && m.ck === 'chat:A');
    return kept.length === 1 && kept[0].f === 1;
})(), () => J(state.processedFloors));
A('D4 关联行 / 账本 / 分段总结：**新建即打存档键**（切档后不再整份可见）', (() => {
    boot({ chatKey: 'chat:A' }, 'chat:A');
    const link = { dim: 'memories', refId: 'm1', who: '甲', how: 'participant' };
    stampEntryArchive(link);
    const led = { id: 'l1', currency: '银币', date: '1920-01-01', amount: -5 };
    stampEntryArchive(led);
    const seg = { id: 's1', header: '一', lines: ['a'] };
    stampEntryArchive(seg);
    return link.chatKey === 'chat:A' && led.chatKey === 'chat:A' && seg.chatKey === 'chat:A'
        && entryArchiveKey({ chatKey: 'chat:B' }) === 'chat:B';
})(), 'n/a');

// ---------- E v3.52.9：归档不再反复提示（归一化保归属 + 归档记忆 + 载入自动收敛） ----------
A('E1 **归一化保留存档归属**（关联行 / 账本）：旧实现重建对象时丢 `chatKey` → 每次载入后横幅又提示', (() => {
    const link = normalizeRelLink({ dim: 'memories', refId: 'm1', who: '甲', how: 'participant', chatKey: 'chat:A' });
    const led = normalizeLedgerEntry({ id: 'l1', currencyId: 'c1', date: '1920-01-01', delta: -5, chatKey: 'chat:A' });
    const link2 = normalizeRelLink({ dim: 'memories', refId: 'm2', who: '乙', how: 'witness', ck: 'chat:B' });
    return link && link.chatKey === 'chat:A' && led && led.chatKey === 'chat:A' && link2 && link2.chatKey === 'chat:B';
})(), 'n/a');
A('E2 **归档记忆**：`adoptLegacyEntries` 成功后写 `archiveAdoptAuto`；`autoAdoptOnLoad` 在已确认且存档键已知时自动归入（幂等）', (() => {
    boot({}, 'chat:A');
    const r1 = adoptLegacyEntries();
    const auto = autoAdoptOnLoad();
    const again = autoAdoptOnLoad();
    return r1.adopted === 2 && state.archiveAdoptAuto === true && auto.adopted === 0
        && again.adopted === 0 && archiveStats(['memories']).legacy === 0;
})(), () => J({ adoptedFlag: state.archiveAdoptAuto }));
A('E3 `autoAdoptOnLoad` **未确认过就不动**（不把历史数据悄悄认领）', (() => {
    boot({}, 'chat:A');
    const auto = autoAdoptOnLoad();
    return auto.adopted === 0 && state.archiveAdoptAuto !== true && archiveStats(['memories']).legacy === 1;
})(), 'n/a');
A('E4 载入期收敛：`migrateState` 在用户已确认归档后，把新出现的无归属条目自动归入本档（横幅不再复现）', (() => {
    boot({}, 'chat:A');
    state.archiveAdoptAuto = true;
    state.memories.push({ id: 'm-new-legacy', owner: '甲', title: '新遗留', content: 'x' });
    const before = archiveStats(['memories']).legacy;
    migrateState(state);
    return before === 2 && archiveStats(['memories']).legacy === 0 && state.memories.filter((x) => x.id === 'm-new-legacy')[0].chatKey === 'chat:A';
})(), () => J(archiveStats(['memories'])));

R.done();
