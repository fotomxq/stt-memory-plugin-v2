// ============================================================
// 单元测试 · v3.52.18：情节总结防高频触发 + 设定简化（token 上限 / 保留 N 条）
//
// 用户要求（原话）：「经过排查可能是分段总结出问题了，前几次改版升级导致的异常，频繁总结引发。
//   请优化总结的机制，避免高频次触发。其次简化设定，主要是控制token上限和保留N条（默认30）情节外，超出去的部分进行总结。」
//
// 口径：
//   · **聚合目标 = 保留最近 N 条**（默认 30；不再按「当前条数 × 30%」—— 旧口径每加 1 条就再总结一次）；
//   · 自动路径两道闸：冷却 120s（`ATOM_COMPACT_AUTO_COOLDOWN_MS`）+ 最小批量 10 条（`ATOM_COMPACT_MIN_BATCH`）；
//     手动 force / 单测直接调用不受限（保持 V1 行为）；
//   · 设定页只摆「开关 / token 上限 / 保留 N 条」，其余调参进「高级」折叠。
// 运行：node tests/unit/atom-compact-guard.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { atomCompactPlan, runAtomCompact } from '../../core/atom-compact.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { settingsPageHtml, SETTINGS_CONTROLS, settingsPagesInfo } from '../../ui/settings-pages.js';

const R = makeReporter('atom-compact-guard v3.52.18 情节总结防高频 / 设定简化');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(patch) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    if (patch) Object.assign(cfg, patch);
    cfg.storeMinAtoms = 0;
    setScopeKey('char:ac');
    setLastMessageId(400);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(emptyState());
    setLoadPhase('ready');
    return state;
}
const mkAtoms = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: 'a' + i, title: 'T' + i, text: '第' + i + '条情节正文：甲在码头交接货物并记录数量。', date: '1919-11-' + String((i % 28) + 1).padStart(2, '0'), floorStart: i, floorEnd: i, uses: 1, importance: 0.5 });
    return out;
};

A('A1 生产口径：**聚合目标 = 保留最近 N 条**（默认 30）；超出部分才进总结池', (() => {
    boot();
    state.atoms = mkAtoms(45);
    const plan = atomCompactPlan();
    return plan.recentN === 30 && plan.target === 30 && plan.pool.length === 15 && plan.before === 45;
})(), () => { boot(); state.atoms = mkAtoms(45); return J(atomCompactPlan()); });
A('A2 自动路径**最小批量闸**：超出保留窗口不足 10 条 → `below-batch`（不再「多 1-2 条就总结」）', (async () => {
    boot();
    state.atoms = mkAtoms(35);   // pool = 5
    setAiHooks({ callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false });
    const r = await runAtomCompact({ auto: true });
    return r.ok === true && r.skipped === 'below-batch' && r.poolLen === 5 && r.minBatch === 10;
})(), 'n/a');
A('A3 自动路径**冷却闸**：完成一次自动总结后 120s 内再次自动触发 → `cooldown`（手动 force 不受影响）', (async () => {
    boot();
    state.atoms = mkAtoms(45);
    let calls = 0;
    setAiHooks({ callAi: async () => { calls += 1; return { ok: true, text: J({ groups: [] }) }; }, feedText: () => '', busy: () => false });
    const r1 = await runAtomCompact({ auto: true });      // 首次：正常进入（AI 无 groups → no-merge）
    const r2 = await runAtomCompact({ auto: true });      // 冷却期（首次完成后记录时刻）
    return (r1.ok === true) && r2.skipped === 'cooldown' && calls === 1;
})(), 'n/a');
A('A4 设定简化：prompts 页明面只有「开关 / token 上限 / 保留 N 条」；其余三项进「高级」折叠', (() => {
    const h = settingsPageHtml('prompts', '');
    const main = ['atomCompactEnabled', 'atomCompactChars', 'atomCompactRecent'];
    const adv = ['atomCompactTarget', 'atomCompactRatio', 'atomCompactBatch'];
    const at = (k) => h.indexOf('data-ftt-cfg="' + k + '"');
    return main.every((k) => at(k) >= 0) && adv.every((k) => at(k) >= 0)
        && h.indexOf('高级（一般不用改）') >= 0
        && at('atomCompactTarget') > h.indexOf('高级（一般不用改）')
        && at('atomCompactEnabled') < h.indexOf('高级（一般不用改）')
        && h.indexOf('保留最近 N 条情节（默认 30）') >= 0
        && h.indexOf('token / 字符上限') >= 0;
})(), 'n/a');
A('A5 配置默认值：保留 30 条（生产默认）；控件表仍覆盖全部 6 键（兼容旧存档）', (() => {
    const keys = SETTINGS_CONTROLS.prompts.map((c) => String(c.key));
    return Number(defaultCfg.atomCompactRecent) === 30
        && ['atomCompactEnabled', 'atomCompactChars', 'atomCompactRecent', 'atomCompactTarget', 'atomCompactRatio', 'atomCompactBatch'].every((k) => keys.indexOf(k) >= 0)
        && settingsPagesInfo().totalControls > 0;
})(), 'n/a');

R.done();
