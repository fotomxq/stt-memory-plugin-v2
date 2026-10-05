// ============================================================
// 单元测试 · v3.18.0「角色修复：已明显去世的角色标记『已去世』」
// 用户要求（原话）：「角色修复功能，针对已明显去世的角色进行标记已去世，避免反复调取处理。
//   注意个别可能存在超长寿命的角色，需结合剧情研判，实在无法确认的不做标记。」
//
// 口径（保守优先，**默认不标记**）：
//   · 证据 = 该角色**档案自身字段** + `characterEvidencePack()` 收集的**相关原子数据**（情节 / 记忆 / 状态 / …）；
//   · 只有「**本人**在句中被明确判定死亡」才算：名字须在死亡词**之前 16 字内**，且中间无亲属/同伴主语、
//     无否定 / 幸存 / 假死表述；
//   · **长寿命语境**（长生 / 不死 / 精灵 / 妖族 / 修真 / 神明 / 转世 …）→ 必须出现**终局**措辞
//     （形神俱灭 / 魂飞魄散 / 彻底死亡 …）才标记，否则只报「待确认」、**不标记**；
//   · 判不出 → 不标记；标记**只增不减**（取消请在编辑器取消勾选）。
// 覆盖：
//   A 组 判级（本人死亡 / 长寿命 / 他人死亡 / 否定假死 / 相关原子数据佐证 / 已标记短路）；
//   B 组 标记与联动（幂等、队列跳过、年龄锁定、只增不减、文案）；
//   C 组 机械总入口接线（返回结构不含新键 → V1 黄金样本口径不变；`lastDeceasedMark()` 可读；AI 名单自动排除）；
//   D 组 AI 守则（默认不追加 → 逐字不变；`deathGuide` 才追加）；
//   E 组 调试干跑（`FTT.deceasedScan()` 只读不标记）。
// 运行：node tests/unit/character-deceased.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';
import {
    snapshotDeathVerdict, markDeceasedByEvidence, deceasedMarkText, lastDeceasedMark,
    buildCharacterRepairQueue, runCharacterMechanicalPass, runCharacterRepair,
    buildCharacterRepairPrompt, deathSentenceJudge, DEATH_WORDS, LONG_LIFE_WORDS,
} from '../../core/character-repair.js';

const R = makeReporter('character-deceased v3.18.0 已去世研判与标记');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(makeHost({}), doc);

let toasts = [];
let aiText = '{}';
let aiCalls = 0;
function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.repairCharacterMinSize = 30; cfg.repairCharacterBatch = 3; cfg.repairFloors = 10;
    setScopeKey('char:deceased');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    aiText = '{}'; aiCalls = 0;
    setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => '', busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    return state;
}
const snap = (name, history, extra) => Object.assign({ id: 'sn_' + name, name: name, tags: [], background: { history: history } }, extra || {});
const verdict = (s) => snapshotDeathVerdict(s).verdict;

// ---------- A 组：判级 ----------
A('A1 本人明确死亡（阵亡 / 去世 / 被杀 / 遇害 / 殉职）→ `dead`；证据取句子原文（可核对）', (() => {
    const cases = [
        '角色甲在最后的战斗中阵亡，同伴将他葬在江边。',
        '角色甲于归途中遇害，遗体被送回城中。',
        '角色甲病逝于三年后的冬天。',
    ];
    return cases.every((t) => verdict(snap('角色甲', t)) === 'dead')
        && snapshotDeathVerdict(snap('角色甲', cases[0])).evidence.indexOf('阵亡') > 0
        && DEATH_WORDS.indexOf('阵亡') >= 0 && DEATH_WORDS.indexOf('死士') < 0;
})(), () => DEATH_WORDS.length);

