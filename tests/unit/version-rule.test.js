// ============================================================
// 单元测试 · v3.25.1「版本号规则」+「docs 事实一致性门禁」自检
//
// 用户要求（原话）：①「版本号后续追加，只在 **3.XX.XX** 基础上追加，可一直追加三位数及以上，
//   尽量不动 `3.`，除非我明确要求。」②「请核对 docs 文档内容的一致性，完善相关文档。」
//
// 覆盖：
//   A 版本号规则纯函数（`scripts/check-version-sync.js#checkVersionFormat`）——
//     合法 / 位数递增（3.25.9 → 3.25.10 → 3.99.9 → 3.100.0）/ 格式非法 / 主版本非 3 时必须失败（除非显式放行）；
//   B 规则与文档**同源**：`docs/README.md` §3 的「版本号规则」行与四处版本都指向同一规则；
//   C docs 事实门禁本身可用：`scripts/check-docs-facts.js` 能跑通，且**真的会**在数字被改动时报错（反向探针）。
// 运行：node tests/unit/version-rule.test.js
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { checkVersionFormat, FIXED_MAJOR, VERSION_RULE } from '../../scripts/check-version-sync.js';

const R = makeReporter('version-rule v3.25.1 版本号追加规则 + docs 事实门禁自检');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------- A 组：规则纯函数 ----------
A('A1 合法版本号：主版本固定 3；`minor`/`patch` **位数不限**（两位、三位、四位都合法）', (() => {
    const ok = ['3.0.0', '3.9.9', '3.25.0', '3.25.10', '3.100.0', '3.999.1000'];
    return FIXED_MAJOR === 3 && ok.every((v) => checkVersionFormat(v).ok === true)
        && ok.every((v) => checkVersionFormat(v).major === 3)
        && checkVersionFormat('3.100.0').ok === true && checkVersionFormat('3.25.10').ok === true;
})(), () => J(['3.25.10', '3.100.0'].map((v) => checkVersionFormat(v))));

A('A2 **追加**语义不因位数变化而破：`3.99.9 → 3.100.0`（minor 进位到三位）与 `3.25.9 → 3.25.10`（patch 进位）都必须合法', (() => {
    return checkVersionFormat('3.99.9').ok === true && checkVersionFormat('3.100.0').ok === true
        && checkVersionFormat('3.25.9').ok === true && checkVersionFormat('3.25.10').ok === true;
})(), VERSION_RULE);

A('A3 格式非法一律失败并给出可读原因：缺段 / 多段 / 非数字 / 前缀 v / 预发布后缀 / 空值', (() => {
    const bad = ['3.25', '3', '3.25.0.1', '3.25.x', 'v3.25.0', '3.25.0-p1', '', null, undefined, 'abc'];
    return bad.every((v) => checkVersionFormat(v).ok === false)
        && checkVersionFormat('3.25').reason.indexOf('格式不合规') === 0
        && checkVersionFormat('v3.25.0').reason.indexOf('格式不合规') === 0;
})(), () => J(['3.25', 'v3.25.0', '3.25.0-p1'].map((v) => checkVersionFormat(v).reason)));

A('A4 **主版本非 3 → 失败**（用户裁决：尽量不动 3.，除非明确要求）；显式放行（`allowMajor=true`）时通过但 `major` 如实回报', (() => {
    const blocked = ['4.0.0', '2.99.9', '10.0.0'].map((v) => checkVersionFormat(v));
    const allowed = checkVersionFormat('4.0.0', true);
    return blocked.every((r) => r.ok === false && r.reason.indexOf('主版本必须是 3') === 0)
        && blocked.every((r) => r.reason.indexOf('位数不限') > 0)          // 报错文案自带规则说明
        && allowed.ok === true && allowed.major === 4;
})(), () => J(['4.0.0', '2.99.9'].map((v) => checkVersionFormat(v).reason)));

// ---------- B 组：规则与文档同源 ----------
A('B1 四处版本号一致、均合规，且与 `docs/README.md` §3 的版本号行/规则行一致（文档没写旧版本、也没写旧规则）', (() => {
    const manifest = JSON.parse(read('manifest.json')).version;
    const pkg = JSON.parse(read('package.json')).version;
    const constVer = (read('core/constants.js').match(/export const VERSION = '([^']+)'/) || [])[1];
    const headVer = (read('CHANGELOG.md').match(/^##\s+v?(\d+\.\d+\.\d+)/m) || [])[1];
    const md = read('docs/README.md');
    const verLine = md.split('\n').filter((l) => /^\|\s*版本号\s*\|/.test(l))[0] || '';
    const ruleLine = md.split('\n').filter((l) => /^\|\s*版本号规则\s*\|/.test(l))[0] || '';
    const headClaim = (md.match(/当前值（v(\d+\.\d+\.\d+)）/) || [])[1] || '';
    return new Set([manifest, pkg, constVer, headVer]).size === 1
        && checkVersionFormat(manifest).ok === true
        && verLine.indexOf('`' + manifest + '`') > 0
        && headClaim === manifest
        && ruleLine.indexOf('3.XX.XX') > 0 && ruleLine.indexOf('主版本固定 3') > 0 && ruleLine.indexOf('位数不限') > 0;
})(), () => J({ v: JSON.parse(read('manifest.json')).version }));

// ---------- C 组：docs 事实门禁可用 + 反向探针 ----------
A('C1 `scripts/check-docs-facts.js` 在**当前工作区**跑通（退出码 0）—— 说明 §3 数字口径 / 目录地图 / 版本规则 / 引用与目录树此刻全部一致', (() => {
    try {
        const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-docs-facts.js')], { cwd: ROOT, encoding: 'utf8' });
        return out.indexOf('✅ docs 事实一致性通过') >= 0;
    } catch (e) { return false; }
})(), '');

A('C2 **反向探针**：把 §3「内核配置键数」故意改错 → 门禁必须失败并指出「文档写 X、实测 Y」（跑完自动还原，不改仓库）', (() => {
    const p = join(ROOT, 'docs', 'README.md');
    const back = readFileSync(p, 'utf8');
    try {
        const patched = back.replace(/(\|\s*内核配置键数\s*\|[^|]*\|\s*)(\d+)/, '$1' + '1');
        if (patched === back) return false;                       // 行不存在 → 视为失败（口径表被改坏了）
        writeFileSync(p, patched);
        let failed = false, said = '';
        try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-docs-facts.js')], { cwd: ROOT, encoding: 'utf8' }); }
        catch (e) { failed = true; said = String(e.stdout || ''); }
        return failed && said.indexOf('§3「内核配置键数」') >= 0 && said.indexOf('实测') > 0;
    } finally { writeFileSync(p, back); }
})(), '');

R.done();
