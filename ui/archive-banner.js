// ============================================================
// ui/archive-banner.js —— **存档分区横幅**（v3.52.7）
//
// 用户要求：「不同的存档，数据应该加以区分，避免混淆。」（澄清后选择：按聊天存档隔离，角色内每档一份）
//
// 显示（面板外壳，所有分页可见）：
//   📂 当前存档 <短键> ｜ 本档 N 条 · 旧存档遗留 L 条（可见并打标）· 其它存档 M 条（已隐藏）
//   提供「归入当前存档」（把 legacy 归入本档；危险动作二次确认）与「查看其它存档」提示（只读说明）。
// 口径：存档键未知（宿主未提供聊天元数据）→ 横幅**不渲染**（fail-open，与 `core/archive-scope.js` 一致）。
// ============================================================
import { archiveStats } from '../core/archive-scope.js';

function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function shortKey(k) { const s = String(k || ''); return s.length > 10 ? (s.slice(0, 6) + '…' + s.slice(-3)) : s; }

/**
 * @returns {string} 横幅 HTML（存档键未知时为空串）
 */
export function archiveBannerHtml() {
    try {
        const st = archiveStats();
        if (!st || !st.known) return '';
        const parts = ['📂 当前存档 <b data-ftt-archive-key>' + esc(shortKey(st.currentKey)) + '</b>'];
        parts.push('本档 ' + st.current + ' 条');
        if (st.legacy) parts.push('旧存档遗留 <b class="ftt-warn">' + st.legacy + '</b> 条（可见·打标）');
        parts.push(st.other ? ('其它存档 <b>' + st.other + '</b> 条（已隐藏，不参与注入/清理）') : '其它存档 0 条');
        return '<div class="ftt-archive-bar" data-ftt-archive-bar title="记忆按聊天存档隔离：切换聊天会自动切到那一条存档的数据；升级前的历史数据无存档归属，打「旧存档」标并计入本视图">'
            + '<span class="ftt-archive-txt">' + parts.join(' ｜ ') + '</span>'
            + (st.legacy
                ? '<button class="ftt-btn ftt-sm" data-ftt-action="archiveAdopt" title="把这些升级前的历史数据归入当前存档（只补空归属，别的存档不动；会二次确认）">↪ 把旧存档归入当前</button>'
                : '')
            + '</div>';
    } catch (e) { return ''; }
}
