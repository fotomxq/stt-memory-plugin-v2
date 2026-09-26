// ============================================================
// 单元测试 · v2.69.0「主角 0001-01-01 出生、剧情 0191 触发生日日期异常」修复
//
// 用户报告：「主角大类当主角为 0001-01-01 出生，剧情到 0191-09-23 时，会触发生日日期异常。
//   请核对原因并修复该异常判断。」
//
// **真根因**：`snapshotBirthAnomaly()` 的 `overage` 判据是 V1 原样 ——
//   `calcAge(birth, 剧情锚点) > 120 && !(出生年为负) → 'overage'`：这条阈值是「**现实人类寿命**」的经验值，
//   且只豁免「公元前出生」。于是 ① 故事用自设纪元（从 0001-01-01 起算、剧情到 0191 年 → 主角 190 岁）
//   与 ② 非人/长生设定（精灵、龙裔、亡灵…）都会被误判为「出生日期异常」，进而
//   在 角色档案列表挂 ⚠ 角标、在「🔧 修复角色」按钮上计入「⚠️N 优先」、并让 `buildCharacterRepairQueue()`
//   **无视字数门限**把主角排进修复优先档。
//
// 本批（`core/model/snapshot.js`）：`overage` 增加两条豁免 ——
//   ① `snapshotLongLived(s)`：档案（species/race/title/occupation/family/birthNote/背景/标签/外貌）含非人·长生信号；
//   ② `snapshotLowEpochCalendar(anchor)`：剧情锚点年份 < 1000（自设纪元 / 编年起点）。
//   **只放宽 overage**：`future` / `after-record` / `bad-format` / fallback 占位 / 穿越者豁免 全部照旧。
//
// V1 对照（oracle）：`tests/fixtures/v1-golden-birth-anomaly.json`（真实 V1 v1.206 `snapshotBirthAnomaly`）
// 运行：node tests/unit/birth-anomaly.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    snapshotBirthAnomaly, snapshotLongLived, snapshotLowEpochCalendar, calcAge, ageAnchorDate,
    snapshotAge, snapshotBirthAnomalyLabel, SNAP_BIRTH_ANOMALY_LABEL,
} from '../../core/model/snapshot.js';
import { buildCharacterRepairQueue } from '../../core/character-repair.js';
import { listRowMainHtml } from '../../ui/list-rows.js';
import { panelBodyHtml, openPanel, setPanelHooks2 } from '../../ui/panel.js';
import { SCENARIOS } from '../fixtures/birth-anomaly-scenarios.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('birth-anomaly v2.69.0 出生日期异常判定修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'v1-golden-birth-anomaly.json'), 'utf8'));
const fxOf = (n) => FX.scenarios.filter((s) => s.name === n)[0];

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

/** 装一份状态：剧情锚点 + 该场景的角色档案（与 oracle 生成器同口径） */
function bootScenario(sc) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('主角');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: String(sc.story || ''), time: '' });
    st.snapshots = [Object.assign({ id: 'snap-' + sc.name }, sc.snap)];
    setKernelState(st);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    return st.snapshots[0];
}
const scen = (n) => SCENARIOS.filter((s) => s.name === n)[0];

// ---------- A 组：oracle 对照 + 场景逐项 ----------
A('A1 oracle 齐备：11 个场景 · 3 处已记录差异 · V1 标签表与当前一致', FX.scenarios.length === 11
    && FX.scenarios.filter((s) => s.deviation).length === 3
    && J(FX.labels) === J(SNAP_BIRTH_ANOMALY_LABEL), J({ n: FX.scenarios.length, labels: SNAP_BIRTH_ANOMALY_LABEL }));

A('A2 11 个场景实时结论 = 期望（含用户场景豁免、真异常保留、纪元边界）', (() => {
    const bad = [];
    for (const sc of SCENARIOS) {
        const s = bootScenario(sc);
        const got = String(snapshotBirthAnomaly(s) || '');
        if (got !== String(sc.expect)) bad.push({ n: sc.name, got: got, want: sc.expect });
    }
    return bad.length === 0;
})(), '见断言');

A('A3 差异有据：V2 与 V1 结论不同的场景，必须带 deviation 说明；相同场景 V1 结论与期望一致', (() => {
    const rows = SCENARIOS.map((sc) => {
        const f = fxOf(sc.name);
        const differs = String(f.v1) !== String(sc.expect);
        return { n: sc.name, v1: f.v1, expect: sc.expect, differs: differs, dev: !!sc.deviation };
    });
    return rows.every((r) => (r.differs ? r.dev : true)) && rows.filter((r) => r.differs).length === 3;
})(), J(SCENARIOS.map((sc) => ({ n: sc.name, v1: fxOf(sc.name).v1, expect: sc.expect }))));

