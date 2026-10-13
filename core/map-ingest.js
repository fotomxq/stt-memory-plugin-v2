// ============================================================
// core/map-ingest.js —— **地图库的入库落点**（v3.47.0，`docs/D22` W16 `数-23` 路径自动分析）
//
// 设计依据：`docs/D27` §3.4（路径的自动分析）· §3.2（两种 kind 的字段）· §6 决策 Q2 / Q4 / Q5。
//
// 本模块只做一件事：把 AI 的「地图库」增量落进 `state.maps`，并**逐条执行设计稿的护栏**：
//   ① **只在剧情走过时建路径**（`traversed: true`）—— 未走过的一律**不建**并计数（§3.4 护栏①）；
//   ② **每条自动分析必带 `evidence`**（楼层；§3.4 护栏③），由调用方给出本次抽取的楼层区间；
//   ③ **同一对地点只保留一条 `route`**（同 id）—— 重复走过**更新** `evidence` 与更具体的度量，**不累加**（§3.4）；
//   ④ **抽不到就留空、不估算**（§3.4 / Q4）—— 度量交给 `core/model/map.js#normalizeMeasure`（有界规整）；
//   ⑤ **手填须 `inferred: true`**（Q5）—— 本模块只处理**自动分析**，故落库的路径 `inferred` 恒为 `false`。
//
// 另有两件必要的「名称 → id」解析（AI 只会给名称，而落库要 id）：
//   · `所属场所`（场所名）→ `scenes` 条目 id；解析不到 → **跳过并计数**（不凭空造场景）；
//   · `上层` / `起点` / `终点`（空间单元名）→ `place` id；`scene` 级锚点条目**按需自动生成**（Q2）。
// 本模块是纯函数（不写盘、不碰宿主）；落盘由 `core/ingest.js` 的统一流程负责。
// ============================================================
import { mapPlaceId, mapRouteId, normalizeMap } from './model/map.js';
import { normText } from './util.js';

/** 空读数（注入自查 / 调试日志共用同一形状，避免两处各写一套） */
function emptyStats() {
    return {
        places: 0, routes: 0, anchors: 0,
        untraversed: 0, noEnds: 0, unknownScene: 0, unknownParent: 0, orphanFixtures: 0, invalid: 0,
    };
}

/** 场所名 → `scenes` 条目 id（按 名称 / 路径末级 / 完整路径 三种写法都认） */
function resolveSceneId(scenes, name) {
    const want = normText(name, 40);
    if (!want) return '';
    const list = Array.isArray(scenes) ? scenes : [];
    // 精确名 → 路径末级 → pathStr 全等
    for (const s of list) { if (s && String(s.name || '') === want) return String(s.id || ''); }
    for (const s of list) { const pa = Array.isArray(s && s.pathArr) ? s.pathArr : []; if (pa.length && String(pa[pa.length - 1]) === want) return String(s.id || ''); }
    for (const s of list) { if (s && String(s.pathStr || '') === want) return String(s.id || ''); }
    return '';
}

/** 某场所下按名称找空间单元（可限定层级） */
function findPlace(maps, sceneRef, name, level) {
    const want = normText(name, 40);
    if (!want) return null;
    return (maps || []).filter((m) => m && m.kind === 'place'
        && String(m.sceneRef) === String(sceneRef)
        && (!level || m.level === level)
        && (String(m.name || '') === want || (Array.isArray(m.aliases) && m.aliases.indexOf(want) >= 0)))[0] || null;
}

/**
 * 落「地图库」增量。
 * @param {object} st 运行时 state（**原地修改** `st.maps`；`place` 会读 `st.scenes`）
 * @param {object} delta0 已 `normalizeDeltaKeys` 的增量（取 `delta.maps.add/update`）
 * @param {{floorStart?:number, floorEnd?:number, note?:Function}} [ctx] 本次抽取的楼层区间（写 `evidence`）
 * @returns {{places:number, routes:number, anchors:number, untraversed:number, noEnds:number, unknownScene:number, unknownParent:number, orphanFixtures:number, invalid:number}}
 */
