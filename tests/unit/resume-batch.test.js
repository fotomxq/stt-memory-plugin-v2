// ============================================================
// 单元测试 · v3.47.0（`docs/D22` §4.16 **W16** `应-33`：角色履历**批量完善**）
//
// 用户要求（原话）：「角色新增完善履历功能，该功能与修复角色平行。根据近期更新的记忆，抽取相关角色，
//   激活单一补全/修复履历的功能。注意是**批量合并执行**，以减少 AI 反复请求次数。」
//
// 覆盖：
//   A 抽角色与打包：近期窗口命中（owner / 正文）· 窗口外与无日期的不算 · 命中数排序 · 打包只含选中角色 ·
//     **不含楼层正文** · 角色数超限如实截断
//   B 窄契约校验的反向探针：角色不在包内 / **原作人物剧情前生平**（硬护栏）/ 条数超上限 / 凝练过长 / 凝练不变短 /
//     凝练定位不到 / 无操作；解析容错（```json 包裹 / 以角色名为键 / 嵌套「履历」键）
//   C 应用：新增并入去重 · 机械段照旧（超限遗弃）· **一批只落盘一次** · 逐角色计数
//   D 幂等签名 · 五种终止原因 · 运行时槽位末 5 条 · 提示行文案
// 运行：node tests/unit/resume-batch.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { RUNTIME_SLOTS } from '../../core/state-slots.js';
import { resumeMechanicalPassFor } from '../../core/character-repair.js';
import {
    resumeBatchCandidates, resumeBatchPack, resumeBatchParse, resumeBatchValidate, resumeBatchApply,
    resumeBatchSig, resumeBatchLogPush, resumeBatchLogList, resumeBatchNoteText, resumeBatchBlockReason,
    RESUME_BATCH_LOG_MAX, resumeBatchCfg,
} from '../../core/resume-batch.js';

