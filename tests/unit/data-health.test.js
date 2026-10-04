// ============================================================
// 单元测试 · v3.13.0「数据体检 + 载入期数据异常自愈」（v3.13.1 修四处口径缺陷）
// 用户要求（原话）：「基于本地调试端口，核对存在的BUG和数据异常，进行修复。」
//
// 口径：
//   · **体检**（`core/data-health.js#dataHealthReport`）只读、零副作用，逐条列出异常（code / dim / id / field / detail）；
//   · **自愈**（`core/migrate.js#healthSelfHeal`，随 `migrateState` 在载入期执行）只修「能从数据本身确定地修好」的部分：
//     脏台账标记 · 非规范 NSFW 等级 · 负数 uses · 越界 importance · 倒置/非法的楼层区间；
//   · 语义无法确定的（缺 id / 重复 id / 超长字段 / 非法墓碑时间戳）**只报告不擅改**；
//   · 本批（v3.13.0）修掉的两个真实缺陷：
//     ① 旧版台账迁移把混入的 `null` 经 `Number(null) = 0` **伪造成「第 0 楼已处理」**，`{f:'x'}` 一类垃圾被静默丢一半；
//     ② 调试试探自身用 `Number()` 宽松读取台账 → 也会把 `null` 读成第 0 楼，**异常被掩盖**（体检与桥同时修）。
//   · v3.13.1（用户要求「检查最新版 BUG」后修，D 组锁死）：
//     ③ `HEALTH_DIMS` 里 `plotSegments` 重复 → 该维被扫两遍（明细 / 计数翻倍、`scanned.dims` 虚高）；
//     ④ `level` 原先由被 `cap` 截断的 `findings` 推导 → 大量 info 会把 warn 挤出明细，摘要**低估严重度**；
//     ⑤ 丢弃留痕台账 `processedDropped` 与 `lastChatFloor` / `processedVer` 原先体检与自愈**都没覆盖**；
//     ⑥ 自愈的 `changed` 原先被丢弃（无留痕）→ 现经 `lastHealInfo()` 回传，`index.js` 记日志并按需落盘。
// 运行：node tests/unit/data-health.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { dataHealthReport, dataHealthText, HEALTH_FINDINGS_CAP } from '../../core/data-health.js';
import { migrateState, healthSelfHeal, lastHealInfo } from '../../core/migrate.js';
import { buildBridgeMethods } from '../../ui/debug.js';
import { bridgeDispatch, setBridgeMethods } from '../../adapters/debug-bridge.js';

const R = makeReporter('data-health v3.13.0–v3.13.1 数据体检 + 载入期数据异常自愈');
const A = (n, c, e) => { const det = () => (typeof e === "function" ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e); if (c && typeof c.then === "function") return c.then((v) => R.assert(n, v === true, det())); return R.assert(n, c === true, det()); };
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:health');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文：角色甲在仓库清点货物。' }] }), doc);
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), st || {}));
    return state;
}

/** 异常大礼包（每条都对应一个 `code`） */
const DIRTY = () => ({
    atoms: [
        { id: 'a1', text: '正常情节正文足够长用于测试。', title: 't1', floorStart: 5, floorEnd: 2, nsfw: 'Strong', uses: -3 },
        { text: '没有 id 的情节正文足够长。', title: 't2' },
        { id: '', text: '空 id 情节正文足够长。', title: 't3', floorNowStart: 9, floorNowEnd: 2, originGone: true },
        { id: 'a1', text: '重复 id 的情节正文足够长。', title: 't4', nsfw: true, importance: 3 },
        { id: 'a2', text: '短', title: 't5', floorNowStart: 3 },
    ],
    memories: [{ id: 'm1', title: 'm', content: 'y'.repeat(4000) }],
    items: 'not-an-array',
    currentStates: [{ id: 's1', subject: '甲', field: '状态', value: 'x'.repeat(300), nsfw: 4 }],
    links: [{ dim: 'memories', refId: 'm1', who: '甲' }, null, { dim: 'nope', refId: 'zz' }, { dim: 'atoms' }],
    processedFloors: [3, { f: 'x', h: null }, { f: 99, h: 'abc' }, null, true, '', { f: 3, h: '' }],
    lastKnownFloor: 'x',
    deleted: { atoms: { a2: 'ts' } },
    deletedH: { atoms: { h1: 0 } },
});

