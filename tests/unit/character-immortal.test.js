// ============================================================
// 单元测试 · v3.22.0「角色修复：超长年龄分析 + 长生者字段」
//
// 用户要求（原话）：「角色修复，新增对超长年龄人员的分析，明显不合理的可能是长期没出现的人物，但被误判会长生。
//   其次角色新增字段，根据剧情标记是否为长生者，该开关可以被编辑。
//   如果是标记了长生者，则无需在修复角色中被分析。
//   如果被分析发现为误判角色，则可根据剧情或预判分析后，标记为去世。」
//
// 落定口径：
//   ① **超长年龄分析**（机械、零 AI）：年龄 > `SNAP_AGE_EXTREME_YEARS`(200) 且档案**没有任何长寿依据** →
//      异常码 `age-extreme`（「疑似长期未出场而虚增 / 误判长生」）—— **不受「低纪元」豁免**
//      （真机：628 年剧情里出现数百岁的凡人，原先被 `snapshotLowEpochCalendar` 静默放过）；
//   ② **身份.长生者**（`identity.immortal`）：三态 bool、**可编辑**（AI 与编辑器都能勾/取消，与「已去世」的单向不同）；
//   ③ **标记长生者 → 角色修复整批跳过**（名单 / 出生日期机械改写都不碰）；
//   ④ **误判纠正**：AI 判定「长生者是误判」时可同时输出 `身份.长生者=否` + `身份.已去世=是`（按剧情标记去世）。
//
// 覆盖：A 字段与开关语义；B 超长年龄判定与豁免；C 跳过规则；D 提示词（守则 + ⚠️ 点名 + 默认提示词不变）；
//       E 误判纠正落地与计数；F 只读干跑；G 编辑器字段（可编辑）。
// 运行：node tests/unit/character-immortal.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    normalizeSnapshot, snapshotImmortal, snapshotImmortalFlag, snapshotRepairSkip, snapshotBirthAnomaly,
    snapshotLastSeenGapYears, SNAP_AGE_EXTREME_YEARS, snapshotAgeIsLocked, ageAnchorDate,
} from '../../core/model/snapshot.js';
import {
    buildCharacterRepairQueue, setSnapshotByPath, buildCharacterRepairPrompt, applyCharacterRepairResult,
    correctSnapshotBirthDates, runCharacterMechanicalPass, snapshotDeathVerdict, characterAgeScan, SNAP_REPAIR_FIELD_MAP,
} from '../../core/character-repair.js';
import { kindFields, flattenSnapshot } from '../../ui/fields.js';

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

const R = makeReporter('character-immortal v3.22.0 超长年龄分析 + 长生者字段');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** 装场景：剧情日期固定 628-07-10（**低纪元** —— 专门验证「超长年龄」不再被纪元豁免） */
function boot(snaps) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char-immortal');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), { snapshots: clone(snaps || []), state: { date: '628-07-10', time: '下午' } }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setNotifyHooks({ toast: () => undefined });
    return state;
}
const SNAP = (name, identity, extra) => Object.assign({
    id: 'snap-' + name, name: name, identity: clone(identity || {}), tags: [], uses: 1,
}, extra || {});

// ---------- A 组：字段与开关语义 ----------
A('A1 归一化：`identity.immortal` 三态（true / false / 未提及）；中文与英文别名都认（长生者 / 长生 / immortal / mortal）', (() => {
    const a = normalizeSnapshot({ name: '甲', identity: { immortal: true } });
    const b = normalizeSnapshot({ name: '乙', identity: { 长生者: '是' } });
    const c = normalizeSnapshot({ name: '丙', profile: { immortal: 'no' } });
    const d = normalizeSnapshot({ name: '丁', identity: {} });
    const e = normalizeSnapshot({ name: '戊', immortal: '永生' });
    return a.identity.immortal === true && b.identity.immortal === true && c.identity.immortal === false
        && d.identity.immortal === undefined && e.identity.immortal === true
        && snapshotImmortal(a) === true && snapshotImmortal(c) === false && snapshotImmortal(d) === false;
})(), '');

