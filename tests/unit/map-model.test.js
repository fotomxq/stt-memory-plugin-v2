// ============================================================
// 单元测试 · v3.47.0 地图维度（`docs/D22` W16 `数-22` 容器落地 / `数-23` 路径自动分析 / `数-24` 从属注入）
//
// 设计依据：`docs/D27-地图维度设计稿.md` §3.1（分层）· §3.2（两 kind）· §3.3（六处接线）· §3.4（路径护栏）
//   · §3.5（捆绑注入）· §6 决策记录 Q1–Q7。
//
// 本文件锁七件事：
//   ① **六处接线**（常量 / 归一 / 哈希 / 瘦身 / 迁移 / 跨端）+ `DATA_VERSION` 1 → 2；
//   ② **稳定 id**：`mp_` 由（层级|场所|上层|名称）派生、`mr_` **与方向无关**；同名同父同场所两端同 id；
//   ③ **引用不进哈希**（`02` §2 I3）：改 `sceneRef`/`parentId`/`fromId`/`toId`/`evidence` **不改变**内容哈希；
//   ④ **路径护栏**（§3.4）：只在走过时建、必带 `evidence`、同对只一条且**只更新不累加**、未走过不建；
//   ⑤ **场所 / 上层 / 端点解析不到就跳过并计数**（不凭空造场景）；
//   ⑥ **从属注入**（§3.5）：场景入选才挂子块、**不新增 `[地图]` 小节**、场景文案逐字不变、预算紧张先丢地图；
//   ⑦ **反向探针**：把护栏拆掉会被本文件抓住（下述断言直接读真实落库结果）。
//
// 运行：node tests/unit/map-model.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { ATOM_DIM_KEYS, DIMENSIONS, DATA_VERSION } from '../../core/constants.js';
import {
    normalizeMap, normalizeMeasure, mapPlaceId, mapRouteId, mapsOf, mapTreeOf, mapInjectLines, mapInjectStats,
    MAP_LEVELS, MAP_INJECT_MAX_ROOMS,
} from '../../core/model/map.js';
import { atomContentHash, atomIdentityHash } from '../../core/model/hash.js';
import { HASH_FIELDS, IDENTITY_FIELDS, slimWhitelistOf } from '../../core/model/hashfields.js';
import { SLIM_HASHED_FIELDS, SLIM_SYNONYM_GROUPS, slimEntryForStorage, hydrateSlimEntry } from '../../core/slim.js';
import { applyMapDelta, mapDeltaText } from '../../core/map-ingest.js';
import { migrateState } from '../../core/migrate.js';
import { dataAggHash, mergeDataObjects } from '../../core/cross-sync.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { storeCapFor, STORE_LIMITS, STORE_SHARE_DIMS } from '../../core/ingest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('map-model v3.47.0 地图维度（D22 W16 数-22/数-23/数-24 · D27）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

// ---------- ① 六处接线 ----------
A('A1 常量：`DIMENSIONS` 15 维含 maps · `ATOM_DIM_KEYS` 14 含 maps · `DATA_VERSION` = 2（`docs/D27` §3.3 第 1/5 项）', (() => {
    return DIMENSIONS.some((d) => d.kind === 'maps') && DIMENSIONS.length === 15
        && ATOM_DIM_KEYS.indexOf('maps') >= 0 && ATOM_DIM_KEYS.length === 14
        && DATA_VERSION === 2;
})(), J({ dims: DIMENSIONS.length, atom: ATOM_DIM_KEYS.length, dv: DATA_VERSION }));

A('A2 哈希表：`HASH_FIELDS.maps` = 内容类六项 + kind；**引用类不在表内**（§3.3 ③ / `02` §2 I3）', (() => {
    const f = HASH_FIELDS.maps || [];
    const refs = ['sceneRef', 'parentId', 'fromId', 'toId', 'evidence'];
    return ['level', 'name', 'desc', 'distance', 'timeCost', 'direction'].every((k) => f.indexOf(k) >= 0)
        && refs.every((k) => f.indexOf(k) < 0)
        && J(IDENTITY_FIELDS.maps) === J({});     // 与货币同口径：不进身份哈希（id 已由内容派生）
})(), J(HASH_FIELDS.maps));

A('A3 瘦身：白名单由哈希表派生（含 maps）· 同义组 keeper 都在白名单内（`slim-keeper` 的不变量）', (() => {
    const set = SLIM_HASHED_FIELDS.maps || [];
    const groups = SLIM_SYNONYM_GROUPS.maps || [];
    return J(set) === J(slimWhitelistOf('maps'))
        && set.indexOf('name') >= 0 && set.indexOf('desc') >= 0
        && groups.length === 2 && groups.every((g) => g.some((k) => set.indexOf(k) >= 0));
})(), J({ set: SLIM_HASHED_FIELDS.maps, groups: SLIM_SYNONYM_GROUPS.maps }));

A('A4 迁移：老存档补 `maps: []`（`DATA_VERSION` 1 → 2 的唯一迁移动作，只补容器不解释旧数据）', (() => {
    const old = { atoms: [], version: '3.46.6' };      // 完全没有 maps 的老存档
    const out = migrateState(JSON.parse(JSON.stringify(old)));
    return Array.isArray(out.maps) && out.maps.length === 0;
})(), 'n/a');

A('A5 跨端：`maps` 进**逐条合并**（`dataAggHash` 计入）—— 两端只差地图时指纹必须不同', (() => {
    const a = { atoms: [], maps: [{ id: 'mp_x', kind: 'place', level: 'room', name: '货仓', sceneRef: 's1' }] };
    const b = { atoms: [], maps: [] };
    const h1 = dataAggHash(a), h2 = dataAggHash(b);
    const merged = mergeDataObjects(a, b, {});        // 返回 `{data, stat}`（见 `core/cross-sync.js` 的出口契约）
    return h1 !== h2 && !!h1 && !!h2 && ((merged.data || {}).maps || []).length === 1;
})(), 'n/a');

A('A6 上限：`maps` 在 `STORE_LIMITS` 与占比表内（否则「总上限 × 占比」派生会漏它）；占比合计仍 100', (() => {
    const sum = STORE_SHARE_DIMS.reduce((n, d) => n + Number(defaultCfg.storeShare[d] || 0), 0);
    const cap = storeCapFor('maps');
    return !!STORE_LIMITS.maps && STORE_SHARE_DIMS.indexOf('maps') >= 0
        && Number(defaultCfg.storeShare.maps) === Number(STORE_LIMITS.maps[4])
        && sum === 100 && Number(cap) > 0;
})(), J({ dims: STORE_SHARE_DIMS.length, cap: storeCapFor('maps') }));

// ---------- ② 归一与稳定 id ----------
const anchor = normalizeMap({ kind: 'place', level: 'scene', name: '码头', sceneRef: 's1' });
const room = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's1', parentId: anchor.id, desc: '堆木箱的旧仓房' });
A('B1 空间单元归一：三级 `level` 枚举；**场所级只做锚点、不写文本**（N3：文本以 `scenes` 为准）', (() => {
    const bad = normalizeMap({ kind: 'place', level: '不存在的层级', name: 'X', sceneRef: 's1' });
    const sceneDesc = normalizeMap({ kind: 'place', level: 'scene', name: '码头', sceneRef: 's1', desc: '不该留' });
    return MAP_LEVELS.join(',') === 'scene,room,fixture'
        && anchor.desc === '' && sceneDesc.desc === '' && room.desc === '堆木箱的旧仓房'
        && bad.level === 'scene';                                     // 非法层级 → 退化为最保守的锚点
})(), J([anchor.desc, room.desc]));
A('B2 `sceneRef` 是硬要求；缺场所 → 丢弃（`null`），不静默落一条无归属的单元', (() => {
    return normalizeMap({ kind: 'place', name: '孤岛' }) === null
        && normalizeMap({ kind: 'place', name: 'X', sceneRef: 's1' }) !== null;
})(), 'n/a');
A('B3 稳定 id：同名同父同场所 → 同一 id（两端归一一致；`02` §2 I1「由 id 寻址」）', (() => {
    const a = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's1', parentId: 'mp_p' });
    const b = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's1', parentId: 'mp_p' });
    return a.id === b.id && a.id === mapPlaceId('room', 's1', 'mp_p', '货仓') && a.id.indexOf('mp_') === 0;
})(), room.id);
A('B4 路径 id **与方向无关**（`A→B` 与 `B→A` 同一条，避免两条互相矛盾）', (() => {
    return mapRouteId('a', 'b') === mapRouteId('b', 'a') && mapRouteId('a', 'b').indexOf('mr_') === 0;
})(), mapRouteId('a', 'b'));
A('B5 路径归一：两端必填且不同（自环丢弃）；`direction` 非法回落 `both`；未走过 → `inferred: true`', (() => {
    const self = normalizeMap({ kind: 'route', fromId: 'a', toId: 'a' });
    const r = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', direction: '瞎写' });
    const walked = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true });
    return self === null && r.direction === 'both' && r.inferred === true && r.traversed === false
        && walked.traversed === true && walked.inferred === false;
})(), 'n/a');
A('B6 kind 缺省时按「有无 from/to」推断（AI 常省 `kind`）；显式 `kind` 优先', (() => {
    const p = normalizeMap({ name: '货仓', sceneRef: 's1', level: 'room' });
    const r = normalizeMap({ fromId: 'a', toId: 'b', traversed: true });
    return p && p.kind === 'place' && r && r.kind === 'route';
})(), 'n/a');

