'use strict';
// ============================================================
// oracle（AI 独立分组抽取 + 被动调度接线）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-separate-dim.json
//   被测（V1 事实源，行号取自 v1.206）：
//     · `runSummarySeparate(floorText, floorRange, silent)`（14785~14837）——独立分组：按维度分别构造提示词、
//       **并行**调用 AI（`cfg.dimensionPresets[维度]` 指定预设，未指定回主配置）、逐组 `mergeDelta`、
//       每组独立计成功/失败、成功后 `scheduleParallelWeave(floorRange, jsExtractKeywords(floorText))`；
//     · 分段路径分支 `if (cfg.dimensionGrouping === 'separate') { const results = await runSummarySeparate(...) }`（15477~15485）；
//     · `jsExtractKeywords(text)`（11213~11232）——被动推演关键词（JS 本地抽取，零 AI）；
//     · `scheduleParallelWeave(floorRange, keywords)`（13018~13051）——1.8s 防抖 + 间隔闸门 + 已在调度即静默丢弃。
//   覆盖：
//     ① 分组构造（启用=各自单组 / 未启用=合成一个「统一」组）+ 组序 + 每组提示词（**逐字符**，取自真实请求体）；
//     ② `dimensionPresets[维度]` 参与方式（命中预设 → 走预设的 url/model；未指定 → 主配置）；
//     ③ 并行失败互不影响（fetch 抛错 / HTTP 500 / 无该维度数据 三种失败，各自只影响自己那组，无未捕获 rejection）；
//     ④ 逐组 `mergeDelta` 计数（同一份「全维度」响应喂给每组，只有该组的切片落库）；
//     ⑤ 合并成功后触发 `scheduleParallelWeave` 的**轮次与参数**（间隔未到 → 每个成功组各一次；正常 → 1 个 1.8s 定时器，
//        驱动该定时器可观测到真实传入的关键词与楼层区间）+ `jsExtractKeywords` 输出。
// 纪律：日志走 stderr（在 loadPlugin 之前覆写 console）、stdout 只输出 JSON、结尾 process.exit(0)、
//   连跑两次逐字节一致（定时器由本脚本接管，不使用真实等待）。
// 运行：node tests/fixtures/gen-v1-golden-separate-dim.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}

