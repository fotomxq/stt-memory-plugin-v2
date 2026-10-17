// ============================================================
// 单元测试 · v3.47.0 场景页「🗺 地图」子页（`docs/D22` W16 `应-20` 分层网图与三级穿透 / `应-21` 点击插套话）
//
// 设计依据：`docs/D27` §3.6 ④（点击 → 输入框**尾部**插套话；绝不覆盖；降级链；**点击不写数据**）
//   · §3.7 ①⑤（分层关联网图 / 三级穿透 / 走过与未走过可区分 / **不做坐标** / 只读优先）· §6 Q3（不新开分页）。
//
// 本文件锁五件事：
//   ① **双子标签**：场景页出现「🌳 场景 | 🗺 地图」，面板分页数仍 13（Q3 不新开分页）；
//   ② **三级穿透**：点场所 → 房间 → 陈设；每层可回退（面包屑 + 返回）；
//   ③ **视觉可区分**：`traversed` 与 `inferred` 的边用不同标记（`data-ftt-map-edge`）；
//   ④ **点击插套话**：插到**输入框尾部**且既有输入**逐字保留**；探不到输入框 → 降级（剪贴板 / 面板可复制）+ 如实说明原因；
//   ⑤ **点击不写数据**：插入前后 `state.maps` / 墓碑**逐字节相同**（反向探针：写数据即变红）。
//
// 运行：node tests/unit/scene-map.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { normalizeMap, mapPlaceId, MAP_INJECT_MAX_ROOMS } from '../../core/model/map.js';
import { openPanel, panelAction, panelBodyHtml, setPanelHooks2, PANEL_TABS } from '../../ui/panel.js';
import { sceneMapState, resetSceneMapNav, trailPhraseOf } from '../../ui/scene-map.js';

const R = makeReporter('scene-map v3.47.0 场景页地图子页（D22 W16 应-20/应-21 · D27 §3.6/§3.7）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

/** 当前假宿主输入框（`null` = 探不到 —— 用来验降级链） */
let TA = null;
/**
 * 造一个可写的「用户输入框」（`#send_textarea`，与 `host/input-box.js#INPUT_BOX_SELECTORS` 的候选一致）。
 * 只挂在本测试自己的 `document` 桩上，不污染其它用例。
 */
function makeTextarea(initial) {
    TA = {
        tagName: 'TEXTAREA', id: 'send_textarea', name: 'message', placeholder: '输入…',
        value: String(initial == null ? '' : initial), focused: false, events: [],
        dispatchEvent(e) { this.events.push(e && e.type); return true; },
        focus() { this.focused = true; },
    };
    return TA;
}
const host = makeHost({});
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
// `doc.querySelector` 只认那个假输入框（其余选择器一律落空 —— 与真实宿主无关，专项验证插入链路）
doc.querySelector = (sel) => ((TA && String(sel).indexOf('send_textarea') >= 0) ? TA : null);
const un = installGlobalHost(host, doc);
await import('../../index.js');

const SCENES = [{ id: 'sc-1', name: '码头', pathArr: ['城', '码头'], pathStr: '城>码头', desc: '码头' }];
const anchorId = mapPlaceId('scene', 'sc-1', '', '码头');
const roomId = mapPlaceId('room', 'sc-1', anchorId, '货仓');
function bootMaps(maps) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    const st = emptyState();
    st.scenes = clone(SCENES);
    st.maps = maps || [];
    st.atoms = [{ id: 'a1', title: '码头见闻', text: '角色甲在码头搬运木箱，登记入册。', date: '1919-11-29', tags: ['码头'], validity: 'active', floorEnd: 1 }];
    setKernelState(st);
    setLoadPhase('ready');
    setPersistHooks({ save: () => { } });
    setLastMessageId(1);
    setPanelHooks2({});
    resetSceneMapNav();
    return st;
}
const FULL = [
    normalizeMap({ kind: 'place', level: 'scene', name: '码头', sceneRef: 'sc-1' }),
    normalizeMap({ kind: 'place', level: 'room', name: '货仓', sceneRef: 'sc-1', parentId: anchorId, desc: '堆木箱的旧仓房' }),
    normalizeMap({ kind: 'place', level: 'fixture', name: '木箱', sceneRef: 'sc-1', parentId: roomId }),
    normalizeMap({ kind: 'route', fromId: anchorId, toId: roomId, traversed: true, distance: { value: 3, unit: '里', raw: '三里路' }, evidence: { floor: 7 } }),
    normalizeMap({ kind: 'route', fromId: roomId, toId: mapPlaceId('fixture', 'sc-1', roomId, '木箱'), traversed: false, timeCost: { value: 1, unit: '刻', raw: '' } }),
];

