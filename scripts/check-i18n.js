// ============================================================
// scripts/check-i18n.js —— 词条门禁
// ① 两份 JSON 必须可解析且**键集完全一致**（键 = 界面上的中文字面量）；
// ② `i18n/<locale>.js` ESM 镜像必须与对应 JSON **逐值一致**（防手改镜像造成运行时与 ST 扫描不一致）。
// 用法：node scripts/check-i18n.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['zh-cn', 'en'];
const problems = [];
const dicts = {};

for (const l of LOCALES) {
    try {
        dicts[l] = JSON.parse(readFileSync(join(ROOT, 'i18n', l + '.json'), 'utf8'));
    } catch (e) {
        problems.push('i18n/' + l + '.json 解析失败：' + String((e && e.message) || e));
    }
}

const base = dicts['zh-cn'] ? Object.keys(dicts['zh-cn']).sort() : [];
for (const l of LOCALES) {
    if (!dicts[l]) continue;
    const keys = Object.keys(dicts[l]).sort();
    if (JSON.stringify(keys) !== JSON.stringify(base)) {
        const miss = base.filter((k) => keys.indexOf(k) < 0);
        const extra = keys.filter((k) => base.indexOf(k) < 0);
        problems.push('i18n/' + l + '.json 键集与 zh-cn 不一致（缺 ' + miss.length + ' / 多 ' + extra.length + '）：' + miss.concat(extra).slice(0, 6).join('、'));
    }
}

for (const l of LOCALES) {
    try {
        const mod = await import(pathToFileURL(join(ROOT, 'i18n', l + '.js')).href);
        const mirror = mod.default || {};
        const json = dicts[l] || {};
        const diffKeys = Object.keys(json).filter((k) => mirror[k] !== json[k]).concat(Object.keys(mirror).filter((k) => json[k] === undefined));
        if (diffKeys.length) problems.push('i18n/' + l + '.js 与 JSON 不一致：' + diffKeys.slice(0, 6).join('、'));
    } catch (e) {
        problems.push('i18n/' + l + '.js 导入失败：' + String((e && e.message) || e));
    }
}

console.log('词条门禁检查：' + LOCALES.length + ' 种语言 · ' + Object.keys(dicts['zh-cn'] || {}).length + ' 条');
if (problems.length) {
    console.log('❌ 词条门禁未通过（' + problems.length + ' 项）');
    problems.slice(0, 10).forEach((p) => console.log('   · ' + p));
    process.exit(1);
}
console.log('✅ 词条门禁通过（键集一致 · JS 镜像与 JSON 同步）');