// ---------- ③ 度量规整（不猜） ----------
A('C1 度量：保留 `raw` 原话；能规整则附 `{value, unit}`（阿拉伯数字 + 个位汉字数字 + 无义后缀）', (() => {
    const a = normalizeMeasure('三里路'), b = normalizeMeasure('5里地'), c = normalizeMeasure('半日');
    return a.value === 3 && a.unit === '里' && a.raw === '三里路'
        && b.value === 5 && b.unit === '里'
        && c.value === 0.5 && c.unit === '日';
})(), J([normalizeMeasure('三里路'), normalizeMeasure('半日')]));
A('C2 **不猜**：复合数词 / 约数 / 比喻一律只留 `raw`（`value` 为 `null`）', (() => {
    const list = ['二十里', '约莫五里', '三步并作两步', '两个时辰', '走了五里地'];
    return list.every((x) => { const m = normalizeMeasure(x); return m && m.value === null && m.raw === x; });
})(), J(['二十里', '三步并作两步'].map(normalizeMeasure)));
A('C3 AI 直接给数值 / 单位时原样采用；非法数值 → `null`（不编）；空输入 → `null`', (() => {
    const g = normalizeMeasure({ value: 3, unit: '里', raw: '三里路' });
    const bad = normalizeMeasure({ value: -5, unit: '里' });       // 无 raw 且数值非法 → 整条视为「没有」
    const unitBad = normalizeMeasure({ value: 3, unit: '把' });   // 非白名单单位 → 不算可规整，但数值保留
    return g.value === 3 && g.unit === '里' && bad === null
        && unitBad.value === 3 && unitBad.unit === '' && normalizeMeasure('') === null;
})(), 'n/a');