A('A2 词表严格分离：「长生」**不得**被死亡词表判成「已去世」；反之「已去世」也不得被长生词表吸收', (() => {
    // 若误用 snapshotFlag（死亡词表）解析长生者，'长生' 会命中「是」→ 语义相反的严重错判
    const asDeath = normalizeSnapshot({ name: '甲', identity: { deceased: '长生' } });
    const asImmortal = normalizeSnapshot({ name: '乙', identity: { immortal: '是' } });
    return snapshotImmortalFlag('长生') === true && snapshotImmortalFlag('已去世') === undefined
        && asDeath.identity.deceased === undefined && asImmortal.identity.immortal === true
        && asImmortal.identity.deceased === undefined;
})(), '');

A('A3 开关**可编辑**（双向）：`身份.长生者` 能写 true 也能写回 false；`身份.已去世` 仍保持「只标记不取消」（V1 口径）', (() => {
    const s = { identity: {} };
    const on = setSnapshotByPath(s, '身份.长生者', '是');
    const afterOn = s.identity.immortal;
    const off = setSnapshotByPath(s, '身份.长生者', false);
    const afterOff = s.identity.immortal;
    const onAgain = setSnapshotByPath(s, '身份.长生者', '长生');
    const afterAgain = s.identity.immortal;
    const d1 = setSnapshotByPath(s, '身份.已去世', '是');
    const d2 = setSnapshotByPath(s, '身份.已去世', false);
    return on.ok === true && on.changed === true && afterOn === true
        && off.changed === true && afterOff === false
        && onAgain.changed === true && afterAgain === true
        && d1.changed === true && d2.changed === false && snapshotAgeIsLocked(s) === true;
})(), () => J({ immortal: 'see steps' }));

A('A4 内容副本含「长生者」（用户可编辑字段 → 参与身份指纹）；字段表新增 `身份.长生者` 且为 optional', (() => {
    const on = normalizeSnapshot({ name: '甲', identity: { immortal: true } });
    const off = normalizeSnapshot({ name: '甲', identity: { immortal: false } });
    const none = normalizeSnapshot({ name: '甲', identity: {} });
    return on.content.indexOf('长生者:是') >= 0 && off.content.indexOf('长生者:否') >= 0 && none.content.indexOf('长生者') < 0
        && SNAP_REPAIR_FIELD_MAP['身份.长生者'].optional === true
        && J(SNAP_REPAIR_FIELD_MAP['身份.长生者'].g) === J(['identity', 'immortal']);
})(), '');

// ---------- B 组：超长年龄判定（剧情锚点固定在 0628-07-10，**低纪元**） ----------
A('B1 **低纪元**（628 年）+ 无长寿依据 + 年龄远超阈值 → `age-extreme`（真机场景：数百岁的凡人不再被静默放过）', (() => {
    boot([]);
    const s = SNAP('凡人甲', { birthDate: '0300-01-01' });                 // 628 - 300 = 328 岁
    const snap = normalizeSnapshot(s);
    const anom = snapshotBirthAnomaly(snap);
    return anom === 'age-extreme' && SNAP_AGE_EXTREME_YEARS === 200;
})(), () => String(snapshotBirthAnomaly(normalizeSnapshot(SNAP('凡人甲', { birthDate: '0300-01-01' })))));

A('B2 有长寿依据（种族=精灵）/ 已标记长生者 / 穿越者 / 年龄未超阈值 → **都不判** `age-extreme`（锚点在册，不是「没锚点才不判」）', (() => {
    boot([]);
    const elf = normalizeSnapshot(SNAP('精灵乙', { birthDate: '0300-01-01', species: '精灵' }));
    const marked = normalizeSnapshot(SNAP('长生丙', { birthDate: '0300-01-01', immortal: true }));
    // 穿越者信号取自**档案正文/背景**（`birthNote` 不在归一化白名单里 —— 与 V1 身份键集一致，故不作为判据来源）
    const traveler = normalizeSnapshot(SNAP('穿越丁', { birthDate: '0300-01-01' }, { background: { origin: '从后世穿越而来' } }));
    const young = normalizeSnapshot(SNAP('少年戊', { birthDate: '0600-01-01' }));            // 28 岁
    return ageAnchorDate() !== ''                                                            // 锚点确实在册
        && snapshotBirthAnomaly(elf) === '' && snapshotBirthAnomaly(marked) === ''
        && snapshotBirthAnomaly(traveler) === '' && snapshotBirthAnomaly(young) === ''
        && snapshotBirthAnomaly(marked) !== 'overage';
})(), () => J({ anchor: ageAnchorDate() }));

