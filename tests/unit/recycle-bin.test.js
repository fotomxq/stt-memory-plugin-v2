// ============================================================
// 单元测试 · v3.46.7 「最近删除 + 恢复」（`docs/D22` §4.4 W15 `应-8` / `docs/D19` §3.4 + §8）
//
// 实施规格（原话）：「在『设定 → 数据管理』的危险区之前增加『🕳 最近删除（N 条）』只读列表 +
//   『♻ 恢复选中』（清除对应 id 墓碑）。范围限定为**本机当前作用域**、只读列表 + 单条/批量恢复」；
//   验收 = 「删除 1 条 → 出现在最近删除 → 恢复后…；**跨端不复活语义不变（构造合并用例）**」。
//
// 本文件锁六件事：
//   ① **清单只读**：从 `state.deleted`（id 墓碑）按维度列出，时间倒序，**不改任何数据**；
//   ② **恢复 = 清墓碑**：只动 `state.deleted` / `state.deletedH`，不新增/不修改任何条目；
//   ③ **跨端语义（验收原文）**：墓碑清掉 → 同一内容可以重新写入（合并用例）；
//   ④ **不误伤**：只清被选中的那一条；别人的墓碑（不同时间戳 / 不同 id）一条不动；
//   ⑤ **界面动作**：勾选 / 全选 / 清空 / 恢复的勾选集合口径 + 空选时不写盘；
//   ⑥ **零渲染副作用**：区块 HTML 只读渲染，且**没有墓碑时不渲染**。
//
// 运行：node tests/unit/recycle-bin.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { upsertEntry, deleteEntry } from '../../core/entries.js';
import { tombstoneMap, tombstoneHMap, tombSet, tombSetH } from '../../core/merge.js';
import { applyDeletedToArray } from '../../core/sweep.js';
import { atomIdentityHash } from '../../core/model/hash.js';
import { recycleBinList, recycleBinRestore, recycleBinState, recycleDimLabel, RECYCLE_BIN_MAX } from '../../core/recycle-bin.js';
import { recycleBinSectionHtml, runRecycleBinAction, recycleBinAction, recycleBinUiState, resetRecycleBinSelection } from '../../ui/recycle-bin.js';
import { panelBodyHtml, panelAction, setPanelHooks2, openPanel } from '../../ui/panel.js';

const R = makeReporter('recycle-bin v3.46.7 最近删除 + 恢复（D22 W15 应-8 / D19 应-8）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
await import('../../index.js');

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    const st = emptyState();
    st.atoms = [{ id: 'a1', title: '情节一', text: '正文一', floorEnd: 1 }];
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save: () => { } });
    setLastMessageId(1);
    setPanelHooks2({});
    resetRecycleBinSelection();
    tombstoneMap(); tombstoneHMap();
}

// ---------- ① 清单只读 ----------
boot();
deleteEntry('atoms', 'a1');
A('A1 删除后墓碑落到 `state.deleted.atoms`', !!tombstoneMap().atoms && !!tombstoneMap().atoms.a1, J(tombstoneMap().atoms));
A('A2 条目本身已从容器移除（恢复不搬运正文）', state.atoms.length === 0, 'len=' + state.atoms.length);
const l1 = recycleBinList();
A('A3 清单列出该条（维度 + id + 时刻）', l1.total === 1 && l1.items[0].dim === 'atoms' && l1.items[0].id === 'a1' && l1.items[0].ts > 0, J(l1.items));
A('A4 维度标签取 `core/constants.js#DIMENSIONS`（不另立一份）', l1.items[0].label === '情节' && recycleDimLabel('memories') === '长期记忆', l1.items[0].label);
A('A5 清单是只读的：连调两次读数一致、且不改墓碑', (() => {
    const before = J(tombstoneMap());
    const a = recycleBinList(), b = recycleBinList();
    return a.total === b.total && before === J(tombstoneMap());
})(), '清单写入');

// 时间倒序 + 外框
boot();
tombSet('atoms', 'old', 1000);
tombSet('atoms', 'new', 9000);
tombSet('memories', 'm1', 5000);
const l2 = recycleBinList();
A('A6 维度按固定序（情节在记忆之前）、维度内按时间倒序', J(l2.items.map((x) => x.dim + ':' + x.id)) === J(['atoms:new', 'atoms:old', 'memories:m1']), J(l2.items.map((x) => x.dim + ':' + x.id)));
A('A7 外框：超出 `RECYCLE_BIN_MAX` 时截断并如实报「共 N 条」', (() => {
    boot();
    for (let i = 0; i < RECYCLE_BIN_MAX + 5; i++) tombSet('atoms', 'k' + i, 1000 + i);
    const r = recycleBinList();
    return r.items.length === RECYCLE_BIN_MAX && r.total === RECYCLE_BIN_MAX + 5 && r.truncated === 5;
})(), 'total=' + recycleBinList().total);
A('A8 空墓碑 → 空清单（界面据此不渲染区块）', (() => { boot(); return recycleBinList().total === 0 && recycleBinSectionHtml() === ''; })(), 'n/a');

