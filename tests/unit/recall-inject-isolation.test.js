// ============================================================
// 单元测试 · v3.50.5 `应-40`：注入体的**区块级隔离**（`docs/D45` §2.2 F1 / §8 `应-40`）
//
// 缺陷（实测复现）：`core/recall.js#buildMemoryBodyForInject` 整个函数**共用一个兜错**，
//   只有 `[货币]` 区块自带隔离（v3.46.5 用户报告「货币根本没注入成功」时补的）。
//   其余任何大类只要有一条坏数据（数组里混入 `null`，或该维度**不是数组**），整个函数抛错 → 返回空串
//   → **AI 一条记忆都看不到**。脏数据来源现成：导入、早期版本写入、跨端合并。
//
// 口径（本批）：注入前**只读清洗**（非数组 → 空数组；元素里的 null/undefined → 丢弃）+
//   每个区块的**行构建**各包一层错误边界（失败只丢该区块，其余照常）。
//
// 本档 = **反向探针**：逐维构造两种脏数据 → 断言正文**非空**且含 `## 情节记忆` 见证条目。
//   去掉清洗 / 区块边界后，本档必须变红（实现前实测：15 项全红）。
//
// 运行：node tests/unit/recall-inject-isolation.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';

const R = makeReporter('recall-inject-isolation v3.50.5 `应-40`：脏数据只丢该区块（不再是整份注入变空）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '甲在码头清点货物。', name: '角色甲' }] }), doc);
setChatHooks({ dbgLog: () => undefined });

/** 见证条目：只要它还在，就说明 `## 情节记忆` 区块没被牺牲 */
const WITNESS = '甲在码头打开木箱取出账册。';

/** 基线态：每条维度都放 1 条正常数据（这样「丢的是哪一个区块」才有意义） */
function baseState() {
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: '1919-11-29', time: '夜', location: '码头', present: ['角色甲'] });
    st.atoms = [{ id: 'a1', title: '木箱账册', text: WITNESS, date: '1919-11-29', validity: 'active', floorStart: 1, floorEnd: 1, tags: ['码头'], uses: 0, importance: 0.8 }];
    st.currentStates = [{ id: 't1', subject: '角色甲', field: '处境', value: '在码头', status: 'active', date: '1919-11-29' }];
    st.snapshots = [{ id: 'sn1', name: '角色甲', identity: '船工', appearance: '短打', tags: [], date: '1919-11-29' }];
    st.memories = [{ id: 'm1', title: '旧事', content: '货船曾失窃。', date: '1919-11-20', tags: ['旧'], importance: 0.6 }];
    st.items = [{ id: 'i1', name: '铜钥匙', desc: '开木箱用。', date: '1919-11-29', tags: [], owner: '角色甲' }];
    st.plans = [{ id: 'p1', content: '查明敲门者。', status: 'open', date: '1919-11-29', tags: [], planner: '角色甲' }];
    st.suspense = [{ id: 's1', content: '谁在夜里敲门？', status: 'open', date: '1919-11-29', tags: [] }];
    st.parallels = [{ id: 'x1', title: '黑市风声', text: '码头有人私下交易。', date: '1919-11-29', tags: [] }];
    st.rumors = [{ id: 'r1', subject: '货船', content: '听说要涨价。', date: '1919-11-29', tags: [], objectivity: '主观' }];
    st.currencies = [{ id: 'c1', owner: '角色甲', name: '银元', unit: '枚', amount: 50, date: '1919-11-29', tags: [] }];
    st.npcs = [{ id: 'n1', name: '角色乙', gender: '女', identity: '商人', tags: [] }];
    st.scenes = [{ id: 'sc1', name: '码头', desc: '夜里的码头。', date: '1919-11-29' }];
    st.concepts = [{ id: 'cp1', name: '走私', content: '私下转运货物。', date: '1919-11-29', tags: [] }];
    st.maps = [{ id: 'mp1', name: '码头区', units: [], routes: [], date: '1919-11-29' }];
    st.vars = { weather: '阴' };
    return st;
}

function boot(mutate) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.injectCurrentPrompt = true;
    setScopeKey('角色甲');
    setLastMessageId(3);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    const st = baseState();
    if (mutate) mutate(st);
    setKernelState(st);
}

const body = () => String(buildMemoryBodyForInject('甲 码头 木箱 货船') || '');

/** 15 个维度 × 两种脏数据形态（数组含 null / 该维度不是数组） */
const DIMS = [
    'atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'parallels',
    'rumors', 'currencies', 'npcs', 'scenes', 'concepts', 'maps', 'vars',
];