// ---------- 场景（确定性） ----------
const FLOOR_TEXT = '[第3楼 AI] 甲在码头清点货物，铜箱的锁完好。\n[第4楼 AI] 甲把铜箱搬进仓库。';
const FLOOR_RANGE = { start: 3, end: 4 };
const SEED = {
    protagonist: '甲',
    state: { date: '1919-11-29', time: '傍晚', location: '码头' },
    atoms: [{ id: 'seed-a0', title: '旧事', text: '甲曾在码头搬运铜箱。', date: '1919-11-20', tags: ['码头', '铜箱'], keywords: [], uses: 0, floorStart: 0, floorEnd: 1 }],
    memories: [], currentStates: [], snapshots: [], items: [], plans: [], suspense: [],
    scenes: [], concepts: [], parallels: [{ id: 'seed-p0', title: '铜箱去向', gua: '坎', causalLine: '铜箱被转手', characters: ['甲'], tags: ['铜箱'], keywords: [], date: '1919-11-20', floorStart: 0, floorEnd: 1, uses: 0 }],
    currencies: [], rumors: [], npcs: [], links: [], plotSegments: [], vars: {}, deleted: {}, deletedH: {}, stats: {},
    weaveLastFloor: -1, processedFloors: [],
};
const CFG = {
    enabled: true,
    apiType: 'custom',
    apiUrl: 'https://main.example/v1',
    apiKey: 'key-main',
    model: 'model-main',
    proxyPreset: '',
    apiTemperature: 0.2,
    apiMaxTokens: '',
    apiTopP: '',
    activeApiPreset: '',
    apiPresets: { '预设甲': { apiType: 'custom', apiUrl: 'https://preset-a.example/v1', apiKey: 'key-a', model: 'model-A', proxyPreset: '' } },
    dimensionGrouping: 'separate',
    // V1 口径：`cfg.dimensionEnabled[d]` **真值**才各自成组；其余合成一个「统一」组（v1.206 14786~14787）
    dimensionEnabled: { atoms: true, states: true, plans: true },
    dimensionPresets: { states: '预设甲' },
    parallelWeaveEnabled: true,
    parallelWeaveInterval: 0,
    parallelDecayEnabled: false,
};
/** 全维度「厨房水槽」响应：每组都拿到同一份，只有自己的切片应落库（验证逐组 mergeDelta） */
const KITCHEN_SINK = {
    atoms: { add: [{ title: '清点', text: '甲在码头清点货物并把铜箱搬进仓库（正文足够长）。', date: '1919-11-29' }] },
    states: { add: [{ subject: '甲', field: '位置', value: '仓库' }] },
    snapshots: { add: [{ name: '甲', identity: { 职业: '脚夫' } }] },
    memories: { add: [{ owner: '甲', title: '铜箱', content: '甲记得铜箱的锁完好。', date: '1919-11-29' }] },
    items: { add: [{ name: '铜箱', note: '锁完好' }] },
    plans: { add: [{ content: '清点完毕后再决定' }] },
    suspense: { add: [{ content: '铜箱里装的是什么？' }] },
    scenes: { add: [{ name: '仓库', pathArr: ['仓库'], pathStr: '仓库' }] },
    concepts: { add: [{ name: '脚夫规矩', text: '码头脚夫的规矩。' }] },
    currencies: { add: [{ owner: '甲', name: '银元', amount: 12, unit: '枚', date: '1919-11-29' }] },
    rumors: { add: [{ content: '码头夜里有人搬箱子。' }] },
};
/** 中文键版「厨房水槽」：V1 独立分组在 `mergeDelta` **之前**按原始键切片 → 中文键全部判「无该维度数据」 */
const CN_KITCHEN_SINK = {
    情节: { add: [{ 标题: '清点', 正文: '甲在码头清点货物。', 日期: '1919-11-29' }] },
    状态记录: { add: [{ 主体: '甲', 字段: '位置', 值: '仓库' }] },
    角色档案: { add: [{ 姓名: '甲' }] },
    记忆库: { add: [{ 归属: '甲', 标题: '铜箱', 正文: '甲记得铜箱的锁完好。' }] },
    物品库: { add: [{ 名称: '铜箱' }] },
    计划库: { add: [{ 内容: '清点完毕后再决定' }] },
    场景库: { add: [{ 名称: '仓库' }] },
    概念库: { add: [{ 名称: '脚夫规矩' }] },
    货币: { add: [{ 归属: '甲', 名称: '银元', 额度: 12 }] },
    传言: { add: [{ 内容: '码头夜里有人搬箱子。' }] },
};
const resp = (content) => {
    const payload = { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
    return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(payload)); }, async text() { return JSON.stringify(payload); } };
};
const httpErr = (status, text) => ({ ok: false, status, statusText: String(text || ''), async text() { return String(text || ''); }, async json() { return null; } });

/** 组别识别：真实 V1 请求体里的维度模板标记（默认模板逐字） */
function groupOf(messages) {
    const sys = String((messages && messages[0] && messages[0].content) || '');
    if (sys.indexOf('【计划库与悬念库】') >= 0) return 'plans';
    if (sys.indexOf('【状态记录】') >= 0) return 'states';
    if (sys.indexOf('【情节】') >= 0) return 'atoms';
    return '统一';
}

