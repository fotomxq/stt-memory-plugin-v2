#!/usr/bin/env node
// ============================================================
// scripts/check-version-sync.js —— 版本一致性门禁（docs/13 §8.4）
// 校验：manifest.version == package.json version == core/constants.js VERSION == CHANGELOG 首条版本
//       （可选 --strict：HEAD 必须正好落在同名 tag 上，用于发版）
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const constants = read('core/constants.js');
const m = constants.match(/export const VERSION = '([^']+)'/);
const constVersion = m ? m[1] : null;
let changelogVersion = null;
if (existsSync(join(ROOT, 'CHANGELOG.md'))) {
    const h = read('CHANGELOG.md').match(/^##\s+v?(\d+\.\d+\.\d+)/m);
    changelogVersion = h ? h[1] : null;
}
let tag = null;
try {
    tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch (e) { tag = null; }
const tagVersion = tag ? tag.replace(/^v/, '') : null;

const rows = [
    ['manifest.json', manifest.version],
    ['package.json', pkg.version],
    ['core/constants.js', constVersion],
    ['CHANGELOG.md 首条', changelogVersion],
];
console.log('版本一致性检查：');
for (const [k, v] of rows) console.log('  ' + k.padEnd(22) + ' ' + (v || '（缺失）'));
console.log('  ' + 'git tag(HEAD)'.padEnd(22) + ' ' + (tagVersion || '（未打 tag —— 开发中）'));

const values = rows.map(r => r[1]).filter(Boolean);
const mismatch = new Set(values).size > 1;
if (mismatch) {
    console.log('❌ 版本不一致：' + values.join(' / '));
    process.exit(1);
}
if (tagVersion && tagVersion !== manifest.version) {
    console.log('❌ git tag 与 manifest.version 不一致：' + tagVersion + ' vs ' + manifest.version);
    process.exit(1);
}
if (strict && !tagVersion) {
    console.log('❌ --strict：HEAD 未落在版本 tag 上');
    process.exit(1);
}
console.log('✅ 版本一致性通过（' + manifest.version + '）' + (tagVersion ? '' : '（开发中未打 tag）'));
