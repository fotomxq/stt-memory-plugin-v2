// ============================================================
// 单元测试 · **存档隔离补全**（v3.52.14 / `docs/D61` `数-52`）
//
// 用户报告（原话）：「请核对本地端，存档混乱，不同存档的内容出现了交叉。请修复该错误。」
//
// 本地端只读取证（`ftt.*` 调试桥等价口径 + 只读扫描 extension-store）：
//   · 当前聊天是一条全新的 1 楼存档（`chatKey=8048378324082269`），而同角色状态里
//     `atoms` 229 条 = 本档 0 + 旧版遗留 26 + **别档 203**；`ledger` 912 条里 **623 条属于另一条聊天存档**、
//     289 条无归属；`deals` 5 条**全部属于另一条存档**。
//   · `snapshots` 89 条中 71 条无归属、`maps` 40 条全部无归属 → 这些「旧存档遗留」在**每条**聊天里都可见。
//   · 楼层收缩把**别档条目**当成「本档」重算：773 条被钉到本档第 0 楼（各档开场白相同 → 哈希必然相同），
//     还被写 `floorNowHash` / `originGone`（别档正文在它自己的聊天里明明还在）。
//
// 本档锁四组：
//   A 旧存档遗留**默认隐藏**、显式显示（横幅开关）；
//   B 货币流水 / 长期收支**按存档过滤**（含汇总、对账、删除守卫）；
//   C 楼层收缩**只维护本档**（别档条目/标记原样保留；0/0 区间不参与哈希定位）；
//   D 归属证据②（`floorFingerprintHit`）**不再认领「不可辨位」**（0/0 区间、第 0 楼）。
// 反向探针：把 `archiveVisible` 的 legacy 分支改回 `true` → A1/A4 必红；
//   `ledgerVisible` 改回 `ledgerList` → B1/B2 必红；去掉 `isOtherArchiveEntry` → C1/C3 必红。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    setLegacyVisible, legacyVisibleOn, archiveVisible, filterArchiveVisible, archiveStats,
} from '../../core/archive-scope.js';
import { ledgerVisible, ledgerOf, ledgerSum, deleteLedgerEntry, reconcileLedger } from '../../core/model/ledger.js';
import { dealVisible, findDeal } from '../../core/model/deal.js';
import { floorFingerprintHit } from '../../core/chat-scope.js';
import { handleFloorShrink, hashFloorText } from '../../host/floors.js';

const R = makeReporter('archive-isolation v3.52.14 存档隔离补全（旧档隐藏 / 流水与长期收支分档 / 收缩只动本档 / 证据加固）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : (e === undefined ? 'n/a' : e)));
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const host = makeHost({ chat: [{ is_user: false, mes: '开场白：甲在码头。', name: '角色甲' }] });
installGlobalHost(host, makeDocument(['ftt-panel']));

function boot(seed, chatKey) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:archive');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    setLegacyVisible(false);
    const st = Object.assign(emptyState(), seed || {});
    st.chatKey = (chatKey === undefined ? 'chat:A' : String(chatKey));
    setKernelState(st);
    return st;
}

// ============================================================
// A 组：旧存档遗留默认隐藏（用户报告的直接原因）
// ============================================================
A('A1 已知存档时 `legacy`（无归属历史数据）**默认隐藏**；`other` 一律隐藏；显式开关只放行 legacy', (() => {
    boot({ memories: [
        { id: 'm-cur', title: '本档', chatKey: 'chat:A' },
        { id: 'm-legacy', title: '旧档遗留' },
        { id: 'm-other', title: '别档', chatKey: 'chat:B' },
    ] });
    const hidden = archiveVisible(state.memories[1]) === false && filterArchiveVisible(state.memories).length === 1;
    const on = setLegacyVisible(true);
    const shown = filterArchiveVisible(state.memories).map((x) => x.id).join(',') === 'm-cur,m-legacy';
    setLegacyVisible(false);
    return hidden && on === true && legacyVisibleOn() === false && shown
        && archiveVisible({ chatKey: 'chat:B' }) === false;
})(), () => J(archiveStats(['memories'])));

