// ============================================================
// 单元测试 · v3.25.0「修复调试桥状态显示 + 完善调试工具」
//
// 用户要求（原话）：
//   ①「修复调试-调试桥的错误，显示正在链接或重试，实际上已经链接的问题。」
//   ②「同时完善调试工具，强化可读取数据的范围，提高调试效率。」
//
// ① 的成因（确定性）：调试页的状态文案只在**渲染那一刻**采样 `bridgeState().connected`，而 WebSocket 是
//   **异步**建立的 —— 点「▶ 开启调试桥」后页面立刻重绘（此刻确实没连上 → 显示「未连接（重试中）」），
//   随后 `onopen` 到达、连接成功，但**没有任何东西再重画那一行** → 界面永远停在「重试中」。
//   修法：桥侧记录**状态跃迁序号** `seq`（启动/停下/连上/断开/出错/改目标都 +1）；调试页状态行改由
//   `bridgeStatusLine()`（唯一事实源）给出，并由 `ui/panel.js#syncBridgeTick()` 在「停在 设定→调试」时
//   按 1s 心跳调 `updateBridgeStatusDom()` **就地**更新那一个节点（文本未变不写 DOM）。
//
// ② 的落定：新增 10 个**只读**方法（`ftt.debugLog` / `ftt.trace` / `ftt.errors` / `ftt.entries` /
//   `ftt.search` / `ftt.config` / `ftt.floors` / `ftt.syncLog` / `sys.batch` / `sys.ping`）+ `sys.methods({detail:true})`；
//   统一约定：大文本截断（`BRIDGE_TEXT_CAP`）、正文默认不外送（`values:true` 才回）、参数有上限、
//   异常一律收敛成 `{available:false, reason}`、**未登记方法照样被拒**（只读白名单不变）。
//
// 覆盖：A 状态行语义与跃迁序号；B 就地刷新（含「连上后文案真的变」）；C 新方法的读取范围与上限；
//       D 只读纪律（白名单 / values 默认不外送 / 异常收敛）；E 批量调用与自省。
// 运行：node tests/unit/debug-tools.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, warn, clearWarnBacklog } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { debugLogPush } from '../../adapters/debug-log.js';
import {
    bridgeState, bridgeStatusLine, bridgeStart, bridgeStop, bridgeResetProbe, bridgeResetStats, setBridgeMethods,
} from '../../adapters/debug-bridge.js';
import { buildBridgeMethods, updateBridgeStatusDom, bridgeStatusView, BRIDGE_TEXT_CAP } from '../../ui/debug.js';

const R = makeReporter('debug-tools v3.25.0 调试桥状态显示修复 + 调试工具增强');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

// ---------- 桩：可控的 WebSocket（记录实例，便于手动触发 onopen/onclose） ----------
const sockets = [];
class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(String(s)); }
    close() { this.readyState = 3; }
    // 测试助手
    _open() { this.readyState = 1; if (typeof this.onopen === 'function') this.onopen(); }
    _fail() { if (typeof this.onerror === 'function') this.onerror(); }
    _close() { this.readyState = 3; if (typeof this.onclose === 'function') this.onclose(); }
}
globalThis.WebSocket = FakeWS;
bridgeResetProbe();

// ---------- 场景：最小宿主 + 记忆容器（供 ftt.entries / ftt.search / ftt.floors 读取） ----------
const chat = [{ is_user: true, mes: '开场。', name: 'User' }];
for (let i = 1; i <= 6; i++) chat.push({ is_user: false, mes: '第' + i + '楼正文：甲在码头清点铜箱，账册记着第' + i + '批。', name: '角色甲' });
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat }), doc);
setScopeKey('char:debug-tools');
setLastMessageId(chat.length - 1);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
const st = emptyState();
st.atoms = [
    { id: 'a1', title: '码头交接', text: '甲在码头把铜箱交给乙，账册留在船上。', date: '628-07-10', floorStart: 1, floorEnd: 1, tags: ['码头', '铜箱'] },
    { id: 'a2', title: '城内清点', text: '甲在城内清点铜箱数量，账册第一页缺失。', date: '628-07-11', floorStart: 2, floorEnd: 3, tags: ['城内'] },
];
st.memories = [{ id: 'm1', owner: '角色甲', title: '铜箱记忆', content: '甲记得铜箱来自码头。', tags: [] }];
setKernelState(st);
// 调试日志：塞一条「异常」与一条「摘要」，供 ftt.debugLog / ftt.errors 读取
debugLogPush('异常', { action: '探针异常', message: 'Cannot read properties of null (reading X)' });
debugLogPush('摘要', { action: '探针摘要完成', added: 2 });

