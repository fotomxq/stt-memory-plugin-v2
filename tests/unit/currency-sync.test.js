// ============================================================
// 单元测试 · 货币（`currencies`）的**跨端同步**（v3.45.6，用户报告「货币总是没有同步」）
//
// 背景（三条同源，缺一都不会有「总是不同步」的观感）：
//   ① `currencies` **不在** `ATOM_DIM_KEYS` 内（`core/constants.js`；`docs/D8` R11 裁定「货币暂不纳入哈希」）
//      → `mergeDataObjects` 的逐条合并根本不处理货币，只按「非原子容器整侧取较新」；
//   ② `dataAggHash` **计入**货币 → 两端「只差货币」时 `aggSame=false`，而 `diffAtomData` 看不见货币
//      → `crossComputeInfo` 判成 `replace-remote` / `replace-local`（**整体替换**）；
//   ③ 于是：远端较新 → 本端独有货币被整维丢掉；本端较新 → 对端货币永不并入；
//      「立即同步 / 采用对端」的 `adoptRemoteEnvelope` 更是直接丢弃本端全部货币。
//
// 本版口径（与其它原子维度同口径）：**逐条并集**（同一「归属 + 币种」一条）· 冲突取「更新的那一侧」
//   （条目 `updatedAt` → 信封时间）· **收支流水并集**（同日期 + 同额 + 同说明去重，最近 12 笔）·
//   **id / 内容双墓碑**（跨端删除不复活）· 「是否超集」的判定把货币差异一并计入。
//
// 有意保持不动（V1 黄金样本锁定，`tests/unit/cross-sync-golden.test.js`）：`dataAggHash` 的算法、
//   `atomEntryCount` 的维度集合、`diffAtomData` 的字段集。
// 反向探针：把 `mergeDataObjects` 的货币并集换回「整侧取较新」（或把 `currencies` 放回非原子列表），
//   M5 / M6 / M11 必须失败。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { storageEnvelope } from '../../core/envelope.js';
import {
    mergeCurrencyArrays, diffCurrencyData, currencyIdentityKey, mergeDataObjects, dataAggHash,
} from '../../core/cross-sync.js';
import { adoptRemoteEnvelope, crossComputeInfo } from '../../adapters/sync.js';

