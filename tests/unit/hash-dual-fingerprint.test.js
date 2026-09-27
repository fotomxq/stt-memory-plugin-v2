// ============================================================
// 单元测试 · v2.86.0「双指纹」（`docs/D8` R1=B）
//   ① **身份指纹**（`atomIdentityHash`）：4 基本槽（标题/日期/内容/地点·如有）+ 3 扩展槽（标签/类型/状态·如有），
//      带 `i2:` 前缀 → 用于「认身份」：去重 / 内容墓碑 / 复活防护 / 控制台显示；
//   ② **变更指纹**（`atomContentHash` / `atomChangeHash`）：沿用 V1 逐维字段表 → 用于「看变化」：增量快照差异 / 情节签名。
// 覆盖：A 槽位口径与集合排序；B 两种指纹的分工（哪些改动「认身份」看不见、「看变化」必须看见）；
//       C 例外与边界（关联层 / 货币 / 未归一化历史数据）；D 前缀与消费方接线（墓碑 / 快照 / 签名）。
// 运行：node tests/unit/hash-dual-fingerprint.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    atomIdentityHash, atomContentHash, atomChangeHash, hashPrefixOf, IDENTITY_HASH_PREFIX,
} from '../../core/model/hash.js';
import { IDENTITY_FIELDS, HASH_FIELDS, slimWhitelistOf } from '../../core/model/hashfields.js';
import { collectAtomHashes, tombEntry } from '../../core/merge.js';

const R = makeReporter('hash-dual-fingerprint v2.86.0 双指纹（身份 / 变更）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:hash');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();

const ATOM = {
    id: 'a1', title: '在码头发现物品', date: '1919-11-29', time: '傍晚', text: '角色甲发现被破坏的物品戊',
    locations: ['码头', '仓库'], tags: ['危机', '发现'], type: '发现', validity: 'active', uses: 3,
};
const I = (cat, e) => atomIdentityHash(cat, e);
const C = (cat, e) => atomContentHash(cat, e);

// ---------- A 组：槽位口径 ----------
A('A1 身份指纹带 `i2:` 前缀；**集合类字段先排序**（标签/地点顺序不同 → 同一指纹）', (() => {
    const a = I('atoms', ATOM);
    const b = I('atoms', Object.assign({}, ATOM, { tags: ['发现', '危机'], locations: ['仓库', '码头'] }));
    return a.indexOf(IDENTITY_HASH_PREFIX) === 0 && a === b && hashPrefixOf(a) === IDENTITY_HASH_PREFIX;
})(), () => I('atoms', ATOM));

A('A2 身份槽位覆盖 7 类的**代表性改动**都会改变指纹（标题 / 日期 / 内容 / 地点 / 标签 / 类型 / 状态）', (() => {
    const base = I('atoms', ATOM);
    const cases = [
        { title: '改标题' }, { date: '1919-11-30' }, { text: '换了正文' }, { locations: ['别处'] },
        { tags: ['新标签'] }, { type: '转折' }, { validity: 'inactive' },
    ];
    const changed = cases.filter((patch) => I('atoms', Object.assign({}, ATOM, patch)) !== base).length;
    return changed === cases.length;
})(), '7/7');

A('A3 状态记录：标题槽 = `subject·field`（R10）、内容槽 = `value`、状态槽 = `status`', (() => {
    const s1 = { subject: '角色甲', field: '情绪', value: '担忧', status: 'active' };
    const same = Object.assign({}, s1);
    const diffSubject = Object.assign({}, s1, { subject: '角色乙' });
    const diffValue = Object.assign({}, s1, { value: '平静' });
    const diffStatus = Object.assign({}, s1, { status: 'inactive' });
    return I('currentStates', s1) === I('currentStates', same)
        && I('currentStates', s1) !== I('currentStates', diffSubject)
        && I('currentStates', s1) !== I('currentStates', diffValue)
        && I('currentStates', s1) !== I('currentStates', diffStatus)
        && IDENTITY_FIELDS.currentStates.title.join(',') === 'subject,field';
})(), '见断言');

A('A4 计划 / 悬念：内容槽并入 `steps` / `clues`（R7）→ 步骤内容变化会改变身份指纹', (() => {
    const p1 = { title: '查案', content: '查明真相', tags: ['主线'], status: 'open', steps: [{ text: '问话', done: false }] };
    const p2 = clone(p1); p2.steps = [{ text: '问话', done: true }];
    const p3 = clone(p1); p3.steps = [{ text: '搜查', done: false }];
    const s1 = { title: '谁在背后', content: '幕后之人', tags: [], status: 'open', clues: [{ text: '旧信' }] };
    const s2 = clone(s1); s2.clues = [{ text: '银表' }];
    return I('plans', p1) !== I('plans', p2) && I('plans', p1) !== I('plans', p3) && I('suspense', s1) !== I('suspense', s2);
})(), '见断言');

// ---------- B 组：两种指纹的分工（R1=B 的核心） ----------
A('B1 改 `time`（时段）/ `uses` / `importance` / 楼层：**身份指纹不变**（认身份要迟钝），**变更指纹要变**（看变化要敏感）', (() => {
    const base = ATOM;
    const patched = Object.assign({}, ATOM, { time: '深夜', uses: 99, importance: 0.9, floorStart: 1, floorEnd: 2 });
    return I('atoms', base) === I('atoms', patched) && C('atoms', base) !== C('atoms', patched)
        && C('atoms', base) === C('atoms', base);
})(), '见断言');

