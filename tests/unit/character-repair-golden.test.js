// ============================================================
// 单元测试 · B8-6c-3 角色档案修复管道（V1 v1.139/v1.152/v1.161/v1.162/v1.172/v1.176/v1.177/v1.205）
//   （与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-character-repair.json —— 原子尺寸 / 待修复名单 / 点路径写入 / 相关原子数据 /
//   提示词（逐字符，含 strict 加强轮）/ 机械处理（出生日期·标签·年龄）/ 结果应用（更新·推断·无依据·删除）/
//   `runCharacterRepair` 全链路（fetch 桩喂 AI）/ AI 空手加强重试 / 零变化分支 / 空库。
// 覆盖：
//   `snapshotAtomSize`（optional 字段「身份.已去世」不计入 size/missing）；`buildCharacterRepairQueue`
//   （字数门限、出生日期异常优先档无视门限、已去世整批跳过、排序）；
//   `setSnapshotByPath`（字段闭集 / str·arr·tags·bool·rel 五类分支 / 英文别名 / 空话占位拒收 /
//   出生日期公元前规范化 / 未来出生拒写 / allowOverwrite 改写 + birthSource·birthNote）；
//   `characterEvidencePack`（情节/记忆/状态/物品/关联行 & 按时间从新到旧）；`characterRepairContext` 的
//   聚焦效果经提示词逐字符比对覆盖；`buildCharacterRepairPrompt`（system + user 逐字符 + strict 加强轮）；
//   `applyCharacterRepairResult`（姓名+中文点路径精确应用、只填空不改写、出生日期兜底、时间戳、年龄重算、
//   推断/无依据/未知角色计数、删除明显错误 + 状态联动清除 + 墓碑）；
//   `correctSnapshotBirthDates` / `runCharacterMechanicalPass`（零 AI 全局机械处理）；
//   另含 V2 编排与接线：`runCharacterRepair` 全链路 / AI 空手加强重试 / 零变化 / 空库 / `aiBusy` 互斥；
//   `FTT.*` 入口、面板动作 `characterRepair` 与角色分页按钮（含 ⚠️ 优先角标）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg, normalizeDeltaKeys } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    SNAP_REPAIR_FIELDS, SNAP_REPAIR_FIELD_MAP, snapshotAtomSize, buildCharacterRepairQueue, setSnapshotByPath,
    characterEvidencePack, buildCharacterRepairPrompt, applyCharacterRepairResult, correctSnapshotBirthDates,
    runCharacterMechanicalPass, runCharacterRepair, ensureSnapshotTags, deriveSnapshotTags,
} from '../../core/character-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-character-repair.json'), 'utf8'));
const R = makeReporter('character-repair-golden B8-6c-3 角色档案修复（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);
setChatHooks({ dbgLog: () => undefined });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};
/** 记录最近一次 NOTIFY（V1 `toastLogGet` 的 V2 等价：notifyHooks.toast(text, kind)） */
let toasts = [];
let aiText = '{}';
let aiCalls = 0;
function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    // oracle 固定门限/批次/楼层数/字数上限 → V2 同值，保证确定可比
    cfg.repairCharacterMinSize = 30; cfg.repairCharacterBatch = 3; cfg.repairFloors = 10;
    setScopeKey('甲');
    setLastMessageId(3);                       // oracle mock env：getLastMessageId() === 3
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    state.repairCursor = state.repairCursor || {};
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    aiText = '{}'; aiCalls = 0;
    // 面板/编排路径共用 AI 钩子；feedText 固定为 oracle 捕获的投喂文本（V1 `buildFeedFloorText(10)`）
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => G.feedText, busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
/** 档案投影（排除宿主 `saveState` 内部补的 `h` 哈希 —— 与 oracle 的投影一致） */
const snapView = (s) => ({
    id: s.id, name: s.name, identity: s.identity, appearance: s.appearance, personality: s.personality,
    background: s.background, social: s.social, future: s.future, relationships: s.relationships,
    tags: s.tags, uses: s.uses,
    lastSeenDate: s.lastSeenDate, lastSeenTime: s.lastSeenTime, lastUpdateDate: s.lastUpdateDate, lastUpdateTime: s.lastUpdateTime,
});
const snaps = () => (state.snapshots || []).map(snapView);
const snapTombs = () => Object.keys((state.deleted || {}).snapshots || {}).sort();
const statesView = () => (state.currentStates || []).map(x => ({ id: x.id, subject: x.subject }));
/** 待修复名单投影（与 oracle 一致） */
const queueView = (q) => ({
    list: q.list.map(x => ({ id: x.id, name: x.name, size: x.size, filled: x.filled, total: x.total, missing: x.missing, anomaly: x.anomaly, anomalyLabel: x.anomalyLabel, birthDate: x.birthDate })),
    total: q.total, minSize: q.minSize, anomalies: q.anomalies, anomalyList: q.anomalyList.map(x => x.name),
    deceasedCount: q.deceasedCount, deceasedList: q.deceasedList,
});
/** V1 `toastLogGet()` 的 `{kind,title,text}` → V2 `notifyHooks.toast(text, kind)` 的 `[kind, 'title text']`
 *  （V1 `notify('repair', …)` 的 toastr 类型是 warning；V2 notifyHooks 只认 info/success/warning/error） */
