#!/usr/bin/env node
// ============================================================
// scripts/check-ui-spec.js —— **UI 规范一致性检查**（`docs/D9-UI统一规范设计稿.md` v0.2 的 U13 / §9 C1–C11）
//
// 口径（U13）：**S0 只读报告（不阻断）→ S4 接入门禁（先 warning）**。故默认 **warning 模式**（永远 exit 0），
//   加 `--strict` 才在发现问题时 exit 1（供后续升级为 error 门禁用）。
//
// 检查方式是**静态源码扫描**（无 DOM、无宿主、零依赖）：
//   · 覆盖的是「可机械判定」的规范条目；语义级检查（如某页空态文案是否得体）仍由人工走查（D9 §8 S2）；
//   · 每条命中都会打印 `文件:行号`，便于直接定位。
// 用法：node scripts/check-ui-spec.js [--strict] [--quiet]
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
const uiFiles = (() => { try { return readdirSync(join(ROOT, 'ui')).filter((f) => f.endsWith('.js')).map((f) => 'ui/' + f); } catch (e) { return []; } })();
const lines = (s) => String(s).split('\n');
const hits = [];
const hit = (id, file, line, msg) => hits.push({ id, file, line, msg });

// ---------- C1（U9）：`<button>` 的 type="button" 由**集中机制**保证 ----------
// 口径：面板内所有 HTML 都经 `ui/panel.js#ensureButtonTypes()`（字符串层补 type + DOM 层 `hardenButtonTypes` 兜底），
//   因此**不逐字面量报错**；只检查 ① 机制存在且覆盖两条面板渲染路径；② 面板渲染路径**之外**的 ui 文件若直接产出
//   `<button>` 字面量且缺 type= 才提示（这些不会被 ensureButtonTypes 覆盖）。
{
    const panel = read('ui/panel.js');
    const hasEnsure = /export function ensureButtonTypes/.test(panel);
    const applied = (panel.match(/ensureButtonTypes\(/g) || []).length;
    const hardened = /function hardenButtonTypes/.test(panel);
    if (!hasEnsure || applied < 3) hit('C1', 'ui/panel.js', 0, `集中补 type 机制不完整（ensureButtonTypes=${hasEnsure}，调用 ${applied} 处；应覆盖面板 HTML 与模态 HTML）`);
    if (!hardened) hit('C1', 'ui/panel.js', 0, '缺 DOM 层兜底 hardenButtonTypes');
    // 面板渲染路径 = 从 panel.js 出发的**传递依赖闭包**（这些模块的 HTML 都会被 ensureButtonTypes 处理）
    const imported = new Set();
    const queue = ['ui/panel.js'];
    while (queue.length) {
        const cur = queue.pop();
        const src = read(cur);
        for (const m of src.matchAll(/from '\.\/([a-z0-9-]+)\.js'/g)) {
            const dep = 'ui/' + m[1] + '.js';
            if (uiFiles.indexOf(dep) >= 0 && !imported.has(dep)) { imported.add(dep); queue.push(dep); }
        }
    }
    for (const f of uiFiles) {
        if (f === 'ui/panel.js' || imported.has(f)) continue;
        const L = lines(read(f));
        L.forEach((l, i) => {
            const re = /<button\b[^>]*>/gi;
            let m;
            while ((m = re.exec(l))) {
                if (!/\btype\s*=/.test(m[0])) hit('C1', f, i + 1, '面板渲染路径之外的按钮缺 type="button"');
            }
        });
    }
}

// ---------- C2（U9）：裸 `**加粗**` 已由渲染层单测覆盖（静态扫描会误报 `mdBold()` 的合法用法） ----------
// 说明：`ui/hints.js#mdBold` 有意把 `**x**` 转成 `<b>`；是否泄漏到页面由 `tests/unit/ui-wording.test.js`
//   （渲染真实页面后扫描）保证 —— 这里不再静态扫描，避免噪声。
{
    const has = /mdBold/.test(read('ui/hints.js')) && /ui-wording/.test(read('tests/unit/ui-wording.test.js'));
    if (!has) hit('C2', 'tests/unit/ui-wording.test.js', 0, '未发现渲染层「裸加粗」单测覆盖');
}

// ---------- C3（U12）：列表元信息不得用中文冒号作字段分隔 ----------
{
    const f = 'ui/list-rows.js';
    const L = lines(read(f));
    L.forEach((l, i) => {
        if (/调用['"`]?\s*\+\s*\(?\s*\w*\.?uses/.test(l) && l.indexOf('：') >= 0) hit('C3', f, i + 1, '元信息行出现中文冒号分隔（v2.80.0 口径：改用空格/·）');
        if (/重要度['"]?\s*\+\s*importancePct/.test(l) && l.indexOf('：') >= 0) hit('C3', f, i + 1, '元信息行出现中文冒号分隔');
    });
}

// ---------- C4（U3）：每个维度列表页必须有空态文案 ----------
{
    const src = read('ui/panel.js') + '\n' + read('ui/list-rows.js') + '\n' + uiFiles.map(read).join('\n');
    const emptyCount = (src.match(/ftt-empty/g) || []).length;
    if (emptyCount < 11) hit('C4', 'ui/*.js', 0, `空态（.ftt-empty）出现 ${emptyCount} 处 < 11 —— 11 个维度列表页应各自有空态引导`);
}

// ---------- C5（U12）：范围型控件三件套 ----------
{
    const s = read('ui/settings-pages.js');
    const okOut = /data-ftt-range-out=/.test(s);
    const okDef = /--ftt-range-def/.test(s);
    const okDefault = /默认 /.test(s);
    if (!(okOut && okDef && okDefault)) hit('C5', 'ui/settings-pages.js', 0, `范围型控件缺三件套：output=${okOut} 默认刻度=${okDef} 默认值文字=${okDefault}`);
}

// ---------- C6（U12）：`input` 分支不得写配置 ----------
{
    const s = read('ui/panel.js');
    const i = s.indexOf("el.addEventListener('input'");
    const j = s.indexOf("el.addEventListener('change'");
    const block = (i >= 0 && j > i) ? s.slice(i, j) : '';
    if (block && /applySettingsControl|saveKernelCfg/.test(block)) hit('C6', 'ui/panel.js', 0, 'input 分支里出现写配置调用（应在 change 分支）');
}

// ---------- C7（U4）：危险动作必须二次确认（跨模块扫描 + 就近确认调用） ----------
{
    const SRC = {};
    for (const f of uiFiles) SRC[f] = lines(read(f));
    const panel = read('ui/panel.js');
    const map = {
        '删除条目': 'delete',
        '清空调试日志': 'dbgClear',
        '清空同步日志': 'syncLogClear',
        '清空 NSFW 词条库': 'nsfwKwReset',
        '导入覆盖': 'importStateApply',
        '恢复快照': 'snapRestore',
        '清空注入': 'clear-inject',
        '清空已处理楼层台账': 'clearFloors',
        '清空情节分段': 'clearPlotSegments',
    };
    const missing = [];
    const noConfirm = [];
    for (const label of Object.keys(map)) {
        const act = map[label];
        let found = false, confirmed = false;
        for (const f of Object.keys(SRC)) {
            const L = SRC[f];
            L.forEach((l, i) => {
                if (l.indexOf("'" + act + "'") < 0 && l.indexOf('"' + act + '"') < 0) return;
                found = true;
                const win = L.slice(Math.max(0, i - 40), i + 41).join('\n');
                if (/confirmDialog\(|\bconfirm\(/.test(win)) confirmed = true;
            });
        }
        if (!found) missing.push(label + '(' + act + ')');
        else if (!confirmed) noConfirm.push(label + '(' + act + ')');
    }
    if (missing.length) hit('C7', 'ui/*.js', 0, `危险动作未在动作表出现：${missing.join(' / ')}`);
    if (noConfirm.length) hit('C7', 'ui/*.js', 0, `危险动作**未发现二次确认**：${noConfirm.join(' / ')}（D9 U4：需 confirmDialog 或二段式）`);
    if (!/confirmDialog/.test(panel)) hit('C7', 'ui/panel.js', 0, '缺统一的确认框实现（confirmDialog）');
}

// ---------- C8（U5）：短提示 ≤ 40 字（同文案 60s 节流口径另由 runtime 保证） ----------
{
    const over = [];
    for (const f of uiFiles) {
        const L = lines(read(f));
        L.forEach((l, i) => {
            const re = /shortHintHtml\(\s*'([^']*)'/g;
            let m;
            while ((m = re.exec(l))) {
                const t = m[1].replace(/\\n/g, '');
                if (t.length > 40) over.push(f + ':' + (i + 1) + ' (' + t.length + ' 字)');
            }
        });
    }
    over.slice(0, 8).forEach((o) => hit('C8', o.split(':')[0], Number(String(o).split(':')[1]), '短提示超过 40 字：' + o));
    if (over.length > 8) hit('C8', 'ui/*.js', 0, `另有 ${over.length - 8} 处短提示超长`);
}

// ---------- C9（U7）：不得再接「静默吞掉告警」 ----------
{
    for (const f of ['adapters/store.js', 'index.js', 'host/inject.js']) {
        const L = lines(read(f));
        L.forEach((l, i) => { if (/warn\s*:\s*\(\s*\)\s*=>\s*undefined/.test(l)) hit('C9', f, i + 1, 'warn 被接线为静默丢弃（v2.87.0 已修，勿回退）'); });
    }
}

// ---------- C10（重绘纪律）：复用模态节点 + 滚动恢复 ----------
{
    const s = read('ui/panel.js');
    if (s.indexOf('existingModalNode') < 0 && s.indexOf('__fttModalNode') < 0) hit('C10', 'ui/panel.js', 0, '未发现「复用同一模态节点」的实现（v2.80.1 点击不闪）');
    if (!/scrollTop/.test(s)) hit('C10', 'ui/panel.js', 0, '未发现滚动位置恢复（整页重渲染后应恢复）');
}

// ---------- C11（U6）：长耗时动作必须有忙碌态与中断 ----------
{
    const s = read('ui/panel.js');
    const hasBusy = /busyNoteHtml|ftt-head-busy/.test(s);
    const hasAbort = /abort|中断/.test(s);
    if (!hasBusy) hit('C11', 'ui/panel.js', 0, '未发现忙碌态渲染（busyNoteHtml / ftt-head-busy）');
    if (!hasAbort) hit('C11', 'ui/panel.js', 0, '未发现中断入口（abort /「中断」）');
}

// ---------- 输出 ----------
const byId = {};
for (const h of hits) byId[h.id] = (byId[h.id] || 0) + 1;
console.log('UI 规范一致性检查（docs/D9 §9 C1–C11；' + (strict ? 'strict' : 'warning') + ' 模式）');
if (!hits.length) console.log('  ✅ 全部通过（0 命中）');
else {
    if (!quiet) for (const h of hits.slice(0, 40)) console.log(`  ⚠️ ${h.id} ${h.file}${h.line ? ':' + h.line : ''} — ${h.msg}`);
    if (hits.length > 40) console.log(`  … 另有 ${hits.length - 40} 处`);
    console.log('  汇总：' + Object.keys(byId).sort().map((k) => k + '×' + byId[k]).join(' · '));
}
console.log('  ' + (hits.length ? '（warning 模式：不阻断；--strict 才失败）' : '（已满足当前规范）'));
process.exit(strict && hits.length ? 1 : 0);
