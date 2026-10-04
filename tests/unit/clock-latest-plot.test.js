// ============================================================
// 单元测试 · v2.98.0「获取时间，没有从最新情节自动抓取数据」修复
//
// 用户报告（原话）：「获取时间，没有从最新情节自动抓取数据，请核对并修复错误。」
//
// 核对结论（`core/recall.js#trustedPlotList` + `core/clock-extract.js#resolveStoryClock`）：
//   v2.51.0「时钟只取最新情节」的实现用 `latestTrustedPlot({ needDate: true })` **只挑一条**节点，
//   并要求这一条**同时**提供 date / time / location。于是：
//     ① **最新情节只有「时间」没写「日期」**（AI 极常见：给了「时间：深夜」却没写「日期」）→ 整条被跳过，
//        时钟退回**次新那条带日期的旧情节**的 date+time+location → 时间不是最新情节的；
//     ② 一条**带日期的情节都没有**时 → `resolveStoryClock` 直接返回空 → **连时间/地点也取不到**，
//        总览只能灰字显示「（参考最近情节：…）」——用户看到的就是「没有从最新情节自动抓取数据」；
//     ③ `storyClockReference()`（灰字参考）用「不带 needDate」的挑法，与取值口径**不一致** →
//        出现「参考最近情节：深夜」与「时间：08:00」自相矛盾；
//     ④ **没有楼层信息**的情节（导入的旧数据 / 删楼后被置为未知区间者，floor 0）按「楼层降序」会被排到最后
//        → 它们的日期/时间**永远取不到**。
//   修法：把「可信情节」抽成**最新在前的列表**（筛选/排序不变），date / time / location **各自**向前找
//   第一条有值的（仍只在情节内）；若一方没有楼层信息，排序改用剧情日期判谁更新；参考值与取值口径统一。
//
// 覆盖：A 逐字段取值；B 无日期情节；C 全无日期；D 参考值与取值一致；E 无楼层情节；F 边界（无情节/降级）。
// 运行：node tests/unit/clock-latest-plot.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    resolveStoryClock, clockAutoExtractOnce, clockExtractState, scheduleClockExtract, setClockTextHooks,
} from '../../core/clock-extract.js';
import { trustedPlotList, latestTrustedPlot, latestPlotByFloor, atomLatestDated } from '../../core/recall.js';
import { clockSectionHtml } from '../../ui/clock.js';

const R = makeReporter('clock-latest-plot v2.98.0 时钟从最新情节逐字段自动抓取');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头。' }] }), doc);

/** 装场景：`atoms` 为情节列表，`seed` 为已有时钟值 */
function boot(atoms, seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:clock-latest');
    setLastMessageId(1);
    const st = emptyState();
    setKernelState(st);
    st.atoms = atoms || [];
    if (seed) Object.assign(st.state, seed);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
    return st;
}
const ATOM = (id, floor, date, time, locs) => ({
    id: id, text: id + ' 的正文足够长。', title: id,
    date: date || '', time: time || '', locations: locs || [],
    floorStart: floor || 0, floorEnd: floor || 0, tags: [], uses: 0,
});
const pick = (r) => ({ date: r.date, time: r.time, location: r.location });

// ---------- A 组：逐字段取「最新的、该字段有值」的情节 ----------
A('A1 最新情节只有**时间**（没写日期）→ 时间取最新那条、日期退到次新那条（修复前整条被跳过：时间仍是旧情节的 08:00）', (() => {
    boot([
        ATOM('旧', 1, '1919-11-20', '08:00', ['码头']),
        ATOM('新', 2, '', '深夜', ['酒馆']),
    ]);
    const r = resolveStoryClock({});
    return J(pick(r)) === J({ date: '1919-11-20', time: '深夜', location: '酒馆' })
        && r.source.date === 'plot' && r.source.time === 'plot' && r.source.location === 'plot';
})(), () => J(pick(resolveStoryClock({}))));

A('A2 最新情节只有**地点**（无日期无时间）→ 地点取最新那条、日期/时间退到次新那条', (() => {
    boot([
        ATOM('旧', 1, '1919-11-20', '08:00', ['码头']),
        ATOM('新', 2, '', '', ['酒馆']),
    ]);
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-20', time: '08:00', location: '酒馆' });
})(), () => J(pick(resolveStoryClock({}))));

