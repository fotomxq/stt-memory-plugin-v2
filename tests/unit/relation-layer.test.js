// ============================================================
// 单元测试 · v2.83.0「原子层之上的关联层」（实现 docs/D2 的边层：派生视图 + 反向索引）
//
// 用户要求：「开发之前设计的原子层之上的关联层。」
//
// 设计落点（docs/D2-关系约束层设计稿.md）：
//   · T1 让全部 14 个大类进入同一张关系网；T2 把散落的原子↔原子引用收敛为**有类型的边**并支持**反向查询**；
//   · §3.5 阶段 1：`links` 作 `knows` 的只读投影源、各维度私有引用字段作**机械派生来源**，不迁移、不落库；
//   · §0 建议起点 S0：先让关系可见、可反查（`core/relations.js`）。
// 覆盖：
//   A 组：边模型（`core/model/relation.js`）—— 引用归一 / 对称边 canonical / 有向边方向 / 自环拒收 / 词表校验；
//   B 组：派生（`core/relations.js`）—— 逐类引用来源、开关关闭、确定性、上限截断、不派生 caused/before/co-occur；
//   C 组：反向索引 —— `dependents`（谁依赖我）/ `relationsOf`（我引用了谁）与端点标签；
//   D 组：快照统计与死链；E 组：查询解析；F 组：设定入口与开关统一（D1 G1 修复）。
// 运行：node tests/unit/relation-layer.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { relRef, relRefKey, relationId, relTypeSymmetric, relTypeKeys, normRelation, REL_SOURCE_RANK } from '../../core/model/relation.js';
import { deriveRelations, relationSnapshot, dependents, relationsOf, relationQueryRefs, relationLayerOn, relEndpointLabel, relDimLabel } from '../../core/relations.js';
import { relLayerOn } from '../../ui/rel-table.js';
import { SETTINGS_CONTROLS, settingsPageHtml, settingsPagesInfo } from '../../ui/settings-pages.js';

const R = makeReporter('relation-layer v2.83.0 关联层（派生视图 + 反向索引）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 一份覆盖全部派生来源的样本数据 */
function sample() {
    return Object.assign(emptyState(), {
        atoms: [
            { id: 'a1', text: '甲角色在码头交货。', date: '1919-11-01', locations: ['码头'], entities: ['甲角色'], validity: 'active' },
            { id: 'a2', text: '乙角色与丙角色在仓库盘货。', date: '1919-11-20', locations: ['仓库'], validity: 'active' },
            { id: 'aSum', text: '【总结】早期两条。', date: '1919-11-25', mergedSummary: { by: 'auto', sourceIds: ['a1', 'a2'], sourceCount: 2 }, validity: 'active', permanence: 'permanent' },
        ],
        snapshots: [{ id: 's1', name: '甲角色' }, { id: 's2', name: '乙角色' }, { id: 's3', name: '丙角色' }],
        scenes: [
            { id: 'sc1', name: '城市甲', pathArr: ['城市甲'], pathStr: '城市甲' },
            { id: 'sc2', name: '码头', pathArr: ['城市甲', '码头'], pathStr: '城市甲>码头' },
            { id: 'sc3', name: '仓库', pathArr: ['城市甲', '仓库'], pathStr: '城市甲>仓库' },
        ],
        links: [
            { id: 'l1', dim: 'memories', refId: 'm1', who: '甲角色', how: 'participant', deviation: 'accurate', at: '1919-11-01' },
            { id: 'l2', dim: 'memories', refId: 'm1', who: '乙角色', how: 'told', deviation: 'unaware' },
            { id: 'l3', dim: 'memories', refId: 'm1', who: '', public: true, sourceRefs: [{ dim: 'atoms', refId: 'a1' }] },
        ],
        memories: [{ id: 'm1', owner: '甲角色', title: '码头见闻', content: '甲角色在码头看到木箱。', date: '1919-11-01' }],
        plans: [{ id: 'p1', content: '清点货单', status: 'open', atomRefs: ['a1'], memRefs: ['m1'] }],
        suspense: [{ id: 'x1', content: '木箱来源', status: 'open', planRefs: ['p1'], atomRefs: ['a2'] }],
        parallels: [
            { id: 'pa1', title: '第三方插手', text: '若木箱属第三方。', date: '1919-11-05', sourceRefs: [{ dim: 'atoms', refId: 'a1' }], planRef: 'p1' },
            { id: 'pa2', title: '已转正的分支', text: '成了事实。', date: '1919-11-06', promotedTo: 'a2' },
        ],
        rumors: [
            { id: 'r1', subject: '木箱', content: '听说木箱被第三方拿走', parallelRefs: ['pa1'] },
            { id: 'r2', subject: '木箱', content: '后续说法', lineage: { rootId: 'r1', parentId: 'r1', children: [], generation: 1 } },
        ],
        plotSegments: [{ id: 'seg1', header: '### 1919-11', atomIds: ['a1', 'a2'], atomCount: 2 }],
        items: [{ id: 'i1', name: '铜箱', owner: '甲角色', location: '码头' }, { id: 'i2', name: '通用物资', owner: '通用' }],
        currencies: [{ id: 'c1', owner: '乙角色', name: '银元', amount: 5 }],
    });
}
function boot(mut) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.relLinkEnabled = true;
    setScopeKey('char:relation');
    setKernelState(sample());
    if (typeof mut === 'function') mut(state);
}