// ---------- ② 恢复 = 清墓碑 ----------
boot();
deleteEntry('atoms', 'a1');
tombSetH('atoms', 'hash-a1', tombstoneMap().atoms.a1);
const r1 = recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
A('B1 恢复清掉 id 墓碑', r1.ok && r1.restored === 1 && !tombstoneMap().atoms, J(tombstoneMap()));
A('B2 恢复清掉配对的**内容哈希**墓碑（同一时刻成对写过）', r1.hashes === 1 && !tombstoneHMap().atoms, J(tombstoneHMap()));
A('B3 恢复**不新增/不修改任何条目**（正文不搬回来）', state.atoms.length === 0, 'len=' + state.atoms.length);
A('B4 幂等：同一条再恢复一次 → 记为跳过（不报错、不改任何东西）', (() => {
    const r = recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
    return r.ok === true && r.restored === 0 && r.skipped === 1;
})(), 'n/a');
A('B5 坏输入不抛错（缺维度 / 缺 id / 非数组）', (() => {
    const a = recycleBinRestore([{ dim: '', id: 'x' }, { dim: 'atoms' }, null]);
    const b = recycleBinRestore(null);
    return a.ok === true && a.skipped === 3 && b.ok === true && b.restored === 0;
})(), 'n/a');

// ---------- ③ 跨端语义（验收原文：构造合并用例） ----------
// 口径依据 `core/sweep.js#applyDeletedToArray`：**内容墓碑**只删「有明确墙钟（>1e12）**且不晚于墓碑**」的条目
//   （墙钟未知的条目只能由 id 墓碑删除 —— v2.91.0 的加严口径）。
boot();
deleteEntry('atoms', 'a1');                       // 删除条目的同时写下 id 墓碑
const ts1 = tombstoneMap().atoms.a1;
// 对端合并进来的**同内容、新 id** 条目：墙钟早于墓碑（= 它确实是删除之前写的）
const peer = { id: 'peer-9', title: '情节一', text: '正文一', floorEnd: 1, updatedAt: ts1 - 1000 };
tombSetH('atoms', atomIdentityHash('atoms', peer), ts1);   // 清扫学到的内容墓碑（与删除同一时刻）
A('C1 删除后：同内容以新 id 写回会被**内容墓碑**挡住（跨端不复活的原语义）', (() => {
    const r = applyDeletedToArray('atoms', [peer], state.deleted, state.deleted, state.deletedH, state.deletedH, false);
    return r.arr.length === 0;
})(), '内容墓碑失效');
A('C1b 另一面：**墙钟晚于墓碑**的同内容条目不该被内容墓碑误删（v2.91.0 加严口径）', (() => {
    const fresh = Object.assign({}, peer, { id: 'peer-10', updatedAt: ts1 + 1000 });
    const r = applyDeletedToArray('atoms', [fresh], state.deleted, state.deleted, state.deletedH, state.deletedH, false);
    return r.arr.length === 1;
})(), '误删了删除之后写回的同内容');
A('C1c 清单里能看到这条墓碑（界面恢复入口的前提）', (() => {
    const l = recycleBinList();
    return l.total === 1 && l.items[0].id === 'a1';
})(), J(recycleBinList()));
recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
A('C2 恢复后：同内容可以重新写入（合并用例 → 墓碑清掉才允许）', (() => {
    const r = applyDeletedToArray('atoms', [peer], state.deleted, state.deleted, state.deletedH, state.deletedH, false);
    return r.arr.length === 1 && r.arr[0].id === 'peer-9';
})(), '墓碑未清干净');

// ---------- ④ 不误伤 ----------
boot();
deleteEntry('atoms', 'a1');
const keepTs = 123;
tombSet('atoms', 'keep', keepTs);                     // 另一条（不同 id）的墓碑
tombSetH('atoms', 'H-keep', keepTs);                  // 它的内容墓碑（同一时刻）
recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
A('D1 只清被选中的那条；其它 id 墓碑一条不动', !!tombstoneMap().atoms && !!tombstoneMap().atoms.keep && !tombstoneMap().atoms.a1, J(tombstoneMap().atoms));
A('D2 **时间戳不等**的内容墓碑不被误清（只清能证明是这一条的）', !!tombstoneHMap().atoms && !!tombstoneHMap().atoms['H-keep'], J(tombstoneHMap().atoms));
A('D3 跨维度不串（记忆维度的墓碑不受影响）', (() => {
    boot();
    tombSet('atoms', 'a1', 1000); tombSet('memories', 'm1', 1000);
    recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
    return !!tombstoneMap().memories && !!tombstoneMap().memories.m1;
})(), 'n/a');