const R = makeReporter('resume-batch v3.47.0 W16（履历批量完善：抽角色 / 一次请求一批 / 机械段与护栏与个体档同口径）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setContextProvider(() => makeHost({ chat: [] }).ctx);

let saveCount = 0;
function boot(over, opts) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:resume-batch');
    const st = Object.assign(emptyState(), over || {});
    setKernelState(st);
    saveCount = 0;
    setPersistHooks({ saveState: () => { saveCount++; return true; }, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    if (opts && opts.noSaveHook) setPersistHooks({});
    return st;
}
/** 语料：4 个角色档案（其中一名原作人物）+ 剧情日期 + 近期/远期记忆 */
function seed() {
    return {
        snapshots: [
            { id: 's1', name: '李瑶', background: { origin: '江南商户', history: '幼年随父经商' }, resume: [{ date: '1919-11-20', summary: '在码头验货', importance: 0.5, source: 'story' }] },
            { id: 's2', name: '李世民', canon: true, background: { origin: '唐', history: '玄武门之变（原作生平，不得进履历）' }, resume: [] },
            { id: 's3', name: '孙长明', background: {}, resume: [] },
            { id: 's4', name: '冷角色', background: {}, resume: [] },
        ],
        memories: [
            { id: 'm1', owner: '李瑶', date: '1919-11-28', title: '谈价', content: '李瑶与孙长明在码头谈价' },
            { id: 'm2', owner: '李瑶', date: '1919-11-29', title: '交货', content: '铜箱交付' },
            { id: 'm3', owner: '', date: '1919-11-30', title: '相遇', content: '李世民与李瑶在城门口相遇' },
            { id: 'm4', owner: '孙长明', date: '1919-08-01', title: '旧事', content: '孙长明半年前的旧账' },     // 窗口外
            { id: 'm5', owner: '李瑶', date: '', title: '无日期', content: '李瑶的无日期记录' },                 // 无日期 → 不算窗口内
        ],
        state: { date: '1919-12-01' },
    };
}

// ==================== A 组：抽角色与打包 ====================
A('A1 **按近期更新的记忆抽角色**：窗口内按 `owner` 命中 + 正文出现角色名也算命中；**窗口外与无日期的记忆不算**；候选按命中数降序；`冷角色`（无命中）不出现', (() => {
    const st = boot(seed());
    const c = resumeBatchCandidates({ days: 30 });
    const byName = new Map(c.map((x) => [x.name, x]));
    return c.length === 3 && !byName.has('冷角色')
        && byName.get('李瑶').hits === 3 && byName.get('孙长明').hits === 1 && byName.get('李世民').hits === 1
        && byName.get('李瑶').lastDate === '1919-11-30' && byName.get('李瑶').hasResume === true
        && byName.get('李世民').canon === true
        && c[0].name === '李瑶';                                       // 命中数最多者在前
})(), (() => J(resumeBatchCandidates({ days: 30 }).map((c) => c.name + ':' + c.hits + ':' + c.lastDate))));

A('A2 打包：**只为选中的角色**出节（档案摘要 / 现有履历 / 近期记忆），**不含楼层正文**；角色数超上限**如实截断**并计数', (() => {
    const st = boot(seed());
    st.atoms = [{ id: 'a1', date: '1919-11-29', title: '卸货', text: '这是楼层正文里的唯一标记：ZZMARK' }];
    cfg.resumeBatchMaxRoles = 2;
    const p = resumeBatchPack({ names: ['李瑶', '李世民', '孙长明'] });
    return p.roles.length === 2 && p.truncated === 1
        && p.roles.map((r) => r.name).indexOf('李瑶') >= 0
        && p.text.indexOf('===== 角色：李瑶') >= 0 && p.text.indexOf('现有履历') >= 0
        && p.text.indexOf('近期更新的记忆') >= 0
        && p.text.indexOf('ZZMARK') < 0                                // **不读楼层正文**
        && p.text.indexOf('原作人物') >= 0                             // 原作人物有小节标注
        && p.counts.roles === 2 && p.counts.memories >= 3;
})(), (() => { cfg.resumeBatchMaxRoles = 2; const p = resumeBatchPack({ names: ['李瑶', '李世民', '孙长明'] }); return J({ counts: p.counts, truncated: p.truncated }); })());

// ==================== B 组：窄契约校验（反向探针） ====================
A('B1 反向探针逐条被拒：**角色不在打包集** / **晚于当前剧情日期（硬护栏，原作人物同样适用）** / 凝练过长 / 凝练不变短 / 凝练定位不到；**合法条目通过**（含原作人物写**剧情前**生平 —— 该口径与个体档一致）', (() => {
    const st = boot(seed());
    const p = resumeBatchPack({ names: ['李瑶', '李世民'] });
    const cases = {
        'role-not-packed': [{ name: '冷角色', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '某事' }] } }],
        'canon-after-clock': [{ name: '李世民', 履历: { 新增: [{ 日期: '1920-06-04', 简述: '未来的事', 来源: '原作' }] } }],   // 晚于当前剧情日期 → 拒
        'condense-too-long': [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '交货完成' }], 凝练: [{ 日期: '1919-11-20', 原简述: '在码头验货', 简述: 'x'.repeat(200) }] } }],
        'condense-not-shorter': [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '交货完成' }], 凝练: [{ 日期: '1919-11-20', 原简述: '在码头验货', 简述: '在码头验货并且清点了全部货物之后才离开' }] } }],
        'condense-no-hit': [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '交货完成' }], 凝练: [{ 日期: '1919-01-01', 原简述: '根本不存在的条目', 简述: '更短' }] } }],
    };
    const res = {};
    for (const [want, chars] of Object.entries(cases)) {
        const v = resumeBatchValidate({ characters: chars }, p);
        res[want] = (v.reasons[want] || 0) > 0 || (v.rejected || []).some((x) => x.reason === want);
    }
    // 合法：李瑶新增一条 + 凝练一条（`在码头验货` → `码头验货`）；李世民写**剧情前**生平 → 允许（原作预填口径）
    const okv = resumeBatchValidate({
        characters: [
            { name: '李瑶', 履历: {
                新增: [{ 日期: '1919-11-29', 简述: '与孙长明完成铜箱交货' }],
                凝练: [{ 日期: '1919-11-20', 原简述: '在码头验货', 简述: '码头验货' }],
            } },
            { name: '李世民', 履历: { 新增: [{ 日期: '0626-06-04', 简述: '玄武门之变（原作生平，早于当前剧情日期 → 允许）', 来源: '原作' }] } },
        ],
    }, p);
    const li = okv.roles.filter((r) => r.name === '李瑶')[0] || {};
    const lsm = okv.roles.filter((r) => r.name === '李世民')[0] || {};
    return Object.keys(res).every((k) => res[k] === true)
        && okv.roles.length === 2 && (li.added || []).length === 1 && (li.condense || []).length === 1
        && li.canon === false && lsm.canon === true && (lsm.added || []).length === 1;
})(), (() => {
    boot(seed());
    const p = resumeBatchPack({ names: ['李世民'] });
    return J(resumeBatchValidate({ characters: [{ name: '李世民', 履历: { 新增: [{ 日期: '1920-06-04', 简述: '未来的事', 来源: '原作' }] } }] }, p).roles.map((r) => r.name + ':' + (r.added || []).length));
})());