const wfToasts = (list) => list.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);
/** 单次点路径写入（不改动输入对象） */
const setP = (mut, path, val, opts) => {
    const s = clone(mut);
    const r = setSnapshotByPath(s, path, val, opts);
    return { r, s };
};

// ============================================================
// C 组：角色修复内核 —— 与 V1 逐项比对
// ============================================================
R.assert('C1 snapshotAtomSize：有效正文字数（去空白）+ 字段填充数 + 缺失清单；optional 字段「身份.已去世」不参与统计 —— 5 条档案逐条与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const got = (state.snapshots || []).map(s => [s.name, snapshotAtomSize(s)]);
    state.snapshots[0].identity.deceased = true;
    return J(got) === J(G.atomSize) && J(snapshotAtomSize(state.snapshots[0])) === J(G.atomSizeDeceased)
        && got[0][1].total === 19 && SNAP_REPAIR_FIELDS.length === 20
        && SNAP_REPAIR_FIELD_MAP['身份.已去世'].optional === true;
})(), G.atomSize);

R.assert('C2 buildCharacterRepairQueue：字数门限筛选 + 出生日期异常优先档（无视门限、排在最前）+ 已去世整批跳过 + total/anomalies/deceased 计数 —— 与 V1 一致；门限 0 时全量入列', (() => {
    boot(G.inputs.scenario);
    const q = queueView(buildCharacterRepairQueue());
    const minSize = cfg.repairCharacterMinSize;
    cfg.repairCharacterMinSize = 0;
    const qAll = queueView(buildCharacterRepairQueue());
    cfg.repairCharacterMinSize = minSize;
    return J(q) === J(G.queue) && J(qAll) === J(G.queueAll)
        && q.list[0].name === '角色丁' && q.list[0].anomaly === 'bad-format'
        && q.deceasedCount === 1 && q.deceasedList[0] === '已故者' && q.anomalies === 1;
})(), G.queue);

R.assert('C3 机械处理（零 AI）：correctSnapshotBirthDates（缺失跳过 / 已就绪不动 / 格式非法重推 / 已去世跳过）与 runCharacterMechanicalPass（出生日期校正 + 标签补充 + 年龄刷新）逐字段与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const mech = runCharacterMechanicalPass();
    const mechSnaps = (state.snapshots || []).map(x => ({ name: x.name, identity: x.identity, tags: x.tags }));
    boot(G.inputs.scenario);
    const cb = correctSnapshotBirthDates();
    boot(G.inputs.scenario);
    runCharacterMechanicalPass();
    const after = buildCharacterRepairQueue().list.map(x => [x.name, x.size, x.filled, x.anomaly]);
    return J(mech) === J(G.mechPass) && J(mechSnaps) === J(G.mechSnapshots)
        && J(cb) === J(G.correctBirth) && J(after) === J(G.afterMechQueue)
        && mech.deceased === 1 && mech.birth.corrected === 1 && mech.tags.filled === 1 && after[1][3] === '';
})(), G.mechPass);