// ---------- A 组：体检逐类检出 ----------
boot(DIRTY());
const REPORT = dataHealthReport();
const hasCode = (c) => (REPORT.counts[c] || 0) >= 1;

A('A1 结构类（error）：维度容器类型错误 / 条目不是对象 → `ok=false` 且逐条给出 dim 与位置', (() => {
    const c = REPORT.findings.filter((f) => f.code === 'container-type')[0] || {};
    const e = REPORT.findings.filter((f) => f.code === 'entry-not-object')[0] || {};
    return REPORT.ok === false && REPORT.level === 'error' && c.dim === 'items' && c.level === 'error'
        && e.dim === 'links' && e.at === 1 && REPORT.scanned.dims >= 15 && REPORT.scanned.items >= 8;
})(), () => REPORT.counts);

A('A2 标识类：缺 id / 空 id / 重复 id 都被列出（后者带 id 与位置）', (() => {
    const dup = REPORT.findings.filter((f) => f.code === 'entry-dup-id');
    return hasCode('entry-no-id') && REPORT.counts['entry-no-id'] === 2      // atoms[1] 缺 id / atoms[2] 空 id
        && dup.length === 1 && dup[0].id === 'a1' && dup[0].at === 3
        && REPORT.findings.every((f) => !(f.code === 'entry-no-id' && f.dim === 'links'));   // 关联层行本就没有 id，不得误报
})(), () => REPORT.findings.filter((f) => String(f.code).indexOf('id') >= 0));

A('A3 楼层类：来源区间倒置 / 当前位置倒置 / 非法半对 / 「原文已移除」却带当前位置 —— 全部列出', (() => {
    const inv = REPORT.findings.filter((f) => f.code === 'floor-inverted')[0] || {};
    const now = REPORT.findings.filter((f) => f.code === 'floornow-inverted')[0] || {};
    const gone = REPORT.findings.filter((f) => f.code === 'origin-gone-with-floornow')[0] || {};
    return hasCode('floor-inverted') && hasCode('floornow-inverted') && hasCode('origin-gone-with-floornow')
        && J(inv.value) === J([5, 2]) && J(now.value) === J([9, 2]) && gone.id === '';
})(), () => REPORT.counts);

A('A4 NSFW 类：等级不是规范值（大小写 / 布尔 / 数字）→ `nsfw-invalid` 逐条列出', (() => {
    const rows = REPORT.findings.filter((f) => f.code === 'nsfw-invalid');
    return rows.length === 3 && rows.every((f) => f.field === 'nsfw') && hasCode('nsfw-invalid')
        && rows.some((f) => f.value === 'Strong') && rows.some((f) => f.value === true) && rows.some((f) => f.value === 4);
})(), () => REPORT.findings.filter((f) => f.code === 'nsfw-invalid'));

A('A5 数值类：负数 uses / 越界 importance 被列出（字段与值都可核对）', (() => {
    const u = REPORT.findings.filter((f) => f.code === 'uses-invalid')[0] || {};
    const im = REPORT.findings.filter((f) => f.code === 'importance-out-of-range')[0] || {};
    return u.field === 'uses' && u.value === -3 && im.field === 'importance' && im.value === 3;
})(), () => REPORT.counts);

A('A6 体积类：单字段超上限 → `field-too-long`（info 级，不阻断）', (() => {
    const rows = REPORT.findings.filter((f) => f.code === 'field-too-long');
    const m = rows.filter((f) => f.dim === 'memories' && f.field === 'content')[0] || {};
    // 状态记录的超长检查要能生效（`currentStates` → 上限表键 `states` 的别名映射）
    return rows.length >= 2 && m.value === 4000 && m.level === 'info'
        && REPORT.findings.filter((f) => f.code === 'field-too-long' && f.dim === 'currentStates').length === 1;
})(), () => REPORT.findings.filter((f) => f.code === 'field-too-long'));

