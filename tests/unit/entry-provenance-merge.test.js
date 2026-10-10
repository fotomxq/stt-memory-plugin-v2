// ============================================================
// 单元测试 · v3.22.1「合并/去重把溯源与降级标记洗掉 → 旧聊天情节复活压住时钟」根因修复
//
// 用户报告（原话）：「新版本 现在又出现了时钟异常，请核对原因并修复该问题。」
//
// 真机取证（调试桥 `ftt.plotScope` / `ftt.pendingScan` / 落盘状态 blob / 插件自己的追踪时间线）：
//   · 13:19（页面 v3.22.0）当前聊天归属 `state.chatKey` 仍为**空串**、`lastChatFloor=71`，
//     但时钟被读成 `0198-05-16 下午 · 罗马式大浴池`（**别条聊天的旧故事线**）；
//   · 同刻 `originGone` 只剩 104/115 条 —— 10:51 复核时 **0198 年线那三条情节都是 `originGone:true`**，
//     13:19 却变回「未标记」，而 `floorShrinkAt` **从未设置**（说明不是拆楼归位清掉的）；
//   · 时间线恰落在 13:18:54 那次载入：「**以服务端文件为基底 + local / idb 并集并入**」，
//     基底文件 `fileAt = 2026-10-04 20:33`（**滞后一天**，早于 10-05 10:27 那次打标）；
//   · 13:22 复核：第 73 楼被分析、新情节打上 `chatKey` 后时钟自愈为 `628-07-21 中午`。
//
// 成因（确定性、可复现）：`originGone`/`hidden`/`summarizedBy` 这类**溯源与降级标记不参与内容哈希**
//   （`docs/D8` 槽位口径），而合并/去重只按 `updatedAt` **整对象取一侧**：
//     · `core/cross-sync.js#mergeDataObjects` 的「**同内容哈希**」分支直接 `push(L[id])`
//       —— 基底（滞后副本）那一份**没有标记**，于是标记凭空消失（真机走的正是这条：内容一字未改）；
//     · 冲突分支（按 `updatedAt` 取胜）同理；
//     · `core/migrate.js#contentDedupeArray`（同内容异 id 去重）只并 NSFW 等级与楼层/uses，同样丢标记。
//   标记一丢 ⇒ `core/chat-scope.js#plotDemoted` 不再降级 ⇒ 那条**别条聊天的旧情节**位置又比本聊天
//   真正的最新情节高 ⇒ 成为「最新情节」⇒ 时钟被压回旧故事线（本期 `chatKey` 为空使分层失效，加倍放大）。
//
// 修复口径（保守、只增不减，与 v3.8.0 的 NSFW 等级「只升不降」同款；见 `core/floor-cover.js#mergeEntryProvenance`）：
//   · **只升不降**：`originGone` / `hidden` / `summarizedBy` / `mergedSummary` —— 任一侧成立即成立；
//     **清除只能由本地已核实路径改写**（`handleFloorShrink.mapEntry` 按内容哈希确认原文仍在 → `clearGone`），合并**从不**清除；
//   · **补空**：`originGoneAt` / `floorNowStart` / `floorNowEnd` / `floorNowHash` / `chatKey` —— 缺失才补，**绝不覆盖**已有值。
//
// 覆盖：A 原语口径；B 跨端合并（同内容 / 冲突两条分支）；C 同内容异 id 去重；D 端到端时钟回归（含反事实）；
//       E 宿主注入状态时立刻记「当前聊天归属」（刷新首屏那条路径）。
// 运行：node tests/unit/entry-provenance-merge.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { mergeEntryProvenance } from '../../core/floor-cover.js';
import { contentDedupeArray } from '../../core/migrate.js';
import { mergeDataObjects } from '../../core/cross-sync.js';
import { trustedPlotList } from '../../core/recall.js';
import { plotDemoted } from '../../core/chat-scope.js';
import { resolveStoryClock } from '../../core/clock-extract.js';
import { atomContentHash, atomIdentityHash } from '../../core/model/hash.js';
import { attachKernelState } from '../../host/chat.js';

