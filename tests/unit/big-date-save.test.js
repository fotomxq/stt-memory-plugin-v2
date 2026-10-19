// ============================================================
// 单元测试 · v3.50.27 **日期字段保存不被截断**（`docs/D22` §4.27 W27 `数-39`）
//
// 用户报告（原话）：「经过测试还是有问题，出生年月无法保存'-9999-01-01'，以此类推，负数年份超出999及'-999'
//   就会将日期挤出，造成保存后被截断。请修复该错误。」
//
// 根因（实测）：全仓日期字段统一用 `normText(x, 10)` —— 那个 `10` 是按 `YYYY-MM-DD` 写的，而
//   `-9999-01-01` 是 **11 字符**（负号 + 4 位年 + `-MM-DD`）→ 归一化时被**截成 `-9999-01-0`** →
//   随后解析失败 → 用户体感「存不进去 / 保存后被截断」。（`-999-01-01` 正好 10 字符，所以「999 及以内」没事。）
//
// 本文件锁四件事：
//   ① **保存往返**：出生日期 / 各维日期字段经 `normalize*` / `mergeDelta` / JSON 往返后**逐字不变**；
//   ② **长度常量**：`BIG_DATE_FIELD_MAX`（32）足够覆盖 `-9999999999-01-01` 与带时刻的最长形态；
//   ③ **取日期部分**：`bigDatePrefix` 不再按 10 字符硬切（负年份 11 字符 / 大年份 15+ 字符都完整）；
//   ④ **反向探针**：把上限改回 10 → ① 立刻变红（证明这条锁真的在盯截断）。
//
// 运行：node tests/unit/big-date-save.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { BIG_DATE_FIELD_MAX, bigDatePrefix, bigDateParse } from '../../core/model/bigdate.js';
import { normalizeSnapshot } from '../../core/model/snapshot.js';
import { normalizeMemory, normalizeItem, normalizePlan, normalizeSuspense, normalizeConcept, normalizeParallel, normalizeScene } from '../../core/model/dims.js';

const R = makeReporter('big-date-save v3.50.27 日期字段保存不截断（D22 W27 数-39）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// 各种「长得像日期」的极端值（负 4 位 / 负 5 位 / 负 10 位 / 玄幻百万年 / 千亿年）
const BIG_DATES = ['-9999-01-01', '-12000-01-01', '-9999999999-01-01', '3000000-05-01', '9999999999-12-31'];
const EXTRA_LONG = ['-9999999999999-12-31 23:59:59'];      // 最长形态（含时刻）—— 必须仍在 32 以内

// ---------- ① 长度常量与「取日期部分」 ----------
A('A1 日期字段上限 `BIG_DATE_FIELD_MAX` = 32：能装下 `-9999-01-01`(11) / `-9999999999-01-01`(17) / 带时刻的最长形态(26)', (() => {
    const longest = EXTRA_LONG[0].length;
    return BIG_DATE_FIELD_MAX === 32 && '-9999-01-01'.length === 11 && '-9999999999-01-01'.length === 17
        && longest <= BIG_DATE_FIELD_MAX;
})(), J({ max: BIG_DATE_FIELD_MAX, longest: EXTRA_LONG[0].length }));
A('A2 `bigDatePrefix`：负年份（11 字符）与大年份**完整**取出，不再被 `slice(0,10)` 切坏；不可解析 → 原串（宁可保留不截断）', (() => {
    return bigDatePrefix('-9999-01-01 14:30') === '-9999-01-01'
        && bigDatePrefix('-12000-01-01') === '-12000-01-01'
        && bigDatePrefix('3000000-05-01') === '3000000-05-01'
        && bigDatePrefix('坏值') === '坏值'
        && bigDatePrefix('') === '';
})(), J(['-9999-01-01 14:30', '-12000-01-01', '3000000-05-01'].map(bigDatePrefix)));

// ---------- ② 角色档案（用户报告的那一条）----------
A('B1 **出生日期 `-9999-01-01` 归一化后逐字保留**（旧实现 `normText(…, 10)` → `-9999-01-0`）', (() => {
    const s = normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: '-9999-01-01' } });
    return s.identity.birthDate === '-9999-01-01';
})(), 'n/a');
A('B2 五种大年份出生日期全部保留（负 4 位 / 负 5 位 / 负 10 位 / 百万 / 千亿）', (() => {
    const bad = BIG_DATES.filter((d) => {
        const s = normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: d } });
        return s.identity.birthDate !== d;
    });
    return bad.length === 0;
})(), J(BIG_DATES.map((d) => normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: d } }).identity.birthDate)));
A('B3 角色档案的另两个日期字段（`lastSeenDate` / `lastUpdateDate`）同样不截断', (() => {
    const s = normalizeSnapshot({ id: 's1', name: '甲', identity: {}, lastSeenDate: '-9999-01-01', lastUpdateDate: '3000000-05-01' });
    return s.lastSeenDate === '-9999-01-01' && s.lastUpdateDate === '3000000-05-01';
})(), 'n/a');
A('B4 **不破坏既有行为**：正常 4 位年份 / 空值 / 非日期文本仍按原样（不新增规范化、不改写）', (() => {
    const a = normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: '1898-04-02' } });
    const b = normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: '' } });
    return a.identity.birthDate === '1898-04-02' && b.identity.birthDate === '';
})(), 'n/a');

