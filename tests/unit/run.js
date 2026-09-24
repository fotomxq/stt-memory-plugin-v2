#!/usr/bin/env node
// ============================================================
// tests/unit/run.js —— 单元测试统一入口（逐个子进程运行，单文件崩溃不影响其余）
// ============================================================
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
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
if (bad) { for (const f of failed) console.log('  ❌', f); process.exit(1); }
process.exit(0);