// ---------- ④ 引用不进哈希 ----------
A('D1 **改引用不改内容哈希**（`sceneRef`/`parentId`/`evidence`）：场景改名 / 重挂父级不引发跨端抖动', (() => {
    const p1 = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's1', parentId: 'mp_a', desc: 'd' });
    const p2 = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's2', parentId: 'mp_b', desc: 'd' });
    const r1 = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true, evidence: { floor: 1 } });
    const r2 = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true, evidence: { floor: 99, atomId: 'z' } });
    return atomContentHash('maps', p1) === atomContentHash('maps', p2) && atomContentHash('maps', r1) === atomContentHash('maps', r2);
})(), 'n/a');
A('D2 改内容（名称 / 描述 / 度量 / 方向）**必须**改变内容哈希；两 kind 之间也不撞', (() => {
    const a = normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 's1' });
    const b = normalizeMap({ kind: 'place', level: 'room', name: '粮仓', sceneRef: 's1' });
    const r1 = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true, distance: { raw: '三里' } });
    const r2 = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true, distance: { raw: '五里' } });
    return atomContentHash('maps', a) !== atomContentHash('maps', b)
        && atomContentHash('maps', r1) !== atomContentHash('maps', r2)
        && atomContentHash('maps', a) !== atomContentHash('maps', r1);
})(), 'n/a');
A('D3 身份哈希为空（与 `currencies` 同口径）—— 避免「两条不同路径算出同一身份」互相误伤删除墓碑', (() => {
    const r1 = normalizeMap({ kind: 'route', fromId: 'a', toId: 'b', traversed: true });
    const r2 = normalizeMap({ kind: 'route', fromId: 'c', toId: 'd', traversed: true });
    return atomIdentityHash('maps', r1) === '' && atomIdentityHash('maps', r2) === '';
})(), 'n/a');
A('D4 瘦身往返**不改内容哈希**（与其它维度同款不变量）', (() => {
    const round = hydrateSlimEntry('maps', slimEntryForStorage('maps', room));
    return atomContentHash('maps', room) === atomContentHash('maps', round);
})(), 'n/a');

