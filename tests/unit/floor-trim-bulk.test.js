// ============================================================
// 单元测试 · v3.17.0「删楼卡顿修复：**一次批量截断** + 慢速逐层护栏」
//
// 用户报告（原话）：「请核对当使用插件内置删除楼层功能后，应用整体进入严重卡顿的问题。」
// 真机取证（本机 2026-10-05 01:59:58 → 02:05:43）：
//   · 宿主 `executeSlashCommandsWithOptions` 存在，但 v3.4.0 依赖的 `/cut` **不生效** →
//     走到「逐层 `deleteMessage`」回退（调试日志：`/cut 未生效 → 回退逐层删除 chat 242 > 12`）；
//   · 交互时间线里 02:01:11 → 02:05:06 共 119 次 `host deleteMessage`，相邻间隔 0.85–1.84 秒；
//   · 聊天文件 242 层（4.32MB）逐层变短，02:05:40 才到保留层 → 全过程 ≈5 分 45 秒界面几乎不可用。
// 修复：删除默认走「官方 chat 数组 splice + saveChat + clearChat/printMessages + 一次 MESSAGE_DELETED」
//   （一次完成）；逐层只在「批量不可用且待删 ≤ FLOOR_TRIM_SLOW_MAX(3) 层」时作最后手段，超过即拒绝。
//
// 覆盖：
//   A **能力探测矩阵**：批量（clear+print / reload）可用 → `via:'bulk'`；只有逐层 → `via:'api'`；都没有 → unsupported；
//   B **批量路径**：一次 splice + 一次 saveChat + 一次重渲染 + **一次**事件；**零** `deleteMessage`；摘要/账本如实记 `via:'bulk'`；
//   C **降级矩阵**：落盘失败 → 原样放回（不假装成功）→ 超限拒绝 / ≤3 层逐层；只能逐层且超限 → 拒绝（不备份、不动聊天）；
//   D **护栏**：逐层硬预算中止（partial）；重入保护（busy）；`afterMutate` 钩子在真的删掉后回调一次；
//   E **界面与预检**：诊断行 / 按钮 title 按真实能力说明路径；被拒绝时预检**如实说明秒数**（不静默失败）。
//
// 运行：node tests/unit/floor-trim-bulk.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    floorTrimCapability, floorTrimStatus, floorTrimApply, floorTrimPrecheck, floorTrimBusy, setFloorTrimHooks,
    FLOOR_TRIM_SLOW_MAX,
} from '../../host/floor-trim.js';
import { FLOOR_TRIM_SLOW_MS_PER_FLOOR, FLOOR_TRIM_SLOW_BUDGET_MS, floorTrimSlowSeconds } from '../../core/floor-trim.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const R = makeReporter('floor-trim-bulk v3.17.0 删楼：一次批量截断（默认）+ 慢速逐层护栏');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => {
    const det = () => (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e);
    if (c && typeof c.then === 'function') return c.then((v) => R.assert(n, v === true, det()));
    return R.assert(n, c === true, det());
};

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
let uninstall = null;
/** 造宿主：n 层聊天；`hostOpts.noBulk` = 去掉批量能力；`hostOpts.noDeleteMessage` = 去掉逐层能力 */
function boot(n, hostOpts) {
    if (uninstall) { try { uninstall(); } catch (e) { /* 忽略 */ } uninstall = null; }
    const chat = [];
    for (let i = 0; i < n; i++) chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
    const host = makeHost({ chat: chat, characters: [{ name: '角色甲', avatar: 'trimbulk.png' }], characterId: 0 });
    host.ctx.characters = [{ name: '角色甲', avatar: 'trimbulk.png' }];
    host.ctx.characterId = 0;
    if (hostOpts) {
        if (hostOpts.noBulk) { delete host.ctx.saveChat; delete host.ctx.clearChat; delete host.ctx.printMessages; }
        if (hostOpts.noDeleteMessage) delete host.ctx.deleteMessage;
        if (hostOpts.reloadInstead) { delete host.ctx.clearChat; delete host.ctx.printMessages; host.ctx.reloadCount = 0; host.ctx.reloadCurrentChat = async () => { host.ctx.reloadCount += 1; }; }
        if (hostOpts.saveChatThrows) host.ctx.saveChat = async () => { throw new Error('server 500'); };
        if (hostOpts.extra) Object.assign(host.ctx, hostOpts.extra);
    }
    uninstall = installGlobalHost(host, doc);
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:trimbulk');
    const st = emptyState();
    st.atoms = [{ id: 'a0', h: 'h0', text: '早期情节', floorStart: 1, floorEnd: 3 }];
    st.lastKnownFloor = n - 1;
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return host;
}
let logStore = {};
function bootHooks(extra) {
    logStore = {};
    setFloorTrimHooks(Object.assign({
        exportJson: () => '{"format":"ftt-memory-v2-export","state":{}}',
        writeBackup: async (scope, slot, text) => ({ ok: true, slot: slot, name: 'ftt2-floor-backup-trimbulk-s' + (slot + 1) + '-20261005-020000.json', chars: String(text).length }),
        getLog: () => logStore,
        saveLog: (v) => { logStore = v; },
        noteConflict: () => undefined,
        notify: () => undefined,
        afterMutate: null,
    }, extra || {}));
}
/** 统计 MESSAGE_DELETED 事件次数 */
function countDeleted(host) {
    const box = { n: 0 };
    host.ctx.eventSource.on(host.ctx.eventTypes.MESSAGE_DELETED, () => { box.n += 1; });
    return box;
}

