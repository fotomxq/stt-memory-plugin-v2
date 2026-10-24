// ============================================================
// 单元测试 · v3.51.6 **货币归属漏斗**（用户要求：AI 把别人货币分析进来 → 主体不在主角/指定人员 → 直接舍弃）
//
// 覆盖：
//   A `currencyOwnerAllowed`：主角名（含包含匹配）· 指定人员 · 路人 → false · 空归属 → false
//   B AI 增量入库：主角/指定人员保留；**第三人舍弃**（add / update 都过漏斗）· 关掉开关 → 全保留
//   C 手工通路不受影响：编辑器/快速记账写入「其他人」的货币照常入库（漏斗只管 AI 增量）
//   D 已有存档里"其他人"的货币**不清理**（漏斗管新数据）
// 运行：node tests/unit/currency-funnel.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { currencyOwnerAllowed, normalizeCurrency, defaultCurrencyOwner } from '../../core/model/money.js';
import { applyQuickCurrencyFlow } from '../../core/currency-quick.js';
import { mergeDelta } from '../../core/ingest.js';

const R = makeReporter('currency-funnel v3.51.6 货币归属漏斗（程序化 · 不经 AI）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:funnel');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.protagonist = { name: '林昭' };
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const cu = (owner, name, amount) => ({ owner: owner, name: name, amount: amount == null ? 10 : amount, unit: '枚' });

// ---------- A 判据 ----------
A('A1 允许：**主角**（相等 / 包含匹配，如「林昭」「林昭·主角」）与**指定人员**；不容许：路人 / 空归属', (() => {
    boot();
    cfg.currencyTrackedRoles = ['沈青'];
    return currencyOwnerAllowed('林昭') === true && currencyOwnerAllowed('林昭·主角') === true
        && currencyOwnerAllowed('沈青') === true && currencyOwnerAllowed('沈青（护卫）') === true
        && currencyOwnerAllowed('王二麻子') === false && currencyOwnerAllowed('') === false && currencyOwnerAllowed(null) === false;
})(), () => J(['林昭', '林昭·主角', '沈青', '王二麻子'].map((x) => [x, currencyOwnerAllowed(x)])));

// ---------- B AI 增量入库 ----------
A('B1 **add**：主角与指定人员保留；第三人**直接舍弃**（不入库、不写账本）', (() => {
    boot({ currencies: [], ledger: [] });
    cfg.currencyTrackedRoles = ['沈青'];
    const delta = { currencies: { add: [cu('林昭', '银元', 100), cu('沈青', '铜钱', 5), cu('王二麻子', '私房钱', 88)] } };
    mergeDelta(delta, { floor: { start: 1, end: 1 } });
    const owners = state.currencies.map((x) => String(x.owner));
    return state.currencies.length === 2 && owners.indexOf('王二麻子') < 0
        && owners.indexOf('林昭') >= 0 && owners.indexOf('沈青') >= 0;
})(), () => J(state.currencies.map((x) => x.owner)));
A('B2 **update** 也过漏斗：对「第三人」的更新不落地（原有条目原样不动；不新建）', (() => {
    boot({ currencies: [{ id: 'cur_w', owner: '王二麻子', name: '私房钱', amount: 88, unit: '枚', history: [] }] });
    mergeDelta({ currencies: { update: [Object.assign({ id: 'cur_w' }, cu('王二麻子', '私房钱', 999))] } }, { floor: { start: 2, end: 2 } });
    const w = state.currencies.filter((x) => String(x.owner) === '王二麻子')[0];
    return state.currencies.length === 1 && w && Number(w.amount) === 88;
})(), () => J(state.currencies));
A('B3 开关 `cfg.currencyFunnel = false` → 全部保留（老存档 / 用户想全量时可用）', (() => {
    boot({ currencies: [] });
    cfg.currencyFunnel = false;
    mergeDelta({ currencies: { add: [cu('林昭', '银元', 100), cu('王二麻子', '私房钱', 88)] } }, { floor: { start: 1, end: 1 } });
    return state.currencies.length === 2;
})(), () => J(state.currencies.map((x) => x.owner)));
A('B4 空归属按主角入库（`normalizeCurrency` 先回落主角名，漏斗再放行）', (() => {
    boot({ currencies: [] });
    mergeDelta({ currencies: { add: [{ name: '银元', amount: 7 }] } }, { floor: { start: 1, end: 1 } });
    return state.currencies.length === 1 && String(state.currencies[0].owner) === defaultCurrencyOwner();
})(), () => J(state.currencies));

// ---------- C 手工通路不受影响 ----------
A('C1 快速记账 / 编辑器手工写入「其他人」的货币**照常入库**（漏斗只作用于 AI 增量）', (() => {
    boot({ currencies: [{ id: 'cur_b', owner: '王二麻子', name: '私房钱', amount: 10, unit: '枚', history: [] }] });
    const r = applyQuickCurrencyFlow(state.currencies[0], 'in', 5, {});
    return r && r.ok !== false && Number(r.currency.amount) === 15;
})(), 'n/a');

// ---------- D 已有数据不清理 ----------
A('D1 已有存档里「其他人」的货币**不被清理**（漏斗管新数据，不替用户删旧数据 —— `D28` 口径）', (() => {
    boot({ currencies: [{ id: 'cur_old', owner: '路人甲', name: '碎银', amount: 3, unit: '枚', history: [] }] });
    mergeDelta({ currencies: { add: [cu('林昭', '银元', 100)] } }, { floor: { start: 1, end: 1 } });
    return state.currencies.length === 2 && state.currencies.some((x) => String(x.owner) === '路人甲');
})(), () => J(state.currencies.map((x) => x.owner)));
A('D2 归一函数本身不拦（漏斗在**入库口**，不在模型层强塞）：`normalizeCurrency` 对任意归属都照常产出', (() => {
    const n = normalizeCurrency({ owner: '王二麻子', name: '私房钱', amount: 1 });
    return !!n && String(n.owner) === '王二麻子';
})(), 'n/a');

R.done();
