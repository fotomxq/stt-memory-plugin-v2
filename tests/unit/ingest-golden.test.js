// ============================================================
// 单元测试 · P3 次批（AI delta 落库内核 core/ingest.js#mergeDelta）与 V1 一致
// 黄金样本：tests/fixtures/v1-golden-ingest.json（oracle = 真实 V1 插件 v1.206 在固定 seed + 固定 delta 下的容器结果）
// 口径：严格相等（JSON.stringify）；墙钟时间戳（>1e12）比较前归一为 'TS'。
//   保存流水线（内容哈希刷新 / 删除留痕）由宿主注入钩子完成 —— 测试里注入与 adapters/store.js 相同的三步，
//   以便逐字符比较 V1 落库后的 `h` 内容哈希。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state as kernelState, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { entryIndexBuild, entryIndexInit, tombstoneSweep } from '../../core/sweep.js';
import { mergeDelta } from '../../core/ingest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-ingest.json'), 'utf8'));
const R = makeReporter('ingest-golden mergeDelta V1 移植保真度（P3 次批）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));
const tsNorm = (v) => {
    if (Array.isArray(v)) return v.map(tsNorm);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (typeof v[k] === 'number' && v[k] > 1e12) ? 'TS' : tsNorm(v[k]);
        return o;
    }
    return v;
};
const JT = (v) => J(tsNorm(v));

/** 与 V1 oracle 相同的运行环境：默认配置 + 关闭会引入随机/时间性的调度开关 */
function bootKernel() {
    Object.assign(cfg, clone(defaultCfg));
    cfg.stateDecayEnabled = false;
    cfg.parallelDecayEnabled = false;
    cfg.memoryForgetEnabled = false;
    cfg.autoRelMaint = false;
    cfg.rumorEnabled = true;
    cfg.currencyEnabled = true;
    cfg.snapshotEnabled = true;
    setScopeKey('角色甲');
    setKernelState(Object.assign(emptyState(), clone(G.seedState)));
    // 保存流水线（与 adapters/store.js 同序）：建索引 → 刷新全部原子 h → 删除留痕
    // 保存流水线（与 adapters/store.js 同序）：**基线只在启动建立一次** → 之后消失的条目才能被留痕
    let indexReady = false;
    setPersistHooks({
        saveState: () => {
            if (!indexReady) { entryIndexInit(); indexReady = true; }
            entryIndexBuild(true);
            tombstoneSweep();
            return true;
        },
        saveCfg: () => true, log: () => undefined, warn: () => undefined,
    });
}

bootKernel();
const ret = mergeDelta(clone(G.delta), { start: 4, end: 6 });
const res = kernelState;
const W = G.result;

R.assert('M1 返回统计：ok / added / total 与 V1 一致（兼容布尔判断）', (() => {
    return !!ret && ret.ok === true && ret.added === G.ret.added && ret.total === G.ret.total
        && W.ret === undefined;
})(), { got: ret && { ok: ret.ok, added: ret.added, total: ret.total }, want: G.ret });

const dims = ['atoms', 'currentStates', 'memories', 'items', 'plans', 'suspense', 'concepts', 'parallels', 'currencies', 'rumors', 'scenes', 'npcs', 'snapshots'];
const diff = [];
dims.forEach((k) => {
    const want = W[k] === undefined ? [] : W[k];
    if (JT(res[k]) !== JT(want)) diff.push(k);
});
R.assert('M2 十三类维度落库结果与 V1 逐字符一致（' + dims.join(' / ') + '）', (() => {
    return diff.length === 0;
})(), {
    diff,
    firstAtom: diff.indexOf('atoms') >= 0 ? { got: tsNorm((res.atoms || [])[0]), want: (W.atoms || [])[0] } : undefined,
    firstItem: diff.indexOf('items') >= 0 ? { got: tsNorm((res.items || [])[0]), want: (W.items || [])[0] } : undefined,
});

R.assert('M3 情节更新：原地替换且保留 uses / 因果 log 字段；新增按时间排序；已存在条目不受影响', (() => {
    const a = (res.atoms || []);
    const upd = a.filter((x) => x.id === 'a_upd')[0];
    const keep = a.filter((x) => x.id === 'a_keep')[0];
    return a.length === 4 && !!upd && upd.text.indexOf('新版本正文') === 0
        && upd.uses === 2 && Array.isArray(upd.log) && upd.log.length === 1 && upd.log[0].prev.indexOf('旧版本正文') === 0
        && !!keep && keep.uses === 3 && keep.text.indexOf('旧情节') > 0
        && a.map((x) => x.id).indexOf('a_gone') < 0;
})(), { atoms: (res.atoms || []).map((x) => x.id) });