export function applyMapDelta(st, delta0, ctx) {
    const stats = emptyStats();
    try {
        if (!st || !delta0) return stats;
        const delta = (delta0.maps && typeof delta0.maps === 'object') ? delta0.maps : null;
        if (!delta) return stats;
        const add = Array.isArray(delta.add) ? delta.add : [];
        const upd = Array.isArray(delta.update) ? delta.update : [];
        const items = add.concat(upd);
        if (!items.length) return stats;
        st.maps = Array.isArray(st.maps) ? st.maps : [];
        const fb = ctx || {};
        const floor = Math.max(0, Number(fb.floorEnd) || Number(fb.floorStart) || 0);

        // ---------- 第一遍：空间单元（先建点、再连线，避免「先来的路径找不到端点」） ----------
        for (const raw of items) {
            const n = normalizeMap(raw);
            if (!n || n.kind !== 'place') continue;
            const sceneId = resolveSceneId(st.scenes, n.sceneRef);
            if (!sceneId) { stats.unknownScene++; continue; }                       // 不凭空造场景（③ 数据使用场所数据）
            // 场所锚点按需自动生成（Q2：`scene` 级 place 是**独立锚点条目**，路径两端统一用 place id）
            ensureAnchor(st, sceneId, n, stats);
            if (n.level === 'scene') continue;                                      // 锚点已由上面负责
            const parent = resolveParent(st, sceneId, n);
            if (n.level === 'room' && !parent) { stats.unknownParent++; }            // 房间必须有锚点父级
            if (n.level === 'fixture' && (!parent || parent.level !== 'room')) { stats.unknownParent++; continue; }
            const pid = String(parent ? parent.id : (anchorOf(st, sceneId) || {}).id || '');
            const id = mapPlaceId(n.level, sceneId, pid, n.name);
            const rec = Object.assign({}, n, { id: id, sceneRef: sceneId, parentId: pid, floorSeen: floor || n.floorSeen });
            upsertPlace(st, rec);
            stats.places++;
        }

        // ---------- 第二遍：路径（护栏①：只在走过时建；护栏③：同对只一条） ----------
        for (const raw of items) {
            const n = normalizeMap(raw);
            if (!n || n.kind !== 'route') continue;
            if (n.traversed !== true) { stats.untraversed++; continue; }             // 护栏①：未走过不建
            const sceneA = sceneOfPlaceId(st, n.fromId);
            const f = resolvePlaceEndpoint(st, n.fromId);
            const t = resolvePlaceEndpoint(st, n.toId);
            if (!f || !t) { stats.noEnds++; continue; }                              // 两端都要能解析到
            const ev = { floor: floor, atomId: '' };                                 // 护栏②：必带 evidence
            // **必须走归一**：路线记录同样要带 `kind` / `category` / `title` 等通用字段
            //   （否则 `kind` 缺失 → 派生视图与注入都认不出它是路径 —— 本轮实测踩到并修正）
            const rec = normalizeMap({
                kind: 'route', fromId: String(f.id), toId: String(t.id),
                distance: n.distance, timeCost: n.timeCost,
                traversed: true, direction: n.direction, evidence: ev,
            });
            if (!rec) { stats.noEnds++; continue; }
            upsertRoute(st, Object.assign(rec, { floorSeen: floor || n.floorSeen, inferred: false }));   // 护栏⑤：自动分析恒为 false
            stats.routes++;
            void sceneA;
        }
        stats.orphanFixtures = countOrphanFixtures(st);
        return stats;
    } catch (e) {
        stats.invalid++;
        return stats;
    }
}

/** 取某场所的 `scene` 级锚点 */
function anchorOf(st, sceneId) {
    return (st.maps || []).filter((m) => m && m.kind === 'place' && m.level === 'scene' && String(m.sceneRef) === String(sceneId))[0] || null;
}

/** 按需生成场所锚点（已存在则复用；`name` 取场景名） */
function ensureAnchor(st, sceneId, hint, stats) {
    if (anchorOf(st, sceneId)) return anchorOf(st, sceneId);
    const scene = (st.scenes || []).filter((s) => s && String(s.id) === String(sceneId))[0] || null;
    const name = normText((scene && scene.name) || hint.sceneRef, 40);
    if (!name) return null;
    const rec = normalizeMap({ kind: 'place', level: 'scene', name: name, sceneRef: sceneId });
    if (!rec) return null;
    upsertPlace(st, rec);
    stats.anchors++;
    return rec;
}

/** 解析空间单元的上级（`上层` 名 → place）；房间可为空（挂到锚点下） */
function resolveParent(st, sceneId, n) {
    const want = normText(n.parentId, 40);
    if (want) {
        const hit = findPlace(st.maps, sceneId, want);
        if (hit) return hit;
    }
    return anchorOf(st, sceneId);
}