A('A7 关联类：关联行非对象 / 缺键 / 引用不存在的条目（孤儿行）全部列出', (() => {
    // 非对象行 + 缺 refId 行 = 2 条行结构异常；引用不存在条目 = 1 条孤儿行
    return hasCode('link-bad-row') && REPORT.counts['link-bad-row'] === 2 && hasCode('link-orphan')
        && REPORT.findings.filter((f) => f.code === 'link-orphan')[0].refId === 'nope:zz';
})(), () => REPORT.counts);

A('A8 台账类（**本批核心缺陷**）：`null` / `true` / 空串 / 非数字串 都必须报 `ledger-bad-mark`，绝不能被当成「第 0 楼」', (() => {
    const bad = REPORT.findings.filter((f) => f.code === 'ledger-bad-mark');
    const vals = bad.map((f) => f.value);
    return REPORT.counts['ledger-bad-mark'] === 4                      // {f:'x'} · null · true · 空串
        && vals.some((v) => v === null) && vals.some((v) => v === true) && vals.some((v) => v === '')
        && hasCode('ledger-dup-mark') && hasCode('lastknown-invalid');
})(), () => ({ counts: REPORT.counts, bad: REPORT.findings.filter((f) => f.code === 'ledger-bad-mark').map((f) => f.value) }));

A('A9 墓碑类：非正数（`\'ts\'` / `0`）时间戳 → `tombstone-bad-ts`（该墓碑实际不生效，跨端可能被复活）', (() => {
    const rows = REPORT.findings.filter((f) => f.code === 'tombstone-bad-ts');
    return rows.length === 2 && rows.some((f) => f.dim === 'deleted.atoms' && f.id === 'a2')
        && rows.some((f) => f.dim === 'deletedH.atoms' && f.id === 'h1');
})(), () => REPORT.findings.filter((f) => f.code === 'tombstone-bad-ts'));

A('A10 摘要文本：一行讲清「几类异常 / 扫描了多少条」，路径与字段不含正文', (() => {
    const t = dataHealthText(REPORT);
    return t.indexOf('数据体检：') === 0 && t.indexOf('ledger-bad-mark') > 0
        && t.indexOf('扫描 ' + REPORT.scanned.items + ' 条') > 0 && t.indexOf('x'.repeat(50)) < 0
        && HEALTH_FINDINGS_CAP >= 200;
})(), () => dataHealthText(REPORT));

A('A11 干净状态：无异常 → `ok=true` / `level=ok` / 明细为空（不误报）', (() => {
    const clean = { atoms: [{ id: 'a1', text: '甲在码头搬运木箱，登记入册。', title: 't', floorStart: 1, floorEnd: 2, nsfw: 'strong', uses: 2, importance: 0.5 }], processedFloors: [{ f: 1, h: 'h1' }], lastKnownFloor: 1, deleted: {} };
    const r = dataHealthReport(clean);
    return r.ok === true && r.level === 'ok' && r.findings.length === 0 && J(r.counts) === J({})
        && dataHealthText(r) === '数据体检：未发现异常（扫描 1 条 / 15 维）';   // v3.13.1：维度去重后唯一 15 维
})(), '见断言');

// ---------- B 组：载入期自愈 ----------
const FIXED = migrateState(JSON.parse(JSON.stringify(DIRTY())));
const FIXED_HEALTH = dataHealthReport(FIXED);
const FIXED_ONCE = JSON.parse(JSON.stringify(FIXED));
const FIXED_AGAIN = migrateState(FIXED_ONCE);

A('B1 自愈后异常大幅收敛：结构类与「可确定修好」的类别全部消失，只剩「只报告不擅改」的三类', (() => {
    const codes = Object.keys(FIXED_HEALTH.counts).sort();
    return FIXED_HEALTH.ok === true                                  // 结构类已清
        && codes.every((c) => ['entry-no-id', 'entry-dup-id', 'field-too-long', 'tombstone-bad-ts'].indexOf(c) >= 0)
        && FIXED_HEALTH.counts['entry-no-id'] === 2 && FIXED_HEALTH.counts['tombstone-bad-ts'] === 2
        && !FIXED_HEALTH.counts['ledger-bad-mark'] && !FIXED_HEALTH.counts['nsfw-invalid']
        && !FIXED_HEALTH.counts['uses-invalid'] && !FIXED_HEALTH.counts['floor-inverted']
        && !FIXED_HEALTH.counts['floornow-inverted'] && !FIXED_HEALTH.counts['importance-out-of-range'];
})(), () => FIXED_HEALTH.counts);

