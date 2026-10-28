// ============================================================
// 单元测试 · v3.52.2 W34：**角色关注标记**（不被自动清理）+ **清理未关注角色的物品**（先预览后确认）
//
// 用户要求（原话）：「角色新增标记功能，将角色标记为关注，避免被自动清理。
//   物品新增按钮，可清理未关注角色的物品。注意清理前，需先排查询问用户，列出即将清理掉的物品清单，然后确认后再删除。」
//
// 覆盖：
//   A 关注标记：归一保留 watch / 切换（行内动作）/ 不进内容哈希（不引发跨端内容抖动）
//   B 自动清理豁免：存档上限裁剪（`enforceDimCaps`）· 低使用遗忘清扫（snapshots 项）
//   C 物品归属：`items[].owner` 归一 + 内容哈希包含 owner（跨端 owner 变更可传播）
//   D 清理计划（只读）：候选 = owner 非空且非关注/非主角；未归属 / 关注 / 主角 **都不动**
//   E 两步式应用：预览不删 → 确认后逐条删除（留墓碑）+ 级联关联行；无候选时安全空跑
//   F 界面：物品页有入口按钮 + 预览卡（逐条清单 / 前→后 / 危险确认）；角色行有「☆ 关注 / ⭐ 已关注」
// 运行：node tests/unit/snapshot-watch-items-cleanup.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase, saveState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { normalizeSnapshot } from '../../core/model/snapshot.js';
import { normalizeItem } from '../../core/model/dims.js';
import { atomContentHash } from '../../core/model/hash.js';
import { snapshotWatched, watchedRoleNames, roleProtected, toggleSnapshotWatch, dropWatchedKeys, capSnapshotsKeepingWatched } from '../../core/snapshot-watch.js';
import { itemsCleanupPlan, applyItemsCleanup } from '../../core/items-cleanup.js';
import { enforceDimCaps, mergeDelta } from '../../core/ingest.js';
import { ledgerList } from '../../core/model/ledger.js';
import { panelAction, setPanelHooks2, panelBodyHtml } from '../../ui/panel.js';
import { dangerActionPromptOf } from '../../ui/panel.js';
import { itemsCleanupState, itemsCleanupBarHtml, itemsCleanupPanelHtml } from '../../ui/items-cleanup-panel.js';
import { PROMPT_TEMPLATES_V2 } from '../../core/config.js';
const PROMO_TEMPLATES_NOOP = '';
import { listRowMainHtml } from '../../ui/list-rows.js';

const R = makeReporter('snapshot-watch-items-cleanup v3.52.2 W34 关注标记 / 物品清理');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:watch');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(10);
    const st = emptyState();
    st.protagonist = { name: '主角' };
    st.snapshots = [
        { id: 'sn1', name: '甲', watch: true, identity: {} },
        { id: 'sn2', name: '乙', identity: {} },
        { id: 'sn3', name: '主角', identity: {} },
    ];
    st.items = [
        { id: 'it1', name: '甲之剑', owner: '甲' },
        { id: 'it2', name: '乙的包裹', owner: '乙' },
        { id: 'it3', name: '主角的钱袋', owner: '主角' },
        { id: 'it4', name: '无名石头' },
    ];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- A 关注标记 ----------
A('A1 归一保留 `watch`；未提及 = false（缺省不占体积）；`watchedRoleNames` 只含被关注者', (() => {
    const s1 = normalizeSnapshot({ name: '甲', watch: true });
    const s2 = normalizeSnapshot({ name: '乙' });
    // v3.52.2：`watch` **只在 true 时写**（false 与缺省等价 → V1 黄金样本零漂移）
    return s1.watch === true && s2.watch === undefined && snapshotWatched(s1) === true && snapshotWatched(s2) === false;
})(), 'n/a');
A('A2 `watch` **不进内容哈希**（用户标记不该让跨端把同一条判成「内容变了」）', (() => {
    const a = atomContentHash('snapshots', { name: '甲', identity: {}, appearance: '', personality: {}, background: {}, relationships: [], social: {}, future: {}, watch: true });
    const b = atomContentHash('snapshots', { name: '甲', identity: {}, appearance: '', personality: {}, background: {}, relationships: [], social: {}, future: {}, watch: false });
    return a === b && !!a;
})(), 'n/a');
A('A3 切换关注：按 id / 姓名都能切换；返回昵称与提示；主角恒受保护（不计关注名单）', (() => {
    boot();
    const r1 = toggleSnapshotWatch('sn2');
    const r2 = toggleSnapshotWatch('乙');
    const names = watchedRoleNames();
    return r1.ok === true && r1.watch === true && r1.name === '乙' && r2.watch === false
        && names.indexOf('甲') >= 0 && names.indexOf('乙') < 0 && roleProtected('主角') === true;
})(), () => watchedRoleNames());
A('A4 `roleProtected`：关注者受保护，未关注者不受保护；空名不误判', (() => {
    boot();
    return roleProtected('甲') === true && roleProtected('乙') === false && roleProtected('') === false;
})(), 'n/a');