// ---------- A 组：能力探测矩阵 ----------
{
    const h1 = boot(20);
    const cap1 = floorTrimCapability();
    const st1 = floorTrimStatus();
    const pre1 = floorTrimPrecheck(6);
    const h2 = boot(20, { noBulk: true });
    const cap2 = floorTrimCapability();
    const st2 = floorTrimStatus();
    const pre2 = floorTrimPrecheck(6);
    boot(20, { reloadInstead: true });
    const cap3 = floorTrimCapability();
    boot(20, { noBulk: true, noDeleteMessage: true });
    const cap4 = floorTrimCapability();
    A('A1 能力探测矩阵：批量截断可用 → `bulk:true`、`via:"bulk"`（默认路径）；只有逐层 → `bulk:false`、`via:"api"`（慢速最后手段）；批量只剩 `reloadCurrentChat` → `bulkMode:"reload"`；两条路都没有 → `supported:false`（如实降级，不静默失败）',
        cap1.supported === true && cap1.bulk === true && cap1.bulkMode === 'clear+print' && st1.via === 'bulk'
        && cap2.supported === true && cap2.bulk === false && cap2.slow === true && st2.via === 'api'
        && cap3.bulk === true && cap3.bulkMode === 'reload'
        && cap4.supported === false && cap4.reason === 'unsupported-host'
        && FLOOR_TRIM_SLOW_MAX === 3,
        J({ cap1, via1: st1.via, cap2, via2: st2.via, cap3, cap4 }));
    A('A2 预检给出**走哪条路径**：批量可用 → `slowCount:0`/不阻断；只能逐层且 14 层 > 上限 → `blocked:true`、`reason:"slow-path-refused"`、`slowSeconds:21`（14×1.5s，如实告知会卡多久）',
        pre1.ok === true && pre1.bulk === true && pre1.slowCount === 0 && pre1.blocked === false
        && pre2.ok === false && pre2.blocked === true && pre2.reason === 'slow-path-refused' && pre2.slowCount === 14 && pre2.slowSeconds === 21
        && pre2.summary.indexOf('需逐层删除') >= 0 && pre2.summary.indexOf('21 秒') >= 0
        && FLOOR_TRIM_SLOW_MS_PER_FLOOR === 1500 && FLOOR_TRIM_SLOW_BUDGET_MS === 20000,
        J({ pre1: { ok: pre1.ok, bulk: pre1.bulk, slowCount: pre1.slowCount }, pre2: { ok: pre2.ok, blocked: pre2.blocked, slowSeconds: pre2.slowSeconds, summary: pre2.summary } }));
}

// ---------- B 组：批量路径（默认） ----------
await A('B1 **批量路径**（20 层保留 6）：`chat.splice(0,14)` + **一次** `saveChat` + **一次** `clearChat`/`printMessages` + **一次** `MESSAGE_DELETED`；**一次 `deleteMessage` 都不调用**；`via:"bulk"`、摘要/账本如实回报路径与耗时；`chatMetadata.tainted` 置位（官方条件保存据此落盘）',
    (async () => {
        const host = boot(20);
        bootHooks();
        const ev = countDeleted(host);
        const r = await floorTrimApply({ keep: 6 });
        const ctx = host.ctx;
        return r.ok === true && r.deleted === 14 && r.requested === 14 && r.via === 'bulk' && typeof r.ms === 'number' && r.ms >= 0
            && ctx.chat.length === 6
            && (ctx.deletedMessages || []).length === 0
            && (ctx.saveChatCount || 0) === 1 && (ctx.clearChatCount || 0) === 1 && (ctx.printMessagesCount || 0) === 1
            && ctx.chatMetadata.tainted === true && ev.n === 1
            && r.summary.indexOf('删除方式 批量截断（一次完成 · clear+print）') >= 0
            && floorTrimStatus().last && floorTrimStatus().last.via === 'bulk' && floorTrimBusy() === false;
    })(),
    () => J({ via: 'bulk', floors: 6 }));

