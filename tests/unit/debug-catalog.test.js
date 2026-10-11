// ============================================================
// 单元测试 · v3.45.4 `docs/D22` W10 **`技-41`** —— 调试面口径统一（单一事实源 `core/debug-catalog.js`）
//   设计：`docs/D31-调试工具统一设计稿.md` §3.2（kind 枚举化）/ §3.4（唯一 CAP 汇总表）/ §3.5（统一脱敏）/
//         §3.6 + §8 Q4（只读清单；清空型永不进桥）/ §3.7（追溯六字段）/ §5（12 类必要内容）
//
// 本文件锁八件事：
//   ① **枚举完备**：源码里出现的每一个 `dbgLog` / `debugLogPush` kind 都必须在 `DEBUG_KINDS` 里
//      （扫描范围 = `core/` `host/` `adapters/` `ui/` + `index.js` + `devtools.js`；
//       `tests/` 与 `scripts/` **有意排除**：测试用例故意用「类别A」这类合成 kind 去逐字锁 V1 黄金口径，
//       它们是**故意的未登记**，扫进来只会天天报噪声 —— 报噪声的检查等于没有检查）；
//   ② **CAP 以代码为准**：`DEBUG_CAPS` 的每个数值都与**模块导入的真实常量**比对（不是抄文档）；
//   ③ **脱敏**：键名黑名单 / 密钥形态 / 正文只回长度 / 深度与项数上限 / 环安全 / **入参不被修改**；
//   ④ **追溯六字段**：缺省补空、多余键丢弃、超长截断；
//   ⑤ **只读清单**：`kind:'clear'` 的动作**没有**任何一个出现在桥方法名集合里（Q4 的**反向判据**）；
//      桥方法名与 `ui/debug.js#buildBridgeMethods` 的实测集合**双向差异 0**（`技-41` 验收 ②）；
//   ⑥ **12 类必要内容**恰为 12 且每类都有 `outlets`；
//   ⑦ 汇总读数 / 人读摘要的形状与「同一读数一处计算」；
//   ⑧ `debug-log.js` 的**未登记 kind** 三步（照记 / 计数 / 一次性提示）与既有口径**一个字段都没动**。
//
// 运行：node tests/unit/debug-catalog.test.js
// ============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import {
    DEBUG_KINDS, DEBUG_CAPS, TRACE_FIELDS, REQUIRED_CONTENT, READONLY_OUTLETS,
    debugKindRegistered, debugKindList, debugCapList, traceStamp, redactForOutlet,
    requiredContentList, readonlyOutletList, debugCatalogReport, debugCatalogText,
} from '../../core/debug-catalog.js';
import { collectLogKinds, stripComments } from '../../scripts/debug-coverage-lib.js';
import { DEBUG_CAP, DEBUG_DATA_MAX, debugLogPush, debugLogList, debugLogClear, debugLogStats, debugUnregisteredKinds, setDebugLogHooks } from '../../core/debug-log.js';
import { TRACE_TOTAL_CAP, TRACE_ITEM_MAX, TRACE_DEDUPE_MS, TRACE_CONTEXT_SPAN, TRACE_CAT_CAP } from '../../core/trace.js';
import { TRACE_STORE_CAP } from '../../adapters/trace-store.js';
import { READ_LEDGER_CAP } from '../../core/read-ledger.js';
import { CONFLICT_CAP, CONFLICT_LOG_CAP } from '../../core/conflicts.js';
import { SYNC_LOG_MAX } from '../../core/sync-log.js';
import { AI_USAGE_KEEP, AI_USAGE_MAX_KEYS } from '../../core/token-cost.js';
import { FLOOR_BACKUP_SLOTS } from '../../adapters/floor-backup.js';
import { ETA_SAMPLES } from '../../core/pipeline.js';
import { REPAIR_LOG_MAX } from '../../core/repair.js';
import { WARN_BACKLOG_MAX, setChatHooks } from '../../core/model/runtime.js';
import { PERF_WINDOW, PERF_DEDUPE_MS, PERF_THRESHOLDS } from '../../core/perf-probe.js';
import { VERSION } from '../../core/constants.js';