A('B2 改 `qty` / `carried`（状态类）：身份不变、变更变 —— 这正是「快照必须记下数量变化」的依据', (() => {
    const i1 = { name: '铜钥匙', desc: '旧钥匙', location: '口袋', tags: ['随身'], qty: 100, carried: true };
    const i2 = Object.assign({}, i1, { qty: 50, carried: false });
    return I('items', i1) === I('items', i2) && C('items', i1) !== C('items', i2);
})(), '见断言');

A('B3 `atomChangeHash` 与 `atomContentHash` 同源（变更指纹行为零改动）；身份指纹**不参与** `HASH_FIELDS` 的口径', (() => {
    const a = C('atoms', ATOM);
    const b = atomChangeHash('atoms', ATOM);
    return a === b && a.indexOf(IDENTITY_HASH_PREFIX) < 0 && HASH_FIELDS.atoms.indexOf('validity') < 0;
})(), '见断言');

// ---------- C 组：例外与边界 ----------
A('C1 关联层（R11）为**引用型例外**：身份指纹 = `i2:` + 现引用字段集；货币（R11）不参与身份判定（空串）', (() => {
    const l = { dim: 'atoms', refId: 'a1', who: '角色甲', how: '亲眼所见', kind: 'knows', public: true };
    const li = I('links', l);
    return li.indexOf(IDENTITY_HASH_PREFIX) === 0 && li.indexOf(C('links', l)) > 0
        && I('links', l) !== I('links', Object.assign({}, l, { kind: 'knows-not' }))
        && I('currencies', { name: '银元', amount: 10 }) === '';
})(), '见断言');

A('C2 未归一化的历史数据（角色档案缺内容副本）→ 身份指纹退化为 `i2:legacy:` + 变更指纹，**不误判同名不同档案**', (() => {
    const k1 = { id: 'k1', name: '角色甲', category: 'snapshots' };
    const k2 = { id: 'k2', name: '角色甲', category: 'snapshots', appearance: '灰色长袍' };
    const h1 = I('snapshots', k1), h2 = I('snapshots', k2);
    return h1 !== h2 && h1.indexOf('i2:legacy:') === 0 && h2.indexOf('i2:legacy:') === 0;
})(), '见断言');

A('C3 归一化后的角色档案：**内容副本**使「同名字段不同」的两条档案身份不同（与 V1 的合并口径差异由此纠正）', (() => {
    const k1 = { id: 'k1', name: '角色甲', category: 'snapshots', content: '' };
    const k2 = { id: 'k2', name: '角色甲', category: 'snapshots', content: '外貌：灰色长袍' };
    const k3 = { id: 'k3', name: '角色甲', category: 'snapshots', content: '外貌：灰色长袍', tags: ['主', '次'] };
    const k4 = { id: 'k4', name: '角色甲', category: 'snapshots', content: '外貌：灰色长袍', tags: ['次', '主'] };
    return I('snapshots', k1) !== I('snapshots', k2) && I('snapshots', k3) === I('snapshots', k4);
})(), '见断言');

A('C4 兜底：对象非法 / 未登记维度 → 空串（与「无分支 → 空」同义，不凭空造身份）', (() => {
    return I('atoms', null) === '' && I('atoms', undefined) === '' && I('zzz', { a: 1 }) === '' && C('currencies', { a: 1 }) === '';
})(), '见断言');

// ---------- D 组：消费方接线 ----------
A('D1 内容墓碑写的是**身份指纹**（`i2:` 前缀）；条目 `h` 缓存同样由身份指纹刷新', (() => {
    boot();
    state.atoms = [clone(ATOM)];
    tombEntry('atoms', state.atoms[0]);
    const keys = Object.keys((state.deletedH || {}).atoms || {});
    return keys.length === 1 && keys[0] === I('atoms', ATOM);
})(), '见断言');

A('D2 快照 / 签名链路取**变更指纹**：`collectAtomHashes(\'change\')` 不带 `i2:` 前缀；默认（身份）带前缀', (() => {
    boot();
    state.atoms = [clone(ATOM)];
    const ch = collectAtomHashes('change').map[ATOM.id].h;
    const id = collectAtomHashes('identity').map[ATOM.id].h;
    return ch === C('atoms', ATOM) && ch.indexOf(IDENTITY_HASH_PREFIX) < 0
        && id.indexOf(IDENTITY_HASH_PREFIX) === 0;
})(), '见断言');

A('D3 瘦身白名单由哈希字段表**派生**（R16）：= 变更字段 ∪ 身份字段，且同义组 keeper 一定落在白名单内', (() => {
    const w = slimWhitelistOf('plans');
    const both = w.indexOf('content') >= 0 && w.indexOf('title') >= 0 && w.indexOf('status') >= 0;
    const noTransform = w.indexOf('stepsText') < 0;
    const drift = [];
    for (const cat of Object.keys(HASH_FIELDS)) {
        const set = slimWhitelistOf(cat);
        for (const f of HASH_FIELDS[cat]) if (set.indexOf(f) < 0) drift.push(cat + '.' + f);
        const idf = IDENTITY_FIELDS[cat] || {};
        for (const slot of Object.keys(idf)) for (const f of idf[slot]) {
            if (f === 'stepsText' || f === 'cluesText' || f === 'linesText') continue;
            if (set.indexOf(f) < 0) drift.push(cat + '#' + f);
        }
    }
    return both && noTransform && drift.length === 0;
})(), () => slimWhitelistOf('plans'));

R.done();