A('A2 当前存档键**读不到** → 仍然 fail-open（不分档、全部可见；冷启动/单测不误伤）', (() => {
    boot({ memories: [{ id: 'm1' }, { id: 'm2', chatKey: 'chat:B' }] }, '');
    return legacyVisibleOn() === false && filterArchiveVisible(state.memories).length === 2;
})(), 'n/a');

A('A3 `archiveStats` 仍如实计数（本档 / 旧档遗留 / 别档）——「默认隐藏」不等于「不统计」', (() => {
    boot({ memories: [
        { id: 'm-cur', chatKey: 'chat:A' }, { id: 'm-legacy' }, { id: 'm-other', chatKey: 'chat:B' },
    ] });
    const s = archiveStats(['memories']);
    return s.current === 1 && s.legacy === 1 && s.other === 1 && s.known === true && s.currentKey === 'chat:A';
})(), () => J(archiveStats(['memories'])));

// ============================================================
// B 组：货币流水 / 长期收支按存档过滤（真机 912 笔流水 / 5 条标的物跨档）
// ============================================================
function bootMoney() {
    return boot({
        currencies: [
            { id: 'c1', owner: '甲', name: '银币', amount: 10, chatKey: 'chat:A' },
            { id: 'c2', owner: '乙', name: '金币', amount: 5, chatKey: 'chat:B' },
        ],
        ledger: [
            { id: 'l1', currencyId: 'c1', date: '1920-01-01', delta: 10, chatKey: 'chat:A', owner: '甲' },
            { id: 'l2', currencyId: 'c2', date: '1920-01-02', delta: 5, chatKey: 'chat:B', owner: '乙' },
            { id: 'l3', currencyId: 'c1', date: '1920-01-03', delta: 3, owner: '甲' },              // 无归属（旧版遗留）
        ],
        deals: [
            { id: 'd1', owner: '甲', currencyId: 'c1', desc: '本档标的', chatKey: 'chat:A' },
            { id: 'd2', owner: '乙', currencyId: 'c2', desc: '别档标的', chatKey: 'chat:B' },
        ],
    });
}

A('B1 `ledgerVisible` / `ledgerOf` / `ledgerSum`：**只算当前存档**（别档流水不进视图、不进净额；旧版遗留默认隐藏）', (() => {
    bootMoney();
    const visible = ledgerVisible().map((x) => x.id).join(',');
    const of = ledgerOf('c1').map((x) => x.id).join(',');
    const sum = ledgerSum('c1');
    const shown = (() => { setLegacyVisible(true); const r = ledgerSum('c1'); setLegacyVisible(false); return r; })();
    return visible === 'l1' && of === 'l1' && sum === 10 && shown === 13;
})(), () => J({ visible: ledgerVisible().map((x) => x.id), sum: ledgerSum('c1') }));

A('B2 `reconcileLedger` 只对**本档可见**的货币对账（别档货币不再误报「对账不平」）', (() => {
    bootMoney();
    const rows = reconcileLedger();
    return rows.length === 1 && rows[0].currencyId === 'c1' && rows[0].diff === 0;
})(), () => J(reconcileLedger()));

A('B3 `deleteLedgerEntry` 拒绝删除**别的存档**的流水（否则会动到别档数据）', (() => {
    bootMoney();
    const r = deleteLedgerEntry('l2');
    const keep = (state.ledger || []).length;
    return r.ok === false && String(r.error).indexOf('别的存档') >= 0 && keep === 3;
})(), () => J({ ok: false }));

A('B4 `dealVisible` / `findDeal`：长期收支也按存档过滤（别档标的物不在本档可见/可编辑/不触发）', (() => {
    bootMoney();
    const ids = dealVisible().map((d) => d.id).join(',');
    return ids === 'd1' && !!findDeal('d1') && findDeal('d2') === null;
})(), () => J(dealVisible().map((d) => d.id)));

