// 单元测试 · v2.94.0「设定 → 数据管理：删除到最近 N 层」（`docs/D12` v0.2 §4 / §8-E / 阶段 S4）
//
// 用户约定：「在设定-数据管理 中约定楼层删除的三个按钮（保留最近 6 / 10 / 12 层），确保插件可感知该操作。」
// 用户补充：「**用官方 API 实现，不然其他插件也会异常。**」
//
// 本文件覆盖五组：
//   A 组 —— 纯内核预检（`core/floor-trim.js#planFloorTrim`）：三档 / 删多少层 / 删哪一段 / 受影响条目；
//   B 组 —— 删后**精确编号重映射**（只改编号、绝不删数据；未知区间幂等）；
//   C 组 —— 宿主层：官方 API 能力探测（缺失 → unsupported，D12 Q6 不静默失败）；
//   D 组 —— 端到端执行：真实删除（走 `ctx.deleteMessage` 桩）→ 事件/落盘可观测 → 记忆条数一条不少；
//   E 组 —— 失败姿态：备份失败即中止（一层都不删）、半途失败如实报告 partial；
//   F 组 —— 界面：数据管理页三档按钮 + 只读诊断行（D12 §8.1）。
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, getLastMessageId, setLastMessageId, setTimerHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { planFloorTrim, remapAfterTrim, trimSummaryText, FLOOR_TRIM_PRESETS } from '../../core/floor-trim.js';
import {
    setFloorTrimHooks, floorTrimCapability, floorTrimStatus, floorTrimPrecheck, floorTrimApply,
    floorRecalibrate, floorCalibrateStatus, countStaleEntries,
    FLOOR_TRIM_PRESETS as HOST_PRESETS,
} from '../../host/floor-trim.js';
import { runAutoSummary } from '../../host/extract.js';
import { liveLastFloorId } from '../../host/floors.js';
import { floorBackupName, writeFloorBackup, nextFloorBackupSlot, FLOOR_BACKUP_PREFIX, FLOOR_BACKUP_SLOTS } from '../../adapters/floor-backup.js';
import { hashFloorText, isFloorProcessed, scanPendingFloors, processedStats } from '../../host/floors.js';   // v3.0.19：F1/F2/H1 断言需要（此前那些断言是假绿，漏了 import 也没暴露）
import { settingsPageHtml } from '../../ui/settings-pages.js';
import { storagePageHtml } from '../../ui/sync.js';

const R = makeReporter('floor-trim v2.94.0 数据管理删楼（官方 API + 备份 + 精确编号校准）');
// v3.0.19（测试完整性）：**异步断言必须真的被求值**。
//   旧写法 `(n, c) => R.assert(n, !!c)` 里的 `!!` 会把 Promise 直接变成 `true` ——
//   于是本文件里所有 `A('…', (async () => {…})(), …)` 都是**假绿**（D1–E3、G2、F1/F2、G1、H1 从未真正执行）。
//   现在：条件为 thenable 时返回 Promise（调用点必须 `await A(...)`），布尔时同步断言；
//   同时把 detail 支持成函数（失败时才算，避免无谓开销）。漏写 await 时由 `R.assert` 的 thenable 防呆兜住。
const A = (n, c, e) => {
    const det = () => (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e);
    if (c && typeof c.then === 'function') return c.then((v) => R.assert(n, v === true, det()));
    return R.assert(n, c === true, det());
};
const J = (v) => JSON.stringify(v);

// ---------- 桩宿主 ----------
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
let uninstallHost = null;
function bootHost(opts) {
    const o = opts || {};
    if (uninstallHost) { try { uninstallHost(); } catch (e) { /* 忽略 */ } uninstallHost = null; }
    const chat = [];
    for (let i = 0; i < (o.floors || 20); i++) chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼正文', name: i % 2 === 0 ? 'User' : 'AI' });
    const host = makeHost(Object.assign({ chat: chat }, o.hostOpts || {}));
    uninstallHost = installGlobalHost(host, doc);
    return host;
}
bootHost({ floors: 20 });

/** 内核复位：空状态 + 若干带楼层区间的条目（覆盖「全删 / 跨越 / 幸存」三种） */
function bootState() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:floortrim');
    const st = emptyState();
    st.atoms = [
        { id: 'a0', h: 'h0', text: '早期情节', floorStart: 1, floorEnd: 3 },      // 全在被删段
        { id: 'a1', h: 'h1', text: '跨越情节', floorStart: 0, floorEnd: 15 },      // 跨越删除线
        { id: 'a2', h: 'h2', text: '幸存情节', floorStart: 12, floorEnd: 14 },     // 完全幸存
        { id: 'a3', h: 'h3', text: '未知区间', floorStart: 0, floorEnd: 0 },       // 已是未知 → 幂等
    ];
    st.memories = [{ id: 'm0', h: 'mh0', text: '记忆', floorStart: 2, floorEnd: 5 }];
    st.plotSegments = [{ id: 's0', h: 'sh0', start: 0, end: 2 }, { id: 's1', h: 'sh1', start: 10, end: 12 }];
    st.processedFloors = [{ f: 1, h: 'x1' }, { f: 11, h: 'x11' }, { f: 13, h: 'x13' }];
    st.lastKnownFloor = 19;
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    return st;
}
bootState();

