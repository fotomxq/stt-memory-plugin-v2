// ============================================================
// 单元测试 · v2.61.0「提取记忆：第一步先校对时钟等基本信息，然后再去提取」
//
// 用户要求：「提取记忆优化，**第一步先校对时钟等基本信息**，然后再去提取。」
//
// 目标链路（本测试逐项锁定）：
//   ① 校对：`host/preflight.js#calibrateBasics()` —— 从**最新一条非总结情节**（时钟唯一可信来源）解析并落盘
//      `state.state.{date,time,location,present}`，尊重「消息后自动同步时钟」开关（关闭则如实跳过，不擅自覆盖）；
//   ② 前置：把【基本信息 · 提取前已校对】（日期/时间/地点/在场角色）前置到提取提示词的 user 消息
//      —— `core/prompt.js#buildSummaryPrompt` 本身**保持 V1 逐字不动**（黄金样本 `extract-prompt-flow` P1 继续保护）；
//   ③ 提取：AI 抽取 → 合并落库；新条目缺日期时按 V1 口径用**已校对**的剧情日期补齐；
//   ④ 留痕：`lastExtractRecord().calib` 与 `lastPreflightInfo()` 给出「是否变化 / 跳过原因 / 时钟值」，
//      总览「📤 最后一次提取」一行显示「🕒 已校对 … / 时钟未变 … / 未校对（原因）」。
// 运行：node tests/unit/extract-preflight.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { defaultCfg } from '../../core/config.js';
import { entryIndexInit, entryIndexBuild } from '../../core/sweep.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { calibrateBasics, withBasics, preflightInfo } from '../../host/preflight.js';
import { analyzeFloor, analyzeSegment, lastExtractRecord, lastPreflightInfo } from '../../host/extract.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';

const R = makeReporter('extract-preflight v2.61.0 提取前校对时钟等基本信息');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
const host = makeHost({});
installGlobalHost(host, doc);
setScopeKey('char:preflight-test');
setPersistHooks({
    saveState: () => { entryIndexInit(); entryIndexBuild(true); return true; },
    saveCfg: () => true, log: () => undefined, warn: () => undefined,
});
globalThis.window = Object.assign({}, globalThis.window, { localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true } });

/** 造场景：一条最新情节（唯一可信来源）+ 一楼正文 */
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setKernelState(emptyState());
    if (o.plot !== false) {
        state.atoms = [{
            id: 'pf-plot', text: '甲在码头卸货。', date: '1919-11-29', time: '08:52', location: '凉州卫-钟鼓楼',
            floorStart: 1, floorEnd: 1, tags: [], validity: 'active', uses: 1, characters: ['甲'],
        }];
    }
    host.ctx.chat = [{ is_user: true, mes: '你好', name: 'User' }, { is_user: false, mes: o.text || '甲把铜箱搬上船，铜箱里是账册。', name: '角色甲' }];
    setLastMessageId(1);
    entryIndexInit(); entryIndexBuild(true);
}
const clock = () => ({ date: state.state.date, time: state.state.time, location: state.state.location });

// ---- C 组：校对本身 ----
A('C1 有最新情节 → 校对成功：时钟落盘 + 基本信息文本（日期/时间/地点）+ note「已校对」', (() => {
    boot({});
    const c = calibrateBasics({ text: '甲在码头卸货。' });
    return c.ok === true && c.changed === true
        && c.clock.date === '1919-11-29' && c.clock.time === '08:52' && c.clock.location === '凉州卫-钟鼓楼'
        && clock().date === '1919-11-29' && clock().time === '08:52' && clock().location === '凉州卫-钟鼓楼'
        && c.text.indexOf('【基本信息 · 提取前已校对】') === 0
        && c.text.indexOf('【当前剧情日期】1919-11-29') >= 0
        && c.text.indexOf('【当前时间】08:52') >= 0
        && c.text.indexOf('【当前地点】凉州卫-钟鼓楼') >= 0
        && c.note.indexOf('已校对：') === 0 && c.skipped === '';
})(), (() => { const c = calibrateBasics({}); return J({ ok: c.ok, changed: c.changed, note: c.note, text: c.text }); })());

A('C2 第二次校对 → 「时钟无变化」且不再改写（幂等）', (() => {
    boot({});
    calibrateBasics({});
    const c2 = calibrateBasics({});
    return c2.ok === true && c2.changed === false && c2.note.indexOf('时钟无变化：') === 0;
})(), '见断言');

