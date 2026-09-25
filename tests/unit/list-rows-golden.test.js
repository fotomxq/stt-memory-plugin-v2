// ============================================================
// 单元测试 · v2.47.0「数据面板各大类列表：内容与顺序对齐 V1」
// 用户报告：「情节等大类面板列表显示内容不全，请参照 V1 展示对应内容，**注意展示顺序**。」
//
// 背景：V2 此前所有维度都用同一句 `entrySummary()`（title→name→content→text→subject，截 90 字）+ 一行 meta，
//   各维度自有字段（情节类型/楼层/有效性与标签、记忆知情徽标与分类、角色档案正文与年龄、物品数量与所在地、
//   货币额度与流水、传言阶段/客观性/载体/链路、计划目标时间与进度、平行卦象/源起/目标概率、概念来源与被引用…）
//   全部缺失；排序也不是 V1 的 `sortRecent`（剧情日期倒序 → floorEnd 倒序）。
//
// oracle：`tests/fixtures/v1-golden-list-rows.json`（生成器 `gen-v1-golden-list-rows.cjs`，真实 V1 v1.206；
//   对每个维度取该条目的行 HTML → 去掉全部按钮 → 去标签 → 分词；现实墙钟归一 `<WALL>`，两次运行逐字节一致）。
// 覆盖：
//   R 组：oracle 自证（V1 行里确有各维度自有字段）；
//   V 组：**逐维度、逐条目**比对行正文文本序列（字段集合 + **先后顺序**）；
//   O 组：**排序** —— 列表按剧情日期倒序、无日期靠后、同类按 floorEnd 倒序（V1 `sortRecent`）；
//   S 组：可见范围 —— 计划/悬念只列 `status==='open'`；情节默认隐藏「已总结」项（`👁 显示已总结` 后出现）；
//   D 组：**下钻与引用**（角色页已知记忆/参与计划/在查悬念、概念页被记忆引用）在同一行内出现。
// 运行：node tests/unit/list-rows-golden.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelBodyHtml, panelAction, panelState, setPanelHooks2, openPanel } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-list-rows.json'), 'utf8'));
const R = makeReporter('list-rows-golden v2.47.0 大类列表内容与顺序（V1 对齐）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

function boot() {
    Object.assign(cfg, clone(defaultCfg));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false;
    cfg.clockAutoPatrol = false;
    cfg.importanceBase = 0.12; cfg.importancePerUse = 0.06;
    setScopeKey('甲');
    setLastMessageId(5);
    setKernelState(Object.assign(emptyState(), clone(G.sample)));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
}
boot();
openPanel('plans');

// ---------- 与生成器完全相同的取法（保证两端同口径） ----------
function balancedSlice(html, at, tag) {
    const re = new RegExp('<' + tag + '\\b|</' + tag + '>', 'g');
    re.lastIndex = at;
    let depth = 0, m;
    while ((m = re.exec(html)) !== null) {
        if (m[0].charAt(1) === '/') depth -= 1; else depth += 1;
        if (depth === 0) return html.slice(at, m.index + m[0].length);
    }
    return html.slice(at);
}
/** 行正文文本序列（去按钮 → 去标签 → 分词；现实墙钟归一 `<WALL>`） */
function rowTokens(html, id) {
    const s = String(html || '');
    let at = s.indexOf('data-ftt-id="' + id + '"');
    if (at < 0) at = s.indexOf('data-id="' + id + '"');
    if (at < 0) return null;
    const start = s.lastIndexOf('<div class="ftt-item', at);
    const row = balancedSlice(s, start < 0 ? at : start, 'div');
    const text = row
        .replace(/<button[\s\S]*?<\/button>/g, ' ')
        .replace(/<input[^>]*>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/现实更新\s+[^·]+/g, '现实更新 <WALL>')
        .replace(/\s+/g, ' ').trim();
    return text ? text.split(' ').filter(Boolean) : [];
}
/** 带搜索词的场景树（走面板的搜索槽 + 场景页渲染） */
function scenesTreeSearch(q) {
    psQSet('scenes', q);
    const html = panelBodyHtml('scenes');
    psQSet('scenes', '');
    return String(html);
}
function psQSet(kind, q) {
    // 面板搜索词槽通过 `search` 动作写入（与真实交互同路径）；此处直接调用动作以保持同构
    try { void panelAction('search', { kind: kind, q: q }); } catch (e) { /* 忽略 */ }
}

/** HTML 实体回解（断言用：属性里的 `>` 会被写成 `&gt;`，浏览器 dataset 读回的是解码值） */
const unesc = (h) => String(h || '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const pageOf = (dim) => {
    if (dim === 'states') return panelBodyHtml('states');
    if (dim === 'plans' || dim === 'suspense') return panelBodyHtml('plans');
    return panelBodyHtml(dim);
};

// ---------- R 组：oracle 自证 ----------
A('R1 oracle 自证：V1 的行里确有各维度**自有字段**（不是一句摘要）', (() => {
    const d = G.dims;
    const has = (dim, id, needle) => (d[dim][id] || []).join(' ').indexOf(needle) >= 0;
    return has('atoms', 'a1', '主线') && has('atoms', 'a1', '3-5楼') && has('atoms', 'a1', '重要度24%')
        && has('atoms', 'a1', '#码头') && has('atoms', 'a2', '⚠️不确定')
        && has('memories', 'm1', '公开事实') && has('memories', 'm1', '事实')
        && has('snapshots', 's1', '出生日期：1900-03-04') && has('snapshots', 's1', '年龄：19岁')
        && has('items', 'i1', '×1（城市甲·码头）') && has('items', 'i2', '（无标签')
        && has('currencies', 'c1', '原始额度') && has('currencies', 'c1', '收入')
        && has('rumors', 'r1', '发酵度') && has('rumors', 'r1', '传导链路')
        && has('plans', 'p1', '进度') && has('suspense', 'x1', '揭晓条件')
        && has('concepts', 'cc1', '被记忆引用') && has('parallels', 'pa1', '源起')
        && has('states', 'st1', '调用2次');
})(), J(Object.keys(G.dims)));

// ---------- V 组：逐维度逐条目比对 ----------
const plan = [['atoms', 'a1'], ['atoms', 'a2'], ['atoms', 'a3'], ['memories', 'm1'], ['memories', 'm2'],
    ['snapshots', 's1'], ['items', 'i1'], ['items', 'i2'], ['currencies', 'c1'], ['rumors', 'r1'],
    ['plans', 'p1'], ['suspense', 'x1'], ['concepts', 'cc1'], ['parallels', 'pa1'], ['states', 'st1']];
const diffs = [];
for (const [dim, id] of plan) {
    const want = G.dims[dim][id];
    const got = rowTokens(pageOf(dim), id);
    if (J(got) !== J(want)) diffs.push({ dim, id, got, want });
}
A('V1 行正文**逐维度逐条目**与 V1 oracle 一致（字段集合 + 先后顺序；现实墙钟归一）', diffs.length === 0, J(diffs.slice(0, 3)));

A('V2 各维度行**都含自有字段**（不是摘要兜底）：抽查每维至少一个特征串', (() => {
    const h = (dim) => String(pageOf(dim) || '');
    return h('atoms').indexOf('· 主线 · ') >= 0 && h('atoms').indexOf('楼 · 调用') >= 0 && h('atoms').indexOf('重要度') >= 0
        && h('memories').indexOf('ftt-badge--public">公开事实') >= 0 && h('memories').indexOf('概念：码头规矩') >= 0
        && h('snapshots').indexOf('出生日期：1900-03-04') >= 0 && h('snapshots').indexOf('年龄：19岁') >= 0
        && h('items').indexOf('×1（城市甲·码头）') >= 0 && h('items').indexOf('（无标签') >= 0
        && h('currencies').indexOf('原始额度') >= 0 && h('currencies').indexOf('收支'.length ? '定金' : '') >= 0
        && h('rumors').indexOf('传导链路') >= 0 && h('plans').indexOf('进度 40%') >= 0
        && h('plans').indexOf('揭晓条件：找到刻记号的人') >= 0 && h('concepts').indexOf('被记忆引用') >= 0
        && h('parallels').indexOf('⚡ 源起') >= 0 && h('states').indexOf('更新 1919-11-25 傍晚') >= 0;
})(), '');

// ---------- O 组：排序（V1 sortRecent） ----------
A('O1 排序 = V1 `sortRecent`：剧情日期倒序 → 无日期靠后 → 同类按 floorEnd 倒序（情节/记忆/物品/概念逐页核对）', (() => {
    boot();
    const order = (dim, ids) => ids.map((id) => String(pageOf(dim).indexOf('data-id="' + id + '"'))).map(Number)
        .every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]));
    // 情节：a1(11-20) > a2(11-18) > a3(11-16)
    const atomsOk = order('atoms', ['a1', 'a2', 'a3']);
    // 记忆：m1(11-20) > m2(11-19)
    const memOk = order('memories', ['m1', 'm2']);
    // 物品：i1(floorEnd 5) > i2(floorEnd 3)
    const itemOk = order('items', ['i1', 'i2']);
    return atomsOk && memOk && itemOk;
})(), (() => {
    boot();
    const html = pageOf('atoms');
    return J(['a1', 'a2', 'a3'].map((id) => [id, html.indexOf('data-id="' + id + '"')]));
})());