/** 分组构造（V1 口径的「期望值」，用于与实测请求比对；顺序 = V1 DIMENSIONS 顺序） */
const V1_DIMENSIONS = ['atoms', 'states', 'snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'];
function expectedGroups(enabled) {
    const on = V1_DIMENSIONS.filter((d) => enabled && enabled[d]);
    const rest = V1_DIMENSIONS.filter((d) => !(enabled && enabled[d]));
    return on.map((d) => ({ dim: d, dims: [d] })).concat(rest.length ? [{ dim: '统一', dims: rest }] : []);
}

(async function main() {
    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    const calls = [];                       // 本次运行的 AI 请求（仅 /chat/completions）
    let allCnKey = false;                    // 全部组回中文维度键（V1 原样：切片发生在归一之前）
    const failPlan = {};
    env.parentWin.fetch = async (url, opts) => {
        const u = String(url);
        let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { /* 忽略 */ }
        if (u.indexOf('/chat/completions') < 0 || !body || !body.messages) return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
        const g = groupOf(body.messages);
        const rec = { url: u, g, model: body.model, messages: proj(body.messages) };
        calls.push(rec);
        const plan = failPlan[g];
        if (allCnKey) return resp(CN_KITCHEN_SINK);
        if (plan === 'throw') throw new Error('模拟网络中断');
        if (plan === 'http500') return httpErr(500, 'boom');
        if (plan === 'nodim') return resp({ 无关维度: { add: [] } });
        return resp(KITCHEN_SINK);
    };
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    // 定时器接管：记录但不真跑（结尾清掉），从而可**确定性**地驱动 weave 定时器
    globalThis.setTimeout = (fn, ms) => { const id = realSetTimeout(() => { /* 不自动执行 */ }, ms); timers.push({ id, ms, fn }); return id; };

    function resetRun(patch) {
        Object.assign(F.cfg, JSON.parse(JSON.stringify(CFG)), patch || {});
        F.state = Object.assign({}, JSON.parse(JSON.stringify(SEED)), {
            version: F.state.version, lastKnownFloor: SEED.state ? 3 : 3, updatedAt: 1900000000000,
        });
        F.dbgClear();
        calls.length = 0;
        timers.length = 0;
        allCnKey = false;
        Object.keys(failPlan).forEach((k) => { delete failPlan[k]; });
    }
    const timerCount = (ms) => timers.filter((t) => t.ms === ms).length;
    const clearTimers = () => { timers.forEach((t) => { try { clearTimeout(t.id); } catch (e) { /* 忽略 */ } }); timers.length = 0; };
    /** 驱动并消化本次运行产生的 weave 定时器：`fireWeave` 开头即 `weaveTimer = null`，
     *  若不驱动，插件模块级 `weaveTimer` 会一直占位 → 后续运行的 `scheduleParallelWeave` 全部被静默丢弃。 */
    async function drainWeaveTimers() {
        for (const t of timers.filter((x) => x.ms === 1800)) {
            try { await t.fn(); } catch (e) { /* 忽略 */ }
        }
        clearTimers();
    }
    // V1 原样：成功时 `ok` 是 `mergeDelta` 的**返回对象** `{ok:true,added,total}`（真值），失败时是 `false` / `{ok:false,error}`
    const resultsView = (r) => (r || []).map((x) => ({
        dim: x.dim,
        ok: !!(x.ok && typeof x.ok === 'object' ? x.ok.ok : x.ok),
        rawOkType: (x.ok && typeof x.ok === 'object') ? 'mergeDelta-result' : typeof x.ok,
        merged: x.ok && typeof x.ok === 'object' ? { added: x.ok.added, total: x.ok.total } : null,
        error: x.ok && typeof x.ok === 'object' && x.ok.ok !== true ? String(x.ok.error || '') : (x.error ? String(x.error) : undefined),
    }));
    const counts = () => ({
        atoms: (F.state.atoms || []).length, states: (F.state.currentStates || []).length, snapshots: (F.state.snapshots || []).length,
        memories: (F.state.memories || []).length, items: (F.state.items || []).length, plans: (F.state.plans || []).length,
        suspense: (F.state.suspense || []).length, scenes: (F.state.scenes || []).length, concepts: (F.state.concepts || []).length,
        currencies: (F.state.currencies || []).length, rumors: (F.state.rumors || []).length,
    });
    /** V1 `dbgLog(kind, data)` 把 data 存成 **JSON 字符串**（v1.206 601~608）→ 解析后取 `action` */
    const dbgActions = () => (F.dbgGet() || []).map((l) => {
        try { return String((JSON.parse(String(l && l.data || '{}')) || {}).action || ''); } catch (e) { return ''; }
    });

    // ---------- 运行 1：正常成功（验证分组构造 / 逐字符提示词 / 预设参与 / 切片落库 / weave 定时器） ----------
    resetRun();
    let threw1 = null;
    let r1 = [];
    try { r1 = await F.runSummarySeparate(FLOOR_TEXT, FLOOR_RANGE, true); } catch (e) { threw1 = String((e && e.message) || e); }
    const run1Groups = calls.map((c) => ({ dim: c.g, url: c.url, model: c.model, messages: c.messages }));
    const run1State = counts();
    const run1WeaveTimers = timerCount(1800);
    await drainWeaveTimers();

    // ---------- 运行 2：三种失败各自独立（fetch 抛错 / HTTP 500 / 无该维度数据） ----------
    resetRun();
    failPlan.states = 'throw'; failPlan.plans = 'http500'; failPlan['统一'] = 'nodim';
    let threw2 = null;
    let r2 = [];
    try { r2 = await F.runSummarySeparate(FLOOR_TEXT, FLOOR_RANGE, true); } catch (e) { threw2 = String((e && e.message) || e); }
    const run2State = counts();
    const run2Results = resultsView(r2);
    const run2WeaveTimers = timerCount(1800);
    await drainWeaveTimers();

    // ---------- 运行 3：全部成功 + 间隔未到 → 每个成功组各调用一次 scheduleParallelWeave（可数） ----------
    resetRun({ parallelWeaveInterval: 999 });
    F.state.weaveLastFloor = 4;                       // 4 - 4 = 0 < 999 → 间隔未到
    let r3 = [];
    try { r3 = await F.runSummarySeparate(FLOOR_TEXT, FLOOR_RANGE, true); } catch (e) { /* 忽略 */ }
    const run3 = {
        results: resultsView(r3),
        intervalSkipLogs: dbgActions().filter((a) => a === '平行事件间隔未到').length,
        weaveTimers: timerCount(1800),
        aiCalls: calls.length,
    };
    await drainWeaveTimers();

    // ---------- 运行 4：全部成功 + 间隔到 → 1 个 1.8s 定时器（已在调度 → 后到静默丢弃），驱动后观测真实参数 ----------
    resetRun();
    let r4 = [];
    try { r4 = await F.runSummarySeparate(FLOOR_TEXT, FLOOR_RANGE, true); } catch (e) { /* 忽略 */ }
    const weaveTimers4 = timers.filter((t) => t.ms === 1800);
    const beforeDrive = calls.length;
    let weaveErr = null;
    try { if (weaveTimers4.length) await weaveTimers4[0].fn(); } catch (e) { weaveErr = String((e && e.message) || e); }
    clearTimers();                       // 已手动驱动 → 不再二次驱动（否则 weavePending 为空时会再跑一次空任务）
    const weaveReq = calls.filter((c) => String((c.messages[1] || {}).content || '').indexOf('触发关键词') >= 0).pop() || null;
    const weaveUser = String((weaveReq && weaveReq.messages[1] && weaveReq.messages[1].content) || '');
    const line = (re) => { const m = weaveUser.match(re); return m ? m[0] : null; };
    const run4 = {
        results: resultsView(r4),
        weaveTimers: weaveTimers4.length,
        aiCallsAfterSchedule: beforeDrive,
        keywordsAtWeave: (() => {
            const m = weaveUser.match(/触发关键词（提取记忆所得，用于关联更新）：([^\n]*)/);
            return m ? String(m[1]).split('、').filter(Boolean) : null;
        })(),
        keywordsAfterAllMerges: (() => { try { return F.jsExtractKeywords(FLOOR_TEXT); } catch (e) { return null; } })(),
        weave: weaveReq ? {
            url: weaveReq.url, model: weaveReq.model,
            label: '平行事件·交织',
            keywordLine: line(/触发关键词（提取记忆所得，用于关联更新）：[^\n]*/),
            matchedHead: line(/【平行事件 · 关键词命中待更新[^\n]*/),
            weaveLastFloor: Number(F.state.weaveLastFloor),
            parallels: (F.state.parallels || []).length,
        } : null,
        weaveError: weaveErr,
    };

    // ---------- 运行 5：AI 回**中文维度键** → 独立分组判「无该维度数据」（V1 原样怪癖：切片发生在 `mergeDelta` 归一之前） ----------
    resetRun();
    allCnKey = true;
    let r5 = [];
    try { r5 = await F.runSummarySeparate(FLOOR_TEXT, FLOOR_RANGE, true); } catch (e) { /* 忽略 */ }
    const run5 = { results: resultsView(r5), state: counts(), weaveTimers: timerCount(1800) };
    await drainWeaveTimers();

    globalThis.setTimeout = realSetTimeout;

    const out = {
        note: 'B9-e oracle：AI 独立分组抽取（runSummarySeparate）+ 被动调度（scheduleParallelWeave / jsExtractKeywords）——真实 V1 v1.206 直调',
        meta: {
            v1Version: 'v1.206',
            srcFile: 'FTT记忆组件-v1.206.js',
            generator: 'tests/fixtures/gen-v1-golden-separate-dim.cjs',
            lines: {
                runSummarySeparate: 14785, separateBranch: 15477, jsExtractKeywords: 11213, scheduleParallelWeave: 13018,
            },
        },
        v1Source: {
            runSummarySeparate: snip('    async function runSummarySeparate(', '    // ==================== 被动触发器（v1.35）'),
            runSummarySeparateSilentUnused: /async function runSummarySeparate\(([^)]*)\)[\s\S]*?\n    \}\n/.test(SRC) ? (() => {
                const body = snip('    async function runSummarySeparate(', '    // ==================== 被动触发器（v1.35）');
                const after = body.slice(body.indexOf(') {') + 3);
                return after.indexOf('silent') < 0;                 // 形参 silent 在函数体内**从未被引用**（V1 原样）
            })() : null,
            segmentSeparateBranch: snip("                    if (cfg.dimensionGrouping === 'separate') {", '                    const prompt = await buildSummaryPrompt(segText, DIMENSIONS);'),
            jsExtractKeywords: snip('    function jsExtractKeywords(text) {', '    // 第二层：浏览器 JS 抽取记忆 ——'),
            scheduleParallelWeave: snip('    function scheduleParallelWeave(floorRange, keywords) {', '    // 关键词 → 命中既有平行事件'),
        },
        input: { floorText: FLOOR_TEXT, floorRange: FLOOR_RANGE, cfg: CFG, seed: SEED },
        expectedGroups: expectedGroups(CFG.dimensionEnabled),
        run1: { threw: threw1, groups: run1Groups, results: resultsView(r1), state: run1State, weaveTimers: run1WeaveTimers, stateAfterGroupOrder: expectedGroups(CFG.dimensionEnabled).map((g) => g.dim) },
        run2: { threw: threw2, results: run2Results, state: run2State, weaveTimers: run2WeaveTimers },
        run3,
        run4,
        run5,
        kitchenSink: KITCHEN_SINK,
    };
    const text = JSON.stringify(out, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text, 'utf8');
    realStdoutWrite(text);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR ' + ((e && e.stack) || e) + '\n'); process.exit(1); });
