// ============================================================
// ui/scene-map.js —— **场景页「🗺 地图」子页：分层关联网图 + 三级穿透 + 点击插套话**
//   （v3.47.0，`docs/D22` W16 `应-20` / `应-21`；设计 `docs/D27` §3.6 ④ / §3.7 ①⑤）
//
// 口径（逐条对应设计稿）：
//   · **不新开面板分页**（Q3）：作为**场景页的双子标签**（场景 | 地图）—— 面板分页数仍 13；
//   · **分层关联网图**：空间单元为点、路径为边，按 `level` 分层展开；**不做坐标 / 瓦片 / 寻路几何**（N2）；
//   · **走过 / 未走过视觉可区分**（§3.7）：`traversed` 用实线标记「剧情走过」，`inferred` 标「未走过（手填）」；
//   · **三级穿透**：点场所 → 展开房间 → 再展开陈设；每层可回退（面包屑）；
//   · **只读优先**（Q6）：首版只读展示 + 点击插套话，**不改任何记忆数据**；
//   · **点击不写数据**（§3.6）：只把套话插进**用户输入框尾部**（`host/input-box.js`，能力探测 + 降级链：
//     宿主输入框 → 剪贴板 → 面板内可复制文本），**绝不覆盖既有输入**，失败**如实说明原因**；
//   · **上限可见**（§3.7）：显示「单元 N / 路径 M」与各自存储上限。
//
// 落点理由（`docs/05` §5 **C11** + 体量棘轮）：`ui/panel.js` 已贴上限，故本功能整体落新模块，
//   面板只留「子标签切换 + 子页渲染 + 动作分发」三处接线。
// ============================================================
import { MAP_LEVEL_LABELS, mapPlaces, mapRoutes, mapTreeOf, mapsOf, mapRouteStatusText, mapRouteMeasureText } from '../core/model/map.js';
// v3.50.6（用户报告「场景地图是图，不是列表」+ `docs/D27` §8 `应-45`）：网状图渲染落**新模块**（C11 + 体量棘轮）
import { sceneMapGraphSvg } from './scene-map-graph.js';
import { insertTextToHost, inputBoxCapability } from '../host/input-box.js';
import { state, cfg } from '../core/model/runtime.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

/** 本模块接管的动作（`ui/panel.js` 只按这张表分发） */
export const SCENE_MAP_ACTIONS = Object.freeze(['mapSub', 'mapOpen', 'mapBack', 'mapRoot', 'mapInsert']);

/** 子页态：`scene`（场景树，V1 原样）| `map`（地图网图） */
let sub = 'scene';
/** 当前下钻到的**场所**（`scenes` 条目 id；空 = 场所列表） */
let openScene = '';
/** 当前下钻到的**房间**（`place` id；空 = 只展开到房间层） */
let openRoom = '';
/** 最近一次插入的结果（供界面如实回显原因） */
let lastInsert = null;

/** 状态快照（面板 / 调试 / 测试用；只读） */
export function sceneMapState() {
    return {
        sub: sub, openScene: openScene, openRoom: openRoom,
        lastInsert: lastInsert ? Object.assign({}, lastInsert) : null,
        cap: mapCap(),
    };
}
/** 子页切换（'scene' | 'map'） */
export function setSceneMapSub(k) { sub = (String(k) === 'map') ? 'map' : 'scene'; return sub; }
/** 子页读数 */
export function sceneMapSub() { return sub; }
/** 回到上一层（陈设 → 房间 → 场所列表） */
export function sceneMapBack() {
    if (openRoom) { openRoom = ''; return 'rooms'; }
    if (openScene) { openScene = ''; return 'scenes'; }
    return 'root';
}
/** 重置到根（切页 / 数据重载后调用） */
export function resetSceneMapNav() { openScene = ''; openRoom = ''; return true; }
/** 清掉上次插入回显（切页时用） */
export function clearSceneMapInsert() { lastInsert = null; return true; }