/** 删楼钩子（账本在内存里，模拟 ST 扩展设置 `floorTrimLog`） */
let logStore = {};
function bootHooks(extra) {
    logStore = {};
    setFloorTrimHooks(Object.assign({
        exportJson: () => '{"format":"ftt-memory-v2-export","state":{}}',
        writeBackup: async (scope, slot, text) => ({ ok: true, slot: slot, name: 'ftt2-floor-backup-' + String(scope).replace(/[^A-Za-z0-9_.-]/g, '') + '-' + (slot + 1) + '.json', chars: text.length }),
        getLog: () => logStore,
        saveLog: (v) => { logStore = v; },
        noteConflict: () => undefined,
        notify: () => undefined,
    }, extra || {}));
}

// ---------- A 组：纯内核预检 ----------
A('A1 三档固定为 6 / 10 / 12（内核与宿主层同一常量来源）', (() => {
    return FLOOR_TRIM_PRESETS.length === 3 && FLOOR_TRIM_PRESETS[0] === 6 && FLOOR_TRIM_PRESETS[1] === 10
        && FLOOR_TRIM_PRESETS[2] === 12 && HOST_PRESETS === FLOOR_TRIM_PRESETS;
})(), J(FLOOR_TRIM_PRESETS));

A('A2 预检口径（20 层保留 6）：删 14 层、区间 [0,13]、幸存区间 [14,19]、新末楼 5', (() => {
    const p = planFloorTrim({ chatLen: 20, keep: 6, state: state });
    return p.ok === true && p.total === 20 && p.keep === 6 && p.removeCount === 14
        && J(p.removeRange) === J([0, 13]) && J(p.keepRange) === J([14, 19]) && p.newLastId === 5;
})(), () => J(planFloorTrim({ chatLen: 20, keep: 6, state: state })));

A('A3 受影响条目按「区间与 [0,M-1] 有交集」统计：a0/a1/a2 + m0 + s0/s1 共 6 条（未知区间 a3 不计）', (() => {
    const p = planFloorTrim({ chatLen: 20, keep: 6, state: state });
    const aff = p.affected || {};
    return aff.total === 6 && aff.dims.atoms === 3 && aff.dims.memories === 1 && aff.dims.plotSegments === 2
        && aff.dims.currencies === undefined;
})(), () => J(planFloorTrim({ chatLen: 20, keep: 6, state: state }).affected));

A('A4 无操作 / 参数异常：楼层不足该档 → nothing-to-delete；无聊天 → no-chat；keep<1 → bad-keep', (() => {
    const a = planFloorTrim({ chatLen: 4, keep: 6, state: state });
    const b = planFloorTrim({ chatLen: 0, keep: 6, state: state });
    const c = planFloorTrim({ chatLen: 20, keep: 0, state: state });
    return a.ok === false && a.reason === 'nothing-to-delete' && a.removeCount === 0
        && b.ok === false && b.reason === 'no-chat'
        && c.ok === false && c.reason === 'bad-keep';
})(), '');

A('A5 摘要文案讲清「当前几层 / 保留几层 / 删几层 / 影响几条」并追加「未提取」提示（不含正文）', (() => {
    const p = planFloorTrim({ chatLen: 20, keep: 10, state: state });
    const t = trimSummaryText(p, { unextracted: 3, supported: true });
    return t.indexOf('当前 20 层') >= 0 && t.indexOf('保留最近 10 层') >= 0 && t.indexOf('将删除 10 层') >= 0
        && t.indexOf('受影响记忆') >= 0 && t.indexOf('3 层尚未提取') >= 0 && t.indexOf('情节') < 0;
})(), () => trimSummaryText(planFloorTrim({ chatLen: 20, keep: 10, state: state }), { unextracted: 3 }));

