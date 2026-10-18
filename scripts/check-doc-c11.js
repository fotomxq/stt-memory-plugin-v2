#!/usr/bin/env node
// ============================================================
// scripts/check-doc-c11.js —— **C11 主体纯度与版本史分离**（`docs/D14` C11 / `开发守则.md` §2.7 A–E 组）
//   `docs/D22` W5 `技-22`：把 §2.7 的可机械判定条目做成脚本。
//
// 判据（都只做「可机械判定」的部分；语义级仍由人工评审）：
//   · **E1 链式否定**：同一行 ≥2 个版本号 + `改为|不再|修正为|取代` → 违规
//   · **E3 并列标签**：`（vX.Y.Z 口径）` 这类用版本号当并列标签 → 违规
//   · **E4 标题带版本**：标题行含版本号 → 违规
//   · **B1 附录存在性**：正文出现 ≥2 个**不同**版本号，文档却没有 `## 附录` 节 → 违规
//   · **A2 正文密度**：正文（附录之前）版本号条数 → **只减不增**棘轮（基线 JSON）
//
// 范围（`开发守则.md` §2.7）：`docs/01`–`05`、`docs/D*.md`、专项层。
//   **不适用**：`docs/history/**`、`CHANGELOG.md`、台账类（`D17` / `D22`）、索引（`README`）。
//
// 模式：默认 **warning**（`exit 0`，供存量消化期）；`--strict` 阻断；`--write-baseline` 收紧基线（只减不增）；
//   `--self-test` 反向探针自检（构造 5 类违规，断言全部被检出且干净样本零命中）。
//
// 用法：node scripts/check-doc-c11.js [--strict] [--quiet] [--write-baseline] [--self-test]
// ============================================================
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
const writeBaseline = process.argv.includes('--write-baseline');
const selfTest = process.argv.includes('--self-test');
const BASELINE_REL = 'scripts/doc-c11-baseline.json';

/** 版本号（`3.50.24` / `v3.50.24`；允许四位以上尾段） */
const V_RE = /\bv?(\d+\.\d+\.\d+)\b/g;
/** 链式否定的动词 */
const NEG_RE = /改为|不再|修正为|取代/;
/** 不适用本判据的文件（台账 / 索引 / 版本史） */
const SKIP_RE = [/^README\.md$/, /^D17-/, /^D22-/, /^D24-/, /^D14-/, /^D27-/];

/** 收集待检文档（docs 顶层 .md，排除 SKIP_RE） */
function docFiles() {
    return readdirSync(join(ROOT, 'docs'))
        .filter((f) => f.endsWith('.md'))
        .filter((f) => !SKIP_RE.some((re) => re.test(f)))
        .sort();
}

/** 摘出「正文」= 附录之前（`## …附录` 起始） */
function splitBody(text) {
    const m = /^##[^\n]*附录/m.exec(text);
    return m ? { body: text.slice(0, m.index), hasAppendix: true, appendix: text.slice(m.index) } : { body: text, hasAppendix: false, appendix: '' };
}

/**
 * 检查一个文本（纯函数，供单测 / 自检复用）
 * @returns {{density:number, distinct:number, hasAppendix:boolean, hits:Array<{id:string,line:number,msg:string}>}}
 */
export function checkDocText(text, name) {
    const { body, hasAppendix } = splitBody(String(text || ''));
    const lines = body.split('\n');
    const hits = [];
    const distinct = new Set();
    let density = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const vs = [...line.matchAll(V_RE)].map((m) => m[1]);
        vs.forEach((v) => distinct.add(v));
        density += vs.length;
        // E4：标题带版本
        if (/^#{1,6}\s/.test(line) && vs.length) hits.push({ id: 'E4', line: i + 1, msg: '标题含版本号（版本号不得当标题限定语）：' + line.trim().slice(0, 60) });
        // E1：链式否定（≥2 个版本号 + 否定动词）
        if (vs.length >= 2 && NEG_RE.test(line)) hits.push({ id: 'E1', line: i + 1, msg: '链式否定（' + vs.length + ' 个版本号 + 改为/不再/修正为/取代）：' + line.trim().slice(0, 70) });
        // E3：并列标签
        if (/（v?\d+\.\d+\.\d+\s*口径）/.test(line)) hits.push({ id: 'E3', line: i + 1, msg: '用「（vX 口径）」当并列标签：' + line.trim().slice(0, 60) });
    }
    // B1：≥2 个不同版本号却没有附录
    if (distinct.size >= 2 && !hasAppendix) hits.push({ id: 'B1', line: 0, msg: '正文出现 ' + distinct.size + ' 个不同版本号，但本文档没有「## 附录」节（版本史应移入附录）' });
    return { density: density, distinct: distinct.size, hasAppendix: hasAppendix, hits: hits, name: name };
}

/** 全仓扫描 */
function scanAll(files) {
    const out = [];
    for (const f of files) {
        const t = readFileSync(join(ROOT, 'docs', f), 'utf8');
        out.push(checkDocText(t, f));
    }
    return out;
}