/** 存储上限读数（「单元 N / 路径 M 与各自上限」；取有效上限口径 `storeCapFor`，取不到就回落 cfg） */
function mapCap() {
    try {
        const total = Number(cfg && cfg.storeTotalMax) || 0;
        const share = Number(cfg && cfg.storeShare && cfg.storeShare.maps) || 0;
        const fromShare = (total > 0 && share > 0) ? Math.round(total * share / 100) : 0;
        const fallback = Number(cfg && cfg.storeMaxMaps) || 0;
        return { total: total, share: share, cap: fromShare || fallback };
    } catch (e) { return { total: 0, share: 0, cap: 0 }; }
}

/** 套话文案（可配置：占位符见 `core/config.js#mapTrailPhrase`） */
export function trailPhraseOf(place, room) {
    try {
        const tpl = String((cfg && cfg.mapTrailPhrase) || '前往{path}');
        const placeName = String((place && place.name) || '');
        const roomName = String((room && room.name) || '');
        const path = [placeName, roomName].filter(Boolean).join(' > ');
        return tpl.replace(/\{path\}/g, path).replace(/\{place\}/g, placeName).replace(/\{room\}/g, roomName);
    } catch (e) { return ''; }
}

// ==================== 渲染 ====================

/** 场景页双子标签（与「情节 / 分段总结」同款：锚点 + `data-ftt-*`） */
export function sceneMapTabsHtml(cur) {
    const c = String(cur || 'scene');
    const n = mapsOf(state).length;
    return '<div class="ftt-row ftt-subtabs" data-ftt-scene-tabs>'
        + '<a href="javascript:void(0)" class="ftt-subtab' + (c === 'scene' ? ' ftt-on' : '') + '" data-ftt-mapsub="scene">🌳 场景（' + ((state.scenes || []).length) + '）</a>'
        + '<a href="javascript:void(0)" class="ftt-subtab' + (c === 'map' ? ' ftt-on' : '') + '" data-ftt-mapsub="map" title="在场景之下做空间结构化：房间 / 陈设 + 地点之间的路径（只读网图 + 点击插套话）">🗺 地图（' + n + '）</a>'
        + '<span class="ftt-hint ftt-ml-2">地图从属注入：只有场景入选时才跟着进提示词，<b>不单独注入</b>；点击只插文本、不写数据</span></div>';
}

/** 空态（两段式：为什么空 + 下一步做什么，`docs/D9` §10 U3） */
function emptyHtml() {
    return '<div class="ftt-empty">还没有任何地图数据。地图由「AI 摘要」从正文抽取 —— '
        + '只有当剧情<b>明确走过</b>某条路时才会记下距离 / 耗时；正文没写就留空，<b>绝不估算</b>。'
        + '房间 / 陈设同理：正文提到具体房间才会出现。</div>';
}

/** 面包屑（三级穿透的回退出口） */
function breadcrumbHtml() {
    if (!openScene) return '';
    const scene = (state.scenes || []).filter((s) => s && String(s.id) === String(openScene))[0] || null;
    const rooms = mapPlaces(state, { sceneRef: openScene }).filter((p) => p.level === 'room');
    const room = openRoom ? (rooms.filter((r) => String(r.id) === String(openRoom))[0] || null) : null;
    const crumb = (label, act, kind) => '<a href="javascript:void(0)" class="ftt-subtab" data-ftt-action="' + act + '" data-kind="' + esc(kind || '') + '">' + esc(label) + '</a>';
    return '<div class="ftt-row ftt-filterbar ftt-map-crumbs">'
        + crumb('🗺 全部场所', 'mapRoot', '')
        + '<span class="ftt-map-sep">›</span>'
        + (room ? crumb(String(scene ? scene.name : '场所'), 'mapOpen', 'scene') : '<b class="ftt-map-cur">' + esc(String(scene ? scene.name : '场所')) + '</b>')
        + (room ? ('<span class="ftt-map-sep">›</span><b class="ftt-map-cur">' + esc(String(room.name || '')) + '</b>') : '')
        + '<button class="ftt-btn ftt-sm" data-ftt-action="mapBack" title="回上一层">← 返回</button>'
        + '</div>';
}

