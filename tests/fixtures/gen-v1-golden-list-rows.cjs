'use strict';
// ============================================================
// v2.47.0 oracle：「数据面板各『大类』列表行」的内容与顺序对照样本
//   → tests/fixtures/v1-golden-list-rows.json
// 目的：用户报告「情节等大类面板列表显示内容不全，请参照 V1 展示对应内容，**注意展示顺序**」——
//   把 **V1 v1.206 各维度行渲染器**输出的**正文文本序列**固化成可复查证据（剔除操作按钮），
//   供 V2 断言「同一份数据、同一顺序、同样的字段」。
// 取法：对每个维度，boot 一个全新 V1 实例 → 写入固定样本 state → 调 `F.<dim>Html()` →
//   用 `data-ftt-id="<id>"` 定位该条目的行 → 去掉 `<div class="ftt-item-ops">…</div>` → 去标签 → 压平空白 → 分词。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

/** 固定样本（与 V2 单测完全一致；日期固定 → 相对时间标注可复现） */
const SAMPLE = {
    story: { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'] },
    atoms: [
        {
            id: 'a1', title: '码头交货', text: '甲把铜箱交给乙，收下定金。', type: '主线', date: '1919-11-20', time: '傍晚',
            floorStart: 3, floorEnd: 5, uses: 2, tags: ['码头', '交易'], validity: 'active', locations: ['城市甲·码头'], importance: 0.2,
        },
        {
            id: 'a2', text: '乙在钟鼓楼下等了一整夜，天亮才离开。', type: '支线', date: '1919-11-18',
            floorStart: 1, floorEnd: 2, uses: 0, tags: ['钟鼓楼'], validity: 'uncertain',
        },
        {
            id: 'a3', title: '合并总结', text: '合并总结（覆盖前两条）', type: '总结', date: '1919-11-16',
            floorStart: 0, floorEnd: 1, uses: 1, tags: [], validity: 'active',
            mergedSummary: { by: 'manual', sourceCount: 2, label: '码头线' },
        },
    ],
    memories: [
        { id: 'm1', title: '铜箱归属', content: '铜箱原属丙，后被甲取得。', date: '1919-11-20', uses: 3, owner: '通用', tags: ['铜箱'], memCategory: '事实', floorEnd: 5 },
        { id: 'm2', title: '乙的秘密', content: '乙在夜里去过码头。', date: '1919-11-19', uses: 1, owner: '乙', tags: ['秘密'], memCategory: '私密', floorEnd: 4 },
    ],
    snapshots: [
        {
            id: 's1', name: '甲', uses: 4, tags: ['主角'], floorEnd: 5,
            identity: { gender: '男', birthDate: '1900-03-04', species: '人类', occupation: '商贩', title: '小掌柜', family: '甲家', deceased: false },
            personality: { traits: ['谨慎'], quirks: ['数铜钱'], values: ['守信'], speechStyle: '简短' },
            background: { origin: '城市甲', history: '自幼在码头长大。' },
            relationships: [{ name: '乙', relation: '同伴', attitude: '信任' }],
            social: { relationToUser: '雇主', attitudeToUser: '恭敬' },
            future: { todos: ['查账'], commitments: ['保乙周全'] },
            lastUpdateDate: '1919-11-24', lastUpdateTime: '夜里', lastSeenDate: '1919-11-25', lastSeenTime: '傍晚',
        },
    ],
    items: [
        { id: 'i1', name: '铜箱', qty: 1, location: '城市甲·码头', carried: true, desc: '沉甸甸的木箱。', tags: ['货物'], uses: 2, floorEnd: 5 },
        { id: 'i2', name: '铜钥匙', desc: '开箱用。', tags: [], uses: 0, floorEnd: 3 },
    ],
    currencies: [
        { id: 'c1', name: '银元', amount: 12.5, unit: '枚', owner: '甲', note: '定金与余款', uses: 2, date: '1919-11-20', tags: ['货款'], history: [{ date: '1919-11-18', delta: -2, note: '买绳' }, { date: '1919-11-20', delta: 5, note: '定金' }] },
    ],
    rumors: [
        {
            id: 'r1', subject: '码头夜里有人搬货', content: '据说码头半夜有船靠岸。', stage: '发酵', objectivity: '主观', ferment: 3,
            uses: 1, date: '1919-11-21', source: '酒馆', tags: ['码头'],
            carriers: [{ who: '酒保', role: '传播者' }], media: [{ type: '口耳', name: '茶摊', at: '1919-11-21', active: true }],
            chain: [{ at: '1919-11-21', kind: '传播', note: '酒保说给船工' }], lineage: { generation: 1 }, parallelRefs: ['p1'],
        },
    ],
    plans: [
        { id: 'p1', title: '查清铜箱来路', content: '去仓库核对账册。', date: '1919-11-22', characters: ['甲', '乙'], targetTime: '1919-12-01', status: 'open', phase: 'blocked', statusNote: '缺账册', progress: 40, steps: [{ done: true }, { done: false }], tags: ['主线'], floorEnd: 5 },
    ],
    suspense: [
        { id: 'x1', title: '铜箱是谁的', content: '箱底的记号来自何处。', date: '1919-11-20', characters: ['甲'], resolveTime: '1919-12-05', status: 'open', clues: [{ text: '记号' }], resolveCondition: '找到刻记号的人', tags: ['悬念'], floorEnd: 4 },
    ],
    concepts: [
        { id: 'cc1', name: '码头规矩', content: '先来后到。', source: '船工', date: '1919-11-15', uses: 1, tags: ['规则'], floorEnd: 2 },
    ],
    parallels: [
        {
            id: 'pa1', title: '乙独自去了城南', text: '乙没去码头，而是去了城南。', gua: '坎为水', type: '推演', date: '1919-11-20', time: '夜里',
            location: '城南', characters: ['乙'], causalLine: '因为甲改了主意', goalOdds: [{ target: '查清账册', likelihood: 60 }],
            uses: 2, tags: ['支线'], floorEnd: 5, updatedAt: 1790000000000,
            sourceRefs: ['a1'], previews: ['乙在城南遇见丙'], constraintNote: '不得与主线冲突',
        },
    ],
    currentStates: [
        { id: 'st1', subject: '甲', field: '体力', value: '疲惫', uses: 2, updatedAt: '1919-11-25', updatedAtTime: '傍晚', floorEnd: 5 },
    ],
    links: [
        { id: 'l1', dim: 'memories', refId: 'm1', who: '', public: true, conceptRef: '码头规矩', how: 'anchor' },
        { id: 'l2', dim: 'memories', refId: 'm2', who: '甲', how: 'witness', view: '只看到木箱' },
        { id: 'l3', dim: 'plans', refId: 'p1', who: '甲', how: 'author' },
        { id: 'l4', dim: 'suspense', refId: 'x1', who: '甲', how: 'involved' },
        { id: 'l5', dim: 'parallels', refId: 'pa1', who: '乙', how: 'related' },
    ],
};

async function boot() {
    const env = makeTavernEnv({});
    const F = await loadPlugin(env);
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false; F.cfg.clockForceDegrade = false;
    F.cfg.importanceBase = 0.12; F.cfg.importancePerUse = 0.06;
    F.state = Object.assign({}, F.state, proj(SAMPLE));
    return F;
}

/** 平衡切片：从 `at` 处的元素开始，取到同层闭合（用于精确取「一行」） */
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

/**
 * 行正文文本序列：定位 `data-ftt-id="<id>"` → 取该行（平衡切片）→ **去掉全部按钮/输入**（两侧对称）
 * → 去标签 → 压平空白 → 分词。
 */
function rowTokens(html, id) {
    const s = String(html || '');
    const at = s.indexOf('data-ftt-id="' + id + '"');
    if (at < 0) return null;
    const start = s.lastIndexOf('<div class="ftt-item"', at);
    const row = balancedSlice(s, start < 0 ? at : start, 'div');
    const text = row
        .replace(/<button[\s\S]*?<\/button>/g, ' ')
        .replace(/<input[^>]*>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/现实更新\s+[^·]+/g, '现实更新 <WALL>')      // 现实墙钟随环境/时区变化 → 归一
        .replace(/\s+/g, ' ').trim();
    return text ? text.split(' ').filter(Boolean) : [];
}

(async function main() {
    const F = await boot();
    const out = {
        meta: {
            v1Version: 'v1.206',
            generatedBy: 'tests/fixtures/gen-v1-golden-list-rows.cjs',
            note: '各「大类」列表行的**正文文本序列**（已剔除操作按钮）：V2 v2.47.0 起按同一字段集合与顺序渲染，逐维断言一致。',
        },
        sample: proj(SAMPLE),
        dims: {},
        unavailable: [],
    };
    const plan = [
        ['atoms', 'a1'], ['atoms', 'a2'], ['atoms', 'a3'],
        ['memories', 'm1'], ['memories', 'm2'],
        ['snapshots', 's1'],
        ['items', 'i1'], ['items', 'i2'],
        ['currencies', 'c1'],
        ['rumors', 'r1'],
        ['plans', 'p1'],
        ['suspense', 'x1'],
        ['concepts', 'cc1'],
        ['parallels', 'pa1'],
        ['states', 'st1'],
    ];
    const pageOf = {
        atoms: 'atomsHtml', memories: 'memoriesHtml', snapshots: 'snapshotsHtml', items: 'itemsHtml',
        currencies: 'currenciesHtml', rumors: 'rumorsHtml', plans: 'plansHtml', suspense: 'plansHtml',
        concepts: 'conceptsHtml', parallels: 'parallelsHtml', states: 'statesHtml',
    };
    const cache = {};
    for (const [dim, id] of plan) {
        const fn = pageOf[dim];
        if (typeof F[fn] !== 'function') { out.unavailable.push(dim + ':' + fn); continue; }
        if (!cache[dim]) {
            try { cache[dim] = String(F[fn]() || ''); } catch (e) { out.unavailable.push(dim + ':ERR:' + String(e.message)); cache[dim] = ''; }
        }
        const tokens = rowTokens(cache[dim], id);
        out.dims[dim] = out.dims[dim] || {};
        out.dims[dim][id] = tokens;
    }
    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();
