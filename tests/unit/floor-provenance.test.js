// ============================================================
// 单元测试 · v3.7.0「楼层溯源不可变 + 原文已移除 + 按新位置记录」
// 用户要求（原文）：「原子数据来源记录了楼层，**原始楼层不应该变动**。当楼层发生突变后，如找不到对应楼层哈希值，
//   则**标记原文已移除**处理。同时新的楼层必须**结合新的位置来记录**，修复无法分析、跳过的问题。」
//
// 口径（本批裁决）：
//   · `floorStart` / `floorEnd` = **原始来源楼层（溯源）**：条目在哪儿产生的，**创建后永不改写**；
//   · `floorNowStart` / `floorNowEnd` = **当前位置**：突变后按**内容哈希**匹配出的新位置（缺省 = 与来源相同）；
//   · `originGone` / `originGoneAt` = **原文已移除**：按哈希找不到原文时打标；内容与来源楼层**都保留**，
//     但**不再覆盖任何楼层**（否则新楼会被旧数据永久压住 → 「无法分析、跳过」）；
//   · 判据基础：突变**前**的台账（`f → h`）才是权威 —— 它记录「原始楼层里的内容哈希」，据此在**当前聊天**里找同一段内容。
//
// 覆盖：
//   A 组：哈希命中 → 只写「当前位置」，**来源楼层一字不动**；
//   B 组：哈希失配/位置消失 → 打「原文已移除」，来源楼层与内容都保留（不置 0/0）；
//   C 组：覆盖判定改用**当前位置**、`originGone` 不再覆盖 —— 新楼因此**可被分析**（不再被误跳过）；
//   D 组：溯源字段在归一化 / AI 更新落库（`mergeDelta`）后**不丢**；
//   E 组：删楼重映射（`remapAfterTrim`）同样只动当前位置 / 只打标记；
//   F 组：历史 `floorStale` 兼容（视为「当前位置未知」，不覆盖楼层）。
// 运行：node tests/unit/floor-provenance.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { handleFloorShrink, hashFloorText, scanPendingFloors } from '../../host/floors.js';
import { normalizeAtom } from '../../core/model/atom.js';
import { mergeDelta } from '../../core/ingest.js';
import { remapAfterTrim } from '../../core/floor-trim.js';
import { currentFloorRange, meaningfulFloorRange, floorCoverage, originFloorRange, floorPositionLabel } from '../../core/floor-cover.js';

const R = makeReporter('floor-provenance v3.7.0 楼层溯源不可变 + 原文已移除');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 造聊天：`texts[i]` 指定第 i 楼正文（缺省用可区分的通用正文） */
const chatOf = (n, texts) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push({ is_user: false, role: 'assistant', mes: (texts && texts[i]) || ('第' + i + '楼正文：角色甲在仓库清点编号' + i + '的货物。') });
    return a;
};
function boot(floors, st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false; cfg.clockAutoPatrol = false;
    setScopeKey('char:floorprov');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setChatHooks({ latestAiFloorText: () => '', dbgLog: () => undefined });
    installGlobalHost(makeHost({ chat: floors }), doc);
    setLastMessageId(floors.length - 1);
    setKernelState(Object.assign(emptyState(), st || {}));
    return state;
}
const atom = (id, fs, fe, extra) => Object.assign({ id: id, title: id, text: '剧情正文' + id + '：角色甲在仓库清点货物，数量与来源都需要记录清楚。', date: '1919-11-01', floorStart: fs, floorEnd: fe, tags: [] }, extra || {});
const SHIFT_TEXT = '这是被整体前移的那段原文：角色乙在码头交接铜箱，编号 A9；内容足够长以便形成稳定哈希。';

