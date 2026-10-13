// ============================================================
// core/model/map.js —— **地图维度 `maps` 的数据模型**（v3.47.0，`docs/D22` W16 `数-22`：容器落地）
//
// 设计依据：`docs/D27-地图维度设计稿.md` §3.1（分层模型）· §3.2（两种 `kind`）· §3.4（路径自动分析）
//   · §3.3（六处接线）· §6 决策记录 Q1–Q7（**七条全部采纳建议默认**）。
//
// 一条 `maps` 条目 = **两种 `kind` 之一**（同一维度、两种形态）：
//   · `kind: 'place'` —— **空间单元**：`level` ∈ `scene`（场所锚点）/ `room`（房间）/ `fixture`（陈设）；
//   · `kind: 'route'` —— **路径**：两端 `place` id + 距离 / 耗时 + 「剧情是否走过」。
//
// 四条硬口径（逐条对应设计稿）：
//   ① **不重复场所层级**（N3 / §3.2）：`place.sceneRef` 指向 `scenes` 条目，场所层级仍以 `scenes.pathArr` 为准；
//      `scene` 级 `place` **只做锚点、不写文本**（`desc` 留空，文本一律以 `scenes` 为准）；
//   ② **稳定 id**（`02` §2 I1「一切由 id 寻址」）：`mp_<身份>` / `mr_<两端>`；**路径 id 与方向无关**
//      （`A→B` 与 `B→A` 是同一条物理路径，方向由 `direction` 表达，避免两条互相矛盾）；
//   ③ **不猜**（§3.4）：距离 / 耗时**抽不到就留空**（`null`），绝不用现实世界常识补；未走过默认不建 `route`；
//      手填必须 `inferred: true`（自动分析的**恒为 `false`** —— 由抽取链路显式给 `traversed: true`）；
//   ④ **引用不进哈希**（§3.3 ③ / `02` §2 I3）：`sceneRef` / `parentId` / `fromId` / `toId` / `evidence` 不进内容哈希。
//
// 本模块是**纯函数叶子**（`docs/05` §5 C1：不 import 上层、不碰 DOM / 宿主）。
// ============================================================
import { clamp, hashText, normText, normalizeList } from '../util.js';
import { dimCap, nsfwField } from './scalars.js';

/** 空间单元的层级枚举（**只允许三级**，`docs/D27` §3.1 / R8） */
export const MAP_LEVELS = Object.freeze(['scene', 'room', 'fixture']);
/** 层级中文名（UI / 注入 / 提示词共用一份，避免三处各写一套） */
export const MAP_LEVEL_LABELS = Object.freeze({ scene: '场所', room: '房间', fixture: '陈设' });
/** 路径方向枚举：`both`（默认互通）/ `a-to-b` / `b-to-a`（单向，如「只能出不能进」） */
export const MAP_DIRECTIONS = Object.freeze(['both', 'a-to-b', 'b-to-a']);
/** 空间单元 id / 路径 id 前缀（供 UI 与校验区分两 `kind`） */
export const MAP_PLACE_PREFIX = 'mp_';
export const MAP_ROUTE_PREFIX = 'mr_';
/** 单个空间单元的别名上限 */
const MAP_ALIAS_MAX = 6;
/** 每条路径最多记几条 `evidence`（可回溯；不累加、只保留最近几次） */
const MAP_EVIDENCE_MAX = 3;

/**
 * 可规整的度量单位白名单（**只认这些**；不在表内 → 只留 `raw`、不做任何换算）。
 * 目的：把「数字 + 单位」这类**能机械规整**的原话附上 `{value, unit}`（Q4「能规整则附」），
 *   而不是把「三步并作两步」这类**比喻**误当成单位。
 */
const MEASURE_UNITS = Object.freeze([
    '里', '公里', '千米', '米', '步', '丈', '尺', '码',
    '天', '日', '时辰', '小时', '刻', '盏茶', '炷香', '月', '年', '分钟', '秒',
]);

/**
 * **个位汉字数字**的机械映射（**有界**：只认单字 + 「十」/「半」，不解析「二十」「十五」这类复合数词）。
 * 为什么只做这么点：`docs/D27` §3.4 要求「抽不到留空、**不猜测**」——
 *   复合数词的解析（`二十` / `十五` / `三十五六`）规则多、歧义大，属**猜测**，故一律只留 `raw`。
 */
