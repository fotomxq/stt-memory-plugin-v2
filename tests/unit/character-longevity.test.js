// ============================================================
// 单元测试 · v3.49.1「角色修复：年龄高寿 → **主动标记去世**」
//
// 用户要求（原话）：「角色修复中，除了抽取字数偏少外，还需增加对年龄异常的处理。
//   当没有标记长生者，且年龄明显达到平均高寿的，需主动标记去世。」
//
// 口径（**保守**，任一不满足即不标记；`core/character-repair.js#snapshotLongevityVerdict`）：
//   ① 未标记已去世（短路，避免反复处理）；② **没有长生者标记**且档案无长生类措辞；
//   ③ 出生日期**可算且可信**（future / bad-format / after-record / overage 四种异常 → 不动）；
//   ④ 年龄 ≥ `cfg.repairDeceasedAge`（默认 75）——「明显达到平均高寿」；
//   ⑤ 年龄 ≥ 200（`SNAP_AGE_EXTREME_YEARS`）→ 只**报告**不标记（多半是长生者没标或数据错）。
// 覆盖：
//   A 研判单条：达阈值 → dead / 未达 → none / 长生者 → 不动 / 长生类措辞 → 不动 /
//     出生日期异常 → 不动 / 年龄算不出 → 不动 / ≥200 → report / 已标记 → 短路
//   B 全链路：`markDeceasedByEvidence`（年龄规则）与机械段读数（`ageMarked` / `ageThreshold` / `deceasedByEvidence`）
//     + 队列随后跳过 + 幂等 + 可关（`ageRule:false` / 阈值 0）
//   C 干跑：`characterAgeScan()` 带 `longevity` 读数（只读不标记）
// 运行：node tests/unit/character-longevity.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    snapshotLongevityVerdict, SNAP_LONGEVITY_DEFAULT_YEARS,
    markDeceasedByEvidence, lastDeceasedMark, buildCharacterRepairQueue, runCharacterMechanicalPass, characterAgeScan,
} from '../../core/character-repair.js';

const R = makeReporter('character-longevity v3.49.1 年龄高寿 → 主动标记去世');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.repairCharacterMinSize = 30; cfg.repairCharacterBatch = 3; cfg.repairFloors = 10;
    setScopeKey('char:longevity');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false });
    setNotifyHooks({ toast: () => undefined });
    return state;
}
/** 造一个角色：`birthDate` + 剧情日期 `state.date` 决定年龄 */
const snap = (name, birthDate, extra) => Object.assign({ id: 'sn_' + name, name: name, tags: [], identity: Object.assign({ birthDate: birthDate }, (extra && extra.identity) || {}), background: (extra && extra.background) || {} }, extra && extra.top || {});
/** 剧情日期 1919-12-01 */
const story = { state: { date: '1919-12-01' } };

// ==================== A 组：研判单条 ====================
A('A1 达阈值 → `dead`（reason `age-longevity`，证据写明年龄与阈值）；未达阈值 → `none`；默认阈值 = 75 且可被配置覆盖', (() => {
    const st = boot(Object.assign({ snapshots: [
        snap('老张', '1839-03-01'),          // 80 岁
        snap('小李', '1899-03-01'),          // 20 岁
    ] }, story));
    const a = snapshotLongevityVerdict(st.snapshots[0]);
    const b = snapshotLongevityVerdict(st.snapshots[1]);
    cfg.repairDeceasedAge = 90;
    const c = snapshotLongevityVerdict(st.snapshots[0]);      // 80 < 90 → 不标
    return SNAP_LONGEVITY_DEFAULT_YEARS === 75
        && a.verdict === 'dead' && a.reason === 'age-longevity' && Math.round(a.age) === 80
        && a.threshold === 75 && String(a.evidence).indexOf('未标记长生者') > 0
        && b.verdict === 'none' && b.reason === 'below-threshold'
        && c.verdict === 'none' && c.threshold === 90;
})(), (() => { boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story)); return J(snapshotLongevityVerdict(state.snapshots[0])); })());

A('A2 **没有长生者标记**是硬门槛：长生者开关 / 档案里的长生类措辞（长生·不死·精灵·修真…）→ **一律不动**（blocked 写明原因）', (() => {
    const st = boot(Object.assign({ snapshots: [
        snap('仙尊', '1000-01-01', { identity: { birthDate: '1000-01-01', immortal: true } }),
        snap('精灵', '0900-01-01', { background: { history: '她是精灵，寿命漫长' } }),
        snap('凡人', '1839-03-01'),
    ] }, story));
    const a = snapshotLongevityVerdict(st.snapshots[0]);
    const b = snapshotLongevityVerdict(st.snapshots[1]);
    const c = snapshotLongevityVerdict(st.snapshots[2]);
    return a.verdict === 'none' && a.blocked === 'immortal'
        && b.verdict === 'none' && b.blocked === 'long-life-words'
        && c.verdict === 'dead';
})(), (() => {
    boot(Object.assign({ snapshots: [snap('仙尊', '1000-01-01', { identity: { birthDate: '1000-01-01', immortal: true } })] }, story));
    return J(snapshotLongevityVerdict(state.snapshots[0]));
})());

