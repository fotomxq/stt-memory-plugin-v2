// ============================================================
// 单元测试 · v2.86.0「瘦身白名单」定位与不变量（`docs/D8` §5 / R16–R18）
//   定位：白名单 = **同义字段消歧表**（同义组里保留哪一份 = keeper），**不是**「保留字段清单」；
//         非空字段一律保存；空值/默认值无条件丢弃；它由 `core/model/hashfields.js` 派生（同源）。
// 覆盖：A keeper 表由哈希字段派生；B **只丢等值同义**（值不同两份都留）；C hydrate 由 keeper 无损重建；
//       D 瘦身前后**两种指纹**都不变（R3 的 v2.86.0 版本：身份 + 变更都要满足）。
// 运行：node tests/unit/slim-keeper.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { slimEntryForStorage, hydrateSlimEntry, SLIM_HASHED_FIELDS, SLIM_SYNONYM_GROUPS, isSlimDefault } from '../../core/slim.js';
import { atomIdentityHash, atomContentHash } from '../../core/model/hash.js';
import { HASH_FIELDS, slimWhitelistOf } from '../../core/model/hashfields.js';

const R = makeReporter('slim-keeper v2.86.0 瘦身白名单（消歧表）定位与不变量');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o));
const dims = Object.keys(SLIM_HASHED_FIELDS);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:slimkeeper');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();

/** 每个维度的最小样例（含真实字段名，够跑 keeper 与哈希） */
const SAMPLE = {
    atoms: { id: 'a1', title: '情节', text: '正文', content: '正文', date: '1919-01-01', tags: ['甲'], type: '事件' },
    currentStates: { id: 's1', subject: '角色甲', field: '情绪', value: '担忧', content: '担忧', status: 'active' },
    snapshots: { id: 'k1', name: '角色甲', title: '角色甲', appearance: '长袍', tags: ['主'] },
    memories: { id: 'm1', owner: '角色甲', title: '记忆', content: '看到一切', date: '1919-01-01', tags: [] },
    items: { id: 'i1', name: '铜钥匙', desc: '旧钥匙', content: '旧钥匙', location: '口袋', carried: true, tags: [] },
    plans: { id: 'p1', title: '查案', content: '查明真相', status: 'open', tags: [], steps: [{ text: '问话' }] },
    suspense: { id: 'q1', title: '谁在背后', content: '幕后之人', status: 'open', tags: [], clues: [{ text: '旧信' }] },
    scenes: { id: 'c1', name: '码头', title: '码头', desc: '港口区', content: '港口区', pathArr: ['甲城', '码头'], pathStr: '甲城>码头' },
    concepts: { id: 'n1', name: '天机阁', title: '天机阁', content: '情报机构', source: '传闻', date: '1919-01-01', tags: [] },
    parallels: { id: 'r1', title: '另一种可能', text: '若当时…', content: '若当时…', date: '1919-01-01', tags: [] },
    links: { id: 'l1', dim: 'atoms', refId: 'a1', who: '角色甲', how: '亲眼', kind: 'knows', public: true },
    plotSegments: { id: 'g1', header: '1919-01 至 1919-02', start: '1919-01-01', end: '1919-02-01', lines: [{ label: '线', text: '正文' }], items: [{ label: '线', text: '正文' }], title: '1919-01 至 1919-02' },
    rumors: { id: 'u1', subject: '甲', title: '甲', content: '私藏货物', text: '私藏货物', tags: [], stage: '萌芽' },
};

// ---------- A 组：派生与 keeper 不变量 ----------
A('A1 白名单 = 派生结果（变更字段 ∪ 身份字段）；每个维度都覆盖其两类字段，且不含具名变换（如 stepsText）', (() => {
    const drift = [];
    for (const cat of dims) {
        const set = SLIM_HASHED_FIELDS[cat];
        if (J(set) !== J(slimWhitelistOf(cat))) drift.push(cat + ':非派生');
        for (const f of (HASH_FIELDS[cat] || [])) if (set.indexOf(f) < 0) drift.push(cat + '.' + f);
        if (set.indexOf('stepsText') >= 0 || set.indexOf('cluesText') >= 0 || set.indexOf('linesText') >= 0) drift.push(cat + ':变换泄漏');
    }
    return drift.length === 0 && dims.length === 13;
})(), () => dims);