R.assert('C4 setSnapshotByPath 类型分支：str 只填空（已填不改）· 空话占位拒收 · 英文别名还原 · arr 只填空 · tags 并集 · rel 拒收 · bool 只「标记为已去世」 · 非法路径 —— 与 V1 逐字段一致', (() => {
    boot(G.inputs.scenario);
    const got = {
        strFill: setP({ identity: { gender: '' }, tags: [] }, '身份.性别', '女'),
        strFilled: setP({ identity: { gender: '男' }, tags: [] }, '身份.性别', '女'),
        strPlaceholder: setP({ identity: {} }, '身份.性别', '未知'),
        strAlias: setP({ identity: {} }, 'appearance', '高个'),
        strShort: setP({ identity: {} }, '身份.性别', 'x'),
        arrEmpty: setP({ personality: {} }, '性格.性格特质', ['谨慎', '沉稳', '谨慎']),
        arrFilled: setP({ personality: { traits: ['谨慎'] } }, '性格.性格特质', ['沉稳']),
        arrEmptyVal: setP({ personality: {} }, '性格.性格特质', []),
        tagsUnion: setP({ tags: ['甲', '乙'] }, '标签', ['乙', '丙']),
        tagsEmpty: setP({ tags: ['甲'] }, '标签', ''),
        relRejected: setP({ relationships: [] }, '关系列表', [{ name: '角色甲' }]),
        boolTrue: setP({ identity: {} }, '身份.已去世', '是'),
        boolFalse: setP({ identity: {} }, '身份.已去世', false),
        boolAlready: setP({ identity: { deceased: true } }, '身份.已去世', true),
        badPath: setP({ identity: {} }, '不存在的路径', 'x'),
        birthBc: setP({ identity: {} }, '身份.出生日期', '公元前221年1月2日'),
        birthFuture: setP({ identity: {} }, '身份.出生日期', '2100-01-01'),
        birthOverwriteBlocked: setP({ identity: { birthDate: '1900-01-01' } }, '身份.出生日期', '1880-05-06', { allowOverwrite: true }),
        birthOverwriteAllowed: setP({ identity: { birthDate: '1910-01-01' }, tags: [] }, '身份.出生日期', '1880-05-06', { allowOverwrite: true }),
        birthOverwriteBad: setP({ identity: { birthDate: '1910-01-01' } }, '身份.出生日期', '约1880年', { allowOverwrite: true }),
        noSnap: { r: setSnapshotByPath(null, '身份.性别', '男'), s: null },
    };
    return J(got) === J(G.setPath) && got.birthBc.s.identity.birthDate === '-0221-01-02'
        && got.birthFuture.r.reason === 'futureBirth' && got.birthOverwriteBad.r.reason === 'badFormatBirth'
        && got.arrEmpty.s.personality.traits.length === 2 && got.tagsUnion.s.tags.length === 3;
})(), G.setPath);

R.assert('C5 characterEvidencePack：按姓名从情节/记忆/状态/物品/关联层捞取「相关原子数据」，按时间从新到旧排序、单条 ≤160 字；无命中返回空 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const ev = characterEvidencePack('角色乙');
    const none = characterEvidencePack('查无此人');
    return J(ev) === J(G.evidence) && J(none) === J(G.evidenceNone)
        && ev.total === 6 && ev.lines[0].indexOf('[情节] 2020-01-05') === 0
        && ev.lines.some(x => x.indexOf('[关联·participant]') === 0) && none.total === 0;
})(), G.evidence);

R.assert('C6 buildCharacterRepairPrompt：目标顺序（异常优先 → 字数升序）+ system/user 两条消息**逐字符**与 V1 一致（当前剧情日期行 / ⚠️ 异常点名 / 现有字段 / 缺失清单 / 相关原子数据 / 近期正文 / 输出契约）', (() => {
    boot(G.inputs.scenario);
    const q = buildCharacterRepairQueue();
    const targets = q.list.slice(0, 3);
    const got = buildCharacterRepairPrompt(targets);
    return J(targets.map(t => t.name)) === J(G.promptTargets) && J(got) === J(G.prompt)
        && got.length === 2 && got[0].role === 'system' && got[1].role === 'user'
        && got[1].content.indexOf('【当前剧情日期】2020-06-01') >= 0
        && got[1].content.indexOf('⚠️ 出生日期异常') >= 0
        && got[1].content.indexOf('相关记忆原子数据') >= 0;
})(), G.prompt[1].content.slice(0, 200));

R.assert('C7 buildCharacterRepairPrompt 加强轮（strict）：在用户消息首部追加「【加强轮】…再次空手返回视为任务失败。」—— 其余内容与普通轮逐字符一致（V2 编排断言）', (() => {
    boot(G.inputs.scenario);
    const targets = buildCharacterRepairQueue().list.slice(0, 3);
    const strict = buildCharacterRepairPrompt(targets, { strict: true });
    const plain = buildCharacterRepairPrompt(targets);
    return J(strict) === J(G.promptStrict)
        && strict[1].content.indexOf('【加强轮】') === 0
        && strict[1].content.slice(strict[1].content.indexOf('\n\n') + 2) === plain[1].content
        && strict[0].content === plain[0].content;
})(), G.promptStrict[1].content.slice(0, 200));