A('B2 台账自愈：非法标记**丢弃**（不再伪造第 0 楼）、重复标记去重、裸数字保留为无哈希在册标记', (() => {
    return J(FIXED.processedFloors) === J([{ f: 3, h: '' }, { f: 99, h: 'abc' }])
        && FIXED.processedFloors.every((m) => Number.isInteger(m.f) && m.f >= 0 && typeof m.h === 'string');
})(), () => FIXED.processedFloors);

A('B3 基线自愈：`lastKnownFloor` 非整数 → `-1`（未知；下游一律按有限数判据处理）', (() => {
    return FIXED.lastKnownFloor === -1;
})(), () => ({ lastKnownFloor: FIXED.lastKnownFloor }));

A('B4 NSFW 等级自愈：`Strong` → `strong`、`true` → `strong`；无法识别 → **删除字段**（缺省即「无」）', (() => {
    const a = FIXED.atoms;
    return a[0].nsfw === 'strong' && a[3].nsfw === 'strong';
})(), () => FIXED.atoms.map((x) => x.nsfw));

A('B5 数值自愈：负数 uses → 0；越界 importance 夹到 0..1（其它字段不动）', (() => {
    return FIXED.atoms[0].uses === 0 && FIXED.atoms[3].importance === 1
        && FIXED.atoms[0].text === '正常情节正文足够长用于测试。';
})(), () => FIXED.atoms.map((x) => ({ uses: x.uses, importance: x.importance })));

A('B6 楼层自愈：来源区间倒置 → **互换修好**；当前位置非法/倒置/半对/与「原文已移除」矛盾 → **整对删除**', (() => {
    const a0 = FIXED.atoms[0], a2 = FIXED.atoms[2], a4 = FIXED.atoms[4];
    return a0.floorStart === 2 && a0.floorEnd === 5                    // 倒置 → 互换
        && a2.originGone === true && a2.floorNowStart === undefined && a2.floorNowEnd === undefined
        && a4.floorNowStart === undefined;                             // 半对 → 删除
})(), () => FIXED.atoms.map((x) => ({ fs: x.floorStart, fe: x.floorEnd, ns: x.floorNowStart, ne: x.floorNowEnd, gone: x.originGone })));

A('B7 幂等：再次迁移**零改动**（逐字符相等），自愈不会反复改写存档', (() => {
    return J(FIXED_AGAIN) === J(FIXED) && healthSelfHeal(JSON.parse(JSON.stringify(FIXED))) === false;
})(), '见断言');

A('B8 绝不删条目：自愈前后原子层条数与 id 集合一致（缺 id / 空 id 都保留）；关联层由既有 `migrateRelLinks` 负责清理', (() => {
    const before = DIRTY();
    return FIXED.atoms.length === before.atoms.length && FIXED.currentStates.length === 1
        && FIXED.links.length === 1                                  // 合法那一行保留；非对象 / 缺键 / 孤儿行由 links 迁移清理
        && FIXED.links[0].refId === 'm1'
        && FIXED.deleted.atoms.a2 === 'ts' && FIXED.deletedH.atoms.h1 === 0
        // id 集合逐字符一致：缺 id 保留为「缺」、空 id 保留为空串、重复 id 原样留着（只报告不擅改）
        && FIXED.atoms.map((x) => (x.id === undefined ? '(缺)' : String(x.id))).join(',') === 'a1,(缺),,a1,a2';
})(), () => ({ atoms: FIXED.atoms.length, ids: FIXED.atoms.map((x) => (x.id === undefined ? '(缺)' : String(x.id))), links: JSON.parse(JSON.stringify(FIXED.links)) }));

A('B9 只报告不擅改：缺 id / 重复 id / 超长字段 / 非法墓碑时间戳在自愈后**原样保留**（不猜、不删）', (() => {
    return FIXED.atoms[1].id === undefined && FIXED.atoms[3].id === 'a1'
        && String(FIXED.memories[0].content).length === 4000
        && FIXED.deleted.atoms.a2 === 'ts' && FIXED.deletedH.atoms.h1 === 0;
})(), '见断言');