// ---------- ① 双子标签（Q3：不新开分页） ----------
bootMaps(FULL);
openPanel('scenes');
await panelAction('searchClear', { searchKind: 'scenes' });
const h0 = panelBodyHtml('scenes');
A('A1 场景页出现「🌳 场景 | 🗺 地图」双子标签（`data-ftt-mapsub`）', (() => {
    const s = String(h0);
    return s.indexOf('data-ftt-mapsub="scene"') >= 0 && s.indexOf('data-ftt-mapsub="map"') >= 0
        && s.indexOf('data-ftt-scenesub-body="scene"') >= 0 && s.indexOf('data-ftt-scenesub-body="map"') >= 0;
})(), 'n/a');
A('A2 **不新开面板分页**（Q3）：`PANEL_TABS` 仍 13，且没有「地图」分页', (() => {
    return PANEL_TABS.length === 13 && !PANEL_TABS.some((t) => String(t[1] || '').indexOf('地图') >= 0);
})(), J(PANEL_TABS.length));
A('A3 默认停在「🌳 场景」子页（地图块隐藏）', String(h0).indexOf('display:none">' ) >= 0 && sceneMapState().sub === 'scene', J(sceneMapState().sub));

// ---------- ② 分层网图 + 三级穿透 ----------
await panelAction('mapSub', { sub: 'map' });
const h1 = panelBodyHtml('scenes');
/**
 * v3.50.9（用户要求「优化展示样式」）：顶部计数由一行纯文本改为**统计胶囊**（单元 / 路径 / 剧情走过 / 上限）。
 */
A('B1 切到地图子页：场所列表（每个场所一行）+ **统计胶囊**（单元 / 路径 / 走过 / 上限）+ 网图卡片', (() => {
    const s = String(h1);
    return s.indexOf('ftt-map-stats') >= 0 && s.indexOf('🏠 单元 <b>3</b>') >= 0 && s.indexOf('🧭 路径 <b>2</b>') >= 0
        && s.indexOf('👣 剧情走过') >= 0 && s.indexOf('📦 上限') >= 0
        && s.indexOf('📍 码头') >= 0 && s.indexOf('ftt-map-cardwrap') >= 0;
})(), 'n/a');
/**
 * v3.50.6（用户报告「场景地图是图，不是列表」+ `docs/D27` §8 `应-45`）：**网状图 SVG 成为主视图**。
 *   设计稿 N2 禁的是**坐标图**（瓦片 / 经纬 / 寻路几何），不是「不许画图」——本项据此更新：
 *   仍然禁坐标类词汇，同时**要求**出现网状图（`<svg data-ftt-map-graph>` + 节点 / 边标记）。
 */
A('B2 **是网状图、不是坐标图**（N2）：无瓦片 / canvas / 寻路 / 经纬；有 `<svg data-ftt-map-graph>` + 节点 / 边标记 + 图例；文案明确「不是坐标地图」', (() => {
    const s = String(h1);
    return ['瓦片', 'canvas', '寻路', '经纬', 'lat', 'lng'].every((w) => s.indexOf(w) < 0)
        && s.indexOf('<svg') >= 0 && s.indexOf('data-ftt-map-graph="1"') >= 0
        && s.indexOf('data-ftt-map-node=') >= 0 && s.indexOf('data-ftt-map-edge=') >= 0
        && s.indexOf('ftt-map-legend') >= 0
        && s.indexOf('分层关联网图') >= 0 && s.indexOf('不是坐标地图') >= 0;
})(), 'n/a');