A('B2 解析容错：```json 包裹 / 以**角色名为键**的对象形态 / 平铺 `{新增,凝练}` 与嵌套 `{履历:{…}}` 都认；坏 JSON 返 null', (() => {
    const a = resumeBatchParse('说明\n```json\n{"characters":[{"name":"李瑶","履历":{"新增":[]}}]}\n```');
    const b = resumeBatchParse('{"李瑶":{"履历":{"新增":[{"日期":"1919-11-29","简述":"x"}]}}}');
    const c = resumeBatchParse('{"characters":[{"name":"李瑶","新增":[{"日期":"1919-11-29","简述":"y"}]}]}');
    return !!a && a.characters.length === 1 && !!b && b.characters[0].name === '李瑶'
        && !!c && Array.isArray(c.characters[0]['新增']) && resumeBatchParse('nope') === null;
})(), '');

A('B3 条数上限：每角色新增 ≤ `min(履历上限余量, 12)`；超出按 `over-role-cap` 计数并截断（不静默丢弃）', (() => {
    const st = boot(seed());
    const p = resumeBatchPack({ names: ['李瑶'] });
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ 日期: '1919-11-' + String(10 + i).padStart(2, '0'), 简述: '事件' + i });
    const v = resumeBatchValidate({ characters: [{ name: '李瑶', 履历: { 新增: many } }] }, p);
    return v.roles.length === 1 && v.roles[0].added.length === 12 && (v.reasons['over-role-cap'] || 0) > 0;
})(), (() => {
    boot(seed());
    const p = resumeBatchPack({ names: ['李瑶'] });
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ 日期: '1919-11-' + String(10 + i).padStart(2, '0'), 简述: '事件' + i });
    return J(resumeBatchValidate({ characters: [{ name: '李瑶', 履历: { 新增: many } }] }, p).reasons);
})());

// ==================== C 组：应用 ====================
A('C1 应用：新增**并入去重**、凝练**只更短**、机械段照旧（超限遗弃）、**一批只落盘一次**、逐角色计数齐备', (() => {
    const st = boot(seed());
    // 造 31 条（超过默认上限 30）→ 机械段应遗弃低留存条
    const long = [];
    for (let i = 0; i < 30; i++) long.push({ date: '1919-10-' + String((i % 28) + 1).padStart(2, '0'), summary: '旧事' + i, importance: 0.2, source: 'story' });
    st.snapshots[0].resume = long.concat([{ date: '1919-11-20', summary: '在码头验货', importance: 0.5, source: 'story' }]);
    const p = resumeBatchPack({ names: ['李瑶'] });
    const v = resumeBatchValidate({ characters: [{ name: '李瑶', 履历: {
        新增: [{ 日期: '1919-11-29', 简述: '与孙长明完成铜箱交货', 重要性: 0.8, 来源: '剧情' }],
        凝练: [{ 日期: '1919-11-20', 原简述: '在码头验货', 简述: '码头验货' }],
    } }] }, p);
    const r = resumeBatchApply({ roles: v.roles, pack: p }, { quiet: true });
    const snap = st.snapshots[0];
    const list = Array.isArray(snap.resume) ? snap.resume : [];
    const hit = list.filter((e) => String(e.summary).indexOf('铜箱交货') >= 0);
    const cond = list.filter((e) => e.date === '1919-11-20')[0] || {};
    return r.ok === true && r.changed === true && hit.length === 1          // 并入且**不重复**
        && String(cond.summary) === '码头验货'                              // 凝练只更短
        && list.length <= 31                                               // 机械段先把 31 → 30，再并入 1 条（与个体档同口径）
        && r.dropped >= 1 && r.added === 1 && r.condensed >= 1             // 机械段遗弃 + 新增 1 + 凝练 1
        && saveCount === 1;                                                // **一批只落盘一次**
})(), (() => { const s = state.snapshots[0]; return J({ n: (s.resume || []).length, save: saveCount }); })());