// ---------- B 组：删后精确编号重映射（只改编号，绝不删数据） ----------
// v3.7.0（用户要求）：「原始楼层不应该变动……找不到对应楼层哈希值 → 标记原文已移除；新的楼层结合新的位置记录。」
A('B1 三种区间分别处理（v3.7.0 口径）：**来源楼层原样保留**；全删段 → 打「原文已移除」（`originGone`）；跨越 → 起点记 0 / 终点记新位置；未知区间幂等', (() => {
    bootState();
    const before = state.atoms.length + state.memories.length + state.plotSegments.length;
    const r = remapAfterTrim(state, 14, 5);
    const g = (id) => state.atoms.filter((x) => x.id === id)[0];
    const s0 = state.plotSegments.filter((x) => x.id === 's0')[0];
    const after = state.atoms.length + state.memories.length + state.plotSegments.length;
    return r.ok === true && before === after                                   // **一条都没删**
        // ① 全删段（1..3，M=14）：来源楼层不动 + 原文已移除
        && g('a0').floorStart === 1 && g('a0').floorEnd === 3 && g('a0').originGone === true && g('a0').floorNowStart === undefined
        // ② 跨越删除线（0..15）：来源楼层不动；当前位置起点未知（0）、终点 15-14=1
        && g('a1').floorStart === 0 && g('a1').floorEnd === 15 && g('a1').floorNowStart === 0 && g('a1').floorNowEnd === 1
        // ③ 未知区间（0/0）→ 幂等不动
        && g('a3').floorStart === 0 && g('a3').floorEnd === 0 && g('a3').originGone === undefined
        && s0.start === 0 && s0.end === 2 && s0.originGone === true      // 分段总结：来源区间（0..2）保留，只打原文已移除
        && r.staled >= 3;
})(), () => J(state.atoms));

A('B2 幸存项写**当前位置**（来源楼层不动）+ 未知区间不动 + 台账重排（丢弃被删段、幸存段前移）+ lastKnownFloor 收紧', (() => {
    bootState();
    // 15 层场景：删 10 层，幸存 [10,19] → 旧 12 变新 2
    const st = state;
    st.atoms = [
        { id: 's', h: 'hs', floorStart: 12, floorEnd: 14 },     // 幸存 → 2/4
        { id: 'u', h: 'hu', floorStart: 0, floorEnd: 0 },       // 未知 → 保持不动
        { id: 'd', h: 'hd', floorStart: 3, floorEnd: 4 },       // 全删 → 0/0 + stale
    ];
    st.memories = []; st.plotSegments = []; st.currentStates = [];   // 本断言只考察上述三项
    st.processedFloors = [{ f: 2, h: 'p2' }, { f: 10, h: 'p10' }, { f: 15, h: 'p15' }];
    st.lastKnownFloor = 19;
    const r = remapAfterTrim(st, 10, 9);
    const s = st.atoms.filter((x) => x.id === 's')[0];
    const u = st.atoms.filter((x) => x.id === 'u')[0];
    const d = st.atoms.filter((x) => x.id === 'd')[0];
    return s.floorStart === 12 && s.floorEnd === 14 && s.floorNowStart === 2 && s.floorNowEnd === 4 && s.floorStale === undefined
        && u.floorStart === 0 && u.floorEnd === 0 && u.floorNowStart === undefined && u.originGone === undefined
        && d.floorStart === 3 && d.floorEnd === 4 && d.originGone === true
        && st.processedFloors.length === 2 && st.processedFloors[0].f === 0 && st.processedFloors[0].h === 'p10'
        && st.processedFloors[1].f === 5 && st.processedFloors[1].h === 'p15'
        && st.lastKnownFloor === 9 && r.shifted === 1 && r.staled === 1 && Number.isFinite(st.floorShrinkAt);
})(), () => ({ pf: state.processedFloors, lk: state.lastKnownFloor }));

A('B3 M=0 时不动任何字段（幂等短路）', (() => {
    bootState();
    const snapshot = J(state.atoms);
    const r = remapAfterTrim(state, 0, 19);
    return r.ok === true && r.shifted === 0 && JSON.stringify(state.atoms) === snapshot;
})(), '');

// ---------- C 组：官方 API 能力探测（D12 Q6） ----------
A('C1 有 `ctx.deleteMessage` → supported=true；上下文缺失 → no-host', (() => {
    bootHost({ floors: 20 });
    const cap = floorTrimCapability();
    return cap.supported === true && cap.ok === true && cap.reason === '';
})(), () => J(floorTrimCapability()));

A('C2 宿主**不提供**官方删楼接口 → supported=false / reason=unsupported-host（不静默失败，按钮侧置灰）', (() => {
    bootHost({ floors: 20, hostOpts: { noDeleteMessage: true } });
    const cap = floorTrimCapability();
    const pre = floorTrimPrecheck(6);
    return cap.supported === false && cap.reason === 'unsupported-host'
        && pre.ok === false && pre.supported === false && pre.reason === 'unsupported-host';
})(), () => J(floorTrimCapability()));