R.assert('C8 applyCharacterRepairResult：按「姓名 + 中文点路径」精确应用（只填空、已填不改）、英文别名还原、出生日期兜底推测、档案更新时间戳与年龄重算、推断/无依据/未知角色计数 —— 与 V1 逐字段一致', (() => {
    boot(G.inputs.scenario);
    const targets = buildCharacterRepairQueue().list.slice(0, 3);
    const delta = normalizeDeltaKeys(clone(G.inputs.applyDeltaRaw));
    const normalizedOk = J(delta) === J(G.applyDeltaNormalized);
    const ra = applyCharacterRepairResult(delta, targets);
    const got = { r: ra, snapshots: snaps(), states: statesView(), tombs: snapTombs() };
    const k1 = (state.snapshots || []).find(x => x.id === 'k1');
    return normalizedOk && J(got) === J(G.apply)
        && ra.rolesChanged === 2 && ra.changed === 4 && ra.unknownRole === 1 && ra.invalid === 0
        && k1.identity.gender === '男' && k1.identity.age === '120'
        && k1.background.origin === '海家' && k1.lastUpdateDate === '2020-06-01'
        && k1.tags.length === 3;
})(), G.apply.r);

R.assert('C9 applyCharacterRepairResult 删除明显错误条目：档案移除 + **状态记录联动清除** + 写入删除墓碑 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const targets = buildCharacterRepairQueue().list.slice(0, 5);
    const rd = applyCharacterRepairResult(normalizeDeltaKeys({ '角色档案': { '更新': [], '删除': ['已故者'] } }), targets);
    const got = { r: rd, names: (state.snapshots || []).map(x => x.name), states: (state.currentStates || []).map(x => x.subject), tombs: snapTombs() };
    return J(got) === J(G.applyRemove) && rd.removed === 1
        && (state.snapshots || []).every(x => x.name !== '已故者')
        && (state.currentStates || []).every(x => x.subject !== '已故者')
        && snapTombs().indexOf('已故者') >= 0;
})(), G.applyRemove.r);

// ============================================================
// P 组：V2 编排（runCharacterRepair 全链路）
// ============================================================
await A('P1 runCharacterRepair 全链路：① 全局机械处理 → ② 待修复名单 → ③ 窄契约 AI（桩）→ ④ 姓名+点路径精确应用 → ⑤ 出生/标签兜底 + 年龄刷新 —— 返回结构 / 档案 / 状态 / 通知文案与 V1 逐项一致', async () => {
    boot(G.inputs.scenario);
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { characterRepair: '（测试用角色修复模板）' });
    aiText = JSON.stringify(G.inputs.ai);
    const r = await runCharacterRepair();
    const got = {
        res: {
            made: r.made, targets: r.targets, attempts: r.attempts, changed: r.changed, rolesChanged: r.rolesChanged,
            inferred: r.inferred, removed: r.removed, noBasis: r.noBasis, invalid: r.invalid, queueLeft: r.queueLeft,
            mech: r.mech, ageSync: r.ageSync, keys: Object.keys(r).sort(),
        },
        snapshots: snaps(), states: (state.currentStates || []).map(x => x.subject), toasts, aiCalls,
    };
    const want = clone(G.run); want.toasts = wfToasts(G.run.toasts);
    return J(got) === J(want) && aiCalls === 1 && r.made === 1 && r.rolesChanged === 2
        && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('已去世 1 名跳过（年龄锁定）') >= 0;
}, G.run.res);

await A('P2 runCharacterRepair AI 空手而归：自动**加强重试一轮**（strict 提示词，同批目标、共 2 次 AI），出生日期兜底仍产生 1 个字段 —— 返回结构与 V1 一致', async () => {
    boot(G.inputs.scenario);
    aiText = '{}';
    const r = await runCharacterRepair();
    const got = {
        res: {
            made: r.made, targets: r.targets, attempts: r.attempts, noBasis: r.noBasis, inferred: r.inferred,
            invalid: r.invalid, queueLeft: r.queueLeft, mech: r.mech, ageSync: r.ageSync, keys: Object.keys(r).sort(),
        },
        toasts, aiCalls,
    };
    const want = clone(G.runNone); want.toasts = wfToasts(G.runNone.toasts);
    return J(got) === J(want) && aiCalls === 2 && r.attempts === 2 && r.made === 1
        && String(toasts[1][1]).indexOf('AI 加强重试 2 轮') >= 0;
}, G.runNone.res);

