// ============================================================
// 单元测试 · B8-6c-2 场景修复管道（与**真实 V1 插件**逐项比对 + V2 编排/接线）
// 黄金样本（oracle = 真实 V1 插件 v1.206，`tests/unit/helpers.js#loadPlugin` 暴露的 `__FTT`）：
//   tests/fixtures/v1-golden-scene-repair.json —— 提示词逐字符 / 全量重建 / 两级并集 / 全链路 / 各早退与异常分支
// 覆盖：
//   buildSceneRepairPrompt（system + user **逐字符**，整库清单 + 空库「（无场景数据）」）；
//   applySceneRebuild（归一化 + 同路径去重 + **逐级补全中间层** + 路径未变保留 id/uses/floorSeen + 描述兜底；
//     空数组 → `empty`、不可归一 → `invalid`、非数组 → `empty`、字符串路径亦可）；
//   修复后的**两级并集**（`scenesUnionMergeAll`：精确同路径 + 相似地名（行政后缀）→ 归并 + 子级路径改名；
//     顶层同地异名只归并自身、既有子级路径不改名 —— V1 原生怪癖）；
//   runSceneRepair（全链路 fetch 桩 / no-rebuild 四态 / invalid / 空库 / 互斥）；
//   另含 V2 编排与接线：场景分页按钮（**无显隐条件**，V1 `scenesHtml` 的 sceneBar 恒渲染）、`sceneRepair` 动作可达、
//   `FTT.*` 入口齐备与无 hook 降级。
// 说明：V1 `saveState` 会调 `tombstoneSweep` 自动给消失条目留墓碑，故本测试的 `saveState` 桩同样调用
//   `tombstoneSweep()`，并在 `boot()` 后调 `entryIndexInit()` 对齐基线 —— 与 oracle 侧的 `F.entryIndexInit()` 一一对应。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import {
    cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks,
} from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { scenesUnionMergeAll } from '../../core/ingest.js';
import { buildSceneRepairPrompt, applySceneRebuild, runSceneRepair } from '../../core/scene-repair.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { installDevtools, uninstallDevtools } from '../../devtools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-scene-repair.json'), 'utf8'));
const R = makeReporter('scene-repair-golden B8-6c-2 场景修复（V1 对齐）');
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
function boot(stateLike, cfgPatch) {
    Object.assign(cfg, clone(defaultCfg));
    if (cfgPatch) Object.assign(cfg, clone(cfgPatch));
    setScopeKey('甲');
    setLastMessageId(400);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    // V1 `saveState` = 删除留痕（tombstoneSweep）+ 落盘；测试里同样触发留痕（oracle 侧同口径）
    setPersistHooks({ saveState: () => { try { tombstoneSweep(); } catch (e) { /* 忽略 */ } return true; }, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setTimerHooks({ set: () => 0, clear: () => undefined });
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai' }), feedText: () => '', busy: () => false });
    toasts = [];
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    // oracle 侧每个场景都调 `F.entryIndexInit()` → 这里同口径对齐删除留痕基线
    entryIndexInit();
    return state;
}
/** 场景条目投影（与 oracle 的投影字段一致） */
const sceneViewOf = (list) => (list || []).map(x => ({
    id: x.id, name: x.name, pathArr: x.pathArr, pathStr: x.pathStr, desc: x.desc,
    uses: x.uses, floorSeen: x.floorSeen, tags: x.tags,
}));
const sceneView = () => sceneViewOf(state.scenes);
const tombsOf = () => Object.keys((state.deleted || {}).scenes || {}).sort();
/** V1 通知三元件 → V2 单串通知（`repair` → `warning`，与 `core/repair.js` 同映射） */
const wantToasts = (rows) => rows.map(t => [t[0] === 'repair' ? 'warning' : t[0], [t[1], t[2]].filter(Boolean).join(' ')]);

// ============================================================
// S 组：场景修复 —— 与 V1 逐项比对
// ============================================================
R.assert('S1 buildSceneRepairPrompt：system + user 两条消息**逐字符**与 V1 一致（整库清单 `- 名称 ｜ 路径 ｜ 描述`）；空库输出「（无场景数据）」', (() => {
    boot(G.inputs.scenario);
    const got = buildSceneRepairPrompt();
    boot({ scenes: [] });
    const empty = buildSceneRepairPrompt();
    return J(got) === J(G.prompt) && J(empty) === J(G.promptEmpty)
        && got.length === 2 && got[0].role === 'system' && got[1].role === 'user'
        && got[0].content.indexOf('只输出 JSON，不要解释。') >= 0
        && got[1].content.indexOf('- 纽约 ｜ 路径：纽约 ｜ 描述：繁华都市。') >= 0
        && got[1].content.indexOf('- 曼哈顿 ｜ 路径：纽约>曼哈顿 ｜ 描述：纽约的区。') >= 0
        && empty[1].content.indexOf('（无场景数据）') >= 0;
})(), G.prompt.map(m => [m.role, String(m.content).slice(0, 60)]));

R.assert('S2 applySceneRebuild 全量：归一化 + 同路径去重 + **逐级补全中间层**；路径未变保留原 id/uses/floorSeen 且描述为空时兜底旧描述 —— 与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const r = applySceneRebuild(clone(G.inputs.rebuild));
    const got = { ok: r.ok, reason: r.reason, list: sceneViewOf(r.list) };
    const ids = (r.list || []).map(x => x.id);
    const byPath = new Map((r.list || []).map(x => [x.pathStr, x]));
    return J(got) === J(G.applyRebuild) && J(ids) === J(G.applyRebuildIds)
        && r.list.length === 5
        && byPath.get('纽约').id === 'sc1' && byPath.get('纽约').uses === 3 && byPath.get('纽约').floorSeen === 10
        && byPath.get('纽约').desc === '繁华都市。'                                   // AI 描述为空 → 兜底旧描述
        && byPath.get('纽约>曼哈顿').id === 'sc2' && byPath.get('纽约>曼哈顿').desc === '纽约的核心区。'
        && byPath.get('纽约>皇后区').desc === '' && byPath.get('纽约>皇后区').id === ids[4]   // 中间层被补全（列在子级之后）
        && r.list.filter(x => x.pathStr === '纽约>曼哈顿').length === 1;               // 重复项被丢弃
})(), G.applyRebuild);

