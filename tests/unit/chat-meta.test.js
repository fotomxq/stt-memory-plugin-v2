// 单元测试 · v2.94.0「chatMetadata 主载体：**只读**接入与差异报告」（`docs/D11` v0.3 §3.2/§5 S1；`docs/D12` v0.2 S4b）
//
// 用户裁决（`docs/D12` §8-C）：「载体必须比消息活得久 —— 记忆数据主载体是 `chatMetadata`（随聊天存活），
//   **不得**把消息 `extra` 作为唯一载体（删楼会连带删掉）。」
// 本阶段纪律：**只读不写** —— 探测宿主 API（缺失即降级）→ 读命名空间下的数据 → 与当前状态做逐项差异报告。
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import {
    CHAT_META_KEY, chatMetaCapability, chatMetaRead, liveStateSummary, chatMetaDiffReport, chatMetaDiffText,
} from '../../adapters/chat-meta.js';
import { chatMetaSectionHtml, buildDebugExport } from '../../ui/debug.js';
import { setDebugHooks } from '../../ui/debug.js';

const R = makeReporter('chat-meta v2.94.0 chatMetadata 主载体只读差异报告');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
let uninstallHost = null;
function bootHost(metaObj, opts) {
    const o = opts || {};
    if (uninstallHost) { try { uninstallHost(); } catch (e) { /* 忽略 */ } uninstallHost = null; }
    const host = makeHost({ chat: [{ is_user: true, mes: '你好', name: 'User' }] });
    if (!o.noChatMetadata) host.ctx.chatMetadata = (metaObj === undefined) ? {} : metaObj;
    else delete host.ctx.chatMetadata;
    if (o.noSaveMetadata) delete host.ctx.saveMetadata;
    uninstallHost = installGlobalHost(host, doc);
    return host;
}

/** 造一份「chatMetadata 里的记忆信封」 */
function metaEnvelope(stateObj, at) {
    return { [CHAT_META_KEY]: { format: 'ftt-memory-v2', version: '2.94.0', scope: 'char:x', at: (at === undefined ? 1700000000000 : at), state: stateObj } };
}
/** 造一份生效状态（各维条数可控） */
function liveState(atoms, memories) {
    const st = emptyState();
    st.atoms = [];
    for (let i = 0; i < (atoms || 0); i++) st.atoms.push({ id: 'a' + i, h: 'h' + i, text: '情节' + i });
    st.memories = [];
    for (let i = 0; i < (memories || 0); i++) st.memories.push({ id: 'm' + i, h: 'mh' + i, text: '记忆' + i });
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}
setScopeKey('char:chatmeta');

// ---------- A 组：能力探测与降级 ----------
A('A1 能力探测：有 chatMetadata → available/readable；saveMetadata 存在只作**写能力诊断**（本阶段不调用）；无宿主 → no-host', (() => {
    bootHost({});
    const a = chatMetaCapability();
    return a.available === true && a.readable === true && a.writable === true && a.reason === '';
})(), () => J(chatMetaCapability()));

A('A2 宿主不提供 chatMetadata / saveMetadata → 如实降级（不抛异常：`no-chat-metadata`；写能力 false 但**可读**）', (() => {
    bootHost(undefined, { noChatMetadata: true });
    const a = chatMetaCapability();
    const r = chatMetaRead();
    const d = chatMetaDiffReport(liveState(0, 0));
    bootHost({}, { noSaveMetadata: true });
    const b = chatMetaCapability();
    return a.available === false && a.reason === 'no-chat-metadata' && r.ok === false && r.reason === 'no-chat-metadata'
        && d.verdict === 'unsupported' && d.text.indexOf('本阶段降级') >= 0
        && b.available === true && b.writable === false;
})(), () => J({ cap: chatMetaCapability(), read: chatMetaRead() }));

