// ============================================================
// 单元测试 · v3.1.0「界面渲染成本」（`docs/D13` S1，用户要求「按建议改善性能」）
//
// 本文件把 D13 的三条结论钉成回归：
//   A **只构建当前分页**：一次渲染不再构建全部 13 页（旧实现还构建两遍）；
//   B **一次动作 = 一次构建**：`finalizePanelAction` 复用刚构建的 HTML（旧实现第三次构建）；
//   C **角色页下钻索引化**：`characterDrillHtml` 从「每行扫全库」改为「一次建索引、每行 O(命中数)」，
//     且**输出与旧实现逐字节一致**（用旧路径做参照比对）；顺带把「剧情锚点」提到渲染期算一次。
//
// 运行：node tests/unit/perf-render.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, getStoryNow } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildRowCtx, characterDrillHtml, listRowMainHtml } from '../../ui/list-rows.js';

const R = makeReporter('perf-render v3.1.0 渲染成本：只构建当前页 / 一次动作一次构建 / 下钻索引化');
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
host.ctx.characters = [{ name: '角色甲', avatar: 'perf.png' }];
host.ctx.characterId = 0;
installGlobalHost(host, doc);
setContextProvider(() => host.ctx);
installGlobalFetch(() => ({ status: 404, text: '' }));
const P = await import('../../ui/panel.js');
const entry = await import('../../index.js');

const txt = (n, s) => ('【' + s + '】' + '甲在码头清点铜箱并记账，铜箱成色与银元兑换比例需与账本核对。'.repeat(20)).slice(0, n);
function mkState(k) {
    const o = k || {};
    const st = emptyState();
    st.atoms = Array.from({ length: o.atoms || 0 }, (_, i) => ({ id: 'a-' + i, title: '情节' + i, text: txt(210, 'a' + i), date: '1919-11-01', tags: ['码头'], floorStart: i, floorEnd: i + 1, updatedAt: 1000 + i }));
    st.memories = Array.from({ length: o.memories || 0 }, (_, i) => ({ id: 'm-' + i, owner: '甲', title: '记忆' + i, content: txt(130, 'm' + i), updatedAt: 1000 + i }));
    st.plans = Array.from({ length: o.plans || 0 }, (_, i) => ({ id: 'pl-' + i, title: '计划' + i, content: '送信', status: 'open', updatedAt: 1000 + i }));
    st.suspense = Array.from({ length: o.suspense || 0 }, (_, i) => ({ id: 'su-' + i, title: '悬念' + i, content: '谁在跟踪', status: 'open', updatedAt: 1000 + i }));
    st.snapshots = Array.from({ length: o.snapshots || 0 }, (_, i) => ({
        id: 's-' + i, name: '角色' + i,
        identity: { occupation: '商人', birthDate: '1890-01-0' + ((i % 9) + 1) },
        background: txt(420, 's' + i),
        relationships: [{ name: '乙', relation: '同乡' }],
        uses: 2, updatedAt: 1000 + i,
    }));
    st.currentStates = Array.from({ length: o.states || 0 }, (_, i) => ({ id: 'st-' + i, subject: '甲', field: '体力', value: '尚可' + i, updatedAt: 1000 + i }));
    st.items = Array.from({ length: o.items || 0 }, (_, i) => ({ id: 'i-' + i, name: '物品' + i, text: txt(90, 'i' + i), updatedAt: 1000 + i }));
    st.concepts = Array.from({ length: o.concepts || 0 }, (_, i) => ({ id: 'c-' + i, name: '概念' + i, content: txt(160, 'c' + i), updatedAt: 1000 + i }));
    st.parallels = Array.from({ length: o.parallels || 0 }, (_, i) => ({ id: 'p-' + i, title: '平行' + i, text: txt(320, 'p' + i), updatedAt: 1000 + i }));
    st.links = [];
    for (let i = 0; i < (o.links || 0); i++) {
        st.links.push({ dim: 'memories', refId: 'm-' + (i % Math.max(1, o.memories || 1)), who: '角色' + (i % Math.max(1, o.snapshots || 1)), how: ['author', 'witness', 'told', 'rumor'][i % 4] });
    }
    st.updatedAt = Date.now();
    return st;
}
function boot(k) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('perf.png');
    const st = k ? mkState(k) : emptyState();
    setKernelState(st);
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    P.resetPanelRenderStats();
    return st;
}
const med = (fn, n) => { const a = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); a.push(performance.now() - t0); } a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

