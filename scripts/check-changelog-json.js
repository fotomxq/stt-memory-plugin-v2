#!/usr/bin/env node
// ============================================================
// scripts/check-changelog-json.js —— 版本清单门禁（v2.53.0）
//
// 校验三件事：
//   ① `FTT-memory-changelog.json` 与 `CHANGELOG.md` **逐字节一致**（由生成器再算一次比对，防手改漂移）；
//   ② 清单顶层 version == manifest.version（否则「关于」页会显示旧版本为最新）；
//   ③ 清单结构与「关于」页渲染契约一致：changelog 非空、首条 version/date 合法、每条都有 title 与 points 数组。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_FILE, renderFromRepo } from './gen-changelog-json.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];
const add = (m) => issues.push(m);

let json = null;
try {
    json = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
} catch (e) {
    add('FTT-memory-changelog.json 缺失或不是合法 JSON：' + String((e && e.message) || e));
}

if (json) {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const next = renderFromRepo();
    const prev = readFileSync(OUT_FILE, 'utf8');
    if (prev !== next) add('清单与 CHANGELOG.md 不同步（运行 node scripts/gen-changelog-json.js 重新生成）');
    if (String(json.version) !== String(manifest.version)) {
        add('清单 version(' + json.version + ') != manifest.version(' + manifest.version + ')');
    }
    if (!Array.isArray(json.changelog) || !json.changelog.length) add('changelog 必须是非空数组');
    (json.changelog || []).forEach((e, i) => {
        const at = 'changelog[' + i + ']';
        if (!/^\d+\.\d+\.\d+$/.test(String(e && e.version))) add(at + ' version 非法：' + (e && e.version));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e && e.date))) add(at + ' date 非法（应为 YYYY-MM-DD）：' + (e && e.date));
        if (!e || typeof e.title !== 'string' || !e.title) add(at + ' 缺少 title');
        if (!e || !Array.isArray(e.points)) add(at + ' points 必须是数组');
    });
    const first = (json.changelog || [])[0];
    if (first && String(first.version) !== String(manifest.version)) {
        add('首条版本(' + first.version + ') 应等于当前版本(' + manifest.version + ')（清单按版本倒序）');
    }
}

console.log('版本清单检查：FTT-memory-changelog.json' + (json ? '（' + (json.changelog || []).length + ' 个版本）' : ''));
if (issues.length) {
    for (const m of issues) console.log('  ❌ ' + m);
    console.log('版本清单：' + issues.length + ' 处违规');
    process.exit(1);
}
console.log('✅ 版本清单通过（与 CHANGELOG.md 同步 · 版本 ' + json.version + '）');
