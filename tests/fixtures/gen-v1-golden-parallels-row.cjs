'use strict';
// ============================================================
// oracle（平行大类列表行布局）：真实 V1 插件 v1.206 `parallelsHtml()` 的行结构与操作区
//   → 生成 tests/fixtures/v1-golden-parallels-row.json
//
// 被测（用户要求）：「平行大类中的 UI 布局需优化，尤其是列表右侧按钮会大量挤占空间。
//   **默认应该将按钮竖向排列**，V1 也有类似处理。」
//
// V1 事实源（v1.206）：
//   · 行容器：`<div class="ftt-item" …><div class="ftt-item-main">…9 行内容…</div><div class="ftt-item-ops ftt-ops-col">…</div></div>`
//     （24481；**只有平行页**用 `ftt-ops-col`，全库仅此一处）；
//   · 操作区内容与顺序：🚀 `parallelAdvance` → ⬆ `promoteParallel` →（多选模式的勾选框）→ ✏️ `editEntry` → 🗑 `delEntry`；
//   · 条件：已达衰退阈值（`parallelExpired`）→ 不渲染 🚀；已转正（`promotedTo`）→ 不渲染 ⬆；
//   · CSS：`#ftt-panel .ftt-ops-col { flex-direction: column; align-items: center; justify-content: center; flex: 0 0 auto; }`（22758）。
//
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-parallels-row.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-parallels-row.json');

/** 一行 HTML → 投影（操作区类名 / 操作按钮动作顺序 / 主体是否在 .ftt-item-main） */
function projectRow(rowHtml) {
    const h = String(rowHtml || '');
    const opsAt = h.indexOf('<div class="ftt-item-ops');
    const opsTag = opsAt >= 0 ? (h.slice(opsAt).match(/^<div class="([^"]*)"/) || [])[1] || '' : '';
    const opsHtml = opsAt >= 0 ? h.slice(opsAt) : '';
    const actions = [];
    const re = /data-ftt-action="([^"]*)"/g;
    let m;
    while ((m = re.exec(opsHtml)) !== null) actions.push(m[1]);
    return {
        opsClass: opsTag,
        opsActions: actions,
        hasMain: h.indexOf('<div class="ftt-item-main">') >= 0,
        hasOpsCol: /ftt-ops-col/.test(opsTag),
        hasMultiCheckboxInOps: /data-ftt-select="/.test(opsHtml),
    };
}
function rowsOf(html) {
    const out = [];
    const re = /<div class="ftt-item" [^>]*>[\s\S]*?(?=<div class="ftt-item" |<div class="ftt-addbar|$)/g;
    let m;
    while ((m = re.exec(String(html))) !== null) out.push(m[0]);
    return out;
}

(async function main() {
    const src = fs.readFileSync(path.join(V1, 'src', 'FTT记忆组件-v1.205.js'), 'utf8');
    const env = makeTavernEnv();
    const F = await loadPlugin(env);

    // 三条平行事件：普通 / 已转正 / 巨旧（用极低衰退阈值制造「已衰退」）
    F.state.parallels = [
        { id: 'p1', title: '北境集结', text: '部落在边境零星集结。', date: '1919-11-30', location: '北境·哨所', characters: ['甲'], gua: '乾', tags: ['北境'], type: '推演', uses: 2, importance: 0.7, updatedAt: Date.now() },
        { id: 'p2', title: '王城宴会', text: '宴会筹备中。', date: '1919-11-28', promotedTo: 'atom-1', tags: ['宫廷'], updatedAt: Date.now() },
        { id: 'p3', title: '旧日风声', text: '很久以前的事。', date: '1900-01-01', tags: ['旧'], updatedAt: Date.now() - 400 * 86400000 },
    ];
    const normal = rowsOf(F.parallelsHtml()).map(projectRow);

    // 「已衰退」分支：阈值降到 0 → 全部视为过期（只观察 🚀 的有无）
    let expiredRows = [];
    try {
        const saved = F.cfg.parallelDecayCutoff;
        F.cfg.parallelDecayCutoff = 0;
        expiredRows = rowsOf(F.parallelsHtml()).map(projectRow);
        F.cfg.parallelDecayCutoff = saved;
    } catch (e) { /* 忽略 */ }

    const out = {
        generatedFrom: 'src/FTT记忆组件-v1.205.js（当前 src 最新版）parallelsHtml()',
        cssRule: (src.match(/#ftt-panel \.ftt-ops-col \{[^}]*\}/) || [''])[0],
        opsColClassUsageInV1: (src.match(/ftt-item-ops ftt-ops-col/g) || []).length,   // = 1：全库只有平行页这样写
        opsColMentionsInV1: (src.match(/ftt-ops-col/g) || []).length,                    // = 2：上述用法 + CSS 规则
        rows: normal,
        rowsWhenExpired: expiredRows,
        notes: [
            'V1 只有平行页用 `ftt-ops-col`（竖向操作列），其余维度沿用横向 `.ftt-item-ops`。',
            'V1 的「🔗 关联」跳转在备注行内（V2 放在行主体末尾，位置差异已登记）。',
            'V1 的 🚀 在 `parallelExpired` 为真时不渲染；⬆ 在 `promotedTo` 非空时不渲染。',
        ],
    };
    const json = JSON.stringify(out, null, 1) + '\n';
    if (OUT) fs.writeFileSync(OUT, json);
    process.stdout.write(json);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR: ' + (e && e.stack || e) + '\n'); process.exit(1); });