const R = makeReporter('entry-provenance-merge v3.22.1 合并/去重保住溯源与降级标记');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const chatOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push({ is_user: i % 2 === 0, mes: '第' + i + '楼正文：角色甲在仓库清点货物。' }); return a; };

/** 情节条目（内容足够长以形成稳定哈希；`extra` 覆盖溯源/降级标记） */
const ATOM = (id, floor, date, time, locs, extra) => Object.assign({
    id: id, text: '情节正文：' + id + ' 的场景描写足够长，供时钟取值与哈希计算。', title: id,
    date: date || '', time: time || '', locations: locs || [],
    floorStart: floor || 0, floorEnd: floor || 0, tags: [], uses: 1,
}, extra || {});

/** 数据层（`mergeDataObjects` 入参）：真机里基底 = 滞后的服务端文件，并入侧 = local/idb */
const D = (o) => Object.assign({ scope: 'char:entry-prov', updatedAt: 0 }, o || {});
const pickClock = (r) => ({ date: r.date, time: r.time, location: r.location });

/** 装场景（与 chat-scope 测试同款）：`chatKey` 为空 = 刷新首屏那段「归属还没记上」的窗口 */
function boot(atoms, opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:entry-prov');
    setLastMessageId(o.liveFloor === undefined ? 23 : o.liveFloor);
    const st = emptyState();
    setKernelState(st);
    st.atoms = atoms || [];
    if (o.chatKey !== undefined) st.chatKey = o.chatKey;
    if (o.tail !== undefined) { st.lastChatFloor = o.tail; st.lastKnownFloor = o.tail; }
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: chatOf(o.chatFloors === undefined ? 24 : o.chatFloors) }), doc);
    return st;
}

// ---------- A 组：原语口径 ----------
A('A1 **只升不降**：`originGone` / `hidden` / `summarizedBy` / `mergedSummary` 任一侧成立即成立，并回报被抬升的字段名', (() => {
    const t = { id: 'x' };
    const changed = mergeEntryProvenance(t, { originGone: true, hidden: true, summarizedBy: 'sum-7', mergedSummary: { n: 3 } });
    const again = mergeEntryProvenance(t, { originGone: true, hidden: true });
    return t.originGone === true && t.hidden === true && t.summarizedBy === 'sum-7' && t.mergedSummary && t.mergedSummary.n === 3
        && J(changed.sort()) === J(['hidden', 'mergedSummary', 'originGone', 'summarizedBy'])
        && again.length === 0;                       // 已成立 → 不重复抬升（幂等）
})(), () => J(mergeEntryProvenance({ id: 'x' }, { originGone: true, hidden: true })));

A('A2 **补空不覆盖**：`originGoneAt` / `floorNow*` / `floorNowHash` / `chatKey` 只在目标缺失时补齐；已核实值一字不动', (() => {
    const t = {
        id: 'x', originGone: true, originGoneAt: 1791177002000,
        floorNowStart: 25, floorNowEnd: 25, floorNowHash: 'verified-in-this-chat', chatKey: 'this-chat',
    };
    const changed = mergeEntryProvenance(t, {
        originGoneAt: 1, floorNowStart: 3, floorNowEnd: 4, floorNowHash: 'stale-hash', chatKey: 'other-chat',
    });
    // v3.40.5 契约变更（真机取证 171 条 origin-gone-with-floornow）：**合并结果处于「原文已移除」时，
    //   `floorNow*` 既不补也不留**（该条目运行时本就不覆盖任何楼层；留着会被 clearGone ④ 洗白成「位置有效」）。
    //   其余字段口径不变：originGoneAt / floorNowHash / chatKey 仍是「补空不覆盖」。
    return J(changed) === J(['floorNowCleared'])
        && t.floorNowStart === undefined && t.floorNowEnd === undefined
        && t.originGoneAt === 1791177002000
        && t.floorNowHash === 'verified-in-this-chat' && t.chatKey === 'this-chat';
})(), () => J(mergeEntryProvenance({ id: 'x' }, {})));