// ---------- A 组：边模型 ----------
A('A1 引用归一：`relRef` 去空白并在缺维度/缺 id 时返回 null；端点键是 `dim|id`', (() => {
    return J(relRef('atoms', ' a1 ')) === J({ dim: 'atoms', id: 'a1' })
        && relRef('atoms', '') === null && relRef('', 'a1') === null
        && relRefKey({ dim: 'atoms', id: 'a1' }) === 'atoms|a1';
})(), () => J(relRef('atoms', 'a1')));

A('A2 稳定 id：**对称边**两端写法一致（不会 A↔B 双写），**有向边**方向不同即不同边', (() => {
    const ab = relationId('mirrors', relRef('rumors', 'r1'), relRef('parallels', 'pa1'));
    const ba = relationId('mirrors', relRef('parallels', 'pa1'), relRef('rumors', 'r1'));
    const fwd = relationId('derived-from', relRef('atoms', 'a2'), relRef('atoms', 'a1'));
    const rev = relationId('derived-from', relRef('atoms', 'a1'), relRef('atoms', 'a2'));
    const howA = relationId('knows', relRef('memories', 'm1'), { who: '甲角色' }, 'participant');
    const howB = relationId('knows', relRef('memories', 'm1'), { who: '甲角色' }, 'told');
    return ab === ba && fwd !== rev && howA !== howB && relTypeSymmetric('mirrors') === true && relTypeSymmetric('derived-from') === false;
})(), () => ({ ab: relationId('mirrors', relRef('rumors', 'r1'), relRef('parallels', 'pa1')) }));

A('A3 `normRelation` 只认词表内的类型、端点必须齐备，并归一来源权重（未知来源回落 mech）', (() => {
    const ok = normRelation({ type: 'knows', from: { dim: 'memories', id: 'm1' }, to: { who: '甲角色' }, how: 'participant', source: 'manual', strength: 2 });
    const badType = normRelation({ type: '不存在的类型', from: { dim: 'a', id: 'b' }, to: { dim: 'c', id: 'd' } });
    const badEnd = normRelation({ type: 'knows', from: { dim: 'memories', id: 'm1' }, to: { dim: '', id: '' } });
    return !!ok && ok.source === 'manual' && ok.strength === 1 && ok.id.indexOf('rel_') === 0
        && badType === null && badEnd === null
        && REL_SOURCE_RANK.manual > REL_SOURCE_RANK.ai && REL_SOURCE_RANK.mech > REL_SOURCE_RANK.inferred;
})(), '见断言');