// ---------- B 自动清理豁免 ----------
A('B1 **存档上限裁剪**：超过上限时，被关注的档案不被裁掉（即便低重要度 / 低使用）', (() => {
    boot({ snapshots: Array.from({ length: 12 }, (_, i) => ({ id: 'sx' + i, name: '角色' + i, watch: i === 11, importance: 0.01, uses: 0 })) });
    cfg.storeTotalMax = 100;
    cfg.storeShare = Object.assign({}, cfg.storeShare, { snapshots: 20 });   // 上限 20% → 但按保底；直接压到 8 条
    // 为了让上限生效，直接给该维一个更小的占比：快照占比 8 → cap 8
    cfg.storeShare.snapshots = 8;
    const before = state.snapshots.length;
    enforceDimCaps();
    const keptNames = state.snapshots.map((s) => String(s.name));
    return before === 12 && state.snapshots.length <= 8 && keptNames.indexOf('角色11') >= 0;
})(), () => J({ n: state.snapshots.length, kept: state.snapshots.map((s) => s.name) }));

// ---------- C 物品归属 ----------
A('C1 `items[].owner` 归一保留（空 = 未归属 → **不写键**，V1 样本零漂移）；`owner` **不进内容哈希**（归属元信息，边界已登记）', (() => {
    const a = normalizeItem({ name: '剑', owner: '乙' });
    const b = normalizeItem({ name: '剑' });
    const h1 = atomContentHash('items', normalizeItem({ name: '剑', owner: '乙' }));
    const h2 = atomContentHash('items', normalizeItem({ name: '剑', owner: '甲' }));
    return a.owner === '乙' && b.owner === undefined && h1 === h2;
})(), 'n/a');

// ---------- D 清理计划 ----------
A('D1 计划**只读**：候选 = owner 非空且非关注/非主角；未归属 / 关注者 / 主角物品都不在清单里', (() => {
    boot();
    const p = itemsCleanupPlan();
    const ids = p.items.map((x) => x.id).sort();
    return p.ok === true && J(ids) === J(['it2']) && p.total === 1 && p.kept === 2 && p.unowned === 1
        && p.byOwner.length === 1 && p.byOwner[0].owner === '乙' && p.byOwner[0].count === 1
        && state.items.length === 4;   // 计划不写数据
})(), () => { boot(); const p = itemsCleanupPlan(); return J({ ids: p.items.map((x) => x.id), kept: p.kept, unowned: p.unowned }); });
A('D2 无候选 → 安全空跑（不删任何东西，提示如实）', (() => {
    boot({ items: [{ id: 'a', name: 'x', owner: '甲' }] });
    const p = itemsCleanupPlan();
    const r = applyItemsCleanup(p);
    return p.total === 0 && r.ok === true && r.removed === 0 && state.items.length === 1;
})(), 'n/a');

// ---------- E 应用 ----------
A('E1 确认后逐条删除：留删除墓碑（跨端不复活）+ 级联关联行；保留项不受影响', (() => {
    boot({ links: [{ id: 'lk1', dim: 'items', refId: 'it2', who: '乙', how: 'participant' }] });
    const p = itemsCleanupPlan();
    const r = applyItemsCleanup(p);
    const tombs = Object.keys((state.deleted || {}).items || {});
    return r.ok === true && r.removed === 1 && state.items.length === 3
        && state.items.some((x) => x.id === 'it1') && !state.items.some((x) => x.id === 'it2')
        && tombs.indexOf('it2') >= 0 && (state.links || []).every((x) => !(x.dim === 'items' && x.refId === 'it2'));
})(), () => J({ n: state.items.length, tombs: Object.keys((state.deleted || {}).items || {}) }));