A('A3 **非法值视为缺失**：`NaN` / 负数 / 非整数 / 空串 → 从另一侧补齐（不把脏值当「已有值」挡住真值）', (() => {
    const t = { id: 'x', originGoneAt: NaN, floorNowStart: -1, floorNowEnd: 2.5, floorNowHash: '', chatKey: '' };
    const changed = mergeEntryProvenance(t, {
        originGone: true, originGoneAt: 1791177002000,
        floorNowStart: 25, floorNowEnd: 25, floorNowHash: 'h-25', chatKey: 'chat-A',
    });
    // v3.40.5：目标被抬升为「原文已移除」→ 位置整对清掉（脏值不再补回），指纹 / 时刻 / 归属照旧补空
    return t.originGone === true && t.originGoneAt === 1791177002000
        && t.floorNowStart === undefined && t.floorNowEnd === undefined
        && t.floorNowHash === 'h-25' && t.chatKey === 'chat-A'
        && J(changed.slice().sort()) === J(['chatKey', 'floorNowCleared', 'floorNowHash', 'originGone', 'originGoneAt']);
})(), () => J(mergeEntryProvenance({ id: 'x', originGoneAt: NaN }, { originGoneAt: 5 })));

A('A4 非对象 / 缺参 → 静默返回空变更（不抛异常）', (() => {
    return J(mergeEntryProvenance(null, {})) === '[]' && J(mergeEntryProvenance({}, null)) === '[]' && J(mergeEntryProvenance('x', 'y')) === '[]';
})(), '');

// ---------- B 组：跨端合并 `mergeDataObjects` ----------
// 真机路径：内容一字未改（同内容哈希）→ 基底（滞后副本）胜出，标记原本随整对象替换消失。
const b1 = () => {
    const stale = ATOM('atom_c63x0o', 25, '0198-05-16', '下午', ['大浴池']);
    const fresh = Object.assign({}, stale, { originGone: true, originGoneAt: 1791177002000, floorNowStart: 25, floorNowEnd: 25 });
    const r = mergeDataObjects(D({ atoms: [stale] }), D({ updatedAt: 1791177526145, atoms: [fresh] }));
    return { stale, fresh, arr: r.data.atoms || [], first: (r.data.atoms || [])[0] || {}, stat: r.stat };
};
A('B1 **同内容哈希分支（真机走的就是这条）**：基底是滞后副本（无标记）、并入侧有「原文已移除」→ 合并后标记**仍在**', (() => {
    const x = b1();
    return atomContentHash('atoms', x.stale) === atomContentHash('atoms', x.fresh)   // 前提：标记不进内容哈希
        && x.arr.length === 1
        && x.first.originGone === true && x.first.originGoneAt === 1791177002000
        // v3.40.5：合并后是「原文已移除」→ 位置不补（真机上正是这 171 条的来源）
        && x.first.floorNowStart === undefined && x.first.floorNowEnd === undefined;
})(), () => J(b1()));

const b2 = () => {
    const stale = ATOM('atom_dkr581', 23, '0198-03-09', '傍晚', ['苏布拉街区']);          // 较旧、无标记
    const fresh = ATOM('atom_dkr581', 23, '0198-03-10', '傍晚', ['苏布拉街区'], {          // 较新、内容已改（哈希不同）
        originGone: true, originGoneAt: 1791177002000, hidden: true, summarizedBy: 'sum-9',
        floorNowStart: 21, floorNowEnd: 21, floorNowHash: 'h-21', chatKey: 'other-chat',
    });
    // 让**无标记**的那一侧靠 `updatedAt` 取胜（真机里「滞后副本」也会这样赢）
    const a = Object.assign({}, stale, { updatedAt: 2000 });
    const b = Object.assign({}, fresh, { updatedAt: 1000 });
    const r = mergeDataObjects(D({ updatedAt: 1, atoms: [a] }), D({ updatedAt: 2, atoms: [b] }));
    return { a, b, first: (r.data.atoms || [])[0] || {}, stat: r.stat };
};
A('B2 **冲突分支（按 updatedAt 取胜）**：胜出侧无标记、败者侧有 → 标记、位置指纹与归属**全部保住**', (() => {
    const x = b2();
    const f = x.first;
    return x.stat.conflictWinLocal === 1 && f.id === 'atom_dkr581'
        && atomContentHash('atoms', x.a) !== atomContentHash('atoms', x.b)
        && f.originGone === true && f.originGoneAt === 1791177002000 && f.hidden === true && f.summarizedBy === 'sum-9'
        // v3.40.5：标记抬升后位置不再落地；**内容指纹与归属照旧保住**（供 recheckOriginGone 找回）
        && f.floorNowStart === undefined && f.floorNowEnd === undefined
        && f.floorNowHash === 'h-21' && f.chatKey === 'other-chat';
})(), () => J(b2()));

