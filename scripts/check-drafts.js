#!/usr/bin/env node
// ============================================================
// scripts/check-drafts.js —— **设计稿结构合规**（`docs/D14` §3 **C10** / `docs/D22` `技-19`，登记 `docs/D17` U118 / U119）
//
// 依据：`开发守则.md` §2.2（设计稿 9 个必备块）· §2.6（实施规格 9 个固定字段 + 维度标注 + 禁止表述）。
//   本脚本是 C10 的**机检落地**（此前"由人工评审承担"，见 `开发守则.md` §3.2.1）。
//
// 适用范围（**触及即合规**，`docs/D22` §1.7 存量口径）：
//   ① 只扫 `docs/D*.md`；**台账类**（`D17` / `D22`）按 §2.2 的**5 块变体**，本脚本不适用；
//   ② 只对**已采用新模板**（含「实施规格」小节）的稿子做结构判据 —— 存量老稿（`D1`–`D16` 等）
//      未采用该格式者**不回溯**，这就是"触及即合规"：改了它，它才进范围。
//
// 判据：
//   B1 9 个必备块齐全（头部元信息 / 目标与非目标 / 现状核对 / 方案 / 分阶段落地 / 风险与对策 /
//      待确认问题清单 / 维度归属与优先级 / 实施规格）；
//   B2 实施规格的**表头**必须齐 9 个字段（编号 · 维度 · 目标 · 落点 · 前置 · 步骤 · 验收 · 回退 · 台账）；
//   B3 实施规格每一行的**维度**必须是 业务 / 应用 / 数据 / 技术 之一（§2.5 严格全序）；
//   B4 正文不得出现 §2.6 的**禁止表述**（不可判定）；确需保留的，在该行加 `<!-- 结构豁免 -->`。
//
// 模式：默认 **warning（永远 exit 0）**（`docs/D21` §3.3「先 warning 后评阻断」）；`--strict` 才 exit 1。
//   存量违规按**基线只减不增**处置：`scripts/draft-structure-baseline.json` 记录当前违规集合，
//   之后**新增违规**（= 动过的稿子没补齐）与**基线该收窄**（= 已补齐却仍留豁免）都会报出来。
//   注意：`D18` / `D19` / `D20` 是 §2.6 的**范例**，必须**零违规**（`docs/D22` `技-19` 验收）。
//
// 用法：node scripts/check-drafts.js [--strict] [--quiet] [--write-baseline]
// ============================================================
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
const writeBaseline = process.argv.includes('--write-baseline');
const BASELINE_REL = 'scripts/draft-structure-baseline.json';
/** 台账类（§2.2 的 5 块变体，不适用 9 块模板） */
const LEDGER_DRAFTS = ['D17', 'D22'];
/** §2.6 的禁止表述（不可判定） */
const FORBIDDEN = ['视情况而定', '适当优化', '参考某某实现'];
/** 结构豁免标记（行内 HTML 注释，渲染不可见） */
const EXEMPT = '<!-- 结构豁免 -->';
/** §2.5 的四个维度 */
const DIMS = ['业务', '应用', '数据', '技术'];
/** §2.6 的 9 个字段（顺序即表格列序） */
const SPEC_FIELDS = ['编号', '维度', '目标', '落点', '前置', '步骤', '验收', '回退', '台账'];

const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
const draftFiles = (() => {
    try {
        return readdirSync(join(ROOT, 'docs'))
            .filter((f) => /^D\d+.*\.md$/.test(f))
            .filter((f) => LEDGER_DRAFTS.indexOf(String(f).split('-')[0]) < 0)
            .sort();
    } catch (e) { return []; }
})();

/** 把正文按 `##` 级标题切块，返回 `[{title, body}]`（`title` 为标题文字，不含 `##`） */
function sections(md) {
    const out = [];
    let cur = null;
    for (const line of String(md).split('\n')) {
        const m = /^##\s+(.*)$/.exec(line);
        if (m) { cur = { title: m[1].trim(), body: [] }; out.push(cur); continue; }
        if (cur) cur.body.push(line);
    }
    return out.map((s) => ({ title: s.title, body: s.body.join('\n') }));
}