A('A3 无宿主上下文（纯 Node）时不抛异常，全部降级', (() => {
    if (uninstallHost) { try { uninstallHost(); } catch (e) { /* 忽略 */ } uninstallHost = null; }
    const a = chatMetaCapability();
    const r = chatMetaRead();
    const d = chatMetaDiffReport(liveState(0, 0));
    bootHost({});
    return a.available === false && a.reason === 'no-host' && r.ok === false && d.verdict === 'unsupported';
})(), '');

// ---------- B 组：只读接入 ----------
A('B1 读出命名空间下的信封：present / 各维条数 / 总数 / 体积 / 写入时间 / 版本', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }, { id: 'a2' }], memories: [{ id: 'm1' }] }, 1700000000000));
    const r = chatMetaRead();
    return r.ok === true && r.present === true && r.total === 3
        && r.counts.atoms === 2 && r.counts.memories === 1 && r.counts.items === 0
        && r.at === 1700000000000 && r.version === '2.94.0' && r.scope === 'char:x' && r.bytes > 30;
})(), () => J(chatMetaRead()));

A('B2 chatMetadata 存在但**没有本插件命名空间** → present=false（不误报、不臆造）', (() => {
    bootHost({ otherExtension: { a: 1 } });
    const r = chatMetaRead();
    return r.ok === true && r.present === false && r.total === 0 && r.bytes === 0;
})(), () => J(chatMetaRead()));

A('B3 兼容「裸 state」（命名空间下直接是 state，没有信封）与同口径摘要', (() => {
    bootHost({ [CHAT_META_KEY]: { atoms: [{ id: 'x' }], snapshts: [] } });
    const r = chatMetaRead();
    const live = liveStateSummary(liveState(1, 0));
    return r.present === true && r.total === 1 && r.counts.atoms === 1
        && live.total === 1 && live.counts.atoms === 1 && live.bytes > 2;
})(), '');

// ---------- C 组：差异报告结论（D11 S1 验收：逐项差异 + 可执行结论） ----------
A('C1 live-only：chatMetadata 没有本插件数据、当前状态有 → 明确说「只在文件通道」「本阶段只读不动」', (() => {
    bootHost({});
    const d = chatMetaDiffReport(liveState(3, 1));
    return d.verdict === 'live-only' && d.present === false && d.live.total === 4
        && d.text.indexOf('只在文件通道') >= 0 && d.text.indexOf('只读不动') >= 0;
})(), () => J(chatMetaDiffReport(liveState(3, 1)).verdict));

A('C2 same：两边各维条数一致 → 无需处理（体积两边都给出）', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }], memories: [{ id: 'm1' }] }));
    const d = chatMetaDiffReport(liveState(1, 1));
    return d.verdict === 'same' && d.ok === true && Object.keys(d.dims).length === 0
        && d.text.indexOf('两边一致') >= 0 && d.meta.bytes > 0 && d.live.bytes > 0;
})(), '');

A('C3 differs + 时间先后：两边条数不同时按 `at` 判「哪边较新」，并逐维列出差值与方向', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }, { id: 'a2' }], memories: [] }, 1700000000000));
    const st = liveState(1, 0);
    st.updatedAt = 0;                        // live.at 恒为 0 → meta 较新
    const a = chatMetaDiffReport(st);
    const st2 = liveState(1, 0);
    const b = chatMetaDiffReport(st2);
    // 反过来：把 chatMetadata 的时间调到 0 → 判定「当前状态较新」
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }, { id: 'a2' }] }, 0));
    const c = chatMetaDiffReport(liveState(1, 0));
    return a.verdict === 'meta-newer' && a.dims.atoms && a.dims.atoms.meta === 2 && a.dims.atoms.live === 1
        && a.dims.atoms.delta === 1 && a.text.indexOf('两边条目数不同') >= 0
        && b.verdict === 'meta-newer' && c.verdict === 'live-newer';
})(), () => J({ a: chatMetaDiffReport(liveState(1, 0)).verdict }));