A('C3 无宿主上下文时预检/执行都如实返回（不抛异常）', (() => {
    const g = globalThis.SillyTavern;
    try {
        delete globalThis.SillyTavern;
        const cap = floorTrimCapability();
        const pre = floorTrimPrecheck(6);
        return cap.supported === false && cap.reason === 'no-host' && pre.ok === false;
    } finally { globalThis.SillyTavern = g; }
})(), '');

// ---------- D 组：端到端执行（真实删除流程，全走官方 API 桩） ----------
await A('D1 20 层保留 6：真实调用 `ctx.deleteMessage` 14 次（从后往前），聊天真的变短，并触发 14 次 MESSAGE_DELETED', (async () => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks();
    const r = await floorTrimApply({ keep: 6 });
    const host2 = globalThis.SillyTavern.getContext();
    const deleted = host2.deletedMessages || [];
    return r.ok === true && r.deleted === 14 && r.requested === 14
        && host2.chat.length === 6
        && deleted.length === 14
        && deleted[0] === 13 && deleted[13] === 0                 // **从后往前**：先删最大下标
        && (host2.saveMetadataCount || 0) === 14;                 // 每次都落盘（官方方法自带）
})(), () => ({ r: '见断言', floors: globalThis.SillyTavern.getContext().chat.length }));

await A('D2 记忆一条都不少（只改编号，v3.7.0）：原子数不变、全删段条目「原文已移除」（来源楼层保留）、跨越段按**新位置**记 floorNow*、幸存段条目前移', (async () => {
    bootHost({ floors: 20 });
    const st = bootState();
    bootHooks();
    const n0 = st.atoms.length + st.memories.length + st.plotSegments.length;
    const r = await floorTrimApply({ keep: 6 });
    const n1 = st.atoms.length + st.memories.length + st.plotSegments.length;
    const a0 = st.atoms.filter((x) => x.id === 'a0')[0];
    const a2 = st.atoms.filter((x) => x.id === 'a2')[0];
    return r.ok === true && n0 === n1
        // v3.7.0：来源楼层**原样保留**；找不到原文的条目打「原文已移除」
        && a0.floorStart === 1 && a0.floorEnd === 3 && a0.originGone === true
        // 旧 12..14 **跨越**删除线（M=14）→ 只有原第 14 楼幸存 → 当前位置 = 新第 0 楼（来源 12..14 原样保留）
        && a2.floorStart === 12 && a2.floorEnd === 14 && a2.originGone === undefined
        && a2.floorNowStart === 0 && a2.floorNowEnd === 0;
})(), () => J(state.atoms));

await A('D3 删前**自动明文备份**（3 槽轮转）：备份内容 = 导出信封、槽位 0→1→2→0、账本只留 3 条', (async () => {
    const seen = [];
    let last = null;
    // v3.0.19：**先把账本清空**（`bootHooks()` 的 logStore = {}），此后跨轮持久 —— 轮转才有意义。
    //   此前账本带着上一断言残留的槽位（起点不是 0），而这条断言从没真正执行过（假绿）所以没暴露。
    bootHooks({ writeBackup: async (scope, slot, text) => { seen.push(slot); return { ok: true, slot: slot, name: 'bk-' + slot + '.json', chars: text.length }; } });
    for (let i = 0; i < 4; i++) {
        bootHost({ floors: 20 });
        bootState();
        last = await floorTrimApply({ keep: 10 });
    }
    const okD3 = J(seen) === J([0, 1, 2, 0])
        && last.ok === true && last.backup.ok === true && last.backup.name === 'bk-0.json'
        && Array.isArray(logStore.items) && logStore.items.length === 3;
    if (!okD3) console.log('D3-DEBUG ' + J({ seen: seen, last: last && { ok: last.ok, reason: last.reason, backup: last.backup, deleted: last.deleted }, items: (logStore.items || []).length }));
    return okD3;
})(), () => J({ seen: seen, items: (logStore.items || []).length }));

await A('D4 只读诊断：当前层数 / 插件条数 / 上次删楼（保留层数 + 备份文件名）；未删过时为 null', (async () => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks();
    const before = floorTrimStatus();
    await floorTrimApply({ keep: 12 });
    const after = floorTrimStatus();
    return before.last === null && before.floors === 20 && before.entries === 7 && before.supported === true
        && after.last !== null && after.last.keep === 12 && after.last.removed === 8 && after.last.backup.indexOf('ftt2-floor-backup-') === 0
        && after.floors === 12 && after.presets.length === 3;
})(), () => J(floorTrimStatus()));