A('O2 无日期条目排在**有日期条目之后**（V1 `sortRecent`：`da && !db → -1`）', (() => {
    boot();
    const list = state.memories;
    list.push({ id: 'm9', title: '无日期记忆', content: '没有日期。', date: '', uses: 0, floorEnd: 99 });
    const html = pageOf('memories');
    const m1 = html.indexOf('data-id="m1"');
    const m9 = html.indexOf('data-id="m9"');
    return m1 >= 0 && m9 > m1;
})(), (() => {
    boot();
    state.memories.push({ id: 'm9', title: '无日期记忆', content: '没有日期。', date: '', uses: 0, floorEnd: 99 });
    const html = pageOf('memories');
    return J(['m1', 'm2', 'm9'].map((id) => [id, html.indexOf('data-id="' + id + '"')]));
})());

// ---------- S 组：可见范围 ----------
A('S1 计划/悬念只列 `status === "open"`（V1 `openPlansAll/openSuspAll`）', (() => {
    boot();
    state.plans.push({ id: 'p9', title: '已完结计划', content: '', status: 'done', date: '1919-11-10' });
    state.suspense.push({ id: 'x9', title: '已揭晓悬念', content: '', status: 'resolved', date: '1919-11-10' });
    const html = pageOf('plans');
    return html.indexOf('data-id="p1"') >= 0 && html.indexOf('data-id="p9"') < 0
        && html.indexOf('data-id="x1"') >= 0 && html.indexOf('data-id="x9"') < 0;
})(), '');

