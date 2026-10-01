// ============================================================
// 单元测试 · v3.2.0「自动修复补充一步：清理无效关系」
//
// 用户要求（原话）：「设定的关系表，需要在自动修复中补充一个步骤，自动清理无效关系。」
//
// 口径（`core/rel-maint.js#cleanInvalidRelLinks`）——只清**结构上就没有意义**的关联行：
//   · `dangling` 目标条目不存在（与既有孤儿口径一致）
//   · `badDim`   `dim` 不在「记忆 / 计划 / 悬念 / 平行」
//   · `badRef`   `refId` 为空
//   · `empty`    无 `who` 且条目级属性与语义字段全空（纯空行）
//   · `ghost`    有 `who` 但不在**任何已知名册**（档案 / 名册 / 主角·玩家 / 状态主体 / 记忆归属 / 货币归属 / 平行相关角色）
//   纪律：写删除墓碑（跨端不复活）· 幂等 · `dryRun` 只报告 · 名册判定宽松（宁可漏删、不可误删人工关联）。
//
// 运行：node tests/unit/rel-invalid.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setIdentityView } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    cleanInvalidRelLinks, relInvalidStats, relInvalidSummary,
    relRepairMaint, relMaintSummary, capRelLinks,
} from '../../core/rel-maint.js';
import { runRepairMech } from '../../core/repair.js';

const R = makeReporter('rel-invalid v3.2.0 自动修复补充一步：清理无效关系');
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'relinv.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);
installGlobalFetch(() => ({ status: 404, text: '' }));
await import('../../index.js');

/** 造一个「有效数据齐全」的库底（用于穿插无效行） */
function mk(st) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('relinv.png');
    const s = st || emptyState();
    if (!s.memories) s.memories = [];
    s.memories = [{ id: 'm-1', owner: '甲', title: '记忆一', content: '甲在码头交接。', updatedAt: 1 }];
    s.plans = [{ id: 'pl-1', title: '计划一', content: '送信', status: 'open', updatedAt: 1 }];
    s.suspense = [{ id: 'su-1', title: '悬念一', content: '谁在跟踪', status: 'open', updatedAt: 1 }];
    s.parallels = [{ id: 'pa-1', title: '平行一', text: '某条平行事件', tags: [], updatedAt: 1 }];
    s.snapshots = [{ id: 'sn-1', name: '角色甲', updatedAt: 1 }];
    s.npcs = [{ id: 'np-1', name: '老张', updatedAt: 1 }];
    s.protagonist = { name: '主角' };
    s.currentStates = [{ id: 'st-1', subject: '角色甲', field: '体力', value: '尚可', updatedAt: 1 }];
    s.currencies = [{ id: 'cu-1', owner: '老张', currency: '银元', amount: 10, updatedAt: 1 }];
    s.links = [];
    s.deleted = {}; s.deletedH = {};
    s.updatedAt = 1;
    setKernelState(s);
    setIdentityView({ characterName: '玩家甲' });
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return s;
}
const KINDS = ['dangling', 'ghost', 'empty', 'badDim', 'badRef'];
const mkRows = () => ([
    { id: 'L-ok-1', dim: 'memories', refId: 'm-1', who: '角色甲', how: 'witness', updatedAt: 1 },   // 有效：在册角色
    { id: 'L-ok-2', dim: 'memories', refId: 'm-1', who: '', kind: 'fact', public: true, updatedAt: 1 },   // 有效：无 who 但有锚属性
    { id: 'L-dangling', dim: 'memories', refId: 'm-gone', who: '角色甲', how: 'witness', updatedAt: 1 },
    { id: 'L-ghost', dim: 'memories', refId: 'm-1', who: '查无此人', how: 'witness', updatedAt: 1 },
    { id: 'L-empty', dim: 'memories', refId: 'm-1', who: '', how: '', updatedAt: 1 },
    { id: 'L-baddim', dim: 'bogus', refId: 'm-1', who: '角色甲', how: 'witness', updatedAt: 1 },
    { id: 'L-badref', dim: 'memories', refId: '', who: '角色甲', how: 'witness', updatedAt: 1 },
]);

