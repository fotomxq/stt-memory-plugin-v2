// ============================================================
// 单元测试 · v3.50.22：W2 `业-2` —— **约束可机械校验**（`docs/D2` §5.2 / §6 S3）
//   ① **落库前**（防幻觉）：`sourceRefs` 指向不存在的条目 / 未来楼层 → **剔除依据、保留条目**，`dropped` 如实计；
//   ② **落库后**（体检）：机械派生 + 校验 → finding 形态沿用体检 `{code, level, dim, id, field, value, detail}`，**只报告不改数据**；
//   ③ 总开关 `cfg.constraintCheckEnabled`（默认开；关 → 一条都不报）。
//
// 运行：node tests/unit/constraint-check.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    CONSTRAINT_CODES, CONSTRAINT_REF_DIMS, entryRefs, entryEvidence, buildConstraintIndex,
    filterInvalidRefs, constraintFindings, constraintCheckOn,
} from '../../core/constraint-check.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('constraint-check v3.50.22：W2 `业-2` 约束机械校验（finding 沿用体检形态）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('cc22'); setLastMessageId(30);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });

/** 造一份最小 state：2 条情节（楼层 3 / 8）+ 1 条平行事件 */
function mkState(extra) {
    const st = emptyState();
    st.atoms = [
        { id: 'a3', text: '第三条楼层的情节正文足够长。', title: '甲', floorStart: 3, floorEnd: 3 },
        { id: 'a8', text: '第八条楼层的情节正文足够长。', title: '乙', floorStart: 8, floorEnd: 8 },
    ];
    st.parallels = [Object.assign({
        id: 'p1', title: '平行一', text: '平行世界的一件足够长的事。', causalLine: '因甲而乙。',
        floorStart: 10, floorEnd: 10, sourceRefs: [{ dim: 'atoms', refId: 'a3', floor: 3 }],
    }, extra || {})];
    return st;
}

// ---------- A 组：字段读取（两种写法都认） ----------
A('A1 `entryRefs` 认 `sourceRefs` / `关联来源` / 中文键，归一为 `{dim, refId, floor}`', (() => {
    const a = entryRefs({ sourceRefs: [{ dim: 'atoms', refId: 'a1', floor: 3 }] });
    const b = entryRefs({ 关联来源: ['a2', { id: 'a3', 楼层: 5 }] });
    const c = entryRefs({ 来源: { refId: 'a4' } });
    return a.length === 1 && a[0].refId === 'a1' && a[0].floor === 3
        && b.length === 2 && b[0].refId === 'a2' && b[1].floor === 5
        && c.length === 1 && c[0].refId === 'a4' && entryRefs({}).length === 0;
})(), 'n/a');

A('A2 `entryEvidence` 认数字 / 文本里的楼层 / 对象；解析不出时给空字段（供 `evidence-invalid` 判）', (() => {
    const a = entryEvidence({ evidence: 12 });
    const b = entryEvidence({ evidence: '见第 7 楼' });
    const c = entryEvidence({ evidence: '无楼层字样' });
    const d = entryEvidence({ evidence: [{ refId: 'x1' }] });
    return a[0].floor === 12 && b[0].floor === 7 && c.length === 1 && c[0].floor === 0 && !c[0].refId && d[0].refId === 'x1';
})(), 'n/a');

A('A3 `buildConstraintIndex`：按维建 id 集 + 记每条的发生楼层（因果倒挂判定要用）', (() => {
    const idx = buildConstraintIndex(mkState());
    return idx.byDim.atoms.has('a3') && idx.byDim.atoms.has('a8')
        && idx.byDim.parallels.has('p1') && idx.floorOf['atoms:a8'] === 8;
})(), 'n/a');

// ---------- B 组：落库前（防幻觉） ----------
A('B1 **幻觉依据被剔除、好依据保留**：`sourceRefs` 指向不存在的 `a9` → `dropped=1`，`kept=1`', (() => {
    const st = mkState();
    const e = { id: 'p2', sourceRefs: [{ dim: 'atoms', refId: 'a3', floor: 3 }, { dim: 'atoms', refId: 'a9', floor: 4 }] };
    const r = filterInvalidRefs('parallels', e, { state: st, maxFloor: 30 });
    return r.kept.length === 1 && r.dropped.length === 1 && r.dropped[0].refId === 'a9'
        && r.entry.sourceRefs.length === 1 && r.entry.sourceRefs[0].refId === 'a3';
})(), 'n/a');

A('B2 **未来楼层也算幻觉**：`floor` 超过「已见最大楼层」→ 剔除（即使条目存在）', (() => {
    const st = mkState();
    const r = filterInvalidRefs('parallels', { sourceRefs: [{ dim: 'atoms', refId: 'a3', floor: 99 }] }, { state: st, maxFloor: 30 });
    return r.dropped.length === 1 && r.kept.length === 0;
})(), 'n/a');