A('A4 用户场景：主角 0001-01-01 → 剧情 0191-09-23 **不再**判异常，但年龄仍如实算出 190', (() => {
    const s = bootScenario(scen('low-epoch-overage'));
    return snapshotBirthAnomaly(s) === '' && calcAge('0001-01-01', ageAnchorDate()) === '190'
        && snapshotLowEpochCalendar(ageAnchorDate()) === true
        && snapshotAge(s) === '190';
})(), J({ anom: snapshotBirthAnomaly(bootScenario(scen('low-epoch-overage'))), age: calcAge('0001-01-01', ageAnchorDate()) }));

A('A5 真异常未被放宽：现实纪元的出生年笔误、凡人超龄、未来出生、倒挂、脏格式仍然判出', (() => {
    const got = {};
    for (const n of ['real-epoch-overage', 'boundary-1000', 'future-birth', 'after-record', 'bad-format']) {
        got[n] = String(snapshotBirthAnomaly(bootScenario(scen(n))) || '');
    }
    return got['real-epoch-overage'] === 'overage' && got['boundary-1000'] === 'overage'
        && got['future-birth'] === 'future' && got['after-record'] === 'after-record'
        && got['bad-format'] === 'bad-format';
})(), '见断言');

A('A6 长生豁免只看档案内容：精灵/亡灵/巫妖/龙裔/人造体命中；凡人同字段不命中；姓名不作依据', (() => {
    const yes = ['高等精灵', '亡灵法师', '巫妖', '古龙', '人造体', '吸血鬼', '仙人', '狼人'];
    const no = ['人类', '铁匠', ''];
    const hitYes = yes.every((sp) => snapshotLongLived({ identity: { species: sp } }) === true);
    const hitNo = no.every((sp) => snapshotLongLived({ identity: { species: sp } }) === false);
    // 姓名带「龙」但档案是凡人 → 不豁免（V1 同款纪律：只看内容不看姓名）
    const nameOnly = snapshotLongLived({ name: '龙傲天', identity: { species: '人类' } }) === false;
    return hitYes && hitNo && nameOnly;
})(), J({ yes: '8 类命中', no: '3 类不命中' }));

// ---------- B 组：下游影响（用户实际看到的） ----------
A('B1 角色档案列表行不再挂「⚠️ 出生日期异常」角标（真异常仍挂）', (() => {
    const s1 = bootScenario(scen('low-epoch-overage'));
    const row1 = listRowMainHtml('snapshots', s1);
    const s2 = bootScenario(scen('real-epoch-overage'));
    const row2 = listRowMainHtml('snapshots', s2);
    return row1.indexOf('出生日期异常') < 0 && row2.indexOf('出生日期异常') > 0;
})(), '见断言');

A('B2 角色页「🔧 修复角色」不再出现「（⚠️N 优先）」角标（主角场景）', (() => {
    bootScenario(scen('low-epoch-overage'));
    openPanel('snapshots');
    const html = panelBodyHtml('snapshots');
    const withBadge = html.indexOf('（⚠️1 优先）') >= 0;
    bootScenario(scen('real-epoch-overage'));
    const html2 = panelBodyHtml('snapshots');
    return withBadge === false && html2.indexOf('（⚠️1 优先）') >= 0;
})(), '见断言');

A('B3 修复优先档不再把主角拉进来（真异常角色仍在优先档）', (() => {
    bootScenario(scen('low-epoch-overage'));
    const q1 = buildCharacterRepairQueue();
    bootScenario(scen('real-epoch-overage'));
    const q2 = buildCharacterRepairQueue();
    const names1 = (q1.anomalyList || []).map((x) => x.name);
    const names2 = (q2.anomalyList || []).map((x) => x.name);
    return names1.length === 0 && names2.length === 1 && names2[0] === '角色甲'
        && (q1.list || []).every((x) => x.anomaly === '');
})(), J({ q1: (buildCharacterRepairQueue().anomalyList || []).map((x) => x.name) }));

A('B4 标签文案未动（V1 逐字）：四种异常的 label 与 oracle 一致', (() => {
    const all = Object.keys(SNAP_BIRTH_ANOMALY_LABEL).every((k) => SNAP_BIRTH_ANOMALY_LABEL[k] === FX.labels[k]);
    return all && snapshotBirthAnomalyLabel('overage') === '按剧情日期算出的年龄超过 120 岁';
})(), J(SNAP_BIRTH_ANOMALY_LABEL));

R.done();