await A('D5 低噪声记账：登记一条人工确认项（kind=删楼，detail 含备份文件名与「记忆保留 N 条」）+ 调试日志', (async () => {
    bootHost({ floors: 20 });
    bootState();
    const notes = [];
    const logs = [];
    bootHooks({
        noteConflict: (item) => notes.push(item),
        notify: () => undefined,
    });
    // 挂钩内核日志（`log` 经 runtime 注入）
    const r = await floorTrimApply({ keep: 10 });
    return r.ok === true && notes.length === 1 && notes[0].kind === '删楼'
        && notes[0].detail.indexOf('删除 10 层') >= 0 && notes[0].detail.indexOf('记忆保留') >= 0
        && notes[0].detail.indexOf('备份') >= 0 && notes[0].count === 1;
})(), '');

// ---------- E 组：失败姿态 ----------
await A('E1 备份失败 → **中止**：一层都没删（不允许「删了但没备份」）', (async () => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks({ writeBackup: async () => ({ ok: false, error: 'upload 500' }) });
    const r = await floorTrimApply({ keep: 10 });
    const host2 = globalThis.SillyTavern.getContext();
    return r.ok === false && r.reason === 'backup-failed' && host2.chat.length === 20 && (host2.deletedMessages || []).length === 0;
})(), () => J({ ok: false, floors: globalThis.SillyTavern.getContext().chat.length }));

await A('E2 半途失败（第 5 次起无效）→ 如实报告 partial + 已删层数；编号按**实际删除量**校准，记忆仍一条不少', (async () => {
    bootHost({ floors: 20 });
    const st = bootState();
    bootHooks();
    let n = 0;
    const r = await floorTrimApply({
        keep: 6,
        _deleteOne: async (id) => {
            n++;
            if (n > 5) return;                                   // 后 9 次：调用无效（模拟宿主未渲染/拒绝）
            const ctx = globalThis.SillyTavern.getContext();
            ctx.chat.splice(id, 1);
        },
    });
    return r.ok === false && r.partial === true && r.deleted === 5 && r.requested === 14
        && globalThis.SillyTavern.getContext().chat.length === 15
        && st.atoms.length === 4 && st.memories.length === 1 && st.plotSegments.length === 2;
})(), () => J({ deleted: 5, floors: globalThis.SillyTavern.getContext().chat.length }));

await A('E3 不支持宿主时执行直接返回 unsupported（不做任何备份、不碰聊天）', (async () => {
    bootHost({ floors: 20, hostOpts: { noDeleteMessage: true } });
    bootState();
    let backupCalled = false;
    bootHooks({ writeBackup: async () => { backupCalled = true; return { ok: true }; } });
    const r = await floorTrimApply({ keep: 6 });
    return r.ok === false && r.unsupported === true && r.reason === 'unsupported-host'
        && backupCalled === false && globalThis.SillyTavern.getContext().chat.length === 20;
})(), '');

// ---------- F 组：界面（设定 → 数据管理） ----------
A('F1 数据管理页三档按钮齐备（保留最近 6/10/12 层）+ 只读诊断行「当前 N 层 · 插件 M 条」', (() => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks();
    const h = String(settingsPageHtml('data', '') || '');
    return h.indexOf('✂️ 删除聊天楼层（减小聊天体积）') >= 0
        && h.indexOf('data-ftt-action="floorTrim" data-ftt-keep="6"') >= 0
        && h.indexOf('data-ftt-action="floorTrim" data-ftt-keep="10"') >= 0
        && h.indexOf('data-ftt-action="floorTrim" data-ftt-keep="12"') >= 0
        && h.indexOf('>保留最近 6 层</button>') >= 0 && h.indexOf('>保留最近 10 层</button>') >= 0
        && h.indexOf('>保留最近 12 层</button>') >= 0
        && h.indexOf('只读诊断：当前 20 层 · 插件 7 条') >= 0;
})(), '');

A('F2 按钮 title 给出**预检**（将删层数 / 受影响条数）；宿主不支持时**禁用 + 写明原因**', (() => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks();
    const okHtml = String(settingsPageHtml('data', '') || '');
    const okTitle = okHtml.indexOf('将删除 14 层') >= 0 && okHtml.indexOf('受影响记忆 4 条') >= 0;
    bootHost({ floors: 20, hostOpts: { noDeleteMessage: true } });
    const noHtml = String(settingsPageHtml('data', '') || '');
    const dis = noHtml.indexOf('data-ftt-action="floorTrim" data-ftt-keep="6" disabled') >= 0
        && noHtml.indexOf('当前宿主不提供官方删除楼层接口') >= 0;
    return okTitle && dis;
})(), '');

