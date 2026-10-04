// ============================================================
// 单元测试 · v3.6.0「自动修复追加：按最新情节刷新时间/地点/人物（最新情节按内置天数判断）」
//
// 用户要求（原话）：「总览自动修复功能，追加一个步骤，即根据最新的情节获取最新的时间、地点、人物等信息。
//   注意最新的情节指根据内置的天数判断。」
//
// 覆盖：
//   A 「最新情节」的判定：**两边都有内置天数（`storyDay`）时以天数大者为准**（`core/recall.js#trustedPlotList`）；
//     任一侧没有天数 → 沿用原口径（楼层优先 → 剧情日期），不倒退；
//   B 自动修复第 1 段（零 AI）**确实执行**这一步：时间 / 地点 / 在场人物 / 第 N 天都按最新情节写入 `state.state`，
//     报告里如实回报，`stage1.clockSync` 供诊断；
//   C 手工锁定（`cfg.clockManualLock` 默认开）时**不覆盖**日期/时间/地点（如实回报「已跳过（手工锁定…）」）；
//   D 无可用情节时**不清空**已有值（保持原值，不引入他源）。
//
// 运行：node tests/unit/repair-clock-step.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { runRepairMech, setRepairHooks, repairHookState } from '../../core/repair.js';
import { trustedPlotList } from '../../core/recall.js';
import { clockAutoExtractOnce, clockExtractState } from '../../core/clock-extract.js';