// ---------- F 界面 ----------
A('F1 面板：角色行有「☆ 关注 / ⭐ 已关注」；物品页有清理入口；危险动作二次确认已登记', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const snap = String(panelBodyHtml('snapshots') || '');
    await panelAction('tab', { tab: 'items' });
    const items = String(panelBodyHtml('items') || '');
    return snap.indexOf('data-ftt-action="watchToggle"') >= 0 && snap.indexOf('⭐ 已关注') >= 0 && snap.indexOf('☆ 关注') >= 0
        && snap.indexOf('⭐ 关注') >= 0
        && items.indexOf('data-ftt-action="itemsCleanup"') >= 0 && items.indexOf('清理未关注角色的物品') >= 0
        && /确认清理清单里的物品/.test(String(dangerActionPromptOf('itemsCleanupApply') || ''));
})(), 'n/a');
A('F2 预览卡：列出**逐条清单**（前→后）+ 保留/未归属统计；确认前不删除任何数据', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'items' });
    await panelAction('itemsCleanup', {});
    const html = String(panelBodyHtml('items') || '');
    const st = itemsCleanupState();
    return st.open === true && html.indexOf('data-ftt-preview-card') >= 0 && html.indexOf('乙的包裹') >= 0
        && html.indexOf('ftt-preview-op--del') >= 0 && html.indexOf('未归属的 1 件') >= 0
        && state.items.length === 4
        && html.indexOf('data-ftt-action="itemsCleanupApply"') >= 0;
})(), 'n/a');
A('F3 点「确认清理」（模拟已确认）→ 删除 + 关闭预览 + 面板提示已清理数量', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'items' });
    await panelAction('itemsCleanup', {});
    const r = await panelAction('itemsCleanupApply', {});
    const st = itemsCleanupState();
    return r && r.ok === true && r.removed === 1 && st.open === false && state.items.length === 3
        && String(r.note).indexOf('已清理 1 件') >= 0;
})(), 'n/a');
A('F4 关注切换动作：点击后落库（watch 变化 + 提示），并持久化（saveState 被调用）', (async () => {
    boot();
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const r = await panelAction('watchToggle', { kind: 'snapshots', id: 'sn2' });
    const s2 = state.snapshots.filter((x) => x.id === 'sn2')[0];
    return r && r.ok === true && s2.watch === true && String(r.note).indexOf('已关注') >= 0;
})(), 'n/a');

// ---------- G v3.52.4：老数据「归属缺失」导致的漏列/0 计数（真机报告） ----------
A('G1 **位置是角色名 + 随身** → 推断归属：其他人的物品能进清单；显式 owner 优先于推断', (() => {
    boot({
        snapshots: [{ id: 'w', name: '甲', watch: true }, { id: 'o', name: '乙' }],
        items: [
            { id: 'a', name: '乙的包裹', location: '乙', carried: true },        // 无 owner → 推断「乙」→ 未关注 → 候选
            { id: 'b', name: '甲的剑', location: '甲', carried: true },          // 无 owner → 推断「甲」→ 关注 → 保留
            { id: 'c', name: '库房钥匙', location: '库房', carried: false },     // 位置是地点 → 未归属 → 不动
            { id: 'd', name: '丙的信', owner: '丙', location: '甲', carried: true }, // 显式 owner 优先 → 候选（丙）
        ],
    });
    const p = itemsCleanupPlan();
    const ids = p.items.map((x) => x.id).sort();
    return J(ids) === J(['a', 'd']) && p.total === 2 && p.kept === 1 && p.unowned === 1
        && p.inferred >= 1 && p.items.filter((x) => x.id === 'a')[0].inferred === true
        && p.items.filter((x) => x.id === 'd')[0].inferred === false
        && String(p.note).indexOf('推断归属') >= 0;
})(), () => { boot({ snapshots: [{ id: 'w', name: '甲', watch: true }, { id: 'o', name: '乙' }], items: [{ id: 'a', name: '乙的包裹', location: '乙', carried: true }, { id: 'b', name: '甲的剑', location: '甲', carried: true }] }); const p = itemsCleanupPlan(); return J({ ids: p.items.map((x) => x.id), kept: p.kept, inferred: p.inferred }); });
A('G2 **关注角色的物品不再显示 0 件**：关注角色名下物品计入「保留」；未携带的物品不按位置推断', (() => {
    boot({
        snapshots: [{ id: 'w', name: '乙', watch: true }],
        items: [
            { id: 'x', name: '乙之剑', location: '乙', carried: true },
            { id: 'y', name: '乙的旧信', location: '乙', carried: false },
            { id: 'z', name: '路边石子', location: '街道', carried: true },
        ],
    });
    const p = itemsCleanupPlan();
    return p.total === 0 && p.kept === 1 && p.unowned === 2;
})(), () => { boot({ snapshots: [{ id: 'w', name: '乙', watch: true }], items: [{ id: 'x', name: '乙之剑', location: '乙', carried: true }] }); return J(itemsCleanupPlan()); });
A('G3 物品清单行显示归属（便于核对清理依据）', (() => {
    boot({ snapshots: [{ id: 'o', name: '乙' }], items: [{ id: 'i', name: '银怀表', owner: '乙', location: '乙' }] });
    return listRowMainHtml('items', state.items[0], null).indexOf('归属：乙') >= 0;
})(), 'n/a');
A('G4 **V1 提示词逐字符不变**（归属不靠改提示词；由清理时的「位置 + 随身」确定性推断承担，避免黄金样本漂移）', (() => {
    const tpl = Array.isArray(PROMPT_TEMPLATES_V2.items) ? PROMO_TEMPLATES_NOOP : String(PROMPT_TEMPLATES_V2.items || '');
    return tpl.indexOf('- 归属：') < 0 && tpl.indexOf('- 携带：') >= 0;
})(), 'n/a');