const b3 = () => {
    // 本地（较新、胜出）已核实当前位置/归属；对端是滞后值 → 补空**不覆盖**
    const local = ATOM('atom_1lx5i3q', 29, '628-07-10', '下午', ['西市'], {
        updatedAt: 9000, floorNowStart: 29, floorNowEnd: 29, floorNowHash: 'h-verified', chatKey: 'this-chat',
    });
    const remote = ATOM('atom_1lx5i3q', 29, '628-07-10', '中午', ['西市'], {
        updatedAt: 1000, originGone: true, floorNowStart: 7, floorNowEnd: 7, floorNowHash: 'h-stale', chatKey: 'other-chat',
    });
    const r = mergeDataObjects(D({ updatedAt: 1, atoms: [local] }), D({ updatedAt: 2, atoms: [remote] }));
    return { first: (r.data.atoms || [])[0] || {}, stat: r.stat };
};
A('B3 胜出侧**已经核实**的 `floorNow*` / `floorNowHash` / `chatKey` 不被对端滞后值覆盖（补空不覆盖；标记仍抬升）', (() => {
    const x = b3();
    return x.stat.conflictWinLocal === 1
        && x.first.time === '下午'                                   // 内容确实是本地那份
        // v3.40.5：对端把标记抬升为「原文已移除」后，**位置失去意义**（不保留陈旧位置）；
        //   指纹与归属仍按「补空不覆盖」保住（指纹是复核找回的依据）
        && x.first.floorNowStart === undefined && x.first.floorNowEnd === undefined
        && x.first.floorNowHash === 'h-verified'
        && x.first.chatKey === 'this-chat'
        && x.first.originGone === true;                              // 只升不降：对端的标记照样抬升
})(), () => J(b3().first));

const b4 = () => {
    // 本地独有 / 远端独有 / 同内容 三条分支的条数语义不因本次修复而改变
    const onlyL = ATOM('only-l', 5, '628-07-01', '上午', ['甲地']);
    const onlyR = ATOM('only-r', 6, '628-07-02', '上午', ['乙地'], { originGone: true, originGoneAt: 111 });
    const same = ATOM('same-id', 7, '628-07-03', '上午', ['丙地']);
    const sameR = Object.assign({}, same, { originGone: true, originGoneAt: 222 });
    const r = mergeDataObjects(D({ atoms: [onlyL, same] }), D({ updatedAt: 9, atoms: [onlyR, sameR] }));
    const by = {}; for (const it of (r.data.atoms || [])) by[it.id] = it;
    return { n: r.data.atoms.length, by, stat: r.stat };
};
A('B4 条数语义不变：并集 3 条（本地独有 + 远端独有 + 同 id），且三条各自的「原文已移除」都在', (() => {
    const x = b4();
    return x.n === 3 && x.stat.added === 1 && x.stat.same === 1
        && x.by['only-l'].originGone === undefined
        && x.by['only-r'].originGone === true && x.by['only-r'].originGoneAt === 111
        && x.by['same-id'].originGone === true && x.by['same-id'].originGoneAt === 222;
})(), () => J({ n: b4().n, stat: b4().stat }));

