// ============================================================
// 单元测试 · v3.26.4「台账标记丢失 → 大量楼层误报未分析」修复
//
// 真机取证（用户报告）：「新版本 请调试对接，突然冒出来大量未分析的楼层，实际早已分析。」
//   只读复算事实：聊天 231 层，台账只剩 68 条标记（全部与各自楼层正文哈希一致 → 台账没「错位」），
//   未分析清单重算 = 41 层（AI 楼 2,4,…,98）；这批楼层**既无标记、也无丢弃留痕、覆盖判据也不认**，
//   而旧副本（本机缓冲）里同一台账有 104 条标记 —— 低楼层标记在某次「删楼 / 部分载入」之后被**静默丢弃**了。
//
// 本批四件事（代码口径见 `host/floors.js` 头部注释与 `core/floor-trim.js#remapAfterTrim`）：
//   ① 丢弃一律留痕（删楼 / 迁移 / 漂移刷新三处补齐）；
//   ② 「楼层下标还在、只是取不到正文」**绝不丢弃标记**（旧口径会因此把台账整片刷掉）；
//   ③ **留痕回填**：留痕里的旧哈希在当前聊天里按内容找得到 → 恢复为「已处理」（删楼→恢复聊天的救回路径）；
//   ④ 「原文已移除」常态化复核 + 用户显式补救（`markFloorsProcessed`）+ 只读健康量表（`ledgerHealth`）。
//
// 运行：node tests/unit/ledger-heal.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { remapAfterTrim } from '../../core/floor-trim.js';
import {
    listUnprocessedFloors, scanPendingFloors, migrateProcessedFloorsV170, processedDriftGuard,
    healLedgerFromDropped, recheckOriginGone, markFloorsProcessed, ledgerHealth,
    processedVerTag, hashFloorText, rememberDroppedMarks,
} from '../../host/floors.js';

const R = makeReporter('ledger-heal v3.26.4 台账标记丢失修复');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 交替聊天：偶数 = AI 楼（非用户），奇数 = 用户楼 */
function altChat(n, opts) {
    const o = opts || {};
    const chat = [];
    for (let i = 0; i < n; i++) {
        const ai = i % 2 === 0;
        const blank = Array.isArray(o.blankFloors) && o.blankFloors.indexOf(i) >= 0;
        chat.push({
            is_user: !ai,
            role: ai ? 'assistant' : 'user',
            mes: blank ? '' : ('第' + i + '楼：角色甲在仓库清点货物并记下账目。'),
        });
    }
    return chat;
}

function boot(chat) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.timelyAnalysis = false;
    setScopeKey('角色甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    const st = emptyState();
    setKernelState(st);
    installGlobalHost(makeHost({ chat: chat }), doc);
    setLastMessageId(chat.length - 1);
    return st;
}

// ------------------------------------------------------------
// A. 删楼：被删段内的标记「丢弃前留痕」（core 层如实回报，宿主层留痕）
// ------------------------------------------------------------
A('A1 `remapAfterTrim` 如实回报被丢弃的标记（旧口径静默丢弃 → 聊天恢复后这批楼层永远变回「未分析」）；幸存段仍按 M 前移', (() => {
    const st = emptyState();
    st.processedFloors = [{ f: 1, h: 'h1' }, { f: 5, h: 'h5' }, { f: 9, h: 'h9' }];
    const r = remapAfterTrim(st, 6, 13);
    return r.ok === true
        && J(r.dropped) === J([{ f: 1, h: 'h1' }, { f: 5, h: 'h5' }])                    // 被删段内 → 必须回报
        && J(st.processedFloors) === J([{ f: 3, h: 'h9' }])                             // 幸存段：9 - 6 = 3
        && st.lastKnownFloor === 13;
})(), () => J({ dropped: remapAfterTrim(Object.assign(emptyState(), { processedFloors: [{ f: 1, h: 'h1' }, { f: 5, h: 'h5' }, { f: 9, h: 'h9' }] }), 6, 13).dropped }));

A('A2 `remapAfterTrim(0)` / 无台账 → 空回报、不改数据（幂等短路口径不变）', (() => {
    const st = emptyState();
    st.processedFloors = [{ f: 2, h: 'x' }];
    const r = remapAfterTrim(st, 0, 9);
    return J(r.dropped) === J([]) && J(st.processedFloors) === J([{ f: 2, h: 'x' }]);
})(), () => 'ok');