A('B3 「长期未出场」读数：`snapshotLastSeenGapYears` 给出「最后见面 / 最后更新」距今多少年（判「长期未出场」的依据）', (() => {
    boot([]);
    const far = normalizeSnapshot(SNAP('久未出场', { birthDate: '0300-01-01' }, { lastSeenDate: '0400-05-01' }));   // 距今 228 年
    const near = normalizeSnapshot(SNAP('刚见过', { birthDate: '0600-01-01' }, { lastSeenDate: '0628-07-01' }));    // 距今 0.02 年
    const none = normalizeSnapshot(SNAP('无记录', { birthDate: '0600-01-01' }));
    const g1 = snapshotLastSeenGapYears(far), g2 = snapshotLastSeenGapYears(near), g3 = snapshotLastSeenGapYears(none);
    return Number.isFinite(g1) && g1 > 220 && Number.isFinite(g2) && g2 < 1 && !Number.isFinite(g3);
})(), () => J({ far: snapshotLastSeenGapYears(normalizeSnapshot(SNAP('久未出场', { birthDate: '0300-01-01' }, { lastSeenDate: '0400-05-01' }))), none: snapshotLastSeenGapYears(normalizeSnapshot(SNAP('无记录', { birthDate: '0600-01-01' }))) }));

// ---------- C 组：标记长生者 → 修复整批跳过 ----------
A('C1 `snapshotRepairSkip`：已去世（年龄锁定）与长生者都跳过，原因分别可辨（供通知如实说明）', (() => {
    const dead = normalizeSnapshot(SNAP('故人', { deceased: true }));
    const immortal = normalizeSnapshot(SNAP('长生', { immortal: true }));
    const alive = normalizeSnapshot(SNAP('常人', {}));
    const a = snapshotRepairSkip(dead), b = snapshotRepairSkip(immortal), c = snapshotRepairSkip(alive);
    return a.skip === true && a.reason === 'deceased' && b.skip === true && b.reason === 'immortal'
        && c.skip === false && c.reason === '';
})(), '');

A('C2 待修复名单：长生者**整批跳过**（分别计数，不进 AI 名单）；`characterAgeScan()` 里能看到跳过原因', (() => {
    boot([
        SNAP('常人甲', { occupation: '铁匠' }),
        SNAP('长生乙', { immortal: true, occupation: '修士' }),
        SNAP('故人丙', { deceased: true }),
    ]);
    cfg.repairCharacterMinSize = 0;
    const q = buildCharacterRepairQueue();
    const scan = characterAgeScan();
    return q.list.length === 1 && q.list[0].name === '常人甲'
        && q.immortalCount === 1 && q.immortalList[0] === '长生乙'
        && q.deceasedCount === 1 && q.deceasedList[0] === '故人丙'
        && scan.find((x) => x.name === '长生乙').skip === 'immortal'
        && scan.find((x) => x.name === '故人丙').skip === 'deceased';
})(), () => J({ list: buildCharacterRepairQueue().list.map((x) => x.name), q: { i: buildCharacterRepairQueue().immortalCount } }));

A('C3 机械出生日期校正也跳过长生者（年龄不可信 → 不重推、不改写），计数进 `skippedImmortal`', (() => {
    boot([
        SNAP('长生乙', { immortal: true, birthDate: '约300年' }),      // 格式非法，但被跳过 → 不动
        SNAP('常人甲', { birthDate: '约300年' }),                       // 同一脏值，未标记 → 按线索重推
    ]);
    const cb = correctSnapshotBirthDates();
    const imm = normalizeSnapshot(state.snapshots.find((x) => x.name === '长生乙'));
    const hum = normalizeSnapshot(state.snapshots.find((x) => x.name === '常人甲'));
    return cb.skippedImmortal === 1 && cb.corrected === 1
        && String(imm.identity.birthDate) === '约300年'                 // 原样保留（未处理）
        && String(hum.identity.birthDate) !== '约300年';                // 已重推
})(), () => J({ cb: correctSnapshotBirthDates(), b: (state.snapshots || []).map((x) => [x.name, (x.identity || {}).birthDate]) }));

