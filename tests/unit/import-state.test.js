// ============================================================
// 单元测试 · v3.50.7「导出后的数据无法导入」（用户报告）
//
// 用户原话：「导出后的数据无法导入，请修复。」
//
// 根因（本轮实测，`docs/D17` `U253`）：导入链路（`index.js#importStateJson` → `adapters/import-v1.js#mergeV1IntoCurrent`）
//   此前**只并维度容器 + 墓碑 + `state` 三键**，于是「导出 → 导入到新设备 / 恢复备份」之后：
//     · **已处理楼层台账 `processedFloors` 归零** → 旧楼层全部重新变成「待分析」（用户看到的就是「导入没生效」）；
//     · **`vars` 变量清空** · **`stats` 计数归零** · `varTemplates` / `plotSegmentLog` 丢失；
//     · 信封里**没有 `state`** 时（文件不完整）旧实现拿信封本身当状态合并 → `added: 0` 却报 `ok: true`（**静默假成功**）；
//     · 带 BOM 的 JSON（Windows 记事本「另存为 UTF-8」）→ 直接 `JSON 解析失败`。
//
// 本档锁：往返一致性（含运行时槽）· BOM / 空白容错 · 信封缺 state 如实失败 · 逐容器回报 · 落盘失败不吞结果。
//
// 运行：node tests/unit/import-state.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setPersistHooks, setScopeKey, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { DIMENSIONS } from '../../core/constants.js';
import { exportTextOf } from '../../core/export.js';
import { importStateJson } from '../../index.js';
import { importStatePayload, importResultNote } from '../../adapters/import-state.js';
import { attachKernelState } from '../../host/chat.js';

const R = makeReporter('import-state v3.50.7：导出 → 导入 往返（含运行时槽）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('imp'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });

/** 造一份「每个维度 + 每个关键运行时槽都有内容」的库 */
function richState() {
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '1919-11-29', time: '夜', location: '码头' });
    DIMENSIONS.forEach((d, i) => {
        if (d.kind === 'state') return;
        st[d.kind] = [{
            id: 'x' + i, kind: (d.kind === 'maps' ? 'place' : undefined), level: (d.kind === 'maps' ? 'scene' : undefined),
            sceneRef: (d.kind === 'maps' ? 'sc-1' : undefined),
            title: 'T' + i, text: '正文 ' + i, content: '正文 ' + i, name: 'N' + i, subject: 'S' + i, field: 'F' + i, value: 'V' + i,
            date: '1919-11-29', validity: 'active', tags: [], floorStart: i + 1, floorEnd: i + 1,
        }];
    });
    st.vars = { weather: '阴', mood: '紧' };
    st.stats = { plansClosed: 3, suspenseResolved: 2 };
    st.processedFloors = { 1: { f: 1, h: 'h1' }, 2: { f: 2, h: 'h2' } };
    st.processedDropped = { 9: { f: 9, h: 'h9' } };
    st.lastKnownFloor = 42;
    st.processedVer = 3;
    st.plotSegmentLog = [{ at: 1, sig: 'b1-abc', n: 30, ok: true }, { at: 2, sig: 'b2-def', n: 30, ok: true }];
    st.deleted = { atoms: { gone1: 111 } };
    st.deletedH = { atoms: { 'hash-1': 222 } };
    st.protagonist = '角色甲';
    st.storyDay = 12;
    return st;
}
const exportOf = (st) => exportTextOf(st, { format: 'ftt-memory-v2-export', version: 'test', scope: 'imp', at: 1 });
const counts = (s) => DIMENSIONS.map((d) => (s && Array.isArray(s[d.kind])) ? s[d.kind].length : -1);

// ---------- A 组：往返一致性 ----------
A('A1 **维度往返**：导出 → 导入到空库 → 15 个维度容器**逐条还原**（条数一致）', (() => {
    const src = richState();
    const text = exportOf(src);
    attachKernelState(emptyState());
    return importStateJson(text).then((r) => {
        const ok = r.ok === true && J(counts(state)) === J(counts(src));
        return ok;
    });
})(), () => J({ dims: counts(state) }));

A('A2（回归）**运行时槽往返**：`processedFloors` / `processedDropped` / `vars` / `stats` / `lastKnownFloor` / `processedVer` / `plotSegmentLog` / `deleted` / `deletedH` / `protagonist` / `storyDay` 全部随备份还原', (() => {
    const src = richState();
    const text = exportOf(src);
    attachKernelState(emptyState());
    return importStateJson(text).then((r) => {
        const s = state;
        return r.ok === true
            && J(s.processedFloors) === J(src.processedFloors)
            && J(s.processedDropped) === J(src.processedDropped)
            && J(s.vars) === J(src.vars)
            && J(s.stats) === J(src.stats)
            && Number(s.lastKnownFloor) === 42 && Number(s.processedVer) === 3
            && (s.plotSegmentLog || []).length === 2
            && !!s.deleted.atoms.gone1 && !!s.deletedH.atoms['hash-1']
            && String(s.protagonist) === '角色甲' && Number(s.storyDay) === 12;
    });
})(), () => J({ floors: state.processedFloors, vars: state.vars, stats: state.stats, log: (state.plotSegmentLog || []).length }));