R.assert('M4 楼层范围透传：本轮新增条目带 floorStart/floorEnd（4/6）与剧情日期 seenDate', (() => {
    const it = (res.items || [])[0] || {};
    const atomNew = (res.atoms || []).filter((x) => x.id !== 'a_keep' && x.id !== 'a_upd')[0] || {};
    return it.floorStart === 4 && it.floorEnd === 6 && it.seenDate === '1919-11-29'
        && atomNew.floorStart === 4 && atomNew.floorEnd === 6;
})(), { item: (res.items || [])[0] && { fs: res.items[0].floorStart, fe: res.items[0].floorEnd } });

R.assert('M5 内容哈希落地：保存流水线写回全部原子 h（与 V1 逐字符一致）', (() => {
    const a = res.atoms || [];
    return a.length === 4 && a.every((x) => typeof x.h === 'string' && x.h.length > 3)
        && JT(a.map((x) => x.h)) === JT((W.atoms || []).map((x) => x.h));
})(), { got: (res.atoms || []).map((x) => x.h), want: (W.atoms || []).map((x) => x.h) });

R.assert('M6 单值容器与变量：state 不被 delta 覆盖、vars 合并（V1 同款）', (() => {
    return JT(res.state) === JT(W.state) && JT(res.vars) === JT(W.vars)
        && res.vars['天气'] === '阴' && res.state.location === '码头';
})(), { state: res.state, vars: res.vars });

R.assert('M7 角色档案：出生日期推算年龄（剧情日期锚定，与 V1 一致）', (() => {
    const s = (res.snapshots || [])[0] || {};
    const w = (W.snapshots || [])[0] || {};
    return s.identity && s.identity.age === w.identity.age && s.identity.age === '19'
        && s.identity.birthDate === '1900-03-04' && s.name === '乙';
})(), { got: ((res.snapshots || [])[0] || {}).identity, want: ((W.snapshots || [])[0] || {}).identity });

R.assert('M8 传言：按主体维护一条并归一（客观性/发酵度/传播者）与 V1 一致', (() => {
    const r = (res.rumors || [])[0] || {};
    return r.subject === '甲' && r.content === '甲私藏了码头货物' && r.stage === '萌芽'
        && Number(r.ferment) === 20 && Array.isArray(r.carriers) && r.carriers.length === 1
        && r.carriers[0].who === '乙' && JT(r) === JT((W.rumors || [])[0]);
})(), { got: tsNorm((res.rumors || [])[0]), want: (W.rumors || [])[0] });

R.assert('M9 幂等与删除留痕：同一 delta 再合并不新增；remove 走墓碑（deleted 容器记 id）', (() => {
    const before = J((res.atoms || []).map((x) => x.id));
    const beforeTotal = (res.atoms || []).length + (res.memories || []).length + (res.items || []).length;
    const ret2 = mergeDelta(clone(G.delta), { start: 4, end: 6 });
    const afterTotal = (res.atoms || []).length + (res.memories || []).length + (res.items || []).length;
    const ret3 = mergeDelta({ atoms: { remove: ['a_upd'] } }, { start: 7, end: 7 });
    const tomb = (res.deleted && res.deleted.atoms) || {};
    return ret2 && ret2.ok === true && afterTotal === beforeTotal
        && J((res.atoms || []).map((x) => x.id)) !== before
        && (res.atoms || []).map((x) => x.id).indexOf('a_upd') < 0
        && !!tomb['a_upd'] && !!ret3 && ret3.ok === true;
})(), { deleted: (res.deleted || {}).atoms });

R.assert('M10 脏增量不抛：null / 字符串 / 空对象 / 未知名维度都安全（V1 口径：null→空增量仍返回 ok；非对象→false）', (() => {
    const snapshot = J(res.atoms);
    const r1 = mergeDelta(null, {});
    const r2 = mergeDelta('不是对象', {});
    const r3 = mergeDelta({}, {});
    const r4 = mergeDelta({ unknownDim: { add: [1, 2] }, atoms: { add: [{ text: '太短' }] } }, {});
    return r1 && r1.ok === true && r1.added === 0 && !r2 && r3 && r3.ok === true && r4 && r4.ok === true
        && J(res.atoms) === snapshot                       // 空/脏增量不产生条目
        && typeof res.atoms[0].id === 'string';
})(), {});

setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
R.done();
