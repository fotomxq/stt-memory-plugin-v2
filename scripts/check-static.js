#!/usr/bin/env node
// ============================================================
// scripts/check-static.js —— **零依赖静态检查门禁**（`docs/D22` W5 `技-10`；`docs/D17` U130）
//
// 与 `docs/D21` §8 的一处**有意差异（如实登记）**：设计稿写「`jsconfig.json` + `checkJs`」，但那需要 TypeScript
//   （`node_modules`）→ 与 §6 **Q5 用户裁决**「不允许引入需要 `node_modules` 的工具」冲突。
//   本脚本交付**零依赖等价物**（三件）：
//     ① `node --check` **语法检查**（Node 原生；调用失败不误报，只标 skipped）；
//     ② **导入名 ↔ 导出名一致性**（`scripts/static-lib.js#checkImports`）—— 最常被 `checkJs` 抓到的那类错
//        （导入了不存在的具名导出 → 运行时静默 `undefined`）；
//     ③ **最小 lint 规则集**（禁止 `eval` / `new Function` / `debugger` / `with`；告警 `console.*` / `var` / 空 `catch`）。
//
// 用法：
//   node scripts/check-static.js            # 门禁：错误必须 0，告警 ≤ 基线（逐规则也不得涨）
//   node scripts/check-static.js --json     # 机器可读
//   node scripts/check-static.js --list     # 逐条列出（默认只列前 40 条）
//   node scripts/check-static.js --syntax   # **加上全量 `node --check` 语法检查**（Windows 上约 25s，发版前跑一次即可）
//   node scripts/check-static.js --write    # 重写告警基线（只允许**变小**；涨了拒绝，须 --allow-growth + CHANGELOG 理由）
//
// 语法检查为什么默认关：每次 `node --check` 都是一次子进程（Windows 上 ~450ms）→ 400+ 文件约 25s，对门禁太贵。
//   **而语法错误本来就跑不掉**：门禁里的单测 + 冒烟会 **import 全部交付模块**（core/host/adapters/ui/入口），
//   `scripts/` 与 `tests/` 的文件则被门禁本身直接执行 —— 真正可能漏的只有「既没被 import、也没被执行」的孤立文件，
//   `--syntax` 就是为这一步兜底（`npm run static:full`）。
//
// 边界：**只读源码**，不改写任何源码；`--write` 只写 `scripts/static-baseline.json`。
// ============================================================
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './check-core-refs.js';
import {
    SHIPPED_DIRS, SHIPPED_FILES, TOOL_DIRS,
    lintCode, emptyCatchFindings, checkImports, summarizeStatic, planStatic, STATIC_RULES,
} from './static-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_REL = 'scripts/static-baseline.json';
const BASELINE_PATH = join(ROOT, BASELINE_REL);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const AS_JSON = has('--json');
const LIST_ALL = has('--list');
const WRITE = has('--write');
const ALLOW_GROWTH = has('--allow-growth');
const SKIP_SYNTAX = !has('--syntax');

function walk(dir, acc = []) {
    try {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p, acc);
            else if (/\.(?:js|mjs|cjs)$/.test(name)) acc.push(p);
        }
    } catch (e) { /* 目录不存在 → 跳过 */ }
    return acc;
}

const absFiles = SHIPPED_DIRS.map((d) => join(ROOT, d)).flatMap((d) => walk(d))
    .concat(SHIPPED_FILES.map((f) => join(ROOT, f)).filter((p) => { try { return statSync(p).isFile(); } catch (e) { return false; } }))
    .concat(TOOL_DIRS.map((d) => join(ROOT, d)).flatMap((d) => walk(d)))
    .sort();

const files = {};                     // 仓库相对路径 → 源码（导入核对需要全量）
for (const abs of absFiles) {
    try { files[relative(ROOT, abs).replace(/\\/g, '/')] = readFileSync(abs, 'utf8'); } catch (e) { /* 忽略读失败 */ }
}

const findings = [];
// 文件面：交付面（core/host/adapters/ui + 入口）适用全部规则；工具面（scripts/tests）只做正确性检查
const faceOf = (rel) => (SHIPPED_DIRS.some((d) => rel.indexOf(d + '/') === 0) || SHIPPED_FILES.indexOf(rel) >= 0 ? 'shipped' : 'tool');
for (const rel of Object.keys(files)) {
    const raw = files[rel];
    const face = faceOf(rel);
    findings.push(...lintCode(rel, codeOnly(raw), face));
    findings.push(...emptyCatchFindings(rel, raw, face));
}
findings.push(...checkImports(files));

/**
 * ① **语法检查**（`node --check`，Node 原生零依赖）。
 *
 * 为什么要**并发**：单进程逐个 `node --check` 每次都要付一次进程启动（~40ms）→ 400+ 文件 ≈ **18s**，
 *   对门禁来说太贵；8 路并发后 ≈ 3s（实测）。子进程起不来（受限环境的 EPERM 等）一律记 `skipped`，
 *   **不误报**（那种情况下语法仍由单测/冒烟装载全部模块兜底）。
 */
