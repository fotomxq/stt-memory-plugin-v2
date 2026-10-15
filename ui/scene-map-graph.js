// ============================================================
// ui/scene-map-graph.js —— **场景地图的网状图渲染**（v3.50.6，用户报告 + `docs/D27` §8 `应-45`）
//
// 用户原话：「场景地图是图，不是列表，请修正该问题。这个图建议采用网状图为主。」
//
// 口径（与 `docs/D27` §1.2 非目标 N2 不冲突 —— N2 禁的是**坐标图**）：
//   · **网状图（network）**：空间单元 = 节点，路径 = **有向边**，另有「属」的**从属边**（虚线，细）；
//   · **不是坐标地图**：没有瓦片 / 经纬 / 寻路几何 —— 布局只按「层级 + 序号」确定性地摆放（无物理引擎、无随机）；
//   · 走过 / 未走过**视觉可区分**（实线 + 实心头 / 虚线 + 空心头），与列表徽标的 `data-ftt-map-edge` 同口径；
//   · 节点可点：`<g data-ftt-map-node="id">` —— 复用面板既有动作分发（下钻 / 插入套话），**点击不写任何记忆数据**；
//   · **纯函数**：`sceneMapGraphLayout()` 只吃数据 → 出坐标（可单测锁定）；`sceneMapGraphSvg()` 只把布局串成 SVG 串。
//
// 落点理由（`docs/05` §5 C11 + 体量棘轮）：`ui/panel.js` 已贴上限 → 图形渲染整体落新模块。
// ============================================================

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

// 度量 / 状态文案**单一事实源**在核心（与列表行、注入子块共用，避免三处各写一套）
import { mapRouteStatusText, mapRouteMeasureText } from '../core/model/map.js';

/** 布局常量（确定性；单测直接断言这些几何） */
export const MAP_GRAPH = Object.freeze({
    nodeW: 118, nodeH: 30, gapY: 16, layerX: 190, padX: 16, padY: 14, labelH: 14,
});

/** 层级深度：场景 0 / 房间 1 / 陈设 2（`parentId` 缺失时退化为按 level 推断，保证不越界） */
function depthOf(place) {
    if (!place) return 0;
    if (place.level === 'scene') return 0;
    if (place.level === 'room') return 1;
    return 2;
}

/**
 * **纯布局**：空间单元 → 分层节点坐标；路径 → 有向边端点；`parentId` → 从属边。
 * @param {Array} places 空间单元（`kind==='place'`）
 * @param {Array} routes 路径（`kind==='route'`）
 * @returns {{nodes:Array,edges:Array,links:Array,width:number,height:number,byId:Object}}
 */
export function sceneMapGraphLayout(places, routes) {
    const ps = (Array.isArray(places) ? places : []).filter((p) => p && p.id);
    const rs = (Array.isArray(routes) ? routes : []).filter((r) => r && r.id);
    const G = MAP_GRAPH;
    const nodes = [];
    const byId = {};
    // 分层：每层的槽位按「父节点顺序 → 输入顺序」稳定排列（确定性：同数据必得同图）
    const layers = [[], [], []];
    ps.forEach((p) => { layers[Math.min(2, Math.max(0, depthOf(p)))].push(p); });
    layers.forEach((list, d) => {
        list.forEach((p, i) => {
            const node = {
                id: String(p.id), name: String(p.name || '') || '（未命名）', level: String(p.level || ''),
                parentId: String(p.parentId || ''), desc: String(p.desc || ''),
                depth: d, x: G.padX + d * G.layerX, y: G.padY + i * (G.nodeH + G.gapY), w: G.nodeW, h: G.nodeH,
            };
            nodes.push(node);
            byId[node.id] = node;
        });
    });
    const centerOf = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
    const edges = rs.map((r) => {
        const a = byId[String(r.fromId)] || null, b = byId[String(r.toId)] || null;
        const ca = a ? centerOf(a) : null, cb = b ? centerOf(b) : null;
        return {
            id: String(r.id), fromId: String(r.fromId), toId: String(r.toId),
            fromName: a ? a.name : '（未知）', toName: b ? b.name : '（未知）',
            // 走过 = `traversed`（剧情实际走过）；未走过 = `inferred`（手填）—— 与列表徽标同口径
            walked: r.traversed === true,
            inferred: r.inferred === true,
            statusText: mapRouteStatusText(r),
            measure: mapRouteMeasureText(r),
            drawable: !!(ca && cb), x1: ca ? ca.x : 0, y1: ca ? ca.y : 0, x2: cb ? cb.x : 0, y2: cb ? cb.y : 0,
        };
    });
    const links = nodes.filter((n) => n.parentId && byId[n.parentId]).map((n) => {
        const p = byId[n.parentId];
        return { fromId: p.id, toId: n.id, x1: p.x + p.w, y1: p.y + p.h / 2, x2: n.x, y2: n.y + n.h / 2 };
    });
    const width = G.padX * 2 + G.nodeW + 2 * G.layerX;
    const maxRows = Math.max(1, layers[0].length, layers[1].length, layers[2].length);
    const height = G.padY * 2 + maxRows * (G.nodeH + G.gapY) + G.labelH;
    return { nodes: nodes, edges: edges, links: links, width: width, height: height, byId: byId };
}

