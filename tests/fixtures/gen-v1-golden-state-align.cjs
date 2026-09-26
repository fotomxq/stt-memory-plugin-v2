'use strict';
// ============================================================
// oracle（状态大类对齐）：真实 V1 插件 v1.206 直调，生成 tests/fixtures/v1-golden-state-align.json
//   被测（V1 事实源）：
//     · 提示词模板 `state` / `states` / `statesRepair`（V1 `PROMPT_TEMPLATES_V2`，v1.206 1582 / 1617 / 2028）；
//     · 状态页 `statesHtml()`（23988~24027）：空态、按主体分组（组头 ➕添加 / 🗑删除分组）、组内
//       `字段：值` + `调用N次 · 更新 日期 时间`、主体排序（localeCompare）、搜索占位符、无匹配文案；
//     · 注入体 `buildMemoryBodyForInject()`（11884~）中的 [状态记录] 块（在场过滤 / 每角色上限 / 行格式）；
//     · 条数钳制 `applyStateBounds()`（17339~，经 `mergeDelta` 触发）：每角色 > stateMaxPerSubject 裁最旧。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-state-align.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const clone = (o) => JSON.parse(JSON.stringify(o));
const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** 状态页「语义投影」（V1 HTML → 与 V2 渲染可比较的结构） */
function projectStatesPage(html) {
    const h = String(html || '');
    const groups = [];
    const re = /<h4 class="ftt-h4-inline ftt-mt-6">👤 ([\s\S]*?)<\/h4>/g;
    let m;
    while ((m = re.exec(h))) {
        const head = m[1];
        const name = (head.match(/^([\s\S]*?) <span class="ftt-muted">/) || [])[1] || '';
        const count = Number((head.match(/<span class="ftt-muted">\((\d+)\)<\/span>/) || [])[1] || 0);
        // 该组内的行（到下一个组头之前）
        const rest = h.slice(m.index + m[0].length);
        const nextAt = rest.search(/<h4 class="ftt-h4-inline ftt-mt-6">/);
        const body = nextAt >= 0 ? rest.slice(0, nextAt) : rest;
        const rows = [];
        const rowRe = /<div class="ftt-item"[^>]*><div class="ftt-item-main"><b>([\s\S]*?)<\/b>：([\s\S]*?)<div class="ftt-meta">([\s\S]*?)<\/div>/g;
        let rm;
        while ((rm = rowRe.exec(body))) rows.push({ field: stripTags(rm[1]), value: stripTags(rm[2]), meta: stripTags(rm[3]) });
        const hasAdd = body.indexOf('data-ftt-action="addStateFor"') >= 0;
        const hasDelGroup = body.indexOf('data-ftt-action="delStateGroup"') >= 0;
        groups.push({ subject: stripTags(name), count: count, rows: rows, addBtn: hasAdd, delGroupBtn: hasDelGroup });
    }
    return {
        empty: (h.match(/<div class="ftt-empty">([\s\S]*?)<\/div>/) || [])[1] ? stripTags((h.match(/<div class="ftt-empty">([\s\S]*?)<\/div>/) || [])[1]) : '',
        chip: stripTags((h.match(/<div class="ftt-cat-stat ftt-chip">([\s\S]*?)<\/div>/) || [])[1] || ''),
        placeholder: (h.match(/data-ftt-search="states"[^>]*placeholder="([^"]*)"/) || [])[1] || '',
        repairBtn: h.indexOf('data-ftt-action="stateRepair"') >= 0,
        groups: groups,
    };
}

(async function main() {
    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    const t = F.cfg.promptTemplates || {};
    const out = {
        note: '由 tests/fixtures/gen-v1-golden-state-align.cjs 直调真实 V1 插件 v1.206 生成（连跑两次逐字节一致）。',
        templates: { state: String(t.state || ''), states: String(t.states || ''), statesRepair: String(t.statesRepair || '') },
    };

    // ---------- ① 状态页：空态 ----------
    F.state = Object.assign({}, F.state, { currentStates: [], atoms: [], memories: [], snapshots: [], items: [], plans: [], suspense: [], scenes: [], concepts: [], parallels: [] });
    out.pageEmpty = projectStatesPage(F.statesHtml());

    // ---------- ② 状态页：分组 / 行 / 排序 ----------
    const mk = (subject, field, value, extra) => Object.assign({ id: 'st-' + subject + '-' + field, subject, field, value, status: 'active', importance: 0.6, floorStart: 1, floorEnd: 5, uses: 2, updatedAt: '1919-11-29', updatedAtTime: '傍晚' }, extra || {});
    F.state = Object.assign({}, F.state, {
        currentStates: [
            mk('乙', '处境', '在船上', { floorEnd: 7, uses: 5 }),
            mk('甲', '情绪与心理状态', '担忧', { floorEnd: 9, uses: 1 }),
            mk('甲', '短期目标', '找到铜箱', { floorEnd: 3, uses: 0 }),
            mk('丙', '身体状况与伤势', '左臂扭伤', { floorEnd: 4, uses: 9, updatedAt: '', updatedAtTime: '' }),
            mk('甲', '处境', '在码头', { floorEnd: 12, uses: 4 }),
        ],
    });
    out.pageGrouped = projectStatesPage(F.statesHtml());
    // 搜索命中 / 无匹配（走 V1 的搜索槽）
    F.pageSearchQuery['states'] = '铜箱';
    out.pageSearchHit = projectStatesPage(F.statesHtml());
    F.pageSearchQuery['states'] = '不存在的词';
    out.pageSearchMiss = projectStatesPage(F.statesHtml());
    F.pageSearchQuery['states'] = '';

    // ---------- ③ 注入体 [状态记录] 块（在场过滤 + 每角色上限 + 行格式） ----------
    F.cfg.charBudget = 6000;
    F.cfg.maxStates = 30;
    F.cfg.stateMinPerSubject = 1;
    F.cfg.stateMaxPerSubject = 10;
    F.cfg.injectConstraintBlock = false;                 // 约束段与状态无关，关掉以便逐字比对状态块
    F.state.state = { date: '1919-11-29', time: '傍晚', location: '码头', present: ['甲'] };
    const body = String(F.buildMemoryBodyForInject('', { inject: true, countUses: false }) || '');
    const blockOf = (b) => {
        const i = b.indexOf('[状态记录]');
        if (i < 0) return '';
        const rest = b.slice(i);
        const j = rest.slice(1).search(/\n\[/);
        return (j >= 0 ? rest.slice(0, j + 1) : rest).trim();
    };
    out.inject = { hasBlock: body.indexOf('[状态记录]') >= 0, block: blockOf(body), bodyChars: body.length };

    // ---------- ④ 条数钳制 applyStateBounds（经 mergeDelta 触发）：每角色 > 上限裁最旧 ----------
    const many = [];
    for (let i = 0; i < 12; i++) many.push({ subject: '甲', field: '字段' + i, value: '值' + i, importance: 0.5, floorEnd: i + 1, uses: i });
    F.state.currentStates = many.map((x, i) => Object.assign({ id: 'b' + i }, x));
    const mr = F.mergeDelta({ states: { add: [] } }, { start: 1, end: 1 });
    out.bounds = {
        merge: mr,
        keptFields: (F.state.currentStates || []).map((s) => String(s.field)).sort(),
        count: (F.state.currentStates || []).length,
    };

    const text = JSON.stringify(out, null, 1);
    if (OUT) fs.writeFileSync(OUT, text + '\n');
    process.stdout.write(text + '\n');
    process.exit(0);
})().catch((e) => { process.stderr.write('FAIL ' + String((e && e.message) || e) + '\n'); process.exit(1); });