// ---------- A 组：五类无效行 + 墓碑 + 幂等 ----------
{
    const st = mk();
    st.links = mkRows();
    const dry = relInvalidStats(st);
    const dryOk = dry.invalid === 5 && dry.total === 7 && KINDS.every((k) => dry.reasons[k] === 1);

    const r1 = cleanInvalidRelLinks({});
    const kept = (st.links || []).map((x) => x.id).sort().join(',');
    const tombs = Object.keys((st.deleted || {}).links || {}).length;
    const gone = ['L-dangling', 'L-ghost', 'L-empty', 'L-baddim', 'L-badref'].every((id) => !(st.links || []).some((x) => x.id === id));
    const summary = relInvalidSummary(r1);

    // 幂等：再跑一次零改动
    const r2 = cleanInvalidRelLinks({});
    // dryRun 不改动
    const st2 = mk(); st2.links = mkRows();
    const r3 = cleanInvalidRelLinks({ dryRun: true });
    const dryUntouched = (st2.links || []).length === 7 && st2.links.some((x) => x.id === 'L-ghost');

    R.assert('A1 一步清掉五类无效关系：**孤儿行**（目标条目不存在）· **幽灵角色行**（不在任何已知名册）· **纯空行**（无角色且无锚属性）· **非法维度** · **空指向**；全部写删除墓碑（跨端不复活）；有效行一条不动；幂等（再跑零改动）；`dryRun` 只报告',
        dryOk && r1.ok === true && r1.removed === 5 && r1.kept === 2 && kept === 'L-ok-1,L-ok-2' && gone && tombs === 5
        && r2.removed === 0 && r2.changed === false && r3.removed === 5 && r3.changed === false && dryUntouched
        && summary === '清理无效关系 5 行（孤儿 1 · 幽灵角色 1 · 空行 1 · 非法维度 1 · 空指向 1）'
        && r1.details.rows.length === 5 && r1.details.rows.every((x) => KINDS.indexOf(x.reason) >= 0),
        J({ dry, removed: r1.removed, kept, tombs, gone, r2: { removed: r2.removed, changed: r2.changed }, summary }));
}

// ---------- B 组：已知名册判定要「宽松」（不误删人工关联） ----------
{
    // 名册来源：档案 / 名册 / 主角 / 玩家（身份视图）/ 状态主体 / 记忆归属 / 货币归属 / 平行相关角色
    const st = mk();
    st.parallels = [{ id: 'pa-2', title: '平行二', text: '带相关角色', characters: ['路乙'], tags: [], updatedAt: 1 }];
    st.links = [
        { id: 'B1', dim: 'memories', refId: 'm-1', who: '角色甲', how: 'witness', updatedAt: 1 },     // 档案
        { id: 'B2', dim: 'memories', refId: 'm-1', who: '老张', how: 'witness', updatedAt: 1 },       // 名册 + 货币归属
        { id: 'B3', dim: 'memories', refId: 'm-1', who: '主角', how: 'witness', updatedAt: 1 },       // 主角字段
        { id: 'B4', dim: 'memories', refId: 'm-1', who: '玩家甲', how: 'witness', updatedAt: 1 },     // 玩家（身份视图）
        { id: 'B5', dim: 'memories', refId: 'm-1', who: '甲', how: 'witness', updatedAt: 1 },         // 记忆归属
        { id: 'B6', dim: 'memories', refId: 'm-1', who: '路乙', how: 'witness', updatedAt: 1 },       // 平行相关角色
        { id: 'B7', dim: 'memories', refId: 'm-1', who: '角色甲·乙', how: 'witness', updatedAt: 1 },  // 模糊匹配（档案名前缀）
        { id: 'B8', dim: 'memories', refId: 'm-1', who: '不存在的人', how: 'witness', updatedAt: 1 },  // 幽灵（唯一应删）
    ];
    const r = cleanInvalidRelLinks({});
    const survivors = (st.links || []).map((x) => x.id).sort().join(',');
    R.assert('B1 名册判定**宽松优先**（宁可漏删、不可误删人工关联）：档案 / 名册 / 主角字段 / 玩家名（身份视图）/ 记忆归属 / 货币归属 / 平行「相关角色」/ 档案名前缀模糊匹配 全部视为有效；只有真正查无此人的「幽灵角色行」被清',
        r.removed === 1 && r.reasons.ghost === 1 && survivors === 'B1,B2,B3,B4,B5,B6,B7',
        J({ removed: r.removed, reasons: r.reasons, survivors }));
}

// ---------- C 组：与既有维护步骤的分工（V1 口径不动） ----------
{
    const st = mk();
    st.links = [
        { id: 'C-dup-a', dim: 'memories', refId: 'm-1', who: '角色甲', how: 'rumor', updatedAt: 1 },
        { id: 'C-dup-b', dim: 'memories', refId: 'm-1', who: '角色甲', how: 'author', updatedAt: 2 },     // 同 (dim,refId,who) → 由 relRepairMaint 去重（保留更可靠者）
        { id: 'C-ghost', dim: 'memories', refId: 'm-1', who: '幽灵乙', how: 'told', updatedAt: 1 },      // 由本步清理
        { id: 'C-stale', dim: 'memories', refId: 'm-1', who: '', kind: 'fact', conceptRef: '不存在的概念', updatedAt: 1 },   // 悬空引用 → 由 relRepairMaint 清理字段
    ];
    const m = relRepairMaint();
    const maintTxt = relMaintSummary(m);
    const afterMaint = (st.links || []).map((x) => x.id);
    const r = cleanInvalidRelLinks({});
    R.assert('C1 分工明确：`relRepairMaint`（V1 逐字移植）继续负责去重 / 悬空引用 / 角色名归一（本步**不接手**、结果不变）；本步只负责「结构无效 + 幽灵角色」。两步合起来才把关系表清干净，且**都不动有效行**',
        (m.deduped || 0) === 1 && (m.staleRefs || 0) === 1
        && afterMaint.length === 3 && afterMaint.indexOf('C-ghost') >= 0
        && r.removed === 1 && r.reasons.ghost === 1 && (st.links || []).map((x) => x.id).indexOf('C-ghost') < 0
        && maintTxt.indexOf('关联去重 1 行') >= 0 && maintTxt.indexOf('悬空引用清理 1 处') >= 0,
        J({ m: { deduped: m.deduped, staleRefs: m.staleRefs }, afterMaint, removed: r.removed, maintTxt }));
}

