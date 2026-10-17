// ============================================================
// ui/scene-map-graph.js —— **场景地图的网状图渲染**（v3.50.6 落地 · v3.50.9 美化）
//
// 来源：`docs/D27` §8 `应-45`（网状图；`应-20` 的「分层关联网图」目标）+
//   用户 v3.50.9 要求「完善场景地图，优化展示样式和图展示样式，提高美化效果」。
//
// 设计（仍是**确定性纯函数**：无随机、无物理引擎、无时间依赖 → 可单测）：
//   · **整齐树布局（tidy layering）**：按层级分列（场景 0 / 房间 1 / 陈设 2）；
//     同一父节点的子节点**成组垂直居中**在其父节点旁 → 连线不交叉，不用力导向也好看；
//   · **节点宽度随文字自适应**（夹在 MIN_W..MAX_W），过长名称截断加「…」，不再溢出；
//   · **边 = 贝塞尔曲线**（水平出入、圆润转弯）+ **箭头 marker**（有向）；走过 = 绿实线，未走过 = 黄虚线；
//   · **边标签带底色小片**（压在曲线上也不糊）；从属关系 = 浅色虚线（父右 → 子左）；
//   · **层级配色**：场景 / 房间 / 陈设各有左侧色条 + 层级小标签；
//   · 悬空边（指向未知单元）**如实标红**，不静默吞掉、不伪造节点。
//
// 可点性保持不变：节点 `<g data-ftt-map-node="id">`、边 `data-ftt-map-edge="traversed|inferred"`
//   —— 复用面板既有动作分发（下钻 / 插入套话），**点击不写任何记忆数据**。
// 纯 `core/` 依赖（度量 / 状态文案单一事实源）+ 字符串拼接；不碰 DOM / 定时器（`ui/` 层）。
// ============================================================
import { mapRouteStatusText, mapRouteMeasureText } from '../core/model/map.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

/** 估算文本像素宽（中文按 1 字宽，其余按 0.55；SVG 里无测量 API → 用确定性估算法，测试可锁） */
export function mapTextWidth(s, fontSize) {
    const t = String(s == null ? '' : s);
    let w = 0;
    for (const ch of t) w += (ch.charCodeAt(0) > 0x2e80 ? 1.0 : 0.55);
    return w * num(fontSize || 12);
}

/** 截断到指定像素宽（追加「…」） */
function clipText(s, maxPx, fontSize) {
    const t = String(s == null ? '' : s);
    if (mapTextWidth(t, fontSize) <= maxPx) return t;
    let out = '';
    for (const ch of t) {
        if (mapTextWidth(out + ch + '…', fontSize) > maxPx) break;
        out += ch;
    }
    return out + '…';
}

/** 布局常量（确定性；单测直接断言这些几何） */
export const MAP_GRAPH = Object.freeze({
    minW: 96, maxW: 176, nodeH: 34, gapY: 12, layerX: 210, padX: 18, padY: 16,
    labelH: 18, legendH: 22, fontSize: 12, labelFont: 10.5,
});

/** 层级深度：场景 0 / 房间 1 / 陈设 2（缺 `level` 时退化为 1，保证不越界） */
function depthOf(place) {
    if (!place) return 1;
    if (place.level === 'scene') return 0;
    if (place.level === 'fixture') return 2;
    return 1;
}

/** 节点标签（层级中文） */
function levelLabel(level) {
    return level === 'scene' ? '场景' : (level === 'fixture' ? '陈设' : '房间');
}

/**
 * **纯布局 v2**（整齐分层 + 子节点成组居中 + 宽度自适应）。
 * @param {Array} places 空间单元（`kind==='place'`）
 * @param {Array} routes 路径（`kind==='route'`）
 * @returns {{nodes:Array,edges:Array,links:Array,width:number,height:number,byId:Object}}
 */