/** 实施规格小节里的**表格**（取第一个含表头的表格） */
function specTable(body) {
    const lines = String(body).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().charAt(0) !== '|') continue;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.indexOf('编号') < 0 || cells.indexOf('维度') < 0) continue;
        const rows = [];
        for (let j = i + 2; j < lines.length; j++) {
            const l = lines[j];
            if (l.trim().charAt(0) !== '|') break;
            rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
        }
        return { header: cells, rows: rows };
    }
    return null;
}

const problems = [];
const seen = new Set();             // 违规指纹（基线比对用）
const detail = [];                  // 逐条打印

for (const f of draftFiles) {
    const md = read(join('docs', f));
    if (!md) continue;
    const secs = sections(md);
    const titles = secs.map((s) => s.title);
    const has = (re) => titles.some((t) => re.test(t));
    /** 只在**含实施规格**的稿子上做结构判据（触及即合规） */
    const specSec = secs.filter((s) => /实施规格/.test(s.title))[0];
    if (!specSec) continue;

    const add = (id, msg) => {
        const key = f + '|' + id;
        if (seen.has(key)) return;
        seen.add(key);
        problems.push(f + '（' + id + '）：' + msg);
        detail.push({ file: f, id: id, msg: msg });
    };

    // B1：9 个必备块
    //   块名**接受同义写法**（存量稿的标题各有措辞；判据认的是"这一块在不在"，不是"标题逐字相同"）：
    //     ③ 现状核对 → 也认「现状梳理」「现状核实」；④ 方案 → 也认「缺陷逐一完善」「判据设计」；
    //     ⑤ 分阶段落地 → 也认「落地顺序」（如 `D18` §7.2）；⑦ 待确认问题清单 → 也认「决策记录」（裁决已定时的形态）。
    const blocks = [
        ['头部元信息', /^>\s*文档版本/m.test(md)],
        ['目标 / 非目标', has(/目标/) && /非目标/.test(md)],
        ['现状核对', has(/现状核对|现状梳理|现状核实/)],
        ['方案', has(/方案|缺陷逐一完善|判据设计/)],
        ['分阶段落地', has(/分阶段|落地顺序/)],
        ['风险与对策', has(/风险/)],
        ['待确认问题清单', has(/待确认问题|决策记录/)],
        // ⑧ 维度归属与优先级：**两种合法形态**都认 —— ① 独立小节；② 头部元信息里声明
        //   （`D18` 起的新稿把「本篇维度」写在头部 `**维度归属：…**`，见其 v1.1 变更说明；`D19`–`D28` 两处都有）
        ['维度归属与优先级', has(/维度归属/) || /^>[^\n]*维度归属/m.test(md)],
        ['实施规格', true],
    ];
    for (const [name, ok] of blocks) if (!ok) add('B1', '缺必备块「' + name + '」（`开发守则.md` §2.2）');

    // B2：实施规格表头 9 字段
    const tb = specTable(specSec.body);
    if (!tb) {
        add('B2', '实施规格小节里找不到「编号 / 维度」表头的表格');
    } else {
        const missing = SPEC_FIELDS.filter((x) => tb.header.indexOf(x) < 0);
        if (missing.length) add('B2', '实施规格表头缺字段：' + missing.join('、') + '（§2.6 的 9 个字段一个不能少）');
        // B3：每行维度合法（维度格里**允许带尾注**，如 `技术 **[契约]**（R4）` → 以**开头**是否为维度词判定）
        const badDims = tb.rows
            .filter((r) => r.length >= 2 && r[0] && r[0] !== '---')
            .filter((r) => !DIMS.some((d) => r[1].indexOf(d) === 0))
            .map((r) => (r[0] || '(无编号)') + '→' + (r[1] || '(空)'));
        if (badDims.length) add('B3', '实施规格条目维度不合规（须为 业务/应用/数据/技术）：' + badDims.slice(0, 6).join('、') + (badDims.length > 6 ? '…' : ''));
    }

    // B4：禁止表述（本行带 `<!-- 结构豁免 -->` 的除外）
    const offenders = [];
    for (const line of md.split('\n')) {
        if (line.indexOf(EXEMPT) >= 0) continue;
        for (const w of FORBIDDEN) if (line.indexOf(w) >= 0) offenders.push(w);
    }
    if (offenders.length) add('B4', '出现 §2.6 的禁止表述（不可判定）：' + Array.from(new Set(offenders)).join('、')
        + '；确需保留请在该行加 `' + EXEMPT + '` 并写明理由');
}