A('A3 三条各只带一个字段 → 逐字段各取其最新（日期来自最新带日期的那条、时间来自最新带时间的那条、地点来自最新带地点的那条）', (() => {
    boot([
        ATOM('甲', 1, '1919-11-18', '', []),
        ATOM('乙', 2, '', '傍晚', []),
        ATOM('丙', 3, '', '', ['钟鼓楼']),
    ]);
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-18', time: '傍晚', location: '钟鼓楼' });
})(), () => J(pick(resolveStoryClock({}))));

A('A4 同行内多值仍取**第一条**（最新那条同时有时间和日期时，两者同源 —— 不引入跨条拼接）', (() => {
    boot([
        ATOM('旧', 1, '1919-11-20', '08:00', ['码头']),
        ATOM('新', 2, '1919-11-29', '深夜', ['酒馆']),
    ]);
    const r = resolveStoryClock({});
    return J(pick(r)) === J({ date: '1919-11-29', time: '深夜', location: '酒馆' }) && r.plotFloor === 2;
})(), '');

// ---------- B 组：全无日期（修复前完全取不到） ----------
A('B1 所有情节都没有日期但最新那条有「时间/地点」→ **时间与地点必须取到**（修复前返回空，总览只能灰字显示参考值）', (() => {
    const st = boot([ATOM('新', 2, '', '深夜', ['酒馆'])]);
    const r = resolveStoryClock({});
    const applied = clockAutoExtractOnce();
    return r.date === '' && r.time === '深夜' && r.location === '酒馆'
        && applied === true && st.state.date === '' && st.state.time === '深夜' && st.state.location === '酒馆';
})(), () => J({ r: pick(resolveStoryClock({})), s: { time: state.state.time, loc: state.state.location } }));

A('B2 逐字段取值**不会清空**既有值：某字段所有情节都没有 → 该字段保持原值（沿用旧值，符合「不改动时钟」口径）', (() => {
    const st = boot([ATOM('新', 2, '', '深夜', [])], { date: '1919-11-20', time: '08:00', location: '码头' });
    const changed = clockAutoExtractOnce();
    return changed === true && st.state.time === '深夜' && st.state.date === '1919-11-20' && st.state.location === '码头';
})(), () => J({ d: state.state.date, t: state.state.time, l: state.state.location }));

// ---------- C 组：参考值与取值口径一致（修复前自相矛盾） ----------
A('C1 `storyClockReference()`（总览灰字「参考最近情节」）与 `resolveStoryClock` **同一口径**：时间相同，不再出现「参考：深夜 / 时间：08:00」', (() => {
    const st = boot([
        ATOM('旧', 1, '1919-11-20', '08:00', ['码头']),
        ATOM('新', 2, '', '深夜', ['酒馆']),
    ]);
    clockAutoExtractOnce();
    const html = String(clockSectionHtml() || '');
    // 时间已从最新情节取到 → 总览显示实值，且**不再**出现「参考最近情节」的灰字兜底
    return st.state.time === '深夜' && html.indexOf('⏱ 时间：深夜') >= 0 && html.indexOf('参考最近情节') < 0;
})(), () => String(clockSectionHtml() || '').slice(0, 260));

A('C2 无任何情节时才显示灰字参考，且此时参考值必为空（不会出现「有参考值却没被采用」）', (() => {
    boot([]);
    const html = String(clockSectionHtml() || '');
    return html.indexOf('📅 日期：<span class="ftt-muted">（未记录') >= 0
        && html.indexOf('参考最近情节') < 0;
})(), '');

// ---------- D 组：无楼层信息的情节（导入的旧数据 / 删楼后置为未知区间等） ----------
// 注：面板「➕ 新增/编辑」写入的条目**会**带上当前楼层（`upsertEntry` 用 `getLastMessageId()`），
//   故此组针对的是**真正没有楼层信息**的来源：早期导入的数据、被删楼标记为未知区间的情节等。
A('D1 **没有楼层信息**的情节（floor 0）带更新的日期 → 必须被采纳（修复前按楼层降序排到最后，永远取不到）', (() => {
    boot([
        ATOM('提取', 20, '1919-11-20', '08:00', ['码头']),
        ATOM('手动', 0, '1919-11-29', '深夜', ['酒馆']),
    ]);
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-29', time: '深夜', location: '酒馆' });
})(), () => J(pick(resolveStoryClock({}))));

