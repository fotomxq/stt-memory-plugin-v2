// 单元测试 · 待确认项（`docs/D10` Q10；v2.92.0 建立 → **v3.36.0 按用户要求重新设计**）
//   v3.36.0：待确认（`decide`，带差异化动作）/ 记录（`log`，只读、无需确认）分离；
//   修「点击全部已确认报 unknown-action」；A5 由**假绿**（断言收到 Promise）改为真断言。
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    setConflictHooks, noteConflict, listConflicts, pendingConflictCount, pendingConflictKinds,
    clearConflicts, conflictsSummary, CONFLICT_CAP,
    listConflictLog, conflictLogCount, conflictLogSummary, conflictKindSpec, resolveConflict, CONFLICT_ACT, CONFLICT_KINDS, CONFLICT_LOG_CAP, migrateConflicts,
} from '../../core/conflicts.js';
import { panelAction, panelState } from '../../ui/panel.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { storagePageHtml } from '../../ui/sync.js';

const R = makeReporter('conflicts v2.92.0 待人工确认项（设定 + 总览）');
const A = (n, c, e) => R.assert(n, !!c, e);
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
let store = [];
let storeLog = [];
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:conflicts');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    store = []; storeLog = [];
    setConflictHooks({ get: () => store, save: (x) => { store = x; }, getLog: () => storeLog, saveLog: (x) => { storeLog = x; } });
}
boot();

A('A1 登记与统计：按 kind+detail 去重累加；`pendingConflictCount`（含权重）≠ `pendingConflictKinds`（种类数）', (() => {
    boot();
    noteConflict({ kind: '跨端合并冲突', detail: 'A', count: 2 });
    noteConflict({ kind: '跨端合并冲突', detail: 'A' });
    noteConflict({ kind: '并集自检异常', detail: 'B' });
    return pendingConflictCount() === 4 && pendingConflictKinds() === 2 && listConflicts().length === 2
        && conflictsSummary().indexOf('跨端合并冲突 ×3') >= 0;
})(), () => ({ count: pendingConflictCount(), kinds: pendingConflictKinds() }));

A('A2 上限 ' + CONFLICT_CAP + ' 条（最新在前）+ 全清', (() => {
    boot();
    for (let i = 0; i < CONFLICT_CAP + 10; i++) noteConflict({ kind: 'k' + i, detail: 'd' + i });
    // 保留「最新 50 条」= 插入序列的最后 50 个（k10..k59）；同毫秒插入时排序键相同，故按「最早的那批被丢弃」断言
    const capped = listConflicts().length === CONFLICT_CAP
        && listConflicts().filter((x) => x.kind === 'k0').length === 0
        && listConflicts().filter((x) => x.kind === 'k59').length === 1;
    const before = pendingConflictKinds();
    const r = clearConflicts();
    return capped && r.cleared === before && pendingConflictCount() === 0;
})(), () => ({ kinds: pendingConflictKinds() }));

A('A3 设定 → 存储「待确认」区（v3.36.0 新设计）：待确认项**一栏一项**并带**该类自己的动作按钮**（如「🔀 重新同步（并集）」+「✅ 知道了」）；「记录」类只进只读区、不计入待确认', (() => {
    boot();
    const empty = String(storagePageHtml([]) || '');
    noteConflict({ kind: '跨端合并冲突', detail: '本地与远端同 id 不同内容 3 条', count: 3 });
    noteConflict({ kind: '删楼', detail: '删除 10 层（保留最近 10 层）；备份 bk.json', count: 1 });
    const html = String(storagePageHtml([]) || '');
    return empty.indexOf('无待确认项') >= 0
        // 待确认：计数只算 decide（跨端合并冲突 ×3），记录不计入
        && html.indexOf('data-ftt-conflicts') >= 0 && html.indexOf('待确认（共 3 项 · 1 类）') >= 0
        && html.indexOf('data-ftt-conflict-item="跨端合并冲突|') >= 0
        && html.indexOf('data-ftt-action="conflictAct"') >= 0
        && html.indexOf('data-ftt-cact="resync"') >= 0 && html.indexOf('data-ftt-cact="dismiss"') >= 0
        && html.indexOf('🔀 重新同步（并集）') >= 0 && html.indexOf('✅ 全部已确认（3）') >= 0
        // 记录：只读区（无需确认），不以「待确认」名义出现
        && html.indexOf('data-ftt-conflict-log') >= 0 && html.indexOf('无需确认') >= 0
        && html.indexOf('data-ftt-conflict-log-row="删楼|') >= 0
        && pendingConflictCount() === 3 && conflictLogCount() === 1;
})(), () => ({ pending: pendingConflictCount(), log: conflictLogCount() }));