A('B3 **不改入参**（返回新对象）且**无依据的条目原样通过**', (() => {
    const src = { id: 'p3', sourceRefs: [{ dim: 'atoms', refId: 'a3', floor: 3 }] };
    const before = J(src);
    const st = mkState();
    filterInvalidRefs('parallels', src, { state: st, maxFloor: 30 });
    const plain = filterInvalidRefs('memories', { id: 'm1', content: '正文' }, { state: st, maxFloor: 30 });
    return J(src) === before && plain.dropped.length === 0 && plain.entry.id === 'm1';
})(), 'n/a');

// ---------- C 组：落库后（体检 finding） ----------
A('C1 feeling 形态：每条 finding 都有 `{code, level, dim, id, field, value, detail}`，且 **level 恒为 warn**（只提示不改数据）', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'aMissing', floor: 3 }] });
    const f = constraintFindings(st, { maxFloor: 30 });
    const one = f[0] || {};
    return f.length >= 1 && CONSTRAINT_CODES.indexOf(one.code) >= 0 && one.level === 'warn'
        && ['code', 'level', 'dim', 'id', 'field', 'value', 'detail'].every((k) => k in one);
})(), () => J(constraintFindings(mkState({ sourceRefs: [{ dim: 'atoms', refId: 'zz', floor: 1 }] }), { maxFloor: 30 })));

A('C2 **悬空依据**（`ref-orphan`）：指向不存在的条目被点名（dim/id/value 可追溯）', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'aMissing', floor: 3 }] });
    const f = constraintFindings(st, { maxFloor: 30 }).filter((x) => x.code === 'ref-orphan');
    return f.length === 1 && f[0].dim === 'parallels' && f[0].id === 'p1' && f[0].value === 'aMissing';
})(), 'n/a');

A('C3 **因果倒挂**（`causal-inverted`）：依据条目楼层（8）晚于本条（10）→ 不报；依据楼层（20）→ 报', (() => {
    const okSt = mkState({ floorStart: 20, floorEnd: 20, sourceRefs: [{ dim: 'atoms', refId: 'a8', floor: 8 }] });
    const badSt = mkState({ floorStart: 5, floorEnd: 5, sourceRefs: [{ dim: 'atoms', refId: 'a8', floor: 8 }] });
    const ok = constraintFindings(okSt, { maxFloor: 30 }).filter((x) => x.code === 'causal-inverted');
    const bad = constraintFindings(badSt, { maxFloor: 30 }).filter((x) => x.code === 'causal-inverted');
    return ok.length === 0 && bad.length === 1;
})(), 'n/a');

A('C4 **未来楼层**（`ref-floor-missing`）+ **evidence 不可解析**（`evidence-invalid`）都能报出来', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'a3', floor: 99 }], evidence: '胡说的依据' });
    const codes = constraintFindings(st, { maxFloor: 30 }).map((x) => x.code);
    return codes.indexOf('ref-floor-missing') >= 0 && codes.indexOf('evidence-invalid') >= 0;
})(), 'n/a');

A('C5 **只读**：跑校验前后 `state` 的 JSON 完全一致（`N4` 不自动删改）', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'aMissing', floor: 3 }] });
    const before = J(st);
    constraintFindings(st, { maxFloor: 30 });
    return J(st) === before;
})(), 'n/a');

A('C6 体检集成：`dataHealthReport` 里能看到约束 finding（`counts` 也有该 code）', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'aMissing', floor: 3 }] });
    setKernelState(st);
    const rep = dataHealthReport(st, { maxFloor: 30 });
    const codes = rep.findings.map((f) => f.code);
    return codes.indexOf('ref-orphan') >= 0 && Number(rep.counts['ref-orphan'] || 0) >= 1;
})(), 'n/a');

A('C7 **总开关**：`cfg.constraintCheckEnabled=false` → 体检不再报约束 finding；恢复默认后又能报', (() => {
    const st = mkState({ sourceRefs: [{ dim: 'atoms', refId: 'aMissing', floor: 3 }] });
    setKernelState(st);
    const on = constraintCheckOn();
    cfg.constraintCheckEnabled = false;
    const off = dataHealthReport(st, { maxFloor: 30 }).findings.filter((f) => CONSTRAINT_CODES.indexOf(f.code) >= 0).length;
    cfg.constraintCheckEnabled = true;
    const back = dataHealthReport(st, { maxFloor: 30 }).findings.filter((f) => CONSTRAINT_CODES.indexOf(f.code) >= 0).length;
    return on === true && off === 0 && back >= 1;
})(), 'n/a');

R.done();