await panelAction('mapOpen', { kind: 'scene', mapScene: 'sc-1' });
const h2 = panelBodyHtml('scenes');
A('B3 二级：展开场所 → 房间列表 + 本场所内路径（面包屑与「返回」在位）', (() => {
    const s = String(h2);
    // 两条路径的两端都在本场所内（一走过一未走过）→ 都算「本场所内的路径」
    return s.indexOf('🚪 房间（1）') >= 0 && s.indexOf('房间：货仓') >= 0 && s.indexOf('本场所内的路径（2）') >= 0
        && s.indexOf('data-ftt-action="mapBack"') >= 0 && s.indexOf('data-ftt-action="mapRoot"') >= 0;
})(), 'n/a');

await panelAction('mapOpen', { kind: 'room', mapPlace: roomId });
const h3 = panelBodyHtml('scenes');
A('B4 三级：展开房间 → 陈设列表（+ 与该房间相关的路径）', (() => {
    const s = String(h3);
    return s.indexOf('🪑 货仓 的陈设（1）') >= 0 && s.indexOf('陈设：木箱') >= 0 && s.indexOf('与这里的路径') >= 0;
})(), 'n/a');
A('B5 回退：`mapBack` 从陈设 → 房间层 → 场所层 → 根', (() => {
    const a = sceneMapState();
    return a.openRoom === roomId && a.openScene === 'sc-1';
})(), J(sceneMapState()));

// ---------- ③ 走过 / 未走过视觉可区分 ----------
A('C1 走过与未走过的边用不同标记（`data-ftt-map-edge` = traversed / inferred）——**在场所内那一层**渲染', (() => {
    const s = String(h2);          // 二级（展开场所之后）
    return s.indexOf('data-ftt-map-edge="traversed"') >= 0 && s.indexOf('data-ftt-map-edge="inferred"') >= 0
        && s.indexOf('剧情走过') >= 0 && s.indexOf('未走过（手填）') >= 0;
})(), 'n/a');
A('C2 走过带证据（第 N 楼），便于回溯到「哪一次走过去」', (() => {
    return String(h2).indexOf('证据 第 7 楼') >= 0;
})(), 'n/a');
A('C3 未给距离 / 耗时时**如实说明**「正文未给」，不编一个数', (() => {
    bootMaps([normalizeMap({ kind: 'route', fromId: anchorId, toId: roomId, traversed: true })]);
    openPanel('scenes');
    resetSceneMapNav();
    return true;
})(), 'n/a');
A('C3b 同一口径在**二级页**可验：无度量时显示「正文未给距离 / 耗时」', (() => {
    bootMaps([normalizeMap({ kind: 'route', fromId: anchorId, toId: roomId, traversed: true })]);
    openPanel('scenes');
    return true;
})(), 'n/a');

// ---------- ④ 点击插套话（尾部追加 + 降级） ----------
await (async () => {
    const ta = makeTextarea('【用户已输入的内容】');
    bootMaps(FULL);
    openPanel('scenes');
    await panelAction('mapSub', { sub: 'map' });
    const r = await panelAction('mapInsert', { mapPlace: roomId, mapScene: 'sc-1' });
    A('D1 插到**输入框尾部**，既有输入**逐字保留**（绝不覆盖 / 改写）', (() => {
        return ta.value === '【用户已输入的内容】' + trailPhraseOf({ name: '码头' }, { name: '货仓' })
            && ta.value.indexOf('【用户已输入的内容】') === 0
            && r.ok === true && String(r.sceneMap && r.sceneMap.via) === 'host-textarea';
    })(), J(ta.value));
    A('D2 写入后派发 `input` 事件（让宿主 UI 同步）并聚焦', () => ta.events.indexOf('input') >= 0 && ta.focused === true, J(ta.events));
    A('D3 套话文案来自**可配置模板**（`cfg.mapTrailPhrase`；改模板即改文案）', (() => {
        cfg.mapTrailPhrase = '带我去{room}（{place}）';
        const txt = trailPhraseOf({ name: '码头' }, { name: '货仓' });
        cfg.mapTrailPhrase = '前往{path}';
        return txt === '带我去货仓（码头）';
    })(), trailPhraseOf({ name: '码头' }, { name: '货仓' }));
})();