/** 一个空间单元行（点「🗺 前往」插套话；房间可继续下钻） */
function placeRowHtml(place, sceneAnchor, opts) {
    const o = opts || {};
    const id = String(place.id || '');
    const isRoom = place.level === 'room';
    const fs = (o.fixturesOf && o.fixturesOf[id]) || [];
    const canDrill = isRoom && fs.length > 0;
    const ops = '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="mapInsert" data-map-place="' + esc(id) + '" data-map-scene="' + esc(String(sceneAnchor && sceneAnchor.id)) + '" title="把「' + esc(trailPhraseOf(sceneAnchor, place)) + '」插到用户输入框尾部（只追加，不覆盖既有输入）">🗺 前往</button>'
        + (canDrill ? ('<button class="ftt-btn ftt-sm" data-ftt-action="mapOpen" data-kind="room" data-map-place="' + esc(id) + '" title="展开房间内的陈设">🔍 陈设（' + fs.length + '）</button>') : '');
    return '<div class="ftt-item ftt-inline" data-ftt-map-node="' + esc(id) + '">'
        + '<span class="ftt-grow"><b>' + esc(MAP_LEVEL_LABELS[place.level] || place.level) + '：' + esc(String(place.name || '')) + '</b>'
        + (place.desc ? (' <span class="ftt-muted">：' + esc(String(place.desc)) + '</span>') : '')
        + (place.aliases && place.aliases.length ? (' <span class="ftt-muted">（别名 ' + esc(place.aliases.join('、')) + '）</span>') : '')
        + '</span>' + ops + '</div>';
}

/** 一条路径行（走过 / 未走过**视觉可区分**：`ftt-ok` vs `ftt-muted`） */
function routeRowHtml(route, byId, sceneAnchor) {
    const nm = (id) => String((byId[String(id)] || {}).name || '（未知场所）');
    const walked = route.traversed === true;
    const measure = mapRouteMeasureText(route);
    const badge = '<span class="ftt-badge' + (walked ? ' ftt-ok' : '') + '" data-ftt-map-edge="' + (walked ? 'traversed' : 'inferred') + '">'
        + esc(mapRouteStatusText(route)) + '</span>';
    const ev = (route.evidence || []).length ? (' <span class="ftt-muted">· 证据 ' + esc((route.evidence || []).map((e) => ('第 ' + num(e.floor) + ' 楼')).join('、')) + '</span>') : '';
    const dirTxt = route.direction === 'both' ? '' : ('（单向：' + esc(route.direction === 'a-to-b' ? '起点→终点' : '终点→起点') + '）');
    return '<div class="ftt-item ftt-inline" data-ftt-map-route="' + esc(String(route.id)) + '">'
        + '<span class="ftt-grow">' + esc(nm(route.fromId)) + ' <b>' + (walked ? '——' : '┄┄') + '</b> ' + esc(nm(route.toId))
        + (measure ? (' <span class="ftt-muted">（' + esc(measure) + '）</span>') : ' <span class="ftt-muted">（正文未给距离 / 耗时）</span>')
        + ' ' + badge + dirTxt + ev + '</span>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="mapInsert" data-map-route="' + esc(String(route.id)) + '" data-map-scene="' + esc(String(sceneAnchor && sceneAnchor.id)) + '" title="把「' + esc(trailPhraseOf(byId[String(route.toId)] || null, null)) + '」插到用户输入框尾部">🗺 前往</button>'
        + '</div>';
}

/**
 * 地图子页正文（只读网图 + 三级穿透 + 点击插套话）。
 * @returns {string} HTML
 */