A('A3 年龄必须**可信**：出生日期异常（未来 / 倒挂 / 格式非法）→ 不动；算不出年龄 → 不动；**≥200 岁 → 只报告不标记**（`report` / `implausible-age`）', (() => {
    const st = boot(Object.assign({ snapshots: [
        snap('未来人', '1950-01-01'),                        // 出生晚于剧情日期 → future
        snap('无生日', ''),                                   // 没有出生日期 → 算不出
        snap('超长', '1700-01-01'),                           // 219 岁 → report（不标）
    ] }, story));
    const a = snapshotLongevityVerdict(st.snapshots[0]);
    const b = snapshotLongevityVerdict(st.snapshots[1]);
    const c = snapshotLongevityVerdict(st.snapshots[2]);
    return a.verdict === 'none' && a.blocked === 'birth-untrusted'
        && b.verdict === 'none'
        && c.verdict === 'report' && c.reason === 'implausible-age' && Number(c.age) >= 200;
})(), (() => {
    boot(Object.assign({ snapshots: [snap('超长', '1700-01-01')] }, story));
    return J(snapshotLongevityVerdict(state.snapshots[0]));
})());

A('A4 幂等：**已标记已去世**的角色短路（`already-marked`），不再反复研判（「避免反复调取处理」的既有口径）', (() => {
    const st = boot(Object.assign({ snapshots: [snap('老张', '1839-03-01', { identity: { birthDate: '1839-03-01', deceased: true } })] }, story));
    const a = snapshotLongevityVerdict(st.snapshots[0]);
    return a.verdict === 'none' && a.blocked === 'already-marked';
})(), '');

// ==================== B 组：全链路 ====================
A('B1 批量标记：达阈值且未标长生者 → **主动写 `身份.已去世`**，并单列计数（`markedByAge` / `ageMarkedNames`）；文字证据与年龄**分列**计数', (() => {
    const st = boot(Object.assign({ snapshots: [
        snap('老张', '1839-03-01'),
        snap('小李', '1899-03-01'),
        snap('阵亡者', '1879-01-01', { background: { history: '阵亡者在最后的战斗中阵亡。' } }),
    ] }, story));
    const stat = markDeceasedByEvidence({ silent: true });
    const byName = {};
    for (const s of st.snapshots) byName[String(s.name)] = s;
    return stat.marked === 2 && stat.markedByAge === 1 && stat.markedByEvidence === 1
        && stat.ageThreshold === 75 && stat.ageMarkedNames.join(',') === '老张'
        && byName['老张'].identity.deceased === true && byName['小李'].identity.deceased !== true
        && byName['阵亡者'].identity.deceased === true
        && stat.items.filter((x) => x.source === 'age').length === 1;
})(), (() => { boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story)); return J(markDeceasedByEvidence({ silent: true })); })());

A('B2 ≥200 岁**只报告不标记**：`ageReported` + `ageReportedDetail`（写明年龄），且该角色**没有**被标记', (() => {
    const st = boot(Object.assign({ snapshots: [snap('超长', '1700-01-01')] }, story));
    const stat = markDeceasedByEvidence({ silent: true });
    return stat.marked === 0 && stat.ageReported === 1
        && stat.ageReportedDetail[0].name === '超长' && Number(stat.ageReportedDetail[0].age) >= 200
        && st.snapshots[0].identity.deceased !== true;
})(), '');

A('B3 机械段读数 + 队列联动：`runCharacterMechanicalPass()` 回报 `ageMarked` / `ageThreshold` / `deceasedByEvidence`；被年龄规则标记的角色**随后从待修复名单消失**', (() => {
    const st = boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story));
    const mech = runCharacterMechanicalPass();
    const q = buildCharacterRepairQueue();
    const death = lastDeceasedMark();
    return Number(mech.ageMarked) === 1 && Number(mech.ageThreshold) === 75
        && Number(mech.deceasedByEvidence) === 0 && mech.changed === true
        && !!death && death.markedByAge === 1
        && q.list.length === 0 && q.deceasedCount === 1;              // 已去世 → 整批跳过
})(), (() => { boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story)); const m = runCharacterMechanicalPass(); return J({ ageMarked: m.ageMarked, ageThreshold: m.ageThreshold, deceasedByEvidence: m.deceasedByEvidence }); })());

A('B4 幂等与可关：连跑两次第二次 `marked === 0`；`ageRule:false` 关规则后不标；`repairDeceasedAge = 0` 视为关闭（阈值下限保护）', (() => {
    const st = boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story));
    const s1 = markDeceasedByEvidence({ silent: true });
    const s2 = markDeceasedByEvidence({ silent: true });
    // 换一个角色，试 ageRule:false
    st.snapshots.push(snap('老王', '1840-01-01'));
    const s3 = markDeceasedByEvidence({ silent: true, ageRule: false });
    const a = snapshotLongevityVerdict(st.snapshots[1], { threshold: 0 });   // **0 = 关闭规则**（不是回落默认）
    return s1.markedByAge === 1 && s2.marked === 0 && s3.markedByAge === 0
        && st.snapshots[1].identity.deceased !== true && a.threshold === 0 && a.blocked === 'disabled';
})(), (() => { boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story)); markDeceasedByEvidence({ silent: true }); return J(markDeceasedByEvidence({ silent: true })); })());

// ==================== C 组：干跑 ====================
A('C1 `characterAgeScan()` 只读干跑：逐角色带 `longevity` 研判与阈值，且**不写任何标记**（用户/调试可先看"谁会被年龄规则标记"）', (() => {
    const st = boot(Object.assign({ snapshots: [snap('老张', '1839-03-01'), snap('小李', '1899-03-01')] }, story));
    const scan = characterAgeScan();
    const zh = scan.filter((x) => x.name === '老张')[0] || {};
    return scan.length === 2 && !!zh.longevity && zh.longevity.verdict === 'dead'
        && Number(zh.longevity.threshold) === 75
        && st.snapshots.every((s) => !(s.identity && s.identity.deceased));      // 干跑零写入
})(), (() => { boot(Object.assign({ snapshots: [snap('老张', '1839-03-01')] }, story)); const s = characterAgeScan()[0]; return J({ name: s.name, age: s.age, longevity: s.longevity && s.longevity.verdict }); })());

R.done();