A('S2 情节默认隐藏**真正已总结**项（`hidden:true` / `summarizedBy`，V1 `atomIsHidden`）→ 切换后出现', (() => {
    boot();
    state.atoms.push({ id: 'a4', text: '被合并隐藏的原文。', type: '主线', date: '1919-11-15', floorStart: 0, floorEnd: 1, uses: 0, hidden: true });
    const before = pageOf('atoms');
    return before.indexOf('data-id="a4"') < 0 && before.indexOf('data-id="a1"') >= 0;
})(), (() => {
    boot();
    state.atoms.push({ id: 'a4', text: '被合并隐藏的原文。', date: '1919-11-15', floorStart: 0, floorEnd: 1, uses: 0, hidden: true });
    return J({ hasA4: pageOf('atoms').indexOf('data-id="a4"') >= 0, toggle: pageOf('atoms').indexOf('显示已总结') >= 0 });
})());

await (async () => {
    boot();
    state.atoms.push({ id: 'a4', text: '被合并隐藏的原文。', type: '主线', date: '1919-11-15', floorStart: 0, floorEnd: 1, uses: 0, hidden: true });
    await panelAction('atomToggleHidden', {});
    const after = pageOf('atoms');
    A('S3 切换「👁 显示已总结」后隐藏情节出现，且带「🙈已总结隐藏」标记（V1 `hiddenTag`）',
        after.indexOf('data-id="a4"') >= 0 && after.indexOf('🙈已总结隐藏') >= 0,
        J({ hasA4: after.indexOf('data-id="a4"') >= 0, hiddenTag: after.indexOf('🙈已总结隐藏') >= 0 }));
})();

// ---------- T 组：场景树（V1 `scenesHtml()` 聚合树） ----------
A('T1 场景页 = **聚合树**：按 `pathArr` 聚合出中间层级（虚节点仅展示）、子级缩进、节点带路径标记', (() => {
    boot();
    state.scenes = [
        { id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '水汽很重。', tags: ['水边'], uses: 2, importance: 0.1, pathStr: '城市甲>码头' },
        { id: 'sc2', name: '钟鼓楼', pathArr: ['城市甲', '钟鼓楼'], desc: '楼高五层。', tags: [], uses: 0, pathStr: '城市甲>钟鼓楼' },
        { id: 'sc3', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], desc: '', tags: [], uses: 1, pathStr: '城市甲>码头>里屋' },
    ];
    const html = unesc(pageOf('scenes'));
    return html.indexOf('data-ftt-scene-node="城市甲"') >= 0
        && html.indexOf('data-ftt-scene-node="城市甲>码头"') >= 0
        && html.indexOf('data-ftt-scene-node="城市甲>码头>里屋"') >= 0
        && html.indexOf('共 3 个场景节点') >= 0
        && html.indexOf('class="ftt-scene-children"') >= 0
        && html.indexOf('➕子') >= 0
        && html.indexOf('调用2次') >= 0 && html.indexOf('重要度') >= 0;
})(), (() => { boot(); state.scenes = [{ id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '水汽很重。', tags: [], uses: 2, pathStr: '城市甲>码头' }]; return J(pageOf('scenes').slice(0, 200)); })());