// ---------- ⑤ 路径自动分析（数-23 护栏） ----------
function bootMaps(scenes, maps) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    const st = emptyState();
    st.scenes = scenes || [];
    st.maps = maps || [];
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save: () => { } });
    setLastMessageId(1);
    return st;
}
const SCENES = [{ id: 'sc-1', name: '码头', pathArr: ['城', '码头'], pathStr: '城>码头', desc: '码头' }];

A('E1 走过 → 建一条带 `evidence` 的路径；**场所锚点按需自动生成**（Q2：独立锚点条目）', (() => {
    const st = bootMaps(SCENES, []);
    const stats = applyMapDelta(st, { maps: { add: [
        { 层级: 'room', 名称: '货仓', 所属场所: '码头', 描述: '堆木箱的旧仓房' },
        { 起点: '码头', 终点: '货仓', 距离: '三里路', 走过: true },
    ] } }, { floorStart: 10, floorEnd: 12 });
    const routes = st.maps.filter((m) => m.kind === 'route');
    return stats.places === 1 && stats.anchors === 1 && routes.length === 1
        && routes[0].traversed === true && routes[0].inferred === false
        && (routes[0].evidence || []).length === 1 && routes[0].evidence[0].floor === 12
        && routes[0].distance && routes[0].distance.value === 3;
})(), 'n/a');

A('E2 **未走过不建路径**（护栏①）：给了距离也不建，且如实计数 `untraversed`', (() => {
    const st = bootMaps(SCENES, []);
    const stats = applyMapDelta(st, { maps: { add: [
        { 层级: 'room', 名称: '货仓', 所属场所: '码头' },
        { 起点: '码头', 终点: '货仓', 距离: '三里路', 走过: false },
    ] } }, { floorEnd: 5 });
    return st.maps.filter((m) => m.kind === 'route').length === 0 && stats.untraversed === 1;
})(), 'n/a');

A('E3 **同一对地点只一条**（护栏③）：重复走过只更新 `evidence` 与更具体的度量，**不累加、不新增**', (() => {
    const st = bootMaps(SCENES, []);
    applyMapDelta(st, { maps: { add: [{ 层级: 'room', 名称: '货仓', 所属场所: '码头' }, { 起点: '码头', 终点: '货仓', 距离: '三里路', 走过: true }] } }, { floorEnd: 3 });
    const n1 = st.maps.filter((m) => m.kind === 'route').length;
    applyMapDelta(st, { maps: { update: [{ 起点: '货仓', 终点: '码头', 耗时: '半日', 走过: true }] } }, { floorEnd: 9 });
    const routes = st.maps.filter((m) => m.kind === 'route');
    return n1 === 1 && routes.length === 1                       // 方向反过来也是同一条（id 与方向无关）
        && (routes[0].evidence || []).length === 2               // 两次走过 → 两条证据（不重复同楼层）
        && routes[0].distance && routes[0].distance.raw === '三里路'   // 旧度量保留（新的更具体才覆盖）
        && routes[0].timeCost && routes[0].timeCost.value === 0.5;     // 新度量补上
})(), J((() => { const st = bootMaps(SCENES, []); applyMapDelta(st, { maps: { add: [{ 层级: 'room', 名称: '货仓', 所属场所: '码头' }, { 起点: '码头', 终点: '货仓', 走过: true }] } }, { floorEnd: 3 }); applyMapDelta(st, { maps: { update: [{ 起点: '货仓', 终点: '码头', 走过: true }] } }, { floorEnd: 9 }); return st.maps.filter((m) => m.kind === 'route')[0]; })()));

A('E4 场所 / 端点 / 上层解析不到 → **跳过并计数**（绝不凭空造场景，③「数据使用场所数据」）', (() => {
    const st = bootMaps(SCENES, []);
    const s1 = applyMapDelta(st, { maps: { add: [{ 层级: 'room', 名称: '货仓', 所属场所: '不存在的地方' }] } }, { floorEnd: 1 });
    const s2 = applyMapDelta(st, { maps: { add: [{ 起点: '码头', 终点: '不存在的地方', 走过: true }] } }, { floorEnd: 1 });
    return s1.unknownScene === 1 && s2.noEnds === 1 && st.maps.filter((m) => m.kind === 'place').length === 0;
})(), 'n/a');