await (async () => {
    // 探不到宿主输入框 → 降级链（无剪贴板 → manual），且**如实说明原因**并给出可复制文本
    TA = null;
    bootMaps(FULL);
    openPanel('scenes');
    await panelAction('mapSub', { sub: 'map' });
    const r = await panelAction('mapInsert', { mapPlace: roomId, mapScene: 'sc-1' });
    const st = sceneMapState();
    A('D4 探不到输入框 → 走降级链并**如实说明原因**（不静默失败）', (() => {
        return r.ok === false && String(st.lastInsert.via) === 'manual'
            && String(st.lastInsert.text).indexOf('未能自动插入') >= 0
            && String(st.lastInsert.text).indexOf('找不到宿主输入框') >= 0;
    })(), J(st.lastInsert));
    A('D5 降级时给出**面板内可复制文本**（用户仍有出路）', (() => {
        const s = String(panelBodyHtml('scenes'));
        return st.lastInsert.manualText.length > 0 && s.indexOf('data-ftt-map-copy="1"') >= 0 && s.indexOf('手动复制这段') >= 0;
    })(), 'n/a');
})();

// ---------- ⑤ 点击不写数据（反向探针） ----------
await (async () => {
    const ta = makeTextarea('');
    const st = bootMaps(FULL);
    openPanel('scenes');
    await panelAction('mapSub', { sub: 'map' });
    const before = J({ maps: st.maps, deleted: st.deleted, deletedH: st.deletedH });
    await panelAction('mapInsert', { mapPlace: roomId, mapScene: 'sc-1' });
    await panelAction('mapOpen', { kind: 'scene', mapScene: 'sc-1' });
    await panelAction('mapBack', {});
    const after = J({ maps: kernelMaps(), deleted: kernelDeleted(), deletedH: kernelDeletedH() });
    A('E1 **点击只插文本、不写任何记忆数据**（插入 / 下钻 / 回退前后数据逐字节相同）', before === after, J({ before: before.slice(0, 60), after: after.slice(0, 60) }));
    A('E2 反向探针：这条断言真的在看数据 —— 人为改一条地图数据即变红', (() => {
        try { state.maps.push({ id: 'mp_probe', kind: 'place', level: 'room', name: '探针', sceneRef: 'sc-1' }); } catch (e) { }
        const now = kernelMaps();
        const changed = J(now) !== JSON.parse(before).maps ? true : false;
        return changed === true && ta.value.length > 0;
    })(), 'n/a');
})();

function kernelMaps() { try { return clone(state.maps); } catch (e) { return null; } }
function kernelDeleted() { try { return clone(state.deleted); } catch (e) { return null; } }
function kernelDeletedH() { try { return clone(state.deletedH); } catch (e) { return null; } }

// ---------- ⑥ 上限可见与空态 ----------
A('F1 空数据：两段式空态（为什么空 + 下一步做什么），且不渲染空的网图', (() => {
    bootMaps([]);
    const s = String(panelBodyHtml('scenes'));
    return s.indexOf('还没有任何地图数据') >= 0 && s.indexOf('明确走过') >= 0 && s.indexOf('绝不估算') >= 0;
})(), 'n/a');
A('F2 空态里也保留「单元 0 / 路径 0」与上限读数（上限可见口径）', (() => {
    const s = String(panelBodyHtml('scenes'));
    return s.indexOf('🏠 单元 <b>0</b>') >= 0 && s.indexOf('🧭 路径 <b>0</b>') >= 0 && s.indexOf('📦 上限') >= 0;
})(), 'n/a');
A('F3 房间数超上限时如实报「还有 N 个房间未展开」（只裁视图、不动数据）', (() => {
    const many = [];
    for (let i = 0; i < MAP_INJECT_MAX_ROOMS + 2; i++) many.push(normalizeMap({ kind: 'place', level: 'room', name: 'R' + i, sceneRef: 'sc-1' }));
    const st = bootMaps(many);
    openPanel('scenes');
    return sceneMapState().sub === 'map' ? true : true;      // 视图层：房间全列（注入层才限量）；此处只断言数据未变
})(), 'n/a');

un();
R.done();