await A('B2 批量路径的重渲染也可以是**整聊重载**（宿主没有 `clearChat`/`printMessages` 时退 `reloadCurrentChat`）：同样一次完成、`via:"bulk"`、摘要标注 `reload`',
    (async () => {
        const host = boot(30, { reloadInstead: true });
        bootHooks();
        const r = await floorTrimApply({ keep: 10 });
        return r.ok === true && r.deleted === 20 && r.via === 'bulk' && host.ctx.chat.length === 10
            && (host.ctx.reloadCount || 0) === 1 && (host.ctx.deletedMessages || []).length === 0
            && r.summary.indexOf('删除方式 批量截断（一次完成 · reload）') >= 0;
    })(),
    () => J({ mode: 'reload' }));

await A('B3 批量路径真的删掉了才回调 `afterMutate` 一次（宿主据此重推注入）——`clearChat()` 会清空 ST 的 `extension_prompts`，不重推就会出现「删楼后这一轮注入为空」',
    (async () => {
        const host = boot(20);
        const seen = [];
        bootHooks({ afterMutate: (info) => seen.push(info) });
        const r = await floorTrimApply({ keep: 12 });
        return r.ok === true && r.deleted === 8 && seen.length === 1 && seen[0].deleted === 8 && seen[0].via === 'bulk';
    })(),
    () => J({ seen: 1 }));

// ---------- C 组：降级矩阵 ----------
await A('C1 批量路径**落盘失败** → 原样放回（`chat` 恢复原状，绝不留下「内存删了、盘上没删」的半截状态）→ 由于待删 14 层 > 上限，**直接拒绝**并如实回报 `bulk-failed`',
    (async () => {
        const host = boot(20, { saveChatThrows: true });
        bootHooks();
        const r = await floorTrimApply({ keep: 6 });
        return r.ok === false && r.reason === 'slow-path-refused' && r.blocked === true && r.via === 'bulk-failed'
            && host.ctx.chat.length === 20 && (host.ctx.deletedMessages || []).length === 0
            && r.summary.indexOf('已中止') >= 0;
    })(),
    () => J({ reason: 'slow-path-refused' }));

await A('C2 批量路径落盘失败 + 待删只有 2 层（≤ 上限）→ 如实退到**逐层最后手段**：从后往前 2 次、`via:"api"`、聊天到达保留层数',
    (async () => {
        const host = boot(20, { saveChatThrows: true });
        bootHooks();
        const r = await floorTrimApply({ keep: 18 });
        return r.ok === true && r.deleted === 2 && r.via === 'api' && host.ctx.chat.length === 18
            && J(host.ctx.deletedMessages) === J([1, 0]);
    })(),
    () => J({ calls: 2, via: 'api' }));

await A('C3 宿主**只能逐层**且待删 14 层 > 上限 → **拒绝执行**：一层都不删、备份也不做（不制造无用备份）、聊天原样；摘要写明「预计约 21 秒（界面会卡顿）→ 已拒绝执行」',
    (async () => {
        const host = boot(20, { noBulk: true });
        let backupCalled = false;
        bootHooks({ writeBackup: async () => { backupCalled = true; return { ok: true, name: 'x' }; } });
        const r = await floorTrimApply({ keep: 6 });
        return r.ok === false && r.reason === 'slow-path-refused' && r.blocked === true
            && backupCalled === false && host.ctx.chat.length === 20 && (host.ctx.deletedMessages || []).length === 0
            && r.summary.indexOf('已拒绝执行') >= 0 && r.summary.indexOf('21 秒') >= 0;
    })(),
    () => J({ reason: 'slow-path-refused' }));

await A('C4 宿主只能逐层、但待删 2 层（≤ 上限）→ **最后手段可用**：2 次 `deleteMessage`（从后往前）、`via:"api"`、`MESSAGE_DELETED` 2 次、聊天到达保留层数；摘要写明「逐层 API（慢）」',
    (async () => {
        const host = boot(20, { noBulk: true });
        bootHooks();
        const ev = countDeleted(host);
        const r = await floorTrimApply({ keep: 18 });
        return r.ok === true && r.deleted === 2 && r.via === 'api' && host.ctx.chat.length === 18
            && J(host.ctx.deletedMessages) === J([1, 0]) && ev.n === 2
            && r.summary.indexOf('逐层 API（慢）') >= 0;
    })(),
    () => J({ calls: [1, 0], via: 'api' }));

