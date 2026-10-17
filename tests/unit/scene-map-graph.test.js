// ============================================================
// 单元测试 · v3.50.6「场景地图是**网状图**，不是列表」（用户报告 + `docs/D27` §8 `应-45`）
//
// 用户原话：「场景地图是图，不是列表，请修正该问题。这个图建议采用网状图为主。」
//
// 本档锁两件事：
//   ① **布局是纯函数且确定**（`ui/scene-map-graph.js#sceneMapGraphLayout`）：节点 = 空间单元、边 = 路径、
//      从属边 = `parentId`；同数据必得同坐标（无随机 / 无物理引擎 / 无时间依赖）；
//   ② **渲染出的就是网状图**（`#sceneMapGraphSvg`）：`<svg data-ftt-map-graph>` + 每个节点一个可点的
//      `<g data-ftt-map-node>` + 每条路径一条 `data-ftt-map-edge`（走过实线 / 未走过虚线）+ 图例；
//      并且**不是坐标地图** —— 不出现瓦片 / 经纬 / 寻路等词汇。
//
// 运行：node tests/unit/scene-map-graph.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { normalizeMap } from '../../core/model/map.js';
import { sceneMapGraphLayout, sceneMapGraphSvg, MAP_GRAPH, mapTextWidth } from '../../ui/scene-map-graph.js';

