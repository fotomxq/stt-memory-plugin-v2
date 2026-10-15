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
import { cfg, state } from '../core/model/runtime.js';
import { plotSegmentPlan, plotSegmentBusy } from '../core/plot-segment.js';
import { sortPlotSegments } from '../core/model/segment.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * 预告行 HTML（无待整理情节时返回空串，不占位）。
 * @returns {string}
 */
export function plotSegmentForecastHtml() {
    try {
        const plan = plotSegmentPlan();
        if (!plan || !plan.total || !plan.batches.length) return '';
        const per = Math.max(1, Math.min(40, Number(cfg && cfg.plotSegmentMaxBatches) || 1));
        const n = Math.min(per, plan.eligible || 0);
        const chars = (plan.batches.filter((b) => b.covered !== true && b.full === true).slice(0, per))
            .reduce((s, b) => s + (Number(b.chars) || 0), 0);
        const totalChars = plan.batches.reduce((s, b) => s + (Number(b.chars) || 0), 0);
        /**
         * v3.50.3（用户要求「必须满足『每次打包给 AI 的情节条数』后方可执行 1 次……最近必须至少有 N 条情节是未总结的」）：
         *   预告行现在把**门槛状态**说清 —— 未总结多少条 / 需凑满多少条才能提交 / 当前可提交几批；
         *   未达标时明确写"还差 N 条"，不再让用户以为点了就会跑。
         */
        const threshold = Number(plan.batchAtoms) || 30;
        const pending = Number(plan.pending) || 0;
        const eligible = Number(plan.eligible) || 0;
        const gate = eligible > 0
            ? ('<b>可提交 ' + esc(eligible) + ' 批</b>（本次点一次提交 ' + esc(n) + ' 批 · 约 ' + esc(chars) + ' 字符）'
                + (eligible > n ? '；余下可再点继续' : ''))
            : ('<b class="ftt-busy">未达门槛</b>：未总结 ' + esc(pending) + ' 条，需凑满 <b>' + esc(threshold)
                + '</b> 条一批才能提交（还差 <b>' + esc(Math.max(0, threshold - pending)) + '</b> 条）');
        return '<div class="ftt-muted ftt-w-full" data-ftt-seg-forecast>'
            + '可见情节 <b>' + esc(plan.total) + '</b> 条 · 未总结 <b>' + esc(pending) + '</b> 条 → 共 <b>' + esc(plan.batches.length) + '</b> 批（合计约 <b>' + esc(totalChars) + '</b> 字符，每批 ≤ '
            + esc(plan.batchAtoms) + ' 条 / ≤ ' + esc(plan.batchChars || '不限') + ' 字符）；' + gate
            + '。<b>增量模式</b>下已被现有段落覆盖的批次不再重复提交；同一批**已提交过**（含上次失败）也不会重复提交。</div>';
    } catch (e) { return ''; }
}

/**
 * v3.50.3（用户要求「必须满足『每次打包给 AI 的情节条数』后方可执行 1 次」）：**门槛读数**（只读）。
 *   eligible = 可提交的**满批**数 · pending = 未总结条数 · threshold = 每批条数上限 · need = 还差几条。
 * @returns {{eligible:number,pending:number,threshold:number,need:number,per:number}|null}
 */
export function plotSegmentGate() {
    try {
        const pl = plotSegmentPlan();
        const th = Number(pl.batchAtoms) || 30;
        const pending = Number(pl.pending) || 0;
        return {
            eligible: Number(pl.eligible) || 0, pending: pending, threshold: th, need: Math.max(0, th - pending),
            per: Math.max(1, Math.min(40, Number(cfg && cfg.plotSegmentMaxBatches) || 1)),
        };
    } catch (e) { return null; }
}

/**
 * 工具栏（🧩 生成分段总结 / ➕ 手动补一段 / 🧹 清理分段）。
 *   未达门槛 → 按钮 `disabled` + `ftt-btn-off`，`title` 写明「未总结 N 条 / 需凑满 T 条 / 还差 M 条」；
 *   在途（`plotSegmentBusy()`）→ 也禁用并显示「⏳ 已提交，等返回」。
 * @param {number} segCount 现有段落数（决定是否显示「清理分段」）
 * @returns {string}
 */