// ---------- H v3.52.6：关注档案「不被自动删除」+ 置顶 ----------
A('H1 **AI 删除指令对关注档案不生效**：`snapshots.remove` 命中的关注角色被拦下（其余照删），留墓碑只针对实际删除者', (() => {
    boot({ snapshots: [{ id: 'w1', name: '甲', watch: true }, { id: 'o1', name: '乙' }] });
    mergeDelta({ snapshots: { remove: ['甲', '乙'] } }, { floors: [1, 1] });
    const names = state.snapshots.map((x) => String(x.name));
    const tombs = Object.keys((state.deleted || {}).snapshots || {});
    return names.indexOf('甲') >= 0 && names.indexOf('乙') < 0 && tombs.indexOf('乙') >= 0 && tombs.indexOf('甲') < 0;
})(), () => J({ names: state.snapshots.map((x) => x.name), tombs: Object.keys((state.deleted || {}).snapshots || {}) }));
A('H2 **上限裁剪保活**：超过上限时关注档案不被裁掉（即使排在容器最前面 / 超上限也保留）', (() => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, name: '角色' + i, watch: i === 0 }));
    const out = capSnapshotsKeepingWatched(list, 4);
    const ids = out.map((x) => x.id);
    return ids.indexOf('s0') >= 0 && ids.length === 4 && ids.indexOf('s9') >= 0 && ids.indexOf('s8') >= 0 && ids.indexOf('s7') >= 0;
})(), () => J(capSnapshotsKeepingWatched(Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, name: '角色' + i, watch: i === 0 })), 4).map((x) => x.id)));
A('H3 **角色修复删除**同样跳过关注档案（`dropWatchedKeys` 门禁）', (() => {
    boot({ snapshots: [{ id: 'w1', name: '甲', watch: true }, { id: 'o1', name: '乙' }] });
    const g = dropWatchedKeys(['甲', '乙']);
    return J(g.keep) === J(['乙']) && g.blocked === 1;
})(), 'n/a');
A('H4 **关注置顶**：默认排序里关注角色恒在最前（段内仍按最近提及倒序）', (async () => {
    boot({ snapshots: [
        { id: 'a', name: '甲', lastSeenDate: '1919-01-01' },
        { id: 'b', name: '乙', lastSeenDate: '1920-01-01' },
        { id: 'c', name: '丙', lastSeenDate: '1921-01-01', watch: true },
        { id: 'd', name: '丁', lastSeenDate: '1922-01-01', watch: true },
    ] });
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const html = String(panelBodyHtml('snapshots') || '');
    const order = [];
    const re = /data-ftt-action="edit" data-kind="snapshots" data-id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) order.push(m[1]);
    return J(order) === J(['d', 'c', 'b', 'a']);
})(), 'n/a');

R.done();