// ---------- C 组：同内容异 id 去重 `contentDedupeArray` ----------
/** 同内容异 id：标题/正文/日期/时间/地点全同 → 身份哈希一致（只是 id 与标记不同） */
const SAME = (id, extra) => Object.assign(ATOM(id, 25, '0198-05-16', '下午', ['大浴池'], extra), {
    title: '亚历山大港的浴池对话',
    text: '角色甲在浴池里向商人打听航线与货期，内容足够长以便形成稳定的身份哈希。',
});
const c1 = () => {
    const older = SAME('id-old', { originGone: true, originGoneAt: 1791177002000, updatedAt: 1000 });
    const newer = SAME('id-new', { updatedAt: 9000 });
    return { older, newer, out: contentDedupeArray('atoms', [newer, older]) };
};
A('C1 同内容异 id 去重：胜出那条**没有标记**、被去重那条有 → 存活条目仍带「原文已移除」（标记不被去重抹掉）', (() => {
    const x = c1();
    const s = x.out[0] || {};
    return atomIdentityHash('atoms', x.older) === atomIdentityHash('atoms', x.newer)
        && x.out.length === 1 && s.id === 'id-new'
        && s.originGone === true && s.originGoneAt === 1791177002000;
})(), () => J(c1().out));

const c2 = () => {
    const a = SAME('id-a', { nsfw: 'weak', updatedAt: 9000 });
    const b = SAME('id-b', { nsfw: 'strong', floorStart: 20, floorEnd: 26, uses: 4, updatedAt: 1000 });
    return { out: contentDedupeArray('atoms', [a, b]) };
};
A('C2 回归不倒退：NSFW 等级「只升不降」与楼层并区间 / uses 累计照旧生效', (() => {
    const s = c2().out[0] || {};
    return c2().out.length === 1 && s.nsfw === 'strong' && s.floorStart === 20 && s.floorEnd === 26 && s.uses === 5;
})(), () => J(c2().out));

const c3 = () => {
    const a = SAME('id-a', { chatKey: 'this-chat', updatedAt: 9000 });
    const b = SAME('id-b', { chatKey: 'other-chat', floorNowStart: 5, floorNowEnd: 5, floorNowHash: 'h5', updatedAt: 1000 });
    return { out: contentDedupeArray('atoms', [a, b]) };
};
A('C3 去重时归属补空不覆盖：已有 `chatKey` 原样保留，缺失的 `floorNow*` 从另一条补齐', (() => {
    const s = c3().out[0] || {};
    return c3().out.length === 1 && s.chatKey === 'this-chat' && s.floorNowStart === 5 && s.floorNowEnd === 5 && s.floorNowHash === 'h5';
})(), () => J(c3().out));

// ---------- D 组：端到端时钟回归（真机场景 + 反事实） ----------
// 真机参数（13:19 那次）：归属为空、`lastChatFloor = 71`（**滞后一天那份状态里的末楼**）、
//   当前聊天真正的最新情节在第 23 楼、别条聊天旧线被代理定位到第 25 楼。
//   `71` 这个偏大的末楼使「位置越界」判据不触发（25 ≤ 71），于是**只剩** `originGone` 降级能挡住它 ——
//   标记一被合并洗掉，旧线就以「位置更高」取胜（时钟被压回 0198-05-16，与真机日志完全一致）。
const d1 = () => {
    // ① 先按真机做一次「滞后基底 + 并集」合并
    const stale = ATOM('旧线', 25, '0198-05-16', '下午', ['大浴池']);
    const fresh = Object.assign({}, stale, { originGone: true, originGoneAt: 1791177002000 });
    const merged = ((mergeDataObjects(D({ updatedAt: 1790725980433, atoms: [stale] }), D({ updatedAt: 1791177526145, atoms: [fresh] })).data.atoms) || [])[0] || {};
    // ② 反事实对照：把标记手工洗掉（= 修复前的行为）
    const washed = Object.assign({}, merged); delete washed.originGone; delete washed.originGoneAt;
    const cur = ATOM('本聊天新', 23, '628-07-10', '下午', ['西市茶棚'], { chatKey: 'chat-A' });
    // ③ 归属为空（刷新首屏窗口，聊天分层失效）+ 滞后末楼 71
    boot([merged, cur], { chatKey: '', tail: 71 });
    const orderFixed = trustedPlotList().map((x) => x.node.id);
    const clockFixed = pickClock(resolveStoryClock({}));
    boot([washed, cur], { chatKey: '', tail: 71 });
    const orderWashed = trustedPlotList().map((x) => x.node.id);
    const clockWashed = pickClock(resolveStoryClock({}));
    return { merged, washed, orderFixed, clockFixed, orderWashed, clockWashed };
};
A('D1 **真机复现**：归属为空（分层失效）+ 滞后末楼 71 时，被合并保住的「原文已移除」标记仍使旧聊天情节降级 → 时钟取本聊天最新情节 `628-07-10`', (() => {
    const x = d1();
    return plotDemoted(x.merged, 71) === 1 && plotDemoted(x.washed, 71) === 0       // 旧线位置 25 ≤ 71 → 只有标记能降级它
        && J(x.orderFixed) === J(['本聊天新', '旧线'])
        && J(x.clockFixed) === J({ date: '628-07-10', time: '下午', location: '西市茶棚' });
})(), () => J(d1()));