A('A2 **长寿命角色**（精灵 / 妖族 / 修真 / 不死 / 转世 …）：无终局描写一律**不标记**（none / uncertain）', (() => {
    const elf = snap('精灵乙', '精灵乙活了千年，据说永生不死；这一次他在乱战中阵亡。', { identity: { species: '精灵' } });
    const ghost = snap('鬼修丙', '鬼修丙早已死去，却又从轮回中归来。', { identity: { species: '鬼修' } });
    const v1 = snapshotDeathVerdict(elf), v2 = snapshotDeathVerdict(ghost);
    return snapshotDeathVerdict(snap('精灵乙', '精灵乙活了千年，据说永生不死。', { identity: { species: '精灵' } })).verdict === 'none'
        && v1.verdict === 'uncertain' && v1.reason === 'long-life-unconfirmed' && v1.longLife === true
        && v2.verdict === 'uncertain' && LONG_LIFE_WORDS.indexOf('精灵') >= 0 && LONG_LIFE_WORDS.indexOf('转世') >= 0;
})(), () => ({ elf: snapshotDeathVerdict(snap('精灵乙', '精灵乙活了千年，据说永生不死；这一次他在乱战中阵亡。', { identity: { species: '精灵' } })) }));

A('A3 「本人」邻接才算：名字在死亡词之后 / 中间夹亲属或同伴主语 → 不算（他人之死绝不标记）', (() => {
    const cases = [
        '角色丁目睹其父去世，从此沉默寡言。',
        '阵亡的将士里，有一个是角色丁的兄长。',
        '角色丁的同伴在渡口被杀，他独自逃了出来。',
        '角色丁的母亲早已病逝。',
    ];
    return cases.every((t) => verdict(snap('角色丁', t)) !== 'dead')
        && deathSentenceJudge('角色丁目睹其父去世', '角色丁', false).why === 'third-party'
        && deathSentenceJudge('阵亡的将士里有角色丁', '角色丁', false).why === 'name-after';
})(), () => deathSentenceJudge('角色丁目睹其父去世', '角色丁', false));

A('A4 否定 / 幸存 / 假死 / 生死不明 → 不标记（`negated` 或证据不足）', (() => {
    const cases = [
        '大家都以为角色戊已死，其实他死里逃生，并未身亡。',
        '角色戊没有死，只是重伤昏迷。',
        '角色戊的下落不明，无人知道他是否还活着。',
    ];
    return cases.every((t) => verdict(snap('角色戊', t)) === 'none')
        && deathSentenceJudge('角色戊已死，其实他死里逃生', '角色戊', false).why === 'negated'
        && verdict(snap('角色戊', '角色戊还活着，正在码头清点货物。')) === 'none';
})(), () => deathSentenceJudge('角色戊已死，其实他死里逃生', '角色戊', false));

A('A5 结合剧情研判：死亡结论只出现在**相关原子数据**（情节 / 记忆）里也能判出（含 entities 命中的情节）', (() => {
    boot({
        snapshots: [snap('角色己', '角色己是城里的铁匠，手艺很好。')],
        atoms: [{ id: 'a1', title: '城破', text: '城破那日，角色己在城头战死，尸首被同乡收敛。', date: '1919-05-01', entities: ['角色己'], tags: [] }],
        memories: [{ id: 'm1', title: '旧事', owner: '角色己', content: '角色己临终前把打铁铺托付给了邻居。', date: '1919-05-02' }],
    });
    const v = snapshotDeathVerdict(state.snapshots[0], { max: 10 });
    return v.verdict === 'dead' && v.hits >= 1 && v.scanned >= 2;
})(), () => snapshotDeathVerdict(state.snapshots[0], { max: 10 }));

A('A6 已标记（`身份.已去世 = true`）→ 短路 `already-marked`（避免反复研判与调取）', (() => {
    boot({ snapshots: [snap('角色庚', '角色庚已去世。', { identity: { deceased: true } })] });
    const v = snapshotDeathVerdict(state.snapshots[0]);
    const stat = markDeceasedByEvidence({ silent: true });
    return v.verdict === 'none' && v.reason === 'already-marked'
        && stat.scanned === 1 && stat.skipped === 1 && stat.marked === 0;
})(), '见断言');