R.assert('S3 applySceneRebuild 边界：空数组 / 非数组 → `empty`；全部不可归一 → `invalid`；字符串路径按 `>` 拆分并保留原 id', (() => {
    boot(G.inputs.scenario);
    const e1 = applySceneRebuild([]);
    const e2 = applySceneRebuild([{ '名称': '', '路径': [] }, { '名称': '', '描述': 'x' }]);
    const e3 = applySceneRebuild(null);
    const s = applySceneRebuild([{ '名称': '纽约', '路径': '纽约', '描述': '改为字符串路径。' }]);
    return J({ ok: e1.ok, reason: e1.reason }) === J(G.applyRebuildEmpty)
        && J({ ok: e2.ok, reason: e2.reason }) === J(G.applyRebuildInvalid)
        && J({ ok: e3.ok, reason: e3.reason }) === J(G.applyRebuildNonArray)
        && J({ ok: s.ok, list: sceneViewOf(s.list), ids: (s.list || []).map(x => x.id) }) === J(G.applyRebuildStringPath);
})(), G.applyRebuildInvalid);

R.assert('S4 scenesUnionMergeAll 两级归并：同上级 + 行政后缀差异（曼哈顿 / 曼哈顿区）→ 描述取更全/统计取大 + 子级路径改名（曼哈顿区>唐人街 → 曼哈顿>唐人街）—— 与 V1 一致', (() => {
    boot({ scenes: [
        { id: 'u1', name: '曼哈顿', pathArr: ['纽约', '曼哈顿'], pathStr: '纽约>曼哈顿', desc: '区。', uses: 1, floorSeen: 1, tags: [] },
        { id: 'u2', name: '曼哈顿区', pathArr: ['纽约', '曼哈顿区'], pathStr: '纽约>曼哈顿区', desc: '同地异名的更全描述。', uses: 3, floorSeen: 5, tags: [] },
        { id: 'u3', name: '唐人街', pathArr: ['纽约', '曼哈顿区', '唐人街'], pathStr: '纽约>曼哈顿区>唐人街', desc: '街。', uses: 2, floorSeen: 4, tags: [] },
    ] });
    const n = scenesUnionMergeAll();
    return J({ n, scenes: sceneView(), tombs: tombsOf() }) === J(G.unionAll)
        && n === 1 && state.scenes.length === 2
        && state.scenes[0].id === 'u1' && state.scenes[0].uses === 3 && state.scenes[1].pathStr === '纽约>曼哈顿>唐人街';
})(), G.unionAll);

R.assert('S5 scenesUnionMergeAll 顶层同地异名（纽约 / 纽约市）：根级归并自身，但**既有子级路径不改名**（V1 原生怪癖，如实固化）', (() => {
    boot({ scenes: [
        { id: 'v1', name: '纽约', pathArr: ['纽约'], pathStr: '纽约', desc: '都市。', uses: 1, floorSeen: 1, tags: [] },
        { id: 'v2', name: '纽约市', pathArr: ['纽约市'], pathStr: '纽约市', desc: '同地异名的更全描述。', uses: 3, floorSeen: 5, tags: [] },
        { id: 'v3', name: '曼哈顿', pathArr: ['纽约市', '曼哈顿'], pathStr: '纽约市>曼哈顿', desc: '区。', uses: 2, floorSeen: 4, tags: [] },
    ] });
    const n = scenesUnionMergeAll();
    return J({ n, scenes: sceneView(), tombs: tombsOf() }) === J(G.unionAllRoot)
        && n === 1 && state.scenes.length === 2 && state.scenes[0].desc === '同地异名的更全描述。'
        && state.scenes[1].pathStr === '纽约市>曼哈顿';                                 // 子级未被改名（V1 原样）
})(), G.unionAllRoot);

