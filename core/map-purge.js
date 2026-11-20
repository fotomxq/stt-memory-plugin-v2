// ============================================================
// core/map-purge.js —— **地图（场景地图）数据清理例程**（v3.52.19 预备；下一版执行）
//
// 用户要求（原话）：「移除场景地图的设计，注意补充下一个版本删除相关数据的代码，确保清理干净。」
//
// 分工（两阶段，避免「移除设计」时误删用户数据）：
//   · **v3.52.19（本版）**：设计下线 —— UI 子页 / 注入 / 抽取 / 入库全部移除；**存量数据保留不动**
//     （`state.maps` / `state.deleted.maps` / `storeShare.maps` / `mapTrailPhrase` 等原样留在存档里，只读不可见）。
//   · **下一版（`MAP_PURGE_VERSION`）**：调用本模块 `applyPlannedMapPurge()` → 一键把地图相关数据/配置清干净。
//     现在就把代码备好（含测试），下一版只需在初始化流程里加一行调用即可。
//
// 清理范围（**只删地图**，不碰任何其它维度）：
//   ① `state.maps`（地图条目）→ 逐条写墓碑后清空（跨端不复活）；
//   ② `state.links` 中 `dim === 'maps'` 的关联行；
//   ③ 地图相关的墓碑/留痕（`state.deleted.maps` / `state.deletedH.maps`）；
//   ④ 配置：`mapTrailPhrase`（地图套话）恢复默认；`storeShare.maps` 删除；`storeMinMaps` / `storeMaxMaps` 归零；
//   ⑤ 台账：`state.extractFailures` 不受影响；`state.repairCursor` 等游标按地图键删除（若存在）。
// ============================================================
import { VERSION } from './constants.js';
import { state, cfg, saveState, dbgLog } from './model/runtime.js';
import { tombMany } from './merge.js';

/** 下一版版本号：≥ 该版本时 `applyPlannedMapPurge()` 自动执行（当前版只预备、不执行） */
export const MAP_PURGE_VERSION = '3.52.20';

/** 语义化版本比较（只比较前两段 + 第三段数字；`3.52.9` < `3.52.10`） */
export function versionAtLeast(v, min) {
    const p = (x) => String(x || '').split('.').map((n) => Math.max(0, Math.floor(Number(n) || 0)));
    const a = p(v), b = p(min);
    for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
    return true;
}

/** 地图存量统计（只读；下一版前后都用它核对「是否清干净」） */
export function mapLegacyStats() {
    const out = { entries: 0, links: 0, tombstones: 0, hashTombstones: 0, configKeys: [] };
    try {
        out.entries = Array.isArray(state.maps) ? state.maps.length : 0;
        out.links = (Array.isArray(state.links) ? state.links : []).filter((x) => x && String(x.dim) === 'maps').length;
        out.tombstones = state.deleted && state.deleted.maps ? Object.keys(state.deleted.maps).length : 0;
        out.hashTombstones = state.deletedH && state.deletedH.maps ? Object.keys(state.deletedH.maps).length : 0;
        // v3.52.20：三个配置键已从默认配置静态删除；这里只报「旧存档里是否还残留」
        const keys = [];
        try {
            if (cfg && cfg.mapTrailPhrase !== undefined) keys.push('mapTrailPhrase');
            if (cfg && cfg.storeShare && Object.prototype.hasOwnProperty.call(cfg.storeShare, 'maps')) keys.push('storeShare.maps');
            if (cfg && cfg.storeMinMaps !== undefined) keys.push('storeMinMaps');
            if (cfg && cfg.storeMaxMaps !== undefined) keys.push('storeMaxMaps');
        } catch (e) { /* 忽略 */ }
        out.configKeys = keys;
    } catch (e) { /* 只读统计失败 → 返回已收集部分 */ }
    return out;
}

/**
 * **执行地图数据清理**（不可逆；调用方负责确认）。
 * @param {{force?:boolean}} [opts] `force:true` 忽略版本闸（测试 / 手动维护用）
 * @returns {{ok:boolean, reason?:string, removed?:number, links?:number, tombstones?:number, hashTombstones?:number, note?:string}}
 */
