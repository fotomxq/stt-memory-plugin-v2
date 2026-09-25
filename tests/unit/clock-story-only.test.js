// ============================================================
// 单元测试 · v2.39.0「时钟不得取真实日期（必须与剧情对齐）」
// 背景（用户要求）：「时钟缺陷，V1 修复过该问题，V2 必须对齐。即时钟不能取真实日期，必须和剧情对齐。」
// V1 的口径（其文档原文，`docs/03-数据模型与存储.md` / `docs/11`）：
//   「剧情时钟未知（`state.state.date` 为空）时**不折算**（不写现实时间，沿用 v1.161 口径）；**现实墙钟不进注入正文**」
//   「**绝不退回现实日期**（现实时间不是剧情时间）」。
// V1 的实际漏洞（本批修正，**V1 缺陷 #4**）——`stampNowForState()` 在无剧情日期时回退 `new Date()`，
//   把现实日期写进 **`memories[].date`** 与 **`currentStates[].updatedAt/updatedAtTime`**（剧情时间字段），
//   并经注入体发给 AI（`- [2026-09-25]记忆甲：…`）。oracle 证据见 tests/fixtures/v1-golden-clock-story-only.json。
// 覆盖：
//   O 组：V1 oracle 自证（无剧情日期 → V1 写现实日期并进入注入体；有剧情日期 → 写剧情日期）；
//   V 组：V2 修正后 —— 无剧情日期**留空**（绝不写现实日期/年份），有剧情日期与 V1 **逐字一致**；
//   I 组：注入体里不出现现实日期（无剧情时钟场景）；有剧情时钟时注入仍带剧情日期 + 相对时间；
//   S 组：同族守卫复核（手工录入缺年份且无可用年份 → 拒绝；巡检无可信锚点 → 不改；AE 修复无锚点 → 不调用）；
//   U 组：现实墙钟只以「现实更新 …」标注出现在 UI（平行事件行），不与 📅 剧情日期混同。
// 运行：node tests/unit/clock-story-only.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { mergeDelta } from '../../core/ingest.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { stampNowForState, stampSnapshotTime } from '../../core/model/snapshot.js';
import { parseClockManualInput, clockPatrolAnchorInfo, clockPatrolRepairItem } from '../../core/clock-patrol.js';
import { panelBodyHtml } from '../../ui/panel.js';
import * as recallMod from '../../core/recall.js';
import { debugLogPush, wireDebugLog } from '../../adapters/debug-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-clock-story-only.json'), 'utf8'));
const R = makeReporter('clock-story-only v2.39.0 时钟不得取真实日期');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const NOW = new Date();
const pad = (x) => String(x).padStart(2, '0');
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
const YEAR = String(NOW.getFullYear());
/** 与 oracle 生成器相同的归一：现实日期/年 → 占位符 */
const norm = (s) => String(s == null ? '' : s).split(TODAY).join('<TODAY>').split(YEAR).join('<YEAR>');