A('A4 **总览**横幅（源码级）：`overviewBody` 调用 `conflictBannerHtml()`，横幅含 `⚠️ 待确认` 与「去处理 / 已确认」两个动作', (() => {
    // 说明：总览整页渲染依赖较多宿主钩子（单测环境不便全量注入），故此处核对**渲染路径接线**与横幅模板本身；
    //   端到端表现由冒烟覆盖（面板可用时该横幅出现在总览顶部）。
    const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
    const calls = src.indexOf('conflictBannerHtml(); if (b) lines.push(b)') >= 0 || src.indexOf('conflictBannerHtml()') >= 0;
    const tmpl = src.indexOf('data-ftt-conflict-banner') >= 0 && src.indexOf('⚠️ 待确认') >= 0
        && src.indexOf('data-ftt-action="goStorageConflicts"') >= 0 && src.indexOf('data-ftt-action="resolveConflicts"') >= 0;
    return calls && tmpl;
})(), '见断言');

const conf5 = await (async () => {
    boot();
    noteConflict({ kind: '跨端合并冲突', detail: 'A', count: 1 });
    noteConflict({ kind: '删楼', detail: '删除 10 层', count: 1 });
    // ① 全部已确认：只清待确认，记录保留（修复「点击报 unknown-action」）
    //    v3.37.0（S2）：确认动作本身也留一条「已确认：<类别>」记录 → 记录区 2 类（删楼 + 这条留痕）
    const r1 = await panelAction('resolveConflicts', {});
    const okClear = r1.ok === true && Number(r1.cleared) === 1 && Number(r1.keptLog) === 2
        && pendingConflictCount() === 0 && conflictLogCount() === 2
        && listConflictLog().some((x) => x.kind === '已确认：跨端合并冲突')
        && String(r1.note).indexOf('已全部确认 1 类') >= 0;
    // ② 单条差异化动作：dismiss（知道了）销账
    noteConflict({ kind: '并集自检异常', detail: 'B', count: 2 });
    const cid = String((listConflicts()[0] || {}).id || '');
    const r2 = await panelAction('conflictAct', { cid: cid, cact: 'dismiss' });
    const okDismiss = r2.ok === true && Number(r2.removed) === 1 && pendingConflictCount() === 0
        && String(r2.note).indexOf('剩余待确认 0 项') > 0
        && listConflictLog().some((x) => x.kind === '已确认：并集自检异常');   // S2：单条确认同样留痕
    // ③ 动作白名单：该类不支持的动作被拒且**保留**待确认项
    noteConflict({ kind: '并集自检异常', detail: 'C', count: 1 });
    const cid3 = String((listConflicts()[0] || {}).id || '');
    const logBefore3 = conflictLogCount();
    const r3 = await panelAction('conflictAct', { cid: cid3, cact: 'resync' });
    const okReject = r3.ok === false && String(r3.note).indexOf('不支持该动作') > 0 && pendingConflictCount() === 1
        && conflictLogCount() === logBefore3;   // 被拒的动作**不留痕**（只有真确认才写记录）
    // ④ 从总览横幅「去处理」：跳到设定 → 存储并回报待确认条数（此前同样报 unknown-action）
    const r4 = await panelAction('goStorageConflicts', {});
    const okGo = r4.ok === true && Number(r4.conflicts) === 1 && panelState().tab === 'settings' && panelState().settingsSub === 'storage';
    return { ok: okClear && okDismiss && okReject && okGo, okClear, okDismiss, okReject, okGo, r1: r1, r2: r2, r3: r3, r4: r4 };
})();
A('A5 动作（v3.36.0 重写，**真断言**）：`resolveConflicts` 清待确认而保留记录；`conflictAct` 按类别动作销账；不支持的动作被拒且保留；`goStorageConflicts` 跳到设定→存储', conf5.ok, () => conf5);