export function sceneMapGraphLayout(places, routes) {
    const G = MAP_GRAPH;
    const ps = (Array.isArray(places) ? places : []).filter((p) => p && p.id);
    const rs = (Array.isArray(routes) ? routes : []).filter((r) => r && r.id);
    const byId = {};

    // ① 节点（宽度随名称自适应；过长截断）
    const raw = ps.map((p) => {
        const name = String(p.name || '') || '（未命名）';
        const tag = levelLabel(String(p.level || ''));
        const wName = mapTextWidth(name, G.fontSize) + 30;
        const wTag = mapTextWidth(tag, G.labelFont) + 40;
        const w = Math.max(G.minW, Math.min(G.maxW, Math.ceil(Math.max(wName, wTag))));
        const node = {
            id: String(p.id), name: name, shownName: clipText(name, w - 42, G.fontSize), level: String(p.level || ''),
            levelText: tag, parentId: String(p.parentId || ''), desc: String(p.desc || ''),
            depth: depthOf(p), w: w, h: G.nodeH, x: 0, y: 0, subH: G.nodeH, subY: 0,
        };
        byId[node.id] = node;
        return node;
    });

    // ② 分层 + 成组居中（按输入顺序 → 确定性）
    const layers = [[], [], []];
    raw.forEach((n) => { layers[n.depth].push(n); });
    const childrenOf = (id) => raw.filter((n) => n.parentId && String(n.parentId) === String(id) && n.depth > (byId[String(id)] ? byId[String(id)].depth : -1));
    const roots = raw.filter((n) => !(n.parentId && byId[n.parentId]));

    /** 递归算子树高度：叶子 = 自身高；父 = 子块总高（父在其中居中）——间隔加在**兄弟之间** */
    const measure = (node) => {
        const kids = childrenOf(node.id);
        if (!kids.length) { node.subH = node.h; return node.h; }
        let total = 0;
        kids.forEach((k, i) => {
            const h = measure(k);
            k.subY = total;                       // 该子树的**块顶**相对父块
            total += h;
            if (i < kids.length - 1) total += G.gapY;
        });
        node.subH = Math.max(node.h, total);
        return node.subH;
    };
    let cursorY = 0;
    roots.forEach((r) => { const h = measure(r); r.subY = cursorY; cursorY += h + G.gapY * 2; });
    const settle = (node) => {
        const kids = childrenOf(node.id);
        if (!kids.length) return;
        const blockTop = node.y - (node.subH - node.h) / 2;
        kids.forEach((k) => { k.y = blockTop + k.subY; settle(k); });
    };
    roots.forEach((r) => { r.y = r.subY; settle(r); });
    // 未挂到任何根的（孤儿 / 环）按层兜底排布，绝不出图外
    const placed = {};
    const mark = (n) => { placed[n.id] = 1; childrenOf(n.id).forEach(mark); };
    roots.forEach(mark);
    let orphanY = cursorY;
    layers.forEach((list) => {
        list.forEach((n) => {
            if (placed[n.id]) return;
            n.y = orphanY; orphanY += n.h + G.gapY; placed[n.id] = 1;
        });
    });
    layers.forEach((list, d) => { list.forEach((n) => { n.x = G.padX + d * G.layerX; }); });
    const minY = Math.min.apply(null, raw.map((n) => n.y).concat([0]));
    raw.forEach((n) => { n.y = n.y - minY + G.padY; });

    // ③ 边（贝塞尔；父右出 / 子左入；同层走上下弧）
    const cx = (n) => n.x + n.w / 2, cy = (n) => n.y + n.h / 2;
    const edges = rs.map((r) => {
        const a = byId[String(r.fromId)] || null, b = byId[String(r.toId)] || null;
        const walked = r.traversed === true;
        const e = {
            id: String(r.id), fromId: String(r.fromId), toId: String(r.toId),
            fromName: a ? a.name : '（未知）', toName: b ? b.name : '（未知）',
            walked: walked, inferred: r.inferred === true, statusText: mapRouteStatusText(r),
            measure: mapRouteMeasureText(r), drawable: !!(a && b),
            x1: 0, y1: 0, x2: 0, y2: 0, d: '', lx: 0, ly: 0, lw: 0,
        };
        if (a && b) {
            const forward = (b.depth > a.depth) || (b.depth === a.depth && b.x >= a.x);
            e.x1 = forward ? a.x + a.w : cx(a); e.y1 = forward ? cy(a) : a.y + a.h;
            e.x2 = forward ? b.x : cx(b); e.y2 = forward ? cy(b) : b.y;
            const dx = Math.max(24, Math.abs(e.x2 - e.x1) * 0.45);
            e.d = forward
                ? ('M ' + e.x1 + ' ' + e.y1 + ' C ' + (e.x1 + dx) + ' ' + e.y1 + ', ' + (e.x2 - dx) + ' ' + e.y2 + ', ' + e.x2 + ' ' + e.y2)
                : ('M ' + e.x1 + ' ' + e.y1 + ' C ' + e.x1 + ' ' + (e.y1 + 30) + ', ' + e.x2 + ' ' + (e.y2 - 30) + ', ' + e.x2 + ' ' + e.y2);
            e.lx = (e.x1 + e.x2) / 2; e.ly = (e.y1 + e.y2) / 2;
            e.lw = Math.ceil(mapTextWidth(e.fromName + ' → ' + e.toName, G.labelFont)) + 14;
        }
        return e;
    });
    const links = raw.filter((n) => n.parentId && byId[n.parentId]).map((n) => {
        const p = byId[n.parentId];
        const dx = Math.max(16, (n.x - (p.x + p.w)) * 0.5);
        return {
            fromId: p.id, toId: n.id, x1: p.x + p.w, y1: cy(p), x2: n.x, y2: cy(n),
            d: 'M ' + (p.x + p.w) + ' ' + cy(p) + ' C ' + (p.x + p.w + dx) + ' ' + cy(p) + ', ' + (n.x - dx) + ' ' + cy(n) + ', ' + n.x + ' ' + cy(n),
        };
    });

    const width = G.padX * 2 + G.maxW + 2 * G.layerX;
    const maxY = Math.max.apply(null, raw.map((n) => n.y + n.h).concat([G.nodeH]));
    const maxLabelY = Math.max.apply(null, edges.filter((e) => e.drawable).map((e) => e.ly + 30).concat([0]));
    const height = Math.ceil(Math.max(maxY, maxLabelY) + G.padY + G.labelH + G.legendH);
    return { nodes: raw, edges: edges, links: links, width: width, height: height, byId: byId };
}

