// ============================================================
// 单元测试 · v3.52.19：场景地图设计下线 + **下一版数据清理例程**（预备）
//
// 用户要求（原话）：「移除场景地图的设计，注意补充下一个版本删除相关数据的代码，确保清理干净。」
//
// 口径：
//   · 本版（3.52.19）：UI / 注入 / 抽取 / 入库全部下线；**存量数据保留**（不误删）；
//   · 下一版（`MAP_PURGE_VERSION = 3.52.20`）：`applyPlannedMapPurge()` 到点自动执行 → 清干净；
//   · 清理范围只含地图：`state.maps` / `deleted.maps` / `deletedH.maps` / `links(dim=maps)` / 地图配置键。
// 运行：node tests/unit/map-purge.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { VERSION } from '../../core/constants.js';
import { MAP_PURGE_VERSION, mapLegacyStats, purgeMapData, applyPlannedMapPurge, versionAtLeast } from '../../core/map-purge.js';

const R = makeReporter('map-purge v3.52.19 地图设计下线 + 下一版数据清理预备');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:map');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLoadPhase('ready');
    const st = emptyState();
    st.maps = [
        { id: 'mp1', name: '码头', kind: 'place', sceneRef: 'sc1' },
        { id: 'mp2', name: '仓库', kind: 'place', sceneRef: 'sc2' },
    ];
    st.links = [
        { id: 'lk1', dim: 'maps', refId: 'mp1', who: '甲', how: 'located' },
        { id: 'lk2', dim: 'memories', refId: 'me1', who: '甲', how: 'participant' },
    ];
    st.deleted = { maps: { mp9: 1 } };
    st.deletedH = { maps: { 'h-mp': 1 } };
    cfg.mapTrailPhrase = '前往 {place}';
    cfg.storeShare = Object.assign({}, cfg.storeShare, { maps: 4 });
    cfg.storeMinMaps = 1;
    cfg.storeMaxMaps = 9;
    setKernelState(st);
    return st;
}

A('A1 存量统计：条目 / 关联行 / 墓碑 / 内容墓碑 / 配置键 逐项如实', (() => {
    boot();
    const s = mapLegacyStats();
    return s.entries === 2 && s.links === 1 && s.tombstones === 1 && s.hashTombstones === 1
        && J(s.configKeys.sort()) === J(['mapTrailPhrase', 'storeMaxMaps', 'storeMinMaps', 'storeShare.maps']);
})(), () => { boot(); return J(mapLegacyStats()); });
A('A2 本版**只预备不执行**：`applyPlannedMapPurge()` 在 3.52.19 → `not-yet`，存量一条不动', (() => {
    boot();
    const r = applyPlannedMapPurge();
    return r.ok === false && r.reason === 'not-yet' && r.stats.entries === 2
        && state.maps.length === 2 && state.links.length === 2 && VERSION === '3.52.19' && MAP_PURGE_VERSION === '3.52.20';
})(), 'n/a');
A('A3 清理例程（下一版执行）：条目/关联行/墓碑/内容墓碑/配置键全部清干净，其它维度不受影响', (() => {
    boot();
    const r = purgeMapData({ force: true });
    const s = mapLegacyStats();
    return r.ok === true && r.removed === 2 && r.links === 1 && r.tombstones === 1 && r.hashTombstones === 1
        && s.entries === 0 && s.links === 0 && s.tombstones === 0 && s.hashTombstones === 0 && s.configKeys.length === 0
        && state.links.length === 1 && String(state.links[0].dim) === 'memories'   // 非地图关联行保留
        && !Object.prototype.hasOwnProperty.call(cfg, 'mapTrailPhrase')
        && !Object.prototype.hasOwnProperty.call(cfg, 'storeMinMaps')
        && !Object.prototype.hasOwnProperty.call(cfg, 'storeMaxMaps')
        && !Object.prototype.hasOwnProperty.call(cfg.storeShare, 'maps')
        && String(r.note).indexOf('已清理地图数据') >= 0;
})(), () => { boot(); const r = purgeMapData({ force: true }); return J({ r: r, s: mapLegacyStats() }); });
A('A4 幂等：清干净后再跑 → 0 条（提示「没有地图数据需要清理」）；版本闸在「到点」时自动放行', (() => {
    boot();
    purgeMapData({ force: true });
    const r2 = purgeMapData({ force: true });
    const at = (v) => applyPlannedMapPurge({ force: false, _v: v });
    return r2.ok === true && r2.removed === 0 && String(r2.note).indexOf('没有地图数据需要清理') >= 0
        && versionAtLeast('3.52.20', MAP_PURGE_VERSION) === true
        && versionAtLeast('3.52.9', '3.52.10') === false
        && versionAtLeast('3.52.19', MAP_PURGE_VERSION) === false;
})(), 'n/a');

R.done();
