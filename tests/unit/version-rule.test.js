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
//   C docs 事实门禁本身可用：`scripts/check-docs-facts.js` 能跑通，且**真的会**在数字被改动时报错（反向探针）；
//   D v1.1 新增判据的反向探针：C8（符号级存在性）/ C9（本仓库源码绝对行号棘轮）——用临时台账文件探针，不改既有文档。
// 运行：node tests/unit/version-rule.test.js
// ============================================================
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { checkVersionFormat, FIXED_MAJOR, VERSION_RULE } from '../../scripts/check-version-sync.js';
// v3.40.3（`docs/D22` `技-12`）：C5 批次档前缀唯一匹配 / C6 目录树结构化解析的纯函数
import { batchHits, parseTopTreeNames } from '../../scripts/docs-facts-lib.js';

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

// ---------- D 组：v1.1 新增判据 C8（符号级存在性）/ C9（行号棘轮）的反向探针 ----------
// 为什么用**临时台账文件**做探针：C8/C9 扫的是 `docs/**` 全量，直接改既有文档会污染仓库；
//   新建一个 `docs/D99-探针.md`（头部元信息合规、含故意写错的引用）→ 跑门禁 → 必失败 → 删除。
//   这样探针**不改任何既有文档**，也不会因为中途异常留下垃圾（finally 里删）。
const PROBE_DOC = join(ROOT, 'docs', 'D99-门禁反向探针.md');
const PROBE_HEAD = '# D99 · 门禁反向探针（临时）\n\n> 文档版本：v1.0 ｜ 日期：2026-10-06 ｜ 类型：**设计稿（不发版）** ｜ 状态：临时\n\n';
const runFacts = () => {
    try { return { ok: true, out: execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-docs-facts.js')], { cwd: ROOT, encoding: 'utf8' }) }; }
    catch (e) { return { ok: false, out: String(e.stdout || '') }; }
};
A('D1 **C8 反向探针**：文档里写一个不存在的符号（`core/rumor-evolve.js#notARealSymbol`）→ 门禁必须失败并指出「符号引用不存在」', (() => {
    try {
        writeFileSync(PROBE_DOC, PROBE_HEAD + '引用：`core/rumor-evolve.js#notARealSymbol`。\n', 'utf8');
        const r = runFacts();
        return r.ok === false && r.out.indexOf('符号引用不存在') >= 0 && r.out.indexOf('notARealSymbol') >= 0;
    } catch (e) { return false; } finally { try { rmSync(PROBE_DOC, { force: true }); } catch (e) { /* 忽略 */ } }
})(), '');

A('D2 **C9 反向探针**：文档里**新增**一批本仓库源码的绝对行号引用 → 门禁必须失败并提示「改成 `文件#符号`」', (() => {
    try {
        const lines = [];
        for (let i = 1; i <= 12; i++) lines.push('引用 ' + i + '：`core/recall.js:' + (100 + i) + '`。');
        writeFileSync(PROBE_DOC, PROBE_HEAD + lines.join('\n') + '\n', 'utf8');
        const r = runFacts();
        return r.ok === false && r.out.indexOf('绝对行号引用') >= 0 && r.out.indexOf('文件#符号') >= 0;
    } catch (e) { return false; } finally { try { rmSync(PROBE_DOC, { force: true }); } catch (e) { /* 忽略 */ } }
})(), '');

A('D3 C8/C9 的**正向**口径：当前工作区的符号引用全部可解析、行号引用未越预算（探针删净后门禁回到通过）', (() => {
    const r = runFacts();
    return r.ok === true && r.out.indexOf('引用形态：') > 0
        && r.out.indexOf('全部可解析') > 0 && r.out.indexOf('只减不增') > 0
        && existsSync(PROBE_DOC) === false;
})(), '');

// ---------- E 组：v3.40.3（`docs/D22` `技-12`）—— C5 批次档前缀 / C6 目录树结构化解析的反向探针 ----------
// 这两处判据抽成了纯函数（`scripts/docs-facts-lib.js`），因此探针可以**精确驱动**它们，
//   不必往 `docs/` 写临时文件（那会反过来牵动 C6 自己的目录树集合判据）。
A('E1 **C5 反向探针**：写一个不存在的**批次档前缀**（`history/P10c9999`）→ 门禁必须失败并指出「批次档引用不存在」', (() => {
    try {
        writeFileSync(PROBE_DOC, PROBE_HEAD + '见 `history/P10c9999`。\n', 'utf8');
        const r = runFacts();
        return r.ok === false && r.out.indexOf('批次档引用不存在') >= 0 && r.out.indexOf('P10c9999') >= 0;
    } catch (e) { return false; } finally { try { rmSync(PROBE_DOC, { force: true }); } catch (e) { /* 忽略 */ } }
})(), '');

A('E2 **C5 唯一匹配**：`P10c6` 只认 `P10c6-…`（不吞 `P10c60`–`P10c68`）、`P10c` 只认 `P10c-…`、`P10c68` 唯一；不存在的前缀命中 0 条', (() => {
    const names = ['P10c6-分片提交.md', 'P10c60-快照拆分.md', 'P10c68-D16-P0P1落地.md', 'P10c-时钟取值追踪与日志口径.md'];
    const a = batchHits('P10c6', names), b = batchHits('P10c', names), c = batchHits('P10c68', names), d = batchHits('P10c9999', names);
    return a.length === 1 && a[0] === 'P10c6-分片提交.md'
        && b.length === 1 && b[0] === 'P10c-时钟取值追踪与日志口径.md'
        && c.length === 1 && c[0] === 'P10c68-D16-P0P1落地.md'
        && d.length === 0;
})(), '');

A('E3 **C6 反向探针**：树条目的**描述文字里含 `history/`** 也不得截短比较范围（旧实现裸子串截断 → 后两行被吞掉、误报「漏列」）', (() => {
    const tree = [
        '## 1. 目录结构（四层）',
        '```text',
        'docs/',
        '├── README.md               # 索引（本文件）',
        '├── D22-开发待办清单.md     # 设计层（读法见 history/P10c46 与 docs/history/ 全层）',
        '├── D28-性能专项设计稿.md   # 设计层（evidence 在 history/P10c70）',
        '└── history/                # 历史批次层（只读留痕）',
        '    ├── README.md',
        '    └── P10c70-x.md',
        '```',
        '## 2. 阅读路径',
    ].join('\n');
    const got = parseTopTreeNames(tree);
    return got.length === 2 && got[0] === 'D22-开发待办清单.md' && got[1] === 'D28-性能专项设计稿.md';
})(), '');

A('E4 **C6 正向**：真实 `docs/README.md` 的目录树解析结果 == 磁盘上的 `docs/*.md` 集合（不含 README.md 自身）', (() => {
    const md = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8');
    const got = parseTopTreeNames(md).slice().sort();
    const disk = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
    return got.length === disk.length && got.every((v, i) => v === disk[i]);
})(), '');

R.done();
