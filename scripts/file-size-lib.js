// ============================================================
// scripts/file-size-lib.js —— **单体文件体量门禁**的纯函数库（`docs/D22` W5 `技-14`；`docs/D17` U134）
//
// 事实与裁决：
//   · `docs/D21` §3.3 `技-14`：`ui/panel.js` / `index.js` / `adapters/store.js` 体量过大 —— **不拆分既有文件**
//     （`docs/D9` §1 N4 已定不做），但**约束新增**：新功能一律落新模块，禁止继续往这三个文件堆；
//   · `docs/D17` U134 另登记 `ui/debug.js` / `core/config.js` 也是单体大文件 → 一并纳入**同一门禁**（观察面与三个主目标同口径）；
//   · 验收（`docs/D21` §8 `技-14` 行）：**「`wc -l` 不再增长（或增长仅为必要接线）」**。
//
// 为什么用「基线 + 宽限」而不是绝对上限：
//   这三个文件仍**必须**承担接线（新模块要挂进来就一定要改 `index.js` / `ui/panel.js`）——绝对上限会把
//   「正常接线」与「把功能堆进单体文件」一起挡掉。宽限（`margin`）就是「必要接线」的额度：**赚到的行数要还**
//   （`--write` 只在本文件变小或经裁决后才允许收紧基线），因此长期是**只减不增**。
// ============================================================

/** 默认宽限（行）：「必要接线」额度 —— 五个文件共用；超出即视为「继续堆功能」 */
export const DEFAULT_MARGIN = 40;

/** 纳入门禁的单体文件（三个主目标来自 `D21` §3.3；另两个来自 `D17` U134 的实测清单） */
export const WATCHED_FILES = Object.freeze([
    { file: 'ui/panel.js', why: 'D21 §3.3 主目标（面板与全部动作分发）' },
    { file: 'index.js', why: 'D21 §3.3 主目标（装配与钩子接线）' },
    { file: 'adapters/store.js', why: 'D21 §3.3 主目标（保存流水线）' },
    { file: 'ui/debug.js', why: 'D17 U134 实测清单（调试面）' },
    { file: 'core/config.js', why: 'D17 U134 实测清单（配置与提示词）' },
]);

/** 行数口径 = `wc -l`（换行符个数；与 `docs/D21` §8 的验收写法一致） */
export function countLines(text) {
    try { return (String(text == null ? '' : text).match(/\n/g) || []).length; } catch (e) { return 0; }
}

/**
 * 体量判定（纯函数，供门禁与单测共用）。
 * @param {Array<{file:string, lines:number}>} current 实测行数
 * @param {{margin?:number, files?:object, note?:string}} baseline 基线（`files` = 文件名 → 行数）
 * @param {{strict?:boolean}} [opts] `strict` = 宽限按 0（只允许变小）
 * @returns {{ok:boolean, margin:number, rows:Array, over:Array}}
 */
export function planFileSize(current, baseline, opts) {
    const o = opts || {};
    const base = (baseline && typeof baseline === 'object') ? baseline : {};
    const margin = o.strict === true ? 0 : (Number(base.margin) >= 0 ? Number(base.margin) : DEFAULT_MARGIN);
    const files = (base && base.files && typeof base.files === 'object') ? base.files : {};
    const rows = [];
    for (const item of (Array.isArray(current) ? current : [])) {
        const file = String((item && item.file) || '');
        const lines = Math.max(0, Number((item && item.lines) || 0));
        const hasBase = Object.prototype.hasOwnProperty.call(files, file);
        const baseLines = hasBase ? Math.max(0, Number(files[file]) || 0) : 0;
        const limit = baseLines + margin;
        const delta = lines - baseLines;                       // 相对基线的增减（负数 = 变小）
        const over = hasBase ? Math.max(0, lines - limit) : 0;  // 超出上限的行数
        rows.push({
            file: file, lines: lines, base: baseLines, margin: margin, limit: limit,
            delta: delta, over: over,
            status: !hasBase ? 'unbaselined' : (over > 0 ? 'over' : (delta < 0 ? 'shrunk' : 'within')),
        });
    }
    const over = rows.filter((r) => r.status === 'over' || r.status === 'unbaselined');
    return { ok: over.length === 0, margin: margin, rows: rows, over: over };
}

/** 人读报告（门禁 stdout 与单测共用同一份措辞） */
export function fileSizeReportText(plan) {
    const p = plan || {};
    const lines = [];
    lines.push('单体文件体量：宽限 ' + Number(p.margin) + ' 行/文件' + (p.margin === 0 ? '（--strict：只允许变小）' : ''));
    for (const r of (p.rows || [])) {
        const mark = r.status === 'over' ? '❌' : (r.status === 'unbaselined' ? '❓' : (r.status === 'shrunk' ? '✅' : '✅'));
        lines.push('  ' + mark + ' ' + r.file.padEnd(20) + ' ' + String(r.lines).padStart(5) + ' 行'
            + ' · 基线 ' + String(r.base).padStart(5) + ' · 变化 ' + (r.delta >= 0 ? '+' : '') + r.delta
            + (r.over ? (' · **超出上限 ' + r.over + ' 行**') : ''));
    }
    return lines.join('\n');
}