const R = makeReporter('debug-catalog v3.45.4 技-41 调试面口径统一（D31 §3/§5/§8 Q4）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ============================================================
// K 组：kind 枚举（§3.2 / §3.8「枚举化」）
// ============================================================
const SRC_DIRS = ['core', 'host', 'adapters', 'ui'];
const SRC_FILES = ['index.js', 'devtools.js'];
function walk(dir, acc) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (p.endsWith('.js')) acc.push(p);
    }
    return acc;
}
const srcPaths = SRC_DIRS.map((d) => join(ROOT, d)).flatMap((d) => walk(d, [])).concat(SRC_FILES.map((f) => join(ROOT, f)));
const srcTexts = srcPaths.map((p) => ({ file: relative(ROOT, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));
const collected = collectLogKinds(srcTexts);

A('K1 **枚举完备（机械核对）**：源码（core/ host/ adapters/ ui/ + index.js + devtools.js）里出现的每一个 `dbgLog`/`debugLogPush` kind 都已在 `DEBUG_KINDS` 登记 —— 漏一个即红（这就是「新增一条 kind 未登记会被发现」的静态侧）', (() => {
    const missing = collected.list.filter((k) => !debugKindRegistered(k));
    return missing.length === 0 && collected.list.length >= 15;   // 顺带锁住「收集器没把整仓吃掉」
})(), J({ scanned: srcTexts.length, kinds: collected.list, missing: collected.list.filter((k) => !debugKindRegistered(k)) }));

A('K2 `debugKindRegistered` 正/反向：已登记 true、空串/false/null/未登记 false（逐字比对，不做大小写或前后缀容忍）', (() => {
    return debugKindRegistered('摘要') === true && debugKindRegistered('调试') === true
        && debugKindRegistered('不存在的类别') === false && debugKindRegistered('') === false
        && debugKindRegistered(null) === false && debugKindRegistered(undefined) === false
        && debugKindRegistered('摘 要') === false;
})(), J({ yes: debugKindRegistered('摘要'), no: debugKindRegistered('不存在的类别') }));

A('K3 枚举表**冻结**且 `debugKindList()` 返回**副本**：改动副本不影响事实源（否则三处出口会互相污染）', (() => {
    const before = J(debugKindList());
    const l1 = debugKindList();
    l1.push({ kind: '注入的假类别', note: '' });
    l1[0].note = '被改坏了';
    const after = J(debugKindList());
    return Object.isFrozen(DEBUG_KINDS) && Object.isFrozen(DEBUG_KINDS[0])
        && Object.isFrozen(READONLY_OUTLETS) && Object.isFrozen(DEBUG_CAPS) && Object.isFrozen(REQUIRED_CONTENT)
        && before === after && before !== J(l1);
})(), J({ n: debugKindList().length }));

A('K4 每条 kind 都有**中文 note**（说明「这个类别记什么」），且 `kind` 非空不重复', (() => {
    const ks = DEBUG_KINDS.map((x) => x.kind);
    const bad = DEBUG_KINDS.filter((x) => !x.kind || !String(x.note || '').trim());
    return bad.length === 0 && new Set(ks).size === ks.length;
})(), J(DEBUG_KINDS.map((x) => x.kind)));

// ============================================================
// C 组：CAP 汇总表（§3.4）—— 每行的数值必须与**代码常量**一致
// ============================================================
/** `source` 片段 → 该行必须包含的真实常量值 */
const CAP_EXPECT = [
    ['core/debug-log.js#DEBUG_CAP', DEBUG_CAP],
    ['core/debug-log.js#DEBUG_DATA_MAX', DEBUG_DATA_MAX],
    ['core/trace.js#TRACE_TOTAL_CAP', TRACE_TOTAL_CAP],
    ['core/trace.js#TRACE_ITEM_MAX', TRACE_ITEM_MAX],
    ['core/trace.js#TRACE_DEDUPE_MS', TRACE_DEDUPE_MS],
    ['core/trace.js#TRACE_CONTEXT_SPAN', TRACE_CONTEXT_SPAN],
    ['adapters/trace-store.js#TRACE_STORE_CAP', TRACE_STORE_CAP],
    ['core/read-ledger.js#READ_LEDGER_CAP', READ_LEDGER_CAP],
    ['core/conflicts.js#CONFLICT_CAP', CONFLICT_CAP],
    ['core/conflicts.js#CONFLICT_LOG_CAP', CONFLICT_LOG_CAP],
    ['core/sync-log.js#SYNC_LOG_MAX', SYNC_LOG_MAX],
    ['core/pipeline.js#ETA_SAMPLES', ETA_SAMPLES],
    ['core/token-cost.js#AI_USAGE_KEEP', AI_USAGE_KEEP],
    ['#AI_USAGE_MAX_KEYS', AI_USAGE_MAX_KEYS],
    ['adapters/floor-backup.js#FLOOR_BACKUP_SLOTS', FLOOR_BACKUP_SLOTS],
    ['core/repair.js#REPAIR_LOG_MAX', REPAIR_LOG_MAX],
    ['core/model/runtime.js#WARN_BACKLOG_MAX', WARN_BACKLOG_MAX],
    ['core/perf-probe.js#PERF_WINDOW', PERF_WINDOW],
    ['#PERF_DEDUPE_MS', PERF_DEDUPE_MS],
];
const capRows = debugCapList();
const rowBy = (needle) => capRows.filter((r) => String(r.source || '').indexOf(needle) >= 0);

A('C1 CAP 表至少 8 行，且每行四要素（载体 / 上限 / 保留窗 / 事实源符号）齐全（§3.4 的「每个载体给上限与保留窗」）', (() => {
    const bad = capRows.filter((r) => !String(r.carrier || '').trim() || !String(r.cap || '').trim() || !String(r.window || '').trim() || !String(r.source || '').trim());
    return capRows.length >= 8 && bad.length === 0;
})(), J({ rows: capRows.length }));

/** 逐常量核对 CAP 表，返回不一致清单（供断言与失败详情共用） */
function capMismatches() {
    const bad = [];
    for (const [needle, val] of CAP_EXPECT) {
        const rows = rowBy(needle);
        if (rows.length !== 1) { bad.push(needle + ' → 命中 ' + rows.length + ' 行'); continue; }
        const text = String(rows[0].cap || '') + ' ' + String(rows[0].window || '');
        if (text.indexOf(String(val)) < 0) bad.push(needle + ' → 表里没有 ' + val + '（实际：' + text + '）');
    }
    return bad;
}

A('C2 **CAP 以代码为准（逐常量核对）**：' + CAP_EXPECT.length + ' 个 `source` 行都能在表里找到，且该行的「上限 + 保留窗」文本里真的出现了那个常量值', capMismatches().length === 0, J(capMismatches()));

A('C3 分类环形上限逐类核对：`TRACE_CAT_CAP` 的 6 个数字都出现在同一行的上限文本里（文档只给符号，数字必须来自代码）', (() => {
    const rows = rowBy('core/trace.js#TRACE_CAT_CAP');
    if (rows.length !== 1) return false;
    const text = String(rows[0].cap || '');
    return Object.keys(TRACE_CAT_CAP).every((k) => text.indexOf(k + ' ' + TRACE_CAT_CAP[k]) >= 0);
})(), J({ row: rowBy('core/trace.js#TRACE_CAT_CAP')[0], cat: TRACE_CAT_CAP }));

A('C4 探针分级阈值与 `core/perf-probe.js#PERF_THRESHOLDS` 一致（50 / 200 / 1000），不做「文档抄一遍」', (() => {
    const rows = rowBy('core/perf-probe.js#PERF_THRESHOLDS');
    if (rows.length !== 1) return false;
    const text = String(rows[0].cap || '');
    return text.indexOf(String(PERF_THRESHOLDS.notice)) >= 0 && text.indexOf(String(PERF_THRESHOLDS.stall)) >= 0 && text.indexOf(String(PERF_THRESHOLDS.freeze)) >= 0;
})(), J(PERF_THRESHOLDS));

A('C5 `source` 指向的文件**真实存在**（「待建」的开发期产物除外；否则 CAP 表就是「写在文档里的臆想」）', (() => {
    const bad = [];
    for (const r of capRows) {
        const src = String(r.source || '');
        const m = /^([\w./-]+\.js)/.exec(src);
        if (!m) continue;                       // 非 .js 的事实源（如待建的 scripts/perf-baseline.json）不在此判据内
        try { readFileSync(join(ROOT, m[1]), 'utf8'); } catch (e) { bad.push(m[1]); }
    }
    return bad.length === 0;
})(), J(capRows.map((r) => r.source)));

A('C6 `debugCapList()` 返回副本（改动它不影响事实源）', (() => {
    const before = J(debugCapList());
    const l = debugCapList();
    l[0].cap = '被改坏了';
    l.push({ carrier: '假的' });
    return before === J(debugCapList());
})(), '');

// ============================================================
// R 组：统一脱敏（§3.5）
// ============================================================
A('R1 键名黑名单（`apikey|api_key|secret|token|password|passwd|authorization|cookie|session`，大小写不敏感）→ 值一律 `[redacted]`；**不命中**的普通键原样保留', (() => {
    const out = redactForOutlet({
        apiKey: 'AKIA-abcdefghijklmn', Authorization: 'Bearer abcdefghijklmnop',
        api_key: 'x', SECRET: 'y', token: 'z', password: 'p', passwd: 'q', cookie: 'c', session: 's',
        keep: 'this-should-stay', n: 42,
    });
    return out.apiKey === '[redacted]' && out.Authorization === '[redacted]' && out.api_key === '[redacted]'
        && out.SECRET === '[redacted]' && out.token === '[redacted]' && out.password === '[redacted]'
        && out.passwd === '[redacted]' && out.cookie === '[redacted]' && out.session === '[redacted]'
        && out.keep === 'this-should-stay' && out.n === 42;
})(), J(redactForOutlet({ apiKey: 'x', keep: 'y' })));

A('R2 字符串里的**密钥形态**（`sk-` / `Bearer ` / 长十六进制 / 长 Base64）→ 保留前 4 与后 2 字符 + `…`（不再原样外送）', (() => {
    const out = redactForOutlet({
        s1: 'sk-abcdefghijklmnop', s2: 'Bearer 0123456789abcdef',
        s3: 'a'.repeat(40), s4: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5', plain: 'hello',
    });
    return out.s1 === 'sk-a…op' && String(out.s1).indexOf('abcdefghij') < 0
        && String(out.s2).indexOf('…') >= 0 && String(out.s2).length <= 8
        && String(out.s3).indexOf('…') >= 0 && String(out.s3).length <= 8
        && String(out.s4).indexOf('…') >= 0 && String(out.s4).length <= 8
        && out.plain === 'hello';
})(), J(redactForOutlet({ s1: 'sk-abcdefghijklmnop', s3: 'a'.repeat(40) })));

A('R3 正文类字段（`text/content/desc/body/message/prompt/response`）→ **只回长度** `[len:N]`；非正文键的字符串照常保留', (() => {
    const out = redactForOutlet({ text: '甲乙丙', content: 'abcd', desc: '', body: [1, 2, 3], message: 'x'.repeat(50), prompt: 'p', response: 'r', action: '写入完成' });
    return out.text === '[len:3]' && out.content === '[len:4]' && out.desc === '[len:0]'
        && out.body === '[len:3]' && out.message === '[len:50]' && out.prompt === '[len:1]' && out.response === '[len:1]'
        && out.action === '写入完成';
})(), J(redactForOutlet({ text: '甲乙丙', body: [1, 2, 3] })));

A('R4 `{ allowText: true }` 时才回正文**原文**（显式开关，默认绝不外送）；且正文键下的密钥仍先命中黑名单', (() => {
    const s = '这是一段正文。'.repeat(30);          // 300 字：含中文与标点，**不会**被密钥形态启发式误伤
    const out = redactForOutlet({ text: s, apiKey: 'sk-abcdefghijkl', content: '短正文' }, { allowText: true });
    const capped = redactForOutlet({ text: s }, { allowText: true, depth: 6 });
    return out.text === s && out.content === '短正文' && out.apiKey === '[redacted]' && capped.text.length > 0;
})(), J(redactForOutlet({ text: 'abc' }, { allowText: true })));

A('R5 深度 ≤ 6 与每层 ≤ 50 项（数组元素 / 对象键）：超限处**标注截断**而不是无限展开', (() => {
    let deep = { v: 'leaf' };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    const arr = new Array(60).fill(0).map((_, i) => i);
    const wide = {}; for (let i = 0; i < 60; i++) wide['k' + i] = i;
    const o1 = redactForOutlet(deep);
    const o2 = redactForOutlet(arr);
    const o3 = redactForOutlet(wide);
    const o4 = redactForOutlet(arr, { items: 3, depth: 2 });
    let p = o1, d = 0;
    while (p && typeof p === 'object' && p.child !== undefined) { p = p.child; d++; if (d > 12) break; }
    return J(p) === J('[Object]') && o2.length === 51 && o2[50] === '…+10' && Object.keys(o3).length === 51 && o3['…'] === '+10'
        && o4.length === 4 && o4[3] === '…+57';
})(), J({ arr: redactForOutlet([1, 2, 3, 4]).length }));

A('R6 **循环引用不抛错**：自引用对象 / 互相引用对象 → 标 `[circular]`（观测设施绝不能反过来弄坏主流程）', (() => {
    const a = { name: 'a' }; a.self = a;
    const x = { n: 1 }; const y = { n: 2 };
    x.other = y; y.other = x;
    let ok = false, oa = null, ox = null;
    try { oa = redactForOutlet(a); ox = redactForOutlet(x); ok = true; } catch (e) { ok = false; }
    return ok && oa.self === '[circular]' && ox.other.other === '[circular]';
})(), '');

A('R7 **入参未被修改**（深比较前后逐字节一致）且返回**新对象**（引用不同）', (() => {
    const input = { apiKey: 'sk-abcdefghijkl', text: '正文', list: [1, 2, { token: 't', deep: { a: 1 } }] };
    const before = J(input);
    const out = redactForOutlet(input);
    return J(input) === before && out !== input && out.list !== input.list && out.list[2] !== input.list[2]
        && out.apiKey === '[redacted]' && out.text === '[len:2]' && out.list[2].token === '[redacted]' && out.list[2].deep.a === 1;
})(), J(redactForOutlet({ apiKey: 'k' })));

// ============================================================
// S 组：追溯六字段（§3.7）
// ============================================================
A('S1 `TRACE_FIELDS` 恰为 §3.7 的六字段且顺序固定（顺序固定才能让三处出口逐字段比对）', (() => {
    return J(TRACE_FIELDS) === J(['at', 'ver', 'window', 'cause', 'site', 'u']) && Object.isFrozen(TRACE_FIELDS);
})(), J(TRACE_FIELDS));

A('S2 `traceStamp` 规范化：**缺省补空串** · **多余键丢弃** · **超长值截断** · 非对象入参不抛', (() => {
    const full = traceStamp({ at: 1700000000000, ver: VERSION, window: 'w', cause: 'c', site: 'core/x.js:12', u: 'U197' });
    const empty = traceStamp(null);
    const extra = traceStamp({ at: 1, ver: 'v', window: 'w', cause: 'c', site: 's', u: 'u', 多出来的键: 'x', data: '正文' });
    const long = traceStamp({ cause: 'x'.repeat(400), site: 'y'.repeat(400) });
    return J(Object.keys(full)) === J(TRACE_FIELDS)
        && full.at === '1700000000000' && full.ver === VERSION && full.u === 'U197'
        && J(empty) === J({ at: '', ver: '', window: '', cause: '', site: '', u: '' })
        && Object.keys(extra).length === 6 && extra['多出来的键'] === undefined && extra.data === undefined
        && String(long.cause).length <= 120 && String(long.cause).slice(-1) === '…'
        && String(long.site).length <= 120 && traceStamp(42).at === '';
})(), J(traceStamp({ cause: 'x'.repeat(400) })));

// ============================================================
// O 组：只读清单与桥白名单（§3.6 · §8 Q4）
// ============================================================
/** 从 `ui/debug.js` 实测桥方法名（与 `core/debug-catalog.js` 的清单做集合比对） */
function bridgeNamesFromSource() {
    const t = stripComments(read('ui/debug.js'));
    const re = /[A-Za-z_$][\w$]*\[['"]((?:ftt|sys|host)\.[A-Za-z0-9_]+)['"]\]\s*=/g;
    const out = new Set();
    let m;
    while ((m = re.exec(t))) out.add(m[1]);
    return out;
}
const BRIDGE_SRC = bridgeNamesFromSource();
const RO = readonlyOutletList();
const RO_BRIDGE = new Set(RO.filter((x) => String(x.where).indexOf('buildBridgeMethods') >= 0).map((x) => x.name));
const RO_CLEAR = RO.filter((x) => x.kind === 'clear');

A('O1 **只读清单与桥白名单双向差异 0**（`技-41` 验收 ②）：清单里的桥方法与 `ui/debug.js#buildBridgeMethods` 实测方法名**完全一致** —— 桥新增一个方法而清单没跟上，这条就红', (() => {
    const onlySrc = Array.from(BRIDGE_SRC).filter((n) => !RO_BRIDGE.has(n));
    const onlyList = Array.from(RO_BRIDGE).filter((n) => !BRIDGE_SRC.has(n));
    return BRIDGE_SRC.size > 40 && onlySrc.length === 0 && onlyList.length === 0;
})(), J({ src: BRIDGE_SRC.size, list: RO_BRIDGE.size, onlySrc: Array.from(BRIDGE_SRC).filter((n) => !RO_BRIDGE.has(n)), onlyList: Array.from(RO_BRIDGE).filter((n) => !BRIDGE_SRC.has(n)) }));

A('O2 **Q4 反向判据**：`kind:\'clear\'` 的清空型动作**没有任何一个**出现在桥方法名集合里（含裸名与 `ftt.`+名两种形态）—— 桥里一旦出现清空动作，这条就红', (() => {
    const bare = new Set(Array.from(BRIDGE_SRC).map((n) => n.split('.')[1]));
    const bad = RO_CLEAR.filter((x) => BRIDGE_SRC.has(x.name) || bare.has(x.name) || BRIDGE_SRC.has('ftt.' + x.name));
    return RO_CLEAR.length >= 5 && bad.length === 0;
})(), J({ clear: RO_CLEAR.map((x) => x.name), bad: RO_CLEAR.filter((x) => BRIDGE_SRC.has(x.name)).map((x) => x.name) }));

A('O3 清空型动作的 `note` 写明「永不进桥白名单（Q4 裁决）；只在面板 / 命令里，走既有二次确认」，且每条都有 `where`（可核对落点）', (() => {
    const bad = RO_CLEAR.filter((x) => String(x.note || '').indexOf('永不进桥白名单') < 0 || String(x.note || '').indexOf('二次确认') < 0 || !String(x.where || '').trim());
    const kinds = new Set(RO.map((x) => x.kind));
    return bad.length === 0 && J(Array.from(kinds).sort()) === J(['clear', 'read']);
})(), J(RO_CLEAR.map((x) => x.note)));

A('O4 只读清单三组齐备（桥 `ftt.*` / 桥 `sys.*` / `FTT.*` 只读入口）且 `debugCatalogReport().readonly` 的分组计数与实际一致（同一读数只算一次）', (() => {
    const groups = new Set(RO.map((x) => x.group));
    const rep = debugCatalogReport();
    const has = (kw) => Array.from(groups).some((g) => g.indexOf(kw) >= 0);
    return has('ftt.*') && has('sys.*') && has('FTT.*') && has('清空型')
        && rep.readonly.read === RO.filter((x) => x.kind === 'read').length
        && rep.readonly.clear === RO_CLEAR.length
        && rep.readonly.total === RO.length;
})(), J(debugCatalogReport().readonly));

A('O5 `readonlyOutletList()` 返回副本（改动它不会改到事实源）', (() => {
    const before = J(readonlyOutletList().map((x) => [x.group, x.name]));
    const l = readonlyOutletList();
    l.push({ group: '假的', name: '假的', kind: 'read', where: '', note: '' });
    l[0].name = '被改坏了';
    return before === J(readonlyOutletList().map((x) => [x.group, x.name]));
})(), '');

// ============================================================
// T 组：12 类必要内容与汇总读数（§5 · §3.8）
// ============================================================
A('T1 `REQUIRED_CONTENT` **恰为 12 类**（`docs/D31` §5），编号 1..12 连续，每类都有非空 `outlets` 数组与中文名；第 11/12 类（性能与卡顿 / 优化事项清单）已登记且用的是 `data-ftt-sec="perf"` / `ftt.perf*` / 导出字段 `perf`', (() => {
    const nos = REQUIRED_CONTENT.map((x) => x.no);
    const bad = REQUIRED_CONTENT.filter((x) => !Array.isArray(x.outlets) || !x.outlets.length || !String(x.name || '').trim());
    const n11 = REQUIRED_CONTENT.filter((x) => x.no === 11)[0] || { outlets: [] };
    const n12 = REQUIRED_CONTENT.filter((x) => x.no === 12)[0] || { outlets: [] };
    return REQUIRED_CONTENT.length === 12 && J(nos) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) && bad.length === 0
        && n11.outlets.indexOf('data-ftt-sec="perf"') >= 0 && n11.outlets.indexOf('ftt.perf') >= 0
        && n12.outlets.indexOf('ftt.perfTargets') >= 0 && n12.outlets.indexOf('perf') >= 0;
})(), J(REQUIRED_CONTENT.map((x) => [x.no, x.name, x.outlets.length])));

A('T2 `requiredContentList()` 是**副本**且带 `status` / `note`（`status` 是 §5 的**声明**读数；实时判定在 scripts/check-debug-coverage.js）', (() => {
    const l = requiredContentList();
    const before = J(requiredContentList());
    l[0].name = '被改坏了';
    l[0].outlets.push('假的出口');
    return before === J(requiredContentList())
        && l.every((x) => x.status === 'ok' || x.status === 'gap')
        && String(l[10].note || '').indexOf('U191') >= 0 && String(l[11].note || '').indexOf('U196') >= 0;
})(), J(requiredContentList().map((x) => [x.no, x.status])));

A('T3 `debugCatalogReport()` 是一处计算的汇总读数（kinds/caps/traceFields/required/readonly 全部由上面几张表派生，不重算）；`debugCatalogText()` ≤ 200 字并且真的念出条数', (() => {
    const r = debugCatalogReport();
    const txt = debugCatalogText();
    return r.kinds === DEBUG_KINDS.length && r.caps === DEBUG_CAPS.length && r.required === REQUIRED_CONTENT.length
        && J(r.traceFields) === J(TRACE_FIELDS)
        && r.version === VERSION
        && Array.isArray(r.unregisteredKinds) && r.unregisteredKinds.length === 0
        && txt.length > 0 && txt.length <= 200 && txt.indexOf(String(r.kinds)) >= 0 && txt.indexOf(String(r.caps)) >= 0;
})(), J({ text: debugCatalogText(), len: debugCatalogText().length }));

A('T4 **内核纯净**：`core/debug-catalog.js` 只 import `./constants.js`（无宿主 / DOM / `node:fs`），且**不反向** import `core/debug-log.js`（那会成环）', (() => {
    const src = read('core/debug-catalog.js');
    const imports = Array.from(src.matchAll(/^\s*import\s+[^;]*?from\s+'([^']+)'/gm)).map((m) => m[1]);
    return imports.length === 1 && imports[0] === './constants.js'
        && imports.every((x) => x.indexOf('debug-log') < 0);
})(), '');

// ============================================================
// U 组：debug-log.js 的「未登记 kind」三步（技-41 ①/④）
// ============================================================
A('U1 未登记 kind：**照记**（绝不丢日志）+ **计数**（`debugLogStats().unregistered`）+ `debugUnregisteredKinds()` 带 `notified`；同 kind 第二次只加计数', (() => {
    setDebugLogHooks({ load: () => [], save: () => undefined });
    debugLogClear();
    const k = '未登记示例类别';
    const r1 = debugLogPush(k, { a: 1 });
    const r2 = debugLogPush(k, { a: 2 });
    const list = debugLogList();
    const st = debugLogStats();
    const un = debugUnregisteredKinds();
    const ok = r1 === true && r2 === true && list.length === 2 && list[0].kind === k && list[1].kind === k
        && st.n === 2 && st.unregistered.count === 2 && J(st.unregistered.kinds) === J([k])
        && un.length === 1 && un[0].kind === k && un[0].count === 2 && un[0].notified === true
        && Number(un[0].firstAt) > 0 && Number(un[0].lastAt) >= Number(un[0].firstAt);
    debugLogClear();
    return ok;
})(), J({ st: debugLogStats(), un: debugUnregisteredKinds() }));

A('U2 未登记读数**不会污染既有统计口径**：已登记 kind 照常计数，`unregistered` 只统计未登记的那一个；`debugLogClear()` 后统计全部归零（含 `unregistered`）', (() => {
    setDebugLogHooks({ load: () => [], save: () => undefined });
    debugLogClear();
    debugLogPush('摘要', '正常');
    debugLogPush('未登记示例类别', '异常口径');
    const st = debugLogStats();
    const midOk = st.n === 2 && Number(st.kinds['摘要']) === 1 && Number(st.kinds['未登记示例类别']) === 1
        && st.unregistered.count === 1 && st.cap === DEBUG_CAP;
    debugLogClear();
    const after = debugLogStats();
    const ok = midOk && after.n === 0 && J(after.kinds) === J({}) && after.unregistered.count === 0 && after.unregistered.kinds.length === 0;
    debugLogClear();
    return ok;
})(), J({ mid: debugLogStats() }));

A('U3 **依赖倒置**：`debug-log.js` 把「未登记」读取器注入给 `debug-catalog.js`，因此 `debugCatalogReport().unregisteredKinds` 是**实时**的（catalog 不反向 import debug-log，故无环）', (() => {
    setDebugLogHooks({ load: () => [], save: () => undefined });
    debugLogClear();
    const before = debugCatalogReport().unregisteredKinds.length;
    debugLogPush('另一个未登记类别', 1);
    const rep = debugCatalogReport();
    const ok = before === 0 && rep.unregisteredKinds.length === 1 && rep.unregisteredKinds[0].kind === '另一个未登记类别';
    debugLogClear();
    return ok && debugCatalogReport().unregisteredKinds.length === 0;
})(), J(debugCatalogReport().unregisteredKinds));

A('U4 未登记 kind **不额外读时钟**（观测设施不得扰动被观测者）：`tests/unit/debug-log-golden.test.js` 用「固定基准 + 每次 +1ms」的确定性时钟逐字节比对 V1 黄金样本 —— 本用例用一个可计数的时钟证明「push 一条未登记 kind」只读一次时钟（与基线相同）', (() => {
    setDebugLogHooks({ load: () => [], save: () => undefined });
    debugLogClear();
    const real = Date.now;
    let calls = 0;
    Date.now = () => { calls += 1; return 1700000000000 + calls; };
    let n1 = 0, n2 = 0;
    try {
        calls = 0; debugLogPush('未登记示例类别', 'a'); n1 = calls;
        debugLogClear();
        calls = 0; debugLogPush('摘要', 'a'); n2 = calls;
    } finally { Date.now = real; }
    debugLogClear();
    return n1 === 1 && n2 === 1;
})(), J({ unregisteredTicks: '见断言' }));

A('U5 **一次性提示真的会写一条 `dbgLog(\'调试\', …)`**（宿主接线后，即需求 ②）：把 `chatHooks.dbgLog` 接成 `debugLogPush`（就是 `host/chat.js` 的真机接法）后，第一次遇到未登记 kind 会**多出恰好 1 条** `kind=调试` 的条目；它排在**业务条目之后**（故 `debugLogList()[0]` 仍是业务条目本身）；**同一个 kind 第二次不再提示**（不刷屏）', (() => {
    setDebugLogHooks({ load: () => [], save: () => undefined });
    setChatHooks({ dbgLog: (k, d) => debugLogPush(k, d) });
    debugLogClear();
    debugLogPush('未登记示例类别', 'first');
    const a1 = debugLogList();
    debugLogPush('未登记示例类别', 'second');
    const a2 = debugLogList();
    const ok = a1.length === 2 && a1[0].kind === '未登记示例类别' && a1[1].kind === '调试'
        && a2.length === 3 && a2.filter((l) => l.kind === '调试').length === 1
        && a2[0].kind === '未登记示例类别'
        && String(a1[1].data).indexOf('未登记示例类别') >= 0;
    setChatHooks({ dbgLog: () => undefined });    // 复原：同进程后续用例不受影响
    debugLogClear();
    return ok;
})(), J({ afterFirst: 2, afterSecond: 3 }));

R.done();