// ---------- 范例硬约束（`docs/D22` `技-19` 验收：D18/D19/D20 必须通过） ----------
const EXAMPLES = ['D18', 'D19', 'D20'];
const exampleViolations = problems.filter((p) => EXAMPLES.some((e) => p.indexOf(e + '-') === 0));
if (exampleViolations.length) {
    problems.push('范例稿（' + EXAMPLES.join(' / ') + '）必须零违规，实测 ' + exampleViolations.length + ' 条：见上');
}

// ---------- 基线（只减不增） ----------
let baseline = null;
try { baseline = JSON.parse(read(join('scripts', 'draft-structure-baseline.json'))); } catch (e) { baseline = null; }
const baseList = (baseline && Array.isArray(baseline.violations)) ? baseline.violations.map(String) : [];
const baseSet = new Set(baseList);
const nowKeys = problems.map((p) => p.split('：')[0]);
let addedViolations = [], staleBaseline = [];
if (!baseline) {
    problems.push('基线文件缺失或不可解析：' + BASELINE_REL + '（用 `--write-baseline` 生成）');
} else {
    addedViolations = nowKeys.filter((k) => !baseSet.has(k));
    staleBaseline = baseList.filter((k) => nowKeys.indexOf(k) < 0);
}

if (writeBaseline) {
    const boot = (!baseline || baseList.length === 0);
    const keep = (boot ? nowKeys.slice() : baseList.filter((k) => nowKeys.indexOf(k) >= 0)).sort();
    const out = {
        what: '设计稿结构合规（C10 / `技-19`）的**存量违规基线**（只减不增；「触及即合规」不回填）',
        why: '存量老稿未采用 9 块模板；基线把现状固化，只让**新增违规**与**基线该收窄**报出来',
        how: 'node scripts/check-drafts.js --write-baseline',
        updatedAt: new Date().toISOString().slice(0, 10),
        violations: keep,
    };
    try {
        writeFileSync(join(ROOT, BASELINE_REL), JSON.stringify(out, null, 2) + '\n', 'utf8');
        console.log('  · 已' + (boot ? '建立（bootstrap）' : '收紧') + '基线：' + baseList.length + ' → ' + keep.length + '（' + BASELINE_REL + '）');
    } catch (e) { problems.push('写入基线失败：' + String((e && e.message) || e)); }
}

// ---------- 输出 ----------
console.log('设计稿结构合规检查（C10）：扫描 ' + draftFiles.length + ' 份 `docs/D*.md`（其中含「实施规格」者才做结构判据）');
if (nowKeys.length) {
    if (!quiet) for (const d of detail) console.log('  ⚠️ ' + d.file + ' [' + d.id + '] ' + d.msg);
    if (addedViolations.length) console.log('  ⚠️ **新增违规**（不在基线里）：' + addedViolations.join('、'));
    if (staleBaseline.length) console.log('  ⚠️ **基线该收窄**（这些违规已不复现）：' + staleBaseline.join('、'));
    console.log('设计稿结构合规：' + nowKeys.length + ' 条（' + (strict ? '--strict → 视为失败' : 'warning 模式：不阻断') + '）');
    process.exit(strict ? 1 : 0);
}
console.log('✅ 设计稿结构合规通过（9 块齐全 · 实施规格 9 字段齐全 · 维度合规 · 无禁止表述）');