// ---------- D 组：自动修复真的会跑这一步 ----------
await (async () => {
    const st = mk();
    st.links = mkRows();
    const m1 = await runRepairMech({ silent: true, cause: '单测' });
    const notes = (m1.stage1 && m1.stage1.notes) || [];
    const relNote = notes.filter((x) => String(x).indexOf('清理无效关系') === 0).join(' | ');
    const maintNote = notes.filter((x) => String(x).indexOf('关联维护：') === 0).join(' | ');
    const left = st.links || [];
    const INVALID_IDS = ['L-dangling', 'L-ghost', 'L-empty', 'L-baddim', 'L-badref'];
    const noneLeft = INVALID_IDS.every((id) => !left.some((x) => x.id === id));
    // 剩余两行都必须「有效」：一行有在册角色，一行无角色但有锚属性（去重/归一后 id 由 `relLinkId` 重算 → 不写死）
    const remainOk = left.length === 2
        && left.some((x) => x.who === '角色甲')
        && left.some((x) => !x.who && (x.kind || x.public === true));
    const tombIds = Object.keys((st.deleted || {}).links || {});
    // 两类墓碑都要有：V1 维护（孤儿/去重/悬空）与本步（幽灵角色 / 空行）
    const tombOk = tombIds.length >= 4 && tombIds.indexOf('L-ghost') >= 0;
    R.assert('D1 **自动修复第 1 段（零 AI）确实执行了这一步**：`runRepairMech()` 之后 5 条无效关系一条不剩、2 条有效保留、墓碑齐全，报告里既有 V1「关联维护」摘要也有本步「清理无效关系 N 行（…）」；`stage1.relInvalid` 供诊断/日志读取（V1 维护先跑 → 本步只补它没覆盖的类别，故计数可小于 5）',
        noneLeft && remainOk && tombOk
        && /^清理无效关系 \d+ 行（/.test(relNote) && maintNote.length > 0
        && !!m1.stage1 && !!m1.stage1.relInvalid && m1.stage1.relInvalid.removed >= 1 && m1.stage1.relInvalid.changed === true,
        J({ left: left.map((x) => x.id), relNote, maintNote, tombIds, relInvalid: m1.stage1 && m1.stage1.relInvalid && m1.stage1.relInvalid.reasons }));
})();

// ---------- D2：关联层总开关关闭 → 不读写关联行（与 relRepairMaint 同口径） ----------
{
    const st = mk();
    st.links = mkRows();
    cfg.relLinkEnabled = false;                    // 层关闭
    const r = cleanInvalidRelLinks({});
    const untouched = (st.links || []).length === 7;
    cfg.relLinkEnabled = true;                     // 重开 → 修复会照常清
    const r2 = cleanInvalidRelLinks({});
    R.assert('D2 关联层总开关关闭时**不清理**（层关闭 = 不读写关联行，与 `relRepairMaint` 同口径），数据原样保留；重开后再跑照常清 5 行',
        r.removed === 0 && r.changed === false && untouched && r2.removed === 5 && r2.changed === true,
        J({ closed: { removed: r.removed, changed: r.changed }, untouched, reopened: r2.removed }));
}

// ---------- E 组：与「关联层容量上限」互不干扰（都是保存/修复期的一步） ----------
{
    const st = mk();
    st.links = [];
    for (let i = 0; i < 260; i++) st.links.push({ id: 'E' + i, dim: 'memories', refId: 'm-1', who: '角色甲', how: 'witness', updatedAt: i });
    const cap = capRelLinks(st, {});
    const r = cleanInvalidRelLinks({});
    R.assert('E1 与「关联层容量上限」（v3.1.0）互不干扰：容量裁剪先把 260 行裁到上限 200（有效行），无效关系清理随后判为「无无效行」（零改动）——两步各自幂等、可任意顺序执行',
        cap.changed === true && st.links.length === 200 && r.removed === 0 && r.changed === false,
        J({ cap: { before: cap.before, after: cap.after, dropped: cap.dropped }, links: st.links.length, r: { removed: r.removed } }));
}

R.done();
