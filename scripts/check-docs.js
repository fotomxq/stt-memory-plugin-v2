#!/usr/bin/env node
// ============================================================
// scripts/check-docs.js —— 文档规范校验（V2 精简版：围栏 / 语言标注 / 标题层级 /
// 效果类 HTML / 行尾空白 / 头部元信息）
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);
const issues = [];

function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (name.endsWith('.md')) acc.push(p);
    }
    return acc;
}

for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    const add = (ln, msg) => issues.push({ file: rel, line: ln, msg });

    let inFence = false, fenceAt = 0, prev = 0;
    lines.forEach((raw, idx) => {
        const st = raw.trim();
        if (st.startsWith('```')) {
            if (!inFence) { inFence = true; fenceAt = idx + 1; if (!st.slice(3).trim()) add(idx + 1, '代码块缺少语言标注'); }
            else inFence = false;
            return;
        }
        if (inFence) return;
        const h = st.match(/^(#{1,6})\s/);
        if (h) { const lvl = h[1].length; if (prev && lvl > prev + 1) add(idx + 1, '标题层级跳级 h' + prev + ' → h' + lvl); prev = lvl; }
        else if (st && !/^(\||>|-|\d+\.|\*|\[)/.test(st)) prev = 0;
        const plain = raw.split('`').filter((_, i) => i % 2 === 0).join('');
        const fx = plain.match(/<\/?(br|font|b|i|u|center|div|span|style|marquee)\b[^>]*>/i);
        if (fx) add(idx + 1, '效果类 HTML：' + fx[0]);
        if (raw !== raw.replace(/[ \t]+$/, '')) add(idx + 1, '行尾存在空白');
    });
    if (inFence) add(fenceAt, '代码围栏未闭合');

    const head = lines.slice(0, 12).join('\n');
    if (!/文档版本/.test(head) && !/^#\s/m.test(head)) add(1, '缺少头部元信息（文档版本 / 标题）');
    if (rel.startsWith('docs/') && !/文档版本/.test(head)) add(1, 'docs/ 下文档缺少「文档版本」行');
}

console.log('文档规范检查：' + walk(ROOT).length + ' 个文件');
if (issues.length) {
    for (const it of issues) console.log('  ❌ ' + it.file + ':' + it.line + ' ' + it.msg);
    console.log('文档规范：' + issues.length + ' 处违规');
    process.exit(1);
}
console.log('✅ 文档规范通过（0 违规）');