// ---------- A 组：哈希命中 → 只写「当前位置」 ----------
A('A1 楼层突变后按**内容哈希**找到原文 → 只写 `floorNowStart/End`（当前位置），**来源楼层 floorStart/floorEnd 一字不动**', (() => {
    boot(chatOf(10, { 4: SHIFT_TEXT }), {
        lastKnownFloor: 599,
        atoms: [atom('a_shift', 30, 32), atom('a_old', 50, 52)],
    });
    // 突变前的台账：原始第 30 楼的内容 = 当前第 4 楼的正文；原始第 50 楼的内容已不在聊天里
    state.processedFloors = [{ f: 30, h: hashFloorText(4) }, { f: 50, h: 'deadbeefdeadbeef' }];
    const r = handleFloorShrink();
    const a1 = state.atoms[0];
    return r.ok === true && r.originGone === 1
        // ① 来源（溯源）不动
        && a1.floorStart === 30 && a1.floorEnd === 32 && J(originFloorRange(a1)) === J([30, 32])
        // ② 当前位置 = 找到的楼层 + 原区间跨度
        && a1.floorNowStart === 4 && a1.floorNowEnd === 6
        // ③ 原文仍在 → 不标记「原文已移除」
        && a1.originGone === undefined && a1.floorStale === undefined
        // ④ 位置由 currentFloorRange 给出（覆盖判定口径）
        && J(currentFloorRange(a1)) === J([4, 6]) && J(meaningfulFloorRange(a1)) === J([4, 6]);
})(), () => ({ a1: state.atoms[0], r: undefined }));

// ---------- B 组：哈希失配 → 原文已移除 ----------
A('B1 按哈希**找不到**原文 → 打「原文已移除」`originGone`；来源楼层与内容**都保留**（绝不置 0/0、绝不删条目）', (() => {
    // 承接 A1 的局面（同一轮 `handleFloorShrink` 的结果）
    const a2 = state.atoms[1];
    return a2.floorStart === 50 && a2.floorEnd === 52 && a2.originGone === true && !!a2.originGoneAt
        && a2.floorNowStart === undefined && a2.floorNowEnd === undefined
        && a2.floorStale === undefined
        && typeof a2.text === 'string' && a2.text.length > 10
        && state.atoms.length === 2;   // 一条不删
})(), () => ({ a2: state.atoms[1] }));

A('B2 原始区间整体超出当前末楼（位置根本不存在）→ 同样判「原文已移除」', (() => {
    boot(chatOf(10), { lastKnownFloor: 599, atoms: [atom('b_far', 500, 505)] });
    const r = handleFloorShrink();
    const a = state.atoms[0];
    return r.originGone === 1 && a.floorStart === 500 && a.floorEnd === 505 && a.originGone === true && currentFloorRange(a) === null;
})(), '见断言');

A('B3 原文重新出现（哈希再次命中）→ **解除**「原文已移除」并写回当前位置（可恢复、不粘死）', (() => {
    boot(chatOf(10, { 7: SHIFT_TEXT }), { lastKnownFloor: 599, atoms: [atom('b_back', 30, 32, { originGone: true, originGoneAt: 1 })] });
    state.processedFloors = [{ f: 30, h: hashFloorText(7) }];
    handleFloorShrink();
    const a = state.atoms[0];
    return a.floorStart === 30 && a.floorEnd === 32 && a.originGone === undefined && a.floorNowStart === 7 && a.floorNowEnd === 9;
})(), '见断言');

// ---------- C 组：覆盖判定改用当前位置 → 「无法分析、跳过」被修好 ----------
A('C1 覆盖判定用**当前位置**：`floorNow=2..5` 的条目覆盖第 3 楼、**不再覆盖**原来源 8..11 楼', (() => {
    boot(chatOf(12), { lastKnownFloor: 11, atoms: [atom('c_now', 8, 11, { floorNowStart: 2, floorNowEnd: 5 })] });
    const cov = floorCoverage(state);
    return cov.has(3) === true && cov.has(5) === true && cov.has(6) === false
        && cov.has(8) === false && cov.has(9) === false && cov.has(11) === false
        && currentFloorRange(state.atoms[0]) && J(currentFloorRange(state.atoms[0])) === J([2, 5]);
})(), '见断言');