/**
 * 网状图 SVG（**只读**；节点带 `data-ftt-map-node`、边带 `data-ftt-map-edge` 以便复用既有点击分发）。
 * @param {Array} places · @param {Array} routes
 * @param {{title?:string, emptyHint?:string}} [opts]
 * @returns {string} 无节点时返回空串（由调用方给空态）
 */
export function sceneMapGraphSvg(places, routes, opts) {
    const o = opts || {};
    const L = sceneMapGraphLayout(places, routes);
    if (!L.nodes.length) return '';
    const G = MAP_GRAPH;
    // 确定性 id 前缀（同页多图不冲突；无随机 → 可单测/可复现）
    const uid = 'mg' + Math.abs(L.nodes.length * 31 + L.edges.length * 7 + Math.round(L.width));
    const parts = [];
    parts.push('<svg class="ftt-map-svg" viewBox="0 0 ' + L.width + ' ' + L.height + '" width="100%" height="' + L.height
        + '" role="img" aria-label="' + esc((o.title || '场景地图') + '：节点 ' + L.nodes.length + ' · 路径 ' + L.edges.length) + '" data-ftt-map-graph="1">');
    parts.push('<defs>'
        + '<marker id="' + uid + '-arrow-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ftt-map-arrow ftt-walked" d="M 0 0 L 10 5 L 0 10 z" /></marker>'
        + '<marker id="' + uid + '-arrow-i" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ftt-map-arrow ftt-inferred" d="M 0 0 L 10 5 L 0 10 z" /></marker>'
        + '<filter id="' + uid + '-soft" x="-20%" y="-40%" width="140%" height="180%"><feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-opacity="0.35" /></filter>'
        + '</defs>');
    if (o.title) parts.push('<text class="ftt-map-svg-title" x="' + G.padX + '" y="' + (L.height - 6) + '">' + esc(o.title) + '</text>');
    // 从属边（父右 → 子左；浅色虚线）
    L.links.forEach((l) => {
        parts.push('<path class="ftt-map-svg-link" d="' + l.d + '" fill="none" stroke-dasharray="3 4" />');
    });
    // 路径边（贝塞尔 + 箭头）+ 标签片（名称 / 度量两行）
    L.edges.forEach((e) => {
        if (!e.drawable) {
            parts.push('<text class="ftt-map-svg-elabel ftt-map-svg-dangling" x="' + G.padX + '" y="' + (L.height - 6) + '">⚠ 路径指向未知单元：'
                + esc(e.fromName) + ' → ' + esc(e.toName) + '</text>');
            return;
        }
        const cls = 'ftt-map-svg-edge' + (e.walked ? ' ftt-walked' : ' ftt-inferred');
        parts.push('<path class="' + cls + '" data-ftt-map-edge="' + (e.walked ? 'traversed' : 'inferred') + '" data-ftt-map-route="' + esc(e.id)
            + '" d="' + e.d + '" fill="none" marker-end="url(#' + uid + (e.walked ? '-arrow-w' : '-arrow-i') + ')"'
            + (e.walked ? '' : ' stroke-dasharray="6 4"') + ' />');
        parts.push('<g class="ftt-map-svg-chip">'
            + '<rect x="' + (e.lx - e.lw / 2) + '" y="' + (e.ly + 2) + '" width="' + e.lw + '" height="' + (G.labelH + 12) + '" rx="6" />'
            + '<text class="ftt-map-svg-elabel" x="' + e.lx + '" y="' + (e.ly + 14) + '">' + esc(e.fromName + ' → ' + e.toName) + '</text>'
            + '<text class="ftt-map-svg-esub" x="' + e.lx + '" y="' + (e.ly + 26) + '">' + esc(e.measure || '正文未给距离 / 耗时') + '</text>'
            + '</g>');
    });
    // 节点（卡片 + 左侧层级色条 + 名称 + 层级小标签；可点）
    L.nodes.forEach((n) => {
        parts.push('<g class="ftt-map-svg-node ftt-lv-' + esc(n.level || 'room') + '" data-ftt-map-node="' + esc(n.id) + '" filter="url(#' + uid + '-soft)">'
            + '<rect class="ftt-map-card" x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="8" />'
            + '<rect class="ftt-map-accent" x="' + n.x + '" y="' + (n.y + 5) + '" width="3" height="' + (n.h - 10) + '" rx="1.5" />'
            + '<text class="ftt-map-svg-nlabel" x="' + (n.x + 12) + '" y="' + (n.y + 21) + '">' + esc(n.shownName) + '</text>'
            + '<text class="ftt-map-svg-ntag" x="' + (n.x + n.w - 9) + '" y="' + (n.y + 21) + '" text-anchor="end">' + esc(n.levelText) + '</text>'
            + '</g>');
    });
    parts.push('</svg>');
    // 图例（走过 / 未走过 / 从属）+ 计数 + 操作提示
    const walked = L.edges.filter((e) => e.walked).length;
    parts.push('<div class="ftt-map-legend">'
        + '<span class="ftt-map-lg ftt-walked">━▶</span> 剧情走过（' + walked + '）'
        + '<span class="ftt-map-lg ftt-inferred ftt-ml-2">┄▶</span> 未走过（手填）（' + (L.edges.length - walked) + '）'
        + '<span class="ftt-map-lg ftt-map-lg-link ftt-ml-2">┈</span> 从属（属 Nx）'
        + '<span class="ftt-muted ftt-ml-2">· 点节点下钻 / 插入套话</span></div>');
    return parts.join('');
}