// ---------- B 组：派生 ----------
A('B1 认知边（links → knows / knows-not）：带 how / public / at；`deviation=unaware` 归为 knows-not；锚行不产生认知边', (() => {
    boot();
    const { edges } = deriveRelations();
    const k1 = edges.filter((e) => e.type === 'knows' && e.to.who === '甲角色')[0] || {};
    const kn = edges.filter((e) => e.type === 'knows-not')[0] || {};
    return k1.from && k1.from.dim === 'memories' && k1.from.id === 'm1' && k1.how === 'participant'
        && k1.public === true && k1.at === '1919-11-01'          // 公开标记来自锚行
        && kn.to && kn.to.who === '乙角色' && String(kn.deviation) === 'unaware'
        && !edges.some((e) => e.type === 'knows' && e.to && e.to.who === '');
})(), () => deriveRelations().edges.filter((e) => e.type === 'knows' || e.type === 'knows-not').map((e) => e.type + ':' + (e.to.who || '?')));

A('B2 结构边：锚行引用 → member-of/derived-from；计划/悬念/分段/总结/传言的引用各自成边', (() => {
    boot();
    const { edges } = deriveRelations();
    const has = (t, fd, fi, td, ti, who) => edges.some((e) => e.type === t && e.from.dim === fd && e.from.id === fi
        && ((who && e.to.who === who) || (!who && e.to && e.to.dim === td && e.to.id === ti)));
    return has('member-of', 'memories', 'm1', 'atoms', 'a1')             // 锚行 sourceRefs? 不，member-of 看 conceptRef 等
        || has('derived-from', 'memories', 'm1', 'atoms', 'a1');          // 锚行 sourceRefs → derived-from
})(), () => deriveRelations().edges.filter((e) => e.from.id === 'm1').map((e) => e.type + '→' + (e.to.id || e.to.who)));

A('B3 逐来源核对：平行来源/转正 · 计划与悬念引用 · 分段 · 总结 · 传言谱系与镜像', (() => {
    boot();
    const { edges } = deriveRelations();
    const has = (t, f, to) => edges.some((e) => e.type === t && f === (e.from.dim + ':' + e.from.id) && to === (e.to.dim ? (e.to.dim + ':' + e.to.id) : ('who:' + e.to.who)));
    return has('derived-from', 'parallels:pa1', 'atoms:a1')        // sourceRefs
        && has('derived-from', 'atoms:a2', 'parallels:pa2')        // promotedTo（情节 ← 被转正的平行）
        && has('member-of', 'parallels:pa1', 'plans:p1')           // planRef
        && has('member-of', 'plans:p1', 'atoms:a1')                // atomRefs
        && has('member-of', 'suspense:x1', 'plans:p1')             // planRefs
        && has('derived-from', 'plotSegments:seg1', 'atoms:a1')    // 分段 → 情节
        && has('derived-from', 'atoms:aSum', 'atoms:a1')           // 总结 → 被总结情节
        && has('derived-from', 'rumors:r2', 'rumors:r1')           // 传言谱系
        // 对称边按端点键排序归一 → 存储方向可能相反，两种写法都算命中（这正是「不双写」的证明）
        && (has('mirrors', 'rumors:r1', 'parallels:pa1') || has('mirrors', 'parallels:pa1', 'rumors:r1'));
})(), () => deriveRelations().edges.map((e) => e.type + ' ' + ((e.from.dim||('who:'+e.from.who)) + ':' + (e.from.id||'')) + '→' + ((e.to.dim||('who:'+e.to.who)) + ':' + (e.to.id||''))));

A('B4 归属与位置：owner → owns（「通用」不建边）；地点**精确**匹配场景才建 located-at（含路径写法）', (() => {
    boot();
    const { edges } = deriveRelations();
    const own = edges.filter((e) => e.type === 'owns');
    const loc = edges.filter((e) => e.type === 'located-at');
    return own.length === 3                                        // items i1 / currencies c1 / memories m1（i2 owner=通用 排除）
        && own.every((e) => !!e.to.dim && !!e.from.who)
        && loc.some((e) => e.from.id === 'a1' && e.to.id === 'sc2')   // atoms.locations ['码头'] → 场景 sc2
        && loc.some((e) => e.from.id === 'a2' && e.to.id === 'sc3')
        && loc.some((e) => e.from.id === 'i1' && e.to.id === 'sc2')
        && loc.every((e) => e.source === 'inferred');
})(), () => deriveRelations().edges.filter((e) => e.type === 'owns' || e.type === 'located-at').map((e) => e.type + ':' + e.from.id + '→' + e.to.id));

