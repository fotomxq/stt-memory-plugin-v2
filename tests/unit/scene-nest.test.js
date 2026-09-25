// ============================================================
// 单元测试 · v2.50.0「场景收纳（父级层级）修复」（用户报告：「场景收纳能力异常需修复」）
//
// 缺陷（V2 自身）：编辑一条**嵌套场景**时，父级下拉恒为「（顶层）」——
//   ① 缺少 V1 的 `findSceneParentId()`（由 `pathArr` 反查父级记录）；
//   ② 下拉只列裸 `name`、未按完整路径排序、无层级缩进、无完整路径提示。
//   后果：用户打开嵌套场景直接点「💾 保存」→ `deconstructEntry` 按「父级=空」重建 →
//   `pathArr` 退化为 `[name]` → **层级被拍平**（场景树里该节点跑到顶层）＝「收纳异常」。
// V1 口径（v1.206）：`findSceneParentId` 23352 · 父级下拉 23300~23313（排序/缩进/`name（完整>路径）`）。
// 覆盖：
//   P 组：`findSceneParentId` 等价行为（路径反查父级 / 顶层为空 / 父级记录缺失为空 / 一/二/三层）；
//   D 组：父级下拉渲染（排序、缩进、完整路径标签、选中项）；
//   R 组：**往返不丢层级** —— 打开嵌套场景 → 用预填值保存 → `pathArr` 与打开前逐字一致；
//        并对照「若按旧实现（父级空）保存」会被拍平（负向对照）；
//   E 组：新增子场景（`addChildScene` 预设父级）与改父级（reparent）仍按 V1 口径重建路径。
// 运行：node tests/unit/scene-nest.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel } from '../../ui/panel.js';
import { deconstructEntry } from '../../ui/fields.js';
import { scenesTreeHtml } from '../../ui/scene-tree.js';

const R = makeReporter('scene-nest v2.50.0 场景收纳（父级层级）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const unesc = (h) => String(h || '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** 固定场景集：三层（城市甲 > 码头 > 里屋）+ 同名分支（城市乙 > 码头）—— 用于验证「同名不同枝」的可辨识度 */
function boot(scenes) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), {
        scenes: clone(scenes || [
            { id: 'sc1', name: '城市甲', pathArr: ['城市甲'], pathStr: '城市甲', desc: '', tags: [], uses: 0 },
            { id: 'sc2', name: '码头', pathArr: ['城市甲', '码头'], pathStr: '城市甲>码头', desc: '', tags: [], uses: 2 },
            { id: 'sc3', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], pathStr: '城市甲>码头>里屋', desc: '有铜箱。', tags: [], uses: 1 },
            { id: 'sc4', name: '城市乙', pathArr: ['城市乙'], pathStr: '城市乙', desc: '', tags: [], uses: 0 },
            { id: 'sc5', name: '码头', pathArr: ['城市乙', '码头'], pathStr: '城市乙>码头', desc: '', tags: [], uses: 1 },
        ]),
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
}
boot();
openPanel('settings');

/** 打开编辑器并返回 body HTML */
async function openEditor(kind, id, preset) {
    const p = { kind: kind, id: id || '' };
    if (preset) p.preset = clone(preset);
    await panelAction('edit', p);
    return String(panelBodyHtml('scenes') || '');
}
/** 读 `<select data-ftt-ed="parent">` 的选中项 id 与选项列表 */
function readParentSelect(html) {
    const at = html.indexOf('data-ftt-ed="parent"');
    if (at < 0) return null;
    const end = html.indexOf('</select>', at);
    const seg = html.slice(at, end);
    const opts = [];
    const re = /<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g;
    let m;
    while ((m = re.exec(seg)) !== null) opts.push({ value: m[1], selected: /selected/.test(m[2]), label: unesc(m[3]) });
    return { selected: (opts.filter((o) => o.selected)[0] || { value: '' }).value, opts: opts };
}

// ---------- P 组：父级反查等价（走 `deconstructEntry` 的同一份路径口径 + 下拉选中） ----------
await (async () => {
    boot();
    const html = await openEditor('scenes', 'sc3');          // 三层里的「里屋」
    const sel = readParentSelect(html);
    A('P1 编辑三层嵌套场景 → 父级下拉**选中其真实父级**（城市甲>码头 = sc2），不再是「（顶层）」',
        !!sel && sel.selected === 'sc2', J(sel && { selected: sel.selected }));
})();

await (async () => {
    boot();
    const html = await openEditor('scenes', 'sc1');          // 顶层
    const sel = readParentSelect(html);
    A('P2 顶层场景 → 父级下拉选中「（顶层）」（空值）', !!sel && sel.selected === '', J(sel && { selected: sel.selected }));
})();

await (async () => {
    boot([
        { id: 'x1', name: '孤儿节点', pathArr: ['不存在甲', '不存在乙', '孤儿节点'], pathStr: '不存在甲>不存在乙>孤儿节点', desc: '', tags: [], uses: 0 },
    ]);
    const html = await openEditor('scenes', 'x1');
    const sel = readParentSelect(html);
    A('P3 父级**记录缺失**（只有虚节点）→ 选中「（顶层）」且不报错（保存时按顶层重建，与 V1 判据一致）',
        !!sel && sel.selected === '', J(sel && { selected: sel.selected }));
})();