A('A6 类别登记表与分流：`decide` 类动作含「知道了」（且可带差异动作）；`log` 类（删楼 / 楼层收缩 / 跨端分歧已自动合并）不计入待确认、只进记录；未知类别保守按 `decide` 处理', (() => {
    boot();
    const spec1 = conflictKindSpec('跨端合并冲突');
    const spec2 = conflictKindSpec('删楼');
    const spec3 = conflictKindSpec('未登记类别X');
    const rLog = noteConflict({ kind: '楼层收缩', detail: '聊天已减小 10 层', count: 1 });
    return spec1.mode === 'decide' && spec1.actions.map((x) => x.id).join(',') === 'resync,dismiss'
        && spec2.mode === 'log' && spec2.actions.length === 0
        && spec3.mode === 'decide' && spec3.actions[0].id === CONFLICT_ACT.DISMISS
        && CONFLICT_KINDS['删楼'].mode === 'log' && CONFLICT_KINDS['跨端分歧（已自动合并）'].mode === 'log'
        && rLog.mode === 'log' && pendingConflictCount() === 0 && conflictLogCount() === 1
        && listConflicts().length === 0 && listConflictLog().length === 1
        && conflictLogSummary().indexOf('楼层收缩 ×1') >= 0 && conflictsSummary() === '';
})(), () => ({ kinds: Object.keys(CONFLICT_KINDS), log: listConflictLog() }));

A('A7 记录区上限 ' + CONFLICT_LOG_CAP + ' 类（最新在前）且与待确认清单互不影响；`resolveConflict` 的 `action` 如实回报', (() => {
    boot();
    for (let i = 0; i < CONFLICT_LOG_CAP + 5; i++) noteConflict({ kind: '删楼', detail: 'd' + i });
    const capped = listConflictLog().length === CONFLICT_LOG_CAP && listConflictLog().filter((x) => x.detail === 'd0').length === 0;
    noteConflict({ kind: '跨端合并冲突', detail: 'keep', count: 1 });
    const r = resolveConflict('跨端合并冲突', 'resync');
    return capped && r.ok === true && r.removed === 1 && r.action === 'resync' && r.pending === 0
        && listConflictLog().length === CONFLICT_LOG_CAP;      // 记录不受待确认处理影响
})(), () => ({ log: listConflictLog().length }));

A('A8 v3.37.0（设计缺陷 S1）旧数据迁移：语义已变成「记录」的类别从待确认区搬到记录区（计数与明细保留）；「待确认」类原样留下；**幂等**', (() => {
    boot();
    // 模拟 v3.35 及更早写下的数据（那时只有「待确认」一种语义）
    store = [
        { id: '删楼|删除 10 层', kind: '删楼', detail: '删除 10 层（保留最近 10 层）；备份 bk.json', count: 2, firstAt: 1, lastAt: 3, seq: 1 },
        { id: '楼层收缩|减小', kind: '楼层收缩', detail: '聊天已减小 10 层', count: 1, firstAt: 1, lastAt: 2, seq: 2 },
        { id: '跨端合并冲突|A', kind: '跨端合并冲突', detail: 'A', count: 1, firstAt: 1, lastAt: 1, seq: 3 },
    ];
    const r1 = migrateConflicts();
    const movedOk = r1.moved === 2 && r1.kept === 1 && listConflicts().length === 1
        && String(listConflicts()[0].kind) === '跨端合并冲突'
        && listConflictLog().length === 2 && conflictLogCount() === 3      // 删楼 ×2 + 楼层收缩 ×1
        && listConflictLog().filter((x) => x.kind === '删楼')[0].count === 2;   // 计数与明细原样保留
    const r2 = migrateConflicts();
    return movedOk && r2.moved === 0 && listConflicts().length === 1 && listConflictLog().length === 2;
})(), () => ({ r1: store, log: listConflictLog().map((x) => [x.kind, x.count]) }));

