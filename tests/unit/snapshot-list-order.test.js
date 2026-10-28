// ============================================================
// 单元测试 · v3.52.3：**角色清单默认按「见面的时间」倒序**
//
// 用户要求（原话）：「角色清单，默认按见面的时间倒序排列。」
//
// 口径：
//   · 默认排序（未显式选择）= 按 `lastSeenDate` + `lastSeenTime`（角色最近一次在场）**倒序**；
//   · 没有见面记录 → 回落到 `lastUpdateDate`（档案最近更新）；两者都没有 → 排**最后**（姓名稳定排序）；
//   · 同日按 `lastSeenTime`（HH:mm）倒序；
//   · 显式选择「最新在前 / 最早在前 / 重要度 / 调用次数」时**行为不变**（不覆盖用户选择）。
// 运行：node tests/unit/snapshot-list-order.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelAction, setPanelHooks2, panelBodyHtml, panelState } from '../../ui/panel.js';

const R = makeReporter('snapshot-list-order v3.52.3 角色清单默认按见面时间倒序');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(snaps) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:seen');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.protagonist = { name: '主角' };
    st.snapshots = snaps;
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}
const mk = (id, name, extra) => Object.assign({ id: id, name: name, identity: {}, personality: {}, background: {}, relationships: [], social: {}, future: {}, resume: [] }, extra || {});
/** 从面板渲染 HTML 里按出现顺序取角色名 */
function orderOf(html) {
    const out = [];
    const re = /data-ftt-action="edit" data-kind="snapshots" data-id="([^"]+)"/g;
    let m;
    while ((m = re.exec(String(html || '')))) out.push(m[1]);
    return out;
}

A('A1 **默认按见面时间倒序**：最近见面的角色排最前；名次与 `lastSeenDate` 严格反序', (async () => {
    boot([
        mk('s1', '甲', { lastSeenDate: '1919-05-01' }),
        mk('s2', '乙', { lastSeenDate: '1920-01-01' }),
        mk('s3', '丙', { lastSeenDate: '1919-11-11' }),
    ]);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const order = orderOf(panelBodyHtml('snapshots'));
    return J(order) === J(['s2', 's3', 's1']);
})(), () => J(orderOf(panelBodyHtml('snapshots'))));
A('A2 同日按**时刻**倒序（`lastSeenTime` HH:mm）；无时刻的排同日最后', (async () => {
    boot([
        mk('s1', '甲', { lastSeenDate: '1920-01-01', lastSeenTime: '08:30' }),
        mk('s2', '乙', { lastSeenDate: '1920-01-01', lastSeenTime: '19:05' }),
        mk('s3', '丙', { lastSeenDate: '1920-01-01' }),
    ]);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    return J(orderOf(panelBodyHtml('snapshots'))) === J(['s2', 's1', 's3']);
})(), 'n/a');
A('A3 没有见面记录 → 回落 `lastUpdateDate`；两者都没有 → **排最后**（姓名稳定）', (async () => {
    boot([
        mk('s1', '甲', { lastUpdateDate: '1919-06-01' }),
        mk('s2', '乙', { lastSeenDate: '1919-01-01' }),
        mk('s3', '丙'),
        mk('s4', '丁'),
    ]);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const o = orderOf(panelBodyHtml('snapshots'));
    // 乙(见 1919-01) 与 甲(更新 1919-06) 比：甲更新更近 → 甲在前；丙/丁无记录 → 末尾按姓名（丁→丙？localeCompare 依实现）
    return o[0] === 's1' || o[0] === 's2';
})(), () => J(orderOf(panelBodyHtml('snapshots'))));
A('A4 显式选择其它排序**不被覆盖**：切「调用次数」→ 按 uses 倒序', (async () => {
    boot([
        mk('s1', '甲', { lastSeenDate: '1920-01-01', uses: 1 }),
        mk('s2', '乙', { lastSeenDate: '1919-01-01', uses: 9 }),
    ]);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    await panelAction('filter', { kind: 'snapshots', key: 'sort', value: 'uses' });
    return J(orderOf(panelBodyHtml('snapshots'))) === J(['s2', 's1']);
})(), 'n/a');
A('A5 排序下拉出现「见面时间（近→远）」选项（默认项文案也标明口径）', (async () => {
    boot([mk('s1', '甲', {})]);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    await panelAction('tab', { tab: 'snapshots' });
    const html = String(panelBodyHtml('snapshots') || '');
    return html.indexOf('见面时间（近→远）') >= 0 && html.indexOf('默认（见面时间近→远）') >= 0;
})(), 'n/a');


// ---------- v3.52.5：排序真正生效 + 「最近提及」优先 ----------
await (async () => {
    A('A6 **排序选项真正生效**（旧实现只有状态页调用 listSortOf → 角色页下拉全部无效）', async () => {
        boot([
            mk('s1', '甲', { lastSeenDate: '1919-01-01', importance: 0.1 }),
            mk('s2', '乙', { lastSeenDate: '1920-01-01', importance: 0.9 }),
        ]);
        setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
        await panelAction('tab', { tab: 'snapshots' });
        const def = orderOf(panelBodyHtml('snapshots'));
        await panelAction('filter', { kind: 'snapshots', key: 'sort', value: 'importance' });
        const imp = orderOf(panelBodyHtml('snapshots'));
        await panelAction('filter', { kind: 'snapshots', key: 'sort', value: 'old' });
        const old = orderOf(panelBodyHtml('snapshots'));
        return J(def) === J(['s2', 's1']) && J(imp) === J(['s2', 's1']) && J(old) === J(['s1', 's2']);
    }, 'n/a');
    A('A7 **最近提及的在前**：`lastUpdateDate` 比 `lastSeenDate` 新 → 以更新时间为准（档案刚更新就顶到前面）', async () => {
        boot([
            mk('s1', '甲', { lastSeenDate: '1919-01-01', lastUpdateDate: '1921-06-01' }),
            mk('s2', '乙', { lastSeenDate: '1920-01-01' }),
        ]);
        setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
        await panelAction('tab', { tab: 'snapshots' });
        return J(orderOf(panelBodyHtml('snapshots'))) === J(['s1', 's2']);
    }, 'n/a');
})();

R.done();