A('F3 v2.96.0 顺序调整（用户要求「危险操作放到最后」）：危险区横幅 → 删楼 → 删数据，三块**都在页面末尾**（安全分块之后），且删楼与删数据**分块呈现**', (() => {
    bootHost({ floors: 20 });
    bootState();
    bootHooks();
    const h = String(settingsPageHtml('data', '') || '');
    const i0 = h.indexOf('data-ftt-danger-zone');
    const i1 = h.indexOf('✂️ 删除聊天楼层');
    const i2 = h.indexOf('🗑 删除数据（不可恢复）');
    const safe = h.indexOf('🗂 本地缓冲');
    return i0 > 0 && i1 > i0 && i2 > i1 && safe > 0 && i0 > safe
        && h.indexOf('插件已提取的记忆<b>不会</b>随之丢失') > 0
        && h.indexOf('以下两块都会写入不可逆的改动') > 0
        // 「不可恢复」的那个按钮在页面最末（危险区按「可回滚的在前」排序）
        && h.indexOf('data-ftt-action="reset"') > i2;
})(), '');



// ---------- G 组：设定 → 存储「🧱 楼层校准」（`docs/D12` §3.4 / 阶段 S3；幂等手动兜底） ----------
A('G1 存储页含「🧱 楼层校准」分节：只读诊断（当前层数 / 标记数 / 最近一次收缩时间 / 失效条数）+「🔄 重新校准楼层」按钮', (() => {
    bootHost({ floors: 20 });
    const st = bootState();
    st.floorShrinkAt = 0;
    const h = String(storagePageHtml([]) || '');
    const h2 = (() => { st.floorShrinkAt = Date.now(); st.atoms[0].floorStale = true; return String(storagePageHtml([]) || ''); })();
    return h.indexOf('data-ftt-floor-calibrate') >= 0 && h.indexOf('🧱 楼层校准') >= 0
        && h.indexOf('data-ftt-action="floorRecalibrate"') >= 0 && h.indexOf('只改编号，条目一条不删') >= 0
        && h.indexOf('尚未发生楼层收缩') >= 0
        && h2.indexOf('最近一次收缩：') >= 0 && h2.indexOf('1</b> 条条目的<b>原文已移除</b>') >= 0   // v3.7.0：文案由「楼层信息已失效/未知区间」改为「原文已移除」
        && h2.indexOf('当前 20 层') >= 0;
})(), '');

await A('G2 `floorRecalibrate()` 幂等兜底：无收缩 → skipped=no-shrink 且不动数据；有收缩 → 真实重算（编号降级 + 基线收紧），**条目不删**', (async () => {
    bootHost({ floors: 20 });
    const st = bootState();
    const n0 = st.atoms.length + st.memories.length + st.plotSegments.length;
    // ① 无收缩：聊天 20 层、基线 19 → 幂等短路，不动作
    st.lastKnownFloor = 19;
    const a = await floorRecalibrate();
    const aSnap = J(st.atoms);
    // ② 人为「在酒馆里自己删了楼」：聊天只剩 6 层，基线仍停在 19 → 强制重算
    const ctx = globalThis.SillyTavern.getContext();
    ctx.chat.length = 6;
    const b = await floorRecalibrate();
    const n1 = st.atoms.length + st.memories.length + st.plotSegments.length;
    const a2 = st.atoms.filter((x) => x.id === 'a2')[0];
    const a3 = st.atoms.filter((x) => x.id === 'a3')[0];
    // ③ 幂等：再跑一次不应再改任何条目
    const after = J(st.atoms);
    const c = await floorRecalibrate();
    return a.ok === true && a.skipped === 'no-shrink' && a.lastId === 19
        && b.ok === true && b.lastId === 5 && b.staleEntries >= 1 && st.lastKnownFloor === 5
        && n0 === n1                                                // **条目不删**
        // v3.7.0：来源楼层保留；超出末楼且找不到原文 → 原文已移除
        && a2.floorStart === 12 && a2.floorEnd === 14 && a2.originGone === true
        && a3.floorStart === 0 && a3.floorEnd === 0 && a3.originGone === undefined
        && c.ok === true && J(st.atoms) === after;                   // 幂等
})(), () => J({ lk: state.lastKnownFloor, stale: countStaleEntries() }));
// v3.7.0：「原文已移除」计数（只读诊断）—— `countStaleEntries()` 现同时统计 `originGone` 与历史 `floorStale`

A('G3 校准状态只读诊断：返回最近一次收缩时间 / 失效条数 / 当前层数 / 台账标记数', (() => {
    bootHost({ floors: 20 });
    const st = bootState();
    st.floorShrinkAt = 1700000000000;
    st.atoms[0].floorStale = true;
    st.processedFloors = [{ f: 1, h: 'a' }, { f: 2, h: 'b' }];
    const r = floorCalibrateStatus();
    return r.at === 1700000000000 && r.stale === 1 && r.floors === 20 && r.marks === 2 && r.lastKnownFloor === 19;
})(), () => J(floorCalibrateStatus()));

