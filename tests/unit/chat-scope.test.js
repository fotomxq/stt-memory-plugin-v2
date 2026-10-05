// ============================================================
// 单元测试 · v3.20.0「时钟吃了别条聊天的旧情节」根因修复
//
// 用户报告（原话）：「通过调试端口分析识别时钟BUG，最新的情节已经变化，但还是识别为错误的时间，
//   请修复该问题。该问题已经出现过很多次，请核对根源并修复。」
//
// 真机取证（调试桥 `ftt.clockTraceInfo` / 落盘状态 / 插件自己的修复日志）：
//   · 当前聊的是 `书籍`（24 楼，628 年长安线），但同一个角色的 `atoms` 里还躺着
//     198 年罗马线、327/438 年昆仑山线的旧情节，楼层号一路排到 **508**；
//   · 修复日志原文：「楼层突变：**最新情节在第 508 楼、当前只有第 13 楼**（相差 495 层…）」
//     「**剧情时钟：已是最新（本轮无改动）（日期 198-02-21 · 时间 上午 · 地点 苏布拉街区…）**」
//     —— 时钟被**别条聊天**的旧情节锁死，而当前聊天的正文早已走到 628-07-10；
//   · 且**每次删楼都复发**：`handleFloorShrink` 用「按角色共用的台账哈希」当条目原文指纹，
//     把陈旧情节代理定位到当前聊天的楼层上并 `clearGone` **洗白**。
//
// 覆盖：A 判据原语；B 排序（聊天归属 / 位置越界）；C 时钟逐字段一致性；
//       D 新条目打归属；E 删楼不再洗白陈旧情节；F 判不出来时不改行为（向后兼容）。
// 运行：node tests/unit/chat-scope.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { chatTier, normalizeChatKey, plotPositionOf, plotOverflow, plotDemoted, currentChatKey, currentChatTail, plotScopeSnapshot } from '../../core/chat-scope.js';
import { trustedPlotList, latestPlotByFloor, atomLatestDated } from '../../core/recall.js';
import { resolveStoryClock, clockExtractState } from '../../core/clock-extract.js';
import { clockTraceInfo } from '../../core/clock-trace.js';
import { mergeDelta } from '../../core/ingest.js';
import { handleFloorShrink, hashFloorText } from '../../host/floors.js';

const R = makeReporter('chat-scope v3.20.0 情节按聊天隔离 + 位置越界降级');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const chatOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push({ is_user: i % 2 === 0, mes: '第' + i + '楼正文：角色甲在仓库清点货物。' }); return a; };

/** 装场景：`atoms` 情节列表；`chatKey` 当前聊天归属；`tail` 状态里记的末楼 */
function boot(atoms, opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:chat-scope');
    setLastMessageId(o.liveFloor === undefined ? 0 : o.liveFloor);
    const st = emptyState();
    setKernelState(st);
    st.atoms = atoms || [];
    if (o.chatKey !== undefined) st.chatKey = o.chatKey;
    if (o.tail !== undefined) { st.lastChatFloor = o.tail; st.lastKnownFloor = o.tail; }
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: chatOf(o.chatFloors === undefined ? 1 : o.chatFloors) }), doc);
    return st;
}
const ATOM = (id, floor, date, time, locs, extra) => Object.assign({
    id: id, text: id + ' 的正文足够长，供时钟取值。', title: id,
    date: date || '', time: time || '', locations: locs || [],
    floorStart: floor || 0, floorEnd: floor || 0, tags: [], uses: 0,
}, extra || {});
const pick = (r) => ({ date: r.date, time: r.time, location: r.location });

// ---------- A 组：判据原语 ----------
A('A1 `normalizeChatKey`：去空白 / 限长 / 非字符串为空', (() => {
    return normalizeChatKey('  8090866702608464 ') === '8090866702608464'
        && normalizeChatKey(null) === '' && normalizeChatKey(undefined) === ''
        && normalizeChatKey('x'.repeat(200)).length === 80;
})(), '');

A('A2 `chatTier`：本聊天 0 / 归属未知（升级前历史数据）1 / 别条聊天 2；当前标识未知时一律 0（不改行为）', (() => {
    const cur = 'A';
    const same = chatTier({ chatKey: 'A' }, cur) === 0;
    const legacy = chatTier({}, cur) === 1;
    const other = chatTier({ chatKey: 'B' }, cur) === 2;
    const noCur = chatTier({ chatKey: 'B' }, '') === 0 && chatTier({}, '') === 0;
    return same && legacy && other && noCur;
})(), '');

