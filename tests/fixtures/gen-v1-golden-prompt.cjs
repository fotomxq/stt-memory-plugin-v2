'use strict';
// ============================================================
// oracle（AI 摘要提示词）：真实 V1 插件 v1.206 `buildSummaryPrompt(text, DIMENSIONS)` 的真实输出
//   → 生成 tests/fixtures/v1-golden-prompt.json
//
// 为什么重建这个 oracle（v2.68.0，用户报告「状态大类总是没数据」）：
//   §旧 fixture 的 `dims` 记录的是 **V2 容器 kind**（`currentStates` / `parallels` / `plotSegments` / `npcs` …）。
//   把它喂给提示词构造器时 `pt[d]` 取不到模板 —— 于是 **「状态记录」整段说明缺失**、反而混入 V1 摘要不抽的
//   「平行事件」模板；黄金样本把这份**错误输入**固化成「V1 原样」，使错误无从暴露。
//   本生成器改为：从 V1 源码里读出 `const DIMENSIONS = [...]`（V1 的 10 个摘要维度键）作为输入，
//   并记录每段模板签名是否出现，便于人工核对。
//
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-prompt.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-prompt.json');
const OLD = path.join(__dirname, 'v1-golden-prompt.json');

/** 从旧 fixture 复用输入（seed / floors），保证与历史样本可比 */
function loadInputs() {
    try {
        const d = JSON.parse(fs.readFileSync(OLD, 'utf8'));
        return { seed: d.seed, floors: d.floors };
    } catch (e) {
        return {
            seed: { state: { date: '1919-11-29', time: '夜', location: '码头' } },
            floors: '[第3楼 用户] 我们把木箱抬进仓库。\n[第4楼 AI] 甲用铜钥匙打开木箱，里面是发黄的账册。',
        };
    }
}

/** V1 源码里的摘要维度键（**唯一事实源**：`const DIMENSIONS = [...]`，v1.206 1128） */
function v1Dimensions(src) {
    const m = src.match(/const DIMENSIONS = \[([^\]]*)\]/);
    if (!m) throw new Error('未在 V1 源码里找到 DIMENSIONS');
    return m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 每段维度模板的签名（用于「这段说明到底进没进提示词」的可读核对） */
const SIGNATURES = {
    atoms: '【情节】', states: '【状态记录】', snapshots: '【角色档案】', memories: '【记忆库】', items: '【物品库】',
    plans: '【计划库与悬念库】', scenes: '【场景库】', concepts: '【概念库】', currencies: '【货币】', rumors: '【传言】',
    parallels: '【平行事件】', anchor: '【当前状态】',
};

(async function main() {
    const src = fs.readFileSync(path.join(V1, 'src', 'FTT记忆组件-v1.205.js'), 'utf8');
    const DIMS = v1Dimensions(src);
    const inputs = loadInputs();

    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    if (typeof F.buildSummaryPrompt !== 'function') throw new Error('V1 未导出 buildSummaryPrompt');

    // 与历史 fixture 同口径：只装配 seed（其余为 V1 默认）
    try {
        const cur = (F.state && typeof F.state === 'object') ? F.state : null;
        if (cur && inputs.seed) for (const k of Object.keys(inputs.seed)) cur[k] = JSON.parse(JSON.stringify(inputs.seed[k]));
    } catch (e) { /* 忽略 */ }

    const messages = await F.buildSummaryPrompt(inputs.floors, DIMS);
    const sys = String((messages && messages[0] && messages[0].content) || '');
    const sig = {};
    for (const k of Object.keys(SIGNATURES)) sig[k] = sys.indexOf(SIGNATURES[k]) >= 0;

    const out = {
        note: 'V1 真实插件 v1.206 buildSummaryPrompt(text, DIMENSIONS) 输出（v2.68.0 重建：dims = V1 摘要维度键，修复旧样本误用 V2 容器 kind 的问题）',
        v1Dimensions: DIMS,
        seed: inputs.seed,
        floors: inputs.floors,
        dims: DIMS,
        signatures: sig,
        messages: messages,
        templateLens: Object.keys(SIGNATURES).map((k) => ({ key: k, sig: SIGNATURES[k], present: sig[k] })),
    };
    const json = JSON.stringify(out, null, 1) + '\n';
    if (OUT) fs.writeFileSync(OUT, json);
    process.stdout.write(json);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR: ' + (e && e.stack || e) + '\n'); process.exit(1); });