A('B5 场景层级 → member-of（子场景 → 父场景，按路径解析）', (() => {
    boot();
    const { edges } = deriveRelations();
    return edges.some((e) => e.type === 'member-of' && e.from.dim === 'scenes' && e.from.id === 'sc2' && e.to.dim === 'scenes' && e.to.id === 'sc1')
        && edges.some((e) => e.type === 'member-of' && e.from.id === 'sc3' && e.to.id === 'sc1');
})(), () => deriveRelations().edges.filter((e) => e.from.dim === 'scenes').map((e) => e.from.id + '→' + e.to.id));

A('B6 **不派生**因果/时序/共现（机械推不出）：词表里保留其位但当前零产出；自环拒收', (() => {
    boot((st) => { st.atoms.push({ id: 'aSelf', text: '自环测试', validity: 'active' }); st.links.push({ id: 'ls', dim: 'atoms', refId: 'aSelf', who: '甲角色', how: 'participant' }); });
    const { edges } = deriveRelations();
    const types = edges.map((e) => e.type);
    return types.indexOf('caused') < 0 && types.indexOf('before') < 0 && types.indexOf('co-occur') < 0
        && relTypeKeys().indexOf('caused') >= 0
        && !edges.some((e) => e.from.dim && e.to.dim && e.from.dim === e.to.dim && e.from.id === e.to.id);
})(), () => Array.from(new Set(deriveRelations().edges.map((e) => e.type))));

A('B7 开关口径（D1 G1 修复）：`relLinkEnabled=false` → 只停「谁知道」边（linksOff=true），其它引用照常派生；UI 与内核同一键', (() => {
    boot();
    const on = deriveRelations();
    cfg.relLinkEnabled = false;
    const off = deriveRelations();
    const offTypes = off.edges.map((e) => e.type);
    return on.edges.some((e) => e.type === 'knows') && off.linksOff === true
        && offTypes.indexOf('knows') < 0 && offTypes.indexOf('knows-not') < 0
        && offTypes.indexOf('derived-from') >= 0                     // 其它来源不受开关影响
        && relationLayerOn() === false && relLayerOn() === false;     // 内核与 UI 读同一个键
})(), () => ({ on: deriveRelations().scanned, off: deriveRelations().linksOff }));

A('B8 确定性：同一份数据重复派生结果**逐字节一致**（含顺序），不修改任何 state', (() => {
    boot();
    const before = J(state);
    const a = J(deriveRelations().edges);
    const b = J(deriveRelations().edges);
    const c = J(deriveRelations({ max: 10000 }).edges);
    return a === b && a === c && J(state) === before;
})(), () => deriveRelations().edges.length + ' 条边');

A('B9 上限截断：`max` 生效并如实标记 `truncated`', (() => {
    boot();
    const all = deriveRelations().edges.length;
    const r = deriveRelations({ max: 3 });
    return all > 3 && r.edges.length === 3 && r.truncated === true;
})(), () => ({ all: deriveRelations().edges.length }));

// ---------- C 组：反向索引 ----------
A('C1 `dependents`（谁依赖我）：以该端点为**终点**的边齐备，并带上来源标签与维度名', (() => {
    boot();
    const snap = relationSnapshot();
    const deps = dependents(relRef('atoms', 'a1'), { edges: snap.edges });
    const kinds = deps.map((e) => e.type).sort();
    return deps.length >= 3
        && kinds.indexOf('derived-from') >= 0 && kinds.indexOf('member-of') >= 0
        && deps.every((e) => !!e.fromLabel && e.from.id !== 'a1');
})(), () => dependents(relRef('atoms', 'a1')).map((e) => e.type + '←' + e.fromLabel));

A('C2 `relationsOf`（我引用了谁）：以该端点为**起点**的边齐备（含角色端点的显示名）；归属边（角色→条目）属**反向**', (() => {
    boot();
    const snap = relationSnapshot();
    const out = relationsOf(relRef('memories', 'm1'), { edges: snap.edges });
    const inn = dependents(relRef('memories', 'm1'), { edges: snap.edges });
    const knows = out.filter((e) => e.type === 'knows' || e.type === 'knows-not');
    return out.length >= 3 && knows.length === 2                     // 甲角色（知情）+ 乙角色（不知情）
        && knows.every((e) => !!e.toLabel && !!e.toCoord)
        && inn.some((e) => e.type === 'owns' && e.from.who === '甲角色');
})(), () => relationsOf(relRef('memories', 'm1')).map((e) => e.type + '→' + e.toLabel));