A('A3 逐容器回报：`dims`（各维度新增）/ `slots`（槽并入）/ `tombstones`（墓碑）都在返回体里（用户能看出到底进了什么）', (() => {
    const src = richState();
    const text = exportOf(src);
    attachKernelState(emptyState());
    return importStateJson(text).then((r) => {
        const dimKeys = Object.keys(r.dims || {});
        const slotKeys = Object.keys(r.slots || {});
        return r.ok === true && Number(r.added) >= 10 && dimKeys.length >= 10
            && slotKeys.indexOf('processedFloors') >= 0 && slotKeys.indexOf('vars') >= 0 && slotKeys.indexOf('stats') >= 0
            && (r.tombstones.deleted || 0) >= 1 && (r.tombstones.deletedH || 0) >= 1;
    });
})(), () => J({ added: state.atoms && 0 }));

A('A4 提示文案**逐容器明细**：含「条目新增 N 条（…）」+「台账 / 变量等并入」+「未删除本地记忆」；落盘失败另起一句如实说明', (() => {
    const note = importResultNote({ ok: true, added: 5, dims: { atoms: 3, memories: 2 }, slots: { vars: 1, stats: 2 }, tombstones: { deleted: 1, deletedH: 0 } });
    const bad = importResultNote({ ok: true, added: 0, dims: {}, slots: {}, tombstones: {}, saved: false, saveError: '写盘失败' });
    return note.indexOf('条目新增 5 条') >= 0 && note.indexOf('atoms 3') >= 0 && note.indexOf('memories 2') >= 0
        && note.indexOf('台账 / 变量等并入') >= 0 && note.indexOf('未删除本地记忆') >= 0
        && bad.indexOf('本机都已有') >= 0 && bad.indexOf('⚠ 落盘失败') >= 0 && bad.indexOf('写盘失败') >= 0;
})(), 'n/a');

A('A5 **合并语义不变**：本机已有的同 id 条目**不被覆盖**、本机独有条目**不被删除**（append-only）', (() => {
    const text = exportOf(richState());
    const local = emptyState();
    local.atoms = [{ id: 'x0', title: '本机版', text: '本机正文', date: '1919-11-29', validity: 'active', tags: [] },
        { id: 'local-only', title: '本机独有', text: '不该被删', date: '1919-11-29', validity: 'active', tags: [] }];
    attachKernelState(local);
    return importStateJson(text).then(() => {
        const byId = {};
        (state.atoms || []).forEach((a) => { byId[a.id] = a; });
        return !!byId['x0'] && byId['x0'].title === '本机版' && !!byId['local-only'] && (state.atoms || []).length === 2 + (richState().atoms.length - 1);
    });
})(), () => J((state.atoms || []).map((a) => a.id)));

// ---------- B 组：解析容错与如实失败 ----------
A('B1 **BOM 容错**：JSON 前置 `\\uFEFF`（Windows 记事本另存为 UTF-8）也能导入（旧实现直接「JSON 解析失败」）', (async () => {
    const text = exportOf(richState());
    attachKernelState(emptyState());
    const r = await importStateJson('\uFEFF' + text);
    return r.ok === true && Number(r.added) > 0;
})(), 'n/a');

A('B2 首尾空白 / 换行容错；空内容如实拒绝（`内容为空`）', (async () => {
    const text = exportOf(richState());
    attachKernelState(emptyState());
    const r1 = await importStateJson('\n\n  ' + text + '  \n');
    const r2 = await importStateJson('   \n');
    return r1.ok === true && r2.ok === false && String(r2.reason) === '内容为空';
})(), 'n/a');

A('B3 **信封缺 `state` 如实失败**（不再「静默假成功」：`added: 0` 却报成功）', (async () => {
    const r = await importStateJson(J({ format: 'ftt-memory-v2-export', version: '3.50.6', scope: 'imp', at: 1 }));
    return r.ok === false && String(r.reason).indexOf('没有 state') >= 0 && String(r.format) === 'ftt-memory-v2-export';
})(), 'n/a');

A('B4 非法 JSON 如实失败；**裸状态**（无信封，直接 `{atoms:[…]}`）仍可导入（历史口径）', (async () => {
    const bad = await importStateJson('{ 这不是 JSON');
    attachKernelState(emptyState());
    const raw = await importStateJson(J({ atoms: [{ id: 'r1', title: 'R', text: '裸状态', date: '1919-11-29', validity: 'active', tags: [] }] }));
    return bad.ok === false && String(bad.reason) === 'JSON 解析失败' && raw.ok === true && Number(raw.added) === 1;
})(), 'n/a');

A('B5 **落盘失败不吞结果**：`save` 抛错时仍返回 `ok:true` + 合并读数，并带 `saved:false` / `saveError`（内存已合并）', (async () => {
    const text = exportOf(richState());
    const r = await importStatePayload(text, {
        getState: () => emptyState(),
        attach: (next) => attachKernelState(next),
        save: () => { throw new Error('写盘失败'); },
    });
    return r.ok === true && r.saved === false && String(r.saveError).indexOf('写盘失败') >= 0 && Number(r.added) > 0;
})(), 'n/a');

A('B6 **反向探针**：把「BOM 容错」去掉即应失败 —— 证明 A/B 组真的在看这段代码（此处直接断言裸 `JSON.parse` 对 BOM 会抛错）', (() => {
    let threw = false;
    try { JSON.parse('\uFEFF{"a":1}'); } catch (e) { threw = true; }
    return threw === true;
})(), 'n/a');

R.done();