// ============================================================
// P 组：V2 编排（runSceneRepair 全链路）
// ============================================================
await A('P1 runSceneRepair 全链路：整库清单 → AI（fetch 桩，「场景库.重建」）→ 重建落库（保留 id/uses/floorSeen）→ 并集 → 落盘；返回结构 / 场景表 / 墓碑 / 提示文案与 V1 一致，且发给 AI 的 messages 与 V1 逐字节相同', async () => {
    boot(G.inputs.scenario);
    let seen = null, aiCalls = 0;
    setAiHooks({ callAi: async (messages) => { aiCalls++; seen = clone(messages); return { ok: true, text: G.inputs.ai }; }, feedText: () => '', busy: () => false });
    const r = await runSceneRepair();
    const flow = { made: r.made, before: r.before, after: r.after };
    return aiCalls === 1 && J(flow) === J(G.flow) && J(sceneView()) === J(G.flowScenes)
        && J((state.scenes || []).map(x => x.id)) === J(G.flowIds) && J(tombsOf()) === J(G.flowTombs)
        && J(seen) === J(G.flowMessages[0]) && J(toasts) === J(wantToasts(G.flowToasts))
        && flow.before === 2 && flow.after === 5 && state.scenes.length === 5;
}, G.flow);

await A('P2 runSceneRepair 修复后再做场景并集：AI 返回「纽约 / 纽约市」→ 重建后两级归并压成 1 个节点，消失节点由 `saveState` 删除留痕写墓碑（V1 同口径）', async () => {
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: G.inputs.aiUnion }), feedText: () => '', busy: () => false });
    const r = await runSceneRepair();
    const flow = { made: r.made, before: r.before, after: r.after };
    return J(flow) === J(G.flowUnion) && J(sceneView()) === J(G.flowUnionScenes)
        && J(tombsOf()) === J(G.flowUnionTombs) && J(toasts) === J(wantToasts(G.flowUnionToasts))
        && state.scenes.length === 1 && state.scenes[0].desc === '同地异名的更全描述。'
        && Number(state.scenes[0].uses) === 3 && Number(state.scenes[0].floorSeen) === 10;
}, G.flowUnion);

await A('P3 runSceneRepair 四态早退：缺「重建」/ 空列表 / 非法 JSON / 换了维度键 → 全部 `no-rebuild` 且数据零改动；重建结果全不可归一 → `invalid:invalid` 且数据零改动', async () => {
    const cases = [
        ['missing', JSON.stringify({ '场景库': {} })],
        ['emptyList', JSON.stringify({ '场景库': { '重建': [] } })],
        ['badJson', '这不是 JSON'],
        ['otherDim', JSON.stringify({ '记忆库': { '重建': G.inputs.rebuild } })],
    ];
    const bad = [];
    for (const [name, text] of cases) {
        boot(G.inputs.scenario);
        setAiHooks({ callAi: async () => ({ ok: true, text }), feedText: () => '', busy: () => false });
        const r = await runSceneRepair();
        const want = clone(G.noRebuild[name]);
        want.toasts = wantToasts(want.toasts);
        const got = { r: { made: r.made, error: r.error }, scenes: sceneView(), toasts: toasts.slice(-1) };
        if (J(got) !== J(want)) bad.push([name, got, want]);
    }
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify({ '场景库': { '重建': [{ '名称': '', '路径': [] }] } }) }), feedText: () => '', busy: () => false });
    const ri = await runSceneRepair();
    const wantI = clone(G.invalidRebuild);
    wantI.toasts = wantToasts(wantI.toasts);
    const gotI = { made: ri.made, error: ri.error, scenes: sceneView(), toasts: toasts.slice(-1) };
    return bad.length === 0 && J(gotI) === J(wantI)
        && ri.error === 'invalid:invalid' && state.scenes.length === 2;
}, G.noRebuild);

await A('P4 runSceneRepair 空库 / 长任务在途拒绝（aiBusy 互斥）：分别返回 skipped / blocked，数据零改动，提示与 V1 逐字一致', async () => {
    boot({ scenes: [] });
    const r0 = await runSceneRepair();
    const emptyOk = !r0.made && r0.skipped === true && J(toasts) === J(wantToasts(G.emptyToasts));
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: G.inputs.ai }), feedText: () => '', busy: () => true });
    const rb = await runSceneRepair();
    setAiHooks({ callAi: async () => ({ ok: false }), feedText: () => '', busy: () => false });
    return emptyOk && rb.made === 0 && rb.blocked === true
        && J(sceneView()) === J(G.busyScenes) && J(toasts) === J(wantToasts(G.busyToasts));
}, G.busyFlow);