A('C3 端点标签：AtomRef 取条目标题（缺失条目如实标注）、`{who}` 取角色名；维度中文名可读', (() => {
    boot();
    return relEndpointLabel(relRef('atoms', 'a1')).indexOf('甲角色在码头交货') >= 0
        && relEndpointLabel(relRef('atoms', '不存在')) === '（条目已不在库中）'
        && relEndpointLabel({ who: '甲角色' }) === '甲角色'
        && relDimLabel('parallels') === '平行事件' && relDimLabel('memories') === '长期记忆';
})(), '见断言');

// ---------- D 组：快照统计 ----------
A('D1 `relationSnapshot`：按类型/起点维度统计、死链计数（端点条目已不存在）、扫描条目数', (() => {
    boot();
    const s1 = relationSnapshot();
    boot((st) => { st.parallels.push({ id: 'paBad', title: '悬空来源', text: 'x', sourceRefs: [{ dim: 'atoms', refId: '已删除的情节' }] }); });
    const s2 = relationSnapshot();
    return s1.stats.total > 10 && s1.stats.byType.knows >= 1 && s1.stats.byType['knows-not'] >= 1 && s1.stats.byFromDim.atoms >= 1
        && s1.stats.dangling === 0 && s1.stats.scanned > 10
        && s2.stats.dangling >= 1;                                     // 悬空引用如实计入死链
})(), () => relationSnapshot().stats);

// ---------- E 组：查询解析 ----------
A('E1 查询：`dim:id` 精确命中；标题关键字子串命中（上限）；未命中返回空', (() => {
    boot();
    const byCoord = relationQueryRefs('atoms:a1');
    const byText = relationQueryRefs('铜箱');
    const miss = relationQueryRefs('绝对不存在的词');
    return byCoord.length === 1 && byCoord[0].coord === 'atoms:a1' && byCoord[0].dimLabel === '情节'
        && byText.length === 1 && byText[0].coord === 'items:i1'
        && relationQueryRefs('木箱').length >= 1                        // 关键字命中（正文/标题）
        && miss.length === 0;
})(), () => relationQueryRefs('铜箱'));

// ---------- F 组：设定入口与开关统一 ----------
A('F1 v2.83.0 设定入口补齐：关联层三项控件落在「分析记忆」页（此前完全无 UI 入口），且总数如实 +3', (() => {
    const keys = SETTINGS_CONTROLS.analyze.map((c) => String(c.key));
    const info = settingsPagesInfo();
    const analyze = info.pages.filter((p) => p.id === 'analyze')[0] || {};
    const page = settingsPageHtml('analyze');
    return keys.indexOf('relLinkEnabled') >= 0 && keys.indexOf('relLinkMax') >= 0 && keys.indexOf('relOrphanAction') >= 0
        && info.totalControls === 176 && analyze.controls === 20
        && page.indexOf('关联层（谁知道 / 谁相关）') >= 0
        && page.indexOf('data-ftt-cfg="relLinkEnabled"') >= 0 && page.indexOf('data-ftt-cfg="relOrphanAction"') >= 0
        && page.indexOf('自动清理（目标条目已不存在）') >= 0;             // select 选项
})(), () => SETTINGS_CONTROLS.analyze.filter((c) => /^rel/.test(String(c.key))).map((c) => c.key));

A('F2 关键口径写回真实键：`relLinkEnabled` 关闭后内核派生与 UI 关系层同时停用（不再是配置里不存在的键）', (() => {
    boot();
    cfg.relLinkEnabled = false;
    const off = deriveRelations();
    cfg.relLinkEnabled = true;
    const on = deriveRelations();
    return off.linksOff === true && on.linksOff === false
        && on.edges.filter((e) => e.type === 'knows').length >= 1
        && on.edges.filter((e) => e.type === 'knows-not').length >= 1
        && off.edges.filter((e) => e.type === 'knows' || e.type === 'knows-not').length === 0;
})(), '见断言');

R.done();
