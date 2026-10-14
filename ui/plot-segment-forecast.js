// ============================================================
// ui/plot-segment-forecast.js —— 「🧩 分段总结」子页的**提交前体量预告**（v3.49.3）
//
// 用户报告（原话）：「情节的自动分段统计存在设计缺陷，会提交巨量数据。其实需要统计的 30 个情节
//   不可能这么大的数据量，请链接本地调试并核对，解决该问题。」
//
// 为什么单独成模块：`ui/panel.js` 受 `docs/D22` W5 `技-14` **单体文件体量棘轮**约束（基线 + 40 行宽限）——
//   预告行连注释十余行，直接写进去会顶破上限（实测 +45 > +40）。按 `docs/05` §5 **C11**「新功能落新模块、
//   大文件只留必要接线」，把渲染搬到这里，`ui/panel.js` 只留 **一行调用**。
//
// 口径：**只读**。数据源 = `core/plot-segment.js#plotSegmentPlan()`（与真正提交用的是同一份计划）——
//   所以预告里的「几条 / 几批 / 约多少字符」与 AI 实际收到的是**同一口径**，不是另算一套。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { plotSegmentPlan } from '../core/plot-segment.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 预告行 HTML（无待整理情节时返回空串，不占位）。
 * @returns {string}
 */
export function plotSegmentForecastHtml() {
    try {
        const plan = plotSegmentPlan();
        if (!plan || !plan.total || !plan.batches.length) return '';
        const per = Math.max(1, Math.min(40, Number(cfg && cfg.plotSegmentMaxBatches) || 1));
        const n = Math.min(per, plan.batches.length);
        const chars = plan.batches.slice(0, n).reduce((s, b) => s + (Number(b.chars) || 0), 0);
        const totalChars = plan.batches.reduce((s, b) => s + (Number(b.chars) || 0), 0);
        return '<div class="ftt-muted ftt-w-full" data-ftt-seg-forecast>'
            + '待整理 <b>' + esc(plan.total) + '</b> 条 → 共 <b>' + esc(plan.batches.length) + '</b> 批 · 合计约 <b>' + esc(totalChars) + '</b> 字符；'
            + '点一次只提交 <b>' + esc(n) + '</b> 批（每批 ≤ ' + esc(plan.batchAtoms) + ' 条 / ≤ ' + esc(plan.batchChars || '不限') + ' 字符'
            + ' · 本次约 <b>' + esc(chars) + '</b> 字符）'
            + (plan.batches.length > n ? '；余下可再点继续' : '')
            + '。<b>增量模式</b>下已被现有段落覆盖的批次不再重复提交。</div>';
    } catch (e) { return ''; }
}