// ---------- N1：基线（无脏数据）必须注入见证条目 ----------
A('N1 基线：无脏数据时正文含 `## 情节记忆` 见证条目（后续所有「非空」判据的参照）', (() => {
    boot(null);
    const b = body();
    return b.indexOf('## 情节记忆') >= 0 && b.indexOf(WITNESS) >= 0;
})(), () => ({ len: body().length, head: body().slice(0, 80) }));

// ---------- N2：数组里混入 null → 只丢该维度，其余照常 ----------
A('N2 **数组里混入 `null`**（15 维逐条）：注入正文**非空**且仍含 `## 情节记忆` 见证条目（实现前：整份注入被清空）', (() => {
    const bad = [];
    for (const dim of DIMS) {
        boot((st) => {
            const v = st[dim];
            if (Array.isArray(v)) st[dim] = [null].concat(v);
            else st[dim] = [null];                     // vars（对象）→ 换成含 null 的数组，同样属脏数据
        });
        const b = body();
        if (!(b.length > 0 && b.indexOf('## 情节记忆') >= 0 && b.indexOf(WITNESS) >= 0)) bad.push(dim);
    }
    return bad.length === 0;
})(), () => {
    const bad = [];
    for (const dim of DIMS) {
        boot((st) => { const v = st[dim]; st[dim] = Array.isArray(v) ? [null].concat(v) : [null]; });
        const b = body();
        if (!(b.length > 0 && b.indexOf('## 情节记忆') >= 0)) bad.push(dim + '(len=' + b.length + ')');
    }
    return bad;
});

// ---------- N3：该维度不是数组 → 只丢该维度，其余照常 ----------
/**
 * `atoms` 脏了 → 见证条目所在区块**自己**理应为空（丢的就是它）；其余 14 维脏了 → 见证条目必须照常在。
 */
A('N3 **该维度不是数组**（15 维逐条，脏数据 `{}`）：**正文非空**；除 `atoms` 自身外，`## 情节记忆` 见证条目必须仍在（实现前：`(…).slice is not a function` → 整份清空）', (() => {
    const bad = [];
    for (const dim of DIMS) {
        boot((st) => { st[dim] = {}; });
        const b = body();
        const okWitness = (dim === 'atoms') ? true : (b.indexOf('## 情节记忆') >= 0 && b.indexOf(WITNESS) >= 0);
        if (!(b.length > 0 && okWitness)) bad.push(dim);
    }
    return bad.length === 0;
})(), () => {
    const bad = [];
    for (const dim of DIMS) {
        boot((st) => { st[dim] = {}; });
        const b = body();
        const okWitness = (dim === 'atoms') ? true : (b.indexOf('## 情节记忆') >= 0);
        if (!(b.length > 0 && okWitness)) bad.push(dim + '(len=' + b.length + ')');
    }
    return bad;
});

// ---------- N4：坏数据只影响**该维度自己**（见证条目所在维度除外） ----------
/**
 * 隔离等价性：把某维度换成「脏数据」与「清空该维度」必须得到**逐字节相同**的注入体
 *   —— 证明 ① 坏数据不影响其它维度；② 清洗的净效果就是「该维度按空处理」。
 */
A('N4 **只丢坏元素（清洗等价）**：`memories` = 含 `null`/`undefined` 的数组 与 手工剔除坏元素后的数组 → 正文**逐字节相同**；`## 情节记忆` 见证条目仍在', (() => {
    const good = { id: 'm9', title: '好条目', content: '正常内容', date: '1919-11-20', tags: ['旧'] };
    boot((st) => { st.memories = [null, good, undefined]; });
    const dirty = body();
    boot((st) => { st.memories = [good]; });
    const clean = body();
    return dirty === clean && dirty.length > 0 && dirty.indexOf('## 情节记忆') >= 0 && dirty.indexOf(WITNESS) >= 0;
})(), () => ({ dirtyLen: body().length }));

// ---------- N5：清洗不改变正常路径（逐字节对照） ----------
A('N5 **正常数据逐字节不变**：同一正常态连续两次构建的正文完全相同，且长度与见证条目都在（清洗是纯读、不改 state）', (() => {
    boot(null);
    const b1 = body();
    const b2 = body();
    return b1 === b2 && b1.length > 0 && b1.indexOf(WITNESS) >= 0;
})(), () => ({ len: body().length }));

R.done();