await A('P3 runCharacterRepair 两轮零落库且出生/标签均已就绪：走 warning 分支回报 noChange（不虚报成功），AI 调用 2 次', async () => {
    boot(G.inputs.scenario);
    state.snapshots = [{ id: 'n1', name: '角色戊', identity: { birthDate: '1970-02-03', gender: '男' }, tags: ['村民', '渔民', '中年'], uses: 1 }];
    state.currentStates = []; state.atoms = []; state.memories = []; state.items = []; state.links = [];
    aiText = '{}';
    const r = await runCharacterRepair();
    const got = {
        res: {
            made: r.made, noChange: r.noChange, targets: r.targets, attempts: r.attempts, noBasis: r.noBasis,
            inferred: r.inferred, invalid: r.invalid, queueLeft: r.queueLeft, ageSync: r.ageSync, keys: Object.keys(r).sort(),
        },
        snapshots: snaps(), toasts, aiCalls,
    };
    const want = clone(G.runNoChange); want.toasts = wfToasts(G.runNoChange.toasts);
    return J(got) === J(want) && aiCalls === 2 && r.made === 0 && r.noChange === true
        && toasts[1][0] === 'warning' && String(toasts[1][1]).indexOf('本轮未产生实际变化') >= 0;
}, G.runNoChange.res);

await A('P4 runCharacterRepair 空库：直接返回 skipped 并提示先产生角色档案（不触发 AI / 不写墓碑）', async () => {
    boot({});
    const r = await runCharacterRepair();
    return J(r) === J(G.runEmpty.res) && J(toasts) === J(wfToasts(G.runEmpty.toasts))
        && r.made === 0 && r.skipped === true && aiCalls === 0
        && String(toasts[0][1]).indexOf('暂无角色') >= 0;
}, G.runEmpty.res);

await A('P5 runCharacterRepair 长任务在途拒绝（aiBusy 互斥语义，同 core/repair.js#runRepair）：返回 blocked，不改动任何数据', async () => {
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: '{}' }; }, feedText: () => G.feedText, busy: () => true });
    const before = J(snaps());
    const r = await runCharacterRepair();
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => G.feedText, busy: () => false });
    return r.made === 0 && r.blocked === true && J(snaps()) === before && aiCalls === 0
        && toasts.length === 1 && toasts[0][0] === 'warning' && String(toasts[0][1]).indexOf('修复进行中') >= 0;
}, '');

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 角色分页渲染 V1 同款「🔧 修复角色」按钮：有角色时显示、无角色时隐藏；出生日期异常角色数进优先档 → 文案带「（⚠️N 优先）」（无异常则不带）', (() => {
    boot(G.inputs.scenario);
    openPanel('snapshots'); setPanelHooks2({});
    const html = panelBodyHtml('snapshots');
    const hasBtn = html.indexOf('data-ftt-action="characterRepair"') >= 0
        && html.indexOf('title="出生日期倒挂者优先，其余按字数最薄弱 3 条"') >= 0
        && html.indexOf('🔧 修复角色（⚠️2 优先）') >= 0;      // 角色丁（格式非法）+ 已故者（年龄超 120）
    boot({ snapshots: [{ id: 'x1', name: '角色己', identity: { birthDate: '1990-01-01' }, tags: ['甲', '乙', '丙'], uses: 1 }] });
    openPanel('snapshots'); setPanelHooks2({});
    const noAnom = panelBodyHtml('snapshots');
    boot({ snapshots: [] });
    openPanel('snapshots');
    const empty = panelBodyHtml('snapshots');
    return hasBtn && noAnom.indexOf('🔧 修复角色<') >= 0 && noAnom.indexOf('⚠️') < 0
        && empty.indexOf('data-ftt-action="characterRepair"') < 0;
})(), '');