const CJK_NUM = Object.freeze({ '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '半': 0.5 });

/**
 * **度量的规整**（`{value, unit, raw}`）：保留**剧情原话** `raw`；能规整则附 `{value, unit}`。
 * 「能规整」= AI 直接给了数值与单位，或 `raw` 是**纯「数字 + 白名单单位」**形态：
 *   · 阿拉伯数字：「3里」→ 3 里；· 个位汉字数字：「三里路」→ 3 里、「半日」→ 0.5 日。
 * 其余（复合数词 / 比喻 / 约数）**一律只留 `raw`** —— 绝不由常识推算（§3.4）。
 * @returns {{value:number|null, unit:string, raw:string}|null}
 */
export function normalizeMeasure(m) {
    try {
        if (m === undefined || m === null) return null;
        const src = (typeof m === 'object' && !Array.isArray(m)) ? m : { raw: m };
        const raw = dimCap('maps', String(src.raw == null ? '' : src.raw).trim());
        let value = Number(src.value);
        let unit = String(src.unit == null ? '' : src.unit).trim();
        if (!Number.isFinite(value) && raw) {
            // 允许一个**无义后缀**（「三里**路**」/「5里**地**」）—— 白名单极小，避免把比喻当度量
            const num = '(\\d+(?:\\.\\d+)?)';
            const cjk = '([一二两三四五六七八九十半])';
            const tail = '(?:路|路程|地|远)?';
            const mm = raw.match(new RegExp('^' + num + '\\s*([^\\d\\s]+?)' + tail + '$'));
            const mc = raw.match(new RegExp('^' + cjk + '([^\\d\\s]+?)' + tail + '$'));
            if (mm && MEASURE_UNITS.indexOf(mm[2]) >= 0) { value = Number(mm[1]); unit = mm[2]; }
            else if (mc && MEASURE_UNITS.indexOf(mc[2]) >= 0) { value = CJK_NUM[mc[1]]; unit = mc[2]; }
        }
        if (!Number.isFinite(value) || value < 0) value = null;
        if (unit && MEASURE_UNITS.indexOf(unit) < 0) unit = '';       // 非白名单单位 → 不算「可规整」
        if (!raw && value === null) return null;
        return { value: value, unit: dimCap('maps', unit), raw: raw };
    } catch (e) { return null; }
}

/** 路径 id：**与方向无关**（两端 id 排序后取哈希）—— `A→B` 与 `B→A` 是同一条 */
export function mapRouteId(a, b) {
    const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
    const pair = [x, y].sort();
    return MAP_ROUTE_PREFIX + hashText(pair[0] + '|' + pair[1]);
}

/** 空间单元 id：`level|sceneRef|parentId|name` 决定（同名同父同场所 → 两端算得同一 id） */
export function mapPlaceId(level, sceneRef, parentId, name) {
    return MAP_PLACE_PREFIX + hashText([String(level || ''), String(sceneRef || ''), String(parentId || ''), String(name || '')].join('|'));
}

/**
 * `maps` 条目归一（**两 `kind` 分派**）—— 与其它维度的 `normalizeX` 同签名（原始对象 → 规范对象或 `null`）。
 * `kind` 缺省时按「有 from/to → route，否则 place」推断（AI 常省略 `kind`；**不猜别的**）。
 * @param {object} e AI / 用户给出的原始条目
 * @returns {object|null} 归一后的条目（必需字段缺失 → `null`，调用方丢弃并如实计数）
 */
export function normalizeMap(e) {
    try {
        if (!e || typeof e !== 'object') return null;
        const kind = String(e.kind || e['类型'] || '').toLowerCase();
        const hasEnds = e.fromId !== undefined || e.from !== undefined || e['起点'] !== undefined
            || e.toId !== undefined || e.to !== undefined || e['终点'] !== undefined;
        const isRoute = (kind === 'route' || kind === '路径') ? true
            : ((kind === 'place' || kind === '空间单元' || kind === '地点') ? false : hasEnds);
        return isRoute ? normalizeRoute(e) : normalizePlace(e);
    } catch (err) { return null; }
}

/** 空间单元归一（`level` 枚举夹取；`sceneRef` 必填；`scene` 级**不写文本**） */
function normalizePlace(e) {
    const name = normText(e.name || e['名称'] || e['名字'], 40);
    if (!name) return null;
    const lv0 = String(e.level || e['层级'] || '').toLowerCase();
    const level = MAP_LEVELS.indexOf(lv0) >= 0 ? lv0 : 'scene';    // 非法层级 → 退化为场所锚点（最保守，不丢条目）
    const sceneRef = String(e.sceneRef || e['所属场所'] || e['场所'] || '').trim();
    if (!sceneRef) return null;                                    // 场所归属是硬要求（③「数据使用场所数据」）
    const parentId = String(e.parentId || e['上层'] || '').trim();
    const desc = (level === 'scene') ? '' : dimCap('maps', normText(e.desc || e['描述'] || '', 2000));   // N3：场所级只做锚点
    const aliases = normalizeList(e.aliases || e['别名'], MAP_ALIAS_MAX).map((x) => normText(x, 20)).filter(Boolean);
    return {
        id: String(e.id || mapPlaceId(level, sceneRef, parentId, name)),
        kind: 'place',
        level: level,
        name: name,
        aliases: aliases,
        desc: desc,
        sceneRef: sceneRef,
        parentId: parentId,
        floorSeen: Math.max(0, Number(e.floorSeen) || 0),
        uses: Number(e.uses) || 0,
        // 原子层通用字段（与各维度同口径；`title`/`content` 供瘦身同义组与展示复用）
        category: 'maps',
        title: name,
        content: desc,
        strength: Math.round(clamp(Number(e.importance) || 0.5, 0, 1) * 100),
        extra: { mapKind: 'place', level: level, sceneRef: sceneRef, parentId: parentId },
        ...nsfwField(e),
    };
}

/** 路径归一（两端必填且不同；`traversed` 见 §3.4 护栏①；未走过即 `inferred: true`） */
function normalizeRoute(e) {
    const fromId = String(e.fromId || e.from || e['起点'] || '').trim();
    const toId = String(e.toId || e.to || e['终点'] || '').trim();
    if (!fromId || !toId || fromId === toId) return null;          // 自环无意义 → 丢弃
    const dir0 = String(e.direction || e['方向'] || '').toLowerCase();
    const direction = MAP_DIRECTIONS.indexOf(dir0) >= 0 ? dir0 : 'both';
    const traversed = e.traversed === true || e['走过'] === true;
    return {
        id: String(e.id || mapRouteId(fromId, toId)),
        kind: 'route',
        fromId: fromId,
        toId: toId,
        distance: normalizeMeasure(e.distance || e['距离']),
        timeCost: normalizeMeasure(e.timeCost || e['耗时'] || e['所需时间']),
        traversed: traversed,
        // 护栏①：**自动分析的恒为 `false`**（抽取链路显式给 traversed:true）；未走过 → 只能是手填
        inferred: traversed ? (e.inferred === true || e['推断'] === true) : true,
        direction: direction,
        evidence: normalizeEvidence(e.evidence || e['证据']),
        floorSeen: Math.max(0, Number(e.floorSeen) || 0),
        uses: Number(e.uses) || 0,
        category: 'maps',
        title: '',
        content: '',
        strength: Math.round(clamp(Number(e.importance) || 0.5, 0, 1) * 100),
        extra: { mapKind: 'route', fromId: fromId, toId: toId, traversed: traversed, direction: direction },
        ...nsfwField(e),
    };
}

/** 走过证据（`{floor, atomId}`，可回溯；§3.4 护栏③）——最多 `MAP_EVIDENCE_MAX` 条 */
function normalizeEvidence(ev) {
    const out = [];
    const list = Array.isArray(ev) ? ev : (ev ? [ev] : []);
    for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        const floor = Number(x.floor);
        const atomId = String(x.atomId || x['情节'] || '').trim();
        if (!Number.isFinite(floor) && !atomId) continue;
        out.push({ floor: Number.isFinite(floor) ? Math.max(0, Math.round(floor)) : 0, atomId: atomId });
        if (out.length >= MAP_EVIDENCE_MAX) break;
    }
    return out;
}

// ==================== 派生视图（注入 / UI / 体检共用同一份，避免三处各算一套） ====================

/** 取 `maps` 数组（缺省空数组，绝不抛错） */
export function mapsOf(st) {
    try { return Array.isArray(st && st.maps) ? st.maps : []; } catch (e) { return []; }
}

/** 只要空间单元（可按场所收窄） */
export function mapPlaces(st, opts) {
    const o = opts || {};
    return mapsOf(st).filter((m) => m && m.kind === 'place' && (!o.sceneRef || String(m.sceneRef) === String(o.sceneRef)));
}

/** 只要路径（可限定「两端都在给定 id 集合内」） */
export function mapRoutes(st, opts) {
    const o = opts || {};
    return mapsOf(st).filter((m) => m && m.kind === 'route'
        && (!o.placeIds || (o.placeIds.indexOf(String(m.fromId)) >= 0 && o.placeIds.indexOf(String(m.toId)) >= 0)));
}

/**
 * **某场所的空间单元树**（`scene` → `room` → `fixture`）。
 * 孤儿（`parentId` 指向不存在的上层）**如实计数**并排除出树（不静默丢，供体检/注入自查列出）。
 * @returns {{scene:object|null, rooms:Array, fixturesOf:Object<string,Array>, orphans:number, total:number}}
 */
export function mapTreeOf(st, sceneRef) {
    const sites = mapPlaces(st, { sceneRef: sceneRef });
    const byId = {};
    sites.forEach((p) => { byId[String(p.id)] = p; });
    const rooms = sites.filter((p) => p.level === 'room');
    const fixturesOf = {};
    let orphans = 0;
    sites.filter((p) => p.level === 'fixture').forEach((f) => {
        const pid = String(f.parentId || '');
        const parent = pid ? byId[pid] : null;
        if (!parent || parent.level !== 'room') { orphans++; return; }
        if (!fixturesOf[pid]) fixturesOf[pid] = [];
        fixturesOf[pid].push(f);
    });
    return { scene: sites.filter((p) => p.level === 'scene')[0] || null, rooms: rooms, fixturesOf: fixturesOf, orphans: orphans, total: sites.length };
}

/** 某条路径的中文两端（注入 / UI / 体检共用；找不到一端如实标「（未知）」） */
export function mapRouteLabel(st, route) {
    const byId = {};
    mapPlaces(st).forEach((p) => { byId[String(p.id)] = p; });
    const nm = (id) => { const p = byId[String(id)]; return p ? String(p.name || '') : '（未知）'; };
    return nm(route && route.fromId) + ' → ' + nm(route && route.toId);
}

/** 一条路径的度量文本（`raw` 优先，有规整值则附上；都没有 → 空串，**不编**） */
export function mapRouteMeasureText(route) {
    const one = (m, label) => {
        if (!m) return '';
        const raw = String(m.raw || '');
        const num = (m.value !== null && m.value !== undefined) ? (String(m.value) + String(m.unit || '')) : '';
        const body = raw || num;
        if (!body) return '';
        return label + body + ((raw && num && raw !== num) ? ('（' + num + '）') : '');
    };
    return [one(route && route.distance, '距离 '), one(route && route.timeCost, '耗时 ')].filter(Boolean).join('；');
}

/** 路径的「走过 / 未走过」人读标记（UI 与注入共用） */
export function mapRouteStatusText(route) {
    if (!route) return '';
    if (route.traversed === true) return '剧情走过';
    return route.inferred === true ? '未走过（手填）' : '未走过';
}

export { MAP_ALIAS_MAX, MAP_EVIDENCE_MAX };

// ==================== 注入子块（`docs/D27` §3.5 ⑥「捆绑注入」） ====================
// 口径（逐条对应设计稿）：
//   · **禁止单独注入**：`maps` **不进**召回候选池；子块只挂在本场景的 `[场景地点]` 小节里（`core/recall.js`）；
//   · **继承场景的命运**：场景小节不入预算 → 子块也不出现（同一个大类，且**排在场景整块之后**）；
//   · **优先级低于场景本身**：子块是**同一大类里追加的行**，预算不够时先丢子块、场景整块保留；
//   · **按层限量**：房间 / 陈设 / 路径各有上限（下表的常量）。
//
// 为什么**不做成设定项**（差异登记，与 v3.46.0 的 `SNAP_CAP`/`SNAP_BATCH` 同款处置）：
//   这三个数只影响「一次注入里挂多少行」，属内部排版口径；做成控件会增加 3 个配置键与 3 个控件，
//   而用户可感知的出口已经由 `charBudget`（总字数）统一约束。
/** 注入子块：每个场景最多列几个房间 */
export const MAP_INJECT_MAX_ROOMS = 6;
/** 注入子块：每个房间最多列几个陈设 */
export const MAP_INJECT_MAX_FIXTURES = 6;
/** 注入子块：每个场景最多列几条路径 */
export const MAP_INJECT_MAX_ROUTES = 6;

/**
 * 生成**某场景的地图注入子块**（多行文本；无内容 → 空数组）。
 * 「按层限量」的裁剪**只影响本次注入**，不动任何数据（`docs/D27` R8）。
 * @param {object} st 运行时 state
 * @param {string} sceneId 场景条目 id
 * @returns {string[]} 行（首行是子块标题；无地图 → `[]`）
 */
export function mapInjectLines(st, sceneId) {
    try {
        const sid = String(sceneId || '');
        if (!sid) return [];
        const tree = mapTreeOf(st, sid);
        if (!tree.total) return [];
        const places = mapPlaces(st, { sceneRef: sid });
        const ids = places.map((p) => String(p.id));
        const routes = mapRoutes(st, { placeIds: ids });
        const roomLines = [];
        tree.rooms.slice(0, MAP_INJECT_MAX_ROOMS).forEach((r) => {
            const fs = (tree.fixturesOf[String(r.id)] || []).slice(0, MAP_INJECT_MAX_FIXTURES).map((f) => String(f.name || '')).filter(Boolean);
            const desc = r.desc ? ('：' + String(r.desc)) : '';
            roomLines.push('  - 房间：' + String(r.name || '') + desc + (fs.length ? ('（陈设：' + fs.join('、') + '）') : ''));
        });
        const moreRooms = Math.max(0, tree.rooms.length - MAP_INJECT_MAX_ROOMS);
        const byId = {};
        places.forEach((p) => { byId[String(p.id)] = p; });
        const routeLines = routes.slice(0, MAP_INJECT_MAX_ROUTES).map((rt) => {
            const nm = (id) => String((byId[String(id)] || {}).name || '（未知）');
            const m = mapRouteMeasureText(rt);
            return '  - 路径：' + nm(rt.fromId) + ' → ' + nm(rt.toId)
                + (m ? ('（' + m + '）') : '') + '［' + mapRouteStatusText(rt) + '］';
        });
        const moreRoutes = Math.max(0, routes.length - MAP_INJECT_MAX_ROUTES);
        if (!roomLines.length && !routeLines.length) return [];
        const sceneName = String((((st.scenes || []) || []).filter((s) => s && String(s.id) === sid)[0] || {}).name || '');
        const out = ['  📍 地图' + (sceneName ? ('（' + sceneName + '）') : '') + '：'];
        roomLines.forEach((l) => out.push(l));
        if (moreRooms) out.push('  - （还有 ' + moreRooms + ' 个房间未展开）');
        routeLines.forEach((l) => out.push(l));
        if (moreRoutes) out.push('  - （还有 ' + moreRoutes + ' 条路径未展开）');
        return out;
    } catch (e) { return []; }
}

/** 注入自查读数：本次挂了几个场景的地图子块、共几行（供「如实列出」口径） */
export function mapInjectStats(st, sceneIds) {
    const ids = Array.isArray(sceneIds) ? sceneIds : [];
    let scenes = 0, lines = 0;
    ids.forEach((sid) => {
        const l = mapInjectLines(st, sid);
        if (l.length) { scenes++; lines += l.length; }
    });
    return { scenes: scenes, lines: lines, units: mapsOf(st).filter((m) => m && m.kind === 'place').length, routes: mapsOf(st).filter((m) => m && m.kind === 'route').length };
}
