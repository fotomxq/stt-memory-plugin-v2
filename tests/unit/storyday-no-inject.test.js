// ============================================================
// 单元测试 · v2.48.0「剧情第 N 天**不允许注入**」（用户要求；**V1 故障明确修正 #6**）
// 用户原话：「剧情第N天，不允许注入，这个设定只是在插件内校准时间用的。」
//
// 事实：V1 v1.206（11943）把 `剧情天数:第N天` 拼进注入体的 `[当前状态]` 块 → AI 每轮都能看到这个
//   **插件内部计数**（既非剧情正文、也不可被故事解释），既占预算又可能被 AI 写进正文。
//   该值的唯一用途是**插件内时间校准**：正文头 `▶第 N 天` 解析出天数，设定 `clockStoryDayEpoch`（纪元首日）
//   时按「纪元首日 + (N-1) 天」换算成**日期**（见 core/clock-extract.js 的 `storyday` 分支）。
//
// oracle：`tests/fixtures/v1-golden-storyday-inject.json`（生成器 `gen-v1-golden-storyday-inject.cjs`，真实 V1 v1.206，
//   两次运行逐字节一致）—— A 组固化「V1 确实注入了它」，B/C 组固化「内部校准照常工作」。
// 覆盖：
//   O 组：oracle 自证（V1 注入体含该行；V1 在设纪元首日后能把天数换成日期）；
//   N 组：**V2 注入体不含「剧情天数 / 第N天」**（多种 state 组合：仅 storyDay、storyDay+日期、含在场角色）；
//   P 组：注入体**其余** `[当前状态]` 行与 V1 一致（日期/时间/地点/在场角色；顺序：日期 → 时间 → 地点 → 在场）；
//   C 组：**内部校准不受影响** —— `resolveStoryClock` 仍记 `storyDay`，设纪元首日后日期 = 纪元首日 + (N-1) 天；
//   U 组：总览仍展示该值，但明确标注「校准用 · 不注入」。
// 运行：node tests/unit/storyday-no-inject.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { resolveStoryClock, setClockTextHooks, clockAutoExtractOnce } from '../../core/clock-extract.js';
import { panelBodyHtml } from '../../ui/panel.js';
import { debugLogPush, wireDebugLog } from '../../adapters/debug-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-storyday-inject.json'), 'utf8'));
const R = makeReporter('storyday-no-inject v2.48.0 剧情第 N 天不允许注入');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const STORY_DAY = Number(G.meta.storyDay) || 500;
const EPOCH = String(G.meta.epoch || '1919-11-01');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
setChatHooks({ latestAiFloorText: () => '', dbgLog: (k, d) => debugLogPush(k, d) });

function boot(statePatch, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false;
    cfg.clockAutoPatrol = false; cfg.clockForceDegrade = false;
    cfg.injectConstraintBlock = false;
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        atoms: [{ id: 'a1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: ['码头'] }],
        state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'] },
    }, clone(statePatch || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
}
const bodyOf = (opts) => {
    try { return String((buildMemoryBodyForInject('', Object.assign({ diagnose: true }, opts || {})) || {}).bodyText || ''); } catch (e) { return 'ERR:' + String(e.message); }
};
const hasStoryDay = (t) => /剧情天数|第\s*\d+\s*天/.test(String(t || ''));

// ---------- O 组：oracle 自证 ----------
A('O1 oracle 自证：**V1 确实把「剧情天数:第N天」注入了**（`[当前状态]` 块内，用户要求禁止）', (() => {
    return G.A.bodyHasStoryDay === true && String(G.A.storyDayLine).indexOf('第' + STORY_DAY + '天') >= 0
        && (G.A.stateLines || []).indexOf('剧情天数:第' + STORY_DAY + '天') >= 0
        && (G.A.bodyHead || []).indexOf('剧情天数:第' + STORY_DAY + '天') >= 0;
})(), J(G.A));

A('O2 oracle 自证：该值的**真正用途**是内部校准 —— 设 `clockStoryDayEpoch` 后「第 500 天」换算成日期', (() => {
    return G.C.epoch === EPOCH && Number(G.C.storyDay) === STORY_DAY && G.C.date === '1921-03-14'
        && G.C.source && G.C.source.date === 'storyday'
        && G.B.date === null && Number(G.B.storyDay) === STORY_DAY;      // 未设纪元首日 → 只记天数
})(), J({ B: G.B, C: G.C }));

// ---------- N 组：V2 不再注入 ----------
A('N1 V2 注入体**不含**「剧情天数 / 第N天」（仅 storyDay 时）', (() => {
    boot({ state: { date: '', time: '', location: '', storyDay: STORY_DAY } });
    const b = bodyOf();
    return b.length > 0 && !hasStoryDay(b);
})(), (() => { boot({ state: { date: '', time: '', location: '', storyDay: STORY_DAY } }); return J(bodyOf()); })());

A('N2 日期/时间/地点/在场齐全时同样不含（与 V1 样本同 state，唯一差别就是少了那一行）', (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY } });
    const b = bodyOf();
    const lines = b.split('\n');
    return !hasStoryDay(b) && lines.indexOf('日期:1919-11-25') >= 0 && lines.indexOf('时间:傍晚') >= 0
        && lines.indexOf('地点:城市甲·码头') >= 0 && lines.indexOf('[当前状态]') >= 0;
})(), (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY } });
    return J(bodyOf().split('\n').slice(0, 8));
})());