const R = makeReporter('scene-map-graph v3.50.6：地图以网状图为主视图（`docs/D27` §8 `应-45`）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

/** 夹具：1 场景 + 2 房间（其一带陈设）+ 3 条路径（两走过、一未走过手填） */
function fixture() {
    const places = [
        normalizeMap({ id: 'p-scene', kind: 'place', level: 'scene', name: '码头', sceneRef: 'sc-1' }),
        normalizeMap({ id: 'p-room1', kind: 'place', level: 'room', name: '货仓', parentId: 'p-scene', sceneRef: 'sc-1' }),
        normalizeMap({ id: 'p-room2', kind: 'place', level: 'room', name: '暗室', parentId: 'p-room1', sceneRef: 'sc-1' }),
        normalizeMap({ id: 'p-fx1', kind: 'place', level: 'fixture', name: '木箱', parentId: 'p-room1', sceneRef: 'sc-1' }),
    ];
    const routes = [
        normalizeMap({ id: 'r1', kind: 'route', fromId: 'p-scene', toId: 'p-room1', traversed: true, distance: { raw: '三里路' }, sceneRef: 'sc-1' }),
        normalizeMap({ id: 'r2', kind: 'route', fromId: 'p-room1', toId: 'p-room2', traversed: true, timeCost: { raw: '半刻' }, sceneRef: 'sc-1' }),
        normalizeMap({ id: 'r3', kind: 'route', fromId: 'p-room2', toId: 'p-scene', inferred: true, sceneRef: 'sc-1' }),
    ];
    return { places: places, routes: routes };
}

// ---------- A 组：布局（纯函数 / 确定性） ----------
A('A1 节点 = 空间单元（数量 / 名称 / 层级），按层级分列：场景 0 / 房间 1 / 陈设 2', (() => {
    const f = fixture();
    const L = sceneMapGraphLayout(f.places, f.routes);
    const lv = {};
    L.nodes.forEach((n) => { lv[n.level] = (lv[n.level] || 0) + 1; });
    const scene = L.nodes.filter((n) => n.id === 'p-scene')[0];
    const room1 = L.nodes.filter((n) => n.id === 'p-room1')[0];
    const fx1 = L.nodes.filter((n) => n.id === 'p-fx1')[0];
    return L.nodes.length === 4 && lv.scene === 1 && lv.room === 2 && lv.fixture === 1
        && scene.depth === 0 && room1.depth === 1 && fx1.depth === 2
        && scene.x < room1.x && room1.x < fx1.x
        && scene.name === '码头' && room1.name === '货仓';
})(), () => sceneMapGraphLayout(fixture().places, fixture().routes).nodes);

/**
 * v3.50.9（用户要求「优化展示样式和图展示样式」）：边由「中心直连 `<line>`」升级为
 *   **节点边框出入点 + 贝塞尔曲线**（父右出 / 子左入），端点落在边框上、路径可圆润转弯。
 */
A('A2 边 = 路径（数量 / 有向端点落在**节点边框**上 / 贝塞尔路径 / 走过标记 / 度量文本）', (() => {
    const f = fixture();
    const L = sceneMapGraphLayout(f.places, f.routes);
    const r1 = L.edges.filter((e) => e.id === 'r1')[0];
    const r3 = L.edges.filter((e) => e.id === 'r3')[0];
    const a = L.byId['p-scene'], b = L.byId['p-room1'];
    return L.edges.length === 3 && L.edges.every((e) => e.drawable)
        && r1.walked === true && r3.walked === false
        && r1.x1 === a.x + a.w && r1.y1 === a.y + a.h / 2            // 父：右边界中点
        && r1.x2 === b.x && r1.y2 === b.y + b.h / 2                  // 子：左边界中点
        && r1.d.indexOf('M ') === 0 && r1.d.indexOf('C ') > 0         // 贝塞尔
        && Number(r1.lw) > 0 && r1.lx > 0 && r1.ly > 0               // 标签片尺寸/位置
        && r1.measure.indexOf('三里路') >= 0 && r3.inferred === true && r3.statusText.indexOf('未走过') >= 0;
})(), () => sceneMapGraphLayout(fixture().places, fixture().routes).edges);

A('A3 从属边 = `parentId`（只连到**存在**的父节点；悬空 parentId 不画，也不编造节点）', (() => {
    const f = fixture();
    f.places.push(normalizeMap({ id: 'p-orphan', kind: 'place', level: 'fixture', name: '孤儿', parentId: 'nope', sceneRef: 'sc-1' }));
    const L = sceneMapGraphLayout(f.places, f.routes);
    return L.links.length === 3 && L.links.every((l) => L.byId[l.fromId] && L.byId[l.toId])
        && L.links.filter((l) => l.toId === 'p-orphan').length === 0;
})(), () => sceneMapGraphLayout(fixture().places, fixture().routes).links);

A('A4 **确定性**：同一份数据连续布局两次 → 坐标 / 尺寸**逐字段相同**（无随机、无时间依赖）', (() => {
    const f = fixture();
    return J(sceneMapGraphLayout(f.places, f.routes)) === J(sceneMapGraphLayout(f.places, f.routes));
})(), 'n/a');

A('A5 尺寸随行数增长（不重叠）：每个节点高度固定、行距固定 → 同一层内 y 严格递增且间隔 ≥ 节点高', (() => {
    const places = [];
    for (let i = 0; i < 5; i++) places.push(normalizeMap({ id: 'p' + i, kind: 'place', level: 'room', name: 'R' + i, sceneRef: 'sc-1' }));
    const L = sceneMapGraphLayout(places, []);
    const ys = L.nodes.map((n) => n.y);
    let ok = true;
    for (let i = 1; i < ys.length; i++) if (!(ys[i] - ys[i - 1] >= MAP_GRAPH.nodeH)) ok = false;
    return ok && L.height > MAP_GRAPH.nodeH * 5;
})(), () => sceneMapGraphLayout(fixture().places, fixture().routes).height);

// ---------- B 组：渲染（网图为主视图 / 可点 / 图例 / 不是坐标图） ----------
A('B1 SVG 容器带 `data-ftt-map-graph` + viewBox + aria 标签（无障碍）', (() => {
    const f = fixture();
    const s = sceneMapGraphSvg(f.places, f.routes, { title: '网状图' });
    return s.indexOf('<svg') >= 0 && s.indexOf('data-ftt-map-graph="1"') >= 0
        && s.indexOf('viewBox="0 0 ') >= 0 && s.indexOf('role="img"') >= 0 && s.indexOf('aria-label="') >= 0;
})(), () => sceneMapGraphSvg(fixture().places, fixture().routes, {}).slice(0, 160));

A('B2 **每个空间单元一个可点节点**（`<g data-ftt-map-node="id">` + 名称 + 层级标签）', (() => {
    const f = fixture();
    const s = sceneMapGraphSvg(f.places, f.routes, {});
    const ids = f.places.map((p) => p.id);
    return ids.every((id) => s.indexOf('data-ftt-map-node="' + id + '"') >= 0)
        && s.indexOf('>码头<') >= 0 && s.indexOf('>货仓<') >= 0
        && s.indexOf('>场景<') >= 0 && s.indexOf('>陈设<') >= 0;
})(), 'n/a');

A('B3 **每条路径一条有向边（贝塞尔 + 箭头 marker）**：走过 = 实线、未走过 = 虚线；边带度量标签片', (() => {
    const f = fixture();
    const s = sceneMapGraphSvg(f.places, f.routes, {});
    const edges = s.split('<path class="ftt-map-svg-edge').slice(1);
    const walked = edges.filter((e) => e.indexOf('data-ftt-map-edge="traversed"') >= 0);
    const inferred = edges.filter((e) => e.indexOf('data-ftt-map-edge="inferred"') >= 0);
    return edges.length === 3 && walked.length === 2 && inferred.length === 1
        && walked.every((e) => e.indexOf('stroke-dasharray') < 0)
        && inferred.every((e) => e.indexOf('stroke-dasharray') >= 0)
        && edges.every((e) => e.indexOf('marker-end="url(#') >= 0)      // 箭头：有向
        && s.indexOf('<marker') >= 0 && s.indexOf('ftt-map-arrow') >= 0
        && s.indexOf('ftt-map-svg-chip') >= 0
        && s.indexOf('三里路') >= 0 && s.indexOf('半刻') >= 0;
})(), 'n/a');

A('B4 图例说明三种线（走过 / 未走过 / 从属），且**不是坐标地图**：不出现瓦片 / 经纬 / 寻路词汇', (() => {
    const f = fixture();
    const s = sceneMapGraphSvg(f.places, f.routes, {});
    return s.indexOf('ftt-map-legend') >= 0 && s.indexOf('剧情走过') >= 0 && s.indexOf('未走过（手填）') >= 0
        && s.indexOf('从属（属 Nx）') >= 0
        && ['瓦片', '经纬', 'canvas', '寻路', 'lat="', 'lng="'].every((w) => s.indexOf(w) < 0);
})(), 'n/a');

A('B5 **悬空边如实标出**（路径指向未知单元 → 红字提示，不静默吞掉、不伪造节点）', (() => {
    const f = fixture();
    f.routes.push(normalizeMap({ id: 'r9', kind: 'route', fromId: 'p-room1', toId: 'ghost', traversed: true, sceneRef: 'sc-1' }));
    const L = sceneMapGraphLayout(f.places, f.routes);
    const s = sceneMapGraphSvg(f.places, f.routes, {});
    const bad = L.edges.filter((e) => e.id === 'r9')[0];
    return bad && bad.drawable === false && s.indexOf('⚠ 路径指向未知单元') >= 0;
})(), 'n/a');

A('B6 空数据 → 返回空串（由调用方渲染空态，不画一个空网图）', (() => {
    return sceneMapGraphSvg([], [], {}) === '' && sceneMapGraphSvg(null, null, {}) === '';
})(), 'n/a');

A('B7 转义：名称里的 HTML 元字符被转义（不注入标记）', (() => {
    const places = [normalizeMap({ id: 'p-x', kind: 'place', level: 'scene', name: '<img src=x onerror=alert(1)>', sceneRef: 'sc-1' })];
    const s = sceneMapGraphSvg(places, [], {});
    return s.indexOf('<img') < 0 && s.indexOf('&lt;img') >= 0;
})(), 'n/a');

// ---------- C 组（v3.50.9）：美化特性 ----------
A('C1 **节点宽度随文字自适应**（夹在 minW..maxW）：长名称变宽、极短名称取 minW；过长名称**截断加「…」**不溢出', (() => {
    const mk = (id, name) => normalizeMap({ id: id, kind: 'place', level: 'room', name: name, sceneRef: 'sc-1' });
    const L = sceneMapGraphLayout([mk('a', '短'), mk('b', '这是一个非常非常长的房间名称用来测试截断'), mk('c', '中等长度的房间名')], []);
    const a = L.byId['a'], b = L.byId['b'], c = L.byId['c'];
    return a.w === MAP_GRAPH.minW && b.w === MAP_GRAPH.maxW && c.w > a.w && c.w < b.w
        && b.shownName.indexOf('…') >= 0 && mapTextWidth(b.shownName, MAP_GRAPH.fontSize) <= b.w - 40;
})(), () => sceneMapGraphLayout([normalizeMap({ id: 'x', kind: 'place', level: 'room', name: '这是一个非常非常长的房间名称用来测试截断', sceneRef: 'sc-1' })], []).nodes[0]);

A('C2 **整齐树**：同一父节点的多个子节点**成组垂直居中**在父节点旁（父 y ≈ 子块中心；兄弟间不重叠）', (() => {
    const ps = [normalizeMap({ id: 'p', kind: 'place', level: 'scene', name: '码头', sceneRef: 'sc-1' })];
    ['r1', 'r2', 'r3'].forEach((id, i) => ps.push(normalizeMap({ id: id, kind: 'place', level: 'room', name: '房' + (i + 1), parentId: 'p', sceneRef: 'sc-1' })));
    const L = sceneMapGraphLayout(ps, []);
    const p = L.byId['p'], kids = ['r1', 'r2', 'r3'].map((id) => L.byId[id]);
    const center = (p.y + p.h / 2), band = (kids[0].y + kids[2].y + kids[2].h) / 2;
    const noOverlap = kids.every((k, i) => i === 0 || k.y >= kids[i - 1].y + kids[i - 1].h);
    return Math.abs(center - band) <= 1.5 && noOverlap && kids.every((k) => k.x > p.x);
})(), () => J(sceneMapGraphLayout(fixture().places, []).nodes.map((n) => ({ id: n.id, y: n.y }))));

A('C3 **视觉分件齐备**：defs（箭头 ×2 + 阴影滤镜）· 层级色条 · 卡片圆角 · 图例含计数与「点节点」提示', (() => {
    const f = fixture();
    const s = sceneMapGraphSvg(f.places, f.routes, { title: '网状图' });
    return s.indexOf('<defs>') >= 0 && s.indexOf('-arrow-w') >= 0 && s.indexOf('-arrow-i') >= 0 && s.indexOf('feDropShadow') >= 0
        && (s.match(/ftt-map-accent/g) || []).length === f.places.length
        && s.indexOf('ftt-map-card') >= 0 && s.indexOf('rx="8"') >= 0
        && s.indexOf('剧情走过（2）') >= 0 && s.indexOf('未走过（手填）（1）') >= 0
        && s.indexOf('点节点下钻 / 插入套话') >= 0
        && s.indexOf('ftt-lv-scene') >= 0 && s.indexOf('ftt-lv-room') >= 0 && s.indexOf('ftt-lv-fixture') >= 0;
})(), 'n/a');

A('C4 **可复现**：同一份数据两次渲染**逐字节相同**（id 前缀确定、无随机、无时间依赖）', (() => {
    const f = fixture();
    return sceneMapGraphSvg(f.places, f.routes, { title: 'T' }) === sceneMapGraphSvg(f.places, f.routes, { title: 'T' });
})(), 'n/a');

R.done();