// ---------- D 组：下拉渲染口径（V1 23300~23313） ----------
await (async () => {
    boot();
    const html = await openEditor('scenes', 'sc3');
    const sel = readParentSelect(html);
    const labels = (sel ? sel.opts : []).map((o) => o.label);
    A('D1 下拉：按**完整路径**排序 + 层级缩进 + `name（完整>路径）` 标签（V1 逐字），同名分支可区分',
        !!sel && sel.opts[0].label === '（顶层）'
        && labels.some((l) => l.indexOf('城市甲（城市甲）') >= 0)
        && labels.some((l) => l.indexOf('码头（城市甲>码头）') >= 0 && l.indexOf('　') === 0)
        && labels.some((l) => l.indexOf('码头（城市乙>码头）') >= 0)
        && labels.some((l) => l.indexOf('里屋（城市甲>码头>里屋）') >= 0 && l.indexOf('　　') === 0),
        J(sel && sel.opts.map((o) => o.label)));
})();

// ---------- R 组：往返不丢层级（核心回归） ----------
await (async () => {
    boot();
    const before = clone(state.scenes.filter((x) => x.id === 'sc3')[0]);
    const html = await openEditor('scenes', 'sc3');
    const sel = readParentSelect(html);
    // 用户点「💾 保存」= 面板用**当前表单值**重建入库 raw（等价 `collectEditorFields` 的直取）
    const raw = deconstructEntry('scenes', { id: 'sc3', name: before.name, parent: sel.selected });
    const after = (() => { const i = (state.scenes || []).findIndex((x) => x.id === 'sc3'); state.scenes[i] = Object.assign({}, state.scenes[i], raw); return clone(state.scenes[i]); })();
    A('R1 打开嵌套场景 → 直接保存：`pathArr` **逐字不变**（层级不丢）；正文/标签/调用次数等字段也保留',
        J(after.pathArr) === J(before.pathArr) && after.pathStr === before.pathStr
        && after.desc === before.desc && after.uses === before.uses,
        J({ before: before.pathArr, after: after.pathArr }));
})();

await (async () => {
    // 负向对照：按旧实现（父级空）保存 → 会被拍平成顶层
    boot();
    const before = clone(state.scenes.filter((x) => x.id === 'sc3')[0]);
    const raw = deconstructEntry('scenes', { id: 'sc3', name: before.name, parent: '' });
    A('R2 负向对照：父级取空（旧实现的默认行为）→ `pathArr` 退化为 `[name]`（**这就是用户看到的「收纳异常」**）',
        J(raw.pathArr) === J(['里屋']), J(raw.pathArr));
})();

await (async () => {
    boot();
    await openEditor('scenes', 'sc5');        // 城市乙>码头
    const html = String(panelBodyHtml('scenes') || '');
    const sel = readParentSelect(html);
    A('R3 同名不同枝：编辑「城市乙>码头」→ 选中它自己的父级（城市乙 = sc4），不会串到城市甲那枝',
        !!sel && sel.selected === 'sc4', J(sel && { selected: sel.selected }));
})();

// ---------- E 组：新增子场景 / 改父级 ----------
await (async () => {
    boot();
    await panelAction('addChildScene', { id: 'sc2' });      // 在「城市甲>码头」下新增
    const html = String(panelBodyHtml('scenes') || '');
    const sel = readParentSelect(html);
    A('E1 新增子场景：父级预设为被点节点（sc2）并选中', !!sel && sel.selected === 'sc2', J(sel && { selected: sel.selected }));

    const raw = deconstructEntry('scenes', { name: '仓库', parent: 'sc2' });
    A('E2 新增子场景保存 → `pathArr` = 父级路径 + 本节点名（V1 口径）',
        J(raw.pathArr) === J(['城市甲', '码头', '仓库']), J(raw.pathArr));
})();

await (async () => {
    boot();
    // 把「里屋」改挂到「城市乙>码头」下
    const raw = deconstructEntry('scenes', { id: 'sc3', name: '里屋', parent: 'sc5' });
    A('E3 改父级（reparent）→ `pathArr` 按新父级重建',
        J(raw.pathArr) === J(['城市乙', '码头', '里屋']), J(raw.pathArr));
})();

A('E4 场景树按新父级重新收纳（reparent 后出现在新分支下）', (() => {
    boot();
    const i = state.scenes.findIndex((x) => x.id === 'sc3');
    state.scenes[i] = Object.assign({}, state.scenes[i], deconstructEntry('scenes', { id: 'sc3', name: '里屋', parent: 'sc5' }));
    const html = unesc(scenesTreeHtml({ q: '', multi: false, sel: new Set() }));
    const at = html.indexOf('data-ftt-scene-node="城市乙>码头>里屋"');
    const awayFromOld = html.indexOf('data-ftt-scene-node="城市甲>码头>里屋"') < 0;
    return at >= 0 && awayFromOld;
})(), (() => { boot(); return ''; })());

un();
R.done();