const R = makeReporter('repair-clock-step v3.6.0 自动修复：按最新情节刷新时间/地点/人物（天数为准）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
host.ctx.characters = [{ name: '角色甲', avatar: 'clockstep.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);
const entry = await import('../../index.js');
try { await entry.init(); } catch (e) { /* 装配失败不阻塞 */ }

const mkChat = (n) => {
    host.ctx.chat.length = 0;
    for (let i = 0; i < n; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
    host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
    // 内核侧的末楼快照（`clockAutoExtractOnce` 会先看它；生产由 CHAT_CHANGED / 渲染事件刷新）
    try { setLastMessageId(host.ctx.chat.length - 1); } catch (e) { /* 忽略 */ }
};
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('clockstep.png');
    setKernelState(Object.assign(emptyState(), o.state || {}));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    mkChat(o.floors || 20);
    try { setRepairHooks(repairHookState()); } catch (e) { /* 忽略 */ }
    return state;
}

// ==================== A 组：最新情节按内置天数判断 ====================
{
    // 楼层更小的那条「第 30 天」情节，应当排在楼层更大的「第 2 天」情节**前面**（两边都有天数 → 天数优先）
    boot({
        floors: 40,
        state: {
            atoms: [
                { id: 'p-low-floor-high-day', title: '第30天', text: '甲在仓库。', date: '1919-11-10', time: '10:00', location: '仓库', storyDay: 30, floorStart: 1, floorEnd: 2, entities: ['角色甲'], tags: [], updatedAt: 1 },
                { id: 'p-high-floor-low-day', title: '第2天', text: '甲在码头。', date: '1919-11-02', time: '08:00', location: '码头', storyDay: 2, floorStart: 30, floorEnd: 31, entities: ['乙'], tags: [], updatedAt: 2 },
            ],
        },
    });
    const list = trustedPlotList();
    A('A1 「最新情节」按**内置天数**判断：两边都有 `storyDay` 时，**天数大者在前** —— 第 30 天（楼层 2）排在第 2 天（楼层 31）之前；取自 `/core/recall.js#trustedPlotList`（时钟解析与在场解析共用这一份顺序）',
        list.length === 2 && list[0].node.id === 'p-low-floor-high-day' && list[0].node.storyDay === 30
        && list[1].node.id === 'p-high-floor-low-day',
        J(list.map((x) => [x.node.id, x.node.storyDay, x.node.floorEnd])));
}

{
    // 只有一侧有天数 → 沿用原口径（楼层优先），不让「没写天数的新情节」被老情节压下去
    boot({
        floors: 40,
        state: {
            atoms: [
                { id: 'old-day', title: '第30天', text: '甲在仓库。', storyDay: 30, floorStart: 1, floorEnd: 2, tags: [], updatedAt: 1 },
                { id: 'new-no-day', title: '新情节', text: '甲在码头。', floorStart: 30, floorEnd: 31, tags: [], updatedAt: 2 },
            ],
        },
    });
    const list = trustedPlotList();
    A('A2 任一侧没有天数时**沿用原口径**（楼层优先）：新情节（无 `storyDay`、楼层 31）仍排在有天数的老情节（楼层 2）之前 —— 不会因为「新情节还没写第 N 天」而让时钟倒退',
        list[0].node.id === 'new-no-day' && list[1].node.id === 'old-day',
        J(list.map((x) => [x.node.id, x.node.storyDay, x.node.floorEnd])));
}

// ==================== B 组：自动修复真的执行这一步 ====================
await (async () => {
    const st = boot({
        floors: 40,
        state: {
            state: { date: '1919-01-01', time: '00:00', location: '旧地点', present: ['旧人'] },
            snapshots: [{ id: 'snap-1', name: '角色甲', identity: {}, updatedAt: 1 }],   // 角色名册：供「在场 ← 最新情节的涉及角色」解析
            atoms: [
                { id: 'c-day30', title: '第30天', text: '甲在仓库核对账本。', date: '1919-11-10', time: '10:30', location: '仓库', storyDay: 30, floorStart: 1, floorEnd: 2, entities: ['角色甲'], tags: [], updatedAt: 1 },
                { id: 'c-day2', title: '第2天', text: '甲在码头卸货。', date: '1919-11-02', time: '08:00', location: '码头', storyDay: 2, floorStart: 35, floorEnd: 36, entities: ['某乙'], tags: [], updatedAt: 2 },
            ],
        },
    });
    setRepairHooks({ clockSync: () => {
        const changed = clockAutoExtractOnce({ force: true });
        const res = clockExtractState() || {};
        const s2 = state.state || {};
        return {
            changed: changed === true, date: String(s2.date || ''), time: String(s2.time || ''), location: String(s2.location || ''),
            present: Array.isArray(s2.present) ? s2.present.slice() : [], storyDay: Number(s2.storyDay) || 0,
            plotStoryDay: (() => {
                const node = (state.atoms || []).find((x) => x && String(x.id) === String(res.plotId || ''));
                return Number(node && node.storyDay) || 0;
            })(),
            manualLock: !!(s2.clockSrc && s2.clockSrc.manualLock), source: res.source || {}, plotId: String(res.plotId || ''),
        };
    } });
    const r = await runRepairMech({ silent: true, cause: '单测' });
    const notes = (r.stage1 && r.stage1.notes) || [];
    const note = notes.filter((x) => String(x).indexOf('剧情时钟：') === 0).join(' | ');
    const s3 = state.state || {};
    A('B1 自动修复第 1 段**确实执行**「按最新情节刷新时间/地点/人物」：日期 / 时间 / 地点 / 在场人物 / 第 N 天都按**天数最大**的那条情节（第 30 天 · 仓库）写入 `state.state`；报告里如实回报「剧情时钟：已按最新情节刷新（第 30 天 · 日期 … · 时间 … · 地点 仓库 · 在场 …）」；`stage1.clockSync` 供诊断',
        note.indexOf('剧情时钟：') === 0 && note.indexOf('已按最新情节刷新') > 0
        && note.indexOf('第 30 天') > 0 && note.indexOf('仓库') > 0
        && String(s3.date) === '1919-11-10' && String(s3.time) === '10:30' && String(s3.location) === '仓库'
        // 注：`state.state.storyDay` 只在**正文头结构被采用**时才写（V1 口径）；此处取到的是「情节自身的第 N 天」
        //   （`plotStoryDay`），用于报告与核对「按天数取到的是哪一条」。
        && Array.isArray(s3.present) && s3.present.indexOf('角色甲') >= 0
        && !!r.stage1.clockSync && r.stage1.clockSync.plotStoryDay === 30
        && String((s3.clockSrc || {}).location) === 'plot'
        && String((s3.clockSrc || {}).present) === 'plot-atom' && !!r.stage1.clockSync.plotStoryDay && r.stage1.clockSync.plotStoryDay === 30,
        J({ note, date: s3.date, time: s3.time, location: s3.location, storyDay: s3.storyDay, present: s3.present, src: s3.clockSrc, clockSync: r.stage1.clockSync }));
})();

// ==================== C 组：手工锁定时不覆盖 ====================
await (async () => {
    const st = boot({
        floors: 40,
        state: {
            state: { date: '1919-01-01', time: '00:00', location: '手工地点', clockManual: { date: '1919-01-01', time: '00:00', location: '手工地点', at: 1 } },
            atoms: [{ id: 'c2', title: '第5天', text: '甲在仓库。', date: '1919-11-05', time: '09:00', location: '仓库', storyDay: 5, floorStart: 1, floorEnd: 2, tags: [], updatedAt: 1 }],
        },
    });
    cfg.clockManualLock = true;                        // 默认即为 true；显式写出便于阅读
    const r = await runRepairMech({ silent: true, cause: '单测' });
    const notes = (r.stage1 && r.stage1.notes) || [];
    const note = notes.filter((x) => String(x).indexOf('剧情时钟：') === 0).join(' | ');
    A('C1 手工锁定（`cfg.clockManualLock` 默认开）时**不覆盖**日期 / 时间 / 地点（手工值保持），报告如实回报「已跳过（手工锁定，不覆盖日期/时间/地点）」—— 自动修复不会把用户手工改写的锚点冲掉',
        note.indexOf('剧情时钟：已跳过（手工锁定') === 0
        && String(state.state.date) === '1919-01-01' && String(state.state.location) === '手工地点'
        && !!r.stage1.clockSync && r.stage1.clockSync.manualLock === true,
        J({ note, date: state.state.date, location: state.state.location, clockSync: r.stage1 && r.stage1.clockSync }));
})();

// ==================== D 组：无可用情节不清空 ====================
await (async () => {
    const st = boot({
        floors: 20,
        state: { state: { date: '1919-03-03', time: '12:00', location: '留在地点', present: ['角色甲'] }, atoms: [] },
    });
    const r = await runRepairMech({ silent: true, cause: '单测' });
    A('D1 没有任何可用情节时**不改动时钟**（不清空、不从其它数据类别取值）：已有日期 / 时间 / 地点 / 在场保持原值，`changed:false`（与 `resolveStoryClock` 的既有口径一致）',
        String(state.state.date) === '1919-03-03' && String(state.state.time) === '12:00'
        && String(state.state.location) === '留在地点'
        && !!r.stage1.clockSync && r.stage1.clockSync.changed === false,
        J({ date: state.state.date, location: state.state.location, clockSync: r.stage1 && r.stage1.clockSync }));
})();

R.done();