const doc = makeDocument(['extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
setChatHooks({ latestAiFloorText: () => '', dbgLog: (k, d) => debugLogPush(k, d) });

function boot(date) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false; cfg.clockAutoPatrol = false;
    setScopeKey('甲'); setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), { state: { date: date || '', time: date ? '傍晚' : '', location: '', present: [] } }));
    setPersistHooks({ saveState: () => { entryIndexBuild(true); tombstoneSweep(); return true; }, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    entryIndexInit();
    return state;
}
const writeOne = (title) => mergeDelta({ memories: { add: [{ title, content: '甲在码头清点铜箱' }] }, states: { add: [{ subject: title, field: '体力', value: '疲惫' }] } });
const memDates = () => (state.memories || []).map((m) => norm(m.date));
const stateDates = () => (state.currentStates || []).map((s) => [norm(s.updatedAt), norm(s.updatedAtTime)]);

// ---------- O 组：V1 oracle 自证 ----------
A('O1 V1 oracle 自证：**无剧情日期**时 V1 把现实日期写进 memories[].date 与 states[].updatedAt/updatedAtTime，并进入注入体（`- [<TODAY>]记忆甲…`）', (() => {
    return G.meta.v1Version === 'v1.206'
        && G.A.memories[0].date === '<TODAY>' && G.A.states[0].updatedAt === '<TODAY>' && G.A.states[0].updatedAtTime === '<NOW>'
        && G.A.injectMemoryLines[0].indexOf('- [<TODAY>]记忆甲') === 0
        // 现实年份还会反向污染「手工录入缺年份」的可用年份来源（原子数据多数派）
        && G.A.majorityYear.year === '<YEAR>' && G.A.manualYearless.ok === true && G.A.manualYearless.date === '<YEAR>-11-29';
})(), G.A);

A('O2 V1 oracle：**有剧情日期**时 V1 写的是剧情日期与剧情时刻（V2 必须逐字保持一致），注入体带「日期（今天）」相对时间', (() => {
    return G.B.memories[0].date === '1919-11-20' && G.B.states[0].updatedAt === '1919-11-20' && G.B.states[0].updatedAtTime === '傍晚'
        && G.B.injectMemoryLines[0].indexOf('- [1919-11-20（今天）]记忆乙') === 0;
})(), G.B);

// ---------- V 组：V2 修正 ----------
A('V1 无剧情日期：`stampNowForState()` 返回空（不再回退现实墙钟），`memories[].date` 与 `states[].updatedAt/updatedAtTime` **留空**', (() => {
    boot('');
    const st = stampNowForState();
    const emptyOk = st.date === '' && st.time === '';
    writeOne('记忆甲');
    const mem = memDates();
    const states0 = stateDates();
    const noToday = mem.every((d) => d.indexOf(YEAR) < 0 && d.indexOf(TODAY) < 0)
        && states0.every(([d, t]) => d.indexOf(YEAR) < 0 && d.indexOf(TODAY) < 0 && t.indexOf(String(NOW.getHours()).padStart(2, '0')) < 0);
    const fieldsEmpty = (state.memories || []).every((m) => !String(m.date || '').trim())
        && (state.currentStates || []).every((s) => !String(s.updatedAt || '').trim() && !String(s.updatedAtTime || '').trim());
    return emptyOk && noToday && fieldsEmpty;
})(), null);

A('V2 有剧情日期：写入剧情日期与剧情时刻（与 V1 oracle **逐字一致**）；同一条记忆/状态不会出现真实年份', (() => {
    boot('1919-11-20');
    writeOne('记忆乙');
    return J(memDates()) === J(['1919-11-20']) && J(stateDates()) === J([['1919-11-20', '傍晚']])
        && J(memDates()) === J(G.B.memories.map((m) => m.date))
        && J(stateDates()) === J(G.B.states.map((s) => [s.updatedAt, s.updatedAtTime]));
})(), null);

A('V2 现实墙钟只出现在 epoch 毫秒记账字段（平行事件 updatedAt 的衰退窗口），**不进**剧情时间字段：写入后全部剧情日期字段要么为空要么等于剧情日期', (() => {
    boot('1919-11-20');
    mergeDelta({
        atoms: { add: [{ title: '情节甲', text: '甲在码头' }] },
        memories: { add: [{ title: '记忆丙', content: '丙在场' }] },
        states: { add: [{ subject: '丙', field: '体力', value: '疲惫' }] },
        parallels: { add: [{ title: '分支甲', text: '甲去了乙地' }] },
    });
    const all = [];
    ['atoms', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts'].forEach((k) => {
        for (const it of (state[k] || [])) if (it && it.date) all.push([k, String(it.date)]);
    });
    for (const s of (state.currentStates || [])) all.push(['states.updatedAt', String(s.updatedAt || '')]);
    const bad = all.filter(([, d]) => d && d.indexOf(YEAR) >= 0);
    const p = (state.parallels || [])[0] || {};
    return bad.length === 0 && all.every(([, d]) => !d || d.indexOf('1919-') === 0)
        // 平行事件的 updatedAt 是**记账用** epoch 毫秒（V1 同口径：按现实更新近度做 30 天衰退窗口）
        && (p.updatedAt === undefined || Number(p.updatedAt) > 1e12);
})(), null);