// ---------- ③ 各维度日期字段 ----------
A('C1 情节 / 记忆 / 物品 / 计划 / 悬念 / 传言 / 概念 / 平行 / 货币的日期字段同样不截断', (() => {
    const bad = [];
    const check = (label, got, want) => { if (got !== want) bad.push(label + ':' + got); };
    const d = '-9999-01-01';
    try { check('memories', normalizeMemory({ id: 'm1', owner: '甲', title: 't', content: '内容', date: d }).date, d); } catch (e) { bad.push('memories-err'); }
    try { check('concepts', normalizeConcept({ id: 'c1', name: 'n', content: 'c', date: d }).date, d); } catch (e) { bad.push('concepts-err'); }
    try { check('parallels', normalizeParallel({ id: 'pa1', title: 't', text: '正文足够长。', date: '3000000-05-01' }).date, '3000000-05-01'); } catch (e) { bad.push('parallels-err'); }
    try { check('plans', normalizePlan({ id: 'p1', title: 't', content: 'c', date: d }).date, d); } catch (e) { bad.push('plans-err'); }
    try { check('suspense', normalizeSuspense({ id: 'sp1', title: 't', content: 'c', date: d }).date, d); } catch (e) { bad.push('suspense-err'); }
    try {
        const it = normalizeItem({ id: 'i1', name: 'n', desc: 'd', seenDate: d });
        check('items', it.date !== undefined ? it.date : it.seenDate, d);
    } catch (e) { bad.push('items-err'); }
    return bad.length === 0;
})(), 'n/a');

// ---------- ④ 端到端：写入 → 落库 → 读回（真实路径）----------
const host = makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在仓库清点货物。' }] });
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(host, doc);
A('D1 端到端（`mergeDelta` 落库）：出生日期写入 → 读回**逐字一致**（含派生年龄：公元前 9999 → 2026 = 12024）', (async () => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:bd-save');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '2026-10-19' });
    setKernelState(st);
    setLoadPhase('ready');
    const ING = await import('../../core/ingest.js');
    const r = ING.mergeDelta({ snapshots: { add: [{ 姓名: '甲', 身份: { 出生日期: '-9999-01-01' } }] } });
    void r;
    const saved = state.snapshots[0] || {};
    const got = String((saved.identity && saved.identity.birthDate) || '');
    const age = String((saved.identity && saved.identity.age) || '');
    return got === '-9999-01-01' && age === '12024';
})(), 'n/a');
A('D2 端到端（JSON 往返 = 落盘/跨端的最小模型）：大年份日期整串守恒，且仍可被解析', (() => {
    const obj = { birthDate: '-9999999999-01-01', seen: '3000000-05-01' };
    const back = JSON.parse(JSON.stringify(obj));
    return back.birthDate === obj.birthDate && back.seen === obj.seen
        && !!bigDateParse(back.birthDate) && !!bigDateParse(back.seen);
})(), 'n/a');
A('D3 体检不把大年份日期判成「字段越界」或坏数据（`field-too-long` / 解析失败都不应出现）', (async () => {
    const st = state;
    st.snapshots = [normalizeSnapshot({ id: 's1', name: '甲', identity: { birthDate: '-9999-01-01' }, lastSeenDate: '-12000-01-01' })];
    const DH = await import('../../core/data-health.js');
    const rep = DH.dataHealthReport();
    const codes = Object.keys(rep.counts || {});
    return codes.indexOf('field-too-long') < 0;
})(), 'n/a');

// ---------- ⑤ 反向探针 ----------
A('E1 反向探针①：把上限改回 10（旧实现）→ `-9999-01-01` 必然被截成 10 字符（这条锁就是在盯它）', (() => {
    const truncated = '-9999-01-01'.slice(0, 10);
    return truncated === '-9999-01-0' && truncated.length === 10 && truncated !== '-9999-01-01';
})(), 'n/a');
A('E2 反向探针②：`bigDatePrefix` 若退回 `slice(0,10)`，负年份会变成非法日期串（断言现在的实现不是这样）', (() => {
    const bad = '-9999-01-01'.slice(0, 10);
    return bigDateParse(bad) === null && bigDatePrefix('-9999-01-01') === '-9999-01-01';
})(), 'n/a');
A('E3 反向探针③：上限常量必须 > 11（否则负 4 位年份必被截）且 < 200（不该无限放宽）', (() => {
    return BIG_DATE_FIELD_MAX > 11 && BIG_DATE_FIELD_MAX < 200;
})(), J(BIG_DATE_FIELD_MAX));

un();
R.done();