A('E5 陈设的上层必须是**有效房间**（指不到 → 跳过并计 `unknownParent`）—— 避免孤悬的「木箱」', (() => {
    const st = bootMaps(SCENES, []);
    const s = applyMapDelta(st, { maps: { add: [{ 层级: 'fixture', 名称: '木箱', 所属场所: '码头', 上层: '并不存在的房间' }] } }, { floorEnd: 1 });
    return s.unknownParent === 1 && st.maps.filter((m) => m.kind === 'place' && m.level === 'fixture').length === 0;
})(), 'n/a');

A('E6 合法三级：房间挂锚点、陈设挂房间；树形派生视图正确（`mapTreeOf`）', (() => {
    const st = bootMaps(SCENES, []);
    applyMapDelta(st, { maps: { add: [
        { 层级: 'room', 名称: '货仓', 所属场所: '码头' },
        { 层级: 'room', 名称: '账房', 所属场所: '码头' },
        { 层级: 'fixture', 名称: '木箱', 所属场所: '码头', 上层: '货仓' },
    ] } }, { floorEnd: 2 });
    const t = mapTreeOf(st, 'sc-1');
    return t.scene && t.rooms.length === 2 && (t.fixturesOf[t.rooms.filter((r) => r.name === '货仓')[0].id] || []).length === 1 && t.orphans === 0;
})(), 'n/a');

A('E7 落库读数有一句人读文本（日志 / 注入自查共用同一形状）', (() => {
    const st = bootMaps(SCENES, []);
    const s = applyMapDelta(st, { maps: { add: [{ 层级: 'room', 名称: '货仓', 所属场所: '码头' }] } }, { floorEnd: 1 });
    return mapDeltaText(s).indexOf('单元 +1') >= 0;
})(), mapDeltaText({ places: 1, routes: 0, anchors: 1, untraversed: 0, noEnds: 0, unknownScene: 0, unknownParent: 0, orphanFixtures: 0, invalid: 0 }));

// ---------- ⑥ 从属注入（数-24） ----------
const host = makeHost({});
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const un = installGlobalHost(host, doc);
await import('../../index.js');

function bootInject(maps) {
    const st = bootMaps(SCENES, maps);
    st.atoms = [{ id: 'a1', title: '码头见闻', text: '角色甲在码头搬运木箱，登记入册。', date: '1919-11-29', tags: ['码头'], validity: 'active', floorEnd: 1 }];
    setKernelState(st);
    return st;
}
const MAPS_FULL = [
    normalizeMap({ kind: 'place', level: 'scene', name: '码头', sceneRef: 'sc-1' }),
    normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 'sc-1', parentId: mapPlaceId('scene', 'sc-1', '', '码头'), desc: '堆木箱的旧仓房' }),
    normalizeMap({ kind: 'route', fromId: mapPlaceId('scene', 'sc-1', '', '码头'), toId: mapPlaceId('room', 'sc-1', mapPlaceId('scene', 'sc-1', '', '码头'), '货仓'), traversed: true, distance: { value: 3, unit: '里', raw: '三里路' }, evidence: { floor: 3 } }),
];

/**
 * v3.50.6（用户报告「场景地图是图，不是列表」，`docs/D27` §8 `应-45`）：注入子块改为**网状图**形态
 *   —— ① 节点表（稳定编号 `N1…` + 层级 + 「属 Nx」）；② 连线表（`N1 →(度量) N2［走过 / 未走过（手填）］`）。
 *   断言据此更新（旧口径是「房间 / 路径」两串平铺列表）。
 */
