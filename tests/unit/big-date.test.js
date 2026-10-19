// ============================================================
// 单元测试 · v3.50.26 大年份出生日期与年龄（`docs/D22` §4.25 W25 `数-32`）
//
// 用户要求（原话）：「角色出生年月和年龄需支持更大的年份，如 -9999-01-01，对应公元前9999年。
//   其次还有一些玄幻故事线，本身年月是百万计的，如果卡死也是问题。
//   1. 出生年月的结构必然是"正负年份-月份-月份"的结构，且年份不应限制死范围，确保计算不溢出即可。
//   2. 年龄应支持各种大年份的计算，而且如过超过一定量级，需加入单位简化，如102万岁、300亿岁等。」
//
// 本文件锁六件事（逐条对应上面的要求）：
//   ① **结构**：`[正负]年-月-日`（含低精度的年-月 / 年），`-` / `/` / `.` 等价，公元前可负年份或文本；
//   ② **不设死范围**：|年| 覆盖到安全整数护栏（1e13），百万 / 亿年可解析、可比较、可相减；`0 年` / 2月30日 / 超护栏 仍判非法；
//   ③ **计算不溢出**：日序走整数算法（不经 `Date`），并与整数日历自洽（1970-01-01 = 0、往返一致、单调）；
//   ④ **年龄**：跨大年份相减正确（含「生日未到 -1」与低精度规则）；
//   ⑤ **单位简化**：`<1万` 岁 · `≥1万` 万岁 · `≥1亿` 亿岁 · `≥1万亿` 万亿岁（最多 1 位小数）；
//   ⑥ **链路端到端**：出生日期 → `snapshotAge` → 列表行显示「万岁/亿岁」，且「神话尺度」不再误报「超长年龄」。
//
// 运行：node tests/unit/big-date.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    BIG_YEAR_MAX, BIG_YEAR_DIGITS, BIG_AGE_UNITS,
    bigDateParse, bigDateStr, bigDateValid, bigYearOk, bigYearStr,
    bigDayNumber, bigDateFromDayNumber, bigAgeYears, bigAgeParts, bigAgeText,
    bigIsLeap, bigDaysInMonth,
} from '../../core/model/bigdate.js';
import { calcAge, parseBirthDateParts, snapshotAge, snapshotBirthAnomaly, snapshotAgeBasisText } from '../../core/model/snapshot.js';
import { clockDateParts, clockDateTrim, clockDateValid, clockReplaceYear, clockYearStr, storyDateMsFromStr } from '../../core/clock.js';
import { openPanel, panelBodyHtml, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('big-date v3.50.26 大年份出生日期与年龄（D22 W25 数-32）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// ---------- ① 结构：正负年份-月-日（三种精度 / 分隔符 / 公元前文本） ----------
A('A1 结构：`-9999-01-01`（公元前 9999 年）· `-0221-01-02` · `3000000-05-01`（玄幻百万年）都能解析为 day 精度', (() => {
    const a = bigDateParse('-9999-01-01'), b = bigDateParse('-0221-01-02'), c = bigDateParse('3000000-05-01');
    return a && a.y === -9999 && a.m === 1 && a.d === 1 && a.precision === 'day'
        && b && b.y === -221 && b.m === 1 && b.d === 2
        && c && c.y === 3000000 && c.m === 5 && c.d === 1;
})(), J([bigDateParse('-9999-01-01'), bigDateParse('3000000-05-01')]));
A('A2 分隔符等价：`-` / `/` / `.` 三种写法解析结果一致；低精度（年-月 / 年）保留精度标记', (() => {
    const a = bigDateParse('3000000/5/1'), b = bigDateParse('3000000.5.1'), c = bigDateParse('3000000-05'), d = bigDateParse('-9999');
    return J(a) === J(bigDateParse('3000000-05-01')) && J(a) === J(b)
        && c && c.precision === 'month' && c.d === 1 && d && d.precision === 'year' && d.y === -9999;
})(), 'n/a');
A('A3 公元前文本写法同样支持大年份：`公元前9999年1月2日` · `前9999年` · `9999 BC`', (() => {
    const a = bigDateParse('公元前9999年1月2日'), b = bigDateParse('前9999年'), c = bigDateParse('9999 BC');
    return a && a.y === -9999 && a.m === 1 && a.d === 2 && a.precision === 'day'
        && b && b.y === -9999 && b.precision === 'year'
        && c && c.y === -9999;
})(), 'n/a');
A('A4 允许尾部时间/后缀（剧情日期常带时刻）：`1919-11-29 14:30` 只取日期部分', (() => {
    const p = bigDateParse('1919-11-29 14:30');
    return p && p.y === 1919 && p.m === 11 && p.d === 29 && p.precision === 'day';
})(), 'n/a');
A('A5 规范化输出：`bigDateStr` 负数带 `-`、月日补零、年份不足 4 位补零、大年份不截断', (() => {
    return bigDateStr('-9999-1-1') === '-9999-01-01' && bigDateStr('221-1-2') === '0221-01-02'
        && bigDateStr('3000000-5-1') === '3000000-05-01' && bigYearStr(-99999) === '-99999';
})(), J([bigDateStr('-9999-1-1'), bigDateStr('3000000-5-1')]));

// ---------- ② 不设死范围（只受安全整数护栏），非法值仍拒绝 ----------
A('B1 **年份不设业务上限**：`20000-05-06` / `-99999-05-06` / `9999999999-01-01`（千亿年前）都合法', (() => {
    return bigDateValid('20000-05-06') && bigDateValid('-99999-05-06') && bigDateValid('9999999999-01-01')
        && bigDateParse('9999999999-01-01').y === 9999999999;
})(), 'n/a');
A('B2 **溢出护栏**（不是业务范围）：`BIG_YEAR_MAX` = 1e13，±1e13 内合法、超出拒绝；位数上限 13', (() => {
    const okMax = bigYearOk(BIG_YEAR_MAX), okNeg = bigYearOk(-BIG_YEAR_MAX);
    const over = bigDateParse('10000000000001-01-01');       // 1e13 + 1
    return BIG_YEAR_MAX === 1e13 && BIG_YEAR_DIGITS === 13 && okMax && okNeg && over === null;
})(), J({ max: BIG_YEAR_MAX, okMax: bigYearOk(BIG_YEAR_MAX), over: bigDateParse('10000000000001-01-01') }));
A('B3 非法仍非法：`0 年`（公历无 0 年）· `2 月 30 日` · `13 月` · 脏文本 → `null`（不静默兜底）', (() => {
    return bigDateParse('0-01-01') === null && bigDateParse('2024-02-30') === null
        && bigDateParse('2024-13-01') === null && bigDateParse('约1890年') === null
        && bigDateParse('') === null && bigDateParse(null) === null;
})(), 'n/a');
A('B4 整数日历自洽：闰年 / 月天数（含负数年份的 proleptic Gregorian 规则）', (() => {
    return bigIsLeap(2000) && !bigIsLeap(1900) && bigIsLeap(2024) && bigIsLeap(0) === true
        && bigDaysInMonth(2024, 2) === 29 && bigDaysInMonth(1900, 2) === 28 && bigDaysInMonth(2024, 4) === 30;
})(), 'n/a');

// ---------- ③ 计算不溢出（整数日序） ----------
A('C1 日序基准与往返：`1970-01-01` = 0；大年份 / 负年份往返一致（不经 `Date`）', (() => {
    const a = bigDayNumber(1970, 1, 1);
    const b = bigDayNumber(3000000, 5, 1);
    const c = bigDayNumber(-9999, 1, 1);
    const rb = bigDateFromDayNumber(b.days);
    const rc = bigDateFromDayNumber(c.days);
    return a.ok && a.days === 0 && b.ok && c.ok
        && rb && rb.y === 3000000 && rb.m === 5 && rb.d === 1
        && rc && rc.y === -9999 && rc.m === 1 && rc.d === 1;
})(), J({ big: bigDayNumber(3000000, 5, 1), neg: bigDayNumber(-9999, 1, 1) }));
A('C2 单调与相邻：日期越大日序越大；相邻两天差 1（跨年 / 跨公元前同样成立）', (() => {
    const d1 = bigDayNumber(1919, 12, 31).days, d2 = bigDayNumber(1920, 1, 1).days;
    const n1 = bigDayNumber(-1, 12, 31).days, n2 = bigDayNumber(1, 1, 1).days;
    const m1 = bigDayNumber(3000000, 1, 1).days, m2 = bigDayNumber(3000001, 1, 1).days;
    return d2 - d1 === 1 && n2 - n1 === 1 && m2 > m1 && d1 < d2 && n1 < n2;
})(), 'n/a');
A('C3 溢出边界：日序超出安全整数（`8.64e15`）→ `ok:false`，绝不返回错数', (() => {
    const bad = bigDayNumber(BIG_YEAR_MAX, 12, 31);
    return bad.ok === false || Math.abs(bad.days) <= 8.64e15;
})(), J(bigDayNumber(BIG_YEAR_MAX, 12, 31)));

// ---------- ④ 年龄（大年份相减 + 精度规则） ----------
A('D1 跨大年份：公元前 9999 年 → 2026 年 = 12024 岁（历史纪年无 0 年）；玄幻 3000000 → 3000102 = 102 岁', (() => {
    // 历史纪年（无 0 年）：公元前 9999 年 → 2026 年 = 9999 + 2026 - 1 = 12024 岁
    const a = bigAgeYears('-9999-01-01', '2026-10-19');
    const b = bigAgeYears('3000000-05-01', '3000102-06-01');
    return a === 12024 && b === 102;
})(), J([bigAgeYears('-9999-01-01', '2026-10-19'), bigAgeYears('3000000-05-01', '3000102-06-01')]));
A('D2 精度规则：day 生日未到 -1；month 月份未到 -1；year 只做年份相减（估算）', (() => {
    return bigAgeYears('1900-12-31', '1919-11-29') === 18           // 生日未到 → 18
        && bigAgeYears('1900-11-29', '1919-11-29') === 19            // 生日当天 → 19
        && bigAgeYears('1900-12', '1919-11-29') === 18               // 月精度：12 月未到
        && bigAgeYears('1900', '1919-11-29') === 19;                // 年精度：直接相减
})(), 'n/a');
A('D3 未来出生（age 为负）如实返回负数，由调用方决定呈现；不可解析 → `NaN`', (() => {
    const neg = bigAgeYears('1930-01-01', '1919-11-29');
    return neg === -11 && Number.isNaN(bigAgeYears('坏值', '1919-11-29')) && Number.isNaN(bigAgeYears('1900-01-01', '坏值'));
})(), 'n/a');

// ---------- ⑤ 单位简化（用户点名：102万岁 / 300亿岁） ----------
A('E1 阈值：`<1万` 岁 · `≥1万` 万岁 · `≥1亿` 亿岁 · `≥1万亿` 万亿岁（阶梯常量可查）', (() => {
    const units = BIG_AGE_UNITS.map((u) => u.unit).join(',');
    return units === '万亿岁,亿岁,万岁,岁' && bigAgeParts(9999).unit === '岁' && bigAgeParts(10000).unit === '万岁'
        && bigAgeParts(99999999).unit === '万岁' && bigAgeParts(1e8).unit === '亿岁' && bigAgeParts(1e12).unit === '万亿岁';
})(), J(BIG_AGE_UNITS.map((u) => [u.unit, u.div])));
A('E2 用户示例逐字：42 → `42岁` · 1020000 → `102万岁` · 300000000 → `3亿岁` · 1500000000000 → `1.5万亿岁`', (() => {
    return bigAgeText(42) === '42岁' && bigAgeText(1020000) === '102万岁'
        && bigAgeText(300000000) === '3亿岁' && bigAgeText(1500000000000) === '1.5万亿岁';
})(), J([42, 1020000, 300000000, 1500000000000].map((x) => bigAgeText(x))));
A('E3 边界与小数：10000 → `1万岁`（不显示 1.0）· 12345 → `1.2万岁` · 负数保留符号 · 非数字 → 空串', (() => {
    return bigAgeText(10000) === '1万岁' && bigAgeText(12345) === '1.2万岁'
        && bigAgeText(-50000) === '-5万岁' && bigAgeText(NaN) === '' && bigAgeText('') === '';
})(), J([10000, 12345, -50000, NaN].map((x) => bigAgeText(x))));

// ---------- ⑥ 链路端到端（内核 + 时钟 + 列表行） ----------
const host = makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在仓库清点货物。' }] });
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(host, doc);
function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:bigdate');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), st || {}));
    setLoadPhase('ready');                       // 首屏闸门：未 ready 时面板只显示「正在读取数据…」
    return state;
}
A('F1 内核链路：`calcAge` 对 `-9999-01-01` / `3000000-05-01` 给出正确的年龄字符串（契约不变：数字串）', (() => {
    return calcAge('-9999-01-01', '2026-10-19') === '12024'
        && calcAge('3000000-05-01', '3000102-06-01') === '102'
        && calcAge('2024-02-30', '2026-10-19') === '';               // 非法日期 → 空串（不臆造）
})(), J([calcAge('-9999-01-01', '2026-10-19'), calcAge('3000000-05-01', '3000102-06-01')]));
A('F2 `parseBirthDateParts` 与时钟族同口径：大年份出生 / 剧情日期都能解析，且 **不因超 4 位被判非法**', (() => {
    const b = parseBirthDateParts('-9999-01-01');
    const c = clockDateParts('3000000-05-01');
    const d = clockDateTrim('-9999-1-1');
    return b && b.y === -9999 && c && c.y === 3000000 && d === '-9999-01-01'
        && clockDateValid('20000-05-06') === true
        && clockYearStr(-9999) === '-9999' && clockReplaceYear('2011-05-06', 3000000) === '3000000-05-06';
})(), J({ trim: clockDateTrim('-9999-1-1'), valid: clockDateValid('20000-05-06'), parts: clockDateParts('3000000-05-01') }));
A('F3 毫秒域（按天衰减）在超 Date 范围时**明确降级**：返回 `NaN`（调用方按「无日期」处理，不崩不误判）', (() => {
    const normal = storyDateMsFromStr('1919-11-29');
    const big = storyDateMsFromStr('3000000-05-01');
    return Number.isFinite(normal) && Number.isNaN(big);
})(), J({ normal: storyDateMsFromStr('1919-11-29'), big: storyDateMsFromStr('3000000-05-01') }));
A('F4 「神话尺度」不再误报「超长年龄（疑长期未出场）」：≥1 万岁不报 `age-extreme`，1 万以内仍按原口径', (() => {
    const mk = (birth) => ({ id: 's1', name: '甲', identity: { birthDate: birth }, relations: [], resume: [] });
    const big = snapshotBirthAnomaly(mk('-9999-01-01'), '2026-10-19');            // 12024 岁（神话尺度）
    const sameYear = snapshotBirthAnomaly(mk('2026-01-01'), '2026-10-19');         // 0 岁
    // 628 岁：仍属「待研判」信号（`overage` 先命中 —— 保持既有口径，不被本轮放宽吃掉）
    const medieval = snapshotBirthAnomaly(mk('1391-01-01'), '2019-01-01');
    return big === '' && sameYear === '' && medieval !== '';
})(), J(['神话', '常规', '628岁']));
A('F5 列表行显示（端到端）：角色页把大年龄显示为**单位简化**文本（`万岁` / `亿岁`），而不是长数字串', (() => {
    boot({
        state: Object.assign({}, emptyState().state, { date: '3000102-06-01' }),
        snapshots: [
            { id: 's1', name: '寿星甲', identity: { birthDate: '3000000-05-01' }, relations: [], resume: [], uses: 1 },
            { id: 's2', name: '古神乙', identity: { birthDate: '-900000000-01-01' }, relations: [], resume: [], uses: 1 },
        ],
    });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    openPanel('snapshots');
    const html = String(panelBodyHtml('snapshots'));
    // s1：102 岁（不加单位）；s2：≈9.03 亿岁 → 单位简化成「亿岁」
    return html.indexOf('年龄：102岁') >= 0 && html.indexOf('亿岁') >= 0 && html.indexOf('岁（按剧情日期') >= 0;
})(), 'n/a');
A('F6 `snapshotAge` 与 `calcAge` 同源（同一出生日期 / 锚点给出同一岁数）——「只算一次、两处一致」', (() => {
    boot({ state: Object.assign({}, emptyState().state, { date: '2026-10-19' }), snapshots: [{ id: 's1', name: '甲', identity: { birthDate: '-9999-01-01' }, relations: [], resume: [] }] });
    const s = state.snapshots[0];
    return String(snapshotAge(s, '2026-10-19')) === calcAge('-9999-01-01', '2026-10-19');
})(), 'n/a');

un();
R.done();