A('D2 **反事实对照**：同一份数据若标记被洗掉（修复前），旧情节就重新胜出、时钟被压回 `0198-05-16`（证明标记就是那根救命稻草）', (() => {
    const x = d1();
    return J(x.orderWashed) === J(['旧线', '本聊天新'])
        && J(x.clockWashed) === J({ date: '0198-05-16', time: '下午', location: '大浴池' });
})(), () => J({ order: d1().orderWashed, clock: d1().clockWashed }));

A('D3 归属已记上时（正常路径）行为不倒退：别条聊天情节本就排后面，时钟仍是本聊天线', (() => {
    const oldLine = ATOM('别条旧线', 25, '0198-05-16', '下午', ['大浴池'], { chatKey: 'other-chat' });
    const cur = ATOM('本聊天新', 23, '628-07-10', '下午', ['西市茶棚'], { chatKey: 'chat-A' });
    boot([oldLine, cur], { chatKey: 'chat-A', tail: 71 });
    return J(trustedPlotList().map((x) => x.node.id)) === J(['本聊天新', '别条旧线'])
        && J(pickClock(resolveStoryClock({}))) === J({ date: '628-07-10', time: '下午', location: '西市茶棚' });
})(), () => J(trustedPlotList().map((x) => x.node.id)));

// ---------- E 组：宿主注入状态时立刻记「当前聊天归属」 ----------
const e1 = () => {
    const host = makeHost({ chat: chatOf(3) });
    host.ctx.chatMetadata = { chat_id_hash: 'chat-hash-e1' };
    installGlobalHost(host, doc);
    const st = emptyState();
    const ret = attachKernelState(st);
    return { st, ret, same: ret === st };
};
A('E1 `attachKernelState()` **注入即归属**：刷新首屏那条路径（载入 → 合并 → 注入 → 重解析时钟）不再停在 `chatKey` 为空', (() => {
    const x = e1();
    return x.same && x.st.chatKey === 'chat-hash-e1';
})(), () => J(e1().st.chatKey));

A('E2 读不到标识时写空串（归属未知，不放宽分层），且**不抛异常**、再次注入幂等', (() => {
    const host = makeHost({ chat: chatOf(3) });
    installGlobalHost(host, doc);
    const st = emptyState();
    const a = attachKernelState(st) === st && st.chatKey === '';
    const b = attachKernelState(st) === st && st.chatKey === '';
    return a && b;
})(), '');

A('E3 标识回退链：`chat_id_hash` → `chatId` → `chatMetadata.integrity`（三条都试）', (() => {
    const r1 = (() => { const h = makeHost({}); h.ctx.chatId = 'chat-42'; installGlobalHost(h, doc); const st = emptyState(); attachKernelState(st); return st.chatKey; })();
    const r2 = (() => { const h = makeHost({}); h.ctx.chatMetadata = { integrity: 'integrity-uuid' }; installGlobalHost(h, doc); const st = emptyState(); attachKernelState(st); return st.chatKey; })();
    const r3 = (() => { const h = makeHost({}); h.ctx.chatMetadata = { chat_id_hash: 'H', integrity: 'I' }; h.ctx.chatId = 'C'; installGlobalHost(h, doc); const st = emptyState(); attachKernelState(st); return st.chatKey; })();
    return r1 === 'chat-42' && r2 === 'integrity-uuid' && r3 === 'H';
})(), '');

R.done();