A('F1 `mapInjectLines`：有数据才出行；**网状图**形态（节点表 + 连线表 + 走过标记 + 陈设）', (() => {
    const st = bootInject(MAPS_FULL);
    const lines = mapInjectLines(st, 'sc-1');
    const text = lines.join('\n');
    return lines.length >= 3 && text.indexOf('🗺 地图（网状图 · 节点 / 连线）') >= 0
        && text.indexOf('节点：N1 ') >= 0 && text.indexOf('（属 N') >= 0
        && text.indexOf('连线：') >= 0 && text.indexOf('→(') >= 0
        && text.indexOf('剧情走过') >= 0 && text.indexOf('三里路') >= 0;   // 该夹具无陈设（陈设行由 F3 之外的夹具覆盖）
})(), J(mapInjectLines(bootInject(MAPS_FULL), 'sc-1')));
A('F2 无地图数据 → 零行（场景小节照旧输出，**不因地图缺失而变化**）', (() => {
    const st = bootInject([]);
    return mapInjectLines(st, 'sc-1').length === 0 && mapInjectStats(st, ['sc-1']).scenes === 0;
})(), 'n/a');
A('F3 「按层限量」只裁**本次注入**、不动数据（节点上限）', (() => {
    const many = [];
    for (let i = 0; i < MAP_INJECT_MAX_ROOMS + 3; i++) many.push(normalizeMap({ kind: 'place', level: 'room', name: 'R' + i, sceneRef: 'sc-1' }));
    const st = bootInject(many);
    const before = st.maps.length;
    const lines = mapInjectLines(st, 'sc-1');
    const nodeLine = lines.filter((l) => l.indexOf('节点：') >= 0)[0] || '';
    // v3.50.6：节点表以「｜」分隔，上限 = MAP_INJECT_MAX_ROOMS + 1（含场景节点本身）
    return nodeLine.split('｜').length === MAP_INJECT_MAX_ROOMS + 1
        && lines.some((l) => l.indexOf('未展开') >= 0)
        && st.maps.length === before;                     // 数据未变
})(), 'n/a');

A('G1 注入体：**不新增 `[地图]` 小节**（地图只作为 `[场景地点]` 的子块出现），自查如实报出块数与行数', (() => {
    bootInject(MAPS_FULL);
    let d = null;
    try { d = buildMemoryBodyForInject('码头', { budget: 8000, diagnose: true }); } catch (e) { d = null; }
    const body = String((d && d.bodyText) || '');
    const mi = (d && d.mapInject) || null;
    return body.indexOf('地图') >= 0 && body.indexOf('[地图]') < 0 && body.indexOf('码头') >= 0
        && !!mi && mi.blocks >= 1 && mi.lines >= 3 && !mi.reason
        && (d.catHeads || []).indexOf('[场景地点]') >= 0
        && (d.catHeads || []).every((h) => h.indexOf('[地图]') < 0);
})(), 'n/a');
A('G2 场景**未入选**时地图也完全不出现（「禁止单独注入」的语义）+ 自查如实给出原因', (() => {
    bootInject(MAPS_FULL);
    let d = null;
    try { d = buildMemoryBodyForInject('这个查询词匹配不到任何场景', { budget: 8000, diagnose: true }); } catch (e) { d = null; }
    const body = String((d && d.bodyText) || '');
    const mi = (d && d.mapInject) || null;
    return body.indexOf('地图') < 0 && !!mi && mi.blocks === 0
        && String(mi.reason || '').indexOf('场景未入选') >= 0
        && (mi.units || 0) === 2;                       // 数据在，只是**不单独注入**
})(), 'n/a');
A('G3 注入自查读数如实带原因（`mapInjectStats`：单位数 / 路径数 / 命中场景数）', (() => {
    const st = bootInject(MAPS_FULL);
    const s = mapInjectStats(st, ['sc-1', 'sc-不存在']);
    return s.units === 2 && s.routes === 1 && s.scenes === 1 && s.lines >= 3;
})(), J(mapInjectStats(bootInject(MAPS_FULL), ['sc-1'])));
A('G4 预算紧张时**先丢地图、场景保留**（同一大类内地图行排在场景整块**之后**）', (() => {
    bootInject(MAPS_FULL);
    try {
        const src = readFileSync(join(ROOT, 'core', 'recall.js'), 'utf8');
        // v3.50.5（`应-40`）：该区块的行构建被包进 pushCat 的 thunk → 源码形态变为
        //   `() => ((sceneText ? [{ text: sceneText }] : []).concat(mapRows))`；语义（场景整块在前、地图行随后）不变。
        const i = src.indexOf('(sceneText ? [{ text: sceneText }] : []).concat(mapRows)');
        const after = src.indexOf('mapRows.push');
        return i > 0 && after > 0 && src.indexOf('pushCat(\'[场景地点]\'') > 0;
    } catch (e) { return false; }
})(), 'n/a');

un();
R.done();
