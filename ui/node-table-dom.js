// ============================================================
// ui/node-table-dom.js —— **已发生节点的结构性行编辑**（v3.51.7，`docs/D53` §3.4 / `docs/D22` W32 `应-47` 续）
//
// 用户要求：「前景预判② 已发生的变动节点，设计也有问题，应该采用结构性设计，不要用分隔符设计。」
//
// 本模块只做**纯 DOM 行操作**（加一行 / 删一行），不碰数据、不碰动作分发：
//   · 行 = `.ftt-node-row`，行内三个输入 `data-ftt-ed="node-<i>-date|delta|note"`（由 `collectEditorFields` 收集）；
//   · 行号只需**唯一**，可以是稀疏的（`deconstructEntry` 会排序并忽略空日期行）；
//   · 新行行号 = 当前最大行号 + 1（找不到则 0），避免与既有行冲突。
// 宿主（`ui/panel.js`）在点击委托里调一次 `nodeTableClick(target)`；命中即返回 `true`（不再进动作分发）。
// ============================================================
const ROW_SEL = '.ftt-node-row';
const ATTR = 'data-ftt-node-row';

function rowsOf(scope) {
    try { return Array.from(scope.querySelectorAll(ROW_SEL)); } catch (e) { return []; }
}
function nextIndex(scope) {
    let max = -1;
    for (const r of rowsOf(scope)) {
        const v = Number(r.getAttribute(ATTR));
        if (Number.isFinite(v) && v > max) max = v;
    }
    return max + 1;
}
/** 行 HTML（与 `ui/fields.js#nodeTableHtml` 同结构；空值 + 删除按钮） */
function rowHtml(i) {
    const a = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return '<div class="ftt-node-row" ' + ATTR + '="' + i + '">'
        + '<input type="text" data-ftt-ed="node-' + i + '-date" value="" placeholder="年-月-日" title="发生日期（年-月-日）">'
        + '<input type="number" data-ftt-ed="node-' + i + '-delta" value="0" placeholder="金额" title="金额（正=收入 / 负=支出）">'
        + '<input type="text" data-ftt-ed="node-' + i + '-note" value="" placeholder="说明" title="说明（≤80 字）">'
        + '<button type="button" class="ftt-btn ftt-sm ftt-node-del" data-ftt-node-del="' + i + '" title="删除这一行">✕</button>'
        + '</div>';
}

/**
 * 处理节点表的行操作。
 * @param {Element} target 被点击的元素（或其宿主）
 * @returns {boolean} 是否已处理（true = 调用方直接 return）
 */
export function nodeTableClick(target) {
    try {
        const el = target || null;
        if (!el || typeof el.closest !== 'function') return false;
        const add = el.closest('[data-ftt-node-add]');
        if (add) {
            const table = add.closest('.ftt-node-table');
            if (!table) return true;
            const i = nextIndex(table);
            const foot = table.querySelector('.ftt-node-foot');
            if (foot && typeof foot.insertAdjacentHTML === 'function') foot.insertAdjacentHTML('beforebegin', rowHtml(i));
            return true;
        }
        const del = el.closest('[data-ftt-node-del]');
        if (del) {
            const row = del.closest(ROW_SEL);
            if (row && row.parentNode && typeof row.parentNode.removeChild === 'function') row.parentNode.removeChild(row);
            return true;
        }
        return false;
    } catch (e) { return false; }
}
