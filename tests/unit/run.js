#!/usr/bin/env node
// ============================================================
// tests/unit/run.js —— 单元测试统一入口（逐个子进程运行，单文件崩溃不影响其余）
//
// v3.25.1：结尾**自查文档口径** —— 本文件是「单测文件数 / 断言数」的唯一实测方，因此由它比对
//   `docs/README.md` §3「单测规模」的声明值（不一致 → 失败并直接给出该改成什么），
//   避免文档数字静默漂移（这两行 `scripts/check-docs-facts.js` 无法独立核对：它不该为了两个数字再跑一遍全量）。
// ============================================================
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const files = readdirSync(DIR).filter(f => f.endsWith('.test.js')).sort();
if (!files.length) { console.error('未找到任何 *.test.js'); process.exit(1); }

console.log('\n===== FTT记忆组件 V2 单元测试（' + files.length + ' 个文件）=====\n');
let ok = 0, bad = 0;
const failed = [];
let assertions = 0;
for (const f of files) {
    console.log('\n── 运行 ' + f + ' ──');
    try {
        const out = execFileSync(process.execPath, [join(DIR, f)], { encoding: 'utf8' });
        process.stdout.write(out);
        const m = out.match(/结果:\s*(\d+)\s*通过/);
        if (m) assertions += Number(m[1]);
        ok++;
    } catch (e) {
        if (e.stdout) process.stdout.write(String(e.stdout));
        if (e.stderr) process.stderr.write(String(e.stderr));
        bad++; failed.push(f);
    }
}
console.log('\n===== 单元测试汇总：' + ok + '/' + files.length + ' 个文件通过, ' + bad + ' 失败；断言 ' + assertions + ' 项 =====');

/**
 * 文档口径自查（v3.25.1）：`docs/README.md` §3「单测规模」行的两个数字必须等于本次实测。
 * 解析失败（文档结构变了 / 该行被删）同样报错 —— 口径表不许悄悄少一行。
 * @returns {string[]} 不一致项（空数组 = 一致）
 */
function checkDocsClaim() {
    let md = '';
    try { md = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8'); }
    catch (e) { return ['读不到 docs/README.md：' + String((e && e.message) || e)]; }
    const line = md.split('\n').filter((l) => /^\|\s*单测规模\s*\|/.test(l))[0] || '';
    const m = line.match(/(\d+)\s*文件\s*\/\s*(\d+)\s*断言/);
    if (!m) return ['docs/README.md §3「单测规模」行缺失或格式不符（应形如 `156 文件 / 2414 断言`）'];
    const out = [];
    if (Number(m[1]) !== files.length) out.push('文件数：文档写 ' + Number(m[1]) + '，实测 ' + files.length);
    if (Number(m[2]) !== assertions) out.push('断言数：文档写 ' + Number(m[2]) + '，实测 ' + assertions);
    return out;
}
// 有失败文件时数字本身不完整，跳过口径比对（先修测试）
const docIssues = bad ? [] : checkDocsClaim();
if (docIssues.length) {
    for (const it of docIssues) console.log('  ❌ docs 口径不一致：' + it);
    console.log('  请把 `docs/README.md` §3「单测规模」更新为：' + files.length + ' 文件 / ' + assertions + ' 断言（同一提交内完成）');
    process.exit(1);
}

if (bad) { for (const f of failed) console.log('  ❌', f); process.exit(1); }
process.exit(0);