await A('U2 面板动作 characterRepair 可达：走 runCharacterRepair 全链路并把结果写回面板 note（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenario);
    aiText = JSON.stringify(G.inputs.ai);
    openPanel('snapshots'); setPanelHooks2({});
    const r = await panelAction('characterRepair', {});
    const st = panelState();
    const note = String(st.note || '');
    return r.ok === true && !!r.characterRepair && r.made === 1 && r.action === 'characterRepair' && aiCalls === 1
        && note.indexOf('角色修复：') >= 0 && note.indexOf('目标 3 名') >= 0 && note.indexOf('补全 2 名 / 6 个字段') >= 0;
}, '');

R.assert('U3 FTT 调试入口齐备：snapRepairFields / snapRepairFieldMap / snapshotAtomSize / characterRepairQueue / setSnapshotByPath / characterRepairPrompt / characterRepairApply / characterRepair / characterEvidencePack / ensureSnapshotTags / deriveSnapshotTags / characterMechanicalPass / correctSnapshotBirthDates', (() => {
    boot(G.inputs.scenario);
    const on = installDevtools({
        snapRepairFields: () => SNAP_REPAIR_FIELDS,
        snapRepairFieldMap: () => SNAP_REPAIR_FIELD_MAP,
        snapshotAtomSize: (s) => snapshotAtomSize(s),
        characterRepairQueue: () => buildCharacterRepairQueue(),
        setSnapshotByPath: (s, p, v, o) => setSnapshotByPath(s, p, v, o),
        characterRepairPrompt: (t, o) => buildCharacterRepairPrompt(t, o),
        characterRepairApply: (d, t) => applyCharacterRepairResult(d, t),
        characterRepair: (o) => runCharacterRepair(o),
        characterEvidencePack: (n, o) => characterEvidencePack(n, o),
        ensureSnapshotTags: (s) => ensureSnapshotTags(s),
        deriveSnapshotTags: (s, o) => deriveSnapshotTags(s, o),
        characterMechanicalPass: (o) => runCharacterMechanicalPass(o),
        correctSnapshotBirthDates: (o) => correctSnapshotBirthDates(o),
    });
    const F = globalThis.FTT;
    const fields = F.snapRepairFields();
    const q = F.characterRepairQueue();
    const t0 = q.list.filter(x => x.name === '角色甲')[0];
    const targets = [t0];
    const prompt = F.characterRepairPrompt(targets);
    const applied = F.characterRepairApply(normalizeDeltaKeys({ '角色档案': { '更新': [{ '姓名': '角色甲', '补全': { '身份.性别': '男', '不存在的路径': 'x' } }] } }), targets);
    const ev = F.characterEvidencePack('角色乙');
    const atom = F.snapshotAtomSize(state.snapshots.find(x => x.name === '角色甲'));
    const mech = F.characterMechanicalPass();
    const tags = F.deriveSnapshotTags({ name: '角色庚', identity: { occupation: '船医' }, tags: [] });
    const et = F.ensureSnapshotTags({ name: '角色庚', identity: { occupation: '船医' }, tags: [] });
    const one = F.setSnapshotByPath({ identity: {} }, '身份.种族', '人类');
    const ok = on === true && Array.isArray(fields) && fields.length === 20 && !!F.snapRepairFieldMap()['身份.性别']
        && q.list.length === 4 && q.anomalyList.length === 1 && q.deceasedList[0] === '已故者'
        && Array.isArray(prompt) && prompt.length === 2 && prompt[0].role === 'system'
        && applied.invalid === 1 && applied.rolesChanged === 1 && applied.changed >= 1
        && (state.snapshots.find(x => x.name === '角色甲').identity.gender === '男')
        && atom.total === 19 && ev.total === 6 && !!mech && Number(mech.total) === 5
        && Array.isArray(tags) && tags.indexOf('船医') >= 0 && et.changed === true
        && one.ok === true && one.changed === true
        && typeof F.characterRepair === 'function' && typeof F.characterEvidencePack === 'function';
    uninstallDevtools();
    return ok && globalThis.FTT === undefined;
})(), '');

await A('U4 FTT.characterRepair 无 hook 时按约定降级（不抛错），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenario);
    installDevtools({});
    const noHook = await globalThis.FTT.characterRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenario);
    installDevtools({ characterRepair: (o) => runCharacterRepair(o) });
    const r = await globalThis.FTT.characterRepair({ aiText: JSON.stringify(G.inputs.ai) });
    uninstallDevtools();
    return degraded && r.made === 1 && r.changed === 6;
}, '');

un();
R.done();