// ---------- F 组：v3.0.16 删楼后仍能继续分析 ----------
// 用户报告（原话）：「新版本 使用内置删除楼层后，无法衔接继续分析，新增正文无法分析。」
// 根因：内置删楼走官方 `deleteMessage()`（只发 `MESSAGE_DELETED`，我们未订阅）→ 内核的
//   `getLastMessageId()`（聊天同步快照）**仍是删楼前的旧值**；而 `runAutoSummary` 的区间
//   （`effLast = lastId - 2`）就是用它算的 → 扫到一堆**已不存在**的楼层 → 全部 `missing`
//   → 「本次没有可分析楼层」→ 用户看到的就是「删楼后新正文无法分析」。
await A('F1 内置删楼后**立刻刷新聊天视图**：内核 `getLastMessageId()` = 新末楼（无需等下一次事件），且「按末楼推进」的基线（推演间隔 / 传言轮次）一并收紧到新末楼', (async () => {
    const host = bootHost({ floors: 30 });
    const st = bootState();
    st.lastKnownFloor = 29;
    st.weaveLastFloor = 28;
    st.rumorTick = { round: 3, lastFloor: 29, parallelFloor: 27, runs: 2, lastAt: 0 };
    setLastMessageId(29);                                   // 删楼前的快照
    bootHooks();
    const before = getLastMessageId();
    const r = await floorTrimApply({ keep: 10, backup: false, _deleteOne: async (id) => { host.ctx.chat.splice(id, 1); } });
    return r.ok === true && host.ctx.chat.length === 10
        && before === 29 && getLastMessageId() === 9           // 刷新为活值
        && liveLastFloorId() === 9
        && Number(st.lastKnownFloor) === 9
        && Number(st.weaveLastFloor) === 9 && Number(st.rumorTick.lastFloor) === 9 && Number(st.rumorTick.parallelFloor) === 9;
})(), () => J({ last: getLastMessageId(), live: liveLastFloorId(), weave: Number(state.weaveLastFloor) }));

await A('F2 **根因回归**（用户报告的那条路径）：即使内核末楼快照仍是删楼前的**旧值**（真实竞态），批量摘要也按**活值**算区间 —— 删楼后新增的正文照常被分析（修复前：区间指向已不存在的楼层 → 全部 missing →「没有可分析楼层」）', (async () => {
    const host = bootHost({ floors: 30 });
    const st = bootState();
    st.lastKnownFloor = 29;
    bootHooks();
    // 删到只剩 10 楼（用官方 API 语义：从后往前 splice）
    await floorTrimApply({ keep: 10, backup: false, _deleteOne: async (id) => { host.ctx.chat.splice(id, 1); } });
    // 之后用户继续聊天：新增一楼（全新正文），并把内核快照**人为变旧**（模拟「还没收到事件刷新」的窗口）
    host.ctx.chat.push({ is_user: false, mes: '【新】甲在码头发现一只新的铜箱，断口整齐。', name: 'AI' });
    st.processedFloors = (st.processedFloors || []).filter((x) => Number(x.f) <= 8);
    setLastMessageId(29);
    const snapshotBefore = getLastMessageId();
    const r = await runAutoSummary({ ai: async () => ({ ok: true, text: J({ 情节: { 新增: [{ 标题: '铜箱', 正文: '甲在码头发现一只新的铜箱（正文足够长）。', 日期: '1919-12-02' }] } }) }) });
    const analyzed = (state.atoms || []).some((a) => a.title === '铜箱');
    return snapshotBefore === 29 && r.ok === true && Number(r.made) >= 1 && analyzed === true
        && Number(String(r.floors || '0-0').split('-')[1]) <= host.ctx.chat.length - 1;      // 区间不越界
})(), () => J({ floors: state.processedFloors && state.processedFloors.length, atoms: (state.atoms || []).map((x) => x.title) }));

