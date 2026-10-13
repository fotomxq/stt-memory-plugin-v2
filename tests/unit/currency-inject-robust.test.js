// ============================================================
// 单元测试 · v3.46.5（用户报告「货币根本没注入成功」）
//   **货币区块的注入健壮性**：一条坏数据不得让**整份注入**变空
//
// 根因（本轮实测）：`core/recall.js` 的 `[货币]` 区块里 `hist.map(f => f.date …)` 直接读元素字段；
//   收支数组里只要有一个非对象元素（`null` — 历史数据 / 导入 / 早期版本写入），就抛
//   `TypeError: Cannot read properties of null (reading 'date')`；而**整个注入体构建共用一个 try**，
//   于是 `catch { return '' }` → **货币连同其它全部记忆都没注入**（用户看到的就是「货币根本没注入成功」）。
// 修复：① 逐条清洗（只留对象元素）；② **货币区块单独兜错**（区块级隔离：坏了只丢货币）；
//   ③ 自查（`diagnose`）纳入货币的「看到 N / 注入 M」，让归属不匹配之类的原因**可诊断**。
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';

const R = makeReporter('currency-inject-robust v3.46.5 货币注入健壮性（坏数据不得让整份注入消失）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

function boot(over, cfgOver) {
    Object.assign(cfg, clone(defaultCfg));
    Object.assign(cfg, cfgOver || {});
    setScopeKey('char:cur-inject');
    setKernelState(Object.assign(emptyState(), { protagonist: { name: '李瑶' } }, clone(over || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return true;
}
const body = (opts) => String(buildMemoryBodyForInject('', Object.assign({ inject: false }, opts || {})) || '');
const CURS = () => ([
    { id: 'c1', owner: '李瑶', name: '黄金', unit: '两', amount: 120, date: '1919-11-20', uses: 2, history: [{ date: '1919-11-20', delta: 5, note: '赏银' }] },
    { id: 'c2', owner: '李瑶', name: '碎金子', unit: '两', amount: 30, date: '1919-11-26', uses: 1, history: [] },
]);
/** 一条情节：用来证明「货币坏了，别的大类还在」 */
const ATOM = { id: 'a1', title: '码头', text: '甲在码头清点货物。', content: '甲在码头清点货物。', uses: 1, floorStart: 0, floorEnd: 0 };

// ---------- A 组：正常路径（口径不变） ----------
A('A1 主角的货币**恒定注入**：`## 货币` 出现，行内含「归属·币种 额度 单位」，并按开关列出说明', (() => {
    boot({ currencies: CURS() });
    const t = body();
    return t.indexOf('## 货币') >= 0 && t.indexOf('李瑶·黄金 120 两') >= 0 && t.indexOf('李瑶·碎金子 30 两') >= 0;
})(), () => body().split('\n').filter((l) => l.indexOf('·') >= 0).join(' / ').slice(0, 160));

A('A2 `currencyEnabled=false` → 不注入货币区块（原口径不变）', (() => {
    boot({ currencies: CURS() }, { currencyEnabled: false });
    return body().indexOf('## 货币') < 0;
})(), '');

A('A3 归属不是主角且未标定 → **不注入**（设计口径：其他角色的货币仅在其被提及/在场时列出）但**别的大类照常**', (() => {
    boot({ atoms: [ATOM], currencies: [{ id: 'x1', owner: '路人甲', name: '银元', unit: '枚', amount: 5, uses: 1, history: [] }] });
    const t = body();
    return t.indexOf('## 货币') < 0 && t.indexOf('## 情节记忆') >= 0;
})(), () => body().match(/^## .*/gm) || []);

A('A4 标定跟踪后（`currencyTrackedRoles` 含该归属）→ **恒定注入**并标 ⭐已标定（原口径不变）', (() => {
    boot({ currencies: [{ id: 'x1', owner: '路人甲', name: '银元', unit: '枚', amount: 5, uses: 1, history: [] }] },
        { currencyTrackedRoles: ['路人甲'] });
    const t = body();
    return t.indexOf('## 货币') >= 0 && t.indexOf('路人甲·银元 5 枚') >= 0 && t.indexOf('⭐已标定') >= 0;
})(), '');

// ---------- B 组：健壮性（本次修复的核心） ----------
A('B1 **收支含非对象元素（null）不再让整份注入消失**：货币区块仍在（旧行为：正文长度 0、什么都没有）', (() => {
    boot({ currencies: CURS() });
    setKernelState(Object.assign(emptyState(), { protagonist: { name: '李瑶' }, currencies: (() => { const c = CURS(); c[0].history = [null]; return c; })() }));
    const t = body();
    return t.length > 0 && t.indexOf('## 货币') >= 0 && t.indexOf('李瑶·黄金 120 两') >= 0;
})(), () => J({ len: body().length, has: body().indexOf('## 货币') >= 0 }));

A('B2 收支里混入 `null` / 字符串 / 数字 → 只影响那一条的「近期」尾注，**行本身依旧注入**（逐条清洗）', (() => {
    boot({ currencies: (() => { const c = CURS(); c[0].history = [null, 'oops', 42, { date: '1919-11-21', delta: 7, note: '正常' }]; return c; })() });
    const t = body();
    const line = (t.split('\n').filter((l) => l.indexOf('李瑶·黄金') >= 0)[0] || '');
    return t.indexOf('## 货币') >= 0 && line.indexOf('120 两') >= 0 && line.indexOf('正常') >= 0;
})(), () => body().split('\n').filter((l) => l.indexOf('李瑶·黄金') >= 0).join(''));

A('B3 **区块级隔离**：货币数据坏掉时，其它大类（情节 / 记忆）照常注入 —— 一条坏数据只丢它自己那一块', (() => {
    boot({ atoms: [ATOM], memories: [{ id: 'm1', title: '旧事', text: '旧事一条', content: '旧事一条', uses: 1 }],
        currencies: (() => { const c = CURS(); c[0].history = [null]; return c; })() });
    const t = body();
    return t.indexOf('## 情节记忆') >= 0 && t.indexOf('## 长期记忆') >= 0 && t.indexOf('## 货币') >= 0;
})(), () => (body().match(/^## .*/gm) || []).join(' '));

A('B4 `currencies` 本身不是数组（脏数据）也不崩：货币区块缺席、其余照常（不返回空串）', (() => {
    boot({ atoms: [ATOM], currencies: { bad: true } });
    const t = body();
    return t.indexOf('## 情节记忆') >= 0 && t.indexOf('## 货币') < 0;
})(), () => (body().match(/^## .*/gm) || []).join(' '));

A('B5 条目里混入 `null` 条目 → 跳过该条，其余货币照常注入', (() => {
    boot({ currencies: [null, CURS()[0]] });
    const t = body();
    return t.indexOf('## 货币') >= 0 && t.indexOf('李瑶·黄金 120 两') >= 0;
})(), '');

// ---------- C 组：自我诊断（让「为什么没注入」有据可查） ----------
A('C1 自查（`diagnose`）纳入货币：候选 = **看到几条**（含未注入的），注入 = 实际写进正文的条数', (() => {
    boot({ currencies: [{ id: 'x1', owner: '路人甲', name: '银元', unit: '枚', amount: 5, uses: 1, history: [] }] });
    const d = buildMemoryBodyForInject('', { diagnose: true, inject: false });
    const cand = ((d && d.candidates && d.candidates.currencies) || []).length;
    const inj = ((d && d.injected && d.injected.currencies) || []).length;
    return !!d && cand === 1 && inj === 0;                       // 看到 1 条、注入 0 条 → 归属不匹配一眼可见
})(), () => { boot({ currencies: [{ id: 'x1', owner: '路人甲', name: '银元', unit: '枚', amount: 5, uses: 1, history: [] }] }); const d = buildMemoryBodyForInject('', { diagnose: true, inject: false }); return J({ cand: (d.candidates || {}).currencies, inj: (d.injected || {}).currencies }); });

A('C2 自查里主角货币：看到 N 与注入 M 一致（都进正文）', (() => {
    boot({ currencies: CURS() });
    const d = buildMemoryBodyForInject('', { diagnose: true, inject: false });
    const cand = ((d && d.candidates && d.candidates.currencies) || []).length;
    const inj = ((d && d.injected && d.injected.currencies) || []).length;
    return cand === 2 && inj === 2;
})(), '');

R.done();