A('T2 当前位置高亮：`state.state.location` 与路径匹配 → 「📍 当前」+ 亮色分支（含祖先）', (() => {
    boot();
    state.state.location = '城市甲·码头';
    state.scenes = [
        { id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '', tags: [], uses: 0, pathStr: '城市甲>码头' },
        { id: 'sc2', name: '钟鼓楼', pathArr: ['城市甲', '钟鼓楼'], desc: '', tags: [], uses: 0, pathStr: '城市甲>钟鼓楼' },
    ];
    const html = pageOf('scenes');
    return html.indexOf('📍 当前：城市甲·码头（亮色分支 = 当前位置）') >= 0
        && html.indexOf('📍 当前</span>') >= 0
        && html.indexOf('rgba(240,192,96,0.15)') >= 0;
})(), (() => { boot(); state.state.location = '城市甲·码头'; state.scenes = [{ id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '', tags: [], uses: 0 }]; const h = pageOf('scenes'); return J({ note: h.indexOf('亮色分支') >= 0, badge: h.indexOf('📍 当前</span>') >= 0 }); })());

A('T3 折叠入口存在（`data-ftt-scene-caret-for` + `data-ftt-scene-children` 成对）；搜索命中保留祖先路径', (() => {
    boot();
    state.scenes = [
        { id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '', tags: [], uses: 0 },
        { id: 'sc2', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], desc: '有铜箱。', tags: [], uses: 0 },
    ];
    const html = unesc(pageOf('scenes'));
    const caretOk = html.indexOf('data-ftt-scene-caret-for="城市甲>码头"') >= 0 && html.indexOf('data-ftt-scene-children="城市甲>码头"') >= 0;
    // 搜索「铜箱」→ 只保留 里屋 及其祖先（城市甲 / 码头）
    boot();
    state.scenes = [
        { id: 'sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '', tags: [], uses: 0 },
        { id: 'sc2', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], desc: '有铜箱。', tags: [], uses: 0 },
        { id: 'sc9', name: '别处', pathArr: ['城市乙', '别处'], desc: '无关。', tags: [], uses: 0 },
    ];
    const filtered = scenesTreeSearch('铜箱');
    return caretOk && filtered.indexOf('里屋') >= 0 && filtered.indexOf('城市甲') >= 0 && filtered.indexOf('别处') < 0;
})(), '');

// ---------- D 组：下钻与引用 ----------
A('D1 角色页行含「下钻」块（已知记忆 / 参与计划 / 在查悬念，V1 `relCharacterDrillHtml`）', (() => {
    boot();
    const html = pageOf('snapshots');
    return html.indexOf('🧠 已知 1 条（目击 1）《乙的秘密》') >= 0
        && html.indexOf('📋 参与计划 1（策划 1）《查清铜箱来路》') >= 0
        && html.indexOf('🔍 在查/知情悬念 1') >= 0;
})(), (() => { boot(); const h = pageOf('snapshots'); return J(h.slice(h.indexOf('🧠') - 40, h.indexOf('🧠') + 160)); })());

A('D2 概念页行含「← 被记忆引用 N 条：《…》」（V1 `relConceptRefHtml`）', (() => {
    boot();
    const html = pageOf('concepts');
    return html.indexOf('← 被记忆引用 1 条：《铜箱归属》') >= 0;
})(), (() => { boot(); const h = pageOf('concepts'); return J(h.slice(h.indexOf('←'), h.indexOf('←') + 80)); })());

A('D3 关系入口不重复：记忆页每条记忆**恰好一个** 🔗 关联（行内渲染，V1 位置），面板不再追加第二个', (() => {
    boot();
    const html = pageOf('memories');
    const total = String(html).split('data-ftt-action="relJump"').length - 1;
    const rows = state.memories.length;
    return total === rows;
})(), (() => {
    boot();
    const html = pageOf('memories');
    return J({ relJump: String(html).split('data-ftt-action="relJump"').length - 1, rows: state.memories.length });
})());

boot();
un();
R.done();