A('D2 两边都无楼层信息时按剧情日期取新；两边都有楼层信息时**仍以楼层为准**（原口径不变）', (() => {
    boot([ATOM('甲', 0, '1919-11-18', '', []), ATOM('乙', 0, '1919-11-25', '', [])]);
    const noFloor = resolveStoryClock({}).date;
    boot([ATOM('低楼层但日期新', 2, '1919-11-25', '', []), ATOM('高楼层但日期旧', 9, '1919-11-18', '', [])]);
    const byFloor = resolveStoryClock({}).date;
    return noFloor === '1919-11-25' && byFloor === '1919-11-18';
})(), () => J({ noFloor: '1919-11-25', byFloor: '1919-11-18' }));

A('D3 删除楼层后被标记为「未知区间」的情节（floor 0/0 + floorStale）按剧情日期参与竞争（不再无条件沉底）', (() => {
    const stale = ATOM('未知区间', 0, '1919-11-29', '深夜', ['酒馆']);
    stale.floorStale = true;
    boot([ATOM('有楼层', 3, '1919-11-20', '08:00', ['码头']), stale]);
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-29', time: '深夜', location: '酒馆' });
})(), '');

// ---------- E 组：筛选口径不变（唯一可信来源仍是「情节」） ----------
A('E1 排除项照旧：已总结隐藏 / 情节总结条 / 已失效 一律不参与取值（即使它们的日期/时间更新）', (() => {
    const hidden = ATOM('已总结', 30, '2035-01-01', '23:59', ['未来城']); hidden.summarizedBy = 's1';
    const summary = ATOM('总结条', 31, '2035-01-02', '23:59', ['未来城']); summary.mergedSummary = { by: 'auto', sourceCount: 1 };
    const inactive = ATOM('已失效', 32, '2035-01-03', '23:59', ['未来城']); inactive.validity = 'inactive';
    boot([ATOM('可用', 10, '1919-11-22', '傍晚', ['酒馆']), hidden, summary, inactive]);
    const list = trustedPlotList();
    return list.length === 1 && list[0].node.id === '可用'
        && J(pick(resolveStoryClock({}))) === J({ date: '1919-11-22', time: '傍晚', location: '酒馆' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('E2 其它数据类别（记忆/角色/物品/场景…）**仍然完全不参与**时钟取值', (() => {
    const st = boot([ATOM('情节', 1, '1919-11-20', '08:00', ['码头'])]);
    st.memories = [{ id: 'm1', owner: '甲', content: '甲记得', date: '2035-01-01' }];
    st.scenes = [{ id: 's1', name: '未来城', pathStr: '未来城', floorEnd: 99 }];
    st.currentStates = [{ id: 'c1', subject: '甲', field: '位置', value: '未来城' }];
    return J(pick(resolveStoryClock({}))) === J({ date: '1919-11-20', time: '08:00', location: '码头' });
})(), '');

A('E3 历史 API 不回退：`latestTrustedPlot({needDate:true})` 仍是「最新一条**带日期**的情节」（其它调用点行为不变）', (() => {
    boot([ATOM('旧', 1, '1919-11-20', '08:00', []), ATOM('新', 2, '', '深夜', [])]);
    const withDate = latestTrustedPlot({ needDate: true });
    const anyPlot = latestTrustedPlot({});
    return withDate && withDate.node.id === '旧' && anyPlot && anyPlot.node.id === '新';
})(), '');

// ---------- G 组：v3.16.1 拆楼重编号后的「最新情节」口径（用户报告「情节有最新的，但时钟不更新；点修复也没用」） ----------
/** 造一条带「原始楼层 + 当前位置」的情节（拆楼后 floorStart/floorEnd 是原始楼层、floorNow* 是当前位置） */
const ATOM2 = (id, rawFloor, nowFloor, date, time, loc, extra) => Object.assign({
    id: id, text: id + ' 的正文足够长。', title: id,
    date: date || '', time: time || '', locations: loc ? [loc] : [],
    floorStart: rawFloor || 0, floorEnd: rawFloor || 0,
    floorNowStart: nowFloor || 0, floorNowEnd: nowFloor || 0,
    tags: [], uses: 0,
}, extra || {});

A('G1 **拆楼重编号后按「当前位置」排序**：原始 508 楼且 `originGone`（原文已移除）的旧情节，不再压住现在 196 楼的最新情节', (() => {
    const stale = ATOM2('旧', 508, 0, '327-03-15', '', '', { originGone: true });
    const fresh = ATOM2('新', 196, 196, '628-04-28', '上午', '平民集市');
    boot([stale, fresh]);
    const list = trustedPlotList();
    const r = resolveStoryClock({});
    return list.length === 2 && list[0].node.id === '新'
        && J(pick(r)) === J({ date: '628-04-28', time: '上午', location: '平民集市' })
        && r.source.date === 'plot' && r.plotId === '新';
})(), () => J({ order: trustedPlotList().map((x) => x.node.id), got: pick(resolveStoryClock({})) }));

A('G2 `originGone`（原文已移除）降级：活情节永远排在它前面（即使它的原始楼层/日期更新）', (() => {
    const gone = ATOM2('已移除', 900, 900, '700-01-01', '深夜', '未来城', { originGone: true });
    const live = ATOM2('活', 100, 100, '628-01-01', '清晨', '长安城');
    boot([gone, live]);
    const list = trustedPlotList();
    return list[0].node.id === '活' && list[1].node.id === '已移除'
        && J(pick(resolveStoryClock({}))) === J({ date: '628-01-01', time: '清晨', location: '长安城' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('G3 无 `floorNow*` 时口径**完全不变**（纯原始楼层比较，向后兼容）', (() => {
    boot([ATOM('低', 10, '1919-11-20', '08:00', ['码头']), ATOM('高', 20, '1919-11-21', '傍晚', ['酒馆'])]);
    const list = trustedPlotList();
    return list[0].node.id === '高' && list[1].node.id === '低'
        && J(pick(resolveStoryClock({}))) === J({ date: '1919-11-21', time: '傍晚', location: '酒馆' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

A('G4 `latestPlotByFloor()`（在场角色来源）同样按当前位置 + 活情节优先，取到的是当前现场', (() => {
    const stale = ATOM2('旧', 508, 0, '327-03-15', '下午', '昆仑山深处', { originGone: true });
    const fresh = ATOM2('新', 196, 196, '628-04-28', '上午', '平民集市');
    fresh.entities = ['李瑶'];
    boot([stale, fresh]);
    const p = latestPlotByFloor();
    return p && p.node.id === '新' && p.date === '628-04-28' && p.time === '上午' && p.location === '平民集市'
        && J(p.entities) === J(['李瑶']);
})(), () => J(latestPlotByFloor()));

A('G5 `atomLatestDated()`（快照参考时钟）也优先**活情节**：旧聊天残留的高楼层/未来日期不再胜出', (() => {
    const staleFuture = ATOM2('旧未来', 900, 900, '628-12-31', '深夜', '旧城', { originGone: true });
    const live = ATOM2('活', 196, 196, '628-04-28', '上午', '平民集市');
    boot([staleFuture, live]);
    const n = atomLatestDated();
    return n && n.node && n.node.id === '活' && n.date === '628-04-28';
})(), () => J(atomLatestDated() && atomLatestDated().node && atomLatestDated().node.id));

// ---------- F 组：调度与落盘不回归 ----------
A('F1 `scheduleClockExtract()` 1.8s 防抖后落盘逐字段结果（消息后自动同步链路可用）', (() => {
    const st = boot([ATOM('旧', 1, '1919-11-20', '08:00', ['码头']), ATOM('新', 2, '', '深夜', ['酒馆'])]);
    const timers = [];
    setTimerHooks({ set: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; }, clear: () => { } });
    const fired = scheduleClockExtract();
    timers.forEach((t) => { if (t.ms === 1800) t.fn(); });
    setTimerHooks({ set: (fn, ms) => setTimeout(fn, Math.max(0, Number(ms) || 0)), clear: (id) => { try { clearTimeout(id); } catch (e) { /* 忽略 */ } } });
    return fired === true && st.state.time === '深夜' && clockExtractState() && clockExtractState().source.time === 'plot';
})(), () => J({ fired: true, t: state.state.time }));

R.done();