A('C2 「原文已移除」的条目**不覆盖任何楼层** → 同一楼号的新内容**照常进入待分析清单**（不再被旧数据压住而不分析）', (() => {
    // 对照：同一区间、却没有 originGone 的条目 → 第 9 楼被判「已有数据」而跳过
    boot(chatOf(12), { lastKnownFloor: 11, atoms: [atom('c_covered', 8, 11)], processedFloors: [] });
    const s1 = scanPendingFloors({ maintain: false, startFloor: 8, endFloor: 11 });
    const skippedCovered = s1.skipped.covered;
    // 本例：原文已移除 → 不再覆盖 → 第 8..11 楼全部列为待分析
    boot(chatOf(12), { lastKnownFloor: 11, atoms: [atom('c_gone', 8, 11, { originGone: true, originGoneAt: 1 })], processedFloors: [] });
    const s2 = scanPendingFloors({ maintain: false, startFloor: 8, endFloor: 11 });
    return skippedCovered === 4 && s2.skipped.covered === 0
        && s2.floors.length === 4 && s2.floors[0] === 8 && s2.floors[3] === 11
        && floorCoverage(state).has(9) === false && meaningfulFloorRange(state.atoms[0]) === null;
})(), () => ({ floors: scanPendingFloors({ maintain: false, startFloor: 8, endFloor: 11 }).floors }));

// ---------- D 组：溯源字段在归一化 / 落库后不丢 ----------
A('D1 `normalizeAtom` 原样保留 `floorNow*` / `originGone`（不参与内容哈希，重归一化不得冲掉）', (() => {
    const n = normalizeAtom(atom('d1', 3, 4, { floorNowStart: 1, floorNowEnd: 2, originGone: true, originGoneAt: 12345 }), {});
    return n.floorStart === 3 && n.floorEnd === 4 && n.floorNowStart === 1 && n.floorNowEnd === 2
        && n.originGone === true && n.originGoneAt === 12345;
})(), '见断言');

A('D2 AI 更新既有情节（`mergeDelta` 更新路径）→ 从旧条目**继承**溯源/当前位置/「原文已移除」，只替换正文', (() => {
    boot(chatOf(6), { lastKnownFloor: 5, atoms: [atom('d2', 3, 4, { floorNowStart: 1, floorNowEnd: 2, originGone: true, originGoneAt: 999 })] });
    mergeDelta({ atoms: { update: [{ id: 'd2', title: 'd2', text: '更新后的正文：角色甲改在另一处仓库清点货物，数量仍未清点完毕。', date: '1919-11-02', floorStart: 3, floorEnd: 4, tags: [] }] } }, { startFloor: 3, endFloor: 4 });
    const a = state.atoms[0];
    return state.atoms.length === 1 && /更新后的正文/.test(a.text)
        && a.floorStart === 3 && a.floorEnd === 4
        && a.floorNowStart === 1 && a.floorNowEnd === 2 && a.originGone === true && a.originGoneAt === 999;
})(), () => ({ atom: state.atoms[0] }));

// ---------- E 组：删楼重映射同样只动当前位置 ----------
A('E1 `remapAfterTrim`：来源楼层不动；幸存段写 `floorNow*`、被删段打 `originGone`（不置 0/0、不删条目）', (() => {
    const st = Object.assign(emptyState(), {
        atoms: [atom('e_survive', 12, 14), atom('e_deleted', 2, 3)],
    });
    const r = remapAfterTrim(st, 10, 40);
    const s = st.atoms[0], d = st.atoms[1];
    return r.ok === true && st.atoms.length === 2
        && s.floorStart === 12 && s.floorEnd === 14 && s.floorNowStart === 2 && s.floorNowEnd === 4 && s.originGone === undefined
        && d.floorStart === 2 && d.floorEnd === 3 && d.originGone === true && d.floorNowStart === undefined
        && d.floorStale === undefined
        && J(currentFloorRange(s)) === J([2, 4]) && currentFloorRange(d) === null;
})(), '见断言');

// ---------- F 组：历史字段兼容 ----------
A('F1 历史 `floorStale: true`（当前位置未知）→ 不覆盖任何楼层；来源楼层保持原值可查', (() => {
    const it = atom('f1', 20, 25, { floorStale: true });
    boot(chatOf(30), { lastKnownFloor: 29, atoms: [it] });
    return currentFloorRange(it) === null && meaningfulFloorRange(it) === null
        && floorCoverage(state).has(22) === false
        && J(originFloorRange(it)) === J([20, 25]);
})(), '见断言');