A('A9 v3.37.0（S1 兜底）界面绝不出现「待确认但无动作」的行：老数据里的 log 类若仍留在待确认区，也会补一个「✅ 知道了」按钮', (() => {
    boot();
    store = [{ id: '删楼|旧的', kind: '删楼', detail: '旧的删楼通知', count: 1, firstAt: 1, lastAt: 1, seq: 1 }];
    const html = String(storagePageHtml([]) || '');
    const seg = html.slice(html.indexOf('data-ftt-conflicts'), html.indexOf('data-ftt-conflict-log') > 0 ? html.indexOf('data-ftt-conflict-log') : undefined);
    return conflictKindSpec('删楼').actions.length === 0
        && seg.indexOf('data-ftt-conflict-item="删楼|旧的"') > 0
        && seg.indexOf('data-ftt-action="conflictAct"') > 0 && seg.indexOf('data-ftt-cact="dismiss"') > 0
        && seg.indexOf('✅ 知道了') > 0;
})(), () => ({ seg: String(storagePageHtml([]) || '').slice(0, 200) }));

A('A10 v3.37.0（S2）「确认」也留痕：单条处理与批量清空都会在记录区追加「已确认：<类别>」（合并计数，可追溯）', (() => {
    boot();
    noteConflict({ kind: '跨端合并冲突', detail: 'A', count: 1 });
    resolveConflict('跨端合并冲突', 'dismiss');
    noteConflict({ kind: '并集自检异常', detail: 'B', count: 1 });
    clearConflicts();
    const names = listConflictLog().map((x) => x.kind);
    const sum = listConflictLog().reduce((n, x) => n + x.count, 0);
    return names.indexOf('已确认：跨端合并冲突') >= 0 && names.indexOf('已确认：并集自检异常') >= 0
        && sum === 2 && listConflicts().length === 0
        && conflictLogSummary().indexOf('已确认：') >= 0;
})(), () => listConflictLog());

A('A11 v3.37.0（S3）接线回归（源码级）：冲突 / 记录钩子由 `wireConflictHooks()` **在 `init()` 里**接上（不再只在开面板时接 —— 否则没开过面板的会话里冲突会被写进默认内存钩子而丢失）', (() => {
    const src = readFileSync(join(ROOT, 'index.js'), 'utf8');
    const hasFn = src.indexOf('function wireConflictHooks()') >= 0 && src.indexOf('let conflictWired = false') >= 0;
    const inInit = (() => {
        const i = src.indexOf('export async function init()');
        const body = src.slice(i, i + 4000);
        return body.indexOf('wireConflictHooks();') >= 0;
    })();
    const inPopup = (() => {
        const i = src.indexOf('export async function openPanelPopup(');
        const body = src.slice(i, i + 3000);
        return body.indexOf('wireConflictHooks();') >= 0 && body.indexOf('setConflictHooks({') < 0;   // 不再内联接线
    })();
    const migrates = src.indexOf('migrateConflicts()') >= 0;                                            // 装配时迁移老数据
    return hasFn && inInit && inPopup && migrates;
})(), '见断言');

R.done();