// ==================== A 组：只构建当前分页 ====================
{
    boot({ atoms: 3, memories: 2, snapshots: 1, items: 1 });
    await P.panelAction('tab', { tab: 'atoms' });
    const cur = P.panelModalInnerHtml();
    const all = P.panelModalInnerHtml({ all: true });
    const other = P.panelModalInnerHtml({ tab: 'memories' });
    const curOk = cur.indexOf('data-ftt-body="atoms"') >= 0 && cur.indexOf('情节列表') >= 0;
    // 其它分页只留**同 id 的占位容器**（无正文）→ 不含其正文特征串
    const noOthers = ['data-ftt-settings-page=', '🗂 场景', '设定 · 基础'].every((needle) => cur.indexOf(needle) < 0);
    const allOk = all.length > cur.length && all.indexOf('data-ftt-settings-page=') >= 0;
    const byTabOk = other.indexOf('记忆') >= 0 && other.indexOf('情节列表') < 0;
    const containers = (cur.match(/data-ftt-body="/g) || []).length;
    R.assert('A1 **只构建当前分页**：一次渲染只把当前页写进正文，其余 12 页只留同 id 占位容器（13 个容器恒在）；`{all:true}` 仍可构建全部 13 页（调试 / 兼容口径）；`{tab}` 可按指定页构建',
        curOk && noOthers && allOk && byTabOk && containers === 13,
        J({ curOk, noOthers, allOk, byTabOk, containers, curLen: cur.length, allLen: all.length }));
}

// ==================== B 组：一次动作 = 一次构建 ====================
const B1 = await (async () => {
    boot({ atoms: 4, memories: 3 });
    await P.panelAction('tab', { tab: 'overview' });
    const b0 = P.panelRenderStats().builds;
    P.renderPanel();
    const b1 = P.panelRenderStats().builds;
    await P.panelAction('refresh', {});
    const b2 = P.panelRenderStats().builds;
    const r3 = await P.panelAction('refresh', {});
    const b3 = P.panelRenderStats().builds;
    const html = String(r3.html || '');
    return {
        renderOnce: b1 - b0 === 1,                 // renderPanel 自身：1 次构建（旧实现 2 次）
        actionOnce: b2 - b1 === 1,                 // 一次动作：+1（旧实现 renderPanel 2 次 + 返回值 1 次 = 3 次）
        actionOnce2: b3 - b2 === 1,
        htmlReused: html === P.panelHtmlBuilt() && html.indexOf('<div class="ftt-modal">') === 0,
        bytes: String(P.panelHtmlBuilt()).length,
    };
})();
R.assert('B1 **一次渲染只构建一遍、一次动作也只多构建一遍**：`renderPanel()` 与每个面板动作都只 +1 次构建（旧实现分别 2 次与 3 次）；动作返回值复用刚构建的 HTML（`panelHtmlBuilt()`），不再重复构串',
    B1.renderOnce && B1.actionOnce && B1.actionOnce2 && B1.htmlReused && B1.bytes > 100,
    B1);

{
    boot({ atoms: 2 });
    const s0 = P.panelRenderStats();
    await P.panelAction('tab', { tab: 'atoms' });
    const s1 = P.panelRenderStats();
    R.assert('B2 渲染观测可用（`docs/D13` S0）：`renders/builds/lastMs/lastBytes/lastTab/maxMs/slow` 逐项更新；`resetPanelRenderStats()` 可清零（调试页与 `FTT.renderStats()` 同源）',
        s1.renders > s0.renders && s1.builds > s0.builds && s1.lastMs >= 0 && s1.lastBytes > 0 && s1.lastTab === 'atoms'
        && s1.maxMs >= s1.lastMs && typeof s1.slow === 'number' && typeof P.PANEL_RENDER_SLOW_MS === 'number'
        && P.resetPanelRenderStats() === true && P.panelRenderStats().renders === 0,
        J({ s0, s1 }));
}

// ==================== C 组：下钻索引化（输出必须与旧实现逐字节一致） ====================
{
    // 构造有区分度的关联：多种 how（含并列名次）、归一化姓名（空格 / 中点）、指向不存在条目的行、无 who 的锚行
    const st = boot({ memories: 12, plans: 5, suspense: 4, snapshots: 6 });
    st.links = [
        { dim: 'memories', refId: 'm-0', who: '角色 0', how: 'witness' },
        { dim: 'memories', refId: 'm-0', who: '角色·0', how: 'author' },     // 同一归一化姓名，更高可靠度 → 胜出
        { dim: 'memories', refId: 'm-1', who: '角色0', how: 'told' },
        { dim: 'memories', refId: 'm-2', who: '角色1', how: 'rumor' },
        { dim: 'memories', refId: 'm-9', who: '角色1', how: 'author' },      // 状态顺序靠后 → 输出顺序按 state 序
        { dim: 'memories', refId: 'm-404', who: '角色1', how: 'author' },    // 目标不存在 → 两侧都应忽略
        { dim: 'memories', refId: 'm-3', who: '', how: '' },                 // 锚行（无 who）
        { dim: 'plans', refId: 'pl-0', who: '角色1', how: 'join' },
        { dim: 'suspense', refId: 'su-1', who: '角色1', how: 'investigating' },
        { dim: 'parallels', refId: 'p-0', who: '角色1', how: 'related' },
    ];
    const ctx = buildRowCtx();
    const mismatches = [];
    for (const s of st.snapshots) {
        const a = characterDrillHtml(s.name, ctx);      // 索引路径
        const b = characterDrillHtml(s.name);           // 旧路径（全量扫描）
        if (a !== b) mismatches.push({ name: s.name, a: a, b: b });
    }
    const hasDrill = st.snapshots.some((s) => characterDrillHtml(s.name, ctx).indexOf('已知') >= 0);
    R.assert('C1 下钻索引化**输出与旧实现逐字节一致**（同一排序：可靠度降序 → 角色字典序；同可靠度保留先出现者；目标不存在的行两侧都忽略；姓名按「去空格 / 中点 + 小写」归一）',
        mismatches.length === 0 && hasDrill,
        J({ mismatches: mismatches.slice(0, 3), hasDrill }));
}

{
    boot({ memories: 6, plans: 4, suspense: 3, snapshots: 3 });
    const st = state;
    st.links = [
        { dim: 'memories', refId: 'm-0', who: '角色0', how: 'author' },
        { dim: 'memories', refId: 'm-1', who: '角色0', how: 'witness' },
        { dim: 'plans', refId: 'pl-0', who: '角色1', how: 'join' },
    ];
    const ctx = buildRowCtx();
    const rowMismatch = [];
    for (const s of st.snapshots) {
        const a = listRowMainHtml('snapshots', s, ctx);
        const b = listRowMainHtml('snapshots', s);
        if (a !== b) rowMismatch.push(s.name);
    }
    R.assert('C2 渲染期「剧情锚点」只算一次（`ctx.anchor`）但**不改变任何一行输出**：年龄 / 年龄依据 / 出生日期异常三类字段在有 ctx 与无 ctx 下逐字节一致（无剧情时钟、锚点需扫全库时也不变）',
        rowMismatch.length === 0 && getStoryNow() === '' ,
        J({ rowMismatch: rowMismatch.slice(0, 3), storyNow: getStoryNow() }));
}

const C3 = (() => {
    // 规模守卫（不是基准测试，只是防「二次增长」回归）
    const st = boot({ atoms: 300, memories: 400, plans: 180, suspense: 180, snapshots: 200, links: 2000 });
    P.panelBodyHtml('snapshots');            // 预热
    const ms = med(() => P.panelBodyHtml('snapshots'), 3);
    return { ms: Math.round(ms), snapshots: st.snapshots.length, links: st.links.length };
})();
R.assert('C3 规模守卫：200 档案 × 400 记忆 × 2000 关联行下，角色页**单页构建** ≤ 500ms（旧实现实测 ≈ 1970ms；本机实测 ≈ 15ms —— 断言给足慢机器余量，只拦二次增长回归）',
    C3.ms <= 500, J(C3));

R.done();