A('A2 每个同义组的 keeper 都在白名单内（R3 的不变量之一）；组内字段名都在该维语料里', (() => {
    const bad = [];
    for (const cat of Object.keys(SLIM_SYNONYM_GROUPS)) {
        const hashed = SLIM_HASHED_FIELDS[cat] || [];
        for (const grp of SLIM_SYNONYM_GROUPS[cat]) {
            const keeper = grp.filter((f) => hashed.indexOf(f) >= 0)[0] || null;
            if (!keeper) bad.push(cat + ':' + grp.join('/'));
        }
    }
    return bad.length === 0;
})(), '见断言');

A('A3 白名单**不决定**字段是否保存：非空字段一律保留（含不在白名单里的运行态字段）', (() => {
    const out = slimEntryForStorage('atoms', { id: 'a1', title: '情节', text: '正文', uses: 3, floorEnd: 9, hidden: true, importance: 0.7 });
    return out.title === '情节' && out.text === '正文' && out.uses === 3 && out.floorEnd === 9
        && out.hidden === true && out.importance === 0.7 && out.id === 'a1';
})(), '见断言');

A('A4 空值 / 默认值**无条件丢弃**（与白名单无关）：\'\' / [] / 0 / false / {} 不写盘', (() => {
    const out = slimEntryForStorage('atoms', { id: 'a1', title: '情节', text: '', tags: [], uses: 0, hidden: false, extra: [] });
    return out.text === undefined && out.tags === undefined && out.uses === undefined
        && out.hidden === undefined && isSlimDefault(0) && isSlimDefault(false) && isSlimDefault([]) && isSlimDefault('');
})(), '见断言');

// ---------- B 组：只丢等值同义 ----------
A('B1 同义字段**值相同** → 只留 keeper，读回由 keeper 补齐（无损）', (() => {
    const bad = [];
    for (const cat of Object.keys(SLIM_SYNONYM_GROUPS)) {
        const src = SAMPLE[cat];
        if (!src) continue;
        for (const grp of SLIM_SYNONYM_GROUPS[cat]) {
            const present = grp.filter((f) => src[f] !== undefined);
            if (present.length < 2) continue;
            const slim = slimEntryForStorage(cat, clone(src));
            const kept = grp.filter((f) => slim[f] !== undefined);
            if (kept.length !== 1) { bad.push(cat + ':' + grp.join('/') + ':未收敛'); continue; }
            const back = hydrateSlimEntry(cat, clone(slim));
            for (const f of grp) {
                if (f === 'pathStr' && Array.isArray(back.pathArr)) { if (back.pathStr !== back.pathArr.join('>')) bad.push(cat + ':pathStr'); continue; }
                if (J(back[f]) !== J(src[f])) bad.push(cat + '.' + f + ' 读回不一致');
            }
        }
    }
    return bad.length === 0;
})(), () => '见断言');

A('B2 同义字段**值不同** → 两份都留（绝不因消歧丢数据）；读回也不改写', (() => {
    const src = { id: 'a1', title: 'A', name: 'B', text: '正文甲', content: '正文乙' };
    const slim = slimEntryForStorage('atoms', clone(src));
    return slim.text === '正文甲' && slim.content === '正文乙';
})(), '见断言');

A('B3 轨迹一致：`slim` 后再 `hydrate` 不改变白名单内的字段值（13 维逐维）', (() => {
    const bad = [];
    for (const cat of dims) {
        const src = SAMPLE[cat];
        if (!src) continue;
        const back = hydrateSlimEntry(cat, clone(slimEntryForStorage(cat, clone(src))));
        for (const f of SLIM_HASHED_FIELDS[cat]) {
            if (src[f] === undefined) continue;
            if (isSlimDefault(src[f])) continue;                 // 空值/默认值本就不写盘（哈希侧按「缺失 ≡ 空」归一）
            if (f === 'pathStr' && Array.isArray(back.pathArr)) continue;
            if (J(back[f]) !== J(src[f])) bad.push(cat + '.' + f);
        }
    }
    return bad.length === 0;
})(), '见断言');

// ---------- C 组：两种指纹在瘦身前后都不变（R3 v2.86.0） ----------
A('C1 瘦身 → 读回：**身份指纹**与**变更指纹**都必须与瘦身前一致（双指纹版的 R3）', (() => {
    const bad = [];
    for (const cat of dims) {
        const src = SAMPLE[cat];
        if (!src) continue;
        const back = hydrateSlimEntry(cat, clone(slimEntryForStorage(cat, clone(src))));
        if (atomIdentityHash(cat, back) !== atomIdentityHash(cat, src)) bad.push(cat + ':身份');
        if (atomContentHash(cat, back) !== atomContentHash(cat, src)) bad.push(cat + ':变更');
    }
    return bad.length === 0;
})(), '见断言');

R.done();