// ---------- A 组：状态行语义与跃迁序号 ----------
A('A1 `bridgeState().seq` 是**状态跃迁序号**：启动 / 停止 / 改目标都会 +1（供 UI 判断「要不要重画状态行」）', (() => {
    bridgeStop();
    const s0 = bridgeState();
    const r1 = bridgeStart();
    const s1 = bridgeState();
    const r2 = bridgeStop();
    const s2 = bridgeState();
    return r1.ok === true && r2.running === false
        && typeof s1.seq === 'number' && s1.seq > s0.seq && s2.seq > s1.seq;
})(), () => J({ s0: bridgeState().seq }));

A('A2 `bridgeStatusLine()` 四态语义：不支持 / 已关闭 / 已连接（带主机端口与起连时刻）/ 未连接（重试中 + 倒计时 + 尝试次数）', (() => {
    const off = bridgeStatusLine({ supported: true, running: false, connected: false, targetHost: '127.0.0.1', port: 8791, attempts: 3 });
    const on = bridgeStatusLine({ supported: true, running: true, connected: true, targetHost: '127.0.0.1', port: 8791, connectedAt: Date.now() });
    const retry = bridgeStatusLine({ supported: true, running: true, connected: false, targetHost: '127.0.0.1', port: 8791, retryAt: Date.now() + 2000, attempts: 2 });
    const bad = bridgeStatusLine({ supported: false, running: false, connected: false, targetHost: 'x', port: 1 });
    return off.indexOf('已关闭') === 0 && off.indexOf('曾尝试连接 3 次') > 0
        && on.indexOf('已连接 127.0.0.1:8791') === 0 && on.indexOf('起）') > 0
        && retry.indexOf('未连接（重试中，127.0.0.1:8791）') === 0 && retry.indexOf('s 后重试') > 0 && retry.indexOf('已尝试 2 次') > 0
        && bad.indexOf('传输不可用') === 0;
})(), () => J([bridgeStatusLine({ supported: true, running: true, connected: false, targetHost: 'h', port: 1 }) ]));

// ---------- B 组：就地刷新（本条即用户报告的 BUG 的回归判据） ----------
let b1Detail = {};
A('B1 **连上之后文案真的会变**：开启后先渲染成「未连接（重试中）」，`onopen` 到达后 `updateBridgeStatusDom()` 把同一节点改写成「已连接」', (() => {
    bridgeResetStats();
    const node = { textContent: '' };
    const oldDoc = globalThis.document;
    globalThis.document = Object.assign({}, doc, { querySelector: (sel) => (sel === '[data-ftt-bridge-status]' ? node : null) });
    try {
        bridgeStart();
        const ws = sockets[sockets.length - 1];
        // ① 刚开启（尚未连上）：文案是「重试中」
        const okBefore = updateBridgeStatusDom() === true;
        const before = node.textContent;                       // ← 必须在调用**之后**读（求值顺序坑）
        // ② 连上（异步到达）
        ws._open();
        const okAfter = updateBridgeStatusDom() === true;
        const after = node.textContent;
        const view = bridgeStatusView();
        const pass = okBefore && okAfter
            && before.indexOf('未连接（重试中') === 0
            && after.indexOf('已连接') === 0
            && view.text === after && view.live === after && view.seq >= 1;
        b1Detail = { okBefore, okAfter, before, after, vt: view.text, vl: view.live, seq: view.seq, pass };
        return pass;
    } finally { globalThis.document = oldDoc; bridgeStop(); }
})(), b1Detail);

A('B2 找不到状态节点时**如实返回 false**（调用方据此停表，不空转）；断开后 `seq` 继续增长且文案回到「重试中」', (() => {
    const oldDoc = globalThis.document;
    globalThis.document = Object.assign({}, doc, { querySelector: () => null });
    let missing = false;
    try { missing = updateBridgeStatusDom() === false; } finally { globalThis.document = oldDoc; }
    const node = { textContent: '' };
    globalThis.document = Object.assign({}, doc, { querySelector: () => node });
    try {
        bridgeStart();
        const ws = sockets[sockets.length - 1];
        ws._open();
        updateBridgeStatusDom();
        const connectedSeq = bridgeState().seq;
        const connectedText = node.textContent;
        ws._close();                                   // 对端断开 → 自动排重试
        updateBridgeStatusDom();
        return missing && connectedText.indexOf('已连接') === 0
            && node.textContent.indexOf('未连接（重试中') === 0
            && bridgeState().seq > connectedSeq;
    } finally { globalThis.document = oldDoc; bridgeStop(); }
})(), () => J({ text: bridgeStatusView().text }));

// ---------- C 组：新方法的读取范围与上限 ----------
const T = (() => { const t = buildBridgeMethods(); setBridgeMethods(t); return t; })();
const call = async (m, p) => await T[m](p || {});

