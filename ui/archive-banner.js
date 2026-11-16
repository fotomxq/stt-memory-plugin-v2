// ============================================================
// ui/archive-banner.js —— **存档分区横幅**（v3.52.7；v3.52.14 改为「旧存档默认隐藏」）
//
// 用户要求：「不同的存档，数据应该加以区分，避免混淆。」（澄清后选择：按聊天存档隔离，角色内每档一份）
//
// v3.52.14 用户再次报告：「存档混乱，不同存档的内容出现了交叉」——真机复核确认：无归属的旧版历史数据
//   （真机 539 条）在**每一条**聊天存档里都可见，新建的空存档一打开就塞满旧故事内容。
//   现在：`legacy` **默认隐藏**；横幅如实显示计数，并提供**显式**「👁 显示旧存档数据」开关
//   （仅本次页面会话有效，不落盘）+「↪ 把旧存档归入当前」（二次确认）。
//
// 显示（面板外壳，所有分页可见）：
//   📂 当前存档 <短键> ｜ 本档 N 条 · 旧存档遗留 L 条（默认隐藏 / 已显示·打标）· 其它存档 M 条（已隐藏）
// 口径：存档键未知（宿主未提供聊天元数据）→ 横幅**不渲染**（fail-open，与 `core/archive-scope.js` 一致）。
// ============================================================
import { archiveStats, legacyVisibleOn } from '../core/archive-scope.js';

function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function shortKey(k) { const s = String(k || ''); return s.length > 10 ? (s.slice(0, 6) + '…' + s.slice(-3)) : s; }

/**
 * @returns {string} 横幅 HTML（存档键未知时为空串）
 */
export function archiveBannerHtml() {
    try {
        const st = archiveStats();
        if (!st || !st.known) return '';
        const reveal = legacyVisibleOn();
        const parts = ['📂 当前存档 <b data-ftt-archive-key>' + esc(shortKey(st.currentKey)) + '</b>'];
        parts.push('本档 ' + st.current + ' 条');
        if (st.legacy) parts.push('旧存档遗留 <b class="ftt-warn">' + st.legacy + '</b> 条' + (reveal ? '（已显示·打标）' : '（默认隐藏）'));
        parts.push(st.other ? ('其它存档 <b>' + st.other + '</b> 条（已隐藏，不参与注入/清理）') : '其它存档 0 条');
        const legacyBtns = (st.legacy
            ? ('<button class="ftt-btn ftt-sm" data-ftt-action="archiveReveal" title="' + (reveal
                ? '把「旧存档遗留」重新隐藏（本次会话内有效，不改任何数据）'
                : '临时显示「旧存档遗留」数据（本次会话内有效；默认隐藏是为了避免旧存档内容串到当前存档）') + '">'
                + (reveal ? '🙈 隐藏旧存档数据' : '👁 显示旧存档数据') + '</button>'
                + (reveal ? '<button class="ftt-btn ftt-sm" data-ftt-action="archiveAdopt" title="把这些升级前的历史数据归入当前存档（只补空归属，别的存档不动；会二次确认）">↪ 把旧存档归入当前</button>' : ''))
            : '');
        return '<div class="ftt-archive-bar" data-ftt-archive-bar title="记忆按聊天存档隔离：切换聊天自动切到那一条存档的数据；升级前的历史数据没有存档归属，默认隐藏（横幅可临时显示并归入当前存档），避免旧存档内容串进当前存档">'
            + '<span class="ftt-archive-txt">' + parts.join(' ｜ ') + '</span>'
            + legacyBtns
            + '</div>';
    } catch (e) { return ''; }
}