const R = makeReporter('currency-sync v3.45.6 货币跨端同步（逐条并集 / 冲突取新 / 收支并集 / 双墓碑）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const cur = (owner, name, amount, extra) => Object.assign({ owner, name, amount }, extra || {});
/** 手造信封：`storageEnvelope` 会把 `payload.updatedAt` 改写成 `Date.now()`，而本组要模拟「对端信封较旧 / 较新」 */
const envAt = (data, at) => ({ v: 1, scope: 'test', payload: { scope: 'test', updatedAt: Number(at) || 0, data: clone(data) }, hash: '', ts: Number(at) || 0 });

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot(data) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:currency');
    setKernelState(Object.assign(emptyState(), clone(data || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return state;
}

// ---------- A 组：逐条并集（纯函数） ----------
A('A1 `mergeCurrencyArrays`：**双端独有各保留**（不是整侧取较新）—— 本端独有 + 对端独有都在', (() => {
    const l = [cur('甲', '银元', 5), cur('甲', '贝壳', 3)];
    const r = [cur('甲', '银元', 9), cur('乙', '美元', 100)];
    const out = mergeCurrencyArrays(l, r, { preferRemote: true });
    const keys = out.map((x) => x.owner + '·' + x.name).sort();
    return out.length === 3 && J(keys) === J(['乙·美元', '甲·贝壳', '甲·银元'])
        && out.filter((x) => x.name === '银元')[0].amount === 9      // 同一条冲突 → 取新
        && out.filter((x) => x.name === '贝壳')[0].amount === 3      // 本端独有 → 不被丢掉（旧口径会丢）
        && out.filter((x) => x.name === '美元')[0].amount === 100;   // 对端独有 → 并入（旧口径永不并入）
})(), (() => mergeCurrencyArrays([cur('甲', '银元', 5), cur('甲', '贝壳', 3)], [cur('甲', '银元', 9), cur('乙', '美元', 100)], { preferRemote: true }))());

A('A2 冲突仲裁：条目 `updatedAt` 较新者胜；并列（AI 写入无墙钟）时**信封较新的一侧**胜', (() => {
    const lOld = cur('甲', '银元', 5, { updatedAt: 100 });
    const rNew = cur('甲', '银元', 9, { updatedAt: 900 });
    const winByEntry = mergeCurrencyArrays([lOld], [rNew], { preferRemote: false })[0];       // 远端条目更新 → 远端胜
    const winByEnvelope = mergeCurrencyArrays([cur('甲', '银元', 5)], [cur('甲', '银元', 9)], { preferRemote: false })[0];
    const winByEnvelopeR = mergeCurrencyArrays([cur('甲', '银元', 5)], [cur('甲', '银元', 9)], { preferRemote: true })[0];
    return winByEntry.amount === 9 && winByEnvelope.amount === 5 && winByEnvelopeR.amount === 9;
})(), (() => ({ byEntry: mergeCurrencyArrays([cur('甲', '银元', 5, { updatedAt: 100 })], [cur('甲', '银元', 9, { updatedAt: 900 })], { preferRemote: false }), byEnv: mergeCurrencyArrays([cur('甲', '银元', 5)], [cur('甲', '银元', 9)], { preferRemote: false }) }))());

A('A3 身份键：优先「归属 + 币种」（`id` 形态不一致的老数据不会分裂成两条）；无身份键的条目**原样保留不合并**', (() => {
    const a = cur('甲', '银元', 5, { id: 'cur_aaa' });
    const b = cur('甲', '银元', 9, { id: 'c1' });                       // V1 原始形态：id 不同、归属+币种相同
    const merged = mergeCurrencyArrays([a], [b], { preferRemote: true });
    const keyOfRaw = currencyIdentityKey({ id: 'c1', who: '甲', kind: '银元' });   // V1 原始字段名（who/kind）
    const noKey = mergeCurrencyArrays([{ amount: 1 }], [{ amount: 2 }], { preferRemote: true });
    return merged.length === 1 && merged[0].amount === 9
        && keyOfRaw === currencyIdentityKey({ owner: '甲', name: '银元' })
        && noKey.length === 2;
})(), (() => ({ merged: mergeCurrencyArrays([cur('甲', '银元', 5, { id: 'cur_aaa' })], [cur('甲', '银元', 9, { id: 'c1' })], { preferRemote: true }), raw: currencyIdentityKey({ id: 'c1', who: '甲', kind: '银元' }) }))());

A('A4 收支流水**并集**（同日期 + 同额 + 同说明去重；只留最近 12 笔）—— 只报收支的那一端流水不被覆盖', (() => {
    const h1 = [{ date: '1919-11-29', delta: 50, note: '卖船板' }];
    const h2 = [{ date: '1919-11-30', delta: -20, note: '买药' }];
    const out = mergeCurrencyArrays([cur('甲', '银元', 5, { history: clone(h1) })], [cur('甲', '银元', 9, { history: clone(h2) })], { preferRemote: true })[0];
    const dup = mergeCurrencyArrays([cur('甲', '银元', 5, { history: clone(h1) })], [cur('甲', '银元', 9, { history: clone(h1) })], { preferRemote: true })[0];
    const many = [];
    for (let i = 1; i <= 15; i++) many.push({ date: '1919-12-' + String(i).padStart(2, '0'), delta: i, note: 'n' + i });
    const capped = mergeCurrencyArrays([cur('甲', '银元', 1, { history: many.slice(0, 8) })], [cur('甲', '银元', 2, { history: many.slice(8) })], { preferRemote: true })[0];
    return out.history.length === 2 && out.history[0].note === '卖船板' && out.history[1].note === '买药'
        && dup.history.length === 1                                        // 同一笔（日期+额+说明）只保留一条
        && capped.history.length === 12                                    // 上限 12 笔（与 `mergeMoneyHistory` 同口径）
        && capped.history[11].note === 'n15';
})(), (() => mergeCurrencyArrays([cur('甲', '银元', 5, { history: [{ date: '1919-11-29', delta: 50, note: '卖船板' }] })], [cur('甲', '银元', 9, { history: [{ date: '1919-11-30', delta: -20, note: '买药' }] })], { preferRemote: true }))());

// ---------- B 组：差异统计 ----------
A('B1 `diffCurrencyData`：same / onlyLocal / onlyRemote / conflict + 胜负 与 `diffAtomData` 同口径；`uses` / 楼层不同**不算内容冲突**', (() => {
    const l = { updatedAt: 1000, currencies: [cur('甲', '银元', 5, { uses: 1, floorEnd: 3 }), cur('甲', '贝壳', 3, { id: 'x1' })] };
    const r = { updatedAt: 2000, currencies: [cur('甲', '银元', 5, { uses: 9, floorEnd: 7 }), cur('乙', '美元', 1, { id: 'y1' })] };
    const d = diffCurrencyData(l, r);
    const empty = diffCurrencyData(null, null);
    return d.same === 1 && d.onlyLocal === 1 && d.onlyRemote === 1 && d.conflict === 0
        && empty.same === 0 && empty.conflict === 0;
})(), (() => diffCurrencyData({ updatedAt: 1000, currencies: [cur('甲', '银元', 5, { uses: 1 })] }, { updatedAt: 2000, currencies: [cur('甲', '银元', 5, { uses: 9 })] }))());

A('B2 `diffCurrencyData` 冲突：按「条目 updatedAt → 信封时间」判胜负（本端较新时本端胜，不再永远对端胜）', (() => {
    const l = { updatedAt: 9000, currencies: [cur('甲', '银元', 5)] };
    const r = { updatedAt: 1000, currencies: [cur('甲', '银元', 9)] };
    const d1 = diffCurrencyData(l, r);
    const d2 = diffCurrencyData(r, l);
    return d1.conflict === 1 && d1.conflictWinLocal === 1 && d1.conflictWinRemote === 0
        && d2.conflict === 1 && d2.conflictWinRemote === 1;
})(), (() => diffCurrencyData({ updatedAt: 9000, currencies: [cur('甲', '银元', 5)] }, { updatedAt: 1000, currencies: [cur('甲', '银元', 9)] }))());

// ---------- C 组：合并路径（mergeDataObjects） ----------
A('C1 `mergeDataObjects`：远端信封更新 + 两端各有独有货币 → **并集**（旧口径「整侧取较新」会丢掉本端独有货币 = 用户报的 BUG）', (() => {
    const base = { updatedAt: 5000, currencies: [cur('甲', '银元', 5), cur('甲', '贝壳', 3)] };
    const remote = { updatedAt: 8000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] };
    const out = mergeDataObjects(clone(base), clone(remote), {}).data.currencies;
    const got = out.map((x) => x.owner + '·' + x.name + '=' + x.amount).sort();
    return J(got) === J(['乙·美元=100', '甲·贝壳=3', '甲·银元=9']);
})(), (() => mergeDataObjects(clone({ updatedAt: 5000, currencies: [cur('甲', '银元', 5), cur('甲', '贝壳', 3)] }), clone({ updatedAt: 8000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] }), {}).data.currencies)());

A('C2 `mergeDataObjects`：本端信封更新 + 对端有独有货币 → **同样并入**（旧口径 `remTs > baseTs` 才取对端 → 永不并入）', (() => {
    const base = { updatedAt: 9000, currencies: [cur('甲', '银元', 5)] };
    const remote = { updatedAt: 1000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] };
    const out = mergeDataObjects(clone(base), clone(remote), {}).data.currencies;
    const byName = {};
    out.forEach((x) => { byName[x.name] = x.amount; });
    return out.length === 2 && byName['银元'] === 5 && byName['美元'] === 100;
})(), (() => mergeDataObjects(clone({ updatedAt: 9000, currencies: [cur('甲', '银元', 5)] }), clone({ updatedAt: 1000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] }), {}).data.currencies)());