A('C3 完全没有可用情节与时钟 → 如实报「无可校对信息」，不猜、不造值', (() => {
    boot({ plot: false });
    const c = calibrateBasics({});
    return c.ok === false && c.text === '' && c.note.indexOf('无可校对信息') === 0 && clock().date === '';
})(), (() => { const c = calibrateBasics({}); return J({ ok: c.ok, note: c.note }); })());

A('C3b 无新情节但已有时钟 → 基本信息仍用**当前时钟**（不清空、不臆造），标注「时钟无变化」', (() => {
    boot({ plot: false });
    state.state.date = '1900-01-01';       // 已有旧值：校对不应清空它
    const c = calibrateBasics({});
    return c.ok === true && c.changed === false && c.note.indexOf('时钟无变化：1900-01-01') === 0
        && c.text.indexOf('【当前剧情日期】1900-01-01') >= 0 && clock().date === '1900-01-01';
})(), (() => { const c = calibrateBasics({}); return J({ ok: c.ok, note: c.note, text: c.text }); })());

A('C4 关闭「消息后自动同步时钟」→ 跳过校对并如实说明（不擅自覆盖用户时钟）', (() => {
    boot({});
    cfg.clockExtractEnabled = false;
    const c = calibrateBasics({});
    return c.skipped === 'auto-off' && c.changed === false && clock().date === ''
        && c.note.indexOf('校对已跳过') === 0 && c.note.indexOf('自动同步时钟') > 0;
})(), '见断言');

A('C5 组件整体关闭（enabled=false）→ 跳过校对且不写时钟', (() => {
    boot({});
    cfg.enabled = false;
    const c = calibrateBasics({});
    return c.skipped === 'disabled' && clock().date === '' && c.note.indexOf('组件未启用') > 0;
})(), '见断言');

A('C6 withBasics：把基本信息前置到最后一条 user 消息（无 user 消息时前置到末条），不改 role/条数', (() => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
    const out = withBasics(msgs, { text: '【基本信息 · 提取前已校对】\n【当前剧情日期】1919-11-29' });
    const single = withBasics([{ role: 'system', content: 'S' }], { text: 'B' });
    const none = withBasics(msgs, null);
    return out.length === 2 && out[0].content === 'S' && out[1].content.indexOf('【基本信息') === 0 && out[1].content.indexOf('U') > 0
        && J(msgs) === J([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])   // 不改原数组
        && single[0].content.indexOf('B') === 0 && none[1].content === 'U';
})(), '见断言');

A('C7 内核提示词构造器**未被改动**（V1 逐字）：`buildSummaryPrompt` 输出里没有「基本信息」块（前置由 host 完成）', (async () => {
    boot({});
    const msgs = await buildSummaryPrompt('【第1楼 AI】正文', ['atoms']);
    return msgs.length === 2 && msgs[0].role === 'system'
        && String(msgs[0].content).indexOf('基本信息') < 0 && String(msgs[1].content).indexOf('基本信息') < 0;
})(), '见断言');