export function sceneMapBodyHtml() {
    let places = [], routes = [];
    try { places = mapsOf(state).filter((m) => m && m.kind === 'place'); routes = mapsOf(state).filter((m) => m && m.kind === 'route'); } catch (e) { places = []; routes = []; }
    const cap = mapCap();
    /**
     * v3.50.9（用户要求「优化展示样式和图展示样式，提高美化效果」）：顶部改为**统计胶囊行** ——
     *   单元 / 路径 / 走过 / 存储上限一眼可见（此前挤在一行纯文本里，数字不突出）。
     */
    const walkedN = routes.filter((r) => r && r.traversed === true).length;
    const chip = (label, v, cls) => '<span class="ftt-chip ftt-map-chip' + (cls ? ' ' + cls : '') + '">' + esc(label) + ' <b>' + esc(String(v)) + '</b></span>';
    const head = '<div class="ftt-map-stats">'
        + chip('🏠 单元', places.length) + chip('🧭 路径', routes.length)
        + chip('👣 剧情走过', walkedN, walkedN ? 'ftt-ok' : '') + chip('📦 上限', cap.cap ? num(cap.cap) : '未设')
        + '</div>'
        + '<div class="ftt-hint">分层关联网图（<b>不是坐标地图</b>）：场所 → 房间 → 陈设三级；路径只记<b>剧情走过</b>的那些，'
        + '未走过的只能是手填（标「未走过（手填）」）。<b>点图中的节点</b>即可下钻或插入套话。</div>';
    let ins = '';
    if (lastInsert) {
        ins = '<div class="ftt-hint' + (lastInsert.ok ? '' : ' ftt-note--err') + '">' + esc(lastInsert.text) + '</div>';
        if (lastInsert.manualText) {
            ins += '<div class="ftt-field ftt-field-col"><label>手动复制这段（自动插入不可用）：</label>'
                + '<textarea data-ftt-map-copy="1" rows="2" readonly>' + esc(lastInsert.manualText) + '</textarea></div>';
        }
    }
    if (!places.length && !routes.length) return head + ins + emptyHtml();

    const byId = {};
    places.forEach((p) => { byId[String(p.id)] = p; });
    const scenes = (state.scenes || []).filter((s) => s && s.id);

    // ---------- 第三级：某房间的陈设 ----------
    if (openScene && openRoom) {
        const anchor = places.filter((p) => p.level === 'scene' && String(p.sceneRef) === String(openScene))[0] || null;
        const room = byId[String(openRoom)] || null;
        const tree = mapTreeOf(state, openScene);
        const fs = (tree.fixturesOf[String(openRoom)] || []);
        const rows = fs.length ? fs.map((f) => placeRowHtml(f, anchor, {})).join('\n') : '<div class="ftt-empty">这个房间里还没有记录任何陈设。正文提到具体物件时才会出现。</div>';
        const routesHere = routes.filter((r) => String(r.fromId) === String(openRoom) || String(r.toId) === String(openRoom));
        return head + ins + breadcrumbHtml()
            + '<h4 class="ftt-h4-inline ftt-map-h4">🪑 ' + esc(String(room ? room.name : '房间')) + ' 的陈设（' + fs.length + '）</h4>' + rows
            + (routesHere.length ? ('<h4 class="ftt-h4-inline">🧭 与这里的路径</h4>' + routesHere.map((r) => routeRowHtml(r, byId, anchor)).join('\n')) : '');
    }

    // ---------- 第二级：某场所的房间 + 该场所内的路径 ----------
    if (openScene) {
        const anchor = places.filter((p) => p.level === 'scene' && String(p.sceneRef) === String(openScene))[0] || null;
        const tree = mapTreeOf(state, openScene);
        const ids = places.filter((p) => String(p.sceneRef) === String(openScene)).map((p) => String(p.id));
        const routesHere = routes.filter((r) => ids.indexOf(String(r.fromId)) >= 0 && ids.indexOf(String(r.toId)) >= 0);
        const roomRows = tree.rooms.map((r) => placeRowHtml(r, anchor, { fixturesOf: tree.fixturesOf })).join('\n');
        return head + ins + breadcrumbHtml()
            + '<h4 class="ftt-h4-inline ftt-map-h4">🚪 房间（' + tree.rooms.length + '）</h4>'
            + (roomRows || '<div class="ftt-empty">这个场所下还没有记录任何房间。正文提到具体房间时才会出现。</div>')
            + (tree.orphans ? ('<div class="ftt-hint">⚠ 有 ' + tree.orphans + ' 个陈设的「上层」指不到有效房间（已跳过，可在调试页查看入库读数）。</div>') : '')
            + '<h4 class="ftt-h4-inline">🧭 本场所内的路径（' + routesHere.length + '）</h4>'
            + (routesHere.length ? routesHere.map((r) => routeRowHtml(r, byId, anchor)).join('\n')
                : '<div class="ftt-hint">场所内部还没有记下任何路径（只记剧情明确走过的）。</div>');
    }

    // ---------- 第一级：场所列表（含跨场所路径） ----------
    const anchorRows = scenes.map((s) => {
        const sid = String(s.id);
        const tree = mapTreeOf(state, sid);
        const anchor = tree.scene;
        const label = String(s.name || s.pathStr || sid);
        return '<div class="ftt-item ftt-inline" data-ftt-map-node="' + esc(sid) + '">'
            + '<span class="ftt-grow"><b>📍 ' + esc(label) + '</b>'
            + ' <span class="ftt-muted">房间 ' + tree.rooms.length + ' · 单元 ' + tree.total + '</span></span>'
            + (tree.total ? '<button class="ftt-btn ftt-sm" data-ftt-action="mapOpen" data-kind="scene" data-map-scene="' + esc(sid) + '" title="展开这个场所的房间与路径">🔍 展开</button>' : '')
            + (anchor ? '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="mapInsert" data-map-place="' + esc(String(anchor.id)) + '" data-map-scene="' + esc(sid) + '" title="把「' + esc(trailPhraseOf(anchor, null)) + '」插到输入框尾部">🗺 前往</button>' : '')
            + '</div>';
    }).join('\n');
    // 跨场所路径（两端属于不同场所）—— 只在根层列出，避免每层重复
    const sceneOf = (pid) => String((byId[String(pid)] || {}).sceneRef || '');
    const cross = routes.filter((r) => sceneOf(r.fromId) !== sceneOf(r.toId));
    /**
     * v3.50.6（用户报告：「场景地图是图，不是列表」）：**网状图放最前**（图为主），
     *   逐行明细退居其后的「明细（可下钻 / 可插入）」小节 —— 图形本身也可点（节点带 `data-ftt-map-node`）。
     */
    const graph = sceneMapGraphSvg(places, routes, { title: '网状图：节点 ' + places.length + ' · 路径 ' + routes.length + '（实线 = 剧情走过 · 虚线 = 未走过）' });
    return head + ins
        + (graph ? ('<div class="ftt-map-cardwrap"><h4 class="ftt-h4-inline ftt-map-h4">🕸 网状图</h4>' + graph + '</div>') : '')
        + '<h4 class="ftt-h4-inline ftt-map-h4">📍 场所有地图数据的（' + scenes.filter((s) => mapTreeOf(state, String(s.id)).total).length + ' / ' + scenes.length + '）</h4>'
        + (anchorRows || '<div class="ftt-empty">场景库还是空的。先在「🌳 场景」页或 AI 摘要里建立地点树。</div>')
        + (cross.length ? ('<h4 class="ftt-h4-inline">🧭 跨场所路径（' + cross.length + '）</h4>' + cross.map((r) => routeRowHtml(r, byId, null)).join('\n')) : '');
}