// ---------- C 组：本地调试端口（调试桥）接线 ----------
await (async () => {
    boot(DIRTY());
    setBridgeMethods(buildBridgeMethods());
    const call = async (m, p) => (await bridgeDispatch({ id: m, method: m, params: p || {} })).result;

    const health = await call('ftt.dataHealth');
    const text = await call('ftt.dataHealthText');
    await A('C1 调试桥只读方法：`ftt.dataHealth`（结构化）与 `ftt.dataHealthText`（一行摘要）可用，且与内核报告同源', (() => {
        return health && health.ok === false && health.counts['ledger-bad-mark'] === 4
            && typeof text === 'string' && text.indexOf('数据体检：') === 0
            && J(Object.keys(health.counts).sort()) === J(Object.keys(dataHealthReport().counts).sort());
    })(), () => ({ text: text, counts: health && health.counts }));

    const shape = await call('ftt.memoryShape');
    await A('C2 `ftt.memoryShape` 只回**数字**：非数组容器 → `null` 并单列 `bad`（此前会把 `"string"` 直接填进计数表，消费方拿到的不是条数）', (() => {
        return shape.items === null && shape.bad && shape.bad.items === 'string'
            && shape.atoms === 5 && shape.currentStates === 1 && shape.memories === 1;
    })(), () => shape);

    const ledger = await call('ftt.ledger');
    await A('C3 `ftt.ledger` 严格解析标记：非法项 `f:null` + `bad:true` 并给出 `badMarks` 计数（不再把 `null` 读成第 0 楼）', (() => {
        return ledger.badMarks === 4 && ledger.marks.length === 7
            && ledger.marks.every((m) => m.f === null ? m.bad === true : (Number.isInteger(m.f) && m.bad === false));
    })(), () => ({ badMarks: ledger.badMarks, marks: ledger.marks }));

    const limited = await call('ftt.dataHealth', { cap: 3 });
    await A('C4 `ftt.dataHealth` 支持 `cap` 限流（默认 200 条上限；超出只累计计数并回 `truncated`）', (() => {
        return limited.findings.length === 3 && limited.truncated >= 1
            && limited.counts['ledger-bad-mark'] === 4;
    })(), () => ({ findings: limited.findings.length, truncated: limited.truncated }));
})();

// ---------- D 组：v3.13.1 口径修复回归 ----------
A('D1 维度**不重复扫描**：`plotSegments` 只算一维（`scanned.dims` = 唯一维度数），同一异常不会报两遍', (() => {
    const one = { id: 'seg-1', header: 'H', uses: -5, floorStart: 9, floorEnd: 3, nsfw: 'STRONG' };
    const r = dataHealthReport({ plotSegments: [one] });
    const segRows = r.findings.filter((f) => f.dim === 'plotSegments');
    const codes = segRows.map((f) => f.code).sort();
    const uniq = [...new Set(codes)];
    return r.scanned.dims === 15                                  // 13(ATOM_DIM_KEYS) + currencies + npcs（plotSegments 已含）
        && dataHealthReport({}).scanned.dims === 15
        && segRows.length === 3                                   // 3 处异常各一条（修复前是 6 条）
        && J(codes) === J(uniq)
        && r.counts['uses-invalid'] === 1 && r.counts['floor-inverted'] === 1 && r.counts['nsfw-invalid'] === 1;
})(), () => { const r = dataHealthReport({ plotSegments: [{ id: 's', uses: -5, floorStart: 9, floorEnd: 3, nsfw: 'STRONG' }] }); return { dims: r.scanned.dims, counts: r.counts, rows: r.findings.filter((f) => f.dim === 'plotSegments').map((f) => f.code) }; });