A('A3 宿主删楼路径把丢弃的标记写进「丢弃留痕」（`rememberDroppedMarks` 口径：有界、按楼层去重）', (() => {
    const st = boot(altChat(20));
    st.processedFloors = [{ f: 1, h: 'a' }, { f: 3, h: 'b' }, { f: 15, h: 'c' }];
    const r = remapAfterTrim(st, 10, 9);            // 删前 10 层
    rememberDroppedMarks(r.dropped);                 // ← `host/floor-trim.js` 删楼路径新增的那一行
    return J(st.processedFloors) === J([{ f: 5, h: 'c' }])
        && J((st.processedDropped || []).map((x) => ({ f: x.f, h: x.h }))) === J([{ f: 1, h: 'a' }, { f: 3, h: 'b' }]);
})(), () => J((state.processedDropped || []).map((x) => x.f)));

// ------------------------------------------------------------
// B. 「楼层下标还在、只是取不到正文」→ 绝不丢标记（旧口径会整片刷掉台账）
// ------------------------------------------------------------
A('B1 旧标记迁移：**只丢「越界（楼层确实不存在）」**；「楼层在但取不到正文」保留原标记并计入 `keptNoText`；丢弃留痕同步记录', (() => {
    const chat = altChat(10, { blankFloors: [2, 4] });        // 第 2/4 楼（AI 楼）正文为空 = 「取不到正文」
    const st = boot(chat);
    setLastMessageId(9);
    st.processedFloors = [{ f: 1, h: hashFloorText(1) }, { f: 2, h: 'old-2' }, { f: 4, h: 'old-4' }, { f: 99, h: 'beyond' }];
    st.processedVer = 'v1.170:old';                          // 触发迁移
    const r = migrateProcessedFloorsV170();
    const marks = st.processedFloors.map((x) => ({ f: x.f, h: x.h }));
    return r.dropped === 1 && r.keptNoText === 2
        // f=2/4 保留**原哈希**（没有被刷成空、也没有消失）；f=1 按当前正文刷新
        && J(marks) === J([{ f: 1, h: hashFloorText(1) }, { f: 2, h: 'old-2' }, { f: 4, h: 'old-4' }])
        && r.migrated === 1
        // f=99 越界（楼层确实不存在）→ 丢弃且**留痕**
        && J((st.processedDropped || []).map((x) => x.f)) === J([99]);
})(), () => J({ r: migrateProcessedFloorsV170(), marks: state.processedFloors, dropped: state.processedDropped }));

A('B2 哈希漂移防呆：整体刷新哈希时同样**不丢「读不到正文」的标记**（旧口径在这里静默丢弃 → 台账被刷掉且写上新签名）', (() => {
    const chat = altChat(30, { blankFloors: [2, 4] });
    const st = boot(chat);
    setLastMessageId(29);
    const wrong = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26].map((f) => ({ f: f, h: 'stale-' + f }));
    st.processedFloors = [{ f: 2, h: 'keep-2' }, { f: 4, h: 'keep-4' }].concat(wrong);
    st.processedVer = processedVerTag();
    st.lastKnownFloor = 26;
    const r = processedDriftGuard(false, true);               // force：跳过 20s 节流
    const byFloor = new Map(st.processedFloors.map((x) => [Number(x.f), String(x.h)]));
    return r.drifted === true && r.keptNoText === 2
        && byFloor.get(2) === 'keep-2' && byFloor.get(4) === 'keep-4'                  // 读不到正文 → 原样保留
        && byFloor.get(6) === hashFloorText(6) && byFloor.get(26) === hashFloorText(26) // 能读到的 → 按当前算法刷新
        && st.processedFloors.length === 13;
})(), () => J({ r: processedDriftGuard(false, true), marks: state.processedFloors.length }));

A('B3 口径反向确认：**越界**标记在漂移刷新里照常丢弃（楼层确实不存在时不该留在册），并进丢弃留痕', (() => {
    const chat = altChat(30, {});
    const st = boot(chat);
    setLastMessageId(29);
    st.processedFloors = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26].map((f) => ({ f: f, h: 'stale-' + f })).concat([{ f: 999, h: 'beyond' }]);
    st.processedVer = processedVerTag();
    st.lastKnownFloor = 26;
    const r = processedDriftGuard(false, true);
    return r.drifted === true && r.dropped === 1
        && !st.processedFloors.some((x) => Number(x.f) === 999)
        && J((st.processedDropped || []).map((x) => Number(x.f))) === J([999]);
})(), J({ dropped: (state.processedDropped || []).map((x) => Number(x.f)), marks: (state.processedFloors || []).length }));

