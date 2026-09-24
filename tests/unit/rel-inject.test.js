// ============================================================
// 单元测试 · B5 关系表与注入自查（对齐 V1 12B-UI-关系表.js / injectCheckPanelHtml）
// 口径：
//   ① 关系行写回走 `upsertRelLinks`（V1 返回 {added,updated,removed}）+ `saveState()`；空角色名行不落库；
//   ② 「清空该条目关联」「清扫孤儿」「清除推定」与 V1 同名动作语义一致（删除留墓碑）；
//   ③ 注入自查只读：与真实注入**同一代码路径**（`buildMemoryBodyForInject` 的 diagnose 模式），
//      能给出约束段原文、已召回计数、未召回非公共信息及原因（关键词未命中 / 候选未入选）。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { relTableHtml, relAction, relRowsOf, relDirty, relStats, relByWho, howLabel, REL_DIMS } from '../../ui/rel-table.js';
import { injectCheckData, injectCheckPanelHtml, injectCheckAction, setCheckMode, setCheckKeywords, checkInfo } from '../../ui/inject-check.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';

const R = makeReporter('rel-inject B5 关系表与注入自查');
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.injectConstraintBlock = true;
    setScopeKey('角色甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        state: { date: '1919-11-29', time: '夜', location: '码头', present: ['甲'] },
        atoms: [{ id: 'a1', title: '码头木箱', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29' }],
        memories: [
            { id: 'm1', owner: '甲', content: '甲记得昨夜有人在巷口徘徊。', date: '1919-11-28' },
            { id: 'm2', owner: '乙', content: '乙私下把货单藏了起来。', date: '1919-11-28' },
        ],
        plans: [{ id: 'p1', kind: '计划', content: '清点货单并上报' }],
        suspense: [{ id: 's1', kind: '悬念', content: '木箱断口来源不明' }],
        parallels: [{ id: 'pa1', title: '另一种可能', text: '若木箱属于第三方势力，则可能有人上门。' }],
        snapshots: [{ id: 'sn1', name: '甲' }, { id: 'sn2', name: '乙' }],
    }));
    let ready = false;
    setPersistHooks({
        saveState: () => { if (!ready) { entryIndexInit(); ready = true; } entryIndexBuild(true); tombstoneSweep(); return true; },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
    setPanelHooks2({});
}
boot();

R.assert('R1 关系维度与方式：4 个可编辑维度；平行事件只有「相关」，其余含亲历/目击/被告知等（V1 relHowOptions）', (() => {
    const html = relTableHtml('memories', 'm1');
    const par = relTableHtml('parallels', 'pa1');
    return J(REL_DIMS) === J(['memories', 'plans', 'suspense', 'parallels'])
        && howLabel('told') === '被告知' && howLabel('related') === '相关'
        && html.indexOf('data-ftt-rel-body="memories|m1"') >= 0 && html.indexOf('data-ftt-action="relAddRow"') >= 0
        && html.indexOf('data-ftt-action="relSave"') >= 0 && html.indexOf('data-ftt-action="relSweep"') >= 0
        && html.indexOf('data-ftt-action="relDropInferred"') >= 0
        && par.indexOf('相关') >= 0 && par.indexOf('ftt-rel-table') >= 0;
})(), '');

R.assert('R2 行编辑草稿：relAddRow 只改草稿（库未变、relDirty=true），relSetRow 写入字段', (() => {
    const r1 = relAction('relAddRow', { kind: 'memories', id: 'm2' });
    const r2 = relAction('relSetRow', { kind: 'memories', id: 'm2', idx: 0, row: { who: '乙', how: 'told', from: '甲' } });
    const libRows = relRowsOf('memories', 'm2', { fresh: true });
    const draft = relRowsOf('memories', 'm2');
    return r1.ok === true && r1.rows === 1 && r2.ok === true && r2.row.who === '乙'
        && libRows.length === 0 && draft.length === 1 && relDirty('memories', 'm2') === true
        && relTableHtml('memories', 'm2').indexOf('（有未保存改动）') >= 0;
})(), { draft: relRowsOf('memories', 'm2') });

R.assert('R2b 保存：走 upsertRelLinks 与 saveState（返回 added/updated），空角色名行被跳过，草稿清空', (() => {
    const bad = relAction('relAddRow', { kind: 'memories', id: 'm2' });       // 再插入一行（空角色名）
    const before = J(state.links || []);
    const r = relAction('relSave', { kind: 'memories', id: 'm2' });
    const rows = relRowsOf('memories', 'm2', { fresh: true });
    return bad.rows === 2 && r.ok === true && r.saved === 1 && r.skipped === 1 && r.added >= 1
        && rows.length === 1 && String(rows[0].who) === '乙' && relDirty('memories', 'm2') === false
        && J(state.links || []) !== before && (state.links || []).length === 1;
})(), relRowsOf('memories', 'm2', { fresh: true }));

R.assert('R3 清空该条目关联 / 清扫孤儿 / 清除推定：三个动作语义与 V1 一致（孤儿按目标存在性判定）', (() => {
    boot();
    // 建三条关联：m1（正常）、孤儿（refId 不存在）、m2（备注含「推定」）
    relAction('relAddRow', { kind: 'memories', id: 'm1' });
    relAction('relSetRow', { kind: 'memories', id: 'm1', idx: 0, row: { who: '甲', how: 'participant' } });
    relAction('relSave', { kind: 'memories', id: 'm1' });
    relAction('relAddRow', { kind: 'memories', id: 'ghost' });
    relAction('relSetRow', { kind: 'memories', id: 'ghost', idx: 0, row: { who: '丙' } });
    relAction('relSave', { kind: 'memories', id: 'ghost' });
    relAction('relAddRow', { kind: 'plans', id: 'p1' });
    relAction('relSetRow', { kind: 'plans', id: 'p1', idx: 0, row: { who: '甲', note: '推定（由标题相似度）' } });
    relAction('relSave', { kind: 'plans', id: 'p1' });
    const st1 = relStats();
    const sweep = relAction('relSweep', {});
    const st2 = relStats();
    const drop = relAction('relDropInferred', {});
    const st3 = relStats();
    const clear = relAction('relClearEntry', { kind: 'memories', id: 'm1' });
    const st4 = relStats();
    return st1.total === 3 && st1.orphan === 1 && st1.inferred === 1
        && sweep.ok === true && sweep.swept === 1 && st2.total === 2 && st2.orphan === 0
        && drop.ok === true && drop.dropped === 1 && st3.inferred === 0
        && clear.ok === true && clear.cleared === 1 && st4.total === 0;
})(), relStats());

R.assert('R4 按角色筛选：relByWho 返回该角色在各维度的关联（含方式与条目摘要），并按方式优先级排序', (() => {
    boot();
    relAction('relAddRow', { kind: 'plans', id: 'p1' });
    relAction('relSetRow', { kind: 'plans', id: 'p1', idx: 0, row: { who: '甲', how: 'author' } });
    relAction('relSave', { kind: 'plans', id: 'p1' });
    relAction('relAddRow', { kind: 'memories', id: 'm1' });
    relAction('relSetRow', { kind: 'memories', id: 'm1', idx: 0, row: { who: '甲', how: 'told' } });
    relAction('relSave', { kind: 'memories', id: 'm1' });
    const list = relByWho('甲');
    const other = relByWho('乙');
    return list.length === 2 && list[0].how === 'author' && list[1].how === 'told'
        && list[0].title.indexOf('清点货单') >= 0 && other.length === 0;
})(), relByWho('甲'));

R.assert('R5 注入自查（只读同源）：诊断给出约束段原文、预算与已召回计数；未召回非公共信息给出原因', (() => {
    boot();
    // 把记忆条数上限压到 1 → 至少一条记忆成为「候选未入选」（V1：条数上限 / 预算不足导致未进注入）
    cfg.maxMemories = 1;
    const d = injectCheckData({ useKeywords: false });
    const panel = injectCheckPanelHtml({ useKeywords: false });
    const st = checkInfo();
    return d.ok === true && d.budget > 0 && d.constraintCap > 0
        && typeof d.constraintText === 'string' && d.recalledCounts.memories >= 1
        && d.notRecalledCounts.memories >= 1 && d.notRecalled[0].dim === 'memories'
        && ['candidate-not-selected', 'not-matched'].indexOf(d.notRecalled[0].reason) >= 0
        && panel.indexOf('【注入约束】原样预览') >= 0 && panel.indexOf('未进注入的非公共信息') >= 0
        && panel.indexOf('data-ftt-action="checkMode"') >= 0 && st.runs >= 1
        && (state.memories || []).length === 2;                      // 只读：不动数据
})(), (() => { const d = injectCheckData({ useKeywords: false }); return { rec: d.recalledCounts, notRec: d.notRecalledCounts, len: d.constraintLen }; })());

R.assert('R6 自查两个口径可切换：按关键词（有关键词时 query 非空）与按本地召回', (() => {
    const kw = injectCheckAction('checkMode', { mode: 'kw' });
    setCheckKeywords(['码头', '木箱']);
    const a = injectCheckData({ useKeywords: true });
    const bare = injectCheckAction('checkMode', { mode: 'bare' });
    const b = injectCheckData({ useKeywords: false });
    return kw.ok === true && kw.useKeywords === true && a.query.indexOf('码头') >= 0 && a.keywords.length === 2
        && bare.ok === true && bare.useKeywords === false && b.query === '' && checkInfo().useKeywords === false;
})(), checkInfo());

await (async () => {
    boot();
    openPanel('memories');
    setPanelHooks2({ pending: () => [] });
    // 先建一条关联，使「关系表」子页的总览有行可断言（V1 关系表总览按条目聚合）
    await panelAction('relAddRow', { kind: 'memories', id: 'm1' });
    await panelAction('relSave', { kind: 'memories', id: 'm1', rows: [{ who: '甲', how: 'participant' }] });
    const m1 = await panelAction('msub', { tab: 'memories', sub: 'rel' });
    const relView = panelBodyHtml('memories');
    const relWho = await panelAction('relWho', { who: '甲' });
    const checkView = await panelAction('msub', { tab: 'memories', sub: 'check' });
    const checkHtml = panelBodyHtml('memories');
    const add = await panelAction('relAddRow', { kind: 'memories', id: 'm2' });
    const save = await panelAction('relSave', { kind: 'memories', id: 'm2', rows: [{ who: '乙' }] });
    const state1 = panelAction && (await panelAction('tab', { tab: 'memories' }));
    R.assert('R7 面板接线：记忆页三子标签（列表/关系表/约束自查）切换与动作转发、保存提示', (() => {
        return m1.ok === true && relView.indexOf('data-ftt-msub="rel"') >= 0 && relView.indexOf('data-ftt-rel-who="1"') >= 0
            && relView.indexOf('data-ftt-action="relEdit"') >= 0
            && relWho.ok === true && checkView.ok === true && checkHtml.indexOf('ftt-inject-check') >= 0
            && add.ok === true && save.ok === true && save.saved === 1
            && String(state1.html).indexOf('data-ftt-msub="check"') >= 0;
    })(), { saved: save.saved, note: String(state1.html).match(/data-ftt-note>[^<]*/) });
})();

un();
R.done();