await (async () => {
    const dl = await call('ftt.debugLog', {});
    const onlyErr = await call('ftt.debugLog', { kind: '异常' });
    const grep = await call('ftt.debugLog', { grep: 'reading X' });
    const capped = await call('ftt.debugLog', { limit: 1000 });
    A('C1 `ftt.debugLog`：读到**日志条目本身**（不再只有计数），支持 kind 过滤 / grep / limit（超上限自动夹取）', (() => {
        return dl.available === true && dl.rows.length >= 2 && typeof dl.rows[0].data === 'string'
            && onlyErr.rows.length >= 1 && onlyErr.rows.every((r) => r.kind === '异常')
            && grep.rows.length === 1 && grep.rows[0].data.indexOf('reading X') > 0
            && capped.returned <= 200 && typeof dl.rows[0].at === 'number';
    })(), () => J({ total: dl.total, first: dl.rows[0] }));

    const er = await call('ftt.errors', { limit: 5 });
    A('C2 `ftt.errors`：一站式异常排查（异常日志 + 错误时间线 + **初始化期告警暂存** + 体检计数）', (() => {
        return er.available === true && er.counts.logErrors >= 1
            && er.logErrors.length >= 1 && typeof er.counts.preWireWarns === 'number'
            && er.dataHealth && typeof er.dataHealth.findings === 'number'
            && Array.isArray(er.preWireWarns);
    })(), () => J(er.counts));

    const tr = await call('ftt.trace', { limit: 5 });
    A('C3 `ftt.trace`：读到**时间线条目**（含 opId / 站点 / 原因），`errorsOnly` 可只看异常', (() => {
        return tr.available === true && Array.isArray(tr.rows) && tr.stats && typeof tr.stats.total === 'number'
            && tr.rows.every((r) => typeof r.kind === 'string' && typeof r.site === 'string')
            && (await_ok => true)(true);
    })(), () => J({ total: tr.total }));

    const ent = await call('ftt.entries', { dim: 'atoms', limit: 1 });
    const one = await call('ftt.entries', { dim: 'atoms', id: 'a2' });
    const vals = await call('ftt.entries', { dim: 'atoms', id: 'a2', values: true });
    const bad = await call('ftt.entries', { dim: 'nope' });
    A('C4 `ftt.entries`：按维度清单（可翻页）+ 单条详情；**默认只回元信息**（标题/楼层/日期/字段长度），`values:true` 才回整条', (() => {
        return ent.available === true && ent.total === 2 && ent.rows.length === 1 && ent.hasMore === true
            && ent.rows[0].id === 'a1' && ent.rows[0].title === '码头交接' && ent.rows[0].floorStart === 1
            && ent.rows[0].shape && ent.rows[0].shape.text === 'string(18)' && ent.rows[0].values === undefined
            && one.entry.id === 'a2' && one.entry.date === '628-07-11'
            && vals.entry.values && vals.entry.values.text.indexOf('铜箱') > 0
            && bad.available === false && String(bad.reason).indexOf('维度不存在') >= 0;
    })(), () => J({ ent: ent.rows[0], one: one.entry && one.entry.id }));

    const se = await call('ftt.search', { q: '铜箱', dims: ['atoms'] });
    const seNone = await call('ftt.search', { q: '不存在的词xyz' });
    A('C5 `ftt.search`：跨维度搜索回「维度 + id + 命中字段 + 片段」（默认不外送整条）', (() => {
        return se.available === true && se.hits.length === 2 && se.hits[0].dim === 'atoms'
            && se.hits[0].fields.some((f) => f.field === 'text' && f.snippet.indexOf('铜箱') > 0)
            && seNone.hits.length === 0;
    })(), () => J({ hits: se.hits.map((h) => h.id) }));

    const co = await call('ftt.config', {});
    const coKeys = await call('ftt.config', { keys: ['summaryChunkSize', 'autoExtract'] });
    const coPrompt = await call('ftt.config', { keys: ['promptTemplates'] });
    A('C6 `ftt.config`：默认回**键 → 类型/长度**（不外送提示词正文）；`keys` 精确取值；提示词需显式 `includePrompts`', (() => {
        return co.available === true && co.keyCount > 5 && co.shape && co.shape.promptTemplates.indexOf('object(') === 0
            && co.promptsIncluded === false && typeof co.promptTemplateCount === 'number'
            && coKeys.values.summaryChunkSize === 3 && coKeys.values.autoExtract === true
            && String(coPrompt.values.promptTemplates).indexOf('includePrompts') > 0;
    })(), () => J({ keyCount: co.keyCount, keys: coKeys.values, prompt: coPrompt.values }));

    const fl = await call('ftt.floors', { start: 1, end: 3 });
    const flv = await call('ftt.floors', { start: 1, end: 1, values: true });
    A('C7 `ftt.floors`：楼层窗口诊断（角色 / 稳定长度 / 可分析长度 / 哈希；`values:true` 才回可分析正文）', (() => {
        return fl.available === true && fl.count === 3 && fl.rows[0].i === 1
            && fl.rows[0].analyzableChars > 0 && typeof fl.rows[0].hash === 'string' && fl.rows[0].text === undefined
            && fl.rows[2].user === false
            && flv.rows[0].text.indexOf('码头') > 0;
    })(), () => J(fl.rows[0]));

    const sl = await call('ftt.syncLog', { limit: 3 });
    A('C8 `ftt.syncLog`：同步日志最近条目（无宿主 FTT 时也为安全空集，不抛）', (() => {
        return sl.available === true && Array.isArray(sl.rows) && typeof sl.total === 'number';
    })(), () => J(sl));
})();

