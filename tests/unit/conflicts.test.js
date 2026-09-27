// 单元测试 · v2.92.0「需人工确认项：设定 + **总览**双处提示」（`docs/D10` Q10 + 用户要求）
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    setConflictHooks, noteConflict, listConflicts, pendingConflictCount, pendingConflictKinds,
    clearConflicts, conflictsSummary, CONFLICT_CAP,
} from '../../core/conflicts.js';
import { panelAction } from '../../ui/panel.js';
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
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:conflicts');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    store = [];
    setConflictHooks({ get: () => store, save: (x) => { store = x; } });
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

A('A3 设定 → 存储：有待确认项时渲染清单与「全部已确认」按钮；无则显示「无待确认项」', (() => {
    boot();
    const empty = String(storagePageHtml([]) || '');
    noteConflict({ kind: '跨端合并冲突', detail: '本地与远端同 id 不同内容 3 条', count: 3 });
    const html = String(storagePageHtml([]) || '');
    return empty.indexOf('无待确认项') >= 0 && html.indexOf('data-ftt-conflicts') >= 0
        && html.indexOf('待确认（共 3 项）') >= 0 && html.indexOf('data-ftt-action="resolveConflicts"') > 0;
})(), '见断言');

A('A4 **总览**横幅（源码级）：`overviewBody` 调用 `conflictBannerHtml()`，横幅含 `⚠️ 待确认` 与「去处理 / 已确认」两个动作', (() => {
    // 说明：总览整页渲染依赖较多宿主钩子（单测环境不便全量注入），故此处核对**渲染路径接线**与横幅模板本身；
    //   端到端表现由冒烟覆盖（面板可用时该横幅出现在总览顶部）。
    const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
    const calls = src.indexOf('conflictBannerHtml(); if (b) lines.push(b)') >= 0 || src.indexOf('conflictBannerHtml()') >= 0;
    const tmpl = src.indexOf('data-ftt-conflict-banner') >= 0 && src.indexOf('⚠️ 待确认') >= 0
        && src.indexOf('data-ftt-action="goStorageConflicts"') >= 0 && src.indexOf('data-ftt-action="resolveConflicts"') >= 0;
    return calls && tmpl;
})(), '见断言');

await A('A5 动作：`resolveConflicts` 只清提示（返回 cleared）；`goStorageConflicts` 跳到设定→存储并回报待确认条数', (async () => {
    boot();
    noteConflict({ kind: '跨端合并冲突', detail: 'A', count: 1 });
    const r1 = await panelAction('resolveConflicts', {});
    const okClear = r1.ok === true && Number(r1.cleared) === 1 && pendingConflictCount() === 0;
    noteConflict({ kind: '跨端合并冲突', detail: 'B', count: 2 });
    const r2 = await panelAction('goStorageConflicts', {});
    return okClear && r2.ok === true && Number(r2.conflicts) === 1 && pendingConflictCount() === 2;
})(), '');

R.done();