A('F2 `0/0`（区间未知）依旧不构成覆盖（V1 同口径：第 0 楼不被误吞）', (() => {
    const it = atom('f2', 0, 0);
    boot(chatOf(3), { lastKnownFloor: 2, atoms: [it] });
    return currentFloorRange(it) === null && floorCoverage(state).has(0) === false;
})(), '见断言');

// ---------- H 组：当前位置也**可复核**（`floorNowHash`） ----------
A('H1 当前位置的内容**也被移除** → 复核失败 → 转「原文已移除」（不靠猜：位置一度精确，但内容确实没了）', (() => {
    boot(chatOf(14), {
        lastKnownFloor: 13,
        atoms: [atom('h_removed', 20, 21, { floorNowStart: 8, floorNowEnd: 9, floorNowHash: 'content-gone-0001' })],
        processedFloors: [],
    });
    const r = handleFloorShrink({ force: true });
    const a1 = state.atoms[0];
    return r.originGone === 1 && a1.floorStart === 20 && a1.floorEnd === 21
        && a1.originGone === true && currentFloorRange(a1) === null
        && floorCoverage(state).has(8) === false;      // 该楼新内容不再被跳过
})(), () => ({ a1: state.atoms[0] }));

A('H2 当前位置的内容**搬了家**（`floorNowHash` 在新楼层命中）→ 当前位置整体平移，来源楼层仍不动', (() => {
    boot(chatOf(14, { 3: '这段内容后来搬到了第 3 楼：角色丙在驿站清点行囊，编号与去向都记清楚。' }), {
        lastKnownFloor: 13,
        atoms: [atom('h_moved', 20, 21, { floorNowStart: 8, floorNowEnd: 9 })],
    });
    state.atoms[0].floorNowHash = hashFloorText(3);
    handleFloorShrink({ force: true });
    const a1 = state.atoms[0];
    return a1.floorStart === 20 && a1.floorEnd === 21
        && a1.floorNowStart === 3 && a1.floorNowEnd === 4
        && a1.originGone === undefined
        && J(currentFloorRange(a1)) === J([3, 4]);
})(), () => ({ a1: state.atoms[0] }));

A('H3 有精确当前位置、该楼**在册**（删楼时量已知）→ 补记 `floorNowHash` 供下次复核，且**不打**「原文已移除」', (() => {
    boot(chatOf(14), { lastKnownFloor: 13, atoms: [atom('h_stamp', 20, 21, { floorNowStart: 8, floorNowEnd: 9 })] });
    const h8 = hashFloorText(8);
    state.processedFloors = [{ f: 8, h: h8 }];         // 第 8 楼在册（内容 = 已分析过的内容）
    handleFloorShrink({ force: true });
    const a1 = state.atoms[0];
    return a1.floorStart === 20 && a1.floorEnd === 21 && a1.floorNowStart === 8 && a1.floorNowEnd === 9
        && a1.floorNowHash === h8 && a1.originGone === undefined;
})(), () => ({ a1: state.atoms[0] }));

// ---------- G 组：界面标签（把「来源」与「当前位置」讲清楚） ----------
A('G1 `floorPositionLabel`：普通条目与 V1 行正文**逐字一致**（`3-5楼`）；有当前位置 → 带「原 … 楼」；原文已移除 → 明写「原文已移除」', (() => {
    const plain = floorPositionLabel(atom('g_plain', 3, 5));
    const moved = floorPositionLabel(atom('g_moved', 30, 32, { floorNowStart: 4, floorNowEnd: 6 }));
    const gone = floorPositionLabel(atom('g_gone', 12, 14, { originGone: true, originGoneAt: 1 }));
    const unknown = floorPositionLabel(atom('g_unknown', 0, 0));
    return plain === '3-5楼' && moved === '4-6楼（原 30-32楼）' && gone === '原文已移除（原 12-14楼）' && unknown === '';
})(), () => ({ plain: floorPositionLabel(atom('g_plain', 3, 5)), moved: floorPositionLabel(atom('g_moved', 30, 32, { floorNowStart: 4, floorNowEnd: 6 })), gone: floorPositionLabel(atom('g_gone', 12, 14, { originGone: true })) }));

R.done();
