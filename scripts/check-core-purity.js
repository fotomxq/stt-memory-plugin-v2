#!/usr/bin/env node
// ============================================================
// scripts/check-core-purity.js —— 内核纯净度门禁（docs/13 §4 依赖方向）
// 规则：core/ 下所有 .js 必须零宿主依赖 ——
//   ① 不得 import ../host ../adapters ../ui 或仓库外的相对路径；
//   ② 不得出现 window/document/localStorage/SillyTavern/fetch/navigator 等宿主标识符。
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'core');
const FORBIDDEN_IMPORT = /from\s+['"](\.\.\/(host|adapters|ui)|\.\.\/\.\.\/)/;
const FORBIDDEN_IDENT = /\b(window|document|localStorage|sessionStorage|navigator|SillyTavern|fetch|XMLHttpRequest|indexedDB|toastr)\b/;

function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (name.endsWith('.js')) acc.push(p);
    }
    return acc;
}

const files = walk(CORE);
const issues = [];
let checked = 0;
for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    let inBlock = false;
    lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('/*')) inBlock = true;
        if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
        if (t.startsWith('//')) return;
        const code = line.split('//')[0];
        if (FORBIDDEN_IMPORT.test(code)) issues.push({ file: relative(ROOT, f), line: i + 1, msg: '内核引用了宿主层路径' });
        if (FORBIDDEN_IDENT.test(code)) issues.push({ file: relative(ROOT, f), line: i + 1, msg: '内核出现宿主/浏览器标识符: ' + (code.match(FORBIDDEN_IDENT) || [])[0] });
    });
    checked++;
}
console.log('内核纯净度检查：扫描 ' + checked + ' 个文件（core/）');
if (issues.length) {
    for (const it of issues) console.log('  ❌ ' + it.file + ':' + it.line + ' ' + it.msg);
    console.log('内核纯净度：' + issues.length + ' 处违规');
    process.exit(1);
}
console.log('✅ 内核纯净度通过（0 违规）');