export function plotSegmentButtonHtml(segCount) {
    const g = plotSegmentGate() || { eligible: 0, pending: 0, threshold: 30, need: 30, per: 1 };
    const busy = (() => { try { return plotSegmentBusy() === true; } catch (e) { return false; } })();
    const can = g.eligible > 0 && !busy;
    const title = busy
        ? '上一次提交还没返回 —— 等返回后再点（避免重复提交）'
        : (can
            ? ('把情节按时间打包交 AI 拆成多段总结（言简意赅、只陈述事实与数据）—— 当前可提交 ' + g.eligible + ' 批，每次只提交 ' + g.per + ' 批')
            : ('未达门槛：未总结 ' + g.pending + ' 条，需凑满 ' + g.threshold + ' 条一批（还差 ' + g.need + ' 条）—— 可在 设定 → 分析记忆 调小「每次打包给 AI 的情节条数」'));
    return '<div class="ftt-addbar ftt-toolbar">'
        + '<button class="ftt-btn' + (can ? '' : ' ftt-btn-off') + '" data-ftt-action="summary" data-ftt-summary="plotSegments"'
        + (can ? '' : ' disabled') + ' title="' + esc(title) + '">'
        + (busy ? '⏳ 已提交，等返回' : '🧩 生成分段总结') + '</button>'
        + '<button class="ftt-btn" data-ftt-action="addEntry" data-kind="plotSegments">➕ 手动补一段</button>'
        + (Number(segCount) > 0 ? '<button class="ftt-btn ftt-err" data-ftt-action="clearPlotSegments" title="清空全部分段总结（不弹确认）">🧹 清理分段</button>' : '')
        + '</div>';
}

/**
 * 段落列表（含空态与尾部说明）—— v3.50.3 由 `ui/panel.js` 外移而来（C11 + 体量棘轮）。
 * @returns {string}
 */
export function plotSegmentBodyListHtml() {
    const segs = (() => { try { return Array.isArray(state.plotSegments) ? state.plotSegments : []; } catch (e) { return []; } })();
    if (!segs.length) return '<div class="ftt-empty">暂无分段总结。点「🧩 生成分段总结」把情节交 AI 分段整理。</div>';
    const view = sortPlotSegments(segs, 'desc');        // v1.190：默认按时间范围倒序
    const body = view.map((s) => {
        const lines = Array.isArray(s.lines) ? s.lines : [];
        const inner = lines.map((ln, i) => '<div class="ftt-seg-line"><span class="ftt-seg-no">' + (i + 1) + '.</span> <b>' + esc(ln && ln.label) + '</b>：' + esc(ln && ln.text) + '</div>').join('');
        const rangeTxt = (s.start || s.end) ? (esc(s.start || '?') + (s.end && s.end !== s.start ? ' ~ ' + esc(s.end) : '')) : '';
        const meta = [
            s.atomCount ? '覆盖情节 ' + Number(s.atomCount) + ' 条' : '',
            (s.floorStart && s.floorEnd) ? '第 ' + s.floorStart + '-' + s.floorEnd + ' 楼' : '',
            s.manual ? '手动编辑' : 'AI 生成',
        ].filter(Boolean).join(' · ');
        return '<div class="ftt-item ftt-item--col"><div class="ftt-title-row"><b>### ' + esc(s.header || '未标注时间范围') + '</b></div>'
            + (rangeTxt ? '<div class="ftt-meta">🗓 ' + rangeTxt + '</div>' : '') + inner
            + '<div class="ftt-meta">' + esc(meta) + '</div>'
            + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="edit" data-kind="plotSegments" data-id="' + attr(String(s.id || '')) + '" title="编辑该段（时间范围与剧情线）">✏️ 编辑</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="delete" data-kind="plotSegments" data-id="' + attr(String(s.id || '')) + '" title="删除该段（唯一的手动删除入口）">🗑 删除</button></div></div>';
    }).join('\n');
    return body + '\n<div class="ftt-muted ftt-w-full">共 ' + segs.length + ' 段 · 该内容不注入、不参与遗忘，可随时编辑或删除。</div>';
}