// ---------- B 组：标记与联动 ----------
A('B1 标记：`dead` → 写 `identity.deceased = true`；`uncertain` / 无证据不动；**幂等**（第二次零标记）', (() => {
    boot({
        snapshots: [
            snap('角色甲', '角色甲在最后的战斗中阵亡。'),
            snap('精灵乙', '精灵乙活了千年，据说永生不死；这一次他在乱战中阵亡。', { identity: { species: '精灵' } }),
            snap('角色丙', '角色丙仍在码头清点货物。'),
        ],
    });
    const s1 = markDeceasedByEvidence({ silent: true });
    const s2 = markDeceasedByEvidence({ silent: true });
    const byName = (n) => (state.snapshots.filter((x) => x.name === n)[0] || {}).identity || {};
    return s1.scanned === 3 && s1.marked === 1 && s1.uncertain === 1
        && byName('角色甲').deceased === true && byName('精灵乙').deceased === undefined && byName('角色丙').deceased === undefined
        && s2.marked === 0 && s2.skipped === 1                     // 已标记的短路，其余仍不误标
        && state.snapshots.length === 3;                            // 绝不删条目
})(), () => markDeceasedByEvidence({ silent: true }));

A('B2 标记后**修复名单跳过**（避免反复调取处理）：`buildCharacterRepairQueue` 不计入已去世者，且年龄锁定', (() => {
    boot({ snapshots: [snap('角色甲', '角色甲在最后的战斗中阵亡。'), snap('角色丙', '角色丙是铁匠。')] });
    markDeceasedByEvidence({ silent: true });
    const q = buildCharacterRepairQueue();
    const mech = runCharacterMechanicalPass();
    const dead = state.snapshots.filter((x) => x.name === '角色甲')[0];
    return q.deceasedCount === 1 && q.deceasedList.indexOf('角色甲') >= 0
        && q.list.every((x) => x.name !== '角色甲')
        && q.list.some((x) => x.name === '角色丙')
        && mech.deceased === 1 && dead.identity.birthSource !== 'fallback';       // 已去世 → 出生日期不再被兜底
})(), () => ({ q: buildCharacterRepairQueue().deceasedList, mech: runCharacterMechanicalPass() }));

A('B3 报告文案：新标记 / 待确认都写明（名字可核对），无情况时为空串', (() => {
    boot({
        snapshots: [
            snap('角色甲', '角色甲在最后的战斗中阵亡。'),
            snap('精灵乙', '精灵乙活了千年，据说永生不死；这一次他在乱战中阵亡。', { identity: { species: '精灵' } }),
        ],
    });
    const stat = markDeceasedByEvidence({ silent: true });
    const txt = deceasedMarkText(stat);
    return txt.indexOf('新标记已去世 1 名') === 0 && txt.indexOf('角色甲') > 0
        && txt.indexOf('待确认 1 名') > 0 && txt.indexOf('精灵乙') > 0
        && deceasedMarkText({ marked: 0, uncertain: 0 }) === '';
})(), () => deceasedMarkText(markDeceasedByEvidence({ silent: true })));

A('B4 **只增不减**：已标记的不会因为正文里出现「复活 / 假死」而被取消（标记只由编辑器取消）', (() => {
    boot({ snapshots: [snap('角色甲', '角色甲后来死而复生，传闻他假死脱身。', { identity: { deceased: true } })] });
    markDeceasedByEvidence({ silent: true });
    return state.snapshots[0].identity.deceased === true;
})(), () => state.snapshots[0].identity);

A('B5 用户核心要求回归：**超长寿命角色不被标记**（精灵 / 妖兽 / 修真 / 不死之身 各一例）', (() => {
    boot({
        snapshots: [
            snap('精灵乙', '精灵乙在乱战中阵亡。', { identity: { species: '精灵' } }),
            snap('妖兽丙', '妖兽丙被斩于山门之前。', { identity: { species: '妖族' } }),
            snap('修士丁', '修士丁的肉身被毁，元神遁走。', { identity: { occupation: '修士' } }),
            snap('不死者戊', '不死者戊被人斩首，随后又站了起来。', { identity: { species: '不死之身' } }),
        ],
    });
    const stat = markDeceasedByEvidence({ silent: true });
    return stat.marked === 0 && stat.uncertain >= 1 && state.snapshots.every((s) => !(s.identity || {}).deceased);
})(), () => markDeceasedByEvidence({ silent: true }));

