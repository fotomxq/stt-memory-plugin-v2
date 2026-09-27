// ============================================================
// 单元测试 · v2.86.0「角色档案内容副本」（`docs/D8` §4.4，用户裁决 ④）
//   角色名 → 原子层**标题**（已有）；其余结构化字段**每次变更时自动整合成一份副本写入 `content`**；
//   原字段一个不动（展示 / 注入 / 向量照旧读字段），副本只服务「内容存储 + 身份指纹 + 通用检索」。
// 覆盖：A 副本确定性（顺序固定、集合排序）；B 覆盖面（各结构块 + 具名扩展槽都进副本）；
//       C 上限（取该维 `dimCharLimits.snapshots`）；D 与身份指纹的衔接（字段变化 → 副本变化 → 指纹变化）；
//       E 字段扩展不受影响（新增字段登记即生效；原有字段与展示口径不变）。
// 运行：node tests/unit/snapshot-content-copy.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { normalizeSnapshot } from '../../core/model/snapshot.js';
import { atomIdentityHash } from '../../core/model/hash.js';

const R = makeReporter('snapshot-content-copy v2.86.0 角色档案内容副本');
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o));
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot(patch) {
    Object.assign(cfg, clone(defaultCfg));
    if (patch) Object.assign(cfg, patch);
    setScopeKey('char:snapcopy');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();

const FULL = {
    id: 'k1', name: '角色甲',
    identity: { gender: '男', birthDate: '1900-05-20', species: '人类', occupation: '码头工头', title: '老甲', family: '甲家' },
    appearance: '身高178cm；体型精瘦',
    personality: { traits: ['沉稳', '寡言'], quirks: ['转笔'], values: ['守信'], speechStyle: '简短' },
    background: { origin: '港口', history: '在码头长大并接手货栈' },
    relationships: [{ name: '乙', relation: '同伴', attitude: '信任' }, { name: '丙', relation: '对手', attitude: '戒备' }],
    social: { relationToUser: '搭档', attitudeToUser: '克制' },
    future: { todos: ['查出破坏者', '追回货款'], commitments: ['照看乙'] },
    tags: ['码头', '旧'],
    extra: [{ name: 'occupation', value: '码头工头' }, { name: 'traits', value: ['沉稳', '寡言'] }],
};

// ---------- A 组：确定性 ----------
A('A1 副本为**确定性拼接**：同一输入两次生成逐字一致；段顺序固定（身份→外貌→性格→背景→关系→社会→未来→标签→扩展）', (() => {
    const a = normalizeSnapshot(clone(FULL));
    const b = normalizeSnapshot(clone(FULL));
    const c = String(a.content);
    const idx = ['身份：', '外貌：', '性格：', '背景：', '关系：', '社会：', '未来：', '标签：', '扩展：'].map((s) => c.indexOf(s));
    const ordered = idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    return c === b.content && c.length > 0 && ordered;
})(), () => normalizeSnapshot(clone(FULL)).content);

A('A2 **集合类字段先排序**（标签 / 特质 / 关系）→ 输入顺序不同也得到同一份副本', (() => {
    const p = clone(FULL);
    p.tags = ['旧', '码头'];
    p.personality.traits = ['寡言', '沉稳'];
    p.relationships = [{ name: '丙', relation: '对手', attitude: '戒备' }, { name: '乙', relation: '同伴', attitude: '信任' }];
    p.future.todos = ['追回货款', '查出破坏者'];
    return normalizeSnapshot(p).content === normalizeSnapshot(clone(FULL)).content;
})(), '见断言');

// ---------- B 组：覆盖面 ----------
A('B1 每一类结构块都出现在副本里（身份 / 外貌 / 性格 / 背景 / 关系 / 社会 / 未来 / 标签 / 具名扩展槽）', (() => {
    const c = String(normalizeSnapshot(clone(FULL)).content);
    const must = ['码头工头', '身高178cm', '沉稳', '寡言', '转笔', '守信', '简短', '港口', '在码头长大', '乙(同伴/信任)', '丙(对手/戒备)', '搭档', '克制', '查出破坏者', '照看乙', '码头', '扩展：'];
    const miss = must.filter((m) => c.indexOf(m) < 0);
    return miss.length === 0;
})(), () => normalizeSnapshot(clone(FULL)).content);

A('B2 空档案（仅姓名）→ 副本为空串（不写无意义的空段）', (() => {
    const k = normalizeSnapshot({ id: 'k9', name: '路人甲' });
    return k.content === '' && k.title === '路人甲';
})(), '见断言');

A('B3 单一字段（只有外貌）→ 副本仅一段（`背景·经历` 等空块不出现）', (() => {
    const k = normalizeSnapshot({ id: 'k2', name: '角色甲', appearance: '灰色长袍' });
    return k.content === '外貌：灰色长袍';
})(), () => normalizeSnapshot({ id: 'k2', name: '角色甲', appearance: '灰色长袍' }).content);

// ---------- C 组：上限 ----------
A('C1 副本长度受该维 `dimCharLimits.snapshots` 约束（默认 600；改配置后随之变化）', (() => {
    const long = clone(FULL);
    long.background.history = '很长的经历。'.repeat(200);
    const a = normalizeSnapshot(long);
    boot({ dimCharLimits: Object.assign({}, defaultCfg.dimCharLimits, { snapshots: 200 }) });
    const b = normalizeSnapshot(long);
    const okA = String(a.content).length <= Number(defaultCfg.dimCharLimits.snapshots);
    const okB = String(b.content).length <= 200;
    return okA && okB && String(b.content).length > 0;
})(), '见断言');

// ---------- D 组：与身份指纹的衔接 ----------
A('D1 任一结构化字段变化 → 副本变化 → **身份指纹变化**；仅 `uses` / 楼层 / 采样时间变化 → 副本与指纹都不变', (() => {
    boot();
    const base = normalizeSnapshot(clone(FULL));
    const fields = ['appearance', 'tags', 'future', 'social', 'relationships', 'personality', 'background', 'identity'];
    const changed = fields.filter((f) => {
        const p = clone(FULL);
        if (f === 'appearance') p.appearance = '完全不同';
        else if (f === 'tags') p.tags = ['新标签'];
        else if (f === 'future') p.future = { todos: ['新待办'], commitments: [] };
        else if (f === 'social') p.social = { relationToUser: '陌生人', attitudeToUser: '戒备' };
        else if (f === 'relationships') p.relationships = [{ name: '丁', relation: '上级', attitude: '服从' }];
        else if (f === 'personality') p.personality = { traits: ['急躁'] };
        else if (f === 'background') p.background = { origin: '别处', history: '别的经历' };
        else if (f === 'identity') p.identity = Object.assign({}, FULL.identity, { occupation: '船长' });
        const n = normalizeSnapshot(p);
        return n.content !== base.content && atomIdentityHash('snapshots', n) !== atomIdentityHash('snapshots', base);
    });
    const meta = Object.assign(clone(FULL), { uses: 42, floorStart: 1, floorEnd: 9, lastSeenDate: '1919-12-31' });
    const n2 = normalizeSnapshot(meta);
    return changed.length === fields.length
        && n2.content === base.content && atomIdentityHash('snapshots', n2) === atomIdentityHash('snapshots', base);
})(), '见断言');

A('D2 副本本身**不影响**展示口径字段：`name` / `title` / 结构块原样保留（副本只单向派生）', (() => {
    const k = normalizeSnapshot(clone(FULL));
    return k.name === '角色甲' && k.title === '角色甲'
        && k.appearance === FULL.appearance && k.identity.occupation === '码头工头'
        && Array.isArray(k.relationships) && k.relationships.length === 2;
})(), '见断言');

// ---------- E 组：字段扩展不受影响 ----------
A('E1 具名扩展槽（`extra`，由 gender/species/traits 等派生）会进副本（R13）：扩展源字段变化 → 副本与身份指纹同步变化', (() => {
    const a = normalizeSnapshot(clone(FULL));
    const p = clone(FULL);
    p.identity = Object.assign({}, FULL.identity, { species: '半精灵' });   // species 是 extra 的派生源之一
    const b = normalizeSnapshot(p);
    return String(a.content).indexOf('扩展：') >= 0 && a.content !== b.content
        && atomIdentityHash('snapshots', a) !== atomIdentityHash('snapshots', b)
        && String(b.content).indexOf('半精灵') >= 0;
})(), '见断言');

A('E2 未登记的字段不进副本（「登记即生效」）：副本只由已登记的结构块与 `extra` 组成', (() => {
    const p = clone(FULL);
    p.secretNote = '不该进副本的临时字段';
    const k = normalizeSnapshot(p);
    return String(k.content).indexOf('不该进副本') < 0;
})(), '见断言');

R.done();