A('N3 注入体的 `[当前状态]` 行顺序与 V1 一致：日期 → 时间 → 地点 → 在场角色（**没有**天数行）', (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', timeEnd: '19:30', location: '城市甲·码头', present: ['甲', '乙'], storyDay: STORY_DAY } });
    const b = bodyOf({ inject: true });
    const idx = (s) => b.indexOf(s);
    return idx('日期:') >= 0 && idx('日期:') < idx('时间:') && idx('时间:') < idx('地点:') && idx('地点:') < idx('在场角色')
        && b.indexOf('时间:傍晚→19:30') >= 0 && !hasStoryDay(b);
})(), (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', timeEnd: '19:30', location: '城市甲·码头', present: ['甲', '乙'], storyDay: STORY_DAY } });
    return J(bodyOf({ inject: true }).split('\n').slice(0, 8));
})());

A('N4 世界书/约束段等同族文本也不得出现「第 N 天」（同一注入体全文扫描）', (() => {
    boot({ state: { date: '1919-11-25', storyDay: STORY_DAY } }, { injectConstraintBlock: true, injectConstraintPosition: 'tail' });
    const b = bodyOf();
    return b.indexOf('[当前状态]') >= 0 && !hasStoryDay(b) && b.indexOf('甲把铜箱交给乙。') >= 0;
})(), (() => {
    boot({ state: { date: '1919-11-25', storyDay: STORY_DAY } }, { injectConstraintBlock: true, injectConstraintPosition: 'tail' });
    return J({ head: bodyOf().split('\n').slice(0, 6), hasStoryDay: hasStoryDay(bodyOf()) });
})());

// ---------- P 组：V1 的其余行原样保留 ----------
A('P1 V1 样本里除「剧情天数」外的 `[当前状态]` 行，V2 逐条保留（不因移除而误删别的字段）', (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY } });
    const lines = bodyOf({ inject: true }).split('\n');
    const v1Lines = (G.A.stateLines || []).filter((l) => l.indexOf('剧情天数') < 0);
    const missing = v1Lines.filter((l) => lines.indexOf(l) < 0);
    return v1Lines.length >= 3 && missing.length === 0;
})(), (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY } });
    return J({ v2: bodyOf({ inject: true }).split('\n').slice(0, 6), v1: G.A.stateLines });
})());

// ---------- C 组：内部校准不受影响 ----------
A('C1 内部仍记录 `state.state.storyDay`（解析 `▶第 N 天` → 自动提取落盘）', (() => {
    boot({ state: { date: '', time: '', location: '', storyDay: 0 }, atoms: [] });
    cfg.clockExtractEnabled = true;
    const r = resolveStoryClock({ text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    const ok = clockAutoExtractOnce({ force: true, text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    return Number(r.storyDay) === STORY_DAY && Number(state.state.storyDay) === STORY_DAY && ok === true
        && hasStoryDay('剧情天数:第' + STORY_DAY + '天') === true;      // 内部值照旧存在（只是不进注入）
})(), (() => {
    boot({ state: { date: '', time: '', location: '', storyDay: 0 }, atoms: [] });
    const r = resolveStoryClock({ text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    return J({ storyDay: r.storyDay, stateStoryDay: state.state.storyDay });
})());

A('C2 设 `clockStoryDayEpoch` 后「天数 → 日期」校准与 V1 一致（纪元首日 + (N-1) 天）', (() => {
    boot({ state: { date: '', time: '', location: '', storyDay: 0 }, atoms: [] });
    cfg.clockStoryDayEpoch = EPOCH;
    const r = resolveStoryClock({ text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    const r2 = resolveStoryClock({ text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    return r.date === G.C.date && r.source.date === 'storyday'
        && r2.date === G.C.date && Number(r2.storyDay) === STORY_DAY;
})(), (() => {
    boot({ state: { date: '', time: '', location: '', storyDay: 0 }, atoms: [] });
    cfg.clockStoryDayEpoch = EPOCH;
    const r = resolveStoryClock({ text: '▶第 ' + STORY_DAY + ' 天 08:52->09:05(赶路)' });
    return J({ date: r.date, source: r.source, want: G.C });
})());

// ---------- U 组：总览展示（允许）但标注「校准用 · 不注入」 ----------
A('U1 总览仍展示该值，但标签明确「校准用：…（仅用于日期换算，不注入）」', (() => {
    boot({ state: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: STORY_DAY } });
    const html = String(panelBodyHtml('overview') || '');
    return html.indexOf('📆 校准用：剧情第 ' + STORY_DAY + ' 天') >= 0 && html.indexOf('仅用于日期换算，不注入') >= 0;
})(), (() => {
    boot({ state: { date: '1919-11-25', storyDay: STORY_DAY } });
    const h = String(panelBodyHtml('overview') || '');
    const at = h.indexOf('📆 校准用');
    return J(h.slice(at, at + 90));
})());

un();
R.done();