async function syntaxFindings(rels, concurrency) {
    const out = [];
    const queue = rels.slice();
    const workers = [];
    const n = Math.max(1, Math.min(Number(concurrency) || 8, queue.length || 1));
    for (let i = 0; i < n; i++) {
        workers.push((async () => {
            for (;;) {
                const rel = queue.shift();
                if (!rel) return;
                const res = await new Promise((resolve) => {
                    let done = false;
                    try {
                        const ch = spawn(process.execPath, ['--check', join(ROOT, rel)], { stdio: ['ignore', 'pipe', 'pipe'] });
                        let err = '';
                        if (ch.stderr && typeof ch.stderr.on === 'function') ch.stderr.on('data', (d) => { err += String(d); });
                        ch.on('error', () => { if (!done) { done = true; resolve({ skipped: true }); } });
                        ch.on('close', (code) => { if (!done) { done = true; resolve({ code: code, err: err }); } });
                    } catch (e) { if (!done) { done = true; resolve({ skipped: true }); } }
                });
                if (res.skipped) { out.push({ rel: rel, skipped: true }); continue; }
                if (res.code !== 0) out.push({ rel: rel, finding: { file: rel, line: 1, rule: 'syntax', level: 'error', msg: '语法检查失败（node --check）：' + String(res.err || '').split('\n').slice(0, 3).join(' / ').slice(0, 200) } });
            }
        })());
    }
    await Promise.all(workers);
    return out;
}

const syntaxTargets = Object.keys(files).filter((rel) => {
    if (rel.indexOf('tests/fixtures/') === 0) return false;                    // 夹具里可能有**故意的**坏样本
    if (rel.indexOf('tests/') === 0 && /(?:golden|probe|fixture)/.test(rel)) return false;
    return true;
});
const syntax = SKIP_SYNTAX ? [] : await syntaxFindings(syntaxTargets, 8);
for (const s of syntax) if (s && s.finding) findings.push(s.finding);

const sum = summarizeStatic(findings);

// 基线
const loadBaseline = () => {
    try { if (!existsSync(BASELINE_PATH)) return { warnings: 0, byRule: {} }; return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch (e) { return { warnings: 0, byRule: {} }; }
};
const baseline = loadBaseline();
const plan = planStatic(findings, baseline);

if (WRITE) {
    const initial = !baseline || !baseline.byRule || Object.keys(baseline.byRule).length === 0;   // 首次建基线：允许
    const grown = initial ? [] : plan.grown;
    if (grown.length && !ALLOW_GROWTH) {
        console.log('❌ 拒绝写基线：以下规则的告警**变多了** —— 基线只允许变小');
        for (const g of grown) console.log('   · ' + g.rule + ' ' + g.base + ' → ' + g.now);
        console.log('   确需上调请显式加 `--allow-growth`，并在 `CHANGELOG.md` 写明理由。');
        process.exit(1);
    }
    writeFileSync(BASELINE_PATH, JSON.stringify({
        note: '零依赖静态检查的**告警**基线（`docs/D22` W5 `技-10`）。错误（eval/debugger/with/导入名/syntax）**永远必须为 0**，不进基线；本文件只记告警，且只减不增。',
        warnings: sum.warnings,
        byRule: sum.byRule,
    }, null, 2) + '\n', 'utf8');
    console.log('✅ 已写入基线 ' + BASELINE_REL + '（告警 ' + sum.warnings + ' 条 · 错误 ' + sum.errors + ' 条' + (initial ? ' · 首次建立' : '') + '）');
    for (const k of Object.keys(sum.byRule).sort()) console.log('   · ' + k.padEnd(16) + ' ' + sum.byRule[k]);
    process.exit(sum.errors === 0 ? 0 : 1);
}

if (AS_JSON) {
    console.log(JSON.stringify({
        ok: plan.ok, files: Object.keys(files).length, syntaxSkipped: syntax.filter((s) => s.skipped).length,
        summary: sum, baseline: plan.baseline, grown: plan.grown,
        findings: (LIST_ALL ? findings : findings.slice(0, 40)),
    }, null, 2));
    process.exit(plan.ok ? 0 : 1);
}

console.log('零依赖静态检查（技-10）：扫描 ' + Object.keys(files).length + ' 个文件（' + SHIPPED_DIRS.join('/') + '/ + 入口 + ' + TOOL_DIRS.join('/') + '/）'
    + (SKIP_SYNTAX ? ' · 语法检查未开（`--syntax` 开；语法错误由单测/冒烟装载全部模块兜底）' : ' · 含全量 node --check 语法检查')
    + (syntax.filter((s) => s.skipped).length ? (' · 语法检查跳过 ' + syntax.filter((s) => s.skipped).length + ' 个') : ''));
console.log('规则：' + STATIC_RULES.map((r) => r.id).join(' · ') + ' · import-name · import-default · empty-catch · syntax');
console.log('结果：错误 ' + sum.errors + ' 条（必须为 0）· 告警 ' + sum.warnings + ' 条（基线 ' + plan.baseline.warnings + ' 条）');
const errs = findings.filter((f) => f.level === 'error');
if (errs.length) {
    console.log('❌ 错误明细：');
    (LIST_ALL ? errs : errs.slice(0, 40)).forEach((f) => console.log('   · ' + f.file + ':' + f.line + ' [' + f.rule + '] ' + f.msg));
}
if (plan.grown.length) {
    console.log('❌ 告警变多的规则（基线只减不增）：');
    plan.grown.forEach((g) => console.log('   · ' + g.rule + ' ' + g.base + ' → ' + g.now));
}
if (!plan.ok) {
    console.log('❌ 静态检查未通过（错误 ' + sum.errors + ' · 告警 ' + sum.warnings + '/' + plan.baseline.warnings + '）');
    process.exit(1);
}
console.log('✅ 静态检查通过（0 错误 · 告警未超基线）');