// ------------------------------------------------------------
// C. 留痕回填：内容仍在 → 恢复为「已处理」（删楼 → 撤销/恢复聊天 的救回路径）
// ------------------------------------------------------------
A('C1 `healLedgerFromDropped`：留痕里的旧哈希按内容找得到 → 恢复为已处理标记（该楼层随即从「未分析」清单消失）；找不到的留痕原样保留', (() => {
    const chat = altChat(12);
    const st = boot(chat);
    setLastMessageId(11);
    st.processedFloors = [];
    st.processedDropped = [{ f: 1, h: hashFloorText(4) }, { f: 2, h: 'content-really-gone' }];
    const before = scanPendingFloors({ maintain: false }).floors;
    const r = healLedgerFromDropped();
    const after = scanPendingFloors({ maintain: false }).floors;
    return r.restored === 1 && r.kept === 1
        && before.indexOf(4) >= 0 && after.indexOf(4) < 0                       // 第 4 楼（AI 楼）：救回（不再列未分析）
        && J(st.processedFloors) === J([{ f: 4, h: hashFloorText(4) }])
        && J(st.processedDropped.map((x) => Number(x.f))) === J([2]);           // 内容确实没了 → 留痕保留（口径不变）
})(), J({ r: healLedgerFromDropped(), marks: state.processedFloors, dropped: state.processedDropped }));

A('C2 `healLedgerFromDropped` 幂等：第二次调用无变化（不重复写、不覆盖既有标记）', (() => {
    const chat = altChat(12);
    const st = boot(chat);
    st.processedFloors = [{ f: 4, h: 'already-marked-differently' }];
    st.processedDropped = [{ f: 1, h: hashFloorText(4) }];
    const r1 = healLedgerFromDropped();
    const snap = J(st.processedFloors);
    const r2 = healLedgerFromDropped();
    return r1.restored === 0 && r2.restored === 0 && J(st.processedFloors) === snap
        && st.processedFloors.length === 1 && String(st.processedFloors[0].h) === 'already-marked-differently';
})(), J({ marks: state.processedFloors, dropped: state.processedDropped }));

A('C3 端到端：**删楼 → 恢复聊天 → 扫描自愈** —— 被删的标记按内容归位回来，不再成片误报「未分析」', (() => {
    const chat = altChat(24);
    const st = boot(chat);
    setLastMessageId(23);
    // ① 台账齐全（AI 楼全在册）
    st.processedFloors = [];
    for (let f = 0; f <= 23; f++) { const h = hashFloorText(f); if (h && !(chat[f] && chat[f].is_user)) st.processedFloors.push({ f: f, h: h }); }
    st.processedVer = processedVerTag();
    const full = scanPendingFloors({ maintain: false }).floors;
    // ② 删掉前 12 层（宿主路径：台账前移 + 丢弃留痕）—— 台账里 0..11 的标记进留痕
    const removed = chat.splice(0, 12);
    const rm = remapAfterTrim(st, 12, chat.length - 1);
    rememberDroppedMarks(rm.dropped);
    setLastMessageId(chat.length - 1);
    // ③ 用户撤销删楼 / 恢复聊天（正文回来，台账标记没回来）
    chat.unshift.apply(chat, removed);
    setLastMessageId(chat.length - 1);
    const mid = scanPendingFloors({ maintain: false });
    // ④ 扫描（带台账维护）→ 留痕回填把被删段里的 AI 楼全部归位
    const healed = scanPendingFloors({});
    const restored = (st.processedDropped || []).length;
    return J(full) === J([])                                   // 起点：无未分析楼层
        && mid.floors.length > 0                               // 恢复聊天后：误报成片（0..11 里的 AI 楼）
        && J(healed.floors) === J([])                          // 自愈后：清单重新为空
        && restored === 0                                      // 留痕全部回填完毕
        && st.processedFloors.length === 12;                   // 12 个 AI 楼（0,2,…,22）全部在册
})(), () => J({ marks: (state.processedFloors || []).length, dropped: (state.processedDropped || []).length, pending: listUnprocessedFloors({ maintain: false }) }));

// ------------------------------------------------------------
// D. 「原文已移除」常态化复核
// ------------------------------------------------------------
A('D1 `recheckOriginGone`：位置指纹在当前聊天里找得到 → 解除「原文已移除」并归位；找不到的（或无指纹的）保持原样（保守方向）', (() => {
    const chat = altChat(16);
    const st = boot(chat);
    setLastMessageId(15);
    st.atoms = [
        { id: 'a1', kind: 'atoms', title: 't1', text: '甲在仓库清点货物。', floorStart: 5, floorEnd: 5, originGone: true, originGoneAt: 1, floorNowHash: hashFloorText(5) },
        { id: 'a2', kind: 'atoms', title: 't2', text: '乙在码头。', floorStart: 7, floorEnd: 9, originGone: true, originGoneAt: 1, floorNowHash: 'not-in-chat' },
        { id: 'a3', kind: 'atoms', title: 't3', text: '丙在船上。', floorStart: 11, floorEnd: 11, originGone: true, originGoneAt: 1 },
    ];
    const r = recheckOriginGone();
    const a1 = st.atoms[0], a2 = st.atoms[1], a3 = st.atoms[2];
    return r.restored === 1 && r.checked === 2 && r.stillGone === 1
        && a1.originGone !== true && a1.floorNowStart === 5 && a1.floorNowEnd === 5
        && a2.originGone === true                                   // 内容确实不在 → 保持
        && a3.originGone === true;                                  // 无指纹 → 无从复核，保持
})(), () => J({ r: recheckOriginGone(), atoms: state.atoms }));