A('D2 `level` 由**发现到的异常**决定（不受 `cap` 截断影响）：大量 info 也不能把 warn 读没', (() => {
    const big = { atoms: [], processedFloors: [{ f: null, h: '' }] };                    // 台账脏标记（warn）
    for (let i = 0; i < 205; i++) big.atoms.push({ id: 'a' + i, title: 't', text: 'x'.repeat(20000) });   // 超长字段（info）
    const r = dataHealthReport(big, { cap: 200 });
    return r.truncated >= 1 && r.findings.some((f) => f.level === 'info') === true
        && r.counts['ledger-bad-mark'] === 1 && r.level === 'warn'                       // 修复前是 'info'
        && dataHealthText(r).indexOf('数据体检：warn') === 0;
})(), () => { const big = { atoms: [], processedFloors: [{ f: null, h: '' }] }; for (let i = 0; i < 205; i++) big.atoms.push({ id: 'a' + i, text: 'x'.repeat(20000) }); const r = dataHealthReport(big, { cap: 200 }); return { level: r.level, counts: r.counts, truncated: r.truncated, text: dataHealthText(r) }; });

A('D3 体检补齐三个**未覆盖字段**：丢弃留痕台账同口径校验 + `lastChatFloor` / `processedVer` 非法即报', (() => {
    const r = dataHealthReport({
        processedDropped: [{ f: null, h: '' }, { f: 3, h: 'x' }, { f: 3, h: 'x' }, { f: -7, h: '' }],
        lastChatFloor: 'NaN-ish', processedVer: 12345,
    }, { dims: [] });
    const bad = r.findings.filter((f) => f.code === 'ledger-bad-mark');
    const dup = r.findings.filter((f) => f.code === 'ledger-dup-mark');
    return r.counts['ledger-bad-mark'] === 2 && r.counts['ledger-dup-mark'] === 1
        && bad.every((f) => f.dim === 'processedDropped')
        && dup[0].dim === 'processedDropped'
        && r.counts['lastchatfloor-invalid'] === 1 && r.counts['processedver-invalid'] === 1
        && r.level === 'warn';
})(), () => dataHealthReport({ processedDropped: [{ f: null }], lastChatFloor: 'x', processedVer: 1 }, { dims: [] }).counts);

A('D4 自愈补齐：丢弃留痕去非法去重、`lastChatFloor` 非法 → -1、`processedVer` 非字符串 → 删除；且幂等', (() => {
    const dirty = {
        processedFloors: [{ f: null, h: '' }, { f: 2, h: 'a' }, { f: 2, h: 'a' }],
        processedDropped: [{ f: null, h: '' }, { f: -7, h: '' }, { f: 3, h: 'x' }, { f: 3, h: 'x' }],
        lastKnownFloor: 'NaN', lastChatFloor: 'NaN', processedVer: 12345,
    };
    const once = JSON.parse(JSON.stringify(dirty));
    const changed = healthSelfHeal(once);
    const info = lastHealInfo();
    const again = JSON.parse(JSON.stringify(once));
    return changed === true && lastHealInfo().changed === true
        && J(once.processedFloors) === J([{ f: 2, h: 'a' }])
        && J(once.processedDropped) === J([{ f: 3, h: 'x' }])          // 修复前：原样 4 条不动
        && once.lastKnownFloor === -1 && once.lastChatFloor === -1     // 修复前：lastChatFloor 仍是 'NaN'
        && once.processedVer === undefined                              // 修复前：仍是 12345
        && info && info.ledger === 2 && info.dropped === 3 && info.entries === 0
        && healthSelfHeal(again) === false && lastHealInfo().changed === false;   // 幂等
})(), () => { const d = { processedFloors: [], processedDropped: [{ f: null }, { f: 3, h: 'x' }, { f: 3, h: 'x' }], lastChatFloor: 'x', processedVer: 1 }; healthSelfHeal(d); return { after: d, info: lastHealInfo() }; });

A('D5 自愈留痕回传：`lastHealInfo()` 在干净数据上给出 `changed:false`（不误报「修过」）', (() => {
    const clean = { atoms: [{ id: 'a1', title: 't', text: '甲在码头搬箱子。', nsfw: 'strong', uses: 1, importance: 0.5 }], processedFloors: [{ f: 1, h: 'h' }], lastKnownFloor: 1, lastChatFloor: 1, processedVer: 'v1' };
    const changed = healthSelfHeal(JSON.parse(JSON.stringify(clean)));
    const info = lastHealInfo();
    return changed === false && info && info.changed === false && info.ledger === 0 && info.dropped === 0 && info.entries === 0;
})(), () => ({ info: lastHealInfo() }));

R.done();