/** 路径端点：先按 id 命中，再按名称在当前地图里找（AI 常给名称） */
function resolvePlaceEndpoint(st, ref) {
    const key = String(ref || '');
    if (!key) return null;
    const byId = (st.maps || []).filter((m) => m && m.kind === 'place' && String(m.id) === key)[0];
    if (byId) return byId;
    return findPlace(st.maps, '', key) || (st.maps || []).filter((m) => m && m.kind === 'place'
        && (String(m.name || '') === key || (Array.isArray(m.aliases) && m.aliases.indexOf(key) >= 0)))[0] || null;
}

/** 端点所属场所 id（供上层判定用；找不到 → 空串） */
function sceneOfPlaceId(st, ref) {
    const p = resolvePlaceEndpoint(st, ref);
    return p ? String(p.sceneRef || '') : '';
}

/** 空间单元 upsert：同 id 覆盖（保留 uses / floorSeen 的历史较大值） */
function upsertPlace(st, rec) {
    const i = (st.maps || []).findIndex((x) => x && String(x.id) === String(rec.id));
    if (i >= 0) {
        const old = st.maps[i];
        st.maps[i] = Object.assign({}, old, rec, {
            uses: Number(old.uses) || Number(rec.uses) || 0,
            floorSeen: Math.max(Number(old.floorSeen) || 0, Number(rec.floorSeen) || 0),
        });
        return st.maps[i];
    }
    st.maps.push(rec);
    return rec;
}

/** 路径 upsert（护栏③：同 id 只一条；**重复走过更新** evidence 与更具体的度量，**不累加**） */
function upsertRoute(st, rec) {
    const i = (st.maps || []).findIndex((x) => x && String(x.id) === String(rec.id));
    const better = (a, b) => (b && (b.raw || b.value !== null)) ? b : a;   // 更具体的一侧胜出
    if (i >= 0) {
        const old = st.maps[i];
        st.maps[i] = Object.assign({}, old, {
            distance: better(old.distance, rec.distance),
            timeCost: better(old.timeCost, rec.timeCost),
            traversed: true,
            inferred: false,
            direction: rec.direction || old.direction || 'both',
            // evidence 不叠加条目数：同一次走过只留一条（按楼层去重，最多由归一保留 3 条）
            evidence: dedupeEvidence((old.evidence || []).concat(rec.evidence || [])),
            floorSeen: Math.max(Number(old.floorSeen) || 0, Number(rec.floorSeen) || 0),
        });
        return st.maps[i];
    }
    st.maps.push(Object.assign({}, rec, { evidence: dedupeEvidence(rec.evidence || []) }));
    return rec;
}

/** `evidence` 按楼层去重（**不累加**：同一次走过反复更新也只留一条） */
function dedupeEvidence(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((e) => {
        if (!e) return;
        const f = Number(e.floor) || 0;
        if (out.some((x) => (Number(x.floor) || 0) === f && String(x.atomId || '') === String(e.atomId || ''))) return;
        out.push(e);
    });
    return out.slice(-3);
}

/** 孤立陈设计数（`parentId` 指不到有效房间）—— 供注入自查与体检如实列出 */
function countOrphanFixtures(st) {
    try {
        const byId = {};
        (st.maps || []).forEach((m) => { if (m && m.kind === 'place') byId[String(m.id)] = m; });
        return (st.maps || []).filter((m) => {
            if (!m || m.kind !== 'place' || m.level !== 'fixture') return false;
            const p = byId[String(m.parentId || '')];
            return !p || p.level !== 'room';
        }).length;
    } catch (e) { return 0; }
}

/** 读数的中文一行（日志 / 注入自查共用） */
export function mapDeltaText(stats) {
    const s = stats || emptyStats();
    return '地图：单元 +' + s.places + ' · 路径 +' + s.routes + ' · 锚点 +' + s.anchors
        + (s.untraversed ? (' · 未走过未建 ' + s.untraversed) : '')
        + (s.noEnds ? (' · 端点无法解析 ' + s.noEnds) : '')
        + (s.unknownScene ? (' · 场所无法解析 ' + s.unknownScene) : '')
        + (s.unknownParent ? (' · 上层无法解析 ' + s.unknownParent) : '');
}