// ------------------------------------------------------------
// E. 用户显式补救：登记未分析楼层为「已分析」
// ------------------------------------------------------------
A('E1 `markFloorsProcessed`：把未分析清单一次性登记为已处理（清单清空）；非 AI 楼 / 隐藏楼 / 无正文楼如实跳过，不写台账', (() => {
    const chat = altChat(12, { blankFloors: [4] });
    const st = boot(chat);
    setLastMessageId(11);
    st.processedFloors = [];
    const pend = listUnprocessedFloors({ maintain: false });
    const r = markFloorsProcessed(pend.concat([1, 3, 999]));         // 1/3 = 用户楼；999 = 越界
    return r.ok === true && r.marked === pend.length && r.skipped === 3
        && J(listUnprocessedFloors({ maintain: false })) === J([])
        && st.processedFloors.every((x) => Number(x.f) >= 0 && String(x.h || '') !== '')
        && !st.processedFloors.some((x) => Number(x.f) === 1 || Number(x.f) === 3);
})(), () => J({ r: markFloorsProcessed(listUnprocessedFloors({ maintain: false })), marks: state.processedFloors }));

A('E2 `markFloorsProcessed` 是「只写记账」：不动任何记忆条目（条目前后逐字一致），并清掉这些楼的丢弃留痕', (() => {
    const chat = altChat(10);
    const st = boot(chat);
    setLastMessageId(9);
    st.processedFloors = [];
    st.atoms = [{ id: 'a1', kind: 'atoms', title: 't', text: '甲在仓库。', floorStart: 2, floorEnd: 2 }];
    st.processedDropped = [{ f: 2, h: 'old' }, { f: 8, h: 'old8' }];
    const atomsBefore = J(st.atoms);
    markFloorsProcessed([2]);
    return J(st.atoms) === atomsBefore
        && J((st.processedDropped || []).map((x) => Number(x.f))) === J([8])       // 已登记的在册 → 留痕失效
        && st.processedFloors.some((x) => Number(x.f) === 2);
})(), () => J({ atoms: state.atoms, dropped: state.processedDropped }));

A('E3 `markFloorsProcessed` 的守卫：聊天未就绪 / 清单为空 → 明确拒绝且**不写台账**（不把「未就绪」写成「已处理」）', (() => {
    const st = boot(altChat(6));
    setLastMessageId(5);
    st.processedFloors = [];
    const empty = markFloorsProcessed([]);
    const notReady = (() => {
        installGlobalHost(makeHost({ chat: [] }), doc);          // 空聊天 = 未就绪
        return markFloorsProcessed([2]);
    })();
    return empty.ok === false && empty.reason === 'empty'
        && notReady.ok === false && (notReady.reason === 'chat-not-ready' || notReady.reason === 'nothing-markable')
        && st.processedFloors.length === 0;
})(), () => 'ok');

// ------------------------------------------------------------
// F. 只读健康量表（调试桥 `ftt.ledger.health` 的数据源）
// ------------------------------------------------------------
A('F1 `ledgerHealth` 如实计数：标记数 / **读不到正文的标记数**（部分载入或楼层消失的信号）/ 留痕 / 覆盖 / 未分析 / 上次回填', (() => {
    const chat = altChat(12, { blankFloors: [4] });
    const st = boot(chat);
    setLastMessageId(11);
    st.processedFloors = [{ f: 0, h: hashFloorText(0) }, { f: 4, h: 'unreadable-floor' }, { f: 999, h: 'beyond' }];
    st.processedDropped = [{ f: 6, h: 'x' }];
    st.processedVer = processedVerTag();
    const h = ledgerHealth();
    return h.ready === true && h.lastId === 11
        && h.marks === 3 && h.marksReadable === 1 && h.marksUnreadable === 1 && h.marksOutOfRange === 1
        && h.dropped === 1 && Number.isFinite(h.pending) && Array.isArray(h.pendingFloors)
        && Number(h.coverFloors) >= 0 && h.verMatches === true;
})(), J(ledgerHealth()));

A('F2 `ledgerHealth` 在空状态下安全（不抛、不写）', (() => {
    setKernelState(null);
    const h = ledgerHealth();
    setKernelState(emptyState());
    return h && h.ready === false;
})(), () => 'ok');

R.done();