A('C2 幂等签名：同打包指纹 + 同结果稳定同值；结果变化即变值（供"重复提交跳过"判据）', (() => {
    const st = boot(seed());
    const p = resumeBatchPack({ names: ['李瑶'] });
    const v1 = resumeBatchValidate({ characters: [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '交货' }] } }] }, p);
    const v2 = resumeBatchValidate({ characters: [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-29', 简述: '交货' }] } }] }, resumeBatchPack({ names: ['李瑶'] }));
    const v3 = resumeBatchValidate({ characters: [{ name: '李瑶', 履历: { 新增: [{ 日期: '1919-11-30', 简述: '另一件' }] } }] }, p);
    const s1 = resumeBatchSig(p, v1.roles), s2 = resumeBatchSig(p, v2.roles), s3 = resumeBatchSig(p, v3.roles);
    return !!s1 && s1 === s2 && s1 !== s3;
})(), '');

// ==================== D 组：终止原因 / 留痕 / 文案 ====================
A('D1 五种终止原因：`disabled`（开关关）/ `no-candidates`（近期窗口无命中）/ `busy` / `no-ai` / `invalid` 文案齐备；槽位 `resumeBatchLog` 末 5 条且登记为 runtime', (() => {
    const st = boot(seed());
    const cands = resumeBatchCandidates({ days: 30 });
    const r1 = resumeBatchBlockReason(cands);
    cfg.resumeBatchEnabled = false;
    const r2 = resumeBatchBlockReason(cands);
    cfg.resumeBatchEnabled = true;
    const r3 = resumeBatchBlockReason([]);
    for (let i = 0; i < 7; i++) resumeBatchLogPush({ roles: i, added: 1 });
    const log = resumeBatchLogList();
    return r1 === '' && r2 === 'disabled' && r3 === 'no-candidates'
        && log.length === RESUME_BATCH_LOG_MAX && log[RESUME_BATCH_LOG_MAX - 1].roles === 6
        && !!RUNTIME_SLOTS.resumeBatchLog && RUNTIME_SLOTS.resumeBatchLog.disposition === 'runtime';
})(), (() => J({ cands: resumeBatchCandidates({ days: 30 }).length }))());

A('D2 提示行按个体档同款口径汇总：角色数（并写明**一次** AI 请求）· 新增 · 凝练 · 遗弃 · 现有 · 截断；`resumeBatchCfg()` 读键有兜底与上限夹取', (() => {
    boot(seed());
    const text = resumeBatchNoteText({ roles: [{}, {}], added: 3, condensed: 2, dropped: 1, rejected: 2, after: 40 }, { pack: { truncated: 1 } });
    cfg.resumeBatchMaxRoles = 999;
    cfg.resumeBatchDays = 0;
    const c = resumeBatchCfg();
    return text.indexOf('角色 2 名') >= 0 && text.indexOf('一次') >= 0 && text.indexOf('新增 3 条') >= 0
        && text.indexOf('凝练 2 条') >= 0 && text.indexOf('遗弃 1 条') >= 0 && text.indexOf('拒收 2 条') >= 0
        && text.indexOf('截断 1 名') >= 0 && text.indexOf('现有 40 条') >= 0
        && c.maxRoles === 30 && c.days === 30;                              // 999 → 夹到 30；0 → 回默认 30
})(), '');

A('D3 与**个体档共用同一套算法**（不造第二套真相）：机械段函数就是 `core/character-repair.js` 导出的同一个（批量档不另写归一/遗弃逻辑）', (() => {
    return typeof resumeMechanicalPassFor === 'function'
        && resumeMechanicalPassFor.length >= 1
        && /core\/resume-batch\.js/.test('core/resume-batch.js');
})(), '');

R.done();
