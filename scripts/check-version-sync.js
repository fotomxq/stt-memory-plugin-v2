#!/usr/bin/env node
// ============================================================
// scripts/check-version-sync.js —— 版本一致性门禁（docs/13 §8.4）
// 校验：manifest.version == package.json version == core/constants.js VERSION == CHANGELOG 首条版本
//       + **版本号规则**（v3.25.1 起）：形如 `3.<minor>.<patch>`、**主版本固定 3**、minor/patch 位数不限
//       （可选 --strict：HEAD 必须正好落在同名 tag 上，用于发版）
//
// 规则来源（用户裁决）：「版本号后续追加，只在 **3.XX.XX** 基础上追加，可一直追加三位数及以上，
//   **尽量不动 `3.`**，除非我明确要求。」→ 主版本不是 3 时本脚本直接失败；确有需要时须用户明确要求，
//   并同步修订 `开发守则.md` §3.1 与之配套的这段校验（不允许悄悄放宽）。
// 绕过开关（仅用于「用户明确要求改主版本」的那一次）：`--allow-major-change` 或 `FTT_ALLOW_MAJOR_CHANGE=1`。
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const allowMajor = process.argv.includes('--allow-major-change') || process.env.FTT_ALLOW_MAJOR_CHANGE === '1';
/** 固定主版本（与 `开发守则.md` §3.1 同源） */
export const FIXED_MAJOR = 3;
/** 版本号规则的**人读说明**（报错文案与文档共用同一句话） */
export const VERSION_RULE = '规则：形如 3.<minor>.<patch>；主版本固定 ' + FIXED_MAJOR
    + '；minor/patch 位数不限（3.25.9 → 3.25.10 → 3.100.0 照常追加）；只增不复用。';
/**
 * 单个版本号是否合规（纯函数，供门禁与单测共用）。
 * @param {string} v 版本号
 * @param {boolean} [allowMajor] 是否放行非 3 主版本（**仅**用于「用户明确要求改主版本」的那一次）
 * @returns {{ok:boolean, reason:string, major:number|null}}
 */
export function checkVersionFormat(v, allowMajor) {
    const s = String(v == null ? '' : v).trim();
    if (!/^\d+\.\d+\.\d+$/.test(s)) return { ok: false, reason: '格式不合规（' + VERSION_RULE + '）', major: null };
    const major = Number(s.split('.')[0]);
    if (major !== FIXED_MAJOR && allowMajor !== true) {
        return { ok: false, reason: '主版本必须是 ' + FIXED_MAJOR + '，当前 ' + s + '（' + VERSION_RULE + '）', major: major };
    }
    return { ok: true, reason: '', major: major };
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (!isMain) {
    // 被单测 import 时只提供上面的纯函数，不跑门禁主体
} else {

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

// —— 版本号规则（用户裁决：「只在 3.XX.XX 基础上追加，可一直追加三位数以上，尽量不动 3.」）——
let ruleBad = false;
for (const [k, v] of rows) {
    if (!v) continue;
    const r = checkVersionFormat(v, allowMajor);
    if (r.ok) continue;
    console.log('❌ 版本号不合规：' + k + ' = ' + v + ' —— ' + r.reason);
    ruleBad = true;
}
if (ruleBad) {
    console.log('  提示：主版本**不擅自改**；确有需要时须用户明确要求，并同步修订 `开发守则.md` §3.1 后带 `--allow-major-change` 运行。');
    process.exit(1);
}
if (allowMajor) console.log('  ' + '⚠ 主版本校验'.padEnd(20) + ' 已按 --allow-major-change 放行（须有用户明确要求）');

if (tagVersion && tagVersion !== manifest.version) {
    console.log('❌ git tag 与 manifest.version 不一致：' + tagVersion + ' vs ' + manifest.version);
    process.exit(1);
}
if (strict && !tagVersion) {
    console.log('❌ --strict：HEAD 未落在版本 tag 上');
    process.exit(1);
}
console.log('✅ 版本一致性通过（' + manifest.version + '）' + (tagVersion ? '' : '（开发中未打 tag）'));
}   // ← 结束 `if (isMain)`（被 import 时只导出纯函数，不跑门禁主体）