A('C3 货币**跨端删除不复活**（`deleted.currencies` id 墓碑 + `deletedH.currencies` 内容墓碑）+ 削减量进 `stat.reductions.byDim.currencies`', (() => {
    const base = { updatedAt: 5000, currencies: [cur('甲', '银元', 5, { id: 'cur_x' })], deleted: { currencies: { cur_x: 9999 } } };
    const remote = { updatedAt: 8000, currencies: [cur('甲', '银元', 5, { id: 'cur_x' }), cur('乙', '美元', 1, { id: 'cur_y' })], deleted: { currencies: { cur_y: 9999 } } };
    const r = mergeDataObjects(clone(base), clone(remote), {});
    const dim = (r.stat.reductions.byDim || {}).currencies || {};
    return (r.data.currencies || []).length === 0                    // 两条都被各自墓碑挡住（删除不复活）
        && dim.tombstone === 2
        && r.stat.reductions.tombstone >= 2;
})(), (() => { const b = { updatedAt: 5000, currencies: [cur('甲', '银元', 5, { id: 'cur_x' })], deleted: { currencies: { cur_x: 9999 } } }; const rm = { updatedAt: 8000, currencies: [cur('甲', '银元', 5, { id: 'cur_x' }), cur('乙', '美元', 1, { id: 'cur_y' })], deleted: { currencies: { cur_y: 9999 } } }; return mergeDataObjects(clone(b), clone(rm), {}).data; })());