// ============================================================
// U 组：界面与调试接线
// ============================================================
R.assert('U1 场景分页渲染 V1 同款「🔧 修复结构/用词」按钮：**无显隐条件**（V1 `scenesHtml` 的 sceneBar 恒渲染 —— 场景为空时按钮仍在）', (() => {
    boot(G.inputs.scenario);
    openPanel('scenes'); setPanelHooks2({});
    const html = panelBodyHtml('scenes');
    const hasBtn = html.indexOf('data-ftt-action="sceneRepair"') >= 0 && html.indexOf('🔧 修复结构/用词') >= 0
        && html.indexOf('title="复用「立即修复」管道，修正场景树错乱的结构/用词不当"') >= 0;
    boot({ scenes: [] });
    openPanel('scenes');
    const empty = panelBodyHtml('scenes');
    return hasBtn && empty.indexOf('data-ftt-action="sceneRepair"') >= 0
        && empty.indexOf('该类目暂无条目') >= 0;
})(), '');

await A('U2 面板动作 sceneRepair 可达：走 runSceneRepair 全链路并把结果写回面板 note（AI 从共用注入钩子取，不伪造结果）', async () => {
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: G.inputs.ai }), feedText: () => '', busy: () => false });
    openPanel('scenes'); setPanelHooks2({});
    const r = await panelAction('sceneRepair', {});
    const note = String(panelState().note || '');
    return r.ok === true && !!r.sceneRepair && r.made === 1 && r.action === 'sceneRepair'
        && note.indexOf('场景修复：') >= 0 && note.indexOf('节点 2 → 5') >= 0 && state.scenes.length === 5;
}, '');

await A('U3 面板动作 sceneRepair 在 AI 未给出重建列表时如实回报（不伪造成功、不改数据）', async () => {
    boot(G.inputs.scenario);
    setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify({ '场景库': {} }) }), feedText: () => '', busy: () => false });
    openPanel('scenes'); setPanelHooks2({});
    const r = await panelAction('sceneRepair', {});
    const note = String(panelState().note || '');
    return r.ok === true && r.made === 0 && note.indexOf('AI 未返回可用的场景重建列表') >= 0 && state.scenes.length === 2;
}, '');

R.assert('U4 FTT 调试入口齐备：sceneRepairPrompt / sceneRepairApply / sceneRepair / scenesUnionMergeAll', (() => {
    boot(G.inputs.scenario);
    const on = installDevtools({
        sceneRepairPrompt: () => buildSceneRepairPrompt(), sceneRepairApply: (e) => applySceneRebuild(e),
        sceneRepair: (o) => runSceneRepair(o), scenesUnionMergeAll: () => scenesUnionMergeAll(),
    });
    const F = globalThis.FTT;
    const prompt = F.sceneRepairPrompt();
    const applied = F.sceneRepairApply(clone(G.inputs.rebuild));
    const ok = on === true && Array.isArray(prompt) && prompt.length === 2
        && applied.ok === true && applied.list.length === 5 && applied.list[0].id === 'sc1'
        && typeof F.sceneRepair === 'function' && typeof F.scenesUnionMergeAll === 'function';
    boot({ scenes: [
        { id: 'z1', name: '纽约', pathArr: ['纽约'], pathStr: '纽约', desc: '都市。', uses: 1, floorSeen: 1, tags: [] },
        { id: 'z2', name: '纽约市', pathArr: ['纽约市'], pathStr: '纽约市', desc: '更全。', uses: 2, floorSeen: 2, tags: [] },
    ] });
    const merged = globalThis.FTT.scenesUnionMergeAll();
    uninstallDevtools();
    return ok && merged === 1 && state.scenes.length === 1 && globalThis.FTT === undefined;
})(), '');

await A('U5 FTT.sceneRepair 无 hook 时按约定降级（不抛错，返回 no-hook），有 hook 时执行全链路', async () => {
    boot(G.inputs.scenario);
    installDevtools({});
    const noHook = await globalThis.FTT.sceneRepair({});
    uninstallDevtools();
    const degraded = noHook && noHook.made === 0 && noHook.error === 'no-hook';
    boot(G.inputs.scenario);
    installDevtools({ sceneRepair: (o) => runSceneRepair(o) });
    const r = await globalThis.FTT.sceneRepair({ aiText: G.inputs.ai });
    uninstallDevtools();
    return degraded && r.made === 1 && state.scenes.length === 5;
}, '');

un();
R.done();