// ---- E 组：提取链路（先校对 → 再提取） ----
await (async () => {
    boot({});
    let seenPrompt = '', clockAtAiTime = null;
    const delta = { atoms: { add: [{ text: '甲把铜箱搬上船。', floorStart: 1, floorEnd: 1 }] }, memories: { add: [{ owner: '甲', title: '铜箱', content: '已上船。' }] } };
    const r = await analyzeFloor(1, { ai: async (args) => { seenPrompt = String(args.prompt || ''); clockAtAiTime = clock(); return { ok: true, text: JSON.stringify(delta) }; } });
    A('E1 单楼提取：AI 调用前时钟已校对（回调里读到的就是校对值），且提示词里带【基本信息 · 提取前已校对】', r.ok === true
        && clockAtAiTime && clockAtAiTime.date === '1919-11-29' && clockAtAiTime.time === '08:52'
        && seenPrompt.indexOf('【基本信息 · 提取前已校对】') >= 0
        && seenPrompt.indexOf('【当前剧情日期】1919-11-29') >= 0
        && seenPrompt.indexOf('【当前地点】凉州卫-钟鼓楼') >= 0,
        J({ ok: r.ok, clockAtAiTime, head: seenPrompt.slice(0, 80) }));

    A('E2 新条目继承**已校对**的剧情日期（V1 口径：缺日期用 storyNow 补齐）', (() => {
        const atom = (state.atoms || []).filter((a) => a.text === '甲把铜箱搬上船。')[0];
        const mem = (state.memories || []).filter((m) => m.title === '铜箱')[0];
        return !!atom && atom.date === '1919-11-29' && !!mem && mem.date === '1919-11-29';
    })(), J((state.atoms || []).map((a) => a.date)));

    A('E3 留痕：`lastExtractRecord().calib` 与 `lastPreflightInfo()` 同源（含 changed/note/clock）', (() => {
        const rec = lastExtractRecord();
        const pf = lastPreflightInfo();
        return !!rec && !!rec.calib && rec.calib.clock && rec.calib.clock.date === '1919-11-29'
            && typeof rec.calib.changed === 'boolean' && String(rec.calib.note || '').length > 0
            && !!pf && String(pf.note || '').length > 0 && pf.clock.date === '1919-11-29';
    })(), J({ rec: lastExtractRecord() && lastExtractRecord().calib, pf: lastPreflightInfo() && lastPreflightInfo().note }));

    boot({});
    let segPrompt = '';
    const seg = await analyzeSegment(1, 2, { ai: async (args) => { segPrompt = String(args.prompt || ''); return { ok: true, text: JSON.stringify(delta) }; } });
    A('E4 分段提取：同样先校对再提取（与单楼同一套顺序）', seg.ok === true
        && segPrompt.indexOf('【基本信息 · 提取前已校对】') >= 0
        && lastExtractRecord().via === 'segment' && lastExtractRecord().calib.clock.time === '08:52',
        J({ ok: seg.ok, via: lastExtractRecord().via }));

    boot({});
    cfg.clockExtractEnabled = false;
    let offPrompt = '';
    const off = await analyzeFloor(1, { ai: async (args) => { offPrompt = String(args.prompt || ''); return { ok: true, text: JSON.stringify(delta) }; } });
    A('E5 关闭自动同步时：提取照常进行，但**不前置**基本信息，并如实记录「未校对（原因）」', off.ok === true
        && offPrompt.indexOf('【基本信息 · 提取前已校对】') < 0
        && lastExtractRecord().calib.skipped === 'auto-off',
        J({ ok: off.ok, skipped: lastExtractRecord().calib.skipped }));
})();

// ---- U 组：总览可见 ----
await (async () => {
    boot({});
    await analyzeFloor(1, { ai: async () => ({ ok: true, text: JSON.stringify({ atoms: { add: [{ text: '甲在码头卸货并搬箱。', floorStart: 1, floorEnd: 1 }] } }) }) });
    setPanelHooks2({ lastExtract: () => lastExtractRecord(), busy: () => false, batchProgress: () => ({}) });
    openPanel('overview');
    const h = panelBodyHtml('overview');
    const line = (h.match(/data-ftt-last-extract-line>([^<]*)</) || [])[1] || '';
    A('U1 总览「最后一次提取」显示校对结果（🕒 已校对 / 时钟未变 + 日期时间与地点）', h.indexOf('data-ftt-last-extract') >= 0
        && /🕒 (已校对|时钟未变) 1919-11-29 08:52/.test(line) && line.indexOf('凉州卫-钟鼓楼') > 0,
        J(line));

    boot({});
    cfg.clockExtractEnabled = false;
    await analyzeFloor(1, { ai: async () => ({ ok: true, text: JSON.stringify({ atoms: { add: [{ text: '关闭自动同步下的提取。', floorStart: 1, floorEnd: 1 }] } }) }) });
    openPanel('overview');
    const line2 = (panelBodyHtml('overview').match(/data-ftt-last-extract-line>([^<]*)</) || [])[1] || '';
    A('U2 未校对时如实标注（「🕒 未校对（时钟自动同步已关）」），不假装校对过', line2.indexOf('🕒 未校对（时钟自动同步已关）') > 0, J(line2));
})();

A('P1 preflightInfo 只读诊断：给出自动同步开关与当前时钟（设置页/排障用）', (() => {
    boot({});
    const i1 = preflightInfo();
    cfg.clockExtractEnabled = false;
    const i2 = preflightInfo();
    return i1.autoClockOn === true && i2.autoClockOn === false && typeof i1.clock === 'object';
})(), J(preflightInfo()));

R.done();