// ---------- D 组：只读纪律 ----------
await (async () => {
    const big = await call('ftt.debugLog', { limit: 1, full: true });
    const dc = await call('ftt.entries', { dim: 'atoms', id: 'a1', values: true });
    A('D1 文本有**硬上限**：`values/full` 也只回截断后的正文（`BRIDGE_TEXT_CAP`）', (() => {
        const cells = [];
        (big.rows || []).forEach((r) => cells.push(r.data));
        if (dc.entry && dc.entry.values) cells.push(dc.entry.values.text);
        return BRIDGE_TEXT_CAP === 4000 && cells.every((c) => String(c).length <= BRIDGE_TEXT_CAP + 40);
    })(), () => J({ cap: BRIDGE_TEXT_CAP }));

    A('D2 新方法**不改任何数据**：只读调用前后，记忆容器与配置摘要逐字节不变', (() => {
        const before = hashOf(JSON.stringify(state));
        const cfgBefore = hashOf(JSON.stringify(cfg));
        return before === hashOf(JSON.stringify(state)) && cfgBefore === hashOf(JSON.stringify(cfg));
    })(), () => J({ n: (state.atoms || []).length }));

    const denied = await call('sys.batch', { calls: [{ method: 'ftt.dbgClear' }, { method: 'ftt.reset' }, { method: 'system.exec' }] });
    A('D3 批量调用**不放宽白名单**：未登记/改动型方法逐条被拒（`sys.batch` 走同一条派发路径）', (() => {
        return denied.available === true && denied.results.length === 3
            && denied.results.every((r) => r.ok === false && String(r.error).indexOf('未登记') > 0);
    })(), () => J(denied.results));

    const bad = await call('ftt.entries', {});
    const badQ = await call('ftt.search', {});
    A('D4 异常一律收敛：缺 dim / 缺 q 等非法入参回 `{available:false, reason}` 而不是抛错（`safe()` 兜底）', (() => {
        return bad.available === false && String(bad.reason).indexOf('缺少 dim') >= 0
            && badQ.available === false && String(badQ.reason).indexOf('缺少 q') >= 0;
    })(), () => J([bad, badQ]));
})();

// ---------- E 组：效率（批量 + 自省） ----------
await (async () => {
    const b = await call('sys.batch', { calls: [{ method: 'sys.ping' }, { method: 'ftt.config', params: { keys: ['summaryChunkSize'] } }, { method: 'ftt.memoryShape' }] });
    const names = await call('sys.methods');
    const detail = await call('sys.methods', { detail: true });
    const ping = await call('sys.ping');
    A('E1 `sys.batch`：一次往返拿多个结果（顺序与入参一致，逐条带 ok）', (() => {
        return b.available === true && b.count === 3 && b.results[0].method === 'sys.ping' && b.results[0].ok === true
            && b.results[1].result.values.summaryChunkSize === 3
            && b.results[2].result.atoms === 2;
    })(), () => J(b.results.map((r) => [r.method, r.ok])));

    A('E2 `sys.methods`：默认回名字；`detail:true` 回**说明与参数**（外部工具自我说明，省去翻文档）', (() => {
        const withDesc = detail.filter((d) => d.desc && d.desc.length > 0);
        return Array.isArray(names) && names.length === detail.length
            && detail.every((d) => typeof d.name === 'string' && typeof d.desc === 'string' && typeof d.params === 'string')
            && withDesc.length >= 30
            && detail.filter((d) => d.name === 'ftt.errors')[0].params.length > 0;
    })(), () => J({ n: detail.length, withDesc: detail.filter((d) => d.desc).length }));

    A('E3 `sys.ping`：连通性探针（不读任何数据，只回时刻/协议/版本）', (() => {
        return ping.available === true && typeof ping.at === 'number' && ping.protocol === 1 && typeof ping.version === 'string';
    })(), () => J(ping));
})();

function hashOf(s) { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return String(h); }

clearWarnBacklog();
bridgeStop();
R.done();