// ============================================================
// C 组：楼层收缩只维护本档（别档条目/标记原样保留；0/0 区间不定位）
// ============================================================
function bootShrink() {
    host.ctx.chat = [
        { is_user: false, mes: '第 0 楼：开场白（各档相同）。', name: '角色甲' },
        { is_user: true, mes: '第 1 楼：玩家输入。', name: '玩家' },
        { is_user: false, mes: '第 2 楼：甲在码头清点货物。', name: '角色甲' },
    ];
    const st = boot({
        atoms: [
            { id: 'a-cur', title: '本档', text: '本档情节', floorStart: 1, floorEnd: 1, chatKey: 'chat:A' },
            { id: 'a-other', title: '别档', text: '别档情节', floorStart: 1, floorEnd: 1, chatKey: 'chat:B' },
            { id: 'a-legacy', title: '旧档遗留', text: '旧档情节', floorStart: 0, floorEnd: 0 },
        ],
    });
    st.lastChatFloor = 10;       // 上次见到 10 楼 → 现在只剩 2 楼（收缩）
    st.lastKnownFloor = 10;
    st.processedVer = '';         // 避免迁移短路过早改动
    return st;
}

A('C1 别档条目**不被重钉**：`floorNow*` / `originGone` 一个字都不写（它在自己那条聊天里仍然有效）', (() => {
    const st = bootShrink();
    st.processedFloors = [{ f: 1, h: hashFloorText(1), ck: 'chat:A' }];
    const before = J(st.atoms[1]);
    handleFloorShrink({});
    const after = J(st.atoms[1]);
    return before === after && st.atoms[1].floorNowStart === undefined && st.atoms[1].originGone === undefined;
})(), () => J(state.atoms[1]));

A('C2 0/0（区间未知）条目**不参与哈希定位**：不再被钉到本档第 0 楼、也不写 `floorNowHash`（真机 773 条）', (() => {
    const st = bootShrink();
    st.processedFloors = [{ f: 0, h: hashFloorText(0), ck: 'chat:A' }];
    handleFloorShrink({});
    const lg = st.atoms[2];
    return lg.floorNowStart === undefined && lg.floorNowHash === undefined && !lg.originGone;
})(), () => J(state.atoms[2]));

A('C3 本档条目照旧重定位（收缩后位置/指纹正确，语义不回退）', (() => {
    const st = bootShrink();
    st.processedFloors = [{ f: 1, h: hashFloorText(1), ck: 'chat:A' }];
    handleFloorShrink({});
    const a = st.atoms[0];
    return a.floorNowStart === 1 && a.floorNowEnd === 1 && a.floorNowHash === hashFloorText(1) && !a.originGone;
})(), () => J(state.atoms[0]));

A('C4 别档**台账标记原样保留**（收缩不再把别档标记整批重建/丢弃 → 切回别档不会「已分析楼层复现」）', (() => {
    const st = bootShrink();
    st.processedFloors = [
        { f: 1, h: hashFloorText(1), ck: 'chat:A' },
        { f: 2, h: 'hash-of-other-chat', ck: 'chat:B', at: 7 },
    ];
    handleFloorShrink({});
    const other = (st.processedFloors || []).filter((m) => m && m.ck === 'chat:B');
    return other.length === 1 && other[0].f === 2 && other[0].h === 'hash-of-other-chat' && other[0].at === 7;
})(), () => J(state.processedFloors));

// ============================================================
// D 组：归属证据②加固（不再认领「不可辨位」）
// ============================================================
A('D1 `floorFingerprintHit`：**0/0 区间**（位置未知）不构成「出自本聊天」的证据', (() => {
    host.ctx.chat = [
        { is_user: false, mes: '第 0 楼：开场白（各档相同）。', name: '角色甲' },
        { is_user: false, mes: '第 1 楼：甲在码头清点货物。', name: '角色甲' },
    ];
    return floorFingerprintHit({ floorStart: 0, floorEnd: 0, floorNowStart: 0, floorNowEnd: 0, floorNowHash: hashFloorText(0) }, hashFloorText) === false;
})(), 'n/a');

A('D2 `floorFingerprintHit`：**第 0 楼**（各档共享开场白，哈希必然相同）不构成证据', (() => {
    return floorFingerprintHit({ floorStart: 1, floorEnd: 1, floorNowStart: 0, floorNowEnd: 0, floorNowHash: hashFloorText(0) }, hashFloorText) === false;
})(), 'n/a');

A('D3 `floorFingerprintHit`：真实位置（>0 楼）且指纹一致 → 仍然认（证据不被过度收紧）', (() => {
    return floorFingerprintHit({ floorStart: 1, floorEnd: 1, floorNowStart: 1, floorNowEnd: 1, floorNowHash: hashFloorText(1) }, hashFloorText) === true;
})(), 'n/a');

R.done();