A('C4 已标记长生者 → 死亡研判按「长寿命」口径（须有终局措辞才标记），不会因为一句普通死亡词把人判死', (() => {
    boot([
        SNAP('长生乙', { immortal: true }, { background: { history: '长生乙在乱战中被杀，众人皆以为他死了。' } }),
    ]);
    const v1 = snapshotDeathVerdict(state.snapshots[0]);
    boot([
        SNAP('长生丙', { immortal: true }, { background: { history: '长生丙最终形神俱灭，连魂魄都散了。' } }),
    ]);
    const v2 = snapshotDeathVerdict(state.snapshots[0]);
    return v1.longLife === true && v1.verdict === 'uncertain' && v1.reason === 'long-life-unconfirmed'
        && v2.verdict === 'dead' && v2.reason === 'explicit-terminal';
})(), '');

// ---------- D 组：提示词 ----------
A('D1 `immortalGuide` 开启时：守则 + ⚠️ 超长年龄点名（含年龄与「最后见面距今 N 年」）+ ① ② ③ 研判口径', (() => {
    boot([SNAP('凡人甲', { birthDate: '0300-01-01' }, { lastSeenDate: '0400-05-01' })]);
    cfg.repairCharacterMinSize = 0;
    const q = buildCharacterRepairQueue();
    const t = q.list[0];
    const p = buildCharacterRepairPrompt([t], { immortalGuide: true });
    const txt = String(p[1].content);
    return t.anomaly === 'age-extreme' && t.age !== null && t.staleYears > 200
        && txt.indexOf('【长生者判定（保守）】') >= 0 && txt.indexOf('年龄超长本身不是依据') >= 0
        && txt.indexOf('⚠️ 超长年龄') >= 0 && txt.indexOf('身份.长生者') >= 0 && txt.indexOf('身份.已去世') >= 0
        && txt.indexOf('超长年龄待研判者优先') >= 0
        && txt.indexOf('不要改出生日期') >= 0;
})(), () => JSON.stringify(buildCharacterRepairPrompt(buildCharacterRepairQueue().list, { immortalGuide: true })[1].content.slice(0, 400)));

A('D2 默认提示词（不带任何 guide）**逐字不含**新守则与新条款 —— V1 黄金样本口径不变', (() => {
    boot([SNAP('凡人甲', { birthDate: '0300-01-01' })]);
    cfg.repairCharacterMinSize = 0;
    const plain = buildCharacterRepairPrompt(buildCharacterRepairQueue().list);
    const txt = String(plain[1].content);
    return txt.indexOf('长生者判定') < 0 && txt.indexOf('身份.长生者') < 0 && txt.indexOf('超长年龄待研判者优先') < 0
        && txt.indexOf('年龄超长本身不是依据') < 0;     // 中性点名：不出现守则与判定条款（异常标签本身提到「或误判长生」不在此列）
})(), () => String(buildCharacterRepairPrompt(buildCharacterRepairQueue().list)[1].content).slice(0, 200));

// ---------- E 组：误判纠正落地 ----------
A('E1 AI 判定「长生者是误判」→ 同时输出 `身份.长生者=否` + `身份.已去世=是`：标记被取消、并按剧情标记去世（计数如实）', (() => {
    boot([SNAP('长生乙', { immortal: true, birthDate: '0300-01-01' })]);
    cfg.repairCharacterMinSize = 0;
    const q = buildCharacterRepairQueue();
    // 注意：被标记长生者本不在名单里 —— 这里按「上一轮研判已产出该结论」的落地路径直接喂 delta
    const r = applyCharacterRepairResult({ snapshots: { update: [{ '姓名': '长生乙', '补全': { '身份.长生者': '否', '身份.已去世': '是' } }] } }, q.all.concat([{ name: '长生乙', snap: state.snapshots[0] }]));
    const s = state.snapshots[0];
    return r.immortalCleared === 1 && (r.immortalClearedNames || [])[0] === '长生乙'
        && r.deceasedMarked === 1 && snapshotImmortal(s) === false && snapshotAgeIsLocked(s) === true;
})(), () => J({ r: applyCharacterRepairResult({ snapshots: { update: [] } }, []), s: state.snapshots[0] }));