/**
 * 网状图 SVG（**只读**；节点带 `data-ftt-map-node` 以便复用既有点击分发）。
 * @param {Array} places · @param {Array} routes
 * @param {{title?:string,emptyHint?:string}} [opts]
 * @returns {string} 无节点时返回空串（由调用方给空态）
 */
export function sceneMapGraphSvg(places, routes, opts) {
    const o = opts || {};
    const L = sceneMapGraphLayout(places, routes);
    if (!L.nodes.length) return '';
    const G = MAP_GRAPH;
    const parts = [];
    parts.push('<svg class="ftt-map-svg" viewBox="0 0 ' + L.width + ' ' + L.height + '" width="100%" height="' + L.height
        + '" role="img" aria-label="' + esc((o.title || '场景地图') + '：节点 ' + L.nodes.length + ' · 路径 ' + L.edges.length) + '" data-ftt-map-graph="1">');
    if (o.title) parts.push('<text class="ftt-map-svg-title" x="' + G.padX + '" y="' + (L.height - 4) + '">' + esc(o.title) + '</text>');
    // 从属边（「属」——细虚线，先画，压在节点下）
    L.links.forEach((l) => {
        parts.push('<line class="ftt-map-svg-link" x1="' + l.x1 + '" y1="' + l.y1 + '" x2="' + l.x2 + '" y2="' + l.y2 + '" stroke-dasharray="2 3" />');
    });
    // 路径边（有向；走过实线、未走过虚线）+ 度量标签
    L.edges.forEach((e) => {
        const cls = 'ftt-map-svg-edge' + (e.walked ? ' ftt-walked' : ' ftt-inferred');
        if (e.drawable) {
            const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
            parts.push('<line class="' + cls + '" data-ftt-map-edge="' + (e.walked ? 'traversed' : 'inferred') + '" data-ftt-map-route="' + esc(e.id)
                + '" x1="' + e.x1 + '" y1="' + e.y1 + '" x2="' + e.x2 + '" y2="' + e.y2 + '"'
                + (e.walked ? '' : ' stroke-dasharray="5 4"') + ' />');
            const li = [e.fromName + ' → ' + e.toName, e.measure || '正文未给距离 / 耗时'].join(' · ');
            parts.push('<text class="ftt-map-svg-elabel" x="' + mx + '" y="' + (my - 3) + '">' + esc(li) + '</text>');
        } else {
            // 端点缺失（数据脏）：如实画出为「悬空边」，不静默吞掉
            parts.push('<text class="ftt-map-svg-elabel ftt-map-svg-dangling" x="' + G.padX + '" y="' + (L.height - 4) + '">⚠ 路径指向未知单元：'
                + esc(e.fromName) + ' → ' + esc(e.toName) + '</text>');
        }
    });
    // 节点
    L.nodes.forEach((n) => {
        const lv = n.level === 'scene' ? '场景' : (n.level === 'fixture' ? '陈设' : '房间');
        parts.push('<g class="ftt-map-svg-node ftt-lv-' + esc(n.level || 'room') + '" data-ftt-map-node="' + esc(n.id) + '">'
            + '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="6" />'
            + '<text class="ftt-map-svg-nlabel" x="' + (n.x + 10) + '" y="' + (n.y + 19) + '">' + esc(n.name) + '</text>'
            + '<text class="ftt-map-svg-ntag" x="' + (n.x + n.w - 10) + '" y="' + (n.y + 19) + '" text-anchor="end">' + lv + '</text>'
            + '</g>');
    });
    parts.push('</svg>');
    // 图例（走过 / 未走过 / 从属）
    parts.push('<div class="ftt-map-legend"><span class="ftt-map-lg ftt-walked">━</span> 剧情走过'
        + '<span class="ftt-map-lg ftt-inferred ftt-ml-2">┄</span> 未走过（手填）'
        + '<span class="ftt-map-lg ftt-map-svg-link ftt-ml-2">┈</span> 从属（属 Nx）</div>');
    return parts.join('');
}