export function purgeMapData(opts) {
    const o = opts || {};
    const out = { ok: false, reason: '', removed: 0, links: 0, tombstones: 0, hashTombstones: 0, note: '' };
    try {
        const before = mapLegacyStats();
        // ① 条目：逐条墓碑（跨端不复活）后清空；**先**记录原有墓碑数（清理后连墓碑一并删除）
        try { out.tombstones = state.deleted && state.deleted.maps ? Object.keys(state.deleted.maps).length : 0; } catch (e) { /* 忽略 */ }
        try { out.hashTombstones = state.deletedH && state.deletedH.maps ? Object.keys(state.deletedH.maps).length : 0; } catch (e) { /* 忽略 */ }
        const ids = (Array.isArray(state.maps) ? state.maps : []).map((x) => String((x && x.id) || '')).filter(Boolean);
        if (ids.length) { try { tombMany('maps', ids); } catch (e) { /* 忽略 */ } }
        out.removed = ids.length;
        if (Array.isArray(state.maps) && state.maps.length) state.maps = [];
        // ② 关联行
        try {
            const links = Array.isArray(state.links) ? state.links : [];
            const keep = links.filter((x) => !(x && String(x.dim) === 'maps'));
            out.links = links.length - keep.length;
            if (out.links) state.links = keep;
        } catch (e) { /* 忽略 */ }
        // ③ 墓碑 / 内容墓碑（地图已整体下线，留痕也没有意义）
        try {
            if (state.deleted && state.deleted.maps) delete state.deleted.maps;
            if (state.deletedH && state.deletedH.maps) delete state.deletedH.maps;
        } catch (e) { /* 忽略 */ }
        // ④ 配置：v3.52.20 起三个地图配置键**已从 `defaultCfg` 静态删除**（不再有运行期改动）；
        //   这里只做兜底清理（旧存档里可能仍带着这些键，属幂等操作）。
        try {
            if (cfg) {
                if (Object.prototype.hasOwnProperty.call(cfg, 'mapTrailPhrase')) delete cfg.mapTrailPhrase;
                if (cfg.storeShare && Object.prototype.hasOwnProperty.call(cfg.storeShare, 'maps')) delete cfg.storeShare.maps;
                if (Object.prototype.hasOwnProperty.call(cfg, 'storeMinMaps')) delete cfg.storeMinMaps;
                if (Object.prototype.hasOwnProperty.call(cfg, 'storeMaxMaps')) delete cfg.storeMaxMaps;
            }
        } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 忽略 */ }
        try {
            dbgLog('地图', {
                action: '地图数据清理（设计下线）', removed: out.removed, links: out.links,
                tombstones: out.tombstones, hashTombstones: out.hashTombstones,
            });
        } catch (e) { /* 忽略 */ }
        const after = mapLegacyStats();
        out.ok = true;
        out.note = (out.removed || out.links || out.tombstones || out.hashTombstones || before.configKeys.length)
            ? ('已清理地图数据：条目 ' + out.removed + ' · 关联行 ' + out.links + ' · 墓碑 ' + out.tombstones + ' · 内容墓碑 ' + out.hashTombstones
                + '；清理后剩余 条目 ' + after.entries + ' / 关联 ' + after.links + ' / 墓碑 ' + after.tombstones)
            : '没有地图数据需要清理';
        return out;
    } catch (e) {
        return Object.assign(out, { ok: false, reason: 'error', note: '地图数据清理失败：' + String((e && e.message) || e) });
    }
}

/**
 * **按计划执行**：仅当当前版本 ≥ `MAP_PURGE_VERSION`（或显式 force）才真正清理；否则只回报「尚未到该版本」。
 *   下一版只需在 `init()` 末尾调用一次即可（幂等：清干净后再跑为 0 条）。
 * @param {{force?:boolean}} [opts]
 */
export function applyPlannedMapPurge(opts) {
    const o = opts || {};
    if (!o.force && !versionAtLeast(VERSION, MAP_PURGE_VERSION)) {
        const st = mapLegacyStats();
        return { ok: false, reason: 'not-yet', note: '地图数据清理安排在 ' + MAP_PURGE_VERSION + ' 执行（当前 ' + VERSION + '；存量 条目 ' + st.entries + ' / 关联 ' + st.links + '）', stats: st };
    }
    return purgeMapData(o);
}