// ---------- C 组：机械总入口接线 ----------
A('C1 `runCharacterMechanicalPass()` 返回结构键集固定（V1 黄金样本口径 + v1.205 `deceased` + v3.22.0 `immortal`），研判结果经 `lastDeceasedMark()` 读取', (() => {
    boot({ snapshots: [snap('角色甲', '角色甲在最后的战斗中阵亡。')] });
    const mech = runCharacterMechanicalPass();
    const keys = Object.keys(mech).sort();
    const death = lastDeceasedMark();
    // v3.22.0：「长生者」跳过计数进结构（与 v1.205 的 `deceased` 同款 —— 供通知如实说明跳过原因）
    return J(keys) === J(['ages', 'anomalies', 'birth', 'changed', 'deceased', 'immortal', 'tags', 'total'])
        && mech.changed === true && Number(mech.immortal) === 0 && death && death.marked === 1 && death.markedNames[0] === '角色甲';
})(), () => Object.keys(runCharacterMechanicalPass()).sort());

await (async () => {
    const C2 = await (async () => {
        boot({
            snapshots: [snap('角色甲', '角色甲在最后的战斗中阵亡。'), snap('角色丙', '角色丙是铁匠。')],
        });
        let seenTargets = '';
        setAiHooks({
            callAi: async (prompt) => {
                aiCalls++;
                try { seenTargets = String((prompt && prompt[1] && prompt[1].content) || ''); } catch (e) { /* 忽略 */ }
                return { ok: true, text: '{"角色档案":{"更新":[{"姓名":"角色丙","补全":{"身份.职业":"铁匠"}}]}}' };
            },
            feedText: () => '', busy: () => false,
        });
        const r = await runCharacterRepair({});
        const notifyText = toasts.map((x) => x[1]).join(' ｜ ');
        return {
            ok: r.made === 1 && seenTargets.indexOf('角色甲') < 0 && seenTargets.indexOf('角色丙') >= 0
                && notifyText.indexOf('新标记已去世 1 名') > 0,
            r: r, targets: seenTargets.slice(0, 120), notify: notifyText.slice(0, 240),
        };
    })();
    A('C2 `runCharacterRepair` 端到端：新标记的已去世角色被排除在本轮 AI 目标之外，通知书写明「新标记已去世 N 名」', C2.ok, C2);
})();

// ---------- D 组：AI 守则 ----------
A('D1 提示词默认**不追加**守则（V1 逐字口径不变）；`deathGuide:true` 才追加保守判定守则', (() => {
    boot({ snapshots: [snap('角色甲', '角色甲在最后的战斗中阵亡。')] });
    const targets = buildCharacterRepairQueue().list.slice(0, 3);
    const plain = J(buildCharacterRepairPrompt(targets));
    const guided = buildCharacterRepairPrompt(targets, { deathGuide: true });
    const gtxt = String(guided[1].content);
    return plain.indexOf('已去世判定') < 0
        && gtxt.indexOf('【已去世判定（保守）】') === 0 && gtxt.indexOf('别人（父母 / 同伴 / 属下）的死不算') > 0
        && gtxt.indexOf('形神俱灭') > 0 && gtxt.indexOf('无法确认就不要输出该字段') > 0;
})(), '见断言');

// ---------- E 组：调试干跑 ----------
A('E1 `FTT.deceasedScan()`（调试导出）只读干跑：给出逐角色判级与证据，**不写任何标记**', (() => {
    boot({ snapshots: [snap('角色甲', '角色甲在最后的战斗中阵亡。'), snap('角色丙', '角色丙是铁匠。')] });
    installDevtools();
    const rows = globalThis.FTT.deceasedScan();
    const ok = Array.isArray(rows) && rows.length === 2 && rows[0].name === '角色甲' && rows[0].verdict === 'dead'
        && rows[1].verdict === 'none' && !!rows[0].evidence
        && state.snapshots.every((s) => !(s.identity || {}).deceased);
    uninstallDevtools();
    return ok;
})(), () => (globalThis.FTT ? globalThis.FTT.deceasedScan() : null));

R.done();
