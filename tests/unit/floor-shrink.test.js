// 单元测试 · v2.93.0「楼层骤减处理」（`docs/D12` v0.2 裁决：删楼=常态、只改编号不删数据、低噪声）
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { handleFloorShrink, setFloorShrinkHook, hashFloorText } from '../../host/floors.js';

const R = makeReporter('floor-shrink v2.93.0 楼层骤减（删楼常态）处理');
const A = (n, c, e) => R.assert(n, !!c, e);
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const chatOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push({ is_user: i % 2 === 0, role: i % 2 === 0 ? 'user' : 'assistant', mes: '第' + i + '楼正文：角色甲在仓库清点货物。' }); return a; };
function boot(floors, st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:floorshrink');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: floors }), doc);
    setLastMessageId(floors.length - 1);
    setKernelState(Object.assign(emptyState(), st || {}));
}
const atom = (id, fs, fe) => ({ id: id, title: id, text: '剧情' + id, date: '1919-11-01', floorStart: fs, floorEnd: fe, tags: [] });

// A 组：判据与幂等
A('A1 未收缩 / 聊天未就绪 → 不动作（幂等，低噪声）', (() => {
    boot(chatOf(20), { lastKnownFloor: 19 });
    const ok1 = handleFloorShrink().skipped === 'no-shrink';
    boot([], { lastKnownFloor: 599 });
    const ok2 = handleFloorShrink().skipped === 'chat-not-ready';
    return ok1 && ok2;
})(), '见断言');

A('A2 600→10 骤减：识别为收缩、`lastKnownFloor` **收紧**为当前末楼（Q9）', (() => {
    boot(chatOf(10), { lastKnownFloor: 599 });
    const r = handleFloorShrink();
    return r.ok === true && r.removedFloors === 590 && r.lastId === 9 && Number(state.lastKnownFloor) === 9
        && !!state.floorShrinkAt;
})(), () => ({ lastKnownFloor: state.lastKnownFloor }));

// B 组：只改编号、不删数据（Q1）
A('B1 陈旧楼层区间 → 置未知区间 `0/0` + `floorStale`；**条目一条不少**（数据全保留，D12 §8-B）', (() => {
    boot(chatOf(10), {
        lastKnownFloor: 599,
        atoms: [atom('a_old', 100, 105), atom('a_new', 3, 5)],
        memories: [{ id: 'm_old', title: '旧记忆', content: 'x', floorStart: 590, floorEnd: 599 }],
        plotSegments: [{ id: 'g1', header: 'h', start: '1919-01-01', end: '1919-02-01', floorStart: 100, floorEnd: 599, lines: [] }],
    });
    const r = handleFloorShrink();
    const a1 = state.atoms[0], a2 = state.atoms[1];
    return r.staleEntries >= 1 && state.atoms.length === 2 && state.memories.length === 1
        && a1.floorStart === 0 && a1.floorEnd === 0 && a1.floorStale === true
        && a2.floorStart === 3 && a2.floorEnd === 5 && a2.floorStale === undefined
        && state.memories[0].floorStale === true;
})(), () => ({ stale: state.atoms.map((x) => [x.id, x.floorStart, x.floorEnd, !!x.floorStale]) }));

// C 组：台账哈希归位（Q3 绕过 mass-mismatch）
A('C1 台账：幸存 10 楼的标记按**内容哈希**归位、被删楼的标记丢弃；版本签名刷新（Q3 强制归位）', (() => {
    const floors = chatOf(10);
    const marks = [];
    for (let f = 0; f <= 9; f++) marks.push({ f: f + 590, h: hashFloorText(f) });        // 旧编号（删楼前）
    for (let f = 0; f <= 5; f++) marks.push({ f: f, h: 'deadbeef' + f });                 // 已消失的旧楼
    boot(floors, { lastKnownFloor: 599, processedFloors: marks, processedVer: 'v1.100:old' });
    const r = handleFloorShrink();
    const fs = (state.processedFloors || []).map((x) => x.f).sort((a, b) => a - b);
    return r.marks >= 5 && fs.length >= 5 && fs.every((f) => f >= 0 && f <= 9)
        && (state.processedFloors || []).every((x) => String(x.h).indexOf('deadbeef') < 0);
})(), () => state.processedFloors);

// D 组：低噪声记账（D12 §8-A）
A('D1 收缩回调：一次性给出「删了多少层 / 重映射多少条 / 台账多少条」，供**合并计数**登记（不刷屏）', (() => {
    boot(chatOf(10), { lastKnownFloor: 599, atoms: [atom('a1', 100, 105)] });
    const seen = [];
    setFloorShrinkHook((info) => seen.push(info));
    handleFloorShrink();
    setFloorShrinkHook(null);
    return seen.length === 1 && seen[0].removedFloors === 590 && seen[0].staleEntries === 1 && seen[0].lastId === 9;
})(), '见断言');

R.done();