// ---------- ⑤ 界面动作 ----------
boot();
deleteEntry('atoms', 'a1');
deleteEntry('memories', 'm1');
A('E1 `rbAll` 勾选清单全部（跨维度）', (() => {
    const r = runRecycleBinAction('rbAll', {});
    return r.ok === true && r.picked === 2 && recycleBinUiState().picked === 2;
})(), J(recycleBinUiState()));
A('E2 `rbToggle` 单条取消勾选', (() => {
    runRecycleBinAction('rbToggle', { rbDim: 'atoms', rbId: 'a1', on: false });
    const r = recycleBinUiState();
    return r.picked === 1;
})(), J(recycleBinUiState()));
A('E3 `rbNone` 清空勾选', runRecycleBinAction('rbNone', {}).picked === 0, J(recycleBinUiState()));
A('E4 未勾选就恢复 → **明确拒绝**（reason=nothing-picked，零写入）', (() => {
    const before = J(tombstoneMap());
    const r = runRecycleBinAction('rbRestore', {});
    return r.ok === false && r.reason === 'nothing-picked' && before === J(tombstoneMap());
})(), '未勾选却写了');
A('E5 `rbToggle` 缺维度 / 缺 id → 拒绝（reason=bad-ref）', (() => {
    const r = runRecycleBinAction('rbToggle', { rbId: 'x' });
    return r.ok === false && r.reason === 'bad-ref';
})(), 'n/a');
A('E6 恢复成功 → 返回条数 + 清空勾选 + 给出人读提示', (() => {
    runRecycleBinAction('rbAll', {});
    const w = recycleBinAction('rbRestore', {});
    return w.result.ok === true && w.result.restored === 2 && w.note.indexOf('已恢复 2 条') >= 0 && recycleBinUiState().picked === 0;
})(), J(recycleBinAction('rbRestore', {})));
A('E7 勾选求交：墓碑已消失的勾选会被自动剔除（不悬空）', (() => {
    boot(); deleteEntry('atoms', 'a1');
    runRecycleBinAction('rbToggle', { rbDim: 'atoms', rbId: 'a1', on: true });
    // 模拟并发清墓碑（如对端合并把这条合法清掉）→ 勾选应与现存清单求交
    delete tombstoneMap().atoms.a1;
    const h = recycleBinSectionHtml();
    return recycleBinUiState().picked === 0;
})(), J(recycleBinUiState()));

// ---------- ⑥ 面板接线（端到端最小闭环） ----------
boot();
deleteEntry('atoms', 'a1');
openPanel();
await panelAction('settingsSub', { sub: 'data' });
const h = panelBodyHtml('settings');
A('F1 数据管理页渲染出「最近删除」区块（危险区之前）', String(h).indexOf('最近删除') >= 0, '缺少区块');
A('F2 区块位置在危险操作横幅**之前**（设计稿原文）', (() => {
    const i = String(h).indexOf('最近删除'), j = String(h).indexOf('data-ftt-danger-zone');
    return i >= 0 && j >= 0 && i < j;
})(), '位置不对');
A('F3 文案写明「恢复 = 只清墓碑，不把正文搬回来」与「对端仍以墓碑为准」', (() => {
    const s = String(h);
    return s.indexOf('清除这些墓碑记录') >= 0 && s.indexOf('对端仍以墓碑为准') >= 0;
})(), '缺关键说明');
A('F4 恢复按钮在未勾选时为 disabled（且带二次确认登记）', (() => {
    resetRecycleBinSelection();
    const s = recycleBinSectionHtml();
    return s.indexOf('data-ftt-action="rbRestore"') >= 0 && s.indexOf('rbRestore" disabled') >= 0;
})(), 'n/a');
A('G1 面板分发：`rbAll` 经 `panelAction` 走通并重绘', await (async () => {
    const r = await panelAction('rbAll', {});
    return r.ok === true && recycleBinUiState().picked === 1;
})(), 'n/a');
A('G2 面板分发：`rbRestore` 清墓碑并回报条数', await (async () => {
    const r = await panelAction('rbRestore', {});
    return r.ok === true && Number(r.restored) === 1 && !tombstoneMap().atoms;
})(), J(tombstoneMap()));

// 反向探针：把「恢复」写成「不清墓碑」会被 B1/C2 同时抓住
A('H1 反向探针：恢复必须真的改动墓碑（不动墓碑则 B1/C2 变红）', (() => {
    boot(); deleteEntry('atoms', 'a1');
    const before = !!tombstoneMap().atoms;
    recycleBinRestore([{ dim: 'atoms', id: 'a1' }]);
    return before === true && !tombstoneMap().atoms;
})(), 'n/a');
A('H2 `RECYCLE_BIN_MAX` 是有界正整数（只读视图不无上限渲染）', Number.isFinite(RECYCLE_BIN_MAX) && RECYCLE_BIN_MAX > 0);

un();
R.done();