A('E2 AI 判定「确为长生者」→ `身份.长生者=是` 落地并计数（此后不再被修复分析）', (() => {
    boot([SNAP('角色甲', { birthDate: '0300-01-01' })]);
    const r = applyCharacterRepairResult({ snapshots: { update: [{ '姓名': '角色甲', '补全': { '身份.长生者': '是' } }] } }, [{ name: '角色甲', snap: state.snapshots[0] }]);
    const q = buildCharacterRepairQueue();
    return r.immortalSet === 1 && (r.immortalNames || [])[0] === '角色甲'
        && snapshotImmortal(state.snapshots[0]) === true && q.list.length === 0 && q.immortalCount === 1;
})(), '');

A('E3 只想纠正标记、死亡尚无依据 → 只取消「长生者」，**不**标记去世（保守，不越权）', (() => {
    boot([SNAP('长生乙', { immortal: true })]);
    const r = applyCharacterRepairResult({ snapshots: { update: [{ '姓名': '长生乙', '补全': { '身份.长生者': '否' } }] } }, [{ name: '长生乙', snap: state.snapshots[0] }]);
    const s = state.snapshots[0];
    return r.immortalCleared === 1 && !r.deceasedMarked && snapshotImmortal(s) === false && snapshotAgeIsLocked(s) === false;
})(), '');

// ---------- F 组：只读干跑 ----------
A('F1 `characterAgeScan()` 只读：给出年龄 / 是否超长 / 是否长生 / 跳过原因 / 最后见面距今，且**不写任何标记**', (() => {
    boot([SNAP('凡人甲', { birthDate: '0300-01-01' }, { lastSeenDate: '0400-05-01' }), SNAP('长生乙', { immortal: true, birthDate: '0300-01-01' })]);
    const before = J(state.snapshots);
    const scan = characterAgeScan();
    return scan.length === 2 && scan[0].age > 300 && scan[0].extreme === true && scan[0].immortal === false
        && scan.every((x) => x.threshold === SNAP_AGE_EXTREME_YEARS)
        && scan.find((x) => x.name === '长生乙').immortal === true
        && J(state.snapshots) === before;
})(), () => J(characterAgeScan().map((x) => [x.name, x.age, x.extreme, x.immortal, x.skip])));

A('F2 `runCharacterMechanicalPass()` 如实回报长生者跳过数（通知/日志用），且不影响既有键', (() => {
    boot([SNAP('长生乙', { immortal: true, birthDate: '约300年' }), SNAP('常人甲', { birthDate: '约300年' })]);
    const mech = runCharacterMechanicalPass();
    return Number(mech.immortal) === 1 && Number(mech.deceased) === 0
        && mech.birth && Number(mech.birth.skippedImmortal) === 1 && J(Object.keys(mech).sort()) === J(['ages', 'anomalies', 'birth', 'changed', 'deceased', 'immortal', 'tags', 'total']);
})(), () => J(runCharacterMechanicalPass()));

// ---------- G 组：编辑器字段（可编辑） ----------
A('G1 角色编辑器：字段表含「长生者」勾选框（紧跟「已去世」），编辑 → 入库能双向保存', (() => {
    const fields = kindFields('snapshots');
    const iDead = fields.findIndex((f) => f.key === 'deceased');
    const iImm = fields.findIndex((f) => f.key === 'immortal');
    const flat = flattenSnapshot(normalizeSnapshot(SNAP('长生乙', { immortal: true })));
    return iDead >= 0 && iImm === iDead + 1 && fields[iImm].type === 'checkbox'
        && flat.immortal === true && flat.deceased === undefined;
})(), () => J(kindFields('snapshots').map((f) => f.key)));

R.done();
