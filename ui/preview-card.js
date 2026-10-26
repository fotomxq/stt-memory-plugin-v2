// ============================================================
// ui/preview-card.js —— **公共预览卡片组件**（v3.52.0 W33 `应-51`，`docs/D55` §3.7）
//
// 背景：四处「AI / 批处理方案预览」（三域联动 · 货币融合 · 货币修正 · 履历批量）此前各自用
//   `<br>` + `.ftt-muted` 拼装，前后变化不易扫读。
//
// 口径：
//   · **只统一视觉与对比结构**，不改任何动作名 / 数据字段 / 落库路径；
//   · 行结构 `操作徽标 | 变更前 → 变更后 | 依据`；`op` ∈ add / del / mod / report；
//   · 不直接落库的预览一律走本组件（「预览必见前后对比」原则）。
// ============================================================
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

const OP_LABEL = Object.freeze({ add: '新增', del: '剔除', mod: '修正', report: '只报告' });

/**
 * @param {{title?:string, summary?:string, badge?:string, sections?:Array<{label?:string, rows?:Array<{op?:string, before?:string, after?:string, note?:string}>}>, footer?:string}} opts
 * @returns {string} 预览卡片 HTML（`data-ftt-preview-card` 结构锚点）
 */
export function previewCardHtml(opts) {
    const o = opts || {};
    const rowsHtml = (rows) => (Array.isArray(rows) ? rows : []).map((r) => {
        const op = String((r && r.op) || 'mod');
        const opCls = /^(add|del|mod|report)$/.test(op) ? op : 'mod';
        const before = (r && r.before !== undefined && r.before !== '') ? ('<span class="ftt-preview-before">' + esc(r.before) + '</span>') : '';
        const after = (r && r.after !== undefined && r.after !== '') ? ('<span class="ftt-preview-after">' + esc(r.after) + '</span>') : '';
        const arrow = (before && after) ? '<span class="ftt-preview-arrow">→</span>' : '';
        return '<div class="ftt-preview-row"><span class="ftt-preview-op ftt-preview-op--' + opCls + '">' + esc(OP_LABEL[opCls] || op) + '</span>'
            + '<span class="ftt-preview-diff">' + before + arrow + after + '</span>'
            + '<span class="ftt-preview-note ftt-muted">' + esc((r && r.note) || '') + '</span></div>';
    }).join('');
    const sections = (Array.isArray(o.sections) ? o.sections : []).map((s) => {
        const rows = rowsHtml(s && s.rows);
        if (!rows) return '';
        return '<div class="ftt-preview-sec"><div class="ftt-preview-sec-k">' + esc((s && s.label) || '') + '</div>' + rows + '</div>';
    }).join('');
    return '<div class="ftt-preview-card" data-ftt-preview-card>'
        + (o.title ? ('<div class="ftt-preview-title">' + esc(o.title) + (o.badge ? (' <span class="ftt-chip">' + esc(o.badge) + '</span>') : '') + '</div>') : '')
        + (o.summary ? ('<div class="ftt-preview-summary">' + esc(o.summary) + '</div>') : '')
        + sections
        + (o.footer ? ('<div class="ftt-preview-foot ftt-hint">' + esc(o.footer) + '</div>') : '')
        + '</div>';
}