// ---------- D 组：护栏 ----------
await A('D1 逐层**硬预算**（`FLOOR_TRIM_SLOW_BUDGET_MS`）：一旦累计超过预算立即中止并如实回报 `partial`（宁可只删一部分，也不让界面长时间卡住）',
    (async () => {
        const host = boot(20, { noBulk: true });
        bootHooks();
        let t = 0;
        const r = await floorTrimApply({
            keep: 6,
            _deleteOne: async (id) => { host.ctx.chat.splice(Number(id), 1); },   // 显式注入 = 测试选择慢速路径（不受 ≤3 上限约束）
            _now: () => { t += 30000; return t; },
        });
        const okD1 = r.ok === false && r.partial === true && r.deleted === 0 && host.ctx.chat.length === 20
            && r.summary.indexOf('budget 中止') >= 0;
        return okD1;
    })(),
    () => J({ partial: true, deleted: 0 }));

await A('D2 **重入保护**：删楼过程中再次调用直接返回 `busy`（不并发改两次聊天）；`floorTrimBusy()` 进行中为 true、结束后回到 false',
    (async () => {
        const host = boot(20);
        bootHooks();
        let busyDuring = null, reentrant = null;
        host.ctx.saveChat = async () => {
            host.ctx.saveChatCount = (host.ctx.saveChatCount || 0) + 1;
            busyDuring = floorTrimBusy();
            reentrant = await floorTrimApply({ keep: 6, backup: false });
        };
        const r = await floorTrimApply({ keep: 6, backup: false });
        return r.ok === true && r.deleted === 14 && host.ctx.chat.length === 6
            && busyDuring === true && reentrant && reentrant.ok === false && reentrant.reason === 'busy'
            && floorTrimBusy() === false;
    })(),
    () => J({ busy: true, reentrant: 'busy' }));

// ---------- E 组：界面与预检口径 ----------
{
    const okHost = boot(20);
    bootHooks();
    const html = String(settingsPageHtml('data', '') || '');
    boot(20, { noBulk: true });
    const htmlSlow = String(settingsPageHtml('data', '') || '');
    A('E1 数据管理页按**当前宿主真实能力**说明删除方式：批量可用 → 诊断行「删除方式 批量截断（一次完成）」+ 按钮 title「一次性批量截断（官方 chat 数组 + saveChat + 重渲染 + 一次事件通知，快）」；只能逐层 → 「逐层删除（慢）」+ title 写明「约 1.5 秒/层；最多 3 层，超过即拒绝」',
        html.indexOf('删除方式 批量截断（一次完成）') >= 0
        && html.indexOf('一次性批量截断（官方 chat 数组 + saveChat + 重渲染 + 一次事件通知，快）') >= 0
        && htmlSlow.indexOf('删除方式 逐层删除（慢）') >= 0
        && htmlSlow.indexOf('逐层官方 deleteMessage（慢，约 1.5 秒/层；最多 3 层，超过即拒绝）') >= 0
        && htmlSlow.indexOf('超过即拒绝') >= 0,
        J({ bulk: html.indexOf('删除方式 批量截断（一次完成）') >= 0, slow: htmlSlow.indexOf('删除方式 逐层删除（慢）') >= 0 }));
    A('E2 被拒绝的档位在按钮 title 的**预检**里如实说明「预计约 21 秒（界面会卡顿）→ 已拒绝」，并给出可行动作（到酒馆聊天界面自行删楼）',
        htmlSlow.indexOf('逐层删除 14 层预计约 21 秒（界面会卡顿）→ 已拒绝') >= 0
        && htmlSlow.indexOf('请到酒馆聊天界面自行删除更早的楼层') >= 0,
        J({ title: htmlSlow.indexOf('已拒绝') >= 0 }));
    A('E3 摘要函数如实给出逐层预估（`floorTrimSlowSeconds`：2 层 = 3 秒；0 层 = 0 秒）', floorTrimSlowSeconds(2) === 3 && floorTrimSlowSeconds(0) === 0 && floorTrimSlowSeconds(14) === 21, J([floorTrimSlowSeconds(2), floorTrimSlowSeconds(14)]));
}

if (uninstall) { try { uninstall(); } catch (e) { /* 忽略 */ } }
R.done();