// ==================== 动作 ====================

/**
 * 处理本模块的动作（由 `ui/panel.js` 统一分发）。
 * @returns {Promise<{ok:boolean, action:string, reason?:string}>}
 */
export async function runSceneMapAction(a, p) {
    const act = String(a || '');
    const par = p || {};
    try {
        if (act === 'mapSub') { setSceneMapSub(par.sub); return { ok: true, action: act, sub: sub }; }
        if (act === 'mapRoot') { resetSceneMapNav(); return { ok: true, action: act }; }
        if (act === 'mapBack') { const to = sceneMapBack(); return { ok: true, action: act, back: to }; }
        if (act === 'mapOpen') {
            const kind = String(par.kind || 'scene');
            if (kind === 'room') { openRoom = String(par.mapPlace || ''); return { ok: true, action: act, room: openRoom }; }
            openScene = String(par.mapScene || ''); openRoom = '';
            return { ok: true, action: act, scene: openScene };
        }
        if (act === 'mapInsert') return await doInsert(par);
    } catch (e) {
        return { ok: false, action: act, reason: String((e && e.message) || e) };
    }
    return { ok: false, action: act, reason: 'unknown-action' };
}

/** 点击节点 → 插套话（**只插文本、不写数据**；失败必给可读原因） */
async function doInsert(par) {
    let places = [];
    try { places = mapPlaces(state); } catch (e) { places = []; }
    const byId = {};
    places.forEach((x) => { byId[String(x.id)] = x; });
    let place = byId[String(par.mapPlace || '')] || null;
    let targetName = place ? String(place.name || '') : '';
    if (!place && par.mapRoute) {
        // 路径行：以**终点**为目标（「前往 X」的语义）
        const rt = mapRoutes(state).filter((r) => String(r.id) === String(par.mapRoute))[0] || null;
        place = rt ? (byId[String(rt.toId)] || null) : null;
        targetName = place ? String(place.name || '') : '';
    }
    if (!place) {
        lastInsert = { ok: false, text: '这条记录找不到对应的空间单元（可能刚被删除），未插入任何文本。' };
        return { ok: false, action: 'mapInsert', reason: 'no-place' };
    }
    const anchor = (place.level === 'scene')
        ? place
        : (places.filter((x) => x.level === 'scene' && String(x.sceneRef) === String(place.sceneRef))[0] || null);
    const text = trailPhraseOf(place.level === 'scene' ? place : anchor, place.level === 'scene' ? null : place);
    if (!text) {
        lastInsert = { ok: false, text: '套话模板渲染为空（检查设定 → 基础 → 地图套话），未插入任何文本。' };
        return { ok: false, action: 'mapInsert', reason: 'empty-phrase' };
    }
    // 能力探测 + 降级链（`host/input-box.js`）：宿主输入框 → 剪贴板 → 手动复制
    const r = await insertTextToHost(text, { focus: true });
    lastInsert = {
        ok: !!r.ok, via: String(r.via || ''), text: (r.ok
            ? ('已插入到用户输入框尾部：' + text + '（' + String(r.reason || '') + '）')
            : ('未能自动插入 —— ' + String(r.reason || '原因未知') + '。可手动复制：' + text)),
        manualText: r.ok ? '' : text,
        target: targetName,
    };
    return { ok: !!r.ok, action: 'mapInsert', via: String(r.via || ''), reason: String(r.reason || '') };
}

/** 只读能力读数（供界面 / 测试 / 调试列出「当前首选哪一档」） */
export function sceneMapInsertCapability() { return inputBoxCapability(); }

/**
 * **场景页整体正文**（双子标签 + 两个子页容器）—— 由 `ui/panel.js` 一行调用（体量棘轮：面板只留接线）。
 * @param {string} cur 当前子页（`scene` | `map`）
 * @param {string} sceneInnerHtml 「🌳 场景」子页的正文（编辑器 + 场景树；由面板侧给出）
 */
export function scenePageBodyHtml(cur, sceneInnerHtml) {
    const c = String(cur || 'scene');
    return sceneMapTabsHtml(c)
        + '<div data-ftt-scenesub-body="scene" style="' + (c === 'scene' ? '' : 'display:none') + '">' + String(sceneInnerHtml || '') + '</div>'
        + '<div data-ftt-scenesub-body="map" style="' + (c === 'map' ? '' : 'display:none') + '">' + sceneMapBodyHtml() + '</div>';
}
