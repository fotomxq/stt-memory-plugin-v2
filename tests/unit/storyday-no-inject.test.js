// ============================================================
// 单元测试 · v2.51.0「第 N 天」= 原子数据**保留字段**（用户设计说明）
// 用户要求：
//   ① 「剧情第N天，不允许注入，这个设定只是在插件内校准时间用的」（v2.48.0）；
//   ② 后续澄清：该计数器是「原子数据兼容任意时间格式预留的天数计数器」，**设计需保留**，
//      但**不与时钟联动、也不参与注入**（v2.51.0：连「纪元首日换算」设定也一并删除）。
// 因此本文件断言：
//   R 组：保留字段被正确记录在**情节条目**上（`▶第 N 天`），且 `state.state.storyDay` **不被写入**；
//   N 组：注入体里**没有**「剧情天数 / 第 N 天」；时钟也不读它（时钟只取情节的 date/time/location）；
//   S 组：`clockStoryDayEpoch` 设定已删除（默认配置无该键、设定页无该控件、总览无「剧情第 N 天」行）。
// 运行：node tests/unit/storyday-no-inject.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { resolveStoryClock, clockAutoExtractOnce, setClockTextHooks } from '../../core/clock-extract.js';
import { panelBodyHtml } from '../../ui/panel.js';
import { settingsPageHtml, SETTINGS_CONTROLS } from '../../ui/settings-pages.js';
import { debugLogPush, wireDebugLog } from '../../adapters/debug-log.js';

const R = makeReporter('storyday v2.51.0 「第 N 天」保留字段（不联动时钟、不注入）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const STORY_DAY = 500;
const HEADER = '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路) 甲走进码头。';

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
setChatHooks({ latestAiFloorText: () => '', dbgLog: (k, d) => debugLogPush(k, d) });

function boot(text) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'a1', text: String(text || HEADER), date: '1919-11-20', time: '傍晚', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }],
        state: { date: '', time: '', location: '', present: [] },
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setClockTextHooks({ latestAiText: () => HEADER, floorWindowText: () => HEADER });
}
const bodyOf = () => {
    try { return String((buildMemoryBodyForInject('', { diagnose: true, inject: true }) || {}).bodyText || ''); } catch (e) { return 'ERR:' + String(e.message); }
};

// ---------- R 组：保留字段记录在情节上 ----------
A('R1 「▶第 N 天」被记为该情节的**保留字段** `storyDay`（不换算日期、不写 state.state.storyDay）', (() => {
    boot();
    const ok = clockAutoExtractOnce({ force: true });
    const a = (state.atoms || [])[0] || {};
    return ok === true && Number(a.storyDay) === STORY_DAY && state.state.storyDay === undefined;
})(), (() => { boot(); clockAutoExtractOnce({ force: true }); return J({ atom: state.atoms[0] && state.atoms[0].storyDay, stateStoryDay: state.state.storyDay }); })());

A('R2 时钟与保留字段无关：时钟只取情节的 `date/time/location`（`▶第 N 天` 本身不影响日期）', (() => {
    boot('▶第 500 天 08:52->09:05(赶路) 甲走进码头。');
    state.atoms[0].date = '1919-11-20';
    const r = resolveStoryClock();
    const a = state.atoms[0];
    return r.date === '1919-11-20' && r.source.date === 'plot' && a.storyDay === undefined;
})(), (() => { boot(); const r = resolveStoryClock(); return J({ date: r.date, source: r.source }); })());

A('R3 保留字段随存档往返（不参与时钟/注入判定，也不被清洗掉）', (() => {
    boot();
    clockAutoExtractOnce({ force: true });
    const a = state.atoms[0];
    const again = clone(a);
    return Number(again.storyDay) === STORY_DAY && Number(a.storyDay) === STORY_DAY;
})(), '');

// ---------- N 组：不注入 ----------
A('N1 注入体**不含**「剧情天数 / 第 N 天」（保留字段不进注入）', (() => {
    boot();
    clockAutoExtractOnce({ force: true });
    const b = bodyOf();
    // 只约束**时钟状态块**：情节正文里出现「第 500 天」是剧情原文，不算注入计数
    const stateBlock = b.split('\n\n')[0] || '';
    return b.length > 0 && b.indexOf('剧情天数') < 0 && !/第\s*\d+\s*天/.test(stateBlock);
})(), (() => { boot(); clockAutoExtractOnce({ force: true }); return J(bodyOf().split('\n').slice(0, 6)); })());

A('N2 注入体的 `[当前状态]` 只有 日期/时间/地点/在场角色（顺序不变）', (() => {
    boot();
    state.state = { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'] };
    const lines = bodyOf().split('\n');
    const idx = (s) => lines.indexOf(s);
    return idx('日期:1919-11-25') >= 0 && idx('日期:1919-11-25') < idx('时间:傍晚')
        && idx('时间:傍晚') < idx('地点:城市甲·码头') && idx('地点:城市甲·码头') < idx('在场角色：甲');
})(), (() => { boot(); state.state = { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'] }; return J(bodyOf().split('\n').slice(0, 6)); })());

// ---------- S 组：设定与总览不留废弃内容 ----------
A('S1 `clockStoryDayEpoch`（纪元首日换算）设定已删除：默认配置无该键、设定页无该控件', (() => {
    const hasCfg = 'clockStoryDayEpoch' in defaultCfg;
    const baseKeys = (SETTINGS_CONTROLS.base || []).map((c) => String(c.key));
    const h = String(settingsPageHtml('base') || '');
    return hasCfg === false && baseKeys.indexOf('clockStoryDayEpoch') < 0 && h.indexOf('纪元首日') < 0;
})(), Object.keys(defaultCfg).filter((k) => /^clock/.test(k)));

A('S2 总览**不再**显示「剧情第 N 天」行（该值只作数据保留，不呈现在时钟区）', (() => {
    boot();
    clockAutoExtractOnce({ force: true });
    const h = String(panelBodyHtml('overview') || '');
    return h.indexOf('剧情第 ') < 0 && h.indexOf('校准用') < 0 && h.indexOf('📅 日期：') >= 0;
})(), (() => { boot(); clockAutoExtractOnce({ force: true }); const h = String(panelBodyHtml('overview') || ''); const i = h.indexOf('📆'); return J(i >= 0 ? h.slice(i, i + 80) : '（无 📆 行）'); })());

A('S3 设定页时钟分节按新设计（只取最新情节），且不含「正文正则/相对日期/降级」等废弃提示', (() => {
    const h = String(settingsPageHtml('base') || '');
    const gone = ['强制使用降级方案', '日期异常判定', '自定义 · 日期正则', '相对日期推进', '标记式（【时间：】'];
    return h.indexOf('最新一条「情节」') >= 0 && gone.every((t) => h.indexOf(t) < 0);
})(), '');

un();
R.done();