// ---------- 自检（反向探针） ----------
if (selfTest) {
    const cases = [
        { name: 'E1', text: '| x | 改为 A（v1.0.0），不再 B（v2.0.0） |', want: 'E1' },
        { name: 'E3', text: '见（v3.1.0 口径）与（v3.2.0 口径）', want: 'E3' },
        { name: 'E4', text: '## 3. 存储（v2.0.0 改）\n\n正文', want: 'E4' },
        { name: 'B1', text: '正文提到 v1.0.0 与 v2.0.0 两个版本，但没有附录。', want: 'B1' },
        { name: 'clean', text: '## 1. 现状\n\n本节只描述当前行为（v3.50.0 起生效）。\n\n## 附录 · 版本变更史\n\n- v3.50.0：新增。', want: null },
    ];
    let bad = 0;
    for (const c of cases) {
        const r = checkDocText(c.text, c.name);
        const ids = r.hits.map((h) => h.id);
        const ok = c.want ? ids.indexOf(c.want) >= 0 : ids.length === 0;
        if (!ok) { bad++; console.log('  ❌ 自检失败 ' + c.name + ' → 命中 ' + JSON.stringify(ids)); }
        else if (!quiet) console.log('  ✅ 自检 ' + c.name + ' → ' + (ids.length ? ids.join(',') : '零命中'));
    }
    console.log(bad ? 'C11 自检失败：' + bad + ' 组' : 'C11 自检通过（5 组反向探针）');
    process.exit(bad ? 1 : 0);
}

// ---------- 主流程 ----------
const files = docFiles();
const results = scanAll(files);
const totalHits = results.reduce((n, r) => n + r.hits.length, 0);
const byId = {};
for (const r of results) for (const h of r.hits) byId[h.id] = (byId[h.id] || 0) + 1;

const baselinePath = join(ROOT, BASELINE_REL);
let baseline = { density: {}, hits: {} };
try { if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (e) { /* 忽略 */ }

// A2 密度棘轮：每文件正文版本号数 ≤ 基线；新增/上升即违规
const densityOver = [];
for (const r of results) {
    const cap = baseline.density && baseline.density[r.name] !== undefined ? Number(baseline.density[r.name]) : r.density;
    if (r.density > cap) densityOver.push({ file: r.name, now: r.density, cap: cap });
}
// 命中棘轮：同类命中数不得超过基线
const hitsOver = [];
for (const id of Object.keys(byId)) {
    const cap = Number((baseline.hits && baseline.hits[id]) || 0);
    if (byId[id] > cap) hitsOver.push({ id: id, now: byId[id], cap: cap });
}

console.log('C11 文档主体纯度检查（`docs/D14` C11 / `开发守则.md` §2.7 A–E；' + (strict ? 'strict' : 'warning') + ' 模式）');
console.log('  · 待检 ' + files.length + ' 份 · 命中合计 ' + totalHits + ' 处（' + Object.keys(byId).sort().map((k) => k + '×' + byId[k]).join(' · ') + '）');
console.log('  · A2 密度超基线 ' + densityOver.length + ' 份 · 命中超基线 ' + hitsOver.length + ' 类');

if (!quiet) {
    for (const r of results) {
        if (!r.hits.length) continue;
        for (const h of r.hits.slice(0, 3)) console.log('  ⚠️ ' + h.id + ' ' + r.name + (h.line ? ':' + h.line : '') + ' — ' + h.msg);
    }
    for (const d of densityOver) console.log('  ⚠️ A2 ' + d.file + ' — 正文版本号 ' + d.now + ' 处 > 基线 ' + d.cap);
    for (const h of hitsOver) console.log('  ⚠️ RATCHET ' + h.id + ' — 命中 ' + h.now + ' 处 > 基线 ' + h.cap);
}

if (writeBaseline) {
    const nextDensity = {};
    for (const r of results) {
        const prev = baseline.density && baseline.density[r.name] !== undefined ? Number(baseline.density[r.name]) : Infinity;
        nextDensity[r.name] = Math.min(prev, r.density);            // 只减不增
    }
    const nextHits = {};
    for (const id of new Set([...Object.keys(baseline.hits || {}), ...Object.keys(byId)])) {
        const prev = Number((baseline.hits && baseline.hits[id]) || 0);
        const now = Number(byId[id] || 0);
        nextHits[id] = Object.keys(baseline.hits || {}).length ? Math.min(prev, now) : now;
    }
    writeFileSync(baselinePath, JSON.stringify({ note: 'C11 基线（只减不增）：docs/D22 W5 技-22', density: nextDensity, hits: nextHits }, null, 2) + '\n', 'utf8');
    console.log('  · 已更新基线 → ' + BASELINE_REL);
}

const failed = densityOver.length > 0 || hitsOver.length > 0;
console.log('  ' + (failed ? (strict ? '（strict：判为失败）' : '（warning：不阻断；--strict 才失败）') : '✅ C11 主体纯度检查通过（无新增违规）'));
process.exit(strict && failed ? 1 : 0);
