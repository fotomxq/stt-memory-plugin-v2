#!/usr/bin/env node
// ============================================================
// scripts/check-file-size.js —— **单体文件体量门禁**（`docs/D22` W5 `技-14`；`docs/D17` U134）
//
// 守的是什么（一句话）：三个主体量文件（`ui/panel.js` / `index.js` / `adapters/store.js`）**不许继续堆功能**；
//   `ui/debug.js` / `core/config.js` 同口径纳入。判据 = 「基线 + 必要接线宽限」，只减不增。
//
// 用法：
//   node scripts/check-file-size.js              # 门禁（超出上限 → exit 1）
//   node scripts/check-file-size.js --strict     # 宽限按 0（只允许变小）
//   node scripts/check-file-size.js --json       # 机器可读（供门禁汇总/单测）
//   node scripts/check-file-size.js --write      # **重写基线**（只在文件真的变小、或经用户裁决后使用）
//
// 边界（硬性）：本脚本**只读源码行数**，不改写任何源码；`--write` 只写 `scripts/file-size-baseline.json`。
//   `--write` 在「有文件比基线更大」时**默认拒绝**（防止把膨胀顺手洗成新基线）——确需上调须显式 `--allow-growth`
//   并在 `CHANGELOG.md` 里写明理由（与 `docs/D21` §8 的「撤销该约定」口径一致）。
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MARGIN, WATCHED_FILES, countLines, planFileSize, fileSizeReportText } from './file-size-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_REL = 'scripts/file-size-baseline.json';
const BASELINE_PATH = join(ROOT, BASELINE_REL);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const AS_JSON = has('--json');
const STRICT = has('--strict');
const WRITE = has('--write');
const ALLOW_GROWTH = has('--allow-growth');

/** 实测当前行数（读不到 → 0，并在报告里体现为 ❓ 未基线） */
function currentSizes() {
    const out = [];
    for (const w of WATCHED_FILES) {
        let lines = 0;
        try { lines = countLines(readFileSync(join(ROOT, w.file), 'utf8')); } catch (e) { lines = 0; }
        out.push({ file: w.file, lines: lines });
    }
    return out;
}

function loadBaseline() {
    try {
        if (!existsSync(BASELINE_PATH)) return { margin: DEFAULT_MARGIN, files: {} };
        const j = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
        return { margin: (Number(j.margin) >= 0 ? Number(j.margin) : DEFAULT_MARGIN), files: (j.files || {}), note: String(j.note || '') };
    } catch (e) { return { margin: DEFAULT_MARGIN, files: {} }; }
}

const current = currentSizes();
const baseline = loadBaseline();
const plan = planFileSize(current, baseline, { strict: STRICT });

if (WRITE) {
    const initial = !baseline.files || Object.keys(baseline.files).length === 0;   // 首次建基线：允许（没有可比对象）
    const grew = plan.rows.filter((r) => r.delta > 0 && r.base > 0);
    if (grew.length && !ALLOW_GROWTH) {
        console.log('❌ 拒绝写基线：以下文件比基线**更大** —— 体量门禁的意义就是不让它继续涨');
        for (const r of grew) console.log('   · ' + r.file + ' +' + r.delta + ' 行（基线 ' + r.base + ' → 实测 ' + r.lines + '）');
        console.log('   确需上调请显式加 `--allow-growth`，并在 `CHANGELOG.md` 写明理由（属「撤销该约定」级别）。');
        process.exit(1);
    }
    const next = {
        note: '单体文件体量基线（`docs/D22` W5 `技-14` / `docs/D17` U134）。`margin` = 「必要接线」宽限（行）。只减不增：`--write` 在有文件变大时默认拒绝。',
        margin: (Number(baseline.margin) >= 0 ? Number(baseline.margin) : DEFAULT_MARGIN),
        files: Object.fromEntries(current.map((r) => [r.file, r.lines])),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log('✅ 已写入基线 ' + BASELINE_REL + '（' + current.length + ' 个文件' + (initial ? ' · 首次建立' : '') + '）');
    for (const r of current) console.log('   · ' + r.file.padEnd(20) + ' ' + r.lines + ' 行');
    process.exit(0);
}

if (AS_JSON) {
    console.log(JSON.stringify({ ok: plan.ok, margin: plan.margin, strict: STRICT, rows: plan.rows, baseline: BASELINE_REL }, null, 2));
    process.exit(plan.ok ? 0 : 1);
}

console.log('单体文件体量门禁（技-14 / U134）：核对 ' + current.length + ' 个文件 · 基线 ' + BASELINE_REL);
console.log(fileSizeReportText(plan));
if (!plan.ok) {
    console.log('❌ 体量门禁未通过：' + plan.over.length + ' 个文件超出上限 —— 新功能请落在**新模块**（`docs/05-开发指南.md` §5 编码约定），');
    console.log('   这三个/五个文件只允许「必要接线」；确需上调基线见脚本头部（须 `--allow-growth` + `CHANGELOG` 理由）。');
    process.exit(1);
}
console.log('✅ 体量门禁通过（无文件超过「基线 + ' + plan.margin + ' 行」）');
