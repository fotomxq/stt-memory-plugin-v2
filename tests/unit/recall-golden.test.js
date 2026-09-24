// ============================================================
// 单元测试 · 批次 6（core/recall.js 召回与注入）与 V1 一致
// 黄金样本：tests/fixtures/v1-golden-recall.json（oracle = **真实 V1 插件** v1.206：同状态同配置下直调导出函数）
// 口径：严格相等（JSON.stringify）。注入体（body）是整段文本，逐字符比对。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setChatHooks, setLastMessageId, setPersistHooks, getChatMessages } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { atomTimeAsc, atomTimeDesc, nameMatch, tagMatch, rawMatch, recallHay, recallHits, recallEntryScore, matchPresentNames, memInjectLines, planSuspLine, rumorInjLine, parallelInjLine, buildSceneTreeLines, buildInjectConstraints, buildMemoryBodyForInject } from '../../core/recall.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-recall.json'), 'utf8'));
const R = makeReporter('recall-golden V1 移植保真度（批次 6）');
const I = G.inputs;
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));

// 与 oracle 同口径的环境：配置、注入态、聊天/调试钩子、楼层号
Object.assign(cfg, {
    clockAnomalyJumpYears: defaultCfg.clockAnomalyJumpYears,
    charBudget: 900, maxAtoms: 3, maxStates: 2, maxSnapshots: 2, maxMemories: 2,
    maxItems: 2, maxPlans: 2, maxSuspense: 2, maxScenes: 2, maxConcepts: 2, maxParallelsInj: 2, maxRumors: 2,
    atomsRecentRatio: 0.4, currencyTrackedRoles: [],
});
setChatHooks({ dbgLog: () => undefined, latestAiFloorText: () => '', getChatMessages: () => [], getAssistantText: () => '' });
setPersistHooks({ saveState: () => true, saveCfg: () => true });
setLastMessageId(9);
setKernelState(clone(I.STATE));

R.assert('R1 时间排序与 V1 一致（asc/desc 比较器口径）',
    J(clone(I.STATE.atoms).sort(atomTimeAsc).map(x => x.id)) === J(G.atomTimeAsc)
    && J(clone(I.STATE.atoms).sort(atomTimeDesc).map(x => x.id)) === J(G.atomTimeDesc),
    [clone(I.STATE.atoms).sort(atomTimeAsc).map(x => x.id), G.atomTimeAsc]);
R.assert('R2 匹配器与 V1 一致（点名 / 标签 / 原文 / hay / hits / 评分）', (() => {
    const got = {
        nameHit: nameMatch('角色甲在码头', '角色甲'),
        nameMiss: nameMatch('角色甲在码头', '角色丙'),
        tagHit: tagMatch(['码头'], '码头 木箱'),
        rawHit: rawMatch([{ text: '木箱断口整齐' }], ['木箱']),
        recallHay: recallHay({ text: '木箱断口整齐', title: '木箱' }),
        recallHits: recallHits({ text: '木箱断口整齐', title: '木箱' }, ['木箱', '码头']),
        recallEntryScore: recallEntryScore({ id: 'a1', text: '木箱断口整齐', importance: 0.8, uses: 2 }, ['木箱'], { index: 0, total: 3 }),
    };
    return J(got) === J(G.matchers);
})(), G.matchers);
R.assert('R3 在场判定 matchPresentNames 与 V1 一致', J(matchPresentNames(['角色甲', '角色丙'], ['角色甲在码头', '角色乙在仓库'])) === J(G.matchPresentNames), G.matchPresentNames);
R.assert('R4 长期记忆注入行 memInjectLines 与 V1 一致', J(memInjectLines('memories', clone(I.STATE.memories[0]))) === J(G.memInjectLines), memInjectLines('memories', clone(I.STATE.memories[0])));
R.assert('R5 计划/悬念注入行 planSuspLine 与 V1 一致', J(planSuspLine('plans', clone(I.STATE.plans[0]))) === J(G.planSuspLine), planSuspLine('plans', clone(I.STATE.plans[0])));
R.assert('R6 传言注入行 rumorInjLine 与 V1 一致', rumorInjLine(clone(I.STATE.rumors[0])) === G.rumorInjLine, rumorInjLine(clone(I.STATE.rumors[0])));
R.assert('R7 平行事件注入行 parallelInjLine 与 V1 一致', parallelInjLine(clone(I.STATE.parallels[0])) === G.parallelInjLine, parallelInjLine(clone(I.STATE.parallels[0])));
R.assert('R8 场景树注入行 buildSceneTreeLines 与 V1 一致', J(buildSceneTreeLines()) === J(G.buildSceneTreeLines), buildSceneTreeLines());
R.assert('R9 固定约束段 buildInjectConstraints 与 V1 逐字符一致（在场 / 私密范围 / 知情人说明）',
    buildInjectConstraints() === G.buildInjectConstraints, buildInjectConstraints());
R.assert('R10 注入体 buildMemoryBodyForInject 与 V1 逐字符一致（默认预算）',
    buildMemoryBodyForInject('码头 木箱 线人', {}) === G.body, [String(buildMemoryBodyForInject('码头 木箱 线人', {})).slice(0, 120), String(G.body).slice(0, 120)]);
R.assert('R11 注入体在 300 字预算下与 V1 一致（预算裁剪/整条跳过不截断）',
    buildMemoryBodyForInject('码头 木箱 线人', { budget: 300 }) === G.bodyBudget, String(buildMemoryBodyForInject('码头 木箱 线人', { budget: 300 })).slice(0, 120));
R.assert('R12 同一注入态下可复现（两次调用在各自重置注入态后都与 V1 一致；说明构建会累积 uses 的既有行为）', (() => {
    setKernelState(clone(I.STATE));
    const b1 = buildMemoryBodyForInject('码头 木箱 线人', {});
    setKernelState(clone(I.STATE));
    const b2 = buildMemoryBodyForInject('码头 木箱 线人', {});
    return b1 === G.body && b2 === G.body;
})(), '');

setKernelState(null);
R.done();