A('C4 无收支的同一条：合并结果**逐字段取自更新的那一侧**（不新增字段）—— 与 V1 黄金样本同形（`cross-sync-golden S4` 同口径）', (() => {
    const base = { updatedAt: 5000, currencies: [{ id: 'c1', who: '甲', kind: '银元', amount: 5 }] };
    const remote = { updatedAt: 8000, currencies: [{ id: 'c1', who: '甲', kind: '银元', amount: 9 }] };
    const out = mergeDataObjects(clone(base), clone(remote), {}).data.currencies;
    return J(out) === J([{ id: 'c1', who: '甲', kind: '银元', amount: 9 }]);
})(), (() => mergeDataObjects(clone({ updatedAt: 5000, currencies: [{ id: 'c1', who: '甲', kind: '银元', amount: 5 }] }), clone({ updatedAt: 8000, currencies: [{ id: 'c1', who: '甲', kind: '银元', amount: 9 }] }), {}).data.currencies)());

A('C5 幂等 + 只读入参：同一条合并两次结果一致；`mergeDataObjects` 不修改传入的两份数据', (() => {
    const base = { updatedAt: 5000, currencies: [cur('甲', '银元', 5), cur('甲', '贝壳', 3)] };
    const remote = { updatedAt: 8000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] };
    const before = J([base, remote]);
    const once = mergeDataObjects(clone(base), clone(remote), {}).data;
    const twice = mergeDataObjects(clone(once), clone(remote), {}).data;
    return J(once.currencies) === J(twice.currencies) && J([base, remote]) === before;
})(), (() => { const b = { updatedAt: 5000, currencies: [cur('甲', '银元', 5)] }; const r = { updatedAt: 8000, currencies: [cur('甲', '银元', 9)] }; return mergeDataObjects(clone(b), clone(r), {}).data.currencies; })());

// ---------- D 组：同步决策与「整体采用对端」 ----------
A('D1 `crossComputeInfo`：两端**只差货币**时不再误判 `replace-remote` / `replace-local`（整体替换）；`aggSame` 仍按 V1 口径（货币计入指纹）', (() => {
    const l = { updatedAt: 5000, atoms: [{ id: 'a1', text: '同文', updatedAt: 1 }], currencies: [cur('甲', '银元', 5)] };
    const r = { updatedAt: 8000, atoms: [{ id: 'a1', text: '同文', updatedAt: 1 }], currencies: [cur('甲', '银元', 9)] };
    const info = crossComputeInfo(clone(l), clone(r), r.updatedAt);
    return info.aggSame === false && info.diff.onlyLocal === 0 && info.diff.onlyRemote === 0
        && info.curDiff.conflict === 1 && info.mode !== 'replace-remote' && info.mode !== 'replace-local'
        && info.mode === 'divergence';
})(), (() => crossComputeInfo({ updatedAt: 5000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 5)] }, { updatedAt: 8000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 9)] }, 8000))());