// ---------- I 组：注入体 ----------
A('I1 注入体真实装配：无剧情时钟时记忆行**不带**伪剧情日期（绝不出现今天的日期/年份）；有剧情时钟时仍是「[剧情日期（相对时间）]」', (() => {
    const { buildMemoryBodyForInject } = recallMod;
    boot('');
    writeOne('记忆甲');
    const body0 = String(buildMemoryBodyForInject('', { charBudget: 4000, maxMemories: 6, countUses: true, inject: true }) || '');
    const noReal0 = body0.indexOf(YEAR) < 0 && body0.indexOf(TODAY) < 0 && body0.indexOf('记忆甲') >= 0;
    boot('1919-11-20');
    writeOne('记忆乙');
    const body1 = String(buildMemoryBodyForInject('', { charBudget: 4000, maxMemories: 6, countUses: true, inject: true }) || '');
    const line1 = body1.split('\n').filter((l) => l.indexOf('记忆乙') >= 0)[0] || '';
    return noReal0 && line1.indexOf('[1919-11-20（今天）]记忆乙') >= 0;
})(), null);

// ---------- S 组：同族守卫复核 ----------
A('S1 手工录入缺年份且无可用年份 → **拒绝**并提示补全（V1 v1.187 口径，V2 一致）；`clockPatrolAnchorInfo` 在无数据时不可信（宁可不修）', (() => {
    boot('');
    const r = parseClockManualInput({ date: '11月29日' });
    const info = clockPatrolAnchorInfo();
    const item = { id: 'a1', title: '情节', text: '11月29日 甲在码头', date: '11月29日' };
    const rep = clockPatrolRepairItem(item, { field: 'date', value: '11月29日', reason: 'invalid' }, '');
    return r.ok === false && String((r.notes || [])[0] || '').indexOf('缺少年份') >= 0
        && info.usable === false && info.date === ''
        && rep.changed === false && item.date === '11月29日' && String(rep.note).indexOf('保留原值') >= 0;
})(), null);

A('S2 角色档案「最后更新/最后见面」采样：无剧情日期 → 不采样（留空）；有 → 剧情日期（V1 v1.161 口径，V2 一致）', (() => {
    boot('');
    const s0 = { id: 's1', name: '甲', tags: [], identity: {}, background: {}, floorStart: 0, floorEnd: 0, uses: 0 };
    stampSnapshotTime(s0, 'update');
    const s1 = { id: 's2', name: '乙', tags: [], identity: {}, background: {}, floorStart: 0, floorEnd: 0, uses: 0 };
    boot('1919-11-20');
    stampSnapshotTime(s1, 'update');
    return !s0.lastUpdateDate && !s0.lastUpdateTime && s1.lastUpdateDate === '1919-11-20' && s1.lastUpdateTime === '傍晚';
})(), null);

// ---------- U 组：UI 标注 ----------
A('U1 现实墙钟只以「现实更新 …」标注出现在 UI（平行事件行），与 📅 剧情日期并列但**明确区分**；无 epoch updatedAt 的行不出现该标注', (() => {
    boot('1919-11-20');
    setKernelState(Object.assign(emptyState(), {
        state: { date: '1919-11-20', time: '傍晚', location: '', present: [] },
        parallels: [
            { id: 'p1', title: '分支甲', text: '甲去了乙地', date: '1919-11-20', updatedAt: Date.now(), uses: 2, type: '推演' },
            { id: 'p2', title: '分支乙', text: '乙去了丙地', date: '1919-11-21', uses: 0, type: '推演' },
        ],
    }));
    const html = String(panelBodyHtml('parallels'));
    const lineOf = (t) => (html.split('\n').filter((l) => l.indexOf(t) >= 0)[0] || '');
    const l1 = lineOf('分支甲').replace(/<[^>]*>/g, '');
    const l2 = lineOf('分支乙').replace(/<[^>]*>/g, '');
    return l1.indexOf('现实更新') > 0 && l1.indexOf('1919-11-20') > 0
        && l2.indexOf('现实更新') < 0 && l2.indexOf('1919-11-21') > 0
        // 墙钟值必须带「现实更新」前缀（不得裸展示为剧情日期）
        && l1.indexOf('· 现实更新 ') > 0;
})(), null);

un();
R.done();