A('A3 `plotPositionOf` / `plotOverflow` / `plotDemoted`：`floorNow*` 优先；超出末楼判越界；与「原文已移除」同档降级', (() => {
    const p1 = plotPositionOf({ floorStart: 62, floorEnd: 62, floorNowStart: 9, floorNowEnd: 9 }) === 9;
    const p2 = plotPositionOf({ floorStart: 62, floorEnd: 70 }) === 70;
    const of1 = plotOverflow({ floorNowStart: 11, floorNowEnd: 11 }, 10) === true;
    const of2 = plotOverflow({ floorStart: 5, floorEnd: 10 }, 10) === false;
    const of3 = plotOverflow({ floorStart: 5, floorEnd: 10 }, -1) === false;       // 末楼未知 → 不判
    const dm1 = plotDemoted({ originGone: true }, 10) === 1;
    const dm2 = plotDemoted({ floorStart: 508, floorEnd: 508 }, 13) === 1;
    const dm3 = plotDemoted({ floorStart: 3, floorEnd: 3 }, 13) === 0;
    return p1 && p2 && of1 && of2 && of3 && dm1 && dm2 && dm3;
})(), '');

// ---------- B 组：排序（真机故障场景） ----------
// 真机数据：本聊天（628 年长安线，24 楼）＋ 别条聊天残留（198/327 年线，楼层号 11/508）
A('B1 **别条聊天的高楼层旧情节不再压住本聊天的最新情节**（真机：508 楼昆仑山旧线 vs 24 楼长安线）', (() => {
    boot([
        ATOM('外来旧线', 508, '327-03-15', '下午', ['昆仑深谷'], { chatKey: 'other-chat' }),
        ATOM('本聊天新', 24, '628-07-10', '下午', ['西市茶棚'], { chatKey: 'this-chat' }),
    ], { chatKey: 'this-chat', tail: 24 });
    const list = trustedPlotList();
    return list[0].node.id === '本聊天新'
        && J(pick(resolveStoryClock({}))) === J({ date: '628-07-10', time: '下午', location: '西市茶棚' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('B2 归属未知（升级前历史数据）仍参与竞争、且排在**已知别条聊天**的前面（保守，不倒退）', (() => {
    boot([
        ATOM('别条', 30, '327-03-15', '下午', ['昆仑'], { chatKey: 'other-chat' }),
        ATOM('历史数据', 20, '1919-11-20', '上午', ['码头']),
        ATOM('本聊天', 10, '628-07-10', '下午', ['西市'], { chatKey: 'this-chat' }),
    ], { chatKey: 'this-chat', tail: 30 });
    const list = trustedPlotList().map((x) => x.node.id);
    return J(list) === J(['本聊天', '历史数据', '别条']);
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('B3 本聊天一条都没有时 → 历史数据照旧按位置/日期取胜（不给「无值」）', (() => {
    boot([
        ATOM('历史旧', 1, '1919-11-20', '上午', ['码头']),
        ATOM('别条新', 50, '327-03-15', '下午', ['昆仑'], { chatKey: 'other-chat' }),
    ], { chatKey: 'this-chat', tail: 50 });
    const list = trustedPlotList();
    return list[0].node.id === '历史旧'
        && J(pick(resolveStoryClock({}))) === J({ date: '1919-11-20', time: '上午', location: '码头' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('B4 **位置越界降级**：情节楼层超过当前聊天末楼（508 楼 vs 末楼 13）→ 降级，不再当「最新情节」', (() => {
    boot([
        ATOM('越界', 508, '628-12-31', '深夜', ['未来城']),
        ATOM('在册', 13, '628-07-10', '下午', ['西市']),
    ], { tail: 13 });
    const list = trustedPlotList();
    return list[0].node.id === '在册'
        && J(pick(resolveStoryClock({}))) === J({ date: '628-07-10', time: '下午', location: '西市' })
        && plotScopeSnapshot().overflow === 1;
})(), () => J({ order: trustedPlotList().map((x) => x.node.id), scope: plotScopeSnapshot() }));

A('B5 `latestPlotByFloor()`（在场角色来源）与 `atomLatestDated()`（快照参考时钟）同口径：别条聊天的高楼层不再胜出', (() => {
    boot([
        ATOM('外来', 900, '628-12-31', '深夜', ['旧城'], { chatKey: 'other-chat' }),
        ATOM('本聊天', 24, '628-07-10', '下午', ['西市'], { chatKey: 'this-chat' }),
    ], { chatKey: 'this-chat', tail: 24 });
    const p = latestPlotByFloor();
    const n = atomLatestDated();
    return p && p.node.id === '本聊天' && n && n.node && n.node.id === '本聊天' && n.date === '628-07-10';
})(), () => J({ p: latestPlotByFloor() && latestPlotByFloor().node.id, n: atomLatestDated() && atomLatestDated().node.id }));

// ---------- C 组：时钟逐字段一致性（避免「日期已更新、时间还在旧日」） ----------
A('C1 日期取自最新情节、而**只有更早的另一天**有时间 → 时间**不得**跨日拼进来（地点仍取最新那条本身，判据入追踪）', (() => {
    const st = boot([
        ATOM('旧日', 1, '628-07-08', '上午', ['济世斋']),
        ATOM('新日', 2, '628-07-10', '', ['西市茶棚']),
    ], { tail: 2 });
    st.state.date = '628-07-08'; st.state.time = '上午'; st.state.location = '济世斋';
    const r = resolveStoryClock({});
    const info = clockTraceInfo() || {};
    const notes = J(info.notes || []);
    return r.date === '628-07-10' && r.time === '' && r.location === '西市茶棚'
        && notes.indexOf('一致性守卫') >= 0;
})(), () => J({ r: pick(resolveStoryClock({})), notes: (clockTraceInfo() || {}).notes }));

A('C2 同日的更早情节提供时间/地点 → 仍然允许（正常的「沿用当日已知值」）', (() => {
    boot([
        ATOM('同日早', 1, '628-07-10', '上午', ['济世斋']),
        ATOM('同日新', 2, '628-07-10', '', ['西市茶棚']),
    ], { tail: 2 });
    return J(pick(resolveStoryClock({}))) === J({ date: '628-07-10', time: '上午', location: '西市茶棚' });
})(), () => J(pick(resolveStoryClock({}))));

A('C3 最新情节只写时间不写日期（v2.98.0 的原始诉求）→ 时间/地点照旧取到，日期沿用上一已知日', (() => {
    boot([
        ATOM('旧', 1, '1919-11-20', '08:00', ['码头']),
        ATOM('新', 2, '', '深夜', ['酒馆']),
    ], { tail: 2 });
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-20', time: '深夜', location: '酒馆' });
})(), () => J(pick(resolveStoryClock({}))));

// ---------- D 组：新落库的情节打「聊天归属」 ----------
A('D1 新情节落库时打上当前聊天标识（`state.chatKey`）', (() => {
    const st = boot([], { chatKey: 'chat-A' });
    mergeDelta({ atoms: { add: [{ title: '新事件', text: '角色甲在码头发现了破碎的木箱，断定有人潜入。', date: '1919-11-20', locations: ['码头'], floorStart: 3, floorEnd: 3 }] } }, { start: 3, end: 3 });
    return st.atoms.length === 1 && st.atoms[0].chatKey === 'chat-A';
})(), () => J((state.atoms[0] || {}).chatKey));

A('D2 更新既有条目**继承**它原来的归属（别条聊天的条目不会因为一次 AI 更新被洗成「本聊天」）', (() => {
    const st = boot([ATOM('外来', 5, '327-03-15', '下午', ['昆仑'], { chatKey: 'other-chat', text: '角色甲在昆仑山深处与众人论道，议论五行与弦之辨。' })], { chatKey: 'chat-A' });
    mergeDelta({ atoms: { update: [{ id: '外来', title: '外来', text: '角色甲在昆仑山深处与众人论道，议论五行与弦之辨（修订）。', date: '327-03-15', floorStart: 5, floorEnd: 5 }] } }, { start: 5, end: 5 });
    return st.atoms.length === 1 && st.atoms[0].chatKey === 'other-chat';
})(), () => J((state.atoms[0] || {}).chatKey));

A('D3 当前聊天标识未知（读不到）→ **一个也不打标**（判不出来就不改行为，向后兼容）', (() => {
    const st = boot([], {});
    mergeDelta({ atoms: { add: [{ title: '新事件', text: '角色甲在码头发现了破碎的木箱，断定有人潜入。', date: '1919-11-20', floorStart: 3, floorEnd: 3 }] } }, { start: 3, end: 3 });
    return st.atoms.length === 1 && st.atoms[0].chatKey === undefined && (st.chatKey === '' || st.chatKey === undefined);
})(), () => J({ key: (state.atoms[0] || {}).chatKey, cur: state.chatKey }));

// ---------- E 组：删楼不再把陈旧情节「洗白」 ----------
// 真机成因：`handleFloorShrink` 用**按角色共用**的台账哈希当条目原文指纹 → 别条聊天的情节被代理定位到
//   当前聊天楼层并 `clearGone`，位置被伪造 → 每次删楼都把旧情节重新变成「有效位置」。
A('E1 条目**自己的位置指纹**在当前聊天里找不到 → 判「原文已移除」；不再被台账代理救活/改写指纹', (() => {
    boot([], { tail: 599, chatFloors: 10, liveFloor: 9 });
    state.atoms = [{
        id: '外来', title: '外来', text: '角色甲在罗马城苏布拉街区向酒商问路，问的是公厕在哪。',
        date: '198-02-21', floorStart: 3, floorEnd: 3,
        floorNowStart: 3, floorNowEnd: 3, floorNowHash: 'not-in-this-chat',
    }];
    state.processedFloors = [{ f: 3, h: hashFloorText(3) }];       // 台账代理：第 3 楼在本聊天里「在册」
    const r = handleFloorShrink();
    const a = state.atoms[0];
    return r.ok === true && a.originGone === true && a.floorNowHash === 'not-in-this-chat';
})(), () => J(state.atoms[0]));

A('E2 没有自己指纹的历史条目仍走台账代理（不倒退）：原文在册 → 保持有效、指纹补齐为台账值', (() => {
    boot([], { tail: 599, chatFloors: 10, liveFloor: 9 });
    state.atoms = [{ id: '老条目', title: '老条目', text: '角色甲在仓库清点货物，账目与实物对不上。', date: '1919-11-01', floorStart: 3, floorEnd: 3 }];
    state.processedFloors = [{ f: 3, h: hashFloorText(3) }];
    handleFloorShrink();
    const a = state.atoms[0];
    return a.originGone === undefined && a.floorNowStart === 3 && a.floorNowEnd === 3 && a.floorNowHash === hashFloorText(3);
})(), () => J(state.atoms[0]));

// ---------- F 组：判据读得到 / 读不到时的行为边界 ----------
A('F1 `currentChatKey()` / `currentChatTail()` 读的是状态里的登录项（宿主未注入 → 空与 -1）', (() => {
    boot([], {});
    const a = currentChatKey() === '' && currentChatTail() === -1;
    boot([], { chatKey: 'chat-A', tail: 23 });
    return a && currentChatKey() === 'chat-A' && currentChatTail() === 23;
})(), () => J({ key: currentChatKey(), tail: currentChatTail() }));

A('F2 `plotScopeSnapshot()` 体检口径：本聊天 / 未知 / 别条 / 越界 计数 + 本聊天最新楼层（不含正文）', (() => {
    boot([
        ATOM('本1', 3, '628-07-10', '下午', ['西市'], { chatKey: 'chat-A' }),
        ATOM('本2', 9, '628-07-10', '傍晚', ['西市'], { chatKey: 'chat-A' }),
        ATOM('未知', 5, '628-07-10', '上午', ['西市']),
        ATOM('别条', 40, '327-03-15', '下午', ['昆仑'], { chatKey: 'chat-B' }),
        ATOM('越界', 900, '628-12-31', '深夜', ['未来城'], { chatKey: 'chat-A' }),
    ], { chatKey: 'chat-A', tail: 13 });
    const s = plotScopeSnapshot();
    const hasBody = J(s).indexOf('正文足够长') >= 0;
    return s.total === 5 && s.current === 3 && s.legacy === 1 && s.other === 1 && s.overflow === 2
        && s.newest.length === 3 && s.newest[0].floor === 900 && !hasBody;
})(), () => J(plotScopeSnapshot()));

R.done();