A('D2 `crossComputeInfo` 反向：货币**本端为超集**（对端没有任何本端缺失的货币）时仍判 `replace-local`（本端覆盖对端，不产生无谓融合）', (() => {
    const l = { updatedAt: 9000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 9), cur('乙', '美元', 1)] };
    const r = { updatedAt: 1000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 9)] };
    const info = crossComputeInfo(clone(l), clone(r), r.updatedAt);
    return info.curDiff.onlyRemote === 0 && info.curDiff.conflictWinRemote === 0 && info.mode === 'replace-local';
})(), (() => crossComputeInfo({ updatedAt: 9000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 9), cur('乙', '美元', 1)] }, { updatedAt: 1000, atoms: [{ id: 'a1', text: '同文' }], currencies: [cur('甲', '银元', 9)] }, 1000))());

A('D3 `adoptRemoteEnvelope`（整体采用对端）：本端独有货币**仍在**，冲突取新 —— 旧实现把货币整维替换掉（本端条目与较新额度全丢）', (() => {
    boot({ updatedAt: 5000, currencies: [cur('甲', '银元', 5), cur('甲', '贝壳', 3)] });
    const remote = { updatedAt: 8000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] };
    const ok = adoptRemoteEnvelope(envAt(remote, 8000));
    const got = (state.currencies || []).map((x) => x.owner + '·' + x.name + '=' + x.amount).sort();
    return ok === true && J(got) === J(['乙·美元=100', '甲·贝壳=3', '甲·银元=9']);
})(), (() => { boot({ updatedAt: 5000, currencies: [cur('甲', '银元', 5), cur('甲', '贝壳', 3)] }); adoptRemoteEnvelope(envAt({ updatedAt: 8000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 100)] }, 8000)); return state.currencies; })());

A('D4 `adoptRemoteEnvelope`：整体采用对端时**本端较新的额度不被对端旧额度冲掉**（信封较旧 → 并列冲突取本端）+ 本端墓碑仍生效', (() => {
    boot({ updatedAt: 9000, currencies: [cur('甲', '银元', 77)], deleted: { currencies: { cur_gone: 9999 } } });
    const remote = { updatedAt: 1000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 1, { id: 'cur_gone' })] };
    adoptRemoteEnvelope(envAt(remote, 1000));                 // 注意：信封时间取「写它的那一端」的 1000（**早于**本端 9000）
    const byName = {};
    (state.currencies || []).forEach((x) => { byName[x.name] = x.amount; });
    return byName['银元'] === 77 && byName['美元'] === undefined;
})(), (() => { boot({ updatedAt: 9000, currencies: [cur('甲', '银元', 77)], deleted: { currencies: { cur_gone: 9999 } } }); adoptRemoteEnvelope(envAt({ updatedAt: 1000, currencies: [cur('甲', '银元', 9), cur('乙', '美元', 1, { id: 'cur_gone' })] }, 1000)); return state.currencies; })());

A('D5 兜底：非法 / 空输入不抛（`null` / 非数组 / 非对象一律安全退化）', (() => {
    const a = mergeCurrencyArrays(null, null, {});
    const b = mergeCurrencyArrays([{ owner: '甲', name: '银元', amount: 1 }], 'not-an-array', {});
    const c = diffCurrencyData(null, {});
    const d = mergeDataObjects(null, null, {});
    return Array.isArray(a) && a.length === 0 && b.length === 1 && c.conflict === 0
        && !!d && !!d.data && typeof dataAggHash(d.data) === 'string';
})(), (() => ({ a: mergeCurrencyArrays(null, null, {}), c: diffCurrencyData(null, {}) }))());

R.done();