A('C4 meta-only：只有 chatMetadata 有数据、当前状态为空 → 需人工确认后再恢复（**不自动改数据**）', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }] }, 1700000000000));
    const d = chatMetaDiffReport(liveState(0, 0));
    return d.verdict === 'meta-only' && d.live.total === 0 && d.meta.total === 1
        && d.text.indexOf('需要人工确认') >= 0;
})(), '');

A('C5 empty：两边都空 → empty（不是 unsupported、也不是 same）', (() => {
    bootHost({});
    const d = chatMetaDiffReport(liveState(0, 0));
    return d.verdict === 'empty' && d.text.indexOf('都没有') >= 0;
})(), '');

A('C6 人读文本（调试包用）：含命名空间与结论，且**不含任何记忆正文**', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1', text: '机密正文甲' }] }, 1700000000000));
    const t = chatMetaDiffText(liveState(1, 0));
    return t.indexOf(CHAT_META_KEY) >= 0 && t.indexOf('只读不写') >= 0 && t.indexOf('结论：') >= 0
        && t.indexOf('机密正文甲') < 0;
})(), () => chatMetaDiffText(liveState(1, 0)));

// ---------- D 组：**只读不写**（S1 的核心纪律） ----------
A('D1 读取 / 差异报告**完全不改动** chatMetadata（深比较一致），也**从不调用** saveMetadata', (() => {
    const host = bootHost(metaEnvelope({ atoms: [{ id: 'a1' }] }, 1700000000000));
    const before = JSON.stringify(host.ctx.chatMetadata);
    let saveCalls = 0;
    host.ctx.saveMetadata = () => { saveCalls++; return Promise.resolve(); };
    chatMetaRead();
    chatMetaDiffReport(liveState(5, 5));
    chatMetaDiffText(liveState(5, 5));
    chatMetaCapability();
    return JSON.stringify(host.ctx.chatMetadata) === before && saveCalls === 0;
})(), '');

A('D2 宿主 chatMetadata 被替换为**非对象**（异常宿主）时仍降级且不抛', (() => {
    const host = bootHost({});
    host.ctx.chatMetadata = null;
    const d = chatMetaDiffReport(liveState(1, 0));
    host.ctx.chatMetadata = 'not-an-object';
    const d2 = chatMetaDiffReport(liveState(1, 0));
    return d.verdict === 'unsupported' && d2.verdict === 'unsupported';
})(), '');

// ---------- E 组：界面与调试包 ----------
A('E1 调试页「📎 chatMetadata 主载体（只读差异报告）」区块：命名空间 / 结论 / 逐维差异 / 「只读」声明齐备', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1' }, { id: 'a2' }], memories: [] }, 1700000000000));
    const live = liveState(1, 0);
    setKernelState(live);
    const h = String(chatMetaSectionHtml() || '');
    return h.indexOf('data-ftt-chat-meta') >= 0 && h.indexOf(CHAT_META_KEY) >= 0
        && h.indexOf('chatMetadata：2 条') >= 0 && h.indexOf('当前状态：1 条') >= 0
        && h.indexOf('atoms：chatMetadata 2 / 当前 1（差 1）') >= 0
        && h.indexOf('<b>只读</b>') >= 0;
})(), '');

A('E2 调试包（`buildDebugExport`）含主载体只读报告文本，且**不含记忆正文**', (() => {
    bootHost(metaEnvelope({ atoms: [{ id: 'a1', text: '机密正文乙' }] }, 1700000000000));
    setKernelState(liveState(1, 0));
    setDebugHooks({ dump: () => null, meta: () => ({}) });
    const pkg = buildDebugExport();
    const t = (() => { try { return JSON.stringify(pkg); } catch (e) { return ''; } })();
    return typeof pkg.chatMeta === 'string' && pkg.chatMeta.indexOf('主载体（chatMetadata）只读差异报告') >= 0
        && pkg.chatMeta.indexOf('机密正文乙') < 0 && t.indexOf('机密正文乙') < 0;
})(), '');

R.done();