// ---------- G 组：v3.0.17 备份文件名带日期时间（用户要求「导出 json 备份，文件名必须带日期和时间」）----------
await A('G1 删楼备份文件名**带日期时间**（`ftt2-floor-backup-<角色>-s<槽位>-YYYYMMDD-HHmmss.json`）：三个槽位各自成文件、可直接按名排序；写成功后**删掉该槽位的上一份**（「3 份轮转」上限不变）', (async () => {
    const at = new Date(2026, 8, 30, 14, 5, 22);
    const n0 = floorBackupName('char:abc', 0, at);
    const n1 = floorBackupName('char:abc', 1, at);
    const n2 = floorBackupName('char:abc', 2, at);
    const nameOk = n0 === FLOOR_BACKUP_PREFIX + 'charabc-s1-20260930-140522.json'
        && /^ftt2-floor-backup-charabc-s3-\d{8}-\d{6}\.json$/.test(n2)
        && n0 !== n1 && n1 !== n2 && n0.indexOf(':') < 0;
    // 假宿主：上传成功、删除记为「已删除」
    const prevFetch = globalThis.fetch;
    const deleted = [];
    globalThis.fetch = async (url, opts) => {
        if (String(url) === '/api/files/delete') { try { deleted.push(String(JSON.parse((opts && opts.body) || '{}').path || '')); } catch (e) { /* 忽略 */ } return { status: 200, text: 'ok' }; }
        return { status: 200, text: 'ok' };
    };
    const oldName = FLOOR_BACKUP_PREFIX + 'abc-s1-20200101-000000.json';
    const w = await writeFloorBackup('char:abc', 0, '{"x":1}', { at: at, prevName: oldName });
    globalThis.fetch = prevFetch;
    const g1ok = nameOk && w.ok === true && w.name === n0 && w.replaced === oldName
        && deleted.length === 1 && String(deleted[0]).indexOf(oldName) >= 0
        && FLOOR_BACKUP_SLOTS === 3 && nextFloorBackupSlot(2) === 0 && nextFloorBackupSlot(-1) === 0;
    if (!g1ok) console.log('G1-DEBUG ' + J({ nameOk: nameOk, n0: n0, w: w, deleted: deleted, oldName: oldName }));
    return g1ok;
})(), () => J({ name: floorBackupName('char:abc', 0, new Date(2026, 8, 30, 14, 5, 22)) }));

// ---------- H 组：v3.0.19 「删除只成功一部分」也要能继续分析（用户报告「删除后无法正常继续分析」）----------
await A('H1 v3.0.19 删楼**只成功一部分**（前缀里有「洞」→ 前移量与实际下标对不上）时：台账按**内容哈希**归位 —— 仍然存在的楼层保持「已处理」（不会成片重分析），且删楼后**新增的楼层仍是未摘要、可正常继续分析**', (async () => {
    const host = bootHost({ floors: 30 });
    const st = bootState();
    st.atoms = [];
    for (let i = 0; i < 30; i++) st.atoms.push({ id: 'h' + i, h: 'hh' + i, text: '第' + i + '楼正文', floorStart: i, floorEnd: i });
    st.processedFloors = [];
    for (let i = 0; i < 30; i++) { const h = hashFloorText(i); if (h) st.processedFloors.push({ f: i, h: h }); }
    st.processedVer = processedStats().tag;
    st.lastKnownFloor = 29;
    bootHooks();
    // 删除 19..0，但 **id=5 删不掉**（宿主中途失败/该层被别的东西挡住）→ 前缀出现「洞」
    const r = await floorTrimApply({
        keep: 10, backup: false,
        _deleteOne: async (id) => { if (id === 5) return; host.ctx.chat.splice(id, 1); },
    });
    const chatNow = host.ctx.chat.length;                                  // 16：0..5 原文 + 20..29 前移
    const markFloors = (state.processedFloors || []).map((x) => x.f).sort((a, b) => a - b);
    // 台账必须与「当前实际内容」对齐：0..5（老 0..5）与 6..15（老 20..29）都在册
    const marksOk = chatNow === 16 && markFloors.length === 16
        && markFloors[0] === 0 && markFloors[15] === 15
        && isFloorProcessed(0) === true && isFloorProcessed(5) === true && isFloorProcessed(6) === true;
    // 继续聊天：新增一层 → 必须仍是「未摘要」（可继续分析），而不是被判成已处理/已有数据
    host.ctx.chat.push({ is_user: false, mes: '【删楼后新正文】甲在码头清点新到的铜箱。', name: 'AI' });
    const sc = scanPendingFloors();
    const pendingOk = sc.floors.indexOf(16) >= 0 && isFloorProcessed(16) === false;
    if (!(r.partial === true && r.deleted === 14 && marksOk && pendingOk)) {
        console.log('H1-DEBUG ' + J({ partial: r.partial, deleted: r.deleted, chatNow: chatNow, marks: markFloors.length, first: markFloors[0], last: markFloors[markFloors.length - 1], p0: isFloorProcessed(0), p5: isFloorProcessed(5), p6: isFloorProcessed(6), p16: isFloorProcessed(16), floors: sc.floors, skipped: sc.skipped }));
    }
    return r.partial === true && r.deleted === 14 && marksOk && pendingOk;
})(), () => J({ marks: (state.processedFloors || []).length, floors: scanPendingFloors().floors, chat: undefined }));

R.done();
